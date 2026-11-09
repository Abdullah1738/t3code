#!/usr/bin/env python3
"""Offline, resumable canonical copy. No source writes, checkpoints or replacement.

Dry runs are sampled planning ranges, not a capacity or completion-time promise.
Execute requires a clean offline source (no nonempty WAL/rollback journal); the
coordinator must arrange that before invoking this program. Immutable read-only
opens then cannot create or update source-side SHM files. File identity, sidecar
stats, schema and event high-water mark must remain identical across every run.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

from recall_storage import configure_writer, checkpoint, install_change_journal, read_rows, _separate_paths
from robob_readonly import safe_path


STATE = "recall_migration_state"
CURSORS = "recall_migration_tables"
EMPTY_DIGEST = "0" * 64
PAGE_BYTES = 2_000_000


class MigrationError(RuntimeError):
    pass


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def file_signature(source):
    paths = [Path(source)] + [Path(str(source) + suffix) for suffix in ("-wal", "-shm", "-journal")]
    result = {"path": str(Path(source).resolve()), "files": {}}
    for path in paths:
        try:
            st = path.stat()
            result["files"][path.name] = [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]
        except FileNotFoundError:
            result["files"][path.name] = None
    if result["files"][Path(source).name] is None:
        raise MigrationError("source file does not exist")
    return result


def assert_clean_source(source):
    for suffix in ("-wal", "-journal"):
        path = Path(str(source) + suffix)
        if path.exists() and path.stat().st_size:
            raise MigrationError(
                f"source has a nonempty {suffix} file; stop all writers and arrange an offline clean "
                "snapshot/checkpoint before migration (this command never checkpoints the source)"
            )


def assert_unchanged(source, expected):
    if file_signature(source) != expected:
        raise MigrationError("source identity/files changed; target is not ready; resume only with the original unchanged source")


def open_source(source):
    con = sqlite3.connect(safe_path(source).as_uri() + "?mode=ro&immutable=1", uri=True,
                          isolation_level=None, timeout=0.1)
    con.execute("PRAGMA query_only=ON")
    con.execute("PRAGMA cache_size=-8192")
    # Reset for each source statement; one interrupted statement never pins a snapshot.
    return con


def bounded_rows(con, sql, params=(), seconds=2.0):
    until = time.monotonic() + max(0.001, seconds)
    con.set_progress_handler(lambda: int(time.monotonic() >= until), 1000)
    try:
        return read_rows(con, sql, params)
    finally:
        con.set_progress_handler(None, 0)


def schema_objects(con, seconds):
    return bounded_rows(con, "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name", seconds=seconds)


def source_identity(con, source, signature, seconds):
    objects = schema_objects(con, seconds)
    if not any(r[0] == "table" and r[1] == "episodic_events" for r in objects):
        raise MigrationError("source has no episodic_events table")
    max_id = bounded_rows(con, "SELECT coalesce(max(id),0) FROM episodic_events", seconds=seconds)[0][0]
    identity = {"signature": signature, "schema_sha256": hashlib.sha256(json.dumps(objects).encode()).hexdigest(),
                "max_event_id": max_id,
                "user_version": bounded_rows(con, "PRAGMA user_version", seconds=seconds)[0][0],
                "application_id": bounded_rows(con, "PRAGMA application_id", seconds=seconds)[0][0],
                "encoding": bounded_rows(con, "PRAGMA encoding", seconds=seconds)[0][0]}
    assert_unchanged(source, signature)
    return identity, objects


def _plan(objects):
    virtual = {name for kind, name, _, sql in objects if kind == "table" and sql and
               re.match(r"\s*CREATE\s+VIRTUAL\s+TABLE", sql, re.I)}
    fts = {name for kind, name, _, sql in objects if name in virtual and re.search(r"\bUSING\s+fts[345]\b", sql, re.I)}
    unsupported = virtual - fts
    if unsupported:
        raise MigrationError("unsupported non-FTS virtual tables: " + ", ".join(sorted(unsupported)))
    omitted = {"fts_build_state"} | fts
    # FTS shadow tables must not be copied as ordinary tables.
    shadow_suffixes = ("data", "idx", "content", "docsize", "config", "segments", "segdir", "stat")
    for _, name, _, _ in objects:
        if any(name == base + "_" + suffix for base in fts for suffix in shadow_suffixes):
            omitted.add(name)
    tables, deferred = [], []
    for kind, name, table, sql in objects:
        if name.startswith("sqlite_") or name in omitted or table in omitted or not sql:
            continue
        if name in (STATE, CURSORS):
            raise MigrationError("source uses reserved migration table name: " + name)
        if kind in ("index", "trigger", "view") and any(
            re.search(r"(?<!\w)" + re.escape(base) + r"(?!\w)", sql, re.I) for base in fts
        ):
            omitted.add(name)
            continue
        if kind == "table":
            tables.append((name, sql))
        elif kind in ("index", "trigger", "view"):
            deferred.append((kind, name, sql))
    return tables, deferred, sorted(omitted)


def _target_path(source, target_dir):
    source, directory = safe_path(source), Path(target_dir).resolve()
    target = safe_path(directory / "memory.db")
    if directory == source.parent:
        raise MigrationError("target-dir must be a different directory from the source")
    _separate_paths(source, target)
    # A directory containing another source alias is not a clean new destination.
    if directory.exists():
        for entry in directory.iterdir():
            if entry.is_file() and os.path.samefile(source, entry):
                raise MigrationError("target directory contains a source alias")
    return target


def dry_run(source, target_dir, seconds=2.0, sample_rows=8):
    """Read only a few id windows; do not create target-dir or open the target."""
    target = _target_path(source, target_dir)
    source = safe_path(source)
    signature = file_signature(source)
    assert_clean_source(source)
    con = open_source(source)
    try:
        identity, objects = source_identity(con, source, signature, seconds)
        tables, deferred, omitted = _plan(objects)
        hi = identity["max_event_id"]
        samples, measurements = {}, []
        started = time.monotonic()
        for start in sorted({1, max(1, hi // 2), max(1, hi - sample_rows * 4 + 1)}):
            if time.monotonic() - started >= seconds:
                break
            rows = bounded_rows(con, """SELECT id,length(CAST(content AS BLOB)),length(CAST(metadata_json AS BLOB)),
                length(CAST(content_fts AS BLOB)),substr(content,1,262144) FROM episodic_events
                WHERE id>=? AND id<? ORDER BY id LIMIT ?""", (start, start + sample_rows * 4, sample_rows), seconds)
            for row in rows:
                samples[row[0]] = row
            measurements.append({"start_id": start, "id_span": sample_rows * 4, "sampled_rows": len(rows)})
        elapsed = time.monotonic() - started
        assert_unchanged(source, signature)
        n = len(samples)
        span = sum(m["id_span"] for m in measurements)
        # Capped samples cannot estimate dense-window occupancy precisely. Keep the
        # range broad and always include the maximum-id upper bound.
        low_rows = min(hi, max(n, int(hi * sum(m["sampled_rows"] for m in measurements) / max(1, span) * 0.5)))
        avg_bytes = sum((r[1] or 0) + (r[2] or 0) + 192 for r in samples.values()) / max(1, n)
        read_bytes = sum(len(r[4].encode()) for r in samples.values())
        throughput = read_bytes / max(elapsed, 0.001)
        low_bytes, high_bytes = int(low_rows * avg_bytes * 1.1), int(hi * avg_bytes * 2)
        return {"dry_run": True, "source": str(source), "target": str(target), "source_identity": identity,
                "source_file_bytes": source.stat().st_size, "canonical_tables": [t[0] for t in tables],
                "deferred_objects": len(deferred), "omitted_objects": omitted, "sample_windows": measurements,
                "sample_rows": n, "sample_seconds": elapsed,
                "event_rows_planning_range": [low_rows, hi],
                "episodic_cold_bytes_planning_range": [low_bytes, high_bytes],
                "copy_seconds_planning_range": [low_bytes / max(throughput, 1) * 0.3,
                                                high_bytes / max(throughput, 1) * 10],
                "caveats": ["Heuristic sampled ranges, not confidence intervals or accurate predictions.",
                            "Size excludes ancillary tables, SQLite indexes, hot FTS and temporary/WAL space.",
                            "Read timing depends on page cache; writes, validation and index creation may dominate.",
                            "Keep the old store; migration never removes or replaces source files."]}
    finally:
        con.close()


def _json_value(value):
    if isinstance(value, bytes):
        return {"bytes": base64.b64encode(value).decode("ascii")}
    return value


def _encode_key(key):
    return json.dumps([_json_value(v) for v in key], separators=(",", ":"), ensure_ascii=True)


def _decode_key(text):
    return tuple(base64.b64decode(v["bytes"]) if isinstance(v, dict) else v for v in json.loads(text))


def _digest(digest, keys):
    for key in keys:
        digest = hashlib.sha256(bytes.fromhex(digest) + _encode_key(key).encode()).hexdigest()
    return digest


def _table_info(con, name, sql):
    columns = [r[1] for r in read_rows(con, f"PRAGMA table_xinfo({quote(name)})") if r[6] == 0]
    without_rowid = bool(re.search(r"\bWITHOUT\s+ROWID\b", sql, re.I))
    if without_rowid:
        info = read_rows(con, f"PRAGMA table_info({quote(name)})")
        keys = [r[1] for r in sorted(info, key=lambda r: r[5]) if r[5]]
    else:
        keys = [next((alias for alias in ("_rowid_", "rowid", "oid") if alias.lower() not in {c.lower() for c in columns}), None)]
        if keys[0] is None:
            raise MigrationError("table shadows all rowid names: " + name)
    return columns, keys, without_rowid


def _page(con, name, columns, keys, last_key, limit, seconds):
    key_sql = ",".join(quote(k) for k in keys)
    # Do not read the legacy duplicate's overflow pages merely to discard it.
    selected = key_sql + ("," + ",".join("NULL" if name == "episodic_events" and c == "content_fts" else quote(c)
                                         for c in columns) if columns else "")
    params = []
    where = ""
    if last_key is not None:
        values = _decode_key(last_key)
        where = " WHERE (" + key_sql + ") > (" + ",".join("?" for _ in keys) + ")"
        params.extend(values)
    params.append(limit)
    until = time.monotonic() + max(0.001, seconds)
    con.set_progress_handler(lambda: int(time.monotonic() >= until), 1000)
    cursor = None
    rows, size = [], 0
    try:
        cursor = con.execute("SELECT " + selected + " FROM " + quote(name) + where + " ORDER BY " + key_sql + " LIMIT ?", params)
        for row in cursor:
            rows.append(row)
            size += sum(len(v) for v in row if isinstance(v, (str, bytes)))
            if size >= PAGE_BYTES:
                break
        return rows
    finally:
        if cursor is not None:
            cursor.close()
        con.set_progress_handler(None, 0)


def _initialize(target, identity, tables):
    if target.exists():
        existing = sqlite3.connect(target.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            if not read_rows(existing, "SELECT 1 FROM sqlite_master WHERE name=?", (STATE,)):
                raise MigrationError("target memory.db already exists without migration state; use a new directory")
        finally:
            existing.close()
    target.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(target, isolation_level=None, timeout=0.25)
    try:
        con.execute("PRAGMA foreign_keys=OFF")
        configure_writer(con)
        con.execute("PRAGMA encoding=" + quote(identity["encoding"]))
        con.execute("BEGIN IMMEDIATE")
        try:
            con.execute(f"CREATE TABLE IF NOT EXISTS {STATE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL, phase TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0)")
            con.execute(f"""CREATE TABLE IF NOT EXISTS {CURSORS}(
                table_name TEXT PRIMARY KEY, last_key TEXT, copied INTEGER NOT NULL DEFAULT 0,
                digest TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
                validated_key TEXT, validated INTEGER NOT NULL DEFAULT 0,
                validated_digest TEXT NOT NULL, validation_done INTEGER NOT NULL DEFAULT 0)""")
            previous = read_rows(con, f"SELECT identity FROM {STATE}")
            encoded = json.dumps(identity, sort_keys=True)
            if previous and previous[0][0] != encoded:
                raise MigrationError("source signature/schema/max id differs from the target's original source")
            if not previous:
                con.execute(f"INSERT INTO {STATE}(singleton,identity,phase) VALUES(1,?,'copy')", (encoded,))
                for name, sql in tables:
                    con.execute(sql)
                    con.execute(f"INSERT INTO {CURSORS}(table_name,digest,validated_digest) VALUES(?,?,?)",
                                (name, EMPTY_DIGEST, EMPTY_DIGEST))
                con.execute(f"PRAGMA user_version={identity['user_version']}")
                con.execute(f"PRAGMA application_id={identity['application_id']}")
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
        return con
    except BaseException:
        con.close()
        raise


def _status(con, target, processed):
    phase, ready = read_rows(con, f"SELECT phase,ready FROM {STATE}")[0]
    tables = [dict(zip(("table", "copied", "done", "validated", "validation_done"), row)) for row in
              read_rows(con, f"SELECT table_name,copied,done,validated,validation_done FROM {CURSORS} ORDER BY table_name")]
    return {"target": str(target), "phase": phase, "ready": bool(ready), "rows_processed": processed, "tables": tables}


def migrate(source, target_dir, *, offline_confirmed=False, max_rows=100000, seconds=30.0, batch_rows=250):
    """Advance copy/validation by bounded pages; invoke repeatedly until ready.

    A deferred target index/trigger DDL is atomic but may exceed seconds. This is
    offline work; interruption rolls that one DDL back and a later run retries it.
    """
    if not offline_confirmed:
        raise MigrationError("execute requires --offline-confirmed after all source writers have stopped")
    if max_rows < 0 or seconds <= 0 or batch_rows <= 0:
        raise ValueError("max_rows must be nonnegative; seconds and batch_rows must be positive")
    target = _target_path(source, target_dir)
    source = safe_path(source)
    signature = file_signature(source)
    assert_clean_source(source)
    src = open_source(source)
    dst = None
    processed, started = 0, time.monotonic()
    try:
        identity, objects = source_identity(src, source, signature, seconds)
        tables, deferred, _ = _plan(objects)
        dst = _initialize(target, identity, tables)
        _, ready = read_rows(dst, f"SELECT phase,ready FROM {STATE}")[0]
        if ready:
            return _status(dst, target, processed)
        for name, sql in tables:
            columns, keys, without_rowid = _table_info(src, name, sql)
            while processed < max_rows and time.monotonic() - started < seconds:
                last_key, copied, digest, done = read_rows(dst, f"SELECT last_key,copied,digest,done FROM {CURSORS} WHERE table_name=?", (name,))[0]
                if done:
                    break
                assert_unchanged(source, signature)
                limit = min(batch_rows, max_rows - processed)
                rows = _page(src, name, columns, keys, last_key, limit, min(2.0, seconds))
                assert_unchanged(source, signature)
                dst.execute("BEGIN IMMEDIATE")
                try:
                    if rows:
                        write_cols = columns if without_rowid else keys + columns
                        query = "INSERT INTO " + quote(name) + "(" + ",".join(quote(c) for c in write_cols) + ") VALUES(" + ",".join("?" for _ in write_cols) + ")"
                        values = []
                        for row in rows:
                            row = list(row)
                            if name == "episodic_events" and "content_fts" in columns:
                                row[len(keys) + columns.index("content_fts")] = None
                            values.append(row[len(keys):] if without_rowid else row)
                        dst.executemany(query, values)
                        last_key = _encode_key(rows[-1][:len(keys)])
                        digest = _digest(digest, (r[:len(keys)] for r in rows))
                    dst.execute(f"UPDATE {CURSORS} SET last_key=?,copied=?,digest=?,done=? WHERE table_name=?",
                                (last_key, copied + len(rows), digest, int(not rows), name))
                    assert_unchanged(source, signature)
                    dst.execute("COMMIT")
                except BaseException:
                    dst.execute("ROLLBACK")
                    raise
                processed += len(rows)
                checkpoint(dst)
            if not read_rows(dst, f"SELECT done FROM {CURSORS} WHERE table_name=?", (name,))[0][0]:
                return _status(dst, target, processed)
        dst.execute(f"UPDATE {STATE} SET phase='validate'")
        # Re-read only target keys. The source copy cursor's exhaustive page walk
        # is its row count; a chained key digest proves the same IDs and ordering.
        for name, sql in tables:
            _, keys, _ = _table_info(src, name, sql)
            while processed < max_rows and time.monotonic() - started < seconds:
                copied, digest, last, checked, checked_digest, done = read_rows(dst,
                    f"SELECT copied,digest,validated_key,validated,validated_digest,validation_done FROM {CURSORS} WHERE table_name=?", (name,))[0]
                if done:
                    break
                assert_unchanged(source, signature)
                limit = min(batch_rows, max_rows - processed)
                rows = _page(dst, name, [], keys, last, limit, min(2.0, seconds))
                if rows:
                    last = _encode_key(rows[-1])
                    checked_digest = _digest(checked_digest, rows)
                checked += len(rows)
                done = not rows
                if done and (checked != copied or checked_digest != digest):
                    raise MigrationError("target row count/ID validation failed for " + name)
                dst.execute(f"UPDATE {CURSORS} SET validated_key=?,validated=?,validated_digest=?,validation_done=? WHERE table_name=?",
                            (last, checked, checked_digest, int(done), name))
                processed += len(rows)
            if not read_rows(dst, f"SELECT validation_done FROM {CURSORS} WHERE table_name=?", (name,))[0][0]:
                return _status(dst, target, processed)
        assert_unchanged(source, signature)
        # Readiness is revoked until all target-only schema work is committed.
        dst.execute(f"UPDATE {STATE} SET phase='indexes'")
        for kind, name, sql in deferred:
            assert_unchanged(source, signature)
            if not read_rows(dst, "SELECT 1 FROM sqlite_master WHERE type=? AND name=?", (kind, name)):
                dst.execute(sql)
        dst.execute("BEGIN IMMEDIATE")
        try:
            # Keep deleted high AUTOINCREMENT values as well as surviving event IDs.
            if any(r[1] == "sqlite_sequence" for r in objects):
                copied_names = {name for name, _ in tables}
                for name, seq in bounded_rows(src, "SELECT name,seq FROM sqlite_sequence", seconds=seconds):
                    if name in copied_names:
                        dst.execute("DELETE FROM sqlite_sequence WHERE name=?", (name,))
                        dst.execute("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)", (name, seq))
            install_change_journal(dst)
            max_id = read_rows(dst, "SELECT coalesce(max(id),0) FROM episodic_events")[0][0]
            if max_id != identity["max_event_id"]:
                raise MigrationError("target event max id does not match source")
            assert_unchanged(source, signature)
            dst.execute(f"UPDATE {STATE} SET phase='ready',ready=1")
            dst.execute("COMMIT")
        except BaseException:
            dst.execute("ROLLBACK")
            raise
        assert_unchanged(source, signature)
        return _status(dst, target, processed)
    except BaseException:
        if dst is not None and not dst.in_transaction:
            # In particular, a source change detected just after the final commit
            # must not leave a target advertised as ready.
            dst.execute(f"UPDATE {STATE} SET ready=0")
        raise
    finally:
        src.close()
        if dst is not None:
            checkpoint(dst, truncate=True)
            dst.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", required=True, type=Path)
    ap.add_argument("--target-dir", required=True, type=Path)
    ap.add_argument("--execute", action="store_true", help="default is a read-only sampled dry run")
    ap.add_argument("--offline-confirmed", action="store_true")
    ap.add_argument("--max-rows", type=int, default=100000, help="copy plus validation rows per execute invocation")
    ap.add_argument("--seconds", type=float, default=30, help="row-work budget; one target schema/index DDL may exceed it")
    ap.add_argument("--batch-rows", type=int, default=250)
    args = ap.parse_args(argv)
    try:
        if args.execute:
            result = migrate(args.source, args.target_dir, offline_confirmed=args.offline_confirmed,
                             max_rows=args.max_rows, seconds=args.seconds, batch_rows=args.batch_rows)
        else:
            result = dry_run(args.source, args.target_dir, seconds=min(args.seconds, 2.0))
        print(json.dumps(result, indent=2))
        return 0
    except (MigrationError, ValueError, sqlite3.DatabaseError, OSError) as exc:
        print(json.dumps({"ready": False, "error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
