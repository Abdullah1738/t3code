import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

from janitor_test_safety import JanitorTestCase

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path.insert(0, str(SCRIPTS))
import tmpdir_prune as prune


class PruneTests(JanitorTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        self.logs = self.root / 'logs'
        self.audit = self.logs / 'tmpdir-audit.jsonl'
        self.keep = self.root / 'keep.txt'
        for name, value in [('TMP', str(self.data)), ('OPENCODE', str(self.data / 'opencode')),
                            ('LOG_DIR', str(self.logs)), ('AUDIT', str(self.audit)),
                            ('KEEP_FILE', str(self.keep))]:
            p = patch.object(prune, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.old = self.tree('coord-scope-guard-old')
        self.open = self.tree('coord-scope-guard-open')

    def tree(self, name, child='file', young=False):
        path = self.data / name
        path.mkdir(parents=True)
        (path / child).write_text('keep me')
        if not young:
            for item in [path / child, path]:
                os.utime(item, (1, 1))
        return path

    def lsof(self, code=0, stdout=None, stderr=''):
        if stdout is None:
            stdout = f'p1\nfcwd\nn/usr/bin\nf3\nn{self.open}/file\n'
        return subprocess.CompletedProcess(['lsof'], code, stdout, stderr)

    def test_unknown_lsof_keeps_everything_and_audits_once(self):
        cases = [
            ('timeout', subprocess.TimeoutExpired('lsof', 120)),
            ('missing', FileNotFoundError('lsof')),
            ('permission', PermissionError('lsof')),
            ('decode', UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'invalid')),
            ('nonzero_partial', self.lsof(code=1)),
            ('signal', self.lsof(code=-9)),
            ('empty', self.lsof(stdout='')),
            ('no_names', self.lsof(stdout='p1\nfcwd\n')),
            ('malformed', self.lsof(stdout='not lsof output\n')),
            ('name_only', self.lsof(stdout='n/path\n')),
            ('file_before_process', self.lsof(stdout='fcwd\nn/path\n')),
            ('name_without_file', self.lsof(stdout='p1\nn/path\n')),
            ('invalid_process', self.lsof(stdout='pbad\nfcwd\nn/path\n')),
            ('invalid_field', self.lsof(stdout='p1\nfcwd\nx/path\n')),
            ('partial_line', self.lsof(stdout='p1\nfcwd\nn/path')),
            ('malformed_after_valid', self.lsof(stdout='p1\nfcwd\nn/path\ntruncated\n')),
            ('trailing_process', self.lsof(stdout='p1\nfcwd\nn/usr/bin\np2\n')),
            ('trailing_file', self.lsof(stdout='p1\nfcwd\nn/usr/bin\nf3\n')),
            ('trailing_process_file', self.lsof(stdout='p1\nfcwd\nn/usr/bin\np2\nf3\n')),
            ('unnamed_process_before_valid', self.lsof(stdout='p1\np2\nfcwd\nn/usr/bin\n')),
            ('unnamed_file_before_valid', self.lsof(stdout='p1\nf3\nf4\nn/usr/bin\n')),
            ('unnamed_file_before_next_process', self.lsof(stdout='p1\nf3\np2\nf4\nn/usr/bin\n')),
            ('err_descriptor', self.lsof(stdout='p1\nferr\nn/read-error\n')),
            ('err_descriptor_after_valid', self.lsof(stdout='p1\nfcwd\nn/usr/bin\np2\nferr\nn/read-error\n')),
            ('nofd_descriptor', self.lsof(stdout='p1\nfNOFD\nn/read-error\n')),
            ('nofd_descriptor_after_valid', self.lsof(stdout='p1\nfcwd\nn/usr/bin\np2\nfNOFD\nn/read-error\n')),
            ('nul', self.lsof(stdout='p1\nfcwd\nn/path\x00\n')),
            ('diagnostic', self.lsof(stderr='incomplete snapshot')),
            ('bytes', self.lsof(stdout=b'undecoded')),
            ('missing_stdout', subprocess.CompletedProcess(['lsof'], 0, None, '')),
        ]
        for label, result in cases:
            with self.subTest(label=label):
                if self.audit.exists():
                    self.audit.unlink()
                kw = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
                with patch.object(prune.subprocess, 'run', **kw), \
                        patch.object(prune.shutil, 'rmtree') as remove, \
                        patch.object(prune.os, 'remove') as unlink, \
                        contextlib.redirect_stdout(io.StringIO()) as stdout:
                    entry = prune.apply()
                remove.assert_not_called()
                unlink.assert_not_called()
                self.assertEqual(stdout.getvalue(), '')
                self.assertEqual((entry['event'], entry['skipped']), ('tmpdir_prune', 'lsof_unavailable'))
                self.assertTrue(entry['reason'])
                self.assertEqual([json.loads(line) for line in self.audit.read_text().splitlines()], [entry])
                self.assertEqual((self.old / 'file').read_text(), 'keep me')
                self.assertEqual((self.open / 'file').read_text(), 'keep me')

    def test_timeout_cli_exits_zero_without_stdout_or_alert(self):
        # The CLI restricts apply to the macOS temp root; lsof fails before any tree read.
        with patch.object(prune, 'TMP', '/private/var/folders/test'), \
                patch.object(prune.subprocess, 'run', side_effect=subprocess.TimeoutExpired('lsof', 120)), \
                patch.object(sys, 'argv', ['tmpdir_prune.py', 'apply']), \
                contextlib.redirect_stdout(io.StringIO()) as stdout, \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(prune.main(), 0)
        self.assertEqual((stdout.getvalue(), stderr.getvalue()), ('', ''))
        self.assertEqual(json.loads(self.audit.read_text())['skipped'], 'lsof_unavailable')
        self.assertTrue(self.old.exists())

    def test_success_preserves_existing_selection_rules(self):
        vitest = self.data / ('a' * 21)
        (vitest / 'ssr').mkdir(parents=True)
        for path in [vitest / 'ssr', vitest]:
            os.utime(path, (1, 1))
        kept = self.tree('crpko-fdb-targets-kept')
        self.keep.write_text(str(kept) + '\n')
        young = self.tree('coord-scope-apply-young', young=True)
        unrelated = self.tree('other-old')
        scratch = self.tree('opencode/report-only')
        symlink = self.data / 'coord-scope-report-link'
        symlink.symlink_to(unrelated, target_is_directory=True)
        with patch.object(prune.subprocess, 'run', return_value=self.lsof()), \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            entry = prune.apply()
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(entry['removed'], 2)
        self.assertEqual(entry['failed'], [])
        self.assertFalse(self.old.exists())
        self.assertFalse(vitest.exists())
        for path in [self.open, kept, young, unrelated, scratch, symlink]:
            self.assertTrue(path.exists(), str(path))
        self.assertEqual(entry['opencode_stale']['entries'], 1)

    def test_successful_snapshot_without_temp_files_still_prunes(self):
        with patch.object(prune.subprocess, 'run', return_value=self.lsof(stdout='p1\nfcwd\nn/usr/bin\nf3\nn\n')):
            self.assertEqual(prune.apply()['removed'], 2)

    def test_explicit_empty_names_are_complete_records(self):
        with patch.object(prune.subprocess, 'run', return_value=self.lsof(stdout='p1\nf3\nn\n')):
            self.assertEqual(prune.in_use(), set())

    def test_complete_multiple_process_and_file_records_preserve_open_paths(self):
        output = f'p1\nfcwd\nn/usr/bin\nf3\nn\np2\nf4\nn{self.open}/file\n'
        with patch.object(prune.subprocess, 'run', return_value=self.lsof(stdout=output)):
            self.assertEqual(prune.apply()['removed'], 1)
        self.assertTrue(self.open.exists())
        self.assertFalse(self.old.exists())

    def test_normal_mac_snapshot_with_hundreds_of_records_still_prunes(self):
        lines = []
        for pid in range(1, 201):
            lines.extend([f'p{pid}', 'fcwd', 'n/sanitised/work', 'ftxt',
                          f'n/sanitised/executable-{pid}', 'f9',
                          'n' if pid % 3 == 0 else f'n/sanitised/file-{pid}'])
        # -F n omits types; NPOLICY descriptors appear as f<number> followed by an empty n.
        lines.extend(['p201', 'f4', f'n{self.open}/file', 'f9', 'n'])
        self.assertGreater(len(lines), 1000)
        self.assertGreater(lines.count('n'), 50)
        with patch.object(prune.subprocess, 'run', return_value=self.lsof(stdout='\n'.join(lines) + '\n')), \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            entry = prune.apply()
        self.assertEqual(stdout.getvalue(), '')
        self.assertNotIn('skipped', entry)
        self.assertEqual((entry['removed'], entry['failed']), (1, []))
        self.assertEqual((self.open / 'file').read_text(), 'keep me')
        self.assertFalse(self.old.exists())
        self.assertEqual(json.loads(self.audit.read_text())['removed'], 1)

    def test_unknown_keep_list_or_tree_keeps_all_candidates(self):
        self.keep.write_bytes(b'\xff')
        with patch.object(prune.subprocess, 'run', return_value=self.lsof()):
            self.assertEqual(prune.apply()['skipped'], 'keep_list_unavailable')
        self.keep.unlink()
        real_scandir = os.scandir

        def scandir(path):
            if str(path) == str(self.old):
                raise PermissionError('unreadable tree')
            return real_scandir(path)

        with patch.object(prune.subprocess, 'run', return_value=self.lsof()), \
                patch.object(prune.os, 'scandir', side_effect=scandir):
            self.assertEqual(prune.apply()['skipped'], 'tree_unavailable')
        self.assertTrue(self.old.exists())
        self.assertTrue(self.open.exists())

    def test_unavailable_user_temp_is_silent_and_audited(self):
        with patch.dict(os.environ, {'TMPDIR': ''}), \
                patch.object(prune.subprocess, 'run', side_effect=subprocess.TimeoutExpired('getconf', 10)):
            self.assertEqual(prune.user_tmp(), '')
        with patch.object(prune, 'TMP', ''), patch.object(sys, 'argv', ['prune', 'apply']), \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(prune.main(), 0)
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(json.loads(self.audit.read_text())['skipped'], 'tmpdir_unavailable')
