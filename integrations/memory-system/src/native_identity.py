"""Resolve native capture identities to Robob threads without guessing."""

import sqlite3


def _valid_id(value):
    return isinstance(value, str) and bool(value) and value.isprintable() and not any(ch.isspace() for ch in value)


def _identity(instance, source, session_key):
    if not _valid_id(instance) or not _valid_id(session_key):
        return None
    if source == "codex":
        return ("codex", None, None)
    if source != "claude":
        return None
    parts = session_key.split(":agent:")
    if any(part.startswith(":") or part.endswith(":") for part in parts):
        return None
    if len(parts) == 1:
        return ("claudeAgent", parts[0], None)
    if len(parts) == 2 and all(_valid_id(part) for part in parts):
        return ("claudeAgent", parts[0], parts[1])
    return None


def _choose(source, session_key, identity, rows):
    """Reject invalid rows, distinct canonical threads, and parent/child collisions."""
    _, native, agent = identity
    canonical = set()
    kinds = set()
    for thread, alias_native, alias_agent in rows:
        if not _valid_id(thread) or not _valid_id(alias_native):
            return None
        if alias_agent is not None and not _valid_id(alias_agent):
            return None
        if source == "claude":
            # A literal parent ID containing the child delimiter is not safely
            # distinguishable from a child key produced by the capture format.
            if (alias_native, alias_agent) != (native, agent):
                return None
        elif alias_agent is None:
            if alias_native != session_key:
                return None
            kinds.add("parent")
        else:
            if alias_agent != session_key:
                return None
            kinds.add("child")
        canonical.add(thread)
    if len(canonical) != 1 or len(kinds) > 1:
        return None
    return next(iter(canonical))


def source_for_instance(instance):
    """Return the capture source for a known configured native instance."""
    if instance in ("claude", "claudeAgent"):
        return "claude"
    if instance in ("codex", "codex-cu"):
        return "codex"
    return None


def resolve_thread(con, instance, source, session_key):
    """Return the one canonical thread for an exact native identity, or None."""
    identity = _identity(instance, source, session_key)
    if identity is None:
        return None
    driver, native, agent = identity
    try:
        if source == "codex":
            rows = con.execute(
                "SELECT canonical_thread_id, native_id, agent_id FROM thread_aliases"
                " WHERE instance=? AND driver=? AND (agent_id=? OR (native_id=? AND agent_id IS NULL))",
                (instance, driver, session_key, session_key),
            ).fetchall()
        elif agent is None:
            rows = con.execute(
                "SELECT canonical_thread_id, native_id, agent_id FROM thread_aliases"
                " WHERE instance=? AND driver=? AND native_id=? AND agent_id IS NULL",
                (instance, driver, native),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT canonical_thread_id, native_id, agent_id FROM thread_aliases"
                " WHERE instance=? AND driver=? AND ((native_id=? AND agent_id=?)"
                " OR (native_id=? AND agent_id IS NULL))",
                (instance, driver, native, agent, session_key),
            ).fetchall()
    except sqlite3.Error:
        return None
    return _choose(source, session_key, identity, rows)


class ThreadResolver:
    """Snapshot aliases once when resolving many capture rows on one connection."""

    def __init__(self, con):
        self._rows = {}
        try:
            aliases = con.execute(
                "SELECT instance, driver, native_id, agent_id, canonical_thread_id FROM thread_aliases"
                " WHERE driver IN ('claudeAgent', 'codex')"
            )
            for instance, driver, native, agent, thread in aliases:
                if not _valid_id(instance):
                    continue
                source = "claude" if driver == "claudeAgent" else "codex"
                if source == "codex":
                    key = native if agent is None else agent
                elif agent is None:
                    key = native
                elif _valid_id(native) and _valid_id(agent):
                    key = f"{native}:agent:{agent}"
                else:
                    continue
                if _valid_id(key):
                    self._rows.setdefault((instance, source, key), []).append((thread, native, agent))
        except sqlite3.Error:
            self._rows.clear()

    def resolve_thread(self, instance, source, session_key):
        identity = _identity(instance, source, session_key)
        if identity is None:
            return None
        return _choose(source, session_key, identity, self._rows.get((instance, source, session_key), ()))


def files_for_session(con, instance, session_key):
    """Return non-retired ledger rows as dictionaries for an exact session identity."""
    source = source_for_instance(instance)
    # Custom Claude instance IDs still carry self-describing child keys.
    if source is None and isinstance(session_key, str) and ":agent:" in session_key:
        source = "claude"
    if source is None:
        source = "codex"
    if _identity(instance, source, session_key) is None:
        return []
    try:
        cur = con.execute(
            "SELECT * FROM native_capture_files WHERE instance=? AND session_key=? AND retired=0 ORDER BY path",
            (instance, session_key),
        )
        columns = [col[0] for col in cur.description]
        if not {"instance", "session_key", "path", "retired"} <= set(columns):
            return []
        return [dict(zip(columns, row)) for row in cur]
    except sqlite3.Error:
        return []
