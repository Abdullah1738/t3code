"""Menu-backed choice contracts for restaurant cart lines.

Every accepted choice comes from the observed native contract: the choices
sheet endpoint (menubff v3) and the captured POST /cart/v2 payload of
2026-10-11 (ZeroFat 717327, item 157740044, choice 549025015):

    choices: [{"choiceId": <option id from ich[]>, "quantity": 1,
               "subChoiceIds": [<immediate child option id>, ...]}]

Nonempty subChoiceIds observed 2026-10-14: Latea 745022, Cold 700 Ml
1391242560 with 50% Sugar 1400704784 and Crystal Jelly 1400704776.
Only one child level and one unit of the parent choice are wire-proven.

choiceId is the chosen OPTION id, never the section id: a guessed
section-id payload was silently dropped by the server. Sections carry
mnq/mxq selection bounds enforced here before any cart mutation. No
invented numeric ceilings: quantities are positive integers and money is
kept at its exact server representation. No HTTP transport of its own;
the parent's Checkout supplies reads.
"""
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import re

from talabat_http_orders import TalabatError


def _fail(code):
    raise TalabatError(code)


def _positive(value):
    return type(value) is int and 0 < value < 2**63


def _money(value):
    """Menu money value at exact server representation -> fils, or None.

    Accepts any non-negative decimal digits (int, float or numeric string);
    no digit-count ceiling. Negative/ambiguous text is not catalog money.
    """
    if value is None or isinstance(value, bool) or type(value) not in (int, float, str):
        return None
    if not re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', str(value)):
        return None
    try:
        return int(Decimal(str(value)) * 100)
    except (InvalidOperation, ValueError, OverflowError):
        return None


def _prices(row):
    price, original = _money(row.get('pr')), _money(row.get('opr'))
    # Native menus and paid/free options use numeric opr=-1 when there is
    # no separate original price (Dunkin size choices, 2026-10-14). Only this
    # explicit sentinel permits using pr; missing/malformed prices stay unknown.
    if type(row.get('opr')) in (int, float) and row['opr'] == -1:
        original = price
    return price, original


@dataclass(frozen=True)
class MenuEntry:
    item_id: int
    name: str
    price_minor: int | None
    original_price_minor: int | None
    customizable: bool
    section: str


class MenuIndex:
    """Immutable id -> MenuEntry view over one live menubff v4 response."""

    def __init__(self, entries):
        self._entries = dict(entries)

    def __contains__(self, item_id):
        return item_id in self._entries

    def get(self, item_id):
        return self._entries.get(item_id)

    @property
    def entries(self):
        return dict(self._entries)


def _menu_sections(data):
    menu = data.get('menu') if type(data) is dict else None
    result = menu.get('result') if type(menu) is dict else None
    inner = result.get('menu') if type(result) is dict else None
    sections = inner.get('menuSection') if type(inner) is dict else None
    if type(sections) is not list:
        _fail('MENU_SCHEMA_INVALID')
    return sections


def parse_menu(data):
    """menubff v4 short-key walk (menuSection[].itm[] with nm/pr/opr/icc).

    The same id listed again under another section is tolerated only when
    the name matches exactly; conflicting duplicate names are rejected
    rather than silently first-wins.
    """
    entries = {}
    for section in _menu_sections(data):
        if type(section) is not dict:
            _fail('MENU_SCHEMA_INVALID')
        name = section.get('nm')
        rows = section.get('itm')
        if type(name) is not str or type(rows) is not list:
            _fail('MENU_SCHEMA_INVALID')
        for row in rows:
            if type(row) is not dict or not _positive(row.get('id')):
                _fail('MENU_SCHEMA_INVALID')
            item_id = row['id']
            item_name = row.get('nm') if type(row.get('nm')) is str else ''
            existing = entries.get(item_id)
            if existing is not None:
                if existing.name != item_name:
                    _fail('MENU_DUPLICATE_ITEM_CONFLICT')
                continue  # identical cross-listed row; id is identity
            entries[item_id] = MenuEntry(item_id, item_name, *_prices(row),
                                         row.get('icc') is True, name)
    return MenuIndex(entries.items())


def fetch_menu_index(checkout, branch_id):
    """Read-only menubff v4 walk using the flow's authenticated Checkout."""
    if not _positive(branch_id):
        _fail('MENU_BRANCH_ID_INVALID')
    data = checkout._read(f'/menubff/v4/branches/{branch_id}/menu', params={
        'branchId': branch_id, 'countryId': 4, 'areaId': checkout.home['area_id'],
        'latitude': checkout.home['latitude'], 'longitude': checkout.home['longitude']})
    return parse_menu(data)


@dataclass(frozen=True)
class ChoiceOption:
    option_id: int
    section_id: int
    name: str
    price_minor: int | None
    original_price_minor: int | None
    has_sub_categories: bool
    sub_categories: tuple = ()


@dataclass(frozen=True)
class ChoiceSection:
    section_id: int
    item_id: int
    name: str
    min_select: int
    max_select: int
    options: tuple


@dataclass(frozen=True)
class ItemChoices:
    item_id: int
    sections: tuple

    def options_by_id(self):
        return {o.option_id: o for s in self.sections for o in s.options}


def parse_choices(data, menu_item_id):
    """menubff v3 choices response -> ItemChoices (cross-sell ignored)."""
    if not _positive(menu_item_id):
        _fail('MENU_ITEM_ID_INVALID')
    result = data.get('result') if type(data) is dict else None
    rows = result.get('choiceForItem') if type(result) is dict else None
    if rows in (None, []):
        return ItemChoices(menu_item_id, ())
    if type(rows) is not list:
        _fail('MENU_CHOICES_SCHEMA_INVALID')
    sections = []
    for row in rows:
        raw_sections = row.get('choiceSections') if type(row) is dict else None
        sections.extend(_parse_sections(raw_sections, menu_item_id))
    return ItemChoices(menu_item_id, tuple(sections))


def _parse_sections(rows, parent_id):
    if type(rows) is not list:
        _fail('MENU_CHOICES_SCHEMA_INVALID')
    sections = []
    section_ids, option_ids = set(), set()
    for section in rows:
        if (type(section) is not dict or not _positive(section.get('id'))
                or not _positive(section.get('iid')) or section['iid'] != parent_id
                or type(section.get('nm')) is not str
                or type(section.get('mnq')) is not int or section['mnq'] < 0
                or type(section.get('mxq')) is not int or section['mxq'] < section['mnq']):
            _fail('MENU_CHOICES_SCHEMA_INVALID')
        if section['id'] in section_ids or type(section.get('ich')) is not list:
            _fail('MENU_CHOICES_SCHEMA_INVALID')
        section_ids.add(section['id'])
        options = []
        for option in section['ich']:
            if (type(option) is not dict or not _positive(option.get('id'))
                    or type(option.get('nm')) is not str):
                _fail('MENU_CHOICES_SCHEMA_INVALID')
            if option['id'] in option_ids:
                _fail('MENU_CHOICE_ID_AMBIGUOUS')
            option_ids.add(option['id'])
            nested = option.get('subCategories')
            sub_categories = () if nested is None else _parse_sections(nested, option['id'])
            options.append(ChoiceOption(option['id'], section['id'], option['nm'],
                                        *_prices(option), nested is not None, sub_categories))
        sections.append(ChoiceSection(section['id'], parent_id, section['nm'],
                                      section['mnq'], section['mxq'], tuple(options)))
    return tuple(sections)


def fetch_item_choices(checkout, branch_id, menu_item_id):
    """Read-only GET of the observed customize-sheet endpoint."""
    if not _positive(branch_id):
        _fail('MENU_BRANCH_ID_INVALID')
    data = checkout._read(f'/menubff/v3/branches/{branch_id}/menu/{menu_item_id}/choices', params={
        'countryId': 4, 'areaId': checkout.home['area_id'],
        'latitude': checkout.home['latitude'], 'longitude': checkout.home['longitude'],
        'source': '', 'isProUser': 'false'})
    return parse_choices(data, menu_item_id)


def validate_line_choices(item_choices, line_choices):
    """Exact catalog-backed normalization of one line's requested choices.

    line_choices: ((choice_id, quantity, sub_choice_ids), ...).
    Returns the normalized tuple. Section bounds (mnq/mxq) are enforced as
    catalog truth over distinct selected options; quantities are positive
    integers with no invented ceiling.
    """
    if type(item_choices) is not ItemChoices:
        _fail('MENU_CHOICES_REQUIRED')
    normalized = []
    for entry in line_choices:
        if (type(entry) is not tuple or len(entry) != 3 or not _positive(entry[0])
                or type(entry[1]) is not int or entry[1] < 1
                or type(entry[2]) is not tuple):
            _fail('FOOD_ITEM_CHOICES_INVALID')
        if any(not _positive(s) for s in entry[2]):
            _fail('FOOD_ITEM_CHOICES_INVALID')
        if len(set(entry[2])) != len(entry[2]):
            _fail('FOOD_SUBCHOICE_DUPLICATED_IN_LINE')
        normalized.append((entry[0], entry[1], tuple(sorted(entry[2]))))
    if len({cid for cid, _quantity, _subs in normalized}) != len(normalized):
        _fail('FOOD_CHOICE_DUPLICATED_IN_LINE')
    if normalized and not item_choices.sections:
        # Choices requested for an item whose catalog exposes no sections.
        _fail('MENU_ITEM_NOT_CUSTOMIZABLE')
    by_id = item_choices.options_by_id()
    per_section = {}
    all_ids = {c[0] for c in normalized}
    for choice_id, quantity, subs in normalized:
        option = by_id.get(choice_id)
        if option is None:
            _fail('MENU_CHOICE_UNKNOWN')
        children = {o.option_id: o for s in option.sub_categories for o in s.options}
        for sub_id in subs:
            child = children.get(sub_id)
            if child is None:
                _fail('MENU_SUBCHOICE_UNKNOWN_FOR_PARENT')
            if sub_id in all_ids:
                _fail('FOOD_CHOICE_IDENTITY_AMBIGUOUS')
            all_ids.add(sub_id)
            if child.sub_categories:
                _fail('FOOD_SUBCHOICE_DEPTH_UNSUPPORTED')
        for section in option.sub_categories:
            selected = len(set(subs) & {o.option_id for o in section.options})
            if not section.min_select <= selected <= section.max_select:
                _fail('MENU_SUBCHOICE_SECTION_BOUNDS_FAILED')
        if subs and quantity != 1:
            _fail('FOOD_NESTED_CHOICE_QUANTITY_UNPROVEN')
        per_section.setdefault(option.section_id, set()).add(choice_id)
    for section in item_choices.sections:
        selected = len(per_section.get(section.section_id, ()))
        if selected < section.min_select or selected > section.max_select:
            _fail('MENU_CHOICE_SECTION_BOUNDS_FAILED')
    return tuple(normalized)


def choice_catalog(item_choices):
    """{option_id: {'section_id', 'name', 'original_price_minor'}} for readbacks."""
    if type(item_choices) is not ItemChoices:
        _fail('MENU_CHOICES_REQUIRED')
    def info(option):
        result = {'section_id': option.section_id, 'name': option.name,
                  'original_price_minor': option.original_price_minor}
        if option.sub_categories:
            result['sub_choices'] = {o.option_id: info(o)
                                     for s in option.sub_categories for o in s.options}
        return result
    return {o.option_id: info(o) for o in item_choices.options_by_id().values()}
