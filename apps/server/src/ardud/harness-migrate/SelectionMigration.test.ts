import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectId, ServerSettingsError, type KanbanActor } from "@t3tools/contracts";

import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { layer as providerRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import * as KanbanModels from "../kanban/engine/models.ts";
import * as KanbanService from "../kanban/engine/KanbanService.ts";
import * as KanbanThreads from "../kanban/engine/threads.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import { opencodeTestProvider } from "../kanban/engine/testProviders.ts";
import * as SelectionMigration from "./SelectionMigration.ts";

const owner: KanbanActor = { _tag: "owner" };

/** Fixed clock for the snapshot the project owner returns; no test reads the wall clock. */
const FIXED_UPDATED_AT = "2026-11-02T00:00:00.000Z";

/**
 * The owners the migration reads but these board tests do not exercise. They hold no projects,
 * schedules or threads, so the only writes a test sees are the board's.
 */
const emptyOwners = Layer.mergeAll(
  Layer.mock(ProjectService.ProjectService)({
    snapshot: Effect.succeed({ projects: [], updatedAt: FIXED_UPDATED_AT } as never),
  }),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
    list: () => Effect.succeed({ tasks: [] } as never),
  }),
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    listProjectThreads: () => Effect.succeed([]),
  }),
  Layer.mock(Orchestrator.OrchestratorV2)({
    getThreadProjection: () => Effect.die("the board tests read no queued runs"),
  }),
);

/**
 * The board tests never start, message or switch a thread, so the threads service is inert: reads
 * find nothing, and any launch, send or model change dies, so a board operation that tried to touch
 * a thread would fail the test rather than pass it silently.
 */
const inertThreads = Layer.succeed(
  KanbanThreads.KanbanThreads,
  KanbanThreads.KanbanThreads.of({
    view: () => Effect.succeed(null),
    find: () => Effect.succeed(null),
    model: () => Effect.succeed(null),
    lastFailure: () => Effect.succeed(null),
    launch: () => Effect.die("the board tests launch no thread"),
    send: () => Effect.die("the board tests send to no thread"),
    setModel: () => Effect.die("the board tests change no thread model"),
    interrupt: () => Effect.void,
  }),
);

const kanbanStack = (
  settingsLayer: Layer.Layer<ServerSettings.ServerSettingsService, ServerSettingsError>,
) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(inertThreads),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(emptyOwners),
    Layer.provideMerge(settingsLayer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-harness-migrate-test-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
    Layer.provideMerge(NodeCrypto.layer),
  );

const kanbanLayer = kanbanStack(ServerSettings.layerTest());

const testLayer = SelectionMigration.layer.pipe(Layer.provideMerge(kanbanLayer));

/**
 * The same stack with `ardudHarnessMigration.allowConflicts` on. The settings layer is the one the
 * kanban stack reads, so it is provided over the default rather than beneath it.
 */
const allowConflictsLayer = SelectionMigration.layer.pipe(
  Layer.provideMerge(
    kanbanStack(ServerSettings.layerTest({ ardudHarnessMigration: { allowConflicts: true } })),
  ),
);

it.effect("apply moves a board's pools to Claude Code and a second apply writes nothing", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const migration = yield* SelectionMigration.SelectionMigration;
    const board = yield* kanban.ensureBoard({
      slug: "pools",
      name: "Pools",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 2);

    const applied = yield* migration.apply;
    assert.isTrue(applied.applied > 0);

    // The store itself must now hold the migrated pools, not just a report claiming so.
    const pools = yield* store.pools(board.id);
    assert.isTrue(pools.length > 0);
    assert.isTrue(pools.every((pool) => pool.model.instanceId === "claudeAgent"));

    // Running it again finds every value already migrated and writes nothing.
    const again = yield* migration.apply;
    assert.strictEqual(again.applied, 0);
    const poolsAfterSecond = yield* store.pools(board.id);
    assert.deepStrictEqual(poolsAfterSecond, pools);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rollback restores a board's pools exactly as they were before apply", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const migration = yield* SelectionMigration.SelectionMigration;
    const board = yield* kanban.ensureBoard({
      slug: "rollback",
      name: "Rollback",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 2);
    const poolsBefore = yield* store.pools(board.id);

    yield* migration.apply;
    const rolled = yield* migration.rollback(SelectionMigration.SELECTION_MIGRATION_VERSION);

    assert.strictEqual(rolled.skipped.length, 0);
    assert.isTrue(rolled.reverted > 0);
    // Restored means the stored pools are the ones from before apply, not merely a same-looking set.
    const poolsAfter = yield* store.pools(board.id);
    assert.deepStrictEqual(poolsAfter, poolsBefore);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rollback leaves a board alone when it changed after apply, and reports it", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const migration = yield* SelectionMigration.SelectionMigration;
    const board = yield* kanban.ensureBoard({
      slug: "edited",
      name: "Edited",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 2);
    yield* migration.apply;

    // An operator edits a pool after apply: rollback must not undo it silently.
    const migrated = yield* store.pools(board.id);
    const edited = migrated.map((pool) => ({ ...pool, slots: pool.slots + 1 }));
    yield* store.putPool(board.id, edited[0]!);
    const poolsAfterEdit = yield* store.pools(board.id);

    const rolled = yield* migration.rollback(SelectionMigration.SELECTION_MIGRATION_VERSION);

    assert.isTrue(rolled.skipped.length > 0, "the edited board must be reported as skipped");
    assert.deepStrictEqual(yield* store.pools(board.id), poolsAfterEdit);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("apply refuses a conflicting board and leaves every board as it was", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const migration = yield* SelectionMigration.SelectionMigration;
    const board = yield* kanban.ensureBoard({
      slug: "conflict",
      name: "Conflict",
      defaultProjectId: ProjectId.make("project-1"),
    });
    // A suffix and a variant that name different efforts is a conflict the store accepts as-is, so it
    // can exist in production. The migration must never guess which effort was meant.
    const conflicting = {
      key: "opencode/opus/claude-opus-5-5#xhigh",
      model: {
        instanceId: "opencode",
        model: "opus/claude-opus-5-5#xhigh",
        options: [{ id: "variant", value: "high" }],
      },
      slots: 1,
    } as unknown as Parameters<typeof store.putPool>[1];
    yield* store.putPool(board.id, conflicting);
    const poolsBefore = yield* store.pools(board.id);

    const failure = yield* migration.apply.pipe(Effect.flip);
    assert.isTrue(String(failure.message).includes("refused"), "apply must say it refused");

    // Refused means nothing was written: the store is exactly as it was before apply.
    assert.deepStrictEqual(yield* store.pools(board.id), poolsBefore);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("allowConflicts lets apply proceed past a conflict, and only the clean boards move", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const migration = yield* SelectionMigration.SelectionMigration;
    const clean = yield* kanban.ensureBoard({
      slug: "allowed-clean",
      name: "Allowed clean",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(clean.id, clean.defaultCardModel, 2);
    const conflicted = yield* kanban.ensureBoard({
      slug: "allowed-conflict",
      name: "Allowed conflict",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* store.putPool(conflicted.id, {
      key: "opencode/opus/claude-opus-5-5#xhigh",
      model: {
        instanceId: "opencode",
        model: "opus/claude-opus-5-5#xhigh",
        options: [{ id: "variant", value: "high" }],
      },
      slots: 1,
    } as unknown as Parameters<typeof store.putPool>[1]);
    const conflictedBefore = yield* store.pools(conflicted.id);

    const applied = yield* migration.apply;
    assert.isTrue(applied.applied > 0, "the clean board must still be migrated");

    // The clean board moved to Claude Code; the conflicting one was left exactly as it was.
    const cleanPools = yield* store.pools(clean.id);
    assert.isTrue(cleanPools.every((pool) => pool.model.instanceId === "claudeAgent"));
    assert.deepStrictEqual(yield* store.pools(conflicted.id), conflictedBefore);
  }).pipe(Effect.provide(allowConflictsLayer)),
);

it.effect("dry-run reports a board's selections and writes nothing", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const migration = yield* SelectionMigration.SelectionMigration;
    const board = yield* kanban.ensureBoard({
      slug: "toy",
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 2);

    const before = yield* kanban.boards;
    const report = yield* migration.dryRun;
    const after = yield* kanban.boards;

    assert.strictEqual(report.version, SelectionMigration.SELECTION_MIGRATION_VERSION);
    assert.deepStrictEqual(after, before);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("review: rollback handles a board whose defaults were already migrated", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const migration = yield* SelectionMigration.SelectionMigration;
    const board = yield* kanban.ensureBoard({
      slug: "already-native",
      name: "Already native",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const native = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as never;
    yield* store.putBoard({ ...board, managerModel: native, evaluatorModel: native,
      defaultCardModel: native, reviewChains: [] });
    yield* store.putPool(board.id, { key: "opencode/opus/claude-opus-5-5",
      model: { instanceId: "opencode", model: "opus/claude-opus-5-5" }, slots: 2 } as never);
    const before = yield* store.pools(board.id);
    yield* migration.apply;
    const rolled = yield* migration.rollback(1);
    assert.deepStrictEqual(rolled.skipped, []);
    assert.deepStrictEqual(yield* store.pools(board.id), before);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("review: a ledger failure cannot leave a migrated board without rollback data", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const migration = yield* SelectionMigration.SelectionMigration;
    const sql = yield* SqlClient.SqlClient;
    const board = yield* kanban.ensureBoard({ slug: "ledger-fail", name: "Ledger fail",
      defaultProjectId: ProjectId.make("project-1") });
    yield* store.putPool(board.id, { key: "opencode/opus/claude-opus-5-5",
      model: { instanceId: "opencode", model: "opus/claude-opus-5-5" }, slots: 2 } as never);
    const before = yield* store.pools(board.id);
    yield* sql.unsafe(`CREATE TRIGGER review_reject_ledger BEFORE INSERT ON ardud_harness_selection_migration
      BEGIN SELECT RAISE(FAIL, 'review injected failure'); END`);
    yield* migration.apply.pipe(Effect.flip);
    assert.deepStrictEqual(yield* store.pools(board.id), before,
      "a failed migration must retain the original board or durable rollback data");
  }).pipe(Effect.provide(testLayer)),
);
