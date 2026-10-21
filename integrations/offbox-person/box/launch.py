"""Long-lived CloakBrowser for one offbox-person person, on the box's Xvfb :99 session; CDP on 127.0.0.1:9242.

The profile dir is the only place her logins and cookies persist. Her traffic leaves through the owner's home
connection: socks5://127.0.0.1:1055 is a reverse tunnel to a filtering SOCKS server on the owner's Mac. When the
tunnel is down the browser has no internet, on purpose: it must never fall back to the box's datacenter IP.

`~/person/config.json` (optional): {"home": false} uses the box's own IP, {"proxy": "..."} another proxy,
{"locale": "..."} the browser language (geoip would pick ar-AE for a Dubai IP).
"""

import json
import signal
import socket
import sys
import time
from pathlib import Path

from cloakbrowser import launch_persistent_context

HOME_PROXY = ("127.0.0.1", 1055)

home = Path.home() / "person"
cfg_path = home / "config.json"
cfg = json.loads(cfg_path.read_text() or "{}") if cfg_path.exists() else {}


def port_open(addr: tuple[str, int], seconds: float) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            socket.create_connection(addr, timeout=2).close()
            return True
        except OSError:
            time.sleep(1)
    return False


proxy = cfg.get("proxy")
if not proxy and cfg.get("home", True) is not False:
    proxy = f"socks5://{HOME_PROXY[0]}:{HOME_PROXY[1]}"
    # geoip resolves the exit IP through the proxy at launch; without the tunnel it would silently skip the
    # Dubai timezone, so refuse to start instead.
    if not port_open(HOME_PROXY, 30):
        sys.exit("home route 127.0.0.1:1055 is not up; not starting the browser without it")

args = ["--remote-debugging-port=9242", "--force-renderer-accessibility"]
if proxy:
    # SOCKS carries only TCP; without this WebRTC would send UDP straight out of the box's own IP.
    args.append("--force-webrtc-ip-handling-policy=disable_non_proxied_udp")

kwargs = {"headless": False, "geoip": True, "locale": cfg.get("locale", "en-US"), "args": args}
if proxy:
    kwargs["proxy"] = proxy

ctx = launch_persistent_context(str(home / "profile"), **kwargs)


def stop(*_):
    # Closing the context flushes the profile (cookies, sessions) before a save snapshots the disk.
    ctx.close()
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)
while True:
    time.sleep(3600)
