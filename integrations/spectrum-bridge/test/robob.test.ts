import { ActiveRoster } from "../src/active-roster.ts";
import { createToolLog, toolLog } from "../src/toollog.ts";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendKind } from "../src/backend.ts";
import { ControlClient, ControlError, discoverControlConfig, parseSse, questionFrom, type ControlMessage, type PendingRequest } from "../src/control.ts";
import type { NormalizedInbound, Photon } from "../src/photon.ts";
import { GUIDANCE_END, GUIDANCE_START, recordsFromThread, retireUnresolvedRoute, RobobBackend, SELECTED_MODEL_ISSUE, sentMessagePrefix, withoutGuidance } from "../src/robob.ts";
import { opencodeRunEvidence } from "../src/opencode-steps.ts";
import { probeDeferred } from "../src/probe-policy.ts";
import { imessagePreferences } from "../src/preferred-model.ts";
import { Router, turnRanTools } from "../src/router.ts";
import { Store } from "../src/store.ts";
import { firstTurnAlert } from "../src/telegram-fallback.ts";
import { ProbeBudget } from "../src/probe-policy.ts";
import { DETAIL_DEADLINE_MS } from "../src/message-cache.ts";
import { captureLogs } from "./log-fixture.ts";
import type { ChatContext } from "../src/chats.ts";

const inbounds = (store: Store) => store.db.query<{ id: string; state: string }, []>("SELECT id, state FROM inbound ORDER BY rowid").all();
const wakeBody = (title = "Daily board") => `[Watcher event from robob-watch daily-backlog, not typed by the owner. Handle it; reply only if the owner needs to know or act now, otherwise log it to the activity log and end with NO_REPLY.]\n${title}\n\nEvent:\nWORKING #5`;

type Thread = {
  threadId: string; projectId: string; title: string; origin: string | null; runtimeMode: string;
  worktreePath: string | null; parentThreadId: string | null; nativeSessionId: string | null;
  runs: Array<{ runId: string; ordinal: number; status: string; requestedAt?: string }>;
  messages: ControlMessage[]; pending: PendingRequest[]; lastError: string | null; settled?: boolean; archived?: boolean;
  /** What the run-evidence route reports per run; absent means `unknown`. */
  evidence?: Record<string, "ran" | "none" | "unknown">;
  /** The thread's driver; absent means OpenCode, the driver the OpenCode fixtures represent. */
  driver?: { instanceId: string; model: string };
};
type Call = { rows?: number; bytes?: number; method: string; path: string; body?: any; auth: string | null };

const servers: ReturnType<typeof Bun.serve>[] = [];
const stores: Store[] = [];
const dirs: string[] = [];
beforeEach(() => { setSystemTime(); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  for (const store of stores.splice(0)) store.db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A small in-memory stand-in for /api/ardud/control. */
function fakeControl(ownedServers = servers) {
  const threads = new Map<string, Thread>();
  const natives = new Map<string, string>();
  const calls: Call[] = [];
  /** `ignoreSettled` mimics a server from before PATCH learned `settled`. */
  const flags = { ignoreSettled: false, recentRunsLimit: Infinity, historicalEvidence: "terminal" as "terminal" | "running" | "unknown" | "unavailable", sendFailure: undefined as string | undefined,
    markers: false, missingMarker: false, markerStatus: 0, crossStatus: 0, page2Status: 0, pageSize: 1000, omit: new Set<string>(), override: new Map<string, number>(),
    afterDetailRecords: undefined as ((thread: Thread) => void) | undefined };
  let sequence = 0;
  const events = new Map<string, { value: string; marker: number }>();
  const marker = (thread: Thread) => {
    const value = JSON.stringify(thread);
    if (events.get(thread.threadId)?.value !== value) events.set(thread.threadId, { value, marker: ++sequence });
    return flags.override.get(thread.threadId) ?? events.get(thread.threadId)!.marker;
  };
  const projects = [{ projectId: "chats", title: "iMessage", workspaceRoot: "/chats" }];
  let counter = 0;
  const now = () => new Date(Date.now() + counter++).toISOString();
  const state = (thread: Thread) => thread.pending.length ? "needs-input"
    : thread.runs.some(run => run.status === "running") ? "running" : thread.runs.some(run => run.status === "waiting") ? "waiting" : "idle";
  const summary = (thread: Thread) => ({
    ...(flags.markers && !flags.missingMarker ? { changeMarker: marker(thread) } : {}),
    threadId: thread.threadId, projectId: thread.projectId, title: thread.title, state: state(thread), status: thread.runs.at(-1)?.status ?? "idle",
    // The driver decides the OpenCode fallback. Fixtures default to OpenCode, the driver their step rows come from.
    model: thread.driver ?? { instanceId: "opencode", model: "opencode-test" },
    origin: thread.origin, nativeSessionId: thread.nativeSessionId, runtimeMode: thread.runtimeMode, parentThreadId: thread.parentThreadId,
    rootThreadId: thread.parentThreadId ?? thread.threadId, worktreePath: thread.worktreePath, latestRunId: thread.runs.at(-1)?.runId ?? null,
    pendingRequest: thread.pending[0] ? { requestId: thread.pending[0].requestId, kind: thread.pending[0].kind, requestKind: thread.pending[0].requestKind } : null,
    lastError: thread.lastError, settled: thread.settled ?? false, ...(thread.archived ? { archived: true } : {}), createdAt: now(), updatedAt: now(),
  });
  const detail = (thread: Thread) => {
    const records = { state: state(thread), status: thread.runs.at(-1)?.status ?? "idle", run: structuredClone(thread.runs.at(-1) ?? null),
      recentRuns: structuredClone([...thread.runs].reverse().slice(0, flags.recentRunsLimit)), pendingRequests: structuredClone(thread.pending) };
    const afterRecords = flags.afterDetailRecords; flags.afterDetailRecords = undefined;
    afterRecords?.(thread);
    return { ...summary(thread), ...records };
  };
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
        if (searchParams.has("ids") && flags.markerStatus) return ok({}, flags.markerStatus);
        let list = [...threads.values()];
        if (searchParams.has("ids")) {
          const ids = searchParams.get("ids")!.split(",");
          if (ids.length > 50 || ids.some(id => !id)) return ok({}, 400);
          list = list.filter(thread => ids.includes(thread.threadId) && !flags.omit.has(thread.threadId));
        }
        if (searchParams.get("parentThreadId")) list = list.filter(thread => thread.parentThreadId === searchParams.get("parentThreadId"));
        if (searchParams.get("active") === "true") list = list.filter(thread => state(thread) !== "idle");
        if (searchParams.get("origin")) list = list.filter(thread => thread.origin === searchParams.get("origin"));
        return ok({ total: list.length, threads: list.map(summary) });
      }
      if (parts[0] === "threads" && parts[1] === "by-native") {
        const thread = threads.get(natives.get(parts[2]!) ?? "");
        return thread ? ok({ nativeSessionId: parts[2], thread: detail(thread) }) : notFound();
      }
      if (path === "/messages") {
        if (flags.crossStatus) return ok({}, flags.crossStatus);
        if (searchParams.has("cursor") && flags.page2Status) return ok({}, flags.page2Status);
        const ids = searchParams.get("threadIds")!.split(",");
        if (ids.length > 50 || ids.some(id => !id)) return ok({}, 400);
        const since = Number(searchParams.get("since"));
        const rows = [...threads.values()].filter(thread => ids.includes(thread.threadId)).flatMap(thread =>
          thread.messages.map(message => ({ ...message, threadId: thread.threadId })))
          .filter(message => Date.parse(message.updatedAt ?? "") > since)
          .sort((a, b) => Date.parse(a.updatedAt!) - Date.parse(b.updatedAt!) || Buffer.compare(Buffer.from(a.messageId), Buffer.from(b.messageId)));
        const cursor = searchParams.get("cursor");
        const after = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()) as { u: number; id: string } : undefined;
        const rest = after ? rows.filter(row => Date.parse(row.updatedAt!) > after.u || Date.parse(row.updatedAt!) === after.u && Buffer.compare(Buffer.from(row.messageId), Buffer.from(after.id)) > 0) : rows;
        const page = rest.slice(0, Math.min(Number(searchParams.get("limit")), flags.pageSize));
        const last = page.at(-1);
        return ok({ messages: page, nextCursor: rest.length > page.length && last ? Buffer.from(JSON.stringify({ u: Date.parse(last.updatedAt!), id: last.messageId })).toString("base64url") : null });
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
      if (thread && parts[2] === "messages") {
        const call = calls.at(-1)!;
        const since = searchParams.has("since") ? Number(searchParams.get("since")) : -Infinity;
        const messages = thread.messages.filter(message => message.role !== "system" && Date.parse(message.updatedAt ?? "") > since)
          .map(message => ({ message, created: Date.parse(message.createdAt ?? "") }))
          .sort((a, b) => a.created - b.created || a.message.messageId.localeCompare(b.message.messageId))
          .map(({ message }) => message);
        const payload = JSON.stringify({ ok: true, threadId: thread.threadId, state: state(thread), status: thread.runs.at(-1)?.status ?? "idle", runId: thread.runs.at(-1)?.runId ?? null, messages });
        Object.assign(call, { rows: messages.length, bytes: Buffer.byteLength(payload) });
        return new Response(payload, { status: 200, headers: { "content-type": "application/json;charset=utf-8" } });
      }
      if (thread && parts[2] === "runs" && parts[4] === "evidence") {
        const runId = parts[3]!;
        const run = thread.runs.find(candidate => candidate.runId === runId);
        if (!run) return notFound();
        const historical = !thread.runs.slice(-flags.recentRunsLimit).some(candidate => candidate.runId === runId);
        if (historical && flags.historicalEvidence === "unavailable") return ok({}, 503);
        const forced = thread.evidence?.[runId];
        const messages = thread.messages.filter(message => message.runId === runId && message.role === "assistant")
          .map(message => ({ id: message.messageId, phase: message.phase ?? "unknown", text: message.text.slice(0, 200) }));
        return ok({ runId, status: historical && flags.historicalEvidence !== "terminal" ? flags.historicalEvidence : run.status,
          toolEvidence: forced ?? "unknown", complete: forced === "none", messages });
      }
      if (thread && parts[2] === "origin") { thread.origin = body.origin; return ok({ threadId: thread.threadId, origin: body.origin }); }
      if (thread && parts[2] === "interrupt") return ok({ interrupted: true });
      if (thread && parts[2] === "send") {
        if (flags.sendFailure) return Response.json({ ok: false, error: { reason: flags.sendFailure, retrySafe: true } }, { status: 503 });
        const messageId = `${sentMessagePrefix(thread.threadId)}${encodeURIComponent(body.clientRequestId)}`;
        const running = thread.runs.find(run => run.status === "running");
        if (body.mode === "steer" && !thread.messages.some(message => message.messageId === messageId)) {
          if (!running) return Response.json({ ok: false, error: { code: "conflict", message: "no steerable run" } }, { status: 409 });
          thread.messages.push({ messageId, runId: running.runId, role: "user", text: body.text, streaming: false, createdBy: "system", createdAt: now(), updatedAt: now() });
          return ok({ threadId: thread.threadId, messageId, delivery: "steered" });
        }
        if (!thread.messages.some(message => message.messageId === messageId)) {
          const ordinal = Math.max(0, ...thread.runs.map(run => run.ordinal)) + 1;
          const runId = `run:thread:${thread.threadId}:ordinal:${ordinal}`;
          thread.runs.push({ runId, ordinal, status: "running", requestedAt: now() });
          // Robob records a relay as the owner's only when it verified the inbound.
          thread.messages.push({ messageId, runId, role: "user", text: body.text, streaming: false,
            createdBy: body.inboundId ? "user" : "system", createdAt: now(), updatedAt: now() });
        }
        return ok({ threadId: thread.threadId, messageId, delivery: "started", runId: thread.messages.find(message => message.messageId === messageId)?.runId });
      }
      if (thread && parts[2] === "requests") {
        thread.pending = thread.pending.filter(request => request.requestId !== parts[3]);
        return ok({ threadId: thread.threadId, requestId: parts[3] });
      }
      return notFound();
    } });
    ownedServers.push(server);
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

test("fake message reads preserve sort ties, JSON bytes and response metadata", async () => {
  const control = fakeControl();
  const chat = await control.backend().createChat();
  const thread = control.threads.get(chat.id)!;
  thread.messages = ["message-10", "message-2", "message-2", "message-1"].map((messageId, index) => ({
    messageId, runId: null, role: index === 3 ? "system" : "assistant", streaming: false,
    text: `café ☕ ${index}`, createdAt: index === 2 ? null : "2026-11-15T09:30:00Z", updatedAt: "2026-11-15T09:30:01Z",
  }));
  for (const since of [undefined, Date.parse("2026-11-15T09:30:00Z"), Date.parse("2026-11-15T09:30:01Z")]) {
    const messages = thread.messages.filter(message => message.role !== "system" && Date.parse(message.updatedAt ?? "") > (since ?? -Infinity))
      .sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "") || a.messageId.localeCompare(b.messageId));
    const expected = Response.json({ ok: true, threadId: chat.id, state: "idle", status: "idle", runId: null, messages });
    const response = await fetch(`${control.url}/api/ardud/control/threads/${chat.id}/messages${since === undefined ? "" : `?since=${since}`}`, { headers: { authorization: "Bearer test-token" } });
    expect(response.status).toBe(expected.status);
    expect(response.headers.get("content-type")).toBe(expected.headers.get("content-type"));
    const payload = await response.text();
    expect(payload).toBe(await expected.text());
    expect(control.calls.at(-1)).toMatchObject({ rows: messages.length, bytes: Buffer.byteLength(payload) });
    thread.messages[0]!.createdAt = "2026-11-15T09:29:00Z";
  }
});

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
  expect(store.inboundFailure("first")).toMatchObject({ stage: "execution" });
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

test.each([
  { firstStatus: "failed", partial: false },
  { firstStatus: "failed", partial: true },
  { firstStatus: "completed", partial: false },
  { firstStatus: "completed", partial: true },
])("historical first-turn outcome is read back after restart and five later runs (%j)", async ({ firstStatus, partial }) => {
  const control = fakeControl();
  control.flags.recentRunsLimit = 5;
  const store = new Store(":memory:");
  stores.push(store);
  const alerts: string[] = [];
  const options = { alert: async (_id: string, text: string) => { alerts.push(text); return true; } };
  const before = control.backend("/chats", options);
  before.trackFirstTurns(store);
  const transport = { async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); } };
  const routerOptions = {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/private/test/skill.md",
    alertSkillPath: "/private/test/alert.md", alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent", quietMs: 0,
  };
  const router = new Router(store, before, transport, routerOptions);
  store.acceptInbound("first", { id: "first", text: "hi", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  const chat = store.get<{ id: string; directory: string }>("route")!;
  const thread = control.threads.get(chat.id)!;
  if (partial) control.reply(chat.id, "Partial first-run output", firstStatus);
  else thread.runs[0]!.status = firstStatus;
  const firstRun = thread.runs[0]!.runId;
  const steered: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = `msg_${String(i).repeat(64)}`;
    steered.push(id);
    await before.prompt(chat.id, chat.directory, id, "follow up");
    control.reply(chat.id, `Later answer ${i}`, "completed");
  }
  store.set("activeTurn", { ...store.get<object>("activeTurn"), steered, steeredAt: Date.now() });
  const after = control.backend("/chats", options);
  after.trackFirstTurns(store);
  const resumed = new Router(store, after, transport, routerOptions);
  const records = await after.messages(chat.id, chat.directory, { until: steered[0] });
  expect(control.calls.some(call => call.path.includes(`/runs/${encodeURIComponent(firstRun)}/evidence`))).toBe(true);
  expect(records.find(record => record.id === `idle:${firstRun}`)).toMatchObject({ outcome: firstStatus === "failed" ? "failed" : "succeeded" });
  await resumed.tick();
  await resumed.tick();
  expect(alerts).toHaveLength(firstStatus === "failed" ? 1 : 0);
  expect(store.get<unknown[]>("firstTurns")).toEqual([]);
  const expected = Array.from({ length: 5 }, (_, i) => `Later answer ${i}`);
  if (firstStatus === "completed" && partial) expected.unshift("Partial first-run output");
  expect(store.pendingOutbox().filter(item => item.kind === "conversation").map(item => item.text)).toEqual(expected);
  expect(store.pendingOutbox().filter(item => item.kind === "control")).toHaveLength(firstStatus === "failed" ? 1 : 0);
  if (firstStatus === "failed") expect(alerts[0]).toContain("Run failed without error details");
});

test.each(["running", "unknown", "unavailable"] as const)("inconclusive historical evidence (%s) retains pending first-turn state and never forwards partial output", async status => {
  const control = fakeControl();
  control.flags.recentRunsLimit = 5;
  const store = new Store(":memory:");
  stores.push(store);
  const alerts: string[] = [];
  const options = { alert: async (_id: string, text: string) => { alerts.push(text); return true; } };
  const before = control.backend("/chats", options);
  before.trackFirstTurns(store);
  const chat = await before.createChat();
  await before.prompt(chat.id, chat.directory, `msg_${"a".repeat(64)}`, "hi");
  control.reply(chat.id, "Partial output, not an answer", "failed");
  for (let i = 0; i < 5; i++) {
    await before.prompt(chat.id, chat.directory, `msg_${String(i).repeat(64)}`, "later");
    control.reply(chat.id, "Later answer", "completed");
  }
  const after = control.backend("/chats", options);
  after.trackFirstTurns(store);
  control.flags.historicalEvidence = status;
  await expect(after.messages(chat.id)).rejects.toThrow();
  expect(store.get("firstTurns")).toMatchObject([{ id: chat.id, alert: null }]);
  expect(alerts).toEqual([]);
  control.flags.historicalEvidence = "terminal";
  const records = await after.messages(chat.id);
  expect(records.find(record => record.id === `idle:${control.threads.get(chat.id)!.runs[0]!.runId}`)).toMatchObject({ outcome: "failed", firstTurnFailure: true });
  expect(alerts).toHaveLength(1);
  expect(store.get<unknown[]>("firstTurns")).toEqual([]);
});

test("record mapping never invents a successful idle for an unknown historical outcome", () => {
  const runId = "run:thread:t:ordinal:1";
  const records = recordsFromThread({ threadId: "t", lastError: null, run: null, recentRuns: [] }, [{
    messageId: "partial", runId, role: "assistant", text: "Partial output", streaming: false,
    createdAt: null, updatedAt: null,
  }]);
  expect(records.some(record => record.type === "idle")).toBe(false);
});

test.each(["cancelled", "failed"])("a historical waiting outcome is re-read when recovery changes it to %s", async status => {
  const control = fakeControl();
  control.flags.recentRunsLimit = 5;
  const backend = control.backend();
  const chat = await backend.createChat();
  await backend.prompt(chat.id, chat.directory, `msg_${"a".repeat(64)}`, "hi");
  control.reply(chat.id, "First answer", "waiting");
  for (let i = 0; i < 5; i++) {
    await backend.prompt(chat.id, chat.directory, `msg_${String(i).repeat(64)}`, "later");
    control.reply(chat.id, "Later answer", "waiting");
  }
  const first = control.threads.get(chat.id)!.runs[0]!;
  const before = await backend.messages(chat.id);
  expect(before.find(record => record.id === `idle:${first.runId}`)).toMatchObject({ outcome: "succeeded" });
  first.status = status;
  const after = await backend.messages(chat.id);
  expect(after.find(record => record.id === `idle:${first.runId}`)).toMatchObject({ outcome: status === "failed" ? "failed" : "interrupted" });
  expect(control.calls.filter(call => call.path.includes(`/runs/${encodeURIComponent(first.runId)}/evidence`))).toHaveLength(4);
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
  expect(sends[1]!.body).toEqual(sends[0]!.body);
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

test("a new prompt without a model preference keeps the thread model", async () => {
  const control = fakeControl(); const backend = control.backend();
  const { id, directory } = await backend.createChat();
  await backend.prompt(id, directory, `msg_${"a".repeat(64)}`, "hello");
  const send = control.calls.find(call => call.path.endsWith("/send"))!;
  for (const field of ["providerInstanceId", "model", "variant"]) expect(send.body).not.toHaveProperty(field);
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
    { decision: "approve", inboundId: "guid-yes", clientRequestId: expect.stringMatching(/^respond_/) }, { decision: "deny", clientRequestId: expect.stringMatching(/^respond_/) },
    { answers: { q0: "A" }, inboundId: "guid-a", clientRequestId: expect.stringMatching(/^respond_/) }, { dismiss: true, inboundId: "guid-no", clientRequestId: expect.stringMatching(/^respond_/) },
  ]);
});

test.each(["question", "permission"])("a %s response rechecks admission after resolving its thread", async kind => {
  const control = fakeControl(); const backend = control.backend();
  const { id, directory } = await backend.createChat();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const resolve = backend.resolve.bind(backend);
  backend.resolve = async session => { entered.resolve(); await release.promise; return resolve(session); };
  let allowed = true;
  const replying = kind === "question"
    ? backend.questionReply({ id: "q-1", sessionID: id, title: "Pick", questions: [{ key: "q0", question: "Which?", header: "Pick", options: [] }] }, directory, [["A"]], "answer", () => allowed)
    : backend.permissionReply(id, "perm-1", directory, "once", "answer", () => allowed);
  await entered.promise; allowed = false; release.resolve();
  expect(await replying).toBe(false);
  expect(control.calls.filter(call => call.path.endsWith("/respond"))).toEqual([]);
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
    [`/threads/${id}/requests/perm-1/respond`, { decision: "deny", clientRequestId: expect.stringMatching(/^respond_/) }],
    [`/threads/${id}/requests/q-1/respond`, { answers: { q0: "B" }, clientRequestId: expect.stringMatching(/^respond_/) }],
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
  expect(await backend.sessionBusy(id)).toBe(false);
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
  const path = join(dirPath, "synthetic-fixture.sqlite");
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
  return { control, store, router, wake, states, sends: () => control.calls.filter(call => call.path.endsWith("/send")).length };
}

test("an errored step classified between OpenCode's commits, before the native idle marker, is never retried, even when execution later completes a tool", async () => {
  // Between the two native commits: the step is `error` with no retry yet and the run has no idle marker.
  const dirPath = mkdtempSync(join(tmpdir(), "robob-between-"));
  dirs.push(dirPath);
  const path = join(dirPath, "synthetic-fixture.sqlite");
  const base = Date.now();
  const db = new Database(path);
  db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
  db.query("INSERT INTO session_message VALUES ('msg_between', 'ses_between', 'assistant', 0, ?, ?)").run(base + 5_000, JSON.stringify({ finish: "error", content: [{ type: "text", text: "partial" }], error: { type: "provider.internal" } }));
  db.close();
  const first = await failedWake(path, "ses_between", base, []);
  // No idle marker yet: the run is between OpenCode's commits, so it is unsettled and the wake is not retried.
  expect(first.states).toEqual(["failed"]);
  expect(first.store.inboundFailure(first.wake)).toMatchObject({ stage: "execution" });
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
  expect(first.store.inboundFailure(first.wake)).toMatchObject({ stage: "execution" });
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
  expect(first.store.inboundFailure(first.wake)).toMatchObject({ stage: "execution" });
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
  expect(run.store.inboundFailure(run.wake)).toMatchObject({ stage: "execution" });
  expect(run.sends()).toBe(1);
  expect(run.store.pendingOutbox().filter(item => item.kind === "control").map(item => item.text)).toEqual([
    "I couldn't process that message because this chat hit a system error. Please don't resend it yet.",
  ]);
});

test("a new chat's first-call error with reasoning is reported without replaying the wake", async () => {
  const { path, base } = nativeDb("ses_reason_400", [["msg_reason", { finish: "error", content: [{ type: "reasoning", text: "thinking" }], error: { type: "aborted" } }]]);
  const run = await failedWake(path, "ses_reason_400", base, [120_000]);
  expect(run.states).toEqual(["failed", "failed"]);
  expect(run.store.inboundFailure(run.wake)).toMatchObject({ stage: "execution" });
  expect(run.sends()).toBe(1);
});

test("a run whose tool call sits past a truncated scan is never retried, through the real router and OpenCode's run rows", async () => {
  const dirPath = mkdtempSync(join(tmpdir(), "robob-truncated-"));
  dirs.push(dirPath);
  const path = join(dirPath, "synthetic-fixture.sqlite");
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
  expect(store.inboundFailure(wake)).toMatchObject({ stage: "synthetic" });
  setSystemTime(start + 120_000);
  await router.tick();
  expect(control.calls.filter(call => call.path.endsWith("/send"))).toHaveLength(1);
});

test("a later provider 400 keeps the existing tool-free retry behavior", async () => {
  const dirPath = mkdtempSync(join(tmpdir(), "robob-first-call-"));
  dirs.push(dirPath);
  const path = join(dirPath, "synthetic-fixture.sqlite");
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


test.each([0, 94, 95, 99, 100, 101, 250].flatMap(count =>
  ["available", "unavailable", "question", "permission"].map(child => ({ count, child })),
))("owned late-steer replies cross the real backend page boundary ($count narration records, child $child)", async ({ count, child }) => {
  const start = Date.now();
  setSystemTime(start);
  const control = fakeControl();
  const backend = control.backend();
  const chat = await backend.createChat();
  const promptId = (id: string) => `msg_${createHash("sha256").update(id).digest("hex")}`;
  await backend.prompt(chat.id, chat.directory, promptId("third"), "Third question");
  control.reply(chat.id, "Third answer", "completed");
  await backend.prompt(chat.id, chat.directory, promptId("second"), "Second question");
  const thread = control.threads.get(chat.id)!;
  thread.driver = { instanceId: "codex", model: "test" };
  for (let i = 0; i < count; i++) thread.messages.push({
    messageId: `narration-${i}`, runId: thread.runs.at(-1)!.runId, role: "assistant", phase: "narration", text: "Working", streaming: false,
    createdAt: new Date(start + 1_000 + i).toISOString(), updatedAt: new Date(start + 1_000 + i).toISOString(),
  });
  setSystemTime(start + 2_000);
  control.reply(chat.id, "Second answer", "completed");
  const asking = child === "question" || child === "permission";
  const delegated: Thread = { ...thread, threadId: "page-child", parentThreadId: chat.id, runtimeMode: "approval-required",
    runs: [{ runId: "child-run", ordinal: 1, status: "running" }], messages: [], pending: child === "question" ? [{
      requestId: "page-question", kind: "question", requestKind: "user_input", canRespond: true,
      questions: [{ id: "choice", header: "Pick", question: "Which option?", options: [{ label: "A" }, { label: "B" }] }],
    }] : child === "permission" ? [{
      requestId: "page-permission", kind: "approval", requestKind: "command", title: "bash", prompt: "git status", canRespond: true,
    }] : [] };
  control.threads.set(delegated.threadId, delegated);
  if (child === "unavailable") backend.children = async () => { throw new Error("child listing unavailable"); };
  if (asking) {
    const messages = backend.messages.bind(backend);
    let firstPage = true;
    backend.messages = async (id, directory, options) => {
      const records = await messages(id, directory, options);
      if (firstPage && options?.until === promptId("second")) {
        firstPage = false;
        return records.filter(record => record.id === promptId("second"));
      }
      return records;
    };
  }
  const store = new Store(":memory:");
  stores.push(store);
  for (const id of ["second", "third"]) {
    store.acceptInbound(id, { id, text: `${id} question`, attachments: [], isAudioMessage: false, receivedAt: start });
    store.updateInbound(id, "done");
  }
  store.set("route", { ...chat, generation: 1 });
  store.set("batch:second", { id: "second", text: "Second question", batchIds: ["second"], attachments: [], isAudioMessage: false, receivedAt: start });
  store.set("activeTurn", { ...chat, generation: 1, inboundId: "second", messageId: promptId("second"), startedAt: start, phase: "running", steered: [promptId("third")], steeredAt: start });
  const router = new Router(store, backend, { async typing() {}, async read() {}, async downloadAttachment() { throw new Error("Unexpected file"); } }, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/test/imessage", alertSkillPath: "/test/telegram", alertSocketPath: "/test/telegram.sock", openCodeConfigRoot: "/nonexistent/opencode-config",
  });
  setSystemTime(start + 120_000);
  await router.tick();
  if (asking) {
    const requests = store.pendingOutbox().filter(op => op.id.startsWith("request:"));
    expect(requests).toHaveLength(1);
    expect(await router.beforeSend(requests[0]!)).toBe("send");
  }
  await router.tick();
  expect(store.pendingOutbox().filter(op => op.kind === "conversation").map(op => op.text)).toEqual(["Third answer", "Second answer"]);
  if (asking) {
    expect(store.get<object | null>("activeTurn")).toMatchObject({ background: true, origin: "request" });
    expect(store.pendingOutbox().filter(op => op.id.startsWith("request:"))).toHaveLength(1);
  } else expect(store.get<object | null>("activeTurn")).toBeNull();
  expect(control.calls.filter(call => call.path.endsWith("/send"))).toHaveLength(2);
});


function delegatedRouter(context?: ChatContext) {
  const control = fakeControl();
  const backend = control.backend();
  const store = new Store(":memory:");
  stores.push(store);
  const router = new Router(store, backend, {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
  }, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/private/test/skill.md",
    alertSkillPath: "/private/test/alert.md", alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent", quietMs: 0, watchMs: 0,
    ...(context ? { context, chatGuid: context.chat.key } : {}),
  });
  return { control, backend, store, router };
}

test("incremental admission reads respect persisted cooldown and retry cap while normal polling proceeds", async () => {
  const start = Date.parse("2026-11-18T03:00:00Z"); setSystemTime(start);
  const h = delegatedRouter(), chat = await h.backend.createChat(), id = "cached-admission";
  const messageId = `msg_${createHash("sha256").update(id).digest("hex")}`;
  h.store.set("route", { ...chat, generation: 1 });
  h.store.acceptInbound(id, { id, text: "Please check", source: "typed", attachments: [], isAudioMessage: false, receivedAt: start - 120_000 } satisfies NormalizedInbound);
  h.store.updateInbound(id, "processing");
  h.store.set(`failed-delivery:${id}`, { ...chat, generation: 1, inboundId: id, messageId, startedAt: start - 120_000, phase: "unknown" });
  expect(await h.backend.promptAccepted(chat.id, chat.directory, messageId)).toBe(false);
  const reads = spyOn(ControlClient.prototype, "messages").mockRejectedValueOnce(new ControlError(503));
  try {
    await h.router.checkInboundLatency();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]![1]).toBeNumber();
    setSystemTime(start + 1_000); await h.router.checkInboundLatency();
    expect(reads).toHaveBeenCalledTimes(1);
    setSystemTime(start + 60_000);
    const budget = new ProbeBudget(h.store);
    while (budget.take()) {}
    await h.router.checkInboundLatency();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(inbounds(h.store)).toEqual([{ id, state: "processing" }]);
    await h.backend.messages(chat.id, chat.directory);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(h.control.calls.filter(call => call.path.endsWith("/send"))).toEqual([]);
  } finally { reads.mockRestore(); }
});

test.each([false, true])("a completed parent replies before its delegated child, even with older busy work (%s)", async olderBusy => {
  const { control, backend, store, router } = delegatedRouter();
  store.acceptInbound("parent-76", { id: "parent-76", text: "Did it go through?", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  const route = store.get<{ id: string; generation: number }>("route")!;
  const parent = control.threads.get(route.id)!;
  parent.driver = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const run = parent.runs.at(-1)!;
  run.runId = `run:thread:${route.id}:ordinal:76`;
  run.ordinal = 76;
  parent.messages[0]!.runId = run.runId;
  if (olderBusy) parent.runs.unshift({ runId: `run:thread:${route.id}:ordinal:75`, ordinal: 75, status: "running" });
  const child = { ...parent, threadId: "delegated-child", parentThreadId: route.id,
    runs: [{ runId: "child-run", ordinal: 1, status: "running" }], messages: [], pending: [] };
  control.threads.set(child.threadId, child);
  control.reply(route.id, "It went through.", "completed");
  expect(await backend.statuses()).toHaveProperty(child.threadId);
  await router.tick();
  const replies = () => store.pendingOutbox().filter(item => item.kind === "conversation").map(item => item.text);
  expect(replies()).toEqual(["It went through."]);
  expect(inbounds(store)).toContainEqual({ id: "parent-76", state: "done" });
  expect(store.get<{ sessionId: string; id: string }>("watermark")).toEqual({ sessionId: route.id, id: `idle:${run.runId}` });

  child.runs[0]!.status = "completed";
  if (olderBusy) parent.runs[0]!.status = "completed";
  // Robob resumes the route for the delegated completion; its agent-authored
  // user notice is hidden by recordsFromThread, leaving the reply after the watermark.
  const wakeRun = { runId: `run:thread:${route.id}:ordinal:77`, ordinal: 77, status: "running" };
  parent.runs.push(wakeRun);
  const at = new Date(Date.now() + 1000).toISOString();
  parent.messages.push({ messageId: "delegated-completion", runId: wakeRun.runId, role: "user", text: "Delegated task finished", streaming: false, createdBy: "agent", createdAt: at, updatedAt: at });
  control.reply(route.id, "Child result delivered.", "completed");
  for (let i = 0; i < 3; i++) await router.tick();
  expect(replies()).toEqual(["It went through.", "Child result delivered."]);
  expect(store.get<{ sessionId: string; id: string }>("watermark")).toEqual({ sessionId: route.id, id: `idle:${wakeRun.runId}` });
  expect(store.get("activeTurn")).toBeNull();
  expect(inbounds(store)).toEqual([{ id: "parent-76", state: "done" }]);
});


test.each([
  { scope: "child", kind: "permission", unavailable: false, steps: 1 },
  { scope: "child", kind: "question", unavailable: false, steps: 1 },
  { scope: "child", kind: "permission", unavailable: true, steps: 1 },
  { scope: "child", kind: "question", unavailable: true, steps: 1 },
  { scope: "root", kind: "permission", unavailable: false, steps: 1 },
  { scope: "root", kind: "question", unavailable: false, steps: 1 },
  { scope: "child", kind: "question", unavailable: true, steps: 2 },
  { scope: "root", kind: "question", unavailable: false, steps: 2 },
])("requests survive an earlier parent completion without blocking its reply (%j)", async ({ scope, kind, unavailable, steps }) => {
  const { control, backend, store, router } = delegatedRouter();
  store.acceptInbound("request-parent", { id: "request-parent", text: "Start work", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  const route = store.get<{ id: string }>("route")!;
  const parent = control.threads.get(route.id)!;
  const run = parent.runs.at(-1)!;
  parent.driver = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const request: PendingRequest = kind === "question" ? {
    requestId: "work-question", kind: "question", requestKind: "user_input", canRespond: true, questions: [
      { id: "choice", header: "Pick", question: "Which option?", options: [{ label: "A" }, { label: "B" }] },
      ...steps === 2 ? [{ id: "second", header: "Next", question: "Which next?", options: [{ label: "A" }, { label: "B" }] }] : [],
    ],
  } : { requestId: "work-permission", kind: "approval", requestKind: "command", title: "bash", prompt: "git status", canRespond: true };
  const asking: Thread = scope === "child" ? { ...parent, threadId: "asking-child", parentThreadId: route.id,
    runs: [{ runId: "child-run", ordinal: 1, status: "running" }], messages: [], pending: [request] } : parent;
  if (scope === "child") {
    control.threads.set(asking.threadId, asking);
    // The fake server has no SSE connection; deliver and drain its creation event.
    rosterEvent(backend.activeRoster, { type: "thread.created", threadId: asking.threadId });
    await backend.statuses(true);
  }
  else {
    parent.runs.push({ runId: `run:thread:${route.id}:ordinal:2`, ordinal: 2, status: "running" });
    parent.pending = [request];
  }
  await router.tick();
  expect(router.routerStatus().pending).toMatchObject([{ sessionId: asking.threadId, kind, state: "pending" }]);
  expect(store.pendingOutbox().some(item => item.id.startsWith("request:"))).toBe(true);
  expect(store.pendingOutbox().filter(item => item.kind === "conversation")).toEqual([]);
  for (const item of store.pendingOutbox().filter(item => item.id.startsWith("request:"))) store.outboxState(item.id, "sent", `sent:${item.id}`);
  if (steps === 2) {
    store.acceptInbound("first-step", { id: "first-step", text: "1", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
    await router.tick();
    for (const item of store.pendingOutbox().filter(item => item.id.startsWith("request:"))) store.outboxState(item.id, "sent", `sent:${item.id}`);
  }
  const children = backend.children.bind(backend);
  if (unavailable) backend.children = async () => { throw new Error("child listing unavailable"); };
  const at = new Date(Date.now() + 1000).toISOString();
  parent.messages.push({ messageId: "parent-reply", runId: run.runId, role: "assistant", text: "Parent finished.", phase: "answer", streaming: false, createdBy: "agent", createdAt: at, updatedAt: at });
  run.status = "completed";
  await router.tick();
  const replies = () => store.pendingOutbox().filter(item => item.kind === "conversation").map(item => item.text);
  expect(replies()).toEqual(["Parent finished."]);
  expect(inbounds(store)).toContainEqual({ id: "request-parent", state: "done" });
  expect(store.get<{ sessionId: string; id: string }>("watermark")).toEqual({ sessionId: route.id, id: `idle:${run.runId}` });
  for (let i = 0; i < 3; i++) await router.tick();
  const prompts = store.db.query<{ id: string }, []>("SELECT id FROM outbox WHERE id LIKE 'request:%'").all();
  expect(prompts).toHaveLength(steps);
  expect(router.routerStatus().pending).toMatchObject([{ sessionId: asking.threadId, state: "pending" }]);
  store.acceptInbound("request-answer", { id: "request-answer", text: kind === "permission" ? "yes" : steps === 2 ? "2" : "1", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  expect(asking.pending).toEqual([]);
  if (steps === 2) expect(control.calls.find(call => call.path.includes(`/threads/${asking.threadId}/requests/`))!.body.answers).toEqual({ choice: "A", second: "B" });
  expect(control.calls.filter(call => call.path.includes(`/threads/${asking.threadId}/requests/`))).toHaveLength(1);
  expect(control.calls.filter(call => call.path.endsWith("/send"))).toHaveLength(1);
  backend.children = children;
  if (scope === "child") {
    asking.runs[0]!.status = "completed";
    parent.runs.push({ runId: `run:thread:${route.id}:ordinal:2`, ordinal: 2, status: "running" });
  }
  const next = parent.runs.at(-1)!;
  control.reply(route.id, "Follow-up finished.", "completed");
  for (let i = 0; i < 4; i++) await router.tick();
  expect(replies()).toEqual(["Parent finished.", "Follow-up finished."]);
  expect(store.get<{ sessionId: string; id: string }>("watermark")).toEqual({ sessionId: route.id, id: `idle:${next.runId}` });
  expect(store.get("activeTurn")).toBeNull();
});


test.each([false, true])("an older busy run finishing without a later wake frees the next inbound (%s)", async olderAnswer => {
  const { control, backend, store, router } = delegatedRouter();
  store.acceptInbound("parent-76", { id: "parent-76", text: "Did it go through?", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  const route = store.get<{ id: string }>("route")!;
  const parent = control.threads.get(route.id)!;
  parent.driver = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const run = parent.runs.at(-1)!;
  run.runId = `run:thread:${route.id}:ordinal:76`;
  run.ordinal = 76;
  parent.messages[0]!.runId = run.runId;
  const older = { runId: `run:thread:${route.id}:ordinal:75`, ordinal: 75, status: "running" };
  parent.runs.unshift(older);
  control.reply(route.id, "Parent finished.", "completed");
  await router.tick();
  expect(store.pendingOutbox().filter(item => item.kind === "conversation").map(item => item.text)).toEqual(["Parent finished."]);
  expect(store.get("activeTurn")).toMatchObject({ background: true, messageId: `idle:${run.runId}` });
  older.status = "completed";
  if (olderAnswer) {
    const at = new Date(Date.now() + 1000).toISOString();
    parent.messages.push({ messageId: "older-answer", runId: older.runId, role: "assistant", text: "Older work finished.", phase: "answer", streaming: false, createdBy: "agent", createdAt: at, updatedAt: at });
  }
  expect(await backend.sessionBusy(route.id)).toBe(false);
  expect(await backend.statuses()).toEqual({});
  for (let i = 0; i < 5; i++) await router.tick();
  expect(store.get("activeTurn")).toBeNull();
  expect(store.get<{ sessionId: string; id: string }>("watermark")).toEqual({ sessionId: route.id, id: `idle:${run.runId}` });
  store.acceptInbound("next", { id: "next", text: "Next question", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  expect(control.calls.filter(call => call.path.endsWith("/send")).map(call => call.body.text)).toEqual(["Did it go through?", "Next question"]);
  expect(inbounds(store)).toContainEqual({ id: "next", state: "done" });
});

test("control calls aggregate success timing and retain failed method/duration, with no bodies or query data", async () => {
  const { captureLogs } = await import("./log-fixture.ts");
  const { ControlClient } = await import("../src/control.ts");
  const { toolLog } = await import("../src/toollog.ts");
  toolLog.flush();
  await toolLog.settled();
  const logs = await captureLogs(async () => {
    const control = fakeControl();
    const client = new ControlClient({ url: control.url, token: "test-token" });
    await client.request("GET", "/health?private=PRIVATE_QUERY");
    await expect(client.request("POST", "/missing", { text: "PRIVATE_BODY", token: "PRIVATE_TOKEN" })).rejects.toThrow();
    toolLog.flush();
  });
  const summary = logs.find(l => l.name === "turn.robob_calls")!;
  expect(summary.calls?.health).toMatchObject({ count: 1, ok: 1, failed: 0 });
  expect(summary.calls?.health.p50).toBeGreaterThanOrEqual(0);
  const failed = logs.filter(l => l.name === "turn.robob_call" && l.ok === false);
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({ props: { method: "POST", route: "/missing" } });
  expect(failed[0]!.error?.tag).toBe("control.request_failed");
  expect(failed[0]!.durationMs).toBeGreaterThanOrEqual(0);
  for (const value of ["PRIVATE_", "test-token"]) expect(JSON.stringify(logs)).not.toContain(value);
});


test("steering files: images accompany strict same-id sends without a second prompt", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const { id, directory } = await backend.createChat();
  await backend.prompt(id, directory, `msg_${"a".repeat(64)}`, "Work");
  const bytes = new Uint8Array([1, 2, 3]);
  const uploaded: unknown[] = [];
  const attachment = { attachmentId: "image-1", type: "image" as const, name: "flight.png", mimeType: "image/png", sizeBytes: bytes.length };
  const upload = spyOn(ControlClient.prototype, "upload").mockImplementation(async file => { uploaded.push(file); return attachment; });
  try {
    const requestId = `msg_${"d".repeat(64)}`;
    const files = [{ type: "file" as const, mime: "image/png", filename: "flight.png", url: "data:image/png;base64,AQID" }];
    expect(await backend.steer(id, directory, requestId, "Add these flights", "File guidance", files)).toBe("steered");
    expect(await backend.steer(id, directory, requestId, "Add these flights", "File guidance", files)).toBe("started");
    expect(uploaded).toEqual([{ name: "flight.png", mimeType: "image/png", bytes }]);
    expect(control.calls.filter(call => call.body?.clientRequestId === requestId).map(call => call.body)).toEqual([1, 2].map(() => ({
      text: "Add these flights", guidance: "File guidance", mode: "steer", clientRequestId: requestId, attachments: [attachment],
    })));
    expect(control.threads.get(id)!.messages).toHaveLength(2);
    expect(await backend.promptAccepted(id, directory, requestId)).toBe(true);
  } finally { upload.mockRestore(); }
});


test.each(["auto", "steer"].flatMap(mode => ["startup_unavailable", "send_timeout"].flatMap(reason => [false, true].map(restart => ({ mode, reason, restart })))))("file retry keeps identical $mode POST through $reason (restart=$restart)", async ({ mode, reason, restart }) => {
  let uploads = 0;
  const bodies: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/ardud/control/attachments") return Response.json({ ok: true, attachmentId: `file-${++uploads}`, relativeUrl: "/upload" });
    if (path === "/upload") return new Response("");
    if (path.endsWith("/send")) {
      bodies.push(await request.json());
      return bodies.length < 3 ? Response.json({ ok: false, error: { reason, retrySafe: true } }, { status: 503 })
        : Response.json({ ok: true, delivery: "steered" });
    }
    return new Response("Unexpected request", { status: 500 });
  } });
  servers.push(server);
  const dir = mkdtempSync(join(tmpdir(), "bridge-file-retry-")); dirs.push(dir);
  const store = new Store(join(dir, "inbound.sqlite")); stores.push(store);
  const makeBackend = (state: Store) => {
    const backend = new RobobBackend({ chatRoot: "/chats", url: server.url.origin, token: "test-token" });
    backend.trackFirstTurns(state); return backend;
  };
  let backend = makeBackend(store);
  const files = [{ type: "file" as const, mime: "image/png", filename: "flight.png", url: "data:image/png;base64,AQID" }];
  const send = () => mode === "steer" ? backend.steer("thread-test", "/chats", "msg_retry", "Flight", "Guidance", files)
    : backend.prompt("thread-test", "/chats", "msg_retry", "Flight", "Guidance", files);
  await expect(send()).rejects.toMatchObject({ status: 503, reason });
  if (restart) {
    const reopened = new Store(join(dir, "inbound.sqlite")); stores.push(reopened);
    backend = makeBackend(reopened);
  }
  await expect(send()).rejects.toMatchObject({ status: 503, reason });
  await send();
  expect(uploads).toBe(1);
  expect(bodies).toHaveLength(3);
  expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]]);
  expect(bodies[0]).toMatchObject({ mode, clientRequestId: "msg_retry", attachments: [{ attachmentId: "file-1" }] });
});

test.each(["bytes", "name", "mime", "removed", "added", "order"])("file retry refuses changed %s under the same identity", async shape => {
  const control = fakeControl(); const backend = control.backend();
  const { id, directory } = await backend.createChat();
  const attachment = { attachmentId: "file-1", type: "image" as const, name: "flight.png", mimeType: "image/png", sizeBytes: 3 };
  const upload = spyOn(ControlClient.prototype, "upload").mockResolvedValue(attachment);
  const files = [{ type: "file" as const, mime: "image/png", filename: "flight.png", url: "data:image/png;base64,AQID" },
    { type: "file" as const, mime: "image/png", filename: "other.png", url: "data:image/png;base64,BAUG" }];
  try {
    await backend.steer(id, directory, "msg_file_identity", "Flight", "Guidance", files);
    const changed = files.map(file => ({ ...file }));
    if (shape === "bytes") changed[0]!.url = "data:image/png;base64,BAUG";
    if (shape === "name") changed[0]!.filename = "renamed.png";
    if (shape === "mime") changed[0]!.mime = "image/jpeg";
    if (shape === "removed") changed.pop();
    if (shape === "added") changed.push({ ...files[0]! });
    if (shape === "order") changed.reverse();
    await expect(backend.steer(id, directory, "msg_file_identity", "Flight", "Guidance", changed)).rejects.toThrow("Robob attachment retry changed");
    expect(control.calls.filter(call => call.body?.clientRequestId === "msg_file_identity")).toHaveLength(1);
    expect(upload).toHaveBeenCalledTimes(2);
  } finally { upload.mockRestore(); }
});

test.each(["question", "cancel"])("steering files: %s during upload prevents the later POST", async kind => {
  const control = fakeControl(); const backend = control.backend();
  const { id, directory } = await backend.createChat();
  await backend.prompt(id, directory, `msg_${"a".repeat(64)}`, "Work");
  const entered = Promise.withResolvers<void>();
  const uploaded = Promise.withResolvers<{ attachmentId: string; type: "image"; name: string; mimeType: string; sizeBytes: number }>();
  const abort = new AbortController();
  let blocked = false, checks = 0;
  const upload = spyOn(ControlClient.prototype, "upload").mockImplementation(async (_file, signal) => {
    expect(signal).toBe(abort.signal); entered.resolve(); return uploaded.promise;
  });
  try {
    const requestId = `msg_${"e".repeat(64)}`;
    const sending = backend.steer(id, directory, requestId, "These flights", "guidance", [{ type: "file", mime: "image/png", url: "data:image/png;base64,AQID" }], {
      signal: abort.signal, beforeSend: async () => { checks++; return !blocked; },
    });
    await entered.promise;
    blocked = true;
    if (kind === "cancel") abort.abort();
    uploaded.resolve({ attachmentId: "image-2", type: "image", name: "flight.png", mimeType: "image/png", sizeBytes: 3 });
    expect(await sending).toBe("refused");
    expect(checks).toBe(kind === "question" ? 1 : 0);
    expect(control.calls.filter(call => call.body?.clientRequestId === requestId)).toEqual([]);
    expect(control.threads.get(id)!.messages).toHaveLength(1);
  } finally { upload.mockRestore(); }
});

test("steering files: cancellation aborts an upload already in flight", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Response>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/api/ardud/control/attachments") return Response.json({ ok: true, attachmentId: "file-1", relativeUrl: "/upload" });
    entered.resolve(); return release.promise;
  } });
  servers.push(server);
  const client = new ControlClient({ url: server.url.origin, token: "test-token" });
  const abort = new AbortController();
  const uploading = client.upload({ name: "file.bin", mimeType: "application/octet-stream", bytes: new Uint8Array([1]) }, abort.signal);
  await entered.promise; abort.abort();
  try { await expect(uploading).rejects.toThrow("Robob control request failed"); }
  finally { release.resolve(new Response("")); }
});


test("steering files: incomplete family lists are unknown to admission", async () => {
  const control = fakeControl(); const backend = control.backend();
  const { id, directory } = await backend.createChat();
  const list = spyOn(ControlClient.prototype, "listThreads").mockResolvedValue({ total: 501, threads: [] });
  try {
    await expect(backend.statuses(true)).rejects.toThrow("Incomplete active family discovery");
    await expect(backend.children(id, directory, true)).rejects.toThrow("Incomplete child discovery");
    expect(await backend.statuses()).toEqual({});
    expect(await backend.children(id, directory)).toEqual([]);
  } finally { list.mockRestore(); }
});

async function markerFixture(count = 1, running = false) {
  const control = fakeControl(); control.flags.markers = true;
  const backend = control.backend();
  const chats: Awaited<ReturnType<RobobBackend["createChat"]>>[] = [];
  for (let i = 0; i < count; i++) {
    const chat = await backend.createChat(); chats.push(chat);
    await backend.prompt(chat.id, chat.directory, `msg_${String(i).padStart(64, "0")}`, "hello");
    const thread = control.threads.get(chat.id)!;
    thread.driver = { instanceId: "codex", model: "test" };
    control.reply(chat.id, "original", running ? "running" : "completed");
    thread.evidence = running ? {} : { [thread.runs[0]!.runId]: "none" };
  }
  const tick = async () => {
    await backend.beginMessageTick(chats.map(chat => chat.id));
    return Promise.all(chats.map(chat => backend.messages(chat.id)));
  };
  await tick(); control.calls.length = 0;
  return { control, backend, chats, tick };
}

const pollingCalls = (calls: Call[]) => calls.filter(call => call.method === "GET" && (call.path.startsWith("/messages?") || call.path.startsWith("/threads?ids=") || call.path.includes("/messages?")));

async function withinDetailBound(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("detail preparation exceeded the shared deadline")), DETAIL_DEADLINE_MS + 500);
    })]);
  } finally { clearTimeout(timer); }
}

test("bounded details: one held chat defers without delaying another beyond the shared deadline", async () => {
  const { control, backend, chats } = await markerFixture(2, true);
  const [slow, healthy] = chats as [typeof chats[number], typeof chats[number]];
  const before = await backend.messages(slow.id), cache = backend["messageCache"];
  const checkpoint = cache["entries"].get(slow.id);
  control.reply(slow.id, "slow final", "completed"); control.reply(healthy.id, "healthy final", "completed");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), returned = Promise.withResolvers<void>();
  const read = backend.client.thread.bind(backend.client);
  const detail = spyOn(backend.client, "thread").mockImplementation(async (id, options) => {
    const result = await read(id, options);
    if (id === slow.id) { entered.resolve(); await release.promise; returned.resolve(); }
    return result;
  });
  const started = performance.now();
  let polling: Promise<void> | undefined;
  try {
    const rows = await captureLogs(async () => {
      polling = backend.beginMessageTick(chats.map(chat => chat.id));
      await entered.promise;
      await withinDetailBound(polling);
      expect(performance.now() - started).toBeLessThan(DETAIL_DEADLINE_MS + 500);
      expect(JSON.stringify(await backend.messages(healthy.id))).toContain("healthy final");
      expect(await backend.messages(slow.id)).toEqual(before);
      expect(await backend.messages(slow.id, slow.directory, { until: "not-in-old-cache" })).toEqual(before);
      expect(cache["entries"].get(slow.id)).toBe(checkpoint);
      await expect(backend.promptAccepted(slow.id, slow.directory, "unknown")).rejects.toBe(probeDeferred);
      expect(control.calls.filter(call => call.path === `/threads/${slow.id}`)).toHaveLength(1);
      expect(control.calls.filter(call => call.path.includes(`/threads/${slow.id}/messages`))).toHaveLength(0);
      const page = control.calls.find(call => call.path.startsWith("/messages?"))!;
      expect(new URL("http://test" + page.path).searchParams.get("threadIds")).toBe(healthy.id);
      release.resolve(); await returned.promise;
      expect(cache["entries"].get(slow.id)).toBe(checkpoint);
      await backend.beginMessageTick(chats.map(chat => chat.id));
      expect(JSON.stringify(await backend.messages(slow.id))).toContain("slow final");
      expect(cache["entries"].get(slow.id)?.marker).not.toBe(checkpoint?.marker);
      expect(control.calls.filter(call => call.path === `/threads/${slow.id}`)).toHaveLength(2);
    });
    expect(rows.find(row => row.name === "detail_deferred")?.props).toMatchObject({ reason: "timeout", streak: 1 });
    expect(rows.filter(row => row.name === "robob.message_reads").reduce((sum, row) => sum + Number(row.props?.detailDeferred ?? 0), 0)).toBe(1);
  } finally { release.resolve(); await polling; detail.mockRestore(); }
});

test("bounded details: five slow reads cost one deadline and cannot publish late", async () => {
  const { control, backend, chats } = await markerFixture(5, true);
  const cache = backend["messageCache"], checkpoints = chats.map(chat => cache["entries"].get(chat.id));
  for (const chat of chats) control.reply(chat.id, "late final", "completed");
  const release = Promise.withResolvers<void>(), reads: Promise<unknown>[] = [];
  const read = backend.client.thread.bind(backend.client);
  const detail = spyOn(backend.client, "thread").mockImplementation((id, options) => {
    const result = read(id, options).then(async response => { await release.promise; return response; });
    reads.push(result); return result;
  });
  const started = performance.now();
  let polling: Promise<void> | undefined;
  try {
    polling = backend.beginMessageTick(chats.map(chat => chat.id));
    await withinDetailBound(polling);
    expect(reads).toHaveLength(5);
    expect(performance.now() - started).toBeLessThan(DETAIL_DEADLINE_MS + 500);
    expect(pollingCalls(control.calls)).toHaveLength(1);
    expect(chats.map(chat => cache["entries"].get(chat.id))).toEqual(checkpoints);
    release.resolve(); await Promise.all(reads);
    expect(chats.map(chat => cache["entries"].get(chat.id))).toEqual(checkpoints);
  } finally { release.resolve(); await polling; await Promise.all(reads); detail.mockRestore(); }
});

test("bounded details: first-read timeout is uncertainty without a same-tick fallback", async () => {
  const control = fakeControl(); control.flags.markers = true;
  const backend = control.backend(), chat = await backend.createChat();
  await backend.prompt(chat.id, chat.directory, "original", "hello"); control.calls.length = 0;
  const release = Promise.withResolvers<void>();
  const read = backend.client.thread.bind(backend.client);
  const detail = spyOn(backend.client, "thread").mockImplementation(async (id, options) => { const result = await read(id, options); await release.promise; return result; });
  let polling: Promise<void> | undefined;
  try {
    polling = backend.beginMessageTick([chat.id]);
    await withinDetailBound(polling);
    await expect(backend.messages(chat.id)).rejects.toBe(probeDeferred);
    await expect(backend.promptAccepted(chat.id, chat.directory, "original")).rejects.toBe(probeDeferred);
    expect(backend["messageCache"]["entries"].has(chat.id)).toBe(false);
    expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(1);
    expect(pollingCalls(control.calls)).toHaveLength(1);
    release.resolve(); detail.mockRestore();
    await backend.beginMessageTick([chat.id]);
    expect(await backend.promptAccepted(chat.id, chat.directory, "original")).toBe(true);
  } finally { release.resolve(); await polling; detail.mockRestore(); }
});

test.each([new ControlError(500), new Error("failed detail")])("bounded details: failed reads keep committed pairs and log consecutive streaks (%s)", async failure => {
  const { control, backend, chats } = await markerFixture(1, true);
  const chat = chats[0]!, before = await backend.messages(chat.id);
  control.threads.get(chat.id)!.pending.push({ requestId: "pending", kind: "approval", requestKind: "command" });
  let failing = true;
  const read = backend.client.thread.bind(backend.client);
  const detail = spyOn(backend.client, "thread").mockImplementation((...args) => failing ? Promise.reject(failure) : read(...args));
  try {
    const rows = await captureLogs(async () => {
      for (let tick = 1; tick <= 6; tick++) {
        await backend.beginMessageTick([chat.id]);
        expect(await backend.messages(chat.id)).toEqual(before);
        expect(await backend.permissions(chat.id)).toEqual([]);
      }
      expect(detail).toHaveBeenCalledTimes(6);
      expect(pollingCalls(control.calls)).toHaveLength(6);
      failing = false;
      await backend.beginMessageTick([chat.id]);
      expect(await backend.permissions(chat.id)).toHaveLength(1);
      control.threads.get(chat.id)!.pending.push({ requestId: "next", kind: "approval", requestKind: "command" });
      failing = true;
      await backend.beginMessageTick([chat.id]);
    });
    expect(rows.filter(row => row.name === "detail_deferred").map(row => row.props?.streak)).toEqual([1, 2, 3, 4, 5, 6, 1]);
    expect(rows.find(row => row.name === "detail_deferred")?.props).toMatchObject({ reason: failure instanceof ControlError ? "status" : "error", elapsedMs: expect.any(Number), ...(failure instanceof ControlError ? { status: 500 } : {}) });
    expect(rows.filter(row => row.name === "detail_deferred_streak")).toHaveLength(1);
    expect(rows.find(row => row.name === "detail_deferred_streak")).toMatchObject({ level: "warn", props: { streak: 5 } });
    expect(rows.filter(row => row.name === "robob.message_reads").reduce((sum, row) => sum + Number(row.props?.detailDeferred ?? 0), 0)).toBe(7);
  } finally { detail.mockRestore(); }
});

test.each((["write", "read-version", "route"] as const).flatMap(invalidation => ["completed", "needs-input"].map(state => ({ invalidation, state }))))(
  "bounded checkpoint: $invalidation invalidation cannot mix $state metadata into a deferred transcript", async ({ invalidation, state }) => {
  const { control, backend, chats } = await markerFixture(1, true);
  const chat = chats[0]!, cache = backend["messageCache"], checkpoint = cache["entries"].get(chat.id);
  const before = await backend.messages(chat.id), thread = control.threads.get(chat.id)!;
  if (state === "completed") control.reply(chat.id, "finished", "completed");
  else thread.pending.push({ requestId: "pending-one", kind: "approval", requestKind: "command" });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const read = backend.client.crossThreadMessages.bind(backend.client);
  const page = spyOn(backend.client, "crossThreadMessages").mockImplementation(async args => {
    const result = await read(args); entered.resolve(); await release.promise; return result;
  });
  const polling = backend.beginMessageTick([chat.id]);
  try {
    await entered.promise;
    if (invalidation === "write") cache.afterWrite(chat.id);
    else if (invalidation === "route") cache.routeChange(chat.id);
    else cache["readVersions"].set(chat.id, (cache["readVersions"].get(chat.id) ?? 0) + 1);
    release.resolve(); await polling;
    // A metadata-only reader may cache this rejected capture for reuse, never for deferral.
    const rejected = await cache.detail(chat.id);
    expect(state === "completed" ? rejected.run?.status === "completed" : rejected.pendingRequests.length > 0).toBe(true);
    thread.pending.push({ requestId: "new-request", kind: "question", requestKind: "question" });
    const detail = spyOn(backend.client, "thread").mockRejectedValue(new ControlError(500));
    try {
      await backend.beginMessageTick([chat.id]);
      if (invalidation === "route") {
        await expect(backend.messages(chat.id)).rejects.toBe(probeDeferred);
      } else {
        expect(cache["entries"].get(chat.id)).toBe(checkpoint);
        expect((await cache.detail(chat.id)).run?.status).toBe("running");
        expect((await cache.detail(chat.id)).pendingRequests).toEqual([]);
        expect(await backend.messages(chat.id)).toEqual(before);
      }
      expect(detail).toHaveBeenCalledTimes(1);
      expect(control.calls.filter(call => call.path.includes(`/threads/${chat.id}/messages`))).toHaveLength(0);
    } finally { detail.mockRestore(); }
  } finally { release.resolve(); await polling; page.mockRestore(); }
});

test.each(["resync", "missing-until"] as const)("bounded checkpoint: %s rebuild retains its matching detail on deferral", async reason => {
  const { control, backend, chats } = await markerFixture(1, true);
  const chat = chats[0]!, cache = backend["messageCache"];
  await backend.beginMessageTick([chat.id]);
  control.reply(chat.id, "new partial", "running");
  if (reason === "resync") await cache.resync(chat.id, "redaction");
  else await cache.read(chat.id, "missing", () => false);
  const before = await backend.messages(chat.id), checkpoint = cache["entries"].get(chat.id);
  expect(JSON.stringify(before)).toContain("new partial");
  control.threads.get(chat.id)!.pending.push({ requestId: "pending", kind: "approval", requestKind: "command" });
  const detail = spyOn(backend.client, "thread").mockRejectedValue(new ControlError(500));
  try {
    await backend.beginMessageTick([chat.id]);
    expect(cache["entries"].get(chat.id)).toBe(checkpoint);
    expect(await backend.messages(chat.id)).toEqual(before);
    expect(await backend.permissions(chat.id)).toEqual([]);
    expect(detail).toHaveBeenCalledTimes(1);
  } finally { detail.mockRestore(); }
});

test.each((["approval", "question", "dismiss"] as const).flatMap(kind => [false, true].map(pending => ({ kind, pending }))))(
  "bounded reconciliation: $kind with prior pending=$pending rechecks deferral after preparation", async ({ kind, pending }) => {
  const { control, backend, chats, tick } = await markerFixture(1, true);
  const chat = chats[0]!, thread = control.threads.get(chat.id)!, cache = backend["messageCache"];
  if (pending) {
    thread.pending.push({ requestId: "target", kind: kind === "approval" ? "approval" : "question", requestKind: "command" });
    await tick();
    thread.pending.length = 0;
  } else thread.pending.push({ requestId: "target", kind: kind === "approval" ? "approval" : "question", requestKind: "command" });
  const failed = Promise.withResolvers<Awaited<ReturnType<ControlClient["thread"]>>>();
  const started = Promise.withResolvers<void>();
  const detail = spyOn(backend.client, "thread").mockImplementation(() => { started.resolve(); return failed.promise; });
  const entered = Promise.withResolvers<void>(), read = cache.detail.bind(cache);
  const reader = spyOn(cache, "detail").mockImplementation(id => { entered.resolve(); return read(id); });
  const polling = backend.beginMessageTick([chat.id]);
  await started.promise;
  const resolving = backend.responseResolved(chat.id, chat.directory, "target").then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
  try {
    await entered.promise;
    failed.reject(new ControlError(500));
    await polling;
    expect((await resolving).error).toBe(probeDeferred);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(control.calls.filter(call => call.method === "POST" && call.path.endsWith("/respond"))).toHaveLength(0);
  } finally { failed.reject(new ControlError(500)); await polling; await resolving; reader.mockRestore(); detail.mockRestore(); }
  await tick();
  expect(await backend.responseResolved(chat.id, chat.directory, "target")).toBe(pending);
});

test.each((["root", "child"] as const).flatMap(target => ["question", "permission"].map(kind => ({ target, kind }))))(
  "marker polling: $target $kind response fences replies at its correct write boundary", async ({ target, kind }) => {
  const { control, backend, chats, tick } = await markerFixture(2, true);
  const parent = chats[0]!, destination = target === "root" ? parent : chats[1]!;
  if (target === "child") control.threads.get(destination.id)!.parentThreadId = parent.id;
  control.threads.get(destination.id)!.pending.push({ requestId: "pending-one", kind: kind === "question" ? "question" : "approval", requestKind: "command",
    questions: [{ id: "q1", header: "Choose", question: "Which?", options: [{ label: "yes" }] }] });
  await tick();
  const store = new Store(":memory:"); stores.push(store);
  const turn = { ...parent, generation: 1, phase: "running" as const, messageId: `msg_${"0".repeat(64)}`, startedAt: 0 };
  store.set("route", { ...parent, generation: 1 }); store.set("activeTurn", turn);
  store.acceptInbound("answer", { id: "answer", text: "yes", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() });
  store.updateInbound("answer", "processing");
  const router = new Router(store, backend, { async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); } }, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/test/imessage", alertSkillPath: "/test/telegram", alertSocketPath: "/test/socket", openCodeConfigRoot: "/nonexistent",
  });
  const request = kind === "question" ? (await backend.questions(destination.id))[0]! : (await backend.permissions(destination.id))[0]!;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const respond = backend.client.respond.bind(backend.client);
  const held = spyOn(backend.client, "respond").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return respond(...args); });
  const sending = backend.messageReadScope(() => router["postResponse"]("answer", turn, destination.id, destination.directory, request.id, {
    request, answers: kind === "question" ? [["yes"]] : [], decision: "once", outbox: 0,
  }));
  try {
    await entered.promise;
    control.reply(parent.id, "finished while response waited", "completed");
    await tick();
    const records = await backend.messages(parent.id);
    const reply = records.find(record => record.type === "assistant" && JSON.stringify(record).includes("finished while response waited"))!;
    expect(reply).toBeDefined();
    release.resolve(); await sending;
    const before = store.get<string[]>("human-response-before:answer");
    expect(before?.includes(reply.id)).toBe(target === "child");
    expect(router["replyCoverage"](turn, records, reply.id, ["answer"], new Set())).toEqual(target === "child" ? [] : ["answer"]);
    expect(control.calls.filter(call => call.method === "POST" && call.path.endsWith("/respond"))).toHaveLength(1);
  } finally { release.resolve(); await sending; held.mockRestore(); }
});

test.each(["idle", "active", "steer"])("marker polling: five-thread 60-second router budget (%s)", async scenario => {
  const measuredAt = performance.now(), timings = { markerMs: 0, completionMs: 0, routerMs: 0 };
  const timed = async (field: keyof typeof timings, work: () => Promise<void>) => {
    const at = performance.now();
    try { await work(); } finally { timings[field] += performance.now() - at; }
  };
  const start = Date.parse("2026-11-15T09:30:00Z"); setSystemTime(start);
  const control = fakeControl(); control.flags.markers = true;
  const backend = control.backend();
  const chats: Awaited<ReturnType<RobobBackend["createChat"]>>[] = [];
  for (let i = 0; i < 5; i++) {
    const chat = await backend.createChat(); chats.push(chat);
    const thread = control.threads.get(chat.id)!;
    thread.driver = { instanceId: "codex", model: "test" };
    await backend.prompt(chat.id, chat.directory, `msg_${"0".repeat(64)}`, "history");
    for (let row = 0; row < 100; row++) thread.messages.push({ messageId: `history-${row}`, role: "assistant", phase: "narration", text: "old text ".repeat(100),
      runId: thread.runs[0]!.runId, streaming: false, createdAt: new Date(start - 200_000 + row * 1000).toISOString(), updatedAt: new Date(start - 200_000 + row * 1000).toISOString() });
    thread.messages[0]!.createdAt = thread.messages[0]!.updatedAt = new Date(start - 120_000).toISOString();
    thread.runs[0]!.status = "completed";
  }
  await backend.beginMessageTick(chats.map(chat => chat.id));
  const lanes = chats.map(chat => {
    const store = new Store(":memory:"); stores.push(store);
    store.set("route", { ...chat, generation: 1 });
    const router = new Router(store, backend, { async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); } }, {
      owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/test/skill", alertSkillPath: "/test/alert",
      alertSocketPath: "/test/socket", openCodeConfigRoot: "/nonexistent", quietMs: 0, watchMs: 5_000,
    });
    return { chat, store, router, thread: control.threads.get(chat.id)! };
  });
  if (scenario !== "idle") for (const { chat, store, router, thread } of lanes) {
    store.acceptInbound("budget", { id: "budget", text: "hello", attachments: [], isAudioMessage: false, source: "typed", receivedAt: start });
    await router.tick();
    thread.messages.push({ messageId: `stream-${chat.id}`, role: "assistant", phase: "narration", text: "working", streaming: true,
      runId: thread.runs.at(-1)!.runId, createdAt: new Date(start + 500).toISOString(), updatedAt: new Date(start + 500).toISOString() });
  }
  control.calls.length = 0;
  let completionSecond = 0;
  for (let second = 1; second <= 60; second++) {
    setSystemTime(start + second * 1000);
    for (const { chat, store, thread } of lanes) {
      const stream = thread.messages.find(message => message.messageId === `stream-${chat.id}`);
      if (stream && second < 50) { stream.text += "."; stream.updatedAt = new Date().toISOString(); }
      if (second === 30 && scenario === "steer") store.acceptInbound("budget-steer", { id: "budget-steer", text: "also this", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() });
      if (second === 50 && scenario !== "idle") control.reply(chat.id, "done", "completed");
    }
    const from = control.calls.length;
    await timed("markerMs", () => backend.beginMessageTick(chats.map(chat => chat.id)));
    for (const { router } of lanes) { await timed("completionMs", () => router.checkCompletion()); await timed("routerMs", () => router.tick()); }
    const calls = pollingCalls(control.calls.slice(from));
    expect(calls.length).toBeLessThanOrEqual(scenario === "idle" ? 1 : 2);
    if (!completionSecond && scenario !== "idle" && lanes.every(({ store }) => store.pendingOutbox().some(op => op.kind === "conversation" && op.text === "done"))) completionSecond = second;
  }
  if (scenario !== "idle") expect(completionSecond).toBe(50);
  const gets = control.calls.filter(call => call.method === "GET");
  console.log("marker-five-thread-budget", JSON.stringify({ scenario, durationMs: performance.now() - measuredAt, ...timings, polling: pollingCalls(gets).length,
    markers: gets.filter(call => call.path.startsWith("/threads?ids=")).length, messages: gets.filter(call => call.path.startsWith("/messages?")).length,
    detail: gets.filter(call => /^\/threads\/[^/?]+$/.test(call.path)).length, evidence: gets.filter(call => call.path.endsWith("/evidence")).length,
    discovery: gets.filter(call => call.path.startsWith("/threads?") && !call.path.startsWith("/threads?ids=")).length, completionSecond }));
});

test("marker polling: run completion without a message is visible on the next tick", async () => {
  const start = Date.now(); setSystemTime(start);
  const { control, backend, chats, tick } = await markerFixture(1, true);
  const thread = control.threads.get(chats[0]!.id)!;
  const before = await tick(); expect(before[0]!.some(record => record.type === "idle")).toBe(false);
  thread.runs[0]!.status = "completed";
  setSystemTime(start + 1000);
  control.calls.length = 0;
  const after = await tick(); expect(after[0]!.some(record => record.type === "idle")).toBe(true);
  expect(after[0]).toEqual(await control.backend().messages(chats[0]!.id));
  expect(pollingCalls(control.calls).filter(call => call.path.startsWith("/messages?"))).toHaveLength(1);
  expect(control.calls.filter(call => call.path === `/threads/${chats[0]!.id}`)).toHaveLength(2); // One detail per backend, including the reference read.
  expect(await backend.promptAccepted(chats[0]!.id, chats[0]!.directory, "absent")).toBe(false);
});

test("marker polling: five unchanged threads cost one polling GET including all router read forms", async () => {
  const { control, backend, chats, tick } = await markerFixture(5);
  for (let i = 0; i < 4; i++) {
    control.calls.length = 0;
    await tick();
    for (const chat of chats) {
      await backend.messageReadScope(async () => {
        for (const options of [{ limit: 1 }, { limit: 20 }, { limit: 100 }, { until: "msg_" + String(chats.indexOf(chat)).padStart(64, "0") }]) await backend.messages(chat.id, chat.directory, options);
      });
      expect(await backend.promptAccepted(chat.id, chat.directory, "msg_" + String(chats.indexOf(chat)).padStart(64, "0"))).toBe(true);
    }
    expect(pollingCalls(control.calls)).toHaveLength(1);
    expect(control.calls.filter(call => call.method === "GET")).toHaveLength(1);
    expect(control.calls[0]!.path).not.toContain("updatedSince");
    expect(control.calls[0]!.path).toContain("%2C");
  }
});

test("marker polling: tied updates, system rows and paging remain deep-equal", async () => {
  const { control, backend, chats, tick } = await markerFixture(5);
  control.flags.pageSize = 2;
  const chat = chats[0]!, thread = control.threads.get(chat.id)!;
  const row = thread.messages[1]!;
  for (const text of ["tie-one", "tie-two"]) {
    row.text = text;
    thread.messages.push({ ...row, messageId: text, role: "system", text: "never deliver" });
    control.calls.length = 0;
    const result = await tick();
    expect(result[0]).toEqual(await control.backend().messages(chat.id));
    expect(JSON.stringify(result[0])).toContain(text);
    expect(JSON.stringify(result[0])).not.toContain("never deliver");
    expect(control.calls.filter(call => call.path.startsWith("/threads?ids="))).toHaveLength(1);
    expect(control.calls.filter(call => call.path.startsWith("/messages?")).length).toBeGreaterThanOrEqual(2);
  }
  expect(await backend.promptAccepted(chat.id, chat.directory, "absent")).toBe(false);
});

test("marker polling: page-two failure retries the old watermark and marker without partial cache commits", async () => {
  const { control, chats, tick } = await markerFixture();
  control.flags.pageSize = 1;
  const thread = control.threads.get(chats[0]!.id)!;
  thread.messages[1]!.text = "changed";
  control.flags.page2Status = 500;
  const fallback = await tick();
  expect(fallback[0]).toEqual(await control.backend().messages(chats[0]!.id));
  const first = control.calls.find(call => call.path.startsWith("/messages?"))!;
  const oldSince = new URL("http://test" + first.path).searchParams.get("since");
  control.flags.page2Status = 0; control.calls.length = 0;
  const retry = await tick();
  expect(retry[0]).toEqual(fallback[0]);
  const replay = control.calls.find(call => call.path.startsWith("/messages?"))!;
  expect(new URL("http://test" + replay.path).searchParams.get("since")).toBe(oldSince);
  control.calls.length = 0; await tick();
  expect(pollingCalls(control.calls)).toHaveLength(1);
});

test.each([false, true])("marker polling: completion during the message drain cannot seal earlier text (model error=%s)", async modelError => {
  const control = fakeControl(); control.flags.markers = true;
  const alerts: string[] = [];
  const backend = control.backend("/chats", { alert: async (_id, text) => { alerts.push(text); return true; } });
  const store = new Store(":memory:"); stores.push(store); backend.trackFirstTurns(store);
  const chat = await backend.createChat();
  await backend.prompt(chat.id, chat.directory, `msg_${"a".repeat(64)}`, "hello");
  const thread = control.threads.get(chat.id)!;
  thread.driver = { instanceId: "codex", model: "test" };
  control.reply(chat.id, "partial", "running");
  const read = backend.client.crossThreadMessages.bind(backend.client);
  const cross = spyOn(backend.client, "crossThreadMessages").mockImplementationOnce(async options => {
    const response = await read(options);
    control.reply(chat.id, modelError ? "There's an issue with the selected model (bad)." : "finished", "completed");
    return response;
  });
  try {
    await backend.beginMessageTick([chat.id]);
    const during = await backend.messages(chat.id);
    expect(during.some(record => record.type === "idle")).toBe(false);
    expect(alerts).toHaveLength(0);
    expect(store.get("firstTurns")).toMatchObject([{ id: chat.id, alert: null }]);
    expect(control.calls.filter(call => call.method === "GET" && call.path === `/threads/${chat.id}`)).toHaveLength(1);
    await backend.beginMessageTick([chat.id]);
    const after = await backend.messages(chat.id);
    expect(after.find(record => record.type === "idle")).toMatchObject({ outcome: modelError ? "failed" : "succeeded" });
    expect(alerts).toHaveLength(modelError ? 1 : 0);
    if (modelError) expect(alerts[0]).toContain("selected model");
    else expect(JSON.stringify(after)).toContain("finished");
  } finally { cross.mockRestore(); }
});

test("marker polling: archived omissions retry failed pages before stopping marker tracking", async () => {
  const { control, backend, chats, tick } = await markerFixture();
  const chat = chats[0]!;
  control.flags.omit.add(chat.id); control.threads.get(chat.id)!.archived = true;
  control.reply(chat.id, "final archive reply", "completed");
  control.flags.pageSize = 1; control.flags.page2Status = 500;
  await backend.beginMessageTick([chat.id]);
  control.calls.length = 0; control.flags.page2Status = 0;
  const repaired = await tick();
  expect(JSON.stringify(repaired)).toContain("final archive reply");
  expect(control.calls.filter(call => call.path.startsWith("/threads?ids="))).toHaveLength(1);
  expect(control.calls.filter(call => call.path.startsWith("/messages?")).length).toBeGreaterThan(1);
  control.calls.length = 0;
  expect(await tick()).toEqual(repaired);
  expect(pollingCalls(control.calls)).toHaveLength(0);
});

const malformedMessageRows: Array<{ name: string; patch: Record<string, unknown> | null }> = [
  { name: "null row", patch: null },
  ...["threadId", "messageId", "runId", "role", "text", "streaming", "createdAt", "updatedAt"].map(field => ({ name: `missing ${field}`, patch: { [field]: undefined } })),
  ...["threadId", "messageId", "runId"].map(field => ({ name: `empty ${field}`, patch: { [field]: "" } })),
  ...["threadId", "messageId", "runId", "text", "createdBy", "creationSource"].map(field => ({ name: `numeric ${field}`, patch: { [field]: 1 } })),
  { name: "unknown thread", patch: { threadId: "unrequested-thread" } },
  { name: "invalid role", patch: { role: "tool" } },
  { name: "invalid phase", patch: { phase: "final" } },
  { name: "string streaming", patch: { streaming: "false" } },
  ...["createdAt", "updatedAt"].flatMap(field => [null, "invalid"].map(value => ({ name: `${field}=${value}`, patch: { [field]: value } }))),
];

test.each(malformedMessageRows)("marker polling: malformed $name falls back and retries the old checkpoint", async ({ patch }) => {
  const { control, backend, chats, tick } = await markerFixture();
  const chat = chats[0]!, thread = control.threads.get(chat.id)!;
  thread.messages[1]!.text = "valid change";
  const read = backend.client.crossThreadMessages.bind(backend.client);
  let since: string | number | undefined;
  const cross = spyOn(backend.client, "crossThreadMessages").mockImplementationOnce(async options => {
    since = options.since;
    const response = await read(options);
    const row = patch === null ? null : { ...response.messages[0]!, ...patch };
    return { ...response, messages: [row] } as typeof response;
  });
  try {
    const fallback = await tick();
    expect(fallback[0]).toEqual(await control.backend().messages(chat.id));
    expect(control.calls.filter(call => call.path.includes(`/threads/${chat.id}/messages?`))).toHaveLength(2);
    control.calls.length = 0;
    expect(await tick()).toEqual(fallback);
    const replay = control.calls.find(call => call.path.startsWith("/messages?"))!;
    expect(new URL("http://test" + replay.path).searchParams.get("since")).toBe(String(since));
    control.calls.length = 0; await tick();
    expect(pollingCalls(control.calls)).toHaveLength(1);
  } finally { cross.mockRestore(); }
});

test.each(["500", "old-server", "cross-400", "cross-404", "cross-500"])("marker polling: %s falls back without skipping threads", async fault => {
  const { control, chats, tick } = await markerFixture(5);
  if (fault === "500") control.flags.markerStatus = 500;
  else if (fault === "old-server") control.flags.missingMarker = true;
  else control.flags.crossStatus = Number(fault.slice(6));
  for (const chat of chats) control.threads.get(chat.id)!.messages[1]!.text = "after-fault";
  const result = await tick();
  for (let i = 0; i < chats.length; i++) expect(result[i]).toEqual(await control.backend().messages(chats[i]!.id));
  expect(control.calls.filter(call => call.path.includes("/messages?")).length).toBeGreaterThanOrEqual(5);
});

test("marker polling: decrease, omission, redaction resync, missing anchor and route change rebuild", async () => {
  const start = Date.now(); setSystemTime(start);
  const { control, backend, chats, tick } = await markerFixture();
  const chat = chats[0]!, thread = control.threads.get(chat.id)!;
  const full = () => control.calls.filter(call => call.path.startsWith("/messages?") && new URL("http://test" + call.path).searchParams.get("since") === "-8640000000000000");
  control.flags.override.set(chat.id, 0); await tick(); expect(full()).toHaveLength(1);
  control.calls.length = 0; await tick(); expect(full()).toHaveLength(0);
  control.flags.omit.add(chat.id); await tick(); expect(full()).toHaveLength(1);
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(1);
  control.flags.omit.clear(); control.calls.length = 0;
  thread.messages[1]!.text = "redacted";
  setSystemTime(start + 10 * 60_000); const rebuilt = await tick();
  expect(JSON.stringify(rebuilt)).toContain("redacted"); expect(full()).toHaveLength(1);
  control.calls.length = 0;
  await tick(); await backend.messages(chat.id, chat.directory, { until: "missing" });
  await backend.messages(chat.id, chat.directory, { until: "missing" });
  expect(full()).toHaveLength(1);
  control.calls.length = 0; await backend.retireOthers(chat.id); await tick(); expect(full()).toHaveLength(1);
});

test("marker polling: evidence is fresh each tick and shared once per run; promptAccepted adds no GET", async () => {
  const { control, backend, chats, tick } = await markerFixture(1, true);
  const chat = chats[0]!, thread = control.threads.get(chat.id)!;
  thread.runs[0]!.status = "running"; thread.evidence = {};
  await tick(); control.calls.length = 0;
  await tick(); await backend.messages(chat.id); await backend.messages(chat.id);
  expect(control.calls.filter(call => call.path.endsWith("/evidence"))).toHaveLength(1);
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(0);
  const gets = control.calls.filter(call => call.method === "GET").length;
  const prompt = `msg_${"f".repeat(64)}`;
  await backend.steer(chat.id, chat.directory, prompt, "also this");
  expect(await backend.promptAccepted(chat.id, chat.directory, prompt)).toBe(true);
  expect(control.calls.filter(call => call.method === "GET")).toHaveLength(gets);
  thread.evidence = { [thread.runs[0]!.runId]: "ran" };
  const next = await tick(); expect(next[0]!.some(record => record.type === "assistant" && record.toolEvidence === "ran")).toBe(true);
});

test("marker polling: chunks at 50, including rebuilds, and uses the oldest observed watermark", async () => {
  const { control, chats, tick } = await markerFixture(51);
  await tick();
  expect(control.calls.filter(call => call.path.startsWith("/threads?ids="))).toHaveLength(2);
  expect(pollingCalls(control.calls)).toHaveLength(2);
  control.calls.length = 0;
  const watermark = Math.min(...chats.map(chat => Math.max(...control.threads.get(chat.id)!.messages.map(message => Date.parse(message.updatedAt!))))) - 30_000;
  for (const chat of chats) control.threads.get(chat.id)!.messages[1]!.text += " changed";
  await tick();
  const pages = control.calls.filter(call => call.path.startsWith("/messages?"));
  expect(pages).toHaveLength(2);
  expect(new URL("http://test" + pages[0]!.path).searchParams.get("since")).toBe(String(watermark));
  for (const call of control.calls.filter(call => call.path.startsWith("/threads?ids=") || call.path.startsWith("/messages?"))) {
    const query = new URL("http://test" + call.path).searchParams;
    const ids = (query.get("ids") ?? query.get("threadIds"))!.split(",");
    expect(ids.length).toBeLessThanOrEqual(50); expect(ids.every(Boolean)).toBe(true);
  }
});

test("marker polling: poll counters, per-tick attribution and fallback reasons survive logging", async () => {
  const root = mkdtempSync(join(tmpdir(), "marker-reads-log-")); dirs.push(root);
  const log = createToolLog({ root, now: () => Date.parse("2026-11-18T04:00:01Z") });
  log.write({ component: "robob", kind: "perf", name: "robob.messages_read", ids: { threadId: "thread-one", tickId: "tick-one", callBatchId: "batch-one" },
    props: { markerPolls: 1, crossThreadReads: 1, crossThreadPages: 2, markerSkips: 3, fallbacks: 1, fallbackReason: "cross-thread-error", evidenceReads: 4, detailReads: 1, discoveryReads: 2, rowsReturned: 9, bytesReturned: 321 } });
  log.flush();
  const rows = readFileSync(join(root, "2026-11-18.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const detail = rows.find(line => line.name === "robob.messages_read")!;
  expect(detail.ids).toMatchObject({ threadId: "thread-one", tickId: "tick-one", callBatchId: "batch-one" });
  expect(detail.props.fallbackReason).toBe("cross-thread-error");
  expect(rows.find(line => line.name === "robob.message_reads")!.props).toMatchObject({ markerPolls: 1, crossThreadReads: 1, crossThreadPages: 2,
    markerSkips: 3, fallbacks: 1, evidenceReads: 4, detailReads: 1, discoveryReads: 2, rowsReturned: 9, bytesReturned: 321 });
});

test("marker polling: archived omissions stop tracking without replacing history with an empty transcript", async () => {
  const { control, chats, tick } = await markerFixture();
  const chat = chats[0]!;
  control.flags.omit.add(chat.id); control.threads.get(chat.id)!.archived = true;
  const before = await tick();
  control.calls.length = 0;
  expect(await tick()).toEqual(before);
  expect(pollingCalls(control.calls)).toHaveLength(0);
});

test("marker polling: needs-input reads one fresh detail and marker timeouts use the per-thread path", async () => {
  const { control, backend, chats, tick } = await markerFixture();
  const chat = chats[0]!;
  control.threads.get(chat.id)!.pending.push({ requestId: "approval-one", kind: "approval", requestKind: "command", prompt: "Allow command?" });
  await tick();
  expect(await backend.sessionBusy(chat.id)).toBe(true);
  expect(await backend.permissions(chat.id)).toHaveLength(1);
  await backend.messages(chat.id);
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(1);
  control.calls.length = 0;
  const marker = spyOn(backend.client, "threadSummaries").mockRejectedValueOnce(new ControlError(0));
  try {
    const fallback = await tick();
    expect(fallback[0]).toEqual(await control.backend().messages(chat.id));
    expect(control.calls.some(call => call.path.startsWith(`/threads/${chat.id}/messages?`))).toBe(true);
  } finally { marker.mockRestore(); }
});

test("marker polling: sibling chat backends share the marker pass and native aliases", async () => {
  const { control, backend, chats } = await markerFixture(2);
  const sibling = backend.forChat("chats/friend", "Friend");
  control.natives.set("ses_friend", chats[1]!.id);
  await sibling.resolve("ses_friend");
  control.calls.length = 0;
  await backend.beginMessageTick([chats[0]!.id, "ses_friend"]);
  await backend.messages(chats[0]!.id); await sibling.messages("ses_friend");
  expect(pollingCalls(control.calls)).toHaveLength(1);
  expect(new URL("http://test" + pollingCalls(control.calls)[0]!.path).searchParams.get("ids")).toBe(chats.map(chat => chat.id).join(","));
});

test.each([
  ...["queued", "waiting", "running"].flatMap(prior => ["completed", "failed", "cancelled", "interrupted", "rolled_back"].map(status => ({ prior, status }))),
  ...["completed", "failed", "cancelled", "interrupted"].map(prior => ({ prior, status: "rolled_back" })),
])
  ("marker polling: retained $prior run becoming $status refreshes exact detail", async ({ prior, status }) => {
  const { control, backend, chats, tick } = await markerFixture(1, true);
  const chat = chats[0]!, thread = control.threads.get(chat.id)!;
  thread.runs[0]!.status = prior;
  await backend.prompt(chat.id, chat.directory, `msg_${"f".repeat(64)}`, "latest");
  control.reply(chat.id, "latest partial", "running");
  const before = await tick(); control.calls.length = 0;
  if (prior === "completed") expect(before[0]!.find(record => record.id === `idle:${thread.runs[0]!.runId}`)).toMatchObject({ outcome: "succeeded" });
  thread.runs[0]!.status = status;
  const result = await tick();
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(1);
  for (const options of [{ limit: 1 }, { limit: 100 }, { until: `msg_${"0".repeat(64)}`, limit: 20 }, { since: 0, limit: 100 }]) {
    expect(await backend.messages(chat.id, chat.directory, options)).toEqual(await control.backend().messages(chat.id, chat.directory, options));
  }
  expect(result[0]!.find(record => record.id === `idle:${thread.runs[0]!.runId}`)).toMatchObject({
    outcome: status === "completed" ? "succeeded" : status === "failed" ? "failed" : "interrupted",
  });
  control.calls.length = 0; await tick();
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(0);
});

test.each(["retained rollback", "latest completion", "pending request"].flatMap(event => [false, true].map(omitted => ({ event, omitted }))))
  ("marker polling: detail marker race repairs $event on the next tick (omitted=$omitted)", async ({ event, omitted }) => {
  const { control, backend, chats, tick } = await markerFixture();
  const chat = chats[0]!, thread = control.threads.get(chat.id)!;
  await backend.prompt(chat.id, chat.directory, `msg_${"f".repeat(64)}`, "latest");
  control.reply(chat.id, "latest partial", "running");
  await tick();
  thread.messages[1]!.text = "changed before detail";
  if (omitted) control.flags.omit.add(chat.id);
  control.flags.afterDetailRecords = current => {
    if (event === "retained rollback") current.runs[0]!.status = "rolled_back";
    else if (event === "latest completion") current.runs.at(-1)!.status = "completed";
    else current.pending.push({ requestId: "raced-approval", kind: "approval", requestKind: "command", prompt: "Allow?" });
  };
  control.calls.length = 0;
  const captured = await tick();
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(1);
  if (event === "retained rollback") expect(captured[0]!.find(record => record.id === `idle:${thread.runs[0]!.runId}`)).toMatchObject({ outcome: "succeeded" });
  control.calls.length = 0; control.flags.omit.clear();
  const repaired = await tick();
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(1);
  expect(pollingCalls(control.calls)).toHaveLength(2);
  if (event === "pending request") expect(await backend.permissions(chat.id)).toHaveLength(1);
  for (const options of [{ limit: 1 }, { limit: 100 }, { until: `msg_${"0".repeat(64)}`, limit: 20 }, { since: 0, limit: 100 }]) {
    expect(await backend.messages(chat.id, chat.directory, options)).toEqual(await control.backend().messages(chat.id, chat.directory, options));
  }
  if (event === "retained rollback") expect(repaired[0]!.find(record => record.id === `idle:${thread.runs[0]!.runId}`)).toMatchObject({ outcome: "interrupted" });
  control.calls.length = 0; await tick();
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(0);
  expect(pollingCalls(control.calls)).toHaveLength(1);
});

test("marker polling: an omitted first summary cannot certify a raced detail marker", async () => {
  const { control, backend, chats } = await markerFixture();
  const chat = chats[0]!, thread = control.threads.get(chat.id)!;
  await backend.prompt(chat.id, chat.directory, `msg_${"f".repeat(64)}`, "latest");
  const reader = control.backend();
  control.flags.omit.add(chat.id);
  control.flags.afterDetailRecords = current => { current.runs[0]!.status = "rolled_back"; };
  await reader.beginMessageTick([chat.id]);
  expect((await reader.messages(chat.id)).find(record => record.id === `idle:${thread.runs[0]!.runId}`)).toMatchObject({ outcome: "succeeded" });
  control.flags.omit.clear(); control.calls.length = 0;
  await reader.beginMessageTick([chat.id]);
  const repaired = await reader.messages(chat.id);
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(1);
  expect(pollingCalls(control.calls)).toHaveLength(2);
  expect(repaired).toEqual(await control.backend().messages(chat.id));
  expect(repaired.find(record => record.id === `idle:${thread.runs[0]!.runId}`)).toMatchObject({ outcome: "interrupted" });
  control.calls.length = 0; await reader.beginMessageTick([chat.id]); await reader.messages(chat.id);
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(0);
  expect(pollingCalls(control.calls)).toHaveLength(1);
});

test.each(["marker", "page"])("marker polling: raced fallback detail after a %s failure cannot replace the committed boundary", async fault => {
  const { control, backend, chats, tick } = await markerFixture();
  const chat = chats[0]!, thread = control.threads.get(chat.id)!;
  await backend.prompt(chat.id, chat.directory, `msg_${"f".repeat(64)}`, "latest");
  await tick();
  thread.messages[1]!.text = "trigger detail";
  if (fault === "marker") control.flags.markerStatus = 500;
  else { control.flags.pageSize = 1; control.flags.page2Status = 500; }
  control.flags.afterDetailRecords = current => { current.runs[0]!.status = "rolled_back"; };
  const fallback = await tick();
  expect(fallback[0]!.find(record => record.id === `idle:${thread.runs[0]!.runId}`)).toMatchObject({ outcome: "succeeded" });
  control.flags.markerStatus = 0; control.flags.page2Status = 0; control.flags.pageSize = 1000; control.calls.length = 0;
  const repaired = await tick();
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(1);
  expect(repaired[0]).toEqual(await control.backend().messages(chat.id));
  expect(repaired[0]!.find(record => record.id === `idle:${thread.runs[0]!.runId}`)).toMatchObject({ outcome: "interrupted" });
  control.calls.length = 0; await tick();
  expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(0);
  expect(pollingCalls(control.calls)).toHaveLength(1);
});

test.each([false, true])("marker polling: Router tick deferral releases probe leases without backoff (landed=%s)", async landed => {
  const start = Date.parse("2026-11-18T03:00:00Z"); setSystemTime(start);
  const { control, backend, chats } = await markerFixture(1, true);
  const chat = chats[0]!, id = "deferred-admission";
  const prompt = `msg_${createHash("sha256").update(id).digest("hex")}`;
  const store = new Store(":memory:"); stores.push(store);
  store.set("route", { ...chat, generation: 1 });
  store.acceptInbound(id, { id, text: "Please check", source: "typed", attachments: [], isAudioMessage: false, receivedAt: start - 120_000 });
  store.updateInbound(id, "processing");
  store.set(`failed-delivery:${id}`, { ...chat, generation: 1, inboundId: id, messageId: prompt, startedAt: start - 120_000, phase: "unknown" });
  const lines: Parameters<typeof toolLog.write>[0][] = [];
  const log = spyOn(toolLog, "write").mockImplementation(line => { lines.push(line); });
  const router = new Router(store, backend, { async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); } }, {
    owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/test/skill", alertSkillPath: "/test/alert",
    alertSocketPath: "/test/socket", openCodeConfigRoot: "/nonexistent", quietMs: 0, watchMs: 0,
  });
  const request = backend.client.request.bind(backend.client), lost = new ControlError(0);
  const post = spyOn(backend.client, "request").mockImplementation(async function<T>(...args: Parameters<ControlClient["request"]>): Promise<T> {
    if (args[0] !== "POST" || !args[1].endsWith("/send")) return request<T>(...args);
    if (landed) await request<T>(...args); throw lost;
  });
  try {
    await expect(backend.prompt(chat.id, chat.directory, prompt, "Please check")).rejects.toBe(lost);
    await router.checkInboundLatency(); await router.checkInboundLatency();
    for (const key of [id, `prompt:${chat.id}:${prompt}`]) expect(store.get(`replay-probe-backoff:${key}`)).toMatchObject({ delay: 0, nextAt: 0 });
    expect(lines.filter(line => line.name === "router.probe_backoff")).toHaveLength(0);
    expect(lines.filter(line => line.name === "router.prompt_probe")).toHaveLength(0);
    setSystemTime(start + 1000); await backend.beginMessageTick([chat.id]);
    await router.checkInboundLatency();
    expect(lines.filter(line => line.name === "router.prompt_probe").map(line => line.props?.probeOutcome)).toEqual([landed ? "accepted" : "notAcceptedYet"]);
    expect(lines.filter(line => line.name === "router.probe_backoff")).toHaveLength(0);
    expect(await backend.promptAccepted(chat.id, chat.directory, prompt)).toBe(landed);
    expect(control.calls.filter(call => call.path.endsWith("/send") && call.body.clientRequestId === prompt)).toHaveLength(landed ? 1 : 0);
  } finally { post.mockRestore(); log.mockRestore(); }
});

test.each((["auto", "steer"] as const).flatMap(mode => [false, true].flatMap(landed => [0, 500, 503].map(status => ({ mode, landed, status })))))
  ("marker polling: ambiguous $mode ($status, landed=$landed) waits for the next snapshot without another GET", async ({ mode, landed, status }) => {
  const { control, backend, chats, tick } = await markerFixture(1, true);
  const chat = chats[0]!, prompt = `msg_${"f".repeat(64)}`;
  const request = backend.client.request.bind(backend.client);
  const lost = new ControlError(status, "unavailable", status === 503 ? { reason: "reader_unavailable", retrySafe: false } : {});
  let posts = 0;
  const post = spyOn(backend.client, "request").mockImplementation(async function<T>(...args: Parameters<ControlClient["request"]>): Promise<T> {
    if (args[0] !== "POST" || !args[1].endsWith("/send")) return request<T>(...args);
    posts++;
    if (landed) await request<T>(...args);
    throw lost;
  });
  try {
    const sending = mode === "auto" ? backend.prompt(chat.id, chat.directory, prompt, "follow up") : backend.steer(chat.id, chat.directory, prompt, "follow up");
    await expect(sending).rejects.toBe(lost);
    expect(lost.reconciled).not.toBe(true);
    await expect(backend.promptAccepted(chat.id, chat.directory, prompt)).rejects.toBe(probeDeferred);
    expect(control.calls.filter(call => call.method === "GET")).toHaveLength(0);
    await tick();
    expect(await backend.promptAccepted(chat.id, chat.directory, prompt)).toBe(landed);
    expect(pollingCalls(control.calls).length).toBeLessThanOrEqual(2);
    expect(posts).toBe(1);
    expect(control.threads.get(chat.id)!.messages.filter(row => row.text === "follow up")).toHaveLength(landed ? 1 : 0);
  } finally { post.mockRestore(); }
});

test.each(["approval", "question", "dismiss"] as const)("marker polling: ambiguous %s response waits for fresh request detail", async kind => {
  const { control, backend, chats, tick } = await markerFixture(1, true);
  const chat = chats[0]!, thread = control.threads.get(chat.id)!;
  thread.pending.push({ requestId: "pending-one", kind: kind === "approval" ? "approval" : "question", requestKind: "command",
    questions: [{ id: "q1", header: "Choose", question: "Which?", options: [{ label: "yes" }] }] });
  await tick(); control.calls.length = 0;
  const request = backend.client.request.bind(backend.client), lost = new ControlError(0);
  const post = spyOn(backend.client, "request").mockImplementation(async function<T>(...args: Parameters<ControlClient["request"]>): Promise<T> {
    if (args[0] !== "POST" || !args[1].endsWith("/respond")) return request<T>(...args);
    await request<T>(...args); throw lost;
  });
  try {
    const sending = kind === "approval" ? backend.permissionReply(chat.id, "pending-one", chat.directory, "once")
      : kind === "dismiss" ? backend.cancelQuestion(chat.id, "pending-one", chat.directory)
      : backend.questionReply((await backend.questions(chat.id))[0]!, chat.directory, [["yes"]]);
    await expect(sending).rejects.toBe(lost);
    expect(lost.reconciled).not.toBe(true);
    await expect(backend.responseResolved(chat.id, chat.directory, "pending-one")).rejects.toBe(probeDeferred);
    expect(control.calls.filter(call => call.method === "GET")).toHaveLength(0);
    await tick();
    expect(await backend.responseResolved(chat.id, chat.directory, "pending-one")).toBe(true);
    expect(control.calls.filter(call => call.path === `/threads/${chat.id}`)).toHaveLength(1);
  } finally { post.mockRestore(); }
});

test.each(["transport", "reader_unavailable", "server_error"].flatMap(reason => [false, true].map(restart => ({ reason, restart }))))("deferred steer refusal releases its wire mode ($reason, restart=$restart)", async ({ reason, restart }) => {
  const { control, backend, store, router } = delegatedRouter(); backend.trackFirstTurns(store);
  store.acceptInbound("root", { id: "root", text: "Original", attachments: [], isAudioMessage: false, receivedAt: Date.now() });
  await router.tick();
  const route = store.get<{ id: string }>("route")!;
  let readable = true;
  const thread = ControlClient.prototype.thread;
  const read = spyOn(ControlClient.prototype, "thread").mockImplementation(async function(this: ControlClient, ...args) {
    if (!readable) throw new Error("reader unavailable");
    return thread.apply(this, args);
  });
  const request = ControlClient.prototype.request;
  const post = spyOn(ControlClient.prototype, "request").mockImplementation(async function<T>(this: ControlClient, ...args: Parameters<ControlClient["request"]>): Promise<T> {
    const [method, path, body] = args;
    if (method === "POST" && path.endsWith("/send") && (body as { mode?: string })?.mode === "steer") {
      readable = false;
      throw new ControlError(reason === "transport" ? 0 : reason === "server_error" ? 500 : 503, "unavailable",
        reason === "reader_unavailable" ? { reason, retrySafe: false } : {});
    }
    return request.apply(this, args) as Promise<T>;
  });
  try {
    store.acceptInbound("human", { id: "human", text: "Follow up", attachments: [], isAudioMessage: false, receivedAt: Date.now() });
    await router.tick();
    expect(store.get("steer-attempt:human")).toMatchObject(reason === "server_error" ? { text: "Follow up" } : { reconcileOnly: true });
    const activeBackend = restart ? control.backend() : backend; activeBackend.trackFirstTurns(store);
    const activeRouter = restart ? new Router(store, activeBackend, {
      async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
    }, { owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/test/skill", alertSkillPath: "/test/alerts", alertSocketPath: "/test/socket", openCodeConfigRoot: "/nonexistent", quietMs: 0, watchMs: 0 }) : router;
    readable = true;
    control.reply(route.id, "Original answered", "completed");
    await activeRouter.tick(); await activeRouter.tick();
    expect(control.calls.filter(call => call.path.endsWith("/send")).map(call => call.body.text)).toEqual(["Original", "Follow up"]);
    expect(store.get("activeTurn")).toMatchObject({ inboundId: "human", phase: "running" });
    control.reply(route.id, "Follow-up answered", "completed"); await activeRouter.tick();
    for (const op of store.pendingOutbox()) store.outboxState(op.id, "sent");
    expect(inbounds(store).find(row => row.id === "human")?.state).toBe("done");
  } finally { post.mockRestore(); read.mockRestore(); }
});

test.each(["startup_unavailable", "send_timeout"])("held auto retry preserves every wire field through %s and restart", async reason => {
  const { control, backend, store, router } = delegatedRouter(); backend.trackFirstTurns(store);
  const start = Date.now(); setSystemTime(start);
  control.flags.sendFailure = reason;
  store.acceptInbound("human", { id: "human", text: "Question", source: "typed", attachments: [], isAudioMessage: false, receivedAt: start });
  await router.tick();
  for (const offset of [60_000, 120_000]) { setSystemTime(start + offset); await router.tick(); }
  expect(store.get("activeTurn")).toMatchObject({ phase: "held" });
  setSystemTime(start + 180_000); await router.tick();
  const restartedBackend = control.backend(); restartedBackend.trackFirstTurns(store);
  const restarted = new Router(store, restartedBackend, {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
  }, { owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/test/skill", alertSkillPath: "/test/alerts", alertSocketPath: "/test/socket", openCodeConfigRoot: "/nonexistent", quietMs: 0, watchMs: 0 });
  control.flags.sendFailure = undefined;
  setSystemTime(start + 240_000); await restarted.tick();
  const bodies = control.calls.filter(call => call.path.endsWith("/send")).map(call => call.body);
  expect(bodies).toHaveLength(4);
  expect(bodies).toEqual(bodies.map(() => bodies[0]));
  expect(bodies[0]).toMatchObject({ mode: "auto", text: "Question", inboundId: "human" });
  expect(store.get("activeTurn")).toMatchObject({ phase: "running" });
});

test.each([false, true].flatMap(restart => [0, 120].map(history => ({ restart, history }))))("a delegated completion racing a sealed wake keeps its reply (restart=$restart, history=$history)", async ({ restart, history }) => {
  const { control, backend, store, router } = delegatedRouter(); backend.trackFirstTurns(store);
  store.acceptInbound("root", { id: "root", text: "Ask a delegate", attachments: [], isAudioMessage: false, receivedAt: Date.now() });
  await router.tick();
  const route = store.get<{ id: string; directory: string; generation: number }>("route")!;
  const thread = control.threads.get(route.id)!;
  thread.driver = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  control.reply(route.id, "Working on it", "completed"); await router.tick();
  for (const op of store.pendingOutbox()) store.outboxState(op.id, "sent");
  const prompt = backend.prompt.bind(backend);
  const posting = spyOn(backend, "prompt").mockImplementation(async (...args) => {
    const runId = `run:thread:${route.id}:ordinal:2`;
    thread.runs.push({ runId, ordinal: 2, status: "running" });
    const at = new Date(Date.now() + 1).toISOString();
    thread.messages.push({ messageId: "delegated-completion", runId, role: "user", text: "Delegated task node:delegated-task:done [completed]:\nDelegate finished", streaming: false, createdBy: "agent", createdAt: at, updatedAt: at });
    for (let index = 0; index < history; index++) thread.messages.push({
      messageId: `progress-${index}`, runId, role: "assistant", text: "Progress", phase: "narration",
      streaming: false, createdBy: "agent", createdAt: at, updatedAt: at,
    });
    control.reply(route.id, "Delegate result", "completed");
    await prompt(...args);
  });
  store.acceptInbound("wake:next", { id: "wake:next", text: wakeBody(), attachments: [], isAudioMessage: false, receivedAt: Date.now() });
  try { await router.tick(); } finally { posting.mockRestore(); }
  expect(thread.runs.map(run => run.ordinal)).toEqual([1, 2, 3]);
  control.reply(route.id, "NO_REPLY", "completed");
  const activeBackend = restart ? control.backend() : backend; activeBackend.trackFirstTurns(store);
  const activeRouter = restart ? new Router(store, activeBackend, {
    async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); },
  }, { owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/test/skill", alertSkillPath: "/test/alerts", alertSocketPath: "/test/socket", openCodeConfigRoot: "/nonexistent", quietMs: 0, watchMs: 0 }) : router;
  await activeRouter.tick(); await activeRouter.tick();
  const replies = store.pendingOutbox().filter(op => op.kind === "conversation");
  expect(replies.map(op => op.text)).toEqual(["Delegate result"]);
  expect(store.get<string[]>(`reply-covered:${replies[0]!.id}`)).toEqual([]);
  store.outboxState(replies[0]!.id, "sent"); await activeRouter.tick();
  expect(store.pendingOutbox().filter(op => op.kind === "conversation")).toEqual([]);
  expect(store.get("watermark")).toMatchObject({ id: `idle:${thread.runs[2]!.runId}` });
});

test.each([false, true])("a send's completion read scopes out an older failed run and its stale thread error (restart=%s)", async restart => {
  const control = fakeControl();
  let backend = control.backend();
  const store = new Store(":memory:");
  stores.push(store);
  backend.trackFirstTurns(store);
  const chat = await backend.createChat();
  const old = Date.parse("2026-11-16T10:16:47Z");
  const sent = Date.parse("2026-11-16T11:35:32Z");
  const thread = control.threads.get(chat.id)!;
  thread.runs.push({ runId: `run:thread:${chat.id}:ordinal:17`, ordinal: 17, status: "failed", requestedAt: new Date(old).toISOString() });
  thread.messages.push({ messageId: "old-input", runId: thread.runs[0]!.runId, role: "user", text: "Old wake", streaming: false,
    createdAt: new Date(old).toISOString(), updatedAt: new Date(old).toISOString() });
  thread.lastError = "The provider could not start this turn";
  setSystemTime(sent);
  const prompt = `msg_${"a".repeat(64)}`;
  await backend.prompt(chat.id, chat.directory, prompt, "New wake");
  if (restart) { backend = control.backend(); backend.trackFirstTurns(store); }
  // A stale lastError can remain while the fresh run completes normally.
  control.reply(chat.id, "NO_REPLY", "completed");
  const records = await backend.messages(chat.id, chat.directory, { until: prompt, since: sent });
  expect(records.some(record => record.id === "old-input")).toBe(true);
  const current = records.slice(records.findIndex(record => record.id === prompt) + 1);
  expect(current.filter(record => record.type === "idle")).toMatchObject([{ outcome: "succeeded" }]);
  expect(current.some(record => record.type === "assistant" && record.error)).toBe(false);
});

test("an admitted steer reads the run it joined even when that run predates the steer", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const chat = await backend.createChat();
  const root = `msg_${"b".repeat(64)}`;
  const followup = `msg_${"c".repeat(64)}`;
  await backend.prompt(chat.id, chat.directory, root, "Original request");
  const sent = Date.now() + 60_000;
  setSystemTime(sent);
  expect(await backend.steer(chat.id, chat.directory, followup, "Follow-up request")).toBe("steered");
  control.reply(chat.id, "Both answered", "completed");
  const records = await backend.messages(chat.id, chat.directory, { until: followup, since: sent });
  expect(records.some(record => record.id === followup)).toBe(true);
  expect(records.filter(record => record.type === "idle")).toMatchObject([{ outcome: "succeeded" }]);
});

// The reference creates a fresh backend for each read, retaining the pre-cache full-read path.
test.each([false, true])("incremental message records equal full reads through streaming, phases, runs and route rotation (markers=%s)", async markers => {
  const control = fakeControl();
  const backend = control.backend();
  let chat = await backend.createChat();
  const prompt = `msg_${"c".repeat(64)}`;
  await backend.prompt(chat.id, chat.directory, prompt, "first");
  let thread = control.threads.get(chat.id)!;
  thread.driver = { instanceId: "codex", model: "test" };
  const verify = async () => {
    control.flags.markers = markers;
    if (markers) backend.beginMessageTick([chat.id]);
    for (const options of [{ limit: 1 }, { limit: 20, until: prompt }, { until: prompt, since: Date.now() - 60_000 },
      { limit: 100 }, { until: `idle:${thread.runs[0]!.runId}`, limit: 20 }]) {
      expect(await backend.messages(chat.id, chat.directory, options)).toEqual(await control.backend().messages(chat.id, chat.directory, options));
    }
  };
  await verify();
  const at = new Date().toISOString();
  for (const id of ["a2", "a10", "A1"]) thread.messages.push({ messageId: id, role: "assistant", phase: "narration", streaming: true,
    text: id, runId: thread.runs[0]!.runId, createdAt: at, updatedAt: at });
  await verify();
  for (let i = 1; i <= 3; i++) {
    for (const message of thread.messages.filter(message => message.role === "assistant")) {
      message.text += ` update ${i}`;
      message.updatedAt = new Date(Date.now() + i).toISOString();
      if (i === 3) { message.phase = "answer"; message.streaming = false; }
    }
    await verify();
  }
  thread.runs[0]!.status = "completed";
  await verify();
  await backend.prompt(chat.id, chat.directory, `msg_${"d".repeat(64)}`, "second");
  control.reply(chat.id, "second reply", "waiting");
  await verify();
  thread.messages.push({ messageId: "background", runId: thread.runs[1]!.runId, role: "user", createdBy: "system",
    text: "[Subagent completed] background result", streaming: false, createdAt: at, updatedAt: new Date(Date.now() + 4).toISOString() });
  await verify();
  chat = await backend.createChat();
  await backend.retireOthers(chat.id);
  await backend.prompt(chat.id, chat.directory, prompt, "new route");
  thread = control.threads.get(chat.id)!;
  thread.driver = { instanceId: "codex", model: "test" };
  await verify();
});

test.each(["auto", "steer"] as const)("ambiguous %s send reconciles a snapshot read before admission", async mode => {
  const control = fakeControl();
  const backend = control.backend();
  const chat = await backend.createChat();
  await backend.prompt(chat.id, chat.directory, `msg_${"1".repeat(64)}`, "Original");
  const followup = `msg_${"2".repeat(64)}`;
  const projected = await backend.client.thread(chat.id);
  // Admission can become visible in messages before the thread projection changes.
  const thread = spyOn(backend.client, "thread").mockResolvedValue(projected);
  const request = backend.client.request.bind(backend.client);
  const lost = new ControlError(503, "unavailable", { reason: "reader_unavailable", retrySafe: false });
  const post = spyOn(backend.client, "request").mockImplementation(async function<T>(...args: Parameters<ControlClient["request"]>): Promise<T> {
    if (args[0] !== "POST" || !args[1].endsWith("/send")) return request<T>(...args);
    // Repopulate the same-tick cache after before-send invalidation, while the POST is in flight.
    expect(await backend.promptAccepted(chat.id, chat.directory, followup)).toBe(false);
    await request<T>(...args);
    throw lost;
  });
  try {
    await backend.messageReadScope(async () => {
      await backend.messages(chat.id);
      if (mode === "auto") await backend.prompt(chat.id, chat.directory, followup, "Follow up");
      else expect(await backend.steer(chat.id, chat.directory, followup, "Follow up")).toBe("steered");
    });
    expect(lost.reconciled).toBe(true);
    expect(await backend.promptAccepted(chat.id, chat.directory, followup)).toBe(true);
    expect(control.calls.filter(call => call.path.endsWith("/send") && call.body.clientRequestId === followup)).toHaveLength(1);
  } finally { post.mockRestore(); thread.mockRestore(); }
});

test("message cache shares one read per tick, refreshes later ticks and invalidates after sends", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const chat = await backend.createChat();
  const prompt = `msg_${"e".repeat(64)}`;
  await backend.prompt(chat.id, chat.directory, prompt, "hello");
  const reads = () => control.calls.filter(call => call.path.includes("/messages?"));
  await backend.messages(chat.id);
  control.calls.length = 0;
  await backend.messageReadScope(async () => {
    await backend.messages(chat.id, chat.directory, { until: prompt, limit: 20 });
    expect(await backend.promptAccepted(chat.id, chat.directory, prompt)).toBe(true);
    await backend.messages(chat.id, chat.directory, { limit: 1 });
  });
  expect(reads()).toHaveLength(1); // Three paths, two fewer GETs (67%).
  expect(reads()[0]!.path).toContain("since=");
  await backend.messageReadScope(async () => {
    await backend.messages(chat.id);
    const steer = `msg_${"f".repeat(64)}`;
    await backend.steer(chat.id, chat.directory, steer, "also this");
    expect(await backend.promptAccepted(chat.id, chat.directory, steer)).toBe(true);
    await backend.messages(chat.id, chat.directory, { until: steer, limit: 20 });
    expect(await backend.promptAccepted(chat.id, chat.directory, steer)).toBe(true);
  });
  expect(reads()).toHaveLength(3); // Pre-write and post-write reads; write is a freshness boundary.
  expect(reads().every(call => call.path.includes("since="))).toBe(true);
  await backend.messages(chat.id);
  expect(reads()).toHaveLength(4); // No cached-skip on future ticks.
});

test("missing until, route change, merge conflict and ten-minute redaction resync each full-read once", async () => {
  const start = Date.now();
  setSystemTime(start);
  try {
    const control = fakeControl();
    const backend = control.backend();
    const chat = await backend.createChat();
    await backend.prompt(chat.id, chat.directory, `msg_${"a".repeat(64)}`, "hello");
    control.reply(chat.id, "original", "completed");
    const full = () => control.calls.filter(call => call.path.includes("/messages?") && !call.path.includes("since="));
    await backend.messages(chat.id);
    expect(full()).toHaveLength(1);
    await backend.messageReadScope(async () => {
      await backend.messages(chat.id, chat.directory, { until: "absent" });
      await backend.messages(chat.id, chat.directory, { until: "absent" });
    });
    expect(full()).toHaveLength(2);
    const row = control.threads.get(chat.id)!.messages[1]!;
    row.createdAt = new Date(start + 100).toISOString();
    await backend.messages(chat.id);
    expect(full()).toHaveLength(3);
    setSystemTime(start + 3_000);
    control.threads.get(chat.id)!.messages.push({ messageId: "advance-cursor", runId: row.runId, role: "assistant", phase: "narration", text: "newer row",
      streaming: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await backend.messages(chat.id);
    row.text = "redacted";
    setSystemTime(start + 5_000);
    expect(JSON.stringify(await backend.messages(chat.id))).toContain("original");
    setSystemTime(start + 10 * 60_000);
    const resynced = await backend.messages(chat.id);
    expect(JSON.stringify(resynced)).toContain("redacted");
    expect(full()).toHaveLength(4);
    await backend.messages(chat.id);
    expect(full()).toHaveLength(4);
    await backend.retireOthers(chat.id);
    await backend.messages(chat.id);
    await backend.messages(chat.id);
    expect(full()).toHaveLength(5);
  } finally { setSystemTime(); }
});

for (const { historySize, scenario } of [100, 1_500].flatMap(historySize => ["idle", "active", "steer"].map(scenario => ({ historySize, scenario })))) {
  test(`60-second router budgets preserve completion timing (${historySize} rows, ${scenario})`, async () => {
  const start = Date.parse("2026-11-15T09:30:00Z");
  const table: object[] = [];
  try {
    const results = [];
    for (const legacy of [true, false]) {
      setSystemTime(start);
      const ownedServers: typeof servers = [];
      const control = fakeControl(ownedServers);
      const backend = control.backend();
      if (legacy) {
        backend.messageReadScope = body => body();
        backend.client.messages = id => ControlClient.prototype.messages.call(backend.client, id);
      }
      const store = new Store(":memory:");
      try {
        const router = new Router(store, backend, { async typing() {}, async read() {}, async downloadAttachment() { throw new Error("unused"); } }, {
          owner: "+15555550123", chatGuid: "iMessage;-;+15555550123", timezone: "Asia/Dubai", skillPath: "/test/skill", alertSkillPath: "/test/alert",
          alertSocketPath: "/test/socket", openCodeConfigRoot: "/nonexistent", quietMs: 0, watchMs: 5_000,
        });
        const chat = await backend.createChat();
        const thread = control.threads.get(chat.id)!;
        thread.driver = { instanceId: "codex", model: "test" };
        await backend.prompt(chat.id, chat.directory, `msg_${"0".repeat(64)}`, "history");
        for (let i = 0; i < historySize; i++) thread.messages.push({ messageId: `history-${i}`, role: "assistant", phase: "narration", text: "old text ".repeat(100),
          runId: thread.runs[0]!.runId, streaming: false, createdAt: new Date(start - (historySize + 100) * 1_000 + i * 1_000).toISOString(), updatedAt: new Date(start - (historySize + 100) * 1_000 + i * 1_000).toISOString() });
        thread.messages[0]!.createdAt = thread.messages[0]!.updatedAt = new Date(start - 120_000).toISOString();
        thread.runs[0]!.status = "completed";
        store.set("route", { ...chat, generation: 1 });
        if (scenario !== "idle") {
          store.acceptInbound("budget", { id: "budget", text: "hello", attachments: [], isAudioMessage: false, source: "typed", receivedAt: start });
          await router.tick();
          thread.messages.push({ messageId: "stream", role: "assistant", phase: "narration", text: "working", streaming: true,
            runId: thread.runs.at(-1)!.runId, createdAt: new Date(start + 500).toISOString(), updatedAt: new Date(start + 500).toISOString() });
        }
        const startup = control.calls.filter(call => call.path.includes("/messages?"));
        control.calls.length = 0;
        const paths: Record<string, { messages: number; thread: number; evidence: number }> = {};
        const collect = (path: string, from: number) => {
          paths[path] ??= { messages: 0, thread: 0, evidence: 0 };
          for (const call of control.calls.slice(from)) if (call.method === "GET") {
            if (call.path.includes("/messages?")) paths[path]!.messages++;
            else if (call.path.endsWith("/evidence")) paths[path]!.evidence++;
            else if (/^\/threads\/[^/?]+$/.test(call.path)) paths[path]!.thread++;
          }
        };
        let completedAt = 0;
        for (let second = 1; second <= 60; second++) {
          setSystemTime(start + second * 1_000);
          const stream = thread.messages.find(message => message.messageId === "stream");
          if (stream && second < 50) { stream.text += "."; stream.updatedAt = new Date().toISOString(); }
          if (second === 30 && scenario === "steer") store.acceptInbound("budget-steer", { id: "budget-steer", text: "also this", attachments: [], isAudioMessage: false, source: "typed", receivedAt: Date.now() });
          if (second === 50 && scenario !== "idle") control.reply(chat.id, "done", "completed");
          let from = control.calls.length; await router.checkCompletion(); collect("completion", from);
          from = control.calls.length; await router.tick(); collect(second === 30 && scenario === "steer" ? "tick-steer" : "tick", from);
          if (!completedAt && scenario !== "idle" && store.pendingOutbox().some(op => op.kind === "conversation" && op.text === "done")) completedAt = second;
        }
        const reads = control.calls.filter(call => call.path.includes("/messages?"));
        const full = reads.filter(call => !call.path.includes("since="));
        results.push({ legacy, paths, gets: reads.length, full: full.length + startup.length, startupGets: startup.length, incremental: reads.length - full.length,
          rows: reads.reduce((sum, call) => sum + (call.rows ?? 0), 0), bytes: reads.reduce((sum, call) => sum + (call.bytes ?? 0), 0), completedAt });
      } finally {
        await Promise.all(ownedServers.map(server => server.stop(true)));
        store.db.close();
      }
    }
    const [before, after] = results;
    expect(after!.full).toBeLessThanOrEqual(before!.full * .1);
    expect(after!.rows).toBeLessThan(before!.rows * .2);
    expect(after!.bytes).toBeLessThan(before!.bytes * .2);
    expect(after!.gets).toBeLessThanOrEqual(before!.gets);
    if (scenario !== "idle") { expect(before!.completedAt).toBe(50); expect(after!.completedAt).toBe(50); }
    table.push({ historySize, scenario, before, after });
    console.log("message-read-budget", JSON.stringify(table));
  } finally { setSystemTime(); }
  // The legacy 1,500-row active/steer paths take about 3 s on b0; allow headroom for host load.
}, historySize === 1_500 && scenario !== "idle" ? 15_000 : undefined);
}

test("message read modes, full reasons and returned bytes survive the minute log aggregation", async () => {
  const root = mkdtempSync(join(tmpdir(), "message-reads-log-")); dirs.push(root);
  let now = Date.parse("2026-11-15T09:30:01Z");
  const log = createToolLog({ root, now: () => now });
  for (const [mode, reason] of [["full", "first-read"], ["incremental", undefined], ["shared", undefined], ["cached-skip", undefined],
    ["full", "missing-until"], ["full", "route-change"], ["full", "resync"], ["full", "merge-conflict"], ["full", "clock-skew"]]) {
    log.write({ component: "robob", kind: "perf", name: "robob.messages_read", ids: { threadId: "thread-fixture" },
      props: { readMode: mode!, ...(reason ? { fullReason: reason } : {}), rowsReturned: 2, bytesReturned: 500 } });
  }
  now += 60_000;
  await log.tick();
  const lines = readFileSync(join(root, "2026-11-15.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(lines.filter(line => line.name === "robob.messages_read")).toHaveLength(0);
  expect(lines.find(line => line.name === "robob.message_reads")).toMatchObject({ ts: "2026-11-15T09:30:00.000Z", ids: { threadId: "thread-fixture" }, props: {
    fullReads: 6, incrementalReads: 1, sharedReads: 1, cachedSkipReads: 1, rowsReturned: 18, bytesReturned: 4500,
    firstReads: 1, missingUntils: 1, routeChanges: 1, resyncs: 1, mergeConflicts: 1, clockSkews: 1,
  } });
});

test("a cached run removed by rollback forces one full repair instead of retaining its messages", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const chat = await backend.createChat();
  await backend.prompt(chat.id, chat.directory, `msg_${"9".repeat(64)}`, "rolled back");
  control.reply(chat.id, "old", "completed");
  await backend.messages(chat.id);
  const thread = control.threads.get(chat.id)!;
  thread.messages = []; thread.runs = [];
  control.calls.length = 0;
  expect(await backend.messages(chat.id)).toEqual([]);
  expect(control.calls.filter(call => call.path.includes("/messages?") && !call.path.includes("since="))).toHaveLength(1);
});

test("completion and external steer writes invalidate an existing tick's snapshot", async () => {
  const control = fakeControl();
  const backend = control.backend();
  const chat = await backend.createChat();
  const prompt = `msg_${"7".repeat(64)}`;
  const steer = `msg_${"8".repeat(64)}`;
  await backend.prompt(chat.id, chat.directory, prompt, "hello");
  const ready = Promise.withResolvers<void>();
  const written = Promise.withResolvers<void>();
  const reading = backend.messageReadScope(async () => {
    await backend.messages(chat.id);
    ready.resolve();
    await written.promise;
    expect(await backend.promptAccepted(chat.id, chat.directory, steer)).toBe(true);
    control.reply(chat.id, "complete", "completed");
    expect((await backend.messages(chat.id)).at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" });
  });
  await ready.promise;
  try { await backend.steer(chat.id, chat.directory, steer, "also this"); }
  finally { written.resolve(); }
  await reading;
});

test.each([
  { label: "future timestamp beyond overlap", cachedAt: 10_000, nextAt: 1_000, full: true },
  { label: "future timestamp at exclusive since boundary", cachedAt: 2_000, nextAt: 0, full: true },
  { label: "future cursor with delayed poll after clock catches up", cachedAt: 10_000, errorAt: 1_000, nextAt: 15_000, full: true },
  { label: "exclusive future boundary with delayed poll", cachedAt: 2_000, errorAt: 0, nextAt: 10_000, full: true },
  { label: "safe overlap with delayed poll", cachedAt: 1_999, errorAt: 0, nextAt: 10_000, full: false },
  { label: "future timestamp within overlap", cachedAt: 1_999, nextAt: 0, full: false },
  { label: "wall clock moves backwards beyond overlap", cachedAt: -20_000, nextAt: -10_000, full: true },
  { label: "wall clock moves backwards at overlap boundary", cachedAt: -20_000, nextAt: -2_000, full: true },
  { label: "wall clock moves backwards within overlap", cachedAt: -20_000, nextAt: -1_999, full: false },
  { label: "equal timestamp", cachedAt: 0, nextAt: 0, full: false },
])("clock skew preserves the first-turn model-error verdict: $label", async ({ cachedAt, nextAt, errorAt = nextAt, full }) => {
  const start = Date.parse("2026-11-15T12:00:00Z");
  setSystemTime(start);
  try {
    const control = fakeControl();
    const alerts: string[] = [];
    const backend = control.backend("/chats", { alert: async (_id, text) => { alerts.push(text); return true; } });
    const chat = await backend.createChat();
    await backend.prompt(chat.id, chat.directory, `msg_${"6".repeat(64)}`, "hello");
    const thread = control.threads.get(chat.id)!;
    thread.driver = { instanceId: "codex", model: "test" };
    thread.messages[0]!.updatedAt = new Date(start + cachedAt).toISOString();
    await backend.messages(chat.id);
    control.calls.length = 0;
    setSystemTime(start + errorAt);
    control.reply(chat.id, "There's an issue with the selected model (test).", "completed");
    thread.messages.at(-1)!.createdAt = thread.messages.at(-1)!.updatedAt = new Date().toISOString();
    setSystemTime(start + nextAt);
    const records = await backend.messages(chat.id);
    const fullReads = control.calls.filter(call => call.path.includes("/messages?") && !call.path.includes("since="));
    expect(fullReads).toHaveLength(full ? 1 : 0);
    expect(records).toEqual(await control.backend().messages(chat.id));
    expect(records.at(-1)).toMatchObject({ type: "idle", outcome: "failed", modelError: true });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("issue with the selected model");
    await backend.messages(chat.id);
    expect(alerts).toHaveLength(1);
  } finally { setSystemTime(); }
});

test("a slow response retains the cursor's request-time skew before a later model error", async () => {
  const start = Date.parse("2026-11-15T12:00:00Z");
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  setSystemTime(start);
  try {
    const control = fakeControl();
    const alerts: string[] = [];
    const backend = control.backend("/chats", { alert: async (_id, text) => { alerts.push(text); return true; } });
    const chat = await backend.createChat();
    await backend.prompt(chat.id, chat.directory, `msg_${"5".repeat(64)}`, "hello");
    const thread = control.threads.get(chat.id)!;
    thread.driver = { instanceId: "codex", model: "test" };
    thread.messages[0]!.updatedAt = new Date(start + 10_000).toISOString();
    const messages = backend.client.messages.bind(backend.client);
    backend.client.messages = async (...args) => {
      const response = await messages(...args);
      received.resolve();
      await release.promise;
      return response;
    };
    const initial = backend.messages(chat.id);
    await received.promise;
    setSystemTime(start + 1_000);
    control.reply(chat.id, "There's an issue with the selected model (test).", "completed");
    setSystemTime(start + 15_000);
    release.resolve();
    await initial;
    backend.client.messages = messages;
    const records = await backend.messages(chat.id);
    expect(records).toEqual(await control.backend().messages(chat.id));
    expect(records.at(-1)).toMatchObject({ type: "idle", outcome: "failed", modelError: true });
    expect(alerts).toHaveLength(1);
  } finally { release.resolve(); setSystemTime(); }
});

test.each(["resolve", "upload"])("bus expiry during Robob %s preparation prevents the actual send", async delayed => {
  const control = fakeControl(), backend = control.backend();
  const { id, directory } = await backend.createChat();
  let now = 1_000; const clock = spyOn(Date, "now").mockImplementation(() => now);
  const resolve = spyOn(backend, "resolve").mockImplementation(async () => { if (delayed === "resolve") now = 2_000; return id; });
  const upload = spyOn(backend.client, "upload").mockImplementation(async () => { now = 2_000; return { attachmentId: "unused", type: "file", name: "file", mimeType: "text/plain", sizeBytes: 1 }; });
  try {
    await expect(backend.prompt(id, directory, "msg_expired_bus", "PRIVATE_REQUEST", "guidance",
      delayed === "upload" ? [{ type: "file", mime: "text/plain", filename: "file", url: "data:text/plain;base64,YQ==" }] : [], undefined, undefined, undefined, 2_000))
      .rejects.toThrow("Agent delivery expired");
    expect(control.calls.filter(call => call.path.endsWith("/send"))).toHaveLength(0);
  } finally { upload.mockRestore(); resolve.mockRestore(); clock.mockRestore(); }
});

let rosterSequence = 0;
function rosterEvent(roster: ActiveRoster, data: Record<string, unknown>) {
  roster.event({ id: String(++rosterSequence), data });
}

function rosterFixture() {
  let time = 1_000_000;
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "test-token" });
  const row = (threadId: string, state: import("../src/control.ts").ThreadState = "running", parentThreadId: string | null = null): import("../src/control.ts").ThreadSummary => ({
    threadId, projectId: "chats", title: threadId, state, status: state, origin: "imessage",
    nativeSessionId: null, runtimeMode: "full-access", parentThreadId, rootThreadId: parentThreadId ?? threadId,
    worktreePath: "/chats", pendingRequest: null, createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:00:00Z",
  });
  const server = { threads: [row("owner")], total: 1 };
  const reads = spyOn(client, "listThreads").mockImplementation(async () => structuredClone(server));
  // These list-race cases exercise the full-list fallback; event-detail success has its own matrix.
  const roster = new ActiveRoster({ listThreads: client.listThreads.bind(client), events: options => client.events(options) }, () => time);
  const backend = new RobobBackend({ chatRoot: "/chats", client, activeRoster: roster, finishes: () => new Map() });
  const chats = [backend, ...["moni", "group-a", "group-b", "idle-a", "idle-b"].map(name => backend.forChat(`chats/${name}`, name))];
  const event = (threadId: string, state: string, runId?: string) => {
    const row = server.threads.find(row => row.threadId === threadId);
    if (row && (!runId || runId === (row.activeRunId ?? row.latestRunId))) row.state = row.pendingRequest ? "needs-input" : state as typeof row.state;
    rosterEvent(roster, { type: "thread.status", threadId, state, ...(runId ? { runId } : {}) });
  };
  return { client, row, server, reads, roster, backend, chats, event, advance: (ms: number) => { time += ms; } };
}

function holdRosterRead(f: ReturnType<typeof rosterFixture>) {
  const response = Promise.withResolvers<typeof f.server>();
  const started = Promise.withResolvers<void>();
  f.reads.mockImplementationOnce(() => { started.resolve(); return response.promise; });
  return { ...response, started: started.promise };
}

test("active roster shares six concurrent reads and the healthy 120-second budget across every chat", async () => {
  for (const scenario of ["idle", "active", "steer"] as const) {
    const f = rosterFixture();
    if (scenario === "idle") { f.server.threads = []; f.server.total = 0; }
    f.roster.streamState(true);
    await Promise.all(f.chats.map(chat => chat.statuses()));
    expect(f.reads).toHaveBeenCalledTimes(1);
    for (let second = 1; second <= 120; second++) {
      f.advance(1_000);
      if (scenario !== "idle" && second % 10 === 0) f.event("owner", second % 20 ? "running" : "queued");
      await Promise.all(f.chats.map(chat => chat.statuses()));
      if (scenario === "steer" && second === 55) await f.backend.statuses(true);
    }
    expect(f.reads).toHaveBeenCalledTimes(5);
    expect(f.roster.status()).toMatchObject({ startup: 1, safety: 4, roster_event: 0, stream_down: 0 });
    f.reads.mockRestore();
  }
});

test("active roster stream-down TTL is one GET per ten seconds for the process", async () => {
  const f = rosterFixture();
  for (let second = 0; second <= 120; second++) {
    if (second) f.advance(1_000);
    await Promise.all(f.chats.map(chat => chat.statuses()));
  }
  expect(f.reads).toHaveBeenCalledTimes(13);
  expect(f.roster.status()).toMatchObject({ startup: 1, stream_down: 12 });
});

test.each(["idle", "running"] as const)("unchanged %s details during a refresh cannot start a reconciliation loop", async state => {
  const f = rosterFixture(); f.server.threads[0]!.state = state;
  f.roster.streamState(true); await f.backend.statuses();
  f.advance(30_000);
  const response = Promise.withResolvers<typeof f.server>(); f.reads.mockReturnValueOnce(response.promise);
  const refresh = f.backend.statuses(true);
  const reads = f.chats.map(() => f.roster.checkpoint("owner"));
  for (const read of reads) f.roster.observe(structuredClone(f.server.threads[0]!), read);
  response.resolve(structuredClone(f.server)); await refresh;
  for (const read of reads) f.roster.observe(structuredClone(f.server.threads[0]!), read);
  await f.backend.statuses(true);
  expect(f.reads).toHaveBeenCalledTimes(2);
  expect(f.roster.status().ambiguous).toBe(0);
});

test("ambiguities during and already covered by one fetch cannot start another generation", async () => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses();
  const old = f.chats.map(() => f.roster.checkpoint("owner"));
  const response = Promise.withResolvers<typeof f.server>(); f.reads.mockReturnValueOnce(response.promise);
  const idle = { ...f.server.threads[0]!, state: "idle" as const };
  for (const read of old) f.roster.observe(idle, { ...read, revision: -1 });
  expect(f.reads).toHaveBeenCalledTimes(2);
  response.resolve(structuredClone(f.server));
  await Promise.all(f.chats.map(chat => chat.statuses(true)));
  for (const read of old) f.roster.observe(idle, read);
  expect(await f.backend.statuses(true)).toHaveProperty("owner");
  expect(f.reads).toHaveBeenCalledTimes(2);
  expect(f.roster.status().ambiguous).toBe(1);
});

test.each(["thread.created", "thread.status", "request.opened", "request.resolved"])("family discovery during %s cannot publish a complete roster missing a new child", async type => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses();
  const stale = structuredClone(f.server);
  const response = Promise.withResolvers<typeof f.server>(); f.reads.mockReturnValueOnce(response.promise);
  f.advance(30_000); const admission = f.backend.statuses(true);
  const request = { requestId: "pending", kind: "question" as const, requestKind: "user_input" };
  f.server.threads.push({ ...f.row("child", "needs-input", "owner"), pendingRequest: request }); f.server.total++;
  rosterEvent(f.roster, { type, threadId: "child", state: "needs-input", ...request });
  response.resolve(stale);
  expect(await admission).toHaveProperty("child", { type: "busy", root: "owner" });
  expect(f.reads).toHaveBeenCalledTimes(3);
  expect(f.roster.status().ambiguous).toBe(0);
});

test.each(["idle", "active", "steer", "stream-down"])("six Sendblue routers retain their 120-second list budget: %s", async scenario => {
  const c = fakeControl(), backend = c.backend();
  backend.activeRoster.streamState(scenario !== "stream-down");
  const names = ["owner", "moni", "group-a", "group-b", "idle-a", "idle-b"];
  const backends = names.map((name, i) => i ? backend.forChat(`chats/${name}`, name) : backend);
  const stores = names.map(() => new Store(":memory:"));
  const routes = await Promise.all(backends.map(b => b.createChat()));
  if (scenario === "active" || scenario === "steer") c.threads.get(routes[0]!.id)!.runs.push({ runId: "budget-running", ordinal: 1, status: "running" });
  const routers = backends.map((b, i) => new Router(stores[i]!, b, { typing: async () => {}, read: async () => {}, downloadAttachment: async () => { throw new Error("unused"); } }, {
    context: { chat: { slug: names[i]!, key: `dm:+1555555012${i}`, title: names[i]!, kind: i === 0 ? "owner" : "dm" },
      roleOf: () => ({ name: "Owner", role: "owner" }), typing: () => false, react: async () => {} }, chatGuid: `dm:+1555555012${i}`,
    owner: "+15555550123", skillPath: "/skills", alertSkillPath: "/alert", alertSocketPath: "/alert.sock", timezone: "UTC",
  }));
  const start = Date.now();
  try {
    for (let second = 0; second <= 120; second++) {
      setSystemTime(start + second * 1_000);
      for (let i = 0; i < routers.length; i++) {
        await (routers[i] as unknown as { statusesFor(route: typeof routes[number]): Promise<unknown> }).statusesFor(routes[i]!);
      }
      if (scenario === "steer" && second === 55) await backend.statuses(true);
    }
    await backend.statuses();
    const lists = c.calls.filter(call => call.path.includes("active=true"));
    if (scenario === "stream-down") expect(lists.length).toBe(13);
    else expect(lists.length / 2).toBeLessThanOrEqual(4);
    expect(backend.activeRoster.status().ambiguous).toBe(0);
  } finally { setSystemTime(); for (const store of stores) store.db.close(); }
});

test("sequenced busy patches need no GET; unavailable event detail falls back before clearing idle", async () => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses();
  f.event("owner", "idle");
  await f.backend.statuses(true);
  for (const chat of f.chats) expect(await chat.statuses()).toEqual({});
  f.event("owner", "running");
  for (const chat of f.chats) expect(await chat.statuses(true)).toEqual({ owner: { type: "busy", root: null } });
  expect(f.reads).toHaveBeenCalledTimes(2);
  expect(f.roster.status()).toMatchObject({ detailErrors: 1, roster_event: 1 });
});

test("fallback discovery refetches; deletion removes locally and reconnect refetches", async () => {
  for (const data of [
    { type: "thread.status", threadId: "unknown", state: "running" }, { type: "thread.created", threadId: "new" },
    { type: "thread.updated", threadId: "owner", change: "thread.archived" },
    { type: "thread.updated", threadId: "owner", change: "thread.deleted" }, { type: "ready", resumed: false }, { type: "resync" },
  ]) {
    const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses();
    rosterEvent(f.roster, data); await Promise.all(f.chats.map(chat => chat.statuses(true)));
    const localRemoval = data.change === "thread.deleted";
    expect(f.reads).toHaveBeenCalledTimes(localRemoval ? 1 : 2);
    expect(f.roster.status().roster_event).toBe(localRemoval ? 0 : 1); f.reads.mockRestore();
  }
});

test("healthy steer admission uses cache, a stream gap awaits one fetch, replies do not", async () => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses(true);
  await f.backend.statuses(true); expect(f.reads).toHaveBeenCalledTimes(1);
  f.roster.streamState(false);
  const response = holdRosterRead(f), reconciliation = holdRosterRead(f);
  let admitted = false;
  const admission = f.backend.statuses(true).then(() => { admitted = true; });
  expect(admitted).toBe(false);
  expect(await f.chats[1]!.statuses()).toEqual({ owner: { type: "busy", root: null } });
  f.event("owner", "needs-input"); response.resolve(structuredClone(f.server));
  await reconciliation.started;
  expect(admitted).toBe(false);
  expect((await f.chats[1]!.statuses()).owner?.type).toBe("busy");
  reconciliation.resolve(structuredClone(f.server)); await admission;
  expect(f.reads).toHaveBeenCalledTimes(3);
  expect(f.roster.status().detailErrors).toBeGreaterThanOrEqual(1);
  expect((await f.backend.statuses()).owner?.type).toBe("busy");
});

test("incomplete discovery refetches for admission and keeps the partial map for replies", async () => {
  const f = rosterFixture(); f.server.total = 501;
  expect((await f.backend.statuses()).owner?.type).toBe("busy");
  await expect(f.backend.statuses(true)).rejects.toThrow("Incomplete active family discovery");
  expect(f.reads).toHaveBeenCalledTimes(2);
  expect(f.roster.status()).toMatchObject({ complete: false, incomplete: 1, total: 501 });
  expect((await f.backend.statuses()).owner?.type).toBe("busy");
});

test("fetch failures retain busy families, fail admission closed and back off", async () => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses(); f.advance(30_000);
  f.reads.mockRejectedValue(new Error("offline"));
  expect((await f.backend.statuses()).owner?.type).toBe("busy");
  await expect(f.backend.statuses(true)).rejects.toThrow("offline");
  for (let i = 0; i < 20; i++) expect((await f.chats[i % 6]!.statuses()).owner?.type).toBe("busy");
  expect(f.reads).toHaveBeenCalledTimes(2); f.advance(1_000);
  f.reads.mockImplementation(async () => structuredClone(f.server)); await f.backend.statuses(true);
  expect(f.reads).toHaveBeenCalledTimes(3);
  expect(f.roster.status()).toMatchObject({ errors: 1, error_retry: 1 });
});

test("events during a slow refresh survive its older snapshot", async () => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses();
  const stale = structuredClone(f.server);
  f.advance(30_000); const response = holdRosterRead(f), reconciliation = holdRosterRead(f);
  let admitted = false;
  const admission = f.backend.statuses(true).then(statuses => { admitted = true; return statuses; });
  f.event("owner", "idle"); expect(await f.backend.statuses()).toHaveProperty("owner");
  response.resolve(stale); await reconciliation.started;
  expect(admitted).toBe(false);
  expect(await f.backend.statuses()).toHaveProperty("owner");
  reconciliation.resolve(structuredClone(f.server));
  expect(await admission).toEqual({});
  expect(await f.backend.statuses()).toEqual({}); expect(f.reads).toHaveBeenCalledTimes(3);
  expect(f.roster.status().detailErrors).toBeGreaterThanOrEqual(1);
});

test("old-run status cannot clear a newer busy foreground", async () => {
  const f = rosterFixture(); f.server.threads[0]!.activeRunId = "new-run";
  f.roster.streamState(true); await f.backend.statuses();
  let resolve!: (value: typeof f.server) => void;
  f.reads.mockImplementationOnce(() => new Promise(done => { resolve = done; })); f.event("owner", "idle", "old-run");
  expect((await f.backend.statuses()).owner?.type).toBe("busy");
  const admission = f.backend.statuses(true); resolve(structuredClone(f.server)); await admission;
  expect((await f.backend.statuses()).owner?.type).toBe("busy");
});

test("alias and root output equals the old algorithm over scripted server states", async () => {
  const f = rosterFixture(); const alias = new Map([["ses_imported", "root"]]);
  const old = (threads: typeof f.server.threads) => {
    const result: Record<string, import("../src/openchamber.ts").SessionStatus> = {};
    const aliases = new Map([...alias].map(([session, id]) => [id, session]));
    for (const thread of threads) if (["running", "needs-input", "queued"].includes(thread.state)) {
      const busy = { type: "busy" as const, root: thread.parentThreadId === null ? null : aliases.get(thread.rootThreadId) ?? thread.rootThreadId };
      result[thread.threadId] = busy; if (thread.nativeSessionId) result[thread.nativeSessionId] = busy;
    }
    for (const [session, id] of alias) if (result[id]) result[session] = result[id]!;
    return result;
  };
  for (const state of ["running", "needs-input", "queued", "waiting", "idle"] as const) {
    f.server.threads = [f.row("root", state), { ...f.row("child", state, "root"), nativeSessionId: "ses_child" }, { ...f.row("archived", "idle"), archived: true }];
    f.server.total = f.server.threads.length; f.advance(30_000);
    await f.roster.read(false, alias);
    expect(await f.roster.read(true, alias)).toEqual(old(f.server.threads));
  }
});

test("canonical route detail clears busy state without waiting for the safety refresh", async () => {
  const f = rosterFixture(); await f.backend.statuses();
  f.server.threads[0]!.state = "waiting";
  f.roster.observe(f.server.threads[0]!);
  expect(await f.backend.statuses()).toEqual({});
  expect(f.reads).toHaveBeenCalledTimes(1);
});

test("a status patch during a fetch preserves the fetched parentage and native identity", async () => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses();
  let resolve!: (value: typeof f.server) => void;
  f.advance(30_000); f.reads.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const refresh = f.backend.statuses(true);
  f.event("owner", "queued");
  f.server.threads[0] = { ...f.server.threads[0]!, parentThreadId: "new-root", rootThreadId: "new-root", nativeSessionId: "ses_new" };
  resolve(structuredClone(f.server));
  expect(await refresh).toEqual({ owner: { type: "busy", root: "new-root" }, ses_new: { type: "busy", root: "new-root" } });
});

test("one shared SSE subscription closes with the process and patches every chat", async () => {
  const f = rosterFixture();
  let opened!: () => void;
  const opening = new Promise<void>(resolve => { opened = resolve; });
  let stopped!: () => void;
  const stopping = new Promise<void>(resolve => { stopped = resolve; });
  const events = spyOn(f.client, "events").mockImplementation(async function* ({ signal }) {
    yield { id: "7", data: { type: "ready", sequence: 7, resumed: false } };
    await f.backend.statuses(true);
    f.server.threads[0]!.state = "idle";
    yield { id: "9", data: { type: "thread.status", threadId: "owner", state: "idle" } };
    await f.backend.statuses(true);
    opened();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    stopped();
  });
  f.roster.start(); f.roster.start(); await opening;
  expect(events).toHaveBeenCalledTimes(1);
  for (const chat of f.chats) expect(await chat.statuses()).toEqual({});
  f.roster.stop(); await stopping;
  expect(f.roster.status()).toMatchObject({ streamHealthy: false, streamUp: 1, streamDown: 1 });
});

test("SSE down: route detail clears its completed run without a list GET or changing another family", async () => {
  const f = rosterFixture();
  f.server.threads.push(f.row("another-family")); f.server.total = 2;
  await f.backend.statuses();
  const idle = { ...f.server.threads[0]!, state: "idle" as const, recentRuns: [], pendingRequests: [], run: null };
  spyOn(f.client, "thread").mockResolvedValue({ thread: idle });
  expect(await f.backend.sessionBusy("owner")).toBe(false);
  expect(await f.backend.statuses()).toEqual({ "another-family": { type: "busy", root: null } });
  expect(f.reads).toHaveBeenCalledTimes(1);
});

test.each(["event-before-detail", "detail-before-event"])("older idle detail never overwrites a newer busy event: %s", async order => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses();
  f.server.threads[0]!.state = "idle";
  f.roster.observe(f.server.threads[0]!);
  const idle = { ...f.server.threads[0]!, state: "idle" as const, recentRuns: [], pendingRequests: [], run: null };
  let finish!: (value: { thread: typeof idle }) => void;
  spyOn(f.client, "thread").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const detail = f.backend.sessionBusy("owner");
  // resolve(id) yields before the HTTP read starts; its promise marks the precise boundary.
  await Promise.resolve();
  if (order === "event-before-detail") f.event("owner", "running");
  finish({ thread: idle });
  expect(await detail).toBe(order === "event-before-detail");
  if (order === "detail-before-event") f.event("owner", "running");
  expect(await f.backend.statuses()).toEqual({ owner: { type: "busy", root: null } });
  expect(f.reads).toHaveBeenCalledTimes(1);
});

test("a repeated busy event also fences an older idle route detail", async () => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses();
  const idle = { ...f.server.threads[0]!, state: "idle" as const, recentRuns: [], pendingRequests: [], run: null };
  const response = Promise.withResolvers<{ thread: typeof idle }>();
  spyOn(f.client, "thread").mockReturnValue(response.promise);
  const detail = f.backend.sessionBusy("owner");
  await Promise.resolve();
  f.event("owner", "running");
  response.resolve({ thread: idle });
  expect(await detail).toBe(true);
  expect(await f.backend.statuses()).toHaveProperty("owner");
  expect(f.reads).toHaveBeenCalledTimes(1);
});

test.each(["running", "queued"])("another thread's %s event cannot discard a fresh idle route detail", async state => {
  const f = rosterFixture(); f.server.threads.push(f.row("other")); f.server.total = 2;
  f.roster.streamState(true); await f.backend.statuses();
  const idle = { ...f.server.threads[0]!, state: "idle" as const, recentRuns: [], pendingRequests: [], run: null };
  const response = Promise.withResolvers<{ thread: typeof idle }>();
  spyOn(f.client, "thread").mockReturnValue(response.promise);
  const detail = f.backend.sessionBusy("owner");
  await Promise.resolve();
  f.event("other", state);
  response.resolve({ thread: idle });
  expect(await detail).toBe(false);
  expect(await f.backend.statuses()).toEqual({ other: { type: "busy", root: null } });
  expect(f.reads).toHaveBeenCalledTimes(1);
});

const requestCases = [
  { kind: "question" as const, requestKind: "user_input" },
  ...["command", "file-read", "file-change", "mcp-elicitation", "permission", "dynamic_tool_call", "auth_refresh"]
    .map(requestKind => ({ kind: "approval" as const, requestKind })),
].flatMap(request => [null, "owner"].flatMap(parent =>
  (["idle", "waiting", "running", "queued"] as const).map(state => ({ ...request, parent, state }))));

test.each(requestCases)("request events preserve aggregate needs-input across run states (%j)", async ({ kind, requestKind, parent, state }) => {
  const f = rosterFixture();
  const request = { requestId: "pending", kind, requestKind };
  f.server.threads = [{ ...f.row("asking", state, parent), latestRunId: "run-1" }];
  f.roster.streamState(true); await f.backend.statuses();
  rosterEvent(f.roster, { type: "request.opened", threadId: "asking", ...request, status: "pending" });
  const busy = { asking: { type: "busy" as const, root: parent } };
  expect(await f.backend.statuses(true)).toEqual(busy);
  for (const [status, next] of [["waiting", "waiting"], ["completed", "idle"], ["queued", "queued"], ["running", "running"]]) {
    rosterEvent(f.roster, { type: "thread.status", threadId: "asking", runId: "run-1", status, state: next });
    expect(await f.backend.statuses(true)).toEqual(busy);
  }
  expect(f.reads).toHaveBeenCalledTimes(1);
  // A summary exposes only one pending request. Resolving one cannot prove there are no others.
  f.server.threads[0] = { ...f.server.threads[0]!, state: "needs-input", pendingRequest: { ...request, requestId: "second" } };
  rosterEvent(f.roster, { type: "request.resolved", threadId: "asking", ...request, status: "resolved" });
  expect(await f.backend.statuses(true)).toEqual(busy);
  f.server.threads[0] = { ...f.server.threads[0]!, state, pendingRequest: null };
  rosterEvent(f.roster, { type: "request.resolved", threadId: "asking", ...request, requestId: "second", status: "cancelled" });
  expect(await f.backend.statuses(true)).toEqual(["running", "queued"].includes(state) ? busy : {});
  expect(f.reads).toHaveBeenCalledTimes(3);
});

test.each([false, true])("an in-flight run-1 completion cannot erase a fetched busy run-2 (active id: %s)", async active => {
  const f = rosterFixture();
  f.server.threads[0] = { ...f.server.threads[0]!, latestRunId: "run-1", activeRunId: active ? "run-1" : null };
  f.roster.streamState(true); await f.backend.statuses();
  f.advance(30_000); const response = holdRosterRead(f), reconciliation = holdRosterRead(f);
  let admitted = false;
  const admission = f.backend.statuses(true).then(statuses => { admitted = true; return statuses; });
  rosterEvent(f.roster, { type: "thread.status", threadId: "owner", runId: "run-1", status: "completed", state: "idle" });
  f.server.threads[0] = { ...f.server.threads[0]!, latestRunId: "run-2", activeRunId: active ? "run-2" : null };
  response.resolve(structuredClone(f.server)); await reconciliation.started;
  expect(admitted).toBe(false);
  expect(await f.backend.statuses()).toEqual({ owner: { type: "busy", root: null } });
  reconciliation.resolve(structuredClone(f.server));
  expect(await admission).toEqual({ owner: { type: "busy", root: null } });
  expect(f.reads).toHaveBeenCalledTimes(3);
  expect(f.roster.status().detailErrors).toBeGreaterThanOrEqual(1);
});

test.each(["opening", "fetched", "resolved"])("request state remains authoritative during a slow refresh: %s", async source => {
  const f = rosterFixture();
  f.server.threads[0] = { ...f.server.threads[0]!, latestRunId: "run-1" };
  const request = { requestId: "question", kind: "question" as const, requestKind: "user_input" };
  if (source === "resolved") Object.assign(f.server.threads[0]!, { state: "needs-input", pendingRequest: request });
  f.roster.streamState(true); await f.backend.statuses();
  const stale = structuredClone(f.server);
  f.advance(30_000); const response = holdRosterRead(f), reconciliation = holdRosterRead(f);
  let admitted = false;
  const admission = f.backend.statuses(true).then(statuses => { admitted = true; return statuses; });
  if (source === "opening") {
    Object.assign(f.server.threads[0]!, { state: "needs-input", pendingRequest: request });
    rosterEvent(f.roster, { type: "request.opened", threadId: "owner", ...request, status: "pending" });
  }
  rosterEvent(f.roster, { type: "thread.status", threadId: "owner", runId: "run-1", status: "completed", state: "idle" });
  if (source === "resolved") {
    f.server.threads[0] = { ...f.server.threads[0]!, state: "idle", pendingRequest: null };
    rosterEvent(f.roster, { type: "request.resolved", threadId: "owner", ...request, status: "resolved" });
  }
  if (source === "fetched") {
    Object.assign(stale.threads[0]!, { state: "needs-input", pendingRequest: request });
    Object.assign(f.server.threads[0]!, { state: "needs-input", pendingRequest: request });
  }
  response.resolve(stale); await reconciliation.started;
  expect(admitted).toBe(false);
  expect(await f.backend.statuses()).toEqual({ owner: { type: "busy", root: null } });
  reconciliation.resolve(structuredClone(f.server));
  expect(await admission).toEqual(source === "resolved" ? {} : { owner: { type: "busy", root: null } });
  expect(await f.backend.statuses()).toEqual(source === "resolved" ? {} : { owner: { type: "busy", root: null } });
  expect(f.reads).toHaveBeenCalledTimes(3);
  expect(f.roster.status().detailErrors).toBeGreaterThanOrEqual(1);
});

const detailRequestRaces = (["question", "approval"] as const).flatMap(kind =>
  (["waiting", "idle"] as const).flatMap(state => [false, true].map(fail => ({ kind, state, fail }))));

test.each(detailRequestRaces)("a same-run detail cannot erase a fetched pending request (%j)", async ({ kind, state, fail }) => {
  const f = rosterFixture();
  f.server.threads = [{ ...f.row("child", "running", "owner"), activeRunId: null, latestRunId: "run-1" }];
  f.roster.streamState(true); await f.backend.statuses();
  f.advance(30_000); const response = holdRosterRead(f);
  const reconciliation = fail ? undefined : holdRosterRead(f);
  let admitted = false;
  const admission = f.backend.statuses(true).then(statuses => { admitted = true; return statuses; });
  f.roster.observe({ ...f.server.threads[0]!, state, status: state, pendingRequest: null, updatedAt: "2026-11-19T00:00:01Z" });
  f.server.threads[0] = { ...f.server.threads[0]!, state: "needs-input", updatedAt: "2026-11-19T00:00:02Z",
    pendingRequest: { requestId: "pending", kind, requestKind: kind === "question" ? "user_input" : "command" } };
  expect(f.roster.isBusy("child")).toBe(true);
  if (fail) response.reject(new Error("reconciliation offline"));
  else {
    response.resolve(structuredClone(f.server)); await reconciliation!.started;
    expect(admitted).toBe(false);
    expect(await f.backend.statuses()).toEqual({ child: { type: "busy", root: "owner" } });
    reconciliation!.resolve(structuredClone(f.server));
  }
  if (fail) await expect(admission).rejects.toThrow("reconciliation offline");
  else expect(await admission).toEqual({ child: { type: "busy", root: "owner" } });
  expect(await f.backend.statuses()).toEqual({ child: { type: "busy", root: "owner" } });
  expect(f.reads).toHaveBeenCalledTimes(fail ? 2 : 3);
  expect(f.roster.status().ambiguous).toBe(fail ? 0 : 1);
});

test.each(["fetched-busy", "detail-busy"])("conflicting same-run aggregate details preserve busy until reconciled: %s", async order => {
  const f = rosterFixture(); f.server.threads[0]!.latestRunId = "run-1";
  if (order === "detail-busy") f.server.threads[0]!.state = "waiting";
  f.roster.streamState(true); await f.backend.statuses();
  f.advance(30_000); const response = holdRosterRead(f), reconciliation = holdRosterRead(f);
  let admitted = false;
  const admission = f.backend.statuses(true).then(statuses => { admitted = true; return statuses; });
  f.roster.observe({ ...f.server.threads[0]!, state: order === "detail-busy" ? "running" : "waiting" });
  expect(f.roster.isBusy("owner")).toBe(true);
  response.resolve({ total: 1, threads: [{ ...f.server.threads[0]!, state: order === "fetched-busy" ? "running" : "waiting" }] });
  await reconciliation.started;
  expect(admitted).toBe(false);
  expect(await f.backend.statuses()).toEqual({ owner: { type: "busy", root: null } });
  f.server.threads[0]!.state = "running";
  reconciliation.resolve(structuredClone(f.server));
  expect(await admission).toEqual({ owner: { type: "busy", root: null } });
  expect(f.reads).toHaveBeenCalledTimes(3);
  expect(f.roster.status().ambiguous).toBe(1);
});

const drainingRunEvents = [
  { status: "waiting", state: "waiting" },
  ...["completed", "failed", "cancelled", "interrupted", "rolled_back"].map(status => ({ status, state: "idle" })),
];

test.each(drainingRunEvents)("a run's %s event reconciles a child with older active work", async ({ status, state }) => {
  const f = rosterFixture();
  f.server.threads = [{ ...f.row("child", "running", "owner"), activeRunId: "run-2", latestRunId: "run-2" }];
  f.roster.streamState(true); await f.backend.statuses();
  f.server.threads[0]!.activeRunId = "run-1";
  const response = Promise.withResolvers<typeof f.server>(); f.reads.mockReturnValueOnce(response.promise);
  rosterEvent(f.roster, { type: "thread.status", threadId: "child", runId: "run-2", status, state });
  // Replies use the retained view immediately, while complete family reads join one aggregate GET.
  expect(await f.backend.statuses()).toEqual({ child: { type: "busy", root: "owner" } });
  const admissions = Promise.all(f.chats.map(chat => chat.statuses(true)));
  response.resolve(structuredClone(f.server));
  for (const statuses of await admissions) expect(statuses).toEqual({ child: { type: "busy", root: "owner" } });
  expect(f.reads).toHaveBeenCalledTimes(2);
});

test("a failed aggregate read after a terminal event retains the overlapping child's busy state", async () => {
  const f = rosterFixture();
  f.server.threads = [{ ...f.row("child", "running", "owner"), activeRunId: "run-2", latestRunId: "run-2" }];
  f.roster.streamState(true); await f.backend.statuses();
  f.reads.mockRejectedValue(new Error("offline"));
  rosterEvent(f.roster, { type: "thread.status", threadId: "child", runId: "run-2", status: "completed", state: "idle" });
  await expect(f.backend.statuses(true)).rejects.toThrow("offline");
  expect(await f.backend.statuses()).toEqual({ child: { type: "busy", root: "owner" } });
  expect(f.reads).toHaveBeenCalledTimes(2);
});

test("a final run completion removes its busy mark after one aggregate reconciliation", async () => {
  const f = rosterFixture(); f.server.threads[0]!.latestRunId = "run-1";
  f.roster.streamState(true); await f.backend.statuses();
  f.server.threads = []; f.server.total = 0;
  rosterEvent(f.roster, { type: "thread.status", threadId: "owner", runId: "run-1", status: "completed", state: "idle" });
  expect(await f.backend.statuses(true)).toEqual({});
  expect(f.reads).toHaveBeenCalledTimes(2);
});

test("a busy detail for a different run keeps admission blocked until the fetch ambiguity is reconciled", async () => {
  const f = rosterFixture();
  f.server.threads[0] = { ...f.server.threads[0]!, latestRunId: "run-1" };
  f.roster.streamState(true); await f.backend.statuses();
  f.advance(30_000); const response = holdRosterRead(f), reconciliation = holdRosterRead(f);
  let admitted = false;
  const admission = f.backend.statuses(true).then(statuses => { admitted = true; return statuses; });
  const next = { ...f.server.threads[0]!, latestRunId: "run-2" };
  f.roster.observe(next);
  expect(f.roster.isBusy("owner")).toBe(true);
  response.resolve({ total: 1, threads: [{ ...f.server.threads[0]!, state: "idle" }] });
  await reconciliation.started;
  expect(admitted).toBe(false);
  expect(await f.backend.statuses()).toEqual({ owner: { type: "busy", root: null } });
  f.server.threads[0] = next;
  reconciliation.resolve(structuredClone(f.server));
  expect(await admission).toEqual({ owner: { type: "busy", root: null } });
  expect(f.reads).toHaveBeenCalledTimes(3);
  expect(f.roster.status().ambiguous).toBe(1);
});

test("a failed request-resolution fetch retains needs-input and rejects admission", async () => {
  const f = rosterFixture();
  const request = { requestId: "question", kind: "question" as const, requestKind: "user_input" };
  f.server.threads[0] = { ...f.server.threads[0]!, state: "needs-input", pendingRequest: request };
  f.roster.streamState(true); await f.backend.statuses();
  f.reads.mockRejectedValue(new Error("offline"));
  rosterEvent(f.roster, { type: "request.resolved", threadId: "owner", ...request, status: "resolved" });
  await expect(f.backend.statuses(true)).rejects.toThrow("offline");
  expect(await f.backend.statuses()).toEqual({ owner: { type: "busy", root: null } });
  expect(f.reads).toHaveBeenCalledTimes(2);
});

test.each(["resolved", "expired", "cancelled"])("a %s request cannot be revived by a later completion after leaving the active list", async status => {
  const f = rosterFixture();
  const request = { requestId: "question", kind: "question" as const, requestKind: "user_input" };
  f.server.threads[0] = { ...f.server.threads[0]!, state: "needs-input", pendingRequest: request, latestRunId: "run-1" };
  f.roster.streamState(true); await f.backend.statuses();
  f.server.threads = []; f.server.total = 0;
  rosterEvent(f.roster, { type: "request.resolved", threadId: "owner", ...request, status });
  expect(await f.backend.statuses(true)).toEqual({});
  rosterEvent(f.roster, { type: "thread.status", threadId: "owner", runId: "run-1", status: "completed", state: "idle" });
  expect(await f.backend.statuses(true)).toEqual({});
  expect(f.reads).toHaveBeenCalledTimes(2);
});

test.each([
  { threadId: "unknown" }, { requestId: null }, { kind: "unknown" }, { requestKind: null },
])("an unpatchable request opening shares one aggregate refetch (%j)", async fields => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses();
  const request = { requestId: "question", kind: "question" as const, requestKind: "user_input" };
  f.server.threads.push({ ...f.row("unknown", "needs-input", "owner"), pendingRequest: request }); f.server.total = 2;
  rosterEvent(f.roster, { type: "request.opened", threadId: "owner", ...request, ...fields, status: "pending" });
  for (const statuses of await Promise.all(f.chats.map(chat => chat.statuses(true)))) {
    expect(statuses.unknown).toEqual({ type: "busy", root: "owner" });
  }
  expect(f.reads).toHaveBeenCalledTimes(2);
  expect(f.roster.status()).toMatchObject({ misses: 1, roster_event: 1 });
});

test.each(["opened", "waiting", "completed", "detail-fetch", "detail-race"])("real backend steer admission finds a child's question after %s", async transition => {
  const start = Date.now(); setSystemTime(start);
  const h = delegatedRouter({
    chat: { key: "dm:+15555550123", slug: "owner", kind: "owner", title: "Owner" },
    roleOf: () => ({ name: "Owner", role: "owner" }), typing: () => false, react: async () => {},
  });
  h.store.acceptInbound("work", { id: "work", text: "Start work", attachments: [], isAudioMessage: false, source: "typed", receivedAt: start } satisfies NormalizedInbound);
  await h.router.tick();
  const route = h.store.get<{ id: string }>("route")!;
  const request: PendingRequest = { requestId: "child-question", kind: "question", requestKind: "user_input", canRespond: true,
    questions: [{ id: "choice", header: "Pick", question: "Which?", options: [{ label: "A" }] }] };
  const child: Thread = { ...h.control.threads.get(route.id)!, threadId: "asking", parentThreadId: route.id,
    runs: [{ runId: "child-run", ordinal: 1, status: transition === "detail-race" ? "running" : "waiting" }], messages: [], pending: ["opened", "detail-fetch", "detail-race"].includes(transition) ? [] : [request] };
  h.control.threads.set(child.threadId, child);
  h.backend.activeRoster.streamState(true);
  rosterEvent(h.backend.activeRoster, { type: "thread.created", threadId: child.threadId });
  await h.backend.statuses(true);
  const initial = h.control.calls.filter(call => call.path.includes("active=true")).length;
  // Deliver at admission, after any earlier request scan, so the real guard must use the patched roster.
  const statuses = h.backend.statuses.bind(h.backend);
  const admission = spyOn(h.backend, "statuses").mockImplementation(async complete => {
    if (complete) {
      if (transition === "detail-race") {
        const original = h.backend.client.thread.bind(h.backend.client);
        const { thread: old } = await original(child.threadId);
        const permission = Promise.withResolvers<{ thread: typeof old }>(), question = Promise.withResolvers<{ thread: typeof old }>();
        const entered = Promise.withResolvers<void>(), landed = Promise.withResolvers<void>();
        let reads = 0;
        spyOn(h.backend.client, "thread").mockImplementation(async id => {
          if (id !== child.threadId || reads >= 2) return original(id);
          if (++reads === 2) entered.resolve();
          return reads === 1 ? permission.promise : question.promise;
        });
        const permissions = h.backend.permissions.bind(h.backend);
        spyOn(h.backend, "permissions").mockImplementation(async (...args) => { const result = await permissions(...args); if (args[0] === child.threadId) landed.resolve(); return result; });
        const scan = h.router["requests"](h.store.get<Parameters<typeof h.router["requests"]>[0]>("activeTurn")!, await statuses(true), true);
        await entered.promise;
        child.pending = [request];
        permission.resolve(await original(child.threadId)); await landed.promise;
        question.resolve({ thread: { ...old, state: "waiting", pendingRequest: null, pendingRequests: [] } }); await scan;
      }
      else if (transition === "detail-fetch") {
        const read = h.backend.activeRoster.checkpoint(child.threadId);
        const { thread: older } = await h.backend.client.thread(child.threadId);
        const list = h.backend.client.listThreads.bind(h.backend.client);
        spyOn(h.backend.client, "listThreads").mockImplementationOnce(async args => {
          await Promise.resolve();
          h.backend.activeRoster.observe(older, read);
          child.pending = [request];
          return list(args);
        });
        setSystemTime(start + 30_000);
      }
      else if (transition === "opened") {
        child.pending = [request];
        rosterEvent(h.backend.activeRoster, { type: "request.opened", threadId: child.threadId, ...request, status: "pending" });
      }
      else {
        child.pending = [request];
        child.runs[0]!.status = transition;
        rosterEvent(h.backend.activeRoster, { type: "thread.status", threadId: child.threadId, runId: "child-run", status: transition, state: transition === "waiting" ? "waiting" : "idle" });
      }
    }
    return statuses(complete);
  });
  h.store.acceptInbound("steer", { id: "steer", text: "Change direction", attachments: [], isAudioMessage: false, source: "typed", receivedAt: start } satisfies NormalizedInbound);
  await h.router.tick();
  expect(admission.mock.calls.some(([complete]) => complete)).toBe(true);
  expect(h.control.calls.filter(call => call.path.endsWith("/send"))).toHaveLength(1);
  expect(h.router.routerStatus().pending).toMatchObject([{ sessionId: child.threadId, kind: "question", state: "pending" }]);
  expect(h.control.calls.filter(call => call.path.includes("active=true"))).toHaveLength(initial + (["detail-fetch", "detail-race"].includes(transition) ? 1 : 0));
});

test.each([undefined, "9", "10", "bad", "9007199254740992"])("unordered event sequence %s retains busy and refetches once", async id => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses();
  f.roster.event({ id: "10", data: { type: "thread.status", threadId: "owner", state: "queued" } });
  const response = Promise.withResolvers<typeof f.server>(); f.reads.mockReturnValueOnce(response.promise);
  f.roster.event({ id, data: { type: "thread.status", threadId: "owner", state: "running" } });
  expect(await f.backend.statuses()).toHaveProperty("owner");
  const admission = Promise.all(f.chats.map(chat => chat.statuses(true)));
  response.resolve(structuredClone(f.server)); await admission;
  expect(f.reads).toHaveBeenCalledTimes(2);
  expect(f.roster.status()).toMatchObject({ detailErrors: 1, roster_event: 1 });
});

test.each(["before", "during", "after"])("detail started %s the latest fetch clears only when ordered", async order => {
  const f = rosterFixture(); f.roster.streamState(true); await f.backend.statuses();
  let read = f.roster.checkpoint("owner");
  const response = Promise.withResolvers<typeof f.server>();
  f.advance(30_000); f.reads.mockReturnValueOnce(response.promise);
  const refresh = f.backend.statuses(true);
  if (order === "during") { f.roster.finish("owner", read); read = f.roster.checkpoint("owner"); }
  response.resolve(structuredClone(f.server)); await refresh;
  if (order === "after") { f.roster.finish("owner", read); read = f.roster.checkpoint("owner"); }
  f.server.threads[0]!.state = "idle";
  const reconciliation = order === "during" ? holdRosterRead(f) : undefined;
  f.roster.observe(f.server.threads[0]!, read);
  if (order === "after") expect(await f.backend.statuses()).toEqual({});
  else {
    if (reconciliation) {
      await reconciliation.started;
      let admitted = false;
      const admission = f.backend.statuses(true).then(statuses => { admitted = true; return statuses; });
      expect(await f.backend.statuses()).toHaveProperty("owner");
      expect(admitted).toBe(false);
      reconciliation.resolve(structuredClone(f.server));
      expect(await admission).toEqual({});
    } else {
      expect(await f.backend.statuses(true)).toHaveProperty("owner");
      f.roster.observe(f.server.threads[0]!);
    }
  }
  expect(await f.backend.statuses(true)).toEqual({});
  expect(f.reads).toHaveBeenCalledTimes(order === "during" ? 3 : 2);
  expect(f.roster.status().ambiguous).toBe(order === "during" ? 1 : 0);
});

test("real backend familyBusy stays true when a newer child run ends but older work continues", async () => {
  const h = delegatedRouter({
    chat: { key: "dm:+15555550123", slug: "owner", kind: "owner", title: "Owner" },
    roleOf: () => ({ name: "Owner", role: "owner" }), typing: () => false, react: async () => {},
  });
  const chat = await h.backend.createChat();
  const child: Thread = { ...h.control.threads.get(chat.id)!, threadId: "child", parentThreadId: chat.id,
    runs: [{ runId: "run-1", ordinal: 1, status: "running" }, { runId: "run-2", ordinal: 2, status: "running" }], messages: [], pending: [] };
  h.control.threads.set(child.threadId, child);
  h.backend.activeRoster.streamState(true); await h.backend.statuses(true);
  child.runs[1]!.status = "completed";
  rosterEvent(h.backend.activeRoster, { type: "thread.status", threadId: child.threadId, runId: "run-2", status: "completed", state: "idle" });
  const family = h.router as unknown as { familyBusy(route: { id: string; directory: string; generation: number }): Promise<boolean> };
  expect(await family.familyBusy({ ...chat, generation: 1 })).toBe(true);
  expect((await h.backend.statuses(true)).child).toEqual({ type: "busy", root: chat.id });
  expect(await family.familyBusy({ ...chat, generation: 1 })).toBe(true);
});

test("Sendblue finds a newly created child's question through the shared SSE-down fallback, without an event", async () => {
  const start = Date.now(); setSystemTime(start);
  const h = delegatedRouter({
    chat: { key: "dm:+15555550123", slug: "owner", kind: "owner", title: "Owner" },
    roleOf: () => ({ name: "Owner", role: "owner" }), typing: () => false, react: async () => {},
  });
  h.store.acceptInbound("new-child", { id: "new-child", text: "Start work", attachments: [], isAudioMessage: false, source: "typed", receivedAt: start } satisfies NormalizedInbound);
  await h.router.tick();
  const route = h.store.get<{ id: string }>("route")!;
  await h.backend.statuses();
  const parent = h.control.threads.get(route.id)!;
  h.control.threads.set("unannounced-child", { ...parent, threadId: "unannounced-child", parentThreadId: route.id,
    runs: [{ runId: "child-run", ordinal: 1, status: "running" }], messages: [], pending: [{
      requestId: "unannounced-question", kind: "question", requestKind: "user_input", canRespond: true,
      questions: [{ id: "choice", header: "Pick", question: "Which?", options: [{ label: "A" }] }],
    }] });
  expect(h.backend.activeRoster.status().streamHealthy).toBe(false);
  const initial = h.control.calls.filter(call => call.path.includes("active=true")).length;
  const listed = Promise.withResolvers<void>();
  const list = h.backend.client.listThreads.bind(h.backend.client);
  spyOn(h.backend.client, "listThreads").mockImplementation(async args => {
    const result = await list(args); if (args?.active) listed.resolve(); return result;
  });
  setSystemTime(start + 10_000);
  await h.router.tick();
  await listed.promise;
  await h.router.tick();
  expect(h.router.routerStatus().pending).toMatchObject([{ sessionId: "unannounced-child", kind: "question", state: "pending" }]);
  const counters = h.backend.activeRoster.status();
  expect(counters.stream_down).toBe(1);
  expect(h.control.calls.filter(call => call.path.includes("active=true"))).toHaveLength(initial + 1 + counters.ambiguous);
  expect(counters.roster_event).toBe(counters.ambiguous);
});
