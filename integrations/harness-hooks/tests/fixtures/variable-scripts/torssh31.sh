python3 - <<'PY'
import hashlib,json,re,subprocess
from pathlib import Path
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
p=Path('tmp/vault-native/build-final.sh')
s=p.read_text();s,n=re.subn(r'^expected=[0-9a-f]{40}$','expected='+head,s,flags=re.M);assert n==1;p.write_text(s)
p=Path('tmp/vault-native/formal-inputs.json');r=json.loads(p.read_text())
for item in r['inputs']:
 old=subprocess.check_output(['git','show',r['formalHead']+':'+item['path']]);new=subprocess.check_output(['git','show',head+':'+item['path']]);assert old==new and hashlib.sha256(new).hexdigest()==item['sha256'],item['path']
r['buildHead']=head;r['buildSpecsTree']=subprocess.check_output(['git','rev-parse',head+':specs'],text=True).strip();r['diffStat']=subprocess.check_output(['git','diff','--stat',r['formalHead'],head,'--',*[i['path'] for i in r['inputs']]],text=True);assert not r['diffStat'];p.write_text(json.dumps(r,indent=2)+'\n')
print('PASS exact-headguard/formal80manifest updated to',head)
PY
python3 tmp/vault-native/derive-gates.py
for file in native/scripts/bootstrap-tools.sh native/ssh/build.sh native/tests/build-ssh-host.sh native/tests/build-rekey-server.sh tmp/vault-native/build-final.sh; do bash -n "$file"; done
git status --short
