import type { NonNullableUsage, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadSendResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const parentThreadId = ThreadId.make("thread:claude-blocked-status-parent");
const projectId = ProjectId.make("project:claude-delegated-completion");
const selection = {
  instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const sdkUsage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: "not_available",
  iterations: [],
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: "standard",
  speed: "standard",
} satisfies NonNullableUsage;

interface SdkFrame {
  readonly message: SDKMessage;
  readonly processed: Deferred.Deferred<void>;
}

interface QueryProbe {
  readonly input: ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput;
  readonly nativeSessionId: string;
  readonly frames: Queue.Queue<SdkFrame>;
}

const sendSdkFrame = Effect.fn("sendSdkFrame")(function* (query: QueryProbe, message: SDKMessage) {
  const processed = yield* Deferred.make<void>();
  yield* Queue.offer(query.frames, { message, processed });
  yield* Deferred.await(processed);
});

const completeSdkTurn = Effect.fn("completeSdkTurn")(function* (
  query: QueryProbe,
  prompt: SDKUserMessage,
  result: string,
) {
  const crypto = yield* Crypto.Crypto;
  const assistantId = yield* crypto
    .randomUUIDv4()
    .pipe(Effect.filterOrFail(ClaudeAdapterV2.isClaudePromptUuid));
  yield* sendSdkFrame(query, {
    type: "assistant",
    uuid: assistantId,
    session_id: query.nativeSessionId,
    user_message_uuid: prompt.uuid!,
    parent_tool_use_id: null,
    message: {
      id: `msg_${assistantId}`,
      container: null,
      context_management: null,
      type: "message",
      role: "assistant",
      model: selection.model,
      content: [{ type: "text", text: result, citations: null }],
      stop_details: null,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: sdkUsage,
    },
  });
  yield* sendSdkFrame(query, {
    type: "result",
    subtype: "success",
    uuid: yield* crypto
      .randomUUIDv4()
      .pipe(Effect.filterOrFail(ClaudeAdapterV2.isClaudePromptUuid)),
    session_id: query.nativeSessionId,
    user_message_uuid: prompt.uuid!,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: "end_turn",
    terminal_reason: "completed",
    total_cost_usd: 0,
    usage: sdkUsage,
    modelUsage: {},
    permission_denials: [],
  });
});

it.live.each([false, true])(
  "returns Claude SDK results while another session status write is blocked (queued follow-up: %s)",
  (queueFollowup) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("claude-delegated-completion");
        const paused = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const offers = yield* Queue.unbounded<{
          readonly query: QueryProbe;
          readonly message: SDKUserMessage;
        }>();
        const queries: Array<QueryProbe> = [];
        let blockParentStatus = false;
        const layerRegistry = Layer.unwrap(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const crypto = yield* Crypto.Crypto;
            const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
              instanceId: selection.instanceId,
              settings: yield* decodeClaudeSettings({ homePath: cwd }),
              environment: {},
              attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({
                prefix: "t3-claude-delegated-attachments-",
              }),
              fileSystem,
              path: yield* Path.Path,
              crypto,
              idAllocator: yield* IdAllocator.IdAllocatorV2,
              queryRunner: {
                allocateSessionId: crypto.randomUUIDv4().pipe(Effect.orDie),
                open: (input) =>
                  Effect.gen(function* () {
                    const query: QueryProbe = {
                      input,
                      nativeSessionId: input.options.sessionId ?? input.options.resume!,
                      frames: yield* Queue.unbounded<SdkFrame>(),
                    };
                    queries.push(query);
                    return {
                      messages: Stream.fromQueue(query.frames).pipe(
                        Stream.flatMap(({ message, processed }) =>
                          Stream.make(message).pipe(
                            Stream.concat(
                              Stream.fromEffect(Deferred.succeed(processed, undefined)).pipe(
                                Stream.drain,
                              ),
                            ),
                          ),
                        ),
                      ),
                      offer: (message) =>
                        Effect.gen(function* () {
                          const processed = yield* Deferred.make<void>();
                          yield* Queue.offer(query.frames, {
                            message: { ...message, session_id: query.nativeSessionId },
                            processed,
                          });
                          yield* Queue.offer(offers, { query, message });
                        }),
                      setModel: () => Effect.void,
                      applyFlagSettings: () => Effect.void,
                      setPermissionMode: () => Effect.void,
                      stopTask: () => Effect.void,
                      backgroundTasks: () => Effect.succeed(false),
                      interrupt: Effect.void,
                      close: Queue.shutdown(query.frames),
                    };
                  }),
                forkSession: () => Effect.die("unused forkSession"),
                subagentLaunchToolUseId: () => Effect.succeed(null),
                assertComplete: Effect.void,
              },
            });
            return ProviderAdapterRegistry.layerFromAdapters([adapter]);
          }),
        ).pipe(Layer.provide(IdAllocator.layer), Layer.provide(NodeServices.layer));
        const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
          { name: "claude-delegated-completion", runtimePolicyOverride: { cwd } },
          layerRegistry,
          {
            runEffectWorker: false,
            beforeEventWrite: (input) =>
              blockParentStatus &&
              input.events.some(
                (event) =>
                  event.type === "provider-session.updated" && event.threadId === parentThreadId,
              )
                ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
          },
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const layerTest = McpHttpServer.layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(layerOrchestration),
          Layer.provide(layerRegistry.pipe(Layer.provide(McpProviderSessions.layer))),
          Layer.provide(
            ProviderRegistryMock.layer([
              {
                instanceId: selection.instanceId,
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                enabled: true,
                installed: true,
                version: "test",
                status: "ready",
                auth: { status: "authenticated" },
                checkedAt: "2026-11-16T00:00:00.000Z",
                models: [
                  {
                    slug: selection.model,
                    name: selection.model,
                    isCustom: false,
                    capabilities: null,
                  },
                ],
                slashCommands: [],
                skills: [],
              },
            ]),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
          Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const server = yield* McpServer.McpServer;
          const awaitEvent = (
            threadId: ThreadId,
            predicate: (event: OrchestrationV2DomainEvent) => boolean,
          ) =>
            orchestrator.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
              Stream.filter((stored) => predicate(stored.event)),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die(`Event stream ended for ${threadId}.`),
                  onSome: (stored) => Effect.succeed(stored.event),
                }),
              ),
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:claude-delegated-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "Claude delegated parent",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:claude-delegated-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:claude-delegated-parent:start"),
            text: "Keep the parent turn active.",
            attachments: [],
            modelSelection: selection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          const parentOffer = yield* Queue.take(offers);
          expect(parentOffer.query.input.threadId).toBe(parentThreadId);
          yield* awaitEvent(
            parentThreadId,
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          const invocation: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:claude-delegated-completion"),
            requestNamespace: parentOffer.query.input.providerSessionId,
            thread: {
              threadId: parentThreadId,
              providerSessionId: parentOffer.query.input.providerSessionId,
              providerInstanceId: selection.instanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const invoke = (name: string, args: Record<string, unknown>) =>
            server.callTool({ name, arguments: args }).pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(
                McpSchema.McpServerClient,
                McpSchema.McpServerClient.of({
                  clientId: 1,
                  protocolVersion: "2025-06-18",
                  clientCapabilities: {},
                  clientInfo: { name: "claude-completion-test", version: "1.0.0" },
                  initializePayload: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "claude-completion-test", version: "1.0.0" },
                  },
                  getClient: Effect.die("unused client"),
                }),
              ),
              Effect.tap((response) =>
                Effect.sync(() =>
                  expect(response.isError, JSON.stringify(response.content)).not.toBe(true),
                ),
              ),
              Effect.map((response) => response.structuredContent),
            );
          const status = (taskId: string) =>
            invoke("task_status", { taskId }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult)),
            );

          // Hold the actual sink call while the session-status permit is acquired.
          blockParentStatus = true;
          yield* parentOffer.query.input.onMcpStatus!({
            server: "blocked-status-fixture",
            status: "unavailable",
            reason: "timeout",
            batchLatencyMs: 0,
          });
          yield* Deferred.await(paused);

          const first = yield* invoke("delegate_task", {
            task: "Inspect the first delegated boundary.",
            target: { providerInstanceId: selection.instanceId, model: selection.model },
            mode: "async",
            clientRequestId: "claude-delegated-first",
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult)));
          expect(first.childRunId).not.toBeNull();
          yield* worker.drain();
          const firstOffer = yield* Queue.take(offers);
          expect(firstOffer.query.input.threadId).toBe(first.childThreadId);
          expect(firstOffer.query.input.providerSessionId).not.toBe(
            parentOffer.query.input.providerSessionId,
          );
          const queued = queueFollowup
            ? yield* invoke("t3_thread_send", {
                threadId: first.childThreadId,
                message: "Inspect the queued delegated boundary.",
                mode: "queue",
                clientRequestId: "claude-delegated-followup",
              }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult)))
            : null;
          if (queued !== null) {
            expect(queued).toMatchObject({ status: "queued", delivery: "queued" });
            expect(queued.runId).not.toBe(first.childRunId);
          }
          const firstResult = "The first delegated boundary is complete.";
          const expectedResults = new Map([[first.childRunId, firstResult]]);
          yield* completeSdkTurn(firstOffer.query, firstOffer.message, firstResult);
          yield* awaitEvent(
            first.childThreadId,
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.childRunId &&
              event.payload.status === "waiting",
          );
          yield* worker.drain();
          yield* awaitEvent(
            first.childThreadId,
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.childRunId &&
              event.payload.status === "completed",
          );
          if (queued !== null) {
            yield* awaitEvent(
              first.childThreadId,
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === queued.runId &&
                event.payload.status === "starting",
            );
            yield* worker.drain();
            const followupOffer = yield* Queue.take(offers);
            expect(followupOffer.query).toBe(firstOffer.query);
            expect(followupOffer.message.uuid).not.toBe(firstOffer.message.uuid);
            const followupResult = "The queued delegated boundary is complete.";
            expectedResults.set(queued.runId, followupResult);
            yield* completeSdkTurn(followupOffer.query, followupOffer.message, followupResult);
            yield* awaitEvent(
              first.childThreadId,
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === queued.runId &&
                event.payload.status === "waiting",
            );
            yield* worker.drain();
          }
          const resultRunId = queued?.runId ?? first.childRunId;
          yield* awaitEvent(
            parentThreadId,
            (event) =>
              event.type === "context-transfer.created" &&
              event.payload.type === "subagent_result" &&
              event.payload.sourceThreadId === first.childThreadId &&
              event.payload.sourcePoint.runId === resultRunId,
          );
          // A follow-up queued before the original task finishes contributes its final result.
          const taskResult = yield* status(first.taskId);
          expect(taskResult).toMatchObject({
            childRunId: first.childRunId,
            status: "completed",
            workState: "result_available",
            summary: expectedResults.get(resultRunId),
            hasPendingChildRuns: false,
            startPending: false,
            startProgress: null,
            latestTerminalRunId: resultRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
          });
          expect(taskResult.resultContextTransferId).not.toBeNull();
          const child = yield* orchestrator.getThreadProjection(first.childThreadId);
          expect(child.runs.map((run) => run.status)).toEqual(
            [...expectedResults].map(() => "completed"),
          );
          expect(child.turnItems.filter((item) => item.type === "error")).toEqual([]);
          expect(
            queries.filter((query) => query.input.threadId === first.childThreadId),
          ).toHaveLength(1);
          for (const [runId, result] of expectedResults) {
            expect(
              child.turnItems
                .filter((item) => item.type === "assistant_message" && item.runId === runId)
                .map((item) => item.type === "assistant_message" && item.text),
            ).toEqual([result]);
            const attemptId = child.runs.find((run) => run.id === runId)?.activeAttemptId;
            expect(
              child.providerTurns.find((turn) => turn.runAttemptId === attemptId)?.promptAcceptedAt,
            ).toBeDefined();
          }
          expect(yield* Deferred.isDone(release)).toBe(false);
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).providerSessions[0]
              ?.lastError,
          ).toBeNull();
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.provide(layerTest));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
