"""Readiness metadata for synthetic server exports; never touches runtime data."""
from datetime import datetime, timezone


def ready(con, *, updated_at=None):
    con.execute("CREATE TABLE IF NOT EXISTS ardud_readonly_meta(key TEXT PRIMARY KEY, value TEXT)")
    con.executemany("INSERT OR REPLACE INTO ardud_readonly_meta VALUES (?,?)",
                    [("schema_version", "1"), ("ready", "1"), ("history_ready", "1"), ("destructive_ready", "1"),
                     ("updated_at", updated_at or datetime.now(timezone.utc).isoformat())])


def native_ready(con):
    ready(con)
    con.execute("CREATE TABLE IF NOT EXISTS ardud_native_sessions(id TEXT PRIMARY KEY,applied_seq INTEGER,dirty INTEGER)")
    con.execute("INSERT OR IGNORE INTO ardud_native_sessions SELECT id,1,0 FROM session_v2")
