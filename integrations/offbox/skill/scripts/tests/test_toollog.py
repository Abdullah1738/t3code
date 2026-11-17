"""Shared logging and real call-site coverage; all backends are fixtures."""
import contextlib
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import toollog
from offbox_lib import cli, common, home, misc, pool, reap, runs, ssh_sync
from test_capacity import Isolated


class Logs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'logs'
        self.env = patch.dict(os.environ, OFFBOX_TOOL_LOG_DIR=str(self.root))
        self.env.start()
        self.addCleanup(self.env.stop)

    def rows(self):
        return [json.loads(line) for path in self.root.glob('*.ndjson') for line in path.read_text().splitlines()]

    def test_missing_stderr_metadata_survives_serialization(self):
        props = dict(stream='stderr', backend='boat', reason='history_empty')
        toollog.emit('run', 'run.log_stream_missing', kind='error', ok=False, ids={'run': 'run-fixture'}, props=props)
        self.assertEqual(self.rows()[0]['props'], props)

    def test_command_transport_fields_survive_serialization(self):
        for mode in ('argv', 'file'):
            for name in ('run.start', 'run.command'):
                toollog.emit('run', name, props={'cmd_bytes': 140111, 'cmd_via': mode, 'step_count': 39})
        self.assertEqual([row['props'] for row in self.rows()],
                         [{'cmd_bytes': 140111, 'cmd_via': mode, 'step_count': 39}
                          for mode in ('argv', 'file') for name in ('run.start', 'run.command')])

    def test_disk_attempt_and_space_metadata_survive_the_logger_filter(self):
        props = dict(tmp_free_bytes=123, tmp_size_bytes=456, tmp_fstype='tmpfs',
                     workspace_free_bytes=789, workspace_size_bytes=1024, workspace_fstype='zfs',
                     command_exit_code=2, wrapper_exit_code=2, disk_attempt=2,
                     infra_failure='enospc', infra_reason='disk_exhausted')
        toollog.emit('run', 'run.disk_space', props={**props, 'disk_space': {'path': '/private/secret'}})
        self.assertEqual(self.rows()[0]['props'], props)

    def test_toolchain_crash_metadata_survives_filter(self):
        for reason in ('toolchain_unpack_crash', 'go_inventory_crash'):
            with self.subTest(reason=reason):
                props = dict(infra_failure='native_crash', infra_reason=reason, wrapper_exit_code=90)
                toollog.emit('run', 'run.disk_space', ids={'box': 'bx_fixture'}, props=props)
                self.assertEqual(self.rows()[-1]['props'], props)
                self.assertEqual(self.rows()[-1]['ids'], {'box': 'bx_fixture'})

    def test_queue_resume_fields_survive_serialization_including_unknown_places(self):
        for place in (1, None):
            props = dict(outageS=15, waitedMs=31000, placeBefore=place, placeAfter=place, deadlineKept=True)
            toollog.emit('pool', 'run.queue_resumed', ids={'run': 'run-A'}, props=props)
            self.assertEqual(self.rows()[-1]['props'], props)

    def test_format_private_modes_and_only_allowed_metadata(self):
        secret = 'password=secret-1234567890123456'
        toollog.emit('run', 'run.request', ok=True, duration_ms=1.2345,
                     ids={'run': 'run-fixture', 'password': secret},
                     props={'bytes': 12, 'repo': toollog.repo_id(secret), 'backend': 'home', 'prompt': secret,
                            'token': secret, 'cookie': secret, 'password': secret, 'otp': secret,
                            'card': secret, 'body': secret, 'health': 90, 'reason': secret,
                            'commandClass': secret}, tag=secret)
        row = self.rows()[0]
        self.assertEqual(set(row), {'ts','tool','component','kind','name','durationMs','ok','ids','props'})
        self.assertRegex(row['ts'], r'^\d{4}-\d\d-\d\dT.*\.\d{3}Z$')
        self.assertEqual(row['props'], {'bytes': 12, 'repo': toollog.repo_id(secret), 'backend': 'home'})
        self.assertEqual(row['ids'], {'run': 'run-fixture'})
        self.assertNotIn(secret, json.dumps(row))
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        self.assertEqual(next(self.root.glob('*.ndjson')).stat().st_mode & 0o777, 0o600)

    def test_cap_once_across_threads_keeps_errors(self):
        toollog.emit('run', 'run.request')
        with patch.object(toollog, 'CAP_BYTES', 1):
            threads = [threading.Thread(target=toollog.emit, args=('run', 'run.sync')) for _ in range(20)]
            for t in threads: t.start()
            for t in threads: t.join()
            toollog.emit('run', 'run.error', kind='error', tag='fixture_error')
        names = [r['name'] for r in self.rows()]
        self.assertEqual(names, ['run.request', 'log.cap', 'run.error'])

    def test_first_write_retains_30_days_only_and_other_files(self):
        self.root.mkdir()
        today = datetime.now(timezone.utc).date()
        old = (today-timedelta(days=31)).isoformat()
        keep = (today-timedelta(days=30)).isoformat()
        for name in (old+'.ndjson', 'rollup-'+old+'.json', old+'.cap', keep+'.ndjson', 'unrelated.txt'):
            (self.root/name).touch()
        toollog.emit('run', 'run.request')
        self.assertFalse((self.root/(old+'.ndjson')).exists())
        self.assertFalse((self.root/('rollup-'+old+'.json')).exists())
        self.assertTrue((self.root/(keep+'.ndjson')).exists())
        self.assertTrue((self.root/'unrelated.txt').exists())

    def test_never_raises_on_unwritable_path_bad_types_nan_or_os_failure(self):
        self.root.touch()
        for kwargs in ({}, {'props': {'size': []}}, {'ids': {'run': object()}}, {'duration_ms': float('nan')}, {'props': object()}):
            toollog.emit('run', 'run.request', **kwargs)
        self.root.unlink()
        with patch.object(toollog.os, 'write', side_effect=OSError('disk full')):
            toollog.emit('run', 'run.request')
        # A broken log sink cannot change a wrapped function's return or exception.
        with patch.object(toollog, 'directory', side_effect=OSError('disk gone')):
            @toollog.observed('run','run.sync','sync_failed')
            def succeeds(): return 42
            self.assertEqual(succeeds(),42)
            with self.assertRaisesRegex(ValueError, 'original'):
                with toollog.span('run','run.sync'): raise ValueError('original')

    def test_fixture_rollup_counts_rates_percentiles_top20_and_atomic_mode(self):
        for n in range(1,101):
            toollog.emit('sync','run.sync',kind='perf',duration_ms=n,ok=n!=100)
        for n in range(25):
            toollog.emit('ssh','ssh.drop',kind='error',ok=False,tag='error_'+str(n),ids={'run':'run-fixture'})
        path = next(self.root.glob('*.ndjson'))
        with path.open('a') as f: f.write('{broken\n')
        result = toollog.rollup(path.stem)
        self.assertEqual(result['total'],125)
        self.assertEqual(result['countsByName'],{'run.sync':100,'ssh.drop':25})
        self.assertEqual(result['countsByKind'],{'perf':100,'error':25})
        self.assertEqual(result['durationMs']['run.sync'],{'p50':50,'p95':95,'max':100})
        self.assertAlmostEqual(result['okRate'],99/125)
        self.assertAlmostEqual(result['errorRate'],26/125)
        self.assertEqual(len(result['topErrors']),20)
        self.assertEqual(result['topErrors'][0]['sampleIds'], {'run':'run-fixture'})
        self.assertEqual(result['malformedLines'],1)
        self.assertFalse(result['sampled'])
        self.assertEqual(next(self.root.glob('rollup-*')).stat().st_mode & 0o777,0o600)
        with self.assertRaises(ValueError): toollog.rollup('../2026-01-01')

    def test_rollup_weights_sampled_counts_and_rates_but_not_percentiles(self):
        for ms, sampled, failed in ((1, True, False), (2, True, False), (3, True, True),
                                    (4, False, False), (5, False, True)):
            toollog.emit('gate', 'gate.decision', kind='error' if failed else 'perf',
                         ok=not failed, duration_ms=ms, props={'sample': 20} if sampled else {},
                         tag='gate_failed' if failed else None)
        path = next(self.root.glob('*.ndjson'))
        result = toollog.rollup(path.stem)
        self.assertEqual(result['total'], 62)
        self.assertEqual(result['countsByName'], {'gate.decision': 62})
        self.assertEqual(result['countsByKind'], {'perf': 41, 'error': 21})
        self.assertTrue(result['sampled'])
        self.assertAlmostEqual(result['okRate'], 41/62)
        self.assertAlmostEqual(result['errorRate'], 21/62)
        self.assertEqual(result['topErrors'][0]['count'], 21)
        self.assertEqual(result['durationMs']['gate.decision'], {'p50': 3, 'p95': 5, 'max': 5})
        self.assertEqual(result['malformedLines'], 0)

    def test_rollup_defaults_invalid_sample_weights_to_one(self):
        weights = (None, True, False, 0, -20, 2.5, '20', [], {})
        self.root.mkdir()
        path = self.root / '2026-11-14.ndjson'
        path.write_text(''.join(json.dumps({'tool': 'offbox', 'name': 'gate.decision', 'kind': 'perf',
                                           'ok': True, 'props': {'sample': weight}}) + '\n' for weight in weights))
        result = toollog.rollup(path.stem)
        self.assertEqual(result['total'], len(weights))
        self.assertFalse(result['sampled'])
        self.assertEqual(result['okRate'], 1)
        self.assertEqual(result['malformedLines'], 0)

    def test_rollup_weights_only_explicit_ok_values_in_ok_rate(self):
        toollog.emit('gate', 'gate.decision', kind='perf', props={'sample': 20})
        toollog.emit('gate', 'gate.decision', kind='error', ok=False, tag='gate_failed')
        result = toollog.rollup(next(self.root.glob('*.ndjson')).stem)
        self.assertEqual(result['total'], 21)
        self.assertEqual(result['okRate'], 0)
        self.assertAlmostEqual(result['errorRate'], 1/21)

    def test_rollup_cli_and_first_recurring_tick_after_0005(self):
        toollog.emit('run','run.request',ok=True)
        day=next(self.root.glob('*.ndjson')).stem
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cli.main(['log-rollup','--day',day]),0)
        self.assertEqual(json.loads(out.getvalue())['countsByName'],{'run.request':1})
        class Clock(datetime):
            value=datetime(2026,11,13,0,4,tzinfo=timezone.utc)
            @classmethod
            def now(cls,tz=None): return cls.value
        with patch.object(toollog,'datetime',Clock), patch.object(toollog,'rollup',wraps=toollog.rollup) as roll:
            toollog.rollup_previous()
            roll.assert_not_called()
            Clock.value=datetime(2026,11,13,0,5,tzinfo=timezone.utc)
            toollog.rollup_previous()
            toollog.rollup_previous()
            self.assertEqual(roll.call_count,1)
            self.assertEqual(roll.call_args.args,('2026-11-12',))


class Instrumentation(Isolated):
    # Exercise the logging wrappers; the failover test stubs _probe and traps execve.
    guard_home_failover = False

    def setUp(self):
        super().setUp()
        for name in ('SSH_DIR', 'CM_DIR', 'KEY_PATH'):
            self.stack.enter_context(patch.object(ssh_sync, name, Path(self.tmp.name)/name))
        ssh_sync.SSH_DIR.mkdir(exist_ok=True)
        self.logdir = Path(self.tmp.name)/'shared-logs'
        self.stack.enter_context(patch.dict(os.environ, OFFBOX_TOOL_LOG_DIR=str(self.logdir)))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def rows(self, name):
        return [json.loads(line) for p in self.logdir.glob('*.ndjson') for line in p.read_text().splitlines()
                if json.loads(line)['name']==name]

    def outcomes(self, name):
        self.assertEqual({r['ok'] for r in self.rows(name)}, {True,False},name)

    def test_cli_commands_success_and_failure(self):
        from offbox_lib import bases
        cases = [('wait',['run-fixture'],misc,'wait'),('logs',['run-fixture'],misc,'logs'),
                 ('kill',['run-fixture'],misc,'kill_run'),('save',[],bases,'save'),
                 ('status',[],misc,'status'),('ssh',['bx_fixture'],misc,'ssh_shell'),
                 ('reap',[],reap,'reap'),('local',['--reason','fixture task'],misc,'local_exempt')]
        with patch('offbox_lib.identity.whoami',return_value=self.me):
            for name, args, mod, fn in cases:
                with patch.object(mod,fn,return_value={} if name=='save' else [] if name=='reap' else 0):
                    self.assertEqual(cli.main([name,*args]),0)
                with patch.object(mod,fn,side_effect=common.OffboxError('secret raw exception',code=90)):
                    self.assertEqual(cli.main([name,*args]),90)
                self.outcomes('cli.'+name)

    def test_run_request_and_all_infra_exit_reasons(self):
        a=cli.build_parser().parse_args(['run','--no-fallback','--env','TOKEN=never-log-me','--','echo','private prompt'])
        with patch.object(home,'may_fail_over',return_value=False), patch.object(home,'on_standby',return_value=False):
            with patch.object(cli,'_remote_once',return_value=0): self.assertEqual(cli.cmd_run(a,self.me),0)
            for code in (90,91,92,93):
                with patch.object(cli,'_remote_once',side_effect=common.OffboxError('private error',code=code)), patch('offbox_lib.fallback.note_infra_failure'):
                    self.assertEqual(cli.cmd_run(a,self.me),code)
        self.outcomes('run.invocation')
        self.assertEqual({r['error']['tag'] for r in self.rows('run.error')}, {'exit_90','exit_91','exit_92','exit_93'})
        self.assertNotIn('never-log-me',next(self.logdir.glob('*.ndjson')).read_text())
        self.assertEqual(self.rows('run.request')[0]['props']['envCount'],1)

    def test_sync_pull_and_upload_outcomes(self):
        stats={'sent':123,'files':4}
        with patch.object(ssh_sync,'_push_files',return_value=stats), patch.object(ssh_sync,'tracked_secret_matches',return_value=['.env']):
            ssh_sync.push('bx_fixture',Path(self.me['repo_root']),'work',run_id='run-fixture')
        with patch.object(ssh_sync,'_push_files',side_effect=common.OffboxError('private error')):
            with self.assertRaises(common.OffboxError): ssh_sync.push('bx_fixture',Path(self.me['repo_root']),'work')
        self.outcomes('run.sync')
        self.assertEqual(self.rows('run.sync')[0]['props'],{'bytes':123,'files':4,'skipped':1})
        for rc in (0,23):
            with patch.object(ssh_sync,'ssh_base',return_value=['ssh']),patch.object(ssh_sync.subprocess,'run',return_value=subprocess.CompletedProcess([],rc,'Total bytes received: 40\nNumber of regular files transferred: 2','failure')):
                ssh_sync.pull('bx_fixture','work','.','artifact',Path(self.tmp.name))
        self.outcomes('run.pull')
        for failure in (False,True):
            with patch.object(ssh_sync,'ssh',side_effect=subprocess.TimeoutExpired('ssh',1) if failure else None):
                if failure:
                    with self.assertRaises(subprocess.TimeoutExpired): ssh_sync.put_file('bx_fixture','env',b'PASSWORD=private')
                else: ssh_sync.put_file('bx_fixture','env',b'PASSWORD=private')
        self.outcomes('ssh.put_file')
        self.assertEqual(self.rows('ssh.put_file')[-1]['error']['tag'],'put_file_timeout')

    def test_ssh_setup_readiness_and_drop(self):
        endpoint={'sshEndpoint':'localhost:22','hostKey':'fake-host-key'}
        with patch.object(ssh_sync,'pubkey',return_value='fixture-key'),patch.object(ssh_sync.api,'sshkey',return_value=endpoint):
            ssh_sync.setup('bx_fixture')
        with patch.object(ssh_sync,'pubkey',return_value='fixture-key'),patch.object(ssh_sync.api,'sshkey',side_effect=ValueError('secret')):
            with self.assertRaises(ValueError): ssh_sync.setup('bx_fixture')
        self.outcomes('ssh.setup')
        with patch.object(ssh_sync,'ssh',return_value=subprocess.CompletedProcess([],0,b'',b'')):
            ssh_sync.wait_ssh('bx_fixture',1)
        with self.assertRaises(common.OffboxError): ssh_sync.wait_ssh('bx_fixture',0)
        self.outcomes('ssh.readiness')
        with patch.object(ssh_sync.subprocess,'run',return_value=subprocess.CompletedProcess([],255,b'',b'private stderr')):
            ssh_sync.ssh('bx_fixture','private command')
        self.assertEqual(self.rows('ssh.drop')[0]['error']['tag'],'ssh_drop')

    def test_health_failover_reaper_and_install_detach(self):
        from offbox_lib import api
        for result in (None,'home down'):
            with patch.object(home,'_probe',return_value=result): home.probe()
        self.outcomes('home.probe')
        with patch.object(home,'record_failure'), patch.object(api,'probe_backend',return_value=None), \
                patch.object(home.os,'execve',side_effect=RuntimeError('exec replaced')):
            with self.assertRaises(RuntimeError): home.fail_over('private reason', ['run'], 'run-fixture')
        self.assertEqual(self.rows('backend.failover')[0]['props']['from'],'home')
        with patch.object(reap,'_reap_logged',return_value=['stop bx_fixture']): reap.reap()
        with patch.object(reap,'_reap_logged',side_effect=common.OffboxError('failed')):
            with self.assertRaises(common.OffboxError): reap.reap()
        with patch.object(reap,'_reap_logged',return_value=['stop bx_fixture (FAILED: secret)']): reap.reap()
        self.assertFalse(self.rows('reaper.pass')[-1]['ok'])
        self.assertFalse(self.rows('reaper.action')[-1]['ok'])
        self.outcomes('reaper.pass')
        self.assertEqual(self.rows('reaper.action')[0]['props']['action'],'stop')
        rn=runs.Runner(cli.build_parser().parse_args(['run','--','true']),self.me)
        with patch.object(rn,'record'),patch.object(runs,'save_run_state'),patch.object(runs,'db',side_effect=common.OffboxError('fixture stop')):
            self.assertEqual(runs._detach(rn,15),common.EXIT_DETACHED)
        self.assertEqual(self.rows('run.error')[-1]['error']['tag'],'install_mid_run')

    def test_install_landing_during_run_is_detected_without_affecting_result(self):
        with patch.object(runs,'_source_stamp',return_value=('new installed source',)):
            runs._log_source_change('run-fixture')
        row=self.rows('run.error')[0]
        self.assertEqual(row['error']['tag'],'install_mid_run')
        self.assertEqual(row['props']['stage'],'install_mid_run')
        with patch.object(runs,'_source_stamp',side_effect=OSError('unreadable installed source')):
            runs._log_source_change('run-fixture')
        self.assertEqual(len(self.rows('run.error')),1)

    def test_pool_lease_success_failure_and_snapshot(self):
        row={'box_id':'bx_fixture','_log_lease_kind':'saved-base'}
        with patch.object(pool,'_acquire_logged',return_value=row): pool.acquire(self.me,run_id='run-fixture')
        with patch.object(pool,'_acquire_logged',side_effect=common.OffboxError('no capacity')):
            with self.assertRaises(common.OffboxError): pool.acquire(self.me)
        self.outcomes('run.lease')
        self.assertEqual(self.rows('run.lease')[0]['props']['leaseKind'],'saved-base')
        self.box('bx_deleted',state='deleted')
        self.box('bx_fixture',member=True)
        self.busy('bx_fixture')
        rn=runs.Runner(cli.build_parser().parse_args(['run','--','true']),self.me)
        rn._log_pool(self.con)
        snapshot=next(r for r in self.rows('pool.snapshot') if r['props']['backend']=='boat')['props']
        self.assertEqual((snapshot['busy'],snapshot['idle'],snapshot['stopped']),(1,0,0))

    def test_terminal_command_and_end_success_failure(self):
        for n, code in enumerate((0,1)):
            rid='run-end-'+str(n)
            self.con.execute("INSERT INTO runs(run_id,status,mode,start_at,process_id,setup_s) VALUES (?,'running','fg',?,123,1)",(rid,common.now()-3))
            self.con.commit()
            self.con.execute("UPDATE runs SET command_at=? WHERE run_id=?",(common.now()-1,rid))
            self.con.commit()
            self.assertEqual(runs.finish(rid,code,bookkeeping=False),code)
            self.assertEqual(runs.finish(rid,code,bookkeeping=False),code)
        self.outcomes('run.command'); self.outcomes('run.end')
        self.assertEqual(len(self.rows('run.end')),2)
        self.assertNotIn('durationMs',self.rows('run.command')[0])

    def test_recovered_start_logs_once_even_when_settlement_already_committed(self):
        from offbox_lib import start_check
        for index, code in enumerate((0, 7),1):
            rid='run-recovered-'+str(code)
            self.con.execute("INSERT INTO runs(run_id,status,mode,start_at,wrapper_pid) VALUES (?,'starting','bg',?,456)",(rid,common.now()-2))
            self.con.commit()
            row=self.con.execute('SELECT * FROM runs WHERE run_id=?',(rid,)).fetchone()
            start_check.settle(self.con,row,start_check.Result('started',code,456),'fixture recovery')
            self.assertEqual(len(self.rows('run.end')),index)
            self.assertEqual(len(self.rows('run.command')),index)
            runs.finish(rid,code,bookkeeping=False)
            runs.finish(rid,code,bookkeeping=False)
        self.outcomes('run.command'); self.outcomes('run.end')
        self.assertEqual(len(self.rows('run.command')),2)
        self.assertEqual(len(self.rows('run.end')),2)

    def test_unknown_start_stays_open_for_later_confirmed_terminal_log(self):
        from offbox_lib import start_check
        rid='run-uncertain'
        self.con.execute("INSERT INTO runs(run_id,status,mode,start_at,wrapper_pid) VALUES (?,'starting','fg',?,456)",(rid,common.now()-2))
        self.con.commit()
        row=self.con.execute('SELECT * FROM runs WHERE run_id=?',(rid,)).fetchone()
        start_check.settle(self.con,row,start_check.Result(pid=456),'fixture unknown')
        self.assertEqual(self.rows('run.end'),[])
        row=self.con.execute('SELECT * FROM runs WHERE run_id=?',(rid,)).fetchone()
        start_check.settle(self.con,row,start_check.Result('started',0,456),'fixture confirmed')
        self.assertEqual(len(self.rows('run.end')),1)
        self.assertEqual(len(self.rows('run.command')),1)

    def test_reaper_and_pool_recovery_emit_terminal_logs_without_finish(self):
        from offbox_lib import lease, start_check
        for caller in ('reaper','pool'):
            for code in (0,7):
                rid='run-recover-'+caller+'-'+str(code)
                bid='bx_'+caller+str(code)
                self.box(bid,member=True)
                self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,start_at,client_pid) VALUES (?,?,'starting','bg',?,999999999)",(rid,bid,common.now()-500))
                self.con.execute("INSERT INTO kv(k,v) VALUES (?, '1')",('start_claim:'+rid,))
                self.con.execute("INSERT INTO kv(k,v) VALUES (?, '1')",('start_unattached:'+rid,))
                self.con.commit()
                with patch.object(start_check,'check',return_value=start_check.Result('started',code,456)), \
                        patch.object(misc,'_client_alive',return_value=False), patch.object(lease,'idle_ttl'), \
                        patch.object(runs,'reconcile_lost'), patch.object(misc,'_catch_up_finished'):
                    for _ in range(2):
                        if caller=='reaper': reap._check_unlocked(self.con,bid,'running',False,[],{'checks':3})
                        else: pool._refresh_background(self.con,'repo')
                for name in ('run.command','run.end'):
                    rows=[r for r in self.rows(name) if r.get('ids',{}).get('run')==rid]
                    self.assertEqual(len(rows),1,(caller,code,name))
                    self.assertEqual(rows[0]['props']['exitCode'],code)

    def test_local_override_keeps_reason_out(self):
        with patch.object(misc,'require_proven'),patch.object(misc,'EXEMPTIONS',Path(self.tmp.name)/'exemptions.json'):
            misc.local_exempt(self.me,'credential bound task private','2h',False,False)
        row=self.rows('local.override')[0]
        self.assertEqual(row['props'],{'ttlSeconds':7200,'reasonLength':29})


if __name__ == '__main__': unittest.main()
