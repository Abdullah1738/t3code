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
  KanbanCard,
  KanbanCardId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as ControlStore from "../control/ControlStore.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import { markQueuedRunRecovered } from "../fast-install/report.ts";
import * as RestartPacingState from "./RestartPacingState.ts";
import * as RestartPacing from "./RestartPacing.ts";
import * as ServerSettings from "../../serverSettings.ts";

const decodeProjection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection);
const decodeLink = Schema.decodeUnknownSync(KanbanThreadLink);
const decodeMessage = Schema.decodeUnknownEffect(OrchestrationV2ConversationMessage);
const decodeTurn = Schema.decodeUnknownEffect(OrchestrationV2ProviderTurn);
const decodeTurnItem = Schema.decodeUnknownEffect(OrchestrationV2TurnItem);
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
  let card: typeof KanbanCard.Type | null = null;
  const commits: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
  const layer = RestartPacingState.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.sync(() => projection),
          getTurnItem: () => Effect.sync(() => recorded),
          getNextTurnItemOrdinal: () => Effect.succeed(1),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.none()) }),
        Layer.mock(ControlStore.ControlStore)({ getOrigin: () => Effect.sync(() => origin) }),
        Layer.mock(KanbanStore.KanbanStore)({
          threadLink: () => Effect.sync(() => link),
          cardsByThread: () => Effect.sync(() => (card === null ? [] : [card])),
          discussionByEvaluator: () => Effect.succeed(null),
        }),
        ThreadCommandExecutor.layer,
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) =>
            Effect.sync(() => {
              commits.push(input);
              for (const event of input.events)
                if (event.type === "turn-item.updated") recorded = event.payload;
              return { committed: true, cancelledEffectCount: 0 } as never;
            }),
        }),
        IdAllocator.layer,
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          hasRunContinuationAt: () => Effect.sync(() => continuationPending),
        }),
      ),
    ),
  );
  return {
    commits,
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
    working: () => {
      if (link === null) throw new Error("set role first");
      link = { ...link, cardId: KanbanCardId.make("card:runtime-recovery") };
      card = {
        id: link.cardId,
        stage: "working",
        activeRole: "work",
        activeThreadId: source.threadId,
        stalled: null,
      } as typeof KanbanCard.Type;
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
    assert.deepEqual(yield* state.sourceForRun(source.threadId, continuation.id), {
      ...source,
      classification: "continuation",
    });
    markQueuedRunRecovered(run.id);
    assert.deepEqual(yield* state.sourceForRun(source.threadId, run.id), {
      ...source,
      classification: "recovered-queue",
    });
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
    const automatic = {
      ...source,
      sourceRunId: automaticId,
      classification: "pending-continuation-race" as const,
    };
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
      const pacing = yield* RestartPacing.RestartPacing;
      assert.isAbove(yield* pacing.acquireRun(source.threadId, automaticId), 0);
      f.recorded(automaticId);
      f.pending(false);
      assert.deepEqual(yield* state.sourceForRun(source.threadId, automaticId), automatic);
      f.set({ ...f.get(), messages: [{ ...message, createdBy: "user" }] });
      assert.isUndefined(yield* state.sourceForRun(source.threadId, automaticId));
    }).pipe(
      Effect.provide(
        RestartPacing.layer.pipe(
          Layer.provideMerge(f.layer),
          Layer.provide(ServerSettings.layerTest({})),
          Layer.provide(Layer.succeed(RestartPacing.RestartLoad, () => 2)),
        ),
      ),
    );
  },
);

it.effect(
  "a stale pending continuation cannot re-catch automatic wakes after startup work started",
  () => {
    const f = makeFixture();
    return Effect.gen(function* () {
      const state = yield* RestartPacingState.RestartPacingState;
      yield* TestClock.adjust("1 hour");
      const startedAt = yield* DateTime.now;
      const automaticId = RunId.make("run:late-notification");
      const message = yield* decodeMessage({
        id: "message:late",
        threadId: run.threadId,
        runId: automaticId,
        nodeId: null,
        role: "user",
        text: "Checks passed",
        attachments: [],
        streaming: false,
        createdAt: startedAt,
        updatedAt: startedAt,
        createdBy: "system",
        creationSource: "server",
      });
      f.pending(true);
      f.set({
        ...f.get(),
        runs: [
          { ...run, status: "completed", startedAt, completedAt: startedAt },
          {
            ...run,
            id: automaticId,
            status: "starting",
            userMessageId: message.id,
            requestedAt: startedAt,
            startedAt: null,
            completedAt: null,
          },
        ],
        messages: [message],
      });
      assert.isUndefined(yield* state.sourceForRun(source.threadId, automaticId));
      const pacing = yield* RestartPacing.RestartPacing;
      assert.equal(yield* pacing.acquireRun(source.threadId, automaticId), 0);
      // An existing wait is this run's durable classification, not a new wake.
      f.recorded(automaticId);
      assert.equal(
        (yield* state.sourceForRun(source.threadId, automaticId))?.sourceRunId,
        automaticId,
      );
    }).pipe(
      Effect.provide(
        RestartPacing.layer.pipe(
          Layer.provideMerge(f.layer),
          Layer.provide(ServerSettings.layerTest({})),
          Layer.provide(Layer.succeed(RestartPacing.RestartLoad, () => 2)),
        ),
      ),
    );
  },
);

it.effect.each([1, 2])(
  "a completed wait at position %s preserves its classification and blocking gates",
  (position) => {
    const f = makeFixture();
    return Effect.gen(function* () {
      const state = yield* RestartPacingState.RestartPacingState;
      yield* state.status({ ...source, classification: "pending-continuation-race" }, position, {
        total: 5,
        active: 4,
        maxActive: 4,
        spacingMs: 1200,
        loadHoldElapsedMs: 30000,
        loadHoldRemainingMs: 1170000,
      });
      const item = f.commits[0]?.events.find((event) => event.type === "turn-item.updated");
      assert.isDefined(item);
      if (item?.type !== "turn-item.updated" || item.payload.type !== "notification") return;
      assert.equal(item.payload.summary, `Resuming after restart (position ${position} of 5)`);
      assert.equal(
        item.payload.detail,
        `Source: pending-continuation-race. Queue: position ${position} of 5. Active: 4/4 (maxActive). Spacing: 2s remaining. Load hold: 30s elapsed, 1170s remaining.`,
      );
      yield* TestClock.adjust("1 minute");
      yield* state.status(source, null);
      const completed = f.commits
        .at(-1)
        ?.events.find((event) => event.type === "turn-item.updated");
      assert.isDefined(completed);
      if (completed?.type !== "turn-item.updated" || completed.payload.type !== "notification")
        return;
      assert.equal(completed.payload.summary, "Restart wait ended");
      assert.equal(completed.payload.status, "completed");
      assert.equal(completed.payload.detail, item.payload.detail);
      assert.isNotNull(completed.payload.completedAt);
      assert.deepEqual(completed.payload.startedAt, item.payload.startedAt);
      yield* state.status(source, null);
      const repeated = f.commits.at(-1)?.events.find((event) => event.type === "turn-item.updated");
      if (repeated?.type !== "turn-item.updated" || repeated.payload.type !== "notification")
        return;
      assert.equal(repeated.payload.detail, item.payload.detail);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["user", "scheduled"] as const)(
  "%s input skips pacing despite a pending continuation",
  (kind) => {
    const f = makeFixture();
    return Effect.gen(function* () {
      const state = yield* RestartPacingState.RestartPacingState;
      const id = RunId.make(`run:unpaced:${kind}`);
      const message = yield* decodeMessage({
        id: `message:${kind}`,
        threadId: run.threadId,
        runId: id,
        nodeId: null,
        role: "user",
        text: "Work",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: kind === "user" ? "user" : "system",
        creationSource: "server",
        ...(kind === "scheduled" ? { scheduledTaskId: "schedule:test" } : {}),
      });
      f.pending(true);
      f.set({
        ...f.get(),
        runs: [{ ...run, id, status: "starting", userMessageId: message.id }],
        messages: [message],
      });
      assert.isUndefined(yield* state.sourceForRun(source.threadId, id));
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "a racing wake with a delayed first claim stays paced after another startup run starts",
  () => {
    const f = makeFixture();
    return Effect.gen(function* () {
      const state = yield* RestartPacingState.RestartPacingState;
      const requestedAt = yield* DateTime.now;
      yield* TestClock.adjust("1 second");
      const startedAt = yield* DateTime.now;
      const id = RunId.make("run:delayed-startup-race");
      const message = yield* decodeMessage({
        id: "message:delayed-startup-race",
        threadId: run.threadId,
        runId: id,
        nodeId: null,
        role: "user",
        text: "Checks passed",
        attachments: [],
        streaming: false,
        createdAt: requestedAt,
        updatedAt: requestedAt,
        createdBy: "system",
        creationSource: "server",
      });
      f.pending(true);
      f.set({
        ...f.get(),
        messages: [message],
        runs: [
          { ...run, status: "completed", startedAt, completedAt: startedAt },
          {
            ...run,
            id,
            status: "starting",
            userMessageId: message.id,
            requestedAt,
            startedAt: null,
          },
        ],
      });
      assert.equal(
        (yield* state.sourceForRun(source.threadId, id))?.classification,
        "pending-continuation-race",
      );
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["direct", "continuation"] as const)(
  "a %s run with a running timestamp still holds before provider acceptance",
  (kind) => {
    const f = makeFixture();
    const starting = {
      ...run,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
      ...(kind === "continuation"
        ? {
            id: RunId.make("run:continued-before-provider"),
            restartContinuationOfRunId: run.id,
          }
        : {}),
    };
    f.set({
      ...f.get(),
      runs: kind === "continuation" ? [run, starting] : [starting],
      providerTurns: [],
    });
    return Effect.gen(function* () {
      const state = yield* RestartPacingState.RestartPacingState;
      assert.isTrue(yield* state.active(source));
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "runtime-loss Working cards precede routine restart work, with owner messages still first",
  () => {
    const f = makeFixture();
    return Effect.gen(function* () {
      const state = yield* RestartPacingState.RestartPacingState;
      f.role("work");
      f.working();
      assert.equal((yield* state.describe(source)).priority, 2);
      const failure = yield* decodeTurnItem({
        id: `turn-item:runtime-lost:${run.id}`,
        threadId: run.threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "error",
        title: null,
        status: "failed",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        failure: {
          class: "transport_error",
          category: "unknown",
          code: "provider.runtime_lost",
          retryable: true,
          message: "Runtime lost",
        },
      });
      f.set({ ...f.get(), turnItems: [failure] });
      assert.equal((yield* state.describe(source)).priority, 0.5);
      if (failure.type === "error") {
        f.set({
          ...f.get(),
          turnItems: [{ ...failure, failure: { ...failure.failure, message: "rate limit" } }],
        });
        assert.equal((yield* state.describe(source)).priority, 2);
      }
      f.origin("imessage");
      assert.equal((yield* state.describe(source)).priority, 0);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect.each([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
  "failed",
  "completed",
  "cancelled",
] as const)("bound diagnostics find a %s successor", (status) => {
  const f = makeFixture();
  f.set({ ...f.get(), runs: [run, { ...run, id: RunId.make("successor"), ordinal: 2, status }] });
  return Effect.gen(function* () {
    const state = yield* RestartPacingState.RestartPacingState;
    assert.equal(
      yield* state.hasSuccessor(source),
      ["queued", "preparing", "starting", "running", "waiting"].includes(status),
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "bound diagnostics exclude the actual starting run when its source is a predecessor",
  () => {
    const f = makeFixture();
    const actual = { ...run, id: RunId.make("actual"), status: "starting" as const };
    f.set({ ...f.get(), runs: [run, actual] });
    return Effect.gen(function* () {
      const state = yield* RestartPacingState.RestartPacingState;
      assert.isFalse(yield* state.hasSuccessor(source, actual.id));
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("holder status uses its actual admitted run instead of a queued replacement", () => {
  const f = makeFixture();
  return Effect.gen(function* () {
    const state = yield* RestartPacingState.RestartPacingState;
    const actualId = RunId.make("run:actual-start");
    f.set({
      ...f.get(),
      runs: [
        { ...run, status: "queued" },
        {
          ...run,
          id: actualId,
          status: "starting",
          restartContinuationOfRunId: RunId.make("run:older-source"),
        },
      ],
    });
    assert.isFalse(yield* state.active(source));
    assert.isTrue(yield* state.active(source, actualId));
    f.set({ ...f.get(), runs: [{ ...run, status: "queued" }] });
    assert.isFalse(yield* state.active(source, actualId));
  }).pipe(Effect.provide(f.layer));
});
