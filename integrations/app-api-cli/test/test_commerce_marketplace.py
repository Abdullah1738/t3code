from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock,patch

import commerce_marketplace as c
from noon_auth_lifecycle import AuthSnapshot


class IntegrationTests(unittest.TestCase):
    def test_quiet_sounding_option_cannot_trigger_speculative_setter(self):
        from noon_marketplace_review import QuietOption
        flow=object.__new__(c.MarketplaceFlow);flow.service='main'
        from unittest.mock import Mock
        flow.session_response=Mock(data={'deliveryOptions':{'no_bell':{'status':'inactive','type':'checkbox','message':'Do not ring'}}})
        flow.client=Mock()
        with self.assertRaisesRegex(Exception,'UNSUPPORTED_NATIVE_MARKETPLACE_QUIET_DELIVERY'):
            flow.set_delivery_options((QuietOption('no_bell','no_bell',True,'unproved'),))
        flow.client.call.assert_not_called()

    def setup_flow(self,service='main',response=None):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        p=patch.object(c.journal,'ROOT',Path(temp.name).resolve()/'commerce');p.start();self.addCleanup(p.stop)
        p=patch.object(c.receipts,'ROOT',Path(temp.name).resolve()/'commerce');p.start();self.addCleanup(p.stop)
        auth=Mock();auth.status.return_value={'maintenance_state':'none'}
        auth.revalidate.side_effect=lambda *a,**kw:AuthSnapshot(service,'1'*64,'2'*64,time.time(),
            {'cookie':'synthetic=secret','x-addresscode':'HOME','x-addresskey':'KEY'},time.monotonic()+30)
        events=[]
        def wire(op,headers,deadline,*,response_observer):
            events.append(('wire',op.name,headers['x-experience']))
            response_observer(c.market.ResponseObservation('https://'+op.host+op.path,200,('synthetic=rotated',)))
            return response if response is not None else {'items':[],'offers':[],'count':0}
        flow=c.MarketplaceFlow(service,auth=auth,request=wire)
        return flow,auth,events

    def test_journal_precedes_cookie_retention_and_no_second_session_send(self):
        flow,auth,events=self.setup_flow()
        def retained(*args,**kwargs):
            self.assertEqual(c.journal.inspect(flow.flow_id)['operations'][0]['state'],'OBSERVED')
        auth.retain_response_cookies.side_effect=retained
        flow.session()
        with self.assertRaises(c.market.MarketplaceError):flow.session()
        self.assertEqual(events,[('wire','session','ecom')])
        self.assertEqual(c.journal.inspect(flow.flow_id)['reserved_minor'],0)

    def test_read_only_cart_never_claims_financial_flow(self):
        flow,auth,events=self.setup_flow('supermall')
        self.assertTrue(flow.cart()['empty'])
        self.assertEqual(events,[('wire','cart','rocket')])
        self.assertFalse(flow.opened)
        auth.retain_response_cookies.assert_called_once()

    def test_account_drift_and_unreviewed_financial_operation_prevent_wire(self):
        flow,auth,events=self.setup_flow()
        with self.assertRaises(c.market.MarketplaceError):flow.client.call('place',total=20)
        self.assertEqual(events,[])
        self.assertFalse(flow.opened)
        flow,auth,events=self.setup_flow()
        auth.revalidate.side_effect=lambda *a,**kw:AuthSnapshot('main','3'*64,'2'*64,time.time(),{},time.monotonic()+30)
        with self.assertRaises(c.market.MarketplaceError):flow.cart()
        self.assertEqual(events,[])

    def test_reviewed_synthetic_shape_place_and_payment_use_real_journal(self):
        from test import test_noon_marketplace_review as fixtures
        from noon_minutes_checkout import SavedCard
        fixture=fixtures.ReviewTests();fixture.setUp()
        flow,auth,events=self.setup_flow()
        flow.session()
        now=time.time()
        fixture.home.update(account_ref='1'*64,address_ref='2'*64,observed_at=now)
        flow.snapshot.checked_at=now
        flow.snapshot._headers.update({'x-addresscode':'home-code','x-addresskey':'home-key'})
        flow.last_cart=c.market.Response(c.market.operation('main','cart'),200,fixture.cart,now)
        flow.session_response=c.market.Response(c.market.operation('main','session'),200,fixture.session,now)
        flow.owned_offers=(('offer-1','vanilla',2),)
        flow.card=SavedCard('saved-token','****2342','mastercard')
        reviewed=flow.review_selected(manifest=fixture.manifest,expected_fees=(('shipping',250),),
            quiet_options=fixture.quiet,shape=fixture.shape)
        self.assertEqual(reviewed.payable_minor,2250)
        def wire(op,headers,deadline,*,response_observer):
            response_observer(c.market.ResponseObservation('https://'+op.host+op.path,200,()))
            return 'NORDER123' if op.name=='place' else {'status':'pending','clientSecret':'synthetic-intent'} if op.name=='order_status' else {'status':'payment_confirmed'}
        flow.client._request=wire
        flow.place_reviewed()
        flow.complete_existing_payment('NORDER123')
        state=c.journal.inspect(flow.flow_id)
        self.assertEqual(state['reserved_minor'],2250)
        self.assertEqual(state['order_id'],'NORDER123')
        self.assertEqual([x['kind'] for x in state['operations']],['quote','place','payment'])
        with self.assertRaises(c.market.MarketplaceError):flow.place_reviewed()


if __name__=='__main__':unittest.main()
