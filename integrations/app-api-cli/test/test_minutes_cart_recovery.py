"""Recorded 17 Oct catalog/freebie shapes with synthetic account/payment data."""
import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch
from email.message import Message

import commerce_cli as cli
import commerce_minutes as c
import commerce_minutes_cleanup as cleanup
import noon_minutes_options as options
from commerce_basket_input import read_items
from test.test_noon_minutes_checkout import fixture, Harness, HEADERS
from test import test_commerce_minutes as flow_tests
from test import test_multi_basket_lanes as basket_tests


def gift():
    # Projected item fields recorded before the live-cart hold; no account data.
    return {'sku':'Z6369F4D632B77DF4D4E0Z-1','qty':1,
            'title':'Toilet Rim Blocks Lavender Freebie','isFreebie':True,
            'price':0,'offerPrice':0,'salePrice':None,'qtyMax':0,
            'cartLineType':'normal','selectedModifiers':None,'isCustomizable':False}


def catalog():
    # Fields reconstructed from the recorded catalog group output, 17 Oct.
    return json.loads((Path(__file__).parent/'fixture_minutes_options.json').read_text())


def snapshot(data):
    return c.m.Snapshot(data,c.m.project_session(data),time.time())


class FreebieTests(unittest.TestCase):
    def review(self,data):
        return c.m.review_snapshot(snapshot(data),expected_skus=[c.m.sku_line('SYNTHETIC_SHAKE',1)],
            expected_total_minor=2050,required_preferences=['synthetic_leave','synthetic_quiet'],
            card=c.m.SavedCard('synthetic-payment-token','xxxx5542','mastercard'))

    def test_recorded_freebie_with_qtymax_zero_passes_and_is_digest_bound(self):
        data=fixture();data['items'].insert(0,gift())
        first=self.review(data)
        data['items'][0]['qty']=2
        self.assertNotEqual(first,self.review(data))

    def test_unexplained_paid_requested_or_special_extra_never_passes(self):
        changes=[{'price':1},{'offerPrice':0.01},{'salePrice':1},{'price':None},
                 {'isFreebie':False},{'isFreebie':None},{'qty':0},
                 {'sku':'SYNTHETIC_SHAKE'},{'bundle':{}},{'dealCode':'UNVERIFIED'},
                 {'cartLineType':'unknown'},{'selectedModifiers':{'g':['m']}}]
        for change in changes:
            with self.subTest(change=change):
                data=fixture();data['items'].append({**gift(),**change})
                with self.assertRaises(c.m.MinutesError):self.review(data)
        data=fixture();data['items']=[gift()]
        with self.assertRaisesRegex(c.m.MinutesError,'MANIFEST_MISMATCH'):self.review(data)

    def test_prepare_and_resume_report_gift_without_financial_calls(self):
        helper=basket_tests.MinutesMultiBasketTests()
        data=helper.multi_wire();data['items'].append(gift())
        items=[{'sku':'SYNTHETIC_SHAKE','qty':2},{'sku':'SYNTHETIC_BAR','qty':3}]
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(c.j,'ROOT',Path(temp)/'commerce'), \
                patch.object(c.receipts,'ROOT',Path(temp)/'commerce'), \
                patch.object(options,'read_options',return_value={'groups':[]}):
            auth=flow_tests.ResumeActiveTests().auth()
            flow=c.MinutesFlow(items=items,auth=auth)
            harness=Harness([helper.empty_wire(),data,data,data,helper.card_wire()])
            flow.client._request=harness.request
            prepared=flow.prepare_only()
            self.assertEqual(prepared['review']['provider_added_freebies'],[{
                'sku':gift()['sku'],'title':gift()['title'],'quantity':1,'price_minor':0}])
            self.assertFalse({'place','payment_complete'} & {x[0] for x in harness.calls})
            with patch.object(c,'readback_session',return_value=snapshot(data)):
                resumed=c.MinutesFlow.resume_active(flow.flow_id,items=items,auth=auth)
            self.assertEqual(resumed.flow_id,flow.flow_id)


class OptionsTests(unittest.TestCase):
    def test_catalog_transport_is_get_with_encoded_query_and_no_body(self):
        from unittest.mock import Mock
        response=Mock()
        response.__enter__=Mock(return_value=response)
        response.__exit__=Mock(return_value=False)
        response.code=200;response.headers=Message()
        response.geturl.return_value='https://api-app-instant.noon.com/_svc/catalog/search?q=shot+coffee&page=1&rows=50&productsOnly=1'
        response.read.return_value=b'{"hits":[]}'
        opener=Mock();opener.open.return_value=response
        with patch.object(c.m.urllib.request,'build_opener',return_value=opener):
            c.m.native_request('catalog_search',HEADERS,time.monotonic()+10,None,
                query={'q':'shot coffee','page':1,'rows':50,'productsOnly':'1'},
                response_observer=lambda _:None)
        request=opener.open.call_args.args[0]
        self.assertEqual(request.full_url,response.geturl.return_value)
        self.assertEqual(request.get_method(),'GET');self.assertIsNone(request.data)

    def test_recorded_groups_and_missing_required_are_reported_before_any_cart_call(self):
        hit=catalog();sku=hit['sku'];projected=options.project_options(hit,sku)
        self.assertEqual(len(projected['groups']),6)
        self.assertEqual(projected['groups'][2]['options'][2]['price_minor'],400)
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(c.j,'ROOT',Path(temp)/'commerce'), \
                patch.object(c.receipts,'ROOT',Path(temp)/'commerce'), \
                patch.object(options,'read_options',return_value=projected), \
                patch.object(c.MinutesFlow,'initial_session',side_effect=AssertionError('no cart reads')):
            flow=c.MinutesFlow(items=[{'sku':sku,'qty':1}],auth=flow_tests.ResumeActiveTests().auth())
            with self.assertRaises(options.OptionsError) as error:flow.prepare_only()
            self.assertEqual(error.exception.code,'MINUTES_REQUIRED_OPTIONS_MISSING')
            self.assertEqual([x['title'] for x in error.exception.details['required_groups']],
                             ['Choose size','Choose coffee beans','Choose type of milk'])
            self.assertFalse(flow.opened)

    def test_items_file_modifiers_reach_sync_and_exact_readback(self):
        hit=catalog();sku=hit['sku'];selected=['coffee_regular_colddrinks','dark_roast','low_fat_milk']
        data=fixture();data['items'][0].update(sku=sku,selectedModifiers={
            'cup_size_dummy_colddrinks':[selected[0]],'coffee_blend':[selected[1]],'type_of_milk':[selected[2]]})
        empty=fixture();empty['items']=[]
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(c.j,'ROOT',Path(temp)/'commerce'), \
                patch.object(c.receipts,'ROOT',Path(temp)/'commerce'), \
                patch.object(options,'read_options',return_value=options.project_options(hit,sku)) as discover:
            path=Path(temp)/'items.json'
            path.write_text(json.dumps({'items':[{'sku':sku,'qty':1,'modifiers':selected,
                                                 'catalog_query':'shot iced caramel macchiato'}]}))
            flow=c.MinutesFlow(items=read_items(str(path)),auth=flow_tests.ResumeActiveTests().auth())
            harness=Harness([empty,data]);flow.client._request=harness.request
            flow.initial_session();flow.fill_empty()
            self.assertEqual(harness.calls[-1],('sync',{'skus':[{'sku':sku,'qty':1,'modifiers':selected}],
                                                      'bundles':[],'refresh':False}))
            self.assertEqual(discover.call_args.kwargs['query'],'shot iced caramel macchiato')

    def test_unknown_codes_excess_and_schema_changes_refused(self):
        hit=catalog();p=options.project_options(hit,hit['sku'])
        base=['coffee_regular_colddrinks','dark_roast','low_fat_milk']
        for selected in (base+['invented_skimmed'],base+['medium_roast']):
            with self.assertRaisesRegex(options.OptionsError,'MINUTES_OPTIONS_INVALID'):
                options.validate_selection({'sku':hit['sku'],'modifiers':selected},p)
        for changed in ({'customizationOptions':None},{'customizationConfig':{'unverified':True}}):
            with self.assertRaises(c.m.MinutesError):options.project_options({**hit,**changed},hit['sku'])
        plain={'sku':'PLAIN','isCustomizable':False,'customizationOptions':None}
        self.assertEqual(options.project_options(plain,'PLAIN')['groups'],[])
        with self.assertRaises(c.m.MinutesError):
            options.project_options({**plain,'isCustomizable':True,'customizationOptions':[]},'PLAIN')

    def test_read_only_discovery_exact_identity_and_cli_error_details(self):
        hit=catalog();auth=flow_tests.ResumeActiveTests().auth()
        with patch.object(options.m,'native_request',return_value={'hits':[hit]}) as request:
            p=options.read_options(hit['sku'],query='shot iced caramel macchiato',auth=auth)
        self.assertEqual(request.call_args.args[0],'catalog_search')
        self.assertIsNone(request.call_args.args[3])
        with patch.object(options.m,'native_request',return_value={'hits':[{**hit,'sku':'WRONG'}]}):
            with self.assertRaisesRegex(options.OptionsError,'CATALOG_ITEM_NOT_RESOLVED'):
                options.read_options(hit['sku'],auth=auth)
        with patch.object(options,'read_options',return_value=p),contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cli.main(['item-options','minutes','--sku',hit['sku']]),0)
        self.assertFalse(json.loads(out.getvalue())['cart_mutation_sent'])
        error=options.OptionsError('MINUTES_REQUIRED_OPTIONS_MISSING',{'required_groups':p['groups'][:3]})
        with patch.object(cli,'order_minutes',side_effect=error),contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cli.main(['order','minutes','--sku',hit['sku'],'--prepare-only']),1)
        self.assertEqual(len(json.loads(out.getvalue())['details']['required_groups']),3)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        for mod in (c.j,c.receipts):
            p=patch.object(mod,'ROOT',Path(self.temp.name)/'commerce');p.start();self.addCleanup(p.stop)
        self.auth=flow_tests.ResumeActiveTests().auth()
        self.data=fixture();self.data['items'].append(gift())
        self.skus=[c.m.sku_line('SYNTHETIC_SHAKE',1)]
        self.flow=c.MinutesFlow(skus=self.skus,auth=self.auth)
        empty=fixture();empty['items']=[]
        self.empty=snapshot(empty)
        self.harness=Harness([empty,self.data])
        self.flow.client._request=self.harness.request
        with patch.object(options,'read_options',return_value={'groups':[]}):
            self.flow.initial_session();self.flow.fill_empty()

    def invoke(self,reads=None,active=0):
        real=c.m.MinutesCheckout
        harness=Harness([self.empty.wire])
        def client(*a,**kw):return real(*a,request=harness.request,**kw)
        with patch.object(cleanup,'readback_session',side_effect=reads or [snapshot(self.data),snapshot(self.data),self.empty]), \
                patch.object(cleanup,'readback_active_orders',return_value=c.m.Snapshot({},{'count':active},time.time())), \
                patch.object(c.m,'MinutesCheckout',side_effect=client) as constructor:
            # Keep the static receipt reconstruction available through the factory mock.
            constructor._response_receipt=real._response_receipt
            result=cleanup.clear_cart(self.flow.flow_id,auth=self.auth)
        return result,harness

    def test_closed_cart_clears_once_and_independent_readback_is_empty(self):
        c.j.abandon(self.flow.flow_id)
        result,harness=self.invoke()
        self.assertEqual(harness.calls,[('sync',{'skus':[],'bundles':[],'refresh':False})])
        self.assertTrue(result['cart_empty']);self.assertFalse(result['financial_send'])
        self.assertEqual(c.j.inspect(result['cleanup_flow_id'])['state'],'RELEASED')
        self.assertEqual(c.j.inspect(self.flow.flow_id)['state'],'RELEASED')
        # A second call cannot reuse old evidence after its cleanup operation.
        with self.assertRaisesRegex(c.j.JournalError,'OWNERSHIP_SUPERSEDED'):self.invoke()

    def test_active_or_financial_source_never_contacts_provider(self):
        with patch.object(cleanup,'NoonAuthLifecycle',side_effect=AssertionError('no auth')):
            with self.assertRaisesRegex(c.j.JournalError,'CLOSED_CART_ONLY'):
                cleanup.clear_cart(self.flow.flow_id)
        c.j.consume(self.flow.flow_id,'place',kind='place',request_hash='a'*64,
                    cart_hash='b'*64,review_hash='c'*64,payable_minor=2050)
        c.j.observe(self.flow.flow_id,'place',outcome='UNKNOWN',evidence_hash='d'*64)
        c.j.release_orderless(self.flow.flow_id,evidence_hash='e'*64)
        with self.assertRaisesRegex(c.j.JournalError,'CLOSED_CART_ONLY'):self.invoke()

    def test_changed_cart_active_order_or_new_flow_cannot_be_cleared(self):
        c.j.abandon(self.flow.flow_id)
        changed=copy.deepcopy(self.data);changed['items'][0]['qty']=2
        with self.assertRaisesRegex(c.m.MinutesError,'READBACK_MISMATCH'):
            self.invoke([snapshot(changed)])
        with self.assertRaisesRegex(c.m.MinutesError,'ACTIVE_ORDER_PRESENT'):self.invoke(active=1)
        c.j.open_flow(flow_id=str(uuid.uuid4()),app='noon',vertical='minutes',
                    account_hash=self.flow.snapshot.account_ref,scope_hash='a'*64)
        with self.assertRaisesRegex(c.j.JournalError,'ACCOUNT_RECONCILIATION_REQUIRED'):self.invoke()

    def test_readback_change_immediately_before_clear_sends_nothing(self):
        c.j.abandon(self.flow.flow_id)
        changed=copy.deepcopy(self.data);changed['items'].append({**gift(),'sku':'OTHER'})
        with self.assertRaisesRegex(c.m.MinutesError,'AUTH_HEADERS_FAILED'):
            self.invoke([snapshot(self.data),snapshot(changed)])
        c.j.require_account_available('noon',self.flow.snapshot.account_ref)

    def test_unknown_clear_keeps_account_fenced(self):
        c.j.abandon(self.flow.flow_id)
        real=c.m.MinutesCheckout
        harness=Harness([c.m.MinutesError('REQUEST_TIMEOUT')])
        with patch.object(cleanup,'readback_session',return_value=snapshot(self.data)), \
                patch.object(cleanup,'readback_active_orders',return_value=c.m.Snapshot({},{'count':0},time.time())), \
                patch.object(c.m,'MinutesCheckout',side_effect=lambda *a,**kw: real(*a,
                    request=harness.request,**kw)) as constructor:
            constructor._response_receipt=real._response_receipt
            with self.assertRaisesRegex(c.m.MinutesError,'REQUEST_TIMEOUT'):
                cleanup.clear_cart(self.flow.flow_id,auth=self.auth)
        with self.assertRaisesRegex(c.j.JournalError,'ACCOUNT_RECONCILIATION_REQUIRED'):
            c.j.require_account_available('noon',self.flow.snapshot.account_ref)
