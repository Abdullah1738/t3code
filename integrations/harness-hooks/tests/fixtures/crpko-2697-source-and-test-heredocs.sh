cat > scripts/gc-private-release-operation-records.mjs <<'EOF'
#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { operationParameterName, PRIVATE_RELEASE_SCHEMA } from "./private-ecs-release-journal.mjs";
import { awaitParameterReadback, snapshotParameter } from "./release-pointer-transaction.mjs";

const safeToken = /^[A-Za-z0-9_.:-]{1,128}$/;
const validEnv = /^(dev|staging|prod|qa[0-9]+)$/;

export function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!["--env", "--dry-run", "--execute", "--region"].includes(flag)
      || args.has(flag) || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error(`invalid or missing argument: ${flag}`);
    }
    args.set(flag, argv[i + 1]);
  }
  const env = args.get("--env");
  if (!validEnv.test(env ?? "")) throw new Error("--env must be dev, staging, prod or qa<id>");
  for (const flag of ["--dry-run", "--execute"]) {
    if (args.has(flag) && !["true", "false"].includes(args.get(flag))) {
      throw new Error(`${flag} must be true or false`);
    }
  }
  const execute = args.get("--execute") === "true";
  if ((execute && args.get("--dry-run") === "true") || (!execute && args.get("--dry-run") === "false")) {
    throw new Error("deletion requires --execute true without --dry-run true");
  }
  return { env, execute, region: args.get("--region") };
}

function currentOperation(awsJson, env, binary) {
  const name = operationParameterName(env, binary);
  const snapshot = snapshotParameter(awsJson, name);
  if (!snapshot.existed) return null;
  let journal;
  try { journal = JSON.parse(snapshot.value); } catch {
    throw new Error(`${name}: journal is not valid JSON; cleanup refused`);
  }
  if (snapshot.type !== "String" || !journal || Array.isArray(journal)
    || typeof journal.operation_id !== "string" || !safeToken.test(journal.operation_id)
    || (journal.schema !== undefined && journal.schema !== PRIVATE_RELEASE_SCHEMA)
    || (journal.env !== undefined && journal.env !== env)
    || (journal.binary !== undefined && journal.binary !== binary)) {
    throw new Error(`${name}: journal ownership is unreadable; cleanup refused`);
  }
  return journal.operation_id;
}

function listNames(awsJson, prefix) {
  const names = new Set();
  const tokens = new Set();
  let token;
  do {
    const page = awsJson(["ssm", "describe-parameters", "--parameter-filters",
      JSON.stringify([{ Key: "Path", Option: "Recursive", Values: [prefix] }]),
      "--max-results", "50", "--no-paginate", ...(token ? ["--next-token", token] : [])]);
    if (!Array.isArray(page.Parameters) || page.Parameters.some(p => typeof p?.Name !== "string")) {
      throw new Error("SSM parameter listing is invalid");
    }
    for (const parameter of page.Parameters) names.add(parameter.Name);
    token = page.NextToken;
    if (token !== undefined && (typeof token !== "string" || !token || tokens.has(token))) {
      throw new Error("SSM parameter pagination token is invalid or repeated");
    }
    if (token) tokens.add(token);
  } while (token);
  return [...names].sort();
}

export function gcOperationRecords({ env, awsJson, execute = false,
  reportPath = `tmp/operation-record-gc-${env}.json`, readback } = {}) {
  if (!validEnv.test(env ?? "") || typeof execute !== "boolean") throw new Error("invalid cleanup options");
  const prefix = `/crpko/${env}/release-private-gates/operations`;
  const report = { schema: "crpko.operation-record-gc.v1", env, dry_run: !execute, status: "planning", records: [] };
  const save = () => {
    const path = resolve(reportPath);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  };
  // Replace any receipt from an earlier invocation even if listing fails.
  save();
  try {
    const groups = new Map();
    for (const name of listNames(awsJson, prefix)) {
      const parts = name.startsWith(`${prefix}/`) ? name.slice(prefix.length + 1).split("/") : [];
      const [binary, operationId, ...child] = parts;
      // Main journals and anything outside a complete operation child path
      // are evidence only. Never broaden the deletion prefix to the gate root.
      const eligible = parts.length >= 3 && /^[a-z][a-z0-9-]{0,127}$/.test(binary)
        && safeToken.test(operationId) && child.every(part => /^[A-Za-z0-9_.-]+$/.test(part))
        && !parts.some(part => ["admissions", "latch", "close-notice-writer"].includes(part));
      const row = { name, binary: binary ?? null, operation_id: operationId ?? null,
        decision: eligible ? "pending" : "skip-protected" };
      report.records.push(row);
      if (eligible) {
        const key = `${binary}/${operationId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
    }
    const owners = new Map();
    for (const rows of groups.values()) {
      const { binary, operation_id: operationId } = rows[0];
      if (!owners.has(binary)) owners.set(binary, currentOperation(awsJson, env, binary));
      for (const row of rows) row.decision = owners.get(binary) === operationId ? "skip-current" : "orphan";
    }
    report.status = execute ? "deleting" : "dry-run";
    save(); // All names and initial decisions must exist on disk before any delete.
    if (execute) {
      for (const rows of groups.values()) {
        for (const row of rows) {
          if (row.decision !== "orphan") continue;
          row.decision = "delete-pending";
          save();
          // Reread before EVERY delete, including successive records in one
          // operation. Supported workflows also serialize on crpko-dev-mutation.
          if (currentOperation(awsJson, env, row.binary) === row.operation_id) {
            row.decision = "skip-current";
            save();
            continue;
          }
          try {
            awsJson(["ssm", "delete-parameter", "--name", row.name]);
          } catch (error) {
            if (snapshotParameter(awsJson, row.name).existed) throw error;
          }
          if (awaitParameterReadback(awsJson, row.name, snapshot => !snapshot.existed, readback).existed) {
            throw new Error(`${row.name}: deletion readback did not converge`);
          }
          row.decision = "deleted";
          save();
        }
      }
      report.status = "complete";
      save();
    }
    return report;
  } catch (error) {
    for (const row of report.records) {
      if (row.decision === "delete-pending") row.decision = "delete-failed";
      else if (["pending", "orphan"].includes(row.decision)) row.decision = "not-deleted";
    }
    report.status = "failed";
    report.error = error.message;
    save();
    throw error;
  }
}

export function main(argv = process.argv.slice(2), { awsJson, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { env, execute, region } = parseArgs(argv);
    const callAws = awsJson ?? (args => {
      const result = spawnSync("aws", [...args, ...(region ? ["--region", region] : []), "--output", "json"],
        { encoding: "utf8", timeout: 60_000, env: { ...process.env, AWS_PAGER: "" } });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr.trim() || "AWS command failed");
      return result.stdout.trim() ? JSON.parse(result.stdout) : {};
    });
    const report = gcOperationRecords({ env, execute, awsJson: callAws });
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
EOF
cat > .github/workflows/run-dev-operation-record-gc.yml <<'EOF'
name: Dev operation record cleanup

on:
  workflow_dispatch:
    inputs:
      mode:
        description: List orphaned records or delete them
        required: true
        type: choice
        default: dry-run
        options:
          - dry-run
          - execute

permissions:
  contents: read
  id-token: write

jobs:
  authorize-manual-run:
    name: Authorize manual run
    if: ${{ github.event_name == 'workflow_dispatch' && (github.actor != 'Abdullah1738' || github.triggering_actor != 'Abdullah1738') }}
    runs-on: ubuntu-latest
    steps:
      - name: Reject unauthorized manual actor
        run: |
          echo "Manual workflow runs are restricted to Abdullah1738."
          exit 1
  cleanup:
    if: ${{ github.event_name == 'workflow_dispatch' && github.actor == 'Abdullah1738' && github.triggering_actor == 'Abdullah1738' }}
    runs-on: ubuntu-latest
    environment: dev
    concurrency:
      group: crpko-dev-mutation
      cancel-in-progress: false
    env:
      AWS_REGION: ${{ vars.CRPKO_AWS_REGION || 'ap-south-1' }}
      AWS_ACCOUNT_ID: ${{ vars.CRPKO_AWS_ACCOUNT_ID }}
      GC_MODE: ${{ inputs.mode }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ env.AWS_ACCOUNT_ID }}:role/crpko-dev-gha-apply
          aws-region: ${{ env.AWS_REGION }}
      - name: Clean up orphaned operation records
        run: |
          set -euo pipefail
          case "$GC_MODE" in
            dry-run) npm run gc:private-release-operation-records -- --env dev --dry-run true ;;
            execute) npm run gc:private-release-operation-records -- --env dev --execute true ;;
            *) echo "invalid cleanup mode" >&2; exit 1 ;;
          esac
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: operation-record-gc-dev
          path: tmp/operation-record-gc-dev.json
          retention-days: 30
          if-no-files-found: warn
EOF
python3 - <<'PY'
import json
from pathlib import Path
p=Path('package.json');d=json.loads(p.read_text());d['scripts']['gc:private-release-operation-records']='node scripts/gc-private-release-operation-records.mjs';d['scripts']['test']+=' && node --test scripts/test-gc-private-release-operation-records.mjs';p.write_text(json.dumps(d,indent=2)+'\n')
p=Path('scripts/runbooks/trading-core-close-notice-writer.md');s=p.read_text();i=s.index('## Not covered');s=s[:i]+'''## Cleaning up leftover records

Roll-forward completion retains child records under
`/crpko/<env>/release-private-gates/operations/<binary>/<operation_id>/`.
They consume SSM Standard parameter quota. The cleanup command lists these
records and reads each binary's main journal. It treats children as orphaned
only when that journal is absent or names another operation.

Start with the default dry run:

```bash
npm run gc:private-release-operation-records -- --env dev
# Equivalent: --env dev --dry-run true
```

Inspect `tmp/operation-record-gc-dev.json`: it lists parameter names, operation
IDs and decisions without parameter values. After approval to delete the listed
orphans, use `--env dev --execute true`. The command writes its decisions before
any deletion, rereads the main journal before each record deletion and confirms
each deletion with bounded readback. If the journal now names that operation,
the record is skipped. Unreadable ownership or failed deletion readback stops
cleanup with a failed report and a non-zero exit. A rerun lists remaining records
again; it never replays a previous report as deletion instructions.

For dev, `run-dev-operation-record-gc.yml` provides the same `dry-run` (default)
and `execute` modes, restricted to Abdullah1738 for both the initial actor and
reruns. It shares `crpko-dev-mutation` with release workflows and uploads the
report even on failure. Do not run the command alongside manual or external
journal writers: SSM has no atomic owner-check-and-delete operation, and the
workflow lock cannot serialize those writers. Other environments require their
own mutation exclusion and environment-matched credentials.

Cleanup never deletes main journals, the close notice writer latch or admission
evidence. Current-operation records remain intact, including snapshots,
target/candidate records and attempt events. In-write pruning remains unchanged.

'''+s[i:];s=s.replace('parameter quota; a garbage-collection follow-up owns their eventual removal.','parameter quota; use "Cleaning up leftover records" above to remove orphans.');p.write_text(s)
PY