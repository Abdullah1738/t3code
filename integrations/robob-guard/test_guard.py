import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import guard
from hold import Holds

SOURCE = Path(__file__).resolve().parent


# Backend recovery simulations own their inputs; TCC behavior is tested separately.
def setUpModule():
    global tcc_patch, tier_patch
    tcc_patch = patch("guard.tcc_jam_tick")
    tcc_patch.start()
    tier_patch = patch("guard.protected_tier_tick")
    tier_patch.start()


def tearDownModule():
    tier_patch.stop()
    tcc_patch.stop()


class DecisionTests(unittest.TestCase):
    def setUp(self):
        self.state=guard.initial_state(); self.now=10000
    def tick(self,elapsed=30,**kw):
        self.now+=elapsed
        self.state,status,action=guard.decide(self.state,now=self.now,up=kw.pop('up',False),boot_time=kw.pop('boot_time',0),**kw)
        return status,action
    def opened(self):
        self.assertEqual(self.tick()[1],'none'); self.assertEqual(self.tick()[1],'reopen')
    def test_up(self):self.assertEqual(self.tick(up=True),(['up'],'none'))
    def test_down_and_grace(self):
        self.opened(); self.assertEqual(self.tick(89)[1],'backoff');self.assertEqual(len(self.state['history']),1)
    def test_boot_boundary(self):
        for age,expected in [(0,'reopen'),(299,'reopen'),(300,'none'),(-1,'none')]:
            with self.subTest(age=age):
                self.assertEqual(guard.decide(guard.initial_state(),now=10000,up=False,boot_time=10000-age)[2],expected)
    def failed_state(self, failures):
        state = guard.initial_state()
        for now in [10000, 10030]:
            state, _, _ = guard.decide(state, now=now, up=False, boot_time=0)
        for attempt in range(failures):
            now += 90
            state, _, _ = guard.decide(state, now=now, up=False, boot_time=0)
            if attempt < failures - 1:
                now = state['next_retry']
                state, _, _ = guard.decide(state, now=now, up=False, boot_time=0)
        return state, now

    def test_persisted_attempts_from_previous_boot_do_not_delay_startup(self):
        for failures in [0, 1, 2, 3, 4]:
            for hold_kind in ['absent', 'fresh', 'stale', 'dead']:
                with self.subTest(failures=failures, hold=hold_kind), tempfile.TemporaryDirectory() as d:
                    previous, checked_at = self.failed_state(failures)
                    boot = checked_at + 30
                    now = boot + 30
                    state_file = Path(d) / 'state.json'
                    guard.atomic_json(state_file, previous)
                    hold = None if hold_kind == 'absent' else dict(
                        by='install', pid=2, startedAt=now, beatAt=now - (90 if hold_kind == 'stale' else 0))
                    state, statuses, action = guard.decide(
                        guard.read_state(state_file), now=now, up=False, boot_time=boot,
                        hold=hold, hold_pid_alive=hold_kind != 'dead')
                    self.assertEqual(action, 'none' if hold_kind == 'fresh' else 'reopen')
                    self.assertEqual(state['failed_reopens'], 0)
                    self.assertEqual(state['backoff_step'], 0)
                    self.assertEqual(state['next_retry'], 0)
                    if hold_kind == 'fresh':
                        self.assertEqual(statuses, ['hold:install'])
                        self.assertEqual(state['down_count'], 0)
                    else:
                        self.assertEqual(state['last_reopen'], now)
                        self.assertEqual(state['history'], previous['history'] + [now])
                        self.assertTrue(state['awaiting_reopen'])
                        # Persist again so another launchd check on this boot keeps startup grace.
                        guard.atomic_json(state_file, state)
                        state, _, action = guard.decide(
                            guard.read_state(state_file), now=now + 30, up=False, boot_time=boot)
                        self.assertEqual(action, 'backoff')
                        self.assertEqual(state['failed_reopens'], 0)
                        self.assertEqual(state['last_reopen'], now)

    def test_same_boot_retry_delay_and_unknown_boot_are_preserved(self):
        for boot in [0, None]:
            with self.subTest(boot=boot):
                previous, checked_at = self.failed_state(3)
                state, _, action = guard.decide(previous, now=checked_at + 60, up=False, boot_time=boot)
                self.assertEqual(action, 'backoff')
                self.assertEqual(state['next_retry'], previous['next_retry'])
                self.assertEqual(state['next_retry'] - (checked_at + 60), 540)

    def test_same_boot_startup_grace_then_normal_retry(self):
        state, _, action = guard.decide(guard.initial_state(), now=10030, up=False, boot_time=10000)
        self.assertEqual(action, 'reopen')
        for now in [10060, 10119]:
            state, _, action = guard.decide(state, now=now, up=False, boot_time=10000)
            self.assertEqual(action, 'backoff')
            self.assertEqual(state['failed_reopens'], 0)
        state, _, action = guard.decide(state, now=10120, up=False, boot_time=10000)
        self.assertEqual(action, 'backoff')
        self.assertEqual(state['failed_reopens'], 1)
        self.assertEqual(state['next_retry'], 10240)
        self.assertEqual(guard.decide(state, now=10240, up=False, boot_time=10000)[2], 'reopen')

    def test_previous_boot_state_after_startup_window_uses_two_checks(self):
        previous, checked_at = self.failed_state(3)
        boot = checked_at + 30
        state, _, action = guard.decide(previous, now=boot + 300, up=False, boot_time=boot)
        self.assertEqual(action, 'none')
        self.assertEqual(state['down_count'], 1)
        self.assertEqual(guard.decide(state, now=boot + 330, up=False, boot_time=boot)[2], 'reopen')
    def test_hold_corpus(self):
        rows=[(dict(by='install',pid=2,startedAt=10000,beatAt=10000),True,True),
              (dict(by='install',pid=2,startedAt=10000,beatAt=9910),True,False),
              (dict(by='install',pid=2,startedAt=10000,beatAt=9999),False,False),
              (dict(by='install',pid=2,startedAt=10000,beatAt=10001),True,False),
              (dict(by='install',pid=-1,startedAt=10000,beatAt=10000),True,False),
              (dict(by='install',pid=True,startedAt=10000,beatAt=10000),True,False),
              (dict(by='install',pid=2,startedAt=10000,beatAt=float('nan')),True,False),
              (dict(by='install',pid=2,startedAt=10000,beatAt='10000'),True,False),({},True,False),([],True,False)]
        for hold,alive,fresh in rows:
            with self.subTest(hold=hold,alive=alive):
                s,status,a=guard.decide(dict(guard.initial_state(),down_count=1),now=10000,up=False,boot_time=0,hold=hold,hold_pid_alive=alive)
                self.assertEqual(a,'none' if fresh else 'reopen');self.assertEqual(s['down_count'],0 if fresh else 2)
                self.assertTrue(status[0].startswith('hold:' if fresh else 'stale-hold:'))
    def test_backoff_never_gives_up(self):
        self.opened()
        for delay in [120,300,600,600,600]:
            self.assertEqual(self.tick(90)[1],'backoff');self.assertEqual(self.state['next_retry'],self.now+delay)
            self.assertEqual(self.tick(delay-1)[1],'backoff');self.assertEqual(self.tick(1)[1],'reopen')
    def test_failed_alert_once_and_retry(self):
        self.opened()
        for delay in [120,300]:self.tick(90);self.tick(delay)
        self.tick(90); keys=list(self.state['pending_alerts']);self.assertEqual(len(keys),1)
        key=keys[0];self.assertTrue(key.endswith(':failed-reopen'))
        self.state=guard.notification_result(self.state,key,False);self.tick()
        self.assertNotIn(key,self.state['alerts_sent']);self.assertIn(key,self.state['pending_alerts'])
        self.state=guard.notification_result(self.state,key,True);self.tick(600)
        self.assertNotIn(key,self.state['pending_alerts']);self.assertEqual(self.state['alerts_sent'].count(key),1)
    def test_crash_loop_persists_across_recovery(self):
        for i in range(5):self.tick(100,up=True);self.tick();self.tick()
        key=next(k for k in self.state['pending_alerts'] if k.endswith(':crash-loop'))
        self.state=guard.notification_result(self.state,key,True)
        self.tick(100,up=True);self.tick();self.tick();self.assertFalse(self.state['pending_alerts'])
        self.tick(3600,up=True);self.assertIsNone(self.state['crash_episode']);self.assertEqual(self.state['history'],[])
    def test_recovery_resets_backoff_but_respects_grace(self):
        self.opened();self.tick(90);self.tick(up=True)
        self.assertEqual(self.state['backoff_step'],0);self.assertEqual(self.state['failed_reopens'],0)
        self.tick();self.assertEqual(self.tick()[1],'reopen');self.tick(0,up=True);self.tick(0)
        self.assertEqual(self.tick(0)[1],'backoff')
    def test_hold_resets_intentional_downtime(self):
        self.opened();self.tick(200,hold=dict(by='install',pid=2,startedAt=10000,beatAt=self.now+200),hold_pid_alive=True)
        self.assertEqual(self.state['failed_reopens'],0);self.assertEqual(self.tick()[1],'none');self.assertEqual(self.tick()[1],'reopen')

    def test_live_ssd_block_preserves_attempts_without_alerts(self):
        self.state.update(last_reopen=9000, awaiting_reopen=True, failed_reopens=2,
                          history=[8000, 8100, 8200, 8300, 8400], crash_episode=8000)
        previous = dict(self.state)
        for tick in range(150):
            statuses, action = self.tick(ssd_block=dict(since='incident', lastOutcome='timeout'),
                                         ssd_block_live=True)
            self.assertEqual(action, 'none')
            self.assertIn('ssd-block:timeout', statuses)
            self.assertEqual(self.state, dict(previous, down_count=tick + 1))
            self.assertEqual(self.state['pending_alerts'], {})

    def test_ssd_block_clears_after_three_down_checks(self):
        for tick in range(3):
            self.assertEqual(self.tick(ssd_block={}, ssd_block_live=True)[1], 'none')
        self.assertEqual(self.state['down_count'], 3)
        self.assertEqual(self.tick()[1], 'reopen')
        self.assertEqual(self.state['last_reopen'], self.now)

    def test_stale_ssd_block_does_not_delay_reopen(self):
        self.tick()
        statuses, action = self.tick(ssd_block=dict(lastOutcome='error'), ssd_block_live=False)
        self.assertEqual(action, 'reopen')
        self.assertIn('stale-ssd-block', statuses)

    def test_up_ignores_live_ssd_block(self):
        self.opened()
        expected = guard.decide(self.state, now=self.now + 30, up=True, boot_time=0)
        self.assertEqual(self.tick(up=True, ssd_block=dict(lastOutcome='jam'), ssd_block_live=True),
                         (expected[1], expected[2]))
        self.assertEqual(self.state, expected[0])

    def test_install_hold_wins_over_ssd_block(self):
        self.opened()
        statuses, action = self.tick(
            hold=dict(by='install', pid=2, startedAt=self.now, beatAt=self.now), hold_pid_alive=True,
            ssd_block=dict(lastOutcome='jam'), ssd_block_live=True)
        self.assertEqual((statuses, action), (['hold:install'], 'none'))
        self.assertEqual(self.state['down_count'], 0)

class IOTests(unittest.TestCase):
    def setUp(self):
        protected = patch('guard.protected_tier_tick')
        protected.start()
        self.addCleanup(protected.stop)

    def test_ssd_marker_and_probe_freshness_corpus(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            root = home / '.local/state/mac-upkeep'
            root.mkdir(parents=True)
            marker = root / 'ssd-launchd-read-blocked'
            probe = root / 'ssd-read-probe.json'
            self.assertEqual(guard.read_ssd_block(home, 10000), (None, False, []))
            block = dict(since='incident', lastOutcome='timeout')
            guard.atomic_json(marker, block)
            self.assertEqual(guard.read_ssd_block(home, 10000), (block, False, []))
            probe.write_text('probe freshness uses mtime, not JSON')
            for age, live in [(0, True), (299, True), (299.9, True), (300, False), (301, False), (-1, False)]:
                with self.subTest(age=age):
                    os.utime(probe, (10000 - age, 10000 - age))
                    self.assertEqual(guard.read_ssd_block(home, 10000), (block, live, []))
            for raw in [b'{', b'[]', b'null', b'true', b'1', b'"marker"', b'\xff',
                        b' ' * guard.SSD_MARKER_MAX_BYTES + b'{}', b'[' * 2000]:
                with self.subTest(raw=raw[:30]):
                    marker.write_bytes(raw)
                    self.assertEqual(guard.read_ssd_block(home, 10000),
                                     (None, False, ['ssd-block-unreadable']))
            with patch('guard.Path.open', side_effect=PermissionError):
                self.assertEqual(guard.read_ssd_block(home, 10000),
                                 (None, False, ['ssd-block-unreadable']))

    def test_ssd_path_overrides_and_bounded_read(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            marker, probe = home / 'marker', home / 'probe'
            marker.write_text('{}')
            probe.touch()
            os.utime(probe, (10000, 10000))
            env = dict(ROBOB_GUARD_SSD_BLOCK_PATH=str(marker), ROBOB_GUARD_SSD_PROBE_STATE_PATH=str(probe))
            with patch.dict(os.environ, env):
                self.assertEqual(guard.read_ssd_block(home, 10000), ({}, True, []))
                with patch('guard.Path.open') as opened:
                    opened.return_value.__enter__.return_value.read.return_value = b'{}'
                    self.assertEqual(guard.read_ssd_block(home, 10000), ({}, True, []))
                    opened.return_value.__enter__.return_value.read.assert_called_once_with(
                        guard.SSD_MARKER_MAX_BYTES + 1)

    def test_ssd_block_check_logging_and_reopen(self):
        import contextlib
        import io
        for kind, up, expected in [('live', False, 'ssd-block:timeout'), ('live', True, 'up'),
                                   ('stale', False, 'stale-ssd-block'),
                                   ('unreadable', False, 'ssd-block-unreadable')]:
            with self.subTest(kind=kind, up=up), tempfile.TemporaryDirectory() as d:
                home = Path(d)
                root = home / '.local/state/mac-upkeep'
                marker, probe = root / 'ssd-launchd-read-blocked', root / 'ssd-read-probe.json'
                guard.atomic_json(marker, dict(since='2026-11-17T18:32:00Z', lastOutcome='timeout'))
                probe.touch()
                os.utime(probe, (9700 if kind == 'stale' else 10000,) * 2)
                if kind == 'unreadable':
                    marker.write_text('{')
                state_path = home / '.local/state/robob-guard/state.json'
                guard.atomic_json(state_path, dict(guard.initial_state(), down_count=1))
                out = io.StringIO()
                with patch('guard.backend_ready', return_value=up), patch('guard.desktop_snapshot', return_value=None), \
                        patch('guard.backend_ownership', return_value=(None, None, [])), \
                        patch('guard.process_diagnostics', return_value='processes={}'), \
                        patch('guard.boot_epoch', return_value=0), patch('guard.time.time', return_value=10000), \
                        patch('guard.reopen') as opened, patch('guard.notify') as notified, \
                        contextlib.redirect_stdout(out):
                    guard.check(home)
                    self.assertEqual(opened.call_count, int(kind != 'live' and not up))
                    notified.assert_not_called()
                self.assertEqual(out.getvalue(), '')
                log = (state_path.parent / 'guard.log').read_text()
                self.assertIn(expected, log)
                if kind == 'live' and not up:
                    self.assertIn('"since":"2026-11-17T18:32:00Z","lastOutcome":"timeout"', log)
                    self.assertEqual(guard.read_state(state_path)['down_count'], 2)
                if up:
                    self.assertNotIn('ssd-block:', log)

    def test_ssd_block_arriving_during_final_recheck_cancels_reopen(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            state_path = home / '.local/state/robob-guard/state.json'
            previous = dict(guard.initial_state(), down_count=1)
            guard.atomic_json(state_path, previous)
            calls = []
            def health(home):
                calls.append(True)
                if len(calls) == 2:
                    root = home / '.local/state/mac-upkeep'
                    guard.atomic_json(root / 'ssd-launchd-read-blocked', dict(since='incident', lastOutcome='jam'))
                    (root / 'ssd-read-probe.json').touch()
                    os.utime(root / 'ssd-read-probe.json', (10000, 10000))
                return False
            with patch('guard.backend_ready', side_effect=health), \
                    patch('guard.desktop_snapshot', return_value=None), \
                    patch('guard.backend_ownership', return_value=(None, None, [])), \
                    patch('guard.process_diagnostics', return_value='processes={}'), \
                    patch('guard.boot_epoch', return_value=0), patch('guard.time.time', return_value=10000), \
                    patch('guard.reopen') as opened, patch('guard.notify') as notified:
                guard.check(home)
                opened.assert_not_called()
                notified.assert_not_called()
            self.assertEqual(guard.read_state(state_path), dict(previous, down_count=2))
            self.assertIn('ssd-block:jam', (state_path.parent / 'guard.log').read_text())

    def test_ssd_block_arriving_during_recovery_corpus(self):
        for phase in ['absent-ownership', 'replace-stop', 'replace-ownership']:
            for kind in ['live', 'stale', 'unreadable', 'absent']:
                with self.subTest(phase=phase, kind=kind), tempfile.TemporaryDirectory() as d:
                    home = Path(d)
                    state_path = home / '.local/state/robob-guard/state.json'
                    previous = dict(guard.initial_state(), down_count=3)
                    desktop = None
                    if phase.startswith('replace'):
                        desktop = dict(pid=42, identity='birth', startedAt=9000)
                        previous.update(unready_since=9700, unready_last=9970, unready_ticks=2,
                                        unready_desktop='42:birth')
                    guard.atomic_json(state_path, previous)
                    def publish():
                        if kind == 'absent':
                            return
                        root = home / '.local/state/mac-upkeep'
                        marker = root / 'ssd-launchd-read-blocked'
                        guard.atomic_json(marker, dict(since='late', lastOutcome='jam'))
                        (root / 'ssd-read-probe.json').touch()
                        os.utime(root / 'ssd-read-probe.json', (9700 if kind == 'stale' else 10000,) * 2)
                        if kind == 'unreadable':
                            marker.write_text('{')
                    ownership_calls = []
                    def ownership(*args):
                        ownership_calls.append(True)
                        if len(ownership_calls) == 3 and phase.endswith('ownership'):
                            publish()
                        return None, None, []
                    def stop(*args):
                        if phase == 'replace-stop':
                            publish()
                        return True
                    with patch('guard.backend_ready', return_value=False), \
                            patch('guard.desktop_snapshot', return_value=desktop), \
                            patch('guard.backend_ownership', side_effect=ownership), \
                            patch('guard.stop_unready_desktop', side_effect=stop), \
                            patch('guard.process_diagnostics', return_value='processes={}'), \
                            patch('guard.boot_epoch', return_value=0), patch('guard.time.time', return_value=10000), \
                            patch('guard.reopen') as opened, patch('guard.notify') as notified:
                        guard.check(home)
                        self.assertEqual(len(ownership_calls), 3)
                        self.assertEqual(opened.call_count, int(kind != 'live'))
                        notified.assert_not_called()
                    state = guard.read_state(state_path)
                    log = (state_path.parent / 'guard.log').read_text()
                    if kind == 'live':
                        self.assertEqual(state, dict(previous, down_count=4))
                        self.assertIn('ssd-block:jam', log)
                        self.assertIn('action=none', log)
                    else:
                        self.assertEqual(state['last_reopen'], 10000)
                        self.assertEqual(state['history'], [10000])
                        if kind != 'absent':
                            self.assertIn('stale-ssd-block' if kind == 'stale' else 'ssd-block-unreadable', log)

    def test_ssd_marker_status_input_corpus_logs_one_utf8_row(self):
        rows = [('missing', {}), ('ascii', dict(lastOutcome='timeout')),
                ('unicode', dict(lastOutcome='é🛠')), ('high-surrogate', dict(lastOutcome='\ud800')),
                ('low-surrogate', dict(lastOutcome='\udfff')), ('quotes', dict(lastOutcome='"\\')),
                ('whitespace', dict(lastOutcome='error\nnext\r\tline')),
                ('controls', dict(lastOutcome='\x00\x1b')), ('null', dict(lastOutcome=None)),
                ('bool', dict(lastOutcome=False)), ('number', dict(lastOutcome=42)),
                ('array', dict(lastOutcome=['\ud800'])), ('object', dict(lastOutcome={'key': '\udfff'}))]
        for name, marker in rows:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as d:
                home = Path(d)
                root = home / '.local/state/mac-upkeep'
                marker['since'] = '\ud800'
                guard.atomic_json(root / 'ssd-launchd-read-blocked', marker)
                (root / 'ssd-read-probe.json').touch()
                os.utime(root / 'ssd-read-probe.json', (10000, 10000))
                with patch('guard.backend_ready', return_value=False), \
                        patch('guard.process_diagnostics', return_value='processes={}'), \
                        patch('guard.boot_epoch', return_value=0), patch('guard.time.time', return_value=10000), \
                        patch('guard.reopen') as opened, patch('guard.notify') as notified:
                    guard.check(home)
                    opened.assert_not_called()
                    notified.assert_not_called()
                log = (home / '.local/state/robob-guard/guard.log').read_text(encoding='utf-8')
                self.assertEqual(len(log.splitlines()), 1)
                self.assertIn('ssd-block:', log)
                self.assertIn('action=none', log)
                self.assertIn('"since":"\\ud800"', log)

    def test_bounded_process_diagnostics_and_failed_reads(self):
        output = "malformed\n1 0 /sbin/launchd /sbin/launchd\n42 1 /Applications/Ro %s\n" % guard.EXECUTABLE
        output += "\n".join("%s 43 /Applications/Ro %s %s" % (pid, guard.EXECUTABLE, "x" * 300) for pid in range(43, 53))
        with patch('quit_reason.registered_desktop_pids',return_value={42}), \
                patch('guard.subprocess.run',return_value=subprocess.CompletedProcess('ps',0,stdout=output)):
            detail=json.loads(guard.process_diagnostics().removeprefix('processes='))
        self.assertEqual(detail['lsappinfo_pid'],42)
        self.assertTrue(detail['lsappinfo_alive'])
        self.assertEqual([p['pid'] for p in detail['robob_processes']],list(range(42,47)))
        self.assertEqual(detail['robob_processes'][0]['role'],'desktop')
        self.assertTrue(all(len(p['args'])==160 and p['ppid']==43 for p in detail['robob_processes'][1:]))
        with patch('quit_reason.registered_desktop_pids',side_effect=OSError('lsa')), \
                patch('guard.subprocess.run',side_effect=subprocess.TimeoutExpired('ps',5)):
            detail=guard.process_diagnostics()
        self.assertIn('"lsappinfo_alive":"unknown"',detail)
        self.assertIn('"lsappinfo_error":"OSError"',detail)
        self.assertIn('"processes_error":"TimeoutExpired"',detail)

    def test_check_error_notification_text(self):
        with patch('guard.subprocess.run') as run:
            self.assertTrue(guard.notify(Path('/fake'),'robob-guard:10000:check-error',dict(kind='check-error',at=10090)))
        command=run.call_args.args[0]
        message=command[command.index('--text')+1]
        self.assertIn('checks keep failing',message)
        self.assertIn('guard.log',message)
        self.assertEqual(command[-1],'robob-guard:10000:check-error')

    def test_check_error_state_validation(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'state'
            state=guard.initial_state()
            guard.record_check_error(state,10000,False)
            for now in [10030,10060,10090]:guard.record_check_error(state,now,False)
            guard.atomic_json(path,state)
            self.assertEqual(guard.read_state(path),state)
            for key,value in [('check_error_count',-1),('check_error_count',True),('check_error_since','bad')]:
                with self.subTest(key=key,value=value):
                    guard.atomic_json(path,dict(state,**{key:value}))
                    self.assertEqual(guard.read_state(path),guard.initial_state())

    def test_exact_process(self):
        self.assertTrue(guard.robob_present(' 12 '+guard.EXECUTABLE+'\n'))
        for value in ['Robob',guard.EXECUTABLE+' Helper','python script Robob',guard.EXECUTABLE+'-old']:
            self.assertFalse(guard.robob_present(' 12 '+value))
    def test_clean_background_open(self):
        with patch.dict(os.environ,{'BUN_INSPECT':'1','TMUX':'x'}),patch('guard.time.time',return_value=10000),patch('guard.subprocess.run') as run:
            guard.reopen(Path('/fake'));args,kw=run.call_args
            self.assertEqual(args[0],['/usr/bin/open','-g','-a',guard.APP,'--env','ROBOB_LAUNCH_INITIATOR=guard:10000000']);self.assertEqual(set(kw['env']),{'HOME','USER','PATH'});self.assertEqual(kw['cwd'],'/')
    def test_notification_failure(self):
        with patch('guard.subprocess.run',side_effect=subprocess.TimeoutExpired('bun',30)) as run:
            self.assertFalse(guard.notify(Path('/fake'),'key',dict(kind='crash-loop',at=10000)))
            self.assertEqual(run.call_args.kwargs['timeout'],30);self.assertNotIn('BUN_INSPECT',run.call_args.kwargs['env'])
            self.assertTrue(any('Dubai' in x for x in run.call_args.args[0]))
    def test_log_trimming(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'log';p.write_text(('x'*600+'\n')*2100)
            guard.append_log(p,10000,['hold:foo\nbar'],'none');lines=p.read_text().splitlines()
            self.assertEqual(len(lines),2000);self.assertIn('hold:foo bar',lines[-1])
    def test_state_roundtrip_and_corrupt(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'state';s,_,_=guard.decide(dict(guard.initial_state(),down_count=1),now=10000,up=False,boot_time=0)
            guard.atomic_json(p,s);self.assertEqual(guard.read_state(p),s)
            p.write_text('{"history":["bad"]}');self.assertEqual(guard.read_state(p),guard.initial_state())
    def test_check_in_sandbox(self):
        with tempfile.TemporaryDirectory() as d:
            home=Path(d);p=home/'.local/state/robob-guard/state.json'
            guard.atomic_json(p,dict(guard.initial_state(),down_count=1))
            with patch('guard.backend_ready',return_value=False),patch('guard.process_up',return_value=False),patch('guard.boot_epoch',return_value=0),patch('guard.reopen') as opened,patch('guard.notify') as notified:
                guard.check(home);opened.assert_called_once_with(home);notified.assert_not_called()
                guard.atomic_json(home/'.robob/install-hold.json',dict(by='test',pid=os.getpid(),startedAt=__import__('time').time(),beatAt=__import__('time').time()))
                guard.check(home);self.assertEqual(opened.call_count,1)
                self.assertIn('hold:test',(p.parent/'guard.log').read_text())
    def test_process_failure_never_opens(self):
        with tempfile.TemporaryDirectory() as d,patch('guard.backend_ready',return_value=False),patch('guard.process_up',side_effect=OSError('ps')),patch('guard.reopen') as opened:
            guard.check(Path(d));opened.assert_not_called()
    def test_heartbeat_arriving_during_recheck_never_records_open(self):
        for beat in [10000,10000.5,10001]:
            with self.subTest(beat=beat),tempfile.TemporaryDirectory() as d:
                home=Path(d);p=home/'.local/state/robob-guard/state.json'
                guard.atomic_json(p,dict(guard.initial_state(),down_count=1))
                def process(home):
                    guard.atomic_json(home/'.robob/install-hold.json',dict(by='arriving',pid=os.getpid(),startedAt=10000,beatAt=beat))
                    return False
                with patch('guard.desktop_snapshot',return_value=None),patch('guard.process_diagnostics',return_value='fixture'),patch('guard.backend_ready',side_effect=process),patch('guard.boot_epoch',return_value=0),patch('guard.time.time',side_effect=[10000,10001]),patch('guard.reopen') as opened:
                    guard.check(home);opened.assert_not_called()
                state=guard.read_state(p)
                self.assertEqual(state['history'],[]);self.assertFalse(state['awaiting_reopen'])
                self.assertIn('hold:arriving',(p.parent/'guard.log').read_text())
    def test_plist(self):
        p=plistlib.loads((SOURCE / 'scripts/com.ardud.robob-guard.plist').read_bytes());self.assertEqual(p['StartInterval'],30);self.assertIs(p['RunAtLoad'],True)
    def test_shell_syntax_without_execution(self):
        repo=Path(__file__).resolve().parents[2]
        scripts=['integrations/deploy.zsh','integrations/robob-guard/scripts/install-hold.zsh']
        scripts+=['tmp/memory/cutover/'+name+'.zsh' for name in
                  ['robob-restart-unattended','install-robob','install-robob-resume','missions-cutover-unattended']]
        for script in scripts:
            with self.subTest(script=script):
                subprocess.run(['/bin/zsh','-n',str(repo/script)],check=True,capture_output=True,timeout=10)
    def test_shell_nested_hold_preserves_exit_cleanup(self):
        library=(SOURCE / 'scripts/install-hold.zsh').resolve()
        with tempfile.TemporaryDirectory() as d:
            home=Path(d);bin_dir=home/'.local/bin';bin_dir.mkdir(parents=True)
            helper=bin_dir/'robob-install-hold'
            helper.write_text('#!/bin/zsh -f\nprint -r -- "$*" >> "$HOME/calls"\n')
            helper.chmod(0o755)
            env=dict(os.environ,HOME=d)
            env.pop('ROBOB_INSTALL_HOLD_BY',None);env.pop('ROBOB_INSTALL_HOLD_PID',None)
            (home/'child.zsh').write_text('source "$1"\nrobob_hold_begin child\n')
            script='source "$1"; trap \'print cleanup >> "$HOME/calls"\' EXIT; robob_hold_begin outer; zsh -f "$HOME/child.zsh" "$1"'
            subprocess.run(['/bin/zsh','-f','-c',script,'test',str(library)],check=True,env=env,capture_output=True,timeout=10)
            calls=(home/'calls').read_text().splitlines()
            self.assertEqual([line.split()[0] for line in calls],['start','beat','cleanup','stop'])
    def test_repair_wait_keeps_hold_until_healthy(self):
        library=(SOURCE / 'scripts/install-hold.zsh').resolve()
        for failures in [0,1,3]:
            with self.subTest(failures=failures),tempfile.TemporaryDirectory() as d:
                home=Path(d);bin_dir=home/'.local/bin';bin_dir.mkdir(parents=True)
                helper=bin_dir/'robob-install-hold'
                helper.write_text('#!/bin/zsh -f\nprint -r -- "$*" >> "$HOME/calls"\n');helper.chmod(0o755)
                (home/'probes').write_text('0')
                script='source "$1"; robob_hold_begin repair; ready() { local n=$(cat "$HOME/probes"); (( n++ )); print "$n" > "$HOME/probes"; print probe >> "$HOME/calls"; (( n > '+str(failures)+' )) || return 1; print \'{"ok":true,"status":"healthy"}\'; }; sleep() { print wait >> "$HOME/calls"; }; robob_hold_wait_for_repair ready; print healthy >> "$HOME/calls"'
                env=dict(os.environ,HOME=d);env.pop('ROBOB_INSTALL_HOLD_BY',None);env.pop('ROBOB_INSTALL_HOLD_PID',None)
                subprocess.run(['/bin/zsh','-f','-c',script,'test',str(library)],check=True,env=env,capture_output=True,timeout=10)
                calls=(home/'calls').read_text().splitlines()
                self.assertTrue(calls[0].startswith('start '));self.assertTrue(calls[-1].startswith('stop '))
                self.assertEqual(calls[-2],'healthy');self.assertEqual(calls.count('wait'),failures)
    def test_external_supervisor_exit_gates(self):
        import re
        blocks=re.findall(r'```zsh\n(.*?)```',(SOURCE / 'release-supervisor.md').read_text(),re.S)
        setup=blocks[0].replace('/Volumes/ExternalSSD/t3code-fork/integrations/robob-guard/scripts/install-hold.zsh',str((SOURCE / 'scripts/install-hold.zsh').resolve()))
        for exit_code,tail in [(0,blocks[1]),(7,blocks[1]),(1,blocks[2])]:
            with self.subTest(exit_code=exit_code),tempfile.TemporaryDirectory() as d:
                home=Path(d);bin_dir=home/'.local/bin';bin_dir.mkdir(parents=True)
                helper=bin_dir/'robob-install-hold'
                helper.write_text('#!/bin/zsh -f\nprint -r -- "$*" >> "$HOME/calls"\n');helper.chmod(0o755)
                (home/'probes').write_text('0')
                (home/'responses').write_text('null\n<html>not health</html>\n{"ok":true,"status":"healthy"}\n')
                mocks='node() { local n=$(cat "$HOME/probes"); (( n++ )); print "$n" > "$HOME/probes"; print probe >> "$HOME/calls"; /usr/bin/sed -n "${n}p" "$HOME/responses"; }; sleep() { print wait >> "$HOME/calls"; };'
                env=dict(os.environ,HOME=d);env.pop('ROBOB_INSTALL_HOLD_BY',None);env.pop('ROBOB_INSTALL_HOLD_PID',None)
                result=subprocess.run(['/bin/zsh','-f','-c',mocks+setup+'\nrc='+str(exit_code)+'\n'+tail],env=env,capture_output=True,timeout=10)
                self.assertEqual(result.returncode,exit_code)
                calls=(home/'calls').read_text().splitlines()
                self.assertTrue(calls[0].startswith('start '));self.assertTrue(calls[-1].startswith('stop '))
                self.assertEqual(calls[1:-1],['probe','wait','probe','wait','probe'])
    def test_shell_health_response_corpus(self):
        library=(SOURCE / 'scripts/install-hold.zsh').resolve()
        rows=[('<html>login</html>',False),('null',False),('[]',False),('{}',False),
              ('{"ok":true,"status":"starting"}',False),('{"ok":false,"status":"healthy"}',False),
              ('{"ok":"true","status":"healthy"}',False),('',False),('{"ok":',False),
              ('true',False),('1',False),('"healthy"',False),
              ('{"ok":true,"status":"healthy"}',True)]
        script='source "$1"; probe() { print -r -- "$1"; }; robob_hold_health probe "$2"'
        for response,healthy in rows:
            with self.subTest(response=response):
                result=subprocess.run(['/bin/zsh','-f','-c',script,'test',str(library),response],capture_output=True,timeout=10)
                self.assertEqual(result.returncode==0,healthy)
        script='source "$1"; probe() { print \'{"ok":true,"status":"healthy"}\'; return 5; }; robob_hold_health probe'
        result=subprocess.run(['/bin/zsh','-f','-c',script,'test',str(library)],capture_output=True,timeout=10)
        self.assertNotEqual(result.returncode,0)

class HoldTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);self.h=Holds(Path(t.name));self.pid=os.getpid()
    def test_start_beat_stop_matching_only(self):
        with patch('hold.subprocess.Popen') as spawn,patch('hold.time.time',return_value=10000):
            spawn.return_value.pid=987654;self.assertEqual(self.h.start('test',self.pid),987654)
        self.assertEqual(json.loads(self.h.path.read_text()),dict(by='test',pid=self.pid,startedAt=10000,beatAt=10000))
        with patch('hold.time.time',return_value=10020):self.assertTrue(self.h.beat('test',self.pid))
        self.assertEqual(json.loads(self.h.path.read_text())['beatAt'],10020)
        self.assertFalse(self.h.stop('other',self.pid));self.assertFalse(self.h.stop('test',self.pid+1));self.assertTrue(self.h.path.exists())
        self.assertTrue(self.h.stop('test',self.pid));self.assertFalse(self.h.path.exists())
    def test_foreign_hold_and_old_generation(self):
        with patch('hold.subprocess.Popen') as spawn:
            spawn.return_value.pid=987654;self.h.start('test',self.pid)
            with self.assertRaisesRegex(ValueError,'another live'):self.h.start('other',self.pid)
        self.assertFalse(self.h.beat('test',self.pid,'old-token'));self.assertFalse(self.h.beat('other',self.pid))
    def test_real_cli_lifecycle_in_temporary_home(self):
        env=dict(os.environ,HOME=str(self.h.home),PYTHONDONTWRITEBYTECODE='1')
        helper=str((SOURCE / 'bin/robob-install-hold').resolve())
        def call(action,by='cli'):
            return subprocess.run([helper,action,'--by',by,'--pid',str(self.pid)],env=env,check=True,capture_output=True,text=True,timeout=10)
        beater=int(call('start').stdout.strip())
        try:
            self.assertTrue(guard.pid_alive(beater))
            self.assertEqual(json.loads(self.h.path.read_text())['by'],'cli')
            call('beat');call('stop','foreign');self.assertTrue(self.h.path.exists())
            call('stop');self.assertFalse(self.h.path.exists())
        finally:
            self.h.stop('cli',self.pid)
            try:os.waitpid(beater,os.WNOHANG)
            except ChildProcessError:pass

    def test_dead_pid(self):
        with patch('hold.pid_alive',return_value=False):
            with self.assertRaises(ValueError):self.h.start('test',123)
            self.assertFalse(self.h.beat('test',123))
    def test_only_signals_verified_beater(self):
        guard.atomic_json(self.h.path,dict(by='test',pid=self.pid));guard.atomic_json(self.h.meta,dict(by='test',pid=self.pid,beaterPid=987654,token='unique'))
        with patch.object(self.h,'beater_is_ours',return_value=True),patch('hold.os.kill') as kill:
            self.h.stop('test',self.pid);kill.assert_called_once_with(987654,__import__('signal').SIGTERM)

if __name__=='__main__':unittest.main()
