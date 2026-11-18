#!/Users/ardud/.local/android/venv/bin/python
"""ph: drive Abdullah's local Nothing (3a) Lite over ADB/uiautomator2. Run `ph help`."""
import sys, os, re, time, subprocess, xml.etree.ElementTree as ET
import argparse, base64, collections, datetime, json, signal, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
# phonelock's lazy imports must share this CLI's event context.
if __name__ == '__main__': sys.modules['ph'] = sys.modules[__name__]
import phonelock
SERIAL = os.environ.get("PH_SERIAL", "002473611000997")
TMP = os.environ.get("PH_TMP", "/private/var/folders/vt/8qndzr_j44z70bh0rn2zyfkm0000gn/T/opencode/phone")
os.makedirs(TMP, exist_ok=True)
_d = None
_action_sent = False
_context = {}
_private_values = ()
STATE = Path.home() / ".local/state/ph"

def single_send_device(u):
    # u2 also retries HTTP RPCs and falls back to another text input method internally.
    # Disable those replays here; ph captures evidence before any server restart.
    class SingleSendDevice(u.Device):
        def jsonrpc_call(self, method, params=None, timeout=10):
            from uiautomator2.core import _jsonrpc_call
            return _jsonrpc_call(self._dev, self._device_server_port, method, params, timeout, False)

        def _must_broadcast(self, action, extras=None):
            from uiautomator2.exceptions import AdbBroadcastError
            result = self._broadcast(action, extras or {})
            if result.code != -1:
                raise AdbBroadcastError("input broadcast reply did not confirm success")

        def send_keys(self, text, clear=False):
            if self.is_input_ime_installed():
                self.set_input_ime()
                if clear: self._must_broadcast("ADB_KEYBOARD_CLEAR_TEXT")
                self._must_broadcast("ADB_KEYBOARD_INPUT_TEXT", {
                    "text": base64.b64encode(text.encode()).decode()})
                self._must_broadcast("ADB_KEYBOARD_HIDE")
            else:
                if clear: u._Device.clear_text(self)
                u._Device.send_keys(self, text)
    return SingleSendDevice(SERIAL)

def action(call, *args, **kwargs):
    global _action_sent
    try: state = phonelock.status()
    except (phonelock.Busy, OSError, UnicodeError):
        state = dict(lease_owner="none", lease_state="foreign", hold_present=phonelock.hold_state()[0])
    guard_phone(True)
    first = not _action_sent
    _action_sent = True
    try:
        return call(*args, **kwargs)
    finally:
        if first:
            lock_event("action", state=state)
            if state["lease_state"] == "none" and not state["hold_present"]:
                lock_event("unleased_action", state=state)

def d():
    global _d
    guard_phone(False)
    if _d is None:
        import uiautomator2 as u; _d = single_send_device(u)
    return _d
def adb(*a):
    guard_phone(False)
    return subprocess.run(["adb", "-s", SERIAL, *a], capture_output=True, text=True, check=True).stdout
def _run(args, t=5, strict=False, *, device_action=False):
    if args and args[0] == "adb":
        guard_phone(device_action or (len(args) > 1 and args[1] in ("kill-server", "start-server")))
    try: return subprocess.run(args, capture_output=True, text=True, timeout=t, check=strict).stdout
    except TimeoutError: raise
    except Exception:
        if strict: raise
        return ""
def doctor(as_json):
    import json
    st, detail, ask, code = "", "", None, 3
    devs = _run(["adb", "devices", "-l"])
    state = {p[0]: p[1] for p in (l.split() for l in devs.splitlines()[1:]) if len(p) > 1}
    if state.get(SERIAL) == "offline":
        guard_phone(True)
        _run(["adb", "kill-server"])
        time.sleep(1)
        guard_phone(True)
        _run(["adb", "start-server"], t=15)
        devs = _run(["adb", "devices", "-l"])
        state = {p[0]: p[1] for p in (l.split() for l in devs.splitlines()[1:]) if len(p) > 1}
    s = state.get(SERIAL)
    if s == "device":
        echo = _run(["adb", "-s", SERIAL, "shell", "echo ok"]).strip()
        pw = (_run(["adb", "-s", SERIAL, "shell", "dumpsys power | grep -m1 mWakefulness"]).strip().splitlines() or [""])[0]
        if echo == "ok":
            st, detail, code = "ok", f"adb reachable; {pw or 'screen state unknown'}", 0
            if not re.search(r"\bmWakefulness=Awake\b", pw):
                detail += "; phone not awake; run ph wake"
        else:
            st, detail, ask = "offline", "adb lists the phone but its shell did not answer", None
    elif s == "unauthorized":
        st, detail = "unauthorized", "Phone asks to allow USB debugging."
        ask = "Phone asks to allow USB debugging. Ask Abdullah to tap Allow on the phone."
    elif s == "offline":
        st, detail = "offline", "adb still reports the phone as offline after restarting the server."
        ask = "Run: adb kill-server && adb start-server, then retry."
    else:
        usb = _run(["ioreg", "-p", "IOUSB", "-l", "-w0"], t=5)
        if re.search(r'"USB Vendor Name" = "Nothing"', usb) or re.search(r'"USB Product Name" = "A001T"', usb):
            st, detail = "usb_mode", "Phone is on USB but adb cannot see it under this serial."
            ask = ("Phone is plugged in but not in a debugging USB mode (it was in MIDI on 21 Oct). "
                   "Ask Abdullah: pull down the notification shade, tap the USB notification, pick File transfer. "
                   "If that is already set, toggle USB debugging off and on in Developer options.")
        else:
            st, detail = "not_connected", "Phone is not plugged into the Mac (or the cable is charge-only)."
            ask = "Phone is not plugged into the Mac (or the cable is charge-only)."
    if as_json:
        print(json.dumps({"status": st, "serial": SERIAL, "detail": detail, "ask_owner": ask}))
    else:
        print(f"{st}: {detail}")
        if ask: print(f"ask: {ask}")
    sys.exit(code)
def wake(timeout=6.0):
    deadline = time.monotonic() + timeout
    retry_at = deadline - timeout / 2
    state = {"wakefulness": None, "keyguard": "unknown", "actions": []}
    def run(*args, strict=False):
        remaining = deadline - time.monotonic()
        if remaining <= 0: return ""
        # Bound each adb call as well as polling; the outer step alarm defaults to 45s.
        return _run(["adb", "-s", SERIAL, *args], t=min(1.0, remaining), strict=strict)
    def act(name, *args):
        if time.monotonic() < deadline:
            state["actions"].append(name)
            action(run, *args, strict=True)
    def power():
        match = re.search(r"\bmWakefulness=(\w+)", run("shell", "dumpsys power | grep -m1 mWakefulness"))
        return match.group(1) if match else None
    def wake_key():
        act("KEYCODE_WAKEUP", "shell", "input", "keyevent", "KEYCODE_WAKEUP")
    def dismiss():
        act("dismiss-keyguard", "shell", "wm", "dismiss-keyguard")

    state["wakefulness"] = power()
    # ADB wakes Dozing directly; u2's screen_on() treats AOD as already on.
    if state["wakefulness"] != "Awake": wake_key()
    dismiss()
    retried = False
    while time.monotonic() < deadline:
        state["wakefulness"] = power()
        match = re.search(r"\bisKeyguardShowing=(true|false)\b", run("shell", "dumpsys window"))
        # Missing keyguard data cannot prove the app is accessible.
        state["keyguard"] = {"true": "showing", "false": "hidden"}.get(match.group(1) if match else None, "unknown")
        if state["wakefulness"] == "Awake" and state["keyguard"] == "hidden":
            return True, state
        if not retried and time.monotonic() >= retry_at and state["wakefulness"] != "Awake":
            wake_key()
            dismiss()
            retried = True
        remaining = deadline - time.monotonic()
        if remaining > 0: time.sleep(min(0.3, remaining))
    return False, state
def nodes():
    root = ET.fromstring(d().dump_hierarchy(compressed=False))
    out = []
    for n in root.iter("node"):
        a = n.attrib; t = a.get("text", "").strip(); c = a.get("content-desc", "").strip()
        rid = a.get("resource-id", "").split("/")[-1]
        m = re.findall(r"\d+", a.get("bounds", ""));
        if len(m) != 4: continue
        x1, y1, x2, y2 = map(int, m)
        if x2 <= x1 or y2 <= y1: continue
        clk = a.get("clickable") == "true" or a.get("long-clickable") == "true"
        edit = "EditText" in a.get("class", "")
        if not (t or c or edit or (clk and rid)): continue
        out.append(dict(t=t, c=c, rid=rid, x=(x1+x2)//2, y=(y1+y2)//2, b=(x1,y1,x2,y2), clk=clk, edit=edit,
                        chk=a.get("checked") == "true", sel=a.get("selected") == "true", pkg=a.get("package","")))
    return out
# Masks card numbers, CVC/CVV and expiry before screen text reaches an agent.
# Mirrors dia-agent-bridge/src/redact.js: keep the two rule sets in step.
_CARD_RUN = re.compile(r"(?<![0-9])[0-9](?:[ -]*[0-9]){12,18}(?![0-9])")
# Between a label and its value: up to three words, each side padded by up to six punctuation or
# whitespace characters (':', '=', '-', quotes, brackets, commas, newlines). Covers 'CVC for card is 123',
# JSON '"cvc":"123"' and 'CVV (123)'. Bounded, so unrelated text after the label is not reached.
_GAP = r"((?:[\s:=\-\"'()\[\]{},]{0,6}(?:[A-Za-z]{1,20}[\s:=\-\"'()\[\]{},]{0,6}){0,3}))"
_CVC_LABEL = re.compile(r"(\b(?:cvc|cvv|csc|cvn|security\s*code)\b)" + _GAP + r"([0-9]{3,4})(?![0-9])", re.I | re.A)
_EXP_LABEL = re.compile(r"(\b(?:exp|expiry|expires?|expiration|valid\s*thru|valid\s*through|mm\s*/\s*yy(?:yy)?)\b)" + _GAP + r"([0-9]{1,2}\s*[/-]\s*(?:[0-9]{4}|[0-9]{2}))(?![0-9])", re.I | re.A)
# A field whose name/id/label says it is a CVC or expiry; its node value is the secret.
_SENSITIVE_FIELD = re.compile(r"(?<![a-z])(cvc|cvv|csc|cvn|security[\s_-]*code|card[\s_-]*number|cardnumber|cc[-_]?number|cc[-_]?csc|cc[-_]?exp|expir\w*|valid[\s_-]*thru|exp|mm\s*/\s*yy(?:yy)?)(?![a-z])", re.I)
def _luhn(digits):
    total, double = 0, False
    for ch in reversed(digits):
        n = ord(ch) - 48
        if double:
            n *= 2
            if n > 9: n -= 9
        total += n; double = not double
    return total % 10 == 0
def _card(m):
    digits = re.sub(r"[ -]", "", m.group(0))
    return f"•••• {digits[-4:]}" if 13 <= len(digits) <= 19 and _luhn(digits) else m.group(0)
def redact_text(text):
    if not text: return text
    text = _CARD_RUN.sub(_card, text)
    text = _CVC_LABEL.sub(lambda m: m.group(1) + m.group(2) + "•••", text)
    return _EXP_LABEL.sub(lambda m: m.group(1) + m.group(2) + "••/••", text)
def is_sensitive_field(*names):
    return any(n and _SENSITIVE_FIELD.search(n) for n in names)
def field_ctx(n):
    """Everything that can name a field for one node: resource-id, text and content-desc."""
    return " ".join(x for x in (n.get("rid", ""), n.get("t", ""), n.get("c", "")) if x)
def redact(text, field=""):
    """Redact screen text. If the field context (node label, content-desc or resource-id) names a
    CVC or expiry field and the text is a bare value ('123', '12/29'), mask it: a bare value has
    no label of its own, so the node's context is the only way to know it is a secret."""
    if field and is_sensitive_field(field) and text:
        if re.fullmatch(r"\s*[0-9][0-9/ -]{0,6}\s*", text): return "••/••" if re.search(r"[/-]", text) else "•••"
    return redact_text(text)
def diagnostic(text):
    text = str(text)
    # A fragment replacement can corrupt delimiters in nested or truncated payloads.
    # Keep structured context in event fields; never persist quoted free-form data.
    if "'" in text or '"' in text: return "[redacted payload]"
    private = set()
    for value in _private_values:
        if value:
            private.update((value, repr(value)[1:-1], ascii(value)[1:-1],
                            json.dumps(value)[1:-1], json.dumps(value, ensure_ascii=False)[1:-1]))
    for value in sorted(private, key=len, reverse=True):
        text = text.replace(value, "[redacted]")
    text = re.sub(r"(?i)\b(text|password|token|secret|clipboard|params|extras|args)\s*[:=].*",
                  r"\1=[redacted]", text)
    return redact_text(text)

def token(value, fallback="unknown"):
    return value if re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:-]{0,63}", value) else fallback

def component(value):
    return value if re.fullmatch(r"(?:android|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)/\.?[A-Za-z_$][\w.$]*", value, re.A) else None

def maintain_logs():
    try:
        STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
        events = STATE / "events.jsonl"
        if events.exists() and events.stat().st_size > 5 * 1024 * 1024:
            events.replace(STATE / "events.jsonl.1")
        drops = STATE / "drops"
        if drops.exists():
            files = sorted(drops.glob("*.log"), key=lambda f: f.stat().st_mtime_ns)
            for old in files[:-200]: old.unlink()
    except Exception: pass

def event(kind, exc=None, *, source="ph", cmd=None, phase=None, message=None, device=True, **fields):
    # Diagnostics must not change a command result, even on a missing phone or full disk.
    try:
        now = datetime.datetime.now(datetime.timezone.utc)
        row = dict(ts=now.isoformat(), event=kind, source=token(source),
                   cmd=token(cmd or _context.get("cmd", "unknown")),
                   target_kind=_context.get("target_kind", "selector"),
                   phase=phase or ("action" if _action_sent else "read"),
                   exc_type=token(type(exc).__name__) if exc else None,
                   exc_message=diagnostic(message if message is not None else str(exc) if exc else "")[:200],
                   attempt=_context.get("attempt", 1),
                   elapsed_ms=round((time.monotonic() - _context.get("started", time.monotonic())) * 1000),
                   serial=SERIAL, ime=None, focused_window=None, drop_log=None)
        row.update(fields)
        if device and not phonelock.check(action=False)[1]:
            row["ime"] = component(_run(["adb", "-s", SERIAL, "shell", "settings", "get", "secure", "default_input_method"], t=3).strip())
            focus = _run(["adb", "-s", SERIAL, "shell", "dumpsys window | grep mCurrentFocus"], t=3)
            match = re.search(r"mCurrentFocus=.*?\bu\d+\s+([^\s}]+)", focus)
            row["focused_window"] = component(match.group(1)) if match else None
            if kind in ("reconnect", "maybe_sent", "failed", "external_drop"):
                raw = _run(["adb", "-s", SERIAL, "logcat", "-d", "-t", "300"], t=5)
                lines = [diagnostic(line) for line in raw.splitlines() if re.search(
                    r"uiautomator|uia2|wetest|AndroidRuntime|lowmemorykiller|ActivityManager: Killing|InputMethod|ImeTracker|BiometricPrompt|FATAL", line, re.I)][-80:]
                try:
                    drops = STATE / "drops"
                    drops.mkdir(parents=True, exist_ok=True, mode=0o700)
                    path = drops / (now.strftime("%Y%m%dT%H%M%S.%fZ") + "-" + row["cmd"] + ".log")
                    with path.open("x", encoding="utf-8") as out: out.write("\n".join(lines) + ("\n" if lines else ""))
                    row["drop_log"] = str(path)
                except Exception: pass
        STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(STATE / "events.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as out: out.write(json.dumps(row) + "\n")
        maintain_logs()
    except Exception: pass

def note_drop(args):
    parser = argparse.ArgumentParser(prog="ph note-drop")
    for name in ("source", "cmd", "exc"): parser.add_argument("--" + name, required=True)
    parser.add_argument("--msg", default="")
    parser.add_argument("--phase", choices=("read", "action"), default="read")
    opts = parser.parse_args(args)
    event("external_drop", source=opts.source, cmd=opts.cmd, phase=opts.phase,
          message=opts.msg, exc=type(token(opts.exc), (Exception,), {})(opts.msg))

def show_log(n=20):
    recent = collections.deque(maxlen=max(0, n))
    types, sources, leases, reasons = (collections.Counter() for _ in range(4))
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)
    for path in (STATE / "events.jsonl.1", STATE / "events.jsonl"):
        try:
            with path.open(encoding="utf-8") as inp:
                for line in inp:
                    try:
                        row = json.loads(line)
                        ts = datetime.datetime.fromisoformat(row["ts"])
                        if ts.tzinfo is None: continue
                        recent.append(row)
                        if ts >= cutoff:
                            types[token(row["event"])] += 1
                            sources[token(row["source"])] += 1
                            if "lease_state" in row: leases[token(row["lease_state"])] += 1
                            if row["event"] == "busy_refused": reasons[token(row.get("reason", "unknown"))] += 1
                    except (ValueError, TypeError, KeyError): continue
        except OSError: pass
    for row in recent:
        claim = ""
        if "lease_state" in row:
            chain = row.get("caller_chain", [])
            names = ">".join(str(c.get("comm", "?")) for c in chain)
            project = next((str(c["cwd_tail"]) for c in chain if c.get("cwd_tail")), "?")
            claim = f" lease={row.get('lease_state')} reason={row.get('reason', '-')} caller={names} project={project}"
        print(diagnostic(f"{row['ts']} {row['event']} {row['source']} {row.get('cmd', '?')} "
                         f"{row.get('phase', '?')} {row.get('exc_type') or '-'} "
                         f"ime={row.get('ime')} focus={row.get('focused_window')} drop={row.get('drop_log')}{claim}"))
    print("Last 7 days by event: " + (", ".join(f"{k}={v}" for k, v in sorted(types.items())) or "none"))
    print("Last 7 days by source: " + (", ".join(f"{k}={v}" for k, v in sorted(sources.items())) or "none"))

    print("Last 7 days by lease_state: " + (", ".join(f"{k}={v}" for k, v in sorted(leases.items())) or "none"))
    print("Last 7 days busy_refused by reason: " + (", ".join(f"{k}={v}" for k, v in sorted(reasons.items())) or "none"))

NOISE = re.compile(r"notification:|signal|Battery|clock|key_pos|Location requests active", re.I)
def show(allnodes=False):
    ns = nodes()
    pks = [n["pkg"] for n in ns if n["pkg"] and n["pkg"] != "com.android.systemui"]
    pk = max(set(pks), key=pks.count) if pks else "?"   # app_current() RPC takes ~5 s; derive from the tree instead
    print(f"== app={pk} at={time.strftime('%Hh%Mm%Ss')}")
    for i, n in enumerate(ns):
        ctx = field_ctx(n); lab = redact(n["t"] or n["c"], ctx); extra = []
        if not allnodes and (n["pkg"] == "com.android.systemui" or NOISE.search(lab) or NOISE.search(n["rid"])): continue
        if n["c"] and n["t"] and n["c"] != n["t"]: extra.append(f"desc={redact(n['c'], ctx)[:40]}")
        if n["rid"]: extra.append(f"id={n['rid']}")
        flags = ("E" if n["edit"] else "") + ("C" if n["clk"] else "") + ("✓" if n["chk"] or n["sel"] else "")
        print(f"[{i}] {lab[:70]!r} ({n['x']},{n['y']}) {flags} {' '.join(extra)}")
def find(q, idx=0):
    ns = nodes(); ql = q.lower()
    if q.startswith("id="):
        hits = [n for n in ns if n["rid"] == q[3:]]
    else:
        hits = [n for n in ns if (n["t"] or "").lower() == ql or (n["c"] or "").lower() == ql]
        if not hits: hits = [n for n in ns if ql in (n["t"] or "").lower() or ql in (n["c"] or "").lower()]
    if len(hits) <= idx: return None
    return hits[idx]
def main(a):
    if not a or a[0] in ("help", "-h"): print(__doc__ + """
ui [-a]                    list on-screen elements (status bar hidden; -a shows all): [i] 'label' (x,y) flags(E=edit C=clickable ✓=checked/selected) id=
tap X Y | tap "text" [n]   tap coords, or the n-th element whose text/desc matches (exact first, then substring); tap id=RID
wait "text" [secs]         wait until text appears (default 15s); exits 1 on timeout
type "text" [--clear]      type into focused field (unicode ok); --clear clears first
key back|home|enter|recent|search|del
swipe up|down|left|right   scroll page (up = content moves up = scroll down)
open PKG | stop PKG        launch / force-stop app
url URI [PKG]              open deep link (market://, https://, app scheme), optional target package
shot [name]                screenshot -> $PH_TMP/name-<ts>.png (unique path; downscaled 540w copy printed too)
cur                        current package/activity
doctor [--json]            why the phone is unreachable (adb/USB state, read-only, <=5s steps); exit 0 ok, 3 otherwise
wake                       wake + unlock (no PIN) screen
sms [n]                    last n (default 4) incoming SMS/iMessages on the Mac (OTP codes land here)
sh CMD...                  raw adb shell (treated as an action; never auto-repeated)
log [n]                    last n events (default 20), counts by event/source over 7 days
note-drop --source NAME --cmd VERB --exc TYPE [--msg TEXT] [--phase read|action]
                           log a direct-u2 drop without connecting or resetting u2
hold acquire --token T | hold refresh|release | hold status [--json]
lease acquire|run --owner T --purpose P [--ttl 20m] [-- CMD...]
lease refresh|release --owner T | lease status [--json]
Exit codes: 0 success, 1 not found/timeout, 2 usage, 3 failed twice, 4 MAYBE_SENT (check ph ui before repeating), 5 PHONE_BUSY (yield)
"""); return
    c = a[0]
    if c == "ui": show("-a" in a)
    elif c == "tap":
        if len(a) >= 3 and a[1].isdigit() and a[2].isdigit(): action(d().click, int(a[1]), int(a[2])); print("tapped", a[1], a[2])
        else:
            n = find(a[1], int(a[2]) if len(a) > 2 else 0)
            if not n: event("not_found"); print("NOT FOUND:", redact(a[1])); sys.exit(1)
            action(d().click, n["x"], n["y"]); print("tapped", repr(redact(n["t"] or n["c"], field_ctx(n))), n["x"], n["y"])
    elif c == "wait":
        end = time.time() + (float(a[2]) if len(a) > 2 else 15)
        while time.time() < end:
            hit = find(a[1])
            if hit: print("found", redact(a[1], field_ctx(hit))); return
            time.sleep(0.4)
        event("timeout"); print("TIMEOUT", redact(a[1])); sys.exit(1)
    elif c == "type":
        dv = d(); clear = "--clear" in a; txt = [x for x in a[1:] if x != "--clear"][0]
        action(dv.send_keys, txt, clear=clear); print("typed", len(txt), "chars")
    elif c == "key": action(d().press, a[1]); print("key", a[1])
    elif c == "swipe": action(d().swipe_ext, a[1], scale=0.7); print("swiped", a[1])
    elif c == "open": action(d().app_start, a[1]); print("opened", a[1])
    elif c == "stop": action(d().app_stop, a[1]); print("stopped", a[1])
    elif c == "url":
        cmd = ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", a[1]] + (["-p", a[2]] if len(a) > 2 else [])
        print(action(adb, *cmd).strip())
    elif c == "shot":
        f = f"{TMP}/{a[1] if len(a)>1 else 's'}-{time.strftime('%Y%m%d-%H%M%S')}.png"
        with open(f, "wb") as fh: fh.write(subprocess.run(["adb", "-s", SERIAL, "exec-out", "screencap", "-p"], capture_output=True).stdout)
        from PIL import Image
        img = Image.open(f); s = f[:-4] + "-s.png"
        img.resize((540, int(540 * img.height / img.width))).save(s); print(f); print(s)
    elif c == "cur":
        # adbutils.app_current() retries internally; keep recovery in ph's outer loop.
        out = adb("shell", "dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity'").strip()
        if not out: raise RuntimeError("current activity not reported")
        print(out)
    elif c == "wake":
        ok, state = wake()
        if "--json" in a:
            import json
            print(json.dumps({"ok": ok, **state}))
        elif ok: print("awake")
        elif state["wakefulness"] == "Awake" and state["keyguard"] == "showing":
            print("locked: wakefulness=Awake keyguard=showing after dismiss (secure lock?)")
        else:
            print(f"not awake: wakefulness={state['wakefulness'] or 'unknown'} keyguard={state['keyguard']}")
        if not ok: sys.exit(1)
    elif c == "sms":
        q = ("select datetime(date/1000000000+978307200,'unixepoch','localtime'), text from message "
             f"where is_from_me=0 and text is not null and text != '' order by date desc limit {int(a[1]) if len(a)>1 else 4}")
        print(subprocess.run(["sqlite3", os.path.expanduser("~/Library/Messages/chat.db"), q], capture_output=True, text=True).stdout, end="")
    elif c == "sh": print(action(adb, "shell", *a[1:]), end="")
    elif c == "log": show_log(int(a[1]) if len(a) > 1 else 20)
    elif c == "note-drop": note_drop(a[1:])
    elif c == "doctor": doctor("--json" in a)
    else: print("unknown; ph help"); sys.exit(2)
ACTIONS = {"tap", "type", "key", "swipe", "open", "stop", "url", "sh", "wake"}

class PhoneBusy(Exception):
    pass


def process_comm(pid):
    # macOS ps comm is argv[0], which a caller can rewrite to contain input.
    # The kernel's executable path supplies a name without trusting that string.
    try:
        if sys.platform == "darwin":
            import ctypes
            lib = ctypes.CDLL("/usr/lib/libproc.dylib")
            buf = ctypes.create_string_buffer(4096)
            if lib.proc_pidpath(pid, buf, len(buf)) <= 0: return "unknown"
            path = buf.value.decode()
        else:
            path = os.readlink(f"/proc/{pid}/exe")
        name = Path(path).name
        return name if re.fullmatch(r"[A-Za-z0-9_.+-]{1,80}", name) else "unknown"
    except Exception:
        return "unknown"


def caller_chain():
    chain, pid = [], os.getppid()
    for _ in range(6):
        if pid <= 0 or any(row["pid"] == pid for row in chain): break
        try:
            result = subprocess.run(["ps", "-o", "ppid=,comm=", "-p", str(pid)],
                                    capture_output=True, text=True, timeout=1, check=True)
            parent, comm = result.stdout.strip().split(None, 1)
            chain.append(dict(pid=pid, comm=process_comm(pid), cwd_tail=None))
            pid = int(parent)
        except Exception: break
    if chain:
        try:
            result = subprocess.run(["lsof", "-a", "-d", "cwd", "-p", str(chain[0]["pid"]), "-Fn"],
                                    capture_output=True, text=True, timeout=1, check=True)
            path = next(line[1:] for line in result.stdout.splitlines() if line.startswith("n/"))
            chain[0]["cwd_tail"] = "/".join(Path(path).parts[-2:])
        except Exception: pass
    return chain


def lock_event(kind, reason=None, state=None):
    try:
        state = state or phonelock.status()
        fields = {k: state[k] for k in ("lease_owner", "lease_state", "hold_present")}
    except Exception:
        fields = dict(lease_owner="none", lease_state="foreign", hold_present=phonelock.hold_state()[0])
    if reason: fields["reason"] = "hold" if reason == phonelock.HOLD_REASON or reason == phonelock.HOLD_LOST_REASON or reason.startswith("hold ") else "lease"
    event(kind, device=False, caller_chain=caller_chain(), **fields)


def refuse(reason, prefix=""):
    lock_event("busy_refused", reason)
    print("PHONE_BUSY: " + prefix + reason)


def guard_phone(action):
    ok, reason = phonelock.check(action=action)
    if not ok:
        refuse(reason)
        raise PhoneBusy()


class HoldParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse otherwise echoes arbitrary arguments, including the hold token.
        raise ValueError('invalid hold request')


def hold_cli(args):
    parser = HoldParser(prog="ph hold")
    subs = parser.add_subparsers(dest="command", required=True)
    for name in ("acquire", "refresh", "release", "status"):
        sub = subs.add_parser(name)
        if name == "acquire": sub.add_argument("--token", required=True)
        if name == "status": sub.add_argument("--json", action="store_true")
    try:
        opts = parser.parse_args(args)
        if opts.command == "acquire": phonelock.hold_acquire(opts.token)
        elif opts.command == "refresh": phonelock.hold_refresh()
        elif opts.command == "release": phonelock.hold_release()
        else:
            state = phonelock.hold_status()
            state.pop("own_hold")
            state.pop("lost_hold", None)
            print(json.dumps(state) if opts.json else " ".join(f"{k}={v}" for k, v in state.items()))
        return 0
    except phonelock.Busy as exc:
        refuse(str(exc))
        return 5
    except (ValueError, OSError, UnicodeError):
        print("hold: invalid request or unavailable metadata")
        return 2
    except SystemExit as exc:
        return exc.code


def lease_cli(args):
    parser = argparse.ArgumentParser(prog="ph lease")
    subs = parser.add_subparsers(dest="command", required=True)
    for name in ("acquire", "refresh", "release", "run", "status"):
        sub = subs.add_parser(name)
        if name == "status":
            sub.add_argument("--json", action="store_true")
        else:
            sub.add_argument("--owner", required=True)
            if name in ("acquire", "run"):
                sub.add_argument("--purpose", required=True)
                sub.add_argument("--ttl", default="20m")
    # Parse child argv separately: it must never appear in an argparse error.
    head, child_args = args, []
    if "--" in args:
        at = args.index("--")
        head, child_args = args[:at], args[at+1:]
    try:
        opts = parser.parse_args(head)
        if opts.command == "status":
            state = phonelock.status()
            state.pop("own_hold")
            state.pop("lost_hold", None)
            print(json.dumps(state) if opts.json else
                  f"hold_present={state['hold_present']} lease={state['lease']} seconds_left={state['seconds_left']:.0f}")
        elif opts.command == "release":
            phonelock.hold_state()
            phonelock.release(opts.owner)
        elif opts.command == "refresh": phonelock.refresh(opts.owner)
        elif opts.command == "acquire": phonelock.acquire(opts.owner, opts.purpose, opts.ttl)
        else:
            if not child_args: raise ValueError("lease run requires -- CMD...")
            ttl = phonelock.ttl_seconds(opts.ttl)
            return lease_run(opts.owner, opts.purpose, ttl, child_args)
        return 0
    except phonelock.Busy as exc:
        refuse(str(exc))
        return 5
    except (ValueError, OSError):
        print("lease: invalid request or unavailable metadata")
        return 2
    except SystemExit as exc:
        return exc.code


def group_running(child):
    child.poll()  # Reap our leader; an exited leader does not imply an empty group.
    try: os.killpg(child.pid, 0)
    except ProcessLookupError: return False
    try:
        result = subprocess.run(['ps', '-axo', 'pgid=,stat='], capture_output=True,
                                text=True, check=True, timeout=1)
        states = [parts[1] for line in result.stdout.splitlines()
                  if len(parts := line.split()) == 2 and parts[0] == str(child.pid)]
        # Linux container init may retain orphan zombies. They cannot do device work.
        return any(not state.startswith('Z') for state in states)
    except (OSError, subprocess.SubprocessError):
        return True


def finish_group(child):
    try: os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        child.wait()
        return
    deadline = time.monotonic() + 2
    while group_running(child):
        if time.monotonic() >= deadline:
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: break
        time.sleep(.1)
    child.wait()


def lease_run(owner, purpose, ttl, args):
    stop = threading.Event()
    child = None
    handlers = {}
    received = []
    acquired = False
    lost_claim = []
    lease_id = None
    group_finished = False
    def forward(signum, _frame):
        received.append((signum, time.monotonic()))
        if child is not None:
            try: os.killpg(child.pid, signum)
            except ProcessLookupError: pass
    def heartbeat():
        while not stop.wait(ttl / 3):
            try: phonelock.refresh(owner, lease_id=lease_id)
            except (phonelock.Busy, OSError) as exc:
                lost_claim.append(str(exc) if isinstance(exc, phonelock.Busy) else "lease metadata unavailable")
                # Loss of the claim must stop even direct-adb/u2 children.
                forward(signal.SIGTERM, None)
                return
    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            handlers[sig] = signal.signal(sig, forward)
        lease = phonelock.acquire(owner, purpose, ttl, exclusive=True)
        lease_id = lease["lease_id"]
        acquired = True
        if received: return 128 + received[-1][0]
        child = subprocess.Popen(args, env={**os.environ, "PH_LEASE_OWNER": owner}, start_new_session=True)
        if received: forward(received[-1][0], None)
        worker = threading.Thread(target=heartbeat, daemon=True)
        worker.start()
        while True:
            try:
                code = child.wait(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                if received and time.monotonic() - received[0][1] >= 2:
                    try: os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
        finish_group(child)
        group_finished = True
        stop.set()
        worker.join()
        if lost_claim:
            refuse(lost_claim[0])
            return 5
        return code if code >= 0 else 128 - code
    finally:
        if child is not None and not group_finished:
            finish_group(child)
        stop.set()
        if 'worker' in locals(): worker.join()
        if acquired:
            try: phonelock.release(owner, lease_id=lease_id)
            except (phonelock.Busy, OSError): pass
        for sig, handler in handlers.items(): signal.signal(sig, handler)


phonelock.event_hook = lock_event
phonelock.safe_purpose = lambda purpose: diagnostic(str(purpose))[:80]

def _alarm(*_): raise TimeoutError("ph: step timed out")
def reset_u2():
    global _d
    if phonelock.check(action=True)[1]:
        _d = None
        return
    try:
        _run(["adb", "-s", SERIAL, "shell", "pkill -f com.wetest.uia2; pkill -f uiautomator"], t=5, device_action=True)
    except Exception: pass
    finally: _d = None

def run(argv):
    global _action_sent, _context, _private_values
    _action_sent = False
    cmd = token(argv[0]) if argv else "help"
    kind = "selector"
    if cmd == "tap":
        kind = "coords" if len(argv) >= 3 and argv[1].isdigit() and argv[2].isdigit() else "id" if len(argv) > 1 and argv[1].startswith("id=") else "text"
    elif cmd in ("type", "wait"): kind = "text"
    _context = dict(cmd=cmd, target_kind=kind, started=time.monotonic())
    values = []
    if cmd == "type": values = [v for v in argv[1:] if v != "--clear"]
    elif cmd == "sh": values = argv[1:]
    elif cmd in ("tap", "wait", "url") and len(argv) > 1 and kind != "coords": values = [argv[1]]
    _private_values = tuple(values + [part for v in values for part in v.splitlines() if part] +
                            [base64.b64encode(v.encode()).decode() for v in values])
    maintain_logs()
    # These local diagnostics have their own bounded adb calls and must never reset u2.
    if cmd == "hold":
        return hold_cli(argv[1:])
    if cmd == "lease":
        return lease_cli(argv[1:])
    if cmd in ("log", "note-drop", "help") or argv[0] == "-h":
        phonelock.hold_state()
        main(argv)
        return 0
    previous = signal.signal(signal.SIGALRM, _alarm)
    lim = int(os.environ.get("PH_TIMEOUT", "45"))
    if cmd == "wait" and len(argv) > 2: lim = int(float(argv[2])) + 30
    try:
        for attempt in (1, 2):
            _context["attempt"] = attempt
            signal.alarm(lim)
            try:
                guard_phone(cmd in ACTIONS)
                main(argv)
                return 0
            except PhoneBusy:
                return 5
            except SystemExit as exc:
                return exc.code
            except Exception as exc:
                signal.alarm(0)
                if _action_sent:
                    event("maybe_sent", exc)
                    reset_u2()
                    print(f"MAYBE_SENT: {cmd} may have reached the phone ({type(exc).__name__}); run 'ph ui' to check before repeating")
                    return 4
                ok, reason = phonelock.check(action=False)
                if reason:
                    refuse(reason, prefix="not resetting u2 while ")
                    return 5
                if isinstance(exc, TimeoutError): event("timeout", exc)
                event("failed" if attempt == 2 else "reconnect", exc)
                reset_u2()
                if attempt == 2:
                    print("ERROR:", type(exc).__name__, diagnostic(str(exc))[:200])
                    return 3
                time.sleep(1)
            finally: signal.alarm(0)
    finally:
        signal.signal(signal.SIGALRM, previous)

if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
