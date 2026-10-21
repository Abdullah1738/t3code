"""Owner-scoped native Talabat lifecycle with real journal and auth bindings."""
import hashlib
import json
import time
import urllib.parse
import uuid

from commerce_auth_status import CommerceAuth
from commerce_flow import FlowGate, account_hash
import commerce_journal as journal
import talabat_http_checkout as h


def intent_scope(vertical, branch, items, allow_duplicate_of=None):
    # Preserve old empty-note/empty-choice flow hashes; any nonempty note or
    # choice set changes the intent. Raw requested rows form the intent.
    scope = {'branch':branch,'vertical':vertical,
        'items':[(x.item_id,x.quantity) for x in items],
        'home':'Banyantree2104','card':'5542','quiet':True,'extras':False}
    notes = [(x.item_id,x.note) for x in items if x.note]
    if notes:
        scope['item_notes'] = notes
    choices = [(x.item_id,x.quantity,tuple(x.choices)) for x in items if x.choices]
    if choices:
        scope['item_choices'] = choices
    if allow_duplicate_of is not None:
        scope['allow_duplicate_of'] = allow_duplicate_of
    return journal.digest(scope)


class TalabatFlow:
    def __init__(self, *, vertical, branch, items, receipt_factory=None, auth=None, timeout=120, flow_id=None,
                 allow_duplicate_of=None):
        if vertical not in ('shops', 'mart', 'restaurants'):
            journal.fail('INVALID_COMMERCE_VERTICAL')
        # Branch 798285 fence removed 2026-10-10: the ghost order 3947177570 was
        # dispositioned as a never-paid server-side zombie (not in the app order
        # list; no UI cancel exists) and a fresh authorized cart POST succeeded on
        # this branch 8 Oct. Standard flow guards (quote/place/payment binding)
        # remain fully active.
        self.auth = auth or CommerceAuth()
        self.vertical, self.branch, self.items = vertical, branch, items
        self.allow_duplicate_of = allow_duplicate_of
        if allow_duplicate_of is not None and vertical != 'restaurants':
            journal.fail('DUPLICATE_OVERRIDE_RESTAURANTS_ONLY')
        self.flow_id = flow_id or str(uuid.uuid4())
        saved = self._fresh()
        self.account_hash = account_hash(saved)
        journal.require_account_available('talabat',self.account_hash,flow_id=flow_id)
        self.approved = None
        self.store = None
        scope = intent_scope(vertical, branch, items, allow_duplicate_of)
        self.scope_hash = scope
        if receipt_factory is None:
            import commerce_receipts
            binding=dict(flow_id=self.flow_id,app='talabat',vertical=vertical,
                account_hash=self.account_hash,scope_hash=scope)
            if flow_id is not None:
                state=journal.inspect(flow_id)
                if journal.binding(flow_id)!=binding or state['state']!='ACTIVE' or any(
                        x['kind'] in ('place','payment') or x['state']!='OBSERVED' for x in state['operations']):
                    journal.fail('OWNED_PREPARATION_NOT_RESUMABLE')
                sink=commerce_receipts.load(**binding)
            else:
                sink=commerce_receipts.create(**binding)
        else:
            sink = receipt_factory(self.flow_id,self.account_hash)
        self.gate = FlowGate(flow_id=self.flow_id, app='talabat', vertical=vertical,
            account_hash=self.account_hash, scope_hash=scope,
            receipt_sink=sink,
            request_check=self._check_request)
        self.checkout = h.Checkout(saved, flow_id=self.flow_id,
            journal=self.gate.before_talabat, receipt=self.gate.talabat_receipt,
            fresh_account=self._fresh, timeout=timeout)
        if vertical == 'restaurants':
            # Read-only pre-mutation truth pass: exact menu ids, customization
            # flags and catalog-backed choices, before any cart POST.
            self.store = self.checkout.verify_restaurant_items(branch, items)
            self.items = h._items(self.store, items)
            if self.allow_duplicate_of is not None:self.verify_duplicate_override(saved)
        else:
            self.store = self.checkout.resolve_grocery(branch, vertical)
            self.items = h._items(self.store, items)
        if flow_id is not None:
            self.gate.opened=True
            self.checkout.consumed={x['name'] for x in state['operations']}

    def resume_cart(self, *, verticals_key):
        """Read only the exact cart ID already durably returned to this flow."""
        c=self.checkout
        records=self.gate.receipt_sink.snapshot().receipts
        created=next((r for r in records if r.operation=='create_cart' and r.state=='SUCCEEDED'),None)
        if created is None:journal.fail('OWNED_CART_RECEIPT_REQUIRED')
        if self.store.vertical=='restaurants':
            import talabat_restaurant_cart as restaurant
            data=c._read(f'/cart/v1/{created.cart_id}',params={'hasOutstandingPayments':'false'})
            c.restaurant_cart=restaurant.project_cart(data,cart_id=created.cart_id,
                branch_id=self.store.branch_id,items=self.items,
                choice_catalog=c._choice_catalog)
            c.cart=h.parse_cart(data,self.store,self.items,choice_catalog=c._choice_catalog,
                item_prices=c._item_prices)
        else:
            data=c._read('/grocery/v2/cart',params=c._cart_query(self.store),headers=c._grocery_headers(verticals_key))
            current=h.parse_cart(data,self.store,self.items)
            if current.cart_id!=created.cart_id:journal.fail('OWNED_CART_ID_CHANGED')
            c.cart=current
        c._verticals_key=verticals_key
        c.payment_config()
        selection=h.select_payment(c.config,c.card)
        self.expected_prepare=h.prepare_body(self.store,c.home,selection=selection,features=c.config['supportedFeatures'])
        first=c.prepare(selected=True)
        c.payment_config(first.amount_minor)
        selection=h.select_payment(c.config,c.card)
        self.expected_prepare=h.prepare_body(self.store,c.home,selection=selection,features=c.config['supportedFeatures'],
            instructions=json.loads(first.response)['checkout']['deliveryInstructions'])
        c.prepare(selected=True,quiet_from=first,phase='quote_final_quiet')
        return self.review_current()

    def _fresh(self):
        saved = self.auth.fresh_before_mutation('talabat',self.vertical,timeout=25).mutation_account(self.vertical)
        if hasattr(self,'account_hash') and account_hash(saved) != self.account_hash:
            journal.fail('ACCOUNT_CHANGED')
        return saved

    def verify_duplicate_override(self, saved):
        from commerce_talabat_duplicate import verify_override
        self.duplicate_override = verify_override(saved, order=self.allow_duplicate_of,
            branch=self.branch, items=self.items, menu=self.checkout._menu_index,
            deadline=h.auth.new_deadline(30))

    def review_current(self):
        c=self.checkout
        if c.quote is None:journal.fail('EXACT_REVIEW_REQUIRED')
        review=h.project_quote(c.quote)
        if (review['payable_minor'] <= 0
                or review['currency']!='AED' or review['card_last4']!='5542'
                or review['quiet_selected'] is not True
                or any(review[k] is not False for k in ('tip','subscription','wallet','save_preferences'))):
            journal.fail('OWNER_TEST_SCOPE_OR_BUDGET_FAILED')
        self.approved=review
        return review

    def revalidate_owned_quote(self):
        """Distinct final quote phase on the same owned cart, never another cart."""
        c=self.checkout
        saved=self._fresh()
        c.saved=saved
        c.created_at=time.monotonic();c.deadline=h.auth.new_deadline(120)
        c.read_owned_cart()
        previous=c.quote
        if previous is None:journal.fail('OWNED_QUOTE_REQUIRED')
        c.payment_config(previous.amount_minor)
        selection=h.select_payment(c.config,c.card)
        instructions=json.loads(previous.response)['checkout']['deliveryInstructions']
        self.expected_prepare=h.prepare_body(self.store,c.home,selection=selection,
            features=c.config['supportedFeatures'],instructions=instructions)
        # Fresh final review is a new explicitly named phase, not replay of the
        # consumed quote_selected_quiet request.
        c.prepare(selected=True,quiet_from=previous,phase='quote_final_quiet')
        return self.review_current()

    def _check_request(self, record):
        """Reconstruct the exact expected native request at the last pre-send seam."""
        c = self.checkout
        op = record['operation']
        if c.flow_id != self.flow_id or account_hash(c.saved) != self.account_hash:
            return False
        if op == 'create_cart':
            body = h.cart_body(self.store,c.home,self.items)
            path = '/cart/v2' if self.vertical == 'restaurants' else '/grocery/v2/cart'
        else:
            if (c.cart is None or c.cart.store != self.store or c.cart.items != self.items
                    or record.get('cart_binding') != hashlib.sha256(c.cart.cart_id.encode()).hexdigest()):
                return False
            path = '/ccx/v1/checkout/' + urllib.parse.quote(c.cart.cart_id,safe='')
            if op.startswith('quote_'):
                body = self.expected_prepare
            elif op in ('place','payment'):
                if self.approved is None:
                    return False
                quote = c.quote if op == 'place' else c._place_quote
                if (quote is None or h.project_quote(quote) != self.approved
                        or record.get('review_sha256') != self.approved['quote_digest']
                        or record.get('payable_minor') != self.approved['payable_minor']):
                    return False
                if op == 'place':
                    if time.monotonic()-quote.observed_at >= 120:
                        return False
                    body = h.place_body(quote,allow_duplicate=self.allow_duplicate_of is not None); path += '/placeOrder'
                else:
                    body = h.payment_body(c.placed,quote); path='/pay/v1/payments'
                    if record.get('payment_order_id') != c.placed.order_id:
                        return False
            else:
                return False
        expected = hashlib.sha256(path.encode()+b'\0'+h._json(body)).hexdigest()
        return record.get('request_sha256') == expected

    def prepare(self, *, verticals_key):
        c = self.checkout
        c.create_cart(self.store,self.items,verticals_key=verticals_key)
        if getattr(c.cart, 'below_minimum', False):
            # The Mov campaign minimum is enforced server-side only at placeOrder
            # (a generic 400). Refuse during review so the basket is fixed first.
            journal.fail('CART_BELOW_MINIMUM_ORDER_VALUE')
        c.payment_config()
        self.expected_prepare = h.prepare_body(self.store,c.home,features=c.config['supportedFeatures'])
        initial = c.prepare(selected=False)
        c.payment_config(initial.amount_minor)
        selection = h.select_payment(c.config,c.card)
        instructions = json.loads(initial.response)['checkout']['deliveryInstructions']
        self.expected_prepare = h.prepare_body(self.store,c.home,selection=selection,
            features=c.config['supportedFeatures'],instructions=instructions)
        final = c.prepare(selected=True,quiet_from=initial)
        review = h.project_quote(final)
        if (review['payable_minor'] <= 0
                or review['currency'] != 'AED' or review['card_last4'] != '5542'
                or review['quiet_selected'] is not True
                or any(review[k] is not False for k in ('tip','subscription','wallet','save_preferences'))):
            journal.fail('OWNER_TEST_SCOPE_OR_BUDGET_FAILED')
        self.approved = review
        return review

    def purchase(self):
        if self.approved is None:
            journal.fail('EXACT_REVIEW_REQUIRED')
        if self.allow_duplicate_of is not None:
            self.verify_duplicate_override(self._fresh())
        placed = self.checkout.submit_place(approved_amount_minor=self.approved['payable_minor'],
            approved_quote_digest=self.approved['quote_digest'],allow_duplicate=self.allow_duplicate_of is not None)
        if placed.state != 'PAYMENT_PENDING':
            result = {'state':placed.state,'reason':placed.reason,'flow_id':self.flow_id}
            if placed.state == 'REJECTED_DUPLICATE':
                from commerce_talabat_duplicate import close_duplicate
                try:
                    result['duplicate_closure'] = close_duplicate(self.flow_id,auth=self.auth,wait_for_history=True)
                    result['account_fence_lifted'] = True
                except Exception as exc:
                    from commerce_reconcile import _safe_read_error
                    result.update(account_fence_lifted=False,closure_error=_safe_read_error(exc))
            return result
        result = self.checkout.submit_payment()
        if self.checkout.payment_poller is not None:
            result = self.checkout.poll_payment()
        return {'state':result.state,'reason':result.reason,'flow_id':self.flow_id}


def release_failed_preparation(flow_id):
    """Review bound immutable receipts before releasing a legacy quote fence.

    Also closes a process-loss window after the failed receipt was persisted
    but before the atomic journal transition. Never calls the merchant.
    """
    import commerce_receipts as receipts
    binding = journal.binding(flow_id)
    local = journal.inspect(flow_id)
    if (binding['app'] != 'talabat' or local['state'] not in ('ACTIVE', 'FENCED')
            or local['reserved_minor'] != 0 or local['order_id'] is not None):
        journal.fail('RELEASE_TALABAT_PREPARATION_SCOPE_INVALID')
    records = receipts.load(**binding).snapshot().receipts
    ops = local['operations']
    if (len(records) < 2 or [r.operation for r in records] != [o['name'] for o in ops]
            or records[0].operation != 'create_cart' or records[0].state != 'SUCCEEDED'
            or any(r.state != 'SUCCEEDED' for r in records[:-1])
            or records[-1].operation not in receipts.PREPARATION - {'create_cart'}
            or records[-1].state not in ('SUBMISSION_UNKNOWN', 'PREPARATION_FAILED')
            or any(r.order_id or r.transaction_id or r.context for r in records)):
        journal.fail('RELEASE_TALABAT_PREPARATION_EVIDENCE_INVALID')
    evidence = {'flow_id': flow_id, 'binding': binding,
                'receipts': [receipts._wire(r) for r in records]}
    return journal.release_preparation(flow_id, records[-1].operation,
                                       evidence_hash=journal.digest(evidence))


def settle_interrupted_cart(flow_id, *, vertical, branch, items, verticals_key, auth=None, timeout=120):
    """Close the create_cart ambiguity of a flow whose wire send succeeded but
    whose receipt persistence failed (process loss / lock contention).

    Strictly read-only against the wire: one live cart GET proves the exact
    owned contents. The receipt is then persisted (adopting the account-stable
    cart id if a terminal-RELEASED prior flow still holds it), the operation is
    observed, and the flow becomes normally resumable via TalabatFlow(flow_id=).
    """
    if flow_id is None or vertical not in ('shops','mart'):
        journal.fail('SETTLE_SCOPE_INVALID')
    saved_auth = auth or CommerceAuth()
    saved = saved_auth.fresh_before_mutation('talabat',vertical,timeout=25).mutation_account(vertical)
    state = journal.inspect(flow_id)
    if (state['app'] != 'talabat' or state['vertical'] != vertical or state['state'] != 'ACTIVE'
            or state['order_id'] is not None or state['reserved_minor'] != 0
            or [ (x['name'],x['kind'],x['state']) for x in state['operations'] ]
                != [('create_cart','cart','MAY_HAVE_SENT')]):
        journal.fail('SETTLE_NOT_SINGLE_UNOBSERVED_CART')
    binding = journal.binding(flow_id)
    if account_hash(saved) != binding['account_hash']:
        journal.fail('ACCOUNT_CHANGED')
    scope = intent_scope(vertical, branch, items)
    if scope != binding['scope_hash']:
        journal.fail('SETTLE_INTENT_MISMATCH')
    c = h.Checkout(saved, flow_id=flow_id,
        journal=lambda r: journal.fail('SETTLE_SEND_FORBIDDEN'),
        receipt=lambda rec: journal.fail('SETTLE_SEND_FORBIDDEN'),
        fresh_account=lambda: journal.fail('SETTLE_SEND_FORBIDDEN'), timeout=timeout)
    store = c.resolve_grocery(branch, vertical)
    data = c._read('/grocery/v2/cart', params=c._cart_query(store),
        headers=c._grocery_headers(verticals_key))
    try:
        parsed = h.parse_cart(data, store, items)
    except Exception:
        journal.fail('SETTLE_CART_CONTENTS_MISMATCH')
    cart_binding = hashlib.sha256(parsed.cart_id.encode()).hexdigest()
    adopted = set()
    import commerce_receipts
    sink = commerce_receipts.load(**binding)
    owner = journal.cart_owner('talabat', binding['account_hash'], cart_binding)
    if owner is None:
        # Receipts-only prior (no carts row): find terminal never-financial
        # receipts-side holders and adopt from the first one.
        candidates = sorted(set().union(
            sink.holders(parsed.cart_id, exclude_flow=flow_id),
            sink.holders(cart_binding, exclude_flow=flow_id)))
        for candidate in candidates:
            info = journal.inspect(candidate)
            if (info.get('state') == 'RELEASED' and info.get('order_id') is None
                    and not any(x['kind'] in ('payment', 'preauthorize', 'prepay')
                                for x in info.get('operations', []))):
                owner = candidate
                break
    if owner is not None and owner != flow_id:
        journal.adopt_stable_cart(flow_id, owner, cart_binding,
            evidence_hash=journal.digest({'cart_id':parsed.cart_id,
                'prior_flow_id':owner,'items':[(x.item_id,x.quantity) for x in items]}))
        adopted = {parsed.cart_id, cart_binding}
    record = {'flow_id':flow_id,'operation':'create_cart','state':'SUCCEEDED','http_status':200,
              'cart_id':parsed.cart_id,'cart_binding':cart_binding}
    try:
        sink(record, adopted_ids=frozenset(adopted))
    except Exception as exc:
        # Idempotent settle: an identical create_cart receipt may already be
        # durable (e.g. parked by a sidecar replay or a prior interrupted
        # settle). Only the exact already-stored code is tolerable.
        if getattr(exc, 'code', None) != 'RECEIPT_OPERATION_ALREADY_STORED':
            raise
    journal.observe(flow_id, 'create_cart', outcome='RESPONSE_RECEIVED',
        evidence_hash=journal.digest({'operation':'create_cart','state':'SUCCEEDED','reason':None,
            'http_status':200,'order_id':None,'next_index':None,
            'cart_binding':cart_binding,'review_sha256':None}))
    return {'cart_id':parsed.cart_id,'cart_binding':cart_binding,
            'adopted_from':owner if owner != flow_id else None,'state':'SETTLED'}
