"""Running OpenCode session ids, read from the shared OpenCode service.

OPENCODE_SERVICE_URL (default http://127.0.0.1:49374), basic auth user
"opencode" with the password from OPENCODE_SERVER_PASSWORD or
~/.config/opencode-service/password. Robob drives this service, so its
running threads show up here as running sessions.
"""
import base64
import json
import os
import urllib.request

OC_SERVICE_URL = os.environ.get("OPENCODE_SERVICE_URL", "http://127.0.0.1:49374")
PASSWORD_FILE = os.path.expanduser("~/.config/opencode-service/password")

def _password():
    pw = os.environ.get("OPENCODE_SERVER_PASSWORD")
    if pw:
        return pw
    try:
        with open(PASSWORD_FILE) as f:
            return f.read().strip()
    except OSError:
        return None

def _fetch(url, auth=None, timeout=20):
    req = urllib.request.Request(url.rstrip("/") + "/api/session/active")
    if auth:
        token = base64.b64encode(f"opencode:{auth}".encode()).decode()
        req.add_header("Authorization", "Basic " + token)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return set((json.load(r).get("data") or {}).keys())

def active_session_ids(timeout=20):
    """Return (set_of_ids, None), or (None, error) when the service can't be read."""
    try:
        return _fetch(OC_SERVICE_URL, _password(), timeout), None
    except Exception as e:  # noqa: BLE001
        return None, f"opencode-service: {e}"
