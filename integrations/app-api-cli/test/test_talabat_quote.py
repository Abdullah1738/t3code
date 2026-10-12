import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import talabat_quote as q


def fixture():
    home = {k:'' for k in q.ADDRESS_KEYS}
    home.update(id='synthetic-address',country=4,country_code='971',suite='2104',
                area_id=1308,type=1,latitude=25.0778,longitude=55.1569)
    vendor = {'talabat_id':q.c.BRANCH,'global_id':'synthetic-vendor','chain_id':1,
              'vertical_type':1,'is_dark_store':True,'is_migrated':False}
    return home,vendor,{'paySupportsTPro':True}


def card_fixture():
    card = {'cardNumber':'****5542','CountryId':4,'isExpired':False,
            'isValidCard':True,'isForceCvv':False,'expireYear':'2099','expireMonth':'12',
            'token':'synthetic-token','tokenId':'synthetic-token-id'}
    config = {'supportedFeatures':{'paySupportsTPro':True},'paymentMethods':[{
        'isEnabled':True,'isSelected':False,'title':'Mastercard 5542',
        'supportedFeatures':{k:True for k in q.CARD_FEATURES},
        'events':{'payment':{'method':{'paymentMethod':2,'addTPayMethod':7},
                            'card':{'cardId':card['tokenId'],'binNumber':'123456',
                                    'cardFingerPrint':'synthetic-fingerprint'}}}}]}
    return config, card


class InitialQuoteTests(unittest.TestCase):
    def test_initial_map_preserves_native_nulls_country_quirk(self):
        body=q.initial_body(*fixture())
        self.assertEqual(body['addressV2']['country'],'971')
        self.assertEqual(body['addressV2']['country_code'],'971')
        self.assertEqual(body['countryCode'],'AE')
        self.assertEqual(set(body['addressV2']),set(q.ADDRESS_KEYS))
        self.assertEqual(body['selectedAddressId'],'synthetic-address')
        for key in ('paymentMethod','addTPayMethod','hasDues','binNumber','walletBalance',
                    'riderTipAmount','isCustomRiderTip','saveRiderTipForLater'):
            self.assertIsNone(body[key])
        self.assertIs(body['proSubscribeChecked'],False)
        self.assertNotIn('deliveryInstructions',body)
        self.assertNotIn('cardTokenId',body)

    def test_feature_override_denied(self):
        for bad in ({},{'paymentMethod':0},{'paySupportsTPro':1},{'paySupportsTPro':True,'hasDues':False}):
            h,v,_=fixture()
            with self.assertRaises(q.c.http.TalabatError): q.initial_body(h,v,bad)

    def test_wrong_address_types_country_home_denied(self):
        for k,value in [('country',1),('country_code','AE'),('suite','123'),('area_id',True),
                        ('latitude',float('nan')),('mobile_number',123),('id','')]:
            h,v,f=fixture(); h[k]=value
            with self.assertRaises(q.c.http.TalabatError): q.initial_body(h,v,f)

    def test_vendor_schema_denied(self):
        for k,value in [('talabat_id',1),('vertical_type',2),('is_migrated',None),('is_dark_store',False)]:
            h,v,f=fixture(); v[k]=value
            with self.assertRaises(q.c.http.TalabatError): q.initial_body(h,v,f)

    def test_cart_changed_denied(self):
        before={'id':'synthetic-cart','items':[{'product_id':q.c.QUEST,'quantity':1}],
                'subtotal_after_discount':20.25}
        self.assertTrue(q.require_current_cart(before,before)['sole_quest_quantity_one'])
        for path,value in [('id','other'),('items',[]),('subtotal_after_discount',0),('subtotal_after_discount',90)]:
            after=copy.deepcopy(before); after[path]=value
            with self.assertRaises(q.c.http.TalabatError): q.require_current_cart(before,after)

    def test_first_bad_manifest_denied(self):
        for item in ({'product_id':'other','quantity':1},{'product_id':q.c.QUEST,'quantity':2},
                     {'product_id':q.c.QUEST,'quantity':True}):
            cart={'id':'x','items':[item],'subtotal_after_discount':20.25}
            with self.assertRaises(q.c.http.TalabatError): q.require_current_cart(cart,cart)

    def test_post_exact_endpoint_consumes_before_send(self):
        with tempfile.TemporaryDirectory() as d:
            marker=Path(d)/'intent'; body=q.initial_body(*fixture())
            def send(req,deadline):
                self.assertEqual(marker.stat().st_mode & 0o777,0o600)
                self.assertEqual(json.loads(marker.read_text())['state'],'MAY_HAVE_SENT')
                self.assertEqual(req.get_method(),'POST')
                self.assertEqual(req.full_url,q.c.API+'/ccx/v1/checkout/synthetic%2Fcart')
                self.assertEqual(json.loads(req.data),body)
                self.assertNotIn('placeOrder',req.full_url)
                return {'checkout':{}}
            with patch.object(q,'INITIAL_INTENT',marker),patch.object(q.c.auth,'native_headers',return_value={}),patch.object(q,'_json_request',side_effect=send) as net:
                self.assertEqual(q.post_initial({'auth':{'access_token':'synthetic'}},'synthetic/cart',body,'00000000-0000-0000-0000-000000000001',time.monotonic()+30),{'checkout':{}})
                with self.assertRaises(q.c.http.TalabatError):
                    q.post_initial({'auth':{'access_token':'synthetic'}},'synthetic/cart',body,'00000000-0000-0000-0000-000000000001',time.monotonic()+30)
                self.assertEqual(net.call_count,1)

    def test_failed_post_keeps_consumed_intent(self):
        with tempfile.TemporaryDirectory() as d:
            marker=Path(d)/'intent'
            with patch.object(q,'INITIAL_INTENT',marker),patch.object(q.c.auth,'native_headers',return_value={}),patch.object(q,'_json_request',side_effect=RuntimeError('synthetic')) as net:
                with self.assertRaises(RuntimeError):
                    q.post_initial({'auth':{'access_token':'synthetic'}},'synthetic-cart',q.initial_body(*fixture()),'00000000-0000-0000-0000-000000000001',time.monotonic()+30)
                self.assertTrue(marker.exists()); self.assertEqual(net.call_count,1)

    def test_invalid_post_body_no_intent_or_io(self):
        for k,value in [('paymentMethod',2),('proSubscribeChecked',True),('hasDues',False),
                        ('quickCheckout',True),('selectedAddressId','wrong'),('deviceLatitude',0),
                        ('paySupportsTPro','true')]:
            with tempfile.TemporaryDirectory() as d:
                marker=Path(d)/'intent'; body=q.initial_body(*fixture()); body[k]=value
                with patch.object(q,'INITIAL_INTENT',marker),patch.object(q,'_json_request') as net:
                    with self.assertRaises(q.c.http.TalabatError):
                        q.post_initial({},'synthetic-cart',body,'00000000-0000-0000-0000-000000000001',time.monotonic()+30)
                    self.assertFalse(marker.exists()); net.assert_not_called()

    def test_consumed_observe_stops_before_account_read(self):
        with tempfile.TemporaryDirectory() as d:
            marker=Path(d)/'intent'; marker.touch()
            with patch.object(q,'INITIAL_INTENT',marker),patch.object(q.c.http,'account') as auth:
                with self.assertRaises(q.c.http.TalabatError): q.observe_initial('unused',send=True)
                auth.assert_not_called()

    def test_symlink_marker_denied(self):
        with tempfile.TemporaryDirectory() as d:
            marker=Path(d)/'intent'; marker.symlink_to(Path(d)/'missing')
            with patch.object(q,'INITIAL_INTENT',marker),patch.object(q.c.http,'account') as auth:
                with self.assertRaises(q.c.http.TalabatError): q.observe_initial('unused',send=True)
                auth.assert_not_called()

    def test_no_truthy_send(self):
        with patch.object(q.c.http,'account') as auth:
            with self.assertRaises(q.c.http.TalabatError): q.observe_initial('unused',send='yes')
            auth.assert_not_called()

    def test_explicit_cart_branch_contradiction_denied(self):
        good={'id':'synthetic-cart','items':[{'product_id':q.c.QUEST,'quantity':1}],
              'subtotal_after_discount':20.25}
        bad={**good,'branch_id':1}
        for before,after in ((good,bad),(bad,good),(bad,bad)):
            with self.assertRaises(q.c.http.TalabatError): q.require_current_cart(before,after)
        self.assertTrue(q.require_current_cart(good,good)['sole_quest_quantity_one'])

    def test_initial_body_json_type_substitution_denied(self):
        for key,value in [('verticalId',True),('branchId',float(q.c.BRANCH))]:
            body=q.initial_body(*fixture()); body[key]=value
            with patch.object(q,'_post_quote_once') as send:
                with self.assertRaises(q.c.http.TalabatError):
                    q.post_initial({},'cart',body,'00000000-0000-0000-0000-000000000001',time.monotonic()+30)
                send.assert_not_called()


class SelectedCardQuoteTests(unittest.TestCase):
    def test_card_native_mapping_no_token_or_wallet(self):
        h,v,_=fixture(); config,card=card_fixture()
        body=q.selected_card_body(h,v,config,card)
        self.assertEqual((body['paymentMethod'],body['addTPayMethod']),(2,7))
        self.assertEqual(body['binNumber'],'123456')
        self.assertEqual(body['cardFingerPrint'],'synthetic-fingerprint')
        self.assertIsNone(body['walletBalance'])
        self.assertIsNone(body['hasDues'])
        self.assertIs(body['proSubscribeChecked'],False)
        self.assertNotIn('cardTokenId',body)
        self.assertNotIn(card['tokenId'],json.dumps(body))
        self.assertEqual({k:body[k] for k in q.CARD_FEATURES},config['paymentMethods'][0]['supportedFeatures'])

    def test_wallet_selected_event_never_guessed_null(self):
        for selected in ({}, {'talabatPayConfig':{'balance':0}}, {'name':'unknown'}):
            h,v,_=fixture(); config,card=card_fixture()
            config['paymentMethods'][0]['events']['selected']=selected
            with self.assertRaises(q.c.http.TalabatError): q.selected_card_body(h,v,config,card)

    def test_token_not_tokenid_denied(self):
        h,v,_=fixture(); config,card=card_fixture()
        config['paymentMethods'][0]['events']['payment']['card']['cardId']=card['token']
        with self.assertRaises(q.c.http.TalabatError): q.selected_card_body(h,v,config,card)

    def test_default_postpaid_not_accepted(self):
        h,v,_=fixture(); config,card=card_fixture()
        config['paymentMethods'][0]['events']['payment']['method']['addTPayMethod']=11
        with self.assertRaises(q.c.http.TalabatError): q.selected_card_body(h,v,config,card)

    def test_ambiguous_card_denied(self):
        h,v,_=fixture(); config,card=card_fixture()
        config['paymentMethods'].append(copy.deepcopy(config['paymentMethods'][0]))
        with self.assertRaises(q.c.http.TalabatError): q.selected_card_body(h,v,config,card)

    def test_feature_override_denied(self):
        h,v,_=fixture(); config,card=card_fixture()
        config['paymentMethods'][0]['supportedFeatures']['hasDues']=False
        with self.assertRaises(q.c.http.TalabatError): q.selected_card_body(h,v,config,card)

    def test_changed_card_or_disabled_denied(self):
        for key,value in [('binNumber','unknown'),('cardFingerPrint','')]:
            h,v,_=fixture(); config,card=card_fixture()
            config['paymentMethods'][0]['events']['payment']['card'][key]=value
            with self.assertRaises(q.c.http.TalabatError): q.selected_card_body(h,v,config,card)
        h,v,_=fixture(); config,card=card_fixture(); config['paymentMethods'][0]['isEnabled']=False
        with self.assertRaises(q.c.http.TalabatError): q.selected_card_body(h,v,config,card)

    def test_card_operation_consumed_once_distinct_from_initial(self):
        h,v,_=fixture(); config,card=card_fixture(); body=q.selected_card_body(h,v,config,card)
        with tempfile.TemporaryDirectory() as d:
            marker=Path(d)/'card-intent'; initial=Path(d)/'initial'; initial.write_text('consumed')
            def send(req,deadline):
                self.assertEqual(json.loads(marker.read_text())['operation'],'selected_card_quote')
                self.assertEqual(initial.read_text(),'consumed')
                self.assertNotIn('placeOrder',req.full_url)
                self.assertEqual(json.loads(req.data),body)
                return {'checkout':{}}
            with patch.object(q,'CARD_INTENT',marker),patch.object(q,'INITIAL_INTENT',initial),patch.object(q.c.auth,'native_headers',return_value={}),patch.object(q,'_json_request',side_effect=send) as net:
                args=({'auth':{'access_token':'synthetic'}},'synthetic-cart',body,'00000000-0000-0000-0000-000000000001',time.monotonic()+30)
                kw=dict(home=h,vendor=v,config=config,saved_card=card)
                q.post_selected_card(*args,**kw)
                with self.assertRaises(q.c.http.TalabatError): q.post_selected_card(*args,**kw)
                self.assertEqual(net.call_count,1)

    def test_consumed_card_observe_no_io(self):
        with tempfile.TemporaryDirectory() as d:
            marker=Path(d)/'intent'; marker.touch()
            with patch.object(q,'CARD_INTENT',marker),patch.object(q,'observe_initial') as read:
                with self.assertRaises(q.c.http.TalabatError): q.observe_selected_card('unused',send=True)
                read.assert_not_called()

    def test_selected_body_json_type_substitution_denied(self):
        h,v,_=fixture(); config,card=card_fixture()
        for key,value in [('paymentMethod',2.0),('proSubscribeChecked',0),
                          ('isMigrated',1),('verticalId',True)]:
            body=q.selected_card_body(h,v,config,card); body[key]=value
            with patch.object(q,'_post_quote_once') as send:
                with self.assertRaises(q.c.http.TalabatError):
                    q.post_selected_card({},'cart',body,'00000000-0000-0000-0000-000000000001',
                        time.monotonic()+30,home=h,vendor=v,config=config,saved_card=card)
                send.assert_not_called()

    def test_payable_cart_branch_contradiction_no_post(self):
        h,v,_=fixture(); config,card=card_fixture()
        evidence={'home':h,'vendor':v,'saved':{},'saved_card':card,'cart_id':'cart',
                  'flow_id':'00000000-0000-0000-0000-000000000001','deadline':time.monotonic()+30}
        cart={'id':'cart','branch_id':1,'items':[{'product_id':q.c.QUEST,'quantity':1}],
              'subtotal_after_discount':20.25}
        with tempfile.TemporaryDirectory() as d:
            with patch.object(q,'REVIEW_INTENT',Path(d)/'intent'),\
                    patch.object(q,'observe_initial',return_value=evidence),\
                    patch.object(q,'payment_config',return_value=config),\
                    patch.object(q.c,'verticals_key',return_value='synthetic'),\
                    patch.object(q.c,'get_json',return_value=cart),\
                    patch.object(q,'_post_quote_once') as send:
                with self.assertRaises(q.c.http.TalabatError): q.observe_payable_review('unused',send=True)
                send.assert_not_called()


class QuoteProjectionTests(unittest.TestCase):
    def evidence(self):
        h,v,_=fixture(); config,card=card_fixture()
        return {'home':h,'cart_id':'synthetic-cart','body':q.selected_card_body(h,v,config,card),
                'response':{'tracking':{'cartId':'synthetic-cart'},
                    'branchInfo':{'country':{'id':4,'currencyCode':'AED'}},
                    'checkout':{'amount':'30.14','branchId':q.c.BRANCH,
                        'address':{'latitude':h['latitude'],'longitude':h['longitude'],
                                   'areaId':h['area_id'],'description':'synthetic-private-address 2104'},
                        'cart':{'items':[{'itemGuid':q.c.QUEST,'quantity':1,'price':'20.25','total':'20.25'}]},
                        'deliveryInstructions':{'instructions':[{'id':'synthetic-private-id',
                            'title':"Don't ring doorbell",'isSelected':True,'isEnabled':True}],
                            'saveForLater':{'isPreSaved':True}},
                        'paymentSummary':{'items':[{'type':k,'amount':v} for k,v in
                            [('SubTotal','20.25'),('DeliveryFee','8.99'),('ServiceFee','0.90'),('Total','30.14')]]}}}}

    def test_projection_bound_amounts_without_private_values(self):
        out=q.project_quote(self.evidence())
        self.assertTrue(out['current_cart_id_echo_matches'])
        self.assertTrue(out['one_quest_item_guid_matches'])
        self.assertTrue(out['charges_sum_matches'])
        self.assertTrue(out['amount_matches_summary'])
        self.assertFalse(out['ready_to_order'])
        text=json.dumps(out)
        for private in ('synthetic-cart','synthetic-private','synthetic-fingerprint',q.c.QUEST):
            self.assertNotIn(private,text)

    def test_wrong_or_partial_quote_cannot_pass(self):
        ev=self.evidence(); ev['response']['tracking']['cartId']='wrong'
        ev['response']['checkout']['paymentSummary']['items'].pop(1)
        out=q.project_quote(ev)
        self.assertFalse(out['current_cart_id_echo_matches'])
        self.assertFalse(out['charges_sum_matches'])
        self.assertFalse(out['ready_to_order'])

    def test_unknown_instruction_text_not_printed(self):
        ev=self.evidence(); ev['response']['checkout']['deliveryInstructions']['instructions'][0]['title']='private 123 contact'
        self.assertNotIn('private 123 contact',json.dumps(q.project_quote(ev)))

    def test_money_rejects_private_non_numeric_and_nonfinite(self):
        for val in ('a-private-ID',float('nan'),True,None,'1e3'):
            self.assertIsNone(q._money(val))

    def test_display_money_currency_label(self):
        self.assertEqual(q._display_money('AED 20.25'),'20.25')
        self.assertEqual(q._display_money('20.25 AED'),'20.25')
        self.assertIsNone(q._display_money('20.25 reduced from 25.00'))

    def test_tip_projection_numeric_states_only(self):
        out=q._tip_states({'options':[{'id':'private','amount':2,'isSelected':False}],
                           'title':'private free text','saveForLater':{'isPreSaved':True}})
        self.assertEqual(len(out),3)
        self.assertNotIn('private',json.dumps(out))

    def test_consumed_payable_review_no_io(self):
        with tempfile.TemporaryDirectory() as d:
            marker=Path(d)/'intent'; marker.touch()
            with patch.object(q,'REVIEW_INTENT',marker),patch.object(q,'observe_initial') as read:
                with self.assertRaises(q.c.http.TalabatError): q.observe_payable_review('unused',send=True)
                read.assert_not_called()

    def test_full_quiet_quote_is_review_only_never_order_ready(self):
        ev=self.evidence(); checkout=ev['response']['checkout']
        checkout['deliveryInstructions']['instructions']=[
            {'id':'synthetic-'+str(i),'title':title,'isSelected':selected,'isEnabled':True}
            for i,(title,selected) in enumerate([('Call on arrival',False),
                ("Don't ring doorbell",True),('Leave at my door',True)])]
        checkout['riderTips']={'options':[{'value':2,'isSelected':False}],
                                'saveTip':{'isSelected':True}}
        out=q.project_quote(ev)
        self.assertTrue(out['quiet_controls_verified'])
        self.assertTrue(out['quote_ready_for_review'])
        self.assertFalse(out['ready_to_order'])
        self.assertFalse(out['commit_enabled'])
        checkout['riderTips']['options'][0]['isSelected']=True
        self.assertFalse(q.project_quote(ev)['quote_ready_for_review'])

    def test_extra_selected_instruction_blocks_quiet_claim(self):
        ev=self.evidence()
        ev['response']['checkout']['deliveryInstructions']['instructions'].append(
            {'id':'second','title':'Call on arrival','isSelected':True,'isEnabled':True})
        self.assertFalse(q.project_quote(ev)['quiet_controls_verified'])

    def test_preference_flags_cannot_enter_selected_card_body(self):
        h,v,_=fixture(); config,card=card_fixture()
        for key in ('saveDeliveryInstructionsForLater','driverNotes','riderNote','cardTokenId'):
            body=q.selected_card_body(h,v,config,card); body[key]='not-allowed'
            with patch.object(q,'_post_quote_once') as send:
                with self.assertRaises(q.c.http.TalabatError):
                    q.post_selected_card({},'cart',body,'00000000-0000-0000-0000-000000000001',
                        time.monotonic()+30,home=h,vendor=v,config=config,saved_card=card)
                send.assert_not_called()

    def test_alphabetic_private_labels_and_tip_keys_not_exposed(self):
        ev=self.evidence()
        ev['response']['checkout']['deliveryInstructions']['instructions'][0]['title']='Private Person'
        ev['response']['checkout']['riderTips']={'PrivatePerson':{'isSelected':True}}
        text=json.dumps(q.project_quote(ev))
        self.assertNotIn('Private Person',text)
        self.assertNotIn('PrivatePerson',text)

    def test_negative_or_unknown_display_money_rejected(self):
        for value in ('AED -20.25','-20.25 AED','AED −20.25','(20.25) AED',
                      'USD 20.25','private 20.25','20.25 private'):
            with self.subTest(value=value): self.assertIsNone(q._display_money(value))

    def test_unit_is_complete_token(self):
        for description in ('Unit 12104','Unit 21040','Unit A2104','Unit 2104B'):
            ev=self.evidence(); ev['response']['checkout']['address']['description']=description
            with self.subTest(description=description):
                self.assertFalse(q.project_quote(ev)['home_unit_in_description'])


if __name__=='__main__': unittest.main()
