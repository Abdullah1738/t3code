"""The set of work that is running right now, from both harnesses.

Two sources, unioned:
  - Robob's control API: GET /api/ardud/control/threads?active=true. Claude and Codex threads (and OpenCode
    threads Robob drives) show up here, with their worktree path and native session id.
  - The shared OpenCode service: GET /api/session/active, for OpenCode sessions Robob does not front.

The snapshot is "complete" only when both sources answered in full. A source that is down, returns something
unreadable, or is truncated (the control API caps a page at 500 and reports the full count in `total`) makes
the snapshot incomplete. The reapers keep everything when it is incomplete: a missing source means "unknown",
never "idle".

The control credential is the rcsim component's file. Robob has no janitor component yet; adding one is a server
change (apps/server/src/ardud/auth/components.ts) that needs a deploy. rcsim is the closest existing read-only
Run Cloud sweep and holds the same read scope. Override with ROBOB_CONTROL_CONFIG when a janitor component exists.
OPENCODE_SERVICE_URL (default http://127.0.0.1:49374). Password: OPENCODE_SERVER_PASSWORD or
~/.config/opencode-service/password.
"""
import base64
import json
import os
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


class Snapshot(dict):
    """{complete, threads: {threadId: {...}}, opencode: set(ids), problems: [str]}."""


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


def robob_active(timeout=20):
    """Every active Robob thread, or (None, error). Pages past the 500 cap by widening nothing: the API has
    no cursor, so a result larger than one page is reported incomplete and the caller keeps everything."""
    # The full list, not active=true: that filter is built from runs and pending requests, so a native child with
    # neither is absent from it. includeSubagents keeps subagent threads in the list (the API hides them by
    # default). The janitor decides activity from each thread with in_use().
    query = "/threads?" + urllib.parse.urlencode({"includeSubagents": "true", "limit": CONTROL_PAGE})
    status, body = _control_get(query, timeout)
    if status == 0 and isinstance(body, str):
        return None, f"control api: {body}"
    if status != 200 or not isinstance(body, dict) or body.get("ok") is not True:
        return None, f"control api: status {status}"
    threads = body.get("threads")
    total = body.get("total")
    if not isinstance(threads, list) or not isinstance(total, int):
        return None, "control api: unreadable thread list"
    if total > len(threads):
        return None, f"control api: {total} active threads, only {len(threads)} returned (truncated)"
    return {t["threadId"]: t for t in threads if isinstance(t, dict) and t.get("threadId")}, None


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
    """The union of both sources, with `complete` true only when every source answered in full and every in-use
    thread has a known workspace."""
    problems = []
    threads, err = robob_active(timeout)
    if err:
        problems.append(err)
    opencode, oc_err = opencode_active(timeout)
    if oc_err:
        problems.append(oc_err)
    roots = {}
    in_use_threads = [t for t in (threads or {}).values() if in_use(t)]
    if any(not t.get("worktreePath") for t in in_use_threads):
        roots, roots_err = project_roots(timeout)
        if roots_err:
            problems.append(roots_err)
        else:
            for t in in_use_threads:
                if not workspace_of(t, roots):
                    problems.append(f"workspace unknown for thread {t.get('threadId')}")
    return Snapshot(complete=not problems, threads=threads or {}, opencode=opencode or set(),
                    problems=problems)


def active_workspaces(timeout=20):
    """Every directory an in-use Robob thread works in, or None when the set is incomplete."""
    snap = snapshot(timeout)
    if not snap["complete"]:
        return None
    roots, _ = project_roots(timeout) if any(not t.get("worktreePath") for t in snap["threads"].values()) \
        else ({}, None)
    return {workspace_of(t, roots or {}) for t in snap["threads"].values() if in_use(t)} - {None}


def active_session_ids(timeout=20):
    """Back-compat shape for callers that only know OpenCode: (ids, None) or (None, error)."""
    return opencode_active(timeout)
