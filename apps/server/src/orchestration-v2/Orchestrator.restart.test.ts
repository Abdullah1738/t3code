import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

it.effect.each([false, true])(
  "restarts or preserves the capability rejection through receipt replay (interrupt=%s)",
  (interrupt) => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const modelSelection = { instanceId, model: "test" };
    const threadId = ThreadId.make("thread:restart-rejection");
    const projectId = ProjectId.make("project:restart-rejection");
    const sessionId = ProviderSessionId.make("session:restart-rejection");
    const capabilities = {
      ...ClaudeProviderCapabilitiesV2,
      turns: { ...ClaudeProviderCapabilitiesV2.turns, supportsInterrupt: interrupt },
    };
    const adapter = {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      getCapabilities: () => Effect.succeed(capabilities),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () =>
        DateTime.now.pipe(
          Effect.map(
            (now) =>
              ({
                instanceId,
                driver: ProviderDriverKind.make("claudeAgent"),
                providerSessionId: sessionId,
                providerSession: {
                  id: sessionId,
                  driver: ProviderDriverKind.make("claudeAgent"),
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd: process.cwd(),
                  model: "test",
                  capabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.never,
                close: () => Effect.void,
              }) as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          ),
        ),
    } as ProviderAdapter.ProviderAdapterV2["Service"];
    const database = Sqlite.layerMemory;
    const runtime = Harness.layerWithRegistry(
      { name: "restart-rejection" },
      Registry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    );
    const stores = Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provide(database)),
      CommandReceiptStore.layer.pipe(Layer.provide(database)),
    );
    const layer = ThreadManagementService.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(runtime, stores, ServerSettings.layerTest())),
    );
    return Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const management = yield* ThreadManagementService.ThreadManagementService;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("restart-rejection:create"),
        threadId,
        projectId,
        title: "Restart",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("restart-rejection:initial"),
        threadId,
        messageId: MessageId.make("restart-rejection:initial"),
        text: "initial",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* sessions.open({
        threadId,
        providerSessionId: sessionId,
        modelSelection,
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        },
      });
      const before = yield* engine.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const now = yield* DateTime.now;
      const providerThread = before.providerThreads[0]!;
      yield* projections.apply({
        id: EventId.make("restart-rejection:binding"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: { ...providerThread, providerSessionId: sessionId },
      });
      yield* projections.apply({
        id: EventId.make("restart-rejection:running"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...run, status: "running" },
      });
      yield* projections.apply({
        id: EventId.make("restart-rejection:turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make("turn:restart-rejection"),
          providerThreadId: providerThread.id,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId!,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      const input = {
        projectId,
        threadId,
        commandId: CommandId.make("restart-rejection:send"),
        messageId: MessageId.make("restart-rejection:send"),
        mode: "restart" as const,
        text: "replacement",
        attachments: [],
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      if (interrupt) {
        const first = yield* management.sendToThread(input);
        assert.equal(first.delivery, "restarted");
        assert.notEqual(first.run.id, run.id);
        const accepted = yield* receipts.getByCommandId(input.commandId);
        assert.isTrue(Option.isSome(accepted) && accepted.value.status === "accepted");
        const interrupted = yield* receipts.getByCommandId(
          CommandId.make(`${input.commandId}:restart-interrupt`),
        );
        assert.isTrue(Option.isSome(interrupted) && interrupted.value.status === "accepted");
        const sequence = yield* engine.getThreadEventSequence(threadId);
        assert.equal((yield* management.sendToThread(input)).delivery, "restarted");
        assert.equal(yield* engine.getThreadEventSequence(threadId), sequence);
        assert.lengthOf((yield* engine.getThreadProjection(threadId)).messages, 2);
        return;
      }
      const reason =
        "Claude cannot restart an active run. Use t3_thread_interrupt, then send the message.";
      const first = yield* management.sendToThread(input).pipe(Effect.flip);
      assert.equal(userFacingDispatchErrorMessage(first), reason);
      const receipt = yield* receipts.getByCommandId(input.commandId);
      assert.isTrue(Option.isSome(receipt));
      if (Option.isSome(receipt)) assert.equal(receipt.value.error, reason);
      const activeRetry = yield* management.sendToThread(input).pipe(Effect.flip);
      assert.include(userFacingDispatchErrorMessage(activeRetry), `previously rejected: ${reason}`);
      yield* projections.apply({
        id: EventId.make("restart-rejection:completed"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      const retry = yield* management.sendToThread(input).pipe(Effect.flip);
      assert.include(userFacingDispatchErrorMessage(retry), `previously rejected: ${reason}`);
      assert.notInclude(retry.message, "Failed to dispatch orchestration command");
      assert.lengthOf((yield* engine.getThreadProjection(threadId)).messages, 1);
    }).pipe(Effect.provide(layer));
  },
);
