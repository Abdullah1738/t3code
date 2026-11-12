import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  KanbanBoardId,
  KanbanCardId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type KanbanBoard,
  type KanbanCard,
  type KanbanPool,
  type KanbanThreadLink,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ServerConfig from "../../../config.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import { kanbanDDL } from "../../persistence/kanbanSchema.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import { KanbanService, layer as kanbanLayer } from "./KanbanService.ts";
import { planCutoverCardRestore } from "./cutoverCards.ts";
import * as KanbanModels from "./models.ts";
import * as Rules from "./rules.ts";
import { KanbanThreads, type KanbanThreadsShape, type KanbanThreadView } from "./threads.ts";

const at = "2026-11-05T00:00:00.000Z";
const later = "2026-11-05T01:00:00.000Z";
const work: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
const review: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "xhigh" }],
};
const worker = ThreadId.make("existing-worker");
const reviewer = ThreadId.make("existing-reviewer");
const board: KanbanBoard = {
  id: KanbanBoardId.make("cutover"),
  slug: "cutover",
  name: "Cutover",
  icon: null,
  iconImage: null,
  defaultProjectId: ProjectId.make("project-1"),
  managerModel: work,
  evaluatorModel: work,
  defaultCardModel: work,
  reviewChains: [{ name: "two-step", steps: [work, review] }],
  defaultReviewChain: "two-step",
  instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
  setup: null,
  pause: { reason: "Harness cutover", keep: [], at, by: "owner" },
  createdAt: at,
  archivedAt: null,
};
const stopped: KanbanCard = {
  id: KanbanCardId.make("card-1"),
  boardId: board.id,
  number: 1,
  title: "Preserve this work",
  description: "Existing branch and pending owner asks stay put",
  prompt: "Continue",
  subtasks: [],
  subtaskSeq: 0,
  stage: "todo",
  priority: 2,
  goalId: null,
  projects: [],
  model: work,
  models: [{ model: work, weight: 3 }],
  projectId: board.defaultProjectId,
  links: [
    {
      kind: "pr",
      url: "https://github.com/example/repo/pull/1",
      label: "Existing branch",
      state: "open",
      checkedAt: at,
    },
  ],
  blockedBy: [],
  stalled: { reason: "Stopped for cutover", by: { _tag: "owner" }, at },
  question: null,
  asks: [
    {
      id: "q1",
      text: "Ship this?",
      blocking: false,
      by: { _tag: "thread", threadId: worker },
      at,
      seq: null,
      closedAt: null,
    },
  ],
  reviewChain: "two-step",
  reviewStep: 1,
  reviewRound: 2,
  activeThreadId: null,
  activeRole: null,
  activePool: null,
  workThreadId: worker,
  reviewThreadId: reviewer,
  discussionId: null,
  wakeNote: "Keep this context",
  nudgedAt: null,
  settledAt: null,
  createdBy: { _tag: "owner" },
  createdAt: at,
  updatedAt: at,
  movedAt: at,
};
const link = (role: "work" | "review" = "work"): KanbanThreadLink => ({
  threadId: role === "work" ? worker : reviewer,
  boardId: board.id,
  cardId: stopped.id,
  role,
  purpose: null,
  discussionId: null,
  model: role === "work" ? work : review,
  startedAt: at,
  endedAt: at,
  paused: { at, message: "Old outage", runId: null },
});
const pool = (model: ModelSelection, slots = 1): KanbanPool => ({
  key: Rules.poolKey(model),
  model,
  slots,
});
const fixture = (overrides: Partial<Parameters<typeof planCutoverCardRestore>[0]> = {}) => ({
  restore: { cardId: stopped.id, threadId: worker, stage: "working" as const },
  board,
  card: stopped,
  link: link(),
  threadCards: [stopped.id],
  cards: [stopped],
  pools: [pool(work), pool(review)],
  holds: new Map<string, string>(),
  at: later,
  ...overrides,
});

it("reattaches the recorded worker without changing the packet, asks, or origin link", () => {
  const result = planCutoverCardRestore(fixture());
  assert.isTrue(result.ok);
  if (!result.ok) return;
  assert.strictEqual(result.card.activeThreadId, worker);
  assert.strictEqual(result.card.workThreadId, worker);
  assert.strictEqual(result.card.reviewThreadId, reviewer);
  assert.strictEqual(result.card.activeRole, "work");
  assert.strictEqual(result.card.activePool, Rules.poolKey(work));
  assert.isNull(result.card.stalled);
  assert.deepStrictEqual(result.card.asks, stopped.asks);
  assert.deepStrictEqual(result.card.links, stopped.links);
  assert.deepStrictEqual(result.link, { ...link(), endedAt: null, paused: null });
  assert.deepStrictEqual(board.pause?.keep, []);
  const retry = planCutoverCardRestore(
    fixture({ card: result.card, link: result.link, at: "2026-11-05T02:00:00.000Z" }),
  );
  assert.isTrue(retry.ok);
  if (retry.ok) {
    assert.isFalse(retry.changed);
    assert.strictEqual(retry.card.updatedAt, later);
  }
});

it("restores the exact reviewer to the current chain step, not the worker pool", () => {
  const result = planCutoverCardRestore(
    fixture({
      restore: { cardId: stopped.id, threadId: reviewer, stage: "in_review" },
      link: link("review"),
      pools: [pool(review)],
    }),
  );
  assert.isTrue(result.ok);
  if (!result.ok) return;
  assert.strictEqual(result.card.activeThreadId, reviewer);
  assert.strictEqual(result.card.activeRole, "review");
  assert.strictEqual(result.card.activePool, Rules.poolKey(review));
  assert.strictEqual(result.card.workThreadId, worker);
  assert.strictEqual(result.card.reviewStep, 1);
  assert.deepStrictEqual(result.link.model, review);
});

it("maps a legacy role model to its native pool and refuses a conflicting selection", () => {
  const legacy: ModelSelection = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "opus/claude-opus-5-5",
    options: [{ id: "variant", value: "high" }],
  };
  const result = planCutoverCardRestore(
    fixture({
      card: { ...stopped, model: legacy },
      link: { ...link(), model: legacy },
    }),
  );
  assert.isTrue(result.ok);
  if (result.ok) {
    assert.strictEqual(result.card.activePool, Rules.poolKey(work));
    assert.deepStrictEqual(result.link.model, work);
  }
  assert.isFalse(
    planCutoverCardRestore(
      fixture({
        card: { ...stopped, model: { ...legacy, model: `${legacy.model}#max` } },
      }),
    ).ok,
  );
});

it("uses worker history only when the stopped card dropped its worker pointer", () => {
  const card = { ...stopped, workThreadId: null };
  assert.isTrue(planCutoverCardRestore(fixture({ card })).ok);
  assert.isFalse(planCutoverCardRestore(fixture({ card, threadCards: [] })).ok);
  assert.isFalse(
    planCutoverCardRestore(
      fixture({
        card: { ...stopped, workThreadId: ThreadId.make("a-newer-worker") },
      }),
    ).ok,
  );
});

it("refuses live boards, unrelated roles/threads, settled cards and cards not stopped", () => {
  const cases: Array<Partial<Parameters<typeof planCutoverCardRestore>[0]>> = [
    { board: { ...board, pause: null } },
    { board: { ...board, pause: { ...board.pause!, keep: [stopped.id] } } },
    { link: null },
    { link: { ...link(), boardId: KanbanBoardId.make("another-board") } },
    { link: { ...link(), threadId: ThreadId.make("another-thread") } },
    { link: { ...link(), role: "review" } },
    { card: { ...stopped, settledAt: at } },
    { card: { ...stopped, stalled: null } },
    { card: { ...stopped, stage: "needs_owner" } },
    { card: { ...stopped, activeThreadId: ThreadId.make("someone-else") } },
  ];
  for (const entry of cases) assert.isFalse(planCutoverCardRestore(fixture(entry)).ok);
});

it("requires the exact migrated pool and keeps slot limits, counting shared threads once", () => {
  assert.isFalse(planCutoverCardRestore(fixture({ pools: [] })).ok);
  assert.isFalse(planCutoverCardRestore(fixture({ pools: [pool(work, 0)] })).ok);
  assert.isFalse(
    planCutoverCardRestore(fixture({ pools: [{ ...pool(work), key: "opencode/stale-key" }] })).ok,
  );
  const other: KanbanCard = {
    ...stopped,
    id: KanbanCardId.make("card-2"),
    number: 2,
    stage: "working",
    stalled: null,
    activeRole: "work",
    activeThreadId: ThreadId.make("other-worker"),
    activePool: Rules.poolKey(work),
  };
  assert.isFalse(planCutoverCardRestore(fixture({ cards: [stopped, other] })).ok);
  assert.isFalse(
    planCutoverCardRestore(fixture({ holds: new Map([["held-thread", Rules.poolKey(work)]]) })).ok,
  );
  assert.isTrue(
    planCutoverCardRestore(
      fixture({
        cards: [stopped, { ...other, activeThreadId: worker }],
        holds: new Map([[worker, Rules.poolKey(work)]]),
      }),
    ).ok,
  );
  assert.isFalse(
    planCutoverCardRestore(fixture({ holds: new Map([[worker, Rules.poolKey(review)]]) })).ok,
  );
});

const filesLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-cutover-cards-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
);
const threadView = (threadId: ThreadId): KanbanThreadView => ({
  threadId,
  projectId: board.defaultProjectId!,
  title: "Existing branch",
  state: "idle",
  updatedAt: at,
  quietSince: at,
  runStartedAt: null,
  backgroundWork: 0,
  prWatches: 0,
  prs: [],
  archived: false,
});
const separateBoardsLayer = Layer.effect(
  BoardsDatabase.BoardsDatabase,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.forEach(kanbanDDL, (ddl) => sql.unsafe(ddl), { discard: true });
    return BoardsDatabase.BoardsDatabase.of({ sql, ready: Effect.void, path: ":memory:boards" });
  }),
).pipe(Layer.provide(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" }))));
const testLayer = (
  options: {
    readonly exists?: boolean;
    readonly failLinkWrite?: boolean;
    readonly failEventWrite?: boolean;
    readonly separateBoards?: boolean;
    readonly threads?: Partial<KanbanThreadsShape>;
  } = {},
) => {
  const storeLayer =
    options.failLinkWrite || options.failEventWrite
      ? Layer.effect(
          KanbanStore.KanbanStore,
          Effect.map(KanbanStore.KanbanStore, (real) => ({
            ...real,
            putThreadLink: (value: KanbanThreadLink) =>
              options.failLinkWrite && value.endedAt === null
                ? Effect.fail(
                    new KanbanStore.KanbanStoreError({
                      operation: "fixture failure",
                      cause: new Error("link write failed"),
                    }),
                  )
                : real.putThreadLink(value),
            addCardEvent: (event) =>
              real
                .addCardEvent(event)
                .pipe(
                  Effect.flatMap((saved) =>
                    options.failEventWrite
                      ? Effect.fail(
                          new KanbanStore.KanbanStoreError({
                            operation: "event fixture failure",
                            cause: new Error("event write failed"),
                          }),
                        )
                      : Effect.succeed(saved),
                  ),
                ),
          })),
        ).pipe(Layer.provide(KanbanStore.layer))
      : KanbanStore.layer;
  return kanbanLayer.pipe(
    Layer.provideMerge(
      Layer.mock(KanbanThreads)({
        find: (threadId) => Effect.succeed(options.exists === false ? null : threadView(threadId)),
        // Any launch/send/setModel call is an unimplemented mock and fails this test.
        ...options.threads,
      }),
    ),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(options.separateBoards ? separateBoardsLayer : Layer.empty),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([])),
    Layer.provideMerge(filesLayer),
  );
};
const seed = Effect.gen(function* () {
  const store = yield* KanbanStore.KanbanStore;
  yield* store.putBoard(board);
  yield* store.putCard(stopped);
  yield* store.putPool(board.id, pool(work));
  yield* store.putPool(board.id, pool(review));
  yield* store.putThreadLink(link());
  yield* store.putThreadLink(link("review"));
  yield* store.addThreadCard(worker, stopped.id, at);
  return store;
});

it.effect(
  "service restores both roles without creating or messaging threads, and retries once",
  () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const service = yield* KanbanService;
      yield* service.restoreCutoverCard({ cardId: stopped.id, threadId: worker, stage: "working" });
      const first = yield* store.card(stopped.id);
      yield* service.restoreCutoverCard({ cardId: stopped.id, threadId: worker, stage: "working" });
      assert.deepStrictEqual(yield* store.card(stopped.id), first);
      assert.strictEqual((yield* store.cardEvents(stopped.id)).length, 1);
      assert.deepStrictEqual(yield* store.threadLink(worker), {
        ...link(),
        endedAt: null,
        paused: null,
      });
      assert.deepStrictEqual(yield* store.boards, [board]);

      yield* store.putCard(stopped);
      yield* service.restoreCutoverCard({
        cardId: stopped.id,
        threadId: reviewer,
        stage: "in_review",
      });
      const reviewed = yield* store.card(stopped.id);
      assert.strictEqual(reviewed?.activeThreadId, reviewer);
      assert.strictEqual(reviewed?.activePool, Rules.poolKey(review));
      assert.deepStrictEqual(reviewed?.asks, stopped.asks);
      const open = yield* store.threadLinks({ boardId: board.id, open: true });
      assert.deepStrictEqual(
        open.map((entry) => entry.threadId),
        [worker, reviewer],
      );
    }).pipe(Effect.provide(testLayer())),
);

it.effect("a missing existing thread leaves the card and its link untouched", () =>
  Effect.gen(function* () {
    const store = yield* seed;
    const service = yield* KanbanService;
    const error = yield* service
      .restoreCutoverCard({ cardId: stopped.id, threadId: worker, stage: "working" })
      .pipe(Effect.flip);
    assert.strictEqual(error.code, "not-found");
    assert.deepStrictEqual(yield* store.card(stopped.id), stopped);
    assert.deepStrictEqual(yield* store.threadLink(worker), link());
    assert.deepStrictEqual(yield* store.cardEvents(stopped.id), []);
  }).pipe(Effect.provide(testLayer({ exists: false }))),
);

it.effect("card/link/event writes roll back together if the link write fails", () =>
  Effect.gen(function* () {
    const store = yield* seed;
    const service = yield* KanbanService;
    yield* service
      .restoreCutoverCard({ cardId: stopped.id, threadId: worker, stage: "working" })
      .pipe(Effect.flip);
    assert.deepStrictEqual(yield* store.card(stopped.id), stopped);
    assert.deepStrictEqual(yield* store.threadLink(worker), link());
    assert.deepStrictEqual(yield* store.cardEvents(stopped.id), []);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly stage: string;
      readonly active_thread_id: string | null;
    }>`SELECT stage, active_thread_id FROM ardud_kanban_cards WHERE id = ${stopped.id}`;
    assert.deepStrictEqual(rows, [{ stage: "todo", active_thread_id: null }]);
  }).pipe(Effect.provide(testLayer({ failLinkWrite: true }))),
);

it.effect("separate board database rolls back the card when reopening its link fails", () =>
  Effect.gen(function* () {
    const store = yield* seed;
    const service = yield* KanbanService;
    const main = yield* SqlClient.SqlClient;
    const boards = yield* BoardsDatabase.client;
    assert.notStrictEqual(main, boards);
    const mainTables =
      yield* main`SELECT name FROM sqlite_schema WHERE name = 'ardud_kanban_cards'`;
    assert.deepStrictEqual(mainTables, []);
    yield* service
      .restoreCutoverCard({ cardId: stopped.id, threadId: worker, stage: "working" })
      .pipe(Effect.flip);
    assert.deepStrictEqual(yield* store.card(stopped.id), stopped);
    assert.deepStrictEqual(yield* store.threadLink(worker), link());
    assert.deepStrictEqual(yield* store.cardEvents(stopped.id), []);
  }).pipe(Effect.provide(testLayer({ separateBoards: true, failLinkWrite: true }))),
);

it.effect(
  "separate board database rolls back card, link and event after an event write failure",
  () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const service = yield* KanbanService;
      const main = yield* SqlClient.SqlClient;
      assert.notStrictEqual(main, yield* BoardsDatabase.client);
      yield* service
        .restoreCutoverCard({ cardId: stopped.id, threadId: worker, stage: "working" })
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* store.card(stopped.id), stopped);
      assert.deepStrictEqual(yield* store.threadLink(worker), link());
      assert.deepStrictEqual(yield* store.cardEvents(stopped.id), []);
    }).pipe(Effect.provide(testLayer({ separateBoards: true, failEventWrite: true }))),
);

it.effect(
  "paused restores survive stale failed turn ends and repeated idle/missing ticks before wake",
  () => {
    let missing = false;
    let failureReads = 0;
    let sends = 0;
    return Effect.gen(function* () {
      const store = yield* seed;
      const service = yield* KanbanService;
      for (const [threadId, stage] of [
        [worker, "working"],
        [reviewer, "in_review"],
      ] as const) {
        missing = false;
        yield* store.putCard(stopped);
        yield* service.restoreCutoverCard({ cardId: stopped.id, threadId, stage });
        const restored = yield* store.card(stopped.id);
        const restoredLink = yield* store.threadLink(threadId);
        const events = yield* store.cardEvents(stopped.id);
        yield* service.turnEnded(threadId);
        yield* service.turnEnded(threadId);
        yield* service.tick;
        yield* service.tick;
        missing = true;
        yield* service.tick;
        yield* service.tick;
        assert.deepStrictEqual(yield* store.card(stopped.id), restored);
        assert.deepStrictEqual(yield* store.threadLink(threadId), restoredLink);
        assert.deepStrictEqual(yield* store.cardEvents(stopped.id), events);
        assert.deepStrictEqual(yield* store.boards, [board]);
      }
      assert.strictEqual(failureReads, 0);
      assert.strictEqual(sends, 0);
    }).pipe(
      Effect.provide(
        testLayer({
          threads: {
            find: (threadId) => Effect.succeed(missing ? null : threadView(threadId)),
            view: (threadId) => Effect.succeed(missing ? null : threadView(threadId)),
            findLastFailure: () =>
              Effect.sync(() => {
                failureReads += 1;
                return {
                  class: "provider_error" as const,
                  code: "stopped-for-cutover",
                  message: "Old run was interrupted",
                  retryable: false,
                  runId: "source-run",
                };
              }),
            send: () =>
              Effect.sync(() => {
                sends += 1;
              }),
          },
        }),
      ),
    );
  },
);
