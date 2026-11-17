// @effect-diagnostics nodeBuiltinImport:off -- loopback requests exercise the production response observer.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  type AnalyticsEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { FetchHttpClient, HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as McpCallLedger from "../ardud/analytics/McpCallLedger.ts";
import * as ThreadReadMetrics from "../ardud/analytics/ThreadReadMetrics.ts";
import { makeHttpSocketTelemetry } from "../ardud/http/HttpSocketTelemetry.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpDeadline from "./McpDeadline.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const httpLayer = HttpServer.layerTestClient.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provideMerge(
    NodeHttpServer.layer(
      () => makeHttpSocketTelemetry(() => {}).instrument(NodeHttp.createServer()),
      { port: 0 },
    ),
  ),
);

it.effect.each(
  (
    [
      { mode: "abort", masked: true },
      { mode: "deadline", masked: true },
      { mode: "deadline", masked: false },
    ] as const
  ).flatMap((input) => ["t3_thread_read", "discussion_read"].map((name) => ({ ...input, name }))),
)("records one $name row for $mode with masked=$masked cleanup", ({ mode, masked, name }) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const cleaned = yield* Deferred.make<void>();
    const recorded = yield* Deferred.make<void>();
    const rows: AnalyticsEvent[] = [];
    let shutdown = Effect.void;
    const probe = Toolkit.make(
      Tool.make(name, {
        description: "A masked timeline read",
        success: Schema.Struct({ ok: Schema.Boolean }),
        dependencies: [McpCallLedger.McpCallLedger],
      }),
    );
    const registration = McpHttpServer.toolkitRegistration(
      probe,
      McpToolAccess.toLayer(probe, {
        [name]: McpToolAccess.reads(() =>
          Effect.gen(function* () {
            shutdown = (yield* McpCallLedger.McpCallLedger).shutdown;
            const wait = Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              if (masked) yield* Deferred.await(release).pipe(Effect.uninterruptible);
              else return yield* Effect.never;
              return { ok: true };
            });
            return yield* (
              name === "t3_thread_read" ? ThreadReadMetrics.read("timeline", wait) : wait
            ).pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined)));
          }),
        ),
      }),
    ).pipe(
      Layer.provideMerge(McpHttpServer.layerMcpTransport),
      Layer.provide(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: () =>
            Effect.succeed({
              environmentId: EnvironmentId.make("env:deadline"),
              requestNamespace: "deadline",
              thread: {
                threadId: ThreadId.make("thread:deadline"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerSessionId: "deadline",
              },
              client: undefined,
              capabilities: new Set(["orchestration"]),
              issuedAt: 1,
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (row) =>
            Effect.gen(function* () {
              if (row.kind !== "mcp.call") return;
              rows.push(row);
              yield* Deferred.succeed(recorded, undefined);
            }),
          flush: Effect.void,
        }),
      ),
    );
    yield* HttpRouter.serve(registration, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.build,
    );
    const http = yield* HttpClient.HttpClient;
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: "Bearer deadline",
    };
    const initialized = yield* http.post("/mcp", {
      headers,
      body: HttpBody.jsonUnsafe({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "deadline", version: "1" },
        },
      }),
    });
    const pending = yield* http
      .post("/mcp", {
        headers: {
          ...headers,
          "mcp-session-id": initialized.headers["mcp-session-id"]!,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.jsonUnsafe({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      })
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.forkChild,
      );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(
      mode === "deadline"
        ? name === "t3_thread_read"
          ? McpDeadline.READ_TIMEOUT
          : "20 seconds"
        : "100 millis",
    );
    if (mode === "abort") yield* Fiber.interrupt(pending);
    else {
      const response = yield* Fiber.join(pending);
      expect(response).toContain('"isError":true');
      if (name === "t3_thread_read") {
        expect(response).toContain('"_tag":"ThreadReadTimeoutError"');
        expect(response).toContain("Read-only, nothing changed");
        expect(response).toContain("smaller limit");
        expect(response).toContain("task_status");
      } else {
        expect(response).toContain('"reason":"server_busy"');
        expect(response).toContain("Robob is busy; nothing was read. Retry the same call.");
      }
    }
    yield* Deferred.await(recorded);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: name,
      callerThreadId: "thread:deadline",
      durationMs: mode === "deadline" ? (name === "t3_thread_read" ? 45_000 : 20_000) : 100,
      outcome: mode === "deadline" ? "timeout" : "interrupted",
      errorPhase: mode === "deadline" && name === "t3_thread_read" ? "query" : "handler",
      responseDelivery: mode === "abort" ? "closed" : "finished",
      ...(mode === "deadline"
        ? { errorTag: name === "t3_thread_read" ? "ThreadReadTimeoutError" : "TimeoutError" }
        : {}),
      ...(mode === "abort" ? { props: { cause: "client_disconnect" } } : {}),
      ...(name === "t3_thread_read"
        ? {
            threadReadStages: [
              { stage: "timeline", completed: masked ? false : expect.any(Boolean) },
            ],
          }
        : { phase: "handler", waitedMs: mode === "deadline" ? 20000 : 100 }),
    });
    if (masked) expect(yield* Deferred.isDone(cleaned)).toBe(false);
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(cleaned);
    yield* shutdown;
    expect(rows).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(httpLayer)),
);
