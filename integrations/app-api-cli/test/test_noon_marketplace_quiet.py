"""Offline synthetic values on native keys; no account or network fixtures."""
from copy import deepcopy
import unittest
from unittest.mock import patch

from noon_marketplace_quiet import (
    QuietDeliveryUnsupported, native_delivery_options, native_quiet_contract,
    select_native_quiet_delivery, verify_native_quiet_delivery,
)
from noon_marketplace_review import ReviewError


def session_fixture():
    return {'addressCode': 'fixture-home', 'deliveryOptions': {
        'fixture-info': {'status': 'inactive', 'action': 'info',
                         'type': 'checkbox', 'message': 'Fixture server option'},
        'fixture-recipient': {'status': 'active', 'action': 'receiver_phone',
                              'type': 'checkbox', 'message': 'Fixture recipient',
                              'note': {'content': 'Alternate-phone explanatory copy'}},
    }}


class QuietTests(unittest.TestCase):
    def setUp(self):
        self.session = session_fixture()
        self.context = {'service': 'main', 'request_experience': 'ecom', 'request_mp': 'noon'}
        for name in ('socket.socket.connect', 'socket.socket.connect_ex',
                     'socket.create_connection', 'subprocess.run', 'subprocess.Popen'):
            guard = patch(name, side_effect=AssertionError('I/O forbidden'))
            guard.start()
            self.addCleanup(guard.stop)

    def test_exact_native_option_paths_and_branches(self):
        rows = native_delivery_options(self.session)
        self.assertEqual(rows[0]['source_path'], ('deliveryOptions', 'fixture-info'))
        self.assertEqual(rows[0]['native_press_branch'], 'info_overlay')
        self.assertEqual(rows[1]['native_press_branch'], 'set_active_false')
        self.session['deliveryOptions']['fixture-recipient']['status'] = 'inactive'
        self.assertEqual(native_delivery_options(self.session)[1]['native_press_branch'],
                         'alternate_receiver_phone')

    def test_disabled_unknown_and_checkbox_only_do_not_enable(self):
        option = self.session['deliveryOptions']['fixture-info']
        option['status'] = 'disabled'
        self.assertEqual(native_delivery_options(self.session)[0]['native_press_branch'], 'disabled')
        option.update(status='future_status', action='future_action')
        row = native_delivery_options(self.session)[0]
        self.assertEqual(row['status'], 'future_status')
        self.assertFalse(row['active'])
        self.assertEqual(row['native_press_branch'], 'no_activation')
        del option['action']
        self.assertEqual(native_delivery_options(self.session)[0]['native_press_branch'], 'no_activation')

    def test_absent_empty_null_are_distinct(self):
        self.assertIsNone(native_delivery_options({}))
        self.assertEqual(native_delivery_options({'deliveryOptions': {}}), [])
        for bad in (None, [], True):
            with self.subTest(bad=bad), self.assertRaisesRegex(ReviewError, 'SCHEMA_DELIVERY_OPTIONS'):
                native_delivery_options({'deliveryOptions': bad})

    def test_request_active_boolean_is_not_response_status(self):
        for option in ({'active': True}, {'status': True}, {'status': None}):
            with self.subTest(option=option), self.assertRaisesRegex(ReviewError, 'STATUS'):
                native_delivery_options({'deliveryOptions': {'fixture': option}})

    def test_quiet_sounding_copy_codes_and_alternate_note_are_not_semantics(self):
        self.session['deliveryOptions']['leave_at_door'] = {
            'status': 'active', 'action': 'receiver_phone', 'type': 'checkbox',
            'message': "Leave at door. Don't ring. Don't call.",
            'note': {'content': "Please leave at the door. Don't ring the bell, don't call."}}
        contract = native_quiet_contract(self.session, **self.context)
        self.assertFalse(contract['supported'])
        self.assertNotIn('rider_note', contract)
        self.assertNotIn('payload', contract)
        self.assertEqual(contract['required_quiet_semantics'], ('leave_at_door', 'no_bell', 'no_call'))
        for api in (select_native_quiet_delivery, verify_native_quiet_delivery):
            with self.assertRaises(QuietDeliveryUnsupported) as caught:
                api(self.session, **self.context)
            self.assertEqual(caught.exception.contract, contract)
            self.assertIn('f88683@50', caught.exception.contract['missing_nodes'][3]['anchor'])

    def test_main_and_supermall_bind_proven_request_context_without_echo(self):
        main = native_quiet_contract(self.session, **self.context)
        rocket = native_quiet_contract(self.session, service='supermall',
                                       request_experience='rocket', request_mp='noon')
        self.assertEqual(main['session_hash'], rocket['session_hash'])
        self.assertNotEqual(main['binding_hash'], rocket['binding_hash'])
        self.assertFalse(rocket['supported'])
        for changes in ({'request_experience': 'rocket'}, {'request_mp': 'rocket'},
                        {'service': 'minutes'}):
            with self.subTest(changes=changes), self.assertRaises(ReviewError):
                native_quiet_contract(self.session, **{**self.context, **changes})

    def test_full_snapshot_binding_and_no_mutation(self):
        before = deepcopy(self.session)
        first = native_quiet_contract(self.session, **self.context)
        self.assertEqual(before, self.session)
        self.session['deliveryOptions']['fixture-recipient']['note']['content'] = 'Changed copy'
        second = native_quiet_contract(self.session, **self.context)
        self.assertNotEqual(first['session_hash'], second['session_hash'])
        self.assertNotEqual(first['delivery_options'][1]['source_hash'],
                            second['delivery_options'][1]['source_hash'])
        first['missing_nodes'][0]['missing'] = 'caller edited result'
        self.assertNotEqual(first['missing_nodes'], second['missing_nodes'])

    def test_instant_or_saved_address_decoys_cannot_close_marketplace_gap(self):
        self.session.update(deliveryPreferences={'leave_at_door': True},
                            deliveryInstructions="Don't call or ring", leaveAtDoor=True)
        self.assertFalse(native_quiet_contract(self.session, **self.context)['supported'])


if __name__ == '__main__':
    unittest.main()
