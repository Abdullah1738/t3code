cat > tmp/quint/1606/make-terraform-tests.py <<'PY'
from pathlib import Path
p=Path('terraform/modules/ecs-runtime/tests/reporting_source_catalog.tftest.hcl').read_text()
base=p[p.index('variables {'):p.index('\nrun "')]
base=base.replace('localstack_mode                          = true','localstack_mode                          = false')
# Mock all SSM collections to deterministic empty inputs; individual cases supply release pointers.
out='''mock_provider "aws" {
  mock_data "aws_ssm_parameter" { defaults = { value = "ami-00000000000000000" } }
  mock_data "aws_ssm_parameters_by_path" { defaults = { names = [], values = [] } }
}

'''+base
old='b'*40
compatible='047bb699c3c7d36c2a32553b7576fc89a5f5411c'
for origin in ['explicit','persisted']:
 for kind,sha,digit in [('old',old,'b'),('missing_source',None,'d'),('compatible',compatible,'c')]:
  digest='sha256:'+digit*64
  shas={} if sha is None else {'edge-api':sha}
  import json
  def obj(d):return json.dumps(d)
  out+='\nrun "'+origin+'_'+kind+'" {\n  command = plan\n'
  if origin=='explicit':
   out+='  variables {\n    image_digests = { for name in keys(jsondecode(file("../../../plan/devops-runtime-values.json")).services) : name => "'+digest+'" }\n    image_git_shas = '+obj(shas)+'\n  }\n'
  else:
   out+='''  override_data {
    target = data.aws_ssm_parameters_by_path.release_image_digests[0]
    values = {
      names = [for name in keys(jsondecode(file("../../../plan/devops-runtime-values.json")).services) : "/crpko/dev/release-image-digests/${name}"]
      values = [for name in keys(jsondecode(file("../../../plan/devops-runtime-values.json")).services) : "'''+digest+'''"]
    }
  }
  override_data {
    target = data.aws_ssm_parameters_by_path.release_git_shas[0]
    values = { names = '''+('[]' if sha is None else '["/crpko/dev/release-git-shas/edge-api"]')+', values = '+('[]' if sha is None else '["'+sha+'"]')+''' }
  }
'''
  out+='''  assert {
    condition = alltrue([for container in jsondecode(aws_ecs_task_definition.service["edge-api-api"].container_definitions) :
      container.image == "111122223333.dkr.ecr.ap-south-1.amazonaws.com/edge-api@'''+digest+'''" &&
      { for entry in container.environment : entry.name => entry.value }.CRPKO_GIT_SHA == "'''+(sha or '0'*40)+'''" &&
      { for entry in container.environment : entry.name => entry.value }.EDGE_OTP_HOME_SHARD == "0"
      if container.name == "edge-api"
    ])
    error_message = "Terraform must preserve the selected image and source without asserting OTP compatibility."
  }
  assert {
    condition = alltrue(flatten([for key, task in aws_ecs_task_definition.service : [
      for container in jsondecode(task.container_definitions) : alltrue([
        for entry in container.environment : entry.name != "EDGE_OTP_HOME_SHARD"
      ])
    ] if key != "edge-api-api"]))
    error_message = "Only Edge may carry the OTP deployment marker."
  }
}
'''
Path('terraform/modules/ecs-runtime/tests/edge_otp_marker.tftest.hcl').write_text(out)
PY
python3 tmp/quint/1606/make-terraform-tests.py
cat > scripts/test-edge-otp-marker-terraform.mjs <<'EOF'
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("Terraform keeps explicit and persisted Edge images unmarked until image proof", { timeout: 900_000 }, (t) => {
  mkdirSync(join(root, "tmp"), { recursive: true });
  const dir = mkdtempSync(join(root, "tmp/edge-otp-terraform-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const copy = (path) => cpSync(join(root, path), join(dir, path), {
    recursive: true, filter: (path) => !path.split(sep).includes(".terraform")
  });
  copy("plan");
  copy("config/environments/dev.json");
  copy("terraform/modules/ecs-runtime");
  const config = join(dir, "terraform.rc");
  const mirror = process.env.TERRAFORM_PROVIDER_MIRROR;
  writeFileSync(config, `disable_checkpoint = true\n${mirror ? `provider_installation { filesystem_mirror { path = ${JSON.stringify(resolve(mirror))} } }` : ""}\n`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME,
    TF_CLI_CONFIG_FILE: config, TF_IN_AUTOMATION: "1", TF_INPUT: "0", CHECKPOINT_DISABLE: "1", AWS_EC2_METADATA_DISABLED: "true" };
  if (process.env.TF_PLUGIN_CACHE_DIR) env.TF_PLUGIN_CACHE_DIR = process.env.TF_PLUGIN_CACHE_DIR;
  const run = (args) => spawnSync(process.env.TERRAFORM_BINARY || "terraform", args, {
    cwd: join(dir, "terraform/modules/ecs-runtime"), env, encoding: "utf8", timeout: 800_000, maxBuffer: 16 * 1024 * 1024
  });
  const init = run(["init", "-backend=false", "-input=false", "-no-color"]);
  assert.equal(init.status, 0, `${init.error ?? ""}\n${init.stdout}\n${init.stderr}`);
  const result = run(["test", "-no-color", "-filter=tests/edge_otp_marker.tftest.hcl"]);
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  t.diagnostic(result.stdout);
});
EOF
offbox run -- node --test scripts/test-edge-otp-marker-terraform.mjs