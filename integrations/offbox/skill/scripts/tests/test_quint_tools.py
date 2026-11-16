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
from offbox_lib import common, node_tools, quint_tools


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


if __name__ == '__main__':
    unittest.main()
