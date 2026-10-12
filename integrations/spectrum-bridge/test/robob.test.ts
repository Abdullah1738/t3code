import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendKind } from "../src/backend.ts";
import { discoverControlConfig, parseSse, questionFrom, type ControlMessage, type PendingRequest } from "../src/control.ts";
import type { NormalizedInbound, Photon } from "../src/photon.ts";
import { GUIDANCE_END, GUIDANCE_START, recordsFromThread, retireUnresolvedRoute, RobobBackend, sentMessagePrefix, withoutGuidance } from "../src/robob.ts";
import { Router } from "../src/router.ts";
import { Store } from "../src/store.ts";

type Thread = {
  threadId: string; projectId: string; title: string; origin: string | null; runtimeMode: string;
  worktreePath: string | null; parentThreadId: string | null; nativeSessionId: string | null;
  runs: Array<{ runId: string; ordinal: number; status: string }>;
  messages: ControlMessage[]; pending: PendingRequest[]; lastError: string | null; settled?: boolean;
};
type Call = { method: string; path: string; body?: any; auth: string | null };

const servers: ReturnType<typeof Bun.serve>[] = [];
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  for (const store of stores.splice(0)) store.db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A small in-memory stand-in for /api/ardud/control. */
function fakeControl() {
  const threads = new Map<string, Thread>();
  const natives = new Map<string, string>();
  const calls: Call[] = [];
  /** `ignoreSettled` mimics a server from before PATCH learned `settled`. */
  const flags = { ignoreSettled: false };
  const projects = [{ projectId: "chats", title: "iMessage", workspaceRoot: "/chats" }];
  let counter = 0;
  const now = () => new Date(Date.now() + counter++).toISOString();
  const state = (thread: Thread) => thread.pending.length ? "needs-input"
    : thread.runs.some(run => run.status === "running") ? "running" : thread.runs.some(run => run.status === "waiting") ? "waiting" : "idle";
  const summary = (thread: Thread) => ({
    threadId: thread.threadId, projectId: thread.projectId, title: thread.title, state: state(thread), status: thread.runs.at(-1)?.status ?? "idle",
    origin: thread.origin, nativeSessionId: thread.nativeSessionId, runtimeMode: thread.runtimeMode, parentThreadId: thread.parentThreadId,
    rootThreadId: thread.parentThreadId ?? thread.threadId, worktreePath: thread.worktreePath, latestRunId: thread.runs.at(-1)?.runId ?? null,
    pendingRequest: thread.pending[0] ? { requestId: thread.pending[0].requestId, kind: thread.pending[0].kind, requestKind: thread.pending[0].requestKind } : null,
    lastError: thread.lastError, settled: thread.settled ?? false, createdAt: now(), updatedAt: now(),
  });
  const detail = (thread: Thread) => ({ ...summary(thread), run: thread.runs.at(-1) ?? null, recentRuns: [...thread.runs].reverse(), pendingRequests: thread.pending });
  const ok = (body: object, status = 200) => Response.json({ ok: true, ...body }, { status });
  const notFound = () => Response.json({ ok: false, error: { code: "not_found", message: "nope" } }, { status: 404 });
  const url = (() => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const { pathname, searchParams } = new URL(request.url);
      const path = pathname.replace("/api/ardud/control", "");
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
      calls.push({ method: request.method, path: path + (searchParams.size ? `?${searchParams}` : ""), body, auth: request.headers.get("authorization") });
      if (request.headers.get("authorization") !== "Bearer test-token") return Response.json({ ok: false, error: { code: "unauthorized" } }, { status: 401 });
      const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
      if (path === "/health") return ok({ status: "healthy", sequence: 1 });
      if (path === "/projects") return ok({ projects });
      if (path === "/threads" && request.method === "POST") {
        const threadId = `thread-${threads.size + 1}`;
        threads.set(threadId, { threadId, projectId: "chats", title: body.title, origin: body.origin ?? null, runtimeMode: body.runtimeMode,
          worktreePath: body.directory, parentThreadId: null, nativeSessionId: null, runs: [], messages: [], pending: [], lastError: null });
        return ok({ threadId, projectId: "chats", directory: body.directory, messageId: null, runId: null, status: "idle" }, 201);
      }
      if (path === "/threads" && request.method === "GET") {
        let list = [...threads.values()];
        if (searchParams.get("parentThreadId")) list = list.filter(thread => thread.parentThreadId === searchParams.get("parentThreadId"));
        if (searchParams.get("active") === "true") list = list.filter(thread => state(thread) !== "idle");
        if (searchParams.get("origin")) list = list.filter(thread => thread.origin === searchParams.get("origin"));
        return ok({ total: list.length, threads: list.map(summary) });
      }
      if (parts[0] === "threads" && parts[1] === "by-native") {
        const thread = threads.get(natives.get(parts[2]!) ?? "");
        return thread ? ok({ nativeSessionId: parts[2], thread: detail(thread) }) : notFound();
      }
      const thread = parts[0] === "threads" ? threads.get(parts[1]!) : undefined;
      if (parts[0] === "threads" && !thread) return notFound();
      if (thread && parts.length === 2 && request.method === "PATCH") {
        if (body.settled !== undefined) {
          if (body.settled && state(thread) !== "idle") return Response.json({ ok: false, error: { code: "conflict", message: "busy" } }, { status: 409 });
          if (!flags.ignoreSettled) thread.settled = body.settled;
        }
        return ok({ thread: detail(thread) });
      }
      if (thread && parts.length === 2) return ok({ thread: detail(thread) });
      if (thread && parts[2] === "messages") return ok({ threadId: thread.threadId, state: state(thread), messages: thread.messages });
      if (thread && parts[2] === "origin") { thread.origin = body.origin; return ok({ threadId: thread.threadId, origin: body.origin }); }
      if (thread && parts[2] === "interrupt") return ok({ interrupted: true });
      if (thread && parts[2] === "send") {
        const messageId = `${sentMessagePrefix(thread.threadId)}${encodeURIComponent(body.clientRequestId)}`;
        if (!thread.messages.some(message => message.messageId === messageId)) {
          const runId = `run:thread:${thread.threadId}:ordinal:${thread.runs.length + 1}`;
          thread.runs.push({ runId, ordinal: thread.runs.length + 1, status: "running" });
          thread.messages.push({ messageId, runId, role: "user", text: body.text, streaming: false, createdBy: "user", createdAt: now(), updatedAt: now() });
        }
        return ok({ threadId: thread.threadId, messageId, delivery: "started" });
      }
      if (thread && parts[2] === "requests") {
        thread.pending = thread.pending.filter(request => request.requestId !== parts[3]);
        return ok({ threadId: thread.threadId, requestId: parts[3] });
      }
      return notFound();
    } });
    servers.push(server);
    return server.url.origin;
  })();
  /** Finishes the newest run with an assistant reply. */
  const reply = (threadId: string, text: string, status = "waiting") => {
    const thread = threads.get(threadId)!;
    const run = thread.runs.at(-1)!;
    thread.messages.push({ messageId: `assistant-${thread.messages.length}`, runId: run.runId, role: "assistant", text, streaming: false, createdBy: "agent", createdAt: now(), updatedAt: now() });
    run.status = status;
  };
  const backend = (chatRoot = "/chats") => new RobobBackend({ chatRoot, url, token: "test-token", model: async () => ({ providerID: "opus", modelID: "claude-opus-5-5", variant: "high" }) });
  return { url, threads, natives, calls, projects, flags, reply, backend };
}

test("backend switch defaults to OpenChamber and rejects unknown values", () => {
  expect(backendKind({}, {})).toBe("openchamber");
  expect(backendKind({}, { backend: "robob" })).toBe("robob");
  expect(backendKind({ BRIDGE_BACKEND: "robob" }, { backend: "openchamber" })).toBe("robob");
  expect(() => backendKind({ BRIDGE_BACKEND: "chamber" })).toThrow("Invalid bridge backend");
});

test("control config: env first, then a chmod 600 token file, loopback only", () => {
  const dir = mkdtempSync(join(tmpdir(), "robob-config-"));
  dirs.push(dir);
  const file = join(dir, "ardud-control.json");
  writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:14033", token: "from-file" }));
  chmodSync(file, 0o644);
  expect(() => discoverControlConfig({ env: { T3_CONTROL_TOKEN_FILE: file } })).toThrow("chmod 600");
  chmodSync(file, 0o600);
  expect(discoverControlConfig({ env: { T3_CONTROL_TOKEN_FILE: file } })).toEqual({ url: "http://127.0.0.1:14033", token: "from-file" });
  expect(discoverControlConfig({ env: { T3_CONTROL_URL: "http://localhost:1/", T3_CONTROL_TOKEN: "env", T3_CONTROL_TOKEN_FILE: file } }))
    .toEqual({ url: "http://localhost:1", token: "env" });
  expect(() => discoverControlConfig({ env: { T3_CONTROL_URL: "https://example.com", T3_CONTROL_TOKEN: "x" } })).toThrow("127.0.0.1");
  expect(() => discoverControlConfig({ env: { T3_CONTROL_TOKEN_FILE: join(dir, "missing.json") } })).toThrow();
});

test("createChat makes an imessage-origin full-access thread in a dated folder under the chat root", async () => {
  const control = fakeControl();
  const created = await control.backend().createChat();
  expect(created.id).toBe("thread-1");
  expect(created.directory).toMatch(/^\/chats\/\d{4}-\d{2}-\d{2}\/session-[0-9a-f-]{36}$/);
  const post = control.calls.find(call => call.method === "POST" && call.path === "/threads")!;
  expect(post.body).toMatchObject({ directory: created.directory, origin: "imessage", runtimeMode: "full-access", model: "opus/claude-opus-5-5", variant: "high" });
  expect(post.auth).toBe("Bearer test-token");
});

test("createChat refuses a chat root that is not a registered project", async () => {
  const control = fakeControl();
  await expect(control.backend("/elsewhere").createChat()).rejects.toThrow("not a Robob project");
  expect(control.calls.some(call => call.method === "POST")).toBe(false);
});

test("prompt prepends channel guidance, sends the model and dedupes by prompt id", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const { id, directory } = await backend.createChat();
  await backend.prompt(id, directory, "msg_1", "hello", "Be brief.", [], { providerID: "opus", modelID: "claude-opus-5-5", variant: "high" });
  await backend.prompt(id, directory, "msg_1", "hello", "Be brief.");
  const sends = control.calls.filter(call => call.path.endsWith("/send"));
  expect(sends[0]!.body).toMatchObject({ mode: "auto", clientRequestId: "msg_1", model: "opus/claude-opus-5-5", variant: "high" });
  expect(sends[0]!.body.text).toBe(`${GUIDANCE_START}\nBe brief.\n${GUIDANCE_END}\n\nhello`);
  expect(control.threads.get(id)!.messages).toHaveLength(1);
  expect(await backend.promptAccepted(id, directory, "msg_1")).toBe(true);
  expect(await backend.promptAccepted(id, directory, "msg_2")).toBe(false);
  const records = await backend.messages(id, directory);
  expect(records).toEqual([{ id: "msg_1", type: "user", text: "hello", time: expect.any(Object) }]);
});

test("records: settled runs end with an idle marker; agent-sent wakes are not owner text", () => {
  const messages: ControlMessage[] = [
    { messageId: `${sentMessagePrefix("t")}m1`, runId: "run:thread:t:ordinal:1", role: "user", text: `${GUIDANCE_START}\nx\n${GUIDANCE_END}\n\nhi`, streaming: false, createdBy: "user", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { messageId: "a1", runId: "run:thread:t:ordinal:1", role: "assistant", text: "Hello!", streaming: false, createdAt: "2026-01-01T00:00:01Z", updatedAt: "2026-01-01T00:00:02Z" },
    { messageId: "wake", runId: "run:thread:t:ordinal:2", role: "user", text: "Delegated task done", streaming: false, createdBy: "agent", createdAt: "2026-01-01T00:01:00Z", updatedAt: "2026-01-01T00:01:00Z" },
    { messageId: "a2", runId: "run:thread:t:ordinal:2", role: "assistant", text: "Partial", streaming: true, createdAt: "2026-01-01T00:01:01Z", updatedAt: "2026-01-01T00:01:01Z" },
  ];
  const records = recordsFromThread({ threadId: "t", lastError: null, run: null, recentRuns: [
    { runId: "run:thread:t:ordinal:2", ordinal: 2, status: "running" }, { runId: "run:thread:t:ordinal:1", ordinal: 1, status: "waiting" },
  ] }, messages);
  expect(records.map(record => [record.type, record.id])).toEqual([
    ["user", "m1"], ["assistant", "a1"], ["idle", "idle:run:thread:t:ordinal:1"], ["assistant", "a2"],
  ]);
  expect((records[0] as { text: string }).text).toBe("hi");
  expect(records[2]).toMatchObject({ outcome: "succeeded" });
  expect(records[3]).not.toHaveProperty("finish");
  expect(withoutGuidance("plain")).toBe("plain");
});

test("a failed run carries the thread error so refusals are recognised", () => {
  const records = recordsFromThread({ threadId: "t", lastError: "Provider blocked the response", run: null, recentRuns: [{ runId: "r1", ordinal: 1, status: "failed" }] }, [
    { messageId: "u", runId: "r1", role: "user", text: "x", streaming: false, createdBy: "user", createdAt: null, updatedAt: null },
  ]);
  expect(records.map(record => record.type)).toEqual(["user", "assistant", "idle"]);
  expect(records[1]).toMatchObject({ error: { message: "Provider blocked the response" } });
  expect(records[2]).toMatchObject({ outcome: "failed" });
});

test("ses_ ids resolve through by-native; requests and replies go to the control API", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const { id, directory } = await backend.createChat();
  control.natives.set("ses_old", id);
  const thread = control.threads.get(id)!;
  thread.pending = [
    { requestId: "perm-1", kind: "approval", requestKind: "command", title: "bash", prompt: "rm -rf build\nls", canRespond: true },
    { requestId: "q-1", kind: "question", requestKind: "user_input", title: "User input", canRespond: true, questions: [
      { id: "q0", header: "Pick", question: "Which?", options: [{ label: "A", description: "A" }, { label: "B", description: "Second" }], multiSelect: false, allowCustomAnswer: false },
    ] },
  ];
  const permissions = await backend.permissions("ses_old", directory);
  expect(permissions).toEqual([{ id: "perm-1", sessionID: "ses_old", action: "bash", resources: ["rm -rf build", "ls"] }]);
  const [question] = await backend.questions("ses_old", directory);
  expect(question).toMatchObject({ id: "q-1", sessionID: "ses_old", questions: [{ key: "q0", options: [{ label: "A" }, { label: "B", description: "Second" }], multiple: false, custom: false }] });
  expect(await backend.permissionReply("ses_old", "perm-1", directory, "reject")).toBe(true);
  expect(await backend.questionReply(question!, directory, [["B"]])).toBe(true);
  const responds = control.calls.filter(call => call.path.includes("/requests/"));
  expect(responds.map(call => [call.path, call.body])).toEqual([
    [`/threads/${id}/requests/perm-1/respond`, { decision: "deny" }],
    [`/threads/${id}/requests/q-1/respond`, { answers: { q0: "B" } }],
  ]);
  expect(await backend.isSessionAutoAccepting("ses_old", directory)).toBe(true);
  expect(await backend.isSessionAutoAccepting("ses_unknown", directory)).toBeUndefined();
  expect(await backend.markImessageOrigin("ses_old")).toBe("already");
  thread.origin = null;
  expect(await backend.markImessageOrigin(id)).toBe("marked");
  expect(control.threads.get(id)!.origin).toBe("imessage");
  expect(await backend.markImessageOrigin("thread-missing")).toBe("missing");
  await expect(backend.markImessageOrigin("ses_unknown")).rejects.toThrow();
});

test("a question Robob cannot ask over text is surfaced as unsupported", () => {
  expect(questionFrom({ requestId: "r", kind: "question", requestKind: "user_input", canRespond: false, questions: [] }, "t"))
    .toMatchObject({ unsupported: true, questions: [] });
});

test("statuses list busy threads; waiting (background drain) does not block the chat", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const { id, directory } = await backend.createChat();
  await backend.prompt(id, directory, "msg_1", "hi");
  expect(await backend.statuses()).toEqual({ [id]: { type: "busy" } });
  control.reply(id, "done", "waiting");
  expect(await backend.statuses()).toEqual({});
});

test("retireOthers settles idle iMessage chats except the kept one", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const old = await backend.createChat();
  const busy = await backend.createChat();
  const keep = await backend.createChat();
  await backend.prompt(busy.id, busy.directory, "msg_1", "still going");
  control.threads.set("other", { ...control.threads.get(old.id)!, threadId: "other", origin: null });
  control.threads.set("child", { ...control.threads.get(old.id)!, threadId: "child", parentThreadId: old.id });
  expect(await backend.retireOthers(keep.id)).toBe(1);
  expect(control.threads.get(old.id)!.settled).toBe(true);
  expect(control.threads.get(busy.id)!.settled).toBeUndefined();
  expect(control.threads.get(keep.id)!.settled).toBeUndefined();
  expect(control.threads.get("other")!.settled).toBeUndefined();
  expect(control.threads.get("child")!.settled).toBeUndefined();
  expect(await backend.retireOthers(keep.id)).toBe(0);
});

test("retireOthers counts nothing when the server ignores settled", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const old = await backend.createChat();
  const keep = await backend.createChat();
  control.flags.ignoreSettled = true;
  expect(await backend.retireOthers(keep.id)).toBe(0);
  expect(control.threads.get(old.id)!.settled).toBeUndefined();
});

test("an unmapped ses_ route is retired so the next text starts a fresh chat", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const store = new Store(":memory:");
  stores.push(store);
  store.set("route", { id: "ses_gone", directory: "/old", generation: 3 });
  expect(await retireUnresolvedRoute(store, backend)).toBe(true);
  expect(store.get("route")).toBeNull();
  control.natives.set("ses_kept", (await backend.createChat()).id);
  store.set("route", { id: "ses_kept", directory: "/old", generation: 3 });
  expect(await retireUnresolvedRoute(store, backend)).toBe(false);
  store.set("route", { id: "thread-1", directory: "/chats/x", generation: 3 });
  expect(await retireUnresolvedRoute(store, backend)).toBe(false);
});

test("Robob threads reset their own context; imported ses_ routes don't", () => {
  const backend = fakeControl().backend();
  expect(backend.resetsContext("thread-1")).toBe(true);
  expect(backend.resetsContext("ses_legacy")).toBe(false);
});

test("SSE parser yields id, event and JSON data, skipping comments", async () => {
  const body = new Response(": ping\n\nid: 7\nevent: thread.status\ndata: {\"type\":\"thread.status\",\"state\":\"idle\"}\n\nid: 8\ndata: not json\n\n").body!;
  const frames = [];
  for await (const frame of parseSse(body)) frames.push(frame);
  expect(frames).toEqual([{ id: "7", event: "thread.status", data: { type: "thread.status", state: "idle" } }]);
});

test("the router runs a full iMessage turn on the Robob backend", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const earlier = await backend.createChat();
  const store = new Store(":memory:");
  stores.push(store);
  const transport: Pick<Photon, "typing" | "read" | "downloadAttachment"> = {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
  };
  const router = new Router(store, backend, transport, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/private/test/skill.md",
    alertSkillPath: "/private/test/alert.md", alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent", quietMs: 0,
  });
  store.acceptInbound("in-1", { id: "in-1", text: "what's up?", attachments: [], isAudioMessage: false, receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  const route = store.get<{ id: string; directory: string }>("route")!;
  expect(route.id).toBe("thread-2");
  // The earlier chat is settled in the background once the new route is stored.
  for (let i = 0; i < 100 && !control.threads.get(earlier.id)!.settled; i++) await Bun.sleep(5);
  expect(control.threads.get(earlier.id)!.settled).toBe(true);
  expect(control.threads.get(route.id)!.settled).toBeUndefined();
  expect(control.threads.get(route.id)!.origin).toBe("imessage");
  const sent = control.calls.find(call => call.path.endsWith("/send"))!;
  expect(sent.body.text).toStartWith(GUIDANCE_START);
  expect(sent.body.text).toContain("CURRENT_SESSION_ID for bridge commands: thread-2");
  expect(sent.body.text).toEndWith("what's up?");
  expect(store.get<{ phase: string }>("activeTurn")!.phase).toBe("running");
  control.reply(route.id, "All good here.");
  await router.tick();
  const replies = store.pendingOutbox().filter(item => item.kind === "conversation");
  expect(replies.map(item => [item.text, item.sessionId])).toEqual([["All good here.", "thread-2"]]);
  expect(store.get("activeTurn")).toBeNull();
});
