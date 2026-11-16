"""Read-only success cannot clear a home disk-full write failure."""
import contextlib
import json
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from offbox_lib import api,common,disk_pressure,home,runs
import home_monitor as monitor

class ClientDisk(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(common,'SERVER_CFG',Path(self.tmp.name)/'server.json'))
        self.stack.enter_context(patch.object(api,'BACKEND','server'))

    def test_sqlite_full_shapes_and_other_backend_errors(self):
        for message in ['database or disk is full','disk I/O error','ENOSPC','No space left on device']:
            with self.subTest(message=message):
                error=api.ApiError(500,'internal',message)
                self.assertEqual(str(error),'home server out of disk');self.assertTrue(error.outage)
                self.assertEqual(error.code,90);self.assertTrue(disk_pressure.pending())
        with patch.object(api,'BACKEND','boat'):
            self.assertIn('API 500',str(api.ApiError(500,'internal','disk I/O error')))
        self.assertNotIn('out of disk',str(api.ApiError(500,'internal','different error')))

    def test_typed_refusal_wording(self):
        data={'error':{'details':{'disk':{'filesystems':[{'filesystem':'offbox','free_bytes':1024**3,'level':'full'}]}}}}
        for value in (data, data['error']['details']):
            with self.subTest(envelope=value):
                error=api.ApiError(503,'server_disk_low','ignored',data=value)
                self.assertEqual(str(error),'home offbox server is low on disk (1.0 GiB on offbox)')
                self.assertTrue(error.outage)

    def test_successful_read_does_not_clear_failure_but_sampled_recovery_does(self):
        api.ApiError(500,'internal','database or disk is full')
        self.assertIn('out of disk',disk_pressure.health_reason({'ok':True}))
        with patch.object(home,'probe',return_value='home server out of disk'),patch.object(api,'call') as call:
            self.assertIn('out of disk',api.probe());call.assert_not_called()
        self.assertIsNone(disk_pressure.health_reason({'ok':True,'disk':{'level':'ok','sampled_at':time.time()+1,'write_ok':True,'written_at':time.time()+1}}))
        self.assertFalse(disk_pressure.pending())

    def test_fresh_measurement_without_successful_write_cannot_clear_failure(self):
        api.ApiError(500,'internal','database or disk is full')
        self.assertIn('out of disk',disk_pressure.health_reason({'ok':True,'disk':{'level':'ok','sampled_at':time.time()+1}}))
        self.assertTrue(disk_pressure.pending())

    def test_cached_healthy_measurement_before_write_failure_cannot_clear_it(self):
        old_sample=time.time()-1
        api.ApiError(500,'internal','database or disk is full')
        self.assertIn('out of disk',disk_pressure.health_reason({'ok':True,'disk':{'level':'ok','sampled_at':old_sample}}))
        self.assertTrue(disk_pressure.pending())

    def test_full_health_cannot_be_overridden_by_authenticated_read(self):
        disk_pressure.remember(True)
        with patch.object(home,'probe',return_value='home server out of disk'),patch.object(home,'recent_failure',return_value=True),patch.object(api,'probe_backend') as read:
            self.assertIn('out of disk',home.preflight_reason());read.assert_not_called()

    def test_full_health_even_with_ok_true_is_refused(self):
        self.assertIn('out of disk',disk_pressure.health_reason({'ok':True,'disk_full':True}))

    def test_startup_probe_keeps_waiting_unless_disk_pressure_refuses_it(self):
        for level, expected in [('ok',None),('full','out of disk'),('unknown','measurement unavailable')]:
            data={'ok':False,'starting':True,'phase':'reconcile','disk':{'level':level}}
            response=SimpleNamespace(read=lambda:json.dumps(data).encode())
            with self.subTest(level=level),patch.object(home,'health_url',return_value='http://test'), \
                 patch.object(home.urllib.request,'urlopen',return_value=contextlib.nullcontext(response)), \
                 patch.object(home,'wait_while_starting',return_value=None) as wait:
                reason=home._probe()
                if expected:
                    self.assertIn(expected,reason)
                    wait.assert_not_called()
                else:
                    self.assertIsNone(reason)
                    self.assertEqual(wait.call_args.args[0],'reconcile')

    def test_sync_rsync23_and_upload_enospc_are_infra90(self):
        for no_sync in (False,True):
            with self.subTest(no_sync=no_sync),contextlib.ExitStack() as stack:
                runner=runs.Runner.__new__(runs.Runner);runner.box='bx_aaaaaaaa';runner.me={'repo_key':'repo'}
                runner.root=Path(self.tmp.name);runner.run_id='disk-sync';runner.check_source=lambda _:None
                stack.enter_context(patch.object(api,'left',return_value=None))
                stack.enter_context(patch.object(runs.ssh_sync,'put_file',side_effect=common.OffboxError('No space left on device') if no_sync else None))
                stack.enter_context(patch.object(runs,'_seed_candidates',return_value=[]))
                stack.enter_context(patch.object(runs.ssh_sync,'push',side_effect=common.OffboxError('rsync error code 23: ENOSPC')))
                stack.enter_context(patch.object(runs.prepare,'phase',side_effect=lambda *a:contextlib.nullcontext()))
                with self.assertRaises(common.OffboxError) as caught:
                    runner._sync_box(None,SimpleNamespace(no_sync=no_sync,git=False),'/repo','/env',b'')
                self.assertEqual(caught.exception.code,90);self.assertIn('home server out of disk',str(caught.exception));self.assertTrue(caught.exception.outage)

    def test_slow_health_retry_distinguishes_disk_refusal_from_transport_delay(self):
        for level, expected in [('ok', None), ('full', 'out of disk'), ('unknown', 'measurement unavailable')]:
            data = {'ok': level == 'ok', 'snapshot_age_s': 900, 'refresh_stage': 'incus',
                    'disk': {'level': level}}
            response = SimpleNamespace(read=lambda: json.dumps(data).encode())
            with self.subTest(level=level), patch.object(home, 'health_url', return_value='http://test'), \
                    patch.object(home.urllib.request, 'urlopen', side_effect=[
                        TimeoutError('health timed out'), contextlib.nullcontext(response)]), \
                    patch.object(home, 'tcp_connects', return_value=True), \
                    patch.object(home, 'wait_while_starting') as wait:
                reason = home._probe()
                if expected is None:
                    self.assertIsNone(reason)
                else:
                    self.assertIn(expected, reason)
                wait.assert_not_called()

    def test_transport_timeouts_wait_without_becoming_disk_full(self):
        with patch.object(home, 'health_url', return_value='http://test'), \
                patch.object(home.urllib.request, 'urlopen', side_effect=TimeoutError('health timed out')), \
                patch.object(home, 'tcp_connects', return_value=True), \
                patch.object(home, 'wait_while_starting', return_value=None) as wait:
            self.assertIsNone(home._probe())
        self.assertEqual(wait.call_args.args[0], 'slow')
        self.assertFalse(disk_pressure.pending())

    def test_box_read_recovery_rejects_explicit_disk_failure_during_startup(self):
        for level in ('full', 'unknown'):
            data = {'ok': False, 'starting': True, 'phase': 'reconcile', 'disk': {'level': level}}
            response = SimpleNamespace(read=lambda: json.dumps(data).encode())
            with self.subTest(level=level), patch.object(home, 'health_url', return_value='http://test'), \
                    patch.object(home.urllib.request, 'urlopen', return_value=contextlib.nullcontext(response)), \
                    patch.object(home, 'tcp_connects', return_value=True), \
                    patch('home_monitor.tailnet_facts', return_value={'peer_online': True}), \
                    patch.object(common, 'home_state', return_value={}):
                self.assertFalse(home.slow_read_reachable())

class MonitorDisk(unittest.TestCase):
    def response(self,data):
        value=Mock();value.status=200;value.read.return_value=json.dumps(data).encode()
        ctx=Mock();ctx.__enter__=Mock(return_value=value);ctx.__exit__=Mock(return_value=False)
        opener=Mock();opener.open.return_value=ctx;return opener

    def test_low_class_warns_full_refuses_even_if_ok_true(self):
        for full,expected,ok in [(False,'disk_low',True),(True,'disk_full',False)]:
            data={'ok':True,'disk_low':True,'disk_full':full,'disk':{'level':'full' if full else 'low','disk_low':True,'disk_full':full}}
            with self.subTest(full=full),patch.object(monitor.urllib.request,'build_opener',return_value=self.response(data)):
                result=monitor.check_health('http://test');self.assertEqual(result['error'],expected);self.assertEqual(result['ok'],ok)

    def test_full_disk_does_not_receive_startup_grace(self):
        for full in (False,True):
            data={'ok':False,'starting':True,'phase':'reconcile','disk_full':full,
                  'disk':{'level':'full' if full else 'ok','disk_full':full}}
            with self.subTest(full=full),patch.object(monitor.urllib.request,'build_opener',return_value=self.response(data)):
                result=monitor.check_health('http://test')
                self.assertTrue(result['health']['starting'])
                self.assertEqual(result['health']['phase'],'reconcile')
                self.assertEqual(result['health']['disk']['disk_full'],full)
                state=monitor.fresh_state(100)
                for now in (100,160,220):
                    monitor.step(state,{'check':result,'mac':{'online':True}},now)
                self.assertEqual(state['state'],'home_down' if full else 'home_starting')

    def test_alert_once_stable_retry_key_and_status_disk_fields(self):
        state=monitor.fresh_state(100);state['disk']={'level':'low','disk_low':True,'filesystems':[{'filesystem':'offbox','free_bytes':1024**3,'free_pct':1,'level':'low'}]}
        effects=Mock();effects.telegram.side_effect=[False,True]
        first=monitor.reconcile(state,'http://test',effects,100,'good')
        second=monitor.reconcile(state,'http://test',effects,160,'good')
        monitor.reconcile(state,'http://test',effects,220,'good')
        self.assertEqual(effects.telegram.call_count,2);self.assertEqual(effects.telegram.call_args_list[0],effects.telegram.call_args_list[1])
        self.assertEqual(first[0]['action'],'telegram-disk-low');self.assertEqual(second[0]['key'],'offbox-home-disk:100')
        effects.create_thread.assert_not_called();self.assertEqual(monitor.backend_view(state)['disk'],state['disk'])

    def test_tick_full_disk_bypasses_startup_and_slow_retry_grace(self):
        from tests.test_home_monitor import Sim, ONLINE
        for after_timeout, boot in ((retry, boot) for retry in (False, True)
                                    for boot in (None, 'boot-a', 'boot-b')):
            sim = Sim(self)
            sim.tick()
            data = {'ok': False, 'starting': True, 'phase': 'reconcile', 'boot_id': boot,
                    'disk': {'level': 'full', 'disk_full': True}}
            with self.subTest(after_timeout=after_timeout, boot=boot), \
                    patch.object(monitor.urllib.request, 'build_opener', return_value=self.response(data)):
                full = monitor.check_health('http://test')
                for _ in range(monitor.DOWN_AFTER):
                    sim.now += 60
                    monitor.tick(sim.dir, clock=lambda: sim.now, effects=sim.fx,
                                 check=lambda u: {'ok': False, 'error': 'timeout', 'health': {}} if after_timeout else full,
                                 retry=lambda u: full, mac=lambda u: dict(ONLINE, peer_online=True), tcp=lambda u: True)
                    self.assertNotIn(sim.backend()['state'], ('home_starting', 'home_slow'))
                self.assertEqual(sim.backend()['state'], 'home_down')
                self.assertEqual(sim.backend()['class'], 'hard')
                self.assertIn('error=disk_full', sim.log())

    def test_stale_startup_snapshot_gets_grace_without_false_disk_full(self):
        from tests.test_home_monitor import Sim
        sim = Sim(self)
        sim.tick()
        for _ in range(3):
            result = sim.tick(ok=False, error='not_ok', health={
                'starting': True, 'phase': 'reconcile', 'snapshot_age_s': 900,
                'refresh_stage': 'incus', 'disk': {'level': 'ok', 'disk_full': False}})
            self.assertEqual(result['state'], 'home_starting')
        self.assertEqual(sim.fx.calls, [])
        self.assertFalse(sim.backend()['disk']['disk_full'])

    def test_disk_warning_still_alerts_once_during_startup(self):
        from tests.test_home_monitor import Sim
        sim = Sim(self)
        sim.tick()
        for _ in range(2):
            result = sim.tick(ok=False, error='not_ok', health={
                'starting': True, 'phase': 'reconcile',
                'disk': {'level': 'low', 'disk_low': True}})
            self.assertEqual(result['state'], 'home_starting')
        self.assertEqual(len(sim.fx.telegrams), 1)
