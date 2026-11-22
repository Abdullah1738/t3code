import { chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, mkdtempSync, openSync, readdirSync, statSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { constants } from "node:os";
import { safeDependency } from "./cause.ts";
import { sanitizeGroupState } from "./check-groups.ts";

export type LogEntry = {
  component: string; kind: "event" | "perf" | "error"; name: string;
  durationMs?: number; ok?: boolean; ids?: Record<string, unknown>; props?: Record<string, unknown>;
  error?: { tag: string; message?: string };
};
const token = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
const idKeys = new Set(["watcher", "run", "thread", "chat", "key", "operation", "reminder", "update", "item", "helper", "meantFor"]);
const numeric = new Set(["exitCode", "timeoutMs", "attempt", "count", "threshold", "failures", "bytes", "queuedMs", "failedSources", "totalSources", "events", "waitMs", "spanMs", "graceMs", "relays", "slotWaitMs", "slotQueueDepth", "slotActiveAtEnqueue", "startLateMs", "intervalMs", "depth", "oldestWaitMs", "active", "cap", "dueAt", "lateMs", "load", "elapsedMs"]);
const boolean = new Set(["deduped", "accepted", "timedOut", "notified", "batched", "urgent", "closing", "archived", "frozenContext", "batchOpen", "grace", "loadMode", "sendDeferred"]);
const errnoCodes = new Set(Object.keys(constants.errno));
const signals = new Set(Object.keys(constants.signals));
const values: Record<string, readonly string[]> = {
  alertKind: ["pause", "failing", "recovered"],
  severity: ["info", "attention", "error"], outcome: ["fire", "no_change", "fail", "timeout", "busy", "stuck_previous", "accepted", "ambiguous", "deferred", "definite", "owner"],
  failureClass: ["control_api_unavailable", "timeout", "definite", "other"],
  source: ["mail", "sms", "bank", "charge"], routed: ["board", "chat", "ignored", "logged"],
  authKind: ["otp", "signin_link"],
  senderLabel: ["Emirates NBD", "Emirates Islamic", "Mashreq", "ADCB", "Wio", "Apple", "Google", "WHOOP", "Claude", "Virgin", "e&", "du", "your bank", "an inbox sender"],
  class: ["urgent", "today", "info", "noise", "candidate", "charge", "bank", "security", "otp", "unknown", "fail_open", "deduped"],
  action: ["create", "queue", "cancel", "snooze", "sent", "retry", "check", "wake", "notify", "send", "coalesce", "conflict", "expire", "pause", "remove", "cap", "resume"],
  state: ["pending", "sending", "sent", "uncertain", "cancelled", "failed", "scheduled", "queued", "done", "expired", "paused", "active"],
  stderrClass: ["usage_error", "missing_file", "permission", "timeout", "dependency_busy", "python_traceback", "auth", "connect", "json", "unknown"],
  triggerKind: ["file", "wal"],
  step: ["native", "status", "send"],
  op: ["native", "native_retry", "status", "status_retry", "send", "confirm"],
  route: ["person", "owner", "group", "creator", "other", "thread", "unverified", "refused"],
  via: ["wake", "thread", "imessage-send", "telegram", "none", "wake:owner-fallback", "native:pending"],
  confirmed: ["pending", "n/a"],
  operation: ["check", "pending"],
  lane: ["fast", "slow"],
  trigger: ["schedule", "trigger", "retry", "final"],
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

function logId(key: string, value: string | number): string {
  const text = String(value);
  // Names are needed for nightly attribution; arbitrary correlation IDs may contain private text.
  return (key === "watcher" || key === "helper") && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(text) && !/\d{5}/.test(text)
    ? text : createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function fields(entry: LogEntry, at: Date) {
  if (!token.test(entry.component) || !token.test(entry.name) || !["event", "perf", "error"].includes(entry.kind)) return undefined;
  const marker = entry.name === "deploy.marker" ? markerProps(entry.props) : undefined;
  if (entry.name === "deploy.marker" && (!marker || entry.kind !== "event")) return undefined;
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(marker ? {} : entry.ids ?? {})) {
    if (!idKeys.has(key) || (typeof value !== "string" && typeof value !== "number")) continue;
    ids[key] = logId(key, value);
  }
  const props: Record<string, unknown> = {};
  const fileEvent = ["data_read.retried", "data_read.failed", "data_write.retried", "data_write.failed", "runs_log.write_failed"].includes(entry.name);
  const stuckEvent = entry.component === "runner" && ["watch.skip", "watch.stuck_group", "watch.stuck_exited"].includes(entry.name);
  for (const [key, value] of Object.entries(entry.props ?? {})) {
    // Only triage supplies a bounded, credential-redacted classifier diagnostic.
    if (entry.component === "triage" && entry.name === "triage.classify" && key === "classifier_error"
      && typeof value === "string" && value.length <= 400 && !/[\x00-\x1f]/.test(value)) props[key] = value;
    else if (entry.name === "watch.pause_probe" && key === "error_first_line" && typeof value === "string") {
      props[key] = value.split(/[\r\n]/, 1)[0]!.replace(/[\x00-\x1f]/g, " ")
        .replace(/https?:\/\/\S+/gi, "[url]")
        .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[credential]")
        .replace(/((?:password|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|[^\s,;]+)/gi, "$1[redacted]")
        .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
    }
    else if ((entry.name === "watch.pause_probe" || entry.name === "watch.auto_resumed")
      && ["attempts", "paused_ms", "duration_ms"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) props[key] = value;
    else if (entry.name === "watch.pause_probe" && key === "ok" && typeof value === "boolean") props[key] = value;
    else if (entry.name === "watch.pause_probe" && key === "next_at" && typeof value === "string" && Number.isFinite(Date.parse(value))) props[key] = new Date(value).toISOString();
    else if (stuckEvent && key === "diagnostic" && typeof value === "string") props[key] = sanitizeGroupState(value);
    else if (stuckEvent && ["pgid", "pid", "killedAt", "ageMs"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) props[key] = value;
    else if (fileEvent && key === "path" && typeof value === "string" && value.length <= 1024 && value.startsWith("/") && !/[\x00-\x1f]/.test(value)) props[key] = value;
    else if (fileEvent && (key === "attempts" || key === "ms") && typeof value === "number" && Number.isFinite(value) && value >= 0) props[key] = value;
    else if (fileEvent && key === "dataless" && typeof value === "boolean") props[key] = value;
    else if (key === "holders" && (entry.name === "slot.wait" || entry.name === "slot.backlog") && Array.isArray(value)) {
      props[key] = value.slice(0, 100).flatMap(value => {
        const holder = record(value);
        return (typeof holder.watcher === "string" || typeof holder.watcher === "number") && milliseconds(holder.elapsedMs)
          ? [{ watcher: logId("watcher", holder.watcher), elapsedMs: holder.elapsedMs }] : [];
      });
    } else if (key === "dependency" && safeDependency(value)) props[key] = value;
    else if ((key === "exitCode" || key === "signal") && value === null) props[key] = null;
    else if (key === "stderrLines" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) props[key] = value;
    else if (key === "missingForS" && typeof value === "number" && Number.isFinite(value) && value >= 0) props[key] = value;
    else if ((key === "stderrHash" || key === "triggerPathHash") && typeof value === "string" && /^[a-f0-9]{16}$/.test(value)) props[key] = value;
    else if (key === "missingSince" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value) props[key] = value;
    else if (key === "errnoCode" && typeof value === "string" && (errnoCodes.has(value) || value === "UNKNOWN")) props[key] = value;
    else if (key === "signal" && typeof value === "string" && signals.has(value)) props[key] = value;
    else if ((entry.name === "watch.grace_ended" || entry.name === "watch.removed") && key === "reason" && typeof value === "string"
      && ["expired", "resume", "now", "paused", "no_inflight_check"].includes(value)) props[key] = value;
    else if (entry.name === "watch.route_checked" && key === "reason" && typeof value === "string"
      && ["no --session", "live owner session", "iMessage thread", "live thread", "not_found", "archived", "invalid_id", "invalid_thread", "invalid_session", "lookup unavailable"].includes(value)) props[key] = value;
    else if (entry.name === "watch.route_checked" && key === "durationMs" && typeof value === "number"
      && Number.isFinite(value) && value >= 0) props[key] = value;
    else if (entry.name === "wake.creator_fallback" && key === "reason" && typeof value === "string"
      && /^(?:timeout|invalid|archived|error|exit:\d{1,3})$/.test(value)) props[key] = value;
    else if (entry.name === "wake.creator_fallback" && key === "durationMs" && typeof value === "number"
      && Number.isFinite(value) && value >= 0) props[key] = value;
    else if (entry.name === "wake.send_delivered_late" && ["retries", "totalDelayMs"].includes(key)
      && typeof value === "number" && Number.isFinite(value) && value >= 0) props[key] = value;
    else if (typeof value === "string" && (key === "via" && /^thread:[A-Za-z0-9%_-]{1,8}$/.test(value)
      || key === "meant_for" && /^[A-Za-z0-9%_-]{1,8}$/.test(value))) props[key] = value;
    else if (numeric.has(key) && typeof value === "number" && Number.isFinite(value)) props[key] = value;
    else if (boolean.has(key) && typeof value === "boolean") props[key] = value;
    else if (typeof value === "string" && values[key]?.includes(value)) props[key] = value;
  }
  return {
    ts: at.toISOString(), tool: "watchers", component: entry.component, kind: entry.kind, name: entry.name,
    ...(typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) && entry.durationMs >= 0 ? { durationMs: entry.durationMs } : {}),
    ...(typeof entry.ok === "boolean" ? { ok: entry.ok } : {}),
    ...(Object.keys(ids).length ? { ids } : {}), ...(marker ? { props: marker } : Object.keys(props).length ? { props } : {}),
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
      if (entry.kind !== "error" && entry.name !== "deploy.marker") return;
    }
    appendLine(file, line);
  } catch { /* Logging cannot affect the caller. */ }
}

export function toolError(component: string, tag: string, ids?: Record<string, unknown>, props?: Record<string, unknown>): void {
  toolLog({ component, kind: "error", name: `${component}.error`, ok: false, ids, props, error: { tag } });
}

// Only release metadata belongs here; never accept command lines, paths or arbitrary text.
function markerProps(value: unknown) {
  const props = record(value);
  const { service, sha, step } = props;
  if (typeof service !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(service) || /\d{5}/.test(service)
    || typeof step !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(step) || /\d{5}/.test(step)
    || typeof sha !== "string" || !/^(?:[a-f0-9]{7,40}|[a-f0-9]{64})$/.test(sha)) return undefined;
  return { service, sha, step };
}

export function logMarker(props: unknown): void {
  try {
    const safe = markerProps(props);
    if (safe) toolLog({ component: "deploy", kind: "event", name: "deploy.marker", props: safe });
  } catch { /* A marker must never interrupt a release. */ }
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeId = (key: string, value: unknown): value is string => typeof value === "string" && (
  /^[a-f0-9]{24}$/.test(value) || ((key === "watcher" || key === "helper") && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value) && !/\d{5}/.test(value))
);
const milliseconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const outcomes = () => ({ no_change: 0, fire: 0, fail: 0, timeout: 0, busy: 0 });
function percentiles(samples: number[]) {
  samples.sort((a, b) => a - b);
  return { p50: samples[Math.ceil(samples.length * .5) - 1] ?? null, p95: samples[Math.ceil(samples.length * .95) - 1] ?? null, max: samples.at(-1) ?? null };
}
function watcherStats() {
  return { runs: 0, actualRuns: 0, intervals: [] as { at: number; ms: number }[], lates: [] as number[], fires: 0, outcomes: outcomes(), durations: [] as number[], queued: [] as number[], slotWaits: [] as number[], lateRuns: 0, failStreak: 0, longestFailStreak: 0, lastFailureTag: null as string | null };
}
function helperStats() {
  return { runs: 0, failures: 0, exitCodes: Object.create(null) as Record<string, number>, durations: [] as number[] };
}
const byRuns = (a: [string, { runs: number }], b: [string, { runs: number }]) => b[1].runs - a[1].runs || a[0].localeCompare(b[0]);

export type LogWindow = { since: string; until: string };
const HALF_HOUR = 30 * 60_000;

function isoTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return undefined;
  const date = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== match[1]) return undefined;
  if (match[5] !== "Z" && (Number(match[5]!.slice(1, 3)) > 23 || Number(match[5]!.slice(4)) > 59)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

type SourceError = { tag: string; source: string; id: string; count: number };
const byErrors = (a: SourceError, b: SourceError) => b.count - a.count || a.tag.localeCompare(b.tag) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id);
function countSource(map: Map<string, SourceError>, tag: string, source: string, id: string) {
  const key = JSON.stringify([tag, source, id]);
  const entry = map.get(key) ?? { tag, source, id, count: 0 };
  entry.count++;
  map.set(key, entry);
}

export async function rollup(selection: string | LogWindow, dir = logDirectory(), out?: string) {
  try {
    const day = typeof selection === "string" ? selection : undefined;
    if (day !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)) return undefined;
    const window = typeof selection === "string" ? undefined : selection;
    const since = isoTime(window?.since ?? `${day}T00:00:00Z`);
    const until = window ? isoTime(window.until) : since === undefined ? undefined : since + 86400_000;
    if (since === undefined || until === undefined || since >= until) return undefined;
    // Atomic replacement also prevents an --out symlink/hardlink from overwriting a day file.
    if (out && ((window && /^rollup-\d{4}-\d{2}-\d{2}\.json$/i.test(basename(out))) || /\.ndjson$/i.test(basename(out)))) return undefined;
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");
    const counts: Record<string, number> = Object.create(null), kinds: Record<string, number> = Object.create(null);
    const durations: Record<string, number[]> = Object.create(null);
    const errors: Record<string, number> = Object.create(null);
    const watchers = new Map<string, ReturnType<typeof watcherStats>>();
    const dependencies = new Map<string, { busyRuns: number; watchers: Set<string> }>();
    const helpers = new Map<string, ReturnType<typeof helperStats>>();
    const sourceErrors = new Map<string, SourceError>();
    const hours = new Map<string, { errors: Map<string, SourceError>; runs: number; fail: number; timeout: number; durations: number[] }>();
    const markers: { ts: string; service: string; sha: string; step: string }[] = [];
    const errorTimes: number[] = [];
    const wake = { sent: 0, failed: 0, attempts: 0, replyGuard: { total: 0, blocked: 0, accepted: 0 } };
    let allSlotsBusyMs = 0;
    let loadModeMs = 0, loadModeSwitches = 0;
    const slotHolders = new Map<string, number>();
    let total = 0, ok = 0, failed = 0, withOk = 0;
    // Read the halo too so marker comparisons retain their full 30 minutes across UTC midnight.
    let files: string[];
    try { files = readdirSync(dir); }
    catch (error) {
      if (record(error).code !== "ENOENT") throw error;
      files = [];
    }
    // Cadence headers are daily; keep the prior UTC day even for later windows.
    const firstDay = new Date(since - 86400_000).toISOString().slice(0, 10);
    const lastDay = new Date(until + HALF_HOUR - 1).toISOString().slice(0, 10);
    const days = new Set(files.filter(name => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name) && name.slice(0, 10) >= firstDay && name.slice(0, 10) <= lastDay));
    if (day) days.add(`${day}.ndjson`);
    for (const file of [...days].sort()) {
      const source = join(dir, file);
      try { statSync(source); }
      catch (error) { if (record(error).code === "ENOENT") continue; throw error; }
      const lines = createInterface({ input: createReadStream(source), crlfDelay: Infinity });
      for await (const line of lines) {
        let row; try { row = record(JSON.parse(line)); } catch { continue; }
        if (row.tool !== "watchers" || typeof row.name !== "string" || !token.test(row.name) || typeof row.kind !== "string" || !["event", "perf", "error"].includes(row.kind)) continue;
        const ts = isoTime(row.ts);
        if (ts !== undefined && ts >= since - HALF_HOUR && ts < until + HALF_HOUR && row.kind === "error") errorTimes.push(ts);
        // Usage is flushed at least once a minute, including while a check spans midnight.
        if (ts !== undefined && milliseconds(row.durationMs) && (row.name === "slot.busy" || row.name === "slot.hold")) {
          const overlap = Math.max(0, Math.min(ts, until) - Math.max(ts - row.durationMs, since));
          if (row.name === "slot.busy") allSlotsBusyMs += overlap;
          else {
            const id = record(row.ids).watcher;
            if (safeId("watcher", id)) slotHolders.set(id, (slotHolders.get(id) ?? 0) + overlap);
          }
        }
        if (ts !== undefined && row.name === "host.load_time" && milliseconds(row.durationMs)) {
          loadModeMs += Math.max(0, Math.min(ts, until) - Math.max(ts - row.durationMs, since));
        }
        // Interval metadata survives an empty window and includes watchers with no
        // completed checks. Never read today's live definitions to explain history.
        if ((row.name === "watch.cadence" || row.name === "watch.run") && ts !== undefined && ts < until) {
          const id = record(row.ids).watcher, ms = record(row.props).intervalMs;
          if (safeId("watcher", id) && milliseconds(ms) && ms > 0) {
            const stats = watchers.get(id) ?? watcherStats();
            watchers.set(id, stats);
            if (stats.intervals.at(-1)?.ms !== ms) stats.intervals.push({ at: ts, ms });
          }
        }
        // Legacy day fixtures without timestamps still contribute to daily totals only.
        if (window ? ts === undefined || ts < since || ts >= until : file !== `${day}.ndjson`) continue;
        let hour;
        if (ts !== undefined && ts >= since && ts < until) {
          const key = new Date(ts).toISOString().slice(0, 13) + ":00:00Z";
          hour = hours.get(key) ?? { errors: new Map<string, SourceError>(), runs: 0, fail: 0, timeout: 0, durations: [] as number[] };
          hours.set(key, hour);
        }
        total++; counts[row.name] = (counts[row.name] ?? 0) + 1; kinds[row.kind] = (kinds[row.kind] ?? 0) + 1;
        if (row.name === "host.load_mode" && typeof record(row.props).loadMode === "boolean") loadModeSwitches++;
        if (typeof row.ok === "boolean") { withOk++; if (row.ok) ok++; else failed++; }
        if (milliseconds(row.durationMs)) (durations[row.name] ??= []).push(row.durationMs);
        const ids = record(row.ids), props = record(row.props), error = record(row.error);
        const watcher = safeId("watcher", ids.watcher) ? ids.watcher : undefined;
        const helper = safeId("helper", ids.helper) ? ids.helper : undefined;
        const tag = typeof error.tag === "string" && token.test(error.tag) ? error.tag : undefined;
        const sourceKind = helper ? "helper" : watcher ? "watcher" : "component";
        const sourceId = helper ?? watcher ?? (typeof row.component === "string" && token.test(row.component) ? row.component : "unknown");
        if (row.kind === "error" && hour) countSource(hour.errors, tag ?? row.name, sourceKind, sourceId);
        if (row.name === "deploy.marker" && row.kind === "event" && ts !== undefined) {
          const props = markerProps(row.props);
          if (props) markers.push({ ts: new Date(ts).toISOString(), ...props });
        }
        // Only deliverPending emits this after success. wake.sent also includes failure escalations.
        if (row.name === "watch.fire" && row.ok === true) {
          const id = watcher ?? "unknown", stats = watchers.get(id) ?? watcherStats();
          watchers.set(id, stats);
          stats.fires++;
        }
        if (row.name === "watch.run") {
          if (hour) {
            hour.runs++;
            if (props.outcome === "timeout") hour.timeout++;
            else if (props.outcome === "fail" || (row.ok === false && props.outcome !== "busy")) hour.fail++;
            if (milliseconds(row.durationMs)) hour.durations.push(row.durationMs);
          }
          const id = watcher ?? "unknown", stats = watchers.get(id) ?? watcherStats();
          watchers.set(id, stats);
          stats.runs++;
          if (props.trigger === undefined || props.trigger === "schedule") stats.actualRuns++;
          if (milliseconds(props.lateMs)) stats.lates.push(props.lateMs);
          const outcome = props.outcome;
          if (outcome === "no_change" || outcome === "fire" || outcome === "fail" || outcome === "timeout" || outcome === "busy") stats.outcomes[outcome]++;
          if (outcome === "busy" && safeDependency(props.dependency)) {
            const dependency = dependencies.get(props.dependency) ?? { busyRuns: 0, watchers: new Set<string>() };
            dependencies.set(props.dependency, dependency);
            dependency.busyRuns++;
            dependency.watchers.add(id);
          }
          if (milliseconds(row.durationMs)) stats.durations.push(row.durationMs);
          if (milliseconds(props.queuedMs)) stats.queued.push(props.queuedMs);
          // Runs for one watcher are serialized; helper errors and delivery retries are not new runs.
          if (outcome === "fail" || outcome === "timeout" || row.ok === false) {
            stats.longestFailStreak = Math.max(stats.longestFailStreak, ++stats.failStreak);
            stats.lastFailureTag = tag ?? null;
          } else if (outcome === "no_change" || outcome === "fire" || row.ok === true) stats.failStreak = 0;
        }
        if (row.name === "slot.start" && watcher) {
          const stats = watchers.get(watcher) ?? watcherStats();
          watchers.set(watcher, stats);
          if (milliseconds(props.slotWaitMs)) stats.slotWaits.push(props.slotWaitMs);
          if (milliseconds(props.startLateMs) && milliseconds(props.intervalMs) && props.intervalMs > 0 && props.startLateMs > props.intervalMs) stats.lateRuns++;
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
          else if (row.ok === false && props.accepted !== true) wake.failed++;
        } else if (row.name === "wake.confirmed") {
          wake.sent++;
        } else if (row.name === "wake.unconfirmed") {
          wake.failed++;
        } else if (row.name === "wake.reply_guard") {
          wake.replyGuard.total++;
          if (props.accepted === false) wake.replyGuard.blocked++;
          else if (props.accepted === true) wake.replyGuard.accepted++;
        }
        if (tag) {
          errors[tag] = (errors[tag] ?? 0) + 1;
          countSource(sourceErrors, tag, sourceKind, sourceId);
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
      for (const outcome of ["no_change", "fire", "fail", "timeout", "busy"] as const) watcherTotals.outcomes[outcome] += stats.outcomes[outcome];
    }
    const helperTotals = { helpers: helpers.size, runs: 0, failures: 0, exitCodes: Object.create(null) as Record<string, number> };
    for (const stats of helpers.values()) {
      helperTotals.runs += stats.runs;
      helperTotals.failures += stats.failures;
      for (const [code, count] of Object.entries(stats.exitCodes)) helperTotals.exitCodes[code] = (helperTotals.exitCodes[code] ?? 0) + count;
    }
    const cadenceStats = (stats: ReturnType<typeof watcherStats>) => {
      let expected = 0, from = since;
      const intervals = [...stats.intervals].sort((a, b) => a.at - b.at);
      let interval = intervals[0]?.ms;
      for (const entry of intervals) {
        if (entry.at > since) {
          expected += (Math.min(entry.at, until) - from) / interval!;
          from = Math.min(entry.at, until);
        }
        interval = entry.ms;
      }
      if (interval !== undefined) expected += (until - from) / interval;
      const expectedRuns = interval === undefined ? null : Math.floor(expected);
      return { expectedRuns, actualRuns: stats.actualRuns, missedTicks: expectedRuns === null ? null : Math.max(0, expectedRuns - stats.actualRuns), lateMs: percentiles(stats.lates) };
    };
    // Keep every known interval watcher visible even when it completed zero runs.
    // Legacy sources without cadence metadata retain the existing compact top 40.
    const byWatcher = Object.fromEntries([...watchers].sort(byRuns).filter(([, stats], i) => i < 40 || stats.intervals.length).map(([id, stats]) => [id, {
      runs: stats.runs, outcomes: stats.outcomes, fires: stats.fires, durationMs: percentiles(stats.durations), queuedMs: { p95: percentiles(stats.queued).p95 },
      ...cadenceStats(stats),
      longestFailStreak: stats.longestFailStreak, lastFailureTag: stats.lastFailureTag,
      slotWaitMs: { count: stats.slotWaits.length, total: stats.slotWaits.reduce((sum, ms) => sum + ms, 0), p95: percentiles(stats.slotWaits).p95 }, lateRuns: stats.lateRuns,
    }]));
    const byHelper = Object.fromEntries([...helpers].sort(byRuns).slice(0, 40).map(([id, stats]) => [id, {
      runs: stats.runs, failures: stats.failures, exitCodes: stats.exitCodes, durationMs: { p95: percentiles(stats.durations).p95 },
    }]));
    const errorsByTagAndSource = [...sourceErrors.values()].sort(byErrors).slice(0, 20);
    const hourly = [...hours].sort(([a], [b]) => a.localeCompare(b)).map(([hour, stats]) => ({
      hour, errors: [...stats.errors.values()].sort(byErrors).slice(0, 10),
      watchRun: { count: stats.runs, fail: stats.fail, timeout: stats.timeout, p95: percentiles(stats.durations).p95 },
    }));
    errorTimes.sort((a, b) => a - b);
    function lowerBound(time: number) {
      let lo = 0, hi = errorTimes.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (errorTimes[mid]! < time) lo = mid + 1; else hi = mid; }
      return lo;
    }
    const rate = (start: number, end: number) => {
      const errors = lowerBound(end) - lowerBound(start);
      return { errors, minutes: 30, errorsPerMinute: errors / 30, complete: end <= Date.now() };
    };
    const deployMarkers = markers.sort((a, b) => a.ts.localeCompare(b.ts)).map(marker => {
      const at = Date.parse(marker.ts);
      return { ...marker, before: rate(at - HALF_HOUR, at), after: rate(at, at + HALF_HOUR) };
    });
    const result = { ...(window ? { since: new Date(since).toISOString(), until: new Date(until).toISOString() } : { day }), tool: "watchers", total, counts, kinds, ok, failed, okRate: withOk ? ok / withOk : null, errorRate: total ? (kinds.error ?? 0) / total : 0, durations: timing,
      errors: Object.entries(errors).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([tag, count]) => ({ tag, count,
        topSources: [...sourceErrors.values()].filter(source => source.tag === tag).sort(byErrors).slice(0, 3).map(({ source, id, count }) => ({ source, id, count })),
      })),
      byDependency: Object.fromEntries([...dependencies].sort(([a, x], [b, y]) => y.busyRuns - x.busyRuns || a.localeCompare(b)).slice(0, 20)
        .map(([name, stats]) => [name, { busyRuns: stats.busyRuns, watchers: stats.watchers.size }])),
      dependencyTotals: { dependencies: dependencies.size, busyRuns: [...dependencies.values()].reduce((total, stats) => total + stats.busyRuns, 0) },
      byWatcher, watcherTotals, byHelper, helperTotals, errorsByTagAndSource, wake, hourly, markers: deployMarkers,
      loadMode: { minutes: loadModeMs / 60_000, switches: loadModeSwitches },
      slots: { allSlotsBusyMinutes: allSlotsBusyMs / 60_000, topHolders: [...slotHolders].filter(([, ms]) => ms > 0).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, 20).map(([watcher, ms]) => ({ watcher, slotSeconds: ms / 1000 })) } };
    const target = out ?? (day ? join(dir, `rollup-${day}.json`) : undefined);
    if (target) {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const scratch = mkdtempSync(join(dirname(target), ".rollup-"));
      try {
        const temp = join(scratch, "result.json");
        writeFileSync(temp, JSON.stringify(result) + "\n", { mode: 0o600 });
        renameSync(temp, target);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
    return result;
  } catch { return undefined; }
}
