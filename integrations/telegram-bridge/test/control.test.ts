import { afterEach, expect, test } from "bun:test";
import { toolError } from "../src/toollog.ts";
import { useToolLogFixture } from "./toollog-fixture.ts";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, discoverControlConfig } from "../src/control.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tokenFile = (name: string, token: string, mode = 0o600) => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-control-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:14033", token }));
  chmodSync(file, mode);
  return file;
};

test("control config reads the bridge's own credential and ignores the retired shared file", () => {
  const home = mkdtempSync(join(tmpdir(), "telegram-control-"));
  dirs.push(home);
  const write = (path: string, token: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:14033", token }), { mode: 0o600 });
  };
  write(join(home, ".robob", "ardud-control.json"), "shared");
  expect(() => discoverControlConfig({ home, env: {} })).toThrow("ENOENT");
  write(join(home, ".robob", "components", "telegram-bridge.json"), "own");
  expect(discoverControlConfig({ home, env: {} }).token).toBe("own");
  expect(discoverControlConfig({ home, env: { T3_CONTROL_TOKEN_FILE: "" } }).token).toBe("own");
  expect(discoverControlConfig({ home, env: {}, tokenFile: "" }).token).toBe("own");
});

test("control config refuses a named token file that does not exist", () => {
  const home = mkdtempSync(join(tmpdir(), "telegram-control-"));
  dirs.push(home);
  expect(() => discoverControlConfig({ env: { T3_CONTROL_TOKEN_FILE: join(home, "missing.json") }, home })).toThrow("ENOENT");
});

test("control config refuses a token file others can read", () => {
  const loose = tokenFile("loose.json", "loose", 0o644);
  expect(() => discoverControlConfig({ env: { T3_CONTROL_TOKEN_FILE: loose } })).toThrow("chmod 600");
});

test("control config takes env credentials before any file", () => {
  const file = tokenFile("file.json", "file");
  expect(discoverControlConfig({ env: { T3_CONTROL_URL: "http://localhost:1/", T3_CONTROL_TOKEN: "env", T3_CONTROL_TOKEN_FILE: file } }))
    .toEqual({ url: "http://localhost:1", token: "env" });
});

const logs = useToolLogFixture();

test("ask receipts use the kanban route and contain only identity and time", async () => {
  const original = globalThis.fetch;
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "test-token" });
  const calls: { url: string; body: unknown }[] = [];
  try {
    globalThis.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ recorded: true });
    }, { preconnect: original.preconnect });
    await client.askNotified("robob:1380:q1", 0);
    await client.askNotified("arbitrary private text", 0);
    expect(calls).toEqual([{ url: "http://127.0.0.1:1/api/ardud/kanban/cards/robob%3A1380/asks/q1/notified", body: { channel: "telegram", at: "1970-01-01T00:00:00.000Z" } }]);
    globalThis.fetch = Object.assign(async () => Response.json({ error: { code: "not-found" } }, { status: 404 }), { preconnect: original.preconnect });
    await client.askNotified("robob:1380:q1", 0);
  } finally { globalThis.fetch = original; }
});


test("control transport failures preserve only safe causes through the wrapper", async () => {
  const original = globalThis.fetch;
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "test-token" });
  const secret = "https://private.invalid/path?token=private-token";
  try {
    for (const [failure, cause] of [[{ code: "ECONNREFUSED", message: secret }, "ECONNREFUSED"],
      [new DOMException(secret, "TimeoutError"), "timeout"], [new DOMException(secret, "AbortError"), "abort"]] as const) {
      globalThis.fetch = Object.assign(async () => { throw failure; }, { preconnect: original.preconnect });
      let caught: unknown;
      try { await client.request("GET", "/requests"); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ status: 0, causeClass: cause });
      expect(String(caught)).not.toContain(secret);
      expect(logs.entries().at(-1)?.props?.cause).toBe(cause);
    }
  } finally { globalThis.fetch = original; }
  expect(logs.text()).not.toContain(secret);
  expect(logs.text()).not.toContain("test-token");
});

test("control distinguishes invalid JSON from HTTP failure and keeps request bodies private", async () => {
  const original = globalThis.fetch;
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "test-token" });
  try {
    globalThis.fetch = Object.assign(async () => new Response("private non-JSON body"), { preconnect: original.preconnect });
    await expect(client.request("GET", "/requests")).rejects.toMatchObject({ causeClass: "decode" });
    expect(logs.entries().at(-1)?.props?.cause).toBe("decode");
    globalThis.fetch = Object.assign(async () => Response.json({ ok: false }, { status: 403 }), { preconnect: original.preconnect });
    await expect(client.request("GET", "/requests")).rejects.toMatchObject({ causeClass: 403 });
  } finally { globalThis.fetch = original; }
  expect(logs.text()).not.toContain("private non-JSON body");
});


test("JSON body failures preserve transport causes with signal and HTTP precedence", async () => {
  const original = globalThis.fetch;
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "test-token" });
  const secret = "https://private.invalid/body?token=private-token";
  const cases = [
    { failure: new SyntaxError(secret), status: 200, cause: "decode" },
    { failure: Object.assign(new Error(secret), { code: "ECONNRESET" }), status: 200, cause: "ECONNRESET" },
    { failure: Object.assign(new Error(secret), { code: "ETIMEDOUT" }), status: 200, cause: "ETIMEDOUT" },
    { failure: new DOMException(secret, "AbortError"), status: 200, cause: "abort" },
    { failure: new Error(secret), status: 200, signal: AbortSignal.abort(new DOMException(secret, "TimeoutError")), cause: "timeout" },
    { failure: Object.assign(new Error(secret), { code: "ECONNRESET" }), status: 503, cause: 503 },
    { failure: new Error(secret), status: 503, signal: AbortSignal.abort(new DOMException(secret, "TimeoutError")), cause: "timeout" },
    { failure: Object.assign(new Error(secret), { code: "PRIVATE_CODE" }), status: 200, cause: "unclassified" },
  ];
  try {
    for (const entry of cases) {
      globalThis.fetch = Object.assign(async () => new Response(new ReadableStream({
        start(controller) { controller.error(entry.failure); },
      }), { status: entry.status }), { preconnect: original.preconnect });
      await expect(client.request("GET", "/requests", undefined, { signal: entry.signal }))
        .rejects.toMatchObject({ status: entry.status, causeClass: entry.cause });
      expect(logs.entries().at(-1)?.props?.cause).toBe(entry.cause);
    }
  } finally { globalThis.fetch = original; }
  expect(logs.entries()).toHaveLength(cases.length);
  expect(logs.text()).not.toContain(secret);
  expect(logs.text()).not.toContain("PRIVATE_CODE");
  expect(logs.text()).not.toContain("test-token");
});


test("control wrappers preserve bounded diagnostics for request, body, upload and events", async () => {
  const original = globalThis.fetch;
  const client = new ControlClient({ url: "http://127.0.0.1:1", token: "test-token" });
  const secret = "thread-private-id Private title bearer-token-123 Message text";
  const cases: Array<{ failure: unknown; props: Record<string, string> }> = [
    { failure: new TypeError(secret), props: { cause: "unclassified", detail: "TypeError", errorClass: "TypeError" } },
    { failure: { code: "ConnectionClosed", message: secret }, props: { cause: "socket_closed", detail: "ConnectionClosed" } },
    { failure: { code: "ENOENT", path: secret }, props: { cause: "ENOENT", detail: "ENOENT" } },
    { failure: { code: "ECONNREFUSED", path: secret }, props: { cause: "ECONNREFUSED", detail: "ECONNREFUSED" } },
    { failure: secret, props: { cause: "non_error", detail: "String" } },
  ];
  try {
    for (const { failure, props } of cases) {
      for (const operation of ["request", "body", "upload", "events"]) {
        globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
          if (operation === "upload" && String(input).endsWith("/attachments")) {
            return Response.json({ ok: true, attachmentId: "fixture", relativeUrl: "/upload" });
          }
          if (operation === "body") return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
          throw failure;
        }, { preconnect: original.preconnect });
        let caught: unknown;
        try {
          if (operation === "events") await client.events({ signal: new AbortController().signal }).next();
          else if (operation === "upload") await client.upload({ name: "fixture.txt", mimeType: "text/plain", bytes: new Uint8Array([1]) });
          else await client.request("GET", "/requests");
        } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(Error);
        toolError("telegram", "tg.attention.pendingRequests", undefined, caught);
        expect(logs.entries().at(-1)?.props).toEqual(props);
      }
    }
    globalThis.fetch = Object.assign(async () => Response.json({ ok: false, error: { code: secret } }), { preconnect: original.preconnect });
    try { await client.request("GET", "/requests"); } catch (error) { toolError("telegram", "tg.attention.pendingRequests", undefined, error); }
    expect(logs.entries().at(-1)?.props).toEqual({ cause: "decode", detail: "SchemaError" });
  } finally { globalThis.fetch = original; }
  for (const part of secret.split(" ")) expect(logs.text()).not.toContain(part);
  expect(logs.text()).not.toContain("test-token");
});
