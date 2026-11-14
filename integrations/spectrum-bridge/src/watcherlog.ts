import { chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { logDirectory as bridgeLogDirectory } from "./log-directory.ts";
import { join } from "node:path";

export type LogEntry = {
  component: string; kind: "event" | "perf" | "error"; name: string;
  durationMs?: number; ok?: boolean; ids?: Record<string, unknown>; props?: Record<string, unknown>;
  error?: { tag: string; message?: string };
};
const token = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
const idKeys = new Set(["watcher", "run", "thread", "chat", "key", "operation", "reminder", "update", "item", "helper"]);
const numeric = new Set(["exitCode", "attempt", "count", "bytes", "queuedMs"]);
const boolean = new Set(["deduped", "accepted"]);
const values: Record<string, readonly string[]> = {
  severity: ["info", "attention", "error"], outcome: ["fire", "no_change", "fail", "timeout"],
  source: ["mail", "sms", "bank", "charge"], routed: ["board", "chat", "ignored"],
  class: ["urgent", "today", "info", "noise", "candidate", "charge", "bank", "security", "otp", "unknown", "fail_open", "deduped"],
  action: ["create", "queue", "cancel", "snooze", "sent", "retry", "check", "wake", "notify", "send", "coalesce", "conflict", "expire", "pause", "remove", "cap", "resume"],
  state: ["pending", "sending", "sent", "uncertain", "cancelled", "failed", "scheduled", "queued", "done", "expired", "paused", "active"],
};
export const logDirectory = () => bridgeLogDirectory("watchers");
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

export function toolError(component: string, tag: string, ids?: Record<string, unknown>): void {
  toolLog({ component, kind: "error", name: `${component}.error`, ok: false, ids, error: { tag } });
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
    const lines = createInterface({ input: createReadStream(join(dir, `${day}.ndjson`)), crlfDelay: Infinity });
    for await (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (!row || row.tool !== "watchers" || !token.test(row.name) || !["event", "perf", "error"].includes(row.kind)) continue;
      total++; counts[row.name] = (counts[row.name] ?? 0) + 1; kinds[row.kind] = (kinds[row.kind] ?? 0) + 1;
      if (typeof row.ok === "boolean") { withOk++; if (row.ok) ok++; else failed++; }
      if (typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0) (durations[row.name] ??= []).push(row.durationMs);
      if (row.error && token.test(row.error.tag)) {
        const tag = row.error.tag;
        const entry = errors[tag] ??= { count: 0 };
        entry.count++;
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
