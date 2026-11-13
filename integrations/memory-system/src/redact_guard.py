"""Persist only record identifiers; a secret or its digest never becomes a rule."""
import json
import sqlite3

DDL = '''CREATE TABLE IF NOT EXISTS recall_redacted_ids(
    kind TEXT NOT NULL, value TEXT NOT NULL, marker TEXT NOT NULL,
    PRIMARY KEY(kind,value))'''
ID_KEYS = {'uuid', 'call_id', 'tool_use_id', 'tool_call_id', 'msg_id', 'rec_id', 'message_id'}


def identities(value):
    if isinstance(value, (str, bytes)):
        try:
            value = json.loads(value)
        except (ValueError, UnicodeError):
            return set()
    result = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(child, str) and (key in ID_KEYS or (key == 'id' and value.get('type') == 'tool_use')):
                result.add(child)
            elif isinstance(child, (dict, list)):
                result.update(identities(child))
    elif isinstance(value, list):
        for child in value:
            result.update(identities(child))
    return result


def marker_for(con, *, source=None, session=None, turn=None, payload=None, record_id=None, capture_id=None):
    # Most installations have no tombstones. Never create tables from a reader.
    if not con.execute("SELECT 1 FROM sqlite_master WHERE name='recall_redacted_ids'").fetchone():
        return None
    keys = [('id', json.dumps([session,i])) for i in identities(payload)] if session else []
    if record_id:
        keys.append(('id', json.dumps([session,record_id])))
    if capture_id and session:
        keys.append(('native',json.dumps([capture_id[0],session,capture_id[1]])))
    if source and session and turn:
        keys.append(('turn', json.dumps([source, session, turn])))
    for kind, value in keys:
        row = con.execute('SELECT marker FROM recall_redacted_ids WHERE kind=? AND value=?', (kind, value)).fetchone()
        if row:
            return row[0]
    return None


def event(con, source, session, turn, content, metadata, capture_id=None):
    marker = marker_for(con, source=source, session=session, turn=turn, payload=metadata, capture_id=capture_id)
    return (marker, json.dumps({'redacted': True})) if marker else (content, metadata)


def raw(con, payload, record_id=None, session=None, capture_id=None):
    marker = marker_for(con, payload=payload, record_id=record_id, session=session, capture_id=capture_id)
    return (json.dumps({'redacted': marker}) + '\n').encode() if marker else payload


class CaptureGuard:
    """A tick holds the shared fence, so its rule set cannot change mid-capture."""
    def __init__(self, con):
        self.con = con
        self.enabled = bool(con.execute("SELECT 1 FROM sqlite_master WHERE name='recall_redacted_ids'").fetchone())

    def event(self, source, session, turn, content, metadata, capture_id=None):
        return event(self.con,source,session,turn,content,metadata,capture_id) if self.enabled else (content,metadata)

    def raw(self, payload, record_id=None, session=None, capture_id=None):
        return raw(self.con,payload,record_id,session,capture_id) if self.enabled else payload
