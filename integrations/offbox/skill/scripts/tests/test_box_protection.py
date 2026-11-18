"""Pinned boxes and ambiguous terminal holders are unavailable to cleanup and other workers."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

from test_capacity import Isolated
from offbox_lib import api, bases, cli, common, home, identity, lease, misc, pool, reap, runs
import offbox_protection

BOX_PROTECTION = api.box_protection


class ProtectionTests(Isolated):
    def setUp(self):
        super().setUp()
        self.box('bx_held', member=True)
        self.stack.enter_context(patch.object(lease, 'now', return_value=1000))
        self.stack.enter_context(patch.object(api, 'BACKEND', 'server'))
        self.stack.enter_context(patch.object(api, 'box_protection', BOX_PROTECTION))
        self.stack.enter_context(patch.object(api, 'call', return_value={'confirmedGone': False}))

    def uncertain(self, status='infra', code=90):
        self.con.execute("INSERT INTO runs(run_id,box_id,owner,status,exit_code,process_id,command_id) "
                         "VALUES ('run-holder','bx_held','thread:holder',?,?,1001,'command-holder')", (status, code))
        self.con.commit()

    def test_false_terminal_record_retains_pool_reservation(self):
        for status in ('infra', 'lost'):
            with self.subTest(status=status):
                self.con.execute('DELETE FROM runs')
                self.uncertain(status)
                self.assertEqual(lease.active_runs(self.con, 'bx_held'), 1)
                self.assertFalse(pool._pin_available(self.con, 'bx_held', self.me))

    def test_absent_exit_and_legacy_false_confirmation_still_require_probe(self):
        self.uncertain('lost', None)
        common.kv_set(self.con, 'lost_confirmed:run-holder', '1')
        self.assertEqual(lease.active_runs(self.con, 'bx_held'), 1)
        with patch.object(api, 'call', return_value={'confirmedGone': True}):
            lease.reconcile_holds(self.con, 'bx_held')
        self.assertEqual(lease.active_runs(self.con, 'bx_held'), 0)

    def test_home_error_and_old_box_confirmation_cannot_free_live_holder(self):
        self.uncertain('lost',None)
        for prior in (None,'box'):
            with self.subTest(prior=prior):
                if prior:
                    common.kv_set(self.con,'lost_confirmed:run-holder',prior)
                with patch.object(api,'get',return_value=dict(state='error')), \
                        patch.object(api,'history_get',return_value={}), \
                        patch.object(api,'call',return_value=dict(confirmedGone=False)) as probe:
                    self.assertIsNone(runs.confirmed_lost('bx_held','run-holder',check_box=True))
                    self.assertEqual(lease.active_runs(self.con,'bx_held'),1)
                    self.assertIn('/protection?run_id=run-holder',probe.call_args.args[1])
                with patch.object(api,'call',return_value=dict(confirmedGone=True)):
                    lease.reconcile_holds(self.con,'bx_held')
                self.assertEqual(lease.active_runs(self.con,'bx_held'),0)
                self.con.execute("DELETE FROM kv WHERE k='holder_gone:run-holder'")
                self.con.commit()

    def test_failed_1006_holder_is_fenced_like_infra(self):
        self.uncertain('failed', 1)
        self.con.execute("UPDATE runs SET error='websocket 1006 EOF'")
        self.assertFalse(pool._pin_available(self.con, 'bx_held', self.me))

    def test_progress_snapshot_does_not_probe_or_release_holder(self):
        self.uncertain()
        self.con.execute('BEGIN')
        try:
            with patch.object(api, 'call') as probe:
                lease.reconcile_holds(self.con, 'bx_held')
            probe.assert_not_called()
            self.assertEqual(lease.active_runs(self.con, 'bx_held'), 1)
        finally:
            self.con.rollback()

    def test_reap_skips_live_pin_when_stopping(self):
        self.con.execute('UPDATE leases SET pinned_until=2000,last_used_at=1')
        with patch.object(api, 'list_boxes', return_value=[dict(id='bx_held',state='running')]), \
                patch.object(api, 'stop') as stop, patch.object(bases, 'upkeep'), \
                patch.object(reap, 'now', return_value=1000):
            reap.reap()
        stop.assert_not_called()

    def test_failed_server_pin_acknowledgement_leaves_local_pin_intact(self):
        self.con.execute("UPDATE leases SET owner=?,repo_root=?,pinned_until=2000", (self.me['owner'],self.me['repo_root']))
        common.kv_set(self.con, 'pin_owner:bx_held', self.me['owner'])
        with patch.object(api, 'call', side_effect=common.OffboxError('server unavailable')):
            with self.assertRaisesRegex(common.OffboxError, 'server unavailable'):
                bases.keep(self.me, 0, box_id='bx_held')
        self.assertEqual(lease.pinned_until(self.con, 'bx_held'), 2000)

    def test_only_positive_server_confirmation_releases_uncertain_holder(self):
        self.uncertain()
        for reply in ({}, {'confirmedGone': False}, {'confirmedGone': 'true'}):
            with self.subTest(reply=reply), patch.object(api, 'call', return_value=reply):
                lease.reconcile_holds(self.con, 'bx_held')
                self.assertEqual(lease.active_runs(self.con, 'bx_held'), 1)
        with patch.object(api, 'call', return_value={'confirmedGone': True}):
            lease.reconcile_holds(self.con, 'bx_held')
        self.assertEqual(lease.active_runs(self.con, 'bx_held'), 0)
        event = self.con.execute("SELECT * FROM events WHERE kind='lease_free'").fetchone()
        self.assertEqual(json.loads(event['detail'])['caller']['run_id'], 'run-holder')

    def test_nonholder_stop_and_delete_name_the_holder(self):
        self.uncertain()
        for action in (lease.stop_box, lease.delete_box):
            with self.subTest(action=action.__name__), patch.object(api, 'stop') as stop, patch.object(api, 'delete') as delete:
                with self.assertRaisesRegex(common.OffboxError, 'thread:holder.*run-holder'):
                    action(self.con, 'bx_held', 'another thread')
                stop.assert_not_called()
                delete.assert_not_called()

    def test_pin_blocks_idle_stop_before_image_archive(self):
        self.con.execute("UPDATE leases SET pinned_until=2000 WHERE box_id='bx_held'")
        common.kv_set(self.con, 'pin_owner:bx_held', 'thread:pinner')
        with patch.object(lease, 'keep_images') as images, patch.object(api, 'stop') as stop:
            with self.assertRaisesRegex(common.OffboxError, 'thread:pinner'):
                lease.stop_box(self.con, 'bx_held', 'reap: idle')
            images.assert_not_called()
            stop.assert_not_called()

    def test_override_is_explicit_and_audited(self):
        self.uncertain()
        with patch.object(api, 'stop') as stop, patch.object(lease, 'keep_images'), \
                patch.object(lease.ssh_sync, 'close_master'), patch.object(lease, 'release_if_confirmed'):
            lease.stop_box(self.con, 'bx_held', 'explicit override', override=True)
        stop.assert_called_once_with('bx_held', override=True)
        entry = self.con.execute("SELECT detail FROM events WHERE kind='stop'").fetchone()
        self.assertEqual(json.loads(entry[0])['protection']['holds'][0]['run_id'], 'run-holder')

    def test_policy_never_automatically_overrides_pin_or_unknown_holder(self):
        snapshots = [dict(pin=dict(active=True, holder='A'), holds=[]),
                     dict(pin={}, holds=[dict(run_id='R', state='unknown')])]
        for snapshot in snapshots:
            self.assertIsNotNone(offbox_protection.blocked(snapshot, override=True))
            self.assertIsNone(offbox_protection.blocked(snapshot, automatic=False, override=True))

    def test_parent_command_values_are_redacted(self):
        import subprocess
        token = offbox_protection.CALLER.set(None)
        self.addCleanup(offbox_protection.CALLER.reset, token)
        with patch.object(subprocess, 'run', return_value=type('P', (), {'stdout': '/bin/zsh -c secret --token=secret'})()):
            caller = offbox_protection.caller('client:reap')
        self.assertNotIn('secret', json.dumps(caller))
        self.assertEqual(caller['parent_argv'], ['zsh', '-c', '<redacted>', '--token'])

    def test_server_actor_metadata_does_not_launch_parent_command(self):
        import subprocess
        token = offbox_protection.CALLER.set(None)
        self.addCleanup(offbox_protection.CALLER.reset, token)
        with patch.object(subprocess, 'run') as execute:
            caller = offbox_protection.caller('restart')
        execute.assert_not_called()
        self.assertEqual(caller['actor'], 'restart')

    def test_reap_and_release_delete_log_parent_and_environment_thread(self):
        for argv in (['reap'], ['release','bx_held','--delete']):
            with self.subTest(argv=argv), contextlib.ExitStack() as stack:
                token = offbox_protection.CALLER.set(None)
                stack.callback(offbox_protection.CALLER.reset, token)
                stack.enter_context(patch.dict('os.environ', T3_THREAD_ID='thread-from-env'))
                stack.enter_context(patch.object(identity, 'whoami', return_value=dict(self.me,thread=None)))
                ps = stack.enter_context(patch.object(subprocess, 'run', return_value=
                    subprocess.CompletedProcess([],0,stdout='/bin/zsh -c private-prompt --token=private-key')))
                stack.enter_context(patch.object(home, 'person_gate'))
                stack.enter_context(patch.object(reap, 'reap', return_value=[]))
                stack.enter_context(patch.object(misc, 'release'))
                stack.enter_context(patch.object(cli, '_reap_other_backend'))
                logged = stack.enter_context(patch.object(cli, 'log'))
                self.assertEqual(cli.main(argv), 0)
                events = [c.args[0] for c in logged.call_args_list if c.args[0].startswith('client_command ')]
                self.assertEqual(len(events), 1)
                actor = json.loads(events[0].split(' ',1)[1])
                self.assertEqual(actor['actor'], 'client:'+argv[0])
                self.assertIsInstance(actor['parent_pid'], int)
                self.assertEqual(actor['parent_argv'], ['zsh','-c','<redacted>','--token'])
                self.assertEqual(actor['thread_id'], 'thread-from-env')
                self.assertNotIn('private', events[0])
                self.assertGreaterEqual(ps.call_count, 1)

    def test_repair_policy_check_fails_closed_on_incomplete_responses(self):
        payload = Path(self.tmp.name)/'protection.json'
        for snapshot, allowed in (({},False),
                ({'ok':True,'pin':{'active':False},'holds':[]},True),
                ({'ok':True,'pin':{'active':True},'holds':[]},False),
                ({'ok':True,'pin':{'active':False},'holds':[{'run_id':'held'}]},False),
                ({'ok':True,'pin':{'active':0},'holds':[]},False),
                ({'ok':True,'pin':{'active':False},'holds':{}},False)):
            with self.subTest(snapshot=snapshot):
                payload.write_text(json.dumps(snapshot))
                result = subprocess.run([sys.executable,'-I',offbox_protection.__file__,'--check',str(payload)],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode == 0, allowed)

    def test_status_reports_expiring_pin_holder_even_when_account_is_down(self):
        self.con.execute("UPDATE leases SET pinned_until=?", (common.now()+60,))
        common.kv_set(self.con, 'pin_owner:bx_held', 'thread:retention')
        out = io.StringIO()
        with contextlib.redirect_stdout(out), patch.object(api, 'limits', side_effect=common.OffboxError('down')), \
                patch.object(api, 'list_boxes', return_value=[]):
            misc.status(self.me)
        self.assertIn('pin expires', out.getvalue())
        self.assertIn('thread:retention', out.getvalue())

    def test_status_expiry_boundaries(self):
        for delta, visible in ((-1,False),(0,False),(1,True),(86400,True),(86401,False)):
            with self.subTest(delta=delta), patch.object(misc, 'now', return_value=1000):
                self.con.execute('UPDATE leases SET pinned_until=?', (1000+delta,))
                out = io.StringIO()
                with contextlib.redirect_stdout(out), patch.object(api, 'limits', side_effect=common.OffboxError('down')), \
                        patch.object(api, 'list_boxes', return_value=[]):
                    misc.status(self.me)
                self.assertEqual('pin expires' in out.getvalue(), visible)

    def test_background_adoption_preserves_originating_caller(self):
        me = self.me
        self.con.execute("INSERT INTO runs(run_id,owner,repo_root,cwd,local_cwd,mode,status,client_pid) "
                         "VALUES ('run-bg',?,?,?,?,'bg','starting',?)",
                         (me['owner'], me['repo_root'], me['repo_root'], me['repo_root'], os.getpid()))
        self.con.commit()
        origin = dict(actor='client:run', holder=me['owner'], pid=501, parent_pid=500,
                      parent_argv=['zsh', '-c', '<redacted>'], thread_id='thread-origin', host='caller-mac')
        payload = dict(args={}, me=me, backend=common.backend(), caller=origin,
                       ready_fd=1, accept_fd=2, signal_mask=[])
        token = offbox_protection.CALLER.set(None)
        self.addCleanup(offbox_protection.CALLER.reset, token)
        observed = []
        def admitted(*args, **kwargs):
            observed.append(offbox_protection.caller())
            return 0
        with patch.object(runs, 'background_client', side_effect=admitted), patch.object(runs, '_source_present'), \
                patch.object(runs.os,'chdir'):
            self.assertEqual(runs._background_queue('run-bg', payload), 0)
        for key in ('pid','parent_pid','parent_argv','thread_id','host','holder'):
            self.assertEqual(observed[0][key], origin[key])
        self.assertEqual(observed[0]['run_id'], 'run-bg')

    def test_server_child_hold_blocks_selection_claim_and_checkout_preparation(self):
        snapshot = dict(ok=True, pin=dict(active=False), holds=[dict(holder='thread:child',run_id=None,state='exited')])
        self.con.execute("INSERT INTO runs(run_id,box_id,status,exit_code) VALUES ('done','bx_held','done',0)")
        self.con.commit()
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='bx_held'").fetchone())
        with patch.object(api, 'call', return_value=snapshot):
            self.assertFalse(pool._pin_available(self.con, 'bx_held', self.me))
            with self.assertRaisesRegex(common.OffboxError, 'thread:child'):
                pool._claim(self.con, self.me, row, 'next-run')
            with self.assertRaisesRegex(common.OffboxError, 'thread:child'):
                lease._check_held('bx_held', dict(state='running',protection=snapshot))
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_callers').fetchone()[0], 0)

    def test_pin_requires_exact_ack_and_reconciles_only_locally_owned_legacy_pin(self):
        self.con.execute('UPDATE leases SET owner=?,repo_root=?,pinned_until=2000',
                         (self.me['owner'],self.me['repo_root']))
        self.con.commit()
        common.kv_set(self.con, 'pin_owner:bx_held', self.me['owner'])
        safe = dict(ok=True,pin=dict(active=True,holder=None,until=None),holds=[])
        for pin in ({}, dict(active=True,holder=None,until=None),
                    dict(active=True,holder=self.me['owner'],until='2026-01-01T00:00:00Z')):
            with self.subTest(pin=pin), patch.object(api,'call',side_effect=[safe,dict(sandbox=dict(protection=dict(pin=pin)))] ):
                with self.assertRaisesRegex(common.OffboxError, 'exact pin'):
                    bases.keep(self.me, 1, box_id='bx_held')
                self.assertEqual(lease.pinned_until(self.con,'bx_held'),2000)
        with patch.object(api,'call',return_value=dict(ok=True,sandbox=dict(pinned=True))) as call:
            with self.assertRaisesRegex(common.OffboxError,'protection unavailable'):
                bases.keep(self.me,1,box_id='bx_held')
            self.assertEqual(call.call_count,1)  # old server was not patched

    def test_boat_pin_ttl_and_saved_retention_never_stop_or_resume(self):
        with patch.object(api,'BACKEND','boat'), patch.object(api,'set_ttl') as ttl:
            self.con.execute('UPDATE leases SET pinned_until=87400')
            self.con.commit()
            lease.ensure_ttl('bx_held',60)
            self.assertGreaterEqual(ttl.call_args.args[1],86400)
        with patch.object(api,'BACKEND','boat'), patch.object(api,'saved_list',return_value=([],dict(included=1,used=0))), \
                patch.object(api,'save') as save, patch.object(api,'saved_get',return_value=dict(status='ready',sourceSandboxId='bx_held')), \
                patch.object(api,'stop') as stop, patch.object(api,'resume') as resume:
            self.assertTrue(bases.keep_pin_saved(self.con,'bx_held'))
            self.assertTrue(bases.keep_pin_saved(self.con,'bx_held'))
            save.assert_called_once()
            stop.assert_not_called()
            resume.assert_not_called()
            self.assertTrue(common.kv_get(self.con,'pin_saved:bx_held'))

    def test_existing_boat_pin_with_full_saved_slots_keeps_disk_running(self):
        self.con.execute('UPDATE leases SET pinned_until=2000')
        self.con.commit()
        with patch.object(api,'BACKEND','boat'), patch.object(bases,'now',return_value=1000), \
                patch.object(api,'saved_list',return_value=([],dict(included=1,used=1))), \
                patch.object(lease,'_resume_confirmed',return_value=(True,False)) as resume, \
                patch.object(api,'wait_state'), patch.object(lease,'ensure_ttl',return_value=True) as ttl, \
                patch.object(api,'stop') as stop, patch.object(api,'delete') as delete:
            bases.retain_pin(self.con,'bx_held',api.STOPPED_STATES[0])
        resume.assert_called_once_with(self.con,'bx_held',1060,None)
        ttl.assert_called_once_with('bx_held',1060)
        stop.assert_not_called()
        delete.assert_not_called()
        self.assertEqual(self.con.execute('SELECT state FROM leases').fetchone()[0],'running')
        self.assertTrue(self.con.execute("SELECT 1 FROM events WHERE kind='pin_retention_resume'").fetchone())

    def test_expired_original_keeps_saved_pin_and_refuses_with_snapshot_name(self):
        self.con.execute('UPDATE leases SET pinned_until=2000')
        common.kv_set(self.con,'pin_saved:bx_held','pin-retained-snapshot')
        self.con.commit()
        for snapshot in (None,dict(state='stopped',dataExpiredAt='2026-11-17T00:00:00Z')):
            with self.subTest(snapshot=snapshot), patch.object(api,'BACKEND','boat'), \
                    patch.object(api,'get',return_value=snapshot), patch.object(api,'resume') as resume:
                row = dict(self.con.execute('SELECT * FROM leases').fetchone())
                with self.assertRaisesRegex(lease.PinnedLeaseError,'pin-retained-snapshot.*explicit restoration'):
                    lease._reuse_available(self.con,row,'small')
                resume.assert_not_called()
                self.assertEqual(lease.pinned_until(self.con,'bx_held'),2000)
                self.assertEqual(common.kv_get(self.con,'pin_saved:bx_held'),'pin-retained-snapshot')
        self.assertTrue(self.con.execute("SELECT 1 FROM events WHERE kind='pin_restore_required'").fetchone())
