import { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendKind } from "../src/backend.ts";
import { discoverControlConfig, parseSse, questionFrom, type ControlMessage, type PendingRequest } from "../src/control.ts";
import type { NormalizedInbound, Photon } from "../src/photon.ts";
import { GUIDANCE_END, GUIDANCE_START, recordsFromThread, retireUnresolvedRoute, RobobBackend, SELECTED_MODEL_ISSUE, sentMessagePrefix, withoutGuidance } from "../src/robob.ts";
import { opencodeRunEvidence } from "../src/opencode-steps.ts";
import { imessagePreferences } from "../src/preferred-model.ts";
import { Router, turnRanTools } from "../src/router.ts";
import { Store } from "../src/store.ts";
import { firstTurnAlert } from "../src/telegram-fallback.ts";

const inbounds = (store: Store) => store.db.query<{ id: string; state: string }, []>("SELECT id, state FROM inbound ORDER BY rowid").all();
const wakeBody = (title = "Daily board") => `[Watcher event from robob-watch daily-backlog, not typed by the owner. Handle it; reply only if the owner needs to know or act now, otherwise log it to the activity log and end with NO_REPLY.]\n${title}\n\nEvent:\nWORKING #5`;

type Thread = {
  threadId: string; projectId: string; title: string; origin: string | null; runtimeMode: string;
  worktreePath: string | null; parentThreadId: string | null; nativeSessionId: string | null;
  runs: Array<{ runId: string; ordinal: number; status: string; requestedAt?: string }>;
  messages: ControlMessage[]; pending: PendingRequest[]; lastError: string | null; settled?: boolean;
  /** What the run-evidence route reports per run; absent means `unknown`. */
  evidence?: Record<string, "ran" | "none" | "unknown">;
  /** The thread's driver; absent means OpenCode, the driver the OpenCode fixtures represent. */
  driver?: { instanceId: string; model: string };
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
  const flags = { ignoreSettled: false, recentRunsLimit: Infinity };
  const projects = [{ projectId: "chats", title: "iMessage", workspaceRoot: "/chats" }];
  let counter = 0;
  const now = () => new Date(Date.now() + counter++).toISOString();
  const state = (thread: Thread) => thread.pending.length ? "needs-input"
    : thread.runs.some(run => run.status === "running") ? "running" : thread.runs.some(run => run.status === "waiting") ? "waiting" : "idle";
  const summary = (thread: Thread) => ({
    threadId: thread.threadId, projectId: thread.projectId, title: thread.title, state: state(thread), status: thread.runs.at(-1)?.status ?? "idle",
    // The driver decides the OpenCode fallback. Fixtures default to OpenCode, the driver their step rows come from.
    model: thread.driver ?? { instanceId: "opencode", model: "opencode-test" },
    origin: thread.origin, nativeSessionId: thread.nativeSessionId, runtimeMode: thread.runtimeMode, parentThreadId: thread.parentThreadId,
    rootThreadId: thread.parentThreadId ?? thread.threadId, worktreePath: thread.worktreePath, latestRunId: thread.runs.at(-1)?.runId ?? null,
    pendingRequest: thread.pending[0] ? { requestId: thread.pending[0].requestId, kind: thread.pending[0].kind, requestKind: thread.pending[0].requestKind } : null,
    lastError: thread.lastError, settled: thread.settled ?? false, createdAt: now(), updatedAt: now(),
  });
  const detail = (thread: Thread) => ({ ...summary(thread), run: thread.runs.at(-1) ?? null, recentRuns: [...thread.runs].reverse().slice(0, flags.recentRunsLimit), pendingRequests: thread.pending });
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
      if (thread && parts[2] === "runs" && parts[4] === "evidence") {
        const runId = parts[3]!;
        const run = thread.runs.find(candidate => candidate.runId === runId);
        if (!run) return notFound();
        const forced = thread.evidence?.[runId];
        const messages = thread.messages.filter(message => message.runId === runId && message.role === "assistant")
          .map(message => ({ id: message.messageId, phase: message.phase ?? "unknown", text: message.text.slice(0, 200) }));
        return ok({ runId, status: run.status, toolEvidence: forced ?? "unknown", complete: forced === "none", messages });
      }
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
          thread.runs.push({ runId, ordinal: thread.runs.length + 1, status: "running", requestedAt: now() });
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
  const backend = (chatRoot = "/chats", extra: Partial<ConstructorParameters<typeof RobobBackend>[0]> = {}) => new RobobBackend({ chatRoot, url, token: "test-token", model: async () => ({ providerID: "opus", modelID: "claude-opus-5-5", variant: "high" }),
    ...extra,
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
  expect(post.body).toMatchObject({ directory: created.directory, origin: "imessage", runtimeMode: "full-access", model: "opus/claude-opus-5-5", variant: "high", providerInstanceId: "opencode" });
  expect(post.auth).toBe("Bearer test-token");
});

test("createChat and prompt name the OpenCode instance for the current provider/model config", async () => {
  // Robob's default may sit on another instance (claudeAgent); without the instance the thread lands there and fails.
  const configRoot = mkdtempSync(join(tmpdir(), "robob-pref-"));
  dirs.push(configRoot);
  writeFileSync(join(configRoot, "opencode.jsonc"), `{ "imessage": { "model": "opus/claude-opus-5-5", "variant": "high" } }`);
  const control = fakeControl();
  const backend = control.backend("/chats", { model: async () => (await imessagePreferences(configRoot)).model });
  const { id, directory } = await backend.createChat();
  await backend.prompt(id, directory, `msg_${"b".repeat(64)}`, "hello", "", [], (await imessagePreferences(configRoot)).model);
  const create = control.calls.find(call => call.method === "POST" && call.path === "/threads")!;
  const send = control.calls.find(call => call.path.endsWith("/send"))!;
  for (const body of [create.body, send.body]) {
    expect(body).toMatchObject({ model: "opus/claude-opus-5-5", variant: "high", providerInstanceId: "opencode" });
  }
});

test("an explicit claudeAgent preference sends its instance and the slashless model id", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "robob-pref-"));
  dirs.push(configRoot);
  writeFileSync(join(configRoot, "opencode.jsonc"), `{ "imessage": { "instanceId": "claudeAgent", "model": "claude-opus-5-5", "variant": "high" } }`);
  const control = fakeControl();
  const model = (await imessagePreferences(configRoot)).model;
  const backend = control.backend("/chats", { model: async () => model });
  const { id, directory } = await backend.createChat();
  await backend.prompt(id, directory, `msg_${"c".repeat(64)}`, "hello", "", [], model);
  const create = control.calls.find(call => call.method === "POST" && call.path === "/threads")!;
  const send = control.calls.find(call => call.path.endsWith("/send"))!;
  for (const body of [create.body, send.body]) {
    expect(body).toMatchObject({ model: "claude-opus-5-5", variant: "high", providerInstanceId: "claudeAgent" });
  }
});

test("a new thread's failed first turn raises one alert, never again and never for a later turn", async () => {
  const control = fakeControl();
  const alerts: Array<[string, string]> = [];
  const backend = control.backend("/chats", { alert: async (threadId, text) => { alerts.push([threadId, text]); return true; } });
  const { id, directory } = await backend.createChat();
  await backend.prompt(id, directory, `msg_${"d".repeat(64)}`, "hello", "", []);
  // Still running: nothing to judge yet.
  await backend.messages(id, directory);
  expect(alerts).toEqual([]);
  control.reply(id, "There's an issue with the selected model (opus/claude-opus-5-5). It may not exist or you may not have access to it.", "completed");
  await backend.messages(id, directory);
  await backend.messages(id, directory);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]![0]).toBe(id);
  expect(alerts[0]![1]).toContain("failed its first turn");
  expect(alerts[0]![1]).toContain("issue with the selected model");
  // A later failed turn on the same thread stays quiet.
  await backend.prompt(id, directory, `msg_${"e".repeat(64)}`, "again", "", []);
  control.threads.get(id)!.lastError = "model returned 400";
  control.reply(id, "", "failed");
  await backend.messages(id, directory);
  expect(alerts).toHaveLength(1);
});

test("a failed first run with lastError alerts once; a good first turn never alerts", async () => {
  const control = fakeControl();
  const alerts: string[] = [];
  const backend = control.backend("/chats", { alert: async threadId => { alerts.push(threadId); return true; } });
  const bad = await backend.createChat();
  await backend.prompt(bad.id, bad.directory, `msg_${"f".repeat(64)}`, "hello", "", []);
  const thread = control.threads.get(bad.id)!;
  thread.runs.at(-1)!.status = "failed";
  thread.lastError = "model returned 400";
  await backend.messages(bad.id, bad.directory);
  await backend.messages(bad.id, bad.directory);
  expect(alerts).toEqual([bad.id]);
  const good = await backend.createChat();
  await backend.prompt(good.id, good.directory, `msg_${"0".repeat(64)}`, "hello", "", []);
  control.reply(good.id, "Morning. All set.");
  await backend.messages(good.id, good.directory);
  // Its second turn fails, but only a first turn is judged.
  await backend.prompt(good.id, good.directory, `msg_${"1".repeat(64)}`, "again", "", []);
  control.threads.get(good.id)!.lastError = "model returned 400";
  control.reply(good.id, "", "failed");
  await backend.messages(good.id, good.directory);
  expect(alerts).toEqual([bad.id]);
  // A thread the backend did not create (a stored route from before a restart) is never judged.
  const other = control.backend("/chats", { alert: async threadId => { alerts.push(threadId); return true; } });
  await other.messages(bad.id, bad.directory);
  expect(alerts).toEqual([bad.id]);
});

test.each(["owner", "forChat"])("%s first-turn failures send one attention alert and one honest chat notice", async routeKind => {
  const control = fakeControl();
  const posts: Array<{ path: string; body: Record<string, string> }> = [];
  const root = control.backend("/chats", { alert: firstTurnAlert(async (path, body) => { posts.push({ path, body }); return 202; }) });
  const backend = routeKind === "forChat" ? root.forChat("chats/test-person", "Test person") : root;
  const store = new Store(":memory:");
  stores.push(store);
  backend.trackFirstTurns(store);
  const router = new Router(store, backend, {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
  }, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/private/test/skill.md",
    alertSkillPath: "/private/test/alert.md", alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent", quietMs: 0,
  });
  store.acceptInbound("first", { id: "first", text: "hello", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  const { id } = store.get<{ id: string }>("route")!;
  const thread = control.threads.get(id)!;
  thread.driver = { instanceId: "claudeAgent", model: "opus/claude-opus-5-5" };
  control.reply(id, "Starting up", "running");
  control.reply(id, "There's an issue with the selected model (opus/claude-opus-5-5).", "completed");
  thread.lastError = "Claude gave up after repeated API errors.";
  await router.tick();
  await router.tick();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ path: "/notify", body: { source: "iMessage bridge", severity: "attention", dedupeKey: `${id}:first-turn-failed` } });
  for (const value of [thread.title, id, thread.driver.model, thread.driver.instanceId, thread.lastError]) expect(posts[0]!.body.text).toContain(value);
  expect(store.pendingOutbox().filter(item => item.kind === "conversation")).toEqual([]);
  expect(store.pendingOutbox().filter(item => item.kind === "control").map(item => item.text)).toEqual([
    "The chat's model isn't available, so I couldn't process that message. Resending it won't fix this.",
  ]);
  expect(inbounds(store)).toEqual([{ id: "first", state: "failed" }]);
  expect(control.calls.filter(call => call.path.endsWith("/send"))).toHaveLength(1);
});

test.each([
  { status: "failed", error: null, text: "" },
  { status: "completed", error: "Provider failed", text: "" },
  { status: "completed", error: null, text: "There's an issue with the selected model (bad)." },
])("first-turn error form %j is failed evidence even without assistant text", async failure => {
  const control = fakeControl();
  const alerts: string[] = [];
  const backend = control.backend("/chats", { alert: async (_id, text) => { alerts.push(text); return true; } });
  const chat = await backend.createChat();
  await backend.prompt(chat.id, chat.directory, `msg_${"2".repeat(64)}`, "hi");
  const thread = control.threads.get(chat.id)!;
  thread.runs[0]!.status = failure.status;
  thread.lastError = failure.error;
  if (failure.text) control.reply(chat.id, failure.text, failure.status);
  const records = await backend.messages(chat.id, chat.directory);
  expect(alerts).toHaveLength(1);
  expect(records.at(-1)).toMatchObject({ type: "idle", outcome: "failed", firstTurnFailure: true });
  await backend.messages(chat.id, chat.directory);
  expect(alerts).toHaveLength(1);
});

test("first-turn checks survive restart, and a Telegram transport retry keeps the same key without replaying the turn", async () => {
  const control = fakeControl();
  const store = new Store(":memory:");
  stores.push(store);
  const keys: string[] = [];
  const alert = firstTurnAlert(async (_path, body) => { keys.push(body.dedupeKey); return keys.length === 1 ? 503 : 200; });
  const before = control.backend("/chats", { alert });
  before.trackFirstTurns(store);
  const chat = await before.createChat();
  await before.prompt(chat.id, chat.directory, `msg_${"3".repeat(64)}`, "hi");
  control.threads.get(chat.id)!.lastError = "bad model";
  control.reply(chat.id, "", "failed");
  const after = control.backend("/chats", { alert });
  after.trackFirstTurns(store);
  await after.messages(chat.id, chat.directory);
  expect(store.get("firstTurns")).toMatchObject([{ id: chat.id, alert: expect.stringContaining("bad model") }]);
  await after.prompt(chat.id, chat.directory, `msg_${"7".repeat(64)}`, "repaired");
  control.threads.get(chat.id)!.lastError = null;
  control.reply(chat.id, "All set", "completed");
  await after.messages(chat.id, chat.directory);
  await after.messages(chat.id, chat.directory);
  expect(keys).toEqual([`${chat.id}:first-turn-failed`, `${chat.id}:first-turn-failed`]);
  expect(store.get<string[]>("firstTurns")).toEqual([]);
  expect(control.calls.filter(call => call.path.endsWith("/send"))).toHaveLength(2);
});

test("overlapping first-turn reads share one in-flight alert", async () => {
  const control = fakeControl();
  let finish!: (accepted: boolean) => void;
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  let started!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; });
  let alerts = 0;
  const backend = control.backend("/chats", { alert: async () => { alerts++; started(); return pending; } });
  const chat = await backend.createChat();
  await backend.prompt(chat.id, chat.directory, `msg_${"8".repeat(64)}`, "hi");
  control.reply(chat.id, "", "failed");
  const first = backend.messages(chat.id, chat.directory);
  await sending;
  await backend.messages(chat.id, chat.directory);
  expect(alerts).toBe(1);
  finish(true);
  await first;
  await backend.messages(chat.id, chat.directory);
  expect(alerts).toBe(1);
});

test.each([
  ["There's an issue with the selected model (bad). It may not exist.", true],
  ["There’s an issue with the selected model (bad).", true],
  ["There is an issue with the selected model (bad).", true],
  ["I fixed the issue with the selected model; everything is working now.", false],
  ['The error was "There\'s an issue with the selected model (bad)." It is fixed.', false],
  ['"There\'s an issue with the selected model (bad)."', false],
  ["No issue with the selected model now.", false],
])("selected-model diagnostic form %s matches %s", (text, expected) => {
  expect(SELECTED_MODEL_ISSUE.test(text as string)).toBe(expected);
});

test.each([200, 202, 400, 409, 500, 503, undefined])("first-turn alert accepts only durable Telegram acceptance (%s)", async status => {
  expect(await firstTurnAlert(async () => status)("thread", "failed")).toBe(status === 200 || status === 202);
});

test("an alert held during an outage drains after route replacement and restart", async () => {
  const control = fakeControl();
  const store = new Store(":memory:");
  stores.push(store);
  const posted: string[] = [];
  const before = control.backend("/chats", { alert: firstTurnAlert(async () => 503) });
  before.trackFirstTurns(store);
  const old = await before.createChat();
  await before.prompt(old.id, old.directory, `msg_${"9".repeat(64)}`, "hi");
  control.reply(old.id, "", "failed");
  await before.messages(old.id);
  const current = await before.createChat();
  const after = control.backend("/chats", { alert: firstTurnAlert(async (_path, body) => { posted.push(body.dedupeKey); return 202; }) });
  after.trackFirstTurns(store);
  await after.messages(current.id);
  await after.messages(current.id);
  expect(posted).toEqual([`${old.id}:first-turn-failed`]);
  expect(store.get("firstTurns")).toMatchObject([{ id: current.id, alert: null }]);
});

test.each([
  { status: "completed", laterRuns: 1 },
  { status: "failed", laterRuns: 1 },
  { status: "completed", laterRuns: 5 },
])("a first-turn model complaint before queued steers (%j) is replaced with one notice, not forwarded", async ({ status, laterRuns }) => {
  const control = fakeControl();
  control.flags.recentRunsLimit = 5;
  const alerts: string[] = [];
  const backend = control.backend("/chats", { alert: async (id, text) => { alerts.push(text); return true; } });
  const store = new Store(":memory:");
  stores.push(store);
  const router = new Router(store, backend, {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
  }, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/private/test/skill.md",
    alertSkillPath: "/private/test/alert.md", alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent", quietMs: 0,
  });
  store.acceptInbound("first", { id: "first", text: "hi", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  const chat = store.get<{ id: string; directory: string }>("route")!;
  control.reply(chat.id, "There's an issue with the selected model (bad).", "completed");
  const steered: string[] = [];
  for (let i = 0; i < laterRuns; i++) {
    const steer = `msg_${String(i).repeat(64)}`;
    steered.push(steer);
    await backend.prompt(chat.id, chat.directory, steer, "second");
    control.reply(chat.id, "This reply worked", i === laterRuns - 1 ? status : "completed");
  }
  store.set("activeTurn", { ...store.get<object>("activeTurn"), steered, steeredAt: Date.now() });
  await router.tick();
  await router.tick();
  expect(store.pendingOutbox().filter(item => item.kind === "conversation").map(item => item.text)).toEqual(status === "completed" ? Array(laterRuns).fill("This reply worked") : []);
  expect(store.pendingOutbox().filter(item => item.kind === "control").map(item => item.text)).toEqual([
    "The chat's model isn't available, so I couldn't process that message. Resending it won't fix this.",
  ]);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("failed its first turn");
});

test("a successful first turn stays successful when an unobserved later turn fails", async () => {
  const control = fakeControl();
  const alerts: string[] = [];
  const backend = control.backend("/chats", { alert: async id => { alerts.push(id); return true; } });
  const chat = await backend.createChat();
  await backend.prompt(chat.id, chat.directory, `msg_${"4".repeat(64)}`, "hi");
  control.reply(chat.id, "All set", "completed");
  await backend.prompt(chat.id, chat.directory, `msg_${"5".repeat(64)}`, "again");
  control.threads.get(chat.id)!.lastError = "later failure";
  control.reply(chat.id, "", "failed");
  const records = await backend.messages(chat.id, chat.directory);
  expect(alerts).toEqual([]);
  expect(records.filter(record => record.type === "idle").map(record => record.outcome)).toEqual(["succeeded", "failed"]);
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
  expect(sends[0]!.body).toMatchObject({ mode: "auto", clientRequestId: prompt, model: "opus/claude-opus-5-5", variant: "high", providerInstanceId: "opencode" });
  // No preference on the turn sends no model fields at all, so the thread keeps its own.
  expect(sends[1]!.body).not.toHaveProperty("providerInstanceId");
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

test("records: a Robob phase decides answer vs narration; no finish is invented for a settled message", () => {
  const at = "2026-01-01T00:00:00Z";
  const messages: ControlMessage[] = [
    { messageId: "narrate", runId: "run:thread:t:ordinal:1", role: "assistant", phase: "narration", text: "Checking the calendar.", streaming: false, createdAt: at, updatedAt: at },
    { messageId: "reply", runId: "run:thread:t:ordinal:1", role: "assistant", phase: "answer", text: "You're booked.", streaming: false, createdAt: at, updatedAt: at },
    { messageId: "unsure", runId: "run:thread:t:ordinal:1", role: "assistant", text: "Maybe.", streaming: false, createdAt: at, updatedAt: at },
  ];
  const records = recordsFromThread({ threadId: "t", lastError: null, run: null, recentRuns: [
    { runId: "run:thread:t:ordinal:1", ordinal: 1, status: "completed" },
  ] }, messages);
  const steps = records.filter((record): record is Extract<typeof record, { type: "assistant" }> => record.type === "assistant");
  expect(steps.map(step => [step.id, step.answer])).toEqual([["narrate", false], ["reply", true], ["unsure", undefined]]);
  for (const step of steps) expect(step).not.toHaveProperty("finish");
});

test("a Claude thread with a historical ses_ session never reads OpenCode's database for its evidence", async () => {
  const control = fakeControl();
  const { id } = await control.backend().createChat();
  const threadId = await control.backend()["resolve"](id);
  const thread = control.threads.get(threadId)!;
  // A thread that moved from OpenCode keeps its old `ses_` session; its driver is now Claude.
  thread.nativeSessionId = "ses_historical_opencode";
  thread.driver = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  thread.runs.push({ runId: "run:thread:claude:ordinal:1", ordinal: 1, status: "completed", requestedAt: "2026-01-01T00:00:00Z" });
  thread.evidence = { "run:thread:claude:ordinal:1": "unknown" };
  // OpenCode's step rows are read through this reader; a Claude thread must never reach it.
  const reads: string[] = [];
  const backend = control.backend();
  (backend as unknown as { runEvidence: (session: string, since: number) => "none" }).runEvidence = session => {
    reads.push(session);
    return "none";
  };
  expect(await backend.runToolEvidence(id, "/chats", Date.parse("2026-01-01T00:00:00Z") - 1000)).toBe("unknown");
  expect(reads).toEqual([]);
});

test("a long thread asks Robob for evidence only for the runs on the page, and a settled run once", async () => {
  const control = fakeControl();
  const { id } = await control.backend().createChat();
  const threadId = await control.backend()["resolve"](id);
  const thread = control.threads.get(threadId)!;
  thread.evidence = {};
  for (let ordinal = 1; ordinal <= 100; ordinal++) {
    const runId = `run:thread:${threadId}:ordinal:${ordinal}`;
    thread.runs.push({ runId, ordinal, status: "completed", requestedAt: new Date(Date.UTC(2026, 0, 1, 0, ordinal)).toISOString() });
    // The prompt is written before the answer, as in a real run, so the answer sorts after it.
    const asked = new Date(Date.UTC(2026, 0, 1, 0, ordinal, 0)).toISOString();
    const answered = new Date(Date.UTC(2026, 0, 1, 0, ordinal, 1)).toISOString();
    thread.messages.push({ messageId: `user-${ordinal}`, runId, role: "user", text: `question ${ordinal}`, streaming: false, createdBy: "user", createdAt: asked, updatedAt: asked });
    thread.messages.push({ messageId: `assistant-${ordinal}`, runId, role: "assistant", text: `answer ${ordinal}`, streaming: false, createdBy: "agent", createdAt: answered, updatedAt: answered });
    thread.evidence[runId] = "none";
  }
  // The cache is per backend instance, so both polls use the same one, as the router does.
  const backend = control.backend();
  const evidenceReads = () => control.calls.filter(call => call.path.includes("/evidence")).length;
  // The newest page is the last run's answer and its idle marker: one run, one read.
  expect((await backend.messages(id, "/chats", { limit: 2 })).filter(record => record.type === "assistant")).toHaveLength(1);
  expect(evidenceReads()).toBe(1);
  // Polled again, the settled run's proof is kept rather than asked for again.
  await backend.messages(id, "/chats", { limit: 2 });
  expect(evidenceReads()).toBe(1);
});

test("a run's tool evidence from Robob reaches its steps; unknown never becomes none", async () => {
  const control = fakeControl();
  const { id, directory } = await control.backend().createChat();
  const threadId = await control.backend()["resolve"](id);
  const thread = control.threads.get(threadId)!;
  const run = (runId: string) => ({ runId, ordinal: thread.runs.length + 1, status: "completed", requestedAt: "2026-01-01T00:00:00Z" });
  const at = "2026-01-01T00:00:01Z";
  thread.runs.push(run("run:a"), run("run:b"), run("run:c"));
  thread.messages.push(
    { messageId: "a-1", runId: "run:a", role: "assistant", phase: "answer", text: "done", streaming: false, createdAt: at, updatedAt: at },
    { messageId: "b-1", runId: "run:b", role: "assistant", phase: "narration", text: "checking", streaming: false, createdAt: at, updatedAt: at },
    { messageId: "c-1", runId: "run:c", role: "assistant", text: "unsure", streaming: false, createdAt: at, updatedAt: at },
  );
  thread.evidence = { "run:a": "none", "run:b": "ran", "run:c": "unknown" };
  const records = await control.backend().messages(id, directory);
  const step = (messageId: string) => records.find(record => record.id === messageId && record.type === "assistant") as Extract<(typeof records)[number], { type: "assistant" }> | undefined;
  expect(step("a-1")?.toolEvidence).toBe("none");
  expect(step("b-1")?.toolEvidence).toBe("ran");
  expect(step("c-1")?.toolEvidence).toBe("unknown");
  expect(step("a-1")?.answer).toBe(true);
  expect(step("b-1")?.answer).toBe(false);
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
  // An OpenCode thread: its native session is what OpenCode's step rows are read from.
  control.threads.get(id)!.nativeSessionId = "ses_tool_run";
  const records = await backend.messages(id, directory);
  const replies = records.filter(record => record.type === "assistant");
  expect(replies.map(record => record.type === "assistant" && record.toolEvidence)).toEqual(["ran", "unknown"]);
  expect(turnRanTools(records)).toBe(true);
});

test("a failed run whose steps all stopped with no tool is classified tool-free, so it may be retried", async () => {
  const now = () => new Date().toISOString();
  const control = fakeControl();
  // Tool-free needs native proof (run rows), not just a `stop` finish on a text step.
  const backend = new RobobBackend({ chatRoot: "/chats", url: control.url, token: "test-token", model: async () => undefined,
    finishes: ids => new Map(ids.map(id => [id, "stop"] as const)), runEvidence: () => "none" });
  const { id, directory } = await backend.createChat();
  const prompt = `msg_${"c".repeat(64)}`;
  await backend.prompt(id, directory, prompt, "hello", "", [], { providerID: "opus", modelID: "claude-opus-5-5", variant: "high" });
  const step = `message:provider:opencode:native-item:${encodeURIComponent("msg_stop:text:0")}`;
  control.threads.get(id)!.messages.push({ messageId: step, runId: control.threads.get(id)!.runs.at(-1)!.runId, role: "assistant", text: "", streaming: false, createdBy: "agent", createdAt: now(), updatedAt: now() });
  control.threads.get(id)!.runs.at(-1)!.status = "failed";
  control.threads.get(id)!.nativeSessionId = "ses_native_stop";
  const records = await backend.messages(id, directory);
  expect(turnRanTools(records)).toBe(false);
});

test("a tool-only run with no text still counts as having run a tool, so an interrupted turn is never retried", async () => {
  const control = fakeControl();
  const sawDb: string[][] = [];
  const backend = new RobobBackend({ chatRoot: "/chats", url: control.url, token: "test-token", model: async () => undefined,
    finishes: () => new Map(),
    runEvidence: (session, since) => { sawDb.push([session, String(since)]); return "ran"; } });
  const { id, directory } = await backend.createChat();
  const prompt = `msg_${"d".repeat(64)}`;
  await backend.prompt(id, directory, prompt, "run the check", "", [], { providerID: "opus", modelID: "claude-opus-5-5", variant: "high" });
  // The run called a tool and was interrupted: Robob has no text record for it at all.
  const thread = control.threads.get(id)!;
  thread.nativeSessionId = "ses_native_tool";
  thread.runs.at(-1)!.status = "interrupted";
  expect(await backend.runToolEvidence(id, directory, Date.parse("2026-10-29T00:00:00Z"))).toBe("ran");
  expect(sawDb[0]![0]).toBe("ses_native_tool");
});

test("a first-call provider error with no native evidence is unproven, so it is reported once and never retried", async () => {
  const control = fakeControl();
  const backend = new RobobBackend({ chatRoot: "/chats", url: control.url, token: "test-token", model: async () => undefined,
    finishes: () => new Map(), runEvidence: () => "unknown" });
  const { id, directory } = await backend.createChat();
  await backend.prompt(id, directory, `msg_${"e".repeat(64)}`, "hello", "", [], { providerID: "opus", modelID: "claude-opus-5-5", variant: "high" });
  // Robob's record of a 400 on the very first call: the run settled failed, no text, lastError set.
  const thread = control.threads.get(id)!;
  thread.nativeSessionId = "ses_native_400";
  thread.runs.at(-1)!.status = "failed";
  thread.lastError = "model returned 400";
  expect(await backend.runToolEvidence(id, directory, Date.parse("2026-10-29T00:00:00Z"))).toBe("unknown");
});

test("a first-call provider error with positive no-tool evidence is classified tool-free, so it may be retried", async () => {
  const control = fakeControl();
  const backend = new RobobBackend({ chatRoot: "/chats", url: control.url, token: "test-token", model: async () => undefined,
    finishes: () => new Map(), runEvidence: () => "none" });
  const { id, directory } = await backend.createChat();
  await backend.prompt(id, directory, `msg_${"f".repeat(64)}`, "hello", "", [], { providerID: "opus", modelID: "claude-opus-5-5", variant: "high" });
  const thread = control.threads.get(id)!;
  thread.nativeSessionId = "ses_native_none";
  thread.runs.at(-1)!.status = "failed";
  thread.lastError = "model returned 400";
  expect(await backend.runToolEvidence(id, directory, Date.parse("2026-10-29T00:00:00Z"))).toBe("none");
});

/** A real Robob backend, the real OpenCode run-row reader on `path`, and a router over them. */
function nativeRouter(path: string) {
  const control = fakeControl();
  const backend = new RobobBackend({ chatRoot: "/chats", url: control.url, token: "test-token", model: async () => undefined,
    finishes: () => new Map(), runEvidence: opencodeRunEvidence(path) });
  const store = new Store(":memory:");
  stores.push(store);
  const transport: Pick<Photon, "typing" | "read" | "downloadAttachment"> = {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
  };
  const router = new Router(store, backend, transport, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/private/test/skill.md",
    alertSkillPath: "/private/test/alert.md", alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent", quietMs: 0,
    droppedBatchMs: 0,
  });
  return { control, store, router };
}

/** An OpenCode DB at a temp path with one session's rows, written before the test starts. */
function nativeDb(session: string, rows: [string, unknown][]) {
  const dirPath = mkdtempSync(join(tmpdir(), "robob-native-"));
  dirs.push(dirPath);
  const path = join(dirPath, "opencode.db");
  const db = new Database(path);
  db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
  // Rows are written after the run starts (the run's requestedAt is `base`), as native execution would write them.
  const base = Date.now();
  rows.forEach(([id, data], index) => db.query("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, ?, ?)").run(id, session, index, base + 5_000 + index, JSON.stringify(data)));
  // The run has settled: OpenCode wrote its idle marker after the steps.
  db.query("INSERT INTO session_message VALUES (?, ?, 'idle', ?, ?, ?)").run(`idle_${session}`, session, rows.length, base + 10_000, JSON.stringify({ outcome: "failed" }));
  db.close();
  return { path, base };
}

/** Drives one wake to a settled failed run on `session`, then returns the router's state after the given offsets. */
async function failedWake(path: string, session: string, base: number, offsetsMs: number[]) {
  const { control, store, router } = nativeRouter(path);
  setSystemTime(base);
  const wake = `wake:${session.slice(-8).padEnd(64, "0")}`;
  store.acceptInbound(wake, { id: wake, text: wakeBody(), attachments: [], isAudioMessage: false, source: "typed", receivedAt: base } satisfies NormalizedInbound);
  await router.tick();
  const route = store.get<{ id: string }>("route")!;
  const thread = control.threads.get(route.id)!;
  thread.nativeSessionId = session;
  thread.lastError = "model returned 400";
  thread.runs.at(-1)!.status = "failed";
  await router.tick();
  const states: string[] = [];
  states.push(inbounds(store).find(row => row.id === wake)?.state ?? "missing");
  for (const offset of offsetsMs) {
    setSystemTime(base + offset);
    await router.tick();
    states.push(inbounds(store).find(row => row.id === wake)?.state ?? "missing");
  }
  return { control, store, router, states, sends: () => control.calls.filter(call => call.path.endsWith("/send")).length };
}

test("an errored step classified between OpenCode's commits, before the native idle marker, is never retried, even when execution later completes a tool", async () => {
  // Between the two native commits: the step is `error` with no retry yet and the run has no idle marker.
  const dirPath = mkdtempSync(join(tmpdir(), "robob-between-"));
  dirs.push(dirPath);
  const path = join(dirPath, "opencode.db");
  const base = Date.now();
  const db = new Database(path);
  db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
  db.query("INSERT INTO session_message VALUES ('msg_between', 'ses_between', 'assistant', 0, ?, ?)").run(base + 5_000, JSON.stringify({ finish: "error", content: [{ type: "text", text: "partial" }], error: { type: "provider.internal" } }));
  db.close();
  const first = await failedWake(path, "ses_between", base, []);
  // No idle marker yet: the run is between OpenCode's commits, so it is unsettled and the wake is not retried.
  expect(first.states).toEqual(["failed"]);
  expect(first.sends()).toBe(1);
  // Execution carries on: retry.scheduled lands, then a tool completes, then the run settles idle.
  const later = new Database(path);
  later.query("UPDATE session_message SET data = ? WHERE id = ?").run(JSON.stringify({ finish: "error", content: [{ type: "text", text: "partial" }], retry: { attempt: 2, at: base + 120_000 }, error: { type: "provider.internal" } }), "msg_between");
  later.query("INSERT INTO session_message VALUES ('msg_tool', 'ses_between', 'assistant', 1, ?, ?)").run(base + 60_000, JSON.stringify({ finish: "tool-calls", content: [{ type: "tool", id: "t", name: "bash", state: { status: "completed" } }] }));
  later.query("INSERT INTO session_message VALUES ('idle_ses_between', 'ses_between', 'idle', 2, ?, ?)").run(base + 90_000, JSON.stringify({ outcome: "succeeded" }));
  later.close();
  setSystemTime(base + 120_000);
  await first.router.tick();
  setSystemTime(base + 240_000);
  await first.router.tick();
  expect(first.sends()).toBe(1);
});

test("an error step with a pending native retry is never retried, even when that execution later completes a tool", async () => {
  // OpenCode recorded the first call as an error with text and a pending retry: the execution is not settled.
  const { path, base } = nativeDb("ses_retry_run", [["msg_retry", { finish: "error", content: [{ type: "text", text: "partial" }], retry: { attempt: 2, at: Date.now() + 120_000 }, error: { type: "provider.internal" } }]]);
  const first = await failedWake(path, "ses_retry_run", base, []);
  expect(first.states).toEqual(["failed"]);
  expect(first.sends()).toBe(1);
  // During the backoff the same execution carries on and completes a tool. A terminal step does not prove it stopped.
  const db = new Database(path);
  db.query("UPDATE session_message SET data = ? WHERE id = ?").run(JSON.stringify({ finish: "tool-calls", content: [{ type: "tool", id: "t", name: "bash", state: { status: "completed" } }] }), "msg_retry");
  db.close();
  setSystemTime(base + 120_000);
  await first.router.tick();
  setSystemTime(base + 240_000);
  await first.router.tick();
  expect(first.sends()).toBe(1);
});

test("an unfinished native step is never retried, even when that run later completes a tool", async () => {
  // The first call's row has no finish yet: execution may still be running, so it is not provably tool-free.
  const { path, base } = nativeDb("ses_cont_run", [["msg_open", { content: [] }]]);
  const first = await failedWake(path, "ses_cont_run", base, []);
  // Robob failed the run, but the native row is unfinished: the wake is reported and not retried.
  expect(first.states).toEqual(["failed"]);
  expect(first.sends()).toBe(1);
  // The same native row keeps running and finishes with a tool call. The router must still not send again.
  const db = new Database(path);
  db.query("UPDATE session_message SET data = ? WHERE id = ?").run(JSON.stringify({ finish: "tool-calls", content: [{ type: "tool", id: "t", name: "bash", state: { status: "completed" } }] }), "msg_open");
  db.close();
  setSystemTime(base + 120_000);
  await first.router.tick();
  setSystemTime(base + 240_000);
  await first.router.tick();
  expect(first.sends()).toBe(1);
});

test("a new chat's first-call error with text is reported without replaying the wake", async () => {
  const { path, base } = nativeDb("ses_text_400", [["msg_text", { finish: "error", content: [{ type: "text", text: "partial" }], error: { type: "aborted" } }]]);
  const run = await failedWake(path, "ses_text_400", base, [120_000]);
  expect(run.states).toEqual(["failed", "failed"]);
  expect(run.sends()).toBe(1);
  expect(run.store.pendingOutbox().filter(item => item.kind === "control").map(item => item.text)).toEqual([
    "I couldn't process that message because this chat hit a system error. Please don't resend it yet.",
  ]);
});

test("a new chat's first-call error with reasoning is reported without replaying the wake", async () => {
  const { path, base } = nativeDb("ses_reason_400", [["msg_reason", { finish: "error", content: [{ type: "reasoning", text: "thinking" }], error: { type: "aborted" } }]]);
  const run = await failedWake(path, "ses_reason_400", base, [120_000]);
  expect(run.states).toEqual(["failed", "failed"]);
  expect(run.sends()).toBe(1);
});

test("a run whose tool call sits past a truncated scan is never retried, through the real router and OpenCode's run rows", async () => {
  const dirPath = mkdtempSync(join(tmpdir(), "robob-truncated-"));
  dirs.push(dirPath);
  const path = join(dirPath, "opencode.db");
  // 200 stop steps, then the run's tool step: the tool row is past the old 200-row cap.
  const db = new Database(path);
  db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
  const insert = db.query("INSERT INTO session_message VALUES (?, 'ses_native_long', 'assistant', ?, ?, ?)");
  const base = Date.now();
  for (let i = 0; i < 200; i++) insert.run(`msg_s${i}`, i, base + i, JSON.stringify({ finish: "stop", content: [{ type: "text", text: "ok" }] }));
  insert.run("msg_tool", 200, base + 200, JSON.stringify({ finish: "tool-calls", content: [{ type: "tool", id: "t", name: "bash", state: { status: "completed" } }] }));
  db.close();
  const control = fakeControl();
  const backend = new RobobBackend({ chatRoot: "/chats", url: control.url, token: "test-token", model: async () => undefined,
    finishes: () => new Map(), runEvidence: opencodeRunEvidence(path) });
  const store = new Store(":memory:");
  stores.push(store);
  const transport: Pick<Photon, "typing" | "read" | "downloadAttachment"> = {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
  };
  const router = new Router(store, backend, transport, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/private/test/skill.md",
    alertSkillPath: "/private/test/alert.md", alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent", quietMs: 0,
    droppedBatchMs: 0,
  });
  const start = base;
  setSystemTime(start);
  const wake = `wake:${"n".repeat(64)}`;
  store.acceptInbound(wake, { id: wake, text: wakeBody(), attachments: [], isAudioMessage: false, source: "typed", receivedAt: start } satisfies NormalizedInbound);
  await router.tick();
  const route = store.get<{ id: string }>("route")!;
  const thread = control.threads.get(route.id)!;
  thread.nativeSessionId = "ses_native_long";
  thread.runs.at(-1)!.status = "interrupted";
  await router.tick();
  expect(inbounds(store).find(row => row.id === wake)?.state).toBe("failed");
  setSystemTime(start + 120_000);
  await router.tick();
  expect(control.calls.filter(call => call.path.endsWith("/send"))).toHaveLength(1);
});

test("a later provider 400 keeps the existing tool-free retry behavior", async () => {
  const dirPath = mkdtempSync(join(tmpdir(), "robob-first-call-"));
  dirs.push(dirPath);
  const path = join(dirPath, "opencode.db");
  // OpenCode's record of the failed first call: finish error, no content, error aborted.
  const db = new Database(path);
  db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
  db.query("INSERT INTO session_message VALUES (?, 'ses_native_400', 'assistant', 0, ?, ?)").run("msg_400", Date.now(), JSON.stringify({ finish: "error", content: [], error: { type: "aborted" } }));
  // The settled run: OpenCode wrote its idle marker after the failed step.
  db.query("INSERT INTO session_message VALUES ('idle_400', 'ses_native_400', 'idle', 1, ?, ?)").run(Date.now() + 1000, JSON.stringify({ outcome: "failed" }));
  db.close();
  const control = fakeControl();
  const backend = new RobobBackend({ chatRoot: "/chats", url: control.url, token: "test-token", model: async () => undefined,
    finishes: () => new Map(), runEvidence: opencodeRunEvidence(path) });
  const store = new Store(":memory:");
  stores.push(store);
  const transport: Pick<Photon, "typing" | "read" | "downloadAttachment"> = {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
  };
  const router = new Router(store, backend, transport, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/private/test/skill.md",
    alertSkillPath: "/private/test/alert.md", alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent", quietMs: 0,
    droppedBatchMs: 0,
  });
  const start = Date.parse("2026-10-29T07:00:11Z");
  setSystemTime(start);
  const prior = await backend.createChat();
  await backend.prompt(prior.id, prior.directory, `msg_${"6".repeat(64)}`, "hi");
  control.reply(prior.id, "All set", "completed");
  store.set("route", { ...prior, generation: 1, createdAt: start, threadAt: start });
  const sendsBefore = control.calls.filter(call => call.path.endsWith("/send")).length;
  const wake = `wake:${"m".repeat(64)}`;
  store.acceptInbound(wake, { id: wake, text: wakeBody(), attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  // The first call was answered 400: the run settles failed, with no text and lastError set.
  const route = store.get<{ id: string }>("route")!;
  const thread = control.threads.get(route.id)!;
  thread.nativeSessionId = "ses_native_400";
  thread.lastError = "model returned 400";
  thread.runs.at(-1)!.status = "failed";
  await router.tick();
  expect(inbounds(store).find(row => row.id === wake)?.state).toBe("pending");
  expect(control.calls.filter(call => call.path.endsWith("/send"))).toHaveLength(sendsBefore + 1);
  setSystemTime(start + 120_000);
  await router.tick();
  expect(control.calls.filter(call => call.path.endsWith("/send"))).toHaveLength(sendsBefore + 2);
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
  // This thread's steps are OpenCode's own messages, so it is an OpenCode thread for the fallback.
  thread.nativeSessionId = "ses_background_answer";
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
