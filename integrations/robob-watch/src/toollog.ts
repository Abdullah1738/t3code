import { chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, mkdtempSync, openSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { constants } from "node:os";

export type LogEntry = {
  component: string; kind: "event" | "perf" | "error"; name: string;
  durationMs?: number; ok?: boolean; ids?: Record<string, unknown>; props?: Record<string, unknown>;
  error?: { tag: string; message?: string };
};
const token = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
const idKeys = new Set(["watcher", "run", "thread", "chat", "key", "operation", "reminder", "update", "item", "helper"]);
const numeric = new Set(["exitCode", "attempt", "count", "threshold", "failures", "bytes", "queuedMs", "failedSources", "totalSources"]);
const boolean = new Set(["deduped", "accepted", "timedOut", "notified"]);
const errnoCodes = new Set(Object.keys(constants.errno));
const signals = new Set(Object.keys(constants.signals));
const values: Record<string, readonly string[]> = {
  severity: ["info", "attention", "error"], outcome: ["fire", "no_change", "fail", "timeout"],
  source: ["mail", "sms", "bank", "charge"], routed: ["board", "chat", "ignored"],
  class: ["urgent", "today", "info", "noise", "candidate", "charge", "bank", "security", "otp", "unknown", "fail_open", "deduped"],
  action: ["create", "queue", "cancel", "snooze", "sent", "retry", "check", "wake", "notify", "send", "coalesce", "conflict", "expire", "pause", "remove", "cap", "resume"],
  state: ["pending", "sending", "sent", "uncertain", "cancelled", "failed", "scheduled", "queued", "done", "expired", "paused", "active"],
  stderrClass: ["usage_error", "missing_file", "permission", "timeout", "python_traceback", "auth", "connect", "json", "unknown"],
  triggerKind: ["file", "wal"],
  step: ["native", "status"],
};
let testRoot: string | undefined;
export const logDirectory = () => {
  if (process.env.TOOLLOG_DIR) return process.env.TOOLLOG_DIR;
  const bunTest = process.versions.bun && /(?:\.(?:test|spec)|_(?:test|spec))\.[cm]?[jt]sx?$/.test(process.argv[1] ?? "");
  if (process.env.ROBOB_TEST || process.env.NODE_ENV === "test" || process.env.PYTEST_CURRENT_TEST || bunTest) {
    testRoot ??= mkdtempSync(join(tmpdir(), "watchers-test-logs-"));
    return process.env.TOOLLOG_DIR = testRoot;
  }
  return join(homedir(), ".robob/logs/tools/watchers");
};
const initialized = new Set<string>();
const CAP = 50 * 1024 * 1024;

function fields(entry: LogEntry, at: Date) {
  if (!token.test(entry.component) || !token.test(entry.name) || !["event", "perf", "error"].includes(entry.kind)) return undefined;
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.ids ?? {})) {
    if (!idKeys.has(key) || !["string", "number"].includes(typeof value)) continue;
    const text = String(value);
    // Names are needed for nightly attribution; arbitrary correlation IDs may contain private text.
    ids[key] = (key === "watcher" || key === "helper") && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(text) && !/\d{5}/.test(text)
      ? text : createHash("sha256").update(text).digest("hex").slice(0, 24);
  }
  const props: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(entry.props ?? {})) {
    if ((key === "exitCode" || key === "signal") && value === null) props[key] = null;
    else if (key === "stderrLines" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) props[key] = value;
    else if (key === "stderrHash" && typeof value === "string" && /^[a-f0-9]{16}$/.test(value)) props[key] = value;
    else if (key === "errnoCode" && typeof value === "string" && (errnoCodes.has(value) || value === "UNKNOWN")) props[key] = value;
    else if (key === "signal" && typeof value === "string" && signals.has(value)) props[key] = value;
    else if (entry.name === "wake.creator_fallback" && key === "reason" && typeof value === "string"
      && /^(?:timeout|invalid|archived|exit:\d{1,3})$/.test(value)) props[key] = value;
    else if (entry.name === "wake.creator_fallback" && key === "durationMs" && typeof value === "number"
      && Number.isFinite(value) && value >= 0) props[key] = value;
    else if (numeric.has(key) && typeof value === "number" && Number.isFinite(value)) props[key] = value;
    else if (boolean.has(key) && typeof value === "boolean") props[key] = value;
    else if (typeof value === "string" && values[key]?.includes(value)) props[key] = value;
  }
  return {
    ts: at.toISOString(), tool: "watchers", component: entry.component, kind: entry.kind, name: entry.name,
    ...(typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) && entry.durationMs >= 0 ? { durationMs: entry.durationMs } : {}),
    ...(typeof entry.ok === "boolean" ? { ok: entry.ok } : {}),
    ...(Object.keys(ids).length ? { ids } : {}), ...(Object.keys(props).length ? { props } : {}),
    // Exception messages can embed payloads and credentials. Only the stable code is retained.
    ...(entry.error && token.test(entry.error.tag) ? { error: { tag: entry.error.tag, message: entry.error.tag } } : {}),
  };
}

function appendLine(file: string, line: unknown): void {
  const fd = openSync(file, "a", 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, JSON.stringify(line) + "\n"); }
  finally { closeSync(fd); }
}

export function toolLog(entry: LogEntry): void {
  try {
    if ((process.env.ROBOB_TEST || process.env.NODE_ENV === "test" || process.env.PYTEST_CURRENT_TEST) && !process.env.TOOLLOG_DIR) return;
    const at = new Date();
    const line = fields(entry, at);
    if (!line) return;
    const dir = logDirectory(), day = at.toISOString().slice(0, 10), file = join(dir, `${day}.ndjson`);
    const identity = `${dir}/${day}`;
    if (!initialized.has(identity)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const cutoff = new Date(at.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
      for (const name of readdirSync(dir)) {
        const match = /^(?:rollup-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json|\.cap)$/.exec(name);
        if (match && match[1]! < cutoff) { try { unlinkSync(join(dir, name)); } catch { /* Best effort retention. */ } }
      }
      initialized.add(identity);
    }
    const size = existsSync(file) ? statSync(file).size : 0;
    if (size > CAP) {
      try {
        const marker = openSync(join(dir, `${day}.cap`), "wx", 0o600); closeSync(marker);
        appendLine(file, { ts: at.toISOString(), tool: "watchers", component: "logger", kind: "error", name: "log.cap", ok: false, error: { tag: "log.cap", message: "log.cap" } });
      } catch { /* Another component already recorded the cap. */ }
      if (entry.kind !== "error") return;
    }
    appendLine(file, line);
  } catch { /* Logging cannot affect the caller. */ }
}

export function toolError(component: string, tag: string, ids?: Record<string, unknown>, props?: Record<string, unknown>): void {
  toolLog({ component, kind: "error", name: `${component}.error`, ok: false, ids, props, error: { tag } });
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeId = (key: string, value: unknown): value is string => typeof value === "string" && (
  /^[a-f0-9]{24}$/.test(value) || ((key === "watcher" || key === "helper") && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value) && !/\d{5}/.test(value))
);
const milliseconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const outcomes = () => ({ no_change: 0, fire: 0, fail: 0, timeout: 0 });
function percentiles(samples: number[]) {
  samples.sort((a, b) => a - b);
  return { p50: samples[Math.ceil(samples.length * .5) - 1] ?? null, p95: samples[Math.ceil(samples.length * .95) - 1] ?? null, max: samples.at(-1) ?? null };
}
function watcherStats() {
  return { runs: 0, fires: 0, outcomes: outcomes(), durations: [] as number[], queued: [] as number[], failStreak: 0, longestFailStreak: 0, lastFailureTag: null as string | null };
}
function helperStats() {
  return { runs: 0, failures: 0, exitCodes: Object.create(null) as Record<string, number>, durations: [] as number[] };
}
const byRuns = (a: [string, { runs: number }], b: [string, { runs: number }]) => b[1].runs - a[1].runs || a[0].localeCompare(b[0]);

export async function rollup(day: string, dir = logDirectory()) {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return undefined;
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");
    const counts: Record<string, number> = Object.create(null), kinds: Record<string, number> = Object.create(null);
    const durations: Record<string, number[]> = Object.create(null);
    const errors: Record<string, { count: number; sampleId?: string }> = Object.create(null);
    const watchers = new Map<string, ReturnType<typeof watcherStats>>();
    const helpers = new Map<string, ReturnType<typeof helperStats>>();
    const sourceErrors = new Map<string, { tag: string; source: "watcher" | "helper"; id: string; count: number }>();
    const wake = { sent: 0, failed: 0, attempts: 0, replyGuard: { total: 0, blocked: 0, accepted: 0 } };
    let total = 0, ok = 0, failed = 0, withOk = 0;
    const source = join(dir, `${day}.ndjson`);
    let sourceExists = true;
    try { statSync(source); }
    catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      sourceExists = false;
    }
    const lines = sourceExists ? createInterface({ input: createReadStream(source), crlfDelay: Infinity }) : [];
    for await (const line of lines) {
      let row; try { row = record(JSON.parse(line)); } catch { continue; }
      if (row.tool !== "watchers" || typeof row.name !== "string" || !token.test(row.name) || typeof row.kind !== "string" || !["event", "perf", "error"].includes(row.kind)) continue;
      total++; counts[row.name] = (counts[row.name] ?? 0) + 1; kinds[row.kind] = (kinds[row.kind] ?? 0) + 1;
      if (typeof row.ok === "boolean") { withOk++; if (row.ok) ok++; else failed++; }
      if (milliseconds(row.durationMs)) (durations[row.name] ??= []).push(row.durationMs);
      const ids = record(row.ids), props = record(row.props), error = record(row.error);
      const watcher = safeId("watcher", ids.watcher) ? ids.watcher : undefined;
      const helper = safeId("helper", ids.helper) ? ids.helper : undefined;
      const tag = typeof error.tag === "string" && token.test(error.tag) ? error.tag : undefined;
      // Only deliverPending emits this after success. wake.sent also includes failure escalations.
      if (row.name === "watch.fire" && row.ok === true) {
        const id = watcher ?? "unknown", stats = watchers.get(id) ?? watcherStats();
        watchers.set(id, stats);
        stats.fires++;
      }
      if (row.name === "watch.run") {
        const id = watcher ?? "unknown", stats = watchers.get(id) ?? watcherStats();
        watchers.set(id, stats);
        stats.runs++;
        const outcome = props.outcome;
        if (outcome === "no_change" || outcome === "fire" || outcome === "fail" || outcome === "timeout") stats.outcomes[outcome]++;
        if (milliseconds(row.durationMs)) stats.durations.push(row.durationMs);
        if (milliseconds(props.queuedMs)) stats.queued.push(props.queuedMs);
        // Runs for one watcher are serialized; helper errors and delivery retries are not new runs.
        if (outcome === "fail" || outcome === "timeout" || row.ok === false) {
          stats.longestFailStreak = Math.max(stats.longestFailStreak, ++stats.failStreak);
          stats.lastFailureTag = tag ?? null;
        } else if (outcome === "no_change" || outcome === "fire" || row.ok === true) stats.failStreak = 0;
      }
      if (row.name === "helper.run") {
        const id = helper ?? "unknown", stats = helpers.get(id) ?? helperStats();
        helpers.set(id, stats);
        stats.runs++;
        if (row.ok === false) stats.failures++;
        if (props.exitCode === null || (typeof props.exitCode === "number" && Number.isSafeInteger(props.exitCode))) {
          const code = String(props.exitCode);
          stats.exitCodes[code] = (stats.exitCodes[code] ?? 0) + 1;
        }
        if (milliseconds(row.durationMs)) stats.durations.push(row.durationMs);
      }
      if (row.name === "wake.sent") {
        wake.attempts++;
        if (row.ok === true) wake.sent++;
        else if (row.ok === false) wake.failed++;
      } else if (row.name === "wake.reply_guard") {
        wake.replyGuard.total++;
        if (props.accepted === false) wake.replyGuard.blocked++;
        else if (props.accepted === true) wake.replyGuard.accepted++;
      }
      if (tag) {
        const entry = errors[tag] ??= { count: 0 };
        entry.count++;
        // Reuse sanitized IDs only, never text from a malformed fixture line.
        for (const [key, value] of Object.entries(ids)) {
          if (idKeys.has(key) && safeId(key, value)) {
            entry.sampleId ??= value;
            break;
          }
        }
        // A helper can also carry its parent watcher ID. Attribute once to the immediate source.
        const source = helper ? "helper" : "watcher", id = helper ?? watcher;
        if (id) {
          const key = JSON.stringify([tag, source, id]);
          const error = sourceErrors.get(key) ?? { tag, source, id, count: 0 };
          error.count++;
          sourceErrors.set(key, error);
        }
      }
    }
    const timing = Object.fromEntries(Object.entries(durations).map(([name, samples]) => {
      samples.sort((a, b) => a - b);
      return [name, { count: samples.length, p50: samples[Math.ceil(samples.length * .5) - 1], p95: samples[Math.ceil(samples.length * .95) - 1], max: samples.at(-1) }];
    }));
    const watcherTotals = { watchers: watchers.size, runs: 0, outcomes: outcomes(), fires: 0 };
    for (const stats of watchers.values()) {
      watcherTotals.runs += stats.runs;
      watcherTotals.fires += stats.fires;
      for (const outcome of ["no_change", "fire", "fail", "timeout"] as const) watcherTotals.outcomes[outcome] += stats.outcomes[outcome];
    }
    const helperTotals = { helpers: helpers.size, runs: 0, failures: 0, exitCodes: Object.create(null) as Record<string, number> };
    for (const stats of helpers.values()) {
      helperTotals.runs += stats.runs;
      helperTotals.failures += stats.failures;
      for (const [code, count] of Object.entries(stats.exitCodes)) helperTotals.exitCodes[code] = (helperTotals.exitCodes[code] ?? 0) + count;
    }
    // Bound both source lists; totals still include sources omitted from the compact report.
    const byWatcher = Object.fromEntries([...watchers].sort(byRuns).slice(0, 40).map(([id, stats]) => [id, {
      runs: stats.runs, outcomes: stats.outcomes, fires: stats.fires, durationMs: percentiles(stats.durations), queuedMs: { p95: percentiles(stats.queued).p95 },
      longestFailStreak: stats.longestFailStreak, lastFailureTag: stats.lastFailureTag,
    }]));
    const byHelper = Object.fromEntries([...helpers].sort(byRuns).slice(0, 40).map(([id, stats]) => [id, {
      runs: stats.runs, failures: stats.failures, exitCodes: stats.exitCodes, durationMs: { p95: percentiles(stats.durations).p95 },
    }]));
    const errorsByTagAndSource = [...sourceErrors.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id)).slice(0, 20);
    const result = { day, tool: "watchers", total, counts, kinds, ok, failed, okRate: withOk ? ok / withOk : null, errorRate: total ? (kinds.error ?? 0) / total : 0, durations: timing,
      errors: Object.entries(errors).sort((a, b) => b[1].count - a[1].count).slice(0, 20).map(([tag, value]) => ({ tag, ...value })),
      byWatcher, watcherTotals, byHelper, helperTotals, errorsByTagAndSource, wake };
    const target = join(dir, `rollup-${day}.json`);
    writeFileSync(target, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 }); chmodSync(target, 0o600);
    return result;
  } catch { return undefined; }
}
