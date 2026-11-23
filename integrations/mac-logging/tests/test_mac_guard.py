from concurrent.futures import Future
import copy
import datetime as dt
import io
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import mac_guard as m
import status
import toollog

NOW = 1794873600
ROBOB = '/Applications/Robob.app/Contents/MacOS/Robob'


def immediate_submit(fn):
    future = Future()
    try:
        future.set_result(fn())
    except BaseException as exc:
        future.set_exception(exc)
    return future


def proc(pid, comm='burner', ppid=1, cpu=0, args=None, state='S', **kw):
    value = dict(pid=pid, ppid=ppid, start='Mon Nov 16 00:00:00 2026', comm=comm,
                args=args or comm, state=state, cpuS=cpu, rssMb=2, etime='02:00:00',
                family=Path(comm).name)
    value.update(kw)
    return value


def snapshot(rows, footprints=None, load=0, pressure=1, lag=0, ticks=None):
    return dict(rows=rows, top=[dict(pid=pid, memMb=gb*1024, cmprsMb=gb*1000, command='truncated')
                              for pid, gb in (footprints or {}).items()], load=[load]*3, ncpu=16,
                lag=lag, pressure=pressure, swap=dict(usedMb=39000, totalMb=40000), ticks=ticks)


def robob_browser_tree(parent='server', cpu=0):
    app = proc(1, ROBOB)
    server = proc(2, 'node', ppid=1, args='node apps/server/dist/bin.mjs --bootstrap-fd 3')
    session = proc(3, 'codex', ppid=2)
    browser = proc(10, '/Users/test/.robob/tools/chrome-headless-shell/chrome-headless-shell',
                   ppid=3 if parent == 'provider' else 2 if parent == 'server' else 1,
                   args='chrome-headless-shell --headless')
    renderer = proc(11, browser['comm'], ppid=10, cpu=cpu, args='chrome-headless-shell --type=renderer')
    return [app, server, session, browser, renderer] if parent != 'standalone' else [browser, renderer]


class FakeHost:
    def __init__(self):
        self.effects = []
        self.live = {}
        self.suspended = set()
        self.owners = {}
        self.builds = {}
        self.worker = dict(state='running')
        self.launches = {}
        self.lookups = []
        self.initial_launches = {}
        self.sent_requests = set()
        self.checks = dict(pid=1, started=NOW-3600, hold=None, restart=False, install=False, building=[])
        self.apps = {}

    def app_info(self, p):
        return self.apps.get(p['comm'])

    def quit_app(self, p):
        self.effects.append(('quit', p['pid'], p['bundleId']))

    def ssd_blocked(self):
        return False

    def identity(self, p):
        q = self.live.get(p['pid'])
        return bool(q and q['start'] == p['start'] and q['comm'] == p['comm'] and q['args'] == p['args'])

    def same_birth(self, p):
        q = self.live.get(p['pid'])
        return bool(q and q['start'] == p['start'])

    def signal(self, p, sig):
        self.effects.append(('signal', p['pid'], signal.Signals(sig).name))
        ident = (p['pid'], p['start'])
        if sig == signal.SIGSTOP:
            self.suspended.add(ident)
        elif sig == signal.SIGCONT:
            self.suspended.discard(ident)

    def soften(self, p):
        self.effects.append(('soften', p['pid']))
        return dict(result='sent', niceBefore=0, niceAfter=20,
                    stages=dict(identityRead=dict(result='sent', same=True), getpriority=dict(result='sent'),
                                renice=dict(rc=0, result='sent'), identityRecheck=dict(result='sent', same=True),
                                readBack=dict(result='sent')))

    def notify(self, key, text):
        self.effects.append(('notify', key, text))

    def ownership(self, p, rows, now):
        return dict(state=self.owners.get(p['pid'], 'unknown'))

    def build(self, p, rows, now):
        return self.builds.get(p['pid'], {})

    def overload(self):
        if isinstance(self.checks, Exception):
            raise self.checks
        return self.checks

    def restart(self, log, stamp):
        self.effects.append(('restart', str(log), stamp))

    def restart_result(self, pending):
        return None

    def worker_status(self, tid):
        return self.worker

    def worker_send(self, tid, text, request_id=None):
        if request_id is None or request_id not in self.sent_requests:
            self.effects.append(('steer', tid, text))
            self.sent_requests.add(request_id)

    def worker_lookup(self, request_id):
        self.lookups.append(request_id)
        return self.launches.get(request_id)

    def worker_create(self, launch):
        request_id = launch['clientRequestId']
        if request_id not in self.initial_launches:
            self.effects.append(('worker', launch['prompt']))
            self.initial_launches[request_id] = copy.deepcopy(launch)
        self.launches[request_id] = m.worker_thread_id(request_id)
        return self.launches[request_id]

    def worker_initial(self, launch):
        return m.worker_thread_id(launch['clientRequestId']) if launch['clientRequestId'] in self.initial_launches else None

    def worker_resume(self, launch):
        request_id = launch['clientRequestId']
        if request_id not in self.initial_launches:
            self.effects.append(('safety', m.worker_thread_id(request_id), launch['prompt'], request_id))
            self.initial_launches[request_id] = copy.deepcopy(launch)
        return m.worker_thread_id(request_id)

    def diagnostic(self, path):
        self.effects.append(('diagnostic', str(path)))


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.host = FakeHost()
        self.events = []
        self.now = NOW
        self.guard = m.Guard(self.host, self.root/'state', self.root/'evidence', dry=False,
                             logger=lambda c, k, n, **kw: self.events.append((n, kw['props'])), clock=lambda: self.now, worker_submit=immediate_submit)

    def tick(self, rows, footprints=None, **kw):
        rows = [dict(p) for p in rows]
        for p in rows:
            if (p['pid'], p['start']) in self.host.suspended:
                p['state'] = 'T'
        self.host.live = {p['pid']: copy.deepcopy(p) for p in rows}
        result = self.guard.tick(snapshot(rows, footprints, **kw), self.now)
        self.now += 30
        return result

    def effects(self, kind):
        return [e for e in self.host.effects if e[0] == kind]

    def events_named(self, name):
        return [props for n, props in self.events if n == 'macguard.'+name]

    def test_nov16_memory_replay(self):
        rows = [proc(10, 'node', args='node cluster-supervisor.cjs', label='com.ardud.9router'),
                proc(20, 'node', ppid=10, args='node next-server PORT=20128')]
        for gb in (2, 12.5):
            result = self.tick(rows, {20: gb}, pressure=2)
            self.assertFalse(result['strain'])
            self.assertFalse(self.effects('signal'))
        result = self.tick(rows, {20: 23}, pressure=2)
        self.assertIn(5, result['signals'])
        self.assertNotIn(4, result['signals'])
        self.assertEqual(self.effects('signal'), [('signal', 20, 'SIGTERM')])
        self.guard.drain(self.now-20)
        self.assertEqual(self.effects('signal')[-1], ('signal', 20, 'SIGKILL'))
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertEqual(len(self.effects('notify')), 1)
        event = self.events_named('memory_runaway')[0]
        self.assertAlmostEqual(event['growthGiBMin'], 21)
        self.assertEqual(event['memoryClass'], 'carve-out')
        path = Path(self.effects('worker')[0][1].split('Evidence: ')[1].splitlines()[0])
        evidence = json.loads((path/'snapshot.json').read_text())
        self.assertEqual(len(evidence['history']['20']), 3)
        self.assertEqual(evidence['rows'][0]['label'], 'com.ardud.9router')

    def test_nov16_load_replay(self):
        rows = [proc(1, '/sbin/launchd', ppid=0), proc(10, ROBOB, state='R'), proc(2, 'codex', ppid=10, state='R'),
                proc(3, 'python3', args='python3 msgs.py', label='com.abdullah.msgs', state='R'),
                proc(100, 'xcodebuild', state='R'), proc(101, 'SWBBuildService', ppid=100, state='R')]
        rows += [proc(110+i, 'clang', ppid=101, state='R') for i in range(9)]
        rows += [proc(130+i, 'swift-frontend', ppid=101, state='R') for i in range(7)]
        rows += [proc(200+i, 'agent-browser-darwin-arm64') for i in range(42)]
        rows += [proc(400+i, 'python3', args='python3 live-job.py', state='R', label='com.abdullah.job') for i in range(128)]
        self.host.builds[100] = dict(detached=True, stale=True)
        for _ in range(9):
            result = self.tick(rows, load=224, lag=8)
            self.guard.drain(self.now-20)
        self.assertEqual(result['rZeroCount'], 149)
        signals = self.effects('signal')
        self.assertIn(('signal', 100, 'SIGTERM'), signals)
        self.assertIn(('signal', 100, 'SIGKILL'), signals)
        self.assertTrue(all(p not in {1, 2, 3, 10} for _, p, _ in signals))
        self.assertEqual({p for _, p, sig in signals if 200 <= p < 242 and sig == 'SIGTERM'}, set(range(200, 242)))
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertFalse(self.effects('steer'))  # no new signal after the initial launch

    def test_memory_edges(self):
        for _ in range(5):
            self.tick([proc(10)], {10: 20})
        self.assertFalse(self.host.effects)
        self.tick([proc(10)], {10: 50})
        self.assertEqual(self.effects('signal')[0], ('signal', 10, 'SIGTERM'))

    def test_provider_memory_matrix(self):
        for name, args in [('codex', 'codex'), ('claude', 'claude'), ('opencode', 'opencode serve'),
                           ('gemini', 'gemini'), ('cursor-agent', 'cursor-agent'),
                           ('node', 'node /tools/@openai/codex/bin/codex.js'),
                           ('bun', 'bun /tools/opencode/bin/opencode')]:
            for owner in ('live', 'ended', 'unknown'):
                with self.subTest(name=name, owner=owner):
                    self.host.owners[10] = owner
                    self.tick([proc(10, name, args=args)], {10: 200})
        self.assertFalse(self.effects('signal'))
        self.assertFalse(self.effects('soften'))
        self.assertTrue(self.events_named('memory_runaway'))
        self.assertTrue(all(e['action'] == 'protected_alert' for e in self.events_named('memory_runaway')))
        self.assertEqual(len(self.effects('worker')), 1)

    def test_stuck_orphan_provider_untouched(self):
        rows = [proc(1, 'codex'), proc(2, 'claude'), proc(3, 'opencode')]
        for _ in range(12):
            self.tick(rows, load=200)
        self.assertFalse(self.effects('signal'))
        self.assertFalse(self.effects('soften'))

    def test_provider_below_job_never_signalled_by_tree(self):
        rows = [proc(10, 'xcodebuild'), proc(11, 'codex', ppid=10), proc(12, 'clang', ppid=10)]
        self.host.builds[10] = dict(detached=True, stale=True, root=10)
        for _ in range(3):
            self.tick(rows, load=200)
        self.assertFalse(any(e[1] in (10, 11) for e in self.effects('signal')))
        self.assertIn(('signal', 12, 'SIGTERM'), self.effects('signal'))

    def test_robob_runaway_restart_once(self):
        for gb in (6, 18, 30):
            self.tick([proc(1, ROBOB)], {1: gb})
        self.assertEqual(len(self.effects('restart')), 1)
        self.assertFalse(self.effects('signal'))
        self.assertEqual(self.events_named('robob_restart')[0]['result'], 'launched')
        self.tick([proc(1, ROBOB)], {1: 35})
        self.assertEqual(len(self.effects('restart')), 1)
        self.assertEqual(self.events_named('robob_restart')[-1]['reason'], 'memory_restart_cooldown')
        self.assertFalse(self.effects('worker'))  # the detached attempt has not reported yet

    def test_robob_tree_total(self):
        self.tick([proc(1, ROBOB), proc(2, '/Applications/Robob.app/Contents/Frameworks/Robob Helper (Renderer)', ppid=1)], {1: 10, 2: 15})
        self.assertEqual(len(self.effects('restart')), 1)
        self.assertFalse(self.effects('signal'))

    def test_node_provider_not_robob_tree(self):
        self.tick([proc(1, ROBOB), proc(2, 'node', ppid=1, args='node /tools/codex/bin/codex.js')], {1: 3, 2: 200})
        self.assertFalse(self.effects('restart'))
        self.assertFalse(self.effects('signal'))
        self.assertEqual(self.events_named('memory_runaway')[0]['memoryClass'], 'protected')

    def test_robob_skip_matrix(self):
        cases = [('hold', 'installer', 'install_hold'), ('restart', True, 'tmux_session'),
                 ('install', True, 'tmux_session'), ('building', ['release'], 'release_build'),
                 ('started', NOW-120, 'server_uptime_under_10m'), ('started', None, 'server_start_unavailable')]
        for key, value, reason in cases:
            with self.subTest(key=key):
                self.host.checks = dict(pid=1, started=NOW-3600, hold=None, restart=False, install=False, building=[])
                self.host.checks[key] = value
                self.tick([proc(1, ROBOB)], {1: 25})
                self.assertEqual(self.events_named('robob_restart')[-1]['reason'], reason)
        self.host.checks = m.ProbeError('missing')
        self.tick([proc(1, ROBOB)], {1: 25})
        self.assertEqual(self.events_named('robob_restart')[-1]['reason'], 'restart_unavailable')
        self.assertFalse(self.effects('restart'))
        self.assertFalse(self.effects('signal'))
        self.assertEqual(len(self.effects('worker')), 1)

    def test_memory_repeat_notify_once(self):
        for i in range(3):
            self.tick([proc(10+i, 'node', args='node next-server', label='com.ardud.router')], {10+i: 50})
            self.guard.drain(self.now-20)
        self.assertEqual(len(self.effects('signal')), 6)
        self.assertEqual(len(self.effects('notify')), 1)
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertEqual(len(self.effects('steer')), 2)

    def test_top_fails_no_rss_fallback(self):
        rows = [proc(10)]
        rows[0]['rssMb'] = 200*1024
        for i in range(3):
            value = snapshot(rows, pressure=4)
            value.update(top=None, errors=[dict(probe='top', failure='timeout')])
            self.guard.tick(value, NOW+i*30)
        self.assertFalse(self.host.effects)
        self.assertEqual(len(self.events_named('error')), 3)

    def test_healthy_detached_build_softening_only(self):
        self.host.builds[10] = dict(detached=True, stale=False)
        self.host.owners[10] = 'live'
        for i in range(15):
            self.tick([proc(10, 'xcodebuild', cpu=i*60)], load=200)
        self.assertEqual(self.effects('soften'), [('soften', 10)])
        self.assertFalse(self.effects('signal'))

    def test_detached_build_no_progress_fresh_log_kept(self):
        self.host.builds[10] = dict(detached=True, stale=False)
        for _ in range(4):
            self.tick([proc(10, 'xcodebuild')], load=200)
        self.assertFalse(self.effects('signal'))

    def test_hog_ladder_and_resume(self):
        for i in range(10):
            self.tick([proc(10, cpu=i*60)], load=200)
            self.guard.drain(self.now-20)
        effects = [e[:3] for e in self.host.effects if e[0] in ('soften', 'signal')]
        self.assertEqual(effects[:4], [('soften', 10), ('signal', 10, 'SIGSTOP'), ('signal', 10, 'SIGTERM'), ('signal', 10, 'SIGKILL')])
        for _ in range(10):
            self.tick([proc(10, cpu=540)])
        self.assertIn(('signal', 10, 'SIGCONT'), self.effects('signal'))

    def test_already_nice_skip_does_not_stall_hog_ladder(self):
        self.host.soften = lambda p:dict(result='skipped', reason='already-nice', niceBefore=20, niceAfter=20,
                                        stages=dict(renice=dict(result='skipped', reason='already-nice')))
        for i in range(10):
            self.tick([proc(10, cpu=i*60)], load=200)
            self.guard.drain(self.now-20)
        self.assertIn(('signal', 10, 'SIGSTOP'), self.effects('signal'))
        self.assertIn(('signal', 10, 'SIGTERM'), self.effects('signal'))
        skipped = [e for e in self.events_named('action') if e['action'] == 'renice']
        self.assertEqual(len(skipped), 1)
        self.assertEqual(skipped[0]['reason'], 'already-nice')

    def test_gui_hogs_soften_only(self):
        for i in range(15):
            self.tick([proc(10, '/Applications/Dia.app/Contents/MacOS/Dia', cpu=i*60),
                       proc(11, '/Applications/Messages.app/Contents/MacOS/Messages', cpu=i*60)], load=200)
        self.assertEqual(len(self.effects('soften')), 2)
        self.assertFalse(self.effects('signal'))

    def test_gui_memory_carveout(self):
        self.tick([proc(10, '/Applications/Dia.app/Contents/MacOS/Dia')], {10: 50})
        self.assertEqual(self.effects('signal'), [('signal', 10, 'SIGTERM')])

    def test_pid_reuse_before_kill(self):
        self.tick([proc(10)], {10: 50})
        self.host.live[10]['start'] = 'Mon Nov 16 01:00:00 2026'
        self.guard.drain(self.now-20)
        self.assertEqual(len(self.effects('signal')), 1)
        self.assertEqual(self.events_named('action')[-1]['result'], 'skipped_identity')

    def test_quiet_samples_and_pause_dry(self):
        for _ in range(20):
            self.tick([proc(10)])
        self.assertFalse(self.host.effects)
        self.assertEqual(len(self.events_named('sample')), 2)
        for mode in ('pause', 'dry'):
            if mode == 'pause':
                (self.guard.state/'paused').touch()
            else:
                (self.guard.state/'paused').unlink()
                self.guard.dry = True
            self.tick([proc(1, ROBOB), proc(10)], {1: 25, 10: 50})
            self.guard.drain(self.now)
            self.assertFalse(self.host.effects)
        self.assertEqual([e['reason'] for e in self.events_named('robob_restart')], ['paused', 'dry_run'])

    def test_worker_cooldown(self):
        self.guard.worker = dict(endedAt=NOW-100)
        for _ in range(3):
            self.tick([proc(10)], load=100)
        self.assertFalse(self.effects('worker'))
        self.tick([proc(20)], {20: 50})
        self.guard.drain(self.now-20)
        self.assertEqual(len(self.effects('worker')), 1)
        self.host.worker = dict(state='idle', status='completed')
        self.tick([proc(20)], {20: 50})
        self.guard.drain(self.now-20)
        self.assertEqual(len(self.effects('worker')), 1)

    def test_ended_worker_no_duplicate_during_same_protected_incident(self):
        self.tick([proc(10, 'codex')], {10: 200})
        self.host.worker = dict(state='idle', status='completed')
        self.tick([proc(10, 'codex')], {10: 200})
        self.assertEqual(len(self.effects('worker')), 1)
        self.tick([proc(11, 'codex')], {11: 200})
        self.assertEqual(len(self.effects('worker')), 2)

    def test_diagnostic_two_minute_windows_once(self):
        rows = [proc(100+i, 'codex', state='R') for i in range(64)]
        for i in range(9):
            self.tick(rows, load=120, ticks=[i*300, 0, i*700, 0])
        self.assertEqual(len(self.effects('diagnostic')), 1)
        self.assertFalse(self.effects('signal'))
        path = Path(self.effects('diagnostic')[0][1])
        progress = json.loads((path/'progress60.json').read_text())
        self.assertEqual(len(progress['progress']), 64)
        self.assertEqual(progress['progress'][0]['windowS'], 60)

    def test_restore_log(self):
        self.tick([proc(10)], {10: 50})
        for _ in range(4):
            self.tick([proc(10)], {10: 1})
        self.assertEqual(len(self.events_named('restore')), 1)

    def test_system_and_cua_exemptions(self):
        rows = [proc(10+i, comm) for i, comm in enumerate(['/System/Library/daemon', '/usr/libexec/tool',
                 '/usr/sbin/tool', '/sbin/tool', 'launchd', 'WindowServer', 'kernel_task'])]
        self.tick(rows, {p['pid']: 200 for p in rows})
        self.assertFalse(self.effects('signal'))


    def test_load_and_lag_two_consecutive_samples(self):
        self.assertFalse(self.tick([proc(10)], load=64)['strain'])
        self.assertTrue(self.tick([proc(10)], load=64)['strain'])
        self.assertEqual(self.events_named('strain_start')[0]['signals'], [1])

    def test_lag_alone_and_clear_ten_cycles(self):
        self.assertFalse(self.tick([proc(10)], lag=8)['strain'])
        self.assertTrue(self.tick([proc(10)], lag=8)['strain'])
        for _ in range(9):
            self.assertTrue(self.tick([proc(10)])['strain'])
        self.assertFalse(self.tick([proc(10)])['strain'])

    def test_calm_countdown_never_requests_worker(self):
        self.guard.worker = dict(threadId='existing', startedAt=NOW)
        self.tick([], lag=8)
        self.tick([], lag=8)
        self.host.effects.clear()
        with patch.object(self.guard, 'worker_needed') as needed:
            for _ in range(9):
                self.assertTrue(self.tick([])['strain'])
            needed.assert_not_called()
        self.assertFalse(self.effects('steer'))
        self.assertEqual(self.events_named('worker_skipped')[0]['reason'], 'empty_signals')

    def test_strain_steers_on_gain_or_ten_minute_ongoing(self):
        self.guard.worker = dict(threadId='existing', startedAt=NOW)
        self.tick([], load=100)
        self.tick([], load=100)
        self.assertEqual(len(self.effects('steer')), 1)
        for _ in range(19):
            self.tick([], load=100)
        self.assertEqual(len(self.effects('steer')), 1)
        self.tick([], load=100)
        self.assertEqual(len(self.effects('steer')), 2)
        self.assertIn('still ongoing', self.effects('steer')[-1][2])
        self.assertIn('100', self.effects('steer')[-1][2])
        self.tick([], load=100, lag=8)
        self.assertEqual(len(self.effects('steer')), 3)
        self.tick([], load=100)
        self.assertEqual(len(self.effects('steer')), 3)
        skipped = self.events_named('worker_skipped')
        self.assertTrue(skipped)
        self.assertLessEqual(len(skipped), 11)

    def test_strain_clear_sends_one_final_without_launching(self):
        self.tick([], lag=8)
        self.tick([], lag=8)
        for _ in range(10):
            self.tick([])
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertEqual(len(self.effects('steer')), 1)
        self.assertIn('strain ended', self.effects('steer')[0][2])
        self.assertIn('300', self.effects('steer')[0][2])
        self.tick([])
        self.restart_guard()
        self.tick([])
        self.assertEqual(len(self.effects('steer')), 1)

    def test_strain_clear_does_not_launch_for_absent_or_ended_worker(self):
        for worker in ({}, dict(threadId='ended', startedAt=NOW)):
            with self.subTest(worker=worker):
                self.guard.strain, self.guard.since, self.guard.calm = True, self.now-300, 9
                self.guard.worker = worker
                self.host.worker = dict(state='idle', status='completed')
                self.tick([])
                self.assertFalse(self.effects('worker'))
                self.assertFalse(self.effects('steer'))

    def test_load_only_waits_ten_continuous_minutes(self):
        self.tick([], load=100)
        self.tick([], load=100)
        for _ in range(19):
            self.tick([], load=100)
        self.assertFalse(self.effects('worker'))
        self.tick([], load=100)
        self.assertEqual(len(self.effects('worker')), 1)
        self.tick([], load=100)
        self.assertFalse(self.effects('steer'))
        self.assertEqual(self.events_named('worker_skipped')[0]['reason'], 'load_only_wait')

    def test_load_only_additional_signal_launches_at_once(self):
        for _ in range(4):
            self.tick([], load=100)
        self.assertFalse(self.effects('worker'))
        self.tick([], load=100, lag=8)
        self.assertEqual(len(self.effects('worker')), 1)

    def test_load_only_calm_or_sampling_gap_restarts_wait(self):
        for gap in ('calm', 'missing'):
            with self.subTest(gap=gap):
                case = GuardTests()
                case.setUp()
                try:
                    for _ in range(10):
                        case.tick([], load=100)
                    if gap == 'calm':
                        case.tick([])
                    else:
                        case.now += 600
                    for _ in range(20):
                        case.tick([], load=100)
                    self.assertFalse(case.effects('worker'))
                    case.tick([], load=100)
                    self.assertEqual(len(case.effects('worker')), 1)
                finally:
                    case.doCleanups()

    def test_strain_dedupe_and_load_wait_survive_restart(self):
        for _ in range(10):
            self.tick([], load=100)
        self.restart_guard()
        for _ in range(11):
            self.tick([], load=100)
        self.assertFalse(self.effects('worker'))
        self.tick([], load=100)
        self.assertEqual(len(self.effects('worker')), 1)
        record = copy.deepcopy(self.guard.saved['strainWorker'])
        self.restart_guard()
        self.tick([], load=100)
        self.assertFalse(self.effects('steer'))
        self.assertEqual(self.guard.saved['strainWorker'], record)
        self.assertEqual(record['signals'], [1])
        self.assertTrue(Path(record['evidence']).exists())

    def test_urgent_incidents_bypass_strain_dedupe(self):
        self.guard.worker = dict(threadId='existing', startedAt=NOW)
        self.tick([], load=100)
        self.tick([], load=100)
        self.tick([proc(10, 'codex')], {10: 200}, load=100)
        self.assertEqual(len(self.effects('steer')), 2)
        self.assertIn('memory runaway', self.effects('steer')[-1][2])
        self.host.checks['hold'] = 'installer'
        self.tick([proc(1, ROBOB)], {1: 25}, load=100)
        self.assertEqual(len(self.effects('steer')), 3)
        self.assertIn('Robob restart skipped', self.effects('steer')[-1][2])

    def test_empty_signals_never_launch_in_calm_countdown(self):
        self.tick([], load=100)
        self.tick([], load=100)
        for _ in range(10):
            self.tick([])
        self.assertFalse(self.effects('worker'))
        self.assertFalse(self.effects('steer'))

    def test_running_worker_dedupe_survives_restart(self):
        self.guard.worker = dict(threadId='existing', startedAt=NOW)
        m.write_json(self.guard.state/'worker.json', self.guard.worker)
        self.tick([], lag=8)
        self.tick([], lag=8)
        self.restart_guard()
        for _ in range(19):
            self.tick([], lag=8)
        self.assertEqual(len(self.effects('steer')), 1)
        self.tick([], lag=8)
        self.assertEqual(len(self.effects('steer')), 2)

    def test_ambiguous_strain_send_reserved_before_restart(self):
        self.guard.worker = dict(threadId='existing', startedAt=NOW)
        m.write_json(self.guard.state/'worker.json', self.guard.worker)
        send = self.host.worker_send
        def lost_ack(*args):
            send(*args)
            raise m.ProbeError('timeout after delivery')
        with patch.object(self.host, 'worker_send', side_effect=lost_ack):
            self.tick([], lag=8)
            self.tick([], lag=8)
        self.restart_guard()
        self.tick([], lag=8)
        self.assertEqual(len(self.effects('steer')), 1)

    def test_load_only_gate_bypassed_by_offender_or_unknown_health(self):
        for mode in ('offender', 'lag_unknown', 'pressure_unknown'):
            with self.subTest(mode=mode):
                case = GuardTests()
                case.setUp()
                try:
                    for _ in range(2):
                        case.tick([], load=100, lag=None if mode == 'lag_unknown' else 0,
                                  pressure=None if mode == 'pressure_unknown' else 1)
                    if mode == 'offender':
                        case.guard.first_action = case.now-180
                        with patch.object(case.guard, 'cpu_actions', return_value=1):
                            case.tick([], load=100)
                    self.assertEqual(len(case.effects('worker')), 1)
                finally:
                    case.doCleanups()

    def test_load_only_gap_with_intermediate_save_restarts_wait(self):
        for save_path in ('restart_result', 'drain', 'restart'):
            with self.subTest(save_path=save_path):
                case = GuardTests()
                case.setUp()
                try:
                    for _ in range(10):
                        case.tick([], load=100)
                    case.now += 600
                    if save_path == 'restart_result':
                        case.guard.saved['restartPending'] = dict(log='unused', evidence=str(case.root))
                        case.host.restart_result = lambda pending: dict(ok=True)
                    elif save_path == 'drain':
                        case.guard.drain(case.now)
                    else:
                        case.guard.drain(case.now)
                        case.restart_guard()
                    for _ in range(20):
                        case.tick([], load=100)
                    self.assertFalse(case.effects('worker'))
                    case.tick([], load=100)
                    self.assertEqual(len(case.effects('worker')), 1)
                finally:
                    case.doCleanups()

    def test_load_only_interrupted_tick_restarts_wait_table(self):
        for restart in (False, True):
            for phase, gap in [('check_restart_result', 0), ('check_restart_result', 600),
                               ('cpu_actions', 0), ('cpu_actions', 600)]:
                with self.subTest(restart=restart, phase=phase, gap=gap):
                    case = GuardTests()
                    case.setUp()
                    try:
                        for _ in range(10):
                            case.tick([], load=100)
                        case.now += gap
                        case.guard.saved['restartPending'] = dict(log='unused', evidence=str(case.root))
                        case.host.restart_result = lambda pending: dict(ok=True)
                        original = getattr(case.guard, phase)
                        def interrupted(*args):
                            original(*args)
                            raise RuntimeError('tick interrupted after saved restart result')
                        with patch.object(case.guard, phase, side_effect=interrupted):
                            with self.assertRaises(RuntimeError):
                                case.tick([], load=100)
                        case.now += 30
                        if restart:
                            case.restart_guard()
                        for _ in range(20):
                            case.tick([], load=100)
                        self.assertEqual(len(case.effects('worker')), 0)
                        case.tick([], load=100)
                        self.assertEqual(len(case.effects('worker')), 1)
                    finally:
                        case.doCleanups()

    def test_strain_clear_delivery_failure_table(self):
        for failure in ('status', 'before_send', 'lost_ack', 'paused'):
            with self.subTest(failure=failure):
                case = GuardTests()
                case.setUp()
                try:
                    case.tick([], lag=8)
                    case.tick([], lag=8)
                    for _ in range(9):
                        case.tick([])
                    send = case.host.worker_send
                    requests = []
                    def deliver(tid, text, request_id=None):
                        requests.append(request_id)
                        if failure == 'lost_ack' or len(requests) > 1:
                            send(tid, text, request_id)
                        if len(requests) == 1:
                            raise m.ProbeError('send unavailable')
                    status_result = dict(side_effect=m.ProbeError('unavailable')) if failure == 'status' else dict(return_value=case.host.worker)
                    with patch.object(case.host, 'worker_send', side_effect=deliver), \
                         patch.object(case.host, 'worker_status', **status_result):
                        if failure == 'paused':
                            (case.guard.state/'paused').touch()
                        case.tick([])
                    case.restart_guard()
                    if failure == 'paused':
                        (case.guard.state/'paused').unlink()
                    # The successful retry uses the same identity after a lost ack.
                    def retry(tid, text, request_id=None):
                        requests.append(request_id)
                        send(tid, text, request_id)
                    with patch.object(case.host, 'worker_send', side_effect=retry):
                        case.tick([])
                        case.tick([])
                    self.assertEqual(len(case.effects('worker')), 1)
                    self.assertEqual(len(case.effects('steer')), 1)
                    self.assertIn('strain ended', case.effects('steer')[0][2])
                    self.assertTrue(requests[0])
                    self.assertEqual(len(set(requests)), 1)
                    case.restart_guard()
                    case.tick([])
                    self.assertEqual(len(case.effects('steer')), 1)
                finally:
                    case.doCleanups()

    def test_strain_clear_keeps_original_worker_after_replacement(self):
        self.tick([], lag=8)
        self.tick([], lag=8)
        tid = self.guard.worker['threadId']
        for _ in range(9):
            self.tick([])
        with patch.object(self.host, 'worker_status', side_effect=m.ProbeError('unavailable')):
            self.tick([])
        self.guard.worker = dict(threadId='replacement', startedAt=self.now)
        self.tick([])
        self.assertEqual(len(self.effects('steer')), 1)
        self.assertEqual(self.effects('steer')[0][1], tid)
        self.assertEqual(len(self.effects('worker')), 1)

    def test_strain_clear_waits_for_pending_initial_safety(self):
        self.tick([], lag=8)
        self.tick([], lag=8)
        tid = self.guard.worker['threadId']
        launch = copy.deepcopy(next(iter(self.host.initial_launches.values())))
        self.guard.worker = dict(launchUnknown=True, launch=launch, startedAt=NOW)
        jobs = []
        def submit(fn):
            future = Future()
            jobs.append((fn, future))
            return future
        self.guard.worker_submit = submit
        for _ in range(10):
            self.tick([])
        self.assertFalse(self.effects('steer'))
        self.assertTrue(any(k.startswith('strainClearResponder:') for k in self.guard.saved))
        self.guard.worker_submit = immediate_submit
        jobs[0][1].set_result(jobs[0][0]())
        self.tick([])
        self.assertEqual(self.guard.worker['threadId'], tid)
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertEqual(len(self.effects('steer')), 1)
        self.assertIn('strain ended', self.effects('steer')[0][2])

    def test_signal_four_nonprotected_growth(self):
        self.tick([proc(10)], {10: 5}, pressure=2)
        result = self.tick([proc(10)], {10: 6}, pressure=2)
        self.assertIn(4, result['signals'])
        self.tick([proc(10)], {10: 7}, pressure=2)
        self.assertEqual(self.effects('soften'), [('soften', 10)])

    def test_memory_growth_missing_top_breaks_history(self):
        self.tick([proc(10)], {10: 2})
        sample = snapshot([proc(10)])
        sample['top'] = None
        self.guard.tick(sample, self.now)
        self.now += 30
        self.tick([proc(10)], {10: 20})
        self.assertEqual(self.effects('signal'), [])

    def test_provider_installed_inside_robob_remains_session(self):
        self.tick([proc(1, ROBOB), proc(2, '/Applications/Robob.app/Contents/tools/codex', ppid=1)], {1: 3, 2: 200})
        self.assertEqual(self.effects('restart'), [])
        self.assertEqual(self.effects('signal'), [])

    def test_actions_eprem_is_logged_and_guard_keeps_running(self):
        with patch.object(self.host, 'signal', side_effect=PermissionError(1, 'EPERM')):
            self.tick([proc(10)], {10: 50})
        self.assertEqual(self.events_named('action')[0]['errno'], 1)
        self.assertFalse(self.guard.pending)

    def test_worker_unknown_status_never_creates_second(self):
        self.tick([proc(10, 'codex')], {10: 200})
        with patch.object(self.host, 'worker_status', side_effect=m.ProbeError('timeout')):
            self.tick([proc(11, 'codex')], {11: 200})
        self.assertEqual(len(self.effects('worker')), 1)

    def test_worker_failed_create_retries_same_correlation_after_absence(self):
        with patch.object(self.host, 'worker_create', side_effect=m.ProbeError('timeout')) as create:
            for i in range(3):
                self.tick([proc(10+i, 'codex')], {10+i: 200})
        self.assertEqual(create.call_count, 3)
        self.assertEqual(create.call_args_list[0], create.call_args_list[1])
        self.assertEqual(create.call_args_list[1], create.call_args_list[2])
        self.assertEqual(len(self.host.lookups), 2)
        self.assertTrue(json.loads((self.guard.state/'worker.json').read_text())['launchUnknown'])

    def test_worker_timeout_after_accept_adopts_after_restart(self):
        create = self.host.worker_create
        def accept_then_timeout(launch):
            create(launch)
            raise m.ProbeError('timeout')
        with patch.object(self.host, 'worker_create', side_effect=accept_then_timeout):
            self.tick([proc(10, 'codex')], {10: 200})
        request_id = self.guard.worker['launch']['clientRequestId']
        self.restart_guard()
        with patch.object(self.host, 'worker_create', side_effect=m.ProbeError('still slow')) as retry:
            self.tick([proc(11, 'codex')], {11: 200})
        retry.assert_not_called()
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertEqual(self.guard.worker['threadId'], m.worker_thread_id(request_id))
        self.assertEqual(len(self.effects('steer')), 1)
        self.assertEqual(self.events_named('worker_spawned')[-1]['result'], 'adopted')

    def test_worker_timeout_before_accept_retries_exact_payload_after_restart(self):
        with patch.object(self.host, 'worker_create', side_effect=m.ProbeError('timeout')):
            self.tick([proc(10, 'codex')], {10: 200})
        launch = copy.deepcopy(self.guard.worker['launch'])
        self.restart_guard()
        self.now += 86400
        with patch.object(self.host, 'worker_create', wraps=self.host.worker_create) as create:
            self.tick([proc(11, 'codex')], {11: 200})
        create.assert_called_once_with(launch)
        self.assertEqual(self.host.lookups, [launch['clientRequestId']])
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertEqual(len(self.effects('steer')), 1)
        self.assertIn('protected', self.effects('steer')[0][2])
        self.assertFalse(self.guard.worker.get('launchUnknown'))

    def test_worker_lookup_found_adopts_without_reposting(self):
        launch = dict(clientRequestId='mac-guard-existing', prompt='original safety prompt')
        self.guard.worker = dict(launchUnknown=True, launch=launch, startedAt=NOW)
        self.host.launches[launch['clientRequestId']] = m.worker_thread_id(launch['clientRequestId'])
        with patch.object(self.host, 'worker_create') as create:
            self.tick([], load=0)
        create.assert_not_called()
        self.assertEqual(self.guard.worker['threadId'], m.worker_thread_id(launch['clientRequestId']))
        self.assertEqual(self.events_named('worker_spawned')[-1]['result'], 'adopted')

    def test_partial_launch_retains_safety_until_acceptance_table(self):
        for report in (False, True):
            for accepted in (False, True):
                for recovery_failure in (None, 'before', 'after'):
                    for calm in (False, True):
                        with self.subTest(report=report, accepted=accepted, failure=recovery_failure, calm=calm):
                            case = GuardTests()
                            case.setUp()
                            try:
                                create = case.host.worker_create
                                def partial(launch):
                                    if accepted:
                                        create(launch)
                                    else:
                                        case.host.launches[launch['clientRequestId']] = m.worker_thread_id(launch['clientRequestId'])
                                    raise m.WorkerControlError('timeout')
                                if report:
                                    case.host.checks = dict(unavailable='disabled')
                                with patch.object(case.host, 'worker_create', side_effect=partial):
                                    case.tick([proc(1, ROBOB)] if report else [proc(10, 'codex')],
                                              {1: 25} if report else {10: 200})
                                launch = copy.deepcopy(case.guard.worker['launch'])
                                case.restart_guard()
                                method = 'worker_initial' if accepted else 'worker_resume'
                                initial = getattr(case.host, method)
                                def recover(value):
                                    self.assertEqual(value, launch)
                                    if recovery_failure != 'before':
                                        result = initial(value)
                                    if recovery_failure:
                                        raise m.WorkerControlError('timeout')
                                    return result
                                with patch.object(case.host, 'worker_create') as repost, \
                                     patch.object(case.host, method, side_effect=recover):
                                    case.tick([] if calm else [proc(11, 'codex')], {} if calm else {11: 200})
                                repost.assert_not_called()
                                if recovery_failure:
                                    self.assertTrue(case.guard.worker['launchUnknown'])
                                    self.assertEqual(case.guard.worker['launch'], launch)
                                    self.assertFalse(case.effects('steer'))
                                    if report:
                                        self.assertIn('restartResponder', case.guard.saved)
                                    case.restart_guard()
                                    case.tick([], {})
                                self.assertEqual(case.guard.worker['threadId'], m.worker_thread_id(launch['clientRequestId']))
                                self.assertEqual(len(case.effects('worker')), int(accepted))
                                self.assertEqual(len(case.effects('safety')), int(not accepted))
                                self.assertEqual(case.host.initial_launches[launch['clientRequestId']], launch)
                                if not accepted:
                                    self.assertEqual(case.effects('safety')[0][2], launch['prompt'])
                                if report:
                                    self.assertNotIn('restartResponder', case.guard.saved)
                            finally:
                                case.doCleanups()

    def test_sampling_and_strain_ladder_continue_while_launch_pending(self):
        jobs = []
        def submit(fn):
            future = Future()
            jobs.append((fn, future))
            return future
        self.guard.worker_submit = submit
        self.tick([], load=200, lag=8)
        self.tick([], load=200, lag=8)
        for i in range(4):
            result = self.tick([proc(10, cpu=i*60)], load=200)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(len(self.events_named('sample')), 5)
        self.assertTrue(result['strain'])
        self.assertIn(('soften', 10), self.host.effects)
        self.assertIn(('signal', 10, 'SIGSTOP'), self.host.effects)
        launch = copy.deepcopy(self.guard.worker['launch'])
        jobs[0][1].set_result(jobs[0][0]())
        self.tick([], load=0)
        self.assertEqual(self.guard.worker['threadId'], m.worker_thread_id(launch['clientRequestId']))
        self.assertEqual(len(jobs), 1)

    def test_pending_initial_safety_keeps_sampling_and_report(self):
        for report in (False, True):
            with self.subTest(report=report):
                case = GuardTests()
                case.setUp()
                try:
                    if report:
                        case.host.checks = dict(unavailable='disabled')
                    def partial(launch):
                        case.host.launches[launch['clientRequestId']] = m.worker_thread_id(launch['clientRequestId'])
                        raise m.WorkerControlError('timeout')
                    with patch.object(case.host, 'worker_create', side_effect=partial):
                        case.tick([proc(1, ROBOB)] if report else [proc(10, 'codex')],
                                  {1: 25} if report else {10: 200})
                    launch = copy.deepcopy(case.guard.worker['launch'])
                    jobs = []
                    def submit(fn):
                        future = Future()
                        jobs.append((fn, future))
                        return future
                    case.guard.worker_submit = submit
                    case.tick([], load=200)
                    jobs[0][1].set_result(jobs[0][0]())
                    case.tick([], load=200)
                    self.assertEqual(case.guard.worker_job['operation'], 'worker_initial')
                    samples = len(case.events_named('sample'))
                    for i in range(4):
                        result = case.tick([proc(10, cpu=i*60)], load=200)
                    self.assertTrue(result['strain'])
                    self.assertEqual(len(case.events_named('sample')), samples+4)
                    self.assertIn(('signal', 10, 'SIGSTOP'), case.host.effects)
                    self.assertEqual(len(jobs), 2)
                    self.assertEqual(case.guard.worker['launch'], launch)
                    self.assertFalse(case.effects('steer'))
                    self.assertFalse(case.effects('safety'))
                    if report:
                        self.assertIn('restartResponder', case.guard.saved)
                    jobs[1][1].set_result(jobs[1][0]())
                    case.tick([], load=0)
                    self.assertTrue(case.guard.worker['launchUnknown'])
                    self.assertEqual(case.guard.worker_job['operation'], 'worker_resume')
                    if report:
                        self.assertIn('restartResponder', case.guard.saved)
                    jobs[2][1].set_result(jobs[2][0]())
                    case.tick([], load=0)
                    self.assertEqual(case.guard.worker['threadId'], m.worker_thread_id(launch['clientRequestId']))
                    self.assertEqual(case.effects('safety')[0][2], launch['prompt'])
                    if report:
                        self.assertNotIn('restartResponder', case.guard.saved)
                finally:
                    case.doCleanups()

    def test_pause_during_initial_history_prevents_recovery(self):
        launch = dict(clientRequestId='mac-guard-partial', prompt='full safety prompt')
        self.guard.worker = dict(launchUnknown=True, launch=launch, startedAt=NOW)
        self.host.launches[launch['clientRequestId']] = m.worker_thread_id(launch['clientRequestId'])
        initial = self.host.worker_initial
        def pause(launch):
            result = initial(launch)
            (self.guard.state/'paused').touch()
            return result
        with patch.object(self.host, 'worker_initial', side_effect=pause), patch.object(self.host, 'worker_resume') as resume:
            self.tick([], load=0)
        resume.assert_not_called()
        self.assertTrue(self.guard.worker['launchUnknown'])
        self.assertEqual(self.guard.worker['launch'], launch)
        (self.guard.state/'paused').unlink()
        self.tick([], load=0)
        self.assertEqual(self.guard.worker['threadId'], m.worker_thread_id(launch['clientRequestId']))

    def test_default_executor_does_not_block_sampling(self):
        entered, release = threading.Event(), threading.Event()
        self.guard = m.Guard(self.host, self.root/'state', self.root/'evidence', dry=False,
                             logger=lambda c, k, n, **kw: self.events.append((n, kw['props'])), clock=lambda: self.now)
        create = self.host.worker_create
        def blocked(launch):
            entered.set()
            if not release.wait(10):
                raise TimeoutError()
            return create(launch)
        try:
            with patch.object(self.host, 'worker_create', side_effect=blocked):
                self.tick([], load=200, lag=8)
                self.tick([], load=200, lag=8)
                self.assertTrue(entered.wait(5))
                self.tick([], load=200)
                self.assertEqual(len(self.events_named('sample')), 2)
                self.assertTrue(self.guard.worker['launchUnknown'])
                release.set()
                self.guard.worker_job['future'].result(timeout=5)
                self.tick([], load=0)
                self.assertIn('threadId', self.guard.worker)
        finally:
            release.set()
            self.guard.worker_executor.shutdown(wait=True)

    def test_worker_lookup_failure_classes_and_backoff(self):
        launch = dict(clientRequestId='mac-guard-unknown', prompt='original')
        for failure in ('timeout', 'http_status', 'bad_response'):
            with self.subTest(failure=failure):
                self.guard.worker = dict(launchUnknown=True, launch=launch, startedAt=NOW)
                with patch.object(self.host, 'worker_lookup', side_effect=m.WorkerControlError(failure, 16.6, 503)), \
                     patch.object(self.host, 'worker_create') as create:
                    self.tick([], load=0)
                    self.guard.worker_needed(self.root, 'still needed', urgent=True)
                create.assert_not_called()
                self.assertTrue(self.guard.worker['launchUnknown'])
                event = self.events_named('worker_lookup')[-1]
                self.assertEqual(event['failure'], failure)
                self.assertEqual(event['durationS'], 16.6)
                self.assertEqual(event['errno'], 503)

    def test_worker_reconcile_unknown_never_creates_duplicate_then_recovers(self):
        with patch.object(self.host, 'worker_create', side_effect=m.ProbeError('timeout')):
            self.tick([proc(10, 'codex')], {10: 200})
        self.restart_guard()
        self.now += 86400
        with patch.object(self.host, 'worker_lookup', side_effect=m.ProbeError('timeout')), \
             patch.object(self.host, 'worker_create') as create:
            self.tick([proc(11, 'codex')], {11: 200})
        create.assert_not_called()
        self.tick([proc(12, 'codex')], {12: 200})
        self.assertEqual(len(self.effects('worker')), 1)

    def test_worker_late_accept_during_reconcile_uses_same_request(self):
        with patch.object(self.host, 'worker_create', side_effect=m.ProbeError('timeout')):
            self.tick([proc(10, 'codex')], {10: 200})
        launch = copy.deepcopy(self.guard.worker['launch'])
        def absent_then_late_accept(request_id):
            self.host.worker_create(launch)
            return None
        with patch.object(self.host, 'worker_lookup', side_effect=absent_then_late_accept):
            self.tick([proc(11, 'codex')], {11: 200})
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertEqual(len(self.host.launches), 1)

    def test_worker_reconcile_muted_does_nothing(self):
        with patch.object(self.host, 'worker_create', side_effect=m.ProbeError('timeout')):
            self.tick([proc(10, 'codex')], {10: 200})
        (self.guard.state/'paused').touch()
        with patch.object(self.host, 'worker_lookup') as lookup:
            self.tick([proc(11, 'codex')], {11: 200})
        lookup.assert_not_called()

    def test_orphan_term_pause_recovery_cancels_delayed_kill(self):
        rows = [proc(10, 'test-runner')]
        for _ in range(3):
            self.tick(rows, load=200)
        self.assertEqual(self.effects('signal'), [('signal', 10, 'SIGTERM')])
        (self.guard.state/'paused').touch()
        for _ in range(10):
            self.tick(rows)
        self.assertFalse(self.guard.strain)
        self.assertFalse(self.guard.pending)
        self.restart_guard()
        (self.guard.state/'paused').unlink()
        self.guard.drain(self.now)
        self.assertEqual(self.effects('signal'), [('signal', 10, 'SIGTERM')])
        self.assertEqual(self.events_named('action')[-1]['result'], 'cancelled_strain_clear')

    def test_queued_kill_class_recovery_restart_table(self):
        for cls in ('A', 'B', 'C', 'D'):
            for restart in (False, True):
                with self.subTest(cls=cls, restart=restart):
                    case = GuardTests()
                    case.setUp()
                    try:
                        case.tick([proc(10)], load=200)
                        case.tick([proc(10)], load=200)
                        case.guard.terminate([case.guard.rows[10]], cls)
                        old = copy.deepcopy(case.guard.pending)
                        (case.guard.state/'paused').touch()
                        for _ in range(10):
                            case.tick([proc(10)])
                        self.assertEqual(bool(case.guard.pending), cls == 'D')
                        if restart:
                            # Also tolerate stale pre-fix pending records loaded
                            # with a persisted calm state, before any fresh ps.
                            case.guard.pending = old
                            case.guard.save()
                            case.restart_guard()
                        (case.guard.state/'paused').unlink()
                        if cls == 'D' and restart:
                            case.tick([proc(10)])
                        case.guard.drain(case.now)
                        self.assertEqual(('signal', 10, 'SIGKILL') in case.effects('signal'), cls == 'D')
                    finally:
                        case.doCleanups()

    def test_pid_reuse_resets_growth(self):
        self.tick([proc(10)], {10: 2})
        self.tick([proc(10)], {10: 12})
        replacement = proc(10)
        replacement['start'] = 'Mon Nov 16 02:00:00 2026'
        self.tick([replacement], {10: 23})
        self.assertFalse(self.effects('signal'))

    def test_paused_pending_and_resume(self):
        self.tick([proc(10)], {10: 50})
        (self.guard.state/'paused').touch()
        self.guard.drain(self.now)
        self.assertEqual(len(self.effects('signal')), 1)
        self.assertEqual(len(self.guard.pending), 1)
        (self.guard.state/'paused').unlink()
        self.guard.drain(self.now)
        self.assertEqual(self.effects('signal')[-1], ('signal', 10, 'SIGKILL'))

    def test_persisted_state_never_contains_raw_credentials(self):
        self.tick([proc(10, args='burner --password hunter2')], {10: 50})
        saved = (self.guard.state/'state.json').read_text()
        self.assertNotIn('hunter2', saved)
        self.assertIn('argsHash', saved)

    def test_one_minute_sample_diagnostic_does_not_capture(self):
        rows = [proc(100+i, 'codex', state='R') for i in range(64)]
        for i in range(4):
            self.tick(rows, load=120, ticks=[i*300, 0, i*700, 0])
        self.assertFalse(self.effects('diagnostic'))

    def test_cua_driver_ignored_under_strain(self):
        for i in range(8):
            self.tick([proc(10, 'cua-driver', cpu=i*120)], load=200)
        self.assertFalse(self.effects('signal'))
        self.assertFalse(self.effects('soften'))

    def test_robob_descendant_cpu_ladder_softens_without_signals(self):
        for i in range(12):
            self.tick(robob_browser_tree(cpu=i*36), load=100, lag=8)
            self.guard.drain(self.now-20)
        self.assertIn(('soften', 11), self.host.effects)
        self.assertFalse(self.effects('signal'))
        self.assertFalse(self.guard.pending)
        self.assertFalse(self.guard.stopped)
        self.assertTrue(m.robob_descendant(self.guard.rows[11], self.guard.rows))
        self.assertFalse(m.robob(self.guard.rows[11], self.guard.rows))

    def test_robob_descendant_signal_classes(self):
        self.tick(robob_browser_tree(), load=100, lag=8)
        self.guard.strain = True
        for cls in ('A', 'B', 'C', 'D', 'G'):
            for action in ('STOP', 'CONT', 'TERM', 'KILL'):
                with self.subTest(cls=cls, action=action):
                    self.assertFalse(self.guard.action(self.guard.rows[11], cls, action))
                    row = self.events_named('action')[-1]
                    self.assertEqual(row['result'], 'cancelled_protection')
                    self.assertEqual(row['protectedBy'], 'robob-descendant')
                    self.assertIn(row['protectedAncestor']['pid'], (1, 2))
                    self.assertFalse(self.effects('signal'))
                    logged = toollog.record('mac-guard', 'event', 'macguard.action',
                                            dt.datetime.now(dt.timezone.utc), props=row)
                    self.assertEqual(logged['props']['protectedBy'], 'robob-descendant')
                    self.assertEqual(logged['props']['protectedAncestor']['pid'], row['protectedAncestor']['pid'])

    def test_provider_boundary_signal_classes(self):
        for command in ('claude', 'codex', 'opencode', 'gemini', 'cursor-agent', 'grok',
                        'antigravity', '/Users/test/.robob/harness-cli/claude/current/bin/claude',
                        'node /opt/@openai/codex/bin/codex.js'):
            for cls in ('A', 'B', 'C', 'D', 'G'):
                for action in ('STOP', 'CONT', 'TERM', 'KILL'):
                    with self.subTest(command=command, cls=cls, action=action):
                        self.setUp()
                        rows = robob_browser_tree('provider')
                        rows[2].update(comm=command.split()[0], args=command)
                        self.tick(rows, load=100, lag=8)
                        self.guard.strain = True
                        sent = self.guard.action(self.guard.rows[11], cls, action)
                        row = self.events_named('action')[-1]
                        self.assertNotIn('protectedBy', row)
                        self.assertNotIn('protectedAncestor', row)
                        self.assertEqual(sent, cls != 'G')
                        self.assertEqual(row['result'], 'cancelled_gui_authorization' if cls == 'G' else 'sent')
                        self.assertTrue(m.exempt(self.guard.rows[3], self.guard.rows))

    def test_live_safe_chain_job_below_claude_reaches_class_b_stop(self):
        self.host.owners[50812] = 'ended'
        for i in range(4):
            rows = [proc(80256, ROBOB),
                    proc(80622, 'node', ppid=80256, args='node apps/server/dist/bin.mjs --bootstrap-fd 3'),
                    proc(62309, '/Users/test/.robob/harness-cli/claude/current/bin/claude', ppid=80622),
                    proc(50001, 'zsh', ppid=62309, args='zsh -l'),
                    proc(50002, 'zsh', ppid=50001, args='zsh -c job'),
                    proc(50003, 'node', ppid=50002, args='node /opt/safe-chain/bin/safe-chain.js python3 probe.py'),
                    proc(50004, 'python3', ppid=50003, args='python3 probe.py'),
                    proc(50812, 'node', ppid=50004, args='node test.js', cpu=i*36)]
            self.tick(rows, load=113, lag=8)
        self.assertGreater(self.guard.rows[50812]['cpuDelta'], 100)
        self.assertIn(('signal', 50812, 'SIGSTOP'), self.effects('signal'))
        actions = [r for r in self.events_named('action') if r['pid'] == 50812]
        self.assertIn(('B', 'STOP', 'sent'), [(r['actionClass'], r['action'], r['result']) for r in actions])
        self.assertTrue(all('protectedBy' not in r and 'protectedAncestor' not in r for r in actions))
        self.assertFalse(m.robob_descendant(self.guard.rows[50812], self.guard.rows))

    def test_server_direct_mcp_and_checkpoint_are_signal_protected(self):
        for comm, args in [('node', 'node /opt/mcp/server.js'), ('git', 'git update-ref refs/checkpoints/test')]:
            with self.subTest(args=args):
                self.tick(robob_browser_tree()[:2] + [proc(12, comm, ppid=2, args=args)])
                self.guard.strain = True
                self.assertEqual(m.robob_ancestor(self.guard.rows[12], self.guard.rows)['pid'], 2)
                self.assertFalse(self.guard.action(self.guard.rows[12], 'D', 'TERM'))
                self.assertEqual(self.events_named('action')[-1]['protectedBy'], 'robob-descendant')
        self.assertFalse(self.effects('signal'))

    def test_memory_runaway_below_provider_uses_existing_carve_out(self):
        self.tick(robob_browser_tree('provider'), {11: 50})
        self.assertIn(('signal', 11, 'SIGTERM'), self.effects('signal'))
        self.assertEqual(self.events_named('memory_runaway')[0]['memoryClass'], 'carve-out')
        self.assertTrue(all('protectedBy' not in r for r in self.events_named('action')))

    def test_same_browser_binary_without_robob_ancestry_can_be_signalled(self):
        self.tick(robob_browser_tree('standalone'), load=100, lag=8)
        self.guard.strain = True
        self.assertFalse(m.robob_descendant(self.guard.rows[11], self.guard.rows))
        self.assertTrue(self.guard.action(self.guard.rows[11], 'B', 'STOP'))
        self.assertIn(('signal', 11, 'SIGSTOP'), self.effects('signal'))

    def test_robob_descendant_memory_runaway_is_report_only(self):
        self.tick(robob_browser_tree(), {11: 50})
        self.guard.drain(self.now+10)
        self.assertFalse(self.effects('signal'))
        self.assertFalse(self.guard.pending)
        self.assertEqual(self.events_named('memory_runaway')[0]['memoryClass'], 'protected')

    def test_live_agent_node_build_softened_only(self):
        self.host.owners[10] = 'live'
        for i in range(15):
            self.tick([proc(10, 'node', args='node run-build.js', cpu=i*60)], load=200)
        self.assertEqual(self.effects('soften'), [('soften', 10)])
        self.assertFalse(self.effects('signal'))

    def test_unknown_build_under_provider_softened_only(self):
        for i in range(15):
            self.tick([proc(1, 'codex'), proc(10, 'node', ppid=1, args='node task.js', cpu=i*60)], load=200)
        self.assertEqual(self.effects('soften'), [('soften', 10)])
        self.assertFalse(self.effects('signal'))

    def test_node_app_child_kind_matrix(self):
        # The desktop configuration identifies its node server with this flag;
        # other node children must use D, without restarting the app.
        for args, expected in [('node /server/bin.mjs --bootstrap-fd 3', True),
                               ('node build.js', False), ('node tools/worker.js', False),
                               ('node /tools/codex/bin/codex.js --bootstrap-fd 3', False)]:
            with self.subTest(args=args):
                rows = {1: proc(1, ROBOB), 10: proc(10, 'node', ppid=1, args=args)}
                self.assertEqual(m.robob(rows[10], rows), expected)

    def test_opencode_service_label_exempt_without_provider_name(self):
        rows = [proc(10, 'node', args='node server.js', label='com.ardud.opencode-service'),
                proc(20, 'node', ppid=10, args='node worker.js')]
        for _ in range(3):
            self.tick(rows, {20: 200}, load=200)
        self.assertFalse(self.effects('signal'))
        self.assertFalse(self.effects('soften'))
        self.assertTrue(all(e['action'] == 'protected_alert' for e in self.events_named('memory_runaway')))

    def test_signal_three_owner_state_matrix(self):
        for owner in ('live', 'ended', 'unknown'):
            with self.subTest(owner=owner):
                case = GuardTests()
                case.setUp()
                try:
                    case.host.owners[10] = owner
                    for _ in range(4):
                        result = case.tick([proc(10, 'codex', state='R')], load=32)
                    self.assertEqual(3 in result['signals'], owner == 'live')
                    self.assertEqual(result['strain'], owner == 'live')
                    self.assertFalse(case.effects('signal'))
                finally:
                    case.doCleanups()

    def test_build_and_browser_evidence_matrix(self):
        cases = [('xcodebuild', 'xcodebuild'), ('clang', 'clang'),
                 ('node', 'node scripts/build-desktop-artifact.ts'),
                 ('node', 'node build.js'), ('bun', 'bun scripts/test-suite.ts'),
                 ('agent-browser-darwin-arm64', 'agent-browser-darwin-arm64')]
        for comm, args in cases:
            with self.subTest(comm=comm, args=args):
                case = GuardTests()
                case.setUp()
                try:
                    for i in range(10):
                        case.tick([proc(10, comm, args=args, cpu=i*60, etime='00:02:00')], load=200)
                    self.assertEqual(case.effects('signal'), [])
                    for _ in range(4):
                        case.tick([proc(10, comm, args=args, cpu=540, etime='00:02:00')], load=200)
                    self.assertEqual(case.effects('signal'), [])
                finally:
                    case.doCleanups()

    def test_term_grace_from_actual_term_clock_for_a_and_d(self):
        for cls in ('A', 'D'):
            with self.subTest(cls=cls):
                case = GuardTests()
                case.setUp()
                try:
                    case.guard.clock = lambda: case.now+17
                    if cls == 'A':
                        case.host.builds[10] = dict(detached=True, stale=True)
                        for _ in range(3):
                            case.tick([proc(10, 'xcodebuild')], load=200)
                    else:
                        case.tick([proc(10)], {10: 50})
                    due = case.guard.pending[0]['due']
                    self.assertEqual(due, case.now-30+27)
                    case.guard.drain(due-1)
                    self.assertEqual(case.effects('signal'), [('signal', 10, 'SIGTERM')])
                    case.guard.drain(due)
                    self.assertEqual(case.effects('signal')[-1], ('signal', 10, 'SIGKILL'))
                finally:
                    case.doCleanups()

    def test_pause_created_during_overload_checks(self):
        checks = self.host.checks
        def checking():
            (self.guard.state/'paused').touch()
            return checks
        with patch.object(self.host, 'overload', side_effect=checking):
            self.tick([proc(1, ROBOB)], {1: 25})
        self.assertFalse(self.effects('restart'))
        self.assertFalse(self.effects('notify'))
        self.assertFalse(self.effects('worker'))
        self.assertEqual(self.events_named('robob_restart')[-1]['reason'], 'paused')

    def restart_guard(self):
        self.guard = m.Guard(self.host, self.root/'state', self.root/'evidence', dry=False,
                             logger=lambda c, k, n, **kw: self.events.append((n, kw['props'])), clock=lambda: self.now, worker_submit=immediate_submit)

    def test_stopped_survives_restart_and_failed_resume(self):
        for i in range(3):
            self.tick([proc(10, 'node', args='node worker.js --token SECRET', cpu=i*60)], load=200)
        self.assertIn(('signal', 10, 'SIGSTOP'), self.effects('signal'))
        self.restart_guard()
        self.tick([proc(10, 'node', args='node worker.js --token SECRET', cpu=120)], load=200)
        self.assertNotIn(('signal', 10, 'SIGCONT'), self.effects('signal'))
        for _ in range(9):
            self.tick([proc(10, 'node', args='node worker.js --token SECRET', cpu=120)])
        with patch.object(self.host, 'signal', side_effect=PermissionError(1, 'EPERM')):
            self.tick([proc(10, 'node', args='node worker.js --token SECRET', cpu=120)])
        self.assertEqual(len(self.guard.stopped), 1)
        self.tick([proc(10, 'node', args='node worker.js --token SECRET', cpu=120)])
        self.assertIn(('signal', 10, 'SIGCONT'), self.effects('signal'))
        self.assertEqual(self.guard.stopped, [])

    def test_hog_recovers_before_stop(self):
        self.tick([proc(10)], load=200)
        self.tick([proc(10, cpu=60)], load=200)
        for _ in range(10):
            self.tick([proc(10, cpu=60)], load=200)
        self.assertEqual(self.effects('soften'), [('soften', 10)])
        self.assertFalse(self.effects('signal'))

    def test_robob_tree_below_top_twenty(self):
        rows = [proc(100+i, '/System/Library/daemon') for i in range(20)]
        rows += [proc(1, ROBOB), proc(2, '/Applications/Robob.app/Contents/Frameworks/Robob Helper', ppid=1)]
        top = 'PID COMMAND MEM CMPRS\n'+''.join('%d system 30G 29G\n' % (100+i) for i in range(20))
        top += '1 Robob 12G 10G\n2 Robob Helper 13G 11G\n'
        sample = snapshot(rows)
        sample['top'] = m.parse_top(top)
        self.host.live = {p['pid']: p for p in rows}
        self.guard.tick(sample, self.now)
        self.assertEqual(len(self.effects('restart')), 1)
        evidence = next(self.guard.evidence.glob('*/snapshot.json'))
        packet = json.loads(evidence.read_text())
        self.assertEqual(len(packet['top']), 20)
        self.assertFalse(self.effects('signal'))

    def test_worker_terminal_with_pending_work_steers(self):
        self.tick([proc(10, 'codex')], {10: 200})
        self.host.worker = dict(state='idle', status='completed', pendingRequests=['queued'])
        self.tick([proc(11, 'codex')], {11: 200})
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertEqual(len(self.effects('steer')), 1)

    def test_attached_live_build_stale_metadata_kept(self):
        self.host.owners[10] = 'live'
        self.host.builds[10] = dict(detached=True, stale=True, root=10)
        for _ in range(5):
            self.tick([proc(20, 'codex'), proc(10, 'xcodebuild', ppid=20)], load=200)
        self.assertFalse(self.effects('signal'))

    def test_stop_cannot_become_class_a_stall(self):
        self.host.owners[10] = 'ended'
        for i in range(3):
            self.tick([proc(10, 'xcodebuild', cpu=i*60)], load=200)
        self.assertIn(('signal', 10, 'SIGSTOP'), self.effects('signal'))
        for _ in range(5):
            self.tick([proc(10, 'xcodebuild', cpu=120)], load=200)
        self.assertNotIn(('signal', 10, 'SIGTERM'), self.effects('signal'))
        self.tick([proc(10, 'xcodebuild', cpu=120)], load=200)
        self.assertEqual(self.effects('signal')[-1], ('signal', 10, 'SIGTERM'))
        self.assertEqual(self.events_named('action')[-1]['actionClass'], 'B')

    def test_stop_intent_survives_interruption_during_signal(self):
        class Interrupted(BaseException):
            pass
        for i in range(2):
            self.tick([proc(10, cpu=i*60)], load=200)
        real_signal = self.host.signal
        def interrupt(p, sig):
            real_signal(p, sig)
            if sig == signal.SIGSTOP:
                raise Interrupted()
        with patch.object(self.host, 'signal', side_effect=interrupt), self.assertRaises(Interrupted):
            self.tick([proc(10, cpu=120)], load=200)
        self.restart_guard()
        self.assertEqual(len(self.guard.stopped), 1)
        self.assertEqual(self.guard.hogs[(10, proc(10)['start'])]['stage'], 2)
        for _ in range(10):
            self.tick([proc(10, cpu=120)])
        self.assertIn(('signal', 10, 'SIGCONT'), self.effects('signal'))

    def test_stop_grace_survives_restart(self):
        for i in range(3):
            self.tick([proc(10, cpu=i*60)], load=200)
        stopped_at = self.guard.hogs[(10, proc(10)['start'])]['at']
        self.restart_guard()
        while self.now < stopped_at+180:
            self.tick([proc(10, cpu=120)], load=200)
            self.assertNotIn(('signal', 10, 'SIGTERM'), self.effects('signal'))
        self.tick([proc(10, cpu=120)], load=200)
        self.assertEqual(self.effects('signal')[-1], ('signal', 10, 'SIGTERM'))

    def test_stop_failure_rolls_back_recovery_intent(self):
        for i in range(2):
            self.tick([proc(10, cpu=i*60)], load=200)
        with patch.object(self.host, 'signal', side_effect=PermissionError(1, 'EPERM')):
            self.tick([proc(10, cpu=120)], load=200)
        self.assertFalse(self.guard.stopped)
        self.assertEqual(self.guard.hogs[(10, proc(10)['start'])]['stage'], 1)
        self.restart_guard()
        self.assertFalse(self.guard.stopped)

    def test_stop_interruption_delivery_table(self):
        class Interrupted(BaseException):
            pass
        for delivered in (False, True):
            with self.subTest(delivered=delivered):
                case = GuardTests()
                case.setUp()
                try:
                    for i in range(2):
                        case.tick([proc(10, cpu=i*60)], load=200)
                    real_signal = case.host.signal
                    def interrupt(p, sig):
                        if sig != signal.SIGSTOP or delivered:
                            real_signal(p, sig)
                        if sig == signal.SIGSTOP:
                            raise Interrupted()
                    with patch.object(case.host, 'signal', side_effect=interrupt), self.assertRaises(Interrupted):
                        case.tick([proc(10, cpu=120)], load=200)
                    case.restart_guard()
                    case.now += 30
                    observed_at = case.now
                    for _ in range(6):
                        case.tick([proc(10, cpu=120)], load=200)
                        self.assertNotIn(('signal', 10, 'SIGTERM'), case.effects('signal'))
                    self.assertEqual(case.now, observed_at+180)
                    case.tick([proc(10, cpu=120)], load=200)
                    if delivered:
                        self.assertEqual(case.effects('signal')[-1], ('signal', 10, 'SIGTERM'))
                    else:
                        self.assertFalse(case.effects('signal'))
                        case.tick([proc(10, cpu=120)], load=200)
                        case.guard.drain(case.now)
                        self.assertFalse(case.effects('signal'))
                finally:
                    case.doCleanups()

    def test_external_continue_requires_fresh_offender(self):
        for i in range(3):
            self.tick([proc(10, cpu=i*60)], load=200)
        self.host.suspended.clear()
        for _ in range(10):
            self.tick([proc(10, cpu=120)], load=200)
        self.assertEqual(self.effects('signal'), [('signal', 10, 'SIGSTOP')])
        self.assertEqual(self.guard.hogs[(10, proc(10)['start'])]['stage'], 1)
        self.restart_guard()
        self.assertEqual(len(self.guard.stopped), 1)

    def test_class_c_population_and_eligibility_table(self):
        # The packet counts all daemons, then filters victims by ppid and age.
        for old, attached, expected in [(11, 0, 11), (1, 10, 1), (1, 9, 0)]:
            with self.subTest(old=old, attached=attached):
                case = GuardTests()
                case.setUp()
                try:
                    rows = [proc(10+i, 'agent-browser-darwin-arm64') for i in range(old)]
                    rows += [proc(100+i, 'agent-browser-darwin-arm64', ppid=500, etime='00:02:00') for i in range(attached)]
                    case.tick(rows, load=200)
                    case.tick(rows, load=200)
                    self.assertEqual(len(case.effects('signal')), expected)
                    self.assertTrue(all(e[1] < 100 for e in case.effects('signal')))
                finally:
                    case.doCleanups()


class PlumbingTests(unittest.TestCase):
    def test_worker_request_isolated_bounded_and_inspector_free(self):
        calls = []
        def run(argv, **kw):
            calls.append((argv, kw))
            return subprocess.CompletedProcess(argv, 0, '{"ok": true}')
        with patch.dict(os.environ, BUN_INSPECT='1'):
            self.assertEqual(m.Host(run).worker_request('POST', '/threads', {'clientRequestId': 'test'}), {'ok': True})
        argv, kw = calls[0]
        self.assertEqual(argv, ['/usr/bin/python3', '-I', str(HERE/'mac_guard.py'), '--worker-control'])
        self.assertEqual(kw['timeout'], 50)
        self.assertNotIn('BUN_INSPECT', kw['env'])
        self.assertEqual(json.loads(kw['input']), dict(method='POST', path='/threads', body={'clientRequestId': 'test'}))
        for failure in (OSError(), subprocess.TimeoutExpired(argv, 10)):
            with self.subTest(failure=type(failure).__name__), self.assertRaises(m.ProbeError):
                m.Host(lambda *a, **kw: (_ for _ in ()).throw(failure)).worker_request('GET', '/threads/test')

    def test_slow_create_over_old_timeout_is_adopted(self):
        request_id = 'mac-guard-slow'
        tid = m.worker_thread_id(request_id)
        launch = dict(clientRequestId=request_id, prompt='test')
        calls = []
        def opener(req, timeout):
            calls.append(req.method)
            # Model the measured API latency without making every test wait.
            if timeout < 16.6:
                raise TimeoutError()
            return io.BytesIO(json.dumps(dict(threadId=tid, messageId=tid, runId='run')).encode())
        def run(argv, **kw):
            self.assertGreater(kw['timeout'], 45)
            value = m.worker_control(json.loads(kw['input']), opener)
            return subprocess.CompletedProcess(argv, 0, json.dumps(value))
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,
                {'T3_CONTROL_URL': 'http://test.invalid', 'T3_CONTROL_TOKEN': 'dummy'}, clear=True):
            guard = m.Guard(m.Host(run), Path(tmp)/'state', Path(tmp)/'evidence',
                            dry=False, logger=lambda *a, **kw: None, worker_submit=immediate_submit)
            guard.now = NOW
            guard.worker = dict(launchUnknown=True, launch=launch, startedAt=NOW)
            self.assertEqual(guard.launch_worker(Path(tmp)), tid)
            self.assertEqual(guard.worker['threadId'], tid)
        self.assertEqual(calls, ['POST'])

    def test_http_duration_and_failure_class_table(self):
        forms = [('timeout', lambda req: TimeoutError()),
                 ('timeout', lambda req: m.urllib.error.URLError(TimeoutError())),
                 ('http_status', lambda req: m.urllib.error.HTTPError(req.full_url, 503, 'test', {}, io.BytesIO(b'proxy'))),
                 ('bad_response', lambda req: None)]
        for failure, error in forms:
            with self.subTest(failure=failure), patch.dict(os.environ,
                    {'T3_CONTROL_URL': 'http://test.invalid', 'T3_CONTROL_TOKEN': 'dummy'}, clear=True):
                times = [0]
                def opener(req, **kw):
                    times[0] += 16.6
                    exc = error(req)
                    if exc:
                        raise exc
                    return io.BytesIO(b'not json')
                def run(argv, **kw):
                    metrics = {}
                    try:
                        value = m.worker_control(json.loads(kw['input']), opener, metrics)
                        return subprocess.CompletedProcess(argv, 0, json.dumps(dict(value, _durationS=metrics['durationS'])))
                    except (OSError, ValueError, m.ProbeError) as exc:
                        return subprocess.CompletedProcess(argv, 1, json.dumps(dict(failure=m.worker_failure(exc),
                            status=getattr(exc, 'status', None), _durationS=metrics['durationS'])))
                with patch.object(m.time, 'monotonic', side_effect=lambda: times[0]), \
                     self.assertRaises(m.WorkerControlError) as caught:
                    m.Host(run).worker_request('POST', '/threads')
                self.assertEqual(caught.exception.failure, failure)
                self.assertEqual(caught.exception.durationS, 16.6)

    def test_worker_helper_error_protocol_preserves_failure_class(self):
        for failure, status in [('timeout', None), ('http_status', 503), ('bad_response', None)]:
            with self.subTest(failure=failure):
                def run(argv, **kw):
                    return subprocess.CompletedProcess(argv, 1, json.dumps(dict(failure=failure, status=status)))
                with self.assertRaises(m.WorkerControlError) as caught:
                    m.Host(run).worker_request('POST', '/threads')
                self.assertEqual(caught.exception.failure, failure)
                self.assertEqual(caught.exception.status, status)

    def test_worker_correlation_response_shape_table(self):
        host = m.Host()
        request_id = 'mac-guard-test'
        tid = m.worker_thread_id(request_id)
        forms = [(dict(missing=True), None), (dict(thread=dict(threadId=tid)), tid),
                 (dict(threadId=tid), tid), (dict(thread=None), ValueError),
                 (dict(thread=[]), ValueError), (dict(thread=dict(threadId='other')), ValueError),
                 (dict(), ValueError), (dict(missing=False), ValueError)]
        for response, expected in forms:
            with self.subTest(response=response), patch.object(host, 'worker_request', return_value=response) as call:
                if expected is ValueError:
                    with self.assertRaises(ValueError):
                        host.worker_lookup(request_id)
                else:
                    self.assertEqual(host.worker_lookup(request_id), expected)
                call.assert_called_once_with('GET', '/threads/ardud-control%3Athread%3Amac-guard-test')
        launch = dict(clientRequestId=request_id, prompt='test')
        good = dict(threadId=tid, messageId=tid, runId='durable-run')
        forms = [good, dict(good, threadId='other'), dict(), dict(thread=dict(threadId=tid)),
                 dict(threadId=tid), dict(good, messageId=None), dict(good, messageId='other'),
                 dict(good, runId=None), dict(good, runId=''), dict(good, runId=True), dict(good, runId=[])]
        for response in forms:
            with self.subTest(create=response), patch.object(host, 'worker_request', return_value=response) as call:
                if response == good:
                    self.assertEqual(host.worker_create(launch), tid)
                else:
                    with self.assertRaises(ValueError):
                        host.worker_create(launch)
                call.assert_called_once_with('POST', '/threads', launch)

    def test_initial_message_history_acceptance_table(self):
        host = m.Host()
        launch = dict(clientRequestId='mac-guard-partial', prompt=' full safety prompt\n')
        tid = m.worker_thread_id(launch['clientRequestId'])
        good = dict(messageId=tid, role='user', text=launch['prompt'].strip(), runId='durable-run')
        forms = [('original', dict(threadId=tid, messages=[good], total=1)),
                 ('accepted in partial page', dict(threadId=tid, messages=[good], total=1001))]
        for name, response in forms:
            with self.subTest(name=name), patch.object(host, 'worker_request', return_value=response) as request:
                self.assertEqual(host.worker_initial(launch), tid)
                request.assert_called_once_with('GET', '/threads/'+m.urllib.parse.quote(tid, safe='')+'/messages?role=user&limit=1000')

        empty = dict(threadId=tid, messages=[], total=0)
        forms = [('wrong thread', dict(empty, threadId='other')),
                 ('missing thread', dict(messages=[], total=0))]
        forms += [('messages '+repr(value), dict(empty, messages=value)) for value in (None, False, '', {}, [None], [[]])]
        forms += [('total '+repr(value), dict(empty, total=value)) for value in (None, False, '0', -1, 0.5, 1)]
        forms += [('message '+key+' '+repr(value), dict(empty, messages=[dict(good, **{key: value})], total=1))
                  for key, values in [('role', (None, 'assistant')), ('text', (None, 'summary only')),
                                      ('runId', (None, '', False, []))] for value in values]
        for name, response in forms:
            with self.subTest(name=name), patch.object(host, 'worker_request', return_value=response) as request:
                with self.assertRaises(ValueError):
                    host.worker_initial(launch)
                self.assertEqual(request.call_count, 1)  # Unknown history cannot authorize a send.

    def test_initial_message_recovery_uses_original_launch_identity(self):
        host = m.Host()
        launch = dict(clientRequestId='mac-guard-partial', prompt=' full safety prompt\n')
        tid = m.worker_thread_id(launch['clientRequestId'])
        path = '/threads/'+m.urllib.parse.quote(tid, safe='')
        good = dict(threadId=tid, messageId=tid, runId='durable-run')
        forms = [good, dict(good, threadId='other'), dict(good, messageId=None), dict(good, messageId='other')]
        forms += [dict(good, runId=value) for value in (None, '', False, [])]
        for response in forms:
            with self.subTest(response=response), patch.object(host, 'worker_request', return_value=response) as request:
                if response == good:
                    self.assertEqual(host.worker_resume(launch), tid)
                else:
                    with self.assertRaises(ValueError):
                        host.worker_resume(launch)
                request.assert_called_once_with('POST', path+'/resume-launch', launch)

    def test_initial_message_recovery_lost_ack_with_real_template(self):
        host = m.Host()
        prompt = (HERE/'mac_guard_worker_prompt.md').read_text()
        self.assertTrue(prompt.endswith('\n'))
        launch = dict(clientRequestId='mac-guard-partial', prompt=prompt)
        tid = m.worker_thread_id(launch['clientRequestId'])
        messages = []
        sends = []
        def request(method, path, body=None):
            if method == 'GET':
                return dict(threadId=tid, messages=copy.deepcopy(messages), total=len(messages))
            sends.append((path, body))
            messages.append(dict(messageId=tid, role='user', text=body['prompt'].strip(), runId='durable-run'))
            raise m.WorkerControlError('timeout')
        with patch.object(host, 'worker_request', side_effect=request):
            self.assertIsNone(host.worker_initial(launch))
            with self.assertRaises(m.WorkerControlError):
                host.worker_resume(launch)
            self.assertEqual(host.worker_initial(launch), tid)
        self.assertEqual(sends, [('/threads/'+m.urllib.parse.quote(tid, safe='')+'/resume-launch', launch)])

    def test_worker_control_only_authoritative_absence_allows_retry(self):
        forms = [(404, b'{"ok":false,"error":{"code":"not_found"}}', True),
                 (404, b'{"error":{"code":"unavailable"}}', False),
                 (404, b'<html>proxy</html>', False), (401, b'{"error":{"code":"not_found"}}', False),
                 (500, b'{"error":{"code":"not_found"}}', False)]
        with patch.dict(os.environ, {'T3_CONTROL_URL': 'http://test.invalid/', 'T3_CONTROL_TOKEN': 'dummy'}, clear=True):
            for code, body, missing in forms:
                with self.subTest(code=code, body=body):
                    def opener(req, **kw):
                        raise m.urllib.error.HTTPError(req.full_url, code, 'test', {}, io.BytesIO(body))
                    if missing:
                        self.assertEqual(m.worker_control(dict(method='GET', path='/threads/test'), opener), dict(missing=True))
                    else:
                        with self.assertRaises((m.ProbeError, ValueError)):
                            m.worker_control(dict(method='GET', path='/threads/test'), opener)
            with self.assertRaises(m.ProbeError):
                m.worker_control(dict(method='POST', path='/threads'),
                                 lambda *a, **kw: (_ for _ in ()).throw(m.urllib.error.HTTPError(
                                     'http://test.invalid', 404, 'test', {}, io.BytesIO(forms[0][1]))))

    def test_worker_control_auth_payload_and_private_config_precedence(self):
        calls = []
        def opener(req, **kw):
            calls.append((req, kw))
            return io.BytesIO(b'{"ok":true,"threadId":"test"}')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            component = root/'.robob/components/t3ctl.json'
            component.parent.mkdir(parents=True)
            component.write_text(json.dumps(dict(url='http://component.invalid', token='component-dummy')))
            component.chmod(0o600)
            shared = root/'.robob/ardud-control.json'
            shared.write_text(json.dumps(dict(url='http://shared.invalid', token='shared-dummy')))
            shared.chmod(0o600)
            forms = [({}, 'component.invalid', 'component-dummy'),
                     ({'T3_CONTROL_TOKEN_FILE': str(shared)}, 'shared.invalid', 'shared-dummy'),
                     ({'T3_CONTROL_URL': 'http://env.invalid///', 'T3_CONTROL_TOKEN': 'env-dummy'}, 'env.invalid', 'env-dummy')]
            for env, hostname, token in forms:
                with self.subTest(env=env), patch.dict(os.environ, env, clear=True), patch.object(m.Path, 'home', return_value=root):
                    body = dict(clientRequestId='correlation', prompt='test')
                    self.assertEqual(m.worker_control(dict(method='POST', path='/threads', body=body), opener)['threadId'], 'test')
                    req, kw = calls[-1]
                    self.assertEqual(req.full_url, 'http://'+hostname+'/api/ardud/control/threads')
                    self.assertEqual(req.get_header('Authorization'), 'Bearer '+token)
                    self.assertEqual(json.loads(req.data), body)
                    self.assertEqual(kw['timeout'], 45)
            with patch.dict(os.environ, {'T3_CONTROL_TOKEN_FILE': str(root/'missing')}, clear=True), self.assertRaises(FileNotFoundError):
                m.worker_control(dict(method='GET', path='/threads/test'), opener)
            component.chmod(0o644)
            with patch.dict(os.environ, {}, clear=True), patch.object(m.Path, 'home', return_value=root), self.assertRaises(ValueError):
                m.worker_control(dict(method='GET', path='/threads/test'), opener)

    def test_isolated_helper_imports_reviewed_siblings(self):
        result = subprocess.run([sys.executable, '-I', str(HERE/'mac_guard.py'), '--help'],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--restart-check', result.stdout)

    def test_collect_uses_footprint_exact_ps_identity_and_bounds(self):
        calls = []
        p = proc(20, 'node', ppid=10, args='node next-server')
        def run(argv, **kw):
            calls.append((argv, kw))
            if argv == m.PS:
                text = '20 10 0:00.00 2048 S Mon Nov 16 00:00:00 2026 02:00:00 501 node\n'
            elif argv[0] == '/bin/ps':
                text = '20 '+p['start']+' node next-server\n'
            elif argv[0] == '/bin/launchctl':
                text = '10 0 com.ardud.router\n'
            elif argv[0] == '/usr/bin/top':
                text = 'PID COMMAND MEM CMPRS\n20 truncated 23G 22G\n'
            elif argv[-1] == 'vm.swapusage':
                text = 'total = 40G used = 39G'
            elif argv[0] == '/usr/sbin/sysctl':
                text = '2'
            else:
                text = json.dumps(dict(lag=dict(worstMs=8000)))
            return subprocess.CompletedProcess(argv, 0, text)
        with patch.object(m.os, 'getloadavg', return_value=(1, 2, 3)), \
             patch.object(m.os, 'cpu_count', return_value=16), patch.object(m, 'cpu_ticks', return_value=[1, 2, 3, 4]):
            value = m.Host(run).collect(0)
        self.assertEqual(value['top'][0]['memMb'], 23*1024)
        self.assertEqual(value['rows'][0]['comm'], 'node')
        self.assertEqual(value['rows'][0]['rssMb'], 2)
        self.assertEqual(value['lag'], 8)
        self.assertEqual([kw['timeout'] for argv, kw in calls if argv == m.PS], [20])
        self.assertEqual([kw['timeout'] for argv, kw in calls if argv[0] == '/usr/bin/top'], [10])
        self.assertTrue(all('-n' not in argv for argv, _ in calls if argv[0] == '/usr/bin/top'))
        self.assertTrue(all('BUN_INSPECT' not in kw['env'] for _, kw in calls))

    def test_launchagent_namespace_matrix(self):
        for namespace in ('com.abdullah.', 'com.ardud.', 'local.ardud.'):
            with self.subTest(namespace=namespace):
                def run(argv, **kw):
                    if argv == m.PS:
                        output = '10 1 0:00.00 2048 S Mon Nov 16 00:00:00 2026 02:00:00 501 node\n'
                    elif argv[0] == '/bin/launchctl':
                        output = '10 0 '+namespace+'service\n'
                    elif argv[0] == '/bin/ps':
                        output = '10 Mon Nov 16 00:00:00 2026 node worker.js\n'
                    elif argv[0] == '/usr/bin/top':
                        output = 'PID COMMAND MEM CMPRS\n10 node 1G 0G\n'
                    elif argv[-1] == 'vm.swapusage':
                        output = 'total = 4G used = 0G'
                    else:
                        output = '1'
                    return subprocess.CompletedProcess(argv, 0, output)
                with patch.object(m, 'cpu_ticks', return_value=[1, 2, 3, 4]):
                    sample = m.Host(run).collect(1)
                parent = sample['rows'][0]
                child = proc(20, 'node', ppid=10, args='node child.js')
                self.assertTrue(m.protected(child, {10: parent, 20: child}))

    def test_current_ps_schema_preserves_full_comm_paths_and_uid(self):
        comms = ['node', '/Applications/Robob.app/Contents/MacOS/Robob',
                 '/System/Library/CoreServices/System Utility', '/Users/ardud/bin/with spaces']
        def run(argv, **kw):
            if argv == m.PS:
                output = '\n'.join('%s 1 0:00.00 2048 S Mon Nov 16 00:00:00 2026 02:00:00 %s %s' %
                                   (20+i, 501+i, comm) for i, comm in enumerate(comms))
            elif argv[0] == '/bin/ps':
                output = '\n'.join('%s Mon Nov 16 00:00:00 2026 %s' % (20+i, comm) for i, comm in enumerate(comms))
            elif argv[0] == '/bin/launchctl':
                output = ''
            elif argv[0] == '/usr/bin/top':
                output = 'PID COMMAND MEM CMPRS\n20 node 1G 0G\n'
            else:
                output = 'total = 4G used = 0G' if argv[-1] == 'vm.swapusage' else '1'
            return subprocess.CompletedProcess(argv, 0, output)
        with patch.object(m, 'cpu_ticks', return_value=[1, 2, 3, 4]):
            sample = m.Host(run).collect(1)
        self.assertEqual([(p['uid'], p['comm']) for p in sample['rows']], list(zip(range(501,505), comms)))

    def test_provider_wrapper_forms(self):
        forms = [
            ('node', 'node '+'--flag '*12+'/tools/@openai/codex/bin/codex.js'),
            ('node', 'node --eval "require(\"provider\")"'),
            ('bun', 'bun --eval "run()"'),
            ('zsh', 'zsh -c "codex app-server"'),
            ('grok', 'grok'), ('antigravity', 'antigravity'),
            ('node', 'node /tools/grok/bin/grok.js'),
            ('bun', 'bun /tools/antigravity/cli.js'),
        ]
        for comm, args in forms:
            with self.subTest(comm=comm, args=args):
                self.assertTrue(m.provider(proc(10, comm, args=args)))
        self.assertFalse(m.provider(proc(10, 'node', args='node next-server')))

    def test_worker_protocol_input_shapes(self):
        forms = [None, [], 'running', 42, False, dict(thread=None), dict(thread=[])]
        for body in forms:
            with self.subTest(body=body):
                run = lambda argv, **kw: subprocess.CompletedProcess(argv, 0, json.dumps(body))
                with self.assertRaises(ValueError):
                    m.Host(run).worker_status('worker-1')
        for body in [dict(state='running'), dict(thread=dict(state='running'))]:
            run = lambda argv, **kw: subprocess.CompletedProcess(argv, 0, json.dumps(body))
            self.assertEqual(m.Host(run).worker_status('worker-1')['state'], 'running')

    def test_ended_owner_is_revalidated_before_escalation(self):
        import types
        host = m.Host()
        host.owner_deadline = m.time.monotonic()+60
        p = proc(10, 'xcodebuild')
        ended = dict(state='idle', status='completed', settled=True, activeRunId=None,
                     pendingRequests=[], threadId='owner')
        live = dict(state='running', threadId='owner')
        fake = types.SimpleNamespace(native_binding=lambda pid: dict(T3_THREAD_ID='owner'))
        with patch.dict(sys.modules, leftover_processes=fake), patch.object(host, 'worker_status', side_effect=[ended, live]) as status_read:
            self.assertEqual(host.ownership(p, {10: p}, NOW)['state'], 'ended')
            self.assertEqual(host.ownership(p, {10: p}, NOW+30)['state'], 'live')
            self.assertEqual(status_read.call_count, 2)
        host.owner_cache[(10, p['start'])] = (NOW, dict(state='ended', bound=True))
        host.owner_deadline = 0
        self.assertEqual(host.ownership(p, {10: p}, NOW+30), dict(state='unknown', bound=True))

    def test_live_status_worker_protocol_table(self):
        forms = [(None, 'unknown: owner'), ([], 'unknown: owner'),
                 (dict(thread=None), 'unknown: owner'), (dict(thread=[]), 'unknown: owner'),
                 (dict(state='idle', status='completed'), None),
                 (dict(state='idle', status='completed', pendingRequests=['queued']), 'owner'),
                 (dict(state='running'), 'owner')]
        with tempfile.TemporaryDirectory() as tmp, patch.object(status.Path, 'home', return_value=Path(tmp)):
            path = Path(tmp)/'.local/state/mac-guard/worker.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(dict(threadId='owner')))
            for body, expected in forms:
                with self.subTest(body=body):
                    run = lambda argv, **kw: subprocess.CompletedProcess(argv, 0, json.dumps(body))
                    self.assertEqual(status.guard_worker(run), expected)
            path.write_text('[]')
            self.assertEqual(status.guard_worker(), 'unknown')

    def test_restart_command_exact(self):
        calls = []
        def run(argv, **kw):
            calls.append((argv, kw))
            return subprocess.CompletedProcess(argv, 0, '')
        with tempfile.TemporaryDirectory() as tmp, patch.object(m, 'OVERLOAD_SCRIPT', Path(tmp)/'robob-overload-restart.py'), patch.object(m, 'OVERLOAD_STATE', Path(tmp)/'state'):
            m.OVERLOAD_SCRIPT.touch()
            (m.OVERLOAD_SCRIPT.parent/'launchd-entry.zsh').touch()
            m.Host(run).restart(Path('/safe/restart.log'), 'abc123')
            entry = str(m.OVERLOAD_SCRIPT.parent/'launchd-entry.zsh')
        argv, kw = calls[0]
        self.assertEqual(argv[:7], [m.TMUX, '-L', 'restart', 'new-session', '-d', '-s', 'mac-guard-restart'])
        self.assertIn('/bin/zsh -f '+entry+' restart abc123 > /safe/restart.log 2>&1', argv[7])
        self.assertEqual(kw['timeout'], 20)

    def test_identity_and_exec_reuse(self):
        p = proc(10, 'node', args='node worker.js')
        outputs = [p['start']+' node', p['start']+' node /tools/codex/bin/codex.js']
        host = m.Host(lambda argv, **kw: subprocess.CompletedProcess(argv, 0, outputs.pop(0)))
        self.assertFalse(host.identity(p))

    def test_health_shape(self):
        self.assertEqual(m.health_lag(dict(lag=dict(worstMs=8000))), 8)

    def test_plist_installer_and_name_isolation(self):
        value = plistlib.loads((HERE/'launchd/com.abdullah.mac-guard.plist').read_bytes())
        self.assertEqual(value['ProcessType'], 'Interactive')
        self.assertTrue(value['KeepAlive'])
        self.assertTrue(value['RunAtLoad'])
        self.assertNotIn('StartInterval', value)
        src = (HERE/'mac_guard.py').read_text()
        self.assertNotIn('com.ardud.robob-guard', src)
        self.assertNotIn('.local/state/robob-guard', src)
        self.assertIn('mac_guard_worker_prompt.md', (HERE/'install.zsh').read_text())

    def test_logger_retains_details_and_redacts(self):
        row = toollog.record('mac-guard', 'event', 'macguard.memory_runaway', dt.datetime.now(dt.timezone.utc),
                props=dict(pid=10, start='Mon Nov 16 00:00:00 2026', comm='node', footprintGiB=200,
                           history=[dict(at=NOW, cpuS=3, footprintGiB=200)], action='protected_alert',
                           args='node worker.js --password abc123'))
        self.assertEqual(row['props']['pid'], 10)
        self.assertEqual(row['props']['history'][0]['footprintGiB'], 200)
        self.assertNotIn('abc123', json.dumps(row))

    def test_logger_preserves_full_worker_thread_identity(self):
        tid = 'thread:project:ardud-opencode-import%3Aproject%3A%2FVolumes%2FExternalSSD%2Ft3code-fork:'+'a'*120
        row = toollog.record('mac-guard', 'event', 'macguard.worker_spawned', dt.datetime.now(dt.timezone.utc),
                             props=dict(threadId=tid, evidence='/safe/evidence'))
        self.assertEqual(row['props']['threadId'], tid)

    def test_status_guard_24h(self):
        now = dt.datetime(2026, 11, 17, 12, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows = [dict(tool='mac', kind='event', ts='2026-11-17T11:00:00Z', name='macguard.sample', props=dict(strain=True)),
                    dict(tool='mac', kind='event', ts='2026-11-17T11:01:00Z', name='macguard.action', props=dict(result='sent')),
                    dict(tool='mac', kind='event', ts='2026-11-17T11:02:00Z', name='macguard.robob_restart', props=dict(result='launched'))]
            (root/'2026-11-17.ndjson').write_text(''.join(json.dumps(r)+'\n' for r in rows))
            result = status.report(now, root)
        self.assertEqual(result['guard']['actions24h'], 1)
        self.assertEqual(result['guard']['restarts24h'], 1)
        self.assertTrue(result['guard']['strain'])


def dry_replays():
    reports = {}
    for name in ('nov16-load', 'nov16-memory', 'robob-runaway'):
        case = GuardTests()
        case.setUp()
        try:
            case.guard.dry = True
            if name == 'nov16-load':
                rows = [proc(1, '/sbin/launchd', ppid=0), proc(10, ROBOB, state='R'), proc(2, 'codex', ppid=10, state='R'),
                        proc(3, 'python3', args='python3 msgs.py', label='com.abdullah.msgs', state='R'),
                        proc(100, 'xcodebuild', state='R'), proc(101, 'SWBBuildService', ppid=100, state='R')]
                rows += [proc(110+i, 'clang', ppid=101, state='R') for i in range(9)]
                rows += [proc(130+i, 'swift-frontend', ppid=101, state='R') for i in range(7)]
                rows += [proc(200+i, 'agent-browser-darwin-arm64') for i in range(42)]
                rows += [proc(400+i, 'codex', state='R') for i in range(128)]
                case.host.builds[100] = dict(detached=True, stale=True)
                for _ in range(9):
                    case.tick(rows, load=224, lag=8)
                    case.guard.drain(case.now-20)
            elif name == 'nov16-memory':
                rows = [proc(10, 'node', args='node cluster-supervisor.cjs', label='com.ardud.9router'),
                        proc(20, 'node', ppid=10, args='node next-server PORT=20128')]
                for gb in (2, 12.5, 23, 33.5):
                    case.tick(rows, {20: gb}, pressure=2)
                    case.guard.drain(case.now-20)
            else:
                for gb in (6, 18, 30):
                    case.tick([proc(1, ROBOB)], {1: gb})
            assert not case.host.effects, case.host.effects
            actions = [props for event, props in case.events if event in
                       ('macguard.action', 'macguard.memory_runaway', 'macguard.robob_restart',
                        'macguard.worker_spawned', 'macguard.worker_steered')]
            reports[name] = dict(actions=actions, realEffects=case.host.effects)
        finally:
            case.doCleanups()
    return reports


class ReplayTests(unittest.TestCase):
    def test_dry_replay_actions(self):
        reports = dry_replays()
        for report in reports.values():
            self.assertEqual(report['realEffects'], [])
        load = reports['nov16-load']['actions']
        self.assertTrue(any(a.get('pid') == 100 and a['action'] == 'TERM' for a in load))
        self.assertTrue(any(a.get('pid') == 101 and a['action'] == 'KILL' for a in load))
        self.assertFalse(any(a.get('pid') in (1, 2, 3, 10) and a.get('action') for a in load))
        memory = reports['nov16-memory']['actions']
        self.assertEqual({a['pid'] for a in memory if a.get('actionClass') == 'D'}, {20})
        self.assertTrue(any(a.get('footprintGiB') == 23 and a.get('memoryClass') == 'carve-out' for a in memory))
        restart = reports['robob-runaway']['actions']
        self.assertTrue(any(a.get('result') == 'skipped' and a['reason'] == 'dry_run' for a in restart))
        self.assertFalse(any(a.get('actionClass') for a in restart))


if __name__ == '__main__':
    if '--replay-report' in sys.argv:
        print(json.dumps(dry_replays(), indent=2))
    else:
        unittest.main()
