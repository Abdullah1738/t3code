"""Reload behavior with isolated files and an HTTP fixture; no live OpenCode."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import TestCase, main, mock

HELPER = Path(__file__).resolve().parents[1] / 'libexec/opencode-reload/opencode_reload.py'
spec = importlib.util.spec_from_file_location('opencode_reload', HELPER)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ReloadTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = mock.patch.dict(os.environ, {'HOME': str(self.root), 'OPENCODE_RELOAD_WAIT': '30',
            'OPENCODE_RELOAD_INSTANCES': json.dumps([{'name': 'HOME', 'url': 'http://127.0.0.1:1'},
                                                   {'name': 'BTSE', 'url': 'http://127.0.0.1:1'}]),
            'OPENCODE_ALLOW_RELOAD': '0', 'TOOLLOG_ROOT': str(self.root / 'logs')})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.src = self.root / 'source.ts'
        self.src.write_bytes(b'new plugin')
        self.dst = self.root / '.config/opencode/plugin/test.ts'
        self.dst.parent.mkdir(parents=True)
        self.dst.write_bytes(b'old plugin')

    def test_noop_does_not_probe_write_or_log(self):
        self.src.write_bytes(self.dst.read_bytes())
        before = self.dst.stat()
        with mock.patch.object(guard, 'quiet_window', side_effect=AssertionError('probe')), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(guard.apply('fixture', [(self.src, self.dst)]), 0)
        self.assertEqual((self.dst.stat().st_ino, self.dst.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        self.assertEqual(out.getvalue(), '')
        self.assertFalse((self.root / '.local/state').exists())

    def test_original_baseline_survives_lock_wait_for_conflicting_or_converged_writes(self):
        for replacement in (b'concurrent edit', self.src.read_bytes()):
            with self.subTest(replacement=replacement):
                self.dst.write_bytes(b'old plugin')
                state = self.root / '.local/state/opencode-reload'
                state.mkdir(parents=True, exist_ok=True)
                observed = threading.Event()
                errors = []
                original_flock = guard.fcntl.flock
                def announced_flock(fd, operation):
                    observed.set()
                    original_flock(fd, operation)
                def apply():
                    try:
                        guard.apply('fixture', [(self.src, self.dst)])
                    except ValueError as error:
                        errors.append(str(error))
                with (state / 'install.lock').open('a') as lock:
                    original_flock(lock, guard.fcntl.LOCK_EX)
                    with mock.patch.object(guard.fcntl, 'flock', side_effect=announced_flock):
                        worker = threading.Thread(target=apply)
                        worker.start()
                        self.assertTrue(observed.wait(5), 'apply did not reach the lock')
                        self.dst.write_bytes(replacement)
                        original_flock(lock, guard.fcntl.LOCK_UN)
                        worker.join(5)
                        self.assertFalse(worker.is_alive())
                self.assertEqual(self.dst.read_bytes(), replacement)
                self.assertEqual(bool(errors), replacement == b'concurrent edit')
                if errors:
                    self.assertIn('changed while waiting for lock', errors[0])
                self.assertFalse(list(self.root.rglob('*.ndjson')))

    def test_expected_baseline_rejects_an_edit_before_helper_starts(self):
        before = self.root / 'original'
        before.write_bytes(b'old plugin')
        self.dst.write_bytes(b'concurrent edit')
        with self.assertRaisesRegex(ValueError, 'changed since planning'):
            guard.apply('fixture', [(self.src, self.dst)], expected_before=[(before, self.dst)])
        self.assertEqual(self.dst.read_bytes(), b'concurrent edit')

    def test_reload_receipt_proves_only_this_invocations_replaced_inode(self):
        receipt = self.root / 'receipt.json'
        with contextlib.redirect_stdout(io.StringIO()):
            guard.apply('fixture', [(self.src, self.dst)], receipt=receipt)
        owner, = json.loads(receipt.read_text())
        self.assertEqual(owner, {'path': str(self.dst), 'device': self.dst.stat().st_dev, 'inode': self.dst.stat().st_ino, 'mtime_ns': self.dst.stat().st_mtime_ns})
        previous = self.root / 'previous.ts'
        previous.write_bytes(b'old plugin')
        # Another installer replaces even identical bytes. This receipt no longer owns it.
        peer = self.root / 'peer'
        peer.write_bytes(self.dst.read_bytes())
        os.replace(peer, self.dst)
        with self.assertRaisesRegex(ValueError, 'no longer owned by this install'):
            guard.apply('fixture-rollback', [(previous, self.dst)], owned_by=receipt)
        self.assertEqual(self.dst.read_bytes(), b'new plugin')

    def test_busy_then_quiet_and_timeout(self):
        elapsed = [0]
        calls = []
        def sleep(seconds):
            calls.append(seconds)
            elapsed[0] += seconds
        def fetch(_):
            return ({'HOME': 1 if not elapsed[0] else 0, 'BTSE': 0}, 1 if not elapsed[0] else 0)
        counts, waited = guard.quiet_window(fetch=fetch, sleep=sleep, clock=lambda: elapsed[0])
        self.assertEqual((counts, waited, calls), ({'HOME': 0, 'BTSE': 0}, 15000, [15]))
        elapsed[0] = 0
        with self.assertRaisesRegex(ValueError, '2 OpenCode sessions busy; rerun later or pass --allow-reload'):
            guard.quiet_window(fetch=lambda _: ({'HOME': 1, 'BTSE': 1}, 2), sleep=sleep, clock=lambda: elapsed[0])
        self.assertEqual(elapsed[0], 30)

    def test_dry_run_validates_settings_without_state_or_network_calls(self):
        invalid = [('OPENCODE_RELOAD_WAIT', value) for value in ('invalid', '-1', '86401', 'nan', 'inf')]
        invalid += [('OPENCODE_RELOAD_INSTANCES', json.dumps(value)) for value in (
            [], {}, [None], [{'name': 1, 'url': 'http://fixture'}],
            [{'name': 'HOME', 'url': None}], [{'name': 'HOME', 'url': 'file:///fixture'}],
            [{'name': 'HOME', 'url': 'http://fixture', 'directory': None}],
            [{'name': 'HOME', 'url': 'http://fixture', 'password_file': 1}],
            [{'name': 'HOME', 'url': 'http://fixture'}] * 2)]
        for key, value in invalid:
            with self.subTest(key=key, value=value), mock.patch.dict(os.environ, {key: value}):
                with mock.patch.object(guard, 'busy_counts', side_effect=AssertionError('probe')):
                    with self.assertRaises(ValueError):
                        guard.apply('fixture', [(self.src, self.dst)], dry_run=True)
                self.assertFalse((self.root / '.local').exists())
                self.assertEqual(self.dst.read_bytes(), b'old plugin')

    def test_staging_rechecks_every_destination_before_the_first_replace(self):
        other = self.dst.parent / 'other.ts'
        other.write_bytes(b'old plugin')
        for target in (self.dst, other):
            for symlink in (False, True):
                with self.subTest(target=target, symlink=symlink):
                    for dst in (self.dst, other):
                        dst.unlink(missing_ok=True)
                        dst.write_bytes(b'old plugin')
                    def edit(_):
                        if symlink:
                            target.unlink()
                            target.symlink_to(self.src)
                        else:
                            target.write_bytes(b'concurrent edit')
                    with mock.patch.object(guard.os, 'fsync', side_effect=edit):
                        with self.assertRaisesRegex(ValueError, 'changed while staging'):
                            guard.apply('fixture', [(self.src, self.dst), (self.src, other)])
                    self.assertEqual(target.read_bytes(), b'new plugin' if symlink else b'concurrent edit')
                    untouched = other if target == self.dst else self.dst
                    self.assertEqual(untouched.read_bytes(), b'old plugin')
                    self.assertFalse(list(self.dst.parent.glob('.opencode-reload-*')))
                    self.assertFalse(list(self.root.rglob('*.ndjson')))

    def test_rollback_rechecks_receipt_after_staging_identical_peer_replacement(self):
        receipt = self.root / 'receipt.json'
        with contextlib.redirect_stdout(io.StringIO()):
            guard.apply('fixture', [(self.src, self.dst)], receipt=receipt)
        before = {p: p.read_bytes() for p in self.root.rglob('*.ndjson')}
        previous = self.root / 'previous.ts'
        previous.write_bytes(b'old plugin')
        def peer_replace(_):
            peer = self.root / 'peer'
            peer.write_bytes(self.src.read_bytes())
            os.replace(peer, self.dst)
        with mock.patch.object(guard.os, 'fsync', side_effect=peer_replace):
            with self.assertRaisesRegex(ValueError, 'no longer owned by this install'):
                guard.apply('fixture-rollback', [(previous, self.dst)], owned_by=receipt)
        self.assertEqual(self.dst.read_bytes(), b'new plugin')
        self.assertEqual({p: p.read_bytes() for p in self.root.rglob('*.ndjson')}, before)
        self.assertFalse(list(self.dst.parent.glob('.opencode-reload-*')))

    def test_allow_reload_does_not_sleep(self):
        counts, _ = guard.quiet_window(True, fetch=lambda _: ({'HOME': 3, 'BTSE': 2}, 5),
                                       sleep=lambda _: self.fail('slept'))
        self.assertEqual(counts, {'HOME': 3, 'BTSE': 2})

    def test_atomic_batch_logs_hashes_and_unknown_and_backups_outside_plugin(self):
        other = self.dst.parent / 'other.ts'
        before_inode = self.dst.stat().st_ino
        replaced = []
        replace = os.replace
        def observed(src, dst):
            self.assertTrue(Path(src).name.startswith('.opencode-reload-'))
            self.assertEqual(Path(src).parent, Path(dst).parent)
            self.assertEqual(Path(src).read_bytes(), b'new plugin')
            replaced.append(dst)
            replace(src, dst)
        with mock.patch.object(guard.os, 'replace', side_effect=observed), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(guard.apply('fixture', [(self.src, self.dst), (self.src, other)]), 2)
        self.assertEqual(len(replaced), 2)
        self.assertNotEqual(self.dst.stat().st_ino, before_inode)
        self.assertEqual(out.getvalue().count('opencode-reload:'), 1)
        self.assertIn('HOME=unknown', out.getvalue())
        self.assertEqual(sorted(p.name for p in self.dst.parent.iterdir()), ['other.ts', 'test.ts'])
        backups = list((self.root / '.config/opencode/backups').rglob('*.bak-*'))
        self.assertEqual([p.read_bytes() for p in backups], [b'old plugin'])
        logs = list(self.root.rglob('*.ndjson'))
        rows = [json.loads(line) for p in logs for line in p.read_text().splitlines()]
        event, = [row for row in rows if row['kind'] == 'opencode-reload']
        self.assertEqual(event['props']['installer'], 'fixture')
        self.assertEqual(event['props']['busy'], {'HOME': 'unknown', 'BTSE': 'unknown'})
        self.assertEqual(event['props']['files'][0]['sha256_before'], guard.digest(b'old plugin'))
        self.assertEqual(event['props']['files'][1]['sha256_before'], None)
        before = self.dst.stat()
        log_before = logs[0].read_bytes()
        guard.apply('fixture', [(self.src, self.dst), (self.src, other)])
        self.assertEqual((self.dst.stat().st_ino, self.dst.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        self.assertEqual(logs[0].read_bytes(), log_before)

    def test_all_sources_preflight_before_any_write_and_dry_run(self):
        before = self.dst.stat()
        with self.assertRaises(FileNotFoundError):
            guard.apply('fixture', [(self.src, self.dst), (self.root / 'missing', self.dst.parent / 'new.ts')])
        self.assertEqual((self.dst.stat().st_ino, self.dst.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        self.assertFalse((self.root / '.local').exists())
        with mock.patch.object(guard, 'quiet_window', side_effect=AssertionError('probe')):
            guard.apply('fixture', [(self.src, self.dst)], dry_run=True)
        self.assertEqual((self.dst.stat().st_ino, self.dst.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))

    def test_http_protocol_auth_and_process_wide_union(self):
        requests = []
        password = self.root / 'password'
        password.write_text('fixture-password')
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, self.headers.get('Authorization')))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"data":{"ses_fixture":{"type":"running"}}}')
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            config = [dict(name=name, url=f'http://127.0.0.1:{server.server_port}', directory=directory,
                           password_file=str(password)) for name, directory in [('HOME', '/fixture'), ('BTSE', '/fixture/BTSE')]]
            counts, total = guard.busy_counts(config)
            self.assertEqual((counts, total), ({'HOME': 1, 'BTSE': 1}, 1))
            self.assertIn('location%5Bdirectory%5D=%2Ffixture%2FBTSE', requests[1][0])
            self.assertTrue(all(auth.startswith('Basic ') for _, auth in requests))
            import subprocess
            command = [os.sys.executable, str(HELPER), '--installer', 'fixture', '--pair', str(self.src), str(self.dst)]
            env = {**os.environ, 'OPENCODE_RELOAD_WAIT': '0', 'OPENCODE_RELOAD_INSTANCES': json.dumps(config)}
            before = self.dst.stat()
            timed_out = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(timed_out.returncode, 1)
            self.assertIn('1 OpenCode sessions busy', timed_out.stderr)
            self.assertEqual(self.dst.stat().st_ino, before.st_ino)
            self.assertEqual(self.dst.stat().st_mtime_ns, before.st_mtime_ns)
            self.assertFalse(list(self.root.rglob('*.ndjson')))
            for flags, overrides in [(['--allow-reload'], {}), ([], {'OPENCODE_ALLOW_RELOAD': '1'})]:
                self.dst.write_bytes(b'old plugin')
                allowed = subprocess.run(command + flags, env={**env, **overrides}, capture_output=True, text=True)
                self.assertEqual(allowed.returncode, 0, allowed.stderr)
                self.assertEqual(allowed.stdout.count('opencode-reload:'), 1)
                self.assertEqual(self.dst.read_bytes(), self.src.read_bytes())

        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_partial_batch_failure_logs_only_the_file_actually_replaced(self):
        other = self.dst.parent / 'other.ts'
        replace = os.replace
        def fail_second(source, destination):
            if destination == other:
                raise OSError('fixture rename failure')
            replace(source, destination)
        with mock.patch.object(guard.os, 'replace', side_effect=fail_second), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(OSError, 'fixture rename failure'):
                guard.apply('fixture', [(self.src, self.dst), (self.src, other)])
        events = [json.loads(line) for p in self.root.rglob('*.ndjson') for line in p.read_text().splitlines()]
        event, = [e for e in events if e['kind'] == 'opencode-reload']
        self.assertFalse(event['ok'])
        self.assertEqual([f['path'] for f in event['props']['files']], [str(self.dst)])
        self.assertFalse(other.exists())
        self.assertFalse(list(self.dst.parent.glob('.opencode-reload-*')))

    def test_busy_timeout_changes_nothing_and_cli_exits_nonzero(self):
        import subprocess
        before = self.dst.stat()
        with mock.patch.object(guard, 'quiet_window', side_effect=ValueError('2 OpenCode sessions busy')):
            with self.assertRaisesRegex(ValueError, 'sessions busy'):
                guard.apply('fixture', [(self.src, self.dst)])
        self.assertEqual((self.dst.stat().st_ino, self.dst.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        result = subprocess.run([os.sys.executable, str(HELPER), '--installer', 'fixture', '--pair',
                                 str(self.root / 'missing'), str(self.dst)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.dst.stat().st_ino, self.dst.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))


if __name__ == '__main__':
    main()
