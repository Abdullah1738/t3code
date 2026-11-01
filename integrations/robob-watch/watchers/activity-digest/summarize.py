#!/usr/bin/python3
"""Short wake text for activity-digest: totals, counts per topic, path to the full list.

stdin: unreported activity-log lines. argv[1]: path of the full digest file. Prints at most ~15 lines.
Topic = the field after the first " · " (the log format); lines without it use the first word after the time.
"""
import re
import sys
from collections import Counter, OrderedDict

SHOW = 11  # topic lines; header + path + "By topic:" + 11 + "other topics" = 15 lines max

STAMP = re.compile(r"^(?:- )?(\d{4}-\d{2}-\d{2}) ~?(\d{2}:[0-9x]{2})")


def stamp(line):
    m = STAMP.match(line)
    return (m.group(1), m.group(2)) if m else ("", "")


def topic(line):
    parts = line.split(" · ")
    if len(parts) >= 3:
        text = parts[1]
    else:
        text = STAMP.sub("", line)
        text = re.sub(r"^\s*(\+04|Dubai)?\s*[:—-]*\s*", "", text)
        text = re.split(r"[:—]", text, 1)[0]
    text = re.sub(r"\([^)]*\)", " ", text.lower()).replace("/", " ")
    toks = [t.strip(":,.;'\"") for t in text.split()]
    toks = [t for t in toks if t]
    main = toks[0] if toks else "untagged"
    sub = toks[1] if len(toks) > 1 and toks[1].isalpha() and len(toks[1]) > 2 else None
    return main, sub


def main():
    lines = [l.rstrip("\n") for l in sys.stdin if l.strip()]
    if not lines:
        return
    groups = OrderedDict()
    for l in lines:
        m, s = topic(l)
        groups.setdefault(m, Counter())[s] += 1
    n = len(lines)
    (d0, t0), (d1, t1) = stamp(lines[0]), stamp(lines[-1])
    span = f"{d0} {t0} to {t1}" if d0 == d1 else f"{d0} {t0} to {d1} {t1}"
    print(f"Activity log: {n} unreported entr{'y' if n == 1 else 'ies'} ({span} Dubai).")
    print(f"Full list (read it before writing the catch-up): {sys.argv[1]}")
    ranked = sorted(groups.items(), key=lambda kv: -sum(kv[1].values()))
    shown, rest = ranked[:SHOW], ranked[SHOW:]
    if len(rest) == 1:
        shown, rest = ranked, []
    print("By topic:")
    for name, subs in shown:
        total = sum(subs.values())
        named = [(s, c) for s, c in subs.most_common() if s and c >= 2]
        detail = ""
        if len(named) > 1 or (named and named[0][1] < total):
            detail = " (" + ", ".join(f"{s} {c}" for s, c in named[:3]) + (", …" if len(named) > 3 else "") + ")"
        print(f"- {name} {total}{detail}")
    if rest:
        print(f"- {len(rest)} other topics: {sum(sum(s.values()) for _, s in rest)} entries")


if __name__ == "__main__":
    main()
