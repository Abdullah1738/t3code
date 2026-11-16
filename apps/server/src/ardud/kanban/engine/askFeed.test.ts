/** The Needs-you feed stays cheap on a big board: it never decodes the cards that hold no matching ask. */
import { assert, it } from "@effect/vitest";
import { needsYouFromFeed, needsYouItems } from "@t3tools/client-runtime/ardud/kanban/needsYou";
import { kanbanSchedule, type KanbanCard } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import { readAskFeed } from "./askFeed.ts";

const AT = "2026-11-10T10:00:00.000Z";
const CARDS = 3_700;
const OPEN_EVERY = 100;

const cardJson = (number: number, boardId: string) => {
  const id = `card-${boardId}-${number}`;
  const open = number % OPEN_EVERY === 0;
  const closed = number % 3 === 0;
  return JSON.stringify({
    id,
    boardId,
    number,
    title: `Card ${number}`,
    description: "d".repeat(500),
    // A prompt that mentions the marker in prose must not count as an ask.
    prompt: `${"p".repeat(8_000)} "closedAt":null`,
    subtasks: [],
    subtaskSeq: 0,
    // The card after an asking card is unfinished and waits on it; other odd cards are done.
    stage: open
      ? "needs_owner"
      : number % 2 === 0 || number % OPEN_EVERY === 1
        ? "todo"
        : "verified",
    priority: 3,
    goalId: null,
    projects: [],
    model: { instanceId: "opencode", model: "opus/claude-opus-5-5" },
    models: [],
    projectId: null,
    links: [],
    blockedBy: number % OPEN_EVERY === 1 && number > 1 ? [`card-${boardId}-${number - 1}`] : [],
    stalled: null,
    question: null,
    asks: [
      ...(closed
        ? [
            {
              id: "q1",
              text: "Old?",
              blocking: false,
              by: { _tag: "owner" },
              at: "2026-11-01T10:00:00.000Z",
              seq: null,
              closedAt: number % 30 === 0 ? "2026-11-10T09:30:00.000Z" : "2026-11-02T10:00:00.000Z",
            },
          ]
        : []),
      ...(open
        ? [
            {
              id: closed ? "q2" : "q1",
              text: "Go?",
              blocking: true,
              by: { _tag: "owner" },
              at: AT,
              seq: null,
              closedAt: null,
              kind: "action",
              action: { summary: "Deploy" },
              batchKey: "deploy-go",
            },
          ]
        : []),
    ],
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
    settledAt: null,
    createdBy: { _tag: "owner" },
    createdAt: AT,
    updatedAt: AT,
    movedAt: AT,
  });
};

it.effect("reads the open asks of a 3,700-card board without decoding the board", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* KanbanStore.KanbanStore;
    for (const boardId of ["board-big", "board-other"]) {
      yield* sql`INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${boardId}, ${boardId.slice(6)}, ${`{"name":"${boardId}"}`})`;
    }
    yield* sql.withTransaction(
      Effect.forEach(
        Array.from({ length: CARDS }, (_, index) => index + 1),
        (number) => {
          const json = cardJson(number, "board-big");
          const stage = (JSON.parse(json) as { stage: string }).stage;
          return sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, active_thread_id, json)
            VALUES (${`card-board-big-${number}`}, 'board-big', ${number}, ${stage}, NULL, ${json})`;
        },
        { discard: true },
      ),
    );
    yield* sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, active_thread_id, json)
      VALUES ('card-board-other-100', 'board-other', 100, 'needs_owner', NULL, ${cardJson(100, "board-other")})`;

    const timed = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const started = performance.now();
        const value = yield* effect;
        return { value, ms: performance.now() - started };
      });

    const open = yield* timed(readAskFeed(sql, { boardId: "board-big" as never }, AT));
    assert.strictEqual(open.value.open.length, CARDS / OPEN_EVERY);
    assert.deepStrictEqual(open.value.closed, []);
    const first = open.value.open[0]!;
    assert.deepStrictEqual(
      [first.cardRef, first.boardName, first.kind, first.blocks, first.ask.batchKey, first.stage],
      ["big:100", "board-big", "action", 1, "deploy-go", "needs_owner"],
    );
    // Card 3700 has no card after it.
    assert.strictEqual(open.value.open.at(-1)!.blocks, 0);

    const all = yield* timed(readAskFeed(sql, {}, AT));
    assert.strictEqual(all.value.open.length, CARDS / OPEN_EVERY + 1);
    assert.strictEqual(all.value.open.at(-1)!.cardRef, "other:100");

    const history = yield* timed(
      readAskFeed(
        sql,
        { boardId: "board-big" as never, closedSince: "2026-11-10T09:00:00.000Z" },
        AT,
      ),
    );
    assert.strictEqual(history.value.open.length, CARDS / OPEN_EVERY);
    assert.strictEqual(history.value.closed.length, Math.floor(CARDS / 30));
    assert.isTrue(history.value.closed.every((item) => item.waitsOn === null));

    // Measured at about 35 ms open and 75 ms with the closed window (in-memory SQLite, M-series
    // Mac), the same with the whole-chain count as with the direct one it replaced (21-run
    // medians on a busy machine: 67 to 81 ms against 75 ms). The bounds are generous: they
    // catch a read that goes back to decoding the board.
    assert.isBelow(open.ms, 1_000);
    assert.isBelow(history.ms, 2_000);
  }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "what a card unblocks is the whole chain, and the feed, the selector and the scheduler agree",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* KanbanStore.KanbanStore;
      const boardId = "board-chain";
      yield* sql`INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${boardId}, 'chain', '{"name":"Chain"}')`;
      const id = (number: number) => `card-${boardId}-${number}`;
      const ask = {
        id: "q1",
        text: "Go?",
        blocking: true,
        by: { _tag: "owner" },
        at: AT,
        seq: null,
        closedAt: null,
      };
      // Card 7 of the generator has no asks and waits on nothing.
      const plain = JSON.parse(cardJson(7, boardId)) as Record<string, unknown>;
      const made = (number: number, patch: Record<string, unknown>) => ({
        ...plain,
        id: id(number),
        number,
        title: `Card ${number}`,
        prompt: "p",
        stage: "todo",
        ...patch,
      });
      const WAITERS = 400;
      const cards = [
        // A holds an ask; B waits on A; 400 cards wait on B.
        made(1, { stage: "needs_owner", asks: [ask] }),
        made(2, { blockedBy: [id(1)] }),
        ...Array.from({ length: WAITERS }, (_, index) => made(index + 3, { blockedBy: [id(2)] })),
        // Not counted: a backlog card nobody is going to do, and a finished one.
        made(403, { priority: 5, blockedBy: [id(1)] }),
        made(404, { stage: "verified", blockedBy: [id(1)] }),
        // Another asker that nothing waits on.
        made(405, { stage: "needs_owner", asks: [ask] }),
      ];
      yield* sql.withTransaction(
        Effect.forEach(
          cards,
          (card) =>
            sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, active_thread_id, json)
              VALUES (${card.id}, ${boardId}, ${card.number}, ${card.stage as string}, NULL, ${JSON.stringify(card)})`,
          { discard: true },
        ),
      );

      const started = performance.now();
      const feed = yield* readAskFeed(sql, { boardId: boardId as never }, AT);
      const ms = performance.now() - started;
      assert.deepStrictEqual(
        feed.open.map((item) => [item.cardRef, item.blocks]),
        [
          ["chain:1", WAITERS + 1],
          ["chain:405", 0],
        ],
      );

      const typed = cards as unknown as ReadonlyArray<KanbanCard>;
      const now = Date.parse(AT);
      const selector = needsYouItems(
        { cards: new Map(typed.map((card) => [card.id, card])) } as never,
        now,
      );
      const fromFeed = needsYouFromFeed(feed.open, now);
      const schedule = kanbanSchedule(typed, { nowMs: now });
      for (const list of [selector, fromFeed]) {
        assert.deepStrictEqual(
          list.items.map((item) => [item.cardNumber, item.unblocks]),
          [
            [1, WAITERS + 1],
            [405, 0],
          ],
        );
      }
      assert.strictEqual(schedule.get(id(1))?.holds, WAITERS + 1);
      assert.strictEqual(schedule.get(id(405))?.holds, 0);
      assert.isBelow(ms, 1_000);
    }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("pages indexed ask candidates across gaps without reading the empty trailing cards", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* KanbanStore.KanbanStore;
    for (const boardId of ["board-a", "board-b"]) {
      yield* sql`INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${boardId}, ${boardId.slice(6)}, ${`{"name":"${boardId}"}`})`;
      yield* sql.withTransaction(
        Effect.forEach(
          Array.from({ length: 1_500 }, (_, i) => (i + 1) * 2),
          (number) => {
            const stored = JSON.parse(cardJson(number, boardId));
            if (number > 2_800) stored.asks = [];
            else if (!stored.asks.some((ask: { closedAt: string | null }) => ask.closedAt === null))
              stored.asks.push({
                id: "q3",
                text: "Go?",
                blocking: false,
                by: { _tag: "owner" },
                at: AT,
                seq: null,
                closedAt: null,
              });
            const json = JSON.stringify(stored);
            return sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, json) VALUES (${`card-${boardId}-${number}`}, ${boardId}, ${number}, 'todo', ${json})`;
          },
          { discard: true },
        ),
      );
    }
    const batches: Array<number> = [];
    const observe: Statement.Transformer = (statement) => {
      const [query, params] = statement.compile();
      if (!query.includes("'boardId', c.board_id")) return Effect.succeed(statement);
      return sql.unsafe<{ count: number }>(`SELECT COUNT(*) AS count FROM (${query})`, params).pipe(
        Effect.provideService(Statement.CurrentTransformer, undefined),
        Effect.tap((rows) => Effect.sync(() => batches.push(rows[0]!.count))),
        Effect.as(statement),
        Effect.orDie,
      );
    };
    const all = yield* readAskFeed(sql, {}, AT).pipe(
      Effect.provideService(Statement.CurrentTransformer, observe),
    );
    assert.isAtMost(Math.max(...batches), 64);
    assert.strictEqual(
      batches.reduce((a, b) => a + b, 0),
      2_800,
    );
    assert.deepStrictEqual(
      all.open.map((item) => item.cardRef),
      ["a", "b"].flatMap((slug) =>
        Array.from({ length: 1_400 }, (_, i) => `${slug}:${(i + 1) * 2}`),
      ),
    );
    const one = yield* readAskFeed(sql, { boardId: "board-b" as never }, AT);
    assert.deepStrictEqual(
      one.open,
      all.open.filter((item) => item.boardId === "board-b"),
    );
    const history = yield* readAskFeed(sql, { closedSince: "2026-11-10T09:00:00.000Z" }, AT);
    assert.strictEqual(history.closed.length, 2 * Math.floor(2_800 / 30));
    assert.deepStrictEqual(history.open, all.open);
    yield* sql`UPDATE ardud_kanban_cards SET json = json_set(json, '$.asks', json('[]'))`;
    assert.deepStrictEqual((yield* readAskFeed(sql, {}, AT)).open, []);
  }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("uses partial indexes for three asking cards among 5,100 cards, including history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* KanbanStore.KanbanStore;
    for (const boardId of ["board-a", "board-b"]) {
      yield* sql`INSERT INTO ardud_kanban_boards (id, slug, json)
        VALUES (${boardId}, ${boardId.slice(6)}, ${JSON.stringify({ name: boardId })})`;
    }
    const asking = new Set([17, 2_600, 5_099]);
    const cards = Array.from({ length: 5_100 }, (_, i) => {
      const number = i + 1;
      const boardId = number > 2_550 ? "board-b" : "board-a";
      const card = JSON.parse(cardJson(number, boardId));
      card.asks = asking.has(number) ? JSON.parse(cardJson(100, boardId)).asks : [];
      card.stage = asking.has(number) ? "needs_owner" : "verified";
      return card;
    });
    // Mixed open/closed, closed-only, old history, and the exact history boundary.
    cards[16].asks.push(
      ...JSON.parse(cardJson(30, "board-a")).asks,
      ...JSON.parse(cardJson(3, "board-a")).asks.map((ask: object) => ({ ...ask, id: "old" })),
    );
    cards[18].asks = JSON.parse(cardJson(60, "board-a")).asks;
    cards[19].asks = JSON.parse(cardJson(90, "board-a")).asks;
    cards[19].asks[0].closedAt = "2026-11-10T09:00:00.000Z";
    yield* sql.withTransaction(
      Effect.forEach(
        cards,
        (card) => sql`INSERT INTO ardud_kanban_cards
        (id, board_id, number, stage, json)
        VALUES (${card.id}, ${card.boardId}, ${card.number}, ${card.stage}, ${JSON.stringify(card)})`,
        { discard: true },
      ),
    );

    const pages: Array<{ rows: number; plan: string }> = [];
    const observe: Statement.Transformer = (statement) => {
      const [query, params] = statement.compile();
      if (!query.includes("'boardId', c.board_id")) return Effect.succeed(statement);
      return Effect.gen(function* () {
        const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params);
        const rows = yield* sql.unsafe<{ count: number }>(
          `SELECT COUNT(*) AS count FROM (${query})`,
          params,
        );
        pages.push({ rows: rows[0]!.count, plan: plan.map((row) => row.detail).join("\n") });
        return statement;
      }).pipe(Effect.provideService(Statement.CurrentTransformer, undefined), Effect.orDie);
    };
    for (const boardId of [undefined, "board-a", "board-b"]) {
      for (const closedSince of [undefined, "2026-11-10T09:00:00.000Z", AT]) {
        pages.length = 0;
        const feed = yield* readAskFeed(sql, { boardId: boardId as never, closedSince }, AT).pipe(
          Effect.provideService(Statement.CurrentTransformer, observe),
        );
        assert.strictEqual(pages.length, 1);
        assert.isAtMost(pages[0]!.rows, closedSince === undefined ? 3 : 5);
        assert.match(
          pages[0]!.plan,
          /USING (?:COVERING )?INDEX ardud_kanban_cards_open_asks/,
          pages[0]!.plan,
        );
        assert.notMatch(pages[0]!.plan, /SCAN (?:c|ardud_kanban_cards)(?:$|\s)/m);
        if (closedSince !== undefined)
          assert.match(
            pages[0]!.plan,
            /USING (?:COVERING )?INDEX ardud_kanban_cards_closed_asks/,
            pages[0]!.plan,
          );
        const scoped = cards.filter((card) => boardId === undefined || card.boardId === boardId);
        // Full-card scan oracle: the old query's per-ask predicate, card order and history cap.
        const expected = scoped.flatMap((card) =>
          card.asks.flatMap((ask: { id: string; closedAt: string | null }) =>
            (
              ask.closedAt === null
                ? card.settledAt === null
                : closedSince !== undefined && ask.closedAt >= closedSince
            )
              ? [{ cardId: card.id, ask }]
              : [],
          ),
        );
        assert.deepStrictEqual(
          feed.open.map((item) => ({ cardId: item.cardId, ask: item.ask })),
          expected.filter((item) => item.ask.closedAt === null),
        );
        assert.deepStrictEqual(
          feed.closed.map((item) => ({ cardId: item.cardId, ask: item.ask })),
          expected
            .filter((item) => item.ask.closedAt !== null)
            .sort((a, b) => (b.ask.closedAt ?? "").localeCompare(a.ask.closedAt ?? ""))
            .slice(0, 200),
        );
      }
    }

    const started = performance.now();
    const measured = yield* readAskFeed(sql, {}, AT);
    const ms = performance.now() - started;
    assert.strictEqual(measured.open.length, 3);
    yield* Effect.logInfo(
      JSON.stringify({
        fixtureCards: cards.length,
        openAsks: measured.open.length,
        legacyCandidatePages: Math.ceil(cards.length / 64),
        indexedCandidatePages: 1,
        indexedCandidateRows: 3,
        syntheticRequestMs: ms,
      }),
    );

    // Index membership follows JSON writes (including SQLite json_set) in both directions.
    yield* sql`UPDATE ardud_kanban_cards SET json = json_set(json, '$.asks', json('[]'))`;
    const empty = yield* readAskFeed(sql, { closedSince: "2026-11-01T00:00:00.000Z" }, AT);
    assert.deepStrictEqual([empty.open, empty.closed], [[], []]);
    const card = cards[1]!;
    const asks = JSON.parse(cardJson(100, card.boardId)).asks;
    yield* sql`UPDATE ardud_kanban_cards SET json = json_set(json, '$.asks', json(${JSON.stringify(asks)}))
      WHERE id = ${card.id}`;
    assert.deepStrictEqual(
      (yield* readAskFeed(sql, {}, AT)).open.map((item) => item.cardId),
      [card.id],
    );
    yield* sql`DELETE FROM ardud_kanban_cards WHERE id = ${card.id}`;
    assert.deepStrictEqual((yield* readAskFeed(sql, {}, AT)).open, []);
  }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

const messageJson = (discussionId: string, seq: number, askId?: string) =>
  JSON.stringify({
    discussionId,
    seq,
    author: { _tag: "owner" },
    authorName: "Owner",
    blocks: [{ _tag: "md", text: `Message ${seq} ${"x".repeat(2_048)}` }],
    answers: [],
    createdAt: AT,
    ...(askId === undefined ? {} : { askId }),
  });

it.effect(
  "point-reads legacy pairs and bounds indexed ask messages with identical open/history output",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* KanbanStore.KanbanStore;
      yield* sql`INSERT INTO ardud_kanban_boards (id, slug, json) VALUES ('board-a', 'a', '{"name":"A"}')`;
      const asks = [
        { id: "q1", seq: 90, firstSeq: 1, closedAt: null },
        { id: "q2", seq: 2, firstSeq: 3, closedAt: null },
        { id: "q3", seq: null, closedAt: "2026-11-10T09:00:00.000Z" },
        { id: "q4", seq: 4, closedAt: "2026-11-01T09:00:00.000Z" },
        { id: "q5", seq: null, closedAt: null },
      ].map((ask) => ({
        text: "Go?",
        blocking: false,
        by: { _tag: "owner" },
        at: AT,
        ...ask,
      }));
      const card = { ...JSON.parse(cardJson(100, "board-a")), discussionId: "discussion-a", asks };
      yield* sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, json)
      VALUES (${card.id}, 'board-a', 100, 'needs_owner', ${JSON.stringify(card)})`;
      for (let seq = 1; seq <= 150; seq++) {
        // Edited legacy firstSeq/seq, another ask's message at a requested seq,
        // an unrelated historical ask, and a long tagged discussion interleave.
        const askId = seq <= 3 ? undefined : seq === 4 ? "q4" : seq % 7 === 0 ? "q3" : "q1";
        yield* sql`INSERT INTO ardud_kanban_messages VALUES ('discussion-a', ${seq}, ${messageJson("discussion-a", seq, askId)})`;
      }
      // Legacy asking messages can also be later than all tagged messages.
      yield* sql`UPDATE ardud_kanban_cards SET json = json_set(json, '$.asks[1].seq', 151)`;
      yield* sql`INSERT INTO ardud_kanban_messages VALUES ('discussion-a', 151, ${messageJson("discussion-a", 151)})`;
      const legacyQuery: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        if (!query.includes("ardud_kanban_messages_ask_marked")) return Effect.succeed(statement);
        const pairs = JSON.stringify(
          asks.flatMap((ask) =>
            [ask.id === "q2" ? 151 : ask.seq, ask.firstSeq].flatMap((seq) =>
              seq == null ? [] : [["discussion-a", seq]],
            ),
          ),
        );
        return Effect.succeed(sql`SELECT m.json FROM ardud_kanban_messages m
        WHERE m.discussion_id = 'discussion-a'
          AND (instr(m.json, ${'"askId":"'}) > 0 OR EXISTS (
            SELECT 1 FROM json_each(${pairs}) wanted
            WHERE json_extract(wanted.value, '$[0]') = m.discussion_id
              AND json_extract(wanted.value, '$[1]') = m.seq))
        ORDER BY m.discussion_id, m.seq`);
      };
      for (const closedSince of [
        undefined,
        "2026-11-10T09:00:00.000Z",
        "2000-01-01T00:00:00.000Z",
      ]) {
        const input = { closedSince };
        const old = yield* readAskFeed(sql, input, AT).pipe(
          Effect.provideService(Statement.CurrentTransformer, legacyQuery),
        );
        const plans: Array<string> = [];
        const observe: Statement.Transformer = (statement) => {
          const [query, params] = statement.compile();
          if (!query.includes("ardud_kanban_messages_ask_marked")) return Effect.succeed(statement);
          return sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params).pipe(
            Effect.provideService(Statement.CurrentTransformer, undefined),
            Effect.tap((rows) =>
              Effect.sync(() => plans.push(rows.map((row) => row.detail).join("\n"))),
            ),
            Effect.as(statement),
            Effect.orDie,
          );
        };
        const spans: Array<Tracer.Span> = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const current = yield* readAskFeed(sql, input, AT).pipe(
          Effect.provideService(Statement.CurrentTransformer, observe),
          Effect.withTracer(tracer),
        );
        const messageSpan = spans.find((span) => span.name === "KanbanAskFeed.messages")!;
        assert.strictEqual(messageSpan.attributes.get("discussions"), 1);
        assert.strictEqual(
          messageSpan.attributes.get("askedPairs"),
          closedSince === "2000-01-01T00:00:00.000Z" ? 5 : 4,
        );
        assert.strictEqual(messageSpan.attributes.get("history"), closedSince !== undefined);
        assert.isAbove(Number(messageSpan.attributes.get("rowsReturned")), 0);
        assert.deepStrictEqual(current, old);
        assert.strictEqual(plans.length, 1);
        assert.notMatch(plans[0]!, /SCAN (?:m|ardud_kanban_messages)(?:$|\s)/m);
        assert.match(plans[0]!, /SEARCH m USING INDEX sqlite_autoindex_ardud_kanban_messages_1/);
        assert.match(plans[0]!, /USING (?:COVERING )?INDEX ardud_kanban_messages_ask_marked/);
        assert.strictEqual(current.open[0]!.messages.length, 51);
        assert.strictEqual(current.open[0]!.messages[0]!.seq, 1);
        assert.deepStrictEqual(
          current.open[1]!.messages.map((m) => m.seq),
          [3, 151],
        );
        assert.deepStrictEqual(current.open[2]!.messages, []);
      }
      // An index update must move the message between asks without stale membership.
      yield* sql`UPDATE ardud_kanban_messages SET json = json_set(json, '$.askId', 'q5')
      WHERE discussion_id = 'discussion-a' AND seq = 150`;
      assert.deepStrictEqual(
        (yield* readAskFeed(sql, {}, AT)).open[2]!.messages.map((m) => m.seq),
        [150],
      );
    }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "bounds production-sized message reads and selects only the newest 200 closed asks before SQL",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* KanbanStore.KanbanStore;
      yield* sql`INSERT INTO ardud_kanban_boards (id, slug, json) VALUES ('board-a', 'a', '{"name":"A"}')`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (let number = 1; number <= 310; number++) {
            const discussionId = `discussion-${number}`;
            const ask = {
              id: "q1",
              text: "Go?",
              blocking: false,
              by: { _tag: "owner" },
              at: AT,
              seq: 1,
              firstSeq: 1,
              closedAt: number <= 100 ? null : "2026-11-10T09:00:00.000Z",
            };
            const card = {
              ...JSON.parse(cardJson(number, "board-a")),
              settledAt: null,
              discussionId,
              asks: [ask],
            };
            yield* sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, json)
          VALUES (${card.id}, 'board-a', ${number}, 'todo', ${JSON.stringify(card)})`;
            const count = 500 + ((number - 1) % 6) * 500;
            const body = messageJson(discussionId, 1);
            // All messages in every tenth discussion carry askId: SQL must bound dense threads too.
            yield* sql`WITH RECURSIVE seqs(seq) AS (SELECT 1 UNION ALL SELECT seq + 1 FROM seqs WHERE seq < ${count})
          INSERT INTO ardud_kanban_messages
          SELECT ${discussionId}, seq, json_set(${body}, '$.seq', seq,
            '$.blocks[0].text', printf('%.*c', ${2_048 + (number % 4) * 1_536}, 'x'))
          FROM seqs`;
            yield* sql`UPDATE ardud_kanban_messages SET json = json_set(json, '$.askId', 'q1')
          WHERE discussion_id = ${discussionId}
            AND (seq = 1 OR seq = ${count} OR ${number % 10} = 0)`;
          }
        }),
      );
      const total = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM ardud_kanban_messages`;
      assert.isAtLeast(total[0]!.count, 525_000);
      for (const closedSince of [
        undefined,
        "2026-11-10T09:00:00.000Z",
        "1900-01-01T00:00:00.000Z",
      ]) {
        let returned = 0;
        let queriedDiscussions = 0;
        const observe: Statement.Transformer = (statement) => {
          const [query, params] = statement.compile();
          if (!query.includes("ardud_kanban_messages_ask_marked")) return Effect.succeed(statement);
          const pairs = JSON.parse(String(params[1])) as Array<[string, string]>;
          queriedDiscussions = new Set(pairs.map(([discussion]) => discussion)).size;
          return Effect.gen(function* () {
            const plan = yield* sql.unsafe<{ detail: string }>(
              `EXPLAIN QUERY PLAN ${query}`,
              params,
            );
            assert.notMatch(
              plan.map((r) => r.detail).join("\n"),
              /SCAN (?:m|ardud_kanban_messages)(?:$|\s)/m,
            );
            const rows = yield* sql.unsafe<{ count: number }>(
              `SELECT COUNT(*) AS count FROM (${query})`,
              params,
            );
            returned = rows[0]!.count;
            return statement;
          }).pipe(Effect.provideService(Statement.CurrentTransformer, undefined), Effect.orDie);
        };
        const start = performance.now();
        const feed = yield* readAskFeed(sql, { closedSince }, AT).pipe(
          Effect.provideService(Statement.CurrentTransformer, observe),
        );
        const discussions = closedSince === undefined ? 100 : 300;
        assert.strictEqual(queriedDiscussions, discussions);
        assert.strictEqual(returned, (discussions / 10) * 51 + discussions * 0.9 * 2);
        assert.strictEqual(feed.open.length, 100);
        assert.strictEqual(feed.closed.length, closedSince === undefined ? 0 : 200);
        assert.deepStrictEqual(
          feed.closed.map((item) => item.cardNumber),
          closedSince === undefined ? [] : Array.from({ length: 200 }, (_, i) => i + 101),
        );
        yield* Effect.logInfo(
          JSON.stringify({
            fixtureMessages: total[0]!.count,
            history: closedSince !== undefined,
            discussions,
            rowsReturned: returned,
            requestMs: performance.now() - start,
          }),
        );
      }
    }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
  120_000,
);

it.effect(
  "keeps the global history cutoff across boards, timestamps and multiple asks per card",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* KanbanStore.KanbanStore;
      const stored: Array<{
        boardId: string;
        number: number;
        asks: Array<{ id: string; closedAt: string | null }>;
      }> = [];
      for (const boardId of ["board-a", "board-b", "board-c"]) {
        yield* sql`INSERT INTO ardud_kanban_boards (id, slug, json) VALUES (${boardId}, ${boardId}, '{}')`;
        for (let number = 1; number <= 45; number++) {
          const asks = [
            { id: "q1", closedAt: `2026-11-10T09:${String(number % 30).padStart(2, "0")}:00.000Z` },
            {
              id: "q2",
              closedAt: `2026-11-10T09:${String(29 - (number % 30)).padStart(2, "0")}:00.000Z`,
            },
            ...(number % 11 === 0 ? [{ id: "q3", closedAt: null }] : []),
          ].map((ask) => ({
            ...ask,
            text: "Go?",
            blocking: false,
            by: { _tag: "owner" },
            at: AT,
            seq: null,
          }));
          stored.push({ boardId, number, asks });
          const card = {
            ...JSON.parse(cardJson(number, boardId)),
            settledAt: null,
            discussionId: `discussion-${boardId}-${number}`,
            asks,
          };
          yield* sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, json)
          VALUES (${card.id}, ${boardId}, ${number}, 'todo', ${JSON.stringify(card)})`;
        }
      }
      for (const boardId of [undefined, "board-b"]) {
        for (const closedSince of [
          undefined,
          "2026-11-10T09:10:00.000Z",
          "1900-01-01T00:00:00.000Z",
        ]) {
          // Independent full-card oracle: filter asks, then sort and cap the global result.
          const eligible = stored
            .filter((card) => boardId === undefined || card.boardId === boardId)
            .flatMap((card) =>
              card.asks.map((ask) => ({ boardId: card.boardId, number: card.number, ask })),
            );
          const expectedOpen = eligible.filter(({ ask }) => ask.closedAt === null);
          const expectedClosed = eligible
            .filter(
              ({ ask }) =>
                ask.closedAt !== null && closedSince !== undefined && ask.closedAt >= closedSince,
            )
            .sort((a, b) => (b.ask.closedAt ?? "").localeCompare(a.ask.closedAt ?? ""))
            .slice(0, 200);
          let selected: Array<[string, string]> = [];
          const observe: Statement.Transformer = (statement) => {
            const [query, params] = statement.compile();
            if (query.includes("ardud_kanban_messages_ask_marked"))
              selected = JSON.parse(String(params[1]));
            return Effect.succeed(statement);
          };
          const feed = yield* readAskFeed(sql, { boardId: boardId as never, closedSince }, AT).pipe(
            Effect.provideService(Statement.CurrentTransformer, observe),
          );
          assert.deepStrictEqual(
            feed.open.map((item) => ({
              boardId: item.boardId,
              number: item.cardNumber,
              ask: item.ask,
            })),
            expectedOpen,
          );
          assert.deepStrictEqual(
            feed.closed.map((item) => ({
              boardId: item.boardId,
              number: item.cardNumber,
              ask: item.ask,
            })),
            expectedClosed,
          );
          assert.deepStrictEqual(
            selected.map(([discussion, ask]) => `${discussion}:${ask}`).sort(),
            [...expectedOpen, ...expectedClosed]
              .map((item) => `discussion-${item.boardId}-${item.number}:${item.ask.id}`)
              .sort(),
          );
        }
      }
    }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
