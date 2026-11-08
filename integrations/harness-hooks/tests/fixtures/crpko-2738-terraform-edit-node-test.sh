python3 - <<'PY'
from pathlib import Path
for branch in ['main-dev','native-v1']:
 root=Path('/Volumes/ExternalSSD/crpko-devops/tmp/card-2738')/branch
 p=root/'terraform/modules/clickhouse-ec2/volume_grow.tf'
 s=p.read_text()
 needle='  grow_document_arn_any    = "arn:aws:ssm:${var.aws_region}:${local.grow_account_id}:automation-definition/${local.grow_document_name}:*"'
 assert needle in s
 s=s.replace(needle,needle+'\n  grow_document_resource_arn = "arn:aws:ssm:${var.aws_region}:${local.grow_account_id}:document/${local.grow_document_name}"')
 assert s.count('Resource = [local.grow_document_arn_any]')==2
 s=s.replace('Resource = [local.grow_document_arn_any]','Resource = [local.grow_document_arn_any, local.grow_document_resource_arn]')
 for role in ['grow_events','grow_scheduler']:
  s+='''

data "aws_iam_principal_policy_simulation" "start_automation_ROLE" {
  for_each = {
    for key, role in aws_iam_role.ROLE : key => role if var.cutover_command_deny_simulation_enabled
  }

  policy_source_arn = each.value.arn
  action_names      = ["ssm:StartAutomationExecution"]
  resource_arns     = [local.grow_document_resource_arn, local.grow_document_arn]

  depends_on = [aws_iam_role_policy.ROLE]

  lifecycle {
    postcondition {
      condition = try(length(self.results) == 2 &&
        toset([for result in self.results : result.resource_arn]) == toset([local.grow_document_resource_arn, local.grow_document_arn]) &&
        alltrue([
          for result in self.results :
          result.action_name == "ssm:StartAutomationExecution" &&
          result.decision == "allowed" &&
          length(result.missing_context_keys) == 0
      ]), false)
      error_message = "Grow start proof failed for role ${self.policy_source_arn}; require allowed on both the document and automation-definition ARNs with no missing context."
    }
  }
}
'''.replace('ROLE',role)
 p.write_text(s)
 p=root/'scripts/runbooks/clickhouse-data-volume-online-grow.md'
 s=p.read_text();needle='What the automation does:'
 line='The events and scheduler roles must allow `ssm:StartAutomationExecution` on both the document ARN and the automation-definition ARN; check each role with `aws iam simulate-principal-policy --policy-source-arn <role arn> --action-names ssm:StartAutomationExecution --resource-arns <document arn> <automation-definition arn>` (use the `:$DEFAULT` definition version).\n\n'
 assert needle in s
 p.write_text(s.replace(needle,line+needle,1))
 p=root/'scripts/runbooks/clickhouse-data-volume-grow-failed.md'
 s=p.read_text();s=s.replace('## Triage\n','## Triage\n\nAlarm in ALARM but no execution: check AWS/Events FailedInvocations for rule `crpko-<env>-clickhouse-grow-data-volume-alarm` and CloudTrail StartAutomationExecution AccessDenied.\n',1);p.write_text(s)
PY
terraform fmt terraform/modules/clickhouse-ec2/volume_grow.tf
node --test scripts/test-clickhouse-volume-autogrow.mjs > tmp/card-2738/head-tests.log 2>&1