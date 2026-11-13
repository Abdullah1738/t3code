python3 - <<'PY'
from pathlib import Path
import json,subprocess,re
p=Path('plan/devops-terraform-build-spec.json')
s=subprocess.check_output(['git','show',f'HEAD:{p}'],text=True)
for env in ('dev','staging'):
    rel=f'appconfig/initial/{env}/global.json'
    pattern=r'(?m)^(\s*'+re.escape(json.dumps(rel))+r': )"(?:[^"\\]|\\.)*"(,?)$'
    matches=list(re.finditer(pattern,s))
    assert len(matches)==1
    old_line=matches[0].group()
    old_flag=r'\"withdrawals_enabled\": true'
    new_flag=r'\"withdrawals_enabled\": false'
    assert old_line.count(old_flag)==1
    s=s[:matches[0].start()]+old_line.replace(old_flag,new_flag,1)+s[matches[0].end():]
p.write_text(s)
p=Path('scripts/test-appconfig-profile-schemas.mjs')
s=subprocess.check_output(['git','show',f'HEAD:{p}'],text=True)
main=Path('/Users/ardud/checkouts/crpko-devops-wdflag',p).read_text()
start=main.index('test("initial global withdrawals stay disabled')
end=main.index('test("required JSON properties',start)
anchor='test("required JSON properties must be own properties, including nested profiles", () => {'
assert s.count(anchor)==1
p.write_text(s.replace(anchor,main[start:end]+anchor,1))
PY
 git add plan/devops-terraform-build-spec.json scripts/test-appconfig-profile-schemas.mjs && git diff --cached --check && git diff --cached --stat && git write-tree && node scripts/validate-plan-package.mjs plan > /Volumes/ExternalSSD/crpko-devops/tmp/card2422-native-validate.log 2>&1
result=$?
tail -9 /Volumes/ExternalSSD/crpko-devops/tmp/card2422-native-validate.log
exit $result