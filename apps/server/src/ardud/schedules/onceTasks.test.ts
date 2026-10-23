import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const baseInput = {
  title: "t3 test: once",
  prompt: "reply OK",
  projectId: "project-once",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "opencode", model: "opus/claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

const withService = <A, E>(
  launches: Ref.Ref<number>,
  body: Effect.Effect<A, E, ScheduledTaskService.ScheduledTaskService | SqlClient.SqlClient>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.provideMerge(
          ScheduledTaskService.layer,
          Layer.mergeAll(
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
              isScratchProject: () => Effect.succeed(false),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: () =>
                Ref.update(launches, (n) => n + 1).pipe(
                  Effect.as({
                    threadId: ThreadId.make("thread-once"),
                    projection: undefined as never,
                    resumed: false,
                  }),
                ),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            NodeCrypto.layer,
            Scheduler.layer,
            Layer.mock(SecretRequests.SecretRequests)({}),
          ),
        ),
      );
      return yield* body.pipe(Effect.provideContext(context));
    }),
  );

it.effect("fires a once task when due, then disables it and keeps the record", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-05T08:50:00.000Z"));
    const launches = yield* Ref.make(0);
    yield* withService(
      launches,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const input = yield* decodeUpsertInput({
          ...baseInput,
          enabled: true,
          schedule: { type: "once", at: "2026-10-05T12:55:00+04:00", timeZone: "Asia/Dubai" },
        });
        const { task } = yield* service.upsert(input);
        assert.equal(task.nextRunAt, "2026-10-05T08:55:00.000Z");

        yield* TestClock.adjust("4 minutes");
        assert.equal(yield* Ref.get(launches), 0);
        yield* TestClock.adjust("2 minutes");
        assert.equal(yield* Ref.get(launches), 1);

        const [after] = (yield* service.list()).tasks;
        assert.equal(after?.enabled, false);
        assert.isNull(after?.nextRunAt ?? null);
        assert.equal(after?.lastRunStatus, "running");
        assert.equal(after?.runCount, 1);

        // Nothing fires again, and re-enabling a spent once task is refused.
        yield* TestClock.adjust("10 minutes");
        assert.equal(yield* Ref.get(launches), 1);
        const refused = yield* service.setEnabled({ id: task.id, enabled: true }).pipe(Effect.flip);
        assert.include(refused.message, "in the past");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("rejects creating an enabled once task in the past, but allows a disabled one", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-05T10:00:00.000Z"));
    const launches = yield* Ref.make(0);
    yield* withService(
      launches,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const past = { type: "once", at: "2026-10-05T08:55:00Z" } as const;
        const enabled = yield* decodeUpsertInput({ ...baseInput, enabled: true, schedule: past });
        const failure = yield* service.upsert(enabled).pipe(Effect.flip);
        assert.include(failure.message, "in the past");
        const disabled = yield* decodeUpsertInput({ ...baseInput, enabled: false, schedule: past });
        assert.equal((yield* service.upsert(disabled)).task.enabled, false);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

const seedOnceRow = (dueIso: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
      task_id: "scheduled-task:once-down",
      title: "t3 test: once while down",
      prompt: "reply OK",
      enabled: 1,
      schedule_json: `{"type":"once","at":"${dueIso}"}`,
      project_id: "project-once",
      thread_id: null,
      workspace_strategy_json: '{"type":"root"}',
      model_selection_json: '{"instanceId":"opencode","model":"opus/claude-opus-5-5"}',
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_by: "user",
      creation_source: "web",
      created_at: dueIso,
      updated_at: dueIso,
      next_run_at: dueIso,
      last_run_at: null,
      last_run_status: "never",
      last_run_error: null,
      run_count: 0,
    })}`;
  });

it.effect("fires a once task missed by less than an hour when the server comes back", () =>
  Effect.gen(function* () {
    yield* seedOnceRow("2026-10-05T08:55:00.000Z");
    yield* TestClock.setTime(Date.parse("2026-10-05T09:40:00.000Z"));
    const launches = yield* Ref.make(0);
    yield* withService(
      launches,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* TestClock.adjust("6 seconds");
        assert.equal(yield* Ref.get(launches), 1);
        const [task] = (yield* service.list()).tasks;
        assert.equal(task?.enabled, false);
        assert.equal(task?.lastRunStatus, "running");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("marks a once task missed by more than an hour instead of firing it", () =>
  Effect.gen(function* () {
    yield* seedOnceRow("2026-10-05T08:55:00.000Z");
    yield* TestClock.setTime(Date.parse("2026-10-05T10:00:00.000Z"));
    const launches = yield* Ref.make(0);
    yield* withService(
      launches,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* TestClock.adjust("6 seconds");
        assert.equal(yield* Ref.get(launches), 0);
        const [task] = (yield* service.list()).tasks;
        assert.equal(task?.enabled, false);
        assert.isNull(task?.nextRunAt ?? null);
        assert.equal(task?.lastRunStatus, "failed");
        assert.include(task?.lastRunError ?? "", "Missed");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
