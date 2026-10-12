import copy
from email.message import Message
import io
import json
import multiprocessing
from pathlib import Path
import signal
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

import noon_auth_lifecycle as auth
from noon_checkout import fingerprint


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


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.storage = Storage()
        self.calls = []
        self.manager = auth.NoonAuthLifecycle(storage=self.storage, transport=self.wire,
                                              lock_root=self.temp.name)

    def wire(self, h, end, retain):
        self.calls.append(copy.deepcopy(h))
        retain((), 200)
        return identity()

    def bind(self, service='main'):
        return self.manager.bind_existing(service, fingerprint('private-customer'))

    @property
    def state(self):
        return self.storage.db['noon-auth-lifecycle-noon']

    def test_bind_restart_and_vertical_session_map(self):
        first = self.bind()
        self.assertEqual(first.service, 'main')
        self.assertEqual(set(self.storage.writes), {'noon-auth-lifecycle-noon'})
        restarted = auth.NoonAuthLifecycle(storage=self.storage, transport=self.wire, lock_root=self.temp.name)
        self.assertTrue(restarted.status('supermall')['binding_present'])
        self.assertFalse(restarted.status('minutes')['binding_present'])
        self.assertFalse(restarted.status('nownow')['binding_present'])
        snapshot = restarted.fresh_before_mutation('supermall')
        self.assertEqual(snapshot.service, 'supermall')
        with self.assertRaisesRegex(auth.AuthError, 'SERVICE_MISMATCH'):
            snapshot.mutation_headers('main')

    def test_readonly_diagnostic_valid_identity_never_claims_renewal_or_writes(self):
        self.bind();before=copy.deepcopy(self.storage.db);writes=len(self.storage.writes)
        def customer(h,end,retain):retain((),200);return {'customerCode':'private-customer'}
        self.manager.identity_transport=customer
        result=self.manager.diagnose_readonly('main')
        self.assertTrue(result['ok']);self.assertEqual(result['storage_writes'],0)
        self.assertFalse(result['rejected_session_recovery_verified'])
        self.assertEqual(result['action'],'existing_session_valid')
        self.assertEqual(self.storage.db,before);self.assertEqual(len(self.storage.writes),writes)
        self.assertNotIn('private-',json.dumps(result))

    def test_readonly_rejected_session_stops_no_retry_and_gives_native_recovery(self):
        self.bind();before=copy.deepcopy(self.storage.db)
        def rejected(h,end,retain):retain((),401);raise auth.AuthError('AUTH_EXPIRED')
        self.manager.transport=MagicMock(side_effect=rejected)
        self.manager.identity_transport=MagicMock(side_effect=AssertionError('no fallback'))
        result=self.manager.diagnose_readonly('main')
        self.assertFalse(result['ok']);self.assertEqual(result['action'],'supported_native_account_recovery')
        self.assertTrue(result['recovery_steps'])
        self.manager.transport.assert_called_once();self.manager.identity_transport.assert_not_called()
        self.assertEqual(self.storage.db,before)

    def test_readonly_rotation_is_ram_observation_not_publication_or_renewal(self):
        self.bind();before=copy.deepcopy(self.storage.db)
        def changed(h,end,retain):
            retain(('_natnetidv2=private-changed; Domain=.noon.com; Path=/',),200)
            return identity()
        self.manager.transport=changed
        self.manager.identity_transport=MagicMock(side_effect=AssertionError('not exercised'))
        result=self.manager.diagnose_readonly('main')
        self.assertTrue(result['auth_cookie_rotation_observed'])
        self.assertFalse(result['rejected_session_recovery_verified'])
        self.assertEqual(self.storage.db,before)

    def test_readonly_transport_failure_not_mislabelled_valid_or_login_required(self):
        self.bind();before=copy.deepcopy(self.storage.db)
        self.manager.transport=MagicMock(side_effect=OSError('private-network-data'))
        result=self.manager.diagnose_readonly('main')
        self.assertFalse(result['ok'])
        self.assertEqual(result['action'],'inspect_identity_read_failure')
        self.assertEqual(result['recovery_steps'],[])
        self.assertEqual(self.storage.db,before)
        self.assertNotIn('private-network-data',json.dumps(result))

    def test_expected_account_required_no_trust_on_first_use(self):
        with self.assertRaisesRegex(auth.AuthError, 'EXPECTED_ACCOUNT_REQUIRED'):
            self.manager.bind_existing('main', None)
        self.assertEqual(self.calls, [])
        with self.assertRaisesRegex(auth.AuthError, 'IDENTITY_MISMATCH'):
            self.manager.bind_existing('main', fingerprint('wrong-customer'))
        self.assertNotIn('headers', self.state)
        self.assertEqual(self.state['pending']['state'], 'candidate_retained')

    def test_rotation_retained_before_validation_published_only_after_exercised(self):
        self.bind()
        old = copy.deepcopy(self.state['headers'])
        def rotating(h, end, retain):
            if h['cookie'] == old['cookie']:
                retain(('_natnetidv2=private-new; Domain=.noon.com; Path=/; Secure; HttpOnly',), 200)
                self.assertEqual(self.state['headers'], old)
            else:
                self.assertEqual(self.state['pending']['base_headers'], h)
                retain((), 200)
            return identity()
        self.manager.transport = MagicMock(side_effect=rotating)
        snapshot = self.manager.revalidate('main')
        self.assertEqual(self.manager.transport.call_count, 2)
        self.assertIn('private-new', snapshot.read_headers()['cookie'])
        self.assertIsNone(self.state['pending'])

    def test_failed_rotation_retained_then_restart_reconcile(self):
        self.bind()
        old = copy.deepcopy(self.state['headers'])
        def rotating(h, end, retain):
            retain(('_natnetidv2=private-new; Domain=noon.com; Path=/',), 200)
            return identity('wrong')
        self.manager.transport = rotating
        with self.assertRaisesRegex(auth.AuthError, 'IDENTITY_MISMATCH'):
            self.manager.revalidate('main')
        self.assertEqual(self.state['headers'], old)
        self.assertIn('private-new', self.state['pending']['headers']['cookie'])
        self.manager.transport = self.wire
        self.manager.reconcile('main')
        self.assertIn('private-new', self.state['headers']['cookie'])

    def test_failed_second_validation_keeps_rotated_material_in_flight(self):
        self.bind()
        def rotating(h, end, retain):
            if 'private-new' in h['cookie']:
                raise OSError('private-network-error')
            retain(('_natnetidv2=private-new; Domain=noon.com; Path=/',), 200)
            return identity()
        self.manager.transport = rotating
        with self.assertRaisesRegex(auth.AuthError, '^AUTH_OPERATION_FAILED$'):
            self.manager.revalidate('main')
        self.assertEqual(self.state['pending']['state'], 'read_in_flight')
        self.assertIn('private-new', self.state['pending']['base_headers']['cookie'])
        self.manager.transport = self.wire
        self.manager.reconcile('main')
        self.assertIn('private-new', self.state['headers']['cookie'])

    def test_continuous_rotation_stops_bounded_with_latest_retained(self):
        self.bind()
        calls = []
        def rotating(h, end, retain):
            calls.append(1)
            retain((f'_natnetidv2=private-new{len(calls)}; Domain=noon.com; Path=/',), 200)
            return identity()
        self.manager.transport = rotating
        with self.assertRaisesRegex(auth.AuthError, 'ROTATION_UNSTABLE'):
            self.manager.revalidate('main')
        self.assertEqual(len(calls), 2)
        self.assertIn('private-new2', self.state['pending']['headers']['cookie'])

    def test_native_capture_change_does_not_overwrite_overlay(self):
        self.bind()
        old = copy.deepcopy(self.state)
        self.storage.db['noon']['headers']['cookie'] += '; private-other=1'
        with self.assertRaisesRegex(auth.AuthError, 'NATIVE_SESSION_CHANGED_REBIND_REQUIRED'):
            self.manager.revalidate('main')
        self.assertEqual(self.state, old)

    def test_out_of_lock_overlay_writer_is_not_overwritten(self):
        self.bind()
        store = self.storage.store
        def concurrent(key, value):
            store(key, value)
            if (value.get('pending') or {}).get('state') == 'candidate_retained':
                self.storage.db[key]['external_change'] = True
        self.storage.store = concurrent
        with self.assertRaisesRegex(auth.AuthError, 'ACCOUNT_CHANGED_RECONCILE_REQUIRED'):
            self.manager.revalidate('main')
        self.assertTrue(self.state['external_change'])
        self.assertIsNotNone(self.state['pending'])

    def test_explicit_native_recapture_rebind_keeps_account_pin(self):
        self.bind()
        self.storage.db['noon']['headers']['cookie'] = '_nrtnetid=private-recaptured; _natnetidv2=private-new'
        with self.assertRaisesRegex(auth.AuthError, 'IDENTITY_MISMATCH'):
            self.manager.rebind_existing('main', fingerprint('other'))
        result = self.manager.rebind_existing('main', fingerprint('private-customer'))
        self.assertIn('private-recaptured', result.read_headers()['cookie'])
        self.assertIsNone(self.state['pending'])

    def test_rebind_cannot_discard_pending_rotated_material(self):
        self.bind()
        self.state['pending'] = {'state': 'cookies_retained', 'set_cookies': ['private-rotated']}
        with self.assertRaisesRegex(auth.AuthError, 'PENDING_AUTH_RECONCILE_REQUIRED'):
            self.manager.rebind_existing('main', fingerprint('private-customer'))
        self.assertEqual(self.state['pending']['set_cookies'], ['private-rotated'])

    def test_403_never_refreshes_retries_or_reconciles(self):
        self.bind()
        def forbidden(h, end, retain):
            retain((), 403)
            raise auth.AuthError('AUTH_FORBIDDEN')
        self.manager.transport = MagicMock(side_effect=forbidden)
        with self.assertRaisesRegex(auth.AuthError, 'AUTH_FORBIDDEN'):
            self.manager.revalidate('main')
        with self.assertRaisesRegex(auth.AuthError, 'AUTH_FORBIDDEN'):
            self.manager.reconcile('main')
        self.assertEqual(self.manager.transport.call_count, 1)

    def test_read401_requires_changed_auth_not_only_successful_whoami(self):
        self.bind()
        operation = MagicMock(side_effect=auth.native.NoonError('AUTH_EXPIRED'))
        with self.assertRaisesRegex(auth.AuthError, 'NO_FRESH_AUTH_MANUAL_RECOVERY_REQUIRED'):
            self.manager.read_with_recovery('main', operation, read_only=True)
        self.assertEqual(operation.call_count, 1)

    def test_whoami401_with_rotated_cookie_validates_once_before_publish(self):
        self.bind()
        old = copy.deepcopy(self.state['headers'])
        def expired(h, end, retain):
            if 'private-old' in h['cookie']:
                retain(('_natnetidv2=private-new; Domain=noon.com; Path=/',), 401)
                raise auth.AuthError('AUTH_EXPIRED')
            self.assertEqual(self.state['headers'], old)
            retain((), 200)
            return identity()
        self.manager.transport = MagicMock(side_effect=expired)
        snapshot = self.manager.revalidate('main')
        self.assertIn('private-new', snapshot.read_headers()['cookie'])
        self.assertEqual(self.manager.transport.call_count, 2)

    def test_whoami401_without_rotated_cookie_no_retry(self):
        self.bind()
        def expired(h, end, retain):
            retain((), 401)
            raise auth.AuthError('AUTH_EXPIRED')
        self.manager.transport = MagicMock(side_effect=expired)
        with self.assertRaisesRegex(auth.AuthError, 'NO_FRESH_AUTH_MANUAL_RECOVERY_REQUIRED'):
            self.manager.revalidate('main')
        self.assertEqual(self.manager.transport.call_count, 1)

    def test_read401_one_replay_after_changed_validated_auth(self):
        self.bind()
        requests = []
        def operation(h, end):
            requests.append(h)
            if len(requests) == 1:
                def rotating(h, end, retain):
                    retain(('_natnetidv2=private-new; Domain=noon.com; Path=/',), 200)
                    return identity()
                self.manager.transport = rotating
                raise auth.AuthError('AUTH_EXPIRED')
            return 'projected'
        result = self.manager.read_with_recovery('main', operation, read_only=True)
        self.assertEqual(result, 'projected')
        self.assertEqual(len(requests), 2)
        self.assertIn('private-new', requests[1]['cookie'])

    def test_mutation_no_callback_retry_api_and_one_use_snapshot(self):
        snapshot = self.bind()
        snapshot.mutation_headers('main')
        with self.assertRaisesRegex(auth.AuthError, 'ALREADY_USED'):
            snapshot.mutation_headers('main')
        op = MagicMock()
        with self.assertRaisesRegex(auth.AuthError, 'READ_ONLY_OPERATION_REQUIRED'):
            self.manager.read_with_recovery('main', op)
        op.assert_not_called()

    def test_home_mismatch_blocks_publication(self):
        self.bind()
        def bad(h, end, retain):
            retain((), 200)
            data = identity()
            data['experiences'][0]['selectedAddress']['lat'] = 1
            return data
        self.manager.transport = bad
        with self.assertRaisesRegex(auth.AuthError, 'HOME_PIN_MISMATCH'):
            self.manager.revalidate('main')

    def test_expired_cookie_claim_is_not_a_session_expiry_signal(self):
        # Real whoami accepts the captured session despite this JWT's expiry.
        self.storage.db['noon']['headers']['cookie'] = '_natnetidv2=e30.eyJleHAiOjF9.x; _nrtnetid=opaque'
        self.bind()
        self.assertFalse(self.manager.status('main')['expiry_known'])
        self.assertFalse(self.manager.status('main')['refresh_grant_verified'])

    def test_no_secrets_in_repr_status_cli_or_exception(self):
        snapshot = self.bind()
        self.assertNotIn('private', json.dumps(self.manager.status('main')))
        self.assertNotIn('private-old', repr(snapshot))
        with patch.object(auth, 'NoonAuthLifecycle', side_effect=ValueError('private-old')), patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(auth.main(['status', 'main']), 1)
        self.assertNotIn('private-old', out.getvalue())

    def test_elapsed_deadline_no_new_calls_and_restored_alarm(self):
        self.bind()
        previous = signal.getsignal(signal.SIGALRM)
        with self.assertRaisesRegex(auth.native.NoonError, 'TIMEOUT'):
            self.manager.revalidate('main', deadline=time.monotonic() - 1)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0., 0.))
        self.assertEqual(signal.getsignal(signal.SIGALRM), previous)

    def test_rotation_retention_storage_failure_sanitized_stops_publication(self):
        self.bind()
        old = copy.deepcopy(self.state['headers'])
        store = self.storage.store
        def failed(key, value):
            if (value.get('pending') or {}).get('state') == 'cookies_retained':
                raise OSError('private-new')
            store(key, value)
        self.storage.store = failed
        def rotating(h, end, retain):
            retain(('_natnetidv2=private-new; Domain=noon.com; Path=/',), 200)
            return identity()
        self.manager.transport = MagicMock(side_effect=rotating)
        with self.assertRaisesRegex(auth.AuthError, '^ACCOUNT_STORAGE_WRITE_FAILED_STOP$'):
            self.manager.revalidate('main')
        self.assertEqual(self.state['headers'], old)
        self.assertEqual(self.state['pending']['state'], 'read_in_flight')
        self.assertEqual(self.manager.transport.call_count, 1)

    def test_read403_never_recovery_and_second401_no_third_read(self):
        self.bind()
        operation = MagicMock(side_effect=auth.AuthError('AUTH_FORBIDDEN'))
        before = len(self.calls)
        with self.assertRaisesRegex(auth.AuthError, 'AUTH_FORBIDDEN'):
            self.manager.read_with_recovery('main', operation, read_only=True)
        self.assertEqual(operation.call_count, 1)
        self.assertEqual(len(self.calls), before + 1)
        def rejected(h, end):
            def rotating(h, end, retain):
                retain(('_natnetidv2=private-new; Domain=noon.com; Path=/',), 200)
                return identity()
            self.manager.transport = rotating
            raise auth.AuthError('AUTH_EXPIRED')
        operation = MagicMock(side_effect=rejected)
        with self.assertRaisesRegex(auth.AuthError, '^AUTH_EXPIRED$'):
            self.manager.read_with_recovery('main', operation, read_only=True)
        self.assertEqual(operation.call_count, 2)

    def test_cookie_scopes_deletion_duplicate_and_expiry(self):
        for raw in ('_natnetidv2=x; Domain=evil.test; Path=/', '_natnetidv2=x; Path=/',
                    '_natnetidv2=x; Domain=noon.com; Path=/auth'):
            with self.assertRaisesRegex(auth.AuthError, 'SCOPE_UNSUPPORTED'):
                auth.merge_cookies(headers(), [raw])
        result = auth.merge_cookies(headers(), ['dcae=; Domain=noon.com; Path=/; Max-Age=0'])
        self.assertNotIn('dcae=', result['cookie'])
        with self.assertRaisesRegex(auth.AuthError, 'HEADER_INVALID'):
            auth.cookie_pairs('x=1; x=2')

    def test_wire_retains_headers_even_when_body_or_json_fails(self):
        for body in (b'{', OSError('private-drip-error')):
            response, opener = MagicMock(), MagicMock()
            response.__enter__.return_value = response
            response.code = 200
            response.headers = Message()
            response.headers.add_header('Set-Cookie', '_natnetidv2=private-new; Domain=noon.com; Path=/')
            if isinstance(body, bytes):
                response.read.return_value = body
            else:
                response.read.side_effect = body
            opener.open.return_value = response
            retained = []
            with patch.object(auth.urllib.request, 'build_opener', return_value=opener):
                with self.assertRaisesRegex(auth.AuthError, 'AUTH_READ_FAILED_NO_RETRY'):
                    auth.whoami_wire(headers(), time.monotonic() + 1, lambda values, code: retained.append(values))
            self.assertEqual(len(retained), 1)
            self.assertIn('private-new', retained[0][0])
            self.assertEqual(opener.open.call_count, 1)

    def test_customer_wire_exact_native_get_without_body_or_redirect(self):
        response, opener = MagicMock(), MagicMock()
        response.__enter__.return_value = response
        response.code = 200
        response.headers = Message()
        response.read.return_value = b'{"customerCode":"private-customer"}'
        opener.open.return_value = response
        retained = MagicMock()
        with patch.object(auth.urllib.request, 'build_opener', return_value=opener) as build:
            auth.customer_wire(headers(), time.monotonic() + 2, retained)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, auth.IDENTITY)
        self.assertEqual(request.method, 'GET')
        self.assertIsNone(request.data)
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertIsInstance(build.call_args.args[1], auth.native.NoRedirect)
        retained.assert_called_once_with((), 200)
        with self.assertRaisesRegex(auth.AuthError, 'ENDPOINT_DENIED'):
            auth._identity_read_wire(auth.IDENTITY + '?refresh=1', headers(), time.monotonic() + 2, retained)

    def test_identity_maintenance_no_rotation_is_not_claimed_renewal(self):
        self.bind()
        def customer(h, end, retain):
            retain((), 200)
            return {'customerCode': 'private-customer', 'email': 'private-email'}
        self.manager.identity_transport = MagicMock(side_effect=customer)
        before = len(self.calls)
        result = self.manager.revalidate_identity('main')
        self.assertEqual(len(self.calls), before + 1)
        self.manager.identity_transport.assert_called_once()
        self.assertEqual(result.account_ref, fingerprint('private-customer'))
        self.assertFalse(self.manager.status('main')['refresh_grant_verified'])

    def test_identity_rotation_requires_independent_home_and_preserves_on_failure(self):
        self.bind()
        old = copy.deepcopy(self.state['headers'])
        def customer(h, end, retain):
            retain(('_natnetidv2=private-new; Domain=noon.com; Path=/',), 200)
            return {'customerCode': 'private-customer'}
        def bad_home(h, end, retain):
            self.assertIn('private-new', h['cookie'])
            self.assertEqual(self.state['headers'], old)
            retain((), 200)
            data = identity()
            data['experiences'][0]['selectedAddress']['lat'] = 0
            return data
        self.manager.identity_transport = customer
        self.manager.transport = bad_home
        with self.assertRaisesRegex(auth.AuthError, 'HOME_PIN_MISMATCH'):
            self.manager.revalidate_identity('main')
        self.assertEqual(self.state['headers'], old)
        self.assertIn('private-new', self.state['pending']['headers']['cookie'])
        self.manager.transport = self.wire
        self.manager.reconcile('main')
        self.assertIn('private-new', self.state['headers']['cookie'])

    def test_identity_mismatch_retains_rotation_without_whoami_or_publish(self):
        self.bind()
        before = len(self.calls)
        def customer(h, end, retain):
            retain(('_natnetidv2=private-new; Domain=noon.com; Path=/',), 200)
            return {'customerCode': 'private-other'}
        self.manager.identity_transport = customer
        with self.assertRaisesRegex(auth.AuthError, 'ACCOUNT_IDENTITY_MISMATCH'):
            self.manager.revalidate_identity('main')
        self.assertEqual(len(self.calls), before)
        self.assertIn('private-old', self.state['headers']['cookie'])
        self.assertIn('private-new', self.state['pending']['headers']['cookie'])

    def test_identity401_and403_never_retry_or_fallback(self):
        for code in (401, 403):
            with self.subTest(code=code):
                self.setUp()
                self.bind()
                before = len(self.calls)
                def rejected(h, end, retain):
                    retain(('_natnetidv2=private-new; Domain=noon.com; Path=/',), code)
                    auth.http_ok(code)
                self.manager.identity_transport = MagicMock(side_effect=rejected)
                with self.assertRaisesRegex(auth.AuthError, 'AUTH_EXPIRED|AUTH_FORBIDDEN'):
                    self.manager.revalidate_identity('main')
                self.manager.identity_transport.assert_called_once()
                self.assertEqual(len(self.calls), before)
                self.assertIn('private-new', self.state['pending']['set_cookies'][0])

    def test_mutation_response_cookies_retained_without_dispatch_then_reconcile(self):
        snapshot = self.bind()
        snapshot.mutation_headers('main')
        result = self.manager.retain_response_cookies('main', snapshot,
            ['_natnetidv2=private-new; Domain=noon.com; Path=/'],
            response_url='https://api-app.noon.com/_svc/checkout-v2/place', http_status=200)
        self.assertTrue(result['retained'])
        self.assertEqual(len(self.calls), 1)
        self.assertIn('private-old', self.state['headers']['cookie'])
        self.manager.reconcile('main')
        self.assertIn('private-new', self.state['headers']['cookie'])

    def test_cookie_retention_unproved_hosts_and_origin_spoofs_denied(self):
        snapshot = self.bind('nownow')
        values = ['_natnetidv2=private-new; Domain=noon.com; Path=/']
        before = len(self.storage.writes)
        for host in ('prodapi-app-fd.noon.com', 'arbitrary.noon.com',
                     'api-app-fd.noon.com.evil.test', 'api-app-fd.noon.com:443',
                     'user@api-app-fd.noon.com'):
            with self.subTest(host=host), self.assertRaisesRegex(auth.AuthError, 'ORIGIN_DENIED'):
                self.manager.retain_response_cookies('nownow', snapshot, values,
                    response_url='https://' + host + '/native-route', http_status=200)
        self.assertEqual(len(self.storage.writes), before)
        self.assertTrue(self.manager.retain_response_cookies('nownow', snapshot, values,
            response_url='https://api-app-fd.noon.com/native-route', http_status=200)['retained'])

    def test_late_cookie_observations_keep_both_and_stop_automatic_selection(self):
        snapshot = self.bind()
        values = ['_natnetidv2=private-new; Domain=noon.com; Path=/']
        kwargs = {'response_url': 'https://api-app.noon.com/native-route', 'http_status': 200}
        self.manager.retain_response_cookies('main', snapshot, values, **kwargs)
        late = ['_natnetidv2=private-late; Domain=noon.com; Path=/']
        with self.assertRaisesRegex(auth.AuthError, 'CONCURRENT_COOKIE_OBSERVATION'):
            self.manager.retain_response_cookies('main', snapshot, late, **kwargs)
        self.assertEqual(self.state['pending']['set_cookies'], values)
        self.assertEqual(self.state['response_observations'][0]['set_cookies'], late)
        with self.assertRaisesRegex(auth.AuthError, 'CONCURRENT_COOKIE_OBSERVATION'):
            self.manager.reconcile('main')
        self.assertEqual(self.manager.status('main')['maintenance_state'], 'conflicting_observations')

    def test_body_deadline_alarm_keeps_headers_and_no_retry(self):
        response, opener = MagicMock(), MagicMock()
        response.__enter__.return_value = response
        response.code = 200
        response.headers = Message()
        response.headers.add_header('Set-Cookie', '_natnetidv2=private-new; Domain=noon.com; Path=/')
        def stalled_body(size):
            left, interval = signal.getitimer(signal.ITIMER_REAL)
            self.assertGreater(left, 0)
            self.assertEqual(interval, 0)
            signal.getsignal(signal.SIGALRM)(signal.SIGALRM, None)
        response.read.side_effect = stalled_body
        opener.open.return_value = response
        retained = []
        start = time.monotonic()
        with patch.object(auth.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(auth.native.NoonError, 'NATIVE_READ_TIMEOUT'):
                auth.whoami_wire(headers(), start + .05, lambda values, code: retained.append(values))
        self.assertEqual(len(retained), 1)
        self.assertEqual(opener.open.call_count, 1)


def parallel_worker(db, counter, lock_root, barrier, out):
    class SharedStorage:
        def load(self, key):
            return copy.deepcopy(db.get(key))
        def store(self, key, value):
            db[key] = copy.deepcopy(value)
    def wire(h, end, retain):
        with counter.get_lock():
            counter.value += 1
        time.sleep(.15)
        retain(('_natnetidv2=private-new; Domain=noon.com; Path=/',), 200)
        return identity()
    manager = auth.NoonAuthLifecycle(storage=SharedStorage(), transport=wire, lock_root=lock_root)
    original = manager._records
    first = [True]
    def records(*args):
        result = original(*args)
        if first[0]:
            first[0] = False
            barrier.wait(timeout=5)
        return result
    manager._records = records
    try:
        result = manager.revalidate('main', rejected_ref=auth.credential_ref(headers()))
        out.put('ok' if 'private-new' in result.read_headers()['cookie'] else 'bad')
    except Exception as exc:
        out.put(auth.safe_code(exc))


class ConcurrencyTest(unittest.TestCase):
    def test_concurrent_expiry_one_rotation_cross_process(self):
        ctx = multiprocessing.get_context('fork')
        with ctx.Manager() as shared, tempfile.TemporaryDirectory() as root:
            storage = Storage()
            manager = auth.NoonAuthLifecycle(storage=storage, transport=lambda h, d, r: (r((), 200), identity())[1], lock_root=root)
            manager.bind_existing('main', fingerprint('private-customer'))
            db = shared.dict(storage.db)
            counter, barrier, out = ctx.Value('i', 0), ctx.Barrier(3), ctx.Queue()
            processes = [ctx.Process(target=parallel_worker, args=(db, counter, root, barrier, out)) for _ in range(3)]
            for process in processes:
                process.start()
            for process in processes:
                process.join(8)
                if process.is_alive():
                    process.terminate()
                    process.join()
                self.assertEqual(process.exitcode, 0)
            self.assertEqual([out.get(timeout=2) for _ in processes], ['ok'] * 3)
            self.assertEqual(counter.value, 2)  # one exchange and candidate validation


if __name__ == '__main__':
    unittest.main()
