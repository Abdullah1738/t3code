"""Pure, conservative interpretation of recovered payment/status schemas.

No request builder, status polling, callback execution, authentication or payment
transport. The v2 status body has no identity/amount/card echo: this cannot certify
payment for an order even when it reports 'success'. Raw data stays with caller.
"""
import re

import talabat_place_contract as place


def _payment(state, reason):
    return {'state':state, 'reason':reason, 'retry_allowed':False,
            'request_response_binding_verified':False, 'payment_completion_verified':False,
            'charged_card_verified':False, 'charged_amount_verified':False,
            'settlement_verified':False, 'merchant_acceptance_verified':False,
            'no_charge_verified':False, 'rollback_verified':False,
            'ready_to_order':False, 'commit_enabled':False}


def project_payment_status(http_status, body):
    """Project a supplied /pay/v2/payment/status body, never fetch it.

    Parser 0x1ec8638 has five nullable fields. Native normalizes status through an
    unresolved string operation: only exact recovered literals are recognized here.
    Non-null error/fallback/checkout/redirect are unsupported continuation boundaries
    even if a status claims success; no alternate method or SDK is selected.
    """
    if type(http_status) is not int or http_status != 200 or type(body) is not dict:
        return _payment('PAYMENT_UNKNOWN', 'PAYMENT_STATUS_RESPONSE_UNSUPPORTED')
    for key in ('status', 'redirectUrl', 'hyperPayCheckoutId'):
        if body.get(key) is not None and type(body[key]) is not str:
            return _payment('PAYMENT_UNKNOWN', 'PAYMENT_STATUS_SCHEMA_UNSUPPORTED')
    for key in ('error', 'fallback'):
        if body.get(key) is not None and type(body[key]) is not dict:
            return _payment('PAYMENT_UNKNOWN', 'PAYMENT_STATUS_SCHEMA_UNSUPPORTED')
    status = body.get('status')
    if body.get('fallback') is not None:
        return _payment('PAYMENT_BLOCKED', 'ALTERNATE_PAYMENT_UNSUPPORTED')
    if body.get('redirectUrl') is not None or status == 'redirection':
        return _payment('CHALLENGE_REQUIRED', 'PAYMENT_REDIRECT_UNSUPPORTED')
    if body.get('hyperPayCheckoutId') is not None:
        return _payment('PAYMENT_BLOCKED', 'PAYMENT_SDK_CONTINUATION_UNPROVEN')
    if body.get('error') is not None or status == 'error':
        return _payment('PAYMENT_ERROR_REPORTED', 'NO_ROLLBACK_OR_RETRY_PROOF')
    if status == 'success':
        return _payment('UNBOUND_PAYMENT_SUCCESS', 'TRANSACTION_BINDING_AND_FINANCIAL_RECEIPT_UNPROVEN')
    if status is None or status == 'pending':
        return _payment('PAYMENT_PENDING', 'PAYMENT_COMPLETION_UNPROVEN')
    # Native defaults unknown statuses to pending. We do not accept casing,
    # cancellation/failed aliases, SDK messages or telemetry as terminal proof.
    return _payment('PAYMENT_UNKNOWN', 'PAYMENT_STATUS_LITERAL_UNSUPPORTED')


def project_order_readback(observation, tracking_body):
    """Compare raw tracking identity only with the received place-response ID.

    Identity equality here is local consistency, not proof the caller performed
    an authenticated/fresh GET. Preserve that distinction in every projection.
    A lost place response cannot be filled using a similar history entry.
    """
    place.project_response(observation)  # validates exact class/state/reason
    result = {'order_id_received':False, 'order_identity_matches':False,
              'fulfilment_stage':'unknown', 'fulfilment_progress_reported':False,
              'fresh_server_provenance_verified':False, 'exact_order_readback_verified':False,
              'payment_completion_verified':False, 'settlement_verified':False,
              'charged_card_verified':False, 'charged_amount_verified':False,
              'merchant_acceptance_verified':False, 'retry_allowed':False,
              'ready_to_order':False, 'commit_enabled':False}
    order = observation.order_id
    if type(order) is not str or not re.fullmatch(r'[0-9]{1,20}', order):
        return {**result, 'reason':'NO_RECEIVED_ORDER_ID_FOR_EXACT_READBACK'}
    result['order_id_received'] = True
    if type(tracking_body) is not dict or tracking_body.get('type') != 'OrderTrackingScreen':
        return {**result, 'reason':'ORDER_TRACKING_SCHEMA_UNSUPPORTED'}
    attrs = tracking_body.get('common_tracking_event_attributes')
    if type(attrs) is not dict:
        return {**result, 'reason':'ORDER_TRACKING_SCHEMA_UNSUPPORTED'}
    identity = attrs.get('order_id')
    # Native existing track accepts str(attrs.order_id); exclude bool/float and
    # arbitrary __str__ conversion while preserving actual integer/string forms.
    if (type(identity) not in (str, int) or (type(identity) is int and not 0 <= identity < 10**20)
            or not re.fullmatch(r'[0-9]{1,20}', str(identity))
            or str(identity) != order):
        return {**result, 'reason':'ORDER_IDENTITY_MISMATCH'}
    result['order_identity_matches'] = True
    status = attrs.get('delivery_status')
    if type(status) is not str or not re.fullmatch(r'[a-z_]{1,64}', status):
        return {**result, 'reason':'ORDER_TRACKING_STATUS_UNSUPPORTED'}
    stage = {'order_almostready':'preparing', 'order_delivering':'out for delivery',
             'order_delivered':'delivered'}.get(status)
    if stage is None:
        return {**result, 'reason':'ORDER_PROGRESS_NOT_RECOGNIZED'}
    return {**result, 'fulfilment_stage':stage, 'fulfilment_progress_reported':True,
            'reason':'EXACT_ID_PROGRESS_SUPPLIED_NOT_PAYMENT_PROOF'}


def require_payment_enabled():
    place.q.c._fail('PAYMENT_DISABLED_ROUTING_BINDING_AMOUNT_AND_CHALLENGE_UNPROVEN')
