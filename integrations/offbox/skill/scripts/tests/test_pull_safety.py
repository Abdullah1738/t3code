"""Local edits, concurrent settlers and pull receipts. No live SSH or state."""
import contextlib
import errno
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, common, lease, misc, pool, pulls, reap, resources, runs, ssh_sync
from test_capacity import Isolated


class PullSafetyTests(Isolated):
    def setUp(self):
        super().setUp()
        self.root = Path(self.me['repo_root'])
        self.remote = Path(self.tmp.name) / 'remote'
        self.remote.mkdir()
        self.box('bx_pull', member=True)
        self.con.execute("""INSERT INTO runs(run_id,box_id,status,mode,process_id,pulls,remote_dir,
            rel_cwd,local_cwd,repo_root,start_at) VALUES ('run-pull','bx_pull','running','bg',42,?,
            'w/project','.',?,?,?)""", (json.dumps(['f.txt']), str(self.root), str(self.root), common.now()))
        self.calls = []
        self.output = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stderr(self.output))
        self.stack.enter_context(contextlib.redirect_stdout(self.output))

    def row(self):
        return self.con.execute("SELECT * FROM runs WHERE run_id='run-pull'").fetchone()

    def events(self, kind):
        return [json.loads(r[0]) for r in self.con.execute('SELECT detail FROM events WHERE kind=?', (kind,))]

    def write_file(self, relative, value, remote=False):
        path = (self.remote if remote else self.root) / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        return path

    def baseline(self, paths=None):
        paths = paths or ['f.txt']
        self.con.execute("UPDATE runs SET pulls=? WHERE run_id='run-pull'", (json.dumps(paths),))
        pulls.record_baseline('run-pull', self.root, paths)

    def sync(self, box, rdir, rel, pattern, stage, **opts):
        self.calls.append((pattern, opts))
        self.assertTrue(opts['relative'])
        for match in pulls.local_matches(self.remote, pattern):
            for source in pulls.files_under(match) if match.is_dir() else (match,):
                target = stage / source.relative_to(self.remote)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        return dict(ok=True, files=len(list(pulls.files_under(stage))))

    def test_baseline_file_directory_glob_and_missing(self):
        self.write_file('one.txt', 'one')
        self.write_file('dir/nested/two.txt', 'two')
        self.write_file('glob/a.txt', 'a')
        self.baseline(['one.txt', 'dir/', 'glob/*.txt', 'new.txt', 'missing/*.txt'])
        baseline = common.read_json(pulls.baseline_path('run-pull'), {})
        self.assertEqual(set(baseline['files']), {'one.txt', 'dir/nested/two.txt', 'glob/a.txt', 'new.txt', 'missing/*.txt'})
        for name in ('one.txt', 'dir/nested/two.txt', 'glob/a.txt'):
            self.assertEqual(baseline['files'][name], pulls.fingerprint(self.root / name))
        self.assertEqual(baseline['files']['new.txt'], 'absent')
        self.assertEqual(self.row()['pull_state'], 'pending')

    def test_kill_before_pull_claim_keeps_checkout_reserved_from_allocator(self):
        self.write_file('f.txt', 'base')
        self.baseline()
        self.write_file('f.txt', 'result of killed run', remote=True)
        self.box('bx_other', member=True)
        self.con.execute("UPDATE runs SET owner=?,remote_dir=? WHERE run_id='run-pull'",
                         (self.me['owner'], pool.remote_dir_for(self.me['repo_root'])))
        self.con.commit()
        observed = {}

        def incoming(box, remote_dir, rel, pattern, stage, **options):
            observed['active_during_transfer'] = lease.active_runs(self.con, box)
            selected = pool.acquire(self.me)
            try:
                observed['allocated_box'] = selected['box_id']
                if selected['box_id'] == box and selected['remote_dir'] == remote_dir:
                    self.write_file('f.txt', 'result of next run', remote=True)
                return self.sync(box, remote_dir, rel, pattern, stage, **options)
            finally:
                pool.release_guard(selected)

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)))
            stack.enter_context(patch.object(lease, 'touch'))
            stack.enter_context(patch.object(lease, 'idle_ttl'))
            stack.enter_context(patch.object(runs, 'settle_docker'))
            stack.enter_context(patch.object(api, 'cmd_kill', return_value={}))
            stack.enter_context(patch.object(api, 'cmd_status', return_value={
                'running': False, 'status': 'exited', 'exitCode': 143}))
            stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('network forbidden')))
            stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
            from offbox_lib import box_disk
            stack.enter_context(patch.object(box_disk, 'picker_ok', return_value=True))
            stack.enter_context(patch.object(ssh_sync, 'pull', side_effect=incoming))
            self.assertEqual(misc.kill_run('run-pull', self.me), 0)
            observed['active_before_claim'] = lease.active_runs(self.con, 'bx_pull')
            observed['confirmed_exit'] = runs.killed_result('run-pull', row=self.row())['exit_code']
            observed['status_after_receipt'] = self.row()['status']
            self.assertEqual(misc._settled(self.row()), 143)
        self.assertEqual(observed['active_before_claim'], 1, observed)
        self.assertEqual(observed['active_during_transfer'], 1, observed)
        self.assertEqual(observed['allocated_box'], 'bx_other', observed)
        self.assertEqual(observed['confirmed_exit'], 143)
        self.assertEqual(observed['status_after_receipt'], 'running')
        self.assertEqual((self.root / 'f.txt').read_text(), 'result of killed run')
        self.assertEqual((self.row()['status'], self.row()['exit_code'], self.row()['pull_state']),
                         ('killed', 143, 'done'))
        self.assertEqual(lease.active_runs(self.con, 'bx_pull'), 0)
        self.assertEqual(len(self.events('pull_start')), 1)
        self.assertIn('pulls: done (1 files, 0 conflicts)', self.output.getvalue())

    def test_terminal_command_reserves_box_until_its_pulls_are_terminal(self):
        for status, code in (('killed', 143), ('done', 0), ('failed', 7)):
            for state in (None, 'pending', 'running', 'none', 'done', 'partial', 'failed'):
                with self.subTest(status=status, pull_state=state):
                    self.con.execute("UPDATE runs SET status=?,exit_code=?,pull_state=?",
                                     (status, code, state))
                    self.con.execute("INSERT OR REPLACE INTO pool_cap_callers "
                                     "(token,pool_key,pid,run_id,cap,granted) "
                                     "VALUES ('pull-cap','repo',999999,'run-pull',8,1)")
                    self.con.commit()
                    reserved = state in (None, 'pending', 'running')
                    self.assertEqual(lease.active_runs(self.con, 'bx_pull'), int(reserved))
                    cap = pool.pool_cap(self.con, 'repo')
                    retained = self.con.execute("SELECT 1 FROM pool_cap_callers WHERE token='pull-cap'").fetchone()
                    self.assertEqual(bool(retained), reserved)
                    if reserved:
                        self.assertEqual(cap, 8)
        self.con.execute("UPDATE runs SET pulls='[]',pull_state='pending'")
        self.con.commit()
        self.assertEqual(lease.active_runs(self.con, 'bx_pull'), 0)

    def test_only_proven_never_started_fence_releases_pending_pull_reservation(self):
        cases = [('lost', None, None), ('lost', None, '1'), ('lost', None, 'box'),
                 ('lost', None, 'fenced'), ('lost', 7, 'fenced'), ('killed', 143, 'fenced')]
        for status, code, proof in cases:
            for state in (None, 'pending', 'running', 'none', 'done', 'partial', 'failed'):
                with self.subTest(status=status, code=code, proof=proof, pull_state=state):
                    self.con.execute("UPDATE runs SET status=?,exit_code=?,pull_state=?",
                                     (status, code, state))
                    self.con.execute("DELETE FROM kv WHERE k='lost_confirmed:run-pull'")
                    if proof:
                        self.con.execute("INSERT INTO kv(k,v) VALUES ('lost_confirmed:run-pull',?)", (proof,))
                    self.con.execute("INSERT OR REPLACE INTO pool_cap_callers "
                                     "(token,pool_key,pid,run_id,cap,granted) "
                                     "VALUES ('pull-cap','repo',999999,'run-pull',8,1)")
                    self.con.commit()
                    never_started = status == 'lost' and code is None and proof == 'fenced'
                    unconfirmed_lost = status == 'lost' and code is None and proof is None
                    reserved = (unconfirmed_lost or (state in (None, 'pending', 'running') and
                                (not never_started or state == 'running')))
                    self.assertEqual(lease.active_runs(self.con, 'bx_pull'), int(reserved))
                    pool.pool_cap(self.con, 'repo')
                    retained = self.con.execute("SELECT 1 FROM pool_cap_callers WHERE token='pull-cap'").fetchone()
                    self.assertEqual(bool(retained), reserved)

    def test_confirmed_lost_reaper_wait_refresh_releases_checkout_after_pull(self):
        from offbox_lib import box_disk, run_evidence
        self.write_file('f.txt', 'base')
        self.baseline()
        self.write_file('f.txt', 'last remote content', remote=True)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(lease, 'touch'))
            stack.enter_context(patch.object(lease, 'idle_ttl'))
            stack.enter_context(patch.object(runs, 'settle_docker'))
            stack.enter_context(patch.object(runs, 'recorded_exit', return_value=None))
            stack.enter_context(patch.object(runs, 'remote_alive', return_value='gone'))
            stack.enter_context(patch.object(api, 'get', return_value={'state': 'running'}))
            stack.enter_context(patch.object(api, 'cmd_status', return_value={
                'running': False, 'status': 'lost', 'exitCode': None}))
            stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('network forbidden')))
            stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
            stack.enter_context(patch.object(misc, '_catch_up_finished', return_value='complete'))
            stack.enter_context(patch.object(runs, 'recover_lost_exit', return_value=(None, 'no receipt')))
            stack.enter_context(patch.object(run_evidence, 'report'))
            stack.enter_context(patch.object(ssh_sync, 'pull', side_effect=self.sync))
            reap._check_unlocked(self.con, 'bx_pull', 'running', False, [])
            self.assertEqual(self.con.execute("SELECT v FROM kv WHERE k='lost_confirmed:run-pull'").fetchone()[0], '1')
            self.assertEqual(misc.wait('run-pull', 2), 90)
            reap._check_unlocked(self.con, 'bx_pull', 'running', False, [])
            pool._refresh_background(self.con, 'repo')
            self.assertEqual(len(self.calls), 1)
            self.assertEqual((self.root / 'f.txt').read_text(), 'last remote content')
            self.assertEqual((self.row()['status'], self.row()['exit_code'], self.row()['pull_state']),
                             ('lost', None, 'done'))
            self.assertEqual(lease.active_runs(self.con, 'bx_pull'), 0)
            stack.enter_context(patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '1'}))
            stack.enter_context(patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)))
            stack.enter_context(patch.object(box_disk, 'picker_ok', return_value=True))
            selected = pool.acquire(self.me)
            try:
                self.assertEqual(selected['box_id'], 'bx_pull')
            finally:
                pool.release_guard(selected)
        self.assertEqual(len(self.events('pull_start')), 1)
        self.assertIn('pulls: done (1 files, 0 conflicts)', self.output.getvalue())
        self.assertIn('exit=None', self.output.getvalue())
        self.assertIn('exit unknown', self.output.getvalue())

    def test_confirmed_lost_pending_pulls_settle_at_each_entry(self):
        from offbox_lib import run_evidence
        for entry in ('wait', 'reap', 'refresh', 'reconcile'):
            for proof in ('1', 'box'):
                with self.subTest(entry=entry, proof=proof), contextlib.ExitStack() as stack:
                    self.write_file('f.txt', 'base')
                    self.baseline()
                    self.write_file('f.txt', 'last remote content', remote=True)
                    self.con.execute("UPDATE runs SET status='lost',exit_code=NULL,pull_state='pending'")
                    self.con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES ('lost_confirmed:run-pull',?)", (proof,))
                    self.con.commit()
                    (common.LOGS_DIR / 'run-pull.pulls.jsonl').unlink(missing_ok=True)
                    self.con.execute("DELETE FROM events WHERE kind LIKE 'pull_%'")
                    self.con.commit()
                    self.calls.clear()
                    stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('network forbidden')))
                    stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
                    stack.enter_context(patch.object(misc, '_catch_up_finished', return_value='complete'))
                    stack.enter_context(patch.object(run_evidence, 'report'))
                    stack.enter_context(patch.object(ssh_sync, 'pull', side_effect=self.sync))
                    if entry == 'wait':
                        self.assertEqual(misc._settled(self.row(), until=common.now()+2), 90)
                    elif entry == 'reap':
                        reap._check_unlocked(self.con, 'bx_pull', 'running', False, [])
                    elif entry == 'refresh':
                        pool._refresh_background(self.con, 'repo')
                    else:
                        runs.reconcile_lost(self.con, 'bx_pull', state='running', until=common.now()+2)
                    self.assertEqual(len(self.calls), 1)
                    self.assertEqual((self.row()['status'], self.row()['exit_code'], self.row()['pull_state']),
                                     ('lost', None, 'done'))
                    self.assertEqual(lease.active_runs(self.con, 'bx_pull'), 0)
                    owner = json.loads(self.row()['pull_owner'])
                    self.assertEqual(owner['role'], {'refresh': 'refresh', 'reap': 'reap'}.get(entry, 'wait'))

    def test_confirmed_lost_live_pull_stays_reserved_and_wait_respects_timeout(self):
        from offbox_lib import run_evidence
        self.baseline()
        owner = json.dumps({'pid': os.getpid(), 'role': 'refresh', 'claim': 'live-lost-pull'})
        self.con.execute("UPDATE runs SET status='lost',exit_code=NULL,pull_state='running',pull_owner=?", (owner,))
        self.con.execute("INSERT INTO kv(k,v) VALUES ('lost_confirmed:run-pull','1')")
        self.con.commit()
        with contextlib.ExitStack() as stack:
            transfer = stack.enter_context(patch.object(ssh_sync, 'pull', side_effect=AssertionError('duplicate pull')))
            stack.enter_context(patch.object(misc, '_catch_up_finished'))
            stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
            stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('network forbidden')))
            stack.enter_context(patch.object(run_evidence, 'report'))
            pool._refresh_background(self.con, 'repo')
            reap._check_unlocked(self.con, 'bx_pull', 'running', False, [])
            self.assertEqual(lease.active_runs(self.con, 'bx_pull'), 1)
            with self.assertRaises(common.OffboxError) as error:
                misc._settled(self.row(), until=common.now()+.02)
            self.assertEqual(error.exception.code, 124)
            self.assertEqual(self.row()['pull_owner'], owner)
            transfer.assert_not_called()

    def test_confirmed_lost_failed_pull_releases_reservation_with_unknown_exit(self):
        from offbox_lib import run_evidence
        self.baseline()
        self.con.execute("UPDATE runs SET status='lost',exit_code=NULL")
        self.con.execute("INSERT INTO kv(k,v) VALUES ('lost_confirmed:run-pull','box')")
        self.con.commit()
        with contextlib.ExitStack() as stack:
            transfer = stack.enter_context(patch.object(ssh_sync, 'pull', side_effect=common.OffboxError('box unavailable')))
            stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
            stack.enter_context(patch.object(run_evidence, 'report'))
            self.assertEqual(misc._settled(self.row(), until=common.now()+2), 90)
            self.assertEqual(misc._settled(self.row(), until=common.now()+2), 90)
            transfer.assert_called_once()
        self.assertEqual((self.row()['status'], self.row()['exit_code'], self.row()['pull_state']),
                         ('lost', None, 'failed'))
        self.assertEqual(lease.active_runs(self.con, 'bx_pull'), 0)
        self.assertEqual(self.events('pull_end')[-1]['outcome'], 'failed')
        self.assertIn('box unavailable', self.output.getvalue())

    def test_lost_reconciliation_skips_unconfirmed_fenced_and_affinity_pulls(self):
        for proof in (None, 'fenced', '1'):
            with self.subTest(proof=proof), contextlib.ExitStack() as stack:
                self.baseline()
                self.con.execute("UPDATE runs SET status='lost',exit_code=NULL,pull_state='pending'")
                self.con.execute("DELETE FROM kv WHERE k='lost_confirmed:run-pull'")
                if proof:
                    self.con.execute("INSERT INTO kv(k,v) VALUES ('lost_confirmed:run-pull',?)", (proof,))
                self.con.commit()
                transfer = stack.enter_context(patch.object(ssh_sync, 'pull', side_effect=AssertionError('unsafe pull')))
                stack.enter_context(patch.object(runs, 'confirmed_lost', return_value=None))
                stack.enter_context(patch.object(misc, '_catch_up_finished'))
                if proof == '1':
                    pool._refresh_background(self.con, 'repo', pull_artifacts=False)
                else:
                    runs.reconcile_lost(self.con, 'bx_pull', state='running', foreign=True, role='refresh')
                transfer.assert_not_called()
                self.assertEqual(self.row()['pull_state'], 'pending')
                self.assertEqual(lease.active_runs(self.con, 'bx_pull'), 0 if proof == 'fenced' else 1)

    def test_publish_or_conflict_for_all_local_states(self):
        cases = [('base', None, 'remote', 'written'), ('base', 'edit', 'remote', 'conflict'),
                 (None, None, 'remote', 'written'), (None, 'created', 'remote', 'conflict'),
                 ('base', None, 'base', 'unchanged'), ('base', 'deleted', 'remote', 'conflict')]
        for original, edited, incoming, outcome in cases:
            with self.subTest(original=original, edited=edited, outcome=outcome):
                self.output.seek(0)
                self.output.truncate()
                for path in (self.root / 'f.txt', self.root / 'f.txt.offbox-pulled'):
                    path.unlink(missing_ok=True)
                if original is not None:
                    self.write_file('f.txt', original)
                self.con.execute("UPDATE runs SET pull_state=NULL,pull_summary=NULL")
                self.con.execute('DELETE FROM events')
                (common.LOGS_DIR / 'run-pull.pulls.jsonl').unlink(missing_ok=True)
                self.baseline()
                if edited == 'deleted':
                    (self.root / 'f.txt').unlink()
                elif edited is not None:
                    self.write_file('f.txt', edited)
                self.write_file('f.txt', incoming, remote=True)
                with patch.object(ssh_sync, 'pull', side_effect=self.sync):
                    self.assertTrue(runs.settle_pulls('run-pull', 'wait'))
                self.assertEqual(self.events('pull_file')[-1]['outcome'], outcome)
                self.assertEqual(self.row()['pull_state'], 'partial' if outcome == 'conflict' else 'done')
                if outcome == 'conflict':
                    self.assertEqual((self.root / 'f.txt.offbox-pulled').read_text(), incoming)
                    if edited == 'deleted':
                        self.assertFalse((self.root / 'f.txt').exists())
                    else:
                        self.assertEqual((self.root / 'f.txt').read_text(), edited)
                    event = self.events('pull_conflict')[0]
                    self.assertEqual((event['run_id'], event['role'], event['pid']), ('run-pull', 'wait', os.getpid()))
                    self.assertIn('NOT pulled f.txt', self.output.getvalue())
                    self.assertNotIn('offbox: offbox:', self.output.getvalue())
                    self.assertNotIn('run-pull: pulled f.txt', self.output.getvalue())
                else:
                    self.assertEqual((self.root / 'f.txt').read_text(), incoming)

    def test_race_one_transfer_wait_blocks_other_settlers_skip(self):
        self.write_file('f.txt', 'base')
        self.baseline()
        self.write_file('f.txt', 'remote', remote=True)
        entered, release, waited = threading.Event(), threading.Event(), threading.Event()
        failures = []
        def slow(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return self.sync(*args, **kwargs)
        def owner():
            try:
                runs.settle_pulls('run-pull', 'refresh', foreign=True)
            except BaseException as error:
                failures.append(error)
        def waiter():
            try:
                pulls.wait('run-pull', until=common.now()+5)
                waited.set()
            except BaseException as error:
                failures.append(error)
        with patch.object(ssh_sync, 'pull', side_effect=slow):
            first = threading.Thread(target=owner)
            first.start()
            self.assertTrue(entered.wait(5))
            self.assertFalse(runs.settle_pulls('run-pull', 'reap', foreign=True))
            second = threading.Thread(target=waiter)
            second.start()
            self.assertFalse(waited.wait(.1))
            self.assertEqual(self.row()['status'], 'running')
            release.set()
            first.join(5)
            second.join(5)
            self.assertTrue(waited.is_set())
            self.assertFalse(failures, failures)
            self.assertTrue(runs.settle_pulls('run-pull', 'reap', foreign=True))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.events('pull_start')), 1)
        self.assertEqual(self.events('pull_end')[0]['role'], 'refresh')

    def test_refresh_and_reaper_callers_skip_a_waits_live_claim(self):
        self.baseline()
        entered, release = threading.Event(), threading.Event()
        def slow(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return dict(ok=True, files=0)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(ssh_sync, 'pull', side_effect=slow))
            stack.enter_context(patch.object(api, 'cmd_status', return_value=dict(status='exited', running=False, exitCode=1)))
            stack.enter_context(patch.object(misc, '_client_alive', return_value=False))
            finish = stack.enter_context(patch.object(runs, 'finish'))
            owner = threading.Thread(target=runs.settle_pulls, args=('run-pull', 'wait'))
            owner.start()
            self.assertTrue(entered.wait(5))
            try:
                pool._refresh_background(self.con, 'repo')
                reap._check_unlocked(self.con, 'bx_pull', 'running', False, [])
                finish.assert_not_called()
                self.assertEqual(self.row()['status'], 'running')
            finally:
                release.set()
                owner.join(5)
        self.assertEqual(len(self.events('pull_start')), 1)

    def test_shared_push_records_snapshot_after_push_returns(self):
        self.write_file('f.txt', 'before')
        runner = SimpleNamespace(box='bx_pull', root=self.root, cwd=self.root, me=self.me, run_id='run-pull',
                                 check_source=lambda phase: None, record=lambda **kw: None)
        a = SimpleNamespace(no_sync=False, git=False, pull=['f.txt'])
        before = pulls.fingerprint(self.root / 'f.txt')
        def push(*args, **kwargs):
            self.write_file('f.txt', 'pushed')
            self.assertFalse(pulls.baseline_path('run-pull').exists())
            return dict(seconds=0, sent=0)
        with patch.object(ssh_sync, 'push', side_effect=push), patch.object(ssh_sync, 'put_file'):
            runs.Runner._sync_box(runner, self.con, a, 'w/project', 'env', b'')
        self.assertEqual(common.read_json(pulls.baseline_path('run-pull'), {})['files']['f.txt'], before)

    def test_saved_result_keeps_slot_reserved_when_refresh_defers_pulls(self):
        self.baseline()
        for code in (0, 1):
            with self.subTest(code=code):
                runs.save_run_state('run-pull', status='done' if code == 0 else 'failed', exit_code=code)
                with patch.object(runs, 'finish') as finish, patch.object(runs, 'settle_pulls') as claim:
                    pool._refresh_background(self.con, 'repo', pull_artifacts=False)
                finish.assert_not_called()
                claim.assert_not_called()
                self.assertEqual(self.row()['status'], 'running')

    def test_detached_pusher_records_its_own_snapshot(self):
        root = Path(self.tmp.name)
        self.write_file('f.txt', 'initial')
        proc = subprocess.run([sys.executable, '-I', str(Path(__file__).resolve()), '--push-fixture', str(root)],
                              capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rid = proc.stdout.strip().splitlines()[-1]
        end = time.monotonic()+10
        while not (root / 'push-complete').exists() and time.monotonic() < end:
            time.sleep(.01)
        self.assertTrue((root / 'push-complete').exists())
        self.assertTrue((root / 'starts').exists())
        snapshot = common.read_json(pulls.baseline_path(rid), {})
        self.assertEqual(snapshot['files']['f.txt'], pulls.fingerprint(root / 'f.txt'))
        self.assertEqual((root / 'push-pid').read_text(), str(self.con.execute(
            'SELECT client_pid FROM runs WHERE run_id=?', (rid,)).fetchone()[0]))

    def test_failed_row_waits_for_running_pulls_and_timeout_reports_owner(self):
        self.con.execute("UPDATE runs SET status='failed',exit_code=1,pull_state='running',pull_owner=?",
                         (json.dumps(dict(pid=os.getpid(), role='refresh')),))
        with self.assertRaises(common.OffboxError) as raised:
            misc._settled(self.row(), until=common.now()+.03)
        self.assertEqual(raised.exception.code, 124)
        self.assertIn(f'pulls: still running (owner pid {os.getpid()}, role refresh)', self.output.getvalue())
        ready, done = threading.Event(), threading.Event()
        result = []
        def block():
            ready.set()
            result.append(misc.wait('run-pull', 5))
            done.set()
        self.row_snapshot = dict(self.row())
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(misc, '_require_my_run'))
            for name, value in [('_catch_up_log', 'complete'), ('_failure_tail', None), ('_report_deps_hint', None)]:
                stack.enter_context(patch.object(misc, name, return_value=value))
            stack.enter_context(patch.object(runs, 'space_result', side_effect=lambda rid, code, **kw: code))
            thread = threading.Thread(target=block)
            thread.start()
            self.assertTrue(ready.wait(2))
            self.assertFalse(done.wait(.1))
            self.con.execute("UPDATE runs SET pull_state='done',pull_summary=?", (json.dumps(dict(files=1, conflicts=0)),))
            thread.join(5)
        self.assertEqual(result, [1])
        self.assertIn('pulls: done (1 files, 0 conflicts)', self.output.getvalue())

    def test_records_survive_catchup_and_state_restore_keeps_path_arguments(self):
        self.write_file('f.txt', 'base')
        self.baseline()
        self.write_file('f.txt', 'remote', remote=True)
        with patch.object(ssh_sync, 'pull', side_effect=self.sync):
            runs.settle_pulls('run-pull', 'reap', foreign=True)
        for kind in ('pull_start', 'pull_file', 'pull_end'):
            entry = self.events(kind)[0]
            self.assertEqual((entry['pid'], entry['role'], entry['box']), (os.getpid(), 'reap', 'bx_pull'))
        self.assertEqual(self.events('pull_end')[0]['files'], 1)
        self.assertEqual(self.events('pull_end')[0]['bytes'], 6)
        path = common.LOGS_DIR / 'run-pull.log'
        self.assertFalse(path.exists(), 'pull settlement must not create a log before output catch-up')
        path.write_text('command output\n')
        pulls.footer('run-pull')
        self.assertIn('pull_start', path.read_text())
        path.write_text('recovered command output\n')
        pulls.footer('run-pull')
        self.assertIn('pull_end', path.read_text())
        saved = common.read_json(common.LOGS_DIR / 'run-pull.state.json', {})
        self.assertEqual(saved['pulls']['state'], 'done')
        self.assertEqual(runs.restore_run_state(self.row())['pulls'], '["f.txt"]')

    def test_dead_owner_is_retaken_and_legacy_runs_are_not_silent(self):
        self.write_file('f.txt', 'remote', remote=True)
        self.con.execute("UPDATE runs SET pull_state='running',pull_owner=?", (json.dumps(dict(pid=999999, role='wait')),))
        with patch.object(pulls, '_alive', return_value=False), patch.object(ssh_sync, 'pull', side_effect=self.sync):
            self.assertTrue(runs.settle_pulls('run-pull', 'refresh', foreign=True))
        self.assertEqual(self.events('pull_start')[0]['retaken_from']['pid'], 999999)
        self.assertIn('no pull baseline', self.output.getvalue())
        self.assertEqual((self.root / 'f.txt').read_text(), 'remote')

    def test_pull_failure_preserves_command_result(self):
        self.con.execute("UPDATE runs SET status='failed',exit_code=7")
        self.baseline()
        with patch.object(ssh_sync, 'pull', side_effect=OSError('rsync unavailable')):
            pulls.wait('run-pull')
        self.assertEqual((self.row()['exit_code'], self.row()['pull_state']), (7, 'failed'))
        pulls.report('run-pull')
        self.assertIn('pulls: failed', self.output.getvalue())

    def test_transfer_timeout_leaves_a_retryable_claim_and_command_exit(self):
        self.write_file('f.txt', 'base')
        self.baseline()
        self.write_file('f.txt', 'remote', remote=True)
        self.con.execute("UPDATE runs SET status='failed',exit_code=7")
        clock = [100.0]
        def timed_out(*args, **kwargs):
            clock[0] += kwargs['timeout']
            raise subprocess.TimeoutExpired('rsync', kwargs['timeout'])
        with patch.object(common, 'now', side_effect=lambda: clock[0]), \
                patch.object(ssh_sync, 'pull', side_effect=timed_out):
            with self.assertRaises(common.OffboxError) as raised:
                pulls.wait('run-pull', until=101)
        self.assertEqual(raised.exception.code, 124)
        self.assertEqual((self.row()['pull_state'], self.row()['exit_code']), ('pending', 7))
        self.assertEqual((self.root / 'f.txt').read_text(), 'base')
        with patch.object(ssh_sync, 'pull', side_effect=self.sync):
            pulls.wait('run-pull')
        self.assertEqual((self.row()['pull_state'], self.row()['exit_code']), ('done', 7))
        self.assertEqual((self.root / 'f.txt').read_text(), 'remote')

    def test_footer_respects_command_log_writer(self):
        self.baseline()
        with patch.object(ssh_sync, 'pull', return_value=dict(ok=True, files=0)):
            runs.settle_pulls('run-pull', 'wait')
        entered, release = threading.Event(), threading.Event()
        path = common.LOGS_DIR / 'run-pull.log'
        def holder():
            with runs.log_lock('run-pull'):
                path.write_text('command output\n')
                entered.set()
                release.wait(5)
        thread = threading.Thread(target=holder)
        thread.start()
        self.assertTrue(entered.wait(5))
        try:
            pulls.footer('run-pull')
            self.assertEqual(path.read_text(), 'command output\n')
        finally:
            release.set()
            thread.join(5)
        pulls.footer('run-pull')
        self.assertTrue(path.read_text().startswith('command output\n'))
        self.assertIn('pull_end', path.read_text())

    def test_symlink_parent_cannot_write_outside_tree(self):
        outside = Path(self.tmp.name) / 'outside'
        outside.mkdir()
        self.baseline(['nested/f.txt'])
        (self.root / 'nested').symlink_to(outside, target_is_directory=True)
        self.write_file('nested/f.txt', 'remote', remote=True)
        with patch.object(ssh_sync, 'pull', side_effect=self.sync):
            runs.settle_pulls('run-pull', 'wait')
        self.assertFalse((outside / 'f.txt').exists())
        self.assertEqual(self.row()['pull_state'], 'failed')

    def test_globs_and_directory_snapshots_do_not_follow_symlinks(self):
        outside = Path(self.tmp.name) / 'outside'
        outside.mkdir()
        (outside / 'secret.txt').write_text('outside')
        (self.root / 'link').symlink_to(outside, target_is_directory=True)
        self.write_file('nested/f.txt', 'inside')
        self.baseline(['**/*.txt', 'nested/'])
        saved = common.read_json(pulls.baseline_path('run-pull'), {})['files']
        self.assertEqual(set(saved), {'nested/f.txt'})

    def test_corrupt_baseline_fails_closed(self):
        self.write_file('f.txt', 'local')
        self.write_file('f.txt', 'remote', remote=True)
        pulls.baseline_path('run-pull').write_text('{broken')
        with patch.object(ssh_sync, 'pull') as sync:
            runs.settle_pulls('run-pull', 'wait')
        sync.assert_not_called()
        self.assertEqual((self.root / 'f.txt').read_text(), 'local')
        self.assertEqual(self.row()['pull_state'], 'failed')

    def test_finish_does_not_change_an_already_settled_row(self):
        self.con.execute("UPDATE runs SET status='done',exit_code=0,end_at=123,pull_state='done'")
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(runs, 'settled_steps_code', side_effect=lambda r, c, **kw: c))
            stack.enter_context(patch.object(runs, 'space_result', return_value=1))
            stack.enter_context(patch.object(runs, 'emit_terminal'))
            runs.finish('run-pull', 1, 'failed', catch_up=False, bookkeeping=False)
        self.assertEqual((self.row()['status'], self.row()['exit_code'], self.row()['end_at']), ('done', 0, 123))


    def test_review_edit_between_check_and_replace_is_preserved(self):
        self.write_file('f.txt', 'pushed version')
        self.baseline()
        self.write_file('f.txt', 'new remote version', remote=True)
        replace = pulls.os.replace
        target = self.root.resolve() / 'f.txt'
        def concurrent_edit(source, destination, **kwargs):
            if Path(source) == target or (kwargs.get("src_dir_fd") is not None and str(source) == target.name) or (Path(destination) == target and '.offbox-tmp-' in Path(source).name):
                target.write_text('local edit after final fingerprint')
            return replace(source, destination, **kwargs)
        with patch.object(ssh_sync, 'pull', side_effect=self.sync), \
                patch.object(pulls.os, 'replace', side_effect=concurrent_edit):
            pulls.wait('run-pull')
        self.assertEqual(target.read_text(), 'local edit after final fingerprint')
        self.assertEqual((self.root / 'f.txt.offbox-pulled').read_text(), 'new remote version')
        self.assertEqual(self.row()['pull_state'], 'partial')


    def test_review_post_push_edit_enters_baseline(self):
        self.write_file('f.txt', 'pushed version')
        self.write_file('f.txt', 'pushed version', remote=True)
        runner = SimpleNamespace(box='bx_pull', root=self.root, cwd=self.root, me=self.me,
                                 run_id='run-pull', check_source=lambda phase: None,
                                 record=lambda **values: None)
        args = SimpleNamespace(no_sync=False, git=False, pull=['f.txt'])
        original = pulls.record_baseline
        push_completed = threading.Event()
        def pushed(*args, **kwargs):
            push_completed.set()
            return dict(seconds=0, sent=0)
        def snapshot(*args):
            self.assertTrue(push_completed.is_set())
            self.write_file('f.txt', 'local edit AFTER push returned')
            return original(*args)
        with patch.object(ssh_sync, 'push', side_effect=pushed), patch.object(ssh_sync, 'put_file'), \
                patch.object(pulls, 'record_baseline', side_effect=snapshot):
            runs.Runner._sync_box(runner, self.con, args, 'w/project', 'env', b'')
        with patch.object(ssh_sync, 'pull', side_effect=self.sync):
            pulls.wait('run-pull')
        self.assertEqual((self.root / 'f.txt').read_text(), 'local edit AFTER push returned')


    def test_review_existing_sidecar_edit_is_preserved(self):
        self.write_file('f.txt', 'pushed version')
        self.write_file('f.txt.offbox-pulled', 'previous conflict copy')
        self.baseline(['.'])
        self.write_file('f.txt', 'main local edit')
        self.write_file('f.txt.offbox-pulled', 'edited previous conflict copy')
        self.write_file('f.txt', 'new remote copy', remote=True)
        with patch.object(ssh_sync, 'pull', side_effect=self.sync):
            pulls.wait('run-pull')
        self.assertEqual((self.root / 'f.txt').read_text(), 'main local edit')
        self.assertEqual((self.root / 'f.txt.offbox-pulled').read_text(), 'edited previous conflict copy')
        conflict = self.events('pull_conflict')[0]
        self.assertNotEqual(conflict['pulled_copy'], 'f.txt.offbox-pulled')
        self.assertEqual((self.root / conflict['pulled_copy']).read_text(), 'new remote copy')

    def test_publication_keeps_a_save_after_displacement_and_an_open_writer(self):
        for absent in (False, True):
            with self.subTest(absent=absent):
                target = self.root / ('new.txt' if absent else 'existing.txt')
                if not absent:
                    target.write_text('base')
                source = self.write_file(target.name, 'remote', remote=True)
                original = pulls.fingerprint(target)
                link = pulls.os.link
                def save_before_publication(src, dst, **kwargs):
                    if Path(dst) == target or (kwargs.get("dst_dir_fd") is not None and str(dst) == target.name):
                        target.write_text('concurrent save')
                    return link(src, dst, **kwargs)
                backups = []
                with patch.object(pulls.os, 'link', side_effect=save_before_publication):
                    self.assertFalse(pulls.atomic_copy(source, target, expected=original,
                                                      backup_record=backups.append))
                self.assertEqual(target.read_text(), 'concurrent save')
                if not absent:
                    self.assertEqual(backups[0].read_text(), 'base')
        target = self.write_file('held.txt', 'base')
        source = self.write_file('held.txt', 'remote', remote=True)
        backups = []
        with target.open('r+') as held:
            self.assertTrue(pulls.atomic_copy(source, target, expected=pulls.fingerprint(target),
                                             backup_record=backups.append))
            held.seek(0)
            held.write('later open-file edit')
            held.truncate()
        self.assertEqual(target.read_text(), 'remote')
        self.assertEqual(backups[0].read_text(), 'later open-file edit')

    def test_terminal_results_settle_pulls_on_every_background_entry(self):
        self.write_file('f.txt', 'remote', remote=True)
        for status, code in (('done', 0), ('failed', 7), ('interrupted', 94), ('killed', 130)):
            for caller in ('wait', 'refresh', 'reap'):
                with self.subTest(status=status, caller=caller), contextlib.ExitStack() as stack:
                    self.con.execute('UPDATE runs SET status=?,exit_code=?,pull_state=NULL', (status, code))
                    self.baseline()
                    stack.enter_context(patch.object(ssh_sync, 'pull', side_effect=self.sync))
                    stack.enter_context(patch.object(runs, 'finish', return_value=code))
                    stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
                    stack.enter_context(patch.object(misc, '_report_deps_hint'))
                    stack.enter_context(patch.object(resources, 'finalize'))
                    stack.enter_context(patch.object(runs, 'space_result', side_effect=lambda rid, c, **kw: c))
                    if caller == 'wait':
                        self.assertEqual(misc._settled(self.row()), code)
                    elif caller == 'refresh':
                        pool._refresh_background(self.con, 'repo')
                    else:
                        reap._check_unlocked(self.con, 'bx_pull', 'running', False, [])
                    self.assertEqual(self.row()['pull_state'], 'done')
                    self.assertEqual(self.row()['exit_code'], code)
                    self.assertEqual(self.events('pull_end')[-1]['role'], caller)


    def test_review_failed_first_history_fetch_can_recover(self):
        self.baseline()
        self.con.execute("UPDATE runs SET status='failed',exit_code=7,command_id='cmd_history'")
        with patch.object(ssh_sync, 'pull', return_value=dict(ok=True, files=0)):
            pulls.wait('run-pull')
        with patch.object(api, 'BACKEND', 'server'):
            with patch.object(api, 'history_logs', side_effect=common.OffboxError('temporary history outage')):
                first = misc._catch_up_log(self.row(), budget=1)
            self.assertTrue(first.startswith('incomplete:'), first)
            self.assertIsNone(common.checkpoint(common.LOGS_DIR / 'run-pull.log'))
            def page(box, command, stream, offset, **kwargs):
                value = 'actual command output\n' if stream == 'stdout' else ''
                return dict(data=value[offset:], nextOffset=len(value), size=len(value), done=True)
            with patch.object(api, 'history_logs', side_effect=page) as fetched:
                second = misc._catch_up_log(self.row(), budget=1)
            self.assertIn(second, ('complete', 'caught_up'),
                          f'second={second}; history API calls={fetched.call_count}')
            self.assertIn('actual command output', (common.LOGS_DIR / 'run-pull.log').read_text())


    def test_review_interrupted_command_reaches_pull_terminal(self):
        self.write_file('f.txt', 'pushed version')
        self.baseline()
        self.con.execute("UPDATE runs SET status='interrupted',exit_code=94")
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(misc, '_require_my_run'))
            stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
            stack.enter_context(patch.object(misc, '_report_deps_hint'))
            stack.enter_context(patch.object(resources, 'finalize'))
            stack.enter_context(patch.object(runs, 'space_result', side_effect=lambda run, code, **kw: code))
            sync = stack.enter_context(patch.object(ssh_sync, 'pull', return_value=dict(ok=False, missing=True, error='No file')))
            code = misc.wait('run-pull', 1)
        self.assertEqual(code, 94)
        self.assertIn(self.row()['pull_state'], pulls.TERMINAL,
                      f"wait returned {code} with pull_state={self.row()['pull_state']}; transfers={sync.call_count}")


    def test_review_state_file_lock_honors_wait_deadline(self):
        self.baseline()
        self.con.execute("UPDATE runs SET status='failed',exit_code=7")
        entered, finished = threading.Event(), threading.Event()
        original = runs.save_run_state
        outcome = {}
        def save(*args, **kwargs):
            entered.set()
            return original(*args, **kwargs)
        def wait_for_pull():
            start = time.monotonic()
            try:
                pulls.wait('run-pull', until=common.now()+.04)
                outcome['code'] = 0
            except common.OffboxError as error:
                outcome['code'] = error.code
            finally:
                outcome['elapsed'] = time.monotonic()-start
                finished.set()
        with patch.object(ssh_sync, 'pull', return_value=dict(ok=True, files=0)), \
                patch.object(runs, 'save_run_state', side_effect=save):
            with common.file_lock('run-state-run-pull'):
                worker = threading.Thread(target=wait_for_pull)
                worker.start()
                self.assertTrue(entered.wait(2))
                finished.wait(.2)
            worker.join(2)
        self.assertTrue(finished.is_set())
        self.assertEqual(outcome['code'], 124)
        self.assertLess(outcome['elapsed'], .15, f'40ms deadline, {outcome}')


    def test_r2_interruption_state_lock_respects_wait_deadline(self):
        self.baseline()
        entered, finished = threading.Event(), threading.Event()
        original_save = runs.save_run_state
        result = {}
        row = dict(self.row())

        def save(*args, **kwargs):
            entered.set()
            return original_save(*args, **kwargs)

        def waiter():
            start = time.monotonic()
            try:
                misc._resolve_exit(row, common.LOGS_DIR / 'run-pull.log',
                                   common.now() + .04, (0, 0), None, echo=False)
            except common.OffboxError as error:
                result['code'] = error.code
            except BaseException as error:
                result['error'] = repr(error)
            finally:
                result['elapsed'] = time.monotonic() - start
                finished.set()

        interrupted = runs.Interrupted('run-pull', {'interruption': {'cause': 'server_restart', 'cleanup': 'clean', 'leftover_killed': 0}})
        with patch.object(runs, 'follow', side_effect=interrupted), patch.object(runs, 'save_run_state', side_effect=save):
            with common.file_lock('run-state-run-pull'):
                worker = threading.Thread(target=waiter)
                worker.start()
                self.assertTrue(entered.wait(2))
                completed_while_held = finished.wait(.15)
            worker.join(2)
        self.assertTrue(finished.is_set(), result)
        self.assertEqual(result.get('code'), 124, result)
        self.assertTrue(completed_while_held, f'40ms wait still blocked on state lock: {result}')

    def test_r2_ancestor_retarget_cannot_displace_an_outside_file(self):
        self.write_file('nested/f.txt', 'base')
        self.baseline(['nested/f.txt'])
        self.write_file('nested/f.txt', 'remote', remote=True)
        outside = Path(self.tmp.name) / 'outside'
        outside.mkdir()
        (outside / 'f.txt').write_text('base')
        root = self.root.resolve()
        original_safe = pulls.safe_path
        checks = []

        def swap_after_check(current_root, relative):
            path = original_safe(current_root, relative)
            if str(relative) == 'nested/f.txt':
                checks.append(str(path))
                if len(checks) == 2:
                    (root / 'nested').rename(root / 'nested-saved')
                    (root / 'nested').symlink_to(outside, target_is_directory=True)
            return path

        with patch.object(ssh_sync, 'pull', side_effect=self.sync), patch.object(pulls, 'safe_path', side_effect=swap_after_check):
            pulls.wait('run-pull')
        self.assertEqual(len(checks), 2)
        files = {p.name: p.read_text() for p in outside.iterdir() if p.is_file()}
        self.assertEqual((outside / 'f.txt').read_text() if (outside / 'f.txt').exists() else None, 'base',
                         f'outside directory was changed: {files}; pull state={self.row()["pull_state"]}')
        self.assertEqual(files, {'f.txt': 'base'})

    def test_r2_publish_failure_restores_displaced_destination(self):
        self.write_file('f.txt', 'base')
        self.baseline()
        self.write_file('f.txt', 'remote', remote=True)
        target = self.root.resolve() / 'f.txt'
        original_link = pulls.os.link

        def failed_publication(source, destination, *args, **kwargs):
            if (Path(destination) == target or (kwargs.get('dst_dir_fd') is not None and str(destination) == target.name)) and '.offbox-tmp-' in Path(source).name:
                raise OSError(errno.ENOSPC, 'injected publication ENOSPC')
            return original_link(source, destination, *args, **kwargs)

        with patch.object(ssh_sync, 'pull', side_effect=self.sync), patch.object(pulls.os, 'link', side_effect=failed_publication):
            pulls.wait('run-pull')
        backups = self.events('pull_backup')
        backup_content = (self.root / backups[0]['backup']).read_text()
        self.assertEqual(target.read_text() if target.exists() else None, 'base',
                         f'failed pull removed original path; backup={backup_content}; state={self.row()["pull_state"]}')
        self.assertEqual(self.row()['pull_state'], 'failed')
        self.assertIn('injected publication ENOSPC', self.output.getvalue())

    def test_publication_pins_parent_for_main_files_and_conflict_copies(self):
        for conflict in (False, True):
            with self.subTest(conflict=conflict):
                directory = self.root / ('conflict' if conflict else 'main')
                directory.mkdir()
                target = directory / ('f.txt.offbox-pulled' if conflict else 'f.txt')
                target.write_text('base')
                outside = Path(self.tmp.name) / directory.name
                outside.mkdir()
                (outside / target.name).write_text('outside')
                source = self.write_file(directory.name + '/f.txt', 'remote', remote=True)
                original_open = pulls.os.open
                swapped = []
                def swap_after_open(path, flags, *args, **kwargs):
                    fd = original_open(path, flags, *args, **kwargs)
                    if str(path) == directory.name and flags & os.O_DIRECTORY:
                        directory.rename(directory.with_name(directory.name + '-saved'))
                        directory.symlink_to(outside, target_is_directory=True)
                        swapped.append(True)
                    return fd
                with patch.object(pulls.os, 'open', side_effect=swap_after_open):
                    result = pulls.atomic_copy(source, target, root=self.root,
                                               expected=None if conflict else pulls.fingerprint(target))
                self.assertEqual(swapped, [True])
                self.assertTrue(result)
                self.assertEqual({p.name: p.read_text() for p in outside.iterdir()}, {target.name: 'outside'})
                saved = directory.with_name(directory.name + '-saved')
                written = result.name if conflict else target.name
                self.assertEqual((saved / written).read_text(), 'remote')
                self.assertFalse(any('.offbox-tmp-' in p.name for p in saved.iterdir()))

    def test_publication_error_rollback_preserves_concurrent_saves_and_reports_failed_restore(self):
        for error_code in (errno.ENOSPC, errno.EACCES):
            for recovery in ('restore', 'concurrent-save', 'restore-fails'):
                with self.subTest(error_code=error_code, recovery=recovery):
                    target = self.write_file(f'{error_code}-{recovery}.txt', 'base')
                    source = self.write_file(target.name, 'remote', remote=True)
                    backups = []
                    original_link = pulls.os.link
                    def fail(src, dst, **kwargs):
                        if '.offbox-tmp-' in Path(src).name:
                            if recovery == 'concurrent-save':
                                target.write_text('concurrent save')
                            raise OSError(error_code, 'injected publication failure')
                        if recovery == 'restore-fails':
                            raise OSError(errno.EIO, 'injected restore failure')
                        return original_link(src, dst, **kwargs)
                    with patch.object(pulls.os, 'link', side_effect=fail):
                        with self.assertRaises((OSError, common.OffboxError)) as raised:
                            pulls.atomic_copy(source, target, root=self.root,
                                              expected=pulls.fingerprint(target), backup_record=backups.append)
                    self.assertEqual(len(backups), 1)
                    self.assertEqual(backups[0].read_text(), 'base')
                    if recovery == 'restore-fails':
                        self.assertFalse(target.exists())
                        self.assertIn(backups[0].name, str(raised.exception))
                        self.assertIn('injected restore failure', str(raised.exception))
                    else:
                        self.assertEqual(target.read_text(), 'concurrent save' if recovery == 'concurrent-save' else 'base')
                    self.assertFalse(any('.offbox-tmp-' in p.name for p in self.root.iterdir()))

    def test_r2_historical_footer_only_log_recovers_command_output(self):
        self.baseline()
        self.con.execute("UPDATE runs SET status='failed',exit_code=7,command_id='history-r2'")
        with patch.object(ssh_sync, 'pull', return_value=dict(ok=True, files=0)):
            pulls.wait('run-pull')
        path = common.LOGS_DIR / 'run-pull.log'
        marker = '\n[offbox run-pull pulls]\n'
        path.write_text(marker + ''.join('offbox: ' + e['kind'] + ' ' + json.dumps(e) + '\n' for e in pulls.records('run-pull')))

        def page(box, command, stream, offset, **kwargs):
            value = 'actual command output\n' if stream == 'stdout' else ''
            return dict(data=value[offset:], nextOffset=len(value), size=len(value), done=True)

        with patch.object(misc.api, 'BACKEND', 'server'), patch.object(misc.api, 'history_logs', side_effect=page):
            outcome = misc._catch_up_log(self.row(), budget=1)
        self.assertIn(outcome, ('complete', 'caught_up'))
        self.assertIn('actual command output', path.read_text())
        self.assertIn('pull_end', path.read_text())


    def test_r3_sqlite_claim_respects_wait_deadline(self):
        self.write_file("f.txt", "base")
        self.baseline()
        self.con.execute("UPDATE runs SET status='failed',exit_code=7")
        entered, finished = threading.Event(), threading.Event()
        original_write = common.write
        result = {}
        @contextlib.contextmanager
        def observe_write(con):
            entered.set()
            with original_write(con):
                yield con
        def waiter():
            start = time.monotonic()
            try:
                pulls.wait("run-pull", until=common.now() + .04)
                result["code"] = 0
            except common.OffboxError as error:
                result["code"] = error.code
                result["message"] = str(error)
            except BaseException as error:
                result["error"] = repr(error)
            finally:
                result["elapsed"] = time.monotonic() - start
                finished.set()
        with patch.object(common, "write", side_effect=observe_write), patch.object(ssh_sync, "pull", side_effect=self.sync):
            self.con.execute("BEGIN IMMEDIATE")
            worker = threading.Thread(target=waiter)
            try:
                worker.start()
                self.assertTrue(entered.wait(2))
                result["finished_while_writer_held"] = finished.wait(.15)
            finally:
                self.con.rollback()
            worker.join(2)
        self.assertTrue(finished.is_set(), result)
        result["pull_state"] = self.row()["pull_state"]
        result["command_exit"] = self.row()["exit_code"]
        result["transfers"] = len(self.calls)
        self.assertEqual(result.get("code"), 124, result)
        self.assertTrue(result["finished_while_writer_held"], f"40ms pull wait remained blocked on a SQLite writer: {result}")

    def retarget_receipt(self, conflict):
        self.write_file("nested/f.txt", "base")
        self.baseline(["nested/f.txt"])
        if conflict:
            self.write_file("nested/f.txt", "local edit")
        self.write_file("nested/f.txt", "remote", remote=True)
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (outside / "f.txt").write_text("outside")
        nested = self.root / "nested"
        moved = self.root / "nested-saved"
        original_open = pulls.os.open
        swapped = []
        def retarget_after_open(path, flags, *args, **kwargs):
            fd = original_open(path, flags, *args, **kwargs)
            if str(path) == "nested" and flags & os.O_DIRECTORY and not swapped:
                nested.rename(moved)
                nested.symlink_to(outside, target_is_directory=True)
                swapped.append(True)
            return fd
        with patch.object(ssh_sync, "pull", side_effect=self.sync), patch.object(pulls.os, "open", side_effect=retarget_after_open):
            pulls.wait("run-pull")
        self.assertEqual(swapped, [True])
        kind, key = ("pull_conflict", "pulled_copy") if conflict else ("pull_backup", "backup")
        receipt = self.events(kind)[0]
        reported = self.root / receipt[key]
        expected = "remote" if conflict else "base"
        data = dict(pull_state=self.row()["pull_state"], receipt=receipt,
                    reported_exists=reported.exists(),
                    actual_files={str(p.relative_to(self.root)): p.read_text() for p in moved.iterdir() if p.is_file()},
                    outside_files={p.name: p.read_text() for p in outside.iterdir() if p.is_file()},
                    output=self.output.getvalue())
        self.assertEqual(data["outside_files"], {"f.txt": "outside"})
        self.assertEqual(reported.read_text() if reported.is_file() else None, expected,
                         f"receipt points to a missing recovery file after pinned-parent publication: {data}")

    def test_r3_retargeted_conflict_receipt_names_existing_copy(self):
        self.retarget_receipt(True)

    def test_r3_retargeted_backup_receipt_names_existing_backup(self):
        self.retarget_receipt(False)

    def test_recovery_paths_follow_renames_at_each_publication_boundary(self):
        for conflict, phase in ((False, 'displace'), (False, 'publish'), (True, 'publish')):
            with self.subTest(conflict=conflict, phase=phase):
                name = f'{conflict}-{phase}'
                directory = self.root / name
                directory.mkdir()
                target = directory / ('f.txt.offbox-pulled' if conflict else 'f.txt')
                target.write_text('base')
                original = pulls.fingerprint(target)
                source = self.write_file(name + '/f.txt', 'remote', remote=True)
                outside = Path(self.tmp.name) / name
                outside.mkdir()
                (outside / target.name).write_text('outside')
                moved = directory.with_name(name + '-saved')
                def swap():
                    directory.rename(moved)
                    directory.symlink_to(outside, target_is_directory=True)
                replace, link = pulls.os.replace, pulls.os.link
                def after_replace(src, dst, **kwargs):
                    result = replace(src, dst, **kwargs)
                    if phase == 'displace':
                        swap()
                    return result
                def after_link(src, dst, **kwargs):
                    result = link(src, dst, **kwargs)
                    if phase == 'publish' and '.offbox-tmp-' in str(src):
                        swap()
                    return result
                backups = []
                with patch.object(pulls.os, 'replace', side_effect=after_replace), \
                        patch.object(pulls.os, 'link', side_effect=after_link):
                    actual = pulls.atomic_copy(source, target, root=self.root,
                                               expected=None if conflict else original, backup_record=backups.append)
                self.assertIsInstance(actual, Path)
                self.assertEqual(actual.parent, moved)
                self.assertEqual(actual.read_text(), 'remote')
                if not conflict:
                    self.assertEqual(backups[0].parent, moved)
                    self.assertEqual(backups[0].read_text(), 'base')
                self.assertEqual({p.name: p.read_text() for p in outside.iterdir()}, {target.name: 'outside'})

    def test_sqlite_contention_at_receipts_and_final_update_is_bounded_and_retryable(self):
        for boundary in ('pull_start', 'pull_file', 'pull_end', 'terminal_update'):
            with self.subTest(boundary=boundary):
                self.con.execute("UPDATE runs SET status='failed',exit_code=7,pull_state=NULL")
                (common.LOGS_DIR / 'run-pull.pulls.jsonl').unlink(missing_ok=True)
                self.write_file('f.txt', 'base')
                self.baseline()
                self.write_file('f.txt', 'remote', remote=True)
                entered, held, finished = threading.Event(), threading.Event(), threading.Event()
                result = {}
                execute = common.StateConnection.execute
                def observe(con, sql, params=()):
                    receipt = sql.startswith('INSERT INTO events') and len(params) > 2 and params[2] == boundary
                    terminal = boundary == 'terminal_update' and sql.startswith('UPDATE runs SET pull_state=?,pull_ended_at=')
                    if (receipt or terminal) and threading.current_thread() is worker and not entered.is_set():
                        entered.set()
                        if not held.wait(2):
                            raise AssertionError('writer did not acquire the fixture lock')
                    return execute(con, sql, params)
                def wait_for_pull():
                    try:
                        pulls.wait('run-pull', until=common.now()+.08)
                        result['code'] = 0
                    except common.OffboxError as error:
                        result['code'] = error.code
                    except BaseException as error:
                        result['error'] = repr(error)
                    finally:
                        finished.set()
                worker = threading.Thread(target=wait_for_pull)
                with patch.object(common.StateConnection, 'execute', new=observe), \
                        patch.object(ssh_sync, 'pull', side_effect=self.sync):
                    worker.start()
                    try:
                        self.assertTrue(entered.wait(2))
                        self.con.execute('BEGIN IMMEDIATE')
                        held.set()
                        within_deadline = finished.wait(.25)
                    finally:
                        self.con.rollback()
                        held.set()
                        worker.join(2)
                self.assertTrue(within_deadline, result)
                self.assertEqual(result.get('code'), 124, result)
                self.assertEqual(self.row()['exit_code'], 7)
                self.assertEqual(pulls.records('run-pull')[-1]['outcome'], 'pending')
                with patch.object(ssh_sync, 'pull', side_effect=self.sync):
                    pulls.wait('run-pull', until=common.now()+1)
                self.assertEqual(self.row()['pull_state'], 'done')
                self.assertEqual((self.root / 'f.txt').read_text(), 'remote')


    def test_r4_backup_db_contention_retains_actual_main_write_receipt(self):
        self.write_file("f.txt", "base")
        self.baseline()
        self.write_file("f.txt", "remote", remote=True)
        self.con.execute("UPDATE runs SET status='failed',exit_code=7")
        entered, held, finished = threading.Event(), threading.Event(), threading.Event()
        execute = common.StateConnection.execute
        result = {}

        def observe(con, sql, parameters=()):
            backup_insert = (sql.startswith("INSERT INTO events") and len(parameters) > 2
                             and parameters[2] == "pull_backup")
            if backup_insert and threading.current_thread() is worker and not entered.is_set():
                entered.set()
                if not held.wait(2):
                    raise AssertionError("fixture writer failed to acquire lock")
            return execute(con, sql, parameters)

        def wait_for_pull():
            try:
                pulls.wait("run-pull", until=common.now() + .08)
                result["code"] = 0
            except common.OffboxError as error:
                result["code"] = error.code
                result["message"] = str(error)
            except BaseException as error:
                result["error"] = repr(error)
            finally:
                finished.set()

        worker = threading.Thread(target=wait_for_pull)
        with patch.object(common.StateConnection, "execute", new=observe), \
                patch.object(ssh_sync, "pull", side_effect=self.sync):
            worker.start()
            try:
                self.assertTrue(entered.wait(2), "did not reach actual backup event insertion")
                self.con.execute("BEGIN IMMEDIATE")
                held.set()
                within_bound = finished.wait(.3)
            finally:
                self.con.rollback()
                held.set()
                worker.join(2)
        self.assertTrue(within_bound, result)
        self.assertEqual(result.get("code"), 124, result)
        self.assertEqual(self.row()["exit_code"], 7)
        initial = pulls.records("run-pull")
        backup = [e for e in initial if e["kind"] == "pull_backup"][0]
        before_retry = dict(pull_state=self.row()["pull_state"],
                            main=(self.root / "f.txt").read_text(),
                            backup=(self.root / backup["backup"]).read_text(), records=initial)
        with patch.object(ssh_sync, "pull", side_effect=self.sync):
            pulls.wait("run-pull", until=common.now() + 1)
        final = pulls.records("run-pull")
        self.assertEqual(before_retry["main"], "remote")
        self.assertEqual(before_retry["backup"], "base")
        actual_writes = [e for e in final if e["kind"] == "pull_file"
                         and e.get("outcome") == "written" and e.get("written_copy") == "f.txt"]
        self.assertTrue(actual_writes,
                        "main f.txt was actually published before backup SQLite contention, but no actual-main-write receipt exists even after retry")
        self.assertEqual([e for e in initial if e['kind'] == 'pull_file'], actual_writes)
        self.assertEqual({k: actual_writes[0][k] for k in ('bytes', 'sha256')},
                         pulls.fingerprint(self.root / 'f.txt'))
        self.assertEqual(initial[-1]['files'], 1)
        self.assertEqual(initial[-1]['bytes'], len('remote'))
        self.assertEqual(self.row()['pull_state'], 'done')
        self.assertFalse((self.root / 'f.txt.offbox-pulled').exists())

    def test_r4_parent_moved_outside_during_publication_keeps_recovery_receipts(self):
        self.write_file("nested/f.txt", "base")
        self.baseline(["nested/f.txt"])
        self.write_file("nested/f.txt", "remote", remote=True)
        self.con.execute("UPDATE runs SET status='failed',exit_code=7")
        nested = self.root / "nested"
        moved = Path(self.tmp.name).resolve() / "moved-outside-worktree"
        original_replace = pulls.os.replace
        changed = []

        def after_displacement(source, destination, **kwargs):
            result = original_replace(source, destination, **kwargs)
            if str(source) == "f.txt" and ".offbox-local-" in str(destination) and not changed:
                nested.rename(moved)
                changed.append(True)
            return result

        with patch.object(ssh_sync, "pull", side_effect=self.sync), \
                patch.object(pulls.os, "replace", side_effect=after_displacement):
            pulls.wait("run-pull")
        self.assertEqual(changed, [True])
        records = pulls.records("run-pull")
        self.assertEqual((moved / "f.txt").read_text(), "remote")
        self.assertEqual(self.row()["exit_code"], 7)
        self.assertTrue([e for e in records if e["kind"] == "pull_backup"],
                        "a local inode backup was retained and incoming bytes published, but neither actual recovery path was recorded")
        backup = self.events('pull_backup')[0]
        written = self.events('pull_file')[0]
        self.assertEqual(Path(backup['backup']).parent, moved)
        self.assertEqual(Path(backup['backup']).read_text(), 'base')
        self.assertEqual(Path(written['written_copy']), moved / 'f.txt')
        self.assertEqual({k: written[k] for k in ('bytes', 'sha256')}, pulls.fingerprint(moved / 'f.txt'))
        self.assertEqual(json.loads(self.row()['pull_summary'])['files'], 1)

    def test_outside_parent_move_receipts_for_main_and_conflict_publications(self):
        for original, edited in ((None, None), ('base', None), ('base', 'local edit')):
            with self.subTest(original=original, edited=edited):
                self.con.execute('UPDATE runs SET pull_state=NULL')
                self.con.execute('DELETE FROM events')
                (common.LOGS_DIR / 'run-pull.pulls.jsonl').unlink(missing_ok=True)
                name = str(len(self.calls))
                relative = name + '/f.txt'
                directory = self.root / name
                directory.mkdir()
                if original is not None:
                    self.write_file(relative, original)
                self.baseline([relative])
                if edited is not None:
                    self.write_file(relative, edited)
                self.write_file(relative, 'remote', remote=True)
                moved = Path(self.tmp.name).resolve() / ('outside-' + name)
                link = pulls.os.link
                swapped = []
                def after_publication(src, dst, **kwargs):
                    result = link(src, dst, **kwargs)
                    if '.offbox-tmp-' in str(src) and not swapped:
                        directory.rename(moved)
                        swapped.append(True)
                    return result
                with patch.object(ssh_sync, 'pull', side_effect=self.sync), \
                        patch.object(pulls.os, 'link', side_effect=after_publication):
                    pulls.wait('run-pull')
                kind, key = ('pull_conflict', 'pulled_copy') if edited else ('pull_file', 'written_copy')
                receipt = self.events(kind)[0]
                actual = Path(receipt[key])
                self.assertEqual(actual.parent, moved)
                self.assertEqual(actual.read_text(), 'remote')
                self.assertEqual({k: receipt[k] for k in ('bytes', 'sha256')}, pulls.fingerprint(actual))
                if edited:
                    self.assertEqual((moved / 'f.txt').read_text(), edited)
                if original and not edited:
                    backup = Path(self.events('pull_backup')[0]['backup'])
                    self.assertEqual(backup.parent, moved)
                    self.assertEqual(backup.read_text(), original)
                summary = json.loads(self.row()['pull_summary'])
                self.assertEqual((summary['files'], summary['bytes'], summary['conflicts']), (1, 6, int(bool(edited))))


    def test_merged_kill_completion_uses_one_claim_and_preserves_local_edit(self):
        self.write_file('f.txt', 'base')
        self.baseline()
        self.write_file('f.txt', 'edit after push')
        self.write_file('f.txt', 'remote', remote=True)
        self.con.execute("UPDATE runs SET status='killed',exit_code=143")
        with patch.object(ssh_sync, 'pull', side_effect=self.sync):
            self.assertEqual(runs.complete_killed(self.row(), pulls=['f.txt'], role='fg'), 143)
            self.assertEqual(runs.complete_killed(self.row(), pulls=['f.txt']), 143)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual((self.row()['status'], self.row()['exit_code'], self.row()['pull_state']),
                         ('killed', 143, 'partial'))
        self.assertEqual((self.root/'f.txt').read_text(), 'edit after push')
        self.assertEqual((self.root/'f.txt.offbox-pulled').read_text(), 'remote')
        self.assertEqual(self.events('pull_conflict')[0]['role'], 'fg')
        self.assertIn('pulls: partial (1 files, 1 conflicts)', self.output.getvalue())

    def test_merged_kill_completion_observes_existing_pull_claim_and_timeout(self):
        self.baseline()
        self.con.execute("UPDATE runs SET status='killed',exit_code=143,pull_state='running',pull_owner=?",
                         (json.dumps(dict(pid=os.getpid(),role='refresh')),))
        clock = [100.0]
        def pause(seconds):
            clock[0] += seconds
        with patch.object(common, 'now', side_effect=lambda: clock[0]), \
                patch.object(pulls.time, 'sleep', side_effect=pause), \
                patch.object(ssh_sync, 'pull') as transfer:
            with self.assertRaises(common.OffboxError) as raised:
                runs.complete_killed(self.row(), pulls=['f.txt'], until=100.2)
        self.assertEqual(raised.exception.code, 124)
        transfer.assert_not_called()
        self.assertEqual((self.row()['exit_code'], self.row()['pull_state']), (143,'running'))
        self.assertIn('pulls: still running', self.output.getvalue())

    def test_queued_edit_is_the_push_baseline(self):
        self.write_file('f.txt', 'at queue time')
        self.write_file('f.txt', 'edited before push')
        self.baseline()
        self.write_file('f.txt', 'remote', remote=True)
        self.assertEqual(common.read_json(pulls.baseline_path('run-pull'), {})['files']['f.txt'],
                         pulls.fingerprint(self.root/'f.txt'))
        with patch.object(ssh_sync, 'pull', side_effect=self.sync):
            pulls.wait('run-pull')
        self.assertEqual((self.root/'f.txt').read_text(), 'remote')
        backups=self.events('pull_backup')
        self.assertEqual(len(backups),1)
        self.assertEqual((self.root/backups[0]['backup']).read_text(),'edited before push')
        self.assertEqual(self.row()['pull_state'],'done')


def configure_push_fixture(root):
    from test_bg_queue_detach import configure_fixture
    a, me = configure_fixture(root, 'boat')
    runs.BG_ENTRY = Path(__file__).resolve()
    a.no_sync = False
    a.pull = ['f.txt']
    os.chdir(root)
    def pushed(*args, **kwargs):
        (root / 'push-pid').write_text(str(os.getpid()))
        return dict(seconds=0, sent=0)
    ssh_sync.push = pushed
    ssh_sync.put_file = lambda *args: None
    runs.Runner._prepare_box = runs.Runner._sync_box
    return a, me


if __name__ == '__main__' and len(sys.argv) > 1:
    if sys.argv[1] == '--push-fixture':
        a, me = configure_push_fixture(Path(sys.argv[2]))
        sys.exit(runs.run_remote(a, me))
    elif sys.argv[1] == '_bg-queue':
        payload = json.load(sys.stdin)
        os.environ.clear()
        os.environ.update(payload['env'])
        configure_push_fixture(Path(os.environ['OFFBOX_TEST_ROOT']))
        code = runs.background_queue(sys.argv[2], payload)
        (Path(os.environ['OFFBOX_TEST_ROOT']) / 'push-complete').write_text('done')
        sys.exit(code)
