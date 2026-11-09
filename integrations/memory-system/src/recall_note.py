"""Hard UTF-8 budget including the native recall envelope."""
import re

MAX_NOTE_BYTES = 1500
MAX_ITEMS = 2
PREFIX, SUFFIX = "<recall>\n", "\n</recall>"


def bounded_note(note):
    if not isinstance(note, str) or not note.strip():
        return None
    if note.startswith(PREFIX) and note.endswith(SUFFIX):
        note = note[len(PREFIX):-len(SUFFIX)]
    if len(re.findall(r"^\s*(?:[-*•]|\d+[.)])\s+", note, re.M)) > MAX_ITEMS:
        return None
    # Oversized free-form/history notes are omitted, never cut mid-instruction.
    return note if len((PREFIX + note + SUFFIX).encode("utf-8")) <= MAX_NOTE_BYTES else None


def rule_note(rules):
    entries, selected = [], []
    for rule in rules:
        if not (rule.get('citation') or rule.get('source')): continue
        entry = f"- {rule.get('text', '')} [{rule.get('citation') or rule.get('source', '')}]"
        candidate = "Owner rules:\n" + "\n".join(entries + [entry])
        if bounded_note(candidate):
            entries.append(entry)
            selected.append(rule)
        if len(entries) == MAX_ITEMS:
            break
    return ("Owner rules:\n" + "\n".join(entries) if entries else None), selected
