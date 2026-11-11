cat > tmp/card-3044/implement.py <<'PY'
from pathlib import Path
import json,re
root=Path('.')
old='backoffice-registry-catalog'; new='backoffice-registry-history-adoption'
def swap(s):
 return s.replace('BACKOFFICE_REGISTRY_CATALOG','BACKOFFICE_REGISTRY_HISTORY_ADOPTION').replace('BackofficeRegistryCatalog','BackofficeRegistryHistoryAdoption').replace('backofficeRegistryCatalog','backofficeRegistryHistoryAdoption').replace('runRegistryCatalog','runRegistryHistoryAdoption').replace('registry_catalog_cli','registry_history_adoption_cli').replace('backoffice_registry_catalog','backoffice_registry_history_adoption').replace(old,new)
def duplicate(p,marker,end):
 s=Path(p).read_text(); a=s.index(marker); b=s.index(end,a+len(marker)); chunk=s[a:b]; Path(p).write_text(s[:b]+swap(chunk)+s[b:])
# Balanced HCL blocks.
def hcl(p,markers):
 s=Path(p).read_text()
 for marker in markers:
  a=s.index(marker); start=s.index('{',a); depth=1; b=start+1
  while depth:
   depth += (s[b]=='{')-(s[b]=='}'); b+=1
  chunk=s[a:b]; s=s[:b]+ '\n\n'+swap(chunk)+s[b:]
 Path(p).write_text(s)
hcl('terraform/modules/ecs-runtime/main.tf',['resource "aws_cloudwatch_log_group" "backoffice_registry_catalog"','resource "aws_ecs_task_definition" "backoffice_registry_catalog"'])
duplicate('terraform/modules/ecs-runtime/main.tf','  backoffice_registry_catalog_task_name =','  # One-off position bonus')
hcl('terraform/modules/ecs-runtime/variables.tf',['variable "backoffice_registry_catalog_enabled"'])
hcl('terraform/modules/ecs-runtime/outputs.tf',['output "backoffice_registry_catalog_run_task_spec"'])
for p in ['terraform/roots/dev/outputs.tf','terraform/roots/dev/main.tf']:
 s=Path(p).read_text(); lines=s.splitlines(True); out=[]; i=0
 while i<len(lines):
  line=lines[i];out.append(line)
  if 'service_name == "backoffice-core" && module.ecs_runtime.backoffice_registry_catalog_run_task_spec' in line:
   chunk=''.join(lines[i:i+3]);out+=lines[i+1:i+3];out.append(swap(chunk));i+=2
  elif 'backoffice_registry_catalog' in line:out.append(swap(line))
  i+=1
 Path(p).write_text(''.join(out))
# Scope target and strict guard mirrors, with policy comparison changed below.
p='scripts/foundationdb-explorer-terraform-targets.mjs'
duplicate(p,'} else if (scope === "backoffice-registry-catalog")','} else if (scope ===',)
s=Path(p).read_text().replace('"backoffice-registry-catalog",','"backoffice-registry-catalog", "backoffice-registry-history-adoption",',1);Path(p).write_text(s)
p='scripts/guard-foundationdb-explorer-infra-plan.mjs'
duplicate(p,'const BACKOFFICE_REGISTRY_CATALOG_ROLE_ADDRESS','// Structural equality')
duplicate(p,'if (scope === "backoffice-registry-catalog") {','if (scope === "risk-task-version-backfill")')
s=Path(p).read_text(); a=s.index('function backofficeRegistryHistoryAdoptionRolePolicyCheck'); b=s.index('// Structural equality',a)
s=s[:a]+'''function backofficeRegistryHistoryAdoptionRolePolicyCheck(change) {
  const after = change.change?.after ?? {};
  const refs = oneOffTaskConfigResource(BACKOFFICE_REGISTRY_HISTORY_ADOPTION_SPEC, "environment_iam_roles", "aws_iam_role_policy.environment").expressions?.role?.references;
  if (after.role !== BACKOFFICE_REGISTRY_HISTORY_ADOPTION_ROLE_NAME || !sameRefs(refs, ["aws_iam_role.environment", "each.key"])) {
    throw new Error("history adoption policy must attach to its dedicated role");
  }
  const account = oneOffTaskAccountId(BACKOFFICE_REGISTRY_HISTORY_ADOPTION_SPEC);
  const template = JSON.parse(readFileSync(resolve(repoRoot, "plan/iam/roles/crpko-env-backoffice-registry-history-adoption-task-role.json"), "utf8")).inline_policy;
  const expected = JSON.parse(JSON.stringify(template).replaceAll("<env>", "dev").replaceAll("<region>", "ap-south-1").replaceAll("<account_id>", account));
  if (typeof after.policy !== "string" || !sameConditionStructure(JSON.parse(after.policy), expected)) {
    throw new Error("history adoption task role policy must match the exact transactional prefix and native fee repair policy");
  }
}

'''+s[b:]
s=s.replace('"backoffice-registry-catalog",','"backoffice-registry-catalog", "backoffice-registry-history-adoption",',1).replace('scope !== "backoffice-registry-catalog"','scope !== "backoffice-registry-catalog" && scope !== "backoffice-registry-history-adoption"',1)
a=s.index('  if (scope === "backoffice-registry-catalog") {');b=s.index('  if (scope ===',a+8);s=s[:b]+swap(s[a:b])+s[b:];Path(p).write_text(s)
# Workflow: complete line expressions plus exact target arm.
p=Path('.github/workflows/terraform-dev.yml');s=p.read_text();a=s.index('                if [ "$FOUNDATIONDB_EXPLORER_SCOPE" = "backoffice-registry-catalog" ]; then');b=s.index('                if [',a+30);s=s[:b]+swap(s[a:b]).replace('catalog_seen','adoption_seen')+s[b:]
a=s.index('          if (process.env.FOUNDATIONDB_EXPLORER_SCOPE === "backoffice-registry-catalog"');b=s.index('          }',a)+12;s=s[:b]+'\n'+swap(s[a:b])+s[b:]
s=s.replace('          - backoffice-registry-catalog\n','          - backoffice-registry-catalog\n          - backoffice-registry-history-adoption\n')
s=s.replace("inputs.foundationdb_explorer_scope == 'backoffice-registry-catalog'", "inputs.foundationdb_explorer_scope == 'backoffice-registry-catalog' || inputs.foundationdb_explorer_scope == 'backoffice-registry-history-adoption'")
s=s.replace("inputs.foundationdb_explorer_scope != 'backoffice-registry-catalog'", "inputs.foundationdb_explorer_scope != 'backoffice-registry-catalog' && inputs.foundationdb_explorer_scope != 'backoffice-registry-history-adoption'")
lines=s.splitlines(True);out=[]
for line in lines:
 out.append(line)
 if 'catalog_seen_targets=()' in line:out.append(line.replace('catalog_seen','adoption_seen'))
 if '[ "$FOUNDATIONDB_EXPLORER_SCOPE" = "backoffice-registry-catalog" ] && [ "$target_count" -ne 8 ]' in line:
  # single line is full shell guard
  out.append(swap(line))
p.write_text(''.join(out))
# Runner mirrors the reviewed catalog guard behavior.
s=swap(Path('scripts/run-backoffice-registry-catalog.mjs').read_text()).replace('Registry catalog','Registry history adoption').replace('catalog task','history adoption task').replace('catalog role','history adoption role').replace('catalog report','history adoption report')
s=s.replace('"poll-seconds"]','"poll-seconds", "repair-native-fee"]')
s=s.replace('const values = {};','const values = {};\n  const repairNativeFees = [];',1).replace('Object.hasOwn(values, name)', '(name !== "repair-native-fee" && Object.hasOwn(values, name))',1)
s=s.replace('    values[name] = argv[++index];','    const value = argv[++index];\n    if (name === "repair-native-fee") repairNativeFees.push(value);\n    else values[name] = value;',1)
s=s.replace('  return {\n    environment:', '''  if (repairNativeFees.length && values.mode !== "apply") throw new Error("--repair-native-fee requires --mode apply");
  if (repairNativeFees.some((id) => !/^[A-Za-z0-9._:-]{1,128}$/.test(id))) throw new Error("invalid --repair-native-fee id");
  return {
    repairNativeFees,
    environment:''',1)
s=s.replace('`--${options.mode}`]','`--${options.mode}`, ...(options.repairNativeFees ?? []).flatMap((id) => ["--repair-native-fee", id])]')
s=s.replace('  const { env, account, region, aws } = deps;','''  const { env, account, region, aws } = deps;
  if ((options.repairNativeFees ?? []).some((id) => typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(id))
    || ((options.repairNativeFees ?? []).length > 0 && options.mode !== "apply")) refuse("ARGUMENT_INVALID", "repair-native-fee requires apply and valid ids");''')
# Both control and payload tables bind the adoption report.
s=s.replace('json.control_table === expectTable','json.control_table === expectTable && json.history_table === `crpko-${environment}-registry-effective-business-history`')
Path('scripts/run-backoffice-registry-history-adoption.mjs').write_text(s)
# Full existing runner test matrix, plus specific arguments tests below.
s=swap(Path('scripts/test-run-backoffice-registry-catalog.mjs').read_text())
s=s.replace('control_table: TABLE,','control_table: TABLE, history_table: "crpko-dev-registry-effective-business-history",')
s=s.replace('assertTaskDefinition, assertWritersDrained, main,','assertTaskDefinition, assertWritersDrained, parseArgs, main,')
Path('scripts/test-run-backoffice-registry-history-adoption.mjs').write_text(s)
# Exact role template. History GetItem/Query are required by verify via the production reader.
role=json.loads(Path('plan/iam/roles/crpko-env-backoffice-registry-catalog-task-role.json').read_text());role['role_name']=swap(role['role_name']);stmts=role['inline_policy']['Statement'];arn='arn:aws:dynamodb:<region>:<account_id>:table/'
control=arn+'crpko-<env>-registry-effective-timeline-control';history=arn+'crpko-<env>-registry-effective-business-history'
tables=['registry_assets','registry_asset_chains','registry_venue_treasury_accounts','registry_bbp_buckets','registry_slippage_policies','registry_vip_tiers','registry_fee_schedules'];keys=[t+'#*' for t in tables]+['fee_schedule#*']
def allow(sid,actions,resources,condition=None):
 s=dict(Sid='BackofficeRegistryHistoryAdoption'+sid,Effect='Allow',Action=['dynamodb:'+a for a in actions],Resource=resources)
 if condition:s['Condition']=condition
 return s
cond=lambda keys:{'StringEquals':{'dynamodb:EnclosingOperation':'TransactWriteItems'},'ForAllValues:StringLike':{'dynamodb:LeadingKeys':keys}}
role['inline_policy']['Statement']=[allow('BusinessRead',['Scan','GetItem','ConditionCheckItem'],[arn+t for t in tables]),allow('ControlRead',['Scan','GetItem','Query','ConditionCheckItem'],[control]),allow('HistoryRead',['GetItem','Query'],[history]),allow('TransactionalPut',['PutItem'],[control,history],cond(keys)),allow('NativeFeeRepair',['UpdateItem','DeleteItem'],[control],cond(['fee_schedule#*']))]+stmts[3:]
for s in role['inline_policy']['Statement']:
 s['Sid']=swap(s['Sid'])
 if s['Sid']=='DenyDirectDynamoWrites':
  s['Action']=['dynamodb:UpdateItem','dynamodb:DeleteItem'];s['Condition']={'StringNotEqualsIfExists':{'dynamodb:EnclosingOperation':'TransactWriteItems'}}
role['inline_policy']['Statement'].append(dict(Sid='DenyBatchWrite',Effect='Deny',Action=['dynamodb:BatchWriteItem'],Resource=['*']))
role['localstack_simulation']=[]
# IAM decision cross product includes all prefix, operation, action and table siblings.
for table in [control,history]+[arn+t for t in tables]+[arn+'registry_entity_revisions']:
 for prefix in keys+['instrument#*','risk_tier_schedule#*','registry#*','CATALOG#*']:
  for action in ['PutItem','UpdateItem','DeleteItem']:
   for tx in [False,True]:
    ok=tx and ((action=='PutItem' and table in [control,history] and prefix in keys) or (action in ['UpdateItem','DeleteItem'] and table==control and prefix=='fee_schedule#*'))
    ctx={'dynamodb:LeadingKeys':prefix.replace('*','test')}
    if tx:ctx['dynamodb:EnclosingOperation']='TransactWriteItems'
    role['localstack_simulation'].append(dict(id=f'{len(role["localstack_simulation"])}-{action}',action='dynamodb:'+action,resource=table,condition=ctx,expected='allowed' if ok else ('explicitDeny' if not tx and action!='PutItem' else 'implicitDeny')))
Path('plan/iam/roles/crpko-env-backoffice-registry-history-adoption-task-role.json').write_text(json.dumps(role,indent=2)+'\n')
p=Path('plan/iam/role-index.json');idx=json.loads(p.read_text());idx['roles'].append(dict(role_name=role['role_name'],category=role['category'],file='iam/roles/crpko-env-backoffice-registry-history-adoption-task-role.json'));p.write_text(json.dumps(idx,indent=2)+'\n')
# Build spec embeds source files exactly.
p=Path('plan/devops-terraform-build-spec.json');spec=json.loads(p.read_text());spec['files']['iam/role-index.json']=Path('plan/iam/role-index.json').read_text();spec['files']['iam/roles/crpko-env-backoffice-registry-history-adoption-task-role.json']=Path('plan/iam/roles/crpko-env-backoffice-registry-history-adoption-task-role.json').read_text();p.write_text(json.dumps(spec,indent=2)+'\n')
p=Path('package.json');pkg=json.loads(p.read_text());pkg['scripts']['runbook:'+new]='node scripts/run-'+new+'.mjs';pkg['scripts']['test:'+new]='node --test scripts/test-run-'+new+'.mjs scripts/test-guard-'+new+'-plan.mjs scripts/test-'+new+'-infra.mjs';pkg['scripts']['test']+=' && '+pkg['scripts']['test:'+new];p.write_text(json.dumps(pkg,indent=2)+'\n')
PY
python3 tmp/card-3044/implement.py
node --check scripts/guard-foundationdb-explorer-infra-plan.mjs
node --test scripts/test-run-backoffice-registry-history-adoption.mjs > tmp/card-3044/runner.log 2>&1
 tail -10 tmp/card-3044/runner.log