import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

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
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import { kanbanDDL } from "../../persistence/kanbanSchema.ts";
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
  nightlyReview: null,
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

it.effect("loads open review links with their cards, including missing cards, in one read", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const current = card(1, "in_review");
    yield* store.putCard(current);
    const link: KanbanThreadLink = {
      threadId: ThreadId.make("review-1"),
      boardId,
      cardId: current.id,
      role: "review",
      purpose: null,
      discussionId: null,
      model,
      startedAt: at,
      endedAt: null,
      paused: null,
    };
    yield* store.putThreadLink(link);
    const missing = {
      ...link,
      threadId: ThreadId.make("missing"),
      cardId: KanbanCardId.make("missing"),
    };
    yield* store.putThreadLink(missing);
    yield* store.putThreadLink({ ...link, threadId: ThreadId.make("work"), role: "work" });
    yield* store.putThreadLink({ ...link, threadId: ThreadId.make("ended"), endedAt: at });
    yield* store.putThreadLink({
      ...link,
      threadId: ThreadId.make("other-board"),
      boardId: KanbanBoardId.make("other"),
    });
    const queries: string[] = [];
    const observe: Statement.Transformer = (statement) => {
      queries.push(statement.compile()[0]);
      return Effect.succeed(statement);
    };
    const joined = yield* store
      .openReviewLinks(boardId)
      .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    assert.lengthOf(queries, 1);
    assert.deepStrictEqual(joined, [
      { link, card: current },
      { link: missing, card: null },
    ]);
  }).pipe(Effect.provide(TestLayer)),
);

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

it.effect("compact pages read the split boards database, not orchestration storage", () =>
  Effect.gen(function* () {
    const main = yield* SqlClient.SqlClient;
    const context = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
    const sql = Context.get(context, SqlClient.SqlClient);
    yield* Effect.forEach(kanbanDDL, (ddl) => sql.unsafe(ddl), { discard: true });
    const split = BoardsDatabase.BoardsDatabase.of({ sql, ready: Effect.void, path: ":memory:" });
    yield* Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const detail = "private detail".repeat(1_000);
      yield* store.putBoard(board);
      yield* Effect.forEach([1, 3, 8], (number) =>
        store.putCard({
          ...card(number, "todo"),
          description: detail,
          prompt: detail,
          wakeNote: detail,
        }),
      );
      yield* store.putGoal({
        id: KanbanGoalId.make("split-goal"),
        boardId,
        name: "Split goal",
        status: "active",
        now: null,
        story: [{ at, text: detail }],
        createdAt: at,
      });
      const first = yield* store.feedCards(boardId, { after: 0, limit: 2 });
      const next = yield* store.feedCards(boardId, { after: first.at(-1)!.number, limit: 2 });
      assert.deepStrictEqual(
        first.map((row) => row.number),
        [1, 3],
      );
      assert.deepStrictEqual(
        next.map((row) => row.number),
        [8],
      );
      assert.isTrue(
        first.every(
          (row) => row.prompt === "" && row.description === "" && row.wakeNote === "pending",
        ),
      );
      assert.strictEqual((yield* store.feedGoals(boardId))[0]!.story[0]!.text.length, 512);
      assert.strictEqual((yield* store.card(first[0]!.id))!.prompt, detail);
    }).pipe(
      Effect.provide(
        KanbanStore.layer.pipe(Layer.provide(Layer.succeed(BoardsDatabase.BoardsDatabase, split))),
      ),
    );
    assert.deepStrictEqual(
      yield* main`SELECT name FROM sqlite_schema WHERE name GLOB 'ardud_kanban_*'`,
      [],
    );
  }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);

it.effect("pages big boards without loading card detail or goal histories", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const large = "detail".repeat(200_000);
    for (let number = 1; number <= 24; number++) {
      yield* store.putCard({
        ...card(number, "todo"),
        description: large,
        prompt: large,
        wakeNote: large,
      });
    }
    yield* store.putGoal({
      id: KanbanGoalId.make("goal-big"),
      boardId,
      name: "Big",
      status: "active",
      now: null,
      story: [{ at, text: large }],
      createdAt: at,
    });
    const first = yield* store.feedCards(boardId, { after: 0, limit: 10 });
    const next = yield* store.feedCards(boardId, { after: first.at(-1)!.number, limit: 10 });
    assert.deepEqual(
      first.map((row) => row.number),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.strictEqual(next[0]!.number, 11);
    assert.isBelow(Buffer.byteLength(JSON.stringify(first)), 30_000);
    assert.isTrue(
      first.every(
        (row) => row.prompt === "" && row.description === "" && row.wakeNote === "pending",
      ),
    );
    assert.isNull(first[0]!.stalled);
    assert.lengthOf((yield* store.feedGoals(boardId))[0]!.story, 1);
    assert.strictEqual((yield* store.feedGoals(boardId))[0]!.story[0]!.text.length, 512);
    assert.strictEqual((yield* store.card(first[0]!.id))!.prompt, large);
    assert.lengthOf((yield* store.goals(boardId))[0]!.story, 1);
  }).pipe(Effect.provide(TestLayer)),
);

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
          assert.deepStrictEqual(yield* store.discussionBoardIdsByEvaluator("evaluator-1"), [
            boardId,
          ]);
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
        packet(7, "needs_owner", { asks: [{ ...openAsk, blocking: true, handedAt: at }] }),
        packet(8, "todo", { activeThreadId: null, asks: [{ ...openAsk, clarifyAskedAt: at }] }),
        packet(9, "todo", { activeThreadId: null, asks: [{ ...openAsk, expiresAt: at }] }),
        packet(10, "todo", {
          activeThreadId: null,
          asks: [{ ...openAsk, snoozedUntil: "2999-01-01T00:00:00.000Z" }],
        }),
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
          // Whose turn it is travels with each ask; the keys stay absent when unset.
          asks: asks.map(({ closedAt, clarifyAskedAt, handedAt, expiresAt, snoozedUntil }) => ({
            closedAt,
            ...(clarifyAskedAt === undefined ? {} : { clarifyAskedAt }),
            ...(handedAt === undefined ? {} : { handedAt }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
            ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
          })),
        })),
      );
      assert.isBelow(JSON.stringify(summary).length, 3_000);
      assert.isAbove(JSON.stringify(full).length, 600_000);

      const nowMs = Date.parse(at) + 1;
      const fromFull = summaries(
        tallyBoards([{ board, cards: full, discussions: [], threadIds: [] }]),
        nowMs,
      );
      const fromSummary = summaries(
        tallyBoards([{ board, cards: summary, discussions: [], threadIds: [] }]),
        nowMs,
      );
      assert.deepStrictEqual(fromSummary, fromFull);
      // Cards 3 and 4; the handed, waiting-on-asker, expired and snoozed asks (7 to 10) don't count.
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

it.effect(
  "discussion board candidates include every distinct board and follow evaluator ownership",
  () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const evaluator = ThreadId.make("evaluator");
      const otherBoard = { ...board, id: KanbanBoardId.make("board-2"), slug: "other" };
      yield* store.putBoard(board);
      yield* store.putBoard(otherBoard);
      const first = {
        id: KanbanDiscussionId.make("disc-1"),
        boardId,
        cardId: null,
        title: "First",
        evaluatorThreadId: evaluator,
        participants: [],
        lastSeq: 0,
        lastMessageAt: null,
        createdBy: { _tag: "owner" },
        createdAt: at,
        archivedAt: null,
        titleEditedAt: null,
        settledAt: null,
        snoozedUntil: null,
        pinnedAt: null,
        reopenedAt: null,
      } satisfies KanbanDiscussion;
      const other = { ...first, id: KanbanDiscussionId.make("disc-3"), boardId: otherBoard.id };
      yield* store.putDiscussion(first);
      yield* store.putDiscussion({ ...first, id: KanbanDiscussionId.make("disc-2") });
      yield* store.putDiscussion(other);
      assert.deepStrictEqual(yield* store.discussionBoardIdsByEvaluator(evaluator), [
        boardId,
        otherBoard.id,
      ]);
      assert.deepStrictEqual(yield* store.discussionBoardIdsByEvaluator("absent"), []);
      yield* store.putDiscussion({ ...other, evaluatorThreadId: ThreadId.make("replacement") });
      assert.deepStrictEqual(yield* store.discussionBoardIdsByEvaluator(evaluator), [boardId]);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("releases the reader every 64 summary rows on a 3,000-card board", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const sql = yield* SqlClient.SqlClient;
    const expected = Array.from({ length: 3_000 }, (_, i) => ({
      ...card((i + 1) * 2, i % 2 === 0 ? "needs_owner" : "working"),
      settledAt: i % 7 === 0 ? at : null,
      asks: [
        {
          id: "q1",
          text: "Go?",
          blocking: false,
          by: { _tag: "owner" as const },
          at,
          seq: null,
          closedAt: i % 3 === 0 ? at : null,
        },
      ],
    }));
    yield* sql.withTransaction(Effect.forEach(expected, store.putCard, { discard: true }));
    const batches: Array<number> = [];
    const observe: Statement.Transformer = (statement) => {
      const [query, params] = statement.compile();
      if (!query.includes("json_object(") || !query.includes("'settledAt'"))
        return Effect.succeed(statement);
      return sql.unsafe<{ count: number }>(`SELECT COUNT(*) AS count FROM (${query})`, params).pipe(
        Effect.provideService(Statement.CurrentTransformer, undefined),
        Effect.tap((rows) => Effect.sync(() => batches.push(rows[0]!.count))),
        Effect.as(statement),
        Effect.orDie,
      );
    };
    const summary = yield* store
      .summaryCards(boardId)
      .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    assert.deepStrictEqual(
      summary,
      expected.map(({ id, stage, settledAt, activeThreadId, asks }) => ({
        id,
        stage,
        settledAt,
        activeThreadId,
        asks: asks.map(({ closedAt }) => ({ closedAt })),
      })),
    );
    assert.strictEqual(
      batches.reduce((a, b) => a + b, 0),
      3_000,
    );
    assert.isAtMost(Math.max(...batches), 64);
    // A write between reads must be visible: batching adds no cached result.
    yield* store.putCard({ ...expected[0]!, stage: "verified", settledAt: at });
    assert.strictEqual((yield* store.summaryCards(boardId))[0]!.stage, "verified");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("reuses decoded rows across list and single reads without parsing again", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    yield* store.putBoard(board);
    yield* store.putCard(card(1, "todo"));
    const parse = vi.spyOn(JSON, "parse");
    try {
      const firstBoard = yield* store.board(boardId);
      const firstCard = yield* store.card(KanbanCardId.make("card-1"));
      const parses = parse.mock.calls.length;
      assert.strictEqual((yield* store.boards)[0], firstBoard);
      assert.strictEqual((yield* store.cards(boardId))[0], firstCard);
      assert.strictEqual(parse.mock.calls.length, parses);
      assert.deepStrictEqual(firstBoard, board);
      assert.deepStrictEqual(firstCard, card(1, "todo"));
      assert.isTrue(Object.isFrozen(firstBoard));
      assert.isTrue(Object.isFrozen(firstBoard!.instructions));
      assert.isTrue(Object.isFrozen(firstCard!.subtasks));
      assert.isTrue(Object.isFrozen(firstCard!.model));
      assert.throws(
        () => Object.assign(firstBoard!.instructions, { escalation: "mutated" }),
        TypeError,
      );
      assert.throws(() => Object.assign(firstCard!.projects, { 0: "mutated" }), TypeError);
    } finally {
      parse.mockRestore();
    }
  }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("decodes changed JSON for the same id, including raw SQL writes", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.putBoard(board);
    const before = yield* store.board(boardId);
    const changed = { ...board, name: "Changed outside the store" };
    yield* sql`UPDATE ardud_kanban_boards SET json = ${JSON.stringify(changed)} WHERE id = ${boardId}`;
    const after = yield* store.board(boardId);
    assert.deepStrictEqual(after, changed);
    assert.notStrictEqual(after, before);
    assert.strictEqual((yield* store.boards)[0], after);
    assert.strictEqual(before!.name, board.name);
  }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.live(
  "a rollback returns committed rows even after decoding the uncommitted write",
  () =>
    withFileStore(
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.putBoard(board);
        yield* store.putCard(card(1, "todo"));
        const before = yield* store.board(boardId);
        const beforeCard = yield* store.card(KanbanCardId.make("card-1"));
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* store.putBoard({ ...board, name: "Uncommitted" });
              yield* store.putCard({ ...card(1, "todo"), title: "Uncommitted" });
              assert.strictEqual((yield* store.board(boardId))!.name, "Uncommitted");
              assert.strictEqual(
                (yield* store.card(KanbanCardId.make("card-1")))!.title,
                "Uncommitted",
              );
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.flip);
        assert.deepStrictEqual(yield* store.board(boardId), before);
        assert.deepStrictEqual(yield* store.card(KanbanCardId.make("card-1")), beforeCard);
      }),
    ),
  30_000,
);

it.live(
  "keeps a 6000-card working set across boards, projections and thread reads",
  () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const smallBoard = KanbanBoardId.make("small-board");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (let number = 1; number <= 6000; number++) {
            const row = {
              ...card(number, "todo"),
              boardId: number <= 5000 ? boardId : smallBoard,
              prompt: "Fixture working-set prompt. ".repeat(80),
            };
            yield* store.putCard(row);
            yield* store.putThreadLink({
              threadId: ThreadId.make(`cache-thread-${number}`),
              boardId: row.boardId,
              cardId: row.id,
              role: "work",
              purpose: null,
              discussionId: null,
              model,
              startedAt: at,
              endedAt: null,
              paused: null,
            });
          }
        }),
      );
      // Isolated synthetic data only. Force GC so this reports retained cache heap,
      // rather than the transient allocations from writing/decoding the fixture.
      NodeV8.setFlagsFromString("--expose_gc");
      const gc = NodeVM.runInNewContext("gc") as () => void;
      gc();
      const beforeBytes = process.memoryUsage().heapUsed;
      for (const id of [smallBoard, boardId]) {
        assert.strictEqual((yield* store.cards(id)).length, id === boardId ? 5000 : 1000);
        yield* store.summaryCards(id);
        yield* store.feedCards(id);
        yield* store.threadLinks({ boardId: id, open: false });
      }
      gc();
      const retainedBytes = process.memoryUsage().heapUsed - beforeBytes;
      const cold = yield* store.decodeCacheStats;
      for (const id of [boardId, smallBoard]) {
        yield* store.cards(id);
        yield* store.summaryCards(id);
        yield* store.feedCards(id);
        yield* store.threadLinks({ boardId: id, open: false });
      }
      const warm = yield* store.decodeCacheStats;
      const spans: Tracer.Span[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      yield* store.summaryCards(boardId).pipe(Effect.withTracer(tracer));
      const summaryRead = spans.find((span) => span.name === "KanbanStore.read");
      assert.strictEqual(summaryRead?.attributes.get("kanban.decode.summary.hits"), 5000);
      assert.strictEqual(summaryRead?.attributes.get("kanban.decode.summary.misses"), 0);
      for (const name of ["card", "feed", "summary", "thread"]) {
        assert.strictEqual(cold[name]!.entries, 6000);
        assert.strictEqual(warm[name]!.misses, 6000);
        assert.strictEqual(warm[name]!.hits - cold[name]!.hits, 6000);
        assert.strictEqual(warm[name]!.evictions, 0);
      }
      const original = yield* store.card(KanbanCardId.make("card-1"));
      yield* store.feedCards(boardId, { after: 0, limit: 1 });
      assert.strictEqual(yield* store.card(original!.id), original);
      yield* Effect.logInfo("KANBAN_WORKING_SET_COUNTS", {
        cards: 6000,
        bigBoard: 5000,
        smallBoard: 1000,
        retainedBytes,
        bytesPerCardAllDecoders: Math.round(retainedBytes / 6000),
        cold,
        warm,
      });
    }).pipe(Effect.provide(TestLayer)),
  60_000,
);

it.effect("replaces a row version and drops deleted card and thread entries", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const sql = yield* SqlClient.SqlClient;
    const row = card(1, "todo");
    const threadId = ThreadId.make("deleted-thread");
    yield* store.putCard(row);
    yield* store.putThreadLink({
      threadId,
      boardId,
      cardId: row.id,
      role: "work",
      purpose: null,
      discussionId: null,
      model,
      startedAt: at,
      endedAt: null,
      paused: null,
    });
    yield* store.cards(boardId);
    yield* store.summaryCards(boardId);
    yield* store.feedCards(boardId);
    yield* store.threadLink(threadId);
    const cold = yield* store.decodeCacheStats;
    const changed = { ...row, title: "Changed through SQL", stage: "working" };
    yield* sql`UPDATE ardud_kanban_cards SET stage = 'working', json = ${JSON.stringify(changed)} WHERE id = ${row.id}`;
    assert.deepStrictEqual(yield* store.card(row.id), changed);
    const updated = yield* store.decodeCacheStats;
    assert.strictEqual(updated.card!.misses - cold.card!.misses, 1);
    assert.strictEqual(updated.card!.entries, 1);
    yield* sql`DELETE FROM ardud_kanban_cards WHERE id = ${row.id}`;
    yield* sql`DELETE FROM ardud_kanban_threads WHERE thread_id = ${threadId}`;
    yield* store.cards(boardId);
    yield* store.threadLinks({ boardId, open: false });
    const deleted = yield* store.decodeCacheStats;
    for (const name of ["card", "feed", "summary", "thread"]) {
      assert.strictEqual(deleted[name]!.entries, 0);
      assert.strictEqual(deleted[name]!.evictions, 1);
    }
    assert.isNull(yield* store.card(row.id));
    assert.isNull(yield* store.threadLink(threadId));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("open cards use the partial index and follow settle and reopen writes", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const sql = yield* SqlClient.SqlClient;
    const open = card(1, "todo");
    const settled = { ...card(2, "verified"), settledAt: at };
    yield* store.putCard(open);
    yield* store.putCard(settled);
    const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT id, board_id, json FROM ardud_kanban_cards
      WHERE board_id = ${boardId} AND json_extract(json, '$.settledAt') IS NULL
      ORDER BY number`;
    assert.isTrue(plan.some((row) => row.detail.includes("ardud_kanban_cards_open")));
    assert.deepStrictEqual(yield* store.openCards(boardId), [open]);
    assert.strictEqual((yield* store.decodeCacheStats).card!.misses, 1);
    yield* store.putCard({ ...open, settledAt: at });
    yield* store.putCard({ ...settled, settledAt: null });
    assert.deepStrictEqual(yield* store.openCards(boardId), [{ ...settled, settledAt: null }]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("does not freeze decoded rows outside tests when NODE_ENV is unset", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    yield* store.putCard(card(1, "todo"));
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", undefined);
    try {
      const row = yield* store.card(KanbanCardId.make("card-1"));
      assert.isFalse(Object.isFrozen(row));
      assert.isFalse(Object.isFrozen(row!.subtasks));
    } finally {
      vi.unstubAllEnvs();
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.live(
  "observes a second connection's board, card and thread changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "kanban-cache-writer-" });
      const dbPath = path.join(dir, "boards.sqlite");
      const other = yield* Layer.build(NodeSqliteClient.layer({ filename: dbPath }));
      const writer = Context.get(other, SqlClient.SqlClient);
      yield* Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const link = {
          threadId: ThreadId.make("cache-thread"),
          boardId,
          cardId: KanbanCardId.make("card-1"),
          role: "work" as const,
          purpose: null,
          discussionId: null,
          model,
          startedAt: at,
          endedAt: null,
          paused: null,
        };
        yield* store.putBoard(board);
        yield* store.putCard(card(1, "todo"));
        yield* store.putThreadLink(link);
        const originalBoard = yield* store.board(boardId);
        const originalCard = yield* store.card(link.cardId);
        const originalLink = yield* store.threadLink(link.threadId);
        assert.strictEqual((yield* store.threadLinksByIds([link.threadId]))[0], originalLink);
        assert.deepStrictEqual(yield* store.threadLinksByIds([]), []);
        assert.isTrue(Object.isFrozen(originalLink));
        assert.isTrue(Object.isFrozen(originalLink!.model));
        const nextBoard = { ...board, name: "Other writer" };
        const nextCard = { ...card(1, "todo"), title: "Other writer" };
        const nextLink = { ...link, endedAt: at };
        yield* writer`UPDATE ardud_kanban_boards SET json = ${JSON.stringify(nextBoard)} WHERE id = ${boardId}`;
        yield* writer`UPDATE ardud_kanban_cards SET json = ${JSON.stringify(nextCard)} WHERE id = ${link.cardId}`;
        yield* writer`UPDATE ardud_kanban_threads SET json = ${JSON.stringify(nextLink)} WHERE thread_id = ${link.threadId}`;
        assert.deepStrictEqual(yield* store.board(boardId), nextBoard);
        assert.deepStrictEqual(yield* store.card(link.cardId), nextCard);
        assert.deepStrictEqual(yield* store.threadLink(link.threadId), nextLink);
        assert.deepStrictEqual(yield* store.threadLinksByIds([link.threadId, "absent"]), [
          nextLink,
        ]);
        assert.deepStrictEqual(originalBoard, board);
        assert.deepStrictEqual(originalCard, card(1, "todo"));
        assert.deepStrictEqual(originalLink, link);
      }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provide(Sqlite.layerFromPath(dbPath)))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);

it.effect(
  "dispatch candidates use a partial index and retain waits, deciding and thread holders",
  () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const wait = {
        on: "time" as const,
        pr: null,
        card: null,
        ask: null,
        until: at,
        sinceHead: null,
        script: null,
        args: null,
        note: "Later",
        by: { _tag: "owner" as const },
        at,
        wakeRole: null,
        expiredAt: null,
        status: null,
        lastCheckedAt: null,
        failures: 0,
        problem: null,
      };
      const rows = [
        card(1, "todo"),
        card(2, "working"),
        card(3, "needs_review"),
        card(4, "in_review"),
        { ...card(5, "completed"), wait },
        { ...card(6, "deployed"), deciding: { since: at, why: "Wait ended", toldAt: null } },
        { ...card(7, "needs_owner"), activeThreadId: ThreadId.make("still-held") },
        card(8, "completed"),
        card(9, "deployed"),
        card(10, "verified"),
        card(11, "needs_owner"),
        { ...card(12, "todo"), settledAt: at },
      ];
      yield* Effect.forEach(rows, (row) => store.putCard(row), { discard: true });
      const queries: string[] = [];
      const observe: Statement.Transformer = (statement) => {
        queries.push(statement.compile()[0]);
        return Effect.succeed(statement);
      };
      assert.deepStrictEqual(
        yield* store
          .dispatchCards(boardId)
          .pipe(Effect.provideService(Statement.CurrentTransformer, observe)),
        rows.slice(0, 7),
      );
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${queries[0]}`, [
        boardId,
      ]);
      assert.isTrue(plan.some((row) => row.detail.includes("ardud_kanban_cards_dispatch")));
      yield* store.putCard({ ...rows[7]!, stage: "todo" });
      yield* store.putCard({ ...rows[0]!, stage: "verified" });
      assert.deepStrictEqual(
        (yield* store.dispatchCards(boardId)).map((row) => row.number),
        [2, 3, 4, 5, 6, 7, 8],
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("card write watches cover raw and bulk writers and end with their pass", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const row = card(1, "todo");
    const closed = yield* Effect.scoped(
      Effect.gen(function* () {
        const changed = yield* store.watchCardWrites(boardId);
        yield* store.putCard(row);
        assert.deepStrictEqual([...changed], [row.id]);
        changed.clear();
        yield* store.rekeyBoard(boardId, [], [{ ...row, title: "Rekeyed" }]);
        assert.deepStrictEqual([...changed], [row.id]);
        changed.clear();
        yield* store.migrateBoardSelections({
          board,
          pools: [],
          oldPoolKeys: [],
          cards: [{ ...row, title: "Migrated" }],
          threadLinks: [],
        });
        assert.deepStrictEqual([...changed], [row.id]);
        changed.clear();
        return changed;
      }),
    );
    yield* store.putCard(row);
    assert.strictEqual(closed.size, 0);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const fresh = yield* store.watchCardWrites(boardId);
        assert.strictEqual(fresh.size, 0);
        yield* store.putCard({
          ...row,
          boardId: KanbanBoardId.make("another-board"),
          id: KanbanCardId.make("another"),
        });
        assert.strictEqual(fresh.size, 0);
        yield* store.putCard(row);
        assert.deepStrictEqual([...fresh], [row.id]);
      }),
    );
  }).pipe(Effect.provide(TestLayer)),
);
