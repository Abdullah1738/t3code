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
a late thread binding reaches recall without new messages. Rows are upserted;
revision counts the changes to a row.
"""

import json
import os
import sqlite3
import sys
import time

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
    out = []
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
    subagent_rows = list(state.execute(
        "SELECT child_thread_id, thread_id, payload_json, driver, provider_instance_id"
        " FROM orchestration_v2_projection_subagents WHERE child_thread_id IS NOT NULL"))
    for _c, _p, payload, _d, _i in subagent_rows:
        pj = _j(payload)
        if _str(pj.get("id")) and _str(pj.get("parentNodeId")):
            task_parent[_str(pj.get("id"))] = _str(pj.get("parentNodeId"))
    unresolved = {}  # reason -> child thread ids left without an alias this tick
    for child_tid, parent_tid, payload, driver, instance in subagent_rows:
        p = _j(payload)
        ref = p.get("nativeTaskRef") if isinstance(p.get("nativeTaskRef"), dict) else {}
        task = _str(ref.get("nativeId"))
        if not task:
            continue  # no native task id: nothing native to key this child by
        owners = resolve_owner(_str(p.get("parentNodeId")), turn_owner, task_parent)
        if owners is None:
            note_unresolved(unresolved, child_tid, "no provider turn in the parent chain")
            continue
        if len(owners) != 1:
            note_unresolved(unresolved, child_tid, f"{len(owners)} provider threads claim the parent chain")
            continue
        pt = next(iter(owners))
        if pt not in by_provider or not by_provider[pt][0]:
            note_unresolved(unresolved, child_tid, "owning provider thread has no native session")
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


def write(mem, rows, now=None):
    now = int(time.time()) if now is None else now

    def txn():
        n = 0
        for r in rows:
            key = f"{r['driver'] or ''}|{r['instance'] or ''}|{r['native']}|{r.get('agent') or ''}"
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
            n += 1
        return n

    return with_retry(mem, txn)


def sync(mem_path=MEM_DB, state_path=STATE_DB):
    if not os.path.isfile(state_path):
        raise FileNotFoundError(f"Robob state DB {state_path} not found")
    state = sqlite3.connect(f"file:{state_path}?mode=ro", uri=True, timeout=30)
    state.execute("PRAGMA busy_timeout=30000")
    try:
        rows = gather(state)
    finally:
        state.close()
    mem = sqlite3.connect(mem_path, timeout=600)
    mem.execute("PRAGMA busy_timeout=600000")
    try:
        schema_migrations.migrate(mem)
        mem.executescript(DDL)
        n = write(mem, rows)
    finally:
        mem.close()
    return n


def main():
    n = sync()
    print("DONE", json.dumps({"aliases": n}), flush=True)


if __name__ == "__main__":
    main()
