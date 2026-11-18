import { afterEach, expect, spyOn, test } from "bun:test";
import { ControlError, type ControlMessage } from "../src/control.ts";
import { RobobBackend, sentMessagePrefix } from "../src/robob.ts";
import { captureLogs } from "./log-fixture.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop(true))); });

function setup(status: number, reason?: string, retrySafe = false, admitted = false) {
  const id = "thread-test", prompt = `msg_${"d".repeat(64)}`;
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const holder = { runId: "run:thread:thread-test:ordinal:24", state: "running" };
  const messages: ControlMessage[] = admitted ? [{ messageId: `${sentMessagePrefix(id)}${prompt}`, runId: holder.runId,
    role: "user", text: "PRIVATE_TEXT", streaming: false, createdAt: null, updatedAt: null }] : [];
  let readFails = false;
  let pendingRequests: { requestId: string }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
    calls.push({ method: request.method, path, body });
    if (request.method === "POST") return Response.json({ ok: false, error: {
      code: "conflict", reason, retrySafe, holder, message: "PRIVATE_ERROR", token: "PRIVATE_TOKEN",
    } }, { status });
    if (readFails) return Response.json({ ok: false }, { status: 503 });
    return Response.json(path.endsWith("/messages") ? { ok: true, messages } : {
      ok: true, thread: { threadId: id, recentRuns: [], run: null, pendingRequests, state: "running" },
    });
  } });
  servers.push(server);
  const backend = new RobobBackend({ chatRoot: "/chats", url: server.url.origin, token: "test-token" });
  return { backend, id, prompt, calls, holder, failReads: () => { readFails = true; }, pending: () => { pendingRequests = [{ requestId: "request" }]; } };
}

test.each([undefined, "no_steerable_turn"])("control refusal %s is definite and retains safe diagnostics", async reason => {
  const h = setup(409, reason);
  const logs = await captureLogs(async () => {
    expect(await h.backend.steer(h.id, "/chats", h.prompt, "PRIVATE_TEXT")).toBe("refused");
  });
  expect(h.calls.map(call => call.method)).toEqual(["POST"]);
  const failure = logs.find(line => line.kind === "error" && line.props?.retrySafe === false);
  expect(failure?.props?.holderRunId).toBe(h.holder.runId);
  if (reason) expect(failure?.props?.controlReason).toBe(reason);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_");
});

const conflicts = ["thread_archived", "attempt_changed", "run_not_interruptible", "run_not_found", "command_id_conflict", "command_rejected", "operation_conflict", "reader_unavailable", "server_error"];
test.each(conflicts.flatMap(reason => [false, true].map(admitted => ({ reason, admitted }))))("control $reason reconciles before deciding admission (admitted=$admitted)", async ({ reason, admitted }) => {
  const h = setup(reason === "server_error" ? 500 : reason === "reader_unavailable" ? 503 : 409, reason === "server_error" ? undefined : reason, false, admitted);
  expect(await h.backend.steer(h.id, "/chats", h.prompt, "PRIVATE_TEXT")).toBe(admitted ? "steered" : "refused");
  expect(h.calls.map(call => call.method)).toEqual(["POST", "GET", "GET"]);
});

test.each(["startup_unavailable", "send_timeout"].flatMap(reason => ["steer", "auto"].map(mode => ({ reason, mode }))))("control $reason retries retain $mode and identity", async ({ reason, mode }) => {
  const h = setup(503, reason, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const sending = mode === "steer" ? h.backend.steer(h.id, "/chats", h.prompt, "PRIVATE_TEXT")
      : h.backend.prompt(h.id, "/chats", h.prompt, "PRIVATE_TEXT");
    await expect(sending).rejects.toMatchObject({ status: 503, reason, retrySafe: true });
  }
  expect(h.calls.map(call => [call.body.clientRequestId, call.body.mode])).toEqual([[h.prompt, mode], [h.prompt, mode]]);
  expect(h.calls[0]!.body).toEqual(h.calls[1]!.body);
});

test("control request_resolved never repeats the answer", async () => {
  const h = setup(409, "request_resolved");
  await expect(h.backend.questionReply({ id: "request", sessionID: h.id, title: "Choice", questions: [{ key: "q", header: "Choice", question: "Choose", options: [{ label: "A" }] }] }, "/chats", [["A"]], "human"))
    .rejects.toMatchObject({ reason: "request_resolved", retrySafe: false });
  expect(h.calls.map(call => call.method)).toEqual(["POST"]);
});

test.each(["pending", "cancelled", "answered-elsewhere"])("respond reader failure never treats %s resolution as our receipt", async state => {
  const h = setup(503, "reader_unavailable");
  if (state === "pending") h.pending();
  const answering = h.backend.questionReply({ id: "request", sessionID: h.id, title: "Choice", questions: [{ key: "q", header: "Choice", question: "Choose", options: [{ label: "A" }] }] }, "/chats", [["A"]], "human");
  await expect(answering).rejects.toMatchObject({ reason: "reader_unavailable", reconciled: true });
  expect(h.calls.map(call => [call.method, call.path])).toEqual([["POST", `/api/ardud/control/threads/${h.id}/requests/request/respond`], ["GET", `/api/ardud/control/threads/${h.id}`]]);
});

test("control reconcile failure stays uncertain and carries the original reason", async () => {
  const h = setup(503, "reader_unavailable"); h.failReads();
  await expect(h.backend.steer(h.id, "/chats", h.prompt, "PRIVATE_TEXT")).rejects.toMatchObject({ reason: "reader_unavailable", reconciled: false });
  expect(h.calls.map(call => call.method)).toEqual(["POST", "GET"]);
});

test("ControlError retains only routing fields from the response", () => {
  const error = new ControlError(409, "conflict", { reason: "thread_archived", retrySafe: false, holder: { runId: "run:24", state: "completed" } });
  expect(error).toMatchObject({ status: 409, code: "conflict", reason: "thread_archived", retrySafe: false, holder: { runId: "run:24", state: "completed" } });
});


test.each(["startup_unavailable", "send_timeout"].flatMap(reason => ["question", "permission"].map(kind => ({ reason, kind }))))("response $reason retries retain the $kind endpoint, identity and body", async ({ reason, kind }) => {
  const h = setup(503, reason, true);
  for (let n = 0; n < 2; n++) {
    const result = kind === "question" ? h.backend.questionReply({ id: "request", sessionID: h.id, title: "Choice", questions: [{ key: "q", header: "Choice", question: "Choose", options: [{ label: "A" }] }] }, "/chats", [["A"]], "human")
      : h.backend.permissionReply(h.id, "request", "/chats", "once", "human");
    await expect(result).rejects.toMatchObject({ reason, retrySafe: true });
  }
  expect(h.calls).toHaveLength(2);
  expect(h.calls[0]).toEqual(h.calls[1]);
  expect(h.calls[0]!.body.clientRequestId).toMatch(/^respond_[a-f0-9]{64}$/);
});

test.each(["truncated", "reset", "timeout"].flatMap(failure => ["question", "permission"].map(kind => ({ failure, kind }))))("committed $kind response with $failure body reconciles after HTTP200", async ({ failure, kind }) => {
  const calls: { method: string; body?: Record<string, unknown> }[] = [];
  let readable = false;
  const fetching = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
    if (method === "POST") {
      const response = new Response("{", { status: 200 });
      if (failure !== "truncated") response.json = async () => { throw new DOMException("Body unavailable", failure === "timeout" ? "TimeoutError" : "NetworkError"); };
      return response;
    }
    return readable ? Response.json({ ok: true, thread: { pendingRequests: [] } }) : Response.json({ ok: false }, { status: 503 });
  }) as typeof fetch);
  try {
    const backend = new RobobBackend({ chatRoot: "/chats", url: "http://127.0.0.1:1", token: "test-token" });
    const result = kind === "question"
      ? backend.questionReply({ id: "request", sessionID: "thread-test", title: "Choice", questions: [{ key: "q", header: "Choice", question: "Choose", options: [{ label: "A" }] }] }, "/chats", [["A"]], "human")
      : backend.permissionReply("thread-test", "request", "/chats", "once", "human");
    await expect(result).rejects.toMatchObject({ status: 200, reconciled: false });
    expect(calls.map(call => call.method)).toEqual(["POST", "GET"]);
    expect(calls[0]!.body?.clientRequestId).toMatch(/^respond_[a-f0-9]{64}$/);
    readable = true;
    expect(await backend.responseResolved("thread-test", "/chats", "request")).toBe(true);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  } finally { fetching.mockRestore(); }
});
