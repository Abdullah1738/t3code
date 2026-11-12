mkdir -p tmp/card-3057-evidence
cat > tmp/card-3057-evidence/check_test_ids.py <<'PY'
from pathlib import Path
from collections import Counter
import re,subprocess
p=Path('binaries/registry/TDD.md')
s=p.read_text()
bullets=[l for l in s.splitlines() if l.startswith('- ')]
ids=[]
for l in bullets:
 m=re.match(r'^- ([A-Z][A-Z0-9]*-[0-9]{3}): ',l)
 assert m, l
 ids.append(m[1])
assert all(n==1 for n in Counter(ids).values()), 'duplicate ID'
base=subprocess.check_output(['git','show','7e68a12d:'+str(p)],text=True)
base_ids=set(re.findall(r'^- ([A-Z][A-Z0-9]*-[0-9]{3}): ',base,re.M))
assert set(ids)-base_ids=={'REGTL-052','REGTL-053','REGTL-054'}
for l in bullets:
 if l.startswith(('- REGTL-052:', '- REGTL-053:', '- REGTL-054:')):
  assert re.fullmatch(r'- REGTL-\d{3}: Ensures that .+ meets .+ constraints per .+',l),l
print(f'PASS: {len(ids)} Registry test IDs have strict PREFIX-NNN format and are unique; REGTL-052..054 are new and follow the strict checklist sentence format.')
PY
python3 tmp/card-3057-evidence/check_test_ids.py
git diff --check
git diff --binary > tmp/card-3057-evidence/candidate.patch
git add -- 'binaries/registry/Data Models.md' binaries/registry/Deployment.md binaries/registry/Events.md binaries/registry/Lifecycle.md binaries/registry/TDD.md tmp/changelog/pending.yml
git write-tree