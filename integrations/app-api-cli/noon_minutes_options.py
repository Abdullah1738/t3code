"""Read-only Minutes customization discovery from the native catalog search hit."""
import time

import noon_minutes_checkout as m
from noon_auth_lifecycle import NoonAuthLifecycle


class OptionsError(m.MinutesError):
    def __init__(self, code, details):
        super().__init__(code)
        self.details = details


def project_options(hit, sku):
    m.require(isinstance(hit, dict) and hit.get('sku') == sku, 'MINUTES_CATALOG_SKU_MISMATCH')
    groups = hit.get('customizationOptions')
    if groups is None:
        m.require(hit.get('isCustomizable') is False, 'MINUTES_OPTIONS_SCHEMA_UNVERIFIED')
        groups = []
    m.require(isinstance(groups, list) and len(groups) <= 30
              and not hit.get('customizationConfig')
              and (bool(groups) or hit.get('isCustomizable') is not True),
              'MINUTES_OPTIONS_SCHEMA_UNVERIFIED')
    result, codes, group_ids = [], set(), set()
    for group in groups:
        m.require(isinstance(group, dict), 'MINUTES_OPTIONS_SCHEMA_UNVERIFIED')
        group_id = m.ident(group.get('modifierGroup'))
        low, high = group.get('minSelection'), group.get('maxSelection')
        options = group.get('modifiers')
        m.require(group_id not in group_ids and group.get('modifierType') == 'checkbox'
                  and type(low) is int and type(high) is int and 0 <= low <= high
                  and isinstance(options, list) and low <= len(options),
                  'MINUTES_OPTIONS_SCHEMA_UNVERIFIED')
        group_ids.add(group_id)
        projected = []
        for option in options:
            m.require(isinstance(option, dict), 'MINUTES_OPTIONS_SCHEMA_UNVERIFIED')
            code = m.ident(option.get('modifierCode'))
            m.require(code not in codes and type(option.get('isPreselected')) is bool
                      and not option.get('customizationOptions') and not option.get('modifiers'),
                      'MINUTES_OPTIONS_SCHEMA_UNVERIFIED')
            price = m.amount_minor(option.get('price'))
            m.require(price >= 0, 'MINUTES_OPTIONS_SCHEMA_UNVERIFIED')
            codes.add(code)
            projected.append({'code': code, 'title': m.safe_text(option.get('title')),
                              'price_minor': price, 'preselected': option['isPreselected']})
        result.append({'group': group_id, 'title': m.safe_text(group.get('title')),
                       'min_selection': low, 'max_selection': high, 'options': projected})
    return {'sku': sku, 'title': m.safe_text(hit.get('title')), 'groups': result}


def read_options(sku, *, query=None, auth=None, timeout=25):
    m.ident(sku)
    query = sku if query is None else query
    m.require(isinstance(query, str) and 0 < len(query.strip()) <= 200, 'INVALID_CATALOG_QUERY')
    auth = auth or NoonAuthLifecycle()
    state = auth.status('minutes')
    snap = auth.reconcile('minutes') if state['maintenance_state'] != 'none' else auth.revalidate('minutes')
    observations = []
    try:
        data = m.native_request('catalog_search', snap.read_headers(), time.monotonic() + timeout,
                                None, query={'q': query, 'page': 1, 'rows': 50, 'productsOnly': '1'},
                                response_observer=observations.append)
        m._application_ok(data)
        m.require(isinstance(data.get('hits'), list), 'MINUTES_CATALOG_SCHEMA_CHANGED')
        hits = [x for x in data['hits'] if isinstance(x, dict) and x.get('sku') == sku]
        if len(hits) != 1:
            raise OptionsError('MINUTES_CATALOG_ITEM_NOT_RESOLVED', {
                'sku': sku, 'message': 'Use --query with the product name, or catalog_query in its items-file row. '
                                       'The bounded search must return this exact SKU.'})
        return project_options(hits[0], sku)
    finally:
        for observation in observations:
            auth.retain_response_cookies('minutes', snap, observation.set_cookies,
                response_url=observation.response_url, http_status=observation.http_status)


def validate_selection(item, catalog):
    selected = set(item['modifiers'])
    known = {option['code'] for group in catalog['groups'] for option in group['options']}
    missing, excessive = [], []
    for group in catalog['groups']:
        count = len(selected & {x['code'] for x in group['options']})
        if count < group['min_selection']:
            missing.append(group)
        if count > group['max_selection']:
            excessive.append(group)
    if missing or excessive or selected - known:
        raise OptionsError('MINUTES_REQUIRED_OPTIONS_MISSING' if missing else 'MINUTES_OPTIONS_INVALID', {
            'sku': item['sku'], 'required_groups': missing, 'over_selected_groups': excessive,
            'unknown_modifiers': sorted(selected - known),
            'message': 'Pass chosen option codes in this items-file row as modifiers: ["code", ...]. '
                       'Preselected catalog options are not silently chosen.'})
