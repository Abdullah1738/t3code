/**
 * Retry once before flagging, through the board service: a failed worker or
 * reviewer run, and a reviewer that ends without a verdict, are run again once
 * before the card is flagged. A failed run's card waits out its backoff in its
 * queue and holds no slot. The pure decision is tested in retries.test.ts.
 */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  KanbanError,
  kanbanRetryNotBefore,
  kanbanRetrying,
  kanbanWaiting,
  ProjectId,
  ThreadId,
  type KanbanActor,
  type KanbanCard,
  type ModelSelection,
  type OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";

import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import * as KanbanModels from "./models.ts";
import * as KanbanService from "./KanbanService.ts";
import * as Retries from "./retries.ts";
import * as Rules from "./rules.ts";
import * as Waits from "./waits.ts";
import { opencodeTestProvider } from "./testProviders.ts";
import { KanbanThreads, type KanbanThreadView } from "./threads.ts";

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
  /** Reads of each thread (its view or its last failure), for tests that count them. */
  const reads = new Map<string, number>();
  const counted = (threadId: string) => reads.set(threadId, (reads.get(threadId) ?? 0) + 1);
  let nextThread = 0;
  let nextRun = 0;
  const sendControl = { beforeSend: (_text: string): Effect.Effect<void> => Effect.void };
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
      pendingUserInputs: () => Effect.succeed([]),
      view: read,
      find: read,
      model: (threadId) => Effect.sync(() => threads.get(threadId)?.model ?? null),
      lastFailure: failureOf,
      findLastFailure: failureOf,
      latestRun: () => Effect.succeed(null),
      runSettled: () => Effect.succeed(true),
      compactRun: () => Effect.succeed(null),
      launch: (input) =>
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
      send: (input) =>
        sendControl.beforeSend(input.text).pipe(
          Effect.andThen(
            Effect.sync(() => {
              threads.get(input.threadId)?.messages.push(input.text);
            }),
          ),
        ),
      withdraw: () => Effect.void,
      setModel: (threadId, model) =>
        Effect.sync(() => {
          const thread = threads.get(threadId);
          if (thread) thread.model = model;
        }),
      queuedRuns: () => Effect.succeed([]),
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
    });
  const finish = (threadId: string) => {
    threads.get(threadId)!.run = null;
  };
  return { layer, fail, recover, messages, readsOf, start, finish, interrupted, sendControl };
};

const testLayer = (fake: Layer.Layer<KanbanThreads>, storeLayer = KanbanStore.layer) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-kanban-retries-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ServerSettings.layerTest()),
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
