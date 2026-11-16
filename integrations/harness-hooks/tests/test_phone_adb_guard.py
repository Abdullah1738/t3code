if __package__:
    from . import test_environment
else:
    import test_environment

import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / 'src'
sys.path.insert(0, str(SRC))
import phone_adb_guard as guard
import engine
import claude
import codex

CORPUS = json.loads(Path(__file__).with_name('phone_adb_cases.json').read_text())
TAP = 'adb -s X shell input tap 1 1'


class PhoneAdbTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'PH_LOCK_DIR': str(self.root), 'HARNESS_HOOKS_STATE_DIR': str(self.root / 'logs'),
                                          'PH_LEASE_OWNER': '', 'PHONE_HOLD_OWNER': ''})
        self.env.start()
        self.addCleanup(self.env.stop)
        now = dt.datetime.now(dt.timezone.utc)
        self.lease = dict(owner='holder', purpose='release QA', acquired_at=now.isoformat(),
                          expires_at=(now + dt.timedelta(minutes=20)).isoformat(), pid=123, lease_id='generation')
        self.write_lease()

    def write_lease(self):
        (self.root / 'lease.json').write_text(json.dumps(self.lease))

    def test_corpus(self):
        for row in CORPUS:
            with self.subTest(command=row['command']):
                self.assertEqual(bool(guard.classify(row['command'])['reason']), row['deny'])

    def test_all_mutation_verbs(self):
        groups = {'am': ['start', 'force-stop', 'broadcast', 'kill', 'instrument'],
                  'cmd': ['connectivity', 'wifi', 'statusbar', 'package', 'input', 'phone', 'activity'],
                  'pm': ['clear', 'disable', 'enable', 'uninstall', 'grant', 'revoke']}
        for tool, verbs in groups.items():
            for verb in verbs:
                with self.subTest(tool=tool, verb=verb):
                    self.assertTrue(guard.classify(f'adb shell {tool} {verb} pkg')['reason'])

    def test_no_lock_expired_and_corrupt(self):
        (self.root / 'lease.json').unlink()
        self.assertEqual(guard.classify(TAP)['rule'], 'phone-adb-state-unleased')
        self.assertEqual(guard.classify('adb forward tcp:1 tcp:2')['rule'], 'phone-adb-forward-unleased')
        self.lease['acquired_at'] = '2000-01-01T00:00:00+00:00'
        self.lease['expires_at'] = '2000-01-01T00:01:00+00:00'
        self.write_lease()
        self.assertIsNone(guard.classify(TAP)['reason'])
        (self.root / 'lease.json').write_text('{broken')
        with patch.object(guard.time, 'sleep') as sleep:
            verdict = guard.classify(TAP)
        sleep.assert_called_once_with(0.05)
        self.assertIsNone(verdict['reason'])
        self.assertEqual(verdict['error'], 'phone-lock-unavailable')

    def test_partial_write_can_recover_once(self):
        (self.root / 'lease.json').write_text('{partial')
        with patch.object(guard.time, 'sleep', side_effect=lambda _: self.write_lease()) as sleep:
            self.assertTrue(guard.classify(TAP)['reason'])
        sleep.assert_called_once_with(0.05)

    def test_invalid_utf8_can_recover_once(self):
        (self.root / 'lease.json').write_bytes(b'\xff')
        with patch.object(guard.time, 'sleep', side_effect=lambda _: self.write_lease()) as sleep:
            self.assertTrue(guard.classify(TAP)['reason'])
        sleep.assert_called_once_with(0.05)

    def test_phone_errors_cannot_bypass_other_guards(self):
        event = {'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'cwd': str(self.root),
                 'tool_input': {'command': 'adb reboot; rg --files /'}}
        with patch.dict(os.environ, {'PH_LOCK_DIR': '~__phone_guard_unknown_user_145__'}):
            self.assertEqual(engine.decide(event, 'claude')['context']['rule'], 'rootwide-search')
        with patch.object(guard, 'classify', side_effect=RuntimeError('private exception')):
            self.assertEqual(engine.decide(event, 'claude')['context']['rule'], 'rootwide-search')

    def test_bad_lock_shapes_and_read_errors_fail_open(self):
        for value in ['[]', '{}', 'null', '{"owner": 1}', 'x' * (guard.LIMIT + 1), '\udcff']:
            with self.subTest(value=value[:40]):
                (self.root / 'lease.json').write_bytes(value.encode('utf8', errors='surrogateescape'))
                self.assertIsNone(guard.classify(TAP)['reason'])
                self.assertEqual(guard.classify(TAP)['error'], 'phone-lock-unavailable')
        for error in [PermissionError(), OSError(), ValueError()]:
            with patch.object(guard, '_read', side_effect=error):
                self.assertIsNone(guard.classify(TAP)['reason'])
                self.assertEqual(guard.classify(TAP)['error'], 'phone-lock-unavailable')
        (self.root / 'priority-hold').mkdir()
        self.assertEqual(guard.classify(TAP)['error'], 'phone-lock-unavailable')

    def test_read_only_never_reads_lock_state(self):
        with patch.object(guard, '_read', side_effect=AssertionError('lock read')):
            for row in CORPUS:
                if not guard.calls(row['command']):
                    self.assertFalse(guard.classify(row['command'])['matched'])

    def test_hold_precedence_and_privacy(self):
        token = 'private priority hold token 42'
        (self.root / 'priority-hold').write_text(token + '\n')
        for command in [TAP, 'PH_LEASE_OWNER=holder ' + TAP, 'ph lease run --owner holder -- ' + TAP,
                        'adb shell svc wifi disable', 'adb forward tcp:9333 localabstract:chrome_devtools_remote']:
            verdict = guard.classify(command)
            self.assertTrue(verdict['reason'])
            self.assertNotIn(token, json.dumps(verdict))
            self.assertNotIn(command, verdict['reason'])
        self.assertIsNone(guard.classify("PHONE_HOLD_OWNER='" + token + "' " + TAP)['reason'])
        with patch.dict(os.environ, {'PHONE_HOLD_OWNER': token}):
            self.assertIsNone(guard.classify(TAP)['reason'])
            self.assertTrue(guard.classify('env -u PHONE_HOLD_OWNER ' + TAP)['reason'])
        (self.root / 'lease.json').write_text('{corrupt but hold outranks lease')
        self.assertTrue(guard.classify(TAP)['reason'])

    def test_native_adapters_corpus(self):
        with patch.object(engine, 'resolve_identity', return_value={}), patch.object(engine, '_classify_offbox', return_value={'heavy': False}):
            for harness, adapter, tool, field in [('claude', claude, 'Bash', 'command'),
                                                 ('codex', codex, 'exec_command', 'cmd'),
                                                 ('codex', codex, 'mcp__shell__exec_command', 'cmd')]:
                for row in CORPUS:
                    with self.subTest(harness=harness, tool=tool, command=row['command']):
                        event = {'hook_event_name': 'PreToolUse', 'tool_name': tool, 'cwd': str(self.root),
                                 'tool_input': {field: row['command']}}
                        result = engine.decide(event, harness)
                        self.assertEqual(result['decision'] == 'deny', row['deny'])
                        if row['deny']:
                            response = adapter.response(event, result)['hookSpecificOutput']
                            self.assertEqual(response['permissionDecision'], 'deny')

    def test_logs_are_hmac_only_for_unleased_and_broken_locks(self):
        with patch.object(engine, 'resolve_identity', return_value={}), patch.object(engine, '_classify_offbox', return_value={'heavy': False}):
            for raw in [None, '{corrupt']:
                (self.root / 'lease.json').unlink(missing_ok=True)
                if raw is not None:
                    (self.root / 'lease.json').write_text(raw)
                event = {'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'cwd': str(self.root),
                         'tool_input': {'command': TAP}}
                self.assertEqual(engine.decide(event, 'claude')['decision'], 'allow')
        log = (self.root / 'logs/decisions.jsonl').read_text()
        self.assertNotIn(TAP, log)
        rows = [r for r in map(json.loads, log.splitlines()) if r['rule'].startswith('phone-adb')]
        self.assertEqual([r['rule'] for r in rows], ['phone-adb-state-unleased', 'phone-adb-unavailable'])
        self.assertEqual(rows[-1]['error'], 'phone-lock-unavailable')
        for row in rows:
            self.assertIsNone(row['cmd'])
            self.assertEqual(len(row['cmd_hmac_sha256']), 64)

    def test_manifest_parity(self):
        manifest = json.loads((SRC.parents[1] / 'harness-homes/manifest.json').read_text())
        paths = manifest['paritySources']['phone-adb']
        self.assertIn('../harness-hooks/src/phone_adb_guard.py', paths)
        self.assertTrue(any(isinstance(p, dict) and p['source'].endswith('/phone-adb-guard.ts') for p in paths))


if __name__ == '__main__':
    unittest.main()
