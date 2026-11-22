import copy
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
from unittest.mock import Mock, patch
from janitor_test_safety import JanitorTestCase
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skill/scripts'))
import leftover_processes as lp
import dev_janitor
from test_leftover_processes import OWNER, ROSTER


class XcodeTests(JanitorTestCase):
    def setUp(self):
        self.now = 1794787200
        start = time.strftime('%a %b %d %H:%M:%S %Y', time.localtime(self.now - 28000))
        self.rows = {}
        for pid, ppid, args in [(1, 0, '/sbin/launchd'), (10, 1, 'Python -I /private/build.py'),
                               (20, 10, '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild build'),
                               (30, 20, '/opt/SWBBuildService'), (40, 30, '/bin/bash script-phase.sh'),
                               (50, 40, '/opt/xcodebuild'), (60, 50, '/opt/SWBBuildService'),
                               (70, 60, '/opt/swift-frontend'), (80, 30, '/opt/clang -cc1')]:
            self.rows[pid] = dict(pid=pid, ppid=ppid, args=args, tty='??', start=start, cpu_seconds=45., rss_kib=1024)
        self.after = copy.deepcopy(self.rows)
        self.meta = dict(cwd='/work/mobile/ios', worktree='/work/mobile', state_pid=10,
                         binding={'CODEX_THREAD_ID': 'native-owner'}, log_path='/work/mobile/build.log',
                         log_mtime=self.now - 20000, derived_data='/work/mobile/tmp/build/ios')

    def detect(self, **kwargs):
        options = dict(metadata=lambda row, rows: copy.deepcopy(self.meta), resolve=lambda binding: copy.deepcopy(OWNER),
                       now=self.now, window_s=60)
        options.update(kwargs)
        return lp.detect_xcode_builds(self.rows, self.rows, self.after, ROSTER, {}, **options)

    def stop(self, report=None, **kwargs):
        report = report or self.detect()
        options = dict(rescan=lambda: copy.deepcopy(report), observe=lambda: copy.deepcopy(self.after), send=Mock(), pause=Mock())
        options.update(kwargs)
        with patch.dict(lp.os.environ, DEV_JANITOR_STOP_XCODE_BUILDS='1'):
            return lp.stop_xcode_builds(report, **options)

    def test_nested_script_build_is_one_root_and_reports_ended_owner(self):
        r = self.detect()
        self.assertEqual([x['pid'] for x in r['inventory']], [20])
        c = r['candidates'][0]
        self.assertEqual((c['owner_state'], c['owner'], c['age_s'], c['cpu_gained_s']), ('ended-owner', 'owner', 28000, 0))
        self.assertEqual(c['child_counts']['xcodebuild'], 1)
        self.assertEqual([p['pid'] for p in c['launcher_chain']], [10, 1])
        self.assertEqual(lp.family(self.rows[20]), 'xcode-build')

    def test_live_waiting_owner_can_have_stalled_build(self):
        value = dict(thread=dict(threadId='live'), keep_reason='owner_has_work_or_not_ended')
        c = self.detect(resolve=lambda binding: value)['candidates'][0]
        self.assertEqual((c['owner_state'], c['owner']), ('live-owner', 'live'))

    def test_any_cpu_progress_or_reset_keeps_detached_tree(self):
        for pid in [20, 30, 40, 50, 60, 70, 80]:
            for delta in [.01, -1]:
                with self.subTest(pid=pid, delta=delta):
                    self.after = copy.deepcopy(self.rows)
                    self.after[pid]['cpu_seconds'] += delta
                    self.assertEqual(self.detect()['candidates'], [])

    def test_log_and_age_boundary_matrix(self):
        for age, lag, expected in [(28000, 1799, False), (28000, 1800, False), (28000, 1801, True),
                                   (100, 1801, False), (7200, None, False), (7201, None, True),
                                   (100, None, False), (28000, -20, False)]:
            with self.subTest(age=age, lag=lag):
                for row in self.rows.values():
                    row['start'] = time.strftime('%a %b %d %H:%M:%S %Y', time.localtime(self.now - age))
                self.after = copy.deepcopy(self.rows)
                self.meta['log_mtime'] = None if lag is None else self.now - lag
                self.assertEqual(bool(self.detect()['candidates']), expected)

    def test_unknown_deleted_incomplete_and_changing_evidence_keep(self):
        for own in [None, dict(thread=dict(threadId='deleted'), keep_reason='owner_deleted')]:
            self.assertEqual(self.detect(resolve=lambda binding: own)['candidates'], [])
        self.assertEqual(self.detect(window_s=59.9)['candidates'], [])
        with patch.dict(ROSTER, complete=False):
            self.assertEqual(self.detect()['candidates'], [])
        self.assertEqual(self.detect(metadata=Mock(side_effect=OSError))['candidates'], [])
        for mode in ['exit', 'reuse', 'new_child', 'negative', 'nan']:
            with self.subTest(mode=mode):
                self.after = copy.deepcopy(self.rows)
                if mode == 'exit':
                    del self.after[70]
                elif mode == 'reuse':
                    self.after[70]['start'] = 'new'
                elif mode == 'new_child':
                    self.after[71] = {**self.rows[70], 'pid': 71}
                else:
                    self.after[70]['cpu_seconds'] = -1 if mode == 'negative' else float('nan')
                self.assertEqual(self.detect()['candidates'], [])

    def test_xcode_gui_terminal_and_tty_ancestors_keep(self):
        for args, tty in [('/Applications/Xcode.app/Contents/MacOS/Xcode', '??'),
                          ('/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', '??'),
                          ('/Applications/iTerm.app/Contents/MacOS/iTerm2', '??'), ('/bin/zsh', 'ttys001')]:
            with self.subTest(args=args):
                self.rows[10].update(args=args, tty=tty)
                self.after = copy.deepcopy(self.rows)
                self.assertEqual(self.detect()['inventory'][0]['keep_reason'], 'interactive_launcher')

    def test_keep_missing_ancestry_and_pid_linked_workspace_owner(self):
        self.assertEqual(self.detect(keep=['/work/mobile'])['candidates'], [])
        del self.rows[10]
        self.assertEqual(self.detect()['candidates'], [])
        self.setUp()
        self.meta['binding'] = None
        with patch.dict(ROSTER, workspaces={'owner': '/work/mobile'}):
            resolve = Mock(return_value=copy.deepcopy(OWNER))
            self.assertEqual(len(self.detect(resolve=resolve)['candidates']), 1)
            resolve.assert_called_once_with({'T3_THREAD_ID': 'owner'})
            self.meta['state_pid'] = None
            self.assertEqual(self.detect()['candidates'], [])

    def test_default_off_never_rescans_or_signals(self):
        self.assertFalse(lp.STOP_XCODE_BUILDS_DEFAULT)
        for flag in ['0', '', 'true']:
            rescan, send = Mock(), Mock()
            with patch.dict(lp.os.environ, DEV_JANITOR_STOP_XCODE_BUILDS=flag):
                self.assertEqual(lp.stop_xcode_builds(self.detect(), rescan=rescan, send=send), [])
            rescan.assert_not_called()
            send.assert_not_called()

    def test_robob_build_is_kept_and_signal_rechecks_ancestry(self):
        report = self.detect()
        self.rows[1]['args'] = '/Applications/Robob.app/Contents/MacOS/Robob'
        self.after = copy.deepcopy(self.rows)
        self.assertEqual(self.detect()['inventory'][0]['keep_reason'], 'robob-descendant')
        self.assertEqual(self.detect()['candidates'], [])
        send = Mock()
        action = self.stop(report, send=send)[0]
        send.assert_not_called()
        self.assertEqual(action['protectedBy'], 'robob-descendant')

    def test_robob_ancestry_rechecked_before_xcode_kill(self):
        send = Mock()
        def pause(seconds):
            self.after[1]['args'] = '/Applications/Robob.app/Contents/MacOS/Robob'
        action = self.stop(send=send, pause=pause)[0]
        self.assertEqual(action['signals'], [dict(pid=20, signal='SIGTERM')])
        self.assertEqual(send.call_count, 1)
        self.assertEqual(action['protectedBy'], 'robob-descendant')

    def test_term_outer_then_services_then_kill_only_survivors(self):
        report = self.detect()
        self.after[900] = dict(pid=900, ppid=1, start='other', tty='??', args='/opt/xcodebuild', cpu_seconds=0)
        events = []
        def send(pid, sig):
            events.append((pid, sig))
            if sig == signal.SIGTERM and pid == 30:
                del self.after[30]
            if sig == signal.SIGKILL:
                del self.after[pid]
        result = self.stop(report, send=send, pause=lambda seconds: events.append(('wait', seconds)))
        self.assertEqual(events, [(20, signal.SIGTERM), ('wait', 10), (30, signal.SIGTERM), (60, signal.SIGTERM),
                                  ('wait', 10), (20, signal.SIGKILL), (60, signal.SIGKILL), ('wait', 1)])
        self.assertIn(900, self.after)
        self.assertFalse(result[0]['ok'])

    def test_graceful_tree_exit_never_kills_and_reports_success(self):
        def send(pid, sig):
            for child in lp.descendants(pid, self.after) | {pid}:
                self.after.pop(child, None)
        action = self.stop(send=send)[0]
        self.assertTrue(action['ok'])
        self.assertEqual(action['signals'], [dict(pid=20, signal='SIGTERM')])

    def test_revalidation_changed_log_owner_cpu_or_reused_pid_keeps(self):
        report = self.detect()
        for key, value in [('owner', 'other'), ('log_mtime', self.now), ('start', 'new')]:
            with self.subTest(key=key):
                fresh = copy.deepcopy(report)
                fresh['candidates'][0][key] = value
                send = Mock()
                self.stop(report, rescan=lambda: fresh, send=send)
                send.assert_not_called()
        self.after[70]['cpu_seconds'] += .01
        send = Mock()
        self.stop(report, send=send)
        send.assert_not_called()
        self.after = copy.deepcopy(self.rows)
        def send_reuse(pid, sig):
            self.after[pid]['start'] = 'replacement'
        action = self.stop(report, send=send_reuse)[0]
        self.assertNotIn(dict(pid=20, signal='SIGKILL'), action['signals'])

    def test_home_paths_redacted_report_keys_additive_and_actions_audited(self):
        self.meta['worktree'] = str(Path.home() / 'work/mobile')
        report = self.detect()
        self.assertEqual(report['candidates'][0]['worktree'], '~/work/mobile')
        old = lp.detect({}, {}, {}, ROSTER)
        summary = lp.report_summary({**old, 'xcode_builds': report})
        self.assertEqual(set(summary), set(lp.report_summary(old)) | {'xcode_builds'})
        state = dict(processes=dict(xcode_builds=report))
        with patch.object(lp, 'stop_xcode_builds', return_value=[dict(pid=20, action='stop', ok=True)]), patch.object(dev_janitor, 'audit') as audit:
            dev_janitor.stop_xcode_candidates(state)
        self.assertEqual(audit.call_args.args[0]['event'], 'xcode_build_stop')

    def test_scan_without_builds_is_fast_and_failure_keeps(self):
        with patch.object(lp, 'cpu_processes', return_value={1: self.rows[1]}), patch.object(lp, 'run') as run:
            self.assertEqual(lp.scan_xcode_builds(ROSTER)['candidates'], [])
            run.assert_not_called()
        with patch.object(lp, 'cpu_processes', side_effect=OSError):
            r = lp.scan_xcode_builds(ROSTER)
            self.assertEqual(r['candidates'], [])
            self.assertTrue(r['problems'])

    def test_metadata_reads_redirect_and_state_pid_binding(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / '.git').touch()
            state = root / 'tmp/build/state'
            state.mkdir(parents=True)
            (state / 'pid').write_text('10')
            log = root / 'build output.log'
            log.write_text('building')
            with patch.object(lp, 'cwd_inventory', return_value={20: str(root)}), patch.object(lp, 'native_binding', return_value={'CODEX_THREAD_ID': 'native-owner'}), patch.object(lp, 'run', return_value=f'p20\nf1\ntREG\nn{log}\n'):
                m = lp.xcode_metadata(self.rows[20], self.rows)
                self.assertEqual((m['worktree'], m['state_pid'], m['log_path']), (str(root), 10, str(log)))
                self.assertEqual(m['log_mtime'], log.stat().st_mtime)
                (state / 'pid').write_text('999')
                m = lp.xcode_metadata(self.rows[20], self.rows)
                self.assertIsNone(m['state_pid'])
                self.assertEqual(m['log_path'], str(log))

    def test_scan_observes_full_minute_and_metadata_conflicts_keep(self):
        with patch.object(lp, 'cpu_processes', side_effect=[self.rows, self.after]), patch.object(lp, 'run') as run, patch.object(lp, 'launch_services', return_value={}), patch.object(lp, 'detect_xcode_builds', return_value={}) as detect, patch.object(lp.time, 'monotonic', side_effect=[100, 160]):
            lp.scan_xcode_builds(ROSTER)
            self.assertEqual(detect.call_args.kwargs['window_s'], 60)
            self.assertEqual(run.call_args.kwargs['timeout'], 75)
            self.assertIn('60', run.call_args.args[0])
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(lp, 'cwd_inventory', return_value={20: temp}), patch.object(lp, 'native_binding', side_effect=[{'CODEX_THREAD_ID': 'a'}, {'CODEX_THREAD_ID': 'b'}]):
                with self.assertRaises(ValueError):
                    lp.xcode_metadata(self.rows[20], self.rows)

    def test_root_replaced_at_final_read_sends_nothing(self):
        report = self.detect()
        reads = [0]
        def observe():
            reads[0] += 1
            if reads[0] > 1:
                self.after[20]['start'] = 'replaced'
            return copy.deepcopy(self.after)
        send = Mock()
        self.assertEqual(self.stop(report, observe=observe, send=send)[0]['reason'], 'root_changed_before_term')
        send.assert_not_called()

    def test_hourly_worker_records_candidates_actions_and_failure(self):
        import janitor_watch
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for ok in [True, False]:
                with self.subTest(ok=ok):
                    report = self.detect()
                    old = lp.detect({}, {}, {}, ROSTER)
                    scan = dict(ts=123, resources=[], candidates=[], liveness_unavailable=None,
                                processes={**old, 'xcode_builds': report})
                    def stop(state):
                        state['processes']['xcode_builds']['actions'] = [dict(pid=20, action='stop', ok=ok)]
                    with (base / 'lock').open('a+') as lock, patch.object(janitor_watch, 'STATE_DIR', base), patch.object(dev_janitor, 'scan', return_value=scan), patch.object(dev_janitor, 'stop_xcode_candidates', side_effect=stop), patch.object(dev_janitor, 'record_report') as record, patch.object(dev_janitor, 'log_run') as log:
                        self.assertEqual(janitor_watch.worker(lock.fileno()), 0 if ok else 1)
                        self.assertEqual(record.call_args.args[0]['processes']['xcode_builds']['actions'][0]['ok'], ok)
                        self.assertEqual(log.call_args.args[1:4], (1, int(ok), ok))
                        self.assertEqual(log.call_args.args[4:], ({}, old['mcp_summary'], None))

    def test_final_preterm_tree_progress_matrix_keeps_resumed_builds(self):
        for mode in ['root_cpu', 'script_cpu', 'compiler_cpu', 'new_child', 'exited_child', 'reused_child', 'reparented_child']:
            with self.subTest(mode=mode):
                self.setUp()
                report = self.detect()
                reads = [0]
                def observe():
                    reads[0] += 1
                    if reads[0] == 2:
                        if mode.endswith('_cpu'):
                            pid = {'root_cpu': 20, 'script_cpu': 40, 'compiler_cpu': 70}[mode]
                            self.after[pid]['cpu_seconds'] += .01
                        elif mode == 'new_child':
                            self.after[90] = {**self.after[70], 'pid': 90}
                        elif mode == 'exited_child':
                            del self.after[70]
                        elif mode == 'reused_child':
                            self.after[70]['start'] = 'new'
                        else:
                            self.after[70]['ppid'] = 30
                    return copy.deepcopy(self.after)
                send = Mock()
                self.assertEqual(self.stop(report, observe=observe, send=send)[0]['action'], 'kept')
                send.assert_not_called()

    def test_build_log_sources_exclude_shared_ancestor_matrix(self):
        for mode in ['state_launcher', 'worktree_launcher', 'outside_launcher', 'shared_launcher']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                (root / '.git').touch()
                state = root / 'tmp/build/state'
                state.mkdir(parents=True)
                if mode == 'state_launcher':
                    (state / 'pid').write_text('10')
                build_log = root / 'build.log'
                launcher_log = root / 'launcher.log'
                shared_log = root / 'server.log'
                for log in [build_log, launcher_log, shared_log]:
                    log.write_text('output')
                os.utime(build_log, (self.now - 20000, self.now - 20000))
                os.utime(launcher_log, (self.now - 10000, self.now - 10000))
                os.utime(shared_log, (self.now, self.now))
                self.rows[100] = {**self.rows[10], 'pid': 100, 'ppid': 1, 'args': 'node /opt/robob/server.js'}
                self.rows[10]['ppid'] = 100
                self.rows[10]['args'] = 'node /opt/robob/server.js' if mode == 'shared_launcher' else 'Python -I build.py'
                hints = {20: str(root), 10: '/outside' if mode == 'outside_launcher' else str(root), 100: str(root)}
                raw = f'p20\nf1\ntREG\nn{build_log}\np10\nf1\ntREG\nn{launcher_log}\np100\nf1\ntREG\nn{shared_log}\n'
                with patch.object(lp, 'cwd_inventory', return_value=hints), patch.object(lp, 'native_binding', return_value=None), patch.object(lp, 'run', return_value=raw) as run:
                    metadata = lp.xcode_metadata(self.rows[20], self.rows)
                uses_launcher = mode in {'state_launcher', 'worktree_launcher'}
                self.assertEqual(metadata['log_path'], str(launcher_log if uses_launcher else build_log))
                self.assertEqual(run.call_args.args[0][run.call_args.args[0].index('-p') + 1], '10,20' if uses_launcher else '20')

    def test_detached_state_lifecycle_matrix_does_not_hide_current_build(self):
        cases = [('absent', None, False, None), ('foreign_live', '999', False, None),
                 ('foreign_complete', '999', True, None), ('blank', '', False, None),
                 ('malformed', 'old-pid', False, None), ('zero', '0', False, None),
                 ('negative', '-10', False, None), ('matching_complete', '10', True, None),
                 ('matching_launcher', '10', False, 10), ('matching_root', '20', False, 20)]
        for name, pid, completed, expected_pid in cases:
            with self.subTest(state=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                (root / '.git').touch()
                state = root / 'tmp/build/state'
                state.mkdir(parents=True)
                current_log, old_log = root / 'current.log', root / 'previous-build.log'
                current_log.write_text('current build')
                old_log.write_text('previous build')
                os.utime(current_log, (self.now - 20000, self.now - 20000))
                os.utime(old_log, (self.now, self.now))
                if pid is not None:
                    (state / 'pid').write_text(pid)
                if completed:
                    (state / 'exit').write_text('0')
                # A stale state log pointer must not override this build's fd.
                (state / 'log').write_text(str(current_log if expected_pid is not None else old_log))
                raw = f'p20\nf1\ntREG\nn{current_log}\n'
                with patch.object(lp, 'cwd_inventory', return_value={20: str(root)}), patch.object(lp, 'native_binding', return_value={'CODEX_THREAD_ID': 'native-owner'}), patch.object(lp, 'run', return_value=raw):
                    metadata = lp.xcode_metadata(self.rows[20], self.rows)
                    report = self.detect(metadata=lp.xcode_metadata)
                self.assertEqual(metadata['state_pid'], expected_pid)
                self.assertEqual(metadata['log_path'], str(current_log))
                self.assertEqual([item['pid'] for item in report['candidates']], [20])
                self.assertEqual(report['candidates'][0]['owner'], 'owner')

    def test_same_worktree_logs_must_belong_to_current_build(self):
        cases = [('redirect', None), ('state_log', 'log'), ('state_log_path', 'log_path')]
        for name, state_key in cases:
            with self.subTest(log_source=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                (root / '.git').touch()
                state = root / 'tmp/build/state'
                state.mkdir(parents=True)
                (state / 'pid').write_text('10')
                logs = root / 'tmp/build/logs'
                logs.mkdir()
                current_log, other_log = logs / 'xcodebuild.log', logs / 'other-build.log'
                current_log.write_text('stalled build')
                other_log.write_text('another build is working')
                os.utime(current_log, (self.now - 20000, self.now - 20000))
                os.utime(other_log, (self.now, self.now))
                if state_key:
                    (state / state_key).write_text(str(current_log.relative_to(root)))
                self.rows[900] = {**self.rows[20], 'pid': 900, 'ppid': 1}
                self.after = copy.deepcopy(self.rows)
                hints = {20: str(root), 10: str(root), 900: str(root)}
                raw = (f'p20\nf1\ntREG\nn{current_log}\n' if state_key is None else '')
                raw += f'p900\nf1\ntREG\nn{other_log}\n'
                with patch.object(lp, 'cwd_inventory', return_value=hints), patch.object(lp, 'native_binding', return_value={'CODEX_THREAD_ID': 'native-owner'}), patch.object(lp, 'run', return_value=raw):
                    metadata = lp.xcode_metadata(self.rows[20], self.rows)
                    report = self.detect(metadata=lp.xcode_metadata)
                self.assertEqual(metadata['log_path'], str(current_log))
                self.assertIn(20, [item['pid'] for item in report['candidates']])
                current = next(item for item in report['candidates'] if item['pid'] == 20)
                self.assertEqual(current['log_mtime'], self.now - 20000)
