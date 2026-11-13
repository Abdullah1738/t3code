import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import { OrchestratorMcpFailure, type AnalyticsEvent } from "@t3tools/contracts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import { finishRollup, makeAccumulator } from "../../../ardud/analytics/rollup.ts";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Analytics from "../../../ardud/analytics/Analytics.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AnalyticsToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";

const scope = (allowed: boolean) =>
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("env-test"),
    capabilities: new Set(allowed ? ["orchestration" as const] : []),
    issuedAt: 0,
    requestNamespace: "analytics-test",
    thread: undefined,
    client: undefined,
  });
it.effect("reads a filtered day's rollup through the MCP service boundary", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const service = Layer.succeed(
      Analytics.Analytics,
      Analytics.Analytics.of({
        flush: Effect.void,
        record: () => Effect.void,
        ingest: () => Effect.void,
        read: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return {
              rollup: {
                ...finishRollup(makeAccumulator(), "2026-11-13", "2026-11-13T00:00:00.000Z"),
                kindCounts: { "ask.answered": 2 },
              },
              samples: [],
            };
          }),
      }),
    );
    const run = Effect.gen(function* () {
      const toolkit = yield* AnalyticsToolkit;
      return yield* toolkit
        .handle("analytics_read", {
          day: "2026-11-13",
          kind: "run.usage",
          boardId: "board-robob",
          cardId: "card:one",
          limit: 10,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
    });
    const result = yield* run.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
          Layer.provideMerge(service),
          Layer.provideMerge(scope(true)),
        ),
      ),
    );
    expect(result.at(-1)?.result).toMatchObject({
      rollup: { kindCounts: { "ask.answered": 2 } },
      samples: [],
    });
    expect(calls).toEqual([
      {
        day: "2026-11-13",
        kind: "run.usage",
        boardId: "board-robob",
        cardId: "card:one",
        limit: 10,
      },
    ]);
    const denied = yield* run.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
          Layer.provideMerge(service),
          Layer.provideMerge(scope(false)),
        ),
      ),
    );
    expect(denied.at(-1)?.result).toMatchObject({ code: "capability_denied" });
    expect(calls).toHaveLength(1);
  }),
);

it.effect("records MCP failures as metadata without exporting the tool's text", () =>
  Effect.gen(function* () {
    const recorded = yield* Deferred.make<AnalyticsEvent>();
    const Probe = Toolkit.make(
      Tool.make("local_failure_probe", {
        parameters: Tool.EmptyParams,
        success: Schema.Unknown,
        failure: OrchestratorMcpFailure,
        failureMode: "return",
      }),
    );
    const handlers = McpToolAccess.toLayer(Probe, {
      local_failure_probe: McpToolAccess.reads(() =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "private-token-and-prompt",
          }),
        ),
      ),
    });
    const registration = McpHttpServer.toolkitRegistration(Probe, handlers).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(
        Layer.mock(Analytics.Analytics)({
          record: (event) => Deferred.succeed(recorded, event).pipe(Effect.asVoid),
        }),
      ),
    );
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      protocolVersion: "2025-06-18",
      clientCapabilities: {},
      clientInfo: { name: "analytics-test", version: "1" },
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "analytics-test", version: "1" },
      },
      getClient: Effect.die("unused"),
    });
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "local_failure_probe", arguments: {} })
        .pipe(Effect.provideService(McpSchema.McpServerClient, client));
      expect(result.isError).toBe(true);
      const event = yield* Deferred.await(recorded);
      expect(event).toMatchObject({
        kind: "mcp.call",
        tool: "local_failure_probe",
        outcome: "refused",
        errorTag: "capability_denied",
        saved: false,
      });
      expect(JSON.stringify(event)).not.toMatch(/private|token|prompt/);
    }).pipe(Effect.provide(registration.pipe(Layer.provideMerge(scope(true)))));
  }),
);
