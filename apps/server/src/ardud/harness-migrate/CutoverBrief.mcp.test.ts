import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpThreadReadResult,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";

const decode = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);

it.effect.each(["claudeAgent", "codex", "codex-cu"])(
  "lets a %s MCP caller page the same thread's pre-switch OpenCode activity",
  (target) => {
    const threadId = ThreadId.make("thread:same-before-and-after-cutover");
    const shell = {
      ...liveThreadShell(threadId),
      providerInstanceId: ProviderInstanceId.make(target),
      modelSelection: { instanceId: ProviderInstanceId.make(target), model: "native-model" },
    };
    const rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [0, 1].map((position) => {
      const id = TurnItemId.make(`item:old-opencode:${position}`);
      return {
        position,
        sourceThreadId: threadId,
        sourceItemId: id,
        visibility: "local",
        item: {
          id,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: ProviderThreadId.make("provider-thread:old-opencode"),
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: position + 1,
          status: "completed",
          title: null,
          startedAt: shell.createdAt,
          completedAt: shell.createdAt,
          updatedAt: shell.createdAt,
          type: "command_execution",
          input: `old command ${position}`,
          output: `old result ${position}`,
          exitCode: 0,
        },
      };
    });
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:cutover-fixture"),
      requestNamespace: "native-cutover-fixture",
      thread: {
        threadId,
        providerInstanceId: ProviderInstanceId.make(target),
        providerSessionId: "native-session",
      },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration"]),
    };
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      protocolVersion: "2025-06-18",
      clientCapabilities: {},
      clientInfo: { name: "native-fixture", version: "1" },
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "native-fixture", version: "1" },
      },
      getClient: Effect.die("unused"),
    });
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const read = (afterPosition?: number) =>
        server
          .callTool({
            name: "t3_thread_read",
            arguments: {
              threadId,
              view: "activity",
              limit: 1,
              ...(afterPosition === undefined ? {} : { afterPosition }),
            },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      const first = yield* read();
      assert.isFalse(
        first.isError,
        first.content.map((item) => (item.type === "text" ? item.text : "")).join("\n"),
      );
      const page = yield* decode(first.structuredContent);
      assert.equal(page.items[0]?.type, "command_execution");
      assert.include(page.items[0]!.text, "old command 0");
      assert.isTrue(page.hasMore);
      const second = yield* read(page.nextPosition!);
      const last = yield* decode(second.structuredContent);
      assert.include(last.items[0]!.text, "old command 1");
      assert.isFalse(last.hasMore);
    }).pipe(
      Effect.provide(
        McpHttpServer.layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(shell),
              getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
              getProjectThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
              getTimelinePage: (_id, options) =>
                Effect.sync(() => {
                  assert.equal(options?.view, "activity");
                  const remaining = rows.filter(
                    (row) => row.position > (options?.afterPosition ?? -1),
                  );
                  return {
                    items: remaining.slice(0, 1),
                    totalItems: rows.length,
                    hasMore: remaining.length > 1,
                  };
                }),
            }),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
          Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
          Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        ),
      ),
    );
  },
);
