"""Journalled noon SUPERMALL (rocket) paid-order lane (captured 2026-10-10).

Live proof: paid rocket order NAEIA0000960441 (1x Quest Vanilla Protein
Milkshake 325ml, AED 25.49 = 17.00 item + 8.49 fees, frictionless saved-card
cc_noonpay — no CVV, no 3DS, no clientSecret consumption). Checkout family is
identical to Main; rocket deltas only (captured contract):

  - catalog verify requires the rocket-flagged buyable offer;
  - cart add is the quick_atc route POST cart-v1/cart/item/{offer}/{qty}
    ?showCart with body {"isFouponSelected":false,"isInstallationSelected":false};
  - the session shipment block carries isRocket true / isSlotBased false and
    the selected express promise holds an ABSOLUTE deliveryDate (watcher eta);
  - fees exist: total == orderPaymentAmount and subtotal == line sum, with
    total >= subtotal (Main required total == subtotal == payable);
  - the captured chain posts the whole checkout family with x-experience ecom,
    so the ordering transport binds to the shared 'main' (ecom) experience
    while the journal keeps the distinct 'supermall' vertical identity.

Lifecycle (mutations journalled at-most-once):
  guard empty cart + no unpaid active orders -> catalog rocket skuConfig ->
  offer resolution (buyable, rocket, min quantity) -> quick add -> checkout
  session {shouldUpdateSession:true} (verify silent delivery + default card
  5542 + address + totals + rocket manifest + absolute promise) -> place-order
  {total} -> order-status poll until success+shipments (paid signal;
  paymentError is failure) -> exact tracking -> watcher.
"""
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import commerce_journal as journal
import commerce_receipts as receipts
from commerce_marketplace_preflight import prior_order_paid
import noon_http_orders as core
import noon_marketplace_checkout as market
import order_watch_receipt
import noon_minutes_checkout as seam
from noon_auth_lifecycle import NoonAuthLifecycle
from commerce_marketplace_payment import MarketplacePayment

WATCH_BIN = str(Path.home() / '.local/bin/order-watch')
WATCH_ORDERS = Path.home() / '.local/state/order-tracker/orders'
WATCH_WATCHERS = Path.home() / '.local/share/robob-watch/watchers'
FLOW_MAX_AGE_SECONDS = 24 * 3600
SEARCH_HOST = 'api-app.noon.com'
SEARCH_PATH = '/_svc/catalog/api/v3/u/search'
PAID_TOTAL_RE = r'\d+\.\d{2}'
ABSOLUTE_DATE_RE = r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'
DUBAI = dt.timezone(dt.timedelta(hours=4))


class CatalogError(journal.JournalError):
    def __init__(self, code, sku_config):
        self.code = code
        self.details = {'sku_config': sku_config}
        super().__init__(code)


def _fail(code):
    journal.fail(code)


def _truthy(value):
    """Catalog v3 search returns booleans as the string "True"."""
    if value is True:
        return True
    if isinstance(value, str) and value.strip().lower() == 'true':
        return True
    return False


def _positive_int(value):
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def resolve_rocket_offer(headers, sku_config, *, deadline=None, timeout=25):
    """Exact catalog search: the skuConfig's live buyable ROCKET offer code.

    Read-only; uses verified account headers. The captured rocket item is
    flagged rocket/quick_atc in its search hit; a non-rocket or ambiguous hit
    never reaches the cart.
    """
    if not isinstance(sku_config, str) or not market.ID.fullmatch(sku_config):
        _fail('SUPERMALL_SKU_CONFIG_INVALID')
    def unavailable(code):
        raise CatalogError(code, sku_config)
    headers = seam._headers(headers)
    # Ecom search collapses some Rocket skuConfigs into a different variant.
    # Catalog uses rocket; the separately captured checkout still uses ecom.
    headers.update({'x-mp': 'noon', 'x-experience': 'rocket'})
    url = ('https://' + SEARCH_HOST + SEARCH_PATH + '?q='
           + urllib.parse.quote(sku_config, safe=''))
    request = urllib.request.Request(url, headers=headers, method='GET')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), core.NoRedirect())
    end = core.operation_deadline(timeout, deadline)
    try:
        with core.read_deadline(end) as left:
            with opener.open(request, timeout=left) as response:
                if not 200 <= response.code < 300:
                    raise core.NoonError('HTTP_' + str(response.code))
                data = seam.decode_response(response.read(seam.MAX_BYTES + 1))
    except (OSError, ValueError, urllib.error.URLError, core.NoonError):
        unavailable('SUPERMALL_CATALOG_SEARCH_FAILED')
    hits = data.get('hits') if isinstance(data, dict) else None
    if not isinstance(hits, list) or len(hits) > 200:
        unavailable('SUPERMALL_CATALOG_SCHEMA_CHANGED')
    matches = [hit for hit in hits if isinstance(hit, dict)
               and hit.get('sku_config') == sku_config]
    offers = {hit.get('offer_code') for hit in matches
              if _truthy(hit.get('is_buyable'))}
    if not matches or len(offers) != 1:
        unavailable('SUPERMALL_CATALOG_ITEM_UNAVAILABLE')
    rocket = [hit for hit in matches
              if hit.get('offer_code') in offers and _is_rocket_hit(hit)]
    if len(rocket) != 1:
        unavailable('SUPERMALL_ITEM_NOT_ROCKET')
    offer = rocket[0].get('offer_code')
    if not isinstance(offer, str) or not market.ID.fullmatch(offer):
        unavailable('SUPERMALL_CATALOG_SCHEMA_CHANGED')
    minimum = max([_positive_int(hit.get('stock_minimum_quantity')) or 1
                   for hit in matches])
    return {'offer': offer, 'stock_minimum_quantity': minimum,
            'sale_price': matches[0].get('sale_price'),
            'title': matches[0].get('name'),
            'image_url': __import__('catalog_schema').image(matches[0], 'https://f.nooncdn.com/p/')}


def _is_rocket_hit(hit):
    flags = hit.get('flags')
    # A nested rocket object can advertise a DIFFERENT offer on a standard hit.
    return isinstance(flags, list) and 'rocket' in flags


def active_marketplace_orders(*, timeout=25):
    """Order-v2 active page via the verified marketplace session (read-only)."""
    end = core.operation_deadline(timeout)
    headers = core.verified_session('marketplace', end)
    rows = core.marketplace_cards(core.request('marketplace_active', headers, end))
    return [{'order': row['order'], 'raw_status': row['raw_status']} for row in rows]


def _normalize_items(sku_config, quantity, items):
    """Validate one explicit item list; never a raw passthrough.

    Single-item backcompat: sku_config+quantity. Multi-item: items rows
    {sku_config, quantity}. Mixing both forms fails. No arbitrary quantity
    caps; the live stock_minimum_quantity merchant minimum is enforced later.
    """
    if items is not None:
        if sku_config is not None or quantity is not None:
            _fail('SUPERMALL_ITEMS_CONFLICT')
        if not isinstance(items, (tuple, list)) or not items:
            _fail('SUPERMALL_ITEMS_REQUIRED')
        out, seen = [], set()
        for row in items:
            if not isinstance(row, dict) or 'sku_config' not in row or 'quantity' not in row \
                    or not set(row) <= {'sku_config', 'quantity'}:
                _fail('SUPERMALL_ITEM_ROW_INVALID')
            code, qty = row['sku_config'], row['quantity']
            if not isinstance(code, str) or not market.ID.fullmatch(code):
                _fail('SUPERMALL_SKU_CONFIG_INVALID')
            if type(qty) is not int or not 1 <= qty:
                _fail('SUPERMALL_QUANTITY_INVALID')
            if code in seen:
                _fail('SUPERMALL_DUPLICATE_SKU_CONFIG')
            seen.add(code)
            out.append({'sku_config': code, 'quantity': qty})
        return out
    if type(quantity) is not int or not 1 <= quantity:
        _fail('SUPERMALL_QUANTITY_INVALID')
    if not isinstance(sku_config, str) or not market.ID.fullmatch(sku_config):
        _fail('SUPERMALL_SKU_CONFIG_INVALID')
    return [{'sku_config': sku_config, 'quantity': quantity}]


def _scope_hash(items, address_hash):
    """Single-item keeps the exact legacy digest; multi binds the full manifest."""
    if len(items) == 1:
        return journal.digest({'sku': items[0]['sku_config'], 'qty': items[0]['quantity'],
                               'home': address_hash, 'card': '5542', 'quiet': True,
                               'service': 'supermall'})
    return journal.digest({'items': [[i['sku_config'], i['quantity']] for i in items],
                           'home': address_hash, 'card': '5542', 'quiet': True,
                           'service': 'supermall'})


def _sorted_wire_manifest(rows):
    """Sorted [(offerCode, quantity)] cart rows; None on any shape drift."""
    if not isinstance(rows, list):
        return None
    out = []
    for row in rows:
        if not isinstance(row, dict) or row.get('offerCode') is None:
            return None
        out.append((row['offerCode'], row.get('quantity')))
    return sorted(out)


def _promise_eta(value):
    """Absolute promise deliveryDate (Dubai local) -> timezone-aware ISO eta."""
    if not isinstance(value, str):
        return None
    try:
        moment = dt.datetime.strptime(value, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=DUBAI)
    except ValueError:
        return None
    return moment.isoformat()


class SupermallOrderFlow(MarketplacePayment):
    """One owned supermall (rocket) order following the captured contract."""

    vertical = 'supermall'

    def __init__(self, *, sku_config=None, quantity=None, items=None, auth=None,
                 request=market.native_request):
        # Lane-native item validation strictly BEFORE any auth/network work.
        self.items = _normalize_items(sku_config, quantity, items)
        self.single = len(self.items) == 1
        self.sku_config = self.items[0]['sku_config'] if self.single else None
        self.quantity = self.items[0]['quantity'] if self.single else None
        self.auth = auth or NoonAuthLifecycle()
        self.snapshot = self._snapshot()
        self.account_hash, self.address_hash = self.snapshot.account_ref, self.snapshot.address_ref
        journal.require_account_available('noon', self.account_hash)
        self.flow_id = str(uuid.uuid4())
        self.scope_hash = _scope_hash(self.items, self.address_hash)
        self.cart_hash = journal.digest({'service': 'supermall', 'account': self.account_hash,
                                         'flow': self.flow_id})
        self.opened = False
        self.expected = None
        self.current_operation = None
        self.offers = None
        self.offer = None
        self.last_cart = None
        self.session_response = None
        self.review = None
        self.order = None
        self.receipt_store = None
        self.pending_cookies = []
        # Captured rocket checkout chain posts the checkout-v2/cart-v1 family
        # with x-experience ecom; the journal vertical stays 'supermall'.
        self.client = market.MarketplaceClient('main', header_provider=self._headers,
                                               before_send=self._before, receipt=self._receipt,
                                               response_cookies=self._cookies, request=request)

    # -- auth / journal plumbing -------------------------------------------
    def _snapshot(self, deadline=None):
        state = self.auth.status('supermall')
        return (self.auth.reconcile('supermall') if state['maintenance_state'] != 'none'
                else self.auth.revalidate('supermall', deadline=deadline))

    def _headers(self, operation, deadline):
        snapshot = self._snapshot(deadline)
        if (snapshot.account_ref != self.account_hash
                or snapshot.address_ref != self.address_hash
                or operation.service != 'main'):
            _fail('SUPERMALL_ACCOUNT_HOME_CHANGED')
        self.snapshot = snapshot
        return snapshot.mutation_headers('supermall') if operation.mutation else snapshot.read_headers()

    def _before(self, metadata):
        journal.require_account_available('noon', self.account_hash,
                                          flow_id=self.flow_id if self.opened else None)
        if self.expected is None or metadata != {
                'service': 'main', 'operation': self.expected[0],
                'request_digest': self.expected[1],
                'order_id': self.order if self.expected[0] == 'payment_complete' else None}:
            _fail('SUPERMALL_REQUEST_NOT_BOUND')
        operation = self.expected[0]
        kinds = {'add_rocket': 'cart', 'session': 'quote', 'place': 'place', 'payment_complete': 'payment'}
        kind = kinds.get(operation)
        if kind is None:
            _fail('SUPERMALL_OPERATION_UNMAPPED')
        financial = kind in ('place', 'payment')
        if financial and (self.review is None or kind == 'place' and time.time() - self.review['observed_at'] > 60):
            _fail('SUPERMALL_FRESH_REVIEW_REQUIRED')
        if not self.opened:
            journal.open_flow(flow_id=self.flow_id, app='noon', vertical='supermall',
                              account_hash=self.account_hash, scope_hash=self.scope_hash)
            self.opened = True
            self.receipt_store = receipts.create(flow_id=self.flow_id, app='noon', vertical='supermall',
                                                 account_hash=self.account_hash,
                                                 scope_hash=self.scope_hash)
        # Journal name: every rocket add gets a digest-suffixed unique name so
        # a resume can skip exactly the already-journalled items. The FIRST
        # session consume keeps the exact legacy name 'session' (resume/CLI
        # compatibility); a re-run session refresh (prepare_only after a
        # process restart) consumes under a fresh unique suffix instead of
        # colliding with the one-shot (flow_id, name) primary key.
        name = operation
        if operation == 'add_rocket':
            name = operation + '_' + metadata['request_digest'][:16]
        elif operation == 'session' and 'session' in (
                self._consumed_names() if self.opened else ()):
            name = 'session_' + uuid.uuid4().hex[:8]
        self.current_operation = name
        result = journal.consume(self.flow_id, name, kind=kind,
                                 request_hash=metadata['request_digest'], cart_hash=self.cart_hash,
                                 review_hash=self.review['digest'] if financial else None,
                                 payable_minor=self.review['payable_minor'] if financial else None,
                                 payment_order_id=self.order if kind == 'payment' else None)
        self.expected = None
        return result

    def _receipt(self, record):
        if record['service'] != 'main':
            _fail('SUPERMALL_RECEIPT_SCOPE_MISMATCH')
        if record['operation'] in ('place', 'payment_complete'):
            self.receipt_store.append(receipts.Receipt(
                operation='place' if record['operation'] == 'place' else 'payment',
                state='SUBMISSION_UNKNOWN' if record['outcome'] == 'UNKNOWN' else record['outcome'],
                http_status=record['http_status'], order_id=record['order_id'], currency='AED',
                payable_minor=self.review['payable_minor'], review_sha256=self.review['digest']))
        journal.observe(self.flow_id, self.current_operation, outcome=record['outcome'],
                        evidence_hash=record['evidence_hash'], order_id=record['order_id'])
        return True

    def _cookies(self, operation, values, *, response_url, http_status, outcome_journaled):
        record = (self.snapshot, tuple(values), response_url, http_status)
        self.pending_cookies.append(record)
        if operation not in ('cart', 'order_status', 'order_detail', 'order_refund', 'payment_config',
                             'payment_status') and not outcome_journaled:
            return True
        self.auth.retain_response_cookies('supermall', record[0], record[1],
                                          response_url=response_url, http_status=http_status)
        self.pending_cookies.remove(record)
        return True

    def _expect(self, name, **args):
        operation = market.operation('main', name, **args)
        self.expected = (name, operation.digest)
        return operation

    # -- guards -------------------------------------------------------------
    def _resolve_all(self, *, timeout=25):
        """Resolve every item's live rocket offer (read-only catalog search)."""
        resolved = {item['sku_config']: resolve_rocket_offer(self.snapshot.read_headers(),
                                                             item['sku_config'], timeout=timeout)
                    for item in self.items}
        for item in self.items:
            row = resolved[item['sku_config']]
            if item['quantity'] < row['stock_minimum_quantity']:
                print(json.dumps({'phase': 'minimum_quantity',
                                  'minimum': row['stock_minimum_quantity'],
                                  'sku_config': item['sku_config']}), flush=True)
                _fail('SUPERMALL_QUANTITY_BELOW_STOCK_MINIMUM')
        self.offers = {code: row['offer'] for code, row in resolved.items()}
        self.card_catalog = resolved
        self.offer = self.offers.get(self.sku_config) if self.single else None
        return resolved

    def _expected_offers(self):
        return sorted((self.offers[item['sku_config']], item['quantity'])
                      for item in self.items)

    def _consumed_names(self):
        return {x['name'] for x in journal.inspect(self.flow_id)['operations']}

    def guard(self, *, timeout=25):
        """Nonempty basket or a pending-unpaid order blocks place (as Main).

        Active paid orders are surfaced, not blockers. Expired checkout records
        need matching durable order-v2 payment/invoice evidence; pending, failed
        and unproved orders still stop the lane.
        """
        cart = self.client.cart().summary()
        if cart['empty'] is not True:
            print(json.dumps({'phase': 'cart_blocker', 'count': cart['count']}), flush=True)
            _fail('SUPERMALL_BASKET_MUST_NOT_BE_REPLACED')
        active = active_marketplace_orders(timeout=timeout)
        paid_prior = []
        for row in active:
            if not prior_order_paid(self.client, row['order'], timeout=timeout):
                print(json.dumps({'phase': 'active_order_blocker',
                                  'active_orders': active}), flush=True)
                _fail('SUPERMALL_ACTIVE_ORDER_PRESENT')
            paid_prior.append({'order': row['order'], 'status': 'success'})
        if active:
            print(json.dumps({'phase': 'prior_orders_paid', 'prior': paid_prior}), flush=True)
        resolved = self._resolve_all(timeout=timeout)
        result = {'cart_empty': True, 'active_orders': len(active),
                  'prior_orders_paid': paid_prior,
                  'items': [{'sku_config': item['sku_config'],
                             'offer': self.offers[item['sku_config']],
                             'quantity': item['quantity'],
                             'stock_minimum_quantity':
                                 resolved[item['sku_config']]['stock_minimum_quantity'],
                             'title': resolved[item['sku_config']]['title']}
                            for item in self.items]}
        if self.single:
            result.update({'offer': self.offer,
                           'stock_minimum_quantity':
                               resolved[self.sku_config]['stock_minimum_quantity'],
                           'title': resolved[self.sku_config]['title']})
        return result

    # -- lifecycle ----------------------------------------------------------
    def add(self, *, timeout=25):
        """Quick-add every resolved rocket offer; verify the exact manifest.

        Captured route: POST cart-v1/cart/item/{offer}/{qty}?showCart with the
        two explicit deselect flags (isFouponSelected/isInstallationSelected).
        Already-journalled adds (resume) are skipped by digest name and never
        re-sent; the final readback must still match the complete manifest.
        """
        if self.offers is None:
            _fail('SUPERMALL_OFFERS_UNRESOLVED')
        consumed = self._consumed_names() if self.opened else set()
        added = []
        for item in self.items:
            offer = self.offers[item['sku_config']]
            operation = self._expect('add_rocket', offer=offer,
                                     quantity=item['quantity'])
            if 'add_rocket_' + operation.digest[:16] in consumed:
                added.append({'sku_config': item['sku_config'], 'offer': offer,
                              'quantity': item['quantity'], 'resumed': True})
                continue
            self.client.call('add_rocket', offer=offer, quantity=item['quantity'],
                             timeout=timeout)
            added.append({'sku_config': item['sku_config'], 'offer': offer,
                          'quantity': item['quantity']})
        after = self.client.cart()
        summary = after.summary()
        rows = summary['items']
        if summary['empty'] or _sorted_wire_manifest(rows) != self._expected_offers():
            if self.current_operation:
                journal.observe(self.flow_id, self.current_operation, outcome='UNKNOWN',
                                evidence_hash=journal.digest({'reason': 'EXACT_ADDED_MANIFEST_MISMATCH'}))
            _fail('SUPERMALL_EXACT_ADDED_MANIFEST_MISMATCH')
        self.last_cart = after
        if self.current_operation:
            journal.observe(self.flow_id, self.current_operation, outcome='CART_READBACK',
                            evidence_hash=market.cleanup_readback_hash(after, self.account_hash, self.address_hash))
        result = {'items': added, 'count': summary['count']}
        if self.single:
            result.update({'offer': self.offer, 'sku_config': self.sku_config,
                           'quantity': self.quantity})
        return result

    def checkout_session(self, *, timeout=25):
        """checkout-v2 session {shouldUpdateSession:true} (captured body)."""
        self._expect('session', should_update_session=True)
        self.session_response = self.client.call('session', should_update_session=True,
                                                 timeout=timeout)
        return self.session_response

    def review_session(self, *, timeout=25):
        """Verify the server-carried defaults + rocket manifest; freeze review.

        The review covers the COMPLETE basket across every rocket shipment
        (multi-seller baskets are one review, never split charges): each
        shipment must be rocket/non-slot with exactly one selected express
        promise carrying an ABSOLUTE deliveryDate; the watcher eta is the
        latest promise date across shipments. Single-item flows keep the
        captured projection shape byte-for-byte.
        """
        import re as _re
        if self.session_response is None or self.last_cart is None:
            _fail('SUPERMALL_SELECTED_CART_SESSION_REQUIRED')
        data = self.session_response.data
        if not isinstance(data, dict):
            _fail('SUPERMALL_SESSION_SCHEMA_CHANGED')
        headers = self.snapshot.read_headers()
        if data.get('addressKey') != headers['x-addresskey']:
            _fail('SUPERMALL_ADDRESS_BINDING_MISMATCH')
        delivery = data.get('deliveryOptions')
        silent = delivery.get('silent_delivery') if isinstance(delivery, dict) else None
        if not isinstance(silent, dict) or silent.get('status') != 'active':
            _fail('SUPERMALL_SILENT_DELIVERY_NOT_ACTIVE')
        methods = data.get('paymentMethods')
        if not isinstance(methods, list):
            _fail('SUPERMALL_SESSION_SCHEMA_CHANGED')
        cards = None
        for row in methods:
            if isinstance(row, dict) and row.get('code') == 'cc_noonpay':
                if row.get('status') != 'active' or not isinstance(row.get('cards'), list):
                    _fail('SUPERMALL_DEFAULT_CARD_NOT_ACTIVE')
                cards = row['cards']
                break
        if cards is None:
            _fail('SUPERMALL_DEFAULT_CARD_MISSING')
        defaults = [card for card in cards if isinstance(card, dict)
                    and isinstance(card.get('mask'), str) and card['mask'].endswith('5542')
                    and card.get('isDefault') is True and card.get('isSelected') is True]
        if len(defaults) != 1:
            _fail('SUPERMALL_DEFAULT_CARD_NOT_SELECTED')
        if data.get('useCredits') is not False or data.get('walletAmount') != 0:
            _fail('SUPERMALL_CREDITS_OR_WALLET_UNEXPECTED')
        total_minor = market.fils(data.get('total'))
        subtotal_minor = market.fils(data.get('subtotal'))
        payable_minor = market.fils(data.get('orderPaymentAmount'))
        if (total_minor != payable_minor or total_minor <= 0
                or total_minor < subtotal_minor):
            _fail('SUPERMALL_TOTAL_ARITHMETIC_OR_CAP')
        shipments = data.get('shipments')
        if not isinstance(shipments, list) or not shipments:
            _fail('SUPERMALL_SHIPMENT_SCHEMA_CHANGED')
        manifest = []
        unit_sum_minor = 0
        promise_dates = []
        for shipment in shipments:
            if not isinstance(shipment, dict) \
                    or shipment.get('isRocket') is not True \
                    or shipment.get('isSlotBased') is not False:
                _fail('SUPERMALL_ROCKET_SHIPMENT_REQUIRED')
            items = shipment.get('items')
            if not isinstance(items, list) or not items:
                _fail('SUPERMALL_SHIPMENT_SCHEMA_CHANGED')
            for item in items:
                if not isinstance(item, dict) or type(item.get('quantity')) is not int:
                    _fail('SUPERMALL_SHIPMENT_SCHEMA_CHANGED')
                unit_sum_minor += market.fils(item.get('unitPrice')) * item['quantity']
                manifest.append((item.get('skuConfig'), item['quantity']))
            promises = shipment.get('promises')
            if not isinstance(promises, list):
                _fail('SUPERMALL_SHIPMENT_SCHEMA_CHANGED')
            selected = [promise for promise in promises if isinstance(promise, dict)
                        and promise.get('isSelected') is True]
            if len(selected) != 1:
                _fail('SUPERMALL_PROMISE_SELECTION_INVALID')
            promise = selected[0]
            analytics = promise.get('analytics')
            if isinstance(analytics, dict) and analytics.get('tag') != 'rocket':
                _fail('SUPERMALL_PROMISE_SELECTION_INVALID')
            delivery_date = promise.get('deliveryDate')
            if not isinstance(delivery_date, str) or not _re.fullmatch(ABSOLUTE_DATE_RE, delivery_date):
                _fail('SUPERMALL_PROMISE_DELIVERY_DATE_REQUIRED')
            promise_dates.append(delivery_date)
        expected = sorted((item['sku_config'], item['quantity']) for item in self.items)
        if sorted(manifest) != expected:
            _fail('SUPERMALL_MANIFEST_MISMATCH')
        if unit_sum_minor != subtotal_minor:
            _fail('SUPERMALL_SUBTOTAL_ARITHMETIC_MISMATCH')
        latest_date = max(promise_dates)
        eta = _promise_eta(latest_date)
        if self.single:
            projection = {'sku_config': self.sku_config, 'offer': self.offer,
                          'quantity': self.quantity, 'total_minor': total_minor,
                          'subtotal_minor': subtotal_minor,
                          'fees_minor': total_minor - subtotal_minor,
                          'address_key': data.get('addressKey'), 'card_last4': '5542',
                          'silent_delivery': True, 'credits': False, 'isRocket': True,
                          'promise_delivery_date': latest_date}
        else:
            projection = {'items': sorted([item['sku_config'], item['quantity']]
                                          for item in self.items),
                          'subtotal_minor': subtotal_minor,
                          'fees_minor': total_minor - subtotal_minor,
                          'total_minor': total_minor, 'shipments': len(shipments),
                          'address_key': data.get('addressKey'), 'card_last4': '5542',
                          'silent_delivery': True, 'credits': False, 'isRocket': True,
                          'promise_delivery_date': latest_date}
        self.review = {'digest': journal.digest(projection), 'payable_minor': total_minor,
                       'observed_at': time.time(), 'projection': projection, 'eta': eta}
        return dict(projection, review_hash=self.review['digest'], eta=eta)

    def prepare_only(self, *, timeout=25):
        """Guard -> adds -> FRESH exact basket readback -> session -> review; STOP.

        No financial send of any kind; the flow stays ACTIVE for a later
        explicit order. On resume the already-journalled rocket adds are
        skipped by digest name, and the complete basket is re-GET immediately
        before the checkout session and review freeze (never a cached
        session snapshot).
        """
        consumed = self._consumed_names() if self.opened else set()
        active = active_marketplace_orders(timeout=timeout)
        for row in active:
            if not prior_order_paid(self.client, row['order'], timeout=timeout):
                print(json.dumps({'phase': 'active_order_blocker',
                                  'active_orders': active}), flush=True)
                _fail('SUPERMALL_ACTIVE_ORDER_PRESENT')
        self._resolve_all(timeout=timeout)
        pending = [item for item in self.items
                   if 'add_rocket_' + market.operation(
                       'main', 'add_rocket', offer=self.offers[item['sku_config']],
                       quantity=item['quantity']).digest[:16] not in consumed]
        if pending:
            cart = self.client.cart().summary()
            if cart['empty'] is not True:
                print(json.dumps({'phase': 'cart_blocker', 'count': cart['count']}), flush=True)
                _fail('SUPERMALL_BASKET_MUST_NOT_BE_REPLACED')
            self.add(timeout=timeout)
        else:
            # Resume: adopt the live basket read-only; exact manifest required.
            after = self.client.cart()
            summary = after.summary()
            if summary['empty'] or _sorted_wire_manifest(summary['items']) \
                    != self._expected_offers():
                _fail('SUPERMALL_RESUME_MANIFEST_MISMATCH')
            self.last_cart = after
        # Fresh complete-basket readback immediately before the review freeze.
        fresh = self.client.cart()
        fresh_summary = fresh.summary()
        if fresh_summary['empty'] or _sorted_wire_manifest(fresh_summary['items']) \
                != self._expected_offers():
            _fail('SUPERMALL_EXACT_ADDED_MANIFEST_MISMATCH')
        self.last_cart = fresh
        self.checkout_session(timeout=timeout)
        review = self.review_session(timeout=timeout)
        return {'flow_id': self.flow_id, 'prepared_only': True, 'review': review,
                'readback': {'count': fresh_summary['count'],
                             'items': fresh_summary['items'],
                             'shipments': self.review['projection'].get('shipments'),
                             'eta': self.review.get('eta')}}

    def place(self, *, timeout=25):
        """Single financial send: place-order {total} -> bare order number."""
        if self.review is None:
            _fail('SUPERMALL_REVIEW_REQUIRED')
        self._expect('place', total=self.review['payable_minor'] / 100)
        result = self.client.call('place', total=self.review['payable_minor'] / 100,
                                  timeout=timeout)
        self.order = result.summary()['order']
        return {'order': self.order}

    def exact_tracking(self, *, attempts=10, sleep=time.sleep, timeout=25):
        """Exact order-v2 manifest read; empty groups repopulate asynchronously."""
        retry_codes = {'INVALID_RESPONSE', 'INCOMPLETE_MANIFEST'}
        last_error = None
        for attempt in range(attempts):
            try:
                return self.client.track(self.order, timeout=timeout)
            except (market.MarketplaceError, core.NoonError) as exc:
                code = getattr(exc, 'code', None) or str(exc)
                if code not in retry_codes:
                    raise
                last_error = exc
                print(json.dumps({'phase': 'exact_tracking_retry', 'attempt': attempt + 1,
                                  'error': code}), flush=True)
                sleep(6)
        raise last_error

    def verify_tracking(self, *, attempts=10, sleep=time.sleep, timeout=25):
        tracking = self.exact_tracking(attempts=attempts, sleep=sleep, timeout=timeout)
        if tracking.get('order') != self.order:
            _fail('SUPERMALL_EXACT_TRACKING_NOT_CONFIRMED')
        journal.observe(self.flow_id, 'place', outcome='EXACT_ORDER_CONFIRMED',
                        evidence_hash=journal.digest(tracking), order_id=self.order)
        return tracking

    def register_tracker(self, label, eta=None, *, recipient='owner'):
        if eta is not None:
            try:
                dt.datetime.fromisoformat(eta)
            except ValueError:
                _fail('SUPERMALL_WATCHER_ETA_INVALID')
        name = f"order-noon-{self.order.lower()}"
        command = [WATCH_BIN, 'add', '--app', 'noon', '--order', self.order,
                   *__import__('delivery_cards').commerce_args(self, 'supermall'),
                   '--payment-confirmed',
                   *order_watch_receipt.command_args(recipient, order_watch_receipt.reserved_minor(journal, self.flow_id)),
                   '--placed-at', dt.datetime.now(DUBAI).isoformat()]
        if eta is not None:
            command += ['--eta', eta]
        command += ['--label', label]
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
                        evidence_hash=journal.digest({'watcher': name, 'active': True,
                                                      'eta': eta}),
                        order_id=self.order)
        return {'watcher': name, 'registered': True, **receipt}

    # -- resume --------------------------------------------------------------
    @classmethod
    def resume_active(cls, flow_id, *, sku_config=None, quantity=None, items=None,
                      auth=None, request=market.native_request):
        """Continue an ACTIVE pre-place supermall flow from the live basket readback.

        Consumed operations must all be OBSERVED non-financial steps. The live
        cart must hold exactly our rocket offers at the requested quantities;
        nothing is re-sent. Refuses flows older than 24h. Accepts the legacy
        single-item pair or items= rows (validated before any auth work).
        """
        normalized = _normalize_items(sku_config, quantity, items)
        binding = journal.binding(flow_id)
        state = journal.inspect(flow_id)
        if binding['app'] != 'noon' or binding['vertical'] != 'supermall':
            _fail('SUPERMALL_FLOW_REQUIRED')
        if state['state'] != 'ACTIVE' or state['order_id'] \
                or any(x['kind'] == 'place' for x in state['operations']) \
                or any(x['state'] != 'OBSERVED' for x in state['operations']):
            _fail('SUPERMALL_ACTIVE_PREPARATION_REQUIRED')
        if time.time() - journal.flow_created_at(flow_id) > FLOW_MAX_AGE_SECONDS:
            _fail('SUPERMALL_FLOW_EXPIRED_24H')
        self = object.__new__(cls)
        self.auth = auth or NoonAuthLifecycle()
        self.items = normalized
        self.single = len(normalized) == 1
        self.sku_config = normalized[0]['sku_config'] if self.single else None
        self.quantity = normalized[0]['quantity'] if self.single else None
        self.snapshot = self._snapshot()
        self.account_hash, self.address_hash = self.snapshot.account_ref, self.snapshot.address_ref
        self.scope_hash = _scope_hash(self.items, self.address_hash)
        if self.scope_hash != binding['scope_hash'] \
                or self.account_hash != binding['account_hash']:
            _fail('SUPERMALL_RECOVERY_SCOPE_MISMATCH')
        journal.require_account_available('noon', self.account_hash, flow_id=flow_id)
        self.flow_id = flow_id
        self.cart_hash = journal.digest({'service': 'supermall', 'account': self.account_hash,
                                         'flow': flow_id})
        self.opened = True
        self.expected = None
        self.current_operation = None
        self.offers = None
        self.offer = None
        self.last_cart = None
        self.session_response = None
        self.review = None
        self.order = None
        self.receipt_store = receipts.load(**binding)
        self.pending_cookies = []
        self.client = market.MarketplaceClient('main', header_provider=self._headers,
                                               before_send=self._before, receipt=self._receipt,
                                               response_cookies=self._cookies, request=request)
        # Exact live-basket readback; a foreign basket is never adopted.
        resolved = {item['sku_config']: resolve_rocket_offer(self.snapshot.read_headers(),
                                                             item['sku_config'], timeout=25)
                    for item in self.items}
        self.offers = {code: row['offer'] for code, row in resolved.items()}
        self.offer = self.offers.get(self.sku_config) if self.single else None
        expected = sorted((self.offers[item['sku_config']], item['quantity'])
                          for item in self.items)
        cart_read = self.client.cart()
        cart = cart_read.summary()
        manifest = _sorted_wire_manifest(cart.get('items'))
        if cart['empty'] or manifest != expected:
            _fail('SUPERMALL_RESUME_MANIFEST_MISMATCH')
        self.last_cart = cart_read
        return self

    @classmethod
    def resume_paid(cls, flow_id, *, label, eta=None, auth=None,
                    request=market.native_request, recipient='owner'):
        """Restart-safe read-only completion of a paid, unconfirmed supermall flow.

        Requires the order id and a PAYMENT_REPORTED_SUCCESS observation; only
        the exact tracking readback, watcher registration and journal COMPLETE
        remain. Nothing is re-sent; place is never repeated.
        """
        binding = journal.binding(flow_id)
        state = journal.inspect(flow_id)
        if binding['app'] != 'noon' or binding['vertical'] != 'supermall':
            _fail('SUPERMALL_FLOW_REQUIRED')
        if state['state'] != 'ACTIVE' or not state['order_id'] \
                or not journal.payment_reported(flow_id):
            _fail('SUPERMALL_PAID_FLOW_REQUIRED')
        self = object.__new__(cls)
        self.auth = auth or NoonAuthLifecycle()
        self.flow_id = flow_id
        self.order = state['order_id']
        self.opened = True
        self.expected = None
        self.current_operation = None
        self.offer = None
        self.last_cart = None
        self.session_response = None
        self.review = None
        self.receipt_store = receipts.load(**binding)
        self.pending_cookies = []
        self.snapshot = self._snapshot()
        self.account_hash, self.address_hash = self.snapshot.account_ref, self.snapshot.address_ref
        self.cart_hash = journal.digest({'service': 'supermall', 'account': self.account_hash,
                                         'flow': flow_id})
        self.client = market.MarketplaceClient('main', header_provider=self._paid_headers,
                                               before_send=self._paid_denied,
                                               receipt=self._receipt, response_cookies=self._cookies,
                                               request=request)
        tracking = self.exact_tracking()
        if tracking.get('order') != self.order:
            _fail('SUPERMALL_EXACT_TRACKING_NOT_CONFIRMED')
        journal.observe(flow_id, 'place', outcome='EXACT_ORDER_CONFIRMED',
                        evidence_hash=journal.digest(tracking), order_id=self.order)
        registration = self.register_tracker(label, eta=eta, recipient=recipient)
        journal.complete(flow_id)
        return {'ok': True, 'flow_id': flow_id, 'order': self.order,
                'tracking': tracking, 'watcher': registration['watcher'],
                **order_watch_receipt.fields(registration), 'financial_retry': False}

    # resume_paid uses read-only plumbing: mutations are denied, receipts only journal.
    def _paid_headers(self, operation, deadline):
        snapshot = self._snapshot(deadline)
        if operation.service != 'main' or operation.mutation:
            _fail('SUPERMALL_RECOVERY_READ_ONLY')
        self.snapshot = snapshot
        return snapshot.read_headers()

    def _paid_denied(self, metadata):
        _fail('SUPERMALL_RECOVERY_READ_ONLY')
