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

    def test_alert_once_stable_retry_key_and_status_disk_fields(self):
        state=monitor.fresh_state(100);state['disk']={'level':'low','disk_low':True,'filesystems':[{'filesystem':'offbox','free_bytes':1024**3,'free_pct':1,'level':'low'}]}
        effects=Mock();effects.telegram.side_effect=[False,True]
        first=monitor.reconcile(state,'http://test',effects,100,'good')
        second=monitor.reconcile(state,'http://test',effects,160,'good')
        monitor.reconcile(state,'http://test',effects,220,'good')
        self.assertEqual(effects.telegram.call_count,2);self.assertEqual(effects.telegram.call_args_list[0],effects.telegram.call_args_list[1])
        self.assertEqual(first[0]['action'],'telegram-disk-low');self.assertEqual(second[0]['key'],'offbox-home-disk:100')
        effects.create_thread.assert_not_called();self.assertEqual(monitor.backend_view(state)['disk'],state['disk'])
