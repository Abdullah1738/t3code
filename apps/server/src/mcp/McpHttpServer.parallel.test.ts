import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId, ThreadId, ProviderInstanceId, type AnalyticsEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit, McpSchema, McpServer } from "effect/ai";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as McpCallLedger from "../ardud/analytics/McpCallLedger.ts";
import * as ThreadReadMetrics from "../ardud/analytics/ThreadReadMetrics.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

it.effect.each(["same session", "different callers"] as const)(
  "thread read HTTP calls overlap: %s",
  (mode) => Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const recorded = yield* Deferred.make<void>();
    let active = 0;
    const rows: AnalyticsEvent[] = [];
    const probe = Toolkit.make(Tool.make("t3_thread_read", {
      description: "A latched thread read",
      success: Schema.Struct({ ok: Schema.Boolean }),
    }));
    const registration = McpHttpServer.toolkitRegistration(probe, McpToolAccess.toLayer(probe, {
      t3_thread_read: McpToolAccess.reads(() => Effect.gen(function* () {
        active += 1;
        if (active === 3) yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return { ok: true };
      })),
    })).pipe(
      Layer.provideMerge(McpHttpServer.layerMcpTransport),
      Layer.provide(Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolve: (token) => Effect.succeed({
          environmentId: EnvironmentId.make("env:parallel"),
          requestNamespace: token,
          thread: {
            threadId: ThreadId.make(`thread:${token}`),
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: token,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        }),
      })),
      Layer.provide(Layer.mock(Analytics.Analytics)({
        record: (row) => Effect.gen(function* () {
          if (row.kind !== "mcp.call") return;
          rows.push(row);
          if (rows.length === 3) yield* Deferred.succeed(recorded, undefined);
        }),
        flush: Effect.void,
      })),
    );
    yield* HttpRouter.serve(registration, { disableListenLog: true, disableLogger: true }).pipe(Layer.build);
    const http = yield* HttpClient.HttpClient;
    const headers = (token: string, session?: string) => ({
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(session === undefined ? {} : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
    });
    const initialize = (token: string) => http.post("/mcp", {
      headers: headers(token),
      body: HttpBody.text(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "parallel", version: "1" } },
      }), "application/json"),
    });
    const first = yield* initialize("first");
    const second = mode === "same session" ? first : yield* initialize("second");
    const pending = yield* Effect.forEach([0, 1, 2], (index) => {
      const other = mode === "different callers" && index === 2;
      return http.post("/mcp", {
        headers: headers(other ? "second" : "first", (other ? second : first).headers["mcp-session-id"]!),
        body: HttpBody.text(JSON.stringify({
          jsonrpc: "2.0", id: index + 2, method: "tools/call",
          params: { name: "t3_thread_read", arguments: {} },
        }), "application/json"),
      }).pipe(Effect.flatMap((response) => response.text));
    }, { concurrency: "unbounded" }).pipe(Effect.forkChild);
    // All three must enter before any is released. A serial transport deadlocks here.
    yield* Deferred.await(entered);
    expect(active).toBe(3);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(pending)).toHaveLength(3);
    yield* Deferred.await(recorded);
    expect(rows.map((row) => row.inFlightAtStart?.overall).sort()).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.inFlightAtStart?.session).sort()).toEqual(
      mode === "same session" ? [1, 2, 3] : [1, 1, 2],
    );
    for (const row of rows) expect(row).toMatchObject({
      readerWaitMs: 0, queryMs: 0, renderMs: 0, threadReadStages: [],
    });
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each(["cancel", "shutdown"] as const)("captures active stages and releases counters on %s", (mode) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const recorded = yield* Deferred.make<void>();
    const rows: AnalyticsEvent[] = [];
    let calls = 0;
    let shutdown: Effect.Effect<void> = Effect.void;
    const probe = Toolkit.make(Tool.make("t3_thread_read", {
      description: "A cancellable thread read",
      success: Schema.Struct({ ok: Schema.Boolean }),
      dependencies: [McpCallLedger.McpCallLedger],
    }));
    const registration = McpHttpServer.toolkitRegistration(probe, McpToolAccess.toLayer(probe, {
      t3_thread_read: McpToolAccess.reads(() => Effect.gen(function* () {
        shutdown = (yield* McpCallLedger.McpCallLedger).shutdown;
        calls += 1;
        if (calls > 1) return { ok: true };
        return yield* ThreadReadMetrics.read("timeline", Effect.gen(function* () {
          (yield* NodeSqliteClient.ReaderWaitObserver)?.(70);
          yield* (yield* NodeSqliteClient.StatementObserver)!.record({
            operation: "read", connection: "reader", durationMs: 20, waitMs: 70, outcome: "success",
          });
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }));
      })),
    })).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(McpCallLedger.layer),
      Layer.provide(Layer.mock(Analytics.Analytics)({
        record: (row) => Effect.gen(function* () {
          if (row.kind !== "mcp.call") return;
          rows.push(row);
          if (rows.length === (mode === "cancel" ? 2 : 1)) yield* Deferred.succeed(recorded, undefined);
        }),
        flush: Effect.void,
      })),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const invocation = {
        environmentId: EnvironmentId.make("env:exit"), requestNamespace: "exit",
        thread: {
          threadId: ThreadId.make("thread:exit"), providerSessionId: "exit",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined, capabilities: new Set(["orchestration"] as const), issuedAt: 1,
      };
      const client = McpSchema.McpServerClient.of({
        clientId: 1, clientCapabilities: {}, clientInfo: { name: "exit", version: "1" },
        protocolVersion: "2025-06-18",
        initializePayload: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "exit", version: "1" } },
        getClient: Effect.die("unused"),
      });
      const call = () => server.callTool({ name: "t3_thread_read", arguments: {} }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
      const pending = yield* call().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(100);
      if (mode === "shutdown") {
        yield* shutdown;
        yield* Deferred.await(recorded);
        expect(rows[0]).toMatchObject({
          outcome: "interrupted_by_shutdown", readerWaitMs: 70, queryMs: 20,
          threadReadStages: [{ stage: "timeline", durationMs: 100, readerWaitMs: 70, queryMs: 20, completed: false }],
        });
      }
      yield* Fiber.interrupt(pending);
      if (mode === "cancel") {
        yield* call();
        yield* Deferred.await(recorded);
        expect(rows[0]).toMatchObject({
          outcome: "interrupted", readerWaitMs: 70, queryMs: 20,
          threadReadStages: [{ stage: "timeline", durationMs: 100, readerWaitMs: 70, queryMs: 20, completed: true }],
        });
        expect(rows[1]).toMatchObject({ outcome: "ok", inFlightAtStart: { session: 1, overall: 1 } });
      } else {
        expect(rows).toHaveLength(1);
        expect(rows[0]?.threadReadStages?.[0]?.completed).toBe(false);
      }
    }).pipe(Effect.provide(registration));
  }).pipe(Effect.scoped),
);
