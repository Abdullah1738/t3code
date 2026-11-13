import { safeLineFailureCode, sendblueErrorKey } from "./line.ts";
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, fchmodSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile, readFile, rename, unlink } from "node:fs/promises";
import { logDirectory } from "./log-directory.ts";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type LogLine = {
  ts: string; tool: "imessage"; component: string; kind: "event" | "perf" | "error"; name: string;
  durationMs?: number; ok?: boolean; ids?: Record<string, string>; props?: Record<string, string | number | boolean>;
  error?: { tag: string; message: string };
};
type Entry = Omit<LogLine, "ts" | "tool">;
const processRunId = randomUUID();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TAG = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,99}$/;
const LABEL = /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/;
const ID_KEYS = new Set(["chat", "messageId", "threadId", "operationId", "formId", "runId"]);
const NUMBERS = new Set(["attachmentCount", "attachmentBytes", "receiveLagMs", "batchSize", "filesTaken", "waitMs", "outboxDelayMs", "parts", "files", "count", "status", "exitCode", "labels"]);
const ENUMS: Record<string, readonly string[]> = {
  replyMode: ["final", "tool"], reason: ["background", "no_text", "already_folded", "exit", "stdout", "hook"],
  source: ["live", "backfill"], outcome: ["replied", "failed", "refused", "no_reply"],
  cardKind: ["quick", "delivery", "ride", "nutrition", "other"], phase: ["start", "stop"],
  method: ["GET", "POST", "PUT", "DELETE", "PATCH"],
};

// Deliberately do not serialize input objects or Error.message: either can contain a whole prompt or credential.
function clean(entry: Entry, ts: string, runId?: string): LogLine | undefined {
  if (!LABEL.test(entry.component) || !LABEL.test(entry.name) || !["event", "perf", "error"].includes(entry.kind)) return;
  const line: LogLine = { ts, tool: "imessage", component: entry.component, kind: entry.kind, name: entry.name };
  if (typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) && entry.durationMs >= 0) line.durationMs = entry.durationMs;
  if (typeof entry.ok === "boolean") line.ok = entry.ok;
  const ids: Record<string, string> = runId ? { runId } : {};
  for (const [key, value] of Object.entries(entry.ids ?? {})) {
    if (ID_KEYS.has(key) && typeof value === "string" && value.length <= 250 && /^[a-zA-Z0-9_:%.@-]+$/.test(value)
      && !/^\+?\d{6,}$/.test(value)) ids[key] = value;
  }
  if (Object.keys(ids).length) line.ids = ids;
  const props: NonNullable<LogLine["props"]> = {};
  for (const [key, value] of Object.entries(entry.props ?? {})) {
    if (NUMBERS.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) props[key] = value;
    else if (["queued", "inboundKnown", "bytesKnown"].includes(key) && typeof value === "boolean") props[key] = value;
    else if (typeof value === "string" && ENUMS[key]?.includes(value)) props[key] = value;
    // A route template is code-owned; no query strings, ids, or URLs enter the log.
    else if (key === "route" && typeof value === "string" && /^(?:\/(?:[a-z-]+|:id))*$/.test(value)) props[key] = value;
  }
  if (Object.keys(props).length) line.props = props;
  if (entry.kind === "error") {
    let tag = entry.error?.tag ?? "";
    if (/^http_[1-5]\d{2}/.test(tag)) tag = safeLineFailureCode(tag);
    else if (tag.startsWith("sendblue.")) tag = `sendblue.${sendblueErrorKey(tag.slice(9)) ?? "async_failure"}`;
    line.error = { tag: TAG.test(tag) ? tag : "operation.failed", message: "Operation failed" };
  }
  return line;
}

export function createToolLog(options: { root?: string; now?: () => number; capBytes?: number; defer?: boolean } = {}) {
  const root = () => options.root ?? logDirectory("imessage");
  const now = options.now ?? Date.now;
  let maintainedDay = "";
  let maintainedRoot = "";
  let rolledDay = "";
  let rolling = false;
  function append(entry: Entry, stamp?: string): void {
    let fd: number | undefined;
    try {
      const ts = stamp ?? new Date(now()).toISOString();
      const day = ts.slice(0, 10);
      const line = clean(entry, ts, processRunId);
      if (!line) return;
      const dir = root();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      if (maintainedDay !== day || maintainedRoot !== dir) {
        const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - 30 * 86400_000).toISOString().slice(0, 10);
        for (const file of readdirSync(dir)) {
          const date = /^(?:rollup-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json|\.cap)$/.exec(file)?.[1];
          if (date && date < cutoff) { try { unlinkSync(join(dir, file)); } catch { /* Best effort. */ } }
        }
        maintainedDay = day; maintainedRoot = dir;
      }
      fd = openSync(join(dir, `${day}.ndjson`), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      // Repair modes of pre-existing files too.
      const info = fstatSync(fd);
      if ((info.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
      if (info.size >= (options.capBytes ?? 50 * 1024 * 1024)) {
        let marker: number | undefined;
        try {
          marker = openSync(join(dir, `${day}.cap`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          appendFileSync(fd, JSON.stringify(clean({ component: "logger", kind: "error", name: "log.cap", error: { tag: "log.cap", message: "" } }, ts, processRunId)) + "\n");
        } catch { /* Another process already wrote the cap notice. */ }
        finally { if (marker !== undefined) closeSync(marker); }
        if (line.kind !== "error") return;
      }
      appendFileSync(fd, JSON.stringify(line) + "\n");
    } catch { /* Logging must never affect the caller. */ }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Best effort. */ } } }
  }
  const pending: LogLine[] = [];
  let scheduled = false;
  function flush(): void {
    scheduled = false;
    for (const line of pending.splice(0)) append(line, line.ts);
  }
  function write(entry: Entry): void {
    try {
      if (!options.defer) { append(entry); return; }
      const line = clean(entry, new Date(now()).toISOString(), processRunId);
      if (!line) return;
      pending.push(line);
      if (!scheduled) { scheduled = true; queueMicrotask(flush); }
    } catch { /* Optional logging never affects the caller. */ }
  }
  async function rollup(requestedDay?: string) {
    try {
      // Finish queued records before reading a day, without doing I/O in the caller's transaction.
      await Promise.resolve();
      const day = requestedDay ?? new Date(now() - 86400_000).toISOString().slice(0, 10);
      if (!DAY.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return;
      const dir = root();
      const countsByName: Record<string, number> = Object.create(null);
      const countsByKind: Record<string, number> = { event: 0, perf: 0, error: 0 };
      const durations = new Map<string, number[]>();
      const errors = new Map<string, { tag: string; count: number; sampleId?: string }>();
      let total = 0, ok = 0, failed = 0;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      if (existsSync(join(dir, `${day}.ndjson`))) {
      const input = createReadStream(join(dir, `${day}.ndjson`), { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const text of lines) {
          let line: LogLine | undefined;
          try { line = clean(JSON.parse(text), ""); } catch { continue; }
          if (!line) continue;
          total++;
          countsByName[line.name] = (countsByName[line.name] ?? 0) + 1;
          countsByKind[line.kind]++;
          if (line.ok === true) ok++;
          if (line.ok === false) failed++;
          if (line.durationMs !== undefined) {
            const values = durations.get(line.name) ?? [];
            values.push(line.durationMs); durations.set(line.name, values);
          }
          if (line.error) {
            const item = errors.get(line.error.tag) ?? { tag: line.error.tag, count: 0, sampleId: line.ids?.messageId ?? line.ids?.operationId ?? line.ids?.threadId ?? line.ids?.formId ?? line.ids?.runId };
            item.count++; errors.set(item.tag, item);
          }
        }
      } finally { lines.close(); input.destroy(); }
      }
      const durationMs: Record<string, { p50: number; p95: number; max: number }> = Object.create(null);
      for (const [name, values] of durations) {
        values.sort((a, b) => a - b);
        durationMs[name] = { p50: values[Math.max(0, Math.ceil(values.length * .5) - 1)]!, p95: values[Math.ceil(values.length * .95) - 1]!, max: values.at(-1)! };
      }
      const result = { day, tool: "imessage", total, countsByName, countsByKind, ok, failed,
        okRate: ok + failed ? ok / (ok + failed) : 0, errorRate: total ? countsByKind.error / total : 0,
        durationMs, topErrorTags: [...errors.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, 20) };
      const path = join(dir, `rollup-${day}.json`);
      const temporary = join(dir, `.rollup-${day}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
      return result;
    } catch { return; }
  }
  async function tick(): Promise<void> {
    try {
      const at = now();
      const day = new Date(at - 86400_000).toISOString().slice(0, 10);
      if (at % 86400_000 < 5 * 60_000 || rolling || rolledDay === day) return;
      rolling = true;
      try {
        try {
          const saved = JSON.parse(await readFile(join(root(), `rollup-${day}.json`), "utf8"));
          if (saved?.day === day && saved.tool === "imessage" && Number.isSafeInteger(saved.total) && saved.total >= 0
            && saved.countsByName && saved.countsByKind && saved.durationMs && Array.isArray(saved.topErrorTags)) {
            rolledDay = day; return;
          }
        } catch { /* Missing or interrupted files are rebuilt. */ }
        if (await rollup(day)) rolledDay = day;
      } finally { rolling = false; }
    } catch { /* Best effort. */ }
  }
  function capture(action: () => void): void { try { action(); } catch { /* Optional attribution must not affect work. */ } }
  return { write, rollup, tick, capture, flush };
}

export const toolLog = createToolLog({ defer: true });
export function toolError(component: string, tag: string, ids?: LogLine["ids"]): void {
  toolLog.write({ component, kind: "error", name: "bridge.catch", ok: false, ids, error: { tag, message: "" } });
}
export function cardKind(value: string): string {
  // Generator names only; captions, query values and health data never enter the log.
  for (const segment of value.split("/").map(part => part.replace(/^\d{4}-\d{2}-\d{2}[-_]/, ""))) {
    if (/^(?:delivery-|order-)/i.test(segment)) return "delivery";
    if (/^(?:ride-|uber-)/i.test(segment)) return "ride";
    if (/^(?:nutrition|morning|recovery|body)(?:[/_.-]|$)/i.test(segment)) return "nutrition";
    if (/^q-/i.test(segment)) return "quick";
  }
  return "other";
}
