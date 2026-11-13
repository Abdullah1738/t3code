import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthEnvironmentMaintainScope,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as Invocation from "../../mcp/McpInvocationContext.ts";
import * as AccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadRedaction from "./ThreadRedaction.ts";
import { redactionRouteLayer } from "./http.ts";

const input = {
  threadId: ThreadId.make("fixture-thread"),
  itemId: "fixture-item",
  reason: "fixture",
};
const answer = {
  threadId: input.threadId,
  itemId: input.itemId,
  stores: [],
  providers: [],
  checkpointed: true,
  compacted: true,
  verify: true,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "fixture", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect.each([true, false])("HTTP requires maintenance scope (granted=%s)", (granted) =>
  Effect.gen(function* () {
    let calls = 0;
    const web = HttpRouter.toWebHandler(
      redactionRouteLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              authenticateHttpRequest: () =>
                Effect.succeed({ scopes: granted ? [AuthEnvironmentMaintainScope] : [] } as never),
            }),
            Layer.succeed(ThreadRedaction.ThreadRedaction, {
              redactItem: () => {
                calls++;
                return Effect.succeed(answer);
              },
            }),
          ),
        ),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
    const response = yield* Effect.promise(() =>
      web.handler(
        new Request("http://localhost/api/ardud/control/threads/redact-item", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      ),
    );
    expect(response.status).toBe(granted ? 200 : 403);
    expect(calls).toBe(granted ? 1 : 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["owner", "unclaimed", "read-only", "lower-access", "thread"])(
  "MCP redaction authority: %s",
  (kind) => {
    let calls = 0;
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "t3_thread_redact_item", arguments: input })
        .pipe(
          Effect.provideService(Invocation.McpInvocationContext, {
            environmentId: EnvironmentId.make("fixture-env"),
            requestNamespace: "fixture",
            thread:
              kind === "thread"
                ? {
                    threadId: input.threadId,
                    providerSessionId: "fixture-thread-session",
                    providerInstanceId: ProviderInstanceId.make("codex"),
                  }
                : undefined,
            client: {
              sessionId: "fixture",
              label: "fixture",
              access:
                kind === "read-only"
                  ? "read-only"
                  : kind === "lower-access"
                    ? "approval-required"
                    : "full-access",
              maintenanceAuthorized:
                kind === "owner" || kind === "thread" || kind === "lower-access",
            },
            issuedAt: 0,
            capabilities: new Set<Invocation.McpCapability>(["orchestration"]),
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError === true, JSON.stringify(result)).toBe(kind !== "owner");
      expect(calls).toBe(kind === "owner" ? 1 : 0);
    }).pipe(
      Effect.provide(
        McpHttpServer.layerRedactionToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(AccessTestkit.liveThreadsLayer),
          Layer.provide(
            Layer.succeed(ThreadRedaction.ThreadRedaction, {
              redactItem: () => {
                calls++;
                return Effect.succeed(answer);
              },
            }),
          ),
        ),
      ),
    );
  },
);
