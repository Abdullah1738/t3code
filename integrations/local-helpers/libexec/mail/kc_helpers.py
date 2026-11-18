"""Keychain transport for ortie's JSON token sets; never expose values in diagnostics."""
import json
import math
import os
import subprocess
import sys

SECURITY = "/usr/bin/security"
STATE = os.path.expanduser("~/.local/state/mail-oauth")


def reject_constant(_):
    raise ValueError("non-JSON constant")


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("nonfinite JSON number")
    return number


def parse_blob(raw):
    if not raw.strip():
        return None, "empty"
    try:
        blob = json.loads(raw.decode("utf-8"), parse_constant=reject_constant, parse_float=finite_float)
    except (ValueError, UnicodeError, RecursionError):
        return None, "nonjson"
    if not isinstance(blob, dict):
        return None, "nonjson"
    if not isinstance(blob.get("access_token"), str) or not blob["access_token"].strip():
        return None, "no-access-token"
    return blob, None


def log_event(service, event, size):
    import fcntl
    from datetime import datetime, timezone
    from pathlib import Path

    try:
        path = Path(os.environ.get("KC_LOG", os.path.join(STATE, "kc.log")))
        path.parent.mkdir(parents=True, exist_ok=True)
        parent = subprocess.run(["/bin/ps", "-o", "comm=", "-p", str(os.getppid())],
                                capture_output=True, timeout=1, text=True).stdout.strip()[:80]
        entry = dict(ts=datetime.now(timezone.utc).isoformat(), pid=os.getpid(), ppid=os.getppid(),
                     parent_cmd=parent, service=service, event=event, bytes=size)
        # One rotation/append at a time across the accounts and helper processes.
        lock_fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(lock_fd, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if path.exists() and path.stat().st_size > 256 * 1024:
                os.replace(path, str(path) + ".1")
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, "a") as out:
                out.write(json.dumps(entry) + "\n")
    except (OSError, ValueError, subprocess.SubprocessError):
        pass


def keychain_args():
    path = os.environ.get("KC_KEYCHAIN")
    return [path] if path else []


def read_item(service, account):
    try:
        result = subprocess.run([SECURITY, "find-generic-password", "-a", account, "-s", service,
                                 "-w", *keychain_args()], stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=15)
        # security adds one newline, which is not part of the stored value.
        raw = result.stdout.removesuffix(b"\n")
        # security prints non-ASCII password data as hex even with -w.
        try:
            decoded = bytes.fromhex(raw.decode("ascii"))
            # Decode the transport even if access_token is damaged; refresh_token may survive.
            if service != "himalaya-icloud":
                decoded.decode("utf-8")
                raw = decoded
        except (ValueError, UnicodeError):
            pass
        return result.returncode, raw
    except (OSError, subprocess.SubprocessError):
        return 74, b""


def quote_arg(arg):
    if any(ord(char) < 32 or ord(char) == 127 for char in arg):
        raise ValueError("control character in Keychain argument")
    return '"' + arg.replace("\\", "\\\\").replace('"', '\\"') + '"'


def store_command(service, account, raw):
    value = raw.decode("utf-8")
    # Pretty-printed JSON can contain literal newlines, which security -i treats as commands.
    option, value = ("-X", raw.hex()) if any(ord(c) < 32 or ord(c) == 127 for c in value) else ("-w", value)
    command = " ".join(quote_arg(arg) for arg in
                       ["add-generic-password", "-U", "-a", account, "-s", service,
                        option, value, *keychain_args()]) + "\n"
    # security -i uses a fixed 4096-byte input buffer, including its NUL terminator.
    if len(command.encode()) >= 4096:
        raise ValueError("credential exceeds security interactive line limit")
    return command.encode()


def store_item(service, account, raw, *, lock_fd=None):
    # Only the interactive command on stdin contains the secret.
    try:
        command = store_command(service, account, raw)
    except ValueError:
        return False
    try:
        # A killed Python writer must not release its lock while this child can still mutate.
        result = subprocess.run([SECURITY, "-i"], input=command,
                                pass_fds=(lock_fd,) if lock_fd is not None else (),
                                capture_output=True, timeout=15)
        rc, actual = read_item(service, account)
        return result.returncode == 0 and rc == 0 and actual == raw
    except (OSError, subprocess.SubprocessError):
        return False


def read(service, account):
    rc, raw = read_item(service, account)
    # These existing mail clients also read a plain iCloud app password through kc-read.
    if rc == 0 and ((service, account) == ("himalaya-icloud", "himalaya") or
                    parse_blob(raw)[0] is not None):
        sys.stdout.buffer.write(raw + b"\n")
        return 0
    backup_rc, backup = read_item(service + ".last-good", account)
    if backup_rc == 0 and parse_blob(backup)[0] is not None:
        log_event(service, "read-fallback", len(backup))
        sys.stdout.buffer.write(backup + b"\n")
        return 0
    log_event(service, "read-failed", len(raw))
    print("kc-read: credential missing or invalid", file=sys.stderr)
    return rc or 65


def write_locked(service, account, raw, blob, *, lock_fd=None):
    rc, current = read_item(service, account)
    if rc not in (0, 44):
        log_event(service, "write-read-failed", len(raw))
        print("kc-write: cannot read current credential", file=sys.stderr)
        return rc
    old, _ = parse_blob(current)
    backup = current if old is not None else b""
    if old is None:
        backup_rc, saved = read_item(service + ".last-good", account)
        if backup_rc not in (0, 44):
            log_event(service, "write-read-failed", len(raw))
            return backup_rc
        if backup_rc == 0 and parse_blob(saved)[0] is not None:
            backup = saved
    # Even a damaged access_token must not cause a still-usable refresh_token to be discarded.
    try:
        previous = json.loads(current) if current else {}
    except (ValueError, UnicodeError, RecursionError):
        previous = {}
    if not isinstance(previous, dict):
        previous = {}
    previous_refresh = previous.get("refresh_token")
    if not isinstance(previous_refresh, str) or not previous_refresh.strip():
        previous_refresh = parse_blob(backup)[0].get("refresh_token") if backup else None
    if (not isinstance(blob.get("refresh_token"), str) or not blob["refresh_token"].strip()) and (
            isinstance(previous_refresh, str) and previous_refresh.strip()):
        blob["refresh_token"] = previous_refresh
        raw = json.dumps(blob, ensure_ascii=True, separators=(",", ":")).encode()
        log_event(service, "refresh-token-carried", len(raw))
    try:
        store_command(service, account, raw)
        if old is not None:
            store_command(service + ".last-good", account, current)
    except ValueError:
        log_event(service, "write-refused-too-large", len(raw))
        print("kc-write: credential exceeds security interactive line limit", file=sys.stderr)
        return 65
    if old is not None:
        if not store_item(service + ".last-good", account, current, lock_fd=lock_fd):
            log_event(service, "backup-failed", len(current))
            print("kc-write: backup failed; primary unchanged", file=sys.stderr)
            return 74
        log_event(service, "backup-saved", len(current))
    if store_item(service, account, raw, lock_fd=lock_fd):
        log_event(service, "write-ok", len(raw))
        return 0
    restored = bool(backup) and store_item(service, account, backup, lock_fd=lock_fd)
    log_event(service, "write-verify-failed-restored" if restored else "write-verify-failed", len(raw))
    print("kc-write: verification failed; " + ("previous credential restored" if restored else
                                              "no verified restore; last-good retained"), file=sys.stderr)
    return 74


def write(service, account):
    import fcntl
    import hashlib
    from pathlib import Path

    try:
        raw = sys.stdin.buffer.read()
    except OSError:
        log_event(service, "write-refused-stdin", 0)
        print("kc-write: stdin read failed", file=sys.stderr)
        return 74
    blob, reason = parse_blob(raw)
    if reason:
        log_event(service, "write-refused-" + reason, len(raw))
        print("kc-write: refused " + reason, file=sys.stderr)
        return 65
    # Serialize backup/write/restore independently of ortie's external refresh lock.
    keychain = os.environ.get("KC_KEYCHAIN")
    lock_dir = Path(keychain).parent / "kc-locks" if keychain else Path(STATE) / "kc-locks"
    lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    identity = json.dumps([keychain, service, account]).encode()
    lock_path = lock_dir / (hashlib.sha256(identity).hexdigest() + ".lock")
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return write_locked(service, account, raw, blob, lock_fd=lock.fileno())


def main():
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ("read", "write"):
        print("usage: kc-read/kc-write <service> [account]", file=sys.stderr)
        return 64
    mode, service = sys.argv[1:3]
    account = sys.argv[3] if len(sys.argv) == 4 else "ortie"
    try:
        for arg in [service, account, *keychain_args()]:
            quote_arg(arg)
        return write(service, account) if mode == "write" else read(service, account)
    except (OSError, ValueError):
        log_event(service, mode + "-failed", 0)
        print("kc-" + mode + ": local I/O or argument failure", file=sys.stderr)
        return 74


if __name__ == "__main__":
    sys.exit(main())
