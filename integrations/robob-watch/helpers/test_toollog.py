"""Offline format, privacy, retention and cross-process cap proofs."""
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('toollog.py')
spec = importlib.util.spec_from_file_location('watchers_toollog_test', SOURCE)
log = importlib.util.module_from_spec(spec)
spec.loader.exec_module(log)
NOW = dt.datetime(2026, 11, 13, 20, 31, 42, 123456, tzinfo=dt.timezone.utc)


class FrozenDateTime(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW


class ToolLogTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.directory = self.root / 'logs'
        environment = patch.dict(os.environ, {'TOOLLOG_DIR': str(self.directory), 'ROBOB_TEST': '1'})
        environment.start()
        self.addCleanup(environment.stop)
        log._initialized.clear()

    def rows(self):
        return [json.loads(line) for path in self.directory.glob('*.ndjson') for line in path.read_text().splitlines()]

    def entry(self, **fields):
        return {'component': 'triage', 'kind': 'event', 'name': 'triage.decision', **fields}

    def test_format_allowlist_hashes_and_utc_milliseconds(self):
        private = 'private-subject-body-password-health-value'
        entry = self.entry(durationMs=1.5, ok=True, body=private, prompt=private,
                           ids={'watcher': 'inbox-triage', 'helper': 'mail-worker', 'item': private,
                                'chat': 'owner@example.test', 'run': 123, 'subject': private},
                           props={'source': 'mail', 'class': 'urgent', 'routed': 'chat', 'deduped': False,
                                  'exitCode': 0, 'count': 2, 'accepted': True, 'severity': 'info',
                                  'outcome': 'fire', 'action': 'queue', 'state': 'pending',
                                  'subject': private, 'body': private, 'health': 96, 'prompt': private},
                           error={'tag': 'classifier.failed', 'message': private, 'stack': private})
        with patch.object(log.dt, 'datetime', FrozenDateTime):
            log.tool_log(entry)
        row, = self.rows()
        self.assertEqual(row['ts'], '2026-11-13T20:31:42.123Z')
        self.assertEqual(row['tool'], 'watchers')
        self.assertEqual(row['durationMs'], 1.5)
        self.assertEqual(row['ids'], {'watcher': 'inbox-triage', 'helper': 'mail-worker',
                                     'item': hashlib.sha256(private.encode()).hexdigest()[:24],
                                     'chat': hashlib.sha256(b'owner@example.test').hexdigest()[:24],
                                     'run': hashlib.sha256(b'123').hexdigest()[:24]})
        self.assertEqual(row['props'], {key: value for key, value in entry['props'].items()
                                        if key not in ('subject', 'body', 'health', 'prompt')})
        self.assertEqual(row['error'], {'tag': 'classifier.failed', 'message': 'classifier.failed'})
        self.assertNotIn(private, json.dumps(row))

    def test_names_preserve_only_safe_basenames_and_other_ids_always_hash(self):
        for value in ('mail-worker', 'triage.py', 'Email_Helper'):
            log.tool_log(self.entry(ids={'helper': value, 'watcher': value, 'operation': value}))
        for value in ('/private/triage.py', 'email@example.test', 'phone-97150123456', 'private text'):
            log.tool_log(self.entry(ids={'helper': value, 'watcher': value}))
        for row, value in zip(self.rows(), ('mail-worker', 'triage.py', 'Email_Helper', '/private/triage.py',
                                           'email@example.test', 'phone-97150123456', 'private text')):
            digest = hashlib.sha256(value.encode()).hexdigest()[:24]
            self.assertEqual(row['ids']['helper'], value if 'operation' in row['ids'] else digest)
            self.assertEqual(row['ids']['watcher'], row['ids']['helper'])
            if 'operation' in row['ids']:
                self.assertEqual(row['ids']['operation'], digest)

    def test_invalid_and_nonfinite_metadata_never_stringifies_objects(self):
        class Unprintable:
            def __str__(self):
                raise RuntimeError('private exception must not escape')

        for entry in (None, [], Unprintable(), self.entry(component=Unprintable()),
                      self.entry(name='private subject'), self.entry(kind=Unprintable())):
            log.tool_log(entry)
        log.tool_log(self.entry(durationMs=float('nan'), ok=1,
                               ids={'item': Unprintable(), 'run': True},
                               props={'count': True, 'bytes': float('inf'), 'attempt': 10 ** 1000,
                                      'source': Unprintable(), 'class': 'private subject', 'deduped': 1},
                               error={'tag': Unprintable()}))
        log.tool_error(Unprintable(), 'helper.failed')
        row, = self.rows()
        self.assertEqual(set(row), {'ts', 'tool', 'component', 'kind', 'name'})

    def test_private_permissions_repair_existing_directory_and_file(self):
        self.directory.mkdir(mode=0o755)
        path = self.directory / (NOW.date().isoformat() + '.ndjson')
        path.touch(mode=0o644)
        with patch.object(log.dt, 'datetime', FrozenDateTime):
            log.tool_log(self.entry())
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_retains_thirty_days_and_only_removes_owned_dated_files(self):
        self.directory.mkdir()
        old, boundary = ((NOW - dt.timedelta(days=n)).date().isoformat() for n in (31, 30))
        expired = [old + '.ndjson', old + '.cap', 'rollup-' + old + '.json']
        keep = [boundary + '.ndjson', boundary + '.cap', 'rollup-' + boundary + '.json',
                'notes.txt', old + '.ndjson.backup', 'unrelated-' + old + '.json']
        for name in expired + keep:
            (self.directory / name).touch()
        with patch.object(log.dt, 'datetime', FrozenDateTime):
            log.tool_log(self.entry())
        self.assertFalse(any((self.directory / name).exists() for name in expired))
        self.assertTrue(all((self.directory / name).exists() for name in keep))

    def test_tests_without_explicit_directory_do_not_log(self):
        for marker in ('ROBOB_TEST', 'PYTEST_CURRENT_TEST', 'NODE_ENV'):
            with patch.dict(os.environ), patch.object(log.Path, 'home', return_value=self.root):
                for key in ('TOOLLOG_DIR', 'ROBOB_TEST', 'PYTEST_CURRENT_TEST', 'NODE_ENV'):
                    os.environ.pop(key, None)
                os.environ[marker] = 'test' if marker == 'NODE_ENV' else '1'
                log.tool_log(self.entry())
        self.assertFalse((self.root / '.robob').exists())
        self.assertFalse(self.directory.exists())

    def test_filesystem_and_formatting_failures_never_escape(self):
        with patch.object(log.json, 'dumps', side_effect=ValueError('private formatting failure')):
            log.tool_log(self.entry())
            log.tool_error('triage', 'helper.failed')
        self.directory.rmdir()
        self.directory.write_text('a file cannot be a log directory')
        log._initialized.clear()
        log.tool_log(self.entry())
        log.tool_error('triage', 'helper.failed')
        self.assertEqual(self.directory.read_text(), 'a file cannot be a log directory')

    def test_retention_unlink_failure_does_not_drop_the_event(self):
        self.directory.mkdir()
        (self.directory / '2000-01-01.ndjson').touch()
        with patch.object(log.Path, 'unlink', side_effect=PermissionError('private path')):
            log.tool_log(self.entry())
        self.assertEqual(len(self.rows()), 1)

    def test_cap_marker_is_shared_across_processes_and_errors_continue(self):
        self.directory.mkdir()
        day = dt.datetime.now(dt.timezone.utc).date().isoformat()
        path = self.directory / (day + '.ndjson')
        with path.open('wb') as stream:
            stream.truncate(log.CAP + 1)
        program = '''import importlib.util, sys
spec = importlib.util.spec_from_file_location('isolated_toollog', sys.argv[1])
log = importlib.util.module_from_spec(spec)
spec.loader.exec_module(log)
log.tool_log({'component':'triage','kind':'event','name':'suppressed.event'})
log.tool_error('triage', 'helper.failed')
'''
        children = [subprocess.Popen([sys.executable, '-I', '-B', '-c', program, str(SOURCE)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(4)]
        for child in children:
            stdout, stderr = child.communicate(timeout=10)
            self.assertEqual((child.returncode, stdout, stderr), (0, b'', b''))
        with path.open('rb') as stream:
            stream.seek(log.CAP + 1)
            rows = [json.loads(line) for line in stream]
        self.assertEqual(sum(row['name'] == 'log.cap' for row in rows), 1)
        self.assertEqual(sum(row['error']['tag'] == 'helper.failed' for row in rows), 4)
        self.assertEqual(stat.S_IMODE((self.directory / (day + '.cap')).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)


if __name__ == '__main__':
    unittest.main()
