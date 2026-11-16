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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

it.effect.each([true, false])("successor shares the calling session: %s", (sameSession) =>
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
    const successor: OrchestrationV2Run = {
      ...run,
      id: RunId.make("successor:run"),
      ordinal: run.ordinal + 1,
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
    const node = projection.nodes.find((node) => node.id === run.rootNodeId)!;
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
  }).pipe(Effect.provide(layer)),
);

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
      assert.include(String("cause" in error ? error.cause : error), "is stopping");
      assert.lengthOf((yield* engine.getThreadProjection(threadId)).subagents, 0);
    }).pipe(Effect.provide(layer)),
);
