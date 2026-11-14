import collections
import contextlib
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import sys

src, output = map(Path, sys.argv[1:3])
sys.path.insert(0, str(src))
os.environ['RECALL_TOOL_LOG_DIR'] = str(output / 'logs')
import toollog as tl
import robob_readonly as ro

output.mkdir(parents=True)
now = dt.datetime.now(dt.timezone.utc)
paths = [output / name for name in ('state.sqlite', 'opencode.sqlite')]
secret = 'private synthetic query NOT_FOR_LOGS'
for path in paths:
    with contextlib.closing(sqlite3.connect(path)) as con:
        con.execute('CREATE TABLE ardud_readonly_meta(key TEXT PRIMARY KEY,value TEXT)')
        con.executemany('INSERT INTO ardud_readonly_meta VALUES(?,?)',
            [('schema_version', '1'), ('ready', '1'), ('updated_at', now.isoformat())])
        con.execute('CREATE VIRTUAL TABLE messages USING fts5(text)')
        con.execute('INSERT INTO messages VALUES(?)', (secret,))
        con.commit()

@tl.tool
def recall_search(query):
    count = 0
    for path in paths:
        with contextlib.closing(ro.state_ro(path)) as con:
            count += con.execute('SELECT count(*) FROM messages WHERE messages MATCH ?', ('synthetic',)).fetchone()[0]
            ro.ready_generation(con)
    tl.result_count(count)
    return count

for _ in range(1000):
    assert recall_search(secret) == 2

raw = b''.join(p.read_bytes() for p in (output / 'logs').glob('*.ndjson'))
assert secret.encode() not in raw
assert b'NOT_FOR_LOGS' not in raw
rows = [json.loads(line) for line in raw.splitlines()]
print(json.dumps(dict(calls=1000, bytes=len(raw), bytesPerCall=len(raw)/1000,
    lines=len(rows), counts=dict(collections.Counter(r['name'] for r in rows))), indent=2))
