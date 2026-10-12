"""Pure NowNow review and current native-controller continuation decisions.

No transport, credentials, journal mutation or financial request construction.
Inputs are private RAM data; the frozen review contains opaque bindings only.
"""
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math

from noon_checkout import AccountHome, fingerprint
from noon_nownow_checkout import SavedCard, Snapshot, QUIET_NOTE


class ReviewError(ValueError):
    def __init__(self, code, field):
        self.code, self.field = code, field
        super().__init__(code + ':' + field)


def check(ok, code, field):
    if not ok:
        raise ReviewError(code, field)


def required(row, key, path='data'):
    check(type(row) is dict and key in row, 'UNSUPPORTED_FIELD', path + '.' + key)
    return row[key]


def money(value, path):
    check(type(value) in (int, float, Decimal), 'INVALID_AMOUNT', path)
    try:
        amount = Decimal(str(value)) * 100
        check(amount.is_finite() and amount == amount.to_integral_value(),
              'INVALID_AMOUNT', path)
        return int(amount)
    except (InvalidOperation, ValueError):
        raise ReviewError('INVALID_AMOUNT', path) from None


def fresh(observed_at, now, field):
    check(type(observed_at) in (int, float) and type(now) in (int, float)
          and math.isfinite(observed_at) and math.isfinite(now)
          and 0 <= now - observed_at <= 60, 'STALE_OBSERVATION', field)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


FINANCIAL_FIELDS = (
    'orderSubtotal', 'orderSubtotalDiscounted', 'orderDiscount',
    'orderDiscountChannel', 'orderDiscountStore', 'orderDiscountInventory',
    'orderRiderTip', 'orderDeliveryFee', 'orderHandlingFee', 'orderServiceFee',
    'orderSmallOrderFee', 'orderCashFee', 'cartTotal', 'orderTotal',
    'orderWalletAmount', 'orderPaymentAmount',
)


def manifest(products):
    check(type(products) is list and 0 < len(products),
          'INVALID_MANIFEST', 'products')
    out, seen = [], set()
    for p in products:
        code = required(p, 'productCode', 'products')
        check(type(code) is str and bool(code) and code not in seen,
              'DUPLICATE_OR_INVALID_PRODUCT', 'products.productCode')
        seen.add(code)
        qty = money(required(p, 'qty', 'products'), 'products.qty')
        check(qty > 0 and qty % 100 == 0, 'INVALID_QUANTITY', 'products.qty')
        groups = required(p, 'modifiers', 'products')
        check(type(groups) is list, 'UNSUPPORTED_FIELD', 'products.modifiers')
        mods = {}
        for group in groups:
            group_code = required(group, 'modifierCode', 'products.modifiers')
            check(type(group_code) is str and group_code and group_code not in mods,
                  'INVALID_MODIFIER', 'products.modifiers.modifierCode')
            options = required(group, 'modifierOptionList', 'products.modifiers')
            check(type(options) is list, 'UNSUPPORTED_FIELD', 'products.modifiers.modifierOptionList')
            selected = []
            for option in options:
                chosen = required(option, 'isSelected', 'products.modifiers.modifierOptionList')
                check(type(chosen) is bool, 'INVALID_MODIFIER', 'products.modifiers.isSelected')
                if chosen:
                    opt = required(option, 'modifierOptionCode', 'products.modifiers')
                    check(type(opt) is str and opt and opt not in selected,
                          'INVALID_MODIFIER', 'products.modifiers.modifierOptionCode')
                    selected.append(opt)
            mods[group_code] = sorted(selected)
        out.append({'productCode': code, 'qty': qty // 100,
                    'modifiers': {k: v for k, v in sorted(mods.items()) if v},
                    'notes': required(p, 'notes', 'products')})
    return sorted(out, key=lambda p: p['productCode'])


@dataclass(frozen=True)
class FrozenReview:
    digest: str
    payable_minor: int
    observed_at: float
    account_ref: str
    address_ref: str
    session_ref: str
    frozen_json: str


def review_snapshot(snapshot, *, account_home, session_code, store_code,
                    address_code, address_key, address_version, expected_manifest,
                    expected_financials_minor, expected_price_breakdown, card, now, card_binding=None):
    """Expected manifest uses productCode/qty/modifiers-map/notes (local schema).

    All FINANCIAL_FIELDS must be explicitly reviewed in minor units, as must the
    entire native priceBreakdown. Selected token is bound by acknowledged native
    edit-payment context, never inferred from creditCardMask.
    """
    check(isinstance(snapshot, Snapshot), 'INVALID_SNAPSHOT', 'snapshot')
    fresh(snapshot.observed_at, now, 'snapshot.observed_at')
    check(isinstance(account_home, AccountHome) and account_home.service == 'nownow',
          'ACCOUNT_REQUIRED', 'account_home')
    fresh(account_home.checked_at, now, 'account_home.checked_at')
    check(isinstance(card, SavedCard), 'CARD_REQUIRED', 'card')
    card.validate()
    row = required(snapshot.wire, 'data', 'response')
    check(snapshot.wire.get('status') in (None, 'success') and not snapshot.wire.get('error'),
          'APPLICATION_REJECTED', 'response')
    for key, expected in [('checkoutSessionCode', session_code), ('storeCode', store_code),
                          ('addressCode', address_code), ('addressVersion', address_version)]:
        check(required(row, key) == expected, 'BINDING_MISMATCH', 'data.' + key)
    check(required(required(row, 'storeInfo'), 'storeCode', 'data.storeInfo') == store_code,
          'BINDING_MISMATCH', 'data.storeInfo.storeCode')
    check(account_home.address_ref == fingerprint(address_code, address_key),
          'HOME_2104_BINDING_MISMATCH', 'data.addressCode')
    check(account_home.account_ref == fingerprint(required(row, 'customerCode')),
          'ACCOUNT_MISMATCH', 'data.customerCode')
    actual = manifest(required(row, 'products'))
    check(actual == sorted(expected_manifest, key=lambda p: p['productCode']),
          'MANIFEST_MISMATCH', 'data.products')
    check(required(row, 'totalQuantity') == sum(p['qty'] for p in actual),
          'EXTRA_QUANTITY', 'data.totalQuantity')
    check(required(row, 'currencyCode').upper() == 'AED', 'CURRENCY_MISMATCH', 'data.currencyCode')
    check(type(expected_financials_minor) is dict and set(expected_financials_minor) == set(FINANCIAL_FIELDS)
          and all(type(v) is int for v in expected_financials_minor.values()),
          'EXACT_FINANCIAL_REVIEW_REQUIRED', 'expected_financials_minor')
    amounts = {k: money(required(row, k), 'data.' + k) for k in FINANCIAL_FIELDS}
    for k in FINANCIAL_FIELDS:
        check(amounts[k] == expected_financials_minor[k], 'FINANCIAL_MISMATCH', 'data.' + k)
    check(all(value>=0 for value in amounts.values()),'INVALID_AMOUNT','data.financials')
    check(amounts['orderRiderTip']==0,'UNAPPROVED_TIP','data.orderRiderTip')
    check(all(amounts[k]==0 for k in ('orderDiscount','orderDiscountChannel','orderDiscountStore',
                                    'orderDiscountInventory','orderCashFee')),
          'UNSUPPORTED_DISCOUNT_OR_CASH','data.financials')
    lines=sum(money(required(p,'totalPrice','products'),'products.totalPrice') for p in row['products'])
    check(lines==amounts['orderSubtotal']==amounts['orderSubtotalDiscounted'],
          'SUBTOTAL_MISMATCH','data.orderSubtotal')
    fees=sum(amounts[k] for k in ('orderDeliveryFee','orderHandlingFee','orderServiceFee','orderSmallOrderFee'))
    check(amounts['orderTotal']==lines+fees,'FEE_ARITHMETIC_MISMATCH','data.orderTotal')
    check(amounts['orderWalletAmount'] == 0, 'WALLET_NOT_ZERO', 'data.orderWalletAmount')
    check(amounts['orderPaymentAmount'] == amounts['orderTotal'] > 0,
          'PAYABLE_MISMATCH', 'data.orderPaymentAmount')
    check(required(row, 'hasPackageFee') is False, 'UNSUPPORTED_PACKAGE_FEE', 'data.hasPackageFee')
    check(required(required(row, 'vipSingleCheckoutInfo'), 'isAddedToCart', 'data.vipSingleCheckoutInfo') is False,
          'EXTRA_MEMBERSHIP', 'data.vipSingleCheckoutInfo.isAddedToCart')
    breakdown = required(row, 'priceBreakdown')
    check(type(breakdown) is list and breakdown and breakdown == expected_price_breakdown,
          'FEE_BREAKDOWN_MISMATCH', 'data.priceBreakdown')
    check(required(row, 'paymentMethodCode') == 'prepaid', 'PAYMENT_METHOD_MISMATCH', 'data.paymentMethodCode')
    misc = required(row, 'prepaidPaymentMisc')
    check(required(misc, 'prepaidPaymentMethodCode', 'data.prepaidPaymentMisc') == 'cc_noonpay',
          'PAYMENT_METHOD_MISMATCH', 'data.prepaidPaymentMisc.prepaidPaymentMethodCode')
    check(required(row, 'creditCardMask') == card.mask, 'CARD_MISMATCH', 'data.creditCardMask')
    # Current controller owns card.id and syncs it through edit-payment. The
    # native basket does not promise a token echo. A real acknowledged sync
    # binding is mandatory; mask equality is only a separate readback check.
    from noon_nownow_controller import check_card_binding, ControllerError
    try:
        check_card_binding(card_binding,account_home=account_home,session_code=session_code,card=card,now=now)
    except ControllerError as exc:
        raise ReviewError(str(exc),'controller.card_sync') from None
    if 'paymentToken' in row:
        check(row['paymentToken']==card.token,'CARD_TOKEN_MISMATCH','data.paymentToken')
    prefs = required(row, 'deliveryPreference')
    check(type(prefs) is dict and all(type(v) is bool or v is None for v in prefs.values()),
          'UNSUPPORTED_FIELD', 'data.deliveryPreference')
    for code in ('dont_ring_the_bell', 'leave_it_at_my_door'):
        check(required(prefs, code, 'data.deliveryPreference') is True,
              'QUIET_PREFERENCE_MISMATCH', 'data.deliveryPreference.' + code)
    check(required(row, 'driverNotes') == QUIET_NOTE, 'QUIET_NOTE_MISMATCH', 'data.driverNotes')
    check(required(row, 'checkoutWarningPopup') is None, 'VALIDATION_WARNING', 'data.checkoutWarningPopup')
    payload = {'session_ref': fingerprint(session_code), 'store_ref': fingerprint(store_code),
               'account_ref': account_home.account_ref, 'address_ref': account_home.address_ref,
               'address_version': address_version, 'manifest': actual, 'amounts': amounts,
               'priceBreakdown': breakdown, 'card_ref': fingerprint(card.token),
               'preferences': prefs, 'driverNotes': QUIET_NOTE,
               'hasPaymentSubscription': required(row, 'hasPaymentSubscription'),
               'isCvvRequired': required(misc, 'isCvvRequired', 'data.prepaidPaymentMisc'),
               'isVerifyDeviceRequired': required(row, 'isVerifyDeviceRequired')}
    for key in ('hasPaymentSubscription', 'isCvvRequired', 'isVerifyDeviceRequired'):
        check(type(payload[key]) is bool, 'UNSUPPORTED_FIELD', 'data.' + key)
    encoded = canonical(payload)
    return FrozenReview(hashlib.sha256(encoded.encode()).hexdigest(), amounts['orderPaymentAmount'],
                        snapshot.observed_at, account_home.account_ref, account_home.address_ref,
                        fingerprint(session_code), encoded)


def require_same_review(frozen, current, *, now):
    check(isinstance(frozen, FrozenReview) and isinstance(current, FrozenReview), 'INVALID_REVIEW', 'review')
    for review in (frozen, current):
        fresh(review.observed_at, now, 'review.observed_at')
        check(hashlib.sha256(review.frozen_json.encode()).hexdigest() == review.digest,
              'REVIEW_TAMPERED', 'review.digest')
        payload = json.loads(review.frozen_json)
        check(review.payable_minor == payload['amounts']['orderPaymentAmount']
              and review.account_ref == payload['account_ref']
              and review.address_ref == payload['address_ref']
              and review.session_ref == payload['session_ref'],
              'REVIEW_TAMPERED', 'review.bindings')
    check(frozen.digest == current.digest, 'REVIEW_CHANGED', 'review.digest')
    return frozen.digest


def continuation_decision(review, controller, *, now, validation=None):
    """Local observation envelope + native controller fields; never a wire body.

    Envelope: observed_at, review_digest. Native fields: status, selection,
    wallet, orderPaymentAmount, requiresCardSubscription, isCvvRequired.
    validation is the fresh onValidate basket return, with a local review_digest
    attached after reviewing it again. No automatic finalize after subscription.
    """
    require_same_review(review, review, now=now)
    fresh(required(controller, 'observed_at', 'controller'), now, 'controller.observed_at')
    check(required(controller, 'review_digest', 'controller') == review.digest,
          'STALE_PAYMENT_CONTROLLER', 'controller.review_digest')
    p = json.loads(review.frozen_json)
    check(money(required(controller, 'orderPaymentAmount', 'controller'), 'controller.orderPaymentAmount')
          == review.payable_minor, 'STALE_PAYMENT_CONTROLLER', 'controller.orderPaymentAmount')
    selection = required(controller, 'selection', 'controller')
    check(required(selection, 'kind', 'controller.selection') == 'card',
          'PAYMENT_SELECTION_REQUIRED', 'controller.selection.kind')
    check(fingerprint(required(selection, 'cardId', 'controller.selection')) == p['card_ref'],
          'CARD_TOKEN_MISMATCH', 'controller.selection.cardId')
    check(required(required(controller, 'wallet', 'controller'), 'enabled', 'controller.wallet') is False,
          'WALLET_NOT_ZERO', 'controller.wallet.enabled')
    status = required(controller, 'status', 'controller')
    result = {'state': None, 'required_fields': [], 'review_digest': review.digest,
              'financial_send_allowed': False, 'resend_allowed': False}
    if status != 'idle':
        result.update(state='controller_' + str(status), required_fields=['exact operation journal outcome'])
        return result
    if validation is None:
        result.update(state='validate_basket_required', callback='onValidate', callback_args=[],
                      native_call='validateBasket(true)', required_fields=['fresh validated basket', 'review_digest'])
        return result
    check(required(validation, 'review_digest', 'validation') == review.digest,
          'STALE_PAYMENT_CONTROLLER', 'validation.review_digest')
    fresh(required(validation, 'observed_at', 'validation'), now, 'validation.observed_at')
    if required(validation, 'checkoutWarningPopup', 'validation') is not None:
        result.update(state='validation_warning', required_fields=['checkoutWarningPopup'])
        return result
    if p['isVerifyDeviceRequired']:
        result.update(state='device_verification_required', required_fields=['paymentConfig.is_device_verified'])
        return result
    subscription = required(controller, 'requiresCardSubscription', 'controller')
    cvv = required(controller, 'isCvvRequired', 'controller')
    check(type(subscription) is bool and type(cvv) is bool, 'UNSUPPORTED_FIELD', 'controller.payment_flags')
    check(cvv == p['isCvvRequired'], 'STALE_PAYMENT_CONTROLLER', 'controller.isCvvRequired')
    # No membership is in the accepted review. Native readSourceFields makes
    # requiresCardSubscription false in this branch, independent of token echo.
    check(subscription is False,'STALE_PAYMENT_CONTROLLER','controller.requiresCardSubscription')
    if subscription or cvv:
        result.update(state='preorder_subscription_required', native_call='useNNPayment.createSubscription(undefined)',
                      required_fields=['addressCode', 'addressVersion', 'paymentToken',
                                       'clientSecret', 'cvvEncryption.encCvv', 'cvvEncryption.publicKeyName',
                                       'idCustomerToken', 'onPaymentComplete', 'fresh validated basket'])
    else:
        result.update(state='finalize_candidate', callback='onFinalize', native_call='placeOrder()',
                      required_fields=['paymentMethod', 'walletEnabled', 'fresh exact review', 'durable send reservation'])
    return result


def finalize_result(result):
    """f129858 consumes {order, session}; success here never certifies payment."""
    if not isinstance(result, dict):
        return {'kind': 'failure', 'state': 'reconcile_required', 'resend_allowed': False}
    order, session = result.get('order'), result.get('session')
    if isinstance(order, dict) and order.get('orderNr'):
        return {'kind': 'success', 'state': 'exact_order_readback_required',
                'order': order['orderNr'], 'resend_allowed': False}
    if isinstance(session, dict) and session.get('checkoutWarningPopup'):
        return {'kind': 'warning', 'state': 'reconcile_required', 'resend_allowed': False}
    return {'kind': 'failure', 'state': 'reconcile_required', 'resend_allowed': False}
