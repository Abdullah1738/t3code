cat > tmp/d4/keep-native-fee-recovery.py <<'PY'
from pathlib import Path
import subprocess
for name in ['scripts/runbooks/clean-registry-snapshot-topics.mjs','scripts/test-clean-registry-snapshot-topics.mjs','scripts/runbooks/registry-snapshot-topic-cleanup.md']:
 s=subprocess.check_output(['git','show',f'220e8bee3:{name}'],text=True)
 s='\n'.join(l for l in s.split('\n') if not any(x in l for x in ['{ table: "registry_fee_schedules",','{ table: "registry_vip_tiers",','["registry_fee_schedules",','["registry_vip_tiers",','- `evt.registry.fee_schedule.updated.v1`','- `evt.registry.vip_tier.updated.v1`']))
 if name.endswith('topics.mjs') and not name.startswith('scripts/test-'):
  s=s.replace('const excludedTopics = ["evt.registry.user_trading_override.updated.v1"];','// Fee/VIP v2 recover through receipt-based fee-replay, never generic resync.\nconst excludedTopics = ["evt.registry.user_trading_override.updated.v1",\n  "evt.registry.fee_schedule.updated.v2", "evt.registry.vip_tier.updated.v2"];')
 elif name.startswith('scripts/test-'):
  s=s.replace('...affected.map(', '...[...affected,\n      ["registry_fee_schedules", "evt.registry.fee_schedule.updated.v2", 12],\n      ["registry_vip_tiers", "evt.registry.vip_tier.updated.v2", 12]\n    ].map(',1)
  n='  assert.ok(evidence.resync_tables.includes("registry_venue_treasury_accounts"));'
  s=s.replace(n,n+'\n  for (const table of ["registry_fee_schedules", "registry_vip_tiers"]) {\n    assert.equal(evidence.resync_tables.includes(table), false);\n  }\n  for (const topic of ["evt.registry.fee_schedule.updated.v2", "evt.registry.vip_tier.updated.v2"]) {\n    assert.equal(evidence.affected_topics.some((t) => t.name === topic), false);\n    assert.ok(evidence.excluded_topics.includes(topic));\n  }')
 else:
  s=s.replace('`14`','`12`').replace('- Neither `affected_topics` nor `resync_tables` includes user trading override.','- Neither `affected_topics` nor `resync_tables` includes user trading override, fee schedules or VIP tiers.')
  s=s.replace('## Preconditions','Fee and VIP v2 feeds are excluded: their native recovery uses the Registry receipt-based `fee-replay` contract in `binaries/registry/Events.md` section 1.6 of the architecture repository. Generic resync cannot republish them. This command never truncates those feeds.\n\n## Preconditions')
 Path(name).write_text(s)
PY
python3 tmp/d4/keep-native-fee-recovery.py
node --test scripts/test-clean-registry-snapshot-topics.mjs > tmp/d4/d5-cleanup-exclusions.log 2>&1