import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Settings from "../../serverSettings.ts";
import * as Schedules from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Kanban from "../kanban/engine/KanbanService.ts";
import * as Store from "../kanban/store/KanbanStore.ts";
import * as Migration from "./SelectionMigration.ts";
import * as SqlClient from "effect/sql/SqlClient";

it.effect("review: unrelated OpenCode threads retain their approval policy", () => {
  const commands: Array<unknown> = [];
  const thread = { id: "thread-glm", archivedAt: null, settledAt: null,
    modelSelection: { instanceId: "opencode", model: "opus/glm-5" },
    runtimeMode: "approval-required", interactionMode: "default" };
  const testLayer = Migration.layer.pipe(Layer.provideMerge(Layer.mergeAll(
    Sqlite.layerMemory, NodeCrypto.layer, Settings.layerTest(),
    Layer.mock(Schedules.ScheduledTaskService)({ list: () => Effect.succeed({tasks: []} as never) }),
    Layer.mock(Projects.ProjectService)({ snapshot: Effect.succeed({ projects: [{id: "project-1", defaultModelSelection: null}] } as never) }),
    Layer.mock(Threads.ThreadManagementService)({ listProjectThreads: () => Effect.succeed([thread] as never) }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadProjection: () => Effect.succeed({ runs: [] } as never),
      dispatch: (command) => Effect.sync(() => { commands.push(command); return {} as never; }),
    }),
    Layer.mock(Kanban.KanbanService)({ boards: Effect.succeed([]), attachmentPath: () => "" }),
    Layer.mock(Store.KanbanStore)({}),
  )));
  return Effect.gen(function* () {
    const migration = yield* Migration.SelectionMigration;
    yield* migration.apply;
    assert.deepStrictEqual(commands, [], "GLM must not have its permissions widened");
  }).pipe(Effect.provide(testLayer));
});

it.effect("round 2: interrupted selection writes recover their runtime intent and guarded rollback", () => {
  const original = { instanceId: "opencode", model: "opus/claude-opus-5-5" } as never;
  let thread = { id: "thread-rollback", archivedAt: null, settledAt: null, deletedAt: null,
    modelSelection: original, runtimeMode: "approval-required", interactionMode: "default" };
  const testLayer = Migration.layer.pipe(Layer.provideMerge(Layer.mergeAll(
    Sqlite.layerMemory, NodeCrypto.layer, Settings.layerTest(),
    Layer.mock(Schedules.ScheduledTaskService)({ list: () => Effect.succeed({ tasks: [] } as never) }),
    Layer.mock(Projects.ProjectService)({ snapshot: Effect.succeed({ projects: [{ id: "project-1", defaultModelSelection: null }] } as never) }),
    Layer.mock(Threads.ThreadManagementService)({ listProjectThreads: () => Effect.sync(() => [thread] as never) }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadProjection: () => Effect.sync(() => ({ thread, runs: [] } as never)),
      dispatch: (command) => Effect.sync(() => {
        if (command.type === "provider.switch" || command.type === "thread.model-selection.set") {
          assert.deepStrictEqual(command.expectedModelSelection, thread.modelSelection);
          thread = { ...thread, modelSelection: command.modelSelection as never };
        } else if (command.type === "thread.runtime-mode.set") {
          assert.strictEqual(command.expectedRuntimeMode, thread.runtimeMode);
          thread = { ...thread, runtimeMode: command.runtimeMode };
        }
        return {} as never;
      }),
    }),
    Layer.mock(Kanban.KanbanService)({ boards: Effect.succeed([]), attachmentPath: () => "" }),
    Layer.mock(Store.KanbanStore)({}),
  )));
  return Effect.gen(function* () {
    const migration = yield* Migration.SelectionMigration;
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`CREATE TRIGGER r2_thread_receipt BEFORE UPDATE OF applied_at ON ardud_harness_selection_migration
      WHEN OLD.scope = 'thread' BEGIN SELECT RAISE(FAIL, 'lost thread receipt'); END`);
    yield* migration.apply.pipe(Effect.flip);
    assert.strictEqual(thread.runtimeMode, "approval-required");
    assert.strictEqual((thread.modelSelection as { instanceId: string }).instanceId, "claudeAgent");
    yield* sql.unsafe(`DROP TRIGGER r2_thread_receipt`);
    yield* migration.apply;
    assert.strictEqual(thread.runtimeMode, "full-access");
    const migrated = thread.modelSelection;
    thread = { ...thread, runtimeMode: "auto-accept-edits", modelSelection: original };
    const guarded = yield* migration.rollback(1);
    assert.strictEqual(guarded.skipped.length, 2);
    assert.strictEqual(thread.runtimeMode, "auto-accept-edits");
    thread = { ...thread, runtimeMode: "full-access", modelSelection: migrated };
    const restored = yield* migration.rollback(1);
    assert.deepStrictEqual(restored.skipped, []);
    assert.strictEqual(thread.runtimeMode, "approval-required");
    assert.deepStrictEqual(thread.modelSelection, original);
  }).pipe(Effect.provide(testLayer));
});
