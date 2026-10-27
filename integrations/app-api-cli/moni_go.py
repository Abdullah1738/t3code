"""Moni's own go for an order placed on her behalf.

Abdullah's standing approval covers paying for Moni's orders, not choosing
them. Before a `--for moni` order is placed, the caller passes her words
(`--moni-go "yes order it"`) and this module confirms that a message from her,
containing those words, arrived within the window, and that she did not call
it off in a later message. Her messages come from three kinds of place, merged
in time order: her iMessage chat with Abdullah (chat 45), her Robob 1:1 thread
(the bridge's `moni` chat DB), and any group chat she is in (bridge
`group-*` chat DBs, or one named with --chat). In a group only her own
addresses count; Abdullah's group messages are ignored. It fails closed: no
matching message, any source unreadable, or a later cancel from her in any of
them means no order.

Agents can run the same check before any order step (prepare-only, resume,
recover) without placing anything:

    python3 moni_go.py check --go "<her words>" [--chat group-sb_gro]

It prints JSON and exits 0 (go stands), 4 (she cancelled after it) or 2 (no
go found, or her messages could not be read). It only runs `imsg history` and
read-only opens of the bridge chat DBs.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import unicodedata

MONI_CHAT_ID = '45'
MONI_NUMBER = '+971585933213'
# Her addresses in bridge rows: her phone and her Gmail. In a group chat only these count as her.
MONI_ADDRESSES = ('+971585933213', 'monikagaleckaite@gmail.com')
BRIDGE_DB = Path.home() / '.config/spectrum-bridge/chats/moni/state.sqlite'
CHAT_SLUG = re.compile(r'[a-z0-9][a-z0-9_-]{0,63}')
_NEVER = dt.datetime.max.replace(tzinfo=dt.timezone.utc)
# Bridge rows get string ids, so they never collide with imsg's integer ids.
BRIDGE_ID_PREFIX = 'bridge:'
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


def _restarts(text, wanted, rego_by_words):
    """True when a message after a cancel puts her order back on: her specific go words, or a clear
    go phrase. "ok order it myself" is her ordering it herself, so it never restarts."""
    if _has(text, 'myself'):
        return False
    return (rego_by_words and _has(text, wanted)) or any(_has(text, p) for p in GO_PHRASES)


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


# iMessage tapbacks arrive as text quoting the message they react to; the quote is not her words.
TAPBACK = re.compile(r'^\s*(?:loved|liked|disliked|laughed at|emphasized|questioned|reacted .{1,16} to|'
                     r'removed an? .{1,24} from|labai patiko|pasijuokta i\u0161)\s+["\u201c\u201e]', re.I)
# Attachment tapbacks ("Loved an image") quote nothing, so they are matched at the end of the text.
TAPBACK_ATTACHMENT = re.compile(r'^\s*(?:loved|liked|disliked|laughed at|emphasized|questioned|reacted .{1,16} to)\s+'
                                r'an?\s+(?:image|photo|video|attachment|audio message|sticker)\s*$', re.I)


def _address(value):
    return str(value).strip().casefold()


_MONI_KEYS = frozenset(_address(a) for a in MONI_ADDRESSES)


def chats_dir():
    return Path(os.environ.get('MONI_BRIDGE_CHATS_DIR') or '~/.config/spectrum-bridge/chats').expanduser()


def bridge_paths(chat=None):
    """Bridge chat DBs to read: her 1:1, plus `chat` when given, else every group chat.

    MONI_BRIDGE_DB (legacy override, used by tests) still names the only DB.
    """
    if chat is not None and not CHAT_SLUG.fullmatch(chat):
        raise RuntimeError('MONI_GO_CHAT_INVALID')
    if os.environ.get('MONI_BRIDGE_DB'):
        return [Path(os.environ['MONI_BRIDGE_DB'])]
    root = chats_dir()
    if chat is not None:
        slugs = ['moni'] if chat == 'moni' else ['moni', chat]
        return [root / slug / 'state.sqlite' for slug in slugs]
    return [root / 'moni' / 'state.sqlite', *sorted(root.glob('group-*/state.sqlite'))]


def _bridge_time(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def read_bridge(path=None):
    """Her inbound rows from her Robob thread (bridge moni chat DB), read-only, oldest first.

    None when the DB or any row can't be read, so the caller fails closed.
    """
    db = Path(path or os.environ.get('MONI_BRIDGE_DB') or BRIDGE_DB)
    try:
        con = sqlite3.connect(f'{db.absolute().as_uri()}?mode=ro', uri=True, timeout=5)
        try:
            raw = con.execute('select id, payload from inbound order by rowid').fetchall()
        finally:
            con.close()
    except (OSError, ValueError, RuntimeError, sqlite3.Error):
        return None
    group = db.parent.name.startswith('group-')
    rows = []
    for row_id, payload in raw:
        try:
            item = json.loads(payload)
        except (TypeError, json.JSONDecodeError):
            return None
        if not isinstance(item, dict):
            return None
        sender = item.get('sender')
        # Bridge wakes and other machine rows carry no sender.
        if not isinstance(sender, str) or not sender.strip():
            continue
        who = _address(sender)
        # In a group, anyone but Moni (Abdullah included) is not her, so their words are ignored.
        if group and who not in _MONI_KEYS:
            continue
        text = item.get('text')
        tapback = isinstance(text, str) and bool(TAPBACK.match(text) or TAPBACK_ATTACHMENT.match(text))
        # sentAt is when she sent it; receivedAt can be a late backfill. Fall back only when sentAt is absent.
        sent = item.get('sentAt')
        when = sent if sent is not None else item.get('receivedAt')
        rows.append({'id': f'{BRIDGE_ID_PREFIX}{row_id}', 'created_at': _bridge_time(when),
                     '_receipt_time': sent is None,
                     'text': text, '_bridge': True,
                     # Only her number starts an order; a tapback or her other address can only call it off.
                     '_cancel_only': tapback or who != _address(MONI_NUMBER),
                     # A voice note's words are not in the row, so it could be a cancel.
                     '_opaque': item.get('isAudioMessage') is True,
                     '_source': str(db)})
    return rows


def read_bridges(paths):
    """Rows from every bridge DB in `paths`, merged oldest first; None if any one can't be read."""
    merged = []
    for path in paths:
        rows = read_bridge(path)
        if rows is None:
            return None
        merged.extend(rows)
    merged.sort(key=lambda row: _parse_time(row.get('created_at')) or _NEVER)
    return merged


def _source_of(row):
    return row.get('_source') or 'imsg'


def _ambiguous_rows(go_row, mine):
    """Cross-DB cancels whose send order against this go cannot be proven.

    A row with a send time (sentAt) is ordered by it. A row without one (receipt only) was
    sent at or before its receipt time, so it can only be placed relative to a timed row
    when that bound settles the order: a receipt-only cancel received before a timed go
    was sent, or a receipt-only go received before a timed cancel was sent. Anything else
    (two receipt-only rows, or a receipt time that overlaps the other row) is ambiguous.
    Chat 45 rows are excluded: verify's own guard covers them.
    """
    if not go_row.get('_bridge'):
        return []
    go_timed = not go_row.get('_receipt_time')
    go_at = _parse_time(go_row.get('created_at'))
    out = []
    for row in mine:
        if not row.get('_bridge') or _source_of(row) == _source_of(go_row):
            continue
        if not (row.get('_opaque') or reads_as_cancel(row.get('text'))):
            continue
        row_timed = not row.get('_receipt_time')
        row_at = _parse_time(row.get('created_at'))
        if go_at is None or row_at is None:
            out.append(row)
        elif go_timed and row_timed:
            continue
        elif go_timed and not row_timed:
            # The cancel was sent no later than its receipt; it is before the go only if received before the go was sent.
            if row_at >= go_at:
                out.append(row)
        elif not go_timed and row_timed:
            # The go was sent no later than its receipt; it is before the cancel only if received before the cancel was sent.
            if go_at >= row_at:
                out.append(row)
        else:
            out.append(row)
    return out


def _proven_before(row, go_row):
    """True when the cancel is provably sent before this go: the go is timed and the cancel's
    upper bound on send time (its own send time, or its receipt) is earlier than it."""
    if go_row.get('_receipt_time'):
        return False
    row_at = _parse_time(row.get('created_at'))
    go_at = _parse_time(go_row.get('created_at'))
    return row_at is not None and go_at is not None and row_at < go_at


def _moni_rows(rows, oldest, latest, bridge_rows=()):
    """Her own messages from both sources inside the window, oldest first, and the
    ids of hers whose time would not parse. On equal times a cancel sorts last, then
    chat 45 by id."""
    kept, unparsed = [], []
    tagged = [(row, None) for row in rows] + [(row, seq) for seq, row in enumerate(bridge_rows)]
    for row, seq in tagged:
        if seq is None and (row.get('is_from_me') or str(row.get('chat_id')) != MONI_CHAT_ID):
            continue
        at = _parse_time(row.get('created_at'))
        if at is None:
            # No usable id either: treat it as newer than the go (fail closed). Bridge ids
            # can't be compared with chat 45's, so a bridge row without a time always is.
            unparsed.append(float('inf') if seq is not None else _row_id(row, missing=float('inf')))
            continue
        if at < oldest or at > latest:
            continue
        stops = bool(row.get('_opaque')) or reads_as_cancel(row.get('text'))
        kept.append((at, stops, seq is not None, _row_id(row) if seq is None else seq, row))
    kept.sort(key=lambda item: item[:4])
    return [item[-1] for item in kept], unparsed


def verify(go_text, *, now=None, window_minutes=WINDOW_MINUTES, runner=subprocess.run, bridge=None, chat=None):
    """Return the go that stands or raise RuntimeError with a stable code.

    Walks her messages from both sources in time order from the first one with
    her go words. Cancels before it don't count. After it, a cancel calls the
    order off (even in a message that repeats the go words), and only her go
    words again or a clear go phrase put it back on. The latest state decides.
    A tapback quotes someone else's words, so it can call an order off but
    never starts one.
    """
    wanted = normalize(go_text)
    if len(wanted) < 2:
        raise RuntimeError('MONI_GO_REQUIRED')
    if bridge is None:
        paths = bridge_paths(chat)
        bridge = lambda: read_bridges(paths)
    rows = read_history(runner)
    bridge_rows = bridge()
    if rows is None or bridge_rows is None:
        raise RuntimeError('MONI_GO_UNVERIFIABLE')
    now = now or dt.datetime.now(dt.timezone.utc)
    oldest = now - dt.timedelta(minutes=window_minutes)
    # After a cancel, only a clear go phrase, or her go words when they are specific, put it back on.
    rego_by_words = len(wanted.split()) >= REGO_MIN_WORDS
    go_row = cancel_row = unheard = bridge_go_at = None
    # Every go a later message replaced: a short repeat must not restart an order whose
    # original go is still unprovably ordered against a cancel from another source.
    replaced = []
    mine, unparsed = _moni_rows(rows, oldest, now + dt.timedelta(minutes=2), bridge_rows)
    for row in mine:
        if go_row is not None and go_row.get('_bridge'):
            bridge_go_at = _parse_time(go_row.get('created_at'))
        text = normalize(row.get('text'))
        if row.get('_opaque'):
            unheard = unheard or (row if go_row is not None else None)
            continue
        if row.get('_cancel_only'):
            if go_row is not None and reads_as_cancel(text):
                cancel_row = cancel_row or row
            continue
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
                replaced.append(go_row)
                go_row = row
        elif _restarts(text, wanted, rego_by_words):
            replaced.append(go_row)
            go_row, cancel_row = row, None
    if go_row is not None and go_row.get('_bridge'):
        bridge_go_at = _parse_time(go_row.get('created_at'))
    if go_row is None:
        raise RuntimeError('MONI_GO_NOT_FOUND')
    if any(mid > _row_id(go_row) for mid in unparsed) or unheard is not None:
        # A newer message of hers has no readable time or words; it could be a cancel after the go.
        raise RuntimeError('MONI_GO_UNVERIFIABLE')
    if _ambiguous_rows(go_row, mine):
        raise RuntimeError('MONI_GO_UNVERIFIABLE')
    # A repeat that replaced an earlier go keeps that go's uncertainty, unless the final go is
    # clear (specific words) and provably sent after each conflicting cancel.
    final_clear = _restarts(normalize(go_row.get('text')), wanted, rego_by_words)
    for candidate in replaced:
        for row in _ambiguous_rows(candidate, mine):
            if not (final_clear and _proven_before(row, go_row)):
                raise RuntimeError('MONI_GO_UNVERIFIABLE')
    if cancel_row is None and bridge_go_at is not None:
        # Bridge times are when the bridge stored a message, which can lag her send by any
        # amount, so once a go from her Robob thread counted, a chat 45 cancel anywhere
        # before it in the window may really have come after it.
        cancel_row = next((row for row in mine if not row.get('_bridge')
                           and _parse_time(row.get('created_at')) <= bridge_go_at
                           and reads_as_cancel(row.get('text'))), None)
    if cancel_row is not None:
        error = RuntimeError('MONI_CANCELLED_AFTER_GO')
        error.go = _ref(go_row)
        error.cancelled_by = _ref(cancel_row)
        raise error
    return _ref(go_row)


def main(argv=None, runner=subprocess.run, now=None, bridge=None):
    parser = argparse.ArgumentParser(prog='moni_go.py', description="Read-only check of Moni's go in her messages")
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('check', help='exit 0 go stands, 4 cancelled after the go, 2 not found or unverifiable')
    check.add_argument('--go', required=True, metavar='HER_WORDS', help='her go, quoted from her chat')
    check.add_argument('--chat', default=None, metavar='SLUG',
                       help='bridge chat where she gave the go, e.g. group-sb_gro; default: her 1:1 plus every group chat')
    args = parser.parse_args(argv)
    try:
        found = verify(args.go, now=now, runner=runner, bridge=bridge, chat=args.chat)
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
