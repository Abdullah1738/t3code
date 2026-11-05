import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskId, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const dependencies = Layer.mergeAll(
  NodeCrypto.layer,
  Scheduler.layer,
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/projects",
    isScratchProject: () => Effect.succeed(false),
  }),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
);

const taskId = ScheduledTaskId.make("scheduled-task:migrate-selection");

/** A stored task on a legacy OpenCode selection, the state a migration reads. */
const legacyTask = decodeUpsertInput({
  id: taskId,
  title: "Review",
  prompt: "Review the open pull requests.",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: "project-migrate-selection",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "opencode", model: "opus/claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
});

it.effect("rewrites a schedule's selection only while it still holds the value that was read", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(yield* legacyTask);
      const legacy = created.task.modelSelection;
      const next = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as typeof legacy;

      // The value the migration read is still stored, so the rewrite lands.
      const wrote = yield* service.migrateModelSelection({ id: taskId, expected: legacy, next });
      expect(wrote).toBe(true);
      const afterWrite = yield* service.list();
      expect(afterWrite.tasks.find((task) => task.id === taskId)?.modelSelection).toEqual(next);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("leaves a schedule alone when its selection changed after it was read", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(yield* legacyTask);
      const legacy = created.task.modelSelection;
      const edited = { instanceId: "opencode", model: "opus/gpt-6-astra" } as typeof legacy;
      const next = { instanceId: "codex", model: "gpt-6-astra" } as typeof legacy;

      // An operator edits the schedule after the dry run read `legacy`: the stale write must not land.
      yield* service.upsert({ ...(yield* legacyTask), modelSelection: edited, id: taskId });
      const wrote = yield* service.migrateModelSelection({ id: taskId, expected: legacy, next });
      expect(wrote).toBe(false);
      const stored = (yield* service.list()).tasks.find((task) => task.id === taskId);
      expect(stored?.modelSelection).toEqual(edited);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
