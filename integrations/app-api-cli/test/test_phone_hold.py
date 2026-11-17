import json
import os
import subprocess
import sys
from unittest.mock import patch

import phone_hold
from phone_hold_fixture import FakePhTests


class PhoneHoldTests(FakePhTests):
    def assert_closed(self, reason):
        self.assertEqual(phone_hold.status(), {
            'present': True, 'error': reason, 'age_s': None, 'stale_in_s': None,
            'holder_alive': None, 'agent_comm': None})

    def test_absent_and_present(self):
        self.assertFalse(phone_hold.held())
        self.respond(present=True, age_s=300, stale_in_s=1500,
                     holder_alive=True, agent_comm='Codex')
        self.assertEqual(phone_hold.status(), dict(present=True, age_s=300,
            stale_in_s=1500, holder_alive=True, agent_comm='Codex'))
        self.assertTrue(phone_hold.held())

    def test_environment_override_is_used_in_new_process(self):
        self.respond(present=True, agent_comm='override')
        result = subprocess.run([sys.executable, '-B', '-c',
                                'import json, phone_hold; print(json.dumps(phone_hold.status()))'],
                                capture_output=True, text=True, check=True, env=dict(os.environ))
        self.assertEqual(json.loads(result.stdout)['agent_comm'], 'override')

    def test_inspector_environment_is_removed(self):
        with patch.dict(os.environ, {'BUN_INSPECT': 'bad', 'BUN_INSPECT_CONNECT_TO': 'bad'}):
            self.assertFalse(phone_hold.held())

    def test_missing_binary_fails_closed(self):
        with patch.object(phone_hold, 'PH_BIN', str(self.folder / 'missing')):
            self.assert_closed('FileNotFoundError')

    def test_nonzero_exit_fails_closed_even_with_absent_stdout(self):
        self.configure(stdout='{"present": false}', exit_code=1)
        self.assert_closed('ph exited 1')
        self.assertTrue(phone_hold.held())

    def test_invalid_status_forms_fail_closed(self):
        for stdout in ('garbage', '', '[]', 'null', 'true', '1', '"status"', '{}',
                       '{"present": null}', '{"present": 0}', '{"present": 1}',
                       '{"present": "false"}', '{"present": []}', '{"present": {}}'):
            with self.subTest(stdout=stdout):
                self.configure(stdout=stdout)
                status = phone_hold.status()
                self.assertIs(status['present'], True)
                self.assertTrue(status['error'])

    def test_minimal_status_is_valid(self):
        self.configure(stdout='{"present": true}')
        self.assertEqual(phone_hold.status(), {'present': True})

    def test_timeout_fails_closed(self):
        self.configure(sleep=16)
        self.assert_closed('ph timed out')
