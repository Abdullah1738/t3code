import * as McpCall from "../../analytics/McpCall.ts";
import * as SavedWrite from "../engine/savedWrite.ts";
// @effect-diagnostics nodeBuiltinImport:off - random fixture text prevents string interning in retention measurements.
import * as NodeCrypto from "node:crypto";
import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Schema from "effect/Schema";
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
  KanbanCard,
  KanbanDiscussion,
  type KanbanGoal,
  type KanbanGroup,
  type KanbanMessage,
  type KanbanPool,
  type KanbanScript,
  type KanbanThreadLink,
  type KanbanWikiPage,
  kanbanPickOrder,
  kanbanSchedule,
} from "@t3tools/contracts";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import { kanbanDDL } from "../../persistence/kanbanSchema.ts";
import { ensureKanbanCacheVersions } from "../../persistence/kanbanCacheVersions.ts";
import { summaries, tallyBoards } from "../engine/summaries.ts";
import * as KanbanStore from "./KanbanStore.ts";
import * as Rules from "../engine/rules.ts";

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
  standingApprovals: [],
  releaseLedger: [],
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
  timeoutMs = 15_000,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kanban-reader-" });
    const layer = KanbanStore.layer.pipe(
      Layer.provideMerge(Sqlite.layerFromPath(path.join(dir, "kanban.sqlite"))),
    );
    return yield* effect.pipe(Effect.timeout(timeoutMs), Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("compact pages read the split boards database, not orchestration storage", () =>
  Effect.gen(function* () {
    const main = yield* SqlClient.SqlClient;
    const context = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
    const sql = Context.get(context, SqlClient.SqlClient);
    yield* Effect.forEach(kanbanDDL, (ddl) => sql.unsafe(ddl), { discard: true });
    yield* ensureKanbanCacheVersions(sql);
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
  it.effect("reads old board rows with no standing approvals as an empty history", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.putBoard(board);
      yield* sql`UPDATE ardud_kanban_boards SET json = json_remove(json, '$.standingApprovals') WHERE id = ${board.id}`;
      assert.deepStrictEqual((yield* store.board(board.id))?.standingApprovals, []);
    }),
  );
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

it.layer(TestLayer)("kanban store: activity reads", (it) => {
  it.effect(
    "reads a board's events in a time window and each card's last stage change before it",
    () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        yield* store.putBoard(board);
        yield* store.putCard(card(1, "todo"));
        yield* store.putCard(card(2, "working"));
        const cardOne = KanbanCardId.make("card-1");
        const cardTwo = KanbanCardId.make("card-2");
        const add = (
          cardId: typeof cardOne,
          when: string,
          kind: "created" | "moved" | "comment" | "flagged",
          fromStage: "todo" | "working" | null,
          toStage: "todo" | "working" | "needs_review" | null,
        ) =>
          store.addCardEvent({
            cardId,
            at: when,
            actor: { _tag: "owner" },
            kind,
            fromStage,
            toStage,
            body: null,
            head: null,
          });
        yield* add(cardOne, "2026-11-10T00:00:00.000Z", "created", null, "todo");
        const started = yield* add(cardOne, "2026-11-11T00:00:00.000Z", "moved", "todo", "working");
        // Not stage changes: a comment, and a flag that leaves it where it was.
        yield* add(cardOne, "2026-11-11T06:00:00.000Z", "comment", null, null);
        yield* add(cardOne, "2026-11-11T07:00:00.000Z", "flagged", "working", "working");
        const inWindow = yield* add(
          cardOne,
          "2026-11-12T02:00:00.000Z",
          "moved",
          "working",
          "needs_review",
        );
        const otherCard = yield* add(cardTwo, "2026-11-12T03:00:00.000Z", "comment", null, null);
        yield* add(cardOne, "2026-11-13T05:00:00.000Z", "comment", null, null);

        const events = yield* store.boardEvents(
          boardId,
          "2026-11-12T00:00:00.000Z",
          "2026-11-13T00:00:00.000Z",
        );
        assert.deepStrictEqual(
          events.map((event) => event.id),
          [inWindow.id, otherCard.id],
        );
        assert.deepStrictEqual(
          yield* store.boardEvents(
            KanbanBoardId.make("board-other"),
            "2026-11-12T00:00:00.000Z",
            "2026-11-13T00:00:00.000Z",
          ),
          [],
        );
        const prior = yield* store.lastTransitions(boardId, [cardOne, cardTwo], inWindow.id);
        assert.deepStrictEqual(
          prior.map((event) => event.id),
          [started.id],
        );
        assert.deepStrictEqual(yield* store.lastTransitions(boardId, [], inWindow.id), []);
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

const discussion = (number: number, home = boardId): KanbanDiscussion => ({
  id: KanbanDiscussionId.make(`cache-discussion-${number}`),
  boardId: home,
  cardId: null,
  title: `Discussion ${number}`,
  evaluatorThreadId: null,
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
});

const decodeFullCard = Schema.decodeEffect(Schema.fromJsonString(KanbanCard));
const decodeFullDiscussion = Schema.decodeEffect(Schema.fromJsonString(KanbanDiscussion));

// Observe the store's public read span, rather than inferring transfer from cache statistics.
const tracedRead = Effect.fnUntraced(function* <A, E>(read: Effect.Effect<A, E>) {
  const spans: Tracer.Span[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const value = yield* read.pipe(Effect.withTracer(tracer));
  const span = spans.find((span) => span.name === "KanbanStore.read")!;
  return {
    value,
    rows: span.attributes.get("jsonRowsFetched"),
    bytes: span.attributes.get("jsonBytesFetched"),
  };
});

it.live(
  "collection reads fetch only changed JSON and match full decodes across mutations",
  () =>
    withFileStore(
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.putCard(card(1, "todo"));
        yield* store.putDiscussion(discussion(1));
        const fullCards = Effect.flatMap(
          NodeSqliteClient.readOnly(
            sql<{
              json: string;
            }>`SELECT json FROM ardud_kanban_cards WHERE board_id = ${boardId} ORDER BY number`,
          ),
          (rows) => Effect.forEach(rows, (row) => decodeFullCard(row.json)),
        );
        const fullDiscussions = Effect.flatMap(
          NodeSqliteClient.readOnly(
            sql<{
              json: string;
            }>`SELECT json FROM ardud_kanban_discussions WHERE board_id = ${boardId} ORDER BY rowid`,
          ),
          (rows) => Effect.forEach(rows, (row) => decodeFullDiscussion(row.json)),
        );
        const check = Effect.gen(function* () {
          const cards = yield* fullCards;
          for (const read of [
            store.cards(boardId),
            store.openCards(boardId),
            store.dispatchCards(boardId),
            store.cardPage(boardId, { after: 0, limit: 10, open: true }),
            store.claimCards(boardId, []),
            store.cardsInStage("todo"),
          ])
            assert.deepStrictEqual(yield* read, cards);
          assert.deepStrictEqual(yield* store.discussions(boardId), yield* fullDiscussions);
          assert.deepStrictEqual(yield* store.openDiscussions(boardId), yield* fullDiscussions);
        });
        yield* check;
        for (const read of [
          store.openCards(boardId),
          store.discussions(boardId),
          store.dispatchCards(boardId),
        ]) {
          const warm = yield* tracedRead<unknown, KanbanStore.KanbanStoreError>(read);
          assert.strictEqual(warm.rows, 0);
          assert.strictEqual(warm.bytes, 0);
        }
        // Same length and unchanged timestamps; these writes bypass all store notifications.
        const edit = (text: string) =>
          Effect.all([
            sql`UPDATE ardud_kanban_cards SET json = json_set(json, '$.title', ${text}) WHERE id = 'card-1'`,
            sql`UPDATE ardud_kanban_discussions SET json = json_set(json, '$.title', ${text}) WHERE id = 'cache-discussion-1'`,
          ]);
        yield* edit("Edited");
        const changedCard = yield* tracedRead(store.openCards(boardId));
        const changedDiscussion = yield* tracedRead(store.discussions(boardId));
        assert.strictEqual(changedCard.rows, 1);
        assert.strictEqual(changedDiscussion.rows, 1);
        assert.strictEqual(changedCard.bytes, JSON.stringify(changedCard.value[0]).length);
        yield* check;
        yield* edit("Second");
        assert.strictEqual((yield* tracedRead(store.openCards(boardId))).rows, 1);
        assert.strictEqual((yield* tracedRead(store.discussions(boardId))).rows, 1);
        yield* check;
        // Even the same committed version must bypass shared entries in a caller transaction.
        yield* sql.withTransaction(check);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* edit("Rolled");
              yield* check;
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.flip);
        yield* check;
        yield* edit("Reused");
        yield* check;
        yield* store.putCard(card(2, "todo"));
        yield* store.putDiscussion(discussion(2));
        assert.strictEqual((yield* tracedRead(store.openCards(boardId))).rows, 1);
        assert.strictEqual((yield* tracedRead(store.discussions(boardId))).rows, 1);
        yield* check;
        yield* sql`DELETE FROM ardud_kanban_cards WHERE id = 'card-1'`;
        yield* sql`DELETE FROM ardud_kanban_discussions WHERE id = 'cache-discussion-1'`;
        yield* check;
        assert.strictEqual((yield* store.decodeCacheStats).card!.entries, 1);
        assert.strictEqual((yield* store.decodeCacheStats).discussion!.entries, 1);
      }),
    ),
  30_000,
);

it.live(
  "collection phases keep one reader snapshot across external commits",
  () =>
    withFileStore(
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const sql = yield* SqlClient.SqlClient;
        const original = card(1, "todo");
        const channel = discussion(1);
        yield* store.putCard(original);
        yield* store.putDiscussion(channel);
        // The transform runs immediately before phase two. The independent writer
        // commits updates, a deletion and inserts after phase one's snapshot is established.
        for (const table of ["ardud_kanban_cards", "ardud_kanban_discussions"] as const) {
          let commits = 0;
          const startWrite = yield* Deferred.make<void>();
          // Fork before entering the read transaction so the writer cannot inherit its connection.
          const writer = yield* Effect.gen(function* () {
            yield* Deferred.await(startWrite);
            yield* sql.withTransaction(
              Effect.gen(function* () {
                if (table === "ardud_kanban_cards") {
                  yield* store.putCard({ ...original, title: "Committed during read" });
                  yield* sql`DELETE FROM ardud_kanban_cards WHERE id = ${original.id}`;
                  yield* store.putCard(card(2, "todo"));
                } else {
                  yield* store.putDiscussion({ ...channel, title: "Committed during read" });
                  yield* sql`DELETE FROM ardud_kanban_discussions WHERE id = ${channel.id}`;
                  yield* store.putDiscussion(discussion(2));
                }
              }),
            );
          }).pipe(Effect.forkChild);
          const transform: Statement.Transformer = (statement) => {
            const [query] = statement.compile();
            if (!query.includes(`FROM "${table}"`) || !query.includes("cache_version, json"))
              return Effect.succeed(statement);
            commits++;
            return Deferred.succeed(startWrite, undefined).pipe(
              Effect.andThen(Fiber.join(writer)),
              Effect.as(statement),
              Effect.orDie,
            );
          };
          if (table === "ardud_kanban_cards") {
            assert.deepStrictEqual(
              yield* store
                .openCards(boardId)
                .pipe(Effect.provideService(Statement.CurrentTransformer, transform)),
              [original],
            );
            assert.deepStrictEqual(yield* store.openCards(boardId), [card(2, "todo")]);
          } else {
            assert.deepStrictEqual(
              yield* store
                .discussions(boardId)
                .pipe(Effect.provideService(Statement.CurrentTransformer, transform)),
              [channel],
            );
            assert.deepStrictEqual(yield* store.discussions(boardId), [discussion(2)]);
          }
          assert.strictEqual(commits, 1);
        }
      }),
    ),
  30_000,
);

it.live(
  "warm synthetic board reads cut serialized worker reply bytes by at least 90 percent",
  () =>
    withFileStore(
      Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const sql = yield* SqlClient.SqlClient;
        const cards = Array.from({ length: 4000 }, (_, i) => ({
          ...card(i + 1, "todo"),
          prompt: "x".repeat(8192),
        }));
        const discussions = Array.from({ length: 3000 }, (_, i) => ({
          ...discussion(i + 1),
          title: "d".repeat(2048),
        }));
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, json)
        SELECT json_extract(value, '$.id'), ${boardId}, json_extract(value, '$.number'), 'todo', value FROM json_each(${JSON.stringify(cards)})`;
            yield* sql`INSERT INTO ardud_kanban_discussions (id, board_id, json)
        SELECT json_extract(value, '$.id'), ${boardId}, value FROM json_each(${JSON.stringify(discussions)})`;
          }),
        );
        const messages = vi.spyOn(NodeWorkerThreads.Worker.prototype, "emit");
        try {
          const measure = Effect.fnUntraced(function* <A, E>(read: Effect.Effect<A, E>) {
            messages.mockClear();
            const value = yield* read;
            const replies = messages.mock.calls.flatMap(([event, reply]) =>
              event === "message" ? [reply] : [],
            );
            const rowReplies = replies.filter(
              (reply) => reply && typeof reply === "object" && "rows" in reply,
            ).length;
            return {
              value,
              bytes: replies.reduce((sum, reply) => sum + NodeV8.serialize(reply).byteLength, 0),
              rowReplies,
            };
          });
          const baseline = yield* measure(
            NodeSqliteClient.readOnly(
              Effect.all([
                sql`SELECT id, board_id, cache_version, json FROM ardud_kanban_cards WHERE board_id = ${boardId} ORDER BY number`,
                sql`SELECT id, board_id, cache_version, json FROM ardud_kanban_discussions WHERE board_id = ${boardId} ORDER BY rowid`,
                sql`SELECT id, board_id, cache_version, json, number FROM ardud_kanban_cards WHERE board_id = ${boardId} AND stage = 'todo' AND json_extract(json, '$.settledAt') IS NULL ORDER BY number`,
              ]),
            ),
          );
          assert.strictEqual(baseline.rowReplies, 3);
          assert.strictEqual((yield* tracedRead(store.openCards(boardId))).rows, 4000);
          assert.strictEqual((yield* tracedRead(store.discussions(boardId))).rows, 3000);
          const warm = yield* measure(
            Effect.all([
              tracedRead(store.openCards(boardId)),
              tracedRead(store.discussions(boardId)),
              tracedRead(store.dispatchCards(boardId)),
            ]),
          );
          for (const read of warm.value) {
            assert.strictEqual(read.rows, 0);
            assert.strictEqual(read.bytes, 0);
          }
          assert.deepStrictEqual(warm.value[0]!.value, cards);
          assert.deepStrictEqual(warm.value[1]!.value, discussions);
          assert.isAbove(warm.bytes, 0);
          assert.isBelow(warm.bytes, baseline.bytes * 0.1);
          yield* Effect.logInfo("KANBAN_WORKER_REPLY_BYTES", {
            cards: cards.length,
            discussions: discussions.length,
            operations: ["openCards", "discussions", "dispatchCards"],
            before: baseline.bytes,
            after: warm.bytes,
            reduction: 1 - warm.bytes / baseline.bytes,
            serialization:
              "node:v8 serialize of actual Worker message replies, including transaction control replies",
          });
        } finally {
          messages.mockRestore();
        }
      }),
      45_000,
    ),
  60_000,
);

it.live(
  "keeps more than 2048 discussions across boards, subsets and row versions",
  () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const smallBoard = KanbanBoardId.make("discussion-small-board");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (let i = 1; i <= 3324; i++)
            yield* store.putDiscussion(discussion(i, i <= 3224 ? boardId : smallBoard));
        }),
      );
      const small = yield* store.discussions(smallBoard);
      const big = yield* store.discussions(boardId);
      assert.strictEqual(big.length, 3224);
      assert.strictEqual(small.length, 100);
      const cold = yield* store.decodeCacheStats;
      const spans: Tracer.Span[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const repeat = yield* store.discussions(boardId).pipe(Effect.withTracer(tracer));
      assert.strictEqual(repeat[0], big[0]);
      assert.strictEqual((yield* store.discussions(smallBoard))[0], small[0]);
      const warm = yield* store.decodeCacheStats;
      assert.strictEqual(warm.discussion!.misses, cold.discussion!.misses);
      assert.strictEqual(warm.discussion!.evictions, 0);
      assert.strictEqual(warm.discussion!.entries, 3324);
      assert.strictEqual(
        spans
          .find((span) => span.name === "KanbanStore.read")
          ?.attributes.get("kanban.decode.discussion.misses"),
        0,
      );
      yield* store.openDiscussions(boardId);
      assert.strictEqual((yield* store.discussions(smallBoard))[0], small[0]);
      const changed = {
        ...big[0]!,
        title: "Changed outside the store",
        evaluatorThreadId: ThreadId.make("cache-evaluator"),
      };
      yield* sql`UPDATE ardud_kanban_discussions SET json = ${JSON.stringify(changed)}, evaluator_thread_id = ${changed.evaluatorThreadId} WHERE id = ${changed.id}`;
      assert.deepStrictEqual(yield* store.discussion(changed.id), changed);
      assert.strictEqual(
        yield* store.discussionByEvaluator(changed.evaluatorThreadId),
        yield* store.discussion(changed.id),
      );
      assert.strictEqual(
        (yield* store.decodeCacheStats).discussion!.misses,
        cold.discussion!.misses + 1,
      );
      assert.strictEqual((yield* store.decodeCacheStats).discussion!.entries, 3324);
      // A version decoded inside a rolled-back transaction must never mask the committed JSON.
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* store.putDiscussion({ ...changed, title: "Rolled back" });
            assert.strictEqual((yield* store.discussion(changed.id))!.title, "Rolled back");
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.catch(() => Effect.void));
      assert.deepStrictEqual(yield* store.discussion(changed.id), changed);
      yield* sql`DELETE FROM ardud_kanban_discussions WHERE id = ${changed.id}`;
      yield* store.discussions(boardId);
      assert.strictEqual((yield* store.decodeCacheStats).discussion!.entries, 3323);
      yield* sql`DELETE FROM ardud_kanban_discussions WHERE id = ${small[0]!.id}`;
      assert.isNull(yield* store.discussion(small[0]!.id));
      assert.strictEqual((yield* store.decodeCacheStats).discussion!.entries, 3322);
      assert.strictEqual((yield* store.decodeCacheStats).discussion!.evictions, 2);
      yield* Effect.logInfo("KANBAN_DISCUSSION_WORKING_SET_COUNTS", {
        bigBoard: 3224,
        smallBoard: 100,
        cold,
        warm,
      });
    }).pipe(Effect.provide(TestLayer)),
  60_000,
);

it.effect(
  "open discussions use the partial index and follow settle, archive and reopen writes",
  () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      // Discussion openness is independent of card stage, pinning and snoozing.
      yield* store.putCard({ ...card(1, "verified"), settledAt: at });
      const rows = [
        discussion(1),
        { ...discussion(2), settledAt: at },
        { ...discussion(3), archivedAt: at },
        { ...discussion(4), settledAt: at, archivedAt: at },
        { ...discussion(5), snoozedUntil: "2026-10-26T13:00:00.000Z" },
        { ...discussion(6), pinnedAt: at },
        { ...discussion(7), cardId: KanbanCardId.make("card-1") },
      ];
      for (const row of rows) yield* store.putDiscussion(row);
      // Missing settledAt in old JSON decodes to null and must match the SQL predicate.
      const legacy = discussion(8);
      const { settledAt: _, ...oldJson } = legacy;
      yield* sql`INSERT INTO ardud_kanban_discussions (id, board_id, json) VALUES (${legacy.id}, ${boardId}, ${JSON.stringify(oldJson)})`;
      for (const statement of kanbanDDL) yield* sql.unsafe(statement);
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT id, board_id, json FROM ardud_kanban_discussions
      WHERE board_id = ${boardId}
        AND json_extract(json, '$.settledAt') IS NULL
        AND json_extract(json, '$.archivedAt') IS NULL
      ORDER BY rowid`;
      assert.isTrue(plan.some((row) => row.detail.includes("ardud_kanban_discussions_open")));
      assert.deepStrictEqual(yield* store.openDiscussions(boardId), [
        rows[0]!,
        ...rows.slice(4),
        legacy,
      ]);
      assert.strictEqual((yield* store.decodeCacheStats).discussion!.entries, 5);
      const all = yield* store.discussions(boardId);
      yield* store.putDiscussion({ ...rows[0]!, settledAt: at });
      yield* store.putDiscussion({ ...rows[1]!, settledAt: null });
      yield* store.putDiscussion({ ...rows[2]!, archivedAt: null });
      const open = yield* store.openDiscussions(boardId);
      assert.deepStrictEqual(
        open.map((row) => row.id),
        [rows[1]!.id, rows[2]!.id, ...rows.slice(4).map((row) => row.id), legacy.id],
      );
      assert.strictEqual((yield* store.decodeCacheStats).discussion!.entries, 8);
      assert.strictEqual(yield* store.discussion(rows[3]!.id), all[3]);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("system channel lookup uses its index and reuses the latest settled channel", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const sql = yield* SqlClient.SqlClient;
    const smallBoard = KanbanBoardId.make("channel-other-board");
    const system = (i: number): KanbanDiscussion => ({
      ...discussion(i),
      createdBy: { _tag: "system", component: "scribe" },
    });
    const expected = { ...system(2), settledAt: at };
    for (const row of [
      system(1),
      expected,
      { ...system(3), archivedAt: at },
      { ...system(4), cardId: KanbanCardId.make("card-1") },
      {
        ...system(5),
        createdBy: { _tag: "system", component: "other" },
      } satisfies KanbanDiscussion,
      { ...system(6), boardId: smallBoard },
      discussion(7),
    ])
      yield* store.putDiscussion(row);
    const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT id, board_id, json FROM ardud_kanban_discussions
      WHERE board_id = ${boardId} AND card_id IS NULL
        AND json_extract(json, '$.archivedAt') IS NULL
        AND json_extract(json, '$.createdBy._tag') = 'system'
        AND json_extract(json, '$.createdBy.component') = 'scribe'
      ORDER BY rowid DESC LIMIT 1`;
    assert.isTrue(
      plan.some((row) => row.detail.includes("ardud_kanban_discussions_system_channel")),
    );
    assert.deepStrictEqual(yield* store.latestSystemDiscussion(boardId, "scribe"), expected);
    assert.strictEqual((yield* store.decodeCacheStats).discussion!.misses, 1);
    assert.isNull(yield* store.latestSystemDiscussion(boardId, "missing"));
    yield* store.putDiscussion({ ...expected, archivedAt: at });
    assert.deepStrictEqual(yield* store.latestSystemDiscussion(boardId, "scribe"), system(1));
  }).pipe(Effect.provide(TestLayer)),
);

it.live(
  "keeps board, goal and board-scoped pool working sets with separate goal projections",
  () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const smallBoard = KanbanBoardId.make("metadata-small-board");
      const goal = (i: number, home = boardId): KanbanGoal => ({
        id: KanbanGoalId.make(`cache-goal-${i}`),
        boardId: home,
        name: `Goal ${i}`,
        status: "active",
        now: null,
        story: [{ at, text: "x".repeat(600) }],
        createdAt: at,
      });
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (let i = 1; i <= 2100; i++) {
            yield* store.putBoard({
              ...board,
              id: KanbanBoardId.make(`cache-board-${i}`),
              slug: `cache-board-${i}`,
            });
            yield* store.putGoal(goal(i));
            yield* store.putPool(boardId, { key: `pool-${i}`, model, slots: 1 });
          }
          yield* store.putGoal(goal(2101, smallBoard));
          yield* store.putPool(smallBoard, { key: "pool-1", model, slots: 2 });
        }),
      );
      const smallGoal = (yield* store.goals(smallBoard))[0];
      const smallPool = (yield* store.pools(smallBoard))[0];
      const boards = yield* store.boards;
      const goals = yield* store.goals(boardId);
      const pools = yield* store.pools(boardId);
      const feed = yield* store.feedGoals(boardId);
      assert.strictEqual(feed[0]!.story[0]!.text.length, 512);
      const cold = yield* store.decodeCacheStats;
      assert.strictEqual((yield* store.boards)[0], boards[0]);
      assert.strictEqual((yield* store.goals(boardId))[0], goals[0]);
      assert.strictEqual((yield* store.feedGoals(boardId))[0], feed[0]);
      assert.strictEqual((yield* store.pools(boardId))[0], pools[0]);
      assert.strictEqual((yield* store.goals(smallBoard))[0], smallGoal);
      assert.strictEqual((yield* store.pools(smallBoard))[0], smallPool);
      const warm = yield* store.decodeCacheStats;
      for (const name of ["board", "goal", "goalFeed", "pool"]) {
        assert.strictEqual(warm[name]!.misses, cold[name]!.misses);
        assert.strictEqual(warm[name]!.evictions, 0);
        assert.isAtLeast(warm[name]!.entries, 2100);
      }
      yield* store.putBoard({ ...boards[0]!, name: "Changed" });
      yield* store.putGoal({ ...goals[0]!, name: "Changed" });
      yield* store.putPool(boardId, { ...pools[0]!, slots: 3 });
      assert.strictEqual((yield* store.board(boards[0]!.id))!.name, "Changed");
      assert.strictEqual((yield* store.goals(boardId))[0]!.name, "Changed");
      assert.strictEqual((yield* store.pools(boardId))[0]!.slots, 3);
      for (const name of ["board", "goal", "pool"])
        assert.strictEqual((yield* store.decodeCacheStats)[name]!.misses, cold[name]!.misses + 1);
      yield* sql`DELETE FROM ardud_kanban_boards WHERE id = ${boards[0]!.id}`;
      yield* sql`DELETE FROM ardud_kanban_goals WHERE id = ${goals[0]!.id}`;
      yield* store.removePool(boardId, pools[0]!.key);
      yield* store.boards;
      yield* store.goals(boardId);
      yield* store.pools(boardId);
      const deleted = yield* store.decodeCacheStats;
      for (const name of ["board", "goal", "goalFeed", "pool"]) {
        assert.strictEqual(deleted[name]!.entries, cold[name]!.entries - 1);
        assert.strictEqual(deleted[name]!.evictions, 1);
      }
      assert.strictEqual((yield* store.pools(smallBoard))[0], smallPool);
    }).pipe(Effect.provide(TestLayer)),
  60_000,
);

it.effect("validates large metadata rows across all id-keyed caches", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const sql = yield* SqlClient.SqlClient;
    const metadata = (text: string) => ({
      board: { ...board, name: text },
      goal: {
        id: KanbanGoalId.make("large-goal"),
        boardId,
        name: text,
        status: "active" as const,
        now: null,
        story: [{ at, text: "Full goal only".repeat(50) }],
        createdAt: at,
      },
      pool: { key: "large-pool", model: { ...model, model: text }, slots: 1 },
      discussion: { ...discussion(1), title: text },
    });
    const first = metadata("a".repeat(2048));
    const second = metadata("b".repeat(2048));
    yield* store.putBoard(first.board);
    yield* store.putGoal(first.goal);
    yield* store.putPool(boardId, first.pool);
    yield* store.putDiscussion(first.discussion);
    const read = Effect.gen(function* () {
      return {
        board: yield* store.board(boardId),
        goal: (yield* store.goals(boardId))[0],
        goalFeed: (yield* store.feedGoals(boardId))[0],
        pool: (yield* store.pools(boardId))[0],
        discussion: yield* store.discussion(first.discussion.id),
      };
    });
    const coldRows = yield* read;
    const cold = yield* store.decodeCacheStats;
    const warmRows = yield* read;
    const warm = yield* store.decodeCacheStats;
    for (const name of ["board", "goal", "goalFeed", "pool", "discussion"] as const) {
      assert.strictEqual(warmRows[name], coldRows[name]);
      assert.strictEqual(warm[name]!.misses, cold[name]!.misses);
      assert.strictEqual(warm[name]!.hits - cold[name]!.hits, 1);
    }
    const write = (rows: typeof first) =>
      Effect.gen(function* () {
        yield* sql`UPDATE ardud_kanban_boards SET json = ${JSON.stringify(rows.board)} WHERE id = ${boardId}`;
        yield* sql`UPDATE ardud_kanban_goals SET json = ${JSON.stringify(rows.goal)} WHERE id = ${rows.goal.id}`;
        yield* sql`UPDATE ardud_kanban_pools SET json = ${JSON.stringify(rows.pool)} WHERE board_id = ${boardId} AND key = ${rows.pool.key}`;
        yield* sql`UPDATE ardud_kanban_discussions SET json = ${JSON.stringify(rows.discussion)} WHERE id = ${rows.discussion.id}`;
      });
    yield* write(second);
    const changed = yield* read;
    const changedStats = yield* store.decodeCacheStats;
    assert.deepStrictEqual(changed.board, second.board);
    assert.deepStrictEqual(changed.goal, second.goal);
    assert.deepStrictEqual(changed.pool, second.pool);
    assert.deepStrictEqual(changed.discussion, second.discussion);
    assert.strictEqual(changed.goalFeed!.name, second.goal.name);
    assert.strictEqual(changed.goalFeed!.story[0]!.text.length, 512);
    assert.strictEqual(changed.goal!.story[0]!.text, second.goal.story[0]!.text);
    for (const name of ["board", "goal", "goalFeed", "pool", "discussion"]) {
      assert.strictEqual(changedStats[name]!.misses - cold[name]!.misses, 1);
      assert.strictEqual(changedStats[name]!.entries, 1);
    }
    yield* sql
      .withTransaction(
        write(first).pipe(Effect.andThen(read), Effect.andThen(Effect.fail("rollback"))),
      )
      .pipe(Effect.flip);
    assert.deepStrictEqual(yield* read, changed);
  }).pipe(Effect.provide(TestLayer)),
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

it.live(
  "retains decoded card text without another full JSON copy",
  () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const count = 128;
      const promptBytes = 131_072;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (let number = 1; number <= count; number++) {
            yield* store.putCard({
              ...card(number, "todo"),
              prompt: NodeCrypto.randomBytes(promptBytes / 2).toString("hex"),
            });
          }
        }),
      );
      // Random fixture text cannot be interned; GC excludes temporary SQL/codec allocations.
      NodeV8.setFlagsFromString("--expose_gc");
      const gc = NodeVM.runInNewContext("gc") as () => void;
      gc();
      const before = process.memoryUsage().heapUsed;
      yield* store.cards(boardId);
      yield* Effect.yieldNow;
      gc();
      const retained = process.memoryUsage().heapUsed - before;
      assert.isBelow(retained, count * promptBytes * 1.5);
      const cold = yield* store.decodeCacheStats;
      yield* store.cards(boardId);
      const warm = yield* store.decodeCacheStats;
      assert.strictEqual(warm.card!.misses, cold.card!.misses);
      assert.strictEqual(warm.card!.hits - cold.card!.hits, count);
      yield* Effect.logInfo("KANBAN_JSON_RETENTION", { retained, textBytes: count * promptBytes });
    }).pipe(Effect.provide(TestLayer)),
  30_000,
);

it.effect("invalidates same-length row text with unchanged timestamps", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const sql = yield* SqlClient.SqlClient;
    const row = { ...card(1, "todo"), prompt: "first".repeat(512) };
    yield* store.putCard(row);
    const original = yield* store.card(row.id);
    assert.strictEqual(yield* store.card(row.id), original);
    const cold = yield* store.decodeCacheStats;
    for (const prompt of ["other".repeat(512), "\ud800".repeat(512), "\ud801".repeat(512)]) {
      const changed = { ...row, prompt };
      yield* sql`UPDATE ardud_kanban_cards SET json = ${JSON.stringify(changed)} WHERE id = ${row.id}`;
      const decoded = yield* store.card(row.id);
      assert.deepStrictEqual(decoded, changed);
      assert.strictEqual(yield* store.card(row.id), decoded);
    }
    const warm = yield* store.decodeCacheStats;
    assert.strictEqual(warm.card!.misses - cold.card!.misses, 3);
    assert.strictEqual(warm.card!.entries, 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "invalidates large cards and discussions on rewrites, replacements and rollback revision reuse",
  () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const originalCard = { ...card(1, "todo"), prompt: "a".repeat(8192) };
      const originalDiscussion = { ...discussion(1), title: "a".repeat(8192) };
      yield* store.putCard(originalCard);
      yield* store.putDiscussion(originalDiscussion);
      const read = Effect.all({
        card: store.card(originalCard.id),
        discussion: store.discussion(originalDiscussion.id),
      });
      const write = (text: string) =>
        Effect.all([
          sql`UPDATE ardud_kanban_cards SET json = ${JSON.stringify({ ...originalCard, prompt: text })} WHERE id = ${originalCard.id}`,
          sql`UPDATE ardud_kanban_discussions SET json = ${JSON.stringify({ ...originalDiscussion, title: text })} WHERE id = ${originalDiscussion.id}`,
        ]);
      const before = yield* read;
      // Every case keeps serialized length and timestamps, including rewriting old text.
      for (const text of ["b".repeat(8192), originalCard.prompt]) {
        yield* write(text);
        const changed = yield* read;
        assert.deepStrictEqual(changed.card, { ...originalCard, prompt: text });
        assert.deepStrictEqual(changed.discussion, { ...originalDiscussion, title: text });
        const warm = yield* read;
        assert.strictEqual(warm.card, changed.card);
        assert.strictEqual(warm.discussion, changed.discussion);
      }
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* write("c".repeat(8192));
            assert.strictEqual((yield* read).card!.prompt, "c".repeat(8192));
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.flip);
      // These writes reuse the rolled-back revisions, with different text.
      yield* write("d".repeat(8192));
      assert.strictEqual((yield* read).card!.prompt, "d".repeat(8192));
      assert.strictEqual((yield* read).discussion!.title, "d".repeat(8192));
      yield* sql`DELETE FROM ardud_kanban_cards WHERE id = ${originalCard.id}`;
      yield* sql`DELETE FROM ardud_kanban_discussions WHERE id = ${originalDiscussion.id}`;
      yield* store.putCard(originalCard);
      yield* store.putDiscussion(originalDiscussion);
      const replaced = yield* read;
      assert.deepStrictEqual(replaced, before);
      yield* sql`INSERT OR REPLACE INTO ardud_kanban_cards (id, board_id, number, stage, json)
      VALUES (${originalCard.id}, ${boardId}, 1, 'todo', ${JSON.stringify({ ...originalCard, prompt: "e".repeat(8192) })})`;
      yield* sql`INSERT OR REPLACE INTO ardud_kanban_discussions (id, board_id, json)
      VALUES (${originalDiscussion.id}, ${boardId}, ${JSON.stringify({ ...originalDiscussion, title: "e".repeat(8192) })})`;
      assert.strictEqual((yield* read).card!.prompt, "e".repeat(8192));
      assert.strictEqual((yield* read).discussion!.title, "e".repeat(8192));
    }).pipe(Effect.provide(TestLayer)),
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

it.effect("slot event windows and open slots keep board, pool and thread identities separate", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const base = {
      boardId: "b",
      poolKey: "p",
      threadId: "t",
      cardId: null,
      at,
      why: "start" as const,
    };
    yield* store.addSlotEvent({ ...base, kind: "take" });
    yield* store.addSlotEvent({ ...base, poolKey: "other", kind: "take" });
    yield* store.addSlotEvent({ ...base, boardId: "other", kind: "take" });
    yield* store.addSlotEvent({ ...base, kind: "release", why: "card_left" });
    yield* store.addSlotEvent({ ...base, threadId: "other", kind: "take" });
    assert.deepStrictEqual(
      (yield* store.openSlots()).map((row) => row.id),
      [2, 3, 5],
    );
    assert.deepStrictEqual(
      (yield* store.openSlots("b")).map((row) => row.id),
      [2, 5],
    );
    assert.deepStrictEqual(
      (yield* store.slotEvents({ boardId: "b", from: at, to: "9999" })).map((row) => row.id),
      [1, 2, 4, 5],
    );
    assert.deepStrictEqual(yield* store.slotEvents({ boardId: "b", from: "", to: at }), []);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("readiness carry-in selects the latest wait and stall markers by board and cutoff", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    yield* store.putBoard(board);
    const cutoff = "2026-11-12T02:00:00.000Z";
    const cases = [
      { kind: "edited", body: "Waiting for CI", wait: true, clears: true },
      { kind: "edited", body: "Wait ended: cleared", wait: true, clears: false },
      { kind: "edited", body: "Wait expired: CI", wait: true, clears: false },
      { kind: "wait_set", body: null, wait: true, clears: true },
      { kind: "wait_cleared", body: null, wait: true, clears: false },
      { kind: "wait_expired", body: null, wait: true, clears: false },
      { kind: "flagged", body: "Cleared", wait: false, clears: true },
      { kind: "moved", body: null, wait: false, clears: true },
      { kind: "review", body: null, wait: false, clears: true },
      { kind: "thread", body: null, wait: false, clears: true },
      { kind: "edited", body: "waiting for CI", wait: false, clears: false },
      { kind: "edited", body: "Waitingfor CI", wait: false, clears: false },
    ] as const;
    const expected: number[] = [];
    for (const [index, entry] of cases.entries()) {
      const current = card(index + 1, "todo");
      yield* store.putCard(current);
      const base = {
        cardId: current.id,
        actor: { _tag: "owner" as const },
        head: null,
        fromStage: null,
        toStage: null,
      };
      const flag = yield* store.addCardEvent({
        ...base,
        at: "2026-11-12T00:00:00.000Z",
        kind: "flagged",
        body: "Run failed: error",
      });
      const marker = yield* store.addCardEvent({
        ...base,
        at: "2026-11-12T01:00:00.000Z",
        kind: entry.kind,
        body: entry.body,
        ...(entry.kind === "thread"
          ? { fromStage: "todo" as const, toStage: "working" as const }
          : {}),
      });
      yield* store.addCardEvent({
        ...base,
        at: "2026-11-12T01:30:00.000Z",
        kind: "comment",
        body: "Unrelated",
      });
      yield* store.addCardEvent({ ...base, at: cutoff, kind: "wait_set", body: null });
      if (!entry.clears) expected.push(flag.id);
      if (entry.wait || entry.clears) expected.push(marker.id);
    }
    const otherBoard = { ...board, id: KanbanBoardId.make("other"), slug: "other" };
    yield* store.putBoard(otherBoard);
    const other = { ...card(100, "todo"), boardId: otherBoard.id };
    yield* store.putCard(other);
    yield* store.addCardEvent({
      cardId: other.id,
      actor: { _tag: "owner" },
      at: at,
      kind: "wait_set",
      body: null,
      fromStage: null,
      toStage: null,
      head: null,
    });
    assert.deepStrictEqual(
      (yield* store.activityHistory(boardId, { since: cutoff, until: "9999" })).map(
        (event) => event.id,
      ),
      expected,
    );
    assert.deepStrictEqual(
      yield* store.activityHistory(boardId, { since: "1900", until: "9999" }),
      [],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "activity history carries stages without window events and finds the first later transition",
  () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      yield* store.putBoard(board);
      const current = card(1, "working");
      yield* store.putCard(current);
      const base = {
        cardId: current.id,
        actor: { _tag: "owner" as const },
        head: null,
        body: null,
      };
      const prior = yield* store.addCardEvent({
        ...base,
        at: "2026-11-11T23:00:00.000Z",
        kind: "created",
        fromStage: null,
        toStage: "todo",
      });
      const flag = yield* store.addCardEvent({
        ...base,
        at: "2026-11-11T23:30:00.000Z",
        kind: "flagged",
        fromStage: null,
        toStage: null,
        body: "Cleared",
      });
      const later = yield* store.addCardEvent({
        ...base,
        at: "2026-11-12T04:00:00.000Z",
        kind: "moved",
        fromStage: "todo",
        toStage: "working",
      });
      yield* store.addCardEvent({
        ...base,
        at: "2026-11-12T05:00:00.000Z",
        kind: "moved",
        fromStage: "working",
        toStage: "completed",
      });
      const window = { since: "2026-11-12T00:00:00.000Z", until: "2026-11-12T03:00:00.000Z" };
      assert.deepStrictEqual(yield* store.boardEvents(boardId, window.since, window.until), []);
      assert.deepStrictEqual(
        (yield* store.activityHistory(boardId, window)).map((event) => event.id),
        [prior.id, flag.id, later.id],
      );
      assert.deepStrictEqual(
        (yield* store.activityHistory(boardId, { ...window, until: later.at })).map(
          (event) => event.id,
        ),
        [prior.id, flag.id, later.id],
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("slot history reads carry-in and the window together, including closed slots", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const base = { boardId: "b", poolKey: "p", threadId: "t", cardId: null, why: "start" as const };
    const add = (
      patch: Partial<KanbanStore.SlotEvent> & Pick<KanbanStore.SlotEvent, "at" | "kind">,
    ) => store.addSlotEvent({ ...base, ...patch });
    const from = "2026-11-12T01:00:00.000Z",
      to = "2026-11-12T03:00:00.000Z";
    yield* add({ kind: "take", at: "2026-11-12T00:00:00.000Z" });
    yield* add({ kind: "release", at: "2026-11-12T00:30:00.000Z" });
    yield* add({ kind: "take", at: "2026-11-12T00:45:00.000Z", threadId: "held" });
    yield* add({ kind: "take", at: "2026-11-12T00:00:00.000Z", boardId: "other" });
    yield* add({ kind: "take", at: from });
    yield* add({ kind: "release", at: from, threadId: "held" });
    yield* add({ kind: "release", at: to });
    const history = yield* store.slotHistory({ boardId: "b", from, to });
    assert.deepStrictEqual(
      history.events.map((event) => event.id),
      [2, 3, 5, 6],
    );
    assert.strictEqual(history.recordedSince, "2026-11-12T00:00:00.000Z");
    assert.deepStrictEqual(yield* store.slotHistory({ boardId: "absent", from, to }), {
      events: [],
      recordedSince: null,
    });
  }).pipe(Effect.provide(TestLayer)),
);

// Event counts use ledger order; boundary samples use the last count at that
// instant, so a release on the hour cannot carry the previous hour's peak in.
const hourlySlotQuery = `
WITH RECURSIVE bounds(board,from_at,to_at) AS (VALUES (?,?,?)), hours(at) AS (SELECT from_at FROM bounds WHERE from_at<to_at UNION ALL SELECT strftime('%Y-%m-%dT%H:00:00.000Z',at,'+1 hour') FROM hours,bounds WHERE strftime('%Y-%m-%dT%H:00:00.000Z',at,'+1 hour')<to_at), counts AS (SELECT id,pool_key,at,SUM(CASE kind WHEN 'take' THEN 1 ELSE -1 END) OVER (PARTITION BY pool_key ORDER BY id ROWS UNBOUNDED PRECEDING) AS used FROM ardud_kanban_slot_events,bounds WHERE board_id=board AND at<to_at), samples AS (SELECT pool_key,at,used FROM counts,bounds WHERE at>=from_at UNION ALL SELECT p.pool_key,h.at,COALESCE((SELECT c.used FROM counts c WHERE c.pool_key=p.pool_key AND c.at<=h.at ORDER BY c.id DESC LIMIT 1),0) FROM (SELECT DISTINCT pool_key FROM counts) p CROSS JOIN hours h)
SELECT strftime('%Y-%m-%dT%H:00:00.000Z',at) AS hour,pool_key,MAX(used) AS peak_slots FROM samples GROUP BY hour,pool_key ORDER BY hour,pool_key;
`;

const hourlySlotCases = [
  {
    name: "take before release at the same millisecond preserves peak two",
    events: [
      ["take", "t1", "00:00:00.000"],
      ["take", "t2", "00:00:00.001"],
      ["release", "t1", "00:00:00.001"],
    ],
    expected: [
      [0, "p", 2],
      [1, "p", 1],
      [2, "p", 1],
      [3, "p", 1],
    ],
  },
  {
    name: "release before take at the same millisecond stays at peak one",
    events: [
      ["take", "t1", "00:00:00.000"],
      ["release", "t1", "00:00:00.001"],
      ["take", "t2", "00:00:00.001"],
    ],
    expected: [
      [0, "p", 1],
      [1, "p", 1],
      [2, "p", 1],
      [3, "p", 1],
    ],
  },
  {
    name: "take and release at one instant still count in that hour",
    events: [
      ["take", "t1", "01:30:00.000"],
      ["release", "t1", "01:30:00.000"],
    ],
    expected: [
      [0, "p", 0],
      [1, "p", 1],
      [2, "p", 0],
      [3, "p", 0],
    ],
  },
  {
    name: "multiple takes and releases sharing an hour boundary preserve every intermediate count",
    events: [
      ["take", "t1", "00:30:00.000"],
      ["take", "t2", "01:00:00.000"],
      ["take", "t3", "01:00:00.000"],
      ["release", "t1", "01:00:00.000"],
      ["release", "t2", "01:00:00.000"],
    ],
    expected: [
      [0, "p", 1],
      [1, "p", 3],
      [2, "p", 1],
      [3, "p", 1],
    ],
  },
  {
    name: "releases on an hour boundary do not carry the previous peak into the new hour",
    events: [
      ["take", "t1", "00:30:00.000"],
      ["take", "t2", "00:30:00.001"],
      ["release", "t1", "01:00:00.000"],
      ["release", "t2", "01:00:00.000"],
    ],
    expected: [
      [0, "p", 2],
      [1, "p", 1],
      [2, "p", 0],
      [3, "p", 0],
    ],
  },
  {
    name: "carry-in uses the final event before the range and includes unchanged hours",
    events: [
      ["take", "t1", "00:00:00.000"],
      ["take", "t2", "00:00:00.000"],
      ["release", "t1", "00:00:00.000"],
    ],
    from: "01:00:00.000",
    expected: [
      [1, "p", 1],
      [2, "p", 1],
      [3, "p", 1],
    ],
  },
  {
    name: "range start is inclusive and end is exclusive",
    events: [
      ["take", "t1", "00:00:00.000"],
      ["take", "t2", "04:00:00.000"],
    ],
    expected: [
      [0, "p", 1],
      [1, "p", 1],
      [2, "p", 1],
      [3, "p", 1],
    ],
  },
  {
    name: "pools stay separate and other boards do not affect carry-in or peaks",
    events: [
      ["take", "t1", "00:00:00.000"],
      ["take", "t2", "00:00:00.000", "q"],
      ["take", "t3", "00:00:00.000", "p", "other"],
      ["take", "t4", "00:00:00.000", "unrelated", "other"],
    ],
    expected: [
      [0, "p", 1],
      [0, "q", 1],
      [1, "p", 1],
      [1, "q", 1],
      [2, "p", 1],
      [2, "q", 1],
      [3, "p", 1],
      [3, "q", 1],
    ],
  },
  { name: "an empty ledger has no pools", events: [], expected: [] },
] satisfies ReadonlyArray<{
  readonly name: string;
  readonly events: ReadonlyArray<
    readonly [
      kind: "take" | "release",
      threadId: string,
      at: string,
      poolKey?: string,
      boardId?: string,
    ]
  >;
  readonly from?: string;
  readonly expected: ReadonlyArray<readonly [hour: number, poolKey: string, peak: number]>;
}>;

it.effect.each(hourlySlotCases)("hourly slot peaks: $name", ({ events, expected, from }) =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const sql = yield* BoardsDatabase.client;
    for (const [kind, threadId, time, poolKey = "p", boardId = "b"] of events) {
      yield* store.addSlotEvent({
        kind,
        threadId,
        at: `2026-11-13T${time}Z`,
        poolKey,
        boardId,
        cardId: null,
        why: kind === "take" ? "start" : "card_left",
      });
    }
    const rows = yield* sql.unsafe<{ hour: string; pool_key: string; peak_slots: number }>(
      hourlySlotQuery,
      ["b", `2026-11-13T${from ?? "00:00:00.000"}Z`, "2026-11-13T04:00:00.000Z"],
    );
    assert.deepStrictEqual(
      rows,
      expected.map(([hour, pool_key, peak_slots]) => ({
        hour: `2026-11-13T${String(hour).padStart(2, "0")}:00:00.000Z`,
        pool_key,
        peak_slots,
      })),
    );
  }).pipe(Effect.provide(TestLayer)),
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
      const exceptions = (["completed", "deployed", "verified", "needs_owner"] as const).flatMap(
        (stage, index) => {
          const base = 20 + index * 10;
          return [
            { ...card(base, stage), wait },
            { ...card(base + 1, stage), deciding: { since: at, why: "Pending", toldAt: null } },
            { ...card(base + 2, stage), activeThreadId: ThreadId.make(`held-${stage}`), wait },
          ];
        },
      );
      const settled = [...rows, ...exceptions].map((row, index) => ({
        ...row,
        id: KanbanCardId.make(`settled-${index}`),
        number: 100 + index,
        settledAt: at,
      }));
      yield* Effect.forEach([...rows, ...exceptions, ...settled], (row) => store.putCard(row), {
        discard: true,
      });
      const queries: string[] = [];
      const observe: Statement.Transformer = (statement) => {
        queries.push(statement.compile()[0]);
        return Effect.succeed(statement);
      };
      assert.deepStrictEqual(
        yield* store
          .dispatchCards(boardId)
          .pipe(Effect.provideService(Statement.CurrentTransformer, observe)),
        [...rows.slice(0, 7), ...exceptions],
      );
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${queries[0]}`, [
        boardId,
        boardId,
      ]);
      assert.isTrue(plan.some((row) => row.detail.includes("ardud_kanban_cards_dispatch")));
      assert.isTrue(plan.some((row) => row.detail.includes("ardud_kanban_cards_open")));
      assert.isFalse(plan.some((row) => /SCAN |TEMP B-TREE/.test(row.detail)));
      yield* store.putCard({ ...rows[7]!, stage: "todo" });
      yield* store.putCard({ ...rows[0]!, stage: "verified" });
      assert.deepStrictEqual(
        (yield* store.dispatchCards(boardId)).map((row) => row.number),
        [2, 3, 4, 5, 6, 7, 8, ...exceptions.map((row) => row.number)],
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

it.effect(
  "poolThreadIds counts distinct active threads across work and review without decoding history",
  () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      for (const [index, pool, thread, role] of [
        [1, "pool", "worker", "work"],
        [2, "pool", "worker", "work"],
        [3, "pool", "reviewer", "review"],
        [4, "other-pool", "elsewhere", "work"],
        [5, "pool", null, null],
      ] as const)
        yield* store.putCard({
          ...card(index, "working"),
          activePool: pool,
          activeThreadId: thread === null ? null : ThreadId.make(thread),
          activeRole: role,
        });
      assert.sameMembers(
        [...(yield* store.poolThreadIds(boardId, "pool"))],
        ["worker", "reviewer"],
      );
      assert.deepEqual(yield* store.poolThreadIds(boardId, "missing"), []);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "claimCards keeps seeds and recursive blockers while omitting unrelated history and ending cycles",
  () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const seed = card(1, "needs_review");
      const todo = { ...card(2, "todo"), blockedBy: [card(3, "completed").id] };
      const blocker = { ...card(3, "completed"), blockedBy: [card(4, "needs_owner").id] };
      const ancestor = { ...card(4, "needs_owner"), blockedBy: [blocker.id] };
      for (const row of [seed, todo, blocker, ancestor, card(5, "completed"), card(6, "deployed")])
        yield* store.putCard(row);
      assert.deepEqual(
        (yield* store.claimCards(boardId, [seed.id])).map((row) => row.id),
        [seed.id, todo.id, blocker.id, ancestor.id],
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect.each([
  "urgency",
  "fanout",
  "aging",
  "waiting",
  "deciding",
  "completed blocker",
  "legacy",
  "cycle",
] as const)("compact claim ranking matches the whole board for %s", (kind) =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const threadId = ThreadId.make("worker");
    const seed = { ...card(1, "needs_review"), workThreadId: threadId };
    const blocker = { ...card(2, "todo"), priority: 4, movedAt: "2026-10-24T13:00:00.000Z" };
    const rivals = [3, 4, 5, 6].map((n) => ({ ...card(n, "todo"), priority: 2 }));
    const waiter = { ...card(7, "needs_owner"), priority: 1, blockedBy: [blocker.id] };
    const history = {
      ...card(8, "verified"),
      updatedAt: "2026-11-05T13:00:00.000Z",
      prompt: "x".repeat(10000),
      description: "x".repeat(10000),
    };
    const cards = [seed, blocker, ...rivals, history];
    if (kind === "urgency") cards.push(waiter);
    if (kind === "fanout") {
      blocker.priority = 3;
      for (let n = 10; n < 21; n++)
        cards.push({ ...card(n, "needs_owner"), priority: 3, blockedBy: [blocker.id] });
    }
    if (kind === "waiting")
      Object.assign(blocker, {
        wait: {
          on: "time",
          until: "2026-12-01T00:00:00.000Z",
          at,
          note: "Wait",
          by: { _tag: "owner" },
          script: null,
          args: null,
          pr: null,
          card: null,
          ask: null,
          sinceHead: null,
          wakeRole: null,
          expiredAt: null,
          status: null,
          lastCheckedAt: null,
          failures: 0,
          problem: null,
        },
      });
    if (kind === "deciding")
      Object.assign(blocker, { deciding: { since: at, why: "Wake", toldAt: null } });
    if (kind === "completed blocker") {
      const completed = { ...card(9, "completed"), movedAt: "2026-11-05T13:00:00.000Z" };
      blocker.blockedBy = [completed.id];
      cards.push(completed);
    }
    if (kind === "cycle") {
      blocker.blockedBy = [waiter.id];
      cards.push(waiter);
    }
    for (const row of cards) yield* store.putCard(row);
    if (kind === "legacy") {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE ardud_kanban_cards SET json = json_remove(json, '$.subtasks') WHERE board_id = ${boardId}`;
    }
    const scoped = yield* store.claimCards(boardId, [seed.id]);
    const metadata = yield* store.schedulingCards(boardId);
    const base = {
      board,
      groups: [
        {
          id: "related",
          name: "related",
          summary: "",
          updatedAt: at,
          cardIds: [seed.id, blocker.id, ...rivals.map((row) => row.id)],
        },
      ],
      seeds: [seed],
      threadId,
      pool: Rules.poolKey(model),
      projectId: null,
      carrying: 0,
      slots: 1,
    };
    const expected = Rules.relatedCandidates({ ...base, cards }).map(({ card }) => card.id);
    const actual = Rules.relatedCandidates({ ...base, cards: scoped, rankingCards: metadata }).map(
      ({ card }) => card.id,
    );
    assert.deepEqual(actual, expected);
    assert.deepEqual(kanbanSchedule(metadata), kanbanSchedule(cards));
    assert.deepEqual(
      [...cards].sort(kanbanPickOrder(metadata)),
      [...cards].sort(kanbanPickOrder(cards)),
    );
    assert.notInclude(JSON.stringify(metadata), "prompt");
    assert.notInclude(JSON.stringify(metadata), "description");
    if (kind === "urgency") assert.equal(actual[0], blocker.id);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect.each([false, true])(
  "#1603 script reply obligations require a card discussion (%s)",
  (onCard) =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const talk = { ...discussion(1603), cardId: onCard ? KanbanCardId.make("card-1603") : null };
      const evaluator = ThreadId.make("eval-1603");
      yield* store.putDiscussion(talk);
      const message: KanbanMessage = {
        discussionId: talk.id,
        seq: 1,
        author: { _tag: "script", scriptId: KanbanScriptId.make("script-1603") },
        authorName: "Sweep",
        blocks: [{ _tag: "md", text: "Question" }],
        answers: [],
        createdAt: at,
      };
      yield* store.putMessage(message);
      assert.isNull(yield* store.ownerWait(talk.id));
      assert.strictEqual((yield* store.ownerWait(talk.id, true))?.seq, 1);
      assert.strictEqual(
        (yield* store.ownerReply(talk.id, evaluator, true))?.answered ?? null,
        onCard ? false : null,
      );
      yield* store.putMessage({
        ...message,
        seq: 2,
        author: { _tag: "evaluator", threadId: ThreadId.make("other-evaluator") },
      });
      assert.strictEqual((yield* store.ownerWait(talk.id, true))?.answered, true);
      assert.strictEqual(
        (yield* store.ownerReply(talk.id, evaluator, true))?.answered ?? null,
        onCard ? true : null,
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect.each(
  (["owner", "script"] as const).flatMap((author) =>
    [false, true].map((answered) => ({ author, answered })),
  ),
)("#1603 a retained $author post keeps its own answer state ($answered)", ({ author, answered }) =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const talk = { ...discussion(1604), cardId: KanbanCardId.make("card-1604") };
    yield* store.putDiscussion(talk);
    const message: KanbanMessage = {
      discussionId: talk.id,
      seq: 1,
      author:
        author === "owner"
          ? { _tag: "owner" }
          : { _tag: "script", scriptId: KanbanScriptId.make("script-1603") },
      authorName: author,
      blocks: [{ _tag: "md", text: "Original" }],
      answers: [],
      createdAt: at,
    };
    yield* store.putMessage(message);
    if (answered)
      yield* store.putMessage({
        ...message,
        seq: 2,
        author: { _tag: "evaluator", threadId: ThreadId.make("answering-1603") },
      });
    yield* store.putMessage({ ...message, seq: 3 });
    assert.deepStrictEqual(yield* store.ownerWait(talk.id, true, 1), {
      seq: 1,
      createdAt: at,
      answered,
    });
    assert.deepStrictEqual(yield* store.ownerWait(talk.id, true), {
      seq: 3,
      createdAt: at,
      answered: false,
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("caller analytics is a memory lookup and follows card and link writes", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const current = card(4336, "working");
    const id = ThreadId.make("worker-4336");
    yield* store.putCard(current);
    yield* store.putThreadLink({
      threadId: id,
      boardId,
      cardId: current.id,
      role: "work",
      purpose: null,
      discussionId: null,
      model,
      startedAt: at,
      endedAt: null,
      paused: null,
    });
    const queries: string[] = [];
    const observe: Statement.Transformer = (statement) => {
      queries.push(statement.compile()[0]);
      return Effect.succeed(statement);
    };
    const context = yield* Effect.sync(() => store.callerAnalytics!(id)).pipe(
      Effect.provideService(Statement.CurrentTransformer, observe),
    );
    assert.deepEqual(context, {
      boardId,
      cardId: current.id,
      cardNumber: 4336,
      cardStage: "working",
      callerRole: "work",
    });
    assert.deepEqual(queries, []);
    store.registerCallerParent!("plain-child", "plain-parent");
    assert.deepEqual(store.callerAnalytics!("plain-child"), {
      callerRole: "none",
      callerKind: "delegated_child",
    });
    store.registerCallerParent!("child", id);
    assert.deepEqual(store.callerAnalytics!("child"), {
      ...context,
      callerRole: "work",
      callerKind: "delegated_child",
    });
    const sql = yield* SqlClient.SqlClient;
    yield* store
      .observeCallerWrites(
        sql.withTransaction(
          store
            .putCard({ ...current, stage: "needs_review" })
            .pipe(Effect.andThen(Effect.fail("rollback"))),
        ),
      )
      .pipe(Effect.exit);
    assert.equal(store.callerAnalytics!(id)?.cardStage, "working");
    yield* store.observeCallerWrites(
      sql.withTransaction(store.putCard({ ...current, stage: "needs_review" })),
    );
    assert.equal(store.callerAnalytics!(id)?.cardStage, "needs_review");
    const reopened = Context.get(
      yield* Layer.build(
        Layer.fresh(KanbanStore.layer).pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
      ),
      KanbanStore.KanbanStore,
    );
    assert.equal(reopened.callerAnalytics!(id)?.cardStage, "needs_review");
    assert.deepEqual(reopened.callerAnalytics!("plain"), {
      callerRole: "none",
      callerKind: "plain_thread",
    });
    const cold = Context.get(
      yield* Layer.build(
        Layer.fresh(KanbanStore.layer).pipe(
          Layer.provide(
            Layer.succeed(BoardsDatabase.BoardsDatabase, {
              sql,
              path: "cold-test",
              ready: Effect.never,
            }),
          ),
        ),
      ),
      KanbanStore.KanbanStore,
    );
    assert.deepEqual(cold.callerAnalytics!("not-loaded-yet"), {
      callerRole: "none",
      callerKind: "unknown",
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect.each(["work", "review", "evaluator", "discussion"] as const)(
  "delegated children inherit the resolved %s role without queries",
  (role) =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const current = card(4336, "working");
      yield* store.putCard(current);
      yield* store.putThreadLink({
        threadId: ThreadId.make("parent"),
        boardId,
        cardId: current.id,
        role: role === "discussion" ? "evaluator" : role,
        purpose: null,
        discussionId: role === "discussion" ? KanbanDiscussionId.make("card-discussion") : null,
        model,
        startedAt: at,
        endedAt: null,
        paused: null,
      });
      store.registerCallerParent!("child", "parent");
      store.registerCallerParent!("grandchild", "child");
      const queries: string[] = [];
      const observe: Statement.Transformer = (statement) => {
        queries.push(statement.compile()[0]);
        return Effect.succeed(statement);
      };
      yield* Effect.sync(() => {
        for (const id of ["child", "grandchild"])
          assert.deepEqual(store.callerAnalytics!(id), {
            boardId,
            cardId: current.id,
            cardNumber: current.number,
            cardStage: current.stage,
            callerRole: role,
            callerKind: "delegated_child",
          });
      }).pipe(Effect.provideService(Statement.CurrentTransformer, observe));
      assert.deepEqual(queries, []);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("reopened caller attribution follows nested subagents and stops at forks", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const sql = yield* SqlClient.SqlClient;
    for (const [id, number] of [
      ["worker", 4336],
      ["own-fork", 4339],
    ] as const) {
      const current = card(number, "working");
      yield* store.putCard(current);
      yield* store.putThreadLink({
        threadId: ThreadId.make(id),
        boardId,
        cardId: current.id,
        role: "work",
        purpose: null,
        discussionId: null,
        model,
        startedAt: at,
        endedAt: null,
        paused: null,
      });
    }
    for (const [id, parent, relationship, deleted] of [
      ["child", "worker", "subagent", false],
      ["grandchild", "child", "subagent", false],
      ["plain-fork", "worker", "fork", false],
      ["fork-child", "plain-fork", "subagent", false],
      ["fork-grandchild", "fork-child", "subagent", false],
      ["own-fork", "worker", "fork", false],
      ["own-child", "own-fork", "subagent", false],
      ["own-grandchild", "own-child", "subagent", false],
      ["legacy", "worker", "legacy", false],
      ["legacy-grandchild", "legacy", "subagent", false],
      ["explicit-root", "worker", "root", false],
      ["root-grandchild", "explicit-root", "subagent", false],
      ["cycle-a", "cycle-b", "subagent", false],
      ["cycle-b", "cycle-a", "subagent", false],
      ["deleted-parent", "worker", "subagent", true],
      ["deleted-grandchild", "deleted-parent", "subagent", false],
    ] as const) {
      const payload = {
        ...(relationship === "legacy"
          ? {}
          : {
              lineage: {
                parentThreadId: relationship === "root" ? null : parent,
                relationshipToParent: relationship === "root" ? null : relationship,
                rootThreadId: "worker",
              },
            }),
        forkedFrom: { type: "run", threadId: parent },
      };
      yield* sql`INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json, deleted_at
      ) VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default',
        ${at}, ${at}, ${JSON.stringify(payload)}, ${deleted ? "2026-11-14T00:00:00.000Z" : null})`;
    }
    const reopened = Context.get(
      yield* Layer.build(
        Layer.fresh(KanbanStore.layer).pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
      ),
      KanbanStore.KanbanStore,
    );
    const queries: string[] = [];
    const observe: Statement.Transformer = (statement) => {
      queries.push(statement.compile()[0]);
      return Effect.succeed(statement);
    };
    yield* Effect.sync(() => {
      for (const [id, number] of [
        ["grandchild", 4336],
        ["fork-grandchild", undefined],
        ["own-grandchild", 4339],
        ["legacy-grandchild", 4336],
        ["root-grandchild", undefined],
        ["cycle-a", undefined],
        ["deleted-grandchild", undefined],
      ] as const) {
        const context = reopened.callerAnalytics!(id);
        assert.equal(context?.callerRole, number === undefined ? "none" : "work", id);
        assert.equal(context?.callerKind, "delegated_child", id);
        assert.equal(context?.cardNumber, number, id);
        assert.equal(context?.cardStage, number === undefined ? undefined : "working", id);
      }
      assert.equal(reopened.callerAnalytics!("plain-fork")?.callerRole, "none");
      assert.equal(reopened.callerAnalytics!("own-fork")?.callerRole, "work");
    }).pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    assert.deepEqual(queries, []);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect.each(["rekey", "selection"] as const)(
  "%s caller metadata waits for the enclosing commit",
  (mode) =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const current = card(4336, "working");
      const id = ThreadId.make("bulk-worker");
      const link = {
        threadId: id,
        boardId,
        cardId: current.id,
        role: "work" as const,
        purpose: null,
        discussionId: null,
        model,
        startedAt: at,
        endedAt: null,
        paused: null,
      };
      yield* store.putCard(current);
      yield* store.putThreadLink(link);
      const before = store.callerAnalytics!(id);
      const watched = yield* store.watchCardWrites(boardId);
      const changed = card(4336, "needs_review");
      const bulk =
        mode === "rekey"
          ? store.rekeyBoard(boardId, [], [changed])
          : store.migrateBoardSelections({
              board,
              pools: [],
              oldPoolKeys: [],
              cards: [changed],
              threadLinks: [{ ...link, role: "review" }],
            });
      const rolledBack = yield* store
        .observeCallerWrites(
          sql.withTransaction(
            bulk.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  assert.deepEqual(store.callerAnalytics!(id), before);
                  assert.deepEqual([...watched], [current.id]);
                }),
              ),
              Effect.andThen(Effect.fail("rollback")),
            ),
          ),
        )
        .pipe(Effect.exit);
      assert.equal(rolledBack._tag, "Failure");
      assert.deepEqual(store.callerAnalytics!(id), before);
      assert.equal((yield* store.card(current.id))?.stage, "working");
      assert.equal((yield* store.threadLink(id))?.role, "work");
      if (mode === "selection") {
        yield* store.observeCallerWrites(sql.withTransaction(bulk));
        assert.equal(store.callerAnalytics!(id)?.cardStage, "needs_review");
        assert.equal(store.callerAnalytics!(id)?.callerRole, "review");
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("#1569 owner choices use their answer time, and a later evaluator clears them", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const talk = discussion(1569);
    const evaluator = ThreadId.make("eval-1569");
    const other = ThreadId.make("other-eval-1569");
    const question: KanbanMessage = {
      discussionId: talk.id,
      seq: 1,
      author: { _tag: "evaluator", threadId: evaluator },
      authorName: "Evaluator",
      blocks: [{ _tag: "md", text: "Ship?" }],
      answers: [],
      createdAt: at,
    };
    yield* store.putDiscussion(talk);
    yield* store.putMessage(question);
    assert.isNull(yield* store.ownerReply(talk.id, evaluator, true));
    const answerAt = "2026-10-25T14:00:00.000Z";
    yield* store.putMessage({
      ...question,
      answers: [{ blockId: "q1", by: { _tag: "owner" }, choice: ["o1"], text: null, at: answerAt }],
    });
    const action = yield* store.ownerReply(talk.id, evaluator, true);
    assert.deepStrictEqual(action, {
      key: `1:q1:${answerAt}`,
      createdAt: answerAt,
      answered: false,
    });
    yield* store.putMessage({
      ...question,
      seq: 2,
      author: { _tag: "evaluator", threadId: other },
      createdAt: answerAt,
    });
    assert.strictEqual((yield* store.ownerReply(talk.id, evaluator, true))?.answered, true);
    assert.strictEqual((yield* store.ownerReply(talk.id, evaluator, false))?.answered, false);
    yield* store.putMessage({
      ...question,
      seq: 3,
      author: { _tag: "owner" },
      createdAt: "2026-10-25T15:00:00.000Z",
    });
    assert.strictEqual((yield* store.ownerReply(talk.id, evaluator, true))?.answered, false);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect.each([false, true])(
  "saved analytics publishes after an outer transaction commits (rollback=%s)",
  (rollback) =>
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const state: McpCall.McpCall["Service"] = {
        callerResolved: true,
        callerResolveMs: 0,
        readerLane: "foreground",
        phase: "handler",
        boardWrite: true,
        saved: false,
      };
      yield* sql`CREATE TABLE saved_probe (value INTEGER)`;
      const write = Effect.gen(function* () {
        yield* SavedWrite.committing;
        yield* sql`INSERT INTO saved_probe VALUES (1)`;
        yield* SavedWrite.committed();
        assert.strictEqual(state.saved, "unknown");
        if (rollback) return yield* Effect.fail("rollback");
      });
      yield* store
        .observeCallerWrites(sql.withTransaction(write))
        .pipe(Effect.provideService(McpCall.McpCall, state), Effect.exit);
      const rows = yield* sql`SELECT * FROM saved_probe`;
      assert.lengthOf(rows, rollback ? 0 : 1);
      assert.strictEqual(state.saved, rollback ? "unknown" : true);
    }).pipe(Effect.provide(TestLayer)),
);
