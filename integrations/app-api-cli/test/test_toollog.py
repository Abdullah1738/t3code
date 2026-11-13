"""Fixture-only diagnostics tests; all log and financial state stays temporary."""
import contextlib
import datetime as dt
import io
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import toollog as log


class Logs(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name) / 'logs'
        p = patch.object(log, 'root', return_value=self.folder)
        p.start()
        self.addCleanup(p.stop)
        log._SEEN.clear()

    def rows(self):
        return [json.loads(line) for p in sorted(self.folder.glob('*.ndjson')) for line in p.read_text().splitlines()]

    def test_format_allowlist_permissions_and_banned_fixture_values(self):
        secret = {'pan': '4242424242424242', 'address': 'Apartment 987 Example Street', 'otp': '846291',
                  'phone': '+971501234567', 'cookie': 'private-cookie-value'}
        log.emit('commerce', 'cmd.start', ids={'flowId': secret['pan'], 'orderId': secret['otp'], **secret},
                 props={**secret, 'last4': '4242', 'prepareOnly': True, 'lane': 'minutes', 'subcommand':'order'},
                 error=secret['address'])
        row, = self.rows()
        self.assertEqual(row['tool'], 'orders')
        self.assertRegex(row['ts'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
        self.assertEqual(row['props'], {'last4':'4242','prepareOnly':True,'lane':'minutes','subcommand':'order'})
        for value in secret.values():
            self.assertNotIn(value, json.dumps(row))
        self.assertEqual(self.folder.stat().st_mode & 0o777, 0o700)
        self.assertEqual(next(self.folder.glob('*.ndjson')).stat().st_mode & 0o777, 0o600)

    def test_cap_is_once_across_process_memory_resets_and_errors_continue(self):
        with patch.object(log, 'CAP_BYTES', 1):
            log.emit('commerce','cmd.start')
            log.emit('commerce','cmd.end')
            log._SEEN.clear()
            log.emit('commerce','cmd.end',kind='perf')
            log.emit('commerce','cmd.error',kind='error',error='FAILED')
        self.assertEqual([r['name'] for r in self.rows()], ['cmd.start','log.cap','cmd.error'])

    def test_retention_and_rollup_statistics(self):
        self.folder.mkdir()
        today = dt.datetime.now(dt.timezone.utc).date()
        old = (today - dt.timedelta(days=31)).isoformat()
        for name in (old+'.ndjson','rollup-'+old+'.json','rollup-'+old+'.cap'):
            (self.folder/name).touch()
        (self.folder/'keep-me').touch()
        for i in range(1, 21):
            log.emit('commerce','step.auth',kind='perf',duration_ms=i,ok=i<20,
                     error='AUTH_EXPIRED' if i == 20 else None, ids={'flowId':'fixture-flow'})
        summary=log.rollup(today.isoformat())
        self.assertEqual(summary['durationsMs']['step.auth'], {'p50':10,'p95':19,'max':20})
        self.assertEqual(summary['okRate'], .95)
        self.assertFalse((self.folder/(old+'.ndjson')).exists())
        self.assertFalse((self.folder/('rollup-'+old+'.cap')).exists())
        self.assertTrue((self.folder/'keep-me').exists())
        self.assertIsNone(log.rollup('../bad'))
        self.assertEqual((self.folder/('rollup-'+today.isoformat()+'.json')).stat().st_mode & 0o777, 0o600)

    def test_all_write_failures_are_dropped_and_tool_result_survives(self):
        @log.timed('commerce','step.auth')
        def success():
            return {'ok':True}
        with patch.object(log.os,'open',side_effect=OSError('disk full')):
            self.assertEqual(success(), {'ok':True})
            log.emit('commerce','cmd.start')
            self.assertIsNone(log.rollup())
        with patch.object(log.Path,'mkdir',side_effect=PermissionError):
            log.emit('commerce','cmd.start')
            self.assertEqual(success(), {'ok':True})

    def test_financial_consume_never_writes_inside_operation(self):
        writes=[]
        locked=[False]
        @log.consumed
        def consume(flow_id, operation, **kwargs):
            self.assertTrue(locked[0])
            return True
        @log.timed('commerce','step.payment_submit')
        def operation():
            locked[0]=True
            try:
                consume('fixture-flow','payment',kind='payment',payable_minor=1234)
                self.assertEqual(writes,[])
            finally:
                locked[0]=False
            return {'ok':True}
        original=log._write
        def write(row):
            self.assertFalse(locked[0])
            writes.append(row)
            original(row)
        with patch.object(log,'_write',side_effect=write):
            operation()
        self.assertIn('payment.may_have_sent',[r['name'] for r in self.rows()])
        # A bare consume must never introduce a disk write at the boundary.
        with patch.object(log,'_write') as output:
            locked[0]=True
            consume('fixture-flow','payment',kind='payment')
            output.assert_not_called()

    def test_previous_day_rollup_after_utc_cutoff(self):
        class Clock(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026,11,13,0,4,tzinfo=dt.timezone.utc)
        with patch.object(log.dt,'datetime',Clock), patch.object(log,'rollup') as run:
            log.previous_day_rollup()
            run.assert_not_called()
        class After(Clock):
            @classmethod
            def now(cls,tz=None):
                return cls(2026,11,13,0,5,tzinfo=dt.timezone.utc)
        with patch.object(log.dt,'datetime',After), patch.object(log,'rollup',wraps=log.rollup) as run:
            log.previous_day_rollup()
            log.previous_day_rollup()
            run.assert_called_once_with('2026-11-12')

    def test_cli_success_refusals_and_fixture_rollup(self):
        import commerce_cli as cli
        with contextlib.redirect_stdout(io.StringIO()), patch.object(cli,'card_preflight',return_value=None):
            self.assertEqual(cli.main(['capabilities']),0)
            pause=self.folder.parent/'paused';pause.write_text('fixture')
            with patch.object(cli,'PAUSE_FILE',pause):
                self.assertEqual(cli.main(['order','minutes','--sku','FIXTURE','--quantity','1','--prepare-only']),4)
            self.assertEqual(cli.main(['order','talabat','--branch','1','--item','2']),5)
            self.assertEqual(cli.main(['log-rollup']),0)
        rows=self.rows()
        self.assertIn('cmd.start',[r['name'] for r in rows])
        self.assertIn('cmd.end',[r['name'] for r in rows])
        self.assertEqual({r['error']['tag'] for r in rows if r['name']=='guard.refused'}, {'ORDERING_PAUSED','TALABAT_RETIRED'})

    def test_card_assert_success_and_refused(self):
        import card_merchants as cm
        import card_status as cs
        with patch.dict(os.environ,{'CARD_STATUS_FILE':str(self.folder.parent/'cards.json')}):
            self.assertTrue(cm.assert_final('noon','9546')[0])
            self.assertFalse(cm.assert_final('noon','2342')[0])
            self.assertTrue(cm.assert_final('noon','2342',fallback=True)[0])
            with self.assertRaises(cs.CardStatusError):
                cm.assert_final('noon','4242424242424242')
        rows=self.rows()
        self.assertEqual([r['ok'] for r in rows],[True,False,True,False])
        self.assertTrue(rows[2]['props']['fallback'])
        self.assertNotIn('4242424242424242',json.dumps(rows))

    def test_poll_transition_delivery_eta_and_errors(self):
        import order_tracker as tracker
        now=time.time()
        cfg={'app':'noon','order':'N-FIXTURE','watcher':'fixture','registered_at':tracker.stamp(now-3600),
             'eta':tracker.stamp(now-600),'for':'owner'}
        folder=self.folder.parent/'watcher';folder.mkdir()
        tracker.write(folder/'order-tracker-state.json',{'primed':True,'status':'preparing'})
        with patch.dict(os.environ,{'WATCH_DIR':str(folder)}), patch.object(tracker,'fetch') as fetch, contextlib.redirect_stdout(io.StringIO()):
            fetch.return_value={'status':'unknown','errors':['secret body ignored']}
            tracker.check(cfg)
            fetch.return_value={'status':'delivered','errors':[]}
            tracker.check(cfg)
            fetch.side_effect=RuntimeError('secret body ignored')
            with self.assertRaises(RuntimeError):tracker.check(cfg)
        rows=self.rows();names={r['name'] for r in rows}
        self.assertTrue({'track.poll','track.transition','track.eta_elapsed','track.delivered','track.error'} <= names)
        poll=[r for r in rows if r['name']=='track.poll']
        self.assertEqual([r['ok'] for r in poll],[False,True,False])
        self.assertEqual(poll[1]['props']['state'],'delivered')
        self.assertTrue(poll[1]['props']['changed'])
        self.assertNotIn('secret body ignored',json.dumps(rows))

    def test_recovery_release_and_abandon_success_and_refusal(self):
        import commerce_cli as cli
        import commerce_food
        args=SimpleNamespace(flow_id='fixture-flow',dry_run=False)
        for event, call, target in [
            ('flow.abandon',lambda:cli.abandon_flow(args),'commerce_journal.abandon'),
            ('flow.release',lambda:cli.release_flow(args),'commerce_cli._release_flow'),
            ('flow.recover_payment',lambda:cli.recover_payment(args.flow_id),'commerce_food.recover'),
        ]:
            with self.subTest(event=event), patch.object(cli.journal,'binding',return_value={'app':'noon','vertical':'food'}):
                with patch(target,return_value={'ok':True}):
                    call()
                with patch(target,side_effect=cli.journal.JournalError('OWNER_GO_REQUIRED')):
                    with self.assertRaises(cli.journal.JournalError):call()
                matching=[r for r in self.rows() if r['name']==event]
                self.assertEqual([r['ok'] for r in matching],[True,False])
        self.assertIn('OWNER_GO_REQUIRED',{r['error']['tag'] for r in self.rows() if 'error' in r})

    def test_rollup_error_tags_sample_id_truncated_tail_and_invalid_input(self):
        log.emit('commerce','cmd.error',kind='error',ok=False,error='OWNER_GO_REQUIRED',ids={'flowId':'fixture-flow'})
        path=next(self.folder.glob('*.ndjson'))
        with path.open('a') as out:out.write('{"partial":')
        summary=log.rollup()
        self.assertEqual(summary['topErrors'][0]['tag'],'OWNER_GO_REQUIRED')
        self.assertEqual(summary['topErrors'][0]['count'],1)
        self.assertRegex(summary['topErrors'][0]['sampleId'],r'^[a-f0-9]{16}$')
        self.assertEqual(summary['invalidLines'],1)
        self.assertEqual(summary['errorRate'],1)

    def test_error_input_class_uses_known_codes_only(self):
        rows=[('plain PAN','4242424242424242'),('spaced PAN','CARD_4242 4242 4242 4242'),
              ('dashed PAN','CARD_4242-4242-4242-4242'),('underscored PAN','CARD_4242_4242_4242_4242'),
              ('uppercase token','BEARER_SECRETABCDEF'),('address','APARTMENT_987_EXAMPLE_STREET'),
              ('OTP','OTP_846291'),('known code','OWNER_GO_REQUIRED')]
        for shape,value in rows:
            with self.subTest(shape=shape):
                @log.timed('commerce','step.auth')
                def fail():raise RuntimeError(value)
                with self.assertRaises(RuntimeError):fail()
                row=self.rows()[-1]
                self.assertEqual(row['error']['tag'],value if value=='OWNER_GO_REQUIRED' else 'OPERATION_FAILED')
                if value!='OWNER_GO_REQUIRED':self.assertNotIn(value,json.dumps(row))

    def test_large_command_keeps_errors_and_end_after_two_thousand_events(self):
        written=[]
        def execute(args):
            for _ in range(2200):log.emit('commerce','step.cart_build')
            log.emit('commerce','cmd.error',kind='error',ok=False,error='OWNER_GO_REQUIRED')
            return 1
        with patch.object(log,'_write',side_effect=written.append):
            self.assertEqual(log.run_command(SimpleNamespace(command='order',order_command='main'),execute),1)
        self.assertEqual(len(written),2203)
        self.assertEqual([r['name'] for r in written[-2:]],['cmd.error','cmd.end'])

    def test_failed_rollup_write_is_atomic_and_next_poll_retries(self):
        yesterday=(dt.datetime.now(dt.timezone.utc).date()-dt.timedelta(days=1)).isoformat()
        target=self.folder/('rollup-'+yesterday+'.json')
        def failure(value,out,**kwargs):
            out.write('{"partial":');raise OSError('disk full')
        with patch.object(log.json,'dump',side_effect=failure):
            self.assertIsNone(log.rollup(yesterday))
        self.assertFalse(target.exists())
        self.assertEqual(list(self.folder.glob('.rollup-*')),[])
        log.previous_day_rollup()
        self.assertEqual(json.loads(target.read_text())['day'],yesterday)
        before=target.read_text()
        with patch.object(log.json,'dump',side_effect=failure):self.assertIsNone(log.rollup(yesterday))
        self.assertEqual(target.read_text(),before)

    def test_all_created_log_ancestors_are_private(self):
        home=self.folder.parent/'home';home.mkdir()
        destination=home/'.robob/logs/tools/orders'
        previous=os.umask(0o022)
        try:
            with patch.object(log.Path,'home',return_value=home),patch.object(log,'root',return_value=destination):
                log.emit('commerce','cmd.start')
            for path in [home/'.robob',home/'.robob/logs',home/'.robob/logs/tools',destination]:
                self.assertEqual(path.stat().st_mode & 0o777,0o700,path)
        finally:os.umask(previous)

    def test_guard_code_class_is_recorded_explicitly(self):
        codes=['OWNER_GO_REQUIRED','MONI_GO_NOT_FOUND','MONI_GO_UNVERIFIABLE',
               'NOWNOW_9546_PAID_CONTRACT_UNPROVEN','MAIN_ACTIVE_ORDER_PRESENT',
               'MINUTES_ACTIVE_ORDER_PRESENT','NOWNOW_ACTIVE_ORDER_PRESENT','SUPERMALL_ACTIVE_ORDER_PRESENT',
               'ORDERING_PAUSED','TALABAT_RETIRED','QUIET_DELIVERY_MISMATCH','ADDRESS_BINDING_MISMATCH']
        codes.extend('''
            ACCOUNT_HOME_CHANGED ACCOUNT_OR_HOME_MISMATCH BINDING_MISMATCH
            FOOD_ACCOUNT_HOME_CHANGED FOOD_CART_HOME_OR_OUTLET_CHANGED FOOD_ORDER_HOME_OR_OUTLET_CHANGED
            HOME_2104_BINDING_MISMATCH HOME_2104_MISMATCH HOME_CONTEXT_MISMATCH HOME_MISMATCH
            HOME_PIN_MISMATCH HOME_READ_STALE HOME_SCHEMA_UNKNOWN HOMEPAGE_SCHEMA_CHANGED INVALID_HOME
            MAIN_ACCOUNT_HOME_CHANGED MARKETPLACE_ACCOUNT_HOME_CHANGED MARKETPLACE_CLEAR_ACCOUNT_HOME_CHANGED
            MINUTES_ACCOUNT_HOME_CHANGED NOWNOW_ACCOUNT_HOME_CHANGED NOWNOW_CLEAR_ACCOUNT_HOME_CHANGED
            ORDER_HOME_STORE_MISMATCH SESSION_HOME_MISMATCH STALE_HOME SUPERMALL_ACCOUNT_HOME_CHANGED
            DRIVER_NOTE_INVALID INVALID_DRIVER_NOTES DUPLICATE_PREFERENCE INVALID_PREFERENCES
            PREFERENCES_REQUIRED PREFERENCES_SCHEMA_CHANGED SCHEMA_DELIVERY_OPTIONS SCHEMA_DELIVERY_OPTION
            INVALID_DELIVERY_OPTION INVALID_DELIVERY_OPTION_CODE INVALID_DELIVERY_OPTION_STATUS
            INVALID_DELIVERY_OPTION_ACTION INVALID_DELIVERY_OPTION_TYPE INVALID_DELIVERY_OPTION_MESSAGE
        '''.split())
        for code in codes:
            with self.subTest(code=code):log.guard_refused(code)
        self.assertEqual([r['error']['tag'] for r in self.rows()],codes)

    def test_optional_ids_and_keyword_call_forms(self):
        for supplied in ({},{'expected_order_id':'fixture-order'},{'order_id':'fixture-order'}, {'order':'fixture-order'}):
            with self.subTest(form=next(iter(supplied),'absent')):
                @log.timed('amazon','provider.orders')
                def read(**kwargs):return {'ok':True}
                read(**supplied)
                row=self.rows()[-1]
                if supplied:
                    self.assertEqual(set(row['ids']),{'orderId'})
                else:self.assertNotIn('ids',row)

    def test_card_input_types_preserve_original_validation(self):
        import card_merchants as cm
        with patch.dict(os.environ,{'CARD_STATUS_FILE':str(self.folder.parent/'cards.json')}):
            for value in (None,42,{},[],b'noon'):
                with self.subTest(type=type(value).__name__):
                    try:expected=cm._assert_final(value,'9546')
                    except Exception as original:
                        with self.assertRaises(type(original)) as actual:cm.assert_final(value,'9546')
                        self.assertEqual(str(actual.exception),str(original))
                    else:self.assertEqual(cm.assert_final(value,'9546'),expected)

    def test_fixture_runner_blocks_subprocess_credentials_and_network(self):
        import run_logging as runner
        import subprocess
        import sys
        commands=[['security','find-generic-password','-w'],['mailsearch','read','fixture'],
                  ['curl','https://example.invalid'],['/bin/sh','-c','true'],
                  [sys.executable,'-c','import socket; socket.create_connection(("example.invalid",443))']]
        for command in commands:
            with self.subTest(executable=command[0]):
                with self.assertRaises(AssertionError):runner.guarded_popen(command)
        with self.assertRaises(AssertionError):runner.guarded_popen([sys.executable,'-c','print("ok")'],shell=True)
        process=runner.guarded_popen([sys.executable,'-c','print("ok")'],stdout=subprocess.PIPE)
        output,_=process.communicate(timeout=2)
        self.assertEqual(output,b'ok\n')

    def test_bank_wait_result_class_reports_failed_and_timeout_outcomes(self):
        cases=[({'paid':True},True,None),({'paid':False},False,'PAYMENT_WAIT_UNCONFIRMED'),
               ({'paid':False,'timed_out':True},False,'PAYMENT_WAIT_TIMEOUT'),
               ({'verification_confirmed':False},False,'PAYMENT_WAIT_UNCONFIRMED'),
               ({'verification_confirmed':True},True,None)]
        for value,ok,code in cases:
            with self.subTest(result=value):
                @log.timed('commerce','step.bank_approval_wait')
                def wait():return value
                self.assertEqual(wait(),value)
                row=self.rows()[-1]
                self.assertEqual(row['ok'],ok)
                self.assertEqual(row.get('error',{}).get('tag'),code)
                self.assertEqual(row['kind'],'perf' if ok else 'error')
        with patch.object(log,'CAP_BYTES',1):
            wait_result={'paid':False,'timed_out':True}
            @log.timed('commerce','step.bank_approval_wait')
            def after_cap():return wait_result
            after_cap()
        self.assertEqual(self.rows()[-1]['error']['tag'],'PAYMENT_WAIT_TIMEOUT')

    def test_ack_and_fallback_guard_tags_survive(self):
        for code in ('SAME_BASKET_PENDING_ACK_REQUIRED','NOON_FALLBACK_REQUIRES_RECORDED_9546_DECLINE'):
            with self.subTest(code=code):
                self.assertEqual(log.tag(code),code)
                log.guard_refused(code)
                self.assertEqual(self.rows()[-1]['error']['tag'],code)

    def test_intraday_rollup_is_refreshed_after_more_events_arrive(self):
        now=dt.datetime.now(dt.timezone.utc)
        yesterday=(now.date()-dt.timedelta(days=1)).isoformat()
        self.folder.mkdir()
        source=self.folder/(yesterday+'.ndjson')
        row={'name':'cmd.start','kind':'event'}
        source.write_text(json.dumps(row)+'\n')
        self.assertEqual(log.rollup(yesterday)['total'],1)
        with source.open('a') as out:out.write(json.dumps(row)+'\n')
        log.previous_day_rollup()
        final=json.loads((self.folder/('rollup-'+yesterday+'.json')).read_text())
        self.assertEqual(final['total'],2)
        self.assertEqual(final['sourceBytes'],source.stat().st_size)
        with patch.object(log,'rollup') as repeat:
            log.previous_day_rollup()
            repeat.assert_not_called()

    def test_provider_list_service_arguments_are_not_order_ids(self):
        for service in ('all','minutes','marketplace'):
            with self.subTest(service=service):
                @log.timed('noon','provider.orders')
                def orders(service):return {'ok':True}
                orders(service)
                self.assertNotIn('ids',self.rows()[-1])
