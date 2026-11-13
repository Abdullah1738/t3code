"""Read the server's published snapshot, never the live writer or an alias of it."""
from datetime import datetime, timezone
import os
from pathlib import Path
import sqlite3

MAX_AGE_SECONDS = 120


def replica_path(component, env=None):
    env = os.environ if env is None else env
    return Path(env.get(component) or env.get('ROBOB_READONLY_DB') or
                str(Path(env.get('HOME', str(Path.home()))) / '.robob/userdata/readonly/state.sqlite')).expanduser()


def assert_replica_path(path, home=None, env=None):
    env = os.environ if env is None else env
    raw = os.fspath(path)
    if not raw or raw.startswith('file:') or '\0' in raw:
        raise ValueError('replica must be a filesystem path')
    candidate = Path(os.path.abspath(os.path.expanduser(raw)))
    home = Path(home or Path.home())
    def expand_home(value):
        return home / value[2:] if value.startswith('~/') else home if value == '~' else Path(value)
    homes = [home / '.robob', home / '.t3', Path('/Volumes/ExternalSSD/robob-data')]
    homes.extend(expand_home(env[key]) for key in ('ROBOB_HOME', 'T3CODE_HOME') if env.get(key))
    live_paths = [Path(os.path.abspath(root / 'userdata' / name)) for root in homes
                  for name in ('statev2.sqlite', 'state.sqlite')]
    live_paths.append(home / '.local/share/opencode/opencode.db')
    if env.get('XDG_DATA_HOME'):
        live_paths.append(Path(os.path.abspath(expand_home(env['XDG_DATA_HOME']) / 'opencode/opencode.db')))
    if candidate in live_paths:
        raise ValueError('refusing live Robob/OpenCode database')
    resolved = candidate.resolve(strict=True)
    info = resolved.stat()
    if not resolved.is_file():
        raise ValueError('replica is not a regular file')
    for live in live_paths:
        try:
            live_resolved = live.resolve(strict=True)
            live_info = live.stat()
        except FileNotFoundError:
            continue
        if resolved == live_resolved or (info.st_dev, info.st_ino) == (live_info.st_dev, live_info.st_ino):
            raise ValueError('refusing live Robob/OpenCode database alias')
    return resolved


def assert_ready(db, now=None):
    meta = dict(db.execute("SELECT key, value FROM ardud_readonly_meta "
                           "WHERE key IN ('ready','updated_at','schema_version')"))
    if meta.get('ready') != '1' or meta.get('schema_version') != '1' or not isinstance(meta.get('updated_at'), str):
        raise ValueError('Robob replica is not ready')
    updated = datetime.fromisoformat(meta['updated_at'].replace('Z', '+00:00'))
    if updated.tzinfo is None:
        raise ValueError('Robob replica timestamp has no timezone')
    age = ((now or datetime.now(timezone.utc)) - updated).total_seconds()
    if age < -5 or age > MAX_AGE_SECONDS:
        raise ValueError('Robob replica is stale')


def connect_replica(path, timeout=2):
    safe = assert_replica_path(path)
    db = sqlite3.connect(safe.as_uri() + '?mode=ro', uri=True, timeout=timeout)
    try:
        db.execute('BEGIN')
        assert_ready(db)
        return db
    except Exception:
        db.close()
        raise
