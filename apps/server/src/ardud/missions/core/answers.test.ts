/**
 * An answer to a pending question becomes a message on the thread. The MCP
 * tool records who sent it from the invocation scope the transport
 * authenticated: an agent's answer is the agent's, never the user's.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadHandlers from "../../../mcp/toolkits/thread/handlers.ts";
import { ThreadToolkit } from "../../../mcp/toolkits/thread/tools.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";

const laneThread = ThreadId.make("t-lane");
const targetThread = ThreadId.make("t-asking");
const pendingRequest = RuntimeRequestId.make("request-1");

const threadScope = {
  environmentId: EnvironmentId.make("environment:answers"),
  requestNamespace: "provider-session:answers",
  thread: {
    threadId: laneThread,
    providerSessionId: "provider-session:answers",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 1,
} satisfies McpInvocationContext.McpInvocationScope;

const clientScope = {
  environmentId: EnvironmentId.make("environment:answers"),
  requestNamespace: "mcp-client:answers",
  thread: undefined,
  client: { sessionId: "oauth-session", label: "Desktop MCP client" },
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 1,
} as unknown as McpInvocationContext.McpInvocationScope;

const projectionFor = (threadId: ThreadId) =>
  (threadId === laneThread
    ? idleThreadProjection(liveThreadShell(threadId))
    : {
        ...idleThreadProjection(liveThreadShell(threadId)),
        runtimeRequests: [{ id: pendingRequest, kind: "user_input", status: "pending" }],
        turnItems: [{ type: "user_input_request", requestId: pendingRequest, questions: [] }],
      }) as unknown as OrchestrationV2ThreadProjection;

/** Answers the pending question through the MCP tool and returns what was dispatched. */
const answerAs = (scope: McpInvocationContext.McpInvocationScope) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
        getThreadRecords: (threadId) => Effect.succeed(projectionFor(threadId)),
        getProjectThreadRecords: (input) => Effect.succeed(projectionFor(input.threadId)),
        dispatch: (command) => {
          dispatched.push(command);
          return Effect.succeed({ sequence: 1 } as never);
        },
      }),
      Layer.mock(ThreadSearch.ThreadSearch)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(ServerSecretStore.ServerSecretStore)({}),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-missions-answers" }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const toolkit = yield* ThreadToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_pending_request_respond", {
        threadId: targetThread,
        requestId: pendingRequest,
        answers: { color: "Blue" },
      } as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return { result: result.at(-1)?.result, dispatched };
  });

describe("answers to pending questions", () => {
  it.effect("an agent's MCP answer is recorded as the agent's, a client's as the system's", () =>
    Effect.gen(function* () {
      const agent = yield* answerAs(threadScope);
      assert.deepStrictEqual(agent.result, { sequence: 1 });
      assert.strictEqual(agent.dispatched.length, 1);
      const agentCommand = agent.dispatched[0];
      assert.strictEqual(agentCommand?.type, "runtime-request.respond");
      assert.strictEqual(
        agentCommand?.type === "runtime-request.respond" ? agentCommand.createdBy : null,
        "agent",
      );

      const client = yield* answerAs(clientScope);
      const clientCommand = client.dispatched[0];
      assert.strictEqual(
        clientCommand?.type === "runtime-request.respond" ? clientCommand.createdBy : null,
        "system",
      );
    }),
  );
});
