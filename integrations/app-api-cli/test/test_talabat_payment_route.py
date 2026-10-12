import copy
import json
import unittest
from unittest.mock import patch

import talabat_payment_route as route
from test import test_talabat_place_contract as fixtures


def inputs():
    original = fixtures.draft_inputs()
    data = {key:original[key] for key in ('home', 'vendor', 'config', 'saved_card')}
    event = data['config']['paymentMethods'][0]['events']['payment']
    event.update(platform='talabat', platformType='sync')
    event['method'].update(paymentMethodName='synthetic-card', addTPayMethodName='synthetic-saved')
    return data


def event(data):
    return data['config']['paymentMethods'][0]['events']['payment']


class PaymentRouteTests(unittest.TestCase):
    def test_complete_seven_key_native_candidate_only(self):
        data = inputs(); before = copy.deepcopy(data)
        draft = route.selected_payment_event(**data)
        self.assertEqual(set(draft), route.EVENT_KEYS)
        self.assertEqual(draft['card']['cardId'], data['saved_card']['tokenId'])
        self.assertNotEqual(draft['card']['cardId'], data['saved_card']['token'])
        self.assertEqual(draft['method']['paymentMethod'], 2)
        for key in ('routingCriteria', 'paymentStatusPullingInterval', 'instrumentId'):
            self.assertIsNone(draft[key])
        self.assertEqual(data, before)
        draft['card']['cardId'] = 'changed'
        self.assertEqual(data, before)

    def test_no_native_platform_or_type_default(self):
        for key, values in (('platform', (None, '', 'hyperPay', 'benefitPay', 'Talabat', False, {})),
                            ('platformType', (None, '', 'async', 'Sync', False, {}))):
            for value in values:
                data = inputs(); event(data)[key] = value
                with self.subTest(key=key, value=value), self.assertRaises(route.q.c.http.TalabatError):
                    route.selected_payment_event(**data)
            data = inputs(); event(data).pop(key)
            with self.assertRaises(route.q.c.http.TalabatError): route.selected_payment_event(**data)

    def test_raw_precheck_cannot_hide_behind_separate_none_requirement(self):
        for value in ({'name':'ForceCVV'}, {'name':'unknown'}, {}, False, '', 0):
            data = inputs(); data['config']['paymentMethods'][0]['events']['prePayment'] = value
            with self.subTest(value=value), self.assertRaisesRegex(route.q.c.http.TalabatError, 'CVV|PRECHECK'):
                route.selected_payment_event(**data)

    def test_wallet_mixed_unknown_modes_all_rejected(self):
        for value in ('wallet', 'mixed', 'card', 'single', '', False, 0, {}):
            data = inputs(); data['config']['paymentMethods'][0]['paymentMode'] = value
            with self.subTest(value=value), self.assertRaises(route.q.c.http.TalabatError):
                route.selected_payment_event(**data)

    def test_auxiliary_even_falsy_events_stop(self):
        for key in ('selected', 'postPayment'):
            for value in ({}, False, '', 0):
                data = inputs(); data['config']['paymentMethods'][0]['events'][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(route.q.c.http.TalabatError):
                    route.selected_payment_event(**data)

    def test_explicit_null_events_and_mode_supported(self):
        data = inputs(); row = data['config']['paymentMethods'][0]
        row['paymentMode'] = None
        row['events'].update(prePayment=None, selected=None, postPayment=None)
        self.assertEqual(route.selected_payment_event(**data)['platform'], 'talabat')

    def test_method_names_and_numeric_types_required(self):
        for key in route.METHOD_KEYS:
            data = inputs(); event(data)['method'].pop(key)
            with self.subTest(key=key), self.assertRaises(route.q.c.http.TalabatError):
                route.selected_payment_event(**data)
        for key, value in (('paymentMethod', 2.0), ('addTPayMethod', 7.0),
                           ('paymentMethodName', ''), ('addTPayMethodName', ' '),
                           ('paymentMethodName', 'secret\nname')):
            data = inputs(); event(data)['method'][key] = value
            with self.assertRaises(route.q.c.http.TalabatError): route.selected_payment_event(**data)

    def test_extras_do_not_sneak_into_serialization(self):
        for where in ('event', 'method', 'card', 'events'):
            data = inputs(); target = event(data)
            if where in ('method', 'card'): target = target[where]
            if where == 'events': target = data['config']['paymentMethods'][0]['events']
            target['future'] = {'private':'example'}
            with self.subTest(where=where), self.assertRaises(route.q.c.http.TalabatError):
                route.selected_payment_event(**data)

    def test_no_instrument_or_polling_even_empty(self):
        for key in ('instrumentId', 'paymentStatusPullingInterval'):
            for value in ('', [], {}, 0, False, 'synthetic'):
                data = inputs(); event(data)[key] = value
                with self.subTest(key=key, value=value), self.assertRaises(route.q.c.http.TalabatError):
                    route.selected_payment_event(**data)

    def test_routing_pu_preserved_but_no_other_fields(self):
        data = inputs(); event(data)['routingCriteria'] = {'pu':'synthetic-private-pu'}
        self.assertEqual(route.selected_payment_event(**data)['routingCriteria'], {'pu':'synthetic-private-pu'})
        for value in ({}, {'pu':''}, {'pu':False}, {'pu':'valid', 'other':True}, False):
            event(data)['routingCriteria'] = value
            with self.assertRaises(route.q.c.http.TalabatError): route.selected_payment_event(**data)

    def test_saved_card_enabled_uniqueness_identity_and_force_cvv(self):
        for kind in ('card', 'disabled', 'duplicate', 'cvv', 'bin', 'fingerprint'):
            data = inputs()
            if kind == 'card': event(data)['card']['cardId'] = data['saved_card']['token']
            elif kind == 'disabled': data['config']['paymentMethods'][0]['isEnabled'] = False
            elif kind == 'duplicate': data['config']['paymentMethods'] *= 2
            elif kind == 'cvv': data['saved_card']['isForceCvv'] = True
            elif kind == 'bin': event(data)['card']['binNumber'] = 'invalid'
            else: event(data)['card']['cardFingerPrint'] = ' '
            with self.subTest(kind=kind), self.assertRaises(route.q.c.http.TalabatError):
                route.selected_payment_event(**data)

    def test_only_private_draft_no_auth_transport_or_error_echo(self):
        data = inputs()
        with patch.object(route.q.c.http, 'account', side_effect=AssertionError('auth')), \
                patch.object(route.q, '_json_request', side_effect=AssertionError('http')):
            route.selected_payment_event(**data)
            event(data)['platform'] = 'secret-runtime-value'
            with self.assertRaises(route.q.c.http.TalabatError) as failure:
                route.selected_payment_event(**data)
            self.assertNotIn('secret-runtime-value', str(failure.exception))
        self.assertNotIn('ready_to_order', json.dumps(route.EVENT_KEYS, default=list))


if __name__ == '__main__': unittest.main()
