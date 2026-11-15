import { afterEach, expect, test } from "bun:test";
import type { NormalizedInbound } from "../src/photon.ts";
import { RobobBackend } from "../src/robob.ts";
import { Router } from "../src/router.ts";
import { Store } from "../src/store.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  for (const store of stores.splice(0)) store.db.close();
});

function fixture(active: boolean) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const now = new Date().toISOString();
  const thread = {
    threadId: "reset-thread", projectId: "chats", title: "Chat", state: active ? "running" : "idle",
    origin: "imessage", runtimeMode: "full-access", worktreePath: "/chats", parentThreadId: null,
    rootThreadId: "reset-thread", nativeSessionId: null, latestRunId: active ? "reset-run" : null,
    model: { instanceId: "codex", model: "gpt-6.1-sol" }, pendingRequest: null,
    lastError: null, settled: false, createdAt: now, updatedAt: now,
    run: active ? { runId: "reset-run", ordinal: 1, status: "running" } : null,
    recentRuns: active ? [{ runId: "reset-run", ordinal: 1, status: "running" }] : [], pendingRequests: [],
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname.replace("/api/ardud/control", "");
    const body: unknown = request.method === "GET" ? undefined : await request.json();
    calls.push({ method: request.method, path, body });
    const ok = (value: object) => Response.json({ ok: true, ...value });
    if (path === "/health") return ok({ status: "healthy" });
    if (path === "/projects") return ok({ projects: [{ projectId: "chats", title: "iMessage", workspaceRoot: "/chats" }] });
    if (path === "/threads" && request.method === "GET") return ok({ total: 1, threads: [thread] });
    if (path === "/threads" && request.method === "POST") return ok({ threadId: "fresh-thread", projectId: "chats", directory: "/chats", messageId: null, runId: null, status: "idle" });
    if (path === "/threads/reset-thread") return ok({ thread });
    if (path === "/threads/fresh-thread") return ok({ thread: { ...thread, threadId: "fresh-thread", state: "idle", run: null, recentRuns: [] } });
    if (path === "/threads/reset-thread/messages") return ok({ threadId: thread.threadId, state: thread.state, messages: [] });
    if (path === "/threads/fresh-thread/messages") return ok({ threadId: "fresh-thread", state: "idle", messages: [] });
    if (path.endsWith("/send")) return ok({ delivery: "started" });
    if (path === "/threads/reset-thread/interrupt") return ok({ interrupted: true });
    if (path === "/threads/reset-thread/origin") return ok({ threadId: thread.threadId, origin: "imessage" });
    throw new Error(`Unexpected fixture request ${request.method} ${path}`);
  } });
  servers.push(server);
  const backend = new RobobBackend({ chatRoot: "/chats", url: server.url.origin, token: "test-token", model: async () => ({ providerID: "codex", modelID: "gpt-6.1-sol" }) });
  return { backend, calls };
}

test.each(["/new", "/New"].flatMap(command => [false, true].flatMap(active => [false, true].map(expired => ({ command, active, expired })))))("reset interruption carries its source through the router ($command active=$active expired=$expired)", async ({ command, active, expired }) => {
  const { backend, calls } = fixture(active);
  const store = new Store(":memory:");
  stores.push(store);
  const route = { id: "reset-thread", directory: "/chats", generation: 1, createdAt: Date.now(), threadAt: Date.now() - (expired ? 9 * 60 * 60 * 1000 : 0) };
  store.set("route", route);
  if (active) {
    store.acceptInbound("running", { id: "running", text: "Work", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
    store.updateInbound("running", "processing");
    store.set("activeTurn", { ...route, inboundId: "running", messageId: "running-message", startedAt: Date.now(), phase: "running" });
  }
  const router = new Router(store, backend, {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
  }, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/private/test/skill.md",
    alertSkillPath: "/private/test/alert.md", alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent", quietMs: 0, watchMs: 0,
  });
  store.acceptInbound("reset-source", { id: "reset-source", text: command, attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  expect(store.pendingOutbox().some(item => item.kind === "control" && item.text === "Fresh start. What's up?")).toBe(true);
  const interrupts = calls.filter(call => call.path.endsWith("/interrupt"));
  expect(interrupts).toHaveLength(active ? 1 : 0);
  if (active) expect(interrupts[0]).toMatchObject({ method: "POST", path: "/threads/reset-thread/interrupt", body: { cancelReason: "thread_reset" } });
});

test.each([undefined, "user_stop", "thread_reset"] as const)("abort preserves the caller's optional source (%s)", async cancelReason => {
  const { backend, calls } = fixture(true);
  expect(await backend.abort("reset-thread", "/chats", cancelReason)).toBe(true);
  expect(calls.find(call => call.path.endsWith("/interrupt"))?.body).toEqual(cancelReason === undefined ? {} : { cancelReason });
});
