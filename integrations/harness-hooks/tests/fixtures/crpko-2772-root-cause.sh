python3 - <<'PY'
from pathlib import Path
import json
root=Path('/Volumes/ExternalSSD/crpko-devops/tmp/card-redis-cycle-nv1');out=root/'recovery-20261108';e0=json.loads((out/'e0-summary.json').read_text());e1=json.loads((out/'e1-summary.json').read_text())
s='''
## Recovery experiments (8 Nov 2026, UTC)

Result: **E1 works locally. E0 is not a zero-change recovery. No apply was run.** Independent read-only review verified structural equality, the entire E1 graph, Redis before/after equality, and E0 workflow inputs with no objections.

### Source and exact inputs

A fresh S3 GetObject into the native worktree at 03:00Z returned the same shared state: serial 1320, lineage `af1fac4c-99b6-d333-16ff-50f0318a6a7a`, version `uF3XDjPZ5A_RgpL.nZkHBxNgTUSIzuyV`, last modified 7 Nov 06:21:23Z. SHA256 `08f8f2a2f6463adddaf01014dbc238ba0d54e4b9e49443935e6dec7f33317ab3`. All 65 environment role flags absent. `source-metadata.json` retains the metadata only.

- Main-dev: clean fetched `origin/main-dev`, commit `ae506251cb4f9e4b54de553879215b137a1d2d24`, detached worktree `/Volumes/ExternalSSD/board-wt/devops-2772-main-dev-recovery`.
- Native-v1: `629e21abfbff85bb8ba866d351e9ba625aac4802`, still current origin/native-v1, worktree `/Volumes/ExternalSSD/board-wt/devops-2772-redis-cycle`.
- Terraform 1.17.1, darwin_arm64, existing binary `tmp/card-redis-cycle-nv1/bin/terraform`. The main-dev full-plan workflow does NOT pin 1.16.1: `.github/workflows/terraform-dev.yml:639` selects `latest` except for two targeted infra scopes. HashiCorp checkpoint returned 1.17.1. The native Redis job also selects latest. Existing committed provider locks were used with `init -lockfile=readonly`.
- Both use `AWS_PROFILE=crpko-dev`, `AWS_REGION=ap-south-1`, `TF_VAR_enable_runtime_compute=true`, and `TF_VAR_devops_git_sha` equal to their exact checkout SHA. Local AWS identity differs from CI's OIDC plan role.
- Main-dev plan-only dispatch with no release: `extra_args=()` at workflow line 1506; full command line 2116. No target, no var-file, no dev-rebuild.tfvars. The release var-file is only materialized for tag/apply paths (line 1076), so it is absent here. Default refresh=true. As specifically required for the experiment, `-lock=false` replaces CI's lock timeout, and `-input=false` prevents prompts.

Exact download:

```sh
umask 077
aws --profile crpko-dev s3api get-object \\
  --bucket crpko-dev-terraform-state --key dev/terraform.tfstate \\
  tmp/recovery-2772/current.tfstate > tmp/recovery-2772/current-meta.json
```

Each worktree had a temporary `terraform/roots/dev/recovery_backend_override.tf` with `terraform { backend "local" { path = "<absolute-worktree>/tmp/recovery-2772/e0.tfstate" } }` (E1 uses e1.tfstate). Each had a separate `TF_DATA_DIR=<absolute-worktree>/tmp/recovery-2772/tfdata`. Both initialized backend metadata files were checked: type local, exact intended local path; no S3 backend was used for planning. Init command for each was:

```sh
AWS_PROFILE=crpko-dev TF_DATA_DIR=<absolute-worktree>/tmp/recovery-2772/tfdata \\
TF_PLUGIN_CACHE_DIR=/Users/ardud/.terraform.d/plugin-cache \\
/Volumes/ExternalSSD/crpko-devops/tmp/card-redis-cycle-nv1/bin/terraform \\
  -chdir=terraform/roots/dev init -input=false -lockfile=readonly
```

### E0: full main-dev plan

Exact runnable command and environment are retained in `recovery-20261108/run-e0.sh`:

```sh
terraform -chdir=terraform/roots/dev plan -input=false -lock=false \\
  -out ../../../tmp/recovery-2772/e0.tfplan
```

Exit **0**, **49 add / 31 change / 30 destroy**. These are 80 changed resource addresses: 19 pure creates, 31 updates, 30 replacements (14 create/delete, 16 delete/create); no pure deletes. Includes task revisions, Aurora settings, Lambda code, ClickHouse artifacts, observability, QA inbox and SST IAM work. Full action/address list follows, with no values.

Plan SHA256: `'''+e0['plan_sha256']+'''`.
Full saved-plan graph: 3777 nodes, zero unresolved, acyclic. JSON render and graph command both exit 0. The input state copy remains byte-identical, serial1320 and zero true role flags after planning.

**No local apply was attempted.** E0 fails the zero-resource-change condition. The refresh-only fallback was not reached: the packet permits it only after a zero-change apply fails to persist flags. E0 -> native-v1 replay is therefore skipped; there is no E0 post-apply state to test. No 0/0/0 saved plan or hash exists to request approval for.

### E1: flags-only copy

The fresh current snapshot was copied and edited locally. Exactly 65 missing `create_before_destroy` fields were set true on `module.environment_iam_roles.aws_iam_role.environment` instances; serial incremented 1320 -> 1321; lineage unchanged. Removing those fields and decrementing serial yields an object deeply equal to the source. No attributes, dependencies, resources, outputs or Terraform-version field changed. `e1-edit-summary.json` records this.

The exact transform is retained in `recovery-20261108/prepare-flags-copy.py`; it fails unless the source serial, lineage, SHA256, 65-instance count and absent flags match, and refuses to overwrite its output. Replaying this retained script produced byte-identical candidate bytes (cmp exit0).

```sh
python3 /Volumes/ExternalSSD/crpko-devops/tmp/card-redis-cycle-nv1/recovery-20261108/prepare-flags-copy.py \\
  /Volumes/ExternalSSD/board-wt/devops-2772-redis-cycle/tmp/recovery-2772/current.tfstate \\
  /Volumes/ExternalSSD/board-wt/devops-2772-redis-cycle/tmp/recovery-2772/e1-replay.tfstate
```

Candidate local state SHA256: `7edc93e0195d150461081fd9e1dacc5c6d17d745b20c00b18951eb76830c2e49`. This is a state-file hash, not a Terraform saved-plan hash.

Native-v1 plan command/environment is retained in `recovery-20261108/run-e1.sh`:

```sh
terraform -chdir=terraform/roots/dev plan -input=false -refresh=false -lock=false \\
  -out ../../../tmp/recovery-2772/e1.tfplan
terraform -chdir=terraform/roots/dev show -json ../../../tmp/recovery-2772/e1.tfplan \\
  > tmp/recovery-2772/e1.json
terraform -chdir=terraform/roots/dev graph -plan=../../../tmp/recovery-2772/e1.tfplan -draw-cycles \\
  > tmp/recovery-2772/e1.dot
npm run guard:terraform-plan -- --env dev --plan-json tmp/recovery-2772/e1.json \\
  --out tmp/recovery-2772/e1-redis-guard.json
```

All four commands exit **0**. Plan **86 add / 50 change / 129 destroy**, 221 changed addresses. Plan SHA256 `'''+e1['plan_sha256']+'''`. Full graph has **3852 nodes, 11611 edges, zero unresolved**, independently topologically sorted with every edge verified. Redis guard: 1 replication group, no-op, identical before/after, no replacement path, no destructive Redis action. This matches the prior failing plan's resource counts but is now acyclic. The local input remains serial1321 with 65 true flags, byte-identical after planning.

There are no Terraform warning headings in either run. The E1 native-v1 plan is NOT an apply candidate: its 221 changed addresses are unrelated to the metadata-only recovery. No one should authorize or apply it as the repair.

### Approval facts and boundaries

The evaluator can ask for **E1 metadata-only recovery**, not an E0 Terraform apply. Proven source: shared serial1320/version uF3XDjPZ5A_RgpL.nZkHBxNgTUSIzuyV, source hash above; candidate: same lineage, serial1321, exactly 65 lifecycle booleans added, candidate hash above. Native-v1 verification commit 629e21abf, Terraform1.17.1. Managed resource values and dependencies unchanged; no AWS resource mutation is part of the proposed repair.

A future shared-state write still needs the owner's approval and exclusive tf:dev claim. Re-read state first; if serial/version/hash changes, this candidate is stale and must be rebuilt and re-proven without overwriting later changes. Do not push serial1319 or apply either experiment's saved plan. The private copies and binaries are deleted after this evidence pass, so a future approved run must recreate the candidate from the current source; the hashes here identify the experiment, not retained executable artifacts.

This resolves the earlier five-attribute confounder: the E1 comparison changes only flags and serial and proves the full graph clears. It does not prevent a later targeted apply from clearing implicit flags again. A durable prevention change remains separate scope.

For #73: native-v1's current plan is acyclic after E1 on the local copy. Shared state is unchanged, so #73 and PR1092 are not yet unblocked. Even after a real approved metadata repair, a native-v1 apply needs separate review of its changes.

### E0 complete resource action/address list

```text
'''
s+='\n'.join('/'.join(r['actions'])+' '+r['address'] for r in e0['changes'])
s+='\n```\n\nSanitized E0/E1 summaries, graph DOT files (addresses only), exact command scripts, input metadata, warning-heading lists and Redis report are under `recovery-20261108/`.\n'
p=root/'ROOT-CAUSE.md';p.write_text(p.read_text()+s)
PY