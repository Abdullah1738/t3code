import json
from pathlib import Path

r = Path('/Volumes/ExternalSSD/crpko-devops/tmp/card-3226')
s = (r / 'merge-740-offbox.log').read_text()
for line in s.splitlines():
    if 'assertions' in line or 'offbox step 2' in line:
        print(line[:1800])
p = r / 'merge-740-record/facts.json'
f = json.loads(p.read_text())
f['current_tests_pending'] = False
command = '''offbox run --include tmp/install-card-3226-terraform.sh --step 'bash tmp/install-card-3226-terraform.sh' --step 'export PATH="$HOME/.local/bin:$PATH"; node --test scripts/test-terraform-pr-plan-gate.mjs scripts/test-guard-foundationdb-explorer-infra-plan.mjs scripts/test-coord-pending-infra-scope.mjs scripts/test-dev-claim.mjs scripts/test-kafka-oneoff-scram-roles.mjs scripts/test-execution-secret-capacity.mjs scripts/test-github-plan-describe-policy.mjs' --step 'ruby scripts/test-workflow-yaml.rb' --step 'node scripts/validate-plan-package.mjs' '''.strip()
f['current_tests'].extend([
    {'command': command, 'result': 'Remote exit 0. All 4 steps passed, 0 failed. 716 Node tests passed, 0 failed. Ruby workflow YAML passed. Plan-package validator passed with existing warnings.', 'log': str(r / 'merge-740-offbox.log')},
    {'command': 'git diff --cached --check', 'result': 'Passed.'},
])
p.write_text(json.dumps(f, indent=2) + '\n')
