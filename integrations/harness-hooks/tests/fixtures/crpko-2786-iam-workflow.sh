python3 - <<'PY'
from pathlib import Path
p=Path('.github/workflows/terraform-dev.yml');s=p.read_text();rows=s.splitlines();idx=next(i-1 for i,line in enumerate(rows) if line.strip()=='test "$FOUNDATIONDB_EXPLORER_SCOPE" = "iam"');base=rows[idx];assert base.rstrip().endswith(')')
new=[]
for role in ['backoffice-core-worker-task-role','backoffice-risk-ledger-release-task-role']:
 new.extend([f'module.environment_iam_roles.aws_iam_role.environment["crpko-env-{role}"]',f'module.environment_iam_roles.aws_iam_role_policy.environment["crpko-env-{role}"]',f'module.environment_iam_roles.aws_iam_role_policy_attachment.cutover_command_deny["crpko-env-{role}"]',f'module.environment_iam_roles.data.aws_iam_principal_policy_simulation.cutover_command_deny["crpko-env-{role}/fdb-backup-describe"]'])
new += ['module.runtime_secrets.aws_iam_role_policy.runtime_secret_read["crpko-dev-backoffice-core-task-role"]','module.runtime_secrets.aws_iam_role_policy.runtime_secret_read["crpko-dev-backoffice-core-worker-task-role"]','module.runtime_access_policies.aws_iam_policy.runtime_access["backoffice-core-dynamodb-registry"]','module.runtime_access_policies.aws_iam_role_policy_attachment.runtime_access["backoffice-core-dynamodb-registry"]','module.runtime_access_policies.aws_iam_role_policy.backoffice_risk_ledger_release_kms[0]','module.runtime_access_policies.aws_iam_policy.backoffice_worker_revisions[0]','module.runtime_access_policies.aws_iam_role_policy_attachment.backoffice_worker_revisions[0]','module.runtime_access_policies.aws_iam_role_policy_attachment.backoffice_worker_runtime_access']
for target in new: assert "'" not in target and 'module.ecs_runtime' not in target
rows[idx]=base[:-1]+'|'+ '|'.join("'"+v+"'" for v in new)+')';p.write_text('\n'.join(rows)+'\n')
q=Path('tmp/card-2786/iam-new-targets.json');import json;q.write_text(json.dumps(new,indent=2)+'\n')
PY
node --test --test-name-pattern='iam scope applies the market-data' scripts/test-terraform-pr-plan-gate.mjs > tmp/card-2786/iam-workflow-shell.log 2>&1