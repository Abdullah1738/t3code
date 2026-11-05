import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type * as Tracer from "effect/Tracer";

import {
  KanbanAutomationId,
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  KanbanGoalId,
  KanbanScriptId,
  ProviderInstanceId,
  ThreadId,
  type KanbanAutomation,
  type KanbanBoard,
  type KanbanCard,
  type KanbanDiscussion,
  type KanbanGoal,
  type KanbanGroup,
  type KanbanMessage,
  type KanbanPool,
  type KanbanScript,
  type KanbanThreadLink,
  type KanbanWikiPage,
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
  reviewChains: [],
  defaultReviewChain: null,
  instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
  createdAt: at,
  setup: null,
  pause: null,
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

const withFileStore = <A, E>(
  effect: Effect.Effect<A, E, KanbanStore.KanbanStore | SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kanban-reader-" });
    const layer = KanbanStore.layer.pipe(
      Layer.provideMerge(Sqlite.layerFromPath(path.join(dir, "kanban.sqlite"))),
    );
    return yield* effect.pipe(Effect.timeout("15 seconds"), Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live(
  "reads every routed store query while a file database writer is held",
  () =>
    withFileStore(
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const sql = yield* SqlClient.SqlClient;
        const todo = card(1, "todo");
        const working = card(2, "working");
        const otherBoard = { ...board, id: KanbanBoardId.make("board-2"), slug: "other" };
        const discussionId = KanbanDiscussionId.make("discussion-1");
        const noOwnerDiscussionId = KanbanDiscussionId.make("discussion-no-owner");
        const scriptId = KanbanScriptId.make("script-1");
        const goal = {
          id: KanbanGoalId.make("goal-1"),
          boardId,
          name: "Reader goal",
          status: "active",
          now: { text: "In progress", at },
          story: [{ text: "Started", at }],
          createdAt: at,
        } satisfies KanbanGoal;
        const pool = { key: "opencode/opus/a", model, slots: 2 } satisfies KanbanPool;
        const group = {
          id: "group-1",
          name: "Reader group",
          summary: "Related work",
          cardIds: [todo.id, working.id],
          updatedAt: at,
        } satisfies KanbanGroup;
        const discussion = {
          id: discussionId,
          boardId,
          cardId: todo.id,
          title: "Reader discussion",
          evaluatorThreadId: ThreadId.make("evaluator-1"),
          participants: [],
          lastSeq: 2,
          lastMessageAt: at,
          createdBy: { _tag: "owner" },
          createdAt: at,
          archivedAt: null,
          titleEditedAt: null,
          settledAt: null,
          snoozedUntil: null,
          pinnedAt: null,
          reopenedAt: null,
        } satisfies KanbanDiscussion;
        const message = (seq: number) =>
          ({
            discussionId,
            seq,
            author: { _tag: "owner" },
            authorName: "Owner",
            blocks: [{ _tag: "md", text: `Message ${seq}` }],
            answers: [],
            createdAt: at,
          }) satisfies KanbanMessage;
        const ownerMessage = message(1);
        const evaluatorMessage = {
          ...message(2),
          author: { _tag: "evaluator", threadId: ThreadId.make("evaluator-1") },
          authorName: "Evaluator",
          createdAt: "2026-10-25T13:01:00.000Z",
        } satisfies KanbanMessage;
        const noOwnerDiscussion = {
          ...discussion,
          id: noOwnerDiscussionId,
          cardId: null,
          evaluatorThreadId: null,
          lastSeq: 1,
        } satisfies KanbanDiscussion;
        const noOwnerMessage = {
          ...evaluatorMessage,
          discussionId: noOwnerDiscussionId,
          seq: 1,
        } satisfies KanbanMessage;
        const script = {
          id: scriptId,
          boardId,
          name: "Reader script",
          path: "/test/reader.sh",
          trigger: { _tag: "manual" },
          enabled: true,
          createdBy: { _tag: "owner" },
          createdAt: at,
          lastRun: null,
        } satisfies KanbanScript;
        const otherScript = {
          ...script,
          id: KanbanScriptId.make("script-2"),
          boardId: otherBoard.id,
          name: "Other script",
        } satisfies KanbanScript;
        const automation = {
          id: KanbanAutomationId.make("automation-1"),
          boardId,
          name: "Reader automation",
          scheduledTaskId: "task-1",
          enabled: true,
          createdAt: at,
        } satisfies KanbanAutomation;
        const wiki = {
          boardId,
          slug: "reader",
          title: "Reader wiki",
          body: "Stored content",
          updatedAt: at,
          updatedBy: { _tag: "owner" },
        } satisfies KanbanWikiPage;
        const thread = {
          threadId: ThreadId.make("thread-2"),
          boardId,
          cardId: working.id,
          role: "work",
          purpose: null,
          discussionId,
          model,
          startedAt: at,
          endedAt: null,
          paused: null,
        } satisfies KanbanThreadLink;
        const endedThread = {
          ...thread,
          threadId: ThreadId.make("thread-ended"),
          cardId: todo.id,
          endedAt: at,
        } satisfies KanbanThreadLink;
        const unrelatedThread = {
          ...thread,
          threadId: ThreadId.make("thread-other-board"),
          boardId: otherBoard.id,
          cardId: null,
        } satisfies KanbanThreadLink;
        const unrelatedEndedThread = {
          ...unrelatedThread,
          threadId: ThreadId.make("thread-other-board-ended"),
          endedAt: at,
        } satisfies KanbanThreadLink;

        yield* store.putBoard(board);
        yield* store.putBoard(otherBoard);
        yield* store.putCard(todo);
        yield* store.putCard(working);
        const event = yield* store.addCardEvent({
          cardId: todo.id,
          at,
          actor: { _tag: "owner" },
          kind: "comment",
          fromStage: null,
          toStage: null,
          body: "Stored event",
          head: null,
        });
        yield* store.putGoal(goal);
        yield* store.putPool(boardId, pool);
        yield* store.putGroups(boardId, [group]);
        yield* store.putDiscussion(discussion);
        yield* store.putDiscussion(noOwnerDiscussion);
        yield* store.putMessage(ownerMessage);
        yield* store.putMessage(evaluatorMessage);
        yield* store.putMessage(noOwnerMessage);
        yield* store.putScript(script);
        yield* store.putScript(otherScript);
        const run = yield* store.addScriptRun({
          scriptId,
          startedAt: at,
          endedAt: at,
          exitCode: 0,
          output: "Stored output",
          trigger: "manual",
        });
        const laterRun = yield* store.addScriptRun({
          scriptId,
          startedAt: at,
          endedAt: at,
          exitCode: 1,
          output: "Later output",
          trigger: "manual",
        });
        yield* store.putAutomation(automation);
        yield* store.putWiki(wiki);
        yield* store.putThreadLink(thread);
        yield* store.putThreadLink(endedThread);
        yield* store.putThreadLink(unrelatedThread);
        yield* store.putThreadLink(unrelatedEndedThread);
        yield* store.addThreadCard(thread.threadId, todo.id, at);
        yield* store.addThreadCard(thread.threadId, working.id, at);
        yield* sql`CREATE TABLE reader_test_writer (value TEXT NOT NULL)`;

        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* Effect.forkChild(
          sql.withTransaction(
            sql`INSERT INTO reader_test_writer (value) VALUES ('held')`.pipe(
              Effect.andThen(Deferred.succeed(held, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          yield* Deferred.await(held);
          assert.deepStrictEqual(yield* store.ownerWait(discussionId), {
            seq: ownerMessage.seq,
            createdAt: ownerMessage.createdAt,
            answered: true,
          });
          assert.isNull(yield* store.ownerWait(noOwnerDiscussionId));
          assert.deepStrictEqual(yield* store.boards, [board, otherBoard]);
          assert.deepStrictEqual(yield* store.cards(boardId), [todo, working]);
          assert.deepStrictEqual(yield* store.summaryCards(boardId), [
            { id: todo.id, stage: "todo", settledAt: null, activeThreadId: null, asks: [] },
            {
              id: working.id,
              stage: "working",
              settledAt: null,
              activeThreadId: working.activeThreadId,
              asks: [],
            },
          ]);
          assert.deepStrictEqual(yield* store.card(todo.id), todo);
          assert.deepStrictEqual(yield* store.cardByNumber(boardId, 2), working);
          assert.deepStrictEqual(yield* store.cardsByThread(thread.threadId), [working]);
          assert.deepStrictEqual(yield* store.cardsInStage("working"), [working]);
          assert.deepStrictEqual(yield* store.cardEvents(todo.id), [event]);
          assert.deepStrictEqual(yield* store.goals(boardId), [goal]);
          assert.deepStrictEqual(yield* store.pools(boardId), [pool]);
          assert.deepStrictEqual(yield* store.groups(boardId), [group]);
          assert.deepStrictEqual(yield* store.discussions(boardId), [
            discussion,
            noOwnerDiscussion,
          ]);
          assert.deepStrictEqual(yield* store.discussion(discussionId), discussion);
          assert.deepStrictEqual(yield* store.discussionByEvaluator("evaluator-1"), discussion);
          assert.deepStrictEqual(yield* store.messages(discussionId, { limit: 1 }), [
            evaluatorMessage,
          ]);
          assert.deepStrictEqual(yield* store.allMessages(discussionId), [
            ownerMessage,
            evaluatorMessage,
          ]);
          assert.deepStrictEqual(yield* store.message(discussionId, 1), ownerMessage);
          assert.deepStrictEqual(yield* store.scripts(boardId), [script]);
          assert.deepStrictEqual(yield* store.allScripts, [script, otherScript]);
          assert.deepStrictEqual(yield* store.script(scriptId), script);
          assert.deepStrictEqual(yield* store.scriptRuns(scriptId, 1), [laterRun]);
          assert.deepStrictEqual(yield* store.scriptRuns(scriptId, 5), [laterRun, run]);
          assert.deepStrictEqual(yield* store.automations(boardId), [automation]);
          assert.deepStrictEqual(yield* store.wiki(boardId), [wiki]);
          assert.deepStrictEqual(yield* store.threadLink(thread.threadId), thread);
          assert.deepStrictEqual(yield* store.threadLinks({ boardId, open: true }), [thread]);
          assert.deepStrictEqual(yield* store.threadLinks({ boardId, open: false }), [
            thread,
            endedThread,
          ]);
          assert.deepStrictEqual(yield* store.threadLinks({ cardId: todo.id }), [
            thread,
            endedThread,
          ]);
          assert.deepStrictEqual(yield* store.threadCards(thread.threadId), [todo.id, working.id]);
        }).pipe(Effect.timeout("5 seconds"), Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(writer).pipe(Effect.timeout("5 seconds"));
      }),
    ),
  30_000,
);

it.live(
  "outside reads see committed cards while a writer has uncommitted changes",
  () =>
    withFileStore(
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const sql = yield* SqlClient.SqlClient;
        const original = card(1, "todo");
        const updated = { ...card(1, "working"), title: "Updated in transaction" };
        yield* store.putCard(original);

        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* Effect.forkChild(
          sql.withTransaction(
            store
              .putCard(updated)
              .pipe(
                Effect.andThen(Deferred.succeed(held, undefined)),
                Effect.andThen(Deferred.await(release)),
              ),
          ),
        );
        yield* Effect.gen(function* () {
          yield* Deferred.await(held);
          assert.deepStrictEqual(yield* store.card(original.id), original);
          assert.deepStrictEqual(yield* store.cards(boardId), [original]);
        }).pipe(Effect.timeout("5 seconds"), Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(writer).pipe(Effect.timeout("5 seconds"));
        assert.deepStrictEqual(yield* store.card(original.id), updated);
        assert.deepStrictEqual(yield* store.cards(boardId), [updated]);
      }),
    ),
  30_000,
);

it.live(
  "reads its own uncommitted card in a writer transaction and after commit",
  () =>
    withFileStore(
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const sql = yield* SqlClient.SqlClient;
        const inserted = card(1, "working");
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* store.putCard(inserted);
              assert.deepStrictEqual(yield* store.card(inserted.id), inserted);
              assert.deepStrictEqual(yield* store.cardByNumber(boardId, 1), inserted);
              assert.deepStrictEqual(yield* store.cards(boardId), [inserted]);
            }),
          )
          .pipe(Effect.timeout("5 seconds"));
        assert.deepStrictEqual(yield* store.card(inserted.id), inserted);
        assert.deepStrictEqual(yield* store.cards(boardId), [inserted]);
      }),
    ),
  30_000,
);

it.live(
  "allocates the next card number on the file database writer",
  () =>
    withFileStore(
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const spans: Array<Tracer.Span> = [];
        const observe: Statement.Transformer = (statement, _sql, _fiber, span) => {
          const [query] = statement.compile();
          if (query.includes("MAX(number)")) spans.push(span);
          return Effect.succeed(statement);
        };
        yield* store.putCard(card(1, "todo"));
        assert.strictEqual(
          yield* store
            .nextCardNumber(boardId)
            .pipe(
              Effect.provideService(Statement.CurrentTransformer, observe),
              Effect.provideService(Statement.SpanPropagationEnabled, true),
            ),
          2,
        );
        assert.deepStrictEqual(
          spans.map((span) => span.attributes.get("db.connection")),
          ["writer"],
        );
      }),
    ),
  30_000,
);

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
      assert.deepStrictEqual(yield* store.cardByNumber(boardId, 2), card(2, "working"));
      assert.isNull(yield* store.cardByNumber(boardId, 99999));
      assert.isNull(yield* store.cardByNumber(KanbanBoardId.make("board-other"), 2));
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
      assert.notInclude(
        (yield* store.boards).map((entry) => entry.id),
        fresh.id,
      );
      assert.deepStrictEqual(yield* store.pools(fresh.id), []);
    }),
  );

  it.effect("writes the board and its pools together when all of them succeed", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const fresh = { ...board, id: KanbanBoardId.make("board-together"), slug: "together" };
      const pool = { key: "opencode/opus/c", model, slots: 0 };
      yield* store.putBoardWithPools(fresh, [pool]);
      assert.include(
        (yield* store.boards).map((entry) => entry.id),
        fresh.id,
      );
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
