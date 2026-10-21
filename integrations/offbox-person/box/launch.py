"""Long-lived CloakBrowser for one offbox-person person. Started detached under xvfb-run; CDP on 127.0.0.1:9242.

The profile dir is the only place her logins and cookies persist. `~/person/config.json` may hold a
{"proxy": "..."} setting that the owner chooses; it is absent by default.
"""

import json
import time
from pathlib import Path

from cloakbrowser import launch_persistent_context

home = Path.home() / "person"
cfg_path = home / "config.json"
cfg = json.loads(cfg_path.read_text() or "{}") if cfg_path.exists() else {}

kwargs = {"headless": False, "geoip": True, "args": ["--remote-debugging-port=9242"]}
if cfg.get("proxy"):
    kwargs["proxy"] = cfg["proxy"]

_ctx = launch_persistent_context(str(home / "profile"), **kwargs)
while True:
    time.sleep(3600)
