import { safeLineFailureCode, sendblueErrorKey } from "./line.ts";
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, fchmodSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile, readFile, rename, unlink } from "node:fs/promises";
import { logDirectory } from "./log-directory.ts";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cleanCalls, createCallAggregation, type CallSummary } from "./log-calls.ts";
import { summarizeLog } from "./log-rollup.ts";
import { cleanSite, errorDetail, logSite, type ErrorDetail } from "./log-error.ts";

export type LogLine = {
  ts: string; tool: "imessage"; component: string; kind: "event" | "perf" | "error"; name: string;
  durationMs?: number; ok?: boolean; ids?: Record<string, string>; props?: Record<string, string | number | boolean>;
  site?: string;
  error?: { tag: string } & ErrorDetail;
  calls?: CallSummary;
};
type Entry = Omit<LogLine, "ts" | "tool" | "error"> & { error?: { tag: string; cause?: unknown } & Partial<ErrorDetail> };
const processRunId = randomUUID();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TAG = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,99}$/;
const LABEL = /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/;
const ID_KEYS = new Set(["chat", "messageId", "threadId", "operationId", "formId", "runId", "callBatchId"]);
const NUMBERS = new Set(["attachmentCount", "attachmentBytes", "receiveLagMs", "batchSize", "filesTaken", "waitMs", "outboxDelayMs", "parts", "files", "count", "status", "exitCode", "labels"]);
const ENUMS: Record<string, readonly string[]> = {
  replyMode: ["final", "tool"], reason: ["background", "no_text", "already_folded", "exit", "stdout", "hook"],
  source: ["live", "backfill"], outcome: ["replied", "failed", "refused", "no_reply"],
  cardKind: ["quick", "delivery", "ride", "nutrition", "other"], phase: ["start", "stop"],
  method: ["GET", "POST", "PUT", "DELETE", "PATCH"],
};

// Only reduced diagnostics cross this boundary; input objects can contain prompts or credentials.
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
  if (entry.name === "turn.robob_calls" && entry.component === "robob" && entry.kind === "perf") line.calls = cleanCalls(entry.calls);
  if (entry.kind === "error") {
    let tag = entry.error?.tag ?? "";
    if (/^http_[1-5]\d{2}/.test(tag)) tag = safeLineFailureCode(tag);
    else if (tag.startsWith("sendblue.")) tag = `sendblue.${sendblueErrorKey(tag.slice(9)) ?? "async_failure"}`;
    const status = /^http_([1-5]\d{2})/.exec(tag)?.[1];
    const name = tag.startsWith("form.") ? "ValidationError" : tag.startsWith("sendblue.") ? "SendblueError" : status ? "HttpError" : "UnknownError";
    line.error = { tag: TAG.test(tag) ? tag : "operation.failed", ...errorDetail(entry.error?.cause, {
      name, ...entry.error, status: entry.error?.status ?? (status ? Number(status) : typeof props.status === "number" ? props.status : undefined),
      code: entry.error?.code ?? (status ? safeLineFailureCode(tag) : undefined),
    }) };
    const site = cleanSite(entry.site);
    if (site) line.site = site;
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
  let rolledHour = -1;
  const calls = createCallAggregation(processRunId);
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
          const date = /^(?:rollup-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json|\.cap|\.degraded)$/.exec(file)?.[1];
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
          marker = openSync(join(dir, `${day}.degraded`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          appendFileSync(fd, JSON.stringify(clean({ component: "logger", kind: "error", name: "log.degraded", error: { tag: "log.degraded", message: "" } }, ts, processRunId)) + "\n");
        } catch { /* Another process already wrote the cap notice. */ }
        finally { if (marker !== undefined) closeSync(marker); }
        const slowOrFailedCall = line.name === "turn.robob_call" && ((line.durationMs ?? 0) > 1_000 || line.ok === false);
        if (line.kind !== "error" && !["turn.start", "turn.end", "turn.robob_calls"].includes(line.name) && !slowOrFailedCall) return;
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
  function enqueue(line: LogLine): void {
    if (!options.defer) { append(line, line.ts); return; }
    pending.push(line);
    if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  }
  function write(entry: Entry): void {
    try {
      if (entry.kind === "error" || entry.name === "form.fail") entry = { ...entry, site: entry.site ?? logSite() };
      if (entry.name === "form.fail" && entry.kind !== "error") entry = { ...entry, kind: "error", error: entry.error ?? { tag: "form.gone" } };
      const line = clean(entry, new Date(now()).toISOString(), processRunId);
      if (!line) return;
      for (const record of calls.accept(line, entry.ids?.runId !== undefined)) enqueue(record);
      if (entry.name === "turn.end") void scheduleRollup(line.ts.slice(0, 10));
    } catch { /* Optional logging never affects the caller. */ }
  }
  async function buildRollup(requestedDay?: string) {
    try {
      // Finish queued records before reading a day, without doing I/O in the caller's transaction.
      await Promise.resolve();
      const day = requestedDay ?? new Date(now() - 86400_000).toISOString().slice(0, 10);
      if (!DAY.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return;
      const dir = root();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const source = join(dir, `${day}.ndjson`);
      const sourceBytes = existsSync(source) ? statSync(source).size : 0;
      async function* records(): AsyncGenerator<LogLine> {
        if (!sourceBytes) return;
        // Read a fixed snapshot so concurrent appends cannot make a cached rollup look current.
        const input = createReadStream(source, { encoding: "utf8", end: sourceBytes - 1 });
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
          for await (const text of lines) {
            try { const line = clean(JSON.parse(text), ""); if (line) yield line; } catch { /* Interrupted or malformed row. */ }
          }
        } finally { lines.close(); input.destroy(); }
      }
      const result = { day, tool: "imessage", sourceBytes, ...await summarizeLog(records()) };
      const path = join(dir, `rollup-${day}.json`);
      const temporary = join(dir, `.rollup-${day}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
      return result;
    } catch { return; }
  }
  type Rollup = Awaited<ReturnType<typeof buildRollup>>;
  const jobs = new Map<string, Promise<Rollup>>();
  const dirty = new Set<string>();
  function scheduleRollup(day: string): Promise<Rollup> {
    const existing = jobs.get(day);
    if (existing) { dirty.add(day); return existing; }
    const job = (async () => {
      let result: Rollup;
      do {
        dirty.delete(day);
        result = await buildRollup(day);
      } while (dirty.has(day));
      jobs.delete(day);
      return result;
    })();
    jobs.set(day, job);
    return job;
  }
  function flushAll(): void {
    for (const line of calls.flush()) enqueue(line);
    flush();
  }
  async function settled(): Promise<void> {
    await Promise.resolve();
    while (jobs.size) await Promise.all([...jobs.values()]);
  }
  async function rollup(requestedDay?: string) {
    try {
      flushAll();
      const day = requestedDay ?? new Date(now() - 86400_000).toISOString().slice(0, 10);
      return await scheduleRollup(day);
    } catch { return; }
  }
  async function tick(): Promise<void> {
    try {
      const at = now();
      if (rolling) { await settled(); return; }
      rolling = true;
      try {
        const hour = Math.floor(at / 3_600_000);
        if (hour !== rolledHour) {
          flushAll();
          const today = new Date(at).toISOString().slice(0, 10);
          if (existsSync(join(root(), `${today}.ndjson`))) await scheduleRollup(today);
          rolledHour = hour;
        }
        const day = new Date(at - 86400_000).toISOString().slice(0, 10);
        if (at % 86400_000 >= 5 * 60_000 && rolledDay !== day) {
          let fresh = false;
          try {
            const saved = JSON.parse(await readFile(join(root(), `rollup-${day}.json`), "utf8"));
            const source = join(root(), `${day}.ndjson`);
            fresh = saved?.day === day && saved.tool === "imessage" && saved.sourceBytes === (existsSync(source) ? statSync(source).size : 0)
              && Number.isSafeInteger(saved.total) && saved.total >= 0 && saved.byComponent && Array.isArray(saved.topErrorTags);
          } catch { /* Missing, stale or interrupted rollups are rebuilt. */ }
          if (fresh || await scheduleRollup(day)) rolledDay = day;
        }
        await settled();
      } finally { rolling = false; }
    } catch { /* Best effort. */ }
  }
  function capture(action: () => void): void { try { action(); } catch { /* Optional attribution must not affect work. */ } }
  function beginRun(threadId: string, messageId: string): void {
    capture(() => {
      const line = clean({ component: "router", kind: "event", name: "turn.start", ids: { threadId, messageId } }, new Date(now()).toISOString(), processRunId);
      if (line) for (const record of calls.accept(line, false)) if (record.name !== "turn.start") enqueue(record);
    });
  }
  return { write, rollup, tick, capture, flush: flushAll, settled, runIds: calls.ids, beginRun };
}

export const toolLog = createToolLog({ defer: true });
export function toolError(component: string, tag: string, cause: unknown, ids?: LogLine["ids"]): void {
  toolLog.write({ component, kind: "error", name: "bridge.catch", ok: false, ids, error: { tag, cause } });
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
