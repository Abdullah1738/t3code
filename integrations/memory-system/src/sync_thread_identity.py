"""Thread identity aliases for native transcripts (table thread_aliases in memory.db).

One Robob conversation can appear under several native ids over its life: an
OpenCode session imported into Robob, a Claude session, a Codex thread, and
Claude/Codex child agents. thread_aliases maps each such native id to the
canonical Robob thread id, so recall aggregates one conversation under one id.

Sources (read-only; never write statev2):
  orchestration_v2_projection_provider_threads   driver/instance + native session id
  orchestration_v2_projection_threads            title, cwd via payload, lineage
  orchestration_v2_projection_subagents          child task -> child thread
  ardud_opencode_import                          OpenCode native id -> imported thread

Refreshed every tick, independently of transcript growth, so a late rename or
a late thread binding reaches recall without new messages. Previously proved
aliases survive recovery unless current evidence contradicts them.
"""

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import schema_migrations  # noqa: E402
from sync_opencode_v2 import with_retry  # noqa: E402

HOME = os.path.expanduser("~")
MEM_DB = os.environ.get("MEMORY_DB", os.path.join(HOME, ".local/share/memory-system/data/memory.db"))
STATE_DB = os.environ.get("ROBOB_STATE_DB", os.path.join(HOME, ".robob/userdata/statev2.sqlite"))

DDL = """
CREATE TABLE IF NOT EXISTS thread_aliases(
  alias_key TEXT PRIMARY KEY,
  canonical_thread_id TEXT NOT NULL,
  root_thread_id TEXT NOT NULL,
  driver TEXT,
  instance TEXT,
  native_id TEXT NOT NULL,
  agent_id TEXT,
  title TEXT,
  cwd TEXT,
  model TEXT,
  first_seen INTEGER,
  last_seen INTEGER,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS thread_aliases_native ON thread_aliases(native_id, agent_id);
CREATE INDEX IF NOT EXISTS thread_aliases_canonical ON thread_aliases(canonical_thread_id);
"""


def _j(text):
    try:
        v = json.loads(text) if text else {}
    except (TypeError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


def _str(v):
    return v if isinstance(v, str) and v else None


def gather(state):
    """Read all source projections from the same SQLite snapshot."""
    if state.in_transaction:
        return _gather(state)
    state.execute("BEGIN")
    try:
        return _gather(state)
    finally:
        state.rollback()


class AliasRows(list):
    def __init__(self):
        super().__init__()
        self.unresolved = []


def _gather(state):
    """Alias rows from statev2 (read-only). Field names follow the live payload_json shapes.

    Thread: title, worktreePath (cwd), lineage.parentThreadId / rootThreadId,
    modelSelection.model. Provider thread: nativeThreadRef.nativeId + driver,
    providerInstanceId, providerThreadId owner thread. Subagent: child thread
    id, nativeTaskRef (the child's native agent id), threadId (parent).
    """
    threads = {}
    for tid, title, payload in state.execute(
        "SELECT thread_id, title, payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL"
    ):
        p = _j(payload)
        lineage = p.get("lineage") if isinstance(p.get("lineage"), dict) else {}
        model_sel = p.get("modelSelection") if isinstance(p.get("modelSelection"), dict) else {}
        threads[tid] = dict(title=title, cwd=_str(p.get("worktreePath")),
                            parent=_str(lineage.get("parentThreadId")), model=_str(model_sel.get("model")),
                            instance=_str(p.get("providerInstanceId")))
    # Native session id per app thread: the provider thread's nativeThreadRef (the id the adapter
    # passes to the SDK as sessionId, and the sessionId transcript records carry). A child
    # subagent is keyed by its PARENT's native session plus its own native agent id, so the
    # parent is resolved through the owning provider thread, never through providerThreadId
    # (an internal projection id, null for native Claude tasks) or the app thread id.
    out = AliasRows()
    for tid, payload, driver, instance in state.execute(
        "SELECT thread_id, payload_json, driver, provider_instance_id FROM orchestration_v2_projection_provider_threads"
        " WHERE thread_id IS NOT NULL"
    ):
        p = _j(payload)
        ref = p.get("nativeThreadRef") if isinstance(p.get("nativeThreadRef"), dict) else {}
        native = _str(ref.get("nativeId"))
        if not native:
            continue
        out.append(dict(canonical=tid, native=native, agent=None, driver=driver or _str(ref.get("driver")),
                        instance=instance or _str(p.get("providerInstanceId")),
                        model=threads.get(tid, {}).get("model")))
    # A child's owning incarnation is found by walking its parentNodeId chain upward until a node
    # is a provider turn's node: that turn's provider thread ran the child. A grandchild under a
    # Claude subagent points at the subagent's task node, which points at the turn, so the walk
    # follows task nodes. No app-thread fallback: a child that resolves to nothing, or to two
    # different provider threads, gets NO alias (logged), never a guessed one.
    by_provider = {pt_id: (native, driver, instance) for pt_id, native, driver, instance in state.execute(
        "SELECT provider_thread_id, json_extract(payload_json,'$.nativeThreadRef.nativeId'), driver, provider_instance_id"
        " FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id IS NOT NULL")}
    turn_owner = {}  # node_id -> set of provider threads that ran a turn at that node
    has_turns = state.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='orchestration_v2_projection_provider_turns'"
    ).fetchone()
    if has_turns:
        for node_id, provider_thread_id in state.execute(
            "SELECT node_id, provider_thread_id FROM orchestration_v2_projection_provider_turns"
        ):
            turn_owner.setdefault(node_id, set()).add(provider_thread_id)
    task_parent = {}  # a subagent's own task node id -> its parentNodeId
    task_parent_ambiguous = set()
    subagent_rows = list(state.execute(
        "SELECT child_thread_id, thread_id, payload_json, driver, provider_instance_id"
        " FROM orchestration_v2_projection_subagents WHERE child_thread_id IS NOT NULL"))
    for _c, _p, payload, _d, _i in subagent_rows:
        pj = _j(payload)
        node, parent_node = _str(pj.get("id")), _str(pj.get("parentNodeId"))
        if node:
            if node in task_parent and task_parent[node] != parent_node:
                task_parent_ambiguous.add(node)
            task_parent[node] = parent_node
    for node in task_parent_ambiguous:
        task_parent[node] = None
        turn_owner[node] = set()
    unresolved = {}  # reason -> child thread ids left without an alias this tick
    for child_tid, parent_tid, payload, driver, instance in subagent_rows:
        p = _j(payload)
        if p.get("origin") == "app_owned":
            continue  # Its child has its own provider thread, not a native task alias.
        ref = p.get("nativeTaskRef") if isinstance(p.get("nativeTaskRef"), dict) else {}
        task = _str(ref.get("nativeId"))
        scope = (child_tid, driver or _str(ref.get("driver")), instance, task)
        if not task:
            out.unresolved.append(scope)
            continue
        owners = resolve_owner(_str(p.get("parentNodeId")), turn_owner, task_parent)
        if owners is None:
            note_unresolved(unresolved, child_tid, "no provider turn in the parent chain")
            out.unresolved.append(scope)
            continue
        if len(owners) != 1:
            note_unresolved(unresolved, child_tid, f"{len(owners)} provider threads claim the parent chain")
            out.unresolved.append(scope)
            continue
        pt = next(iter(owners))
        if pt not in by_provider or not by_provider[pt][0]:
            note_unresolved(unresolved, child_tid, "owning provider thread has no native session")
            out.unresolved.append(scope)
            continue
        parent_native, parent_driver, parent_instance = by_provider[pt]
        out.append(dict(canonical=child_tid, native=parent_native, agent=task,
                        driver=driver or parent_driver or _str(ref.get("driver")),
                        instance=instance or parent_instance, model=None))
    report_unresolved(unresolved)
    for native, tid in state.execute("SELECT native_session_id, thread_id FROM ardud_opencode_import"):
        out.append(dict(canonical=tid, native=native, agent=None, driver="opencode", instance="opencode", model=None))
    for row in out:
        t = threads.get(row["canonical"], {})
        row["title"] = t.get("title")
        row["cwd"] = t.get("cwd")
        row["model"] = row.get("model") or t.get("model")
        row["root"] = _root_of(row["canonical"], threads)
    return out


MAX_CHAIN = 200


def resolve_owner(node_id, turn_owner, task_parent):
    """Walk up from a parent node until a provider turn's node is found.

    Returns the set of provider threads that ran a turn at that node, or None when no turn
    is reached. Cycle-safe (a visited set) and depth-capped at MAX_CHAIN hops.
    """
    seen = set()
    cur = node_id
    for _ in range(MAX_CHAIN):
        if not cur or cur in seen:
            return None
        seen.add(cur)
        if cur in turn_owner:
            return turn_owner[cur]
        cur = task_parent.get(cur)
    return None


def note_unresolved(unresolved, child_tid, reason):
    """A child that cannot be bound gets no alias. Its reason is kept for report_unresolved."""
    unresolved.setdefault(reason, []).append(child_tid)


def report_unresolved(unresolved, sample=5):
    """One stderr line per reason: the count and a few child ids.

    Unbound children stay unbound on every tick, so one line per child would repeat thousands
    of times in the tick log.
    """
    for reason, ids in sorted(unresolved.items()):
        more = f" and {len(ids) - sample} more" if len(ids) > sample else ""
        shown = ", ".join(ids[:sample])
        print(f"thread identity: {len(ids)} child thread(s) without an alias ({reason}): {shown}{more}",
              file=sys.stderr, flush=True)


def _root_of(tid, threads, limit=200):
    """Follow lineage parents to the top. Depth is bounded; a cycle stops at its first repeat."""
    seen, cur = set(), tid
    for _ in range(limit):
        if cur in seen:
            break
        seen.add(cur)
        t = threads.get(cur)
        if not t or not t.get("parent"):
            break
        cur = t["parent"]
    return cur


def _lookup_key(driver, instance, native, agent):
    if not all(isinstance(v, str) and v for v in (driver, instance, native)):
        return None
    if agent is not None and (not isinstance(agent, str) or not agent):
        return None
    if driver == "codex":
        key = native if agent is None else agent
    elif driver == "claudeAgent":
        key = native if agent is None else f"{native}:agent:{agent}"
    else:
        return None
    return driver, instance, key


def _blocked_by_unresolved(row, unresolved):
    driver, instance, native, agent = row["driver"], row["instance"], row["native"], row.get("agent")
    if driver not in ("codex", "claudeAgent"):
        return False
    for _child, scope_driver, scope_instance, task in unresolved:
        if scope_driver in ("codex", "claudeAgent") and scope_driver != driver:
            continue
        if isinstance(scope_instance, str) and scope_instance and scope_instance != instance:
            continue
        if task is None:
            return True
        if driver == "codex" and (agent == task or (agent is None and native == task)):
            return True
        if driver == "claudeAgent" and (agent == task or (agent is None and isinstance(native, str)
                                                          and native.endswith(":agent:" + task))):
            return True
    return False


def write(mem, rows, now=None, *, _inside_transaction=False):
    now = int(time.time()) if now is None else now
    claims = {}
    conflicts = set()
    lookup_claimants = {}
    for row in rows:
        parts = (row["driver"], row["instance"], row["native"], row.get("agent"))
        key = f"{parts[0] or ''}|{parts[1] or ''}|{parts[2]}|{parts[3] or ''}"
        if (not all(isinstance(p, str) and p and "|" not in p for p in parts[:3])
                or (parts[3] is not None and (not isinstance(parts[3], str) or not parts[3] or "|" in parts[3]))
                or not isinstance(row["canonical"], str) or not row["canonical"]):
            conflicts.add(key)
            continue
        if key in claims and claims[key]["canonical"] != row["canonical"]:
            conflicts.add(key)
        else:
            claims[key] = row
        lookup = _lookup_key(*parts)
        if lookup is not None:
            lookup_claimants.setdefault(lookup, set()).add(row["canonical"])
    blocked = set()
    unresolved = list(getattr(rows, "unresolved", ()))
    for row in rows:
        parts = (row["driver"], row["instance"], row["native"], row.get("agent"))
        key = f"{parts[0] or ''}|{parts[1] or ''}|{parts[2]}|{parts[3] or ''}"
        if key in conflicts:
            lookup = _lookup_key(*parts)
            if lookup is not None:
                blocked.add(lookup)
            elif parts[0] in ("codex", "claudeAgent"):
                unresolved.append((row["canonical"], parts[0], parts[1], parts[3]))

    def txn():
        # A skipped child can have had a different task in the previous snapshot.
        blocked_now = set(blocked)
        unresolved_children = {child for child, _driver, _instance, _task in unresolved}
        for child, _driver, _instance, _task in unresolved:
            for driver, instance, native, agent in mem.execute(
                    "SELECT driver,instance,native_id,agent_id FROM thread_aliases WHERE canonical_thread_id=?", (child,)):
                lookup = _lookup_key(driver, instance, native, agent)
                if lookup is not None:
                    blocked_now.add(lookup)
        # Each historical child was proved against its then-current parent native id.
        # Recovery replaces that id in place, so do not invent a child alias for the
        # new parent; preserve the old one only while the current child is unambiguous.
        historical_children = {row[0] for row in mem.execute(
            "SELECT DISTINCT canonical_thread_id FROM thread_aliases WHERE agent_id IS NOT NULL")}
        def invalid_historical(record):
            key, canonical, driver, instance, native, agent = record
            lookup = _lookup_key(driver, instance, native, agent)
            row = {"driver": driver, "instance": instance, "native": native, "agent": agent}
            if canonical in unresolved_children or key in conflicts or lookup in blocked_now or _blocked_by_unresolved(row, unresolved):
                return True
            current = claims.get(key)
            if current is not None and current["canonical"] != canonical:
                return True
            return bool(lookup is not None and lookup_claimants.get(lookup, set()) - {canonical})
        for record in list(mem.execute("SELECT alias_key,canonical_thread_id,driver,instance,native_id,agent_id FROM thread_aliases")):
            if invalid_historical(record):
                mem.execute("DELETE FROM thread_aliases WHERE alias_key=?", (record[0],))
        for key, r in claims.items():
            lookup = _lookup_key(r["driver"], r["instance"], r["native"], r.get("agent"))
            if key in conflicts or lookup in blocked_now or _blocked_by_unresolved(r, unresolved):
                continue
            if r.get("agent") is not None and r["canonical"] in historical_children:
                existing = mem.execute("SELECT 1 FROM thread_aliases WHERE alias_key=?", (key,)).fetchone()
                if not existing:
                    continue
            mem.execute(
                "INSERT INTO thread_aliases(alias_key, canonical_thread_id, root_thread_id, driver, instance,"
                " native_id, agent_id, title, cwd, model, first_seen, last_seen, revision)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)"
                " ON CONFLICT(alias_key) DO UPDATE SET"
                " canonical_thread_id=excluded.canonical_thread_id, root_thread_id=excluded.root_thread_id,"
                " title=coalesce(excluded.title, title), cwd=coalesce(excluded.cwd, cwd),"
                " model=coalesce(excluded.model, model), last_seen=excluded.last_seen,"
                " revision=revision + CASE WHEN canonical_thread_id IS NOT excluded.canonical_thread_id"
                " OR root_thread_id IS NOT excluded.root_thread_id OR title IS NOT excluded.title"
                " OR cwd IS NOT excluded.cwd THEN 1 ELSE 0 END",
                (key, r["canonical"], r["root"], r["driver"], r["instance"], r["native"], r.get("agent"),
                 r.get("title"), r.get("cwd"), r.get("model"), now, now),
            )
        mem.execute(
            "INSERT INTO harness_schema_meta(key, value) VALUES('thread_identity_last_ok', ?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(now),),
        )
        return len(rows)

    return txn() if _inside_transaction else with_retry(mem, txn)


def sync(mem_path=MEM_DB, state_path=STATE_DB):
    if not os.path.isfile(state_path):
        raise FileNotFoundError(f"Robob state DB {state_path} not found")
    mem = sqlite3.connect(mem_path, timeout=600)
    mem.execute("PRAGMA busy_timeout=600000")
    try:
        schema_migrations.migrate(mem)
        mem.executescript(DDL)
        state = sqlite3.connect(f"{Path(os.path.abspath(state_path)).as_uri()}?mode=ro", uri=True, timeout=30)
        state.execute("PRAGMA busy_timeout=30000")
        try:
            # Serialize the source snapshot too: a delayed older gather must not
            # overwrite a newer ambiguity that another refresh already committed.
            n = with_retry(mem, lambda: write(mem, gather(state), _inside_transaction=True))
        finally:
            state.close()
    finally:
        mem.close()
    return n


def main():
    n = sync()
    print("DONE", json.dumps({"aliases": n}), flush=True)


if __name__ == "__main__":
    main()
