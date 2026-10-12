"""Exact native saved-card controller context; no basket token echo is assumed."""
from dataclasses import dataclass,field
import copy
import hashlib
import time

from noon_checkout import fingerprint
from noon_nownow_checkout import SavedCard, payment_payload
from noon_minutes_checkout import _json


class ControllerError(ValueError):
    pass


def require(ok,code):
    if not ok:raise ControllerError(code)


@dataclass(frozen=True,repr=False)
class CardSyncBinding:
    account_ref:str
    address_ref:str
    session_ref:str
    card_ref:str
    request_hash:str
    response_hash:str
    observed_at:float


def bind_card_sync(*, account_home, session_code, card, request_hash, receipt, response, observed_at):
    """Called only after the real durable edit-payment receipt is acknowledged.

    Native selection owns card.id; f129874 passes instrumentToContext to onSync,
    f129857 forwards that card to editPayment. Server basket need not echo token.
    """
    require(type(card) is SavedCard,'SAVED_CARD_REQUIRED');card.validate()
    expected=hashlib.sha256(_json(payment_payload(session_code,card))).hexdigest()
    require(request_hash==expected,'CARD_SYNC_REQUEST_MISMATCH')
    require(type(receipt) is dict and receipt.get('service')=='nownow'
        and receipt.get('operation')=='payment' and receipt.get('request_sha256')==expected
        and receipt.get('outcome')=='RESPONSE_RECEIVED' and receipt.get('http_status')==200,
        'CARD_SYNC_RECEIPT_REQUIRED')
    row=response.get('data') if type(response) is dict else None
    require(type(row) is dict and row.get('checkoutSessionCode')==session_code
        and row.get('paymentMethodCode')=='prepaid' and row.get('creditCardMask')==card.mask
        and row.get('orderWalletAmount')==0,'CARD_SYNC_RESPONSE_MISMATCH')
    misc=row.get('prepaidPaymentMisc')
    require(type(misc) is dict and misc.get('prepaidPaymentMethodCode')=='cc_noonpay',
            'CARD_SYNC_RESPONSE_MISMATCH')
    return CardSyncBinding(account_home.account_ref,account_home.address_ref,fingerprint(session_code),
        fingerprint(card.token),expected,receipt['evidence_hash'],observed_at)


def check_card_binding(binding,*,account_home,session_code,card,now):
    require(type(binding) is CardSyncBinding,'DURABLE_CARD_SYNC_REQUIRED')
    require(0<=now-binding.observed_at<=120,'CARD_SYNC_STALE')
    require((binding.account_ref,binding.address_ref,binding.session_ref,binding.card_ref)==
        (account_home.account_ref,account_home.address_ref,fingerprint(session_code),fingerprint(card.token)),
        'CARD_SYNC_BINDING_MISMATCH')
    return binding.card_ref


def selected_instrument(card_row):
    """f129879 @328..377: kind/cardId/creditCardMask/card/cvv local selection."""
    require(type(card_row) is dict,'CARD_RECORD_REQUIRED')
    card=SavedCard(card_row.get('id'),card_row.get('ccMasked'),card_row.get('ccType'))
    card.validate()
    require(card_row.get('isDeleted') is False,'DELETED_CARD')
    return {'kind':'card','cardId':str(card.token),'creditCardMask':card.mask,
            'card':copy.deepcopy(card_row),'cvv':None}


def finalize_input(instrument, *, wallet_enabled=False, wallet_amount=0):
    """f39853 instrumentToContext exact 5-key object used by onSync/onFinalize.

    This is local callback input. It is not an extra place-order HTTP body.
    """
    require(type(instrument) is dict and instrument.get('kind')=='card','SAVED_CARD_SELECTION_REQUIRED')
    row=instrument.get('card');expected=selected_instrument(row)
    require(instrument.get('cardId')==expected['cardId'] and instrument.get('creditCardMask')==expected['creditCardMask'],
            'SELECTED_CARD_ID_MISMATCH')
    require(wallet_enabled is False and type(wallet_amount) is int and wallet_amount==0,'WALLET_NOT_AUTHORIZED')
    return {'paymentMethod':'cc_noonpay','walletEnabled':False,'walletAmount':0,
            'card':copy.deepcopy(row),'applePayHashedTransactionId':None}


def source_flags(basket):
    """f39849 readSourceFields: subscription required only for added Noon One."""
    require(type(basket) is dict,'BASKET_REQUIRED')
    vip=basket.get('vipSingleCheckoutInfo') or {}
    misc=basket.get('prepaidPaymentMisc') or {}
    cvv=misc.get('isCvvRequired',False);device=basket.get('isVerifyDeviceRequired',False)
    require(type(cvv) is bool and type(device) is bool,'PAYMENT_FLAGS_INVALID')
    return {'isCvvRequired':cvv,'isVerifyDeviceRequired':device,
            'requiresCardSubscription':vip.get('isAddedToCart') is True and basket.get('hasPaymentSubscription') is not True,
            'isNoonOneInCart':vip.get('isAddedToCart') is True}
