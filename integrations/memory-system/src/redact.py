"""Count-only recall redaction. No exception containing payloads crosses the CLI."""
from __future__ import annotations

import contextlib
import datetime
import json
import os
import re
from pathlib import Path
import sqlite3
import stat
import subprocess
import tempfile
import zlib

import redact_guard as guard
from redact_lock import fence


class RedactionError(Exception):
    pass


def read_needle(path):
    if not path:
        return None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise RedactionError('needle-file must be an owned regular 0600 file')
        needle = f.read()
    if not needle or b'\n' in needle or b'\r' in needle or b'\0' in needle:
        raise RedactionError('needle-file must contain one nonempty literal without a line ending')
    needle.decode('utf-8')
    return needle


def patterns(needle):
    if needle is None:
        return ()
    text = needle.decode('utf-8')
    return tuple(set((needle, json.dumps(text,ensure_ascii=True)[1:-1].encode(),
                      json.dumps(text,ensure_ascii=False)[1:-1].encode())))


def contains(value, needle):
    if needle is None or not isinstance(value, (str, bytes)):
        return False
    b = value.encode() if isinstance(value, str) else value
    if any(p in b for p in patterns(needle)):
        return True
    try:
        decoded = json.loads(b)
    except (ValueError, UnicodeError):
        # Capture logs and pretty JSON can wrap an escaped JSON string in a
        # larger non-JSON line. Decode each complete quoted string as well.
        for match in re.finditer(rb'"(?:[^"\\]|\\.)*"',b):
            try:
                if contains_json(json.loads(match.group()),needle):
                    return True
            except (ValueError,UnicodeError):
                pass
        return False
    return contains_json(decoded, needle)


def contains_json(value, needle, depth=0):
    if depth > 64:
        raise RedactionError('nested JSON exceeds inspection limit')
    if isinstance(value, str):
        if needle in value.encode():
            return True
        try:
            nested = json.loads(value)
        except (ValueError,UnicodeError):
            for match in re.finditer(r'"(?:[^"\\]|\\.)*"',value):
                try:
                    if contains_json(json.loads(match.group()),needle,depth+1):
                        return True
                except (ValueError,UnicodeError):
                    pass
            return False
        return nested != value and contains_json(nested,needle,depth+1)
    if isinstance(value, dict):
        return any(contains_json(k,needle,depth+1) or contains_json(v,needle,depth+1) for k,v in value.items())
    if isinstance(value, list):
        return any(contains_json(v,needle,depth+1) for v in value)
    return False


def atomic_write(path, data):
    path = Path(path)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    fd, tmp = tempfile.mkstemp(prefix='.redact-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            os.fchmod(f.fileno(), mode)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        d = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def qi(name):
    return '"' + name.replace('"', '""') + '"'


def tables(con):
    # table_list identifies virtual/shadow tables without guessing their suffixes.
    return {r[1]: r[2] for r in con.execute('PRAGMA table_list') if r[0] == 'main' and not r[1].startswith('sqlite_')}


def decode_cell(name, value):
    if name.endswith('_zlib') and value is not None:
        return zlib.decompress(value)
    return value


def item_match(row, session, item):
    if not item:
        return False
    sid = row.get('session_id') or row.get('session_key')
    if sid != session:
        return False
    return row.get('turn_id') == item or row.get('id') == item or any(
        item in guard.identities(v) for v in row.values() if isinstance(v, (bytes, str)))


def repair_fts_triggers(con):
    sql = con.execute("SELECT sql FROM sqlite_master WHERE name='episodic_fts'").fetchone()
    if not sql or "content='episodic_events'" not in sql[0].replace(' ', ''):
        return
    con.execute('DROP TRIGGER IF EXISTS episodic_fts_update')
    con.execute('DROP TRIGGER IF EXISTS episodic_fts_delete')
    con.execute('''CREATE TRIGGER episodic_fts_update AFTER UPDATE ON episodic_events BEGIN
        INSERT INTO episodic_fts(episodic_fts,rowid,content) VALUES('delete',old.id,old.content);
        INSERT INTO episodic_fts(rowid,content) VALUES(new.id,new.content); END''')
    con.execute('''CREATE TRIGGER episodic_fts_delete AFTER DELETE ON episodic_events BEGIN
        INSERT INTO episodic_fts(episodic_fts,rowid,content) VALUES('delete',old.id,old.content); END''')


def compact(con):
    con.commit()
    if con.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]:
        raise RedactionError('checkpoint blocked by a reader; rerun after it finishes')
    con.execute('VACUUM')
    if con.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]:
        raise RedactionError('checkpoint blocked by a reader; rerun after it finishes')


def byte_hits(path, needle):
    if not needle or not Path(path).exists():
        return 0
    hits, tail = 0, b''
    with open(path, 'rb') as f:
        while chunk := f.read(1024 * 1024):
            data = tail + chunk
            hits += data.count(needle)
            tail = data[-(len(needle)-1):] if len(needle) > 1 else b''
    return hits


def safe_identity(value, needle):
    encoded = json.dumps(value)
    if contains(encoded,needle):
        raise RedactionError('identity intersects redaction selector')
    return encoded


def redact_db(path, needle, marker, *, session=None, item=None, dry_run=False, event_ids=None):
    con = sqlite3.connect(Path(path).as_uri() + ('?mode=ro' if dry_run else '?mode=rw'), uri=True, timeout=1)
    con.row_factory = sqlite3.Row
    matched, replaced, affected_paths = 0, 0, set()
    event_ids = event_ids if event_ids is not None else set()
    try:
        con.execute('PRAGMA secure_delete=ON')
        if not dry_run:
            con.execute('BEGIN IMMEDIATE')
            con.execute(guard.DDL)
            if 'episodic_events' in tables(con) and 'recall_index_state' not in tables(con) and Path(path).name != 'recall_hot.db':
                con.execute('CREATE TABLE IF NOT EXISTS recall_redacted_events(event_id INTEGER PRIMARY KEY)')
            if item:
                con.execute('INSERT OR REPLACE INTO recall_redacted_ids VALUES(?,?,?)', ('id', safe_identity([session,item],needle), marker))
            repair_fts_triggers(con)
        kinds = tables(con)
        derived = 'recall_index_state' in kinds or Path(path).name == 'recall_hot.db'
        if 'recall_redacted_events' in kinds and not derived:
            event_ids.update(r[0] for r in con.execute('SELECT event_id FROM recall_redacted_events'))
        if derived and needle:
            # Recover selection from the full index itself after a prior cold
            # commit, including when the excerpt never contained the credential.
            query = '"' + needle.decode('utf-8').replace('"','""') + '"'
            for fts in ('episodic_fts','episodic_text_fts'):
                if fts in kinds:
                    event_ids.update(r[0] for r in con.execute(f'SELECT rowid FROM {fts} WHERE {fts} MATCH ?',(query,)))
        for table, kind in kinds.items():
            if kind != 'table' or table == 'recall_redacted_ids':
                continue
            info = list(con.execute(f'PRAGMA table_info({qi(table)})'))
            cols = [r['name'] for r in info]
            primary = [r['name'] for r in info if r['pk']]
            keys = primary or ['rowid']
            select = '*' if primary else 'rowid AS rowid,*'
            cursor = con.execute(f'SELECT {select} FROM {qi(table)}')
            while batch := cursor.fetchmany(100):
                for record in batch:
                    row = dict(record)
                    decoded = {k: decode_cell(k, v) for k, v in row.items()}
                    scope = row.get('session_id') or row.get('session_key')
                    if table == 'raw_sessions':
                        scope = row['id']
                    if table == 'native_capture_raw' and 'native_capture_files' in kinds:
                        ledger = con.execute('SELECT session_key FROM native_capture_files WHERE rep_id=?',(row['rep_id'],)).fetchone()
                        scope = ledger[0] if ledger else None
                    by_item = item_match(decoded, session, item)
                    forced = table == 'episodic_events' and derived and row['id'] in event_ids
                    # Raw native lines carry the session inside their JSON, not in a column.
                    if table == 'native_capture_raw' and item:
                        try:
                            raw_record = json.loads(row['raw'])
                            by_item |= ((scope or raw_record.get('sessionId')) == session and item in guard.identities(raw_record))
                        except (ValueError, UnicodeError, AttributeError):
                            pass
                    matching = [k for k, v in decoded.items() if contains(v, needle)]
                    if not matching and not by_item and not forced:
                        continue
                    matched += 1
                    if table == 'episodic_events':
                        event_ids.add(row['id'])
                    if row.get('path'):
                        affected_paths.add(row['path'])
                    if table == 'episodic_events' and 'native_capture_files' in kinds:
                        affected_paths.update(r[0] for r in con.execute(
                            'SELECT path FROM native_capture_files WHERE session_key=?', (row['session_id'],)))
                    if table == 'episodic_events' and 'muse_sync_files' in kinds:
                        affected_paths.update(r[0] for r in con.execute(
                            'SELECT path FROM muse_sync_files WHERE session_id=?', (row['session_id'],)))
                    if table == 'episodic_events':
                        try:
                            meta = json.loads(row.get('metadata_json') or '{}')
                            if os.path.isabs(meta.get('file') or meta.get('path') or ''):
                                affected_paths.add(meta.get('file') or meta.get('path'))
                        except (ValueError, AttributeError):
                            pass
                    if dry_run:
                        continue
                    if table == 'episodic_events' and not derived:
                        # Commit selection with the redacted cold row. A retry
                        # cannot recover arbitrary JSON encodings from excerpts.
                        con.execute('INSERT OR IGNORE INTO recall_redacted_events VALUES(?)',(row['id'],))
                    if 'recall_redacted_ids' in kinds:
                        ids = set().union(*(guard.identities(v) for v in decoded.values() if isinstance(v, (bytes, str))))
                        if table in ('raw_messages', 'raw_sessions'):
                            ids.add(row['id'])
                        if table == 'episodic_events':
                            con.execute('INSERT OR REPLACE INTO recall_redacted_ids VALUES(?,?,?)',
                                        ('turn', safe_identity([row['source'], row['session_id'], row['turn_id']],needle), marker))
                        if table == 'native_capture_raw' and scope and row.get('sha1') != 'redacted':
                            con.execute('INSERT OR REPLACE INTO recall_redacted_ids VALUES(?,?,?)',
                                        ('native',safe_identity([row['source'],scope,row['sha1']],needle),marker))
                        for ident in ids:
                            if scope and not contains(ident, needle):
                                con.execute('INSERT OR REPLACE INTO recall_redacted_ids VALUES(?,?,?)', ('id', safe_identity([scope,ident],needle), marker))
                    changes = {k: marker.encode() if isinstance(row[k], bytes) else marker for k in matching}
                    if table == 'episodic_events':
                        changes.update(content=marker, content_fts=marker, metadata_json=json.dumps({'redacted': True}))
                    elif table == 'native_capture_raw':
                        changes.update(raw=(json.dumps({'redacted': marker})+'\n').encode(), sha1='redacted')
                    elif table == 'raw_messages':
                        changes.update(data_zlib=zlib.compress(json.dumps({'redacted': marker}).encode()), sha256='redacted', raw_size=0)
                    elif table == 'raw_sessions':
                        changes.update(row_json_zlib=zlib.compress(json.dumps({'redacted': marker}).encode()))
                    for k in list(changes):
                        if k.endswith('_zlib') and k not in ('data_zlib', 'row_json_zlib'):
                            changes[k] = zlib.compress(marker.encode())
                    # Indexed row identities cannot be replaced with free-form markers.
                    if any(k in keys for k in changes):
                        raise RedactionError('needle matches a primary key; a separate identity migration is required')
                    if table == 'episodic_events':
                        for fts in ('episodic_fts', 'episodic_text_fts'):
                            if fts in kinds:
                                fsql = con.execute('SELECT sql FROM sqlite_master WHERE name=?', (fts,)).fetchone()[0]
                                if "content='episodic_events'" not in fsql.replace(' ', ''):
                                    con.execute(f'DELETE FROM {fts} WHERE rowid=?', (row['id'],))
                    con.execute(f'UPDATE {qi(table)} SET ' + ','.join(qi(k)+'=?' for k in changes) +
                                ' WHERE ' + ' AND '.join(qi(k)+' IS ?' for k in keys),
                                [*changes.values(), *(row[k] for k in keys)])
                    if table == 'episodic_events':
                        for fts in ('episodic_fts', 'episodic_text_fts'):
                            if fts not in kinds:
                                continue
                            has_trigger = con.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?", (fts+'_update',)).fetchone()
                            if not has_trigger and (fts == 'episodic_fts' or (row['content_type']=='text' and row['speaker'] in ('user','assistant'))):
                                if fts == 'episodic_fts':
                                    con.execute(f'INSERT INTO {fts}(rowid,content) VALUES(?,?)', (row['id'], marker))
                                else:
                                    con.execute(f'INSERT INTO {fts}(rowid,content,source,session_id,speaker,ts) VALUES(?,?,?,?,?,?)',
                                                (row['id'],marker,row['source'],row['session_id'],row['speaker'],row['timestamp']))
                    replaced += 1
            cursor.close()
        if not dry_run:
            # Reset rather than advancing to EOF: replay preserves records appended since the last tick.
            if 'native_capture_files' in kinds:
                con.executemany('UPDATE native_capture_files SET retired=1 WHERE retired=0 AND path=?',
                                [(p,) for p in affected_paths])
            if 'muse_sync_files' in kinds:
                con.executemany("UPDATE muse_sync_files SET offset=0,size=0,mtime_ns=0,state_json='{}',head_sha=NULL WHERE path=?",
                                [(p,) for p in affected_paths])
            for fts in ('episodic_fts','episodic_text_fts'):
                if fts in kinds:
                    sql = con.execute('SELECT sql FROM sqlite_master WHERE name=?',(fts,)).fetchone()[0]
                    if "content='episodic_events'" in sql.replace(' ', ''):
                        # Rebuild also repairs stale tokens left by the previous
                        # unsafe UPDATE trigger before maintenance was installed.
                        con.execute(f"INSERT INTO {fts}({fts}) VALUES('rebuild')")
                    con.execute(f"INSERT INTO {fts}({fts}) VALUES('optimize')")
            compact(con)
    finally:
        con.close()
    remaining = matched if dry_run else sum(byte_hits(str(path)+s, needle) for s in ('','-wal','-journal'))
    if not dry_run and needle:
        with contextlib.closing(sqlite3.connect(Path(path).as_uri()+'?mode=ro',uri=True)) as check:
            for table, kind in tables(check).items():
                if kind != 'table':
                    continue
                columns = [r[1] for r in check.execute(f'PRAGMA table_info({qi(table)})')]
                for row in check.execute(f'SELECT * FROM {qi(table)}'):
                    remaining += int(any(contains(decode_cell(k,v),needle) for k,v in zip(columns,row)))
            kinds = tables(check)
            query = '"' + needle.decode('utf-8').replace('"','""') + '"'
            for fts in ('episodic_fts','episodic_text_fts'):
                if fts in kinds:
                    remaining += check.execute(f'SELECT count(*) FROM {fts} WHERE {fts} MATCH ?',(query,)).fetchone()[0]
    return {'matchedBefore':matched, 'replaced':replaced, 'remainingAfter':remaining}, affected_paths


def redact_file(path, needle, marker, *, dry_run=False):
    # Streaming keeps large capture logs and archived transcripts off the heap.
    path = Path(path)
    with path.open('rb') as probe:
        header = probe.read(4)
    if header.startswith((b'\x1f\x8b',b'PK\x03\x04')):
        raise RedactionError('unsupported compressed flat file')
    compressed = path.suffix == '.zst' or header == b'\x28\xb5\x2f\xfd'
    decoder = None
    if compressed:
        decoder = subprocess.Popen(['zstd','-dc',str(path)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        source = decoder.stdout
    else:
        source = path.open('rb')
    fd, tmp = tempfile.mkstemp(prefix='.redact-',dir=path.parent) if not dry_run else (None,None)
    encoder, matched = None, 0
    try:
        target = os.fdopen(fd,'wb') if fd is not None else None
        if target:
            os.fchmod(target.fileno(),stat.S_IMODE(path.stat().st_mode))
        if compressed and target:
            encoder = subprocess.Popen(['zstd','-q','-c'],stdin=subprocess.PIPE,stdout=target,stderr=subprocess.DEVNULL)
        destination = encoder.stdin if encoder else target
        for line in source:
            if contains(line,needle):
                matched += 1
                line = (json.dumps({'redacted':marker})+'\n').encode()
            if destination:
                destination.write(line)
        if decoder and decoder.wait():
            raise RedactionError('compressed file inspection failed')
        if encoder:
            encoder.stdin.close()
            if encoder.wait():
                raise RedactionError('compressed file rewrite failed')
        if target:
            target.flush()
            os.fsync(target.fileno())
            target.close()
        if matched and not dry_run:
            os.replace(tmp,path)
            directory = os.open(path.parent,os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        source.close()
        for proc in (decoder,encoder):
            if proc and proc.poll() is None:
                proc.terminate()
                proc.wait()
        if fd is not None:
            with contextlib.suppress(OSError):
                os.close(fd)
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)
    remaining = matched if dry_run else 0
    if matched and not dry_run:
        remaining = redact_file(path,needle,marker,dry_run=True)['matchedBefore']
    return {'matchedBefore':matched,'replaced':0 if dry_run else matched,'remainingAfter':remaining}


def sweep(root, needle, marker, *, session=None, item=None, dry_run=False):
    stores, paths, event_ids = {}, set(), set()
    for directory in (Path(root)/'data', Path(root)/'logs'):
        if not directory.exists():
            continue
        for path in sorted(directory.rglob('*'),key=lambda p:(p.name!='memory.db',str(p))):
            if not path.is_file() or path.is_symlink() or path.name.endswith(('-wal','-shm','-journal','.flock')):
                continue
            with path.open('rb') as f:
                sqlite = f.read(16) == b'SQLite format 3\0'
            if sqlite:
                result, affected = redact_db(path,needle,marker,session=session,item=item,dry_run=dry_run,event_ids=event_ids)
                paths.update(affected)
            else:
                result = redact_file(path,needle,marker,dry_run=dry_run)
            stores[str(path)] = result
    return stores, paths


def run(args):
    needle = read_needle(args.needle_file)
    if bool(args.session) != bool(args.item) or not (args.item or needle):
        raise RedactionError('supply --session and --item together, and/or --needle-file')
    # Reasons are deliberately identifiers, not free-form text that could echo a secret.
    import re
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', args.reason) or contains(args.reason, needle):
        raise RedactionError('reason must be a safe incident identifier')
    if not args.dry_run and not args.yes:
        raise RedactionError('review --dry-run, then supply --yes for the approved mutation')
    root = Path(args.root).resolve()
    marker = f'[redacted {datetime.date.today().isoformat()}: {args.reason}]'
    with fence(root, exclusive=True, blocking=False):
        # Refuse pre-upgrade or manual runners which do not hold the shared fence.
        if (root/'logs/state/capture.lock').exists() or (root/'logs/backup.lock').exists():
            raise RedactionError('capture or backup active; retry after it finishes')
        if not args.dry_run:
            atomic_write(root/'logs/state/redaction.generation', os.urandom(16).hex().encode())
        stores, sources = sweep(root,needle,marker,session=args.session,item=args.item,dry_run=args.dry_run)
        # Share raw-replica message ids with the capture writers' memory connection.
        if not args.dry_run and (root/'data/memory.db').exists():
            with contextlib.closing(sqlite3.connect(root/'data/memory.db')) as mem:
                mem.execute('PRAGMA secure_delete=ON')
                mem.execute(guard.DDL)
                for db in (root/'data').glob('*.db'):
                    if db.name == 'memory.db':
                        continue
                    with contextlib.closing(sqlite3.connect(db)) as other:
                        if 'recall_redacted_ids' in tables(other):
                            for tombstone in other.execute('SELECT * FROM recall_redacted_ids'):
                                safe_identity(list(tombstone),needle)
                                mem.execute('INSERT OR REPLACE INTO recall_redacted_ids VALUES(?,?,?)',tombstone)
                # Include ids learned only from the raw replica. Revisit affected
                # OpenCode sessions without reprojecting the entire archive.
                sessions = set()
                for kind,value in mem.execute('SELECT kind,value FROM recall_redacted_ids'):
                    parts = json.loads(value)
                    sessions.add(parts[0] if kind=='id' else parts[1])
                kinds = tables(mem)
                for sid in sessions:
                    for table in ('opencode_sync_progress','opencode_sync_export_progress','opencode_capture_scan'):
                        if table in kinds:
                            mem.execute(f'DELETE FROM {table} WHERE session_id=?',(sid,))
                    if 'opencode_sync_payloads' in kinds and 'opencode_sync_messages' in kinds:
                        mem.execute('DELETE FROM opencode_sync_payloads WHERE msg_id IN '
                                    '(SELECT msg_id FROM opencode_sync_messages WHERE session_id=?)',(sid,))
                mem.commit()
                if mem.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]:
                    raise RedactionError('checkpoint blocked after progress update')
        # Sources belong to #849. They are inspected, never rewritten here.
        for path in sorted(sources):
            if os.path.isfile(path):
                n = redact_file(path,needle,marker,dry_run=True)['matchedBefore']
                stores[path] = {'matchedBefore':n,'replaced':0,'remainingAfter':n}
        result = {'stores':stores, 'paths':sorted(p for p,r in stores.items() if r['matchedBefore']),
                  'verify':not args.dry_run and all(r['remainingAfter']==0 for r in stores.values())}
        if contains(json.dumps(result),needle):
            raise RedactionError('output path intersects redaction selector')
        return result
