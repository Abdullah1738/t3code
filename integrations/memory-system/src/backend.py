"""Where the maintenance jobs reach OpenCode and the session UI.

MEMORY_BACKEND picks the backend (default openchamber until the Robob cutover):

  openchamber  OpenCode endpoints through the OpenChamber proxy
               (OPENCHAMBER_URL, default http://127.0.0.1:57123, no auth).
  robob        OpenCode endpoints straight on the OpenCode service
               (OPENCODE_SERVICE_URL, default http://127.0.0.1:49374, basic auth
               user "opencode", password from OPENCODE_SERVER_PASSWORD or
               OPENCODE_PASSWORD_FILE, default ~/.config/opencode-service/password),
               plus the Robob control API (T3_CONTROL_URL/T3_CONTROL_TOKEN, or
               T3_CONTROL_TOKEN_FILE, else ~/.robob/components/memory.json, else the
               shared ~/.robob/ardud-control.json while it exists) and the
               Robob state DB read-only (ROBOB_STATE_DB, default
               ~/.robob/userdata/statev2.sqlite).

OPENCODE_DB overrides the OpenCode DB path the reapers read (read-only).
Stdlib only: the reapers run on the system python.
"""
import base64
import json
import os
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.expanduser("~")
BACKENDS = ("openchamber", "robob")
CONTROL_PREFIX = "/api/ardud/control"


def name():
    b = (os.environ.get("MEMORY_BACKEND") or "openchamber").strip().lower()
    if b not in BACKENDS:
        raise ValueError(f"MEMORY_BACKEND must be one of {', '.join(BACKENDS)}, got {b!r}")
    return b


def is_robob():
    return name() == "robob"


def label():
    return "OpenCode service" if is_robob() else "OpenChamber"


def opencode_db():
    return os.environ.get("OPENCODE_DB") or os.path.join(HOME, ".local/share/opencode/opencode.db")


# ------------------------------------------------------------------ OpenCode
def opencode_url():
    if is_robob():
        url = os.environ.get("OPENCODE_SERVICE_URL", "http://127.0.0.1:49374")
    else:
        url = os.environ.get("OPENCHAMBER_URL", "http://127.0.0.1:57123")
    return url.rstrip("/")


def opencode_password():
    pw = os.environ.get("OPENCODE_SERVER_PASSWORD")
    if pw:
        return pw
    path = os.environ.get("OPENCODE_PASSWORD_FILE") or os.path.join(HOME, ".config/opencode-service/password")
    try:
        with open(path) as fh:
            pw = fh.read().strip()
    except FileNotFoundError:
        raise RuntimeError(f"no OpenCode service password: set OPENCODE_SERVER_PASSWORD or write {path}")
    if not pw:
        raise RuntimeError(f"OpenCode service password file {path} is empty")
    return pw


def opencode_headers():
    if not is_robob():
        return {}
    raw = ("opencode:" + opencode_password()).encode()
    return {"Authorization": "Basic " + base64.b64encode(raw).decode()}


def opencode_request(method, path, body=None):
    """urllib Request for an OpenCode endpoint on the selected backend."""
    headers = opencode_headers()
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    return urllib.request.Request(opencode_url() + path, data=data, method=method, headers=headers)


# ------------------------------------------------------------------ Robob control API
def control_config():
    url = os.environ.get("T3_CONTROL_URL")
    token = os.environ.get("T3_CONTROL_TOKEN")
    if not url or not token:
        # The memory component credential first, the old shared file while it exists.
        path = os.environ.get("T3_CONTROL_TOKEN_FILE") or next(
            (p for p in (os.path.join(HOME, ".robob/components/memory.json"),
                         os.path.join(HOME, ".robob/ardud-control.json")) if os.path.exists(p)),
            os.path.join(HOME, ".robob/components/memory.json"))
        stored = {}
        try:
            if os.stat(path).st_mode & 0o077:
                raise RuntimeError(f"{path} must be chmod 600")
            with open(path) as fh:
                stored = json.load(fh)
        except FileNotFoundError:
            pass
        url = url or stored.get("url")
        token = token or stored.get("token")
    if not url:
        raise RuntimeError(f"no Robob control URL: set T3_CONTROL_URL or write {path}")
    if not token:
        raise RuntimeError(f"no Robob control token: set T3_CONTROL_TOKEN or write {path}")
    return url.rstrip("/"), token


def control(method, path, body=None, timeout=30):
    """Call the Robob control API. Returns (status, json body or None).
    HTTP errors come back as a status; network errors raise."""
    url, token = control_config()
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url + CONTROL_PREFIX + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    try:
        out = json.loads(raw) if raw else None
    except ValueError:
        out = None
    return status, out


def q(s):
    return urllib.parse.quote(s, safe="")


def thread_for_session(ses_id, timeout=30):
    """Robob thread bound to an OpenCode session id, or None (404)."""
    code, body = control("GET", "/threads/by-native/" + q(ses_id), timeout=timeout)
    if code == 404:
        return None
    if code != 200 or not isinstance(body, dict):
        raise RuntimeError(f"by-native {ses_id}: HTTP {code} {_err(body)}")
    return body.get("thread")


def archive_thread(thread_id, timeout=30):
    code, body = control("PATCH", "/threads/" + q(thread_id), {"archived": True}, timeout=timeout)
    if code != 200:
        raise RuntimeError(f"archive {thread_id}: HTTP {code} {_err(body)}")
    return body


def _err(body):
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return f"{body['error'].get('code')}: {str(body['error'].get('message'))[:160]}"
    return str(body)[:160]


# ------------------------------------------------------------------ Robob state DB (read-only)
def robob_state_db():
    return os.environ.get("ROBOB_STATE_DB") or os.path.join(HOME, ".robob/userdata/statev2.sqlite")


def robob_ro():
    path = robob_state_db()
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Robob state DB {path} not found")
    c = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=30)
    c.execute("PRAGMA busy_timeout=30000")
    return c


def tables(con, like):
    return {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?", (like,))}


def native_ids_for_threads(con, thread_ids):
    """OpenCode session ids bound to Robob threads: live provider threads plus the
    OpenCode importer map when it exists."""
    thread_ids = [t for t in set(thread_ids) if t]
    out = set()
    if not thread_ids:
        return out
    have = tables(con, "%")
    for i in range(0, len(thread_ids), 500):
        chunk = thread_ids[i:i + 500]
        marks = ",".join("?" * len(chunk))
        if "orchestration_v2_projection_provider_threads" in have:
            out |= {r[0] for r in con.execute(
                "SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') "
                f"FROM orchestration_v2_projection_provider_threads WHERE thread_id IN ({marks})", chunk)}
        if "ardud_opencode_import" in have:
            out |= {r[0] for r in con.execute(
                f"SELECT native_session_id FROM ardud_opencode_import WHERE thread_id IN ({marks})", chunk)}
    return {s for s in out if isinstance(s, str) and s.startswith("ses")}


LAST_TASK_THREADS_SQL = """
SELECT json_extract(payload_json, '$.scheduledTaskId'), thread_id, max(created_at)
FROM orchestration_v2_projection_messages
WHERE role = 'user' AND json_extract(payload_json, '$.scheduledTaskId') IS NOT NULL
GROUP BY 1
"""


def scheduled_task_session_ids(con):
    """Native session ids of the thread each Robob scheduled task last ran in
    (its bound thread when it posts into one)."""
    threads = {r[0] for r in con.execute("SELECT thread_id FROM scheduled_tasks WHERE thread_id IS NOT NULL")}
    if "orchestration_v2_projection_messages" in tables(con, "orchestration_v2_projection_messages"):
        tasks = {r[0] for r in con.execute("SELECT task_id FROM scheduled_tasks")}
        threads |= {tid for task, tid, _ in con.execute(LAST_TASK_THREADS_SQL) if task in tasks}
    return native_ids_for_threads(con, threads)


def board_backlog_session_ids(con):
    """Native session ids of threads on the Robob board Backlog lane, or None
    when the board tables do not exist yet.
    TODO: read GET /api/ardud/board once the session board lands, instead of its tables."""
    board = tables(con, "ardud_board_%")
    if "ardud_board_rows" not in board:
        return None
    cols = {r[1] for r in con.execute("PRAGMA table_info(ardud_board_rows)")}
    if not {"thread_id", "backlog"} <= cols:
        raise RuntimeError(f"ardud_board_rows has an unknown shape ({sorted(cols)})")
    where = "backlog != 0" + (" AND deleted = 0" if "deleted" in cols else "")
    threads = [r[0] for r in con.execute(f"SELECT thread_id FROM ardud_board_rows WHERE {where}")]
    return native_ids_for_threads(con, threads)
