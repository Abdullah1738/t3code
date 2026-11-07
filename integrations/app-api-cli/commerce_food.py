"""Journalled Food preparation. Financial transport stays closed pending proof."""
import json
import os
import re
import time
import uuid
import urllib.request
from decimal import Decimal
from pathlib import Path

import commerce_journal as journal
import native
import noon_http_orders as core
import noon_vertical_reads as vertical
from noon_checkout import project_home, QUIET_NOTE

ROOT = Path.home()/'.local/state/app-api-cli/commerce/food'
PREFIX = 'https://api-app-fd.noon.com/_svc/mp-food-api-mpnoon/session/'
QUIET = {'leavedoor': True, 'dontring': True, 'avoidcalling': True}
ROUTES = {'create': {'menuCode','menuVersion','outletCode','addressCode','addressKey','items','deliveryType','scheduleAt'},
          'details': {'sessionCode'}, 'set-delivery-preference': {'sessionCode','deliveryPreference'},
          'add-notes': {'sessionCode','driverNotes'},
          'add-item': {'sessionCode','itemCode','qty','modifiers','notes'},
          'set-payment-method': {'sessionCode','walletAmount','creditCardMask','paymentMethod','prepaidPaymentMethod','paymentTokenCode'}}


def require(ok, code):
    if not ok:
        journal.fail(code)


def money(value):
    require(type(value) in (int, float, str), 'FOOD_AMOUNT_INVALID')
    try:
        number = Decimal(str(value))*100
        require(number.is_finite() and number >= 0 and number == number.to_integral_value(), 'FOOD_AMOUNT_INVALID')
        return int(number)
    except Exception:
        journal.fail('FOOD_AMOUNT_INVALID')


def manifest(rows):
    require(isinstance(rows, list) and bool(rows), 'FOOD_MANIFEST_INVALID')
    result = []
    for row in rows:
        require(isinstance(row, dict) and set(row) <= {'item_code','qty','modifiers','notes'}, 'FOOD_MANIFEST_INVALID')
        code, qty = row.get('item_code'), row.get('qty', 1)
        require(isinstance(code, str) and re.fullmatch(r'I[A-Z0-9]+', code) and type(qty) is int and qty > 0, 'FOOD_MANIFEST_INVALID')
        note, mods = row.get('notes'), row.get('modifiers', {})
        require(note is None or isinstance(note, str) and 0 < len(note) <= 500 and all(ord(c)>=32 for c in note), 'FOOD_NOTE_INVALID')
        require(isinstance(mods, dict), 'FOOD_MODIFIERS_INVALID')
        for group, options in mods.items():
            require(isinstance(group, str) and re.fullmatch(r'MD[A-Z0-9]+', group) and isinstance(options, dict), 'FOOD_MODIFIERS_INVALID')
            for option, count in options.items():
                require(isinstance(option, str) and re.fullmatch(r'I[A-Z0-9]+', option) and type(count) is int and count > 0, 'FOOD_MODIFIERS_INVALID')
        result.append({'itemCode': code, 'qty': qty, 'modifiers': mods, 'notes': note})
    require(len({journal.digest({k:v for k,v in r.items() if k!='qty'}) for r in result}) == len(result), 'FOOD_DUPLICATE_LINE')
    return result


def validate_choices(rows, items):
    by_id = {i['id']: i for i in items}
    for row in rows:
        item = by_id.get(row['itemCode'])
        require(item and item['available'], 'FOOD_ITEM_UNAVAILABLE')
        total_qty=sum(r['qty'] for r in rows if r['itemCode']==row['itemCode'])
        require(type(item.get('max_quantity')) is int and total_qty <= item['max_quantity'], 'FOOD_QUANTITY_UNSUPPORTED')
        require(not row['notes'] or item.get('note_type') not in (None, 'none'), 'FOOD_NOTES_UNSUPPORTED')
        visited = set()
        def groups(groups):
            for group in groups:
                code = group['id']; visited.add(code)
                selected = row['modifiers'].get(code, {})
                require(group['available'] and type(group['min']) is int and type(group['max']) is int and
                        group['min'] <= sum(selected.values()) <= group['max'], 'FOOD_REQUIRED_CHOICES_INVALID')
                options = {o['id']: o for o in group['options']}
                for option, qty in selected.items():
                    require(option in options and options[option]['available'] and
                            type(group['max_per_option']) is int and qty <= group['max_per_option'], 'FOOD_CHOICE_INVALID')
                    groups_nested = options[option]['groups']
                    visit(groups_nested)
        visit = groups
        visit(item['choice_groups'])
        require(set(row['modifiers']) <= visited, 'FOOD_UNKNOWN_CHOICE_GROUP')


def request(operation, headers, body):
    require(operation in ROUTES and set(body) == ROUTES[operation], 'FOOD_ENDPOINT_DENIED')
    h = dict(headers)
    h.update({'content-type':'application/json', 'accept-encoding':'identity'})
    req = urllib.request.Request(PREFIX+operation, headers=h, data=json.dumps(body).encode(), method='POST')
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), core.NoRedirect()).open(req, timeout=20) as response:
            raw = response.read(core.MAX_BYTES+1)
        require(len(raw) <= core.MAX_BYTES, 'FOOD_RESPONSE_TOO_LARGE')
        data = json.loads(raw)
        require(data.get('status') == 'success' and isinstance(data.get('data'), dict), 'FOOD_RESPONSE_UNVERIFIED')
        return data['data']
    except journal.JournalError:
        raise
    except Exception:
        journal.fail('FOOD_REQUEST_OUTCOME_UNVERIFIED_NO_RETRY')


class FoodFlow:
    def __init__(self, outlet, rows, flow_id=None, *, read_only=False):
        require(isinstance(outlet, str) and re.fullmatch(r'[A-Z0-9]{5,64}', outlet), 'FOOD_OUTLET_INVALID')
        self.outlet, self.rows = outlet, manifest(rows)
        self.read_only=read_only
        self.headers = vertical._headers('food', core.operation_deadline(15))
        who = core.request('whoami', self.headers, core.operation_deadline(15))
        self.home = project_home(who, self.headers, 'main', checked_at=time.time())
        self.account = self.home.account_ref
        self.scope = journal.digest({'outlet':outlet, 'items':self.rows, 'home':self.home.address_ref, 'card':'2342','quiet':QUIET_NOTE})
        self.flow_id = flow_id or str(uuid.uuid4())
        ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = ROOT/(self.flow_id+'.json')
        self.state = {}
        if flow_id:
            binding = journal.binding(flow_id)
            local = journal.inspect(flow_id)
            if not read_only:
                require(local['state']=='ACTIVE' and not local['order_id'] and
                        not any(o['kind'] in ('place','payment','prepay','preauthorize') for o in local['operations']), 'FOOD_PREPARATION_ONLY_FLOW_REQUIRED')
            require(binding['vertical']=='food' and binding['account_hash']==self.account and binding['scope_hash']==self.scope, 'FOOD_RECOVERY_SCOPE_MISMATCH')
            self.state = json.loads(self.path.read_text())
            require(self.state['scope']==self.scope, 'FOOD_RECOVERY_SCOPE_MISMATCH')
            require(read_only or time.time()-self.state['created_at']<86400, 'FOOD_PREPARATION_EXPIRED')
        if not read_only:journal.require_account_available('noon', self.account, flow_id=flow_id)

    def save(self):
        temp = self.path.with_suffix('.tmp')
        fd = os.open(temp, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(self.state, stream); stream.flush(); os.fsync(stream.fileno())
        temp.replace(self.path)

    def write(self, operation, body, *, name=None):
        require(not self.read_only, 'FOOD_RECOVERY_READ_ONLY')
        fresh = vertical._headers('food', core.operation_deadline(15))
        who = core.request('whoami', fresh, core.operation_deadline(15))
        home = project_home(who, fresh, 'main', checked_at=time.time())
        require(home.account_ref==self.account and home.address_ref==self.home.address_ref, 'FOOD_ACCOUNT_HOME_CHANGED')
        self.headers = fresh
        journal.require_account_available('noon', self.account, flow_id=self.flow_id)
        name = name or operation.replace('-', '_')
        kind='selection' if operation=='set-payment-method' else 'cart' if operation in ('create','add-item') else 'instructions'
        journal.consume(self.flow_id, name, kind=kind, request_hash=journal.digest(body))
        data = request(operation, self.headers, body)
        journal.observe(self.flow_id, name, outcome='RESPONSE_RECEIVED', evidence_hash=journal.digest(data))
        return data

    def read(self):
        return request('details', self.headers, {'sessionCode':self.state['session']})

    def review(self, data, *, quiet=True):
        require(data.get('checkoutSessionCode')==self.state['session'] and not data.get('orderNr'), 'FOOD_SESSION_ALREADY_ORDERED_OR_CHANGED')
        require(data.get('outletCode')==self.outlet and data.get('addressCode')==self.headers['x-addresscode'], 'FOOD_CART_HOME_OR_OUTLET_CHANGED')
        require(self.headers['x-addresskey'] == str(data.get('addressCode'))+'-'+str(data.get('addressVersion')), 'FOOD_CART_ADDRESS_VERSION_CHANGED')
        lines = data.get('items')
        require(isinstance(lines,list), 'FOOD_CART_ITEMS_INVALID')
        actual = [{'itemCode':r.get('itemCode'),'qty':r.get('qty'),'modifiers':r.get('modifiers') or {},'notes':r.get('notes') or None} for r in lines]
        require(sorted(map(journal.digest,actual))==sorted(map(journal.digest,self.rows)), 'FOOD_CART_MANIFEST_CHANGED')
        prefs = {p.get('code'):p.get('value') for p in data.get('deliveryPreferenceInfo',[]) if isinstance(p,dict)}
        if quiet:
            require(all(prefs.get(k) is True for k in QUIET) and data.get('driverNotes')==QUIET_NOTE, 'FOOD_QUIET_NOT_VERIFIED')
        last4 = str(data.get('creditCardMask') or '')[-4:]
        if quiet:
            require(last4=='2342' and data.get('paymentMethodCode')=='prepaid'
                    and data.get('prepaidPaymentMethodCode')=='cc_noonpay', 'FOOD_CARD_2342_REQUIRED')
            require(money(data.get('orderWalletAmount'))==0 and
                    money(data.get('orderPaymentAmount'))==money(data.get('orderTotal')), 'FOOD_PAYMENT_AMOUNT_CHANGED')
        review = {'outlet':self.outlet,'items':self.rows,'home_verified':True,'card_last4':last4,
                  'quiet':{k:prefs.get(k) for k in QUIET},'driver_note':data.get('driverNotes'),
                  'currency':'AED','payable_minor':money(data.get('orderTotal')),
                  'financial_send':False}
        review['amounts_minor']={k:money(data[k]) for k in ('orderSubtotal','orderSubtotalDiscounted',
            'orderDeliveryFee','orderSmallOrderFee','orderServiceFee','orderRiderTip','orderDonationAmount') if data.get(k) is not None}
        return review

    def prepare(self):
        info, items = native.food_menu_raw(self.outlet, self.headers, 15)
        require(info['status']=='open' and info['serviceable'] is True, 'FOOD_OUTLET_UNAVAILABLE')
        validate_choices(self.rows, items)
        if not self.state:
            orders = vertical.food_orders(timeout=15)['orders']
            require(all(o['raw_status'] in ('delivered','cancelled','canceled','failed','rejected') for o in orders), 'FOOD_ACTIVE_OR_UNKNOWN_ORDER')
            journal.open_flow(flow_id=self.flow_id, app='noon', vertical='food', account_hash=self.account, scope_hash=self.scope)
            self.state = {'scope':self.scope,'outlet':self.outlet,'items':self.rows,'created_at':time.time()}
            self.save()
            print(json.dumps({'flow_id':self.flow_id,'phase':'creating','financial_send':False}),flush=True)
            data = self.write('create', {'menuCode':info['menu_code'],'menuVersion':info['menu_version'],
                'outletCode':self.outlet,'addressCode':self.headers['x-addresscode'],'addressKey':self.headers['x-addresskey'],
                'items':self.rows,'deliveryType':'default','scheduleAt':None})
            session = data.get('checkoutSessionCode')
            require(isinstance(session,str) and re.fullmatch(r'[A-Za-z0-9_-]{5,100}',session), 'FOOD_SESSION_UNVERIFIED_NO_RETRY')
            self.state['session']=session; self.save()
        require('session' in self.state, 'FOOD_CREATE_OUTCOME_UNVERIFIED_NO_RETRY')
        data = self.read()
        operations = {o['name']:o for o in journal.inspect(self.flow_id)['operations']}
        require(all(o['state']=='OBSERVED' for o in operations.values()), 'FOOD_PREVIOUS_SEND_UNOBSERVED')
        self.review(data,quiet=False)
        prefs = {p.get('code') for p in data.get('deliveryPreferenceInfo',[]) if isinstance(p,dict)}
        require(set(QUIET)<=prefs, 'FOOD_QUIET_CODES_UNAVAILABLE')
        operations = {o['name'] for o in journal.inspect(self.flow_id)['operations']}
        if 'set_delivery_preference' not in operations:
            self.write('set-delivery-preference', {'sessionCode':self.state['session'],'deliveryPreference':QUIET})
        if 'add_notes' not in operations:
            self.write('add-notes', {'sessionCode':self.state['session'],'driverNotes':QUIET_NOTE})
        if 'set_payment_method' not in operations:
            import noon_nownow_checkout as cards
            response=cards.native_request('payment_cards',self.headers,core.operation_deadline(15),None,
                                          response_observer=lambda *a,**k:None)
            matches=[r for r in response.get('data',[]) if isinstance(r.get('ccMasked'),str)
                     and r['ccMasked'].endswith('2342') and r.get('isDeleted') is False]
            require(len(matches)==1 and str(matches[0].get('id','')).isdigit(), 'FOOD_CARD_2342_NOT_UNIQUE')
            card=matches[0]
            self.state['card_hash']=journal.digest(str(card['id'])); self.save()
            self.write('set-payment-method', {'sessionCode':self.state['session'],'walletAmount':0,
                       'creditCardMask':card['ccMasked'],'paymentMethod':'prepaid',
                       'prepaidPaymentMethod':'cc_noonpay','paymentTokenCode':str(card['id'])})
        review = self.review(self.read())
        review['store']=info['name']
        names={i['id']:i['name'] for i in items}
        review['display_items']=[{'name':names[r['itemCode']],'qty':r['qty']} for r in self.rows]
        self.state['review_hash']=journal.digest(review); self.state['review']=review; self.save()
        return {'ok':True,'state':'PREPARED_NOT_ORDERED','flow_id':self.flow_id,'review':review,
                'financial_send':False,'purchase_enabled':False,'cleanup':'Leave this isolated session; no owner basket was reset or cleared.'}


def prepare(args):
    require(args.prepare_only, 'FOOD_PAID_TRANSPORT_NOT_YET_VERIFIED')
    raw=json.loads(Path(args.items_file).read_text())
    rows=raw.get('items') if isinstance(raw,dict) else raw
    return FoodFlow(args.outlet_code, rows, args.resume_flow).prepare()


def recover(flow_id):
    """Status-only recovery never turns an interrupted preparation into a send."""
    binding=journal.binding(flow_id); local=journal.inspect(flow_id)
    require(binding['app']=='noon' and binding['vertical']=='food', 'FOOD_FLOW_REQUIRED')
    if any(o['kind'] in ('place','payment') for o in local['operations']):
        from noon_food_financial import Coordinator
        from noon_food_recovery import NativeReader, TrackerRegistrar
        reader=NativeReader(flow_id)
        return Coordinator(flow_id,reader,TrackerRegistrar(reader)).recover()
    state=json.loads((ROOT/(flow_id+'.json')).read_text())
    rows=[{'item_code':r['itemCode'],'qty':r['qty'],'modifiers':r['modifiers'],'notes':r['notes']} for r in state['items']]
    flow=FoodFlow(state['outlet'],rows,flow_id,read_only=True)
    require('session' in state, 'FOOD_CREATE_OUTCOME_UNVERIFIED_NO_RETRY')
    data=flow.read()
    require(data.get('checkoutSessionCode')==state['session'], 'FOOD_SESSION_CHANGED')
    return {'ok':True,'flow_id':flow_id,'state':'NOT_ORDERED' if not data.get('orderNr') else 'EXTERNAL_ORDER_OBSERVED',
            'order':data.get('orderNr'),'financial_send':False,'financial_retry':False,
            'review':flow.review(data,quiet=bool(state.get('review'))) if not data.get('orderNr') else None,
            'purchase_enabled':False}
