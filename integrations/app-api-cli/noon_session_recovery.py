"""Bounded cross-surface Noon session recovery; no invented refresh grant.

Recovery ladder per surface: explicit retained-material reconcile -> revalidate
(validated response cookies) -> same-account peer-surface adoption -> parent-
authorized native recapture / capture-import handoff. Donors are bounded,
ordered by last verification; reads exercise at most the lifecycle's own
single retry; mutations are never retried and no OTP is ever requested here.
Every failure ends in an explicit action_required handoff, never false
success.
"""
import argparse
import json
import os
import stat
import sys

from commerce_auth_status import recovery_action
from noon_auth_lifecycle import (KEY_SURFACES, SESSION_MAP, AuthError, NoonAuthLifecycle,
                                 deadline_for, safe_code)

SURFACES = ('main', 'supermall', 'minutes', 'nownow')
ADOPTABLE = frozenset({'AUTH_EXPIRED', 'NO_FRESH_AUTH_MANUAL_RECOVERY_REQUIRED'})
# Donor-side failures that only disqualify that donor; the ladder then tries
# the next one. Everything else (forbidden, schema, busy, transport) stops.
DONOR_SKIP = frozenset({'AUTH_EXPIRED', 'PEER_SESSION_UNBOUND', 'PEER_ACCOUNT_MISMATCH',
                        'PEER_PENDING_RECONCILE_REQUIRED', 'PEER_AUTH_NOT_APPLICABLE',
                        'PEER_SESSION_KEY_UNSUPPORTED',
                        'CONCURRENT_COOKIE_OBSERVATION_MANUAL_RECONCILE_REQUIRED'})
MAX_DONORS = 2

RECAPTURE_STEPS = (
    'If the original Noon app is still signed in, use a parent-authorized native recapture of that surface session; do not log out first.',
    'If the original app requires login: Account -> Login/Sign up -> the existing account email -> CONTINUE -> legitimate email OTP. The authorized operator may retrieve the current code through the saved mailbox workflow; never loop on resend or print the code.',
    'Do not sign out or invalidate a still-valid session to manufacture expiry; do not clear app data.',
    'Publish the recaptured material through NoonAuthLifecycle.rebind_existing (native Keychain pipeline) or NoonSessionRecovery.import_capture (private captured headers) with the pinned account reference.',
    'After recovery, run verify-all across main, supermall, minutes and nownow before any ordering operation.',
)


class NoonSessionRecovery:
    def __init__(self, *, lifecycle=None, lock_root=None):
        if lifecycle is not None:
            self.lifecycle = lifecycle
        elif lock_root is not None:
            self.lifecycle = NoonAuthLifecycle(lock_root=lock_root)
        else:
            self.lifecycle = NoonAuthLifecycle()

    def _key_info(self, service, *, timeout=5):
        try:
            return self.lifecycle.key_survey(service, timeout=timeout)
        except AuthError as exc:
            if safe_code(exc) != 'ACCOUNT_CAPTURE_REQUIRED':
                raise
            return {'ok': False, 'app': 'noon', 'service': service, 'session_key': SESSION_MAP[service],
                    'capture_present': False, 'native_capture_changed': False, 'binding_present': False,
                    'account_ref': None, 'maintenance_state': 'none', 'last_verified_at': None,
                    'pending_material': False, 'pending_state': None, 'pending_http_status': None,
                    'observation_material': False}

    @staticmethod
    def _donor(info):
        return (info.get('binding_present') is True and isinstance(info.get('account_ref'), str)
                and not info.get('pending_material') and not info.get('observation_material')
                and not info.get('native_capture_changed'))

    @staticmethod
    def _survey_action(info):
        if not info.get('capture_present'):
            return 'manual_account_recovery'
        if info.get('observation_material') or info.get('pending_material'):
            return 'reconcile_retained_material'
        if info.get('native_capture_changed'):
            return 'manual_account_binding'
        if not info.get('binding_present'):
            return 'manual_account_binding'
        return 'validate_before_mutation'

    def _keys(self, *, timeout=5):
        return {key: self._key_info(surface, timeout=timeout) for key, surface in KEY_SURFACES.items()}

    def survey(self, *, timeout=5):
        """Storage-only cross-surface survey. Zero network requests, zero writes."""
        keys = self._keys(timeout=timeout)
        for info in keys.values():
            donors = [other for other, facts in keys.items()
                      if other != info['session_key'] and info.get('binding_present')
                      and self._donor(facts) and facts.get('account_ref') == info.get('account_ref')]
            info['peer_donors'] = sorted(donors, key=lambda k: keys[k].get('last_verified_at') or 0,
                                         reverse=True)
            info['action'] = self._survey_action(info)
        surfaces = {surface: dict(keys[SESSION_MAP[surface]], surface=surface) for surface in SURFACES}
        return {'ok': True, 'app': 'noon', 'read_only': True, 'network_requests': 0,
                'storage_writes': 0, 'refresh_grant_verified': False,
                'rejected_session_recovery_verified': False, 'automatic_otp': False,
                'session_keys': keys, 'surfaces': surfaces}

    def _status_success(self, service, extra):
        status = self.lifecycle.status(service)
        return {**status, **extra, 'ok': True, 'action': 'validate_before_mutation',
                'vertical': service, 'refresh_grant_verified': False,
                'rejected_session_recovery_verified': False}

    def _handoff(self, service, code, *, stage, extra=None):
        action = recovery_action(code)
        result = {'ok': False, 'app': 'noon', 'service': service, 'vertical': service,
                  'session_key': SESSION_MAP[service], 'error': code, 'action': action,
                  'stage': stage, 'retry': False, 'mutation_retry': False, 'automatic_otp': False,
                  'refresh_grant_verified': False, 'rejected_session_recovery_verified': False,
                  'human_challenge_possible': action in {'manual_auth_challenge', 'manual_account_recovery'},
                  'recovery_method': 'native_recapture_or_capture_import'}
        if action == 'manual_account_recovery':
            result['steps'] = list(RECAPTURE_STEPS)
        try:
            info = self._key_info(service)
            result['binding_present'] = info.get('binding_present')
            result['maintenance_state'] = info.get('maintenance_state')
            # A retained 2xx candidate is genuinely reconcilable; surface that
            # instead of a recapture handoff.
            if info.get('pending_state') == 'candidate_retained':
                result['action'] = 'reconcile_retained_material'
        except AuthError:
            pass
        if extra:
            result.update(extra)
        return result

    def recover(self, service, *, timeout=30):
        """Run the bounded ladder for one surface. Never a mutation retry, never OTP."""
        if service not in SESSION_MAP:
            raise AuthError('INVALID_SERVICE')
        info = self._key_info(service)
        if not info.get('capture_present'):
            return self._handoff(service, 'ACCOUNT_CAPTURE_REQUIRED', stage='survey')
        if info.get('observation_material'):
            return self._handoff(service, 'CONCURRENT_COOKIE_OBSERVATION_MANUAL_RECONCILE_REQUIRED',
                                 stage='survey')
        # A confirmed 401 rejection is dead material; adoption/import supersede
        # it as a bounded observation, so go straight to those rungs. Any other
        # retained rotation (in flight, a 2xx candidate, unknown) still needs
        # an explicit reconcile first.
        expired_pending = (info.get('pending_material')
                           and info.get('pending_state') == 'cookies_retained'
                           and info.get('pending_http_status') == 401)
        if info.get('pending_material') and not expired_pending:
            return self._handoff(service, 'PENDING_AUTH_RECONCILE_REQUIRED', stage='survey')
        if info.get('native_capture_changed'):
            return self._handoff(service, 'NATIVE_SESSION_CHANGED_REBIND_REQUIRED', stage='survey')
        if not info.get('binding_present'):
            return self._handoff(service, 'ACCOUNT_BINDING_REQUIRED', stage='survey')
        # Rung 1: validated response cookies (also the ordinary renewal path).
        if expired_pending:
            code = 'AUTH_EXPIRED'
        else:
            try:
                self.lifecycle.revalidate(service, timeout=timeout)
                return self._status_success(service, {'method': 'revalidate'})
            except AuthError as exc:
                code = safe_code(exc)
        if code not in ADOPTABLE:
            return self._handoff(service, code, stage='revalidate')
        # Rung 2: bounded same-account peer adoption, freshest donor first.
        keys = self._keys(timeout=timeout)
        pin = info.get('account_ref')
        donors = sorted((other for other, facts in keys.items()
                         if other != info['session_key'] and self._donor(facts)
                         and facts.get('account_ref') == pin),
                        key=lambda k: keys[k].get('last_verified_at') or 0, reverse=True)
        failures = []
        for donor_key in donors[:MAX_DONORS]:
            try:
                adopted = self.lifecycle.adopt_peer_session(service, KEY_SURFACES[donor_key],
                                                            timeout=timeout)
            except AuthError as exc:
                donor_code = safe_code(exc)
                if donor_code not in DONOR_SKIP:
                    return self._handoff(service, donor_code, stage='adopt',
                                         extra={'failed_donor': donor_key, 'donor_error': donor_code})
                failures.append({'donor_session_key': donor_key, 'error': donor_code})
                continue
            return self._status_success(service, {'method': 'peer_session_adoption',
                                                  'donor_session_key': adopted['donor_session_key']})
        # Rung 3: explicit handoff. No false success, no OTP loop, no retry.
        return self._handoff(service, 'NO_FRESH_AUTH_MANUAL_RECOVERY_REQUIRED', stage='adopt',
                             extra={'donors_attempted': failures,
                                    'steps': list(RECAPTURE_STEPS)})

    def import_capture(self, service, headers, expected_account_ref, *, timeout=30):
        """Delegate to the lifecycle's validated import publish (see its docstring)."""
        return self.lifecycle.publish_capture_import(service, headers, expected_account_ref,
                                                     timeout=timeout)

    def verify_all(self, *, timeout=30):
        """Revalidate every surface, one live exercise per shared session key."""
        results = {}
        done = {}
        for surface in SURFACES:
            key = SESSION_MAP[surface]
            if key in done:
                results[surface] = dict(done[key], surface=surface, service=surface,
                                        vertical=surface, shared_session_key=True)
                continue
            try:
                self.lifecycle.revalidate(surface, timeout=timeout)
                result = self._status_success(surface, {'method': 'revalidate'})
            except AuthError as exc:
                code = safe_code(exc)
                result = {'ok': False, 'app': 'noon', 'service': surface, 'vertical': surface,
                          'session_key': key, 'error': code, 'action': recovery_action(code),
                          'retry': False, 'mutation_retry': False, 'automatic_otp': False}
            done[key] = result
            results[surface] = dict(result, surface=surface)
        return {'ok': all(r['ok'] for r in results.values()), 'app': 'noon',
                'surfaces': results, 'refresh_grant_verified': False,
                'rejected_session_recovery_verified': False, 'automatic_otp': False,
                'mutation_retry': False}


def _load_headers_file(path):
    info = os.stat(path)
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise AuthError('IMPORT_HEADERS_FILE_PERMISSIONS_INVALID')
    if info.st_size > 131072:
        raise AuthError('IMPORT_HEADERS_INVALID')
    with open(path, 'r', encoding='utf-8') as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise AuthError('IMPORT_HEADERS_INVALID')
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('survey', 'status', 'recover', 'verify-all',
                                            'adopt', 'import-capture'))
    parser.add_argument('service', choices=('',) + SURFACES, nargs='?', default='')
    parser.add_argument('--donor', choices=SURFACES)
    parser.add_argument('--headers-file')
    parser.add_argument('--account-ref')
    parser.add_argument('--timeout', type=float, default=30)
    args = parser.parse_args(argv)
    try:
        if args.command not in ('survey', 'verify-all') and not args.service:
            raise AuthError('SERVICE_REQUIRED')
        manager = NoonSessionRecovery()
        if args.command == 'survey':
            result = manager.survey(timeout=args.timeout)
        elif args.command == 'status':
            result = manager.lifecycle.status(args.service)
        elif args.command == 'recover':
            result = manager.recover(args.service, timeout=args.timeout)
        elif args.command == 'verify-all':
            result = manager.verify_all(timeout=args.timeout)
        elif args.command == 'adopt':
            if not args.donor:
                raise AuthError('DONOR_SERVICE_REQUIRED')
            result = manager.lifecycle.adopt_peer_session(args.service, args.donor,
                                                          timeout=args.timeout)
        else:
            if not args.headers_file or not args.account_ref:
                raise AuthError('IMPORT_ARGUMENTS_REQUIRED')
            headers = _load_headers_file(args.headers_file)
            result = manager.import_capture(args.service, headers, args.account_ref,
                                            timeout=args.timeout)
        print(json.dumps(result))
        return 0 if result.get('ok') is not False else 1
    except Exception as exc:
        print(json.dumps({'ok': False, 'app': 'noon', 'error': safe_code(exc),
                          'retry': False, 'mutation_retry': False, 'automatic_otp': False}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
