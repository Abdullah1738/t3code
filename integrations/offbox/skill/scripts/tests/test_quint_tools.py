"""Pinned archive staging and PATH behavior, without touching a live box."""
import hashlib
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import common, java_version, node_tools, quint_tools, runs


class QuintToolsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.archive = self.root / '.local/share/apalache-patched' / quint_tools.ARCHIVE_NAME
        self.archive.parent.mkdir(parents=True)
        self.archive.write_bytes(b'reviewed archive fixture')
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.addCleanup(patch.stopall)
        patch.object(Path, 'home', return_value=self.root).start()
        patch.object(common, 'person', return_value=None).start()
        self.ssh = patch.object(quint_tools.ssh_sync, 'ssh').start()
        self.upload = patch.object(quint_tools.ssh_sync, 'put_file').start()
        self.ssh.return_value.returncode = 1

    def test_archive_is_verified_before_upload_and_published_after_remote_hash_check(self):
        with patch.object(quint_tools, 'ARCHIVE_SHA', self.digest):
            quint_tools.ensure_archive('box')
        self.assertEqual(self.upload.call_args.args[2], self.archive.read_bytes())
        pending = self.upload.call_args.args[1]
        publish = self.ssh.call_args.args[1]
        self.assertIn(f'sha256sum {shlex.quote(pending)}', publish)
        self.assertIn(f'= {self.digest} && mv', publish)
        self.assertIn(quint_tools.REMOTE_ARCHIVE, publish)

    def test_corrupt_local_archive_never_uploads(self):
        with self.assertRaisesRegex(common.OffboxError, 'sha256 mismatch'):
            quint_tools.ensure_archive('box')
        self.upload.assert_not_called()

    def test_cached_verified_archive_does_not_upload_again(self):
        self.ssh.return_value.returncode = 0
        quint_tools.ensure_archive('box')
        self.upload.assert_not_called()

    def test_missing_archive_allows_unrelated_work_without_download(self):
        self.archive.unlink()
        quint_tools.ensure_archive('box')
        self.ssh.assert_not_called()
        self.upload.assert_not_called()

    def test_person_boxes_are_unchanged(self):
        with patch.object(common, 'person', return_value='moni'):
            quint_tools.ensure_archive('box')
            self.assertEqual(quint_tools.block(), ':')
        self.ssh.assert_not_called()

    def test_guard_precedes_repo_and_global_cli_after_cd_and_child_bash(self):
        repo = self.root / 'w/repo'
        (repo / 'child/node_modules/.bin').mkdir(parents=True)
        (repo / 'package.json').write_text('{}')
        for directory in (repo / 'node_modules/.bin', repo / 'child/node_modules/.bin'):
            directory.mkdir(parents=True, exist_ok=True)
            raw = directory / 'quint'
            raw.write_text('#!/bin/sh\necho RAW\n')
            raw.chmod(0o755)
        wrapper = self.root / 'fake-wrapper'
        wrapper.write_text('#!/bin/sh\necho GUARDED\n')
        with patch.object(quint_tools, 'wrapper_path', return_value=wrapper):
            script = quint_tools.block() + node_tools.block('w/repo')
        script += '\nquint; cd child && quint; bash -c quint\n'
        result = subprocess.run(['bash', '-c', script], cwd=repo,
                                env={'HOME': str(self.root), 'PATH': '/usr/bin:/bin'},
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['GUARDED'] * 3)

    def test_production_preamble_keeps_guard_after_java_activation(self):
        repo = self.root / 'w/repo'
        (repo / 'child').mkdir(parents=True)
        (repo / 'package.json').write_text('{}')
        jdk = self.root / 'jvm/java-21-openjdk-test'
        for directory in (repo / 'node_modules/.bin', repo / 'child/node_modules/.bin',
                          jdk / 'bin', self.root / 'node-commands'):
            directory.mkdir(parents=True, exist_ok=True)
            raw = directory / 'quint'
            raw.write_text('#!/bin/sh\necho RAW\n')
            raw.chmod(0o755)
        for name, body in (('javac', 'echo javac 21.0.13'), ('java', ':')):
            executable = jdk / 'bin' / name
            executable.write_text('#!/bin/sh\n' + body + '\n')
            executable.chmod(0o755)
        for directory in (repo / 'node_modules/.bin', repo / 'child/node_modules/.bin',
                          self.root / 'node-commands'):
            executable = directory / 'node'
            executable.write_text('#!/bin/sh\necho ' + ('SELECTED_NODE' if directory.name == 'node-commands'
                                                       else 'RAW_NODE') + '\n')
            executable.chmod(0o755)
        wrapper = self.root / 'fake-wrapper'
        wrapper.write_text('#!/bin/sh\necho GUARDED\n')
        java_shell = java_version.SHELL.replace('/usr/lib/jvm', str(self.root / 'jvm'))
        timeout = self.root / 'test-bin/timeout'
        timeout.parent.mkdir()
        timeout.write_text('#!/bin/sh\n[ "$1" != -k ] || shift 2\nshift\nexec "$@"\n')
        timeout.chmod(0o755)
        node_shell = ('export __offbox_node_commands="$HOME/node-commands"\n'
                      'export PATH="$__offbox_node_commands:$PATH"')
        for node in ('', node_shell):
            for rel in ('.', 'child'):
                for stepped in (False, True):
                    with self.subTest(node=bool(node), rel=rel, stepped=stepped), \
                            patch.object(quint_tools, 'wrapper_path', return_value=wrapper), \
                            patch.object(java_version, 'SHELL', java_shell), \
                            patch.multiple(runs, GO_REPAIR=':', DOCKER_REPAIR=':', LDCACHE_REPAIR=':',
                                           SQLITE_SETUP=':', WATCH_REPAIR=':', CACHE_OWNER_REPAIR=':'), \
                            patch.object(runs.userns, 'setup', return_value=':'), \
                            patch.object(runs.containers, 'script', return_value=':'):
                        invoke = 'quint verify' + ('; node' if node else '')
                        child = invoke + '; bash -c ' + shlex.quote(invoke)
                        command = ('[ "$JAVA_HOME" = "$HOME/jvm/java-21-openjdk-test" ] || exit 88; '
                                   + invoke + '; cd "$HOME/w/repo/child" && ' + invoke
                                   + '; bash -c ' + shlex.quote(child))
                        script = runs.remote_script('w/repo', rel, [] if stepped else [command], None, 'test',
                                                    steps=[command] if stepped else None,
                                                    repo_root=repo, node=node)
                        result = subprocess.run(['bash', '-c', script], cwd=self.root,
                                                env={'HOME': str(self.root),
                                                     'PATH': f'{timeout.parent}:/usr/bin:/bin'},
                                                capture_output=True, text=True, timeout=10)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(result.stdout.splitlines(),
                                         (['GUARDED', 'SELECTED_NODE'] if node else ['GUARDED']) * 4)


if __name__ == '__main__':
    unittest.main()
