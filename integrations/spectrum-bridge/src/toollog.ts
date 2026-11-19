import { RobobLinkDown } from "./robob-link-gate.ts";
import { probeDeferred } from "./probe-policy.ts";
import { safeLineFailureCode, sendblueErrorKey } from "./line.ts";
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, fchmodSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile, readFile, rename, unlink } from "node:fs/promises";
import { logDirectory } from "./log-directory.ts";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cleanPromptProbe, createPromptProbeAggregation, type PromptProbeStats } from "./log-prompt-probes.ts";
import { createMessageReadAggregation } from "./log-message-reads.ts";
import { cleanCalls, createCallAggregation, SLOW_CALL_MS, type CallSummary } from "./log-calls.ts";
import { cleanRobobLink, createRobobLinkState, createRobobLinkAggregation, type RobobLink } from "./log-robob-link.ts";
import { summarizeLog } from "./log-rollup.ts";
import { createChainAggregation } from "./log-chains.ts";
import { recordRenderCounts, renderCounts } from "./log-render-store.ts";
import { cleanRenders, createRenderAggregation, renderChat } from "./log-renders.ts";
import { cleanSite, errorDetail, logSite, causeKey, type ErrorDetail } from "./log-error.ts";
import { CONTROL_REASONS, controlFailureProps } from "./control-errors.ts";

export type LogLine = {
  ts: string; tool: "imessage"; component: string; kind: "event" | "perf" | "error"; name: string;
  level?: "warn";
  durationMs?: number; ok?: boolean; ids?: Record<string, string>; props?: Record<string, string | number | boolean>;
  alreadyLogged?: boolean;
  link?: RobobLink;
  site?: string;
  error?: { tag: string } & ErrorDetail;
  calls?: CallSummary;
  promptProbe?: PromptProbeStats;
  renders?: { count: number; histogram: [number, number][] };
};
type Entry = Omit<LogLine, "ts" | "tool" | "error"> & { error?: { tag: string; cause?: unknown } & Partial<ErrorDetail> };
const processRunId = randomUUID();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TAG = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,99}$/;
const LABEL = /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/;
const ID_KEYS = new Set(["chat", "messageId", "inboundId", "outboxId", "threadId", "fromThreadId", "toThreadId", "operationId", "formId", "runId", "callBatchId", "requestId", "serverRequestId", "outageId", "tickId"]);
const NUMBERS = new Set(["attachmentCount", "attachmentBytes", "receiveLagMs", "batchSize", "filesTaken", "waitMs", "outboxDelayMs", "parts", "files", "count", "status", "exitCode", "labels", "slowestReadMs", "completionLagMs", "seedChars", "recapLines", "pendingOrdersChars", "attempt", "probeIndex", "probeCount", "ageMs", "generation", "rowsReturned", "bytesReturned", "fullReads", "incrementalReads", "cachedSkipReads", "sharedReads", "firstReads", "routeChanges", "missingUntils", "resyncs", "mergeConflicts", "clockSkews", "linkFailureCount", "boundMs", "elapsedMs", "msUntilAccepted", "markerPolls", "crossThreadReads", "crossThreadPages", "markerSkips", "fallbacks", "trackedThreads", "detailReads", "evidenceReads", "discoveryReads", "markerChecks", "crossThreadChecks", "downMs", "skippedCalls", "failedProbes"]);
const ENUMS: Record<string, readonly string[]> = {
  causeKind: ["timeout", "http", "transport"],
  probeOutcome: ["accepted", "notAcceptedYet", "timeout", "http", "transport"],
  controlReason: CONTROL_REASONS,
  route: ["new_turn", "steer", "question_answer", "held_for_wake"],
  readMode: ["full", "incremental", "cached-skip", "shared"],
  fallbackReason: ["marker-error", "missing-marker", "cross-thread-error", "state-raced"],
  fullReason: ["first-read", "route-change", "missing-until", "resync", "merge-conflict", "clock-skew"],
  kind: ["control", "conversation", "notification", "outage", "dropped", "failed", "nudge", "request", "other"],
  state: ["pending", "admitted", "processing", "batched", "done", "failed", "unknown", "cancelled", "observed"],
  action: ["requeued", "in_turn"], leaderKind: ["human", "wake", "reset", "background", "none"],
  telegram: ["sent", "failed"], severity: ["warn"],
  replyMode: ["final", "tool"], reason: ["watchdog_overdue", "respond_failed", "steer_failed", "background_no_reply", "turn_failed", "background", "no_text", "already_folded", "exit", "stdout", "hook", "test_default_command", "age", "contextSize", "providerRefusal", "grace", "not-waiting", "already-sent", "rate-limited"],
  source: ["live", "backfill", "watch", "settle_preceding"], outcome: ["replied", "failed", "refused", "no_reply", "ok", "fallback", "forwarded", "quiet", "owner_typed", "incomplete"],
  cardKind: ["quick", "delivery", "ride", "nutrition", "secure_form", "other"], phase: ["start", "stop"],
  method: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  failureCode: ["none", "renderer_failed", "preview_missing", "render_exception", "page_fetch", "page_http", "page_type", "page_body", "image_fetch", "image_http", "image_type", "image_body", "upload", "upload_url", "invalid_url", "file_prepare"],
  completionCheck: ["before", "after", "unchecked"],
  failureFormat: ["single"],
  linkCause: ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "FETCH_FAILED", "HTTP_503"],
  backend: ["robob", "openchamber", "remote-box", "unknown"],
};

// Only reduced diagnostics cross this boundary; input objects can contain prompts or credentials.
function clean(entry: Entry, ts: string, runId?: string): LogLine | undefined {
  if (!LABEL.test(entry.component) || !LABEL.test(entry.name) || !["event", "perf", "error"].includes(entry.kind)) return;
  const line: LogLine = { ts, tool: "imessage", component: entry.component, kind: entry.kind, name: entry.name };
  if (entry.level === "warn") line.level = "warn";
  if (typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) && entry.durationMs >= 0) line.durationMs = entry.durationMs;
  if (typeof entry.ok === "boolean") line.ok = entry.ok;
  if (entry.name === "bridge.catch" && entry.kind === "error" && entry.alreadyLogged === true) line.alreadyLogged = true;
  const ids: Record<string, string> = runId ? { runId } : {};
  for (const [key, value] of Object.entries(entry.ids ?? {})) {
    // Correlation ids are UUIDs; arbitrary server header text must never become a log field.
    if ((key === "requestId" || key === "serverRequestId" || key === "outageId") && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) continue;
    if (key === "chat" && entry.name.startsWith("card.render")) { ids.chat = renderChat(value); continue; }
    if (ID_KEYS.has(key) && typeof value === "string" && value.length <= 250 && /^[a-zA-Z0-9_:%.@-]+$/.test(value)
      && !/^\+?\d{6,}$/.test(value)) ids[key] = value;
  }
  if (Object.keys(ids).length) line.ids = ids;
  const props: NonNullable<LogLine["props"]> = {};
  for (const [key, value] of Object.entries(entry.props ?? {})) {
    if (entry.component === "mirror" && ["mirror-append", "mirror-queue", "mirror-fail", "mirror-backfill"].includes(entry.name)) {
      if (key === "direction" && (value === "inbound" || value === "outbound")
        || key === "kind" && (value === "text" || value === "file")
        || key === "cause" && ["store", "queue_full", "file_cap", "retry_exhausted", "http", "sink"].includes(String(value))
        || ["latency_ms", "depth"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
        props[key] = value; continue;
      }
    }
    if (entry.name === "synthetic.carry_evicted" && key === "reason" && (value === "expired" || value === "overflow")
      || entry.name === "synthetic.carried_from_stranded" && key === "cause" && (value === "route_retired" || value === "stuck_attempt_used")) {
      props[key] = value; continue;
    }
    if (entry.component === "remote-box" && entry.name === "moni-callback-ready"
      && (key === "handlerMs" || key === "loopDelayMs") && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      props[key] = value; continue;
    }
    if (entry.component === "remote-box" && entry.name === "moni-runner-error") {
      if (key === "path" && typeof value === "string" && ["/send", "/files", "/react", "/agent-ask", "/agent-answer", "/agent-requests", "/share", "/unshare", "/shares", "/metrics", "/ready"].includes(value)
        || key === "errorClass" && typeof value === "string" && ["LineError", "RemoteSendError", "Error", "UnknownError"].includes(value)
        || key === "retryable" && typeof value === "boolean") { props[key] = value; continue; }
      if (key === "code" && typeof value === "string") { props.code = safeLineFailureCode(value); continue; }
    }
    if (["moni-box-fenced", "moni-box-unfenced", "moni-box-wake-autofailed", "moni-box-backend-state"].includes(entry.name)) {
      if (key === "event" && typeof value === "string" && /^[a-f0-9]{12}$/.test(value)
        || key === "kind" && (value === "inbound" || value === "wake")
        || ["hasSend", "active", "busy", "fenced"].includes(key) && typeof value === "boolean"
        || ["queuedBehind", "fencedMs"].includes(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        props[key] = value; continue;
      }
    }
    if (entry.name === "robob.link_state" && key === "resumedByRun" && typeof value === "string" && /^[a-f0-9-]{36}$/.test(value)) { props[key] = value; continue; }
    if (key === "attempt" && typeof value === "number" && (!Number.isSafeInteger(value) || value < 1)) continue;
    if ((NUMBERS.has(key) || key === "replies" && entry.name === "notice.reply") && typeof value === "number" && Number.isFinite(value) && value >= 0) props[key] = value;
    else if ((["queued", "inboundKnown", "bytesKnown", "pendingOrders", "linkRecovery", "retrySafe", "answersInbound", "linkGated", "linkProbe", "linkGateDown"].includes(key) || key === "sealedWake" && entry.name === "notice.reply") && typeof value === "boolean") props[key] = value;
    else if (key === "holderRunId" && typeof value === "string" && value.length <= 250 && /^[a-zA-Z0-9_:%.@-]+$/.test(value)) props[key] = value;
    else if (typeof value === "string" && ENUMS[key]?.includes(value)) props[key] = value;
    // A route template is code-owned; no query strings, ids, or URLs enter the log.
    else if (key === "route" && typeof value === "string" && /^(?:\/(?:[a-z-]+|:id))*$/.test(value)) props[key] = value;
  }
  if (Object.keys(props).length) line.props = props;
  if (entry.name === "router.prompt_probes" && entry.component === "router" && entry.kind === "perf") line.promptProbe = cleanPromptProbe(entry.promptProbe);
  if (entry.component === "robob" && ["robob.link_down", "robob.link_up", "robob.link_state", "robob.link_down_summary", "robob.link_reply"].includes(entry.name)) line.link = cleanRobobLink(entry.link);
  if (entry.name === "card.renders" && entry.kind === "perf") line.renders = cleanRenders(entry.renders);
  if (entry.name === "turn.robob_calls" && entry.component === "robob" && entry.kind === "perf") line.calls = cleanCalls(entry.calls);
  if (entry.kind === "error" || entry.name === "turn.robob_call" && entry.ok === false) {
    let tag = entry.error?.tag ?? "";
    if (/^http_[1-5]\d{2}/.test(tag)) tag = safeLineFailureCode(tag);
    else if (tag.startsWith("sendblue.")) tag = `sendblue.${sendblueErrorKey(tag.slice(9)) ?? "async_failure"}`;
    const status = /^http_([1-5]\d{2})/.exec(tag)?.[1];
    const name = tag.startsWith("form.") ? "ValidationError" : tag.startsWith("sendblue.") ? "SendblueError" : status ? "HttpError" : "UnknownError";
    line.error = { tag: TAG.test(tag) ? tag : "operation.failed", ...errorDetail(entry.error?.cause, {
      name, ...entry.error, status: entry.error?.status ?? (status ? Number(status) : typeof props.status === "number" ? props.status : undefined),
      code: entry.error?.code ?? (status ? safeLineFailureCode(tag) : undefined),
    }) };
    if (["Error", "UnknownError", "TimeoutError", "BoundedTimeout"].includes(line.error.name)) line.error.causeKey = causeKey(line.error, line.error.tag);
    if (line.error.tag === "router.catch1" && props.causeKind) {
      line.error.causeKey = "prompt_acceptance_probe";
      line.error.message = "[redacted]";
      if (props.status === 0) line.error.status = 0;
      if (props.causeKind === "timeout") line.error.code = "ETIMEDOUT";
    }
    const site = cleanSite(entry.site);
    if (site) line.site = site;
  }
  return line;
}

function logSources(dir: string): Record<string, number> {
  return Object.fromEntries(readdirSync(dir).filter(file => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(file)).sort()
    .map(file => [file.slice(0, 10), statSync(join(dir, file)).size]));
}

async function* records(dir: string, sources: Record<string, number>): AsyncGenerator<LogLine> {
  for (const [day, bytes] of Object.entries(sources)) {
    if (!bytes) continue;
    // Fixed byte ranges keep appends during a build visible as a stale dependency snapshot.
    const input = createReadStream(join(dir, `${day}.ndjson`), { encoding: "utf8", end: bytes - 1 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const text of lines) {
        try {
          const parsed = JSON.parse(text);
          const line = clean(parsed, typeof parsed.ts === "string" ? parsed.ts : "");
          if (line) yield line;
        } catch { /* Interrupted or malformed row. */ }
      }
    } finally { lines.close(); input.destroy(); }
  }
}

function chainSources(sources: Record<string, number>, day: string): Record<string, number> {
  return { [day]: sources[day] ?? 0, ...Object.fromEntries(Object.entries(sources).filter(([date]) => date > day)) };
}

export function createToolLog(options: { root?: string; now?: () => number; capBytes?: number; defer?: boolean } = {}) {
  const root = () => options.root ?? logDirectory("imessage");
  const now = options.now ?? Date.now;
  let maintainedDay = "";
  let maintainedRoot = "";
  let rolling = false;
  let rolledHour = -1;
  let rolledYesterday = "";
  let recovery: Promise<void> | undefined;
  const calls = createCallAggregation(processRunId);
  const messageReads = createMessageReadAggregation();
  const promptProbes = createPromptProbeAggregation();
  const robobLink = createRobobLinkState({ root, now, checkpoint: () => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const path = join(root(), `${day}.ndjson`);
    return { day, offset: existsSync(path) ? statSync(path).size : 0 };
  } });
  const renders = createRenderAggregation();
  let writeFailed = false;
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
          const date = /^(?:rollup-|renders-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json|\.cap|\.degraded|\.sqlite(?:-journal|-wal|-shm)?)$/.exec(file)?.[1];
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
        const renderDetail = line.name === "card.render" && (line.ok === false || (line.durationMs ?? 0) > 1_000);
        const slowOrFailedCall = line.name === "turn.robob_call" && ((line.durationMs ?? 0) > SLOW_CALL_MS || line.ok === false);
        if (line.kind !== "error" && line.level !== "warn" && !["msg.received", "reply.sent", "inbound.answered", "inbound.acked", "inbound.delivered", "recovery.notice_sent", "turn.start", "turn.end", "turn.robob_calls", "robob.link_down", "robob.link_up", "robob.link_state", "robob.link_down_summary", "robob.link_reply", "robob.link_reset", "moni-box-up", "moni-box-backend-state", "moni-box-fenced", "moni-box-unfenced", "moni-box-wake-autofailed", "synthetic.carry_evicted", "synthetic.carried_from_stranded"].includes(line.name) && !slowOrFailedCall && !renderDetail) {
          if (line.name === "card.render" || line.name === "card.renders") writeFailed = true;
          return;
        }
      }
      if (line.name === "card.renders" && line.renders) recordRenderCounts(dir, line);
      else appendFileSync(fd, JSON.stringify(line) + "\n");
    } catch (error) {
      writeFailed = true;
      if (entry.name === "card.renders") append({ component: "logger", kind: "error", name: "bridge.catch", ok: false,
        error: { tag: "render.counters.write", cause: error } }, stamp);
    }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Best effort. */ } } }
  }
  const pending: LogLine[] = [];
  let scheduled = false;
  function flush(): void {
    scheduled = false;
    for (const line of pending.splice(0)) append(line, line.ts);
    robobLink.save();
  }
  function enqueue(line: LogLine): void {
    if (!options.defer) { append(line, line.ts); return; }
    pending.push(line);
    scheduleFlush();
  }
  function scheduleFlush(): void {
    if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  }
  function saveLink(): void { if (options.defer) scheduleFlush(); else robobLink.save(); }
  function write(entry: Entry): void {
    try {
      if (entry.kind === "error" || entry.name === "form.fail" || entry.name === "turn.robob_call" && entry.ok === false) entry = { ...entry, site: entry.site ?? logSite() };
      if (entry.name === "form.fail" && entry.kind !== "error") entry = { ...entry, kind: "error", error: entry.error ?? { tag: "form.gone" } };
      const line = clean(entry, new Date(now()).toISOString(), processRunId);
      if (!line) {
        if (entry.name === "card.render" || entry.name === "card.renders") writeFailed = true;
        return;
      }
      const link = robobLink.accept(line);
      for (const event of link.events) enqueue(event);
      if (entry.props?.linkGated === true && entry.ok === false && !link.keepDetail) {
        saveLink();
        return;
      }
      for (const probe of promptProbes.accept(line)) for (const messageRead of messageReads.accept(probe)) for (const render of renders.accept(messageRead)) for (const record of calls.accept(render, entry.ids?.runId !== undefined, link.keepDetail)) enqueue(record);
      saveLink();
      if (entry.name === "turn.end") void scheduleRollup(line.ts.slice(0, 10));
      if (["turn.start", "reply.sent", "inbound.answered"].includes(line.name) && line.ids?.chat && line.ids.inboundId) {
        refreshChains(`${line.ids.chat}\0${line.ids.inboundId}`);
      }
    } catch { writeFailed = true; }
  }
  function readRenderCounts(dir: string, day: string): ReturnType<typeof renderCounts> {
    try { return renderCounts(dir, day); }
    catch (error) {
      write({ component: "logger", kind: "error", name: "bridge.catch", ok: false, error: { tag: "render.counters.read", cause: error } });
      throw error;
    }
  }
  async function saveRollup(dir: string, day: string, result: unknown): Promise<void> {
    const path = join(dir, `rollup-${day}.json`);
    const temporary = join(dir, `.rollup-${day}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async function buildRollup(requestedDay?: string, precedingRecovery?: Promise<void>) {
    try {
      // Finish queued records before reading a day, without doing I/O in the caller's transaction.
      await Promise.resolve();
      await precedingRecovery;
      const day = requestedDay ?? new Date(now() - 86400_000).toISOString().slice(0, 10);
      if (!DAY.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return;
      const dir = root();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const sources = chainSources(logSources(dir), day);
      const sourceBytes = sources[day] ?? 0;
      const later = Object.fromEntries(Object.entries(sources).filter(([date]) => date > day));
      const renders = readRenderCounts(dir, day);
      const result = { day, tool: "imessage", sourceBytes, renderSourceCount: renders.count, chainSources: sources,
        ...await summarizeLog(records(dir, { [day]: sourceBytes }), records(dir, later), renders.lines, day) };
      await saveRollup(dir, day, result);
      return result;
    } catch { return; }
  }
  type Rollup = Awaited<ReturnType<typeof buildRollup>>;
  const jobs = new Map<string, Promise<Rollup>>();
  const dirty = new Set<string>();
  function scheduleRollup(day: string): Promise<Rollup> {
    const existing = jobs.get(day);
    if (existing) { dirty.add(day); return existing; }
    const precedingRecovery = recovery;
    const job = (async () => {
      let result: Rollup;
      do {
        dirty.delete(day);
        result = await buildRollup(day, precedingRecovery);
      } while (dirty.has(day));
      jobs.delete(day);
      return result;
    })();
    jobs.set(day, job);
    return job;
  }
  const pendingChains = new Set<string>();
  const receiptDays = new Map<string, string>();
  const indexedSources = new Map<string, number>();
  let indexedRoot = "";
  let refreshingChains: Promise<void> | undefined;
  function refreshChains(key: string): void {
    pendingChains.add(key);
    refreshingChains ??= (async () => {
      // Deferred writes must reach disk before indexing their receipt or follow-up.
      await Promise.resolve();
      while (pendingChains.size) {
        const keys = [...pendingChains]; pendingChains.clear();
        const dir = root();
        if (indexedRoot !== dir) { receiptDays.clear(); indexedSources.clear(); indexedRoot = dir; }
        const sources = logSources(dir);
        for (const [id, day] of receiptDays) if (!(day in sources)) receiptDays.delete(id);
        for (const day of indexedSources.keys()) if (!(day in sources)) indexedSources.delete(day);
        if (keys.some(id => !receiptDays.has(id))) {
          const changed = Object.fromEntries(Object.entries(sources).filter(([day, bytes]) => indexedSources.get(day) !== bytes));
          for await (const line of records(dir, changed)) {
            if (line.name !== "msg.received" || !line.ids?.chat || !line.ids.messageId) continue;
            const id = `${line.ids.chat}\0${line.ids.messageId}`;
            const day = line.ts.slice(0, 10);
            const previous = receiptDays.get(id);
            if (!previous || day < previous) receiptDays.set(id, day);
          }
          for (const [day, bytes] of Object.entries(changed)) indexedSources.set(day, bytes);
        }
        const days = new Set(keys.map(id => receiptDays.get(id)).filter(day => day !== undefined));
        await Promise.all([...days].map(scheduleRollup));
      }
    })().catch(() => {}).finally(() => {
      refreshingChains = undefined;
      const pending = pendingChains.values().next().value;
      if (pending !== undefined) refreshChains(pending);
    });
  }
  function flushAll(): boolean {
    capture(() => { for (const line of robobLink.flush(now)) enqueue(line); });
    for (const line of promptProbes.flush()) enqueue(line);
    for (const line of messageReads.flush()) enqueue(line);
    for (const line of renders.flush()) enqueue(line);
    for (const line of calls.flush()) enqueue(line);
    flush();
    // Optional logging stays best effort; explicit CLI acknowledgements check this result.
    const written = !writeFailed;
    writeFailed = false;
    return written;
  }
  async function settled(): Promise<void> {
    await Promise.resolve();
    while (jobs.size || refreshingChains || recovery) await Promise.all([
      ...jobs.values(), ...(refreshingChains ? [refreshingChains] : []), ...(recovery ? [recovery] : []),
    ]);
  }
  async function rollup(requestedDay?: string) {
    try {
      flushAll();
      const day = requestedDay ?? new Date(now() - 86400_000).toISOString().slice(0, 10);
      return await scheduleRollup(day);
    } catch { return; }
  }
  async function cachedRollup(dir: string, day: string) {
    try { return JSON.parse(await readFile(join(dir, `rollup-${day}.json`), "utf8")) as NonNullable<Rollup>; }
    catch { return; }
  }
  function validOwnDay(saved: Rollup, day: string, bytes: number): saved is NonNullable<Rollup> {
    return Boolean(saved?.day === day && saved.tool === "imessage" && saved.sourceBytes === bytes && saved.renderSourceCount === readRenderCounts(root(), day).count
      && Number.isSafeInteger(saved.total) && saved.total >= 0 && saved.byComponent && saved.chains && saved.robob_link && Array.isArray(saved.topErrorTags) && Array.isArray(saved.topCauses));
  }
  function recoverRollups(at: number, hourly: boolean, yesterday?: string): Promise<void> {
    const precedingJobs = [...jobs.values()];
    recovery = (async () => {
      // Finish earlier per-day jobs; new targeted refreshes wait for this shared snapshot instead.
      await Promise.all(precedingJobs);
      const dir = root();
      mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
      const sources = logSources(dir);
      const days = new Set<string>(yesterday ? [yesterday] : []);
      if (hourly) {
        const today = new Date(at).toISOString().slice(0, 10);
        const cutoff = new Date(at - 30 * 86400_000).toISOString().slice(0, 10);
        if (today in sources) days.add(today);
        for (const file of readdirSync(dir)) {
          const day = /^rollup-(\d{4}-\d{2}-\d{2})\.json$/.exec(file)?.[1];
          if (day && day >= cutoff && day < today && day in sources) days.add(day);
        }
      }
      const stale = new Set<string>();
      const cached = new Map<string, NonNullable<Rollup>>();
      for (const day of days) {
        const saved = await cachedRollup(dir, day);
        if (validOwnDay(saved, day, sources[day] ?? 0)) {
          if (JSON.stringify(saved.chainSources) === JSON.stringify(chainSources(sources, day))) continue;
          cached.set(day, saved);
        }
        stale.add(day);
      }
      if (!stale.size) return;
      const chains = createChainAggregation();
      const links = createRobobLinkAggregation();
      const summaries = new Map<string, Awaited<ReturnType<typeof summarizeLog>>>();
      const renderSnapshots = new Map<string, ReturnType<typeof renderCounts>>();
      // Every file is streamed once for the entire sweep, including any daily counters needing a rebuild.
      for (const day of new Set([...Object.keys(sources), ...stale])) {
        async function* scan() {
          for await (const line of records(dir, { [day]: sources[day] ?? 0 })) { chains.accept(line); links.accept(line); yield line; }
        }
        if (stale.has(day) && !cached.has(day)) {
          const renders = readRenderCounts(dir, day);
          renderSnapshots.set(day, renders);
          summaries.set(day, await summarizeLog(scan(), undefined, renders.lines, day));
        }
        else for await (const _line of scan()) { /* Only chain milestones are needed for unchanged daily totals. */ }
      }
      for (const day of stale) {
        const base = cached.get(day) ?? summaries.get(day)!;
        const result = { ...base, day, tool: "imessage", sourceBytes: sources[day] ?? 0, renderSourceCount: cached.get(day)?.renderSourceCount ?? renderSnapshots.get(day)?.count ?? 0,
          chainSources: chainSources(sources, day), chains: chains.summary(day), robob_link: links.summary(day) };
        await saveRollup(dir, day, result);
      }
    })().catch(() => {}).finally(() => { recovery = undefined; });
    return recovery;
  }
  async function tick(): Promise<void> {
    try {
      const at = now();
      for (const line of messageReads.flush(Math.floor(at / 60_000) * 60_000)) enqueue(line);
      for (const line of promptProbes.flush(Math.floor(at / 60_000) * 60_000)) enqueue(line);
      if (rolling) { await settled(); return; }
      const hour = Math.floor(at / 3_600_000);
      const hourly = hour !== rolledHour;
      const yesterday = new Date(at - 86400_000).toISOString().slice(0, 10);
      const dueYesterday = at % 86400_000 >= 5 * 60_000 && rolledYesterday !== yesterday;
      if (!hourly && !dueYesterday) return;
      rolling = true;
      try {
        flushAll();
        await recoverRollups(at, hourly, dueYesterday ? yesterday : undefined);
        rolledHour = hour;
        if (dueYesterday) rolledYesterday = yesterday;
        await settled();
      } finally { rolling = false; }
    } catch { /* Best effort. */ }
  }
  function capture(action: () => void): void { try { action(); } catch { writeFailed = true; } }
  function beginRun(threadId: string, messageId: string): void {
    capture(() => {
      const line = clean({ component: "router", kind: "event", name: "turn.start", ids: { threadId, messageId } }, new Date(now()).toISOString(), processRunId);
      if (line) for (const record of calls.accept(line, false)) if (record.name !== "turn.start") enqueue(record);
    });
  }
  const skipRobob = (site: string) => { for (const event of robobLink.skip(site)) enqueue(event); saveLink(); };
  const robobSite = (site: string) => { const first = robobLink.firstAtSite(site); saveLink(); return first; };
  return { robobLinkDown: robobLink.down, robobSite, skipRobob, write, rollup, tick, capture, flush: flushAll, settled, runIds: calls.ids, beginRun };
}

export const toolLog = createToolLog({ defer: true });
/** Cooperative read yielding is expected control flow, not a backend failure. */
export const completionReady = Symbol("completionReady");
// Keep correlation on the error identity without mutating or serializing caller-owned errors.
const loggedFailures = new WeakMap<object, string>();
const gatedFailures = new WeakSet<object>();
export function markLoggedFailure(error: unknown, requestId: string, gated = false): void {
  if (error !== null && typeof error === "object") { loggedFailures.set(error, requestId); if (gated) gatedFailures.add(error); }
}
function loggedRequestId(error: unknown): string | undefined {
  const seen = new Set<object>();
  while (error !== null && typeof error === "object" && !seen.has(error)) {
    const requestId = loggedFailures.get(error);
    if (requestId) return requestId;
    seen.add(error);
    try { error = "cause" in error ? error.cause : undefined; } catch { return; }
  }
}
export function toolError(component: string, tag: string, cause: unknown, ids?: LogLine["ids"], props?: LogLine["props"]): void {
  if (cause === completionReady || cause === probeDeferred) return;
  if (cause instanceof RobobLinkDown) {
    if (!cause.firstAtSite(tag)) return;
  } else if (toolLog.robobLinkDown() && cause !== null && typeof cause === "object" && gatedFailures.has(cause) && !toolLog.robobSite(tag)) return;
  const requestId = loggedRequestId(cause);
  toolLog.write({ component, kind: "error", name: "bridge.catch", ok: false, ids: { ...ids, ...(requestId ? { requestId } : {}) }, props: { ...controlFailureProps(cause), ...props },
    ...(requestId || cause instanceof RobobLinkDown ? { alreadyLogged: true } : {}), error: { tag, cause } });
}
export function cardKind(value: string): string {
  // Generator names only; captions, query values and health data never enter the log.
  for (const segment of value.split("/").map(part => part.replace(/^\d{4}-\d{2}-\d{2}[-_]/, ""))) {
    if (/^(?:delivery-|order-)/i.test(segment)) return "delivery";
    if (/^(?:ride-|uber-)/i.test(segment)) return "ride";
    if (/^(?:nutrition|morning|recovery|body)(?:[/_.-]|$)/i.test(segment)) return "nutrition";
    if (/^(?:_secret|secret|secure|forms?)(?:[_.-]|$)/i.test(segment)) return "secure_form";
    if (/^q-/i.test(segment)) return "quick";
  }
  return "other";
}

export function logCardRender(component: string, kind: string, durationMs: number, ok: boolean,
  details: { chat?: string; outcome?: "ok" | "fallback" | "failed"; failureCode?: string; attempt?: number } = {}): void {
  toolLog.capture(() => toolLog.write({ component, kind: "perf", name: "card.render", durationMs, ok,
    ids: { chat: details.chat ?? "" }, props: { cardKind: kind, outcome: details.outcome ?? (ok ? "ok" : "failed"),
      failureCode: details.failureCode ?? (ok ? "none" : "renderer_failed"), attempt: details.attempt ?? 1 } }));
}
