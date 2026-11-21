"""Owner #142: footprint leaks and normal GUI Quit, without live effects."""
import copy
import ctypes
import datetime as dt
import json
from pathlib import Path
import plistlib
import sys
import unittest
from unittest.mock import patch

import test_mac_guard as shared
proc, ROBOB, m, toollog = shared.proc, shared.ROBOB, shared.m, shared.toollog

ACTIVITY = '/System/Applications/Utilities/Activity Monitor.app/Contents/MacOS/Activity Monitor'

# Exact memory.sample rows for pid 61946, 19 Nov dayfile (#142). Between-row
# interpolation models the guard's own 30-second observations, not measured data.
NOV19 = [
    ('08:44:44.830', 7506), ('08:49:51.132', 7607), ('08:54:56.854', 7711),
    ('09:00:02.532', 7814), ('09:05:07.805', 7921), ('09:10:13.101', 8030),
    ('09:15:18.585', 8135), ('09:20:23.750', 8238), ('09:25:28.674', 8341),
    ('09:30:33.756', 8443), ('09:35:39.244', 8546),
]


class SlowLeakTests(unittest.TestCase):
    setUp = shared.GuardTests.setUp
    tick = shared.GuardTests.tick
    effects = shared.GuardTests.effects
    events_named = shared.GuardTests.events_named

    def app(self, bid='com.apple.ActivityMonitor', comm=ACTIVITY, pid=61946):
        self.host.apps[comm] = dict(app=comm.split('/Contents/')[0], bundleId=bid)
        return proc(pid, comm)

    def series(self, rows, start=7.5, rate=1.2, count=65, **kw):
        for i in range(count):
            self.tick(copy.deepcopy(rows), {p['pid']: start+rate*i/120 for p in rows}, **kw)

    def restart(self):
        self.guard = m.Guard(self.host, self.root/'state', self.root/'evidence', dry=False,
                             logger=lambda c, k, n, **kw: self.events.append((n, kw['props'])), clock=lambda: self.now)

    def test_nov19_replay_quit_once_near_0920(self):
        rows = [self.app()]
        points = [(dt.datetime.fromisoformat('2026-11-19T'+stamp+'+00:00').timestamp(), mb/1024) for stamp, mb in NOV19]
        self.now = points[0][0]
        while self.now < points[-1][0]:
            a, b = next((a,b) for a,b in zip(points, points[1:]) if a[0] <= self.now <= b[0])
            gb = a[1]+(b[1]-a[1])*(self.now-a[0])/(b[0]-a[0])
            self.tick(rows, {61946: gb}, pressure=2, load=80)
        quit_events = [e for e in self.events_named('action') if e.get('action') == 'quit']
        self.assertEqual(self.effects('quit'), [('quit', 61946, 'com.apple.ActivityMonitor')])
        first = self.events_named('slow_leak')[0]
        self.assertGreater(first['footprintGiB'], 8)
        self.assertAlmostEqual(first['growthGiBHour'], 1.2, delta=.1)
        series = quit_events[0]['footprintSeries']
        at = dt.datetime.fromtimestamp(series[-1]['at'], dt.timezone.utc)
        self.assertEqual(at.hour, 9)
        self.assertIn(at.minute, (18,19,20))
        self.assertGreaterEqual(series[-1]['at']-series[0]['at'], 1800)
        self.assertIn(('signal', 61946, 'SIGTERM'), self.effects('signal'))
        self.assertTrue(all(5 not in e['signals'] for e in self.events_named('sample')))
        self.assertTrue(all(4 not in e['signals'] for e in self.events_named('sample')))

    def test_strict_thresholds_and_minimum_window(self):
        for start, rate, count, trips in [(7.4,1.2,60,False), (7.4,1.2,61,False),
                                         (8,1,61,False), (8,1.01,61,True), (9,0,80,False)]:
            with self.subTest(start=start, rate=rate, count=count):
                self.setUp()
                self.series([self.app()], start, rate, count)
                self.assertEqual(bool(self.effects('quit')), trips)

    def test_bundle_exemptions_even_when_renamed(self):
        for bid in ('company.thebrowser.dia', 'com.apple.MobileSMS', 'com.ardud.robob',
                    'com.apple.finder', 'com.apple.Terminal', 'com.googlecode.iterm2',
                    'com.mitchellh.ghostty', 'dev.warp.Warp-Stable', 'dev.warp.Warp', 'dev.warp.Warp-Preview'):
            with self.subTest(bundle=bid):
                self.setUp()
                app = self.app(bid, '/Applications/Renamed.app/Contents/MacOS/Unrelated')
                self.series([app])
                self.assertEqual(self.effects('quit'), [])
                self.assertEqual(self.effects('signal'), [])
                self.assertEqual(self.events_named('slow_leak')[0]['action'], 'protected_alert')
                self.assertEqual(self.events_named('slow_leak')[0]['bundleId'], bid)

    def test_providers_service_robob_and_system_never_quit(self):
        for p in [proc(31,'codex'), proc(31,'claude'), proc(31,'opencode'), proc(31,'node',args='node /opt/codex.js'),
                  proc(31,'service',label='com.ardud.opencode-service'), proc(31,ROBOB),
                  proc(31,'launchd'), proc(31,'WindowServer'), proc(31,'/usr/libexec/leaky'),
                  proc(31,'/System/Library/CoreServices/Utility.app/Contents/MacOS/Utility')]:
            with self.subTest(comm=p['comm']):
                self.setUp()
                self.series([p])
                self.assertEqual(self.effects('quit'), [])
                self.assertEqual(self.effects('signal'), [])
                self.assertEqual(self.effects('soften'), [])
                self.assertEqual(self.effects('restart'), [])
                self.assertEqual(self.events_named('slow_leak')[0]['action'], 'protected_alert')

    def test_protected_slow_leak_alone_never_authorizes_other_jobs(self):
        cases = [(proc(31, 'codex'), owner) for owner in ('live', 'ended', 'unknown')]
        cases += [(p, 'unknown') for p in (
            proc(31, 'claude'), proc(31, 'opencode'), proc(31, 'gemini'),
            proc(31, 'cursor-agent'), proc(31, 'grok'), proc(31, 'antigravity'),
            proc(31, 'node', args='node /tools/@openai/codex/bin/codex.js'),
            proc(31, 'node', label='com.ardud.opencode-service'), proc(31, ROBOB),
            proc(31, '/usr/libexec/leaky'), proc(31, 'leaky', label='com.ardud.integration'),
            proc(31, 'leaky', label='unknown-service-inventory'))]
        for holder, owner in cases:
            with self.subTest(comm=holder['comm'], label=holder.get('label'), owner=owner):
                self.setUp()
                self.host.owners[31] = owner
                orphan = proc(100, 'test-runner')
                for i in range(61):
                    result = self.tick([holder, orphan], {31: 8.1+i*.01}, load=0, lag=0, pressure=1)
                    self.assertFalse(result['strain'])
                    self.assertEqual(result['signals'], [])
                self.guard.drain(self.now)
                self.assertEqual(self.effects('signal'), [])
                self.assertEqual(self.effects('soften'), [])
                self.assertEqual(self.effects('quit'), [])
                self.assertEqual(self.guard.pending, [])
                self.assertEqual(self.events_named('slow_leak')[0]['action'], 'protected_alert')
                self.assertEqual(len(self.effects('worker')), 1)
                self.assertEqual(len(self.effects('notify')), 1)

    def test_exempt_or_unverified_gui_leak_does_not_activate_strain(self):
        for bid in sorted(m.GUI_NEVER_QUIT)+[None]:
            with self.subTest(bundle=bid):
                self.setUp()
                app = self.app(bid, '/Applications/Renamed.app/Contents/MacOS/Renamed')
                if bid is None:
                    self.host.apps.clear()
                for i in range(61):
                    result = self.tick([app, proc(100, 'test-runner')], {61946: 8.1+i*.01})
                    self.assertFalse(result['strain'])
                    self.assertNotIn(7, result['signals'])
                self.assertEqual(self.effects('signal'), [])
                self.assertEqual(self.effects('quit'), [])
                self.assertEqual(self.events_named('slow_leak')[0]['action'], 'protected_alert')

    def test_eligible_slow_leaks_still_activate_strain_without_load(self):
        for kind in ('gui', 'non-gui'):
            with self.subTest(kind=kind):
                self.setUp()
                holder = self.app() if kind == 'gui' else proc(20, 'leak')
                result = None
                for i in range(61):
                    result = self.tick([holder], {holder['pid']: 8.1+i*.01})
                self.assertTrue(result['strain'])
                self.assertEqual(result['signals'], [7])
                self.assertEqual(self.effects('quit'), [('quit', 61946, 'com.apple.ActivityMonitor')] if kind == 'gui' else [])
                self.assertEqual(self.effects('soften'), [('soften', 20)] if kind == 'non-gui' else [])

    def test_quit_then_force_only_after_two_minutes(self):
        rows = [self.app()]
        self.series(rows, count=64)
        self.assertEqual(len(self.effects('quit')), 1)
        self.assertEqual(self.effects('signal'), [])
        self.tick(rows, {61946: 8.14})
        self.assertEqual(self.effects('signal'), [('signal',61946,'SIGTERM')])
        self.guard.drain(self.now-20)
        self.assertEqual(self.effects('signal')[-1], ('signal',61946,'SIGKILL'))
        self.assertEqual(len(self.effects('worker')), 1)

    def test_exited_after_quit_and_pid_reuse_never_force(self):
        for reused in (False, True):
            with self.subTest(reused=reused):
                self.setUp()
                app=self.app()
                self.series([app], count=61)
                next_rows=[dict(app,start='new birth')] if reused else []
                self.series(next_rows, start=9, count=5)
                self.guard.drain(self.now)
                self.assertEqual(self.effects('signal'), [])
                self.assertEqual(len(self.effects('quit')), 1)
                self.assertEqual(len(self.events_named('slow_leak')), 1)
                self.assertEqual(self.events_named('action')[-1]['action'], 'appgone')

    def test_reuse_resets_slow_window(self):
        app=self.app()
        self.series([app], count=60)
        app['start']='new birth'
        self.series([app], start=9, count=60)
        self.assertEqual(self.effects('quit'), [])

    def test_flat_or_shrinking_after_quit_cancels_force(self):
        for gb in (8.1, 8.05):
            with self.subTest(footprint=gb):
                self.setUp()
                rows=[self.app()]
                self.series(rows, count=61)
                for _ in range(5): self.tick(rows,{61946:gb})
                self.assertEqual(self.effects('signal'), [])
                self.assertTrue(any(e.get('result')=='cancelled_not_growing_or_protected' for e in self.events_named('action')))

    def test_recent_decline_cancels_force_even_above_quit_size(self):
        rows=[self.app()]
        self.series(rows,count=61)
        for gb in (8.2,8.3,8.25,8.2): self.tick(rows,{61946:gb})
        self.assertEqual(self.effects('signal'), [])

    def test_missing_samples_keep_window_and_force_needs_top(self):
        rows=[self.app()]
        self.series(rows,count=59)
        self.tick([], {})
        self.tick(rows, {})
        self.tick(rows,{61946:8.11})
        self.assertEqual(len(self.effects('quit')),1)
        for _ in range(4): self.tick(rows,{})
        self.assertEqual(self.effects('signal'),[])
        self.tick(rows,{61946:8.2})
        self.assertEqual(self.effects('signal'),[('signal',61946,'SIGTERM')])

    def test_pause_resume_and_restart_revalidate(self):
        rows=[self.app()]
        self.series(rows,count=61)
        (self.guard.state/'paused').touch()
        for _ in range(5): self.tick(rows,{61946:8.1})
        self.restart()
        (self.guard.state/'paused').unlink()
        self.tick(rows,{61946:8.1})
        self.assertEqual(self.effects('signal'),[])
        self.assertEqual(len(self.effects('quit')),1)

    def test_history_survives_restart_without_shortening_window(self):
        rows=[self.app()]
        self.series(rows,count=60)
        self.restart()
        self.tick(rows,{61946:8.1})
        self.assertEqual(len(self.effects('quit')),1)

    def test_interrupted_force_intent_retries_term_with_fresh_kill_grace(self):
        rows=[self.app()]
        self.series(rows,count=61)
        job=next(iter(self.guard.gui_jobs.values()))
        job['phase']='force'
        self.guard.save()
        self.restart()
        for gb in (8.11,8.12,8.13): self.tick(rows,{61946:gb})
        self.assertEqual(self.effects('signal'),[])
        self.tick(rows,{61946:8.14})
        self.assertEqual(self.effects('signal'),[('signal',61946,'SIGTERM')])
        self.guard.drain(self.now-21)
        self.assertEqual(self.effects('signal'),[('signal',61946,'SIGTERM')])
        self.guard.drain(self.now-20)
        self.assertEqual(self.effects('signal')[-1],('signal',61946,'SIGKILL'))

    def test_pending_force_pause_then_calm_resume(self):
        rows=[self.app()]
        self.series(rows,count=65)
        self.assertEqual(self.effects('signal'),[('signal',61946,'SIGTERM')])
        (self.guard.state/'paused').touch()
        self.restart()
        for _ in range(65): self.tick(rows,{61946:7.5})
        self.assertFalse(self.guard.strain)
        (self.guard.state/'paused').unlink()
        self.guard.drain(self.now)
        self.assertEqual(self.effects('signal'),[('signal',61946,'SIGTERM')])
        self.assertEqual(self.guard.pending,[])

    def test_queued_gui_force_requires_current_growing_footprint(self):
        for footprint in (None,7.5,8.14):
            with self.subTest(footprint=footprint):
                self.setUp();rows=[self.app()]
                self.series(rows,count=65)
                if footprint is None:
                    self.tick(rows,{})
                else:
                    self.tick(rows,{61946:footprint})
                self.guard.drain(self.now-20)
                self.assertEqual(self.effects('signal'),[('signal',61946,'SIGTERM')])

    def test_queued_gui_force_refuses_stale_top_without_new_cycle(self):
        rows=[self.app()]
        self.series(rows,count=65)
        self.guard.drain(self.now+60)
        self.assertEqual(self.effects('signal'),[('signal',61946,'SIGTERM')])

    def test_dry_pending_force_not_proposed_after_recovery(self):
        rows=[self.app()]
        self.series(rows,count=65)
        self.guard.dry=True
        self.host.effects.clear()
        self.tick(rows,{61946:7.5})
        self.guard.drain(self.now-20)
        self.assertEqual(self.host.effects,[])
        self.assertEqual(self.events_named('action')[-1]['result'],'cancelled_gui_authorization')

    def test_delayed_kill_refreshes_service_and_parent_inventory_matrix(self):
        labels=(None,'com.abdullah.bridge','com.ardud.tool','local.ardud.tool',
                'unknown-service-inventory','com.ardud.opencode-service')
        for cls in ('A','B','C','D','G'):
            for launch_label in labels:
                for via_parent in (False,True):
                    with self.subTest(actionClass=cls,label=launch_label,parent=via_parent):
                        self.setUp()
                        if cls=='G':
                            p=self.app()
                            self.series([p],count=65)
                            footprint=8.15
                        else:
                            p=proc(20,'leak')
                            self.tick([p],{20:1})
                            self.guard.strain=True
                            self.guard.pending=[dict(proc=dict(self.guard.rows[20]),due=self.now,actionClass=cls)]
                            footprint=1
                        p=copy.deepcopy(p)
                        rows=[p]
                        if via_parent:
                            p['ppid']=100
                            rows.append(proc(100,'supervisor',label=launch_label))
                        else:
                            p['label']=launch_label
                        self.tick(rows,{p['pid']:footprint})
                        self.host.effects.clear()
                        self.guard.drain(self.now-20)
                        allowed=launch_label is None or cls=='D' and launch_label!='com.ardud.opencode-service'
                        self.assertEqual(self.effects('signal'),[('signal',p['pid'],'SIGKILL')] if allowed else [])
                        self.assertEqual(self.events_named('action')[-1]['label'],launch_label)

    def test_quit_error_is_not_permission_to_force(self):
        rows=[self.app()]
        with patch.object(self.host,'quit_app',side_effect=m.ProbeError('timeout')):
            self.series(rows,count=61)
        self.restart()
        self.series(rows,start=8.11,count=8)
        self.assertEqual(self.effects('signal'),[])
        self.assertEqual(self.effects('quit'),[])
        self.assertTrue(any(e.get('action')=='quit' and e['result']=='unknown' for e in self.events_named('action')))

    def test_protection_and_identity_rechecked_before_term_and_kill(self):
        for when in ('term','kill'):
            for change in ('bundle','identity','pause'):
                with self.subTest(when=when,change=change):
                    self.setUp();rows=[self.app()]
                    self.series(rows,count=64 if when=='term' else 65)
                    before=len(self.effects('signal'))
                    if change=='bundle': self.host.apps[ACTIVITY]['bundleId']='com.apple.Terminal'
                    elif change=='identity': self.host.identity=lambda p:False
                    else: (self.guard.state/'paused').touch()
                    if when=='term': self.tick(rows,{61946:8.14})
                    else: self.guard.drain(self.now-20)
                    self.assertEqual(len(self.effects('signal')),before)

    def test_dry_and_pause_have_no_effects(self):
        for dry in (True,False):
            with self.subTest(dry=dry):
                self.setUp()
                self.guard.dry=dry
                if not dry: (self.guard.state/'paused').touch()
                self.series([self.app()],count=70)
                self.guard.drain(self.now)
                self.assertEqual(self.host.effects,[])

    def test_resume_after_initial_paused_detection_requests_quit(self):
        rows=[self.app()]
        (self.guard.state/'paused').touch()
        self.series(rows,count=61)
        self.assertEqual(self.host.effects,[])
        (self.guard.state/'paused').unlink()
        self.tick(rows,{61946:8.11})
        self.assertEqual(len(self.effects('quit')),1)

    def test_unknown_bundle_never_quits_or_force_quits(self):
        app=self.app()
        self.host.apps.clear()
        self.series([app],count=70)
        self.assertEqual(self.effects('quit'),[])
        self.assertEqual(self.effects('signal'),[])

    def test_gui_bundle_locations(self):
        for root,allowed in [('/Applications',True),('/Users/ardud/Applications',True),
                             ('/Volumes/ExternalSSD/Apps',True),('/System/Applications/Utilities',True),
                             ('/System/Library/CoreServices',False)]:
            with self.subTest(root=root):
                self.setUp()
                app=self.app(comm=root+'/Leaking.app/Contents/MacOS/Leaking')
                self.series([app],count=61)
                self.assertEqual(bool(self.effects('quit')),allowed)

    def test_ps_gap_is_not_application_exit_proof(self):
        rows=[self.app()]
        self.series(rows,count=61)
        with patch.object(self.host,'same_birth',return_value=True):
            self.tick([],{})
        self.tick(rows,{61946:8.12})
        self.assertEqual(len(self.effects('quit')),1)
        self.assertFalse(any(e.get('action')=='appgone' for e in self.events_named('action')))

    def test_ssd_interlock_prevents_robob_restart(self):
        with patch.object(self.host,'ssd_blocked',return_value=True):
            self.tick([proc(1,ROBOB)],{1:25})
        self.assertEqual(self.effects('restart'),[])
        self.assertEqual(self.events_named('robob_restart')[0]['reason'],'ssd_read_blocked')
        self.assertEqual(len(self.effects('worker')),1)

    def test_fast_runaway_actions_precede_slow_leak_processing(self):
        for robob in (False,True):
            with self.subTest(robob=robob):
                self.setUp()
                app=self.app()
                self.series([app],count=60)
                offender=proc(1,ROBOB) if robob else proc(20,'leak')
                with patch.object(self.host, 'app_info', wraps=self.host.app_info) as app_probe:
                    self.tick([app,offender],{61946:8.1,offender['pid']:25 if robob else 50})
                    app_probe.assert_not_called()
                self.assertEqual(self.effects('quit'),[])
                if robob:
                    self.assertEqual(len(self.effects('restart')),1)
                else:
                    self.assertEqual(self.effects('signal'),[('signal',20,'SIGTERM')])

    def test_non_gui_uses_existing_hog_ladder_and_integrations_alert(self):
        for label in (None,'com.ardud.integration'):
            with self.subTest(label=label):
                self.setUp()
                rows=[proc(20,'leak',label=label)]
                self.series(rows,count=68)
                if label:
                    self.assertEqual(self.effects('signal'),[])
                    self.assertEqual(self.effects('soften'),[])
                else:
                    self.assertEqual(self.effects('soften'),[('soften',20)])
                    self.assertEqual(self.effects('signal'),[('signal',20,'SIGSTOP'),('signal',20,'SIGTERM')])
                self.assertEqual(self.effects('quit'),[])

    def test_app_bundle_verifies_main_foreground_executable(self):
        app=self.root/'Changed Name.app'
        executable=app/'Contents/MacOS/Changed Name'
        executable.parent.mkdir(parents=True)
        info=dict(CFBundleIdentifier='com.apple.ActivityMonitor',CFBundleExecutable=executable.name,CFBundlePackageType='APPL')
        for change,expected in [({},True),({'LSUIElement':True},False),({'LSBackgroundOnly':True},False),
                                ({'CFBundleExecutable':'other'},False),({'CFBundlePackageType':'XPC!'},False)]:
            with self.subTest(change=change):
                (app/'Contents/Info.plist').write_bytes(plistlib.dumps(dict(info,**change)))
                self.assertEqual(bool(m.app_info(str(executable))),expected)
        self.assertIsNone(m.app_info(str(app/'Contents/Helpers/worker')))
        self.assertIsNone(m.app_info(str(app/'Contents/Frameworks/Helper.app/Contents/MacOS/Helper')))

    def test_quit_helper_revalidates_identity_bundle_pause_and_dry_run(self):
        request=dict(pid=61946,comm=ACTIVITY,start='birth',argsHash='hash',
                     bundleId='com.apple.ActivityMonitor',stateDir=str(self.root))
        for proof in ('valid','identity','bundle','pause','dry'):
            with self.subTest(proof=proof):
                marker=self.root/'paused'
                if proof=='pause': marker.touch()
                info=dict(app='/app',bundleId='com.apple.Terminal' if proof=='bundle' else request['bundleId'])
                with patch.object(sys,'argv',['mac_guard.py','--quit-gui',json.dumps(request)]), \
                     patch.object(m.Host,'identity',return_value=proof!='identity'), \
                     patch.object(m,'app_info',return_value=info), patch.object(m,'quit_gui') as quit_call, \
                     patch.dict(m.os.environ,{'MAC_GUARD_DRY_RUN':'1' if proof=='dry' else '0'}):
                    if proof=='valid':
                        m.main()
                        quit_call.assert_called_once_with(61946)
                    else:
                        with self.assertRaises(SystemExit): m.main()
                        quit_call.assert_not_called()
                if marker.exists(): marker.unlink()

    def test_quit_appleevent_uses_exact_pid_and_normal_interactive_event(self):
        from unittest.mock import Mock
        api=Mock()
        api.AECreateDesc.return_value=api.AECreateAppleEvent.return_value=api.AESendMessage.return_value=0
        m.quit_gui(61946,api)
        args=api.AECreateDesc.call_args.args
        self.assertEqual(args[0],int.from_bytes(b'kpid','big'))
        self.assertEqual(ctypes.cast(args[1],ctypes.POINTER(ctypes.c_int32)).contents.value,61946)
        self.assertEqual(api.AECreateAppleEvent.call_args.args[:2],(int.from_bytes(b'aevt','big'),int.from_bytes(b'quit','big')))
        self.assertEqual(api.AESendMessage.call_args.args[2],0x21)

    def test_log_preserves_series_and_bundle(self):
        self.series([self.app()],count=61)
        event=next(e for e in self.events_named('action') if e['action']=='quit')
        record=toollog.record('mac-guard','event','macguard.action',dt.datetime.now(dt.timezone.utc),props=event)
        self.assertEqual(record['props']['bundleId'],'com.apple.ActivityMonitor')
        self.assertEqual(len(record['props']['footprintSeries']),61)
        self.assertEqual(record['props']['step'],'quit')

    def test_nov19_dry_replays(self):
        reports=dry_replays()
        for name,report in reports.items():
            self.assertEqual(report['realEffects'],[])
            quits=[e for e in report['actions'] if e.get('step')=='quit']
            if name=='activity-monitor':
                self.assertEqual(len(quits),1)
                self.assertTrue(any(e.get('action')=='TERM' for e in report['actions']))
                self.assertTrue(any(e.get('action')=='KILL' for e in report['actions']))
            else:
                self.assertEqual(quits,[])
                self.assertFalse(any(e.get('action') in ('TERM','KILL') for e in report['actions']))


def dry_replays():
    reports={}
    for name,bid,comm in [('activity-monitor','com.apple.ActivityMonitor',ACTIVITY),
                          ('renamed-dia','company.thebrowser.dia','/Applications/Renamed.app/Contents/MacOS/Renamed'),
                          ('renamed-terminal','com.apple.Terminal','/Applications/Renamed.app/Contents/MacOS/Renamed')]:
        case=SlowLeakTests()
        case.setUp()
        try:
            case.guard.dry=True
            rows=[case.app(bid,comm)]
            points=[(dt.datetime.fromisoformat('2026-11-19T'+stamp+'+00:00').timestamp(),mb/1024) for stamp,mb in NOV19]
            case.now=points[0][0]
            while case.now<points[-1][0]:
                a,b=next((a,b) for a,b in zip(points,points[1:]) if a[0]<=case.now<=b[0])
                gb=a[1]+(b[1]-a[1])*(case.now-a[0])/(b[0]-a[0])
                case.tick(rows,{61946:gb},pressure=2,load=80)
                case.guard.drain(case.now-20)
            assert not case.host.effects
            reports[name]=dict(realEffects=case.host.effects,actions=[e for n,e in case.events
                if n in ('macguard.slow_leak','macguard.action')])
        finally:
            case.doCleanups()
    return reports


if __name__=='__main__':
    if '--replay-report' in sys.argv:
        print(json.dumps(dry_replays(),indent=2))
    else:
        unittest.main()
