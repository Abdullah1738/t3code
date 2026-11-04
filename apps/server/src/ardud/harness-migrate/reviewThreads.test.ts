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
          assert.deepStrictEqual(command.expectedModelSelection, thread.modelSelection);
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

it.effect("rollback retires a pending intent on a terminal run without changing history", () => {
  const original = { instanceId: "opencode", model: "opus/claude-opus-5-5" };
  const after = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const thread = { id: "thread-terminal", archivedAt: null, settledAt: null, deletedAt: null,
    modelSelection: { instanceId: "opencode", model: "opus/glm-5" }, runtimeMode: "approval-required", interactionMode: "default" };
  const run = { id: "terminal-run", status: "completed", modelSelection: after };
  const retiredUnwrittenRun = { id: "terminal-unwritten", status: "completed", modelSelection: original };
  const missingRunRef = `${encodeURIComponent(thread.id)}:${encodeURIComponent("deleted-run")}`;
  const testLayer = Migration.layer.pipe(Layer.provideMerge(Layer.mergeAll(
    Sqlite.layerMemory, NodeCrypto.layer, Settings.layerTest(),
    Layer.mock(Schedules.ScheduledTaskService)({ list: () => Effect.succeed({ tasks: [] } as never) }),
    Layer.mock(Projects.ProjectService)({ snapshot: Effect.succeed({ projects: [{ id: "project-1", defaultModelSelection: null }] } as never) }),
    Layer.mock(Threads.ThreadManagementService)({ listProjectThreads: () => Effect.succeed([thread] as never) }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadProjection: () => Effect.succeed({ thread, runs: [run, retiredUnwrittenRun] } as never),
      dispatch: () => Effect.die("terminal history must not be rewritten"),
    }),
    Layer.mock(Kanban.KanbanService)({ boards: Effect.succeed([]), attachmentPath: () => "" }),
    Layer.mock(Store.KanbanStore)({}),
  )));
  return Effect.gen(function* () {
    const migration = yield* Migration.SelectionMigration;
    const sql = yield* SqlClient.SqlClient;
    const ref = `${encodeURIComponent(thread.id)}:${encodeURIComponent(run.id)}`;
    yield* sql`INSERT INTO ardud_harness_selection_migration
      (version, scope, ref, before_json, after_json, applied_at, rolled_back_at)
      VALUES (1, ${"queued-run"}, ${ref}, ${JSON.stringify(original)}, ${JSON.stringify(after)}, NULL, NULL)`;
    const result = yield* migration.rollback(1);
    assert.isTrue(result.skipped.some((item) => item.ref === ref && item.reason.includes("eligible")));
    assert.isTrue(result.retired.some((item) => item.ref === ref));
    const rows = yield* sql<{ rolled_back_at: string | null }>`SELECT rolled_back_at FROM ardud_harness_selection_migration WHERE ref = ${ref}`;
    assert.isNotNull(rows[0]?.rolled_back_at);
    yield* migration.apply;
    assert.deepStrictEqual(run.modelSelection, after);
    const unwrittenRef = `${encodeURIComponent(thread.id)}:${encodeURIComponent(retiredUnwrittenRun.id)}`;
    for (const pendingRef of [unwrittenRef, missingRunRef]) {
      yield* sql`INSERT INTO ardud_harness_selection_migration
        (version, scope, ref, before_json, after_json, applied_at, rolled_back_at)
        VALUES (1, ${"queued-run"}, ${pendingRef}, ${JSON.stringify(original)}, ${JSON.stringify(after)}, NULL, NULL)`;
    }
    const recovery = yield* migration.apply;
    assert.isTrue(recovery.retired.some((item) => item.ref === unwrittenRef));
    assert.isTrue(recovery.retired.some((item) => item.ref === missingRunRef));
    assert.deepStrictEqual(retiredUnwrittenRun.modelSelection, original);
  }).pipe(Effect.provide(testLayer));
});

it.effect("apply confirms terminal writes and retires dormant unwritten intents", () => {
  const original = { instanceId: "opencode", model: "opus/claude-opus-5-5" };
  const after = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const thread = { id: "thread-dormant", archivedAt: "2026-11-04T00:00:00Z", settledAt: null, deletedAt: null,
    modelSelection: original, runtimeMode: "approval-required", interactionMode: "default" };
  const run = { id: "terminal-run", status: "completed", modelSelection: after };
  const testLayer = Migration.layer.pipe(Layer.provideMerge(Layer.mergeAll(
    Sqlite.layerMemory, NodeCrypto.layer, Settings.layerTest(),
    Layer.mock(Schedules.ScheduledTaskService)({ list: () => Effect.succeed({ tasks: [] } as never) }),
    Layer.mock(Projects.ProjectService)({ snapshot: Effect.succeed({ projects: [{ id: "project-1", defaultModelSelection: null }] } as never) }),
    Layer.mock(Threads.ThreadManagementService)({ listProjectThreads: () => Effect.succeed([thread] as never) }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadProjection: () => Effect.succeed({ thread, runs: [run] } as never),
      dispatch: () => Effect.die("dormant owners must not be rewritten"),
    }),
    Layer.mock(Kanban.KanbanService)({ boards: Effect.succeed([]), attachmentPath: () => "" }),
    Layer.mock(Store.KanbanStore)({}),
  )));
  return Effect.gen(function* () {
    const migration = yield* Migration.SelectionMigration;
    const sql = yield* SqlClient.SqlClient;
    const runRef = `${encodeURIComponent(thread.id)}:${encodeURIComponent(run.id)}`;
    yield* sql`INSERT INTO ardud_harness_selection_migration
      (version, scope, ref, before_json, after_json, applied_at, rolled_back_at)
      VALUES (1, ${"queued-run"}, ${runRef}, ${JSON.stringify(original)}, ${JSON.stringify(after)}, NULL, NULL)`;
    yield* sql`INSERT INTO ardud_harness_selection_migration
      (version, scope, ref, before_json, after_json, applied_at, rolled_back_at)
      VALUES (1, ${"thread"}, ${thread.id}, ${JSON.stringify(original)}, ${JSON.stringify(after)}, NULL, NULL)`;
    const result = yield* migration.apply;
    assert.isTrue(result.retired.some((item) => item.ref === thread.id));
    const rows = yield* sql<{ ref: string; applied_at: string | null; rolled_back_at: string | null }>`
      SELECT ref, applied_at, rolled_back_at FROM ardud_harness_selection_migration ORDER BY id`;
    assert.isNotNull(rows[0]?.applied_at);
    assert.isNotNull(rows[1]?.rolled_back_at);
    const rollback = yield* migration.rollback(1);
    assert.isTrue(rollback.skipped.some((item) => item.ref === runRef));
    assert.deepStrictEqual(run.modelSelection, after);
    assert.deepStrictEqual(thread.modelSelection, original);
    const runtimeRef = `${thread.id}`;
    yield* sql`INSERT INTO ardud_harness_selection_migration
      (version, scope, ref, before_json, after_json, applied_at, rolled_back_at)
      VALUES (1, ${"thread-runtime"}, ${runtimeRef}, ${JSON.stringify("approval-required")}, ${JSON.stringify("full-access")}, NULL, NULL)`;
    const runtimeRecovery = yield* migration.apply;
    assert.isTrue(runtimeRecovery.retired.some((item) => item.ref === runtimeRef && item.scope === "thread-runtime"));
    assert.strictEqual(thread.runtimeMode, "approval-required");
  }).pipe(Effect.provide(testLayer));
});

it.effect("a selection switched to GLM between migration commands cannot gain full access", () => {
  const original = { instanceId: "opencode", model: "opus/claude-opus-5-5" } as never;
  let thread = { id: "thread-race", archivedAt: null, settledAt: null, deletedAt: null,
    modelSelection: original, runtimeMode: "approval-required", interactionMode: "default" };
  const testLayer = Migration.layer.pipe(Layer.provideMerge(Layer.mergeAll(
    Sqlite.layerMemory, NodeCrypto.layer, Settings.layerTest(),
    Layer.mock(Schedules.ScheduledTaskService)({ list: () => Effect.succeed({ tasks: [] } as never) }),
    Layer.mock(Projects.ProjectService)({ snapshot: Effect.succeed({ projects: [{ id: "project-1", defaultModelSelection: null }] } as never) }),
    Layer.mock(Threads.ThreadManagementService)({ listProjectThreads: () => Effect.sync(() => [thread] as never) }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadProjection: () => Effect.sync(() => ({ thread, runs: [] } as never)),
      dispatch: (command) => Effect.gen(function* () {
        if (command.type === "provider.switch" || command.type === "thread.model-selection.set") {
          thread = { ...thread, modelSelection: { instanceId: "opencode", model: "opus/glm-5" } as never };
        } else if (command.type === "thread.runtime-mode.set") {
          if (command.expectedModelSelection !== undefined && JSON.stringify(command.expectedModelSelection) !== JSON.stringify(thread.modelSelection)) {
            return yield* new Orchestrator.OrchestratorDispatchError({ commandId: command.commandId, commandType: command.type, cause: "selection changed" });
          }
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
    const error = yield* migration.apply.pipe(Effect.flip);
    assert.isTrue(error.message.includes("widen thread"));
    assert.strictEqual(thread.runtimeMode, "approval-required");
    assert.strictEqual((thread.modelSelection as { model: string }).model, "opus/glm-5");
  }).pipe(Effect.provide(testLayer));
});
