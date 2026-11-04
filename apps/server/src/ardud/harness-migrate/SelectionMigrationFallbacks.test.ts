import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ProjectId,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { layer as providerRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import * as KanbanModels from "../kanban/engine/models.ts";
import * as KanbanService from "../kanban/engine/KanbanService.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import * as KanbanThreads from "../kanban/engine/threads.ts";
import { opencodeTestProvider } from "../kanban/engine/testProviders.ts";
import { readBlockRetry, writeBlockRetry } from "../schedules/runFollow.ts";
import * as SelectionMigration from "./SelectionMigration.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const taskId = ScheduledTaskId.make("scheduled-task:fallbacks");

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

/** Kanban and the migration over one in-memory database, with no boards and no projects to migrate. */
const migrationStack = (
  settingsLayer: Layer.Layer<ServerSettings.ServerSettingsService, ServerSettingsError>,
) =>
  SelectionMigration.layer.pipe(
    Layer.provideMerge(scheduleLayer),
    Layer.provideMerge(KanbanService.layer),
    Layer.provideMerge(KanbanThreads.layer),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ThreadManagementService.ThreadManagementService)({ listProjectThreads: () => Effect.succeed([]) })),
    Layer.provideMerge(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provideMerge(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.provideMerge(Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects", isScratchProject: () => Effect.succeed(false) })),
    Layer.provideMerge(Layer.mock(Orchestrator.OrchestratorV2)({ getThreadProjection: () => Effect.die("unused") })),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({ snapshot: Effect.succeed({ projects: [], updatedAt: "2026-11-03T00:00:00.000Z" } as never) })),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-harness-migrate-fallbacks-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );

const testLayer = migrationStack(ServerSettings.layerTest());

it.effect("apply maps a schedule's stored fallbacks in order and keeps its retry limits", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
    const migration = yield* SelectionMigration.SelectionMigration;
    const created = yield* scheduled.upsert(
      yield* decodeUpsertInput({
        id: taskId,
        title: "Fallback review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project-fallbacks"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    );
    const limits = { runtimeMode: "full-access", interactionMode: "default" } as const;
    yield* writeBlockRetry(sql, created.task, {
      fallbacks: [
        { instanceId: "opencode", model: "opus/gpt-6-astra" } as never,
        { instanceId: "opencode", model: "layso/gpt-6-astra" } as never,
      ],
      limits,
    });

    const applied = yield* migration.apply;
    assert.isTrue(applied.applied > 0);

    const after = yield* readBlockRetry(sql, created.task);
    assert.isNotNull(after, "the retry row must still be there after apply");
    // Both legacy routes name one Codex model: the list keeps it once, and the limits are unchanged.
    assert.deepStrictEqual(
      after?.fallbacks.map((entry) => `${entry.instanceId}/${entry.model}`),
      ["codex/gpt-6-astra"],
    );
    assert.deepStrictEqual(after?.limits, limits);
    yield* writeBlockRetry(sql, created.task, { fallbacks: [{ instanceId: "codex", model: "operator-edit" } as never], limits });
    const guarded = yield* migration.rollback(1);
    assert.isTrue(guarded.skipped.some((entry) => entry.ref.startsWith(`v1:${encodeURIComponent(taskId)}:`)));
    assert.strictEqual((yield* readBlockRetry(sql, created.task))?.fallbacks[0]?.model, "operator-edit");
    yield* writeBlockRetry(sql, created.task, after!);
    const rolled = yield* migration.rollback(1);
    assert.deepStrictEqual(rolled.skipped, [], "round 2: unchanged fallbacks must roll back");
    const restored = yield* readBlockRetry(sql, created.task);
    assert.deepStrictEqual(restored?.fallbacks.map(entry => `${entry.instanceId}/${entry.model}`),
      ["opencode/opus/gpt-6-astra", "opencode/layso/gpt-6-astra"]);
  }).pipe(Effect.provide(testLayer)),
);
