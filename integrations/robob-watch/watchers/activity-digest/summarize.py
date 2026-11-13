#!/usr/bin/python3
"""Render activity counts and their entries from the same grouped list.

stdin: unreported activity-log lines. argv[1]: path of the full digest file.
Topic = the field after the first " · " (the log format); lines without it use the first word after the time.
"""
import re
import sys
from collections import OrderedDict
from pathlib import Path
# robob-watch test copies the watcher into scratch, while helpers stay installed.
REDACT_HELPERS = Path(__file__).resolve().parents[2] / 'helpers'
if not (REDACT_HELPERS / 'redact.py').is_file():
    REDACT_HELPERS = Path.home() / '.local/share/robob-watch/helpers'
sys.path.insert(0, str(REDACT_HELPERS))
from redact import redact

WAKE_BUDGET = 5500  # robob-watch clips events at 6000 characters.

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


def render(raw):
    lines = [l for l in redact(raw).splitlines() if l.strip()]
    if not lines:
        return ''
    groups = OrderedDict()
    for line in lines:
        name, _ = topic(line)
        groups.setdefault(name, []).append(line)
    n = sum(len(items) for items in groups.values())
    (d0, t0), (d1, t1) = stamp(lines[0]), stamp(lines[-1])
    span = f"{d0} {t0} to {t1}" if d0 == d1 else f"{d0} {t0} to {d1} {t1}"
    output = [f"Activity log: {n} unreported entr{'y' if n == 1 else 'ies'} ({span} Dubai)."]
    for name, items in sorted(groups.items(), key=lambda pair: -len(pair[1])):
        output.extend(['', f'## {name} ({len(items)})'])
        output.extend('- ' + item.removeprefix('- ') for item in items)
    return '\n'.join(output) + '\n'


def main():
    digest = render(sys.stdin.read())
    if not digest:
        return
    Path(sys.argv[1]).write_text(digest)
    # Never send counts whose entries would be clipped out of the wake.
    if len(digest) <= WAKE_BUDGET:
        print(digest, end='')
    else:
        print(f'Activity digest: {sys.argv[1]}')


if __name__ == "__main__":
    main()
