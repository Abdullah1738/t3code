import { afterEach, describe, expect, test } from "bun:test";
import { toolError } from "../src/toollog.ts";
import { useToolLogFixture } from "./toollog-fixture.ts";
import { OpenChamber, type JsonValue } from "../src/openchamber.ts";
import { parseNotificationEvent } from "../src/notification-events.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server.url.origin;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
});

const form = {
  id: "frm_1", sessionID: "ses_1", title: "Questions",
  metadata: { kind: "question", tool: { messageID: "msg_tool", id: "call_1" } },
  fields: [{ key: "q0", title: "Choice", description: "Proceed?", type: "string", custom: true,
    options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] }],
};

describe("OpenCode 2 routes through OpenChamber", () => {
  test("pending lists, statuses, sessions and replies use v2 paths, envelopes and the directory header", async () => {
    const seen: Array<{ method: string; path: string; directory: string | null; body: unknown }> = [];
    const origin = serve(async request => {
      const url = new URL(request.url);
      seen.push({ method: request.method, path: url.pathname + url.search,
        directory: request.headers.get("x-opencode-directory"), body: request.body ? await request.json() : undefined });
      if (url.pathname === "/api/session/active") return Response.json({ data: { ses_1: { type: "running" } } });
      if (url.pathname === "/api/form") return Response.json({ location: { directory: "/Chats" }, data: [form, { ...form, id: "frm_mcp", sessionID: "global" }] });
      if (url.pathname === "/api/permission/request") return Response.json({ location: { directory: "/Chats" }, data: [{ id: "per_1", sessionID: "ses_1", action: "bash", resources: ["ls"] }] });
      if (url.pathname === "/api/session/ses_1") return Response.json({ data: { id: "ses_1", location: { directory: "/Chats" }, time: { created: 1, updated: 2 } } });
      return new Response(null, { status: 204 });
    });
    const client = new OpenChamber(origin);
    expect(await client.statuses()).toEqual({ ses_1: { type: "busy" } });
    const questions = await client.questions("/Chats/é");
    // MCP elicitations owned by `global` have no session to alert about.
    expect(questions.map(request => request.id)).toEqual(["frm_1"]);
    expect(questions[0]).toMatchObject({ title: "Questions", tool: { messageID: "msg_tool", id: "call_1" },
      questions: [{ key: "q0", question: "Proceed?", header: "Choice", custom: true, multiple: false }] });
    expect(await client.permissions("/Chats")).toEqual([{ id: "per_1", sessionID: "ses_1", action: "bash", resources: ["ls"] }]);
    expect(await client.getSession("ses_1", "/Chats")).toMatchObject({ id: "ses_1", directory: "/Chats" });
    expect(await client.permissionReply("ses_1", "per_1", "/Chats", "reject")).toBe(true);
    expect(await client.questionReply(questions[0]!, "/Chats", [["Yes"]])).toBe(true);
    expect(await client.cancelQuestion("ses_1", "frm_1", "/Chats")).toBe(true);
    expect(seen).toEqual([
      { method: "GET", path: "/api/session/active", directory: null, body: undefined },
      { method: "GET", path: "/api/form", directory: encodeURIComponent("/Chats/é"), body: undefined },
      { method: "GET", path: "/api/permission/request", directory: "%2FChats", body: undefined },
      { method: "GET", path: "/api/session/ses_1", directory: "%2FChats", body: undefined },
      { method: "POST", path: "/api/session/ses_1/permission/per_1/reply", directory: "%2FChats", body: { decision: "reject" } },
      { method: "POST", path: "/api/session/ses_1/form/frm_1/reply", directory: "%2FChats", body: { answer: { q0: "yes" } } },
      { method: "DELETE", path: "/api/session/ses_1/form/frm_1", directory: "%2FChats", body: undefined },
    ]);
  });

  test("malformed pending lists and statuses fail instead of reading as empty", async () => {
    let payload: JsonValue = null;
    const client = new OpenChamber(serve(() => Response.json(payload)));
    for (const invalid of [null, [], { data: [] }, { data: { ses_1: "running" } }] as JsonValue[]) {
      payload = invalid;
      await expect(client.statuses()).rejects.toThrow();
    }
    for (const invalid of [null, {}, { data: {} }, { data: [{ id: "x" }] }] as JsonValue[]) {
      payload = invalid;
      await expect(client.permissions("/Chats")).rejects.toThrow();
      await expect(client.questions("/Chats")).rejects.toThrow();
    }
  });
});

describe("notification events", () => {
  const wire = (type: string, data: { [key: string]: JsonValue }, location: JsonValue = { directory: "/Chats" }): JsonValue =>
    ({ id: "evt_1", type, created: 1, location, data });

  test("decodes OpenCode 2 form, permission and execution events", () => {
    expect(parseNotificationEvent(wire("form.created", { form: { id: "frm_1", sessionID: "ses_1", title: "Q", fields: [] } })))
      .toEqual({ type: "asked", kind: "question", sessionId: "ses_1", directory: "/Chats", requestId: "frm_1" });
    for (const type of ["form.replied", "form.cancelled"]) {
      expect(parseNotificationEvent(wire(type, { id: "frm_1", sessionID: "ses_1" })))
        .toEqual({ type: "resolved", kind: "question", sessionId: "ses_1", directory: "/Chats", requestId: "frm_1" });
    }
    expect(parseNotificationEvent(wire("permission.asked", { id: "per_1", sessionID: "ses_1", action: "bash", resources: [] })))
      .toEqual({ type: "asked", kind: "approval", sessionId: "ses_1", directory: "/Chats", requestId: "per_1" });
    expect(parseNotificationEvent(wire("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "once" })))
      .toEqual({ type: "resolved", kind: "approval", sessionId: "ses_1", directory: "/Chats", requestId: "per_1" });
    expect(parseNotificationEvent(wire("session.execution.started", { sessionID: "ses_1" })))
      .toEqual({ type: "status", status: "busy", sessionId: "ses_1", directory: "/Chats" });
    for (const type of ["session.execution.succeeded", "session.execution.failed"]) {
      expect(parseNotificationEvent(wire(type, { sessionID: "ses_1" })))
        .toEqual({ type: "status", status: "idle", sessionId: "ses_1", directory: "/Chats" });
    }
    expect(parseNotificationEvent(wire("session.execution.interrupted", { sessionID: "ses_1", reason: "user" })))
      .toEqual({ type: "status", status: "idle", sessionId: "ses_1", directory: "/Chats" });
    expect(parseNotificationEvent(wire("session.inbox.enqueued", { sessionID: "ses_1", inboxID: "msg_1", item: { type: "user" } })))
      .toEqual({ type: "changed", sessionId: "ses_1", directory: "/Chats" });
  });

  test("shutdown interruptions, synthetic inbox items and unrelated events are ignored", () => {
    expect(parseNotificationEvent(wire("session.execution.interrupted", { sessionID: "ses_1", reason: "shutdown" }))).toBeUndefined();
    expect(parseNotificationEvent(wire("session.inbox.enqueued", { sessionID: "ses_1", inboxID: "msg_1", item: { type: "synthetic" } }))).toBeUndefined();
    for (const type of ["session.text.delta", "question.asked", "session.status", "session.idle"]) {
      expect(parseNotificationEvent(wire(type, { sessionID: "ses_1" }))).toBeUndefined();
    }
  });

  test("missing locations, global owners and malformed identities only wake a recheck", () => {
    expect(parseNotificationEvent(wire("session.execution.started", { sessionID: "ses_1" }, null))).toEqual({ type: "wake" });
    expect(parseNotificationEvent(wire("form.created", { form: { id: "frm_1", sessionID: "global" } }))).toEqual({ type: "wake" });
    expect(parseNotificationEvent(wire("permission.asked", { id: "per_1", sessionID: 7 }))).toEqual({ type: "wake" });
    expect(parseNotificationEvent(wire("permission.replied", { sessionID: "ses_1" }))).toEqual({ type: "wake" });
  });

  test("execution events without a location use the directory last seen for the session", () => {
    const directories = new Map<string, string>();
    const started = wire("session.execution.started", { sessionID: "ses_1" }, null);
    expect(parseNotificationEvent(started, directories)).toEqual({ type: "wake" });
    parseNotificationEvent(wire("session.inbox.enqueued", { sessionID: "ses_1", inboxID: "msg_1", item: { type: "user" } }), directories);
    expect(parseNotificationEvent(started, directories)).toEqual({ type: "status", status: "busy", sessionId: "ses_1", directory: "/Chats" });
    expect(parseNotificationEvent(wire("session.execution.succeeded", { sessionID: "ses_1" }, null), directories))
      .toEqual({ type: "status", status: "idle", sessionId: "ses_1", directory: "/Chats" });
    expect(parseNotificationEvent(wire("session.execution.started", { sessionID: "ses_2" }, null), directories)).toEqual({ type: "wake" });
  });

  test("connection and OpenChamber control events keep their meaning", () => {
    for (const type of ["server.connected", "global.disposed", "location.shutdown"]) {
      expect(parseNotificationEvent({ id: "evt_0", type, data: {} })).toEqual({ type: "invalidate" });
    }
    expect(parseNotificationEvent({ type: "openchamber:permission-auto-accept.updated", properties: {} })).toEqual({ type: "invalidate" });
    expect(parseNotificationEvent({ type: "openchamber:session-board.updated", properties: { entries: [
      { sessionId: "ses_1", directory: "/Chats", state: "waiting", status: "idle", workRevision: 2 },
    ] } })).toEqual({ type: "board", entries: [{ identity: "/Chats\0ses_1", fingerprint: JSON.stringify(["waiting", "idle", 2, undefined, undefined, undefined]) }] });
  });
});

const legacyLogs = useToolLogFixture();

test("legacy backend preserves sanitized wrapper diagnostics", async () => {
  const original = globalThis.fetch;
  const client = new OpenChamber("http://127.0.0.1:1");
  const secret = "private-thread-id private-title private-token private-message";
  const cases: Array<{ error: unknown; props: Record<string, string> }> = [
    { error: new TypeError(secret), props: { cause: "unclassified", detail: "TypeError", errorClass: "TypeError" } },
    { error: { code: "UND_ERR_SOCKET", message: secret }, props: { cause: "socket_closed", detail: "UND_ERR_SOCKET" } },
    ...["ConnectionRefused", "FailedToOpenSocket"].map(code => ({
      error: Object.assign(new TypeError(secret), { code, errno: 0 }), props: { cause: "ECONNREFUSED", detail: code },
    })),
    { error: secret, props: { cause: "non_error", detail: "String" } },
  ];
  try {
    for (const { error: failure, props } of cases) {
      globalThis.fetch = Object.assign(async () => { throw failure; }, { preconnect: original.preconnect });
      try { await client.request("/api/permission/request"); } catch (error) { toolError("telegram", "tg.attention.pendingRequests", undefined, error); }
      expect(legacyLogs.entries().at(-1)?.props).toEqual(props);
    }
  } finally { globalThis.fetch = original; }
  for (const part of secret.split(" ")) expect(legacyLogs.text()).not.toContain(part);
});


test("legacy fetch and JSON body failures preserve every non-Error input form", async () => {
  const original = globalThis.fetch;
  const client = new OpenChamber("http://127.0.0.1:1");
  const secret = "private-thread-id private-title private-token private-message";
  const cases: Array<{ failure: unknown; cause: string; detail: string }> = [
    { failure: undefined, cause: "non_error", detail: "Undefined" },
    { failure: null, cause: "non_error", detail: "Null" },
    { failure: "", cause: "non_error", detail: "String" },
    { failure: secret, cause: "non_error", detail: "String" },
    { failure: 0, cause: "non_error", detail: "Number" },
    { failure: 123, cause: "non_error", detail: "Number" },
    { failure: NaN, cause: "non_error", detail: "Number" },
    { failure: false, cause: "non_error", detail: "Boolean" },
    { failure: true, cause: "non_error", detail: "Boolean" },
    { failure: 0n, cause: "non_error", detail: "BigInt" },
    { failure: Symbol(secret), cause: "non_error", detail: "Symbol" },
    { failure: () => secret, cause: "non_error", detail: "Function" },
    { failure: { message: secret }, cause: "unclassified", detail: "Object" },
    { failure: [secret], cause: "unclassified", detail: "Array" },
  ];
  try {
    for (const { failure, cause, detail } of cases) {
      for (const stage of ["fetch", "body"]) {
        globalThis.fetch = Object.assign(async () => {
          if (stage === "fetch") throw failure;
          // ReadableStream.error(undefined) can close instead of rejecting on some runtimes.
          const response = new Response();
          response.json = async () => { throw failure; };
          return response;
        }, { preconnect: original.preconnect });
        let caught: unknown;
        try { await client.request("/api/permission/request"); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(Error);
        toolError("telegram", "tg.attention.pendingRequests", undefined, caught);
        const props: Record<string, string> = { cause, detail };
        if (cause === "unclassified") props.errorClass = detail;
        expect(legacyLogs.entries().at(-1)?.props).toEqual(props);
      }
    }
  } finally { globalThis.fetch = original; }
  expect(legacyLogs.entries().filter(row => row.error?.tag === "tg.attention.pendingRequests")).toHaveLength(cases.length * 2);
  for (const part of secret.split(" ")) expect(legacyLogs.text()).not.toContain(part);
});
