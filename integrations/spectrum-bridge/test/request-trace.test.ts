import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { createApi } from "../src/api.ts";
import { sendCommand } from "../src/cli.ts";
import { Store } from "../src/store.ts";
import { createRequestTrace, type TraceEntry } from "../src/request-trace.ts";
import { createToolLog, type LogLine } from "../src/toollog.ts";
import { summarizeLog } from "../src/log-rollup.ts";

test("send traces one sanitized row and preserves the real queue response", async () => {
  const root = mkdtempSync(join(tmpdir(), "request-trace-"));
  const store = new Store(":memory:");
  const day = "2026-11-22";
  const log = createToolLog({ root, now: () => Date.parse(`${day}T12:00:00Z`), capBytes: 1 });
  const trace = createRequestTrace(entry => log.write(entry), { loopLag: () => 12 });
  store.set("route", { id: "current", generation: 1 });
  const api = createApi({ store, photon: { async react() {} }, router: () => undefined,
    chatGuid: () => "iMessage;-;+15555550123", enabled: () => true, health: () => ({}) });
  const id = "55a02449-089c-411d-9619-cc2a07f717cb";
  const body = JSON.stringify({ sessionId: "current", dedupeKey: "fixture", text: "PRIVATE_MESSAGE" });
  try {
    const response = await trace.handle(new Request("http://bridge/send?token=PRIVATE_QUERY", {
      method: "POST", body, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "X-Bridge-Request-Id": id },
    }), api);
    expect(response.status).toBe(202);
    log.flush();
    const raw = readFileSync(join(root, `${day}.ndjson`), "utf8");
    const rows: LogLine[] = raw.trim().split("\n").map(row => JSON.parse(row));
    const calls = rows.filter(row => row.name === "api.request");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.props).toMatchObject({ path: "/send", status: 202, bodyBytes: Buffer.byteLength(body), handlerMs: expect.any(Number), loopLagMs: 12, ok: true });
    expect(calls[0]?.ids).toMatchObject({ requestId: id, runId: expect.any(String) });
    expect(raw).not.toContain("PRIVATE_");
    for (const status of [400, 409, 503]) await trace.handle(new Request("http://bridge/send"), () => new Response(null, { status }));
    await expect(trace.handle(new Request("http://bridge/PRIVATE_PATH"), () => { throw new Error("PRIVATE_ERROR"); })).rejects.toThrow();
    log.flush();
    const last = JSON.parse(readFileSync(join(root, `${day}.ndjson`), "utf8").trim().split("\n").at(-1)!);
    expect(last.props).toMatchObject({ status: 500, path: "/unknown", ok: false });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("flood rollup accounts for excess calls once and keeps every send", async () => {
  let at = 0;
  let elapsed = 0;
  const rows: TraceEntry[] = [];
  const trace = createRequestTrace(row => rows.push(row), { clock: () => at, now: () => elapsed++ });
  for (let i = 0; i < 125; i++) {
    await trace.handle(new Request("http://bridge/health"), () => new Response());
    await trace.handle(new Request("http://bridge/send"), () => new Response());
  }
  expect(rows.filter(row => row.props?.path === "/send")).toHaveLength(125);
  expect(rows.filter(row => row.props?.path === "/health")).toHaveLength(60);
  at = 60_000; trace.flush(); trace.flush();
  const rolled = rows.filter(row => row.name === "api.request.rollup");
  expect(rolled).toHaveLength(1);
  expect(rolled[0]?.props).toMatchObject({ count: 65, p50: 1, p95: 1, max: 1 });
  async function* lines() { for (const row of rows) yield { ...row, tool: "imessage" as const, ts: "2026-11-22T12:00:00Z" }; }
  const result = await summarizeLog(lines());
  expect(result.apiRequests["/health"]).toEqual({ count: 125, handlerMs: { p50: 1, p95: 1, max: 1 } });
  expect(result.apiRequests["/send"]?.count).toBe(125);
  expect(result.countsByName["api.request"]).toBe(250);
});

test("CLI timeout joins the socket header and reports await_headers", async () => {
  const root = mkdtempSync(join(tmpdir(), "request-cli-"));
  const path = join(root, "bridge.sock");
  let header = "";
  const connections = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    connections.add(socket);
    socket.on("data", data => { header += data.toString(); });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const rows: TraceEntry[] = [];
  try {
    await expect(sendCommand({ method: "GET", path: "/messages?token=PRIVATE_QUERY" }, { socketPath: path, timeoutMs: 30, emit: row => rows.push(row) })).rejects.toThrow("Bridge request timed out");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.props).toMatchObject({ phase: "await_headers", path: "/messages", timeoutMs: 30, pid: process.pid, loadAvg: expect.any(Number) });
    expect(rows[0]!.props!.elapsedMs).toBeGreaterThanOrEqual(30);
    expect(header.toLowerCase()).toContain(`x-bridge-request-id: ${rows[0]?.ids?.requestId}`);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["connect", "write", "read_body"])("CLI phase %s follows socket milestones", async phase => {
  const root = mkdtempSync(join(tmpdir(), "request-phase-"));
  const path = join(root, "bridge.sock");
  const server = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(path, resolve));
  const rows: TraceEntry[] = [];
  // A controlled transport makes the never-connected and blocked-write cases deterministic.
  const transport = ((_options: unknown, response: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    if (phase === "connect") (_options as { signal: AbortSignal }).signal.addEventListener("abort", () => req.emit("error", new Error("aborted")));
    req.end = () => queueMicrotask(() => {
      const socket = new EventEmitter() as EventEmitter & { connecting: boolean };
      socket.connecting = true;
      req.emit("socket", socket);
      if (phase !== "connect") socket.emit("connect");
      if (phase === "read_body") { req.emit("finish"); response(new EventEmitter()); }
      if (phase !== "connect") req.emit("error", new Error("PRIVATE_ERROR"));
    });
    return req;
  }) as unknown as typeof httpRequest;
  try {
    await expect(sendCommand({ method: "GET", path: "/health" }, { socketPath: path, timeoutMs: 30, httpRequest: transport, emit: row => rows.push(row) })).rejects.toThrow(phase === "connect" ? "Bridge request timed out" : "Bridge request failed");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.props?.phase).toBe(phase);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test("daily CLI rollup groups failures by path and phase", async () => {
  async function* lines(): AsyncGenerator<LogLine> {
    for (const phase of ["connect", "await_headers", "await_headers"]) yield { tool: "imessage", ts: "2026-11-22T12:00:00Z", component: "cli", kind: "error", name: "cli.request_failed", props: { path: "/messages", phase } };
  }
  expect((await summarizeLog(lines())).cliRequestFailures).toEqual({ "/messages": { connect: 1, await_headers: 2 } });
});


test("request rollup survives logger cleaning and agrees with Python", async () => {
  const root = mkdtempSync(join(tmpdir(), "request-parity-"));
  const day = "2026-11-22";
  const log = createToolLog({ root: join(root, "imessage"), now: () => Date.parse(`${day}T12:00:00Z`) });
  const trace = createRequestTrace(row => log.write(row));
  try {
    for (let i = 0; i < 125; i++) await trace.handle(new Request("http://bridge/health"), () => new Response());
    trace.flush(true);
    for (const phase of ["connect", "await_headers", "await_headers"]) log.write({ component: "cli", kind: "error", name: "cli.request_failed", props: { path: "/messages", phase } });
    log.flush();
    const ts = await log.rollup(day);
    const script = "import sys,json;sys.path.insert(0,sys.argv[1]);import toollog;print(json.dumps(toollog.rollup('imessage',sys.argv[2])))";
    const child = Bun.spawn(["python3", "-I", "-c", script, resolve(import.meta.dir, "../../local-helpers/libexec/toollog"), day], {
      env: { ...process.env, TOOLLOG_ROOT: root }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    const py = JSON.parse(output);
    expect(py.apiRequests).toEqual(ts?.apiRequests);
    expect(py.cliRequestFailures).toEqual(ts?.cliRequestFailures);
    expect(py.countsByName).toEqual(ts?.countsByName);
    expect(py.apiRequests["/health"].count).toBe(125);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const flushBoundaries = [
  ["shutdown within minute", "2026-11-22T12:00:30Z", "2026-11-22T12:00:31Z", true],
  ["next minute", "2026-11-22T12:00:59Z", "2026-11-22T12:01:01Z", false],
  ["UTC day", "2026-11-22T23:59:59Z", "2026-11-23T00:00:01Z", false],
  ["UTC month", "2026-11-30T23:59:59Z", "2026-12-01T00:00:01Z", false],
  ["UTC year", "2026-12-31T23:59:59Z", "2027-01-01T00:00:01Z", false],
  ["delayed flush", "2026-11-22T23:59:59Z", "2026-11-24T00:00:01Z", false],
  ["clock rollback", "2026-11-22T00:00:01Z", "2026-11-21T23:59:59Z", false],
] as const;

test.each(flushBoundaries)("flood rollup retains its request day: %s", async (_name, before, after, shutdown) => {
  const root = mkdtempSync(join(tmpdir(), "request-boundary-"));
  let at = Date.parse(before);
  const day = before.slice(0, 10);
  const laterDay = after.slice(0, 10);
  const log = createToolLog({ root: join(root, "imessage"), now: () => at, defer: true });
  const trace = createRequestTrace(row => log.write(row), { clock: () => at, now: () => 0 });
  try {
    for (let i = 0; i < 65; i++) await trace.handle(new Request("http://bridge/health"), () => new Response());
    at = Date.parse(after);
    trace.flush(shutdown); trace.flush(true);
    log.flush();
    const rows: LogLine[] = readFileSync(join(root, "imessage", `${day}.ndjson`), "utf8").trim().split("\n").map(row => JSON.parse(row));
    const rolled = rows.filter(row => row.name === "api.request.rollup");
    expect(rolled).toHaveLength(1);
    expect(rolled[0]?.props?.count).toBe(5);
    expect(rolled[0]?.ts).toBe(new Date(Math.floor(Date.parse(before) / 60_000) * 60_000).toISOString());
    for (const date of new Set([day, laterDay])) {
      const ts = await log.rollup(date);
      const script = "import sys,json;sys.path.insert(0,sys.argv[1]);import toollog;print(json.dumps(toollog.rollup('imessage',sys.argv[2])))";
      const child = Bun.spawn(["python3", "-I", "-c", script, resolve(import.meta.dir, "../../local-helpers/libexec/toollog"), date], {
        env: { ...process.env, TOOLLOG_ROOT: root }, stdout: "pipe", stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      expect(await child.exited, error).toBe(0);
      const py = JSON.parse(output);
      expect(py.apiRequests).toEqual(ts?.apiRequests);
      expect(py.countsByName).toEqual(ts?.countsByName);
      expect(py.apiRequests["/health"]?.count ?? 0).toBe(date === day ? 65 : 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
