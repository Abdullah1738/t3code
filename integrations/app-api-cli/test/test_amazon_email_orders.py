"""Synthetic mail and structure-only reconstructions of 2026-10 Amazon.ae mail.

No production body, address, order/shipment ID, message ID or private link is saved.
"""
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
from email.message import EmailMessage
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import amazon_email_orders as a

OID = '123-1234567-1234567'
OTHER = '123-7654321-7654321'
OBSERVED = '2026-10-08T10:00:00+00:00'
NOW = dt.datetime.fromisoformat(OBSERVED)


def mail(subject, body, *, sender='Amazon.ae <status@amazon.ae>',
         date='Tue, 06 Oct 2026 08:39:37 +0400', mid='fixture', html=False):
    m = EmailMessage()
    m['From'], m['Subject'], m['Message-ID'] = sender, subject, f'<{a.digest(mid)}@example.invalid>'
    if date is not None:
        m['Date'] = date
    m.set_content(body, subtype='html' if html else 'plain')
    return m.as_bytes()


def item_lines(items):
    return '\n'.join(f'{name}\nQuantity: {quantity}' for name, quantity in items)


def confirmation(items=(('Fixture Product A', 1),), oid=OID, **kwargs):
    # Real plaintext layout: all four progress labels are present in Ordered mail.
    body = ('Thanks for your order!\nOrdered\nShipped\nOut for delivery\nDelivered\n'
            f'Order #\n{oid}\nView or edit order\n'
            f'https://www.amazon.ae/example?orderID={oid}\n' +
            '\n'.join(item_lines([item]) + '\nAED 10.00' for item in items) +
            '\nTotal\nAED 10.00\n')
    return mail('Ordered: "Fixture Product A"', body, mid='confirmation-' + oid, **kwargs)


def shipment(stage='Delivered: "Fixture Product A"', items=(('Fixture Product A', 1),),
             oid=OID, sid='SYNTHETIC-SHIPMENT-1', **kwargs):
    return mail(stage, f'Your package status\nOrder #\n{oid}\nTrack package\n'
                f'https://www.amazon.ae/example?orderId={oid}&shipmentId={sid}&packageIndex=0\n'
                + item_lines(items), mid=kwargs.pop('mid', stage + sid), **kwargs)


def parse(raw, **kwargs):
    return a.parse_message(raw, observed_at=OBSERVED, account='gmail', folder='[Gmail]/All Mail', **kwargs)


def aggregate(*raws, **kwargs):
    return a.aggregate_order(OID, [e for raw in raws for e in parse(raw)], **kwargs)


class ParserTests(unittest.TestCase):
    def test_sanitized_real_ordered_template_is_not_delivered(self):
        events = parse(confirmation())
        self.assertEqual(events[0]['stage'], 'confirmed')
        self.assertTrue(events[0]['manifest_complete'])
        self.assertEqual(events[0]['scope'], 'order')

    def test_sanitized_real_delivered_elapsed_subject(self):
        for subject in ['Delivered in 11 hrs 23 mins', 'Delivered in 2 hours',
                        'Delivered: "Fixture"']:
            with self.subTest(subject=subject):
                self.assertEqual(parse(shipment(subject))[0]['stage'], 'delivered')

    def test_shipped_ofd_delivery_scopes(self):
        for subject, expected in [('Shipped: "Fixture"', 'shipped'),
                                  ('Dispatched: "Fixture"', 'shipped'),
                                  ('Out for delivery: "Fixture"', 'out for delivery'),
                                  ('Your package was delivered', 'delivered')]:
            e = parse(shipment(subject))[0]
            self.assertEqual((e['stage'], e['scope']), (expected, 'shipment'))

    def test_cancel_return_refund_not_delivery(self):
        for subject, expected in [('Cancelled: "Fixture"', 'cancelled'),
                                  ('Your order has been cancelled', 'cancelled'),
                                  ('Your return of Fixture...', 'return_requested'),
                                  ('Return received: Fixture', 'returned'),
                                  ('Refund issued: Fixture', 'refunded')]:
            e = parse(shipment(subject))[0]
            self.assertEqual(e['stage'], expected)
            self.assertEqual(e['scope'], 'item')

    def test_future_hypothetical_negated_and_forward_subjects(self):
        for subject in ['Your package will be delivered today',
                        'Your package is expected to be delivered',
                        'When your order is delivered', 'If your order is delivered',
                        'Your order should be delivered', 'Return label: Delivered package',
                        'Delivery instructions', 'Re: Delivered: Fixture',
                        'Fwd: Delivered: Fixture', 'Your order has not shipped',
                        'Your order cannot be cancelled', 'Cancellation request received',
                        'How to cancel your order', 'Your order has not been delivered']:
            with self.subTest(subject=subject):
                self.assertNotIn(a.classify_subject(subject), ('delivered', 'cancelled', 'shipped'))

    def test_trusted_sender_not_display_name_or_suffix(self):
        for sender in ['Amazon <status@evil.invalid>', 'Amazon <x@amazon.ae.evil.invalid>',
                       'Amazon <x@fakeamazon.ae>', 'Amazon <x@amazon-ae.invalid>',
                       'x@amazon.ae, y@evil.invalid']:
            self.assertEqual(parse(shipment(sender=sender)), [])
        self.assertEqual(len(parse(shipment(sender='Amazon <x@ship.amazon.ae>'))), 1)
        # Amazon display names can contain an unquoted comma; policy header parser
        # accepts the observed one-address form where parseaddr may return empty.
        self.assertEqual(a.sender_domain('"Amazon, Returns" <returns@amazon.ae>'), 'amazon.ae')

    def test_forwarded_body_and_attachment_are_not_evidence(self):
        body = ('---------- Forwarded message ----------\n'
                f'Order #\n{OID}\nYour package was delivered')
        self.assertEqual(parse(mail('Delivered: Fixture', body)), [])
        outer = EmailMessage()
        outer['From'], outer['Subject'] = 'x@amazon.ae', 'Delivered: Fixture'
        outer.set_content('Nothing here')
        outer.add_attachment(shipment(), maintype='message', subtype='rfc822')
        self.assertEqual(parse(outer.as_bytes()), [])

    def test_exact_id_required(self):
        self.assertEqual(parse(mail('Delivered: Fixture', 'No order number')), [])
        for bad in [OID + '1', 'x' + OID, OID + '-x']:
            self.assertEqual(parse(mail('Delivered: Fixture', 'Order # ' + bad)), [])
        e = parse(shipment())[0]
        self.assertEqual(e['order_id'], OID)

    def test_links_only_from_trusted_domains_and_nested_redirects(self):
        good = f'https://www.amazon.ae/example?orderId={OID}&shipmentId=SYNTHETIC'
        from urllib.parse import quote
        e = parse(mail('Delivered: Fixture', 'https://www.amazon.ae/redirect?U=' + quote(good, safe='')))[0]
        self.assertEqual(e['order_id'], OID)
        self.assertEqual(len(e['shipment_keys']), 1)
        self.assertEqual(parse(mail('Delivered: Fixture', good.replace('www.amazon.ae', 'evil.invalid'))), [])

    def test_separate_evidence_and_observation_time(self):
        e = parse(shipment())[0]
        self.assertEqual(e['evidence_at'], '2026-10-06T04:39:37+00:00')
        self.assertEqual(e['observed_at'], OBSERVED)
        self.assertEqual(e['evidence_time_source'], 'email_date_header')
        for date in [None, 'Tue, 06 Oct 2026 08:39:37 -0000']:
            e = parse(shipment(date=date))[0]
            self.assertIsNone(e['evidence_at'])
            self.assertEqual(e['observed_at'], OBSERVED)
        e = parse(shipment(date='Fri, 09 Oct 2026 08:00:00 +0000'))[0]
        self.assertEqual(e['stage'], 'unknown')
        self.assertIn('future_message_date', e['warnings'])

    def test_html_only_and_multipart_prefer_plain(self):
        raw = mail('Delivered: Fixture', f'<html><head><style>Delivered</style></head><body>'
                   f'<div>Order #</div><div>{OID}</div><p>Fixture Product A</p>'
                   f'<p>Quantity: 1</p><a href="https://www.amazon.ae/example?orderId={OID}'
                   '&amp;shipmentId=SYNTHETIC">Track</a></body></html>', html=True)
        e = parse(raw)[0]
        self.assertEqual(e['order_id'], OID)
        self.assertEqual(e['items'], parse(shipment())[0]['items'])
        m = a.email.message_from_bytes(shipment(), policy=a.email.policy.default)
        m.add_alternative('<p>Ignore HTML alternative</p>', subtype='html')
        self.assertEqual(len(parse(m.as_bytes())), 1)

    def test_two_orders_in_one_confirmation_have_separate_manifests(self):
        first = a._body(a.email.message_from_bytes(confirmation(), policy=a.email.policy.default))
        second = a._body(a.email.message_from_bytes(confirmation((('Fixture B', 2),), OTHER), policy=a.email.policy.default))
        events = parse(mail('Ordered: Fixture', first + second))
        self.assertEqual({e['order_id'] for e in events}, {OID, OTHER})
        self.assertTrue(all(e['manifest_complete'] for e in events))
        self.assertEqual({sum(i['quantity'] for i in e['items']) for e in events}, {1, 2})

    def test_projection_never_contains_body_title_address_or_private_link(self):
        raw = shipment(items=(('SENSITIVE-TITLE-DO-NOT-OUTPUT', 1),))
        result = json.dumps(parse(raw))
        for secret in ['SENSITIVE-TITLE', 'https://', '?orderId', '@example.invalid', 'SYNTHETIC-SHIPMENT']:
            self.assertNotIn(secret, result)


class ReducerTests(unittest.TestCase):
    def test_manifest_rejects_unparsed_item_before_or_after_total(self):
        m = a.email.message_from_bytes(confirmation(), policy=a.email.policy.default)
        body = a._body(m)
        for corrupt in [body.replace('Total\n', 'Unparsed second product\nTotal\n'),
                        body + '\nUnparsed second product\nQuantity: 1\n',
                        body.replace('Quantity: 1\n', ''),
                        body.replace('AED 10.00\nTotal', 'not a price\nTotal')]:
            with self.subTest(corrupt=corrupt):
                r = aggregate(mail('Ordered: Fixture', corrupt), shipment())
                self.assertFalse(r['manifest']['complete'])
                self.assertFalse(r['whole_order_delivered'])

    def test_equal_timestamp_conflicting_shipment_stages_block_closure(self):
        r = aggregate(confirmation(), shipment(), shipment('Shipped: Fixture'))
        self.assertFalse(r['whole_order_delivered'])
        self.assertIn('conflicting_shipment_stages_at_same_time', r['coverage']['reasons'])

    def test_incomplete_confirmation_and_reversed_chronology_block_closure(self):
        incomplete = mail('Ordered: Fixture', f'Order #\n{OID}\nFixture B\nQuantity: 1')
        self.assertFalse(aggregate(confirmation(), incomplete, shipment())['whole_order_delivered'])
        self.assertFalse(aggregate(confirmation(date='Wed, 07 Oct 2026 08:00:00 +0000'),
                                   shipment())['whole_order_delivered'])

    def test_delivered_without_confirmation_is_only_partial(self):
        r = aggregate(shipment())
        self.assertEqual(r['status'], 'partially_delivered')
        self.assertFalse(r['whole_order_delivered'])
        self.assertFalse(r['terminal'])

    def test_complete_single_package(self):
        r = aggregate(confirmation(), shipment())
        self.assertEqual(r['status'], 'delivered')
        self.assertTrue(r['whole_order_delivered'])
        self.assertEqual(r['coverage']['reasons'], [])

    def test_multipackage_requires_every_item_and_shipment(self):
        c = confirmation((('Fixture Product A', 1), ('Fixture B', 2)))
        first = shipment()
        second_pending = shipment('Shipped: Fixture B', (('Fixture B', 2),), sid='SYNTHETIC-2',
                                  date='Tue, 06 Oct 2026 07:00:00 +0000')
        second_done = shipment(items=(('Fixture B', 2),), sid='SYNTHETIC-2',
                               date='Tue, 06 Oct 2026 08:00:00 +0000')
        self.assertFalse(aggregate(c, first)['whole_order_delivered'])
        self.assertFalse(aggregate(c, first, second_pending)['whole_order_delivered'])
        r = aggregate(c, first, second_pending, second_done)
        self.assertTrue(r['whole_order_delivered'])
        self.assertEqual(len(r['shipments']), 2)

    def test_quantity_shortfall_and_overcount_fail_closed(self):
        c = confirmation((('Fixture Product A', 2),))
        self.assertFalse(aggregate(c, shipment())['whole_order_delivered'])
        c = confirmation()
        self.assertFalse(aggregate(c, shipment(), shipment(sid='SYNTHETIC-2'))['whole_order_delivered'])

    def test_duplicate_message_and_duplicate_snapshots_not_counted_twice(self):
        events = parse(confirmation()) + parse(shipment()) * 2 + parse(shipment(mid='copy'))
        r = a.aggregate_order(OID, events)
        self.assertTrue(r['whole_order_delivered'])
        self.assertEqual(len(r['evidence']), 3)
        self.assertEqual(len(r['shipments']), 1)

    def test_duplicate_mailbox_aliases_survive_reduction_without_mutating_inputs(self):
        raw = shipment()
        gmail = parse(raw, uid=99)[0]
        outlook = a.parse_message(raw, account='outlook', folder='Archive', uid=123,
                                  observed_at='2026-10-08T10:01:00+00:00')[0]
        self.assertEqual(gmail['event_id'], outlook['event_id'])
        originals = json.dumps([gmail, outlook], sort_keys=True)
        expected = ['gmail:[Gmail]/All Mail:99', 'outlook:Archive:123']
        for copies in ([gmail, outlook, gmail], [outlook, gmail, outlook]):
            with self.subTest(first=copies[0]['account']):
                result = a.aggregate_order(OID, parse(confirmation()) + copies)
                self.assertTrue(result['whole_order_delivered'])
                self.assertEqual(len(result['shipments']), 1)
                self.assertEqual(len(result['evidence']), 2)
                event = next(e for e in result['evidence'] if e['stage'] == 'delivered')
                self.assertEqual(event.get('mailbox_aliases'), expected)
                self.assertEqual(event['event_id'], gmail['event_id'])
                self.assertEqual(event['observed_at'], gmail['observed_at'])
                self.assertEqual(event['evidence_at'], gmail['evidence_at'])
                self.assertEqual(event['account'], 'gmail')
        self.assertEqual(json.dumps([gmail, outlook], sort_keys=True), originals)

    def test_mailbox_alias_union_is_idempotent_for_already_reduced_evidence(self):
        raw = shipment()
        gmail = parse(raw, uid=99)[0]
        outlook = a.parse_message(raw, account='outlook', folder='Archive', uid=123,
                                  observed_at=OBSERVED)[0]
        first = a.aggregate_order(OID, [gmail, outlook])
        before = json.dumps(first, sort_keys=True)
        archive = a.parse_message(raw, account='gmail', folder='[Gmail]/Spam', uid=456,
                                  observed_at='2026-10-08T09:59:00+00:00')[0]
        second = a.aggregate_order(OID, first['evidence'] + [archive, outlook])
        self.assertEqual(second['evidence'][0].get('mailbox_aliases'),
                         ['gmail:[Gmail]/All Mail:99', 'gmail:[Gmail]/Spam:456',
                          'outlook:Archive:123'])
        self.assertEqual(second['evidence'][0]['observed_at'], archive['observed_at'])
        self.assertEqual(second, a.aggregate_order(OID, second['evidence'] * 2))
        self.assertEqual(json.dumps(first, sort_keys=True), before)

    def test_cross_order_combined_package_is_not_claimed_whole(self):
        c = confirmation()
        shipped = shipment('Shipped: Fixture')
        combined = shipment(items=(('Fixture Product A', 1), ('Fixture B', 1)),
                            date='Tue, 06 Oct 2026 08:00:00 +0000')
        r = aggregate(c, shipped, combined)
        self.assertFalse(r['whole_order_delivered'])
        self.assertIn('shipment_contents_changed_or_ambiguous', r['coverage']['reasons'])

    def test_same_item_in_two_orders_cannot_share_one_package_unit(self):
        raw = shipment()
        m = a.email.message_from_bytes(raw, policy=a.email.policy.default)
        m.set_content(a._body(m) + f'\nOrder #\n{OTHER}\n')
        r = aggregate(confirmation(), m.as_bytes())
        self.assertFalse(r['whole_order_delivered'])
        self.assertIn('multi_order_shipment_allocation_unproven', r['coverage']['reasons'])

    def test_extra_unmapped_package_item_is_not_whole_even_without_dispatch(self):
        r = aggregate(confirmation(), shipment(items=(('Fixture Product A', 1), ('Fixture B', 1))))
        self.assertFalse(r['whole_order_delivered'])
        self.assertIn('shipment_contains_unmapped_items', r['coverage']['reasons'])

    def test_same_message_id_conflicting_contents_are_not_deduplicated(self):
        r = aggregate(confirmation(), confirmation((('Fixture Product A', 2),)), shipment())
        self.assertFalse(r['manifest']['complete'])
        self.assertFalse(r['whole_order_delivered'])

    def test_scan_failure_blocks_whole_but_keeps_package_proof(self):
        r = aggregate(confirmation(), shipment(), scan_complete=False)
        self.assertEqual(r['status'], 'partially_delivered')
        self.assertTrue(r['coverage']['delivered_package_evidence'])

    def test_cancel_return_not_terminal_without_reconciliation(self):
        for subject in ['Cancelled: Fixture', 'Your return of Fixture', 'Return received: Fixture']:
            r = aggregate(confirmation(), shipment(), shipment(subject))
            self.assertFalse(r['terminal'])
            self.assertFalse(r['whole_order_delivered'])

    def test_missing_time_unbound_shipments_conflicting_manifests(self):
        for extra in [shipment(date=None),
                      mail('Delivered: Fixture', f'Order #\n{OID}\nFixture Product A\nQuantity: 1'),
                      confirmation((('Fixture Product A', 2),))]:
            self.assertFalse(aggregate(confirmation(), shipment(), extra)['whole_order_delivered'])

    def test_unknown_manifest_is_not_completed_by_package_count(self):
        raw = mail('Ordered: Fixture', f'Order #\n{OID}\nFixture Product A\nQuantity: 1')
        self.assertFalse(aggregate(raw, shipment())['whole_order_delivered'])


class FakeMailsearch:
    def __init__(self, messages=None, *, failures=None, total=None, delay=0):
        self.messages = messages or {1: confirmation(), 2: shipment()}
        self.calls, self.failures, self.total, self.delay = [], failures or {}, total, delay

    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[1] == 'read':
            uid = int(args[4])
            if self.delay:
                time.sleep(min(self.delay, kwargs['timeout']))
                if self.delay >= kwargs['timeout']:
                    raise subprocess.TimeoutExpired(args, kwargs['timeout'])
            if uid in self.failures:
                return subprocess.CompletedProcess(args, 1, '', self.failures[uid])
            return subprocess.CompletedProcess(args, 0, self.messages[uid].decode(), '')
        hits = []
        for uid, raw in self.messages.items():
            m = a.email.message_from_bytes(raw, policy=a.email.policy.default)
            hits.append({'account': 'gmail', 'folder': '[Gmail]/All Mail', 'uid': uid,
                         'from': str(m['From']), 'subject': str(m['Subject']),
                         'message_id': str(m['Message-ID']), 'folder_total': self.total or len(self.messages)})
        status = {acct: {'ok': True, 'hits': len(hits) if acct == 'gmail' else 0} for acct in a.ACCOUNTS}
        if 'account' in self.failures:
            status['outlook'] = {'ok': False, 'error': self.failures['account']}
        return subprocess.CompletedProcess(args, int('account' in self.failures),
                                           json.dumps({'status': status, 'hits': hits}), '')


class ScanTests(unittest.TestCase):
    def test_corrupted_mailsearch_sender_does_not_hide_real_return(self):
        fake = FakeMailsearch(messages={1: confirmation(), 2: shipment(),
                                        3: shipment('Your return of Fixture')})

        def runner(args, **kwargs):
            p = fake(args, **kwargs)
            if args[1] != 'read':
                data = json.loads(p.stdout)
                data['hits'][2]['from'] = 'returns@amazon.ae <>'
                p.stdout = json.dumps(data)
            return p

        r = a.track(OID, runner=runner, now=NOW)
        self.assertEqual(r['status'], 'return_requested')
        self.assertFalse(r['whole_order_delivered'])

    def test_untrusted_discovery_envelope_never_becomes_evidence(self):
        fake = FakeMailsearch(messages={1: shipment(sender='Amazon <x@evil.invalid>')})
        r = a.track(OID, runner=fake, now=NOW)
        self.assertEqual(r['status'], 'unknown')
        self.assertEqual(r['evidence'], [])

    def test_all_accounts_first_then_only_matched_mailboxes_and_peek_cli(self):
        fake = FakeMailsearch()
        r = a.track(OID, runner=fake, now=NOW, since='2026-10-05')
        first = fake.calls[0][0]
        for account in a.ACCOUNTS:
            self.assertIn(account, first)
        self.assertEqual(first[-1], 'from:amazon after:2026/10/04 before:2026/10/10')
        self.assertTrue(r['whole_order_delivered'])
        for args, kwargs in fake.calls[1:]:
            self.assertEqual(args[:4], ['mailsearch', 'read', 'gmail', '[Gmail]/All Mail'])
            self.assertEqual(args[-1], '--raw')
            self.assertNotIn('--seen', args)
            self.assertLessEqual(kwargs['timeout'], 12)
        self.assertEqual(r['source'], 'amazon_email')
        self.assertFalse(r['coverage']['native_order_api'])

    def test_account_and_read_errors_are_explicit_without_raw_error(self):
        fake = FakeMailsearch(failures={'account': 'AUTH secret@private.invalid token=SECRET'})
        r = a.track(OID, runner=fake, now=NOW)
        self.assertEqual(r['status'], 'partially_delivered')
        self.assertIn({'code': 'account_unavailable', 'account': 'outlook'}, r['errors'])
        self.assertNotIn('SECRET', json.dumps(r))
        fake = FakeMailsearch(failures={1: 'private authentication diagnostic'})
        r = a.track(OID, runner=fake, now=NOW)
        self.assertEqual(r['errors'][0]['code'], 'message_read_failed')
        self.assertFalse(r['whole_order_delivered'])

    def test_truncation_and_read_cap_are_errors(self):
        for options in [dict(runner=FakeMailsearch(total=3)),
                        dict(runner=FakeMailsearch(), max_reads=1)]:
            r = a.track(OID, now=NOW, **options)
            self.assertTrue(r['errors'])
            self.assertFalse(r['coverage']['complete'])
            self.assertFalse(r['whole_order_delivered'])

    def test_overall_deadline_not_per_message_times_reads(self):
        fake = FakeMailsearch(delay=2)
        start = time.monotonic()
        r = a.orders(runner=fake, now=NOW, timeout=1)
        self.assertLess(time.monotonic() - start, 1.4)
        self.assertTrue(r['errors'])

    def test_search_timeout_unknown_with_all_account_errors(self):
        def runner(*args, **kwargs):
            raise subprocess.TimeoutExpired(args[0], kwargs['timeout'])
        r = a.track(OID, runner=runner, now=NOW)
        self.assertEqual(r['status'], 'unknown')
        self.assertEqual(len(r['coverage']['accounts']), len(a.ACCOUNTS))
        self.assertEqual(r['coverage']['read_attempts'], 0)

    def test_track_filters_exact_target_orders_lists_observed_only(self):
        fake = FakeMailsearch(messages={1: shipment(), 2: shipment(oid=OTHER)})
        r = a.orders(runner=fake, now=NOW)
        self.assertEqual({o['order_id'] for o in r['orders']}, {OID, OTHER})
        r = a.track('999-9999999-9999999', runner=fake, now=NOW)
        self.assertEqual(r['status'], 'unknown')
        self.assertEqual(r['evidence'], [])

    def test_explicit_accounts_and_validation(self):
        r = a.orders(runner=FakeMailsearch(), now=NOW, accounts=['gmail'])
        self.assertEqual(r['coverage']['account_scope'], 'explicit_accounts')
        for opts in [dict(order_id=OID + '1'), dict(accounts=['moni']), dict(days=367),
                     dict(since='2020-01-01'), dict(since='2027-01-01'), dict(max_reads=0)]:
            with self.assertRaises(ValueError):
                a._scan(runner=FakeMailsearch(), now=NOW, **opts)

    def test_no_network_or_process_on_import(self):
        spec = importlib.util.spec_from_file_location('isolated_amazon_email', a.__file__)
        module = importlib.util.module_from_spec(spec)
        with patch.object(socket, 'socket', side_effect=AssertionError('network')), \
             patch.object(subprocess, 'run', side_effect=AssertionError('process')):
            spec.loader.exec_module(module)


if __name__ == '__main__':
    unittest.main()
