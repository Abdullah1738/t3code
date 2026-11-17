import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-6.1-sol" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Recovery tests must never start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = Sqlite.layerMemory;
const layer = Layer.mergeAll(
  database,
  Receipts.layer.pipe(Layer.provide(database)),
  Harness.layerWithRegistry(
    { name: "timeout-recovery-planning" },
    Registry.layerFromAdapters([adapter]),
    {
      databaseLayer: database,
      runEffectWorker: false,
    },
  ),
);

it.effect.each(["startup", "in_process", "ordinary"] as const)(
  "recovers after a real notification planning read fails: %s",
  (scenario) =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const receipts = yield* Receipts.CommandReceiptStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const parent = ThreadId.make("thread:timeout-planning-recovery");
      const commandId = CommandId.make("command:unsaved-create");
      const requestKey = "unsaved";
      const wakeId = `delegation-create-failure:${encodeURIComponent(parent)}:${requestKey}`;
      const wakeCommandId = CommandId.make(`command:${wakeId}`);
      const failed = yield* Deferred.make<void>();
      let attempts = 0;
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:create-parent"),
        threadId: parent,
        projectId: ProjectId.make("project:timeout-planning-recovery"),
        title: "Recovery parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const wrapped: typeof engine = {
        ...engine,
        dispatch: (command, options) => {
          if (command.type !== "message.dispatch" || attempts++ > 0)
            return engine.dispatch(command, options);
          // Prechecks succeed; only the real dispatch planning read sees unavailable storage.
          return sql
            .unsafe(
              "ALTER TABLE orchestration_v2_projection_runtime_requests RENAME TO held_runtime_requests",
            )
            .pipe(
              Effect.orDie,
              Effect.andThen(engine.dispatch(command, options)),
              Effect.ensuring(
                sql
                  .unsafe(
                    "ALTER TABLE held_runtime_requests RENAME TO orchestration_v2_projection_runtime_requests",
                  )
                  .pipe(Effect.orDie),
              ),
              Effect.tapError((error) => {
                assert.equal(error._tag, "OrchestratorProjectionError");
                return Deferred.succeed(failed, undefined);
              }),
            );
        },
      };
      if (scenario === "ordinary") {
        const message = {
          type: "message.dispatch",
          commandId: wakeCommandId,
          threadId: parent,
          messageId: MessageId.make(`message:${wakeId}`),
          text: "Ordinary message",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        } as const;
        assert.equal(
          (yield* wrapped.dispatch(message).pipe(Effect.flip))._tag,
          "OrchestratorProjectionError",
        );
        const receipt = yield* receipts.getByCommandId(wakeCommandId);
        assert.equal(Option.isSome(receipt) ? receipt.value.status : undefined, "rejected");
        assert.equal(
          (yield* wrapped.dispatch(message).pipe(Effect.flip))._tag,
          "OrchestratorCommandPreviouslyRejectedError",
        );
        assert.lengthOf((yield* engine.getThreadRecords(parent, ["messages"])).messages, 0);
        return;
      }
      const service = Threads.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Orchestrator.OrchestratorV2, wrapped),
            Layer.succeed(Receipts.CommandReceiptStoreV2, receipts),
            ServerSettings.layerTest(),
            Layer.mock(Sessions.ProviderSessionManagerV2)({}),
          ),
        ),
      );
      const record: Receipts.DelegationTimeout = {
        commandId,
        attemptId: "planning-retry-attempt",
        parentThreadId: parent,
        clientRequestId: requestKey,
        taskId: IdAllocator.derive.delegatedTaskNode({ commandId }),
        createdAt: "2026-11-17T06:08:59Z",
        analyticsJson: null,
      };
      yield* receipts.saveDelegationTimeout(record);
      yield* Effect.gen(function* () {
        const threads = yield* Threads.ThreadManagementService;
        const recovery = yield* (
          scenario === "startup"
            ? threads.sweepDelegationTimeouts([record])
            : threads
                .settleDelegationTimeout(
                  commandId,
                  {
                    outcome: "failed",
                    stage: "dispatch",
                    elapsedSeconds: 12,
                  },
                  false,
                  record.attemptId,
                )
                .pipe(Effect.map((wake) => assert.equal(wake, "sent")))
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(failed);
        assert.isTrue(
          Option.isNone(yield* receipts.getByCommandId(wakeCommandId)),
          "a transient planning read must not permanently reject the recovery command",
        );
        assert.isUndefined(recovery.pollUnsafe());
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(recovery);
        assert.lengthOf(
          (yield* engine.getThreadRecords(parent, ["messages"])).messages,
          1,
          "the original recovery must finish without a second sweep",
        );
        assert.deepEqual(yield* receipts.listDelegationTimeouts(), []);
        const receipt = yield* receipts.getByCommandId(wakeCommandId);
        assert.equal(Option.isSome(receipt) ? receipt.value.status : undefined, "accepted");
      }).pipe(Effect.provide(service));
      yield* Effect.gen(function* () {
        const restarted = yield* Threads.ThreadManagementService;
        yield* restarted.sweepDelegationTimeouts([record]);
        yield* restarted.sweepDelegationTimeouts();
        assert.lengthOf((yield* engine.getThreadRecords(parent, ["messages"])).messages, 1);
        assert.deepEqual(yield* receipts.listDelegationTimeouts(), []);
      }).pipe(Effect.provide(Layer.fresh(service)));
      assert.equal(attempts, 2);
    }).pipe(Effect.provide(layer)),
);
