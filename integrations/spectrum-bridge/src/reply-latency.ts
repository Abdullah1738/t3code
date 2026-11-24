/** Events whose durationMs measures a human message's wait for a reply. */
export const REPLY_LATENCY_EVENTS: readonly string[] = ["inbound.answered", "reply.sent", "reply.gap"];
export const START_SOURCES = ["received", "synthetic", "missing"] as const;
export const DURATION_INVALID = ["future", "over_24h"] as const;
export type StartSource = typeof START_SOURCES[number];

// A reply crediting a weeks-old stranded row measures the backlog, not latency (#136: one owner reply
// on 23 Nov credited 212 rows from 10 Sep to 11 Nov and logged 73-day durations).
export const MAX_REPLY_LATENCY_MS = 24 * 60 * 60_000;
// Sendblue stamps receivedAt with the provider's send time, so a start slightly ahead of this clock is skew.
const CLOCK_SKEW_MS = 60_000;

export type UnknownLatency = { durationUnknown: true; startSource: StartSource; durationInvalid?: typeof DURATION_INVALID[number] };
export type ReplyLatency = { durationMs: number; props?: undefined } | { durationMs?: undefined; props: UnknownLatency };

/** Only a real receive time within 24 h yields a duration; anything else is logged as unknown. */
export function replyLatency(end: number, start: unknown, startSource: StartSource): ReplyLatency {
  const valid = typeof start === "number" && Number.isSafeInteger(start) && start > 0;
  if (startSource !== "received" || !valid) {
    return { props: { durationUnknown: true, startSource: startSource === "received" ? "missing" : startSource } };
  }
  const ms = end - start;
  if (ms < -CLOCK_SKEW_MS) return { props: { durationUnknown: true, startSource, durationInvalid: "future" } };
  if (ms > MAX_REPLY_LATENCY_MS) return { props: { durationUnknown: true, startSource, durationInvalid: "over_24h" } };
  return { durationMs: Math.max(0, ms) };
}

/** Rows written before #136 carry no durationUnknown flag, so an over-24 h duration is rejected on read too. */
export function unknownReplyLatency(line: { name: string; durationMs?: number; props?: Record<string, unknown> }): boolean {
  if (!REPLY_LATENCY_EVENTS.includes(line.name)) return false;
  return line.props?.durationUnknown === true || line.durationMs !== undefined && line.durationMs > MAX_REPLY_LATENCY_MS;
}
