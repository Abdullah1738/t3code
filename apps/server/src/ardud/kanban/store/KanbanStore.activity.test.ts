import { assert, it } from "@effect/vitest";
import {
  KanbanBoardId,
  KanbanCardId,
  ProviderInstanceId,
  ThreadId,
  type KanbanCard,
  type KanbanCardEvent,
  type KanbanThreadLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as Activity from "../engine/activity.ts";
import * as KanbanStore from "./KanbanStore.ts";
import { initializeKanbanSchema } from "../../persistence/kanbanSchema.ts";

const TestLayer = KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const boardId = KanbanBoardId.make("board-large");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const before = "2026-11-01T00:00:00.000Z";
const window = { since: "2026-11-16T00:00:00.000Z", until: "2026-11-17T00:00:00.000Z" };

const fixtureCard = (number: number, count: number): KanbanCard => {
  const settled = number <= count - Math.min(count, 300);
  return {
    id: KanbanCardId.make(`large-${number}`),
    boardId,
    number,
    title: `Card ${number}`,
    description: "A measured board fixture. ".repeat(80),
    prompt: "Work instructions. ".repeat(100),
    stage: settled ? "verified" : number % 3 === 0 ? "working" : "todo",
    priority: 2,
    goalId: null,
    projects: [],
    model,
    models: [],
    subtasks: [],
    subtaskSeq: 0,
    projectId: null,
    links: [],
    blockedBy: [],
    stalled: null,
    question: null,
    asks:
      number % 17 === 0
        ? [
            {
              id: "q1",
              text: "Decision",
              blocking: false,
              by: { _tag: "owner" },
              at: before,
              closedAt: settled ? window.since : null,
              seq: null,
            },
          ]
        : [],
    reviewChain: null,
    reviewStep: 0,
    reviewRound: 0,
    activeThreadId: null,
    activeRole: null,
    activePool: null,
    workThreadId: null,
    reviewThreadId: null,
    discussionId: null,
    wakeNote: null,
    nudgedAt: null,
    settledAt: settled ? "2026-11-14T00:00:00.000Z" : null,
    createdBy: { _tag: "owner" },
    createdAt: before,
    updatedAt: before,
    movedAt: before,
  };
};

const seed = Effect.fn("ActivityFixture.seed")(function* (count: number, threadCount: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (let start = 1; start <= count; start += 100) {
        const cards = Array.from({ length: Math.min(100, count - start + 1) }, (_, i) =>
          fixtureCard(start + i, count),
        );
        yield* sql`INSERT INTO ardud_kanban_cards ${sql.insert(
          cards.map((card) => ({
            id: card.id,
            board_id: boardId,
            number: card.number,
            stage: card.stage,
            active_thread_id: null,
            json: JSON.stringify(card),
          })),
        )}`;
        const events = cards.flatMap((card) =>
          Array.from({ length: 32 }, (_, index) => {
            const recent = card.number > count - 50 && index >= 29;
            const event: Omit<KanbanCardEvent, "id"> = {
              cardId: card.id,
              actor: { _tag: "owner" },
              kind:
                index === 0
                  ? "created"
                  : index === 15
                    ? "wait_set"
                    : index === 16
                      ? "wait_cleared"
                      : index === 28
                        ? "moved"
                        : "comment",
              at: recent
                ? `2026-11-16T${String(index - 29).padStart(2, "0")}:00:00.000Z`
                : `2026-11-${String(1 + Math.floor(index / 3)).padStart(2, "0")}T00:00:00.000Z`,
              fromStage: index === 28 ? "todo" : null,
              toStage: index === 0 ? "todo" : index === 28 ? card.stage : null,
              body:
                index === 15
                  ? "Waiting for CI"
                  : index === 16
                    ? "Wait ended: cleared"
                    : "Fixture event. ".repeat(35),
              head: null,
            };
            return { card_id: card.id, json: JSON.stringify(event) };
          }),
        );
        for (let i = 0; i < events.length; i += 200)
          yield* sql`INSERT INTO ardud_kanban_card_events ${sql.insert(events.slice(i, i + 200))}`;
      }
      for (let start = 0; start < threadCount; start += 100) {
        const threads = Array.from({ length: Math.min(100, threadCount - start) }, (_, i) => {
          const n = start + i;
          const link: KanbanThreadLink = {
            threadId: ThreadId.make(`large-thread-${n}`),
            boardId,
            cardId: KanbanCardId.make(`large-${(n % count) + 1}`),
            role: n % 3 === 0 ? "review" : "work",
            purpose: null,
            discussionId: null,
            paused: null,
            model,
            startedAt: n < threadCount - 30 ? before : window.since,
            endedAt: n < threadCount - 30 ? "2026-11-02T00:00:00.000Z" : null,
          };
          return {
            thread_id: link.threadId,
            board_id: boardId,
            card_id: link.cardId,
            ended: Number(link.endedAt !== null),
            json: JSON.stringify(link),
          };
        });
        yield* sql`INSERT INTO ardud_kanban_threads ${sql.insert(threads)}`;
      }
    }),
  );
});

const legacyHistory = Effect.fn("ActivityFixture.legacyHistory")(function* (range = window) {
  const window = range;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: number; json: string }>`
          WITH history AS (
            SELECT e.id, e.card_id, json_extract(e.json, '$.at') AS at,
              json_extract(e.json, '$.kind') AS kind,
              substr(json_extract(e.json, '$.body'), 1, length('Wait expired: ')) AS body,
              json_extract(e.json, '$.toStage') AS to_stage,
              json_extract(e.json, '$.fromStage') AS from_stage
            FROM ardud_kanban_cards c
            JOIN ardud_kanban_card_events e INDEXED BY ardud_kanban_card_events_card ON e.card_id = c.id
            WHERE c.board_id = ${boardId}
              AND (json_extract(e.json, '$.at') < ${window.since} OR json_extract(e.json, '$.at') >= ${window.until})
          ), markers AS (
            SELECT *, (to_stage IS NOT NULL AND to_stage IS NOT from_stage) AS is_stage,
              (kind IN ('wait_set', 'wait_cleared', 'wait_expired') OR
                (kind = 'edited' AND (body GLOB 'Waiting *' OR body GLOB 'Wait ended: *' OR body GLOB 'Wait expired: *'))) AS is_wait,
              (kind IN ('flagged', 'moved', 'review', 'wait_set') OR
                (to_stage IS NOT NULL AND to_stage IS NOT from_stage) OR
                (kind = 'edited' AND body GLOB 'Waiting *')) AS is_stall
            FROM history
          ), picked AS (
            SELECT MAX(id) AS id FROM markers WHERE at < ${window.since} AND is_wait GROUP BY card_id
            UNION SELECT MAX(id) AS id FROM markers WHERE at < ${window.since} AND is_stall GROUP BY card_id
            UNION SELECT MAX(id) AS id FROM markers WHERE at < ${window.since} AND is_stage GROUP BY card_id
            UNION SELECT MIN(id) AS id FROM markers WHERE at >= ${window.until} AND is_stage GROUP BY card_id
          )
          SELECT id, json FROM ardud_kanban_card_events WHERE id IN (SELECT id FROM picked) ORDER BY id

`;
  return rows.map((row) => ({ ...JSON.parse(row.json), id: Number(row.id) }) as KanbanCardEvent);
});

const withHistory = (read: Activity.RollupInput, history: ReadonlyArray<KanbanCardEvent>) => ({
  ...read,
  readinessBefore: history.filter((event) => event.at < read.window.since),
  prior: history.filter(
    (event) =>
      event.at < read.window.since && event.toStage !== null && event.fromStage !== event.toStage,
  ),
  after: history.filter((event) => event.at >= read.window.until),
});

const compact = (read: Activity.RollupInput) => {
  const byCard = Activity.groupEvents(read.events);
  return Activity.activeCards(read.cards, byCard, read.window).map((card) =>
    Activity.compactRow(card, byCard.get(card.id) ?? [], read.window),
  );
};

const load = Effect.fn("ActivityFixture.load")(function* (legacy = false, range = window) {
  const window = range;
  const store = yield* KanbanStore.KanbanStore;
  const cards = yield* store.cards(boardId);
  const events = yield* store.boardEvents(boardId, window.since, window.until);
  const threads = yield* store.threadLinks({ boardId, open: false });
  const history = yield* legacy ? legacyHistory(window) : store.activityHistory(boardId, window);
  return {
    window,
    cards,
    events,
    threads,
    board: { pause: null, setup: null, archivedAt: null },
    pools: [{ key: "codex/gpt-6.1-sol", model, slots: 1 }],
    slotHistory: {
      events: [
        {
          id: 1,
          boardId,
          poolKey: "codex/gpt-6.1-sol",
          threadId: "holder",
          cardId: null,
          kind: "take" as const,
          at: before,
          why: "start" as const,
        },
      ],
      recordedSince: before,
    },
    readinessBefore: history.filter((event) => event.at < window.since),
    prior: history.filter(
      (event) =>
        event.at < window.since && event.toStage !== null && event.fromStage !== event.toStage,
    ),
    after: history.filter((event) => event.at >= window.until),
  } satisfies Activity.RollupInput;
});

it.effect(
  "Crpko-sized activity load and rollup",
  () =>
    Effect.gen(function* () {
      yield* seed(4700, 10000);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM ardud_kanban_card_events`)[0]?.n,
        150400,
      );
      for (const marker of ["wait", "stall", "stage", "after"])
        yield* sql.unsafe(`DROP INDEX ardud_kanban_card_events_activity_${marker}`);
      const migrationStart = performance.now();
      yield* initializeKanbanSchema(sql);
      const migrationMs = performance.now() - migrationStart;
      // Fresh store caches for both paths; their SQL database and generated rows are identical.
      const legacyStart = performance.now();
      const legacy = yield* load(true).pipe(Effect.provide(KanbanStore.layer));
      const legacyLoaded = performance.now();
      const legacyResult = Activity.rollup(legacy);
      const legacyRolled = performance.now();
      const legacyRows = compact(legacy);
      const legacyRendered = performance.now();
      const started = performance.now();
      const read = yield* load().pipe(Effect.provide(KanbanStore.layer));
      const loaded = performance.now();
      const result = Activity.rollup(read);
      const rolled = performance.now();
      const rows = compact(read);
      const rendered = performance.now();
      assert.deepStrictEqual(result, legacyResult);
      assert.deepStrictEqual(rows, legacyRows);
      yield* Effect.logInfo(
        JSON.stringify({
          fixture: "Crpko",
          migrationMs: Math.round(migrationMs),
          cards: read.cards.length,
          totalEvents: 150400,
          windowEvents: read.events.length,
          threads: read.threads.length,
          boundaryRows: read.readinessBefore.length + read.after.length,
          loadMs: Math.round(loaded - started),
          rollupMs: Math.round(rolled - loaded),
          compactMs: Math.round(rendered - rolled),
          legacyLoadMs: Math.round(legacyLoaded - legacyStart),
          legacyRollupMs: Math.round(legacyRolled - legacyLoaded),
          legacyCompactMs: Math.round(legacyRendered - legacyRolled),
          legacyBoundaryRows: legacy.readinessBefore.length + legacy.after.length,
        }),
      );
      assert.lengthOf(read.cards, 4700);
      assert.lengthOf(read.events, 150);
      assert.lengthOf(read.threads, 10000);
      assert.isAbove(result.stages.hours.todo?.hours ?? 0, 0);
      assert.isTrue(
        (result.pools.queueWait["codex/gpt-6.1-sol"] ?? []).some((value) => (value ?? 0) > 0),
      );
      assert.isAtMost(read.readinessBefore.length + read.after.length, 300 * 4);
      assert.isBelow(rendered - started, 5000);
      // Settled cards whose only activity is a closed ask must survive board_get since.
      assert.isTrue(rows.some((row) => row.number === 17));
    }).pipe(Effect.provide(TestLayer)),
  120000,
);

it.effect("mixed history preserves every activity section and ask-only board_get rows", () =>
  Effect.gen(function* () {
    yield* seed(12, 30);
    const store = yield* KanbanStore.KanbanStore;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM ardud_kanban_card_events WHERE card_id IN ('large-3', 'large-4') AND json_extract(json, '$.at') >= ${window.since}`;
    const first = fixtureCard(1, 12);
    yield* store.putCard({ ...first, stage: "verified", settledAt: before });
    yield* store.putCard({
      ...fixtureCard(2, 12),
      stage: "verified",
      settledAt: "2026-11-16T02:00:00.000Z",
    });
    yield* store.putCard({
      ...fixtureCard(3, 12),
      stage: "todo",
      asks: [
        {
          id: "q1",
          text: "Ask only",
          by: { _tag: "owner" },
          blocking: true,
          seq: null,
          at: window.since,
          closedAt: null,
        },
      ],
    });
    for (const [kind, body, at] of [
      ["flagged", "Run failed: fixture", "2026-11-16T00:15:00.000Z"],
      ["wait_set", "Waiting for CI", "2026-11-16T00:20:00.000Z"],
      ["review", "clear", "2026-11-16T00:25:00.000Z"],
      ["moved", null, window.until],
    ] as const)
      yield* store.addCardEvent({
        cardId: first.id,
        kind,
        body,
        at,
        actor: { _tag: "owner" },
        head: null,
        fromStage: kind === "moved" ? "todo" : null,
        toStage: kind === "moved" ? "working" : null,
      });
    const read = yield* load();
    const legacy = withHistory(read, yield* legacyHistory());
    assert.deepStrictEqual(Activity.rollup(read), Activity.rollup(legacy));
    assert.deepStrictEqual(compact(read), compact(legacy));
    assert.isTrue(compact(read).some((row) => row.number === 3));
  }).pipe(Effect.provide(TestLayer)),
);
