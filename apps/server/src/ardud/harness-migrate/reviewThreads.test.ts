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

it.effect("review: unrelated OpenCode threads retain their approval policy", () => {
  const commands: Array<unknown> = [];
  const thread = { id: "thread-glm", archivedAt: null, settledAt: null,
    modelSelection: { instanceId: "opencode", model: "opus/glm-5" },
    runtimeMode: "approval-required", interactionMode: "default" };
  const testLayer = Migration.layer.pipe(Layer.provide(Layer.mergeAll(
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
