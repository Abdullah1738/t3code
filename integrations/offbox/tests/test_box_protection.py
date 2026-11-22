"""Every destructive actor uses the same pin/command guard and audit envelope."""
import json
import contextlib
import io
import subprocess
import sys
import threading
from http.server import ThreadingHTTPServer
from unittest.mock import patch

if __package__:
    from .test_boatd import Base, Http, boatd
    from .client_fixtures import Isolated
else:
    from test_boatd import Base, Http, boatd
    from client_fixtures import Isolated

COMMAND_PROBE = boatd.command_probe


class BoxProtectionTests(Base):
    def pinned(self):
        bid = self.box()
        self.con.execute('UPDATE boxes SET pinned=1,pin_until=?,pin_holder=? WHERE id=?',
                         (boatd.now()+86400, 'thread:holder', bid))
        return bid

    def test_stop_delete_and_reaper_leave_live_pin_alone(self):
        bid = self.pinned()
        for action in (lambda: boatd.stop_box(self.con, bid, 'idle ttl'), lambda: boatd.delete_box(self.con, bid)):
            with self.assertRaisesRegex(boatd.Fail, 'thread:holder'):
                action()
        self.con.execute('UPDATE boxes SET last_active=1,ttl=1 WHERE id=?', (bid,))
        with patch.object(boatd, 'ssh_sessions', return_value=0):
            boatd.reap_once(self.con)
        self.assertNotIn(('stop', boatd.ct(bid), '--timeout', '60'), self.f.calls)
        self.assertEqual(boatd.box_row(self.con, bid)['state'], 'ready')

    def test_probe_alive_and_unknown_block_stop_delete_and_handout(self):
        bid = self.box()
        self.con.execute("INSERT INTO commands(box_id,pid,command_id,status,run_id,attempt,holder,metrics) "
                         "VALUES (?,1001,'cmd-old','lost','run-holder',1,'thread:holder','{}')", (bid,))
        for proof in ({'readable': True, 'pids': [31291]},
                      {'readable':True, 'pids':[31291], 'box_rc':0, 'join_verified':True},
                      {'reason': 'unreadable'}):
            with self.subTest(proof=proof), patch.object(boatd, 'command_probe', return_value=proof):
                for action in (lambda: boatd.stop_box(self.con, bid, 'idle'), lambda: boatd.delete_box(self.con, bid),
                               lambda: boatd.queue_cmd(self.con, bid, dict(command='true', detached=True), None)):
                    with self.assertRaisesRegex(boatd.Fail, 'run-holder'):
                        action()

    def test_confirmed_empty_group_releases_false_terminal_holder(self):
        bid = self.box()
        self.con.execute("INSERT INTO commands(box_id,pid,command_id,status,run_id,attempt,holder,metrics) "
                         "VALUES (?,1001,'cmd-old','lost','run-holder',1,'thread:holder','{}')", (bid,))
        with patch.object(boatd, 'command_probe', return_value=dict(readable=True,pids=[],join_verified=True)):
            self.assertTrue(boatd.box_protection(self.con, bid, run_id='run-holder')['confirmedGone'])
            boatd.stop_box(self.con, bid, 'idle ttl')
        self.assertEqual(boatd.box_row(self.con, bid)['state'], 'archived')

    def test_actor_and_protection_survive_every_state_transition(self):
        bid = self.box()
        caller = dict(actor='home-repair script', pid=10, parent_pid=9, parent_argv=['zsh', '<redacted>'],
                      host='test', thread_id='thread-A', run_id='run-A', holder='thread-A')
        token = boatd.offbox_protection.CALLER.set(caller)
        self.addCleanup(boatd.offbox_protection.CALLER.reset, token)
        boatd.stop_box(self.con, bid, 'cleanup')
        boatd.delete_box(self.con, bid)
        rows = self.con.execute('SELECT * FROM box_events WHERE box_id=? ORDER BY seq', (bid,)).fetchall()
        self.assertEqual([r['action'] for r in rows], ['stop','archive','delete'])
        for row in rows:
            event = json.loads(row['detail'])
            self.assertEqual(event['caller']['actor'], 'home-repair script')
            self.assertEqual(event['caller']['parent_pid'], 9)
            self.assertIn('pin', event['protection'])

    def test_expiry_and_indefinite_legacy_pin(self):
        bid = self.pinned()
        self.con.execute('UPDATE boxes SET pin_until=1 WHERE id=?', (bid,))
        self.assertFalse(boatd.box_protection(self.con, bid)['pin']['active'])
        self.con.execute('UPDATE boxes SET pin_until=NULL WHERE id=?', (bid,))
        self.assertTrue(boatd.box_protection(self.con, bid)['pin']['active'])

    def test_failed_provision_cleanup_cannot_delete_a_pin(self):
        bid = self.pinned()
        with self.assertRaisesRegex(boatd.Fail, 'thread:holder'):
            boatd.cleanup_provision(bid, 'ardud')
        self.assertFalse(any(c[0] == 'delete' for c in self.f.calls))

    def test_state_and_actor_event_rollback_together(self):
        bid = self.box()
        with patch.object(boatd, 'box_event', side_effect=RuntimeError('audit write failed')):
            with self.assertRaisesRegex(RuntimeError, 'audit write'):
                boatd.set_box(self.con, bid, state='stopping')
        self.assertEqual(boatd.box_row(self.con, bid)['state'], 'ready')

    def test_every_terminal_invocation_retains_children_without_optional_metadata(self):
        bid = self.box()
        for pid, run_id, sync in ((1001,None,1),(1002,None,0),(1003,'same-run',0),(1004,'same-run',0)):
            self.con.execute("INSERT INTO commands(box_id,pid,command_id,status,run_id,attempt,sync,holder,metrics) "
                             "VALUES (?,?,?,'exited',?,1,?,'thread:holder','{}')", (bid,pid,str(pid),run_id,sync))
        with patch.object(boatd,'command_probe',return_value=dict(readable=True,pids=[31291],box_rc=0)):
            self.assertEqual(len(boatd.box_protection(self.con,bid)['holds']),4)
            for action in (lambda: boatd.stop_box(self.con,bid,'idle'), lambda: boatd.delete_box(self.con,bid),
                           lambda: boatd.queue_cmd(self.con,bid,dict(command='true',detached=True),None)):
                with self.assertRaisesRegex(boatd.Fail,'thread:holder'):
                    action()
        with patch.object(boatd,'command_probe',return_value=dict(readable=True,pids=[],join_verified=True)):
            self.assertEqual(boatd.box_protection(self.con,bid)['holds'],[])
        with patch.object(boatd,'command_probe',side_effect=AssertionError('positive proof must be cached')):
            self.assertEqual(boatd.box_protection(self.con,bid)['holds'],[])

    def test_override_settlement_does_not_invert_box_and_result_locks(self):
        for delete in (False,True):
            bid = self.box(bid='bx_delete' if delete else 'bx_stop')
            self.con.execute("INSERT INTO commands(box_id,pid,command_id,status,attempt,metrics) "
                             "VALUES (?,1001,'cmd','running',1,'{}')", (bid,))
            result_locked, settlement = threading.Event(), threading.Event()
            errors = []
            def finishing():
                con = boatd.db()
                try:
                    with boatd.result_lock(bid,1001):
                        result_locked.set()
                        if not settlement.wait(3):
                            raise AssertionError('lifecycle did not reach settlement')
                        with boatd.box_memory_lock(bid):
                            con.execute("UPDATE commands SET status='exited' WHERE box_id=?",(bid,))
                except BaseException as error:
                    errors.append(error)
                finally:
                    con.close()
            def kill(con,box,pid,**kwargs):
                settlement.set()
                with boatd.result_lock(box,pid):
                    pass
            def cleanup():
                con = boatd.db()
                token = boatd.offbox_protection.CALLER.set(dict(actor='client:release',override=True))
                try:
                    (boatd.delete_box(con,bid) if delete else boatd.stop_box(con,bid,'override'))
                except BaseException as error:
                    errors.append(error)
                finally:
                    boatd.offbox_protection.CALLER.reset(token)
                    con.close()
            writer = threading.Thread(target=finishing,daemon=True)
            worker = threading.Thread(target=cleanup,daemon=True)
            writer.start()
            self.assertTrue(result_locked.wait(3))
            with patch.object(boatd,'kill_cmd',side_effect=kill):
                worker.start()
                writer.join(3)
                worker.join(3)
            self.assertFalse(writer.is_alive() or worker.is_alive(),'result/box lock inversion')
            self.assertEqual(errors,[])

    def test_only_positive_never_dispatched_evidence_releases_without_guest_marker(self):
        for index, (metrics, started, expected) in enumerate((({},None,False), ({'queue_lost_reason':'unit_inactive'},None,True),
                ({'queue_lost_reason':'unit_inactive'},10,False), ({'not_dispatched':True},None,True),
                ({'not_dispatched':True},10,False))):
            with self.subTest(metrics=metrics,started=started):
                bid = self.box(bid='bx_dispatch'+str(index))
                self.con.execute("INSERT INTO commands(box_id,pid,command_id,status,attempt,metrics,started_at) "
                                 "VALUES (?,1001,'cmd','lost',1,?,?)", (bid,json.dumps(metrics),started))
                with patch.object(boatd,'command_probe',return_value={'reason':'no_marker'}):
                    self.assertEqual(not boatd.box_protection(self.con,bid)['holds'],expected)
                self.con.execute('DELETE FROM commands WHERE box_id=?',(bid,))

    def test_a_run_cancelled_while_queued_does_not_hold_its_box(self):
        clean = {'kill': {'cleanup': 'clean', 'leftover_killed': 0, 'remaining': 0}, 'kill_synthetic': True}
        unseen = {'readable': True, 'pids': None, 'box_rc': None, 'marker': None, 'reason': 'cgroup_unverified'}
        cases = (('cancelled in the queue', clean, None, 1, 1, unseen, True),
                 ('it had been admitted', clean, 10, 1, 1, unseen, False),
                 ('an earlier attempt ran', clean, None, 2, 1, unseen, False),
                 ('cleanup left a process', {**clean, 'kill': {**clean['kill'], 'remaining': 1}}, None, 1, 1, unseen, False),
                 ('cleanup is unknown', {**clean, 'kill': {'cleanup': 'unknown'}}, None, 1, 1, unseen, False),
                 ('a real exit replaced the kill', {**clean, 'kill_synthetic': False}, None, 1, 1, unseen, False),
                 ('nobody killed it', clean, None, 1, 0, unseen, False),
                 ('the box has its start marker', clean, None, 1, 1, {**unseen, 'marker': {'pid': 9}}, False),
                 ('the box has its exit receipt', clean, None, 1, 1, {**unseen, 'box_rc': 0}, False),
                 ('the box has its processes', clean, None, 1, 1, {**unseen, 'pids': [31291]}, False),
                 ('the box cannot be read', clean, None, 1, 1, {'reason': 'box_unreadable'}, False),
                 ('Incus does not answer', clean, None, 1, 1, {'reason': 'incus_unavailable'}, False))
        for index, (name, metrics, started, attempt, killed, view, freed) in enumerate(cases):
            with self.subTest(name):
                bid = self.box(bid='bx_queuekill'+str(index))
                self.con.execute("INSERT INTO commands(box_id,pid,command_id,status,exit_code,attempt,killed,metrics,started_at,run_id) "
                                 "VALUES (?,1001,'cmd','exited',143,?,?,?,?,'run-q')",
                                 (bid, attempt, killed, json.dumps(metrics), started))
                with patch.object(boatd,'command_probe',return_value=view):
                    self.assertEqual(not boatd.box_protection(self.con,bid)['holds'],freed)
                    # Reads that do not look at the box (events, listings) never free it.
                    self.assertTrue(boatd.box_protection(self.con,bid,probe=False)['holds'] or freed)
                    if freed:
                        boatd.stop_box(self.con, bid, 'idle ttl')
                        self.assertEqual(boatd.box_row(self.con, bid)['state'], 'archived')

    def test_output_that_shows_the_guest_started_keeps_a_cancelled_run_held(self):
        bid = self.box()
        self.con.execute("INSERT INTO commands(box_id,pid,command_id,status,exit_code,attempt,killed,metrics,run_id,protocol_nonce) "
                         "VALUES (?,1001,'cmd','exited',143,1,1,?,'run-q','nonce-q')",
                         (bid, json.dumps({'kill': {'cleanup': 'clean', 'remaining': 0}, 'kill_synthetic': True})))
        with patch.object(boatd, 'command_was_started', return_value=True), \
                patch.object(boatd,'command_probe',return_value={'readable':True,'pids':None,'box_rc':None,'marker':None}):
            self.assertEqual([h['process_id'] for h in boatd.box_protection(self.con, bid)['holds']], [1001])

    def test_the_real_kill_of_a_queued_run_leaves_its_box_free_to_stop(self):
        bid = self.box()
        pid = self.cmd(bid, status='queued')
        boatd.stage_kill(self.con, bid, pid, False)
        # boatd's own settlement of a kill that arrived before the runner was admitted.
        with patch.object(boatd, 'cleanup_run', side_effect=AssertionError('a queued run has nothing to clean up')):
            boatd.restore_kill_result(self.con, self.status(bid, pid), {})
        row = self.status(bid, pid)
        self.assertEqual((row['status'], row['started_at'], row['killed']), ('exited', None, 1))
        self.assertEqual(json.loads(row['metrics']), {'kill': dict(cleanup='clean', leftover_killed=0, remaining=0),
                                                      'kill_synthetic': True})
        with patch.object(boatd,'command_probe',return_value={'readable':True,'pids':None,'box_rc':None,'marker':None,
                                                               'reason':'cgroup_unverified'}):
            self.assertEqual(boatd.box_protection(self.con, bid)['holds'], [])
            boatd.stop_box(self.con, bid, 'idle ttl')
        self.assertEqual(boatd.box_row(self.con, bid)['state'], 'archived')

    def test_spawn_failure_needs_positive_unit_absence_before_releasing(self):
        for rc, state, expected in ((3,'inactive',True),(4,'unknown',True),(1,'bus unavailable',False)):
            with self.subTest(rc=rc):
                bid = self.box(bid='bx_spawn'+str(rc))
                self.f.spawn_error = 'systemd-run failed'
                self.f.sh[('systemctl','is-active')] = (rc,state)
                with self.assertRaisesRegex(boatd.Fail,'systemd-run failed'):
                    boatd.start_cmd(self.con,bid,dict(command='true',detached=True))
                with patch.object(boatd,'command_probe',return_value={'reason':'no_marker'}):
                    self.assertEqual(not boatd.box_protection(self.con,bid)['holds'],expected)

    def test_delete_rechecks_pin_after_settlement(self):
        bid = self.box(state='archived',running=False)
        def acquired_pin(*args):
            self.con.execute('UPDATE boxes SET pinned=1,pin_holder=? WHERE id=?',('thread:late',bid))
        with patch.object(boatd,'settle_box_commands',side_effect=acquired_pin):
            with self.assertRaisesRegex(boatd.Fail,'thread:late'):
                boatd.delete_box(self.con,bid)
        self.assertEqual(boatd.box_row(self.con,bid)['state'],'archived')
        self.assertFalse(any(c[0]=='delete' for c in self.f.calls))

    def test_delayed_resume_worker_cannot_restart_box_after_stop(self):
        bid = self.box(state='archived',running=False)
        workers=[]
        class DeferredThread:
            def __init__(self,*,target,daemon):
                workers.append(target)
            def start(self):
                pass
        with patch.object(boatd.threading,'Thread',DeferredThread):
            boatd.resume_box(self.con,bid,{})
        boatd.stop_box(self.con,bid,'idle')
        calls=len(self.f.calls)
        workers[0]()
        self.assertEqual(boatd.box_row(self.con,bid)['state'],'archived')
        self.assertEqual(self.f.calls[calls:],[])


class OneStateReadPerProtection(Base):
    """A long-lived box keeps hundreds of past commands; one protection read asks Incus about the box once."""
    INIT = 5000

    def setUp(self):
        super().setUp()
        self.bid = self.box()
        self.asked = []
        self.state = b'{"status":"Running","pid":%d}' % self.INIT
        self.root = self.tmp/'proc'/str(self.INIT)/'root/run/boatd'
        self.root.mkdir(parents=True)
        self.started(self.INIT, 111)
        original = self.f.incus
        def incus(*args, **kw):
            if args[:1] == ('query',) and args[1].endswith('/state'):
                self.asked.append(args[1])
                return subprocess.CompletedProcess(args, 0, self.state, b'')
            return original(*args, **kw)
        for name, value in (('PROC_ROOT', self.tmp/'proc'), ('cg_path', lambda box: self.tmp/'group'/box),
                            ('incus', incus), ('command_probe', COMMAND_PROBE)):
            patcher = patch.object(boatd, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def started(self, pid, start):
        stat = self.tmp/'proc'/str(pid)/'stat'
        stat.parent.mkdir(parents=True, exist_ok=True)
        stat.write_text(f"{pid} (systemd (init)) S 1 " + ' '.join(['0']*17) + f" {start} 0 0\n")

    def past(self, n, bid=None):
        bid = bid or self.bid
        for pid in range(1001, 1001+n):
            self.con.execute("INSERT INTO commands(box_id,pid,command_id,status,run_id,attempt,holder,metrics,started_at,ended_at) "
                             "VALUES (?,?,?,'exited',?,1,'thread:holder','{}',1,2)", (bid, pid, f'cmd-{pid}', f'run-{pid}'))
            (self.root/f'{pid}.1.rc').write_text('0')

    def test_one_query_serves_every_past_command_and_changes_no_answer(self):
        self.past(40)
        one_by_one = [boatd.command_probe(dict(c)) for c in self.con.execute(
            'SELECT * FROM commands WHERE box_id=? ORDER BY pid DESC', (self.bid,))]
        self.assertEqual(len(self.asked), 40)
        self.asked.clear()
        snapshot = boatd.box_protection(self.con, self.bid)
        self.assertEqual(len(self.asked), 1)
        self.assertEqual([h['probe'] for h in snapshot['holds']], one_by_one)
        self.assertEqual(len(snapshot['holds']), 40)
        self.assertTrue(all(h['probe']['reason'] == 'cgroup_unverified' for h in snapshot['holds']))

    def test_a_proven_exit_is_still_retired_from_the_shared_read(self):
        self.past(3)
        (self.root/'1002.1.started').write_text(json.dumps(dict(pid=77, attempt=1, cgroup_joined=True)))
        group = self.tmp/'group'/self.bid/'boatd/1002'
        group.mkdir(parents=True)
        (group/'cgroup.procs').write_text('')
        snapshot = boatd.box_protection(self.con, self.bid)
        self.assertEqual(sorted(h['process_id'] for h in snapshot['holds']), [1001, 1003])
        self.assertEqual(len(self.asked), 1)
        self.assertTrue(self.con.execute("SELECT 1 FROM meta WHERE k=?", (f'holder_gone:{self.bid}:1002:1',)).fetchone())

    def test_a_restarted_box_is_asked_again_instead_of_trusting_the_old_init(self):
        self.past(3)
        real = boatd._proc_start
        seen = []
        def restarted(pid):
            seen.append(pid)
            return real(pid) if len(seen) < 3 else '999'
        with patch.object(boatd, '_proc_start', side_effect=restarted):
            boatd.box_protection(self.con, self.bid)
        self.assertGreater(len(self.asked), 1)

    def test_an_unreadable_start_time_falls_back_to_one_query_per_command(self):
        (self.tmp/'proc'/str(self.INIT)/'stat').unlink()
        self.past(5)
        boatd.box_protection(self.con, self.bid)
        self.assertEqual(len(self.asked), 5)

    def test_a_stopped_box_answers_once_and_retires_its_settled_commands(self):
        self.state = b'{"status":"Stopped","pid":0}'
        self.past(1)
        self.assertEqual(boatd.box_protection(self.con, self.bid)['holds'], [])
        few = len(self.asked)
        self.asked.clear()
        self.con.execute("DELETE FROM meta WHERE k LIKE 'holder_gone:%'")
        self.con.execute('DELETE FROM commands')
        self.past(30)
        self.assertEqual(boatd.box_protection(self.con, self.bid)['holds'], [])
        # The count does not grow with the number of commands (the live-command check after the loop asks once more).
        self.assertEqual(len(self.asked), few)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM meta WHERE k LIKE 'holder_gone:%'").fetchone()[0], 30)

    def test_a_box_started_after_a_stopped_reading_cannot_revive_settled_commands(self):
        """Rows are read before the reading; a stopped box had no process then, so the later start changes nothing
        for them. A command that is still running is held whatever the box says."""
        self.past(4)
        self.con.execute("INSERT INTO commands(box_id,pid,command_id,status,run_id,attempt,holder,metrics,started_at) "
                         "VALUES (?,2000,'cmd-live','running','run-live',1,'thread:holder','{}',1)", (self.bid,))
        answers = [b'{"status":"Stopped","pid":0}']
        original = boatd.incus
        def incus(*args, **kw):
            if args[:1] == ('query',) and args[1].endswith('/state') and answers:
                self.asked.append(args[1])
                return subprocess.CompletedProcess(args, 0, answers.pop(), b'')
            return original(*args, **kw)
        with patch.object(boatd, 'incus', incus):
            snapshot = boatd.box_protection(self.con, self.bid)
        self.assertEqual([h['process_id'] for h in snapshot['holds']], [2000])
        self.assertFalse(snapshot['confirmedGone'])
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM meta WHERE k LIKE 'holder_gone:%'").fetchone()[0], 4)

    def test_a_box_stopped_during_the_read_is_asked_again(self):
        self.past(3)
        real = boatd._proc_start
        def gone_after_first(pid, seen=[]):
            seen.append(pid)
            if len(seen) == 2:
                self.state = b'{"status":"Stopped","pid":0}'
            return real(pid) if len(seen) < 2 else None
        with patch.object(boatd, '_proc_start', side_effect=gone_after_first):
            snapshot = boatd.box_protection(self.con, self.bid)
        # The first command was read from the live root and stays held; the rest saw the fresh stopped answer.
        self.assertEqual([h['process_id'] for h in snapshot['holds']], [1003])

    def test_an_incus_failure_is_not_remembered_and_never_frees_a_command(self):
        self.past(4)
        original = boatd.incus
        def failing(*args, **kw):
            if args[:1] == ('query',) and args[1].endswith('/state'):
                self.asked.append(args[1])
                return subprocess.CompletedProcess(args, 1, b'', b'Error: connection refused')
            return original(*args, **kw)
        with patch.object(boatd, 'incus', failing):
            snapshot = boatd.box_protection(self.con, self.bid)
        self.assertEqual((len(self.asked), len(snapshot['holds'])), (4, 4))
        self.assertTrue(all(h['probe'] == {'reason': 'incus_unavailable'} for h in snapshot['holds']))

    def test_a_failed_read_leaves_nothing_shared_behind(self):
        self.past(2)
        with patch.object(boatd, 'command_probe', side_effect=RuntimeError('boom')), self.assertRaises(RuntimeError):
            boatd.box_protection(self.con, self.bid)
        self.assertIsNone(boatd._BOX_STATE.get())

    def test_an_init_name_that_is_not_text_still_reads_its_start_time(self):
        (self.tmp/'proc'/str(self.INIT)/'stat').write_bytes(
            b"5000 (in\xff\xfe) it) S 1 " + b' '.join([b'0']*17) + b" 4242 0 0\n")
        self.assertEqual(boatd._proc_start(self.INIT), '4242')

    def test_nothing_is_shared_between_two_reads_or_two_boxes(self):
        other = self.box('bx_bbbbbbbb', port=22001)
        self.past(2)
        self.past(2, other)
        boatd.box_protection(self.con, self.bid)
        boatd.box_protection(self.con, other)
        boatd.box_protection(self.con, self.bid)
        self.assertEqual(len(self.asked), 3)
        self.assertIsNone(boatd._BOX_STATE.get())


class ProtectionHTTP(Base):
    call = Http.call

    def setUp(self):
        super().setUp()
        self.tok = {'ardud': boatd.token_create(self.con, 'ardud')}
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), boatd.Handler)
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.url = f'http://127.0.0.1:{self.srv.server_address[1]}/api/v1'
        boatd.READY.set()
        self.addCleanup(boatd.READY.clear)

    def headers(self, actor='client:release', holder='thread:holder', override=False):
        return {'X-Offbox-Caller': json.dumps(dict(actor=actor, holder=holder, override=override,
                pid=254, parent_pid=253, parent_argv=['zsh','<redacted>'], thread_id=holder, host='test-host'))}

    def test_pin_expiry_and_holder_are_acknowledged_by_server(self):
        bid = self.box()
        expiry = boatd.now()+3600
        status, reply = self.call('ardud', 'PATCH', '/sandboxes/'+bid, dict(pinned=True,pinUntil=expiry), self.headers())
        self.assertEqual(status, 200, reply)
        self.assertEqual(reply['sandbox']['protection']['pin']['holder'], 'thread:holder')
        status, reply = self.call('ardud', 'POST', f'/sandboxes/{bid}/stop', {}, self.headers(holder='thread:other'))
        self.assertEqual(status, 409, reply)
        self.assertIn('thread:holder', json.dumps(reply))
        self.assertEqual(boatd.box_row(self.con, bid)['state'], 'ready')

    def test_archived_delete_fences_pin_ack_during_settlement_and_after_failure(self):
        bid = self.box(state='archived',running=False)
        def settle(*args):
            status, reply = self.call('ardud','PATCH','/sandboxes/'+bid,
                                     dict(pinned=True,pinUntil=boatd.now()+3600),self.headers())
            self.assertEqual(status,409,reply)
            self.assertIn('sandbox_deleting',json.dumps(reply))
            raise RuntimeError('settlement interrupted')
        with patch.object(boatd,'settle_box_commands',side_effect=settle):
            with self.assertRaisesRegex(RuntimeError,'settlement interrupted'):
                boatd.delete_box(self.con,bid)
        with contextlib.closing(boatd.db()) as reopened:
            for action in (lambda: boatd.resume_box(reopened,bid,{}),
                           lambda: boatd.queue_cmd(reopened,bid,dict(command='true'),None)):
                with self.assertRaisesRegex(boatd.Fail,'deletion is pending'):
                    action()
        boatd.delete_box(self.con,bid)
        self.assertEqual(self.state(bid)['state'],'deleted')

    def test_stop_rechecks_acknowledged_pin_after_stale_state_change(self):
        bid = self.box()
        def settle(*args):
            boatd.set_box(self.con,bid,state='ready')
            status, reply = self.call('ardud','PATCH','/sandboxes/'+bid,
                                     dict(pinned=True,pinUntil=boatd.now()+3600),self.headers())
            self.assertEqual(status,200,reply)
        with patch.object(boatd,'settle_box_commands',side_effect=settle):
            with self.assertRaisesRegex(boatd.Fail,'thread:holder'):
                boatd.stop_box(self.con,bid,'idle')
        self.assertTrue(boatd.box_protection(self.con,bid)['pin']['active'])
        self.assertFalse(any(c[0]=='stop' for c in self.f.calls))

    def test_legacy_pin_reconciliation_is_explicit_and_audited(self):
        bid = self.box()
        self.con.execute('UPDATE boxes SET pinned=1 WHERE id=?',(bid,))
        expiry = boatd.now()+3600
        body = dict(pinned=True,pinUntil=expiry)
        status, _ = self.call('ardud','PATCH','/sandboxes/'+bid,body,self.headers())
        self.assertEqual(status,409)
        body['pinReconcile'] = dict(holder='thread:holder',until=expiry)
        status, reply = self.call('ardud','PATCH','/sandboxes/'+bid,body,self.headers())
        self.assertEqual(status,200,reply)
        pin = reply['sandbox']['protection']['pin']
        self.assertEqual(pin['holder'],'thread:holder')
        self.assertEqual(pin['until'],boatd.iso(expiry))
        event = self.con.execute("SELECT detail FROM box_events WHERE action='pin_reconcile'").fetchone()
        self.assertEqual(json.loads(event[0])['caller']['local_pin'],body['pinReconcile'])

    def test_repair_delete_uses_server_guard_and_actor_event(self):
        bid = self.box(state='archived', running=False)
        headers = self.headers(actor='home-repair/delete-idle-boxes.sh')
        headers['X-Ascii-Confirm-Delete'] = bid
        self.con.execute('UPDATE boxes SET pinned=1,pin_until=?,pin_holder=? WHERE id=?',
                         (boatd.now()+3600, 'thread:retention', bid))
        status, reply = self.call('ardud', 'DELETE', '/sandboxes/'+bid, headers=headers)
        self.assertEqual(status, 409, reply)
        self.con.execute('UPDATE boxes SET pin_until=1 WHERE id=?', (bid,))
        status, reply = self.call('ardud', 'DELETE', '/sandboxes/'+bid, headers=headers)
        self.assertEqual(status, 200, reply)
        event = json.loads(self.con.execute("SELECT detail FROM box_events WHERE action='delete'").fetchone()[0])
        self.assertEqual(event['caller']['actor'], 'home-repair/delete-idle-boxes.sh')
        self.assertEqual(event['caller']['parent_pid'], 253)
        self.assertFalse(event['protection']['pin']['active'])

    def test_only_explicit_client_release_can_override(self):
        bid = self.box(state='archived', running=False)
        self.con.execute('UPDATE boxes SET pinned=1 WHERE id=?', (bid,))
        for actor, expected in (('home-repair/delete-idle-boxes.sh',409), ('client:release',200)):
            headers = self.headers(actor=actor, override=True)
            headers['X-Ascii-Confirm-Delete'] = bid
            status, reply = self.call('ardud','DELETE','/sandboxes/'+bid,headers=headers)
            self.assertEqual(status, expected, reply)

    def test_unknown_old_caller_is_not_attributed_to_boatd_pid(self):
        bid = self.box(state='archived', running=False)
        status, reply = self.call('ardud','DELETE','/sandboxes/'+bid,headers={'X-Ascii-Confirm-Delete':bid})
        self.assertEqual(status,200,reply)
        event = json.loads(self.con.execute("SELECT detail FROM box_events WHERE action='delete'").fetchone()[0])
        self.assertIsNone(event['caller']['pid'])
        self.assertIn('server_pid', event['caller'])

    def test_simulation_pin_idle_pool_and_false_settlement(self):
        """Real HTTP, SQLite, policy and #148 probe; simulated Incus/proc/cgroup filesystem."""
        from offbox_lib import api, common, lease, misc, pool
        client = Isolated()
        client.setUp()
        self.addCleanup(client.doCleanups)
        bid = self.box()
        client.box(bid, member=True)
        status, reply = self.call('ardud', 'PATCH', '/sandboxes/'+bid,
                                  dict(pinned=True, pinUntil=boatd.now()+86400), self.headers())
        self.assertEqual(status, 200, reply)
        client.con.execute('UPDATE leases SET pinned_until=?', (boatd.now()+86400,))
        common.kv_set(client.con, 'pin_owner:'+bid, 'thread:holder')
        self.con.execute('UPDATE boxes SET ttl=1,last_active=1 WHERE id=?', (bid,))
        with patch.object(boatd, 'ssh_sessions', return_value=0):
            boatd.reap_once(self.con)
        self.assertEqual(boatd.box_row(self.con, bid)['state'], 'ready')
        self.assertFalse(pool._pin_available(client.con, bid, client.me))
        self.assertFalse(any(c[0] in ('stop', 'delete') for c in self.f.calls))
        print('SIMULATION pinned idle beyond TTL: survives; other-worker pool selection: skipped')

        # The holder intentionally clears its own pin; a live command must protect the box by itself.
        status, reply = self.call('ardud', 'PATCH', '/sandboxes/'+bid, dict(pinned=False), self.headers())
        self.assertEqual(status, 200, reply)
        client.con.execute('UPDATE leases SET pinned_until=NULL')
        client.con.execute("INSERT INTO runs(run_id,box_id,owner,status,exit_code,process_id,command_id) "
                           "VALUES ('run-simulation',?,'thread:holder','infra',90,1001,'cmd-simulation')", (bid,))
        client.con.commit()
        self.con.execute("INSERT INTO commands(box_id,pid,command_id,status,run_id,attempt,holder,metrics) "
                         "VALUES (?,1001,'cmd-simulation','lost','run-simulation',1,'thread:holder','{}')", (bid,))
        child = subprocess.Popen([sys.executable, '-I', '-c', 'import sys; sys.stdin.read()'], stdin=subprocess.PIPE)
        def finish_child():
            if not child.stdin.closed:
                child.stdin.close()
            child.wait(timeout=10)
        self.addCleanup(finish_child)
        root = self.tmp/'proc/5000/root/run/boatd'
        root.mkdir(parents=True)
        (root/'1001.1.started').write_text(json.dumps(dict(pid=child.pid,attempt=1,cgroup_joined=True)))
        group = self.tmp/'run-group/boatd/1001'
        group.mkdir(parents=True)
        (group/'cgroup.procs').write_text(str(child.pid))
        original_incus = self.f.incus
        def incus(*args, **kw):
            if args == ('query', f'/1.0/instances/{boatd.ct(bid)}/state'):
                return subprocess.CompletedProcess(args, 0, b'{"status":"Running","pid":5000}', b'')
            return original_incus(*args, **kw)
        def protection_call(method, path, **kw):
            status, reply = self.call('ardud', method, path, headers=self.headers())
            self.assertEqual(status, 200, reply)
            return reply
        with patch.object(boatd, 'command_probe', side_effect=COMMAND_PROBE), \
                patch.object(boatd, 'PROC_ROOT', self.tmp/'proc'), \
                patch.object(boatd, 'cg_path', return_value=self.tmp/'run-group'), \
                patch.object(boatd, 'incus', side_effect=incus), \
                patch.object(api, 'BACKEND', 'server'), patch.object(api, 'call', side_effect=protection_call):
            lease.reconcile_holds(client.con, bid)
            self.assertIsNone(child.poll())
            self.assertEqual(lease.active_runs(client.con, bid), 1)
            self.assertFalse(pool._pin_available(client.con, bid, client.me))
            status, reply = self.call('ardud', 'POST', f'/sandboxes/{bid}/stop', {}, self.headers(holder='thread:other'))
            self.assertEqual(status, 409, reply)
            print(f'SIMULATION false infra 90 while owned PID {child.pid} alive: lease held; hand-out and stop refused')
            finish_child()
            (group/'cgroup.procs').write_text('')
            (root/'1001.1.rc').write_text('0')
            lease.reconcile_holds(client.con, bid)
            self.assertEqual(lease.active_runs(client.con, bid), 0)
        event = json.loads(self.con.execute("SELECT detail FROM box_events WHERE action='lease_free'").fetchone()[0])
        self.assertEqual(event['caller']['actor'], 'client:release')
        self.assertEqual(event['caller']['run_id'], 'run-simulation')
        self.assertEqual(event['caller']['parent_pid'], 253)
        print('SIMULATION real exit + empty group: lease released; actor event='+json.dumps(event, sort_keys=True))
        output = io.StringIO()
        server_box = boatd.box_json(self.con, boatd.box_row(self.con, bid))
        with contextlib.redirect_stdout(output), patch.object(api, 'limits', return_value={}), \
                patch.object(api, 'list_boxes', return_value=[server_box]), \
                patch.object(misc, 'CAP_PATH', self.tmp/'empty-cap.json'):
            misc.status(client.me)
        self.assertIn('actor=client:release', output.getvalue())
        print('SIMULATION offbox status readback:\n'+output.getvalue())
