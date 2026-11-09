#!/usr/bin/env python3
"""Paced native-session export. This is the sole memory-system live DB reader."""

import argparse
import fcntl
import json
import os
import sqlite3
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from robob_readonly import safe_path


class ReadBudgetExceeded(RuntimeError):
    pass


def quote(name):
    return '"' + name.replace('"', '""') + '"'


class Exporter:
    def __init__(self, source, destination, *, page_size=32, chunk_size=65536, read_ms=25):
        self.source_path = Path(source).expanduser().resolve()
        self.path = safe_path(destination)
        if self.path == self.source_path or self.path.name in ('opencode.db', 'statev2.sqlite'):
            raise ValueError('export destination must be separate from live state')
        if self.path.exists() and os.path.samefile(self.source_path, self.path):
            raise ValueError('export destination aliases source')
        if not 1 <= page_size <= 100 or not 1024 <= chunk_size <= 262144 or not 1 <= read_ms <= 100:
            raise ValueError('invalid native export bounds')
        self.page_size, self.chunk_size, self.read_ms = page_size, chunk_size, read_ms
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lock = open(str(self.path) + '.export.lock', 'a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock.close()
            raise RuntimeError('native exporter already running') from None
        self.src = None
        self.out = None
        try:
            self.src = sqlite3.connect(self.source_path.as_uri() + '?mode=ro', uri=True,
                                       timeout=0, isolation_level=None)
            self.src.execute('PRAGMA query_only=ON')
            self.src.execute('PRAGMA busy_timeout=0')
            self.src.execute('PRAGMA cache_size=-8192')
            self.src.execute('PRAGMA mmap_size=0')
            if self.src.execute('PRAGMA journal_mode').fetchone()[0].lower() != 'wal':
                raise RuntimeError('native source must use WAL')
            self.out = sqlite3.connect(self.path, timeout=0, isolation_level=None)
            os.chmod(self.path, 0o600)
            self.out.executescript('''
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;
                PRAGMA journal_size_limit=33554432;
                PRAGMA recursive_triggers=ON;
                CREATE TABLE IF NOT EXISTS ardud_readonly_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS ardud_native_sessions(
                    id TEXT PRIMARY KEY, applied_seq INTEGER, dirty INTEGER NOT NULL DEFAULT 1,
                    cursor INTEGER NOT NULL DEFAULT -1, generation INTEGER NOT NULL DEFAULT 0,
                    seen INTEGER NOT NULL DEFAULT 0, captured_ms INTEGER NOT NULL DEFAULT 0,
                    prune_cursor TEXT NOT NULL DEFAULT '',upper_seq INTEGER NOT NULL DEFAULT -1,
                    attempted INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS ardud_native_messages(
                    id TEXT PRIMARY KEY,session_id TEXT NOT NULL,seen INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,length INTEGER NOT NULL,captured_ms INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS ardud_native_messages_session ON ardud_native_messages(session_id,id);
                CREATE TABLE IF NOT EXISTS ardud_native_payload(
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,session_id TEXT NOT NULL,
                    source_rowid INTEGER NOT NULL,source_seq INTEGER NOT NULL,time_updated INTEGER NOT NULL,
                    offset INTEGER NOT NULL,length INTEGER NOT NULL,metadata TEXT NOT NULL,payload_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS ardud_native_message_rows(
                    id TEXT PRIMARY KEY,session_id TEXT NOT NULL,type TEXT NOT NULL,seq INTEGER NOT NULL,
                    time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL,payload_id TEXT NOT NULL);
                CREATE UNIQUE INDEX IF NOT EXISTS ardud_native_message_seq ON ardud_native_message_rows(session_id,seq);
                CREATE INDEX IF NOT EXISTS ardud_native_message_payload ON ardud_native_message_rows(payload_id);
                CREATE TABLE IF NOT EXISTS ardud_native_chunks(
                    payload_id TEXT NOT NULL,position INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(payload_id,position));
                CREATE TABLE IF NOT EXISTS ardud_native_retired(payload_id TEXT PRIMARY KEY);
                CREATE TRIGGER IF NOT EXISTS ardud_native_retire_message_delete
                    AFTER DELETE ON ardud_native_message_rows BEGIN
                    INSERT OR IGNORE INTO ardud_native_retired VALUES (old.payload_id); END;
                CREATE TRIGGER IF NOT EXISTS ardud_native_retire_message_update
                    AFTER UPDATE OF payload_id ON ardud_native_message_rows
                    WHEN old.payload_id != new.payload_id BEGIN
                    INSERT OR IGNORE INTO ardud_native_retired VALUES (old.payload_id); END;
                CREATE TRIGGER IF NOT EXISTS ardud_native_retire_partial
                    AFTER DELETE ON ardud_native_payload
                    WHEN NOT EXISTS (SELECT 1 FROM ardud_native_message_rows WHERE payload_id=old.payload_id)
                    BEGIN INSERT OR IGNORE INTO ardud_native_retired VALUES (old.payload_id); END;
                CREATE VIEW IF NOT EXISTS session_message AS
                    SELECT id,session_id,type,seq,time_created,time_updated,
                      (SELECT CAST(group_concat(data,'') AS TEXT) FROM
                        (SELECT data FROM ardud_native_chunks c WHERE c.payload_id=m.payload_id ORDER BY position)) AS data
                    FROM ardud_native_message_rows m;
                CREATE TABLE IF NOT EXISTS session_inbox(id TEXT PRIMARY KEY,session_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS session_pending(id TEXT PRIMARY KEY,session_id TEXT NOT NULL);
            ''')
            identity = f'{self.source_path}:{self.source_path.stat().st_dev}:{self.source_path.stat().st_ino}'
            if self.meta('source') not in (None, identity):
                raise RuntimeError('native source replaced; rebuild disposable export')
            self.setmeta('source', identity)
            self.identity = identity
            self.schema_version = self.src.execute('PRAGMA schema_version').fetchone()[0]
            self.change_version = self.src.execute('PRAGMA data_version').fetchone()[0]
            self.setmeta('ready', '0')
            self.setmeta('schema_version', '1')
            self.columns = [r[1:3] for r in self.read('PRAGMA table_info(session_v2)')]
            for table, required_columns in (
                ('event_sequence', {'aggregate_id', 'seq'}),
                ('session_message', {'id', 'session_id', 'type', 'seq', 'time_created', 'time_updated', 'data'}),
                ('session_inbox', {'id', 'session_id'}), ('session_pending', {'id', 'session_id'}),
            ):
                actual = {r[1] for r in self.read('PRAGMA table_info(' + quote(table) + ')')}
                if not required_columns <= actual:
                    raise RuntimeError('native source schema unsupported')
            required = {'id', 'parent_id', 'directory', 'title', 'metadata', 'time_created',
                        'time_updated', 'time_viewed', 'time_suspended'}
            if not required <= {c[0] for c in self.columns}:
                raise RuntimeError('native session schema unsupported')
            shape = json.dumps(self.columns)
            if self.meta('session_schema') not in (None, shape):
                raise RuntimeError('native schema changed; rebuild disposable export')
            self.setmeta('session_schema', shape)
            # Capture archives SELECT * on session_v2, so every native session
            # field is part of its lossless contract. No unrelated tables/FKs.
            self.out.execute('CREATE TABLE IF NOT EXISTS session_v2(' + ','.join(
                quote(name) + ' ' + kind + (' PRIMARY KEY' if name == 'id' else '')
                for name, kind in self.columns) + ')')
            self.names = [c[0] for c in self.columns]
            self.session_upsert = ('INSERT INTO session_v2(' + ','.join(map(quote, self.names)) + ') VALUES ('
                                   + ','.join('?' for _ in self.names) + ') ON CONFLICT(id) DO UPDATE SET '
                                   + ','.join(f'{quote(c)}=excluded.{quote(c)}' for c in self.names if c != 'id'))
            self.out.execute('CREATE INDEX IF NOT EXISTS ardud_native_parent ON session_v2(parent_id)')
            self.out.execute('CREATE INDEX IF NOT EXISTS ardud_native_dirty ON ardud_native_sessions(id) WHERE dirty=1')
            # Start each dirty session at its durable boundary after a process
            # restart; a persisted chunk can finish, but no old prune phase wins.
            self.out.execute('UPDATE ardud_native_sessions SET cursor=-1 WHERE dirty=1')
            self.resumed_payload = bool(self.out.execute('SELECT 1 FROM ardud_native_payload').fetchone())
            self.rescan_after_payload = self.resumed_payload
            # A restart revalidates all small session/queue metadata before
            # resuming payload work; incomplete blobs remain private and resumable.
            self.begin_cycle()
        except BaseException:
            self.close()
            raise

    def meta(self, key):
        row = self.out.execute('SELECT value FROM ardud_readonly_meta WHERE key=?', (key,)).fetchone()
        return row[0] if row else None

    def setmeta(self, key, value):
        self.out.execute('INSERT INTO ardud_readonly_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                         (key, str(value)))

    @contextmanager
    def write(self):
        self.out.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.out.execute('COMMIT')
        except BaseException:
            self.out.execute('ROLLBACK')
            raise

    def read(self, query, params=()):
        """No explicit source transaction survives fetchall, a yield or a target write."""
        until = time.monotonic() + self.read_ms / 1000
        self.src.set_progress_handler(lambda: int(time.monotonic() >= until), 200)
        try:
            return self.src.execute(query, params).fetchall()
        except sqlite3.OperationalError as exc:
            if 'interrupt' in str(exc):
                raise ReadBudgetExceeded('native read exceeded page budget') from None
            raise
        finally:
            self.src.set_progress_handler(None, 0)

    def event_seq(self, sid):
        rows = self.read('SELECT seq FROM event_sequence WHERE aggregate_id=?', (sid,))
        return rows[0][0] if rows else -1

    def begin_cycle(self):
        identity = f'{self.source_path}:{self.source_path.stat().st_dev}:{self.source_path.stat().st_ino}'
        if identity != self.identity:
            raise RuntimeError('native source replaced; reopen exporter')
        if self.read('PRAGMA schema_version')[0][0] != self.schema_version:
            raise RuntimeError('native schema changed; reopen exporter')
        with self.write():
            self.setmeta('ready', '0')
            self.generation = int(self.meta('generation') or 0) + 1
            self.setmeta('generation', self.generation)
        self.started_us = time.time_ns() // 1000
        self.change_version = self.read('PRAGMA data_version')[0][0]
        self.clear_staging = True
        self.missing_sid = None
        self.scan_cursor = 0
        self.phase = 'sessions'
        self.validating = False
        self.prune_cursor = ''
        self.queue_cursor = 0
        self.pin_cursor = ''

    def sessions_page(self):
        cols = ','.join('s.' + quote(c) for c in self.names)
        rows = self.read(f'SELECT s.rowid,{cols},coalesce(e.seq,-1) FROM session_v2 s '
                         'LEFT JOIN event_sequence e ON e.aggregate_id=s.id '
                         'WHERE s.rowid>? ORDER BY s.rowid LIMIT ?', (self.scan_cursor, self.page_size))
        with self.write():
            for row in rows:
                values, seq = row[1:-1], row[-1]
                sid = values[self.names.index('id')]
                self.out.execute(self.session_upsert, values)
                old = self.out.execute('SELECT applied_seq,dirty FROM ardud_native_sessions WHERE id=?', (sid,)).fetchone()
                self.out.execute('INSERT INTO ardud_native_sessions(id,seen) VALUES (?,?) '
                                 'ON CONFLICT(id) DO UPDATE SET seen=excluded.seen', (sid, self.generation))
                if old is None or old[0] != seq:
                    self.out.execute('UPDATE ardud_native_sessions SET dirty=1 WHERE id=?', (sid,))
            if rows:
                self.scan_cursor = rows[-1][0]
        if len(rows) < self.page_size:
            self.phase = 'prune_sessions'

    def prune_sessions(self):
        rows = self.out.execute('SELECT id FROM ardud_native_sessions WHERE id>? ORDER BY id LIMIT ?',
                                (self.prune_cursor, self.page_size)).fetchall()
        with self.write():
            for (sid,) in rows:
                seen = self.out.execute('SELECT seen FROM ardud_native_sessions WHERE id=?', (sid,)).fetchone()[0]
                if seen != self.generation:
                    # Delete messages in pages; one old session may contain GBs.
                    ids = self.out.execute('SELECT id FROM ardud_native_message_rows WHERE session_id=? LIMIT ?', (sid, self.page_size)).fetchall()
                    for (mid,) in ids:
                        self.out.execute('DELETE FROM ardud_native_message_rows WHERE id=?', (mid,))
                        self.out.execute('DELETE FROM ardud_native_messages WHERE id=?', (mid,))
                    if ids:
                        return
                    self.out.execute('DELETE FROM session_v2 WHERE id=?', (sid,))
                    self.out.execute('DELETE FROM ardud_native_sessions WHERE id=?', (sid,))
                    self.out.execute('DELETE FROM ardud_native_payload WHERE session_id=?', (sid,))
                self.prune_cursor = sid
        if len(rows) < self.page_size:
            self.phase = 'session_inbox' if self.validating else 'messages'

    def start_payload(self, row, seq):
        rid, mid, sid, kind, ordinal, created, updated = row
        # blobopen gives constant-size reads even for a 500 MB JSON cell. Close
        # it before every target write/pause so no WAL reader is pinned across ticks.
        with self.src.blobopen('session_message', 'data', rid, readonly=True) as blob:
            length = len(blob)
        with self.write():
            self.out.execute('INSERT OR REPLACE INTO ardud_native_payload VALUES (1,?,?,?,?,?,0,?,?,?)',
                             (mid, sid, rid, seq, updated, length,
                              json.dumps([mid, sid, kind, ordinal, created, updated]), uuid.uuid4().hex))

    def payload_step(self, state):
        _, mid, sid, rid, seq, updated, offset, length, metadata, payload_id = state
        current = self.read('SELECT id,time_updated FROM session_message WHERE rowid=?', (rid,))
        current_seq = self.event_seq(sid)
        if current != [(mid, updated)] or current_seq != seq:
            with self.write():
                self.out.execute('DELETE FROM ardud_native_payload')
                self.out.execute('DELETE FROM ardud_native_messages WHERE id=?', (mid,))
                self.out.execute('DELETE FROM ardud_native_message_rows WHERE id=?', (mid,))
                self.out.execute('UPDATE ardud_native_sessions SET cursor=-1,dirty=1,attempted=? WHERE id=?', (self.generation, sid))
            return
        with self.src.blobopen('session_message', 'data', rid, readonly=True) as blob:
            same_length = len(blob) == length
            if same_length:
                blob.seek(offset)
                chunk = blob.read(min(self.chunk_size, length - offset))
        if not same_length:
            self.out.execute('DELETE FROM ardud_native_payload')
            return
        with self.write():
            self.out.execute('INSERT OR REPLACE INTO ardud_native_chunks VALUES (?,?,?)', (payload_id, offset, chunk))
            self.out.execute('UPDATE ardud_native_payload SET offset=? WHERE singleton=1', (offset + len(chunk),))
        if offset + len(chunk) < length:
            return
        # Version check after the final source chunk, with no held read snapshot.
        current = self.read('SELECT id,time_updated FROM session_message WHERE rowid=?', (rid,))
        if current != [(mid, updated)] or self.event_seq(sid) != seq:
            with self.write():
                self.out.execute('DELETE FROM ardud_native_payload')
                self.out.execute('DELETE FROM ardud_native_messages WHERE id=?', (mid,))
                self.out.execute('DELETE FROM ardud_native_message_rows WHERE id=?', (mid,))
                self.out.execute('UPDATE ardud_native_sessions SET cursor=-1,attempted=? WHERE id=?', (self.generation, sid))
            return
        fields = json.loads(metadata)
        generation = self.out.execute('SELECT generation FROM ardud_native_sessions WHERE id=?', (sid,)).fetchone()[0]
        with self.write():
            conflicting = self.out.execute('SELECT id FROM ardud_native_message_rows WHERE session_id=? AND seq=? AND id!=?', (sid, fields[3], mid)).fetchone()
            if conflicting:
                self.out.execute('DELETE FROM ardud_native_message_rows WHERE id=?', conflicting)
                self.out.execute('DELETE FROM ardud_native_messages WHERE id=?', conflicting)
            self.out.execute('INSERT INTO ardud_native_message_rows VALUES (?,?,?,?,?,?,?) '
                             'ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,type=excluded.type,seq=excluded.seq,'
                             'time_created=excluded.time_created,time_updated=excluded.time_updated,payload_id=excluded.payload_id', fields + [payload_id])
            self.out.execute('INSERT OR REPLACE INTO ardud_native_messages VALUES (?,?,?,?,?,?)',
                             (mid, sid, generation, updated, length, int(time.time() * 1000)))
            self.out.execute('UPDATE ardud_native_sessions SET cursor=? WHERE id=?', (-1 if self.rescan_after_payload else fields[3], sid))
            self.out.execute('DELETE FROM ardud_native_payload')
            self.resumed_payload = False
            self.rescan_after_payload = False

    def messages_step(self):
        if self.missing_sid:
            sid = self.missing_sid
            rows = self.out.execute('SELECT id FROM ardud_native_message_rows WHERE session_id=? LIMIT ?', (sid, self.page_size)).fetchall()
            with self.write():
                for (mid,) in rows:
                    self.out.execute('DELETE FROM ardud_native_message_rows WHERE id=?', (mid,))
                    self.out.execute('DELETE FROM ardud_native_messages WHERE id=?', (mid,))
                if not rows:
                    self.out.execute('DELETE FROM session_v2 WHERE id=?', (sid,))
                    self.out.execute('DELETE FROM ardud_native_sessions WHERE id=?', (sid,))
                    self.out.execute('DELETE FROM ardud_native_payload WHERE session_id=?', (sid,))
                    self.missing_sid = None
            return
        state = self.out.execute('SELECT singleton,id,session_id,source_rowid,source_seq,time_updated,offset,length,metadata,payload_id FROM ardud_native_payload').fetchone()
        if state:
            self.payload_step(state)
            return
        session = self.out.execute('SELECT id,applied_seq,cursor,generation,captured_ms FROM ardud_native_sessions WHERE dirty=1 AND attempted!=? LIMIT 1', (self.generation,)).fetchone()
        if session is None:
            self.phase = 'session_inbox'
            return
        sid, applied, cursor, generation, captured = session
        if not self.read('SELECT 1 FROM session_v2 WHERE id=?', (sid,)):
            self.missing_sid = sid
            return
        seq = self.event_seq(sid)
        expected = self.meta('working_seq:' + sid)
        if cursor == -1 or expected is None:
            upper = self.read('SELECT seq FROM session_message WHERE session_id=? ORDER BY seq DESC LIMIT 1', (sid,))
            upper = upper[0][0] if upper else -1
            with self.write():
                generation = int(self.meta('message_generation') or 0) + 1
                self.setmeta('message_generation', generation)
                self.setmeta('working_seq:' + sid, seq)
                self.out.execute("UPDATE ardud_native_sessions SET cursor=-1,generation=?,prune_cursor='',upper_seq=? WHERE id=?", (generation, upper, sid))
            cursor = -1
            expected = str(seq)
        upper = self.out.execute('SELECT upper_seq FROM ardud_native_sessions WHERE id=?', (sid,)).fetchone()[0]
        rows = self.read('SELECT rowid,id,session_id,type,seq,time_created,time_updated FROM session_message '
                         'WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 1', (sid, cursor, upper))
        if rows:
            row = rows[0]
            # time_updated is not a monotonic revision: already-published
            # same-ms rewrites must not become permanent timestamp-cache hits.
            # Unchanged aggregate sequences skip the whole session instead.
            self.start_payload(row, seq)
            return
        prune_cursor = self.out.execute('SELECT prune_cursor FROM ardud_native_sessions WHERE id=?', (sid,)).fetchone()[0]
        candidates = self.out.execute('SELECT id,seen FROM ardud_native_messages WHERE session_id=? AND id>? ORDER BY id LIMIT ?',
                                      (sid, prune_cursor, self.page_size)).fetchall()
        if candidates:
            with self.write():
                for mid, seen in candidates:
                    if seen != generation:
                        self.out.execute('DELETE FROM ardud_native_message_rows WHERE id=?', (mid,))
                        self.out.execute('DELETE FROM ardud_native_messages WHERE id=?', (mid,))
                self.out.execute('UPDATE ardud_native_sessions SET prune_cursor=? WHERE id=?', (candidates[-1][0], sid))
            return
        # Complete this bounded session pass at its starting event fence. New
        # activity is caught next cycle, rather than starving all old history
        # behind a constantly streaming session.
        self.out.execute('UPDATE ardud_native_sessions SET applied_seq=?,dirty=0,cursor=-1,captured_ms=? WHERE id=?',
                         (int(expected) if expected is not None else seq, int(time.time() * 1000), sid))

    def queues_step(self, table):
        rows = self.read(f'SELECT rowid,id,session_id FROM {quote(table)} WHERE rowid>? ORDER BY rowid LIMIT ?',
                         (self.queue_cursor, self.page_size))
        with self.write():
            for rid, mid, sid in rows:
                self.out.execute(f'INSERT OR REPLACE INTO {quote(table)} VALUES (?,?)', (mid, sid))
            if rows:
                self.queue_cursor = rows[-1][0]
        if len(rows) < self.page_size:
            self.phase = 'prune_' + table
            self.prune_cursor = ''

    def prune_queue(self, table):
        rows = self.out.execute(f'SELECT id FROM {quote(table)} WHERE id>? ORDER BY id LIMIT ?',
                                (self.prune_cursor, self.page_size)).fetchall()
        for (mid,) in rows:
            current = self.read(f'SELECT session_id FROM {quote(table)} WHERE id=?', (mid,))
            if not current:
                self.out.execute(f'DELETE FROM {quote(table)} WHERE id=?', (mid,))
            self.prune_cursor = mid
        if len(rows) < self.page_size:
            self.queue_cursor = 0
            self.phase = 'session_pending' if table == 'session_inbox' else 'pins'

    def step(self):
        if self.clear_staging:
            self.out.execute('DELETE FROM session_inbox WHERE id IN (SELECT id FROM session_inbox LIMIT ?)', (self.page_size,))
            self.out.execute('DELETE FROM session_pending WHERE id IN (SELECT id FROM session_pending LIMIT ?)', (self.page_size,))
            self.clear_staging = bool(self.out.execute('SELECT 1 FROM session_inbox UNION ALL SELECT 1 FROM session_pending LIMIT 1').fetchone())
            return True
        if self.phase == 'sessions':
            self.sessions_page()
        elif self.phase == 'prune_sessions':
            self.prune_sessions()
        elif self.phase == 'messages':
            self.messages_step()
        elif self.phase in ('session_inbox', 'session_pending'):
            self.queues_step(self.phase)
        elif self.phase.startswith('prune_session_'):
            self.prune_queue(self.phase[len('prune_'):])
        elif self.phase == 'pins':
            rows = self.out.execute('SELECT id FROM ardud_native_sessions WHERE dirty=1 AND id>? ORDER BY id LIMIT ?',
                                    (self.pin_cursor, self.page_size)).fetchall()
            with self.write():
                for (sid,) in rows:
                    # A fresh metadata pass can discover messages/sessions
                    # beyond this cycle's fixed payload fence. Keep them busy
                    # for reapers until the following payload pass catches up.
                    self.out.execute('INSERT OR REPLACE INTO session_pending VALUES (?,?)', ('readonly:pending:' + sid, sid))
            if rows:
                self.pin_cursor = rows[-1][0]
            if len(rows) < self.page_size:
                self.phase = 'publish'
        else:
            version = self.read('PRAGMA data_version')[0][0]
            if version != self.change_version and not self.validating:
                # Durable event sequences cover message mutations; claim/view
                # bookkeeping can update sessions without an event. One more
                # short metadata pass includes both before publishing.
                self.change_version = version
                self.scan_cursor = 0
                self.phase = 'sessions'
                self.clear_staging = True
                self.validating = True
                self.queue_cursor = 0
                self.pin_cursor = ''
                with self.write():
                    self.generation += 1
                    self.setmeta('generation', self.generation)
                self.prune_cursor = ''
                return True
            with self.write():
                self.setmeta('history_ready', '0' if self.out.execute('SELECT 1 FROM ardud_native_sessions WHERE applied_seq IS NULL LIMIT 1').fetchone() else '1')
                self.setmeta('destructive_ready', '1' if version == self.change_version else '0')
                stamp = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(self.started_us / 1000000)) + f'.{self.started_us % 1000000:06d}Z'
                self.setmeta('updated_at', stamp)
                self.setmeta('generation_id', uuid.uuid4().hex)
                self.setmeta('ready', '1')
            return False
        return True

    def collect_retired(self):
        """Drain after publication, before producing more replacement payloads."""
        row = self.out.execute('SELECT payload_id FROM ardud_native_retired ORDER BY payload_id LIMIT 1').fetchone()
        if row is None:
            return False
        payload_id = row[0]
        with self.write():
            live = self.out.execute('SELECT 1 FROM ardud_native_message_rows WHERE payload_id=?', row).fetchone()
            partial = self.out.execute('SELECT 1 FROM ardud_native_payload WHERE payload_id=?', row).fetchone()
            if not live and not partial:
                self.out.execute('DELETE FROM ardud_native_chunks WHERE rowid IN '
                                 '(SELECT rowid FROM ardud_native_chunks WHERE payload_id=? LIMIT ?)',
                                 (payload_id, self.page_size))
            if live or partial or not self.out.execute('SELECT 1 FROM ardud_native_chunks WHERE payload_id=?', row).fetchone():
                self.out.execute('DELETE FROM ardud_native_retired WHERE payload_id=?', row)
        return True

    def close(self):
        if self.src:
            self.src.close()
            self.src = None
        if self.out:
            self.out.close()
            self.out = None
        if getattr(self, 'lock', None):
            self.lock.close()
            self.lock = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default=os.environ.get('OPENCODE_EXPORT_SOURCE_DB') or
                        str(Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))) / 'opencode/opencode.db'))
    parser.add_argument('--destination', default=os.environ.get('OPENCODE_READONLY_DB') or
                        str(Path.home() / '.robob/userdata/readonly/opencode.sqlite'))
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    exporter = Exporter(args.source, args.destination)
    try:
        while True:
            try:
                more = exporter.step()
            except ReadBudgetExceeded:
                time.sleep(1)
                continue
            if not more:
                # Reclamation keeps up with replacement volume without pinning
                # the source, delaying publication or imposing a large DELETE.
                while exporter.collect_retired():
                    time.sleep(0.005)
                if args.once:
                    return
                time.sleep(15)
                exporter.begin_cycle()
            else:
                time.sleep(0.005)
    finally:
        exporter.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'native export unavailable: {type(exc).__name__}', file=sys.stderr)
        sys.exit(1)
