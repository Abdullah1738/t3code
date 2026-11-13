mkdir -p terraform/modules/risk-liquidation-runtime/tests
cat > terraform/modules/risk-liquidation-runtime/tests/kafka-seeds.tftest.hcl <<'EOF'
mock_provider "aws" {}

variables {
  enabled                       = true
  environment                   = "dev"
  aws_region                    = "ap-south-1"
  architecture_docs_version     = "docs75"
  operation_id                  = "risk-kafka-seeds"
  image                         = "123456789012.dkr.ecr.ap-south-1.amazonaws.com/crpko/dev/risk-liquidation@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  git_sha                       = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  cluster_arn                   = "arn:aws:ecs:ap-south-1:123456789012:cluster/crpko-dev"
  capacity_provider_name        = "core"
  app_subnet_ids                = ["subnet-00000000000000001"]
  security_group_id             = "sg-00000000000000001"
  service_discovery_service_arn = "arn:aws:servicediscovery:ap-south-1:123456789012:service/srv-risk"
  execution_role_arn            = "arn:aws:iam::123456789012:role/execution"
  task_role_arn                 = "arn:aws:iam::123456789012:role/risk"
  kms_logs_key_arn              = "arn:aws:kms:ap-south-1:123456789012:key/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  kafka_bootstrap_brokers       = "kafka.dev.crpko.internal:9096"
  runtime_secret_arns = {
    "crpko/dev/kafka/scram/broker"                                  = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:broker-AbCdEf"
    "crpko/dev/internal-auth/backoffice-core-to-risk-liquidation"   = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:internal-AbCdEf"
    "crpko/dev/venue-router/mtls/ca-cert"                           = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:ca-AbCdEf"
    "crpko/dev/venue-router/mtls/client-cert"                       = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:cert-AbCdEf"
    "crpko/dev/venue-router/mtls/client-key"                        = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:key-AbCdEf"
  }
  fdb_cluster_file_parameter_name = "/crpko/dev/fdb/cluster-file"
  fdb_cluster_file_parameter_arn  = "arn:aws:ssm:ap-south-1:123456789012:parameter/crpko/dev/fdb/cluster-file"
  metrics_exporter_enabled       = false
  tags                           = {}
}

run "explicit_client_seeds" {
  command = plan
  variables {
    kafka_client_bootstrap_servers = "kafka.dev.crpko.internal:9096,broker-1.dev.crpko.internal:9096,broker-2.dev.crpko.internal:9096,broker-3.dev.crpko.internal:9096"
  }
  assert {
    condition     = one([for entry in jsondecode(aws_ecs_task_definition.service["risk-liquidation-worker"].container_definitions)[1].environment : entry.value if entry.name == "KAFKA_BOOTSTRAP_BROKERS"]) == var.kafka_client_bootstrap_servers
    error_message = "The worker must receive every client seed in order."
  }
}

run "null_client_seeds" {
  command = plan
  variables {
    kafka_client_bootstrap_servers = null
  }
  assert {
    condition     = one([for entry in jsondecode(aws_ecs_task_definition.service["risk-liquidation-worker"].container_definitions)[1].environment : entry.value if entry.name == "KAFKA_BOOTSTRAP_BROKERS"]) == var.kafka_bootstrap_brokers
    error_message = "Null client seeds must retain the caller's bootstrap list."
  }
}

run "omitted_client_seeds" {
  command = plan
  assert {
    condition     = one([for entry in jsondecode(aws_ecs_task_definition.service["risk-liquidation-worker"].container_definitions)[1].environment : entry.value if entry.name == "KAFKA_BOOTSTRAP_BROKERS"]) == var.kafka_bootstrap_brokers
    error_message = "Existing callers must retain their bootstrap list without a new input."
  }
}
EOF
cat > scripts/test-risk-kafka-seeds-terraform.mjs <<'EOF'
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("Risk worker renders client Kafka seeds and retains the null default", (t) => {
  mkdirSync(join(root, "tmp"), { recursive: true });
  const cwd = mkdtempSync(join(root, "tmp/risk-kafka-seeds-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const module = join(cwd, "risk-liquidation-runtime");
  cpSync(join(root, "terraform/modules/risk-liquidation-runtime"), module, {
    recursive: true,
    filter: (path) => !/[\\/]\.terraform(\.lock\.hcl)?$/.test(path),
  });
  copyFileSync(join(root, "terraform/roots/dev/.terraform.lock.hcl"), join(module, ".terraform.lock.hcl"));
  // Match the dev root's provider constraint when initializing this standalone module.
  writeFileSync(join(module, "versions.tf"), 'terraform { required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } } }\n');
  const env = {
    ...process.env, TF_DATA_DIR: join(cwd, "terraform-data"),
    TF_IN_AUTOMATION: "1", TF_INPUT: "0", CHECKPOINT_DISABLE: "1",
    AWS_EC2_METADATA_DISABLED: "true",
  };
  const run = (args) => spawnSync(process.env.TERRAFORM_BINARY || "terraform", args, {
    cwd: module, env, encoding: "utf8", timeout: 600_000,
  });
  const init = run(["init", "-backend=false", "-input=false", "-no-color"]);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const result = run(["test", "-no-color", `-var=package_root=${join(root, "plan")}`]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
EOF
python3 - <<'PY'
from pathlib import Path
p=Path('package.json');s=p.read_text();needle='scripts/test-risk-pbv2-cutover-tasks-infra.mjs';assert s.count(needle)>=1;s=s.replace(needle,needle+' scripts/test-risk-kafka-seeds-terraform.mjs',1);p.write_text(s)
PY
node --test scripts/test-plan-runtime-env.mjs scripts/test-risk-liquidation-oneoff-tds.mjs > tmp/risk-kafka-focused.log 2>&1
 tail -12 tmp/risk-kafka-focused.log