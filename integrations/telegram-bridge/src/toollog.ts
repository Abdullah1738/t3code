import { expandTelemetry } from "./log-format.ts";
import { chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { STREAM_END_KINDS, STREAM_ERROR_CODE } from "./stream-telemetry.ts";

export type LogEntry = {
  component: string; kind: "event" | "perf" | "error"; name: string;
  durationMs?: number; ok?: boolean; ids?: Record<string, unknown>; props?: Record<string, unknown>;
  error?: { tag: string; message?: string };
};
const token = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
const idKeys = new Set(["watcher", "run", "thread", "chat", "key", "operation", "reminder", "update", "item", "helper", "directory"]);
const numeric = new Set(["exitCode", "attempt", "count", "bytes", "queuedMs", "repeats", "windowMs"]);
const boolean = new Set(["deduped", "accepted"]);
const values: Record<string, readonly string[]> = {
  severity: ["info", "attention", "error"], outcome: ["fire", "no_change", "fail", "timeout"],
  source: ["mail", "sms", "bank", "charge"], routed: ["board", "chat", "ignored"],
  class: ["urgent", "today", "info", "noise", "candidate", "charge", "bank", "security", "otp", "unknown", "fail_open", "deduped"],
  action: ["create", "queue", "cancel", "snooze", "sent", "retry", "check", "wake", "notify", "send", "coalesce", "conflict", "expire", "pause", "remove", "cap", "resume"],
  state: ["pending", "sending", "sent", "uncertain", "cancelled", "failed", "scheduled", "queued", "done", "expired", "paused", "active"],
};
export const logDirectory = () => process.env.TOOLLOG_DIR ?? join(homedir(), ".robob/logs/tools/watchers");
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
    if (key === "exitCode" && value === null) props[key] = null;
    else if (entry.name === "tg.robob.streamEnd" && key === "kind" && STREAM_END_KINDS.includes(value as typeof STREAM_END_KINDS[number])) props[key] = String(value);
    else if (entry.name === "tg.robob.streamEnd" && key === "connectedMs"
      && (value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0))) props[key] = value;
    else if (entry.name === "tg.robob.streamEnd" && key === "code" && typeof value === "string" && STREAM_ERROR_CODE.test(value)) props[key] = value;
    else if (key === "cause" && safeCause(value)) props[key] = value;
    else if (key === "detail" && safeDetail(value)) props[key] = value;
    else if (key === "errorClass" && typeof value === "string" && errorClasses.has(value)) props[key] = value;
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

const DROP_HOUR = 3_600_000;
let capDrops: { file: string; day: string; since: number; dropped: Record<string, number> } | undefined;
function flushCapDrops(at: Date, force = false): void {
  if (!capDrops || (!force && at.getTime() - capDrops.since < DROP_HOUR)) return;
  const pending = capDrops;
  if (Object.keys(pending.dropped).length) appendLine(pending.file, {
    ts: new Date(Math.min(at.getTime(), Date.parse(`${pending.day}T23:59:59.999Z`))).toISOString(),
    tool: "watchers", component: "logger", kind: "error", name: "log.capDropped",
    props: { dropped: pending.dropped, since: new Date(pending.since).toISOString() },
  });
  capDrops = { ...pending, since: at.getTime(), dropped: Object.create(null) };
}
function countCapDrop(file: string, day: string, at: Date, entry: LogEntry): void {
  capDrops ??= { file, day, since: at.getTime(), dropped: Object.create(null) };
  const key = `${entry.component}:${entry.kind}:${entry.name}`;
  const target = Object.hasOwn(capDrops.dropped, key) || Object.keys(capDrops.dropped).filter(key => key !== "other").length < 50 ? key : "other";
  capDrops.dropped[target] = (capDrops.dropped[target] ?? 0) + 1;
}

export function toolLog(entry: LogEntry, at = new Date()): void {
  try {
    if ((process.env.ROBOB_TEST || process.env.NODE_ENV === "test" || process.env.PYTEST_CURRENT_TEST) && !process.env.TOOLLOG_DIR) return;
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
    if (capDrops && capDrops.file !== file) {
      if (dirname(capDrops.file) === dir && existsSync(capDrops.file)) flushCapDrops(at, true);
      capDrops = undefined;
    }
    flushCapDrops(at);
    const size = existsSync(file) ? statSync(file).size : 0;
    if (size > CAP) {
      try {
        const marker = openSync(join(dir, `${day}.cap`), "wx", 0o600); closeSync(marker);
        appendLine(file, { ts: at.toISOString(), tool: "watchers", component: "logger", kind: "error", name: "log.cap", ok: false, error: { tag: "log.cap", message: "log.cap" } });
      } catch { /* Another component already recorded the cap. */ }
      if (entry.kind !== "error") { countCapDrop(file, day, at, entry); return; }
    }
    appendLine(file, line);
  } catch { /* Logging cannot affect the caller. */ }
}

// Diagnostics are vocabulary, never exception text (even constructor names can be private).
const causeCodes = new Set(["unclassified", "abort", "timeout", "decode", "schema", "socket_closed", "non_error", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENOENT", "ENOTDIR", "EACCES", "EPERM", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"]);
const errorClasses = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError", "DOMException", "AssertionError", "ControlError", "ApiError", "TransportError", "GrammyError", "HttpError", "ZodError", "ValidationError", "SchemaError", "ParseError", "Object", "Array", "String", "Number", "Boolean", "BigInt", "Symbol", "Function", "Null", "Undefined"]);
const schemaClasses = new Set(["ZodError", "ValidationError", "SchemaError", "ParseError"]);
const cancellationCodes = new Set(["ABORT_ERR", "ERR_CANCELED"]);
const socketCodes = new Set(["ERR_SOCKET_CLOSED", "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_SOCKET", "ConnectionClosed", "SocketClosed"]);
// Bun reports errno 0 for both refused TCP and missing Unix sockets, so ENOENT cannot be inferred.
const bunFetchCauses = new Map([["ConnectionRefused", "ECONNREFUSED"], ["FailedToOpenSocket", "ECONNREFUSED"]]);
const detailValues = new Set([...causeCodes, ...errorClasses, ...cancellationCodes, ...socketCodes, ...bunFetchCauses.keys(), "AbortError", "TimeoutError"]);
export type ErrorCause = string | number;
export type ErrorInfo = { cause: ErrorCause; detail: string; errorClass?: string };
function safeCause(value: unknown): value is ErrorCause {
  return typeof value === "number" ? Number.isInteger(value) && value >= 100 && value <= 599
    : typeof value === "string" && causeCodes.has(value);
}
function safeDetail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && (detailValues.has(value) || /^HTTP [1-5][0-9]{2}$/.test(value));
}
function constructorClass(error: unknown): string {
  if (error === null) return "Null";
  if (error === undefined) return "Undefined";
  const primitiveClasses: Record<string, string> = { string: "String", number: "Number", boolean: "Boolean", bigint: "BigInt", symbol: "Symbol", function: "Function" };
  const primitive = primitiveClasses[typeof error];
  if (primitive) return primitive;
  try {
    const name: unknown = Object.getPrototypeOf(error)?.constructor?.name;
    if (typeof name === "string" && errorClasses.has(name)) return name;
    // Custom classes are reduced to their base class rather than logging a possibly private name.
    return error instanceof Error ? "Error" : "Object";
  } catch { return "Object"; }
}
function infoForCause(cause: ErrorCause, error: unknown, detail?: unknown): ErrorInfo {
  const errorClass = constructorClass(error);
  return { cause, detail: safeDetail(detail) ? detail : typeof cause === "number" ? `HTTP ${cause}` : cause === "unclassified" ? errorClass : cause,
    ...(cause === "unclassified" ? { errorClass } : {}) };
}

export function errorInfo(error: unknown): ErrorInfo {
  const chain: Array<{ code?: unknown; name?: unknown }> = [];
  try {
    let current = error;
    for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
      const row = current as { causeClass?: unknown; diagnostic?: ErrorInfo; status?: unknown; code?: unknown; name?: unknown; cause?: unknown };
      chain.push(row);
      if (safeCause(row.causeClass)) {
        const saved = row.diagnostic;
        if (saved?.cause === row.causeClass && safeDetail(saved.detail)
          && (saved.cause !== "unclassified" || (typeof saved.errorClass === "string" && errorClasses.has(saved.errorClass)))) {
          return { cause: saved.cause, detail: saved.detail, ...(saved.cause === "unclassified" ? { errorClass: saved.errorClass } : {}) };
        }
        return infoForCause(row.causeClass, current);
      }
      if (row.name === "TimeoutError") return infoForCause("timeout", current, row.name);
      if (row.name === "AbortError") return infoForCause("abort", current, row.name);
      if (row.name === "SyntaxError" || row.name === "AssertionError" || row.name === "URIError") return infoForCause("decode", current, row.name);
      if (typeof row.status === "number" && safeCause(row.status)) return infoForCause(row.status, current);
      if (typeof row.code === "string" && causeCodes.has(row.code)) return infoForCause(row.code, current, row.code);
      if (typeof row.code === "string") {
        const cause = bunFetchCauses.get(row.code);
        if (cause) return infoForCause(cause, current, row.code);
      }
      current = row.cause;
    }
    // Existing cause precedence wins, including a known errno nested inside a new error shape.
    for (const row of chain) {
      if (typeof row.name === "string" && schemaClasses.has(row.name)) return infoForCause("schema", error, row.name);
      if (typeof row.code === "string" && cancellationCodes.has(row.code)) return infoForCause("abort", error, row.code);
      if (typeof row.code === "string" && socketCodes.has(row.code)) return infoForCause("socket_closed", error, row.code);
    }
  } catch { /* Error properties need not be safe to read. */ }
  if (error === null || (typeof error !== "object")) return infoForCause("non_error", error, constructorClass(error));
  return infoForCause("unclassified", error);
}

export function errorCause(error: unknown): ErrorCause {
  return errorInfo(error).cause;
}

const ERROR_WINDOW = 60_000;
type ErrorWindow = { component: string; tag: string; props: ErrorInfo; at: number; repeats: number; lastAt: number; dir: string };
const errorWindows = new Map<string, ErrorWindow>();
function flushErrorWindow(window: ErrorWindow, at: number): void {
  if (window.repeats) toolLog({ component: window.component, kind: "error", name: `${window.component}.error`, ok: false,
    props: { ...window.props, repeats: window.repeats, windowMs: Math.max(0, at - window.at) }, error: { tag: window.tag } }, new Date(window.lastAt));
}
export function flushToolErrors(at = Date.now(), force = false): void {
  for (const [key, window] of errorWindows) {
    if (window.dir !== logDirectory()) { errorWindows.delete(key); continue; }
    if (force || at - window.at >= ERROR_WINDOW || Math.floor(at / 3_600_000) !== Math.floor(window.at / 3_600_000)) {
      flushErrorWindow(window, at);
      errorWindows.delete(key);
    }
  }
}
const errorFlushTimer = setInterval(() => { try { flushToolErrors(); flushCapDrops(new Date()); } catch { /* Best effort telemetry. */ } }, ERROR_WINDOW);
errorFlushTimer.unref();
process.once("exit", () => flushToolErrors(Date.now(), true));

export function toolError(component: string, tag: string, ids?: Record<string, unknown>, error?: unknown): void {
  try {
    const at = Date.now(), props = errorInfo(error);
    flushToolErrors(at);
    const key = JSON.stringify([component, tag, props.cause, props.detail]);
    const window = errorWindows.get(key);
    if (window) { window.repeats++; window.lastAt = at; return; }
    toolLog({ component, kind: "error", name: `${component}.error`, ok: false, ids, props, error: { tag } });
    if (errorWindows.size < 200) errorWindows.set(key, { component, tag, props, at, repeats: 0, lastAt: at, dir: logDirectory() });
  } catch { /* Error telemetry cannot affect its caller. */ }
}

// Summary lines represent suppressed occurrences, not an additional error.
export function errorOccurrences(row: { kind?: unknown; props?: { repeats?: unknown } }): number {
  const repeats = row.props?.repeats;
  return row.kind === "error" && typeof repeats === "number" && Number.isSafeInteger(repeats) && repeats > 0 ? repeats : 1;
}

export async function rollup(day: string, dir = logDirectory()) {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return undefined;
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");
    const counts: Record<string, number> = Object.create(null), kinds: Record<string, number> = Object.create(null);
    const durations: Record<string, number[]> = Object.create(null);
    const errors: Record<string, { count: number; sampleId?: string }> = Object.create(null);
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
      let input; try { input = JSON.parse(line); } catch { continue; }
      if (!input || typeof input !== "object") continue;
      for (const expanded of expandTelemetry(input)) {
        const row = expanded as LogEntry & { tool?: string };
        if (!row || row.tool !== "watchers" || !token.test(row.name) || !["event", "perf", "error"].includes(row.kind)) continue;
        const occurrences = errorOccurrences(row);
        total += occurrences; counts[row.name] = (counts[row.name] ?? 0) + occurrences; kinds[row.kind] = (kinds[row.kind] ?? 0) + occurrences;
        if (typeof row.ok === "boolean") { withOk += occurrences; if (row.ok) ok += occurrences; else failed += occurrences; }
        if (typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0) (durations[row.name] ??= []).push(row.durationMs);
        if (row.error && token.test(row.error.tag)) {
          const tag = row.error.tag;
          const entry = errors[tag] ??= { count: 0 };
          entry.count += occurrences;
          // Reuse sanitized IDs only, never text from a malformed fixture line.
          if (row.ids && typeof row.ids === "object") for (const [key, value] of Object.entries(row.ids)) {
            if (!idKeys.has(key) || typeof value !== "string") continue;
            if (/^[a-f0-9]{24}$/.test(value) || ((key === "watcher" || key === "helper") && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value) && !/\d{5}/.test(value))) {
              entry.sampleId ??= value;
              break;
            }
          }
        }
    }
    }
    const timing = Object.fromEntries(Object.entries(durations).map(([name, samples]) => {
      samples.sort((a, b) => a - b);
      return [name, { count: samples.length, p50: samples[Math.ceil(samples.length * .5) - 1], p95: samples[Math.ceil(samples.length * .95) - 1], max: samples.at(-1) }];
    }));
    const result = { day, tool: "watchers", total, counts, kinds, ok, failed, okRate: withOk ? ok / withOk : null, errorRate: total ? (kinds.error ?? 0) / total : 0, durations: timing,
      errors: Object.entries(errors).sort((a, b) => b[1].count - a[1].count).slice(0, 20).map(([tag, value]) => ({ tag, ...value })) };
    const target = join(dir, `rollup-${day}.json`);
    writeFileSync(target, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 }); chmodSync(target, 0o600);
    return result;
  } catch { return undefined; }
}
