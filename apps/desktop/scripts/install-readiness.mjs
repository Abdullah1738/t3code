import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_READY_BUDGET_S = 180;

export function validateReadyBudget(value = String(DEFAULT_READY_BUDGET_S)) {
  if (typeof value !== "string" || value.length === 0 || /[^0-9]/.test(value) ||
      !Number.isSafeInteger(Number(value) * 1000) || Number(value) < 180)
    throw new Error("--ready-budget-s requires an integer >= 180 (safe milliseconds)");
  return Number(value);
}

function remainingMs(quitAt, now, readyBudgetS) {
  const remaining = readyBudgetS * 1000 - (now - quitAt);
  if (remaining <= 0)
    throw Object.assign(new Error(`Install exceeded the ${readyBudgetS} s readiness budget`), {
      code: "READINESS_BUDGET_EXCEEDED",
    });
  return remaining;
}

export function installCommandTimeout(timeout, quitAt, startupComplete, now = Date.now(), readyBudgetS = DEFAULT_READY_BUDGET_S) {
  return quitAt === undefined || startupComplete
    ? timeout
    : Math.min(timeout, remainingMs(quitAt, now, readyBudgetS));
}

export function installBackupTimeout(quitAt, now = Date.now(), readyBudgetS = DEFAULT_READY_BUDGET_S, backupDeadline = now + 120_000) {
  // Preserve the clone cap and the minute reserved for swap, launch and readiness.
  const ms = Math.min(backupDeadline - now, remainingMs(quitAt, now, readyBudgetS) - 60_000);
  if (ms <= 0) throw new Error("No time left for the backup before the swap");
  return ms;
}

export async function waitForInstallReadiness(fn, {
  quitAt, readyBudgetS = DEFAULT_READY_BUDGET_S, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  for (;;) {
    remainingMs(quitAt, now(), readyBudgetS);
    try {
      if (await fn()) return;
    } catch {}
    await sleep(200);
  }
}

/** Read only phase markers, never the database; tolerate an append in progress. */
export async function readBootPhase(file, oldBootId) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const offset = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    const tail = buffer.toString("utf8");
    const records = (offset ? tail.slice(tail.indexOf("\n") + 1) : tail).split("\n").flatMap((line) => {
      try {
        const record = JSON.parse(line);
        return typeof record.bootId === "string" && typeof record.phase === "string" ? [record] : [];
      } catch { return []; }
    });
    const latest = records.at(-1);
    if (!latest || latest.bootId === oldBootId) return { source: file, unavailable: "no_new_boot" };
    const active = new Map();
    for (const record of records.filter((record) => record.bootId === latest.bootId)) {
      if (record.outcome === "start") active.set(record.id, record);
      else active.delete(record.id);
    }
    const current = [...active.values()].at(-1) ?? latest;
    return { source: file, bootId: current.bootId, phase: current.phase, outcome: current.outcome, at: current.at };
  } catch (error) {
    return { source: file, unavailable: error.code ?? String(error) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "boot-phase") console.log(JSON.stringify(await readBootPhase(process.argv[3], process.argv[4] || undefined)));
    else if (process.argv[2] === "boot-id") console.log((await readBootPhase(process.argv[3])).bootId ?? "");
    else if (process.argv[2] === "validate") console.log(validateReadyBudget(process.argv[3]));
    else throw new Error("Expected validate or boot-phase");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
