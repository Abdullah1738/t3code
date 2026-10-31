import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  KanbanScriptId,
  ProviderInstanceId,
  ThreadId,
  type KanbanBoard,
  type KanbanCard,
} from "@t3tools/contracts";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import { summaries, tallyBoards } from "../engine/summaries.ts";
import * as KanbanStore from "./KanbanStore.ts";

const TestLayer = KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const model = { instanceId: ProviderInstanceId.make("opencode"), model: "opus/claude-opus-5-5" };
const at = "2026-10-25T13:00:00.000Z";
const boardId = KanbanBoardId.make("board-1");

const board: KanbanBoard = {
  id: boardId,
  slug: "robob",
  name: "Robob",
  icon: null,
  iconImage: null,
  defaultProjectId: null,
  managerModel: model,
  evaluatorModel: model,
  defaultCardModel: model,
  evaluatorSlots: null,
  reviewChains: [],
  defaultReviewChain: null,
  instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
  createdAt: at,
  setup: null,
  archivedAt: null,
};

const card = (number: number, stage: KanbanCard["stage"]): KanbanCard => ({
  id: KanbanCardId.make(`card-${number}`),
  boardId,
  number,
  title: `Card ${number}`,
  description: "",
  prompt: "do it",
  stage,
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
  asks: [],
  reviewChain: null,
  reviewStep: 0,
  reviewRound: 0,
  activeThreadId: stage === "working" ? ThreadId.make(`thread-${number}`) : null,
  activeRole: stage === "working" ? "work" : null,
  activePool: null,
  workThreadId: null,
  reviewThreadId: null,
  discussionId: null,
  wakeNote: null,
  nudgedAt: null,
  settledAt: null,
  createdBy: { _tag: "owner" },
  createdAt: at,
  updatedAt: at,
  movedAt: at,
});

it.layer(TestLayer)("kanban store", (it) => {
  it.effect("round-trips boards, cards, events, messages and script runs", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      yield* store.putBoard(board);
      yield* store.putBoard(board);
      assert.deepStrictEqual(yield* store.boards, [board]);

      assert.equal(yield* store.nextCardNumber(boardId), 1);
      yield* store.putCard(card(1, "todo"));
      yield* store.putCard(card(2, "working"));
      assert.equal(yield* store.nextCardNumber(boardId), 3);
      assert.equal((yield* store.cards(boardId)).length, 2);
      assert.deepStrictEqual(
        (yield* store.cardsByThread("thread-2")).map((entry) => entry.number),
        [2],
      );
      assert.equal((yield* store.cardsInStage("todo")).length, 1);

      yield* store.putCard({ ...card(2, "needs_review"), activeThreadId: null });
      assert.equal((yield* store.cardsByThread("thread-2")).length, 0);

      const event = yield* store.addCardEvent({
        cardId: KanbanCardId.make("card-1"),
        at,
        actor: { _tag: "owner" },
        kind: "comment",
        fromStage: null,
        toStage: null,
        body: "hello",
        head: null,
      });
      assert.isAbove(event.id, 0);
      const events = yield* store.cardEvents(KanbanCardId.make("card-1"));
      assert.deepStrictEqual(events, [event]);

      const discussionId = KanbanDiscussionId.make("disc-1");
      for (const seq of [1, 2, 3]) {
        yield* store.putMessage({
          discussionId,
          seq,
          author: { _tag: "owner" },
          authorName: "Abdullah",
          blocks: [{ _tag: "md", text: `m${seq}` }],
          answers: [],
          createdAt: at,
        });
      }
      const tail = yield* store.messages(discussionId, { limit: 2 });
      assert.deepStrictEqual(
        tail.map((message) => message.seq),
        [2, 3],
      );
      const after = yield* store.messages(discussionId, { afterSeq: 1 });
      assert.equal(after.length, 2);

      const runRecord = yield* store.addScriptRun({
        scriptId: KanbanScriptId.make("script-1"),
        startedAt: at,
        endedAt: null,
        exitCode: null,
        output: "",
        trigger: "manual",
      });
      yield* store.putScriptRun({ ...runRecord, endedAt: at, exitCode: 0, output: "ok" });
      const runs = yield* store.scriptRuns(KanbanScriptId.make("script-1"), 5);
      assert.deepStrictEqual(runs, [{ ...runRecord, endedAt: at, exitCode: 0, output: "ok" }]);
    }),
  );
});

it.layer(TestLayer)("kanban store: summary cards", (it) => {
  it.effect("summary cards match full-card counts without packet fields", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const summaryBoardId = KanbanBoardId.make("board-summary");
      const openAsk = {
        id: "q1",
        text: "Ship it?",
        blocking: false,
        by: { _tag: "owner" as const },
        at,
        seq: null,
        closedAt: null,
      };
      const closedAsk = { ...openAsk, id: "q2", closedAt: at };
      const packet = (
        number: number,
        stage: KanbanCard["stage"],
        patch: Partial<KanbanCard> = {},
      ): KanbanCard => ({
        ...card(number, stage),
        id: KanbanCardId.make(`sum-card-${number}`),
        boardId: summaryBoardId,
        prompt: "p".repeat(100_000),
        description: "a description",
        subtasks: [
          {
            id: "s1",
            step: 1,
            text: "work",
            owner: "work",
            state: "done",
            note: "a subtask note",
            doneBy: null,
            doneAt: null,
          },
        ],
        ...patch,
      });
      const cards = [
        packet(1, "todo"),
        packet(2, "working"),
        packet(3, "needs_owner", { activeThreadId: null, activeRole: null }),
        packet(4, "working", { asks: [openAsk] }),
        packet(5, "working", { asks: [closedAsk] }),
        packet(6, "needs_owner", { settledAt: at }),
      ];
      for (const entry of cards) yield* store.putCard(entry);

      const full = yield* store.cards(summaryBoardId);
      const summary = yield* store.summaryCards(summaryBoardId);
      assert.deepStrictEqual(
        summary,
        full.map(({ id, stage, settledAt, activeThreadId, asks }) => ({
          id,
          stage,
          settledAt,
          activeThreadId,
          asks: asks.map(({ closedAt }) => ({ closedAt })),
        })),
      );
      assert.isBelow(JSON.stringify(summary).length, 2_000);
      assert.isAbove(JSON.stringify(full).length, 600_000);

      const fromFull = summaries(
        tallyBoards([{ board, cards: full, discussions: [], threadIds: [] }]),
      );
      const fromSummary = summaries(
        tallyBoards([{ board, cards: summary, discussions: [], threadIds: [] }]),
      );
      assert.deepStrictEqual(fromSummary, fromFull);
      assert.equal(fromSummary[0]?.needsOwner, 2);
      assert.equal(fromSummary[0]?.running, 2);

      yield* sql`UPDATE ardud_kanban_cards SET json = json_remove(json, '$.asks') WHERE id = ${"sum-card-1"}`;
      const legacy = (yield* store.summaryCards(summaryBoardId)).find(
        (entry) => entry.id === "sum-card-1",
      );
      assert.deepStrictEqual(legacy?.asks, []);
    }),
  );
});

it.layer(TestLayer)("kanban store: board and pools in one write", (it) => {
  it.effect("rolls the board back when a pool in the same write fails", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const fresh = { ...board, id: KanbanBoardId.make("board-rollback"), slug: "rollback" };
      const good = { key: "opencode/opus/a", model, slots: 0 };
      // A negative slot count fails NonNegativeInt on encode, after the board row is written.
      const bad = { key: "opencode/opus/b", model, slots: -1 };
      const exit = yield* Effect.exit(store.putBoardWithPools(fresh, [good, bad]));
      assert.strictEqual(exit._tag, "Failure");
      assert.notInclude((yield* store.boards).map((entry) => entry.id), fresh.id);
      assert.deepStrictEqual(yield* store.pools(fresh.id), []);
    }),
  );

  it.effect("writes the board and its pools together when all of them succeed", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const fresh = { ...board, id: KanbanBoardId.make("board-together"), slug: "together" };
      const pool = { key: "opencode/opus/c", model, slots: 0 };
      yield* store.putBoardWithPools(fresh, [pool]);
      assert.include((yield* store.boards).map((entry) => entry.id), fresh.id);
      assert.deepStrictEqual(yield* store.pools(fresh.id), [pool]);
    }),
  );

  it.effect("rekeys a pool in place: new key and record, same position", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const fresh = { ...board, id: KanbanBoardId.make("board-rekey"), slug: "rekey" };
      const a = { key: "opencode/opus/a", model, slots: 1 };
      const b = { key: "opencode/opus/b", model, slots: 2 };
      yield* store.putBoardWithPools(fresh, [a, b]);
      yield* store.rekeyBoard(
        fresh.id,
        [{ from: a.key, pool: { ...a, key: "opencode/opus/a#max" } }],
        [],
      );
      assert.deepStrictEqual(yield* store.pools(fresh.id), [
        { ...a, key: "opencode/opus/a#max" },
        b,
      ]);
      // An unknown key changes nothing.
      yield* store.rekeyBoard(
        fresh.id,
        [{ from: "opencode/opus/none", pool: { ...b, key: "x" } }],
        [],
      );
      assert.deepStrictEqual(
        (yield* store.pools(fresh.id)).map((pool) => pool.key),
        ["opencode/opus/a#max", "opencode/opus/b"],
      );
    }),
  );
});

it.layer(TestLayer)("kanban store: evaluator admissions", (it) => {
  it.effect("drops an admission only when its turn matches", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      yield* store.putBoard(board);
      yield* store.putAdmission({ threadId: "thread-a", boardId, turn: "run-a", at: 1 });
      yield* store.putAdmission({ threadId: "thread-b", boardId, turn: "run-b", at: 2 });
      yield* store.dropAdmission("thread-a", "run-b");
      assert.deepStrictEqual(
        (yield* store.admissions()).map((row) => [row.threadId, row.turn]),
        [
          ["thread-a", "run-a"],
          ["thread-b", "run-b"],
        ],
      );
      yield* store.dropAdmission("thread-a", "run-a");
      assert.deepStrictEqual(
        (yield* store.admissions()).map((row) => [row.threadId, row.turn]),
        [["thread-b", "run-b"]],
      );
    }),
  );
});

it.layer(TestLayer)("kanban store: evaluator queue", (it) => {
  it.effect("reads queued evaluator sends oldest first and drops one thread", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      yield* store.putBoard(board);
      const entry = (text: string) => ({ text, model: null, queuedAt: at });
      yield* store.enqueueEvaluator(boardId, "thread-a", entry("one"));
      yield* store.enqueueEvaluator(boardId, "thread-b", entry("two"));
      yield* store.enqueueEvaluator(boardId, "thread-a", entry("three"));
      assert.deepStrictEqual(
        (yield* store.evaluatorQueue(boardId)).map((item) => [item.threadId, item.entry.text]),
        [
          ["thread-a", "one"],
          ["thread-b", "two"],
          ["thread-a", "three"],
        ],
      );
      yield* store.dropEvaluatorQueue("thread-a");
      assert.deepStrictEqual(
        (yield* store.evaluatorQueue(boardId)).map((item) => [item.threadId, item.entry.text]),
        [["thread-b", "two"]],
      );
    }),
  );
});
