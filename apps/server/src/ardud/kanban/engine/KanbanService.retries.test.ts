/**
 * Retry once before flagging, through the board service: a failed worker or
 * reviewer run, and a reviewer that ends without a verdict, are run again once
 * before the card is flagged. A failed run's card waits out its backoff in its
 * queue and holds no slot. The pure decision is tested in retries.test.ts.
 */
import { assert, it } from "@effect/vitest";
import { withTestSchedulerBudget } from "./testSchedulerBudget.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import {
  KanbanError,
  KanbanBoardId,
  KanbanDiscussionId,
  KanbanScriptId,
  kanbanRetryNotBefore,
  kanbanRetrying,
  kanbanWaiting,
  type KanbanCardEvent,
  ProjectId,
  RunId,
  ThreadId,
  type KanbanActor,
  type KanbanCard,
  type ModelSelection,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
} from "@t3tools/contracts";

import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import * as KanbanModels from "./models.ts";
import * as KanbanService from "./KanbanService.ts";
import * as BoardLocks from "./boardLocks.ts";
import * as Retries from "./retries.ts";
import * as Rules from "./rules.ts";
import { effortOptionId } from "@t3tools/client-runtime/ardud/models/harnessRouting";
import * as Waits from "./waits.ts";
import { opencodeTestProvider } from "./testProviders.ts";
import { KanbanThreads, type KanbanThreadView } from "./threads.ts";
import { ownerReplyPending } from "./ownerReplyWake.ts";

type Failure = OrchestrationV2ProviderFailure & {
  readonly runId?: string | null;
  readonly model?: ModelSelection | null;
};

interface FakeThread {
  readonly messages: Array<string>;
  model: ModelSelection;
  failure: Failure | null;
  run: { readonly id: string; readonly at: string } | null;
}

/** Threads that are idle unless a test says otherwise; a failure stands until the test clears it. */
const makeFake = () => {
  const threads = new Map<string, FakeThread>();
  const queued = new Map<ThreadId, ReadonlyArray<OrchestrationV2Run>>();
  const history = new Map<
    string,
    Array<{ id: string; ordinal: number; started: boolean; model: ModelSelection }>
  >();
  /** Reads of each thread (its view or its last failure), for tests that count them. */
  const reads = new Map<string, number>();
  const counted = (threadId: string) => reads.set(threadId, (reads.get(threadId) ?? 0) + 1);
  let nextThread = 0;
  let nextRun = 0;
  const sendControl = {
    beforeSend: (_text: string): Effect.Effect<void> => Effect.void,
    beforeLaunch: (_text: string): Effect.Effect<void> => Effect.void,
  };
  const read = (threadId: ThreadId) =>
    Effect.map(Clock.currentTimeMillis, (nowMs): KanbanThreadView | null =>
      (counted(threadId), threads.has(threadId))
        ? {
            threadId,
            projectId: ProjectId.make("project-1"),
            title: threadId,
            state: threads.get(threadId)!.run === null ? "idle" : "running",
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
            quietSince: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
            runId: threads.get(threadId)!.run?.id ?? null,
            runStartedAt: threads.get(threadId)!.run?.at ?? null,
            lastActivityAt: threads.get(threadId)!.run?.at ?? null,
            backgroundWork: 0,
            prWatches: 0,
            prs: [],
            archived: false,
          }
        : null,
    );
  const failureOf = (threadId: ThreadId) =>
    Effect.sync(() => {
      counted(threadId);
      return threads.get(threadId)?.failure ?? null;
    });
  const layer = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      liveThreadIds: () => Effect.succeed([]),
      remove: () => Effect.void,
      pendingUserInputs: () => Effect.succeed([]),
      claimContext: (threadId) =>
        read(threadId).pipe(
          Effect.map((view) => {
            const model = threads.get(threadId)?.model;
            return view && model ? { projectId: view.projectId, model } : null;
          }),
        ),
      view: read,
      find: read,
      model: (threadId) => Effect.sync(() => threads.get(threadId)?.model ?? null),
      lastFailure: failureOf,
      findLastFailure: failureOf,
      latestRun: (threadId, afterRunId) =>
        Effect.sync(() => {
          if (afterRunId === undefined) return null;
          const runs = history.get(threadId) ?? [];
          const failed = runs.find((run) => run.id === afterRunId);
          const later = runs.findLast(
            (run) => run.started && run.id !== afterRunId && run.ordinal > (failed?.ordinal ?? 0),
          );
          return later === undefined
            ? null
            : {
                runId: later.id,
                status: threads.get(threadId)?.run?.id === later.id ? "running" : "completed",
                message: null,
                model: later.model,
              };
        }),
      backgroundStoppedSince: () => Effect.succeed(false),
      runSettled: () => Effect.succeed(true),
      compactRun: () => Effect.succeed(null),
      launch: (input) =>
        sendControl.beforeLaunch(input.text).pipe(
          Effect.andThen(
            Effect.sync(() => {
              nextThread += 1;
              const threadId = ThreadId.make(`thread-${nextThread}`);
              threads.set(threadId, {
                messages: [input.text],
                model: input.model,
                failure: null,
                run: null,
              });
              return threadId;
            }),
          ),
        ),
      send: (input) =>
        sendControl.beforeSend(input.text).pipe(
          Effect.andThen(
            Effect.sync(() => {
              threads.get(input.threadId)?.messages.push(input.text);
              nextRun += 1;
              return `run-${nextRun}`;
            }),
          ),
        ),
      withdraw: () => Effect.void,
      setModel: (threadId, model) =>
        Effect.sync(() => {
          const thread = threads.get(threadId);
          if (thread) thread.model = model;
        }),
      queuedRuns: (threadId, includeActive) =>
        Effect.sync(() => {
          const current = threads.get(threadId)?.run;
          return [
            ...(queued.get(threadId) ?? []),
            ...(includeActive && current !== null && current !== undefined
              ? [{ id: RunId.make(current.id), status: "running" } as OrchestrationV2Run]
              : []),
          ];
        }),
      cancelQueued: () => Effect.succeed(false),
      interrupt: (threadId) =>
        Effect.sync(() => {
          if (threads.get(threadId)!.run !== null) interrupted.push(threadId);
          threads.get(threadId)!.run = null;
        }),
    }),
  );
  /** The thread's latest run failed; each call is a new run. */
  const fail = (threadId: string, patch: Partial<Failure> = {}) => {
    nextRun += 1;
    threads.get(threadId)!.failure = {
      class: "provider_error",
      code: null,
      message: "upstream closed the stream",
      retryable: null,
      category: "unknown",
      runId: `run-${nextRun}`,
      ...patch,
    };
    const runs = history.get(threadId) ?? [];
    if (!runs.some((run) => run.id === threads.get(threadId)!.failure!.runId))
      runs.push({
        id: threads.get(threadId)!.failure!.runId!,
        ordinal: nextRun,
        started: false,
        model: threads.get(threadId)!.model,
      });
    history.set(threadId, runs);
  };
  /** The thread's latest run is a good one again (the wake started a new run). */
  const recover = (threadId: string) => {
    threads.get(threadId)!.failure = null;
  };
  const messages = (threadId: string) => threads.get(threadId)?.messages ?? [];
  const readsOf = (threadId: string) => reads.get(threadId) ?? 0;
  const interrupted: Array<string> = [];
  const start = (threadId: string) =>
    Effect.map(Clock.currentTimeMillis, (nowMs) => {
      nextRun += 1;
      threads.get(threadId)!.failure = null;
      threads.get(threadId)!.run = {
        id: `run-${nextRun}`,
        at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      };
      const runs = history.get(threadId) ?? [];
      runs.push({
        id: `run-${nextRun}`,
        ordinal: nextRun,
        started: true,
        model: threads.get(threadId)!.model,
      });
      history.set(threadId, runs);
    });
  const finish = (threadId: string) => {
    threads.get(threadId)!.run = null;
  };
  const cloneThread = (id: ThreadId, source: ThreadId) => {
    threads.set(id, { ...threads.get(source)!, messages: [], run: null, failure: null });
  };
  return {
    cloneThread,
    layer,
    fail,
    recover,
    messages,
    readsOf,
    start,
    finish,
    interrupted,
    sendControl,
    setQueued: (threadId: ThreadId) =>
      queued.set(threadId, [
        { id: RunId.make("successor"), status: "queued" } as OrchestrationV2Run,
      ]),
    clearQueued: (threadId: ThreadId) => queued.delete(threadId),
  };
};

const testLayer = (
  fake: Layer.Layer<KanbanThreads>,
  storeLayer = KanbanStore.layer,
  sqlLayer = Sqlite.layerMemory,
) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(sqlLayer),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.map(ServerConfig.ServerConfig, (config) => ({
          ...config,
          robobBuildCommit: "current-build",
        })),
      ).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-kanban-retries-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(ServerSettings.layerTest()),
          ),
        ),
      ),
    ),
  );

const owner: KanbanActor = { _tag: "owner" };
const START = Date.parse("2026-11-10T10:00:00.000Z");
const pastBackoff = TestClock.adjust(Retries.RETRY_BACKOFF_MS + 1_000);

/** A board with one work slot and a one-step review chain, and a card its worker has started. */
const workingCard = Effect.gen(function* () {
  yield* TestClock.setTime(START);
  const kanban = yield* KanbanService.KanbanService;
  const made = yield* kanban.ensureBoard({
    slug: "retries",
    name: "Retries",
    defaultProjectId: ProjectId.make("project-1"),
  });
  const board = yield* kanban.updateBoard(made.id, {
    reviewChains: [{ name: "Standard", steps: [made.evaluatorModel] }],
    defaultReviewChain: "Standard",
  });
  yield* kanban.setPool(board.id, board.defaultCardModel, 1);
  const created = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
  yield* kanban.dispatchNow;
  const card = (yield* kanban.card(created.id)).card;
  const thread = card.activeThreadId!;
  assert.strictEqual(card.stage, "working");
  const now = kanban.card(created.id);
  return { kanban, board, card, thread, now };
});

/** The same card handed to review, with its reviewer started. */
const reviewingCard = Effect.gen(function* () {
  const { kanban, board, card, thread, now } = yield* workingCard;
  yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
    _tag: "thread",
    threadId: thread,
  });
  yield* kanban.turnEnded(thread);
  yield* kanban.dispatchNow;
  const reviewer = (yield* now).card.activeThreadId!;
  assert.notStrictEqual(reviewer, thread);
  assert.strictEqual((yield* now).card.stage, "in_review");
  return { kanban, board, card, reviewer, now };
});

const retriesOf = (card: KanbanCard) =>
  (card.retries ?? []).map((retry) => `${retry.kind}/${retry.role}/${retry.state}`);

const admission = {
  queuedAtMs: START,
  waitedMs: 30 * 60_000,
  positionAtFailure: 2,
  totalAtFailure: 3,
  rule: "no_progress" as const,
};

it.effect.each(["notification", "persisted failure"] as const)(
  "restart failure retains admission details in the stored card event through %s",
  (edge) => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      fake.fail(thread, {
        code: "restart_admission_timeout",
        runId: "run:expired",
        message: "Restart admission expired",
        admission,
      });
      const timeout = {
        runId: "run:expired",
        reason: "Restart admission expired",
        restartAdmission: true,
        admission,
      };
      yield* kanban.turnEnded(thread, edge === "notification" ? timeout : undefined);
      yield* kanban.turnEnded(thread, timeout);
      const detail = yield* now;
      assert.strictEqual(detail.card.stage, "todo");
      assert.include(detail.card.stalled!.reason, "Run failed: Restart admission expired");
      const flags = detail.events.filter((event) => event.kind === "flagged");
      assert.lengthOf(flags, 1);
      assert.deepStrictEqual(flags[0]?.admission, admission);
      assert.strictEqual(flags[0]?.runId, "run:expired");
      assert.strictEqual(flags[0]?.failedThreadId, thread);
      assert.include(flags[0]!.body!, "Run: run:expired");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  },
);

it.effect.each(["work", "review"] as const)(
  "%s retry and stall events preserve the failed run's admission context",
  (role) => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const context = yield* role === "work" ? workingCard : reviewingCard;
      const thread = "reviewer" in context ? context.reviewer : context.thread;
      fake.fail(thread, { runId: "run:retry", admission });
      yield* context.kanban.turnEnded(thread);
      const retry = (yield* context.now).events.findLast((event) =>
        event.body?.startsWith("Run failed, retrying once:"),
      );
      assert.strictEqual(retry?.runId, "run:retry");
      assert.strictEqual(retry?.failedThreadId, thread);
      assert.deepStrictEqual(retry?.admission, admission);
      yield* pastBackoff;
      yield* context.kanban.tick;
      fake.fail(thread, { runId: "run:stalled", admission });
      yield* context.kanban.turnEnded(thread);
      const flagged = (yield* context.now).events.findLast((event) => event.kind === "flagged");
      assert.strictEqual(flagged?.runId, "run:stalled");
      assert.strictEqual(flagged?.failedThreadId, thread);
      assert.deepStrictEqual(flagged?.admission, admission);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  },
);

it.effect.each(["work", "review"] as const)(
  "%s fresh-thread failure events preserve admission context",
  (role) => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const context = yield* role === "work" ? workingCard : reviewingCard;
      const thread = "reviewer" in context ? context.reviewer : context.thread;
      fake.fail(thread, {
        runId: "run:fresh",
        message: "Insufficient context allowance for the provider handoff.",
        admission,
      });
      yield* context.kanban.turnEnded(thread);
      const detail = yield* context.now;
      assert.strictEqual(
        role === "work" ? detail.card.workThreadId : detail.card.reviewThreadId,
        null,
      );
      const moved = detail.events.findLast((event) => event.kind === "moved");
      assert.strictEqual(moved?.runId, "run:fresh");
      assert.strictEqual(moved?.failedThreadId, thread);
      assert.deepStrictEqual(moved?.admission, admission);
      assert.include(moved!.body!, "Insufficient context allowance for the provider handoff.");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  },
);

it.effect.each(["working", "todo", "reassigned"] as const)(
  "start timeout flags the owning card after queue promotion: %s",
  (state) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, thread, now } = yield* workingCard;
        if (state !== "working") {
          fake.fail(thread);
          yield* kanban.turnEnded(thread);
        }
        if (state === "reassigned") {
          const store = yield* KanbanStore.KanbanStore;
          const current = (yield* now).card;
          yield* store.putCard({ ...current, workThreadId: ThreadId.make("replacement-thread") });
        }
        // The FIFO successor is active before the board consumes the expired start.
        yield* fake.start(thread);
        const sent = fake.messages(thread).length;
        yield* kanban.turnEnded(thread, {
          runId: "expired-start",
          reason: "The provider never started this run (waited 10 min).",
        });
        const result = (yield* now).card;
        if (state === "reassigned") assert.isNull(result.stalled);
        else {
          assert.include(result.stalled?.reason ?? "", "never started");
          assert.equal(result.stage, "todo");
          assert.isNull(result.activePool);
          assert.isNull(result.activeThreadId);
          assert.equal(result.workThreadId, thread);
        }
        assert.deepEqual(fake.interrupted, []);
        assert.equal(fake.messages(thread).length, sent);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "a worker's first failed run is not flagged: the card waits in To-Do with no slot, then the same thread is woken once",
  () =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, thread, now } = yield* workingCard;
        fake.fail(thread);
        yield* kanban.turnEnded(thread);

        let detail = yield* now;
        assert.strictEqual(detail.card.stage, "todo");
        assert.isNull(detail.card.stalled);
        assert.isNull(detail.card.activeThreadId);
        assert.isNull(detail.card.activePool);
        assert.strictEqual(detail.card.workThreadId, thread);
        // Back in the queue it keeps the age it had.
        assert.strictEqual(detail.card.movedAt, card.movedAt);
        assert.deepStrictEqual(retriesOf(detail.card), ["run_failed/work/waiting"]);
        assert.strictEqual(kanbanRetrying(detail.card)?.reason, "upstream closed the stream");
        assert.strictEqual(kanbanRetryNotBefore(detail.card), START + Retries.RETRY_BACKOFF_MS);
        assert.isTrue(
          detail.events.some(
            (event) =>
              event.kind === "moved" &&
              event.fromStage === "working" &&
              event.toStage === "todo" &&
              event.body === "Run failed, retrying once: upstream closed the stream",
          ),
        );
        assert.isFalse(detail.events.some((event) => event.kind === "flagged"));

        // Inside the backoff neither dispatch, the tick nor the failed run reported again starts it.
        const sent = fake.messages(thread).length;
        yield* kanban.dispatchNow;
        yield* TestClock.adjust("30 seconds");
        yield* kanban.tick;
        yield* kanban.turnEnded(thread);
        detail = yield* now;
        assert.strictEqual(detail.card.stage, "todo");
        assert.isNull(detail.card.stalled);
        assert.deepStrictEqual(retriesOf(detail.card), ["run_failed/work/waiting"]);
        assert.lengthOf(fake.messages(thread), sent);
        assert.lengthOf(
          detail.events.filter((event) => event.body?.startsWith("Run failed, retrying once")),
          1,
        );

        // Past it, the tick's dispatch wakes the same thread like any other start.
        yield* pastBackoff;
        yield* kanban.tick;
        detail = yield* now;
        assert.strictEqual(detail.card.stage, "working");
        assert.strictEqual(detail.card.activeThreadId, thread);
        assert.strictEqual(detail.card.workThreadId, thread);
        assert.isNull(detail.card.stalled);
        assert.deepStrictEqual(retriesOf(detail.card), ["run_failed/work/waiting"]);
        assert.isFalse(detail.events.some((event) => event.kind === "flagged"));
        const wake = fake.messages(thread).at(-1) ?? "";
        assert.lengthOf(fake.messages(thread), sent + 1);
        assert.include(wake, `Card #${card.number} is back with you.`);
        assert.include(wake, 'Your last run on this card failed: "upstream closed the stream"');
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("the second failed run flags the card as before", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      yield* pastBackoff;
      yield* kanban.tick;
      assert.strictEqual((yield* now).card.stage, "working");

      fake.fail(thread, { message: "upstream closed the stream again" });
      yield* kanban.turnEnded(thread);
      const detail = yield* now;
      assert.strictEqual(detail.card.stage, "todo");
      assert.strictEqual(
        detail.card.stalled?.reason,
        "Run failed: upstream closed the stream again",
      );
      assert.isNull(detail.card.activeThreadId);
      assert.strictEqual(detail.card.workThreadId, thread);
      assert.isUndefined(detail.card.retries);
      assert.isUndefined(kanbanRetrying(detail.card));
      assert.lengthOf(
        detail.events.filter((event) => event.kind === "flagged"),
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a turn that ends normally resets the count: the next failure is retried again", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      yield* pastBackoff;
      yield* kanban.tick;
      assert.deepStrictEqual(retriesOf((yield* now).card), ["run_failed/work/waiting"]);

      // The restarted run is a good one; its turn ends without a move, so the worker is nudged.
      fake.recover(thread);
      yield* kanban.turnEnded(thread);
      let card = (yield* now).card;
      assert.isUndefined(card.retries);
      assert.isNotNull(card.nudgedAt);
      assert.strictEqual(card.stage, "working");

      fake.fail(thread, { message: "second outage of the day" });
      yield* kanban.turnEnded(thread);
      card = (yield* now).card;
      assert.isNull(card.stalled);
      assert.strictEqual(card.stage, "todo");
      assert.deepStrictEqual(retriesOf(card), ["run_failed/work/waiting"]);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a real move resets the count too", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, card, thread, now } = yield* workingCard;
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      assert.deepStrictEqual(retriesOf((yield* now).card), ["run_failed/work/waiting"]);
      // The owner takes the card over while it waits for its retry.
      const pulled = yield* kanban.moveCard(card.id, "needs_owner", "owner", owner);
      assert.isUndefined(pulled.retries);
      assert.isNull(pulled.stalled);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a restart that starts no new run is flagged once it has had time to", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      yield* pastBackoff;
      yield* kanban.tick;
      assert.strictEqual((yield* now).card.stage, "working");
      // The wake went out but the old failed run is still the thread's latest.
      yield* kanban.turnEnded(thread);
      assert.isNull((yield* now).card.stalled);
      assert.strictEqual((yield* now).card.stage, "working");
      yield* TestClock.adjust(Retries.RETRY_SETTLE_MS);
      yield* kanban.turnEnded(thread);
      assert.strictEqual(
        (yield* now).card.stalled?.reason,
        "Run failed: upstream closed the stream",
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a card waiting out its retry costs the tick no thread read and no card write", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      const before = yield* now;
      const reads = fake.readsOf(thread);

      for (let tick = 0; tick < 3; tick += 1) {
        yield* TestClock.adjust("15 seconds");
        yield* kanban.tick;
      }
      const after = yield* now;
      assert.strictEqual(fake.readsOf(thread), reads);
      assert.deepStrictEqual(after.card, before.card);
      assert.lengthOf(after.events, before.events.length);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the silent-run backstop still stops a retry after its backoff ends", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      yield* pastBackoff;
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* now).card.activeThreadId, thread);
      assert.deepStrictEqual(retriesOf((yield* now).card), ["run_failed/work/waiting"]);

      yield* fake.start(thread);
      yield* TestClock.adjust(Rules.RUN_SILENT_MS + 1);
      yield* kanban.tick;
      assert.deepStrictEqual(fake.interrupted, [thread]);
      assert.isTrue(
        (yield* now).events.some((event) => event.body?.startsWith("No activity for 30 min")),
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a worker self-parks through turn end and its deadline wakes it exactly once", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, card, thread, now } = yield* workingCard;
      yield* fake.start(thread);
      const actor = { _tag: "thread", threadId: thread } as const;
      const sent = fake.messages(thread).length;
      yield* kanban.waitCard(
        card.id,
        {
          on: "time",
          until: DateTime.formatIso(DateTime.makeUnsafe(START + 60_000)),
          note: "offbox watcher fallback",
        },
        actor,
      );
      const pending = yield* now;
      assert.strictEqual(pending.card.stage, "working");
      assert.strictEqual(pending.card.activeThreadId, thread);
      const events = pending.events.filter((event) => Waits.waitEventOf(event) === "set");
      assert.lengthOf(events, 1);
      assert.deepStrictEqual(events[0]?.actor, actor);
      assert.include(events[0]?.body ?? "", "2026-11-10T10:01:00.000Z");
      const store = yield* KanbanStore.KanbanStore;
      assert.strictEqual((yield* store.threadLink(thread))?.role, "work");
      fake.finish(thread);
      yield* kanban.turnEnded(thread);
      yield* kanban.turnEnded(thread);
      const parked = (yield* now).card;
      assert.strictEqual(parked.stage, "todo");
      assert.isNull(parked.activeThreadId);
      assert.strictEqual(parked.wait?.on, "time");
      yield* kanban.dispatchNow;
      assert.lengthOf(fake.messages(thread), sent);
      yield* TestClock.adjust("1 minute");
      yield* kanban.tick;
      yield* kanban.dispatchNow;
      assert.isUndefined((yield* now).card.wait);
      assert.strictEqual((yield* now).card.activeThreadId, thread);
      assert.lengthOf(fake.messages(thread), sent + 1);
      assert.include(fake.messages(thread).at(-1) ?? "", "offbox watcher fallback");
      yield* fake.start(thread);
      yield* kanban.tick;
      assert.lengthOf(fake.messages(thread), sent + 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a steer preserves a worker wait until it clears it, then normal nudges resume", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, card, thread, now } = yield* workingCard;
      yield* fake.start(thread);
      const actor = { _tag: "thread", threadId: thread } as const;
      yield* kanban.waitCard(
        card.id,
        {
          on: "time",
          until: DateTime.formatIso(DateTime.makeUnsafe(START + 60_000)),
          note: "offbox watcher fallback",
        },
        actor,
      );
      fake.finish(thread);
      yield* kanban.turnEnded(thread);
      const wait = (yield* now).card.wait;
      yield* kanban.cardThread(card.id, "steer", "A partial result arrived", owner);
      yield* TestClock.adjust(1);
      yield* fake.start(thread);
      assert.deepStrictEqual((yield* now).card.wait, wait);
      fake.finish(thread);
      const sent = fake.messages(thread).length;
      yield* kanban.turnEnded(thread);
      assert.lengthOf(fake.messages(thread), sent);
      yield* TestClock.adjust(1);
      yield* fake.start(thread);
      yield* kanban.waitCard(card.id, null, actor);
      assert.isUndefined((yield* now).card.wait);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* now).card.activeThreadId, thread);
      // A late script answer cannot wake a wait the worker already cleared.
      const late = yield* kanban
        .answerWait(
          card.id,
          { result: "wake", note: "late result" },
          { script: null },
          { _tag: "system", component: "test" },
          true,
        )
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(late));
      fake.finish(thread);
      yield* kanban.turnEnded(thread);
      assert.lengthOf(fake.messages(thread), sent + 1);
      assert.include(fake.messages(thread).at(-1) ?? "", "still in Working");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the silent-run backstop still stops a worker after its parked wait ends", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, card, thread, now } = yield* workingCard;
      yield* kanban.moveCard(card.id, "todo", "owner", owner);
      yield* kanban.waitCard(
        card.id,
        {
          on: "time",
          until: DateTime.formatIso(DateTime.makeUnsafe(START + 60_000)),
          note: "Wait a minute",
          wakeRole: "work",
        },
        owner,
      );
      assert.isTrue(kanbanWaiting((yield* now).card));
      yield* TestClock.adjust("1 minute");
      yield* kanban.tick;
      yield* kanban.dispatchNow;
      assert.isUndefined((yield* now).card.wait);
      assert.strictEqual((yield* now).card.activeThreadId, thread);

      yield* fake.start(thread);
      yield* TestClock.adjust(Rules.RUN_SILENT_MS + 1);
      yield* kanban.tick;
      assert.deepStrictEqual(fake.interrupted, [thread]);
      assert.isTrue(
        (yield* now).events.some((event) => event.body?.startsWith("No activity for 30 min")),
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each(["retry", "wait"] as const)(
  "a detached steer ends its %s hold so the silent-run backstop can stop the run",
  (hold) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, thread, now } = yield* workingCard;
        if (hold === "retry") {
          fake.fail(thread);
          yield* kanban.turnEnded(thread);
        } else {
          yield* kanban.moveCard(card.id, "todo", "owner", owner);
          yield* kanban.waitCard(
            card.id,
            {
              on: "time",
              until: DateTime.formatIso(DateTime.makeUnsafe(START + 24 * 60 * 60_000)),
              note: "Tomorrow",
              wakeRole: "work",
            },
            owner,
          );
        }
        yield* kanban.cardThread(card.id, "steer", "Carry on now", owner);
        const steered = (yield* now).card;
        assert.isNull(steered.activeThreadId);
        assert.isUndefined(steered.wait);
        assert.isUndefined(steered.retries);
        yield* fake.start(thread);
        // The detached run is read even before a retry's original deadline.
        const reads = fake.readsOf(thread);
        yield* kanban.tick;
        assert.isAbove(fake.readsOf(thread), reads);
        assert.deepStrictEqual(fake.interrupted, []);
        yield* TestClock.adjust(Rules.RUN_SILENT_MS + 1);
        yield* kanban.tick;
        assert.deepStrictEqual(fake.interrupted, [thread]);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each(["wait", "retry", "thread"] as const)(
  "a detached steer preserves a replacement %s created during delivery",
  (replacement) =>
    Effect.gen(function* () {
      const fake = makeFake();
      const entered = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      fake.sendControl.beforeSend = (text) =>
        text === "Carry on now"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(delivered)))
          : Effect.void;
      yield* Effect.gen(function* () {
        const { kanban, card, thread, now } = yield* workingCard;
        const store = yield* KanbanStore.KanbanStore;
        if (replacement === "retry") {
          fake.fail(thread);
          yield* kanban.turnEnded(thread);
        } else {
          yield* kanban.moveCard(card.id, "todo", "owner", owner);
          yield* kanban.waitCard(
            card.id,
            { on: "time", until: "2026-11-11T10:00:00.000Z", note: "Tomorrow" },
            owner,
          );
        }
        const steering = yield* Effect.forkChild(
          kanban.cardThread(card.id, "steer", "Carry on now", owner),
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust("1 second");
        if (replacement === "wait") {
          yield* kanban.waitCard(
            card.id,
            { on: "time", until: "2026-11-12T10:00:00.000Z", note: "Later" },
            owner,
          );
        } else {
          const current = (yield* now).card;
          const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
          yield* store.putCard({
            ...current,
            ...(replacement === "thread"
              ? { workThreadId: ThreadId.make("replacement-thread") }
              : {
                  retries: current.retries!.map((entry) => ({
                    ...entry,
                    runId: "replacement-run",
                    at,
                  })),
                }),
          });
        }
        const changed = (yield* now).card;
        yield* Deferred.succeed(delivered, undefined);
        yield* Fiber.join(steering);
        const steered = (yield* now).card;
        if (replacement === "thread") {
          assert.deepStrictEqual(steered, changed);
          assert.isUndefined(steered.detachedSteerAt);
        } else {
          const deliveredAt = DateTime.formatIso(
            DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
          );
          assert.deepStrictEqual(steered, {
            ...changed,
            detachedSteerAt: deliveredAt,
            nudgedAt: null,
            updatedAt: deliveredAt,
          });
          yield* fake.start(thread);
          if (replacement === "wait") assert.isTrue(kanbanWaiting((yield* now).card));
          yield* TestClock.adjust(Rules.RUN_SILENT_MS + 1);
          yield* kanban.tick;
          assert.deepStrictEqual(fake.interrupted, [thread]);
          yield* kanban.turnEnded(thread);
          const reads = fake.readsOf(thread);
          yield* kanban.tick;
          if (replacement === "wait") assert.strictEqual(fake.readsOf(thread), reads);
        }
      }).pipe(
        Effect.ensuring(Deferred.succeed(delivered, undefined)),
        Effect.provide(testLayer(fake.layer)),
      );
    }),
);

it.effect.each(["running", "idle"] as const)(
  "a parked steer's signal survives a delayed turn end only while its thread is %s",
  (state) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, thread, now } = yield* workingCard;
        yield* kanban.moveCard(card.id, "todo", "owner", owner);
        yield* kanban.cardThread(card.id, "steer", "Carry on now", owner);
        yield* fake.start(thread);
        yield* kanban.waitCard(
          card.id,
          { on: "time", until: "2026-11-12T10:00:00.000Z", note: "Later" },
          owner,
        );
        const before = (yield* now).card;
        assert.isDefined(before.detachedSteerAt);
        if (state === "idle") fake.finish(thread);
        yield* kanban.turnEnded(thread);
        assert.deepStrictEqual((yield* now).card.wait, before.wait);
        if (state === "running") {
          assert.strictEqual((yield* now).card.detachedSteerAt, before.detachedSteerAt);
          yield* TestClock.adjust(Rules.RUN_SILENT_MS + 1);
          yield* kanban.tick;
          assert.deepStrictEqual(fake.interrupted, [thread]);
        } else {
          assert.isUndefined((yield* now).card.detachedSteerAt);
          const reads = fake.readsOf(thread);
          for (let tick = 0; tick < 3; tick += 1) {
            yield* TestClock.adjust("15 seconds");
            yield* kanban.tick;
          }
          assert.strictEqual(fake.readsOf(thread), reads);
          assert.deepStrictEqual(fake.interrupted, []);
        }
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

const deferredDiscussion = Effect.gen(function* () {
  const fixture = yield* workingCard;
  const store = yield* KanbanStore.KanbanStore;
  const discussion = yield* fixture.kanban.cardDiscussion(fixture.card.id);
  const deferred = {
    ...discussion,
    participants: [
      {
        actor: { _tag: "thread" as const, threadId: fixture.thread },
        name: "Worker",
        owes: "asked" as const,
        typingUntil: null,
        lastReadSeq: 0,
        deferred: true,
        deferredKey: "original-ask",
      },
    ],
  };
  yield* store.putDiscussion(deferred);
  return { ...fixture, store, discussion: deferred };
});

it.effect.each(["unchanged", "answered", "new ask", "read", "archived", "paused"] as const)(
  "#1412 a write commits during a blocked reminder; record rechecks %s",
  (change) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, board, card, thread, store, discussion } = yield* deferredDiscussion;
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        fake.sendControl.beforeSend = (text) =>
          text.includes("The owner is waiting")
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
            : Effect.void;
        const tick = yield* kanban.tick.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        // Joining this write before releasing the send proves lock admission, without a clock race.
        yield* kanban.editCard(card.id, { title: "Edited during send" }, owner);
        assert.strictEqual((yield* kanban.card(card.id)).card.title, "Edited during send");
        const participant = discussion.participants[0]!;
        const patched =
          change === "answered"
            ? { ...participant, owes: null, deferred: false }
            : change === "new ask"
              ? { ...participant, deferredKey: "new-ask" }
              : change === "read"
                ? { ...participant, lastReadSeq: 1 }
                : participant;
        if (change === "paused") {
          const fresh = (yield* store.board(board.id))!;
          yield* store.putBoard({
            ...fresh,
            pause: {
              keep: [],
              at: discussion.createdAt,
              reason: "Paused during send",
              by: "owner",
            },
          });
        } else if (change !== "unchanged") {
          yield* store.putDiscussion({
            ...discussion,
            participants: [patched],
            ...(change === "archived" ? { archivedAt: discussion.createdAt } : {}),
          });
        }
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(tick);
        const result = (yield* store.discussion(discussion.id))!;
        if (change === "unchanged") {
          assert.strictEqual(result.participants[0]!.owes, "nudged");
          yield* kanban.tick;
          assert.lengthOf(
            fake.messages(thread).filter((text) => text.includes("The owner is waiting")),
            1,
          );
        } else assert.deepStrictEqual(result.participants, [patched]);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each([
  "delivered",
  "later status",
  "read status",
  "legacy zero",
  "legacy read status",
  "missing message",
] as const)("#1412 reminder sends are capped at ten and oldest asks go first (%s)", (shape) =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, card, thread, store, discussion } = yield* deferredDiscussion;
      yield* store.putDiscussion({ ...discussion, participants: [] });
      const link = (yield* store.threadLink(thread))!;
      const targets: ThreadId[] = [];
      // Insert newest first; later status posts also run in the opposite age order.
      for (let i = 14; i >= 0; i--) {
        const target = ThreadId.make(`cap-${i}`);
        targets.unshift(target);
        fake.cloneThread(target, thread);
        const id = KanbanDiscussionId.make(`cap-disc-${i}`);
        const assigned = yield* kanban.createCard(
          discussion.boardId,
          { prompt: `Work ${i}`, title: `Work ${i}` },
          owner,
        );
        yield* store.putCard({
          ...assigned,
          stage: "working",
          activeThreadId: target,
          workThreadId: target,
          activeRole: "work",
          activePool: card.activePool,
          discussionId: id,
        });
        yield* store.putThreadLink({
          ...link,
          threadId: target,
          cardId: assigned.id,
          discussionId: id,
        });
        yield* store.putDiscussion({
          ...discussion,
          id,
          cardId: assigned.id,
          lastSeq: 0,
          participants: [
            {
              ...discussion.participants[0]!,
              actor: { _tag: "thread", threadId: target },
              owes: null,
              deferred: false,
            },
          ],
        });
        const ask = yield* kanban.post(id, owner, [{ _tag: "md", text: "Question" }]);
        const delivered = (yield* store.discussion(id))!;
        const participant = delivered.participants.find(
          (p) => p.actor._tag === "thread" && p.actor.threadId === target,
        )!;
        assert.strictEqual(participant.lastReadSeq, ask.seq);
        assert.strictEqual(participant.askedSeq, ask.seq);
        assert.strictEqual(participant.owes, "asked");
        const askedAt = DateTime.formatIso(DateTime.makeUnsafe(START + i * 1000));
        yield* store.putMessage({ ...ask, createdAt: askedAt });
        let lastMessageAt = askedAt;
        if (shape !== "delivered") {
          lastMessageAt = DateTime.formatIso(DateTime.makeUnsafe(START + (30 - i) * 1000));
          yield* store.putMessage({
            ...ask,
            seq: ask.seq + 1,
            createdAt: lastMessageAt,
            author: { _tag: "system", component: "status" },
            authorName: "Status",
            blocks: [{ _tag: "md", text: "Status update" }],
          });
        }
        const { askedSeq: _askedSeq, ...legacyParticipant } = participant;
        const legacy = shape === "legacy zero" || shape === "legacy read status";
        yield* store.putDiscussion({
          ...delivered,
          createdAt: askedAt,
          lastMessageAt,
          lastSeq: shape === "missing message" ? 99 : ask.seq + (shape === "delivered" ? 0 : 1),
          participants: [
            {
              ...(legacy ? legacyParticipant : participant),
              ...(shape === "missing message" ? { askedSeq: 99 } : {}),
              deferred: true,
              deferredKey: id,
              lastReadSeq: shape === "legacy zero" ? 0 : shape === "missing message" ? 99 : ask.seq,
            },
          ],
        });
        if (shape === "read status" || shape === "legacy read status") {
          yield* kanban.markRead(id, { _tag: "thread", threadId: target }, ask.seq + 1);
          const read = (yield* store.discussion(id))!.participants[0]!;
          assert.strictEqual(read.lastReadSeq, ask.seq + 1);
          assert.strictEqual(read.askedSeq, legacy ? undefined : ask.seq);
          assert.strictEqual(read.owes, "asked");
          assert.strictEqual(read.deferred, true);
        }
      }
      const counts = () =>
        targets.map(
          (id) => fake.messages(id).filter((text) => text.includes("The owner is waiting")).length,
        );
      yield* kanban.tick;
      assert.deepStrictEqual(counts(), [...Array(10).fill(1), ...Array(5).fill(0)]);
      yield* kanban.tick;
      assert.deepStrictEqual(counts(), Array(15).fill(1));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("#1412 the discussion collection read does not own the board lock", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let blocked = false;
    const wrapped = Layer.effect(
      KanbanStore.KanbanStore,
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        return {
          ...store,
          openDiscussions: (id: KanbanBoardId) =>
            Effect.gen(function* () {
              if (blocked) {
                blocked = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(resume);
              }
              return yield* store.openDiscussions(id);
            }),
        };
      }),
    ).pipe(Layer.provide(KanbanStore.layer));
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, card } = yield* workingCard;
      blocked = true;
      const tick = yield* kanban.tick.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* kanban.editCard(card.id, { title: "Read is outside" }, owner);
      assert.strictEqual((yield* kanban.card(card.id)).card.title, "Read is outside");
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(tick);
    }).pipe(Effect.provide(testLayer(fake.layer, wrapped)));
  }),
);

it.effect("a script post keeps its reply reminder without an owner message", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, card, thread } = yield* workingCard;
      const store = yield* KanbanStore.KanbanStore;
      const discussion = yield* kanban.cardDiscussion(card.id);
      const script = { _tag: "script" as const, scriptId: KanbanScriptId.make("script-reminder") };
      yield* kanban.post(discussion.id, script, [{ _tag: "md", text: "Please check this result" }]);
      const obligation = yield* store.ownerReply(discussion.id, thread, false);
      assert.isNotNull(obligation);
      assert.isFalse(obligation!.answered);
      const action = yield* ownerReplyPending(store, discussion.id, thread);
      assert.strictEqual(action, obligation!.key);
      yield* kanban.post(discussion.id, { _tag: "system", component: "scribe" }, [
        { _tag: "md", text: "Status" },
      ]);
      const sent = fake.messages(thread).length;
      yield* kanban.turnEnded(thread);
      assert.deepStrictEqual(fake.messages(thread).slice(sent), [
        `The owner is waiting for your reply in discussion ${discussion.id}. Post it with discussion_post.`,
      ]);
      assert.strictEqual(yield* ownerReplyPending(store, discussion.id, thread), action);
      yield* kanban.post(discussion.id, { _tag: "thread", threadId: thread }, [
        { _tag: "md", text: "Checked" },
      ]);
      assert.isNull(yield* ownerReplyPending(store, discussion.id, thread));
      yield* kanban.post(discussion.id, script, [
        { _tag: "md", text: "Please check the next result" },
      ]);
      assert.isNotNull(yield* ownerReplyPending(store, discussion.id, thread));
      assert.notStrictEqual(yield* ownerReplyPending(store, discussion.id, thread), action);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each(["retry", "wait"] as const)(
  "discussion reminders stay deferred while a released worker is held by a %s",
  (hold) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, thread, now } = yield* workingCard;
        const store = yield* KanbanStore.KanbanStore;
        const discussion = yield* kanban.cardDiscussion(card.id);
        if (hold === "retry") {
          fake.fail(thread);
          yield* kanban.turnEnded(thread);
          fake.recover(thread);
        } else {
          yield* kanban.moveCard(card.id, "todo", "owner", owner);
          yield* kanban.waitCard(
            card.id,
            { on: "time", until: "2026-11-11T10:00:00.000Z", note: "Tomorrow" },
            owner,
          );
        }
        yield* store.putDiscussion({
          ...discussion,
          participants: [
            ...discussion.participants.filter((participant) => participant.actor._tag !== "thread"),
            {
              actor: { _tag: "thread", threadId: thread },
              name: "Worker",
              owes: "asked",
              typingUntil: null,
              lastReadSeq: 0,
            },
          ],
        });
        const sent = fake.messages(thread).length;
        yield* kanban.turnEnded(thread);
        const participant = (yield* kanban.discussion(discussion.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        );
        assert.isTrue(participant?.deferred);
        assert.strictEqual(fake.messages(thread).length, sent);
        const reads = fake.readsOf(thread);
        yield* TestClock.adjust("15 seconds");
        yield* kanban.tick;
        assert.strictEqual(fake.messages(thread).length, sent);
        assert.strictEqual(fake.readsOf(thread), reads);

        if (hold === "retry") yield* pastBackoff;
        else yield* kanban.waitCard(card.id, null, owner);
        yield* kanban.tick;
        assert.isTrue(
          fake
            .messages(thread)
            .some((text) => text.includes("The owner is waiting for your reply")),
        );
        assert.isUndefined((yield* now).card.wait);
        yield* fake.start(thread);
        yield* TestClock.adjust(Rules.RUN_SILENT_MS + 1);
        yield* kanban.tick;
        assert.deepStrictEqual(fake.interrupted, [thread]);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each(["retry", "wait"] as const)(
  "an attached silent run is still stopped with a stale %s hold",
  (hold) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, thread, now } = yield* workingCard;
        const store = yield* KanbanStore.KanbanStore;
        yield* fake.start(thread);
        yield* TestClock.adjust(Rules.RUN_SILENT_MS + 1);
        const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const card = (yield* now).card;
        yield* store.putCard({
          ...card,
          ...(hold === "retry"
            ? {
                retries: [
                  {
                    kind: "run_failed" as const,
                    role: "work" as const,
                    state: "waiting" as const,
                    runId: "old-run",
                    reason: "Old failure",
                    at,
                  },
                ],
              }
            : {
                wait: Waits.newWait(
                  {
                    on: "time",
                    note: "Old wait",
                    until: DateTime.formatIso(DateTime.makeUnsafe(START + 24 * 60 * 60_000)),
                    wakeRole: "work",
                  },
                  owner,
                  at,
                ),
              }),
        });
        yield* kanban.tick;
        assert.deepStrictEqual(fake.interrupted, [thread]);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each(["work nudge", "discussion reminder", "thread discussion"] as const)(
  "a parked sibling does not suppress the active card's %s",
  (reminder) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, thread } = yield* workingCard;
        const store = yield* KanbanStore.KanbanStore;
        const sibling = yield* kanban.createForThread(thread, { prompt: "B", title: "B" });
        const parkedTalk = yield* kanban.cardDiscussion(card.id);
        const activeTalk = yield* kanban.cardDiscussion(sibling.card.id);
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
          _tag: "thread",
          threadId: thread,
        });
        yield* kanban.waitCard(
          card.id,
          { on: "time", until: "2026-11-11T10:00:00.000Z", note: "Tomorrow" },
          owner,
        );
        const parked = (yield* kanban.card(card.id)).card;
        assert.strictEqual(parked.workThreadId, thread);
        assert.isTrue(kanbanWaiting(parked));
        const historical = (yield* store.threadLink(thread))!;
        yield* store.putThreadLink({ ...historical, cardId: card.id });
        const owe = (discussion: typeof parkedTalk) => ({
          ...discussion,
          participants: [
            {
              actor: { _tag: "thread" as const, threadId: thread },
              name: "Worker",
              owes: "asked" as const,
              typingUntil: null,
              lastReadSeq: 0,
            },
          ],
        });
        yield* store.putDiscussion(owe(parkedTalk));
        if (reminder !== "work nudge") {
          yield* store.putDiscussion({
            ...owe(activeTalk),
            ...(reminder === "thread discussion" ? { cardId: null } : {}),
          });
          if (reminder === "thread discussion") {
            const link = (yield* store.threadLink(thread))!;
            yield* store.putThreadLink({ ...link, discussionId: activeTalk.id });
          }
        }
        const sent = fake.messages(thread).length;
        yield* kanban.turnEnded(thread);
        const messages = fake.messages(thread).slice(sent);
        assert.lengthOf(messages, 1);
        assert.include(
          messages[0]!,
          reminder === "work nudge"
            ? "still in Working and your turn ended"
            : "The owner is waiting for your reply",
        );
        assert.isTrue(kanbanWaiting((yield* kanban.card(card.id)).card));
        assert.strictEqual((yield* kanban.card(sibling.card.id)).card.activeThreadId, thread);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

/** The one-slot board with a second card waiting for the slot the first one holds. */
const twoCards = Effect.gen(function* () {
  const { kanban, board, card, thread, now } = yield* workingCard;
  const second = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
  yield* kanban.dispatchNow;
  const other = kanban.card(second.id);
  assert.strictEqual((yield* other).card.stage, "todo");
  return { kanban, board, card, thread, now, other };
});

it.effect("the slot is free during the wait: another card starts in it", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, thread, now, other } = yield* twoCards;
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      yield* kanban.dispatchNow;

      const started = (yield* other).card;
      assert.strictEqual(started.stage, "working");
      assert.isNotNull(started.activeThreadId);
      assert.notStrictEqual(started.activeThreadId, thread);
      const waiting = (yield* now).card;
      assert.strictEqual(waiting.stage, "todo");
      assert.isNull(waiting.activeThreadId);
      assert.isNull(waiting.activePool);
      assert.isNull(waiting.stalled);
      assert.deepStrictEqual(retriesOf(waiting), ["run_failed/work/waiting"]);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a due card with no free slot waits without being flagged, and starts when one frees",
  () =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, thread, now, other } = yield* twoCards;
        fake.fail(thread);
        yield* kanban.turnEnded(thread);
        yield* kanban.dispatchNow;
        const otherThread = (yield* other).card.activeThreadId!;
        const sent = fake.messages(thread).length;

        // Due, and due for a long time: the only slot is taken, so it waits like any card.
        yield* pastBackoff;
        yield* kanban.tick;
        yield* TestClock.adjust("20 minutes");
        yield* kanban.tick;
        yield* kanban.turnEnded(thread);
        let detail = yield* now;
        assert.strictEqual(detail.card.stage, "todo");
        assert.isNull(detail.card.stalled);
        assert.deepStrictEqual(retriesOf(detail.card), ["run_failed/work/waiting"]);
        assert.isFalse(detail.events.some((event) => event.kind === "flagged"));
        assert.lengthOf(fake.messages(thread), sent);

        // The other card hands off to review. Reviews go first and this board reviews on
        // the same pool, so the retry still waits; it gets the slot when the review is done.
        yield* kanban.moveCard((yield* other).card.id, "needs_review", "cardThread", {
          _tag: "thread",
          threadId: otherThread,
        });
        yield* kanban.turnEnded(otherThread);
        yield* kanban.dispatchNow;
        const reviewer = (yield* other).card.activeThreadId!;
        assert.strictEqual((yield* other).card.stage, "in_review");
        assert.strictEqual((yield* now).card.stage, "todo");
        assert.isNull((yield* now).card.stalled);
        yield* kanban.reviewResult(reviewer, "clear", []);
        yield* kanban.turnEnded(reviewer);
        yield* kanban.dispatchNow;
        detail = yield* now;
        assert.strictEqual(detail.card.stage, "working");
        assert.strictEqual(detail.card.activeThreadId, thread);
        assert.isNull(detail.card.stalled);
        assert.include(
          fake.messages(thread).at(-1) ?? "",
          `Card #${card.number} is back with you.`,
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a board paused during the wait starts the retry when the pause lifts", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, board, thread, now } = yield* workingCard;
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      yield* kanban.pauseBoard(board.id, { reason: "Cutover", keep: [] }, owner);
      const sent = fake.messages(thread).length;

      yield* pastBackoff;
      yield* kanban.tick;
      yield* kanban.dispatchNow;
      let detail = yield* now;
      assert.strictEqual(detail.card.stage, "todo");
      assert.isNull(detail.card.stalled);
      assert.deepStrictEqual(retriesOf(detail.card), ["run_failed/work/waiting"]);
      assert.lengthOf(fake.messages(thread), sent);

      yield* kanban.pauseBoard(board.id, null, owner);
      yield* kanban.tick;
      detail = yield* now;
      assert.strictEqual(detail.card.stage, "working");
      assert.strictEqual(detail.card.activeThreadId, thread);
      assert.isNull(detail.card.stalled);
      assert.isFalse(detail.events.some((event) => event.kind === "flagged"));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const HOUR = 60 * 60_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

it.effect("a card parked on a wait is invisible to the retry backstops", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, card, thread, now } = yield* workingCard;
      // The owner takes the card off its worker and parks it; the worker's run then fails.
      yield* kanban.moveCard(card.id, "todo", "owner", owner);
      yield* kanban.waitCard(
        card.id,
        { on: "time", until: iso(START + 3 * HOUR), note: "after the audit" },
        owner,
      );
      const parked = (yield* now).card;
      assert.isTrue(kanbanWaiting(parked));
      assert.strictEqual(parked.workThreadId, thread);
      const sent = fake.messages(thread).length;
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      for (let turn = 0; turn < 4; turn += 1) {
        yield* TestClock.adjust("30 seconds");
        yield* kanban.tick;
      }
      const detail = yield* now;
      assert.strictEqual(detail.card.stage, "todo");
      assert.isNull(detail.card.stalled);
      assert.isUndefined(detail.card.retries);
      assert.isTrue(kanbanWaiting(detail.card));
      assert.lengthOf(fake.messages(thread), sent);
      assert.isFalse(
        detail.events.some(
          (event) => event.kind === "flagged" || event.body?.startsWith("Run failed"),
        ),
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a card held for its retry, with no wait, is invisible to the wait pass", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      const held = yield* now;
      for (let turn = 0; turn < 2; turn += 1) {
        yield* TestClock.adjust("20 seconds");
        yield* kanban.tick;
      }
      let detail = yield* now;
      // The wait pass wrote nothing: no wait, no wait event, the card as the retry left it.
      assert.deepStrictEqual(detail.card, held.card);
      assert.lengthOf(detail.events, held.events.length);
      assert.isUndefined(detail.card.wait);
      assert.isFalse(kanbanWaiting(detail.card));
      assert.isFalse(detail.events.some((event) => /^wait/i.test(event.body ?? "")));
      // And it does not keep the retry from starting.
      yield* pastBackoff;
      yield* kanban.tick;
      detail = yield* now;
      assert.strictEqual(detail.card.stage, "working");
      assert.strictEqual(detail.card.activeThreadId, thread);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a card held for its retry and parked on a wait: the wait holds it, then the retry runs",
  () =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, thread, now } = yield* workingCard;
        fake.fail(thread);
        yield* kanban.turnEnded(thread);
        yield* kanban.waitCard(
          card.id,
          { on: "time", until: iso(START + HOUR), note: "provider maintenance window" },
          owner,
        );
        const sent = fake.messages(thread).length;

        // The backoff is long over; the wait still holds the card.
        yield* TestClock.adjust("30 minutes");
        yield* kanban.tick;
        let detail = yield* now;
        assert.strictEqual(detail.card.stage, "todo");
        assert.isNull(detail.card.stalled);
        assert.isTrue(kanbanWaiting(detail.card));
        assert.deepStrictEqual(retriesOf(detail.card), ["run_failed/work/waiting"]);
        assert.lengthOf(fake.messages(thread), sent);

        // The wait ends: the same thread is woken, told about both.
        yield* TestClock.adjust("31 minutes");
        yield* kanban.tick;
        detail = yield* now;
        assert.strictEqual(detail.card.stage, "working");
        assert.strictEqual(detail.card.activeThreadId, thread);
        assert.isUndefined(detail.card.wait);
        assert.deepStrictEqual(retriesOf(detail.card), ["run_failed/work/waiting"]);
        const wake = fake.messages(thread).at(-1) ?? "";
        assert.include(wake, 'Your last run on this card failed: "upstream closed the stream"');
        assert.include(wake, "provider maintenance window");

        // It was still the card's one retry: the next failure flags.
        fake.fail(thread, { message: "upstream closed the stream again" });
        yield* kanban.turnEnded(thread);
        assert.strictEqual(
          (yield* now).card.stalled?.reason,
          "Run failed: upstream closed the stream again",
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("failures a retry can't help are flagged at once", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      fake.fail(thread, {
        code: "provider.no-route",
        message: "Variant unavailable for opus/gpt-6-astra: high",
      });
      yield* kanban.turnEnded(thread);
      const detail = yield* now;
      assert.match(detail.card.stalled?.reason ?? "", /^Run failed: Variant unavailable/);
      assert.strictEqual(detail.card.stage, "todo");
      assert.isUndefined(detail.card.retries);
      assert.isFalse(detail.events.some((event) => event.body?.startsWith("Run failed, retrying")));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const NO_RETRY_CASES: ReadonlyArray<{ readonly name: string; readonly patch: Partial<Failure> }> = [
  { name: "the provider says a retry won't help", patch: { retryable: false, message: "failed" } },
  { name: "the workspace is missing", patch: { message: "chdir: no such file or directory" } },
  { name: "the model is not allowed", patch: { category: "model_invalid", message: "refused" } },
  { name: "someone stopped the run", patch: { message: "Run interrupted by the owner" } },
];

it.effect.each(NO_RETRY_CASES)("flags at once when $name", ({ patch }) =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      fake.fail(thread, patch);
      yield* kanban.turnEnded(thread);
      const card = (yield* now).card;
      assert.isNotNull(card.stalled);
      assert.isUndefined(card.retries);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a paused board neither retries nor flags; the retry starts when the pause lifts", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, board, thread, now } = yield* workingCard;
      yield* kanban.pauseBoard(board.id, { reason: "Cutover", keep: [] }, owner);
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      yield* pastBackoff;
      yield* kanban.tick;
      let detail = yield* now;
      assert.isNull(detail.card.stalled);
      assert.isUndefined(detail.card.retries);
      assert.strictEqual(detail.card.stage, "working");
      assert.isFalse(detail.events.some((event) => event.body?.startsWith("Run failed")));

      // The pause lifts: the failed run is seen, and the card goes to wait out its backoff.
      yield* kanban.pauseBoard(board.id, null, owner);
      yield* kanban.tick;
      detail = yield* now;
      assert.isNull(detail.card.stalled);
      assert.strictEqual(detail.card.stage, "todo");
      assert.deepStrictEqual(retriesOf(detail.card), ["run_failed/work/waiting"]);
      yield* pastBackoff;
      yield* kanban.tick;
      detail = yield* now;
      assert.strictEqual(detail.card.stage, "working");
      assert.strictEqual(detail.card.activeThreadId, thread);
      assert.isNull(detail.card.stalled);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a reviewer's failed run is retried once on the same review thread, then flagged", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, reviewer, now } = yield* reviewingCard;
      fake.fail(reviewer);
      yield* kanban.turnEnded(reviewer);
      let detail = yield* now;
      const reviewStarted = detail.events.findLast((event) => event.toStage === "in_review")!.at;
      // Back in Needs review with no slot, keeping its place in the queue.
      assert.strictEqual(detail.card.stage, "needs_review");
      assert.isNull(detail.card.activeThreadId);
      assert.isNull(detail.card.activePool);
      assert.strictEqual(detail.card.reviewThreadId, reviewer);
      assert.strictEqual(detail.card.movedAt, reviewStarted);
      assert.isNull(detail.card.stalled);
      assert.deepStrictEqual(retriesOf(detail.card), ["run_failed/review/waiting"]);
      const sent = fake.messages(reviewer).length;
      yield* kanban.dispatchNow;
      yield* TestClock.adjust("30 seconds");
      yield* kanban.tick;
      assert.strictEqual((yield* now).card.stage, "needs_review");
      assert.lengthOf(fake.messages(reviewer), sent);

      yield* pastBackoff;
      yield* kanban.tick;
      detail = yield* now;
      assert.strictEqual(detail.card.stage, "in_review");
      assert.strictEqual(detail.card.activeThreadId, reviewer);
      assert.strictEqual(detail.card.reviewThreadId, reviewer);
      assert.deepStrictEqual(retriesOf(detail.card), ["run_failed/review/waiting"]);
      assert.include(
        fake.messages(reviewer).at(-1) ?? "",
        'Your last review run on this card failed: "upstream closed the stream"',
      );

      fake.fail(reviewer, { message: "upstream closed the stream again" });
      yield* kanban.turnEnded(reviewer);
      detail = yield* now;
      assert.strictEqual(detail.card.stage, "needs_review");
      assert.strictEqual(
        detail.card.stalled?.reason,
        "Run failed: upstream closed the stream again",
      );
      assert.isUndefined(detail.card.retries);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a reviewer without a verdict is nudged, then its review is started again once, then flagged",
  () =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, reviewer, now } = yield* reviewingCard;
        // First quiet turn end: the reminder, as before.
        yield* kanban.turnEnded(reviewer);
        let detail = yield* now;
        assert.isNotNull(detail.card.nudgedAt);
        assert.include(fake.messages(reviewer).at(-1) ?? "", "record your verdict");
        assert.isUndefined(detail.card.retries);

        // Second: no flag yet. The card goes back to Needs Review and the same reviewer is started again.
        yield* kanban.turnEnded(reviewer);
        detail = yield* now;
        assert.strictEqual(detail.card.stage, "needs_review");
        assert.isNull(detail.card.stalled);
        assert.isNull(detail.card.nudgedAt);
        assert.deepStrictEqual(retriesOf(detail.card), ["no_verdict/review/restarted"]);
        assert.isTrue(
          detail.events.some(
            (event) =>
              event.kind === "moved" &&
              event.body === "Reviewer stopped without a verdict, retrying once",
          ),
        );
        assert.strictEqual(
          detail.events.findLast((event) => event.body === Retries.NO_VERDICT_RESTARTED_EVENT)
            ?.failedThreadId,
          reviewer,
        );
        yield* kanban.dispatchNow;
        detail = yield* now;
        assert.strictEqual(detail.card.stage, "in_review");
        assert.strictEqual(detail.card.activeThreadId, reviewer);
        const brief = fake.messages(reviewer).at(-1) ?? "";
        assert.include(brief, "ended without a verdict");
        assert.include(brief, `Card #${card.number}`);

        // The restarted review gets its own reminder, and only then the flag.
        yield* kanban.turnEnded(reviewer);
        assert.isNull((yield* now).card.stalled);
        yield* kanban.turnEnded(reviewer);
        detail = yield* now;
        assert.strictEqual(detail.card.stage, "needs_review");
        assert.strictEqual(detail.card.stalled?.reason, "Reviewer stopped without a verdict");
        assert.strictEqual(
          detail.events.findLast((event) => event.kind === "flagged")?.failedThreadId,
          reviewer,
        );
        assert.isUndefined(detail.card.retries);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

// Current gate policy exempts review subtasks. Inject the historical approval denial
// at the store boundary so this exercises refusal recovery without changing that policy.
it.effect.each(["approval", "conflict", "early conflict"] as const)(
  "a %s refusal is recorded once and flags the review without a nudge or restart",
  (kind) =>
    Effect.gen(function* () {
      const fake = makeFake();
      let refuse = false;
      const reason =
        kind === "approval"
          ? "subtask s3 (secret) needs Abdullah's approval after 2026-11-13T17:42:20.609Z"
          : "Board changed during this operation. Re-read its state before retrying.";
      const denied = new KanbanError({
        code: kind === "approval" ? "denied" : "conflict",
        detail: reason,
      });
      const storeLayer = Layer.effect(
        KanbanStore.KanbanStore,
        Effect.map(KanbanStore.KanbanStore, (real) =>
          KanbanStore.KanbanStore.of({
            ...real,
            board: (id) =>
              Effect.suspend(() => {
                if (!refuse || kind === "early conflict") return real.board(id);
                refuse = false;
                return Effect.die(denied);
              }),
            threadLink: (id) =>
              Effect.suspend(() => {
                if (!refuse || kind !== "early conflict") return real.threadLink(id);
                refuse = false;
                return Effect.die(denied);
              }),
          }),
        ),
      ).pipe(Layer.provide(KanbanStore.layer));
      yield* Effect.gen(function* () {
        const { kanban, reviewer, now } = yield* reviewingCard;
        const before = (yield* now).card;
        const sent = fake.messages(reviewer).length;
        const head = "ae5250595442502b641614ae15e04d02bb7a1926";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          refuse = true;
          assert.strictEqual(
            yield* Effect.flip(
              kanban.reviewResult(
                reviewer,
                "clear",
                [],
                attempt === 0 ? head : ` ${head.toUpperCase()} `,
              ),
            ),
            denied,
          );
        }
        let detail = yield* now;
        assert.deepStrictEqual(detail.card, before);
        const events = detail.events.filter((event) =>
          event.body?.startsWith(Retries.REFUSED_VERDICT_PREFIX),
        );
        assert.lengthOf(events, 1);
        assert.deepStrictEqual(events[0]?.actor, { _tag: "thread", threadId: reviewer });
        assert.strictEqual(events[0]?.head, head);
        assert.strictEqual(events[0]?.kind, "comment");
        assert.strictEqual(events[0]?.body, `Review verdict refused: clear at ae525059: ${reason}`);
        yield* kanban.turnEnded(reviewer);
        yield* kanban.turnEnded(reviewer);
        yield* kanban.dispatchNow;
        detail = yield* now;
        assert.strictEqual(detail.card.stage, "needs_review");
        assert.strictEqual(detail.card.stalled?.reason, `Review verdict refused: ${reason}`);
        assert.strictEqual(
          detail.events.findLast((event) => event.kind === "flagged")?.failedThreadId,
          reviewer,
        );
        assert.deepStrictEqual(detail.card.stalled?.by, {
          _tag: "system",
          component: "dispatcher",
        });
        assert.isNull(detail.card.activeThreadId);
        assert.isNull(detail.card.activeRole);
        assert.isNull(detail.card.activePool);
        assert.isNull(detail.card.nudgedAt);
        assert.strictEqual(detail.card.reviewThreadId, reviewer);
        assert.isUndefined(detail.card.retries);
        assert.lengthOf(fake.messages(reviewer), sent);
        assert.isFalse(
          detail.events.some((event) => event.body === Retries.NO_VERDICT_RESTARTED_EVENT),
        );
        const store = yield* KanbanStore.KanbanStore;
        assert.isNotNull((yield* store.threadLink(reviewer))?.endedAt);
        if (kind === "approval") {
          const sql = yield* BoardsDatabase.client;
          const routes =
            yield* sql`SELECT id FROM ardud_kanban_owner_routes WHERE route_key LIKE ${`review-gate:${detail.card.id}:%`}`;
          assert.lengthOf(routes, 1);
        }
        // The evaluator can clear the flag and retry with the same reviewer.
        yield* kanban.flagCard(detail.card.id, null, owner);
        yield* TestClock.adjust("1 second");
        yield* kanban.dispatchNow;
        assert.strictEqual((yield* now).card.activeThreadId, reviewer);
        yield* kanban.reviewResult(reviewer, "clear", [], head);
        assert.isNull((yield* now).card.stalled);
        assert.lengthOf(
          (yield* now).events.filter((event) => event.kind === "review"),
          1,
        );
      }).pipe(Effect.provide(testLayer(fake.layer, storeLayer)));
    }),
);

it.effect.each(["stage", "link role", "head", "findings"] as const)(
  "records the active reviewer's %s refusal without changing its error",
  (edge) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, reviewer, now } = yield* reviewingCard;
        const store = yield* KanbanStore.KanbanStore;
        if (edge === "stage") yield* store.putCard({ ...(yield* now).card, stage: "needs_review" });
        if (edge === "link role")
          yield* store.putThreadLink({ ...(yield* store.threadLink(reviewer))!, role: "work" });
        const error = yield* Effect.flip(
          kanban.reviewResult(
            reviewer,
            edge === "findings" ? "findings" : "clear",
            [],
            edge === "head" ? "bad-head" : "abcdef1234",
          ),
        );
        assert.strictEqual(
          error.code,
          edge === "stage" ? "conflict" : edge === "link role" ? "denied" : "invalid",
        );
        const detail = yield* now;
        assert.lengthOf(
          detail.events.filter((event) => event.kind === "review"),
          0,
        );
        assert.strictEqual(
          Retries.refusedVerdict(detail.card, detail.events, reviewer),
          error.detail,
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each(["other thread", "other role"] as const)(
  "a refusal from %s does not record a review refusal",
  (edge) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, reviewer, now } = yield* reviewingCard;
        const store = yield* KanbanStore.KanbanStore;
        const card = (yield* now).card;
        yield* store.putCard(
          edge === "other thread"
            ? { ...card, activeThreadId: ThreadId.make("another-reviewer") }
            : { ...card, activeRole: "work" },
        );
        yield* Effect.flip(kanban.reviewResult(reviewer, "findings", [], "abcdef1234"));
        assert.lengthOf(
          (yield* now).events.filter((event) =>
            event.body?.startsWith(Retries.REFUSED_VERDICT_PREFIX),
          ),
          0,
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each([
  { label: "omitted", head: undefined, display: "unknown head" },
  { label: "null", head: null, display: "unknown head" },
  { label: "empty", head: "", display: "unknown head" },
  { label: "blank", head: " \n ", display: "unknown head" },
  { label: "short SHA", head: "abcdef1", display: "abcdef1" },
  { label: "full SHA", head: "ae5250595442502b641614ae15e04d02bb7a1926", display: "ae525059" },
  { label: "uppercase padded SHA", head: " ABCDEF1234 ", display: "abcdef12" },
  { label: "colon", head: "sha:1234", display: "invalid head" },
  { label: "several colons", head: "sha:1234:5678", display: "invalid head" },
  { label: "newline", head: "sha\n1234", display: "invalid head" },
  { label: "newline and colon", head: "sha\n:1234", display: "invalid head" },
  { label: "nonhex", head: "bad-head", display: "invalid head" },
  { label: "nonascii", head: "révision", display: "invalid head" },
  { label: "too short", head: "abcdef", display: "invalid head" },
  { label: "too long", head: "a".repeat(41), display: "invalid head" },
])("a refusal with $label head skips no-verdict recovery", ({ head, display }) =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, reviewer, now } = yield* reviewingCard;
      const sent = fake.messages(reviewer).length;
      const sha = head?.trim().toLowerCase() || null;
      const verdict = sha !== null && !/^[0-9a-f]{7,40}$/.test(sha) ? "clear" : "findings";
      const error = yield* Effect.flip(kanban.reviewResult(reviewer, verdict, [], head));
      const event = (yield* now).events.findLast((event) => event.kind === "comment");
      assert.strictEqual(event?.head, sha);
      assert.strictEqual(
        event?.body,
        `Review verdict refused: ${verdict} at ${display}: ${error.detail}`,
      );
      yield* kanban.turnEnded(reviewer);
      const detail = yield* now;
      assert.strictEqual(detail.card.stage, "needs_review");
      assert.strictEqual(detail.card.stalled?.reason, `Review verdict refused: ${error.detail}`);
      assert.strictEqual(detail.card.reviewThreadId, reviewer);
      assert.lengthOf(fake.messages(reviewer), sent);
      assert.isUndefined(detail.card.retries);
      assert.isFalse(
        detail.events.some((event) => event.body === Retries.NO_VERDICT_RESTARTED_EVENT),
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a verdict ends the review's retry: the next step starts with a clean count", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, reviewer, now } = yield* reviewingCard;
      yield* kanban.turnEnded(reviewer);
      yield* kanban.turnEnded(reviewer);
      yield* kanban.dispatchNow;
      assert.deepStrictEqual(retriesOf((yield* now).card), ["no_verdict/review/restarted"]);
      const done = yield* kanban.reviewResult(reviewer, "findings", ["Rounding drops a cent"]);
      assert.strictEqual(done.card.stage, "todo");
      assert.isUndefined(done.card.retries);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each(["tick", "turn end"] as const)(
  "an idle %s read cannot retire a detached steer after its successor starts",
  (edge) =>
    Effect.gen(function* () {
      const fake = makeFake();
      const entered = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<void>();
      let gateNext = false;
      const gated = Layer.effect(
        KanbanThreads,
        Effect.map(KanbanThreads, (real) => {
          const afterRead = (kind: "view" | "find", view: KanbanThreadView | null) => {
            if (!gateNext || view?.state !== "idle" || kind !== (edge === "tick" ? "find" : "view"))
              return Effect.succeed(view);
            gateNext = false;
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(returned)),
              Effect.as(view),
            );
          };
          return KanbanThreads.of({
            ...real,
            view: (id) => real.view(id).pipe(Effect.flatMap((view) => afterRead("view", view))),
            find: (id) => real.find(id).pipe(Effect.flatMap((view) => afterRead("find", view))),
          });
        }),
      ).pipe(Layer.provide(fake.layer));
      yield* Effect.gen(function* () {
        const { kanban, card, thread, now } = yield* workingCard;
        yield* kanban.moveCard(card.id, "todo", "owner", owner);
        yield* kanban.cardThread(card.id, "steer", "Carry on now", owner);
        yield* kanban.waitCard(
          card.id,
          { on: "time", until: "2026-11-12T10:00:00.000Z", note: "Later" },
          owner,
        );
        yield* fake.start(thread);
        yield* TestClock.adjust("1 second");
        fake.finish(thread);
        gateNext = true;
        const reading = yield* Effect.forkChild(
          edge === "tick" ? kanban.tick : kanban.turnEnded(thread),
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust("1 second");
        yield* fake.start(thread);
        yield* kanban.threadEvent(thread);
        yield* Deferred.succeed(returned, undefined);
        yield* Fiber.join(reading);
        assert.isDefined((yield* now).card.detachedSteerAt);
        assert.isTrue(kanbanWaiting((yield* now).card));
        yield* TestClock.adjust(Rules.RUN_SILENT_MS + 1);
        yield* kanban.tick;
        assert.deepStrictEqual(fake.interrupted, [thread]);
      }).pipe(
        Effect.ensuring(Deferred.succeed(returned, undefined)),
        Effect.provide(testLayer(gated)),
      );
    }),
);

it.effect.each(["stale terminal view", "finished before send returned"] as const)(
  "an idle parked worker returns to zero reads after %s",
  (edge) =>
    Effect.gen(function* () {
      const fake = makeFake();
      const entered = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      let lagNext = false;
      let finishedAt: string | null = null;
      const idleTime = (view: KanbanThreadView | null) =>
        view?.state === "idle" && finishedAt !== null ? { ...view, quietSince: finishedAt } : view;
      const lagged = Layer.effect(
        KanbanThreads,
        Effect.map(KanbanThreads, (real) =>
          KanbanThreads.of({
            ...real,
            view: (id) =>
              real.view(id).pipe(
                Effect.map((view) => {
                  const current = idleTime(view);
                  if (!lagNext || current === null) return current;
                  lagNext = false;
                  return { ...current, state: "running" as const };
                }),
              ),
            find: (id) => real.find(id).pipe(Effect.map(idleTime)),
          }),
        ),
      ).pipe(Layer.provide(fake.layer));
      if (edge === "finished before send returned") {
        fake.sendControl.beforeSend = (text) =>
          text === "Carry on now"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(delivered)))
            : Effect.void;
      }
      yield* Effect.gen(function* () {
        const { kanban, card, thread, now } = yield* workingCard;
        yield* kanban.moveCard(card.id, "todo", "owner", owner);
        if (edge === "finished before send returned") {
          yield* kanban.waitCard(
            card.id,
            { on: "time", until: "2026-11-11T10:00:00.000Z", note: "Tomorrow" },
            owner,
          );
          const steering = yield* Effect.forkChild(
            kanban.cardThread(card.id, "steer", "Carry on now", owner),
          );
          yield* Deferred.await(entered);
          yield* fake.start(thread);
          yield* TestClock.adjust("1 second");
          fake.finish(thread);
          finishedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
          yield* kanban.turnEnded(thread);
          yield* TestClock.adjust("1 second");
          yield* kanban.waitCard(
            card.id,
            { on: "time", until: "2026-11-12T10:00:00.000Z", note: "Later" },
            owner,
          );
          yield* Deferred.succeed(delivered, undefined);
          yield* Fiber.join(steering);
        } else {
          yield* kanban.cardThread(card.id, "steer", "Carry on now", owner);
          yield* fake.start(thread);
          yield* kanban.waitCard(
            card.id,
            { on: "time", until: "2026-11-12T10:00:00.000Z", note: "Later" },
            owner,
          );
          yield* TestClock.adjust("1 second");
          fake.finish(thread);
          finishedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
          lagNext = true;
          yield* kanban.turnEnded(thread);
        }
        const parked = (yield* now).card;
        assert.isTrue(kanbanWaiting(parked));
        assert.isDefined(parked.detachedSteerAt);
        if (edge === "finished before send returned")
          assert.isBelow(Date.parse(finishedAt!), Date.parse(parked.detachedSteerAt!));
        // Allow one tick to observe confirmed idle and reconcile the signal.
        yield* kanban.tick;
        const reconciled = (yield* now).card;
        assert.isUndefined(reconciled.detachedSteerAt);
        assert.deepStrictEqual(reconciled.wait, parked.wait);
        const reads = fake.readsOf(thread);
        for (let tick = 0; tick < 3; tick += 1) {
          yield* TestClock.adjust("15 seconds");
          yield* kanban.tick;
        }
        assert.strictEqual(fake.readsOf(thread), reads);
        assert.deepStrictEqual((yield* now).card, reconciled);
        assert.deepStrictEqual(fake.interrupted, []);
      }).pipe(
        Effect.ensuring(Deferred.succeed(delivered, undefined)),
        Effect.provide(testLayer(lagged)),
      );
    }),
);

const GATE_HEAD = "d37243cdc055a1cb81d8deccefa943af6527f8e1";
const gateFlaggedCard = Effect.gen(function* () {
  const context = yield* reviewingCard;
  const store = yield* KanbanStore.KanbanStore;
  const current = (yield* context.now).card;
  const card: KanbanCard = {
    ...current,
    stage: "needs_review",
    activeThreadId: null,
    activeRole: null,
    activePool: null,
    stalled: {
      reason: `${Retries.REFUSED_VERDICT_PREFIX}subtask s1 (secret) needs Abdullah's approval`,
      by: { _tag: "system", component: "dispatcher" },
      at: current.movedAt,
    },
    subtasks: [
      {
        id: "s1",
        step: 1,
        owner: "review",
        text: "Check secrets are absent from logs",
        gate: "secret",
        state: "open",
        createdAt: current.movedAt,
        note: null,
        doneAt: null,
        doneBy: null,
      },
    ],
    subtaskSeq: 1,
    retries: [
      {
        kind: "no_verdict",
        role: "review",
        state: "restarted",
        at: current.movedAt,
        reason: Retries.NO_VERDICT_REASON,
        runId: null,
      },
    ],
  };
  yield* store.putCard(card);
  yield* store.putThreadLink({
    ...(yield* store.threadLink(context.reviewer))!,
    endedAt: card.movedAt,
  });
  const refusal: Omit<KanbanCardEvent, "id"> = {
    cardId: card.id,
    actor: { _tag: "thread", threadId: context.reviewer },
    at: card.movedAt,
    kind: "comment",
    fromStage: null,
    toStage: null,
    head: GATE_HEAD,
    body: `${Retries.REFUSED_VERDICT_PREFIX}clear at ${GATE_HEAD.slice(0, 8)}: subtask s1 (secret) needs Abdullah's approval`,
  };
  yield* store.addCardEvent(refusal);
  return { ...context, card, store, refusal };
});

const gateRequeues = (events: ReadonlyArray<KanbanCardEvent>) =>
  events.filter((event) => event.body === Retries.REVIEW_GATE_REQUEUED_EVENT);

// Register short board-lock retries explicitly: advancing TestClock before a
// post-commit drain requests its backoff would leave that drain asleep forever.
const advanceBoardRetries = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const scheduled = yield* Queue.unbounded<{
      readonly until: number;
      readonly resume: Deferred.Deferred<void>;
    }>();
    const retryClock: Clock.Clock = {
      ...clock,
      sleep: (duration) => {
        const ms = Duration.toMillis(duration);
        if (ms < 10 || ms > 80) return clock.sleep(duration);
        return Effect.gen(function* () {
          const resume = yield* Deferred.make<void>();
          yield* Queue.offer(scheduled, { until: clock.currentTimeMillisUnsafe() + ms, resume });
          yield* Deferred.await(resume);
        });
      },
    };
    const advance = Effect.forever(
      Effect.gen(function* () {
        const retry = yield* Queue.take(scheduled);
        yield* TestClock.adjust(Math.max(0, retry.until - clock.currentTimeMillisUnsafe()));
        yield* Deferred.succeed(retry.resume, undefined);
      }),
    );
    return yield* Effect.raceFirst(
      effect.pipe(Effect.provideService(Clock.Clock, retryClock)),
      advance,
    );
  });

it.effect(
  "a subtask edit requeues a gate-refused review, retaining queue age, wait and retries",
  () =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, now, store, refusal } = yield* gateFlaggedCard;
        yield* store.addCardEvent({
          ...refusal,
          actor: { _tag: "system", component: "dispatcher" },
          body: Retries.reviewGateBuildEvent("current-build"),
        });
        yield* kanban.waitCard(
          card.id,
          {
            on: "time",
            until: "2026-11-11T10:00:00.000Z",
            note: "Retain parked wait",
            wakeRole: "review",
          },
          owner,
        );
        const wait = (yield* now).card.wait!;
        yield* store.putCard({ ...card, wait });

        yield* TestClock.adjust("1 second");
        const edited = yield* kanban.editCard(
          card.id,
          { subtasks: [{ id: "s1", step: 1, owner: "review", text: "Check log redaction" }] },
          owner,
        );
        assert.strictEqual(edited.stage, "needs_review");
        assert.isNull(edited.stalled);
        assert.strictEqual(edited.movedAt, card.movedAt);
        assert.deepStrictEqual(edited.wait, wait);
        assert.deepStrictEqual(edited.retries, card.retries);
        assert.lengthOf(gateRequeues((yield* now).events), 1);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a new build requeues a historical gate refusal once, with a quick re-record brief", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, card, now, reviewer, store, refusal } = yield* gateFlaggedCard;
      yield* store.addCardEvent({
        ...refusal,
        actor: { _tag: "system", component: "dispatcher" },
        body: Retries.reviewGateBuildEvent("old-build"),
      });
      yield* kanban.tick;
      assert.isNull((yield* now).card.stalled);
      assert.deepStrictEqual((yield* now).card.retries, card.retries);
      assert.include(
        fake.messages(reviewer).at(-1) ?? "",
        `Your earlier verdict at ${GATE_HEAD} was refused by a gate that is now gone`,
      );
      yield* kanban.tick;
      assert.lengthOf(gateRequeues((yield* now).events), 1);
      // A second refusal in this build must not create an automatic retry loop.
      const running = (yield* now).card;
      yield* store.putCard({ ...card, movedAt: running.movedAt });
      yield* store.addCardEvent({ ...refusal, at: running.movedAt });
      yield* kanban.tick;
      assert.isNotNull((yield* now).card.stalled);
      assert.lengthOf(gateRequeues((yield* now).events), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each(["deploy", "money", "secret"] as const)(
  "an unanswered owner %s gate retains its flag and queues its evaluator notice once per build",
  (gate) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, now, store } = yield* gateFlaggedCard;
        const gated = {
          ...card,
          subtasks: card.subtasks.map((subtask) => ({
            ...subtask,
            owner: "evaluator" as const,
            gate,
            gateSource: "set" as const,
            text: `Owner ${gate} action`,
          })),
        };
        yield* store.putCard(gated);
        yield* kanban.tick;
        yield* kanban.tick;
        const detail = yield* now;
        assert.deepStrictEqual(detail.card.stalled, card.stalled);
        assert.deepStrictEqual(detail.card.retries, card.retries);
        assert.lengthOf(gateRequeues(detail.events), 0);
        assert.lengthOf(
          detail.events.filter(
            (event) => event.body === Retries.reviewGateBuildEvent("current-build"),
          ),
          1,
        );
        const sql = yield* BoardsDatabase.client;
        const notices = yield* sql<{
          json: string;
        }>`SELECT json FROM ardud_kanban_owner_routes WHERE route_key LIKE ${`review-gate:${card.id}:%`}`;
        assert.lengthOf(notices, 1);
        assert.include(notices[0]!.json, "needs Abdullah's approval");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect.each(["approved", "picked"] as const)(
  "an owner %s answer rechecks the refused verdict without a new build",
  (answer) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, now, store } = yield* gateFlaggedCard;
        yield* store.putCard({
          ...card,
          subtasks: card.subtasks.map((s) => ({
            ...s,
            owner: "evaluator" as const,
            gate: "deploy" as const,
            gateSource: "set" as const,
            text: "Deploy this fix",
          })),
        });
        yield* kanban.askOwner(
          card.id,
          {
            question: "Approve s1: deploy this fix?",
            blocking: false,
            ...(answer === "picked"
              ? { options: [{ id: "go", label: "Approve s1", approves: ["s1"] }] }
              : {
                  kind: "action" as const,
                  action: { summary: "Deploy this fix for s1" },
                  respond: { verdict: { approve: "Approve", reject: "Reject" } },
                }),
          },
          owner,
          "owner",
        );
        const noticeDrained = yield* Deferred.make<void>();
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            if (options.name === "KanbanService.drainOwnerRoutes") {
              const end = span.end.bind(span);
              span.end = (time, exit) => {
                end(time, exit);
                Deferred.doneUnsafe(noticeDrained, Effect.void);
              };
            }
            return span;
          },
        });
        // The tick's notice must settle before the answer invalidates its snapshot.
        yield* kanban.tick.pipe(Effect.withTracer(tracer));
        yield* Deferred.await(noticeDrained);
        assert.isNotNull((yield* now).card.stalled);
        const ask = (yield* now).card.asks.at(-1)!;
        yield* kanban.answerAsk(
          card.id,
          ask.id,
          answer === "picked"
            ? { verdict: "picked", optionIds: ["go"], revision: 0 }
            : { verdict: "approved", revision: 0 },
          owner,
        );
        assert.isNull((yield* now).card.stalled);
        assert.strictEqual((yield* now).card.stage, "needs_review");
        assert.deepStrictEqual((yield* now).card.retries, card.retries);
        assert.lengthOf(gateRequeues((yield* now).events), 1);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }).pipe(advanceBoardRetries, withTestSchedulerBudget),
);

it.effect("changing guessedGates rechecks refused reviews on that board", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, board, card, now, store } = yield* gateFlaggedCard;
      yield* store.putCard({
        ...card,
        subtasks: card.subtasks.map(({ gate: _gate, ...s }) => ({
          ...s,
          owner: "evaluator" as const,
          text: "Deploy this fix",
        })),
      });
      yield* kanban.tick;
      assert.isNotNull((yield* now).card.stalled);
      yield* kanban.updateBoard(board.id, { guessedGates: [] }, owner);
      assert.isNull((yield* now).card.stalled);
      assert.deepStrictEqual((yield* now).card.retries, card.retries);
      assert.lengthOf(gateRequeues((yield* now).events), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each([
  {
    name: "legacy gate refusal",
    body: `card_review_result clear at ${GATE_HEAD} rejected with capability_denied: secret-gate rejection on s1`,
    own: true,
    old: false,
    recovers: true,
  },
  {
    name: "plain no-verdict",
    body: "I have not reviewed this yet",
    own: true,
    old: false,
    recovers: false,
  },
  {
    name: "another reviewer's refusal",
    body: "card_review_result capability_denied secret gate",
    own: false,
    old: false,
    recovers: false,
  },
  {
    name: "stale refusal",
    body: "card_review_result capability_denied secret gate",
    own: true,
    old: true,
    recovers: false,
  },
  {
    name: "conflict",
    body: "Review verdict refused: clear at abcdef1: Board changed during this operation",
    own: true,
    old: false,
    recovers: false,
  },
  {
    name: "invalid verdict",
    body: "Review verdict refused: findings at abcdef1: findings need at least one line",
    own: true,
    old: false,
    recovers: false,
  },
])(
  "only reliable gate evidence recovers NO_VERDICT_REASON: $name",
  ({ body, own, old, recovers }) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, card, now, store, refusal } = yield* gateFlaggedCard;
        yield* store.putCard({
          ...card,
          movedAt: old ? "2026-11-10T10:01:00.000Z" : card.movedAt,
          reviewThreadId: own ? card.reviewThreadId : ThreadId.make("another-reviewer"),
          stalled: { ...card.stalled!, reason: Retries.NO_VERDICT_REASON },
        });
        // Replace the modern evidence rather than letting it satisfy the legacy test.
        yield* store.putCard({ ...(yield* now).card, movedAt: "2026-11-10T10:01:00.000Z" });
        yield* store.addCardEvent({
          ...refusal,
          at: old ? card.movedAt : "2026-11-10T10:01:00.000Z",
          body,
          head: null,
        });
        yield* kanban.tick;
        assert.strictEqual((yield* now).card.stalled === null, recovers);
        assert.lengthOf(gateRequeues((yield* now).events), recovers ? 1 : 0);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a standing approval grant rechecks that board's refused reviews", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* Effect.gen(function* () {
      const { kanban, board, card, now, store } = yield* gateFlaggedCard;
      const evaluator = {
        _tag: "evaluator" as const,
        threadId: yield* kanban.startEvaluator(board.id, {
          kind: "request",
          text: "Record board approval",
        }),
      };
      yield* store.putCard({
        ...card,
        subtasks: card.subtasks.map((s) => ({
          ...s,
          owner: "evaluator" as const,
          gate: "deploy" as const,
          text: "Deploy this fix",
        })),
      });
      yield* kanban.tick;
      assert.isNotNull((yield* now).card.stalled);
      const approval = yield* kanban.createCard(
        board.id,
        { title: "Standing approval", prompt: "Record approval" },
        owner,
      );
      yield* kanban.askOwner(
        approval.id,
        {
          question: `Approve deployments for the ${board.slug} board`,
          blocking: false,
          kind: "action",
          action: { summary: `Approve deployments for the ${board.slug} board` },
          respond: { verdict: { approve: "Approve", reject: "Reject" } },
        },
        owner,
        "owner",
      );
      yield* kanban.answerAsk(approval.id, "q1", { verdict: "approved", revision: 0 }, owner);
      yield* kanban.standingApproval(
        board.id,
        {
          action: "grant",
          cardId: approval.id,
          ask: "q1",
          quote: "Approve deployments",
          sourceThreadId: "owner-thread",
          saidAt: card.movedAt,
        },
        evaluator,
      );
      assert.isNull((yield* now).card.stalled);
      assert.deepStrictEqual((yield* now).card.retries, card.retries);
      assert.lengthOf(gateRequeues((yield* now).events), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each(["build", "settings"] as const)(
  "a failed %s recovery save rolls back its trigger, receipt and move",
  (trigger) =>
    Effect.gen(function* () {
      const fake = makeFake();
      let target: string | null = null;
      let fail = false;
      const storeLayer = Layer.effect(
        KanbanStore.KanbanStore,
        Effect.map(KanbanStore.KanbanStore, (real) =>
          KanbanStore.KanbanStore.of({
            ...real,
            putCard: (card) =>
              real
                .putCard(card)
                .pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      fail && card.id === target && card.stalled === null
                        ? Effect.die(new Error("recovery card save failed"))
                        : Effect.void,
                    ),
                  ),
                ),
          }),
        ),
      ).pipe(Layer.provide(KanbanStore.layer));
      yield* Effect.gen(function* () {
        const { kanban, board, card, now, store } = yield* gateFlaggedCard;
        if (trigger === "settings")
          yield* store.putCard({
            ...card,
            subtasks: card.subtasks.map(({ gate: _gate, ...s }) => ({
              ...s,
              owner: "evaluator" as const,
              text: "Deploy this fix",
            })),
          });
        const recover =
          trigger === "build"
            ? kanban.tick
            : kanban.updateBoard(board.id, { guessedGates: [] }, owner).pipe(Effect.asVoid);
        target = card.id;
        fail = true;
        yield* Effect.exit(recover);
        const failed = yield* now;
        assert.deepStrictEqual(failed.card.stalled, card.stalled);
        assert.lengthOf(gateRequeues(failed.events), 0);
        assert.isFalse(
          failed.events.some(
            (event) => event.body === Retries.reviewGateBuildEvent("current-build"),
          ),
        );
        assert.deepStrictEqual(
          (yield* kanban.snapshot(board.id)).board.guessedGates,
          board.guessedGates,
        );
        fail = false;
        yield* recover;
        assert.isNull((yield* now).card.stalled);
        assert.lengthOf(gateRequeues((yield* now).events), 1);
      }).pipe(Effect.provide(testLayer(fake.layer, storeLayer)));
    }),
);

it.effect("a failed evaluator delivery retains its durable gate-notification obligation", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    const attempted = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { kanban, card, now, store } = yield* gateFlaggedCard;
      yield* store.putCard({
        ...card,
        subtasks: card.subtasks.map((s) => ({
          ...s,
          owner: "evaluator" as const,
          gate: "secret" as const,
        })),
      });
      const refuse = (text: string) =>
        text.includes("needs Abdullah's approval")
          ? Deferred.succeed(attempted, undefined).pipe(
              Effect.andThen(Effect.die(new Error("evaluator delivery failed"))),
            )
          : Effect.void;
      fake.sendControl.beforeLaunch = refuse;
      fake.sendControl.beforeSend = refuse;
      yield* kanban.tick;
      yield* Deferred.await(attempted);
      const sql = yield* BoardsDatabase.client;
      const routes = yield* sql<{
        done_at: string | null;
      }>`SELECT done_at FROM ardud_kanban_owner_routes WHERE route_key LIKE ${`review-gate:${card.id}:%`}`;
      assert.lengthOf(routes, 1);
      assert.isNull(routes[0]!.done_at);
      assert.isNotNull((yield* now).card.stalled);
      assert.isTrue(
        (yield* now).events.some(
          (event) => event.body === Retries.reviewGateBuildEvent("current-build"),
        ),
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each(
  (["plan", "answer", "settings"] as const).flatMap((trigger) =>
    (["before", "after"] as const).map((order) => ({ trigger, order })),
  ),
)(
  "a $trigger change $order refusal still requeues after an earlier build check",
  ({ trigger, order }) =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* Effect.gen(function* () {
        const { kanban, board, card, now, store, reviewer, refusal } = yield* gateFlaggedCard;
        yield* store.addCardEvent({
          ...refusal,
          actor: { _tag: "system", component: "dispatcher" },
          body: Retries.reviewGateBuildEvent("current-build"),
        });
        if (order === "before") yield* TestClock.adjust("1 second");
        const movedAt = order === "before" ? DateTime.formatIso(yield* DateTime.now) : card.movedAt;
        yield* store.putCard({
          ...card,
          movedAt,
          stage: "in_review",
          activeThreadId: reviewer,
          activeRole: "review",
          activePool: Rules.poolKey(card.model),
          stalled: null,
        });
        yield* store.putThreadLink({ ...(yield* store.threadLink(reviewer))!, endedAt: null });
        if (trigger === "plan")
          yield* kanban.editCard(
            card.id,
            { subtasks: [{ id: "s1", owner: "review", step: 1, text: "Check log redaction" }] },
            owner,
          );
        else if (trigger === "settings")
          yield* kanban.updateBoard(board.id, { guessedGates: [] }, owner);
        else {
          yield* kanban.askOwner(
            card.id,
            {
              question: "Approve s1",
              blocking: false,
              kind: "action",
              action: { summary: "Approve s1" },
              respond: { verdict: { approve: "Approve", reject: "Reject" } },
            },
            owner,
            "owner",
          );
          yield* kanban.answerAsk(card.id, "q1", { verdict: "approved", revision: 0 }, owner);
        }
        if (order === "before") yield* store.addCardEvent({ ...refusal, at: movedAt });
        yield* kanban.turnEnded(reviewer);
        assert.isNotNull((yield* now).card.stalled);
        assert.lengthOf(
          (yield* now).events.filter(
            (event) => event.body === Retries.reviewGateBuildEvent("current-build"),
          ),
          1,
        );
        yield* kanban.tick;
        assert.isNull((yield* now).card.stalled);
        assert.lengthOf(gateRequeues((yield* now).events), 1);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "an edit cannot report a recovered card when the SQL transaction fails after its save",
  () =>
    Effect.gen(function* () {
      const fake = makeFake();
      let fail = false;
      let depth = 0;
      const sqlLayer = Layer.effect(
        SqlClient.SqlClient,
        Effect.map(SqlClient.SqlClient, (sql) => {
          const withTransaction: typeof sql.withTransaction = (effect) =>
            Effect.suspend(() => {
              const outer = depth++ === 0;
              return sql
                .withTransaction(
                  effect.pipe(
                    Effect.tap(() =>
                      outer && fail
                        ? Effect.die(new Error("commit failed after card write"))
                        : Effect.void,
                    ),
                  ),
                )
                .pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      depth--;
                    }),
                  ),
                );
            });
          return new Proxy(sql, {
            get: (target, property, receiver) =>
              property === "withTransaction"
                ? withTransaction
                : Reflect.get(target, property, receiver),
          });
        }),
      ).pipe(Layer.provide(Sqlite.layerMemory));
      yield* Effect.gen(function* () {
        const { kanban, card, now } = yield* gateFlaggedCard;
        fail = true;
        const result = yield* Effect.exit(
          kanban.editCard(
            card.id,
            { subtasks: [{ id: "s1", owner: "review", step: 1, text: "Check log redaction" }] },
            owner,
          ),
        );
        assert.isTrue(Exit.isFailure(result));
        const detail = yield* now;
        assert.deepStrictEqual(detail.card.stalled, card.stalled);
        assert.deepStrictEqual(detail.card.subtasks, card.subtasks);
        assert.lengthOf(gateRequeues(detail.events), 0);
        assert.isFalse(
          detail.events.some(
            (event) => event.body === Retries.reviewGateBuildEvent("current-build"),
          ),
        );
      }).pipe(Effect.provide(testLayer(fake.layer, KanbanStore.layer, sqlLayer)));
    }),
);

it.effect.each(["queued", "running"] as const)(
  "restart bound keeps working card with a %s successor",
  (successor) => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      if (successor === "running") yield* fake.start(thread);
      else fake.setQueued(thread);
      fake.fail(thread, { code: "restart_admission_timeout", runId: "expired-run" });
      yield* kanban.turnEnded(thread, {
        runId: "expired-run",
        reason: "Restart admission expired",
        restartAdmission: true,
      });
      yield* kanban.turnEnded(thread);
      const card = (yield* now).card;
      assert.strictEqual(card.stage, "working");
      assert.strictEqual(card.stalled, null);
      assert.strictEqual(card.activeThreadId, thread);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  },
);

it.effect.each(["owner", "evaluator"] as const)(
  "restart bound clears on later user recovery but preserves %s stalls",
  (actor) => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const { kanban, card, thread, now } = yield* workingCard;
      yield* kanban.turnEnded(thread, {
        runId: "expired-run",
        reason: "Restart admission expired",
        restartAdmission: true,
      });
      const stalled = (yield* now).card;
      assert.strictEqual(stalled.stage, "todo");
      assert.deepStrictEqual(stalled.stalled?.runFailure, {
        threadId: thread,
        runId: "expired-run",
      });
      assert.include(stalled.stalled!.reason, "evaluator can clear");
      yield* TestClock.adjust(60_000);
      yield* fake.start(thread);
      yield* kanban.notifyThreadChanged(thread);
      const recovered = (yield* now).card;
      assert.strictEqual(recovered.stalled, null);
      assert.strictEqual(recovered.stage, "working");
      assert.strictEqual(recovered.activeThreadId, thread);
      assert.strictEqual(recovered.activeRole, "work");
      yield* kanban.flagCard(
        card.id,
        "Investigation",
        actor === "owner" ? owner : { _tag: "evaluator", threadId: ThreadId.make("evaluator-1") },
      );
      yield* fake.start(thread);
      yield* kanban.notifyThreadChanged(thread);
      assert.strictEqual((yield* now).card.stalled?.reason, "Investigation");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  },
);

it.effect("the card evaluator can clear an orphaned restart bound stall", () => {
  const fake = makeFake();
  return Effect.gen(function* () {
    const { kanban, card, thread, now } = yield* workingCard;
    yield* kanban.turnEnded(thread, {
      runId: "expired",
      reason: "Restart admission expired",
      restartAdmission: true,
    });
    yield* kanban.flagCard(card.id, null, {
      _tag: "evaluator",
      threadId: ThreadId.make("evaluator-1"),
    });
    assert.strictEqual((yield* now).card.stalled, null);
  }).pipe(Effect.provide(testLayer(fake.layer)));
});

it.effect(
  "a recovered worker can clear its bound stall before the run-update follower catches up",
  () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const { kanban, card, thread, now } = yield* workingCard;
      yield* kanban.turnEnded(thread, {
        runId: "expired",
        reason: "Restart admission expired",
        restartAdmission: true,
      });
      yield* fake.start(thread);
      yield* kanban.flagCard(card.id, null, { _tag: "thread", threadId: thread });
      assert.strictEqual((yield* now).card.stalled, null);
      assert.strictEqual((yield* now).card.stage, "working");
      assert.strictEqual((yield* now).card.activeThreadId, thread);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  },
);

it.effect.each([false, true])(
  "#1573 claim recovery conflict committed=%s preserves the recovery outcome",
  (committed) => {
    const fake = makeFake();
    let target: KanbanCard["id"] | undefined;
    let targetFiber: number | undefined;
    let conflicts = 0;
    const faulted = Layer.effect(
      KanbanStore.KanbanStore,
      Effect.map(KanbanStore.KanbanStore, (store) =>
        KanbanStore.KanbanStore.of({
          ...store,
          card: (id) =>
            Effect.gen(function* () {
              const card = yield* store.card(id);
              if (
                !committed &&
                id === target &&
                (yield* Effect.fiberId) === targetFiber &&
                conflicts === 0 &&
                card?.stalled?.runFailure
              ) {
                conflicts++;
                yield* store.putCard({ ...card, description: "Concurrent edit" });
                return yield* Effect.die(new BoardLocks.BoardStateChanged(false));
              }
              return card;
            }),
          putCard: (card) =>
            Effect.gen(function* () {
              yield* store.putCard(card);
              if (
                committed &&
                card.id === target &&
                (yield* Effect.fiberId) === targetFiber &&
                conflicts === 0 &&
                card.stalled === null
              ) {
                conflicts++;
                return yield* Effect.die(new BoardLocks.BoardStateChanged(true));
              }
            }),
        }),
      ),
    ).pipe(Layer.provide(KanbanStore.layer));
    return Effect.gen(function* () {
      const { kanban, board, card, thread, now } = yield* workingCard;
      yield* kanban.turnEnded(thread, {
        runId: "expired",
        reason: "Restart admission expired",
        restartAdmission: true,
      });
      assert.isNotNull((yield* now).card.stalled?.runFailure);
      const next = yield* kanban.createCard(board.id, { prompt: "Next", title: "Next" }, owner);
      yield* fake.start(thread);
      target = card.id;
      targetFiber = yield* Effect.fiberId;
      const result = yield* Effect.result(kanban.claimCard(thread, next.id));
      assert.strictEqual(conflicts, 1);
      if (committed) {
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure.code, "conflict");
          assert.include(result.failure.detail, "may have been applied");
        }
        assert.strictEqual((yield* kanban.card(next.id)).card.stage, "todo");
      } else {
        assert.strictEqual(result._tag, "Success");
        if (result._tag === "Success") {
          assert.strictEqual(result.success.card.id, next.id);
          assert.strictEqual(result.success.card.workThreadId, thread);
        }
        assert.strictEqual((yield* now).card.description, "Concurrent edit");
      }
      const recovered = yield* now;
      assert.isNull(recovered.card.stalled);
      assert.strictEqual(recovered.card.stage, "working");
      assert.lengthOf(
        recovered.events.filter((event) => event.body?.startsWith("Cleared run-failed stall")),
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer, faulted)));
  },
);

it.effect("#1573 claim retries a concurrent edit during the recovery run read", () => {
  const fake = makeFake();
  let concurrentEdit: Effect.Effect<void> | undefined;
  let recoveryReads = 0;
  const racing = Layer.effect(
    KanbanThreads,
    Effect.map(KanbanThreads, (threads) =>
      KanbanThreads.of({
        ...threads,
        latestRun: (threadId, afterRunId) =>
          Effect.gen(function* () {
            if (concurrentEdit !== undefined) {
              const edit = concurrentEdit;
              concurrentEdit = undefined;
              yield* edit.pipe(Effect.forkChild, Effect.flatMap(Fiber.join));
            }
            recoveryReads++;
            return yield* threads.latestRun(threadId, afterRunId);
          }),
      }),
    ),
  ).pipe(Layer.provide(fake.layer));
  return Effect.gen(function* () {
    const { kanban, board, card: first, thread } = yield* workingCard;
    const carried = yield* kanban.createCard(
      board.id,
      { prompt: "Carried", title: "Carried" },
      owner,
    );
    const { card } = yield* kanban.claimCard(thread, carried.id);
    const now = kanban.card(card.id);
    yield* kanban.turnEnded(thread, {
      runId: "expired",
      reason: "Restart admission expired",
      restartAdmission: true,
    });
    yield* kanban.flagCard(first.id, "Investigation", owner);
    const next = yield* kanban.createCard(board.id, { prompt: "Next", title: "Next" }, owner);
    yield* fake.start(thread);
    recoveryReads = 0;
    concurrentEdit = kanban
      .editCard(card.id, { description: "Concurrent recovery edit" }, owner)
      .pipe(Effect.asVoid, Effect.orDie);
    const claimed = yield* kanban.claimCard(thread, next.id);
    assert.strictEqual(claimed.card.workThreadId, thread);
    assert.strictEqual(recoveryReads, 2);
    const recovered = yield* now;
    assert.isNull(recovered.card.stalled);
    assert.strictEqual(recovered.card.description, "Concurrent recovery edit");
    assert.strictEqual((yield* kanban.card(first.id)).card.stalled?.reason, "Investigation");
    assert.lengthOf(
      recovered.events.filter((event) => event.body?.startsWith("Cleared run-failed stall")),
      1,
    );
  }).pipe(Effect.provide(testLayer(racing)));
});

it.effect.each(["deadline notification", "duplicate terminal notification"] as const)(
  "a successor promoted during %s cannot disappear between reads",
  (edge) => {
    const fake = makeFake();
    let target: ThreadId | undefined;
    let armed = false;
    const racing = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (real) =>
        KanbanThreads.of({
          ...real,
          queuedRuns: (id, includeActive) =>
            Effect.gen(function* () {
              if (armed && id === target) {
                armed = false;
                yield* fake.start(id);
                fake.clearQueued(id);
                fake.fail(id, { code: "restart_admission_timeout", runId: "expired-run" });
              }
              return yield* real.queuedRuns(id, includeActive);
            }),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      target = thread;
      fake.setQueued(thread);
      fake.fail(thread, { code: "restart_admission_timeout", runId: "expired-run" });
      armed = true;
      yield* kanban.turnEnded(
        thread,
        edge === "deadline notification"
          ? { runId: "expired-run", reason: "Restart admission expired", restartAdmission: true }
          : undefined,
      );
      assert.isFalse(armed);
      const card = (yield* now).card;
      assert.strictEqual(card.stage, "working");
      assert.strictEqual(card.activeThreadId, thread);
      assert.strictEqual(card.stalled, null);
    }).pipe(Effect.provide(testLayer(racing)));
  },
);

it.effect("recovery resolves a model without effort to its configured effort pool", () => {
  const fake = makeFake();
  return Effect.gen(function* () {
    const { kanban, board, card, thread, now } = yield* workingCard;
    const selected = {
      ...card.model,
      options: [{ id: effortOptionId(card.model.instanceId), value: "xhigh" }],
    };
    yield* kanban.setPool(board.id, selected, 1, { replaces: card.activePool! });
    yield* kanban.turnEnded(thread, {
      runId: "expired-run",
      reason: "Restart admission expired",
      restartAdmission: true,
    });
    const threads = yield* KanbanThreads;
    yield* threads.setModel(thread, { instanceId: card.model.instanceId, model: card.model.model });
    yield* fake.start(thread);
    yield* kanban.notifyThreadChanged(thread);
    assert.strictEqual((yield* now).card.activePool, Rules.poolKey(selected));
    const other = yield* kanban.createCard(
      board.id,
      { prompt: "B", title: "B", model: selected },
      owner,
    );
    yield* kanban.dispatchNow;
    assert.strictEqual((yield* kanban.card(other.id)).card.stage, "todo");
  }).pipe(Effect.provide(testLayer(fake.layer)));
});

it.effect.each(["ordinary notification", "tick"] as const)(
  "persisted restart timeout handled by %s keeps the recovery marker",
  (edge) => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      fake.fail(thread);
      yield* kanban.turnEnded(thread);
      yield* pastBackoff;
      yield* kanban.tick;
      assert.strictEqual((yield* now).card.stage, "working");
      fake.fail(thread, { code: "restart_admission_timeout", runId: "persisted-timeout" });
      if (edge === "ordinary notification") yield* kanban.turnEnded(thread);
      else {
        yield* TestClock.adjust("15 seconds");
        yield* kanban.tick;
      }
      assert.deepStrictEqual((yield* now).card.stalled?.runFailure, {
        threadId: thread,
        runId: "persisted-timeout",
      });
      yield* kanban.turnEnded(thread, {
        runId: "persisted-timeout",
        reason: "Restart admission expired",
        restartAdmission: true,
      });
      yield* fake.start(thread);
      yield* kanban.notifyThreadChanged(thread);
      assert.strictEqual((yield* now).card.stalled, null);
      assert.strictEqual((yield* now).card.stage, "working");
      assert.strictEqual((yield* now).card.activeThreadId, thread);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  },
);

it.effect("review1518: recovery finishes before its board event is consumed", () => {
  const fake = makeFake();
  return Effect.gen(function* () {
    const { kanban, thread, now } = yield* workingCard;
    yield* kanban.turnEnded(thread, {
      runId: "expired-run",
      reason: "Restart admission expired",
      restartAdmission: true,
    });
    assert.isNotNull((yield* now).card.stalled);
    yield* fake.start(thread);
    fake.finish(thread);
    yield* kanban.notifyThreadChanged(thread);
    yield* kanban.turnEnded(thread);
    assert.strictEqual((yield* now).card.stalled, null);
  }).pipe(Effect.provide(testLayer(fake.layer)));
});

it.effect("review1518: delayed restart timeout cannot flag successful recovery", () => {
  const fake = makeFake();
  return Effect.gen(function* () {
    const { kanban, thread, now } = yield* workingCard;
    yield* fake.start(thread);
    fake.finish(thread);
    yield* kanban.turnEnded(thread, {
      runId: "expired-run",
      reason: "Restart admission expired",
      restartAdmission: true,
    });
    assert.strictEqual((yield* now).card.stalled, null);
  }).pipe(Effect.provide(testLayer(fake.layer)));
});

it.effect.each(["ordinary notification", "deadline notification"] as const)(
  "completed recovery remains visible to a delayed %s",
  (notification) => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const { kanban, thread, now } = yield* workingCard;
      fake.fail(thread, { code: "restart_admission_timeout", runId: "expired-run" });
      yield* fake.start(thread);
      fake.finish(thread);
      fake.fail(thread, { code: "restart_admission_timeout", runId: "expired-run" });
      yield* kanban.turnEnded(
        thread,
        notification === "deadline notification"
          ? {
              runId: "expired-run",
              reason: "Restart admission expired",
              restartAdmission: true,
            }
          : undefined,
      );
      assert.strictEqual((yield* now).card.stalled, null);
      assert.strictEqual((yield* now).card.stage, "working");
      assert.strictEqual((yield* now).card.activeThreadId, thread);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  },
);

it.effect.each(["owner", "evaluator"] as const)(
  "completed recovery does not clear a %s stall",
  (actor) => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const { kanban, card, thread, now } = yield* workingCard;
      yield* kanban.flagCard(
        card.id,
        "Investigation",
        actor === "owner"
          ? owner
          : {
              _tag: "evaluator",
              threadId: ThreadId.make("evaluator-1"),
            },
      );
      yield* fake.start(thread);
      fake.finish(thread);
      yield* kanban.notifyThreadChanged(thread);
      assert.strictEqual((yield* now).card.stalled?.reason, "Investigation");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  },
);

it.effect("admission failure records the worker on every carried card", () => {
  const fake = makeFake();
  return Effect.gen(function* () {
    const { kanban, board, card: primary, thread } = yield* workingCard;
    const secondary = yield* kanban.createCard(
      board.id,
      { prompt: "Carried", title: "Carried" },
      owner,
    );
    yield* kanban.claimCard(thread, secondary.id);
    yield* kanban.turnEnded(thread, {
      runId: "run:shared",
      reason: "Restart admission expired",
      restartAdmission: true,
      admission,
    });
    for (const card of [primary, secondary]) {
      const failure = (yield* kanban.card(card.id)).events.findLast(
        (event) => event.kind === "flagged",
      );
      assert.strictEqual(failure?.failedThreadId, thread);
      assert.strictEqual(failure?.runId, "run:shared");
      assert.deepStrictEqual(failure?.admission, admission);
    }
  }).pipe(Effect.provide(testLayer(fake.layer)));
});
