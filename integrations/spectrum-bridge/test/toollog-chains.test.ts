import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolLog } from "../src/toollog.ts";

const fixtures: { root: string; logs: ReturnType<typeof createToolLog>[] }[] = [];
afterEach(async () => {
  for (const { root, logs } of fixtures.splice(0)) {
    await Promise.all(logs.map(log => log.settled()));
    rmSync(root, { recursive: true, force: true });
  }
});

const boundaries = [
  { name: "same day", received: "2026-11-13T23:59:55Z", startedMs: 2000, repliedMs: 3000 },
  { name: "midnight", received: "2026-11-13T23:59:59Z", startedMs: 2000, repliedMs: 3000 },
  { name: "month", received: "2026-11-30T23:59:59Z", startedMs: 2000, repliedMs: 3000 },
  { name: "year", received: "2026-12-31T23:59:59Z", startedMs: 2000, repliedMs: 3000 },
  { name: "several days", received: "2026-11-13T23:59:59Z", startedMs: 2 * 86400_000 + 2000, repliedMs: 3 * 86400_000 + 3000 },
];

test.each(boundaries.flatMap(boundary => [false, true].map(restart => ({ ...boundary, restart }))))(
  "$name, restart=$restart: later events refresh the cached receipt-day chain", async ({ received, startedMs, repliedMs, restart }) => {
    let time = Date.parse(received);
    const root = mkdtempSync(join(tmpdir(), "toollog-chains-"));
    const log = createToolLog({ root, now: () => time, defer: true });
    const logs = [log]; fixtures.push({ root, logs });
    const day = received.slice(0, 10);
    const cached = () => JSON.parse(readFileSync(join(root, `rollup-${day}.json`), "utf8"));
    log.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: "owner", messageId: "midnight-fixture" } });
    await log.rollup(day);
    expect(cached().chains.owner).toMatchObject({ received: 1, turnStarted: 0, replySent: 0, completed: 0 });
    const writer = restart ? createToolLog({ root, now: () => time, defer: true }) : log;
    if (restart) logs.push(writer);
    time = Date.parse(received) + startedMs;
    writer.write({ component: "router", kind: "event", name: "turn.start", ids: { chat: "owner", inboundId: "midnight-fixture" } });
    await writer.settled();
    expect(cached().chains.owner).toMatchObject({ received: 1, turnStarted: 1, replySent: 0, completed: 0 });
    time = Date.parse(received) + repliedMs;
    writer.write({ component: "delivery", kind: "perf", name: "reply.sent", ok: true, ids: { chat: "owner", inboundId: "midnight-fixture" } });
    await writer.settled();
    expect(cached().chains.owner).toEqual({ received: 1, turnStarted: 1, replySent: 1, completed: 1,
      receivedToStartMs: { p50: startedMs, p95: startedMs, max: startedMs },
      receivedToReplyMs: { p50: repliedMs, p95: repliedMs, max: repliedMs } });
    const replyDay = new Date(time).toISOString().slice(0, 10);
    if (replyDay !== day) {
      const rebuilt = await writer.rollup(day);
      expect(rebuilt?.total).toBe(1);
      expect(rebuilt?.countsByName).toEqual({ "msg.received": 1 });
      expect((await writer.rollup(replyDay))?.chains).toEqual({});
    }
  },
);

test("tick invalidates a cached receipt-day rollup when a later day changes, including after restart", async () => {
  let time = Date.parse("2026-11-13T23:59:59Z");
  const root = mkdtempSync(join(tmpdir(), "toollog-chains-cache-"));
  const log = createToolLog({ root, now: () => time });
  const logs = [log]; fixtures.push({ root, logs });
  log.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: "moni", messageId: "cache-fixture" } });
  time = Date.parse("2026-11-14T00:05:00Z");
  await log.tick();
  const path = join(root, "rollup-2026-11-13.json");
  const before = JSON.parse(readFileSync(path, "utf8"));
  // Append as another writer: the receipt file's size stays unchanged.
  const append = (name: string, ts: string) => appendFileSync(join(root, "2026-11-14.ndjson"), JSON.stringify({
    tool: "imessage", component: "fixture", kind: "event", name, ts, ok: true, ids: { chat: "moni", inboundId: "cache-fixture" },
  }) + "\n");
  append("turn.start", "2026-11-14T00:00:01Z");
  await log.tick();
  expect(JSON.parse(readFileSync(path, "utf8")).chains.moni.turnStarted).toBe(1);
  append("reply.sent", "2026-11-14T00:00:02Z");
  const restarted = createToolLog({ root, now: () => time }); logs.push(restarted);
  await restarted.tick();
  const after = JSON.parse(readFileSync(path, "utf8"));
  expect(after.sourceBytes).toBe(before.sourceBytes);
  expect(after.total).toBe(1);
  expect(after.chains.moni).toEqual({ received: 1, turnStarted: 1, replySent: 1, completed: 1,
    receivedToStartMs: { p50: 2000, p95: 2000, max: 2000 }, receivedToReplyMs: { p50: 3000, p95: 3000, max: 3000 } });
});

test("overlapping builds retain the last cross-day append and keep other chats independent", async () => {
  let time = Date.parse("2026-11-13T23:59:59Z");
  const root = mkdtempSync(join(tmpdir(), "toollog-chains-overlap-"));
  const log = createToolLog({ root, now: () => time, defer: true });
  fixtures.push({ root, logs: [log] });
  for (const chat of ["owner", "moni"]) log.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat, messageId: "shared-fixture" } });
  await log.rollup("2026-11-13");
  time += 2000;
  log.write({ component: "router", kind: "event", name: "turn.start", ids: { chat: "owner", inboundId: "shared-fixture" } });
  const building = log.rollup("2026-11-13");
  time += 1000;
  log.write({ component: "delivery", kind: "perf", name: "reply.sent", ok: true, ids: { chat: "owner", inboundId: "shared-fixture" } });
  log.write({ component: "delivery", kind: "perf", name: "reply.sent", ok: true, ids: { chat: "owner", inboundId: "unmatched-fixture" } });
  await building;
  await log.settled();
  const result = JSON.parse(readFileSync(join(root, "rollup-2026-11-13.json"), "utf8"));
  expect(result.total).toBe(2);
  expect(result.chains.owner).toMatchObject({ received: 1, turnStarted: 1, replySent: 1, completed: 1 });
  expect(result.chains.moni).toEqual({ received: 1, turnStarted: 0, replySent: 0, completed: 0 });
  expect(JSON.stringify(result.chains)).not.toContain("shared-fixture");
});

test.each([false, true])("multi-day raw appends recover an older receipt cache on tick, restart=%s", async restart => {
  let time = Date.parse("2026-11-13T23:59:59Z");
  const root = mkdtempSync(join(tmpdir(), "toollog-chains-recovery-"));
  const log = createToolLog({ root, now: () => time });
  const logs = [log]; fixtures.push({ root, logs });
  log.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: "moni", messageId: "old-receipt" } });
  await log.rollup("2026-11-13");
  time = Date.parse("2026-11-15T00:05:00Z");
  await log.tick();
  const path = join(root, "rollup-2026-11-13.json");
  expect(JSON.parse(readFileSync(path, "utf8")).chains.moni.completed).toBe(0);
  const later = (name: string, ts: string) => ({ tool: "imessage", component: "fixture", kind: "event", name, ts,
    ok: true, ids: { chat: "moni", inboundId: "old-receipt" } });
  appendFileSync(join(root, "2026-11-15.ndjson"), [later("turn.start", "2026-11-15T00:00:01Z"), later("reply.sent", "2026-11-15T00:00:02Z")]
    .map(row => JSON.stringify(row) + "\n").join(""));
  const reader = restart ? createToolLog({ root, now: () => time }) : log;
  if (restart) logs.push(reader); else time += 3_600_000;
  await reader.tick();
  const result = JSON.parse(readFileSync(path, "utf8"));
  expect(result.total).toBe(1);
  expect(result.chains.moni).toEqual({ received: 1, turnStarted: 1, replySent: 1, completed: 1,
    receivedToStartMs: { p50: 86402_000, p95: 86402_000, max: 86402_000 },
    receivedToReplyMs: { p50: 86403_000, p95: 86403_000, max: 86403_000 } });
});
