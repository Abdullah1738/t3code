import { expect, test } from "bun:test";
import { MAX_REPLY_LATENCY_MS, replyLatency, unknownReplyLatency } from "../src/reply-latency.ts";
import { summarizeLog } from "../src/log-rollup.ts";
import type { LogLine } from "../src/toollog.ts";

const end = Date.parse("2026-11-23T17:50:19.995Z");

test.each([
  ["normal receive time", end - 42_000, "received", { durationMs: 42_000 }],
  ["exactly 24 h", end - MAX_REPLY_LATENCY_MS, "received", { durationMs: MAX_REPLY_LATENCY_MS }],
  ["clock skew within a minute", end + 30_000, "received", { durationMs: 0 }],
  // 23 Nov: spc-msg-34799625 was received 2026-09-10T21:32:46.118Z and logged 6,380,253,877 ms.
  ["the 23 Nov 73-day row", Date.parse("2026-09-10T21:32:46.118Z"), "received",
    { props: { durationUnknown: true, startSource: "received", durationInvalid: "over_24h" } }],
  ["one ms over 24 h", end - MAX_REPLY_LATENCY_MS - 1, "received",
    { props: { durationUnknown: true, startSource: "received", durationInvalid: "over_24h" } }],
  ["seconds instead of ms", Math.floor((end - 5_000) / 1000), "received",
    { props: { durationUnknown: true, startSource: "received", durationInvalid: "over_24h" } }],
  ["start in the future", end + 61_000, "received",
    { props: { durationUnknown: true, startSource: "received", durationInvalid: "future" } }],
  ["missing receive time", undefined, "received", { props: { durationUnknown: true, startSource: "missing" } }],
  ["epoch-0 receive time", 0, "received", { props: { durationUnknown: true, startSource: "missing" } }],
  ["negative receive time", -1, "received", { props: { durationUnknown: true, startSource: "missing" } }],
  ["string receive time", "2026-11-23", "received", { props: { durationUnknown: true, startSource: "missing" } }],
  ["fractional receive time", end - 0.5, "received", { props: { durationUnknown: true, startSource: "missing" } }],
  ["NaN receive time", Number.NaN, "received", { props: { durationUnknown: true, startSource: "missing" } }],
  ["synthetic start", end - 1_000, "synthetic", { props: { durationUnknown: true, startSource: "synthetic" } }],
  ["explicitly missing start", end - 1_000, "missing", { props: { durationUnknown: true, startSource: "missing" } }],
] as const)("%s", (_label, start, source, expected) => {
  expect(replyLatency(end, start, source)).toEqual(expected);
});

test("legacy rows over 24 h and flagged rows are unknown only for reply latency events", () => {
  expect(unknownReplyLatency({ name: "inbound.answered", durationMs: 6_380_253_877 })).toBe(true);
  expect(unknownReplyLatency({ name: "reply.sent", props: { durationUnknown: true } })).toBe(true);
  expect(unknownReplyLatency({ name: "reply.gap", durationMs: MAX_REPLY_LATENCY_MS })).toBe(false);
  expect(unknownReplyLatency({ name: "turn.robob_call", durationMs: 6_380_253_877 })).toBe(false);
});

function line(name: string, chat: string, durationMs?: number, props?: LogLine["props"]): LogLine {
  return { ts: "2026-11-23T17:50:19.995Z", tool: "imessage", component: name === "inbound.answered" ? "router" : "delivery", kind: "perf", name,
    ...(durationMs === undefined ? {} : { durationMs }), ids: { chat, inboundId: "spc-msg-x" }, ...(props ? { props } : {}) };
}

test("rollup leaves unknown and legacy over-24 h durations out of the percentiles and counts them", async () => {
  const unknown = { durationUnknown: true, startSource: "received", durationInvalid: "over_24h" } as const;
  const lines: LogLine[] = [
    line("inbound.answered", "owner", 2_000), line("inbound.answered", "owner", 4_000), line("inbound.answered", "moni", 6_000),
    // Rows already on disk from 23 Nov carry the bogus number and no flag.
    ...Array.from({ length: 212 }, (_, n) => line("inbound.answered", "owner", 1_000_000_000 + n)),
    line("inbound.answered", "owner", undefined, unknown), line("inbound.answered", "group-x", undefined, unknown),
    line("reply.sent", "owner", 3_000), line("reply.sent", "owner", 6_380_253_876),
    line("reply.sent", "owner", undefined, { durationUnknown: true, startSource: "synthetic", outboxDelayMs: 50 }),
    line("reply.gap", "owner", 90_000), line("reply.gap", "owner", 6_380_253_876),
  ];
  const summary = await summarizeLog((async function* () { yield* lines; })());
  expect(summary.first_reply_latency_ms).toEqual({ p50: 4_000, p95: 6_000, max: 6_000, durationUnknownCount: 213 });
  expect(summary.durationUnknownCount).toEqual({ "inbound.answered": 214, "reply.sent": 2, "reply.gap": 1 });
  expect(summary.durationMs["inbound.answered"]).toEqual({ p50: 4_000, p95: 6_000, max: 6_000 });
  expect(summary.durationMs["reply.sent"]).toEqual({ p50: 3_000, p95: 3_000, max: 3_000 });
  expect(summary.durationMs["reply.gap"]).toEqual({ p50: 90_000, p95: 90_000, max: 90_000 });
  expect(summary.byComponent.delivery?.["reply.sent"]).toMatchObject({ count: 3, ok: 0, durationMs: { max: 3_000 } });
  expect(summary.countsByName["inbound.answered"]).toBe(217);
});

test("a day with no unknown rows reports zero counts", async () => {
  const summary = await summarizeLog((async function* () { yield line("inbound.answered", "owner", 5_000); })());
  expect(summary.first_reply_latency_ms).toEqual({ p50: 5_000, p95: 5_000, max: 5_000, durationUnknownCount: 0 });
  expect(summary.durationUnknownCount).toEqual({ "inbound.answered": 0, "reply.sent": 0, "reply.gap": 0 });
});
