"""Concurrent SSH setup publishes complete files without sharing temp paths."""
import contextlib
from concurrent.futures import ThreadPoolExecutor
import multiprocessing
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from offbox_lib import api, ssh_sync  # noqa: E402


READY = {'sshEndpoint': '1.2.3.4:2222', 'hostKey': 'ssh-ed25519 AAAA', 'sshUser': 'user'}
BOX = 'bx_test'


@contextlib.contextmanager
def isolated_setup(root):
    with contextlib.ExitStack() as stack:
        for name, value in (('SSH_DIR', root), ('KEY_PATH', root / 'key'), ('CM_DIR', root / 'cm')):
            stack.enter_context(patch.object(ssh_sync, name, value))
        stack.enter_context(patch.object(ssh_sync, 'ensure_dirs'))
        stack.enter_context(patch.object(ssh_sync, 'pubkey', return_value='ssh-ed25519 fixture'))
        stack.enter_context(patch.object(ssh_sync, 'log'))
        stack.enter_context(patch.object(ssh_sync.toollog, 'emit'))
        stack.enter_context(patch.object(api, 'sshkey', return_value=READY))
        stack.enter_context(patch('urllib.request.urlopen', side_effect=AssertionError('unexpected network call')))
        stack.enter_context(patch.object(ssh_sync.subprocess, 'run',
                                         side_effect=AssertionError('unexpected subprocess')))
        yield


def setup_many(barrier):
    replace = ssh_sync.os.replace

    def synchronized_replace(src, dst):
        # Make both writers reach publication before either can rename the shared old temp file.
        if Path(dst).name == f'config_{BOX}':
            barrier.wait(timeout=10)
        replace(src, dst)

    with patch.object(ssh_sync.os, 'replace', side_effect=synchronized_replace):
        for _ in range(50):
            ssh_sync.setup(BOX)


def process_setup(root, barrier):
    with isolated_setup(root):
        setup_many(barrier)


class SshSetupRaceTests(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        stack.enter_context(isolated_setup(self.root))

    def assert_files(self):
        self.assertEqual((self.root / f'known_hosts_{BOX}').read_text(), f'{BOX} ssh-ed25519 AAAA\n')
        self.assertEqual((self.root / f'config_{BOX}').read_text(), f'''Host {BOX}
  HostName 1.2.3.4
  Port 2222
  User user
  IdentityFile {self.root / 'key'}
  IdentitiesOnly yes
  HostKeyAlias {BOX}
  UserKnownHostsFile {self.root / f'known_hosts_{BOX}'}
  StrictHostKeyChecking yes
  BatchMode yes
  ConnectTimeout 10
  ServerAliveInterval 15
  ServerAliveCountMax 4
  ControlMaster auto
  ControlPath {self.root / 'cm'}/%C
  ControlPersist 600
  LogLevel ERROR
''')
        self.assertEqual(list(self.root.glob('*.tmp*')), [])

    def test_parallel_threads(self):
        barrier = threading.Barrier(2)
        # Patch once: threads share the module and must not wrap each other's mock.
        replace = ssh_sync.os.replace

        def synchronized_replace(src, dst):
            if Path(dst).name == f'config_{BOX}':
                barrier.wait(timeout=10)
            replace(src, dst)

        def worker():
            for _ in range(50):
                ssh_sync.setup(BOX)

        with patch.object(ssh_sync.os, 'replace', side_effect=synchronized_replace), \
                ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(worker) for _ in range(2)]
            for future in futures:
                future.result(timeout=20)
        self.assert_files()

    def test_parallel_processes(self):
        ctx = multiprocessing.get_context('spawn')
        barrier = ctx.Barrier(2)
        processes = [ctx.Process(target=process_setup, args=(self.root, barrier)) for _ in range(2)]
        try:
            for process in processes:
                process.start()
            for process in processes:
                process.join(timeout=20)
                self.assertEqual(process.exitcode, 0)
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                if process.pid is not None:
                    process.join(timeout=5)
        self.assert_files()

    def test_known_hosts_is_atomic_and_published_before_config(self):
        kh = self.root / f'known_hosts_{BOX}'
        kh.write_text('previous key\n')
        replace = ssh_sync.os.replace
        published = []

        def observe_replace(src, dst):
            if Path(dst) == kh:
                self.assertEqual(kh.read_text(), 'previous key\n')
                self.assertEqual(Path(src).read_text(), f'{BOX} ssh-ed25519 AAAA\n')
            else:
                self.assertEqual(kh.read_text(), f'{BOX} ssh-ed25519 AAAA\n')
            published.append(Path(dst).name)
            replace(src, dst)

        with patch.object(ssh_sync.os, 'replace', side_effect=observe_replace):
            ssh_sync.setup(BOX)
        self.assertEqual(published, [f'known_hosts_{BOX}', f'config_{BOX}'])
        self.assert_files()

    def test_replace_failure_keeps_previous_file_and_removes_temp(self):
        replace = ssh_sync.os.replace
        for name in (f'known_hosts_{BOX}', f'config_{BOX}'):
            with self.subTest(file=name):
                destination = self.root / name
                destination.write_text('previous content\n')

                def fail_replace(src, dst):
                    if Path(dst) == destination:
                        raise OSError('replace failed')
                    replace(src, dst)

                with patch.object(ssh_sync.os, 'replace', side_effect=fail_replace):
                    with self.assertRaisesRegex(OSError, 'replace failed'):
                        ssh_sync.setup(BOX)
                self.assertEqual(destination.read_text(), 'previous content\n')
                self.assertEqual(list(self.root.glob('*.tmp*')), [])

    def test_fsync_failure_removes_temp(self):
        with patch.object(ssh_sync.os, 'fsync', side_effect=OSError('fsync failed')):
            with self.assertRaisesRegex(OSError, 'fsync failed'):
                ssh_sync.setup(BOX)
        self.assertEqual(list(self.root.iterdir()), [])
