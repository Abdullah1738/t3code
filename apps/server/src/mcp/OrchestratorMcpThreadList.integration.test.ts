import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadListInput,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const caller = liveThreadShell(ThreadId.make("thread:list-result"));
const decodeThreadListResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "thread-list-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-list-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layer = (
  threads: Partial<ThreadManagement.ThreadManagementService["Service"]> = {},
  titleAvailable = true,
) =>
  McpHttpServer.layerOrchestratorToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCallerRow: () => Effect.succeed(caller),
          getThreadListCandidates: () => Effect.succeed([caller]),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [caller],
              archivedThreads: [],
            }),
          ...threads,
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => {
            const project = {
              id,
              title: "Test project",
              workspaceRoot: "/test",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            };
            // The original toolkit fixture supplied project metadata without a title.
            if (!titleAvailable) Reflect.deleteProperty(project, "title");
            return Effect.succeed(Option.some(project));
          },
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      ),
    ),
  );

const invoke = (input: OrchestratorMcpThreadListInput) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "t3_thread_list", arguments: input })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:list-result"),
      requestNamespace: "thread-list-test",
      thread: {
        threadId: caller.id,
        providerSessionId: "session:list-result",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration"] as const),
      issuedAt: 1,
    }),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

it.effect.each(
  [true, false].flatMap((titleAvailable) =>
    [
      { page: "complete", input: {}, ids: [caller.id], nextCursor: null, total: 1, exact: true },
      {
        page: "bounded",
        input: { limit: 1 },
        ids: [caller.id],
        nextCursor: 1,
        total: 2,
        exact: false,
      },
      { page: "empty", input: { statuses: [] }, ids: [], nextCursor: null, total: 0, exact: true },
      { page: "past end", input: { cursor: 10 }, ids: [], nextCursor: null, total: 1, exact: true },
    ].map((testCase) => ({ ...testCase, titleAvailable })),
  ),
)("returns a JSON MCP $page page (title available: $titleAvailable)", (testCase) =>
  Effect.gen(function* () {
    const result = yield* invoke(testCase.input);
    expect(result.isError).toBe(false);
    const content = yield* decodeThreadListResult(result.structuredContent);
    expect(content).toMatchObject({
      projectId: caller.projectId,
      currentThreadId: caller.id,
      nextCursor: testCase.nextCursor,
      total: testCase.total,
      totalIsExact: testCase.exact,
    });
    expect(content.threads.map((thread) => thread.threadId)).toEqual(testCase.ids);
    if (testCase.titleAvailable) expect(content.projectTitle).toBe("Test project");
    else expect(content).not.toHaveProperty("projectTitle");
    expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(result.structuredContent)));
    const text = result.content[0];
    expect(text?.type).toBe("text");
    if (text?.type === "text") expect(JSON.parse(text.text)).toEqual(result.structuredContent);
  }).pipe(
    Effect.provide(
      layer(
        testCase.page === "bounded"
          ? {
              getThreadListCandidates: () =>
                Effect.succeed([caller, liveThreadShell(ThreadId.make("thread:lookahead"))]),
            }
          : {},
        testCase.titleAvailable,
      ),
    ),
  ),
);

it.effect("returns a declared MCP failure when the thread-list deadline expires", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const pending = yield* invoke({ limit: 1 }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("25 seconds");
      const result = yield* Fiber.join(pending);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "lookup_timeout" });
      const text = result.content[0];
      expect(text?.type).toBe("text");
      if (text?.type === "text") {
        expect(JSON.parse(text.text)).toMatchObject({ code: "lookup_timeout" });
        expect(text.text).toContain("25s");
      }
    }).pipe(
      Effect.provide(
        layer({
          getThreadListCandidates: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      ),
    );
  }),
);
