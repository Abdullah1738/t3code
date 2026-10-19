"""Moni's own go for an order placed on her behalf.

Abdullah's standing approval covers paying for Moni's orders, not choosing
them. Before a `--for moni` order is placed, the caller passes her words
(`--moni-go "yes order it"`) and this module confirms that a message from her,
containing those words, arrived in her chat within the window, and that she
did not call it off in a later message. It fails closed: no matching message,
no readable history, or a later cancel from her means no order.

Agents can run the same check before any order step (prepare-only, resume,
recover) without placing anything:

    python3 moni_go.py check --go "<her words>"

It prints JSON and exits 0 (go stands), 4 (she cancelled after it) or 2 (no
go found, or her chat could not be read). It only runs `imsg history`.
"""
import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import unicodedata

MONI_CHAT_ID = '45'
WINDOW_MINUTES = 45
HISTORY_LIMIT = 80
EXIT_OK = 0
EXIT_NOT_FOUND = 2
EXIT_CANCELLED = 4


def normalize(text):
    text = unicodedata.normalize('NFKC', '' if text is None else str(text)).lower()
    text = re.sub(r"['\u2018\u2019]", '', text)
    text = re.sub(r'[^\w\s]', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


# Her wording for calling an order off, matched as whole words after normalize().
# Kept broad on purpose: a false cancel only means asking her again.
# 19 Oct: "It's been like 20 mins since I wanted a coffee pls leave it".
CANCEL_PHRASES = tuple(normalize(p) for p in (
    'leave it', 'pls leave it', 'forget it', 'forget about it', 'dont order', "don't order", 'do not order',
    'cancel', 'cancel it', 'cancelled', 'canceled', 'never mind', 'nevermind', 'nvm', 'stop', 'no dont',
    'not anymore', 'dont want it', "don't want", 'dont bother', 'skip it', 'no need', 'hold off',
    'dont go ahead', 'do not go ahead',
    # nightly review 20 Oct: wordings the first list missed.
    'dont worry', 'dw', 'no thanks', 'no thank you', 'nah', 'actually no', 'nm', 'forget that', 'forget the',
    'dont need', 'not needed', 'no longer', 'scrap it', 'drop it', 'dont get it', 'dont get anything',
    'dont get me', 'wait dont', 'wait no', 'wait actually', 'hold on', 'too late', 'got one already',
    'ill get it myself',
    # Recheck 20 Oct: cancels that sit next to delivery wording.
    'anymore', 'on second thought', 'next time', 'no need for it', 'leave it with me', 'on hold',
    'changed my mind', 'change my mind', 'change of mind', 'not now', 'not today', 'maybe later',
    'another time', 'some other time', 'dont do it', 'dont buy', 'forget abt', 'forget bout', 'screw it',
    'nope', 'not hungry', 'ok dont'))
# Typos and stretched spellings: nevermindd, nvmd, cancle, cancell, cancelled.
CANCEL_PATTERNS = tuple(re.compile(p) for p in (
    r'(?<!\S)never ?mind+(?!\S)', r'(?<!\S)nvm+d?(?!\S)', r'(?<!\S)cancel+(?:l?ed)?(?!\S)', r'(?<!\S)cancled?(?!\S)',
    r'(?<!\S)leave it+(?!\S)'))
# Wording that contains a cancel phrase but is not a cancel; blanked out before matching.
NOT_CANCEL_PHRASES = tuple(normalize(p) for p in (
    'dont cancel', 'do not cancel', 'dont stop', 'do not stop', 'no need to change', 'no need to rush',
    'no need to call', 'no need to ring', 'leave it at the door', 'leave it by the door', 'leave it outside',
    'leave it on the', 'leave it on my', 'leave it with the', 'leave it with security',
    'leave it with reception', 'leave it to you', 'leave it up to you', 'no need for cutlery',
    'no need for straws', 'no need for napkins', 'no need for sauce', 'dont need cutlery', 'dont forget', 'no need to wait', 'stop by', 'cant wait', 'cannot wait', 'ill wait',
    'i will wait', 'i can wait', 'happy to wait', 'wait for', 'no need to knock', 'no need to text',
    'no need to message', 'dont worry ill wait', 'dont worry i can wait'))
# Short messages that only call it off when they are the whole message ("wait"), since
# the same word inside an instruction ("tell him to wait downstairs") is not a cancel.
CANCEL_WHOLE = frozenset(normalize(p) for p in (
    'wait', 'wait wait', 'wait pls', 'pls wait', 'hang on', 'hold', 'later', 'dont', 'pls dont',
    'please dont', 'no no', 'nope'))
# A clear go that puts her order back on after a cancel.
# Kept narrow: "ill order it myself" or "i get it" must not restart an order she called off.
GO_PHRASES = tuple(normalize(p) for p in ('yes order', 'ok order', 'okay order', 'go ahead', 'yes pls order'))
# After a cancel, her original go words only put the order back on when they are this
# specific; a short go like "ok" or "psl" is too easy to repeat in passing.
REGO_MIN_WORDS = 3


def _has(text, phrase):
    return bool(phrase) and f' {phrase} ' in f' {text} '


def reads_as_cancel(text):
    text = normalize(text)
    if text in CANCEL_WHOLE:
        return True
    # Longest first, so "dont worry ill wait" is blanked before "ill wait".
    for phrase in sorted(NOT_CANCEL_PHRASES, key=len, reverse=True):
        text = re.sub(rf'(?<!\S){re.escape(phrase)}(?!\S)', ' ', text)
    return any(_has(text, phrase) for phrase in CANCEL_PHRASES) or any(p.search(text) for p in CANCEL_PATTERNS)


def _parse_time(value):
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None
    # A time without a zone can't be placed against the window; treat it as unreadable.
    return parsed if parsed.tzinfo is not None else None


def _row_id(row, missing=0):
    try:
        return int(row.get('id'))
    except (TypeError, ValueError):
        return missing


def _ref(row):
    return {'message_id': row.get('id'), 'at': row.get('created_at'), 'text': row.get('text')}


def read_history(runner=subprocess.run):
    try:
        p = runner(['imsg', 'history', '--chat-id', MONI_CHAT_ID, '--limit', str(HISTORY_LIMIT), '--json'],
                   capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if p.returncode != 0:
        return None
    rows = []
    for line in (p.stdout or '').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            return None
    return rows


def _moni_rows(rows, oldest, latest):
    """Her own messages in her chat inside the window, oldest first (id breaks ties),
    and the ids of hers whose time would not parse."""
    kept, unparsed = [], []
    for row in rows:
        if row.get('is_from_me') or str(row.get('chat_id')) != MONI_CHAT_ID:
            continue
        at = _parse_time(row.get('created_at'))
        if at is None:
            # No usable id either: treat it as newer than the go (fail closed).
            unparsed.append(_row_id(row, missing=float('inf')))
            continue
        if at < oldest or at > latest:
            continue
        kept.append((at, _row_id(row), row))
    kept.sort(key=lambda item: (item[0], item[1]))
    return [row for _, _, row in kept], unparsed


def verify(go_text, *, now=None, window_minutes=WINDOW_MINUTES, runner=subprocess.run):
    """Return the go that stands or raise RuntimeError with a stable code.

    Walks her messages in time order from the first one with her go words.
    Cancels before it don't count. After it, a cancel calls the order off (even
    in a message that repeats the go words), and only her go words again or a
    clear go phrase put it back on. The latest state decides.
    """
    wanted = normalize(go_text)
    if len(wanted) < 2:
        raise RuntimeError('MONI_GO_REQUIRED')
    rows = read_history(runner)
    if rows is None:
        raise RuntimeError('MONI_GO_UNVERIFIABLE')
    now = now or dt.datetime.now(dt.timezone.utc)
    oldest = now - dt.timedelta(minutes=window_minutes)
    # After a cancel, only a clear go phrase, or her go words when they are specific, put it back on.
    rego_by_words = len(wanted.split()) >= REGO_MIN_WORDS
    go_row = cancel_row = None
    mine, unparsed = _moni_rows(rows, oldest, now + dt.timedelta(minutes=2))
    for row in mine:
        text = normalize(row.get('text'))
        if go_row is None:
            if _has(text, wanted):
                go_row = row
                # "yes order it... actually nvm": the go message itself calls it off.
                # Only words after the go count: "wait actually yes order it" is a go.
                if reads_as_cancel(f' {text} '.split(f' {wanted} ', 1)[1]):
                    cancel_row = row
            continue
        if reads_as_cancel(text):
            cancel_row = cancel_row or row
        elif cancel_row is None:
            if _has(text, wanted):
                go_row = row
        elif (rego_by_words and _has(text, wanted)) or (
                any(_has(text, p) for p in GO_PHRASES) and not _has(text, 'myself')):
            # "ok order it myself" means she will order it, not us.
            go_row, cancel_row = row, None
    if go_row is None:
        raise RuntimeError('MONI_GO_NOT_FOUND')
    if any(mid > _row_id(go_row) for mid in unparsed):
        # A newer message of hers has no readable time; it could be a cancel after the go.
        raise RuntimeError('MONI_GO_UNVERIFIABLE')
    if cancel_row is not None:
        error = RuntimeError('MONI_CANCELLED_AFTER_GO')
        error.go = _ref(go_row)
        error.cancelled_by = _ref(cancel_row)
        raise error
    return _ref(go_row)


def main(argv=None, runner=subprocess.run, now=None):
    parser = argparse.ArgumentParser(prog='moni_go.py', description="Read-only check of Moni's go in her chat")
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('check', help='exit 0 go stands, 4 cancelled after the go, 2 not found or unverifiable')
    check.add_argument('--go', required=True, metavar='HER_WORDS', help='her go, quoted from her chat')
    args = parser.parse_args(argv)
    try:
        found = verify(args.go, now=now, runner=runner)
    except RuntimeError as exc:
        code = str(exc)
        go = getattr(exc, 'go', None) or {'message_id': None, 'at': None, 'text': None}
        out = {'ok': False, 'error': code, **go}
        if code == 'MONI_CANCELLED_AFTER_GO':
            out['cancelled_by'] = exc.cancelled_by
        print(json.dumps(out))
        return EXIT_CANCELLED if code == 'MONI_CANCELLED_AFTER_GO' else EXIT_NOT_FOUND
    except Exception as exc:  # anything unexpected fails closed: no go
        print(json.dumps({'ok': False, 'error': 'MONI_GO_UNVERIFIABLE', 'detail': type(exc).__name__}))
        return EXIT_NOT_FOUND
    print(json.dumps({'ok': True, **found}))
    return EXIT_OK


if __name__ == '__main__':
    sys.exit(main())
