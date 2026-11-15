"""Synthetic copy of #44's metadata schema; never reads a live bridge store."""
import sqlite3
from contextlib import closing

REQUEST = 'areq_' + 'a' * 64
SCHEMA = '''CREATE TABLE agent_requests (
    id TEXT PRIMARY KEY, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL, parent_id TEXT,
    hop INTEGER NOT NULL, status TEXT NOT NULL, text_chars INTEGER NOT NULL, answer_chars INTEGER,
    created_at INTEGER NOT NULL, answered_at INTEGER, timed_out_at INTEGER)'''


def create_bus(path, now, **changes):
    row = dict(id=REQUEST, from_slug='moni', to_slug='owner', parent_id=None, hop=1,
               status='open', text_chars=123, answer_chars=None,
               created_at=int(now.timestamp() * 1000), answered_at=None, timed_out_at=None)
    row.update(changes)
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute(SCHEMA)
        connection.execute('INSERT INTO agent_requests VALUES (' + ','.join('?' * len(row)) + ')',
                           tuple(row.values()))


def update_bus(path, **changes):
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute('UPDATE agent_requests SET ' + ','.join(k + '=?' for k in changes),
                           tuple(changes.values()))
