import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import { assert, it } from "@effect/vitest";
import {
  OrchestrationV2ThreadProjection,
  OrchestrationV2Run,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
  TurnItemId,
  OrchestrationV2ProviderTurn,
  KanbanThreadLink,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as ControlStore from "../control/ControlStore.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import { markQueuedRunRecovered } from "../fast-install/report.ts";
import * as RestartPacingState from "./RestartPacingState.ts";

const decodeProjection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection);
const decodeLink = Schema.decodeUnknownSync(KanbanThreadLink);
const decodeMessage = Schema.decodeUnknownEffect(OrchestrationV2ConversationMessage);
const decodeTurn = Schema.decodeUnknownEffect(OrchestrationV2ProviderTurn);
const now = DateTime.makeUnsafe("2026-11-12T10:00:00Z");
const source = {
  threadId: ThreadId.make("thread:pacing-state"),
  sourceRunId: RunId.make("run:source"),
};
const model = { instanceId: "codex", model: "gpt-6.1-sol" };
const run = Schema.decodeUnknownSync(OrchestrationV2Run)({
  id: source.sourceRunId,
  threadId: source.threadId,
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection: model,
  providerThreadId: "provider-thread:1",
  userMessageId: "message:1",
  rootNodeId: "node:1",
  activeAttemptId: "attempt:1",
  status: "cancelled",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
});
const makeFixture = () => {
  let projection = decodeProjection({
    thread: {
      id: source.threadId,
      projectId: "project:pacing",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: model,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, rootThreadId: source.threadId, relationshipToParent: null },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      createdBy: "user",
      creationSource: "web",
    },
    runs: [run],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  });
  let continuationPending = false;
  let recorded: typeof OrchestrationV2TurnItem.Type | null = null;
  let origin: string | null = null;
  let link: typeof KanbanThreadLink.Type | null = null;
  const layer = RestartPacingState.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.sync(() => projection),
          getTurnItem: () => Effect.sync(() => recorded),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.none()) }),
        Layer.mock(ControlStore.ControlStore)({ getOrigin: () => Effect.sync(() => origin) }),
        Layer.mock(KanbanStore.KanbanStore)({
          threadLink: () => Effect.sync(() => link),
          discussionByEvaluator: () => Effect.succeed(null),
        }),
        ThreadCommandExecutor.layer,
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          hasPendingRunContinuation: () => Effect.sync(() => continuationPending),
        }),
      ),
    ),
  );
  return {
    layer,
    pending: (value: boolean) => {
      continuationPending = value;
    },
    recorded: (runId = run.id) => {
      recorded = {
        id: TurnItemId.make(`turn-item:restart-pacing:${runId}`),
        threadId: source.threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 100,
        type: "notification",
        source: { kind: "system" },
        outcome: "updated",
        summary: "Resuming after restart (position 1)",
        title: null,
        status: "waiting",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
    },
    get: () => projection,
    set: (value: typeof projection) => {
      projection = value;
    },
    origin: (value: string) => {
      origin = value;
    },
    role: (value: "evaluator" | "work" | "review") => {
      link = decodeLink({
        threadId: source.threadId,
        boardId: "board:robob",
        cardId: null,
        role: value,
        purpose: null,
        discussionId: null,
        model: null,
        startedAt: "2026-11-12T10:00:00Z",
        endedAt: null,
      });
    },
  };
};

it.effect("uses persisted origin and board roles for the priority order", () => {
  const f = makeFixture();
  return Effect.gen(function* () {
    const state = yield* RestartPacingState.RestartPacingState;
    assert.equal((yield* state.describe(source)).priority, 3);
    f.role("work");
    assert.equal((yield* state.describe(source)).priority, 2);
    f.role("review");
    assert.equal((yield* state.describe(source)).priority, 2);
    f.role("evaluator");
    assert.equal((yield* state.describe(source)).priority, 1);
    const message = yield* decodeMessage({
      id: run.userMessageId,
      threadId: run.threadId,
      runId: run.id,
      nodeId: null,
      role: "user",
      text: "Owner request",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      createdBy: "user",
      creationSource: "web",
    });
    f.set({ ...f.get(), messages: [message] });
    assert.equal((yield* state.describe(source)).priority, 0);
    f.set({ ...f.get(), messages: [] });
    f.origin("imessage");
    assert.equal((yield* state.describe(source)).priority, 0);
    assert.equal((yield* state.describe({ ...source, activityAt: 123 })).activityAt, 123);
  }).pipe(Effect.provide(f.layer));
});

it.effect("only restart markers and explicitly recovered queues enter pacing", () => {
  const f = makeFixture();
  return Effect.gen(function* () {
    const state = yield* RestartPacingState.RestartPacingState;
    f.set({ ...f.get(), runs: [{ ...run, status: "starting" }] });
    assert.isUndefined(yield* state.sourceForRun(source.threadId, run.id));
    const continuation = {
      ...run,
      status: "starting" as const,
      id: RunId.make("run:continuation"),
      restartContinuationOfRunId: run.id,
    };
    f.set({ ...f.get(), runs: [{ ...run, status: "starting" }, continuation] });
    assert.deepEqual(yield* state.sourceForRun(source.threadId, continuation.id), source);
    markQueuedRunRecovered(run.id);
    assert.deepEqual(yield* state.sourceForRun(source.threadId, run.id), source);
    assert.isUndefined(yield* state.sourceForRun(source.threadId, RunId.make("run:fresh")));
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([
  ["user", "web", "owner:web", false, 0],
  ["user", "mobile", "owner:mobile", false, 0],
  ["system", "web", "bearer:web", false, 0],
  ["system", "mobile", "bearer:mobile", false, 0],
  ["system", "server", "ardud-control:owner", false, 0],
  ["system", "server", "automatic:wake", false, 3],
  ["agent", "server", "automatic:agent", false, 3],
  ["user", "server", "scheduled:catchup", true, 3],
] as const)(
  "priority treats %s/%s/%s (scheduled=%s) consistently with person turns",
  ([createdBy, creationSource, id, scheduled, priority]) => {
    const f = makeFixture();
    return Effect.gen(function* () {
      const state = yield* RestartPacingState.RestartPacingState;
      const message = yield* decodeMessage({
        id,
        threadId: run.threadId,
        runId: run.id,
        nodeId: null,
        role: "user",
        text: "Pending input",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy,
        creationSource,
        ...(scheduled ? { scheduledTaskId: "schedule:catchup" } : {}),
      });
      f.set({ ...f.get(), runs: [{ ...run, userMessageId: message.id }], messages: [message] });
      assert.equal((yield* state.describe(source)).priority, priority);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "keeps accepted turns active after the claim and releases at provider settlement before checkpoints",
  () => {
    const f = makeFixture();
    return Effect.gen(function* () {
      const state = yield* RestartPacingState.RestartPacingState;
      const continuation = {
        ...run,
        id: RunId.make("run:continued"),
        restartContinuationOfRunId: run.id,
        status: "starting" as const,
      };
      f.set({ ...f.get(), runs: [run, continuation] });
      assert.isTrue(yield* state.active(source));
      const turn = yield* decodeTurn({
        id: "provider-turn:1",
        providerThreadId: run.providerThreadId,
        nodeId: run.rootNodeId,
        runAttemptId: run.activeAttemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      });
      f.set({
        ...f.get(),
        runs: [run, { ...continuation, status: "running" }],
        providerTurns: [turn],
      });
      assert.isTrue(yield* state.active(source));
      f.set({ ...f.get(), providerTurns: [{ ...turn, status: "completed", completedAt: now }] });
      assert.isFalse(yield* state.active(source));
      f.set({
        ...f.get(),
        runs: [run, { ...continuation, status: "cancelled" }],
        providerTurns: [],
      });
      assert.isFalse(yield* state.active(source));
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "automatic wakes sharing a restart backlog remain paced after the original wake settles",
  () => {
    const f = makeFixture();
    const automaticId = RunId.make("run:automatic-source");
    const automatic = { ...source, sourceRunId: automaticId };
    return Effect.gen(function* () {
      const state = yield* RestartPacingState.RestartPacingState;
      const message = yield* decodeMessage({
        id: run.userMessageId,
        threadId: run.threadId,
        runId: run.id,
        nodeId: null,
        role: "user",
        text: "Board restart wake",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: "system",
        creationSource: "server",
      });
      f.set({
        ...f.get(),
        runs: [{ ...run, id: automaticId, status: "starting" }],
        messages: [message],
      });
      assert.isUndefined(yield* state.sourceForRun(source.threadId, automaticId));
      f.pending(true);
      assert.deepEqual(yield* state.sourceForRun(source.threadId, automaticId), automatic);
      f.recorded(automaticId);
      f.pending(false);
      assert.deepEqual(yield* state.sourceForRun(source.threadId, automaticId), automatic);
      f.set({ ...f.get(), messages: [{ ...message, createdBy: "user" }] });
      assert.isUndefined(yield* state.sourceForRun(source.threadId, automaticId));
    }).pipe(Effect.provide(f.layer));
  },
);
