import base64
import copy
import io
import json
import multiprocessing
import signal
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import talabat_auth as auth


def token(exp=None):
    payload = base64.urlsafe_b64encode(json.dumps({'exp': exp or time.time() + 28800}).encode()).decode().rstrip('=')
    return 'synthetic.' + payload + '.not-a-signature'


def account():
    return {'account_verified': True, 'country': 'AE', 'auth': {'access_token': token(),
            'refresh_token': 'synthetic-refresh', 'customerId': 123},
            'expected_profile': {'id': 123, 'mobile_country_code': '971', 'mobile_number': '500000000'},
            'headers': {'x-device-id': 'synthetic-device-id', 'user-agent': 'test'},
            'refresh_auth': {'client_secret': 'synthetic-public-client'},
            'renewal': {'device_token': 'synthetic-device', 'refresh_token_created_at': 'old'},
            'unrelated_field': {'preserve': True}}


class MaintenanceTest(unittest.TestCase):
    def setUp(self):
        self.db = {auth.ACCOUNT: account()}
        self.writes = []
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for target, replacement in [('load', self.load), ('store', self.store),
                                    ('LOCK', Path(self.temp.name) / 'lock')]:
            p = patch.object(auth, target, replacement)
            p.start()
            self.addCleanup(p.stop)

    def load(self, name):
        return copy.deepcopy(self.db.get(name))

    def store(self, name, value):
        self.db[name] = copy.deepcopy(value)
        self.writes.append((name, copy.deepcopy(value)))

    def rotation(self, url, saved, deadline, body=None, extra=None, authenticated=False, pending=None):
        if url == auth.AAA:
            self.assertEqual(extra['X-Device'], 'synthetic-device')
            self.assertEqual(body['grant_type'], 'refresh_token')
            return 200, {'access_token': token(time.time() + 29000),
                         'refresh_token': 'synthetic-rotated'}, {'x-device': 'synthetic-device-rotated',
                         'x-refresh-token-created-at': 'new'}
        self.assertEqual(url, auth.HOST + auth.PROFILE)
        self.assertTrue(authenticated)
        self.assertEqual(self.db[auth.PENDING]['state'], 'candidate_retained')
        self.assertEqual(self.db[auth.ACCOUNT]['auth']['refresh_token'], 'synthetic-refresh')
        return 200, saved['expected_profile'], {}

    def test_rotation_retained_before_profile_and_atomic_publication(self):
        with patch.object(auth, 'wire', side_effect=self.rotation) as wire:
            result = auth.refresh(force=True)
        self.assertTrue(result['renewed'])
        self.assertTrue(result['refresh_verified'])
        self.assertEqual(wire.call_count, 2)
        active = self.db[auth.ACCOUNT]
        self.assertEqual(active['auth']['refresh_token'], 'synthetic-rotated')
        self.assertEqual(active['renewal']['device_token'], 'synthetic-device-rotated')
        self.assertEqual(active['unrelated_field'], {'preserve': True})
        self.assertEqual(len([x for x in self.writes if x[0] == auth.ACCOUNT]), 1)
        self.assertEqual(self.writes[1][1]['state'], 'response_retained')
        self.assertEqual(self.db[auth.PENDING]['state'], 'published')
        self.assertNotIn('synthetic', json.dumps(result))

    def test_failed_profile_preserves_old_and_new_rotation(self):
        old = copy.deepcopy(self.db[auth.ACCOUNT])

        def wire(*args, **kwargs):
            result = self.rotation(*args, **kwargs)
            return (200, {'id': 999}, {}) if args[0].endswith(auth.PROFILE) else result

        with patch.object(auth, 'wire', side_effect=wire):
            with self.assertRaisesRegex(auth.TalabatError, 'ACCOUNT_IDENTITY_MISMATCH'):
                auth.refresh(force=True)
        self.assertEqual(old, self.db[auth.ACCOUNT])
        self.assertEqual(self.db[auth.PENDING]['candidate']['auth']['refresh_token'], 'synthetic-rotated')
        with patch.object(auth, 'wire', return_value=(200, old['expected_profile'], {})) as wire:
            self.assertTrue(auth.reconcile()['refresh_verified'])
        self.assertEqual(wire.call_count, 1)
        self.assertEqual(wire.call_args.args[0], auth.HOST + auth.PROFILE)

    def test_profile_read_concurrent_writer_preserved_and_candidate_retained(self):
        def wire(*args, **kwargs):
            result = self.rotation(*args, **kwargs)
            if args[0] == auth.HOST + auth.PROFILE:
                self.db[auth.ACCOUNT]['out_of_lock_writer'] = 'preserve'
            return result
        with patch.object(auth, 'wire', side_effect=wire):
            with self.assertRaisesRegex(auth.TalabatError, 'ACCOUNT_CHANGED_RECONCILE_REQUIRED'):
                auth.refresh(force=True)
        self.assertEqual(self.db[auth.ACCOUNT]['out_of_lock_writer'], 'preserve')
        self.assertEqual(self.db[auth.ACCOUNT]['auth']['refresh_token'], 'synthetic-refresh')
        self.assertEqual(self.db[auth.PENDING]['candidate']['auth']['refresh_token'], 'synthetic-rotated')
        self.assertFalse(any(name == auth.ACCOUNT for name, _ in self.writes))

    def raw_response(self):
        from unittest.mock import MagicMock
        response, opener = MagicMock(), MagicMock()
        response.__enter__.return_value = response
        response.code = 200
        response.headers = {'X-Device': 'synthetic-new-device'}
        raw = json.dumps({'access_token': token(), 'refresh_token': 'synthetic-rotated'}).encode()
        response.read.return_value = raw
        opener.open.return_value = response
        return response, opener, raw

    def assert_retained_reconciles_without_post(self, opener, raw):
        self.assertEqual(opener.open.call_count, 1)
        pending = self.db[auth.PENDING]
        self.assertEqual(pending['state'], 'raw_response_retained')
        self.assertEqual(base64.b64decode(pending['response_body_b64']), raw)
        self.assertEqual(pending['response_metadata']['x-device'], 'synthetic-new-device')
        self.assertEqual(self.db[auth.ACCOUNT]['auth']['refresh_token'], 'synthetic-refresh')
        with patch.object(auth, 'wire') as wire:
            with self.assertRaisesRegex(auth.TalabatError, 'RECONCILE_REQUIRED'):
                auth.refresh(force=True)
            wire.assert_not_called()
        with patch.object(auth, 'wire', return_value=(200, self.db[auth.ACCOUNT]['expected_profile'], {})) as wire:
            self.assertTrue(auth.reconcile()['refresh_verified'])
        self.assertEqual(wire.call_count, 1)
        self.assertEqual(wire.call_args.args[0], auth.HOST + auth.PROFILE)
        self.assertEqual(self.db[auth.ACCOUNT]['auth']['refresh_token'], 'synthetic-rotated')

    def test_complete_body_after_deadline_retained_before_timeout(self):
        response, opener, raw = self.raw_response()
        clock = [100.0]
        def read(_size):
            clock[0] = 102.0
            return raw
        response.read.side_effect = read
        with patch.object(auth.urllib.request, 'build_opener', return_value=opener), \
                patch.object(auth.time, 'monotonic', side_effect=lambda: clock[0]):
            with self.assertRaisesRegex(auth.TalabatError, 'NATIVE_READ_TIMEOUT'):
                auth.refresh(force=True, timeout=1)
        self.assert_retained_reconciles_without_post(opener, raw)

    def test_real_alarm_during_json_parse_keeps_complete_rotation(self):
        response, opener, raw = self.raw_response()
        original_loads = json.loads
        def delayed(value, *args, **kwargs):
            if value == raw:
                time.sleep(0.15)
            return original_loads(value, *args, **kwargs)
        old_handler = signal.getsignal(signal.SIGALRM)
        with patch.object(auth.urllib.request, 'build_opener', return_value=opener), \
                patch.object(auth.json, 'loads', side_effect=delayed):
            with self.assertRaisesRegex(auth.TalabatError, 'NATIVE_READ_TIMEOUT'):
                auth.refresh(force=True, timeout=0.07)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        self.assertEqual(signal.getsignal(signal.SIGALRM), old_handler)
        self.assert_retained_reconciles_without_post(opener, raw)

    def test_final_parse_deadline_check_keeps_already_retained_response(self):
        response, opener, raw = self.raw_response()
        clock = [100.0]
        original_loads = json.loads
        def parse(value, *args, **kwargs):
            if value == raw:
                self.assertEqual(self.db[auth.PENDING]['state'], 'raw_response_retained')
                clock[0] = 102.0
            return original_loads(value, *args, **kwargs)
        with patch.object(auth.urllib.request, 'build_opener', return_value=opener), \
                patch.object(auth.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(auth.json, 'loads', side_effect=parse):
            with self.assertRaisesRegex(auth.TalabatError, 'NATIVE_READ_TIMEOUT'):
                auth.refresh(force=True, timeout=1)
        self.assert_retained_reconciles_without_post(opener, raw)

    def test_retention_has_bounded_local_phase_and_sanitized_failure(self):
        response, opener, _ = self.raw_response()
        def stalled_store(name, value):
            if value.get('state') == 'raw_response_retained':
                # Invoke the installed timer handler at the exact storage seam.
                # A 40ms wall-clock alarm races with scheduling/GC in full-suite
                # runs and can arrive after this fake store already completed.
                remaining, interval = signal.getitimer(signal.ITIMER_REAL)
                self.assertGreater(remaining, 0)
                self.assertLessEqual(remaining, 2)
                self.assertEqual(interval, 0)
                signal.getsignal(signal.SIGALRM)(signal.SIGALRM, None)
            self.store(name, value)
        with patch.object(auth.urllib.request, 'build_opener', return_value=opener), \
                patch.object(auth, 'RETENTION_SECONDS', 2), patch.object(auth, 'store', side_effect=stalled_store):
            with self.assertRaisesRegex(auth.TalabatError, '^ACCOUNT_STORAGE_WRITE_FAILED_STOP$'):
                auth.refresh(force=True, timeout=5)
        self.assertEqual(opener.open.call_count, 1)
        self.assertEqual(self.db[auth.PENDING]['state'], 'refresh_in_flight')
        with patch.object(auth, 'wire') as wire:
            with self.assertRaisesRegex(auth.TalabatError, 'RECONCILE_REQUIRED'):
                auth.refresh(force=True)
            wire.assert_not_called()

    def test_incomplete_response_is_not_claimed_retained_or_retried(self):
        import http.client
        response, opener, _ = self.raw_response()
        response.read.side_effect = http.client.IncompleteRead(b'synthetic-private-partial', 100)
        with patch.object(auth.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(auth.TalabatError, '^HTTP_EXCHANGE_FAILED_NO_RETRY$'):
                auth.refresh(force=True)
        self.assertEqual(self.db[auth.PENDING]['state'], 'refresh_in_flight')
        self.assertNotIn('response_body_b64', self.db[auth.PENDING])
        self.assertEqual(opener.open.call_count, 1)

    def test_ambiguous_post_blocks_all_automatic_retry(self):
        with patch.object(auth, 'wire', side_effect=auth.TalabatError('HTTP_EXCHANGE_FAILED_NO_RETRY')) as wire:
            with self.assertRaises(auth.TalabatError):
                auth.refresh(force=True)
            with self.assertRaisesRegex(auth.TalabatError, 'RECONCILE_REQUIRED'):
                auth.refresh(force=True)
            with self.assertRaisesRegex(auth.TalabatError, 'NO_RECONCILABLE'):
                auth.reconcile()
            self.assertEqual(wire.call_count, 1)
        self.assertEqual(self.db[auth.PENDING]['state'], 'refresh_in_flight')

    def test_error_response_never_logs_body_or_retries(self):
        with patch.object(auth, 'wire', return_value=(400, {'message': 'private material'}, {})) as wire:
            with self.assertRaisesRegex(auth.TalabatError, '^AUTH_REQUEST_REJECTED$'):
                auth.refresh(force=True)
            with self.assertRaises(auth.TalabatError):
                auth.refresh(force=True)
        self.assertEqual(wire.call_count, 1)
        self.assertEqual(self.db[auth.ACCOUNT]['auth']['refresh_token'], 'synthetic-refresh')

    def test_status_and_unnecessary_refresh_are_local(self):
        with patch.object(auth, 'wire') as wire:
            self.assertFalse(auth.refresh()['renewed'])
            self.assertTrue(auth.status()['refresh_material_present'])
        wire.assert_not_called()

    def test_rejected_token_coalesces_without_new_post(self):
        with patch.object(auth, 'wire') as wire:
            self.assertFalse(auth.refresh(rejected_token='previous-token')['renewed'])
        wire.assert_not_called()

    def test_missing_device_never_tries_aaa_or_otp(self):
        del self.db[auth.ACCOUNT]['renewal']
        with patch.object(auth, 'wire') as wire:
            with self.assertRaisesRegex(auth.TalabatError, 'REFRESH_MATERIAL_MISSING'):
                auth.refresh(force=True)
        wire.assert_not_called()

    def test_jwt_expiry_not_absolute_expires_in_as_ttl(self):
        self.db[auth.ACCOUNT]['auth'].update(access_token=token(time.time() - 1), expires_in=time.time() + 999999)
        self.assertTrue(auth.status()['expired'])
        self.db[auth.ACCOUNT]['auth']['access_token'] = 'invalid'
        with self.assertRaisesRegex(auth.TalabatError, 'ACCOUNT_TOKEN_INVALID'):
            auth.status()

    def test_explicit_sms_request_does_not_modify_active(self):
        old = copy.deepcopy(self.db[auth.ACCOUNT])
        replies = [(200, {'account_status': 'CustomerExist'}, {}),
                   (200, {'verification_ticket': 'synthetic-ticket'}, {})]
        with patch.object(auth, 'apk_constants', return_value={'client_secret': 'public', 'captcha_hashkey': 'hash'}), \
                patch.object(auth, 'wire', side_effect=replies) as wire:
            self.assertTrue(auth.login_request('unused')['sms_requested'])
            with self.assertRaisesRegex(auth.TalabatError, 'RECONCILE_REQUIRED'):
                auth.login_request('unused')
        self.assertEqual(old, self.db[auth.ACCOUNT])
        self.assertEqual(wire.call_count, 2)
        self.assertEqual(self.db[auth.PENDING]['state'], 'awaiting_sms')

    def test_nonexistent_customer_never_sends_sms(self):
        with patch.object(auth, 'apk_constants', return_value={}), \
                patch.object(auth, 'wire', return_value=(200, {'account_status': 'CustomerNotExist'}, {})) as wire:
            with self.assertRaisesRegex(auth.TalabatError, 'NO_REGISTRATION'):
                auth.login_request('unused')
        self.assertEqual(wire.call_count, 1)
        self.assertNotIn(auth.PENDING, self.db)

    def pending_login(self):
        self.db[auth.PENDING] = {'state': 'awaiting_sms', 'kind': 'login', 'started_at': time.time(),
            'base': copy.deepcopy(self.db[auth.ACCOUNT]), 'constants': {'client_secret': 'public'},
            'operation_id': 'synthetic-op', 'verification_ticket': 'synthetic-ticket'}

    def test_login_keeps_response_headers_and_no_old_renewal_inheritance(self):
        self.pending_login()
        response = {'access_token': token(), 'refresh_token': 'new-login', 'customerId': 123}
        with patch.object(auth, 'fresh_sms', return_value='000000'), \
                patch.object(auth, 'wire', side_effect=[(200, response, {'x-device': 'new-device'}),
                                                        (200, self.db[auth.ACCOUNT]['expected_profile'], {})]):
            self.assertTrue(auth.login_complete()['refresh_material_present'])
        self.assertEqual(self.db[auth.ACCOUNT]['renewal'], {'device_token': 'new-device', 'refresh_token_created_at': None})

    def test_login_without_device_retains_candidate_not_active(self):
        self.pending_login()
        old = copy.deepcopy(self.db[auth.ACCOUNT])
        with patch.object(auth, 'fresh_sms', return_value='000000'), \
                patch.object(auth, 'wire', side_effect=[(200, old['auth'], {}), (200, old['expected_profile'], {})]):
            with self.assertRaisesRegex(auth.TalabatError, 'DEVICE_HEADER_MISSING'):
                auth.login_complete()
        self.assertEqual(self.db[auth.ACCOUNT], old)
        self.assertIsNone(self.db[auth.PENDING]['candidate']['renewal']['device_token'])

    def test_login_code_missing_does_not_consume_ticket(self):
        self.pending_login()
        with patch.object(auth, 'fresh_sms', side_effect=auth.TalabatError('OTP_NOT_UNIQUELY_AVAILABLE')), \
                patch.object(auth, 'wire') as wire:
            with self.assertRaises(auth.TalabatError):
                auth.login_complete()
        wire.assert_not_called()
        self.assertEqual(self.db[auth.PENDING]['state'], 'awaiting_sms')

    def test_changed_record_never_overwritten(self):
        self.pending_login()
        self.db[auth.ACCOUNT]['another_writer'] = True
        with patch.object(auth, 'fresh_sms', return_value='000000'), patch.object(auth, 'wire') as wire:
            with self.assertRaisesRegex(auth.TalabatError, 'ACCOUNT_CHANGED'):
                auth.login_complete()
        wire.assert_not_called()

    def test_sms_exact_sender_uniqueness_and_freshness_query(self):
        from unittest.mock import MagicMock
        db = MagicMock()
        db.execute.return_value.fetchall.return_value = [
            ('Your talabat verification code: 000001', 'fake-talabat'),
            ('Your talabat verification code: 000002', 'talabat')]
        started = time.time() - 10
        with patch.object(auth.sqlite3, 'connect', return_value=db):
            self.assertEqual(auth.fresh_sms(started), '000002')
            params = db.execute.call_args.args[1]
            self.assertEqual(params[0], int((started - 978307200) * 1e9))
            db.execute.return_value.fetchall.return_value.append(('Your talabat verification code: 000003', 'Talabat'))
            with self.assertRaisesRegex(auth.TalabatError, 'NOT_UNIQUELY'):
                auth.fresh_sms(started)
            with self.assertRaisesRegex(auth.TalabatError, 'NO_FRESH'):
                auth.fresh_sms(started - 601)

    def test_cli_refuses_retired_talabat(self):
        # Talabat retired by owner 2026-11-07: the CLI never reaches status/refresh/login.
        with patch.object(auth, 'status', side_effect=AssertionError('must not run')), patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(auth.main(['status']), 5)
        self.assertIn('TALABAT_RETIRED', out.getvalue())

    def test_wire_denies_arbitrary_host_and_never_authenticates_mutation(self):
        for url, body in [('https://example.invalid', None), (auth.HOST + '/logout', {}), (auth.AAA, {})]:
            with self.assertRaisesRegex(auth.TalabatError, 'ENDPOINT_DENIED'):
                auth.wire(url, self.db[auth.ACCOUNT], time.monotonic() + 1, body, authenticated=True)

    def test_wire_retains_only_renewal_headers_and_strips_old_authorization(self):
        from unittest.mock import MagicMock
        response, opener = MagicMock(), MagicMock()
        response.__enter__.return_value = response
        response.code = 200
        response.headers = {'X-Device': 'new-device', 'X-Refresh-Token-Created-At': 'new-time', 'Set-Cookie': 'private'}
        response.read.return_value = b'{"access_token":"synthetic-access"}'
        opener.open.return_value = response
        saved = self.db[auth.ACCOUNT]
        saved['headers'].update(Authorization='old-bearer', Cookie='private', **{'X-Device': 'old-device'})
        with patch.object(auth.urllib.request, 'build_opener', return_value=opener):
            code, data, metadata = auth.wire(auth.AAA, saved, time.monotonic() + 3,
                                             {'refresh_token': 'test'}, {'X-Device': 'correct-device'})
        self.assertEqual(metadata, {'x-device': 'new-device', 'x-refresh-token-created-at': 'new-time'})
        request = opener.open.call_args.args[0]
        self.assertIsNone(request.get_header('Authorization'))
        self.assertIsNone(request.get_header('Cookie'))
        self.assertEqual(request.get_header('X-device'), 'correct-device')

    def test_timeout_validation_precedes_storage_and_mutations(self):
        with patch.object(auth, 'wire') as wire:
            for timeout in [float('nan'), float('inf'), -1, 0, True, 121]:
                with self.assertRaisesRegex(auth.TalabatError, 'INVALID_TIMEOUT'):
                    auth.refresh(force=True, timeout=timeout)
        wire.assert_not_called()
        self.assertEqual(self.writes, [])

    def test_parent_deadline_bounds_lock_and_prevents_late_post(self):
        from contextlib import contextmanager
        clock = [100.0]
        @contextmanager
        def lock(timeout):
            self.assertEqual(timeout, 0.25)
            clock[0] = 100.3
            yield
        with patch.object(auth.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(auth, 'account_lock', lock), patch.object(auth, 'wire') as wire:
            with self.assertRaisesRegex(auth.TalabatError, 'NATIVE_READ_TIMEOUT'):
                auth.refresh(force=True, timeout=25, deadline=100.25)
        wire.assert_not_called()
        self.assertEqual(self.writes, [])

    def test_refresh_validation_receives_original_deadline(self):
        end = time.monotonic() + 5
        def wire(*args, **kwargs):
            self.assertEqual(args[2], end)
            return self.rotation(*args, **kwargs)
        with patch.object(auth, 'wire', side_effect=wire):
            self.assertTrue(auth.refresh(force=True, timeout=25, deadline=end)['renewed'])

    def test_two_concurrent_processes_share_one_rotation(self):
        ctx = multiprocessing.get_context('fork')
        start = ctx.Barrier(2)
        rotations, results = ctx.Value('i', 0), ctx.Queue()
        state_file = Path(self.temp.name) / 'synthetic-state.json'
        state_file.write_text(json.dumps(self.db))

        def worker():
            first = True

            def load(name):
                nonlocal first
                value = json.loads(state_file.read_text()).get(name)
                if first and name == auth.ACCOUNT:
                    first = False
                    start.wait(3)
                return value

            def store(name, value):
                data = json.loads(state_file.read_text())
                data[name] = value
                state_file.write_text(json.dumps(data))

            def wire(url, saved, *args, **kwargs):
                if url == auth.AAA:
                    with rotations.get_lock():
                        rotations.value += 1
                    return 200, {'access_token': token(), 'refresh_token': 'rotated'}, {}
                return 200, saved['expected_profile'], {}

            with patch.object(auth, 'load', load), patch.object(auth, 'store', store), patch.object(auth, 'wire', wire):
                try:
                    results.put(auth.refresh(force=True)['renewed'])
                except Exception:
                    results.put('failed')

        children = [ctx.Process(target=worker) for _ in range(2)]
        for child in children:
            child.start()
        for child in children:
            child.join(6)
            if child.is_alive():
                child.terminate()
                child.join()
            self.assertEqual(child.exitcode, 0)
        self.assertEqual(rotations.value, 1)
        self.assertEqual(sorted([results.get(timeout=1), results.get(timeout=1)]), [False, True])

    def test_crossprocess_lock_excludes_other_process(self):
        # A separate process holds the same file; thread-local locks would fail.
        ctx = multiprocessing.get_context('fork')
        ready, release = ctx.Event(), ctx.Event()

        def hold():
            with auth.account_lock():
                ready.set()
                release.wait(5)

        child = ctx.Process(target=hold)
        child.start()
        try:
            self.assertTrue(ready.wait(3))
            with self.assertRaisesRegex(auth.TalabatError, 'BUSY'):
                with auth.account_lock(timeout=0.1):
                    self.fail('concurrent lock acquisition')
        finally:
            release.set()
            child.join(3)
        self.assertEqual(child.exitcode, 0)


if __name__ == '__main__':
    unittest.main()
