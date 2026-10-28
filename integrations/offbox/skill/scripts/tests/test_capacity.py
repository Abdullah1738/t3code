"""Offline regression tests for shared capacity, pooling, retries and local fallback."""
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, capacity, cli, common, fallback, lease, pool, reap, runs, spend


class Isolated(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.tmp.name)
        for name in ('STATE','LOGS_DIR','LOCKS_DIR','SSH_DIR','CM_DIR'):
            self.stack.enter_context(patch.object(common, name, root/name))
        self.stack.enter_context(patch.object(common, 'DB_PATH', root/'db.sqlite'))
        self.stack.enter_context(patch.object(common, 'LOG_PATH', root/'log'))
        self.stack.enter_context(patch.object(spend, 'CAP_PATH', root/'cap.json'))
        self.stack.enter_context(patch.object(lease, 'CAP_PATH', root/'cap.json'))
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'0', 'OFFBOX_POOL_SIZE':'2'}))
        for name in ('OFFBOX_STARTS_PER_MINUTE','OFFBOX_STARTS_PER_HOUR','OFFBOX_STARTS_PER_DAY'):
            self.stack.enter_context(patch.dict(os.environ, {name: str(dict(MINUTE=25,HOUR=180,DAY=760)[name.rsplit('_',1)[-1]])}))
        self.con = common.db()
        capacity.schema(self.con)
        self.addCleanup(self.con.close)
        self.tg = self.stack.enter_context(patch('offbox_lib.identity.telegram', return_value=True))
        self.stack.enter_context(patch.object(spend, 'telegram', self.tg))
        self.stack.enter_context(patch.object(fallback, 'telegram', self.tg))
        self.me = dict(owner='worker', repo_key='repo', repo_root='/checkout/repo', session='s',thread='t')

    def box(self, bid, state='running', used=100, member=False, size='large', source='template:crpko-go'):
        self.con.execute("""INSERT INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,last_used_at,source)
            VALUES (?,'old-worker','/old/worktree','repo','w/old',?,?,?,?)""", (bid,state,size,used,source))
        if member:
            self.con.execute('INSERT INTO pool_members VALUES (?,?)',(bid,'repo'))
        self.con.commit()

    def busy(self, bid):
        self.con.execute("INSERT INTO runs(run_id,box_id,status) VALUES (?,?,'running')",('run-'+bid,bid))
        self.con.commit()


class BudgetTests(Isolated):
    def test_rolling_windows_boundaries(self):
        t = 200000
        for age in (0,59,60,3599,3600,86399,86400):
            self.con.execute("INSERT INTO start_requests(ts,operation) VALUES (?,'create')",(t-age,))
        self.con.commit()
        with patch.object(capacity,'now',return_value=t):
            self.assertEqual([r['used'] for r in capacity.snapshot(self.con)['counts']], [2,4,6])

    def test_legacy_import_idempotent_and_does_not_double_count(self):
        t = common.now()
        self.con.execute("INSERT INTO events VALUES (?, 'b1','lease_new','')",(t,))
        self.con.execute("INSERT INTO events VALUES (?, 'b2','lease_resume','')",(t,))
        self.con.execute("INSERT INTO start_requests(ts,box_id,operation) VALUES (?,'b2','resume')",(t-1,))
        self.con.commit()
        capacity.schema(self.con)
        capacity.schema(self.con)
        self.assertEqual(self.con.execute('SELECT count(*) FROM start_requests').fetchone()[0],2)

    def test_atomic_reservations_cannot_overrun_cap(self):
        out = []
        def reserve():
            try:
                capacity.reserve('create',None)
                out.append('ok')
            except capacity.CapacityError:
                out.append('blocked')
        with patch.dict(os.environ,{'OFFBOX_STARTS_PER_MINUTE':'3'}):
            ts = [threading.Thread(target=reserve) for _ in range(10)]
            for t in ts: t.start()
            for t in ts: t.join()
        self.assertEqual(out.count('ok'),3)
        self.assertEqual(out.count('blocked'),7)

    def test_idle_policy_tight_budget(self):
        self.assertEqual(capacity.idle_seconds('xlarge'),300)
        self.assertEqual(capacity.idle_seconds('large'),600)
        self.assertEqual(capacity.idle_seconds(),600)
        self.assertEqual(capacity.idle_seconds('xlarge',docker=True),common.IDLE_STOP_S)
        self.con.executemany("INSERT INTO start_requests(ts) VALUES (?)",[(common.now()-7200,)]*400)
        self.con.commit()
        self.assertEqual(capacity.idle_seconds('xlarge'),common.IDLE_STOP_S)  # half the day used: fewer resumes
        self.con.executemany("INSERT INTO start_requests(ts) VALUES (?)",[(common.now()-7200,)]*170)
        self.con.commit()
        self.assertEqual(capacity.idle_seconds('xlarge'),3600)  # three quarters used
        with patch.object(capacity,'snapshot',return_value={'blocked':True,'counts':[{'used':0,'cap':760}]}):
            self.assertEqual(capacity.idle_seconds('xlarge'),3600)

    def test_429_fast_fail_shared_cooldown_and_one_alert(self):
        body = {'error':{'code':'rate_limited','message':'840 sandbox starts per day'}}
        err = urllib.error.HTTPError('https://boat.dev',429,'limited',{'Retry-After':'120'},io.BytesIO(json.dumps(body).encode()))
        self.addCleanup(err.close)
        with patch.object(api,'_key',return_value='fake'), patch.object(api.urllib.request,'urlopen',side_effect=err) as send, patch.object(api.time,'sleep') as sleep:
            with self.assertRaisesRegex(capacity.CapacityError,'boat start limit reached'):
                api.create('large',1200,'test','key')
            with self.assertRaises(capacity.CapacityError):
                api.resume('b',1200)
            self.assertEqual(send.call_count,1)
            sleep.assert_not_called()
        capacity.cooldown({'Retry-After':'60'},body)
        self.assertEqual(self.tg.call_count,1)
        self.assertEqual(self.con.execute('SELECT outcome FROM start_requests').fetchone()[0],'http_429')

    def test_cooldown_http_date_and_defaults(self):
        with patch.object(capacity,'now',return_value=0):
            self.assertEqual(capacity.retry_seconds({'Retry-After':'Thu, 01 Jan 1970 00:02:00 GMT'},{}),120)
        self.assertEqual(capacity.retry_seconds({}, {'message':'starts per day'}),3600)
        self.assertEqual(capacity.retry_seconds({}, {'error':{'details':{'retryAfterSeconds':42}}}),42)


class PoolTests(Isolated):
    def test_reaper_unknown_status_keeps_slot_reserved(self):
        self.box('busy',member=True)
        self.busy('busy')
        self.con.execute("UPDATE runs SET process_id=7 WHERE box_id='busy'")
        self.con.commit()
        for result in (None, {'running':False}, common.OffboxError('network')):
            with patch.object(api,'cmd_status',side_effect=result if isinstance(result,Exception) else None,return_value=result):
                reap._check_stale_runs(self.con,'busy','idle',False,[])
                self.assertEqual(lease.active_runs(self.con,'busy'),1)

    def test_box_lock_excludes_second_caller_even_without_run_row(self):
        self.box('only',member=True)
        with patch.dict(os.environ,{'OFFBOX_POOL_SIZE':'1'}), patch.object(lease,'_reuse',side_effect=lambda c,r,s,**kw:dict(r)):
            row = pool.acquire(self.me)
            try:
                with self.assertRaises(capacity.CapacityError):
                    pool.acquire(dict(self.me,owner='other'))
            finally:
                pool.release_guard(row)

    def test_completed_detached_run_frees_slot(self):
        self.box('bg',member=True)
        self.busy('bg')
        self.con.execute("UPDATE runs SET mode='bg',process_id=123 WHERE box_id='bg'")
        self.con.commit()
        with patch.object(api,'cmd_status',return_value={'running':False,'status':'exited','exitCode':0}), patch.object(lease,'idle_ttl'), patch.object(lease,'_reuse',side_effect=lambda c,r,s,**kw:dict(r)):
            row=pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='run-bg'").fetchone()[0],'done')

    def test_full_pool_resizes_existing_idle_box_instead_of_creating(self):
        self.box('small',member=True,size='default')
        with patch.dict(os.environ,{'OFFBOX_POOL_SIZE':'1'}), patch.object(lease,'_reuse',side_effect=lambda c,r,s,**kw:dict(r)) as reuse, patch.object(lease,'acquire_private') as new:
            row=pool.acquire(self.me,size='xlarge')
            pool.release_guard(row)
            self.assertEqual(reuse.call_args.args[2],'xlarge')
            new.assert_not_called()

    def test_running_idle_preferred_and_shared_across_paths(self):
        self.box('stop','stopped',used=300)
        self.box('busy',used=400)
        self.busy('busy')
        self.box('idle',used=100)
        self.con.execute("INSERT INTO runs(run_id,status) VALUES ('mine','starting')")
        self.con.commit()
        with patch.object(lease,'_reuse',side_effect=lambda c,r,s,**kw:dict(r)) as reuse, patch.object(lease,'acquire_private') as new:
            row = pool.acquire(self.me, run_id='mine')
            try:
                self.assertEqual(row['box_id'],'idle')
                self.assertEqual(row['remote_dir'],'w/repo-'+__import__('hashlib').sha1(b'/checkout/repo').hexdigest()[:6])
                self.assertEqual(self.con.execute("SELECT box_id FROM runs WHERE run_id='mine'").fetchone()[0],'idle')
                self.assertEqual(lease.find_lease(self.con,'worker','/checkout/repo')['box_id'],'idle')
                new.assert_not_called()
            finally:
                pool.release_guard(row)

    def test_pool_full_no_new_create(self):
        for bid in ('one','two'):
            self.box(bid,member=True)
            self.busy(bid)
        self.box('surplus')
        with patch.object(lease,'acquire_private') as new, patch.object(lease,'_reuse') as reuse:
            with self.assertRaisesRegex(capacity.CapacityError,'busy/full'):
                pool.acquire(self.me)
            new.assert_not_called()
            reuse.assert_not_called()

    def test_cooldown_reuses_running_never_resumes(self):
        capacity.cooldown({}, {'message':'day limit'})
        self.box('stopped','stopped')
        self.box('live')
        with patch.object(lease,'_reuse',side_effect=lambda c,r,s,**kw:dict(r)) as reuse:
            row = pool.acquire(self.me)
            pool.release_guard(row)
            self.assertEqual(reuse.call_args.args[1]['box_id'],'live')

    def test_stopped_only_budget_denies_without_api(self):
        capacity.cooldown({}, {'message':'day limit'})
        self.box('stopped','stopped')
        with patch.object(lease,'_reuse') as reuse, patch.object(lease,'acquire_private') as new:
            with self.assertRaises(capacity.CapacityError):
                pool.acquire(self.me)
            reuse.assert_not_called()
            new.assert_not_called()

    def test_oversized_running_box_yields_to_stopped_box_at_natural_size(self):
        self.box('big', size='xlarge', member=True, used=500)
        self.box('cold', 'stopped', size='xlarge', member=True, used=100)
        with patch.object(lease,'_reuse',side_effect=lambda c,r,s,**kw:dict(r)) as reuse, patch.object(lease,'acquire_private') as new:
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(reuse.call_args.args[1]['box_id'],'cold')
        self.assertIsNone(reuse.call_args.args[2])  # _reuse picks the natural size for a stopped box
        new.assert_not_called()

    def test_stopped_box_resumes_at_natural_size(self):
        self.box('cold','stopped',size='xlarge')
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='cold'").fetchone())
        with patch.object(api,'get',return_value={'state':'archived','type':'xlarge'}), \
                patch.object(api,'resume',return_value={}) as resume, \
                patch.object(lease,'_bring_up',return_value={'state':'running','type':'large'}), \
                contextlib.redirect_stderr(io.StringIO()):
            got = lease._reuse(self.con,row,None)
        self.assertEqual(resume.call_args.args[2],'large')
        self.assertEqual(got['size'],'large')
        self.box('cold2','stopped',size='large')
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='cold2'").fetchone())
        with patch.object(api,'get',return_value={'state':'archived','type':'large'}), \
                patch.object(api,'resume',return_value={}) as resume, patch.object(lease,'_bring_up'), \
                contextlib.redirect_stderr(io.StringIO()):
            got = lease._reuse(self.con,row,'xlarge')
        self.assertEqual(resume.call_args.args[2],'xlarge')  # an explicit bigger --size still wins
        self.assertEqual(got['size'],'xlarge')

    def test_callers_own_running_box_is_preferred_and_never_demoted(self):
        self.box('other', size='large', member=True, used=900)
        self.box('mine', size='xlarge', member=True, used=100)
        self.box('cold', 'stopped', size='large', member=True, used=50)
        self.con.execute("INSERT INTO pool_callers(owner,repo_root,box_id,remote_dir) VALUES ('worker','/checkout/repo','mine','w/m')")
        self.con.commit()
        with patch.object(lease,'_reuse',side_effect=lambda c,r,s,**kw:dict(r)) as reuse, patch.object(lease,'acquire_private'):
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(reuse.call_args.args[1]['box_id'],'mine')

    def test_stopped_box_infra_error_falls_through_to_running_box(self):
        self.box('big', size='xlarge', member=True, used=500)
        self.box('cold', 'stopped', size='xlarge', member=True, used=100)
        def reuse(c, r, s, **kw):
            if r['box_id'] == 'cold':
                raise common.OffboxError('boat API 500 internal: resume failed')
            return dict(r)
        with patch.dict(os.environ,{'OFFBOX_POOL_SIZE':'2'}), patch.object(lease,'_reuse',side_effect=reuse), \
                patch.object(lease,'acquire_private') as new, contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(row['box_id'],'big')
        new.assert_not_called()

    def test_second_stopped_box_tried_when_first_resume_fails(self):
        self.box('bad', 'stopped', size='large', member=True, used=500)
        self.box('good', 'stopped', size='large', member=True, used=100)
        tried = []
        def reuse(c, r, s, **kw):
            tried.append(r['box_id'])
            if r['box_id'] == 'bad':
                raise common.OffboxError('boat API 500 internal: resume failed')
            return dict(r)
        with patch.dict(os.environ,{'OFFBOX_POOL_SIZE':'2'}), patch.object(lease,'_reuse',side_effect=reuse), \
                patch.object(lease,'acquire_private') as new, contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(tried, ['bad', 'good'])
        self.assertEqual(row['box_id'], 'good')
        new.assert_not_called()

    def test_gone_stopped_box_counts_as_a_failed_try(self):
        self.box('gone', 'stopped', size='large', member=True, used=500)
        self.box('good', 'stopped', size='large', member=True, used=100)
        tried = []
        def reuse(c, r, s, **kw):
            tried.append(r['box_id'])
            return None if r['box_id'] == 'gone' else dict(r)
        with patch.dict(os.environ,{'OFFBOX_POOL_SIZE':'2'}), patch.object(lease,'_reuse',side_effect=reuse), \
                patch.object(lease,'acquire_private') as new, contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(tried, ['gone', 'good'])
        self.assertEqual(row['box_id'], 'good')
        new.assert_not_called()

    def test_shrink_fallback_only_for_shrink_refusals(self):
        self.box('s','stopped',size='xlarge')
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='s'").fetchone())
        for status in (401, 403, 404, 429, 500):
            err = api.ApiError(status,'x','nope')
            with patch.object(api,'get',return_value={'state':'archived','type':'xlarge'}), \
                    patch.object(api,'resume',side_effect=[err,{}]) as resume, patch.object(lease,'_bring_up'), \
                    contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(common.OffboxError):
                    lease._reuse(self.con,row,'large')
            self.assertEqual(resume.call_count, 1, status)
        # Same size: nothing to shrink, so a 400 is not retried either.
        self.box('e','stopped',size='large')
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='e'").fetchone())
        with patch.object(api,'get',return_value={'state':'archived','type':'large'}), \
                patch.object(api,'resume',side_effect=[api.ApiError(400,'x','bad'),{}]) as resume, \
                patch.object(lease,'_bring_up'), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(common.OffboxError):
                lease._reuse(self.con,row,'large')
        self.assertEqual(resume.call_count, 1)
        # A 409 about something else (a busy box) is not a shrink refusal: no retry at the old size.
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='s'").fetchone())
        busy = api.ApiError(409,'sandbox_busy','another operation in progress')
        with patch.object(api,'get',return_value={'state':'archived','type':'xlarge'}), \
                patch.object(api,'resume',side_effect=[busy,{}]) as resume, patch.object(lease,'_bring_up'), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(common.OffboxError):
                lease._reuse(self.con,row,'large')
        self.assertEqual(resume.call_count, 1)
        # A real "does not fit" refusal resumes at the old size.
        nofit = api.ApiError(400,'invalid_type','data does not fit the smaller disk')
        with patch.object(api,'get',return_value={'state':'archived','type':'xlarge'}), \
                patch.object(api,'resume',side_effect=[nofit,{}]) as resume, \
                patch.object(lease,'_bring_up',return_value={'type':'xlarge'}), \
                contextlib.redirect_stderr(io.StringIO()):
            got = lease._reuse(self.con,row,'large')
        self.assertEqual(resume.call_count, 2)
        self.assertEqual(got['size'], 'xlarge')

    def test_docker_use_detected_from_command_or_repo_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(lease.uses_docker('docker compose up -d', d))
            self.assertFalse(lease.uses_docker('go test -run X ./pkg', d))
            Path(d, 'go.mod').write_text('module x\nrequire github.com/testcontainers/testcontainers-go v0.30.0\n')
            self.assertTrue(lease.uses_docker('go test ./integration/', d))
        t = common.now()
        self.con.execute("""INSERT INTO runs (run_id, box_id, owner, repo_root, cwd, cmd, mode, status, start_at,
            end_at, docker) VALUES ('r1','dk','w','/r','/r','go test ./integration/','fg','done',?,?,1)""",
                         (t - 3 * 3600, t - 60))
        self.con.commit()
        self.assertTrue(lease.docker_recent(self.con, 'dk'))
        self.assertTrue(lease.docker_recent(self.con, repo_root='/r'))
        self.assertFalse(lease.docker_recent(self.con, 'other'))

    def test_reaper_uses_per_size_idle_limit(self):
        t = common.now()
        self.box('xl', size='xlarge', used=t-400)
        self.box('lg', size='large', used=t-400)
        live = [{'id':'xl','state':'running','type':'xlarge'},{'id':'lg','state':'running','type':'large'}]
        with patch.object(api,'list_boxes',return_value=live), patch.object(lease,'stop_box') as stop, \
                patch.object(lease,'ensure_ttl') as ttl, patch.object(reap,'_protected',return_value=set()), \
                patch.object(reap,'thread_get',return_value=('ok',None)):
            reap._reap(self.con,False,[])
        self.assertEqual([c.args[1] for c in stop.call_args_list],['xl'])
        self.assertEqual(ttl.call_args.args[0],'lg')

    def test_oversized_running_box_still_used_when_starts_are_tight(self):
        self.box('big', size='xlarge', member=True, used=500)
        self.box('cold', 'stopped', size='large', member=True, used=100)
        self.con.executemany("INSERT INTO start_requests(ts) VALUES (?)",[(common.now()-7200,)]*400)
        self.con.commit()
        with patch.object(lease,'_reuse',side_effect=lambda c,r,s,**kw:dict(r)) as reuse:
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(reuse.call_args.args[1]['box_id'],'big')
        self.assertIsNone(reuse.call_args.args[2])

    def test_explicit_xlarge_prefers_running_xlarge(self):
        self.box('big', size='xlarge', member=True, used=100)
        self.box('cold', 'stopped', size='large', member=True, used=500)
        with patch.object(lease,'_reuse',side_effect=lambda c,r,s,**kw:dict(r)) as reuse:
            row = pool.acquire(self.me, size='xlarge')
            pool.release_guard(row)
        self.assertEqual(reuse.call_args.args[1]['box_id'],'big')

    def test_natural_size_from_base_and_template(self):
        self.con.execute("INSERT INTO bases(name,repo_key,box_id,size,is_default) VALUES ('repo:default','repo','bx_b','default',1)")
        self.con.commit()
        self.assertEqual(lease.natural_size(self.con,{'source':'base:repo:default'}),'large')  # floored at large
        self.assertEqual(lease.natural_size(self.con,{'source':'template:crpko-harness'}),'xlarge')
        self.assertEqual(lease.natural_size(self.con,{'source':'template:generic'}),'default')
        self.assertEqual(lease.natural_size(self.con,{'source':'fresh'}),'large')

    def test_resume_shrinks_and_keeps_size_when_boat_refuses(self):
        self.box('s','stopped',size='xlarge')
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='s'").fetchone())
        refuse = api.ApiError(400,'invalid_request','data does not fit')
        with patch.object(api,'get',return_value={'state':'archived','type':'xlarge'}), \
                patch.object(api,'resume',side_effect=[refuse,{}]) as resume, patch.object(lease,'_bring_up'), \
                contextlib.redirect_stderr(io.StringIO()):
            got = lease._reuse(self.con,row,'large')
        self.assertEqual(resume.call_args_list[0].args[2],'large')
        self.assertIsNone(resume.call_args_list[1].args[2])
        self.assertEqual(got['size'],'xlarge')

    def test_live_box_never_stopped_to_shrink(self):
        self.box('l',size='xlarge')
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='l'").fetchone())
        with patch.object(api,'get',return_value={'state':'running','type':'xlarge'}), patch.object(api,'stop') as stop, \
                patch.object(lease,'_bring_up'), patch.object(lease,'ensure_ttl'):
            got = lease._reuse(self.con,row,'large')
        stop.assert_not_called()
        self.assertEqual(got['size'],'xlarge')

    def test_background_run_reservation_blocks_other_caller(self):
        self.box('b', member=True)
        self.busy('b')
        with patch.dict(os.environ,{'OFFBOX_POOL_SIZE':'1'}), patch.object(lease,'acquire_private') as new:
            with self.assertRaises(capacity.CapacityError):
                pool.acquire(self.me)
            new.assert_not_called()


class FallbackTests(Isolated):
    def test_small_allowed_heavy_never_allowed(self):
        e = capacity.CapacityError('limit')
        self.assertTrue(fallback.allowed(['echo','ok'],e,'/repo'))
        for argv in (['go','test','./...'],['npm','ci'],['pytest','tests/'],['make','test'],['bash','-c','docker compose up -d']):
            self.assertFalse(fallback.allowed(argv,e,'/repo'),argv)
        self.assertFalse(fallback.allowed(['echo','ok'],common.OffboxError('uncertain',started=True),'/repo'))
        self.assertFalse(fallback.allowed(['./scripts/full-suite.sh'],e,'/repo'))
        # Go checks reach the Mac only through local-first's sandbox, never through the plain fallback.
        self.assertFalse(fallback.allowed(['go','test','-run','TestOne','./pkg'],e,'/repo'))

    def test_cli_returns_90_for_full_suite(self):
        args = cli.build_parser().parse_args(['run','--','go','test','./...'])
        with patch.object(runs,'run_remote',side_effect=capacity.CapacityError('limit')), patch.object(fallback,'run_local') as local:
            self.assertEqual(cli.cmd_run(args,self.me),90)
            local.assert_not_called()

    def test_started_error_propagates_even_for_unexpected_failure(self):
        a = cli.build_parser().parse_args(['run','--','echo','ok'])
        def failed(a,rn):
            rn.started=True
            raise RuntimeError('lost response')
        with patch.object(runs,'_run_remote',side_effect=failed), patch.object(runs.Runner,'record'):
            with self.assertRaises(common.OffboxError) as caught:
                runs.run_remote(a,self.me)
            self.assertTrue(caught.exception.started)


class SpendTests(Isolated):
    def limits(self,used=3362489,period='2026-11-13T19:02:12Z',remaining=6637511):
        return dict(creditUsedSeconds=used,creditSecondsPerDollar=100000,subscriptionQuotaSeconds=10000000,
                    subscriptionRemainingSeconds=remaining,subscriptionCurrentPeriodEnd=period)

    def test_one_call_and_cap_contract(self):
        with patch.object(api,'limits',return_value=self.limits()) as limits, patch.object(api,'usage') as usage, patch.object(api,'list_boxes') as boxes:
            out=spend.check()
            self.assertEqual(out['spend'],33.6249)
            self.assertEqual(out['billing_month'],'2026-10')
            self.assertFalse(out['cap_state']['capped'])
            limits.assert_called_once()
            usage.assert_not_called()
            boxes.assert_not_called()

    def test_meter_renewal_cumulative_and_reset(self):
        with patch.object(api,'limits',side_effect=[self.limits(),self.limits(3400000,'2026-12-13T19:02:12Z',9990000)]):
            spend.compute()
            self.assertEqual(spend.compute()['spend'],0.1)
        with patch.object(api,'limits',return_value=self.limits(5000,'2027-01-13T19:02:12Z',9995000)):
            self.assertEqual(spend.compute()['spend'],0.05)

    def test_cap_trips_and_keeps_alert_key_shape(self):
        with patch.object(api,'limits',return_value=self.limits(50100000,remaining=0)), patch.object(spend,'stop_all',return_value=2):
            out=spend.check()
            self.assertTrue(out['cap_state']['capped'])
            self.assertEqual(out['stopped'],2)
            self.assertTrue(any(c.args[1]=='offbox-spend-2026-10-500' for c in self.tg.call_args_list))


if __name__ == '__main__':
    unittest.main()
