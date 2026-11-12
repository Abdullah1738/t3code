cat > scripts/test-breakglass-alert-infra.mjs <<'EOF'
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveEnvironment } from "./lib/environments.mjs";
import { hclAttributeIs, hclAttributes, hclBlocks, hclParse } from "./lib/hcl-body.mjs";
import { activeBlockSource, cutoverDenyAttachmentBlock, cutoverDenySimulationBlock, loadTerraformFiles, moduleRoleCoverageErrors } from "./lib/cutover-command-deny-coverage.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const modulePath = "terraform/modules/infra-log-coverage";
const rule = "aws_cloudwatch_event_rule.breakglass_assume_role";
const globalRule = `${rule}_global`;
const role = "aws_iam_role.breakglass_alert_forwarder";
const policy = "aws_iam_role_policy.breakglass_alert_forwarder";
const target = "aws_cloudwatch_event_target.breakglass_home_bus";
const logsTarget = "aws_cloudwatch_event_target.breakglass_logs";
const group = "aws_cloudwatch_log_group.breakglass_assume_role";
const filter = "aws_cloudwatch_log_metric_filter.breakglass_admin_assume_total";
const alarm = "aws_cloudwatch_metric_alarm.breakglass_assume_role";
const get = (render, address) => render.resources[`${address}[0]`];
const arn = (r, service, suffix, region = r.region) => `arn:aws:${service}:${region}:${r.account}:${suffix}`;
const expectedPattern = (r) => ({ source: ["aws.sts"], "detail-type": ["AWS API Call via CloudTrail"], detail: { eventName: ["AssumeRole"], requestParameters: { roleArn: [arn(r, "iam", `role/crpko-${r.env}-breakglass-admin`, "")] } } });
const block = (source, type, ...labels) => {
  const blocks = hclBlocks(hclParse(source), type, ...labels);
  assert.equal(blocks.length, 1, `${type} ${labels.join(".")} must exist exactly once`);
  return blocks[0].body;
};
const attr = (body, name, value) => assert.ok(hclAttributeIs(body, name, value), `${name} must equal ${value}`);

// Terraform evaluates the actual module, with both providers mocked. No AWS
// credentials, backend or network API calls participate in these plans.
function renderModule(t) {
  mkdirSync(join(root, "tmp"), { recursive: true });
  const cwd = mkdtempSync(join(root, "tmp/breakglass-alert-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  cpSync(join(root, modulePath), cwd, { recursive: true, filter: (p) => !/[\\/]\.terraform(\.lock\.hcl)?$/.test(p) });
  cpSync(join(root, "terraform/roots/dev/.terraform.lock.hcl"), join(cwd, ".terraform.lock.hcl"));
  mkdirSync(join(cwd, "tests"), { recursive: true });
  const contexts = ["dev", "staging", "prod"].map((env, i) => {
    const { config } = resolveEnvironment(env, { repoRoot: root });
    // Staging/prod account IDs are intentionally unset until account creation.
    return { env, region: config.aws.region, account: /^\d{12}$/.test(config.aws.accountId) ? config.aws.accountId : `11112222333${i}` };
  });
  for (const r of contexts) {
    const vars = {
      enabled: true, environment: r.env, aws_region: r.region, aws_account_id: r.account,
      vpc_id: "vpc-12345678", kms_key_arns: { logs: arn(r, "kms", "key/00000000-0000-4000-8000-000000000001") }, tags: {},
      alarm_topic_arns: { sev1: arn(r, "sns", `crpko-${r.env}-cloudwatch-alarms-sev1`), sev2: arn(r, "sns", `crpko-${r.env}-cloudwatch-alarms-sev2`) },
      cutover_command_deny_policy_arn: arn(r, "iam", `policy/crpko-${r.env}-cutover-command-deny`, ""), cutover_command_deny_simulation_enabled: false,
    };
    writeFileSync(join(cwd, `tests/${r.env}.tftest.hcl`), `mock_provider "aws" {
  override_during = plan
  mock_resource "aws_iam_role" { defaults = { arn = ${JSON.stringify(arn(r, "iam", `role/crpko-${r.env}-breakglass-alert-forwarder`, ""))} } }
  mock_resource "aws_cloudwatch_log_group" { defaults = { arn = ${JSON.stringify(arn(r, "logs", `log-group:/aws/events/crpko-${r.env}-breakglass-assume-role`))} } }
}
mock_provider "aws" {
  alias = "global"
  override_during = plan
}
variables ${JSON.stringify(vars)}
run "${r.env}" { command = plan }
run "disabled" {
  command = plan
  variables { enabled = false }
}
`);
  }
  const cliConfig = join(cwd, "terraform.rc");
  writeFileSync(cliConfig, `disable_checkpoint = true\n${process.env.TERRAFORM_PROVIDER_MIRROR ? `provider_installation { filesystem_mirror { path = ${JSON.stringify(resolve(process.env.TERRAFORM_PROVIDER_MIRROR))} } }` : ""}\n`);
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    TF_CLI_CONFIG_FILE: cliConfig, TF_DATA_DIR: join(cwd, "data"),
    TF_IN_AUTOMATION: "1", TF_INPUT: "0", CHECKPOINT_DISABLE: "1", AWS_EC2_METADATA_DISABLED: "true",
    ...(process.env.TF_PLUGIN_CACHE_DIR ? { TF_PLUGIN_CACHE_DIR: process.env.TF_PLUGIN_CACHE_DIR } : {}),
  };
  const tf = (args) => {
    const result = spawnSync(process.env.TERRAFORM_BINARY || "terraform", args, { cwd, env, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  tf(["init", "-backend=false", "-input=false", "-no-color"]);
  const events = tf(["test", "-json", "-verbose", "-no-color"]).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const plans = events.filter((event) => event.test_plan);
  for (const event of plans.filter((e) => e["@testrun"] === "disabled")) {
    assert.deepEqual(event.test_plan.resource_changes ?? [], [], "disabled module creates no resources");
  }
  return contexts.map((r) => {
    const plan = plans.find((e) => e["@testrun"] === r.env)?.test_plan;
    assert.ok(plan, `${r.env} Terraform plan missing`);
    return { ...r, resources: Object.fromEntries(plan.resource_changes.map((v) => [v.address, v.change.after])), source: read(`${modulePath}/breakglass.tf`), rootSource: read(`terraform/roots/${r.env}/main.tf`) };
  });
}

const checks = {
  1(r) {
    for (const address of [rule, globalRule]) {
      assert.equal(get(r, address)?.name, `crpko-${r.env}-breakglass-assume-role`);
      assert.deepEqual(JSON.parse(get(r, address).event_pattern), expectedPattern(r));
    }
    const call = block(r.rootSource, "module", "infra_log_coverage");
    attr(call, "environment", "local.environment");
    attr(call, "aws_region", "local.env_config.aws.region");
    attr(call, "aws_account_id", "local.env_config.aws.accountId");
    attr(call, "enabled", "local.aws_account_id_is_real && var.aws_endpoint_url == null");
    attr(call, "providers", "{ aws = aws, aws.global = aws.global }");
    attr(block(r.source, "resource", "aws_cloudwatch_event_rule", "breakglass_assume_role_global"), "provider", "aws.global");
    const aws = block(read(`${modulePath}/versions.tf`), "terraform").blocks[0].body;
    assert.match(hclAttributes(aws, "aws")[0], /configuration_aliases=\[aws.global\]/);
  },
  2(r) {
    const t = get(r, target);
    assert.equal(t.arn, arn(r, "events", "event-bus/default"));
    assert.equal(t.rule, get(r, globalRule).name);
    assert.equal(t.role_arn, get(r, role).arn);
    attr(block(r.source, "resource", "aws_cloudwatch_event_target", "breakglass_home_bus"), "provider", "aws.global");
    assert.equal(get(r, logsTarget).rule, get(r, rule).name);
    assert.equal(get(r, logsTarget).arn, get(r, group).arn);
    const logPolicy = JSON.parse(get(r, "aws_cloudwatch_log_resource_policy.events_to_logs").policy_document);
    assert.ok(logPolicy.Statement.some((s) => s.Principal.Service === "events.amazonaws.com" && s.Action.includes("logs:PutLogEvents") && s.Action.includes("logs:CreateLogStream") && s.Resource.includes(`${get(r, group).arn}:*`)));
  },
  3(r) {
    assert.equal(get(r, filter).log_group_name, get(r, group).name);
    assert.equal(get(r, group).name, `/aws/events/crpko-${r.env}-breakglass-assume-role`);
    assert.equal(get(r, filter).pattern, "");
    const metric = get(r, filter).metric_transformation[0];
    assert.equal(metric.value, "1");
    const pattern = JSON.parse(get(r, rule).event_pattern);
    const count = (event) => matches(pattern, event) && get(r, filter).pattern === "" ? Number(metric.value) : 0;
    assert.equal(count(fixture(r)), 1);
    assert.equal(count(fixture(r, "AccessDenied")), 1);
    const other = fixture(r); other.detail.requestParameters.roleArn = arn(r, "iam", `role/crpko-${r.env}-gha-apply`, "");
    assert.equal(count(other), 0);
  },
  4(r) {
    const a = get(r, alarm), m = get(r, filter).metric_transformation[0];
    const sev1 = arn(r, "sns", `crpko-${r.env}-cloudwatch-alarms-sev1`);
    assert.deepEqual(a.alarm_actions, [sev1]); assert.deepEqual(a.ok_actions, [sev1]);
    assert.equal(a.alarm_name, `crpko-${r.env}-breakglass-assume-role`);
    assert.match(a.alarm_description, /Sev1.*crpko-oncall-sev1/);
    assert.deepEqual([a.metric_name, a.namespace], [m.name, m.namespace]);
    assert.deepEqual([a.statistic, a.threshold, a.comparison_operator, a.period, a.evaluation_periods, a.datapoints_to_alarm, a.treat_missing_data], ["Sum", 1, "GreaterThanOrEqualToThreshold", 60, 1, 1, "notBreaching"]);
    attr(block(r.rootSource, "module", "infra_log_coverage"), "alarm_topic_arns", "module.cloudwatch_alarm_routes.topic_arns");
  },
  5(r) {
    assert.equal(get(r, role).name, `crpko-${r.env}-breakglass-alert-forwarder`);
    assert.deepEqual(JSON.parse(get(r, role).assume_role_policy), { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": r.account }, ArnEquals: { "aws:SourceArn": arn(r, "events", `rule/crpko-${r.env}-breakglass-assume-role`, "us-east-1") } } }] });
  },
  6(r) {
    const p = JSON.parse(get(r, policy).policy), bus = arn(r, "events", "event-bus/default");
    assert.deepEqual(p, { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "events:PutEvents", Resource: bus }] });
    assert.equal(decision(p, "events:PutEvents", bus), "allowed");
    for (const resource of [arn(r, "events", "event-bus/custom"), arn(r, "events", "event-bus/default", "us-east-1")]) assert.equal(decision(p, "events:PutEvents", resource), "implicitDeny");
    assert.equal(decision(p, "events:PutRule", bus), "implicitDeny");
  },
  7(r) {
    for (const [type, text] of [["resource", cutoverDenyAttachmentBlock("breakglass_alert_forwarder", "count")], ["data", cutoverDenySimulationBlock("breakglass_alert_forwarder", "count")]]) {
      const kind = type === "resource" ? "aws_iam_role_policy_attachment" : "aws_iam_principal_policy_simulation";
      assert.equal(activeBlockSource(r.source, type, kind, "cutover_command_deny_breakglass_alert_forwarder"), text);
    }
    assert.equal(get(r, "aws_iam_role_policy_attachment.cutover_command_deny_breakglass_alert_forwarder").policy_arn, arn(r, "iam", `policy/crpko-${r.env}-cutover-command-deny`, ""));
    const files = loadTerraformFiles(root); files.set(`${modulePath}/breakglass.tf`, r.source);
    assert.deepEqual(moduleRoleCoverageErrors(files), []);
  },
};

function matches(pattern, event) {
  if (Array.isArray(pattern)) return pattern.includes(event);
  return event !== null && typeof event === "object" && Object.entries(pattern).every(([key, value]) => matches(value, event[key]));
}
function decision(policy, action, resource) {
  const match = (p, s) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "i").test(s);
  const applies = (s) => [].concat(s.Action).some((p) => match(p, action)) && [].concat(s.Resource).some((p) => match(p, resource));
  if (policy.Statement.some((s) => s.Effect === "Deny" && applies(s))) return "explicitDeny";
  return policy.Statement.some((s) => s.Effect === "Allow" && applies(s)) ? "allowed" : "implicitDeny";
}
function fixture(r, errorCode) {
  return { version: "0", id: "f0b20a00-0000-4000-8000-000000000001", account: r.account, time: "2026-11-08T00:00:00Z", region: r.region, resources: [], source: "aws.sts", "detail-type": "AWS API Call via CloudTrail", detail: { eventSource: "sts.amazonaws.com", eventName: "AssumeRole", requestParameters: { roleArn: expectedPattern(r).detail.requestParameters.roleArn[0] }, ...(errorCode ? { errorCode } : {}) } };
}
const mutateJson = (r, address, key, fn) => { const p = JSON.parse(get(r, address)[key]); fn(p); get(r, address)[key] = JSON.stringify(p); };
const negatives = [
  ["missing role ARN", 1, (r) => mutateJson(r, rule, "event_pattern", (p) => delete p.detail.requestParameters.roleArn)],
  ["role wildcard", 1, (r) => mutateJson(r, rule, "event_pattern", (p) => p.detail.requestParameters.roleArn = [{ wildcard: `arn:aws:iam::${r.account}:role/crpko-${r.env}-*` }])],
  ["missing global rule", 1, (r) => delete r.resources[`${globalRule}[0]`]],
  ["missing target role", 2, (r) => delete get(r, target).role_arn],
  ["Sev2 alarm", 4, (r) => get(r, alarm).alarm_actions = [arn(r, "sns", `crpko-${r.env}-cloudwatch-alarms-sev2`)]],
  ["missing trust source ARN", 5, (r) => mutateJson(r, role, "assume_role_policy", (p) => delete p.Statement[0].Condition.ArnEquals)],
  ["trust rule wildcard", 5, (r) => mutateJson(r, role, "assume_role_policy", (p) => p.Statement[0].Condition.ArnEquals["aws:SourceArn"] = arn(r, "events", "rule/*", "us-east-1"))],
  ...["event-bus/*", "*"].map((resource) => [`policy ${resource}`, 6, (r) => mutateJson(r, policy, "policy", (p) => p.Statement[0].Resource = resource === "*" ? "*" : arn(r, "events", resource))]),
  ["extra PutRule", 6, (r) => mutateJson(r, policy, "policy", (p) => p.Statement[0].Action = ["events:PutEvents", "events:PutRule"])],
  ["missing Deny attachment", 7, (r) => r.source = r.source.replace(cutoverDenyAttachmentBlock("breakglass_alert_forwarder", "count"), "")],
  ["missing simulation", 7, (r) => r.source = r.source.replace(cutoverDenySimulationBlock("breakglass_alert_forwarder", "count"), "")],
];

test("breakglass alert routes and forwarder permissions", { timeout: 900_000 }, async (t) => {
  const renders = renderModule(t);
  const purposes = ["exact role selection in both regions", "cross-region delivery and Logs access", "successful and denied assumes count; CI role excluded", "Sev1 alarm and recovery route", "trust bound to source account and exact rule", "forwarder can publish only to the home default bus", "cutover Deny attachment and three-document proof"];
  for (const r of renders) {
    for (const [i, purpose] of purposes.entries()) await t.test(`${r.env}: ${i + 1} ${purpose}`, () => checks[i + 1](r));
    for (const [name, check, mutate] of negatives) await t.test(`${r.env}: rejects ${name} (assert ${check})`, () => {
      const copy = structuredClone(r); mutate(copy);
      assert.notDeepEqual(copy, r, "fixture mutation must change the render");
      assert.throws(() => checks[check](copy), assert.AssertionError);
    });
  }
});
EOF
node scripts/test-breakglass-alert-infra.mjs > /tmp/crp12001-fb2a-test.log 2>&1