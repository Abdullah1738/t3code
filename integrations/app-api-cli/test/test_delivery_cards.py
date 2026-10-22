import contextlib
import datetime as dt
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import delivery_cards as c
import order_tracker as t


class CardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for obj, name, value in ((c, 'APPS', self.root/'apps'), (c, 'ROOT', self.root/'state'),
                                 (t, 'ROOT', self.root/'state'), (t, 'WATCHERS', self.root/'watchers'),
                                 (c, 'WATCHERS', self.root/'watchers')):
            p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)
        self.calls = []
        self.fail_send = False
        def bridge(args, **kw):
            self.calls.append(args)
            if args[0] == 'shares':
                published=next(a for a in self.calls if a[0]=='share')
                return {'shares':[{'app':published[-1],'live':True,'url':'https://cards.trycloudflare.com/'}]}
            if args[0] in ('share', 'publish'):
                return {'url': 'https://cards.trycloudflare.com/' if args[0] == 'share' else 'https://host.ts.net:18400/card/'}
            if self.fail_send:
                raise ValueError('bridge_request_failed')
            return {'id': 'message-fixture', 'created': True}
        for name, value in (('bridge', bridge), ('route', lambda: 'fixture-session')):
            p = patch.object(c, name, value); p.start(); self.addCleanup(p.stop)
        self.cfg = {'app':'talabat','order':'123','for':'moni','watcher':'order-talabat-123',
                    'registered_at':dt.datetime.now(dt.timezone.utc).isoformat(), 'vertical':'restaurants',
                    'delivery_card':{'ready':True}, 'card_meta':{'items':[{'name':'Iced latte','qty':1}]}}
        self.data = {'status':'preparing','checked_at':dt.datetime.now(dt.timezone.utc).isoformat()}

    def test_food_steps_and_scoped_terminal_proof(self):
        self.assertEqual(c.stage(self.data, True)[2], 'Preparing')
        self.assertEqual(c.stage({'status':'picked up'}, True)[2], 'Picked up')
        for terminal in ('delivered', 'cancelled'):
            self.assertFalse(c.stage({'status':terminal, 'whole_order_complete':False})[3])
        for row in ({'shipment_id':'N123-S1'}, {'status':'delivered'}):
            result = c.stage({'status':'unknown','shipments':[row],'whole_order_complete':False})
            self.assertEqual((result[1],result[3]), (-1,False))
        self.assertEqual(c.stage({'status':'unknown','candidate':{'stage':'delivered'}})[2], 'Tracking pending')

    def test_eta_range_and_minute_only_never_advance_at_render(self):
        d = {'checked_at':'2026-10-22T08:00:00Z','eta_text':'Arrives in 25-35 mins'}
        self.assertEqual(c.eta(d,{})[0], '12:35')
        self.assertEqual(c.eta({**d,'eta_text':'in 8 min'}, {})[0], '12:08')
        self.assertEqual(c.eta({**d,'eta_text':'1 hr 5 min'}, {})[0], '13:05')
        self.assertIsNone(c.eta({'eta_text':'in 8 min'}, {})[2])

    def test_one_public_link_and_no_progress_send(self):
        first = c.sync(self.cfg, self.data, send=True)
        self.assertEqual(first['status'], 'sent')
        for status in ('picked up','out for delivery','delivered'):
            c.sync(self.cfg,{**self.data,'status':status},send=True)
        self.assertEqual([a[0] for a in self.calls], ['share','send','shares'])
        self.assertEqual(self.calls[1][1:3], ['--to','moni'])
        doc = (c.APPS / first['slug'] / 'index.html').read_text()
        self.assertIn('https://cards.trycloudflare.com/preview.png',doc)
        self.assertIn('Delivered', doc)

    def test_owner_card_tailnet_and_hold_release(self):
        cfg = {**self.cfg,'for':'owner','delivery_card':{'held':True}}
        self.assertEqual(c.sync(cfg,self.data,send=True)['status'],'held:payment_unconfirmed')
        self.assertEqual(self.calls,[])
        cfg['delivery_card']['held'] = False
        self.assertEqual(c.sync(cfg,self.data,send=True)['status'],'sent')
        self.assertEqual([a[0] for a in self.calls],['publish','app'])

    def test_ambiguous_send_retries_exact_payload_and_key(self):
        self.fail_send = True
        self.assertTrue(c.sync(self.cfg,self.data,send=True)['status'].startswith('failed:'))
        first = next(a for a in self.calls if a[0]=='send')
        self.fail_send = False
        self.assertEqual(c.sync(self.cfg,{**self.data,'status':'picked up'},send=True)['status'],'sent')
        self.assertEqual(first,[a for a in self.calls if a[0]=='send'][-1])
        self.assertEqual(sum(a[0]=='share' for a in self.calls),1)

    def test_safe_projection_escaping_zero_and_unknown(self):
        cfg = {**self.cfg,'total':'AED 0.00','address':'private','token':'secret'}
        v = c.view(cfg,self.data,{'store':'<script>bad</script>','items':[{'name':'<b>Milk</b>','qty':2,'image':'javascript:alert(1)'}]})
        self.assertEqual(v['total'],0)
        self.assertIsNone(v['items'][0]['image'])
        self.assertNotIn('address',v)
        self.assertNotIn('secret',json.dumps(v))
        doc = c.page(v)
        self.assertNotIn('<script>bad</script>',doc)
        self.assertIn('&lt;b&gt;Milk&lt;/b&gt;',doc)

    def test_add_registration_and_watcher_refresh_without_resend(self):
        def run(args, timeout=12):
            folder=t.WATCHERS/'order-talabat-123';folder.mkdir(parents=True,exist_ok=True)
            t.write(folder/'watcher.json',{'context':args[args.index('--context')+1]})
            t.write(folder/'order-tracker-state.json',{'last_result':self.data})
            return 'ok'
        with patch.object(t,'run',side_effect=run),patch.object(t.store,'reconcile'),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(t.main(['add','--app','talabat','--order','123','--for','moni','--vertical','restaurants']),0)
        cfg=t.read(t.ROOT/'orders/order-talabat-123.json')
        self.assertEqual(cfg['placed_notice']['channel'],'delivery_card')
        with patch.dict(t.os.environ,WATCH_DIR=str(t.WATCHERS/cfg['watcher'])),patch.object(t,'fetch',return_value={**self.data,'status':'picked up'}),patch.object(t.store,'reconcile'),contextlib.redirect_stdout(io.StringIO()):
            t.check(cfg)
        self.assertEqual([a[0] for a in self.calls],['share','send','shares'])
        state=c.read(c.ROOT/'cards/order-talabat-123.json')
        v=c.read(c.APPS/state['slug']/'status.json')
        self.assertEqual(v['stage'],'Picked up')

    def test_dry_run_and_scratch_test_cannot_publish(self):
        with contextlib.redirect_stdout(io.StringIO()):
            t.main(['add','--app','talabat','--order','123','--for','moni','--dry-run-text'])
        self.assertEqual(self.calls,[])
        scratch=self.root/'scratch';scratch.mkdir()
        with patch.dict(t.os.environ,WATCH_DIR=str(scratch)),patch.object(t,'fetch',return_value=self.data),contextlib.redirect_stdout(io.StringIO()):
            t.check(self.cfg)
        self.assertFalse(c.APPS.exists())
        self.assertEqual(self.calls,[])

    def test_old_registration_never_sends_on_check(self):
        cfg={**self.cfg};cfg.pop('delivery_card')
        self.assertEqual(c.sync(cfg,self.data,send=True)['status'],'legacy_not_enrolled')
        self.assertEqual(self.calls,[])

    def test_metadata_readd_preserves_hold_until_explicit_confirmation(self):
        cfg={**self.cfg,'delivery_card':{'held':True,'ready':True}}
        t.write(t.ROOT/'orders/order-talabat-123.json',cfg)
        t.write(t.WATCHERS/cfg['watcher']/'watcher.json',{'id':'existing'})
        t.write(t.WATCHERS/cfg['watcher']/'order-tracker-state.json',{'last_result':self.data})
        argv=['add','--app','talabat','--order','123','--for','moni','--store','Renamed store']
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(t.main(argv),0)
        self.assertEqual(self.calls,[])
        self.assertTrue(t.read(t.ROOT/'orders/order-talabat-123.json')['delivery_card']['held'])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(t.main([*argv,'--payment-confirmed']),0)
        self.assertEqual([a[0] for a in self.calls],['share','send','shares'])

    def test_public_directory_does_not_reuse_private_legacy_metadata(self):
        legacy=c.APPS/c.slug('talabat','123');legacy.mkdir(parents=True)
        (legacy/'items.json').write_text(json.dumps({'address':'private address','card':'5542'}))
        result=c.sync(self.cfg,self.data,send=True)
        self.assertNotEqual(result['slug'],legacy.name)
        self.assertFalse((c.APPS/result['slug']/'items.json').exists())
        self.assertIn('private address',(legacy/'items.json').read_text())

    def test_partial_cancel_and_shipped_do_not_claim_final_delivery(self):
        self.assertEqual(c.stage({'status':'picked up'})[2],'In transit')
        v=c.view(self.cfg,{'status':'unknown','whole_order_complete':False,
                           'partial_evidence':[{'stage':'cancelled'}]}, {})
        self.assertFalse(v['partial'])

    def test_unknown_manifest_does_not_discard_better_checkout_rows(self):
        v=c.view(self.cfg,{'items':[{'item_id':'opaque','quantity':1}]},
                 {'items':[{'sku':'known-sku','quantity':1,'price':9.5}]})
        self.assertEqual(v['items'][0]['price'],9.5)
        self.assertIn('known-sku',v['items'][0]['name'])

    def test_changed_public_link_is_reported_without_extra_message(self):
        c.sync(self.cfg,self.data,send=True)
        path=c.ROOT/'cards/order-talabat-123.json'
        state=c.read(path);state['link_checked_at']=0;c.atomic(path,state)
        with patch.object(c,'bridge',return_value={'shares':[]}):
            result=c.sync(self.cfg,self.data,send=True)
        self.assertEqual(result['link_health'],'needs_repair')
        self.assertEqual(sum(a[0]=='send' for a in self.calls),1)


if __name__ == '__main__':
    unittest.main()
