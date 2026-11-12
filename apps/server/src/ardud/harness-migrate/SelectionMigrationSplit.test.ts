import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { layer as providerRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as KanbanService from "../kanban/engine/KanbanService.ts";
import * as KanbanModels from "../kanban/engine/models.ts";
import { opencodeTestProvider } from "../kanban/engine/testProviders.ts";
import * as KanbanThreads from "../kanban/engine/threads.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";
import { controlDDL } from "../persistence/boardsSchema.ts";
import { kanbanDDL } from "../persistence/kanbanSchema.ts";
import {
  ensureRunFollowTables,
  readBlockRetry,
  writeBlockRetry,
  type BlockRetry,
} from "../schedules/runFollow.ts";
import * as SelectionMigration from "./SelectionMigration.ts";

// Building the client privately keeps the orchestration SqlClient in the outer context distinct.
const boardsLayer = Layer.effect(
  BoardsDatabase.BoardsDatabase,
  Effect.gen(function* () {
    const context = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
    const sql = Context.get(context, SqlClient.SqlClient);
    yield* Effect.forEach([...controlDDL, ...kanbanDDL], (ddl) => sql.unsafe(ddl), {
      discard: true,
    });
    yield* ensureRunFollowTables(sql);
    return BoardsDatabase.BoardsDatabase.of({ sql, ready: Effect.void, path: ":memory:" });
  }),
);

const inertThreads = Layer.succeed(
  KanbanThreads.KanbanThreads,
  KanbanThreads.KanbanThreads.of({
    view: () => Effect.succeed(null),
    find: () => Effect.succeed(null),
    model: () => Effect.succeed(null),
    lastFailure: () => Effect.succeed(null),
    findLastFailure: () => Effect.succeed(null),
    latestRun: () => Effect.succeed(null),
    compactRun: () => Effect.succeed(null),
    launch: () => Effect.die("split migration tests launch no thread"),
    send: () => Effect.die("split migration tests send to no thread"),
    setModel: () => Effect.die("split migration tests change no thread model"),
    cancelQueued: () => Effect.succeed(false),
    interrupt: () => Effect.void,
  }),
);

const scheduleLayer = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    ),
  ),
);

const testLayer = SelectionMigration.layer.pipe(
  Layer.provideMerge(scheduleLayer),
  Layer.provideMerge(KanbanService.layer),
  Layer.provideMerge(inertThreads),
  Layer.provideMerge(KanbanStore.layer),
  Layer.provideMerge(KanbanModels.layerTest(null)),
  Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
  Layer.provideMerge(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      listProjectThreads: () => Effect.succeed([]),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadProjection: () => Effect.die("split migration tests read no queued runs"),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ProjectService.ProjectService)({
      snapshot: Effect.succeed({ projects: [], updatedAt: "2026-11-05T00:00:00.000Z" } as never),
    }),
  ),
  Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(boardsLayer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-harness-migrate-split-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(NodeCrypto.layer),
);

const assertNoMainLedger = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const tables = yield* sql`
      SELECT name FROM sqlite_schema WHERE name = 'ardud_harness_selection_migration'
    `;
    assert.deepStrictEqual(tables, [], "the migration ledger belongs only to the boards database");
  });

it.effect("split board apply rolls back every board write when its ledger insert fails", () =>
  Effect.gen(function* () {
    const main = yield* SqlClient.SqlClient;
    const { sql } = yield* BoardsDatabase.BoardsDatabase;
    assert.notStrictEqual(sql, main);
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const migration = yield* SelectionMigration.SelectionMigration;
    const board = yield* kanban.ensureBoard({
      slug: "split-ledger-failure",
      name: "Split ledger failure",
      defaultProjectId: ProjectId.make("project-split"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 2);
    const boardsBefore = yield* store.boards;
    const poolsBefore = yield* store.pools(board.id);
    const cardsBefore = yield* store.cards(board.id);
    const linksBefore = yield* store.threadLinks({ boardId: board.id, open: true });
    yield* sql.unsafe(`
      CREATE TRIGGER split_reject_board_ledger
      BEFORE INSERT ON ardud_harness_selection_migration WHEN NEW.scope = 'board'
      BEGIN SELECT RAISE(FAIL, 'split board ledger failure'); END
    `);

    const failure = yield* migration.apply.pipe(Effect.flip);

    assert.include(failure.message, `write board ${board.id}`);
    assert.deepStrictEqual(yield* store.boards, boardsBefore);
    assert.deepStrictEqual(yield* store.pools(board.id), poolsBefore);
    assert.deepStrictEqual(yield* store.cards(board.id), cardsBefore);
    assert.deepStrictEqual(
      yield* store.threadLinks({ boardId: board.id, open: true }),
      linksBefore,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT id FROM ardud_harness_selection_migration WHERE scope = 'board'`,
      [],
    );
    yield* assertNoMainLedger(main);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("split board apply and rollback keep their ledger out of the main database", () =>
  Effect.gen(function* () {
    const main = yield* SqlClient.SqlClient;
    const { sql } = yield* BoardsDatabase.BoardsDatabase;
    assert.notStrictEqual(sql, main);
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const migration = yield* SelectionMigration.SelectionMigration;
    const board = yield* kanban.ensureBoard({
      slug: "split-round-trip",
      name: "Split round trip",
      defaultProjectId: ProjectId.make("project-split"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 2);
    const boardsBefore = yield* store.boards;
    const poolsBefore = yield* store.pools(board.id);
    yield* assertNoMainLedger(main);

    const applied = yield* migration.apply;

    assert.isAbove(applied.report.counts.board, 0);
    const poolsAfter = yield* store.pools(board.id);
    assert.isAbove(poolsAfter.length, 0);
    assert.isTrue(poolsAfter.every((pool) => pool.model.instanceId === "claudeAgent"));
    const ledger = yield* sql<{
      id: number;
      applied_at: string | null;
      rolled_back_at: string | null;
    }>`
      SELECT id, applied_at, rolled_back_at FROM ardud_harness_selection_migration
      WHERE scope = 'board' ORDER BY id
    `;
    assert.strictEqual(ledger.length, applied.report.counts.board);
    assert.isTrue(ledger.every((row) => row.applied_at !== null && row.rolled_back_at === null));
    yield* assertNoMainLedger(main);
    assert.strictEqual((yield* migration.apply).applied, 0);

    const rolled = yield* migration.rollback(SelectionMigration.SELECTION_MIGRATION_VERSION);

    assert.deepStrictEqual(rolled.skipped, []);
    assert.isAtLeast(rolled.reverted, ledger.length);
    assert.deepStrictEqual(yield* store.boards, boardsBefore);
    assert.deepStrictEqual(yield* store.pools(board.id), poolsBefore);
    const restoredLedger = yield* sql<{ id: number; rolled_back_at: string | null }>`
      SELECT id, rolled_back_at FROM ardud_harness_selection_migration
      WHERE scope = 'board' ORDER BY id
    `;
    assert.deepStrictEqual(
      restoredLedger.map((row) => row.id),
      ledger.map((row) => row.id),
    );
    assert.isTrue(restoredLedger.every((row) => row.rolled_back_at !== null));
    yield* assertNoMainLedger(main);
  }).pipe(Effect.provide(testLayer)),
);

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect.each(["absent", "stale"] as const)(
  "split schedule fallback apply and rollback leave %s main retry data unchanged",
  (legacyRetry) =>
    Effect.gen(function* () {
      const main = yield* SqlClient.SqlClient;
      const { sql } = yield* BoardsDatabase.BoardsDatabase;
      assert.notStrictEqual(sql, main);
      const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
      const migration = yield* SelectionMigration.SelectionMigration;
      const created = yield* scheduled.upsert(
        yield* decodeUpsertInput({
          id: ScheduledTaskId.make(`scheduled-task:split-${legacyRetry}`),
          title: "Split fallback review",
          prompt: "Review the open pull requests.",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project-split"),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
      );
      const original: BlockRetry = {
        fallbacks: [
          { instanceId: ProviderInstanceId.make("opencode"), model: "opus/gpt-6-astra" },
          { instanceId: ProviderInstanceId.make("opencode"), model: "layso/gpt-6-astra" },
        ],
        limits: { runtimeMode: "full-access", interactionMode: "default" },
      };
      yield* writeBlockRetry(sql, created.task, original);
      if (legacyRetry === "stale") {
        yield* writeBlockRetry(main, created.task, {
          fallbacks: [
            {
              instanceId: ProviderInstanceId.make("opencode"),
              model: "opus/claude-opus-5-5",
            },
          ],
          limits: { runtimeMode: "approval-required", interactionMode: "default" },
        });
      }
      const mainSchemaBefore = yield* main`
        SELECT name, sql FROM sqlite_schema
        WHERE name IN ('ardud_scheduled_task_block_retry', 'ardud_harness_selection_migration')
        ORDER BY name
      `;
      const mainRowsBefore =
        legacyRetry === "stale"
          ? yield* main`SELECT * FROM ardud_scheduled_task_block_retry ORDER BY task_id`
          : [];
      yield* assertNoMainLedger(main);

      const applied = yield* migration.apply;

      assert.strictEqual(applied.report.counts["schedule-fallbacks"], 1);
      const migrated = yield* readBlockRetry(sql, created.task);
      assert.deepStrictEqual(migrated, {
        fallbacks: [{ instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" }],
        limits: original.limits,
      });
      const ledger = yield* sql<{ applied_at: string | null; rolled_back_at: string | null }>`
        SELECT applied_at, rolled_back_at FROM ardud_harness_selection_migration
        WHERE scope = 'schedule-fallbacks'
      `;
      assert.strictEqual(ledger.length, 1);
      assert.isNotNull(ledger[0]!.applied_at);
      assert.isNull(ledger[0]!.rolled_back_at);
      assert.deepStrictEqual(
        yield* main`
          SELECT name, sql FROM sqlite_schema
          WHERE name IN ('ardud_scheduled_task_block_retry', 'ardud_harness_selection_migration')
          ORDER BY name
        `,
        mainSchemaBefore,
      );
      if (legacyRetry === "stale") {
        assert.deepStrictEqual(
          yield* main`SELECT * FROM ardud_scheduled_task_block_retry ORDER BY task_id`,
          mainRowsBefore,
        );
      }
      assert.strictEqual((yield* migration.apply).applied, 0);

      const rolled = yield* migration.rollback(SelectionMigration.SELECTION_MIGRATION_VERSION);

      assert.deepStrictEqual(rolled.skipped, []);
      assert.isAtLeast(rolled.reverted, 1);
      assert.deepStrictEqual(yield* readBlockRetry(sql, created.task), original);
      const restoredLedger = yield* sql<{ rolled_back_at: string | null }>`
        SELECT rolled_back_at FROM ardud_harness_selection_migration
        WHERE scope = 'schedule-fallbacks'
      `;
      assert.strictEqual(restoredLedger.length, 1);
      assert.isNotNull(restoredLedger[0]!.rolled_back_at);
      assert.deepStrictEqual(
        yield* main`
          SELECT name, sql FROM sqlite_schema
          WHERE name IN ('ardud_scheduled_task_block_retry', 'ardud_harness_selection_migration')
          ORDER BY name
        `,
        mainSchemaBefore,
      );
      if (legacyRetry === "stale") {
        assert.deepStrictEqual(
          yield* main`SELECT * FROM ardud_scheduled_task_block_retry ORDER BY task_id`,
          mainRowsBefore,
        );
      }
      yield* assertNoMainLedger(main);
    }).pipe(Effect.provide(testLayer)),
);
