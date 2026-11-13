import { afterEach, expect, test } from "bun:test";
import { useToolLogFixture } from "./toollog-fixture.ts";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spectrumRouterStatus } from "../src/spectrum-status.ts";

const servers: Server[] = [];
const directories: string[] = [];

function socketPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "telegram-router-test-"));
  directories.push(directory);
  return join(directory, "router.sock");
}

async function serve(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void): Promise<string> {
  const path = socketPath();
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return path;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const owned = {
  route: { id: "ses_1", directory: "/Chats/ses_1", generation: 3 },
  pending: [{ id: "perm_1", kind: "permission", state: "pending", operationState: "sent" }],
};

test("decodes a well-formed ownership snapshot", async () => {
  const path = await serve((request, response) => {
    expect(request.url).toBe("/router");
    response.end(JSON.stringify(owned));
  });
  expect(await spectrumRouterStatus(path)).toEqual(owned);
  expect(logs.entries()).toEqual([]);
});

test("keeps the optional request session of subagent-owned entries", async () => {
  const child = {
    route: owned.route,
    pending: [{ id: "q_9", kind: "question", state: "pending", operationState: "pending", sessionId: "ses_child", directory: "/Chats/ses_1" }],
  };
  const path = await serve((request, response) => response.end(JSON.stringify(child)));
  expect(await spectrumRouterStatus(path)).toEqual(child);
  const bad = await serve((request, response) => response.end(JSON.stringify({
    route: owned.route, pending: [{ ...child.pending[0], sessionId: "" }],
  })));
  expect(await spectrumRouterStatus(bad)).toBeUndefined();
  expectError("tg.router.decode");
});

test("an empty router means nothing is owned", async () => {
  const path = await serve((request, response) => response.end(JSON.stringify({ route: null, pending: [] })));
  expect(await spectrumRouterStatus(path)).toEqual({ route: null, pending: [] });
});

test.each([
  [{ route: { id: "s", directory: "d", generation: -1 }, pending: [] }, "negative generation"],
  [{ route: { id: "s", directory: "d", generation: 1.5 }, pending: [] }, "fractional generation"],
  [{ route: { id: "s", directory: "d" }, pending: [] }, "missing generation"],
  [{ route: { id: "", directory: "d", generation: 1 }, pending: [] }, "empty id"],
  [{ route: { id: "s", directory: "d\n", generation: 1 }, pending: [] }, "control character"],
  [{ route: "ses_1", pending: [] }, "non-object route"],
  [{ route: null, pending: {} }, "non-array pending"],
  [{ route: null, pending: [{ id: "p", kind: "other", state: "pending", operationState: null }] }, "unknown kind"],
  [{ route: null, pending: [{ id: "p", kind: "question", state: 1, operationState: null }] }, "numeric state"],
  [{ route: null, pending: [{ id: "p", kind: "question", state: "pending", operationState: 3 }] }, "numeric operationState"],
  [{ route: null, pending: [{ kind: "question", state: "pending", operationState: null }] }, "missing id"],
])("rejects malformed body: %s", async (body, name) => {
  const path = await serve((request, response) => response.end(JSON.stringify(body)));
  expect(await spectrumRouterStatus(path), name).toBeUndefined();
  expectError("tg.router.decode");
});

test("non-200 responses, broken JSON, truncation, and connection loss all mean unavailable", async () => {
  const failing = await serve((request, response) => { response.statusCode = 503; response.end("nope"); });
  expect(await spectrumRouterStatus(failing)).toBeUndefined();
  expectError("tg.router.httpStatus");
  const malformed = await serve((request, response) => response.end("{not json"));
  expect(await spectrumRouterStatus(malformed)).toBeUndefined();
  const huge = await serve((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end("[".repeat(200_000));
  });
  expect(await spectrumRouterStatus(huge)).toBeUndefined();
  expect(logs.entries().map(row => row.error?.tag)).toEqual(["tg.router.httpStatus", "tg.router.decode", "tg.router.tooLarge"]);
  const dying = await serve((request, response) => response.destroy());
  expect(await spectrumRouterStatus(dying)).toBeUndefined();
  expect(logs.entries().map(row => row.error?.tag)).toEqual(["tg.router.httpStatus", "tg.router.decode", "tg.router.tooLarge", "tg.router.request"]);
});

test("unreachable or unsafe sockets never own attention", async () => {
  expect(await spectrumRouterStatus(join(socketPath(), "missing.sock"))).toBeUndefined();
  expectError("tg.router.request");
  expect(await spectrumRouterStatus("relative/path.sock")).toBeUndefined();
  expect(await spectrumRouterStatus("/bad\0path")).toBeUndefined();
  expect(logs.entries().map(row => row.error?.tag)).toEqual(["tg.router.request", "tg.router.socket", "tg.router.socket"]);
});

test("timeouts bound the ownership check", async () => {
  const path = await serve(() => { /* never respond */ });
  expect(await spectrumRouterStatus(path, 50)).toBeUndefined();
  expectError("tg.router.timeout");
});

test("timeouts after response headers log once despite abort and stream error events", async () => {
  const path = await serve((request, response) => {
    response.writeHead(200);
    response.flushHeaders();
  });
  expect(await spectrumRouterStatus(path, 50)).toBeUndefined();
  expectError("tg.router.timeout");
});

const logs = useToolLogFixture();


function expectError(tag: string) {
  expect(logs.entries()).toEqual([expect.objectContaining({ tool: "watchers", component: "telegram", name: "telegram.error", kind: "error", ok: false, error: { tag, message: tag } })]);
}

test("incomplete response bodies produce one tagged error without response or socket content", async () => {
  const path = await serve((request, response) => {
    response.writeHead(200, { "Content-Length": "200", Connection: "close" });
    response.end("PRIVATE_RESPONSE_BODY");
  });
  expect(await spectrumRouterStatus(path)).toBeUndefined();
  expectError("tg.router.incomplete");
  expect(logs.text()).not.toContain("PRIVATE_RESPONSE_BODY");
  expect(logs.text()).not.toContain(path);
});
