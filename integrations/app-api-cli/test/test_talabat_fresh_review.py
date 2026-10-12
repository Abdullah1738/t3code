import copy
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import talabat_fresh_review as r
from test import test_talabat_place_contract as fixtures


def snapshot():
    data = fixtures.draft_inputs()
    profile = {'id':123, 'mobile_country_code':'971', 'mobile_number':'500000000'}
    home = {**data['home'], 'cust_id':123, 'profile_name':'Banyantree', 'delivery_instructions':[]}
    cart = {'id':data['cart_id'], 'branch_id':r.q.c.BRANCH,
            'items':[{'product_id':r.q.c.QUEST, 'quantity':1}], 'subtotal_after_discount':20.25}
    return {'expected_profile':profile, 'profile':copy.deepcopy(profile),
            'addresses':{'has_error':False, 'result':[home]}, 'cards':{'data':[data['saved_card']]},
            'vendor':{'vendor':data['vendor']}, 'cart_before':cart, 'cart_after':copy.deepcopy(cart),
            'payment_config':data['config'], 'config_amount':'30.14',
            'quote':data['quote'], 'quote_body':data['quote_body'], 'payment_requirement':None}


def freeze(data=None, *, wall=1000, mono=2000, elapsed=5, ttl=120):
    return r.build_review(snapshot() if data is None else data, observed_at=wall, now=wall+elapsed,
                          started_monotonic=mono, now_monotonic=mono+elapsed, ttl=ttl)


def acknowledgement(value, at=1006):
    return r.bind_acknowledgement(value, {'decision':'approve_exact_review', 'digest':value.digest},
                                  now=at, now_monotonic=at+1000)


class FreshReviewTests(unittest.TestCase):
    def test_full_local_bundle_derives_journal_shape_without_io(self):
        frozen = freeze()
        review = json.loads(frozen._review)
        self.assertEqual(set(review['bindings']), r.journal.BINDINGS)
        self.assertEqual(r.journal.review_digest(review), frozen.digest)
        self.assertEqual(review['payable_minor'],3014)
        safe = r.project_review(frozen, now=1005, now_monotonic=2005)
        self.assertEqual(safe['card_last4'],'5542')
        self.assertEqual(safe['quantity'],1)
        self.assertTrue(safe['local_consistency_verified'])
        for key in ('owner_authorization_verified','fresh_server_provenance_verified',
                    'payment_completion_verified','server_price_lock_verified','ready_to_order','commit_enabled'):
            self.assertIs(safe[key],False)

    def test_detached_no_raw_private_material(self):
        data = snapshot(); before=copy.deepcopy(data); frozen=freeze(data)
        self.assertEqual(data,before)
        text=repr(frozen)+frozen._review.decode()+json.dumps(r.project_review(frozen,now=1005,now_monotonic=2005))
        for value in ('500000000','synthetic-address','synthetic-token','synthetic-fingerprint',data['cart_after']['id']):
            self.assertNotIn(value,text)
        data['quote']['checkout']['amount']='49.00'
        self.assertEqual(r.project_review(frozen,now=1005,now_monotonic=2005)['payable_minor'],3014)

    def test_snapshot_requires_complete_exact_keys_not_historical_projection(self):
        for missing in r.KEYS:
            data=snapshot();data.pop(missing)
            with self.subTest(missing=missing),self.assertRaises(r.q.c.http.TalabatError):freeze(data)
        for data in ({'quote_ready_for_review':True}, {**snapshot(),'authorized':True}):
            with self.assertRaises(r.q.c.http.TalabatError):freeze(data)

    def test_account_profile_type_exact_and_home_customer_binding(self):
        for kind in ('bool','float','different','empty','no-country','home-customer','unknown-profile-key'):
            data=snapshot()
            if kind=='bool':data['profile']['id']=True
            elif kind=='float':data['profile']['id']=123.0
            elif kind=='different':data['profile']['id']=124
            elif kind=='empty':data['expected_profile']={}
            elif kind=='no-country':data['expected_profile']['mobile_country_code']=''
            elif kind=='home-customer':data['addresses']['result'][0]['cust_id']=124
            else:data['expected_profile']['arbitrary']='private'
            with self.subTest(kind=kind),self.assertRaises(r.q.c.http.TalabatError):freeze(data)

    def test_account_fence_hash_stable_across_phone_change(self):
        old=freeze();data=snapshot()
        data['expected_profile']['mobile_number']=data['profile']['mobile_number']='511111111'
        new=freeze(data)
        a,b=json.loads(old._review),json.loads(new._review)
        self.assertEqual(a['bindings']['account'],b['bindings']['account'])
        self.assertNotEqual(old.digest,new.digest)

    def test_saved_home_card_vendor_all_revalidated(self):
        for kind in ('home','card','vendor','cvv','wallet'):
            data=snapshot()
            if kind=='home':data['addresses']['result'][0]['suite']='12104'
            elif kind=='card':data['cards']['data'][0]['cardNumber']='****1111'
            elif kind=='vendor':data['vendor']['vendor']['talabat_id']=1
            elif kind=='cvv':data['payment_requirement']='ForceCVV'
            else:data['payment_config']['paymentMethods'][0]['events']['selected']={'talabatPayConfig':{'balance':0}}
            with self.subTest(kind=kind),self.assertRaises(r.q.c.http.TalabatError):freeze(data)

    def test_cart_identity_and_all_item_fields_stable_before_after(self):
        for key,value in (('id','different'),('items',[]),('subtotal_after_discount',20)):
            data=snapshot();data['cart_after'][key]=value
            with self.assertRaises(r.q.c.http.TalabatError):freeze(data)
        data=snapshot();data['cart_after']['items'][0]['quantity']=1.0
        with self.assertRaises(r.q.c.http.TalabatError):freeze(data)
        data=snapshot();data['cart_before']['subtotal_after_discount']=20
        data['cart_after']['subtotal_after_discount']=20.0
        with self.assertRaises(r.q.c.http.TalabatError):freeze(data)

    def test_cart_subtotal_and_config_request_amount_match_quote(self):
        for kind in ('subtotal','config','bool','unknown'):
            data=snapshot()
            if kind=='subtotal':
                data['cart_before']['subtotal_after_discount']=data['cart_after']['subtotal_after_discount']=19.25
            else:data['config_amount']={'config':20.25,'bool':True,'unknown':None}[kind]
            with self.subTest(kind=kind),self.assertRaisesRegex(r.q.c.http.TalabatError,'AMOUNT_CONTEXT'):freeze(data)

    def test_original_prepare_body_required(self):
        data=snapshot();data['quote_body']['paymentMethod']=None
        with self.assertRaises(r.q.c.http.TalabatError):freeze(data)

    def test_review_starts_before_oldest_observation_not_at_build(self):
        with self.assertRaisesRegex(r.q.c.http.TalabatError,'STALE'):freeze(elapsed=120)
        with self.assertRaisesRegex(r.q.c.http.TalabatError,'STALE'):freeze(elapsed=-1)

    def test_wallclock_rollback_forward_and_monotonic_skew_stop(self):
        for now,mono in ((999,2005),(1005,1999),(1005,2121),(1010,2005),(1005,2010)):
            with self.subTest(now=now,mono=mono),self.assertRaises(r.q.c.http.TalabatError):
                r.build_review(snapshot(),observed_at=1000,now=now,started_monotonic=2000,now_monotonic=mono)

    def test_ttl_and_clock_types_strict(self):
        for ttl in (0,121,True,120.0):
            with self.assertRaises(r.q.c.http.TalabatError):freeze(ttl=ttl)
        for wall in (True,0,float('nan'),float('inf')):
            with self.assertRaises(r.q.c.http.TalabatError):freeze(wall=wall)

    def test_local_approval_matches_but_never_grants_send_permission(self):
        old=freeze();current=freeze(wall=1010,mono=2010)
        out=r.check_approval_binding(old,current,acknowledgement(old),now=1015,now_monotonic=2015)
        self.assertTrue(out['approval_binding_matches'])
        self.assertFalse(out['owner_authorization_verified'])
        self.assertFalse(out['commit_enabled'])
        self.assertNotEqual(old.digest,current.digest)

    def test_approval_requires_exact_digest_decision_and_timestamp(self):
        old=freeze()
        for key,value in (('digest','0'*64),('decision','okay'),('approved_at',999),
                          ('approved_at',1007),('approved_at',True)):
            with self.subTest(key=key,value=value),self.assertRaises(r.q.c.http.TalabatError):
                if key=='approved_at':
                    ack=acknowledgement(old,at=value)
                else:
                    data={'decision':'approve_exact_review','digest':old.digest};data[key]=value
                    ack=r.bind_acknowledgement(old,data,now=1006,now_monotonic=2006)
                r.check_approval_binding(old,old,ack,now=1006,now_monotonic=2006)

    def test_general_go_ahead_is_not_exact_review_acknowledgement(self):
        old=freeze()
        for ack in (True,'okay',{}, {'approved':True},
                    {'decision':'approve_exact_review','digest':old.digest,'authorized':True}):
            with self.assertRaises(r.q.c.http.TalabatError):
                r.bind_acknowledgement(old,ack,now=1006,now_monotonic=2006)

    def test_new_quote_cannot_extend_old_approval_lifetime(self):
        old=freeze();new=freeze(wall=1115,mono=2115,elapsed=1)
        with self.assertRaisesRegex(r.q.c.http.TalabatError,'STALE'):
            r.check_approval_binding(old,new,acknowledgement(old),now=1120,now_monotonic=2120)

    def test_earlier_revalidation_rejected(self):
        old=freeze();earlier=freeze(wall=999,mono=1999)
        with self.assertRaisesRegex(r.q.c.http.TalabatError,'CHANGED'):
            r.check_approval_binding(old,earlier,acknowledgement(old),now=1006,now_monotonic=2006)

    def test_revalidation_must_start_after_exact_approval(self):
        old=freeze();early=freeze(wall=1004,mono=2004,elapsed=1)
        for current in (old,early):
            with self.assertRaisesRegex(r.q.c.http.TalabatError,'POST_APPROVAL'):
                r.check_approval_binding(old,current,acknowledgement(old),now=1010,now_monotonic=2010)

    def test_clock_correction_cannot_make_preapproval_read_postapproval(self):
        old=freeze();early=freeze(wall=1007,mono=2006,elapsed=.25)
        ack=acknowledgement(old,at=1006.5)
        with self.assertRaisesRegex(r.q.c.http.TalabatError,'POST_APPROVAL'):
            r.check_approval_binding(old,early,ack,now=1008,now_monotonic=2008)

    def test_acknowledgement_process_and_monotonic_binding(self):
        old=freeze();current=freeze(wall=1010,mono=2010);ack=acknowledgement(old)
        for changed in (replace(ack,_epoch=object()),replace(ack,approved_monotonic=2001),
                        replace(ack,approved_at=1001),replace(ack,digest='0'*64),ack.__dict__):
            with self.assertRaises(r.q.c.http.TalabatError):
                r.check_approval_binding(old,current,changed,now=1015,now_monotonic=2015)
        with self.assertRaises(r.q.c.http.TalabatError):
            r.bind_acknowledgement(old,{'decision':'approve_exact_review','digest':old.digest},
                                   now=1006,now_monotonic=1999)

    def test_changed_bindings_even_same_total_require_reapproval(self):
        old=freeze()
        for kind in ('home','card','cart','instructions','fees','quote','vendor'):
            data=snapshot()
            if kind=='home':
                data['addresses']['result'][0]['extra_directions']='new private detail'
                data['quote_body']['addressV2']['extra_directions']='new private detail'
            elif kind=='card':data['cards']['data'][0]['token']='changed-private-token'
            elif kind=='cart':
                for k in ('cart_before','cart_after'):data[k]['items'][0]['stock']=2
            elif kind=='instructions':
                data['quote']['checkout']['deliveryInstructions']['instructions'][1]['id']='new-private-instruction'
            elif kind=='fees':
                rows=data['quote']['checkout']['paymentSummary']['items']
                for row in rows:
                    if row['type']=='DeliveryFee':row['amount']='8.00'
                    if row['type']=='ServiceFee':row['amount']='1.89'
            elif kind=='quote':data['quote']['unclassified']={'changed':'metadata'}
            else:data['vendor']['vendor']['global_id']='new-private-vendor'
            new=freeze(data,wall=1010,mono=2010)
            with self.subTest(kind=kind),self.assertRaisesRegex(r.q.c.http.TalabatError,'CHANGED'):
                r.check_approval_binding(old,new,acknowledgement(old),now=1015,now_monotonic=2015)

    def test_process_restart_or_tampered_fields_rejected(self):
        old=freeze()
        for new in (replace(old,_epoch=object()),replace(old,_review=b'{}'),
                    replace(old,_display=b'{"private":"leak"}'),replace(old,digest='0'*64),
                    replace(old,expires_at=9999),replace(old,_started_monotonic=1999)):
            with self.assertRaises(r.q.c.http.TalabatError):r.project_review(new,now=1006,now_monotonic=2006)

    def test_json_nonfinite_nonstring_keys_and_excess_depth_block(self):
        for value in (float('nan'),{1:'private'},set(),{'deep':[[[[float('inf')]]]]}):
            data=snapshot();data['quote']['unknown']=value
            with self.assertRaises(r.q.c.http.TalabatError):freeze(data)

    def test_malformed_private_input_diagnostic_does_not_leak(self):
        for key in ('cards','addresses','vendor','cart_before','quote'):
            data=snapshot();data[key]='secret-example'
            with self.assertRaises(r.q.c.http.TalabatError) as error:freeze(data)
            self.assertNotIn('secret-example',str(error.exception))

    def test_projection_detached_and_repeatable(self):
        frozen=freeze();a=r.project_review(frozen,now=1005,now_monotonic=2005)
        a['charges'][0]['amount']='999.00'
        self.assertNotEqual(a,r.project_review(frozen,now=1005,now_monotonic=2005))

    def test_no_auth_network_journal_or_live_enabling(self):
        with patch.object(r.q.c.http,'account',side_effect=AssertionError('auth')), \
                patch.object(r.q,'_json_request',side_effect=AssertionError('http')), \
                patch.object(r.journal,'consume',side_effect=AssertionError('journal')):
            frozen=freeze()
            r.project_review(frozen,now=1005,now_monotonic=2005)
            current=freeze(wall=1010,mono=2010)
            r.check_approval_binding(frozen,current,acknowledgement(frozen),now=1015,now_monotonic=2015)
            with self.assertRaises(r.q.c.http.TalabatError):r.require_live_review_enabled()
            with self.assertRaises(r.q.c.http.TalabatError):r.place.require_submission_enabled()

    def test_synthetic_review_to_journal_to_pending_never_releases_fence(self):
        # Test-only composition; production exposes no consume/send adapter.
        old=freeze();current=freeze(wall=1010,mono=2010)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(r.journal,'ROOT',Path(directory)/'journal'), \
                patch.object(r.journal.time,'time',return_value=1015):
            r.check_approval_binding(old,current,acknowledgement(old),now=1015,now_monotonic=2015)
            operation=r.journal.consume(json.loads(old._review),old.digest)
            observation=r.place.parse_response(200,fixtures.response())
            safe=r.place.project_response(observation)
            r.journal.record_observation(operation['operation'],safe['state'],r._hash('observation',safe))
            with self.assertRaisesRegex(r.q.c.http.TalabatError,'ALREADY_FENCED'):
                r.journal.consume(json.loads(current._review),current.digest)

    def test_same_account_new_phone_cart_review_cannot_bypass_consumed_fence(self):
        old=freeze();data=snapshot()
        data['profile']['mobile_number']=data['expected_profile']['mobile_number']='511111111'
        for key in ('cart_before','cart_after'):data[key]['id']='new-synthetic-cart'
        data['quote']['tracking']['cartId']='new-synthetic-cart'
        new=freeze(data)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(r.journal,'ROOT',Path(directory)/'journal'), \
                patch.object(r.journal.time,'time',return_value=1015):
            r.journal.consume(json.loads(old._review),old.digest)
            with self.assertRaisesRegex(r.q.c.http.TalabatError,'ALREADY_FENCED'):
                r.journal.consume(json.loads(new._review),new.digest)

    def test_every_post_send_result_keeps_permanent_fence(self):
        cases=[(None,None),(200,{}),(401,{}),(409,{}),(500,{}),(200,fixtures.response()),
               (400,{'duplicateOrderError':{}}),(200,{'smsVerificationError':{}}),
               (200,{'placedOrder':{'orderId':'1234567890','transactionId':'synthetic',
                                    'redirectUrl':'https://private.invalid'}})]
        for status,body in cases:
            with self.subTest(status=status,body=body),tempfile.TemporaryDirectory() as directory, \
                    patch.object(r.journal,'ROOT',Path(directory)/'journal'), \
                    patch.object(r.journal.time,'time',return_value=1015):
                frozen=freeze()
                operation=r.journal.consume(json.loads(frozen._review),frozen.digest)
                safe=r.place.project_response(r.place.parse_response(status,body))
                r.journal.record_observation(operation['operation'],safe['state'],r._hash('observation',safe))
                self.assertFalse(safe['retry_allowed'])
                self.assertFalse(safe['payment_completion_verified'])
                with self.assertRaisesRegex(r.q.c.http.TalabatError,'ALREADY_FENCED'):
                    r.journal.consume(json.loads(frozen._review),frozen.digest)


if __name__=='__main__':unittest.main()
