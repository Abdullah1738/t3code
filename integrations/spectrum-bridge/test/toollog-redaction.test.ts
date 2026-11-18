import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, constants, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createToolLog, toolError, toolLog, type LogLine } from "../src/toollog.ts";
import { putSecretRequest, sweepSecrets } from "../src/secrets.ts";
import { Store } from "../src/store.ts";
import { ControlClient } from "../src/control.ts";

const day = "2026-11-13";
const at = Date.parse(`${day}T12:00:00Z`);
let root: string;
let previous: string | undefined;
beforeEach(async () => {
  // End any previous test's outage before checking that a fresh failure retains its native cause.
  toolLog.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok: true, durationMs: 1,
    props: { method: "GET", route: "/health", failureFormat: "single" } });
  toolLog.flush();
  await toolLog.settled();
  root = mkdtempSync(join(tmpdir(), "toollog-redaction-"));
  previous = process.env.TOOLLOG_DIR;
  process.env.TOOLLOG_DIR = root;
});
afterEach(() => {
  toolLog.flush();
  if (previous === undefined) delete process.env.TOOLLOG_DIR;
  else process.env.TOOLLOG_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
function rows(date = day): LogLine[] {
  return readFileSync(join(root, `${date}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("a real refused ControlClient connection logs the native fetch cause safely", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const client = new ControlClient({ url: `http://127.0.0.1:${address.port}`, token: "PRIVATE_TOKEN" });
  await expect(client.request("GET", "/health?message=PRIVATE_BODY&token=PRIVATE_QUERY")).rejects.toMatchObject({ name: "ControlError", status: 0 });
  toolLog.flush();
  const records = rows(new Date().toISOString().slice(0, 10));
  const failure = records.find(line => line.error?.tag === "control.request_failed")!;
  expect(records.filter(line => line.error)).toHaveLength(1);
  expect(failure.name).toBe("turn.robob_call");
  expect(failure.error).toMatchObject({ code: "ECONNREFUSED" });
  expect(failure.site).toMatch(/^src\/control.ts:\d+$/);
  expect(JSON.stringify(records)).not.toMatch(/PRIVATE_|127\.0\.0\.1|message=|token=/);
});

const fetchCodes = [
  ["ConnectionRefused", "ECONNREFUSED"], ["Timeout", "ETIMEDOUT"],
  ["Malformed_HTTP_Response", "HPE_INVALID_CONSTANT"], ["InvalidHTTPResponse", "HPE_INVALID_CHUNK_SIZE"],
  ["ResponseHeadersTooLarge", "UND_ERR_HEADERS_OVERFLOW"], ["InvalidContentLength", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH"],
  ["ZlibError", "Z_DATA_ERROR"], ["FailedToOpenSocket", "FailedToOpenSocket"],
  ["ConnectionClosed", "ConnectionClosed"], ["DNSResolveFailed", "DNSResolveFailed"],
  ["DNSResolutionFailed", "DNSResolutionFailed"], ["TooManyRedirects", "TooManyRedirects"],
  ["TLSHandshakeFailed", "TLSHandshakeFailed"], ["HTTP2StreamReset", "HTTP2StreamReset"],
  ["HTTP3ProtocolError", "HTTP3ProtocolError"],
  ["ConnectionRefused_PRIVATE_TOKEN", undefined], ["PRIVATE_TOKEN", undefined],
  ["ConnectionRefused?token=PRIVATE_QUERY", undefined], ["ConnectionRefused +971501234567", undefined],
];
test.each(fetchCodes)("native fetch code shape %# stays safe through deferred cleaning and wrappers", (code, expected) => {
  const log = createToolLog({ root, now: () => at, defer: true });
  for (const cause of [
    Object.assign(new TypeError("PRIVATE_BODY"), { code }),
    new TypeError("PRIVATE_BODY", { cause: Object.assign(new Error("PRIVATE_BODY"), { code }) }),
    Object.assign(new TypeError("PRIVATE_BODY"), { errno: code }),
  ]) log.write({ component: "fixture", kind: "error", name: "bridge.catch", error: { tag: "fixture.catch1", cause } });
  log.flush();
  expect(rows().map(row => row.error?.code)).toEqual([expected, expected, undefined]);
  expect(rows()[2].error?.errno).toBe(expected);
  expect(JSON.stringify(rows())).not.toMatch(/PRIVATE_|971501234567/);
});

test("a forced throw retains class, code, errno, status, catch site and two reduced frames", () => {
  function fail() {
    throw Object.assign(new TypeError("HTTP 503 token=sk-private-token +971 50 123 4567 /Users/private/attachment.png?secret=private message=PRIVATE_BODY"), {
      code: "ECONNRESET", errno: -54, statusCode: 503,
      token: "PRIVATE_FORM_VALUE", body: "PRIVATE_BODY",
    });
  }
  try { fail(); } catch (error) { toolError("fixture", "fixture.catch1", error); }
  toolLog.flush();
  const [line] = rows(new Date().toISOString().slice(0, 10));
  expect(line.site).toMatch(/^test\/toollog-redaction.test.ts:\d+$/);
  expect(line.error).toMatchObject({ tag: "fixture.catch1", name: "TypeError", code: "ECONNRESET", errno: -54, status: 503, message: "HTTP 503 [redacted]" });
  expect(line.error?.stack).toHaveLength(2);
  for (const frame of line.error!.stack!) expect(frame).toMatch(/^test\/toollog-redaction.test.ts:\d+$/);
  const raw = JSON.stringify(line);
  for (const secret of ["sk-private-token", "+971", "123 4567", "/Users/private", "attachment.png", "secret=", "PRIVATE_BODY", "PRIVATE_FORM_VALUE"]) expect(raw).not.toContain(secret);
});

test.each([
  ["ENOENT: no such file or directory, scandir '/Users/private/forms/secret.json'", "ENOENT: no such file or directory [redacted]"],
  ["connect ECONNREFUSED 127.0.0.1:3773", "connect ECONNREFUSED [redacted]"],
  ["HTTP 401 https://user:password@example.test/private/path?token=SECRET#PRIVATE", "HTTP 401 [redacted]"],
  ["HTTP 503 Bearer SECRET +1 (555) 123-4567 C:\\Users\\Private\\attachment.pdf", "HTTP 503 [redacted]"],
  ["Request failed with status code 429 body={\"text\":\"PRIVATE\"}", "Request failed with status code 429 [redacted]"],
  ["HTTP 500\nmessage: PRIVATE\n    at /Users/private/attachment.png:12:3", "HTTP 500 [redacted]"],
  ["fetch failed", "fetch failed"],
  ["database is locked", "database is locked"],
  ["Unexpected end of JSON input PRIVATE", "Unexpected end of JSON input [redacted]"],
  ["PRIVATE_MESSAGE_SENTINEL", "[redacted]"],
  ["{\"password\":\"PRIVATE\",\"otp\":\"654321\"}", "[redacted]"],
  ["token=SECRET phone=0501234567 path=./attachments/PRIVATE.png", "[redacted]"],
  ["a".repeat(10000), "[redacted]"],
].map(([message, expected], index) => [index, message, expected] as const))("redacts message shape %#", (_index, message, expected) => {
  const log = createToolLog({ root, now: () => at, defer: true });
  log.write({ component: "fixture", kind: "error", name: "reply.failed", error: { tag: "fixture.catch1", cause: new Error(message) } });
  log.flush();
  expect(rows()[0].error?.message).toBe(expected);
  expect(rows()[0].error!.message.length).toBeLessThanOrEqual(200);
});

test.each(["bridge.catch", "reply.failed", "form.fail"])("%s uses the same safe boundary", name => {
  const log = createToolLog({ root, now: () => at });
  log.write({ component: "fixture", kind: "error", name, error: {
    tag: "fixture.failed", cause: Object.assign(new Error("PRIVATE"), { code: "PRIVATE_TOKEN", status: 422 }),
  } });
  const line = rows()[0];
  expect(line.site).toMatch(/^test\/toollog-redaction.test.ts:\d+$/);
  expect(line.error).toMatchObject({ name: "Error", status: 422, message: "[redacted]" });
  expect(JSON.stringify(line)).not.toContain("PRIVATE");
});

test("the real periodic form sweep reports ENOENT for an active submission without leaking its directory", async () => {
  const store = new Store(":memory:");
  const now = Date.now();
  try {
    putSecretRequest(store, "t".repeat(43), { sessionId: "fixture", generation: 1, purpose: "Fixture",
      fields: [{ name: "password", label: "Password", type: "password" }], state: "submitted",
      createdAt: now, expiresAt: now + 900_000, valuesExpireAt: now + 1_800_000 });
    await expect(sweepSecrets({ store, stateRoot: join(root, "PRIVATE_MISSING_DIRECTORY"), now: () => now })).resolves.toBeUndefined();
    toolLog.flush();
    const line = rows(new Date().toISOString().slice(0, 10)).find(line => line.error?.tag === "secrets.catch9")!;
    expect(line.site).toMatch(/^src\/secrets.ts:\d+$/);
    expect(line.error).toMatchObject({ name: "Error", code: "ENOENT" });
    expect(JSON.stringify(line)).not.toContain("PRIVATE_MISSING_DIRECTORY");
    expect(JSON.stringify(line)).not.toContain(root);
  } finally { store.close(); }
});

test("rollup separates classes at the same tag and keeps legacy records", async () => {
  const log = createToolLog({ root, now: () => at });
  for (const cause of [new TypeError("PRIVATE"), new TypeError("PRIVATE"), new RangeError("PRIVATE"), undefined]) {
    log.write({ component: "fixture", kind: "error", name: "bridge.catch", error: { tag: "fixture.catch1", cause } });
  }
  const result = await log.rollup(day);
  expect(result?.topErrorTags.map(({ tag, name, count }) => ({ tag, name, count }))).toEqual([
    { tag: "fixture.catch1", name: "TypeError", count: 2 },
    { tag: "fixture.catch1", name: "RangeError", count: 1 },
    { tag: "fixture.catch1", name: "UnknownError", count: 1 },
  ]);
});

test.each([false, true])("error diagnostics and call summaries share sanitization with defer=%s", async defer => {
  const log = createToolLog({ root, now: () => at, defer });
  const ids = { threadId: "thread-fixture", messageId: "turn-fixture" };
  log.write({ component: "router", kind: "event", name: "turn.start", ids });
  for (const durationMs of [5, 1_500]) log.write({ component: "robob", kind: "perf", name: "turn.robob_call", durationMs,
    ok: durationMs < 1_000, ids: log.runIds(ids.threadId), props: { method: "GET", route: "/threads/:id" } });
  for (const [messageId, cause] of [["type-error", new TypeError("PRIVATE_BODY")], ["range-error", new RangeError("PRIVATE_BODY")]] as const) {
    log.write({ component: "fixture", kind: "error", name: "bridge.catch", ids: { ...ids, messageId }, error: { tag: "fixture.catch1", cause } });
  }
  log.write({ component: "forms", kind: "event", name: "form.fail", ids, ok: false });
  log.write({ component: "router", kind: "perf", name: "turn.end", ids, ok: true });
  await log.settled();
  expect(JSON.stringify(rows())).not.toContain("PRIVATE");
  expect(rows().find(row => row.name === "form.fail")).toMatchObject({ kind: "error", error: { name: "ValidationError", tag: "form.gone" } });
  expect(rows().find(row => row.calls)?.calls?.thread.count).toBe(2);
  appendFileSync(join(root, `${day}.ndjson`), JSON.stringify({ ts: `${day}T12:00:00Z`, tool: "imessage", component: "robob", kind: "perf",
    name: "turn.robob_calls", ids: { callBatchId: "injected-fixture" }, text: "PRIVATE_BODY",
    error: { tag: "injected.error", name: "PRIVATE_CLASS", message: "PRIVATE_BODY" },
    calls: { thread: { ok: 1, failed: 0, histogram: [[7, 1]], message: "PRIVATE_BODY", p50: "PRIVATE_BODY" } },
  }) + "\n");
  const result = await log.rollup(day);
  expect(result?.countsByName["turn.robob_call"]).toBe(3);
  expect(result?.byComponent.robob?.thread.count).toBe(3);
  for (const [name, sampleId] of [["TypeError", "type-error"], ["RangeError", "range-error"]]) {
    const error = result?.topErrorTags.find(error => error.tag === "fixture.catch1" && error.name === name);
    expect(error).toMatchObject({ count: 1, sampleId });
    expect(error?.site).toMatch(/^test\/toollog-redaction.test.ts:\d+$/);
  }
  expect(result?.topErrorTags.some(error => error.tag === "injected.error")).toBe(false);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

test("hostile getters, primitives and provider-controlled class names cannot break logging", () => {
  const log = createToolLog({ root, now: () => at });
  const causes = [null, "PRIVATE", 654321, { name: "PRIVATE_TOKEN", message: "PRIVATE" },
    { get name() { throw new Error("PRIVATE"); } }];
  for (const cause of causes) expect(() => log.write({ component: "fixture", kind: "error", name: "bridge.catch", error: { tag: "fixture.catch1", cause } })).not.toThrow();
  expect(rows()).toHaveLength(causes.length);
  expect(JSON.stringify(rows())).not.toMatch(/PRIVATE|654321/);
});

test.each([
  [{ code: "tokenNetwork" }, { code: "tokenNetwork" }],
  [{ errno: "ECONNRESET" }, { errno: "ECONNRESET" }],
  [{ code: "internalError" }, { code: "internalError" }],
  [{ code: "http_400:PRIVATE_TOKEN" }, { code: "http_400:provider_error", status: 400 }],
  [{ code: "http503" }, { code: "http503", status: 503 }],
  [{ code: "tokenHttp401" }, { code: "tokenHttp401", status: 401 }],
  [{ cause: { code: "ECONNREFUSED", errno: -61 } }, { code: "ECONNREFUSED", errno: -61 }],
  [{ status: 429 }, { status: 429 }],
  [{ statusCode: 502 }, { status: 502 }],
  [{ response: { status: 503, body: "PRIVATE" } }, { status: 503 }],
])("retains known diagnostic metadata %#", (metadata, expected) => {
  const log = createToolLog({ root, now: () => at, defer: true });
  log.write({ component: "fixture", kind: "error", name: "bridge.catch", error: {
    tag: "fixture.catch1", cause: Object.assign(new Error("PRIVATE"), metadata),
  } });
  log.flush();
  expect(rows()[0].error).toMatchObject(expected);
  expect(JSON.stringify(rows())).not.toContain("PRIVATE");
});

test("multiline message text cannot masquerade as source frames", () => {
  const log = createToolLog({ root, now: () => at });
  log.write({ component: "fixture", kind: "error", name: "bridge.catch", error: {
    tag: "fixture.catch1", cause: new Error("PRIVATE\n    at /private/spectrum-bridge/src/PRIVATE_ATTACHMENT.ts:12:3"),
  } });
  expect(rows()[0].error?.stack?.[0]).toMatch(/^test\/toollog-redaction.test.ts:\d+$/);
  expect(JSON.stringify(rows())).not.toContain("PRIVATE");
});

test("DOM abort exceptions retain their error name", () => {
  const log = createToolLog({ root, now: () => at });
  log.write({ component: "fixture", kind: "error", name: "bridge.catch", error: {
    tag: "fixture.catch1", cause: new DOMException("PRIVATE", "AbortError"),
  } });
  expect(rows()[0].error?.name).toBe("AbortError");
  expect(JSON.stringify(rows())).not.toContain("PRIVATE");
});

// Each stack input shape must pass the same filter when queued, appended and rolled up.
test.each([
  ["node:PRIVATE_FORM_VALUE:12:3", "<external>:12"],
  ["node:internal/PRIVATE_FORM_VALUE:12:3", "<external>:12"],
  ["/private/spectrum-bridge/src/PRIVATE_ATTACHMENT.ts:12:3", "<external>:12"],
  ["/private/spectrum-bridge/test/PRIVATE_ATTACHMENT.test.ts:12:3", "<external>:12"],
  ["/private/PRIVATE_ATTACHMENT.pdf:12:3", "<external>:12"],
  ["https://example.test/PRIVATE_ATTACHMENT.js?token=PRIVATE:12:3", "<external>:12"],
  ["node:fs:12:3", "node:fs:12"],
  ["node:internal/process/task_queues:12:3", "node:internal/process/task_queues:12"],
  ["/private/spectrum-bridge/src/secrets.ts:12:3", "src/secrets.ts:12"],
])("stack location shape %# never exposes unknown names", async (frame, expected) => {
  const log = createToolLog({ root, now: () => at, defer: true });
  log.write({ component: "fixture", kind: "error", name: "bridge.catch", site: "src/PRIVATE_ATTACHMENT.ts:99", error: {
    tag: "fixture.catch1", cause: { name: "Error", message: "fixed", stack: `Error: fixed\n    at ${frame}` },
  } });
  log.flush();
  expect(rows()[0].error?.stack).toEqual([expected]);
  expect(rows()[0].site).toBeUndefined();
  expect(JSON.stringify(rows())).not.toContain("PRIVATE");
  expect(JSON.stringify(await log.rollup(day))).not.toContain("PRIVATE");
});

test.each([
  ["node:PRIVATE_FORM_VALUE:12", "<external>:12"],
  ["src/PRIVATE_ATTACHMENT.ts:12", "<external>:12"],
  ["src/secrets.ts:12", "src/secrets.ts:12"],
  ["<external>:12", "<external>:12"],
])("already reduced stack shape %# is revalidated", (frame, expected) => {
  const log = createToolLog({ root, now: () => at, defer: true });
  log.write({ component: "fixture", kind: "error", name: "bridge.catch", error: {
    tag: "fixture.catch1", name: "Error", stack: [frame],
  } });
  log.flush();
  expect(rows()[0].error?.stack).toEqual([expected]);
  expect(JSON.stringify(rows())).not.toContain("PRIVATE");
});

test("O_NOFOLLOW symlink guard errors retain ELOOP", () => {
  const target = join(root, "PRIVATE_TARGET");
  const link = join(root, "PRIVATE_SYMLINK");
  writeFileSync(target, "PRIVATE_CONTENT");
  symlinkSync(target, link);
  const log = createToolLog({ root, now: () => at });
  try {
    openSync(link, constants.O_RDONLY | constants.O_NOFOLLOW);
    throw new Error("expected symlink guard to reject");
  } catch (cause) {
    log.write({ component: "fixture", kind: "error", name: "bridge.catch", error: { tag: "fixture.catch1", cause } });
  }
  expect(rows()[0].error?.code).toBe("ELOOP");
  expect(JSON.stringify(rows())).not.toContain("PRIVATE");
});

test.each([
  ["1", true], ["100000", true], ["0", false], ["100001", false],
  ["971500000000", false], ["00012", false], ["-1", false], ["12.5", false], ["1e3", false],
])("source line number shape %# is validated in every location field", async (number, valid) => {
  const log = createToolLog({ root, now: () => at, defer: true });
  const raw = [
    `/private/spectrum-bridge/src/secrets.ts:${number}:3`,
    `/private/attachment.ts:${number}:3`,
    `node:fs:${number}:3`,
  ];
  for (const frame of raw) log.write({ component: "fixture", kind: "error", name: "bridge.catch", error: {
    tag: "fixture.catch1", cause: { name: "Error", message: "fixed", stack: `Error: fixed\n    at ${frame}` },
  } });
  for (const frame of [`src/secrets.ts:${number}`, `node:fs:${number}`, `<external>:${number}`]) {
    log.write({ component: "fixture", kind: "error", name: "bridge.catch", error: { tag: "fixture.catch1", stack: [frame] } });
  }
  log.write({ component: "fixture", kind: "error", name: "bridge.catch", site: `src/secrets.ts:${number}`, error: { tag: "fixture.catch1" } });
  log.flush();
  const lines = rows();
  for (const line of lines.slice(0, 6)) expect(Boolean(line.error?.stack?.length)).toBe(valid);
  expect(lines[6].site).toBe(valid ? `src/secrets.ts:${number}` : undefined);
  if (!valid) {
    expect(JSON.stringify(lines.map(line => ({ site: line.site, stack: line.error?.stack })))).not.toContain(`:${number}`);
    expect(JSON.stringify((await log.rollup(day))?.topErrorTags)).not.toContain(`:${number}`);
  }
});

test.each(["+971501234567", "/Users/private/PRIVATE.pdf", "https://private.test/?token=PRIVATE", "PRIVATE_TOKEN"])("render diagnostics reject private metadata shape %#", async privateValue => {
  const log = createToolLog({ root, now: () => at, defer: true });
  log.write({ component: "cards", kind: "perf", name: "card.render", ok: false, durationMs: 22,
    ids: { chat: privateValue }, props: { cardKind: privateValue, outcome: "failed", failureCode: privateValue, attempt: 1 } });
  log.write({ component: "router", kind: "error", name: "bridge.catch", error: {
    tag: "router.catch49", cause: { name: "Error", message: privateValue, code: privateValue, causeKey: privateValue },
  } });
  log.flush();
  expect(rows()[0]).toMatchObject({ ids: { chat: "other" }, props: { outcome: "failed", attempt: 1 } });
  expect(rows()[0].props?.failureCode).toBeUndefined();
  expect(rows()[1].error?.causeKey).toBe("background_watch");
  expect(JSON.stringify(rows())).not.toContain(privateValue);
  expect(JSON.stringify(await log.rollup(day))).not.toContain(privateValue);
});
