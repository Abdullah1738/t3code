"""Bank-evidenced disposition of automatic Food captures; no financial sender."""
import datetime as dt
import json
import re
import subprocess
from decimal import Decimal
from pathlib import Path

import commerce_journal as j

BANK_FIELDS = frozenset({'source', 'source_id', 'sender', 'timestamp', 'amount_minor',
                         'card_last4', 'merchant', 'evidence'})
TRACKING_FIELDS = frozenset({'ok', 'app', 'service', 'order', 'source', 'status', 'raw_status',
                             'scope', 'identity_verified', 'account_verified', 'saved_home_verified',
                             'automatic_payment'})
AUTOMATIC_FIELDS = frozenset({'order', 'account_hash', 'scope_hash', 'amount_minor', 'card_hash',
                              'payment_client_secret_null', 'automatic_capture', 'processed_at'})


def require(ok, suffix):
    if not ok:
        j.fail('FOOD_CAPTURE_CLOSE_' + suffix)


def valid_processed_at(value):
    if type(value) is not str or re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d', value) is None:
        return False
    try:
        # Python 3.15 normalizes 24:00:00 to the next day; evidence must retain
        # the exact native calendar value rather than accepting normalization.
        return dt.datetime.fromisoformat(value).isoformat(timespec='seconds') == value
    except ValueError:
        return False


def parse_purchase(text):
    require(type(text) is str, 'BANK_TEXT_INVALID')
    # Keep just the purchase sentence; available credit is unrelated private data.
    match = re.match(r'Purchase of AED ([0-9]+(?:,[0-9]{3})*\.[0-9]{2}) with Credit Card ending '
                     r'([0-9]{4}) at ([^\n.]+)\.', text, re.I)
    require(match is not None, 'BANK_TEXT_INVALID')
    return {'amount_minor': int(Decimal(match[1].replace(',', '')) * 100),
            'card_last4': match[2], 'merchant': match[3], 'evidence': match[0]}


def bank_message(message_id, placed_at):
    require(type(message_id) is int and message_id > 0, 'BANK_SOURCE_INVALID')
    day = dt.datetime.fromtimestamp(placed_at, dt.timezone(dt.timedelta(hours=4))).date()
    # show has no JSON mode. Search supplies original sender/id/epoch; its
    # highlighted snippet can be the sender, so read the exact message for text.
    command = [str(Path.home()/'.local/bin/msgs'), 'search', 'in:imessage',
               '--from', 'EmiratesNBD', '--since', str(day), '--until', str(day + dt.timedelta(days=2)),
               '--json', '-n', '100']
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20, check=True)
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    except (OSError, ValueError, subprocess.SubprocessError):
        j.fail('FOOD_CAPTURE_CLOSE_BANK_READ_FAILED')
    matches = [r for r in rows if type(r) is dict and r.get('id') == message_id]
    require(len(matches) == 1, 'BANK_MESSAGE_NOT_FOUND')
    row = matches[0]
    require(row.get('source') == 'imessage' and row.get('from_me') == 0
            and row.get('deleted_at') is None, 'BANK_SOURCE_INVALID')
    require(type(row.get('sender')) is str, 'BANK_SENDER_INVALID')
    try:
        shown = subprocess.run([command[0], 'show', str(message_id), '-n', '0'],
                               capture_output=True, text=True, timeout=20, check=True)
    except (OSError, subprocess.SubprocessError):
        j.fail('FOOD_CAPTURE_CLOSE_BANK_READ_FAILED')
    lines = re.findall(r'^>\s+' + str(message_id) + r' \d{4}-\d\d-\d\d \d\d:\d\d '
                       + re.escape(row['sender']) + r': ([^\n]+)$', shown.stdout, re.M)
    require(len(lines) == 1, 'BANK_TEXT_INVALID')
    return {'source': 'msgs', 'source_id': message_id, 'sender': row.get('sender'),
            'timestamp': row.get('ts'), **parse_purchase(lines[0])}


def validate_bank(bank, amount, placed_at):
    require(type(bank) is dict and bank.keys() == BANK_FIELDS, 'BANK_SCHEMA_INVALID')
    require(bank.get('source') == 'msgs'
            and type(bank.get('source_id')) is int and bank['source_id'] > 0, 'BANK_SOURCE_INVALID')
    require(type(bank.get('sender')) is str
            and re.fullmatch(r'emirates\s*nbd', bank['sender'].strip(), re.I) is not None, 'BANK_SENDER_INVALID')
    parsed = parse_purchase(bank.get('evidence'))
    require(all(bank.get(k) == v for k, v in parsed.items()), 'BANK_TEXT_MISMATCH')
    require(type(bank.get('amount_minor')) is int and bank['amount_minor'] == amount, 'AMOUNT_MISMATCH')
    require(bank.get('card_last4') == '2342', 'CARD_MISMATCH')
    require(re.fullmatch(r'noon(?:,\s*dubai)?', bank['merchant'].strip(), re.I) is not None,
            'MERCHANT_MISMATCH')
    require(type(bank.get('timestamp')) is int and 0 < bank['timestamp'] - placed_at <= 1800,
            'BANK_TIME_INVALID')
    try:
        j.validate_owner_attestation(evidence=bank['evidence'], attested_by='owner')
    except j.JournalError:
        j.fail('FOOD_CAPTURE_CLOSE_BANK_TEXT_INVALID')


def automatic_order(flow_id, order):
    """Exact detail stays readable after the original checkout session expires."""
    import commerce_food as food
    import noon_food_recovery as recovery
    import noon_vertical_reads as vertical
    import noon_http_orders as core
    state = json.loads((j.ROOT/'food'/(flow_id+'.json')).read_text())
    # This bank parser only accepts EmiratesNBD 2342. Never attach its receipt
    # to an automatic order prepared with another supported card.
    require((state.get('review') or {}).get('card_last4') == '2342', 'CARD_MISMATCH')
    rows = [{'item_code': r['itemCode'], 'qty': r['qty'], 'modifiers': r['modifiers'], 'notes': r['notes']}
            for r in state['items']]
    flow = food.FoodFlow(state['outlet'], rows, flow_id, read_only=True)
    data = vertical._food_data(vertical._read('food_detail', flow.headers, core.operation_deadline(15), order))
    row = recovery.project_order(data, order, flow, state)
    require('paymentClientSecret' in data and data['paymentClientSecret'] is None
            and (data.get('miscInfo') or {}).get('isPaymentAutoCapture') is True
            and valid_processed_at(data.get('paymentProcessedAt'))
            and all(type(data.get(k)) in (int, float) and data[k] == 0
                    for k in ('orderRefundToWallet', 'orderIssuedCredit', 'orderAdjustments'))
            and data.get('failedErrorMsg') is None and row['accepted'], 'AUTOMATIC_PATH_REQUIRED')
    return {'order': order, 'account_hash': flow.account, 'scope_hash': flow.scope,
            'amount_minor': row['amount_minor'], 'card_hash': row['card_hash'],
            'payment_client_secret_null': True, 'automatic_capture': True,
            'processed_at': data['paymentProcessedAt']}


def close(args, track_exact):
    local = j.inspect(args.flow_id)
    require(local['app'] == 'noon' and local['vertical'] == 'food', 'FOOD_FLOW_REQUIRED')
    require(local['order_id'] is not None, 'ORDER_MISMATCH')
    bank = bank_message(args.bank_msg_id, j.food_capture_placed_at(args.flow_id))
    raw = track_exact('noon', 'food', local['order_id'])
    # Observation time changes on every read; the immutable audit binds the
    # exact delivered result and automatic payment projection instead.
    tracking = {k: raw.get(k) for k in ('ok', 'app', 'service', 'order', 'source', 'status', 'raw_status',
                                      'scope', 'identity_verified', 'account_verified', 'saved_home_verified')}
    tracking['automatic_payment'] = automatic_order(args.flow_id, local['order_id'])
    kwargs = dict(order_id=local['order_id'], reserved_minor=local['reserved_minor'],
                  bank_evidence=bank, tracking_evidence=tracking, attested_by=args.attested_by)
    preview = j.preview_food_automatic_captured(args.flow_id, **kwargs)
    if not args.confirm:
        return {'ok': True, 'dry_run': True, **preview, 'bank_evidence': bank,
                'tracking_evidence': tracking, 'confirm_required': True, 'financial_send': False,
                'next': f'commerce close-food-captured {args.flow_id} --bank-msg-id {args.bank_msg_id} --confirm'}
    return {'ok': True, 'flow_id': args.flow_id, **j.close_food_automatic_captured(args.flow_id, **kwargs),
            'financial_send': False}
