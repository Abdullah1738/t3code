"""Test requests cannot change the live expected-auth suppression registry."""
from contextlib import ExitStack
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import inbox_auth
import test_careem_account_auth as careem_tests
import test_commerce_journal as journal_tests


class InboxAuthIsolationTests(unittest.TestCase):
    def setUp(self):
        self.stack = self.enterContext(ExitStack())
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.live_data = self.root / 'live-data'
        self.live_watchers = self.root / 'live-watchers'
        self.live_data.mkdir()
        self.enable(self.live_watchers)
        self.registry = self.live_data / 'inflight-actions.json'
        self.registry.write_text('[{"sender":"sentinel","account":null,"at":1000}]')
        for name, path in (('_LIVE_DATA', self.live_data), ('DATA', self.live_data),
                           ('_LIVE_WATCHERS', self.live_watchers), ('WATCHERS', self.live_watchers)):
            self.stack.enter_context(patch.object(inbox_auth, name, path))
        self.stack.enter_context(patch.dict(os.environ, {
            'ROBOB_TEST': '', 'NODE_ENV': '', 'PYTEST_CURRENT_TEST': ''}))
        self.before = self.snapshot()

    def enable(self, watchers):
        directory = watchers / 'inbox-triage-fastpath'
        directory.mkdir(parents=True)
        (directory / 'watcher.json').write_text('{"paused":false}')

    def snapshot(self):
        info = self.registry.stat()
        return self.registry.read_bytes(), info.st_ino, info.st_mtime_ns

    def test_test_requests_leave_live_registry_untouched_for_every_test_signal(self):
        for env, runner in (({}, True), ({'ROBOB_TEST': '1'}, False), ({'ROBOB_TEST': 'true'}, False),
                            ({'NODE_ENV': 'test'}, False),
                            ({'PYTEST_CURRENT_TEST': 'test_requests (call)'}, False)):
            with self.subTest(env=env), patch.dict(os.environ, env), patch.dict(sys.modules):
                if not runner:
                    sys.modules.pop('unittest', None)
                inbox_auth.expect(('Careem',))
                inbox_auth.expect_payment('2342')
                inbox_auth.expect_payment('9546')
                self.assertEqual(self.snapshot(), self.before)
                self.assertFalse((self.live_data / 'inflight-actions.lock').exists())

    def test_live_subdirectories_and_symlink_aliases_do_not_opt_in(self):
        alias = self.root / 'live-data-alias'
        alias.symlink_to(self.live_data, target_is_directory=True)
        watchers = self.root / 'scratch-watchers'
        self.enable(watchers)
        for data in (self.live_data / 'child', alias):
            with self.subTest(data=data), patch.object(inbox_auth, 'DATA', data), \
                 patch.object(inbox_auth, 'WATCHERS', watchers):
                inbox_auth.expect(('Careem',))
        self.assertFalse((self.live_data / 'child').exists())
        self.assertEqual(self.snapshot(), self.before)

    def test_redirecting_only_one_boundary_still_cannot_touch_live_state(self):
        scratch_watchers = self.root / 'scratch-watchers'
        self.enable(scratch_watchers)
        with patch.object(inbox_auth, 'DATA', self.root / 'scratch-data'):
            inbox_auth.expect(('Careem',))
            self.assertFalse((self.root / 'scratch-data').exists())
        with patch.object(inbox_auth, 'WATCHERS', scratch_watchers):
            inbox_auth.expect_payment('2342')
        self.assertEqual(self.snapshot(), self.before)

    def test_isolated_integration_requests_write_only_the_scratch_registry(self):
        scratch_data = self.root / 'scratch-data'
        scratch_watchers = self.root / 'scratch-watchers'
        self.enable(scratch_watchers)
        with patch.object(inbox_auth, 'DATA', scratch_data), \
             patch.object(inbox_auth, 'WATCHERS', scratch_watchers), \
             patch.dict(os.environ, {'ROBOB_TEST': '1'}):
            inbox_auth.expect(('Careem',))
            inbox_auth.expect_payment('9546')
        actions = json.loads((scratch_data / 'inflight-actions.json').read_text())
        self.assertEqual([a['sender'] for a in actions], ['careem', 'mashreq'])
        self.assertEqual(self.snapshot(), self.before)

    def test_original_producer_regressions_cannot_modify_live_suppression(self):
        suite = unittest.TestSuite([
            journal_tests.CommerceJournalTest('test_place_reserves_payment_once'),
            careem_tests.AccountAuthTest('test_otp_acceptance_is_not_sms_delivery_and_wire_body_is_unchanged'),
        ])
        with patch.dict(os.environ, {'ROBOB_TEST': '1'}):
            output = io.StringIO()
            result = unittest.TextTestRunner(stream=output).run(suite)
        self.assertTrue(result.wasSuccessful(), output.getvalue())
        self.assertEqual(self.snapshot(), self.before)

    def test_production_request_still_records_before_dispatch(self):
        # Remove only the test-runner signal; all paths remain in this fixture.
        with patch.dict(sys.modules):
            sys.modules.pop('unittest', None)
            inbox_auth.expect(('Careem',))
        actions = json.loads(self.registry.read_text())
        self.assertEqual([a['sender'] for a in actions], ['careem'])


if __name__ == '__main__':
    unittest.main()
