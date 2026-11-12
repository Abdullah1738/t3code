cat > tmp/quint/1606/fix3/RESULTS.md <<'EOF'
# Terraform OTP marker truth

Base: origin/native-v1 0aaba203e0adc93edcd6c3160eab425f8863ddc3. Previous published head452775b7931686d4b8a161fb498d7bb9de6b9075. PR1116, card1606.

Production delta: shared Terraform service_base_env gives edge-api marker0. Terraform has no exact-image proof, so claimed source SHAs cannot certify any image. Release script still verifies ECR digest/source identity and GitHub ancestry before marker1. Runbook exports source-read token and requires marked completed fleet before moves. All3 marker meanings and Broker e1bf746d references retained.

Verification on final production/test delta:
- npm run test:deploy-public-ecs:199 pass,deploy.log. Includes all earlier image binding, historical admission, retry, oversizedresponse closures and3 new bootstrap source cases.
- npm run test:runtime-inventory:69 pass,inventory.log.
- node --test scripts/test-plan-runtime-env.mjs scripts/test-dev-rebuild-bootstrap-runbook.mjs scripts/test-run-static-test-shard.mjs:205 pass,siblings.log.
- npm run validate:plan:exit0,plan.log. Generated spec JSON resolves rebase conflict deterministically from current base plus marker inventory/embedded merged runtime plan.
- TERRAFORM_PROVIDER_MIRROR=/Users/ardud/.terraform.d/plugin-cache node --test scripts/test-edge-otp-marker-terraform.mjs:1 test,6 real mock-provider plan runs pass,terraform-local.log. All Edge taskdefinitions selected digest/SHA checked, marker0, other service taskdefinitions marker absent.
- Terraform format checks pass. No actual Terraform apply: test run command=plan, mock AWS provider, credentialless environment.
- Removing only Terraform's marker0 override from the copied module makes all6 plan runs fail,terraform-old.log. old-render.mjs is local scratch and is not tracked. Only production main.tf delta versus namedbase is this override and its explanatorycomment,confirmed by exact string comparison.
- Earlier remote attempt stopped on missing copied test-module dependencies before validation. Fixed isolated fixture excludes unrelated tftest module fixtures, supplies live FDB parameter name and FDB role, includes source-lag config; local6 plans pass. No broad repository suite repeated. Runtime inventory live CLI readback remains the later rebuild step; inventory fake-AWS CLI coverage passes.

Input/failure class:
| Image source | Explicit input | Persisted SSM pointer | Bootstrap release |
| Old source | marker0,identity unchanged | marker0,identity unchanged | remains0; prior historical-success refusal covered |
| Missing source | marker0,zero SHA | marker0,zero SHA | remains0; prior historical-success refusal covered |
| Compatible source | marker0,identity unchanged | marker0,identity unchanged | verified source/digest becomes1 |

This preserves first rollout and compatible rollback admission. Terraform task-definition registration itself does not rely on running capacity or release gate execution.

Sibling sweep:
- Terraform roots dev,staging,prod call same ecs-runtime module; service_mode_env and service_container_definitions consume overridden service_base_env. Only edge-api gets0. No separate Edge renderer found.
- Public release main registration, config-only regeneration and reused taskdefinition paths keep exactimage verification/history refusal; rollback workflow shares this script. Earlier compatible-image tests pass in199 suite.
- Five public workflow callers retain source-read GH_TOKEN wiring from prior fix.
- Private release script does not register public Edge. Registry/one-off renderers do not use Edge images.
- reload-public-ecs-secrets reuses a pinned existing taskdefinition and fixed image identity; cannot stamp a newly selected image or change marker. It requires exact currentservice/taskdefinition baseline. LocalStack smoke uses synthetic test definitions, not live release path.
- Broker deployment5.15 current read confirms marker means home-shard,pendingdelivery,verify move fence and later unmarked refusal. Wiki lessons checked: real-path regressions, exacthead Criticalchain, no provider writes, native-v1 merge hold/landingwindow, unknown Terraform map shape. No added unknown-valued for_each.
- Skills and watcher search found no alternate OTP marker configuration requiring change. Integrationharness has no Terraform/CodeDeploy marker registration or marker consumer mirror; deploy safety tested in owningrepo instead. No external configuration edit required.
- Outside repository: rebuild must complete verified marked rollout before moves; readback remains s4 after card69. Fleet gate SHARD031 remains evaluator step for633/1198. Merge hold until3069/1110 lands retained.

Quint model: terraform-marker.qnt, in this folder. Explicit/persisted inputs, source missing/mismatch, pointer replacement, timeouts, restart,replay and concurrent historicalcompletion. Invariants noUnprovenMarker and noUnfencedRelease, combined safety.
Commands:
quint run tmp/quint/1606/fix3/terraform-marker.qnt --step oldStep --invariant safety --max-steps40 --max-samples10000
  violation,noUnprovenMarker on old Terraform registration,model-old.log.
quint run tmp/quint/1606/fix3/terraform-marker.qnt --invariant safety --max-steps40 --max-samples10000
  pass10000 traces40steps,model-run.log.
JAVA_HOME=/opt/homebrew/opt/openjdk quint verify tmp/quint/1606/fix3/terraform-marker.qnt --invariant safety --max-steps8 --server-endpoint localhost:9406
  pass depth8,5.209seconds,model-verify.log. No listener remains on9406. Model caught false markers independent of explicit/persisted source identity; no additional issue found. Scratch specs/logs excluded from commit.

No AWS writes,live applies,workflowdispatches,merge or deployment.
EOF