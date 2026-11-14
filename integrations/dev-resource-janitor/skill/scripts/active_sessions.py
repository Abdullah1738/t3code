"""The set of work that is running right now, from both harnesses.

Two sources, unioned:
  - Robob's control API, read in two queries that are each complete on their own, merged by threadId:
      a. GET /threads?active=true&includeSubagents=true: every non-idle thread (runs and pending requests). The
         server builds this from its live ids, so it is small (about 100 on a 26k-thread server).
      b. GET /threads?creationSource=provider&updatedSince=<now - 48 h>: provider-native
         children, including runless children whose app state is idle during native work.
         MCP-delegated tasks have app runs, so (a) covers their non-terminal work without
         pulling thousands of completed delegated tasks into this query.
    Each thread is judged by in_use(), and its workspace is its worktree path or, on the root workspace, its
    project's workspaceRoot. Claude and Codex threads (and OpenCode threads Robob drives) come from here.
  - The shared OpenCode service: GET /api/session/active, for OpenCode sessions Robob does not front.

The snapshot is "complete" only when both sources answered in full. A source that is down, returns something
unreadable, or is truncated (the control API caps a page at 500 and reports the full count in `total`) makes
the snapshot incomplete. The reapers keep everything when it is incomplete: a missing source means "unknown",
never "idle". Query (b) excludes completed MCP task history while preserving runless native children.
The reaper reads complete historical activity separately, including archived threads.

The control credential is the rcsim component's file. Robob has no janitor component yet; adding one is a server
change (apps/server/src/ardud/auth/components.ts) that needs a deploy. rcsim is the closest existing read-only
Run Cloud sweep and holds the same read scope. Override with ROBOB_CONTROL_CONFIG when a janitor component exists.
OPENCODE_SERVICE_URL (default http://127.0.0.1:49374). Password: OPENCODE_SERVER_PASSWORD or
~/.config/opencode-service/password.
"""
import base64
import datetime
import json
import math
import os
import time
import tempfile
import urllib.error
import urllib.parse
import urllib.request

OC_SERVICE_URL = os.environ.get("OPENCODE_SERVICE_URL", "http://127.0.0.1:49374")
PASSWORD_FILE = os.path.expanduser("~/.config/opencode-service/password")
CONTROL_CFGS = tuple(
    p for p in (
        os.environ.get("ROBOB_CONTROL_CONFIG"),
        os.path.expanduser("~/.robob/components/rcsim.json"),
    ) if p
)
# The control API's page cap. A full page is not proof of completeness, so we check `total` too.
CONTROL_PAGE = 500
# How far back a provider-native or delegated child still counts as possibly holding a checkout. The janitor's idle
# threshold is 60 min; a child idle for two days owns nothing live.
NATIVE_WINDOW_MS = 48 * 60 * 60 * 1000
# The native query scans the full thread shell table server-side (7-46 s on the 26k-thread server), so it gets a
# longer timeout than the default 20 s.
NATIVE_TIMEOUT = 60


class Snapshot(dict):
    """{complete, threads: {threadId: {...}}, opencode: set(ids), workspaces: {threadId: dir}, problems: [str]}."""


def _password():
    pw = os.environ.get("OPENCODE_SERVER_PASSWORD")
    if pw:
        return pw
    try:
        with open(PASSWORD_FILE) as f:
            return f.read().strip()
    except OSError:
        return None


def opencode_active(timeout=20):
    """(set of running OpenCode session ids, None) or (None, error text)."""
    try:
        req = urllib.request.Request(OC_SERVICE_URL.rstrip("/") + "/api/session/active")
        pw = _password()
        if pw:
            token = base64.b64encode(f"opencode:{pw}".encode()).decode()
            req.add_header("Authorization", "Basic " + token)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.load(r)
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict):
            return None, "opencode-service: unreadable active list"
        return set(data.keys()), None
    except Exception as e:  # noqa: BLE001
        return None, f"opencode-service: {e}"


def _control_config():
    for path in CONTROL_CFGS:
        if os.path.exists(path):
            return path
    return None


def _control_get(path, timeout=20):
    """(status, json) for a GET on the control API, or (0, error text) when it can't be reached or read."""
    cfg_path = _control_config()
    if cfg_path is None:
        return 0, "no control credential file"
    try:
        if os.stat(cfg_path).st_mode & 0o077:
            return 0, f"{cfg_path} must be chmod 600"
        with open(cfg_path) as f:
            cfg = json.load(f)
        url = cfg["url"].rstrip("/") + "/api/ardud/control" + path
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + cfg["token"]})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def _control_threads(query, timeout, label):
    """One thread query as {threadId: summary}, or (None, error). The API has no cursor and caps a page at 500,
    so a result larger than one page is reported incomplete rather than read partly."""
    status, body = _control_get(query, timeout)
    if status == 0 and isinstance(body, str):
        return None, f"control api {label}: {body}"
    if status != 200 or not isinstance(body, dict) or body.get("ok") is not True:
        return None, f"control api {label}: status {status}"
    threads = body.get("threads")
    total = body.get("total")
    if not isinstance(threads, list) or not isinstance(total, int):
        return None, f"control api {label}: unreadable thread list"
    if total > len(threads):
        return None, f"control api {label}: {total} threads, only {len(threads)} returned (truncated)"
    if total != len(threads) or any(not isinstance(t, dict) or not isinstance(t.get("threadId"), str)
                                    or not t["threadId"] or t.get("state") not in {"idle", "running", "queued", "waiting", "needs-input"}
                                    for t in threads):
        return None, f"control api {label}: malformed roster"
    mapped = {t["threadId"]: t for t in threads}
    if len(mapped) != total:
        return None, f"control api {label}: duplicate thread ids"
    return mapped, None


def robob_active(timeout=20, now_ms=None):
    """Every active Robob thread, or (None, error). The union of two complete queries (see the module docstring).
    Either query failing or truncating makes the whole result incomplete, so a caller keeps everything."""
    # (a) Every non-idle thread. The server builds this from its live ids, so it is small. A null `now_ms` means
    # the wall clock; tests pass one so the window is exact.
    live, err = _control_threads(
        "/threads?" + urllib.parse.urlencode({"active": "true", "includeSubagents": "true", "limit": CONTROL_PAGE}),
        timeout, "active")
    if err:
        return None, err
    # Native children can be runless/idle during provider work. Filter by source,
    # not state; app-delegated tasks with live work are already in query (a).
    now = int(time.time() * 1000) if now_ms is None else now_ms
    native, err = _control_threads(
        "/threads?" + urllib.parse.urlencode({
            "creationSource": "provider",
            "includeSubagents": "true",
            "updatedSince": str(now - NATIVE_WINDOW_MS),
            "limit": CONTROL_PAGE,
        }),
        NATIVE_TIMEOUT, "native")
    if err:
        return None, err
    return {**native, **live}, None


def in_use(thread):
    """Whether a Robob thread may own a worktree the reapers must keep.

    A running or waiting thread is in use. So is any provider-native child, even an idle one: a native child can
    own its checkout between turns, and "idle" is not "gone" for it. Only a settled app thread with no live run is
    free to reap.
    """
    if thread.get("state") not in (None, "idle"):
        return True
    return thread.get("creationSource") == "provider" or thread.get("relationshipToParent") == "subagent"


def project_roots(timeout=20):
    """{projectId: workspaceRoot} from the control API, or (None, error)."""
    status, body = _control_get("/projects", timeout)
    if status == 0 and isinstance(body, str):
        return None, f"control api projects: {body}"
    if status != 200 or not isinstance(body, dict) or body.get("ok") is not True:
        return None, f"control api projects: status {status}"
    projects = body.get("projects")
    if not isinstance(projects, list):
        return None, "control api projects: unreadable"
    return {p["projectId"]: p["workspaceRoot"] for p in projects
            if isinstance(p, dict) and p.get("projectId") and p.get("workspaceRoot")}, None


def workspace_of(thread, roots):
    """The directory a thread works in: its worktree, or its project root when it runs on the root workspace.

    A null worktreePath is normal for a root-workspace thread, so the project root is the directory to keep.
    Returns None when neither is known (the caller treats that as incomplete).
    """
    path = thread.get("worktreePath")
    if path:
        return path
    return roots.get(thread.get("projectId"))


def snapshot(timeout=20):
    """The union of both sources, read once. `complete` is true only when every source answered in full and every
    in-use thread has a known workspace. `workspaces` maps each in-use thread to its directory, so a caller that
    needs the directories reads them from this same answer instead of reading the sources again."""
    problems = []
    threads, err = robob_active(timeout)
    if err:
        problems.append(err)
    opencode, oc_err = opencode_active(timeout)
    if oc_err:
        problems.append(oc_err)
    in_use_threads = [t for t in (threads or {}).values() if in_use(t)]
    roots = {}
    if any(not t.get("worktreePath") for t in in_use_threads):
        found, roots_err = project_roots(timeout)
        if roots_err:
            # A root-workspace thread's directory is unknown without the roots. The snapshot is then incomplete,
            # and the reapers keep everything rather than protect only the worktree paths they could read.
            problems.append(roots_err)
        else:
            roots = found
    workspaces = {}
    for t in in_use_threads:
        path = workspace_of(t, roots)
        if path:
            workspaces[t["threadId"]] = path
        else:
            problems.append(f"workspace unknown for thread {t.get('threadId')}")
    return Snapshot(complete=not problems, threads=threads or {}, opencode=opencode or set(),
                    workspaces=workspaces, problems=problems)


def active_session_ids(timeout=20):
    """Back-compat shape for callers that only know OpenCode: (ids, None) or (None, error)."""
    return opencode_active(timeout)


def checked_snapshot(timeout=20):
    """Convert even unexpected client failures to an incomplete roster, never an empty live set."""
    try:
        return snapshot(timeout)
    except Exception as exc:
        return Snapshot(complete=False, threads={}, opencode=set(), workspaces={},
                        problems=[f"active sessions: {type(exc).__name__}"])


def opencode_directories(ids, timeout=20):
    """Resolve the active service ids through its supported session endpoint."""
    result = {}
    for sid in ids:
        try:
            req = urllib.request.Request(OC_SERVICE_URL.rstrip("/") + "/api/session/" +
                                         urllib.parse.quote(sid, safe=""))
            pw = _password()
            if pw:
                req.add_header("Authorization", "Basic " + base64.b64encode(f"opencode:{pw}".encode()).decode())
            with urllib.request.urlopen(req, timeout=timeout) as response:
                data = json.load(response).get("data")
            if not isinstance(data, dict) or not isinstance((data.get("location") or {}).get("directory", data.get("directory")), str) or not (data.get("location") or {}).get("directory", data.get("directory")):
                return None, "opencode-service: session directory unavailable"
            result[sid] = (data.get("location") or {}).get("directory", data.get("directory"))
        except Exception as exc:
            return None, f"opencode-service directory: {type(exc).__name__}"
    return result, None


def directories(snap):
    if not snap["complete"]:
        return None, "; ".join(snap["problems"]) or "active set incomplete"
    oc, err = opencode_directories(snap["opencode"])
    if err:
        return None, err
    return {**oc, **{"thread:" + tid: path for tid, path in snap["workspaces"].items()}}, None


def opencode_get(path, timeout=20):
    req = urllib.request.Request(OC_SERVICE_URL.rstrip('/') + path)
    pw = _password()
    if pw:
        req.add_header('Authorization', 'Basic ' + base64.b64encode(f'opencode:{pw}'.encode()).decode())
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def _session_pages(activity, high_water=None, directory=None):
    ids, cursors = set(), set()
    cursor, previous, newest = None, None, high_water or 0
    for page in range(200):
        query = {'limit': CONTROL_PAGE, 'order': 'desc'}
        if directory is not None:
            query['directory'] = directory
        if cursor:
            query['cursor'] = cursor
        body = opencode_get('/api/session?' + urllib.parse.urlencode(query))
        rows = body.get('data')
        pagination = body.get('cursor')
        if not isinstance(rows, list) or not isinstance(pagination, dict) or 'next' not in pagination:
            raise ValueError('session list/cursor unavailable')
        updates = []
        for row in rows:
            sid = row.get('id')
            row_directory = (row.get('location') or {}).get('directory', row.get('directory'))
            updated = row.get('time', {}).get('updated')
            if not sid or not row_directory or not isinstance(updated, (int, float)) or not math.isfinite(updated) or updated < 0:
                raise ValueError('session id/location.directory/time.updated unavailable')
            if directory is not None and directory.rstrip('/') != row.get('location', {}).get('directory', row.get('directory', '')).rstrip('/'):
                raise ValueError('session directory filter ignored')
            if sid in ids:
                raise ValueError('session pagination repeated an id')
            if previous is not None and updated > previous:
                raise ValueError('session history is not newest-updated-first')
            previous = updated
            ids.add(sid)
            updates.append(updated)
            newest = max(newest, updated)
            timestamps = [row['time'].get(key, 0) or 0 for key in ('updated', 'viewed', 'idle')]
            if any(not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0 for t in timestamps):
                raise ValueError('session activity timestamp unavailable')
            activity[row_directory.rstrip('/')] = max(activity.get(row_directory.rstrip('/'), 0), max(timestamps) / 1000)
        # The installed service's SessionStore.list orders by time_updated DESC,
        # id DESC; the route's cursor anchors on time.updated. Request that order
        # explicitly and validate it on every page before using this cutoff.
        if high_water is not None and updates and max(updates) < high_water:
            return activity, newest, {'sessions': len(ids), 'pages': page + 1}
        cursor = pagination['next']
        if cursor is None:
            return activity, newest, {'sessions': len(ids), 'pages': page + 1}
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise ValueError('session pagination did not advance')
        cursors.add(cursor)
    raise ValueError('session pagination truncated after 200 pages')


def session_history(cache_path=None, write_cache=False, now=None):
    """Complete directory history, bootstrapped daily and incrementally refreshed between full reads."""
    started = time.monotonic()
    now = time.time() if now is None else now
    cache = None
    if cache_path:
        try:
            with open(cache_path) as file:
                saved = json.load(file)
            if (saved['version'] == 1 and saved['service'] == OC_SERVICE_URL
                    and 0 <= now - saved['full_at'] < 86400
                    and isinstance(saved['high_water'], (int, float))
                    and math.isfinite(saved['high_water']) and 0 <= saved['high_water'] <= now * 1000
                    and isinstance(saved['directories'], dict)
                    and all(isinstance(k, str) and isinstance(v, (int, float)) and math.isfinite(v) and v >= 0 for k, v in saved['directories'].items())):
                cache = saved
        except (OSError, ValueError, KeyError, TypeError):
            pass
    mode = 'incremental' if cache else 'full'
    try:
        try:
            activity, high_water, stats = _session_pages(dict(cache['directories']) if cache else {},
                                                        cache['high_water'] if cache else None)
        except Exception:
            if cache is None:
                raise
            # A cursor/order failure invalidates the incremental proof. Rebuild
            # once from the start; never publish a partially refreshed cache.
            mode = 'full_after_incremental_error'
            activity, high_water, stats = _session_pages({})
            cache = None
        stats.update(mode=mode, duration_s=round(time.monotonic() - started, 3), high_water=high_water)
        if cache_path and write_cache:
            state = dict(version=1, service=OC_SERVICE_URL, directories=activity, high_water=high_water,
                         full_at=cache['full_at'] if cache else now)
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            fd, path = tempfile.mkstemp(prefix='.history-', dir=os.path.dirname(cache_path))
            try:
                with os.fdopen(fd, 'w') as file:
                    json.dump(state, file)
                os.replace(path, cache_path)
            finally:
                if os.path.exists(path):
                    os.unlink(path)
        return activity, stats, None
    except Exception as exc:
        return None, {}, f'opencode history: {type(exc).__name__}: {exc}'


def project_activity(project_id, root, since_ms):
    """Recent history for one project, including archived threads. A cap only disables that repo's reaping."""
    activity = {}
    for archived in (False, True):
        query = {'projectId': project_id, 'includeSubagents': 'true', 'updatedSince': since_ms,
                 'limit': CONTROL_PAGE}
        if archived:
            query['archived'] = 'true'
        threads, err = _control_threads('/threads?' + urllib.parse.urlencode(query), NATIVE_TIMEOUT,
                                        f'history {project_id} archived={archived}')
        if err:
            return None, err
        for thread in threads.values():
            path = thread.get('worktreePath') or root
            try:
                stamps = [thread.get('updatedAt'), thread.get('archivedAt')]
                updated = max(datetime.datetime.fromisoformat(t.replace('Z', '+00:00')).timestamp()
                              for t in stamps if t is not None)
            except (ValueError, TypeError):
                return None, 'control history: updatedAt unavailable'
            activity[path.rstrip('/')] = max(activity.get(path.rstrip('/'), 0), updated)
    return activity, None


def worktree_activity(path, known_directories):
    """Fresh complete directory reads cover viewed/idle changes below the updated-time cutoff."""
    roots = {path.rstrip('/'), os.path.realpath(path).rstrip('/')}
    directories = roots | {directory for directory in known_directories
                           if any(directory == root or directory.startswith(root + '/') for root in roots)}
    activity = {}
    try:
        for directory in sorted(directories):
            paths, _, _ = _session_pages({}, directory=directory)
            for key, value in paths.items():
                activity[key] = max(activity.get(key, 0), value)
        return activity, None
    except Exception as exc:
        return None, f'worktree activity: {type(exc).__name__}: {exc}'
