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
 * About one open card in twenty is parked on a wait (`soakWaits`: merge, push
 * and ci on pull requests with and without a work thread, another card, a time).
 * Some waits are over at the first tick, the driver ends others halfway (a PR
 * merges, its head moves, its checks pass, the time comes) and the rest hold to
 * the end. A wait that should have ended and did not, or ended and should not
 * have, is a problem. After the rounds a few quiet ticks run with no reading
 * changed: they must write no parked card, read no thread of a parked card
 * beyond the one view that carries a watched PR, and ask the host reader once.
 * The time of the wait pass in those ticks is reported and held under a ceiling.
 * Script waits are parked too. No script runs here: after the quiet ticks the soak
 * answers "hold" for all of them in the one batch call the scripts' pass makes, which
 * must load the board once and read or write no card. A tick that runs by itself
 * must never give up (see `ticksGivenUp`). Every write that moves the board's
 * generation is recorded with the call it came from, and the report says who
 * wrote while each tick ran.
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
  kanbanWaiting,
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
import { SOAK_SCRIPT, soakCards, soakRandom, soakWaits } from "./soakBoard.ts";
import { opencodeTestProvider } from "./testProviders.ts";
import { KanbanThreads, type KanbanThreadPr, type KanbanThreadView } from "./threads.ts";
import { KanbanWaitPrs } from "./waitPrs.ts";
import type * as Waits from "./waits.ts";

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
/** A `mid` time wait comes due this long after the board is seeded. */
const WAIT_MID_MS = FULL ? 20_000 : 500;
/** Before this round's tick the driver ends the `mid` waits. */
const WAIT_MID_ROUND = Math.floor(ROUNDS / 2);
/** Ticks run after the rounds with no reading changed. */
const QUIET_TICKS = FULL ? 5 : 3;

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
  /**
   * The wait pass of a tick in which no wait ends: every parked card's check is
   * asked and nothing is written. On the smoke board it measures about 4 ms on a
   * loaded Mac (11 Nov 2026: 6 cards still parked of 15, two of them 1 ms reads).
   * The full board (about 65 parked) is not measured yet, so its ceiling is a
   * guess with the same wide margin. It catches a pass that reads the board once
   * per parked card, not a slow machine.
   */
  waitPassP95Ms: FULL ? 2_000 : 500,
  /**
   * Ticks of the board that give up: the board changed under them and they could
   * not start over (redone eight times already, or they had written or sent
   * something themselves). The tick call still succeeds, and every step of that
   * tick comes 30 seconds later. Every second round starts a tick in the middle of
   * the round's whole traffic, and each of those gives up, here and on the base
   * this branch started from (release-20261110c, 11 Nov 2026: 3 of 3 on the smoke,
   * 20 of 20 on the full board, all after eight redos). That is the ceiling: at
   * most the ticks run that way.
   *
   * A tick that runs by itself must never give up. On the base 5 of 40 did on the
   * full board (none on the smoke), and 1 to 3 of 45 here before the fix: each had
   * handled a failed run the round left behind, which queued a dispatch kick, and
   * the worker's dispatcher then started a card under the rest of the tick. A tick
   * now holds its own kicks until its closing dispatch (`tickKicks`). The report
   * lists who wrote during each tick, from the recorder in `watchedStore`.
   */
  ticksGivenUp: Math.floor(ROUNDS / 2),
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

/**
 * What one tick did for the parked cards: their rows read and written, their
 * threads read, the host reader asked. `first` to `last` spans those calls, which
 * in a tick where no wait ends is the wait pass and nothing else.
 */
interface Probe {
  readonly cards: ReadonlySet<string>;
  readonly threads: ReadonlySet<string>;
  first: number | null;
  last: number | null;
  cardReads: number;
  /** Loads of the whole board's cards. */
  boardLoads: number;
  readonly cardWrites: Set<string>;
  readonly threadReads: Map<string, number>;
  hostPasses: number;
  hostRequests: number;
}

/**
 * Store writes that go through the board's lock. Each one moves the board's
 * generation (`lockedStore.ts`), which is what makes a tick that is outside the
 * gate at that moment stale.
 */
const LOCKED_WRITES = [
  "putBoard",
  "putBoardWithPools",
  "putCard",
  "addCardEvent",
  "putGoal",
  "putPool",
  "removePool",
  "rekeyBoard",
  "migrateBoardSelections",
  "putGroups",
  "putDiscussion",
  "putMessage",
  "putAutomation",
  "putWiki",
  "putThreadLink",
  "addThreadCard",
] as const;

/** One write that moved the board's generation, and the call it came from. */
interface Bump {
  readonly at: number;
  readonly method: string;
  /** The spans it ran under, outermost first: the driver's call, then the engine's. */
  readonly chain: string;
  /** The driver call (or worker) it descends from. */
  readonly root: string;
  readonly rootId: string | null;
  /** That call had already returned: the write came from work it left running. */
  readonly rootEnded: boolean;
  /** The engine operation under the root: one job of the worker, one call of the driver. */
  readonly opId: string | null;
  readonly opStart: bigint | null;
}

const spanChain = (span: Tracer.Span | null): Array<Tracer.Span> => {
  const chain: Array<Tracer.Span> = [];
  let at: Tracer.AnySpan | undefined = span ?? undefined;
  while (at !== undefined && at._tag === "Span") {
    chain.push(at);
    at = Option.getOrUndefined(at.parent);
  }
  return chain.reverse();
};
const spanLabel = (span: Tracer.Span) => {
  const name = span.name.replace("KanbanService.", "");
  const queue = span.attributes.get("serial.queue");
  return typeof queue === "string" ? `${name}(${queue})` : name;
};

const makeWatch = () => {
  const state: { probe: Probe | null } = { probe: null };
  const bumps: Array<Bump> = [];
  /** Messages and launches: after one, the operation that made it is not redone. */
  const sends: Array<{
    readonly at: number;
    readonly chain: string;
    readonly rootId: string | null;
  }> = [];
  /** Runs `effect`, timed into the open probe when `count` takes it. */
  const seen = <A, E, R>(count: (probe: Probe) => boolean, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const probe = state.probe;
      if (probe === null || !count(probe)) return effect;
      const touch = () => {
        const now = performance.now();
        probe.first ??= now;
        probe.last = now;
      };
      touch();
      return Effect.ensuring(effect, Effect.sync(touch));
    });
  return {
    bumps,
    /** Records `effect`, a write through the board's lock, when it has landed. */
    bump: <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(Effect.currentSpan.pipe(Effect.orElseSucceed(() => null)), (span) =>
        Effect.tap(effect, () =>
          Effect.sync(() => {
            const chain = spanChain(span);
            const root = chain[0];
            const driven = root?.name.startsWith("soak:") === true;
            const operation = driven ? chain[1] : root;
            const labels: Array<string> = [];
            for (const entry of chain) {
              const label = spanLabel(entry);
              if (labels.at(-1) !== label) labels.push(label);
            }
            bumps.push({
              at: performance.now(),
              method,
              chain: labels.join(">"),
              root: root === undefined ? "no span" : spanLabel(root),
              rootId: root?.spanId ?? null,
              rootEnded: root?.status._tag === "Ended",
              opId: operation?.spanId ?? null,
              opStart: operation?.status.startTime ?? null,
            });
          }),
        ),
      ),
    sends,
    /** Records a message or a launch under the call that made it. */
    sent: <A, E, R>(kind: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(Effect.currentSpan.pipe(Effect.orElseSucceed(() => null)), (span) =>
        Effect.suspend(() => {
          const chain = spanChain(span);
          const labels: Array<string> = [];
          for (const entry of chain) {
            const label = spanLabel(entry);
            if (labels.at(-1) !== label) labels.push(label);
          }
          sends.push({
            at: performance.now(),
            chain: `${kind}: ${labels.join(">")}`,
            rootId: chain[0]?.spanId ?? null,
          });
          return effect;
        }),
      ),
    open: (cards: ReadonlySet<string>, threads: ReadonlySet<string>) => {
      state.probe = {
        cards,
        threads,
        first: null,
        last: null,
        cardReads: 0,
        boardLoads: 0,
        cardWrites: new Set(),
        threadReads: new Map(),
        hostPasses: 0,
        hostRequests: 0,
      };
    },
    close: () => {
      const probe = state.probe;
      state.probe = null;
      return probe;
    },
    cardRead: <A, E, R>(cardId: string, effect: Effect.Effect<A, E, R>) =>
      seen((probe) => {
        if (!probe.cards.has(cardId)) return false;
        probe.cardReads += 1;
        return true;
      }, effect),
    // Counted, not timed: every step of a tick loads the board, not only the wait pass.
    boardLoad: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        if (state.probe !== null) state.probe.boardLoads += 1;
        return effect;
      }),
    cardWrite: <A, E, R>(cardId: string, effect: Effect.Effect<A, E, R>) =>
      seen((probe) => {
        if (!probe.cards.has(cardId)) return false;
        probe.cardWrites.add(cardId);
        return true;
      }, effect),
    threadRead: <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      seen((probe) => {
        if (!probe.threads.has(threadId)) return false;
        probe.threadReads.set(threadId, (probe.threadReads.get(threadId) ?? 0) + 1);
        return true;
      }, effect),
    hostRead: <A, E, R>(requests: number, effect: Effect.Effect<A, E, R>) =>
      seen((probe) => {
        probe.hostPasses += 1;
        probe.hostRequests += requests;
        return true;
      }, effect),
  };
};
type Watch = ReturnType<typeof makeWatch>;

/** A pull request as its host has it. */
interface HostPr {
  state: "open" | "merged";
  head: string;
  checks: "passing" | "pending";
}

/**
 * The wait PR reader, answering at once from `prs`. The real one asks a host
 * about a PR at most once in three minutes; this one is asked every tick and
 * answers every time, so a tick pays for one read however many PRs are waited on.
 * A PR it does not have is one a work thread watches: that thread's reading stands.
 */
const makeHost = (watch: Watch) => {
  const prs = new Map<string, HostPr>();
  const counts = { passes: 0, requests: 0 };
  const layer = Layer.succeed(
    KanbanWaitPrs,
    KanbanWaitPrs.of({
      read: (requests) =>
        watch.hostRead(
          requests.length,
          Effect.gen(function* () {
            counts.passes += 1;
            counts.requests += requests.length;
            yield* Effect.sleep(IO_MS);
            const at = DateTime.formatIso(yield* DateTime.now);
            const readings: Array<Waits.WaitPrFacts> = [];
            const read: Array<string> = [];
            for (const request of requests) {
              const pr = prs.get(request.url);
              if (pr === undefined) {
                if (request.live !== null) readings.push(request.live);
                continue;
              }
              read.push(request.url);
              readings.push({
                url: request.url,
                state: pr.state,
                at,
                head: pr.head,
                headAt: at,
                checks: pr.checks,
              });
            }
            return { readings, read, failed: [], carried: [] };
          }),
        ),
    }),
  );
  return { prs, counts, layer };
};

/** The store, with the reads and writes of card rows shown to the watch. */
const watchedStore = (watch: Watch) =>
  Layer.effect(
    KanbanStore.KanbanStore,
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      type Write = (
        ...args: ReadonlyArray<unknown>
      ) => Effect.Effect<unknown, KanbanStore.KanbanStoreError>;
      const recorded = Object.fromEntries(
        LOCKED_WRITES.map((name) => [
          name,
          (...args: ReadonlyArray<unknown>) =>
            watch.bump(name, (store[name] as unknown as Write)(...args)),
        ]),
      ) as unknown as Pick<KanbanStore.KanbanStoreShape, (typeof LOCKED_WRITES)[number]>;
      return KanbanStore.KanbanStore.of({
        ...store,
        ...recorded,
        cards: (boardId) => watch.boardLoad(store.cards(boardId)),
        card: (cardId) => watch.cardRead(cardId, store.card(cardId)),
        putCard: (card) => watch.cardWrite(card.id, recorded.putCard(card)),
      });
    }),
  ).pipe(Layer.provide(KanbanStore.layer));

const makeThreads = (watch: Watch) => {
  const threads = new Map<string, SoakThread>();
  /** Pull requests a thread watches, as its view reports them. */
  const prs = new Map<string, Array<KanbanThreadPr>>();
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
        prWatches: 0,
        prs: prs.get(threadId) ?? [],
        archived: false,
      };
      return view;
    }).pipe((effect) => watch.threadRead(threadId, effect));
  const failureOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      counts.reads += 1;
      yield* io();
      return threads.get(threadId)?.failure ?? null;
    }).pipe((effect) => watch.threadRead(threadId, effect));
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
          yield* watch.sent("launch", Effect.void);
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
          yield* watch.sent("send", Effect.void);
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
      cancelQueued: () => Effect.succeed(false),
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
  return { threads, prs, counts, stopped, layer, fail, awaitStart };
};

const soakLayer = (
  threads: Layer.Layer<KanbanThreads>,
  host: Layer.Layer<KanbanWaitPrs>,
  watch: Watch,
) =>
  KanbanService.layer.pipe(
    // As production: owner routes and write follow-ons are delivered after the reply.
    Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred")),
    Layer.provide(Layer.succeed(KanbanService.ReplayReads, true)),
    Layer.provide(Layer.succeed(KanbanService.DeferWriteEffects, true)),
    Layer.provideMerge(threads),
    Layer.provide(host),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(watchedStore(watch)),
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
      const watch = makeWatch();
      const fake = makeThreads(watch);
      const host = makeHost(watch);
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
      /** Each "kanban board tick failed", with what the engine said. */
      const tickFailures: Array<{ readonly at: number; readonly text: string }> = [];
      /** Every tick the driver ran: when, under which span, and whether its board gave up. */
      const tickRuns: Array<{
        readonly label: string;
        readonly alone: boolean;
        readonly from: number;
        to: number;
        readonly startNs: bigint;
        rootId: string | null;
        readonly spansFrom: number;
        spansTo: number;
        gaveUp: boolean;
      }> = [];
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
        if (key === "kanban board tick failed") {
          tickFailures.push({ at: performance.now(), text: text.slice(0, 500) });
        }
      });
      /** Ticks of the board that gave up: logged by the engine, and the tick call still succeeds. */
      const boardTicksFailed = () => logged.get("kanban board tick failed")?.count ?? 0;
      const timings = new Map<string, Array<number>>();
      const failed = new Map<string, number>();
      const firstFailure = new Map<string, string>();
      /** Runs one board call, timed; a failure is counted, not thrown. */
      const op = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const from = performance.now();
          // Named, so a write the call (or work it leaves running) makes can be traced to it.
          const exit = yield* Effect.exit(effect.pipe(Effect.withSpan(`soak:${name}`)));
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
      /** Runs one tick, timed as `name`, and records it for the report of who wrote during it. */
      const ticked = <E, R>(
        name: "tick" | "tick.quiet",
        label: string,
        alone: boolean,
        tick: Effect.Effect<void, E, R>,
      ) =>
        Effect.gen(function* () {
          const failedBefore = boardTicksFailed();
          const run: (typeof tickRuns)[number] = {
            label,
            alone,
            from: performance.now(),
            to: 0,
            startNs: yield* Clock.currentTimeNanos,
            rootId: null,
            spansFrom: spans.length,
            spansTo: 0,
            gaveUp: false,
          };
          tickRuns.push(run);
          const exit = yield* op(
            name,
            Effect.currentSpan.pipe(
              Effect.orElseSucceed(() => null),
              Effect.tap((span) =>
                Effect.sync(() => {
                  run.rootId = span?.spanId ?? null;
                }),
              ),
              Effect.andThen(tick),
            ),
          );
          run.to = performance.now();
          run.spansTo = spans.length;
          run.gaveUp = boardTicksFailed() > failedBefore;
          return { exit, gaveUp: run.gaveUp };
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
        const unparked = soakCards({
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
        const { cards: seeded, parked } = soakWaits({
          cards: unparked,
          seed: SEED + 2,
          nowMs: seededAt,
          midMs: WAIT_MID_MS,
          chainSteps: new Map(CHAINS.map((chain) => [chain.name, chain.steps.length])),
        });
        yield* Effect.forEach(seeded, (card) => store.putCard(card), { discard: true });
        const expected = new Set<string>(seeded.map((card) => card.id));
        // What the parked cards wait on: a PR its idle work thread watches is in that
        // thread's view, any other PR is on the host.
        const seededById = new Map(seeded.map((card) => [card.id as string, card]));
        for (const entry of parked) {
          const card = seededById.get(entry.cardId)!;
          const head = entry.sinceHead ?? "b0000000";
          if (entry.workThreadId === null) {
            if (entry.pr !== null)
              host.prs.set(entry.pr, { state: "open", head, checks: "pending" });
            continue;
          }
          const model = card.model ?? opus;
          fake.threads.set(entry.workThreadId, {
            running: false,
            model,
            messages: [],
            failure: null,
          });
          if (entry.pr !== null) {
            fake.prs.set(entry.workThreadId, [
              { url: entry.pr, title: null, state: "open", head, checks: "pending", at: null },
            ]);
          }
          yield* store.putThreadLink({
            threadId: ThreadId.make(entry.workThreadId),
            boardId: board.id,
            cardId: card.id,
            role: "work",
            purpose: null,
            discussionId: null,
            model,
            startedAt: card.movedAt,
            endedAt: null,
            paused: null,
          });
        }
        /** The `mid` waits end: PRs merge, a head moves, checks pass, the time comes. */
        const endMidWaits = Effect.gen(function* () {
          for (const entry of parked) {
            if (entry.park.ends !== "mid" || entry.pr === null) continue;
            if (entry.workThreadId !== null) {
              fake.prs.set(
                entry.workThreadId,
                (fake.prs.get(entry.workThreadId) ?? []).map((pr) => ({ ...pr, state: "merged" })),
              );
              continue;
            }
            const pr = host.prs.get(entry.pr);
            if (pr === undefined) continue;
            if (entry.park.on === "merge") pr.state = "merged";
            else if (entry.park.on === "push") pr.head = `c${pr.head.slice(1)}`;
            else pr.checks = "passing";
          }
          const left = seededAt + WAIT_MID_MS - (yield* Clock.currentTimeMillis);
          if (left >= 0) yield* Effect.sleep(left + 5);
        });
        /**
         * Whether each round's tick did its work. A board's tick that gives up (the board
         * changed under it eight times over) is logged and skipped, not failed, so the tick
         * call succeeds and every step of it, the wait pass included, comes a tick later.
         */
        const tickDone: Array<boolean> = [];
        /** The ticks that gave up, by where they ran. */
        const gaveUp: Array<string> = [];
        const firstDone = (from: number) => {
          const round = tickDone.indexOf(true, from);
          return round === -1 ? null : round;
        };
        /** The round after whose tick a parked card's wait was first seen gone. */
        const wokenAt = new Map<string, number>();
        const noteWoken = (cards: ReadonlyArray<KanbanCard>, round: number) => {
          const byId = new Map(cards.map((card) => [card.id as string, card]));
          for (const entry of parked) {
            if (wokenAt.has(entry.cardId)) continue;
            if (byId.get(entry.cardId)?.wait === undefined) wokenAt.set(entry.cardId, round);
          }
        };
        const random = soakRandom(SEED + 1);
        // The pools' setup queued a dispatch kick. Run that dispatch here, so the worker's
        // copy of it finds nothing to start: left to the worker it started the board's
        // first cards under the first tick, which then did not run by itself.
        yield* kanban.dispatchNow.pipe(Effect.orDie);
        // As production: queued dispatch kicks run on the worker.
        const worker = yield* Effect.forkChild(kanban.worker.pipe(Effect.withSpan("soak:worker")));

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
          if (round === WAIT_MID_ROUND) yield* endMidWaits;
          const first = yield* ticked("tick", `round ${round + 1}, by itself`, true, kanban.tick);
          tickDone.push(Exit.isSuccess(first.exit) && !first.gaveUp);
          if (first.gaveUp) gaveUp.push(`round ${round + 1}, by itself`);
          const cards = yield* cardsNow;
          noteWoken(cards, round);
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
            const midTick = ticked(
              "tick",
              `round ${round + 1}, in the round's traffic`,
              false,
              kanban.tick,
            ).pipe(
              Effect.tap((mid) =>
                Effect.sync(() => {
                  if (mid.gaveUp) gaveUp.push(`round ${round + 1}, in the round's traffic`);
                }),
              ),
              Effect.asVoid,
            );
            yield* Effect.all([...agents, ...ownerWork, midTick], {
              concurrency: "unbounded",
              discard: true,
            });
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

        // Waits: the ones whose reading changed or whose time came are over, the rest hold.
        noteWoken(settled, ROUNDS);
        const settledById = new Map(settled.map((card) => [card.id as string, card]));
        const kinds = new Map<string, { seeded: number; woken: number }>();
        for (const entry of parked) {
          const card = settledById.get(entry.cardId);
          const woke = wokenAt.get(entry.cardId);
          const kind = kinds.get(entry.park.kind) ?? { seeded: 0, woken: 0 };
          kinds.set(entry.park.kind, {
            seeded: kind.seeded + 1,
            woken: kind.woken + (woke === undefined ? 0 : 1),
          });
          if (card === undefined) continue;
          const name = `parked #${card.number} (${entry.park.kind})`;
          if (entry.park.ends === "never") {
            if (woke === undefined) continue;
            // The one reading the run itself can change: the card it waits on got done.
            const target = entry.waitsOn === null ? undefined : settledById.get(entry.waitsOn);
            if (
              target === undefined ||
              (target.settledAt === null && !KANBAN_DONE_STAGES.has(target.stage))
            ) {
              problems.push(
                `${name} lost its wait by round ${woke + 1} with nothing changed: now ${card.stage}`,
              );
            }
            continue;
          }
          // Over from the first tick that did its work: at the start, or once the driver ended it.
          const due = firstDone(entry.park.ends === "start" ? 0 : WAIT_MID_ROUND);
          if (woke === undefined) {
            if (due !== null) problems.push(`${name} was still parked at the end`);
          } else if (entry.park.ends === "mid" && entry.pr !== null && woke < WAIT_MID_ROUND) {
            problems.push(`${name} ended by round ${woke + 1}, before its reading changed`);
          } else if (due !== null && woke > due) {
            problems.push(
              `${name} ended by round ${woke + 1}; the tick of round ${due + 1} should have ended it`,
            );
          }
        }

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

        // Quiet ticks: no reading changes, so no wait ends. A parked card must cost its
        // check and nothing else: no write of its row, no read of its thread unless that
        // thread's view carries the PR it waits on (one read), one pass of the host reader.
        // The first tick is not counted: it completes what the settling left ready.
        const failedBeforeQuiet = boardTicksFailed();
        yield* Effect.exit(kanban.tick);
        const quiet = {
          parked: 0,
          woken: 0,
          passMs: [] as Array<number>,
          cardReads: [] as Array<number>,
          threadReads: [] as Array<number>,
          hostRequests: [] as Array<number>,
        };
        for (let i = 0; i < QUIET_TICKS; i += 1) {
          const before = new Map(
            (yield* cardsNow)
              .filter((card) => kanbanWaiting(card))
              .map((card) => [card.id as string, card]),
          );
          const threadOf = new Map(
            [...before.values()].flatMap((card) =>
              card.workThreadId === null ? [] : [[card.workThreadId as string, card] as const],
            ),
          );
          const spansBefore = spans.length;
          watch.open(new Set(before.keys()), new Set(threadOf.keys()));
          yield* ticked("tick.quiet", `quiet tick ${i + 1}, by itself`, true, kanban.tick);
          const probe = watch.close();
          // A tick redone because the board changed under it asks again.
          const ran =
            1 +
            Math.max(
              0,
              ...spans.slice(spansBefore).map((span) => {
                const attempt = span.attributes.get("board.rerun_attempt");
                return typeof attempt === "number" ? attempt : 0;
              }),
            );
          const after = new Map((yield* cardsNow).map((card) => [card.id as string, card]));
          if (probe === null) continue;
          const when = `quiet tick ${i + 1}`;
          for (const [id, card] of before) {
            const now = after.get(id);
            if (now === undefined || !kanbanWaiting(now)) {
              quiet.woken += 1;
              continue;
            }
            if (probe.cardWrites.has(id) || JSON.stringify(now) !== JSON.stringify(card)) {
              problems.push(`${when} wrote parked #${card.number} (${card.wait?.note})`);
            }
          }
          for (const [threadId, reads] of probe.threadReads) {
            const card = threadOf.get(threadId)!;
            const name = `parked #${card.number} (${card.wait?.note})`;
            if (card.wait?.pr == null) {
              problems.push(
                `${when} read the thread of ${name} ${reads} times; it waits on no pull request`,
              );
            } else if (reads > ran) {
              problems.push(`${when} read the thread of ${name} ${reads} times in ${ran} run(s)`);
            }
          }
          if (probe.hostPasses > ran) {
            problems.push(`${when} asked the host reader ${probe.hostPasses} times`);
          }
          // A wait that holds is checked on the card the tick already loaded.
          if (probe.cardReads > 0) {
            problems.push(
              `${when} read the rows of parked cards ${probe.cardReads} times; none of them had anything to save`,
            );
          }
          quiet.parked = before.size;
          if (probe.first !== null && probe.last !== null) {
            quiet.passMs.push(probe.last - probe.first);
          }
          quiet.cardReads.push(probe.cardReads);
          quiet.threadReads.push([...probe.threadReads.values()].reduce((sum, n) => sum + n, 0));
          quiet.hostRequests.push(probe.hostRequests);
        }
        if (boardTicksFailed() > failedBeforeQuiet) {
          gaveUp.push(
            `${boardTicksFailed() - failedBeforeQuiet} of the quiet ticks, by themselves`,
          );
        }

        // A script's check came back with nothing new for any of its cards: the answers
        // go to the board as the scripts' pass sends them, in one batch. That is one
        // load of the board, whatever the number of cards, and no card read or written.
        const scripted = (yield* cardsNow).filter(
          (card) => kanbanWaiting(card) && card.wait?.on === "script",
        );
        const batch = { cards: scripted.length, boardLoads: 0, cardReads: 0, cardWrites: 0, ms: 0 };
        if (scripted.length > 0) {
          watch.open(new Set(scripted.map((card) => card.id as string)), new Set());
          const from = performance.now();
          const outcomes = yield* kanban
            .answerWaits(
              board.id,
              scripted.map((card) => ({
                card: card.id,
                answer: { result: "hold" as const },
                script: SOAK_SCRIPT,
                expect: card.wait?.at ?? null,
              })),
              { _tag: "system", component: "wait-checks" },
            )
            .pipe(Effect.orDie);
          batch.ms = Math.round((performance.now() - from) * 10) / 10;
          const probe = watch.close();
          batch.boardLoads = probe?.boardLoads ?? 0;
          batch.cardReads = probe?.cardReads ?? 0;
          batch.cardWrites = probe?.cardWrites.size ?? 0;
          const refused = outcomes.filter((outcome) => !outcome.ok);
          if (refused.length > 0) {
            problems.push(
              `script batch: ${refused.length} of ${outcomes.length} answers were refused: ${refused[0]?.ok === false ? refused[0].detail : ""}`,
            );
          }
          if (batch.boardLoads !== 1 || batch.cardReads > 0 || batch.cardWrites > 0) {
            problems.push(
              `script batch of ${batch.cards} holds: ${batch.boardLoads} board loads, ${batch.cardReads} card rows read, ${batch.cardWrites} cards written (one load, none read, none written)`,
            );
          }
          const after = new Map((yield* cardsNow).map((card) => [card.id as string, card]));
          for (const card of scripted) {
            if (JSON.stringify(after.get(card.id)) !== JSON.stringify(card)) {
              problems.push(`script batch changed parked #${card.number}, whose check said hold`);
            }
          }
        }

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
          gaveUp,
          firstTickDone: tickDone[0] === true,
          batch,
          waits: {
            parked: parked.length,
            open: unparked.filter((card) => card.stage === "todo" || card.stage === "needs_review")
              .length,
            woken: wokenAt.size,
            wokenAtFirstTick: [...wokenAt.values()].filter((round) => round === 0).length,
            byKind: Object.fromEntries(kinds),
            hostPasses: host.counts.passes,
            hostRequests: host.counts.requests,
          },
          quiet,
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(soakLayer(fake.layer, host.layer, watch), Logger.layer([warnings])),
        ),
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
      // Who moved the board's generation while each tick ran. A tick is redone when a
      // write lands while it is outside the gate, and gives up after eight redos or
      // on the first one after it has written or sent something itself.
      const rootOf = new Map<string, string>();
      const rootIdOf = (span: Tracer.Span) => {
        const known = rootOf.get(span.spanId);
        if (known !== undefined) return known;
        const root = spanChain(span)[0]?.spanId ?? span.spanId;
        rootOf.set(span.spanId, root);
        return root;
      };
      const ticksWatched = tickRuns.map((run) => {
        const during = watch.bumps.filter((bump) => bump.at >= run.from && bump.at <= run.to);
        const groups = new Map<
          string,
          {
            writes: number;
            readonly operations: Set<string>;
            readonly startedBefore: Set<string>;
            first: number;
            last: number;
            readonly methods: Map<string, number>;
          }
        >();
        let own = 0;
        for (const bump of during) {
          const mine = bump.rootId !== null && bump.rootId === run.rootId;
          if (mine) own += 1;
          const kind = mine
            ? "the tick itself"
            : bump.root === "soak:worker"
              ? "a worker job"
              : !bump.root.startsWith("soak:")
                ? "background work no call of the driver started"
                : bump.rootEnded
                  ? "left running by an earlier call"
                  : "a call running beside it";
          const key = `${kind}: ${bump.chain}`;
          const group = groups.get(key) ?? {
            writes: 0,
            operations: new Set<string>(),
            startedBefore: new Set<string>(),
            first: bump.at - run.from,
            last: bump.at - run.from,
            methods: new Map<string, number>(),
          };
          group.writes += 1;
          group.last = bump.at - run.from;
          group.methods.set(bump.method, (group.methods.get(bump.method) ?? 0) + 1);
          if (bump.opId !== null) {
            group.operations.add(bump.opId);
            if (bump.opStart !== null && bump.opStart < run.startNs)
              group.startedBefore.add(bump.opId);
          }
          groups.set(key, group);
        }
        let redone = 0;
        for (const span of spans.slice(run.spansFrom, run.spansTo)) {
          if (span.name !== "KanbanService.serial") continue;
          if (span.attributes.get("serial.queue") !== "ticking") continue;
          if (rootIdOf(span) !== run.rootId) continue;
          const attempt = span.attributes.get("board.rerun_attempt");
          if (typeof attempt === "number") redone = Math.max(redone, attempt);
        }
        return {
          tick: run.label,
          alone: run.alone,
          ms: Math.round(run.to - run.from),
          gaveUp: run.gaveUp,
          redone,
          said:
            tickFailures.find((failure) => failure.at >= run.from && failure.at <= run.to + 5)
              ?.text ?? null,
          ownWrites: own,
          ownSends: (() => {
            const counts = new Map<string, number>();
            for (const send of watch.sends) {
              if (send.at < run.from || send.at > run.to || send.rootId !== run.rootId) continue;
              counts.set(send.chain, (counts.get(send.chain) ?? 0) + 1);
            }
            return Object.fromEntries(counts);
          })(),
          otherWrites: during.length - own,
          writers: [...groups]
            .map(([who, group]) => ({
              who,
              writes: group.writes,
              operations: group.operations.size,
              startedBeforeTheTick: group.startedBefore.size,
              firstMs: Math.round(group.first),
              lastMs: Math.round(group.last),
              methods: Object.fromEntries(group.methods),
            }))
            .toSorted((a, b) => b.writes - a.writes),
        };
      });
      const { quiet, ...boardResult } = result;
      const most = (values: ReadonlyArray<number>) =>
        values.length === 0 ? 0 : Math.max(...values);
      const report = {
        config: { full: FULL, cards: CARDS, rounds: ROUNDS, seed: SEED, ioMs: IO_MS },
        board: boardResult,
        // Ticks in which no wait ends: what the parked cards cost, the most seen in one tick.
        waitPass: {
          ticks: quiet.cardReads.length,
          parked: quiet.parked,
          woken: quiet.woken,
          ms: summary(quiet.passMs),
          cardRowsRead: most(quiet.cardReads),
          threadViewsRead: most(quiet.threadReads),
          hostRequests: most(quiet.hostRequests),
        },
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
          boardTicksFailed: boardTicksFailed(),
          ticksGivenUpAt: result.gaveUp,
        },
        ticks: ticksWatched,
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
            `waits parked=${result.waits.parked} of ${result.waits.open} open, woken=${result.waits.woken} (${result.waits.wokenAtFirstTick} at the first tick), still parked=${result.waits.parked - result.waits.woken}; woken/seeded: ${Object.entries(
              result.waits.byKind,
            )
              .map(([kind, entry]) => `${kind} ${entry.woken}/${entry.seeded}`)
              .join("; ")}`,
            `wait pass (quiet tick, ${report.waitPass.parked} parked) n=${report.waitPass.ms.n} p50=${report.waitPass.ms.p50}ms p95=${report.waitPass.ms.p95}ms max=${report.waitPass.ms.max}ms; most in a tick: card rows read=${report.waitPass.cardRowsRead} thread views read=${report.waitPass.threadViewsRead} host requests=${report.waitPass.hostRequests} card writes=0; woken in those ticks=${report.waitPass.woken}`,
            `reruns=${reruns} deepest=${deepest} turnEnds=${result.turnEnds} attempts=${turnEndAttempts} failed=${result.turnEndsFailed} savedThenFailed=${savedThenFailed.length}`,
            `ticksGivenUp=${boardTicksFailed()} of ${(report.timings.tick?.n ?? 0) + (report.timings["tick.quiet"]?.n ?? 0) + 1}${result.gaveUp.length > 0 ? ` (${result.gaveUp.join("; ")})` : ""}`,
            // Who wrote while a tick ran. In full for a tick that ran by itself; the ticks
            // run through a round's traffic are summed (KANBAN_SOAK_OUT has each of them).
            ...ticksWatched.flatMap((tick) => {
              if (!tick.alone || (!tick.gaveUp && tick.otherWrites === 0)) return [];
              return [
                `TICK ${tick.tick}: ${tick.gaveUp ? "GAVE UP" : "did its work"} in ${tick.ms}ms, redone ${tick.redone}x, its own writes=${tick.ownWrites}, writes by others=${tick.otherWrites}, its own sends=${JSON.stringify(tick.ownSends)}${tick.said === null ? "" : `; engine: ${tick.said.split("\n")[0]?.slice(0, 160)}`}`,
                ...tick.writers
                  .slice(0, 8)
                  .map(
                    (writer) =>
                      `   ${writer.writes} writes at +${writer.firstMs}..${writer.lastMs}ms in ${writer.operations} operation(s), ${writer.startedBeforeTheTick} begun before the tick: ${writer.who} ${JSON.stringify(writer.methods)}`,
                  ),
              ];
            }),
            (() => {
              const busy = ticksWatched.filter((tick) => !tick.alone && tick.gaveUp);
              const kinds = new Map<string, number>();
              for (const tick of busy) {
                for (const writer of tick.writers) {
                  const kind = writer.who.split(": ")[0] ?? writer.who;
                  kinds.set(kind, (kinds.get(kind) ?? 0) + writer.writes);
                }
              }
              return `ticks in traffic that gave up: ${busy.length}, after 8 redos ${busy.filter((tick) => tick.redone >= 8).length}, after their own write or send ${busy.filter((tick) => tick.redone < 8).length}; writes during them: ${
                [...kinds]
                  .toSorted((a, b) => b[1] - a[1])
                  .map(([kind, writes]) => `${writes} by ${kind}`)
                  .join(", ") || "none"
              }`;
            })(),
            `ticks by themselves: ${ticksWatched.filter((tick) => tick.alone).length}, gave up ${ticksWatched.filter((tick) => tick.alone && tick.gaveUp).length}, with writes by others during them ${ticksWatched.filter((tick) => tick.alone && tick.otherWrites > 0).length}; ticks in traffic: ${ticksWatched.filter((tick) => !tick.alone).length}, gave up ${ticksWatched.filter((tick) => !tick.alone && tick.gaveUp).length}`,
            `script batch (${result.batch.cards} cards, all hold): board loads=${result.batch.boardLoads} card rows read=${result.batch.cardReads} cards written=${result.batch.cardWrites} in ${result.batch.ms}ms`,
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
      assert.isAbove(result.waits.woken, 0, "waits ended during the run");
      assert.isAbove(report.waitPass.parked, 0, "cards were still parked for the quiet ticks");
      assert.isAtMost(report.waitPass.ms.p95 ?? 0, CEILING.waitPassP95Ms, "wait pass p95");
      assert.isTrue(result.firstTickDone, "the first tick did its work");
      assert.deepStrictEqual(
        result.gaveUp.filter(
          (where) => where.includes("by itself") || where.includes("by themselves"),
        ),
        [],
        "no tick that runs by itself gives up",
      );
      assert.isAtMost(boardTicksFailed(), CEILING.ticksGivenUp, "ticks that gave up");
      assert.isAbove(result.batch.cards, 0, "cards waited on a script for the batch");
    }),
  { timeout: FULL ? 900_000 : 120_000 },
);
