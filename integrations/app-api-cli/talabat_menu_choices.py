"""Menu-backed choice contracts for restaurant cart lines.

Every accepted choice comes from the observed native contract: the choices
sheet endpoint (menubff v3) and the captured POST /cart/v2 payload of
2026-10-11 (ZeroFat 717327, item 157740044, choice 549025015):

    choices: [{"choiceId": <option id from ich[]>, "quantity": 1,
               "subChoiceIds": []}]

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
            entries[item_id] = MenuEntry(item_id, item_name,
                                         _money(row.get('pr')), _money(row.get('opr')),
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
        if type(raw_sections) is not list:
            _fail('MENU_CHOICES_SCHEMA_INVALID')
        for section in raw_sections:
            if (type(section) is not dict or not _positive(section.get('id'))
                    or not _positive(section.get('iid')) or section['iid'] != menu_item_id
                    or type(section.get('nm')) is not str
                    or type(section.get('mnq')) is not int or section['mnq'] < 0
                    or type(section.get('mxq')) is not int or section['mxq'] < 0):
                _fail('MENU_CHOICES_SCHEMA_INVALID')
            options = []
            for option in section.get('ich') if type(section.get('ich')) is list else []:
                if (type(option) is not dict or not _positive(option.get('id'))
                        or type(option.get('nm')) is not str):
                    _fail('MENU_CHOICES_SCHEMA_INVALID')
                price, original = _money(option.get('pr')), _money(option.get('opr'))
                # Live Right Bite free sauce (2026-10-11): pr=0, opr=-1.
                # -1 is the native no-original-price sentinel, not a discount.
                # Only the explicit zero current price proves zero cost; do
                # not invent a list price for paid/missing/malformed choices.
                if (price == 0 and type(option.get('opr')) in (int, float)
                        and option['opr'] == -1):
                    original = 0
                options.append(ChoiceOption(option['id'], section['id'], option['nm'],
                                            price, original,
                                            option.get('subCategories') is not None))
            sections.append(ChoiceSection(section['id'], menu_item_id, section['nm'],
                                          section['mnq'], section['mxq'], tuple(options)))
    return ItemChoices(menu_item_id, tuple(sections))


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

    line_choices: ((choice_id, quantity, sub_choice_ids), ...) — only empty
    sub-choice lists are accepted (non-empty remain unproven on the wire).
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
        if entry[2]:
            # subChoiceIds content shape is not observed; never guess a payload.
            _fail('FOOD_SUBCHOICES_UNPROVEN')
        normalized.append((entry[0], entry[1], ()))
    if len({cid for cid, _quantity, _subs in normalized}) != len(normalized):
        _fail('FOOD_CHOICE_DUPLICATED_IN_LINE')
    if normalized and not item_choices.sections:
        # Choices requested for an item whose catalog exposes no sections.
        _fail('MENU_ITEM_NOT_CUSTOMIZABLE')
    by_id = item_choices.options_by_id()
    per_section = {}
    for choice_id, _quantity, _subs in normalized:
        option = by_id.get(choice_id)
        if option is None:
            _fail('MENU_CHOICE_UNKNOWN')
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
    return {o.option_id: {'section_id': o.section_id, 'name': o.name,
                          'original_price_minor': o.original_price_minor}
            for o in item_choices.options_by_id().values()}
