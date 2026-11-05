"""Readiness metadata for synthetic server exports; never touches runtime data."""
from datetime import datetime, timezone


def ready(con):
    con.execute("CREATE TABLE IF NOT EXISTS ardud_readonly_meta(key TEXT PRIMARY KEY, value TEXT)")
    con.executemany("INSERT OR REPLACE INTO ardud_readonly_meta VALUES (?,?)",
                    [("ready", "1"), ("updated_at", datetime.now(timezone.utc).isoformat())])
