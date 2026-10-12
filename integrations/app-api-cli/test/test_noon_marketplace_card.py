"""Static-native-key fixtures; synthetic values, never a captured account session."""
from copy import deepcopy
from dataclasses import FrozenInstanceError
import unittest

import noon_marketplace_card as c


def native_session(*, sections=True):
    # Selectors: HBC 4893746-4893793; closures 119103, 119108-119110.
    # Fields: HBC 4895765-4895775, 4893890-4893894.
    cards = [
        {'id': 'fixture-unselected-id', 'mask': '****0000', 'type': 'visa', 'isSelected': False},
        {'id': 'fixture-selected-id', 'mask': '****5542', 'type': 'mastercard', 'isSelected': True},
    ]
    method = {'code': 'cc_noonpay', 'status': 'active'}
    if sections:
        method['cardSections'] = [{}, {'cards': None}, {'cards': cards[:1]}, {'cards': cards[1:]}]
    else:
        method['cards'] = cards
    return {'paymentMethodsV2': {'methods': [{'code': 'cod', 'status': 'inactive'}, method]}}


class SelectedCardTests(unittest.TestCase):
    def fails(self, session, code):
        with self.assertRaises(c.CardError) as raised:
            c.extract_selected_card(session)
        self.assertEqual(raised.exception.code, code)

    def test_both_native_card_layouts_and_no_mutation(self):
        for sections in (True, False):
            session = native_session(sections=sections)
            before = deepcopy(session)
            card = c.extract_selected_card(session)
            self.assertEqual((card.token, card.mask, card.network, card.payment_method, card.is_selected),
                             ('fixture-selected-id', '****5542', 'mastercard', 'cc_noonpay', True))
            self.assertEqual(session, before)
            self.assertNotIn(card.token, repr(card))
            self.assertNotIn(card.mask, repr(card))
            with self.assertRaises(FrozenInstanceError):
                card.token = 'changed'

    def test_card_sections_presence_wins_over_legacy_cards(self):
        session = native_session()
        method = session['paymentMethodsV2']['methods'][1]
        method['cards'] = [{'id': 'decoy', 'isSelected': True}]
        self.assertEqual(c.extract_selected_card(session).token, 'fixture-selected-id')
        method['cardSections'] = None
        self.fails(session, 'SCHEMA_CARD_SECTIONS')

    def test_flat_echo_and_saved_card_aliases_are_not_native_evidence(self):
        self.fails({'paymentMethod': 'cc', 'cardToken': 'fake', 'cardMask': '****5542'},
                   'SCHEMA_PAYMENT_METHODS_V2')
        session = native_session(sections=False)
        card = session['paymentMethodsV2']['methods'][1]['cards'][1]
        card['ccMasked'] = card.pop('mask')
        self.fails(session, 'SCHEMA_CARD_MASK')
        card['mask'] = card.pop('ccMasked')
        card['ccType'] = card.pop('type')
        self.fails(session, 'SCHEMA_CARD_TYPE')

    def test_selected_cc_card_does_not_imply_active_cc_method(self):
        session = native_session()
        methods = session['paymentMethodsV2']['methods']
        methods[0]['status'], methods[1]['status'] = 'active', 'inactive'
        self.fails(session, 'SELECTED_PAYMENT_METHOD_NOT_CC')

    def test_active_and_cc_method_ambiguity(self):
        session = native_session()
        methods = session['paymentMethodsV2']['methods']
        methods[0]['status'] = 'active'
        self.fails(session, 'SELECTED_PAYMENT_METHOD_AMBIGUOUS_OR_MISSING')
        methods[0]['status'] = 'inactive'
        methods.append({'code': 'cc_noonpay', 'status': 'inactive', 'cards': []})
        self.fails(session, 'CC_PAYMENT_METHOD_AMBIGUOUS')

    def test_selection_ambiguity_across_sections(self):
        session = native_session()
        sections = session['paymentMethodsV2']['methods'][1]['cardSections']
        sections[2]['cards'][0]['isSelected'] = True
        self.fails(session, 'SELECTED_CARD_AMBIGUOUS_OR_MISSING')
        sections[2]['cards'][0]['isSelected'] = False
        sections[3]['cards'][0]['isSelected'] = False
        self.fails(session, 'SELECTED_CARD_AMBIGUOUS_OR_MISSING')

    def test_wrong_selection_types_and_missing_identity(self):
        for flag in ('false', 1, None, [], {}):
            with self.subTest(flag=flag):
                session = native_session(sections=False)
                session['paymentMethodsV2']['methods'][1]['cards'][1]['isSelected'] = flag
                self.fails(session, 'SCHEMA_CARD_IS_SELECTED')
        for key, code in (('id', 'SCHEMA_CARD_ID'), ('mask', 'SCHEMA_CARD_MASK'), ('type', 'SCHEMA_CARD_TYPE')):
            session = native_session(sections=False)
            del session['paymentMethodsV2']['methods'][1]['cards'][1][key]
            self.fails(session, code)

    def test_cc_constant_is_native_not_generic_cc(self):
        session = native_session()
        session['paymentMethodsV2']['methods'][1]['code'] = 'cc'
        self.fails(session, 'SELECTED_PAYMENT_METHOD_NOT_CC')


if __name__ == '__main__':
    unittest.main()
