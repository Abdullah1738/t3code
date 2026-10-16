"""Moni's own go for an order placed on her behalf.

Abdullah's standing approval covers paying for Moni's orders, not choosing
them. Before a `--for moni` order is placed, the caller passes her words
(`--moni-go "yes order it"`) and this module confirms that a message from her,
containing those words, arrived in her chat within the window. It fails closed:
no matching message, or no readable history, means no order.
"""
import datetime as dt
import json
import re
import subprocess
import unicodedata

MONI_CHAT_ID = '45'
WINDOW_MINUTES = 45
HISTORY_LIMIT = 80


def normalize(text):
    text = unicodedata.normalize('NFKC', text or '').lower()
    text = re.sub(r"['\u2018\u2019]", '', text)
    text = re.sub(r'[^\w\s]', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def _parse_time(value):
    try:
        return dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None


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


def verify(go_text, *, now=None, window_minutes=WINDOW_MINUTES, runner=subprocess.run):
    """Return the matching message or raise RuntimeError with a stable code."""
    wanted = normalize(go_text)
    if len(wanted) < 2:
        raise RuntimeError('MONI_GO_REQUIRED')
    rows = read_history(runner)
    if rows is None:
        raise RuntimeError('MONI_GO_UNVERIFIABLE')
    now = now or dt.datetime.now(dt.timezone.utc)
    oldest = now - dt.timedelta(minutes=window_minutes)
    for row in rows:
        if row.get('is_from_me') or str(row.get('chat_id')) != MONI_CHAT_ID:
            continue
        at = _parse_time(row.get('created_at'))
        if at is None or at < oldest or at > now + dt.timedelta(minutes=2):
            continue
        if f' {wanted} ' in f" {normalize(row.get('text'))} ":
            return {'message_id': row.get('id'), 'at': row.get('created_at'), 'text': row.get('text')}
    raise RuntimeError('MONI_GO_NOT_FOUND')
