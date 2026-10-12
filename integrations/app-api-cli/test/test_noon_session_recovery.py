import copy
import io
import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import commerce_auth_status as commerce
import noon_auth_lifecycle as auth
import noon_session_recovery as recovery
from noon_checkout import fingerprint

PIN = fingerprint('private-customer')
OTHER_PIN = fingerprint('private-other')


def headers():
    return {'cookie': '_nrtnetid=private-renewal; _natnetidv2=private-old; dcae=ae',
            'x-addresscode': 'private-home-code', 'x-addresskey': 'private-home-key',
            'x-experience': 'ecom', 'user-agent': 'synthetic'}


def identity(customer='private-customer'):
    return {'customer': {'customerCode': customer}, 'experiences': [{'selectedAddress': {
        'addressCode': 'private-home-code', 'addressKey': 'private-home-key',
        'addressTitle': 'BanyanTree Hillside 2104', 'lat': 250778251, 'lng': 551569039}}]}


class Storage:
    def __init__(self):
        self.db = {'noon': {'headers': headers()}, 'minutes': {'headers': headers()},
                   'nownow': {'templates': {auth.NOWNOW_TEMPLATE: {'headers': headers()}}}}
        self.writes = []

    def load(self, key):
        return copy.deepcopy(self.db.get(key))

    def store(self, key, value):
        self.db[key] = copy.deepcopy(value)
        self.writes.append(key)


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.storage = Storage()
        self.calls = []
        self.manager = auth.NoonAuthLifecycle(storage=self.storage, transport=self.wire,
                                              lock_root=self.temp.name)
        self.recovery = recovery.NoonSessionRecovery(lifecycle=self.manager)

    def wire(self, h, end, retain):
        self.calls.append(copy.deepcopy(h))
        retain((), 200)
        return identity()

    def bind(self, service='main', pin=PIN):
        return self.manager.bind_existing(service, pin)

    def bind_donor(self, service='minutes', pin=PIN, customer='private-customer'):
        """Bind a peer whose overlay rotated to a different auth credential."""
        def rotate(h, end, retain):
            retain(('_nrtnetid=private-donor-fresh; Domain=.noon.com; Path=/',), 200)
            return identity(customer)
        previous = self.manager.transport
        self.manager.transport = rotate
        try:
            return self.manager.bind_existing(service, pin)
        finally:
            self.manager.transport = previous

    def rejected(self, h, end, retain):
        self.calls.append(copy.deepcopy(h))
        retain((), 401)
        raise auth.AuthError('AUTH_EXPIRED')

    def branch_wire(self, h, end, retain):
        """Accept only the donor credential; reject everything else with 401."""
        self.calls.append(copy.deepcopy(h))
        if 'private-donor-fresh' in h['cookie']:
            retain((), 200)
            return identity()
        retain((), 401)
        raise auth.AuthError('AUTH_EXPIRED')

    @property
    def state(self):
        return self.storage.db['noon-auth-lifecycle-noon']

    def donor_state(self, key='minutes'):
        return self.storage.db['noon-auth-lifecycle-' + key]


class SurveyTest(Base):
    def test_survey_is_storage_only_and_reports_donors(self):
        self.bind()
        self.bind_donor()
        del self.storage.db['nownow']
        writes, calls = list(self.storage.writes), list(self.calls)
        result = self.recovery.survey()
        self.assertTrue(result['ok'])
        self.assertEqual(result['network_requests'], 0)
        self.assertEqual(self.calls, calls)
        self.assertEqual(self.storage.writes, writes)
        self.assertEqual(set(result['surfaces']), set(recovery.SURFACES))
        self.assertEqual(result['surfaces']['main']['peer_donors'], ['minutes'])
        self.assertEqual(result['surfaces']['minutes']['peer_donors'], ['noon'])
        self.assertEqual(result['surfaces']['main']['action'], 'validate_before_mutation')
        self.assertEqual(result['surfaces']['nownow']['capture_present'], False)
        self.assertEqual(result['surfaces']['nownow']['action'], 'manual_account_recovery')
        self.assertNotIn('private-', json.dumps(result))

    def test_key_survey_flags_native_capture_change_without_raising(self):
        self.bind()
        calls = list(self.calls)
        self.storage.db['noon']['headers']['cookie'] = \
            '_nrtnetid=private-newcap; _natnetidv2=private-old; dcae=ae'
        info = self.manager.key_survey('main')
        self.assertTrue(info['native_capture_changed'])
        self.assertTrue(info['binding_present'])
        self.assertEqual(self.calls, calls)


class AdoptTest(Base):
    def test_adopt_publishes_donor_cookies_after_live_validation_only(self):
        self.bind()
        self.bind_donor()
        target_before = copy.deepcopy(self.state)
        donor_before = copy.deepcopy(self.donor_state())
        native_before = copy.deepcopy(self.storage.db['minutes'])
        writes = list(self.storage.writes)
        result = self.manager.adopt_peer_session('main', 'minutes')
        self.assertTrue(result['ok'])
        self.assertEqual(result['method'], 'peer_session_adoption')
        self.assertEqual(result['donor_session_key'], 'minutes')
        self.assertIn('private-donor-fresh', self.state['headers']['cookie'])
        self.assertEqual(self.state['native_digest'], target_before['native_digest'])
        self.assertNotEqual(self.state['generation'], target_before['generation'])
        self.assertEqual(self.donor_state(), donor_before)
        self.assertEqual(self.storage.db['minutes'], native_before)
        self.assertTrue(all(w == 'noon-auth-lifecycle-noon'
                            for w in self.storage.writes[len(writes):]))
        self.assertTrue(any('private-donor-fresh' in h['cookie'] for h in self.calls))
        self.assertNotIn('private-', json.dumps(result))

    def test_adopt_refuses_foreign_unbound_pending_samekey_donors(self):
        self.bind()
        self.bind_donor(pin=OTHER_PIN, customer='private-other')
        calls = list(self.calls)
        with self.assertRaisesRegex(auth.AuthError, 'PEER_ACCOUNT_MISMATCH'):
            self.manager.adopt_peer_session('main', 'minutes')
        self.assertEqual(self.calls, calls)
        with self.assertRaisesRegex(auth.AuthError, 'PEER_SESSION_UNBOUND'):
            self.manager.adopt_peer_session('main', 'nownow')
        with self.assertRaisesRegex(auth.AuthError, 'PEER_SESSION_KEY_UNSUPPORTED'):
            self.manager.adopt_peer_session('main', 'supermall')
        self.bind_donor('nownow')
        self.donor_state('nownow')['pending'] = {'state': 'cookies_retained', 'http_status': 200,
                                                 'set_cookies': [], 'base_headers': headers(),
                                                 'operation_id': 'x'}
        with self.assertRaisesRegex(auth.AuthError, 'PEER_PENDING_RECONCILE_REQUIRED'):
            self.manager.adopt_peer_session('main', 'nownow')
        self.assertEqual(self.calls, calls)

    def test_adopt_refuses_unchanged_credential_and_unbound_target(self):
        with self.assertRaisesRegex(auth.AuthError, 'ACCOUNT_BINDING_REQUIRED'):
            self.manager.adopt_peer_session('main', 'minutes')
        self.bind()
        self.bind('minutes')  # identical cookie values as the target overlay
        with self.assertRaisesRegex(auth.AuthError, 'PEER_AUTH_NOT_APPLICABLE'):
            self.manager.adopt_peer_session('main', 'minutes')
        self.assertEqual(len(self.calls), 2)  # only the two binds exercised

    def test_adopt_supersedes_only_confirmed_401_pending(self):
        self.bind()
        self.bind_donor()
        self.state['pending'] = {'state': 'cookies_retained', 'http_status': 401,
                                 'set_cookies': [], 'base_headers': headers(),
                                 'operation_id': 'prev'}
        result = self.manager.adopt_peer_session('main', 'minutes')
        self.assertTrue(result['ok'])
        self.assertIsNone(self.state['pending'])
        self.assertEqual(self.state['superseded_rejections'][0]['superseded_by'],
                         'peer_session_adoption')
        self.state['pending'] = {'state': 'candidate_retained', 'http_status': 200,
                                 'headers': headers(), 'base_headers': headers(),
                                 'operation_id': 'y'}
        calls = list(self.calls)
        with self.assertRaisesRegex(auth.AuthError, 'PENDING_AUTH_RECONCILE_REQUIRED'):
            self.manager.adopt_peer_session('main', 'minutes')
        self.state['pending'] = {'state': 'read_in_flight', 'base_headers': headers(),
                                 'operation_id': 'z'}
        with self.assertRaisesRegex(auth.AuthError, 'PENDING_AUTH_RECONCILE_REQUIRED'):
            self.manager.adopt_peer_session('main', 'minutes')
        self.assertEqual(self.calls, calls)

    def test_adopt_rejected_candidate_never_retries_and_retains(self):
        self.bind()
        self.bind_donor()
        overlay_before = copy.deepcopy(self.state['headers'])
        self.manager.transport = self.rejected
        calls = len(self.calls)
        with self.assertRaisesRegex(auth.AuthError, 'AUTH_EXPIRED'):
            self.manager.adopt_peer_session('main', 'minutes')
        self.assertEqual(len(self.calls), calls + 1)  # single exercise, no retry
        self.assertEqual(self.state['headers'], overlay_before)
        self.assertEqual(self.state['pending']['http_status'], 401)

    def test_adopt_rotation_stability_republishes_final_cookies(self):
        self.bind()
        self.bind_donor()
        def rotate(h, end, retain):
            self.calls.append(copy.deepcopy(h))
            if 'private-donor-fresh' in h['cookie']:
                retain(('_nrtnetid=private-adopted-rotated; Domain=.noon.com; Path=/',), 200)
            else:
                retain((), 200)
            return identity()
        self.manager.transport = rotate
        result = self.manager.adopt_peer_session('main', 'minutes')
        self.assertTrue(result['ok'])
        self.assertIn('private-adopted-rotated', self.state['headers']['cookie'])
        self.assertNotIn('private-donor-fresh', self.state['headers']['cookie'])
        self.assertEqual(len(self.calls), 3)  # main bind + candidate + stability re-exercise


class ImportTest(Base):
    def imported(self):
        value = headers()
        value['cookie'] = '_nrtnetid=private-imported; _natnetidv2=private-old2; dcae=ae'
        return value

    def test_import_publishes_without_native_writes(self):
        self.bind()
        native = {k: copy.deepcopy(self.storage.db[k]) for k in ('noon', 'minutes', 'nownow')}
        result = self.recovery.import_capture('main', self.imported(), PIN)
        self.assertTrue(result['ok'])
        self.assertEqual(result['method'], 'capture_import')
        self.assertIn('private-imported', self.state['headers']['cookie'])
        self.assertTrue(all(self.storage.db[k] == native[k] for k in native))
        self.assertTrue(all(w.startswith('noon-auth-lifecycle-') for w in self.storage.writes))
        self.assertNotIn('private-', json.dumps(result))

    def test_import_rejects_invalid_shapes(self):
        self.bind()
        for bad in ({}, {'cookie': 'dcae=ae'}, {1: 'x'},
                    {'cookie': '_nrtnetid=private-imported; _natnetidv2=x\r\nInject: 1'},
                    ['not', 'a', 'dict']):
            with self.assertRaisesRegex(auth.AuthError, 'IMPORT_HEADERS_INVALID'):
                self.manager.publish_capture_import('main', bad, PIN)
        self.assertEqual(len(self.calls), 1)  # only the bind; nothing exercised

    def test_import_pin_rules_and_first_bind(self):
        with self.assertRaisesRegex(auth.AuthError, 'EXPECTED_ACCOUNT_REQUIRED'):
            self.recovery.import_capture('minutes', self.imported(), None)
        result = self.recovery.import_capture('minutes', self.imported(), PIN)
        self.assertTrue(result['ok'])
        self.assertTrue(self.manager.status('minutes')['binding_present'])
        self.assertIn('private-imported', self.donor_state('minutes')['headers']['cookie'])
        self.bind()
        with self.assertRaisesRegex(auth.AuthError, 'ACCOUNT_IDENTITY_MISMATCH'):
            self.recovery.import_capture('main', self.imported(), OTHER_PIN)
        with self.assertRaisesRegex(auth.AuthError, 'IMPORT_UNCHANGED_AUTH_NOT_APPLICABLE'):
            self.recovery.import_capture('main', headers(), PIN)

    def test_import_supersedes_confirmed_401_pending(self):
        self.bind()
        self.state['pending'] = {'state': 'cookies_retained', 'http_status': 401,
                                 'set_cookies': [], 'base_headers': headers(),
                                 'operation_id': 'prev'}
        result = self.recovery.import_capture('main', self.imported(), PIN)
        self.assertTrue(result['ok'])
        self.assertIsNone(self.state['pending'])
        self.assertEqual(self.state['superseded_rejections'][0]['superseded_by'], 'capture_import')


class RecoverLadderTest(Base):
    def test_ladder_revalidate_success_never_adopts(self):
        self.bind()
        self.bind_donor()
        with patch.object(self.manager, 'adopt_peer_session',
                          MagicMock(side_effect=AssertionError('no adopt'))):
            result = self.recovery.recover('main')
        self.assertTrue(result['ok'])
        self.assertEqual(result['method'], 'revalidate')
        self.assertEqual(result['action'], 'validate_before_mutation')
        self.assertNotIn('private-', json.dumps(result))

    def test_ladder_401_adopts_healthy_same_account_peer(self):
        self.bind()
        self.bind_donor()
        self.manager.transport = self.branch_wire
        calls = len(self.calls)
        result = self.recovery.recover('main')
        self.assertTrue(result['ok'])
        self.assertEqual(result['method'], 'peer_session_adoption')
        self.assertEqual(result['donor_session_key'], 'minutes')
        self.assertIn('private-donor-fresh', self.state['headers']['cookie'])
        self.assertEqual(len(self.calls), calls + 2)  # rejected revalidate + adopt exercise
        self.assertIsNone(self.state['pending'])
        self.assertTrue(any(o.get('superseded_by') == 'peer_session_adoption'
                            for o in self.state['superseded_rejections']))
        self.assertNotIn('private-', json.dumps(result))

    def test_ladder_resumes_directly_from_confirmed_401_pending(self):
        self.bind()
        self.bind_donor()
        self.manager.transport = self.branch_wire
        self.state['pending'] = {'state': 'cookies_retained', 'http_status': 401,
                                 'set_cookies': [], 'base_headers': headers(),
                                 'operation_id': 'prev'}
        calls = len(self.calls)
        result = self.recovery.recover('main')
        self.assertTrue(result['ok'])
        self.assertEqual(result['method'], 'peer_session_adoption')
        self.assertEqual(len(self.calls), calls + 1)  # no redundant revalidate exercise

    def test_ladder_pending_rotation_requires_explicit_reconcile(self):
        self.bind()
        self.state['pending'] = {'state': 'candidate_retained', 'http_status': 200,
                                 'headers': headers(), 'base_headers': headers(),
                                 'operation_id': 'y'}
        calls = list(self.calls)
        result = self.recovery.recover('main')
        self.assertFalse(result['ok'])
        self.assertEqual(result['action'], 'reconcile_retained_material')
        self.assertEqual(self.calls, calls)  # zero network for this decision

    def test_ladder_exhausted_donors_handoff_is_explicit_never_false_success(self):
        self.bind()  # no peers bound at all
        self.manager.transport = self.rejected
        result = self.recovery.recover('main')
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'NO_FRESH_AUTH_MANUAL_RECOVERY_REQUIRED')
        self.assertEqual(result['action'], 'manual_account_recovery')
        self.assertEqual(result['donors_attempted'], [])
        self.assertTrue(result['steps'])
        self.assertFalse(result['automatic_otp'])
        self.assertFalse(result['retry'])
        self.assertFalse(result['refresh_grant_verified'])
        self.assertNotIn('private-', json.dumps(result))

    def test_ladder_skips_unusable_donor_without_extra_network(self):
        self.bind()
        self.bind_donor(pin=OTHER_PIN, customer='private-other')  # foreign donor is filtered pre-network
        self.manager.transport = self.rejected
        calls = len(self.calls)
        result = self.recovery.recover('main')
        self.assertFalse(result['ok'])
        self.assertEqual(result['action'], 'manual_account_recovery')
        self.assertEqual(len(self.calls), calls + 1)  # only the rejected revalidate

    def test_ladder_foreign_donor_live_mismatch_tries_nothing_blind(self):
        self.bind()
        # Donor survey agrees, but live exercise rejects the donor credential.
        self.bind_donor()
        def always_reject(h, end, retain):
            self.calls.append(copy.deepcopy(h))
            retain((), 401)
            raise auth.AuthError('AUTH_EXPIRED')
        self.manager.transport = always_reject
        result = self.recovery.recover('main')
        self.assertFalse(result['ok'])
        self.assertEqual(result['action'], 'manual_account_recovery')
        self.assertEqual(len(result['donors_attempted']), 1)
        self.assertEqual(result['donors_attempted'][0]['error'], 'AUTH_EXPIRED')

    def test_ladder_forbidden_and_schema_stop_before_adoption(self):
        self.bind()
        self.bind_donor()
        def forbidden(h, end, retain):
            retain((), 403)
            raise auth.AuthError('AUTH_FORBIDDEN')
        self.manager.transport = forbidden
        with patch.object(self.manager, 'adopt_peer_session',
                          MagicMock(side_effect=AssertionError('no adopt'))):
            result = self.recovery.recover('main')
        self.assertFalse(result['ok'])
        self.assertEqual(result['action'], 'manual_auth_challenge')
        # The forbidden attempt left retained pending; model the operator
        # having resolved it before the schema attempt.
        self.state.pop('pending', None)
        self.manager.transport = MagicMock(side_effect=auth.AuthError('SCHEMA_CHANGED'))
        with patch.object(self.manager, 'adopt_peer_session',
                          MagicMock(side_effect=AssertionError('no adopt'))):
            result = self.recovery.recover('main')
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'SCHEMA_CHANGED')
        self.assertEqual(result['action'], 'inspect_schema_change')

    def test_ladder_unbound_and_native_changed_reported(self):
        result = self.recovery.recover('minutes')
        self.assertFalse(result['ok'])
        self.assertEqual(result['action'], 'manual_account_binding')
        self.assertEqual(result['error'], 'ACCOUNT_BINDING_REQUIRED')
        self.bind()
        self.storage.db['noon']['headers']['cookie'] = \
            '_nrtnetid=private-newcap; _natnetidv2=private-old; dcae=ae'
        result = self.recovery.recover('supermall')
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'NATIVE_SESSION_CHANGED_REBIND_REQUIRED')
        self.assertEqual(result['action'], 'manual_account_binding')


class VerifyAllTest(Base):
    def test_one_live_exercise_per_shared_key(self):
        self.bind('main')
        self.bind('minutes')
        self.bind('nownow')
        calls = len(self.calls)
        result = self.recovery.verify_all()
        self.assertTrue(result['ok'])
        self.assertEqual(len(self.calls), calls + 3)  # 3 keys, not 4 surfaces
        self.assertTrue(all(surface['ok'] for surface in result['surfaces'].values()))
        self.assertTrue(result['surfaces']['supermall']['shared_session_key'])
        self.assertEqual(result['surfaces']['supermall']['session_key'], 'noon')
        self.assertEqual(result['surfaces']['supermall']['service'], 'supermall')
        self.assertNotIn('private-', json.dumps(result))

    def test_unbound_keys_report_binding_action(self):
        self.bind('main')
        calls = len(self.calls)
        result = self.recovery.verify_all()
        self.assertFalse(result['ok'])
        self.assertEqual(len(self.calls), calls + 1)
        self.assertTrue(result['surfaces']['main']['ok'])
        self.assertTrue(result['surfaces']['supermall']['ok'])
        for surface in ('minutes', 'nownow'):
            self.assertFalse(result['surfaces'][surface]['ok'])
            self.assertEqual(result['surfaces'][surface]['action'], 'manual_account_binding')


class CommerceWiringTest(Base):
    def test_commerce_recover_noon_runs_the_ladder(self):
        self.bind()
        self.bind_donor()
        self.manager.transport = self.branch_wire
        manager = commerce.CommerceAuth(noon=self.manager)
        result = manager.recover('noon', 'main')
        self.assertTrue(result['ok'])
        self.assertEqual(result['method'], 'peer_session_adoption')
        self.assertEqual(result['vertical'], 'main')
        self.assertEqual(result['action'], 'validate_before_mutation')
        self.assertNotIn('private-', json.dumps(result))

    def test_commerce_reconcile_path_unchanged(self):
        self.bind()
        self.state['pending'] = {'state': 'candidate_retained', 'http_status': 200,
                                 'headers': headers(), 'base_headers': headers(),
                                 'operation_id': 'y'}
        manager = commerce.CommerceAuth(noon=self.manager)
        result = manager.recover('noon', 'main', reconcile=True)
        self.assertTrue(result['ok'])
        self.assertIsNone(self.state['pending'])

    def test_recovery_action_mapping_for_new_codes(self):
        cases = {'PEER_ACCOUNT_MISMATCH': 'manual_account_recovery',
                 'PEER_AUTH_NOT_APPLICABLE': 'manual_account_recovery',
                 'PEER_SESSION_KEY_UNSUPPORTED': 'manual_account_recovery',
                 'PEER_SESSION_UNBOUND': 'manual_account_binding',
                 'NATIVE_SESSION_CHANGED_REBIND_REQUIRED': 'manual_account_binding',
                 'PEER_PENDING_RECONCILE_REQUIRED': 'reconcile_retained_material',
                 'IMPORT_HEADERS_INVALID': 'inspect_local_failure',
                 'IMPORT_HEADERS_FILE_PERMISSIONS_INVALID': 'inspect_local_failure',
                 'IMPORT_UNCHANGED_AUTH_NOT_APPLICABLE': 'inspect_local_failure',
                 'SCHEMA_CHANGED': 'inspect_schema_change',
                 'HOME_SCHEMA_UNKNOWN': 'inspect_schema_change',
                 'ACCOUNT_SCHEMA_UNKNOWN': 'inspect_schema_change',
                 'HOME_PIN_MISMATCH': 'manual_account_recovery'}
        for code, action in cases.items():
            result = commerce.failure('noon', 'main', auth.AuthError(code))
            self.assertEqual(result['action'], action, code)
            self.assertFalse(result['automatic_otp'])
            self.assertFalse(result['mutation_retry'])


class HeadersFileTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = os.path.join(self.temp.name, 'headers.json')

    def write(self, mode, payload):
        fd = os.open(self.path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, mode)
        with os.fdopen(fd, 'w') as handle:
            handle.write(payload)

    def test_owner_only_file_accepted_and_open_rejected(self):
        self.write(0o600, json.dumps({'cookie': '_nrtnetid=private-imported'}))
        self.assertEqual(recovery._load_headers_file(self.path),
                         {'cookie': '_nrtnetid=private-imported'})
        os.chmod(self.path, 0o644)
        with self.assertRaisesRegex(auth.AuthError, 'IMPORT_HEADERS_FILE_PERMISSIONS_INVALID'):
            recovery._load_headers_file(self.path)

    def test_non_dict_payload_rejected(self):
        self.write(0o600, json.dumps(['not', 'a', 'dict']))
        with self.assertRaisesRegex(auth.AuthError, 'IMPORT_HEADERS_INVALID'):
            recovery._load_headers_file(self.path)


if __name__ == '__main__':
    unittest.main()
