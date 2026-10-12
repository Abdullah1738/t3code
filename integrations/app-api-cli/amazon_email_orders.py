#!/usr/bin/env python3
"""Read-only Amazon email orders/track CLI; no Amazon HTTP or phone access.

Public seams: parse_message(raw, ...), aggregate_order(order_id, events, ...),
orders(**options), track(order_id, **options). Raw mail lives in memory only.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime as dt
import email
import email.policy
from email.utils import parsedate_to_datetime
import hashlib
from html import unescape
from html.parser import HTMLParser
import json
import os
import re
import subprocess
import time
from urllib.parse import parse_qs, unquote, urlsplit

UTC = dt.timezone.utc
SOURCE = 'amazon_email'
ACCOUNTS = ('icloud', 'gmail', 'fund', 'outlook', 'juno')
# Explicit marketplaces, not a substring match or a general amazon.* wildcard.
DOMAINS = ('amazon.ae', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr',
           'amazon.it', 'amazon.es', 'amazon.ca', 'amazon.com.au', 'amazon.in',
           'amazon.co.jp', 'amazon.sa')
ORDER_PATTERN = r'(?<![A-Za-z0-9_-])\d{3}-\d{7}-\d{7}(?![A-Za-z0-9_-])'
ORDER_RE = re.compile(ORDER_PATTERN)
ORDER_LABEL = re.compile(r'(?im)^\s*Order\s*(?:#|number\s*:?)\s*(' + ORDER_PATTERN + r')\s*$')
URL_RE = re.compile(r'https?://[^\s<>"\]]+')
FORWARD_RE = re.compile(r'(?im)^(?:[- ]*Forwarded message[- ]*|Begin forwarded message:|On .+ wrote:|>\s*From:)')


def iso(value=None):
    return (value or dt.datetime.now(UTC)).astimezone(UTC).isoformat()


def aware(value):
    result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('timestamp_requires_timezone')
    return result.astimezone(UTC)


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:24]


def trusted_domain(domain):
    domain = domain.lower()
    return any(domain == d or domain.endswith('.' + d) for d in DOMAINS)


def sender_domain(value):
    """Modern header parsing handles Amazon's unquoted/comma display names."""
    try:
        msg = email.message_from_string('From: ' + value + '\n\n', policy=email.policy.default)
        addresses = msg['From'].addresses
        if len(addresses) == 1 and addresses[0].username and trusted_domain(addresses[0].domain):
            return addresses[0].domain.lower()
    except (ValueError, TypeError, AttributeError, IndexError):
        pass
    return None


def classify_subject(subject):
    """Only the current subject, never the body's historical progress timeline."""
    s = ' '.join(subject.lower().replace('’', "'").split())
    if re.match(r'^(?:re|fw|fwd)\s*:', s):
        return 'unknown'
    if re.search(r'\b(?:will|would|should|may|might|could|once|when|if|expected to|scheduled to)\b', s):
        return 'unknown'
    if re.search(r'\b(?:not delivered|delivery failed|unable to deliver|could not deliver|delayed)\b', s):
        return 'problem'
    if re.search(r'\b(?:not|never|cannot|can.t|unable|unsuccessful)\b', s):
        return 'unknown'
    if re.match(r'^(?:your )?(?:return received|return complete|return completed|we.ve received your return)\b', s):
        return 'returned'
    if re.match(r'^(?:your )?refund (?:issued|processed|confirmation)\b', s):
        return 'refunded'
    if re.match(r'^(?:your return of|return (?:requested|request|confirmation|label|instructions)|return for order)\b', s):
        return 'return_requested'
    if re.search(r'\b(?:return|refund|cancellation request|cancel request)\b', s):
        return 'unknown'
    if re.match(r'^(?:cancelled|canceled)\s*:', s) or re.search(r'\b(?:order|item|package)(?: .{0,35})? (?:has been |was |is )?(?:cancelled|canceled)\b', s):
        return 'cancelled'
    if (re.fullmatch(r'delivered in \d+ (?:hrs?|hours?)(?: \d+ (?:mins?|minutes?))?[.!]?', s)
            or re.match(r'^delivered\s*[:!\-]', s)
            or re.search(r'\b(?:your (?:order|package)|shipment) (?:has been |was |is )delivered\b', s)):
        return 'delivered'
    if re.match(r'^out for delivery\s*[:!\-]', s) or re.search(r'\b(?:your (?:order|package)|shipment) is out for delivery\b', s):
        return 'out for delivery'
    if re.match(r'^(?:shipped|dispatched)\s*[:!\-]', s) or re.search(r'\b(?:your (?:order|package)|shipment) (?:has been |was )?(?:shipped|dispatched)\b', s):
        return 'shipped'
    if re.match(r'^ordered\s*:', s) or re.match(r'^(?:order confirmation|your amazon\.[a-z.]+ order|thanks for your order|thank you for your order)\b', s):
        return 'confirmed'
    return 'unknown'


class _HTMLText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.links, self.hidden = [], [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'head'):
            self.hidden += 1
        if not self.hidden:
            if tag in ('br', 'div', 'p', 'tr', 'li', 'table'):
                self.parts.append('\n')
            if tag == 'a':
                href = dict(attrs).get('href', '')
                self.links.append(href)
                # Keep links in their order section, but never expose them.
                self.parts.append('\n' + href + '\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'head'):
            self.hidden = max(0, self.hidden - 1)
        elif not self.hidden and tag in ('div', 'p', 'tr', 'li', 'table'):
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def _body(msg):
    # get_body does not enter attached forwarded messages; walk() would.
    part = msg.get_body(preferencelist=('plain', 'html'))
    if part is None or part.get_content_disposition() == 'attachment':
        return ''
    content = part.get_content()
    if part.get_content_type() == 'text/html':
        parser = _HTMLText()
        parser.feed(content)
        content = ''.join(parser.parts)
    content = unescape(content).replace('\r', '').replace('\u00a0', ' ')
    return re.sub(r'[\u200b\u200c\u034f\u00ad]', '', content)


def _links(text):
    """Local-only decoding of Amazon links. Never fetch or emit a private URL."""
    result = []
    for raw in URL_RE.findall(text):
        pending = [(raw, 0)]
        while pending:
            url, depth = pending.pop()
            try:
                parsed = urlsplit(unescape(url))
                if parsed.scheme not in ('https', 'http') or not trusted_domain(parsed.hostname or ''):
                    continue
                qs = {k.lower(): v for k, v in parse_qs(parsed.query).items()}
            except ValueError:
                continue
            ids = {v for v in qs.get('orderid', []) if re.fullmatch(r'\d{3}-\d{7}-\d{7}', v)}
            shipments = {digest(v) for v in qs.get('shipmentid', []) if re.fullmatch(r'[A-Za-z0-9_-]{1,120}', v)}
            if ids or shipments:
                result.append((ids, shipments))
            if depth < 2:
                for nested in qs.get('u', []):
                    pending.append((unquote(nested), depth + 1))
    return result


def _items(section):
    lines = [x.strip() for x in section.splitlines() if x.strip()]
    quantities, valid = Counter(), True
    for i, line in enumerate(lines):
        match = re.fullmatch(r'(?:Quantity|Qty)\s*:\s*(\d+)', line, re.I)
        if not match:
            if re.match(r'(?i)^(?:quantity|qty)\s*:', line):
                valid = False
            continue
        title = lines[i - 1] if i else ''
        count = int(match[1])
        if not title or URL_RE.search(title) or ORDER_RE.search(title) or not 1 <= count <= 1000:
            valid = False
            continue
        # Product names are not needed by the tracker. An opaque stable identity
        # also prevents addresses or mail content from leaking through projection.
        key = digest(' '.join(title.casefold().split()))
        quantities[key] += count
    return quantities, valid


def _item_list(counts):
    return [{'item_key': key, 'quantity': qty} for key, qty in sorted(counts.items())]


def _counts(items):
    return Counter({i['item_key']: i['quantity'] for i in items})


def _manifest_section(section, oid):
    """Recognize the entire item table, not just any parseable Quantity rows."""
    total = re.search(r'(?im)^\s*(?:Order )?Total\s*:?\s*$', section)
    before = section[:total.start()] if total else section
    items, valid = _items(before)
    lines = [x.strip() for x in before.splitlines() if x.strip()]
    price = r'(?:(?:AED|USD|GBP|EUR|SAR|£|\$|€)\s*[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d{1,2})?\s*(?:AED|USD|GBP|EUR|SAR))'
    # Current plain template is: edit label, order link, then complete
    # (product title, quantity, price) triples. Unknown layouts fail closed.
    table = lines[2:]
    shape = (len(lines) >= 5 and lines[0].lower() == 'view or edit order'
             and URL_RE.fullmatch(lines[1]) and any(oid in ids for ids, _ in _links(lines[1]))
             and len(table) % 3 == 0)
    if shape:
        for i in range(0, len(table), 3):
            title, qty, amount = table[i:i + 3]
            if (URL_RE.search(title) or ORDER_RE.search(title)
                    or re.fullmatch(price, title) or re.match(r'(?i)^(?:Quantity|Qty)\s*:', title)
                    or not re.fullmatch(r'(?i)(?:Quantity|Qty)\s*:\s*\d+', qty)
                    or not re.fullmatch(price, amount)):
                shape = False
                break
    tail = section[total.end():] if total else ''
    tail_lines = [x.strip() for x in tail.splitlines() if x.strip()]
    complete = bool(total and valid and items and shape and tail_lines
                    and re.fullmatch(price, tail_lines[0])
                    and not re.search(r'(?im)^\s*(?:Quantity|Qty)\s*:', tail)
                    and not re.search(r'\b(?:some of|remaining|more items|partial order)\b', section, re.I))
    return items, valid, complete


def parse_message(raw, *, account='unknown', folder='unknown', uid=None, observed_at=None):
    """Return safe exact-order events from one RFC822 message, with no I/O.

    From-domain filtering is not a DKIM authenticity claim. Unsupported/malformed,
    forwarded or untrusted messages return no events. Date is never observation time.
    """
    observed_at = observed_at or iso()
    observed = aware(observed_at)
    if isinstance(raw, bytes):
        msg = email.message_from_bytes(raw, policy=email.policy.default)
    else:
        msg = email.message_from_string(raw, policy=email.policy.default)
    if len(msg.get_all('From', [])) != 1 or len(msg.get_all('Subject', [])) != 1:
        return []
    domain = sender_domain(str(msg['From']))
    subject = str(msg['Subject'])
    stage = classify_subject(subject)
    if not domain or stage == 'unknown':
        return []
    text = _body(msg)
    if FORWARD_RE.search(text):
        return []
    warnings = []
    try:
        sent = parsedate_to_datetime(str(msg['Date']))
        if sent.tzinfo is None:
            raise ValueError('naive_date')
        evidence_at = iso(sent)
        if sent > observed + dt.timedelta(minutes=5):
            warnings.append('future_message_date')
            stage = 'unknown'
    except (ValueError, TypeError, OverflowError):
        evidence_at = None
        warnings.append('missing_or_naive_message_date')
    links = _links(text)
    # Do not use arbitrary order-like strings in promotional/footer URLs.
    visible = URL_RE.sub('', text)
    ids = set(ORDER_RE.findall(visible + '\n' + subject))
    ids.update(oid for linked, _ in links for oid in linked)
    if not ids:
        return []
    # Message-ID alone can be reused or malformed. Identical copies still dedupe
    # across mailboxes, but conflicting content must reach the reducer.
    message_key = digest('\n'.join((str(msg.get('Message-ID') or ''), domain,
                                   subject, str(msg.get('Date') or ''), text)))
    labels = list(ORDER_LABEL.finditer(text))
    events = []
    for oid in sorted(ids):
        sections = [text[m.end():labels[i + 1].start() if i + 1 < len(labels) else len(text)]
                    for i, m in enumerate(labels) if m[1] == oid]
        complete = False
        if stage == 'confirmed':
            # Verified current Amazon.ae Ordered template: each Order # block is
            # individually terminated by Total and includes its own edit link.
            # Multiple Order # blocks can represent different orders, NOT packages.
            section = sections[0] if len(sections) == 1 else ''
            items, valid, complete = _manifest_section(section, oid)
            complete = bool(complete and re.search(r'Thanks for your order!|Thank you for your order', text, re.I))
            shipments = set()
            scope = 'order'
        else:
            # Combined delivered notices can have one visible order ID, a link
            # to a second order ID, and items from both orders in one package.
            # Keep all package items; aggregation intersects against each manifest.
            items, valid = _items(text)
            shipments = {sid for _, group in links for sid in group}
            scope = 'shipment' if stage in ('shipped', 'out for delivery', 'delivered', 'problem') else 'item'
        event = {'order_id': oid, 'event_id': digest(message_key + ':' + oid),
                 'stage': stage, 'scope': scope, 'source': SOURCE,
                 'observed_at': iso(observed), 'evidence_at': evidence_at,
                 'evidence_time_source': 'email_date_header' if evidence_at else None,
                 'account': account, 'folder': folder, 'uid': uid, 'sender_domain': domain,
                 'identity': 'exact_order_id_in_email', 'sender_check': 'from_domain_allowlist_not_dkim',
                 'items': _item_list(items), 'items_parse_valid': valid,
                 'shipment_keys': sorted(shipments), 'related_order_ids': sorted(ids),
                 'manifest_complete': complete, 'warnings': warnings.copy()}
        if stage == 'confirmed' and not complete:
            event['warnings'].append('confirmation_manifest_unproven')
        if scope == 'shipment' and len(shipments) != 1:
            event['warnings'].append('shipment_identity_unproven')
        events.append(event)
    return events


def aggregate_order(order_id, events, *, scan_complete=True):
    """Deduplicate snapshots without dropping mailbox aliases or counting twice."""
    if not re.fullmatch(r'\d{3}-\d{7}-\d{7}', order_id):
        raise ValueError('invalid_order_id')
    unique = {}
    for event in events:
        if event['order_id'] == order_id:
            old = unique.get(event['event_id'])
            aliases = set(event.get('mailbox_aliases', []))
            if event.get('account') and event.get('folder') and event.get('uid') is not None:
                aliases.add(f'{event["account"]}:{event["folder"]}:{event["uid"]}')
            if old is not None:
                aliases.update(old['mailbox_aliases'])
            first = event if old is None or event['observed_at'] < old['observed_at'] else old
            # Keep earliest observation and stable content identity, but retain all
            # source copies for callers migrating mailbox-keyed arrival dedupe.
            # Copy, don't mutate: callers may reduce these inputs again.
            unique[event['event_id']] = {**first, 'mailbox_aliases': sorted(aliases)}
    evidence = sorted(unique.values(), key=lambda e: (e['evidence_at'] or '', e['event_id']))
    reliable = [e for e in evidence if e['evidence_at'] and e['stage'] != 'unknown']
    manifests = [e for e in reliable if e['manifest_complete']]
    manifest = _counts(manifests[0]['items']) if manifests else Counter()
    manifest_complete = bool(manifests) and all(_counts(e['items']) == manifest for e in manifests)
    reasons = []
    if not manifest_complete:
        reasons.append('complete_order_manifest_not_established')
    if not scan_complete:
        reasons.append('mail_scan_incomplete')
    if any(e['stage'] == 'confirmed' and not e['manifest_complete'] for e in reliable):
        reasons.append('unresolved_confirmation_manifest')
    if manifests and any(e['scope'] == 'shipment' and e['evidence_at'] < manifests[0]['evidence_at']
                         for e in reliable):
        reasons.append('shipment_predates_order_confirmation')
    shipments = defaultdict(list)
    unbound = []
    for e in reliable:
        if e['scope'] != 'shipment':
            continue
        if e['related_order_ids'] != [order_id]:
            reasons.append('multi_order_shipment_allocation_unproven')
        if len(e['shipment_keys']) == 1 and e['items_parse_valid'] and e['items']:
            shipments[e['shipment_keys'][0]].append(e)
        else:
            unbound.append(e)
    if unbound:
        reasons.append('unresolved_shipment_evidence')
    projected, delivered, assigned = [], Counter(), Counter()
    for key, group in sorted(shipments.items()):
        latest = group[-1]
        if len({e['stage'] for e in group if e['evidence_at'] == latest['evidence_at']}) > 1:
            reasons.append('conflicting_shipment_stages_at_same_time')
        inventory = _counts(latest['items'])
        consistent = all(_counts(e['items']) == inventory for e in group)
        # A combined package may acquire additional items after initial dispatch.
        # That is not safely resolvable without explicit item mapping.
        relevant = Counter({k: v for k, v in inventory.items() if k in manifest})
        if not consistent:
            reasons.append('shipment_contents_changed_or_ambiguous')
        if set(inventory) - set(manifest):
            reasons.append('shipment_contains_unmapped_items')
        if latest['stage'] != 'delivered':
            reasons.append('shipment_not_delivered')
        assigned.update(relevant)
        if latest['stage'] == 'delivered' and consistent:
            delivered.update(relevant)
        projected.append({'shipment_key': key, 'status': latest['stage'],
                          'items': _item_list(inventory), 'evidence_at': latest['evidence_at'],
                          'contents_consistent': consistent})
    if manifest and assigned != manifest:
        reasons.append('shipment_items_do_not_exactly_cover_manifest')
    aftercare = [e for e in reliable if e['stage'] in ('cancelled', 'return_requested', 'returned', 'refunded')]
    if aftercare:
        reasons.append('cancellation_or_return_requires_item_reconciliation')
    # Unknown-date evidence must not silently disappear from closure checks.
    if len(reliable) != len(evidence):
        reasons.append('unusable_evidence_time_or_stage')
    whole = bool(manifest_complete and projected and not reasons and delivered == manifest
                 and all(s['status'] == 'delivered' for s in projected))
    stages = {e['stage'] for e in reliable}
    if whole:
        status = 'delivered'
    elif aftercare:
        latest = aftercare[-1]['stage']
        status = 'partially_cancelled' if latest == 'cancelled' else latest
    elif 'delivered' in stages:
        status = 'partially_delivered'
    elif reliable:
        status = reliable[-1]['stage']
    else:
        status = 'unknown'
    return {'app': 'amazon', 'order_id': order_id, 'source': SOURCE, 'status': status,
            'whole_order_delivered': whole, 'terminal': whole,
            'latest_event': reliable[-1]['stage'] if reliable else 'unknown',
            'manifest': {'complete': manifest_complete, 'items': _item_list(manifest),
                         'source': 'confirmation_email' if manifests else None},
            'shipments': projected, 'evidence': evidence,
            'coverage': {'scan_complete': scan_complete, 'all_items_delivered': whole,
                         'reasons': sorted(set(reasons)),
                         'delivered_package_evidence': 'delivered' in stages}}


def _clean_env():
    return {k: v for k, v in os.environ.items()
            if k not in ('NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_INSPECT', 'BUN_INSPECT_BRK',
                         'BUN_INSPECT_WAIT', 'BUN_INSPECT_CONNECT_TO')}


def _error(code, account=None, folder=None, uid=None):
    return {k: v for k, v in {'code': code, 'account': account, 'folder': folder, 'uid': uid}.items()
            if v is not None}


def _scan(*, order_id=None, since=None, days=30, timeout=75, limit=150, max_reads=60,
          accounts=None, now=None, runner=None):
    """One bounded sender search, then reads only matching account/folder/UIDs.

    Do not rely on Gmail exact-ID fulltext search: live combined-package messages
    omit an order from indexed text although a trusted tracking link contains it.
    """
    runner = runner or subprocess.run
    now = now or dt.datetime.now(UTC)
    if now.tzinfo is None:
        raise ValueError('timestamp_requires_timezone')
    if order_id and not re.fullmatch(r'\d{3}-\d{7}-\d{7}', order_id):
        raise ValueError('invalid_order_id')
    if not (1 <= days <= 366 and 1 <= limit <= 500 and 1 <= max_reads <= 200 and 1 <= timeout <= 300):
        raise ValueError('invalid_scan_bounds')
    requested = list(dict.fromkeys(accounts or ACCOUNTS))
    if any(a not in ACCOUNTS for a in requested):
        raise ValueError('account_not_supported_by_mailsearch')
    since_date = dt.date.fromisoformat(since) if since else (now - dt.timedelta(days=days)).date()
    if since_date > now.date() or (now.date() - since_date).days > 366:
        raise ValueError('since_outside_366_day_bound')
    start = since_date - dt.timedelta(days=1)
    end = now.date() + dt.timedelta(days=2)
    deadline = time.monotonic() + timeout
    query = f'from:amazon after:{start:%Y/%m/%d} before:{end:%Y/%m/%d}'
    search_timeout = min(15, max(0.1, timeout - 2))
    args = ['mailsearch', '--json', '-n', str(limit), '-t', str(search_timeout)]
    for account in requested:
        args.extend(['-a', account])
    errors, evidence, hits = [], [], []
    coverage = {'source': SOURCE, 'email_only': True, 'native_order_api': False,
                'requested_since': since_date.isoformat(), 'search_after': start.isoformat(),
                'search_before': end.isoformat(), 'date_overlap_days': 1,
                'account_scope': 'all_mailsearch_accounts' if set(requested) == set(ACCOUNTS) else 'explicit_accounts',
                'accounts': {}, 'mailboxes': [], 'search_limit_per_folder': limit,
                'max_reads': max_reads, 'overall_deadline_seconds': timeout,
                'read_attempts': 0, 'read_successes': 0, 'candidate_messages': 0,
                'truncated': False, 'complete': False,
                'limitations': ['email_not_live_amazon_state', 'deleted_mail_not_searched',
                                'mailsearch_does_not_enumerate_skipped_folders',
                                'moni_account_not_supported_by_mailsearch',
                                'unrecognized_subjects_not_read', 'from_domain_is_not_dkim_verification']}
    try:
        process = runner(args + [query], capture_output=True, text=True,
                         timeout=min(timeout, search_timeout + 3), env=_clean_env())
        data = json.loads(process.stdout)
        if not isinstance(data, dict) or not isinstance(data.get('hits'), list) or not isinstance(data.get('status'), dict):
            raise ValueError('invalid_search_response')
        for account in requested:
            status = data['status'].get(account, {})
            ok = status.get('ok') is True
            coverage['accounts'][account] = {'ok': ok}
            if not ok:
                reason = str(status.get('error', '')).lower()
                code = 'account_timeout' if 'timeout' in reason else 'account_unavailable'
                errors.append(_error(code, account))
        if process.returncode and not errors:
            errors.append(_error('mailsearch_nonzero_exit'))
        hits = data['hits']
    except subprocess.TimeoutExpired:
        errors.append(_error('search_deadline_exceeded'))
    except (OSError, ValueError, TypeError):
        errors.append(_error('mailsearch_unavailable_or_invalid_response'))
    for account in requested:
        if account not in coverage['accounts']:
            coverage['accounts'][account] = {'ok': False}
            errors.append(_error('account_search_unverified', account))
    mailboxes = defaultdict(list)
    candidates, seen = [], set()
    for hit in hits:
        if not isinstance(hit, dict) or hit.get('account') not in requested:
            errors.append(_error('invalid_search_hit'))
            continue
        account, folder, uid = hit['account'], hit.get('folder'), hit.get('uid')
        if not isinstance(folder, str) or not isinstance(uid, int) or uid <= 0:
            errors.append(_error('invalid_search_hit', account))
            continue
        mailboxes[(account, folder)].append(hit)
        # mailsearch reconstructs From via legacy parseaddr, which corrupts some
        # Amazon return senders into two-address-looking strings. Its envelope
        # is discovery only: trust is checked on the original RFC822 header.
        if classify_subject(hit.get('subject', '')) == 'unknown':
            continue
        key = (account, folder, uid)
        if key in seen:
            continue
        seen.add(key)
        candidates.append(hit)
    for (account, folder), group in sorted(mailboxes.items()):
        total = max((h.get('folder_total', len(group)) for h in group), default=0)
        truncated = total > len(group)
        coverage['truncated'] |= truncated
        coverage['mailboxes'].append({'account': account, 'folder': folder,
                                      'matched': total, 'listed': len(group), 'truncated': truncated})
    # Stable prioritization: target-ID headers first, delivered/confirmation next;
    # other status subjects still read because the body can carry the only ID.
    priority = {'delivered': 0, 'confirmed': 1, 'cancelled': 2, 'returned': 2,
                'return_requested': 2, 'refunded': 2, 'out for delivery': 3, 'shipped': 4}
    candidates.sort(key=lambda h: (0 if order_id and order_id in ORDER_RE.findall(h.get('subject', '')) else 1,
                                   priority.get(classify_subject(h.get('subject', '')), 5)))
    coverage['candidate_messages'] = len(candidates)
    if len(candidates) > max_reads:
        errors.append(_error('read_limit_exceeded'))
    if coverage['truncated']:
        errors.append(_error('search_results_truncated'))

    def read_one(hit):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return [], _error('overall_deadline_exceeded', hit['account']), False
        try:
            p = runner(['mailsearch', 'read', hit['account'], hit['folder'], str(hit['uid']), '--raw'],
                       capture_output=True, text=True, timeout=min(12, remaining), env=_clean_env())
            if p.returncode:
                return [], _error('message_read_failed', hit['account'], hit['folder'], hit['uid']), True
            events = parse_message(p.stdout, account=hit['account'], folder=hit['folder'],
                                   uid=hit['uid'], observed_at=iso())
            return events, None, True
        except subprocess.TimeoutExpired:
            return [], _error('message_read_timeout', hit['account'], hit['folder'], hit['uid']), True
        except (OSError, ValueError, TypeError, AttributeError, IndexError):
            return [], _error('message_read_or_parse_failed', hit['account'], hit['folder'], hit['uid']), True

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(read_one, h) for h in candidates[:max_reads]]
        for future in as_completed(futures):
            events, error, attempted = future.result()
            coverage['read_attempts'] += int(attempted)
            if error:
                errors.append(error)
            else:
                coverage['read_successes'] += 1
                evidence.extend(events)
    # Complete means the bounded, recognized-message scan only; never all history.
    coverage['complete'] = not errors
    ids = {order_id} if order_id else {e['order_id'] for e in evidence}
    results = [aggregate_order(oid, evidence, scan_complete=coverage['complete']) for oid in sorted(ids)]
    return {'app': 'amazon', 'source': SOURCE, 'checked_at': iso(), 'orders': results,
            'coverage': coverage, 'errors': sorted(errors, key=lambda e: json.dumps(e, sort_keys=True))}


def orders(**options):
    return _scan(**options)


def track(order_id, **options):
    result = _scan(order_id=order_id, **options)
    order = result.pop('orders')[0]
    order_coverage = order.pop('coverage')
    return {**result, **order, 'coverage': {**result['coverage'], 'order': order_coverage}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('orders', 'track'):
        p = sub.add_parser(name)
        if name == 'track':
            p.add_argument('order_id')
        p.add_argument('--json', action='store_true')
        p.add_argument('--since', help='YYYY-MM-DD, max 366 days; search overlaps one day')
        p.add_argument('--days', type=int, default=30)
        p.add_argument('--timeout', type=float, default=75, help='Overall seconds, including all reads')
        p.add_argument('--limit', type=int, default=150, help='Search matches per folder, max 500')
        p.add_argument('--max-reads', type=int, default=60, help='Body-read cap, max 200')
        p.add_argument('--account', action='append', choices=ACCOUNTS, help='Explicitly narrowed account coverage')
    args = parser.parse_args(argv)
    try:
        options = dict(since=args.since, days=args.days, timeout=args.timeout, limit=args.limit,
                       max_reads=args.max_reads, accounts=args.account)
        result = track(args.order_id, **options) if args.command == 'track' else orders(**options)
    except ValueError:
        result = {'app': 'amazon', 'source': SOURCE, 'status': 'unknown',
                  'errors': [_error('invalid_arguments')]}
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        for row in result.get('orders', [result] if 'order_id' in result else []):
            print(f'{row["order_id"]}\t{row["status"]}\twhole_order_delivered={row["whole_order_delivered"]}')
        for error in result['errors']:
            print('ERROR ' + error['code'] + (':' + error['account'] if error.get('account') else ''))
    return 1 if result['errors'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
