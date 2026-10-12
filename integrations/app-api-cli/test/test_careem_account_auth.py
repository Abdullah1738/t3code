import base64
from contextlib import ExitStack
import copy
import hashlib
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import careem_account_auth as a

PHONE = '+971500000000'


def token(kind='CUSTOMER', sub='fixture', exp=None):
    p = {'kind': kind, 'sub': sub, 'exp': exp or time.time()+1000, 'azp': 'test-client'}
    return 'test.' + base64.urlsafe_b64encode(json.dumps(p).encode()).decode().rstrip('=') + '.test'


def context():
    return {'headers': {'authorization': 'Bearer '+token('GUEST'), 'provider-access-key': 'fixture',
                        'x-careem-device-id': 'fixture-device', 'user-agent': 'fixture-agent'},
            'device_id': 'fixture-device', 'client_id': 'test-client', 'client_secret': 'test-secret',
            'basic': 'Basic '+base64.b64encode(b'test-client:test-secret').decode()}


def challenge(name, options=None):
    inverse = {v:k for k,v in a.CHALLENGE_WIRE.items()}
    return {'additional_information': {'challenge': inverse[name],
            'challenge_details': [{'challenge_name': x.lower(), 'masked_value': 'private'} for x in options or []]}}


class AccountAuthTest(unittest.TestCase):
    def setUp(self):
        # Every external boundary is denied unless a test explicitly mocks it.
        stack = self.enterContext(ExitStack())
        for target in ['socket.socket.connect', 'socket.create_connection', 'subprocess.Popen']:
            stack.enter_context(patch(target, side_effect=AssertionError('EXTERNAL_ACCESS_DENIED')))
        for name in ['load', 'store', '_transport']:
            stack.enter_context(patch.object(a, name, side_effect=AssertionError('UNMOCKED_BOUNDARY')))

    def otp_flow(self):
        with patch.object(a, 'guest_context', return_value=context()):
            flow = a.Bootstrap(PHONE, mutate=True)
        flow.last_challenge = 'OTP'
        return flow

    def test_otp_acceptance_is_not_sms_delivery_and_wire_body_is_unchanged(self):
        flow = self.otp_flow()
        response = {'retry_in': 30, 'expires_in': 300, 'otp_length': 4, 'unknown': 'private'}
        with patch.object(a, 'http_request', side_effect=[(200, {}), (202, response)]) as request, \
                patch.object(a, 'solve_pow', return_value='pow:fixture:0'):
            result = flow.request_otp()
        self.assertEqual(result['stage'], 'otp_request_accepted')
        self.assertIs(result['acceptance_verified'], True)
        self.assertIs(result['delivery_verified'], False)
        self.assertEqual(result['retry_in'], 30)
        self.assertEqual(result['expires_in'], 300)
        self.assertEqual(result['otp_length'], 4)
        self.assertEqual(flow.otp_result, result)
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(request.call_args.args[2], {
            'client_id': 'test-client', 'identifier': PHONE, 'type': 'SMS',
            'locale': 'en', 'multiTimeUse': False, 'guard': 'pow:fixture:0'})
        with patch.object(a, 'http_request') as request:
            with self.assertRaises(a.AccountError):
                flow.request_otp()
            request.assert_not_called()

    def test_otp_response_requires_all_three_native_integer_fields(self):
        valid = {'retry_in': 30, 'expires_in': 300, 'otp_length': 4}
        invalid = []
        for key in valid:
            invalid.append({k: v for k, v in valid.items() if k != key})
            invalid.extend({**valid, key: value} for value in [None, True, '4', 4.0])
        invalid.extend({**valid, key: value} for key, value in [
            ('retry_in', -1), ('retry_in', 2**31), ('expires_in', 0),
            ('expires_in', 3601), ('otp_length', 3), ('otp_length', 9)])
        invalid.extend([None, [], 'private'])
        for response in invalid:
            with self.subTest(response=response):
                flow = self.otp_flow()
                with patch.object(a, 'http_request', side_effect=[(200, {}), (202, response)]), \
                        patch.object(a, 'solve_pow', return_value='pow:fixture:0'):
                    with self.assertRaises(a.AccountError):
                        flow.request_otp()
                self.assertIs(flow.otp_result['acceptance_verified'], False)
                self.assertIs(flow.otp_result['delivery_verified'], False)
                with patch.object(a, 'http_request') as request:
                    with self.assertRaises(a.AccountError):
                        flow.request_otp()
                    with self.assertRaises(a.AccountError):
                        flow.verify_otp('1234')
                    request.assert_not_called()

    def test_otp_202_error_envelope_never_counts_as_acceptance(self):
        for extra in [{'error': 'private'}, {'error_description': 'private'},
                      challenge('OTP'), {'additional_information': None}]:
            with self.subTest(extra=extra):
                flow = self.otp_flow()
                response = {'retry_in': 30, 'expires_in': 300, 'otp_length': 4, **extra}
                with patch.object(a, 'http_request', side_effect=[(200, {}), (202, response)]), \
                        patch.object(a, 'solve_pow', return_value='pow:fixture:0'):
                    with self.assertRaises(a.AccountError):
                        flow.request_otp()
                self.assertIs(flow.otp_result['acceptance_verified'], False)
                self.assertNotIn('private', json.dumps(flow.otp_result))

    def test_otp_non_202_has_redacted_diagnostic_and_never_retries(self):
        for status in [200, 400, 401, 403, 429, 500]:
            with self.subTest(status=status):
                flow = self.otp_flow()
                response = {'retry_in': 30, 'expires_in': 300, 'otp_length': 4,
                            'error_description': 'private', **challenge('OTP')}
                with patch.object(a, 'http_request', side_effect=[(200, {}), (status, response)]), \
                        patch.object(a, 'solve_pow', return_value='pow:fixture:0'):
                    with self.assertRaises(a.AccountError):
                        flow.request_otp()
                self.assertEqual(flow.otp_result['http_status'], status)
                self.assertIs(flow.otp_result['acceptance_verified'], False)
                self.assertNotIn('private', json.dumps(flow.otp_result))
                with patch.object(a, 'http_request') as request:
                    with self.assertRaises(a.AccountError):
                        flow.request_otp()
                    request.assert_not_called()

    def test_otp_expiry_does_not_gain_request_latency(self):
        flow = self.otp_flow()
        clock = [100.0]
        def request(route, *args, **kwargs):
            if route == 'pow':
                return 200, {}
            self.assertEqual(route, 'otp')
            clock[0] = 108.0
            return 202, {'retry_in': 0, 'expires_in': 5, 'otp_length': 4}
        with patch.object(a, 'http_request', side_effect=request), \
                patch.object(a, 'solve_pow', return_value='pow:fixture:0'), \
                patch.object(a.time, 'monotonic', side_effect=lambda: clock[0]):
            flow.request_otp()
            self.assertEqual(flow.otp_expires, 105.0)
            with self.assertRaisesRegex(a.AccountError, 'EXPIRED'):
                flow.verify_otp('1234')

    def test_otp_transport_timeout_retains_unknown_not_sent(self):
        flow = self.otp_flow()
        with patch.object(a, 'http_request', side_effect=[(200, {}), a.AccountError('HTTP_TIMEOUT')]), \
                patch.object(a, 'solve_pow', return_value='pow:fixture:0'):
            with self.assertRaises(a.AccountError):
                flow.request_otp()
        self.assertEqual(flow.otp_result, {'stage': 'otp_request_outcome_unknown',
            'acceptance_verified': False, 'delivery_verified': False})
        with patch.object(a, 'http_request') as request:
            with self.assertRaises(a.AccountError):
                flow.request_otp()
            with self.assertRaises(a.AccountError):
                flow.verify_otp('1234')
            request.assert_not_called()

    def test_new_login_invalidates_old_challenge_otp_and_publication_state(self):
        for outcome in [(500, {}), a.AccountError('HTTP_TIMEOUT'),
                        (400, challenge('PASSWORD')), (400, challenge('OTP'))]:
            with self.subTest(outcome=outcome):
                flow = self.otp_flow()
                flow.pending = challenge('TRY_ANOTHER_WAY', ['CARD'])
                flow.tokens = {'access_token': token(), 'refresh_token': 'fixture'}
                flow.otp_sent = True
                flow.otp_length = 4
                flow.otp_expires = time.monotonic()+300
                with patch.object(a, 'http_request', side_effect=[outcome]):
                    if isinstance(outcome, Exception) or outcome[0] == 500:
                        with self.assertRaises(a.AccountError):
                            flow.login()
                        self.assertIsNone(flow.last_challenge)
                        self.assertIsNone(flow.pending)
                    else:
                        flow.login()
                self.assertIsNone(flow.tokens)
                with patch.object(a, 'http_request') as request, patch.object(a, 'store') as store:
                    with self.assertRaises(a.AccountError):
                        flow.verify_otp('1234')
                    with self.assertRaises(a.AccountError):
                        flow.answer_challenge('CARD', '1234')
                    with self.assertRaises(a.AccountError):
                        flow.request_otp()
                    with self.assertRaises(a.AccountError):
                        flow.publish()
                    request.assert_not_called()
                    store.assert_not_called()

    def test_verification_requires_current_otp_challenge(self):
        flow = self.otp_flow()
        flow.otp_sent = True
        flow.otp_length = 4
        flow.otp_expires = time.monotonic()+300
        flow.last_challenge = 'PASSWORD'
        with patch.object(a, 'http_request') as request:
            with self.assertRaises(a.AccountError):
                flow.verify_otp('1234')
            request.assert_not_called()

    def test_actual_moshi_challenge_wire_names(self):
        self.assertEqual(a.challenge({'additional_information':{'challenge':'otp'}})['challenge'],'OTP')
        self.assertEqual(a.challenge({'additional_information':{'challenge':'existing_user_confirmed'}})['challenge'],
                         'RETURNING_USER_CONFIRMATION')
        self.assertEqual(a.challenge(challenge('TRY_ANOTHER_WAY',['CARD','EMAIL']))['options'],['CARD','EMAIL'])
        for value in ['OTP','returning_user_confirmation',None,{'type':'otp'},['otp']]:
            self.assertIsNone(a.challenge({'additional_information':{'challenge':value}}))

    def test_diagnostic_one_post_no_token_exchange_or_publication(self):
        raw = {**challenge('OTP'),'error_description':'private phone and token','token':'private'}
        with patch.object(a,'guest_context',return_value=context()),patch.object(a,'http_request',return_value=(400,raw)) as request,patch.object(a,'store') as store:
            flow=a.Bootstrap(PHONE,mutate=True)
            result=flow.login(diagnose_only=True)
            self.assertEqual(result['recognized_wire_challenge'],'otp')
            self.assertNotIn('private',json.dumps(result))
            self.assertEqual(request.call_count,1)
            store.assert_not_called()
        result=a.error_summary(400,{'error':'private','additional_information':{'challenge':'private-token','challenge_details':[{'challenge_name':'private','masked_value':'private'}]}})
        self.assertNotIn('private',json.dumps(result))

    def test_no_mutation_without_explicit_optin(self):
        with patch.object(a, '_transport') as transport:
            for name in ['login', 'otp', 'verify', 'token']:
                with self.assertRaisesRegex(a.AccountError, 'NOT_ENABLED'):
                    a.http_request(name, {}, {})
            transport.assert_not_called()

    def test_pow_sdk_contract_and_bounds(self):
        cfg = {'version': 1, 'algorithm': 'SHA-1', 'complexity': 2, 'timestamp': 123, 'seed': 'fixture'}
        guard = a.solve_pow(cfg)
        count = int(guard.rsplit(':',1)[1])
        self.assertTrue(hashlib.sha1(f'1:2:123:fixture:{count}'.encode()).hexdigest().startswith('00'))
        self.assertTrue(guard.startswith('pow:fixture:'))
        with self.assertRaises(a.AccountError):
            a.solve_pow({**cfg,'complexity':99})

    def test_guest_context_is_read_only_and_provenance_bound(self):
        c = context()
        saved = {'templates': {'GET identity.careem.com/userinfo': {
            'method':'GET','url':a.ROUTES['profile'][1],'headers':c['headers']}},
            'refresh_auth': {'authorization': c['basic']}}
        original = copy.deepcopy(saved)
        with patch.object(a, 'load', return_value=saved) as load, patch.object(a, 'store') as store:
            result = a.guest_context()
            self.assertEqual(result['client_id'], 'test-client')
            load.assert_called_once_with('careem')
            store.assert_not_called()
        self.assertEqual(saved, original)

    def test_owner_identity_required_before_publication(self):
        for profile in [{'kind':'GUEST','sub':'fixture','phone_number':PHONE},
                        {'kind':'CUSTOMER','sub':'other','phone_number':PHONE},
                        {'kind':'CUSTOMER','sub':'fixture','phone_number':'+971511111111'}]:
            with patch.object(a, 'http_request', return_value=(200,profile)), patch.object(a, 'store') as store:
                with self.assertRaises(a.AccountError):
                    a.verify_customer(token(), PHONE, {})
                store.assert_not_called()

    def test_server_verification_id_is_used_not_sms_and_guest_never_written(self):
        c = context(); codes=[]
        def request(route, headers, body=None, **kwargs):
            codes.append((route,copy.deepcopy(body)))
            if route=='login' and not body.get('otp'):return 400,challenge('OTP')
            if route=='pow':return 200,{'version':1,'algorithm':'SHA-1','complexity':0,'timestamp':1,'seed':'fixture'}
            if route=='otp':return 202,{'expires_in':120,'otp_length':4,'retry_in':30}
            if route=='verify':return 200,{'id':'server-verification-id','provider':'fixture'}
            if route=='login':return 200,{'token':'proof-only'}
            if route=='token':return 200,{'access_token':token(),'refresh_token':'new-refresh'}
            if route=='profile':return 200,{'kind':'CUSTOMER','sub':'fixture','phone_number':PHONE}
            raise AssertionError(route)
        with patch.object(a,'guest_context',return_value=c),patch.object(a,'http_request',side_effect=request),patch.object(a,'store') as store:
            flow=a.Bootstrap(PHONE,mutate=True)
            self.assertEqual(flow.login()['challenge'],'OTP')
            flow.request_otp()
            self.assertEqual(flow.verify_otp('1234')['stage'],'verified_customer')
            result=flow.publish()
            self.assertTrue(result['account_verified'])
            store.assert_called_once()
            self.assertEqual(store.call_args.args[0], 'careem-account')
            self.assertNotIn('authorization',store.call_args.args[1]['client']['headers'])
        self.assertEqual([b['otp'] for r,b in codes if r=='login' and b.get('otp')],['server-verification-id'])
        self.assertEqual(next(b for r,b in codes if r=='token')['grant_type'],'urn:careem:oauth2:grant_type:proof')

    def test_only_offered_card_challenge_and_single_attempt(self):
        with patch.object(a,'guest_context',return_value=context()):flow=a.Bootstrap(PHONE,mutate=True)
        flow.pending=challenge('TRY_ANOTHER_WAY',['EMAIL']);flow.last_challenge='TRY_ANOTHER_WAY'
        with patch.object(a,'http_request') as request:
            with self.assertRaisesRegex(a.AccountError,'NOT_OFFERED'):flow.answer_challenge('CARD','1234')
            request.assert_not_called()
        flow.pending=challenge('TRY_ANOTHER_WAY',['CARD'])
        with patch.object(flow,'login',return_value={'stage':'challenge'}) as login:
            flow.answer_challenge('CARD','1234')
            with self.assertRaises(a.AccountError):flow.answer_challenge('CARD','1234')
            login.assert_called_once()

    def test_ambiguous_otp_send_never_retries(self):
        with patch.object(a,'guest_context',return_value=context()):flow=a.Bootstrap(PHONE,mutate=True)
        flow.last_challenge='OTP'
        with patch.object(a,'http_request',side_effect=[(200,{'version':1,'algorithm':'SHA-1','complexity':0,'timestamp':1,'seed':'fixture'}),a.AccountError('HTTP_FAILED')]):
            with self.assertRaises(a.AccountError):flow.request_otp()
        with patch.object(a,'http_request') as request:
            with self.assertRaises(a.AccountError):flow.request_otp()
            request.assert_not_called()

    def test_refresh_preserves_rotation_but_does_not_publish_unverified_candidate(self):
        old={'account_verified':True,'auth':{'access_token':token(),'refresh_token':'old'},
             'identity':{'sub':'fixture','phone_number':PHONE},'client':context()}
        with patch.object(a,'load',return_value=old),patch.object(a,'http_request',return_value=(200,{
            'access_token':token(),'refresh_token':'rotated'})),patch.object(a,'verify_customer',side_effect=a.AccountError('HTTP_FAILED')),patch.object(a,'store') as store:
            with self.assertRaises(a.AccountError):a.refresh(mutate=True)
            store.assert_called_once()
            self.assertEqual(store.call_args.args[0],a.ACCOUNT)
            self.assertEqual(store.call_args.args[1]['auth']['refresh_token'],'old')
            self.assertEqual(store.call_args.args[1]['renewal_pending']['refresh_token'],'rotated')


if __name__=='__main__':unittest.main()
