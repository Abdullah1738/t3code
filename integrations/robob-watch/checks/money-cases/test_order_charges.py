"""Registered orders with no bank proof, independent of unexplained-charge questions."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import datetime as dt
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
spec = importlib.util.spec_from_file_location('order_charge_cases', Path(__file__).with_name('cases.py'))
mc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mc)


class OrderCharges(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data, self.registry = self.root / 'money', self.root / 'tracker'
        (self.registry / 'orders').mkdir(parents=True)
        self.placed = dt.datetime(2026, 11, 13, 12, tzinfo=mc.TZ)
        self.cfg = {'app': 'acme', 'merchant': 'Acme', 'watcher': 'order-acme-123', 'order': '123',
                    'amount': '81.15', 'currency': 'AED', 'card_last4': '2342', 'for': 'moni',
                    'placed_at': self.placed.isoformat(), 'active': True}
        self.path = self.registry / 'orders' / 'order-acme-123.json'
        self.path.write_text(json.dumps(self.cfg))

    def follow(self, minutes, rows=()):
        return mc.follow_order_charges(self.data, self.placed + dt.timedelta(minutes=minutes),
                                       time.time() + 5, find=lambda *a, **kw: list(rows), registry=self.registry)

    def alert(self, **changes):
        row = {'id': 25, 'source': 'imessage', 'sender': 'EmiratesNBD',
               'ts': (self.placed + dt.timedelta(minutes=1)).timestamp(), 'from_me': 0,
               'body': 'Purchase of AED 81.15 with Credit Card ending 2342 at ACME, UAE. Available balance AED 100.'}
        row.update(changes)
        return row

    def test_opens_at_fifteen_minutes_once_and_closes_on_late_bank_charge(self):
        self.follow(14)
        self.assertEqual(mc.load(self.data)['cases'], [])
        self.follow(15)
        case = mc.load(self.data)['cases'][0]
        self.assertEqual((case['kind'], case['state'], case['who']), ('charge_unconfirmed', 'charge unconfirmed', 'Moni'))
        self.follow(30)
        self.assertEqual(len(mc.load(self.data)['cases']), 1)
        self.follow(31, [self.alert()])
        closed = mc.load(self.data)['cases'][0]
        self.assertEqual((closed['status'], closed['outcome']), ('closed', 'bank charge confirmed'))
        self.assertEqual(closed['history'][-1]['source'], 'sms:25')
        self.follow(60, [self.alert(source='email')])
        self.assertEqual(len(mc.load(self.data)['cases']), 1)
        self.assertEqual(len(mc.load(self.data)['cases'][0]['history']), 2)

    def test_matching_charge_before_first_check_never_opens_case(self):
        self.follow(15, [self.alert()])
        self.assertEqual(mc.load(self.data)['cases'], [])
        self.follow(30)
        self.assertEqual(mc.load(self.data)['cases'], [])

    def test_merchant_metadata_forms_label_and_confirm_the_order_case(self):
        forms = (
            ('native', {'app': 'noon'}, 'noon'),
            ('receipt', {'app': 'acme', 'merchant': 'Acme'}, 'Acme'),
            ('web', {'app': 'web', 'merchant_name': 'Fabrique'}, 'Fabrique'),
            ('web-empty-merchant', {'app': 'web', 'merchant': '', 'merchant_name': 'Fabrique'}, 'Fabrique'),
            ('web-null-merchant', {'app': 'web', 'merchant': None, 'merchant_name': 'Fabrique'}, 'Fabrique'),
            ('explicit-priority', {'app': 'web', 'merchant': 'Acme', 'merchant_name': 'Fabrique'}, 'Acme'),
            ('empty-name', {'app': 'noon', 'merchant_name': ''}, 'noon'),
            ('null-name', {'app': 'noon', 'merchant_name': None}, 'noon'),
        )
        for label, metadata, merchant in forms:
            with self.subTest(form=label):
                cfg = {key: value for key, value in self.cfg.items() if key != 'merchant'}
                cfg.update(metadata)
                self.path.write_text(json.dumps(cfg))
                self.data = self.root / label
                self.follow(15)
                self.assertEqual(mc.load(self.data)['cases'][0]['merchant'], merchant)
                alert = self.alert(body=self.alert()['body'].replace('ACME', merchant.upper()))
                self.follow(16, [alert])
                self.assertEqual(mc.load(self.data)['cases'][0]['status'], 'closed')
                self.data = self.root / (label + '-confirmed-first')
                self.follow(15, [alert])
                self.assertEqual(mc.load(self.data)['cases'], [])

    def test_web_merchant_identity_disambiguates_competing_orders(self):
        for source in ('web', 'receipt'):
            for same_merchant in (True, False):
                with self.subTest(peer_source=source, same_merchant=same_merchant):
                    self.data = self.root / f'peers-{source}-{same_merchant}'
                    cfg = {key: value for key, value in self.cfg.items() if key != 'merchant'}
                    cfg.update(app='web', merchant_name='Fabrique')
                    self.path.write_text(json.dumps(cfg))
                    other = dict(cfg, watcher='order-peer-456', order='456')
                    name = 'Fabrique' if same_merchant else 'Other'
                    if source == 'web':
                        other['merchant_name'] = name
                    else:
                        other.update(app=name.lower(), merchant=name)
                        other.pop('merchant_name')
                    (self.registry / 'orders' / 'other.json').write_text(json.dumps(other))
                    self.follow(15)
                    self.follow(16, [self.alert(body=self.alert()['body'].replace('ACME', 'FABRIQUE'))])
                    cases = {case['reference']: case for case in mc.load(self.data)['cases']}
                    self.assertEqual(cases['123']['status'], 'open' if same_merchant else 'closed')
                    self.assertEqual(cases['456']['status'], 'open')

    def test_bank_alert_input_class_requires_matching_identity(self):
        rows = [self.alert(body=self.alert()['body'].replace('81.15', '81.16')),
                self.alert(body=self.alert()['body'].replace('AED', 'USD')),
                self.alert(body=self.alert()['body'].replace('2342', '9546')),
                self.alert(body=self.alert()['body'].replace('ACME', 'OTHER')),
                self.alert(sender='Acme'), self.alert(from_me=1),
                self.alert(ts=(self.placed - dt.timedelta(hours=1)).timestamp()),
                self.alert(body='Your Acme order 123 receipt: AED 81.15, card 2342'),
                self.alert(body='Transaction of AED 81.15 on your Card ending 2342 at ACME was declined')]
        self.follow(15)
        for row in rows:
            with self.subTest(row=row):
                self.follow(16, [row])
                self.assertEqual(mc.load(self.data)['cases'][0]['status'], 'open')

    def test_two_same_amount_orders_have_distinct_cases(self):
        other = dict(self.cfg, watcher='order-acme-456', order='456')
        (self.registry / 'orders' / 'other.json').write_text(json.dumps(other))
        self.follow(15)
        self.follow(16)
        self.assertEqual(len(mc.load(self.data)['cases']), 2)
        self.follow(17, [self.alert()])
        self.assertTrue(all(case['status'] == 'open' for case in mc.load(self.data)['cases']))

    def test_removed_tracker_does_not_prevent_late_charge_closure(self):
        self.follow(15)
        self.path.unlink()
        self.follow(30, [self.alert()])
        self.assertEqual(mc.load(self.data)['cases'][0]['status'], 'closed')

    def test_charge_allocation_time_class(self):
        for gap in (5, 15, 20, 60, 120):
            with self.subTest(minutes_between_orders=gap):
                self.data = self.root / ('money-' + str(gap))
                other = dict(self.cfg, watcher='order-acme-456', order='456',
                             placed_at=(self.placed + dt.timedelta(minutes=gap)).isoformat())
                (self.registry / 'orders' / 'other.json').write_text(json.dumps(other))
                self.follow(gap + 15)
                alert = self.alert(ts=(self.placed + dt.timedelta(minutes=gap + 1)).timestamp())
                self.follow(gap + 16, [alert])
                self.assertTrue(all(case['status'] == 'open' for case in mc.load(self.data)['cases']))

    def test_archive_outage_stays_unconfirmed(self):
        def broken(*args, **kw):
            raise mc.charges.Lookup('fixture archive unavailable')
        errors = mc.follow_order_charges(self.data, self.placed + dt.timedelta(minutes=15), time.time()+5,
                                        find=broken, registry=self.registry)
        self.assertIn('fixture archive unavailable', errors[0])
        self.assertEqual(mc.load(self.data)['cases'][0]['status'], 'open')

    def test_delayed_bank_charge_closes_unresolved_case(self):
        for minutes in (36 * 60 - 1, 36 * 60, 36 * 60 + 1, 48 * 60, 7 * 24 * 60, 30 * 24 * 60):
            for source in ('email', 'imessage'):
                with self.subTest(delay_minutes=minutes, source=source):
                    self.data = self.root / f'money-{minutes}-{source}'
                    self.follow(15)
                    self.assertEqual(mc.load(self.data)['cases'][0]['status'], 'open')
                    alert = self.alert(source=source, ts=(self.placed + dt.timedelta(minutes=minutes)).timestamp())
                    self.follow(minutes + 1, [alert])
                    case = mc.load(self.data)['cases'][0]
                    self.assertEqual((case['status'], case['outcome']), ('closed', 'bank charge confirmed'))
                    self.follow(minutes + 2, [alert])
                    self.assertEqual(len(mc.load(self.data)['cases'][0]['history']), 2)

    def test_delayed_alert_cannot_confirm_two_unresolved_orders(self):
        other = dict(self.cfg, watcher='order-acme-456', order='456',
                     placed_at=(self.placed + dt.timedelta(minutes=20)).isoformat())
        (self.registry / 'orders' / 'other.json').write_text(json.dumps(other))
        self.follow(35)
        alert = self.alert(ts=(self.placed + dt.timedelta(hours=48)).timestamp())
        self.follow(48 * 60 + 1, [alert])
        self.assertEqual(len(mc.load(self.data)['cases']), 2)
        self.assertTrue(all(case['status'] == 'open' for case in mc.load(self.data)['cases']))


if __name__ == '__main__':
    unittest.main()
