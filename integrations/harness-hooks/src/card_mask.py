"""Payment-card redaction shared by tool hooks and recall capture (stdlib only)."""
from __future__ import annotations

import json
import re

# Consume the entire run before checking its length: a valid suffix of a longer
# number must not be mistaken for a PAN. ASCII boundaries protect UUIDs and SHAs.
_CARD_RUN = re.compile(r"[0-9](?:[ -]?[0-9])*")
_ID_NEIGHBOUR = re.compile(r"[A-Za-z0-9_-]")
# Match the bounded label/value gap used by the Dia and phone maskers, including
# quoted JSON, parenthesised values and short phrases such as 'CVC for card is'.
_PUNCT = r"(?:[\s:=\-\"'()\[\]{},]|\\[\"'])"
_GAP = _PUNCT + r"{0,6}(?:[A-Za-z]{1,20}" + _PUNCT + r"{0,6}){0,3}"
_CVC = re.compile(r"(\b(?:cvc|cvv|csc|cvn|security\s*code)\b" + _GAP + r")([0-9]{3,4})(?![A-Za-z0-9_-])", re.I)
_EXP = re.compile(r"(\b(?:exp|expiry|expires?|expiration|valid\s*(?:thru|through)|mm\s*/\s*yy(?:yy)?)\b" + _GAP + r")((?:0?[1-9]|1[0-2])\s*[/-]\s*(?:[0-9]{4}|[0-9]{2}))(?![A-Za-z0-9_-])", re.I)


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


def mask_value(v):
    """Copy JSON containers, changing only string leaves and retaining every key/type."""
    if isinstance(v, str):
        masked = mask_text(v)
        return masked, masked != v
    if isinstance(v, dict):
        out, changed = {}, False
        for key, value in v.items():
            masked, item_changed = mask_value(value)
            if isinstance(value, str) and isinstance(key, str):
                # A JSON field's label lives in its key rather than its string leaf.
                prefix = key + ': "'
                masked = mask_text(prefix + value + '"')[len(prefix):-1]
                item_changed = masked != value
            out[key] = masked
            changed |= item_changed
        return out, changed
    if isinstance(v, list):
        out, changed = [], False
        for value in v:
            masked, item_changed = mask_value(value)
            out.append(masked)
            changed |= item_changed
        return out, changed
    return v, False


def mask_json_text(s: str) -> str:
    """Redact captured JSON without invalidating its outer record or identity fields."""
    try:
        value = json.loads(s)
    except ValueError:
        return mask_text(s)
    masked, changed = mask_value(value)
    return json.dumps(masked, ensure_ascii=False) if changed else s
