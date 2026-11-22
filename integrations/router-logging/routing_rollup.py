"""Account-routing diagnostics; absent legacy dimensions remain unknown."""
from collections import Counter
import datetime as dt
import re


def request_id(row):
    ids = row.get('ids')
    value = ids.get('req') if isinstance(ids, dict) else None
    return value if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{8,32}', value) else None


def model_id(value):
    return value if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{16}', value) else 'unknown'


def provider_id(value):
    return value if isinstance(value, str) and re.fullmatch(r'[a-z0-9_.-]{1,64}', value) else 'unknown'


def fixed(value, choices):
    return value if isinstance(value, str) and value in choices else 'unknown'


class RoutingSummary:
    def __init__(self):
        self.requests = set()
        self.sticky_requests = set()
        self.chains = Counter()
        self.sticky = Counter()
        self.causes = Counter()
        self.models = Counter()
        self.hours = Counter()
        self.hour_reasons = Counter()
        self.decisions = Counter()
        self.reasons = Counter()
        self.routes = Counter()
        self.sticky_count = self.fallback_count = 0
        self.sticky_missing_req = self.fallback_missing_req = 0

    def add(self, row):
        name = row['name']
        if not name.startswith('proxy.'):
            return
        req = request_id(row)
        if req:
            # Nonterminal rows still prove a request existed when its final row is absent.
            self.requests.add(req)
        props = row.get('props') if isinstance(row.get('props'), dict) else {}
        if name == 'proxy.sticky_miss':
            self.sticky_count += 1
            reason = fixed(props.get('reason'), {'locked', 'removed', 'disabled', 'over_budget'})
            self.sticky[reason] += 1
            self.decisions[fixed(props.get('decision'), {'moved', 'hold', '503'})] += 1
            self.causes[fixed(props.get('prevLockCause'), {'quota', 'auth', 'overloaded', 'model', 'none'})] += 1
            self.models[(provider_id(props.get('provider')), model_id(props.get('model')))] += 1
            hour = 'unknown'
            try:
                at = dt.datetime.fromisoformat(row['ts'].replace('Z', '+00:00'))
                if at.tzinfo is not None:
                    hour = at.astimezone(dt.timezone.utc).strftime('%H')
            except (KeyError, ValueError, TypeError, AttributeError, OverflowError):
                pass
            self.hours[hour] += 1
            self.hour_reasons[(hour, reason)] += 1
            if req:
                self.sticky_requests.add(req)
            else:
                self.sticky_missing_req += 1
        elif name == 'proxy.fallback':
            self.fallback_count += 1
            reason = props.get('reason')
            if not isinstance(reason, str) or not (reason in {'account_switch', 'model_switch'} or re.fullmatch(
                    r'http_[1-5][0-9]{2}|client_abort|header_deadline|http_502_connect_timeout|http_404_no_credentials|proxy_failure', reason)):
                reason = 'unknown'
            self.reasons[reason] += 1
            provider, model = provider_id(props.get('provider')), model_id(props.get('model'))
            self.routes[(provider_id(props.get('fromProvider', provider)), model_id(props.get('fromModel', model)), provider, model)] += 1
            if req:
                self.chains[req] += 1
            else:
                self.fallback_missing_req += 1

    def result(self):
        histogram = Counter(self.chains.get(req, 0) for req in self.requests)
        multiple = sum(n >= 2 for n in self.chains.values())
        sticky = dict(count=self.sticky_count, byReason=dict(sorted(self.sticky.items())),
            byPrevLockCause=dict(sorted(self.causes.items())), byDecision=dict(sorted(self.decisions.items())),
            byModel=[dict(provider=p, model=m, count=n) for (p, m), n in sorted(self.models.items())],
            byHour=dict(sorted(self.hours.items())),
            byHourReason=[dict(hour=h, reason=r, count=n) for (h, r), n in sorted(self.hour_reasons.items())],
            distinctRequests=len(self.sticky_requests), rowsWithoutRequest=self.sticky_missing_req,
            unknownReasonShare=self.sticky['unknown'] / self.sticky_count if self.sticky_count else None)
        fallback = dict(count=self.fallback_count, byReason=dict(sorted(self.reasons.items())),
            byProviderModel=[dict(fromProvider=fp, fromModel=fm, toProvider=tp, toModel=tm, count=n)
                             for (fp, fm, tp, tm), n in sorted(self.routes.items())],
            chainLengthHistogram={str(n): count for n, count in sorted(histogram.items())},
            distinctRequests=len(self.chains), rowsWithoutRequest=self.fallback_missing_req,
            totalDistinctRequests=len(self.requests), requestsWithAtLeastTwoFallbacks=multiple,
            shareRequestsWithAtLeastTwoFallbacks=multiple / len(self.requests) if self.requests else None)
        return sticky, fallback
