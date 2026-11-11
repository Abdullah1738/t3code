cd /Volumes/ExternalSSD/crpko-devops/tmp/card-3186/repo && git log -5 --oneline origin/main-dev -- terraform/modules/aurora-postgresql/main.tf && gh pr list --repo Equicom-Crypto/crpko-devops --state open --limit 100 --json number,title,headRefName,baseRefName > tmp/evidence/open-prs.json && python3 - <<'PY'
import json
for x in json.load(open('tmp/evidence/open-prs.json')):
 if any(s in x['title'].lower() for s in ['aurora','proxy','rotation','1070','954','1113']):print(x)
PY
 node --test scripts/test-aurora-master-rotation-off.mjs scripts/test-cutover-command-deny-infra.mjs > tmp/evidence/rotation-and-deny.log 2>&1