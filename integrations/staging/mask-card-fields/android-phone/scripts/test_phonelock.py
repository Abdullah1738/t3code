"""Phone ownership regressions, with no real adb or u2 calls."""
import ast
import contextlib
import datetime as dt
import importlib.util
import io
import json
import multiprocessing as mp
import os
from pathlib import Path
import signal
import threading
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ph
import phonelock as lock

HOLD_TOKEN = '#21 full16 / current worker thread'
TREE = '<hierarchy><node text="Copy" bounds="[0,0][20,20]" package="dev.test" /></hierarchy>'


def race(directory, owner, ready, go, results):
    lock.LOCK_DIR = Path(directory)
    lock.HOLD = lock.LOCK_DIR / 'priority-hold'
    lock.LEASE = lock.LOCK_DIR / 'lease.json'
    lock.event_hook = lambda kind: None
    ready.put(True)
    go.wait(10)
    try:
        lock.acquire(owner, 'race')
        results.put(True)
    except lock.Busy:
        results.put(False)


class PhoneLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.device = Mock()
        self.device.dump_hierarchy.return_value = TREE
        for obj, name, value in [(lock, 'LOCK_DIR', self.root), (lock, 'HOLD', self.root/'priority-hold'),
                                  (lock, 'LEASE', self.root/'lease.json'), (ph, 'STATE', self.root/'events'),
                                  (ph, 'd', Mock(return_value=self.device)), (ph, '_d', None),
                                  (lock, 'event_hook', ph.lock_event), (lock, '_lost_holds', set()),
                                  (ph, 'caller_chain', Mock(return_value=[dict(pid=123, comm='zsh', cwd_tail='projects/fixture')]))]:
            p = patch.object(obj, name, value)
            p.start(); self.addCleanup(p.stop)
        p = patch.dict(os.environ, {'PH_LOCK_DIR': str(self.root), 'PH_LEASE_OWNER': '', 'PHONE_HOLD_OWNER': ''})
        p.start(); self.addCleanup(p.stop)
        p = patch.object(ph.subprocess, 'run', side_effect=AssertionError('No device or process probes'))
        p.start(); self.addCleanup(p.stop)
        p = patch.object(ph, '_run', side_effect=AssertionError('No adb'))
        p.start(); self.addCleanup(p.stop)
        p = patch.object(ph.time, 'sleep')
        p.start(); self.addCleanup(p.stop)

    def cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = ph.run(list(args))
        return code, out.getvalue()

    def events(self):
        path = ph.STATE/'events.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def claim(self, owner='holder', ttl='20m'):
        return lock.acquire(owner, 'qa', ttl)

    def hold(self, age=0, pid=None, started=None):
        (self.root/'priority-hold.owner.json').unlink(missing_ok=True)
        lock.HOLD.write_text(HOLD_TOKEN)
        stamp = lock.now().timestamp()-age
        os.utime(lock.HOLD, (stamp, stamp))
        if pid is not None:
            (self.root/'priority-hold.owner.json').write_text(json.dumps(dict(
                token_sha=lock.token_sha(HOLD_TOKEN), agent_pid=pid, agent_comm='claude',
                hold_dev=lock.HOLD.stat().st_dev, hold_ino=lock.HOLD.stat().st_ino,
                agent_started=started or 'fixture start', recorded_at=lock.now().isoformat())))

    def test_dead_and_reused_holder_gate_archive_and_privacy(self):
        for started in (False, 'reused start'):
            with self.subTest(started=started):
                self.hold(pid=99999999)
                with patch.object(lock, 'process_started', return_value=started):
                    code, out = self.cli('open', 'dev.example')
                self.assertEqual(code, 0)
                self.assertFalse(lock.HOLD.exists())
                self.assertFalse((self.root/'priority-hold.owner.json').exists())
                archives = list(self.root.glob('priority-hold.stale-*'))
                self.assertTrue(archives)
                self.assertTrue(all(p.read_text() == HOLD_TOKEN for p in archives))
                rows = [r for r in self.events() if r['event']=='hold_archived']
                self.assertEqual(rows[-1]['reason'], 'holder_exited')
                self.assertEqual(rows[-1]['token_sha'], lock.token_sha(HOLD_TOKEN))
                self.assertIn('caller_chain', rows[-1])
                self.assertNotIn(HOLD_TOKEN, out+json.dumps(self.events()))

    def test_holder_age_and_unknown_metadata_matrix(self):
        for metadata in ('live', 'missing', 'mismatched', 'broken', 'probe_failed'):
            for age, code in ((29*60, 5), (31*60, 0)):
                with self.subTest(metadata=metadata, age=age):
                    (self.root/'priority-hold.owner.json').unlink(missing_ok=True)
                    self.hold(age, os.getpid() if metadata != 'missing' else None)
                    if metadata=='mismatched':
                        (self.root/'priority-hold.owner.json').write_text('{"token_sha":"other","agent_pid":99999999}')
                    elif metadata=='broken':
                        (self.root/'priority-hold.owner.json').write_text('not json')
                    with patch.object(lock, 'process_started', return_value=None if metadata=='probe_failed' else 'fixture start'):
                        result, out = self.cli('open', 'dev.example')
                    self.assertEqual(result, code, out)
                    if code==0:
                        self.assertEqual([r for r in self.events() if r['event']=='hold_archived'][-1]['reason'], 'not_refreshed')
                    self.assertNotIn(HOLD_TOKEN, out+json.dumps(self.events()))

    def test_own_call_refreshes_at_most_once_per_minute_and_lazy_metadata(self):
        self.hold(90)
        os.environ['PHONE_HOLD_OWNER'] = HOLD_TOKEN
        self.assertEqual(self.cli('help')[0], 0)
        first = lock.HOLD.stat().st_mtime_ns
        self.assertLess(abs(lock.HOLD.stat().st_mtime-lock.now().timestamp()), 2)
        sidecar = self.root/'priority-hold.owner.json'
        owner = json.loads(sidecar.read_text())
        self.assertIsNone(owner['agent_pid'])
        self.assertNotIn(HOLD_TOKEN, sidecar.read_text())
        self.assertEqual(self.cli('open', 'dev.example')[0], 0)
        self.assertEqual(lock.HOLD.stat().st_mtime_ns, first)
        sidecar.write_text('{"token_sha":"wrong"}')
        self.assertEqual(self.cli('hold', 'refresh')[0], 0)
        self.assertEqual(json.loads(sidecar.read_text())['token_sha'], lock.token_sha(HOLD_TOKEN))

    def test_hold_acquire_refresh_release_and_status(self):
        self.hold(31*60)
        self.assertEqual(self.cli('hold', 'acquire', '--token', HOLD_TOKEN)[0], 0)
        self.assertEqual(self.cli('hold', 'acquire', '--token', 'other')[0], 5)
        self.assertEqual(self.cli('hold', 'release')[0], 5)
        self.assertEqual(self.cli('hold', 'refresh')[0], 5)
        self.assertTrue(lock.HOLD.exists())
        os.environ['PHONE_HOLD_OWNER'] = HOLD_TOKEN
        self.assertEqual(self.cli('hold', 'refresh')[0], 0)
        self.assertEqual(self.cli('hold', 'release')[0], 0)
        self.assertFalse(lock.HOLD.exists())
        self.assertFalse((self.root/'priority-hold.owner.json').exists())
        self.hold(31*60)
        code, out = self.cli('hold', 'status', '--json')
        state = json.loads(out)
        self.assertEqual(code, 0)
        self.assertFalse(state['present'])
        self.assertEqual(state['archived'], 'not_refreshed')
        self.assertNotIn(HOLD_TOKEN, out+json.dumps(self.events()))

    def test_hold_status_live_fields_and_lease_status_sweep(self):
        self.hold(29*60, os.getpid())
        with patch.object(lock, 'process_started', return_value='fixture start'):
            state = json.loads(self.cli('hold', 'status', '--json')[1])
        self.assertTrue(state['holder_alive'])
        self.assertEqual(state['agent_comm'], 'claude')
        self.assertAlmostEqual(state['stale_in_s'], 60, delta=2)
        self.hold(31*60)
        state = json.loads(self.cli('lease', 'status', '--json')[1])
        self.assertFalse(state['hold_present'])
        self.assertEqual(state['archived'], 'not_refreshed')

    def test_hold_replace_or_refresh_at_rename_restores_and_refuses(self):
        real_rename = os.rename
        for change in ('replace', 'refresh', 'third_holder'):
            with self.subTest(change=change):
                self.hold(31*60)
                def renamed(source, target):
                    if change in ('replace', 'third_holder'):
                        lock.HOLD.unlink()
                        lock.HOLD.write_text('successor token')
                    else:
                        os.utime(lock.HOLD, None)
                    real_rename(source, target)
                    if change=='third_holder': lock.HOLD.write_text('third token')
                with patch.object(lock.os, 'rename', side_effect=renamed):
                    self.assertEqual(self.cli('open', 'dev.example')[0], 5)
                self.assertEqual(lock.HOLD.read_text(), 'third token' if change=='third_holder' else
                                 'successor token' if change=='replace' else HOLD_TOKEN)
        self.device.app_start.assert_not_called()
        self.assertFalse(any(r['event']=='hold_archived' for r in self.events()))

    def test_metadata_nearest_agent_and_start_probe(self):
        for chain, expected in ((['claude','codex'], 'claude'), (['codex','claude'], 'codex'),
                                (['opencode','codex'], 'opencode'), (['zsh'], None)):
            with self.subTest(chain=chain):
                rows = [dict(pid=100+i, comm=c, cwd_tail=None) for i,c in enumerate(chain)]
                with patch.object(ph, 'caller_chain', return_value=rows), patch.object(lock, 'process_started', return_value=' raw start '):
                    owner = lock.holder_metadata(HOLD_TOKEN)
                self.assertEqual(owner['agent_comm'], expected)
                self.assertEqual(owner['agent_pid'], 100 if expected in ('claude','codex') else None)
                self.assertNotIn(HOLD_TOKEN, json.dumps(owner))
        for result, expected in ((Mock(returncode=0, stdout=' raw start \n'), ' raw start '),
                                 (Mock(returncode=1, stdout=''), False), (Mock(returncode=2, stdout=''), None)):
            with patch.object(lock.subprocess, 'run', return_value=result):
                self.assertEqual(lock.process_started(os.getpid()), expected)

    def test_process_alive_tristate_and_library_hold_lifecycle(self):
        for result, expected in [('fixture start',True), ('reused',False), (False,False), (None,None)]:
            with self.subTest(result=result), patch.object(lock, 'process_started', return_value=result):
                self.assertIs(lock.process_alive(os.getpid(), 'fixture start'), expected)
        for pid, started in [(None,'start'), (True,'start'), (0,'start'), (123,None), (123,'')]:
            self.assertIsNone(lock.process_alive(pid,started))
        with patch.object(lock, 'process_started', return_value='runner start'), patch.object(ph, 'process_comm', return_value='Python'):
            lock.hold_acquire(HOLD_TOKEN, holder_pid=os.getpid())
            owner=json.loads((self.root/'priority-hold.owner.json').read_text())
            self.assertEqual((owner['agent_pid'],owner['agent_started']), (os.getpid(),'runner start'))
            state=lock.hold_status()
            self.assertTrue(state['holder_alive'])
            self.assertEqual(state['agent_comm'],'Python')
        with self.assertRaises(lock.Busy): lock.hold_release('foreign')
        self.assertTrue(lock.HOLD.exists())
        lock.hold_release(HOLD_TOKEN)
        self.assertFalse(lock.HOLD.exists())
        self.assertFalse((self.root/'priority-hold.owner.json').exists())

    def test_staleness_override_duration_forms(self):
        for value, seconds in [('30m',1800), ('1800',1800), ('1800s',1800), ('0.5h',1800), ('0.1s',0.1)]:
            with self.subTest(value=value), patch.dict(os.environ, PH_HOLD_STALE_AFTER=value):
                self.assertEqual(lock.hold_stale_after(), seconds)
                self.hold(seconds+1)
                self.assertFalse(lock.hold_state()[0])
        for value in ('0', '-1', 'NaN', '30minutes', ''):
            with self.subTest(value=value), patch.dict(os.environ, PH_HOLD_STALE_AFTER=value):
                with self.assertRaises(ValueError): lock.hold_stale_after()

    def test_empty_and_whitespace_holds_expire_but_fresh_stays_busy(self):
        for contents in ('', '\n', '  \t'):
            for age, expected in ((29*60,5), (31*60,0)):
                with self.subTest(contents=contents,age=age):
                    self.hold(age)
                    lock.HOLD.write_text(contents)
                    stamp=lock.now().timestamp()-age
                    os.utime(lock.HOLD,(stamp,stamp))
                    self.assertEqual(self.cli('open','dev.fixture')[0],expected)

    def test_previous_hold_metadata_cannot_reap_reused_token(self):
        self.hold(pid=99999999)
        os.rename(lock.HOLD,self.root/'previous-hold')
        lock.HOLD.write_text(HOLD_TOKEN)
        with patch.object(lock,'process_started',return_value=False) as probe:
            self.assertEqual(self.cli('open','dev.fixture')[0],5)
        probe.assert_not_called()
        self.assertTrue(lock.HOLD.exists())
        self.assertFalse(list(self.root.glob('priority-hold.stale-*')))

    def test_own_expired_hold_stops_device_command_before_reacquire(self):
        for age, pid in ((31*60,None),(0,99999999)):
            with self.subTest(age=age,pid=pid):
                self.hold(age,pid)
                with patch.dict(os.environ,PHONE_HOLD_OWNER=HOLD_TOKEN), patch.object(lock,'process_started',return_value=False):
                    code,out=self.cli('open','dev.fixture')
                self.assertEqual(code,5,out)
                self.assertIn('acquire it again',out)
                self.assertFalse(lock.HOLD.exists())
                self.assertEqual(self.events()[-1]['reason'],'hold')
        self.device.app_start.assert_not_called()

    def test_sidecar_write_failures_do_not_lose_owned_hold(self):
        import errno
        for failure in (errno.ENOSPC,errno.EACCES):
            with self.subTest(failure=failure), patch.object(lock,'write_holder',side_effect=OSError(failure,'fixture')):
                lock.HOLD.unlink(missing_ok=True)
                self.assertEqual(self.cli('hold','acquire','--token',HOLD_TOKEN)[0],0)
                with patch.dict(os.environ,PHONE_HOLD_OWNER=HOLD_TOKEN):
                    self.assertEqual(self.cli('open','dev.fixture')[0],0)
                    self.assertEqual(self.cli('hold','release')[0],0)
                self.assertFalse(lock.HOLD.exists())

    def test_invalid_staleness_override_uses_default_without_breaking_release(self):
        for value in ('0','-1','NaN','30minutes',''):
            with self.subTest(value=value), patch.dict(os.environ,PH_HOLD_STALE_AFTER=value):
                self.hold(29*60)
                self.assertEqual(self.cli('help')[0],0)
                self.assertEqual(self.cli('open','dev.fixture')[0],5)
                self.hold(31*60)
                self.assertEqual(self.cli('hold','status','--json')[0],0)
                self.claim()
                self.hold()
                self.assertEqual(self.cli('lease','release','--owner','holder')[0],0)
                self.assertFalse(lock.LEASE.exists())

    def test_release_preserves_changes_before_removal(self):
        real_unlink, real_rename = Path.unlink, os.rename
        for change in ('replace', 'same_token', 'unreadable', 'refresh', 'rewrite', 'third_holder'):
            with self.subTest(change=change):
                self.hold(120)
                lock.write_holder(HOLD_TOKEN)
                sidecar = self.root/'priority-hold.owner.json'
                metadata = sidecar.read_bytes()
                raced = False
                def replace():
                    nonlocal raced
                    raced = True
                    if change == 'refresh':
                        os.utime(lock.HOLD, None)
                    elif change == 'rewrite':
                        lock.HOLD.write_text('successor token')
                    else:
                        real_unlink(lock.HOLD)
                        lock.HOLD.write_bytes(b'\xff' if change == 'unreadable' else
                                              HOLD_TOKEN.encode() if change == 'same_token' else b'successor token')
                def unlink(path, *args, **kwargs):
                    if path == lock.HOLD and not raced: replace()
                    return real_unlink(path, *args, **kwargs)
                def rename(source, target):
                    if source == lock.HOLD and not raced: replace()
                    result = real_rename(source, target)
                    if source == lock.HOLD and change == 'third_holder': lock.HOLD.write_text('third token')
                    return result
                with patch.object(Path, 'unlink', unlink), patch.object(lock.os, 'rename', side_effect=rename):
                    with self.assertRaises(lock.Busy): lock.hold_release(HOLD_TOKEN)
                expected = (b'third token' if change == 'third_holder' else b'\xff' if change == 'unreadable'
                            else HOLD_TOKEN.encode() if change in ('same_token', 'refresh') else b'successor token')
                self.assertTrue(raced)
                self.assertEqual(lock.HOLD.read_bytes(), expected)
                self.assertEqual(sidecar.read_bytes(), metadata)
                self.assertEqual(self.cli('open', 'dev.fixture')[0], 5)
                if change == 'third_holder':
                    self.assertTrue(any(p.read_bytes() == b'successor token'
                                        for p in self.root.glob('.hold-release-*')))
        self.device.app_start.assert_not_called()
        self.assertFalse(any(r['event'] == 'hold_archived' for r in self.events()))

    def test_successful_release_keeps_unreadable_successor(self):
        real_rename = os.rename
        for contents in (b'successor token', b'\xff'):
            with self.subTest(contents=contents):
                self.hold()
                def replace_after_rename(source, target):
                    result = real_rename(source, target)
                    if source == lock.HOLD: lock.HOLD.write_bytes(contents)
                    return result
                with patch.object(lock.os, 'rename', side_effect=replace_after_rename):
                    lock.hold_release(HOLD_TOKEN)
                self.assertEqual(lock.HOLD.read_bytes(), contents)
                self.assertEqual(self.cli('open', 'dev.fixture')[0], 5)
        self.device.app_start.assert_not_called()

    def test_lazy_metadata_replacement_does_not_grant_successor_access(self):
        self.hold()
        def replace(*_args):
            lock.HOLD.unlink()
            lock.HOLD.write_text('successor')
        with patch.dict(os.environ,PHONE_HOLD_OWNER=HOLD_TOKEN), patch.object(lock,'write_holder',side_effect=replace):
            self.assertEqual(self.cli('open','dev.fixture')[0],5)
        self.assertEqual(lock.HOLD.read_text(),'successor')
        self.device.app_start.assert_not_called()

    def test_bad_library_holder_pid_leaves_no_hold(self):
        for pid in (0,-1,True,False,'123',1.5):
            with self.subTest(pid=pid):
                with self.assertRaises(ValueError): lock.hold_acquire(HOLD_TOKEN,holder_pid=pid)
                self.assertFalse(lock.HOLD.exists())
                self.assertFalse((self.root/'priority-hold.owner.json').exists())

    def test_broken_metadata_lock_keeps_diagnostics_and_gate_usable(self):
        for failure in (FileExistsError,PermissionError,NotADirectoryError):
            with self.subTest(failure=failure), patch.object(lock,'metadata_lock',side_effect=failure):
                for args in [('help',),('log',),('ui',)]:
                    self.assertEqual(self.cli(*args)[0],0)
                code,out=self.cli('open','dev.fixture')
                self.assertEqual(code,5,out)
                self.assertIn('lease metadata unavailable',out)
        self.device.app_start.assert_not_called()

    def test_event_path_sweep_keeps_lost_hold_until_reacquired(self):
        for sweep in (lambda: lock.status(), lambda: ph.lock_event('fixture')):
            with self.subTest(sweep=sweep), patch.dict(os.environ,PHONE_HOLD_OWNER=HOLD_TOKEN):
                self.hold(pid=99999999)
                with patch.object(lock,'process_started',return_value=False): sweep()
                self.assertFalse(lock.HOLD.exists())
                self.assertEqual(self.cli('open','dev.fixture')[0],5)
                self.assertEqual(self.cli('open','dev.fixture')[0],5)
                self.assertNotIn(HOLD_TOKEN,str(lock._lost_holds))
                lock.hold_acquire(HOLD_TOKEN)
                self.assertEqual(self.cli('open','dev.fixture')[0],0)

    def test_hold_discovered_dead_in_action_status_refuses_send(self):
        self.hold(pid=99999999)
        with patch.dict(os.environ,PHONE_HOLD_OWNER=HOLD_TOKEN), patch.object(lock,'process_started',side_effect=['fixture start',False]):
            code,out=self.cli('open','dev.fixture')
        self.assertEqual(code,5,out)
        self.assertIn('acquire it again',out)
        self.device.app_start.assert_not_called()

    def test_refresh_of_absent_or_expired_hold_requests_reacquire(self):
        with patch.dict(os.environ,PHONE_HOLD_OWNER=HOLD_TOKEN):
            for age in (None,31*60):
                with self.subTest(age=age):
                    if age is not None: self.hold(age)
                    code,out=self.cli('hold','refresh')
                    self.assertEqual(code,5,out)
                    self.assertIn('acquire it again',out)
                    self.assertFalse(lock.HOLD.exists())

    def test_invalid_hold_arguments_never_echo_tokens(self):
        for args in [('acquire', '--token', HOLD_TOKEN, 'extra'), ('status', HOLD_TOKEN),
                     (HOLD_TOKEN,), ('acquire', '--token='+HOLD_TOKEN, '--bad')]:
            code, out = self.cli('hold', *args)
            self.assertEqual(code, 2)
            self.assertNotIn(HOLD_TOKEN, out+json.dumps(self.events()))

    def test_exclusive_and_nonowner_release(self):
        self.claim()
        with self.assertRaises(lock.Busy): self.claim('other')
        with self.assertRaises(lock.Busy): lock.release('other')
        self.assertEqual(lock.status()['lease_owner'], 'holder')
        lock.release('holder')
        self.assertFalse(lock.LEASE.exists())

    def test_exclusive_runner_claim_class(self):
        for owner in ('holder', 'other'):
            with self.subTest(existing='live', caller=owner):
                self.claim()
                with self.assertRaises(lock.Busy): lock.acquire(owner, 'runner', exclusive=True)
                self.assertEqual(lock.status()['lease_owner'], 'holder')
                lock.release('holder')
        for owner in ('holder', 'other'):
            with self.subTest(existing='expired', caller=owner):
                lease = self.claim()
                lease['acquired_at'] = (lock.now()-dt.timedelta(minutes=30)).isoformat()
                lease['expires_at'] = (lock.now()-dt.timedelta(minutes=10)).isoformat()
                lock.LEASE.write_text(json.dumps(lease))
                lock.acquire(owner, 'runner', exclusive=True)
                self.assertEqual(lock.status()['lease_owner'], owner)
                lock.release(owner)

    def test_wrapper_instance_cannot_refresh_or_release_same_owner_successor(self):
        lease = self.claim()
        first_id = lease['lease_id']
        refreshed = self.claim()
        self.assertEqual(refreshed['lease_id'], first_id)
        lease['acquired_at'] = (lock.now()-dt.timedelta(minutes=30)).isoformat()
        lease['expires_at'] = (lock.now()-dt.timedelta(minutes=10)).isoformat()
        lock.LEASE.write_text(json.dumps(lease))
        successor = self.claim()
        self.assertNotEqual(successor['lease_id'], first_id)
        for mutate in (lock.release, lock.refresh):
            with self.subTest(operation=mutate.__name__), self.assertRaises(lock.Busy):
                mutate('holder', lease_id=first_id)
        self.assertEqual(lock.status()['lease']['lease_id'], successor['lease_id'])
        lock.release('holder', lease_id=successor['lease_id'])

    def test_recent_and_expired_corruption_class(self):
        for raw in ['', '{"owner":', '{}', '{"owner":5}', '{"expires_at":"invalid"}', b'\xff', b'\xc3', b'\xff\xfe']:
            with self.subTest(raw=raw):
                lock.LEASE.write_bytes(raw) if isinstance(raw, bytes) else lock.LEASE.write_text(raw)
                self.assertFalse(lock.check(True)[0])
                with self.assertRaises(lock.Busy): self.claim('other')
                with self.assertRaises(lock.Busy): lock.release('unknown')
                old = time.time()-lock.MAX_TTL-1
                os.utime(lock.LEASE, (old, old))
                self.assertTrue(lock.check(True)[0])
                self.claim('other')
                self.assertEqual(lock.status()['lease_owner'], 'other')
                self.assertEqual(self.events()[-1]['event'], 'lease_expired_takeover')
                lock.release('other')

    def test_twenty_multiprocess_races(self):
        ctx = mp.get_context('spawn')
        for _ in range(20):
            ready, results, go = ctx.Queue(), ctx.Queue(), ctx.Event()
            jobs = [ctx.Process(target=race, args=(str(self.root), name, ready, go, results)) for name in ('one', 'two')]
            for job in jobs: job.start()
            for job in jobs: self.assertTrue(ready.get(timeout=15))
            go.set()
            self.assertEqual(sorted(results.get(timeout=15) for _ in jobs), [False, True])
            for job in jobs:
                job.join(15)
                self.assertEqual(job.exitcode, 0)
            lock.release(lock.status()['lease_owner'])

    def test_expired_takeover_is_logged(self):
        self.claim()
        lease = json.loads(lock.LEASE.read_text())
        lease['acquired_at'] = (lock.now()-dt.timedelta(minutes=30)).isoformat()
        lease['expires_at'] = (lock.now()-dt.timedelta(minutes=10)).isoformat()
        lock.LEASE.write_text(json.dumps(lease))
        self.assertTrue(lock.check(True)[0])
        self.claim('new')
        self.assertEqual(lock.status()['lease_owner'], 'new')
        self.assertEqual(self.events()[-1]['event'], 'lease_expired_takeover')

    def test_expired_takeover_race(self):
        self.claim()
        lease = json.loads(lock.LEASE.read_text())
        lease['acquired_at'] = (lock.now()-dt.timedelta(minutes=30)).isoformat()
        lease['expires_at'] = (lock.now()-dt.timedelta(minutes=10)).isoformat()
        lock.LEASE.write_text(json.dumps(lease))
        ctx = mp.get_context('spawn')
        ready, results, go = ctx.Queue(), ctx.Queue(), ctx.Event()
        jobs = [ctx.Process(target=race, args=(str(self.root), name, ready, go, results)) for name in ('one', 'two')]
        for job in jobs: job.start()
        for job in jobs: ready.get(timeout=15)
        go.set()
        self.assertEqual(sorted(results.get(timeout=15) for _ in jobs), [False, True])
        for job in jobs:
            job.join(15); self.assertEqual(job.exitcode, 0)

    def test_hold_blocks_acquire_even_for_holder(self):
        lock.HOLD.write_text(HOLD_TOKEN)
        os.environ['PHONE_HOLD_OWNER'] = HOLD_TOKEN
        with self.assertRaises(lock.Busy): self.claim()

    def test_hold_blocks_actions_and_reads_without_device_or_reset(self):
        lock.HOLD.write_text(HOLD_TOKEN)
        for cmd in [('open', 'dev.example'), ('ui',), ('shot', 'x'), ('cur',), ('wait', 'x'),
                    ('find', 'x'), ('sms',), ('doctor',), ('sh', 'private-command'), ('type', 'secret')]:
            with self.subTest(cmd=cmd):
                with patch.object(ph, 'reset_u2') as reset:
                    code, out = self.cli(*cmd)
                self.assertEqual(code, 5)
                self.assertIn(lock.HOLD_REASON, out)
                self.assertNotIn(HOLD_TOKEN, out)
                reset.assert_not_called()
                ph.d.assert_not_called()
                ph._run.assert_not_called()
                ph.subprocess.run.assert_not_called()
                row = self.events()[-1]
                self.assertEqual((row['event'], row['reason'], row['cmd']), ('busy_refused', 'hold', cmd[0]))
        self.assertNotIn(HOLD_TOKEN, json.dumps(self.events()))
        self.assertNotIn('secret', json.dumps(self.events()))

    def test_exact_free_text_hold_owner_and_priority_over_lease(self):
        self.claim()
        lock.HOLD.write_text(HOLD_TOKEN+'\n')
        for owner, code in [('', 5), ('different', 5), (HOLD_TOKEN, 0)]:
            with patch.dict(os.environ, {'PHONE_HOLD_OWNER': owner}):
                self.assertEqual(self.cli('open', 'dev.example')[0], code)
        self.device.app_start.assert_called_once_with('dev.example')

    def test_hold_disappears_after_start_check(self):
        lock.HOLD.write_text(HOLD_TOKEN)
        os.environ['PHONE_HOLD_OWNER'] = HOLD_TOKEN
        def connect():
            lock.HOLD.unlink()
            return self.device
        ph.d.side_effect = connect
        self.assertEqual(self.cli('open', 'dev.example')[0], 0)
        self.device.app_start.assert_called_once()

    def test_unreadable_and_empty_hold_fail_closed(self):
        lock.HOLD.write_text('')
        self.assertEqual(lock.check(False), (False, lock.HOLD_REASON))
        with patch.object(Path, 'read_text', side_effect=PermissionError):
            self.assertEqual(lock.check(True), (False, lock.HOLD_REASON))
        lock.HOLD.unlink()
        with patch.object(Path, 'read_text', side_effect=PermissionError):
            self.assertEqual(lock.hold_state(), (False, False))

    def test_local_commands_work_under_hold(self):
        lock.HOLD.write_text(HOLD_TOKEN)
        for args in [('help',), ('-h',), ('log',), ('lease', 'status', '--json'),
                     ('note-drop', '--source', 'fixture', '--cmd', 'read', '--exc', 'ConnectionError')]:
            self.assertEqual(self.cli(*args)[0], 0)
        ph.d.assert_not_called(); ph._run.assert_not_called()
        ph.subprocess.run.assert_not_called()

    def test_foreign_lease_blocks_tap_and_type_without_input_in_logs(self):
        self.claim()
        for args in [('tap', '10', '10'), ('type', 'secret')]:
            code, out = self.cli(*args)
            self.assertEqual(code, 5)
            self.assertNotIn('secret', out)
        self.device.click.assert_not_called(); self.device.send_keys.assert_not_called()
        self.assertNotIn('secret', json.dumps(self.events()))
        for row in self.events():
            self.assertEqual((row['event'], row['reason'], row['lease_state']), ('busy_refused', 'lease', 'foreign'))
            self.assertEqual(set(row['caller_chain'][0]), {'pid', 'comm', 'cwd_tail'})
        self.assertFalse((ph.STATE/'drops').exists())

    def test_owner_refresh_and_same_owner_reacquire(self):
        self.claim()
        os.environ['PH_LEASE_OWNER'] = 'holder'
        initial = json.loads(lock.LEASE.read_text())
        future = lock.now()+dt.timedelta(minutes=15)
        with patch.object(lock, 'now', return_value=future):
            self.assertEqual(self.cli('key', 'home')[0], 0)
        refreshed = json.loads(lock.LEASE.read_text())
        self.assertGreater(refreshed['expires_at'], initial['expires_at'])
        self.device.press.assert_called_once_with('home')
        self.claim()
        self.assertEqual(lock.status()['lease_state'], 'own')

    def test_claim_between_start_and_rpc_is_refused(self):
        def connect():
            self.claim()
            return self.device
        ph.d.side_effect = connect
        self.assertEqual(self.cli('tap', '10', '10')[0], 5)
        self.device.click.assert_not_called()
        self.assertEqual([r['event'] for r in self.events()], ['busy_refused'])

    def test_hold_between_start_and_rpc_is_refused(self):
        def connect():
            lock.HOLD.write_text(HOLD_TOKEN)
            return self.device
        ph.d.side_effect = connect
        self.assertEqual(self.cli('open', 'dev.example')[0], 5)
        self.device.app_start.assert_not_called()

    def test_doctor_cannot_restart_adb_under_foreign_lease(self):
        self.claim()
        probes = []
        def adb(args, **kwargs):
            probes.append(args)
            return f'List of devices attached\n{ph.SERIAL} offline\n'
        with patch.object(ph, '_run', side_effect=adb):
            self.assertEqual(self.cli('doctor')[0], 5)
        self.assertEqual(probes, [['adb', 'devices', '-l']])
        self.assertEqual(self.events()[-1]['reason'], 'lease')

    def test_adb_restart_class_is_guarded_at_subprocess_boundary(self):
        self.claim()
        for verb in ('kill-server', 'start-server'):
            with self.subTest(verb=verb):
                with self.assertRaises(ph.PhoneBusy): PhoneLockTests.real_run(['adb', verb])
        ph.subprocess.run.assert_not_called()

    def test_reset_claim_handoff_is_refused_at_final_subprocess(self):
        real_check = lock.check
        for claim in ('lease', 'hold'):
            with self.subTest(claim=claim):
                checks = []
                def handoff(action):
                    checks.append(action)
                    if len(checks) == 2:
                        if claim == 'lease': self.claim()
                        else: lock.HOLD.write_text(HOLD_TOKEN)
                    return real_check(action)
                with patch.object(lock, 'check', side_effect=handoff), patch.object(ph, '_run', self.real_run):
                    ph.reset_u2()
                try:
                    ph.subprocess.run.assert_not_called()
                    self.assertEqual(checks, [True, True])
                finally:
                    ph.subprocess.run.reset_mock()
                    if claim == 'lease': lock.release('holder')
                    else: lock.HOLD.unlink()

    real_run = staticmethod(ph._run)

    def test_read_under_foreign_lease_succeeds_but_failure_never_resets(self):
        self.claim()
        self.assertEqual(self.cli('ui')[0], 0)
        self.device.dump_hierarchy.side_effect = RuntimeError('failed read')
        with patch.object(ph, 'reset_u2') as reset:
            code, out = self.cli('ui')
        self.assertEqual(code, 5)
        self.assertIn('not resetting u2 while', out)
        reset.assert_not_called(); ph._run.assert_not_called()

    def test_new_hold_during_read_failure_never_resets(self):
        def fail(**kwargs):
            lock.HOLD.write_text(HOLD_TOKEN)
            raise RuntimeError('failed read')
        self.device.dump_hierarchy.side_effect = fail
        with patch.object(ph, 'reset_u2') as reset:
            self.assertEqual(self.cli('ui')[0], 5)
        reset.assert_not_called(); ph._run.assert_not_called()

    def test_reset_guard_and_action_failure_keep_maybe_sent(self):
        self.claim()
        ph.reset_u2()
        ph._run.assert_not_called()
        os.environ['PH_LEASE_OWNER'] = 'holder'
        def fail(*args):
            lock.HOLD.write_text(HOLD_TOKEN)
            raise RuntimeError('lost reply')
        self.device.press.side_effect = fail
        self.assertEqual(self.cli('key', 'home')[0], 4)
        ph._run.assert_not_called()

    def test_unleased_action_and_log_counts(self):
        self.assertEqual(self.cli('key', 'home')[0], 0)
        self.assertEqual([r['event'] for r in self.events()], ['action', 'unleased_action'])
        lock.HOLD.write_text(HOLD_TOKEN)
        self.cli('ui')
        code, out = self.cli('log')
        self.assertEqual(code, 0)
        self.assertIn('by lease_state: none=3', out)
        self.assertIn('busy_refused by reason: hold=1', out)

    def test_owner_and_ttl_input_class(self):
        for owner in ['', 'a'*81, 'has space', 'a/b', 'a\n', '#21']:
            with self.subTest(owner=owner), self.assertRaises(ValueError): self.claim(owner)
        for ttl in ['0', '-1', '0.001s', '0.5s', '121m', 'nan', 'inf', '20x']:
            with self.subTest(ttl=ttl), self.assertRaises(ValueError): self.claim(ttl=ttl)
        self.claim('a._:-Z9', '120m')

    def test_purpose_redaction(self):
        lock.acquire('holder', 'CVV 123; card 4111111111111111')
        purpose = json.loads(lock.LEASE.read_text())['purpose']
        self.assertNotIn('123', purpose); self.assertNotIn('4111111111111111', purpose)
        self.assertLessEqual(len(purpose), 80)

    def test_caller_chain_comm_only_and_bounded(self):
        with patch.object(ph, 'process_comm', side_effect=['zsh', 'parent']), patch.object(ph.subprocess, 'run') as run:
            run.side_effect = [subprocess.CompletedProcess([], 0, '42 /bin/zsh\n'),
                               subprocess.CompletedProcess([], 0, '0 /usr/bin/parent\n'),
                               subprocess.CompletedProcess([], 0, 'p42\nn/Users/a/projects/fixture\n')]
            rows = PhoneLockTests.real_chain()
        self.assertEqual([r['comm'] for r in rows], ['zsh', 'parent'])
        self.assertIsNone(rows[-1]['cwd_tail'])
        self.assertEqual(rows[0]['cwd_tail'], 'projects/fixture')
        for call in run.call_args_list:
            self.assertEqual(call.kwargs['timeout'], 1)
            self.assertNotIn('args=', call.args[0])

    def test_kernel_name_ignores_rewritten_argv_zero(self):
        self.assertNotIn('private argument', ph.process_comm(os.getpid()))
        if sys.platform != 'darwin':
            with patch.object(os, 'readlink', return_value='/usr/bin/python3'):
                self.assertEqual(ph.process_comm(1), 'python3')
        with patch.object(os, 'readlink', side_effect=OSError):
            if sys.platform != 'darwin': self.assertEqual(ph.process_comm(1), 'unknown')

    def test_lease_loss_during_final_join_cannot_return_success(self):
        started, finish = threading.Event(), threading.Event()
        original_join = threading.Thread.join
        def refresh(*args, **kwargs):
            started.set()
            self.assertTrue(finish.wait(5))
            lock.release('runner')
            lock.acquire('successor', 'qa')
            raise lock.Busy('lease changed; yield')
        def join(worker, *args, **kwargs):
            finish.set()
            return original_join(worker, *args, **kwargs)
        child = Mock(pid=999999)
        def wait(**kwargs):
            self.assertTrue(started.wait(5))
            return 0
        child.wait.side_effect = wait
        child.poll.return_value = 0
        out = io.StringIO()
        with patch.object(ph.subprocess, 'Popen', return_value=child), patch.object(lock, 'refresh', side_effect=refresh), patch.object(threading.Thread, 'join', join), patch.object(ph.os, 'killpg'), patch.object(ph, 'finish_group'), contextlib.redirect_stdout(out):
            self.assertEqual(ph.lease_run('runner', 'qa', 1, ['dummy']), 5)
        self.assertIn('PHONE_BUSY:', out.getvalue())
        self.assertEqual(lock.status()['lease_owner'], 'successor')

    def test_jevrun_private_labels_are_masked_before_truncating(self):
        source = Path(__file__).with_name('jevrun.py').read_text()
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name=='public_text')
        secret = 'PRIVATE-CANARY-'*10
        scope = dict(_typed_values={secret})
        exec(compile(ast.Module(body=[node], type_ignores=[]), '<public>', 'exec'), scope)
        label = 'input field (current value: '+secret+')'
        self.assertNotIn('PRI', scope['public_text'](label)[:30])

    def test_jevrun_serialized_input_class_is_suppressed(self):
        source = Path(__file__).with_name('jevrun.py').read_text()
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name=='public_text')
        inputs = ['PRIVATE_CANARY', "ONE\tPRIVATE_CANARY'", 'ONE\tPRIVATE_CANARY"',
                  'ONE\nPRIVATE_CANARY', 'ONE\r\nPRIVATE_CANARY', 'ONE'+chr(92)+'PRIVATE_CANARY',
                  "ONE'PRIVATE_CANARY\"", 'ONE\vPRIVATE_CANARY', 'ONE\fPRIVATE_CANARY']
        for value in inputs:
            scope = dict(_typed_values={value, *value.split()})
            exec(compile(ast.Module(body=[node], type_ignores=[]), '<private>', 'exec'), scope)
            forms = [value, repr([value]), json.dumps([value]), json.dumps(json.dumps([value])), repr(['"'+value+'"'])]
            for text in forms:
                with self.subTest(value=value, text=text):
                    self.assertNotIn('PRIVATE_CANARY', scope['public_text'](text))

    def test_jevrun_device_call_class_refuses_new_claims(self):
        source = Path(__file__).with_name('jevrun.py').read_text()
        functions = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name in ('priority_check', 'phone_call')]
        scope = dict(phonelock=lock, sys=sys)
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<calls>', 'exec'), scope)
        self.claim()
        for method in ('click', 'press', 'clear_text', 'send_keys', 'swipe', 'swipe_ext', 'app_start', 'app_stop', 'screenshot', 'dump_hierarchy', 'connect', 'adb_reset'):
            with self.subTest(method=method):
                rpc = Mock()
                with self.assertRaises(SystemExit) as exc: scope['phone_call'](rpc, 'private-input')
                self.assertEqual(exc.exception.code, 5)
                rpc.assert_not_called()

    def test_jevrun_priority_and_import_from_other_cwd(self):
        source = Path(__file__).with_name('jevrun.py').read_text()
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'priority_check')
        scope = dict(phonelock=lock, sys=sys)
        exec(compile(ast.Module(body=[node], type_ignores=[]), '<guard>', 'exec'), scope)
        self.claim()
        with self.assertRaises(SystemExit) as exc: scope['priority_check']()
        self.assertEqual(exc.exception.code, 5)

    real_chain = staticmethod(ph.caller_chain)


class LeaseRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = {**os.environ, 'PH_LOCK_DIR': str(self.root), 'PH_TMP': str(self.root/'shots'),
                    'PHONE_HOLD_OWNER': '', 'PH_LEASE_OWNER': ''}
        # Exercise the CLI entry with isolated telemetry as well as isolated claims.
        wrapper=self.root/'ph_cli.py'
        scripts=str(Path(__file__).resolve().parent)
        wrapper.write_text(f"import sys\nfrom pathlib import Path\nsys.path.insert(0,{scripts!r})\nimport ph\nph.STATE=Path({str(self.root/'events')!r})\nsys.exit(ph.run(sys.argv[1:]))\n")
        self.script = str(wrapper)

    def command(self, code):
        return [sys.executable, '-I', self.script, 'lease', 'run', '--owner', 'runner', '--purpose', 'qa',
                '--ttl', '2s', '--', sys.executable, '-I', '-c', code]

    def test_real_cli_with_lock_dir_pointing_to_file(self):
        script=str(Path(__file__).with_name('ph.py'))
        blocked=self.root/'not-a-directory'
        blocked.touch()
        env={**self.env,'PH_LOCK_DIR':str(blocked),'HOME':str(self.root)}
        for args,expected in [(['help'],0),(['log'],0),(['open','dev.fixture'],5),(['hold','status','--json'],0)]:
            with self.subTest(args=args):
                result=subprocess.run([sys.executable,'-I',script,*args],env=env,cwd=self.root,
                                      capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,expected,result.stdout+result.stderr)
                self.assertNotIn('Traceback',result.stderr)

    def test_real_cli_archive_and_refusal_keep_context(self):
        script=str(Path(__file__).with_name('ph.py'))
        env={**self.env,'HOME':str(self.root)}
        hold=self.root/'priority-hold'
        hold.write_text(HOLD_TOKEN)
        stamp=time.time()-31*60
        os.utime(hold,(stamp,stamp))
        result=subprocess.run([sys.executable,'-I',script,'hold','status','--json'],env=env,cwd=self.root,
                              capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['archived'],'not_refreshed')
        hold.write_text(HOLD_TOKEN)
        result=subprocess.run([sys.executable,'-I',script,'hold','release'],env=env,cwd=self.root,
                              capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,5,result.stdout+result.stderr)
        rows=[json.loads(line) for line in (self.root/'.local/state/ph/events.jsonl').read_text().splitlines()]
        self.assertEqual(rows[0]['cmd'],'hold')
        self.assertEqual((rows[-1]['event'],rows[-1]['reason']),('busy_refused','hold'))
        self.assertNotIn(HOLD_TOKEN,json.dumps(rows)+result.stdout+result.stderr)

    def test_process_start_identity_is_independent_of_timezone_and_locale(self):
        expected=lock.process_started(os.getpid())
        bootstrap=('import sys; sys.path.insert(0,'+repr(str(Path(__file__).resolve().parent))+'); '
                   'import phonelock; print(phonelock.process_started(int(sys.argv[1])))')
        for tz,locale in [('UTC0','C'),('Asia/Dubai','C'),('America/New_York','en_US.UTF-8'),('Asia/Tokyo','de_DE.UTF-8')]:
            with self.subTest(tz=tz,locale=locale):
                result=subprocess.run([sys.executable,'-I','-c',bootstrap,str(os.getpid())],
                                      env={**self.env,'TZ':tz,'LC_ALL':locale},capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(result.stdout.rstrip('\n'),expected)

    def test_real_pid_liveness_and_stale_status_subprocess(self):
        hold = self.root/'priority-hold'
        sidecar = self.root/'priority-hold.owner.json'
        started = lock.process_started(os.getpid())
        bootstrap = ('import sys; sys.path.insert(0,'+repr(str(Path(__file__).resolve().parent))+'); '
                     'from unittest.mock import Mock; from pathlib import Path; import ph; ph.STATE=Path('+repr(str(self.root/'events'))+'); ph.d=Mock(return_value=Mock()); '
                     'sys.exit(ph.run(["open","dev.fixture"]))')
        for pid, start, age, code, reason in ((os.getpid(),started,29*60,5,None),
                                             (os.getpid(),started,31*60,0,'not_refreshed'),
                                             (os.getpid(),'reused',0,0,'holder_exited'),
                                             (99999999,started,0,0,'holder_exited')):
            with self.subTest(pid=pid, age=age, start_matches=start==started):
                hold.write_text(HOLD_TOKEN)
                stamp=time.time()-age
                os.utime(hold,(stamp,stamp))
                sidecar.write_text(json.dumps(dict(token_sha=lock.token_sha(HOLD_TOKEN),agent_pid=pid,
                                                  agent_started=start,agent_comm='codex',hold_dev=hold.stat().st_dev,hold_ino=hold.stat().st_ino)))
                result=subprocess.run([sys.executable,'-I','-c',bootstrap],env=self.env,cwd=self.root,
                                      capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,code,result.stdout+result.stderr)
                self.assertNotIn(HOLD_TOKEN,result.stdout+result.stderr)
                if reason:
                    self.assertFalse(hold.exists())
                    rows=[json.loads(x) for x in (self.root/'events'/'events.jsonl').read_text().splitlines()]
                    self.assertEqual([r for r in rows if r['event']=='hold_archived'][-1]['reason'],reason)
                    self.assertNotIn(HOLD_TOKEN,json.dumps(rows))

    def test_child_environment_and_normal_nonzero_release(self):
        for code in [0, 7]:
            result = subprocess.run(self.command(f'import os,sys; print(os.environ["PH_LEASE_OWNER"]); sys.exit({code})'),
                                    env=self.env, cwd=self.root, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, code, result.stdout+result.stderr)
            self.assertEqual(result.stdout.strip(), 'runner')
            self.assertFalse((self.root/'lease.json').exists())

    def test_sigterm_forward_release_and_code(self):
        ready = self.root/'ready'
        result = self.root/'signal'
        code = ('import pathlib,signal,time,sys; '
                f'signal.signal(signal.SIGTERM, lambda *a: (pathlib.Path({str(result)!r}).touch(),sys.exit(9))); '
                f'pathlib.Path({str(ready)!r}).touch(); time.sleep(30)')
        child = subprocess.Popen(self.command(code), env=self.env, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic()+10
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(ready.exists())
            child.send_signal(signal.SIGTERM)
            out, err = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 9, (out, err))
            self.assertTrue(result.exists())
            self.assertFalse((self.root/'lease.json').exists())
        finally:
            if child.poll() is None:
                child.kill(); child.wait()

    def test_lost_claim_returns_busy_even_if_child_handles_term_cleanly(self):
        ready = self.root/'ready'
        code = ('import pathlib,signal,time,sys; signal.signal(signal.SIGTERM,lambda *a:sys.exit(0)); '
                f'pathlib.Path({str(ready)!r}).touch(); time.sleep(30)')
        child = subprocess.Popen(self.command(code), env=self.env, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic()+10
            while not ready.exists() and time.monotonic()<deadline: time.sleep(.01)
            self.assertTrue(ready.exists())
            (self.root/'priority-hold').write_text(HOLD_TOKEN)
            out, err = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 5, (out, err))
            self.assertIn(b'PHONE_BUSY:', out)
            self.assertNotIn(HOLD_TOKEN.encode(), out)
            self.assertFalse((self.root/'lease.json').exists())
        finally:
            if child.poll() is None: child.kill(); child.wait()

    def test_sigint_releases_with_ignoring_child(self):
        ready = self.root/'ready'
        code = ('import pathlib,signal,time; signal.signal(signal.SIGINT, signal.SIG_IGN); '
                f'pathlib.Path({str(ready)!r}).touch(); time.sleep(30)')
        child = subprocess.Popen(self.command(code), env=self.env, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic()+10
            while not ready.exists() and time.monotonic() < deadline: time.sleep(.01)
            self.assertTrue(ready.exists())
            child.send_signal(signal.SIGINT)
            out, err = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 137, (out, err))
            self.assertFalse((self.root/'lease.json').exists())
        finally:
            if child.poll() is None: child.kill(); child.wait()

    def test_duplicate_runner_cannot_release_another_runner(self):
        ready = self.root/'ready'
        code = f'import pathlib,time; pathlib.Path({str(ready)!r}).touch(); time.sleep(30)'
        child = subprocess.Popen(self.command(code), env=self.env, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic()+10
            while not ready.exists() and time.monotonic()<deadline: time.sleep(.01)
            self.assertTrue(ready.exists())
            duplicate = subprocess.run(self.command('pass'), env=self.env, cwd=self.root, capture_output=True, timeout=10)
            self.assertEqual(duplicate.returncode, 5, duplicate.stderr)
            self.assertTrue((self.root/'lease.json').exists())
            child.send_signal(signal.SIGTERM)
            child.communicate(timeout=10)
            self.assertFalse((self.root/'lease.json').exists())
        finally:
            if child.poll() is None: child.kill(); child.wait()

    def test_group_descendants_stop_before_claim_release(self):
        descendant_code = """
import os, pathlib, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))
while True:
    if not pathlib.Path(sys.argv[2]).exists(): pathlib.Path(sys.argv[3]).touch()
    time.sleep(.002)
"""
        for trigger, expected in [('normal', 0), ('nonzero', 7), ('term', 143), ('int', 130), ('claim_loss', 5)]:
            with self.subTest(trigger=trigger):
                marker = self.root/'descendant'
                violation = self.root/'ran-after-release'
                marker.unlink(missing_ok=True); violation.unlink(missing_ok=True)
                code = ('import os,pathlib,subprocess,sys,time; '
                        f'p=subprocess.Popen([sys.executable,"-I","-c",{descendant_code!r},{str(marker)!r},{str(self.root/"lease.json")!r},{str(violation)!r}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); '
                        f'[(time.sleep(.01)) for _ in iter(lambda:pathlib.Path({str(marker)!r}).exists(),True)]; '
                        + ('sys.exit(7)' if trigger=='nonzero' else 'sys.exit(0)' if trigger=='normal' else 'time.sleep(30)'))
                args = self.command(code)
                # Keep the TTL longer than the cancellation grace period.
                args[args.index('--ttl')+1] = '12s'
                child = subprocess.Popen(args, env=self.env, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                descendant = None
                try:
                    deadline=time.monotonic()+10
                    while not marker.exists() and time.monotonic()<deadline: time.sleep(.01)
                    self.assertTrue(marker.exists())
                    descendant=int(marker.read_text())
                    if trigger in ('term','int'): child.send_signal(signal.SIGTERM if trigger=='term' else signal.SIGINT)
                    elif trigger=='claim_loss': (self.root/'priority-hold').write_text(HOLD_TOKEN)
                    out,err=child.communicate(timeout=15)
                    self.assertEqual(child.returncode,expected,(out,err))
                    self.assertFalse((self.root/'lease.json').exists())
                    status=subprocess.run(['ps','-o','stat=','-p',str(descendant)],capture_output=True,text=True,timeout=1).stdout.strip()
                    self.assertTrue(not status or status.startswith('Z'),status)
                    self.assertFalse(violation.exists(),'descendant did work after lease release')
                finally:
                    if child.poll() is None: child.kill(); child.wait()
                    if descendant is not None:
                        try: os.kill(descendant,signal.SIGKILL)
                        except ProcessLookupError: pass
                    (self.root/'priority-hold').unlink(missing_ok=True)

    def test_rewritten_argv_zero_is_not_logged_as_a_process_name(self):
        code = (f'import sys,os; sys.path.insert(0,{str(Path(__file__).resolve().parent)!r}); '
                'import ph; print(ph.process_comm(os.getpid()))')
        result = subprocess.run(['/bin/bash', '-c', 'exec -a "PRIVATE_ARGV_CANARY private input" "$@"',
                                 'fixture', sys.executable, '-I', '-c', code], env=self.env,
                                cwd=self.root, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('PRIVATE_ARGV_CANARY', result.stdout)
        self.assertNotIn('private input', result.stdout)
        self.assertNotIn('unknown', result.stdout)

    def fake_jevrun(self, secret, failure=None, operation="send_keys"):
        script = str(Path(__file__).with_name('jevrun.py'))
        bootstrap = """
import pathlib, runpy, sys, types, time, xml.etree.ElementTree as ET
from unittest.mock import patch
try:
    from uiautomator2.exceptions import RPCUnknownError
except ImportError:
    class RPCUnknownError(Exception): pass
original_read = pathlib.Path.read_text
patch.object(pathlib.Path, 'read_text', lambda p,*a,**kw: 'dummy' if p.name=='openrouter-key' else original_read(p,*a,**kw)).start()
clock=[0.0]
time.time=lambda:clock[0]
time.sleep=lambda seconds:clock.__setitem__(0,clock[0]+seconds)
class Device:
    value=''
    def dump_hierarchy(self, **kwargs):
        root=ET.Element('hierarchy')
        ET.SubElement(root,'node',text=self.value,package='dev.fixture',bounds='[0,0][20,20]',focused='true', **{'class':'android.widget.EditText'})
        return ET.tostring(root,encoding='unicode')
    def clear_text(self): self.value=''
    def send_keys(self,text,**kwargs): self.value=text
sys.modules['requests']=types.SimpleNamespace(Session=lambda:types.SimpleNamespace(headers={}))
sys.modules['uiautomator2']=types.SimpleNamespace(connect=lambda *a:Device())
runpy.run_path(sys.argv[1],run_name='__main__')
"""
        if failure:
            if operation == 'send_keys':
                bootstrap = bootstrap.replace("    def send_keys(self,text,**kwargs): self.value=text", failure)
            elif operation == 'clear_text':
                bootstrap = bootstrap.replace("    def clear_text(self): self.value=''", failure.replace('send_keys(self,text,**kwargs)', 'clear_text(self)').replace('        import threading', f'        text={secret!r}\n        import threading'))
            else:
                bootstrap = bootstrap.replace("    def dump_hierarchy(self, **kwargs):", failure.replace('send_keys(self,text,**kwargs)', 'dump_hierarchy(self,**kwargs)').replace('        import threading', f'        text={secret!r}\n        import threading')+'\n    def unused_hierarchy(self, **kwargs):')
        plan = self.root/'plan.json'
        plan.write_text(json.dumps(dict(app='dev.fixture', steps=[{'type':secret},{'print':'.'},{'verify':['\"'+secret+'\"']} ])))
        code = bootstrap.replace("runpy.run_path(sys.argv[1],run_name='__main__')", "sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0],run_name='__main__')")
        # exec preserves the actual runner's excepthook, unlike runpy's traceback printer.
        code = code.replace("runpy.run_path(sys.argv[0],run_name='__main__')", "exec(compile(pathlib.Path(sys.argv[0]).read_text(),sys.argv[0],'exec'),dict(__name__='__main__',__file__=sys.argv[0]))")
        return subprocess.run([sys.executable,'-I','-c',code,script,str(plan)], env=self.env,cwd=self.root,capture_output=True,text=True,timeout=15)

    def test_jevrun_typing_and_followup_summary_do_not_echo_private_input(self):
        for secret in ["ONE\tPRIVATE_CANARY'", 'PRIVATE-PLAIN-CANARY', 'PRIVATE\'QUOTE\"TAIL', 'PRIVATE-LINE-ONE\nPRIVATE-LINE-TWO', 'سري-اختبار']:
            with self.subTest(secret=secret):
                result=self.fake_jevrun(secret)
                self.assertEqual(result.returncode,4,result.stderr)
                self.assertIn('readback=ok',result.stdout)
                for fragment in secret.replace('\"','\n').replace("'",'\n').splitlines():
                    self.assertNotIn(fragment,result.stdout+result.stderr)

    def test_jevrun_rpc_errors_and_stderr_do_not_echo_private_input(self):
        failure = """    def send_keys(self,text,**kwargs):
        import threading
        sys.stderr.write(text[:3]); sys.stderr.flush(); sys.stderr.write(text[3:]+chr(10)); sys.stderr.buffer.write(text.encode()); sys.stderr.buffer.flush()
        def thread_error(): raise RPCUnknownError('thread error',[text],'stack')
        worker=threading.Thread(target=thread_error);worker.start();worker.join()
        try: raise ValueError(text)
        except ValueError as exc: raise RPCUnknownError('device error',[text],'stack') from exc
"""
        cases=[(operation,secret) for operation in ('send_keys','clear_text','dump_hierarchy')
               for secret in ['PRIVATE_CANARY', "ONE\tPRIVATE_CANARY'", 'PRIVATE_CANARY\nSECOND_CANARY', 'سري-اختبار']]
        for operation,secret in cases:
            with self.subTest(operation=operation,secret=secret):
                result=self.fake_jevrun(secret,failure,operation)
                self.assertNotEqual(result.returncode,0)
                self.assertNotIn('PRIVATE_CANARY', result.stdout+result.stderr)
                self.assertNotIn('SECOND_CANARY', result.stdout+result.stderr)
                self.assertNotIn(secret, result.stdout+result.stderr)
                self.assertIn('RPCUnknownError',result.stderr)

    def test_jevrun_subprocess_from_other_cwd(self):
        (self.root/'priority-hold').write_text(HOLD_TOKEN)
        script = str(Path(__file__).with_name('jevrun.py'))
        bootstrap = ('import pathlib,runpy,sys,types; from unittest.mock import patch; '
                     'sys.modules["requests"]=types.SimpleNamespace(); '
                     'sys.modules["uiautomator2"]=types.SimpleNamespace(connect=lambda *a: (_ for _ in ()).throw(AssertionError("device touched"))); '
                     f'sys.argv=[{script!r},"missing-plan"]; '
                     f'patch(pathlib.Path.__module__+".Path.read_text", lambda self: {HOLD_TOKEN!r} if self.name=="priority-hold" else "dummy").start(); '
                     f'runpy.run_path({script!r},run_name="__main__")')
        result = subprocess.run([sys.executable, '-I', '-c', bootstrap], env=self.env, cwd=self.root,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 5, result.stderr)
        self.assertNotIn(HOLD_TOKEN, result.stdout)

    def test_run_refreshes_and_spawn_failure_releases(self):
        code = ('import time,json,os,datetime,pathlib; time.sleep(2.5); '
                'lease=json.loads((pathlib.Path(os.environ["PH_LOCK_DIR"])/"lease.json").read_text()); '
                'assert datetime.datetime.fromisoformat(lease["expires_at"]) > datetime.datetime.now(datetime.timezone.utc)')
        result = subprocess.run(self.command(code), env=self.env, cwd=self.root, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root/'lease.json').exists())
        args = self.command('')[:-4] + ['--', '/no-such-fixture-command']
        result = subprocess.run(args, env=self.env, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.root/'lease.json').exists())


if __name__ == '__main__': unittest.main()
