import contextlib
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'libexec/toollog'))
import toollog


class ToolLogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {'TOOLLOG_ROOT': self.tmp.name + '/logs'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.day = datetime.now(timezone.utc).strftime('%Y-%m-%d')

    def rows(self, board='agent-tools'):
        return list(toollog.read(board, self.day))

    def test_format_privacy_modes_and_fail_open(self):
        os.chmod(self.tmp.name, 0o755)
        command = 'curl --password do-not-log-me --header token-secret https://private.invalid'
        toollog.hook('codex-cu', 'shell', 'denied', 'test.deny', 1.5, command)
        toollog.emit('test', 'event', 'test.input', props={'command': command, 'password': 'secret', 'count': 2},
                     error_tag='exception containing secret')
        rows = self.rows()
        self.assertEqual(rows[0]['props']['firstWord'], 'curl')
        self.assertEqual(rows[0]['props']['commandLength'], len(command))
        self.assertEqual(rows[0]['durationMs'], 1.5)
        self.assertRegex(rows[0]['ts'], r'Z$')
        self.assertNotIn('do-not-log-me', json.dumps(rows))
        self.assertNotIn('token-secret', json.dumps(rows))
        self.assertNotIn('private.invalid', json.dumps(rows))
        path = toollog.board_dir('agent-tools') / (self.day + '.ndjson')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(Path(self.tmp.name).stat().st_mode), 0o755)
        with patch.object(os, 'open', side_effect=OSError('private secret')):
            toollog.emit('test', 'error', 'test.failed')
        toollog.emit(None, 'error', None, props='broken')
        self.assertEqual(len(self.rows()), 2)

    def test_retention_and_cap_keep_errors_once_across_process_writers(self):
        directory = toollog.board_dir('agent-tools')
        directory.mkdir(parents=True)
        old = (datetime.now(timezone.utc) - timedelta(days=31)).strftime('%Y-%m-%d')
        for name in (old + '.ndjson', 'rollup-' + old + '.json', '.cap-' + old):
            (directory / name).touch()
        (directory / 'unrelated').touch()
        toollog.emit('test', 'event', 'test.start')
        self.assertFalse((directory / (old + '.ndjson')).exists())
        self.assertFalse((directory / ('rollup-' + old + '.json')).exists())
        self.assertTrue((directory / 'unrelated').exists())
        with patch.object(toollog, 'CAP_BYTES', 1):
            for _ in range(3):
                toollog.emit('test', 'event', 'test.dropped')
                toollog.emit('test', 'error', 'test.kept', error_tag='fixture.error')
        names = [r['name'] for r in self.rows()]
        self.assertEqual(names.count('log.cap'), 1)
        for row in self.rows():
            if row['name'] == 'log.cap': print('TOOLLOG_SAMPLE ' + json.dumps(row, separators=(',', ':')))
        self.assertEqual(names.count('test.kept'), 3)
        self.assertNotIn('test.dropped', names)

    def test_reader_and_rollup_two_boards(self):
        for board in ('agent-tools', 'orders'):
            for i in range(1, 21):
                toollog.emit('fixture', 'perf' if i < 20 else 'error', 'fixture.run', board=board,
                             duration_ms=i, ok=i < 20, ids={'sessionId': 'fixture-session'},
                             error_tag='fixture.failure' if i == 20 else None)
            path = toollog.board_dir(board) / (self.day + '.ndjson')
            with path.open('a') as dest:
                dest.write('partial invalid line\n')
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(toollog.main(['read', '--board', board, '--day', self.day, '--kind', 'error', '--name', 'fixture.run', '--limit', '1']), 0)
            self.assertEqual(len(out.getvalue().splitlines()), 1)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(toollog.main(['rollup', '--board', board, '--day', self.day]), 0)
            result = json.loads((toollog.board_dir(board) / ('rollup-' + self.day + '.json')).read_text())
            self.assertEqual(result['total'], 20)
            self.assertEqual(result['durationMsByName']['fixture.run'], {'p50': 10, 'p95': 19, 'max': 20})
            self.assertEqual(result['okRate'], .95)
            self.assertEqual(result['errorRate'], .05)
            self.assertEqual(result['topErrorTags'][0]['sampleId'], {'sessionId': 'fixture-session'})
        for board, day in [('../escape', self.day), ('orders', '../../escape'), ('Orders', self.day)]:
            with self.assertRaises(ValueError):
                list(toollog.read(board, day))

    def test_rollup_prefers_available_error_ids(self):
        toollog.emit('fixture', 'error', 'fixture.error', error_tag='fixture.failure')
        toollog.emit('fixture', 'error', 'fixture.error', error_tag='fixture.failure', ids={'sessionId': 'available-id'})
        self.assertEqual(toollog.rollup('agent-tools', self.day)['topErrorTags'][0]['sampleId'], {'sessionId': 'available-id'})

    def test_hook_errors_keep_ids_in_rollups(self):
        native = 'thread:project:/fixture%2Frepo:thread-id'
        toollog.hook('codex', 'shell', 'denied', 'fixture.denied', 1, ids={'threadId': native})
        self.assertEqual(toollog.rollup('agent-tools', self.day)['topErrorTags'][0]['sampleId'], {'threadId': native})

    def test_added_hook_logging_under_two_ms(self):
        # Warm-up includes retention, then measure the actual per-call write cost.
        toollog.hook('codex', 'shell', 'allowed', 'no-policy', 0, 'git status')
        started = time.perf_counter()
        for _ in range(500):
            toollog.hook('codex', 'shell', 'allowed', 'no-policy', 0, 'git status')
        ms = (time.perf_counter() - started) * 1000 / 500
        print(f'toollog added hook cost: {ms:.3f} ms/call')
        self.assertLess(ms, 2)
        self.assertEqual(len(self.rows()), 501)


if __name__ == '__main__':
    unittest.main()
