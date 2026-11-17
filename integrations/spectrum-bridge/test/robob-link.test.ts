import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolLog, type LogLine } from "../src/toollog.ts";
import { ControlClient } from "../src/control.ts";
import { cleanRobobLink } from "../src/log-robob-link.ts";
import { captureLogs } from "./log-fixture.ts";

const fetchPreconnect = globalThis.fetch.preconnect;
const fetchMock = (implementation: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch =>
  Object.assign(implementation, { preconnect: fetchPreconnect });

const day = "2026-11-16";
const roots: string[] = [];
const logs: ReturnType<typeof createToolLog>[] = [];
afterEach(async () => {
  await Promise.all(logs.splice(0).map(log => log.settled()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(capBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), "robob-link-")); roots.push(root);
  let at = Date.parse(`${day}T12:00:00Z`);
  const log = createToolLog({ root, now: () => at, capBytes }); logs.push(log);
  const call = (cause?: string, ok = !cause, durationMs = 10) => log.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok, durationMs,
    props: { method: "GET", route: "/threads/:id/messages", ...(cause ? { linkCause: cause } : {}), failureFormat: "single" } });
  const received = (id: string) => log.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: "owner", messageId: id }, props: { backend: "robob", text: "PRIVATE_MESSAGE" } });
  const reply = (id: string) => log.write({ component: "router", kind: "perf", name: "inbound.answered", ids: { chat: "owner", inboundId: id }, durationMs: 10 });
  const rows = (date = day): LogLine[] => existsSync(join(root, `${date}.ndjson`)) ? readFileSync(join(root, `${date}.ndjson`), "utf8").trim().split("\n").map(row => JSON.parse(row)) : [];
  return { root, log, call, rows, received, reply, advance: (ms: number) => { at += ms; } };
}

test("100 failed calls collapse to five diagnostics and one down/up, with exact totals and reply milestones", async () => {
  const f = setup();
  f.call("ECONNREFUSED"); f.received("message-a");
  for (let i = 1; i < 100; i++) { f.advance(10); f.call(i < 60 ? "ECONNREFUSED" : "ETIMEDOUT"); }
  f.received("message-b"); f.received("message-b");
  f.advance(10); f.call();
  expect(f.rows().filter(row => row.name === "robob.link_down")).toHaveLength(1);
  expect(f.rows().filter(row => row.name === "robob.link_up")).toHaveLength(1);
  expect(f.rows().filter(row => row.name === "turn.robob_call")).toHaveLength(5);
  expect(f.rows().find(row => row.name === "robob.link_up")?.link).toMatchObject({ failedCalls: 100, suppressedCalls: 95, downMs: 1_000,
    causes: { ECONNREFUSED: 60, ETIMEDOUT: 40 }, inboundReceivedDuringOutage: 2, inboundAnsweredAfter: 0 });
  f.advance(50); f.reply("message-a"); f.reply("message-a");
  const rollup = await f.log.rollup(day);
  expect(rollup?.robob_link).toMatchObject({ totalDownMs: 1_000, longestMs: 1_000, byCause: { ECONNREFUSED: 60, ETIMEDOUT: 40 }, messagesWaiting: 1 });
  expect(rollup?.robob_link.outages[0]).toMatchObject({ inboundAnsweredAfter: 1, firstReplyAt: "2026-11-16T12:00:01.050Z", open: false });
  expect(rollup?.byComponent.robob.messages).toMatchObject({ count: 101, failed: 100, ok: 1 });
  expect(JSON.stringify(f.rows())).not.toContain("PRIVATE_MESSAGE");
});

test("failure/success flaps never declare an outage, including failed non-transport requests", async () => {
  const f = setup();
  for (let i = 0; i < 10; i++) { f.call("ECONNRESET"); f.call(); f.call("ECONNREFUSED"); f.call(undefined, false); }
  expect((await f.log.rollup(day))?.robob_link.outages).toEqual([]);
});

test("all successes over five seconds survive outage recovery even at the existing sampling limit", async () => {
  const f = setup();
  for (let i = 0; i < 20; i++) f.call(undefined, true, 6_000);
  for (let i = 0; i < 25; i++) { for (let n = 0; n < 3; n++) f.call("ECONNRESET"); f.call(undefined, true, 6_000); }
  await f.log.rollup(day);
  expect(f.rows().filter(row => row.name === "turn.robob_call" && row.ok)).toHaveLength(45);
});

test("open outages retain snapshots through the daily cap and roll up without a recovery", async () => {
  const f = setup(1);
  for (let i = 0; i < 100; i++) { f.call("ECONNREFUSED"); f.advance(10); }
  const rollup = await f.log.rollup(day);
  expect(rollup?.robob_link.outages[0]).toMatchObject({ failedCalls: 100, suppressedCalls: 95, downMs: 1_000, open: true });
});

test("cross-midnight recovery and replies refresh the original day's saved rollup", async () => {
  const f = setup();
  f.advance(12 * 3_600_000 - 100);
  for (let i = 0; i < 3; i++) f.call("ECONNRESET");
  f.received("message-a");
  await f.log.rollup(day);
  f.advance(200); f.call(); f.advance(100); f.reply("message-a");
  await f.log.tick(); await f.log.settled();
  const saved = JSON.parse(readFileSync(join(f.root, `rollup-${day}.json`), "utf8"));
  expect(saved.robob_link).toMatchObject({ totalDownMs: 200, messagesWaiting: 0 });
  expect(saved.robob_link.outages[0]).toMatchObject({ inboundAnsweredAfter: 1, open: false });
});

test("messages already answered during the outage are not still waiting", async () => {
  const f = setup();
  f.call("ECONNRESET"); f.received("message-a"); f.reply("message-a"); f.call("ECONNRESET"); f.call("ECONNRESET"); f.call();
  expect((await f.log.rollup(day))?.robob_link.messagesWaiting).toBe(0);
});

const forms: Array<{ label: string; code?: string; nested?: string; name?: string; status?: number; cancelled?: boolean; expected: boolean }> = [
  { label: "node refused", code: "ECONNREFUSED", expected: true },
  { label: "nested node reset", nested: "ECONNRESET", expected: true },
  { label: "bun refused alias", code: "ConnectionRefused", expected: true },
  { label: "bun timeout alias", code: "Timeout", expected: true },
  { label: "deadline", name: "TimeoutError", expected: true },
  { label: "undici headers", code: "UND_ERR_HEADERS_TIMEOUT", expected: true },
  { label: "caller cancellation", name: "AbortError", cancelled: true, expected: false },
  { label: "4xx body timeout", status: 409, name: "TimeoutError", expected: false },
  ...[400, 401, 403, 404, 408, 409, 429, 500, 503].map(status => ({ label: `HTTP ${status}`, status, expected: false })),
];
test.each(forms)("control classification: $label", async fixture => {
  const client = new ControlClient({ url: "http://127.0.0.1:3773", token: "PRIVATE_TOKEN" });
  const failure = Object.assign(new Error("PRIVATE_MESSAGE"), { name: fixture.name ?? "TypeError", code: fixture.code, cause: { code: fixture.nested } });
  const fail = async () => {
    if (fixture.status) return { ok: false, status: fixture.status, json: async () => { if (fixture.name) throw failure; return { ok: false, error: { code: "PRIVATE_MESSAGE" } }; } } as unknown as Response;
    throw failure;
  };
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(fetchMock(fail));
  const abort = new AbortController();
  if (fixture.cancelled) abort.abort();
  try {
    const rows = await captureLogs(async () => {
      fetcher.mockImplementation(fetchMock(async () => new Response(JSON.stringify({ ok: true }))));
      await client.request("GET", "/health");
      fetcher.mockImplementation(fetchMock(fail));
      for (let i = 0; i < 10; i++) await client.request("POST", "/threads/secret-id/send?text=PRIVATE_MESSAGE", { text: "PRIVATE_MESSAGE" }, { signal: abort.signal }).catch(() => {});
      fetcher.mockImplementation(fetchMock(async () => new Response(JSON.stringify({ ok: true }))));
      await client.request("GET", "/health");
    });
    expect(rows.filter(row => row.name === "robob.link_down")).toHaveLength(Number(fixture.expected));
    expect(rows.filter(row => row.name === "robob.link_up")).toHaveLength(Number(fixture.expected));
    expect(rows.filter(row => row.name === "turn.robob_call" && !row.ok)).toHaveLength(fixture.expected ? 5 : 10);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_MESSAGE");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_TOKEN");
    expect(rows.find(row => row.name === "robob.link_down")?.link?.route ?? "/threads/:id/send").toBe("/threads/:id/send");
  } finally { fetcher.mockRestore(); }
});


test("an empty day does not absorb later days' outages", async () => {
  const f = setup();
  f.advance(86400_000);
  for (let i = 0; i < 3; i++) f.call("ECONNREFUSED");
  f.call();
  expect((await f.log.rollup(day))?.robob_link.outages).toEqual([]);
});

test("link event cleaning accepts only counts, normalized causes, route templates and timestamps", () => {
  const safe = { outageId: "c5995564-4258-465d-b39c-670db4c76d6a", firstFailureAt: "2026-11-16T12:00:00.000Z", cause: "ECONNREFUSED" as const,
    route: "/threads/:id/send", failedCalls: 10, suppressedCalls: 5, causes: { ECONNREFUSED: 10 },
    inboundReceivedDuringOutage: 2, inboundAnsweredAfter: 1, inboundAnsweredDuringOutage: 0 };
  const dirty = { ...safe, text: "PRIVATE_MESSAGE", recoveredAt: "PRIVATE_MESSAGE", firstReplyAt: "PRIVATE_MESSAGE", causes: { ...safe.causes, PRIVATE_MESSAGE: 200 }, downMs: Infinity };
  expect(cleanRobobLink(dirty)).toEqual(safe);
  expect(cleanRobobLink({ ...safe, route: "/threads/:id/send?prompt=PRIVATE_MESSAGE" })).toBeUndefined();
  expect(JSON.stringify(cleanRobobLink(dirty))).not.toContain("PRIVATE_MESSAGE");
});

test("HTTP errors during a confirmed outage stay visible and do not inflate transport counts", async () => {
  const f = setup();
  for (let i = 0; i < 8; i++) f.call("ECONNREFUSED");
  for (let i = 0; i < 10; i++) f.call(undefined, false);
  f.call("ECONNRESET"); f.call();
  const rollup = await f.log.rollup(day);
  expect(rollup?.robob_link.outages[0]).toMatchObject({ failedCalls: 9, suppressedCalls: 4, causes: { ECONNREFUSED: 8, ECONNRESET: 1 } });
  expect(f.rows().filter(row => row.name === "turn.robob_call" && !row.ok)).toHaveLength(15);
});


test("a collapsed failure cannot discard pending render counts at the minute boundary", async () => {
  const f = setup();
  f.log.write({ component: "cards", kind: "perf", name: "card.render", ok: true, durationMs: 10, props: { cardKind: "quick", outcome: "ok" } });
  for (let i = 0; i < 5; i++) f.call("ECONNREFUSED");
  f.advance(60_000); f.call("ECONNREFUSED"); f.call();
  expect((await f.log.rollup(day))?.countsByName["card.render"]).toBe(1);
});

test("an open outage cannot attribute later traffic beyond its last observation to downtime", async () => {
  const f = setup();
  for (let i = 0; i < 3; i++) f.call("ECONNREFUSED");
  await f.log.rollup(day);
  const restarted = createToolLog({ root: f.root, now: () => Date.parse(`${day}T15:00:00Z`) }); logs.push(restarted);
  restarted.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: "owner", messageId: "after-restart" }, props: { backend: "robob" } });
  expect((await restarted.rollup(day))?.robob_link.messagesWaiting).toBe(0);
});


test.each(["bridge.stop", "turn.end"])("%s flushes final outage counters before process exit or rollup", async name => {
  const f = setup();
  for (let i = 0; i < 100; i++) f.call(i < 60 ? "ECONNREFUSED" : "ETIMEDOUT");
  f.log.write({ component: "process", kind: "event", name });
  await f.log.settled();
  expect(f.rows().filter(row => row.name === "robob.link_state").at(-1)?.link).toMatchObject({
    failedCalls: 100, suppressedCalls: 95, causes: { ECONNREFUSED: 60, ETIMEDOUT: 40 },
  });
  expect((await f.log.rollup(day))?.robob_link.byCause).toEqual({ ECONNREFUSED: 60, ETIMEDOUT: 40 });
});

const recoveryBoundaries = [
  { label: "reply before recovery, earlier millisecond", before: true, gap: 1, during: 1, after: 0 },
  { label: "reply before recovery, same millisecond", before: true, gap: 0, during: 1, after: 0 },
  { label: "reply after recovery, same millisecond", before: false, gap: 0, during: 0, after: 1 },
  { label: "reply after recovery, later millisecond", before: false, gap: 1, during: 0, after: 1 },
];
test.each(recoveryBoundaries)("recovery boundary: $label", async row => {
  const f = setup();
  for (let i = 0; i < 3; i++) f.call("ECONNREFUSED");
  f.received("message-a"); f.received("message-b");
  if (row.before) { f.reply("message-a"); f.advance(row.gap); f.call(); }
  else { f.call(); f.advance(row.gap); f.reply("message-a"); }
  f.reply("message-a");
  f.received("after-recovery");
  const result = await f.log.rollup(day);
  expect(result?.robob_link.outages[0]).toMatchObject({ inboundReceivedDuringOutage: 2,
    inboundAnsweredDuringOutage: row.during, inboundAnsweredAfter: row.after });
  expect(result?.robob_link.messagesWaiting).toBe(1);
});


const failureBoundaries = [
  { label: "receipt before failure, earlier millisecond", before: true, gap: 1, received: 0 },
  { label: "receipt before failure, same millisecond", before: true, gap: 0, received: 0 },
  { label: "receipt after failure, same millisecond", before: false, gap: 0, received: 1 },
  { label: "receipt after failure, later millisecond", before: false, gap: 1, received: 1 },
];
test.each(failureBoundaries)("first-failure boundary: $label", async row => {
  const f = setup();
  if (row.before) { f.received("message-a"); f.advance(row.gap); f.call("ECONNREFUSED"); }
  else { f.call("ECONNREFUSED"); f.advance(row.gap); f.received("message-a"); }
  f.call("ECONNREFUSED"); f.call("ECONNREFUSED"); f.call();
  const result = await f.log.rollup(day);
  expect(result?.robob_link.outages[0]?.inboundReceivedDuringOutage).toBe(row.received);
  expect(result?.robob_link.messagesWaiting).toBe(row.received);
  const outageId = result?.robob_link.outages[0]?.outageId;
  expect(f.rows().filter(line => line.name === "turn.robob_call" && !line.ok).every(line => line.ids?.outageId === outageId)).toBe(true);
  expect(f.rows().filter(line => line.name === "turn.robob_calls").every(line => line.ids?.outageId === undefined)).toBe(true);
});

const receiptBackends = [
  { chat: "owner", backend: "robob", count: 1 },
  { chat: "moni", backend: "robob", count: 1 },
  { chat: "family-trip", backend: "robob", count: 1 },
  { chat: "moni", backend: "remote-box", count: 0 },
  { chat: "owner", backend: "openchamber", count: 0 },
  { chat: "moni", backend: "openchamber", count: 0 },
  { chat: "owner", backend: "unknown", count: 0 },
  { chat: "moni", backend: undefined, count: 0 },
  { chat: "owner", backend: "PRIVATE_BACKEND", count: 0 },
];
test.each(receiptBackends)("outage receipts: $chat via $backend", async row => {
  const f = setup();
  for (let i = 0; i < 3; i++) f.call("ECONNREFUSED");
  f.log.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: row.chat, messageId: "message-a" },
    props: row.backend === undefined ? {} : { backend: row.backend } });
  f.call();
  expect(f.rows().find(line => line.name === "robob.link_up")?.link?.inboundReceivedDuringOutage).toBe(row.count);
  expect((await f.log.rollup(day))?.robob_link.messagesWaiting).toBe(row.count);
  f.log.write({ component: "router", kind: "event", name: "inbound.answered", ids: { chat: row.chat, inboundId: "message-a" } });
  const result = await f.log.rollup(day);
  expect(result?.robob_link.messagesWaiting).toBe(0);
  expect(result?.robob_link.outages[0]).toMatchObject({ inboundReceivedDuringOutage: row.count, inboundAnsweredAfter: row.count });
  expect(JSON.stringify(f.rows())).not.toContain("PRIVATE_BACKEND");
});
