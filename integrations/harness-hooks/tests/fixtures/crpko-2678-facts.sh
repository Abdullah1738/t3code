python3 - <<'PY'
from pathlib import Path
import subprocess,json
root=Path('tmp/card-2678')
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()
text=f'''# Verified facts for native-v1 carry

Card 2678. Worktree /Volumes/ExternalSSD/board-wt/devops-2525-nv1. Target native-v1.
Exact requested title: chore(native-v1): carry the backoffice analytics allowlist additions (#1084)
Source PR https://github.com/Equicom-Crypto/crpko-devops/pull/1084 merged into main-dev as 44ba3d3413e550bd1b521830bfd94bc4dc85134c. Merged table set is exactly the 8 requested; no source scope change.
Base origin/native-v1 629e21abfbff85bb8ba866d351e9ba625aac4802.
Head {head}. Tree {tree}. Clean worktree. Commit includes cherry-pick -x source trailer. 9 files changed, 68 insertions and 9 deletions.

Carry purpose: ephemeral QA gets its initial AppConfig from native-v1 through the harness vendor pin. This PR brings the main-dev allowlist addition to native-v1. Existing #70 (CRP-12043) owns the subsequent harness re-pin. Do not change harness vendor here.

Resolved 5 conflicts: 3 seeds, schema enum, build-spec. Each list is native-v1 plus exactly the source 8, no removals, no duplicates, old relative order unchanged. md_ticker_latest_v2 and md_ticker_latest_state_v1 remain immediately after md_ticker_v1 in all four lists; the new md_ticker_latest_v1 follows the pair. Initial document version 1 retained. dev 63 -> 71; staging 58 -> 66; prod 58 -> 66; schema enum 63 -> 71. Staging/prod's pre-existing omissions remain as before.

Build-spec based entirely on native-v1. Script parsed base JSON, asserted its unmodified serialization was byte-identical, then replaced exactly the 4 AppConfig strings, byte-equal to disk. Base build-spec has no final newline: JSON.stringify(..., null, 2) + newline differed only at EOF, so script preserved native-v1 EOF for no extra diff. The changed keys are files.appconfig/initial/dev/backoffice_analytics.json, files.appconfig/initial/staging/backoffice_analytics.json, files.appconfig/initial/prod/backoffice_analytics.json and files.appconfig/schema/backoffice_analytics.schema.json. All other keys are identical to base.

3 migration contracts plus the existing test apply unchanged and are byte-identical to source merge:
plan/clickhouse/migrations/20261009_position_bonus_v2_empty_start_rollback.contract.json
plan/clickhouse/migrations/20261013_house_pnl_source_external_flows.contract.json
plan/clickhouse/migrations/20261013_house_pnl_source_external_flows_rollback.contract.json
scripts/test-house-pnl-source-external-flows-migration.mjs
They declare backoffice-core / Equicom-Crypto/backoffice-core / api as known consumer; every contract_change stays false. No migration SQL or DDL change.

Checks on the committed tree (same bytes as tested tree):
- npm run validate:plan exit 0, existing warnings only (IAM headroom, staging/prod terms readiness, registry Kafka transactional-id and placeholder config warnings). Includes migration validator.
- node --test scripts/test-appconfig-publish.mjs: 49 pass, 0 fail, 0 skipped. Local fixture CLI, no AWS calls.
- node --test scripts/test-appconfig-profile-schemas.mjs: 77 pass, 0 fail, 0 skipped.
- node scripts/validate-clickhouse-migration-contracts.mjs: all 41 destructive migration contracts pass, exit 0.
- node --test scripts/test-validate-clickhouse-migration-contracts-canonical.mjs: 22 pass, 0 fail.
- node --test --test-name-pattern='contracts parse and match' scripts/test-house-pnl-source-external-flows-migration.mjs: 1 pass, 0 fail.
- node --test scripts/test-house-pnl-source-external-flows-migration.mjs: full file on remote Linux Docker, 8 pass, 0 fail, 0 skipped, exit 0; two-replica case passes rerun, rollback, reapply, drift refusal and fresh bootstrap. This is test-container execution only, no environment mutation.
- git diff --check and git diff --cached --check exit 0.
- One-off real deriveProfileCandidate + validateJsonSchemaDocument probe: all 8 names individually accepted by new schema and rejected by native-v1 base schema. All 8 have CREATE statements in native-v1 baseline DDL. No new tracked tests.
- Earlier local negative-lookahead test filter was escaped incorrectly and selected full container case. 7 static checks passed; Docker case failed because local Docker daemon is absent. Corrected local targeted command above passes; full remote file also passes. Do not imply that mistaken invocation passed.

Sibling/call-site sweep:
- All 3 environment seeds + common enum: union verified, no missing environment.
- All 4 embedded copies in plan/devops-terraform-build-spec.json: byte parity verified and only these keys changed.
- scripts/validate-plan-package.mjs: validates seeds and embed parity; passed.
- scripts/validate-clickhouse-migration-contracts.mjs: derives backoffice consumers from all env allowlists; 3 contract metadata copies carried, all 41 pass.
- scripts/test-house-pnl-source-external-flows-migration.mjs: existing consumer assertion carried unchanged from source, full file passes remotely.
- terraform/modules/runtime-appconfig/scripts/appconfig-profile-schema.mjs and scripts/deploy-runtime-appconfig-profile.mjs: actual validator/candidate functions used by acceptance/rejection probe.
- Harness src/harness/ephemeral/workspace.py copies appconfig/initial via _PLAN_ENV_DIRS; no analytics list override in appconfig-reference-data fixture. Existing #70 handles pin; no harness edit.
- Broker binaries/backoffice-core/Config.md section 2.6 requires the added names and ticker pair, preserves actor RBAC intersection and projection/storage-only exclusions. No auth code change.
- Searched Crpko skills and active watcher checks/custom for analytics rules. No contradictory skill/watcher change required. Board wiki branch-facts explicitly requires union native-v1 carry before #70 re-pin.

Outside this repo: no live config, deploy, DDL, Terraform apply, AWS writes, skill updates, watcher changes or harness edits in this worker task. The later evaluator must pass native-v1 merge SHA to #70 and note #2525. Existing dependencies only.
Hosted CI has not yet started; do not claim a hosted CI pass. Only local/remote focused check results above are verified.
'''
(root/'FACTS.md').write_text(text)
PY