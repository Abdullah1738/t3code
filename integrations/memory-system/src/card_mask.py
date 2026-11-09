"""Payment-card redaction shared by tool hooks and recall capture (stdlib only)."""
from __future__ import annotations

import json
import math
import re

# Consume the entire run before checking its length: a valid suffix of a longer
# number must not be mistaken for a PAN. ASCII boundaries protect UUIDs and SHAs.
_CARD_RUN = re.compile(r"[0-9](?:[ -]?[0-9])*")
_ID_NEIGHBOUR = re.compile(r"[A-Za-z0-9_-]")
# Match the bounded label/value gap used by the Dia and phone maskers, including
# quoted JSON, parenthesised values and short phrases such as 'CVC for card is'.
_PUNCT = r"(?:[\s:=\-\"'()\[\]{},]|\\[\"'])"
_GAP = _PUNCT + r"{0,6}(?:[A-Za-z]{1,20}" + _PUNCT + r"{0,6}){0,3}"
_CVC_LABEL = r"\b(?:cvc|cvv|csc|cvn|security\s*code)\b"
_EXP_LABEL = r"\b(?:exp|expiry|expires?|expiration|valid\s*(?:thru|through)|mm\s*/\s*yy(?:yy)?)\b"
_CVC_VALUE = r"(?<![A-Za-z0-9_-])([0-9]{3,4})(?![A-Za-z0-9_-])"
_EXP_VALUE = r"(?<![A-Za-z0-9_-])((?:0?[1-9]|1[0-2])\s*[/-]\s*(?:[0-9]{4}|[0-9]{2}))(?![A-Za-z0-9_-])"
_CVC = re.compile("(" + _CVC_LABEL + _GAP + ")" + _CVC_VALUE, re.I)
_EXP = re.compile("(" + _EXP_LABEL + _GAP + ")" + _EXP_VALUE, re.I)
_LABELLED_VALUES = [
    (re.compile(label + _GAP + r"\Z", re.I), re.compile("^(" + _GAP + ")" + value, re.I), replacement)
    for label, value, replacement in [(_CVC_LABEL, _CVC_VALUE, "•••"), (_EXP_LABEL, _EXP_VALUE, "••/••")]
]


def _luhn(digits):
    total = 0
    for i, char in enumerate(reversed(digits)):
        n = ord(char) - 48
        if i % 2:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def mask_text(s: str) -> str:
    def card(match):
        before = s[match.start() - 1:match.start()] if match.start() else ""
        after = s[match.end():match.end() + 1]
        if _ID_NEIGHBOUR.fullmatch(before) or _ID_NEIGHBOUR.fullmatch(after):
            return match.group()
        digits = match.group().replace(" ", "").replace("-", "")
        return "•••• " + digits[-4:] if 13 <= len(digits) <= 19 and _luhn(digits) else match.group()

    s = _CARD_RUN.sub(card, s)
    s = _CVC.sub(lambda m: m[1] + "•••", s)
    return _EXP.sub(lambda m: m[1] + "••/••", s)


def _labelled_value(label, value):
    # Match the key only as context. Redacting it together with the value would
    # shift offsets when a key itself contains card data and truncate the value.
    for key_pattern, value_pattern, replacement in _LABELLED_VALUES:
        if key_pattern.search(label):
            value = value_pattern.sub(lambda m: m[1] + replacement, value)
    return value


def _numeric_text(v):
    if type(v) is int:
        return str(v)
    if type(v) is float and math.isfinite(v) and v.is_integer():
        return str(int(v))
    return None


def _mask_value(v, recall):
    if isinstance(v, str):
        masked = mask_json_text(v) if recall and v.lstrip().startswith(("{", "[")) else mask_text(v)
        return masked, masked != v
    if recall and (digits := _numeric_text(v)) is not None:
        masked = mask_text(digits)
        return (masked, True) if masked != digits else (v, False)
    if isinstance(v, dict):
        out, changed = {}, False
        for key, value in v.items():
            masked, item_changed = _mask_value(value, recall)
            numeric = _numeric_text(value) if recall else None
            if isinstance(key, str) and (isinstance(masked, str) or numeric is not None):
                text = masked if isinstance(masked, str) else numeric
                labelled = _labelled_value(key, text)
                if labelled != text:
                    masked, item_changed = labelled, True
            out[key] = masked
            changed |= item_changed
        return out, changed
    if isinstance(v, list):
        out, changed = [], False
        for value in v:
            masked, item_changed = _mask_value(value, recall)
            out.append(masked)
            changed |= item_changed
        return out, changed
    return v, False


def mask_value(v):
    """Copy tool output, changing only string leaves and retaining every key/type."""
    return _mask_value(v, recall=False)


def mask_recall_value(v):
    """Mask archive data, including numeric PANs and labelled numeric codes."""
    return _mask_value(v, recall=True)


def mask_json_text(s: str) -> str:
    """Redact captured JSON, permitting numeric secrets to become masked strings."""
    try:
        value = json.loads(s)
    except ValueError:
        return mask_text(s)
    masked, changed = mask_recall_value(value)
    return json.dumps(masked, ensure_ascii=False) if changed else s
