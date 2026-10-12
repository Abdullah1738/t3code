from pathlib import Path
from types import SimpleNamespace
import time
import unittest
from unittest.mock import Mock,patch
import commerce_reconcile as c
from noon_auth_lifecycle import AuthSnapshot
import noon_minutes_checkout as m


class DispositionTests(unittest.TestCase):
    def test_missing_owned_place_receipt_stops_before_auth_or_network(self):
        auth=Mock()
        with patch.object(c.journal,'binding',return_value={'app':'noon','vertical':'minutes'}), \
                patch.object(c.journal,'inspect',return_value={'order_id':'IAEGA123'}),patch.object(c.receipts,'load') as load:
            load.return_value.snapshot.return_value=SimpleNamespace(receipts=[])
            with self.assertRaisesRegex(c.journal.JournalError,'EXACT_PLACE_RECEIPT_REQUIRED'):
                c.reconcile('flow',auth=auth)
        auth.noon.status.assert_not_called()

    def test_failed_order_zero_total_and_failed_intent_never_release(self):
        flow='10000000-0000-4000-8000-000000000001'
        binding={'flow_id':flow,'app':'noon','vertical':'minutes','account_hash':'1'*64,'scope_hash':'2'*64}
        local={'order_id':'IAEGA123','state':'FENCED','reserved_minor':1725,'campaign_reserved_minor':5834,
               'operations':[{'kind':'place'}]}
        auth=Mock();auth.noon.status.return_value={'maintenance_state':'none'}
        auth.noon.revalidate.side_effect=lambda *a,**k:AuthSnapshot('minutes','1'*64,'2'*64,time.time(),{'cookie':'synthetic=x'},time.monotonic()+30)
        client=Mock()
        client.order_status.return_value=m.Snapshot({'orderTotal':0,'paymentIntentToken':'PRIVATE-INTENT'},
            {'order':'IAEGA123','raw_status':'failed','identity_echoed':True},time.time())
        client.payment_status.return_value=m.Snapshot({}, {'payment_status':'payment_failed','redirect_required':False},time.time())
        with patch.object(c.journal,'binding',return_value=binding),patch.object(c.journal,'inspect',return_value=local), \
                patch.object(c.receipts,'load') as load,patch.object(m,'MinutesCheckout',return_value=client), \
                patch.object(c.journal,'observe',side_effect=AssertionError('readonly')), \
                patch.object(c.journal,'consume',side_effect=AssertionError('no sends')):
            load.return_value.snapshot.return_value=SimpleNamespace(receipts=[SimpleNamespace(operation='place',order_id='IAEGA123')])
            result=c.reconcile(flow,auth=auth)
        self.assertEqual(result['liability'],'unresolved')
        self.assertFalse(result['reservation_release_allowed'])
        self.assertEqual(result['campaign_reserved_minor'],5834)
        self.assertNotIn('PRIVATE-INTENT',str(result))
        client.payment_status.assert_called_once_with(order='IAEGA123',client_secret='PRIVATE-INTENT',timeout=25)
        self.assertEqual(result['evidence'][1]['route'],'/_svc/mp-payment-api-public/paymentintent/status')

    def test_talabat_422_retains_exact_transaction_and_scope(self):
        import talabat_http_checkout as h
        from commerce_flow import account_hash
        saved={'expected_profile':{'id':77}}
        binding={'flow_id':'10000000-0000-4000-8000-000000000001','app':'talabat','vertical':'shops','account_hash':account_hash(saved),'scope_hash':'2'*64}
        local={'order_id':'12345','state':'FENCED','reserved_minor':4109,'campaign_reserved_minor':5834,'operations':[{'kind':'place'}]}
        auth=Mock();auth.fresh_before_mutation.return_value.mutation_account.return_value=saved
        with patch.object(c.journal,'binding',return_value=binding),patch.object(c.journal,'inspect',return_value=local), \
                patch.object(c.receipts,'load') as load,patch.object(h.orders,'request',return_value={}), \
                patch.object(h.orders,'project',return_value={'order':'12345','raw_status':'order_confirmingdelayed','status':'unknown','identity_verified':True,'account_verified':True}), \
                patch.object(h,'_wire',return_value=h.WireResponse(422,{'status':'Error','error':{}})) as wire:
            load.return_value.snapshot.return_value=SimpleNamespace(receipts=[SimpleNamespace(operation='place',order_id='12345',transaction_id='PRIVATE-TXN')])
            result=c.reconcile(binding['flow_id'],auth=auth)
        self.assertEqual(wire.call_args.args[2:4],('GET','/pay/v2/payment/status'))
        self.assertEqual(wire.call_args.kwargs['params']['encryptedTransactionId'],'PRIVATE-TXN')
        self.assertNotIn('PRIVATE-TXN',str(result))
        self.assertEqual(result['disposition'],'retain_fence_and_reservation')


if __name__=='__main__':unittest.main()
