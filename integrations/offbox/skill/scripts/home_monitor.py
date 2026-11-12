#!/opt/homebrew/bin/python3
"""Home offbox server health monitor: one short check per run (launchd, every 60 s).

Tells the offbox client whether the home server serves runs (backend-state.json), and on an outage
starts a repair agent in its own Robob thread and sends one Telegram. Never logs tokens or response
bodies. Does nothing at all until bootstrap has written server.json.

Self-contained on purpose (stdlib only, no import of the load monitor's modules): a fault in one
monitor must not stop the other.
"""
from __future__ import annotations

import argparse
import datetime as dt
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = Path.home()

DOWN_AFTER = 2            # failed checks in a row, with the Mac online, before home is down
UP_AFTER = 3              # good checks in a row before home is up again
COOLDOWN_S = 30 * 60      # an outage starting this soon after the last alert/recovery is the same outage
GAP_S = 150               # last tick older than this (sleep, reboot, agent unloaded): warm-up tick
MIN_SPACING_S = 30        # a check sooner than this after the last one (a manual run) counts for nothing
HEALTH_TIMEOUT_S = 4
PROBE_TIMEOUT_S = 3
DEGRADED_REALERT_S = 24 * 3600
RECOVERY_NOTICE_GIVE_UP_S = 6 * 3600
INTERNET_PROBES = (("1.1.1.1", 443), ("8.8.8.8", 443))   # IP literals: no DNS, nothing on the tailnet
TAILSCALE_PATHS = ("/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale",
                   "/opt/homebrew/bin/tailscale")

# Repair agent: Fable 5.2 on the native Claude harness, standard mode. "<providerInstanceId>:<model>"
# as `t3ctl models` lists them. Fast mode is the model option `fastMode`; it is never sent, and the
# explicit options list below replaces anything a project default could add.
REPAIR_MODEL = os.environ.get("OFFBOX_REPAIR_MODEL") or "claudeAgent:claude-fable-5-2"
REPAIR_EFFORT = os.environ.get("OFFBOX_REPAIR_EFFORT") or "high"
REPAIR_DIR = os.environ.get("OFFBOX_REPAIR_DIR") or "/Volumes/ExternalSSD/t3code-fork"
RUNBOOK = "/Volumes/ExternalSSD/t3code-fork/integrations/offbox/server/home/REPAIR-RUNBOOK.md"
PREFIX = "[Automated message from the offbox home monitor (com.ardud.offbox-home-monitor), not typed by Abdullah.]"
TELEGRAM_SOURCE = "offbox home monitor"
DUBAI = dt.timezone(dt.timedelta(hours=4))


# ---------------------------------------------------------------- files

def state_dir():
    return Path(os.environ.get("OFFBOX_STATE_DIR") or HOME / ".local/share/offbox")


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def write_json(path, value):
    """Atomic: a reader sees the old file or the new one, never half of one."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    with tmp.open("w") as output:
        output.write(json.dumps(value, sort_keys=True) + "\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(tmp, path)


def configured_url(sdir):
    """The home server's API URL, or None when the home server is not configured (then: do nothing)."""
    cfg = read_json(Path(sdir) / "server.json", None)
    if not isinstance(cfg, dict) or cfg.get("disabled") is True:
        return None
    url = cfg.get("url")
    if not isinstance(url, str) or not re.match(r"https?://[^/\s]+", url):
        return None
    return url.rstrip("/")


def log(sdir, text):
    path = Path(sdir) / "home-monitor.log"
    try:
        if path.stat().st_size > 2_000_000:
            os.replace(path, path.with_name(path.name + ".1"))
    except OSError:
        pass
    stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    with path.open("a") as output:
        output.write(stamp + " " + text + "\n")


def clean(value, limit=120):
    """Printable, bounded text from something another program wrote."""
    return re.sub(r"[^\x20-\x7e]", "?", str("" if value is None else value))[:limit]


def read_client_failures(sdir, after):
    """Lines the offbox client appended after `after`. Informational only: they never mark home down."""
    path = Path(sdir) / "home-failures.jsonl"
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return []
    found = []
    for line in lines[-400:]:
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if not isinstance(item, dict) or isinstance(item.get("ts"), bool):
            continue
        if isinstance(item.get("ts"), (int, float)) and item["ts"] > after:
            found.append({"ts": float(item["ts"]), "reason": clean(item.get("reason"), 160),
                          "run": clean(item.get("run"), 80)})
    if len(lines) > 400:
        tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
        try:
            tmp.write_text("\n".join(lines[-200:]) + "\n")
            os.replace(tmp, path)
        except OSError:
            pass
    return found


# ---------------------------------------------------------------- probes

def error_class(error):
    reason = getattr(error, "reason", error)
    if isinstance(reason, TimeoutError) or "timed out" in str(reason):
        return "timeout"
    if isinstance(reason, ConnectionRefusedError):
        return "refused"
    if isinstance(reason, ConnectionResetError):
        return "reset"
    if isinstance(reason, socket.gaierror):
        return "dns"
    if isinstance(reason, OSError) and reason.errno in (errno.EHOSTUNREACH, errno.ENETUNREACH,
                                                        errno.EHOSTDOWN, errno.ENETDOWN):
        return "unreachable"
    return "error:" + type(reason).__name__


def health_facts(data):
    """The few health fields the monitor keeps. Everything is bounded; the body itself is never kept."""
    pool = data.get("pool") if isinstance(data.get("pool"), dict) else {}
    mdraid = data.get("mdraid") if isinstance(data.get("mdraid"), dict) else {}
    reasons = data.get("reasons") if isinstance(data.get("reasons"), list) else []

    def number(key):
        value = data.get(key)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    # boot_id is the kernel's (it changes when the box restarts); boatd_uptime_s is boatd's own, when sent.
    return {"mode": clean(data.get("mode"), 20), "reasons": [clean(r) for r in reasons[:8]],
            "pool": clean(pool.get("state"), 20), "mdraid": clean(mdraid.get("state"), 20),
            "boot_id": clean(data.get("boot_id"), 64), "version": clean(data.get("version"), 40),
            "uptime_s": number("uptime_s"), "boatd_uptime_s": number("boatd_uptime_s")}


def check_health(url):
    """GET <url>/health. No auth header, ever. Good = HTTP 200, a JSON object, `ok` true."""
    request = urllib.request.Request(url.rstrip("/") + "/health", method="GET",
                                     headers={"Accept": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=HEALTH_TIMEOUT_S) as response:
            status = response.status
            raw = response.read(65536)
    except urllib.error.HTTPError as error:
        error.close()
        return {"ok": False, "error": f"http_{error.code}", "health": {}}
    except Exception as error:  # noqa: BLE001 - every transport failure is a failed check
        return {"ok": False, "error": error_class(error), "health": {}}
    if status != 200:
        return {"ok": False, "error": f"http_{status}", "health": {}}
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        return {"ok": False, "error": "bad_json", "health": {}}
    facts = health_facts(data)
    if data.get("ok") is not True:
        return {"ok": False, "error": "not_ok", "health": facts}
    return {"ok": True, "error": "", "health": facts}


def _run(args, timeout):
    env = dict(os.environ)
    env.pop("BUN_INSPECT", None)
    try:
        return subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              timeout=timeout, env=env)
    except (OSError, subprocess.SubprocessError):
        return None


def tailnet_facts(url=None):
    """Is this Mac on the tailnet (BackendState Running and Self.Online), and what it knows of the box."""
    host = urllib.parse.urlsplit(url).hostname if url else None
    paths = ([os.environ["OFFBOX_TAILSCALE"]] if os.environ.get("OFFBOX_TAILSCALE") else []) + list(TAILSCALE_PATHS)
    seen = False
    for path in paths:
        if not os.access(path, os.X_OK):
            continue
        seen = True
        result = _run([path, "status", "--json"], 5)
        try:
            data = json.loads(result.stdout) if result is not None else None
        except ValueError:
            data = None
        if not isinstance(data, dict):
            continue
        own = data.get("Self") if isinstance(data.get("Self"), dict) else {}
        backend = clean(data.get("BackendState"), 20)
        online = own.get("Online") is True
        peer = "not listed"
        for item in (data.get("Peer") or {}).values() if isinstance(data.get("Peer"), dict) else ():
            names = (str(item.get("HostName") or "").lower(), str(item.get("DNSName") or "").lower())
            if (host and host in (item.get("TailscaleIPs") or [])) or any(n.startswith("offbox-server") for n in names):
                peer = "listed, online" if item.get("Online") else \
                    "listed, offline (last seen " + clean(item.get("LastSeen"), 30) + ")"
                break
        return {"up": backend == "Running" and online, "peer": peer,
                "detail": f"BackendState={backend} Self.Online={str(online).lower()}"}
    return {"up": False, "peer": "unknown",
            "detail": "tailscale CLI gave no status" if seen else "tailscale CLI not found"}


def internet_facts():
    """Either probe passing is enough."""
    failed = []
    for host, port in INTERNET_PROBES:
        try:
            socket.create_connection((host, port), timeout=PROBE_TIMEOUT_S).close()
            return {"ok": True, "detail": f"{host}:{port} ok"}
        except OSError as error:
            failed.append(f"{host}:{port} {error_class(error)}")
    return {"ok": False, "detail": "; ".join(failed)}


def mac_online(url=None):
    tailnet, internet = tailnet_facts(url), internet_facts()
    return {"online": tailnet["up"] and internet["ok"], "tailnet": tailnet["up"], "internet": internet["ok"],
            "tailnet_detail": tailnet["detail"], "internet_detail": internet["detail"], "peer": tailnet["peer"]}


# ---------------------------------------------------------------- effects (the only things that send)

def ctl(method, path, body=None, timeout=10):
    """Robob control API with offbox's own component credential (as monitor_support.ctl, with a timeout).

    The token is read here, goes into one header and nowhere else."""
    paths = (HOME / ".robob/components/offbox.json", HOME / ".robob/ardud-control.json")
    cfg_file = next((p for p in paths if p.exists()), paths[0])
    try:
        if cfg_file.stat().st_mode & 0o077:
            return 0, {}
    except OSError:
        return 0, {}
    cfg = read_json(cfg_file, {})
    if not isinstance(cfg, dict) or not cfg.get("url") or not cfg.get("token"):
        return 0, {}
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(cfg["url"].rstrip("/") + "/api/ardud/control" + path, method=method,
                                     data=data, headers={"Authorization": "Bearer " + cfg["token"],
                                                         "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        error.close()
        return error.code, {}
    except (OSError, ValueError):
        return 0, {}


def model_selection():
    instance, sep, model = REPAIR_MODEL.partition(":")
    if not sep:
        # A bare slug: the API picks the provider (an "a/b" slug is an OpenCode model, effort is its variant).
        return {"model": REPAIR_MODEL, "variant": REPAIR_EFFORT}
    return {"providerInstanceId": instance, "model": model,
            "options": [{"id": "effort", "value": REPAIR_EFFORT}]}


class Effects:
    """Real senders. Every call is safe to repeat: request ids and Telegram keys are stable."""

    def thread_open(self, thread_id):
        """True = exists and not archived, False = archived or gone, None = could not tell."""
        status, data = ctl("GET", "/threads/" + urllib.parse.quote(thread_id, safe=""))
        if status == 404:
            return False
        if status != 200 or not isinstance(data, dict) or not isinstance(data.get("thread"), dict):
            return None
        return data["thread"].get("archived") is not True

    def create_thread(self, title, prompt, request_id):
        body = {"prompt": prompt, "title": title, "directory": REPAIR_DIR, "origin": "automation",
                "runtimeMode": "full-access", "clientRequestId": request_id[:120], **model_selection()}
        status, data = ctl("POST", "/threads", body, timeout=30)
        thread_id = data.get("threadId") if isinstance(data, dict) else None
        return thread_id if status in (200, 201) and isinstance(thread_id, str) and thread_id else None

    def thread_send(self, thread_id, text, request_id):
        status, _ = ctl("POST", "/threads/" + urllib.parse.quote(thread_id, safe="") + "/send",
                        {"text": text, "mode": "auto", "clientRequestId": request_id[:120]}, timeout=20)
        return 200 <= status < 300

    def telegram(self, text, key):
        result = _run([str(HOME / ".bun/bin/bun"), str(HOME / ".local/share/telegram-bridge/src/cli.ts"),
                       "notify", "--source", TELEGRAM_SOURCE, "--severity", "attention",
                       "--text", text, "--key", key], 40)
        return result is not None and result.returncode == 0


# ---------------------------------------------------------------- the state machine (pure)

def fresh_state(now):
    return {"version": 1, "state": "home_up", "since": now, "good_streak": 0, "bad_streak": 0,
            "last_tick": None, "last_check": None, "last_ok": None, "last_ok_health": {}, "reason": "",
            "degraded": [], "fails": [], "mac_at_fail": {}, "client_failures": [], "failures_seen": 0,
            "outage": None, "degraded_alerts": {}, "last_verdict": "", "last_start": None}


def load_state(sdir, now):
    state = fresh_state(now)
    saved = read_json(Path(sdir) / "home-monitor.json", None)
    if isinstance(saved, dict) and saved.get("state") in ("home_up", "home_down"):
        state.update(saved)
    return state


def backend_view(state):
    """What the offbox client reads: backend-state.json."""
    down = state["state"] == "home_down"
    return {"state": state["state"], "since": state["since"], "good_streak": state["good_streak"],
            "bad_streak": state["bad_streak"], "last_check": state["last_check"], "last_ok": state["last_ok"],
            "reason": state["reason"] if down else "",
            "outage_id": (state.get("outage") or {}).get("id", "") if down else "",
            "degraded": list(state.get("degraded") or [])}


def failure_text(check):
    reasons = (check.get("health") or {}).get("reasons") or []
    if check["error"] == "not_ok":
        return clean("health ok=false" + (": " + "; ".join(reasons) if reasons else ""), 160)
    return clean(check["error"], 160)


def step(state, obs, now):
    """Fold one observation into `state`. No I/O. Returns (verdict, events).

    verdict: "good" | "bad" | "indeterminate". Only good and bad are decisive. A failed check is
    indeterminate when the Mac itself is not online or when this is the first tick after a gap; it then
    counts for nothing and clears both streaks, so "down" always needs DOWN_AFTER fresh failures in a row
    with the Mac online, and "up" always needs UP_AFTER fresh good checks in a row. A check that comes
    sooner than MIN_SPACING_S after the last one changes nothing: one blip seen twice is still one blip.
    """
    check, mac = obs["check"], obs["mac"]
    events = []
    last = state.get("last_tick")
    warmup = last is None or now - last > GAP_S
    state["last_tick"] = now
    if warmup:
        state["good_streak"] = state["bad_streak"] = 0

    fresh = [f for f in obs.get("client_failures") or [] if f["ts"] > (state.get("failures_seen") or 0)]
    if fresh:
        state["failures_seen"] = max(f["ts"] for f in fresh)
    state["client_failures"] = [f for f in (state.get("client_failures") or []) + fresh
                                if f["ts"] > now - 3600][-20:]

    started = state.get("last_start")
    if started is not None and 0 <= now - started < MIN_SPACING_S:
        return "indeterminate", ["skipped: too soon after the last check"]
    state["last_start"] = now

    if check["ok"]:
        verdict = "good"
        health = check.get("health") or {}
        state["good_streak"] += 1
        state["bad_streak"] = 0
        state["last_check"] = now
        state["degraded"] = list(health.get("reasons") or ["degraded"]) if health.get("mode") == "degraded" else []
        if state["state"] == "home_down" and state["good_streak"] >= UP_AFTER:
            outage = state.get("outage") or {}
            outage.update(recovered_at=now, up_health=health)
            state.update(state="home_up", since=now, reason="")
            events.append("up")
        if state["state"] == "home_up":
            state["fails"] = []
        state["last_ok"] = now
        state["last_ok_health"] = health
    elif warmup or not mac.get("online"):
        verdict = "indeterminate"
        state["good_streak"] = state["bad_streak"] = 0
        why = "warm-up after a gap" if warmup else \
            "mac offline (tailnet " + ("up" if mac.get("tailnet") else "down") + \
            ", internet " + ("up" if mac.get("internet") else "down") + ")"
        events.append("skipped: " + why)
    else:
        verdict = "bad"
        state["bad_streak"] += 1
        state["good_streak"] = 0
        state["last_check"] = now
        state["fails"] = ((state.get("fails") or []) + [{"ts": now, "error": check["error"],
                                                         "text": failure_text(check)}])[-12:]
        state["mac_at_fail"] = {k: mac.get(k) for k in ("tailnet", "internet", "tailnet_detail",
                                                        "internet_detail", "peer")}
        if state["state"] == "home_down":
            state["reason"] = failure_text(check)
        elif state["bad_streak"] >= DOWN_AFTER:
            state.update(state="home_down", since=now, reason=failure_text(check))
            previous = state.get("outage")
            if previous and now - max(previous.get("alerted_at") or previous["started"],
                                      previous.get("recovered_at") or 0) < COOLDOWN_S:
                # Flapping: the same outage, the same thread, no second Telegram.
                previous.update(down_count=previous["down_count"] + 1, last_down=now, recovered_at=None)
                outage = previous
            else:
                state["outage"] = {
                    "id": time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now)), "started": now, "last_down": now,
                    "down_count": 1, "recovered_at": None, "alerted_at": None,
                    "telegram": {"sent": False, "text": ""},
                    # A repair thread that is still open is reused; reconcile() checks that it is.
                    "thread_id": (previous or {}).get("thread_id"), "thread_seq": 0,
                    "told_down": 0, "told_up": 0}
                outage = state["outage"]
            # The last good check before the failures: the recovery message compares boot_id against it.
            outage.update(before_ok=state.get("last_ok"), before_health=state.get("last_ok_health") or {})
            events.append("down")
    state["last_verdict"] = verdict
    return verdict, events


# ---------------------------------------------------------------- messages

def stamp(ts):
    return dt.datetime.fromtimestamp(ts, DUBAI).strftime("%Y-%m-%d %H:%M:%S") if ts else "never"


def health_line(health):
    health = health or {}
    text = (f"boot_id {health.get('boot_id') or '?'}, uptime_s {health.get('uptime_s')}, "
            f"boatd_uptime_s {health.get('boatd_uptime_s')}, "
            f"version {health.get('version') or '?'}, mode {health.get('mode') or '?'}, "
            f"pool {health.get('pool') or '?'}, mdraid {health.get('mdraid') or '?'}")
    if health.get("reasons"):
        text += ", reasons: " + "; ".join(health["reasons"])
    return text


def evidence(state, url):
    mac = state.get("mac_at_fail") or {}
    fails = "; ".join(stamp(f["ts"])[11:] + " " + f["text"] for f in (state.get("fails") or [])[-8:])
    client = "; ".join(stamp(f["ts"])[11:] + " " + (f["reason"] or "?")
                       + (" (run " + f["run"] + ")" if f["run"] else "")
                       for f in (state.get("client_failures") or [])[-8:])
    last_ok = state.get("last_ok")
    return "\n".join([
        "What the monitor saw (times are Asia/Dubai):",
        f"- Health URL: {url}/health (no auth, {HEALTH_TIMEOUT_S} s timeout). Down = {DOWN_AFTER} failed checks "
        "in a row, one minute apart, with this Mac online.",
        f"- Failed checks: {fails or 'none recorded'}",
        "- Last good check: " + (f"{stamp(last_ok)} ({health_line(state.get('last_ok_health'))})"
                                 if last_ok else "none on record"),
        f"- This Mac at the last failed check: tailnet {'up' if mac.get('tailnet') else 'DOWN'} "
        f"({mac.get('tailnet_detail')}); internet {'reachable' if mac.get('internet') else 'NOT reachable'} "
        f"({mac.get('internet_detail')}); tailnet peer offbox-server: {mac.get('peer')}",
        f"- offbox runs that could not reach home in the last hour: {client or 'none reported'}",
    ])


RULES = "\n".join([
    "Rules in short (the runbook has them in full; they win over everything else):",
    "- Never WIPE-EVERYTHING. Never destroy a pool, dataset or snapshot: no `zpool destroy`, `zfs destroy`, "
    "`incus delete`, `incus snapshot delete`.",
    "- Never open, read or copy Moni's box data (owner `moni`), and never move her box or her work to Boat. "
    "Her tasks simply wait.",
    "- REINSTALL-OS only with Abdullah's explicit OK.",
    "- Do not touch Boat boxes or the Boat plan. offbox already sends runs to Boat by itself and returns to "
    f"home after {UP_AFTER} good checks: switch nothing by hand.",
    "- Message Abdullah only when hands are needed (Telegram, `telegram-notifications` skill), with one "
    "specific action.",
    "- Standard mode only, never fast mode, for you and anything you start.",
    "- Finish with a short cause-and-fix note appended to ~/.local/share/offbox/home-incidents.md, and the "
    "same in this thread.",
])


def down_text(state, url, new_thread):
    outage = state["outage"]
    again = outage["down_count"] > 1
    if new_thread:
        head = ("The home offbox server (tailnet host `offbox-server`) stopped answering its health check"
                + (" again" if again else "") + f". Outage id: {outage['id']}. Find out what is broken and "
                "get it fixed. You start with no context: work through the runbook in order.")
    elif again:
        head = (f"The home offbox server is down again (same outage {outage['id']}, time number "
                f"{outage['down_count']}). Continue the repair with the runbook.")
    else:
        head = (f"The home offbox server is down again: new outage {outage['id']}. This thread is reused "
                "because it is still open. Find out what is broken and get it fixed, runbook in order.")
    return "\n\n".join([PREFIX, head, "Runbook: " + RUNBOOK, evidence(state, url), RULES,
                        "The monitor writes here again when the box answers."])


def up_text(state):
    outage = state["outage"]
    now_health, before = outage.get("up_health") or {}, outage.get("before_health") or {}
    if not now_health.get("boot_id") or not before.get("boot_id"):
        restart = "No boot_id to compare; uptime_s says how long the box has been up."
    elif now_health["boot_id"] != before["boot_id"]:
        restart = "boot_id changed: the box restarted; uptime_s says how long ago."
    else:
        restart = ("boot_id is unchanged: the box did not restart. A small boatd_uptime_s means boatd itself "
                   "restarted; otherwise the path to the box was the problem.")
    return "\n\n".join([
        PREFIX,
        f"The home offbox server answers again ({UP_AFTER} good checks in a row). Outage {outage['id']}: "
        f"down {stamp(outage.get('last_down'))}, up {stamp(outage.get('recovered_at'))} (Asia/Dubai).",
        f"- Now: {health_line(now_health)}\n"
        f"- Last good check before the outage: {stamp(outage.get('before_ok'))} ({health_line(before)})\n"
        f"- {restart}",
        "offbox has gone back to the home server by itself. If you were in the middle of a fix, check that it "
        "is still needed. Then write up cause and fix: append the note to "
        "~/.local/share/offbox/home-incidents.md (date, outage id, what was seen, cause, fix, what to change "
        "so it does not recur) and report the same here. Runbook: " + RUNBOOK,
    ])


def thread_title(outage):
    return "offbox home server down (" + stamp(outage["started"])[:16] + " Dubai)"


def telegram_down_text(state, agent_started):
    outage = state["outage"]
    agent = ("A repair agent is on it (Robob thread \"" + thread_title(outage) + "\")." if agent_started else
             "The repair agent could not be started yet (Robob control API); the monitor retries every minute.")
    return (f"Home offbox is down since {stamp(outage['started'])[11:16]} Dubai ({state['reason'] or 'no answer'}). "
            f"Runs moved to Boat. {agent}")


def degraded_key(reasons):
    return hashlib.sha256("|".join(sorted(reasons)).encode()).hexdigest()[:12]


# ---------------------------------------------------------------- reconcile: do what the state still owes

def reconcile(state, url, effects, now, verdict, dry_run=False, note=lambda text: None):
    """Start/notify the repair agent and send Telegrams that the state still owes. Returns the actions.

    Everything owed stays owed until it succeeds, so a Robob or bridge restart only delays it.
    With dry_run nothing is called and nothing is marked done: the actions are what a real tick would do.
    """
    actions = []
    outage = state.get("outage")
    if outage and state["state"] == "home_down":
        if outage["told_down"] < outage["down_count"]:
            thread = outage.get("thread_id")
            if dry_run:
                actions.append({"action": "repair-thread", "would": "reuse if still open, else create" if thread
                                else "create", "thread": thread or "", "title": thread_title(outage),
                                "model": REPAIR_MODEL, "effort": REPAIR_EFFORT})
            else:
                is_open = effects.thread_open(thread) if thread else False
                if is_open is None:
                    actions.append({"action": "thread-check", "ok": False, "thread": thread})
                elif is_open:
                    ok = effects.thread_send(thread, down_text(state, url, False),
                                             f"offbox-home:{outage['id']}:down:{outage['down_count']}")
                    actions.append({"action": "thread-send-down", "ok": ok, "thread": thread})
                    if ok:
                        outage["told_down"] = outage["down_count"]
                else:
                    created = effects.create_thread(thread_title(outage), down_text(state, url, True),
                                                    f"offbox-home:{outage['id']}:thread:{outage['thread_seq'] + 1}")
                    actions.append({"action": "thread-create", "ok": bool(created), "thread": created or ""})
                    if created:
                        outage.update(thread_id=created, thread_seq=outage["thread_seq"] + 1,
                                      told_down=outage["down_count"])
        telegram = outage["telegram"]
        if not telegram["sent"]:
            key = "offbox-home:" + outage["id"]
            if dry_run:
                actions.append({"action": "telegram-down", "would": "send", "key": key,
                                "text": telegram["text"] or telegram_down_text(state, True)})
            else:
                # The bridge rejects a retry whose text changed: fix the text at the first try.
                if not telegram["text"]:
                    telegram["text"] = telegram_down_text(state, outage["told_down"] == outage["down_count"])
                ok = effects.telegram(telegram["text"], key)
                actions.append({"action": "telegram-down", "ok": ok, "key": key})
                if ok:
                    telegram["sent"] = True
                    outage["alerted_at"] = now
    elif outage and outage.get("recovered_at") and outage["told_up"] < outage["down_count"]:
        thread = outage.get("thread_id")
        if not thread or now - outage["recovered_at"] > RECOVERY_NOTICE_GIVE_UP_S:
            outage["told_up"] = outage["told_down"] = outage["down_count"]   # nobody to tell
        elif dry_run:
            actions.append({"action": "thread-send-up", "would": "send if still open", "thread": thread})
        else:
            is_open = effects.thread_open(thread)
            if is_open is None:
                actions.append({"action": "thread-check", "ok": False, "thread": thread})
            elif not is_open:
                outage["told_up"] = outage["told_down"] = outage["down_count"]
                actions.append({"action": "thread-send-up", "ok": False, "thread": thread, "why": "archived"})
            else:
                ok = effects.thread_send(thread, up_text(state),
                                         f"offbox-home:{outage['id']}:up:{outage['down_count']}")
                actions.append({"action": "thread-send-up", "ok": ok, "thread": thread})
                if ok:
                    outage["told_up"] = outage["told_down"] = outage["down_count"]

    alerts = state.setdefault("degraded_alerts", {})
    for key in [k for k, v in alerts.items() if now - v.get("at", 0) > 7 * 86400]:
        del alerts[key]
    reasons = state.get("degraded") or []
    if verdict == "good" and reasons:
        key = degraded_key(reasons)
        record = alerts.get(key)
        if record is None or now - record["at"] >= DEGRADED_REALERT_S:
            record = {"at": now, "sent": False,
                      "text": "Home offbox is up but degraded: " + "; ".join(reasons) + ". It still serves "
                              "runs. A failed disk needs hands (integrations/offbox/server/home/"
                              "FAILURE-MODES.md, \"Replacing a disk\")."}
            if not dry_run:
                alerts[key] = record
        if not record["sent"]:
            telegram_key = f"offbox-home-degraded:{key}:{int(record['at'])}"
            if dry_run:
                actions.append({"action": "telegram-degraded", "would": "send", "key": telegram_key,
                                "text": record["text"]})
            else:
                ok = effects.telegram(record["text"], telegram_key)
                actions.append({"action": "telegram-degraded", "ok": ok, "key": telegram_key})
                record["sent"] = ok
    for action in actions:
        if "ok" in action:
            note(f"action={action['action']} ok={action['ok']}"
                 + (f" thread={clean(action['thread'], 160)}" if action.get("thread") else "")
                 + (f" key={action['key']}" if action.get("key") else ""))
    return actions


# ---------------------------------------------------------------- one tick

def tick(sdir=None, dry_run=False, clock=time.time, check=check_health, mac=mac_online, effects=None):
    sdir = Path(sdir) if sdir is not None else state_dir()
    url = configured_url(sdir)
    if url is None:
        # Installed before the box exists: no network, no files, nothing.
        return {"configured": False}
    with (sdir / "home-monitor.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"configured": True, "skipped": "another tick holds the lock"}
        now = clock()
        state = load_state(sdir, now)
        before = state["state"]
        result = check(url)
        facts = mac(url)
        failures = read_client_failures(sdir, state.get("failures_seen") or now - 900)
        quiet = state.get("last_verdict") == "good" and before == "home_up"
        verdict, events = step(state, {"check": result, "mac": facts, "client_failures": failures}, now)
        if verdict != "indeterminate":
            write_json(sdir / "backend-state.json", backend_view(state))
        write_json(sdir / "home-monitor.json", state)
        outage_id = (state.get("outage") or {}).get("id", "")
        skipped = "".join(" " + e.replace(" ", "_") for e in events if e.startswith("skipped"))
        if not result["ok"]:
            log(sdir, f"check-fail class={result['error']} verdict={verdict} bad_streak={state['bad_streak']}"
                      + skipped)
        elif verdict == "indeterminate":
            log(sdir, "check-good verdict=indeterminate" + skipped)
        elif not quiet or events:
            log(sdir, f"check-good good_streak={state['good_streak']} state={state['state']}"
                      + (" degraded" if state["degraded"] else ""))
        for event in events:
            if event in ("down", "up"):
                log(sdir, f"state={state['state']} outage={outage_id} "
                          f"down_count={(state.get('outage') or {}).get('down_count', 0)}")
        actions = reconcile(state, url, effects or Effects(), clock(), verdict, dry_run,
                            lambda text: log(sdir, text + (" outage=" + outage_id if outage_id else "")))
        # The end of the tick, not its start: a slow send must not look like a gap to the next tick.
        state["last_tick"] = max(now, clock())
        write_json(sdir / "home-monitor.json", state)
        return {"configured": True, "dry_run": dry_run, "verdict": verdict, "events": events,
                "check": {"ok": result["ok"], "error": result["error"]},
                "mac": {k: facts.get(k) for k in ("online", "tailnet", "internet")},
                "state": state["state"], "good_streak": state["good_streak"], "bad_streak": state["bad_streak"],
                "outage_id": outage_id if state["state"] == "home_down" else "", "degraded": state["degraded"],
                "actions": actions}


def status(sdir=None):
    sdir = Path(sdir) if sdir is not None else state_dir()
    url = configured_url(sdir)
    state = read_json(sdir / "home-monitor.json", {})
    outage = state.get("outage") or {}
    return {"configured": url is not None, "url": url or "",
            "backend_state": read_json(sdir / "backend-state.json", None),
            "last_tick": stamp(state.get("last_tick")), "last_ok": stamp(state.get("last_ok")),
            "last_ok_health": state.get("last_ok_health") or {}, "recent_fails": (state.get("fails") or [])[-5:],
            "outage": {k: outage.get(k) for k in ("id", "started", "down_count", "recovered_at", "alerted_at",
                                                  "thread_id", "told_down", "told_up")} if outage else None,
            "thresholds": {"down_after": DOWN_AFTER, "up_after": UP_AFTER, "cooldown_s": COOLDOWN_S,
                           "gap_s": GAP_S}, "repair_model": REPAIR_MODEL, "repair_effort": REPAIR_EFFORT}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["tick", "status"])
    parser.add_argument("--dry-run", action="store_true",
                        help="check and record state, but start no thread, send no message, no Telegram")
    args = parser.parse_args()
    if args.command == "status":
        print(json.dumps(status(), indent=2, sort_keys=True))
        return
    dry_run = args.dry_run or os.environ.get("OFFBOX_HOME_MONITOR_DRY_RUN") == "1"
    try:
        summary = tick(dry_run=dry_run)
    except Exception as error:  # noqa: BLE001
        # Never print exception bodies: an HTTP error may carry a secret.
        sdir = state_dir()
        if configured_url(sdir) is not None:
            log(sdir, "tick-error type=" + type(error).__name__)
        print("offbox home monitor: tick failed: " + type(error).__name__, file=sys.stderr)
        raise SystemExit(1) from None
    if dry_run or sys.stdout.isatty() or "skipped" in summary:
        print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    main()
