import copy
import datetime as dt
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import mac_guard as m
import status
import toollog

NOW = 1794873600
ROBOB = '/Applications/Robob.app/Contents/MacOS/Robob'


def proc(pid, comm='burner', ppid=1, cpu=0, args=None, state='S', **kw):
    return dict(pid=pid, ppid=ppid, start='Mon Nov 16 00:00:00 2026', comm=comm,
                args=args or comm, state=state, cpuS=cpu, rssMb=2, etime='02:00:00',
                family=Path(comm).name, **kw)


def snapshot(rows, footprints=None, load=0, pressure=1, lag=0, ticks=None):
    return dict(rows=rows, top=[dict(pid=pid, memMb=gb*1024, cmprsMb=gb*1000, command='truncated')
                              for pid, gb in (footprints or {}).items()], load=[load]*3, ncpu=16,
                lag=lag, pressure=pressure, swap=dict(usedMb=39000, totalMb=40000), ticks=ticks)


class FakeHost:
    def __init__(self):
        self.effects = []
        self.live = {}
        self.owners = {}
        self.builds = {}
        self.worker = dict(state='running')
        self.checks = dict(pid=1, started=NOW-3600, hold=None, restart=False, install=False, building=[])

    def identity(self, p):
        q = self.live.get(p['pid'])
        return bool(q and q['start'] == p['start'] and q['comm'] == p['comm'] and q['args'] == p['args'])

    def same_birth(self, p):
        q = self.live.get(p['pid'])
        return bool(q and q['start'] == p['start'])

    def signal(self, p, sig):
        self.effects.append(('signal', p['pid'], signal.Signals(sig).name))

    def soften(self, p):
        self.effects.append(('soften', p['pid']))

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

    def restart(self, log):
        self.effects.append(('restart', str(log)))

    def worker_status(self, tid):
        return self.worker

    def worker_send(self, tid, text):
        self.effects.append(('steer', tid, text))

    def worker_create(self, prompt, now):
        self.effects.append(('worker', prompt))
        return 'critical-worker-1'

    def diagnostic(self, path):
        self.effects.append(('diagnostic', str(path)))


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.host = FakeHost()
        self.events = []
        self.guard = m.Guard(self.host, self.root/'state', self.root/'evidence', dry=False,
                             logger=lambda c, k, n, **kw: self.events.append((n, kw['props'])))
        self.now = NOW

    def tick(self, rows, footprints=None, **kw):
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
        rows = [proc(1, ROBOB, state='R'), proc(2, 'codex', ppid=1, state='R'),
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
        self.assertTrue(all(p not in {1, 2, 3} for _, p, _ in signals))
        self.assertEqual({p for _, p, sig in signals if 200 <= p < 242 and sig == 'SIGTERM'}, set(range(200, 242)))
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertGreaterEqual(len(self.effects('steer')), 1)

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
        self.assertEqual(len(self.effects('worker')), 1)

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

    def test_worker_ambiguous_create_never_retries(self):
        with patch.object(self.host, 'worker_create', side_effect=m.ProbeError('timeout')) as create:
            for i in range(3):
                self.tick([proc(10+i, 'codex')], {10+i: 200})
        self.assertEqual(create.call_count, 1)
        self.assertTrue(json.loads((self.guard.state/'worker.json').read_text())['launchUnknown'])

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


class PlumbingTests(unittest.TestCase):
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
                text = '20 10 0:00.00 2048 S Mon Nov 16 00:00:00 2026 02:00:00 node\n'
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
        self.assertTrue(all('BUN_INSPECT' not in kw['env'] for _, kw in calls))

    def test_restart_command_exact(self):
        calls = []
        def run(argv, **kw):
            calls.append((argv, kw))
            return subprocess.CompletedProcess(argv, 0, '')
        m.Host(run).restart(Path('/safe/restart.log'))
        argv, kw = calls[0]
        self.assertEqual(argv[:8], [m.TMUX, '-L', 'restart', 'new-session', '-d', '-s', 'robob-restart', argv[7]])
        self.assertIn('/usr/bin/python3 -I '+str(m.OVERLOAD_SCRIPT)+' restart 2>&1 | /usr/bin/tee -a /safe/restart.log', argv[7])
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
                rows = [proc(1, ROBOB, state='R'), proc(2, 'codex', ppid=1, state='R'),
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
        self.assertFalse(any(a.get('pid') in (1, 2, 3) and a.get('action') for a in load))
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
