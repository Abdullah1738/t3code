import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

from janitor_test_safety import JanitorTestCase

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path.insert(0, str(SCRIPTS))
import tmpdir_prune as prune
import tmpdir_inventory as inventory
REAL_PROCESS_REFERENCES = prune.process_references


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
        for name, value in [('process_references', set()), ('emit', None)]:
            p = patch.object(prune, name, return_value=value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.dict(os.environ, {'TMPDIR_PRUNE_DELETE': '1'})
        p.start()
        self.addCleanup(p.stop)
        for module, name, value in [(prune, 'CONFIG', str(self.root/'config.json')),
                                    (inventory, 'DISK_LOCK', str(self.root/'inventory.lock'))]:
            p = patch.object(module, name, value)
            p.start()
            self.addCleanup(p.stop)
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
        self.assertEqual(json.loads(self.audit.read_text().splitlines()[-1])['removed'], 1)

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
            result = prune.apply()
            self.assertEqual(result['removed'], 0)
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

    def test_report_only_default_and_explicit_disabled_flag_delete_nothing(self):
        for value in (None, '0', 'false', 'yes'):
            with self.subTest(value=value), patch.dict(os.environ), \
                    patch.object(prune, 'in_use', return_value=set()):
                os.environ.pop('TMPDIR_PRUNE_DELETE', None)
                if value is not None:
                    os.environ['TMPDIR_PRUNE_DELETE'] = value
                result = prune.apply()
                self.assertTrue(result['report_only'])
                self.assertEqual(result['removed'], 0)
                self.assertTrue(self.old.exists())

    def test_agent_24_hour_boundary_and_configurable_threshold(self):
        now = 2000000
        for offset in (-1, 0, 1):
            path = self.tree('tmp.boundary' + str(offset))
            for item in (path, path/'file'):
                os.utime(item, (now-86400-offset, now-86400-offset))
            with patch.object(prune.time, 'time', return_value=now), \
                    patch.object(prune, 'in_use', return_value=set()):
                paths = {c['path'] for c in prune.scan()['candidates']}
            self.assertEqual(str(path) in paths, offset >= 0)
        with patch.dict(os.environ, {'TMPDIR_PRUNE_IDLE_HOURS': '48'}), \
                patch.object(prune.time, 'time', return_value=now), \
                patch.object(prune, 'in_use', return_value=set()):
            self.assertFalse(any('boundary' in c['path'] for c in prune.scan()['candidates']))

    def test_configuration_file_is_supported_for_sanitized_watcher_environment(self):
        with patch.dict(os.environ):
            os.environ.pop('TMPDIR_PRUNE_DELETE', None)
            Path(prune.CONFIG).write_text('{"delete":true,"idleHours":36}')
            self.assertTrue(prune.deletion_enabled())
            self.assertEqual(prune.idle_hours(), 36)
            with patch.dict(os.environ, {'TMPDIR_PRUNE_DELETE': '0', 'TMPDIR_PRUNE_IDLE_HOURS': '24'}):
                self.assertFalse(prune.deletion_enabled())
                self.assertEqual(prune.idle_hours(), 24)

    def test_invalid_threshold_fails_closed(self):
        for value in ('NaN', 'inf', '0', '-1', 'bad'):
            with self.subTest(value=value), patch.dict(os.environ, {'TMPDIR_PRUNE_IDLE_HOURS': value}), \
                    patch.object(prune, 'in_use', return_value=set()):
                self.assertEqual(prune.scan()['skipped'], 'config_unavailable')

    def test_agent_patterns_and_explicit_exclusions(self):
        names = ['tmp.scratch', 'harness-exit.receipt', 'chat-review-abc', 'live-db-snapshot-abc',
                 't3-control-fixture', 't3-orchestration-v2-fixture', 'recall-toollog-test-fixture',
                 'offbox12-review-a', 'offbox2-recheck-a', 'offbox1-integration-a', 'offbox-278-osr93_uj',
                 'robob1937-traces.swf213x7']
        unknown = ['com.apple.foo-review-bar', 'uv-abc.lock', 'ZqpGpiTjSMKJrZcUYPbjo',
                   'unknown-old', 'offbox12-output', 't3-other', 'tmpscratch',
                   'tmp.has space', 'tmp.has\nnewline', 'tmp.has\ttab']
        for name in names + unknown:
            path = self.tree(name)
            self.assertEqual(prune.classify(name, str(path)), 'agent' if name in names else None, name)
        with patch.object(prune, 'in_use', return_value=set()):
            result = prune.apply()
        self.assertEqual(result['removed'], 2+len(names))
        self.assertTrue(all((self.data/n).exists() for n in unknown))

    def test_young_descendant_symlink_foreign_uid_and_budget_are_kept(self):
        path = self.tree('tmp.new-child')
        (path/'file').touch()
        target = self.tree('tmp.symlink')
        (target/'link').symlink_to(self.old)
        with patch.object(prune, 'in_use', return_value=set()):
            paths = {c['path'] for c in prune.scan()['candidates']}
        self.assertNotIn(str(path), paths)
        self.assertNotIn(str(target), paths)
        with patch.object(inventory.os, 'getuid', return_value=os.getuid()+1), self.assertRaises(prune.UsageUnavailable):
            inventory.inspect(str(self.old))
        with patch.object(inventory, 'MAX_NODES', 1), self.assertRaises(prune.UsageUnavailable):
            inventory.inspect(str(self.old))

    def test_fresh_use_or_new_file_after_scan_prevents_removal(self):
        for change in ('open', 'young', 'replace'):
            path = self.tree('tmp.race-' + change)
            with patch.object(prune, 'in_use', return_value=set()):
                candidate = next(c for c in prune.scan()['candidates'] if c['path'] == str(path))
            if change == 'young':
                (path/'file').touch()
            elif change == 'replace':
                path.rename(self.root/'original')
                self.tree(path.name)
            with patch.object(prune, 'in_use', return_value={str(path/'file')} if change == 'open' else set()), \
                    inventory.disk_lock() as fd, self.assertRaises(prune.UsageUnavailable):
                prune.remove_candidate(candidate, time.monotonic()+60, fd)
            self.assertTrue(path.exists())

    def make_worktree(self, name):
        parent = self.root/name
        parent.mkdir()
        def git(*args):
            return subprocess.run(['git', '-C', str(parent), *args], check=True,
                                  capture_output=True, text=True).stdout
        git('init')
        git('config', 'user.email', 'test@example.invalid')
        git('config', 'user.name', 'Test')
        (parent/'file').write_text('tracked')
        git('add', 'file')
        git('-c', 'commit.gpgsign=false', 'commit', '-m', 'initial')
        git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        path = self.data/('tmp.'+name)
        git('worktree', 'add', '--detach', str(path), 'HEAD')
        return path, git

    def age_tree(self, path):
        for root, dirs, files in os.walk(path):
            for name in dirs + files:
                os.utime(Path(root)/name, (1, 1))
        os.utime(path, (1, 1))

    def test_clean_worktree_removed_through_parent_and_registration_disappears(self):
        path, git = self.make_worktree('clean')
        self.age_tree(path)
        with patch.object(prune, 'in_use', return_value=set()):
            result = prune.apply()
        self.assertEqual(result['failed'], [])
        self.assertFalse(path.exists())
        self.assertNotIn(str(path), git('worktree', 'list', '--porcelain'))

    def test_standalone_repository_preserves_every_class_of_unpublished_ref(self):
        refs = {'branch': 'refs/heads/local', 'tag': 'refs/tags/local',
                'notes': 'refs/notes/commits', 'custom': 'refs/archive/local',
                'reflog': None, 'stash': 'refs/stash'}
        for kind, ref in refs.items():
            with self.subTest(kind=kind):
                linked, git = self.make_worktree('ref-'+kind)
                git('worktree', 'remove', str(linked))
                parent = self.root/('ref-'+kind)
                if kind == 'stash':
                    (parent/'file').write_text('unpublished stash')
                    git('stash', 'push')
                else:
                    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'unpublished')
                    commit = git('rev-parse', 'HEAD').strip()
                    git('reset', '--hard', 'HEAD^')
                    if ref:
                        git('update-ref', ref, commit)
                        git('reflog', 'expire', '--expire=now', '--all')
                self.age_tree(parent)
                with self.assertRaises(prune.UsageUnavailable):
                    inventory.inspect(str(parent))

    def test_unpublished_dirty_untracked_orphan_and_locked_worktrees_always_kept(self):
        for kind in ('unpublished', 'dirty', 'untracked', 'orphan', 'locked'):
            path, git = self.make_worktree(kind)
            if kind == 'unpublished':
                git('-C', str(path), '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'local')
            elif kind == 'dirty':
                (path/'file').write_text('uncommitted')
            elif kind == 'untracked':
                (path/'notes').write_text('untracked')
            elif kind == 'orphan':
                (path/'.git').write_text('gitdir: /does/not/exist')
            else:
                git('worktree', 'lock', str(path))
            self.age_tree(path)
            with patch.object(prune, 'in_use', return_value=set()):
                report = prune.scan()
                self.assertNotIn(str(path), {c['path'] for c in report['candidates']}, kind)
                self.assertTrue(any(c['path'] == str(path) for c in report['kept']), kind)
            self.assertTrue(path.exists())

    def test_process_argv_and_var_alias_protect_the_top_level_entry(self):
        with patch.object(prune, 'TMP', '/private/var/folders/test/T'), \
                patch.object(prune.subprocess, 'run', return_value=self.lsof(stdout='p1\nfcwd\nn/var/folders/test/T/tmp.x/file\n')):
            self.assertEqual(prune.in_use(), {'/private/var/folders/test/T/tmp.x/file'})
        forms = [
            '/var/folders/test/T/tmp.owner/script.py',
            '/private/var/folders/test/T/tmp.owner/script.py',
            '/var/folders/test/T//tmp.owner/script.py',
            '/private/var/folders/test/T///tmp.owner/script.py',
            '/var//folders/test//T//tmp.owner/script.py',
            '/var/folders/test/T/./tmp.owner/script.py',
            '/var/folders/test/T/other/../tmp.owner/script.py',
            '"/var/folders/test/T//tmp.owner/script.py"',
            "'/private/var/folders/test/T//tmp.owner/script.py'",
            '--script=/var/folders/test/T//tmp.owner/script.py',
        ]
        for form in forms:
            with self.subTest(form=form), patch.object(prune, 'TMP', '/private/var/folders/test/T'), \
                    patch.object(prune.subprocess, 'run', return_value=self.lsof(stdout='12 python ' + form + '\n')):
                self.assertEqual(REAL_PROCESS_REFERENCES(), {'/private/var/folders/test/T/tmp.owner'})

    def test_work_created_during_final_process_snapshot_is_kept(self):
        path, git = self.make_worktree('snapshot-write')
        self.age_tree(path)
        with patch.object(prune, 'in_use', return_value=set()):
            candidate = next(c for c in prune.scan()['candidates'] if c['path'] == str(path))
        def snapshot():
            (path/'note').write_text('work created while lsof runs')
            return set()
        with patch.object(prune, 'in_use', side_effect=snapshot), inventory.disk_lock() as fd, \
                self.assertRaises(prune.UsageUnavailable):
            prune.remove_candidate(candidate, time.monotonic()+60, fd)
        self.assertTrue((path/'note').exists())
        self.assertIn(str(path), git('worktree', 'list', '--porcelain'))

    def test_plain_git_remove_refuses_work_created_after_last_inspection(self):
        path, git = self.make_worktree('git-race')
        self.age_tree(path)
        real_git = inventory.git
        def changed_before_remove(repo, args, deadline, lock_fd=None):
            if args[:2] == ['worktree', 'remove']:
                self.assertNotIn('--force', args)
                (path/'note').write_text('new untracked work')
            return real_git(repo, args, deadline, lock_fd)
        with patch.object(prune, 'in_use', return_value=set()):
            candidate = next(c for c in prune.scan()['candidates'] if c['path'] == str(path))
            with patch.object(inventory, 'git', side_effect=changed_before_remove), \
                    inventory.disk_lock() as fd, self.assertRaises(prune.UsageUnavailable):
                prune.remove_candidate(candidate, time.monotonic()+60, fd)
        self.assertTrue((path/'note').exists())
        self.assertIn(str(path), git('worktree', 'list', '--porcelain'))

    def test_lsof_cwd_file_and_sibling_prefix_matrix(self):
        for name, source, expected in [('cwd', self.old, 1), ('file', self.old/'file', 1),
                                       ('sibling', str(self.old)+'-other/file', 2)]:
            with self.subTest(name=name), patch.object(prune, 'in_use', return_value={str(source)}):
                self.assertEqual(len(prune.scan()['candidates']), expected)

    def test_events_include_each_removal_and_one_run_summary(self):
        with patch.object(prune, 'in_use', return_value=set()), patch.object(prune, 'emit') as emit:
            result = prune.apply()
        self.assertEqual(result['removed'], 2)
        self.assertEqual([c.args[2] for c in emit.call_args_list],
                         ['janitor.tmpdir_remove', 'janitor.tmpdir_remove', 'janitor.tmpdir_run'])
        for call in emit.call_args_list[:2]:
            self.assertEqual(set(call.kwargs['props']), {'path', 'bytes', 'ageS', 'rule'})
