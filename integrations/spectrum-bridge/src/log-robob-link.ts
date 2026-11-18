import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logDirectory } from "./log-directory.ts";
import { randomUUID } from "node:crypto";
import type { LogLine } from "./toollog.ts";

export const LINK_CAUSES = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "FETCH_FAILED", "HTTP_503"] as const;
export type LinkCause = typeof LINK_CAUSES[number];
export type RobobLink = {
  outageId: string; firstFailureAt: string; cause: LinkCause; route: string;
  failedCalls: number; suppressedCalls: number; causes: Partial<Record<LinkCause, number>>;
  inboundReceivedDuringOutage: number; inboundAckedDuringOutage: number; inboundAnsweredAfter: number; inboundAnsweredDuringOutage: number;
  skippedCalls?: number; failedProbes?: number; bySite?: Record<string, number>;
  downMs?: number; recoveredAt?: string; firstReplyAt?: string; summaryAt?: string;
};
const iso = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
export function cleanRobobLink(value: RobobLink | undefined): RobobLink | undefined {
  if (!value || !/^[a-f0-9-]{36}$/.test(value.outageId) || !iso(value.firstFailureAt)
    || !LINK_CAUSES.includes(value.cause) || !/^(?:\/(?:[a-z-]+|:id))*$/.test(value.route)) return;
  const result: RobobLink = { outageId: value.outageId, firstFailureAt: value.firstFailureAt, cause: value.cause, route: value.route,
    failedCalls: 0, suppressedCalls: 0, causes: {}, inboundReceivedDuringOutage: 0, inboundAckedDuringOutage: 0, inboundAnsweredAfter: 0, inboundAnsweredDuringOutage: 0 };
  for (const key of ["failedCalls", "suppressedCalls", "inboundReceivedDuringOutage", "inboundAckedDuringOutage", "inboundAnsweredAfter", "inboundAnsweredDuringOutage", "downMs", "skippedCalls", "failedProbes"] as const) {
    const n = value[key];
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) result[key] = n;
  }
  if (value.bySite) result.bySite = Object.fromEntries(Object.entries(value.bySite).filter(([site, count]) =>
    /^[a-zA-Z][a-zA-Z0-9_.:-]{0,99}$/.test(site) && Number.isSafeInteger(count) && count >= 0).slice(0, 100));
  for (const cause of LINK_CAUSES) {
    const n = value.causes?.[cause];
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) result.causes[cause] = n;
  }
  for (const key of ["recoveredAt", "firstReplyAt", "summaryAt"] as const) if (iso(value[key])) result[key] = value[key];
  return result;
}

type Outage = { link: RobobLink; waiting: Set<string>; answered: Set<string>; acked: Set<string>; down: boolean; dirty: boolean };
// Remote-box and legacy backends do not depend on this process's local Robob connection.
const robobReceipt = (line: LogLine) => line.name === "msg.received" && line.props?.backend === "robob";
// The default tool logger is process-wide, so all ControlClient instances share this state.
const RETENTION_MS = 30 * 86400_000;
const isAnswer = (line: LogLine) => line.name === "inbound.answered"
  || line.name === "reply.sent" && line.ok === true && (line.props?.kind !== "control" || line.props?.answersInbound === true);
type JournalPosition = { day: string; offset: number };
export function createRobobLinkState(options: { root?: string | (() => string); now?: () => number;
  checkpoint?: () => JournalPosition } = {}) {
  const now = options.now ?? Date.now;
  let active: Outage | undefined;
  let gatedOutage: string | undefined;
  const recovered = new Map<string, Outage>();
  let loadedRoot: string | undefined;
  let resumePending = false;
  let stateDirty = false;
  let lastWrite = -Infinity;
  let replaying = false;
  let stopping = false;
  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  const root = () => typeof options.root === "function" ? options.root() : options.root ?? logDirectory("imessage");
  function restore(value: unknown): Outage | undefined {
    if (!value || typeof value !== "object" || !("link" in value)) return;
    const link = cleanRobobLink(value.link as RobobLink);
    if (!link || now() - Date.parse(link.firstFailureAt) > RETENTION_MS) return;
    const record = value as Record<string, unknown>;
    const identities = (key: "waiting" | "answered" | "acked") => {
      const ids = record[key];
      return new Set(Array.isArray(ids) ? ids.filter((id: unknown): id is string => typeof id === "string"
        && /^[a-zA-Z0-9_:%.@-]{1,250}\0[a-zA-Z0-9_:%.@-]{1,250}$/.test(id)) : []);
    };
    return { link, waiting: identities("waiting"), answered: identities("answered"), acked: identities("acked"),
      down: "down" in value && value.down === true, dirty: false };
  }
  function persist(force = false) {
    if (!loadedRoot || !stateDirty && !force) return;
    if (pendingWrite) { clearTimeout(pendingWrite); pendingWrite = undefined; }
    const delay = 1_000 - (now() - lastWrite);
    if (!force && delay > 0) {
      pendingWrite = setTimeout(() => {
        pendingWrite = undefined;
        // Test/temporary log roots can disappear before the trailing write.
        if (loadedRoot && existsSync(loadedRoot)) persist();
      }, delay);
      pendingWrite.unref();
      return;
    }
    const pack = (item: Outage) => ({ link: cleanRobobLink(item.link), waiting: [...item.waiting], answered: [...item.answered], acked: [...item.acked], down: item.down });
    const temporary = join(loadedRoot, `.robob-link-state-${randomUUID()}.tmp`);
    try {
      mkdirSync(loadedRoot, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ version: 1, active: active ? pack(active) : null,
        recovered: [...recovered.values()].filter(item => item.waiting.size).map(pack),
        ...(options.checkpoint ? { journal: options.checkpoint() } : {}) }) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, join(loadedRoot, "robob-link-state.json"));
      lastWrite = now(); stateDirty = false;
    } catch { /* Logging must not interrupt delivery; the next dirty row retries. */ }
    finally { try { unlinkSync(temporary); } catch { /* Renamed or not created. */ } }
  }
  function load() {
    const dir = root();
    if (loadedRoot === dir) return;
    if (loadedRoot) persist(true);
    loadedRoot = dir; active = undefined; recovered.clear(); resumePending = false; lastWrite = -Infinity;
    try {
      const path = join(dir, "robob-link-state.json");
      const saved = JSON.parse(readFileSync(path, "utf8"));
      chmodSync(path, 0o600);
      if (saved?.version === 1) {
        active = restore(saved.active);
        if (active?.link.recoveredAt) active = undefined;

        if (Array.isArray(saved.recovered)) for (const value of saved.recovered) {
          const item = restore(value);
          if (item?.link.recoveredAt && item.waiting.size) recovered.set(item.link.outageId, item);
        }
        if (saved.journal && /^\d{4}-\d{2}-\d{2}$/.test(saved.journal.day)
          && Number.isSafeInteger(saved.journal.offset) && saved.journal.offset >= 0) {
          replaying = true;
          try { replayJournal(dir, saved.journal); } finally { replaying = false; }
        }
        resumePending = !!active;
        stateDirty = true;
      }
    } catch { /* Missing, expired or interrupted state starts clean. */ }
  }
  function replayJournal(dir: string, position: JournalPosition) {
    for (const day of readdirSync(dir).filter(file => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(file))
      .map(file => file.slice(0, 10)).filter(day => day >= position.day).sort()) {
      const fd = openSync(join(dir, `${day}.ndjson`), "r");
      try {
        let offset = day === position.day ? position.offset : 0;
        const buffer = Buffer.alloc(64 * 1024);
        const decoder = new TextDecoder();
        let pending = "";
        for (;;) {
          const bytes = readSync(fd, buffer, 0, buffer.length, offset);
          if (!bytes) break;
          offset += bytes;
          pending += decoder.decode(buffer.subarray(0, bytes), { stream: true });
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const text = pending.slice(0, end); pending = pending.slice(end + 1);
            try {
              const line = JSON.parse(text) as LogLine;
              if (line.component === "robob" && line.name === "robob.link_reset") {
                if (line.ids?.outageId === active?.link.outageId) active = undefined;
              } else if (line.component === "robob" && ["robob.link_down", "robob.link_up", "robob.link_state", "robob.link_down_summary", "robob.link_reply"].includes(line.name)) {
                const link = cleanRobobLink(line.link);
                if (!link || now() - Date.parse(link.firstFailureAt) > RETENTION_MS) continue;
                const item = active?.link.outageId === link.outageId ? active : recovered.get(link.outageId)
                  ?? { link, waiting: new Set<string>(), answered: new Set<string>(), acked: new Set<string>(), down: true, dirty: false };
                item.link = link; item.down = !link.recoveredAt;
                if (line.name === "robob.link_reply" && line.ids?.chat && line.ids.inboundId) {
                  const id = `${line.ids.chat}\0${line.ids.inboundId}`;
                  item.waiting.delete(id); item.answered.add(id);
                }
                if (link.recoveredAt) {
                  if (active?.link.outageId === link.outageId) active = undefined;
                  if (item.waiting.size) recovered.set(link.outageId, item);
                  else recovered.delete(link.outageId);
                } else active = item;
              } else if (robobReceipt(line) || isAnswer(line) || line.name === "inbound.acked" || line.name === "turn.robob_call") accept(line);
            } catch { /* An interrupted final row is not a milestone. */ }
          }
        }
      } finally { closeSync(fd); }
    }
  }
  const event = (name: string, item: Outage, ts: string): LogLine => ({ ts, tool: "imessage", component: "robob", kind: "event", name,
    link: { ...item.link, causes: { ...item.link.causes } } });
  function accept(line: LogLine): { events: LogLine[]; keepDetail: boolean } {
    load();
    const events: LogLine[] = [];
    let keepDetail = true;
    // Pending reply identities have the same retention window as the day files.
    for (const [id, item] of recovered) if (Date.parse(line.ts) - Date.parse(item.link.firstFailureAt) > RETENTION_MS) { recovered.delete(id); stateDirty = true; }
    if (active && Date.parse(line.ts) - Date.parse(active.link.firstFailureAt) > RETENTION_MS) { active = undefined; resumePending = false; stateDirty = true; }
    if (robobReceipt(line) && active && line.ids?.chat && line.ids.messageId) {
      const id = `${line.ids.chat}\0${line.ids.messageId}`;
      if (!active.waiting.has(id) && !active.answered.has(id)) {
        active.waiting.add(id); active.link.inboundReceivedDuringOutage++; active.dirty = true; stateDirty = true;
      }
    }
    if (line.name === "inbound.acked" && active && line.ids?.chat && line.ids.inboundId) {
      const id = `${line.ids.chat}\0${line.ids.inboundId}`;
      if (active.waiting.has(id) && !active.acked.has(id)) {
        active.acked.add(id); active.link.inboundAckedDuringOutage++; active.dirty = true; stateDirty = true;
      }
    }
    const answered = isAnswer(line);
    if (answered && line.ids?.chat && line.ids.inboundId) {
      const id = `${line.ids.chat}\0${line.ids.inboundId}`;
      // A successful delivery is the milestone, including replies sent through a CLI, card or tapback.
      for (const item of [...recovered.values(), ...(active ? [active] : [])]) if (item.waiting.delete(id)) {
        item.answered.add(id); item.dirty = true; stateDirty = true;
        if (item.link.recoveredAt && line.ts >= item.link.recoveredAt) {
          item.link.inboundAnsweredAfter++; item.link.firstReplyAt ??= line.ts;
          events.push({ ...event("robob.link_reply", item, line.ts), ids: { chat: line.ids.chat, inboundId: line.ids.inboundId } });
        } else item.link.inboundAnsweredDuringOutage++;
      }
    }
    if (line.name === "bridge.stop" && active?.down) active.dirty = true;
    if (line.name === "bridge.stop" || line.name === "turn.end") events.push(...flush(() => Date.parse(line.ts)));
    for (const [id, item] of recovered) if (!item.waiting.size) { recovered.delete(id); stateDirty = true; }
    if (line.name !== "turn.robob_call" || line.component !== "robob") {
      if (!replaying) {
        stopping ||= line.name === "bridge.stop";
        if (!options.checkpoint) save();
      }
      return { events, keepDetail };
    }
    if (line.props?.linkGated === true && active?.down) gatedOutage = active.link.outageId;
    const cause = line.props?.linkCause as LinkCause | undefined;
    if (line.ok === false && cause && LINK_CAUSES.includes(cause)) {
      if (replaying && line.ids?.outageId && (recovered.has(line.ids.outageId)
        || active?.link.outageId === line.ids.outageId && Number(line.props?.linkFailureCount) <= active.link.failedCalls)) return { events, keepDetail };
      // Fast successes can be sampled out; a new durable ID still proves the previous sequence ended.
      if (replaying && line.ids?.outageId && active?.link.outageId !== line.ids.outageId) active = undefined;
      active ??= { link: { outageId: replaying && line.ids?.outageId ? line.ids.outageId : randomUUID(), firstFailureAt: line.ts, cause, route: String(line.props?.route ?? ""),
        failedCalls: 0, suppressedCalls: 0, causes: {}, inboundReceivedDuringOutage: 0, inboundAckedDuringOutage: 0, inboundAnsweredAfter: 0, inboundAnsweredDuringOutage: 0 },
        waiting: new Set(), answered: new Set(), acked: new Set(), down: false, dirty: false };
      line.ids = { ...line.ids, outageId: active.link.outageId };
      if (line.props?.linkGated === true) {
        gatedOutage = active.link.outageId;
        if (line.props.linkProbe === true) active.link.failedProbes = (active.link.failedProbes ?? 0) + 1;
      }
      active.link.failedCalls++;
      line.props = { ...line.props, linkFailureCount: active.link.failedCalls };
      active.link.causes[cause] = (active.link.causes[cause] ?? 0) + 1;
      keepDetail = active.link.failedCalls <= 5;
      if (line.props?.linkGated === true && active.down) keepDetail = firstAtSite(`control.${String(line.props.route).replace(/[^a-zA-Z]/g, ".")}`);
      if (!keepDetail) active.link.suppressedCalls++;
      active.dirty = true; stateDirty = true;
      if (resumePending) {
        resumePending = false; active.down = true;
        const resumed = event("robob.link_state", active, line.ts);
        resumed.props = { resumedByRun: line.ids?.runId ?? "unknown" };
        events.push(resumed); active.dirty = false;
      }
      if (!active.down && active.link.failedCalls >= 3) {
        active.down = true; events.push(event("robob.link_down", active, line.ts)); active.dirty = false;
      }
    } else if (active) {
      if (line.ok === true && (active.down || resumePending)
        && (line.props?.linkGated !== true || line.props.linkProbe === true || line.props.linkGateDown === false)) {
        active.link.recoveredAt = line.ts;
        active.link.downMs = Math.max(0, Date.parse(line.ts) - Date.parse(active.link.firstFailureAt));
        events.push(event("robob.link_up", active, line.ts));
        // The recovering call must survive the normal slow-row sampling limit.
        line.props = { ...line.props, linkRecovery: true };
        if (active.waiting.size) recovered.set(active.link.outageId, active);
        active = undefined; resumePending = false; stateDirty = true;
      } else if (!active.down && !resumePending) {
        // A sampled success must still close a tentative sequence before the next throttled snapshot.
        events.push({ ts: line.ts, tool: "imessage", component: "robob", kind: "event", name: "robob.link_reset", ids: { outageId: active.link.outageId } });
        active = undefined; stateDirty = true;
      }
    }
    for (const [id, item] of recovered) if (!item.waiting.size) recovered.delete(id);
    if (gatedOutage && active?.down) events.push(...flush(() => Date.parse(line.ts)));
    if (!replaying && !options.checkpoint) save();
    return { events, keepDetail };
  }
  function flush(now: () => number): LogLine[] {
    if (!active?.down || !active.dirty) return [];
    const at = now();
    if (gatedOutage === active.link.outageId && at - Date.parse(active.link.summaryAt ?? active.link.firstFailureAt) < 60_000) return [];
    const ts = new Date(at).toISOString();
    active.dirty = false;
    if (gatedOutage === active.link.outageId) { active.link.summaryAt = ts; stateDirty = true; }
    const line = event(gatedOutage === active.link.outageId ? "robob.link_down_summary" : "robob.link_state", active, ts);
    if (line.name === "robob.link_down_summary") line.props = { downMs: Math.max(0, at - Date.parse(active.link.firstFailureAt)),
      skippedCalls: active.link.skippedCalls ?? 0, failedProbes: active.link.failedProbes ?? 0 };
    return [line];
  }
  function save() {
    if (replaying) return;
    persist(stopping); stopping = false;
  }
  function firstAtSite(site: string): boolean {
    if (!active?.down || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,99}$/.test(site)) return true;
    active.link.bySite ??= {};
    const previous = active.link.bySite[site] ?? 0;
    if (Object.keys(active.link.bySite).length < 100 || site in active.link.bySite) active.link.bySite[site] = previous + 1;
    active.dirty = true; stateDirty = true;
    return previous === 0;
  }
  function skip(site: string): LogLine[] {
    load();
    if (!active?.down) return [];
    gatedOutage = active.link.outageId;
    active.link.skippedCalls = (active.link.skippedCalls ?? 0) + 1;
    firstAtSite(site);
    const events = flush(now);
    if (!options.checkpoint) save();
    return events;
  }
  return { accept, flush, save, firstAtSite, skip, down: () => { load(); return active?.down === true; } };
}

export function createRobobLinkAggregation() {
  let order = 0;
  const firstFailures = new Map<string, { ts: string; order: number }>();
  const messages = new Map<string, { received?: string; replied?: string; receivedOrder?: number; repliedOrder?: number; acked?: string; ackedOrder?: number }>();
  const outages = new Map<string, { link: RobobLink; observedAt: string; recoveredOrder?: number }>();
  function accept(line: LogLine) {
    order++;
    if (line.component === "robob" && line.name === "turn.robob_call" && line.ok === false && line.ids?.outageId) {
      const first = firstFailures.get(line.ids.outageId);
      if (!first || line.ts < first.ts) firstFailures.set(line.ids.outageId, { ts: line.ts, order });
    }
    const received = robobReceipt(line);
    const answered = isAnswer(line);
    const id = received ? line.ids?.messageId : line.ids?.inboundId;
    const acked = line.name === "inbound.acked";
    if ((received || answered || acked) && line.ids?.chat && id) {
      const key = `${line.ids.chat}\0${id}`;
      const item = messages.get(key) ?? {};
      const field = received ? "received" : acked ? "acked" : "replied";
      if (!item[field] || line.ts < item[field]) {
        item[field] = line.ts;
        item[received ? "receivedOrder" : acked ? "ackedOrder" : "repliedOrder"] = order;
      }
      messages.set(key, item);
    }
    if (line.component !== "robob" || !["robob.link_down", "robob.link_up", "robob.link_state", "robob.link_down_summary", "robob.link_reply"].includes(line.name) || !line.link) return;
    const previous = outages.get(line.link.outageId);
    if (!previous || line.ts >= previous.observedAt) outages.set(line.link.outageId, { link: line.link, observedAt: line.ts,
      recoveredOrder: line.name === "robob.link_up" ? order : previous?.recoveredOrder });
  }
  // An outage belongs to the UTC day of its first failure; later recovery/reply rows complete that day's record.
  function summary(day?: string) {
    const list = [...outages.values()].filter(({ link }) => !day || link.firstFailureAt.startsWith(day)).map(({ link, observedAt }) => ({ ...link,
      downMs: link.downMs ?? Math.max(0, Date.parse(observedAt) - Date.parse(link.firstFailureAt)), open: !link.recoveredAt }));
    for (const link of list) {
      let received = 0, acked = 0, during = 0, after = 0;
      const observation = outages.get(link.outageId)!;
      const firstFailure = firstFailures.get(link.outageId);
      // NDJSON order resolves receipts/replies on opposite sides of recovery within one millisecond.
      const afterRecovery = (ts: string, position?: number) => link.recoveredAt !== undefined &&
        (ts > link.recoveredAt || ts === link.recoveredAt && (observation.recoveredOrder === undefined || (position ?? 0) > observation.recoveredOrder));
      for (const message of messages.values()) {
        if (!message.received || message.received < link.firstFailureAt
          || message.received === link.firstFailureAt && firstFailure !== undefined && (message.receivedOrder ?? 0) < firstFailure.order
          || message.received > (link.recoveredAt ?? observation.observedAt) || afterRecovery(message.received, message.receivedOrder)) continue;
        received++;
        if (message.acked && message.acked >= message.received && !afterRecovery(message.acked, message.ackedOrder)) acked++;
        if (!message.replied || message.replied < message.received) continue;
        if (afterRecovery(message.replied, message.repliedOrder)) {
          after++;
          if (!link.firstReplyAt || message.replied < link.firstReplyAt) link.firstReplyAt = message.replied;
        } else during++;
      }
      link.inboundReceivedDuringOutage = Math.max(received, link.inboundReceivedDuringOutage);
      link.inboundAckedDuringOutage = Math.max(acked, link.inboundAckedDuringOutage);
      // Snapshot and lifecycle rows describe the same replies, so reconcile totals before partitioning.
      const answered = Math.max(during + after, link.inboundAnsweredAfter + link.inboundAnsweredDuringOutage);
      link.inboundAnsweredAfter = Math.min(answered, Math.max(after, link.inboundAnsweredAfter));
      link.inboundAnsweredDuringOutage = answered - link.inboundAnsweredAfter;
    }
    const byCause: Partial<Record<LinkCause, number>> = {};
    for (const link of list) for (const cause of LINK_CAUSES) if (link.causes[cause]) byCause[cause] = (byCause[cause] ?? 0) + link.causes[cause]!;
    return { outages: list.sort((a, b) => a.firstFailureAt.localeCompare(b.firstFailureAt)), totalDownMs: list.reduce((n, link) => n + link.downMs, 0),
      longestMs: Math.max(0, ...list.map(link => link.downMs)), byCause,
      messagesWaiting: list.reduce((n, link) => n + Math.max(0, link.inboundReceivedDuringOutage - link.inboundAnsweredAfter - link.inboundAnsweredDuringOutage), 0) };
  }
  return { accept, summary };
}
