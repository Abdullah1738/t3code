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
    def test_hold_corpus(self):
        rows=[(dict(by='install',pid=2,beatAt=10000),True,True),
              (dict(by='install',pid=2,beatAt=9910),True,False),
              (dict(by='install',pid=2,beatAt=9999),False,False),
              (dict(by='install',pid=2,beatAt=10001),True,False),
              (dict(by='install',pid=-1,beatAt=10000),True,False),
              (dict(by='install',pid=True,beatAt=10000),True,False),
              (dict(by='install',pid=2,beatAt=float('nan')),True,False),
              (dict(by='install',pid=2,beatAt='10000'),True,False),({},True,False),([],True,False)]
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
        self.opened();self.tick(200,hold=dict(by='install',pid=2,beatAt=self.now+200),hold_pid_alive=True)
        self.assertEqual(self.state['failed_reopens'],0);self.assertEqual(self.tick()[1],'none');self.assertEqual(self.tick()[1],'reopen')

class IOTests(unittest.TestCase):
    def test_exact_process(self):
        self.assertTrue(guard.robob_present(' 12 '+guard.EXECUTABLE+'\n'))
        for value in ['Robob',guard.EXECUTABLE+' Helper','python script Robob',guard.EXECUTABLE+'-old']:
            self.assertFalse(guard.robob_present(' 12 '+value))
    def test_clean_background_open(self):
        with patch.dict(os.environ,{'BUN_INSPECT':'1','TMUX':'x'}),patch('guard.subprocess.run') as run:
            guard.reopen(Path('/fake'));args,kw=run.call_args
            self.assertEqual(args[0],['/usr/bin/open','-g','-a',guard.APP]);self.assertEqual(set(kw['env']),{'HOME','USER','PATH'});self.assertEqual(kw['cwd'],'/')
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
            with patch('guard.process_up',return_value=False),patch('guard.boot_epoch',return_value=0),patch('guard.reopen') as opened,patch('guard.notify') as notified:
                guard.check(home);opened.assert_called_once_with(home);notified.assert_not_called()
                guard.atomic_json(home/'.robob/install-hold.json',dict(by='test',pid=os.getpid(),beatAt=__import__('time').time()))
                guard.check(home);self.assertEqual(opened.call_count,1)
                self.assertIn('hold:test',(p.parent/'guard.log').read_text())
    def test_process_failure_never_opens(self):
        with tempfile.TemporaryDirectory() as d,patch('guard.process_up',side_effect=OSError('ps')),patch('guard.reopen') as opened:
            guard.check(Path(d));opened.assert_not_called()
    def test_heartbeat_arriving_during_recheck_never_records_open(self):
        for beat in [10000,10000.5,10001]:
            with self.subTest(beat=beat),tempfile.TemporaryDirectory() as d:
                home=Path(d);p=home/'.local/state/robob-guard/state.json'
                guard.atomic_json(p,dict(guard.initial_state(),down_count=1))
                def process():
                    guard.atomic_json(home/'.robob/install-hold.json',dict(by='arriving',pid=os.getpid(),beatAt=beat))
                    return False
                with patch('guard.process_up',side_effect=process),patch('guard.boot_epoch',return_value=0),patch('guard.time.time',side_effect=[10000,10001]),patch('guard.reopen') as opened:
                    guard.check(home);opened.assert_not_called()
                state=guard.read_state(p)
                self.assertEqual(state['history'],[]);self.assertFalse(state['awaiting_reopen'])
                self.assertIn('hold:arriving',(p.parent/'guard.log').read_text())
    def test_plist(self):
        p=plistlib.loads(Path('scripts/com.ardud.robob-guard.plist').read_bytes());self.assertEqual(p['StartInterval'],30);self.assertIs(p['RunAtLoad'],True)
    def test_shell_syntax_without_execution(self):
        repo=Path(__file__).resolve().parents[2]
        scripts=['integrations/deploy.zsh','integrations/robob-guard/scripts/install-hold.zsh']
        scripts+=['tmp/memory/cutover/'+name+'.zsh' for name in
                  ['robob-restart-unattended','install-robob','install-robob-resume','missions-cutover-unattended']]
        for script in scripts:
            with self.subTest(script=script):
                subprocess.run(['/bin/zsh','-n',str(repo/script)],check=True,capture_output=True,timeout=10)
    def test_shell_nested_hold_preserves_exit_cleanup(self):
        library=Path('scripts/install-hold.zsh').resolve()
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
        library=Path('scripts/install-hold.zsh').resolve()
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
        blocks=re.findall(r'```zsh\n(.*?)```',Path('release-supervisor.md').read_text(),re.S)
        setup=blocks[0].replace('/Volumes/ExternalSSD/t3code-fork/integrations/robob-guard/scripts/install-hold.zsh',str(Path('scripts/install-hold.zsh').resolve()))
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
        library=Path('scripts/install-hold.zsh').resolve()
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
        helper=str(Path('bin/robob-install-hold').resolve())
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
