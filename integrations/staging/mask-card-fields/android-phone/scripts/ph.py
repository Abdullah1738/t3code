#!/Users/ardud/.local/android/venv/bin/python
"""ph: drive Abdullah's local Nothing (3a) Lite over ADB/uiautomator2. Run `ph help`."""
import sys, os, re, time, subprocess, xml.etree.ElementTree as ET
SERIAL = os.environ.get("PH_SERIAL", "002473611000997")
TMP = os.environ.get("PH_TMP", "/private/var/folders/vt/8qndzr_j44z70bh0rn2zyfkm0000gn/T/opencode/phone")
os.makedirs(TMP, exist_ok=True)
_d = None
def d():
    global _d
    if _d is None:
        import uiautomator2 as u; _d = u.connect(SERIAL)
    return _d
def adb(*a): return subprocess.run(["adb", "-s", SERIAL, *a], capture_output=True, text=True).stdout
def _run(args, t=5):
    try: return subprocess.run(args, capture_output=True, text=True, timeout=t).stdout
    except Exception: return ""
def doctor(as_json):
    import json
    st, detail, ask, code = "", "", None, 3
    devs = _run(["adb", "devices", "-l"])
    state = {p[0]: p[1] for p in (l.split() for l in devs.splitlines()[1:]) if len(p) > 1}
    if state.get(SERIAL) == "offline":
        _run(["adb", "kill-server"]); time.sleep(1); _run(["adb", "start-server"], t=15)
        devs = _run(["adb", "devices", "-l"])
        state = {p[0]: p[1] for p in (l.split() for l in devs.splitlines()[1:]) if len(p) > 1}
    s = state.get(SERIAL)
    if s == "device":
        echo = _run(["adb", "-s", SERIAL, "shell", "echo ok"]).strip()
        pw = (_run(["adb", "-s", SERIAL, "shell", "dumpsys power | grep -m1 mWakefulness"]).strip().splitlines() or [""])[0]
        if echo == "ok":
            st, detail, code = "ok", f"adb reachable; {pw or 'screen state unknown'}", 0
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
# Up to three non-digit words (or ':', '=', '-') between a label and its value. Newlines count as separators.
_GAP = r"((?:[\s:=\-]*[A-Za-z]{1,20}){0,3}[\s:=\-]*)"
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
sh CMD...                  raw adb shell
"""); return
    c = a[0]
    if c == "ui": show("-a" in a)
    elif c == "tap":
        if len(a) >= 3 and a[1].isdigit() and a[2].isdigit(): d().click(int(a[1]), int(a[2])); print("tapped", a[1], a[2])
        else:
            n = find(a[1], int(a[2]) if len(a) > 2 else 0)
            if not n: print("NOT FOUND:", redact(a[1])); sys.exit(1)
            d().click(n["x"], n["y"]); print("tapped", repr(redact(n["t"] or n["c"], field_ctx(n))), n["x"], n["y"])
    elif c == "wait":
        end = time.time() + (float(a[2]) if len(a) > 2 else 15)
        while time.time() < end:
            hit = find(a[1])
            if hit: print("found", redact(a[1], field_ctx(hit))); return
            time.sleep(0.4)
        print("TIMEOUT", redact(a[1])); sys.exit(1)
    elif c == "type":
        dv = d(); clear = "--clear" in a; txt = [x for x in a[1:] if x != "--clear"][0]
        dv.send_keys(txt, clear=clear); print("typed", len(txt), "chars")
    elif c == "key": d().press(a[1]); print("key", a[1])
    elif c == "swipe": d().swipe_ext(a[1], scale=0.7); print("swiped", a[1])
    elif c == "open": d().app_start(a[1]); print("opened", a[1])
    elif c == "stop": d().app_stop(a[1]); print("stopped", a[1])
    elif c == "url":
        cmd = ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", a[1]] + (["-p", a[2]] if len(a) > 2 else [])
        print(adb(*cmd).strip())
    elif c == "shot":
        f = f"{TMP}/{a[1] if len(a)>1 else 's'}-{time.strftime('%Y%m%d-%H%M%S')}.png"
        with open(f, "wb") as fh: fh.write(subprocess.run(["adb", "-s", SERIAL, "exec-out", "screencap", "-p"], capture_output=True).stdout)
        from PIL import Image
        img = Image.open(f); s = f[:-4] + "-s.png"
        img.resize((540, int(540 * img.height / img.width))).save(s); print(f); print(s)
    elif c == "cur":
        out = subprocess.run(["adb","-s",SERIAL,"shell","dumpsys activity activities | grep -m1 topResumedActivity"],capture_output=True,text=True).stdout.strip()
        print(out or d().app_current())
    elif c == "wake": d().screen_on(); adb("shell", "wm", "dismiss-keyguard"); print("awake")
    elif c == "sms":
        q = ("select datetime(date/1000000000+978307200,'unixepoch','localtime'), text from message "
             f"where is_from_me=0 and text is not null and text != '' order by date desc limit {int(a[1]) if len(a)>1 else 4}")
        print(subprocess.run(["sqlite3", os.path.expanduser("~/Library/Messages/chat.db"), q], capture_output=True, text=True).stdout, end="")
    elif c == "sh": print(adb("shell", *a[1:]), end="")
    elif c == "doctor": doctor("--json" in a)
    else: print("unknown; ph help"); sys.exit(2)
def _alarm(*_): raise TimeoutError("ph: step timed out")
if __name__ == "__main__":
    import signal
    signal.signal(signal.SIGALRM, _alarm)
    lim = int(os.environ.get("PH_TIMEOUT", "45"))
    if sys.argv[1:2] == ["wait"] and len(sys.argv) > 3: lim = int(float(sys.argv[3])) + 30
    for attempt in (1, 2):
        signal.alarm(lim)
        try: main(sys.argv[1:]); break
        except SystemExit: raise
        except Exception as e:
            signal.alarm(0)
            if attempt == 2: print("ERROR:", type(e).__name__, str(e)[:200]); sys.exit(3)
            # u2 server wedged: kill it and reconnect once
            subprocess.run(["adb", "-s", SERIAL, "shell", "pkill -f com.wetest.uia2; pkill -f uiautomator"], capture_output=True, timeout=15)
            _d = None; time.sleep(1)
        finally: signal.alarm(0)
