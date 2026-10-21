import multiprocessing as mp
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import unittest.mock
import uuid

import commerce_journal as j


def consume_child(root, flow, output=None):
    j.ROOT = Path(root)
    try:
        result = j.consume(flow, 'cart_create', kind='cart', request_hash='b'*64)
        if output is None:
            os._exit(23)
        output.put(result)
    except j.JournalError as exc:
        if output is not None:
            output.put(str(exc))


class CommerceJournalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)/'commerce'
        self.patcher = patch.object(j, 'ROOT', self.root)
        self.patcher.start()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.patcher.stop)
        self.flow = str(uuid.uuid4())

    def open(self, flow=None, account='a'*64, app='noon', vertical='nownow'):
        flow = flow or self.flow
        j.open_flow(flow_id=flow, app=app, vertical=vertical,
                    account_hash=account, scope_hash='s'.encode().hex()*32)
        return flow

    def consume(self, operation='cart_create', kind='cart', flow=None, **kw):
        if kind == 'payment':
            kw.setdefault('payment_order_id', 'SYNTHETIC-ORDER-1')
        return j.consume(flow or self.flow, operation, kind=kind, request_hash='b'*64, **kw)

    def observe(self, operation='cart_create', outcome='RESPONSE_RECEIVED', flow=None, **kw):
        return j.observe(flow or self.flow, operation, outcome=outcome, evidence_hash='e'*64, **kw)

    def place(self, amount=3000, flow=None, cart='c'*64):
        flow = flow or self.flow
        self.consume('place_order', 'place', flow, cart_hash=cart,
                     review_hash='d'*64, payable_minor=amount)
        self.observe('place_order', 'ORDER_ID_RECEIVED', flow, order_id='SYNTHETIC-ORDER-1')

    def finish(self, flow=None):
        flow = flow or self.flow
        for outcome in ('PAYMENT_REPORTED_SUCCESS', 'EXACT_ORDER_CONFIRMED', 'TRACKER_REGISTERED'):
            self.observe('place_order', outcome, flow, order_id='SYNTHETIC-ORDER-1')
        return j.complete(flow)

    def test_open_is_local_owned_and_private(self):
        self.open()
        out = j.inspect(self.flow)
        self.assertEqual(out['state'], 'ACTIVE')
        self.assertEqual(out['operations'], [])
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root/'journal.sqlite').stat().st_mode & 0o777, 0o600)
        self.assertNotIn('account_hash', out)

    def test_bad_scope_before_storage(self):
        for values in ({'app': []}, {'vertical': 'rocket'}, {'account_hash': 'private-account'},
                       {'scope_hash': 'private-token'}, {'flow_id': 'not-a-uuid'}):
            args = dict(flow_id=self.flow, app='noon', vertical='nownow', account_hash='a'*64, scope_hash='b'*64)
            args.update(values)
            with self.subTest(values=values), self.assertRaises(j.JournalError):
                j.open_flow(**args)
        self.assertFalse(self.root.exists())

    def test_new_flow_new_vertical_does_not_escape_account(self):
        self.open()
        with self.assertRaisesRegex(j.JournalError, 'ALREADY_OWNED'):
            self.open(str(uuid.uuid4()), vertical='minutes')
        # Separate platform identity is not blocked by an unrelated platform flow.
        self.open(str(uuid.uuid4()), app='talabat', vertical='mart')

    def test_consume_requires_observed_previous_operation(self):
        self.open(); self.consume()
        with self.assertRaisesRegex(j.JournalError, 'UNOBSERVED'):
            self.consume('fresh_quote', 'quote')
        self.observe()
        self.assertTrue(self.consume('fresh_quote', 'quote'))

    def test_no_duplicate_operation_after_response(self):
        self.open(); self.consume(); self.observe()
        with self.assertRaisesRegex(j.JournalError, 'ALREADY_OWNED_OR_CONSUMED'):
            self.consume()

    def test_unknown_and_challenge_never_released_by_later_success(self):
        for outcome in ('UNKNOWN', 'CHALLENGE_REQUIRED'):
            flow = self.open(str(uuid.uuid4()), account=j.digest(outcome))
            self.place(flow=flow)
            self.observe('place_order', outcome, flow)
            for signal in ('PAYMENT_REPORTED_SUCCESS', 'EXACT_ORDER_CONFIRMED', 'TRACKER_REGISTERED'):
                self.observe('place_order', signal, flow, order_id='SYNTHETIC-ORDER-1')
            with self.assertRaisesRegex(j.JournalError, 'FENCED'): j.complete(flow)
            with self.assertRaisesRegex(j.JournalError, 'FENCED'):
                self.consume('another_quote', 'quote', flow)

    def test_place_reserves_payment_once(self):
        self.open(); self.place()
        self.consume('pay', 'payment', cart_hash='c'*64, review_hash='d'*64, payable_minor=3000)
        self.assertEqual(j.inspect(self.flow)['campaign_reserved_minor'], 3000)
        self.observe('pay', 'PAYMENT_REPORTED_SUCCESS', order_id='SYNTHETIC-ORDER-1')
        with self.assertRaisesRegex(j.JournalError, 'PAYMENT_ALREADY_CONSUMED'):
            self.consume('pay_new_identity', 'payment', cart_hash='c'*64, review_hash='d'*64, payable_minor=3000)

    def test_payment_exact_cart_amount_review_and_order_required(self):
        self.open()
        with self.assertRaisesRegex(j.JournalError, 'NOT_BOUND'):
            self.consume('pay', 'payment', cart_hash='c'*64, review_hash='d'*64, payable_minor=3000)
        self.place()
        for changes in ({'cart_hash': 'f'*64}, {'review_hash': 'f'*64}, {'payable_minor': 2999}):
            args = dict(cart_hash='c'*64, review_hash='d'*64, payable_minor=3000); args.update(changes)
            with self.subTest(changes=changes), self.assertRaisesRegex(j.JournalError, 'NOT_BOUND'):
                self.consume('pay', 'payment', **args)

    def test_payment_after_combined_place_payment_success_denied(self):
        self.open(); self.place()
        self.observe('place_order', 'PAYMENT_REPORTED_SUCCESS', order_id='SYNTHETIC-ORDER-1')
        with self.assertRaisesRegex(j.JournalError, 'PAYMENT_ALREADY_REPORTED'):
            self.consume('pay', 'payment', cart_hash='c'*64, review_hash='d'*64, payable_minor=3000)

    def test_payment_target_order_required_and_exact_before_consumption(self):
        self.open(); self.place()
        for target in (None, 'SYNTHETIC-OTHER-ORDER', True, ''):
            with self.subTest(target=target), self.assertRaisesRegex(j.JournalError, 'PAYMENT_ORDER'):
                self.consume('pay', 'payment', cart_hash='c'*64, review_hash='d'*64,
                             payable_minor=3000, payment_order_id=target)
        self.assertEqual(len(j.inspect(self.flow)['operations']), 1)

    def test_separate_payment_completion_requires_its_own_success(self):
        self.open(); self.place()
        self.consume('pay', 'payment', cart_hash='c'*64, review_hash='d'*64, payable_minor=3000)
        self.observe('pay')
        for outcome in ('PAYMENT_REPORTED_SUCCESS', 'EXACT_ORDER_CONFIRMED', 'TRACKER_REGISTERED'):
            self.observe('place_order', outcome, order_id='SYNTHETIC-ORDER-1')
        with self.assertRaisesRegex(j.JournalError, 'COMPLETION_UNPROVEN'): j.complete(self.flow)
        self.observe('pay', 'PAYMENT_REPORTED_SUCCESS', order_id='SYNTHETIC-ORDER-1')
        # A stale pre-payment readback is not confirmation of this payment.
        with self.assertRaisesRegex(j.JournalError, 'COMPLETION_UNPROVEN'): j.complete(self.flow)
        self.observe('pay', 'EXACT_ORDER_CONFIRMED', order_id='SYNTHETIC-ORDER-1')
        self.assertEqual(j.complete(self.flow)['state'], 'COMPLETE')

    def test_completed_order_id_cannot_be_rebound_to_new_flow(self):
        self.open(); self.place(); self.finish()
        other = self.open(str(uuid.uuid4()))
        self.consume('place_order', 'place', other, cart_hash='f'*64,
                     review_hash='d'*64, payable_minor=3000)
        with self.assertRaisesRegex(j.JournalError, 'ORDER_ALREADY_OWNED'):
            self.observe('place_order', 'ORDER_ID_RECEIVED', other, order_id='SYNTHETIC-ORDER-1')
        self.assertIsNone(j.inspect(other)['order_id'])

    def test_incompatible_existing_schema_refused_not_repaired(self):
        self.open()
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            db.execute('DROP INDEX active_account')
            db.execute("CREATE UNIQUE INDEX active_account ON flows(app, account_hash, vertical) WHERE state != 'COMPLETE'")
        with self.assertRaisesRegex(j.JournalError, 'SCHEMA_UNSUPPORTED'):
            self.consume()
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            self.assertIn('vertical', db.execute("SELECT sql FROM sqlite_master WHERE name='active_account'").fetchone()[0])

    def test_missing_schema_component_refused(self):
        self.open()
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            db.execute('DROP TABLE observations')
        with self.assertRaisesRegex(j.JournalError, 'SCHEMA_UNSUPPORTED'): self.consume()

    def test_extra_trigger_refused(self):
        self.open()
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            db.execute("CREATE TRIGGER unexpected AFTER INSERT ON observations BEGIN SELECT 1; END")
        with self.assertRaisesRegex(j.JournalError, 'SCHEMA_UNSUPPORTED'): self.consume()

    def test_unexpected_schema_version_refused(self):
        self.open()
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            db.execute('PRAGMA user_version=999')
        with self.assertRaisesRegex(j.JournalError, 'SCHEMA_UNSUPPORTED'): self.consume()

    def test_no_extra_mutation_or_second_place_after_place(self):
        self.open(); self.place()
        for kind in ('cart', 'quote', 'instructions', 'selection', 'place'):
            args = dict(cart_hash='c'*64, review_hash='d'*64, payable_minor=3000) if kind == 'place' else {}
            with self.subTest(kind=kind), self.assertRaisesRegex(j.JournalError, 'PLACE_ALREADY_CONSUMED'):
                self.consume('next_'+kind, kind, **args)

    def test_amount_strict_types_and_representation_before_consumption(self):
        self.open()
        for amount in (True, 0, -1, j.MAX_SQLITE_INTEGER + 1, 3000.0, '3000'):
            with self.subTest(amount=amount), self.assertRaisesRegex(j.JournalError, 'BUDGET_INVALID'):
                self.place(amount)
        self.assertEqual(j.inspect(self.flow)['reserved_minor'], 0)

    def test_abandon_requires_unsent_reads_only_flow(self):
        # Active-only guard: an unknown flow id is refused.
        with self.assertRaisesRegex(j.JournalError, 'FLOW_UNKNOWN|ABANDON'):
            j.abandon(str(uuid.uuid4()))
        # A fresh flow with only observed quote reads can be abandoned.
        fresh = self.open(str(uuid.uuid4()))
        self.consume('quote_initial', 'quote', flow=fresh)
        self.observe('quote_initial', 'RESPONSE_RECEIVED', flow=fresh)
        result = j.abandon(fresh)
        self.assertEqual(result['state'], 'RELEASED')
        self.assertFalse(result['retry_allowed'])
        # Account slot freed: a new flow for the same account can open and consume.
        nxt = self.open(str(uuid.uuid4()))
        self.place(3000, flow=nxt)
        # A flow that placed cannot be abandoned.
        with self.assertRaisesRegex(j.JournalError, 'ABANDON_UNSENT_ONLY'):
            j.abandon(nxt)

    def test_abandon_accepts_read_only_fenced_flow(self):
        # A quote observed UNKNOWN fences the flow; with no financial op and
        # no unobserved send it is still safe to abandon (process-loss close).
        flow = self.open(str(uuid.uuid4()))
        self.consume('quote_initial', 'quote', flow=flow)
        self.observe('quote_initial', 'UNKNOWN', flow=flow)
        self.assertEqual(j.inspect(flow)['state'], 'FENCED')
        result = j.abandon(flow)
        self.assertEqual(result['state'], 'RELEASED')
        # Account slot freed for a successor.
        nxt = self.open(str(uuid.uuid4()))
        self.consume('quote_initial', 'quote', flow=nxt)

    def test_no_per_order_or_lifetime_spending_cap(self):
        for i in range(3):
            flow = self.open(str(uuid.uuid4()), account=j.digest(i))
            self.place(1234567, flow=flow, cart=j.digest(('cart', i)))
            self.finish(flow)
        another = self.open(str(uuid.uuid4()), account=j.digest('another'))
        self.place(9999999, flow=another)
        current = j.inspect(another)
        self.assertEqual(current['campaign_reserved_minor'], 3 * 1234567 + 9999999)
        self.assertIsNone(current['campaign_limit_minor'])
        self.assertIsNone(current['order_limit_minor'])

    def test_historical_policy_and_ambiguous_ownership_are_preserved(self):
        self.open()
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            db.execute('INSERT INTO campaigns VALUES (?,?,?)', ('http-lifecycle-20261009', 30000, 4500))
            db.execute('UPDATE flows SET campaign=? WHERE id=?', ('http-lifecycle-20261009', self.flow))
        self.place(5500)
        self.observe('place_order', 'UNKNOWN')
        old = j.inspect(self.flow)
        self.assertEqual(old['campaign_reserved_minor'], 5500)
        self.assertEqual(old['historical_campaign_limit_minor'], 30000)
        self.assertEqual(old['state'], 'FENCED')
        with self.assertRaises(j.JournalError):
            self.open(str(uuid.uuid4()))
        other = self.open(str(uuid.uuid4()), account=j.digest('new-account'))
        self.assertEqual(j.inspect(other)['campaign_reserved_minor'], 0)
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            self.assertEqual(db.execute('SELECT total_limit,order_limit FROM campaigns WHERE name=?',
                                       ('http-lifecycle-20261009',)).fetchone(), (30000, 4500))

    def test_complete_requires_exact_confirmation_and_tracker(self):
        self.open(); self.place()
        with self.assertRaisesRegex(j.JournalError, 'COMPLETION_UNPROVEN'): j.complete(self.flow)
        self.observe('place_order', 'PAYMENT_REPORTED_SUCCESS', order_id='SYNTHETIC-ORDER-1')
        self.observe('place_order', 'EXACT_ORDER_CONFIRMED', order_id='SYNTHETIC-ORDER-1')
        with self.assertRaisesRegex(j.JournalError, 'COMPLETION_UNPROVEN'): j.complete(self.flow)
        self.observe('place_order', 'TRACKER_REGISTERED', order_id='SYNTHETIC-ORDER-1')
        self.assertEqual(j.complete(self.flow)['state'], 'COMPLETE')
        next_flow = self.open(str(uuid.uuid4()))
        with self.assertRaisesRegex(j.JournalError, 'CART_ALREADY_OWNED'):
            self.consume('other_cart', 'cart', next_flow, cart_hash='c'*64)
        self.assertTrue(self.consume('other_cart', 'cart', next_flow, cart_hash='f'*64))

    def test_no_order_id_switch_or_order_on_cart_operation(self):
        self.open(); self.consume()
        with self.assertRaisesRegex(j.JournalError, 'NONFINANCIAL'):
            self.observe(outcome='ORDER_ID_RECEIVED', order_id='SYNTHETIC-ORDER-1')
        self.observe(); self.place()
        with self.assertRaisesRegex(j.JournalError, 'ID_CHANGED'):
            self.observe('place_order', 'EXACT_ORDER_CONFIRMED', order_id='OTHER-ORDER')

    def test_invalid_observation_no_raw_text_leaks(self):
        self.open(); self.consume()
        for kw in ({'outcome': 'private server error'}, {'evidence_hash': 'private response'},
                   {'order_id': 'private/URL'}, {'outcome': 'ORDER_ID_RECEIVED'}):
            args = dict(outcome='RESPONSE_RECEIVED', evidence_hash='e'*64); args.update(kw)
            with self.assertRaises(j.JournalError) as caught: j.observe(self.flow, 'cart_create', **args)
            self.assertNotIn('private', str(caught.exception))

    def test_crash_after_consumption_stays_spent(self):
        self.open()
        ctx = mp.get_context('spawn')
        child = ctx.Process(target=consume_child, args=(str(self.root), self.flow))
        child.start(); child.join(10)
        if child.is_alive(): child.terminate(); child.join(); self.fail('child timeout')
        self.assertEqual(child.exitcode, 23)
        self.assertEqual(j.inspect(self.flow)['operations'][0]['state'], 'MAY_HAVE_SENT')
        with self.assertRaises(j.JournalError): self.consume()

    def test_concurrent_consumers_only_one_permission(self):
        self.open()
        ctx = mp.get_context('spawn'); output = ctx.Queue()
        children = [ctx.Process(target=consume_child, args=(str(self.root), self.flow, output)) for _ in range(3)]
        try:
            for child in children: child.start()
            for child in children:
                child.join(10); self.assertFalse(child.is_alive()); self.assertEqual(child.exitcode, 0)
            results = [output.get(timeout=2) for _ in children]
            self.assertEqual(sum(result is True for result in results), 1, results)
        finally:
            for child in children:
                if child.is_alive(): child.terminate(); child.join()
            output.close(); output.join_thread()

    def test_directory_sync_failure_after_commit_is_spent(self):
        self.open()
        with patch.object(j.os, 'fsync', side_effect=OSError('private path')):
            with self.assertRaisesRegex(j.JournalError, 'UNAVAILABLE'): self.consume()
        with self.assertRaisesRegex(j.JournalError, 'UNOBSERVED'): self.consume()

    def test_security_paths_and_corrupt_database_fail_without_repair(self):
        other = Path(self.temp.name)/'other'; other.mkdir(mode=0o700)
        self.root.symlink_to(other)
        with self.assertRaises(j.JournalError): self.open()
        self.root.unlink(); self.root.mkdir(mode=0o700)
        path = self.root/'journal.sqlite'; path.write_bytes(b'corrupt'); path.chmod(0o600)
        with self.assertRaises(j.JournalError): self.open()
        self.assertEqual(path.read_bytes(), b'corrupt')

    def test_database_symlink_hardlink_and_bad_mode_denied(self):
        self.open(); path = self.root/'journal.sqlite'
        path.chmod(0o644)
        with self.assertRaises(j.JournalError): j.inspect(self.flow)
        path.chmod(0o600); os.link(path, self.root/'hardlink')
        with self.assertRaises(j.JournalError): j.inspect(self.flow)
        (self.root/'hardlink').unlink(); path.rename(self.root/'real'); path.symlink_to(self.root/'real')
        with self.assertRaises(j.JournalError): j.inspect(self.flow)

    def test_parent_required_and_synced(self):
        with patch.object(j, 'ROOT', self.root/'absent'/'commerce'):
            with self.assertRaises(j.JournalError): self.open()
        self.assertFalse(self.root.exists())
        synced = []; original = j.os.fsync
        def sync(fd):
            synced.append(os.fstat(fd).st_ino); original(fd)
        with patch.object(j.os, 'fsync', side_effect=sync): self.open()
        self.assertIn(self.root.stat().st_ino, synced)
        self.assertIn(self.root.parent.stat().st_ino, synced)

    def test_sqlite_prefix_lookalike_trigger_cannot_hide_or_release_unknown(self):
        self.open(); self.consume()
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            db.execute("""CREATE TRIGGER sqliteX AFTER UPDATE OF state ON flows
                          WHEN NEW.state='FENCED' BEGIN
                          UPDATE flows SET state='COMPLETE' WHERE id=NEW.id; END""")
        with self.assertRaisesRegex(j.JournalError, 'SCHEMA_UNSUPPORTED'):
            self.observe(outcome='UNKNOWN')
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            self.assertEqual(db.execute('SELECT state FROM flows').fetchone()[0], 'ACTIVE')
            self.assertEqual(db.execute('SELECT state FROM operations').fetchone()[0], 'MAY_HAVE_SENT')
        with self.assertRaisesRegex(j.JournalError, 'SCHEMA_UNSUPPORTED'):
            self.open(str(uuid.uuid4()))

    def test_only_hashed_private_payloads_are_written(self):
        self.open()
        marker = 'private-card-token-not-to-persist'
        j.consume(self.flow, 'cart_create', kind='cart', request_hash=j.digest({'token': marker}))
        self.assertNotIn(marker.encode(), (self.root/'journal.sqlite').read_bytes())
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM operations').fetchone()[0], 1)


class ReleaseTest(unittest.TestCase):
    """Terminal, evidence-reviewed closure of a fenced never-paid flow."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)/'commerce'
        self.patcher = patch.object(j, 'ROOT', self.root)
        self.patcher.start()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.patcher.stop)
        self.flow = str(uuid.uuid4())

    def fenced_unpaid_flow(self, app='noon', vertical='minutes'):
        j.open_flow(flow_id=self.flow, app=app, vertical=vertical,
                    account_hash='a'*64, scope_hash='s'.encode().hex()*32)
        j.consume(self.flow, 'place_order', kind='place', request_hash='b'*64,
                  cart_hash='c'*64, review_hash='d'*64, payable_minor=1725)
        j.observe(self.flow, 'place_order', outcome='ORDER_ID_RECEIVED',
                  evidence_hash='e'*64, order_id='IAEGAFAILED1')
        return j.inspect(self.flow)

    def fence_it(self):
        j.observe(self.flow, 'place_order', outcome='UNKNOWN',
                  evidence_hash='f'*64, order_id='IAEGAFAILED1')
        return j.inspect(self.flow)

    def test_payment_reported_flips_exactly_once_observed(self):
        self.fenced_unpaid_flow()
        self.assertFalse(j.payment_reported(self.flow))
        j.observe(self.flow, 'place_order', outcome='PAYMENT_REPORTED_SUCCESS',
                  evidence_hash='e'*64, order_id='IAEGAFAILED1')
        self.assertTrue(j.payment_reported(self.flow))
        with self.assertRaisesRegex(j.JournalError, 'FLOW_UNKNOWN'):
            j.payment_reported(str(uuid.uuid4()))

    def test_release_frees_account_fence_without_retry_or_order_reuse(self):
        self.fenced_unpaid_flow()
        self.fence_it()
        self.assertEqual(j.inspect(self.flow)['state'], 'FENCED')
        with self.assertRaisesRegex(j.JournalError, 'ACCOUNT_RECONCILIATION_REQUIRED'):
            j.require_account_available('noon', 'a'*64)
        result = j.release(self.flow, evidence_hash='1'*64)
        self.assertEqual(result['state'], 'RELEASED')
        self.assertTrue(result['reservation_minor_retained'])
        self.assertFalse(result['retry_allowed'])
        j.require_account_available('noon', 'a'*64)
        other = str(uuid.uuid4())
        j.open_flow(flow_id=other, app='noon', vertical='minutes',
                    account_hash='a'*64, scope_hash='s'.encode().hex()*32)
        # Reservation stays counted against the campaign budget.
        self.assertEqual(j.inspect(other)['campaign_reserved_minor'], 1725)
        # The failed order stays owned; a new flow cannot rebind its identity.
        j.consume(other, 'place_order', kind='place', request_hash='b'*64,
                  cart_hash='e'*64, review_hash='d'*64, payable_minor=1000)
        with self.assertRaisesRegex(j.JournalError, 'ORDER_ALREADY_OWNED'):
            j.observe(other, 'place_order', outcome='ORDER_ID_RECEIVED',
                      evidence_hash='e'*64, order_id='IAEGAFAILED1')
        # A released flow is terminal: no completion, no further operations.
        with self.assertRaisesRegex(j.JournalError, 'FLOW_FENCED'):
            j.complete(self.flow)
        with self.assertRaisesRegex(j.JournalError, 'FLOW_FENCED'):
            j.consume(self.flow, 'payment', kind='payment', request_hash='b'*64,
                      cart_hash='c'*64, review_hash='d'*64, payable_minor=1725,
                      payment_order_id='IAEGAFAILED1')

    def test_release_refuses_wrong_states_and_payment_history(self):
        self.fenced_unpaid_flow()
        j.consume(self.flow, 'payment', kind='payment', request_hash='b'*64,
                  cart_hash='c'*64, review_hash='d'*64, payable_minor=1725,
                  payment_order_id='IAEGAFAILED1')
        j.observe(self.flow, 'payment', outcome='RESPONSE_RECEIVED', evidence_hash='e'*64)
        self.fence_it()
        with self.assertRaisesRegex(j.JournalError, 'PAYMENT_HISTORY_INVALID'):
            j.release(self.flow, evidence_hash='1'*64)
        other = str(uuid.uuid4())
        j.open_flow(flow_id=other, app='noon', vertical='minutes',
                    account_hash='f'*64, scope_hash='s'.encode().hex()*32)
        j.consume(other, 'cart_create', kind='cart', request_hash='b'*64)
        j.observe(other, 'cart_create', outcome='RESPONSE_RECEIVED', evidence_hash='e'*64)
        with self.assertRaisesRegex(j.JournalError, 'FENCED_ONLY'):
            j.release(other, evidence_hash='1'*64)
        with self.assertRaisesRegex(j.JournalError, 'RELEASE_INVALID'):
            j.release(other, evidence_hash='not-a-hash')
        no_order = str(uuid.uuid4())
        j.open_flow(flow_id=no_order, app='noon', vertical='minutes',
                    account_hash='e'*64, scope_hash='s'.encode().hex()*32)
        j.consume(no_order, 'cart_create', kind='cart', request_hash='b'*64)
        j.observe(no_order, 'cart_create', outcome='UNKNOWN', evidence_hash='e'*64)
        with self.assertRaisesRegex(j.JournalError, 'ORDER_REQUIRED'):
            j.release(no_order, evidence_hash='1'*64)

    def test_release_refuses_unobserved_send(self):
        self.fenced_unpaid_flow()
        j.consume(self.flow, 'payment', kind='payment', request_hash='b'*64,
                  cart_hash='c'*64, review_hash='d'*64, payable_minor=1725,
                  payment_order_id='IAEGAFAILED1')
        # payment op left MAY_HAVE_SENT without any observation, then the
        # place observation degraded to UNKNOWN: fenced with a live unknown send.
        self.fence_it()
        with self.assertRaisesRegex(j.JournalError, 'UNOBSERVED_SEND'):
            j.release(self.flow, evidence_hash='1'*64)

    def test_legacy_fence_index_migrates_once_and_other_schemas_still_refuse(self):
        self.fenced_unpaid_flow()
        self.fence_it()
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            db.execute('DROP TABLE owner_attestations')
            db.execute('DROP TABLE duplicate_closures')
            db.execute('PRAGMA user_version=1')
            db.execute('DROP INDEX active_account')
            db.execute("CREATE UNIQUE INDEX active_account "
                       "ON flows(app, account_hash) WHERE state != 'COMPLETE'")
        # Any operation performs the one-way migration inside its transaction.
        j.release(self.flow, evidence_hash='1'*64)
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            sql = db.execute("SELECT sql FROM sqlite_master WHERE name='active_account'").fetchone()[0]
            self.assertIn("RELEASED", sql)
        # An unrelated index shape is still refused, not repaired.
        j.open_flow(flow_id=str(uuid.uuid4()), app='noon', vertical='nownow',
                    account_hash='d'*64, scope_hash='s'.encode().hex()*32)
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            db.execute('DROP INDEX active_account')
            db.execute("CREATE UNIQUE INDEX active_account "
                       "ON flows(app, account_hash, vertical) WHERE state != 'COMPLETE'")
        with self.assertRaisesRegex(j.JournalError, 'SCHEMA_UNSUPPORTED'):
            j.release(self.flow, evidence_hash='2'*64)


if __name__ == '__main__': unittest.main()

class StableCartAdoptionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)/'commerce'
        self.patcher = patch.object(j, 'ROOT', self.root)
        self.patcher.start()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.patcher.stop)
        self.account = 'a'*64
        self.old, self.new = str(uuid.uuid4()), str(uuid.uuid4())

    def open(self, flow, app='talabat', vertical='mart', account=None):
        j.open_flow(flow_id=flow, app=app, vertical=vertical,
                    account_hash=account or self.account, scope_hash='s'.encode().hex()*32)
        return flow

    def prior_owner(self):
        """Old flow: quote consumed with a cart binding (owns the carts row), observed, abandoned."""
        flow = self.open(self.old)
        j.consume(flow, 'quote_initial', kind='quote', request_hash='b'*64, cart_hash='c'*64)
        j.observe(flow, 'quote_initial', outcome='RESPONSE_RECEIVED', evidence_hash='e'*64)
        j.abandon(flow)
        return flow

    def interrupted(self):
        """New flow: exactly one create_cart MAY_HAVE_SENT, no receipt, no observation."""
        flow = self.open(self.new)
        j.consume(flow, 'create_cart', kind='cart', request_hash='b'*64)
        return flow

    def adopt(self, old=None, cart='c'*64, evidence='e'*64, new=None):
        return j.adopt_stable_cart(new or self.new, old or self.old, cart, evidence_hash=evidence)

    def test_adoption_transfers_carts_row_and_records_evidence(self):
        self.prior_owner(); self.interrupted()
        result = self.adopt()
        self.assertTrue(result['transferred'])
        self.assertEqual(j.cart_owner('talabat', self.account, 'c'*64), self.new)
        with self.assertRaises(j.JournalError):
            self.adopt()  # prior owner no longer owns the row
        db = sqlite3.connect(self.root/'journal.sqlite'); db.row_factory = sqlite3.Row
        rows = list(db.execute(
            "SELECT outcome FROM observations WHERE flow_id=? AND operation='create_cart'", (self.new,)))
        db.close()
        outcomes = {r['outcome'] for r in rows}
        # Evidence only: the operation stays MAY_HAVE_SENT until its own settle.
        self.assertIn('STABLE_CART_ADOPTED', outcomes)
        self.assertEqual([x for x in j.inspect(self.new)['operations']
                          if x['name'] == 'create_cart'][0]['state'], 'MAY_HAVE_SENT')

    def test_adoption_refuses_completed_prior_owner_with_financial_history(self):
        # The (app,account) unique partial index guarantees a prior owner is
        # terminal whenever a successor exists; the financial-history refusal
        # therefore matters for a COMPLETE prior owner (paid order).
        flow = self.open(self.old)
        j.consume(flow, 'quote_initial', kind='quote', request_hash='b'*64, cart_hash='c'*64)
        j.observe(flow, 'quote_initial', outcome='RESPONSE_RECEIVED', evidence_hash='e'*64)
        j.consume(flow, 'place_order', kind='place', request_hash='b'*64,
                  cart_hash='c'*64, review_hash='d'*64, payable_minor=3000)
        j.observe(flow, 'place_order', outcome='ORDER_ID_RECEIVED', evidence_hash='e'*64, order_id='ORD-1')
        j.consume(flow, 'pay', kind='payment', request_hash='b'*64, cart_hash='c'*64,
                  review_hash='d'*64, payable_minor=3000, payment_order_id='ORD-1')
        for outcome in ('PAYMENT_REPORTED_SUCCESS', 'EXACT_ORDER_CONFIRMED', 'TRACKER_REGISTERED'):
            j.observe(flow, 'pay', outcome=outcome, evidence_hash='e'*64, order_id='ORD-1')
        j.complete(flow)
        self.interrupted()
        with self.assertRaisesRegex(j.JournalError, 'PRIOR_OWNER'):
            self.adopt()

    def test_adoption_refuses_unknown_prior_and_claims_receipts_only_row(self):
        self.prior_owner(); self.interrupted()
        with self.assertRaisesRegex(j.JournalError, 'FLOW_UNKNOWN'):
            self.adopt(old=str(uuid.uuid4()))
        # Receipts-only prior: no carts row exists (prior never quoted); the
        # successor now CLAIMS the identity instead of being refused.
        self.adopt(cart='f'*64)
        owner = j.cart_owner('talabat', self.account, 'f'*64)
        self.assertEqual(owner, self.new)

    def test_adoption_requires_new_flow_active_with_cart_operation(self):
        self.prior_owner()
        self.open(self.new)
        with self.assertRaisesRegex(j.JournalError, 'NEW_FLOW'):
            self.adopt()
        j.consume(self.new, 'create_cart', kind='cart', request_hash='b'*64)
        j.observe(self.new, 'create_cart', outcome='RESPONSE_RECEIVED', evidence_hash='e'*64)
        j.abandon(self.new)
        with self.assertRaisesRegex(j.JournalError, 'NEW_FLOW'):
            self.adopt()


class OrderlessPlaceRecoveryTest(unittest.TestCase):
    """release_orderless + adoption from a prior flow whose place POST was
    answered with an orderless refusal (4xx, no order id): the below-minimum
    generic-400 shape seen live on the mart lane."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)/'commerce'
        self.patcher = patch.object(j, 'ROOT', self.root)
        self.patcher.start()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.patcher.stop)
        self.account = 'a'*64
        self.old, self.new = str(uuid.uuid4()), str(uuid.uuid4())
        self.cart = 'c'*64

    def open(self, flow):
        j.open_flow(flow_id=flow, app='talabat', vertical='mart',
                    account_hash=self.account, scope_hash='s'.encode().hex()*32)
        return flow

    def refused_prior(self):
        """FENCED talabat flow: quotes + place OBSERVED with outcome UNKNOWN and
        NO order id; owns the carts row via the quote consume."""
        flow = self.open(self.old)
        j.consume(flow, 'quote_initial', kind='quote', request_hash='b'*64, cart_hash=self.cart)
        j.observe(flow, 'quote_initial', outcome='RESPONSE_RECEIVED', evidence_hash='e'*64)
        j.consume(flow, 'place_order', kind='place', request_hash='b'*64,
                  cart_hash=self.cart, review_hash='d'*64, payable_minor=1584)
        j.observe(flow, 'place_order', outcome='UNKNOWN', evidence_hash='f'*64)
        return flow

    def successor(self):
        flow = self.open(self.new)
        j.consume(flow, 'create_cart', kind='cart', request_hash='b'*64)
        return flow

    def test_release_orderless_closes_refused_flow_and_frees_account(self):
        self.refused_prior()
        self.assertEqual(j.inspect(self.old)['state'], 'FENCED')
        with self.assertRaisesRegex(j.JournalError, 'ACCOUNT_RECONCILIATION_REQUIRED'):
            j.require_account_available('talabat', self.account)
        result = j.release_orderless(self.old, evidence_hash='1'*64)
        self.assertEqual(result['state'], 'RELEASED')
        self.assertTrue(result['reservation_minor_retained'])
        self.assertFalse(result['retry_allowed'])
        j.require_account_available('talabat', self.account)
        db = sqlite3.connect(self.root/'journal.sqlite'); db.row_factory = sqlite3.Row
        rows = list(db.execute(
            "SELECT outcome FROM observations WHERE flow_id=? AND operation='place'", (self.old,)))
        db.close()
        self.assertIn('FLOW_RELEASED_PLACE_REFUSED_NO_ORDER', {r['outcome'] for r in rows})

    def test_release_orderless_enforces_refused_shape(self):
        # Order-bearing fenced flow must use release(), not the orderless path.
        other_account = 'd'*64
        flow = str(uuid.uuid4())
        j.open_flow(flow_id=flow, app='talabat', vertical='mart',
                    account_hash=other_account, scope_hash='s'.encode().hex()*32)
        j.consume(flow, 'quote_initial', kind='quote', request_hash='b'*64, cart_hash=self.cart)
        j.observe(flow, 'quote_initial', outcome='RESPONSE_RECEIVED', evidence_hash='e'*64)
        j.consume(flow, 'place_order', kind='place', request_hash='b'*64,
                  cart_hash=self.cart, review_hash='d'*64, payable_minor=4109)
        j.observe(flow, 'place_order', outcome='ORDER_ID_RECEIVED',
                  evidence_hash='e'*64, order_id='3947177570')
        j.observe(flow, 'place_order', outcome='UNKNOWN', evidence_hash='f'*64)
        self.assertEqual(j.inspect(flow)['state'], 'FENCED')
        with self.assertRaisesRegex(j.JournalError, 'ORDER_PRESENT'):
            j.release_orderless(flow, evidence_hash='1'*64)
        # No place at all / not fenced.
        fresh = self.open(str(uuid.uuid4()))
        with self.assertRaisesRegex(j.JournalError, 'FENCED_ONLY'):
            j.release_orderless(fresh, evidence_hash='1'*64)
        # Unobserved place send keeps the fence.
        j.open_flow(flow_id=(unobserved := str(uuid.uuid4())), app='talabat', vertical='mart',
                    account_hash='e'*64, scope_hash='s'.encode().hex()*32)
        j.consume(unobserved, 'place_order', kind='place', request_hash='b'*64,
                  cart_hash=self.cart, review_hash='d'*64, payable_minor=1584)
        with self.assertRaisesRegex(j.JournalError, 'FENCED_ONLY'):
            j.release_orderless(unobserved, evidence_hash='1'*64)

    def test_adoption_from_released_orderless_prior(self):
        self.refused_prior()
        j.release_orderless(self.old, evidence_hash='1'*64)
        self.successor()
        result = j.adopt_stable_cart(self.new, self.old, self.cart, evidence_hash='2'*64)
        self.assertTrue(result['transferred'])
        self.assertEqual(j.cart_owner('talabat', self.account, self.cart), self.new)

    def test_adoption_still_refuses_prior_with_order_or_payment(self):
        # Order-bearing fenced prior (the ghost shape) never adopts.
        other_account = 'd'*64
        flow = str(uuid.uuid4())
        j.open_flow(flow_id=flow, app='talabat', vertical='mart',
                    account_hash=other_account, scope_hash='s'.encode().hex()*32)
        j.consume(flow, 'quote_initial', kind='quote', request_hash='b'*64, cart_hash=self.cart)
        j.observe(flow, 'quote_initial', outcome='RESPONSE_RECEIVED', evidence_hash='e'*64)
        j.consume(flow, 'place_order', kind='place', request_hash='b'*64,
                  cart_hash=self.cart, review_hash='d'*64, payable_minor=4109)
        j.observe(flow, 'place_order', outcome='ORDER_ID_RECEIVED',
                  evidence_hash='e'*64, order_id='3947177570')
        j.observe(flow, 'place_order', outcome='UNKNOWN', evidence_hash='f'*64)
        self.assertEqual(j.inspect(flow)['state'], 'FENCED')
        with self.assertRaisesRegex(j.JournalError, 'ORDER_PRESENT'):
            j.release_orderless(flow, evidence_hash='1'*64)
        self.successor()
        with self.assertRaisesRegex(j.JournalError, 'PRIOR_OWNER'):
            j.adopt_stable_cart(self.new, flow, self.cart, evidence_hash='2'*64)


class RecoverUnknownRepollTest(unittest.TestCase):
    """A stored PAYMENT_UNKNOWN payment_status cursor must not freeze recovery.

    The talabat async poller stores literal states; a 'Success' literal with
    unexpected casing previously mapped to UNKNOWN and the recover short-circuit
    treated any stopped cursor as conclusive. Recovery must re-poll exactly
    that state; genuinely conclusive cursors still settle from evidence alone.
    """

    def _recover(self, state):
        from types import SimpleNamespace
        import commerce_cli
        import commerce_journal as journal_mod
        import commerce_receipts as receipts_mod

        cursor = SimpleNamespace(stopped=True, result=SimpleNamespace(
            state=state, reason='literal'), next_index=3,
            context={'acceptance_id': 'a' * 36})
        calls = {'polls': 0, 'fresh': 0}

        class Store:
            def __call__(self, record, **kw):
                return True

            def snapshot(self):
                return SimpleNamespace(receipts=[SimpleNamespace(operation='payment', order_id='123',
                                                                 context=cursor.context)],
                                       talabat_readback=lambda: cursor)

        class Auth:
            def fresh_before_mutation(self, app, vertical):
                calls['fresh'] += 1
                return self

            def mutation_account(self, vertical):
                return object()

        class Poller:
            def __init__(self, *a, **k):
                pass

            def poll(self, *, max_reads):
                calls['polls'] += 1
                self.next_index = 4
                return SimpleNamespace(state='PAYMENT_REPORTED_SUCCESS',
                                       reason='polled', next_index=4)

        binding = {'app': 'talabat', 'vertical': 'mart', 'flow_id': str(uuid.uuid4()),
                   'account_hash': 'd' * 64, 'scope_hash': 'e' * 64}
        with unittest.mock.patch.object(journal_mod, 'binding',
                                        lambda fid: dict(binding)), \
             unittest.mock.patch.object(receipts_mod, 'load',
                                        lambda **kw: Store()), \
             unittest.mock.patch.object(journal_mod, 'inspect',
                                        lambda fid: {'order_id': None, 'state': 'ACTIVE',
                                                     'app': 'talabat'}), \
             unittest.mock.patch.object(commerce_cli, 'CommerceAuth', Auth), \
             unittest.mock.patch.object(commerce_cli, 'account_hash',
                                        lambda saved: 'd' * 64), \
             unittest.mock.patch.object(commerce_cli, 'talabat',
                                        SimpleNamespace(AsyncPaymentPoller=Poller)):
            from commerce_cli import recover_talabat
            return recover_talabat(str(uuid.uuid4())), calls

    def test_conclusive_cursor_settles_without_polling(self):
        result, calls = self._recover('PAYMENT_BLOCKED')
        self.assertEqual(result['state'], 'PAYMENT_BLOCKED')
        self.assertEqual(result['reason'], 'literal')
        self.assertEqual(calls['polls'], 0)
        self.assertEqual(calls['fresh'], 0)

    def test_unknown_cursor_gets_a_fresh_read_only_poll(self):
        result, calls = self._recover('PAYMENT_UNKNOWN')
        self.assertEqual(result['state'], 'PAYMENT_REPORTED_SUCCESS')
        self.assertEqual(result['reason'], 'polled')
        self.assertEqual(calls['polls'], 1)
        self.assertEqual(calls['fresh'], 1)


class FencedPaymentReconciliationTest(unittest.TestCase):
    """reconcile_fenced_payment: only a later same-operation same-order success
    supersedes an UNKNOWN fence; the flow reactivates for explicit completion."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)/'commerce'
        self.patcher = patch.object(j, 'ROOT', self.root)
        self.patcher.start()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.patcher.stop)
        self.account = 'a'*64
        self.flow = str(uuid.uuid4())

    def open(self):
        j.open_flow(flow_id=self.flow, app='talabat', vertical='mart',
                    account_hash=self.account, scope_hash='s'.encode().hex()*32)
        j.consume(self.flow, 'quote_initial', kind='quote', request_hash='b'*64, cart_hash='c'*64)
        j.observe(self.flow, 'quote_initial', outcome='RESPONSE_RECEIVED', evidence_hash='e'*64)
        j.consume(self.flow, 'place', kind='place', request_hash='b'*64,
                  cart_hash='c'*64, review_hash='d'*64, payable_minor=2179)
        j.observe(self.flow, 'place', outcome='ORDER_ID_RECEIVED',
                  evidence_hash='0'*64, order_id='3949170955')
        j.consume(self.flow, 'payment', kind='payment', request_hash='b'*64,
                  cart_hash='c'*64, review_hash='d'*64, payable_minor=2179,
                  payment_order_id='3949170955')
        j.observe(self.flow, 'payment', outcome='RESPONSE_RECEIVED',
                  evidence_hash='2'*64, order_id='3949170955')
        return self.flow

    def fenced_unknown_then_success(self):
        self.open()
        j.observe(self.flow, 'payment', outcome='UNKNOWN',
                  evidence_hash='3'*64, order_id='3949170955')
        j.observe(self.flow, 'payment', outcome='PAYMENT_REPORTED_SUCCESS',
                  evidence_hash='1'*64, order_id='3949170955')

    def test_reconcile_reactivates_flow_and_records_evidence(self):
        self.fenced_unknown_then_success()
        self.assertEqual(j.inspect(self.flow)['state'], 'FENCED')
        result = j.reconcile_fenced_payment(self.flow, evidence_hash='4'*64)
        self.assertEqual(result['outcome'], 'FENCED_PAYMENT_RECONCILED')
        state = j.inspect(self.flow)
        self.assertEqual(state['state'], 'ACTIVE')
        with sqlite3.connect(str(self.root/'journal.sqlite')) as conn:
            rows = list(conn.execute("SELECT outcome FROM observations WHERE flow_id=? "
                                      "AND outcome='FENCED_PAYMENT_RECONCILED'", (self.flow,)))
        self.assertEqual(len(rows), 1)

    def test_reconcile_refuses_unfenced_flow(self):
        self.open()
        with self.assertRaisesRegex(j.JournalError, 'JOURNAL_RECONCILIATION_NOT_FENCED_ORDER'):
            j.reconcile_fenced_payment(self.flow, evidence_hash='4'*64)

    def test_reconcile_refuses_unknown_without_later_success(self):
        self.open()
        j.observe(self.flow, 'payment', outcome='UNKNOWN',
                  evidence_hash='3'*64, order_id='3949170955')
        with self.assertRaisesRegex(j.JournalError, 'JOURNAL_RECONCILIATION_EVIDENCE_CHAIN_INVALID'):
            j.reconcile_fenced_payment(self.flow, evidence_hash='4'*64)

    def test_reconcile_refuses_success_without_prior_unknown(self):
        # No UNKNOWN observation means the flow was never fenced; reconciliation
        # is refused on state before any evidence-chain inspection.
        self.open()
        j.observe(self.flow, 'payment', outcome='PAYMENT_REPORTED_SUCCESS',
                  evidence_hash='1'*64, order_id='3949170955')
        with self.assertRaisesRegex(j.JournalError, 'JOURNAL_RECONCILIATION_NOT_FENCED_ORDER'):
            j.reconcile_fenced_payment(self.flow, evidence_hash='4'*64)
