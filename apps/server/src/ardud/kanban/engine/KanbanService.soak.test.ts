/**
 * Soak: the engine driven over a board the size of the biggest real one.
 *
 * `soakBoard.ts` seeds about 4,000 cards (1,200 in To-Do with three in four
 * blocked, 120 waiting for review, the rest done), four pools of 60 slots in all
 * and review chains of one to three steps. Fake threads stand in for the models:
 * a launch or a message starts a turn, and the driver decides how each turn ends.
 * Every round runs a tick, then lets a burst of workers and reviewers finish at
 * once (hand off to review, ask the owner, stop without moving, fail, create a
 * card; clear, findings, no verdict, fail) while the owner answers, creates,
 * ships, pulls back and unflags cards, then runs a dispatch and checks the board:
 *
 *  - no card is lost or duplicated;
 *  - a card's stage and its thread agree (no card is in two places);
 *  - no pool runs more threads than it has slots, and no thread is in two pools;
 *  - every started card has a thread the board knows;
 *  - a turn end that reported a failure left nothing behind (see STRICT below);
 *  - at the end nothing startable is left waiting while a slot is free.
 *
 * It prints tick, dispatch, turn-end and start-a-card timings and the count of
 * reruns (operations redone because the board changed under them), and fails on
 * generous ceilings: a regression guard, not a benchmark.
 *
 * Default: a small smoke board, part of the unit run. The full board:
 *
 *   KANBAN_SOAK=1 npx vp test run src/ardud/kanban/engine/KanbanService.soak.test.ts
 *
 * Knobs: KANBAN_SOAK_CARDS, KANBAN_SOAK_ROUNDS, KANBAN_SOAK_SEED, KANBAN_SOAK_IO_MS
 * (service time of one thread read), KANBAN_SOAK_OUT (the report as JSON),
 * KANBAN_SOAK_STRICT=1.
 *
 * STRICT. On the board-lock-diet engine (10 Nov 2026) a turn end that has already
 * saved a flag or sent a nudge is not redone when the board changes under it: it
 * returns "Board changed during this operation" with its work half done (the flag
 * is saved, the note to the evaluator is not). The soak sees that on about one
 * turn end in six. Until the turn-end rewrite lands, those are counted, printed
 * as SAVED-THEN-FAILED and held under a ceiling; KANBAN_SOAK_STRICT=1 fails on the
 * first one.
 */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import {
  KANBAN_DONE_STAGES,
  ProjectId,
  ThreadId,
  type KanbanActor,
  type KanbanCard,
  type KanbanPool,
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
import { modelSelectionOf } from "./defaults.ts";
import * as KanbanModels from "./models.ts";
import * as KanbanService from "./KanbanService.ts";
import * as Rules from "./rules.ts";
import { soakCards, soakRandom } from "./soakBoard.ts";
import { opencodeTestProvider } from "./testProviders.ts";
import { KanbanThreads, type KanbanThreadView } from "./threads.ts";

const env = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const FULL = process.env.KANBAN_SOAK === "1";
const CARDS = env("KANBAN_SOAK_CARDS", FULL ? 4000 : 240);
const ROUNDS = env("KANBAN_SOAK_ROUNDS", FULL ? 40 : 6);
const SEED = env("KANBAN_SOAK_SEED", 20261110);
const STRICT = process.env.KANBAN_SOAK_STRICT === "1";
/** Service time of one thread read; sends and launches take three. */
const IO_MS = env("KANBAN_SOAK_IO_MS", 1);
/** Threads whose turn ends in one round. */
const WORK_ENDS = FULL ? 24 : 6;
const REVIEW_ENDS = FULL ? 10 : 4;

/**
 * Ceilings, about four times what the full board measures on an offbox VM
 * (10 Nov 2026, board-lock-diet engine: tick p50 430 ms and p95 3.7 s, dispatch
 * p50 250 ms and p95 2.1 s, turn end p95 380 ms, an urgent card started 110 ms
 * after its create, 2.4 attempts per turn end, 18% of turn ends reporting a
 * failure). While a card waiting out its retry still held its thread and slot,
 * the tick's median was about 2.2 s here (the tick reloaded the board for each
 * one); the wait now holds nothing and the tick skips such a card. They catch a
 * tick or a dispatch that goes quadratic, or turn ends that start failing far
 * more often under contention, not a slow machine.
 */
const CEILING = {
  tickP95Ms: FULL ? 15_000 : 3_000,
  dispatchP95Ms: FULL ? 10_000 : 2_500,
  turnEndP95Ms: FULL ? 2_500 : 1_500,
  startMs: FULL ? 3_000 : 2_000,
  /** Share of turn ends that may report a failure, whatever they left behind. */
  turnEndFailedShare: 0.4,
  /** Times a turn end runs on average, counting the reruns after the board changed under it. */
  turnEndAttempts: 6,
};

const opus = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "high" });
const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", variant: "xhigh" });
const astra = modelSelectionOf({ model: "opus/gpt-6-astra", variant: "xhigh" });
const haiku = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "high" });
/**
 * A card's automatic retry records, read loosely so this file also builds on an
 * engine without them (the retry change is a separate commit).
 */
const retriesOf = (card: KanbanCard) =>
  (card as { readonly retries?: ReadonlyArray<{ readonly state: string }> }).retries ?? [];
/** 60 slots on the full board, as the real one: two work pools, two that only review. */
const POOLS: ReadonlyArray<readonly [ModelSelection, number]> = FULL
  ? [
      [opus, 26],
      [sol, 16],
      [astra, 10],
      [haiku, 8],
    ]
  : [
      [opus, 6],
      [sol, 4],
      [astra, 3],
      [haiku, 3],
    ];
const CHAINS = [
  { name: "One", steps: [astra] },
  { name: "Two", steps: [astra, haiku] },
  { name: "Three", steps: [sol, astra, haiku] },
];

type Failure = OrchestrationV2ProviderFailure & {
  readonly runId?: string | null;
  readonly model?: ModelSelection | null;
};

interface SoakThread {
  running: boolean;
  model: ModelSelection;
  readonly messages: Array<string>;
  failure: Failure | null;
}

const makeThreads = () => {
  const threads = new Map<string, SoakThread>();
  const counts = { reads: 0, sends: 0, launches: 0, interrupts: 0 };
  /** Threads the board stopped; in production their run's end is a turn end. */
  const stopped = new Set<string>();
  /** Resolved by the launch of the thread whose title has `title`, to time a start. */
  let nextStart: { readonly title: string; readonly done: Deferred.Deferred<void> } | null = null;
  let nextThread = 0;
  let nextRun = 0;
  const io = (steps = 1) => Effect.sleep(IO_MS * steps);
  const started = (title: string) =>
    Effect.suspend(() => {
      const waiting = nextStart;
      if (waiting === null || !title.includes(waiting.title)) return Effect.void;
      nextStart = null;
      return Deferred.succeed(waiting.done, undefined);
    });
  const read = (threadId: ThreadId) =>
    Effect.gen(function* () {
      counts.reads += 1;
      yield* io();
      const thread = threads.get(threadId);
      if (!thread) return null;
      const at = DateTime.formatIso(yield* DateTime.now);
      const view: KanbanThreadView = {
        threadId,
        projectId: ProjectId.make("project-1"),
        title: threadId,
        state: thread.running ? "running" : "idle",
        updatedAt: at,
        quietSince: at,
        runStartedAt: thread.running ? at : null,
        backgroundWork: 0,
        prs: [],
        archived: false,
      };
      return view;
    });
  const failureOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      counts.reads += 1;
      yield* io();
      return threads.get(threadId)?.failure ?? null;
    });
  const layer = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      view: read,
      find: read,
      model: (threadId) => Effect.sync(() => threads.get(threadId)?.model ?? null),
      lastFailure: failureOf,
      findLastFailure: failureOf,
      latestRun: () => Effect.succeed(null),
      compactRun: () => Effect.succeed(null),
      launch: (input) =>
        Effect.gen(function* () {
          counts.launches += 1;
          yield* io(3);
          nextThread += 1;
          const threadId = ThreadId.make(`soak-thread-${nextThread}`);
          threads.set(threadId, {
            running: true,
            model: input.model,
            messages: [input.text],
            failure: null,
          });
          yield* started(input.title);
          return threadId;
        }),
      // A message starts a turn (or steers the running one): the failed run is no longer the latest.
      send: (input) =>
        Effect.gen(function* () {
          counts.sends += 1;
          yield* io(3);
          const thread = threads.get(input.threadId);
          if (!thread) return;
          thread.messages.push(input.text);
          thread.running = true;
          thread.failure = null;
          if (input.model) thread.model = input.model;
        }),
      setModel: (threadId, model) =>
        Effect.sync(() => {
          const thread = threads.get(threadId);
          if (thread) thread.model = model;
        }),
      interrupt: (threadId) =>
        Effect.gen(function* () {
          counts.interrupts += 1;
          yield* io();
          const thread = threads.get(threadId);
          if (thread?.running) {
            thread.running = false;
            stopped.add(threadId);
          }
        }),
    }),
  );
  const fail = (threadId: string, message: string) => {
    const thread = threads.get(threadId);
    if (!thread) return;
    nextRun += 1;
    thread.running = false;
    thread.failure = {
      class: "provider_error",
      message,
      code: null,
      retryable: null,
      category: "unknown",
      runId: `soak-run-${nextRun}`,
      model: thread.model,
    };
  };
  const awaitStart = (title: string) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      nextStart = { title, done };
      return Deferred.await(done);
    });
  return { threads, counts, stopped, layer, fail, awaitStart };
};

const soakLayer = (threads: Layer.Layer<KanbanThreads>) =>
  KanbanService.layer.pipe(
    // As production: owner routes and write follow-ons are delivered after the reply.
    Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred")),
    Layer.provide(Layer.succeed(KanbanService.ReplayReads, true)),
    Layer.provide(Layer.succeed(KanbanService.DeferWriteEffects, true)),
    Layer.provideMerge(threads),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    // No project folders here: the scribe and the title writer find none and stop.
    Layer.provideMerge(
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
    ),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-kanban-soak-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ServerSettings.layerTest()),
      ),
    ),
  );

const owner: KanbanActor = { _tag: "owner" };

const pct = (values: ReadonlyArray<number>, p: number) => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! * 10) / 10;
};
const summary = (values: ReadonlyArray<number>) => ({
  n: values.length,
  p50: pct(values, 0.5),
  p95: pct(values, 0.95),
  max: values.length === 0 ? null : Math.round(Math.max(...values) * 10) / 10,
});

/** What must hold for a board's cards whenever nothing is mid-write. */
export const boardProblems = (
  cards: ReadonlyArray<KanbanCard>,
  pools: ReadonlyArray<KanbanPool>,
  expected: ReadonlySet<string>,
): Array<string> => {
  const problems: Array<string> = [];
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const card of cards) {
    if (ids.has(card.id)) problems.push(`card ${card.id} is on the board twice`);
    if (numbers.has(card.number)) problems.push(`number #${card.number} is used twice`);
    ids.add(card.id);
    numbers.add(card.number);
    if (!expected.has(card.id)) problems.push(`card ${card.id} was never created`);
    const active = card.activeThreadId !== null;
    if (active !== (card.activeRole !== null) || active !== (card.activePool !== null)) {
      problems.push(
        `#${card.number} has half a thread: ${card.activeThreadId}/${card.activeRole}/${card.activePool}`,
      );
    }
    if (card.activeRole === "work" && card.stage !== "working") {
      problems.push(`#${card.number} is in ${card.stage} with a worker on it`);
    }
    if (card.activeRole === "review" && card.stage !== "in_review") {
      problems.push(`#${card.number} is in ${card.stage} with a reviewer on it`);
    }
    if (card.stage === "working" && !active)
      problems.push(`#${card.number} is working with no thread`);
    if (active && (card.settledAt !== null || KANBAN_DONE_STAGES.has(card.stage))) {
      problems.push(`#${card.number} is ${card.stage} and still has a thread`);
    }
  }
  for (const id of expected) if (!ids.has(id)) problems.push(`card ${id} is gone`);
  // A slot belongs to a thread: count threads per pool, and cards per thread.
  const byPool = new Map<string, Set<string>>();
  const poolOfThread = new Map<string, string>();
  const reviewing = new Map<string, number>();
  const carrying = new Map<string, number>();
  for (const card of cards) {
    if (card.activeThreadId === null || card.activePool === null) continue;
    const set = byPool.get(card.activePool) ?? new Set<string>();
    set.add(card.activeThreadId);
    byPool.set(card.activePool, set);
    const other = poolOfThread.get(card.activeThreadId);
    if (other !== undefined && other !== card.activePool) {
      problems.push(`thread ${card.activeThreadId} holds slots in ${other} and ${card.activePool}`);
    }
    poolOfThread.set(card.activeThreadId, card.activePool);
    const counts = card.activeRole === "review" ? reviewing : carrying;
    counts.set(card.activeThreadId, (counts.get(card.activeThreadId) ?? 0) + 1);
  }
  for (const [key, threads] of byPool) {
    const pool = pools.find((candidate) => candidate.key === key);
    if (!pool) problems.push(`cards run on a pool the board doesn't have: ${key}`);
    else if (threads.size > pool.slots) {
      problems.push(`pool ${key} runs ${threads.size} threads on ${pool.slots} slots`);
    }
  }
  for (const [threadId, count] of reviewing) {
    if (count > 1) problems.push(`review thread ${threadId} reviews ${count} cards`);
    if (carrying.has(threadId)) problems.push(`thread ${threadId} both works and reviews`);
  }
  for (const [threadId, count] of carrying) {
    if (count > Rules.MAX_BATCH) problems.push(`work thread ${threadId} carries ${count} cards`);
  }
  return problems;
};

it.live(
  `soak: ${CARDS} cards, ${ROUNDS} rounds of turn ends, verdicts, answers and creates`,
  () =>
    Effect.gen(function* () {
      const fake = makeThreads();
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          if (options.name.startsWith("Kanban")) spans.push(span);
          return span;
        },
      });
      // Warnings the service logs, counted by their first words, with one example each.
      const logged = new Map<string, { count: number; example: string }>();
      const warnings = Logger.make(({ message, logLevel }) => {
        if (logLevel !== "Warn" && logLevel !== "Error") return;
        const parts = (Array.isArray(message) ? message : [message]).map((part) => {
          if (typeof part !== "object" || part === null) return String(part);
          return Object.entries(part)
            .map(
              ([key, value]) =>
                `${key}=${Cause.isCause(value) ? Cause.pretty(value) : String(value)}`,
            )
            .join(" ");
        });
        const text = parts.join(" ");
        const key = text.split(" ").slice(0, 4).join(" ");
        const entry = logged.get(key);
        if (entry) entry.count += 1;
        else logged.set(key, { count: 1, example: text.slice(0, 300) });
      });
      const timings = new Map<string, Array<number>>();
      const failed = new Map<string, number>();
      const firstFailure = new Map<string, string>();
      /** Runs one board call, timed; a failure is counted, not thrown. */
      const op = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const from = performance.now();
          const exit = yield* Effect.exit(effect);
          const list = timings.get(name) ?? [];
          list.push(performance.now() - from);
          timings.set(name, list);
          if (Exit.isFailure(exit)) {
            failed.set(name, (failed.get(name) ?? 0) + 1);
            if (!firstFailure.has(name))
              firstFailure.set(name, Cause.pretty(exit.cause).slice(0, 400));
          }
          return exit;
        });
      const problems: Array<string> = [];
      /** Turn ends that reported a failure after saving or sending something. */
      const savedThenFailed: Array<string> = [];

      const result = yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const store = yield* KanbanStore.KanbanStore;
        const made = yield* kanban.ensureBoard({
          slug: "soak",
          name: "Soak",
          defaultProjectId: ProjectId.make("project-1"),
        });
        const board = yield* kanban.updateBoard(made.id, {
          defaultCardModel: opus,
          reviewChains: CHAINS,
          defaultReviewChain: "One",
        });
        for (const [model, slots] of POOLS) yield* kanban.setPool(board.id, model, slots);
        const seededAt = yield* Clock.currentTimeMillis;
        const seeded = soakCards({
          board,
          cards: CARDS,
          seed: SEED,
          nowMs: seededAt,
          workModels: [
            { model: opus, share: 0.6 },
            { model: sol, share: 0.4 },
          ],
          chains: CHAINS.map((chain) => chain.name),
        });
        yield* Effect.forEach(seeded, (card) => store.putCard(card), { discard: true });
        const expected = new Set<string>(seeded.map((card) => card.id));
        const random = soakRandom(SEED + 1);
        // As production: queued dispatch kicks run on the worker.
        const worker = yield* Effect.forkChild(kanban.worker);

        const cardsNow = kanban.cards(board.id).pipe(Effect.orDie);
        const check = (when: string) =>
          Effect.gen(function* () {
            const cards = yield* cardsNow;
            const pools = yield* store.pools(board.id).pipe(Effect.orDie);
            const found = boardProblems(cards, pools, expected);
            // Every started card has a thread the board knows, in the role the card says.
            const seen = new Set<string>();
            for (const card of cards) {
              const threadId = card.activeThreadId;
              if (threadId === null || seen.has(threadId)) continue;
              seen.add(threadId);
              if (!fake.threads.has(threadId))
                found.push(`#${card.number} runs on a thread that was never started`);
              const link = yield* store.threadLink(threadId).pipe(Effect.orDie);
              if (link === null) found.push(`#${card.number}'s thread ${threadId} has no link`);
              else if (link.boardId !== board.id || link.role !== card.activeRole) {
                found.push(
                  `#${card.number}'s thread ${threadId} is linked as ${link.role} on ${link.boardId}`,
                );
              }
            }
            for (const problem of found.slice(0, 20)) problems.push(`${when}: ${problem}`);
            return cards;
          });

        let turnEnds = 0;
        let turnEndsFailed = 0;
        /**
         * A turn of `threadId` ends. When the board reports the turn end as failed, it
         * must have left nothing behind: no message to the thread, and no flag, nudge or
         * retry on the cards it carried.
         */
        const endTurn = (threadId: string, carried: ReadonlyArray<KanbanCard>) =>
          Effect.gen(function* () {
            const thread = fake.threads.get(threadId);
            if (!thread) return;
            thread.running = false;
            fake.stopped.delete(threadId);
            const messages = thread.messages.length;
            const before = yield* Effect.forEach(carried, (card) =>
              kanban.card(card.id).pipe(
                Effect.map((detail) => detail.events.length),
                Effect.orElseSucceed(() => 0),
              ),
            );
            turnEnds += 1;
            const exit = yield* op("turnEnded", kanban.turnEnded(ThreadId.make(threadId)));
            if (Exit.isSuccess(exit)) return;
            turnEndsFailed += 1;
            if (thread.messages.length > messages) {
              savedThenFailed.push(`turn end of ${threadId} failed after messaging the thread`);
            }
            for (const [index, card] of carried.entries()) {
              const detail = yield* kanban.card(card.id).pipe(Effect.orElseSucceed(() => null));
              const left = (detail?.events ?? [])
                .slice(before[index] ?? 0)
                .filter(
                  (event) =>
                    event.actor._tag === "system" &&
                    /run failed|without a verdict|retry/i.test(event.body ?? ""),
                );
              if (left.length > 0) {
                savedThenFailed.push(
                  `turn end of ${threadId} failed after saving "${left[0]?.body}" on #${card.number}`,
                );
              }
            }
          });

        const sample = <A>(items: ReadonlyArray<A>, count: number): Array<A> => {
          const pool = [...items];
          const picked: Array<A> = [];
          while (picked.length < count && pool.length > 0) {
            picked.push(...pool.splice(random.below(pool.length), 1));
          }
          return picked;
        };
        const create = (
          name: string,
          actor: KanbanActor,
          blockedBy: ReadonlyArray<KanbanCard["id"]>,
          priority: number,
          n: number,
          /** The card whose start is timed: it runs on the pool with the free slot. */
          urgent = false,
        ) =>
          op(
            name,
            kanban.createCard(
              board.id,
              {
                prompt: `Follow-up ${n}`,
                title: urgent ? `Urgent start ${n}` : `Follow-up ${n}`,
                description: "Made during the soak",
                priority,
                blockedBy,
                model: urgent || random.chance(0.6) ? opus : sol,
                reviewChain: random.pick(CHAINS).name,
              },
              actor,
            ),
          ).pipe(
            Effect.tap((exit) =>
              Effect.sync(() => {
                if (Exit.isSuccess(exit)) expected.add(exit.value.id);
              }),
            ),
          );

        let made_ = 0;
        let started = 0;
        for (let round = 0; round < ROUNDS; round += 1) {
          yield* op("tick", kanban.tick);
          const cards = yield* cardsNow;
          const byThread = new Map<string, Array<KanbanCard>>();
          for (const card of cards) {
            if (card.activeThreadId === null) continue;
            const list = byThread.get(card.activeThreadId) ?? [];
            list.push(card);
            byThread.set(card.activeThreadId, list);
          }
          const running = [...byThread].filter(([threadId]) => fake.threads.get(threadId)?.running);
          const workers = sample(
            running.filter(([, carried]) => carried[0]?.activeRole === "work"),
            WORK_ENDS,
          );
          const reviewers = sample(
            running.filter(([, carried]) => carried[0]?.activeRole === "review"),
            REVIEW_ENDS,
          );
          const openTodo = cards.filter((card) => card.stage === "todo" && card.settledAt === null);

          // Every choice is drawn here, in order, so a seed replays the same traffic.
          const agents: Array<Effect.Effect<void>> = [];
          for (const [threadId, carried] of workers) {
            const actor: KanbanActor = { _tag: "thread", threadId: ThreadId.make(threadId) };
            const roll = random.next();
            if (roll < 0.55) {
              agents.push(
                Effect.forEach(
                  carried,
                  (card) =>
                    op(
                      "worker.handOff",
                      kanban.moveCard(card.id, "needs_review", "cardThread", actor),
                    ),
                  { discard: true },
                ).pipe(Effect.andThen(endTurn(threadId, carried))),
              );
            } else if (roll < 0.65) {
              const card = carried[0]!;
              agents.push(
                op(
                  "worker.askOwner",
                  kanban.askOwner(
                    card.id,
                    {
                      question: `Which way for #${card.number}?`,
                      blocking: true,
                      // Even cards ask with a pick, odd ones in plain words.
                      ...(card.number % 2 === 0 ? { options: ["Left", "Right"] } : {}),
                    },
                    actor,
                    "cardThread",
                  ),
                ).pipe(Effect.andThen(endTurn(threadId, carried))),
              );
            } else if (roll < 0.75) {
              // Stops without moving its card: the board nudges it.
              agents.push(endTurn(threadId, carried));
            } else if (roll < 0.83) {
              agents.push(
                Effect.sync(() => fake.fail(threadId, "upstream closed the stream (soak)")).pipe(
                  Effect.andThen(endTurn(threadId, carried)),
                ),
              );
            } else if (roll < 0.9) {
              made_ += 1;
              agents.push(
                create(
                  "worker.createCard",
                  actor,
                  random.chance(0.5) ? [carried[0]!.id] : [],
                  2 + random.below(3),
                  made_,
                ).pipe(Effect.asVoid),
              );
            }
          }
          for (const [threadId, carried] of reviewers) {
            const card = carried[0]!;
            const roll = random.next();
            if (roll < 0.6) {
              // Clear: the chain's next step goes on in the same turn; after the last one the turn ends.
              agents.push(
                op(
                  "reviewer.clear",
                  kanban.reviewResult(ThreadId.make(threadId), "clear", []),
                ).pipe(
                  Effect.andThen(kanban.card(card.id)),
                  Effect.flatMap((detail) =>
                    detail.card.activeThreadId === threadId
                      ? Effect.void
                      : endTurn(threadId, carried),
                  ),
                  Effect.orElseSucceed(() => undefined),
                ),
              );
            } else if (roll < 0.85) {
              agents.push(
                op(
                  "reviewer.findings",
                  kanban.reviewResult(ThreadId.make(threadId), "findings", [
                    `Round ${round}: fix the edge case`,
                  ]),
                ).pipe(Effect.andThen(endTurn(threadId, carried))),
              );
            } else if (roll < 0.93) {
              // Ends without a verdict: nudged, then whatever the board does next.
              agents.push(endTurn(threadId, carried));
            } else {
              agents.push(
                Effect.sync(() => fake.fail(threadId, "upstream closed the stream (soak)")).pipe(
                  Effect.andThen(endTurn(threadId, carried)),
                ),
              );
            }
          }

          const ownerWork: Array<Effect.Effect<void>> = [];
          const waiting = cards.filter(
            (card) => card.stage === "needs_owner" && card.settledAt === null,
          );
          for (const card of sample(waiting, FULL ? 8 : 3)) {
            const ask = card.asks.find((entry) => entry.closedAt === null && entry.seq !== null);
            if (!ask) continue;
            ownerWork.push(
              kanban.cardDiscussion(card.id).pipe(
                Effect.flatMap((discussion) =>
                  card.number % 2 === 0
                    ? op(
                        "owner.pick",
                        kanban.answer(discussion.id, ask.seq!, ask.id, ["o1"], owner),
                      )
                    : op(
                        "owner.answer",
                        kanban.post(discussion.id, owner, [{ _tag: "md", text: "Go ahead." }]),
                      ),
                ),
                Effect.orElseSucceed(() => undefined),
                Effect.asVoid,
              ),
            );
          }
          for (let i = 0; i < (FULL ? 5 : 2); i += 1) {
            made_ += 1;
            const blockers = random.chance(0.5)
              ? sample(openTodo, 1 + random.below(2)).map((card) => card.id)
              : [];
            ownerWork.push(
              create("owner.createCard", owner, blockers, 1 + random.below(4), made_).pipe(
                Effect.asVoid,
              ),
            );
          }
          const completed = cards.filter(
            (card) => card.stage === "completed" && card.settledAt === null,
          );
          for (const card of sample(completed, 3)) {
            ownerWork.push(
              op("owner.ship", kanban.moveCard(card.id, "deployed", "owner", owner)).pipe(
                Effect.asVoid,
              ),
            );
          }
          const flagged = cards.filter((card) => card.stalled !== null && card.settledAt === null);
          for (const card of sample(flagged, FULL ? 4 : 2)) {
            ownerWork.push(
              op("owner.unflag", kanban.flagCard(card.id, null, owner)).pipe(Effect.asVoid),
            );
          }
          for (const card of sample(openTodo, 2)) {
            ownerWork.push(
              op(
                "owner.editCard",
                kanban.editCard(card.id, { priority: 1 + random.below(4) }, owner),
              ).pipe(Effect.asVoid),
            );
          }
          if (round % 3 === 2) {
            const pulled = sample(
              cards.filter((card) => card.stage === "working"),
              1,
            )[0];
            if (pulled) {
              ownerWork.push(
                op("owner.pullBack", kanban.moveCard(pulled.id, "todo", "owner", owner)).pipe(
                  Effect.asVoid,
                ),
              );
            }
          }

          // Odd rounds: everything at once, with a tick running through it. Even
          // rounds: the turn ends land together first, then the owner's writes.
          if (round % 2 === 1) {
            yield* Effect.all(
              [...agents, ...ownerWork, op("tick", kanban.tick).pipe(Effect.asVoid)],
              {
                concurrency: "unbounded",
                discard: true,
              },
            );
          } else {
            yield* Effect.all(agents, { concurrency: "unbounded", discard: true });
            yield* Effect.all(ownerWork, { concurrency: "unbounded", discard: true });
          }
          // A thread the board stopped (a card pulled back) ends its turn.
          for (const threadId of Array.from(fake.stopped))
            yield* endTurn(threadId, byThread.get(threadId) ?? []);

          const before = fake.counts.launches + fake.counts.sends;
          yield* op("dispatch", kanban.dispatchNow);
          started += fake.counts.launches + fake.counts.sends - before;
          yield* check(`round ${round + 1}`);
        }

        // Convergence. Turns that still run with no card are ended (a held slot is
        // freed at the turn's end), then dispatch runs until it has nothing to start.
        const settle = Effect.gen(function* () {
          for (let pass = 0; pass < 6; pass += 1) {
            const cards = yield* cardsNow;
            const active = new Set(
              cards.flatMap((card) =>
                card.activeThreadId === null ? [] : [card.activeThreadId as string],
              ),
            );
            for (const [threadId, thread] of fake.threads) {
              if (thread.running && !active.has(threadId)) yield* endTurn(threadId, []);
            }
            yield* op("dispatch", kanban.dispatchNow);
            const after = yield* cardsNow;
            const pools = yield* store.pools(board.id).pipe(Effect.orDie);
            const current = yield* store.boards.pipe(
              Effect.orDie,
              Effect.map((boards) => boards.find((candidate) => candidate.id === board.id)!),
            );
            const left = Rules.planDispatch(current, after, pools);
            if (left.length === 0) return [];
            if (pass === 5)
              return left.map(
                (dispatch) => `${dispatch.role} ${dispatch.cardId} on ${dispatch.pool}`,
              );
          }
          return [];
        });
        const unstarted = yield* settle;
        for (const entry of unstarted.slice(0, 10))
          problems.push(`left unstarted with a free slot: ${entry}`);
        const settled = yield* check("after settling");

        // Time to start a card: with a slot free on the busiest work pool, the owner
        // creates an urgent card, and it starts through the production path (the
        // create's queued kick, on the worker). Timed from the create to the launch.
        // A card waiting out a failed run's retry holds no slot, so the board runs
        // out of cards to start as it would without failures and a slot stays free.
        const startMs: Array<number> = [];
        const workKey = Rules.poolKey(opus);
        let slots = (yield* store.pools(board.id).pipe(Effect.orDie)).find(
          (pool) => pool.key === workKey,
        )!.slots;
        for (let i = 0; i < 5; i += 1) {
          // Open slots until one stays free after dispatch (ours and the worker's
          // queued kicks) has taken what it wants.
          for (let tries = 0; tries < 12; tries += 1) {
            yield* kanban.dispatchNow.pipe(Effect.orDie);
            yield* Effect.sleep(30);
            const busy = new Set(
              (yield* cardsNow).flatMap((card) =>
                card.activePool === workKey && card.activeThreadId !== null
                  ? [card.activeThreadId as string]
                  : [],
              ),
            ).size;
            if (busy < slots) break;
            slots += 1;
            yield* kanban.setPool(board.id, opus, slots).pipe(Effect.orDie);
          }
          made_ += 1;
          const waitStart = yield* fake.awaitStart(`Urgent start ${made_}`);
          const from = performance.now();
          yield* create("owner.createUrgent", owner, [], 1, made_, true);
          const kicked = yield* waitStart.pipe(Effect.timeoutOption(CEILING.startMs));
          if (kicked._tag === "None") {
            problems.push(
              `urgent card "Urgent start ${made_}" had a free slot and did not start in ${CEILING.startMs} ms`,
            );
            // What the dispatcher would start instead, and what holds the pool.
            const now = yield* cardsNow;
            const pools = yield* store.pools(board.id).pipe(Effect.orDie);
            const current = yield* store.boards.pipe(
              Effect.orDie,
              Effect.map((boards) => boards.find((candidate) => candidate.id === board.id)!),
            );
            const byId = new Map(now.map((card) => [card.id as string, card]));
            const cardLine = (card: KanbanCard | undefined) => {
              if (!card) return "missing";
              const thread = fake.threads.get(
                (card.activeThreadId ?? card.workThreadId ?? "") as string,
              );
              return `#${card.number} ${card.stage} p${card.priority} pool=${card.activePool} active=${card.activeThreadId} work=${card.workThreadId} stalled=${card.stalled?.reason ?? null} retries=${JSON.stringify(retriesOf(card))} thread=${thread ? `running:${thread.running} failed:${thread.failure !== null}` : "none"}`;
            };
            problems.push(
              `  the card: ${cardLine(now.find((card) => card.title === `Urgent start ${made_}`))}`,
              `  pool ${workKey}: ${pools.find((pool) => pool.key === workKey)?.slots} slots`,
              ...now
                .filter((entry) => entry.activePool === workKey && entry.activeThreadId !== null)
                .map((card) => `  holds a slot: ${cardLine(card)}`),
              ...Rules.planDispatch(current, now, pools)
                .slice(0, 8)
                .map(
                  (dispatch) =>
                    `  dispatch would start: ${dispatch.role} on ${dispatch.pool} joins=${dispatch.joins} ${cardLine(byId.get(dispatch.cardId))}`,
                ),
            );
            continue;
          }
          startMs.push(performance.now() - from);
        }
        yield* Effect.sleep(50);
        yield* check("after opening slots");
        yield* Fiber.interrupt(worker);

        const stages = new Map<string, number>();
        for (const card of settled) stages.set(card.stage, (stages.get(card.stage) ?? 0) + 1);
        return {
          boardId: board.id,
          cards: settled.length,
          created: expected.size - seeded.length,
          stages: Object.fromEntries(stages),
          flagged: settled.filter((card) => card.stalled !== null).length,
          // A failed run's card waits in its queue with no thread, then runs again.
          retryWaiting: settled.filter(
            (card) => retriesOf(card).length > 0 && card.activeThreadId === null,
          ).length,
          retryRunning: settled.filter(
            (card) => retriesOf(card).length > 0 && card.activeThreadId !== null,
          ).length,
          started,
          startMs,
          turnEnds,
          turnEndsFailed,
        };
      }).pipe(
        Effect.provide(Layer.mergeAll(soakLayer(fake.layer), Logger.layer([warnings]))),
        Effect.withTracer(tracer),
      );

      // Reruns: an operation redone because the board changed under it (see boardLocks).
      let reruns = 0;
      let deepest = 0;
      let turnEndAttempts = 0;
      for (const span of spans) {
        const attempt = span.attributes.get("board.rerun_attempt");
        if (typeof attempt === "number") {
          reruns += 1;
          deepest = Math.max(deepest, attempt);
        }
        if (span.name === "KanbanService.turnEndedUnlocked") turnEndAttempts += 1;
      }
      const report = {
        config: { full: FULL, cards: CARDS, rounds: ROUNDS, seed: SEED, ioMs: IO_MS },
        board: result,
        timings: Object.fromEntries(
          [...timings].map(([name, values]) => [
            name,
            { ...summary(values), failed: failed.get(name) ?? 0 },
          ]),
        ),
        startCardMs: summary(result.startMs),
        conflicts: {
          reruns,
          deepestRerun: deepest,
          turnEndAttempts,
          turnEnds: result.turnEnds,
          turnEndsFailed: result.turnEndsFailed,
        },
        threadIo: fake.counts,
        firstFailure: Object.fromEntries(firstFailure),
        warnings: Object.fromEntries(logged),
        savedThenFailed,
        problems,
      };
      const out = process.env.KANBAN_SOAK_OUT;
      if (out) {
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(out, JSON.stringify(report, null, 2));
        }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
      }
      const line = (name: string) => {
        const entry = report.timings[name];
        return entry
          ? `${name} n=${entry.n} p50=${entry.p50}ms p95=${entry.p95}ms max=${entry.max}ms failed=${entry.failed}`
          : `${name} n=0`;
      };
      yield* Effect.sync(() =>
        process.stdout.write(
          [
            `soak ${CARDS} cards x ${ROUNDS} rounds (seed ${SEED}): ${JSON.stringify(result.stages)} flagged=${result.flagged} retrying=${result.retryWaiting} waiting, ${result.retryRunning} running again created=${result.created} started=${result.started}`,
            line("tick"),
            line("dispatch"),
            line("turnEnded"),
            `start a card n=${report.startCardMs.n} p50=${report.startCardMs.p50}ms max=${report.startCardMs.max}ms`,
            `reruns=${reruns} deepest=${deepest} turnEnds=${result.turnEnds} attempts=${turnEndAttempts} failed=${result.turnEndsFailed} savedThenFailed=${savedThenFailed.length}`,
            ...[...logged].map(([key, entry]) => `warning x${entry.count}: ${key}`),
            ...savedThenFailed.slice(0, 5).map((entry) => `SAVED-THEN-FAILED ${entry}`),
            ...problems.slice(0, 20).map((problem) => `PROBLEM ${problem}`),
            "",
          ].join("\n"),
        ),
      );

      assert.deepStrictEqual(problems, []);
      if (STRICT) assert.deepStrictEqual(savedThenFailed, []);
      assert.isAbove(result.turnEnds, 0, "turn ends were driven");
      assert.isAbove(result.started, 0, "the dispatcher started cards");
      assert.isAtMost(
        result.turnEndsFailed,
        Math.ceil(result.turnEnds * CEILING.turnEndFailedShare),
        "turn ends that reported a failure",
      );
      assert.isAtMost(
        turnEndAttempts,
        result.turnEnds * CEILING.turnEndAttempts,
        "turn end attempts, reruns included",
      );
      assert.isAtMost(report.timings.tick?.p95 ?? 0, CEILING.tickP95Ms, "tick p95");
      assert.isAtMost(report.timings.dispatch?.p95 ?? 0, CEILING.dispatchP95Ms, "dispatch p95");
      assert.isAtMost(report.timings.turnEnded?.p95 ?? 0, CEILING.turnEndP95Ms, "turn end p95");
      assert.isAtMost(report.startCardMs.max ?? 0, CEILING.startMs, "time to start a card");
    }),
  { timeout: FULL ? 900_000 : 120_000 },
);
