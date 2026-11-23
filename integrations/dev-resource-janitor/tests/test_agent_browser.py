import copy
import io
import json
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
import time
from unittest.mock import Mock, patch

from janitor_test_safety import JanitorTestCase

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skill/scripts'))
import leftover_processes as lp
import dev_janitor
from test_leftover_processes import OWNER, ROSTER


class BrowserTests(JanitorTestCase):
    def setUp(self):
        self.now = 1794787200
        self.row = dict(pid=42, ppid=1, start=time.strftime('%a %b %d %H:%M:%S %Y', time.localtime(self.now - 9000)),
                        tty='??', args='/opt/agent-browser-darwin-arm64')
        self.child = dict(pid=43, ppid=42, start=self.row['start'], tty='??', args='/opt/chrome-headless-shell')
        self.rows = {42: self.row, 43: self.child}
        self.before = {pid: {**row, 'cpu_seconds': 1., 'rss_kib': 1024} for pid, row in self.rows.items()}
        self.after = copy.deepcopy(self.before)
        self.meta = dict(session='test', socket='/private/test/test.sock', namespace=None, socket_dir=None,
                         binding={'CODEX_THREAD_ID': 'native-owner'})

    def detect(self, **kwargs):
        defaults = dict(metadata=lambda pid: copy.deepcopy(self.meta), resolve=lambda binding: copy.deepcopy(OWNER),
                        now=self.now, window_s=2)
        defaults.update(kwargs)
        return lp.detect_agent_browsers(self.rows, self.before, self.after, ROSTER, {}, **defaults)

    def validate(self, item, **kwargs):
        defaults = dict(metadata=lambda pid: copy.deepcopy(self.meta), resolve=lambda binding: copy.deepcopy(OWNER),
                        snapshot=lambda: copy.deepcopy(ROSTER), observe=lambda: copy.deepcopy(self.after), now=self.now)
        defaults.update(kwargs)
        return lp.revalidate_agent_browser(item, **defaults)

    def test_old_ended_owner_has_candidate_with_session_child_summary(self):
        r = self.detect()
        self.assertEqual([x['pid'] for x in r['candidates']], [42])
        c = r['candidates'][0]
        self.assertEqual((c['session'], c['owner_state'], c['age_s']), ('test', 'ended-owner', 9000))
        self.assertEqual(c['children'][0]['rss_kib'], 1024)
        self.assertEqual(lp.family(self.row), 'agent-browser')

    def test_live_unknown_deleted_unsettled_recent_and_held_owner_keep(self):
        live = copy.deepcopy(OWNER)
        live['thread']['state'] = 'running'
        unsettled = copy.deepcopy(OWNER)
        unsettled['thread']['settled'] = False
        held = copy.deepcopy(OWNER)
        held['recovery']['heldWork'] = True
        recent = copy.deepcopy(OWNER)
        recent['thread']['updatedAt'] = '2026-11-16T05:19:59Z'
        for value in [live, None, {'thread': {'threadId': 'owner'}, 'keep_reason': 'owner_deleted'}, unsettled, held, recent]:
            with self.subTest(owner=value):
                self.assertEqual(self.detect(resolve=lambda binding: value)['candidates'], [])

    def test_unbound_and_unreadable_metadata_always_keep(self):
        self.meta['binding'] = None
        self.assertEqual(self.detect()['inventory'][0]['keep_reason'], 'unknown_owner')
        self.assertEqual(self.detect(metadata=Mock(side_effect=OSError))['candidates'], [])

    def test_owner_state_requires_positive_live_or_ended_evidence(self):
        live = copy.deepcopy(OWNER)
        live['thread']['state'] = 'running'
        forms = [('unresolved', None, 'unknown'),
                 ('deleted', {'thread': {'threadId': 'owner'}, 'keep_reason': 'owner_deleted'}, 'unknown'),
                 ('native_live', {'thread': {'threadId': 'owner'},
                                  'keep_reason': 'owner_has_work_or_not_ended'}, 'live-owner'),
                 ('detail_live', live, 'live-owner'), ('ended', OWNER, 'ended-owner')]
        for key in ['state', 'status']:
            missing = copy.deepcopy(OWNER)
            del missing['thread'][key]
            forms.append(('missing_' + key, missing, 'unknown'))
        for name, value, expected in forms:
            with self.subTest(form=name):
                report = self.detect(resolve=lambda binding: value)
                self.assertEqual(report['inventory'][0]['owner_state'], expected)
                if expected == 'unknown':
                    self.assertEqual(report['candidates'], [])

    def test_young_parented_registered_tty_keep_file_and_incomplete_keep(self):
        for key, value in [('ppid', 99), ('tty', 'ttys001'),
                           ('start', time.strftime('%a %b %d %H:%M:%S %Y', time.localtime(self.now - 20)))]:
            with self.subTest(key=key):
                original = self.row[key]
                self.row[key] = value
                self.assertEqual(self.detect()['candidates'], [])
                self.row[key] = original
        for keep in [['42'], ['test'], ['/private/test/test.sock'], ['/private/test']]:
            with self.subTest(keep=keep):
                self.assertEqual(self.detect(keep=keep)['candidates'], [])
        self.assertEqual(self.detect(window_s=.2)['candidates'], [])
        self.assertEqual(self.detect(deadline=0)['candidates'], [])
        with patch.dict(ROSTER, complete=False):
            self.assertEqual(self.detect()['candidates'], [])
        result = lp.detect_agent_browsers(self.rows, self.before, self.after, ROSTER, {42: 'registered'},
                                          metadata=lambda pid: self.meta, now=self.now, window_s=2)
        self.assertEqual(result['candidates'], [])

    def test_busy_child_pid_reuse_and_incomplete_tree_keep(self):
        forms = [('cpu_seconds', 1.01), ('cpu_seconds', .5), ('start', 'different'), ('args', '/opt/other')]
        for key, value in forms:
            with self.subTest(key=key, value=value):
                self.after = copy.deepcopy(self.before)
                self.after[43][key] = value
                self.assertEqual(self.detect()['candidates'], [])
        self.after = copy.deepcopy(self.before)
        del self.after[43]
        self.assertEqual(self.detect()['candidates'], [])
        self.after = copy.deepcopy(self.before)
        del self.after[42]
        self.assertEqual(self.detect()['candidates'], [])

    def test_disabled_flag_never_probes_closes_or_signals(self):
        report = self.detect()
        for flag in ['', '0', 'true']:
            with self.subTest(flag=flag), patch.dict(lp.os.environ, DEV_JANITOR_REAP_AGENT_BROWSER=flag), \
                    patch.object(lp.os, 'kill') as signal, patch.object(lp.subprocess, 'run') as command:
                rescan, close = Mock(), Mock()
                self.assertEqual(lp.reap_agent_browsers(report, rescan=rescan, close=close), [])
                rescan.assert_not_called()
                close.assert_not_called()
                command.assert_not_called()
                signal.assert_not_called()

    def test_close_rechecks_age_independent_identity_and_confirms_children_exit(self):
        report = self.detect()
        current = copy.deepcopy(report)
        current['candidates'][0]['age_s'] += 10
        tree = copy.deepcopy(self.rows)
        def close(item):
            tree.clear()
        with patch.dict(lp.os.environ, DEV_JANITOR_REAP_AGENT_BROWSER='1'):
            actions = lp.reap_agent_browsers(report, rescan=lambda: current, close=close,
                                            refresh=lambda pid=None: copy.deepcopy(tree), validate=self.validate)
        self.assertTrue(actions[0]['ok'])
        self.assertEqual(actions[0]['action'], 'close')

    def test_close_failure_or_orphaned_child_is_not_success_and_never_falls_back_to_signal(self):
        report = self.detect()
        for mode in ['failed', 'child_survives']:
            with self.subTest(mode=mode):
                tree = copy.deepcopy(self.rows)
                def close(item):
                    if mode == 'failed':
                        raise RuntimeError('failed')
                    del tree[42]
                    tree[43]['ppid'] = 1
                clock = [100.]
                with patch.dict(lp.os.environ, DEV_JANITOR_REAP_AGENT_BROWSER='1'), patch.object(lp.os, 'kill') as signal, \
                        patch.object(lp.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(lp.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
                    actions = lp.reap_agent_browsers(report, rescan=lambda: report, close=close,
                                                    refresh=lambda pid=None: copy.deepcopy(tree), validate=self.validate)
                self.assertFalse(actions[0]['ok'])
                signal.assert_not_called()

    def test_close_waits_for_exact_daemon_and_children_with_a_deadline(self):
        report = self.detect()
        forms = [
            ('immediate_exit', {}, {}, True),
            ('delayed_exit', self.rows, {}, True),
            ('delayed_child', {43: {**self.child, 'ppid': 1}}, {}, True),
            ('reused_daemon', {42: {**self.row, 'start': 'new'}}, {}, True),
            ('reused_child', {43: {**self.child, 'start': 'new'}}, {}, True),
            ('daemon_survives', {42: self.row}, {42: self.row}, False),
            ('child_survives_reused_daemon', {42: {**self.row, 'start': 'new'}, 43: self.child},
             {43: {**self.child, 'ppid': 1}}, False),
        ]
        for name, initial, later, expected in forms:
            clock = [100.]
            refresh = Mock(side_effect=lambda: copy.deepcopy(initial if clock[0] < 100.2 else later))
            close = Mock()
            with self.subTest(form=name), patch.dict(lp.os.environ, DEV_JANITOR_REAP_AGENT_BROWSER='1'), \
                    patch.object(lp.time, 'monotonic', side_effect=lambda: clock[0]), \
                    patch.object(lp.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
                    patch.object(lp.os, 'kill') as signal:
                action = lp.reap_agent_browsers(report, rescan=lambda: report, close=close,
                                               refresh=refresh, validate=self.validate)[0]
                self.assertEqual(action['ok'], expected)
                self.assertEqual(action['action'], 'close')
                close.assert_called_once()
                signal.assert_not_called()
                self.assertLessEqual(clock[0], 100. + lp.BROWSER_EXIT_GRACE)
                if expected:
                    self.assertNotIn('reason', action)
                else:
                    self.assertEqual(action['reason'], 'close_incomplete')
                    self.assertEqual(clock[0], 100. + lp.BROWSER_EXIT_GRACE)

    def test_exit_process_reads_share_the_deadline_and_unavailable_reads_fail(self):
        report = self.detect()
        for unavailable in [False, True]:
            clock, budgets = [100.], []
            def observe(pid=None, *, timeout):
                budgets.append(timeout)
                clock[0] += .1
                if unavailable:
                    raise subprocess.TimeoutExpired('ps', timeout)
                return copy.deepcopy(self.rows)
            with self.subTest(unavailable=unavailable), patch.dict(lp.os.environ, DEV_JANITOR_REAP_AGENT_BROWSER='1'), \
                    patch.object(lp.time, 'monotonic', side_effect=lambda: clock[0]), \
                    patch.object(lp.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
                    patch.object(lp, 'processes', side_effect=observe):
                action = lp.reap_agent_browsers(report, rescan=lambda: report, close=Mock(), validate=self.validate)[0]
                self.assertFalse(action['ok'])
                self.assertEqual(action['reason'], 'TimeoutExpired' if unavailable else 'close_incomplete')
                self.assertEqual(budgets[0], lp.BROWSER_EXIT_GRACE)
                self.assertTrue(all(0 < budget <= lp.BROWSER_EXIT_GRACE for budget in budgets))
                self.assertEqual(budgets, sorted(budgets, reverse=True))

    def test_socket_close_acknowledged_before_daemon_and_child_exit(self):
        with tempfile.TemporaryDirectory(prefix='browser-exit-') as directory:
            path = str(Path(directory) / 'test.sock')
            candidate = {**self.detect()['candidates'][0], 'pid': lp.os.getpid(), 'socket': path}
            tree = {candidate['pid']: {**self.row, 'pid': candidate['pid']}, 43: self.child}
            report = {'candidates': [candidate], 'problems': []}
            release, acknowledged = threading.Event(), threading.Event()
            clock = [100.]
            with lp.socket.socket(lp.socket.AF_UNIX, lp.socket.SOCK_STREAM) as listener:
                listener.settimeout(5)
                listener.bind(path)
                listener.listen()
                def daemon():
                    with listener.accept()[0] as connection:
                        connection.settimeout(5)
                        with connection.makefile('rb') as request:
                            message = json.loads(request.readline())
                        connection.sendall(b'{"success":true}\n')
                        acknowledged.set()
                        if not release.wait(5):
                            raise RuntimeError('exit was not released')
                        return message
                with ThreadPoolExecutor(max_workers=1) as executor:
                    response = executor.submit(daemon)
                    def pause(seconds):
                        self.assertTrue(acknowledged.wait(5))
                        release.set()
                        self.assertEqual(response.result(timeout=5)['action'], 'close')
                        tree.clear()
                        clock[0] += seconds
                    try:
                        with patch.dict(lp.os.environ, DEV_JANITOR_REAP_AGENT_BROWSER='1'), \
                                patch.object(lp, 'browser_metadata', return_value={**self.meta, 'socket': path}), \
                                patch.object(lp, 'browser_tree_matches', return_value=True), \
                                patch.object(lp, 'cpu_processes', return_value=tree), \
                                patch.object(lp.time, 'monotonic', side_effect=lambda: clock[0]), \
                                patch.object(lp.time, 'sleep', side_effect=pause), \
                                patch.object(lp.os, 'kill') as signal:
                            action = lp.reap_agent_browsers(report, rescan=lambda: report, validate=lambda item: True,
                                                           refresh=lambda: copy.deepcopy(tree))[0]
                            self.assertTrue(action['ok'])
                            self.assertGreater(clock[0], 100.)
                            signal.assert_not_called()
                    finally:
                        release.set()
                        response.result(timeout=5)

    def test_revalidation_blocks_changed_owner_pid_session_and_new_busy_child(self):
        report = self.detect()
        for key, value in [('owner', 'another'), ('start', 'new'), ('session', 'other')]:
            fresh = copy.deepcopy(report)
            fresh['candidates'][0][key] = value
            with self.subTest(key=key), patch.dict(lp.os.environ, DEV_JANITOR_REAP_AGENT_BROWSER='1'):
                close = Mock()
                self.assertFalse(lp.reap_agent_browsers(report, rescan=lambda: fresh, close=close)[0]['ok'])
                close.assert_not_called()
        self.after[43]['cpu_seconds'] += 1
        with patch.dict(lp.os.environ, DEV_JANITOR_REAP_AGENT_BROWSER='1'):
            close = Mock()
            self.assertFalse(lp.reap_agent_browsers(report, rescan=self.detect, close=close)[0]['ok'])
            close.assert_not_called()

    def test_owner_is_resolved_again_after_the_bulk_rescan(self):
        report = self.detect()
        cases = ['running', 'held', 'queued_child', 'unsettled', 'recent', 'unknown', 'deleted',
                 'binding_changed', 'roster_incomplete', 'roster_resumed', 'roster_delegated',
                 'owner_unavailable', 'roster_unavailable']
        for case in cases:
            own = copy.deepcopy(OWNER)
            meta, roster = copy.deepcopy(self.meta), copy.deepcopy(ROSTER)
            if case == 'running':
                own['thread']['state'] = 'running'
            elif case == 'held':
                own['recovery']['heldWork'] = True
            elif case == 'queued_child':
                own['recovery']['children'] = [{'status': 'queued'}]
            elif case == 'unsettled':
                own['thread']['settled'] = False
            elif case == 'recent':
                own['thread']['updatedAt'] = '2026-11-16T05:19:59Z'
            elif case == 'unknown':
                own = None
            elif case == 'deleted':
                own = {'thread': {'threadId': 'owner'}, 'keep_reason': 'owner_deleted'}
            elif case == 'binding_changed':
                meta['binding'] = {'CODEX_THREAD_ID': 'another'}
            elif case == 'roster_incomplete':
                roster['complete'] = False
            elif case == 'roster_resumed':
                roster['threads']['owner'] = {'threadId': 'owner', 'state': 'running'}
            elif case == 'roster_delegated':
                roster['threads']['child'] = {'threadId': 'child', 'parentThreadId': 'owner',
                                             'state': 'idle', 'creationSource': 'provider'}
            resolve = Mock(side_effect=OSError) if case == 'owner_unavailable' else lambda binding: own
            snapshot = Mock(side_effect=OSError) if case == 'roster_unavailable' else lambda: roster
            validate = lambda item: self.validate(item, metadata=lambda pid: meta, resolve=resolve, snapshot=snapshot)
            # The bulk scan has already approved A when resolving another owner
            # allows A to resume. Its stored candidate remains unchanged.
            with self.subTest(case=case), patch.dict(lp.os.environ, DEV_JANITOR_REAP_AGENT_BROWSER='1'):
                close = Mock()
                action = lp.reap_agent_browsers(report, rescan=lambda: copy.deepcopy(report),
                                               close=close, validate=validate)[0]
                self.assertEqual(action['action'], 'kept')
                self.assertFalse(action['ok'])
                close.assert_not_called()

    def test_final_child_tree_changes_and_incomplete_observations_keep(self):
        report = self.detect()
        cases = ['new_child', 'gone_child', 'reused_child', 'reparented_child', 'changed_command',
                 'changed_tty', 'busy_child', 'cpu_reset', 'root_reused', 'root_gone', 'unavailable']
        for case in cases:
            tree = copy.deepcopy(self.after)
            if case == 'new_child':
                tree[44] = {**tree[43], 'pid': 44}
            elif case == 'gone_child':
                del tree[43]
            elif case == 'reused_child':
                tree[43]['start'] = 'new'
            elif case == 'reparented_child':
                tree[43]['ppid'] = 1
            elif case == 'changed_command':
                tree[43]['args'] = '/opt/other'
            elif case == 'changed_tty':
                tree[43]['tty'] = 'ttys001'
            elif case == 'busy_child':
                tree[43]['cpu_seconds'] += .01
            elif case == 'cpu_reset':
                tree[43]['cpu_seconds'] -= .01
            elif case == 'root_reused':
                tree[42]['start'] = 'new'
            elif case == 'root_gone':
                del tree[42]
            observe = Mock(side_effect=OSError) if case == 'unavailable' else lambda: tree
            with self.subTest(case=case), patch.dict(lp.os.environ, DEV_JANITOR_REAP_AGENT_BROWSER='1'):
                close = Mock()
                action = lp.reap_agent_browsers(report, rescan=lambda: report, close=close,
                                               validate=lambda item: self.validate(item, observe=observe))[0]
                self.assertEqual(action['action'], 'kept')
                close.assert_not_called()

    def test_owner_resuming_during_each_roster_source_is_kept(self):
        report = self.detect()
        for phase in ['robob_active', 'opencode_active', 'project_roots']:
            own = copy.deepcopy(OWNER)
            other = {'threadId': 'other', 'state': 'running', 'projectId': 'project'}
            def source(name, result):
                if name == phase:
                    own['thread']['state'] = 'running'
                return result, None
            with self.subTest(phase=phase), patch.dict(lp.os.environ, DEV_JANITOR_REAP_AGENT_BROWSER='1'), \
                    patch.object(lp.active_sessions, 'robob_active',
                                 side_effect=lambda timeout, **kwargs: source('robob_active', {'other': other})), \
                    patch.object(lp.active_sessions, 'opencode_active',
                                 side_effect=lambda timeout: source('opencode_active', set())), \
                    patch.object(lp.active_sessions, 'project_roots',
                                 side_effect=lambda timeout: source('project_roots', {'project': '/private/test/other'})):
                close = Mock()
                action = lp.reap_agent_browsers(
                    report, rescan=lambda: copy.deepcopy(report), close=close, refresh=lambda: {},
                    validate=lambda item: self.validate(item, resolve=lambda binding: copy.deepcopy(own),
                                                        snapshot=lp.active_sessions.checked_snapshot))[0]
                self.assertEqual(own['thread']['state'], 'running')
                self.assertEqual(action['action'], 'kept')
                close.assert_not_called()

    def test_graceful_close_uses_exact_socket_with_peer_and_start_identity(self):
        candidate = self.detect()['candidates'][0]
        stream = Mock()
        stream.getsockopt.return_value = struct.pack('i', 42)
        stream.makefile.return_value = io.BytesIO(b'{"success":true}\n')
        manager = Mock()
        manager.__enter__ = Mock(return_value=stream)
        manager.__exit__ = Mock(return_value=False)
        with patch.object(lp, 'browser_metadata', return_value=self.meta), \
                patch.object(lp, 'cpu_processes', return_value=self.after), \
                patch.object(lp.sys, 'platform', 'darwin'), \
                patch.object(lp.socket, 'socket', return_value=manager), \
                patch.object(lp.subprocess, 'run') as run:
            lp.close_agent_browser(candidate)
        stream.connect.assert_called_once_with('/private/test/test.sock')
        stream.getsockopt.assert_called_once_with(0, 2, struct.calcsize('i'))
        self.assertEqual(json.loads(stream.sendall.call_args.args[0])['action'], 'close')
        run.assert_not_called()

    def test_replaced_socket_or_process_never_receives_close(self):
        candidate = self.detect()['candidates'][0]
        for peer, rows in [(99, self.after), (42, {42: {**self.row, 'start': 'reused'}})]:
            stream = Mock()
            stream.getsockopt.return_value = struct.pack('i', peer)
            manager = Mock()
            manager.__enter__ = Mock(return_value=stream)
            manager.__exit__ = Mock(return_value=False)
            with self.subTest(peer=peer), patch.object(lp, 'browser_metadata', return_value=self.meta), \
                    patch.object(lp, 'cpu_processes', return_value=rows), patch.object(lp.sys, 'platform', 'darwin'), \
                    patch.object(lp.socket, 'socket', return_value=manager):
                with self.assertRaises(ValueError):
                    lp.close_agent_browser(candidate)
            stream.sendall.assert_not_called()

    def test_child_spawned_during_socket_connection_never_receives_close(self):
        candidate = self.detect()['candidates'][0]
        tree = copy.deepcopy(self.after)
        tree[44] = {**tree[43], 'pid': 44}
        stream = Mock()
        stream.getsockopt.return_value = struct.pack('i', 42)
        manager = Mock()
        manager.__enter__ = Mock(return_value=stream)
        manager.__exit__ = Mock(return_value=False)
        with patch.object(lp, 'browser_metadata', return_value=self.meta), \
                patch.object(lp, 'cpu_processes', return_value=tree), patch.object(lp.sys, 'platform', 'darwin'), \
                patch.object(lp.socket, 'socket', return_value=manager):
            with self.assertRaises(ValueError):
                lp.close_agent_browser(candidate)
        stream.sendall.assert_not_called()

    def test_existing_unix_socket_close_round_trip_without_starting_a_process(self):
        with tempfile.TemporaryDirectory(prefix='browser-socket-') as directory:
            path = str(Path(directory) / 'test.sock')
            candidate = {**self.detect()['candidates'][0], 'pid': lp.os.getpid(), 'socket': path, 'children': []}
            meta = {**self.meta, 'socket': path}
            with lp.socket.socket(lp.socket.AF_UNIX, lp.socket.SOCK_STREAM) as listener:
                listener.settimeout(5)
                listener.bind(path)
                listener.listen()
                def daemon():
                    with listener.accept()[0] as connection:
                        connection.settimeout(5)
                        with connection.makefile('rb') as request:
                            message = json.loads(request.readline())
                        connection.sendall(b'{"success":true}\n')
                        return message
                with ThreadPoolExecutor(max_workers=1) as executor:
                    response = executor.submit(daemon)
                    with patch.object(lp, 'browser_metadata', return_value=meta), \
                            patch.object(lp, 'cpu_processes', return_value={candidate['pid']: candidate}), \
                            patch.object(lp.subprocess, 'run') as run:
                        lp.close_agent_browser(candidate)
                    self.assertEqual(response.result()['action'], 'close')
                    run.assert_not_called()

    def test_report_audit_and_hourly_action_keep_old_keys(self):
        old = dict(candidates=[], problems=[], checked=0, skipped=0, budget_skipped=0, owner_calls={})
        self.assertEqual(lp.report_summary(old), old)
        browser = self.detect()
        st = {'processes': {**old, 'agent_browser': browser}}
        with patch.object(lp, 'reap_agent_browsers', return_value=[{'pid': 42, 'ok': True}]), \
                patch.object(dev_janitor, 'audit') as audit:
            dev_janitor.close_browser_candidates(st)
        self.assertEqual(st['processes']['agent_browser']['actions'], [{'pid': 42, 'ok': True}])
        self.assertEqual(audit.call_args.args[0]['event'], 'agent_browser_close')
        self.assertEqual(lp.report_summary(st['processes'])['owner_calls'], {})

    def test_cpu_observations_parse_minutes_hours_and_exiting_rows(self):
        for cpu, seconds in [('0:00.01', .01), ('93:02.82', 5582.82), ('1:02:03.00', 3723)]:
            raw = f"42 1 {self.row['start']} ?? {cpu} 1024 /opt/agent-browser-darwin-arm64\n"
            with self.subTest(cpu=cpu), patch.object(lp, 'run', return_value=raw):
                self.assertAlmostEqual(lp.cpu_processes()[42]['cpu_seconds'], seconds)
        with patch.object(lp, 'run', return_value='43 1 Tue Nov 17 03:00:00 2026 ?? 0:00.00 0 (Python)\n'):
            self.assertEqual(lp.cpu_processes()[43]['rss_kib'], 0)
        with patch.object(lp, 'run', return_value='broken'):
            with self.assertRaises(ValueError):
                lp.cpu_processes()
