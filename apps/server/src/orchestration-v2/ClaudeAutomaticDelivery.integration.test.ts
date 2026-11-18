import * as TestClock from "effect/testing/TestClock";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskUpsertInput,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as DelegatedTaskProgressGuard from "./DelegatedTaskProgressGuard.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const sessionId = "automatic-delivery-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const decodeScheduledTask = Schema.decodeEffect(ScheduledTaskUpsertInput);
const refusal =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
const statusIds = ["status-1", "status-2", "status-3", "status-4"];
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

const batch = frame({
  type: "assistant",
  uuid: "batch",
  session_id: sessionId,
  parent_tool_use_id: null,
  message: {
    id: "tool-batch",
    role: "assistant",
    type: "message",
    model: modelSelection.model,
    content: [
      { type: "tool_use", id: "build", name: "Bash", input: { command: "make" } },
      ...statusIds.map((id) => ({
        type: "tool_use",
        id,
        name: "mcp__t3-code__task_status",
        input: { taskId: id },
      })),
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});

const toolResult = (id: string, cancelled: boolean) =>
  frame({
    type: "user",
    uuid: `result-${id}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: cancelled,
          content: cancelled ? refusal : id === "build" ? "build OK" : "Task completed normally",
        },
      ],
    },
    ...(cancelled ? { tool_result_meta: [{ id, non_execution_kind: "cancelled" }] } : {}),
  });

const result = (uuid: string, aborted: boolean) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: aborted ? "aborted_tools" : "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });

const deliveries = [
  "child completion",
  "scheduled message",
  "user steering",
  "promoted queued message",
] as const;

it.effect.each(deliveries)(
  "delivers %s without cancelling pending Claude tools or losing accepted input",
  (delivery) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("claude-automatic-delivery");
        const sdkMessages = yield* Queue.unbounded<SDKMessage>();
        const offers: SDKUserMessage[] = [];
        const offeredMessages = yield* Queue.unbounded<SDKUserMessage>();
        const nativeQueue: SDKUserMessage[] = [];
        const batchAbort = new AbortController();
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: modelSelection.instanceId,
          settings,
          environment: {},
          attachmentsDir: cwd,
          fileSystem: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed(sessionId),
            open: () =>
              Effect.succeed({
                messages: Stream.fromQueue(sdkMessages),
                offer: (message) =>
                  Effect.gen(function* () {
                    offers.push(message);
                    nativeQueue.push(message);
                    // Claude Code 2.1.289's queue watcher aborts when a now-priority
                    // command arrives, including while Bash blocks pending reads.
                    if (nativeQueue.some((command) => command.priority === "now")) {
                      batchAbort.abort({ kind: "interrupt" });
                    }
                    yield* Queue.offer(offeredMessages, message);
                  }),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                stopTask: () => Effect.void,
                interrupt: Effect.die("automatic delivery must never interrupt"),
                close: Effect.void,
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:automatic-delivery");
          const projectId = ProjectId.make("project:automatic-delivery");
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId,
            title: "Automatic delivery",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            threadId,
            messageId: MessageId.make("first"),
            text: "Build and check all four tasks.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(running);
          const initialPrompt = yield* Queue.take(offeredMessages);
          const pending = yield* watch(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.nativeItemRef?.nativeId === "status-4",
          );
          yield* Queue.offer(sdkMessages, batch);
          yield* Fiber.join(pending);
          const before = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(before.turnItems.filter((item) => item.status === "running").length, 5);
          const parent = before.runs[0]!;
          if (parent.rootNodeId === null) return yield* Effect.die("parent has no root node");
          const messageId = MessageId.make("automatic-notice");
          if (delivery === "child completion") {
            const taskId = NodeId.make("completed-child");
            const now = yield* DateTime.now;
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("cohort"),
                  type: "run.updated",
                  threadId,
                  runId: parent.id,
                  occurredAt: now,
                  payload: {
                    ...parent,
                    delegatedCompletion: {
                      disposition: "open",
                      nextGeneration: 2,
                      delivery: { generation: 1, messageId, taskIds: [taskId] },
                    },
                  },
                },
                {
                  id: EventId.make("child"),
                  type: "subagent.updated",
                  threadId,
                  runId: parent.id,
                  nodeId: taskId,
                  occurredAt: now,
                  payload: {
                    id: taskId,
                    threadId,
                    runId: parent.id,
                    parentNodeId: parent.rootNodeId,
                    origin: "app_owned",
                    createdBy: "agent",
                    driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                    providerInstanceId: modelSelection.instanceId,
                    providerThreadId: null,
                    childThreadId: null,
                    nativeTaskRef: null,
                    prompt: "Background work",
                    title: "Child",
                    model: null,
                    completionWake: "always",
                    completionDelivery: { state: "claimed", observedByRunId: null },
                    status: "completed",
                    result: "done",
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                  },
                },
              ],
            });
            const command = {
              type: "message.dispatch" as const,
              commandId: CommandId.make("completion"),
              threadId,
              messageId,
              text: "Child completed",
              attachments: [],
              dispatchMode: { type: "queue_after_active" as const },
              createdBy: "agent" as const,
              creationSource: "server" as const,
              delegatedCompletion: { parentRunId: parent.id, generation: 1, taskIds: [taskId] },
            };
            yield* orchestrator.dispatch(command);
            yield* orchestrator.dispatch(command);
            yield* orchestrator.recoverDelegatedTasks;
          } else if (delivery === "scheduled message") {
            yield* Effect.gen(function* () {
              const service = yield* ScheduledTaskService.ScheduledTaskService;
              const { task } = yield* service.upsert(
                yield* decodeScheduledTask({
                  title: "Status check",
                  prompt: "Check the four tasks.",
                  enabled: true,
                  schedule: { type: "interval", everyMs: 60_000 },
                  projectId,
                  threadId,
                  workspaceStrategy: { type: "root" },
                  modelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                }),
              );
              const ran = yield* service.runNow({ id: task.id });
              assert.equal(ran.task.lastRunStatus, "running");
            }).pipe(
              Effect.provide(
                ScheduledTaskService.layer.pipe(
                  Layer.provide(ThreadManagementService.layer),
                  Layer.provide(ServerSettings.layerTest()),
                  Layer.provide(
                    Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
                      ensureTranscript: () =>
                        Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
                    }),
                  ),
                  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
                  Layer.provide(
                    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                      namedProjectsRoot: "/projects",
                      isScratchProject: () => Effect.succeed(false),
                    }),
                  ),
                  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
                  Layer.provide(
                    CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
                  ),
                  Layer.provide(
                    Layer.mergeAll(
                      NodeCrypto.layer,
                      Scheduler.layer,
                      SqlitePersistence.layerMemory,
                    ),
                  ),
                ),
              ),
            );
          } else if (delivery === "user steering") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("steer"),
              threadId,
              messageId,
              text: "Change direction now.",
              attachments: [],
              dispatchMode: { type: "steer_active", targetRunId: parent.id },
              createdBy: "user",
              creationSource: "web",
            });
          } else {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("queue"),
              threadId,
              messageId,
              text: "Change direction now.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
            yield* orchestrator.dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("promote"),
              threadId,
              queuedRunId: queuedRun.id,
              targetRunId: parent.id,
            });
            // Promotion cancels the queued run and moves its message into the
            // running run as a steer that remembers where it came from.
            const promoted = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(promoted.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
            assert.equal(
              promoted.messages.find((message) => message.id === messageId)?.runId,
              parent.id,
            );
            const steer = promoted.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === messageId,
            );
            assert.ok(steer?.type === "user_message");
            assert.equal(steer.inputIntent, "promoted_queued_to_steer");
          }
          yield* worker.drain();
          const steered = delivery !== "scheduled message";
          assert.isFalse(batchAbort.signal.aborted);
          if (!steered) assert.lengthOf(offers, 1);
          const finished = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === parent.id &&
              event.payload.status === "waiting",
          );
          yield* Queue.offer(sdkMessages, toolResult("build", false));
          for (const id of statusIds)
            yield* Queue.offer(sdkMessages, toolResult(id, batchAbort.signal.aborted));
          yield* Queue.offer(
            sdkMessages,
            frame({
              ...result("original-completed", false),
              user_message_uuids: initialPrompt.uuid === undefined ? [] : [initialPrompt.uuid],
            }),
          );
          if (steered) {
            // The fake SDK must finish the accepted input too; its original
            // result alone cannot settle the enclosing steered provider turn.
            const offered = yield* Queue.take(offeredMessages);
            assert.include(
              JSON.stringify(offered.message.content),
              delivery === "child completion" ? "done" : "Change direction now.",
            );
            assert.notEqual(offered.priority, "now");
            yield* Queue.offer(
              sdkMessages,
              frame({
                ...result("steer-completed", false),
                user_message_uuids: offered.uuid === undefined ? [] : [offered.uuid],
              }),
            );
          }
          yield* Fiber.join(finished);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          if (!steered) {
            const queued = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
            const noticeFinished = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === queued.id &&
                event.payload.status === "waiting",
            );
            yield* Queue.offer(sdkMessages, result("notice-completed", false));
            yield* Fiber.join(noticeFinished);
            yield* worker.drain();
          }
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(after.runs.find((run) => run.id === parent.id)?.status, "completed");
          assert.equal(after.providerTurns.length, steered ? 1 : 2);
          const build = after.turnItems.find((item) => item.nativeItemRef?.nativeId === "build");
          assert.equal(build?.status, "completed");
          assert.equal(build?.type === "command_execution" && build.output, "build OK");
          const reads = after.turnItems.filter((item) =>
            statusIds.includes(item.nativeItemRef?.nativeId ?? ""),
          );
          assert.equal(reads.length, 4);
          for (const read of reads) {
            assert.equal(read.status, "completed");
            assert.isUndefined(read.toolNonExecutionKind);
            assert.isFalse(read.type === "dynamic_tool" && read.output === refusal);
          }
          assert.equal(offers.length, 2);
          assert.equal(offers.filter((offer) => offer.priority === "now").length, 0);
          if (delivery === "child completion") {
            assert.equal(after.runs.length, 1);
            assert.equal(after.messages.filter((message) => message.id === messageId).length, 1);
            assert.equal(after.subagents[0]?.completionDelivery?.state, "delivered");
          } else if (!steered) {
            assert.equal(after.runs.length, 2);
            assert.equal(
              after.messages.filter((message) => message.scheduledTaskId !== undefined).length,
              1,
            );
          }
          yield* orchestrator.recoverDelegatedTasks;
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          assert.equal(offers.length, 2);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "claude-automatic-delivery" },
              ProviderAdapterRegistry.layerSingle(adapter),
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
);

it.effect.each([
  ...(["exhausted", "network", "silent", "after-access"] as const).flatMap((shape) =>
    [false, true].map((failAgain) => ({
      shape,
      failAgain,
      sdkStatus: null,
      networkText: "",
      terminalReason: "api_error" as const,
    })),
  ),
  ...[undefined, null, 404].flatMap((syntheticStatus) =>
    [false, true].flatMap((failAgain) =>
      [false, true].flatMap((retryFirst) =>
        [false, true].flatMap((health) =>
          (retryFirst ? [true] : [true, false]).map((nativeFirst) => ({
            shape: "synthetic-network" as const,
            failAgain,
            sdkStatus: null,
            networkText: "",
            terminalReason: "api_error" as const,
            syntheticStatus,
            retryFirst,
            health,
            nativeFirst,
          })),
        ),
      ),
    ),
  ),
  ...[400, 413, 418].flatMap((sdkStatus) =>
    ["Request timed out.", "Connection dropped (ECONNRESET)"].map((networkText) => ({
      shape: "permanent" as const,
      failAgain: false,
      sdkStatus,
      networkText,
      terminalReason: "api_error" as const,
    })),
  ),
  ...(["prompt_too_long", "blocking_limit"] as const).flatMap((terminalReason) =>
    ["Request timed out.", "Connection dropped (ECONNRESET)"].map((networkText) => ({
      shape: "context" as const,
      failAgain: false,
      sdkStatus: null,
      networkText,
      terminalReason,
    })),
  ),
  ...[400, 401, 403, 413, 418, 429].flatMap((sdkStatus) =>
    ["Request timed out.", "Connection dropped (ECONNRESET)"].flatMap((networkText) =>
      ["api_error", "missing", "execution", "synthetic-404"].flatMap((terminal) =>
        [false, true].map((generic) => ({
          shape: "native-sdk" as const,
          failAgain: false,
          sdkStatus,
          networkText,
          generic,
          terminalReason:
            terminal === "api_error" || terminal === "synthetic-404"
              ? ("api_error" as const)
              : null,
          terminalApiStatus: terminal === "synthetic-404" ? 404 : null,
          terminalSubtype: terminal === "execution" ? "error_during_execution" : "success",
        })),
      ),
    ),
  ),
  ...[400, 413].flatMap((sdkStatus) =>
    ["Request timed out.", "Connection dropped (ECONNRESET)"].flatMap((networkText) =>
      ["[Watcher event from build] Ready", "Please relay: ready"].map((relayText) => ({
        shape: "native-sdk" as const,
        failAgain: false,
        sdkStatus,
        networkText,
        relayText,
        generic: true,
        terminalReason: "api_error" as const,
        terminalApiStatus: null,
        terminalSubtype: "success",
      })),
    ),
  ),
  ...[
    "usage limit reached",
    "quota exceeded",
    "authentication failed",
    "invalid api key",
    "401 unauthorized",
    "403 forbidden",
    "429 rate limit",
    "model not found",
    "502 upstream 429 quota exceeded",
  ].map((networkText) => ({
    shape: "native-permanent" as const,
    failAgain: false,
    sdkStatus: null,
    networkText,
    terminalReason: "api_error" as const,
  })),
])(
  "handles $shape delegated recovery (second: $failAgain, SDK: $sdkStatus, text: $networkText, reason: $terminalReason, subtype: $terminalSubtype, status: $terminalApiStatus, generic: $generic, synthetic: $syntheticStatus, retry: $retryFirst, native first: $nativeFirst, health: $health, relay: $relayText)",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { shape, failAgain, sdkStatus, networkText, terminalReason } = scenario;
        const selection =
          shape === "after-access"
            ? { ...modelSelection, model: "claude-sonnet-5-5" }
            : modelSelection;
        const cwd = yield* checkpointWorkspace("claude-delegated-recovery");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configDir = yield* fs.makeTempDirectoryScoped();
        const queues = new Map<string, Queue.Queue<SDKMessage>>();
        const offers: Array<{ session: string; message: SDKUserMessage }> = [];
        const healthInterrupts: string[] = [];
        let sessionOrdinal = 0;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: modelSelection.instanceId,
          settings,
          environment: { CLAUDE_CONFIG_DIR: configDir },
          attachmentsDir: cwd,
          fileSystem: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.sync(() => `recovery-session-${++sessionOrdinal}`),
            open: (input) =>
              Effect.gen(function* () {
                const session = input.options.resume ?? input.options.sessionId!;
                const queue = yield* Queue.unbounded<SDKMessage>();
                queues.set(session, queue);
                return {
                  messages: Stream.fromQueue(queue),
                  offer: (message: SDKUserMessage) =>
                    Effect.sync(() => {
                      offers.push({ session, message });
                    }),
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.sync(() => {
                    healthInterrupts.push(session);
                  }),
                  close: Queue.shutdown(queue),
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const parentId = ThreadId.make("thread:recovery-parent");
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("recovery-create"),
            threadId: parentId,
            projectId: ProjectId.make("project:recovery"),
            title: "Recovery",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            worktreePath: cwd,
            branch: null,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("recovery-parent-start"),
            threadId: parentId,
            messageId: MessageId.make("recovery-parent-start"),
            text: "Delegate work",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          const parent = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make("recovery-child"),
            parentThreadId: parentId,
            parentRunId: parent.id,
            parentNodeId: parent.rootNodeId!,
            task:
              "relayText" in scenario && typeof scenario.relayText === "string"
                ? scenario.relayText
                : "Write the file",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* worker.drain();
          const task = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!;
          const childId = task.childThreadId!;
          const before = yield* orchestrator.getThreadProjection(childId);
          const guard =
            shape === "silent"
              ? yield* DelegatedTaskProgressGuard.DelegatedTaskProgressGuard.pipe(
                  Effect.provide(DelegatedTaskProgressGuard.layer),
                )
              : undefined;
          if (guard !== undefined)
            yield* guard.handle({
              id: EventId.make("guard-silent-child"),
              type: "run.updated",
              threadId: childId,
              runId: before.runs[0]!.id,
              occurredAt: yield* DateTime.now,
              payload: before.runs[0]!,
            });
          const nativeId = before.providerThreads[0]!.nativeThreadRef!.nativeId;
          if (nativeId === null) return yield* Effect.die("child has no native session");
          let queue = queues.get(nativeId)!;
          if (shape === "after-access") {
            const accessRecovery = yield* watch(
              (event) =>
                event.threadId === childId &&
                event.type === "run.updated" &&
                event.payload.launchRecovery?.kind === "model_access",
            );
            yield* Queue.offer(
              queue,
              frame({
                ...result("access-failure", false),
                session_id: nativeId,
                is_error: true,
                terminal_reason: "api_error",
                api_error_status: 401,
                result: "API Error: 401 unauthorized",
              }),
            );
            yield* Fiber.join(accessRecovery);
            const draining = yield* worker.drain().pipe(Effect.forkScoped);
            yield* TestClock.adjust("40 seconds");
            yield* Fiber.join(draining);
            const recovered = yield* orchestrator.getThreadProjection(childId);
            assert.lengthOf(recovered.attempts, 2);
            assert.equal(recovered.runs[0]?.launchRecovery?.kind, "model_access");
            assert.isUndefined(recovered.runs[0]?.transientRecovery);
            assert.equal(recovered.providerThreads[0]?.nativeThreadRef?.nativeId, nativeId);
            queue = queues.get(nativeId)!;
            const toolCompleted = yield* watch(
              (event) =>
                event.threadId === childId &&
                event.type === "turn-item.updated" &&
                event.payload.type === "command_execution" &&
                event.payload.status === "completed",
            );
            yield* Queue.offerAll(queue, [
              frame({
                type: "assistant",
                uuid: "response-after-access",
                session_id: nativeId,
                parent_tool_use_id: null,
                message: {
                  id: "tool-after-access",
                  role: "assistant",
                  type: "message",
                  model: selection.model,
                  content: [
                    { type: "tool_use", id: "build", name: "Bash", input: { command: "make" } },
                  ],
                  stop_reason: "tool_use",
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              }),
              frame({ ...toolResult("build", false), session_id: nativeId }),
            ]);
            yield* Fiber.join(toolCompleted);
          }
          if (
            shape === "permanent" ||
            shape === "context" ||
            shape === "native-sdk" ||
            shape === "native-permanent"
          ) {
            const completedEnvelope =
              scenario.shape === "native-sdk" &&
              scenario.terminalReason === null &&
              scenario.terminalSubtype === "success";
            const terminal = yield* watch(
              (event) =>
                event.threadId === childId &&
                event.type === "run.updated" &&
                event.payload.status === (completedEnvelope ? "waiting" : "failed"),
            );
            if (shape !== "permanent") {
              const dir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
              yield* fs.makeDirectory(dir, { recursive: true });
              yield* fs.writeFileString(
                path.join(dir, `${nativeId}.jsonl`),
                JSON.stringify({
                  type: "system",
                  subtype: "api_error",
                  timestamp: DateTime.formatIso(yield* DateTime.now),
                  error: { message: networkText, connection: null },
                  source: "request_retry",
                }) + "\n",
              );
            }
            const terminalMessage = {
              ...result("statusless-network-terminal", false),
              ...(scenario.shape === "native-sdk" ? { subtype: scenario.terminalSubtype } : {}),
              session_id: nativeId,
              is_error: true,
              terminal_reason: terminalReason,
              api_error_status: scenario.shape === "native-sdk" ? scenario.terminalApiStatus : null,
              result: `API Error: ${networkText}`,
              errors: [networkText],
            };
            if (terminalReason === null) Reflect.deleteProperty(terminalMessage, "terminal_reason");
            yield* Queue.offerAll(queue, [
              ...(shape === "native-permanent"
                ? []
                : [
                    frame({
                      type: "system",
                      subtype: "api_retry",
                      attempt: 1,
                      max_retries: 10,
                      retry_delay_ms: 602,
                      error: "unknown",
                      error_status: sdkStatus,
                      session_id: nativeId,
                      uuid: "permanent-sdk-retry",
                    }),
                  ]),
              ...(scenario.shape === "native-sdk" && scenario.generic
                ? [
                    frame({
                      type: "system",
                      subtype: "api_retry",
                      attempt: 2,
                      max_retries: 10,
                      retry_delay_ms: 602,
                      error: "unknown",
                      error_status: null,
                      session_id: nativeId,
                      uuid: "generic-after-permanent",
                    }),
                  ]
                : []),
              frame(terminalMessage),
            ]);
            yield* Fiber.join(terminal);
            yield* worker.drain();
            const after = yield* orchestrator.getThreadProjection(childId);
            assert.lengthOf(after.attempts, 1);
            assert.lengthOf(
              offers.filter((offer) => offer.session === nativeId),
              1,
            );
            assert.isUndefined(after.runs[0]?.transientRecovery);
            if (completedEnvelope) {
              assert.equal(after.runs[0]?.status, "completed");
              return;
            }
            const failure = after.turnItems.findLast(
              (item) => item.type === "error" && item.status === "failed",
            );
            if (shape === "native-permanent") {
              assert.equal(failure?.type === "error" ? failure.failure.category : "", "unknown");
              assert.include(failure?.type === "error" ? failure.failure.message : "", networkText);
            } else if (
              scenario.shape === "native-sdk" &&
              (scenario.generic ||
                (scenario.terminalApiStatus === 404 &&
                  [401, 403, 429].includes(scenario.sdkStatus)))
            ) {
              assert.equal(
                failure?.type === "error" ? failure.failure.code : "",
                "claude_network_error",
              );
              assert.isFalse(failure?.type === "error" ? failure.failure.retryable : true);
            } else
              assert.equal(
                failure?.type === "error" ? failure.failure.code : "",
                shape === "context" ? terminalReason : `api_error_${sdkStatus}`,
              );
            if (shape === "context")
              assert.equal(
                failure?.type === "error" ? failure.failure.category : "",
                "context_exhausted",
              );
            return;
          }
          const recovering = yield* watch(
            (event) =>
              event.threadId === childId &&
              event.type === "run.updated" &&
              event.payload.transientRecovery !== undefined,
          );
          let firstHealthCheck = true;
          const checkHealth = Effect.gen(function* () {
            if (guard !== undefined && firstHealthCheck) {
              firstHealthCheck = false;
              yield* TestClock.adjust("5 minutes");
              yield* guard.check();
              assert.lengthOf(healthInterrupts, 1);
              // Delay the guard's run events until after the old fifteen-minute deadline.
              yield* TestClock.adjust("10 minutes");
              yield* guard.check();
              assert.lengthOf(healthInterrupts, 1);
              return;
            }
            const current = yield* orchestrator.getThreadProjection(childId);
            const provider = current.providerThreads[0]!;
            const runtime = yield* (yield* ProviderSessionManager.ProviderSessionManagerV2).get(
              provider.providerSessionId!,
            );
            assert.isTrue(Option.isSome(runtime));
            if (Option.isNone(runtime)) return;
            yield* TestClock.adjust("5 minutes");
            assert.isTrue(
              yield* runtime.value.checkRetryHealth!({
                runId: current.runs[0]!.id,
                attemptId: current.runs[0]!.activeAttemptId,
                noResponseBudgetMs: 300_000,
                flapLimit: 20,
              }),
            );
          });
          if (scenario.shape === "synthetic-network") {
            const syntheticProcessed = yield* watch(
              (event) =>
                event.threadId === childId &&
                event.type === "turn-item.updated" &&
                event.payload.nativeItemRef?.nativeId === "synthetic-model-error",
            );
            const dir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
            yield* fs.makeDirectory(dir, { recursive: true });
            yield* fs.writeFileString(
              path.join(dir, `${nativeId}.jsonl`),
              JSON.stringify({
                type: "system",
                subtype: "api_error",
                timestamp: DateTime.formatIso(yield* DateTime.now),
                error: {
                  message: "Connection dropped (ECONNRESET)",
                  connection: { code: "ECONNRESET" },
                },
              }) + "\n",
            );
            const file = path.join(dir, `${nativeId}.jsonl`);
            if (!scenario.nativeFirst) yield* fs.rename(file, `${file}.unavailable`);
            yield* Queue.offerAll(queue, [
              ...(scenario.retryFirst
                ? [
                    frame({
                      type: "system",
                      subtype: "api_retry",
                      attempt: 1,
                      max_retries: 10,
                      retry_delay_ms: 602,
                      error: "unknown",
                      error_status: null,
                      session_id: nativeId,
                      uuid: "reset-retry",
                    }),
                  ]
                : []),
              frame({
                type: "assistant",
                uuid: "synthetic-model-error",
                session_id: nativeId,
                parent_tool_use_id: null,
                error: "model_not_found",
                ...(scenario.syntheticStatus === undefined
                  ? {}
                  : { api_error_status: scenario.syntheticStatus }),
                message: {
                  id: "synthetic",
                  role: "assistant",
                  type: "message",
                  model: "<synthetic>",
                  content: [{ type: "text", text: "There's an issue with the selected model" }],
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              }),
            ]);
            yield* Fiber.join(syntheticProcessed);
            if (!scenario.nativeFirst) yield* fs.rename(`${file}.unavailable`, file);
          }
          const healthCutoff =
            shape === "silent" ||
            shape === "after-access" ||
            (scenario.shape === "synthetic-network" && scenario.health);
          if (healthCutoff) yield* checkHealth;
          else
            yield* Queue.offer(
              queue,
              frame({
                ...result("exhausted-first", false),
                session_id: nativeId,
                is_error: true,
                terminal_reason: "api_error",
                api_error_status: shape === "network" || shape === "synthetic-network" ? null : 529,
                result:
                  shape === "network" || shape === "synthetic-network"
                    ? "API Error: Connection dropped (ECONNRESET)"
                    : "API Error: 529 overloaded_error",
              }),
            );
          yield* Fiber.join(recovering);
          const draining = yield* worker.drain().pipe(Effect.forkScoped);
          yield* TestClock.adjust(1000);
          yield* Fiber.join(draining);
          const resumed = yield* orchestrator.getThreadProjection(childId);
          assert.equal(resumed.providerThreads[0]?.nativeThreadRef?.nativeId, nativeId);
          assert.deepEqual(resumed.runs[0]?.modelSelection, before.runs[0]?.modelSelection);
          const expectedAttempts = shape === "after-access" ? 3 : 2;
          assert.lengthOf(resumed.attempts, expectedAttempts);
          if (guard !== undefined) {
            assert.lengthOf(healthInterrupts, 1);
            assert.isUndefined(resumed.runs[0]?.delegatedTaskStallRecovery);
          }
          assert.lengthOf(
            offers.filter((offer) => offer.session === nativeId),
            expectedAttempts,
          );
          const terminal = yield* watch(
            (event) =>
              event.threadId === childId &&
              event.type === "run.updated" &&
              event.payload.status === (failAgain ? "failed" : "waiting"),
          );
          if (healthCutoff && failAgain) yield* checkHealth;
          else
            yield* Queue.offer(
              queues.get(nativeId)!,
              frame({
                ...result("resumed-result", false),
                session_id: nativeId,
                ...(failAgain
                  ? {
                      is_error: true,
                      terminal_reason: "api_error",
                      api_error_status: 502,
                      result: "API Error: 502 connection reset",
                    }
                  : {}),
              }),
            );
          yield* Fiber.join(terminal);
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(childId);
          assert.lengthOf(after.attempts, expectedAttempts);
          assert.lengthOf(
            offers.filter((offer) => offer.session === nativeId),
            expectedAttempts,
          );
          if (failAgain) {
            const failure = after.turnItems
              .filter((item) => item.type === "error")
              .toSorted((a, b) => b.ordinal - a.ordinal)[0];
            assert.include(
              failure?.type === "error" ? failure.failure.message : "",
              "First error:",
            );
            assert.include(
              failure?.type === "error" ? failure.failure.message : "",
              healthCutoff ? "no response for 5 min" : "502",
            );
          } else assert.equal(after.runs[0]?.status, "completed");
        }).pipe(
          Effect.provide(
            ThreadManagementService.layer.pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  ProviderReplayHarness.layerWithRegistry(
                    { name: "claude-delegated-recovery" },
                    ProviderAdapterRegistry.layerSingle(adapter),
                    { runEffectWorker: false },
                  ),
                  CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
                  ServerSettings.layerTest(),
                ),
              ),
            ),
          ),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
);

it.effect("restarts a running Claude delegated child with interrupt and next-turn delivery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("claude-child-restart");
      const offers: Array<{ session: string; message: SDKUserMessage }> = [];
      const interrupted: string[] = [];
      let sessionOrdinal = 0;
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment: {},
        attachmentsDir: cwd,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.sync(() => `restart-session-${++sessionOrdinal}`),
          open: (input) =>
            Effect.gen(function* () {
              const session = input.options.resume ?? input.options.sessionId!;
              const messages = yield* Queue.unbounded<SDKMessage>();
              return {
                messages: Stream.fromQueue(messages),
                offer: (message: SDKUserMessage) =>
                  Effect.sync(() => {
                    offers.push({ session, message });
                  }),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                stopTask: () => Effect.void,
                interrupt: Effect.sync(() => {
                  interrupted.push(session);
                }),
                close: Queue.shutdown(messages),
              };
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const projectId = ProjectId.make("project:claude-child-restart");
        const parentId = ThreadId.make("thread:claude-child-restart-parent");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("restart-parent-create"),
          threadId: parentId,
          projectId,
          title: "Restart parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          worktreePath: cwd,
          branch: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart-parent-start"),
          threadId: parentId,
          messageId: MessageId.make("restart-parent-start"),
          text: "Delegate work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const parent = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
        const childRunning = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.threadId.startsWith("thread:delegated-task:") &&
              event.type === "provider-turn.updated" &&
              event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("restart-child"),
          parentThreadId: parentId,
          parentRunId: parent.id,
          parentNodeId: parent.rootNodeId!,
          task: "Write the file",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(childRunning);
        const task = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!;
        const threadId = task.childThreadId!;
        assert.include(threadId, "thread:delegated-task:");
        const before = yield* orchestrator.getThreadProjection(threadId);
        const activeRun = before.runs[0]!;
        assert.equal(activeRun.status, "running");
        const providerThread = before.providerThreads.find(
          (t) => t.id === activeRun.providerThreadId,
        )!;
        const session = before.providerSessions.find(
          (s) => s.id === providerThread.providerSessionId,
        )!;
        assert.equal(session.capabilities.turns.supportsInterrupt, true);
        assert.equal(session.capabilities.turns.supportsSteeringByInterruptRestart, false);
        const input = {
          projectId,
          threadId,
          senderThreadId: parentId,
          commandId: CommandId.make("restart-child-send"),
          messageId: MessageId.make("restart-child-send"),
          text: "Use the corrected facts",
          attachments: [],
          mode: "restart" as const,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
        };
        const stopped = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === activeRun.id &&
              event.payload.status === "interrupted",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const restarted = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.threadId === threadId &&
              event.type === "run.updated" &&
              event.payload.ordinal === 2 &&
              event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const sent = yield* service.sendToThread(input);
        assert.equal(sent.delivery, "restarted");
        assert.isNotTrue(sent.run.queueHeld);
        yield* worker.drain();
        yield* Fiber.join(stopped);
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        yield* Fiber.join(restarted);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.find((r) => r.id === activeRun.id)?.status, "interrupted");
        assert.lengthOf(after.runs, 2);
        const next = after.runs.find((r) => r.id === sent.run.id)!;
        assert.notEqual(next.id, activeRun.id);
        assert.equal(next.status, "running");
        assert.lengthOf(interrupted, 1);
        assert.equal(interrupted[0], providerThread.nativeThreadRef?.nativeId);
        const childOffers = offers.filter((o) => o.session === interrupted[0]);
        assert.lengthOf(childOffers, 2);
        assert.include(JSON.stringify(childOffers[1]!.message.message.content), input.text);
        assert.lengthOf(
          after.messages.filter((m) => m.id === input.messageId),
          1,
        );
        const replay = yield* service.sendToThread(input);
        assert.equal(replay.delivery, "restarted");
        assert.equal(replay.run.id, next.id);
        yield* worker.drain();
        assert.lengthOf(interrupted, 1);
        assert.lengthOf(
          offers.filter((o) => o.session === interrupted[0]),
          2,
        );
      }).pipe(
        Effect.provide(
          ThreadManagementService.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ProviderReplayHarness.layerWithRegistry(
                  { name: "claude-child-restart" },
                  ProviderAdapterRegistry.layerSingle(adapter),
                  { runEffectWorker: false },
                ),
                CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
                ServerSettings.layerTest(),
              ),
            ),
          ),
        ),
      );
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
    ),
  ),
);
