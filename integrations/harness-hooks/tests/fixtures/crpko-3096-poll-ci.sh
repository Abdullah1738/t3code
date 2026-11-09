cat > tmp/vector-dl-3096/poll-ci.py <<'PY'
import json, subprocess, pathlib, datetime
root=pathlib.Path(__file__).parent
for label,rid in [('native-v1',42472208170),('main-dev',42472278817)]:
    r=subprocess.run(['gh','api',f'repos/Equicom-Crypto/crpko-devops/actions/runs/{rid}/jobs?per_page=100'],text=True,capture_output=True,check=True)
    data=json.loads(r.stdout)
    (root/f'{label}-jobs.json').write_text(json.dumps(data,indent=2))
    jobs=[j for j in data['jobs'] if j['conclusion']!='skipped']
    result={'branch':label,'run':rid,'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'success':[j['name'] for j in jobs if j['conclusion']=='success'],'failed':[{ 'id':j['id'],'name':j['name'],'steps':[s['name'] for s in j['steps'] if s['conclusion']=='failure']} for j in jobs if j['conclusion'] in ('failure','cancelled','timed_out')],'running':[{'name':j['name'],'current':[s['name'] for s in j['steps'] if s['status']=='in_progress']} for j in jobs if j['status']!='completed'],'vector_success':sum(any(s['name']=='Install pinned Vector VRL test runtime' and s['conclusion']=='success' for s in j['steps']) for j in jobs)}
    print(json.dumps(result))
PY
python3 tmp/vector-dl-3096/poll-ci.py