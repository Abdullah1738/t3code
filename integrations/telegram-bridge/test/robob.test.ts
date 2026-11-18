import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { useToolLogFixture } from "./toollog-fixture.ts";
import { Attention } from "../src/attention.ts";
import { createApi } from "../src/api.ts";
import { backendKind } from "../src/config.ts";
import { ControlError, type ControlEventFrame, type PendingRequest, type ThreadState, type ThreadSummary } from "../src/control.ts";
import { ActiveThreadsBoard, boardEntry, RobobAlertBackend, runOrdinal, type RobobAlertOptions } from "../src/robob.ts";
import { Store } from "../src/store.ts";

type Thread = {
  threadId: string; projectId: string; title: string; origin: string | null; runtimeMode: string; worktreePath: string | null;
  parentThreadId: string | null; relationshipToParent?: string | null; activeRunId?: string | null; state: string; latestRunId: string | null; settled?: boolean; archived?: boolean; pending: PendingRequest[];
};
type Call = { method: string; path: string; body?: any };

const now = Date.parse("2026-10-03T12:00:00Z");
const servers: ReturnType<typeof Bun.serve>[] = [];
const stores: Store[] = [];
const attentions: Attention[] = [];
afterEach(async () => {
  for (const alerts of attentions.splice(0)) alerts.stop();
  setSystemTime();
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  for (const store of stores.splice(0)) store.db.close();
});

function fakeControl(events: string[] = [], options: Pick<RobobAlertOptions, "now" | "log" | "board"> = {}) {
  const threads = new Map<string, Thread>();
  const calls: Call[] = [];
  const summary = (thread: Thread) => ({
    ...thread, status: thread.state === "running" ? "running" : "completed", nativeSessionId: null, rootThreadId: thread.parentThreadId ?? thread.threadId,
    pendingRequest: thread.pending[0] ? { requestId: thread.pending[0].requestId, kind: thread.pending[0].kind, requestKind: thread.pending[0].requestKind } : null,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  });
  const ok = (body: object) => Response.json({ ok: true, ...body });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    const path = pathname.replace("/api/ardud/control", "");
    const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
    calls.push({ method: request.method, path: path + (searchParams.size ? `?${searchParams}` : ""), body });
    if (request.headers.get("authorization") !== "Bearer test-token") return Response.json({ ok: false }, { status: 401 });
    // Retired routes fall through to the web app, as the real server does.
    if (!pathname.startsWith("/api/ardud/control")) return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    if (path === "/health") return ok({ status: "healthy" });
    if (path === "/projects") return ok({ projects: [{ projectId: "p1", title: "repo", workspaceRoot: "/repo" }] });
    if (path === "/events") {
      return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/requests") {
      return ok({ requests: [...threads.values()].flatMap(thread => thread.pending.map(request => ({ ...request, threadId: thread.threadId, origin: thread.origin }))) });
    }
    if (path === "/threads") {
      let list = [...threads.values()];
      if (searchParams.get("active") === "true") list = list.filter(thread => thread.state !== "idle");
      if (searchParams.get("includeSubagents") !== "true") list = list.filter(thread => thread.relationshipToParent !== "subagent");
      return ok({ total: list.length, threads: list.map(summary) });
    }
    const thread = threads.get(parts[1] ?? "");
    if (!thread) return Response.json({ ok: false, error: { code: "not_found" } }, { status: 404 });
    if (parts.length === 2) return ok({ thread: { ...summary(thread), run: null, recentRuns: [], pendingRequests: thread.pending } });
    if (parts[2] === "requests") {
      thread.pending = thread.pending.filter(request => request.requestId !== parts[3]);
      return ok({});
    }
    return Response.json({ ok: false }, { status: 404 });
  } });
  servers.push(server);
  const add = (thread: Partial<Thread> & { threadId: string }) => threads.set(thread.threadId, {
    projectId: "p1", title: thread.threadId, origin: null, runtimeMode: "approval-required", worktreePath: null, parentThreadId: null, relationshipToParent: null,
    state: "idle", latestRunId: null, pending: [], ...thread,
  });
  const backend = new RobobAlertBackend({ url: server.url.origin, token: "test-token", ...options });
  return { threads, calls, add, backend };
}

function attention(backend: RobobAlertBackend) {
  const store = new Store(":memory:");
  stores.push(store);
  const transport = { async editMessageText() {}, async answerCallback() {} };
  const alerts = new Attention(store, backend, transport, { chatId: () => 100, spectrumSocket: "/nonexistent/router.sock" });
  attentions.push(alerts);
  return { store, attention: alerts };
}

function cachedBoard() {
  let at = 0;
  let calls = 0;
  const thread: ThreadSummary = {
    threadId: "t", projectId: "p", title: "Private title", state: "running", status: "running", origin: null,
    nativeSessionId: null, runtimeMode: "approval-required", parentThreadId: null, rootThreadId: "t", worktreePath: "/repo",
    latestRunId: null, pendingRequest: null, createdAt: null, updatedAt: null,
  };
  const state = { threads: [thread], read: async () => ({ total: state.threads.length, threads: state.threads }),
    readThread: async (): Promise<{ thread: ThreadSummary }> => ({ thread }) };
  const threadReads: number[] = [];
  const warnings: string[] = [];
  const client = { listThreads: async (filters: unknown) => {
    expect(filters).toEqual({ active: true, limit: 500 });
    calls++;
    return state.read();
  }, thread: async () => { threadReads.push(at); return state.readThread(); } };
  const board = new ActiveThreadsBoard(client, { of: async () => "/repo" }, { now: () => at, log: event => warnings.push(event) });
  return { board, state, thread, warnings, threadReads, calls: () => calls, time: (value: number) => { at = value; } };
}

test("board reads are cached until 30 seconds old, with safe telemetry only", async () => {
  const h = cachedBoard();
  const counters = { fetchesByReason: { cold: 0, age: 0, hard: 0, soft: 0 }, dirtyEventsByType: {}, windowStartedAt: new Date(0).toISOString(),
    threadReads: 0, threadReadErrors: 0, threadReadsByReason: { run: 0, state: 0, followup: 0, created: 0 },
    streamConnects: 0, streamEndsByKind: { errorFrame: 0, clean: 0, thrown: 0, aborted: 0 },
    streamLastConnectedMs: null, streamMinConnectedMs: null, streamMaxConnectedMs: null,
    streamErrorCodes: {}, lastStreamEndAt: null, lastStreamEndKind: null };
  expect(h.board.status()).toEqual({ boardFetches: 0, boardCacheHits: 0, boardFetchErrors: 0, boardBackoffMs: 0, lastFetchDurationMs: null, lastFetchReason: null, ...counters });
  const first = await h.board.snapshot();
  for (const at of [1, 3_000, 10_000, 29_999]) {
    h.time(at);
    expect(await h.board.snapshot()).toBe(first);
  }
  expect(h.calls()).toBe(1);
  expect(h.board.status()).toEqual({ boardFetches: 1, boardCacheHits: 4, boardFetchErrors: 0, boardBackoffMs: 0, lastFetchDurationMs: 0, lastFetchReason: "cold",
    ...counters, fetchesByReason: { cold: 1, age: 0, hard: 0, soft: 0 } });
  h.time(30_000);
  expect(await h.board.snapshot()).not.toBe(first);
  expect(h.calls()).toBe(2);
  expect(h.board.status().lastFetchReason).toBe("age");
  expect(JSON.stringify(h.board.status())).not.toContain("Private title");
});

test("fetch counters split cold, age, hard and soft without changing the legacy reason", async () => {
  const h = cachedBoard();
  await h.board.snapshot();
  h.time(30_000);
  await h.board.snapshot();
  h.time(33_000);
  h.board.markDirty("hard", "request.opened");
  h.board.markDirty("soft", "thread.updated:thread.metadata-updated");
  await h.board.snapshot();
  h.time(48_000);
  h.board.markDirty("soft", "thread.updated:thread.metadata-updated");
  await h.board.snapshot();
  expect(h.board.status()).toMatchObject({ boardFetches: 4, lastFetchReason: "dirty",
    fetchesByReason: { cold: 1, age: 1, hard: 1, soft: 1 }, dirtyEventsByType: {
      "request.opened": { hard: 1, soft: 0 }, "thread.updated:thread.metadata-updated": { hard: 0, soft: 2 },
    } });
  const detached = h.board.status();
  detached.fetchesByReason.cold = 100;
  detached.dirtyEventsByType["request.opened"]!.hard = 100;
  expect(h.board.status().fetchesByReason.cold).toBe(1);
  expect(h.board.status().dirtyEventsByType["request.opened"]!.hard).toBe(1);
});

test("event counters cap at fifty names plus other and health contains no payload identities", async () => {
  const control = fakeControl([], { now: () => now });
  const threadId = "thread:PRIVATE_ID";
  const title = "PRIVATE_TITLE";
  control.add({ threadId, title, state: "running" });
  await control.backend.sessionBoard();
  await control.backend.notification({ type: "ready", threadId, title });
  await control.backend.notification({ type: "__proto__", threadId });
  for (let index = 0; index < 60; index++) {
    await control.backend.notification({ type: `future.event-${index}`, threadId, title, text: "PRIVATE_TEXT", token: "PRIVATE_TOKEN" });
  }
  await control.backend.notification({ type: "ready" });
  await control.backend.notification({ type: "thread.updated", change: title, threadId });
  await control.backend.notification({ type: "request.opened", threadId, requestId: "PRIVATE_REQUEST_ID", kind: "approval" });
  const store = new Store(":memory:");
  stores.push(store);
  const api = createApi({ store, enabled: () => true, chatId: () => 100, timezone: "UTC", health: () => ({ board: control.backend.boardStatus() }) });
  const response = await api(new Request("http://bridge/health"));
  const health = await response.json();
  expect(Object.keys(health.board.dirtyEventsByType)).toHaveLength(51);
  expect(health.board.dirtyEventsByType).toMatchObject({ ready: { hard: 2, soft: 0 }, other: { hard: 1, soft: 13 } });
  expect(health.board.windowStartedAt).toBe(new Date(now).toISOString());
  expect(JSON.stringify(health)).not.toContain("PRIVATE_");
  expect(health.board).toEqual(control.backend.boardStatus());
});

test("dirty board bursts respect the 3 second gap and remain dirty until fetched", async () => {
  const h = cachedBoard();
  const first = await h.board.snapshot();
  for (let index = 0; index < 20; index++) {
    h.time(index * 100);
    h.board.markDirty();
    expect(await h.board.snapshot()).toBe(first);
  }
  expect(h.calls()).toBe(1);
  h.time(3_000);
  await h.board.snapshot();
  expect(h.calls()).toBe(2);
  expect(h.board.status().lastFetchReason).toBe("dirty");
  await h.board.snapshot();
  expect(h.calls()).toBe(2);
});

test("concurrent board readers share the same fetch, including events during the fetch", async () => {
  const h = cachedBoard();
  let resolve!: (value: { total: number; threads: ThreadSummary[] }) => void;
  h.state.read = () => new Promise(done => { resolve = done; });
  const first = h.board.snapshot();
  const second = h.board.snapshot();
  expect(first).toBe(second);
  h.board.markDirty();
  h.time(75);
  resolve({ total: 1, threads: [h.thread] });
  expect((await Promise.all([first, second]))[0]).toBe(await second);
  expect(h.calls()).toBe(1);
  expect(h.board.status().lastFetchDurationMs).toBe(75);
  h.state.read = async () => ({ total: 0, threads: [] });
  h.time(3_075);
  expect((await h.board.snapshot()).entries).toEqual([]);
  expect(h.calls()).toBe(2);
  expect(h.board.status().lastFetchReason).toBe("dirty");
});

test("a failed refresh serves the retained cache during backoff and then retries dirty", async () => {
  const h = cachedBoard();
  const first = await h.board.snapshot();
  h.time(30_000);
  h.state.read = async () => { h.time(30_025); throw new Error("private failure"); };
  await expect(h.board.snapshot()).rejects.toThrow("private failure");
  expect(h.board.status()).toMatchObject({ boardFetches: 2, boardFetchErrors: 1, boardBackoffMs: 5_000, lastFetchDurationMs: 25, lastFetchReason: "age" });
  expect(h.board.status().fetchesByReason).toEqual({ cold: 1, age: 1, hard: 0, soft: 0 });
  expect(await h.board.snapshot()).toBe(first);
  h.time(35_024);
  expect(await h.board.snapshot()).toBe(first);
  expect(h.calls()).toBe(2);
  let resolve!: (value: { total: number; threads: ThreadSummary[] }) => void;
  h.state.read = () => new Promise(done => { resolve = done; });
  h.time(35_025);
  const retry = h.board.snapshot();
  expect(h.calls()).toBe(3);
  resolve({ total: 1, threads: [h.thread] });
  expect((await retry).entries).toEqual(first.entries);
  expect(h.board.status().lastFetchReason).toBe("dirty");
  expect(h.board.status().boardBackoffMs).toBe(0);
  expect(h.board.status().fetchesByReason).toEqual({ cold: 1, age: 1, hard: 0, soft: 1 });
});

test("a cold failure does not strand the single-flight promise", async () => {
  const h = cachedBoard();
  h.state.read = async () => { throw new Error("unavailable"); };
  await expect(h.board.snapshot()).rejects.toThrow();
  await expect(h.board.snapshot()).rejects.toThrow();
  expect(h.calls()).toBe(1);
  h.state.read = async () => ({ total: 1, threads: [h.thread] });
  h.time(5_000);
  expect((await h.board.snapshot()).entries).toHaveLength(1);
  expect(h.calls()).toBe(2);
});

test("consecutive failures back off 5, 10, 20, 40, 60 seconds and reset after success", async () => {
  const h = cachedBoard();
  const attempts: number[] = [];
  let at = 0;
  h.state.read = async () => { attempts.push(at); throw new Error("unavailable"); };
  for (const [start, delay] of [[0, 5_000], [5_000, 10_000], [15_000, 20_000], [35_000, 40_000], [75_000, 60_000], [135_000, 60_000]]) {
    at = start!;
    h.time(at);
    await expect(h.board.snapshot()).rejects.toThrow();
    expect(h.board.status().boardBackoffMs).toBe(delay!);
    at += delay! - 1;
    h.time(at);
    h.board.markDirty();
    await expect(h.board.snapshot()).rejects.toThrow();
    expect(h.calls()).toBe(attempts.length);
  }
  expect(attempts).toEqual([0, 5_000, 15_000, 35_000, 75_000, 135_000]);
  h.time(195_000);
  h.state.read = async () => ({ total: 1, threads: [h.thread] });
  await h.board.snapshot();
  expect(h.board.status().boardBackoffMs).toBe(0);
  h.time(198_000);
  h.board.markDirty();
  h.state.read = async () => { throw new Error("unavailable"); };
  await expect(h.board.snapshot()).rejects.toThrow();
  expect(h.board.status().boardBackoffMs).toBe(5_000);
});

test("soft metadata churn waits fifteen seconds, and hard events override the soft wait", async () => {
  const h = cachedBoard();
  const first = await h.board.snapshot();
  for (const at of [1_000, 3_000, 14_999]) {
    h.time(at);
    h.board.markDirty("soft");
    expect(await h.board.snapshot()).toBe(first);
  }
  h.time(15_000);
  await h.board.snapshot();
  expect(h.calls()).toBe(2);
  h.time(18_000);
  h.board.markDirty("soft");
  await h.board.snapshot();
  expect(h.calls()).toBe(2);
  h.board.markDirty("hard");
  h.board.markDirty("soft");
  await h.board.snapshot();
  expect(h.calls()).toBe(3);
});

test.each([false, true])("steady idle/metadata-churn fetch count, churn=%j", async churn => {
  const h = cachedBoard();
  for (let at = 0; at < 180_000; at += 250) {
    h.time(at);
    if (churn) h.board.markDirty("soft");
    await h.board.snapshot();
  }
  expect(h.calls()).toBe(churn ? 12 : 6);
});

test.each([[30_000, 12], [20_000, 12]])("mixed unknown events each second and busy/idle flips every %i ms produce %i fetches in three minutes", async (flipGap, expected) => {
  const h = cachedBoard();
  const control = fakeControl([], { board: h.board });
  control.add({ threadId: "t", state: "running" });
  for (let at = 0; at < 180_000; at += 250) {
    h.time(at);
    if (at % 1_000 === 0) await control.backend.notification({ type: "future.event", threadId: "t" });
    if (at > 0 && at % flipGap! === 0) {
      await control.backend.notification({ type: "thread.status", threadId: "t", state: at % (flipGap! * 2) === 0 ? "running" : "idle" });
    }
    await control.backend.sessionBoard();
  }
  expect(h.calls()).toBe(expected!);
  if (flipGap === 30_000) expect(h.calls() / 3).toBeLessThanOrEqual(4);
});

test.each<{ initial: ThreadState; state: ThreadState; kind: string }>([
  { initial: "running", state: "running", kind: "same" },
  { initial: "running", state: "waiting", kind: "move" },
  { initial: "running", state: "queued", kind: "move" },
  { initial: "queued", state: "needs-input", kind: "move" },
  { initial: "waiting", state: "running", kind: "move" },
  { initial: "running", state: "idle", kind: "leave" },
  { initial: "idle", state: "running", kind: "join" },
  { initial: "idle", state: "idle", kind: "offboard" },
])("status cache matrix: $initial -> $state ($kind)", async ({ initial, state, kind }) => {
  const h = cachedBoard();
  h.thread.state = initial;
  if (initial === "idle") h.state.threads = [];
  const first = await h.board.snapshot();
  h.time(1_000);
  h.thread.state = state;
  h.board.applyStatus("t", state);
  expect(await h.board.snapshot()).toBe(first);
  const present = initial !== "idle" && state !== "idle";
  expect(first.entries).toEqual(present ? [boardEntry({ ...h.thread, state }, "/repo")] : []);
  expect(h.board.status().dirtyEventsByType).toEqual({ [`thread.status:${kind}`]: {
    hard: 0, soft: 0, local: 1,
  } });
  h.state.threads = state === "idle" ? [] : [{ ...h.thread, state }];
  for (const at of [3_000, 14_999]) {
    h.time(at);
    await h.board.snapshot();
    expect(h.calls()).toBe(1);
  }
  for (const at of [15_000, 29_999]) {
    h.time(at);
    await h.board.snapshot();
    expect(h.calls()).toBe(kind === "join" ? 2 : 1);
  }
  h.time(30_000);
  expect((await h.board.snapshot()).entries).toEqual(state === "idle" ? [] : [boardEntry({ ...h.thread, state }, "/repo")]);
  expect(h.calls()).toBe(2);
  expect(h.board.status().fetchesByReason).toEqual({ cold: 1, age: kind === "join" ? 0 : 1, hard: 0, soft: kind === "join" ? 1 : 0 });
});

test("raw queued and needs-input states stay distinct from their running board projection", async () => {
  const h = cachedBoard();
  await h.board.snapshot();
  for (const state of ["queued", "queued", "needs-input", "needs-input", "running", "running"] as const) h.board.applyStatus("t", state);
  expect(h.board.status().dirtyEventsByType).toEqual({
    "thread.status:move": { hard: 0, soft: 0, local: 3 }, "thread.status:same": { hard: 0, soft: 0, local: 3 },
  });
});

test("known iMessage roots are offboard even for non-idle statuses", async () => {
  const h = cachedBoard();
  h.thread.origin = "imessage";
  expect((await h.board.snapshot()).entries).toEqual([]);
  h.board.applyStatus("t", "needs-input");
  for (const at of [3_000, 15_000, 29_999]) {
    h.time(at);
    expect((await h.board.snapshot()).entries).toEqual([]);
    expect(h.calls()).toBe(1);
  }
  expect(h.board.status().dirtyEventsByType).toEqual({ "thread.status:offboard": { hard: 0, soft: 0, local: 1 } });
});

test("cold status is HARD and the first read discovers its folder immediately", async () => {
  const h = cachedBoard();
  h.board.applyStatus("t", "running");
  expect(h.board.status().dirtyEventsByType).toEqual({ "thread.status:join": { hard: 1, soft: 0 } });
  expect((await h.board.snapshot()).entries).toEqual([boardEntry(h.thread, "/repo")]);
  for (const at of [3_000, 15_000, 29_999, 30_000]) {
    h.time(at);
    await h.board.snapshot();
    expect(h.calls()).toBe(at === 30_000 ? 2 : 1);
  }
});

test.each([false, true])("in-flight status survives an old roster; warm=%j", async warm => {
  const h = cachedBoard();
  if (warm) await h.board.snapshot();
  h.time(30_000);
  let resolve!: (value: { total: number; threads: ThreadSummary[] }) => void;
  h.state.read = () => new Promise(done => { resolve = done; });
  const pending = h.board.snapshot();
  h.board.applyStatus("t", "idle");
  resolve({ total: 1, threads: [h.thread] });
  expect((await pending).entries).toEqual([]);
  expect(h.board.status().dirtyEventsByType).toEqual({ [`thread.status:${warm ? "leave" : "offboard"}`]: { hard: 1, soft: 0 } });
  h.state.read = async () => ({ total: 0, threads: [] });
  const calls = h.calls();
  h.time(32_999);
  expect((await h.board.snapshot()).entries).toEqual([]);
  expect(h.calls()).toBe(calls);
  for (const at of [33_000, 45_000, 60_000]) {
    h.time(at);
    expect((await h.board.snapshot()).entries).toEqual([]);
    expect(h.calls()).toBe(calls + 1);
  }
});

test("the latest in-flight status wins for moves and joins", async () => {
  const h = cachedBoard();
  await h.board.snapshot();
  h.time(30_000);
  let resolve!: (value: { total: number; threads: ThreadSummary[] }) => void;
  h.state.read = () => new Promise(done => { resolve = done; });
  const pending = h.board.snapshot();
  h.board.applyStatus("t", "idle");
  h.board.applyStatus("t", "queued");
  h.board.applyStatus("t", "waiting");
  h.board.applyStatus("new", "running");
  h.board.applyStatus("new", "needs-input");
  resolve({ total: 2, threads: [h.thread, { ...h.thread, threadId: "new", state: "waiting" }] });
  expect((await pending).entries.map(entry => [entry.sessionId, entry.state, entry.status])).toEqual([
    ["t", "waiting", "idle"], ["new", "running", "busy"],
  ]);
});

test("unknown in-flight joins retain HARD refresh even when absent from the old roster", async () => {
  const h = cachedBoard();
  await h.board.snapshot();
  h.time(30_000);
  let resolve!: (value: { total: number; threads: ThreadSummary[] }) => void;
  h.state.read = () => new Promise(done => { resolve = done; });
  const pending = h.board.snapshot();
  h.board.applyStatus("new", "queued");
  resolve({ total: 1, threads: [h.thread] });
  expect((await pending).entries.map(entry => entry.sessionId)).toEqual(["t"]);
  h.state.read = async () => ({ total: 2, threads: [h.thread, { ...h.thread, threadId: "new", state: "queued" }] });
  h.time(32_999);
  expect((await h.board.snapshot()).entries).toHaveLength(1);
  h.time(33_000);
  expect((await h.board.snapshot()).entries.map(entry => entry.sessionId)).toEqual(["t", "new"]);
});

test("a status received while resolving folders is replayed before the snapshot is published", async () => {
  const h = cachedBoard();
  let entered!: () => void;
  const loading = new Promise<void>(done => { entered = done; });
  let release!: (value: string) => void;
  const board = new ActiveThreadsBoard({ listThreads: async () => ({ total: 1, threads: [h.thread] }) }, {
    of: () => { entered(); return new Promise(done => { release = done; }); },
  });
  const pending = board.snapshot();
  await loading;
  board.applyStatus("t", "idle");
  release("/repo");
  expect((await pending).entries).toEqual([]);
});

test("status patches remain in the cached roster after an in-flight refresh fails", async () => {
  const h = cachedBoard();
  const cached = await h.board.snapshot();
  h.time(30_000);
  let reject!: (error: Error) => void;
  h.state.read = () => new Promise((_resolve, fail) => { reject = fail; });
  const pending = h.board.snapshot();
  h.board.applyStatus("t", "idle");
  reject(new Error("unavailable"));
  await expect(pending).rejects.toThrow("unavailable");
  expect((await h.board.snapshot()).entries).toEqual([]);
  expect(cached.entries).toEqual([]);
  h.state.read = async () => ({ total: 1, threads: [{ ...h.thread, state: "running" }] });
  h.time(35_000);
  expect((await h.board.snapshot()).entries).toHaveLength(1);
});

const runA = "run:thread:t:ordinal:1";
const runB = "run:thread:t:ordinal:2";

const lineageCases = [
  { label: "root", parentThreadId: null, relationshipToParent: null, listed: true },
  { label: "fork", parentThreadId: "parent", relationshipToParent: "fork", listed: true },
  { label: "legacy parented (missing relationship)", parentThreadId: "parent", relationshipToParent: undefined, listed: true },
  { label: "legacy parented (null relationship)", parentThreadId: "parent", relationshipToParent: null, listed: true },
  { label: "future relationship", parentThreadId: "parent", relationshipToParent: "future", listed: true },
  { label: "subagent", parentThreadId: "parent", relationshipToParent: "subagent", listed: false },
];

test("an unknown subagent is read once, including across age refreshes and repeated run statuses", async () => {
  const h = cachedBoard();
  await h.board.snapshot();
  h.state.readThread = async () => ({ thread: { ...h.thread, threadId: "sub", parentThreadId: "t", relationshipToParent: "subagent" } });
  h.time(1_000);
  h.board.applyStatus("sub", "running");
  await h.board.snapshot();
  for (const at of [2_000, 15_000, 29_999, 30_000, 31_000, 60_000, 61_000]) {
    h.time(at);
    h.board.applyStatus("sub", "running", `run:sub:ordinal:${at}`);
    expect((await h.board.snapshot()).entries.map(entry => entry.sessionId)).toEqual(["t"]);
    expect(h.calls()).toBe(1 + Math.floor(at / 30_000));
    expect(h.threadReads).toEqual([1_000]);
  }
  expect(h.board.status().fetchesByReason.soft).toBe(0);
});

test("remembered subagents evict the oldest identity after two thousand", async () => {
  const h = cachedBoard();
  await h.board.snapshot();
  for (let index = 0; index <= 2_000; index++) {
    const threadId = `sub-${index}`;
    h.state.readThread = async () => ({ thread: { ...h.thread, threadId, relationshipToParent: "subagent" } });
    h.board.applyStatus(threadId, "running");
    await h.board.snapshot();
  }
  h.time(4_000);
  h.board.applyStatus("sub-1", "running");
  await h.board.snapshot();
  expect(h.threadReads).toHaveLength(2_001);
  h.state.readThread = async () => ({ thread: { ...h.thread, threadId: "sub-0", relationshipToParent: "subagent" } });
  h.board.applyStatus("sub-0", "running");
  await h.board.snapshot();
  expect(h.threadReads).toHaveLength(2_002);
  expect(h.calls()).toBe(1);
});

test("a burst during the first subagent read learns permanent lineage without a followup", async () => {
  const h = cachedBoard();
  await h.board.snapshot();
  let done!: (value: { thread: ThreadSummary }) => void;
  h.state.readThread = () => new Promise(resolve => { done = resolve; });
  for (let index = 0; index < 10; index++) h.board.applyStatus("sub", "running");
  done({ thread: { ...h.thread, threadId: "sub", relationshipToParent: "subagent" } });
  await h.board.snapshot();
  h.time(4_000);
  h.board.applyStatus("sub", "running", runB);
  await h.board.snapshot();
  expect(h.threadReads).toHaveLength(1);
  expect(h.calls()).toBe(1);
});

test("an unknown join read failure still rediscovers through SOFT within fifteen seconds", async () => {
  const h = cachedBoard();
  await h.board.snapshot();
  h.state.readThread = async () => { throw new Error("unavailable"); };
  h.state.threads.push({ ...h.thread, threadId: "new" });
  h.time(1_000);
  h.board.applyStatus("new", "running");
  await h.board.snapshot();
  h.time(3_000);
  expect((await h.board.snapshot()).entries).toHaveLength(1);
  h.time(15_000);
  expect((await h.board.snapshot()).entries).toHaveLength(2);
  expect(h.board.status()).toMatchObject({ threadReadErrors: 1, fetchesByReason: { soft: 1, hard: 0 } });
});

test.each(lineageCases)("an unknown $label join reads canonically and rediscovers only listed shapes within 15 s", async lineage => {
  let at = 0;
  const control = fakeControl([], { now: () => at });
  await control.backend.sessionBoard();
  control.add({ threadId: "new", state: "running", parentThreadId: lineage.parentThreadId, relationshipToParent: lineage.relationshipToParent });
  at = 1_000;
  await control.backend.notification({ type: "thread.status", threadId: "new", state: "running" });
  for (at of [3_000, 14_999]) {
    expect((await control.backend.sessionBoard()).entries).toEqual([]);
    expect(control.backend.boardStatus()?.boardFetches).toBe(1);
  }
  at = 15_000;
  expect((await control.backend.sessionBoard()).entries.map(entry => entry.sessionId)).toEqual(lineage.listed ? ["new"] : []);
  expect(control.backend.boardStatus()).toMatchObject({ boardFetches: lineage.listed ? 2 : 1, threadReads: 1 });
});

test.each([
  ...lineageCases.map(lineage => ({ ...lineage, state: "running", origin: null })),
  { label: "idle root", parentThreadId: null, relationshipToParent: null, listed: false, state: "idle", origin: null },
  { label: "iMessage root", parentThreadId: null, relationshipToParent: null, listed: false, state: "running", origin: "imessage" },
])("thread.created reads a $label and fetches only active listed shapes within 3 s", async shape => {
  let at = 0;
  const control = fakeControl([], { now: () => at });
  await control.backend.sessionBoard();
  control.add({ ...shape, threadId: "new", worktreePath: "/repo/new" });
  at = 1_000;
  // parentThreadId alone cannot distinguish a fork from a subagent.
  expect(await control.backend.notification({ type: "thread.created", threadId: "new", parentThreadId: shape.parentThreadId })).toEqual({ type: "wake" });
  for (at of [2_999, 3_000]) {
    const entries = (await control.backend.sessionBoard()).entries;
    expect(entries.map(entry => [entry.sessionId, entry.directory])).toEqual(shape.listed && at === 3_000 ? [["new", "/repo/new"]] : []);
    expect(control.backend.boardStatus()?.boardFetches).toBe(shape.listed && at === 3_000 ? 2 : 1);
  }
  expect(control.backend.boardStatus()?.threadReadsByReason.created).toBe(1);
  if (shape.state === "idle") {
    control.threads.get("new")!.state = "running";
    at = 5_000;
    await control.backend.notification({ type: "thread.status", threadId: "new", state: "running" });
    await control.backend.sessionBoard();
    at = 15_000;
    expect((await control.backend.sessionBoard()).entries[0]?.sessionId).toBe("new");
  }
});

test("a failed created read retains HARD, and a missing thread reader retains the same fallback", async () => {
  const h = cachedBoard();
  await h.board.snapshot();
  h.time(1_000);
  h.state.readThread = async () => { throw new Error("unavailable"); };
  h.board.created("new");
  await h.board.snapshot();
  expect(h.calls()).toBe(1);
  h.time(3_000);
  await h.board.snapshot();
  expect(h.board.status()).toMatchObject({ threadReadErrors: 1, fetchesByReason: { hard: 1 } });

  let calls = 0;
  let at = 0;
  const board = new ActiveThreadsBoard({ listThreads: async () => { calls++; return { total: 0, threads: [] }; } }, { of: async () => "/repo" }, { now: () => at });
  await board.snapshot();
  at = 3_000;
  board.created("new");
  await board.snapshot();
  expect(calls).toBe(2);
  expect(board.status().threadReads).toBe(0);
  expect(board.status().dirtyEventsByType["thread.created"]).toEqual({ hard: 1, soft: 0 });
});

test.each(["pending", "cooldown"])("created retains HARD when coalesced with a %s status read", async phase => {
  const h = cachedBoard();
  await h.board.snapshot();
  const thread = { ...h.thread, threadId: "new" };
  h.state.threads.push(thread);
  h.time(1_000);
  let done!: (value: { thread: ThreadSummary }) => void;
  h.state.readThread = () => new Promise(resolve => { done = resolve; });
  h.board.applyStatus("new", "running");
  if (phase === "pending") h.board.created("new");
  done({ thread });
  await h.board.snapshot();
  if (phase === "cooldown") h.board.created("new");
  h.state.readThread = async () => ({ thread });
  h.time(phase === "pending" ? 3_000 : 4_000);
  expect((await h.board.snapshot()).entries.map(entry => entry.sessionId)).toEqual(["t", "new"]);
  expect(h.board.status().fetchesByReason.hard).toBe(1);
  expect(h.threadReads).toHaveLength(phase === "pending" ? 1 : 2);
});

test("an unknown join without a thread reader still uses SOFT rediscovery", async () => {
  let at = 0;
  const h = cachedBoard();
  const state = { threads: [] as ThreadSummary[] };
  const board = new ActiveThreadsBoard({ listThreads: async () => ({ total: state.threads.length, threads: state.threads }) }, { of: async () => "/repo" }, { now: () => at });
  await board.snapshot();
  state.threads.push(h.thread);
  board.applyStatus("t", "running");
  at = 3_000;
  expect((await board.snapshot()).entries).toEqual([]);
  at = 15_000;
  expect((await board.snapshot()).entries[0]?.sessionId).toBe("t");
});

const completionBoundaryCases = ["root", "fork"].flatMap(lineage =>
  ["idle", "running", "error"].flatMap(outcome =>
    ["state", "run", "created"].map(event => ({ lineage, outcome, event }))));

test.each(completionBoundaryCases)("a $event at the $outcome read cleanup boundary rediscovers a $lineage", async ({ lineage, outcome, event }) => {
  let at = 0;
  let lists = 0;
  let reads = 0;
  let rows: ThreadSummary[] = [];
  const thread: ThreadSummary = { ...cachedBoard().thread, threadId: "new", state: "running",
    parentThreadId: lineage === "fork" ? "parent" : null, relationshipToParent: lineage === "fork" ? "fork" : null };
  const firstRead = Promise.withResolvers<{ thread: ThreadSummary }>();
  const board = new ActiveThreadsBoard({
    listThreads: async () => { lists++; return { total: rows.length, threads: rows }; },
    thread: () => ++reads === 1 ? firstRead.promise : Promise.resolve({ thread }),
  }, { of: async () => "/repo/new" }, { now: () => at });
  await board.snapshot();
  at = 1_000;
  board.applyStatus("new", "running");
  if (outcome === "error") {
    firstRead.reject(new Error("unavailable"));
    await firstRead.promise.catch(() => {});
  } else {
    firstRead.resolve({ thread: { ...thread, state: outcome as "idle" | "running" } });
    // The board awaited this promise first, so its result is now applied;
    // its catch/finally chain has not yet removed the coalescing task.
    await firstRead.promise;
  }
  at = 1_100;
  rows = [thread];
  if (event === "created") board.created("new");
  else board.applyStatus("new", "running", event === "run" ? runB : undefined);
  expect((await board.snapshot()).entries).toEqual([]);
  at = 3_999;
  expect((await board.snapshot()).entries).toEqual([]);
  expect(reads).toBe(1);
  at = 4_000;
  const afterCooldown = await board.snapshot();
  expect(reads).toBe(2);
  expect(afterCooldown.entries.map(entry => entry.sessionId)).toEqual(event === "created" ? ["new"] : []);
  at = 15_000;
  expect((await board.snapshot()).entries.map(entry => [entry.sessionId, entry.directory])).toEqual([["new", "/repo/new"]]);
  expect(lists).toBe(2);
  expect(board.status().fetchesByReason).toMatchObject({ hard: event === "created" ? 1 : 0, soft: event === "created" ? 0 : 1 });
});

test.each(lineageCases)("board roster and reconciliation follow the server lineage predicate: $label", async lineage => {
  let at = 0;
  const control = fakeControl([], { now: () => at });
  control.add({ threadId: "t", state: "running", activeRunId: runA, latestRunId: runA,
    parentThreadId: lineage.parentThreadId, relationshipToParent: lineage.relationshipToParent });
  const first = await control.backend.sessionBoard();
  expect(first.entries.map(entry => entry.sessionId)).toEqual(lineage.listed ? ["t"] : []);
  control.threads.get("t")!.state = "waiting";
  await control.backend.notification({ type: "thread.status", threadId: "t", runId: runA, state: "waiting" });
  const next = await control.backend.sessionBoard();
  expect(next.entries.map(entry => [entry.sessionId, entry.state, entry.status])).toEqual(lineage.listed ? [["t", "waiting", "idle"]] : []);
  expect(control.backend.boardStatus()?.boardFetches).toBe(1);
  if (lineage.listed) {
    expect(control.backend.boardStatus()?.threadReads).toBe(1);
    at = 15_000;
    expect((await control.backend.sessionBoard()).entries).toHaveLength(1);
    expect(control.backend.boardStatus()?.boardFetches).toBe(1);
  }
});

test.each(lineageCases.filter(lineage => lineage.listed))("a deferred canonical $label missing from the cache schedules SOFT rediscovery", async lineage => {
  const h = cachedBoard();
  Object.assign(h.thread, { activeRunId: runA, latestRunId: runA,
    parentThreadId: lineage.parentThreadId, relationshipToParent: lineage.relationshipToParent });
  await h.board.snapshot();
  h.time(1_000);
  h.board.applyStatus("t", "waiting", runB);
  await h.board.snapshot();
  h.time(1_500);
  h.board.applyStatus("t", "waiting", runB);
  // A local leave can precede the already-scheduled canonical reconciliation.
  h.board.applyStatus("t", "idle");
  const canonical = { ...h.thread, state: "waiting" as const };
  h.state.readThread = async () => ({ thread: canonical });
  h.state.threads = [canonical];
  h.time(4_000);
  expect((await h.board.snapshot()).entries).toEqual([]);
  expect(h.board.status().threadReads).toBe(2);
  for (const at of [7_000, 14_999]) {
    h.time(at);
    expect((await h.board.snapshot()).entries).toEqual([]);
    expect(h.calls()).toBe(1);
  }
  h.time(15_000);
  expect((await h.board.snapshot()).entries).toEqual([boardEntry(canonical, "/repo")]);
  expect(h.board.status().fetchesByReason).toEqual({ cold: 1, age: 0, hard: 0, soft: 1 });
});

test.each([
  ["completed", "idle"], ["failed", "idle"], ["cancelled", "idle"], ["interrupted", "idle"], ["rolled_back", "idle"],
  ["waiting", "waiting"], ["queued", "queued"], ["preparing", "running"], ["running", "running"],
] as const)("foreign run %s cannot replace active run A with %s", async (_status, state) => {
  const h = cachedBoard();
  Object.assign(h.thread, { activeRunId: runA, latestRunId: runA });
  await h.board.snapshot();
  const canonical = { ...h.thread, latestRunId: runB };
  h.state.readThread = async () => ({ thread: canonical });
  h.board.applyStatus("t", state, runB);
  expect((await h.board.snapshot()).entries).toEqual([boardEntry(canonical, "/repo")]);
  expect(h.calls()).toBe(1);
  expect(h.board.status()).toMatchObject({ threadReads: 1, threadReadErrors: 0, threadReadsByReason: { run: 1, state: 0, followup: 0 } });
});

test.each<ThreadState>(["running", "waiting", "queued", "needs-input", "idle"])("a finishing active run uses canonical thread state %s", async state => {
  const h = cachedBoard();
  Object.assign(h.thread, { activeRunId: runA, latestRunId: runA });
  await h.board.snapshot();
  const canonical = { ...h.thread, state, latestRunId: runB };
  h.state.readThread = async () => ({ thread: canonical });
  h.board.applyStatus("t", "idle", runA);
  expect((await h.board.snapshot()).entries).toEqual(state === "idle" ? [] : [boardEntry(canonical, "/repo")]);
  expect(h.calls()).toBe(1);
});

test.each(["before", "after"])("canonical run status received %s the old list wins the fetch race", async order => {
  const h = cachedBoard();
  Object.assign(h.thread, { activeRunId: runA, latestRunId: runA });
  await h.board.snapshot();
  h.time(30_000);
  let list!: (value: { total: number; threads: ThreadSummary[] }) => void;
  let read!: (value: { thread: ThreadSummary }) => void;
  h.state.read = () => new Promise(done => { list = done; });
  h.state.readThread = () => new Promise(done => { read = done; });
  const pending = h.board.snapshot();
  h.board.applyStatus("t", "idle", runB);
  const canonical = { ...h.thread, latestRunId: runB };
  if (order === "before") read({ thread: canonical });
  list({ total: 1, threads: [{ ...h.thread }] });
  if (order === "after") read({ thread: canonical });
  expect((await pending).entries).toEqual([boardEntry(canonical, "/repo")]);
});

test("run reconciliation coalesces bursts and waits three seconds before a followup read", async () => {
  const h = cachedBoard();
  Object.assign(h.thread, { activeRunId: runA, latestRunId: runA });
  await h.board.snapshot();
  h.time(1_000);
  let read!: (value: { thread: ThreadSummary }) => void;
  h.state.readThread = () => new Promise(done => { read = done; });
  for (let index = 0; index < 20; index++) h.board.applyStatus("t", "idle", runB);
  expect(h.threadReads).toEqual([1_000]);
  // A newer report invalidates this old read rather than allowing a stale leave.
  h.board.applyStatus("t", "running", runA);
  read({ thread: { ...h.thread, state: "idle" } });
  expect((await h.board.snapshot()).entries).toHaveLength(1);
  h.state.readThread = async () => ({ thread: { ...h.thread, latestRunId: runB } });
  for (const at of [2_000, 3_999]) {
    h.time(at);
    h.board.applyStatus("t", "idle", runB);
    expect((await h.board.snapshot()).entries).toHaveLength(1);
    expect(h.threadReads).toEqual([1_000]);
  }
  h.time(4_000);
  expect((await h.board.snapshot()).entries[0]?.workRevision).toBe(2);
  expect(h.threadReads).toEqual([1_000, 4_000]);
  expect(h.board.status().threadReadsByReason).toEqual({ run: 1, state: 0, followup: 1, created: 0 });
});

test("state-only events preserve pending canonical run metadata over an old list", async () => {
  const h = cachedBoard();
  Object.assign(h.thread, { activeRunId: runA, latestRunId: runA });
  const first = await h.board.snapshot();
  h.time(30_000);
  let list!: (value: { total: number; threads: ThreadSummary[] }) => void;
  h.state.read = () => new Promise(done => { list = done; });
  h.state.readThread = async () => ({ thread: { ...h.thread, latestRunId: runB } });
  const control = fakeControl([], { board: h.board });
  control.add({ threadId: "t", state: "running" });
  const pending = h.board.snapshot();
  // The directory read is an observable network milestone after reconciliation.
  await control.backend.notification({ type: "thread.status", threadId: "t", runId: runB, state: "idle" });
  expect(first.entries[0]?.workRevision).toBe(2);
  await control.backend.notification({ type: "thread.status", threadId: "t", runId: runA, state: "running" });
  expect(h.board.status().threadReads).toBe(1);
  list({ total: 1, threads: [{ ...h.thread }] });
  expect((await pending).entries[0]?.workRevision).toBe(2);
});

test("expiry preserves recent cooldowns and deferred followups after two thousand identities", async () => {
  const h = cachedBoard();
  Object.assign(h.thread, { activeRunId: runA, latestRunId: runA });
  await h.board.snapshot();
  h.state.readThread = async () => ({ thread: { ...h.thread, latestRunId: runB } });
  h.board.applyStatus("t", "idle", runB);
  await h.board.snapshot();
  h.thread.latestRunId = runB;
  for (let index = 1; index <= 1_999; index++) {
    h.time(index * 4_000);
    const thread = { ...h.thread, threadId: `old-${index}`, latestRunId: runA };
    h.state.threads = [h.thread, thread];
    h.board.markDirty();
    await h.board.snapshot();
    h.state.readThread = async () => ({ thread: { ...thread, latestRunId: runB } });
    h.board.applyStatus(thread.threadId, "idle", runB);
    await h.board.snapshot();
  }
  const recent = 1_999 * 4_000 + 3_000;
  h.time(recent);
  h.state.readThread = async () => ({ thread: h.thread });
  h.board.applyStatus("t", "idle", runB);
  await h.board.snapshot();
  h.board.applyStatus("t", "idle", runB);
  const before = h.board.status().threadReads;
  h.time(recent + 100);
  const next = { ...h.thread, threadId: "new", latestRunId: runA };
  h.state.threads = [h.thread, next];
  h.board.markDirty();
  await h.board.snapshot();
  h.state.readThread = async () => ({ thread: { ...next, latestRunId: runB } });
  h.board.applyStatus("new", "idle", runB);
  await h.board.snapshot();
  h.board.applyStatus("t", "idle", runB);
  await h.board.snapshot();
  expect(h.board.status().threadReads).toBe(before + 1);
  h.time(recent + 3_000);
  h.state.readThread = async () => ({ thread: h.thread });
  await h.board.snapshot();
  expect(h.board.status().threadReads).toBe(before + 2);
  expect(h.threadReads.slice(-3)).toEqual([recent, recent + 100, recent + 3_000]);
});

test("failed canonical reads fall back to SOFT and preserve the cached row", async () => {
  const h = cachedBoard();
  Object.assign(h.thread, { activeRunId: runA, latestRunId: runA });
  await h.board.snapshot();
  h.time(1_000);
  h.state.readThread = async () => { throw new Error("unavailable"); };
  h.board.applyStatus("t", "idle", runB);
  for (const at of [3_000, 14_999]) {
    h.time(at);
    expect((await h.board.snapshot()).entries).toHaveLength(1);
    expect(h.calls()).toBe(1);
  }
  h.time(15_000);
  await h.board.snapshot();
  expect(h.board.status()).toMatchObject({ threadReads: 1, threadReadErrors: 1,
    fetchesByReason: { cold: 1, soft: 1, hard: 0, age: 0 } });
});

test("a slow canonical read does not delay status attention or its five second prompt", async () => {
  setSystemTime(now);
  const h = cachedBoard();
  Object.assign(h.thread, { activeRunId: runA, latestRunId: runA });
  await h.board.snapshot();
  let read!: (value: { thread: ThreadSummary }) => void;
  h.state.readThread = () => new Promise(done => { read = done; });
  const control = fakeControl([], { board: h.board });
  control.add({ threadId: "t", state: "needs-input", pending: [{ requestId: "q-run", kind: "question", requestKind: "user_input",
    canRespond: true, questions: [{ id: "env", header: "Env", question: "Where?", options: [{ label: "dev" }] }] }] });
  await control.backend.directoryOf("t");
  const { store, attention: alerts } = attention(control.backend);
  alerts.processNotification((await control.backend.notification({ type: "thread.status", threadId: "t", runId: runB, state: "running" }))!);
  await alerts.tick();
  expect(store.pendingSessionNotices()).toHaveLength(1);
  setSystemTime(now + 5_000);
  await alerts.tick();
  expect(store.pendingOutbox().map(entry => entry.text)).toEqual([expect.stringContaining("Where?")]);
  read({ thread: { ...h.thread, state: "needs-input", latestRunId: runB } });
  await h.board.snapshot();
});

test.each([false, true])("live-shaped 180 s replay; retain assistant invalidation=%j", async retainAssistantInvalidation => {
  let at = 0;
  const control = fakeControl([], { now: () => at });
  for (let index = 0; index < 10; index++) control.add({ threadId: `private-${index}`, title: "PRIVATE_TITLE", state: "running",
    activeRunId: `run:thread:private-${index}:ordinal:1`, latestRunId: `run:thread:private-${index}:ordinal:1` });
  let statuses = 0;
  let messages = 0;
  let created = 0;
  for (at = 0; at < 180_000; at += 250) {
    // 32 status reports/minute, 62 completions/minute, 2.5 creations/minute.
    if (at >= (statuses + 1) * 60_000 / 32) {
      const thread = control.threads.get(`private-${statuses % 10}`)!;
      if (statuses % 3 === 0) thread.state = thread.state === "running" ? "waiting" : "running";
      await control.backend.notification({ type: "thread.status", threadId: thread.threadId, state: thread.state, runId: thread.activeRunId });
      statuses++;
    }
    if (at >= (messages + 1) * 60_000 / 62) {
      if (retainAssistantInvalidation) control.backend.markDirty("soft");
      await control.backend.notification({ type: "message.completed", threadId: "private-0", role: "assistant" });
      messages++;
    }
    if (at > 0 && at % 24_000 === 0) {
      const threadId = `created-${created++}`;
      control.add({ threadId, state: "running" });
      await control.backend.notification({ type: "thread.created", threadId });
    }
    if (at > 0 && at % 60_000 === 0) {
      const thread = control.threads.get("private-9")!;
      thread.state = thread.state === "idle" ? "running" : "idle";
      await control.backend.notification({ type: "thread.status", threadId: thread.threadId, state: thread.state, runId: thread.activeRunId });
    }
    await control.backend.sessionBoard();
  }
  const telemetry = control.backend.boardStatus()!;
  expect([statuses, messages, created]).toEqual([95, 185, 7]);
  if (retainAssistantInvalidation) expect(telemetry.boardFetches / 3).toBe(5);
  else {
    expect(telemetry.boardFetches).toBe(10);
    expect(telemetry.boardFetches / 3).toBeLessThanOrEqual(4);
  }
  expect(telemetry.dirtyEventsByType["message.completed:assistant"]).toEqual({ hard: 0, soft: 0, local: 185 });
  expect(telemetry.boardFetchErrors).toBe(0);
  // Seven active-root creations and two returning roots now read canonically.
  expect(telemetry.threadReads).toBe(41);
  expect(telemetry.threadReads / 3).toBeLessThanOrEqual(14);
  expect(telemetry.threadReadErrors).toBe(0);
  expect(telemetry.dirtyEventsByType["thread.status:same"]!.local).toBeGreaterThan(0);
  expect(telemetry.dirtyEventsByType["thread.status:move"]!.local).toBeGreaterThan(0);
  expect(telemetry.dirtyEventsByType["thread.status:leave"]!.local).toBeGreaterThan(0);
  expect(JSON.stringify(telemetry)).not.toMatch(/private-|PRIVATE_TITLE|created-/);
});

test("subagent-heavy live-shaped 180 s replay stays below four lists and twelve thread reads per minute", async () => {
  let at = 0;
  const control = fakeControl([], { now: () => at });
  for (let index = 0; index < 10; index++) control.add({ threadId: `private-${index}`, title: "PRIVATE_TITLE", state: "running",
    activeRunId: `run:thread:private-${index}:ordinal:1`, latestRunId: `run:thread:private-${index}:ordinal:1` });
  for (let index = 0; index < 6; index++) control.add({ threadId: `sub-${index}`, state: "running", parentThreadId: "private-0", relationshipToParent: "subagent" });
  let statuses = 0;
  let joins = 0;
  let messages = 0;
  let created = 0;
  for (at = 0; at < 180_000; at += 250) {
    // 32 total statuses/minute: 18 listed-thread reports and 14 subagent joins.
    if (at >= (statuses + 1) * 60_000 / 18) {
      const thread = control.threads.get(`private-${statuses % 10}`)!;
      if (statuses % 3 === 0) thread.state = thread.state === "running" ? "waiting" : "running";
      // Both state-only and run-scoped reports occur on the control stream.
      await control.backend.notification({ type: "thread.status", threadId: thread.threadId, state: thread.state,
        ...(statuses % 2 === 0 ? { runId: thread.activeRunId } : {}) });
      statuses++;
    }
    if (at >= (joins + 1) * 60_000 / 14) {
      await control.backend.notification({ type: "thread.status", threadId: `sub-${joins % 6}`, state: "running" });
      joins++;
    }
    if (at >= (messages + 1) * 60_000 / 62) {
      await control.backend.notification({ type: "message.completed", threadId: "private-0", role: "assistant" });
      messages++;
    }
    // User messages and their metadata arrive in turn-sized bursts: 7 and 4/min.
    const minuteOffset = at % 60_000;
    if ([2_000, 3_000, 4_000, 25_000, 26_000, 27_000, 50_000].includes(minuteOffset)) {
      await control.backend.notification({ type: "message.completed", threadId: "private-0", role: "user" });
    }
    if ([3_000, 4_000, 26_000, 27_000].includes(minuteOffset)) {
      await control.backend.notification({ type: "thread.updated", threadId: "private-0", change: "thread.metadata-updated" });
    }
    if (at > 0 && at % 24_000 === 0) {
      const threadId = `created-${created++}`;
      const subagent = created % 4 !== 0;
      control.add({ threadId, state: "running", parentThreadId: subagent ? "private-0" : null, relationshipToParent: subagent ? "subagent" : null });
      await control.backend.notification({ type: "thread.created", threadId, parentThreadId: subagent ? "private-0" : null });
    }
    if (at > 0 && at % 60_000 === 0) {
      const thread = control.threads.get("private-9")!;
      thread.state = thread.state === "idle" ? "running" : "idle";
      await control.backend.notification({ type: "thread.status", threadId: thread.threadId, state: thread.state, runId: thread.activeRunId });
    }
    await control.backend.sessionBoard();
  }
  const telemetry = control.backend.boardStatus()!;
  console.info("subagent-heavy replay", JSON.stringify({ listsPerMinute: telemetry.boardFetches / 3, threadReadsPerMinute: telemetry.threadReads / 3 }));
  expect([statuses, joins, messages, created]).toEqual([53, 41, 185, 7]);
  expect(telemetry.boardFetches / 3).toBeLessThanOrEqual(4);
  expect(telemetry.threadReads / 3).toBeLessThanOrEqual(12);
  expect(telemetry.boardFetchErrors + telemetry.threadReadErrors).toBe(0);
  expect(JSON.stringify(telemetry)).not.toMatch(/private-|PRIVATE_TITLE|created-|sub-/);
});

test("the full 500-row roster is mapped and warns once per ten minutes, before filtering iMessage", async () => {
  const h = cachedBoard();
  h.state.threads = Array.from({ length: 500 }, (_, index) => ({ ...h.thread, threadId: `t-${index}`, origin: index === 499 ? "imessage" : null }));
  const first = await h.board.snapshot();
  expect(first.entries).toHaveLength(499);
  expect(first.entries.at(-1)?.sessionId).toBe("t-498");
  expect(h.warnings).toEqual(["board-roster-at-limit"]);
  for (const at of [30_000, 599_999, 600_000, 602_998]) {
    h.time(at);
    h.board.markDirty();
    await h.board.snapshot();
  }
  expect(h.warnings).toHaveLength(1);
  h.time(602_999);
  await h.board.snapshot();
  expect(h.warnings).toEqual(["board-roster-at-limit", "board-roster-at-limit"]);
});

test("plain message wakes wait for the soft gap while cached status moves need no fetch", async () => {
  let at = now;
  const control = fakeControl([], { now: () => at });
  control.add({ threadId: "t", state: "running" });
  await control.backend.sessionBoard();
  const { attention: alerts } = attention(control.backend);
  const reads = () => control.calls.filter(call => call.path.startsWith("/threads?")).length;
  at += 4_000;
  for (let index = 0; index < 20; index++) {
    alerts.processNotification({ type: "wake" });
    alerts.processNotification((await control.backend.notification({ type: "message.completed", threadId: "t", role: "user" }))!);
    await alerts.tick();
  }
  expect(reads()).toBe(1);
  for (let index = 0; index < 20; index++) {
    at += 100;
    await control.backend.notification({ type: "thread.status", threadId: "t", state: "queued" });
    await control.backend.sessionBoard();
  }
  expect(reads()).toBe(1);
  at += 3_000;
  await control.backend.sessionBoard();
  expect(reads()).toBe(1);
  at = now + 15_000;
  await control.backend.sessionBoard();
  expect(reads()).toBe(2);
});

test("assistant completions are counted without fetching inside thirty seconds", async () => {
  let at = 0;
  const control = fakeControl([], { now: () => at });
  control.add({ threadId: "private-thread", title: "PRIVATE_TITLE", state: "running" });
  const first = await control.backend.sessionBoard();
  for (const time of [1_000, 3_000, 15_000, 29_999]) {
    at = time;
    expect(await control.backend.notification({ type: "message.completed", threadId: "private-thread", role: "assistant" })).toBeUndefined();
    expect(await control.backend.sessionBoard()).toBe(first);
    expect(control.backend.boardStatus()?.boardFetches).toBe(1);
  }
  const store = new Store(":memory:");
  stores.push(store);
  const api = createApi({ store, enabled: () => true, chatId: () => 100, timezone: "UTC", health: () => ({ board: control.backend.boardStatus() }) });
  const health = await (await api(new Request("http://bridge/health"))).json();
  expect(health.board.dirtyEventsByType).toEqual({ "message.completed:assistant": { hard: 0, soft: 0, local: 4 } });
  expect(JSON.stringify(health)).not.toMatch(/private-thread|PRIVATE_TITLE/);
  at = 30_000;
  expect(await control.backend.sessionBoard()).not.toBe(first);
  expect(control.backend.boardStatus()?.fetchesByReason).toEqual({ cold: 1, age: 1, hard: 0, soft: 0 });
});

type DirtyEvent = [Record<string, unknown>, boolean];
test.each<DirtyEvent>([
  [{ type: "ready" }, true],
  [{ type: "thread.created" }, true],
  ...["request.opened", "request.resolved"].map<DirtyEvent>(type => [{ type, kind: "approval", requestId: "r" }, true]),
  ...["thread.archived", "thread.unarchived", "thread.deleted", "thread.settled", "thread.unsettled",
    "thread.runtime-mode-updated", "run.created", "run.updated", "runtime-request.updated"].map<DirtyEvent>(change => [{ type: "thread.updated", change }, true]),
  ...["thread.model-selection-updated", "thread.interaction-mode-updated", "thread.renamed", "message.updated"].map<DirtyEvent>(change => [{ type: "thread.updated", change }, false]),
  [{ type: "message.completed", role: "user" }, false],
  [{ type: "thread.status", state: "future-state" }, false],
  [{ type: "future.event" }, false],
  [{ type: "constructor" }, false],
])("board dirty classification: %j => %s", async (data, dirty) => {
  let at = now;
  const control = fakeControl([], { now: () => at });
  control.add({ threadId: "t", state: "running" });
  await control.backend.sessionBoard();
  at += 3_000;
  await control.backend.notification({ threadId: "t", ...data });
  const eventKey = data.type === "thread.updated" ? `thread.updated:${data.change}` : String(data.type);
  expect(control.backend.boardStatus()?.dirtyEventsByType).toEqual({ [eventKey]: data.type === "thread.created"
    ? { hard: 0, soft: 0, local: 1 } : { hard: dirty ? 1 : 0, soft: dirty ? 0 : 1 } });
  await control.backend.sessionBoard();
  expect(control.backend.boardStatus()?.boardFetches).toBe(dirty ? 2 : 1);
  at += 11_999;
  await control.backend.sessionBoard();
  expect(control.backend.boardStatus()?.boardFetches).toBe(dirty ? 2 : 1);
  if (!dirty) {
    at++;
    await control.backend.sessionBoard();
    expect(control.backend.boardStatus()?.fetchesByReason).toEqual({ cold: 1, age: 0, hard: 0, soft: 1 });
  } else {
    expect(control.backend.boardStatus()?.fetchesByReason).toEqual({ cold: 1, age: 0, hard: 1, soft: 0 });
  }
});

test.each(["thread.metadata-updated", "thread.provider-switched", "future-change", undefined])("ambiguous updates use the soft gap: %j", async change => {
  let at = now;
  const control = fakeControl([], { now: () => at });
  control.add({ threadId: "t", state: "running" });
  await control.backend.sessionBoard();
  for (let index = 1; index <= 59; index++) {
    at = now + index * 250;
    await control.backend.notification({ type: "thread.updated", threadId: "t", change });
    await control.backend.sessionBoard();
  }
  expect(control.backend.boardStatus()?.boardFetches).toBe(1);
  at = now + 15_000;
  await control.backend.sessionBoard();
  expect(control.backend.boardStatus()?.boardFetches).toBe(2);
});

test("a review board stand-in needs no dirty or telemetry hooks", async () => {
  const h = cachedBoard();
  const control = fakeControl([], { board: { snapshot: () => h.board.snapshot() } });
  await control.backend.notification({ type: "ready" });
  expect((await control.backend.sessionBoard()).entries).toHaveLength(1);
  expect(control.backend.boardStatus()).toBeUndefined();
});

test("backend switch defaults to OpenChamber", () => {
  expect(backendKind({}, {})).toBe("openchamber");
  expect(backendKind({ BRIDGE_BACKEND: "robob" }, {})).toBe("robob");
  expect(() => backendKind({}, { backend: "other" })).toThrow();
});

test("active threads map onto attention's board entries", () => {
  const base = {
    threadId: "t", projectId: "p", title: "T", state: "waiting" as const, status: "completed", origin: null, nativeSessionId: null,
    runtimeMode: "approval-required", parentThreadId: null, rootThreadId: "t", worktreePath: null, latestRunId: "run:thread:t:ordinal:4",
    pendingRequest: null, createdAt: null, updatedAt: "1970-01-01T00:00:00.005Z",
  };
  expect(boardEntry(base, "/repo")).toMatchObject({ sessionId: "t", state: "waiting", status: "idle", workRevision: 4, updatedAt: 5, directory: "/repo" });
  expect(boardEntry({ ...base, state: "running" }, "/repo")).toMatchObject({ state: "running", status: "busy" });
  expect(boardEntry({ ...base, state: "queued" }, "/repo")).toMatchObject({ state: "running", status: "busy" });
  expect(boardEntry({ ...base, state: "needs-input", pendingRequest: { requestId: "r", kind: "approval", requestKind: "command" } }, "/repo"))
    .toMatchObject({ state: "running", attention: { kind: "approval", count: 1 } });
  expect(boardEntry(base, "/repo")).not.toHaveProperty("attention");
  expect(boardEntry({ ...base, projectId: "" }, "/repo")).not.toHaveProperty("projectId");
  expect(runOrdinal("run:thread:a%3Ab:ordinal:12")).toBe(12);
  expect(runOrdinal(null)).toBe(0);
});

test("the board is the active thread list, iMessage chats left out", async () => {
  const control = fakeControl();
  control.add({ threadId: "work", title: "Fix the build", state: "running", worktreePath: "/repo/wt", latestRunId: "run:thread:work:ordinal:3" });
  control.add({ threadId: "done", title: "Done", state: "waiting" });
  control.add({ threadId: "old", state: "idle" });
  control.add({ threadId: "chat", origin: "imessage", state: "running" });
  const board = await control.backend.sessionBoard();
  expect(board.migrationComplete).toBe(true);
  expect(board.entries.map(entry => [entry.sessionId, entry.directory, entry.state, entry.status, entry.workRevision])).toEqual([
    ["work", "/repo/wt", "running", "busy", 3],
    ["done", "/repo", "waiting", "idle", 0],
  ]);
  expect(control.calls.some(call => call.path.startsWith("/threads?") && call.path.includes("active=true"))).toBe(true);
  expect(control.calls.some(call => call.path.startsWith("/api/"))).toBe(false);
});

test("requests are scoped by thread folder and answered through respond", async () => {
  const control = fakeControl();
  control.add({ threadId: "t1", pending: [{ requestId: "perm", kind: "approval", requestKind: "command", title: "bash", prompt: "make deploy", canRespond: true }] });
  control.add({ threadId: "t2", worktreePath: "/repo/wt", pending: [{ requestId: "q", kind: "question", requestKind: "user_input", canRespond: true,
    questions: [{ id: "env", header: "Env", question: "Where?", options: [{ label: "prod", description: "prod" }, { label: "dev", description: "dev" }], multiSelect: true }] }] });
  const permissions = await control.backend.permissions("/repo");
  expect(permissions).toEqual([{ id: "perm", sessionID: "t1", action: "bash", resources: ["make deploy"] }]);
  expect(await control.backend.permissions("/repo/wt")).toEqual([]);
  const [question] = await control.backend.questions("/repo/wt");
  expect(question).toMatchObject({ id: "q", sessionID: "t2", questions: [{ key: "env", multiple: true, custom: false }] });
  await control.backend.permissionReply("t1", "perm", "/repo", "once");
  await control.backend.questionReply(question!, "/repo/wt", [["prod", "dev"]]);
  expect(control.calls.filter(call => call.method === "POST").map(call => [call.path, call.body])).toEqual([
    ["/threads/t1/requests/perm/respond", { decision: "approve" }],
    ["/threads/t2/requests/q/respond", { answers: { env: ["prod", "dev"] } }],
  ]);
  expect(await control.backend.isSessionAutoAccepting("t1")).toBe(false);
  control.threads.get("t1")!.runtimeMode = "full-access";
  expect(await control.backend.isSessionAutoAccepting("t1")).toBe(true);
});

test("control events decode into attention events", async () => {
  const control = fakeControl([
    "id: 5\nevent: ready\ndata: {\"type\":\"ready\",\"sequence\":5}\n\n",
    ": ping\n\n",
    "id: 6\nevent: thread.status\ndata: {\"type\":\"thread.status\",\"threadId\":\"t1\",\"state\":\"running\",\"status\":\"running\"}\n\n",
    "id: 7\nevent: request.opened\ndata: {\"type\":\"request.opened\",\"threadId\":\"t1\",\"requestId\":\"r1\",\"kind\":\"approval\"}\n\n",
    "id: 8\nevent: request.resolved\ndata: {\"type\":\"request.resolved\",\"threadId\":\"t1\",\"requestId\":\"r1\",\"kind\":\"approval\"}\n\n",
    "id: 9\nevent: message.completed\ndata: {\"type\":\"message.completed\",\"threadId\":\"t1\",\"role\":\"assistant\",\"text\":\"x\"}\n\n",
    "id: 10\nevent: thread.status\ndata: {\"type\":\"thread.status\",\"threadId\":\"t1\",\"state\":\"waiting\",\"status\":\"waiting\"}\n\n",
    "id: 11\nevent: thread.updated\ndata: {\"type\":\"thread.updated\",\"threadId\":\"t1\",\"change\":\"thread.runtime-mode-updated\"}\n\n",
    "id: 12\nevent: thread.status\ndata: {\"type\":\"thread.status\",\"threadId\":\"gone\",\"state\":\"idle\"}\n\n",
  ]);
  control.add({ threadId: "t1" });
  const abort = new AbortController();
  const seen = [];
  for await (const event of control.backend.notifications(abort.signal)) {
    seen.push(event);
    if (seen.length === 7) abort.abort();
  }
  expect(seen).toEqual([
    { type: "invalidate" },
    { type: "status", sessionId: "t1", directory: "/repo", status: "busy" },
    { type: "asked", sessionId: "t1", directory: "/repo", requestId: "r1", kind: "approval" },
    { type: "resolved", sessionId: "t1", directory: "/repo", requestId: "r1", kind: "approval" },
    { type: "status", sessionId: "t1", directory: "/repo", status: "idle" },
    { type: "invalidate" },
    { type: "wake" },
  ]);
});

test("finished threads never get a review notice", async () => {
  setSystemTime(now);
  const control = fakeControl();
  control.add({ threadId: "work", title: "Fix the build", state: "running", latestRunId: "run:thread:work:ordinal:1" });
  control.add({ threadId: "chat", origin: "imessage", state: "running", latestRunId: "run:thread:chat:ordinal:1" });
  const { store, attention: alerts } = attention(control.backend);
  await alerts.tick();
  expect(store.pendingSessionNotices()).toEqual([]);
  control.threads.get("work")!.state = "waiting";
  control.threads.get("chat")!.state = "waiting";
  await alerts.tick();
  setSystemTime(now + 61_000);
  await alerts.tick();
  expect(store.pendingSessionNotices()).toEqual([]);
  expect(store.pendingOutbox()).toEqual([]);
});

test("a pending approval on a root thread becomes an approval prompt with buttons", async () => {
  setSystemTime(now);
  const control = fakeControl();
  control.add({ threadId: "work", title: "Deploy", state: "needs-input", latestRunId: "run:thread:work:ordinal:2",
    pending: [{ requestId: "perm-9", kind: "approval", requestKind: "command", title: "bash", prompt: "make deploy", canRespond: true }] });
  control.add({ threadId: "chat", origin: "imessage", state: "needs-input",
    pending: [{ requestId: "perm-chat", kind: "approval", requestKind: "command", title: "bash", prompt: "ls", canRespond: true }] });
  const { store, attention: alerts } = attention(control.backend);
  await alerts.tick();
  setSystemTime(now + 20_000);
  await alerts.tick();
  const outbox = store.pendingOutbox();
  expect(outbox).toHaveLength(1);
  expect(outbox[0]!.text).toContain("Deploy needs your approval.\nPermission perm-9: bash\nmake deploy");
  expect(outbox[0]!.keyboard).toMatchObject({ rows: [[{ text: "Approve once" }, { text: "Reject" }]] });
});

test("every root thread's question and permission request alerts the owner; there is no lead routing", async () => {
  setSystemTime(now);
  const control = fakeControl();
  control.add({ threadId: "lane", title: "GST lane", state: "needs-input", pending: [{ requestId: "q-lane", kind: "question", requestKind: "user_input",
    canRespond: true, questions: [{ id: "q", header: "Ship", question: "Ship it?", options: [{ label: "yes", description: "" }] }] }] });
  control.add({ threadId: "master", title: "Crpko master", state: "needs-input",
    pending: [{ requestId: "perm-master", kind: "approval", requestKind: "command", title: "bash", prompt: "make deploy", canRespond: true }] });
  const { store, attention: alerts } = attention(control.backend);
  await alerts.tick();
  setSystemTime(now + 20_000);
  await alerts.tick();
  const texts = store.pendingOutbox().map(entry => entry.text);
  expect(texts).toHaveLength(2);
  expect(texts.some(text => text.includes("GST lane"))).toBe(true);
  expect(texts.some(text => text.includes("Crpko master needs your approval"))).toBe(true);
  expect(control.calls.some(call => call.path.includes("missions") || call.path.includes("/board"))).toBe(false);
});

test("an attention tick reads pending requests once, however many folders are busy", async () => {
  setSystemTime(now);
  const control = fakeControl();
  control.add({ threadId: "a", title: "A", state: "running" });
  control.add({ threadId: "b", title: "B", state: "running", worktreePath: "/repo/b" });
  control.add({ threadId: "c", title: "Deploy", state: "needs-input", worktreePath: "/repo/c",
    pending: [{ requestId: "perm-c", kind: "approval", requestKind: "command", title: "bash", prompt: "make deploy", canRespond: true }] });
  const reads = () => control.calls.filter(call => call.path === "/requests").length;
  const { store, attention: alerts } = attention(control.backend);
  await alerts.tick();
  expect(reads()).toBe(1);
  setSystemTime(now + 20_000);
  await alerts.tick();
  expect(reads()).toBe(2);
  const outbox = store.pendingOutbox();
  expect(outbox.map(entry => entry.text)).toEqual([expect.stringContaining("Deploy needs your approval")]);
  // The dispatch boundary still rechecks live, before and after its other reads.
  expect(await alerts.beforeSend({ id: outbox[0]!.id })).toBe("send");
  expect(reads()).toBe(4);
});

test("while nothing is pending, requests are read once a minute; an open notice reads every tick", async () => {
  setSystemTime(now);
  const control = fakeControl();
  control.add({ threadId: "a", title: "Build", state: "running" });
  control.add({ threadId: "sub", title: "Helper", state: "running", parentThreadId: "a", relationshipToParent: "subagent" });
  const reads = () => control.calls.filter(call => call.path === "/requests").length;
  const { store, attention: alerts } = attention(control.backend);
  await alerts.tick();
  expect(reads()).toBe(1);
  for (const at of [5_000, 30_000, 55_000]) {
    setSystemTime(now + at);
    await alerts.tick();
  }
  expect(reads()).toBe(1);
  // This board stand-in hides subagents, so with no event the minute sweep is what finds the request.
  control.threads.get("sub")!.pending = [{ requestId: "perm-sub", kind: "approval", requestKind: "command", title: "bash", prompt: "ls", canRespond: true }];
  setSystemTime(now + 61_000);
  await alerts.tick();
  expect(reads()).toBe(2);
  expect(store.pendingSessionNotices()).toHaveLength(1);
  setSystemTime(now + 81_000);
  await alerts.tick();
  expect(reads()).toBe(3);
  expect(store.pendingOutbox().map(entry => entry.text)).toEqual([expect.stringContaining("Subsession Helper in Build needs your approval")]);
});

test("a request in a folder the board does not list is still found, such as a subagent in its own worktree", async () => {
  setSystemTime(now);
  const control = fakeControl();
  control.add({ threadId: "a", title: "Build", state: "running" });
  control.add({ threadId: "sub", title: "Helper", state: "running", parentThreadId: "a", relationshipToParent: "subagent", worktreePath: "/repo/child",
    pending: [{ requestId: "perm-sub", kind: "approval", requestKind: "command", title: "bash", prompt: "ls", canRespond: true }] });
  const { store, attention: alerts } = attention(control.backend);
  await alerts.tick();
  expect(store.pendingSessionNotices().map(notice => notice.directory)).toEqual(["/repo/child"]);
  setSystemTime(now + 20_000);
  await alerts.tick();
  expect(store.pendingOutbox().map(entry => entry.text)).toEqual([expect.stringContaining("needs your approval")]);
});

test("an asked event outside the cached roster still sends a prompt after the usual five seconds", async () => {
  setSystemTime(now);
  const control = fakeControl([], { now: () => Date.now() });
  const { store, attention: alerts } = attention(control.backend);
  await alerts.tick();
  control.add({ threadId: "hidden", state: "idle", pending: [{ requestId: "q-hidden", kind: "question", requestKind: "user_input",
    canRespond: true, questions: [{ id: "ship", header: "Ship", question: "Ship?", options: [{ label: "yes", description: "" }] }] }] });
  setSystemTime(now + 1_000);
  const event = await control.backend.notification({ type: "request.opened", threadId: "hidden", requestId: "q-hidden", kind: "question" });
  alerts.processNotification(event!);
  await alerts.tick();
  expect(control.backend.boardStatus()?.boardFetches).toBe(1);
  expect(store.pendingSessionNotices()).toHaveLength(1);
  setSystemTime(now + 6_000);
  await alerts.tick();
  expect(store.pendingOutbox().map(entry => entry.text)).toEqual([expect.stringContaining("Ship?")]);
  expect(alerts.status().board).toEqual(control.backend.boardStatus());
});

test("a status event discovers requests inside the board gap even without an asked event", async () => {
  setSystemTime(now);
  const control = fakeControl([], { now: () => Date.now() });
  control.add({ threadId: "t", state: "waiting" });
  const { store, attention: alerts } = attention(control.backend);
  await alerts.tick();
  control.threads.get("t")!.pending = [{ requestId: "q-status", kind: "question", requestKind: "user_input", canRespond: true,
    questions: [{ id: "env", header: "Env", question: "Where?", options: [{ label: "dev", description: "" }] }] }];
  setSystemTime(now + 1_000);
  alerts.processNotification((await control.backend.notification({ type: "thread.status", threadId: "t", state: "needs-input" }))!);
  await alerts.tick();
  expect(control.backend.boardStatus()?.boardFetches).toBe(1);
  expect(control.calls.filter(call => call.path === "/requests")).toHaveLength(2);
  expect(store.pendingSessionNotices().map(notice => [notice.requestId, notice.firstSeen])).toEqual([["q-status", now + 1_000]]);
  setSystemTime(now + 6_000);
  await alerts.tick();
  expect(store.pendingOutbox().map(entry => entry.text)).toEqual([expect.stringContaining("Where?")]);
});

test("asked and resolved events record notices while the board fetch is still in flight", async () => {
  const h = cachedBoard();
  let resolve!: (value: { total: number; threads: ThreadSummary[] }) => void;
  h.state.read = () => new Promise(done => { resolve = done; });
  const control = fakeControl([], { board: h.board });
  control.add({ threadId: "t" });
  const { store, attention: alerts } = attention(control.backend);
  const refresh = control.backend.sessionBoard();
  alerts.processNotification((await control.backend.notification({ type: "request.opened", threadId: "t", requestId: "q", kind: "question" }))!);
  const [notice] = store.pendingSessionNotices();
  expect(notice).toMatchObject({ requestId: "q", state: "pending" });
  alerts.processNotification((await control.backend.notification({ type: "request.resolved", threadId: "t", requestId: "q", kind: "question" }))!);
  expect(store.sessionNotice(notice!.id)?.state).toBe("cancelled");
  expect(h.calls()).toBe(1);
  resolve({ total: 1, threads: [h.thread] });
  await refresh;
});

test.each([
  ["request.opened", "before"], ["request.opened", "during"], ["thread.status", "before"], ["thread.status", "during"],
])("%s %s a slow board read still surfaces the prompt in five seconds", async (type, timing) => {
  setSystemTime(now);
  const h = cachedBoard();
  let resolve!: (value: { total: number; threads: ThreadSummary[] }) => void;
  h.state.read = () => new Promise(done => { resolve = done; });
  const control = fakeControl([], { board: h.board });
  control.add({ threadId: "t", state: "needs-input", pending: [{ requestId: "q-slow", kind: "question", requestKind: "user_input",
    canRespond: true, questions: [{ id: "env", header: "Env", question: "Where?", options: [{ label: "dev", description: "" }] }] }] });
  const { store, attention: alerts } = attention(control.backend);
  const tick = timing === "during" ? alerts.tick() : undefined;
  alerts.processNotification((await control.backend.notification({ type, threadId: "t", state: "needs-input", requestId: "q-slow", kind: "question" }))!);
  await (tick ?? alerts.tick());
  expect(store.pendingSessionNotices()).toHaveLength(1);
  expect(store.pendingOutbox()).toEqual([]);
  setSystemTime(now + 5_000);
  await alerts.tick();
  expect(store.pendingOutbox().map(entry => entry.text)).toEqual([expect.stringContaining("Where?")]);
  expect(h.calls()).toBe(1);
  alerts.processNotification((await control.backend.notification({ type: "request.resolved", threadId: "t", requestId: "q-slow", kind: "question" }))!);
  expect(store.pendingOutbox()).toEqual([]);
  resolve({ total: 1, threads: [h.thread] });
  await control.backend.sessionBoard();
});

const streamLogs = useToolLogFixture();


type StreamScript = (abort: AbortController) => AsyncGenerator<ControlEventFrame, void, unknown>;
async function scriptedStreams(scripts: StreamScript[]) {
  const control = fakeControl([], { now: () => now });
  const abort = new AbortController();
  const resumes: Array<number | undefined> = [];
  const delays: number[] = [];
  let index = 0;
  control.backend.client.events = async function* (options) {
    resumes.push(options.after);
    const script = scripts[index++];
    if (!script) { abort.abort(); return; }
    yield* script(abort);
  };
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    delays.push(delay);
    callback();
    return 0;
  }) as unknown as typeof setTimeout);
  const events = [];
  let callbacks = 0;
  try {
    for await (const event of control.backend.notifications(abort.signal, () => { callbacks++; })) events.push(event);
  } finally { timer.mockRestore(); }
  return { control, events, callbacks, resumes, delays };
}

test("stream ends record first-frame lifetimes, clean and error-frame ends, and preserve replay/backoff", async () => {
  let at = now;
  // Use the injected wall clock for both the board window and connection durations.
  const control = fakeControl([], { now: () => at });
  const abort = new AbortController();
  let connection = 0;
  const resumes: Array<number | undefined> = [];
  control.backend.client.events = async function* (options) {
    resumes.push(options.after);
    if (connection++ === 0) {
      yield { id: "5", data: { type: "ready", threadId: "thread:PRIVATE_ID", title: "PRIVATE_TITLE" } };
      at += 10;
      yield { id: "6", data: { type: "future.event", text: "PRIVATE_PAYLOAD" } };
      at += 75;
      yield { id: "7", data: { type: "error", code: "replica_lag", token: "PRIVATE_TOKEN" } };
    } else if (connection === 2) {
      at += 100;
      yield { id: "8", data: { type: "ready" } };
      at += 25;
    } else { abort.abort(); }
  };
  const delays: number[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    delays.push(delay); callback(); return 0;
  }) as unknown as typeof setTimeout);
  let callbacks = 0;
  try { for await (const event of control.backend.notifications(abort.signal, () => { callbacks++; })) void event; }
  finally { timer.mockRestore(); }
  const stats = control.backend.boardStatus()!;
  expect(stats).toMatchObject({ streamConnects: 2, streamEndsByKind: { errorFrame: 1, clean: 1, thrown: 0, aborted: 1 },
    streamLastConnectedMs: 25, streamMinConnectedMs: 25, streamMaxConnectedMs: 85, streamErrorCodes: { replica_lag: 1 },
    lastStreamEndAt: new Date(at).toISOString(), lastStreamEndKind: "aborted", windowStartedAt: new Date(now).toISOString(),
    dirtyEventsByType: { ready: { hard: 2, soft: 0 }, error: { hard: 0, soft: 1 } } });
  expect(callbacks).toBe(4);
  expect(resumes).toEqual([undefined, 7, 8]);
  // The no-frame abort still follows the existing reconnect sleep path.
  expect(delays).toEqual([1000, 1000, 2000]);
  expect(streamLogs.entries().filter(row => row.name === "tg.robob.streamEnd").map(row => row.props)).toEqual([
    { kind: "errorFrame", connectedMs: 85, code: "replica_lag" },
    { kind: "clean", connectedMs: 25, code: "none" },
    { kind: "aborted", connectedMs: null, code: "none" },
  ]);
  const { attention: alerts } = attention(control.backend);
  expect(alerts.status().board).toEqual(stats);
  const store = new Store(":memory:"); stores.push(store);
  const api = createApi({ store, enabled: () => true, chatId: () => 100, timezone: "UTC", health: () => ({ board: control.backend.boardStatus() }) });
  const health = await (await api(new Request("http://bridge/health"))).json();
  expect(health.board).toEqual(stats);
  expect(JSON.stringify(health) + streamLogs.text()).not.toContain("PRIVATE_");
  stats.streamEndsByKind.clean = 100;
  stats.streamErrorCodes.replica_lag = 100;
  expect(control.backend.boardStatus()?.streamEndsByKind.clean).toBe(1);
  expect(control.backend.boardStatus()?.streamErrorCodes.replica_lag).toBe(1);
});

test("stream throws retain toolError and aborts override thrown and error-frame outcomes", async () => {
  const result = await scriptedStreams([
    async function* () { yield { data: { type: "ready" } }; throw new Error("PRIVATE_ERROR"); },
    async function* (abort) { yield { data: { type: "error", code: "replica_lag" } }; abort.abort(); throw new Error("PRIVATE_ABORT"); },
  ]);
  expect(result.control.backend.boardStatus()).toMatchObject({ streamConnects: 2,
    streamEndsByKind: { errorFrame: 0, clean: 0, thrown: 1, aborted: 1 }, lastStreamEndKind: "aborted" });
  expect(result.delays).toEqual([1000]);
  expect(streamLogs.entries().filter(row => row.error?.tag === "tg.robob.notifications")).toHaveLength(2);
  expect(streamLogs.entries().filter(row => row.name === "tg.robob.streamEnd").map(row => row.props?.kind)).toEqual(["thrown", "aborted"]);
  expect(streamLogs.text()).not.toContain("PRIVATE_");
});

test("stream auth failures still escape and record a thrown attempt with no connected lifetime", async () => {
  const control = fakeControl();
  const error = new ControlError(401, "unauthorized");
  control.backend.client.events = async function* () { throw error; };
  const stream = control.backend.notifications(new AbortController().signal);
  await expect(stream.next()).rejects.toBe(error);
  expect(control.backend.boardStatus()).toMatchObject({ streamConnects: 0,
    streamEndsByKind: { thrown: 1 }, streamLastConnectedMs: null, streamMinConnectedMs: null, streamMaxConnectedMs: null });
  expect(streamLogs.entries().filter(row => row.error?.tag === "tg.robob.notifications")).toHaveLength(1);
});

test("error-frame codes are bounded, private payloads are excluded, and only the final frame determines clean ends", async () => {
  const result = await scriptedStreams([async function* () {
    yield { data: { type: "ready" } };
    for (const code of ["replica_lag", undefined, "PRIVATE_TITLE", "x".repeat(41), "", 123, "bad code", "__proto__", "constructor",
      ...Array.from({ length: 25 }, (_, index) => `code-${index}`), "replica_lag"]) {
      yield { data: { type: "error", code, threadId: "thread:PRIVATE_ID", title: "PRIVATE_TITLE", text: "PRIVATE_PAYLOAD" } };
    }
    yield { data: { type: "ready" } };
  }]);
  const stats = result.control.backend.boardStatus()!;
  expect(stats.streamConnects).toBe(1);
  expect(stats.streamEndsByKind).toEqual({ errorFrame: 0, clean: 1, thrown: 0, aborted: 1 });
  expect(Object.keys(stats.streamErrorCodes)).toHaveLength(21);
  expect(stats.streamErrorCodes).toMatchObject({ replica_lag: 2, none: 6, constructor: 1, ["__proto__"]: 1, other: 9 });
  expect(JSON.stringify(stats) + streamLogs.text()).not.toContain("PRIVATE_");
  const fresh = fakeControl().backend.boardStatus()!;
  expect(fresh.streamConnects).toBe(0);
  expect(fresh.streamErrorCodes).toEqual({});
});


test.each([
  ["replica_lag", "replica_lag"], ["a.b-c_9", "a.b-c_9"], ["x".repeat(40), "x".repeat(40)],
  ["__proto__", "__proto__"], ["constructor", "constructor"], ["other", "other"],
  [undefined, "none"], [null, "none"], [123, "none"], ["", "none"], ["x".repeat(41), "none"],
  ["PRIVATE_TITLE", "none"], ["bad code", "none"], ["thread:private-id", "none"], ["line\n", "none"],
] satisfies Array<[unknown, string]>)("final error code %p is counted and logged as %s", async (code, expected) => {
  const result = await scriptedStreams([async function* () { yield { data: { type: "ready" } }; yield { data: { type: "error", code } }; }]);
  expect(result.control.backend.boardStatus()?.streamEndsByKind.errorFrame).toBe(1);
  expect(result.control.backend.boardStatus()?.streamErrorCodes).toEqual({ [expected]: 1 });
  const end = streamLogs.entries().find(row => row.name === "tg.robob.streamEnd");
  expect(end?.props).toEqual({ kind: "errorFrame", connectedMs: 0, code: expected });
});

test("overflow error code logs as other and aborting a clean iterator records only aborted", async () => {
  const result = await scriptedStreams([async function* (abort) {
    for (let index = 0; index < 25; index++) yield { data: { type: "error", code: `code-${index}` } };
    abort.abort();
  }]);
  expect(result.control.backend.boardStatus()?.streamEndsByKind).toEqual({ errorFrame: 0, clean: 0, thrown: 0, aborted: 1 });
  expect(streamLogs.entries().find(row => row.name === "tg.robob.streamEnd")?.props).toEqual({ kind: "aborted", connectedMs: 0, code: "other" });
  const empty = await scriptedStreams([async function* (abort) { abort.abort(); }]);
  expect(empty.control.backend.boardStatus()).toMatchObject({ streamConnects: 0, streamEndsByKind: { aborted: 1 }, streamLastConnectedMs: null });
});
