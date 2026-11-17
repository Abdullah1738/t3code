"""Reading card alerts and finding what explains a charge: receipts, his own words, a merchant he pays."""
import datetime as dt
from collections import Counter
import importlib.util
import json
import os
import re
from pathlib import Path
import http.server
import threading
import urllib.parse
import sys
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
spec = importlib.util.spec_from_file_location('charges', Path(__file__).with_name('charges.py'))
ch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ch)

TZ = ch.TZ


def summary(text, **extra):
    return {'role': 'user', 'messageId': text, 'text': text, 'createdAt': '2026-10-24T00:10:00.000Z',
            'createdBy': 'user', 'creationSource': 'web', 'automated': False, 'inboundMessageId': None, **extra}


class ReadOnlySearchCache(unittest.TestCase):
    def test_closed_search_reads_cache_but_never_saves_in_read_only_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cache = root / 'msgs-searches.json'
            cache.write_text('{}\n')
            binary = root / 'msgs'
            binary.write_text('#!/bin/sh\nexit 0\n')
            binary.chmod(0o700)
            before = cache.read_bytes(), cache.stat().st_mtime_ns
            memo = {('msgs_cache',): cache, ('write_cache',): False}
            with patch.object(ch, 'MSGS', str(binary)):
                self.assertEqual(ch.search('receipt', '2026-10-23', until='2026-10-24', memo=memo), [])
                self.assertEqual((cache.read_bytes(), cache.stat().st_mtime_ns), before)
                self.assertEqual(ch.search('receipt', '2026-10-23', until='2026-10-24',
                                           memo={('msgs_cache',): cache}, write_cache=False), [])
                self.assertEqual((cache.read_bytes(), cache.stat().st_mtime_ns), before)
                ch.search('receipt', '2026-10-23', until='2026-10-24', memo={('msgs_cache',): cache})
                self.assertNotEqual(cache.read_bytes(), before[0])
                saved = cache.read_bytes(), cache.stat().st_mtime_ns
                with patch.object(ch, 'msgs', side_effect=AssertionError('cache miss')):
                    self.assertEqual(ch.search('receipt', '2026-10-23', until='2026-10-24', memo=memo), [])
                self.assertEqual((cache.read_bytes(), cache.stat().st_mtime_ns), saved)


    def test_owner_cache_default_path_is_read_only_even_when_corrupt_or_missing(self):
        for content in ('{}\n', '{bad json', None):
            with self.subTest(content=content), ControlServer([summary('owner words')]) as server:
                cache = Path(server.tmp.name) / 'owner-texts.json'
                if content is not None:
                    cache.write_text(content)
                before = (cache.read_bytes(), cache.stat().st_mtime_ns) if cache.exists() else None
                with patch.dict(os.environ, {'ROBOB_TOOL_LOG_DIR': str(Path(server.tmp.name) / 'logs'),
                                             'TOOLLOG_ROOT': str(Path(server.tmp.name) / 'logs')}):
                    rows = ch.owner_texts(at('2026-10-24T03:00'), at('2026-10-24T05:00'), write_cache=False)
                self.assertEqual(len(rows), 1)
                after = (cache.read_bytes(), cache.stat().st_mtime_ns) if cache.exists() else None
                self.assertEqual(after, before)


class ControlServer:
    """Loopback-only control fixtures. Never reads credentials or state from the real home."""
    def __init__(self, rows=None, threads=None, stall=None, drip=False, page_size=500,
                 message_delay=0, stall_cursor=None, strict_since=False):
        self.rows = {'a': rows or []}
        self.threads = threads if threads is not None else [{'threadId': 'a', 'title': 'iMessage test',
                           'creationSource': 'server', 'origin': 'imessage'}]
        self.threads = [{'updatedAt': '2026-10-24T01:00:00.000Z', **thread} for thread in self.threads]
        self.calls = []
        self.stall, self.drip = stall, drip
        self.page_size, self.message_delay, self.stall_cursor = page_size, message_delay, stall_cursor
        self.strict_since = strict_since
        self.active_messages = self.max_active_messages = 0
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.status = 200
        self.raw = None
        self.responses = {}
        self.wire_mode = None
        self.declared_extra = 0
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                path = urllib.parse.urlsplit(self.path)
                params = urllib.parse.parse_qs(path.query)
                owner.calls.append((path.path, params, self.headers.get('Authorization')))
                if owner.stall and owner.stall in path.path:
                    owner.stop.wait(5)
                if owner.stall_cursor and params.get('cursor') == [owner.stall_cursor]:
                    owner.stop.wait(5)
                if path.path.endswith('/threads'):
                    threads = [t for t in owner.threads
                               if ('creationSource' not in params or t.get('creationSource', 'web')
                                   in params['creationSource'][0].split(','))
                               and ('origin' not in params or t.get('origin') == params['origin'][0])
                               and (params.get('includeSubagents') == ['true'] or not t.get('subagent'))]
                    offset = int(params.get('cursor', ['0'])[0])
                    limit = min(int(params.get('limit', ['50'])[0]), owner.page_size)
                    page = threads[offset:offset + limit]
                    cursor = str(offset + limit) if offset + limit < len(threads) else None
                    data = {'ok': True, 'threads': page, 'total': len(threads), 'nextCursor': cursor}
                else:
                    with owner.lock:
                        owner.active_messages += 1
                        owner.max_active_messages = max(owner.max_active_messages, owner.active_messages)
                    owner.stop.wait(owner.message_delay)
                    rows = owner.rows.get(urllib.parse.unquote(path.path.split('/')[-2]), [])
                    if owner.strict_since:
                        rows = [row for row in rows if row.get('role') == params.get('role', [row.get('role')])[0]
                                and ch.owner_time(row.get('updatedAt', row['createdAt']))
                                > ch.owner_time(params['since'][0])]
                    data = {'ok': True, 'messages': rows, 'total': len(rows)}
                    with owner.lock:
                        owner.active_messages -= 1
                data = owner.responses.get(path.path, data)
                body = owner.raw if owner.raw is not None else json.dumps(data).encode()
                if owner.wire_mode and path.path.endswith('/messages'):
                    try:
                        self.wfile.write(b'HTTP/1.1 200 OK\r\n')
                        if owner.wire_mode == 'chunk-framing':
                            self.wfile.write(b'Transfer-Encoding: chunked\r\n\r\n')
                        else:
                            self.wfile.write(b'X-Slow: ')
                        while not owner.stop.wait(0.05):
                            self.wfile.write(b'F')
                            self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return
                self.send_response(owner.status)
                if owner.declared_extra and path.path.endswith('/messages'):
                    self.send_header('Content-Length', str(len(body) + owner.declared_extra))
                self.end_headers()
                try:
                    if owner.drip and (owner.drip is True or owner.drip in path.path):
                        while not owner.stop.wait(0.05):
                            self.wfile.write(b' ')
                            self.wfile.flush()
                    else:
                        self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.credentials = Path(self.tmp.name) / 'control.json'
        self.credentials.write_text(json.dumps({'url': f'http://127.0.0.1:{self.server.server_port}',
                                                'token': 'test-secret-never-print'}))
        self.credentials.chmod(0o600)
        self.env = patch.dict(os.environ, {'T3_CONTROL_TOKEN_FILE': str(self.credentials),
                                          'MONEY_CASES_DIR': self.tmp.name})
        self.env.start()
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.env.stop()
        self.tmp.cleanup()


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


class AlertText(unittest.TestCase):
    def test_receipt_queries_keep_money_forms_without_bare_integers(self):
        for amount in ('0.00', '1.00', '9.00', '10.00', '1000.00', '1.25'):
            with self.subTest(amount=amount):
                queries = []
                charge = dict(kind='charge', currency='AED', amount=amount, card='1111', merchant='Acme')
                ch.receipt(charge, dt.datetime(2026, 10, 24, tzinfo=TZ),
                           dt.datetime(2026, 10, 25, tzinfo=TZ),
                           find=lambda query, *a, **kw: queries.append(query) or [])
                self.assertTrue(queries)
                for query in queries:
                    self.assertNotIn('"' + amount.split('.')[0] + '"', query)
                if amount.endswith('.00'):
                    self.assertEqual(queries, ['"acme"', '"1111"'])

    def test_integral_receipts_still_match_symbols_and_spaced_currency(self):
        now = dt.datetime(2026, 10, 24, tzinfo=TZ)
        for text, merchant, currency in (('Receipt from Acme: $1', 'Acme', 'USD'),
                                         ('Receipt from Acme: AED 1', 'Acme', 'AED'),
                                         ('Receipt from Reseller: 1 USD card 1111', 'Acme', 'USD')):
            with self.subTest(text=text):
                row = {'id': 1, 'ts': now.timestamp(), 'sender': 'Acme'}
                def find(query, *a, **kw):
                    return [row] if query.strip('"').lower() in text.lower() else []
                charge = dict(currency=currency, amount='1.00', card='1111', merchant=merchant)
                self.assertEqual(ch.receipt(charge, now, now, find=find, read=lambda *a: text), row)

    def test_exhausted_receipt_scans_never_authorize_an_ask(self):
        when = dt.datetime(2026, 10, 24, tzinfo=TZ)
        now = when + dt.timedelta(days=2)
        charge = dict(kind='charge', currency='USD', amount='1.00', card='1111', merchant='Acme')
        for kind in ('distinct bodies', 'search page'):
            with self.subTest(kind=kind):
                n = ch.RECEIPT_READS + 1 if kind == 'distinct bodies' else ch.RECEIPT_HITS
                rows = [{'id': i, 'ts': when.timestamp(), 'sender': 'Acme'} for i in range(n)]
                def read(row, *a, **kw):
                    if kind == 'search page':
                        return 'Acme newsletter, same body'
                    return 'Receipt from Acme: $1' if row['id'] == n - 1 else f'Acme newsletter {row["id"]}'
                with patch.object(ch, 'show', side_effect=read), patch.object(ch, 'card_owner', return_value='abdullah'):
                    result = ch.explain(charge, when, now, find=lambda *a, **kw: rows,
                                        said=lambda *a, **kw: [])
                self.assertEqual(result['verdict'], 'unverified')
                self.assertIn('receipt scan incomplete', str(result['errors']))

    def test_order_results_and_failures_are_shared_only_within_one_run(self):
        charge = dict(kind='charge', currency='AED', amount='1.00', card='1111', merchant='noon')
        now = dt.datetime(2026, 10, 24, tzinfo=TZ)
        for result in ({'orders': [], 'complete': False}, ValueError('unavailable')):
            with self.subTest(failure=isinstance(result, Exception)):
                memo = {}
                with patch.object(ch.order_lookup, 'read', side_effect=[result, result]) as lookup, \
                        patch.object(ch, 'receipt', return_value=None), \
                        patch.object(ch, 'card_owner', return_value='abdullah'):
                    for _ in range(2):
                        errors = []
                        limits = []
                        self.assertIsNone(ch.found(charge, now, now, said=lambda *a, **kw: [],
                                                   errors=errors, memo=memo, limits=limits))
                        if isinstance(result, Exception):
                            self.assertIn('orders: noon orders: lookup unavailable or incomplete', errors)
                        else:
                            self.assertEqual(errors, [])
                            self.assertEqual(limits[0]['kinds'], ['marketplace_stale'])
                    self.assertEqual(lookup.call_count, 1)
                    ch.found(charge, now, now, said=lambda *a, **kw: [], memo={})
                    self.assertEqual(lookup.call_count, 2)

    def test_order_lookup_without_start_budget_does_not_poison_the_run(self):
        import subprocess
        charge = dict(kind='charge', currency='AED', amount='1.00', card='1111', merchant='noon')
        now = dt.datetime(2026, 10, 24, tzinfo=TZ)
        result = {'orders': [{'service': 'minutes', 'order': 'N1', 'total': '1.00', 'currency': 'AED',
                              'placed_at': now.isoformat()}], 'complete': True}
        cache_dir = tempfile.TemporaryDirectory()
        self.addCleanup(cache_dir.cleanup)
        memo = {('orders_cache',): Path(cache_dir.name) / 'cache.json'}
        with patch.object(ch.time, 'time', return_value=1000), \
                patch.object(ch, 'receipt', return_value=None), \
                patch.object(ch, 'card_owner', return_value='abdullah'), \
                patch.object(ch.order_lookup.subprocess, 'run', return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps(result), '')) as run:
            self.assertIsNone(ch.found(charge, now, now, deadline=1001, memo=memo,
                                       said=lambda *a, **kw: []))
            run.assert_not_called()
            hit = ch.found(charge, now, now, deadline=1010, memo=memo, said=lambda *a, **kw: [])
            self.assertEqual(hit['verdict'], 'receipt')
            ch.found(charge, now, now, deadline=1010, memo=memo, said=lambda *a, **kw: [])
            self.assertEqual(run.call_count, 1)

    def test_selected_body_continuations_stop_at_next_context_header(self):
        bodies = [
            'Purchase of USD 100 with your Credit Card ending 2342 at Acme.',
            'Purchase of USD 100\nwith your Credit Card ending 2342 at Acme.',
            'Purchase of USD 100\n\n  with your Credit Card ending 2342 at Acme.',
            'Purchase of USD 100\r\nwith your Credit Card ending 2342 at Acme.',
            'Purchase of USD 100\nwith your Credit Card ending 2342 at Acme.\n> continuation',
        ]
        for body in bodies:
            for following in (False, True):
                with self.subTest(body=body, following=following):
                    shown = ('imessage: EmiratesNBD\n\n'
                             '         9 2026-11-15 11:59 EmiratesNBD: USD 100 has been refunded.\n'
                             '>       10 2026-11-15 12:00 EmiratesNBD: ' + body)
                    if following:
                        shown += '\n        11 2026-11-15 12:01 EmiratesNBD: Payment of USD 100 towards your Credit Card.'
                    selected = ch.alert_text(shown)
                    self.assertEqual(selected, body.replace('\r\n', '\n'))
                    self.assertEqual(ch.parse(selected, 'EmiratesNBD')['merchant'], 'Acme')

    def test_unknown_timestamp_header_still_bounds_selected_body(self):
        shown = ('imessage: EmiratesNBD\n\n'
                 '>       10 ????-??-?? ??:?? EmiratesNBD: Selected\ncontinuation\n'
                 '        11 ????-??-?? ??:?? EmiratesNBD: Neighbor')
        self.assertEqual(ch.alert_text(shown), 'Selected\ncontinuation')

    def test_unframed_messages_and_email_quotes_are_unchanged(self):
        for shown in ('Purchase of USD 100\nwith your Credit Card ending 2342 at Acme.',
                      'Subject: Bank alert\n\nPurchase of USD 100\n> quoted text'):
            with self.subTest(shown=shown):
                self.assertEqual(ch.alert_text(shown), shown)


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
        for tok in re.findall(r'"[^"]*"|\S+', query):
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


def nobody(since, until, deadline=None, **kwargs):
    return []


CHARGE = ch.parse('Purchase of EUR 12.34 with Credit Card ending 1111 at ACME * EATS PENDING, Amsterdam. Avl')


def read(row, deadline=None):
    return f"{row.get('subject', '')}\n{row.get('body', '')}"


class ReceiptVariants(unittest.TestCase):
    def setUp(self):
        for name, replacement in [('show', read), ('card_owner', lambda charge: 'abdullah')]:
            mock = patch.object(ch, name, replacement)
            mock.start()
            self.addCleanup(mock.stop)

    def explain(self, merchant, amount, body, sender, *, pending=False, minutes=30,
                subject=None, receipt_ok=None):
        charge = dict(CHARGE, merchant=merchant, currency='AED', amount=amount, pending=pending)
        row = dict(id=7, ts=ts('2026-10-24T12:00') + minutes * 60, sender=sender,
                   subject=subject or f'Your receipt from {merchant}', body=body)
        return ch.explain(charge, at('2026-10-24T12:00'), at('2026-10-27T12:00'),
                          find=Finder([row]), said=nobody, receipt_ok=receipt_ok)

    def test_uber_pending_total_and_explicit_wait_fee(self):
        for hold, total, wait in [('201.03', '200.94', None), ('77.45', '106.25', '28.80'),
                                  ('73.46', '84.77', '11.31')]:
            with self.subTest(hold=hold):
                body = f'Uber receipt\nTotal AED {total}'
                if wait:
                    body += f'\nWait Time\n\nAED {wait}'
                self.assertEqual(self.explain('UBER * PENDING', hold, body, 'Uber <receipts@uber.com>',
                                             pending=True)['verdict'], 'receipt')

    def test_uber_tolerance_is_one_percent_capped_at_one_dirham(self):
        for hold, total, expected in [('100.00', '99.00', 'receipt'), ('100.00', '98.99', 'ask'),
                                       ('50.00', '49.50', 'receipt'), ('50.00', '49.49', 'ask'),
                                       ('201.03', '199.99', 'ask'), ('44.81', '80.48', 'ask')]:
            with self.subTest(hold=hold, total=total):
                self.assertEqual(self.explain('UBER * PENDING', hold, f'Uber receipt\nTotal AED {total}',
                                             'Uber <receipts@uber.com>', pending=True)['verdict'], expected)

    def test_uber_requires_pending_merchant_sender_window_and_total(self):
        for changes in [dict(pending=False), dict(merchant='OTHER * PENDING'),
                        dict(sender='Other <receipts@other.example>'),
                        dict(sender='Uber <receipts@uber.com.other.example>'),
                        dict(minutes=-1), dict(minutes=121), dict(body='Uber receipt\nFare AED 200.94'),
                        dict(body='Uber receipt\nTotal AED 200.94\nTotal AED 50.00'),
                        dict(body='Uber receipt\nTotal EUR 200.94')]:
            with self.subTest(changes=changes):
                options = dict(merchant='UBER * PENDING', amount='201.03', pending=True,
                               body='Uber receipt\nTotal AED 200.94', sender='Uber <receipts@uber.com>')
                self.assertEqual(self.explain(**{**options, **changes})['verdict'], 'ask')

    def test_aed_usd_receipts_need_the_brand_and_plausible_paid_total(self):
        for merchant, sender in [('BOAT.DEV', 'Boat <receipts@stripe.example>'),
                                  ('BOAT.DEV', 'Boat.dev <receipts@stripe.example>'),
                                  ('BROWSER USE INC', 'Browser Use <receipts@stripe.example>'),
                                  ('BROWSER USE INC', 'Browser Use Inc. <receipts@stripe.example>')]:
            for paid, expected in [('50.00', 'receipt'), ('25.00', 'ask'), ('100.00', 'ask')]:
                with self.subTest(merchant=merchant, paid=paid):
                    self.assertEqual(self.explain(merchant, '190.47', f'Amount paid ${paid}', sender,
                                                 subject=f'Your receipt from {sender.split(" <")[0]}')['verdict'], expected)

    def test_fx_never_uses_another_merchants_receipt_or_a_bare_number(self):
        for body, sender, subject in [
                ('Amount paid $50.00', 'Other <receipts@other.example>', 'Your receipt from Other'),
                ('Boat plan $50.00', 'Boat <news@boat.example>', 'Boat upgrade'),
                ('Boat invoice: total $50.00', 'Boat <receipts@stripe.example>', 'Boat invoice'),
                ('Boat receipt: Amount paid 50.00', 'Boat <receipts@stripe.example>', 'Boat receipt'),
                ('Boat receipt: Amount paid EUR 50.00', 'Boat <receipts@stripe.example>', 'Boat receipt'),
                ('Boat receipt: Amount paid $50.00\nAmount paid $25.00', 'Boat <receipts@stripe.example>', 'Boat receipt'),
                ('Browser invoice: use credits. Amount paid $50.00', 'Other <receipts@other.example>', 'Dev invoice'),
                ('Boat receipt: Amount paid $50.00', 'Other <receipts@other.example>', 'Other receipt'),
                ('Boat receipt: Amount paid $50.00', 'Other <receipts@other.example>', 'Receipt for Boat equipment'),
                ('Boat receipt: Amount paid $50.00', 'Boat Tours <receipts@tours.example>', 'Boat Tours receipt'),
        ]:
            for merchant in ['BOAT.DEV', 'BROWSER USE INC']:
                with self.subTest(merchant=merchant, body=body, subject=subject):
                    self.assertEqual(self.explain(merchant, '190.47', body, sender, subject=subject)['verdict'], 'ask')

    def test_usd_markup_edges_and_recurring_receipt_window(self):
        for amount, minutes, expected in [('183.62', 30, 'receipt'), ('183.61', 30, 'ask'),
                                          ('190.97', 30, 'receipt'), ('190.98', 30, 'ask'),
                                          ('190.47', -121, 'ask'), ('190.47', 2161, 'ask')]:
            with self.subTest(amount=amount, minutes=minutes):
                self.assertEqual(self.explain('BOAT.DEV', amount, 'Amount paid $50.00',
                                             'Boat <receipts@stripe.example>', minutes=minutes)['verdict'], expected)

    def test_paid_amount_forms_are_currency_bound(self):
        forms = [('Amount paid $50.00', '50'), ('Amount paid:\nUSD 50.00', '50'),
                 ('Amount paid\n50.00 USD', '50'), ('Amount paid $1,234.50', '1234.50'),
                 ('Amount paid $50', '50'), ('Amount paid $50.001', None),
                 ('Amount paid -$50.00', None), ('Amount paid 50 items', None),
                 ('Amount paid EUR 50.00', None)]
        for text, expected in forms:
            with self.subTest(text=text):
                self.assertEqual(ch.labelled_money(text, 'amount paid', 'USD'),
                                 {ch.Decimal(expected)} if expected else set())

    def test_receipt_veto_and_source_errors_remain_closed(self):
        self.assertEqual(self.explain('BOAT.DEV', '190.47', 'Amount paid $50.00',
                                     'Boat <receipts@stripe.example>', receipt_ok=lambda *a: False)['verdict'], 'ask')
        for name in ['show', 'search']:
            with self.subTest(source=name), patch.object(ch, name, side_effect=ch.Lookup('unavailable')):
                charge = dict(CHARGE, merchant='BOAT.DEV', currency='AED', amount='190.47', pending=False)
                options = {} if name == 'search' else dict(find=Finder([
                    dict(id=7, ts=ts('2026-10-24T12:30'), sender='Boat', body='Boat receipt Amount paid $50.00')]))
                result = ch.explain(charge, at('2026-10-24T12:00'), at('2026-10-27T12:00'), said=nobody, **options)
                self.assertEqual(result['verdict'], 'unverified')

    def test_justlife_completion_without_priced_receipt_does_not_explain_a_charge(self):
        self.assertEqual(self.explain('Justlife', '110.90', 'Justlife booking completed',
                                     'Justlife <booking@justlife.example>', subject='Booking completed')['verdict'], 'ask')

    def test_variant_searches_leave_the_read_budget_for_relevant_mail(self):
        for merchant, amount, sender, body, pending in [
                ('UBER * PENDING', '201.03', 'Uber <receipts@uber.com>', 'Uber receipt\nTotal AED 200.94', True),
                ('BROWSER USE INC', '190.47', 'Browser Use <receipts@stripe.example>', 'Amount paid $50.00', False)]:
            with self.subTest(merchant=merchant):
                row = dict(id=7, ts=ts('2026-10-24T12:30'), sender=sender,
                           subject=f'Your receipt from {merchant}', body=body)
                noise = [dict(id=100 + i, ts=ts('2026-10-25T10:00') + i,
                              sender=sender if pending else 'Other <news@other.example>',
                              subject='Uber receipt' if pending else 'View in browser: use credits',
                              body=f'Unrelated notice {i}') for i in range(20)]
                charge = dict(CHARGE, merchant=merchant, currency='AED', amount=amount, pending=pending)
                result = ch.explain(charge, at('2026-10-24T12:00'), at('2026-10-27T12:00'),
                                    find=Finder(noise + [row]), said=nobody)
                self.assertEqual(result['verdict'], 'receipt')

    def test_a_later_exact_uber_receipt_keeps_the_existing_window(self):
        self.assertEqual(self.explain('UBER * PENDING', '201.03', 'Uber receipt\nAED 201.03',
                                     'Uber <receipts@uber.com>', pending=True, minutes=700)['verdict'], 'receipt')

    def test_variant_noise_cannot_block_an_exact_receipt(self):
        observed = at('2026-10-24T12:00')
        for merchant, brand, pending in [('BOAT.DEV', 'Boat', False),
                                         ('BROWSER USE INC', 'Browser Use', False),
                                         ('UBER * PENDING', 'Uber', True)]:
            noise = [dict(id=100 + i, ts=(observed + dt.timedelta(minutes=6 + i)).timestamp(),
                          sender=brand, subject=f'{brand} usage notice', body=f'Usage update {i}')
                     for i in range(ch.RECEIPT_READS + 1)]
            charge = dict(CHARGE, merchant=merchant, currency='AED', amount='190.47', pending=pending)
            for match in ['merchant', 'card']:
                with self.subTest(merchant=merchant, match=match):
                    row = dict(id=7, ts=(observed + dt.timedelta(minutes=5)).timestamp(),
                               sender=brand if match == 'merchant' else 'Payment processor',
                               subject='Your receipt', body='Paid AED 190.47' +
                               (f' to {brand}' if match == 'merchant' else ' with card 1111'))
                    result = ch.explain(charge, observed, observed + dt.timedelta(days=3),
                                        find=Finder(noise + [row]), said=nobody)
                    self.assertEqual((result['verdict'], result.get('msgs')), ('receipt', 7))

    def test_a_body_seen_by_exact_search_can_still_prove_a_variant(self):
        self.assertEqual(self.explain('BOAT.DEV', '190.47',
                                     'Boat receipt\n190.47 credits\nAmount paid $50.00',
                                     'Boat <receipts@stripe.example>')['verdict'], 'receipt')

    def test_whole_aed_variants_survive_broad_merchant_noise(self):
        observed = at('2026-10-24T12:00')
        forms = [('BOAT.DEV', '190.00', 'Boat <receipts@stripe.example>', False,
                  'Amount paid $50.00', 'Terraform dev notice'),
                 ('BROWSER USE INC', '190.00', 'Browser Use <receipts@stripe.example>', False,
                  'Amount paid $50.00', 'View in browser: use credits'),
                 ('UBER * PENDING', '200.00', 'Uber <receipts@uber.com>', True,
                  'Total AED 199.50', 'Uber usage notice')]
        for merchant, amount, sender, pending, body, noise_subject in forms:
            for form, paid in [('variant', body), ('exact', f'Paid AED {amount}')]:
                row = dict(id=7, ts=(observed + dt.timedelta(minutes=30)).timestamp(), sender=sender,
                           subject=f'Your receipt from {merchant}', body=paid)
                noise = [dict(id=100 + i, ts=(observed + dt.timedelta(hours=12, seconds=i)).timestamp(),
                              sender='Other <notice@other.example>', subject=noise_subject,
                              body=f'Unrelated notice {i}') for i in range(ch.RECEIPT_READS + 1)]
                with self.subTest(merchant=merchant, form=form):
                    charge = dict(CHARGE, merchant=merchant, currency='AED', amount=amount, pending=pending)
                    result = ch.explain(charge, observed, observed + dt.timedelta(days=3),
                                        find=Finder(noise + [row]), said=nobody)
                    self.assertEqual((result['verdict'], result.get('msgs')), ('receipt', 7))

    def test_rejected_receipt_copies_only_consume_one_body_read(self):
        observed = at('2026-10-24T12:00')
        charge = dict(CHARGE, merchant='BOAT.DEV', currency='AED', amount='190.47', pending=False)
        notice = dict(id=8, ts=(observed + dt.timedelta(minutes=40)).timestamp(),
                      sender='Boat', subject='Boat usage notice', body='Boat plan AED 190.47')
        copies = [dict(notice, id=100 + i, subject='Your Boat receipt',
                       ts=(observed + dt.timedelta(minutes=20, seconds=i)).timestamp())
                  for i in range(ch.RECEIPT_READS + 1)]
        row = dict(notice, id=7, ts=(observed + dt.timedelta(minutes=5)).timestamp(),
                   subject='Your Boat receipt', body='Boat payment AED 190.47')

        def shown(row, deadline=None):
            return f'Subject: {row["subject"]}\n\n{row["body"]}'

        result = ch.receipt(charge, observed, observed + dt.timedelta(days=3),
                            find=Finder([notice] + copies + [row]), read=shown,
                            receipt_ok=lambda candidate, text: candidate['id'] == 7)
        self.assertEqual(result['id'], 7)

    def test_whole_aed_exact_receipts_keep_existing_paths(self):
        for merchant, brand, pending, minutes, named in [
                ('BOAT.DEV', 'Boat', False, 30, True),
                ('BROWSER USE INC', 'Browser Use', False, 30, True),
                ('UBER * PENDING', 'Uber', True, 30, True),
                ('UBER * PENDING', 'Uber', True, 700, True),
                ('BOAT.DEV', 'Boat', False, 5, False)]:
            with self.subTest(merchant=merchant, minutes=minutes, named=named):
                body = f'{brand} receipt AED 190.00' if named else 'Receipt AED 190.00 paid with card 1111'
                self.assertEqual(self.explain(merchant, '190.00', body,
                                             brand if named else 'Payment processor',
                                             subject='Receipt', pending=pending, minutes=minutes)['verdict'], 'receipt')

    def test_decimal_variants_survive_both_exact_search_noise_paths(self):
        observed = at('2026-10-24T12:00')
        for merchant, sender, pending, body, named_noise in [
                ('BOAT.DEV', 'Boat <receipts@stripe.example>', False, 'Amount paid $50.00', 'Terraform dev'),
                ('BROWSER USE INC', 'Browser Use <receipts@stripe.example>', False,
                 'Amount paid $50.00', 'View in browser: use credits'),
                ('UBER * PENDING', 'Uber <receipts@uber.com>', True, 'Total AED 190.40', 'Uber later trip')]:
            charge = dict(CHARGE, merchant=merchant, currency='AED', amount='190.47', pending=pending)
            row = dict(id=7, ts=(observed + dt.timedelta(minutes=5)).timestamp(), sender=sender,
                       subject=f'Your receipt from {merchant}', body=body)
            for path in ['merchant', 'card']:
                noise = [dict(id=100 + i, ts=(observed + dt.timedelta(
                    hours=12 if path == 'merchant' else 0, minutes=6, seconds=i)).timestamp(),
                    sender='Other <notice@other.example>', subject=named_noise if path == 'merchant' else 'Usage',
                    body=f'190.47 credits remaining, update {i}') for i in range(ch.RECEIPT_READS + 1)]
                for veto in [False, True]:
                    with self.subTest(merchant=merchant, path=path, veto=veto):
                        result = ch.explain(charge, observed, observed + dt.timedelta(days=3),
                                            find=Finder(noise + [row]), said=nobody,
                                            receipt_ok=(lambda *args: False) if veto else None)
                        self.assertEqual(result['verdict'], 'unverified' if veto else 'receipt')
                        if not veto:
                            self.assertEqual(result['msgs'], 7)

    def test_variant_read_allowance_is_bounded(self):
        observed = at('2026-10-24T12:00')
        charge = dict(CHARGE, merchant='BOAT.DEV', currency='AED', amount='190.47', pending=False)
        row = dict(id=7, ts=(observed + dt.timedelta(minutes=5)).timestamp(),
                   sender='Boat <receipts@stripe.example>', subject='Boat receipt', body='Amount paid $50.00')
        noise = [dict(row, id=100 + i, ts=(observed + dt.timedelta(minutes=6, seconds=i)).timestamp(),
                      subject='Boat usage', body=f'Usage update {i}') for i in range(ch.RECEIPT_READS + 1)]
        result = ch.explain(charge, observed, observed + dt.timedelta(days=3),
                            find=Finder(noise + [row]), said=nobody)
        self.assertEqual(result['verdict'], 'unverified')
        self.assertIn('read limit reached', str(result['errors']))


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
        rows = [summary('Check my Apple order status', automated=True, createdBy='system'), relayed('Ok')]
        with ControlServer(rows):
            got = [t for _, t, _ in ch.owner_texts(at('2026-10-24T03:00'), at('2026-10-24T05:00'))]
        self.assertEqual(got, ['Ok'])


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

    def test_lookups_that_fail_are_reported_and_block_asking(self):
        def broken(*a, **k):
            raise ch.Lookup('msgs exit 1')
        r = ch.explain(CHARGE, at('2026-10-23T23:47'), at('2026-10-24T00:37'), find=broken, said=broken)
        self.assertEqual(r['verdict'], 'unverified')
        self.assertEqual(len(r['errors']), 2)
        with self.assertRaises(ch.Lookup):
            ch.left(0, 5)


def relayed(text, inbound='BCA7F873-4770-43DB-8E0E-7E3294F6C71A', **extra):
    return summary(text, createdBy='system', creationSource='server', inboundMessageId=inbound, **extra)


class OwnerTexts(unittest.TestCase):
    def read(self, **kwargs):
        return ch.owner_texts(at('2026-10-24T03:00'), at('2026-10-24T05:00'), **kwargs)

    def message_calls(self, server):
        return [(path, params) for path, params, _ in server.calls if path.endswith('/messages')]

    def test_one_slow_request_is_capped_and_other_progress_is_saved(self):
        threads = [{'threadId': tid, 'title': 'App'} for tid in ('slow', 'a', 'b')]
        with ControlServer(threads=threads, stall='/slow/messages') as server:
            stats = Counter()
            started = time.monotonic()
            with self.assertRaisesRegex(ch.Lookup, r'incomplete \(2 of 3 threads\)'):
                self.read(stats=stats)
            elapsed = time.monotonic() - started
            self.assertGreater(elapsed, ch.OWNER_REQUEST_TIMEOUT - 0.2)
            self.assertLess(elapsed, ch.OWNER_REQUEST_TIMEOUT + 0.7)
            self.assertEqual(stats['owner_timeouts'], 1)
            self.assertEqual(stats['owner_threads_fetched'], 2)
            self.assertEqual(stats['owner_result'], 'incomplete')
            self.assertEqual(stats['owner_cache_size'], 2)
            cache = json.loads((Path(server.tmp.name) / 'owner-texts.json').read_text())
            self.assertEqual(set(cache), {'a', 'b'})
            self.assertGreaterEqual(stats['owner_fetch_ms_max'], 2800)

    def test_stalled_list_counts_attempt_and_reports_list_failed(self):
        with ControlServer(stall='/threads'):
            stats = Counter()
            with self.assertRaises(ch.Lookup):
                self.read(stats=stats)
            self.assertEqual(stats['owner_result'], 'list_failed')
            self.assertEqual(stats['owner_list_pages'], 1)
            self.assertEqual(stats['owner_queries'], 1)
            self.assertEqual(stats['owner_timeouts'], 1)
            self.assertGreaterEqual(stats['owner_list_ms'], 2800)
            self.assertEqual(stats['owner_threads_fetched'], 0)

    def test_ninety_five_threads_converge_with_ten_changes_per_call(self):
        until = at('2026-10-24T05:00')
        since = until - dt.timedelta(days=7)
        threads = [{'threadId': str(n), 'title': 'Private title never in stats',
                    'updatedAt': ch.iso(until - dt.timedelta(hours=n))} for n in range(95)]
        with ControlServer(threads=threads) as server:
            for n in range(95):
                server.rows[str(n)] = [summary('Private text never in stats', messageId=str(n))]
            for call, (fresh, needed, fetched, result) in enumerate((
                    (0, 95, 62, 'incomplete'), (52, 43, 43, 'ok'), (85, 10, 10, 'ok'))):
                if call:
                    for thread in server.threads[:10]:
                        thread['updatedAt'] = ch.iso(until + dt.timedelta(minutes=call))
                server.calls.clear()
                stats = Counter()
                if result == 'incomplete':
                    with self.assertRaises(ch.Lookup):
                        ch.owner_texts(since, until, stats=stats)
                else:
                    self.assertEqual(len(ch.owner_texts(since, until, stats=stats)), 95)
                self.assertEqual(stats['owner_result'], result)
                self.assertEqual(stats['owner_list_pages'], 2)
                self.assertEqual(stats['owner_threads_selected'], 95)
                self.assertEqual(stats['owner_threads_fresh'], fresh)
                self.assertEqual(stats['owner_threads_needed'], needed)
                self.assertEqual(stats['owner_threads_fetched'], fetched)
                self.assertEqual(stats['owner_queries'], fetched + 2)
                self.assertLessEqual(stats['owner_queries'], 64)
                self.assertEqual(stats['owner_timeouts'], 0)
                self.assertEqual(stats['owner_cache_size'], 62 if not call else 95)
                self.assertEqual(len(self.message_calls(server)), fetched)
                self.assertNotIn('Private', json.dumps(stats))
                self.assertNotIn('test-secret', json.dumps(stats))

    def test_cold_and_changed_threads_share_the_request_limit(self):
        threads = [{'threadId': str(n), 'title': 'App',
                    'updatedAt': ch.iso(at('2026-10-24T05:00') - dt.timedelta(minutes=n))}
                   for n in range(95)]
        with ControlServer(threads=threads) as server:
            with self.assertRaises(ch.Lookup):
                self.read()
            for thread in server.threads[:10]:
                thread['updatedAt'] = '2026-10-24T02:00:00Z'
            server.calls.clear()
            with patch.object(ch, 'OWNER_REQUEST_LIMIT', 8), self.assertRaises(ch.Lookup):
                self.read()
            fetched = {path.split('/')[-2] for path, _ in self.message_calls(server)}
            self.assertEqual(fetched, {'62', '63', '64', '0', '1', '2'})

    def test_changed_threads_reconcile_mutations_missing_from_strict_deltas(self):
        cases = [
            ('redacted', [summary('[REDACTED]', messageId='old')], ['[REDACTED]']),
            ('partially redacted', [summary('I paid [REDACTED]', messageId='old')], ['I paid [REDACTED]']),
            ('deleted', [], []),
            ('restamped automated', [summary('I paid Apple', messageId='old', automated=True)], []),
            ('restamped agent', [summary('I paid Apple', messageId='old', createdBy='agent')], []),
            ('forwarded', [summary('[Forwarded by owner] I paid Apple', messageId='old')], []),
        ]
        for mutation, changed, expected in cases:
            for append in (False, True):
                with self.subTest(mutation=mutation, append=append), \
                        ControlServer([summary('I paid Apple', messageId='old')], strict_since=True) as server:
                    self.assertEqual([row[1] for row in self.read()], ['I paid Apple'])
                    server.threads[0]['updatedAt'] = '2026-10-24T01:01:00Z'
                    server.rows['a'] = list(changed)
                    if append:
                        server.rows['a'].append(summary('new unrelated turn', messageId='new',
                                                        createdAt='2026-10-24T01:00:00Z'))
                    server.calls.clear()
                    got = [row[1] for row in self.read()]
                    self.assertCountEqual(got, expected + (['new unrelated turn'] if append else []))
                    path = Path(server.tmp.name) / 'owner-texts.json'
                    self.assertNotIn('I paid Apple', path.read_text())
                    self.assertEqual(self.message_calls(server)[0][1]['since'], ['2026-10-23T22:59:59.999Z'])
                    server.calls.clear()
                    self.assertEqual([row[1] for row in self.read()], got)
                    self.assertEqual(self.message_calls(server), [])

    def test_legacy_delta_cache_is_not_reused_even_with_a_matching_thread_version(self):
        for version in ('missing', 1, '2', True, None):
            with self.subTest(version=version), \
                    ControlServer([summary('I paid Apple', messageId='old')], strict_since=True) as server:
                self.read()
                path = Path(server.tmp.name) / 'owner-texts.json'
                cache = json.loads(path.read_text())
                if version == 'missing':
                    cache['a'].pop('version')
                else:
                    cache['a']['version'] = version
                path.write_text(json.dumps(cache))
                server.rows['a'][0]['text'] = '[REDACTED]'
                with patch.object(ch.toollog, 'emit') as log:
                    self.assertEqual([row[1] for row in self.read()], ['[REDACTED]'])
                log.assert_called_once_with('money-cases', 'cache_reset')
                self.assertNotIn('I paid Apple', path.read_text())
                self.assertEqual(json.loads(path.read_text())['a']['version'], ch.OWNER_CACHE_VERSION)

    def test_failed_refresh_evicts_unvalidated_text_and_keeps_other_covered_threads(self):
        threads = [{'threadId': tid, 'title': 'App'} for tid in ('a', 'b')]
        with ControlServer([summary('I paid Apple', messageId='old')], threads=threads,
                           strict_since=True) as server:
            server.rows['b'] = [summary('unrelated')]
            self.assertEqual(len(self.read()), 2)
            server.threads[0]['updatedAt'] = '2026-10-24T01:01:00Z'
            server.rows['a'][0]['text'] = '[REDACTED]'
            server.responses['/api/ardud/control/threads/a/messages'] = {'ok': False}
            with self.assertRaisesRegex(ch.Lookup, r'incomplete \(1 of 2 threads\)'):
                self.read()
            path = Path(server.tmp.name) / 'owner-texts.json'
            self.assertEqual(set(json.loads(path.read_text())), {'b'})
            self.assertNotIn('I paid Apple', path.read_text())
            server.responses.clear()
            server.calls.clear()
            self.assertCountEqual([row[1] for row in self.read()], ['[REDACTED]', 'unrelated'])
            self.assertEqual(len(self.message_calls(server)), 1)
            server.calls.clear()
            self.assertEqual(len(self.read()), 2)
            self.assertEqual(self.message_calls(server), [])

    def test_ninety_threads_warm_across_checks_then_need_only_lists(self):
        until = at('2026-10-24T05:00')
        since = until - dt.timedelta(days=7)
        threads = [{'threadId': str(n), 'title': 'App',
                    'updatedAt': ch.iso(until - dt.timedelta(hours=n))} for n in range(90)]
        with ControlServer(threads=threads) as server:
            for n, thread in enumerate(threads):
                server.rows[str(n)] = [summary(str(n), createdAt=thread['updatedAt'])]
            with self.assertRaisesRegex(ch.Lookup, r'incomplete \(62 of 90 threads\)'):
                ch.owner_texts(since, until)
            cache = json.loads((Path(server.tmp.name) / 'owner-texts.json').read_text())
            self.assertEqual(set(cache), {str(n) for n in range(62)})
            server.calls.clear()
            self.assertEqual(len(ch.owner_texts(since, until)), 90)
            self.assertEqual(len(self.message_calls(server)), 28)
            server.calls.clear()
            stats = Counter()
            self.assertEqual(len(ch.owner_texts(since, until, stats=stats)), 90)
            self.assertEqual(self.message_calls(server), [])
            self.assertEqual(stats['owner_queries'], 2)

    def test_changed_thread_replaces_full_span_and_reclassifies_messages(self):
        with ControlServer([summary('old', createdAt='2026-10-24T00:00:00Z'),
                            summary('boundary', createdAt='2026-10-24T00:59:00Z'),
                            summary('overlap', createdAt='2026-10-24T00:59:30Z'),
                            summary('removed', createdAt='2026-10-24T00:59:40Z')]) as server:
            self.read()
            server.calls.clear()
            server.threads[0]['updatedAt'] = '2026-10-24T01:00:30Z'
            server.rows['a'] = [summary('old', createdAt='2026-10-24T00:00:00Z'),
                                summary('boundary', createdAt='2026-10-24T00:59:00Z'),
                                summary('overlap edited', messageId='overlap', createdAt='2026-10-24T00:59:30Z'),
                                summary('overlap edited', messageId='overlap', createdAt='2026-10-24T00:59:30Z'),
                                summary('reclassified', messageId='removed', automated=True,
                                        createdAt='2026-10-24T00:59:40Z'),
                                summary('new', createdAt='2026-10-24T01:00:00Z')]
            self.assertEqual([row[1] for row in self.read()], ['new', 'overlap edited', 'boundary', 'old'])
            self.assertEqual(self.message_calls(server)[0][1]['since'], ['2026-10-23T22:59:59.999Z'])
            server.calls.clear()
            self.assertEqual(len(self.read()), 4)
            self.assertEqual(self.message_calls(server), [])

    def test_edits_to_older_turns_replace_cached_text_by_id(self):
        cases = [(summary('edited owner words', messageId='old'), ['edited owner words']),
                 (summary('now automated', messageId='old', automated=True), []),
                 (summary('now agent', messageId='old', createdBy='agent'), []),
                 (summary('[Forwarded by owner] private', messageId='old'), [])]
        for edited, expected in cases:
            with self.subTest(edited=edited['text']), ControlServer([summary('old')], strict_since=True) as server:
                self.read()
                # A recent update can have an old createdAt. The real API's
                # since filter is on updatedAt, not createdAt.
                server.rows['a'] = [{**edited, 'updatedAt': '2026-10-24T01:01:00Z'}]
                server.threads[0]['updatedAt'] = '2026-10-24T01:01:00Z'
                self.assertEqual([row[1] for row in self.read()], expected)

    def test_earlier_window_refetches_and_failed_change_cannot_use_stale_cache(self):
        with ControlServer([summary('newer')]) as server:
            self.read()
            earlier = at('2026-10-23T03:00')
            server.calls.clear()
            server.rows['a'].append(summary('earlier', createdAt=ch.iso(earlier)))
            self.assertEqual(len(ch.owner_texts(earlier, at('2026-10-24T05:00'))), 2)
            self.assertEqual(self.message_calls(server)[0][1]['since'],
                             [ch.iso(earlier - dt.timedelta(milliseconds=1))])
            server.threads[0]['updatedAt'] = '2026-10-24T01:01:00Z'
            server.responses['/api/ardud/control/threads/a/messages'] = {'ok': False}
            with self.assertRaisesRegex(ch.Lookup, r'incomplete \(0 of 1 threads\)'):
                self.read()
            cached = json.loads((Path(server.tmp.name) / 'owner-texts.json').read_text())
            self.assertNotIn('a', cached)

    def test_corrupt_cache_resets_once_and_is_replaced_privately(self):
        for raw in ('not json', '[]', '{"a": {}}'):
            with self.subTest(raw=raw), ControlServer([summary('owner')]) as server:
                path = Path(server.tmp.name) / 'owner-texts.json'
                path.write_text(raw)
                path.chmod(0o644)
                with patch.object(ch.toollog, 'emit') as log:
                    self.assertEqual(len(self.read()), 1)
                log.assert_called_once_with('money-cases', 'cache_reset')
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(json.loads(path.read_text())['a']['texts'][0]['text'], 'owner')
                self.assertEqual(list(path.parent.glob('.owner-texts.json.*')), [])

    def test_unreadable_cache_is_empty(self):
        read = Path.read_text
        def unreadable(path, *args, **kwargs):
            if path.name == 'owner-texts.json':
                raise PermissionError()
            return read(path, *args, **kwargs)
        with ControlServer([summary('owner')]), patch.object(Path, 'read_text', unreadable), \
                patch.object(ch.toollog, 'emit') as log:
            self.assertEqual(len(self.read()), 1)
        log.assert_called_once_with('money-cases', 'cache_reset')

    def test_cache_prunes_threads_and_texts_but_keeps_an_older_requested_window(self):
        until = at('2026-10-24T05:00')
        cutoff = until - dt.timedelta(days=14)
        with ControlServer() as server:
            path = Path(server.tmp.name) / 'owner-texts.json'
            rows = [summary('ancient', createdAt=ch.iso(cutoff - dt.timedelta(days=1))), summary('recent')]
            cached = {'a': {'version': ch.OWNER_CACHE_VERSION, 'updatedAt': server.threads[0]['updatedAt'], 'coveredFrom': ch.iso(cutoff - dt.timedelta(days=2)),
                            'title': 'iMessage test', 'texts': [{**row, 'title': 'iMessage test'} for row in rows]},
                      'expired': {'version': ch.OWNER_CACHE_VERSION, 'updatedAt': ch.iso(cutoff - dt.timedelta(days=1)),
                                  'coveredFrom': ch.iso(cutoff - dt.timedelta(days=2)), 'title': 'App', 'texts': []}}
            path.write_text(json.dumps(cached))
            self.read()
            kept = json.loads(path.read_text())
            self.assertEqual(set(kept), {'a'})
            self.assertEqual([r['text'] for r in kept['a']['texts']], ['recent'])
            self.assertEqual(ch.owner_time(kept['a']['coveredFrom']), cutoff)
            # An old followed question extends retention without reading cases.json.
            path.write_text(json.dumps(cached))
            ch.owner_texts(cutoff - dt.timedelta(days=2), until)
            self.assertEqual(set(json.loads(path.read_text())), {'a', 'expired'})
            self.assertEqual(len(json.loads(path.read_text())['a']['texts']), 2)

    def test_successes_after_a_failed_thread_are_saved_and_next_read_finishes(self):
        threads = [{'threadId': tid, 'title': 'App'} for tid in ('bad', 'a', 'b')]
        with ControlServer(threads=threads) as server:
            for thread in threads:
                server.rows[thread['threadId']] = [summary(thread['threadId'])]
            server.responses['/api/ardud/control/threads/bad/messages'] = {'ok': False}
            with self.assertRaisesRegex(ch.Lookup, r'incomplete \(2 of 3 threads\)'):
                self.read()
            path = Path(server.tmp.name) / 'owner-texts.json'
            self.assertEqual(set(json.loads(path.read_text())), {'a', 'b'})
            server.responses.clear()
            server.calls.clear()
            self.assertEqual(len(self.read()), 3)
            self.assertEqual(len(self.message_calls(server)), 1)

    def test_coverage_preserves_fractional_millisecond_boundaries(self):
        since = at('2026-10-24T03:00:00.000500')
        until = at('2026-10-24T05:00')
        with ControlServer([summary('boundary', createdAt=ch.iso(since))]) as server:
            self.assertEqual(ch.owner_texts(since, until), [])
            server.calls.clear()
            self.assertEqual(len(ch.owner_texts(since - dt.timedelta(microseconds=500), until)), 1)
            self.assertEqual(len(self.message_calls(server)), 1)

    def test_slow_cache_io_is_bounded_and_never_returns_success(self):
        for operation in ('load', 'fsync'):
            with self.subTest(operation=operation), ControlServer([summary('owner')]) as server:
                self.read()
                path = Path(server.tmp.name) / 'owner-texts.json'
                before = path.read_bytes()
                original = ch.owner_cache if operation == 'load' else ch.os.fsync

                def slow(*args, **kwargs):
                    time.sleep(2)
                    return original(*args, **kwargs)

                target, name = (ch, 'owner_cache') if operation == 'load' else (ch.os, 'fsync')
                started = time.monotonic()
                with patch.object(ch, 'OWNER_BUDGET', 1.6), patch.object(target, name, slow), \
                        self.assertRaisesRegex(ch.Lookup, 'owner read incomplete'):
                    self.read()
                self.assertLess(time.monotonic() - started, 2)
                self.assertEqual(path.read_bytes(), before)
                self.assertEqual(list(path.parent.glob('.owner-texts.json.*')), [])

    def test_save_that_consumes_deadline_cannot_return_success(self):
        clock = [1000.0]
        save = ch.save_owner_cache
        def late(*args):
            result = save(*args)
            clock[0] += ch.OWNER_BUDGET + 1
            return result
        with ControlServer([summary('owner')]), patch.object(ch.time, 'time', lambda: clock[0]), \
                patch.object(ch, 'save_owner_cache', late), self.assertRaisesRegex(ch.Lookup, 'out of time'):
            self.read()

    def test_renamed_archived_and_nonowner_threads_do_not_reuse_cached_texts(self):
        with ControlServer([relayed('owner')]) as server:
            self.assertEqual(len(self.read()), 1)
            server.threads[0]['title'] = 'App'
            self.assertEqual(self.read(), [])
            for fields in ({'title': 'Moni'}, {'title': 'Group sb_gro'}, {'archived': True}):
                server.threads[0].update(fields)
                server.calls.clear()
                self.assertEqual(self.read(), [])
                self.assertEqual(self.message_calls(server), [])

    def test_missing_thread_version_or_message_id_fails_closed(self):
        with ControlServer([summary('owner')]) as server:
            del server.threads[0]['updatedAt']
            with self.assertRaisesRegex(ch.Lookup, 'updatedAt unavailable'):
                self.read()
            server.threads[0]['updatedAt'] = '2026-10-24T01:00:00Z'
            del server.rows['a'][0]['messageId']
            with self.assertRaisesRegex(ch.Lookup, 'message id unavailable'):
                self.read()

    def test_only_what_he_typed_counts(self):
        cases = [
            (summary('web'), True),
            (summary('mobile', creationSource='mobile'), True),
            (summary('desktop', creationSource='desktop'), True),
            (relayed('real iMessage'), True),
            (summary('old user-stamped iMessage', creationSource='server', inboundMessageId='real-id'), True),
            (summary('agent', createdBy='agent'), False),
            (summary('coord', creationSource='server'), False),
            (summary('[Forwarded by the owner from x] Acme'), False),
            (summary('assistant', role='assistant'), False),
            (relayed('[Watcher] Acme'), False),
            (relayed('   [Wake] Acme'), False),
            (relayed('no inbound', inbound=None), False),
            (relayed('empty inbound', inbound=''), False),
        ]
        for marker in ('schedule', 'notification', 'delegatedCompletion', 'senderThreadId'):
            cases.extend([(summary(marker, automated=True), False), (relayed(marker, automated=True), False)])
        for prefix in ('wake:', 'reset:', 'secret:'):
            cases.append((relayed(prefix, inbound=prefix + 'abc'), False))
        rows = [row for row, _ in cases]
        with ControlServer(rows) as server:
            got = {text for _, text, _ in self.read()}
            for row, wanted in cases:
                with self.subTest(text=row['text']):
                    self.assertEqual(row['text'] in got, wanted)
            self.assertEqual(len(server.calls), 3)
            self.assertEqual(server.calls[0][1]['limit'], ['500'])
            self.assertEqual(server.calls[2][1]['all'], ['true'])
            self.assertEqual(server.calls[2][1]['role'], ['user'])
            self.assertTrue(all(call[2] == 'Bearer test-secret-never-print' for call in server.calls))

    def test_filters_threads_and_created_at_and_encodes_thread_ids(self):
        threads = [{'threadId': 'a:with/slash', 'title': 'App'},
                   {'threadId': 'm', 'title': 'Moni'}, {'threadId': 'g', 'title': 'Group sb_gro'},
                   {'threadId': 'archived', 'title': 'App', 'archived': True},
                   {'threadId': 'kanban', 'title': 'Kanban task'}]
        with ControlServer(threads=threads) as server:
            server.rows['a:with/slash'] = [summary('before', createdAt='2026-10-23T22:59:59Z'),
                summary('since', createdAt='2026-10-23T23:00:00Z'),
                summary('until', createdAt='2026-10-24T01:00:00Z'),
                summary('after', createdAt='2026-10-24T01:00:01Z')]
            server.rows['kanban'] = [relayed('control send'), summary('board task', createdBy='system')]
            self.assertEqual([text for _, text, _ in self.read()], ['until', 'since'])
            paths = [path for path, _, _ in server.calls]
            self.assertIn('/api/ardud/control/threads/a%3Awith%2Fslash/messages', paths)
            self.assertEqual(len(paths), 4)

    def test_filtered_lists_ignore_thousands_of_workers_and_dedupe_owner_chats(self):
        threads = [{'threadId': f'worker-{n}', 'title': 'Worker', 'creationSource': 'server'}
                   for n in range(3500)]
        threads += [{'threadId': source, 'title': source, 'creationSource': source}
                    for source in ('web', 'mobile', 'desktop', 'mcp')]
        threads += [{'threadId': 'bridge', 'title': 'iMessage owner', 'creationSource': 'server',
                     'origin': 'imessage'},
                    {'threadId': 'overlap', 'title': 'iMessage old', 'creationSource': 'mcp',
                     'origin': 'imessage'},
                    {'threadId': 'moni', 'title': 'Moni', 'creationSource': 'server', 'origin': 'imessage'},
                    {'threadId': 'group', 'title': 'Group sb_gro', 'creationSource': 'server', 'origin': 'imessage'},
                    {'threadId': 'archived', 'title': 'Old', 'creationSource': 'web', 'archived': True},
                    {'threadId': 'child', 'title': 'Subagent', 'creationSource': 'mcp', 'subagent': True}]
        stats = Counter()
        with ControlServer(threads=threads) as server:
            for tid in ('web', 'mobile', 'desktop', 'mcp', 'bridge', 'overlap'):
                server.rows[tid] = [summary(tid)]
            self.assertEqual({text for _, text, _ in self.read(stats=stats)},
                             {'web', 'mobile', 'desktop', 'mcp', 'bridge', 'overlap'})
            lists = [params for path, params, _ in server.calls if path.endswith('/threads')]
            self.assertEqual(lists, [
                {'updatedSince': ['2026-10-23T22:59:59.999Z'], 'limit': ['500'],
                 'creationSource': ['web,mobile,desktop,mcp']},
                {'updatedSince': ['2026-10-23T22:59:59.999Z'], 'limit': ['500'], 'origin': ['imessage']}])
            reads = [urllib.parse.unquote(path.split('/')[-2]) for path, _, _ in server.calls
                     if path.endswith('/messages')]
            self.assertCountEqual(reads, ['web', 'mobile', 'desktop', 'mcp', 'bridge', 'overlap'])
            self.assertEqual(stats['owner_queries'], len(server.calls))

    def test_follows_all_filtered_pages_before_reading_messages(self):
        threads = [{'threadId': str(n), 'title': 'App', 'creationSource': 'mcp'} for n in range(2)]
        threads += [{'threadId': 'bridge-' + str(n), 'title': 'iMessage', 'creationSource': 'server',
                     'origin': 'imessage'} for n in range(2)]
        with ControlServer(threads=threads, page_size=1) as server:
            for thread in threads:
                server.rows[thread['threadId']] = [summary(thread['threadId'])]
            stats = Counter()
            self.assertEqual(len(self.read(stats=stats)), 4)
            self.assertEqual([params.get('cursor') for _, params, _ in server.calls[:4]],
                             [None, ['1'], None, ['1']])
            self.assertEqual(stats['owner_queries'], 8)

    def test_stalled_second_page_never_returns_partial_evidence(self):
        threads = [{'threadId': str(n), 'title': 'App'} for n in range(2)]
        with ControlServer(threads=threads, page_size=1, stall_cursor='1') as server:
            started = time.time()
            remaining = 2.2
            with self.assertRaises(ch.Lookup):
                self.read(deadline=started + remaining)
            self.assertLess(time.time() - started, remaining + 1)
            self.assertEqual(len(server.calls), 2)
            self.assertTrue(all(path.endswith('/threads') for path, _, _ in server.calls))

    def test_bad_or_repeated_cursors_fail_closed(self):
        for cursor in ('', 1, False, '1'):
            with self.subTest(cursor=cursor), ControlServer() as server:
                server.responses['/api/ardud/control/threads'] = {
                    'ok': True, 'threads': [{'threadId': 'a'}], 'total': 2, 'nextCursor': cursor}
                with self.assertRaises(ch.Lookup):
                    self.read()
                self.assertLessEqual(len(server.calls), 2)

    def test_total_requests_are_bounded_for_lists_and_messages(self):
        threads = [{'threadId': str(n), 'title': 'App'} for n in range(70)]
        for page_size in (1, 500):
            with self.subTest(page_size=page_size), ControlServer(threads=threads, page_size=page_size) as server:
                with self.assertRaises(ch.Lookup):
                    self.read()
                self.assertLessEqual(len(server.calls), ch.OWNER_REQUEST_LIMIT)
                if page_size == 1:
                    self.assertTrue(all(path.endswith('/threads') for path, _, _ in server.calls))
                else:
                    self.assertEqual(sum(path.endswith('/messages') for path, _, _ in server.calls), 62)

    def test_request_ceiling_is_shared_by_older_question_windows(self):
        threads = [{'threadId': str(n), 'title': 'App'} for n in range(20)]
        stats = Counter()
        with ControlServer(threads=threads) as server:
            self.read(stats=stats)
            for thread in server.threads:
                thread['updatedAt'] = '2026-10-24T01:01:00.000Z'
            self.read(stats=stats)
            self.assertEqual(stats['owner_queries'], 44)
            for thread in server.threads:
                thread['updatedAt'] = '2026-10-24T01:02:00.000Z'
            with self.assertRaisesRegex(ch.Lookup, 'owner read incomplete'):
                self.read(stats=stats)
            self.assertEqual(stats['owner_queries'], len(server.calls))
            self.assertLessEqual(len(server.calls), ch.OWNER_REQUEST_LIMIT)

    def test_control_credential_is_stdin_only_and_curlrc_is_disabled(self):
        run = ch.subprocess.run
        with ControlServer(), patch.object(ch.subprocess, 'run', wraps=run) as fetch:
            self.read()
        for call in fetch.call_args_list:
            self.assertEqual(call.args[0][:2], ['/usr/bin/curl', '-q'])
            self.assertNotIn('test-secret-never-print', repr(call.args))
            self.assertIn(b'Authorization: Bearer test-secret-never-print', call.kwargs['input'])

    def test_stuck_resolver_or_connect_process_is_killed_within_the_deadline(self):
        run = ch.subprocess.run
        def stuck(*args, **kwargs):
            return run(['/usr/bin/python3', '-I', '-c', 'import time; time.sleep(10)'], **kwargs)
        for budget in (1.2, 10):
            with self.subTest(budget=budget), ControlServer() as server:
                stats = Counter()
                started = time.monotonic()
                with patch.object(ch.subprocess, 'run', side_effect=stuck), self.assertRaises(ch.Lookup):
                    ch.control_get(ch.control_config(), '/threads', {}, time.time() + budget, stats)
                self.assertLess(time.monotonic() - started, min(budget, ch.OWNER_REQUEST_TIMEOUT) + 0.7)
                self.assertEqual(stats['owner_timeouts'], 1)
                self.assertEqual(stats['owner_queries'], 1)
                self.assertEqual(stats['owner_list_pages'], 1)

    def test_twenty_threads_fit_the_cap_with_at_most_six_concurrent_requests(self):
        threads = [{'threadId': str(n), 'title': 'App'} for n in range(20)]
        with ControlServer(threads=threads, message_delay=0.5) as server:
            for n in range(20):
                server.rows[str(n)] = [summary(str(n))]
            stats = Counter()
            started = time.time()
            self.assertEqual(len(self.read(deadline=started + 40, stats=stats)), 20)
            self.assertLess(time.time() - started, ch.OWNER_BUDGET)
            self.assertGreater(server.max_active_messages, 1)
            self.assertLessEqual(server.max_active_messages, 6)
            self.assertEqual(stats['owner_queries'], 22)

    def test_all_user_messages_are_read_even_beyond_the_newest_limit(self):
        rows = [summary(str(n)) for n in range(1100)]
        with ControlServer(rows) as server:
            self.assertEqual(len(self.read()), len(rows))
            params = server.calls[-1][1]
            self.assertEqual(params['all'], ['true'])
            self.assertEqual(params['role'], ['user'])
            self.assertEqual(params['since'], ['2026-10-23T22:59:59.999Z'])

    def test_one_failed_thread_discards_other_threads_owner_evidence(self):
        threads = [{'threadId': tid, 'title': 'App'} for tid in ('a', 'bad')]
        with ControlServer([summary('I paid Apple')], threads=threads) as server:
            server.responses['/api/ardud/control/threads/bad/messages'] = {'ok': True, 'total': 1, 'messages': []}
            with self.assertRaisesRegex(ch.Lookup, 'incomplete message list'):
                self.read()

    def test_incomplete_http_body_is_never_owner_evidence(self):
        with ControlServer([summary('I paid Apple')]) as server:
            server.declared_extra = 10
            with self.assertRaisesRegex(ch.Lookup, 'Robob control: request failed'):
                self.read()

    def test_trickled_headers_and_chunk_framing_do_not_hold_cli_exit(self):
        script = '''
import datetime as dt, pathlib, sys, time
sys.path.insert(0, sys.argv[1])
import charges
now = dt.datetime.now(dt.timezone.utc)
try:
    charges.owner_texts(now - dt.timedelta(days=1), now, deadline=time.time() + 2.2)
except charges.Lookup:
    pass
else:
    sys.exit(1)
'''
        for mode in ('headers', 'chunk-framing'):
            with self.subTest(mode=mode), ControlServer() as server:
                server.wire_mode = mode
                started = time.time()
                done = subprocess.run(['/usr/bin/python3', '-I', '-B', '-c', script,
                                       str(Path(__file__).resolve().parent)],
                                      capture_output=True, text=True, timeout=3.2)
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertLess(time.time() - started, 3.2)
                self.assertTrue(any(path.endswith('/messages') for path, _, _ in server.calls))

    def test_failure_while_another_request_stalls_does_not_strand_cli_exit(self):
        script = '''
import datetime as dt, sys, time
sys.path.insert(0, sys.argv[1])
import charges
now = dt.datetime.now(dt.timezone.utc)
for _ in range(3):
    try:
        charges.owner_texts(now - dt.timedelta(days=1), now, deadline=time.time() + 2)
    except charges.Lookup:
        pass
    else:
        sys.exit(1)
print('finished', flush=True)
'''
        threads = [{'threadId': tid, 'title': 'App'} for tid in ('a', 'slow')]
        with ControlServer(threads=threads, stall='/slow/messages') as server:
            server.responses['/api/ardud/control/threads/a/messages'] = {'ok': False}
            started = time.time()
            done = subprocess.run(['/usr/bin/python3', '-I', '-B', '-c', script,
                                   str(Path(__file__).resolve().parent)],
                                  capture_output=True, text=True, timeout=6.5)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stdout.strip(), 'finished')
            self.assertLess(time.time() - started, 6.5)

    def test_schedule_and_wake_cannot_explain_a_charge(self):
        rows = [summary('I paid Apple', automated=True), relayed('I paid Apple', inbound='wake:abc')]
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00', pending=False)
        with ControlServer(rows):
            result = ch.explain(apple, at('2026-10-24T04:10'), at('2026-10-24T04:20'), find=Finder([]))
        self.assertEqual(result['verdict'], 'ask')

    def test_old_or_invalid_provenance_discards_all_evidence(self):
        for key, value in [('automated', 'missing'), ('inboundMessageId', 'missing'),
                           ('automated', None), ('automated', 0), ('inboundMessageId', 123)]:
            with self.subTest(key=key, value=value):
                old = summary('I paid Apple')
                if value == 'missing':
                    old.pop(key)
                else:
                    old[key] = value
                with ControlServer([summary('I paid Apple'), old]), \
                        self.assertRaisesRegex(ch.Lookup, 'provenance unavailable'):
                    self.read()

    def test_http_and_invalid_json_fail_without_credentials_in_errors(self):
        for status, raw in [(503, b'test-secret-never-print'), (200, b'not json'), (200, b'<html>app</html>')]:
            with self.subTest(status=status, raw=raw), ControlServer() as server:
                server.status, server.raw = status, raw
                with self.assertRaises(ch.Lookup) as error:
                    self.read()
                self.assertIn('Robob control:', str(error.exception))
                self.assertNotIn('test-secret-never-print', str(error.exception))

    def test_old_server_cannot_authorize_a_charge_question(self):
        old = summary('I paid Apple')
        del old['automated']
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00', pending=False)
        with ControlServer([old]):
            result = ch.explain(apple, at('2026-10-24T04:10'), at('2026-10-24T04:20'), find=Finder([]))
        self.assertEqual(result['verdict'], 'unverified')
        self.assertIn('provenance unavailable', str(result['errors']))

    def test_truncated_or_malformed_lists_are_lookup_failures(self):
        for result in ({'ok': True, 'total': 501, 'threads': []},
                       {'ok': True, 'total': 'bad', 'threads': []},
                       {'ok': True, 'threads': None}, {'ok': True, 'threads': [None]}):
            with self.subTest(result=result), ControlServer() as server:
                server.raw = json.dumps(result).encode()
                with self.assertRaises(ch.Lookup):
                    self.read()

    def test_credential_errors_do_not_print_the_file_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'control.json'
            for contents in ('{"token":"test-secret-never-print",}', '{}', '[]'):
                path.write_text(contents)
                with patch.dict(os.environ, {'T3_CONTROL_TOKEN_FILE': str(path)}), self.assertRaises(ch.Lookup) as error:
                    self.read()
                self.assertEqual(str(error.exception), 'Robob control: credentials unavailable')

    def test_control_list_count_class_is_complete_or_fails_closed(self):
        # Every count shape applies to both list endpoints; a partial list is never owner silence.
        cases = [('missing', 0, False), (None, 0, False), ('1', 1, False), (True, 1, False),
                 (1.0, 1, False), (-1, 0, False), (1, 0, False), (0, 1, False),
                 (0, 0, True), (1, 1, True)]
        for key in ('threads', 'messages'):
            for total, count, complete in cases:
                with self.subTest(key=key, total=total, count=count), ControlServer() as server:
                    row = server.threads[0] if key == 'threads' else summary('I paid Apple')
                    result = {'ok': True, key: [row] * count}
                    if total != 'missing':
                        result['total'] = total
                    path = '/api/ardud/control/threads' + ('/a/messages' if key == 'messages' else '')
                    server.responses[path] = result
                    if complete:
                        self.read()
                    else:
                        with self.assertRaisesRegex(ch.Lookup, 'Robob control:'):
                            self.read()

    def test_incomplete_messages_cannot_authorize_a_charge_question(self):
        apple = dict(CHARGE, merchant='APPLE.COM/BILL', currency='USD', amount='99.00', pending=False)
        with ControlServer() as server:
            server.responses['/api/ardud/control/threads/a/messages'] = {'ok': True, 'total': 1, 'messages': []}
            result = ch.explain(apple, at('2026-10-24T04:10'), at('2026-10-24T04:20'), find=Finder([]))
        self.assertEqual(result['verdict'], 'unverified')
        self.assertIn('incomplete message list', str(result['errors']))

    def test_unreachable_server_is_a_lookup(self):
        with ControlServer() as server:
            config = ch.control_config()
        with patch.object(ch, 'control_config', return_value=config), self.assertRaisesRegex(ch.Lookup, 'Robob control'):
            self.read()

    def test_stalled_headers_and_trickled_body_obey_remaining_budget(self):
        for stall, drip in [('/threads', False), ('/messages', False), (None, True), (None, '/messages')]:
            with self.subTest(stall=stall, drip=drip), ControlServer(stall=stall, drip=drip):
                started = time.time()
                remaining = 2.2
                with self.assertRaises(ch.Lookup):
                    self.read(deadline=started + remaining)
                self.assertGreater(time.time() - started, 1)
                self.assertLess(time.time() - started, remaining + 1)

    def test_nested_alarm_is_restored(self):
        with ControlServer(stall='/threads'), ch.within(time.time() + 3, RuntimeError('outer')):
            with self.assertRaises(ch.Lookup):
                self.read(deadline=time.time() + 2.2)
            self.assertGreater(ch.signal.getitimer(ch.signal.ITIMER_REAL)[0], 0)



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


class MarketplaceProof(unittest.TestCase):
    def test_freshness_hold_edges_and_positive_precedence(self):
        charges = ch
        import order_lookup
        at = dt.datetime(2026, 11, 10, 12, tzinfo=dt.timezone.utc)
        charge = dict(merchant='noon', amount='12.34', currency='AED')
        for minutes, walked, expected in ((0, 16, 'marketplace_hold'), (15, 15, 'marketplace_hold'),
                (-15, 15, 'marketplace_hold'), (16, 15, None), (-16, 15, None),
                (0, 14, 'marketplace_stale'), (16, 14, 'marketplace_stale')):
            with self.subTest(minutes=minutes, walked=walked):
                result = {'orders': [], 'complete': True, 'lanes': {
                    name: {'exhaustive': True} for name in order_lookup.LANES}}
                result['lanes']['marketplace'].update(
                    walked_at=(at + dt.timedelta(minutes=walked)).isoformat(),
                    hold_times=[(at + dt.timedelta(minutes=minutes)).isoformat()])
                reader = lambda *a, **kw: result
                if expected:
                    with self.assertRaises(charges.SourceLimit) as exc:
                        charges.order_receipt(charge, at, at, lookup=reader)
                    self.assertEqual(exc.exception.kinds, [expected])
                else:
                    self.assertIsNone(charges.order_receipt(charge, at, at, lookup=reader))
                result['orders'] = [dict(order='N1', placed_at=at.isoformat(), total='12.34', currency='AED', status='delivered')]
                self.assertEqual(charges.order_receipt(charge, at, at, lookup=reader)['verdict'], 'receipt')
                result['orders'][0]['status'] = 'cancelled'
                if expected:
                    with self.assertRaises(charges.SourceLimit):
                        charges.order_receipt(charge, at, at, lookup=reader)
                else:
                    self.assertIsNone(charges.order_receipt(charge, at, at, lookup=reader))


class LimitReasons(unittest.TestCase):
    def test_order_limits_keep_exception_types_and_first_blocker(self):
        when = dt.datetime(2026, 11, 10, 12, tzinfo=dt.timezone.utc)
        charge = dict(merchant='noon', amount='12.34', currency='AED')
        for name in ch.order_lookup.LANES:
            for stop, kind in ((None, 'lane_uncovered'), ('covered', 'lane_uncovered'),
                               ('end_of_history', 'lane_uncovered'), ('unproven_paging', 'lane_uncovered'),
                               ('slice_out', 'lane_slice_out'), ('list_error', 'lane_error'),
                               ('reader_error', 'lane_error'), ('detail_error', 'lane_error'),
                               ('snapshot_missing', 'lane_error')):
                for page_one in (False, True):
                    with self.subTest(lane=name, stop=stop, page_one=page_one):
                        result = {'orders': [], 'complete': False, 'lanes': {
                            lane: {'exhaustive': True} for lane in ch.order_lookup.LANES}}
                        result['lanes']['marketplace']['walked_at'] = (when + ch.SAME_TIME).isoformat()
                        result['lanes'][name].update(exhaustive=False, covered_from=when.isoformat(),
                            stop_reason=stop, limit='page-1 history only' if page_one else None)
                        with self.assertRaises(ch.Lookup) as exc:
                            ch.order_receipt(charge, when, when, lookup=lambda *a, **kw: result)
                        self.assertEqual(type(exc.exception), ch.SourceLimit if page_one else ch.Lookup)
                        self.assertEqual(exc.exception.reason, kind + ':' + name)
        for kind in ('marketplace_hold', 'marketplace_stale'):
            self.assertEqual(ch.SourceLimit('private', [kind]).reason, kind)
        self.assertEqual(ch.SourceLimit('private', ['food_page_1', 'marketplace_hold']).reason,
                         'lane_uncovered:food')
        with self.assertRaises(ch.SourceLimit) as exc:
            ch.order_receipt({**charge, 'merchant': 'careem'}, when, when,
                lookup=lambda *a, **kw: (_ for _ in ()).throw(
                    ch.order_lookup.SourceLimit(ch.order_lookup.BINDING_LIMIT)))
        self.assertEqual(exc.exception.reason, 'source_limit:ORDER_LIST_HOST_BINDING_UNVERIFIED')
        self.assertEqual(ch.SourceLimit('private', ['private-id']).reason, 'other')
        self.assertEqual(ch.Lookup('private', 'private-id').reason, 'other')

    def test_marketplace_checks_precede_lane_gaps_and_first_lane_wins(self):
        when = dt.datetime(2026, 11, 10, 12, tzinfo=dt.timezone.utc)
        charge = dict(merchant='noon', amount='12.34', currency='AED')
        result = {'orders': [], 'complete': False, 'lanes': {
            lane: {'exhaustive': False, 'stop_reason': 'slice_out'} for lane in ch.order_lookup.LANES}}
        result['lanes']['marketplace']['hold_times'] = [when.isoformat()]
        def check(reason, error_class):
            with self.assertRaises(error_class) as exc:
                ch.order_receipt(charge, when, when, lookup=lambda *a, **kw: result)
            self.assertEqual(exc.exception.reason, reason)
        check('marketplace_stale', ch.SourceLimit)
        result['lanes']['marketplace']['walked_at'] = (when + ch.SAME_TIME).isoformat()
        check('marketplace_hold', ch.SourceLimit)
        result['lanes']['marketplace']['hold_times'] = []
        check('lane_slice_out:minutes', ch.Lookup)
        result['orders'] = [dict(order='N1', placed_at=when.isoformat(), total='12.34', currency='AED')]
        self.assertEqual(ch.order_receipt(charge, when, when, lookup=lambda *a, **kw: result)['verdict'], 'receipt')

    def test_receipt_timeout_is_first_even_when_order_is_limited(self):
        when = dt.datetime(2026, 11, 10, 12, tzinfo=dt.timezone.utc)
        charge = dict(kind='charge', merchant='noon', amount='12.34', currency='AED', card='1111')
        for failure, reason in ((ch.Lookup('receipt lookup over time'), 'receipt_out_of_time'),
                                (ch.Lookup('private', 'msgs_timeout'), 'msgs_timeout')):
            with self.subTest(reason=reason), patch.object(ch, 'receipt', side_effect=failure), \
                    patch.object(ch, 'order_receipt', side_effect=ch.SourceLimit('private', ['marketplace_hold'])), \
                    patch.object(ch, 'card_owner', return_value='abdullah'), \
                    patch.object(ch, 'owner_said', return_value=None):
                result = ch.explain(charge, when, when)
            self.assertEqual(result['verdict'], 'unverified')
            self.assertTrue(result['errors'])
            self.assertEqual(result['limit_reason'], reason)
            self.assertEqual(result['limits'][0]['reason'], 'marketplace_hold')


if __name__ == '__main__':
    unittest.main()
