import { randomUUID } from "node:crypto";
import type { LogLine } from "./toollog.ts";

export const LINK_CAUSES = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"] as const;
export type LinkCause = typeof LINK_CAUSES[number];
export type RobobLink = {
  outageId: string; firstFailureAt: string; cause: LinkCause; route: string;
  failedCalls: number; suppressedCalls: number; causes: Partial<Record<LinkCause, number>>;
  inboundReceivedDuringOutage: number; inboundAnsweredAfter: number; inboundAnsweredDuringOutage: number;
  downMs?: number; recoveredAt?: string; firstReplyAt?: string;
};
const iso = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
export function cleanRobobLink(value: RobobLink | undefined): RobobLink | undefined {
  if (!value || !/^[a-f0-9-]{36}$/.test(value.outageId) || !iso(value.firstFailureAt)
    || !LINK_CAUSES.includes(value.cause) || !/^(?:\/(?:[a-z-]+|:id))*$/.test(value.route)) return;
  const result: RobobLink = { outageId: value.outageId, firstFailureAt: value.firstFailureAt, cause: value.cause, route: value.route,
    failedCalls: 0, suppressedCalls: 0, causes: {}, inboundReceivedDuringOutage: 0, inboundAnsweredAfter: 0, inboundAnsweredDuringOutage: 0 };
  for (const key of ["failedCalls", "suppressedCalls", "inboundReceivedDuringOutage", "inboundAnsweredAfter", "inboundAnsweredDuringOutage", "downMs"] as const) {
    const n = value[key];
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) result[key] = n;
  }
  for (const cause of LINK_CAUSES) {
    const n = value.causes?.[cause];
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) result.causes[cause] = n;
  }
  for (const key of ["recoveredAt", "firstReplyAt"] as const) if (iso(value[key])) result[key] = value[key];
  return result;
}

type Outage = { link: RobobLink; waiting: Set<string>; answered: Set<string>; down: boolean; dirty: boolean };
// Remote-box and legacy backends do not depend on this process's local Robob connection.
const robobReceipt = (line: LogLine) => line.name === "msg.received" && line.props?.backend === "robob";
// The default tool logger is process-wide, so all ControlClient instances share this state.
export function createRobobLinkState() {
  let active: Outage | undefined;
  const recovered = new Map<string, Outage>();
  const event = (name: string, item: Outage, ts: string): LogLine => ({ ts, tool: "imessage", component: "robob", kind: "event", name,
    link: { ...item.link, causes: { ...item.link.causes } } });
  function accept(line: LogLine): { events: LogLine[]; keepDetail: boolean } {
    const events: LogLine[] = [];
    let keepDetail = true;
    // Pending reply identities have the same retention window as the day files.
    for (const [id, item] of recovered) if (Date.parse(line.ts) - Date.parse(item.link.firstFailureAt) > 30 * 86400_000) recovered.delete(id);
    if (robobReceipt(line) && active && line.ids?.chat && line.ids.messageId) {
      const id = `${line.ids.chat}\0${line.ids.messageId}`;
      if (!active.waiting.has(id) && !active.answered.has(id)) {
        active.waiting.add(id); active.link.inboundReceivedDuringOutage++; active.dirty = true;
      }
    }
    const answered = line.name === "inbound.answered" || line.name === "reply.sent" && line.ok === true;
    if (answered && line.ids?.chat && line.ids.inboundId) {
      const id = `${line.ids.chat}\0${line.ids.inboundId}`;
      // A successful delivery is the milestone, including replies sent through a CLI, card or tapback.
      for (const item of [...recovered.values(), ...(active ? [active] : [])]) if (item.waiting.delete(id)) {
        item.answered.add(id); item.dirty = true;
        if (item.link.recoveredAt && line.ts >= item.link.recoveredAt) {
          item.link.inboundAnsweredAfter++; item.link.firstReplyAt ??= line.ts;
          events.push(event("robob.link_reply", item, line.ts));
        } else item.link.inboundAnsweredDuringOutage++;
      }
    }
    if (line.name === "bridge.stop" && active?.down) active.dirty = true;
    if (line.name === "bridge.stop" || line.name === "turn.end") events.push(...flush(() => Date.parse(line.ts)));
    if (line.name !== "turn.robob_call" || line.component !== "robob") return { events, keepDetail };
    const cause = line.props?.linkCause as LinkCause | undefined;
    if (line.ok === false && cause && LINK_CAUSES.includes(cause)) {
      active ??= { link: { outageId: randomUUID(), firstFailureAt: line.ts, cause, route: String(line.props?.route ?? ""),
        failedCalls: 0, suppressedCalls: 0, causes: {}, inboundReceivedDuringOutage: 0, inboundAnsweredAfter: 0, inboundAnsweredDuringOutage: 0 },
        waiting: new Set(), answered: new Set(), down: false, dirty: false };
      line.ids = { ...line.ids, outageId: active.link.outageId };
      active.link.failedCalls++;
      active.link.causes[cause] = (active.link.causes[cause] ?? 0) + 1;
      keepDetail = active.link.failedCalls <= 5;
      if (!keepDetail) active.link.suppressedCalls++;
      active.dirty = true;
      if (!active.down && active.link.failedCalls >= 3) {
        active.down = true; events.push(event("robob.link_down", active, line.ts)); active.dirty = false;
      }
    } else if (active) {
      if (line.ok === true && active.down) {
        active.link.recoveredAt = line.ts;
        active.link.downMs = Math.max(0, Date.parse(line.ts) - Date.parse(active.link.firstFailureAt));
        events.push(event("robob.link_up", active, line.ts));
        // The recovering call must survive the normal slow-row sampling limit.
        line.props = { ...line.props, linkRecovery: true };
        if (active.waiting.size) recovered.set(active.link.outageId, active);
        active = undefined;
      } else if (!active.down) active = undefined;
    }
    for (const [id, item] of recovered) if (!item.waiting.size) recovered.delete(id);
    return { events, keepDetail };
  }
  function flush(now: () => number): LogLine[] {
    if (!active?.down || !active.dirty) return [];
    const ts = new Date(now()).toISOString();
    active.dirty = false;
    return [event("robob.link_state", active, ts)];
  }
  return { accept, flush };
}

export function createRobobLinkAggregation() {
  let order = 0;
  const firstFailures = new Map<string, { ts: string; order: number }>();
  const messages = new Map<string, { received?: string; replied?: string; receivedOrder?: number; repliedOrder?: number }>();
  const outages = new Map<string, { link: RobobLink; observedAt: string; recoveredOrder?: number }>();
  function accept(line: LogLine) {
    order++;
    if (line.component === "robob" && line.name === "turn.robob_call" && line.ok === false && line.ids?.outageId) {
      const first = firstFailures.get(line.ids.outageId);
      if (!first || line.ts < first.ts) firstFailures.set(line.ids.outageId, { ts: line.ts, order });
    }
    const received = robobReceipt(line);
    const answered = line.name === "inbound.answered" || line.name === "reply.sent" && line.ok === true;
    const id = received ? line.ids?.messageId : line.ids?.inboundId;
    if ((received || answered) && line.ids?.chat && id) {
      const key = `${line.ids.chat}\0${id}`;
      const item = messages.get(key) ?? {};
      const field = received ? "received" : "replied";
      if (!item[field] || line.ts < item[field]) {
        item[field] = line.ts;
        item[received ? "receivedOrder" : "repliedOrder"] = order;
      }
      messages.set(key, item);
    }
    if (line.component !== "robob" || !["robob.link_down", "robob.link_up", "robob.link_state", "robob.link_reply"].includes(line.name) || !line.link) return;
    const previous = outages.get(line.link.outageId);
    if (!previous || line.ts >= previous.observedAt) outages.set(line.link.outageId, { link: line.link, observedAt: line.ts,
      recoveredOrder: line.name === "robob.link_up" ? order : previous?.recoveredOrder });
  }
  // An outage belongs to the UTC day of its first failure; later recovery/reply rows complete that day's record.
  function summary(day?: string) {
    const list = [...outages.values()].filter(({ link }) => !day || link.firstFailureAt.startsWith(day)).map(({ link, observedAt }) => ({ ...link,
      downMs: link.downMs ?? Math.max(0, Date.parse(observedAt) - Date.parse(link.firstFailureAt)), open: !link.recoveredAt }));
    for (const link of list) {
      let received = 0, during = 0, after = 0;
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
        if (!message.replied || message.replied < message.received) continue;
        if (afterRecovery(message.replied, message.repliedOrder)) {
          after++;
          if (!link.firstReplyAt || message.replied < link.firstReplyAt) link.firstReplyAt = message.replied;
        } else during++;
      }
      link.inboundReceivedDuringOutage = Math.max(received, link.inboundReceivedDuringOutage);
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
