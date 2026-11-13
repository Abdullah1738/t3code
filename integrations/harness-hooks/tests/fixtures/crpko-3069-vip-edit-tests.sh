python3 - <<'PY'
from pathlib import Path
import subprocess,json
p=Path('terraform/modules/runtime-access-policies/main.tf');p.write_bytes(subprocess.check_output(['git','show','HEAD:'+str(p)]))
p=Path('scripts/test-seed-registry-vip-tiers.mjs');s=p.read_text().replace(', freshV1Generation: true','').replace('(m) => { m.fee_v2_active = true; }','(m) => { m.fee_v2_active = false; }').replace(', { freshV1Generation: false }','');s=s.replace('    if (service === "sts")', '''    if (service === "kafka") {
      if (state.v2 === "denied") throw new Error("AccessDenied");
      return { topic: "evt.registry.vip_tier.updated.v2", partitions: state.v2 ? 6 : 12 };
    }
    if (service === "sts")''');s=s.replace('v2 presence and unprovable v2 absence','wrong partition count and unreadable Kafka metadata');p.write_text(s)
p=Path('scripts/test-rewards-vip-admission.mjs');s=p.read_text().replace(', "v2", "v2-building", "v2-denied"','');s+='''\ntest("native admission ignores obsolete additive table sentinels", () => {
  for (const scenario of ["v2", "v2-building", "v2-denied"]) assert.equal(check(vipFixture(scenario)).runtime_acceptance, false);
});
''';p.write_text(s)
p=Path('scripts/runbooks/dev-vip-baseline.md');s=p.read_text();a=s.index('- Use only');b=s.index('- H1',a);s=s[:a]+'''- Use only for an explicitly approved **dev native rebuild bootstrap**. The
  table has HASH `vip_tier_id:S` only. `sk_effective_version` is an ordinary `N`
  attribute, computed exactly as `effective_from_ms * 1000000 + version`.
- Registry requires `registry_entity_revisions`, HASH `pk:S`, with numeric
  `revision=1` and operation `updated_at_ms` per `registry_vip_tiers#VIP_n`.
  All three business rows and all three companion rows commit in one transaction.
- Keep every VIP/revision writer excluded and drained through final readback.
  DynamoDB has no table-empty transaction condition; the confirmation flag
  acknowledges externally enforced exclusion. Never reset existing revision heads.
- The live checks require `evt.registry.vip_tier.updated.v2` with exactly 12
  partitions. Run from a host with private Kafka access and `kafka-topics.sh`,
  passing `--bootstrap-server "$KAFKA_BOOTSTRAP_SERVERS" --command-config
  "$KAFKA_COMMAND_CONFIG"` to inspect, apply and verify. The command config
  contains the environment's authenticated Kafka client settings.
'''+s[b:];s=s.replace(' --confirm-fresh-v1-generation','').replace('legacy-v1','exact-row-v2').replace('fee-v2 activator','VIP writer');p.write_text(s)
p=Path('package.json');d=json.loads(p.read_text());d['scripts']['deploy:registry-fee-vip-publish']='node scripts/run-registry-fee-vip-publish-release.mjs';d['scripts']['test']=d['scripts']['test'].replace('scripts/test-run-registry-resync-release.mjs','scripts/test-run-registry-resync-release.mjs scripts/test-run-registry-fee-vip-publish-release.mjs');p.write_text(json.dumps(d,indent=2)+'\n')
PY
node scripts/generate-kafka-acl-manifest.mjs > tmp/fee-vip-3069/acl.log
node scripts/generate-kafbat-config.mjs > tmp/fee-vip-3069/kafbat.log
node scripts/test-seed-registry-vip-tiers.mjs > tmp/fee-vip-3069/seed-test.log 2>&1
node scripts/test-rewards-vip-admission.mjs > tmp/fee-vip-3069/admission-test.log 2>&1