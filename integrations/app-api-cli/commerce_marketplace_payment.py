"""Main/Supermall payment continuation; one send, then bounded exact reads."""
import order_card
import json
import math
import os
from pathlib import Path
import subprocess
import time

import commerce_journal as journal
import commerce_receipts as receipts
import noon_marketplace_checkout as market
from noon_auth_lifecycle import NoonAuthLifecycle


def telegram_3ds_notify(order, total_minor):
    key = f'noon-marketplace-3ds-{order}'
    text = f"this is ours: approve noon AED {total_minor / 100:.2f} in ENBD X"
    env = {k: v for k, v in os.environ.items()
           if k not in ('NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_INSPECT')}
    command = [str(Path.home() / '.bun/bin/bun'),
               str(Path.home() / '.local/share/telegram-bridge/src/cli.ts'), 'notify',
               '--source', 'Noon payment', '--severity', 'attention',
               '--text', text, '--key', key]
    try:
        result = subprocess.run(command, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=15)
        queued = result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        queued = False
    # A failed alert must not interrupt reconciliation of an already-sent payment.
    return {'queued': queued, 'key': key}


STALL_SECONDS = 300


def telegram_stall_notify(order, total_minor):
    """Second, separate alert when a sent payment has neither confirmed nor failed in 5 min."""
    key = f'noon-marketplace-stall-{order}'
    text = (f"noon AED {total_minor / 100:.2f} still not confirmed after 5 min. If ENBD X has "
            "a prompt, approve it. No prompt: check noon > Orders before ordering in the app, "
            "this one can still go through.")
    env = {k: v for k, v in os.environ.items()
           if k not in ('NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_INSPECT')}
    command = [str(Path.home() / '.bun/bin/bun'),
               str(Path.home() / '.local/share/telegram-bridge/src/cli.ts'), 'notify',
               '--source', 'Noon payment', '--severity', 'attention',
               '--text', text, '--key', key]
    try:
        queued = subprocess.run(command, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=15).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        queued = False
    return {'queued': queued, 'key': key}


class MarketplacePayment:
    vertical = None

    def prepare_payment(self, cvv=None):
        """Check/load secrets before place; keep the encrypted envelope in RAM."""
        if self.review is None or self.session_response is None:
            journal.fail('MARKETPLACE_REVIEW_REQUIRED')
        session = self.session_response.data
        if session.get('isCvvRequired') is not False and cvv is None:
            journal.fail('MARKETPLACE_CVV_REQUIRED_USE_KEYCHAIN')
        methods = session.get('paymentMethods', [])
        selected = [card for method in methods if method.get('code') == 'cc_noonpay'
                    and method.get('status') == 'active' for card in method.get('cards', [])
                    if card.get('isDefault') is True and card.get('isSelected') is True
                    and str(card.get('mask', '')).endswith(order_card.LAST4)]
        if len(selected) != 1:
            journal.fail('MARKETPLACE_SAVED_CARD_MISMATCH')
        self.payment_card_token = market._id(selected[0].get('id'))
        self.cvv_encryption = None
        if cvv is not None:
            from noon_cvv import encrypt
            self.cvv_encryption = encrypt(self.client.call('payment_config').data, cvv)

    def _financial_operation(self):
        operations = journal.inspect(self.flow_id)['operations']
        return next((o['name'] for o in operations if o['kind'] == 'payment'), 'place')

    def _payment_observation(self, outcome, response):
        journal.observe(self.flow_id, self._financial_operation(), outcome=outcome,
                        evidence_hash=response.digest, order_id=self.order)

    def _payment_fail(self, code, **kind):
        journal.payment_fail(self.vertical.upper() + code, flow_id=self.flow_id, order=self.order,
                             amount_minor=self.review['payable_minor'], **kind)

    def await_success(self, *, attempts=300, sleep=time.sleep, timeout=25,
                      wait_seconds=600, clock=time.monotonic, notify=telegram_3ds_notify,
                      stall_notify=telegram_stall_notify):
        if not math.isfinite(wait_seconds) or not 0 < wait_seconds <= 600:
            journal.fail('MARKETPLACE_PAYMENT_WAIT_INVALID')
        if self.order is None:
            journal.fail('MARKETPLACE_ORDER_REQUIRED')
        if notify is None:
            stall_notify = None  # --no-notify silences both alerts
        start = clock()
        end = start + wait_seconds
        alerts = {}

        def alert(phase, send):
            # One queued alert per phase; a failed send retries with backoff, at most 6 times.
            sent = alerts.setdefault(phase, {'queued': False, 'attempts': 0, 'next': 0})
            if sent['queued'] or send is None or sent['attempts'] >= 6 or clock() < sent['next']:
                return
            sent['attempts'] += 1
            result = send(self.order, self.review['payable_minor'])
            sent['queued'] = result.get('queued') is True
            sent['next'] = clock() + min(30, 2 ** sent['attempts'])
            print(json.dumps({'phase': phase, 'notify': result}), flush=True)

        last = None
        # The payment itself reported failed (the order can lag behind it). A resumed wait
        # (await-payment) keeps what the run before the restart already saw.
        declined = getattr(self, '_recovery_only', False) and journal.payment_declined(self.flow_id)
        confirmed = False  # the bank approved it; only the order confirmation is outstanding

        def stalled():
            # Neither confirmed nor failed for 5 minutes: he hears it, with the safe fallback.
            # Checked after each read, so a read that settles the payment never alerts.
            if not declined and not confirmed and clock() - start >= STALL_SECONDS:
                alert('payment_stalled', stall_notify)

        for _ in range(attempts):
            if clock() >= end:
                break
            response = self.client.call('order_status', order=self.order,
                                        timeout=min(timeout, end - clock()))
            data = response.data
            status = data.get('status')
            if status != last:
                last = status
                print(json.dumps({'phase': 'order_status_poll', 'order': self.order,
                                  'status': response.summary()['raw_status']}), flush=True)
            if data.get('paymentError') or data.get('paymentErrorMsg') or status in ('failed', 'cancelled'):
                self._payment_observation('PAYMENT_FAILED', response)
                # A decline alone isn't no-charge proof. Attempt native disposition;
                # otherwise keep a visible failed fence for later reconcile-order.
                from commerce_marketplace_disposition import reconcile
                try:
                    closed = reconcile(self.flow_id, client=self.client)
                    print(json.dumps({'phase': 'payment_failed', **closed}), flush=True)
                except Exception:
                    closed = {}
                    print(json.dumps({'phase': 'payment_failed', 'flow_id': self.flow_id,
                                      'disposition': 'retain_fence_and_reservation'}), flush=True)
                self._payment_fail('_PAYMENT_ERROR_NO_RETRY',
                                   proven=closed.get('provider_no_charge_proven') is True)
            if status == 'success':
                if (not isinstance(data.get('shipments'), list) or not data['shipments']
                        or market.fils(data.get('total')) != self.review['payable_minor']):
                    journal.fail(self.vertical.upper() + '_SUCCESS_READBACK_MISMATCH')
                self._payment_observation('PAYMENT_REPORTED_SUCCESS', response)
                if journal.inspect(self.flow_id)['state'] == 'FENCED':
                    journal.reconcile_marketplace_paid(self.flow_id, evidence_hash=response.digest)
                return {'paid': True, 'status': 'success', 'total': data['total'],
                        'signal': 'success_with_shipments'}
            secret = data.get('clientSecret')
            payment = None
            if status == 'pending' and secret and clock() < end:
                if data.get('total') is not None and market.fils(data['total']) != self.review['payable_minor']:
                    journal.fail('MARKETPLACE_PENDING_AMOUNT_MISMATCH')
                consumed = self._financial_operation() != 'place'
                if not consumed and not getattr(self, '_recovery_only', False):
                    if not getattr(self, 'payment_card_token', None):
                        journal.fail('MARKETPLACE_PAYMENT_SETUP_REQUIRED')
                    args = {'order': self.order, 'client_secret': secret,
                            'card_token': self.payment_card_token}
                    if self.cvv_encryption is not None:
                        args['cvv_encryption'] = self.cvv_encryption
                    self._expect('payment_complete', **args)
                    try:
                        payment = self.client.call('payment_complete', **args,
                                                   timeout=min(timeout, end - clock()))
                    except market.MarketplaceError as exc:
                        if not exc.may_have_sent:
                            raise
                        # Never resend an ambiguous completion, even across restart.
                    finally:
                        self.cvv_encryption = None
                else:
                    payment = self.client.call('payment_status', order=self.order,
                        client_secret=secret, timeout=min(timeout, end - clock()))
            if payment is not None:
                summary = payment.summary()
                state = summary['state']
                if state in ('failed', 'cancelled'):
                    self._payment_observation('PAYMENT_FAILED', payment)
                    # Order cancellation/refund propagation can lag payment status.
                    declined = True
                challenge = state in ('pending', 'challenge_required') or summary['has_redirect']
                if state == 'payment_confirmed':
                    confirmed = True
                elif challenge:
                    confirmed = False  # a fresh challenge outranks an earlier approval
                if not (declined or confirmed) and challenge:
                    alert('owner_3ds_notified', notify)
            elif (not declined and not confirmed and status == 'pending' and not secret
                  and (self._financial_operation() != 'place'
                       or data.get('statusMessage') == 'Payment pending'
                       or data.get('redirect_url'))):
                alert('owner_3ds_notified', notify)
            stalled()
            sleep(max(0, min(2, end - clock())))
        stalled()  # a window or poll budget that ends at 5 minutes still alerts once
        journal.observe(self.flow_id, self._financial_operation(), outcome='UNKNOWN',
                        evidence_hash=journal.digest({'order': self.order, 'payment_wait_elapsed': True}),
                        order_id=self.order)
        self._payment_fail('_PAYMENT_WINDOW_ELAPSED_NO_RETRY',
                           outcome='declined' if declined else 'confirming' if confirmed else 'waiting')

    def confirm_paid(self):
        if not journal.payment_reported(self.flow_id):
            journal.fail('MARKETPLACE_PAYMENT_NOT_CONFIRMED')
        return {'paid': True}

    @classmethod
    def resume_payment(cls, flow_id, *, auth=None, request=market.native_request):
        """Reconstruct only exact read/tracker context. No new financial operation."""
        binding, local = journal.binding(flow_id), journal.inspect(flow_id)
        if (binding['app'] != 'noon' or binding['vertical'] != cls.vertical
                or local['state'] not in ('ACTIVE', 'FENCED') or not local['order_id']):
            journal.fail('MARKETPLACE_PENDING_FLOW_REQUIRED')
        store = receipts.load(**binding)
        placed = [r for r in store.snapshot().receipts if r.operation == 'place'
                  and r.order_id == local['order_id']]
        if len(placed) != 1 or placed[0].payable_minor != local['reserved_minor']:
            journal.fail('EXACT_PLACE_RECEIPT_REQUIRED')
        self = object.__new__(cls)
        self.auth = auth or NoonAuthLifecycle()
        self.snapshot = self._snapshot()
        self.account_hash, self.address_hash = self.snapshot.account_ref, self.snapshot.address_ref
        if self.account_hash != binding['account_hash']:
            journal.fail('RECOVERY_ACCOUNT_CHANGED')
        self.flow_id, self.order = flow_id, local['order_id']
        self._recovery_only = True
        self.opened = True
        self.expected = self.current_operation = None
        self.pending_cookies = []
        self.receipt_store = store
        self.review = {'payable_minor': placed[0].payable_minor, 'digest': placed[0].review_sha256}
        self.client = market.MarketplaceClient('main', header_provider=self._headers,
            response_cookies=self._cookies, request=request)
        return self
