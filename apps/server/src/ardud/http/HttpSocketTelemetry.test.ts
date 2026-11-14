// @effect-diagnostics nodeBuiltinImport:off - exercises raw HTTP/socket events on isolated servers.
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import { describe, expect, vi, afterEach } from "vite-plus/test";
import { it } from "@effect/vitest";

import { makeHttpSocketTelemetry, type SocketRecord } from "./HttpSocketTelemetry.ts";
import * as HttpSocketTelemetry from "./HttpSocketTelemetry.ts";

class Socket extends NodeEvents.EventEmitter {
  bytesRead = 100;
  bytesWritten = 200;
  localPort = 3773;
  remotePort = 23456;
  readableLength = 0;
  writableEnded = false;
  writable = true;
  destroyed = false;
  _httpMessage?: { headersSent: boolean };
  write = vi.fn();
  destroy(_error?: Error) {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }
}

function setup() {
  let time = 10_000;
  const records: Array<{ name: string; fields: SocketRecord }> = [];
  const telemetry = makeHttpSocketTelemetry(
    (name, fields) => records.push({ name, fields }),
    () => time,
  );
  const raw = NodeHttp.createServer();
  raw.removeAllListeners("connection");
  const server = telemetry.instrument(raw);
  const socket = new Socket();
  server.emit("connection", socket);
  const respond = () => {
    const response = Object.assign(new NodeEvents.EventEmitter(), {
      req: { socket },
      shouldKeepAlive: true,
    });
    server.emit("request", { socket }, response);
    response.emit("finish");
  };
  return {
    ...telemetry,
    server,
    socket,
    records,
    respond,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

// Run only our deferred close, never wait for a wall-clock idle deadline.
afterEach(() => vi.useRealTimers());

describe("HTTP socket telemetry", () => {
  it("retires server sockets after reqwest's 90-second pool, retaining Node's buffer", () => {
    const server = NodeHttp.createServer();
    const buffer = server.keepAliveTimeoutBuffer;
    makeHttpSocketTelemetry(() => {}).instrument(server);
    expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(95_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.keepAliveTimeoutBuffer).toBe(buffer);
  });

  it.each(["ECONNRESET", "EPIPE", "HPE_INVALID_METHOD"])(
    "records %s before HTTP dispatch with bounded socket fields",
    (code) => {
      const t = setup();
      t.respond();
      t.server.emit("clientError", Object.assign(new Error("private payload"), { code }), t.socket);
      expect(t.records).toEqual([
        {
          name: "server.http.socket.clientError",
          fields: {
            code,
            bytesRead: 100,
            bytesWritten: 200,
            localPort: 3773,
            remotePort: 23456,
            idleKeepAlive: true,
            readableLength: 0,
            serverEnded: false,
            upgraded: false,
            responseAgeMs: 0,
          },
        },
      ]);
      expect(t.socket.destroyed).toBe(true);
      t.sample();
      expect(t.records.at(-1)?.fields).toEqual({ openSockets: 0, idleSockets: 0 });
    },
  );

  it.each([
    ["HPE_INVALID_METHOD", "400 Bad Request"],
    ["HPE_HEADER_OVERFLOW", "431 Request Header Fields Too Large"],
    ["HPE_CHUNK_EXTENSIONS_OVERFLOW", "413 Payload Too Large"],
    ["ERR_HTTP_REQUEST_TIMEOUT", "408 Request Timeout"],
  ])("preserves Node's %s response", (code, status) => {
    const t = setup();
    t.server.emit("clientError", Object.assign(new Error(), { code }), t.socket);
    expect(t.socket.write).toHaveBeenCalledWith(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  });

  it("does not append an error response to a started response or take over another handler", () => {
    const t = setup();
    t.socket._httpMessage = { headersSent: true };
    t.server.emit("clientError", new Error(), t.socket);
    expect(t.socket.write).not.toHaveBeenCalled();
    const other = setup();
    const handler = vi.fn();
    other.server.on("clientError", handler);
    other.server.emit("clientError", new Error(), other.socket);
    expect(handler).toHaveBeenCalledOnce();
    expect(other.socket.destroyed).toBe(false);
  });

  it("summarizes idle closes and rescues once per minute and resets counters", () => {
    vi.useFakeTimers();
    const t = setup();
    t.respond();
    t.server.emit("timeout", t.socket);
    t.socket.bytesRead++;
    vi.runAllTimers();
    expect(t.socket.destroyed).toBe(false);
    t.server.emit("timeout", t.socket);
    vi.runAllTimers();
    expect(t.socket.destroyed).toBe(true);
    t.sample();
    expect(t.records.map((r) => r.name)).toEqual(["server.http.socket.sample"]);
    t.advance(60_000);
    t.sample();
    expect(t.records.at(-1)?.fields).toEqual({
      elapsedMs: 60_000,
      idleCloses: 1,
      rescued: 1,
      destroysWithUnreadBytes: 0,
      dataAfterEnd: 0,
      recentResets: 0,
    });
    t.advance(60_000);
    t.sample();
    expect(t.records.at(-1)?.fields.rescued).toBe(0);
    expect(t.records.at(-1)?.fields.idleCloses).toBe(0);
  });

  it("counts pending destroys, late data and resets less than one second after a response", () => {
    const t = setup();
    t.respond();
    t.advance(999);
    t.socket.emit("error", Object.assign(new Error(), { code: "ECONNRESET" }));
    expect(t.records.at(-1)?.fields).toMatchObject({ recentReset: true, responseAgeMs: 999 });
    t.advance(1);
    t.socket.emit("error", Object.assign(new Error(), { code: "ECONNRESET" }));
    expect(t.records.at(-1)?.fields.recentReset).toBe(false);
    t.socket.writableEnded = true;
    t.socket.emit("data", Buffer.from("private bytes"));
    t.socket.readableLength = 7;
    t.socket.destroy();
    t.socket.destroy();
    t.advance(60_000);
    t.sample();
    expect(t.records.at(-1)?.fields).toMatchObject({
      destroysWithUnreadBytes: 1,
      dataAfterEnd: 1,
      recentResets: 1,
    });
  });

  it("tracks idle, active and partial-header sockets without tracing each request", () => {
    const t = setup();
    t.sample();
    expect(t.records.pop()?.fields).toEqual({ openSockets: 1, idleSockets: 0 });
    for (let i = 0; i < 100; i++) t.respond();
    expect(t.records).toEqual([]);
    t.sample();
    expect(t.records.pop()?.fields.idleSockets).toBe(1);
    t.socket.bytesRead++;
    t.socket.emit("data", Buffer.from("P"));
    t.sample();
    expect(t.records.pop()?.fields.idleSockets).toBe(0);
  });

  it("detaches HTTP data/error/destroy instrumentation on WebSocket upgrade", () => {
    const t = setup();
    t.respond();
    t.server.emit("upgrade", {}, t.socket);
    expect(t.socket.listenerCount("data")).toBe(0);
    expect(t.socket.listenerCount("error")).toBe(0);
    t.socket.readableLength = 7;
    t.socket.destroy();
    t.advance(60_000);
    t.sample();
    expect(t.records.at(-1)?.fields).toMatchObject({ destroysWithUnreadBytes: 0, dataAfterEnd: 0 });
  });

  it("serves reused HTTP POSTs and hands upgraded sockets to the WebSocket path", async () => {
    const records: Array<{ name: string; fields: SocketRecord }> = [];
    const telemetry = makeHttpSocketTelemetry((name, fields) => records.push({ name, fields }));
    const server = telemetry.instrument(NodeHttp.createServer());
    const sockets = new Set<NodeNet.Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("request", (request, response) => {
      request.resume();
      response.end("ok");
    });
    server.on("upgrade", (_request, socket) => {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });
    const agent = new NodeHttp.Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const port = address.port;
    const post = () =>
      new Promise<boolean>((resolve, reject) => {
        const request = NodeHttp.request(
          { host: "127.0.0.1", port, method: "POST", path: "/mcp", agent },
          (response) => {
            response.resume();
            response.on("end", () => resolve(request.reusedSocket));
          },
        );
        request.on("error", reject);
        request.end("body");
      });
    try {
      expect(await post()).toBe(false);
      expect(await post()).toBe(true);
      telemetry.sample();
      expect(records.at(-1)?.fields.idleSockets).toBe(1);
      const upgraded = await new Promise<number | undefined>((resolve, reject) => {
        const request = NodeHttp.get({
          host: "127.0.0.1",
          port,
          agent: false,
          headers: { Connection: "Upgrade", Upgrade: "websocket" },
        });
        request.on("error", reject);
        request.on("upgrade", (response, socket) => {
          socket.destroy();
          resolve(response.statusCode);
        });
      });
      expect(upgraded).toBe(101);
      expect(records.filter((r) => r.name.includes("Error") || r.name.endsWith(".error"))).toEqual(
        [],
      );
    } finally {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.effect("writes diagnostics through the Effect tracer", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      yield* Effect.gen(function* () {
        const context = yield* Layer.build(HttpSocketTelemetry.layer);
        const telemetry = Context.get(context, HttpSocketTelemetry.HttpSocketTelemetry);
        const raw = NodeHttp.createServer();
        raw.removeAllListeners("connection");
        const server = telemetry.instrument(raw);
        const socket = new Socket();
        server.emit("connection", socket);
        server.emit("clientError", Object.assign(new Error(), { code: "EPIPE" }), socket);
        yield* telemetry.sample;
      }).pipe(Effect.scoped, Effect.withTracer(tracer));
      expect(
        spans.find((s) => s.name === "server.http.socket.clientError")?.attributes.get("code"),
      ).toBe("EPIPE");
      expect(
        spans.find((s) => s.name === "server.http.socket.sample")?.attributes.get("idleSockets"),
      ).toBe(0);
    }),
  );
});
