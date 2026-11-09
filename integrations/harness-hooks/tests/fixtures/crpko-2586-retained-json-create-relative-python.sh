cat > tmp/card2586/replay.py <<'PY'
import sys,json,datetime as dt
from pathlib import Path
sys.path.insert(0,'/Volumes/ExternalSSD/crpko-devops/tmp/board-scripts')
import bstack,kafka_maint as km
root=Path('/Volumes/ExternalSSD/crpko-devops')
groups=json.loads((root/'tmp/card2540/logs/normalized-groups.json').read_text())
rows=json.loads((root/'tmp/card2540/logs/error-rows.json').read_text())['rows']
target=set('bs-38d5151719 bs-235c8e1cda bs-b86c1c161a bs-fe979beec8 bs-c25e1294e2 bs-8e3ad0764e bs-5e9937ca86 bs-eb11996584 bs-80d85fd9a7 bs-59e1b01d9a bs-e31a0648c1 bs-9f99491117'.split())
w=[(km._utc('2026-11-05T19:56:00Z'),km._utc('2026-11-05T20:06:00Z')+120,'#2478 replay')]
# Shapes are normalized/truncated. Recover original messages from retained rows,
# matching service, normalized shape and stream; do not fabricate error codes.
results=[]
for g in groups:
 if g['token'] not in target: continue
 matches=[]
 for r in rows:
  try: body=json.loads(r['body'])
  except (TypeError,ValueError): continue
  msg=body.get('message','')
  if body.get('service')==g['service'] and bstack.norm(msg)==g['shape'] and r['stream'] in g['streams']:
   matches.append(body)
 if not matches: raise SystemExit('unmappable: '+g['token'])
 it=dict(kind='log',lvl=max((b.get('level','').upper() for b in matches),key=lambda l:bstack.LVL_RANK.get(l,0)),svc=g['service'],msg=matches[0]['message'],
         first=dt.datetime.fromisoformat(g['first']).replace(tzinfo=dt.timezone.utc).timestamp(),last=dt.datetime.fromisoformat(g['last']).replace(tzinfo=dt.timezone.utc).timestamp(),
         kafka_maint_match=all(km.message_matches(g['service'],b['message']) for b in matches))
 results.append(dict(token=g['token'],result='skipped' if km.skip_reason(it,w,bstack.DEFAULTS) else 'kept',original_rows=len(matches)))
assert len(results)==12
skipped={r['token'] for r in results if r['result']=='skipped'}
assert skipped==target-{'bs-59e1b01d9a','bs-e31a0648c1','bs-9f99491117'},results
print(json.dumps(results,indent=2));print('PASS: exactly 9 skipped, 3 kept; no live maintenance file created')
PY
python3 tmp/card2586/replay.py > tmp/card2586/replay.log
cat tmp/card2586/replay.log