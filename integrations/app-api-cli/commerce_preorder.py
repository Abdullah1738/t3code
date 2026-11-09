"""NowNow pre-order intent binding. Secrets stay in Keychain, hashes in journal."""
import copy
import hashlib

import commerce_journal as journal
from noon_auth_lifecycle import KeychainStorage


class IntentVault:
    def __init__(self,storage=None):
        self.storage=storage or KeychainStorage()

    def retain(self,flow_id,*,secret,review_hash,cart_hash,card_hash,payable_minor):
        journal._flow(flow_id)
        if type(secret) is not str or not 0<len(secret)<=2000 or any(ord(c)<32 for c in secret):journal.fail('PREORDER_INTENT_INVALID')
        for value in (review_hash,cart_hash,card_hash):
            if not journal._hash(value):journal.fail('PREORDER_BINDING_INVALID')
        if type(payable_minor) is not int or not 0<payable_minor<=journal.MAX_SQLITE_INTEGER:
            journal.fail('PREORDER_AMOUNT_INVALID')
        row={'flow_id':flow_id,'secret':secret,'intent_hash':hashlib.sha256(secret.encode()).hexdigest(),
             'review_hash':review_hash,'cart_hash':cart_hash,'card_hash':card_hash,'payable_minor':payable_minor}
        name='commerce-preorder-'+flow_id
        if self.storage.load(name):journal.fail('PREORDER_INTENT_ALREADY_RETAINED')
        self.storage.store(name,copy.deepcopy(row))
        if self.storage.load(name)!=row:journal.fail('PREORDER_INTENT_PERSISTENCE_FAILED')
        return row['intent_hash']

    def load(self,flow_id):
        journal._flow(flow_id)
        row=self.storage.load('commerce-preorder-'+flow_id)
        if (type(row) is not dict or row.get('flow_id')!=flow_id
                or type(row.get('secret')) is not str
                or hashlib.sha256(row['secret'].encode()).hexdigest()!=row.get('intent_hash')):
            journal.fail('PREORDER_INTENT_UNAVAILABLE')
        return copy.deepcopy(row)


def payment_outcome(projection):
    """Native intent status literals; presence of a redirect always needs a human."""
    if projection.get('redirect_required') is True:return 'CHALLENGE_REQUIRED'
    status=projection.get('payment_status')
    if status=='payment_confirmed':return 'PREORDER_PAYMENT_CONFIRMED'
    if status=='payment_pending':return 'RESPONSE_RECEIVED'
    if status=='payment_ready_to_redirect':return 'CHALLENGE_REQUIRED'
    return 'UNKNOWN'


def recover(flow_id, *, auth=None, vault=None, timeout=20):
    """Restart-safe native status POST only; no authorization/complete replay."""
    from commerce_auth_status import CommerceAuth
    from commerce_nownow import reader
    from noon_nownow_checkout import Snapshot
    from noon_minutes_checkout import project_payment
    import time
    binding=journal.binding(flow_id);state=journal.preorder_status(flow_id)
    if binding['app']!='noon' or binding['vertical']!='nownow':journal.fail('PREORDER_SCOPE_INVALID')
    if not any(x['kind']=='prepay' for x in state['operations']):
        journal.fail('PREORDER_COMPLETE_NOT_SENT_NO_AUTOMATIC_CONTINUATION')
    saved=(vault or IntentVault()).load(flow_id)
    if (saved['intent_hash']!=state['intent_hash'] or saved['payable_minor']!=state['reserved_minor']
            or saved['review_hash']!=state['review_hash'] or saved['cart_hash']!=state['cart_hash']):
        journal.fail('PREORDER_BINDING_MISMATCH')
    interrupted=[x for x in state['operations'] if x['kind']=='prepay' and x['state']=='MAY_HAVE_SENT']
    if interrupted:
        # Process loss with an unobserved financial send is itself ambiguous.
        # Later exact status can inform a human but cannot silently reopen place.
        journal.observe(flow_id,interrupted[0]['name'],outcome='UNKNOWN',
            evidence_hash=journal.digest({'reason':'PREORDER_PROCESS_LOSS_AFTER_SEND'}))
        state=journal.preorder_status(flow_id)
    manager=auth or CommerceAuth()
    if state['payment_confirmed']:
        if state['state'] == 'FENCED':
            journal.reconcile_nownow_preorder(flow_id)
        return {'flow_id':flow_id,'payment_status':'payment_confirmed',
                'recovery':'durable_observation','financial_retry':False,'journal_state':state['state']}
    client=reader(auth=manager.noon,expected_account=binding['account_hash'])
    # Native status carries only clientSecret. No fabricated session/order ID is
    # needed; the durable journal+vault supply that local ownership binding.
    result=client._call('payment_status',{'clientSecret':saved['secret']},timeout,
        project=lambda data:Snapshot(data,project_payment(data,None),time.time()))
    op=next(x['name'] for x in state['operations'] if x['kind']=='prepay')
    journal.observe(flow_id,op,outcome=payment_outcome(result.projection),evidence_hash=journal.digest(result.projection))
    if payment_outcome(result.projection) == 'PREORDER_PAYMENT_CONFIRMED':
        journal.reconcile_nownow_preorder(flow_id)
    return {'flow_id':flow_id,**result.projection,'financial_retry':False,
            'journal_state':journal.inspect(flow_id)['state']}
