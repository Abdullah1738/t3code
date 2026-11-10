import unittest
import noon_http_orders as n
import delivery_cards as cards
import order_tracker as tracker
import native_orders
from unittest.mock import patch


class MarketplaceStageTests(unittest.TestCase):
    def test_manifest_sibling_participates_in_aggregate(self):
        scoped={'status':'out for delivery','eta':'2026-11-07T16:00:00+00:00','eta_text':'Arriving 1 Hr',
                'shipments':[{'status':'out for delivery','scope':'shipment','shipment_id':'N1-S1','eta':'2026-11-07T16:00:00+00:00'}]}
        manifest={'items':[{'status':'placed','scope':'item','item_id':'N1-2','shipment_id':'N1-S2'}]}
        with patch.object(n,'track',return_value=scoped), patch('noon_vertical_reads.track',return_value=manifest):
            result=native_orders.noon_marketplace_track('N1',10)
        self.assertEqual(result['status'],'placed')
        self.assertFalse(result['whole_order_complete'])
        self.assertIsNone(result['eta']);self.assertIsNone(result['eta_text'])

    def test_marketplace_card_rejects_ambiguous_countdown(self):
        data={'eta_text':'Arriving tomorrow in 1 Hr','checked_at':'2026-11-07T12:00:00+00:00'}
        self.assertIsNone(cards.eta(data,{'app':'noon','order':'N1','vertical':'marketplace'})[2])

    def test_lifecycle_and_formatting(self):
        expected={'processing':'pending confirmation','confirmed':'placed','packed':'packed',
                  'shipped':'picked up','out_for_delivery':'out for delivery',
                  'delivered':'delivered','cancelled':'cancelled'}
        for raw, stage in expected.items():
            for value in (raw,raw.upper(),raw.replace('_','-'),raw.replace('_',' ')):
                self.assertEqual(n.marketplace_stage(value),stage)
        for raw in ('not_delivered','will_be_cancelled','future_status',None):
            self.assertEqual(n.marketplace_stage(raw),'unknown')

    def test_mixed_shipments_never_invent_whole_terminal(self):
        self.assertEqual(n.marketplace_active_stage(['delivered','placed']),'placed')
        self.assertEqual(n.marketplace_active_stage(['picked up','placed']),'placed')
        self.assertEqual(n.marketplace_active_stage(['out for delivery','cancelled']),'out for delivery')
        self.assertEqual(n.marketplace_active_stage(['delivered','cancelled']),'unknown')
        self.assertEqual(n.marketplace_active_stage(['unknown','packed']),'unknown')

    def test_relative_eta_is_anchored_and_future_timeline_ignored(self):
        data={'orderNr':'N1','shipmentNr':'N1-S1','deliveryMessage':'Arriving 1 Hr 35 Mins',
              'timeline':[{'label':'Delivered','status':None},{'status':{'highStatusCode':'confirmed'}}]}
        result=n.shipment_track(data,'N1','N1-S1')
        self.assertEqual(result['status'],'placed')
        observed=n.dt.datetime.fromisoformat(result['eta_observed_at'])
        self.assertEqual(n.dt.datetime.fromisoformat(result['eta'])-observed,n.dt.timedelta(minutes=95))
        first=cards.eta(result,{})[2]
        result['checked_at']='2099-01-01T00:00:00+00:00'
        self.assertEqual(cards.eta(result,{})[2],first)

    def test_known_mixed_evidence_does_not_claim_no_status_evidence(self):
        now=10000
        cfg={'app':'noon','order':'N1','for':'owner','registered_at':tracker.stamp(100),'placed_at':tracker.stamp(100),'eta':None}
        state={'primed':True,'status':'unknown'}
        events=tracker.transition({'status':'unknown','errors':[],'status_evidence_available':True},state,cfg,now)
        self.assertFalse(any(e['kind']=='tracking_problem' for e in events))


if __name__=='__main__':unittest.main()
