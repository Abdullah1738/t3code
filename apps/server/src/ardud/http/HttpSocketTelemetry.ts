// @effect-diagnostics nodeBuiltinImport:off - this adapter observes raw Node sockets before HTTP decoding.
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

import * as HttpRequestLifecycle from "./HttpRequestLifecycle.ts";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { deferIdleSocketClose } from "./deferIdleSocketClose.ts";
import * as McpResponseDelivery from "./McpResponseDelivery.ts";

export type SocketRecord = Readonly<Record<string, string | number | boolean>>;
type Report = (name: string, fields: SocketRecord) => void;

interface SocketState {
  socket: NodeNet.Socket;
  idle: boolean;
  upgraded: boolean;
  requests: number;
  lastResponseAt: number;
  lastResponseBytesRead: number;
  detachHttp: () => void;
  localPort: number;
  remotePort: number;
  deliveries: Set<McpResponseDelivery.McpResponseDelivery["Service"]>;
}

// Observe response lifecycles without data/readable listeners so Node keeps its native parser.
export function makeHttpSocketTelemetry(report: Report, now = Date.now) {
  const states = new Map<NodeStream.Duplex, SocketState>();
  let idleCloses = 0;
  let rescued = 0;
  let destroysWithUnreadBytes = 0;
  let dataAfterEnd = 0;
  let recentResets = 0;
  let summaryAt = now();

  function isIdle(state: SocketState | undefined) {
    return (
      state !== undefined &&
      state.idle &&
      !state.socket.destroyed &&
      !state.socket.writableEnded &&
      state.socket.bytesRead === state.lastResponseBytesRead
    );
  }

  function fields(socket: NodeNet.Socket, state = states.get(socket)): SocketRecord {
    return {
      bytesRead: socket.bytesRead,
      bytesWritten: socket.bytesWritten,
      localPort: state?.localPort ?? socket.localPort ?? 0,
      remotePort: state?.remotePort ?? socket.remotePort ?? 0,
      idleKeepAlive: isIdle(state),
      readableLength: socket.readableLength,
      serverEnded: socket.writableEnded,
      upgraded: state?.upgraded ?? false,
      responseAgeMs: state && state.lastResponseAt > 0 ? now() - state.lastResponseAt : -1,
    };
  }

  function responseFinished(this: NodeHttp.ServerResponse) {
    const socket = this.req.socket;
    const state = states.get(socket);
    if (!state || state.upgraded) return;
    state.requests--;
    state.lastResponseAt = now();
    state.lastResponseBytesRead = socket.bytesRead;
    state.idle = state.requests === 0 && this.shouldKeepAlive;
  }

  function instrument<T extends NodeHttp.Server>(server: T): T {
    // reqwest pools idle connections for 90 s. Let the client retire them first.
    // Node 24's extra keepAliveTimeoutBuffer remains at its default (1 s).
    server.keepAliveTimeout = 95_000;
    server.headersTimeout = 100_000;
    server.on("connection", (socket: NodeNet.Socket) => {
      const state: SocketState = {
        socket,
        idle: false,
        upgraded: false,
        requests: 0,
        lastResponseAt: 0,
        lastResponseBytesRead: 0,
        detachHttp: () => {},
        localPort: socket.localPort ?? 0,
        remotePort: socket.remotePort ?? 0,
        deliveries: new Set(),
      };
      states.set(socket, state);
      socket.on("close", () => states.delete(socket));
      const onLateData = () => {
        if (socket.writableEnded) dataAfterEnd++;
      };
      // A data/readable listener unconsumes Node's native HTTP parser. Observe
      // late bytes only after the server's writable side has finished.
      const onFinish = () => {
        state.idle = false;
        if (!socket.destroyed) socket.on("data", onLateData);
      };
      const onError = (error: NodeJS.ErrnoException) => {
        if (state.upgraded) return;
        for (const delivery of state.deliveries)
          if (delivery.closeReason === "unknown") delivery.closeReason = "socket_error";
        const recentReset =
          error.code === "ECONNRESET" &&
          state.lastResponseAt > 0 &&
          now() - state.lastResponseAt < 1_000;
        if (recentReset) recentResets++;
        report("server.http.socket.error", {
          ...fields(socket, state),
          code: error.code ?? "UNKNOWN",
          recentReset,
        });
      };
      socket.on("finish", onFinish);
      socket.on("error", onError);
      socket.on("end", () => {
        for (const delivery of state.deliveries)
          if (delivery.closeReason === "unknown") delivery.closeReason = "peer_end";
      });
      const destroy = socket.destroy;
      socket.destroy = function (error) {
        if (!this.destroyed && !state.upgraded && this.readableLength > 0)
          destroysWithUnreadBytes++;
        return destroy.call(this, error);
      };
      state.detachHttp = () => {
        socket.off("finish", onFinish);
        socket.off("data", onLateData);
        socket.off("error", onError);
        socket.destroy = destroy;
      };
    });
    server.on("request", (request, response) => {
      if (request.url?.startsWith("/api/ardud/control/"))
        HttpRequestLifecycle.observe(request, response);
      const state = states.get(request.socket);
      if (!state) return;
      state.idle = false;
      state.requests++;
      response.on("finish", responseFinished);
      if (request.url?.split("?", 1)[0] === "/mcp") {
        const delivery = McpResponseDelivery.observe(
          request,
          response,
          (closed) => {
            report("server.http.socket.mcpResponseDropped", {
              ...fields(request.socket, state),
              activeRequests: state.requests,
              headersSent: response.headersSent,
              writableFinished: response.writableFinished,
              ...closed.snapshot(),
              ...(closed.tool === undefined ? {} : { tool: closed.tool }),
              ...(closed.callerThreadId === undefined
                ? {}
                : { callerThreadId: closed.callerThreadId }),
            });
          },
          now,
        );
        state.deliveries.add(delivery);
        const remove = () => state.deliveries.delete(delivery);
        response.once("finish", remove);
        response.once("close", remove);
      }
    });
    server.on("upgrade", (_request, socket) => {
      const state = states.get(socket);
      if (!state) return;
      state.idle = false;
      state.upgraded = true;
      state.detachHttp();
    });
    server.on("clientError", (error: NodeJS.ErrnoException, socket: NodeNet.Socket) => {
      for (const delivery of states.get(socket)?.deliveries ?? [])
        delivery.closeReason = "client_error";
      report("server.http.socket.clientError", {
        ...fields(socket),
        code: error.code ?? "UNKNOWN",
      });
      // A clientError listener takes ownership of Node's default error response.
      // Match Node 24: never append HTTP bytes to an already-started response.
      // Respect any additional error handler installed by the server's caller.
      if (server.listenerCount("clientError") > 1) return;
      const active = (socket as NodeNet.Socket & { _httpMessage?: { _headerSent: boolean } })
        ._httpMessage;
      // writeHead() prepares headers; only _headerSent tracks Node's wire state.
      if (socket.writable && !active?._headerSent) {
        const status =
          error.code === "HPE_HEADER_OVERFLOW"
            ? "431 Request Header Fields Too Large"
            : error.code === "HPE_CHUNK_EXTENSIONS_OVERFLOW"
              ? "413 Payload Too Large"
              : error.code === "ERR_HTTP_REQUEST_TIMEOUT"
                ? "408 Request Timeout"
                : "400 Bad Request";
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      }
      socket.destroy(error);
    });
    return deferIdleSocketClose(
      server,
      (socket, outcome) => {
        if (outcome === "rescued") rescued++;
        else {
          if (isIdle(states.get(socket))) idleCloses++;
          for (const delivery of states.get(socket)?.deliveries ?? [])
            delivery.closeReason = "idle_timeout";
        }
      },
      (socket) => {
        const state = states.get(socket);
        return state !== undefined && (state.requests > 0 || state.upgraded);
      },
    );
  }

  function sample() {
    // Read native byte counters at the telemetry cadence, without installing a
    // healthy-socket data listener just to notice an unfinished next request.
    let idleSockets = 0;
    for (const state of states.values()) if (isIdle(state)) idleSockets++;
    report("server.http.socket.sample", { openSockets: states.size, idleSockets });
    const at = now();
    if (at - summaryAt < 60_000) return;
    report("server.http.socket.summary", {
      elapsedMs: at - summaryAt,
      idleCloses,
      rescued,
      destroysWithUnreadBytes,
      dataAfterEnd,
      recentResets,
    });
    idleCloses = rescued = destroysWithUnreadBytes = dataAfterEnd = recentResets = 0;
    summaryAt = at;
  }
  return { instrument, sample };
}

export class HttpSocketTelemetry extends Context.Service<
  HttpSocketTelemetry,
  {
    readonly instrument: <T extends NodeHttp.Server>(server: T) => T;
    readonly sample: Effect.Effect<void>;
  }
>()("t3/ardud/http/HttpSocketTelemetry") {}

export const layer = Layer.effect(
  HttpSocketTelemetry,
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const telemetry = makeHttpSocketTelemetry((name, attributes) => {
      runFork(Effect.void.pipe(Effect.withSpan(name, { root: true, level: "Info", attributes })));
    });
    return HttpSocketTelemetry.of({
      instrument: telemetry.instrument,
      sample: Effect.sync(telemetry.sample),
    });
  }),
);
