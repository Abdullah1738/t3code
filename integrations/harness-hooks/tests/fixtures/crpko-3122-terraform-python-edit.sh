python3 - <<'PY'
from pathlib import Path
p=Path('terraform/modules/environment-iam-roles/main.tf')
s=p.read_text(); assert s.count('"aws:RequestTag/incident_ref" = "*"')==2
p.write_text(s.replace('"aws:RequestTag/incident_ref" = "*"','"aws:RequestTag/incident_ref" = "?*"'))
p=Path('scripts/test-breakglass-ci-role-recovery.mjs'); s=p.read_text()
s=s.replace('import { readFileSync } from "node:fs";', 'import { spawnSync } from "node:child_process";\nimport { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";')
s=s.replace('import test from "node:test";', 'import test from "node:test";\nimport { runInNewContext } from "node:vm";\nimport { extractModule } from "./lib/iam-loopback.mjs";')
s += '''
// Render the module's active HCL, rather than the role template it overrides.
// No provider or AWS credentials are needed to evaluate these locals.
test("rendered human trusts reject empty breakglass incident tags only", { timeout: 120_000 }, (t) => {
  mkdirSync(resolve(root, "tmp"), { recursive: true });
  const cwd = mkdtempSync(resolve(root, "tmp/breakglass-trust-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const module = extractModule("environment-iam-roles", [["locals"]]);
  writeFileSync(resolve(cwd, "variables.tf"), module.variables);
  writeFileSync(resolve(cwd, "fixture.auto.tfvars.json"), JSON.stringify({
    enabled: true, package_root: resolve(root, "plan"), environment: "dev",
    aws_account_id: "123456789012", aws_region: "ap-south-1", identity_account_id: "123456789012",
    human_sso_principal_arn_patterns: ["arn:aws:iam::123456789012:role/AWSReservedSSO_*"],
    human_bootstrap_principal_arns: ["arn:aws:iam::123456789012:user/bootstrap"],
    human_bootstrap_external_id: "fixture-external-id",
  }));
  const render = (source) => {
    writeFileSync(resolve(cwd, "main.tf"), source);
    const result = spawnSync(process.env.TERRAFORM_BINARY || "terraform", ["console", "-no-color"], {
      cwd, input: 'jsonencode({for key, spec in local.role_specs : key => spec.assume_role_policy if spec.category == "human-role"})\\n',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" },
      encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return JSON.parse(JSON.parse(result.stdout.trim()));
  };
  const smoke = read("scripts/localstack-environment-smoke.mjs");
  const evaluateTrustPolicy = runInNewContext([
    "toArray", "wildcardMatch", "conditionMatches", "principalMatches", "trustStatementMatches", "evaluateTrustPolicy",
  ].map((name) => {
    const source = smoke.match(new RegExp(`^function ${name}\\\\([^]*?^}`, "m"));
    assert.ok(source, `missing IAM decision function ${name}`);
    return source[0];
  }).join("\\n") + "\\nevaluateTrustPolicy;");
  const assertBreakglass = (trust) => {
    assert.deepEqual(trust.Statement.map((s) => s.Sid), ["IdentityCenterHumanAccess", "TemporaryBootstrapHumanAccess"]);
    for (const statement of trust.Statement) {
      const sso = statement.Sid === "IdentityCenterHumanAccess";
      const principal = sso ? "arn:aws:iam::123456789012:role/AWSReservedSSO_Breakglass" : "arn:aws:iam::123456789012:user/bootstrap";
      const context = {
        "aws:PrincipalArn": principal, "aws:MultiFactorAuthPresent": "true",
        "sts:ExternalId": "fixture-external-id", "aws:TagKeys": ["incident_ref"],
      };
      assert.equal(statement.Condition.Bool["aws:MultiFactorAuthPresent"], "true");
      assert.deepEqual(statement.Condition["ForAllValues:StringEquals"], { "aws:TagKeys": ["incident_ref"] });
      if (!sso) assert.equal(statement.Condition.StringEquals["sts:ExternalId"], "fixture-external-id");
      for (const action of ["sts:AssumeRole", "sts:TagSession"]) {
        for (const [value, expected] of [["", "implicitDeny"], ["INC-1", "allowed"], [undefined, "implicitDeny"]]) {
          const request = value === undefined ? context : { ...context, "aws:RequestTag/incident_ref": value };
          assert.equal(evaluateTrustPolicy({ Statement: [statement] }, action, principal, request), expected,
            `${statement.Sid} ${action} incident_ref=${JSON.stringify(value)}`);
        }
      }
      assert.deepEqual(statement.Condition.StringLike, { "aws:RequestTag/incident_ref": "?*" });
    }
  };
  const assertOrdinary = (trust) => {
    for (const statement of trust.Statement) {
      assert.ok(!Object.values(statement.Condition).some((entries) => "aws:RequestTag/incident_ref" in entries),
        "ordinary human trust must have no incident_ref condition");
    }
  };
  const trusts = render(module.main);
  assertBreakglass(trusts["crpko-env-breakglass-admin"]);
  for (const [name, trust] of Object.entries(trusts)) {
    if (name !== "crpko-env-breakglass-admin") assertOrdinary(trust);
  }
  // Re-render the old wildcard separately in each trust path.
  const pattern = '"aws:RequestTag/incident_ref" = "?*"';
  const positions = [...module.main.matchAll(/"aws:RequestTag\\/incident_ref" = "\\?\\*"/g)].map((match) => match.index);
  assert.equal(positions.length, 2);
  for (const position of positions) {
    const old = module.main.slice(0, position) + pattern.replace("?*", "*") + module.main.slice(position + pattern.length);
    assert.throws(() => assertBreakglass(render(old)["crpko-env-breakglass-admin"]),
      { code: "ERR_ASSERTION", expected: "implicitDeny", actual: "allowed" });
  }
  const ordinary = structuredClone(trusts["crpko-env-devops-apply"]);
  ordinary.Statement[0].Condition.StringLike = { "aws:RequestTag/incident_ref": "?*" };
  assert.throws(() => assertOrdinary(ordinary), { code: "ERR_ASSERTION" });
});
'''
p.write_text(s)
p=Path('scripts/localstack-environment-smoke.mjs'); s=p.read_text()
needle='''    fs.writeFileSync(path.join(evidenceRoot, "identity-center-trust-decisions.json"), JSON.stringify(humanTrustDecisions, null, 2));'''
assert s.count(needle)==1
s=s.replace(needle,'''    requireTrustDecision(
      observedRoles["crpko-dev-breakglass-admin"].Role.AssumeRolePolicyDocument,
      "crpko-dev-breakglass-admin",
      "sts:TagSession",
      breakglassSsoPrincipalArn,
      "implicitDeny",
      humanTrustDecisions,
      { "aws:PrincipalArn": breakglassSsoPrincipalArn, "aws:MultiFactorAuthPresent": "true", "aws:RequestTag/incident_ref": "", "aws:TagKeys": ["incident_ref"] }
    );
'''+needle)
p.write_text(s)
PY
node scripts/test-breakglass-ci-role-recovery.mjs > tmp/fb2c-focused.log 2>&1