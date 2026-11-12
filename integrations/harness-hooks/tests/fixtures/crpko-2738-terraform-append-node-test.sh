cat >> terraform/modules/clickhouse-ec2/volume_grow.tf <<'EOF'

data "aws_iam_principal_policy_simulation" "start_automation_grow_events" {
  for_each = {
    for key, role in aws_iam_role.grow_events : key => role if var.cutover_command_deny_simulation_enabled
  }

  policy_source_arn = each.value.arn
  action_names      = ["ssm:StartAutomationExecution"]
  resource_arns     = [local.grow_document_resource_arn, local.grow_document_arn]

  depends_on = [aws_iam_role_policy.grow_events]

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

data "aws_iam_principal_policy_simulation" "start_automation_grow_scheduler" {
  for_each = {
    for key, role in aws_iam_role.grow_scheduler : key => role if var.cutover_command_deny_simulation_enabled
  }

  policy_source_arn = each.value.arn
  action_names      = ["ssm:StartAutomationExecution"]
  resource_arns     = [local.grow_document_resource_arn, local.grow_document_arn]

  depends_on = [aws_iam_role_policy.grow_scheduler]

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
EOF
terraform fmt terraform/modules/clickhouse-ec2/volume_grow.tf
node --test scripts/test-clickhouse-volume-autogrow.mjs > tmp/card-2738/head-tests.log 2>&1
 tail -9 tmp/card-2738/head-tests.log