import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  OpenChamber,
  assistantText,
  formAnswer,
  questionFromForm,
  DEFAULT_CHANNEL_SYSTEM,
  type FilePart,
  type FormInfo,
  type MessageRecord,
  type JsonValue,
} from "../src/openchamber.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server.url.origin;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

type Assistant = Extract<MessageRecord, { type: "assistant" }>;

function message(content: Assistant["content"] = []): Assistant {
  return { id: "msg_answer", type: "assistant", content, finish: "stop", time: { created: 1, completed: 2 } };
}

const questionForm: FormInfo = {
  id: "frm_1", sessionID: "ses_chat", title: "Questions",
  metadata: { kind: "question", tool: { messageID: "msg_tool", id: "call_1" } },
  fields: [
    { key: "q0", title: "Choice", description: "Which?", type: "string", custom: true,
      options: [{ value: "a", label: "A", description: "First" }, { value: "b", label: "B" }] },
    { key: "q1", title: "Many", description: "Which ones?", type: "multiselect", custom: false,
      options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
  ],
};

describe("OpenChamber isolated transport", () => {
  test("malformed status and pending-request snapshots fail instead of granting empty authority", async () => {
    let payload: JsonValue = null;
    const client = new OpenChamber(serve(() => Response.json(payload)));
    for (const invalid of [null, [], { data: [] }, { data: { session: null } }, { data: { session: {} } }] as JsonValue[]) {
      payload = invalid;
      await expect(client.statuses()).rejects.toThrow();
    }
    for (const invalid of [null, {}, { data: {} }, [null], [{ id: "ask" }], [{ id: 1, sessionID: "session" }], { data: [{ id: "ask", sessionID: "s" }] }] as JsonValue[]) {
      payload = invalid;
      await expect(client.permissions("s", "/repo")).rejects.toThrow();
      await expect(client.questions("s", "/repo")).rejects.toThrow();
    }
    payload = { data: {} };
    expect(await client.statuses()).toEqual({});
    payload = { data: { ses_a: { type: "running" } } };
    expect(await client.statuses()).toEqual({ ses_a: { type: "busy" } });
    payload = { data: [] };
    expect(await client.permissions("s", "/repo")).toEqual([]);
    expect(await client.questions("s", "/repo")).toEqual([]);
  });
  test("resolves default and nearest explicit policies from real scoped HTTP reads", async () => {
    let policy = { defaultEnabled: true, sessions: {} as Record<string, boolean>, revision: 1 };
    let mode = "valid";
    const origin = serve(request => {
      const url = new URL(request.url);
      if (url.pathname === "/api/permission-auto-accept") return Response.json(policy);
      expect(decodeURIComponent(request.headers.get("x-opencode-directory")!)).toBe("/repo");
      if (mode === "missing") return Response.json(null);
      const id = url.pathname.split("/").at(-1)!;
      return Response.json({ data: { id, location: { directory: mode === "mismatch" ? "/wrong" : "/repo" }, title: id,
        parentID: mode === "cycle" ? (id === "child" ? "root" : "child") : id === "child" ? "root" : undefined } });
    });
    const client = new OpenChamber(origin);
    expect(await client.isSessionAutoAccepting("child", "/repo")).toBe(true);
    policy = { defaultEnabled: true, sessions: { root: false }, revision: 2 };
    expect(await client.isSessionAutoAccepting("child", "/repo")).toBe(false);
    policy = { defaultEnabled: false, sessions: { child: true, root: false }, revision: 3 };
    expect(await client.isSessionAutoAccepting("child", "/repo")).toBe(true);
    policy = { defaultEnabled: true, sessions: {}, revision: 4 };
    for (mode of ["missing", "mismatch", "cycle"]) expect(await client.isSessionAutoAccepting("child", "/repo")).toBeUndefined();
  });
  test("accepts every session board lane and rejects unknown states", async () => {
    let state = "scheduled";
    const origin = serve(() => Response.json({
      version: 1, revision: 4, activatedAt: 1, migrationComplete: true, syncError: null,
      entries: [
        { sessionId: "running", directory: "/repo", title: "Running", state: "running", workRevision: 1, updatedAt: 1 },
        { sessionId: "waiting", directory: "/repo", title: "Waiting", state: "waiting", workRevision: 2, updatedAt: 2 },
        { sessionId: "backlog", directory: "/repo", title: "Backlog", state: "backlog", workRevision: 3, updatedAt: 3 },
        { sessionId: "scheduled", directory: "/repo", title: "Scheduled", projectId: "project", state, workRevision: 4, updatedAt: 4,
          attention: { kind: "question", count: 1, label: "Needs input" } },
      ],
    }));
    const client = new OpenChamber(origin);
    expect((await client.sessionBoard()).entries.map(entry => entry.state)).toEqual(["running", "waiting", "backlog", "scheduled"]);
    state = "completed";
    await expect(client.sessionBoard()).rejects.toThrow();
  });
  test("JSON and SSE explicitly disable proxies and verbose tracing", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(null, { status: 204 })) as unknown as typeof fetch);
    const timeoutSpy = spyOn(AbortSignal, "timeout");
    try {
      const client = new OpenChamber("http://127.0.0.1:1", { Authorization: "Bearer test-only" });
      await client.prompt("ses_chat", "/Chats/test", "msg_1", "private message", "");
      const controller = new AbortController();
      for (const path of ["/api/event", "/api/openchamber/events"] as const) {
        expect(await client.events(path, controller.signal).next()).toEqual({ value: undefined, done: true });
      }
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      for (const [, init] of fetchSpy.mock.calls) {
        expect(init).toMatchObject({ proxy: "", verbose: false, redirect: "manual" });
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-only");
      }
      expect(fetchSpy.mock.calls[0][1]?.body).toContain("private message");
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
      expect(fetchSpy.mock.calls[1][1]?.signal).toBe(controller.signal);
      expect(fetchSpy.mock.calls[2][1]?.signal).toBe(controller.signal);
    } finally {
      fetchSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });

  for (const phase of ["headers", "body"] as const) {
    test.each(["timeout", "timeout with caller", "caller"])(`%s aborts pending ${phase} requests`, async source => {
      const deadline = new AbortController();
      const caller = new AbortController();
      const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      let signal: AbortSignal | undefined;
      let began!: () => void;
      const started = new Promise<void>(resolve => { began = resolve; });
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
        signal = init?.signal ?? undefined;
        if (phase === "headers") {
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
            began();
          });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal?.reason), { once: true });
          },
          pull() { began(); },
        }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/json" } });
      }) as typeof fetch);
      try {
        const pending = new OpenChamber("http://127.0.0.1:1").request("/test", {
          ...(source !== "timeout" ? { signal: caller.signal } : {}),
        });
        await started;
        expect(timeoutSpy).toHaveBeenCalledWith(15_000);
        expect(signal?.aborted).toBe(false);
        (source === "caller" ? caller : deadline).abort(new Error("private abort reason"));
        expect(signal?.aborted).toBe(true);
        const error = await pending.catch((error: unknown) => error);
        expect(error).toMatchObject({
          name: "AbortError", message: `OpenChamber request failed (HTTP ${phase === "headers" ? 0 : 200})`,
        });
        expect((error as Error).cause).toBeUndefined();
        expect(source === "caller" ? deadline.signal.aborted : caller.signal.aborted).toBe(false);
      } finally {
        fetchSpy.mockRestore();
        timeoutSpy.mockRestore();
      }
    });
  }

  test("a pre-aborted caller remains aborted with the default deadline", async () => {
    const caller = AbortSignal.abort(new Error("private reason"));
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      expect(init?.signal?.aborted).toBe(true);
      init?.signal?.throwIfAborted();
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    try {
      await expect(new OpenChamber("http://127.0.0.1:1").request("/test", { signal: caller })).rejects.toMatchObject({
        name: "AbortError", message: "OpenChamber request failed (HTTP 0)",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("long-lived SSE ignores the JSON deadline but still obeys caller cancellation", async () => {
    const deadline = new AbortController();
    const caller = new AbortController();
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ status: "ok" }))
      .mockResolvedValueOnce(new Response('data: {"type":"ready"}\n\ndata: {"type":"next"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }));
    const client = new OpenChamber("http://127.0.0.1:1");
    const events = client.events("/api/event", caller.signal);
    try {
      await client.health();
      expect((await events.next()).value).toEqual({ type: "ready" });
      deadline.abort();
      expect((await events.next()).value).toEqual({ type: "next" });
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      caller.abort("private reason");
      await expect(events.next()).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await events.return();
      fetchSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });
});

describe("OpenChamber HTTP", () => {
  test("JSON requests preserve headers, percent-encoded directory scope, body, and typed responses", async () => {
    const origin = serve(async (request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/example");
      expect(url.searchParams.get("limit")).toBe("7");
      // OpenCode 2 reads the location from the header, never from a query parameter.
      expect(url.searchParams.getAll("directory")).toEqual(["old"]);
      expect(request.headers.get("x-opencode-directory")).toBe(encodeURIComponent("/Chats/a b&c?#"));
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer test-only");
      expect(request.headers.get("accept")).toBe("application/json");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(await request.json()).toEqual({ text: "hello" });
      return Response.json({ accepted: true });
    });
    const client = new OpenChamber(origin, { authorization: "Bearer test-only" });
    const result = await client.request<{ accepted: boolean }>("/api/example?limit=7&directory=old", {
      method: "POST", body: { text: "hello" }, directory: "/Chats/a b&c?#",
    });
    expect(result?.accepted).toBe(true);
  });

  test.each([undefined, "User-chosen title"])("creates a Chats directory and preserves native auto-naming unless title is provided: %j", async (title) => {
    const calls: string[] = [];
    let directory = "";
    const before = new Date();
    const origin = serve(async (request) => {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/fs/home") {
        return Response.json({ home: "/Users/test", chatsRoot: "/configured/Chats/" });
      }
      if (url.pathname === "/api/fs/mkdir") {
        const body = await request.json() as { path: string };
        directory = body.path;
        expect(Object.keys(body)).toEqual(["path"]);
        return new Response(null, { status: 204 });
      }
      expect(url.pathname).toBe("/api/session");
      expect(decodeURIComponent(request.headers.get("x-opencode-directory")!)).toBe(directory);
      // Marked as an iMessage conversation at creation; subagents inherit it.
      expect(await request.json()).toEqual({
        location: { directory }, metadata: { openchamber: { origin: "imessage" } }, ...(title === undefined ? {} : { title }),
      });
      return Response.json({ data: { id: "ses_new", location: { directory }, title } });
    });
    expect(await new OpenChamber(origin).createChat(title)).toEqual({ id: "ses_new", directory });
    expect(directory).toMatch(/^\/configured\/Chats\/\d{4}-\d{2}-\d{2}\/session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const dates = [before, new Date()].map((date) =>
      [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"),
    );
    expect(dates).toContain(directory.split("/")[3]);
    expect(calls).toEqual(["GET /api/fs/home", "POST /api/fs/mkdir", "POST /api/session"]);
  });

  test.each([{}, { home: "/home/test" }, { chatsRoot: "relative" }, { chatsRoot: 42 }])(
    "fails closed on invalid chat root %j", async (payload) => {
      let calls = 0;
      const origin = serve(() => { calls++; return Response.json(payload); });
      await expect(new OpenChamber(origin).createChat("chat")).rejects.toThrow("Invalid OpenChamber chats root");
      expect(calls).toBe(1);
    },
  );

  test("does not create a session when directory creation fails", async () => {
    const calls: string[] = [];
    const origin = serve((request) => {
      const path = new URL(request.url).pathname;
      calls.push(path);
      return path === "/api/fs/home"
        ? Response.json({ home: "/home/test", chatsRoot: "/Chats" })
        : new Response("private filesystem error", { status: 403 });
    });
    await expect(new OpenChamber(origin).createChat("chat")).rejects.toThrow("OpenChamber request failed (HTTP 403)");
    expect(calls).toEqual(["/api/fs/home", "/api/fs/mkdir"]);
  });

  test("creates iMessage chats under the dedicated root without consulting the shared Chats root", async () => {
    const calls: Array<{ path: string; body?: unknown; directory: string | null }> = [];
    const origin = serve(async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() : undefined;
      const header = request.headers.get("x-opencode-directory");
      calls.push({ path, body, directory: header === null ? null : decodeURIComponent(header) });
      if (path === "/api/fs/mkdir") return new Response(null, { status: 204 });
      if (path === "/api/session") return Response.json({ id: "ses_im" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await new OpenChamber(origin, {}, { chatRoot: "/home/test/.config/openchamber/imessage/" }).createChat();
    expect(result.id).toBe("ses_im");
    expect(result.directory).toMatch(/^\/home\/test\/\.config\/openchamber\/imessage\/\d{4}-\d{2}-\d{2}\/session-[0-9a-f-]{36}$/);
    expect(calls.map((call) => call.path)).toEqual(["/api/fs/mkdir", "/api/session"]);
    expect(calls[0]?.body).toEqual({ path: result.directory });
    expect(calls[1]?.directory).toBe(result.directory);
    expect(calls[1]?.body).toMatchObject({ location: { directory: result.directory }, metadata: { openchamber: { origin: "imessage" } } });
  });

  test.each(["relative/root", "/nul\0root", ""])("rejects an invalid dedicated chat root: %j", (chatRoot) => {
    expect(() => new OpenChamber("http://127.0.0.1:1", {}, { chatRoot })).toThrow("Invalid iMessage chat root");
  });

  test("marks an existing session through OpenChamber's serialized merge-patch route", async () => {
    const calls: Array<{ method: string; path: string; directory: string | null; body?: unknown }> = [];
    let metadata: unknown = { openchamber: { assist: { recap: "kept" }, goal: { status: "active" } }, other: { x: 1 } };
    // The server side of POST /api/openchamber/sessions/:id/metadata: RFC 7386 merge.
    const merge = (base: unknown, patch: Record<string, unknown>): Record<string, unknown> => {
      const result: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? { ...base as object } : {};
      for (const [key, value] of Object.entries(patch)) {
        result[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(result[key], value as Record<string, unknown>) : value;
      }
      return result;
    };
    const origin = serve(async request => {
      const url = new URL(request.url);
      const directory = request.headers.get("x-opencode-directory");
      if (request.method === "POST") {
        const body = await request.json() as { patch: Record<string, unknown>; directory: string };
        calls.push({ method: "POST", path: url.pathname, directory, body });
        metadata = merge(metadata, body.patch);
        return Response.json({ metadata });
      }
      calls.push({ method: request.method, path: url.pathname, directory });
      if (url.pathname.endsWith("/ses_gone")) {
        return Response.json({ _tag: "SessionNotFoundError", sessionID: "ses_gone", message: "Session not found" }, { status: 404 });
      }
      return Response.json({ data: { id: "ses_chat", location: { directory: "/Chats/a b" }, metadata } });
    });
    const client = new OpenChamber(origin);
    expect(await client.markImessageOrigin("ses_chat")).toBe("marked");
    expect(calls).toEqual([
      { method: "GET", path: "/api/session/ses_chat", directory: null },
      { method: "POST", path: "/api/openchamber/sessions/ses_chat/metadata", directory: null,
        body: { patch: { openchamber: { origin: "imessage" } }, directory: "/Chats/a b" } },
    ]);
    expect(metadata).toEqual({ openchamber: { assist: { recap: "kept" }, goal: { status: "active" }, origin: "imessage" }, other: { x: 1 } });
    calls.length = 0;
    expect(await client.markImessageOrigin("ses_chat", "/Chats/a b")).toBe("already");
    expect(calls.map(call => call.method)).toEqual(["GET"]);
    expect(await client.markImessageOrigin("ses_gone")).toBe("missing");
  });

  test("only OpenCode's own not-found for this session counts as missing", async () => {
    let posted = false;
    let answer = () => new Response("down", { status: 503 });
    const origin = serve(request => {
      if (request.method === "POST") { posted = true; return Response.json({ metadata: {} }); }
      return answer();
    });
    const client = new OpenChamber(origin);
    await expect(client.markImessageOrigin("ses_chat")).rejects.toMatchObject({ status: 503 });
    for (const response of [
      () => new Response("Cannot GET", { status: 404 }),
      () => Response.json({ error: "not found" }, { status: 404 }),
      () => Response.json({ _tag: "SessionNotFoundError", sessionID: "ses_other" }, { status: 404 }),
    ]) {
      answer = response;
      await expect(client.markImessageOrigin("ses_chat")).rejects.toMatchObject({ status: 404 });
    }
    answer = () => Response.json({ data: { id: "ses_other", location: { directory: "/Chats" } } });
    await expect(client.markImessageOrigin("ses_chat")).rejects.toThrow("Invalid OpenChamber session response");
    expect(posted).toBe(false);
  });

  test("a merge answer that does not name the origin is not success", async () => {
    const origin = serve(request => request.method === "POST"
      ? Response.json({ metadata: { openchamber: { assist: {} } } })
      : Response.json({ data: { id: "ses_chat", location: { directory: "/Chats" }, metadata: {} } }));
    await expect(new OpenChamber(origin).markImessageOrigin("ses_chat")).rejects.toThrow("Invalid OpenChamber metadata response");
  });

  test("rejects a missing session ID instead of returning unusable coordinates", async () => {
    const origin = serve((request) => {
      const path = new URL(request.url).pathname;
      return path === "/api/fs/home"
        ? Response.json({ home: "/home/test", chatsRoot: "/Chats" })
        : new Response(null, { status: 204 });
    });
    await expect(new OpenChamber(origin).createChat("chat")).rejects.toThrow("Invalid OpenChamber session response");
  });

  test("prompt switches the model, admits channel guidance without resuming, then sends text and file URIs", async () => {
    const calls: Array<{ path: string; directory: string | null; body: unknown }> = [];
    const file: FilePart = { type: "file", mime: "text/plain", filename: "note.txt", url: "data:text/plain;base64,aGk=" };
    const origin = serve(async (request) => {
      const url = new URL(request.url);
      expect(request.method).toBe("POST");
      calls.push({ path: url.pathname, directory: request.headers.get("x-opencode-directory"), body: await request.json() });
      if (url.pathname.endsWith("/model")) return new Response(null, { status: 204 });
      return Response.json({ data: { id: "msg_x", sessionID: "ses_chat", type: "user", time: { created: 1 } } });
    });
    const client = new OpenChamber(origin);
    expect(await client.prompt("ses_chat", "/Chats/test", "msg_1", "hello")).toBeUndefined();
    expect(await client.prompt("ses_chat", "/Chats/test", "msg_2", "read this", "Keep it brief.", [file])).toBeUndefined();
    expect(await client.prompt("ses_chat", "/Chats/test", "msg_3", "preferred", "", [], { providerID: "surplus", modelID: "glm-5.3", variant: "max" })).toBeUndefined();
    expect(await client.prompt("ses_chat", "/Chats/test", "msg_4", "no variant", "", [], { providerID: "surplus", modelID: "glm-5.3" })).toBeUndefined();
    const directory = encodeURIComponent("/Chats/test");
    const guidance = (id: string, text: string) => ({ path: "/api/session/ses_chat/synthetic", directory, body: {
      id: `${id}_context`, text, description: "Messaging channel guidance",
      metadata: { source: "spectrum-bridge", kind: "channel-guidance" }, resume: false,
    } });
    expect(calls).toEqual([
      guidance("msg_1", DEFAULT_CHANNEL_SYSTEM),
      { path: "/api/session/ses_chat/prompt", directory, body: { id: "msg_1", text: "hello" } },
      guidance("msg_2", "Keep it brief."),
      { path: "/api/session/ses_chat/prompt", directory, body: { id: "msg_2", text: "read this", files: [{ uri: file.url, name: "note.txt" }] } },
      { path: "/api/session/ses_chat/model", directory, body: { model: { providerID: "surplus", id: "glm-5.3", variant: "max" } } },
      { path: "/api/session/ses_chat/prompt", directory, body: { id: "msg_3", text: "preferred" } },
      { path: "/api/session/ses_chat/model", directory, body: { model: { providerID: "surplus", id: "glm-5.3" } } },
      { path: "/api/session/ses_chat/prompt", directory, body: { id: "msg_4", text: "no variant" } },
    ]);
  });

  test("a failed model switch or guidance admission never sends the prompt", async () => {
    for (const failing of ["/model", "/synthetic"]) {
      const paths: string[] = [];
      const origin = serve((request) => {
        const path = new URL(request.url).pathname;
        paths.push(path);
        return path.endsWith(failing) ? new Response("private", { status: 500 }) : new Response(null, { status: 204 });
      });
      await expect(new OpenChamber(origin).prompt("ses_chat", "/Chats/test", "msg_1", "hello", "Guidance", [], { providerID: "p", modelID: "m" }))
        .rejects.toThrow("OpenChamber request failed (HTTP 500)");
      expect(paths.some(path => path.endsWith("/prompt"))).toBe(false);
    }
  });

  test("routes health, sessions, messages, statuses, permissions and forms through OpenCode 2 paths", async () => {
    const seen: Array<{ method: string; path: string; body: unknown; query: string; directory: string | null }> = [];
    const directory = "/Chats/encoded & directory";
    const id = "id/with ?#";
    const encoded = encodeURIComponent(id);
    const record = message([{ type: "text", text: "answer" }]);
    const origin = serve(async (request) => {
      const url = new URL(request.url);
      seen.push({ method: request.method, path: url.pathname, body: request.body ? await request.json() : undefined,
        query: url.search, directory: request.headers.get("x-opencode-directory") });
      if (url.pathname === "/health") return Response.json({ status: "ok", timestamp: "now", openchamberVersion: "test" });
      if (url.pathname.endsWith("/message")) return Response.json({ data: [record], cursor: { next: "c1" } });
      if (url.pathname === `/api/session/${encoded}`) return Response.json({ data: { id, location: { directory }, title: "test", time: { created: 1, updated: 1 } } });
      if (url.pathname === "/api/session/active") return Response.json({ data: { [id]: { type: "running" } } });
      if (url.pathname.endsWith("/permission")) return Response.json({ data: [{ id: "per_1", sessionID: id, action: "bash", resources: ["ls"] }] });
      if (url.pathname.endsWith("/form")) return Response.json({ data: [questionForm] });
      if (url.pathname.endsWith("/interrupt")) return Response.json({ interrupted: true });
      return new Response(null, { status: 204 });
    });
    const client = new OpenChamber(origin);
    const scope = encodeURIComponent(directory);
    expect((await client.health())?.status).toBe("ok");
    expect(await client.getSession(id, directory)).toMatchObject({ id, directory });
    expect(await client.messages(id, directory)).toEqual([record]);
    expect(await client.messages(id, directory, { limit: 5 })).toEqual([record]);
    expect(await client.statuses()).toEqual({ [id]: { type: "busy" } });
    expect(await client.permissions(id, directory)).toEqual([{ id: "per_1", sessionID: id, action: "bash", resources: ["ls"] }]);
    const [form] = await client.questions(id, directory);
    expect(await client.abort(id, directory)).toBe(true);
    expect(await client.permissionReply(id, "per_1", directory, "once")).toBe(true);
    expect(await client.permissionReply(id, "per_1", directory, "reject")).toBe(true);
    expect(await client.questionReply({ ...form!, sessionID: id }, directory, [["B"], ["X", "Y"]])).toBe(true);
    expect(await client.cancelQuestion(id, "frm_1", directory)).toBe(true);
    expect(seen).toEqual([
      { method: "GET", path: "/health", body: undefined, query: "", directory: null },
      { method: "GET", path: `/api/session/${encoded}`, body: undefined, query: "", directory: scope },
      { method: "GET", path: `/api/session/${encoded}/message`, body: undefined, query: "?limit=100&order=desc", directory: scope },
      { method: "GET", path: `/api/session/${encoded}/message`, body: undefined, query: "?limit=5&order=desc", directory: scope },
      { method: "GET", path: "/api/session/active", body: undefined, query: "", directory: null },
      { method: "GET", path: `/api/session/${encoded}/permission`, body: undefined, query: "", directory: scope },
      { method: "GET", path: `/api/session/${encoded}/form`, body: undefined, query: "", directory: scope },
      { method: "POST", path: `/api/session/${encoded}/interrupt`, body: undefined, query: "", directory: scope },
      { method: "POST", path: `/api/session/${encoded}/permission/per_1/reply`, body: { decision: "once" }, query: "", directory: scope },
      { method: "POST", path: `/api/session/${encoded}/permission/per_1/reply`, body: { decision: "reject" }, query: "", directory: scope },
      { method: "POST", path: `/api/session/${encoded}/form/frm_1/reply`, body: { answer: { q0: "b", q1: ["x", "y"] } }, query: "", directory: scope },
      { method: "DELETE", path: `/api/session/${encoded}/form/frm_1`, body: undefined, query: "", directory: scope },
    ]);
  });

  test("messages walk cursor pages back to the turn prompt and return chronological order", async () => {
    const queries: string[] = [];
    const record = (n: number) => ({ id: `msg_${n}`, type: "user", text: String(n), time: { created: n } });
    const origin = serve((request) => {
      const url = new URL(request.url);
      queries.push(url.search);
      const cursor = url.searchParams.get("cursor");
      if (!cursor) return Response.json({ data: [record(4), record(3)], cursor: { next: "c1" } });
      if (cursor === "c1") return Response.json({ data: [record(2), record(1)], cursor: { next: "c2" } });
      return Response.json({ data: [], cursor: {} });
    });
    const client = new OpenChamber(origin);
    expect((await client.messages("s", "/d", { until: "msg_2", limit: 2 })).map(row => row.id)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"]);
    expect(queries).toEqual(["?limit=2&order=desc", "?limit=2&cursor=c1"]);
    queries.length = 0;
    // A record older than the turn start ends the walk even without the prompt.
    expect((await client.messages("s", "/d", { until: "msg_missing", since: 4, limit: 2 })).map(row => row.id)).toEqual(["msg_3", "msg_4"]);
    expect(queries).toEqual(["?limit=2&order=desc"]);
  });

  test("prompt acceptance reads the promoted record, then the inbox; other failures stay uncertain", async () => {
    let mode = "promoted";
    const origin = serve((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/message/msg_1")) {
        if (mode === "promoted") return Response.json({ data: { id: "msg_1", type: "user", text: "q", time: { created: 1 } } });
        if (mode === "error") return new Response("private", { status: 500 });
        return Response.json({ _tag: "MessageNotFoundError" }, { status: 404 });
      }
      expect(path).toBe("/api/session/ses_1/inbox");
      return Response.json({ data: mode === "queued" ? [{ id: "msg_1", sessionID: "ses_1", type: "user", delivery: "steer" }] : [] });
    });
    const client = new OpenChamber(origin);
    expect(await client.promptAccepted("ses_1", "/d", "msg_1")).toBe(true);
    mode = "queued";
    expect(await client.promptAccepted("ses_1", "/d", "msg_1")).toBe(true);
    mode = "absent";
    expect(await client.promptAccepted("ses_1", "/d", "msg_1")).toBe(false);
    mode = "error";
    await expect(client.promptAccepted("ses_1", "/d", "msg_1")).rejects.toThrow("OpenChamber request failed (HTTP 500)");
  });

  test.each(["https://localhost", "http://example.com", "http://localhost.example.com", "http://127.0.0.2", "http://127.1", "http://2130706433", "http://[::1]", "file:///tmp/test", "http://user:secret@localhost", "http://localhost#secret", "http://localhost?secret", "http://localhost/api", "http://localhost:99999", "not a URL"])(
    "rejects unsafe base URL %s", (url) => {
      expect(() => new OpenChamber(url)).toThrow("OpenChamber URL must be an HTTP origin on 127.0.0.1 or localhost");
    },
  );

  test("allows localhost and trailing slash origins", async () => {
    const origin = serve(() => Response.json(true));
    expect(await new OpenChamber(`${origin.replace("127.0.0.1", "localhost")}/`).request<boolean>("/test")).toBe(true);
  });

  test("rejects request paths that could escape the origin before sending headers", async () => {
    let hits = 0;
    const origin = serve(() => { hits++; return Response.json(true); });
    const client = new OpenChamber(origin, { Authorization: "Bearer test-secret" });
    for (const path of ["http://example.com", origin + "/test", "//example.com", "/\\example.com", " /test", "/test\r\n", "/test#secret"]) {
      await expect(client.request(path)).rejects.toThrow("OpenChamber request failed (HTTP 0)");
    }
    expect(hits).toBe(0);
  });

  test.each([301, 302, 303, 307, 308])("never follows HTTP %i redirects, even to loopback", async (status) => {
    let hits = 0;
    const destination = serve(() => { hits++; return Response.json(true); });
    const origin = serve(() => new Response("private body", { status, headers: { Location: `${destination}/private?token=secret` } }));
    await expect(new OpenChamber(origin, { Authorization: "Bearer secret" }).request("/test")).rejects.toThrow(`OpenChamber request failed (HTTP ${status})`);
    expect(hits).toBe(0);
  });

  test("HTTP and JSON parse failures contain only status, not sensitive response details", async () => {
    const origin = serve((request) => new Response("secret response content", {
      status: new URL(request.url).pathname === "/error" ? 401 : 200,
      statusText: "secret status text",
    }));
    const client = new OpenChamber(origin);
    for (const [path, status] of [["/error", 401], ["/invalid", 200]] as const) {
      let error: unknown;
      try { await client.request(path); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`OpenChamber request failed (HTTP ${status})`);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  test("sanitizes abort reasons and sends no pre-aborted request", async () => {
    let hits = 0;
    const origin = serve(() => { hits++; return Response.json(true); });
    const signal = AbortSignal.abort(new Error("private abort reason"));
    let error: unknown;
    try { await new OpenChamber(origin).request("/test", { signal }); } catch (caught) { error = caught; }
    expect((error as Error).name).toBe("AbortError");
    expect((error as Error).message).toBe("OpenChamber request failed (HTTP 0)");
    expect(hits).toBe(0);
  });

  test("can abort while waiting for a JSON response body", async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const origin = serve(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"pending":'));
        began();
      },
    }), { headers: { "Content-Type": "application/json" } }));
    const controller = new AbortController();
    const pending = new OpenChamber(origin).request("/test", { signal: controller.signal });
    await started;
    controller.abort("private reason");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("rejects invalid limits and persistent permission approval without a request", async () => {
    let hits = 0;
    const origin = serve(() => { hits++; return Response.json(true); });
    const client = new OpenChamber(origin);
    for (const limit of [0, -1, 1.5, NaN, Infinity]) {
      await expect(client.messages("ses_chat", "/Chats/test", { limit })).rejects.toThrow("Invalid message limit");
    }
    // @ts-expect-error The public API deliberately excludes persistent approvals.
    await expect(client.permissionReply("ses_chat", "per_1", "/Chats/test", "always")).rejects.toThrow("Invalid permission reply");
    expect(hits).toBe(0);
  });
});

describe("assistantText", () => {
  test("extracts only visible assistant text in order, not tools or reasoning", () => {
    const record = message([
      { type: "text", text: " First " },
      { type: "reasoning", text: "private reasoning" },
      { type: "tool", id: "call_1", name: "bash", state: { status: "completed", input: {}, content: [{ type: "text", text: "secret" }] } },
      { type: "text", text: "Last" },
    ]);
    expect(assistantText(record)).toBe("First \n\nLast");
    expect(assistantText(message())).toBe("");
  });

  test("never extracts user, synthetic, or compaction records", () => {
    expect(assistantText({ id: "msg_u", type: "user", text: "private prompt", time: { created: 1 } })).toBe("");
    expect(assistantText({ id: "msg_s", type: "synthetic", text: "private context", time: { created: 1 } })).toBe("");
    expect(assistantText({ id: "msg_c", type: "compaction", summary: "private summary", time: { created: 1 } })).toBe("");
  });
});

describe("forms", () => {
  test("question-tool forms map fields to questions with option labels, values, and custom rules", () => {
    const request = questionFromForm(questionForm);
    expect(request).toEqual({
      id: "frm_1", sessionID: "ses_chat", title: "Questions", tool: { messageID: "msg_tool", id: "call_1" },
      questions: [
        { key: "q0", question: "Which?", header: "Choice", multiple: false, custom: true,
          options: [{ label: "A", value: "a", description: "First" }, { label: "B", value: "b" }] },
        { key: "q1", question: "Which ones?", header: "Many", multiple: true, custom: false,
          options: [{ label: "X", value: "x" }, { label: "Y", value: "y" }] },
      ],
    });
    // Labels map back to values; unknown text passes through only as custom text.
    expect(formAnswer(request, [["Own words"], ["Y"]])).toEqual({ q0: "Own words", q1: ["y"] });
    expect(() => formAnswer(request, [["A"]])).toThrow("Invalid form answer");
  });

  test("string fields with closed options are listed-only; open string fields accept text", () => {
    const closed = questionFromForm({ ...questionForm, fields: [{ key: "choice", type: "string", required: true, custom: false,
      description: "Allow?", options: [{ value: "allow", label: "Allow" }] }] });
    expect(closed.questions[0]).toMatchObject({ custom: false, multiple: false, question: "Allow?" });
    const open = questionFromForm({ ...questionForm, fields: [{ key: "name", type: "string", title: "Name" }] });
    expect(open.questions[0]).toMatchObject({ custom: true, options: [], question: "Name" });
  });

  test("forms a text reply cannot answer stay visible but unsupported", () => {
    for (const fields of [
      [{ key: "n", type: "number" }],
      [{ key: "b", type: "boolean" }],
      [{ key: "e", type: "external", url: "https://example.invalid" }],
      [{ key: "s", type: "string" }, { key: "t", type: "string", when: [{ key: "s", op: "eq", value: "x" }] }],
      [{ key: "h", type: "string", hidden: true, required: true }],
    ] as FormInfo["fields"][]) {
      const request = questionFromForm({ ...questionForm, fields });
      expect(request).toMatchObject({ unsupported: true, questions: [] });
      expect(() => formAnswer(request, [])).toThrow("Invalid form answer");
    }
    // A hidden optional field keeps its default and is left out of the answer.
    const hidden = questionFromForm({ ...questionForm, fields: [{ key: "h", type: "string", hidden: true, default: "d" }, { key: "s", type: "string" }] });
    expect(hidden.unsupported).toBeUndefined();
    expect(formAnswer(hidden, [["text"]])).toEqual({ s: "text" });
  });
});

describe("SSE events", () => {
  test.each(["/api/event", "/api/openchamber/events"] as const)(
    "parses fragmented UTF-8, all SSE line endings and initial events at %s", async (path) => {
      const initial = { type: "openchamber:event-stream-ready", properties: { connectedAt: 1 } };
      const event = { directory: "/Chats/test", payload: { type: "message.part.updated", properties: { text: "caf\u00e9 \ud83d\ude80" } } };
      const wire = `\ufeff: heartbeat\r\nid: 1\r\nevent: ready\r\ndata: ${JSON.stringify(initial)}\r\n\r\n`
        + `data: {"directory":"/Chats/test",\ndata: "payload":${JSON.stringify(event.payload)}}\n\n`
        + ': ignored\r\rdata:{"type":"third"}\r\r'
        + 'data\n\ndata: {"type":"incomplete"}';
      const bytes = new TextEncoder().encode(wire);
      let offset = 0;
      let connections = 0;
      const origin = serve((request) => {
        connections++;
        expect(new URL(request.url).pathname).toBe(path);
        expect(request.headers.get("accept")).toBe("text/event-stream");
        expect(request.headers.get("authorization")).toBe("Bearer sse-test");
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (offset === bytes.length) { controller.close(); return; }
            controller.enqueue(bytes.slice(offset, ++offset));
            await Bun.sleep(1);
          },
        }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
      });
      const events: unknown[] = [];
      for await (const event of new OpenChamber(origin, { authorization: "Bearer sse-test" }).events(path, new AbortController().signal)) {
        events.push(event);
      }
      expect(events).toEqual([initial, event, { type: "third" }]);
      expect(connections).toBe(1);
    },
  );

  test.each(["\n", "\r", "\r\n"])("dispatches complete %j frames without waiting for stream closure", async (newline) => {
    const origin = serve(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: {"type":"ready"}${newline}${newline}data: {"type":"next"}${newline}${newline}`));
      },
    }), { headers: { "Content-Type": "text/event-stream" } }));
    const events = new OpenChamber(origin).events("/api/event", new AbortController().signal);
    try {
      expect((await events.next()).value).toEqual({ type: "ready" });
      expect((await events.next()).value).toEqual({ type: "next" });
    } finally {
      await events.return();
    }
  });

  test("does not yield buffered events after cancellation", async () => {
    const origin = serve(() => new Response('data: {"type":"ready"}\n\ndata: {"type":"next"}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const controller = new AbortController();
    const events = new OpenChamber(origin).events("/api/event", controller.signal);
    expect((await events.next()).value).toEqual({ type: "ready" });
    controller.abort("private reason");
    await expect(events.next()).rejects.toMatchObject({ name: "AbortError", message: "OpenChamber request failed (HTTP 200)" });
  });

  test("204 ends the stream without reconnecting", async () => {
    let connections = 0;
    const origin = serve(() => { connections++; return new Response(null, { status: 204 }); });
    const events = new OpenChamber(origin).events("/api/event", new AbortController().signal);
    expect(await events.next()).toEqual({ value: undefined, done: true });
    expect(connections).toBe(1);
  });

  test("aborts a pending stream read without exposing the reason", async () => {
    const origin = serve(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"ready"}\n\n')); },
    }), { headers: { "Content-Type": "text/event-stream" } }));
    const controller = new AbortController();
    const events = new OpenChamber(origin).events("/api/event", controller.signal);
    expect((await events.next()).value).toEqual({ type: "ready" });
    const next = events.next();
    controller.abort("private abort reason");
    await expect(next).rejects.toMatchObject({ name: "AbortError", message: "OpenChamber request failed (HTTP 200)" });
  });

  test.each(["wrong MIME", "invalid JSON", "redirect", "HTTP failure"])("sanitizes SSE %s", async (kind) => {
    let destinationHits = 0;
    const destination = serve(() => { destinationHits++; return new Response("secret"); });
    const status = kind === "redirect" ? 302 : kind === "HTTP failure" ? 503 : 200;
    const origin = serve(() => new Response("data: secret invalid JSON\n\n", {
      status,
      headers: { "Content-Type": kind === "wrong MIME" ? "text/html" : "text/event-stream", Location: destination },
    }));
    const events = new OpenChamber(origin).events("/api/event", new AbortController().signal);
    await expect(events.next()).rejects.toThrow(`OpenChamber request failed (HTTP ${status})`);
    expect(destinationHits).toBe(0);
  });
});
