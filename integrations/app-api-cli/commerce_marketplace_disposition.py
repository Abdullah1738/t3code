"""Exact native cancellation + non-capture proof for marketplace orders."""
import order_card
import time

import commerce_journal as journal
import commerce_receipts as receipts
import noon_marketplace_checkout as market

NO_CAPTURE = "Your payment was not captured by noon, so you won't be charged."
# A 3DS/approval timeout (31 Oct) reports status failed with this message and
# paymentError/paymentErrorMsg null; the refund proof below still applies.
PAYMENT_TIMED_OUT = 'Payment timed out'


def failed_evidence(status, detail, refund, order, amount):
    def require(ok):
        if not ok:
            journal.fail('MARKETPLACE_NO_CHARGE_UNPROVEN')

    require(status.get('status') == 'failed'
            and (bool(status.get('paymentError')) or bool(status.get('paymentErrorMsg'))
                 or status.get('statusMessage') == PAYMENT_TIMED_OUT))
    require(detail.get('orderNr') == order and detail.get('paymentMethodCode') == 'cc_noonpay')
    groups = detail.get('itemGroups')
    require(isinstance(groups, list) and bool(groups))
    item_ids = []
    for group in groups:
        require(group.get('orderNr') == order
                and group.get('subStatus', {}).get('highStatusCode') == 'cancelled')
        items = group.get('items')
        require(isinstance(items, list) and bool(items))
        for item in items:
            item_id = item.get('itemNr')
            require(isinstance(item_id, str) and item_id.startswith(order + '-'))
            item_ids.append(item_id)
    require(len(item_ids) == len(set(item_ids)))
    sections = refund.get('sections', {})
    payment = sections.get('paymentDetails', {})
    require(market.fils(payment.get('amount')) == amount
            and market.fils(payment.get('triggeredAmount')) == amount
            and market.fils(payment.get('pendingDetails', {}).get('amount')) == 0
            and market.fils(payment.get('nonRefundableDetails', {}).get('amount')) == 0)
    methods = payment.get('paymentMethods')
    require(isinstance(methods, list) and len(methods) == 1
            and methods[0].get('code') == 'mastercard'
            and methods[0].get('title') == f'MASTERCARD xxxx{order_card.LAST4}'
            and market.fils(methods[0].get('amount')) == amount)
    for name in ('completedRefunds', 'triggeredRefunds'):
        block = sections.get(name, {})
        mediums = block.get('refundMediums')
        require(isinstance(mediums, list) and len(mediums) == 1)
        medium = mediums[0]
        require(medium.get('code') == 'mastercard'
                and medium.get('title') == f'Processed to xxxx{order_card.LAST4}'
                and market.fils(medium.get('amount')) == amount
                and isinstance(medium.get('description'), str)
                and medium['description'].startswith(NO_CAPTURE + ' '))
        breakup = block.get('refundBreakup', {})
        require(market.fils(breakup.get('totalAmount')) == amount)
        rows = breakup.get('items')
        require(isinstance(rows, list) and sorted(r.get('itemNr', '') for r in rows) == sorted(item_ids))
        fees = breakup.get('feeGroups')
        require(isinstance(fees, list)
                and sum(market.fils(r.get('amount')) for r in rows + fees) == amount)
    return {'order': order, 'currency': 'AED', 'amount_minor': amount,
            'all_items_cancelled': True, 'payment_failed': True, 'card_last4': order_card.LAST4,
            'provider_no_charge_proven': True, 'refund_pending_minor': 0,
            'non_capture_statement': NO_CAPTURE,
            'response_hashes': [journal.digest(x) for x in (status, detail, refund)]}


def reconcile(flow_id, *, auth=None, client=None):
    binding, local = journal.binding(flow_id), journal.inspect(flow_id)
    if (binding['app'] != 'noon' or binding['vertical'] not in ('main', 'supermall')
            or local['state'] not in ('ACTIVE', 'FENCED') or not local['order_id']):
        journal.fail('MARKETPLACE_FAILED_FLOW_REQUIRED')
    store = receipts.load(**binding)
    snapshot = store.snapshot()
    placed = [r for r in snapshot.receipts if r.operation == 'place' and r.order_id == local['order_id']]
    if (len(placed) != 1 or placed[0].currency != 'AED'
            or placed[0].payable_minor != local['reserved_minor']
            or any(r.state == 'PAYMENT_REPORTED_SUCCESS' for r in snapshot.receipts)):
        journal.fail('EXACT_PLACE_RECEIPT_REQUIRED')
    if client is None:
        from commerce_main_order import MainOrderFlow
        from commerce_supermall_order import SupermallOrderFlow
        cls = MainOrderFlow if binding['vertical'] == 'main' else SupermallOrderFlow
        client = cls.resume_payment(flow_id, auth=auth).client
    order = local['order_id']
    status = client.call('order_status', order=order).data
    detail = client.call('order_detail', order=order).data
    refund = client.call('order_refund', order=order).data
    evidence = failed_evidence(status, detail, refund, order, local['reserved_minor'])
    evidence.update(checked_at=time.time(), account_hash=binding['account_hash'])
    with store.locked_snapshot() as current:
        if current.receipts != snapshot.receipts:
            journal.fail('MARKETPLACE_RECEIPTS_CHANGED')
        closed = journal.close_marketplace_uncharged(flow_id, evidence=evidence, expected_local=local)
    return {'ok': True, 'flow_id': flow_id, 'order': order, **closed,
            'provider_no_charge_proven': True, 'financial_send': False, 'financial_retry': False}
