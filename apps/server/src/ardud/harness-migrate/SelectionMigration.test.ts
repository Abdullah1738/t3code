import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProjectId, type KanbanActor } from "@t3tools/contracts";

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

const kanbanLayer = KanbanService.layer.pipe(
  Layer.provideMerge(inertThreads),
  Layer.provideMerge(KanbanStore.layer),
  Layer.provideMerge(KanbanModels.layerTest(null)),
  Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
  Layer.provideMerge(emptyOwners),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-harness-migrate-test-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(NodeCrypto.layer),
);

const testLayer = SelectionMigration.layer.pipe(Layer.provideMerge(kanbanLayer));

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
