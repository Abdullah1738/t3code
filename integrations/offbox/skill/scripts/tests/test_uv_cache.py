"""Reporter logs, real quarantine operations in a fake home, and run/wait exit preservation."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import common, misc, runs, uv_cache
from tests.test_capacity import Isolated
from tests import test_steps_and_hints as steps
from tests import test_bg_empty_logs as background


AA00 = '''error: Failed to install: click-8.5.1-py3-none-any.whl (click==8.5.1)
  Caused by: failed to open file `/home/user/.xcache/uv/archive-v0/mZwmaowx3NLXC838/click-8.5.1.dist-info/WHEEL`: No such file or directory (os error 2)
SUITE_RC=2
'''
SECOND = AA00.replace('click-8.5.1', 'jsonschema_specifications-2025.9.1').replace(
    'click==8.5.1', 'jsonschema-specifications==2025.9.1').replace('mZwmaowx3NLXC838', 'lT_xdwwz4JR4AcK_')
MULTILINE = '''Failed to install: click-8.5.1-py3-none-any.whl (click==8.5.1)
  Caused by: failed to read directory `/home/user/.xcache/uv/archive-v0/mZwmaowx3NLXC838`
  Caused by: No such file or directory (os error 2)
'''


class UvCacheTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(uv_cache.ssh_sync, 'ssh_base', return_value=['ssh']))

    def events(self, kind):
        return [json.loads(row[0]) for row in self.con.execute('SELECT detail FROM events WHERE kind=?', (kind,))]

    def test_reporter_input_forms(self):
        for text, expected in (
            (AA00, ('mZwmaowx3NLXC838', 'click')),
            (SECOND, ('lT_xdwwz4JR4AcK_', 'jsonschema-specifications')),
            (AA00.replace('`', '"'), ('mZwmaowx3NLXC838', 'click')),
            (AA00.replace('`', ''), ('mZwmaowx3NLXC838', 'click')),
            (AA00.replace('WHEEL', 'RECORD'), ('mZwmaowx3NLXC838', 'click')),
            (AA00.replace('failed to open file', 'Failed to read'), ('mZwmaowx3NLXC838', 'click')),
            (AA00.splitlines()[1].replace('failed to open file', 'Failed to read'), ('mZwmaowx3NLXC838', 'click')),
            (AA00.replace('WHEEL', '../click/core.py'), ('mZwmaowx3NLXC838', 'click')),
            ('FAIL TestX', None),
            (AA00.replace('No such file or directory (os error 2)', 'Permission denied'), None),
            (AA00.replace('.xcache/uv/archive-v0', '.cache/private/archive-v0'), None),
            (AA00.replace('mZwmaowx3NLXC838', '../../etc'), None),
            (AA00.splitlines()[1], None),
        ):
            with self.subTest(text=text):
                self.assertEqual(uv_cache.broken_entry(text), expected)

    def test_foreground_hint_event_repair_and_exit(self):
        for text in (AA00, MULTILINE):
            with self.subTest(text=text), patch.object(
                    uv_cache, 'repair', return_value=uv_cache.RepairResult(True, 'cleared', 'moved')) as repair:
                code, lines = steps.CliStepTests.run_cli(self, ['uv', 'run', '--with', 'click', 'true'], 2, text)
                self.assertEqual(code, 2)
                repair.assert_called_once_with('bx_fake', 'mZwmaowx3NLXC838', 'click', timeout=20)
                self.assertEqual(self.events('uv_cache_corrupt')[-1]['package'], 'click')
                self.assertEqual(self.events('uv_cache_repaired')[-1]['entry'], 'mZwmaowx3NLXC838')
                hints = [line for line in lines if 'the uv cache on' in line]
                self.assertEqual(hints, ['offbox: the uv cache on bx_fake has a broken entry (mZwmaowx3NLXC838); '
                                         'it was moved aside — rerun, or set UV_CACHE_DIR=$(mktemp -d) for a private cache'])
                self.assertEqual(lines[-1], 'offbox: remote exit 2')

    def test_report_cause_chain_forms(self):
        missing = 'No such file or directory (os error 2)'
        denied = MULTILINE.replace(missing, 'Permission denied (os error 13)')
        cases = (
            ('same-line-file', AA00, True),
            ('split-directory', MULTILINE, True),
            ('split-file', AA00.replace(': ' + missing, '\n  Caused by: ' + missing), True),
            ('split-read-file', AA00.replace('failed to open file', 'Failed to read').replace(
                ': ' + missing, '\n  Caused by: ' + missing), True),
            ('double-quoted', MULTILINE.replace('`', '"'), True),
            ('unquoted', MULTILINE.replace('`', ''), True),
            ('crlf', MULTILINE.replace('\n', '\r\n'), True),
            ('nested-cause', MULTILINE.replace('  Caused by: failed', '  Caused by: installation failed\n    Caused by: failed'), True),
            ('os-error-only', MULTILINE.replace(missing, 'os error 2'), True),
            ('message-only', MULTILINE.replace(missing, 'No such file or directory'), True),
            ('same-line-denied', AA00.replace(missing, 'Permission denied (os error 13)'), False),
            ('split-denied', denied, False),
            ('denied-then-missing', denied + '  Caused by: ' + missing + '\n', False),
            ('different-error', MULTILINE.replace('  Caused by: ' + missing, 'error: ' + missing), False),
            ('ordinary-line-between', MULTILINE.replace('  Caused by: ' + missing, 'other command output\n  Caused by: ' + missing), False),
            ('blank-line-between', MULTILINE.replace('  Caused by: ' + missing, '\n  Caused by: ' + missing), False),
            ('different-install', MULTILINE.replace('  Caused by: failed', 'error: failed'), False),
        )
        log = runs.LOGS_DIR / 'cause-chain.log'
        for name, text, expected in cases:
            with self.subTest(name=name):
                log.write_text(text)
                err = io.StringIO()
                with patch.object(uv_cache, 'repair', return_value=uv_cache.RepairResult(True, 'cleared', 'moved')) as repair, \
                        contextlib.redirect_stderr(err):
                    uv_cache.report('B', name, log, 2)
                corrupt = [event for event in self.events('uv_cache_corrupt') if event['run'] == name]
                repaired = [event for event in self.events('uv_cache_repaired') if event['run'] == name]
                if expected:
                    repair.assert_called_once_with('B', 'mZwmaowx3NLXC838', 'click', timeout=20)
                    self.assertEqual(len(corrupt), 1)
                    self.assertEqual(corrupt[0]['package'], 'click')
                    self.assertEqual(corrupt[0]['entry'], 'mZwmaowx3NLXC838')
                    self.assertEqual(len(repaired), 1)
                    self.assertEqual(err.getvalue().count('it was moved aside'), 1)
                else:
                    repair.assert_not_called()
                    self.assertEqual(corrupt, [])
                    self.assertEqual(repaired, [])
                    self.assertEqual(err.getvalue(), '')

    def test_non_cache_failure_does_not_repair_or_hint(self):
        with patch.object(uv_cache, 'repair') as repair:
            code, lines = steps.CliStepTests.run_cli(self, ['false'], 9, 'FAIL TestX\n')
        self.assertEqual(code, 9)
        repair.assert_not_called()
        self.assertFalse(any('uv cache' in line for line in lines))
        self.assertEqual(self.events('uv_cache_corrupt'), [])

    def test_repair_failures_keep_exit_and_record_reason(self):
        for result in (subprocess.CompletedProcess([], 255, b'', b'connection refused'),
                       subprocess.TimeoutExpired('ssh', 20), common.OffboxError('SSH failed')):
            with self.subTest(result=result):
                self.con.execute("DELETE FROM kv WHERE k LIKE 'uv_cache_corrupt:%'")
                self.con.commit()
                args = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
                with patch.object(uv_cache.ssh_sync, 'ssh', **args):
                    code, lines = steps.CliStepTests.run_cli(self, ['false'], 2, AA00)
                self.assertEqual(code, 2)
                self.assertTrue(self.events('uv_cache_repair_failed')[-1]['reason'])
                self.assertTrue(any('repair failed' in line for line in lines))
                self.assertFalse(any('it was moved aside' in line for line in lines))

    def test_wait_completion_and_settled_log_repair_once(self):
        log = runs.LOGS_DIR / 'bg.log'
        log.write_text(SECOND)
        row = dict(run_id='bg', mode='bg', box_id='B', repo_root=str(Path(self.tmp.name)), pulls='[]',
                   exit_code=2, status='failed', error=None)
        err = io.StringIO()
        with patch.object(misc, '_catch_up_log', return_value='complete'), patch.object(misc, '_incomplete_log'), \
                patch.object(runs, 'finish', side_effect=lambda rid, code, **kw: code), \
                patch.object(runs, 'go_std_glitch'), patch.object(runs, 'settle_box_wedged', return_value=None), \
                patch.object(uv_cache, 'repair', return_value=uv_cache.RepairResult(True, 'cleared', 'moved')) as repair, \
                contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc._finalize(row, 2, log), 2)
            self.assertEqual(misc._settled(row), 2)
            self.assertEqual(misc._settled(row, echo=True), 2)
        repair.assert_called_once_with('B', 'lT_xdwwz4JR4AcK_', 'jsonschema-specifications', timeout=20)
        self.assertEqual(err.getvalue().count('the uv cache on'), 1)
        self.assertEqual(len(self.events('uv_cache_corrupt')), 1)

    def test_caller_deadline_does_not_change_result(self):
        log = runs.LOGS_DIR / 'deadline.log'
        log.write_text(AA00)
        with patch.object(uv_cache, 'repair') as repair, contextlib.redirect_stderr(io.StringIO()):
            uv_cache.report('B', 'deadline', log, 2, until=common.now() - 1)
        repair.assert_not_called()
        self.assertEqual(self.events('uv_cache_repair_failed')[0]['reason'], 'caller deadline reached')

    def test_wrapper_masking_uv_exit_keeps_zero_and_repairs(self):
        with patch.object(uv_cache, 'repair', return_value=uv_cache.RepairResult(True, 'cleared', 'moved')) as repair:
            code, lines = steps.CliStepTests.run_cli(self, ['bash', '-c', 'uv run false; echo SUITE_RC=$?'], 0, AA00)
        self.assertEqual(code, 0)
        self.assertEqual(repair.call_count, 1)
        self.assertTrue(any('it was moved aside' in line for line in lines))
        self.assertEqual(self.events('uv_cache_corrupt')[0]['package'], 'click')

    def test_repair_uses_one_setup_budget_and_freezes_endpoint(self):
        with patch.object(uv_cache.ssh_sync, 'ssh_base', return_value=['ssh']) as base, \
                patch.object(uv_cache, 'time', SimpleNamespace(monotonic=Mock(side_effect=[100, 101]))), \
                patch.object(uv_cache.api, 'time', SimpleNamespace(time=lambda: 100)), \
                patch.object(uv_cache.ssh_sync, 'time', SimpleNamespace(time=lambda: 100)), \
                patch.object(uv_cache.subprocess, 'run', return_value=subprocess.CompletedProcess(
                    [], 0, b'{"ok":true,"reason":"cleared","archive":"moved"}', b'')) as process:
            self.assertEqual(uv_cache.repair('B', 'mZwmaowx3NLXC838', 'click', timeout=3),
                             uv_cache.RepairResult(True, 'cleared', 'moved'))
        base.assert_called_once_with('B')
        self.assertEqual(process.call_args.kwargs['timeout'], 2)
        self.assertIn('timeout -s KILL 1', process.call_args.args[0][-1])

    def test_frozen_endpoint_keeps_the_outer_ssh_deadline(self):
        clock = SimpleNamespace(time=Mock(return_value=100))
        for current in (101, 103):
            with self.subTest(current=current), \
                    patch.object(uv_cache.api, 'time', clock), \
                    patch.object(uv_cache.ssh_sync, 'time', clock), \
                    patch.object(uv_cache.ssh_sync, 'ssh_base') as select_endpoint, \
                    patch.object(uv_cache.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')) as process:
                clock.time.return_value = 100
                with uv_cache.api.budget(3):
                    clock.time.return_value = current
                    if current == 103:
                        with self.assertRaises(subprocess.TimeoutExpired):
                            uv_cache.ssh_sync.ssh('B', 'repair', timeout=20, base=['ssh', '-p', '22001'])
                        process.assert_not_called()
                    else:
                        uv_cache.ssh_sync.ssh('B', 'repair', timeout=20, base=['ssh', '-p', '22001'])
                        process.assert_called_once_with(['ssh', '-p', '22001', 'B', 'repair'],
                                                       input=None, capture_output=True, timeout=2)
                select_endpoint.assert_not_called()

    def test_expired_setup_never_starts_remote_repair(self):
        with patch.object(uv_cache, 'time', SimpleNamespace(monotonic=Mock(side_effect=[100, 121]))), \
                patch.object(uv_cache.ssh_sync, 'ssh') as ssh:
            with self.assertRaises(subprocess.TimeoutExpired):
                uv_cache.repair('B', 'mZwmaowx3NLXC838', 'click')
        ssh.assert_not_called()

    def fake_home(self):
        home = Path(self.tmp.name) / 'remote'
        archive = home / '.xcache/uv/archive-v0/mZwmaowx3NLXC838'
        (archive / 'click-8.5.1.dist-info').mkdir(parents=True)
        (archive / 'click-8.5.1.dist-info/RECORD').write_text('evidence')
        return home, archive

    def fake_ssh(self, home, commands):
        def ssh(box, command, **kwargs):
            commands.append(command)
            env = dict(HOME=str(home), PATH=os.environ['PATH'])
            return subprocess.run(['bash', '-c', command], env=env, capture_output=True, timeout=kwargs['timeout'])
        return ssh

    def test_real_move_and_wheel_refs_quarantined_not_deleted(self):
        home, archive = self.fake_home()
        cache = home / '.xcache/uv'
        wheel = cache / 'wheels-v5/index/abc/click/8.5.1-py3-none-any'
        wheel.parent.mkdir(parents=True)
        wheel.symlink_to(archive)
        wheel_http = Path(str(wheel) + '.http')
        wheel_http.write_bytes(b'metadata')
        Path(str(wheel) + '.msgpack').write_bytes(b'archive-v0/mZwmaowx3NLXC838')
        Path(str(wheel) + '.rev').write_bytes(b'local wheel timestamp')
        metadata = cache / 'wheels-v7/pypi/click/8.5.1-py3-none-any.msgpack'
        metadata.parent.mkdir(parents=True)
        metadata.write_bytes(b'archive-v0/mZwmaowx3NLXC838')
        orphan_http = metadata.parent / '8.5.2-py3-none-any.http'
        orphan_http.write_bytes(b'archive-v0/mZwmaowx3NLXC838')
        orphan_refs = [metadata.parent / ('orphan' + suffix) for suffix in ('.http', '.msgpack', '.rkyv', '.rev')]
        for path in orphan_refs:
            path.write_bytes(b'archive-v0/mZwmaowx3NLXC838')
        healthy = wheel.parent / '8.5.0-py3-none-any'
        healthy.symlink_to(cache / 'archive-v0/healthy')
        commands = []
        with patch.object(uv_cache.ssh_sync, 'ssh', side_effect=self.fake_ssh(home, commands)):
            self.assertEqual(uv_cache.repair('B', 'mZwmaowx3NLXC838', 'click'),
                             uv_cache.RepairResult(True, 'wheel references cleared', 'moved'))
        self.assertIn('timeout -s KILL ', commands[0])
        self.assertIn('os.rename(source', commands[0])
        self.assertNotIn('rm -rf', commands[0])
        self.assertNotIn('rmtree', commands[0])
        self.assertFalse(archive.exists())
        self.assertFalse(wheel.is_symlink())
        self.assertFalse(wheel_http.exists())
        self.assertFalse(Path(str(wheel) + '.rev').exists())
        self.assertFalse(metadata.exists())
        self.assertFalse(orphan_http.exists())
        for path in orphan_refs:
            with self.subTest(reference=path.suffix):
                self.assertFalse(path.exists())
        self.assertTrue(healthy.is_symlink())
        trash = list((home / '.offbox/trash').glob('uv-*/archive/click-8.5.1.dist-info/RECORD'))
        self.assertEqual(len(trash), 1)
        self.assertEqual(trash[0].read_text(), 'evidence')

    def test_busy_uv_cache_is_left_alone(self):
        import fcntl
        home, archive = self.fake_home()
        with (home / '.xcache/uv/.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_SH)
            with patch.object(uv_cache.ssh_sync, 'ssh', side_effect=self.fake_ssh(home, [])):
                result = uv_cache.repair('B', 'mZwmaowx3NLXC838', 'click')
        self.assertFalse(result.ok)
        self.assertIn('busy', result.reason)
        self.assertEqual(result.archive, 'untouched')
        self.assertTrue(archive.exists())

    def test_partial_and_already_absent_receipts_are_honest(self):
        log = runs.LOGS_DIR / 'receipt.log'
        log.write_text(AA00)
        cases = [(uv_cache.RepairResult(True, 'cleared', 'absent'), 'already absent', 'uv_cache_repaired'),
                 (uv_cache.RepairResult(False, 'permission denied', 'moved'), 'it was moved aside; repair failed', 'uv_cache_repair_failed')]
        for index, (result, hint, kind) in enumerate(cases):
            with self.subTest(result=result), patch.object(uv_cache, 'repair', return_value=result), \
                    contextlib.redirect_stderr(io.StringIO()) as err:
                uv_cache.report('B', f'receipt-{index}', log, 2)
                self.assertIn(hint, err.getvalue())
                self.assertEqual(self.events(kind)[-1]['archive'], result.archive)


class UvCacheRecoveredOutputTests(background._BackgroundOutputFixture):
    def test_finished_logs_reports_once(self):
        self.con.execute("UPDATE runs SET exit_code=2,status='failed'")
        self.con.commit()
        self.path.write_text(AA00)
        with patch.object(misc, '_catch_up_log', return_value='complete'), \
                patch.object(uv_cache, 'report', wraps=uv_cache.report) as report, \
                patch.object(uv_cache, 'repair', return_value=uv_cache.RepairResult(True, 'cleared', 'moved')) as repair:
            code, _, err = self.invoke()
        self.assertEqual(code, 0)
        report.assert_called_once_with('bx_a', 'run-x', self.path, 2, until=None)
        repair.assert_called_once_with('bx_a', 'mZwmaowx3NLXC838', 'click', timeout=20)
        self.assertEqual(err.count('the uv cache on'), 1)
        self.assertEqual(self.con.execute(
            "SELECT COUNT(*) FROM events WHERE kind='uv_cache_corrupt'").fetchone()[0], 1)
        self.assertEqual(self.row()['exit_code'], 2)

    def test_stuck_holder_repair_keeps_the_wait_deadline(self):
        self.path.write_text(AA00)
        with patch.object(misc, 'now', return_value=100), \
                patch.object(uv_cache.common, 'now', return_value=100), \
                patch.object(uv_cache, 'report', wraps=uv_cache.report) as report, \
                patch.object(uv_cache, 'repair', return_value=uv_cache.RepairResult(True, 'cleared', 'moved')) as repair, \
                contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            code = misc._holder_stuck(self.row(), {'exitCode': 2}, self.path, 0, False, deadline=103)
        self.assertEqual(code, 2)
        report.assert_called_once_with('bx_a', 'run-x', self.path, 2, until=103)
        repair.assert_called_once_with('bx_a', 'mZwmaowx3NLXC838', 'click', timeout=3)

    def test_settled_logs_follow_and_wait_use_recovered_output(self):
        self.con.execute("UPDATE runs SET exit_code=2,status='failed'")
        self.con.commit()
        for method in ('logs', 'follow', 'wait'):
            with self.subTest(method=method):
                self.con.execute("DELETE FROM kv WHERE k LIKE 'uv_cache_corrupt:%'")
                self.con.commit()
                self.path.write_text('truncated original\n')
                recovered = Path(str(self.path) + '.remote')
                recovered.write_text(AA00)
                with patch.object(misc, '_catch_up_log', return_value='complete'), \
                        patch.object(misc, '_raw_log', return_value=recovered), \
                        patch.object(uv_cache, 'report', wraps=uv_cache.report) as report, \
                        patch.object(uv_cache, 'repair', return_value=uv_cache.RepairResult(True, 'cleared', 'moved')) as repair:
                    code, _, err = self.invoke(wait=method == 'wait', follow=method == 'follow')
                self.assertEqual(code, 2 if method == 'wait' else 0)
                self.assertEqual(err.count('it was moved aside'), 1)
                report.assert_called_once_with('bx_a', 'run-x', recovered, 2, until=None)
                repair.assert_called_once_with('bx_a', 'mZwmaowx3NLXC838', 'click', timeout=20)

    def test_fresh_process_selects_management_only_endpoint_within_budget(self):
        from offbox_lib import api, ssh_sync
        config = Path(self.tmp.name) / 'ssh-config'
        config.write_text('# offbox-home-ports 22001 22000\n')
        log = runs.LOGS_DIR / 'fresh.log'
        log.write_text(AA00)
        receipt = b'{"ok":true,"reason":"cleared","archive":"moved"}'
        with patch.object(api, 'BACKEND', 'server'), patch.object(ssh_sync, '_HOME_PORTS', {}), \
                patch.object(ssh_sync, 'cfg_path', return_value=config), \
                patch.object(uv_cache, 'time', SimpleNamespace(monotonic=Mock(side_effect=[100, 104]))), \
                patch.object(api, 'time', SimpleNamespace(time=lambda: 100)), \
                patch.object(ssh_sync, 'time', SimpleNamespace(time=lambda: 100)), \
                patch.object(ssh_sync.subprocess, 'run', side_effect=[
                    subprocess.CompletedProcess([], 0, b'', b''),
                    subprocess.CompletedProcess([], 0, receipt, b'')]) as process, \
                contextlib.redirect_stderr(io.StringIO()):
            uv_cache.report('B', 'fresh', log, 2)
        self.assertEqual(process.call_count, 2)
        probe, repair = process.call_args_list
        self.assertEqual(probe.args[0][-1], 'true')
        self.assertEqual(probe.args[0][probe.args[0].index('-p') + 1], '22001')
        self.assertLessEqual(probe.kwargs['timeout'], 5)
        self.assertEqual(repair.args[0][repair.args[0].index('-p') + 1], '22001')
        self.assertEqual(repair.kwargs['timeout'], 16)
        self.assertIn('timeout -s KILL 15', repair.args[0][-1])


if __name__ == '__main__':
    unittest.main()
