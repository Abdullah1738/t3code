cat > /Volumes/ExternalSSD/tmp/068-index-cost.ig6US8Y9/time-boards-schema.py <<'PY'
from pathlib import Path
import sqlite3,re,time,json,subprocess,sys
root=Path(__file__).parent;repo=Path('/Users/ardud/.robob/worktrees/t3code-fork/068-index-cost')
source=Path('/Volumes/ExternalSSD/robob-data/fast-install-backups/2026-11-13T16-39-18.525Z')
mode=sys.argv[1];dest=root/f'{mode}-boards-schema.sqlite'
for suffix in ['', '-wal']:
    src=source/('boards.sqlite'+suffix);out=Path(str(dest)+suffix)
    assert not out.exists();subprocess.run(['cp','-c',str(src),str(out)],check=True)
    assert src.stat().st_ino!=out.stat().st_ino and out.stat().st_nlink==1
con=sqlite3.connect(dest)
for pragma in ['journal_mode=WAL','synchronous=NORMAL','checkpoint_fullfsync=ON','wal_autocheckpoint=0']:
    con.execute('PRAGMA '+pragma)
sentinel=sqlite3.connect('file:'+str(dest)+'?mode=ro',uri=True);sentinel.execute('SELECT 1 FROM sqlite_schema').fetchone()
file='apps/server/src/ardud/persistence/kanbanSchema.ts'
text=subprocess.check_output(['git','show','HEAD:'+file],cwd=repo,text=True) if mode=='full-before' else (repo/file).read_text()
statements=[s.strip() for s in re.findall(r'`([^`]+)`',text,re.S) if re.match(r'\s*CREATE\s+(TABLE|INDEX)',s)]
result={'mode':mode,'sqlite':sqlite3.sqlite_version,'backup':str(source),'preparation':[],'ddl':[]}
names={r[0] for r in con.execute('SELECT name FROM sqlite_schema')}
if mode!='full-before':
    for table in ['ardud_kanban_cards','ardud_kanban_card_events','ardud_kanban_discussions']:
        missing=any((m:=re.match(r'CREATE INDEX IF NOT EXISTS (\w+)\s+ON (\w+)',s)) and m[2]==table and m[1] not in names for s in statements)
        if table in names and missing:
            t=time.monotonic();con.execute(f"SELECT sum(length(json || '')) FROM {table} NOT INDEXED").fetchone()
            row={'table':table,'seconds':time.monotonic()-t,'transaction':con.in_transaction};result['preparation'].append(row);print(json.dumps(row),flush=True)
for statement in statements:
    m=re.match(r'CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)',statement)
    assert m
    if m[1] in names: continue
    t=time.monotonic();con.execute(statement);con.commit()
    row={'name':m[1],'seconds':time.monotonic()-t,'sql':statement};result['ddl'].append(row);print(json.dumps(row),flush=True)
(root/f'{mode}-boards-schema.json').write_text(json.dumps(result,indent=2)+'\n')
con.close();sentinel.close()
PY
python3 -I /Volumes/ExternalSSD/tmp/068-index-cost.ig6US8Y9/time-boards-schema.py full-before
python3 -I /Volumes/ExternalSSD/tmp/068-index-cost.ig6US8Y9/time-boards-schema.py full-after