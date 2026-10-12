"""Secret-free commerce auth status/recovery and explicit pre-mutation snapshots."""
import argparse
from dataclasses import dataclass, field
import json
import re
import sys
import time

from noon_auth_lifecycle import AuthError, NoonAuthLifecycle, deadline_for, safe_code

VERTICAL_SESSIONS = {
    'noon': {'main': 'noon', 'supermall': 'noon', 'minutes': 'minutes', 'nownow': 'nownow'},
    'talabat': {'shops': 'talabat-account', 'restaurants': 'talabat-account', 'mart': 'talabat-account'},
}


def _vertical(app, vertical):
    if app not in VERTICAL_SESSIONS or vertical not in VERTICAL_SESSIONS[app]:
        raise AuthError('INVALID_COMMERCE_VERTICAL')


def recovery_action(code):
    """Finite machine-readable actions; no automatic OTP, captcha or mutation retry."""
    if code == 'AUTH_FORBIDDEN':
        return 'manual_auth_challenge'
    if code in {'AUTH_EXPIRED', 'AUTH_EXPIRED_RENEWAL_REQUIRED'}:
        return 'renew_before_next_operation'
    if 'SCHEMA' in code:
        # Server/catalog auth schema drift must be inspected, not recovered over.
        return 'inspect_schema_change'
    if 'RECONCILE' in code or code in {'HTTP_EXCHANGE_FAILED_NO_RETRY', 'AUTH_READ_FAILED_NO_RETRY'}:
        return 'reconcile_retained_material'
    if code in {'ACCOUNT_BINDING_REQUIRED', 'NATIVE_SESSION_CHANGED_REBIND_REQUIRED',
                'PEER_SESSION_UNBOUND'}:
        return 'manual_account_binding'
    if any(part in code for part in ('MISSING', 'BINDING', 'CAPTURE', 'MANUAL', 'IDENTITY', 'HOME_', 'REJECTED')) \
            or code in {'PEER_ACCOUNT_MISMATCH', 'PEER_AUTH_NOT_APPLICABLE', 'PEER_SESSION_KEY_UNSUPPORTED'}:
        return 'manual_account_recovery'
    if 'TIMEOUT' in code or 'BUSY' in code or code == 'RATE_LIMITED':
        return 'stop_deadline_or_backoff'
    return 'inspect_local_failure'


def failure(app, vertical, exc):
    code = safe_code(exc)
    # Existing Talabat errors are fixed codes but a raw arbitrary exception is not.
    if exc.__class__.__module__ == 'talabat_http_orders' and exc.__class__.__name__ == 'TalabatError':
        value = str(exc)
        if re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', value):
            code = value
    return {'ok': False, 'app': app, 'vertical': vertical, 'error': code,
            'action': recovery_action(code), 'retry': False, 'mutation_retry': False,
            'automatic_otp': False,
            'human_challenge_possible': recovery_action(code) in {'manual_auth_challenge', 'manual_account_recovery'}}


@dataclass(repr=False)
class TalabatSnapshot:
    vertical: str
    _saved: dict = field(repr=False)
    _valid_until: float = field(repr=False)
    _used: bool = field(default=False, repr=False)

    def __repr__(self):
        return '<TalabatAuthSnapshot private>'

    def mutation_account(self, vertical):
        import copy
        if vertical != self.vertical:
            raise AuthError('AUTH_SERVICE_MISMATCH')
        if self._used:
            raise AuthError('AUTH_SNAPSHOT_ALREADY_USED')
        if time.monotonic() >= self._valid_until:
            raise AuthError('AUTH_SNAPSHOT_STALE')
        self._used = True
        return copy.deepcopy(self._saved)


class CommerceAuth:
    def __init__(self, *, noon=None, talabat=None):
        self._noon, self._talabat = noon, talabat

    @property
    def noon(self):
        if self._noon is None:
            self._noon = NoonAuthLifecycle()
        return self._noon

    @property
    def talabat(self):
        if self._talabat is None:
            import talabat_auth
            self._talabat = talabat_auth
        return self._talabat

    def status(self, app, vertical):
        _vertical(app, vertical)
        try:
            if app == 'noon':
                result = self.noon.status(vertical)
                return {**result, 'vertical': vertical, 'action':
                        'reconcile_retained_material' if result['maintenance_state'] != 'none' else
                        'validate_before_mutation' if result['binding_present'] else 'manual_account_binding'}
            raw = self.talabat.status()
            state = raw.get('maintenance_state')
            known = {'none', 'published', 'refresh_in_flight', 'raw_response_retained',
                     'response_retained', 'candidate_retained', 'awaiting_sms',
                     'otp_request_in_flight', 'otp_login_in_flight', 'otp_request_rejected'}
            state = state if state in known else 'unknown'
            pending = state not in {'none', 'published'}
            material = raw.get('refresh_material_present') is True
            return {'ok': True, 'app': app, 'vertical': vertical, 'session_key': 'talabat-account',
                    'account_verified': raw.get('account_verified') is True,
                    'expired': raw.get('expired') is True,
                    'refresh_material_present': material, 'refresh_verified': raw.get('refresh_verified') is True,
                    'maintenance_state': state, 'automatic_otp': False,
                    'action': 'reconcile_retained_material' if pending else
                    'manual_account_recovery' if not material else
                    'renew_before_next_operation' if raw.get('expired') is True else 'validate_before_mutation'}
        except Exception as exc:
            return failure(app, vertical, exc)

    def recover(self, app, vertical, *, reconcile=False, timeout=25):
        """Explicit maintenance, never a checkout/order callback retry wrapper."""
        _vertical(app, vertical)
        try:
            if app == 'noon':
                if reconcile:
                    self.noon.reconcile(vertical, timeout=timeout)
                    return self.status(app, vertical)
                # Bounded ladder: revalidate (validated response cookies) ->
                # same-account peer-surface adoption -> explicit recapture or
                # capture-import handoff. Never false success, never OTP.
                from noon_session_recovery import NoonSessionRecovery
                result = NoonSessionRecovery(lifecycle=self.noon).recover(vertical, timeout=timeout)
                return {**result, 'vertical': vertical}
            if reconcile:
                self.talabat.reconcile(timeout=timeout)
            else:
                self.talabat.refresh(timeout=timeout)
            return self.status(app, vertical)
        except Exception as exc:
            return failure(app, vertical, exc)

    def fresh_before_mutation(self, app, vertical, *, timeout=25, deadline=None):
        """Renew as necessary, validate the exact account, return one-use private state.

        Call this BEFORE marking a cart/order request MAY_HAVE_SENT. On any later
        401/403/timeout, retain the mutation journal and reconcile its exact outcome.
        """
        _vertical(app, vertical)
        end = deadline_for(timeout, deadline)
        if app == 'noon':
            return self.noon.fresh_before_mutation(vertical, timeout=timeout, deadline=end)
        auth = self.talabat
        # The accepted module owns flock, JWT expiry, rotating grant and journal.
        # One grant at most across local expiry and subsequent profile rejection.
        renewed = auth.refresh(timeout=timeout, deadline=end).get('renewed') is True
        for attempt in range(2):
            auth.remaining_time(end)
            with auth.read_deadline(end):
                saved = auth.binding(auth.read_store(auth.ACCOUNT))
            try:
                auth.validate(saved, end)
                return TalabatSnapshot(vertical, saved, time.monotonic() + 30)
            except auth.TalabatError as exc:
                if str(exc) != 'AUTH_EXPIRED_RENEWAL_REQUIRED' or renewed or attempt:
                    raise
            auth.refresh(rejected_token=saved['auth']['access_token'],
                         timeout=min(60, auth.remaining_time(end)), deadline=end)
            renewed = True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('status', 'recover', 'reconcile'))
    parser.add_argument('app', choices=tuple(VERTICAL_SESSIONS))
    parser.add_argument('vertical')
    args = parser.parse_args(argv)
    try:
        manager = CommerceAuth()
        result = manager.status(args.app, args.vertical) if args.command == 'status' else manager.recover(
            args.app, args.vertical, reconcile=args.command == 'reconcile')
    except Exception as exc:
        result = failure(args.app, 'invalid', exc)
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
