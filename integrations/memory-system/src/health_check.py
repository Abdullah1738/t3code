#!/opt/homebrew/bin/python3
"""Memory-system pipeline health check (launchd: com.abdullah.memory-health).

Checks that the whole pipeline is flowing, not just that processes exist:
  sync      raw capture stage (com.abdullah.memory-sync) succeeded recently
  lag       native OpenCode sessions older than 30 min are in memory.db
  muse_lag  Muse capture ran cleanly; logs quiet for 10 min are fully captured
  recall    recall server answers on :18765 and its session catalog keeps up
  backup    last memory backup succeeded recently
  backup_lock  no backup run is hung (>2 h) or died holding logs/backup.lock
  health_backup  health backup had a successful run in the last 13 h
  person_backup  every offbox-person (Moni) backup had a successful run in the last 13 h
  dropbox   Dropbox copy of the live backup repo is complete (name + size)
  disk      internal disk has room
  session_reaper   hourly deletion of 30-day-idle OpenCode sessions runs and is not stuck gated
  location_reaper  5-min cua-driver MCP cleanup runs without errors
  msgs      message archive (com.ardud.message-archive) still reads chat.db

Writes logs/health_last.json and logs/memory_check.log. Sends a Telegram
alert when a check starts failing (once per check per day while it keeps
failing) and an all-clear when it recovers. --dry-run prints and never
notifies.
"""
import argparse
import glob
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import time
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".local/share/memory-system")
DATA = os.path.join(ROOT, "data")
LOGS = os.path.join(ROOT, "logs")
MEM_DB = os.path.join(DATA, "memory.db")
OC_DB = os.path.join(HOME, ".local/share/opencode/opencode.db")
MUSE_SESSIONS = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(HOME, ".local/share"), "muse/sessions")
LIVE_REPO = "/Volumes/ExternalSSD/memory-system-backup/restic/live"
DROPBOX_LIVE = "/Backups/memory-system/live"
STATE = os.path.join(LOGS, "health_state.json")
LAST = os.path.join(LOGS, "health_last.json")
BUN = os.path.join(HOME, ".bun/bin/bun")
TG_CLI = os.path.join(HOME, ".local/share/telegram-bridge/src/cli.ts")

SYNC_MAX_AGE = 15 * 60          # tick every 120 s
LAG_GRACE_MS = 30 * 60 * 1000   # settle window is 10 min
LAG_MAX = 3
MUSE_LAG_GRACE = 10 * 60        # a log may run ahead of memory.db this long
RECALL_URL = "http://127.0.0.1:18765/api/health"
RECALL_MAX_LAG = 20000          # events the session catalog may trail by
BACKUP_MAX_AGE = 9 * 3600       # backup every 4 h
BACKUP_LOCK_MAX_AGE = 2 * 3600  # runs take up to ~1.7 h
HEALTH_BACKUP_STATUS = os.path.join(HOME, ".local/share/health-backup/backup_last.json")
PERSON_BACKUP_DIR = os.path.join(HOME, ".local/share/offbox-person/state")
OTHER_BACKUP_MAX_AGE = 13 * 3600  # these run every 6 h: two missed runs plus slack
DISK_MIN_GB = 30
MSGS_VOLUME = "/Volumes/ExternalSSD"
MSGS_DB = os.path.join(MSGS_VOLUME, "message-archive/index.db")
MSGS_LOG = os.path.join(HOME, ".local/share/message-archive/logs/daemon.log")
MSGS_MAX_AGE = 3600             # awake time without a new iMessage pass; passes run every 30 s, ~15 min under load
MSGS_SEEN = os.path.join(LOGS, "msgs_seen.json")
DRY_RUN = False                 # --dry-run: checks report but keep no state


def ro(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    c.execute("PRAGMA busy_timeout=30000")
    return c


def launchd_exit(label):
    out = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"],
                         capture_output=True, text=True).stdout
    m = re.search(r"last exit code = (\d+|\(never exited\))", out)
    runs = re.search(r"\bruns = (\d+)", out)
    return (m.group(1) if m else None), (int(runs.group(1)) if runs else 0), bool(out)


def stage_status(name):
    """logs/<name>_last.json written by scripts/stage_lib.sh."""
    try:
        return json.load(open(os.path.join(LOGS, f"{name}_last.json")))
    except Exception:
        return None


def check_sync():
    # raw capture stage (scripts/memory_capture_tick.sh, own lock + deadline)
    _, _, loaded = launchd_exit("com.abdullah.memory-sync")
    if not loaded:
        return False, "memory-sync (capture) launch agent not loaded"
    st = stage_status("capture")
    if not st:
        return False, "no capture status (logs/capture_last.json)"
    last_ok = st.get("last_ok_ts") or 0
    age = time.time() - last_ok
    if age > SYNC_MAX_AGE:
        cur = f"; current run {st.get('state')} for {int(st.get('secs') or 0)} s" if st.get("state") == "running" \
            else f"; last run {st.get('state')} rc={st.get('rc')}"
        return False, f"last successful capture {int(age/60)} min ago{cur}"
    return True, f"last capture ok {int(age)} s ago"


def check_lag():
    mem = ro(MEM_DB)
    known = dict(mem.execute("SELECT session_id, time_updated FROM opencode_sync_sessions"))
    src = ro(OC_DB)
    cutoff = int(time.time() * 1000) - LAG_GRACE_MS
    behind = []
    for sid, tu, meta in src.execute("SELECT id, time_updated, metadata FROM session_v2 WHERE time_updated < ?", (cutoff,)):
        try:
            m = json.loads(meta) if meta else {}
        except ValueError:
            m = {}
        if isinstance(m, dict) and m.get("migration"):
            continue
        # -1 = sync saw the session but it still has an in-flight (unsettled)
        # message; session_v2.time_updated is not bumped by new messages, so
        # active sessions would otherwise look "behind". Sync staleness is
        # covered by check_sync.
        if known.get(sid) not in (tu, -1):
            behind.append(sid)
    if len(behind) > LAG_MAX:
        return False, f"{len(behind)} OpenCode sessions not synced into memory.db (e.g. {behind[0]})"
    return True, f"{len(behind)} sessions behind"


def check_muse_lag():
    """Muse capture ran cleanly, and logs that grew MUSE_LAG_GRACE ago are fully captured."""
    if not os.path.isdir(MUSE_SESSIONS):
        return True, "no Muse sessions"
    try:
        st = json.load(open(os.path.join(LOGS, "muse_last.json")))
    except Exception:
        st = None
    if st is not None:
        age = time.time() - (st.get("ts") or 0)
        if age > SYNC_MAX_AGE:
            return False, f"Muse capture last ran {int(age / 60)} min ago"
        if not st.get("ok"):
            errs = "; ".join(st.get("errors") or [])[:200]
            return False, f"Muse capture failed: {errs or 'see logs/capture-*.log'}"
    mem = ro(MEM_DB)
    try:
        known = {p: (size, skip) for p, size, skip in mem.execute("SELECT path, size, skip FROM muse_sync_files")}
    except sqlite3.Error:
        known = {}
    cutoff = time.time() - MUSE_LAG_GRACE
    behind = []
    for dirpath, dirnames, filenames in os.walk(MUSE_SESSIONS):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("tool-outputs", "approval-review")]
        if "session.jsonl" not in filenames:
            continue
        path = os.path.join(dirpath, "session.jsonl")
        try:
            fst = os.stat(path)
        except OSError:
            continue
        if fst.st_mtime > cutoff:
            continue
        size, skip = known.get(path, (None, 0))
        if not skip and size != fst.st_size:
            behind.append(os.path.basename(dirpath))
    if len(behind) > LAG_MAX:
        return False, f"{len(behind)} Muse Code sessions not synced into memory.db (e.g. {behind[0]})"
    return True, f"{len(behind)} Muse sessions behind"


NATIVE_LAG_MAX = 15 * 60         # oldest complete line not yet captured
NATIVE_ERROR_MAX = 30 * 60       # a quarantined file must recover within this
NATIVE_ALIAS_MAX = 15 * 60       # thread_aliases refresh (card D1)
NATIVE_LEDGER = os.path.join(DATA, "memory.db")
ROBOB_SETTINGS = os.path.join(HOME, ".robob/userdata/settings.json")
NATIVE_SEEN = os.path.join(LOGS, "native_capture_seen.json")
CLAUDE_SETTINGS = os.path.join(HOME, ".robob/harness-homes/claude/settings.json")
CLEANUP_MIN_DAYS = 3650
NATIVE_ZSTD_MAX_OFFSET = 256 << 20
NATIVE_ZSTD_LINE_LIMIT = 1 << 20
# D1's representation offsets are uncompressed, including for .zst files.
NATIVE_LEDGER_COLUMNS = {"rep_id", "path", "inode", "offset", "phys_size", "complete", "error_count", "retired"}


def _native_enabled(instance):
    """Robob's real settings: providerInstances is a dict keyed by instance id, and
    `enabled` on each entry (absent means on). True/False when readable, None when
    the file is missing or unreadable (unknown: the root check then stays strict)."""
    try:
        with open(ROBOB_SETTINGS) as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    instances = st.get("providerInstances") if isinstance(st, dict) else None
    if not isinstance(instances, dict):
        return None
    # The generated Claude home is named "claude", but the instance id is claudeAgent.
    inst = instances.get("claudeAgent" if instance == "claude" else instance)
    if not isinstance(inst, dict):
        return None
    config = inst.get("config")
    if inst.get("enabled") is False or (isinstance(config, dict) and config.get("enabled") is False):
        return False
    return True


def _load_native_ledger():
    """(ledger rows by path, root passes, identity refresh epoch, problem). A missing, unreadable or
    wrong-shaped ledger is a problem, never an empty success."""
    if not os.path.isfile(NATIVE_LEDGER):
        return {}, {}, None, "native capture ledger missing (memory.db)"
    try:
        c = ro(NATIVE_LEDGER)
    except sqlite3.Error as e:
        return {}, {}, None, f"native capture ledger unreadable ({e})"
    try:
        cols = [d[1] for d in c.execute("PRAGMA table_info(native_capture_files)")]
        if not NATIVE_LEDGER_COLUMNS <= set(cols):
            return {}, {}, None, f"native_capture_files lacks columns {sorted(NATIVE_LEDGER_COLUMNS - set(cols))}"
        rows = {os.path.realpath(row[cols.index("path")]): dict(zip(cols, row))
                for row in c.execute("SELECT * FROM native_capture_files WHERE retired=0 ORDER BY rep_id")}
        root_cols = {r[1] for r in c.execute("PRAGMA table_info(native_capture_roots)")}
        passes = {}
        if {"instance", "root", "last_pass_at"} <= root_cols:
            passes = {(instance, os.path.realpath(root)): last_pass
                      for instance, root, last_pass in c.execute(
                          "SELECT instance, root, last_pass_at FROM native_capture_roots")
                      if isinstance(instance, str) and isinstance(root, str)}

        meta_cols = {r[1] for r in c.execute("PRAGMA table_info(harness_schema_meta)")}
        if meta_cols and not {"key", "value"} <= meta_cols:
            return rows, passes, None, "harness_schema_meta has no identity watermark columns"
        identity = (c.execute("SELECT value FROM harness_schema_meta WHERE key='thread_identity_last_ok'").fetchone()
                    if meta_cols else None)
        if identity is not None:
            alias_epoch = identity[0]
        else:
            alias_cols = {r[1] for r in c.execute("PRAGMA table_info(thread_aliases)")}
            alias_epoch = (c.execute("SELECT max(last_seen) FROM thread_aliases").fetchone()[0]
                           if "last_seen" in alias_cols else None)
        return rows, passes, alias_epoch, None
    except sqlite3.Error as e:
        return {}, {}, None, f"native capture ledger read failed ({e})"
    finally:
        c.close()


def _native_epoch(value, now):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        value = float(value)
    except (ValueError, OverflowError):
        return None
    return value if math.isfinite(value) and 0 <= value <= now else None


def _native_first_line(path, offset, compressed):
    """First complete unconsumed line, or None when it cannot be read within the bound."""
    if not compressed:
        with open(path, "rb") as fh:
            fh.seek(offset)
            line = fh.readline()
        return line if line.endswith(b"\n") else None

    if offset > NATIVE_ZSTD_MAX_OFFSET:
        return None
    import transcript_capture
    zstd = transcript_capture.zstd_bin()
    if not zstd:
        return None
    try:
        proc = subprocess.Popen([zstd, "-dc", path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
    except OSError:
        return None
    try:
        remaining = offset
        while remaining:
            chunk = proc.stdout.read(min(65536, remaining))
            if not chunk:
                return None
            remaining -= len(chunk)
        line = bytearray()
        while len(line) < NATIVE_ZSTD_LINE_LIMIT:
            chunk = proc.stdout.read(min(65536, NATIVE_ZSTD_LINE_LIMIT - len(line)))
            if not chunk:
                return None
            pos = chunk.find(b"\n")
            if pos >= 0:
                line.extend(chunk[:pos + 1])
                return bytes(line)
            line.extend(chunk)
        return None
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.kill()
        proc.wait()


def _native_line_epoch(path, offset, compressed, now):
    line = _native_first_line(path, offset, compressed)
    if line is None:
        return None
    try:
        rec = json.loads(line)
        value = rec.get("timestamp") if isinstance(rec, dict) else None
        if not isinstance(value, str) or len(value) < 19:
            return None
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return _native_epoch(dt.timestamp(), now)
    except (ValueError, UnicodeDecodeError, OverflowError, OSError):
        return None


def _native_matching_plain_archive(path, root, instance, ledger):
    """A redundant archive is covered only by a byte-identical plain checkpoint."""
    import transcript_capture
    if not path.endswith(".jsonl.zst") or not instance.startswith("codex"):
        return None
    parts = os.path.relpath(path[:-4], root).split(os.sep)
    candidates = [os.path.join(root, *parts)]
    if parts[0] in ("sessions", "archived_sessions"):
        parts[0] = "archived_sessions" if parts[0] == "sessions" else "sessions"
        candidates.append(os.path.join(root, *parts))
    for candidate in candidates:
        candidate = os.path.realpath(candidate)
        row = ledger.get(candidate)
        if row and os.path.isfile(candidate) and transcript_capture.compressed_equals_plain(path, candidate):
            return row, candidate
    return None


def _complete_pending_bytes(path, offset, size):
    """Bytes past the consumed offset up to the last newline. A fresh partial tail
    (no newline yet) counts as 0: it gets grace until its line completes."""
    extra = size - offset
    if extra <= 0:
        return 0
    with open(path, "rb") as fh:
        end = size
        while end > offset:
            start = max(offset, end - 65536)
            fh.seek(start)
            chunk = fh.read(end - start)
            pos = chunk.rfind(b"\n")
            if pos >= 0:
                return start + pos + 1 - offset
            end = start
    return 0


def native_roots_report(now=None, seen=None):
    """Report per root; update `seen` with observed backlog/error start times.

    The first pending record's timestamp is preferred. When unavailable, keep
    the first observation until its complete byte boundary is consumed; a fresh
    mtime or a partial consumer checkpoint cannot reset the fallback clock.
    """
    import transcript_roots
    now = time.time() if now is None else now
    seen = {} if seen is None else seen
    prior_files = seen.get("files", {})
    prior_roots = set(seen.get("roots", []))
    next_files = {}
    report, problems = [], []
    ledger, root_passes, alias_epoch, ledger_problem = _load_native_ledger()
    root_rows = transcript_roots.resolve() if hasattr(transcript_roots, "resolve") else transcript_roots.roots()
    for r in root_rows:
        inst = r["instance"]
        root = os.path.realpath(os.path.expanduser(r.get("path") or r["root"]))
        exists = os.path.isdir(root)
        entry = {"instance": inst, "root": root, "exists": exists, "files": 0,
                 "backlog_bytes": 0, "oldest_lag_s": 0}
        report.append(entry)
        if not exists:
            if _native_enabled(inst) is False and root not in prior_roots and (inst, root) not in root_passes and not any(
                    p.startswith(root + os.sep) for p in ledger):
                continue
            problems.append(f"{inst}: expected root missing ({root})")
            continue
        prior_roots.add(root)
        if ledger_problem:
            problems.append(f"{inst}: {ledger_problem}")
        else:
            pass_epoch = _native_epoch(root_passes.get((inst, root)), now)
            if pass_epoch is None:
                problems.append(f"{inst}: no recent successful capture pass for root (missing or invalid)")
            elif now - pass_epoch > NATIVE_LAG_MAX:
                problems.append(f"{inst}: no recent successful capture pass for root ({int(now - pass_epoch)} s old)")
        identity_epoch = _native_epoch(alias_epoch, now)
        if alias_epoch is None:
            problems.append(f"{inst}: no thread identity refresh watermark")
        elif identity_epoch is None or now - identity_epoch > NATIVE_ALIAS_MAX:
            problems.append(f"{inst}: thread identity refresh stale or invalid")
        subdirs = ("projects",) if inst in ("claude", "claudeAgent") else ("sessions", "archived_sessions")
        for subdir in subdirs:
            directory = os.path.join(root, subdir)
            def walk_error(e):
                problems.append(f"{inst}: cannot scan transcript directory: {e}")
            for dirpath, _, names in os.walk(directory, onerror=walk_error):
                for name in names:
                    if not name.endswith((".jsonl", ".jsonl.zst")):
                        continue
                    full = os.path.realpath(os.path.join(dirpath, name))
                    try:
                        st = os.stat(full)
                        row = ledger.get(full)
                        if row is None and name.endswith(".jsonl.zst"):
                            matching = _native_matching_plain_archive(full, root, inst, ledger)
                            if matching:
                                # The plain file is scanned independently with the same logical bytes.
                                continue
                        offset = int(row["offset"]) if row else 0
                        compressed = name.endswith(".zst")
                        if offset < 0:
                            problems.append(f"{inst}: {name} capture checkpoint does not match file")
                            offset = 0
                        if compressed:
                            matches = row and row["inode"] == st.st_ino and row["phys_size"] == st.st_size
                            if row and not matches:
                                problems.append(f"{inst}: {name} capture checkpoint does not match file")
                                offset = 0
                            pending = not (matches and row["complete"])
                            complete_bytes = max(st.st_size, 1) if pending else 0
                        else:
                            if offset > st.st_size or (row and row["inode"] != st.st_ino):
                                problems.append(f"{inst}: {name} capture checkpoint does not match file")
                                offset = 0
                            complete_bytes = _complete_pending_bytes(full, offset, st.st_size)
                    except (OSError, TypeError, ValueError) as e:
                        problems.append(f"{inst}: cannot inspect {name}: {e}")
                        continue
                    entry["files"] += 1
                    previous = prior_files.get(full, {})
                    same = previous.get("inode") == st.st_ino
                    record = {"inode": st.st_ino}
                    if complete_bytes:
                        entry["backlog_bytes"] += complete_bytes
                        # An observed byte boundary stays outstanding across partial progress.
                        old_boundary = previous.get("boundary") if same else None
                        old_pending = previous.get("pending_since") if same else None
                        if (not isinstance(old_pending, (int, float)) or isinstance(old_pending, bool)
                                or not math.isfinite(old_pending) or old_pending > now):
                            old_pending = None
                        still_pending = old_pending is not None and (compressed or
                                          (isinstance(old_boundary, int) and offset < old_boundary))
                        since = old_pending if still_pending else now
                        invalid_time = (same and previous.get("pending_since") is not None and old_pending is None)
                        unknown = previous.get("unknown", False) if still_pending else not same or invalid_time
                        boundary = old_boundary if still_pending else (st.st_size if compressed else offset + complete_bytes)
                        record.update(pending_since=since, boundary=boundary, unknown=unknown)
                        source_since = _native_line_epoch(full, offset, compressed, now)
                        if compressed and offset > NATIVE_ZSTD_MAX_OFFSET:
                            lag = max(0, now - since)
                            age_unknown = True
                        elif source_since is not None:
                            # A known observation is a lower bound on the age even
                            # when the source clock is newer or later moves forward.
                            lag = now - min(source_since, since) if still_pending else now - source_since
                            age_unknown = False
                        else:
                            lag = max(0, now - since)
                            age_unknown = unknown
                        if age_unknown:
                            entry["oldest_lag_s"] = None
                        elif entry["oldest_lag_s"] is not None:
                            entry["oldest_lag_s"] = max(entry["oldest_lag_s"], int(lag))
                        if age_unknown or lag > NATIVE_LAG_MAX:
                            age = ("age unknown (compressed)" if age_unknown and compressed else
                                   "oldest unknown" if age_unknown else f"oldest {int(lag)} s")
                            problems.append(f"{inst}: {name} has {complete_bytes} pending bytes, "
                                            f"{age}")
                    if row and (row.get("error_count") or 0) > 0:
                        if "error_since" in row:
                            error_since = _native_epoch(row["error_since"], now)
                            error_unknown = error_since is None
                        else:
                            error_since = _native_epoch(previous.get("error_since"), now) if same else None
                            error_unknown = (previous.get("error_unknown", False) if error_since is not None
                                             else not same or "error_since" in previous)
                            if error_since is None:
                                error_since = now
                            record.update(error_since=error_since, error_unknown=error_unknown)
                        if error_unknown or now - error_since > NATIVE_ERROR_MAX:
                            age = "unknown age" if error_unknown else f"{int(now - error_since)} s"
                            problems.append(f"{inst}: {name} capture errors for {age}")
                    next_files[full] = record
    seen["roots"] = sorted(prior_roots)
    seen["files"] = next_files
    return report, problems


def check_native_capture():
    try:
        try:
            with open(NATIVE_SEEN) as f:
                seen = json.load(f)
            if not isinstance(seen, dict) or not isinstance(seen.get("files", {}), dict):
                raise ValueError("invalid native observation state")
        except FileNotFoundError:
            seen = {}
        report, problems = native_roots_report(seen=seen)
        if not DRY_RUN:
            tmp = NATIVE_SEEN + ".tmp"
            with open(tmp, "w") as f:
                json.dump(seen, f)
            os.replace(tmp, NATIVE_SEEN)
    except Exception as e:
        return False, f"native capture check crashed: {type(e).__name__}: {e}"
    summary = "; ".join(f"{r['instance']} {r['files']} files, {r['backlog_bytes']} B backlog, "
                        f"oldest {str(r['oldest_lag_s']) + ' s' if r['oldest_lag_s'] is not None else 'unknown'}"
                        if r["exists"] else f"{r['instance']} absent"
                        for r in report)
    if problems:
        return False, "; ".join(problems[:3]) + f" [{summary}]"
    return True, summary


def check_claude_retention():
    try:
        with open(CLAUDE_SETTINGS) as f:
            days = json.load(f).get("cleanupPeriodDays")
    except (OSError, ValueError):
        return False, f"cannot read {CLAUDE_SETTINGS}"
    if not isinstance(days, int) or days < CLEANUP_MIN_DAYS:
        return False, f"cleanupPeriodDays is {days}, need >= {CLEANUP_MIN_DAYS}"
    return True, f"cleanupPeriodDays {days}"


def check_recall():
    import urllib.request
    try:
        with urllib.request.urlopen(RECALL_URL, timeout=10) as r:
            st = json.loads(r.read())
    except Exception as e:
        return False, f"recall server not answering on :18765 ({e})"
    lag = st.get("catalog_lag")
    if isinstance(lag, int) and lag > RECALL_MAX_LAG:
        return False, f"recall session catalog {lag} events behind (refresh: {str(st.get('catalog_refresh'))[:120]})"
    return True, f"up, catalog lag {lag}"


def check_backup():
    p = os.path.join(LOGS, "backup_last.json")
    try:
        st = json.load(open(p))
    except Exception:
        return False, "no backup status (logs/backup_last.json)"
    last_ok = st.get("last_success_ts") or 0
    if not st.get("ok"):
        return False, f"last backup failed at {st.get('stage')}: {st.get('message', '')[:200]}"
    if time.time() - last_ok > BACKUP_MAX_AGE:
        return False, f"last successful backup {int((time.time()-last_ok)/3600)} h ago"
    return True, f"snapshot {st.get('last_snapshot')} {int((time.time()-last_ok)/60)} min ago"


def _backup_age(path, label):
    # Stall only: a run that failed is already alerted by its own script, so ok=false is not checked here.
    try:
        with open(path) as f:
            st = json.load(f)
    except Exception:
        return False, f"no {label} backup status ({path})"
    last_ok = st.get("last_success_ts") or 0
    age = time.time() - last_ok
    if not last_ok or age > OTHER_BACKUP_MAX_AGE:
        return False, (f"no good {label} backup in {int(OTHER_BACKUP_MAX_AGE/3600)} h "
                       f"(last: {st.get('stage')} {str(st.get('message', ''))[:120]})")
    return True, f"{label} ok {int(age/60)} min ago"


def check_health_backup():
    return _backup_age(HEALTH_BACKUP_STATUS, "health")


def check_person_backups():
    if not os.path.isdir(PERSON_BACKUP_DIR):
        return True, "no offbox-person backups"
    paths = sorted(glob.glob(os.path.join(PERSON_BACKUP_DIR, "*-backup.json")))
    if not paths:
        return False, f"no offbox-person backup status in {PERSON_BACKUP_DIR}"
    results = []
    for p in paths:
        label = os.path.basename(p)[:-len("-backup.json")]
        results.append(_backup_age(p, label))
    if any(not ok for ok, _ in results):
        return False, "; ".join(msg for ok, msg in results if not ok)
    return True, "; ".join(msg for _, msg in results)


def pid_is_backup(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    cmd = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
    return "memory_backup.sh" in cmd


def check_backup_lock():
    # launchd never starts the backup job while a previous run is alive, so a
    # hung run blocks every later one silently; the backup script can't see it.
    lock = os.path.join(LOGS, "backup.lock")
    try:
        age = time.time() - os.stat(lock).st_mtime
    except FileNotFoundError:
        return True, "no backup running"
    try:
        with open(os.path.join(lock, "pid")) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        pid = None
    if pid is None and age < 60:
        return True, "backup starting"
    if pid is None or not pid_is_backup(pid):
        # the next backup run removes it (and logs that)
        return False, f"backup run {pid or '?'} died without releasing logs/backup.lock ({int(age/60)} min old)"
    if age > BACKUP_LOCK_MAX_AGE:
        return False, (f"backup run PID {pid} still running after {age/3600:.1f} h; later runs are blocked "
                       f"until it exits; a stuck replica or restic backup should have timed out by itself; "
                       f"check logs/backup-YYYYMM.log")
    return True, f"backup PID {pid} running for {int(age/60)} min"


def check_dropbox():
    # independent of the backup job: Dropbox copy of the live repo matches the
    # local repo by name + size (full content_hash check runs in every backup)
    import sys
    sys.path.insert(0, os.path.join(ROOT, "src"))
    import dropbox_mirror as dm
    try:
        api = dm.Api()
        rem = api.list_files(DROPBOX_LIVE)
    except Exception as e:
        return False, f"Dropbox API/auth failed: {str(e)[:200]}"
    loc = dm.local_files(LIVE_REPO)
    missing = [k for k in loc if k not in rem or rem[k]["size"] != loc[k]["size"]]
    # packs written in the last backup run may still be uploading
    old = [k for k in missing if time.time() - os.path.getmtime(loc[k]["abs"]) > BACKUP_MAX_AGE]
    if old and os.path.isdir(os.path.join(LOGS, "backup.lock")):
        return True, f"backup running; {len(missing)} files still uploading to {DROPBOX_LIVE}"
    if old:
        return False, f"{len(old)} live repo files missing/different in Dropbox {DROPBOX_LIVE}"
    return True, f"{len(rem)} files in Dropbox {DROPBOX_LIVE} ({len(missing)} pending)"


def check_disk():
    free = shutil.disk_usage(HOME).free / 1e9
    if free < DISK_MIN_GB:
        return False, f"internal disk has {free:.0f} GB free"
    return True, f"{free:.0f} GB free"


def check_cold_finalize():
    # one-shot job that deletes the raw Codex/Hermes data once the cold archive is in Dropbox
    p = os.path.join(LOGS, "cold_finalize.json")
    try:
        st = json.load(open(p))
    except Exception:
        return True, "not started"
    if st.get("state") == "failed":
        return False, f"cold archive finalize failed: {st.get('message', '')[:200]}"
    return True, f"{st.get('state')}: {st.get('message', '')[:120]}"


def _reaper_status(name, max_age, ok_max_age=None):
    p = os.path.join(LOGS, f"{name}_last.json")
    try:
        st = json.load(open(p))
    except Exception:
        return False, f"{name} has never run ({p} missing)"
    age = time.time() - st.get("ts", 0)
    if age > max_age:
        return False, f"{name} last ran {age / 3600:.1f} h ago"
    if st.get("state") == "error":
        errs = "; ".join(str(e) for e in (st.get("errors") or [])[:3]) or st.get("message", "")
        return False, f"{name} failed: {errs[:200]}"
    if ok_max_age and time.time() - st.get("last_ok_ts", st.get("ts", 0)) > ok_max_age:
        return False, f"{name} has been gated since {time.strftime('%m-%d %H:%M', time.localtime(st.get('last_ok_ts', 0)))}: {st.get('message', '')[:160]}"
    return True, None


def check_session_reaper():
    # hourly: deletes OpenCode sessions idle 30+ days once memory + Dropbox backup are verified
    ok, msg = _reaper_status("session_reaper", 3 * 3600, ok_max_age=26 * 3600)
    if not ok:
        return ok, msg
    st = json.load(open(os.path.join(LOGS, "session_reaper_last.json")))
    return True, (f"{st.get('state')}: deleted {st.get('deleted_sessions', 0)} sessions this run, "
                  f"{st.get('remaining_trees', '?')} stale trees left, skipped {st.get('skipped', {})}")


def check_location_reaper():
    # every 5 min: disconnects cua-driver MCP from idle OpenCode locations
    ok, msg = _reaper_status("location_reaper", 30 * 60)
    if not ok:
        return ok, msg
    st = json.load(open(os.path.join(LOGS, "location_reaper_last.json")))
    return True, (f"{st.get('state')}: {st.get('cua_procs', '?')} cua-driver procs, "
                  f"{len(st.get('disconnected', []))} disconnected this run")


def check_worktree_reaper():
    # daily 04:30: removes linked git worktrees with no commits in 60 days and nothing ahead
    p = os.path.expanduser("~/.local/share/dev-janitor/worktree_reaper_last.json")
    try:
        st = json.load(open(p))
    except Exception:
        return False, f"worktree_reaper has never run ({p} missing)"
    age = time.time() - st.get("ts", 0)
    if age > 26 * 3600:
        return False, f"worktree_reaper last ran {age / 3600:.1f} h ago"
    if st.get("state") != "done":
        return False, "worktree_reaper failed: " + "; ".join(st.get("errors", [])[:3])[:200]
    return True, f"removed {len(st.get('removed', []))} worktrees this run, {st.get('worktrees', '?')} checked"


def _last_log_error(path, source, tail_bytes=256 * 1024):
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - tail_bytes))
            lines = f.read().decode(errors="replace").splitlines()
    except OSError:
        return None
    return next((ln for ln in reversed(lines) if f" {source}: ERROR " in ln), None)


def _boot_id():
    # kern.boottime moves when the wall clock is stepped, so it can't tell a
    # reboot apart from a clock change; the boot session UUID only changes on boot.
    try:
        r = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None  # the uptime check below still spots a reboot
    return r.stdout.strip() or None


def _msgs_failing():
    try:
        with open(STATE) as f:
            return "msgs" in json.load(f).get("failing", {})
    except (OSError, ValueError, AttributeError):
        return False


def _msgs_seen():
    try:
        with open(MSGS_SEEN) as f:
            rec = json.load(f)
        return rec if isinstance(rec, dict) else {}
    except (OSError, ValueError):
        return {}


def _uptime():
    return time.clock_gettime(time.CLOCK_UPTIME_RAW)  # stops while asleep, 0 at boot


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _msgs_track(last_ok, prev):
    """Record for last_ok as the archive's newest iMessage pass, and the awake
    seconds since these runs first saw it. The uptime clock stops while the
    Mac sleeps, so a wake gets the allowance to catch up but never a fresh
    one, and only a new pass starts over. After a reboot the time already
    counted carries over and the new boot's uptime counts too. A boot id
    lookup that fails is unknown, not a reboot: the uptime clock decides."""
    up, boot = _uptime(), _boot_id()
    # seen: last sample on a confirmed boot (the accounting); up: last sample
    # of any kind, so a reboot still shows as uptime going back
    rec = {"last_ok": last_ok, "boot": boot, "start": up, "seen": up, "carried": 0, "up": up}
    try:
        if prev["last_ok"] == last_ok:
            start, seen, carried, last_up = prev["start"], prev["seen"], prev["carried"], prev["up"]
            prev_boot = prev["boot"]
            # Older record layouts (no "up", numeric boot) can't say which boot
            # their last sample was on, so they count from now like bad ones.
            if not (all(map(_num, (start, seen, carried, last_up))) and 0 <= start <= seen <= last_up
                    and carried >= 0 and (prev_boot is None or isinstance(prev_boot, str))):
                raise TypeError("bad timing fields")
            known = boot is not None and prev_boot is not None
            rebooted = up < last_up or (known and boot != prev_boot)
            if rebooted:
                # Carry only time certain to be before this boot. Uptime going back
                # puts every earlier sample before it; a boot id change alone
                # doesn't say which boot the unknown samples since `seen` were on.
                rec.update(start=0, carried=carried + (last_up if up < last_up else seen) - start)
            elif boot is None:
                # Unknown boot: keep the last confirmed sample as is. Saving this
                # uptime under the old boot id would count it twice if it turns
                # out to be a new boot, once carried and once as the new uptime.
                rec.update(boot=prev_boot, start=start, seen=seen, carried=carried)
            else:
                rec.update(start=start, carried=carried)
            if "failed" in prev:
                rec["failed"] = prev["failed"]
    except (KeyError, TypeError):
        pass  # no usable record: count from now
    return rec, rec["carried"] + up - rec["start"]


def _msgs_save(rec):
    if DRY_RUN:
        return  # a dry run must not move the baseline the next real run compares with
    tmp = MSGS_SEEN + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f)
    os.replace(tmp, MSGS_SEEN)


def _msgs_last_ok():
    for attempt in range(2):  # opening the WAL db read-only can fail once while the daemon checkpoints
        try:
            c = ro(MSGS_DB)
            try:
                row = c.execute("SELECT value FROM sync_state WHERE key='imessage'").fetchone()
            finally:
                c.close()
            break
        except sqlite3.OperationalError:
            if attempt:
                raise
            time.sleep(5)
    return (json.loads(row[0]) if row else {}).get("last_ok")


def check_msgs():
    # Full Disk Access for chat.db is granted to the Homebrew Cellar python3.14
    # binary, so a brew upgrade silently cuts the iMessage source off. The daemon
    # only logs and backs off, so watch the last good pass instead.
    _, _, loaded = launchd_exit("com.ardud.message-archive")
    mounted = os.path.ismount(MSGS_VOLUME)
    prev = _msgs_seen()
    if mounted:
        last_ok = _msgs_last_ok()
        if not last_ok:
            return False, "the message archive has never finished an iMessage pass"
    else:
        last_ok = prev.get("last_ok")  # can't read the archive: keep counting from the last pass seen
    age = time.time() - last_ok if last_ok else None
    rec, stuck = _msgs_track(last_ok, prev)
    # A failure holds for the same last pass, so a lost record, a clock change
    # or a failure main() saw without this record (a crash, an unsaved record)
    # can't read as a recovery; only a new pass releases it.
    if prev.get("last_ok") is not None and prev.get("last_ok") != last_ok:
        latched = False
    else:
        latched = bool(rec.get("failed")) or _msgs_failing()
    fresh = loaded and mounted and age is not None and 0 <= age <= MSGS_MAX_AGE
    # Awake time on the same pass decides, not the wall clock: it ignores
    # sleep, and a clock set back can't make an old pass look new.
    ok = stuck < MSGS_MAX_AGE and not latched
    rec["failed"] = not ok
    note = ""
    try:
        _msgs_save(rec)
    except OSError as e:
        # without a saved record every run would look like a first sighting
        note = f" (can't save {MSGS_SEEN}: {e})"
        ok = ok and fresh
    synced = f"iMessage archive last synced {age / 3600:.1f} h ago" if age is not None else "no iMessage pass seen"
    if ok:
        if fresh:
            return True, f"iMessage archived {age / 60:.0f} min ago"
        # after a sleep, a remount or a daemon restart the next pass can take ~15 min
        state = "" if loaded and mounted else " while paused (daemon not loaded or SSD not mounted)"
        return True, f"{synced}, waiting{state}: {stuck / 60:.0f} of {MSGS_MAX_AGE / 60:.0f} awake min"
    if not loaded:
        return False, "com.ardud.message-archive is not loaded; " + synced + note
    if not mounted:
        return False, f"{MSGS_VOLUME} is not mounted, the message archive is paused; " + synced + note
    msg = synced + note
    err = _last_log_error(MSGS_LOG, "imessage")
    if not err:
        return False, msg + ", no error logged (daemon stuck?)"
    msg += f"; last error: {err[:200]}"
    if re.search(r"unable to open|authorization denied|not permitted", err, re.I):
        py = os.path.realpath("/opt/homebrew/opt/python@3.14/bin/python3.14")
        msg += f". Full Disk Access is probably missing for {py} (brew upgrade?): grant it, then kickstart com.ardud.message-archive"
    return False, msg


CHECKS = [("sync", check_sync), ("lag", check_lag), ("muse_lag", check_muse_lag), ("native_capture", check_native_capture),
          ("claude_retention", check_claude_retention), ("recall", check_recall),
          ("backup", check_backup),
          ("backup_lock", check_backup_lock),
          ("health_backup", check_health_backup), ("person_backup", check_person_backups),
          ("dropbox", check_dropbox), ("disk", check_disk), ("cold_finalize", check_cold_finalize),
          ("session_reaper", check_session_reaper), ("location_reaper", check_location_reaper),
          ("worktree_reaper", check_worktree_reaper), ("msgs", check_msgs)]


def notify(severity, text, key):
    r = subprocess.run([BUN, TG_CLI, "notify", "--source", "Memory health", "--severity", severity,
                        "--text", text, "--key", key], capture_output=True, text=True, timeout=60)
    return r.returncode == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    global DRY_RUN
    DRY_RUN = args.dry_run

    results = {}
    for name, fn in CHECKS:
        try:
            ok, msg = fn()
        except Exception as e:  # a crashing check is a failing check
            ok, msg = False, f"check crashed: {type(e).__name__}: {e}"
        results[name] = {"ok": ok, "msg": msg}

    try:
        state = json.load(open(STATE))
    except Exception:
        state = {}
    failing = state.get("failing", {})
    today = time.strftime("%Y%m%d")
    new_fail, recovered = [], []
    for name, r in results.items():
        if not r["ok"]:
            prev = failing.get(name)
            if not prev or prev.get("notified_day") != today:
                new_fail.append(name)
            failing[name] = {"since": (prev or {}).get("since", int(time.time())),
                             "msg": r["msg"], "notified_day": (prev or {}).get("notified_day")}
        elif name in failing:
            recovered.append(name)
            failing.pop(name)

    summary = {"ts": int(time.time()), "ok": all(r["ok"] for r in results.values()), "checks": results}
    if args.dry_run:
        print(json.dumps(summary, indent=1))
        return

    if new_fail:
        lines = [f"- {n}: {results[n]['msg']}" for n in new_fail]
        text = "Memory system problem:\n" + "\n".join(lines)
        key = "memory-health:" + today + ":" + ",".join(f"{n}@{failing[n]['since']}" for n in sorted(new_fail))
        if notify("error" if any(n in ("sync", "backup", "backup_lock", "recall", "health_backup", "person_backup") for n in new_fail) else "attention", text, key):
            for n in new_fail:
                failing[n]["notified_day"] = today
    if recovered:
        text = "Memory system recovered: " + ", ".join(recovered) + "."
        notify("info", text, f"memory-health:recovered:{int(time.time())}:{','.join(recovered)}")

    state["failing"] = failing
    for path, obj in ((STATE, state), (LAST, summary)):
        tmp = path + ".tmp"
        json.dump(obj, open(tmp, "w"), indent=1)
        os.replace(tmp, path)
    with open(os.path.join(LOGS, "memory_check.log"), "w") as f:
        f.write("ok\n" if summary["ok"] else
                "".join(f"FAIL {n}: {r['msg']}\n" for n, r in results.items() if not r["ok"]))


if __name__ == "__main__":
    main()
