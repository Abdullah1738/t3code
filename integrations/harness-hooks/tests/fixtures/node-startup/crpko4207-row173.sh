python3 -I - <<'PY'
from pathlib import Path
p=Path('scripts/lib/kafka-membership.mjs')
s=p.read_text().replace('import { createHash }', 'import { kafkaClientAdmission as runtimeAdmission } from "./kafka-client-admission-runtime.mjs";\nimport { createHash }',1)
a=s.index('export function aclReadbackHook('); b=s.index('\nexport function parseCurrentMembership',a)
s=s[:a]+'''export async function aclReadbackHook({ aclManifest, approvalPresent, atBirth = false, binary, principalsDoc, environment, kafkaClientAdmission = runtimeAdmission }) {
  if (!atBirth && aclManifest?.status === "pending-security-approval" && approvalPresent === false) {
    return { status: "PENDING", reason: PENDING_REASON };
  }
  if (!approvalPresent) throw new MembershipError("MEMBERSHIP_ACL_READBACK_MISSING", "at-birth clients require approved ACL evidence");
  const principals = principalsDoc.principals.filter(p => p.binary === binary).map(p => p.name);
  if (!principals.length) throw new MembershipError("MEMBERSHIP_PROBE_MISSING", "binary principal missing");
  try {
    const result = await kafkaClientAdmission({ env: environment, principals, aclManifestDigest: aclManifest.sha256, phase: "membership" });
    if (!result?.evidence_digest || !result.listing_sha256 || !result.readback_at || !result.records?.length) {
      throw Object.assign(new Error("admission result missing"), { code: "KAFKA_PROBE_FAILED" });
    }
    return { status: "PASSED", ...result };
  } catch (error) {
    const codes = { KAFKA_ACL_READBACK_MISSING: "MEMBERSHIP_ACL_READBACK_MISSING", KAFKA_ACL_READBACK_STALE: "MEMBERSHIP_ACL_READBACK_STALE",
      KAFKA_PROBE_MISSING: "MEMBERSHIP_PROBE_MISSING", KAFKA_MANIFEST_MISMATCH: "MEMBERSHIP_DIGEST_MISMATCH" };
    throw new MembershipError(codes[error.code] ?? "MEMBERSHIP_PROBE_FAILED", "principal ACL readback or probe admission refused");
  }
}
''' + s[b:]
s=s.replace('approvalPresent, s3, checkOnly = false }) {','approvalPresent, s3, checkOnly = false, atBirth = false, kafkaClientAdmission }) {')
s=s.replace('const aclReadback = aclReadbackHook({ aclManifest, approvalPresent });', 'const aclReadback = await aclReadbackHook({ aclManifest, approvalPresent, atBirth, binary, principalsDoc: parsePrincipals(principalsText), environment, kafkaClientAdmission });')
p.write_text(s)
p=Path('scripts/compile-kafka-membership.mjs');s=p.read_text().replace('approvalPresent: existsSync(approvalPath),', 'approvalPresent: existsSync(approvalPath),\n      atBirth: env === "dev" || env.startsWith("qa"),');p.write_text(s)
p=Path('scripts/runbooks/clickhouse-canonical-activation.mjs');s=p.read_text();s=s.replace("export function kafkaClientAdmission() { throw Object.assign(new Error('DAZ-4 Kafka client admission is not wired'), {code:'KAFKA_CLIENT_ADMISSION_UNAVAILABLE'}); }", "export { kafkaClientAdmission } from '../lib/kafka-client-admission-runtime.mjs';\nimport { kafkaClientAdmission } from '../lib/kafka-client-admission-runtime.mjs';");p.write_text(s)
PY
 rg -n 'aclReadbackHook' scripts/test-kafka-membership.mjs
 node --check scripts/lib/kafka-membership.mjs
