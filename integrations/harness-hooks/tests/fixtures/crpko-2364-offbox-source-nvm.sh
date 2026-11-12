python3 - <<'PY'
from pathlib import Path
import json,subprocess
p=Path('scripts/test-kafka-contract.mjs');s=p.read_text();old=json.loads(subprocess.check_output(['git','show','HEAD:plan/kafka/self-managed-target.v1.json']));new=json.loads(Path('plan/kafka/self-managed-target.v1.json').read_text())
for env in ['dev','staging','prod']:s=s.replace(old['config_hashes'][env],new['config_hashes'][env])
p.write_text(s)
p=Path('plan/kafka/acl-principals.v1.json');s=p.read_text()
for v in ['shared/Kafka Cluster.md \\u00a74.2','binaries/compliance-kyc/Config.md \\u00a71.3','binaries/market-data/Config.md \\u00a71.3']:s=s.replace(v,v.replace('\\u00a7','§'))
p.write_text(s)
p=Path('terraform/modules/runtime-access-policies/tests/edge_kyc_name_fill.tftest.hcl');s=p.read_text().replace('  kms_key_arns     = {}','''  kms_key_arns     = {}
  dynamodb_table_names = {
    registry_effective_timeline_control = "registry_effective_timeline_control"
    registry_effective_business_history = "registry_effective_business_history"
  }''');p.write_text(s)
PY
node scripts/generate-kafka-acl-manifest.mjs > tmp/card-2364/generate-acl.log
terraform fmt terraform/modules/runtime-access-policies/tests/edge_kyc_name_fill.tftest.hcl
offbox run --step 'source ~/.nvm/nvm.sh && nvm use 24 && node --test scripts/test-kafka-acl-manifest.mjs scripts/test-plan-runtime-env.mjs scripts/test-edge-position-replay-runtime.mjs scripts/test-kafka-contract.mjs' --step 'terraform -chdir=terraform/modules/runtime-access-policies init -backend=false -input=false && terraform -chdir=terraform/modules/runtime-access-policies test -no-color -filter=tests/edge_kyc_name_fill.tftest.hcl' --step 'source ~/.nvm/nvm.sh && nvm use 24 && npm run -s validate:plan && node scripts/generate-kafka-acl-manifest.mjs --check && node scripts/check-kafka-acl-coverage.mjs && node scripts/generate-kafbat-config.mjs --check' > tmp/card-2364/offbox-rerun.log 2>&1