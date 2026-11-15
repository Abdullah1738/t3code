import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolLog, toolLog, type LogLine } from "../src/toollog.ts";
import { ControlClient } from "../src/control.ts";
import { OpenChamber, type MessageRecord } from "../src/openchamber.ts";
import { Router } from "../src/router.ts";
import { Store } from "../src/store.ts";
import { captureLogs } from "./log-fixture.ts";

const day = "2026-11-13";
const roots: string[] = [];
const logs: ReturnType<typeof createToolLog>[] = [];
afterEach(async () => {
  await Promise.all(logs.splice(0).map(log => log.settled()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(capBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), "toollog-aggregate-")); roots.push(root);
  let clock = Date.parse(`${day}T12:00:00Z`);
  const log = createToolLog({ root, now: () => clock, defer: true, capBytes }); logs.push(log);
  const file = (date = day) => join(root, `${date}.ndjson`);
  const rows = (date = day): LogLine[] => existsSync(file(date)) ? readFileSync(file(date), "utf8").trim().split("\n").map(row => JSON.parse(row)) : [];
  function turn(name: "turn.start" | "turn.end", threadId = "thread-a", messageId = "message-a") {
    log.write({ component: "router", kind: name === "turn.start" ? "event" : "perf", name, ids: { threadId, messageId }, ok: true });
  }
  function call(durationMs: number, ok = true, threadId = "thread-a", route = "/threads/:id", captured = log.runIds(threadId)) {
    log.write({ component: "robob", kind: "perf", name: "turn.robob_call", durationMs, ok, ids: captured, props: { method: "GET", route } });
  }
  return { root, log, file, rows, turn, call, time: (at: string) => { clock = Date.parse(at); } };
}

test("one summary per completed turn retains slow/failed calls and exact millisecond percentiles", async () => {
  const { root, log, rows, turn, call } = setup();
  turn("turn.start");
  for (const ms of [10, 20, 30, 900, 1_000, 1_500, 6_000]) call(ms);
  call(50, false);
  turn("turn.end");
  await log.settled();
  expect(rows().filter(row => row.name === "turn.robob_call").map(row => row.durationMs)).toEqual([6_000, 50]);
  const summary = rows().find(row => row.name === "turn.robob_calls")!;
  expect(summary.calls?.thread).toMatchObject({ count: 8, ok: 7, failed: 1, p50: 50, p95: 6_000, max: 6_000 });
  expect(new Set(rows().map(row => row.ids?.runId)).size).toBe(1);
  const result = JSON.parse(readFileSync(join(root, `rollup-${day}.json`), "utf8"));
  expect(result).toMatchObject({ total: 10, recordedRows: 5, countsByName: { "turn.robob_call": 8 }, ok: 9, failed: 1 });
  expect(result.byComponent.robob.thread).toMatchObject({ count: 8, ok: 7, failed: 1, errorRate: .125, durationMs: { p50: 50, p95: 6_000, max: 6_000 } });
});

test.each(["legacy", "mixed", "reversed", "orphan", "new_only", "new_orphan", "summary_only"])("failure format %s counts each diagnostic once", async shape => {
  const { log, file } = setup();
  const raw = (batch: string, single: boolean): LogLine => ({ ts: `${day}T12:00:00Z`, tool: "imessage", component: "robob",
    kind: "perf", name: "turn.robob_call", ok: false, durationMs: 25_000, ids: { runId: "same-run", callBatchId: batch },
    props: { method: "GET", route: "/threads/:id/messages", ...(single ? { failureFormat: "single" } : {}) },
    error: { tag: "control.request_failed", name: "TimeoutError", message: "[redacted]" } });
  const summary = (batch: string): LogLine => ({ ts: `${day}T12:00:00Z`, tool: "imessage", component: "robob", kind: "perf",
    name: "turn.robob_calls", ids: { runId: "same-run", callBatchId: batch }, calls: { messages: {
      count: 10, ok: 9, failed: 1, p50: 10, p95: 25_000, max: 25_000, histogram: [[10, 9], [25_000, 1]],
    } } });
  const legacy: LogLine = { ts: `${day}T12:00:00Z`, tool: "imessage", component: "control", kind: "error", name: "bridge.catch",
    ok: false, ids: { runId: "same-run" }, error: { tag: "control.catch1", name: "TimeoutError", message: "[redacted]" } };
  const records = shape === "new_orphan" ? [raw("new", true)]
    : shape === "new_only" ? [raw("new", true), summary("new")]
    : shape === "summary_only" ? [summary("old")]
    : shape === "orphan" ? [legacy, raw("old", false), raw("new", true)]
    : [legacy, raw("old", false), summary("old"), ...(shape === "legacy" ? [] : [raw("new", true), summary("new")])];
  if (shape === "mixed") for (const row of records) if (row.ids?.callBatchId === "new") row.ts = `${day}T13:00:00Z`;
  if (shape === "reversed") records.reverse();
  writeFileSync(file(), records.map(row => JSON.stringify(row) + "\n").join(""));
  const result = await log.rollup(day);
  const total = shape === "new_orphan" ? 1 : shape === "legacy" ? 11 : shape === "orphan" ? 3 : shape === "new_only" || shape === "summary_only" ? 10 : 21;
  const newOnly = shape === "new_only" || shape === "new_orphan";
  const hasCatch = !newOnly && shape !== "summary_only";
  const callFailures = shape === "legacy" || newOnly || shape === "summary_only" ? 1 : 2;
  const diagnostics = shape === "legacy" || newOnly ? 1 : shape === "summary_only" ? 0 : 2;
  expect(result).toMatchObject({ total, failed: callFailures + Number(hasCatch), recordedRows: records.length, errorRate: diagnostics / total });
  expect(result?.countsByName["turn.robob_call"]).toBe(total - Number(hasCatch));
  expect(result?.byComponent.robob.messages.failed).toBe(callFailures);
  expect(result?.topErrorTags.map(({ tag, count }) => ({ tag, count }))).toEqual([
    ...(!hasCatch ? [] : [{ tag: "control.catch1", count: 1 }]),
    ...(shape === "legacy" || shape === "summary_only" ? [] : [{ tag: "control.request_failed", count: 1 }]),
  ]);
});

test.each([1_500, 5_000, 5_000.01, 5_001, 6_000])("the five-second threshold uses the original timing %s", async ms => {
  const { log, rows, turn, call } = setup();
  turn("turn.start"); call(ms); turn("turn.end"); await log.settled();
  expect(rows().filter(row => row.name === "turn.robob_call")).toHaveLength(ms > 5_000 ? 1 : 0);
});

test("slow-row limit survives summary flushes and never caps failures", async () => {
  const { log, rows, turn, call } = setup();
  turn("turn.start");
  for (let i = 0; i < 50; i++) {
    call(6_000);
    if (i === 24) await log.rollup(day);
  }
  await log.rollup(day);
  expect(rows().filter(row => row.name === "turn.robob_call")).toHaveLength(20);
  expect(rows().flatMap(row => row.calls?.thread ? [row.calls.thread] : []).reduce((sum, stats) => sum + (stats.suppressedSlow ?? 0), 0)).toBe(30);
  expect((await log.rollup(day))?.byComponent.robob.thread).toMatchObject({ count: 50, ok: 50, failed: 0 });
  for (let i = 0; i < 25; i++) call(6_000, false);
  turn("turn.end");
  await log.rollup(day);
  expect(rows().filter(row => row.name === "turn.robob_call" && row.ok === false)).toHaveLength(25);
});

test("sliding limits separate run and call name and expire at ten minutes", async () => {
  const { log, rows, turn, call, time } = setup();
  turn("turn.start");
  for (let i = 0; i < 20; i++) call(6_000);
  time(`${day}T12:09:59.999Z`); call(6_000);
  call(6_000, true, "thread-a", "/threads/:id/messages");
  turn("turn.start", "thread-b", "message-b"); call(6_000, true, "thread-b");
  time(`${day}T12:10:00.000Z`); call(6_000);
  await log.rollup(day);
  const raw = rows().filter(row => row.name === "turn.robob_call");
  expect(raw).toHaveLength(23);
  expect(raw.filter(row => row.props?.route === "/threads/:id/messages")).toHaveLength(1);
  expect(rows().find(row => row.calls?.thread?.suppressedSlow)?.calls?.thread.suppressedSlow).toBe(1);
});

test.each([
  { name: "TimeoutError", code: undefined, response: "throw", status: 0 },
  { name: "TypeError", code: "ECONNREFUSED", response: "throw", status: 0 },
  { name: "SyntaxError", code: undefined, response: "json", status: 200 },
  { name: "TimeoutError", code: undefined, response: "body", status: 200 },
  { name: "AbortError", code: undefined, response: "body", status: 200 },
  { name: "TypeError", code: "ECONNRESET", response: "body", status: 200 },
  { name: "ControlError", code: undefined, response: "http", status: 503 },
])("failed control $name requests retain one error row and one rollup failure", async fixture => {
  const { root, rows } = setup();
  const previous = process.env.TOOLLOG_DIR;
  process.env.TOOLLOG_DIR = root;
  const cause = Object.assign(new Error("PRIVATE +971501234567 /private/PRIVATE https://private.test/?token=PRIVATE"), fixture);
  const fake = Object.assign(async () => {
    if (fixture.response === "json") return new Response("PRIVATE", { status: fixture.status });
    if (fixture.response === "body") return new Response(new ReadableStream({ start(controller) { controller.error(cause); } }), { status: fixture.status });
    if (fixture.response === "http") return Response.json({ ok: false }, { status: fixture.status });
    throw cause;
  }, { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(fake);
  try {
    toolLog.write({ component: "process", kind: "event", name: "bridge.stop" });
    await expect(new ControlClient({ url: "http://127.0.0.1:3773", token: "PRIVATE_TOKEN" }).request("GET", "/threads/thread-a/messages?search=PRIVATE")).rejects.toMatchObject({ status: fixture.status });
    const date = new Date().toISOString().slice(0, 10);
    const result = await toolLog.rollup(date);
    const records = rows(date);
    expect(records.filter(row => row.error)).toHaveLength(1);
    const failure = records.find(row => row.error)!;
    const tag = fixture.response === "json" ? "control.invalid_json" : "control.request_failed";
    expect(failure).toMatchObject({ name: "turn.robob_call", ok: false, props: { method: "GET", route: "/threads/:id/messages", failureFormat: "single" },
      error: { tag, name: fixture.name } });
    expect(failure.ids?.runId).toBeTruthy();
    expect(result?.failed).toBe(1);
    expect(result?.errorRate).toBe(1 / result!.total);
    expect(result?.topErrorTags).toMatchObject([{ tag, count: 1 }]);
    expect(result?.byComponent.robob.messages).toMatchObject({ count: 1, failed: 1, errorRate: 1 });
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  } finally {
    fetch.mockRestore();
    toolLog.write({ component: "process", kind: "event", name: "bridge.stop" }); toolLog.flush(); await toolLog.settled();
    if (previous === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = previous;
  }
});

test.each(["upload", "stream"])("non-request %s failures retain cause keys and rollup causes after #40", async operation => {
  const cause = Object.assign(new Error("PRIVATE +971501234567 /private/PRIVATE https://private.test/?token=PRIVATE"), { code: "ECONNRESET" });
  const fake = Object.assign(async (url: string | URL | Request) => {
    if (String(url).endsWith("/attachments")) return Response.json({ ok: true, attachmentId: "fixture", relativeUrl: "/signed" });
    throw cause;
  }, { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(fake);
  const tag = operation === "upload" ? "control.catch3" : "control.catch5";
  try {
    const records = await captureLogs(async () => {
      const client = new ControlClient({ url: "http://127.0.0.1:3773", token: "PRIVATE_TOKEN" });
      const action = operation === "upload" ? client.upload({ name: "PRIVATE", mimeType: "image/png", bytes: new Uint8Array([1]) })
        : client.events({ signal: new AbortController().signal }).next();
      await expect(action).rejects.toMatchObject({ status: 0 });
      const result = await toolLog.rollup(new Date().toISOString().slice(0, 10));
      expect(result?.topCauses).toContainEqual({ tag, causeKey: "code.ECONNRESET", count: 1 });
    });
    const catches = records.filter(row => row.name === "bridge.catch");
    expect(catches).toHaveLength(1);
    expect(catches[0]?.error).toMatchObject({ tag, causeKey: "code.ECONNRESET" });
    expect(catches[0]?.site).toMatch(/^src\/control.ts:\d+$/);
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  } finally { fetch.mockRestore(); }
});

test("interleaved turns and calls completing after a new turn keep their captured run id", async () => {
  const { log, rows, turn, call } = setup();
  turn("turn.start", "thread-a", "a"); const a = log.runIds("thread-a");
  turn("turn.start", "thread-b", "b"); const b = log.runIds("thread-b");
  call(10, true, "thread-a"); call(20, true, "thread-b");
  turn("turn.end", "thread-a", "a");
  turn("turn.start", "thread-a", "a2"); const a2 = log.runIds("thread-a");
  call(2_000, false, "thread-a", "/threads/:id", a);
  call(30, true, "thread-a");
  turn("turn.end", "thread-b", "b"); turn("turn.end", "thread-a", "a2");
  const result = await log.rollup(day);
  expect(new Set([a.runId, a2.runId, b.runId]).size).toBe(3);
  expect(rows().find(row => row.name === "turn.robob_call")?.ids?.runId).toBe(a.runId);
  expect(result?.byComponent.robob?.thread.count).toBe(4);
});

test("a delayed old turn.end cannot close the new turn's aggregation", async () => {
  const { log, rows, turn, call } = setup();
  turn("turn.start", "thread-a", "a"); const a = log.runIds("thread-a").runId;
  call(10);
  turn("turn.start", "thread-a", "b"); const b = log.runIds("thread-a").runId;
  turn("turn.end", "thread-a", "a");
  expect(log.runIds("thread-a").runId).toBe(b);
  call(20); turn("turn.end", "thread-a", "b"); await log.settled();
  expect(rows().filter(row => row.name === "turn.end").map(row => row.ids?.runId)).toEqual([a, b]);
  expect(rows().filter(row => row.calls).map(row => row.calls?.thread.count)).toEqual([1, 1]);
});

test("resuming a durable turn restores its stable run id without another turn.start", async () => {
  const first = setup(); first.turn("turn.start"); const id = first.log.runIds("thread-a").runId;
  const resumed = setup(); resumed.log.beginRun("thread-a", "message-a");
  expect(resumed.log.runIds("thread-a").runId).toBe(id);
  resumed.call(25); resumed.turn("turn.end"); await resumed.log.settled();
  expect(resumed.rows().some(row => row.name === "turn.start")).toBe(false);
  expect(resumed.rows().find(row => row.calls)?.ids?.runId).toBe(id);
});

test("a fresh Router restores a persisted running turn before its first backend poll", async () => {
  const prior = setup(); prior.log.beginRun("thread-a", "message-a");
  const expectedId = prior.log.runIds("thread-a").runId;
  const { root, rows } = setup();
  const previous = process.env.TOOLLOG_DIR;
  process.env.TOOLLOG_DIR = root;
  toolLog.write({ component: "process", kind: "event", name: "bridge.stop" }); toolLog.flush();
  const path = join(root, "restart.sqlite");
  let store = new Store(path);
  store.set("route", { id: "thread-a", directory: "/fixture", generation: 1 });
  store.set("activeTurn", { id: "thread-a", directory: "/fixture", generation: 1, messageId: "message-a", phase: "running", startedAt: Date.now() });
  store.set("log-turn-start:message-a", true);
  store.close(); store = new Store(path);
  const captured: string[] = [];
  let unexpected = 0;
  class Backend extends OpenChamber {
    constructor() { super("http://127.0.0.1:1"); }
    override async request<T>(): Promise<T | undefined> { unexpected++; throw new Error("Unexpected backend request"); }
    override async messages(): Promise<MessageRecord[]> {
      const ids = toolLog.runIds("thread-a"); captured.push(ids.runId!);
      toolLog.write({ component: "robob", kind: "perf", name: "turn.robob_call", durationMs: 10, ok: true, ids, props: { method: "GET", route: "/threads/:id/messages" } });
      return [{ id: "message-a", type: "user", text: "PRIVATE", time: { created: Date.now() } }];
    }
    override async statuses() { return { "thread-a": { type: "busy" as const } }; }
    override async children() { return []; }
    override async permissions() { return []; }
    override async questions() { return []; }
  }
  const router = new Router(store, new Backend(), {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("Unexpected attachment"); },
  }, { owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", quietMs: 0,
    skillPath: "/fixture/skill", alertSkillPath: "/fixture/alert", alertSocketPath: "/fixture/socket", openCodeConfigRoot: "/nonexistent/opencode", medsFold: false });
  try {
    await router.tick(); await router.tick();
    expect(unexpected).toBe(0);
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(new Set(captured)).toEqual(new Set([expectedId]));
    expect(store.get("activeTurn")).toMatchObject({ phase: "running", messageId: "message-a" });
    toolLog.write({ component: "router", kind: "perf", name: "turn.end", ids: { threadId: "thread-a", messageId: "message-a" }, ok: true });
    await toolLog.settled();
    const records = rows(new Date().toISOString().slice(0, 10));
    expect(records.some(row => row.name === "turn.start")).toBe(false);
    expect(records.find(row => row.calls)?.calls?.messages.count).toBe(captured.length);
    expect(records.find(row => row.calls)?.ids?.runId).toBe(expectedId);
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
    expect(store.pendingOutbox()).toHaveLength(0);
  } finally {
    store.close(); toolLog.flush(); await toolLog.settled();
    if (previous === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = previous;
  }
});

test("hourly and UTC rollover flush calls without a turn.end and rebuild stale zero rollups", async () => {
  const { root, log, file, rows, call, time } = setup();
  call(25);
  writeFileSync(join(root, `rollup-${day}.json`), JSON.stringify({ day, tool: "imessage", total: 0 }));
  await log.tick();
  expect(JSON.parse(readFileSync(join(root, `rollup-${day}.json`), "utf8")).countsByName["turn.robob_call"]).toBe(1);
  call(50); time(`${day}T13:00:00Z`); await log.tick();
  expect(JSON.parse(readFileSync(join(root, `rollup-${day}.json`), "utf8")).countsByName["turn.robob_call"]).toBe(2);
  call(75); time("2026-11-14T00:05:00Z");
  call(100); await log.tick();
  const yesterday = JSON.parse(readFileSync(join(root, `rollup-${day}.json`), "utf8"));
  expect(yesterday.countsByName["turn.robob_call"]).toBe(3);
  expect(yesterday.sourceBytes).toBe(statSync(file()).size);
  expect(rows("2026-11-14").find(row => row.calls)?.calls?.thread.count).toBe(1);
});

test("raw slow calls without a surviving summary remain counted after a crash", async () => {
  const { log, rows, turn, call } = setup();
  turn("turn.start"); call(2_000, false);
  // The automatic completed-turn rollup is absent; flush the pending raw record only.
  await Promise.resolve();
  const line = rows().find(row => row.name === "turn.robob_call")!;
  const other = setup(); appendFileSync(other.file(), JSON.stringify(line) + "\n");
  expect((await other.log.rollup(day))?.byComponent.robob?.thread).toMatchObject({ count: 1, failed: 1 });
  log.flush();
});

test.each([
  ["covered", "/threads/:id", "perf", 1],
  ["partial", "/threads/:id/messages", "perf", 2],
  ["error", "/threads/:id", "error", 2],
])("summary matching keeps independent observations %#", async (_case, route, kind, expected) => {
  const { log, file } = setup();
  const ids = { callBatchId: "batch-fixture", runId: "run-fixture" };
  const stats = { count: 1, ok: 1, failed: 0, p50: 5, p95: 5, max: 5, histogram: [[5, 1]] };
  const rows = [
    { ts: `${day}T12:00:00Z`, tool: "imessage", component: "robob", kind: "perf", name: "turn.robob_calls", ids,
      calls: { thread: stats, messages: { ...stats, histogram: [[5, 2]] } } },
    { ts: `${day}T12:00:00Z`, tool: "imessage", component: "robob", kind, name: "turn.robob_call", ids,
      ok: false, durationMs: 1_500, props: { method: "GET", route }, error: { tag: "fixture.failed", message: "PRIVATE" } },
  ];
  writeFileSync(file(), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const result = await log.rollup(day);
  expect(result?.countsByName["turn.robob_call"]).toBe(expected);
  if (kind === "error") expect(result?.topErrorTags[0]).toMatchObject({ tag: "fixture.failed", count: 1 });
});

test("degraded mode preserves errors, turn boundaries, summaries and slow/failed calls across writers", async () => {
  const { root, log, rows, turn, call } = setup(1);
  log.write({ component: "fixture", kind: "event", name: "before.cap" });
  log.write({ component: "fixture", kind: "perf", name: "card.render", durationMs: 10 });
  turn("turn.start"); call(10); call(6_000); call(50, false); turn("turn.end");
  await log.settled();
  const second = createToolLog({ root, now: () => Date.parse(`${day}T12:00:00Z`), capBytes: 1 }); logs.push(second);
  second.write({ component: "fixture", kind: "event", name: "after.cap" });
  second.write({ component: "fixture", kind: "error", name: "reply.failed", error: { tag: "fixture.failed", message: "PRIVATE" } });
  expect(rows().map(row => row.name)).toEqual(["before.cap", "log.degraded", "turn.start", "turn.robob_call", "turn.robob_call", "turn.robob_calls", "turn.end", "reply.failed"]);
});

test("aggregate metadata cannot carry message text, paths, query strings or arbitrary call names", async () => {
  const { log, rows } = setup();
  log.write({ component: "robob", kind: "perf", name: "turn.robob_calls", calls: {
    PRIVATE_BODY: { count: 1, ok: 1, failed: 0, p50: 1, p95: 1, max: 1, histogram: [[1, 1]] },
    thread: { count: 999, ok: 1, failed: 0, p50: 971501234567, p95: 971501234567, max: 971501234567, suppressedSlow: 971501234567, histogram: [[5, 1], [971501234567, 1]] },
  } });
  log.flush();
  const raw = JSON.stringify(rows());
  expect(raw).not.toContain("PRIVATE"); expect(raw).not.toContain("971501234567");
  expect(rows()[0].calls?.thread).toMatchObject({ count: 1, p50: 5, p95: 5, max: 5 });
  expect(JSON.stringify(await log.rollup(day))).not.toContain("PRIVATE");
});

test("68,226 fast calls over 222 turns stay below one megabyte with a non-zero daily rollup", async () => {
  const { log, file, rows, turn, call } = setup();
  for (let i = 0; i < 222; i++) {
    turn("turn.start", "thread-a", `message-${i}`);
    const count = Math.floor(68_226 / 222) + (i < 68_226 % 222 ? 1 : 0);
    for (let n = 0; n < count; n++) call(100 + n % 200);
    turn("turn.end", "thread-a", `message-${i}`);
  }
  await log.settled();
  expect(statSync(file()).size).toBeLessThan(1_000_000);
  console.info(`busy-day fixture: 68226 calls, 222 turns, ${statSync(file()).size} bytes`);
  expect(rows().filter(row => row.name === "turn.robob_calls")).toHaveLength(222);
  const result = await log.rollup(day);
  expect(result?.countsByName["turn.robob_call"]).toBe(68_226);
  expect(result?.byComponent.robob?.thread.durationMs?.p95).toBe(284);
});

test("the control client captures the turn before awaiting and leaves the response unchanged", async () => {
  const { root, rows } = setup();
  const previous = process.env.TOOLLOG_DIR;
  process.env.TOOLLOG_DIR = root;
  const client = new ControlClient({ url: "http://127.0.0.1:3773", token: "FIXTURE_TOKEN" });
  let resolveFetch!: (response: Response) => void;
  const fakeFetch = Object.assign(() => new Promise<Response>(resolve => { resolveFetch = resolve; }), { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
  const clock = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(6_000);
  try {
    toolLog.write({ component: "router", kind: "event", name: "turn.start", ids: { threadId: "thread-a", messageId: "a" } });
    const first = toolLog.runIds("thread-a").runId;
    const request = client.request("GET", "/threads/thread-a/messages?search=PRIVATE_QUERY");
    toolLog.write({ component: "router", kind: "perf", name: "turn.end", ids: { threadId: "thread-a", messageId: "a" } });
    toolLog.write({ component: "router", kind: "event", name: "turn.start", ids: { threadId: "thread-a", messageId: "b" } });
    const response = { ok: true, messages: ["PRIVATE_MESSAGE_BODY"] };
    resolveFetch(Response.json(response));
    await expect(request).resolves.toEqual(response);
    toolLog.flush(); await toolLog.settled();
    const records = rows(new Date().toISOString().slice(0, 10));
    const call = records.find(row => row.name === "turn.robob_call")!;
    expect(call.ids?.runId).toBe(first);
    expect(call.props?.route).toBe("/threads/:id/messages");
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
    expect(JSON.stringify(records)).not.toContain("FIXTURE_TOKEN");
  } finally {
    fetch.mockRestore(); clock.mockRestore();
    toolLog.write({ component: "process", kind: "event", name: "bridge.stop" });
    toolLog.flush(); await toolLog.settled();
    if (previous === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = previous;
  }
});
