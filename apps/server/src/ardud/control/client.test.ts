// @effect-diagnostics nodeBuiltinImport:off - the client under test is plain Node by design.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

// @ts-expect-error plain ESM module without declarations
import { ControlApiError, ControlClient, discoverConfig } from "./client.mjs";

let server: NodeHttp.Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

const listen = (handler: Parameters<typeof NodeHttp.createServer>[1]) =>
  new Promise<string>((resolve) => {
    server = NodeHttp.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const cli = NodeURL.fileURLToPath(new URL("./t3ctl.mjs", import.meta.url));

const runCommand = (file: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | string | null; stdout: string; stderr: string }>((resolve) => {
    NodeChildProcess.execFile(file, args, { env }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });

const controlEnv = (url: string) => ({
  ...process.env,
  T3_CONTROL_URL: url,
  T3_CONTROL_TOKEN: "test",
});

const runCli = (url: string, args: string[]) =>
  runCommand(process.execPath, [cli, ...args], controlEnv(url));

const runUsageCli = (url: string, args: string[]) =>
  execFile(process.execPath, [
    NodeURL.fileURLToPath(new URL("./t3ctl.mjs", import.meta.url)),
    "usage",
    ...args,
    "--url",
    url,
    "--token",
    "test",
  ]);

describe("discoverConfig", () => {
  const saved = {
    url: process.env.T3_CONTROL_URL,
    token: process.env.T3_CONTROL_TOKEN,
    file: process.env.T3_CONTROL_TOKEN_FILE,
  };
  beforeEach(() => {
    delete process.env.T3_CONTROL_URL;
    delete process.env.T3_CONTROL_TOKEN;
    delete process.env.T3_CONTROL_TOKEN_FILE;
  });
  afterEach(() => {
    for (const [key, value] of [
      ["T3_CONTROL_URL", saved.url],
      ["T3_CONTROL_TOKEN", saved.token],
      ["T3_CONTROL_TOKEN_FILE", saved.file],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reads a chmod 600 token file and rejects a readable one", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctl-"));
    const file = NodePath.join(dir, "ardud-control.json");
    NodeFS.writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:1/", token: "abc" }));
    NodeFS.chmodSync(file, 0o600);
    expect(discoverConfig({ tokenFile: file })).toEqual({
      url: "http://127.0.0.1:1",
      token: "abc",
    });
    NodeFS.chmodSync(file, 0o644);
    expect(() => discoverConfig({ tokenFile: file })).toThrow(/chmod 600/);
  });

  it("refuses a named token file that does not exist", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctl-"));
    expect(() =>
      discoverConfig({ tokenFile: NodePath.join(dir, "missing.json"), component: "x", home: dir }),
    ).toThrow(/ENOENT/);
  });

  it("reads the component's own credential before the shared file", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctl-"));
    const write = (file: string, token: string) => {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:2", token }), {
        mode: 0o600,
      });
    };
    write(NodePath.join(home, ".robob", "ardud-control.json"), "shared");
    expect(discoverConfig({ component: "x", home }).token).toBe("shared");
    write(NodePath.join(home, ".robob", "components", "x.json"), "own");
    expect(discoverConfig({ component: "x", home }).token).toBe("own");
  });
});

describe("ControlClient", () => {
  it("t3ctl sends an explicit request id or a fresh UUID", async () => {
    const bodies: Array<{ text: string; clientRequestId: string }> = [];
    const url = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(body));
        response.end(JSON.stringify({ ok: true }));
      });
    });
    const first = await runCli(url, ["send", "t", "--request-id", "chosen-id", "hello", "world"]);
    const second = await runCli(url, ["send", "t", "hello"]);
    const third = await runCli(url, ["send", "t", "hello"]);
    expect([first.code, second.code, third.code]).toEqual([0, 0, 0]);
    expect(bodies[0]).toMatchObject({ text: "hello world", clientRequestId: "chosen-id" });
    expect(bodies[1]?.clientRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(bodies[2]?.clientRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(bodies[1]?.clientRequestId).not.toBe(bodies[2]?.clientRequestId);
  });

  it.each([
    { label: "generated UUID", requestId: undefined, thread: "thread/' $HOME" },
    { label: "provided id", requestId: "-request'id $HOME", thread: "-thread ' $HOME" },
  ])("prints a shell-safe retry with the same $label after a send timeout", async (test) => {
    const seen: Array<{ path: string | undefined; body: Record<string, unknown> }> = [];
    const deliveries = new Set<unknown>();
    const url = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        seen.push({ path: request.url, body: parsed });
        const duplicate = deliveries.has(parsed.clientRequestId);
        deliveries.add(parsed.clientRequestId);
        if (!duplicate) return; // The server accepted it, but the response was lost.
        response.end(JSON.stringify({ ok: true, runId: "run-1" }));
      });
    });
    // The explicit URL path exercises quoting independently of thread and text.
    const explicitUrl = `${url}/path'quote`;
    const text = '--don\'t expand $(printf hacked); $HOME\n"quoted" \\ `false`';
    const result = await runCli(url, [
      "send",
      "--url",
      explicitUrl,
      "--request-timeout",
      "1",
      ...(test.requestId === undefined ? [] : [`--request-id=${test.requestId}`]),
      "--mode",
      "queue",
      "--model",
      "model with 'quotes'",
      "--option",
      "effort=max",
      "--",
      test.thread,
      text,
    ]);
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(seen).toHaveLength(1);
    const id = seen[0]?.body.clientRequestId;
    if (test.requestId === undefined) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } else {
      expect(id).toBe(test.requestId);
    }
    const prefix = "send timed out; it may or may not have been delivered. Retry safely with: ";
    expect(result.stderr.startsWith(prefix)).toBe(true);
    const retry = result.stderr.slice(prefix.length).replace(/\n$/, "");
    const retried = await runCommand(
      "/bin/sh",
      ["-c", `t3ctl() { "$T3CTL_NODE" "$T3CTL_SCRIPT" "$@"; }\n${retry}`],
      { ...controlEnv(url), T3CTL_NODE: process.execPath, T3CTL_SCRIPT: cli },
    );
    expect(retried.code).toBe(0);
    expect(retried.stderr).toBe("");
    expect(JSON.parse(retried.stdout)).toEqual({ ok: true, runId: "run-1" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).toEqual({
      path: `/path'quote/api/ardud/control/threads/${encodeURIComponent(test.thread)}/send`,
      body: {
        text,
        mode: "queue",
        model: "model with 'quotes'",
        options: [{ id: "effort", value: "max" }],
        clientRequestId: id,
      },
    });
    expect(deliveries.size).toBe(1);
  });

  it("uses the explicit request timeout for ordinary requests and long polls", async () => {
    const paths: Array<string | undefined> = [];
    const url = await listen((request, response) => {
      paths.push(request.url);
      if (request.url === "/api/ardud/control/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
      }
    });
    for (const args of [
      ["--request-timeout", "0.1", "health"],
      ["wait", "thread", "--request-timeout", "0.1"],
      ["events", "--request-timeout", "0.1"],
    ]) {
      const result = await runCli(url, args);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/timeout/i);
      expect(result.stderr).not.toMatch(/Retry safely/);
    }
    expect(paths[0]).toBe("/api/ardud/control/health");
    expect(paths[1]).toMatch(/^\/api\/ardud\/control\/threads\/thread\/wait\?/);
    expect(paths[2]).toBe("/api/ardud/control/events");
  });

  it("does not call a timed-out wait an uncertain send", async () => {
    const paths: Array<string | undefined> = [];
    const url = await listen((request, response) => {
      paths.push(request.url);
      if (request.url?.endsWith("/send")) {
        request.resume();
        request.on("end", () => response.end(JSON.stringify({ ok: true, runId: "run-1" })));
      }
    });
    const result = await runCli(url, ["send", "t", "hello", "--wait", "--request-timeout", "0.1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/timeout/i);
    expect(result.stderr).not.toMatch(/Retry safely/);
    expect(paths).toHaveLength(2);
    expect(paths[1]).toMatch(/\/wait\?/);
  });

  it("reports a send that times out while reading the response body", async () => {
    const url = await listen((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"ok":');
      });
    });
    const result = await runCli(url, ["send", "t", "hello", "--request-timeout", "0.1"]);
    expect(result.code).toBe(4);
    expect(result.stderr).toMatch(/^send timed out; it may or may not have been delivered/);
  });

  it("keeps the request id when the server drops a send response", async () => {
    let accepted: Record<string, unknown> | undefined;
    const url = await listen((request) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        accepted = JSON.parse(body) as Record<string, unknown>;
        request.socket.destroy();
      });
    });
    const result = await runCli(url, ["send", "t", "hello"]);
    expect(result.code).toBe(4);
    expect(accepted?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.stderr).toContain(
      "send connection dropped; it may or may not have been delivered. Retry safely with:",
    );
    expect(result.stderr).toContain(`--request-id '${accepted?.clientRequestId}'`);
  });

  it("omits explicit credentials from the retry while retaining the explicit URL", async () => {
    const seen: Array<{ path: string | undefined; body: unknown }> = [];
    const url = await listen((request) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => seen.push({ path: request.url, body: JSON.parse(body) }));
    });
    const result = await runCli(url, [
      "send",
      "t",
      "hello",
      "--url",
      url,
      "--token",
      "private-test-token",
      "--request-id",
      "id",
      "--request-timeout",
      "0.1",
    ]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain(`--url '${url}'`);
    expect(result.stderr).not.toContain("private-test-token");
    expect(result.stderr).not.toContain("--token");
    expect(seen).toEqual([
      {
        path: "/api/ardud/control/threads/t/send",
        body: { text: "hello", clientRequestId: "id" },
      },
    ]);
  });

  it("does not claim a rejected send timed out or print its token", async () => {
    const url = await listen((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ ok: false, error: { code: "invalid_request", message: "bad" } }),
        );
      });
    });
    const result = await runCli(url, ["send", "t", "hello", "--token", "sensitive-token"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid_request: bad");
    expect(result.stderr).not.toContain("Retry safely");
    expect(result.stderr).not.toContain("sensitive-token");
  });

  it("reports an interrupted send with the same safe-retry exit", async () => {
    let received!: () => void;
    const receivedRequest = new Promise<void>((resolve) => {
      received = resolve;
    });
    const url = await listen((request) => {
      request.resume();
      request.on("end", received);
    });
    const child = NodeChildProcess.spawn(process.execPath, [cli, "send", "t", "message"], {
      env: controlEnv(url),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    await receivedRequest;
    child.kill("SIGTERM");
    expect(await exited).toBe(4);
    expect(stderr).toMatch(
      /^send timed out; it may or may not have been delivered\. Retry safely with: t3ctl send /,
    );
    expect(stderr).toMatch(/--request-id '[0-9a-f-]{36}'/);
  });

  it("rejects invalid request timeouts before making a request", async () => {
    const url = await listen((_request, response) => {
      response.end(JSON.stringify({ ok: true }));
    });
    for (const value of ["", "  ", "0", "-1", "NaN", "Infinity", "2147484"]) {
      const result = await runCli(url, ["--request-timeout=" + value, "health"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/--request-timeout must be a positive number of seconds/);
    }
  });

  it("forwards usage filters, encoding cursors and board IDs and omitting absent values", async () => {
    const seen: Array<{
      method: string | undefined;
      url: string;
      authorization: string | undefined;
    }> = [];
    const url = await listen((request, response) => {
      seen.push({
        method: request.method,
        url: request.url!,
        authorization: request.headers.authorization,
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ items: [{ id: "one" }], nextCursor: "next/+=" }));
    });
    const client = new ControlClient({ url, token: "test" });
    const filters = {
      since: 0,
      until: "2026-11-03T10:00:00+04:00",
      cursor: "cursor/+?=&%",
      limit: 3,
      boardId: "board:/ &?#",
    };
    expect(await client.usage(filters)).toEqual({ items: [{ id: "one" }], nextCursor: "next/+=" });
    await client.usage({ since: "2026-11-01T00:00:00Z" });

    expect(seen.map(({ method, authorization }) => ({ method, authorization }))).toEqual([
      { method: "GET", authorization: "Bearer test" },
      { method: "GET", authorization: "Bearer test" },
    ]);
    const first = new URL(seen[0]!.url, url);
    expect(first.pathname).toBe("/api/ardud/control/usage");
    expect(Object.fromEntries(first.searchParams)).toEqual({
      ...filters,
      since: "0",
      limit: "3",
    });
    const second = new URL(seen[1]!.url, url);
    expect(second.pathname).toBe("/api/ardud/control/usage");
    expect(Object.fromEntries(second.searchParams)).toEqual({ since: "2026-11-01T00:00:00Z" });
  });

  it("t3ctl usage prints one page and forwards its filters", async () => {
    const seen: string[] = [];
    const page = { ok: true, items: [{ id: "first" }], nextCursor: "cursor-2" };
    const url = await listen((request, response) => {
      seen.push(request.url!);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(page));
    });
    const result = await runUsageCli(url, [
      "--since",
      "2026-11-01T00:00:00Z",
      "--until",
      "2026-11-03T10:00:00+04:00",
      "--board",
      "board:one/a",
      "--limit",
      "2",
    ]);
    expect(JSON.parse(result.stdout)).toEqual(page);
    expect(seen).toHaveLength(1);
    const request = new URL(seen[0]!, url);
    expect(request.pathname).toBe("/api/ardud/control/usage");
    expect(Object.fromEntries(request.searchParams)).toEqual({
      since: "2026-11-01T00:00:00Z",
      until: "2026-11-03T10:00:00+04:00",
      boardId: "board:one/a",
      limit: "2",
    });
  });

  it("t3ctl usage follows every cursor without dropping filters and combines the pages", async () => {
    const seen: Array<Record<string, string>> = [];
    const cursor1 = "first/+?=&%";
    const cursor2 = "second cursor";
    const url = await listen((request, response) => {
      const query = new URL(request.url!, "http://localhost").searchParams;
      seen.push(Object.fromEntries(query));
      const cursor = query.get("cursor");
      const page =
        cursor === null
          ? { ok: true, items: [{ id: 1 }], nextCursor: cursor1 }
          : cursor === cursor1
            ? { ok: true, items: [{ id: 2 }], nextCursor: cursor2 }
            : { ok: true, items: [{ id: 3 }], nextCursor: null };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(page));
    });
    const result = await runUsageCli(url, [
      "--since",
      "0",
      "--until",
      "1234567890000",
      "--board",
      "board:/ &?#",
      "--limit",
      "1",
      "--all-pages",
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      items: [{ id: 1 }, { id: 2 }, { id: 3 }],
      nextCursor: null,
    });
    const filters = { since: "0", until: "1234567890000", boardId: "board:/ &?#", limit: "1" };
    expect(seen).toEqual([
      filters,
      { ...filters, cursor: cursor1 },
      { ...filters, cursor: cursor2 },
    ]);
  });

  it("t3ctl usage fails on repeated cursors instead of looping or printing partial results", async () => {
    let calls = 0;
    const url = await listen((_request, response) => {
      calls++;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ items: [{ id: calls }], nextCursor: "repeat" }));
    });
    await expect(runUsageCli(url, ["--since", "0", "--all-pages"])).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("repeated cursor"),
    });
    expect(calls).toBe(2);
  });

  it("t3ctl usage follows a cursor when until is omitted", async () => {
    const seen: Array<Record<string, string>> = [];
    const url = await listen((request, response) => {
      const query = new URL(request.url!, "http://localhost").searchParams;
      seen.push(Object.fromEntries(query));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          query.has("cursor")
            ? { items: [{ id: 2 }], nextCursor: null }
            : { items: [{ id: 1 }], nextCursor: "next" },
        ),
      );
    });
    const result = await runUsageCli(url, ["--since", "1000", "--all-pages"]);
    expect(JSON.parse(result.stdout)).toEqual({ items: [{ id: 1 }, { id: 2 }], nextCursor: null });
    expect(seen).toEqual([{ since: "1000" }, { since: "1000", cursor: "next" }]);
  });

  it("t3ctl usage reports later page errors without printing partial results", async () => {
    let calls = 0;
    const url = await listen((_request, response) => {
      calls++;
      response.setHeader("content-type", "application/json");
      if (calls === 1) {
        response.end(JSON.stringify({ items: [{ id: 1 }], nextCursor: "next" }));
      } else {
        response.statusCode = 500;
        response.end(JSON.stringify({ ok: false, error: { code: "internal", message: "failed" } }));
      }
    });
    await expect(runUsageCli(url, ["--since", "0", "--all-pages"])).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("internal: failed"),
    });
    expect(calls).toBe(2);
  });

  it("t3ctl usage rejects malformed pages instead of returning partial results", async () => {
    const url = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ items: [] }));
    });
    await expect(runUsageCli(url, ["--since", "0", "--all-pages"])).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("invalid usage page"),
    });
  });

  it("t3ctl usage requires --since", async () => {
    const url = await listen((_request, response) => response.end());
    await expect(runUsageCli(url, [])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("missing --since"),
    });
  });

  it("forwards guarded interrupt options from the client and CLI", async () => {
    const seen: Array<{ url: string | undefined; body: unknown }> = [];
    const url = await listen((request, response) => {
      let text = "";
      request.on("data", (chunk) => (text += chunk));
      request.on("end", () => {
        seen.push({ url: request.url, body: JSON.parse(text) });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, interrupted: true }));
      });
    });
    const options = { expectedRunId: "run-new", expectedAttemptId: "att-2", reason: "stalled" };
    const client = new ControlClient({ url, token: "t0k" });
    await client.interrupt("thread/one", { ...options, clientRequestId: "request-1" });
    const result = await execFile(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./t3ctl.mjs", import.meta.url)),
        "interrupt",
        "thread/one",
        "--expect-run",
        "run-new",
        "--expect-attempt",
        "att-2",
        "--reason",
        "stalled",
      ],
      { env: { ...process.env, T3_CONTROL_URL: url, T3_CONTROL_TOKEN: "t0k" } },
    );
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, interrupted: true });
    expect(seen).toEqual([
      {
        url: "/api/ardud/control/threads/thread%2Fone/interrupt",
        body: { ...options, clientRequestId: "request-1" },
      },
      { url: "/api/ardud/control/threads/thread%2Fone/interrupt", body: options },
    ]);
  });

  it("t3ctl forwards instances and repeatable typed options on create, send and set", async () => {
    const requests: Array<{ path: string | undefined; body: unknown }> = [];
    const url = await listen((request, response) => {
      let text = "";
      request.on("data", (chunk) => (text += chunk));
      request.on("end", () => {
        requests.push({ path: request.url, body: JSON.parse(text) });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, threadId: "t", runId: "r" }));
      });
    });
    const cli = NodeURL.fileURLToPath(new URL("./t3ctl.mjs", import.meta.url));
    const invoke = (args: string[]) =>
      new Promise<void>((resolve, reject) => {
        NodeChildProcess.execFile(
          process.execPath,
          [cli, ...args, "--url", url, "--token", "test"],
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      });
    const selection = [
      "--instance",
      "claudeAgent",
      "--model",
      "claude-opus-5-5",
      "--option",
      "effort=max",
      "--option",
      "fastMode=true",
    ];
    await invoke(["create", "--prompt", "hello", ...selection]);
    await invoke(["send", "t", "hello", ...selection]);
    await invoke(["set", "t", ...selection]);
    expect(requests.map(({ path }) => path)).toEqual([
      "/api/ardud/control/threads",
      "/api/ardud/control/threads/t/send",
      "/api/ardud/control/threads/t",
    ]);
    for (const { body } of requests)
      expect(body).toMatchObject({
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ],
      });
  });

  it("sends the bearer token and surfaces API errors", async () => {
    const url = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== "Bearer t0k") {
        response.statusCode = 401;
        response.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "no" } }));
        return;
      }
      response.end(JSON.stringify({ ok: true, threads: [], total: 0, path: request.url }));
    });
    const client = new ControlClient({ url, token: "t0k" });
    const result = await client.listThreads({ origin: "imessage", active: true });
    expect(result.path).toBe("/api/ardud/control/threads?origin=imessage&active=true");
    const bad = new ControlClient({ url, token: "wrong" });
    await expect(bad.projects()).rejects.toBeInstanceOf(ControlApiError);
  });

  it("returns an archive-if-idle refusal instead of throwing it", async () => {
    const bodies: Array<unknown> = [];
    const url = await listen((request, response) => {
      let text = "";
      request.on("data", (chunk) => (text += chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(text));
        response.setHeader("content-type", "application/json");
        if (request.url!.includes("thread-busy")) {
          response.statusCode = 409;
          response.end(
            JSON.stringify({
              ok: false,
              archived: false,
              error: { code: "not_idle", reason: "queued", message: "busy" },
            }),
          );
          return;
        }
        if (request.url!.includes("thread-gone")) {
          response.statusCode = 404;
          response.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "no" } }));
          return;
        }
        response.end(JSON.stringify({ ok: true, archived: true, thread: {} }));
      });
    });
    const client = new ControlClient({ url, token: "t0k" });
    expect(await client.archiveIfIdle("thread-idle", { expectedSession: "ses_1" })).toMatchObject({
      archived: true,
    });
    expect(await client.archiveIfIdle("thread-busy")).toMatchObject({
      archived: false,
      error: { code: "not_idle", reason: "queued" },
    });
    await expect(client.archiveIfIdle("thread-gone")).rejects.toBeInstanceOf(ControlApiError);
    expect(bodies).toEqual([{ expectedSession: "ses_1" }, {}, {}]);
  });

  it("parses SSE frames and resumes with Last-Event-ID", async () => {
    const seen: Array<string | undefined> = [];
    const url = await listen((request, response) => {
      seen.push(request.headers["last-event-id"] as string | undefined);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (seen.length === 1) {
        response.write('retry: 3000\nid: 5\nevent: ready\ndata: {"type":"ready"}\n\n');
        response.write(": ping\n\n");
        response.write(
          'id: 6\nevent: thread.status\ndata: {"type":"thread.status","threadId":"t"}\n\n',
        );
        response.end();
        return;
      }
      response.write(
        'id: 9\nevent: message.completed\ndata: {"type":"message.completed","text":"hi"}\n\n',
      );
    });
    const client = new ControlClient({ url, token: "t" });
    const controller = new AbortController();
    const events: Array<{ type: string; sequence: number }> = [];
    for await (const event of client.events({ signal: controller.signal })) {
      events.push(event);
      if (events.length === 2) controller.abort();
    }
    expect(events).toEqual([
      { type: "thread.status", threadId: "t", sequence: 6 },
      { type: "message.completed", text: "hi", sequence: 9 },
    ]);
    expect(seen).toEqual([undefined, "6"]);
  });
});
