import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Attention } from "../src/attention.ts";
import { backendKind } from "../src/config.ts";
import type { PendingRequest } from "../src/control.ts";
import { boardEntry, RobobAlertBackend, runOrdinal } from "../src/robob.ts";
import { Store } from "../src/store.ts";

type Thread = {
  threadId: string; projectId: string; title: string; origin: string | null; runtimeMode: string; worktreePath: string | null;
  parentThreadId: string | null; state: string; latestRunId: string | null; settled?: boolean; archived?: boolean; pending: PendingRequest[];
};
type Call = { method: string; path: string; body?: any };

const now = Date.parse("2026-10-03T12:00:00Z");
const servers: ReturnType<typeof Bun.serve>[] = [];
const stores: Store[] = [];
afterEach(async () => {
  setSystemTime();
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  for (const store of stores.splice(0)) store.db.close();
});

function fakeControl(events: string[] = []) {
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
      if (searchParams.get("includeSubagents") !== "true") list = list.filter(thread => !thread.parentThreadId);
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
    projectId: "p1", title: thread.threadId, origin: null, runtimeMode: "approval-required", worktreePath: null, parentThreadId: null,
    state: "idle", latestRunId: null, pending: [], ...thread,
  });
  const backend = new RobobAlertBackend({ url: server.url.origin, token: "test-token" });
  return { threads, calls, add, backend };
}

function attention(backend: RobobAlertBackend) {
  const store = new Store(":memory:");
  stores.push(store);
  const transport = { async editMessageText() {}, async answerCallback() {} };
  return { store, attention: new Attention(store, backend, transport, { chatId: () => 100, spectrumSocket: "/nonexistent/router.sock" }) };
}

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
  control.add({ threadId: "sub", title: "Helper", state: "running", parentThreadId: "a" });
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
  control.add({ threadId: "sub", title: "Helper", state: "running", parentThreadId: "a", worktreePath: "/repo/child",
    pending: [{ requestId: "perm-sub", kind: "approval", requestKind: "command", title: "bash", prompt: "ls", canRespond: true }] });
  const { store, attention: alerts } = attention(control.backend);
  await alerts.tick();
  expect(store.pendingSessionNotices().map(notice => notice.directory)).toEqual(["/repo/child"]);
  setSystemTime(now + 20_000);
  await alerts.tick();
  expect(store.pendingOutbox().map(entry => entry.text)).toEqual([expect.stringContaining("needs your approval")]);
});
