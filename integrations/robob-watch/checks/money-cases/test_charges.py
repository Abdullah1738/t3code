"""Reading card alerts and finding what explains a charge: receipts, his own words, a merchant he pays."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
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


class OwnerTexts(unittest.TestCase):
    def test_only_what_he_typed_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.sqlite'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, updated_at TEXT)')
            db.execute('CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, role TEXT, created_at TEXT, '
                       'payload_json TEXT)')
            for tid, title in (('a', 'iMessage 2026-10-24 00:30'), ('m', 'Moni'), ('g', 'Group sb_gro')):
                db.execute('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?)', (tid, title, '2026-10-24T00:00:00.000Z'))
            rows = [('a', 'user', {'createdBy': 'user', 'text': 'acme is mine'}),
                    ('a', 'user', {'createdBy': 'agent', 'text': 'acme agent'}),
                    ('a', 'user', {'createdBy': 'user', 'text': '[Forwarded by the owner from x] acme'}),
                    ('m', 'user', {'createdBy': 'user', 'text': 'acme from moni'}),
                    ('g', 'user', {'createdBy': 'user', 'text': 'acme in the group'}),
                    ('a', 'assistant', {'createdBy': 'user', 'text': 'acme reply'})]
            for tid, role, payload in rows:
                db.execute('INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?)',
                           (tid, role, '2026-10-24T00:10:00.000Z', json.dumps(payload)))
            db.commit()
            db.close()
            with patch.object(ch, 'STATE_DB', path):
                got = ch.owner_texts(at('2026-10-24T03:00'), at('2026-10-24T05:00'))
            self.assertEqual([t for _, t, _ in got], ['acme is mine'])
            with patch.object(ch, 'STATE_DB', Path(tmp) / 'missing.sqlite'), self.assertRaises(ch.Lookup):
                ch.owner_texts(at('2026-10-24T03:00'), at('2026-10-24T05:00'))


if __name__ == '__main__':
    unittest.main()
