import time
import unittest
from unittest.mock import Mock,patch

import commerce_order_status as c
from noon_auth_lifecycle import AuthSnapshot
from noon_checkout import fingerprint
import noon_minutes_checkout as m
from test.test_noon_minutes_checkout import HEADERS


class ReadTests(unittest.TestCase):
    def test_failed_order_is_exact_read_only_and_cookies_are_retained(self):
        account=fingerprint('account');flow='10000000-0000-4000-8000-000000000001'
        binding={'flow_id':flow,'app':'noon','vertical':'minutes','account_hash':account,'scope_hash':'1'*64}
        auth=Mock();manager=auth.noon
        manager.status.return_value={'maintenance_state':'none'}
        manager.revalidate.return_value=AuthSnapshot('minutes',account,
            fingerprint(HEADERS['x-addresscode'],HEADERS['x-addresskey']),time.time(),HEADERS,time.monotonic()+30)
        def native(route,headers,deadline,payload,*,response_observer):
            self.assertEqual(route,'order_get');self.assertEqual(payload,{'orderNr':'IAEGA123'})
            response_observer(m.ResponseObservation('https://'+m.ROUTES[route][1]+m.ROUTES[route][2],200,('synthetic=cookie',)))
            return {'orderNr':'IAEGA123','statusCode':'failed','orderTotal':0}
        original=m.MinutesCheckout
        def client(*args,**kwargs):return original(*args,request=native,**kwargs)
        with patch.object(c.journal,'binding',return_value=binding), \
                patch.object(c.journal,'inspect',return_value={'order_id':'IAEGA123','state':'FENCED','reserved_minor':1725}), \
                patch.object(m,'MinutesCheckout',side_effect=client), \
                patch.object(c.journal,'consume',side_effect=AssertionError('no financial operation')):
            result=c.status(flow,auth=auth)
        self.assertEqual(result['raw_status'],'failed');self.assertFalse(result['financial_retry'])
        manager.retain_response_cookies.assert_called_once()
        self.assertEqual(result['reserved_minor'],1725)

    def test_wrong_account_rejected_before_order_read(self):
        auth=Mock();auth.noon.status.return_value={'maintenance_state':'none'}
        auth.noon.revalidate.return_value=Mock(account_ref='2'*64)
        with patch.object(c.journal,'binding',return_value={'app':'noon','vertical':'minutes','account_hash':'1'*64}), \
                patch.object(c.journal,'inspect',return_value={'order_id':'IAEGA123'}), \
                patch.object(m,'MinutesCheckout') as client:
            with self.assertRaisesRegex(c.journal.JournalError,'ACCOUNT_CHANGED'):c.status('unused',auth=auth)
        client.assert_not_called()

    def test_marketplace_status_uses_explicit_persisted_vertical_and_account(self):
        auth=Mock()
        with patch.object(c.journal,'binding',return_value={'app':'noon','vertical':'supermall','account_hash':'1'*64}), \
                patch.object(c.journal,'inspect',return_value={'order_id':'NORDER123','reserved_minor':2000,'state':'FENCED'}), \
                patch('commerce_marketplace.MarketplaceFlow') as factory:
            flow=factory.return_value;flow.account_hash='1'*64
            flow.client.order_status.return_value.summary.return_value={'state':'failed'}
            result=c.status('flow',auth=auth)
        factory.assert_called_once_with('supermall',auth=auth.noon)
        flow.client.order_status.assert_called_once_with('NORDER123')
        self.assertFalse(result['financial_retry'])


if __name__=='__main__':unittest.main()
