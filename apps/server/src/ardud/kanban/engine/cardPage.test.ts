import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  KanbanBoardId,
  KanbanCardId,
  ProviderInstanceId,
  ThreadId,
  type KanbanBoard,
  type KanbanCard,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import * as KanbanService from "./KanbanService.ts";
import * as KanbanModels from "./models.ts";
import { KanbanThreads } from "./threads.ts";
import { KanbanScripts } from "./ScriptService.ts";
import { kanbanRouteLayer } from "../http.ts";

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

const testLayer = (database = Sqlite.layerMemory) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(Layer.mock(KanbanThreads)({})),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(database),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([])),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-card-page-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ServerSettings.layerTest()),
      ),
    ),
  );
const fixture = (number: number): KanbanCard => ({
  ...card(number, "todo"),
  prompt: `Investigate bs-${String(number).padStart(10, "0")}`,
  description: `Evidence bs-${String(number).padStart(10, "0")}`,
  settledAt: number % 7 === 0 ? at : null,
  links: [
    {
      kind: "url",
      url: `https://example.com/${number}`,
      label: null,
      state: null,
      checkedAt: null,
    },
  ],
  subtasks: [
    {
      id: "s1",
      step: 1,
      text: "Fix it",
      owner: "work",
      state: "open",
      note: null,
      doneBy: null,
      doneAt: null,
    },
  ],
  subtaskSeq: 1,
});
const seed = (rows: ReadonlyArray<KanbanCard>) =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    yield* store.putBoard(board);
    yield* Effect.forEach(rows, (row) => store.putCard(row), { discard: true });
  });

it.effect("pages 600 full cards exactly once, including fingerprints past card 500", () =>
  Effect.gen(function* () {
    const service = yield* KanbanService.KanbanService;
    const expected = Array.from({ length: 600 }, (_, i) => fixture(i + 1));
    yield* seed(expected);
    const cards = [];
    let after = 0;
    for (;;) {
      const result = yield* service.cardPage({ board: boardId, after, limit: 200 });
      assert.isBoolean(result.page.hasMore);
      assert.isAtMost(result.cards.length, 200);
      assert.strictEqual(result.page.nextAfter, result.cards.at(-1)?.number);
      cards.push(...result.cards);
      if (!result.page.hasMore) break;
      after = result.page.nextAfter!;
    }
    assert.deepStrictEqual(cards, expected);
    assert.include(cards[550]!.prompt!, "bs-0000000551");
    const empty = yield* service.cardPage({ board: boardId, after: 600 });
    assert.deepStrictEqual(empty, {
      cards: [],
      page: { limit: 200, hasMore: false, nextAfter: null },
    });
  }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "filters settled rows before SQL LIMIT and keeps null and array fields in projections",
  () =>
    Effect.gen(function* () {
      const service = yield* KanbanService.KanbanService;
      yield* seed(Array.from({ length: 600 }, (_, i) => fixture(i + 1)));
      const result = yield* service.cardPage({
        board: boardId,
        open: true,
        limit: 200,
        fields: ["settledAt", "models", "wakeNote"],
      });
      assert.strictEqual(result.cards.length, 200);
      assert.isAbove(result.page.nextAfter!, 200);
      assert.deepStrictEqual(
        result.cards.map((c) => c.number),
        Array.from({ length: 600 }, (_, i) => i + 1)
          .filter((n) => n % 7 !== 0)
          .slice(0, 200),
      );
      assert.deepStrictEqual(result.cards[0], {
        id: KanbanCardId.make("card-1"),
        number: 1,
        updatedAt: at,
        settledAt: null,
        models: [],
        wakeNote: null,
      });
      assert.isTrue(result.page.hasMore);
      const error = yield* service
        .cardPage({ board: boardId, fields: ["__proto__"] })
        .pipe(Effect.flip);
      assert.strictEqual(error.code, "invalid");
      assert.include(error.detail, "prompt");
      assert.include(error.detail, "updatedAt");
      assert.strictEqual(
        (yield* service.cardPage({ board: boardId, limit: 9999, fields: [] })).cards.length,
        500,
      );
      assert.strictEqual(
        (yield* service.cardPage({ board: boardId, fields: [] })).cards.length,
        200,
      );
    }).pipe(Effect.provide(testLayer())),
);

it.effect("resumes after a 4 MiB cut without gaps or duplicates, counting UTF-8 bytes", () =>
  Effect.gen(function* () {
    const service = yield* KanbanService.KanbanService;
    yield* seed(
      Array.from({ length: 300 }, (_, i) => ({ ...fixture(i + 1), prompt: "é".repeat(25 * 1024) })),
    );
    const numbers = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const result = yield* service.cardPage({
        board: boardId,
        after,
        limit: 500,
        fields: ["prompt"],
      });
      const bytes = result.cards.reduce(
        (sum, row) => sum + Buffer.byteLength(JSON.stringify(row)),
        0,
      );
      if (pages++ === 0) {
        assert.isAbove(bytes, 4 * 1024 * 1024);
        assert.isAtMost(
          bytes - Buffer.byteLength(JSON.stringify(result.cards.at(-1))),
          4 * 1024 * 1024,
        );
        assert.isTrue(result.page.hasMore);
        assert.isBelow(result.cards.length, 100);
      }
      numbers.push(...result.cards.map((c) => c.number));
      assert.strictEqual(result.page.nextAfter, result.cards.at(-1)?.number);
      if (!result.page.hasMore) break;
      after = result.page.nextAfter!;
    }
    assert.deepStrictEqual(
      numbers,
      Array.from({ length: 300 }, (_, i) => i + 1),
    );
  }).pipe(Effect.provide(testLayer())),
);

it.effect("returns a single 5 MiB card and advances to the following card", () =>
  Effect.gen(function* () {
    const service = yield* KanbanService.KanbanService;
    const big = { ...fixture(1), prompt: "x".repeat(5 * 1024 * 1024) };
    yield* seed([big, fixture(2)]);
    const first = yield* service.cardPage({ board: boardId, limit: 500 });
    assert.deepStrictEqual(first.cards, [big]);
    assert.deepStrictEqual(first.page, { limit: 500, hasMore: true, nextAfter: 1 });
    const last = yield* service.cardPage({ board: boardId, after: first.page.nextAfter! });
    assert.deepStrictEqual(last.cards, [fixture(2)]);
    assert.isFalse(last.page.hasMore);
  }).pipe(Effect.provide(testLayer())),
);

it.live("card pages read committed data while a file database writer is held", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-card-page-reader-" });
    yield* Effect.gen(function* () {
      const service = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seed([fixture(1)]);
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          store
            .putCard(fixture(2))
            .pipe(
              Effect.andThen(Deferred.succeed(held, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* Deferred.await(held);
        const result = yield* service.cardPage({ board: boardId });
        assert.deepStrictEqual(result.cards, [fixture(1)]);
      }).pipe(Effect.timeout("5 seconds"), Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(writer);
    }).pipe(
      Effect.provide(
        testLayer(
          Sqlite.layerFromPath(`${dir}/cards.sqlite`).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "GET full-card pages return JSON by slug or id, validate queries, and require read scope",
  () =>
    Effect.gen(function* () {
      yield* seed([fixture(1), fixture(2)]);
      const service = yield* KanbanService.KanbanService;
      const routes = kanbanRouteLayer.pipe(
        Layer.provideMerge(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(KanbanService.KanbanService, service),
            Layer.mock(KanbanScripts)({}),
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              authenticateHttpRequest: (request) =>
                Effect.succeed({
                  sessionId: AuthSessionId.make("page-test"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes:
                    request.headers.authorization === "Bearer read" ? ["orchestration:read"] : [],
                }),
            }),
          ),
        ),
        Layer.provide(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
      );
      const web = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        (handler) => Effect.promise(() => handler.dispose()),
      );
      for (const ref of [board.slug, board.id]) {
        const response = yield* Effect.promise(() =>
          web.handler(
            new Request(
              `http://test.local/api/ardud/kanban/boards/${ref}/cards?limit=1&open=0&fields=prompt,settledAt`,
              { headers: { authorization: "Bearer read" } },
            ),
          ),
        );
        assert.strictEqual(response.status, 200);
        assert.include(response.headers.get("content-type")!, "application/json");
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          cards: [
            { id: "card-1", number: 1, updatedAt: at, prompt: fixture(1).prompt, settledAt: null },
          ],
          page: { limit: 1, hasMore: true, nextAfter: 1 },
        });
      }
      for (const query of ["after=-1", "after=1.5", "limit=1.5", "open=true", "fields=nope"]) {
        const response = yield* Effect.promise(() =>
          web.handler(
            new Request(`http://test.local/api/ardud/kanban/boards/robob/cards?${query}`, {
              headers: { authorization: "Bearer read" },
            }),
          ),
        );
        assert.strictEqual(response.status, 400);
      }
      const denied = yield* Effect.promise(() =>
        web.handler(new Request("http://test.local/api/ardud/kanban/boards/robob/cards")),
      );
      assert.strictEqual(denied.status, 403);
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
);
