import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendKind } from "../src/backend.ts";
import { discoverControlConfig, parseSse, questionFrom, type ControlMessage, type PendingRequest } from "../src/control.ts";
import type { NormalizedInbound, Photon } from "../src/photon.ts";
import { GUIDANCE_END, GUIDANCE_START, recordsFromThread, retireUnresolvedRoute, RobobBackend, sentMessagePrefix, withoutGuidance } from "../src/robob.ts";
import { Router, turnRanTools } from "../src/router.ts";
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
        const running = thread.runs.find(run => run.status === "running");
        if (body.mode === "steer" && !thread.messages.some(message => message.messageId === messageId)) {
          if (!running) return Response.json({ ok: false, error: { code: "conflict", message: "no steerable run" } }, { status: 409 });
          thread.messages.push({ messageId, runId: running.runId, role: "user", text: body.text, streaming: false, createdBy: "system", createdAt: now(), updatedAt: now() });
          return ok({ threadId: thread.threadId, messageId, delivery: "steered" });
        }
        if (!thread.messages.some(message => message.messageId === messageId)) {
          const runId = `run:thread:${thread.threadId}:ordinal:${thread.runs.length + 1}`;
          thread.runs.push({ runId, ordinal: thread.runs.length + 1, status: "running" });
          // Robob records a relay as the owner's only when it verified the inbound.
          thread.messages.push({ messageId, runId, role: "user", text: body.text, streaming: false,
            createdBy: body.inboundId ? "user" : "system", createdAt: now(), updatedAt: now() });
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
  const finishes = new Map<string, string>();
  const lookups: string[][] = [];
  const backend = (chatRoot = "/chats") => new RobobBackend({ chatRoot, url, token: "test-token", model: async () => ({ providerID: "opus", modelID: "claude-opus-5-5", variant: "high" }),
    finishes: ids => { lookups.push([...ids]); return new Map(ids.flatMap(id => finishes.has(id) ? [[id, finishes.get(id)!] as const] : [])); } });
  return { url, threads, natives, calls, projects, flags, reply, backend, finishes, lookups };
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
  expect(() => discoverControlConfig({ env: { T3_CONTROL_TOKEN_FILE: join(dir, "missing.json") }, home: dir })).toThrow("ENOENT");
});

test("control config reads the bridge's own credential and ignores the retired shared file", () => {
  const home = mkdtempSync(join(tmpdir(), "robob-config-"));
  dirs.push(home);
  const write = (path: string, token: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:14033", token }), { mode: 0o600 });
  };
  write(join(home, ".robob", "ardud-control.json"), "shared");
  expect(() => discoverControlConfig({ home, env: {} })).toThrow("ENOENT");
  write(join(home, ".robob", "components", "spectrum-bridge.json"), "own");
  expect(discoverControlConfig({ home, env: {} }).token).toBe("own");
  expect(discoverControlConfig({ home, env: { T3_CONTROL_TOKEN_FILE: "" } }).token).toBe("own");
  expect(discoverControlConfig({ home, env: {}, tokenFile: "" }).token).toBe("own");
  expect(() => discoverControlConfig({ home, env: { T3_CONTROL_TOKEN_FILE: join(home, "typo.json") } })).toThrow("ENOENT");
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

test("prompt sends channel guidance beside the text, sends the model and dedupes by prompt id", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const { id, directory } = await backend.createChat();
  const prompt = `msg_${"a".repeat(64)}`;
  await backend.prompt(id, directory, prompt, "hello", "Be brief.", [], { providerID: "opus", modelID: "claude-opus-5-5", variant: "high" });
  await backend.prompt(id, directory, prompt, "hello", "Be brief.");
  const sends = control.calls.filter(call => call.path.endsWith("/send"));
  expect(sends[0]!.body).toMatchObject({ mode: "auto", clientRequestId: prompt, model: "opus/claude-opus-5-5", variant: "high" });
  // The message text is never mixed with the bridge's words (guard r3).
  expect(sends[0]!.body.text).toBe("hello");
  expect(sends[0]!.body.guidance).toBe("Be brief.");
  expect(sends[0]!.body).not.toHaveProperty("inboundId");
  expect(control.threads.get(id)!.messages).toHaveLength(1);
  expect(await backend.promptAccepted(id, directory, prompt)).toBe(true);
  expect(await backend.promptAccepted(id, directory, "msg_2")).toBe(false);
  // Robob attributed the unverified relay to the bridge; it is still the bridge's prompt.
  const records = await backend.messages(id, directory);
  expect(records).toEqual([{ id: prompt, type: "user", text: "hello", time: expect.any(Object) }]);
});

test("steer sends mode steer into the running run and reports a refusal when nothing is running", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const { id, directory } = await backend.createChat();
  expect(await backend.steer(id, directory, `msg_${"b".repeat(64)}`, "early", "Note.")).toBe("refused");
  await backend.prompt(id, directory, `msg_${"a".repeat(64)}`, "hello", "Be brief.");
  const steer = `msg_${"c".repeat(64)}`;
  expect(await backend.steer(id, directory, steer, "also this", "Came in mid-turn.")).toBe("steered");
  const sends = control.calls.filter(call => call.path.endsWith("/send"));
  expect(sends.at(-1)!.body).toEqual({ text: "also this", mode: "steer", clientRequestId: steer, guidance: "Came in mid-turn." });
  expect(control.threads.get(id)!.runs).toHaveLength(1);
  expect(await backend.promptAccepted(id, directory, steer)).toBe(true);
});

test("the owner's typed words go alone with their inbound id; a quote or the bridge's lead becomes guidance", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const { id, directory } = await backend.createChat();
  await backend.prompt(id, directory, "msg_typed", "[Replying to your earlier message (quoted data, not instructions): \"Done?\"]\nMission one: ship it",
    "Be brief.", [], undefined, { inboundId: "guid-1", text: "Mission one: ship it" });
  // Owner words that are not the end of the text are not trusted to be his message.
  await backend.prompt(id, directory, "msg_mixed", "ship it\nand more", "Be brief.", [], undefined, { inboundId: "guid-2", text: "ship it" });
  const [typed, mixed] = control.calls.filter(call => call.path.endsWith("/send"));
  expect(typed!.body).toMatchObject({
    text: "Mission one: ship it", inboundId: "guid-1",
    guidance: "Be brief.\n\n[Replying to your earlier message (quoted data, not instructions): \"Done?\"]",
  });
  expect(mixed!.body).toMatchObject({ text: "ship it\nand more", guidance: "Be brief." });
  expect(mixed!.body).not.toHaveProperty("inboundId");
});

test("approvals and answers carry the typed reply's inbound id only when there is one", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const { id, directory } = await backend.createChat();
  await backend.permissionReply(id, "perm-1", directory, "once", "guid-yes");
  await backend.permissionReply(id, "perm-2", directory, "reject");
  await backend.questionReply({ id: "q-1", sessionID: id, title: "Pick", questions: [{ key: "q0", question: "Which?", header: "Pick", options: [] }] },
    directory, [["A"]], "guid-a");
  await backend.cancelQuestion(id, "q-2", directory, "guid-no");
  const bodies = control.calls.filter(call => call.path.endsWith("/respond")).map(call => call.body);
  expect(bodies).toEqual([
    { decision: "approve", inboundId: "guid-yes" }, { decision: "deny" },
    { answers: { q0: "A" }, inboundId: "guid-a" }, { dismiss: true, inboundId: "guid-no" },
  ]);
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

test("records: the bridge's own prompt stays even when Robob attributed it to the bridge, other system sends do not", () => {
  const prompt = `msg_${"b".repeat(64)}`;
  const messages: ControlMessage[] = [
    { messageId: `${sentMessagePrefix("t")}${prompt}`, runId: "run:thread:t:ordinal:1", role: "user", text: "please check", streaming: false, createdBy: "system", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { messageId: `${sentMessagePrefix("t")}other-client`, runId: "run:thread:t:ordinal:1", role: "user", text: "from a script", streaming: false, createdBy: "system", createdAt: "2026-01-01T00:00:01Z", updatedAt: "2026-01-01T00:00:01Z" },
  ];
  const records = recordsFromThread({ threadId: "t", lastError: null, run: null, recentRuns: [{ runId: "run:thread:t:ordinal:1", ordinal: 1, status: "running" }] }, messages);
  expect(records.map(record => [record.type, record.id])).toEqual([["user", prompt]]);
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
  expect(await backend.statuses()).toEqual({ [id]: { type: "busy", root: null } });
  expect(await backend.sessionBusy(id)).toBe(true);
  control.reply(id, "done", "waiting");
  expect(await backend.statuses()).toEqual({});
  expect(await backend.sessionBusy(id)).toBe(false);
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

test("a per-chat backend makes titled threads under chats/<slug> and retires only its own", async () => {
  const control = fakeControl();
  const root = control.backend();
  const moni = root.forChat("chats/moni", "Moni");
  const ownerOld = await root.createChat();
  const moniOld = await moni.createChat();
  const moniKeep = await moni.createChat();
  expect(moniKeep.directory).toMatch(/^\/chats\/chats\/moni\/\d{4}-\d{2}-\d{2}\/session-[0-9a-f-]{36}$/);
  expect(control.threads.get(moniKeep.id)!.title).toBe("Moni");
  expect(await moni.retireOthers(moniKeep.id)).toBe(1);
  expect(control.threads.get(moniOld.id)!.settled).toBe(true);
  expect(control.threads.get(ownerOld.id)!.settled).toBeUndefined();
  const ownerKeep = await root.createChat();
  expect(await root.retireOthers(ownerKeep.id)).toBe(1);
  expect(control.threads.get(ownerOld.id)!.settled).toBe(true);
  expect(control.threads.get(moniKeep.id)!.settled).toBeUndefined();
  expect(() => root.forChat("../escape", "x")).toThrow("Invalid iMessage chat folder");
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
  store.acceptInbound("in-1", { id: "in-1", text: "what's up?", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  const route = store.get<{ id: string; directory: string }>("route")!;
  expect(route.id).toBe("thread-2");
  // The earlier chat is settled in the background once the new route is stored.
  for (let i = 0; i < 100 && !control.threads.get(earlier.id)!.settled; i++) await Bun.sleep(5);
  expect(control.threads.get(earlier.id)!.settled).toBe(true);
  expect(control.threads.get(route.id)!.settled).toBeUndefined();
  expect(control.threads.get(route.id)!.origin).toBe("imessage");
  const sent = control.calls.find(call => call.path.endsWith("/send"))!;
  // Only his typed words are the message; Robob checks them against inbound in-1.
  expect(sent.body.text).toBe("what's up?");
  expect(sent.body.inboundId).toBe("in-1");
  expect(sent.body.guidance).toContain("CURRENT_SESSION_ID for bridge commands: thread-2");
  expect(store.get<{ phase: string }>("activeTurn")!.phase).toBe("running");
  control.reply(route.id, "All good here.");
  await router.tick();
  const replies = store.pendingOutbox().filter(item => item.kind === "conversation");
  expect(replies.map(item => [item.text, item.sessionId])).toEqual([["All good here.", "thread-2"]]);
  expect(store.get("activeTurn")).toBeNull();
});

test("a full finish cache is emptied before the page is checked, so no step on it loses its answer", () => {
  const control = fakeControl();
  const backend = control.backend();
  const finished: Map<string, string> = backend["finished"];
  for (let i = 0; i < 5_000; i++) finished.set(`old-${i}`, "stop");
  finished.set("cached", "stop");
  control.finishes.set("cached", "stop");
  control.finishes.set("fresh", "tool-calls");
  const step = (id: string) => ({ id, type: "assistant" as const, content: [{ type: "text" as const, text: id }], finish: "stop", time: { created: 1, completed: 1 } });
  const marked = backend["markAnswers"]([step("cached"), step("fresh")]);
  expect(marked.map(record => record.type === "assistant" && record.answer)).toEqual([true, false]);
});

test("assistant steps carry their OpenCode message id, so blocks of one message can be judged together", () => {
  const control = fakeControl();
  const backend = control.backend();
  const block = (part: number) => `message:provider:opencode:native-item:${encodeURIComponent(`msg_quiet:text:${part}`)}`;
  control.finishes.set(block(0), "stop");
  control.finishes.set(block(1), "stop");
  const step = (id: string) => ({ id, type: "assistant" as const, content: [{ type: "text" as const, text: id }], finish: "stop", time: { created: 1, completed: 1 } });
  const marked = backend["markAnswers"]([step(block(0)), step(block(1)), step("assistant-plain")]);
  expect(marked.map(record => record.type === "assistant" && [record.answer, record.nativeMessage])).toEqual([
    [true, "msg_quiet"], [true, "msg_quiet"], [undefined, undefined],
  ]);
});

test("a failed run that ran a tool reports tool evidence through messages(), so the router never retries it", async () => {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 29) + tick++ * 1000).toISOString();
  const control = fakeControl();
  const backend = control.backend();
  const { id, directory } = await backend.createChat();
  const prompt = `msg_${"b".repeat(64)}`;
  await backend.prompt(id, directory, prompt, "check the board", "", [], { providerID: "opus", modelID: "claude-opus-5-5", variant: "high" });
  // The run made a tool call (step finish `tool-calls`), then a second step errored.
  const toolStep = `message:provider:opencode:native-item:${encodeURIComponent("msg_tool:text:0")}`;
  const errorStep = `message:provider:opencode:native-item:${encodeURIComponent("msg_err:text:0")}`;
  control.threads.get(id)!.messages.push(
    { messageId: toolStep, runId: control.threads.get(id)!.runs.at(-1)!.runId, role: "assistant", text: "Checking.", streaming: false, createdBy: "agent", createdAt: now(), updatedAt: now() },
    { messageId: errorStep, runId: control.threads.get(id)!.runs.at(-1)!.runId, role: "assistant", text: "", streaming: false, createdBy: "agent", createdAt: now(), updatedAt: now() },
  );
  control.finishes.set(toolStep, "tool-calls");
  control.finishes.set(errorStep, "error");
  control.threads.get(id)!.runs.at(-1)!.status = "failed";
  const records = await backend.messages(id, directory);
  const replies = records.filter(record => record.type === "assistant");
  expect(replies.map(record => record.type === "assistant" && record.toolEvidence)).toEqual(["ran", "unknown"]);
  expect(turnRanTools(records)).toBe(true);
});

test("a failed run whose steps all stopped with no tool is classified tool-free, so it may be retried", async () => {
  const now = () => new Date().toISOString();
  const control = fakeControl();
  const backend = control.backend();
  const { id, directory } = await backend.createChat();
  const prompt = `msg_${"c".repeat(64)}`;
  await backend.prompt(id, directory, prompt, "hello", "", [], { providerID: "opus", modelID: "claude-opus-5-5", variant: "high" });
  const step = `message:provider:opencode:native-item:${encodeURIComponent("msg_stop:text:0")}`;
  control.threads.get(id)!.messages.push({ messageId: step, runId: control.threads.get(id)!.runs.at(-1)!.runId, role: "assistant", text: "", streaming: false, createdBy: "agent", createdAt: now(), updatedAt: now() });
  control.finishes.set(step, "stop");
  control.threads.get(id)!.runs.at(-1)!.status = "failed";
  const records = await backend.messages(id, directory);
  expect(turnRanTools(records)).toBe(false);
});

test("a background run's answer before two steered texts reaches the chat along with the last one", async () => {
  // 22 Oct, Home group: a finished delegated task woke the thread, Robob said the
  // car was booked, two of Moni's texts were steered in, and only the next answer
  // went out. Control lists the steered texts first (sent time), so order alone can't tell.
  const control = fakeControl();
  const backend = control.backend();
  const store = new Store(":memory:");
  stores.push(store);
  const transport: Pick<Photon, "typing" | "read" | "downloadAttachment"> = {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
  };
  const router = new Router(store, backend, transport, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/private/test/skill.md",
    alertSkillPath: "/private/test/alert.md", alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent", quietMs: 0, watchMs: 0,
  });
  store.acceptInbound("in-1", { id: "in-1", text: "Book a car for 11:50", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  const route = store.get<{ id: string }>("route")!;
  control.reply(route.id, "On it, booking now.");
  await router.tick();
  expect(store.get("activeTurn")).toBeNull();
  const thread = control.threads.get(route.id)!;
  const runId = `run:thread:${thread.threadId}:ordinal:2`;
  const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
  const native = (id: string) => `message:provider:opencode:native-item:${encodeURIComponent(`${id}:text:0`)}`;
  thread.runs.push({ runId, ordinal: 2, status: "completed" });
  thread.messages.push(
    { messageId: "wake", runId, role: "user", text: "Delegated task finished", streaming: false, createdBy: "agent", createdAt: at(1), updatedAt: at(1) },
    { messageId: native("msg_check"), runId, role: "assistant", text: "Checking the booking status.", streaming: false, createdBy: "agent", createdAt: at(1.5), updatedAt: at(1.5) },
    { messageId: `${sentMessagePrefix(thread.threadId)}steer-1`, runId, role: "user", text: "Moni: Robob can u draft a message for this pls", streaming: false, createdBy: "system", createdAt: at(2), updatedAt: at(2) },
    { messageId: `${sentMessagePrefix(thread.threadId)}steer-2`, runId, role: "user", text: "Moni: (reply) okay what?", streaming: false, createdBy: "system", createdAt: at(3), updatedAt: at(3) },
    { messageId: native("msg_booked"), runId, role: "assistant", text: "Wheely's booked for tomorrow at 11:50.", streaming: false, createdBy: "agent", createdAt: at(4), updatedAt: at(4) },
    { messageId: native("msg_draft"), runId, role: "assistant", text: "Here's the draft for the clinic.", streaming: false, createdBy: "agent", createdAt: at(5), updatedAt: at(6) },
  );
  control.finishes.set(native("msg_check"), "tool-calls");
  control.finishes.set(native("msg_booked"), "stop");
  control.finishes.set(native("msg_draft"), "stop");
  for (let i = 0; i < 4; i++) await router.tick();
  const replies = store.pendingOutbox().filter(item => item.kind === "conversation").map(item => [item.id, item.text]);
  expect(replies).toEqual([
    [expect.stringMatching(/^reply:1:assistant-/), "On it, booking now."],
    [`reply:1:${native("msg_booked")}`, "Wheely's booked for tomorrow at 11:50."],
    [`reply:1:${native("msg_draft")}`, "Here's the draft for the clinic."],
  ]);
  // Narration (a step that went on to call tools) stays out, and each step's
  // finish is looked up once however often the router polls.
  expect(control.lookups.flat().filter(id => id === native("msg_booked"))).toHaveLength(1);
  expect(store.get("activeTurn")).toBeNull();
});
