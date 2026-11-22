import copy
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import guard_reclaim as r
import mac_guard as m
import toollog
from test_mac_guard import FakeHost, Future, immediate_submit, proc, NOW


def stamp(now):
    return dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def event(now, phase='onset', onset=None):
    return dict(name='host.overload', ts=stamp(now), props=dict(phase=phase, onset=stamp(onset or now), durationS=now-(onset or now), conditions=['swap']))


def latest(now, phase='onset', onset=None):
    return {'host.overload': event(now, phase, onset),
            'host.families_lite': dict(ts=stamp(now), props=dict(families=[dict(name='python', count=11)])),
            'host.vitals': dict(ts=stamp(now), props=dict(pressureLevel=2, swapUsedBytes=1000))}


def nproc(pid=20, comm='/opt/homebrew/bin/node', args='node /clone/node_modules/typescript/bin/tsc --noEmit', **kw):
    return proc(pid, comm, **dict(dict(uid=os.getuid(), args=args, start=[NOW, 0]), **kw))


class Native:
    def __init__(self):
        self.rows = {20:nproc()}
        self.effects = []
        self.rss_value = 3000
        self.fail_rss = False

    def census(self):
        return copy.deepcopy(self.rows), dict(partial=False)

    def rss(self, rows):
        if self.fail_rss:
            raise OSError('counters failed')
        return {pid:self.rss_value for pid in rows}

    def soften(self, p):
        self.effects.append(p['pid'])
        return dict(result='sent', niceBefore=0, niceAfter=10)


class ReclaimTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.host, self.native = FakeHost(), Native()
        self.events = []
        self.now = NOW
        self.guard = m.Guard(self.host, root/'state', root/'evidence', dry=False, clock=lambda:self.now,
            logger=lambda c,k,n,**kw:self.events.append((n,kw['props'])), worker_submit=immediate_submit)
        self.janitor_calls = 0
        self.reclaim = r.Reclaimer(self.guard, root/'logs', self.native, self.janitor)

    def janitor(self):
        self.janitor_calls += 1
        return dict(result='completed')

    def tick(self, now=None, phase='onset', onset=None):
        self.now = now or self.now
        self.reclaim.tick(self.now, latest(self.now, phase, onset))

    def test_onset_census_worker_and_summary_next_vitals(self):
        self.tick()
        self.assertEqual(self.janitor_calls, 1)
        self.assertEqual(self.native.effects, [20])
        census = json.loads(next(self.guard.evidence.glob('*/census.json')).read_text())
        self.assertEqual(census['trigger'], event(NOW))
        self.assertEqual(census['families']['props']['families'][0]['count'], 11)
        self.assertEqual(list(census['steps']), ['janitor','gui','renice'])
        self.assertIn('offbox', census['neverTouch'][0])
        self.assertTrue(any(e[0]=='worker' and 'census.json' in e[1] for e in self.host.effects))
        summary = self.events[-1][1]
        self.assertTrue(summary['workerStarted'])
        self.assertEqual(summary['before']['swapUsedBytes'], 1000)
        self.assertIsNone(summary['after'])
        self.tick(NOW+30, 'end', NOW)
        after = next(p for n,p in self.events if p.get('result')=='next-vitals')
        self.assertEqual(after['after']['pressureLevel'], 2)
        self.assertNotIn('pendingSummary', self.reclaim.state)
        self.assertIn('next-vitals', (self.guard.state/'guard.log').read_text())

    def test_dedup_rate_limit_persisted_across_restart(self):
        self.tick()
        self.tick()
        self.tick(NOW+1199)
        self.reclaim = r.Reclaimer(self.guard, self.reclaim.root, self.native, self.janitor)
        self.tick(NOW+1199)
        self.assertEqual(self.janitor_calls, 1)
        self.tick(NOW+1200)
        self.assertEqual(self.janitor_calls, 2)

    def test_peak_requires_same_episode_twenty_minutes_and_low_freed(self):
        self.tick()
        self.tick(NOW+600, 'peak', NOW)
        self.assertEqual(self.janitor_calls, 1)
        self.tick(NOW+1200, 'peak', NOW)
        self.assertEqual(self.janitor_calls, 2)
        self.reclaim.state['freedRssMb'] = 1024
        self.tick(NOW+2400, 'peak', NOW)
        self.assertEqual(self.janitor_calls, 2)
        self.reclaim.state['freedRssMb'] = 0
        self.tick(NOW+2401, 'peak', NOW-1)
        self.assertEqual(self.janitor_calls, 2)

    def test_rate_limited_peak_retries_with_offset_sampler_and_guard(self):
        cases = [
            ('aligned', 0, 1200, False, None, 2),
            ('before-deadline', 20, 1219, False, None, 1),
            ('at-deadline', 20, 1220, False, None, 2),
            ('next-tick', 20, 1230, False, None, 2),
            ('after-restart', 20, 1230, True, None, 2),
            ('freshness-boundary', 180, 1380, False, None, 2),
            ('expired', 180, 1381, False, None, 1),
            ('ended', 20, 1230, False, 'end', 1),
            ('enough-reclaimed', 20, 1230, False, 'freed', 1),
            ('other-episode', 20, 1230, False, 'other', 1),
        ]
        for name, delay, retry, restart, gate, expected in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                calls = []
                guard = m.Guard(FakeHost(), root/'state', root/'evidence', dry=False,
                    clock=lambda:self.now, logger=lambda *a,**kw:None, worker_submit=immediate_submit)
                janitor = lambda:calls.append(self.now) or dict(result='completed')
                native = Native()
                reclaim = r.Reclaimer(guard, root/'logs', native, janitor)
                self.now = NOW+delay
                reclaim.tick(self.now, latest(NOW))
                self.assertEqual(calls, [self.now])
                if gate == 'freed':
                    reclaim.state['freedRssMb'] = 1024
                    reclaim.save()
                peak = latest(NOW+1200, 'peak', NOW-1 if gate == 'other' else NOW)
                self.now = NOW+1200
                reclaim.tick(self.now, peak)
                self.assertEqual(len(calls), 2 if delay == 0 else 1)
                if restart:
                    reclaim = r.Reclaimer(guard, reclaim.root, native, janitor)
                if gate == 'end':
                    self.now = NOW+1210
                    reclaim.tick(self.now, latest(self.now, 'end', NOW))
                self.now = NOW+retry
                reclaim.tick(self.now, peak)
                self.assertEqual(len(calls), expected)
                self.now += 0.1
                reclaim.tick(self.now, peak)
                self.assertEqual(len(calls), expected)

    def test_end_stale_future_and_bad_onsets_do_nothing(self):
        for value in (event(NOW, 'end'), event(NOW-181), event(NOW+1),
                      dict(name='host.overload', ts=stamp(NOW), props=dict(phase='onset', onset='bad'))):
            self.reclaim.tick(NOW, {'host.overload':value})
        self.assertEqual(self.janitor_calls, 0)

    def test_pause_and_dry_run_suppress_all_actions_and_worker(self):
        pause = self.guard.state/'paused'
        pause.touch()
        self.tick()
        pause.unlink()
        self.guard.dry = True
        self.tick()
        self.assertEqual(self.janitor_calls, 0)
        self.assertFalse(self.native.effects)
        self.assertFalse(self.host.effects)

    def test_janitor_timeout_and_rss_failure_still_deliver_worker(self):
        self.reclaim.janitor = lambda:dict(result='timeout')
        self.native.fail_rss = True
        self.tick()
        self.assertTrue(self.events[-1][1]['workerDelivered'])
        self.assertEqual(self.reclaim.state['freedRssMb'], 0)
        self.assertTrue(any(p.get('result')=='timeout' for n,p in self.events))

    def test_census_unavailable_does_not_require_ps_to_start_worker(self):
        self.native.census = lambda:(_ for _ in ()).throw(OSError('libproc unavailable'))
        self.tick()
        self.assertTrue(self.events[-1][1]['workerDelivered'])
        self.assertFalse(self.native.effects)

    def test_protected_matrix_never_softened_or_signalled(self):
        cases = [
            nproc(args='node /pkg/codex/bin/tsc'),
            nproc(comm='/Applications/Robob.app/Contents/MacOS/Robob', args='Robob tsc'),
            nproc(comm='/System/bin/tsc', args='tsc --noEmit'),
            nproc(comm='/usr/libexec/tsc', args='tsc --noEmit'),
            nproc(comm='/Applications/Dia.app/Contents/MacOS/Dia', args='Dia'),
            nproc(comm='/System/Applications/Messages.app/Contents/MacOS/Messages', args='Messages'),
            nproc(comm='/opt/homebrew/bin/tsc', args='tsc --noEmit', label='com.ardud.opencode-service'),
            nproc(comm='/opt/homebrew/bin/python3', args='python3 offbox.py _bg-queue'),
            nproc(comm='/opt/homebrew/bin/python3', args='python3 offbox.py wait x'),
            nproc(comm='/opt/homebrew/bin/python3', args='python3 /repo/mac-logging/host.py'),
            nproc(ppid=9999), nproc(uid=os.getuid()+1), nproc(args='node -e "tsc"'),
        ]
        for p in cases:
            with self.subTest(p=p):
                self.native.rows = {20:p}
                self.tick(self.now+1200)
        self.assertFalse(self.native.effects)
        self.assertFalse(any(e[0]=='signal' for e in self.host.effects))

    def test_release_build_below_provider_eligible_offbox_child_is_not(self):
        build = nproc(args='node /Users/a/.robob/release-builds/quickfix/clone/node_modules/typescript/bin/tsc --noEmit', ppid=30)
        provider = nproc(30, comm='/opt/homebrew/bin/codex', args='codex app-server')
        self.native.rows = {20:build,30:provider}
        self.tick()
        self.assertEqual(self.native.effects, [20])
        provider['args'] = 'python3 /tool/offbox.py _bg-queue'
        self.tick(NOW+1200)
        self.assertEqual(self.native.effects, [20])
        log = next(p for n,p in self.events if p.get('step')=='renice' and p.get('pid')==20)
        self.assertEqual(log['ancestors'][0]['pid'], 30)

    def test_rss_by_rung_and_peak_threshold(self):
        def janitor():
            self.native.rss_value = 1000
            return dict(result='completed')
        self.reclaim.janitor = janitor
        self.tick()
        self.assertEqual(self.reclaim.state['freedRssMb'], 2000)
        self.tick(NOW+1200,'peak',NOW)
        self.assertEqual(len(self.native.effects), 1)

    def test_worker_failure_logged_without_claiming_start(self):
        self.host.worker_create = lambda launch:(_ for _ in ()).throw(OSError('unavailable'))
        self.tick()
        self.assertFalse(self.events[-1][1]['workerStarted'])
        self.assertFalse(self.events[-1][1]['workerDelivered'])

    def test_gui_reuses_existing_rule_only_with_recent_footprint(self):
        self.guard.now = NOW
        self.guard.saved['lastSample'] = NOW
        gui = proc(40, '/Applications/Editor.app/Contents/MacOS/Editor', footprintGiB=12, growthGiBHour=2, footprintObservedAt=NOW)
        self.guard.rows = {40:gui}
        called = []
        self.guard.slow_actions = lambda leaks:called.extend(leaks)
        self.tick()
        self.assertEqual(called, [gui])
        self.tick(NOW+1200)
        self.assertEqual(len(called), 1)

    def test_schema_preserves_evidence_and_redacts_credentials(self):
        self.tick()
        for n, p in self.events:
            if n == 'guard.reclaim':
                row = toollog.record('mac-guard', 'event', n, dt.datetime.now(dt.timezone.utc), props=p)
                self.assertEqual(row['props'], p)
        self.assertNotIn('shortpass', json.dumps(r.log_fields(dict(args='curl --user bob:shortpass'))))

    def test_partial_worker_recovery_keeps_ladder_report_until_safety_accepted(self):
        def partial(launch):
            self.host.launches[launch['clientRequestId']] = m.worker_thread_id(launch['clientRequestId'])
            raise m.WorkerControlError('timeout')
        with patch.object(self.host, 'worker_create', side_effect=partial):
            self.tick()
        launch = copy.deepcopy(self.guard.worker['launch'])
        jobs = []
        def submit(fn):
            future = Future()
            jobs.append((fn, future))
            return future
        self.guard.worker_submit = submit
        self.tick(NOW+30, 'end', NOW)
        for i, operation in enumerate(('worker_lookup', 'worker_initial', 'worker_resume')):
            self.assertEqual(self.guard.worker_job['operation'], operation)
            self.assertEqual(self.guard.worker['launch'], launch)
            self.assertTrue(any(k.startswith('overloadResponder:') for k in self.guard.saved))
            self.assertFalse(any(e[0] in ('worker', 'safety', 'steer') for e in self.host.effects))
            jobs[i][1].set_result(jobs[i][0]())
            self.tick(NOW+60+i*30, 'end', NOW)
        self.assertEqual(self.guard.worker['threadId'], m.worker_thread_id(launch['clientRequestId']))
        self.assertFalse(any(k.startswith('overloadResponder:') for k in self.guard.saved))
        self.assertEqual(self.janitor_calls, 1)
        self.assertEqual(self.native.effects, [20])
        self.assertEqual(len(self.host.launches), 1)
        self.assertEqual([e[2] for e in self.host.effects if e[0] == 'safety'], [launch['prompt']])
        self.assertTrue(self.events[-1][1]['workerDelivered'])

    def test_ambiguous_worker_launch_retried_without_repeating_ladder(self):
        original = self.host.worker_create
        calls = []
        def create(launch):
            calls.append(launch['clientRequestId'])
            result = original(launch)
            if len(calls) == 1:
                raise OSError('lost acknowledgment')
            return result
        self.host.worker_create = create
        self.tick()
        self.assertFalse(self.events[-1][1]['workerDelivered'])
        self.tick(NOW+30,'end',NOW)
        self.assertEqual(len(set(calls)),1)
        self.assertEqual(self.janitor_calls,1)
        self.assertFalse(any(k.startswith('overloadResponder:') for k in self.guard.saved))
        summary = next(p for n,p in self.events if p.get('result')=='next-vitals')
        self.assertTrue(summary['workerDelivered'])
        self.assertTrue(summary['workerStarted'])

    def test_responder_python_argv_shapes_niced_without_touching_provider(self):
        py = '/opt/homebrew/Cellar/python@3.15/3.15.2/Frameworks/Python.framework/Versions/3.15/Resources/Python.app/Contents/MacOS/Python'
        venv = '/Volumes/ExternalSSD/board-wt/crpko-integration-harness-HC-008b/.venv/bin/'
        self.native.rows = {
            7990:nproc(7990, comm=py, args=py+' -m unittest test_statev2_guard', ppid=20418, nice=0),
            56944:nproc(56944, comm=venv+'python', args=venv+'python '+venv+'pytest -k HC_008b', ppid=20418, nice=0),
            20418:nproc(20418, comm='/opt/homebrew/bin/claude', args='claude --print', nice=0)}
        self.tick()
        self.assertEqual(set(self.native.effects), {7990,56944})
        entries = [p for n,p in self.events if p.get('result')=='sent' and p.get('step')=='renice']
        self.assertEqual({p['pid'] for p in entries},{7990,56944})
        self.assertTrue(all(p['niceBefore']==0 and p['niceAfter']==10 for p in entries))

    def test_busy_wait_shell_named_in_census_never_acted_on(self):
        self.native.rows = {
            91870:nproc(91870, comm='/bin/zsh', ppid=20418, args='zsh -lc "while true; do read -t5 </dev/zero; done"', start=[NOW-120,0], cpuS=60),
            20418:nproc(20418, comm='/opt/homebrew/bin/claude', args='claude --print')}
        self.tick()
        census = json.loads(next(self.guard.evidence.glob('*/census.json')).read_text())
        shell = next(p for p in census['processes'] if p['pid']==91870)
        self.assertEqual(shell['family'],'busy-wait tool shell')
        self.assertEqual(shell['cpuPct'],50)
        self.assertEqual(shell['cpuBasis'],'lifetime')
        self.assertFalse(self.native.effects)
        self.assertFalse(any(e[0]=='signal' for e in self.host.effects))

    def test_empty_census_still_logs_all_rungs_and_summary(self):
        self.native.rows = {}
        self.tick()
        rows = [p for n,p in self.events if n=='guard.reclaim']
        self.assertTrue({'janitor','gui','renice','worker','summary'} <= {p['step'] for p in rows})
        self.assertTrue(any(p['result']=='nothing-to-do' for p in rows))
        self.assertTrue(rows[-1]['workerDelivered'])

    def test_slow_janitor_and_helper_saves_cannot_refresh_gui_footprint(self):
        gui = proc(40, '/Applications/Editor.app/Contents/MacOS/Editor', footprintGiB=12, growthGiBHour=2, footprintObservedAt=NOW-30)
        self.guard.rows = {40:gui}
        self.guard.saved['lastSample'] = NOW
        called = []
        self.guard.slow_actions = lambda leaks:called.extend(leaks)
        def janitor():
            self.now += 120
            # A worker-delivery save advances lastSample but not the footprint.
            self.guard.now = self.now
            self.guard.save()
            return dict(result='timeout')
        self.reclaim.janitor = janitor
        self.tick()
        self.assertFalse(called)
        self.assertEqual(self.guard.saved['lastSample'],NOW+120)
        self.assertTrue(self.events[-1][1]['workerDelivered'])

    def test_closed_episode_rejects_delayed_retry_after_reader_restart(self):
        self.tick()
        self.tick(NOW+1200, 'end', NOW)
        self.reclaim = r.Reclaimer(self.guard, self.reclaim.root, self.native, self.janitor)
        for phase,duration in (('onset',0),('peak',1800)):
            delayed = event(NOW+duration,phase,NOW)
            delayed['ts'] = stamp(NOW+1800)
            self.now = NOW+1800
            self.reclaim.tick(self.now, {'host.overload':delayed})
        self.assertEqual(self.janitor_calls,1)
        self.tick(NOW+1801)
        self.assertEqual(self.janitor_calls,2)

    def test_delayed_write_is_not_a_fresh_transition(self):
        for phase in ('onset','peak'):
            delayed = event(NOW,phase,NOW-1200 if phase=='peak' else NOW)
            delayed['ts'] = stamp(NOW+1200)
            self.now = NOW+1200
            self.reclaim.tick(self.now, {'host.overload':delayed})
        self.assertEqual(self.janitor_calls,0)


class InputTests(unittest.TestCase):
    def test_build_command_forms(self):
        cases = [
            ('node','node --max-old-space-size=8192 /repo/node_modules/typescript/bin/tsc --noEmit'),
            ('node','node --max-old-space-size 8192 /repo/node_modules/typescript/bin/tsc --noEmit'),
            ('python3.15','python3.15 -Im unittest discover'),
            ('pytest','pytest tests'),
            ('node','node node_modules/vitest/vitest.mjs run'),
            ('vp','vp test run some.test.ts'),
            ('vp','vp run typecheck'),
            ('node','node scripts/build-desktop-artifact.ts'),
            ('node','node --max-old-space-size=8192 scripts/build-desktop-artifact.ts'),
            ('python3','python3 /arbitrary/worktree/.venv/bin/pytest tests'),
            ('python3','python3 /arbitrary/worktree/.venv/bin/py.test tests'),
            ('tsc','tsc --noEmit'), ('node','node /repo/node_modules/typescript/bin/tsc --noEmit'),
            ('node','node /repo/node_modules/typescript/lib/tsc.js --noEmit'),
            ('vite','vite build'), ('node','node /repo/node_modules/vite/bin/vite.js build'),
            ('vp','vp build'), ('electron-builder','electron-builder --mac'),
            ('node','node /repo/node_modules/electron-builder/out/cli/cli.js --mac'),
            ('esbuild','esbuild input.ts'), ('webpack','webpack --mode production'),
            ('next','next build'), ('cargo','cargo build --release'), ('rustc','rustc foo.rs'),
            ('go','go build ./...'), ('go','go test ./...'), ('xcodebuild','xcodebuild -scheme App'),
            ('python3.15','python3.15 -I -m unittest discover'), ('python3','python3 -m pytest tests'),
            ('python3','python3 /repo/integrations/mac-logging/collector.py'),
        ]
        for comm,args in cases:
            with self.subTest(args=args):
                self.assertIsNotNone(r.heavy(nproc(comm=comm,args=args)))
        for comm,args in [('node','node server.js tsc'),('codex','codex --prompt "go build"'),
                          ('python3','python3 -c "tsc"'),('vite','vite dev'),('next','next start'),('go','go version')]:
            with self.subTest(args=args):
                self.assertIsNone(r.heavy(nproc(comm=comm,args=args)))

    def test_bounded_tail_partial_line_and_latest_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            day = dt.datetime.fromtimestamp(NOW, dt.timezone.utc).date().isoformat()
            path = root/(day+'.ndjson')
            path.write_text('x'*20000+'\n'+json.dumps(event(NOW))+'\n'+json.dumps(event(NOW+1,'end',NOW))+'\n')
            self.assertEqual(r.latest_rows(root,NOW+2,limit=2000)['host.overload']['props']['phase'],'end')

    def test_janitor_normal_locked_worker_hard_timeout(self):
        seen = []
        def run(argv,**kw):
            seen.append((argv,kw))
            raise subprocess.TimeoutExpired(argv,120)
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {'DEV_JANITOR_WATCH_STATE':str(Path(tmp)/'state')}):
                self.assertEqual(r.run_janitor(run,home=tmp)['result'],'timeout')
            self.assertEqual(seen[0][1]['timeout'],120)
            self.assertEqual(seen[0][0][-2],'worker')
            self.assertTrue(seen[0][1]['pass_fds'])

    def test_setpriority_identity_and_already_niced(self):
        native = object.__new__(r.Darwin)
        p = nproc()
        native.row = lambda pid:dict(p)
        with patch.object(os,'getpriority',return_value=15), patch.object(os,'setpriority') as setprio:
            self.assertEqual(native.soften(p)['niceAfter'],15)
            setprio.assert_called_once_with(os.PRIO_PROCESS,p['pid'],15)
        native.row = lambda pid:dict(p,start=[NOW,1])
        with patch.object(os,'setpriority') as setprio:
            self.assertEqual(native.soften(p)['result'],'identity-changed')
            setprio.assert_not_called()

    def test_old_paths_exempt_offbox_holders_and_children(self):
        holder = proc(10, 'python3', args='python3 /path/offbox.py _bg-queue')
        child = proc(11, 'python3', ppid=10, args='python3 test_x.py')
        for p in (holder,child):
            self.assertTrue(m.exempt(p,{10:holder,11:child}))
            self.assertTrue(m.protected(p,{10:holder,11:child}))


class JanitorEnvironmentTests(unittest.TestCase):
    def test_hourly_flags_and_log_override_share_lock(self):
        seen = []
        def run(argv, **kw):
            seen.append((argv,kw))
            lock_fd = int(argv[-1])
            import fcntl
            with (Path(kw['env']['DEV_JANITOR_LOG_DIR'])/'hourly/lock').open('a') as other:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
            os.fstat(lock_fd)
            return subprocess.CompletedProcess(argv,0)
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ,{'DEV_JANITOR_LOG_DIR':str(Path(tmp)/'custom')},clear=True):
                self.assertEqual(r.run_janitor(run,home=tmp)['result'],'completed')
            env = seen[-1][1]['env']
            self.assertEqual(env['DEV_JANITOR_REAP_AGENT_BROWSER'],'1')
            self.assertEqual(env['DEV_JANITOR_STOP_XCODE_BUILDS'],'1')
            self.assertNotIn('BUN_INSPECT',env)
            seen.clear()
            with patch.dict(os.environ,{'DEV_JANITOR_LOG_DIR':str(Path(tmp)/'custom'),
                    'DEV_JANITOR_WATCH_STATE':str(Path(tmp)/'override'),
                    'DEV_JANITOR_REAP_AGENT_BROWSER':'0','DEV_JANITOR_STOP_XCODE_BUILDS':'0'},clear=True):
                def explicit_run(argv,**kw):
                    seen.append(kw)
                    self.assertTrue((Path(tmp)/'override/lock').exists())
                    return subprocess.CompletedProcess(argv,0)
                r.run_janitor(explicit_run,home=tmp)
            self.assertEqual(seen[0]['env']['DEV_JANITOR_REAP_AGENT_BROWSER'],'0')
            self.assertEqual(seen[0]['env']['DEV_JANITOR_STOP_XCODE_BUILDS'],'0')

    def test_busy_read_spelling_matrix_and_high_cpu_requirement(self):
        parent = nproc(10,comm='/opt/homebrew/bin/claude',args='claude --print')
        guard = type('Guard',(),{'previous':{}})()
        for spelling in ('read -t5 </dev/zero','read -t 5 < /dev/zero','read -r -t 5 < /dev/zero'):
            with self.subTest(spelling=spelling):
                p = nproc(comm='/bin/bash',args='bash -c '+json.dumps('while true; do '+spelling+'; done'),ppid=10,start=[NOW-120,0],cpuS=60)
                self.assertEqual(r.census_family(p,{10:parent},guard,NOW),'busy-wait tool shell')
                p['cpuS']=1
                self.assertNotEqual(r.census_family(p,{10:parent},guard,NOW),'busy-wait tool shell')
                self.assertIsNone(r.heavy(p))


class TransitionOrderingTests(unittest.TestCase):
    def test_end_wins_over_retried_onset_or_peak_and_same_time_ties(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            day = dt.datetime.fromtimestamp(NOW,dt.timezone.utc).date().isoformat()
            for phase,duration in (('onset',0),('peak',600),('peak',1200)):
                with self.subTest(phase=phase,duration=duration):
                    end = event(NOW+1200,'end',NOW)
                    retry = event(NOW+duration,phase,NOW)
                    retry['ts'] = stamp(NOW+1800)
                    (root/(day+'.ndjson')).write_text(json.dumps(end)+'\n'+json.dumps(retry)+'\n')
                    self.assertEqual(r.latest_rows(root,NOW+1800)['host.overload']['props']['phase'],'end')

    def test_transition_duration_shape_matrix(self):
        for value in (None,True,'1200',-1,float('nan'),float('inf')):
            with self.subTest(value=value):
                row=event(NOW)
                row['props']['durationS']=value
                self.assertEqual(r.transition_order(row),(0,0))
        for value in (0,0.5,1200):
            with self.subTest(value=value):
                row=event(NOW)
                row['props']['durationS']=value
                self.assertEqual(r.transition_order(row),(NOW+value,1))
