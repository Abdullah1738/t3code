"""Journalled NowNow paid-order lane, replaying the captured 2026-10-10 contract.

Live proof: paid order NNGAANNWEFJMZW8A (Spinneys, 1x Grenade white chocolate
shake, AED 31.45, no CVV, no 3DS). Payment rides the saved-card token bound in
the checkout session by edit-payment; place-order is the single financial send.

Lifecycle (every mutation journalled at-most-once):
  guard homepage active orders -> guard existing store cart -> saved-card
  selection (customer paymentcards + subscription/list corroboration) ->
  session/create -> edit-product (qty) -> validate (pre-place fee/address
  guard) -> edit-payment (saved card, cc_noonpay) -> set-delivery-preference
  (BOTH quiet flags true in ONE call) -> place-order {sessionCode,total} ->
  tracking poll until placed/preparing -> watcher registration.
"""
import datetime as dt
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

import commerce_journal as journal
import commerce_receipts as receipts
import noon_nownow_checkout as native
import order_watch_receipt
from noon_auth_lifecycle import NoonAuthLifecycle
from noon_checkout import AccountHome

WATCH_BIN = str(Path.home() / '.local/bin/order-watch')
WATCH_ORDERS = Path.home() / '.local/state/order-tracker/orders'
WATCH_WATCHERS = Path.home() / '.local/share/robob-watch/watchers'
FLOW_MAX_AGE_SECONDS = 24 * 3600
QUIET_FLAGS = ('dont_ring_the_bell', 'leave_it_at_my_door')
# Observed fee fields on the live Spinneys session (NNGAANNWEFJMZW8A):
# subtotal 20.5 + delivery 6.45 + service 4.5 = total 31.45.
FEE_KEYS = ('orderDeliveryFee', 'orderHandlingFee', 'orderServiceFee',
            'orderSmallOrderFee', 'orderCashFee', 'orderRiderTip', 'orderDiscount')
TERMINAL_TRACK_STATUSES = frozenset({'placed', 'preparing', 'picked up',
                                     'out for delivery', 'nearby', 'delivered'})


def _fail(code):
    journal.fail(code)


def saved_card(client, *, timeout=25):
    """Unique live default Mastercard 5542 from the account paymentcards read.

    The card token is the same numeric id edit-payment sends as paymentToken
    (captured live: numeric paymentcard id == edit-payment paymentToken).
    """
    snap = client.payment_cards(timeout=timeout)
    rows = snap.wire.get('data')
    matches = [row for row in rows
               if isinstance(row.get('ccMasked'), str) and row['ccMasked'].endswith('5542')
               and isinstance(row.get('ccType'), str) and row['ccType'].lower() == 'mastercard'
               and row.get('isDeleted') is False]
    if len(matches) != 1 or not str(matches[0].get('id', '')).isdigit():
        _fail('NOWNOW_SAVED_CARD_NOT_UNIQUE')
    card = native.SavedCard(str(matches[0]['id']), matches[0]['ccMasked'], matches[0]['ccType'])
    card.validate()
    return card


def corroborate_token(client, card, *, timeout=25):
    """subscription/list must contain the saved-card token before edit-payment."""
    refs = client.payment_subscription_list(timeout=timeout).projection['token_refs']
    from noon_checkout import fingerprint
    if fingerprint(card.token) not in refs:
        _fail('NOWNOW_SAVED_CARD_TOKEN_NOT_ACTIVE')


def project_fees(row):
    fees = {}
    for key in FEE_KEYS:
        value = row.get(key)
        fees[key] = native.seam.amount_minor(value) if value is not None else None
    return fees


def _fail_qty():
    _fail('NOWNOW_QUANTITY_INVALID')


def _normalize_items(product_code, quantity, items):
    """Validate one explicit item list; never a raw passthrough.

    Single-item backcompat: product_code+quantity. Multi-item: items rows
    {product_code, quantity, modifiers?, notes?}. Mixing both forms fails.
    """
    if items is not None:
        if product_code is not None or quantity is not None:
            _fail('NOWNOW_ITEMS_CONFLICT')
        if not isinstance(items, (tuple, list)) or not items:
            _fail('NOWNOW_ITEMS_REQUIRED')
        out = []
        seen = set()
        for row in items:
            if not isinstance(row, dict) \
                    or 'product_code' not in row or 'quantity' not in row \
                    or not set(row) <= {'product_code', 'quantity', 'modifiers', 'notes'}:
                _fail('NOWNOW_ITEM_ROW_INVALID')
            code = row['product_code']
            qty = row['quantity']
            if type(qty) is not int or not 1 <= qty:
                _fail_qty()
            code = native.ident(code)
            if code in seen:
                _fail('NOWNOW_DUPLICATE_PRODUCT')
            seen.add(code)
            modifiers = row.get('modifiers')
            if modifiers is not None and not isinstance(modifiers, dict):
                _fail('NOWNOW_MODIFIERS_INVALID')
            notes = row.get('notes')
            if notes is not None and not isinstance(notes, str):
                _fail('NOWNOW_NOTES_INVALID')
            out.append({'product_code': code, 'quantity': qty,
                        'modifiers': dict(modifiers) if modifiers else {}, 'notes': notes})
        return out
    if type(quantity) is not int or not 1 <= quantity:
        _fail_qty()
    return [{'product_code': native.ident(product_code), 'quantity': quantity,
             'modifiers': {}, 'notes': None}]


def _scope_hash(store_code, items, address_hash):
    """Single-item keeps the exact legacy digest; multi binds the full manifest."""
    if len(items) == 1:
        return journal.digest({'store': store_code, 'product': items[0]['product_code'],
                               'qty': items[0]['quantity'], 'home': address_hash,
                               'card': '5542', 'quiet': True})
    return journal.digest({'store': store_code,
                           'products': [[i['product_code'], i['quantity']] for i in items],
                           'home': address_hash, 'card': '5542', 'quiet': True})


def _wire_qty(value):
    """Positive exact quantity, including native cart strings such as '2.0'."""
    if type(value) is int and value > 0:
        return value
    if type(value) is float and value > 0 and value.is_integer():
        return int(value)
    # The native JSON decoder uses Decimal for every noninteger JSON number.
    if isinstance(value, Decimal) and value.is_finite() and value > 0 \
            and value == value.to_integral_value():
        return int(value)
    if type(value) is str and re.fullmatch(r'[0-9]+(?:\.0+)?', value):
        quantity = int(value.split('.', 1)[0])
        return quantity if quantity > 0 else None
    return None


def _wire_manifest(products):
    """Sorted [(product_code, qty)] from a wire products list; None on bad shape."""
    if not isinstance(products, list):
        return None
    out = []
    for line in products:
        if not isinstance(line, dict):
            return None
        code = line.get('productCode')
        qty = _wire_qty(line.get('qty'))
        if not isinstance(code, str) or qty is None:
            return None
        out.append((code, qty))
    return sorted(out)


class NowNowOrderFlow:
    """One owned NowNow store-cart order following the captured contract.

    Multi-product: one store, many distinct product lines. Session create takes
    the FIRST product; every other line (and any qty != 1) rides edit-product
    with absolute qty. Charges are never split: one session, one place send.
    """

    def __init__(self, *, store_code, product_code=None, quantity=None, items=None,
                 auth=None, request=native.native_request):
        # Lane-native item validation strictly BEFORE any auth/network work.
        self.items = _normalize_items(product_code, quantity, items)
        self.single = len(self.items) == 1
        self.auth = auth or NoonAuthLifecycle()
        self.store_code = native.ident(store_code)
        self.product_code = self.items[0]['product_code'] if self.single else None
        self.quantity = self.items[0]['quantity'] if self.single else None
        self.snapshot = self._snapshot()
        self.account_hash, self.address_hash = self.snapshot.account_ref, self.snapshot.address_ref
        journal.require_account_available('noon', self.account_hash)
        self.flow_id = str(uuid.uuid4())
        self.scope_hash = _scope_hash(self.store_code, self.items, self.address_hash)
        self.cart_hash = journal.digest({'flow': self.flow_id, 'store': self.store_code})
        self.opened = False
        self.expected = None
        self.operation_name = None
        self.session_code = None
        self.current = None
        self.review = None
        self.order = None
        self.card = None
        self.receipt_store = None
        self.pending_cookies = []
        self.client = native.NowNowCheckout(
            AccountHome('nownow', self.account_hash, self.address_hash, time.time()),
            header_provider=self._headers, request=request,
            receipt=self._receipt, response_cookies=self._cookies)

    # -- auth / journal plumbing -------------------------------------------
    def _snapshot(self, deadline=None):
        state = self.auth.status('nownow')
        return (self.auth.reconcile('nownow') if state['maintenance_state'] != 'none'
                else self.auth.revalidate('nownow', deadline=deadline))

    def _headers(self, operation, deadline):
        self.snapshot = self._snapshot(deadline)
        if (self.snapshot.account_ref != self.account_hash
                or self.snapshot.address_ref != self.address_hash):
            _fail('NOWNOW_ACCOUNT_HOME_CHANGED')
        return self.snapshot.mutation_headers('nownow') if operation in native.WRITES \
            else self.snapshot.read_headers()

    def _expect(self, operation, body):
        self.expected = (operation, hashlib.sha256(native.seam._json(body)).hexdigest())

    def _before(self, operation, digest):
        if self.expected != (operation, digest):
            _fail('NOWNOW_REQUEST_NOT_BOUND')
        journal.require_account_available('noon', self.account_hash,
                                          flow_id=self.flow_id if self.opened else None)
        kinds = {'cart_get': 'quote', 'cart_create': 'cart', 'product_edit': 'cart',
                  'cart_validate': 'quote', 'payment': 'selection',
                  'delivery_preference': 'instructions', 'instructions': 'instructions',
                  'place': 'place'}
        kind = kinds.get(operation)
        if kind is None:
            _fail('NOWNOW_OPERATION_UNMAPPED')
        financial = kind == 'place'
        if financial:
            if self.review is None or time.time() - self.review['observed_at'] > 60:
                _fail('NOWNOW_FRESH_REVIEW_REQUIRED')
        if not self.opened:
            journal.open_flow(flow_id=self.flow_id, app='noon', vertical='nownow',
                              account_hash=self.account_hash, scope_hash=self.scope_hash)
            self.receipt_store = receipts.create(flow_id=self.flow_id, app='noon', vertical='nownow',
                                                 account_hash=self.account_hash,
                                                 scope_hash=self.scope_hash)
            self.opened = True
        name = operation
        if operation == 'product_edit':
            name = operation + '_' + digest[:16]
        elif operation == 'cart_get':
            # Readback state reads may repeat across a resume; each gets a
            # distinct durable operation name but the exact request digest.
            name = operation + '_' + uuid.uuid4().hex[:8]
        self.operation_name = name
        result = journal.consume(self.flow_id, name, kind=kind, request_hash=digest,
                                 cart_hash=self.cart_hash,
                                 review_hash=self.review['digest'] if financial else None,
                                 payable_minor=self.review['payable_minor'] if financial else None)
        self.expected = None
        return result

    def _receipt(self, record):
        if record['service'] != 'nownow':
            _fail('NOWNOW_RECEIPT_SCOPE_INVALID')
        if record['operation'] == 'place':
            self.receipt_store.append(receipts.Receipt(
                operation='place',
                state='SUBMISSION_UNKNOWN' if record['outcome'] == 'UNKNOWN' else record['outcome'],
                http_status=record['http_status'], order_id=record['order_id'], currency='AED',
                payable_minor=self.review['payable_minor'], review_sha256=self.review['digest']))
        journal.observe(self.flow_id, self.operation_name, outcome=record['outcome'],
                        evidence_hash=record['evidence_hash'], order_id=record['order_id'])
        return True

    def _cookies(self, operation, values, *, response_url, http_status, outcome_journaled):
        pending = (self.snapshot, tuple(values), response_url, http_status)
        self.pending_cookies.append(pending)
        if operation in native.WRITES and not outcome_journaled:
            return True
        self.auth.retain_response_cookies('nownow', self.snapshot, values,
                                          response_url=response_url, http_status=http_status)
        self.pending_cookies.remove(pending)
        return True

    # -- guards -------------------------------------------------------------
    def guard_active_orders(self, *, timeout=25):
        """Allow only completed, attributed purchases for a distinct scope."""
        active = self.client.home(timeout=timeout).projection['active_orders']
        blockers = []
        for order in active:
            binding = journal.completed_order_binding(
                app='noon', vertical='nownow', account_hash=self.account_hash,
                order_id=order['order'])
            # scope_hash includes store, products, quantities and verified home.
            # A paid but still-in-flight duplicate remains blocked. Remote status
            # alone never proves that a prior financial send was reconciled.
            if binding is None or binding['scope_hash'] == self.scope_hash:
                blockers.append(order)
        if blockers:
            print(json.dumps({'phase': 'active_order_blocker', 'active_orders': blockers}), flush=True)
            _fail('NOWNOW_ACTIVE_ORDER_PRESENT')
        return active

    def guard(self, *, timeout=25):
        """Unresolved/duplicate active order or existing store cart blocks."""
        active = self.guard_active_orders(timeout=timeout)
        carts = self.client.recent_carts(timeout=timeout).projection['carts']
        stores = {row.get('store_code') for row in carts if not row.get('empty')}
        if self.store_code in stores:
            print(json.dumps({'phase': 'store_cart_blocker', 'store': self.store_code}), flush=True)
            _fail('NOWNOW_STORE_CART_PRESENT')
        self.card = saved_card(self.client, timeout=timeout)
        corroborate_token(self.client, self.card, timeout=timeout)
        return {'active_orders': len(active), 'store_cart_clear': True,
                'card_last4': '5542', 'token_corroborated': True}

    # -- lifecycle ----------------------------------------------------------
    def create_session(self, *, timeout=25):
        """Session create carries the FIRST item (native single-product route)."""
        first = self.items[0]
        body = {'storeCode': self.store_code, 'productCode': first['product_code'],
                'modifiers': native.modifiers_payload(first['modifiers'])}
        self._expect('cart_create', body)
        result = self.client.create_cart(store_code=self.store_code,
                                         product_code=first['product_code'],
                                         modifiers=first['modifiers'],
                                         before_send=self._before, timeout=timeout)
        self.session_code = result.projection['session_code']
        self.current = result
        return result.projection

    def apply_items(self, *, timeout=25):
        """edit-product per line until the cart equals the exact manifest.

        The create already expresses item 0 when it is a bare qty-1 line with
        no modifiers/notes; every other line (and any deviation) rides one
        absolute-qty edit-product. Lines whose exact intent is already
        journalled (resume) are skipped by operation name, never re-sent.
        """
        if self.session_code is None:
            _fail('NOWNOW_SESSION_REQUIRED')
        consumed = self.consumed()
        for index, item in enumerate(self.items):
            if index == 0 and item['quantity'] == 1 \
                    and not item['modifiers'] and item['notes'] is None:
                continue
            body = {'sessionCode': self.session_code, 'productCode': item['product_code'],
                    'qty': item['quantity'], 'notes': item['notes'],
                    'modifiers': native.modifiers_payload(item['modifiers'])}
            if 'product_edit_' + hashlib.sha256(
                    native.seam._json(body)).hexdigest()[:16] in consumed:
                continue
            self._expect('product_edit', body)
            self.current = self.client.add_product(session_code=self.session_code,
                                                   product_code=item['product_code'],
                                                   quantity=item['quantity'],
                                                   modifiers=item['modifiers'],
                                                   notes=item['notes'],
                                                   before_send=self._before, timeout=timeout)
        return self.current.projection

    def set_quantity(self, *, timeout=25):
        """Legacy single-line alias; identical wire behaviour for one item."""
        return self.apply_items(timeout=timeout)

    def validate(self, *, timeout=25):
        """One validate call; response is the pre-place reviewed state."""
        body = {'sessionCode': self.session_code}
        self._expect('cart_validate', body)
        self.current = self.client.validate_cart(self.session_code, store_code=self.store_code,
                                                 before_send=self._before, timeout=timeout)
        return self.current.projection

    def guard_validated(self, *, timeout=25):
        """Pre-place guard on the validate response: sane fees, exact address.

        Refuses anomalies: fee arithmetic mismatch, tip/cash/discount set,
        wallet nonzero, wrong address/store/session or manifest mismatch.
        """
        if self.current is None or self.session_code is None:
            _fail('NOWNOW_VALIDATED_SESSION_REQUIRED')
        self._guard_state(self.current.wire['data'])
        return {'validated': True}

    def _guard_state(self, row):
        if row.get('checkoutSessionCode') != self.session_code \
                or not isinstance(row.get('storeInfo'), dict) \
                or row['storeInfo'].get('storeCode') != self.store_code:
            _fail('NOWNOW_SESSION_IDENTITY_CHANGED')
        expected = sorted((item['product_code'], item['quantity']) for item in self.items)
        if not expected or _wire_manifest(row.get('products')) != expected:
            _fail('NOWNOW_MANIFEST_MISMATCH')
        fees = project_fees(row)
        subtotal = native.seam.amount_minor(row['orderSubtotal'])
        total = native.seam.amount_minor(row['orderTotal'])
        payable = native.seam.amount_minor(row['orderPaymentAmount'])
        known = {k: v for k, v in fees.items() if v is not None}
        if subtotal + sum(known.values()) != total or total != payable \
                or total <= 0 \
                or native.seam.amount_minor(row.get('orderWalletAmount')) != 0 \
                or known.get('orderRiderTip') or known.get('orderCashFee') \
                or known.get('orderDiscount') or known.get('orderSmallOrderFee'):
            _fail('NOWNOW_FEE_ARITHMETIC_OR_EXTRAS')
        headers = self.snapshot.read_headers()
        if row.get('addressCode') != headers['x-addresscode']:
            _fail('NOWNOW_ADDRESS_BINDING_MISMATCH')
        return {'subtotal_minor': subtotal, 'fees_minor': known, 'total_minor': total}

    def pre_place_read(self, *, timeout=25):
        """Final full-state readback before place (session/active POST)."""
        if self.session_code is None:
            _fail('NOWNOW_SESSION_REQUIRED')
        body = {'storeCode': self.store_code}
        self._expect('cart_get', body)
        readback = self.client.get_cart(self.store_code, before_send=self._before, timeout=timeout)
        if readback.projection.get('empty'):
            _fail('NOWNOW_SESSION_LOST_BEFORE_PLACE')
        self.current = readback
        return readback.projection

    def review_final(self, *, timeout=25):
        """Freeze the pre-place review from the final readback state.

        Requires the payment readback (prepaid, saved-card mask, subscription)
        and BOTH quiet flags true, plus every fee/manifest/address guard.
        """
        if self.current is None or self.session_code is None:
            _fail('NOWNOW_FINAL_READBACK_REQUIRED')
        row = self.current.wire['data']
        state = self._guard_state(row)
        if self.card is None:
            _fail('NOWNOW_CARD_REQUIRED')
        if row.get('hasPaymentSubscription') is not True \
                or row.get('paymentMethodCode') != 'prepaid' \
                or row.get('creditCardMask') != self.card.mask:
            _fail('NOWNOW_PAYMENT_READBACK_MISMATCH')
        prefs = row.get('deliveryPreference')
        if not isinstance(prefs, dict) or any(prefs.get(code) is not True for code in QUIET_FLAGS):
            _fail('NOWNOW_QUIET_PREFERENCE_NOT_ACTIVE')
        if row.get('driverNotes') != native.QUIET_NOTE:
            _fail('NOWNOW_QUIET_NOTE_MISMATCH')
        projection = {'session': self.session_code, 'store': self.store_code,
                      'product': self.product_code, 'qty': self.quantity,
                      'subtotal_minor': state['subtotal_minor'], 'fees_minor': state['fees_minor'],
                      'total_minor': state['total_minor'],
                      'address_code': row.get('addressCode'),
                      'address_version': row.get('addressVersion'),
                      'card_last4': '5542', 'quiet': True}
        if not self.single:
            # Multi-line basket binds the full sorted manifest (single-item
            # flows keep the exact legacy projection shape/digest).
            projection['products'] = sorted(
                [item['product_code'], item['quantity']] for item in self.items)
        self.review = {'digest': journal.digest(projection),
                       'payable_minor': state['total_minor'],
                       'observed_at': time.time(), 'projection': projection}
        return dict(projection, review_hash=self.review['digest'])

    def select_saved_card(self, *, timeout=25):
        """edit-payment binds the saved-card token; readback must echo it."""
        if self.card is None:
            _fail('NOWNOW_CARD_REQUIRED')
        body = native.payment_payload(self.session_code, self.card)
        self._expect('payment', body)
        self.current = self.client.set_payment_method(session_code=self.session_code,
                                                      card=self.card, before_send=self._before,
                                                      timeout=timeout)
        row = self.current.wire['data']
        if row.get('hasPaymentSubscription') is not True \
                or row.get('paymentMethodCode') != 'prepaid' \
                or row.get('creditCardMask') != self.card.mask:
            _fail('NOWNOW_PAYMENT_READBACK_MISMATCH')
        return {'paymentMethodCode': 'prepaid', 'creditCardMask': self.card.mask,
                'hasPaymentSubscription': True}

    def quiet_delivery(self, *, timeout=25):
        """BOTH quiet flags true in ONE full-state call, then verify readback."""
        row = self.current.wire['data']
        prefs = row.get('deliveryPreference')
        if not isinstance(prefs, dict) or not set(QUIET_FLAGS) <= set(prefs):
            _fail('NOWNOW_QUIET_PREFERENCE_UNSUPPORTED')
        selected = {code: True for code in QUIET_FLAGS}
        body = {'sessionCode': self.session_code, 'deliveryPreference': selected}
        self._expect('delivery_preference', body)
        self.current = self.client.set_delivery_preference(session_code=self.session_code,
                                                           preferences=selected,
                                                           before_send=self._before, timeout=timeout)
        after = self.current.wire['data'].get('deliveryPreference')
        if not isinstance(after, dict) or any(after.get(code) is not True for code in QUIET_FLAGS):
            _fail('NOWNOW_QUIET_PREFERENCE_NOT_ACTIVE')
        return {code: True for code in QUIET_FLAGS}

    def quiet_notes(self, *, timeout=25):
        """Send the native driver note once, then require its exact echo."""
        if self.session_code is None:
            _fail('NOWNOW_SESSION_REQUIRED')
        body = {'sessionCode': self.session_code, 'driverNotes': native.QUIET_NOTE}
        self._expect('instructions', body)
        self.current = self.client.set_quiet_notes(session_code=self.session_code,
                                                   before_send=self._before,
                                                   timeout=timeout)
        if self.current.wire['data'].get('driverNotes') != native.QUIET_NOTE:
            _fail('NOWNOW_QUIET_NOTE_MISMATCH')
        return {'driver_notes': native.QUIET_NOTE}

    def place(self, *, timeout=25):
        """Single financial send: place-order {sessionCode, total}."""
        if self.review is None:
            _fail('NOWNOW_REVIEW_REQUIRED')
        body = native.place_payload(self.session_code, self.review['payable_minor'])
        self._expect('place', body)
        result = self.client.place_order(session_code=self.session_code,
                                         order_payment_minor=self.review['payable_minor'],
                                         before_send=self._before, timeout=timeout)
        self.order = result.projection['order']
        return result.projection

    # -- confirmation --------------------------------------------------------
    def poll_tracking(self, *, attempts=40, sleep=time.sleep, timeout=25):
        """Poll v1/order/tracking until placed/preparing (live paid-order proof).

        Captured transitions on NNGAANNWEFJMZW8A: placed ("Awaiting
        confirmation from the merchant", needHelpActions incl. cancel_order)
        -> preparing ("order is being prepared", estimate window).
        """
        if self.order is None:
            _fail('NOWNOW_ORDER_REQUIRED')
        last = None
        for attempt in range(attempts):
            tracking = self.client.tracking(self.order, timeout=timeout).projection
            status = tracking['status']
            if status != last:
                last = status
                print(json.dumps({'phase': 'tracking_poll', 'order': self.order,
                                  'status': status, 'description': tracking['description'],
                                  'estimate': tracking['estimate']}), flush=True)
            if status in TERMINAL_TRACK_STATUSES:
                return tracking
            sleep(5)
        _fail('NOWNOW_TRACKING_NOT_CONFIRMED')

    def confirm_paid(self, tracking):
        """place 200 + native tracking == the captured paid signal (no intents)."""
        if tracking.get('order') != self.order \
                or tracking.get('status') not in TERMINAL_TRACK_STATUSES:
            _fail('NOWNOW_EXACT_TRACKING_NOT_CONFIRMED')
        journal.observe(self.flow_id, 'place', outcome='PAYMENT_REPORTED_SUCCESS',
                        evidence_hash=journal.digest({'order': self.order,
                                                      'tracking': tracking}),
                        order_id=self.order)
        journal.observe(self.flow_id, 'place', outcome='EXACT_ORDER_CONFIRMED',
                        evidence_hash=journal.digest(tracking), order_id=self.order)
        return {'paid': True, 'signal': 'place_200_plus_native_tracking',
                'need_help_actions': tracking.get('need_help_actions')}

    def register_tracker(self, label, *, eta=None, recipient='owner'):
        """order-watch add with durable readback; observe TRACKER_REGISTERED."""
        name = f"order-noon-{self.order.lower()}"
        command = [WATCH_BIN, 'add', '--app', 'noon', '--order', self.order,
                   *order_watch_receipt.command_args(recipient),
                   '--placed-at', dt.datetime.now(dt.timezone(dt.timedelta(hours=4))).isoformat(),
                   '--label', label]
        if eta:
            command += ['--eta', eta]
        env = {k: v for k, v in os.environ.items()
               if k not in ('NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_INSPECT')}
        try:
            result = subprocess.run(command, env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=125)
        except (OSError, subprocess.TimeoutExpired):
            _fail('TRACKER_REGISTRATION_UNCONFIRMED_READBACK_REQUIRED')
        try:
            config = json.loads((WATCH_ORDERS / f'{name}.json').read_text())
            watcher = json.loads((WATCH_WATCHERS / name / 'watcher.json').read_text())
        except (OSError, ValueError):
            _fail('TRACKER_REGISTRATION_UNCONFIRMED_READBACK_REQUIRED')
        exit_ok, receipt = order_watch_receipt.parse(result.stdout, result.returncode, recipient, name)
        if not exit_ok or config.get('order') != self.order \
                or config.get('active') is not True or not watcher:
            _fail('TRACKER_REGISTRATION_UNCONFIRMED_READBACK_REQUIRED')
        journal.observe(self.flow_id, 'place', outcome='TRACKER_REGISTERED',
                        evidence_hash=journal.digest({'watcher': name, 'active': True}),
                        order_id=self.order)
        return {'watcher': name, 'registered': True, **receipt}

    # -- resume --------------------------------------------------------------
    @classmethod
    def resume_active(cls, flow_id, *, store_code, product_code=None, quantity=None,
                      items=None, auth=None, request=native.native_request):
        """Continue an ACTIVE pre-place flow from the store's live session.

        Only non-financial operations may already be consumed (each OBSERVED).
        The active store session must match our exact manifest; nothing is
        re-sent. Refuses flows older than 24h. Accepts the legacy single-item
        pair or items= rows; lane-native validation runs before any auth work.
        """
        normalized = _normalize_items(product_code, quantity, items)
        binding = journal.binding(flow_id)
        state = journal.inspect(flow_id)
        if binding['app'] != 'noon' or binding['vertical'] != 'nownow':
            _fail('NOWNOW_FLOW_REQUIRED')
        if state['state'] != 'ACTIVE' or state['order_id'] \
                or any(x['kind'] == 'place' for x in state['operations']) \
                or any(x['state'] != 'OBSERVED' for x in state['operations']):
            _fail('NOWNOW_ACTIVE_PREPARATION_REQUIRED')
        if time.time() - journal.flow_created_at(flow_id) > FLOW_MAX_AGE_SECONDS:
            _fail('NOWNOW_FLOW_EXPIRED_24H')
        self = object.__new__(cls)
        self.auth = auth or NoonAuthLifecycle()
        self.store_code = native.ident(store_code)
        self.items = normalized
        self.single = len(normalized) == 1
        self.product_code = normalized[0]['product_code'] if self.single else None
        self.quantity = normalized[0]['quantity'] if self.single else None
        self.snapshot = self._snapshot()
        self.account_hash, self.address_hash = self.snapshot.account_ref, self.snapshot.address_ref
        self.scope_hash = _scope_hash(self.store_code, self.items, self.address_hash)
        if self.scope_hash != binding['scope_hash'] \
                or self.account_hash != binding['account_hash']:
            _fail('NOWNOW_RECOVERY_SCOPE_MISMATCH')
        journal.require_account_available('noon', self.account_hash, flow_id=flow_id)
        self.flow_id = flow_id
        self.cart_hash = journal.digest({'flow': flow_id, 'store': self.store_code})
        self.opened = True
        self.expected = None
        self.operation_name = None
        self.session_code = None
        self.current = None
        self.review = None
        self.order = None
        self.card = None
        self.receipt_store = receipts.load(**binding)
        self.pending_cookies = []
        self.client = native.NowNowCheckout(
            AccountHome('nownow', self.account_hash, self.address_hash, time.time()),
            header_provider=self._headers, request=request,
            receipt=self._receipt, response_cookies=self._cookies)
        # Read-only adoption of the live store session, journalled as a quote.
        body = {'storeCode': self.store_code}
        self._expect('cart_get', body)
        readback = self.client.get_cart(self.store_code, before_send=self._before, timeout=25)
        row = readback.wire.get('data') or {}
        expected = sorted((item['product_code'], item['quantity']) for item in self.items)
        if readback.projection.get('empty') \
                or _wire_manifest(row.get('products')) != expected:
            _fail('NOWNOW_RESUME_MANIFEST_MISMATCH')
        self.session_code = readback.projection['session_code']
        self.current = native.Snapshot({'data': row}, readback.projection, time.time())
        self.card = saved_card(self.client, timeout=25)
        corroborate_token(self.client, self.card, timeout=25)
        return self

    def prepare_only(self, *, timeout=25):
        """Build and review the exact basket, then STOP before any financial send.

        Fresh flow: full guard (attributed distinct orders, no foreign store cart) ->
        create + per-line edits -> validate -> card -> quiet -> final
        readback review. Resumed flow: consumed writes are never re-sent; the
        live store session is adopted read-only and must match the exact
        manifest. place() stays unauthorised; the flow remains ACTIVE.
        """
        consumed = self.consumed() if self.opened else set()
        self.guard_active_orders(timeout=timeout)
        if self.card is None:
            self.card = saved_card(self.client, timeout=timeout)
            corroborate_token(self.client, self.card, timeout=timeout)
        if 'cart_create' in consumed:
            # Adopt the live store session read-only; exact manifest required.
            body = {'storeCode': self.store_code}
            self._expect('cart_get', body)
            readback = self.client.get_cart(self.store_code, before_send=self._before,
                                            timeout=timeout)
            if readback.projection.get('empty'):
                _fail('NOWNOW_SESSION_LOST_BEFORE_PLACE')
            self.session_code = readback.projection['session_code']
            self.current = readback
            expected = sorted((item['product_code'], item['quantity']) for item in self.items)
            if _wire_manifest(readback.wire.get('data', {}).get('products')) != expected:
                _fail('NOWNOW_RESUME_MANIFEST_MISMATCH')
        else:
            carts = self.client.recent_carts(timeout=timeout).projection['carts']
            stores = {row.get('store_code') for row in carts if not row.get('empty')}
            if self.store_code in stores:
                print(json.dumps({'phase': 'store_cart_blocker', 'store': self.store_code}), flush=True)
                _fail('NOWNOW_STORE_CART_PRESENT')
            self.create_session(timeout=timeout)
        self.apply_items(timeout=timeout)
        if 'cart_validate' not in consumed:
            self.validate(timeout=timeout)
        if 'payment' not in consumed:
            self.select_saved_card(timeout=timeout)
        if 'delivery_preference' not in consumed:
            self.quiet_delivery(timeout=timeout)
        if 'instructions' not in consumed:
            self.quiet_notes(timeout=timeout)
        self.pre_place_read(timeout=timeout)
        self.guard_validated(timeout=timeout)
        review = self.review_final(timeout=timeout)
        return {'flow_id': self.flow_id, 'prepared_only': True, 'review': review,
                'readback': dict(self.current.projection)}

    def consumed(self):
        return {x['name'] for x in journal.inspect(self.flow_id)['operations']}
