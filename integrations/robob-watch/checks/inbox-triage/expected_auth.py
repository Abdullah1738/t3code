"""Shared writer for requested authentication evidence; never stores a code."""
from email.utils import parseaddr
import fcntl
import json
import os
from pathlib import Path
import tempfile
import time


def record(senders, account=None, *, data=None):
    data = Path(data) if data is not None else Path.home() / 'Documents/assistant/inbox-triage'
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (data / 'inflight-actions.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = data / 'inflight-actions.json'
        now = time.time()
        actions = json.loads(path.read_text()) if path.exists() else []
        actions = [a for a in actions if 0 <= now - a['at'] < 600]
        for sender in senders:
            sender = str(sender).strip()
            sender = (parseaddr(sender)[1] if '@' in sender else sender).casefold()
            actions.append({'sender': sender, 'account': account, 'at': now})
        fd, name = tempfile.mkstemp(prefix='.inflight-', dir=data)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(actions, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
