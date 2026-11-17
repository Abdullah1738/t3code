"""The Mac client's own code against boatd's real HTTP handler: what the two say to each other about a run the
server restarted under. boatd's host side (Incus, systemd, ZFS) is test_boatd's fakes; HTTP, SQLite and the
client are real."""
import contextlib
import importlib.util
import io
import json
import re
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "tests"))
from offbox_lib import api, cli, common, lease, misc, reap, runs, ssh_sync  # noqa: E402
from test_capacity import Isolated  # noqa: E402

# Keep server fixtures off sys.path: client discovery has same-named test modules.
_spec = importlib.util.spec_from_file_location(
    "offbox_server_test_boatd", SCRIPTS.parents[1] / "tests" / "test_boatd.py")
test_boatd = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = test_boatd
_spec.loader.exec_module(test_boatd)

boatd = test_boatd.boatd


class Wire(Isolated):
    def setUp(self):
        super().setUp()
        self.srv = test_boatd.Http("call")      # used as a fixture: boatd with fakes behind a real HTTP server
        self.srv.setUp()
        self.addCleanup(self.srv.doCleanups)
        for name, value in (("API", self.srv.url), ("BACKEND", "server"), ("NAME", "offbox server"),
                            ("KEY_SERVICE", "offbox-server-api")):
            self.stack.enter_context(patch.object(api, name, value))
        self.as_owner("ardud")
        self.stack.enter_context(patch.object(runs, "_ttl_keeper"))
        self.stack.enter_context(patch.object(api, "_COMMAND_DURATIONS", {}))
        self.log = Path(self.tmp.name) / "run.log"

    def as_owner(self, who):
        self.stack.enter_context(patch.object(api, "_key", return_value=self.srv.tok[who]))

    def follow(self, box, pid, **kw):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            try:
                return runs.follow(box, pid, self.log, echo=False, run_id="run-wire", stop_evt=threading.Event(), **kw), \
                    err.getvalue()
            except common.OffboxError as e:
                return e, err.getvalue()

    def end(self, box, pid, code):
        self.srv.con.execute("UPDATE commands SET status='exited', exit_code=?, ended_at=? WHERE box_id=? AND pid=?",
                             (code, boatd.now(), box, pid))
        self.srv.f.active_units.clear()

    def test_the_retry_flag_reaches_the_server_only_when_asked(self):
        box = self.srv.make_box("ardud")
        a = api.cmd_start(box, "make test", meta={"repo": "r", "kind": "make test", "run_id": "run-1"}, retry_interrupted=True)
        b = api.cmd_start(box, "make deploy")
        rows = {r["pid"]: r for r in self.srv.con.execute("SELECT * FROM commands WHERE box_id=?", (box,))}
        self.assertEqual((rows[a["processId"]]["retry_interrupted"], rows[b["processId"]]["retry_interrupted"]), (1, 0))
        st = api.cmd_status(box, a["processId"])
        self.assertEqual((st["attempt"], st["retryInterrupted"], st["bootId"]), (1, True, "boot-2"))

    def test_nonce_persists_over_http_and_authenticates_server_retry(self):
        nonce, run_id = '1234567890abcdef', 'run-nonced-retry'
        box = self.srv.box(running=False)
        pid = self.srv.cmd(box, retry=1)
        self.srv.con.execute('UPDATE commands SET run_id=?,protocol_nonce=? WHERE box_id=? AND pid=?',
                             (run_id, nonce, box, pid))
        path = common.LOGS_DIR / (run_id+'.log')
        runs.save_run_state(run_id, protocol_nonce=nonce)
        err = boatd.cmd_dir(box) / f'{pid}.err'
        first = f'offbox step 1 rc=7 [n={nonce}]: first\n'
        err.write_text(first)
        self.assertEqual(boatd.reconcile(self.srv.con)['retry'], 1)
        path.write_text(err.read_text())
        self.assertIn(f'[run={run_id} n={nonce}]', path.read_text())
        self.assertEqual(runs.step_results(path), [])
        with err.open('a') as stream:
            stream.write(f'offbox step 1 rc=0 [n={nonce}]: second\n')
        path.write_text(err.read_text())
        self.assertEqual(runs.step_results(path), [(1, 0)])
        other = self.srv.make_box('ardud')
        result = api.cmd_start(other, 'true', meta={'run_id':run_id, 'protocol_nonce':nonce})
        row = self.srv.con.execute('SELECT * FROM commands WHERE box_id=? AND pid=?',
                                  (other, result['processId'])).fetchone()
        self.assertEqual((row['run_id'], row['protocol_nonce']), (run_id, nonce))

    def test_legacy_retry_without_next_wrapper_clears_pre_nonce_client_results(self):
        box = self.srv.box(running=False)
        pid = self.srv.cmd(box, retry=1)
        run_id = 'run-legacy-retry'
        self.srv.con.execute('UPDATE commands SET run_id=? WHERE box_id=? AND pid=?', (run_id, box, pid))
        err = boatd.cmd_dir(box) / f'{pid}.err'
        err.write_text('offbox step 1 rc=0: first attempt\n')
        self.assertEqual(boatd.reconcile(self.srv.con)['retry'], 1)
        text = err.read_text()
        expected = ('offbox-server: the server restarted while this run was going (attempt 1 is lost); '
                    'it is queued again as attempt 2')
        self.assertIn(expected, text.splitlines())
        # Frozen pre-nonce collector contract: the server ships before old clients are replaced.
        retry = re.compile(r'offbox-server: the server restarted while this run was going '
                           r'\(attempt \d+ is lost\); it is queued again as attempt \d+')
        step = re.compile(r'offbox step (\d+) rc=(-?\d+): ')
        results = []
        for line in text.splitlines():
            if line.startswith(runs.COMMAND_STARTED_MARKER) or retry.fullmatch(line):
                results.clear()
            elif match := step.search(line):
                results.append((int(match[1]), int(match[2])))
        self.assertEqual(results, [])
        self.assertEqual(runs.protocol.Protocol(run_id).steps(text)[0], [])

    def test_a_run_the_server_retried_is_followed_to_its_end_with_both_attempts_output(self):
        box = self.srv.box(running=False)                 # the machine restarted: its container is down too
        pid = self.srv.cmd(box, retry=1)
        out = boatd.cmd_dir(box) / f"{pid}.out"
        out.write_text("one\n")
        self.assertEqual(boatd.reconcile(self.srv.con)["retry"], 1)
        with out.open("a") as f:
            f.write("one\ntwo\n")
        self.end(box, pid, 0)
        rc, _ = self.follow(box, pid)
        self.assertEqual(rc, 0)
        text = self.log.read_text()
        self.assertEqual(text.replace("\n", " ").count("one"), 2)
        self.assertIn("two", text)
        self.assertIn("queued again as attempt 2", text)
        self.assertEqual(api.cmd_status(box, pid)["attempt"], 2)

    def test_a_client_that_was_at_byte_4_of_attempt_one_gets_only_what_is_new_and_is_told_of_the_retry(self):
        box = self.srv.box(running=False)
        pid = self.srv.cmd(box, retry=1)
        out = boatd.cmd_dir(box) / f"{pid}.out"
        out.write_text("one\n")
        boatd.reconcile(self.srv.con)
        with out.open("a") as f:
            f.write("ONE\nTWO\n")
        self.end(box, pid, 7)
        self.log.write_text("one\n")
        rc, _ = self.follow(box, pid, start_offsets=(4, 0))
        self.assertEqual(rc, 7, "the retried attempt's real exit code")
        text = self.log.read_text()
        self.assertEqual(text.count("one\n"), 1, "nothing it already had is sent twice")
        self.assertIn("ONE\nTWO\n", text)

    def test_a_run_that_was_not_retried_ends_as_interrupted(self):
        box = self.srv.box()
        pid = self.srv.cmd(box)                           # retry_interrupted off
        (boatd.cmd_dir(box) / f"{pid}.out").write_text("half\n")
        boatd.reconcile(self.srv.con)
        e, _ = self.follow(box, pid)
        self.assertIsInstance(e, runs.Interrupted)
        self.assertEqual(e.code, common.EXIT_INTERRUPTED)
        self.assertIn("half", self.log.read_text())
        self.assertEqual(api.cmd_status(box, pid)["status"], "interrupted")

    def test_restart_settlement_does_not_count_downtime_as_execution(self):
        cases=[('interrupted',None,None),('lost','lost',None),('killed','kill',None),('recovered',None,10000)]
        for index,(name,marker,duration) in enumerate(cases):
            with self.subTest(name=name):
                box=self.srv.box(bid=f'bx_timing{index:04d}')
                pid=self.srv.cmd(box)
                self.srv.con.execute('UPDATE commands SET started_at=100 WHERE box_id=? AND pid=?',(box,pid))
                if marker:
                    (boatd.cmd_dir(box)/f'{pid}.kill').write_text(marker)
                if name=='recovered':
                    boatd.write_json(boatd.result_path(box,pid),{'attempt':1,'status':'exited','exit_code':7,
                                                              'started_at':100,'ended_at':110})
                with patch.object(boatd,'now',return_value=3710):
                    boatd.reconcile(self.srv.con)
                status=api.cmd_status(box,pid)
                if name!='recovered':
                    if name == 'interrupted':
                        self.assertEqual(status['metrics']['interruption']['cleanup'], 'clean')
                        self.assertNotIn('wall_s', status['metrics'])
                    else:
                        self.assertEqual(status['metrics']['kill']['cleanup'], 'clean')
                        self.assertNotIn('wall_s', status['metrics'])
                    self.assertEqual(status['endedAt'],boatd.iso(3710))
                # Both existing response paths must retain only an observed execution duration.
                self.assertEqual(api.command_execution_ms(box,pid,f'cmd_{pid}'),duration)
                list(api.cmd_attach(box,pid))
                self.assertEqual(api.command_execution_ms(box,pid,f'cmd_{pid}'),duration)
                rid='run-restart-'+name
                self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,start_at) "
                                 "VALUES (?,?,?,?,'running','bg',100)",(rid,box,f'cmd_{pid}',pid))
                self.con.commit()
                runs.finish(rid,status['exitCode'] if status['exitCode'] is not None else common.EXIT_INTERRUPTED,
                            bookkeeping=False)
                records=[json.loads(line) for p in (self.srv.tmp/'shared-logs').glob('*.ndjson')
                         for line in p.read_text().splitlines()]
                command=[r for r in records if r['name']=='run.command' and r['ids']['run']==rid]
                self.assertEqual(len(command),1)
                self.assertEqual(command[0].get('durationMs'),duration)

    def test_step_results_belong_to_the_final_home_attempt(self):
        first = 'offbox step 1 rc=5: a\noffbox step 2 rc=0: b\n'
        cases = [('', 90), ('offbox step 1 rc=0: a\n', 90),
                 ('offbox step 1 rc=0: a\noffbox step 2 rc=0: b\n', 0),
                 ('offbox step 1 rc=0: a\noffbox step 2 rc=7: b\n', 7)]
        for index, (second, expected) in enumerate(cases):
            with self.subTest(second=second):
                box = self.srv.box(bid=f'bx_step{index:04d}', running=False)
                pid = self.srv.cmd(box, retry=1)
                err_file = boatd.cmd_dir(box) / f'{pid}.err'
                err_file.write_text(first)
                self.assertEqual(boatd.reconcile(self.srv.con)['retry'], 1)
                with err_file.open('a') as f:
                    f.write(second)
                self.end(box, pid, 0)
                run_id = f'run-attempt-{index}'
                log = common.LOGS_DIR / f'{run_id}.log'
                self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,pulls,step_count) "
                                 "VALUES (?,?,?,?,'running','bg','[]',2)", (run_id, box, f'cmd_{pid}', pid))
                self.con.commit()
                # Start from a captured prefix of the first attempt, as a reconnecting client would.
                log.write_text(first)
                runs._commit(log, 0, len(first), len(first))
                with patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'), patch.object(runs, 'settle_docker'), \
                        contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    reap._check_stale_runs(self.con, box, 'running', False, [])
                    self.assertEqual(misc.wait(run_id, None), expected)
                    self.assertEqual(misc.wait(run_id, None), expected)
                    self.assertEqual(misc.logs(run_id, False), 90 if expected == 90 else 0)
                self.assertEqual(runs.step_results(log), [(int(n), int(rc)) for n, rc in
                                 [(m.fields["step"], m.fields["rc"]) for m in runs.protocol.Protocol().scan(second) if m.kind == "step"]])
                row = misc._run_row(run_id)
                self.assertEqual(row['status'], 'infra' if expected == 90 else 'done' if expected == 0 else 'failed')

    def test_three_step_run_stream_drop_mid_step_reattaches_and_keeps_every_result(self):
        real_attach=api.cmd_attach
        for final_rc in (0,7):
            with self.subTest(final_rc=final_rc):
                box=self.srv.box(bid=f'bx_d1f8{final_rc:04d}')
                pid=self.srv.cmd(box)
                run_id=f'run-d1f8-{final_rc}'
                self.srv.con.execute('UPDATE commands SET run_id=? WHERE box_id=? AND pid=?',(run_id,box,pid))
                err_file=boatd.cmd_dir(box)/f'{pid}.err'
                err_file.write_text('offbox step 1 rc=0: first\noffbox step 2 rc=0: second\n'
                                    'Error: Lost connection to the event listener: websocket: close 1006\n')
                c=boatd.cmd_row(self.srv.con,box,pid)
                result=dict(attempt=1,started_at=c['started_at'],interruption=boatd.interruption(c,'exec_stream_lost'))
                self.assertEqual(boatd.settle_transport(self.srv.con,c,result,
                    view=dict(readable=True,pids=[101215],box_rc=None)),'following')
                self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,pulls,step_count) "
                                 "VALUES (?,?,?,?,'running','bg','[]',3)",(run_id,box,f'cmd_{pid}',pid))
                self.con.commit()
                path=common.LOGS_DIR/f'{run_id}.log'
                reattached=[]
                def attach(*args,**kwargs):
                    for frame in real_attach(*args,**kwargs):
                        yield frame
                        if frame.get('type')=='stderr' and 're-attached' in frame.get('data','') and not reattached:
                            self.assertEqual(runs.step_results(path),[(1,0),(2,0)])
                            self.assertEqual(api.cmd_status(box,pid)['running'],True)
                            self.assertEqual(boatd.held_runs(self.srv.con,box),[run_id])
                            reattached.append(True)
                            with err_file.open('a') as f:
                                f.write(f'offbox step 3 rc={final_rc}: third\n')
                            with patch.object(boatd,'command_probe',return_value=dict(readable=True,pids=[],box_rc=final_rc)):
                                self.assertEqual(boatd.settle_cmd(self.srv.con,boatd.cmd_row(self.srv.con,box,pid)),'finalized')
                err=io.StringIO()
                with patch.object(api,'cmd_attach',side_effect=attach),patch.object(lease,'touch'), \
                     patch.object(lease,'idle_ttl'),patch.object(runs,'settle_docker'), \
                     contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(err):
                    self.assertEqual(misc.wait(run_id,None),final_rc)
                self.assertEqual(reattached,[True])
                self.assertEqual(runs.step_results(path),[(1,0),(2,0),(3,final_rc)])
                self.assertEqual(misc._run_row(run_id)['exit_code'],final_rc)
                self.assertEqual(api.cmd_status(box,pid)['exitCode'],final_rc)
                self.assertNotIn('steps incomplete',err.getvalue())

    def test_interrupted_step_run_uses_completeness_without_changing_plain_exit_94(self):
        for index, step_count in enumerate((0, 2)):
            box = self.srv.box(bid=f'bx_intr{index:04d}')
            pid = self.srv.cmd(box)
            (boatd.cmd_dir(box) / f'{pid}.err').write_text('offbox step 1 rc=0: a\n')
            boatd.reconcile(self.srv.con)
            run_id = f'run-interrupted-{index}'
            self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,pulls,step_count) "
                             "VALUES (?,?,?,?,'running','bg','[]',?)", (run_id, box, f'cmd_{pid}', pid, step_count))
            self.con.commit()
            with patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'), patch.object(runs, 'settle_docker'), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                expected = 90 if step_count else 94
                self.assertEqual(cli.main(['wait', run_id]), expected)
                self.assertEqual(misc.wait(run_id, None), expected)

    def test_unavailable_final_history_cannot_accept_old_complete_step_results(self):
        box = self.srv.box()
        pid = self.srv.cmd(box)
        run_id = 'run-old-complete'
        log = common.LOGS_DIR / f'{run_id}.log'
        log.write_text('offbox step 1 rc=0: a\noffbox step 2 rc=0: b\n')
        self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,pulls,step_count) "
                         "VALUES (?,?,?,?,'running','bg','[]',2)", (run_id, box, f'cmd_{pid}', pid))
        self.con.commit()
        row = misc._run_row(run_id)
        with patch.object(misc, '_catch_up_log', return_value='incomplete:history unavailable'), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertIsNone(runs.settled_steps_code(row, 0))
        self.assertIn('steps incomplete:', err.getvalue())
        self.assertNotIn('remote exit 0', err.getvalue())
        for status, code in (('done', 0), ('infra', None)):
            with self.subTest(status=status, code=code):
                self.con.execute("UPDATE runs SET status=?,exit_code=? WHERE run_id=?", (status, code, run_id))
                self.con.commit()
                with patch.object(misc, '_catch_up_log', return_value='incomplete:history unavailable'), \
                        contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
                    for _ in range(2):
                        self.assertEqual(misc.wait(run_id, None), 90)
                        self.assertEqual(misc.logs(run_id, False), 90)
                self.assertNotIn('done exit=0', out.getvalue())
                row = misc._run_row(run_id)
                self.assertEqual((row['status'], row['exit_code']), (status, code))

    def test_another_owners_token_gets_404_for_the_box_and_its_run(self):
        box = self.srv.box()
        pid = self.srv.cmd(box)
        self.as_owner("moni")
        self.assertIsNone(api.cmd_status(box, pid), "404: to her token the run does not exist")
        for call in (lambda: api.call("GET", f"/sandboxes/{box}", retries=0), lambda: api.cmd_start(box, "id"),
                     lambda: list(api.cmd_attach(box, pid))):
            with self.assertRaises(api.ApiError) as cm:
                call()
            self.assertEqual(cm.exception.status, 404)

    def test_server_not_ready_reads_as_an_outage_not_a_refusal(self):
        box = self.srv.box()
        boatd.READY.clear()
        boatd.STATE["problem"] = "reconciling runs and boxes after start"
        with self.assertRaises(api.ApiError) as cm:
            api.call("GET", f"/sandboxes/{box}", retries=0)
        self.assertEqual((cm.exception.status, cm.exception.api_code), (503, "server_not_ready"))
        self.assertTrue(cm.exception.outage)

    def test_unfollowed_background_run_keeps_full_server_output_at_settlement(self):
        for code in (0, 7):
            with self.subTest(code=code):
                box = self.srv.box(bid=f'bx_{code:08d}')
                pid = self.srv.cmd(box)
                stdout = 'start\n' + 'x' * (1 << 20) + '\nfinished\n'
                stderr = 'diagnostic\n'
                (boatd.cmd_dir(box) / f'{pid}.out').write_text(stdout)
                (boatd.cmd_dir(box) / f'{pid}.err').write_text(stderr)
                self.end(box, pid, code)
                run_id = f'run-home-{code}'
                log = common.LOGS_DIR / f'{run_id}.log'
                self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,pulls,start_at,log_path) "
                                 "VALUES (?,?,?,?,'running','bg','[]',?,?)",
                                 (run_id, box, f'cmd_{pid}', pid, common.now(), str(log)))
                self.con.commit()
                self.assertFalse(log.exists())
                with patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'), patch.object(runs, 'settle_docker'), \
                        patch.object(api, 'get', side_effect=AssertionError('history needs no live box inspection')), \
                        patch.object(ssh_sync, 'ssh', side_effect=AssertionError('history needs no SSH')):
                    reap._check_stale_runs(self.con, box, 'running', False, [])
                    row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
                    self.assertEqual((row['status'], row['exit_code']), ('failed' if code else 'done', code))
                    self.assertEqual(log.read_text(), stdout + stderr)
                    self.assertEqual(common.checkpoint(log),
                                     dict(stdoutOffset=len(stdout), stderrOffset=len(stderr), logBytes=len(stdout + stderr)))
                    for _ in range(2):
                        out, err = io.StringIO(), io.StringIO()
                        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                            self.assertEqual(misc.logs(run_id, False), 0)
                        self.assertEqual((out.getvalue(), err.getvalue()), (stdout + stderr, ''))
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(misc.wait(run_id, None), code)

    def test_empty_home_history_reports_no_output_without_inspecting_the_container(self):
        box = self.srv.box()
        pid = self.srv.cmd(box)
        self.end(box, pid, 0)
        self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,exit_code) "
                         "VALUES ('run-silent',?,?,?,'done','bg',0)", (box, f'cmd_{pid}', pid))
        self.con.commit()
        with patch.object(api, 'get', side_effect=AssertionError('full history is on the host disk')):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(misc.logs('run-silent', False), 1)
            self.assertEqual(out.getvalue(), '')
            self.assertIn('server history checked', err.getvalue())
            self.assertEqual(len(err.getvalue().splitlines()), 1)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(misc.wait('run-silent', None), 0)


if __name__ == "__main__":
    unittest.main()
