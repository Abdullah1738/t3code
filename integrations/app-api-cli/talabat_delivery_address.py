"""Order-specific address projection; never substitute the catalog/search pin."""
import re


def _text(value, limit=1000):
    if isinstance(value, str) and 0 < len(value) <= limit and all(ord(c) >= 32 for c in value):
        return value.strip() or None
    return None


def home_match(text):
    """Only the building AND exact unit prove home. Labels alone prove nothing."""
    if not text:
        return None, 'address_unavailable'
    normalized = re.sub(r'[^a-z0-9]+', ' ', text.casefold()).strip()
    building = bool(re.search(r'\bbanyan\s*tree\b', normalized))
    if building:
        explicit_flat = re.search(r'\b(?:flat|unit|apartment)\s+(\d+)\b', normalized)
        if explicit_flat and explicit_flat[1] != '2104':
            return False, 'different_flat'
        if 'hillside' in normalized and re.search(r'\b2104\b', normalized):
            return True, 'banyantree_hillside_and_flat_2104'
        # A partial building-only address cannot certify either destination.
        return None, 'home_building_without_verified_flat'
    if len([part for part in text.split(',') if part.strip()]) >= 3:
        return False, 'different_delivery_address'
    return None, 'incomplete_delivery_address'


def project(data, order):
    empty = {'delivery_address': None, 'is_home': None, 'home_match_reason': 'address_unavailable'}
    attrs = data.get('common_tracking_event_attributes')
    if (data.get('type') != 'OrderTrackingScreen' or not isinstance(attrs, dict)
            or str(attrs.get('order_id')) != order):
        return {**empty, 'home_match_reason': 'order_identity_unverified'}
    layouts, widgets = data.get('layouts'), data.get('widgets')
    if not isinstance(layouts, list) or not isinstance(widgets, dict):
        return empty
    referenced = {key for layout in layouts if isinstance(layout, dict) and layout.get('name') == 'body'
                  for key in (layout.get('column') if isinstance(layout.get('column'), list) else [])
                  if isinstance(key, str)}
    key = 'tlb_app_bff_passthrough'
    widget = widgets.get(key)
    if key not in referenced or not isinstance(widget, dict) or widget.get('type') != 'FluidComponent':
        return empty
    from talabat_http_orders import _data, _props, _shown
    props = _props(_data(widget).get('component'))
    if not _shown(widget) or not _shown(props) or not isinstance(props.get('children'), list):
        return empty
    matches = [(i, _props(child)) for i, child in enumerate(props['children'])
               if isinstance(child, dict) and child.get('template_id') == 'delivery_address']
    if len(matches) != 1:
        return {**empty, 'home_match_reason': 'address_missing_or_ambiguous'}
    index, address = matches[0]
    if not _shown(address) or address.get('tracking_key') not in (None, '', order):
        return empty
    text = _text(address.get('address_text'))
    if not text:
        return empty
    label = _text(address.get('title'), 160)
    if label:
        label = re.sub(r'^[^\w]+', '', label).strip() or None
    is_home, reason = home_match(text)
    return {'delivery_address': {
        'label': label, 'text': text, 'header': _text(address.get('header'), 160),
        # This SDUI component exposes text, not coordinates or saved-address ID.
        # Joining today's saved address could misrepresent a historical order.
        'address_id': None, 'lat': None, 'lng': None,
        'source': f'widgets.{key}.data.component.properties.children[{index}].properties.address_text',
    }, 'is_home': is_home, 'home_match_reason': reason}
