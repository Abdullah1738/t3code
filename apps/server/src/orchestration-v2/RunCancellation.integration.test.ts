import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { assert, it } from "@effect/vitest";
import {
  type AnalyticsEvent,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };

it.effect.each(
  (["cancelled", "interrupted"] as const).flatMap((status) =>
    (
      [
        "user_stop",
        "task_cancel",
        "thread_reset",
        "card_stop",
        "delegated_parent_cancelled",
        "superseded",
        "task_stalled",
        "thread_archive",
      ] as const
    ).map((cancelReason) => ({ status, cancelReason })),
  ),
)("records native $status usage during $cancelReason cleanup", ({ status, cancelReason }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const key = `${status}-${cancelReason}`;
      const cwd = yield* checkpointWorkspace(`cancel-provenance-${key}`);
      const threadId = ThreadId.make(`thread:cancel-provenance:${key}`);
      const submitted = yield* Deferred.make<void>();
      const registered = yield* Deferred.make<void>();
      const usageEmitted = yield* Deferred.make<void>();
      const rows: AnalyticsEvent[] = [];
      let interruptCount = 0;
      const archive = cancelReason === "thread_archive";
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (sessionInput) =>
          Effect.gen(function* () {
            const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            const now = yield* DateTime.now;
            let active: ProviderAdapter.ProviderAdapterV2TurnInput | undefined;
            const register = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
              PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`${key}:turn`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: null,
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
            const end = Effect.gen(function* () {
              const turn = active;
              assert.isDefined(turn);
              interruptCount += 1;
              if (!archive) yield* register(turn);
              yield* PubSub.publish(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId: ProviderTurnId.make(`${key}:turn`),
                runOrdinal: turn.runOrdinal,
                status,
                failure: null,
                threadDisposition: "reusable",
              });
              // Require usage to finish before early Stop can commit its request.
              yield* Deferred.await(usageEmitted);
            });
            const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
              instanceId,
              driver,
              providerSessionId: sessionInput.providerSessionId,
              providerSession: {
                id: sessionInput.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromPubSub(events),
              ensureThread: (input) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`${key}:provider-thread`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: sessionInput.providerSessionId,
                  appThreadId: input.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: key, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  contextUsage: null,
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (input) =>
                Effect.gen(function* () {
                  active = input;
                  if (archive) yield* register(input);
                  yield* Deferred.succeed(submitted, undefined);
                }),
              interruptStartingRun: () => end,
              interruptTurn: () => end,
              steerTurn: () => Effect.die("unused steer"),
              respondToRuntimeRequest: () => Effect.die("unused response"),
              readThreadSnapshot: () => Effect.die("unused snapshot"),
              rollbackThread: () => Effect.die("unused rollback"),
              forkThread: () => Effect.die("unused fork"),
            };
            return runtime;
          }),
      };
      const layer = ProviderReplayHarness.layerWithRegistry(
        { name: `cancel-provenance-${key}` },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { runEffectWorker: false },
      ).pipe(
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: (row) =>
              Effect.gen(function* () {
                rows.push(row);
                if ("runId" in row && row.kind === "run.usage")
                  yield* Deferred.succeed(usageEmitted, undefined);
              }),
          }),
        ),
      );
      const layerMcp = OrchestratorMcpService.layer.pipe(
        Layer.provide(McpProviderSessions.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            layer,
            ThreadManagementService.layer.pipe(
              Layer.provide(layer),
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(Sqlite.layerMemory))),
            ),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            ProviderAdapterRegistry.layerFromAdapters([adapter]),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            ServerSettings.layerTest(),
            NodeServices.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${key}:create`),
          threadId,
          projectId: ProjectId.make(`${key}:project`),
          title: key,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${key}:send`),
          threadId,
          messageId: MessageId.make(`${key}:message`),
          text: "Keep working until stopped.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        yield* engine.streamDomainEvents.pipe(
          Stream.runForEach((event) =>
            event.type === "provider-turn.updated" && event.payload.status === "running"
              ? Deferred.succeed(registered, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* worker.drain();
        yield* Deferred.await(submitted);
        if (archive) yield* Deferred.await(registered);
        const before = yield* engine.getThreadProjection(threadId);
        const run = before.runs[0]!;
        assert.equal(run.status, "running");
        assert.equal(before.providerTurns.length, archive ? 1 : 0);
        if (cancelReason === "user_stop") {
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const response = yield* mcp.interruptThread(
            {
              environmentId: EnvironmentId.make(`environment:${key}`),
              requestNamespace: key,
              thread: { threadId, providerSessionId: key, providerInstanceId: instanceId },
              client: undefined,
              capabilities: new Set(["orchestration"]),
              issuedAt: 1,
            },
            { threadId, runId: run.id, reason: "Requested by the caller." },
          );
          assert.deepInclude(response, {
            runId: run.id,
            status: "interrupt_requested",
            cancelReason: "user_stop",
            cancelDetail: "Requested by the caller.",
          });
          assert.isTrue(yield* Deferred.isDone(usageEmitted));
        } else
          yield* engine.dispatch(
            archive
              ? { type: "thread.archive", commandId: CommandId.make(`${key}:archive`), threadId }
              : {
                  type: "run.interrupt",
                  commandId: CommandId.make(`${key}:stop`),
                  threadId,
                  runId: run.id,
                  cancelReason,
                  reason: "Requested by the caller.",
                },
          );
        yield* worker.drain();
        yield* Deferred.await(usageEmitted);
        const after = yield* engine.getThreadProjection(threadId);
        assert.equal(after.runs[0]?.status, status);
        assert.equal(after.runs[0]?.cancelReason, cancelReason);
        assert.equal(interruptCount, 1);
        const usage = rows.filter((row) => "runId" in row && row.kind === "run.usage");
        assert.lengthOf(usage, 1);
        const row = usage[0]!;
        if (!("runId" in row)) return assert.fail("Missing usage event");
        assert.equal(row.cancelReason, cancelReason);
        assert.equal(row.endReason, status);
      }).pipe(Effect.provide(layerMcp));
    }),
  ),
);
