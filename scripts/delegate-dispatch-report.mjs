import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
export function score(result, inventory) {
  const rows = result.mcpLoad ?? [];
  const measured = rows.filter((r) => r.measured === true);
  const delegates = measured.filter((r) => r.tool === "delegate_task");
  const sends = measured.filter((r) => r.tool === "t3_thread_send");
  const invalid = [];
  if (!delegates.length || !sends.length) invalid.push("missing measured tool samples");
  if (new Set(measured.map((r) => r.id)).size !== measured.length)
    invalid.push("duplicate offered request identity");
  for (const r of measured)
    if (!Number.isFinite(r.elapsedMs) || !r.result) invalid.push(`unfinished sample ${r.id}`);
  const timeout = delegates.filter(
    (r) =>
      r.result?.error?.code === "delegation_timeout" &&
      /during dispatch/.test(r.result.error.message),
  );
  const retryCalls = delegates.map((r) => ({
    id: r.id + ":retry",
    elapsedMs: r.retryElapsedMs,
    result: r.retry,
  }));
  const delegateCalls = [...delegates, ...retryCalls];
  for (const r of retryCalls)
    if (!r.result || !Number.isFinite(r.elapsedMs)) invalid.push(`unfinished retry ${r.id}`);
  const allTimeouts = delegateCalls.filter(
    (r) =>
      r.result?.error?.code === "delegation_timeout" &&
      /during dispatch/.test(r.result.error.message),
  );
  const sendTimeout = sends.filter((r) => r.result?.error?.code === "send_timeout");
  const unexpected = [...measured, ...retryCalls].filter(
    (r) =>
      r.result?.ok === false &&
      !["delegation_timeout", "send_timeout"].includes(r.result.error?.code),
  );
  if (unexpected.length) invalid.push("unexpected tool failures");
  const identity = (value) =>
    value &&
    value.partial !== true &&
    ["taskId", "childThreadId", "childRunId"].every(
      (key) => typeof value[key] === "string" && value[key].length > 0,
    );
  const same = (a, b) =>
    identity(a) &&
    identity(b) &&
    ["taskId", "childThreadId", "childRunId"].every((key) => a[key] === b[key]);
  const expectedId = (r) =>
    r.result?.ok ? r.result.value.taskId : r.result?.error?.message?.match(/Task (\S+) may/)?.[1];
  const originals = rows.filter((r) => r.tool === "delegate_task");
  const notSaved = originals.filter(
    (r) => r.beforeRetryCount !== 1 || r.originalCommitObserved !== true,
  );
  const unverified = originals.filter(
    (r) =>
      !r.beforeRetryStatus?.ok ||
      !identity(r.beforeRetryStatus.value) ||
      !r.retry?.ok ||
      !identity(r.retry.value) ||
      !r.status?.ok ||
      !identity(r.status.value),
  );
  const changed = originals.filter(
    (r) =>
      (r.retry?.ok && expectedId(r) !== r.retry.value.taskId) ||
      (identity(r.beforeRetryStatus?.value) &&
        identity(r.retry?.value) &&
        !same(r.beforeRetryStatus.value, r.retry.value)) ||
      (identity(r.status?.value) &&
        identity(r.retry?.value) &&
        !same(r.status.value, r.retry.value)) ||
      (r.result?.ok && r.retry?.ok && !same(r.result.value, r.retry.value)),
  );
  const resolved = originals.map((r) => r.retry?.value).filter(identity);
  const duplicateIdentities = ["taskId", "childThreadId", "childRunId"].filter(
    (key) => new Set(resolved.map((value) => value[key])).size !== resolved.length,
  );
  if (!inventory || !Array.isArray(inventory.rows))
    invalid.push("missing persisted inventory after retry");
  const persisted = inventory?.rows ?? [];
  const inventoryMatches =
    resolved.length === originals.length &&
    persisted.length === originals.length &&
    new Set(persisted.map((r) => r.id)).size === persisted.length &&
    new Set(persisted.map((r) => r.child)).size === persisted.length &&
    resolved.every((value) =>
      persisted.some(
        (r) =>
          r.id === value.taskId &&
          r.child === value.childThreadId &&
          Array.isArray(r.runs) &&
          r.runs.length === 1 &&
          r.runs[0] === value.childRunId,
      ),
    );
  const times = delegateCalls
    .map((r) => r.elapsedMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const p95 = times.length ? times[Math.ceil(times.length * 0.95) - 1] : null;
  const checks = {
    dispatchTimeouts: !!delegates.length && allTimeouts.length / delegateCalls.length <= 0.02,
    p95: p95 !== null && p95 <= 5000,
    saved:
      !!delegates.length &&
      !notSaved.length &&
      !unverified.length &&
      !changed.length &&
      !duplicateIdentities.length &&
      inventoryMatches,
    sendTimeouts: !!sends.length && sendTimeout.length / sends.length <= 0.02,
  };
  return {
    scope: "MCP call criteria only; CPU, stalls and workload validity are scored separately",
    verdict: invalid.length ? "INVALID" : Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
    invalid,
    checks,
    primaryDelegations: delegates.length,
    primaryDispatchTimeouts: timeout.length,
    delegateCalls: delegateCalls.length,
    dispatchTimeouts: allTimeouts.length,
    dispatchTimeoutPct: delegates.length ? (100 * allTimeouts.length) / delegateCalls.length : null,
    p95AllDelegateCallMs: p95,
    notSavedBeforeRetry: notSaved.map((r) => r.id),
    unverified: unverified.map((r) => r.id),
    changedTask: changed.map((r) => r.id),
    duplicateIdentities,
    inventoryMatches,
    sends: sends.length,
    sendTimeouts: sendTimeout.length,
    sendTimeoutPct: sends.length ? (100 * sendTimeout.length) / sends.length : null,
    unexpected: unexpected.map((r) => ({ id: r.id, error: r.result.error })),
  };
}
if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify(
      score(
        JSON.parse(NodeFS.readFileSync(process.argv[2], "utf8")),
        process.argv[3] ? JSON.parse(NodeFS.readFileSync(process.argv[3], "utf8")) : undefined,
      ),
      null,
      2,
    ),
  );
