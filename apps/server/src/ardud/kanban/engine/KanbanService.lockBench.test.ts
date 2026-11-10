/**
 * Board write latency under production-shaped contention (board-lock-diet, 10 Nov 2026).
 *
 * Production traces showed card writes and background board work spending
 * 80-95% of their time queued for the one state-DB view reader, and turn ends
 * rerunning up to 8 times when a board write landed during such a read. The
 * fake thread layer here models exactly that: every thread read, send and
 * launch takes the one `reader` permit for its service time, while a
 * background loop keeps the reader about two-thirds busy, as the rest of the
 * server does. Turn ends and ticks run in the background; owner and agent
 * writes are timed.
 *
 * Opt-in: KANBAN_LOCK_BENCH=1 (seconds via KANBAN_LOCK_BENCH_SECONDS, JSON to
 * KANBAN_LOCK_BENCH_OUT). Without it a 4-second smoke run checks that the
 * workload runs and that writes keep completing.
 */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as NodeFs from "node:fs";

import {
  ProjectId,
  ThreadId,
  type KanbanActor,
  type KanbanCard,
  type ModelSelection,
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
import { opencodeTestProvider } from "./testProviders.ts";
import { KanbanThreads, type KanbanThreadView } from "./threads.ts";

const env = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const FULL = process.env.KANBAN_LOCK_BENCH === "1";
const SECONDS = FULL ? env("KANBAN_LOCK_BENCH_SECONDS", 60) : 4;
const WORKERS = env("KANBAN_LOCK_BENCH_WORKERS", 12);
/** Service time of one state read while it holds the reader. */
const READ_MS = env("KANBAN_LOCK_BENCH_READ_MS", 25);
/** Other server traffic on the same reader: busy this long, then idle OTHER_GAP_MS. */
const OTHER_MS = env("KANBAN_LOCK_BENCH_OTHER_MS", 12);
const OTHER_GAP_MS = env("KANBAN_LOCK_BENCH_OTHER_GAP_MS", 6);
const TURN_END_EVERY_MS = env("KANBAN_LOCK_BENCH_TURN_END_EVERY_MS", 150);
const TICK_EVERY_MS = env("KANBAN_LOCK_BENCH_TICK_EVERY_MS", 3000);
const OWNER_EVERY_MS = env("KANBAN_LOCK_BENCH_OWNER_EVERY_MS", 400);
const AGENT_EVERY_MS = env("KANBAN_LOCK_BENCH_AGENT_EVERY_MS", 500);

interface Thread {
  running: boolean;
  readonly messages: Array<string>;
}

const makeThreads = Effect.gen(function* () {
  const reader = yield* Semaphore.make(1);
  const threads = new Map<string, Thread>();
  const counts = { reads: 0, sends: 0, launches: 0, interrupts: 0 };
  let next = 0;
  const hold = (ms: number) => reader.withPermits(1)(Effect.sleep(ms));
  const read = (threadId: ThreadId) =>
    Effect.gen(function* () {
      counts.reads += 1;
      yield* hold(READ_MS);
      const thread = threads.get(threadId);
      if (!thread) return null;
      const at = new Date(yield* Clock.currentTimeMillis).toISOString();
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
  const quick = <A>(value: A) =>
    Effect.sync(() => void (counts.reads += 1)).pipe(
      Effect.andThen(hold(READ_MS)),
      Effect.as(value),
    );
  const layer = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      view: read,
      find: read,
      model: () => quick<ModelSelection | null>(null),
      lastFailure: () => quick(null),
      findLastFailure: () => quick(null),
      latestRun: () => quick(null),
      compactRun: () => quick(null),
      // A launch reads and writes thread state several times (receipts, projection, transcript).
      launch: (input) =>
        Effect.gen(function* () {
          counts.launches += 1;
          for (let i = 0; i < 4; i += 1) yield* hold(READ_MS);
          next += 1;
          const threadId = ThreadId.make(`bench-thread-${next}`);
          threads.set(threadId, { running: true, messages: [input.text] });
          return threadId;
        }),
      send: (input) =>
        Effect.gen(function* () {
          counts.sends += 1;
          for (let i = 0; i < 3; i += 1) yield* hold(READ_MS);
          const thread = threads.get(input.threadId);
          if (thread) {
            thread.messages.push(input.text);
            thread.running = true;
          }
        }),
      setModel: () => Effect.void,
      interrupt: (threadId) =>
        Effect.gen(function* () {
          counts.interrupts += 1;
          yield* hold(READ_MS);
          const thread = threads.get(threadId);
          if (thread) thread.running = false;
        }),
    }),
  );
  return { reader, threads, counts, layer, hold };
});

const benchLayer = (threads: Layer.Layer<KanbanThreads>) =>
  KanbanService.layer.pipe(
    // As production: owner routes are delivered after the reply.
    Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred")),
    Layer.provide(
      Layer.succeed(KanbanService.ReplayReads, process.env.KANBAN_LOCK_BENCH_REPLAY !== "0"),
    ),
    Layer.provide(
      Layer.succeed(KanbanService.DeferWriteEffects, process.env.KANBAN_LOCK_BENCH_DEFER !== "0"),
    ),
    Layer.provideMerge(threads),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-kanban-bench-" }).pipe(
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
  p99: pct(values, 0.99),
  max: values.length === 0 ? null : Math.round(Math.max(...values) * 10) / 10,
});

it.live(
  `board writes under reader contention and background turn ends (${SECONDS}s)`,
  () =>
    Effect.gen(function* () {
      const fake = yield* makeThreads;
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          if (
            options.name === "KanbanService.serial" ||
            options.name === "KanbanService.turnEndedUnlocked" ||
            options.name.endsWith("Unlocked")
          )
            spans.push(span);
          return span;
        },
      });
      // Warnings the service logs (failed deliveries and the like), kept for the report.
      const logged: Array<string> = [];
      const warnings = Logger.make(({ message, logLevel, cause }) => {
        if (logLevel !== "Warn" && logLevel !== "Error") return;
        if (logged.length >= 200) return;
        const parts = (Array.isArray(message) ? message : [message]).map((part) => {
          if (typeof part !== "object" || part === null) return String(part);
          return Object.entries(part)
            .map(([key, value]) =>
              `${key}=${Cause.isCause(value) ? Cause.pretty(value) : String(value)}`,
            )
            .join(" ");
        });
        logged.push(`${parts.join(" ").slice(0, 900)} ${Cause.isCause(cause) && cause.reasons.length > 0 ? Cause.pretty(cause).slice(0, 300) : ""}`);
      });
      const timings = new Map<string, Array<number>>();
      const failures = new Map<string, number>();
      const firstFailure = new Map<string, string>();
      const timed = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const started = performance.now();
          const exit = yield* Effect.exit(effect);
          const list = timings.get(name) ?? [];
          list.push(performance.now() - started);
          timings.set(name, list);
          if (Exit.isFailure(exit)) {
            failures.set(name, (failures.get(name) ?? 0) + 1);
            if (!firstFailure.has(name)) firstFailure.set(name, String(exit.cause).slice(0, 300));
          }
          return exit;
        });

      const result = yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const board = yield* kanban.ensureBoard({
          slug: "bench",
          name: "Bench",
          defaultProjectId: ProjectId.make("project-1"),
        });
        yield* kanban.setPool(board.id, board.defaultCardModel, WORKERS);
        for (let i = 0; i < WORKERS; i += 1) {
          yield* kanban.createCard(board.id, { prompt: `Work item ${i}`, title: `Work ${i}` }, owner);
        }
        yield* kanban.dispatchNow;
        const working = (yield* kanban.cards(board.id)).filter(
          (card) => card.workThreadId !== null,
        );
        assert.isAtLeast(working.length, 1);
        const discussion = yield* kanban.createDiscussion(board.id, "Owner notes", owner);
        const deadline = (yield* Clock.currentTimeMillis) + SECONDS * 1000;
        const until = (loop: Effect.Effect<void, never, never>, everyMs: number) =>
          Effect.gen(function* () {
            while ((yield* Clock.currentTimeMillis) < deadline) {
              yield* loop;
              yield* Effect.sleep(everyMs);
            }
          });
        let seed = 7;
        const random = (n: number) => {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          return seed % n;
        };

        const other = until(fake.hold(OTHER_MS), OTHER_GAP_MS);
        const turnEnds = until(
          Effect.gen(function* () {
            const cards = yield* kanban.cards(board.id).pipe(Effect.orDie);
            const live = cards.filter((card) => card.workThreadId !== null);
            if (live.length === 0) return;
            const card = live[random(live.length)]!;
            const thread = fake.threads.get(card.workThreadId!);
            if (thread) thread.running = false;
            // As production: each turn end is its own job, many in flight at once.
            yield* timed("background.turnEnded", kanban.turnEnded(card.workThreadId!)).pipe(
              Effect.forkDetach,
            );
          }),
          TURN_END_EVERY_MS,
        );
        const ticks = until(timed("background.tick", kanban.tick).pipe(Effect.asVoid), TICK_EVERY_MS);

        const ownerCards: Array<KanbanCard> = [];
        let ownerStep = 0;
        const ownerWrites = until(
          Effect.gen(function* () {
            ownerStep += 1;
            switch (ownerStep % 6) {
              case 0: {
                const exit = yield* timed(
                  "owner.createCard",
                  kanban.createCard(
                    board.id,
                    { prompt: `Owner idea ${ownerStep}`, title: `Idea ${ownerStep}` },
                    owner,
                  ),
                );
                if (Exit.isSuccess(exit)) ownerCards.push(exit.value);
                return;
              }
              case 1: {
                const card = ownerCards[random(Math.max(1, ownerCards.length))];
                if (!card) return;
                const detail = yield* kanban.card(card.id).pipe(Effect.orDie);
                const to = detail.card.stage === "completed" ? "todo" : "completed";
                yield* timed("owner.moveCard", kanban.moveCard(card.id, to, "owner", owner));
                return;
              }
              case 2: {
                yield* timed(
                  "owner.post",
                  kanban.post(discussion.id, owner, [
                    { _tag: "md", text: `Owner note ${ownerStep}` },
                  ]),
                );
                return;
              }
              case 4: {
                // The owner drops an agent's question: the asker hears it.
                const cards = yield* kanban.cards(board.id).pipe(Effect.orDie);
                const asked = cards.flatMap((card) =>
                  card.asks
                    .filter((ask) => ask.closedAt === null)
                    .map((ask) => ({ card, ask })),
                );
                if (asked.length === 0) return;
                const { card, ask } = asked[random(asked.length)]!;
                yield* timed(
                  "owner.dropAsk",
                  kanban.changeAsk(card.id, ask.id, "drop", owner, "owner"),
                );
                return;
              }
              case 5: {
                // The owner pulls a working card back: its thread is let go.
                const cards = yield* kanban.cards(board.id).pipe(Effect.orDie);
                const live = cards.filter((card) => card.stage === "working");
                if (live.length === 0) return;
                const card = live[random(live.length)]!;
                yield* timed("owner.moveWorking", kanban.moveCard(card.id, "todo", "owner", owner));
                return;
              }
              default: {
                const card = working[random(working.length)]!;
                yield* timed(
                  "owner.editCard",
                  kanban.editCard(card.id, { title: `Work renamed ${ownerStep}` }, owner),
                );
              }
            }
          }).pipe(Effect.orDie),
          OWNER_EVERY_MS,
        );
        let agentStep = 0;
        const agentWrites = until(
          Effect.gen(function* () {
            agentStep += 1;
            const cards = yield* kanban.cards(board.id).pipe(Effect.orDie);
            const live = cards.filter((card) => card.workThreadId !== null);
            if (live.length === 0) return;
            const card = live[random(live.length)]!;
            const actor: KanbanActor = { _tag: "thread", threadId: card.workThreadId! };
            if (agentStep % 4 === 0 && card.activeThreadId === card.workThreadId) {
              yield* timed(
                "agent.askOwner",
                kanban.askOwner(
                  card.id,
                  { question: `Which API for card ${card.number}?`, blocking: false },
                  actor,
                  "cardThread",
                ),
              );
              return;
            }
            const text =
              agentStep % 3 === 0
                ? `Should I split card ${card.number} into two PRs?`
                : `Progress on ${card.number}: step ${agentStep} done.`;
            yield* timed(
              agentStep % 3 === 0 ? "agent.postQuestion" : "agent.postStatus",
              kanban.postToCard(card.id, actor, [{ _tag: "md", text }]),
            );
          }),
          AGENT_EVERY_MS,
        );

        const fibers = yield* Effect.all(
          [other, turnEnds, ticks, ownerWrites, agentWrites].map((loop) => Effect.forkChild(loop)),
        );
        yield* Effect.forEach(fibers, Fiber.join, { discard: true });
        // Let in-flight turn ends and route drains settle, bounded: every saved
        // follow-on must reach an outcome.
        const sql = yield* SqlClient.SqlClient;
        const pending = () =>
          sql<{ n: number }>`SELECT count(*) AS n FROM ardud_kanban_owner_routes WHERE done_at IS NULL`.pipe(
            Effect.map((rows) => rows[0]?.n ?? 0),
            Effect.orDie,
          );
        const settleBy = (yield* Clock.currentTimeMillis) + Math.max(20_000, SECONDS * 500);
        yield* Effect.sleep(2_000);
        while ((yield* pending()) > 0 && (yield* Clock.currentTimeMillis) < settleBy)
          yield* Effect.sleep(500);
        const routes = yield* sql<{ kind: string; outcome: string | null; n: number }>`
          SELECT coalesce(json_extract(json, '$.effect.kind'), json_extract(json, '$.kind')) AS kind,
                 CASE WHEN done_at IS NULL THEN 'pending' ELSE json_extract(json, '$.outcome') END AS outcome,
                 count(*) AS n
          FROM ardud_kanban_owner_routes GROUP BY 1, 2 ORDER BY 1, 2
        `.pipe(Effect.orDie);
        return { boardId: board.id, routes };
      }).pipe(
        Effect.provide(benchLayer(fake.layer)),
        Effect.provide(Logger.layer([warnings])),
        Effect.withTracer(tracer),
      );

      const ms = (span: Tracer.NativeSpan) =>
        span.status._tag === "Ended"
          ? Number(span.status.endTime - span.status.startTime) / 1e6
          : null;
      const serialWaits = new Map<string, Array<number>>();
      const serialHolds = new Map<string, Array<number>>();
      const admission = new Map<string, Array<number>>();
      let turnEndAttempts = 0;
      let turnEndFailedAttempts = 0;
      for (const span of spans) {
        const duration = ms(span);
        if (duration === null) continue;
        const adm = span.attributes.get("board.admission_wait_ms");
        if (typeof adm === "number") {
          const list = admission.get(span.name) ?? [];
          list.push(adm);
          admission.set(span.name, list);
        }
        if (span.name === "KanbanService.serial") {
          const queue = String(span.attributes.get("serial.queue"));
          const wait = Number(span.attributes.get("serial.wait_ms") ?? 0);
          (serialWaits.get(queue) ?? serialWaits.set(queue, []).get(queue)!).push(wait);
          (serialHolds.get(queue) ?? serialHolds.set(queue, []).get(queue)!).push(duration - wait);
        }
        if (span.name === "KanbanService.turnEndedUnlocked") {
          turnEndAttempts += 1;
          if (span.status._tag === "Ended" && Exit.isFailure(span.status.exit))
            turnEndFailedAttempts += 1;
        }
      }
      const report = {
        config: {
          variant: process.env.KANBAN_LOCK_BENCH_VARIANT ?? null,
          replayReads: process.env.KANBAN_LOCK_BENCH_REPLAY !== "0",
          deferWrites: process.env.KANBAN_LOCK_BENCH_DEFER !== "0",
          seconds: SECONDS,
          workers: WORKERS,
          readMs: READ_MS,
          otherMs: OTHER_MS,
          otherGapMs: OTHER_GAP_MS,
          turnEndEveryMs: TURN_END_EVERY_MS,
          tickEveryMs: TICK_EVERY_MS,
          ownerEveryMs: OWNER_EVERY_MS,
          agentEveryMs: AGENT_EVERY_MS,
        },
        boardId: result.boardId,
        routes: result.routes,
        writes: Object.fromEntries(
          [...timings].map(([name, values]) => [
            name,
            { ...summary(values), failed: failures.get(name) ?? 0 },
          ]),
        ),
        serialWait: Object.fromEntries([...serialWaits].map(([q, v]) => [q, summary(v)])),
        serialHold: Object.fromEntries([...serialHolds].map(([q, v]) => [q, summary(v)])),
        admissionWait: Object.fromEntries(
          [...admission]
            .filter(([, v]) => v.length >= 3)
            .map(([name, v]) => [name, summary(v)]),
        ),
        firstFailure: Object.fromEntries(firstFailure),
        warnings: logged.slice(0, 40),
        turnEnd: { attempts: turnEndAttempts, failedAttempts: turnEndFailedAttempts },
        threadIo: fake.counts,
      };
      // oxlint-disable-next-line no-console
      console.log(`KANBAN_LOCK_BENCH ${JSON.stringify(report)}`);
      if (process.env.KANBAN_LOCK_BENCH_OUT)
        NodeFs.writeFileSync(process.env.KANBAN_LOCK_BENCH_OUT, JSON.stringify(report, null, 2));
      for (const name of ["owner.createCard", "owner.post", "agent.postStatus"]) {
        assert.isAbove(report.writes[name]?.n ?? 0, 0, `${name} completed at least once`);
      }
    }),
  { timeout: (SECONDS + 60) * 1000 },
);
