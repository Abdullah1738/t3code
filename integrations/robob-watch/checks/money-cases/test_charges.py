"""Reading card alerts and finding what explains a charge: receipts, his own words, a merchant he pays."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
spec = importlib.util.spec_from_file_location('charges', Path(__file__).with_name('charges.py'))
ch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ch)

TZ = ch.TZ


def at(text):
    return dt.datetime.fromisoformat(text).replace(tzinfo=TZ)


def ts(text):
    return at(text).timestamp()


class Parse(unittest.TestCase):
    def test_reads_each_bank_format(self):
        cases = [
            ('EmiratesNBD', 'Purchase of EUR 12.34 with Credit Card ending 1111 at ACME * EATS PENDING, Amsterdam. '
             'Avl Cr. Limit is AED -1,000.00. Pls refer stmt for exact amt', ('charge', 'EUR', '12.34', '1111', 'ACME * EATS PENDING', True)),
            ('EmiratesNBD', 'Purchase of AED 1,250.00 with Credit Card ending 1111 at GLOBEX DENTAL & CO, .. Avl Cr. Limit is AED 5.00',
             ('charge', 'AED', '1250.00', '1111', 'GLOBEX DENTAL & CO', False)),
            ('EmiratesNBD', 'Payment of USD 99.00 to INITECH AI with Credit Card ending 1111. Avl Cr. Limit is AED 5.00',
             ('charge', 'USD', '99.00', '1111', 'INITECH AI', False)),
            ('EmiratesNBD', 'Transaction of AED 5,000.10 on your Card 2222 at UMBRELLA INSURANCE MIDDLE was declined due to '
             'insufficient limit.', ('decline', 'AED', '5000.10', '2222', 'UMBRELLA INSURANCE MIDDLE', False)),
            ('EI SMS', 'Credit Card Purchase Card Ending: 3333 At: HOOLI, 971800000000 Amount: AED 70.00 Date: 20/10/2026, 19:18',
             ('charge', 'AED', '70.00', '3333', 'HOOLI', False)),
            ('EI SMS', 'Purchase declined due to insufficient funds Amount: AED 31.50 Credit Card Ending: 3333 At: TABBO, 9714000 Date: x',
             ('decline', 'AED', '31.50', '3333', 'TABBO', False)),
            ('ADCBAlert', 'Credit Card XX4444 was used for AED69.07 on 04/10/2026 14:17:07 at TABBO, Dubai. Avl limit',
             ('charge', 'AED', '69.07', '4444', 'TABBO', False)),
            ('WioPersonal', 'Payment of USD 16.18 (AED 59.42) was done at Vandelay using your Wio Personal card 5555. Thanks',
             ('charge', 'USD', '16.18', '5555', 'Vandelay', False)),
            ('WioPersonal', 'Payment of USD 5.8 at GOOGLE*WORKSPACE X with your Wio Personal card ending with 5555 was declined',
             ('decline', 'USD', '5.80', '5555', 'GOOGLE*WORKSPACE X', False)),
            ('MashreqAlerts@mashreq.com', 'Your Mashreq noon Card ending with 6666 was used for a purchase of AED 31.00 at '
             'ACME *TRIP HELP.ACME.COM', ('charge', 'AED', '31.00', '6666', 'ACME *TRIP HELP.ACME.COM', False)),
        ]
        for sender, text, want in cases:
            with self.subTest(text=text[:40]):
                c = ch.parse(text, sender)
                self.assertEqual((c['kind'], c['currency'], c['amount'], c['card'], c['merchant'], c['pending']), want)

    def test_over_limit_balance_notice_on_5542_is_never_a_charge_question(self):
        for sender in ('Wio Bank', 'Wio Personal', ''):
            with self.subTest(sender=sender):
                self.assertIsNone(ch.parse('Alert: card ending 5542 available balance is AED -2,345.10 and is over limit', sender))

    def test_payments_refunds_prompts_and_other_senders_are_not_charges(self):
        for sender, text in [
            ('EmiratesNBD', 'Payment of AED 900.00 towards your Credit Card ending 1111 has been received.'),
            ('EmiratesNBD', 'Purchase amount of EUR 1.98 at ACME * PENDING on your Credit Card ending 1111 has been refunded'),
            ('EI SMS', 'Refund Initiated Amount: AED 10.00 At: HOOLI, 971800'),
            ('EmiratesNBD', 'A payment on your card needs your confirmation in the app.'),
            ('Acme Shop', 'Purchase of AED 12.00 with Credit Card ending 1111 at ACME, Dubai. Avl Cr. Limit is AED 1'),
        ]:
            with self.subTest(text=text[:40]):
                self.assertIsNone(ch.parse(text, sender))
        self.assertIsNotNone(ch.parse('Purchase of AED 12.00 with Credit Card ending 1111 at ACME, Dubai. Avl'))


class Finder:
    """A fake msgs search: rows matching every AND'ed group of quoted words, inside the dates."""

    def __init__(self, rows):
        self.rows, self.calls = rows, []

    def __call__(self, query, since, until=None, source=None, n=20, deadline=None):
        self.calls.append((query, since, until, source))
        groups = [[w.strip('"').lower() for w in g.split(' OR ')] for g in self.split(query)]
        out = []
        for r in self.rows:
            text = f"{r.get('subject', '')} {r.get('body', '')} {r.get('sender', '')}".lower()
            day = dt.datetime.fromtimestamp(r['ts'], TZ).date().isoformat()
            if source and r.get('source', 'email') != source:
                continue
            if day < since or (until and day >= until):
                continue
            if all(any(w in text for w in g) for g in groups):
                out.append({'source': 'email', 'from_me': 0, **r})
        return sorted(out, key=lambda r: -r['ts'])[:n]

    @staticmethod
    def split(query):
        # Groups are separated where two quoted terms meet without an OR between them.
        groups, cur, prev = [], [], None
        for tok in query.split(' '):
            if tok == 'OR':
                prev = 'OR'
                continue
            if cur and prev != 'OR':
                groups.append(' OR '.join(cur))
                cur = []
            cur.append(tok)
            prev = tok
        if cur:
            groups.append(' OR '.join(cur))
        return groups


def nobody(since, until, deadline=None):
    return []


CHARGE = ch.parse('Purchase of EUR 12.34 with Credit Card ending 1111 at ACME * EATS PENDING, Amsterdam. Avl')


def read(row, deadline=None):
    return f"{row.get('subject', '')}\n{row.get('body', '')}"


class Explain(unittest.TestCase):
    def setUp(self):
        p = patch.object(ch, 'show', read)
        p.start()
        self.addCleanup(p.stop)

    def test_a_receipt_with_the_amount_and_merchant_explains_it(self):
        find = Finder([{'id': 7, 'ts': ts('2026-10-24T10:47'), 'sender': 'Acme Receipts <noreply@acme.example>',
                        'subject': 'Your order with Acme Eats', 'body': 'Thanks for ordering. Total €12.34'}])
        r = ch.explain(CHARGE, at('2026-10-23T23:47'), at('2026-10-24T11:00'), find=find, said=nobody)
        self.assertEqual((r['verdict'], r['msgs']), ('receipt', 7))
        self.assertIn('Acme Receipts', r['why'])

    def test_a_search_hit_counts_only_if_the_mail_shows_the_amount_and_the_name(self):
        charge = ch.parse('Purchase of USD 25.00 with Credit Card ending 1111 at BOAT.DEV, DOVER. Avl')
        stamp = {'id': 5, 'ts': ts('2026-10-25T10:48'), 'sender': 'GitHub <notifications@github.example>',
                 'subject': 'Run failed: Terraform dev', 'body': 'Started 2026-10-25 00:12:21 UTC'}
        def everything(query, since, until=None, source=None, n=20, deadline=None):
            return [{'source': 'email', 'from_me': 0, **stamp}]
        r = ch.explain(charge, at('2026-10-25T10:44'), at('2026-10-25T10:50'), find=everything, said=nobody)
        self.assertEqual(r['verdict'], 'ask')
        stamp.update(sender='Boat <receipts@stripe.example>', subject='Your Boat receipt', body='Amount paid $25.00')
        r = ch.explain(charge, at('2026-10-25T10:44'), at('2026-10-25T10:50'), find=everything, said=nobody)
        self.assertEqual(r['verdict'], 'receipt')

    def test_amounts_are_matched_as_money_in_the_charges_currency(self):
        def hits(amount, currency, text):
            return bool(ch.amount_pattern({'amount': amount, 'currency': currency}).search(text))
        for amount, cur, text in (('25.00', 'USD', 'Amount paid $25.00'), ('1234.50', 'EUR', 'Total EUR 1,234.50'),
                                  ('1234.50', 'EUR', 'Summe 1.234,50 €'), ('199.00', 'USD', 'paid USD 199 today'),
                                  ('199.00', 'USD', '$199 plan'), ('12.34', 'EUR', '€12,34'),
                                  ('266.79', 'AED', 'TOTAL AED266.79')):
            self.assertTrue(hits(amount, cur, text), (amount, text))
        for amount, cur, text in (('25.00', 'USD', 'on 2026-10-25 00:12'), ('199.00', 'USD', 'order $1199.00'),
                                  ('25.00', 'USD', '$25.001'), ('199.00', 'USD', '199 items'),
                                  ('12.34', 'EUR', '€12.345'), ('199.00', 'USD', '€199 plan'),
                                  ('74.49', 'EUR', 'Total 74.49')):
            self.assertFalse(hits(amount, cur, text), (amount, text))

    def test_bank_copies_and_mail_from_before_the_window_dont_count(self):
        find = Finder([{'id': 1, 'ts': ts('2026-10-23T23:48'), 'sender': 'alert@emiratesnbd.com', 'subject': 'acme 12.34'},
                       {'id': 2, 'ts': ts('2026-10-23T20:00'), 'sender': 'noreply@acme.example', 'subject': 'acme 12.34'}])
        r = ch.explain(CHARGE, at('2026-10-23T23:47'), at('2026-10-24T00:30'), find=find, said=nobody)
        self.assertEqual(r['verdict'], 'ask')

    def test_a_receipt_under_another_name_needs_the_card_and_the_minute(self):
        charge = ch.parse('Payment of USD 99.00 to INITECH AI with Credit Card ending 1111. Avl')
        mail = {'ts': ts('2026-10-24T00:45:10'), 'sender': 'BILLING CO <invoice@stripe.example>',
                'subject': 'Your receipt from BILLING CO', 'body': '$99.00 Paid on October 24, 2026 with - 1111'}
        def explain(*rows, now='2026-10-24T00:47'):
            return ch.explain(charge, at('2026-10-24T00:45:05'), at(now), find=Finder(list(rows)), said=nobody)['verdict']
        self.assertEqual(explain(dict(mail, id=3)), 'receipt')
        self.assertEqual(explain(dict(mail, id=4, ts=ts('2026-10-24T03:00')), now='2026-10-24T04:00'), 'ask')
        # Another shop's receipt, an advert, or the amount in another currency is a coincidence.
        self.assertEqual(explain(dict(mail, id=5, body='$99.00 Paid on October 24, 2026 with - 2222')), 'ask')
        self.assertEqual(explain(dict(mail, id=6, subject='Upgrade today', body='Pro for just $99.00, card 1111 ready')),
                         'ask')
        self.assertEqual(explain(dict(mail, id=7, body='€99.00 Paid on October 24, 2026 with - 1111')), 'ask')

    def test_an_advert_naming_the_merchant_is_not_a_receipt(self):
        promo = {'id': 8, 'ts': ts('2026-10-23T23:50'), 'sender': 'Acme <news@acme.example>',
                 'subject': 'Acme deals', 'body': 'Get Acme Eats for just €12.34 this week'}
        r = ch.explain(CHARGE, at('2026-10-23T23:47'), at('2026-10-24T00:30'), find=Finder([promo]), said=nobody)
        self.assertEqual(r['verdict'], 'ask')

    def test_his_own_words_around_the_charge_explain_it(self):
        def said(since, until, deadline=None):
            self.assertEqual((since, until), (at('2026-10-24T00:15'), at('2026-10-24T00:47')))
            return [('2026-10-23T20:46:00.000Z', 'Please set up Acme for me', 'Set up Acme')]
        r = ch.explain(CHARGE, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
        self.assertEqual(r['verdict'], 'owner')
        self.assertIn('00:46', r['why'])

    def test_talking_about_a_merchant_without_paying_it_explains_nothing(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')

        def said(since, until, deadline=None):
            return [('2026-10-24T00:20:00.000Z', 'Summarize the Apple keynote for me', 'Apple talk')]
        r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
        self.assertEqual(r['verdict'], 'ask')

    def test_a_schedule_bound_to_his_imessage_thread_is_not_his_words(self):
        # ScheduledTaskService sends a stored prompt into the owner's iMessage thread as 'system', with
        # no [tag], and the task id in the payload. Only that metadata tells it from his own send.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.sqlite'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, updated_at TEXT)')
            db.execute('CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, role TEXT, created_at TEXT, '
                       'payload_json TEXT)')
            db.execute('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?)',
                       ('a', 'iMessage 2026-10-24 00:30', '2026-10-24T00:00:00.000Z'))
            rows = [('2026-10-24T00:10:00.000Z', {'createdBy': 'system', 'text': 'Check my Apple order status',
                                                  'scheduledTaskId': 'scheduled-task:apple'}),
                    ('2026-10-24T00:11:00.000Z', relayed('Ok'))]
            for created, payload in rows:
                db.execute('INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?)',
                           ('a', 'user', created, json.dumps(payload)))
            db.commit()
            db.close()
            with patch.object(ch, 'STATE_DB', path):
                got = [t for _, t, _ in ch.owner_texts(at('2026-10-24T03:00'), at('2026-10-24T05:00'))]
            self.assertNotIn('Check my Apple order status', got)
            self.assertIn('Ok', got)


    def test_a_purchase_for_another_merchant_does_not_explain_this_charge(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')

        def said(since, until, deadline=None):
            return [('2026-10-24T00:20:00.000Z', 'I paid Amazon AED 50. Send me the Apple keynote summary.', 'iMessage')]
        r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
        self.assertEqual(r['verdict'], 'ask')

        def mine(since, until, deadline=None):
            return [('2026-10-24T00:20:00.000Z', 'I paid Amazon AED 50. The Apple one is mine.', 'iMessage')]
        r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=mine)
        self.assertEqual(r['verdict'], 'owner')

    def test_a_denial_of_a_purchase_from_the_merchant_explains_nothing(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')
        for denial in ('No Apple orders from me', 'I ordered nothing from Apple'):
            with self.subTest(denial=denial):
                def said(since, until, deadline=None, text=denial):
                    return [('2026-10-24T00:20:00.000Z', text, 'iMessage')]
                r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
                self.assertEqual(r['verdict'], 'ask')

    def test_buying_a_product_with_the_merchant_brand_from_another_seller_explains_nothing(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')

        def said(since, until, deadline=None):
            return [('2026-10-24T00:20:00.000Z', 'I ordered an Apple charger from Amazon', 'iMessage')]
        r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
        self.assertEqual(r['verdict'], 'ask')

    def test_ordering_from_the_merchant_itself_still_explains(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')

        def said(since, until, deadline=None):
            return [('2026-10-24T00:20:00.000Z', 'I ordered from Apple, the iCloud one', 'iMessage')]
        r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
        self.assertEqual(r['verdict'], 'owner')

    def test_paying_the_merchant_with_my_card_still_explains_the_charge(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')

        def said(since, until, deadline=None):
            return [('2026-10-24T00:20:00.000Z', 'I paid Apple USD 99 with my ENBD card', 'iMessage')]
        r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
        self.assertEqual(r['verdict'], 'owner')

    def test_a_purchase_from_another_seller_for_my_apple_laptop_explains_nothing(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')
        for text in ('I ordered from Amazon for my Apple laptop', 'I ordered from Amazon using my Apple laptop'):
            with self.subTest(text=text):
                def said(since, until, deadline=None, text=text):
                    return [('2026-10-24T00:20:00.000Z', text, 'iMessage')]
                r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
                self.assertEqual(r['verdict'], 'ask')

    def test_an_instrument_or_product_after_another_payee_is_not_the_merchant(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')
        for text in ('I paid Amazon with Apple Pay', 'I ordered Apple gear through the Amazon store'):
            with self.subTest(text=text):
                def said(since, until, deadline=None, text=text):
                    return [('2026-10-24T00:20:00.000Z', text, 'iMessage')]
                r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
                self.assertEqual(r['verdict'], 'ask')

    def test_a_payment_method_is_never_the_payee_or_the_seller(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')
        for text in ('I paid with Apple Pay', 'I paid Amazon via Apple Pay'):
            with self.subTest(text=text):
                def said(since, until, deadline=None, text=text):
                    return [('2026-10-24T00:20:00.000Z', text, 'iMessage')]
                r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
                self.assertEqual(r['verdict'], 'ask')

    def test_topping_up_the_merchant_account_still_explains_the_charge(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')

        def said(since, until, deadline=None):
            return [('2026-10-24T00:20:00.000Z', 'I topped up my Apple account USD 99', 'iMessage')]
        r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
        self.assertEqual(r['verdict'], 'owner')

    def test_a_later_denial_vetoes_an_earlier_affirmation_in_the_same_message(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')

        def said(since, until, deadline=None):
            return [('2026-10-24T00:20:00.000Z', 'I paid Apple. No, I ordered nothing from Apple.', 'iMessage')]
        r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
        self.assertEqual(r['verdict'], 'ask')

    def test_a_later_denial_of_the_purchase_outvotes_an_earlier_payment(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')
        for text in ('I paid Apple. No Apple orders from me.',
                     'I paid Apple. No, the Apple charge belongs to someone else.'):
            with self.subTest(text=text):
                def said(since, until, deadline=None, text=text):
                    return [('2026-10-24T00:20:00.000Z', text, 'iMessage')]
                r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
                self.assertEqual(r['verdict'], 'ask', text)

    def test_a_correction_that_points_back_at_the_charge_outvotes_an_earlier_payment(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')
        for text in ('I paid Apple. No, wrong charge.', 'I paid Apple. Actually nothing to do with me.'):
            with self.subTest(text=text):
                def said(since, until, deadline=None, text=text):
                    return [('2026-10-24T00:20:00.000Z', text, 'iMessage')]
                r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
                self.assertEqual(r['verdict'], 'ask', text)

    def test_naming_someone_else_who_reimburses_him_still_explains_his_charge(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')
        for text in ('The Apple charge is mine, someone else reimbursed me',
                     'I paid Apple USD 99. Someone else will reimburse me.'):
            with self.subTest(text=text):
                def said(since, until, deadline=None, text=text):
                    return [('2026-10-24T00:20:00.000Z', text, 'iMessage')]
                r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
                self.assertEqual(r['verdict'], 'owner', text)

    def test_a_predicative_someone_else_denial_outvotes_an_earlier_payment(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')
        for text in ("I paid Apple. That was someone else's.",
                     "I paid Apple. Actually that one is someone else's."):
            with self.subTest(text=text):
                def said(since, until, deadline=None, text=text):
                    return [('2026-10-24T00:20:00.000Z', text, 'iMessage')]
                r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
                self.assertEqual(r['verdict'], 'ask', text)

    def test_contracted_and_curly_apostrophe_denials_outvote_an_earlier_payment(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')
        for text in ("I paid Apple. That's someone else's.",
                     "I paid Apple. It's someone else's.",
                     "I paid Apple. That was someone else\u2019s."):
            with self.subTest(text=text):
                def said(since, until, deadline=None, text=text):
                    return [('2026-10-24T00:20:00.000Z', text, 'iMessage')]
                r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
                self.assertEqual(r['verdict'], 'ask', text)

    def test_someone_else_in_the_same_clause_as_an_ownership_answer_still_explains_the_charge(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')
        for text in ('The Apple charge is mine because someone else reimbursed me',
                     'I paid Apple USD 99 for someone else'):
            with self.subTest(text=text):
                def said(since, until, deadline=None, text=text):
                    return [('2026-10-24T00:20:00.000Z', text, 'iMessage')]
                r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
                self.assertEqual(r['verdict'], 'owner', text)

    def test_an_ownership_answer_with_discourse_words_still_explains_the_charge(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')
        for text in ('Actually the Apple charge is mine', 'The Apple charge is mine, no need to ask'):
            with self.subTest(text=text):
                def said(since, until, deadline=None, text=text):
                    return [('2026-10-24T00:20:00.000Z', text, 'iMessage')]
                r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
                self.assertEqual(r['verdict'], 'owner', text)

    def test_paying_another_merchant_with_an_apple_wallet_explains_nothing(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')

        def said(since, until, deadline=None):
            return [('2026-10-24T00:20:00.000Z', 'I paid Amazon via Apple Wallet', 'iMessage')]
        r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
        self.assertEqual(r['verdict'], 'ask')

    def test_an_order_of_something_else_explains_nothing(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')

        def said(since, until, deadline=None):
            return [('2026-10-24T00:20:00.000Z', 'Summarize the order of Apple product announcements', 'Apple talk')]
        r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
        self.assertEqual(r['verdict'], 'ask')

    def test_an_explicit_ownership_answer_explains_the_charge(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00')

        def said(since, until, deadline=None):
            return [('2026-10-24T00:20:00.000Z', 'The Apple charge is mine', 'Apple charge')]
        r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
        self.assertEqual(r['verdict'], 'owner')

    def test_paying_another_merchant_in_the_same_message_explains_nothing(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00', pending=False)
        for text in ('I paid Amazon AED 50. Send me the Apple keynote summary.',
                     'Paid Amazon, then summarise the Apple keynote',
                     'I ordered from Amazon and want the Apple keynote notes',
                     'I paid AED 50 for the Apple cable'):
            def said(since, until, deadline=None, text=text):
                return [('2026-10-24T00:20:00.000Z', text, 'iMessage 2026-10-24 00:40')]
            r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
            self.assertEqual(r['verdict'], 'ask', text)
        for text in ('I paid Apple USD 99', 'Send me the keynote summary. I paid Apple $99 for iCloud.',
                     'Amazon was earlier. The Apple charge is mine'):
            def said(since, until, deadline=None, text=text):
                return [('2026-10-24T00:20:00.000Z', text, 'iMessage 2026-10-24 00:40')]
            r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
            self.assertEqual(r['verdict'], 'owner', text)

    def test_a_question_about_paying_or_owning_it_explains_nothing(self):
        # Review round 4: splitting the message into clauses must not drop the "?" that makes it a question.
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00', pending=False)
        for text in ('Is this Apple charge mine?', 'Have I paid Apple?', 'Did I order from Apple? I paid Amazon.',
                     'Is this Apple charge mine', 'Have I paid Apple', 'Maybe the Apple charge is mine',
                     'I paid Apple 50 dollars',
                     'I paid Apple. Actually no, that is not mine, block it', 'Apple orders keep coming. Who is this'):
            def said(since, until, deadline=None, text=text):
                return [('2026-10-24T00:20:00.000Z', text, 'iMessage 2026-10-24 00:40')]
            r = ch.explain(apple, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
            self.assertEqual(r['verdict'], 'ask', text)

    def test_his_denials_and_questions_explain_nothing(self):
        for text in ('I do not recognise the ACME charge. It is not mine.', "What's this Acme charge?",
                     "acme isn't me, block the card", 'Dispute the Acme one'):
            def said(since, until, deadline=None, text=text):
                return [('2026-10-23T20:46:00.000Z', text, 'iMessage 2026-10-24 00:40')]
            r = ch.explain(CHARGE, at('2026-10-24T00:45'), at('2026-10-24T00:47'), find=Finder([]), said=said)
            self.assertEqual(r['verdict'], 'ask', text)

    def test_a_merchant_he_already_pays_waits_for_the_receipt(self):
        shown = ('imessage: EmiratesNBD\n\n    1 2026-09-01 11:00 EmiratesNBD: Payment of AED 9.00 towards your Credit '
                 'Card ending 1111\n>   9 2026-09-01 12:00 EmiratesNBD: Purchase of EUR 9.99 with Credit Card ending '
                 '1111 at ACME * EATS PENDING, Amsterdam. Avl Cr. Limit is AED 1')
        old = {'id': 9, 'ts': ts('2026-09-01T12:00'), 'sender': 'EmiratesNBD', 'source': 'imessage', 'subject': '',
               'body': 'Purchase of EUR 9.99 with Credit Card ending 1111 at ACME * EATS PENDING', 'shown': shown}
        with patch.object(ch, 'show', lambda row, deadline=None: row.get('shown') or read(row)):
            r = ch.explain(CHARGE, at('2026-10-23T23:47'), at('2026-10-24T00:37'), find=Finder([old]), said=nobody)
            self.assertEqual((r['verdict'], r['until']), ('wait', '2026-10-25T11:47:00+04:00'))
            r = ch.explain(CHARGE, at('2026-10-23T23:47'), at('2026-10-25T12:00'), find=Finder([old]), said=nobody)
            self.assertEqual(r['verdict'], 'ask')
            # Bank alerts alone wait only for a pending hold; a settled charge goes to him.
            settled = ch.parse('Purchase of EUR 12.34 with Credit Card ending 1111 at ACME EATS, Amsterdam. Avl')
            r = ch.explain(settled, at('2026-10-23T23:47'), at('2026-10-24T00:37'), find=Finder([old]), said=nobody)
            self.assertEqual(r['verdict'], 'ask')
        receipt = {'id': 10, 'ts': ts('2026-09-02T12:00'), 'sender': 'Acme <noreply@acme.example>',
                   'subject': 'Your Acme receipt', 'body': 'Thanks for ordering. Total €9.99'}
        r = ch.explain(settled, at('2026-10-23T23:47'), at('2026-10-24T00:37'), find=Finder([receipt]), said=nobody)
        self.assertEqual((r['verdict'], r['why']), ('wait', 'a merchant that mails him receipts: wait for the receipt'))

    def test_newsletters_dont_make_a_merchant_he_pays(self):
        news = {'id': 11, 'ts': ts('2026-09-02T12:00'), 'sender': 'Acme <news@acme.example>',
                'subject': 'Acme weekly', 'body': 'New on Acme Eats this week'}
        r = ch.explain(CHARGE, at('2026-10-23T23:47'), at('2026-10-24T00:37'), find=Finder([news]), said=nobody)
        self.assertEqual(r['verdict'], 'ask')

    def test_the_merchants_own_receipts_are_read_before_other_mail(self):
        # Newsletters naming the merchant come first by date; its own receipt still counts.
        others = [{'id': 20 + i, 'ts': ts(f'2026-10-2{i}T12:00'), 'sender': f'Paper {i} <news@paper.example>',
                   'subject': 'Weekly', 'body': 'Acme paid creators more this year'} for i in range(3)]
        mine = {'id': 30, 'ts': ts('2026-09-02T12:00'), 'sender': 'Acme <noreply@acme.example>',
                'subject': 'Your Acme receipt', 'body': 'Thanks for ordering. Total €9.99'}
        r = ch.explain(CHARGE, at('2026-10-23T23:47'), at('2026-10-24T00:37'), find=Finder(others + [mine]),
                       said=nobody)
        self.assertEqual(r['verdict'], 'wait')

    def test_a_first_time_merchant_and_a_decline_go_to_him(self):
        r = ch.explain(CHARGE, at('2026-10-23T23:47'), at('2026-10-24T00:37'), find=Finder([]), said=nobody)
        self.assertEqual(r['verdict'], 'ask')
        decline = ch.parse('Transaction of AED 5.00 on your Card 2222 at ACME was declined due to insufficient limit')
        r = ch.explain(decline, at('2026-10-23T23:47'), at('2026-10-24T00:37'),
                       find=Finder([{'id': 1, 'ts': ts('2026-10-23T23:50'), 'sender': 'acme', 'subject': 'acme 5.00'}]))
        self.assertEqual(r['verdict'], 'ask')

    def test_lookups_that_fail_are_reported_and_it_asks(self):
        def broken(*a, **k):
            raise ch.Lookup('msgs exit 1')
        r = ch.explain(CHARGE, at('2026-10-23T23:47'), at('2026-10-24T00:37'), find=broken, said=broken)
        self.assertEqual(r['verdict'], 'ask')
        self.assertEqual(len(r['errors']), 3)
        with self.assertRaises(ch.Lookup):
            ch.left(0, 5)


def relayed(text, inbound='BCA7F873-4770-43DB-8E0E-7E3294F6C71A', **extra):
    """A turn as the iMessage bridge sends it: stamped 'system', the relayed id in its channel guidance."""
    guidance = f'You are the owner\'s personal assistant. Current incoming message ID: {json.dumps(inbound)}. Rest.'
    record = {'version': 1, 'contextId': 'ardud-guidance', 'label': 'Channel guidance', 'kind': 'ardud-guidance',
              'payload': {'text': guidance}}
    return {'createdBy': 'system', 'creationSource': 'server', 'text': text,
            'context': {'version': 1, 'records': [record]}, **extra}


class OwnerTexts(unittest.TestCase):
    def test_default_state_is_the_read_replica(self):
        with patch.dict(os.environ, {}, clear=True):
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        self.assertTrue(str(module.STATE_DB).endswith('/readonly/state.sqlite'))

    def test_progress_handler_bounds_a_slow_query(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'owner.sqlite'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE threads (thread_id, title, updated_at)')
                db.execute('CREATE VIEW orchestration_v2_projection_threads AS '
                           'SELECT thread_id, title, slow(updated_at) AS updated_at FROM threads')
                db.execute('CREATE TABLE orchestration_v2_projection_messages '
                           '(thread_id, role, created_at, payload_json)')
                db.executemany('INSERT INTO threads VALUES (?, ?, ?)',
                               [(str(n), 'app', '2000-01-01') for n in range(20000)])
            connect = sqlite3.connect
            def slow(value):
                time.sleep(0.0002)
                return value
            def connection(*args, **kw):
                db = connect(*args, **kw)
                db.create_function('slow', 1, slow)
                return db
            started = time.time()
            remaining = 1.5
            with patch.object(ch, 'STATE_DB', path), patch.object(ch.sqlite3, 'connect', connection):
                with self.assertRaisesRegex(ch.Lookup, 'query over time'):
                    ch.owner_texts(at('2026-10-24T03:00'), at('2026-10-24T05:00'), started + remaining)
            self.assertLess(time.time() - started, remaining + 1)

    def test_only_what_he_typed_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.sqlite'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, updated_at TEXT)')
            db.execute('CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, role TEXT, created_at TEXT, '
                       'payload_json TEXT)')
            for tid, title in (('a', 'iMessage 2026-10-24 00:30'), ('m', 'Moni'), ('g', 'Group sb_gro')):
                db.execute('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?)', (tid, title, '2026-10-24T00:00:00.000Z'))
            rows = [('a', 'user', {'createdBy': 'user', 'creationSource': 'web', 'text': 'acme is mine'}),
                    # The bridge stamps the owner's iMessage turns 'system' (control/http.ts).
                    ('a', 'user', relayed('Acme ordering now')),
                    ('a', 'user', {'createdBy': 'agent', 'text': 'acme agent'}),
                    ('a', 'user', {'createdBy': 'user', 'creationSource': 'web',
                                   'text': '[Forwarded by the owner from x] acme'}),
                    # Coord and crw wakes were stamped 'user' by the server before 27 Oct.
                    ('a', 'user', {'createdBy': 'user', 'creationSource': 'server', 'text': 'acme ordered by coord'}),
                    ('m', 'user', {'createdBy': 'user', 'creationSource': 'web', 'text': 'acme from moni'}),
                    ('g', 'user', {'createdBy': 'user', 'creationSource': 'web', 'text': 'acme in the group'}),
                    ('a', 'assistant', {'createdBy': 'user', 'creationSource': 'web', 'text': 'acme reply'})]
            for tid, role, payload in rows:
                db.execute('INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?)',
                           (tid, role, '2026-10-24T00:10:00.000Z', json.dumps(payload)))
            db.commit()
            db.close()
            with patch.object(ch, 'STATE_DB', path):
                got = ch.owner_texts(at('2026-10-24T03:00'), at('2026-10-24T05:00'))
            # Newest first, as the state DB returns the rows.
            self.assertEqual([t for _, t, _ in got], ['Acme ordering now', 'acme is mine'])
            # Automation stamped 'system' (a kanban prompt, a bracketed watcher wake) isn't his words.
            with patch.object(ch, 'STATE_DB', path):
                db = sqlite3.connect(path)
                # A kanban task and a watcher run each have their own thread, not his iMessage thread.
                db.execute('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?)',
                           ('k', 'Kanban: Apple order receipt parsing', '2026-10-24T00:00:00.000Z'))
                db.execute('INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?)',
                           ('k', 'user', '2026-10-24T00:11:00.000Z',
                            json.dumps({'createdBy': 'system', 'text': 'Review Apple order receipt parsing'})))
                db.execute('INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?)',
                           ('a', 'user', '2026-10-24T00:12:00.000Z',
                            json.dumps({'createdBy': 'system', 'text': '[Watcher] APPLE.COM/BILL USD 99 charged'})))
                db.commit()
                db.close()
                kanban = [t for _, t, _ in ch.owner_texts(at('2026-10-24T03:00'), at('2026-10-24T05:00'))]
            self.assertNotIn('Review Apple order receipt parsing', kanban)
            self.assertNotIn('[Watcher] APPLE.COM/BILL USD 99 charged', kanban)
            with patch.object(ch, 'STATE_DB', Path(tmp) / 'missing.sqlite'), self.assertRaises(ch.Lookup):
                ch.owner_texts(at('2026-10-24T03:00'), at('2026-10-24T05:00'))

    def test_a_schedule_or_wake_in_his_imessage_thread_is_not_his_words(self):
        # ScheduledTaskService sends a bound task's stored prompt into his iMessage thread as plain text, with
        # scheduledTaskId and the task's saved actor ('system', or 'user' when he made the task in the app).
        texts = {'Check my Apple order status': {'createdBy': 'system', 'creationSource': 'server',
                                                 'scheduledTaskId': 'scheduled-task:1'},
                 'Apple order is mine, check it': {'createdBy': 'user', 'creationSource': 'web',
                                                   'scheduledTaskId': 'scheduled-task:2'},
                 'I paid Apple, notification': {'createdBy': 'system', 'notification': {'kind': 'x'}},
                 'Apple order from another thread': {'createdBy': 'system', 'senderThreadId': 'thread:x'},
                 'Apple ordered by a plain control send': {'createdBy': 'system', 'creationSource': 'server'}}
        rows = [(text, {'text': text, **extra}) for text, extra in texts.items()]
        # The bridge's own turns carry made-up ids, not a relayed iMessage.
        for i, fake in enumerate(('wake:abc', 'reset:59:1793073710879', 'secret:abc')):
            rows.append((f'Apple ordering now {i}', relayed(f'Apple ordering now {i}', inbound=fake)))
        rows.append(('I am ordering Apple now', relayed('I am ordering Apple now')))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.sqlite'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, updated_at TEXT)')
            db.execute('CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, role TEXT, created_at TEXT, '
                       'payload_json TEXT)')
            db.execute('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?)',
                       ('a', 'iMessage 2026-10-24 00:30', '2026-10-24T00:00:00.000Z'))
            for _, payload in rows:
                db.execute('INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?)',
                           ('a', 'user', '2026-10-24T00:10:00.000Z', json.dumps(payload)))
            db.commit()
            db.close()
            with patch.object(ch, 'STATE_DB', path):
                got = [t for _, t, _ in ch.owner_texts(at('2026-10-24T03:00'), at('2026-10-24T05:00'))]
                self.assertEqual(got, ['I am ordering Apple now'])
                # The replay from review round 3: the scheduled prompt explains nothing, so the charge is asked.
                apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00', pending=False)
                db = sqlite3.connect(path)
                db.execute("DELETE FROM orchestration_v2_projection_messages WHERE payload_json LIKE '%I am ordering%'")
                db.commit()
                db.close()
                r = ch.explain(apple, at('2026-10-24T04:10'), at('2026-10-24T04:20'), find=Finder([]))
                self.assertEqual(r['verdict'], 'ask')


class SearchOutput(unittest.TestCase):
    def test_msgs_never_inherits_interactive_stdin(self):
        done = ch.subprocess.CompletedProcess([], 0, '', '')
        with patch.object(ch.subprocess, 'run', return_value=done) as run:
            ch.search('Acme', '2026-11-01')
            ch.show({'id': 1})
        self.assertEqual(len(run.call_args_list), 2)
        self.assertTrue(all(call.kwargs['stdin'] == ch.subprocess.DEVNULL for call in run.call_args_list))

    def test_snippets_with_unicode_line_separators_stay_one_row(self):
        rows = [{'id': 1, 'snip': 'Sincerely,\u2028Apple\x85end\x1cx'}, {'id': 2, 'snip': 'ok'}]
        out = ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows)

        class Done:
            returncode = 0
            stdout = out
            stderr = ''

        with patch.object(ch.subprocess, 'run', return_value=Done()):
            got = ch.search('Apple', '2026-11-01')
        self.assertEqual([r['id'] for r in got], [1, 2])
        self.assertEqual(got[0]['snip'], rows[0]['snip'])


if __name__ == '__main__':
    unittest.main()
