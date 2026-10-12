"""Trusted adapter bridge to the durable commerce journal.

Callbacks are scoped to one locally constructed intent. Receipts are persisted
before journal observations; a sink failure leaves MAY_HAVE_SENT in place.
"""
import hashlib

import commerce_journal as journal


class FlowGate:
    def __init__(self, *, flow_id, app, vertical, account_hash, scope_hash,
                 receipt_sink, request_check):
        if not callable(receipt_sink) or not callable(request_check):
            journal.fail('TRUSTED_INTEGRATION_REQUIRED')
        self.flow_id, self.app, self.vertical = flow_id, app, vertical
        self.account_hash, self.scope_hash = account_hash, scope_hash
        self.receipt_sink, self.request_check = receipt_sink, request_check
        self.opened = False

    def before_talabat(self, record):
        if (type(record) is not dict or record.get('version') != 1
                or record.get('app') != self.app or self.app != 'talabat'
                or record.get('flow_id') != self.flow_id
                or record.get('account_binding') != self.account_hash
                or record.get('state') != 'MAY_HAVE_SENT'):
            journal.fail('ADAPTER_SCOPE_MISMATCH')
        operation = record.get('operation')
        kinds = {'create_cart': 'cart', 'quote_initial': 'quote',
                 'quote_initial_quiet': 'quote', 'quote_selected': 'quote',
                 'quote_selected_quiet': 'quote', 'quote_final_quiet':'quote', 'place': 'place', 'payment': 'payment'}
        if operation not in kinds or self.request_check(record) is not True:
            journal.fail('ADAPTER_REQUEST_NOT_BOUND')
        financial = operation in ('place', 'payment')
        if financial and record.get('currency') != 'AED':
            journal.fail('ADAPTER_CURRENCY_MISMATCH')
        if not self.opened:
            journal.open_flow(flow_id=self.flow_id, app=self.app, vertical=self.vertical,
                              account_hash=self.account_hash, scope_hash=self.scope_hash)
            self.opened = True
        return journal.consume(self.flow_id, operation, kind=kinds[operation],
            request_hash=record['request_sha256'], cart_hash=record.get('cart_binding'),
            review_hash=record.get('review_sha256') if financial else None,
            payable_minor=record.get('payable_minor') if financial else None,
            payment_order_id=record.get('payment_order_id'))

    def _adopt_stable_cart_retry(self, record, exc):
        """One evidence-gated adoption when the account-stable cart id collides.

        Talabat grocery cart ids are account-stable, so a successor flow's
        create_cart receipt can hit RECEIPT_ID_FOREIGN against a terminal
        prior flow. If that prior is RELEASED, never held an order and never
        sent a payment, the journal adopts the cart and the receipt is retried
        once with the adopted identity. Anything else re-raises untouched.
        """
        if (record.get('operation') != 'create_cart' or not record.get('cart_id')
                or getattr(exc, 'code', None) != 'RECEIPT_ID_FOREIGN'
                or self.app != 'talabat'):
            raise exc
        cart_hash = hashlib.sha256(record['cart_id'].encode()).hexdigest()
        owner = journal.cart_owner(self.app, self.account_hash, cart_hash)
        if owner is None:
            # Receipts-only prior: no journal carts row exists (the prior flow
            # never reached a quote consume). Find receipts-side holders and
            # adopt from the first terminal, never-financial one.
            holders = getattr(self.receipt_sink, 'holders', None)
            if not callable(holders):
                raise exc
            candidates = sorted(set().union(
                holders(record['cart_id'], exclude_flow=self.flow_id),
                holders(cart_hash, exclude_flow=self.flow_id)))
            owner = None
            for candidate in candidates:
                info = journal.inspect(candidate)
                if (info.get('state') == 'RELEASED' and info.get('order_id') is None
                        and not any(x['kind'] in ('payment', 'preauthorize', 'prepay')
                                    for x in info.get('operations', []))):
                    owner = candidate
                    break
            if owner is None:
                raise exc
        elif owner == self.flow_id:
            raise exc
        prior = journal.inspect(owner)
        if (prior.get('state') != 'RELEASED' or prior.get('order_id') is not None
                or any(x['kind'] in ('payment', 'preauthorize', 'prepay')
                       for x in prior.get('operations', []))):
            raise exc
        journal.adopt_stable_cart(self.flow_id, owner, cart_hash,
            evidence_hash=journal.digest({'cart_id': record['cart_id'],
                'prior_flow_id': owner, 'auto': 'receipt_retry'}))
        return self.receipt_sink(record, adopted_ids=frozenset({record['cart_id'], cart_hash}))

    def talabat_receipt(self, record):
        """Typed adapter receipt; no generic raw server response can enter here."""
        from talabat_http_checkout import PaymentResult
        from talabat_place_contract import PlaceObservation
        if (type(record) is not dict or record.get('flow_id', self.flow_id) != self.flow_id
                or not self.opened):
            journal.fail('ADAPTER_RECEIPT_SCOPE_MISMATCH')
        operation = record.get('operation')
        private = {**record, 'flow_id': self.flow_id}
        try:
            stored = self.receipt_sink(private)
        except Exception as exc:
            stored = self._adopt_stable_cart_retry(private, exc)
        if stored is not True:
            journal.fail('ADAPTER_RECEIPT_NOT_DURABLE')
        order_id = None
        if operation == 'place':
            result = record.get('observation')
            if type(result) is not PlaceObservation:
                journal.fail('ADAPTER_RECEIPT_TYPE_INVALID')
            state, reason, order_id = result.state, result.reason, result.order_id
        elif operation in ('payment', 'payment_status'):
            result = record.get('result')
            if type(result) is not PaymentResult:
                journal.fail('ADAPTER_RECEIPT_TYPE_INVALID')
            state, reason, order_id = result.state, result.reason, result.order_id
        elif operation in ('create_cart', 'quote_initial', 'quote_selected',
                           'quote_initial_quiet', 'quote_selected_quiet','quote_final_quiet'):
            state, reason = record.get('state'), record.get('reason')
        else:
            journal.fail('ADAPTER_RECEIPT_OPERATION_INVALID')
        observation = {'operation': operation, 'state': state, 'reason': reason,
                       'http_status': record.get('http_status'), 'order_id': order_id,
                       'next_index': record.get('next_index'),
                       'cart_binding': record.get('cart_binding'),
                        'review_sha256': record.get('review_sha256')}
        if state == 'PREPARATION_FAILED':
            observation['diagnostic'] = record.get('diagnostic')
            journal.release_preparation(self.flow_id, operation,
                                        evidence_hash=journal.digest(observation))
            return True
        op = 'payment' if operation == 'payment_status' else operation
        if state == 'PAYMENT_REPORTED_SUCCESS':
            outcome = 'PAYMENT_REPORTED_SUCCESS'
        elif state == 'CHALLENGE_REQUIRED':
            outcome = 'CHALLENGE_REQUIRED'
        elif state in ('PAYMENT_PENDING', 'SUCCEEDED'):
            outcome = 'ORDER_ID_RECEIVED' if operation == 'place' else 'RESPONSE_RECEIVED'
        else:
            outcome = 'UNKNOWN'
        journal.observe(self.flow_id, op, outcome=outcome,
                        evidence_hash=journal.digest(observation), order_id=order_id)
        return True

    def exact_order(self, tracking):
        current = journal.inspect(self.flow_id)
        order = current['order_id']
        if (type(tracking) is not dict or tracking.get('order') != order
                or tracking.get('identity_verified') is not True
                or tracking.get('account_verified') is not True
                or tracking.get('source') != 'native_order_api'
                or not order or tracking.get('status') not in
                {'placed', 'preparing', 'picked up', 'out for delivery', 'nearby', 'delivered'}):
            journal.fail('EXACT_TRACKING_NOT_CONFIRMED')
        operation = 'payment' if any(x['kind'] == 'payment' for x in current['operations']) else 'place'
        journal.observe(self.flow_id, operation, outcome='EXACT_ORDER_CONFIRMED',
                        evidence_hash=journal.digest(tracking), order_id=order)

    def tracker_registered(self, order_id, evidence):
        current = journal.inspect(self.flow_id)
        if order_id != current['order_id'] or not order_id:
            journal.fail('TRACKER_ORDER_MISMATCH')
        operation = 'payment' if any(x['kind'] == 'payment' for x in current['operations']) else 'place'
        journal.observe(self.flow_id, operation, outcome='TRACKER_REGISTERED',
                        evidence_hash=journal.digest(evidence), order_id=order_id)


def account_hash(saved):
    return hashlib.sha256(str(saved['expected_profile']['id']).encode()).hexdigest()
