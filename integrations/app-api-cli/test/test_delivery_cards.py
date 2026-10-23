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
                published=next((a for a in self.calls if a[0]=='share'),None)
                return {'shares':[{'app':published[published.index('--app')+1],'live':True,'url':'https://cards.trycloudflare.com/'}] if published else []}
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

    def test_label_reads_before_the_time_and_no_estimate_is_a_word(self):
        d = {'checked_at':'2026-10-22T08:00:00Z','eta_text':'Arrives in 25-35 mins'}
        v = c.view(self.cfg, d, self.cfg['card_meta'])
        self.assertEqual((v['big'], v['word']), ('12:35', False))
        self.assertRegex(v['sub'], r'^Expected (\w{3} \d+ \w{3} )?by$')
        doc = c.markup(v)
        self.assertLess(doc.index('class="when"'), doc.index('<h1'))
        v = c.view(self.cfg, self.data, self.cfg['card_meta'])
        self.assertEqual((v['big'], v['sub'], v['word']), ('No estimate yet', '', True))
        self.assertNotIn('class="when"', c.markup(v))
        self.assertIn('<h1 class="word">', c.markup(v))
        dated = c.view(self.cfg, {**self.data, 'eta_text':'Expected Wednesday 23 September'}, self.cfg['card_meta'])
        self.assertEqual((dated['big'], dated['word']), ('Expected Wednesday 23 September', True))
        self.assertIn('<h1 class="word long">', c.markup(dated))
        # The whole worded estimate reaches the page; only the bubble trims how it shows.
        window = 'Expected Wednesday 23 September between 17:00 and 19:00'
        self.assertEqual(c.view(self.cfg, {**self.data, 'eta_text': window}, self.cfg['card_meta'])['big'], window)
        done = c.view(self.cfg, {**self.data, 'status':'delivered'}, self.cfg['card_meta'])
        self.assertEqual((done['big'], done['sub'], done['word']), ('Delivered', '', True))

    def test_variants_tell_same_dish_apart_and_notes_stay_private(self):
        rows = c.items([
            {'name':'Grilled Shrimp','qty':1,'choicesString':'200g, Satay Sauce, Sweet Potato','specialRequest':'ring twice'},
            {'name':'Grilled Shrimp','qty':1,'choices':[812, 913]},
            {'name':'Organic Eggs','quantity':1,'note':'leave at door'}])
        self.assertEqual([r['detail'] for r in rows], ['200g, Satay Sauce, Sweet Potato', None, None])
        observed = c.items([{'name':'grilled shrimp','quantity':1,'choices':'200g, Satay Sauce, Sweet Potato'},
                            {'name':'Grilled Shrimp','quantity':1,'choices':'100g'}])
        filled = c.fill_details(rows, observed)
        self.assertEqual([r['detail'] for r in filled], ['200g, Satay Sauce, Sweet Potato', '100g', None])
        meta = {'items': rows, 'total': 141.7}
        v = c.view(self.cfg, {**self.data, 'items':[{'name':'Grilled Shrimp','quantity':1,'choices':'100g'}]}, meta)
        doc = c.markup(v)
        self.assertIn('<span class="detail" dir="auto">200g, Satay Sauce, Sweet Potato</span>', doc)
        self.assertIn('<span class="detail" dir="auto">100g</span>', doc)
        self.assertNotIn('ring twice', doc + json.dumps(v))
        self.assertNotIn('leave at door', doc + json.dumps(v))
        self.assertEqual(v['summary'], 'Grilled Shrimp ×2 · Organic Eggs')
        self.assertIn('<p class="summary">3 items · AED 141.70</p>', doc)
        self.assertNotIn('class="more"', doc)
        many = c.view(self.cfg, self.data, {'items': [{'name': f'Item {n}', 'qty': 1} for n in range(5)]})
        self.assertIn('<p class="more">+3 more</p>', c.markup(many))

    def test_repeated_dish_leads_with_the_choices_that_differ(self):
        pizza = 'Spicy Chicken Ranch Pizza with Cheese'
        rows = c.items([{'name': pizza, 'qty': 1, 'choicesString': 'Large, thin crust, stuffed cheese, No Jalapenos'},
                        {'name': pizza, 'qty': 1, 'choicesString': 'Large, thin crust, stuffed cheese, Extra Jalapenos'},
                        {'name': 'Garlic Bread', 'qty': 1, 'choicesString': 'Large, thin crust'}])
        v = c.view(self.cfg, self.data, {'items': rows})
        self.assertEqual([i.get('pick') for i in v['items']],
                         ['No Jalapenos, Large, thin crust, stuffed cheese',
                          'Extra Jalapenos, Large, thin crust, stuffed cheese', None])
        doc = c.markup(v)
        # The full page keeps the server's order; the lead label is extra, for the bubble.
        self.assertIn('<span class="detail" dir="auto">Large, thin crust, stuffed cheese, No Jalapenos</span>'
                      '<span class="pick" dir="auto">No Jalapenos, Large, thin crust, stuffed cheese</span>', doc)
        same = c.view(self.cfg, self.data, {'items': c.items([{'name': pizza, 'qty': 1, 'choicesString': 'Large'}] * 2)})
        self.assertNotIn('class="pick"', c.markup(same))

    def test_picks_set_each_line_apart_from_its_closest_sibling(self):
        pizza = 'Spicy Chicken Ranch Pizza with Cheese'

        def picked(*details):
            rows = c.items([{'name': pizza, 'qty': 1, 'choicesString': d} for d in details])
            return [i.get('pick') for i in c.picks(rows)]
        # A third variant that shares nothing with the first two must not hide their difference.
        # A line whose difference already leads still gets the label (and the wider room).
        self.assertEqual(picked('Large, thin crust, stuffed cheese, No Jalapenos',
                                'Large, thin crust, stuffed cheese, Extra Jalapenos',
                                'Small, thick crust, regular cheese, No Jalapenos'),
                         ['No Jalapenos, Large, thin crust, stuffed cheese',
                          'Extra Jalapenos, Large, thin crust, stuffed cheese',
                          'Small, thick crust, regular cheese, No Jalapenos'])
        # The closest variant's difference can be one the other two share; each line
        # still leads with something that sets it apart from every variant.
        base = 'Large, thin crust, stuffed cheese'
        self.assertEqual(picked(f'{base}, Chicken, Bacon, Extra cheese', f'{base}, Beef, Olives, Extra cheese',
                                f'{base}, Chicken, Bacon, Beef, Olives'),
                         [f'Extra cheese, Chicken, {base}, Bacon', f'Extra cheese, Beef, {base}, Olives',
                          f'Chicken, Beef, {base}, Bacon, Olives'])
        # A repeated choice counts.
        self.assertEqual(picked('Large, thin crust, Cheese', 'Large, thin crust, Cheese, Cheese'),
                         [None, 'Cheese, Large, thin crust, Cheese'])
        # Commas inside brackets belong to one choice; unpaired brackets keep the label whole.
        self.assertEqual(picked('Large, Half & Half (Chicken, Beef)', 'Large, Half & Half (Chicken, Tofu)'),
                         ['Half & Half (Chicken, Beef), Large', 'Half & Half (Chicken, Tofu), Large'])
        self.assertEqual(picked('Half & Half (Chicken, Beef), Large', 'Half & Half (Chicken, Tofu), Large'),
                         ['Half & Half (Chicken, Beef), Large', 'Half & Half (Chicken, Tofu), Large'])
        self.assertEqual(picked('Large, Extra (cheese', 'Large, Extra (beef'),
                         ['Large, Extra (cheese', 'Large, Extra (beef'])
        self.assertEqual(c.choice_parts('Large, "Chef, special", Mild'), ['Large', '"Chef, special"', 'Mild'])
        self.assertEqual(c.choice_parts('Large, Half (Chicken, Beef], Mild'), ['Large, Half (Chicken, Beef], Mild'])
        # A line holding both choices doesn't hide what sets the other two apart.
        base = 'Large, thin crust, stuffed cheese'
        self.assertEqual(picked(f'{base}, Cheese', f'{base}, Olives', f'{base}, Cheese, Olives'),
                         [f'Cheese, {base}', f'Olives, {base}', f'Cheese, Olives, {base}'])
        # Long labels that differ only at the end keep the difference.
        long = 'Large, ' + ', '.join(f'Topping {n}' for n in range(16))
        self.assertGreater(len(long), 160)
        self.assertEqual(picked(f'{long}, No Jalapenos', f'{long}, Extra Jalapenos'),
                         [f'No Jalapenos, {long}'[:160], f'Extra Jalapenos, {long}'[:160]])
        # Arabic choices keep their own direction, so the cut falls on the shared tail.
        rows = c.picks(c.items([{'name': pizza, 'qty': 1, 'choicesString': d}
                                for d in ('كبير, بدون فلفل', 'كبير, فلفل إضافي')]))
        doc = c.markup({**c.view(self.cfg, self.data, {}), "items": rows})
        self.assertIn('<span class="pick" dir="auto">بدون فلفل, كبير</span>', doc)

    def test_unpaired_variants_never_borrow_another_lines_price(self):
        stored = c.items([{'name':'Grilled Shrimp','qty':1,'line_total':40.5},
                          {'name':'Grilled Shrimp','qty':1,'line_total':73.8},
                          {'name':'Organic Eggs','qty':1,'line_total':22.5}])
        read = c.items([{'name':'Organic Eggs','quantity':1},
                        {'name':'Grilled Shrimp','quantity':1,'choices':'200g, Satay Sauce, Sweet Potato'},
                        {'name':'Grilled Shrimp','quantity':1,'choices':'100g'}])
        rows = c.fill_details(stored, read)
        self.assertEqual([(r['name'], r['detail'], r['line_total']) for r in rows], [
            ('Grilled Shrimp', '200g, Satay Sauce, Sweet Potato', None), ('Grilled Shrimp', '100g', None),
            ('Organic Eggs', None, 22.5)])
        # Quantities that don't add up leave the stored lines alone.
        short = c.fill_details(stored, read[:2])
        self.assertEqual([r['detail'] for r in short], [None, None, None])
        # Same choices on every line pair safely with prices kept.
        same = c.fill_details(stored[:2], c.items([{'name':'Grilled Shrimp','quantity':1,'choices':'100g'}] * 2))
        self.assertEqual([(r['detail'], r['line_total']) for r in same], [('100g', 40.5), ('100g', 73.8)])

    def test_variant_pairing_respects_quantities(self):
        stored = c.items([{'name':'Grilled Shrimp','qty':2,'choicesString':'100g','line_total':81},
                          {'name':'Grilled Shrimp','qty':1,'line_total':73.8}])
        # The read shows 100g once, not twice: which line is which is unknown, so nothing moves.
        read = c.items([{'name':'Grilled Shrimp','quantity':1,'choices':'100g'},
                        {'name':'Grilled Shrimp','quantity':2,'choices':'200g'}])
        self.assertEqual(c.fill_details(stored, read), stored)
        # A matching quantity pairs as before.
        read = c.items([{'name':'Grilled Shrimp','quantity':2,'choices':'100g'},
                        {'name':'Grilled Shrimp','quantity':1,'choices':'200g'}])
        self.assertEqual([(r['detail'], r['line_total']) for r in c.fill_details(stored, read)],
                         [('100g', 81), ('200g', 73.8)])
        # One line each, quantities differ: no fill.
        one = c.items([{'name':'Grilled Shrimp','qty':2,'line_total':81}])
        self.assertEqual(c.fill_details(one, c.items([{'name':'Grilled Shrimp','quantity':1,'choices':'100g'}])), one)

    def test_one_public_link_and_no_progress_send(self):
        first = c.sync(self.cfg, self.data, send=True)
        self.assertEqual(first['status'], 'sent')
        for status in ('picked up','out for delivery','delivered'):
            c.sync(self.cfg,{**self.data,'status':status},send=True)
        self.assertEqual([a[0] for a in self.calls], ['shares','share','send','shares'])
        self.assertEqual(self.calls[2][1:3], ['--to','moni'])
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

    def test_retry_after_owner_route_rotation_uses_the_live_session(self):
        self.fail_send = True
        c.sync(self.cfg,self.data,send=True)
        first = next(a for a in self.calls if a[0]=='send')
        self.fail_send = False
        with patch.object(c,'route',lambda: 'rotated-session'):
            self.assertEqual(c.sync(self.cfg,self.data,send=True)['status'],'sent')
        retry = [a for a in self.calls if a[0]=='send'][-1]
        self.assertEqual(first[first.index('--session')+1],'fixture-session')
        self.assertEqual(retry[retry.index('--session')+1],'rotated-session')
        drop = lambda a: [x for i,x in enumerate(a) if '--session' not in a[max(i-1,0):i+1]]
        self.assertEqual(drop(first),drop(retry))

    def test_group_card_chat_gets_the_public_link(self):
        cfg = {**self.cfg,'for':'owner','delivery_card':{'ready':True,'chat':'group-sb_gro'}}
        self.assertEqual(c.sync(cfg,self.data,send=True)['status'],'sent')
        sent = next(a for a in self.calls if a[0]=='send')
        self.assertEqual(sent[sent.index('--to')+1],'group-sb_gro')
        self.assertIn('--text=https://cards.trycloudflare.com/',sent)

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
        self.assertEqual([a[0] for a in self.calls],['shares','share','send','shares'])
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
        self.assertEqual([a[0] for a in self.calls],['shares','share','send','shares'])

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

    def test_public_extra_files_refuse_before_any_page_write(self):
        result=c.sync(self.cfg,self.data,send=True)
        folder=c.APPS/result['slug']
        before=(folder/'index.html').read_bytes()
        (folder/'items.json').write_text('{"store":"private metadata"}')
        result=c.sync(self.cfg,{**self.data,'status':'delivered'},send=False)
        self.assertEqual(result['status'],'failed:public_directory_has_extra_files')
        self.assertEqual(before,(folder/'index.html').read_bytes())

    def test_now_now_native_total_and_minutes_price_omission(self):
        from types import SimpleNamespace as N
        flow=N(current=N(wire={'data':{'products':[{'name':'Milk','qty':2,'price':20,'totalPrice':20}]}},projection={}))
        rows=c.commerce_metadata(flow,'nownow')
        self.assertIsNone(rows[0]['price'])
        self.assertEqual(rows[0]['line_total'],20)
        flow.current.wire={'items':[{'title':'Milk','qty':2,'price':20,'salePrice':15}]}
        self.assertIsNone(c.commerce_metadata(flow,'minutes')[0]['price'])
        flow.card_recovered=True
        self.assertEqual(c.commerce_metadata(flow,'minutes'),[])

    def test_changed_link_explicit_repair_uses_new_key_and_is_idempotent(self):
        c.sync(self.cfg,self.data,send=True)
        original=next(a for a in self.calls if a[0]=='send')
        state=c.read(c.ROOT/'cards/order-talabat-123.json')
        calls=[]
        def repaired(args,**kw):
            calls.append(args)
            if args[0]=='shares':return {'shares':[{'app':state['slug'],'live':True,'url':'https://new.trycloudflare.com/'}]}
            self.assertIn('https://new.trycloudflare.com/preview.png',(c.APPS/state['slug']/'index.html').read_text())
            return {'id':'repair-ack','created':True}
        with patch.object(c,'bridge',side_effect=repaired):
            self.assertEqual(c.repair_link(self.cfg,self.data)['status'],'sent')
            self.assertEqual(c.repair_link(self.cfg,self.data)['status'],'unchanged')
        sent=[a for a in calls if a[0]=='send']
        self.assertEqual(len(sent),1)
        self.assertNotEqual(sent[0][-1],original[-1])
        self.assertIn('new.trycloudflare.com',(c.APPS/state['slug']/'index.html').read_text())

    def test_prune_only_completed_owned_delivery_shares(self):
        c.sync(self.cfg,{**self.data,'status':'delivered'},send=True)
        path=c.ROOT/'cards/order-talabat-123.json';state=c.read(path)
        state['terminal_at']=c.time.time()-3601;c.atomic(path,state)
        c.prune_completed_shares()
        self.assertEqual(self.calls[-1],['unshare','--app',state['slug']])
        self.assertTrue(c.read(path)['unshared'])

    def test_cleanup_failure_cannot_block_new_card(self):
        with patch.object(c,'prune_completed_shares',side_effect=ValueError('offline')):
            result=c.sync(self.cfg,self.data,send=True)
        self.assertEqual(result['status'],'sent')

    def test_share_lifetime_covers_long_promises(self):
        self.assertEqual(c.share_days(self.cfg),2)
        self.assertEqual(c.share_days({**self.cfg,'vertical':'main'}),7)
        cfg={**self.cfg,'eta':(dt.datetime.now(dt.timezone.utc)+dt.timedelta(days=12)).isoformat()}
        self.assertGreaterEqual(c.share_days(cfg),14)

    def test_recovery_without_cart_keeps_registered_item_metadata(self):
        cfg={**self.cfg,'delivery_card':{'held':True}}
        t.write(t.ROOT/'orders/order-talabat-123.json',cfg)
        t.write(t.WATCHERS/cfg['watcher']/'watcher.json',{'id':'existing'})
        with contextlib.redirect_stdout(io.StringIO()):
            t.main(['add','--app','talabat','--order','123','--for','moni','--card-items-json','[]'])
        saved=t.read(t.ROOT/'orders/order-talabat-123.json')
        self.assertEqual(saved['card_meta']['items'],cfg['card_meta']['items'])


if __name__ == '__main__':
    unittest.main()
