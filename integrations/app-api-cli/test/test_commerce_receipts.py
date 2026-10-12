from dataclasses import replace
import hashlib
import json
import multiprocessing as mp
import os
from pathlib import Path
import socket
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

import commerce_receipts as r
import talabat_http_checkout as h
from talabat_http_checkout import AsyncPaymentContext, PaymentResult, payment_status_params
from talabat_place_contract import PlaceObservation


def restarted_read(root, binding, connection):
    r.ROOT = Path(root)
    with patch.object(socket.socket, 'connect', side_effect=AssertionError('offline')):
        restored = r.load(**binding).snapshot().talabat_readback()
        connection.send((restored.context, restored.next_index, restored.result, restored.stopped))
    connection.close()


def concurrent_status(root, binding, context, connection):
    r.ROOT = Path(root)
    try:
        with patch.object(socket.socket, 'connect', side_effect=AssertionError('offline')):
            store = r.load(**binding)
            result = PaymentResult('PAYMENT_PENDING', 'ASYNC_STATUS_PENDING', context.order_id,
                                   context.transaction_id, context.payment_id, context.metadata)
            store(dict(operation='payment_status', http_status=200, context=context, result=result, next_index=1))
        connection.send('stored')
    except r.ReceiptError as exc:
        connection.send(str(exc))
    finally:
        connection.close()


def interrupted_publication(root, binding, context):
    r.ROOT = Path(root)
    unlink = os.unlink

    def crash_before_unlink(name, **kwargs):
        if name.startswith('.pending-'):
            os._exit(73)
        return unlink(name, **kwargs)

    with patch.object(socket.socket, 'connect', side_effect=AssertionError('offline')), \
         patch.object(r.os, 'unlink', side_effect=crash_before_unlink):
        if context is None:
            r.create(**binding)
        else:
            store = r.load(**binding)
            result = PaymentResult('PAYMENT_PENDING', 'ASYNC_STATUS_PENDING', context.order_id,
                                   context.transaction_id, context.payment_id, context.metadata)
            store(dict(operation='payment_status', http_status=200, context=context, result=result, next_index=1))


class CommerceReceiptsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # macOS /var is a system symlink; the store requires the exact real path.
        self.parent = Path(self.temp.name).resolve()
        self.root = self.parent / 'commerce'
        for target, name, value in ((r, 'ROOT', self.root),
                                    (socket.socket, 'connect', AssertionError('offline')),
                                    (socket.socket, 'connect_ex', AssertionError('offline')),
                                    (socket, 'create_connection', AssertionError('offline'))):
            p = patch.object(target, name, **({'side_effect': value} if isinstance(value, Exception) else {'new': value}))
            p.start()
            self.addCleanup(p.stop)
        self.binding = dict(flow_id=str(uuid.uuid4()), app='talabat', vertical='shops',
                            account_hash='a' * 64, scope_hash='b' * 64)
        self.cart = 'synthetic-cart-private'
        self.cart_hash = hashlib.sha256(self.cart.encode()).hexdigest()

    def create(self, **changes):
        return r.create(**{**self.binding, **changes})

    def place(self, store):
        return store(dict(flow_id=store.binding.flow_id, operation='place', http_status=200,
                          observation=PlaceObservation('PAYMENT_PENDING', 'PAYMENT_COMPLETION_UNPROVEN',
                                                       '123456', 'synthetic-transaction', '12.50')))

    def payment(self, store, **changes):
        context = AsyncPaymentContext('123456', 'synthetic-transaction', store.binding.flow_id,
                                      (1.0, 1.5, 2.0), store.binding.account_hash, '', '')
        result = PaymentResult('PAYMENT_PENDING', 'TALABAT_ASYNC_STATUS_REQUIRED', '123456',
                               'synthetic-transaction', '', '')
        record = dict(flow_id=store.binding.flow_id, operation='payment', http_status=200,
                      result=result, context=context, next_index=0)
        record.update(changes)
        store(record)
        return context

    def status(self, store, context, index=1, success=False, **changes):
        result = PaymentResult('PAYMENT_REPORTED_SUCCESS' if success else 'PAYMENT_PENDING',
                               'EXACT_TRANSACTION_ASYNC_STATUS_SUCCESS' if success else 'ASYNC_STATUS_PENDING',
                               context.order_id, context.transaction_id, context.payment_id, context.metadata)
        record = dict(operation='payment_status', http_status=200, result=result, context=context, next_index=index)
        record.update(changes)
        return store(record)

    def files(self):
        return {p.name: p.read_bytes() for p in (self.root / 'receipts').glob('*.json')}

    def test_real_process_restart_restores_exact_get_context_and_cursor(self):
        store = self.create()
        self.place(store)
        context = self.payment(store)
        self.status(store, context)
        ctx = mp.get_context('spawn')
        receive, send = ctx.Pipe(duplex=False)
        process = ctx.Process(target=restarted_read, args=(str(self.root), self.binding, send))
        process.start()
        send.close()
        process.join(10)
        if process.is_alive():
            process.terminate()
            process.join(5)
            self.fail('restart process did not finish')
        self.assertEqual(process.exitcode, 0)
        self.assertTrue(receive.poll())
        restored, index, result, stopped = receive.recv()
        receive.close()
        self.assertEqual(restored, context)
        self.assertEqual(index, 1)
        self.assertEqual(result.state, 'PAYMENT_PENDING')
        self.assertFalse(stopped)
        self.assertEqual(payment_status_params(restored), {
            'isRedirectionInitiated': 'false', 'encryptedTransactionId': 'synthetic-transaction',
            'scenario': 'deliveryOrder', 'subscription': 'false', 'metadata': '', 'paymentId': ''})

    def test_preparation_then_place_payment_status_are_immutable_versions(self):
        store = self.create()
        self.assertTrue(store(dict(flow_id=self.binding['flow_id'], operation='create_cart', state='SUCCEEDED',
                                   http_status=201, cart_id=self.cart, cart_binding=self.cart_hash)))
        self.assertTrue(store(dict(flow_id=self.binding['flow_id'], operation='quote_selected', state='SUCCEEDED',
                                   http_status=200, cart_binding=self.cart_hash, currency='AED',
                                   payable_minor=1250, review_sha256='c' * 64)))
        baseline = self.files()
        self.place(store)
        context = self.payment(store)
        self.status(store, context, success=True)
        self.assertEqual({name: self.files()[name] for name in baseline}, baseline)
        snapshot = r.load(**self.binding).snapshot()
        self.assertEqual(len(snapshot.receipts), 5)
        self.assertEqual(snapshot.receipts[1].payable_minor, 1250)
        self.assertTrue(snapshot.talabat_readback().stopped)
        for path in (self.root, self.root / 'receipts'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        for path in (self.root / 'receipts').iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.stat().st_nlink, 1)

    def test_unknown_preparation_is_retained_without_raw_response(self):
        store = self.create()
        store(dict(flow_id=self.binding['flow_id'], operation='quote_initial', state='SUBMISSION_UNKNOWN',
                   reason='RESPONSE_INVALID_OR_UNAVAILABLE_NO_RETRY', http_status=None))
        self.assertEqual(store.snapshot().receipts[0].state, 'SUBMISSION_UNKNOWN')
        with self.assertRaises(r.ReceiptError):
            store.snapshot().talabat_readback()

    def test_place_redirect_is_never_persisted_and_malformed_balance_does_not_lose_ids(self):
        store = self.create()
        store(dict(flow_id=self.binding['flow_id'], operation='place', http_status=200,
                   observation=PlaceObservation('CHALLENGE_REQUIRED', 'PAYMENT_REDIRECT_UNSUPPORTED',
                                                '123456', 'synthetic-transaction', 'private-non-amount',
                                                'https://secret.example/private-card-token')))
        value = store.snapshot().receipts[0]
        self.assertEqual(value.order_id, '123456')
        self.assertIsNone(value.balance_amount)
        raw = b''.join(self.files().values())
        for secret in (b'secret.example', b'private-card-token', b'private-non-amount', b'redirect_url'):
            self.assertNotIn(secret, raw)

    def test_unknown_payment_response_keeps_get_only_recovery(self):
        store = self.create()
        self.place(store)
        unknown = PaymentResult('PAYMENT_UNKNOWN', 'RESPONSE_INVALID_NO_RETRY',
                                '123456', 'synthetic-transaction', '', '')
        context = self.payment(store, result=unknown, http_status=None)
        restored = store.snapshot().talabat_readback()
        self.assertFalse(restored.stopped)
        self.assertEqual(restored.context, context)
        self.assertEqual(restored.next_index, 0)

    def test_sync_payment_has_no_async_restoration(self):
        store = self.create()
        self.place(store)
        result = PaymentResult('PAYMENT_REPORTED_SUCCESS', 'TALABAT_SYNC_NORMAL_RETURN',
                               '123456', 'synthetic-transaction')
        self.payment(store, result=result, context=None)
        with self.assertRaisesRegex(r.ReceiptError, 'CONTEXT_UNAVAILABLE'):
            store.snapshot().talabat_readback()

    def test_status_get_401_resumes_with_fresh_auth_same_context_and_next_cursor(self):
        binding = {**self.binding, 'account_hash': hashlib.sha256(b'77').hexdigest()}
        store = r.create(**binding)
        self.place(store)
        context = self.payment(store)
        saved = {'account_verified': True, 'country': 'AE', 'headers': {},
                 'auth': {'access_token': 'synthetic-old-auth', 'customerId': 77},
                 'expected_profile': {'id': 77, 'mobile_country_code': '971', 'mobile_number': '500000000'}}
        fresh = {**saved, 'auth': {**saved['auth'], 'access_token': 'synthetic-fresh-auth'}}
        responses = iter((h.WireResponse(401, None), h.WireResponse(200, {'status': 'success'})))

        def wire(auth, deadline, method, path, **kwargs):
            self.assertEqual((method, path), ('GET', '/pay/v2/payment/status'))
            self.assertEqual(kwargs['params'], payment_status_params(context))
            self.assertEqual(kwargs['headers'], {'x-acceptance-request-id': context.acceptance_id})
            return next(responses)

        with patch.object(h, '_wire', side_effect=wire) as request, \
             patch.object(h.orders, 'request', return_value=saved['expected_profile']) as profile, \
             patch.object(h.auth, 'expiry', return_value=time.time() + 3600), \
             patch.object(h.auth, 'refresh', side_effect=AssertionError('explicit fresh auth required')), \
             patch.object(h.time, 'sleep') as sleep:
            poller = h.AsyncPaymentPoller(saved, context, receipt=store)
            result = poller.poll()
            self.assertEqual((result.state, result.reason),
                             ('PAYMENT_UNKNOWN', 'ASYNC_READ_AUTH_RENEWAL_REQUIRED'))
            poller.poll()
            self.assertTrue(poller.stopped)
            self.assertEqual(request.call_count, 1)
            recovered = r.load(**binding)
            readback = recovered.snapshot().talabat_readback()
            self.assertFalse(readback.stopped)
            self.assertEqual(readback.context, context)
            self.assertEqual(readback.next_index, 1)
            self.assertEqual(recovered.snapshot().receipts[-1].http_status, 401)
            resumed = h.AsyncPaymentPoller(fresh, readback.context, receipt=recovered,
                                          next_index=readback.next_index)
            self.assertEqual(resumed.poll().state, 'PAYMENT_REPORTED_SUCCESS')
            resumed.poll()
            self.assertEqual(request.call_count, 2)
            self.assertEqual([call.args[0]['auth']['access_token'] for call in request.call_args_list],
                             ['synthetic-old-auth', 'synthetic-fresh-auth'])
            self.assertEqual([call.args for call in sleep.call_args_list], [(1.0,), (1.5,)])
            self.assertEqual([call.args[0] for call in profile.call_args_list], [h.orders.PROFILE] * 2)
        final = r.load(**binding).snapshot().talabat_readback()
        self.assertEqual(final.context, context)
        self.assertEqual(final.next_index, 2)
        self.assertTrue(final.stopped)
        self.assertEqual([item.operation for item in recovered.snapshot().receipts],
                         ['place', 'payment', 'payment_status', 'payment_status'])

    def test_other_status_failures_and_terminal_results_remain_stopped(self):
        cases = [('PAYMENT_UNKNOWN', 'STATUS_READ_FAILED_NO_RETRY', 403),
                 ('PAYMENT_UNKNOWN', 'ASYNC_STATUS_LITERAL_UNSUPPORTED', 200),
                 ('PAYMENT_UNKNOWN', 'ASYNC_READ_AUTH_RENEWAL_REQUIRED', 500),
                 ('CHALLENGE_REQUIRED', 'REDIRECT_NOT_FOLLOWED', 200),
                 ('PAYMENT_BLOCKED', 'FALLBACK_NOT_FOLLOWED', 200),
                 ('PAYMENT_ERROR_REPORTED', 'NO_ROLLBACK_OR_RETRY_ASSUMED', 422),
                 ('PAYMENT_REPORTED_SUCCESS', 'EXACT_TRANSACTION_ASYNC_STATUS_SUCCESS', 200)]
        for index, (state, reason, code) in enumerate(cases):
            with self.subTest(state=state, reason=reason), patch.object(r, 'ROOT', self.parent / str(index)):
                store = self.create()
                self.place(store)
                context = self.payment(store)
                result = PaymentResult(state, reason, context.order_id, context.transaction_id,
                                       context.payment_id, context.metadata)
                self.status(store, context, result=result, http_status=code)
                self.assertTrue(r.load(**self.binding).snapshot().talabat_readback().stopped)

    def test_cursor_requires_next_position_and_exact_context(self):
        store = self.create()
        self.place(store)
        context = self.payment(store)
        self.status(store, context)
        before = self.files()
        for index in (0, 1, 3, True, -1):
            with self.subTest(index=index), self.assertRaises(r.ReceiptError):
                self.status(store, context, index=index)
        for changed in (replace(context, intervals=(2.0, 1.5, 2.0)),
                        replace(context, payment_id=None), replace(context, metadata=None),
                        replace(context, acceptance_id=str(uuid.uuid4())),
                        replace(context, account_binding='e' * 64),
                        replace(context, transaction_id='other-transaction'),
                        replace(context, order_id='999999')):
            with self.subTest(context=type(changed).__name__), self.assertRaises(r.ReceiptError):
                self.status(store, changed, index=2)
        self.assertEqual(self.files(), before)
        self.status(store, context, index=2)
        self.assertEqual(store.snapshot().talabat_readback().next_index, 2)

    def test_concurrent_writers_cannot_overwrite_or_duplicate_cursor(self):
        store = self.create()
        self.place(store)
        context = self.payment(store)
        ctx = mp.get_context('spawn')
        children = []
        for _ in range(2):
            receive, send = ctx.Pipe(duplex=False)
            process = ctx.Process(target=concurrent_status, args=(str(self.root), self.binding, context, send))
            process.start()
            send.close()
            children.append((process, receive))
        results = []
        for process, receive in children:
            process.join(10)
            if process.is_alive():
                process.terminate()
                process.join(5)
                self.fail('writer did not finish')
            self.assertEqual(process.exitcode, 0)
            self.assertTrue(receive.poll())
            results.append(receive.recv())
            receive.close()
        self.assertCountEqual(results, ['stored', 'RECEIPT_CURSOR_NOT_NEXT'])
        self.assertEqual(store.snapshot().talabat_readback().next_index, 1)
        self.assertEqual(len(store.snapshot().receipts), 3)

    def test_payment_must_match_received_place_identifiers(self):
        store = self.create()
        with self.assertRaisesRegex(r.ReceiptError, 'NOT_BOUND_TO_PLACE'):
            self.payment(store)
        self.place(store)
        self.payment(store)
        with self.assertRaisesRegex(r.ReceiptError, 'ALREADY_STORED'):
            self.payment(store)

    def test_foreign_ids_across_flow_or_account_are_not_adopted(self):
        first = self.create()
        self.place(first)
        for account in ('a' * 64, 'c' * 64):
            other = self.create(flow_id=str(uuid.uuid4()), account_hash=account)
            with self.assertRaisesRegex(r.ReceiptError, 'ID_FOREIGN'):
                self.place(other)
            self.assertEqual(other.snapshot().receipts, ())

    def test_nonempty_payment_id_cannot_be_reused_by_another_order(self):
        first = self.create()
        self.place(first)
        result = PaymentResult('PAYMENT_REPORTED_SUCCESS', 'TALABAT_SYNC_NORMAL_RETURN',
                               '123456', 'synthetic-transaction', 'synthetic-payment')
        self.payment(first, result=result, context=None)
        other = self.create(flow_id=str(uuid.uuid4()))
        other(dict(flow_id=other.binding.flow_id, operation='place', http_status=200,
                   observation=PlaceObservation('PAYMENT_PENDING', 'PAYMENT_COMPLETION_UNPROVEN',
                                                '654321', 'other-transaction', '12.50')))
        result = replace(result, order_id='654321', transaction_id='other-transaction')
        with self.assertRaisesRegex(r.ReceiptError, 'ID_FOREIGN'):
            self.payment(other, result=result, context=None)

    def test_cart_binding_mismatch_and_rebinding_are_rejected(self):
        store = self.create()
        record = dict(flow_id=self.binding['flow_id'], operation='create_cart', state='SUCCEEDED',
                      http_status=200, cart_id=self.cart, cart_binding='d' * 64)
        with self.assertRaisesRegex(r.ReceiptError, 'CART_MISMATCH'):
            store(record)
        record['cart_binding'] = self.cart_hash
        store(record)
        with self.assertRaisesRegex(r.ReceiptError, 'ID_REBOUND'):
            store(dict(flow_id=self.binding['flow_id'], operation='quote_initial', state='SUCCEEDED',
                       http_status=200, cart_binding='e' * 64, currency='AED', payable_minor=1250,
                       review_sha256='f' * 64))

    def test_creation_and_every_load_require_exact_immutable_binding(self):
        store = self.create()
        before = self.files()
        for change in ({'account_hash': 'c' * 64}, {'scope_hash': 'd' * 64}, {'vertical': 'mart'},
                       {'app': 'noon', 'vertical': 'main'}, {'flow_id': str(uuid.uuid4())}):
            with self.subTest(change=change), self.assertRaises(r.ReceiptError):
                r.load(**{**self.binding, **change})
        with self.assertRaisesRegex(r.ReceiptError, 'FLOW_EXISTS'):
            self.create()
        with self.assertRaisesRegex(r.ReceiptError, 'FLOW_MISMATCH'):
            store(dict(flow_id=str(uuid.uuid4()), operation='place', observation=PlaceObservation(
                'SUBMISSION_UNKNOWN', 'RESPONSE_MISSING_OR_MALFORMED'), http_status=None))
        self.assertEqual(self.files(), before)

    def test_invalid_creation_does_not_touch_storage(self):
        for change in ({'flow_id': '../escape'}, {'flow_id': str(uuid.uuid1())}, {'account_hash': 'raw-account'},
                       {'scope_hash': 'raw-scope'}, {'app': 'other'}, {'vertical': 'other'}):
            with self.subTest(change=change), self.assertRaises(r.ReceiptError):
                self.create(**change)
        self.assertFalse(self.root.exists())
        with self.assertRaises(r.ReceiptError):
            r.load(**self.binding)
        self.assertFalse(self.root.exists())

    def test_raw_callback_extras_and_objects_are_rejected_without_storage(self):
        store = self.create()
        self.place(store)
        before = self.files()
        for key in ('auth', 'card', 'instrument', 'redirect_url', 'raw', 'headers'):
            with self.subTest(key=key), self.assertRaises(r.ReceiptError):
                self.payment(store, **{key: {'secret': 'never-save-this'}})
        for result in ({'state': 'PAYMENT_PENDING', 'secret': 'never-save-this'},
                       PaymentResult('PAYMENT_PENDING', 'never-save-this', '123456', 'synthetic-transaction')):
            with self.assertRaises(r.ReceiptError):
                self.payment(store, result=result)
        with self.assertRaises(r.ReceiptError):
            store.append({'raw': 'never-save-this'})
        self.assertEqual(self.files(), before)
        self.assertNotIn('synthetic-transaction', repr(store.snapshot()))

    def test_urls_cannot_be_smuggled_into_opaque_context_fields(self):
        store = self.create()
        self.place(store)
        for key in ('metadata', 'payment_id', 'transaction_id'):
            result = PaymentResult('PAYMENT_PENDING', 'TALABAT_ASYNC_STATUS_REQUIRED',
                                   '123456', 'synthetic-transaction')
            result = replace(result, **{key: 'https://private.example/token'})
            with self.subTest(key=key), self.assertRaises(r.ReceiptError):
                self.payment(store, result=result, context=None)

    def test_noon_minimal_typed_path_without_auth_or_payment_secrets(self):
        store = self.create(app='noon', vertical='minutes')
        store.append(r.Receipt('place', 'ORDER_ID_RECEIVED', http_status=200, order_id='SYNTHETIC-NOON-1',
                               cart_binding='c' * 64, review_sha256='d' * 64, currency='AED', payable_minor=1250))
        store.append(r.Receipt('tracking', 'EXACT_ORDER_CONFIRMED', http_status=200, order_id='SYNTHETIC-NOON-1'))
        self.assertEqual(store.snapshot().receipts[-1].order_id, 'SYNTHETIC-NOON-1')
        with self.assertRaises(r.ReceiptError):
            store.append(r.Receipt('payment', 'PAYMENT_PENDING', metadata='private-client-secret'))
        with self.assertRaisesRegex(r.ReceiptError, 'ID_REBOUND'):
            store.append(r.Receipt('tracking', 'EXACT_ORDER_CONFIRMED', order_id='SYNTHETIC-NOON-2'))
        for changes in ({'payable_minor': 1350}, {'review_sha256': 'e' * 64}):
            value = r.Receipt('payment', 'PAYMENT_PENDING', order_id='SYNTHETIC-NOON-1',
                              currency='AED', payable_minor=1250, review_sha256='d' * 64)
            with self.assertRaisesRegex(r.ReceiptError, 'PLACE_BINDING_CHANGED'):
                store.append(replace(value, **changes))

    def test_nonfinite_intervals_bool_cursor_and_raw_operation_are_rejected(self):
        store = self.create()
        self.place(store)
        context = AsyncPaymentContext('123456', 'synthetic-transaction', store.binding.flow_id,
                                      (1.0,), store.binding.account_hash, '', '')
        for interval in (float('nan'), float('inf'), True, 0, -1, 61):
            with self.subTest(interval=interval), self.assertRaises(r.ReceiptError):
                self.payment(store, context=replace(context, intervals=(interval,)))
        with self.assertRaises(r.ReceiptError):
            self.payment(store, context=context, next_index=True)
        with self.assertRaises(r.ReceiptError):
            store({'operation': {'raw': 'private'}, 'flow_id': self.binding['flow_id']})

    def test_symlink_at_parent_root_receipts_or_file_is_rejected(self):
        real = self.parent / 'real'
        real.mkdir(mode=0o700)
        linked = self.parent / 'linked'
        linked.symlink_to(real, target_is_directory=True)
        with patch.object(r, 'ROOT', linked / 'commerce'), self.assertRaises(r.ReceiptError):
            self.create()
        self.root.symlink_to(real, target_is_directory=True)
        with self.assertRaises(r.ReceiptError):
            self.create()
        self.root.unlink()
        self.root.mkdir(mode=0o700)
        (self.root / 'receipts').symlink_to(real, target_is_directory=True)
        with self.assertRaises(r.ReceiptError):
            self.create()
        (self.root / 'receipts').unlink()
        store = self.create()
        manifest = next((self.root / 'receipts').glob('*.json'))
        backup = self.parent / 'manifest'
        manifest.rename(backup)
        manifest.symlink_to(backup)
        with self.assertRaises(r.ReceiptError):
            store.snapshot()
        self.assertEqual(list(real.iterdir()), [])

    def test_public_modes_and_hardlinks_fail_closed(self):
        store = self.create()
        for path, mode in ((self.root, 0o755), (self.root / 'receipts', 0o755),
                           (self.root / 'receipts' / '.lock', 0o644)):
            original = path.stat().st_mode & 0o777
            path.chmod(mode)
            with self.assertRaises(r.ReceiptError):
                store.snapshot()
            path.chmod(original)
        manifest = next((self.root / 'receipts').glob('*.json'))
        manifest.chmod(0o644)
        with self.assertRaises(r.ReceiptError):
            store.snapshot()
        manifest.chmod(0o600)
        os.link(manifest, self.parent / 'hardlink')
        with self.assertRaises(r.ReceiptError):
            store.snapshot()

    def test_failed_file_sync_never_publishes_receipt(self):
        store = self.create()
        before = self.files()
        sync = r._sync

        def failed(fd, directory=False):
            if not directory:
                raise OSError('private-error-text')
            return sync(fd, directory)

        with patch.object(r, '_sync', side_effect=failed):
            with self.assertRaisesRegex(r.ReceiptError, '^RECEIPT_STORE_UNAVAILABLE$'):
                self.place(store)
        self.assertEqual(self.files(), before)
        self.assertFalse(list((self.root / 'receipts').glob('.pending-*')))

    def test_atomic_publication_never_overwrites_even_with_unexpected_destination(self):
        store = self.create()
        link = os.link
        destination = self.root / 'receipts' / f'{store.binding.flow_id}.00000001.json'

        def race(source, target, **kw):
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.write(fd, b'occupied')
            os.close(fd)
            return link(source, target, **kw)

        with patch.object(r.os, 'link', side_effect=race), self.assertRaises(r.ReceiptError):
            self.place(store)
        self.assertEqual(destination.read_bytes(), b'occupied')

    def test_process_interruption_after_link_recovers_published_binding_and_status(self):
        for phase in ('binding', 'status'):
            with self.subTest(phase=phase), patch.object(r, 'ROOT', self.parent / phase):
                context = None
                if phase == 'status':
                    store = self.create()
                    self.place(store)
                    context = self.payment(store)
                ctx = mp.get_context('spawn')
                process = ctx.Process(target=interrupted_publication, args=(str(r.ROOT), self.binding, context))
                process.start()
                process.join(10)
                if process.is_alive():
                    process.terminate()
                    process.join(5)
                    self.fail('interrupted writer did not exit')
                self.assertEqual(process.exitcode, 73)
                directory = r.ROOT / 'receipts'
                pending, = directory.glob('.pending-*')
                version = 0 if context is None else 3
                final = directory / f'{self.binding["flow_id"]}.{version:08d}.json'
                self.assertEqual(pending.stat().st_ino, final.stat().st_ino)
                self.assertEqual(final.stat().st_nlink, 2)
                before = {p.name: p.read_bytes() for p in directory.glob('*.json')}
                restored = r.load(**self.binding)
                snapshot = restored.snapshot()
                self.assertFalse(pending.exists())
                self.assertEqual(final.stat().st_nlink, 1)
                self.assertEqual({p.name: p.read_bytes() for p in directory.glob('*.json')}, before)
                if context is None:
                    self.assertEqual(snapshot.receipts, ())
                    self.place(restored)
                else:
                    readback = snapshot.talabat_readback()
                    self.assertEqual((readback.context, readback.next_index, readback.stopped), (context, 1, False))
                    self.status(restored, context, index=2, success=True)
                    self.assertTrue(restored.snapshot().talabat_readback().stopped)

    def test_recovery_rejects_arbitrary_hardlinks_and_malformed_publication_pairs(self):
        cases = ('outside-final', 'outside-pending', 'two-finals', 'two-pending', 'third-link',
                 'invalid-pending-name', 'public-mode', 'symlink', 'corrupt', 'wrong-binding', 'version-gap')
        for case in cases:
            with self.subTest(case=case), patch.object(r, 'ROOT', self.parent / case):
                store = self.create()
                directory = r.ROOT / 'receipts'
                final = directory / f'{store.binding.flow_id}.00000000.json'
                pending = directory / ('.pending-' + str(uuid.uuid4()))
                other = self.parent / ('outside-' + case)
                if case == 'outside-final':
                    os.link(final, other)
                elif case == 'outside-pending':
                    pending.write_bytes(final.read_bytes())
                    pending.chmod(0o600)
                    os.link(pending, other)
                elif case == 'two-finals':
                    os.link(final, directory / f'{store.binding.flow_id}.00000001.json')
                elif case == 'two-pending':
                    pending.write_bytes(final.read_bytes())
                    pending.chmod(0o600)
                    os.link(pending, directory / ('.pending-' + str(uuid.uuid4())))
                elif case == 'symlink':
                    pending.symlink_to(final)
                else:
                    if case == 'invalid-pending-name':
                        pending = directory / ('.pending-' + str(uuid.uuid1()))
                    os.link(final, pending)
                    if case == 'third-link':
                        os.link(final, other)
                    elif case == 'public-mode':
                        final.chmod(0o644)
                    elif case == 'corrupt':
                        final.write_bytes(b'{"schema":1,"schema":1}')
                    elif case == 'wrong-binding':
                        data = json.loads(final.read_text())
                        data['binding']['flow_id'] = str(uuid.uuid4())
                        final.write_text(json.dumps(data))
                    elif case == 'version-gap':
                        data = json.loads(final.read_text())
                        data['version'] = 2
                        final.write_text(json.dumps(data))
                        final = final.rename(directory / f'{store.binding.flow_id}.00000002.json')
                before = {p.name: (p.lstat().st_ino, p.lstat().st_nlink, p.read_bytes()) for p in directory.iterdir()}
                with self.assertRaises(r.ReceiptError):
                    store.snapshot()
                self.assertEqual({p.name: (p.lstat().st_ino, p.lstat().st_nlink, p.read_bytes())
                                  for p in directory.iterdir()}, before)

    def test_recovery_validates_all_history_before_removing_any_alias(self):
        store = self.create()
        other = self.create(flow_id=str(uuid.uuid4()))
        directory = self.root / 'receipts'
        final = directory / f'{store.binding.flow_id}.00000000.json'
        pending = directory / ('.pending-' + str(uuid.uuid4()))
        os.link(final, pending)
        corrupt = directory / f'{other.binding.flow_id}.00000000.json'
        valid = corrupt.read_bytes()
        corrupt.write_bytes(b'not-json')
        with self.assertRaises(r.ReceiptError):
            store.snapshot()
        self.assertEqual(final.stat().st_nlink, 2)
        self.assertTrue(pending.exists())
        corrupt.write_bytes(valid)
        self.assertEqual(store.snapshot().receipts, ())
        self.assertFalse(pending.exists())
        self.assertEqual(final.stat().st_nlink, 1)

    def test_recovery_syncs_directory_before_and_after_unlink_and_can_retry_failures(self):
        for failure in ('before-sync', 'unlink', 'after-sync', None):
            with self.subTest(failure=failure), patch.object(r, 'ROOT', self.parent / str(failure)):
                store = self.create()
                directory = r.ROOT / 'receipts'
                final = directory / f'{store.binding.flow_id}.00000000.json'
                pending = directory / ('.pending-' + str(uuid.uuid4()))
                os.link(final, pending)
                before = final.read_bytes()
                sync, unlink = r._sync, os.unlink
                calls = []

                def synced(fd, directory=False):
                    self.assertTrue(directory)
                    calls.append('sync')
                    if failure == ('before-sync' if len(calls) == 1 else 'after-sync'):
                        raise OSError('synthetic crash')
                    return sync(fd, directory)

                def unlinked(name, **kwargs):
                    calls.append('unlink')
                    self.assertEqual(name, pending.name)
                    if failure == 'unlink':
                        raise OSError('synthetic crash')
                    return unlink(name, **kwargs)

                with patch.object(r, '_sync', side_effect=synced), patch.object(r.os, 'unlink', side_effect=unlinked):
                    if failure is None:
                        store.snapshot()
                    else:
                        with self.assertRaisesRegex(r.ReceiptError, 'STORE_UNAVAILABLE'):
                            store.snapshot()
                expected = ['sync', 'unlink', 'sync']
                self.assertEqual(calls, expected[:1 if failure == 'before-sync' else 2 if failure == 'unlink' else 3])
                self.assertEqual(pending.exists(), failure in ('before-sync', 'unlink'))
                self.assertEqual(r.load(**self.binding).snapshot().receipts, ())
                self.assertFalse(pending.exists())
                self.assertEqual(final.stat().st_nlink, 1)
                self.assertEqual(final.read_bytes(), before)

    def test_corrupt_duplicate_fields_and_version_gaps_are_rejected(self):
        store = self.create()
        manifest = next((self.root / 'receipts').glob('*.json'))
        raw = manifest.read_bytes()
        manifest.write_bytes(raw.replace(b'"schema":1', b'"schema":1,"schema":1'))
        with self.assertRaises(r.ReceiptError):
            store.snapshot()
        manifest.write_bytes(raw)
        self.place(store)
        version = self.root / 'receipts' / f'{store.binding.flow_id}.00000001.json'
        data = json.loads(version.read_text())
        data['version'] = 2
        version.write_text(json.dumps(data))
        version.rename(version.with_name(version.name.replace('.00000001.', '.00000002.')))
        with self.assertRaises(r.ReceiptError):
            store.snapshot()

    def test_unpublished_private_file_is_not_adopted(self):
        store = self.create()
        orphan = self.root / 'receipts' / ('.pending-' + str(uuid.uuid4()))
        fd = os.open(orphan, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, b'partial uncommitted synthetic content')
        os.close(fd)
        self.assertEqual(store.snapshot().receipts, ())
        self.place(store)
        self.assertTrue(orphan.exists())
        self.assertEqual(len(store.snapshot().receipts), 1)



class HoldersScanTest(unittest.TestCase):
    def test_holders_finds_cart_identity_across_flows(self):
        import commerce_receipts as R
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            real = os.path.realpath(tmp)
            with patch.object(R, 'ROOT', real):
                b1 = R.create(flow_id=str(uuid.uuid4()), app='talabat', vertical='shops',
                              account_hash='a'*64, scope_hash='b'*64)
                b1({'flow_id': b1.binding.flow_id, 'operation': 'create_cart',
                    'state': 'SUCCEEDED', 'http_status': 200,
                    'cart_id': 'stable-cart-1', 'cart_binding': hashlib.sha256(b'stable-cart-1').hexdigest()})
                b2 = R.create(flow_id=str(uuid.uuid4()), app='noon', vertical='minutes',
                              account_hash='a'*64, scope_hash='b'*64)
                self.assertEqual(b1.holders('stable-cart-1'), {b1.binding.flow_id})
                self.assertEqual(b1.holders(hashlib.sha256(b'stable-cart-1').hexdigest()), {b1.binding.flow_id})
                self.assertEqual(b1.holders('stable-cart-1', exclude_flow=b1.binding.flow_id), set())


if __name__ == '__main__':
    unittest.main()

    def test_adopted_stable_cart_identity_is_storable_across_flows(self):
        """Talabat grocery cart ids are account-stable; a terminal prior flow's
        cart identity may be re-stored by its successor via adopted_ids."""
        first = self.create()
        record = dict(flow_id=first.binding.flow_id, operation='create_cart', state='SUCCEEDED',
                      http_status=200, cart_id=self.cart, cart_binding=self.cart_hash)
        first(record)
        second = self.create(flow_id=str(uuid.uuid4()))
        with self.assertRaisesRegex(r.ReceiptError, 'ID_FOREIGN'):
            second(dict(record, flow_id=second.binding.flow_id))
        second(dict(record, flow_id=second.binding.flow_id),
               adopted_ids=frozenset({self.cart, self.cart_hash}))
        snap = second.snapshot().receipts
        self.assertEqual(len(snap), 1)
        self.assertEqual(snap[0].cart_id, self.cart)
        # Adoption never licenses rebinding the identity inside the new flow.
        with self.assertRaisesRegex(r.ReceiptError, 'ID_REBOUND'):
            second(dict(flow_id=second.binding.flow_id, operation='create_cart', state='SUCCEEDED',
                        http_status=200, cart_id=self.cart, cart_binding='e' * 64))
