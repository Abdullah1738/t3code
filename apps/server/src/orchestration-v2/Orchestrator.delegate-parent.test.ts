import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-6.1-sol" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Admission tests must not start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = Sqlite.layerMemory;
const layer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(database)),
  Harness.layerWithRegistry({ name: "delegate-admission" }, Registry.layerFromAdapters([adapter]), {
    databaseLayer: database,
    runEffectWorker: false,
  }),
);
const seed = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make("thread:delegate-admission");
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("parent:create"),
    threadId,
    projectId: ProjectId.make("project:delegate-admission"),
    title: "Parent",
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
    commandId: CommandId.make("parent:start"),
    threadId,
    messageId: MessageId.make("parent:message"),
    text: "Delegate",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const projection = yield* engine.getThreadProjection(threadId);
  const run = projection.runs[0]!;
  const admittedAt = DateTime.add(run.requestedAt, { seconds: 1 });
  const command = {
    type: "delegated_task.request",
    commandId: CommandId.make("delegate:same-key"),
    parentThreadId: threadId,
    parentRunId: run.id,
    parentNodeId: run.rootNodeId!,
    parentAdmittedAt: admittedAt,
    task: "Review",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    completionWake: "always",
    createdBy: "agent",
    creationSource: "mcp",
  } as const;
  return { engine, store, threadId, run, command, projection };
});

it.effect.each([
  ["completed", 1, true],
  ["completed", 0, true],
  ["completed", -1, false],
  ["interrupted", 1, false],
  ["cancelled", 1, false],
  ["failed", 1, false],
  ["rolled_back", 1, false],
] as const)(
  "parent %s ending %s seconds after admission (accepted=%s)",
  ([status, offset, accepted]) =>
    Effect.gen(function* () {
      const { engine, store, threadId, run, command } = yield* seed;
      const completedAt = DateTime.add(command.parentAdmittedAt, { seconds: offset });
      yield* store.apply({
        id: EventId.make("parent:end"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: completedAt,
        payload: { ...run, status, completedAt },
      });
      if (accepted) {
        yield* engine.dispatch(command);
        yield* engine.dispatch(command);
        const parent = yield* engine.getThreadProjection(threadId);
        assert.lengthOf(parent.subagents, 1);
        assert.equal(parent.subagents[0]!.runId, run.id);
        assert.lengthOf(
          (yield* engine.getThreadProjection(parent.subagents[0]!.childThreadId!)).runs,
          1,
        );
      } else {
        const error = yield* engine.dispatch(command).pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.include(String("cause" in error ? error.cause : error), "is not active");
        assert.lengthOf((yield* engine.getThreadProjection(threadId)).subagents, 0);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect.each([true, false])(
  "detached create across two successors shares the calling session: %s",
  (sameSession) =>
    Effect.gen(function* () {
      const { engine, store, threadId, run, command, projection } = yield* seed;
      const providerThread = projection.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      )!;
      const sessionId = ProviderSessionId.make("caller:session");
      const now = DateTime.add(command.parentAdmittedAt, { seconds: 1 });
      yield* store.apply({
        id: EventId.make("parent:session"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: { ...providerThread, providerSessionId: sessionId },
      });
      yield* store.apply({
        id: EventId.make("parent:end"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      const successorProviderThread = sameSession
        ? providerThread.id
        : ProviderThreadId.make("other:provider-thread");
      if (!sameSession)
        yield* store.apply({
          id: EventId.make("successor:session"),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...providerThread,
            id: successorProviderThread,
            providerSessionId: ProviderSessionId.make("other:session"),
          },
        });
      const finishedSuccessor: OrchestrationV2Run = {
        ...run,
        id: RunId.make("finished-successor:run"),
        ordinal: run.ordinal + 1,
        rootNodeId: NodeId.make("finished-successor:root"),
        requestedAt: now,
        status: "completed",
        completedAt: now,
      };
      yield* store.apply({
        id: EventId.make("finished-successor:run"),
        type: "run.updated",
        threadId,
        runId: finishedSuccessor.id,
        occurredAt: now,
        payload: finishedSuccessor,
      });
      const node = projection.nodes.find((node) => node.id === run.rootNodeId)!;
      yield* store.apply({
        id: EventId.make("finished-successor:root"),
        type: "node.updated",
        threadId,
        runId: finishedSuccessor.id,
        nodeId: finishedSuccessor.rootNodeId!,
        occurredAt: now,
        payload: {
          ...node,
          id: finishedSuccessor.rootNodeId!,
          runId: finishedSuccessor.id,
          rootNodeId: finishedSuccessor.rootNodeId!,
        },
      });
      const successor: OrchestrationV2Run = {
        ...run,
        id: RunId.make("successor:run"),
        ordinal: run.ordinal + 2,
        rootNodeId: NodeId.make("successor:root"),
        providerThreadId: successorProviderThread,
        requestedAt: now,
        status: "running",
      };
      yield* store.apply({
        id: EventId.make("successor:run"),
        type: "run.updated",
        threadId,
        runId: successor.id,
        occurredAt: now,
        payload: successor,
      });
      yield* store.apply({
        id: EventId.make("successor:root"),
        type: "node.updated",
        threadId,
        runId: successor.id,
        nodeId: successor.rootNodeId!,
        occurredAt: now,
        payload: {
          ...node,
          id: successor.rootNodeId!,
          runId: successor.id,
          rootNodeId: successor.rootNodeId!,
        },
      });
      yield* engine.dispatch({ ...command, parentProviderSessionId: sessionId });
      yield* engine.dispatch({ ...command, parentProviderSessionId: sessionId });
      const parent = yield* engine.getThreadProjection(threadId);
      assert.lengthOf(parent.subagents, 1);
      assert.equal(parent.subagents[0]!.runId, sameSession ? successor.id : run.id);
      assert.equal(
        parent.subagents[0]!.parentNodeId,
        sameSession ? successor.rootNodeId : run.rootNodeId,
      );
      const child = yield* engine.getThreadProjection(parent.subagents[0]!.childThreadId!);
      assert.equal(child.thread.lineage.parentThreadId, threadId);
      assert.lengthOf(child.runs, 1);
      assert.equal(child.runs[0]!.delegatedTaskId, parent.subagents[0]!.id);
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  "run_not_found",
  "run_not_completed",
  "admission_time_missing",
  "completion_time_missing",
  "admission_before_run",
  "admission_after_completion",
  "admitted_node_missing",
  "admitted_node_run_mismatch",
  "admitted_root_missing",
  "successor_root_missing",
  "successor_node_missing",
] as const)("rejection identifies %s and records admission evidence", (reason) => {
  const spans: Array<Record<string, unknown>> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        end(time, exit);
        if (span.name === "orchestrationV2.dispatch.delegatedTaskRequest")
          spans.push(Object.fromEntries(span.attributes));
      };
      return span;
    },
  });
  return Effect.gen(function* () {
    const { engine, store, threadId, run, command, projection } = yield* seed;
    const completedAt = DateTime.add(command.parentAdmittedAt, { seconds: 1 });
    const parent = {
      ...run,
      status: reason === "run_not_completed" ? ("failed" as const) : ("completed" as const),
      completedAt: reason === "completion_time_missing" ? null : completedAt,
      rootNodeId: reason === "admitted_root_missing" ? null : run.rootNodeId,
    };
    yield* store.apply({
      id: EventId.make("parent:end"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: completedAt,
      payload: parent,
    });
    const sessionId = ProviderSessionId.make("caller:session");
    let attachmentRunId = run.id;
    if (reason.startsWith("successor_")) {
      const providerThread = projection.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      )!;
      yield* store.apply({
        id: EventId.make("parent:session"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: completedAt,
        payload: { ...providerThread, providerSessionId: sessionId },
      });
      attachmentRunId = RunId.make("successor:run");
      yield* store.apply({
        id: EventId.make("successor:run"),
        type: "run.updated",
        threadId,
        runId: attachmentRunId,
        occurredAt: completedAt,
        payload: {
          ...run,
          id: attachmentRunId,
          ordinal: run.ordinal + 1,
          rootNodeId: reason === "successor_root_missing" ? null : NodeId.make("missing:root"),
          requestedAt: completedAt,
          status: "running",
        },
      });
    }
    if (reason === "admitted_node_run_mismatch") {
      const node = projection.nodes.find((node) => node.id === run.rootNodeId)!;
      yield* store.apply({
        id: EventId.make("parent:node-mismatch"),
        type: "node.updated",
        threadId,
        runId: run.id,
        nodeId: node.id,
        occurredAt: completedAt,
        payload: { ...node, runId: RunId.make("other:run") },
      });
    }
    const { parentAdmittedAt, ...withoutAdmission } = command;
    const input = {
      ...withoutAdmission,
      ...(reason === "admission_time_missing"
        ? {}
        : {
            parentAdmittedAt:
              reason === "admission_before_run"
                ? DateTime.subtract(run.requestedAt, { seconds: 1 })
                : reason === "admission_after_completion"
                  ? DateTime.add(completedAt, { seconds: 1 })
                  : parentAdmittedAt,
          }),
      parentRunId: reason === "run_not_found" ? RunId.make("missing:run") : run.id,
      parentNodeId:
        reason === "admitted_node_missing" ? NodeId.make("missing:node") : command.parentNodeId,
      parentProviderSessionId: sessionId,
    };
    const error = yield* engine.dispatch(input).pipe(Effect.flip);
    assert.equal(error._tag, "OrchestratorDispatchError");
    assert.equal(
      String("cause" in error ? error.cause : error),
      `Parent run ${reason === "run_not_found" ? input.parentRunId : attachmentRunId} is not active: ${reason}.`,
    );
    assert.lengthOf((yield* engine.getThreadProjection(threadId)).subagents, 0);
    const evidence = spans.at(-1)!;
    assert.equal(evidence["t3.delegate.rejection_reason"], reason);
    assert.equal(
      evidence["t3.delegate.parent_run_status"],
      reason === "run_not_found" ? null : parent.status,
    );
    assert.equal(
      evidence["t3.delegate.parent_admitted_at"],
      input.parentAdmittedAt === undefined ? null : DateTime.formatIso(input.parentAdmittedAt),
    );
    assert.equal(
      evidence["t3.delegate.parent_requested_at"],
      reason === "run_not_found" ? null : DateTime.formatIso(run.requestedAt),
    );
    assert.equal(
      evidence["t3.delegate.parent_completed_at"],
      reason === "run_not_found" || parent.completedAt === null
        ? null
        : DateTime.formatIso(parent.completedAt),
    );
  }).pipe(Effect.provide(layer), Effect.withTracer(tracer));
});

it.effect.each(
  (["run.interrupt", "thread.stop"] as const).flatMap((stopType) =>
    [false, true].flatMap((resumeAgain) =>
      (
        [
          "complete",
          "missing-root",
          "missing-provider",
          "missing-attempt",
          "missing-root-provider",
          "missing-root-attempt",
          "missing-provider-attempt",
          "missing-all",
        ] as const
      ).map((binding) => ({ stopType, resumeAgain, binding })),
    ),
  ),
)(
  "Stop revokes detached admission across successors ($stopType, resumed=$resumeAgain, $binding)",
  ({ stopType, resumeAgain, binding }) =>
    Effect.gen(function* () {
      const { engine, store, threadId, run, command } = yield* seed;
      const now = DateTime.add(command.parentAdmittedAt, { seconds: 1 });
      yield* store.apply({
        id: EventId.make("parent:end"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      const start = (key: string) =>
        engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(key),
          threadId,
          messageId: MessageId.make(key),
          text: key,
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
      yield* start("successor:start");
      const successor = (yield* engine.getThreadProjection(threadId)).runs.at(-1)!;
      if (binding !== "complete")
        yield* store.apply({
          id: EventId.make("successor:binding"),
          type: "run.updated",
          threadId,
          runId: successor.id,
          occurredAt: now,
          payload: {
            ...successor,
            rootNodeId:
              binding.includes("root") || binding === "missing-all" ? null : successor.rootNodeId,
            providerThreadId:
              binding.includes("provider") || binding === "missing-all"
                ? null
                : successor.providerThreadId,
            activeAttemptId:
              binding.includes("attempt") || binding === "missing-all"
                ? null
                : successor.activeAttemptId,
          },
        });
      if (stopType === "run.interrupt")
        yield* engine.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("successor:stop"),
          threadId,
          runId: successor.id,
        });
      else
        yield* engine.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("successor:stop"),
          threadId,
        });
      const stopped = yield* engine.getThreadProjection(threadId);
      assert.equal(
        stopped.runs.find((candidate) => candidate.id === successor.id)?.status,
        "interrupted",
      );
      assert.lengthOf(
        stopped.turnItems.filter(
          (item) => item.runId === successor.id && item.type === "run_interrupt_request",
        ),
        1,
      );
      if (resumeAgain) yield* start("newest:start");
      const error = yield* engine.dispatch(command).pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.equal(
        String("cause" in error ? error.cause : error),
        `Parent run ${run.id} is stopping: stop_requested.`,
      );
      assert.lengthOf((yield* engine.getThreadProjection(threadId)).subagents, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["accepted", "rejected", "revoked", "thread.create"] as const)(
  "replays %s receipt while the parent dispatch lock is held",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, threadId, command } = yield* seed;
        const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
        const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const replay =
          outcome === "thread.create"
            ? {
                type: "thread.create" as const,
                commandId: CommandId.make("parent:create"),
                threadId,
                projectId: ProjectId.make("project:delegate-admission"),
                title: "Parent",
                modelSelection,
                runtimeMode: "full-access" as const,
                interactionMode: "default" as const,
                branch: null,
                worktreePath: null,
                createdBy: "user" as const,
                creationSource: "web" as const,
              }
            : command;
        yield* engine.dispatch(replay);
        const accepted = yield* engine.dispatch(replay);
        if (outcome === "rejected")
          yield* receipts.upsert({
            commandId: command.commandId,
            threadId,
            commandType: command.type,
            acceptedAt: yield* DateTime.now,
            resultSequence: accepted.sequence,
            status: "rejected",
            error: "Rejected for test",
          });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const held = yield* locks
          .withLock(
            threadId,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const result = yield* engine
          .dispatch(replay, {
            isStale: () => outcome === "revoked",
          })
          .pipe(Effect.exit);
        assert.isUndefined(held.pollUnsafe(), "receipt replay must leave the lock held");
        if (outcome === "rejected" || outcome === "revoked") {
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            const error = result.cause.reasons.find((r) => r._tag === "Fail")?.error;
            assert.equal(
              error?._tag,
              outcome === "rejected"
                ? "OrchestratorCommandPreviouslyRejectedError"
                : "OrchestratorCommandRejectedError",
            );
            if (error?._tag === "OrchestratorCommandRejectedError") assert.isTrue(error.revoked);
          }
        } else {
          assert.equal(result._tag, "Success");
          if (result._tag === "Success") assert.deepEqual(result.value, accepted);
          assert.lengthOf(
            (yield* engine.getThreadProjection(threadId)).subagents,
            outcome === "thread.create" ? 0 : 1,
          );
        }
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(held);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer,
            ThreadCommandExecutor.layer,
            CommandReceiptStore.layer.pipe(Layer.provide(database)),
          ),
        ),
      ),
    ),
);
