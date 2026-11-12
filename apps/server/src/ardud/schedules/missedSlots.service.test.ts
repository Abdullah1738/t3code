import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { afterEach, vi } from "vite-plus/test";
afterEach(() => vi.unstubAllEnvs());
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";

const decode = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const now = "2026-11-09T23:07:00.000Z";
const slot = "2026-11-09T20:00:00.000Z";
const daily = { type: "fixed_time", timeOfDay: "00:00", timeZone: "Asia/Dubai" } as const;

const boot = <A, E>(
  prompts: string[],
  body: (
    tick: Effect.Effect<void>,
  ) => Effect.Effect<A, E, ScheduledTaskService.ScheduledTaskService | SqlClient.SqlClient>,
  options: { readOrigin?: Effect.Effect<{ relayHookBaseUrl: null }>; launchTimes?: number[] } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sources = new Map<string, Effect.Effect<void>>();
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(Scheduler.Scheduler)({
          register: <E, R>(name: string, run: Effect.Effect<void, E, R>) =>
            Effect.gen(function* () {
              const context = yield* Effect.context<R>();
              sources.set(name, run.pipe(Effect.provideContext(context), Effect.orDie));
            }),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Effect.gen(function* () {
              options.launchTimes?.push(DateTime.toEpochMillis(yield* DateTime.now));
              prompts.push(input.initialMessage?.text ?? "");
              return {
                threadId: ThreadId.make(`thread-${prompts.length}`),
                projection: undefined as never,
                resumed: false,
              };
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      const context = yield* Layer.build(
        ScheduledTaskService.layer.pipe(
          Layer.provide(dependencies),
          Layer.provide(
            Layer.succeed(
              ScheduledTaskService.ScheduledTaskWebhookOrigin,
              options.readOrigin ?? Effect.succeed({ relayHookBaseUrl: null }),
            ),
          ),
        ),
      );
      return yield* body(Effect.suspend(() => sources.get("scheduled-tasks")!)).pipe(
        Effect.provideContext(context),
      );
    }),
  );

const seed = (id: string, schedule: unknown, due = slot) =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    const input = yield* decode({
      commandId: id,
      title: id,
      prompt: "Review the logs.",
      enabled: false,
      projectId: "project-schedules",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      schedule,
    });
    const { task } = yield* service.upsert(input);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE scheduled_tasks SET enabled = 1, next_run_at = ${due} WHERE task_id = ${task.id}`;
    return task.id;
  });

it.effect("records a missed daily slot and one late run, including across a second boot", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        yield* seed("daily", daily);
        yield* tick;
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const task = (yield* service.list()).tasks[0]!;
        assert.equal(prompts.length, 1);
        assert.equal(
          prompts[0],
          `Late run: the ${slot} slot was missed (Robob unavailable). Review the logs.`,
        );
        assert.equal(task.missedRuns?.length, 1);
        assert.equal(task.missedRuns?.[0]?.slotAt, slot);
        assert.equal(task.missedRuns?.[0]?.catchUpAt, now);
        assert.equal(task.nextRunAt, "2026-11-10T20:00:00.000Z");
        yield* tick;
        assert.equal(prompts.length, 1);
      }),
    );
    yield* boot(prompts, (tick) => tick);
    assert.equal(prompts.length, 1);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("records every hourly slot with no catch-up", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-09T23:30:00Z"));
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        yield* seed("hourly", { type: "interval", everyMs: 3_600_000 });
        yield* tick;
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const task = (yield* service.list()).tasks[0]!;
        assert.equal(task.lastRunStatus, "missed");
        assert.equal(task.nextRunAt, "2026-11-10T00:00:00.000Z");
        assert.equal(task.missedRuns?.length, 4);
        assert.equal(prompts.length, 0);
        yield* tick;
        assert.equal((yield* service.list()).tasks[0]?.missedRuns?.length, 4);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("staggers late runs by 30 seconds and retains the queue over a reboot", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        yield* seed("first", daily);
        yield* seed("second", daily);
        yield* tick;
        assert.equal(prompts.length, 1);
        yield* TestClock.adjust("29 seconds");
        yield* tick;
        assert.equal(prompts.length, 1);
        yield* TestClock.adjust("1 second");
        yield* tick;
        assert.equal(prompts.length, 2);
      }),
    );
    yield* boot(prompts, (tick) => tick);
    assert.equal(prompts.length, 2);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect.each([
  { hours: 23, runs: 1, status: "running" },
  { hours: 25, runs: 0, status: "missed" },
])("handles a one-shot missed by $hours hours", ({ hours, runs, status }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(slot) + hours * 3_600_000);
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        yield* seed("once", { type: "once", at: slot });
        yield* tick;
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const task = (yield* service.list()).tasks[0]!;
        assert.equal(prompts.length, runs);
        assert.equal(task.enabled, false);
        assert.equal(task.lastRunStatus, status);
        assert.equal(task.missedRuns?.length, 1);
        if (runs) assert.include(prompts[0]!, `Late run: the ${slot}`);
      }),
    );
    yield* boot(prompts, (tick) => tick);
    assert.equal(prompts.length, runs);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect.each([
  { schedule: { type: "cron", expression: "0 * * * *", timeZone: "UTC" }, count: 4, runs: 0 },
  {
    schedule: { type: "cron", expression: "0 0 * * *", timeZone: "Asia/Dubai" },
    count: 1,
    runs: 1,
  },
  { schedule: { type: "interval", everyMs: 86_400_000 }, count: 1, runs: 1 },
])("recovers cadence $schedule", ({ schedule, count, runs }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-09T23:30:00Z"));
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        yield* seed("cadence", schedule);
        yield* tick;
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        assert.equal((yield* service.list()).tasks[0]?.missedRuns?.length, count);
        assert.equal(prompts.length, runs);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("only catches up the latest of several daily missed slots", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        yield* seed("days", daily, "2026-11-07T20:00:00.000Z");
        yield* tick;
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const task = (yield* service.list()).tasks[0]!;
        assert.equal(task.missedRuns?.length, 3);
        assert.equal(prompts.length, 1);
        assert.include(prompts[0]!, slot);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("keeps missed history outside the catch-up window", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-10T09:00:00Z"));
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        yield* seed("expired-daily", daily);
        yield* tick;
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const task = (yield* service.list()).tasks[0]!;
        assert.equal(task.lastRunStatus, "missed");
        assert.equal(task.missedRuns?.length, 1);
        assert.equal(prompts.length, 0);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("retains pending catch-ups and the 30 second spacing across reboot", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        yield* seed("reboot-first", daily);
        yield* seed("reboot-second", daily);
        yield* tick;
        assert.equal(prompts.length, 1);
      }),
    );
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        yield* tick;
        assert.equal(prompts.length, 1);
        yield* TestClock.adjust("30 seconds");
        yield* tick;
        assert.equal(prompts.length, 2);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("expires a one-shot that ages out while waiting behind another late run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(slot) + 86_400_000 - 10_000);
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        yield* seed("once-first", { type: "once", at: slot });
        yield* seed("once-second", { type: "once", at: slot });
        yield* tick;
        assert.equal(prompts.length, 1);
        yield* TestClock.adjust("30 seconds");
        yield* tick;
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        assert.isTrue((yield* service.list()).tasks.every((task) => !task.enabled));
        assert.equal(prompts.length, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("batches long outages without treating an old short-interval slot as current", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(slot) + 266 * 60_000);
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        const id = yield* seed("minute-batch", { type: "interval", everyMs: 60_000 });
        yield* tick;
        assert.equal(prompts.length, 0);
        yield* tick;
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM ardud_scheduled_task_missed_slots WHERE task_id = ${id}`;
        assert.equal(rows[0]?.count, 266);
        assert.equal(prompts.length, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect.each(
  [
    {
      zone: "Asia/Dubai",
      scheduleZone: undefined,
      due: "2026-11-09T05:00:00.000Z",
      next: "2026-11-10T05:00:00.000Z",
    },
    {
      zone: "America/New_York",
      scheduleZone: undefined,
      due: "2026-10-31T13:00:00.000Z",
      next: "2026-11-01T14:00:00.000Z",
    },
    {
      zone: "Asia/Dubai",
      scheduleZone: "UTC",
      due: "2026-11-09T09:00:00.000Z",
      next: "2026-11-10T09:00:00.000Z",
    },
    {
      zone: "UTC",
      scheduleZone: "Asia/Dubai",
      due: "2026-11-09T05:00:00.000Z",
      next: "2026-11-10T05:00:00.000Z",
    },
  ].flatMap((row) => [false, true].map((late) => ({ ...row, late }))),
)(
  "advances local calendar $zone / $scheduleZone late=$late",
  ({ zone, scheduleZone, due, next, late }) =>
    Effect.gen(function* () {
      vi.stubEnv("TZ", zone);
      yield* TestClock.setTime(Date.parse(due) + (late ? 7_200_000 : 0));
      const prompts: string[] = [];
      yield* boot(prompts, (tick) =>
        Effect.gen(function* () {
          yield* seed(
            "calendar",
            { type: "fixed_time", timeOfDay: "09:00", timeZone: scheduleZone },
            due,
          );
          yield* tick;
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          assert.equal((yield* service.list()).tasks[0]?.nextRunAt, next);
          assert.equal(prompts.length, 1);
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect.each([
  { expression: "* * * * *", missed: 30 },
  { expression: "*/5 * * * *", missed: 6 },
  { expression: "0,30 * * * *", missed: 1 },
])("does not replay superseded cron slots for $expression", ({ expression, missed }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(slot) + 30 * 60_000);
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        const id = yield* seed("frequent-cron", { type: "cron", expression, timeZone: "UTC" });
        yield* tick;
        assert.equal(prompts.length, 1);
        for (let count = 0; count < 11; count++) {
          yield* TestClock.adjust("5 seconds");
          yield* tick;
        }
        assert.equal(prompts.length, 1);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM ardud_scheduled_task_missed_slots WHERE task_id = ${id}`;
        assert.equal(rows[0]?.count, missed);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("expires a missed one-shot after a transient claim failure", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(slot) + 3_600_000);
    const prompts: string[] = [];
    yield* boot(prompts, (tick) =>
      Effect.gen(function* () {
        yield* seed("claim-failure", { type: "once", at: slot });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER fail_catch_up BEFORE UPDATE OF catch_up_at ON ardud_scheduled_task_missed_slots BEGIN SELECT RAISE(FAIL, 'synthetic claim failure'); END`;
        yield* tick;
        assert.equal(prompts.length, 0);
        yield* sql`DROP TRIGGER fail_catch_up`;
        yield* TestClock.adjust("27 hours");
        yield* tick;
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const task = (yield* service.list()).tasks[0]!;
        assert.equal(task.enabled, false);
        assert.equal(task.lastRunStatus, "missed");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("spaces catch-ups from dispatch after slow candidate reads", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    const prompts: string[] = [];
    const launchTimes: number[] = [];
    let reads = 0;
    let delay = false;
    const readOrigin = Effect.gen(function* () {
      if (delay && ++reads === 3) yield* TestClock.adjust("20 seconds");
      return { relayHookBaseUrl: null };
    });
    yield* boot(
      prompts,
      (tick) =>
        Effect.gen(function* () {
          yield* seed("slow-first", daily);
          yield* seed("slow-second", daily);
          delay = true;
          yield* tick;
          assert.equal(prompts.length, 1);
          yield* TestClock.adjust("10 seconds");
          yield* tick;
          assert.equal(prompts.length, 1);
          yield* TestClock.adjust("20 seconds");
          yield* tick;
          assert.equal(prompts.length, 2);
          assert.isAtLeast(launchTimes[1]! - launchTimes[0]!, 30_000);
        }),
      { readOrigin, launchTimes },
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect.each([0, 20_000, 120_000])(
  "keeps reboot spacing when the persisted claim precedes dispatch by %i ms",
  (claimAgeMs) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const prompts: string[] = [];
      const launchTimes: number[] = [];
      yield* boot(
        prompts,
        (tick) =>
          Effect.gen(function* () {
            yield* seed("old-claim-first", daily);
            yield* seed("old-claim-second", daily);
            yield* tick;
            assert.equal(prompts.length, 1);
            const sql = yield* SqlClient.SqlClient;
            // Reproduce the persisted state of a claim delayed before dispatch.
            yield* sql`UPDATE ardud_scheduled_task_missed_slots
      SET catch_up_at = ${DateTime.formatIso(DateTime.makeUnsafe(launchTimes[0]! - claimAgeMs))}
      WHERE catch_up_at IS NOT NULL`;
          }),
        { launchTimes },
      );
      yield* boot(
        prompts,
        (tick) =>
          Effect.gen(function* () {
            yield* TestClock.adjust("10 seconds");
            yield* tick;
            assert.equal(prompts.length, 1);
            yield* TestClock.adjust("20 seconds");
            yield* tick;
            assert.equal(prompts.length, 2);
            assert.isAtLeast(launchTimes[1]! - launchTimes[0]!, 30_000);
          }),
        { launchTimes },
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);
