"""Offline lost-start proofs using real bash wrappers and isolated run state."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, cli, common, fallback, lease, misc, outage, pool, reap, runs, ssh_sync, start_check
from test_capacity import Isolated


class ShellChecks(Isolated):
    def setUp(self):
        super().setUp()
        self.home = Path(self.tmp.name) / 'home'
        self.home.mkdir()
        self.env = dict(HOME=str(self.home), PATH=os.environ['PATH'])
        self.stack.enter_context(patch.object(ssh_sync, 'ssh', side_effect=self.ssh))

    def ssh(self, box, command, **kw):
        return subprocess.run(['bash', '-c', command], env=self.env, capture_output=True, timeout=kw.get('timeout', 10))

    def wrapper(self, run='run-test', command='exit 1'):
        return self.ssh('bx', runs.exit_recording_command(command, run))

    def receipt(self, run, code):
        p = self.home / f'.offbox/exit/{run}.rc'
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(str(code))

    def claim(self, run):
        p = self.home / f'.offbox/claim/{run}'
        p.mkdir(parents=True)
        (p / 'pid').write_text('12345')
        return p

    def test_fenced_late_delivery_cannot_execute(self):
        self.assertEqual(start_check.check('bx', 'run-test').verdict, 'fenced')
        p = self.wrapper(command='touch "$HOME/side-effect"')
        self.assertEqual(p.returncode, 98, p.stderr)
        self.assertIn(b'offbox-claim-refused', p.stderr)
        self.assertFalse((self.home / 'side-effect').exists())

    def test_wrapper_runs_once_and_keeps_original_receipt(self):
        self.assertEqual(self.wrapper(command='echo x >> "$HOME/count"; exit 1').returncode, 1)
        self.assertEqual(self.wrapper(command='echo y >> "$HOME/count"').returncode, 98)
        self.assertEqual((self.home / 'count').read_text(), 'x\n')
        self.assertEqual(start_check.check('bx', 'run-test').code, 1)
        self.assertGreater(int((self.home / '.offbox/claim/run-test/pid').read_text()), 1)

    def test_aged_claim_never_expires(self):
        c = self.claim('run-aged')
        os.utime(c, (time.time()-5*86400,)*2)
        self.assertEqual(self.wrapper('run-other').returncode, 1)
        self.assertTrue(c.exists())
        self.assertEqual(self.wrapper('run-aged', 'touch "$HOME/late"').returncode, 98)
        self.assertFalse((self.home / 'late').exists())

    def test_pgrep_missing_or_error_is_unknown(self):
        self.claim('run-held')
        for status in (2, 127):
            command = f'pgrep() {{ return {status}; }}; ' + start_check.script('run-held', True)
            with patch.object(ssh_sync, 'ssh', side_effect=lambda box, cmd, **kw: self.ssh(box, command, **kw)):
                self.assertEqual(start_check.check('bx', 'run-held').verdict, 'unknown')
        self.receipt('run-held', 1)
        command = 'pgrep() { return 127; }; ' + start_check.script('run-held', True)
        with patch.object(ssh_sync, 'ssh', side_effect=lambda box, cmd, **kw: self.ssh(box, command, **kw)):
            self.assertEqual(start_check.check('bx', 'run-held').code, 1)

    def test_receipt_is_read_again_after_process_probe(self):
        self.claim('run-race')
        command = ('pgrep() { mkdir -p "$HOME/.offbox/exit"; echo 7 > "$HOME/.offbox/exit/run-race.rc"; return 1; }; '
                   + start_check.script('run-race', True))
        with patch.object(ssh_sync, 'ssh', side_effect=lambda box, cmd, **kw: self.ssh(box, command, **kw)):
            self.assertEqual(start_check.check('bx', 'run-race').code, 7)

    def test_legacy_check_reads_receipt_without_taking_claim(self):
        self.assertEqual(start_check.check('bx', 'run-old', claim=False).verdict, 'unknown')
        self.assertFalse((self.home / '.offbox/claim/run-old').exists())
        self.receipt('run-old', 1)
        self.assertEqual(start_check.check('bx', 'run-old', claim=False).code, 1)


class StartPaths(Isolated):
    def setUp(self):
        super().setUp()
        self.box('bx', member=True)
        self.stack.enter_context(patch.object(api, '_key', return_value='fake'))
        self.stack.enter_context(patch('urllib.request.urlopen', side_effect=AssertionError('unexpected boat call')))
        self.stack.enter_context(patch.object(pool, 'acquire', side_effect=lambda *a, **kw: dict(box_id='bx', remote_dir='w/r', size='large')))
        self.stack.enter_context(patch.object(runs.Runner, '_prepare_box', return_value=None))
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.stack.enter_context(patch.object(start_check, 'GRACE_S', 0))
        self.stack.enter_context(patch.object(fallback, 'note_infra_failure'))
        self.local = self.stack.enter_context(patch.object(fallback, 'run_local'))

    def run_cli(self, err, result, bg=False):
        a = cli.build_parser().parse_args(['run', '--remote'] + (['--bg'] if bg else []) + ['--', 'go test ./...'])
        out, log = io.StringIO(), io.StringIO()
        with patch.object(api, 'cmd_start', side_effect=err) as send, patch.object(start_check, 'check', return_value=result) as checked, \
                patch.object(outage, 'window_seconds', return_value=0), contextlib.redirect_stdout(out), contextlib.redirect_stderr(log):
            code = cli.cmd_run(a, self.me)
        self.check_calls = checked.call_count
        row = self.con.execute('SELECT * FROM runs ORDER BY rowid DESC LIMIT 1').fetchone()
        self.local.assert_not_called()
        return code, row, out.getvalue()+log.getvalue(), send

    def test_all_ambiguous_start_forms_fence_and_settle_foreground_and_bg(self):
        errors = [api.NetworkError('connection reset')] + [api.ApiError(s, f'http_{s}', '') for s in (500,502,503,504,520,524,599)]
        for bg in (False, True):
            for error in errors:
                with self.subTest(bg=bg,error=error):
                    code, row, output, send = self.run_cli(error, start_check.Result('fenced'), bg)
                    self.assertEqual(code, 90)
                    self.assertNotEqual(row['status'], 'starting')
                    self.assertEqual(lease.active_runs(self.con, 'bx'), 0)
                    self.assertIn(row['run_id'], output)
                    self.assertIn('Nothing ran', output)
                    self.assertEqual(send.call_count, 1)

    def test_timeout_that_executed_returns_real_failure(self):
        error = api.ApiError(502, 'sandbox_direct_failed', 'Request timeout after 39994ms')
        self.assertFalse(api._never_delivered(502, error.api_code, error.message))
        code, row, output, send = self.run_cli(error, start_check.Result('started', 1, 12345))
        self.assertEqual(code, 1)
        self.assertEqual((row['status'],row['exit_code']), ('failed',1))
        self.assertIn('live output unavailable', output)
        self.assertEqual(send.call_count, 1)

    def test_normal_cmd_start_records_the_api_id_unchanged(self):
        a = cli.build_parser().parse_args(['run', '--remote', '--bg', '--', 'go test ./...'])
        with patch.object(api, 'cmd_start', return_value={'processId': 1001, 'commandId': 'cmd-own'}), \
                patch.object(api, 'get', return_value={'state': 'running'}), \
                patch.object(lease, 'ensure_ttl'), contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.cmd_run(a, self.me), 0)
        row = self.con.execute('SELECT * FROM runs ORDER BY rowid DESC LIMIT 1').fetchone()
        self.assertEqual((row['process_id'], row['command_id'], row['wrapper_pid']), (1001, 'cmd-own', None))

    def test_start_recovery_records_only_wrapper_pid_foreground_and_background(self):
        for backend in ('boat', 'server'):
            for bg in (False, True):
                for wrapper in (4242, 1002):
                    with self.subTest(backend=backend, bg=bg, wrapper=wrapper), \
                            patch.object(api, 'BACKEND', backend), \
                            patch.object(api, 'cmd_status') as status, patch.object(api, 'cmd_kill') as kill:
                        code, row, _, _ = self.run_cli(api.NetworkError('reset'),
                                                       start_check.Result('started', 7, wrapper), bg=bg)
                        self.assertEqual(code, 0 if bg else 7)
                        self.assertIsNone(row['process_id'])
                        self.assertEqual(row['wrapper_pid'], wrapper)
                        self.assertEqual((row['status'], row['exit_code']), ('failed', 7))
                        status.assert_not_called()
                        kill.assert_not_called()

    def test_unknown_or_held_claim_settles_and_quarantines(self):
        for result in (start_check.Result(), start_check.Result('started', pid=12345)):
            code, row, output, send = self.run_cli(api.NetworkError('reset'), result, bg=True)
            self.assertEqual(code, 90)
            self.assertEqual(row['status'], 'infra')
            self.assertIn(row['run_id'], output)
            self.assertIn('offbox ssh bx', output)
            self.assertGreater(lease.active_runs(self.con, 'bx'), 0)
            self.assertIn(row['run_id'], row['error'])

    def test_refused_and_cf_do_not_ssh_check(self):
        for status in (409, *api.CF_NOT_DELIVERED):
            with patch.object(start_check, 'check') as check:
                self.run_cli(api.ApiError(status, 'refused', ''), start_check.Result())
            self.assertEqual(self.check_calls,0)

    def test_fenced_outage_retry_uses_new_id_once(self):
        a = cli.build_parser().parse_args(['run', '--remote', '--', 'go test ./...'])
        with patch.object(api, 'cmd_start', side_effect=[api.ApiError(500,'http_500',''), api.NetworkError('reset')]) as send, \
                patch.object(start_check, 'check', side_effect=[start_check.Result('fenced'),start_check.Result('started',1)]), \
                patch.object(outage, 'wait_until_up', return_value=True) as wait, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.cmd_run(a,self.me),1)
        rows = self.con.execute('SELECT * FROM runs').fetchall()
        self.assertEqual(len(rows),2)
        self.assertNotEqual(rows[0]['run_id'],rows[1]['run_id'])
        self.assertNotIn('starting', [r['status'] for r in rows])
        self.assertEqual(send.call_count,2)
        wait.assert_called_once()
        for row, call in zip(rows,send.call_args_list):
            self.assertIn(row['run_id'],call.args[1])

    def test_unknown_start_blocks_even_an_allowed_local_fallback(self):
        a = cli.build_parser().parse_args(['run','--','echo hello'])
        with patch.object(api,'cmd_start',side_effect=api.NetworkError('reset')), \
                patch.object(start_check,'check',return_value=start_check.Result()), \
                patch.object(fallback,'allowed',return_value=True), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.cmd_run(a,self.me),90)
        self.local.assert_not_called()

    def test_background_receipt_prints_id_and_settles(self):
        code,row,output,send = self.run_cli(api.NetworkError('reset'),start_check.Result('started',1),bg=True)
        self.assertEqual(code,0)
        self.assertEqual((row['status'],row['exit_code']),('failed',1))
        self.assertIn(row['run_id'],output)

    def test_recovered_completion_pulls_before_terminal_status_fg_and_bg(self):
        for bg in (False,True):
            path = ('bg' if bg else 'fg') + '.txt'
            a = cli.build_parser().parse_args(['run','--remote'] + (['--bg'] if bg else [])
                                              + ['--pull',path,'--','go test ./...'])
            def pull(box,remote,rel,path,dest,**opts):
                row = self.con.execute('SELECT status FROM runs ORDER BY rowid DESC LIMIT 1').fetchone()
                self.assertEqual(row['status'],'running')
                (Path(self.tmp.name) / path).write_text('artifact')
                return {'ok':True,'files':1}
            with patch.object(api,'cmd_start',side_effect=api.NetworkError('reset')), \
                    patch.object(start_check,'check',return_value=start_check.Result('started',1)), \
                    patch.object(ssh_sync,'pull',side_effect=pull), contextlib.redirect_stderr(io.StringIO()), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.cmd_run(a,self.me),0 if bg else 1)
            self.assertEqual((Path(self.tmp.name) / path).read_text(),'artifact')
            row = self.con.execute('SELECT * FROM runs ORDER BY rowid DESC LIMIT 1').fetchone()
            self.assertEqual((row['status'],row['exit_code']),('failed',1))


class RecoveryPaths(ShellChecks):
    def setUp(self):
        super().setUp()
        self.box('bx', member=True)
        self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,start_at,client_pid) VALUES ('run-dead','bx','starting','bg',?,424242)", (common.now()-360,))
        self.con.execute("INSERT INTO kv(k,v) VALUES ('start_claim:run-dead','1')")
        self.con.commit()
        self.stack.enter_context(patch.object(misc, '_client_alive', return_value=False))
        self.stack.enter_context(patch.object(runs, 'reconcile_lost'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(misc, '_catch_up_finished'))

    def row(self):
        return self.con.execute("SELECT * FROM runs WHERE run_id='run-dead'").fetchone()

    def test_reap_dead_box_assigned_takes_claim_releases_pool(self):
        reap._check_unlocked(self.con,'bx','running',False,[])
        self.assertEqual(self.row()['status'],'lost')
        self.assertIn('nothing ran',self.row()['error'])
        self.assertEqual(lease.active_runs(self.con,'bx'),0)

    def test_reap_held_or_failed_ssh_ends_infra_reserves_box(self):
        for result in (start_check.Result('started',pid=12345), start_check.Result()):
            self.con.execute("UPDATE runs SET status='starting',process_id=NULL WHERE run_id='run-dead'")
            self.con.commit()
            with patch.object(start_check,'check',return_value=result):
                reap._check_unlocked(self.con,'bx','running',False,[])
            self.assertEqual(self.row()['status'],'infra')
            self.assertIn('run-dead',self.row()['error'])
            self.assertGreater(lease.active_runs(self.con,'bx'),0)

    def test_reap_legacy_receipt_wins(self):
        self.con.execute("DELETE FROM kv WHERE k='start_claim:run-dead'")
        self.con.commit()
        self.receipt('run-dead',1)
        reap._check_unlocked(self.con,'bx','running',False,[])
        self.assertEqual((self.row()['status'],self.row()['exit_code']),('failed',1))

    def test_reap_live_client_no_error_untouched(self):
        with patch.object(misc,'_client_alive',return_value=True), patch.object(start_check,'check') as check:
            reap._check_unlocked(self.con,'bx','running',False,[])
        self.assertEqual(self.row()['status'],'starting')
        check.assert_not_called()

    def test_reap_dry_or_low_budget_does_not_claim(self):
        for dry,left in ((True,100),(False,1)):
            with patch.object(api,'left',return_value=left), patch.object(start_check,'check') as check:
                reap._check_unlocked(self.con,'bx','running',dry,[])
            check.assert_not_called()
        self.assertFalse((self.home / '.offbox/claim/run-dead').exists())

    def test_wait_legacy_receipt_returns_one(self):
        self.con.execute("DELETE FROM kv WHERE k='start_claim:run-dead'")
        self.con.commit()
        self.receipt('run-dead',1)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.wait('run-dead',10),1)
        self.assertEqual(self.row()['status'],'failed')

    def test_wait_ssh_failure_settles_and_names_hint(self):
        with patch.object(ssh_sync,'ssh',side_effect=OSError('offline')):
            with self.assertRaises(common.OffboxError) as error:
                misc.wait('run-dead',10)
        self.assertIn('run-dead',str(error.exception))
        self.assertIn('offbox ssh bx',str(error.exception))
        self.assertEqual(self.row()['status'],'infra')
        self.assertGreater(lease.active_runs(self.con,'bx'),0)

    def test_wait_running_claim_then_receipt(self):
        with patch.object(start_check,'check',side_effect=[start_check.Result('started',pid=12345),start_check.Result('started',1,12345)]), \
                patch.object(misc.time,'sleep'), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.wait('run-dead',10),1)
        self.assertEqual((self.row()['status'],self.row()['exit_code']),('failed',1))

    def test_wait_fenced_returns_infra_without_attaching(self):
        with patch.object(runs,'follow',side_effect=AssertionError('no process')), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.wait('run-dead',10),90)
        self.assertEqual(self.row()['status'],'lost')
        self.assertEqual(lease.active_runs(self.con,'bx'),0)

    def test_reservation_survives_failed_stop_confirmation(self):
        start_check.settle(self.con,self.row(),start_check.Result(),'reset')
        with patch.object(api,'get',side_effect=common.OffboxError('offline')):
            self.assertFalse(lease._release_locked(self.con,'bx'))
        self.assertGreater(lease.active_runs(self.con,'bx'),0)
        with patch.object(api,'get',return_value={'state':'archived'}):
            self.assertTrue(lease._release_locked(self.con,'bx'))
        self.assertEqual(lease.active_runs(self.con,'bx'),0)

    def test_reap_no_box_dead_client_still_released_early(self):
        self.con.execute("UPDATE runs SET box_id=NULL WHERE run_id='run-dead'")
        self.con.commit()
        with patch.object(api,'list_boxes',return_value=[]), patch.object(api,'get',return_value=None), patch.object(reap,'_protected',return_value=set()):
            reap._reap(self.con,False,[])
        self.assertEqual(self.row()['status'],'lost')
        self.assertIn('before it got a box',self.row()['error'])

    def test_reap_reserves_a_receipt_follower_with_no_pid(self):
        self.con.execute("UPDATE runs SET status='running' WHERE run_id='run-dead'")
        self.con.execute("INSERT INTO kv(k,v) VALUES ('start_unattached:run-dead','1')")
        self.con.commit()
        with patch.object(start_check,'check',return_value=start_check.Result('started')):
            reap._check_unlocked(self.con,'bx','running',False,[])
        self.assertEqual(self.row()['status'],'infra')
        self.assertGreater(lease.active_runs(self.con,'bx'),0)

    def test_wait_deadline_during_ssh_leaves_row_for_next_wait(self):
        clock = [common.now()]
        def late(*args,**kwargs):
            clock[0] += 10
            return start_check.Result('started',1)
        with patch.object(misc,'now',side_effect=lambda:clock[0]), patch.object(start_check,'check',side_effect=late):
            with self.assertRaises(common.OffboxError) as error:
                misc.wait('run-dead',5)
        self.assertEqual(error.exception.code,124)
        self.assertEqual(self.row()['status'],'starting')

    def test_wait_and_reap_pull_recovered_artifacts_before_settling(self):
        self.receipt('run-dead',1)
        for route in ('wait','reap'):
            path = route + '.txt'
            self.con.execute("UPDATE runs SET status='starting',exit_code=NULL,end_at=NULL,remote_dir='w/r', "
                             "rel_cwd='.',local_cwd=?,pulls=? WHERE run_id='run-dead'",
                             (self.tmp.name, '["' + path + '"]'))
            self.con.commit()
            def pull(box,remote,rel,path,dest,**opts):
                self.assertEqual(self.row()['status'],'starting')
                (dest / path).write_text('artifact')
                return {'ok':True,'files':1}
            with patch.object(ssh_sync,'pull',side_effect=pull), contextlib.redirect_stderr(io.StringIO()), \
                    contextlib.redirect_stdout(io.StringIO()):
                if route == 'wait':
                    self.assertEqual(misc.wait('run-dead',10),1)
                else:
                    reap._check_unlocked(self.con,'bx','running',False,[])
            self.assertEqual((Path(self.tmp.name) / path).read_text(),'artifact')
            self.assertEqual((self.row()['status'],self.row()['exit_code']),('failed',1))


class ApiSubmission(Isolated):
    def test_cmd_start_posts_once_on_every_proxy_error(self):
        import json
        import urllib.error
        for status, code, message in [(500,'http_500','Something went wrong'), (502,'http_502',''),
                (502,'sandbox_direct_failed','Request timeout after 39994ms'),
                (502,'sandbox_direct_failed','connect ECONNREFUSED'),
                (503,'sandbox_direct_failed','connect ETIMEDOUT'), (504,'http_504',''),
                (520,'http_520',''), (524,'http_524',''), (525,'http_525','')]:
            body = json.dumps({'code':code,'message':message}).encode()
            error = urllib.error.HTTPError('https://boat.dev',status,'x',{},io.BytesIO(body))
            with patch.object(api,'_key',return_value='fake'), patch('urllib.request.urlopen',side_effect=error) as send:
                with self.assertRaises(api.ApiError):
                    api.cmd_start('bx','run-test')
                self.assertEqual(send.call_count,1,(status,code,message))
            error.close()
