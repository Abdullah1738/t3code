import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import { FOLLOW_QUIET_MS, writeBlockRetry } from "./runFollow.ts";

const T0 = Date.parse("2026-10-22T20:00:00.000Z");
const minute = 60_000;
const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const BLOCKED = {
  class: "provider_error",
  code: "provider.content-filter",
  message: "Provider blocked the response",
  retryable: null,
};
const FULL = { runtimeMode: "full-access", interactionMode: "default" } as const;

interface RunState {
  readonly id: string;
  readonly status: string;
  readonly endsAt?: number;
  readonly blocked?: boolean;
  /** A blocked run whose failure carries only the content_filter category, with no legacy code. */
  readonly blockedByCategory?: boolean;
}

const BLOCKED_BY_CATEGORY = {
  class: "provider_error",
  code: "model_refusal",
  message: "Claude declined to continue this request.",
  retryable: null,
  category: "content_filter",
};

type Threads = ReadonlyMap<string, ReadonlyArray<RunState>>;

const LIVE = new Set(["preparing", "starting", "running", "waiting"]);

const records = (threadId: string, runs: ReadonlyArray<RunState>) => ({
  thread: {
    id: threadId,
    deletedAt: null,
    activeProviderThreadId: null,
    limitRecovery: null,
  },
  runs: runs.map((run, index) => ({
    id: run.id,
    threadId,
    ordinal: index + 1,
    status: run.status,
    rootNodeId: `node-${run.id}`,
    startedAt: run.status === "queued" ? null : DateTime.makeUnsafe(T0),
    completedAt: run.endsAt === undefined ? null : DateTime.makeUnsafe(run.endsAt),
  })),
  subagents: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  turnItems: runs
    .filter((run) => run.blocked === true || run.blockedByCategory === true)
    .map((run, index) => ({
      id: `error-${run.id}`,
      type: "error",
      status: "failed",
      ordinal: index,
      runId: run.id,
      nodeId: `node-${run.id}`,
      updatedAt: DateTime.makeUnsafe(run.endsAt ?? T0),
      failure: run.blockedByCategory === true ? BLOCKED_BY_CATEGORY : BLOCKED,
    })),
});

const shell = (threadId: string, runs: ReadonlyArray<RunState>) => {
  const ends = runs.flatMap((run) => (run.endsAt === undefined ? [] : [run.endsAt]));
  return {
    id: threadId,
    deletedAt: null,
    activeRunId: runs.find((run) => LIVE.has(run.status))?.id ?? null,
    pendingRuntimeRequest: null,
    latestRunCompletedAt: ends.length === 0 ? null : DateTime.makeUnsafe(Math.max(...ends)),
  };
};

interface Harness {
  readonly threads: Ref.Ref<Threads>;
  readonly launches: Ref.Ref<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>;
}

const makeHarness = Effect.gen(function* () {
  return {
    threads: yield* Ref.make<Threads>(new Map()),
    launches: yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]),
  } satisfies Harness;
});

const setRuns = (harness: Harness, threadId: string, runs: ReadonlyArray<RunState>) =>
  Ref.update(harness.threads, (threads) => new Map(threads).set(threadId, runs));

const withService = <A, E>(
  harness: Harness,
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
              launch: (input) =>
                Effect.gen(function* () {
                  const launched = yield* Ref.updateAndGet(harness.launches, (all) => [
                    ...all,
                    input,
                  ]);
                  const threadId = `thread-${launched.length}`;
                  yield* setRuns(harness, threadId, [{ id: `${threadId}-run`, status: "running" }]);
                  return {
                    threadId: ThreadId.make(threadId),
                    projection: undefined as never,
                    resumed: false,
                  };
                }),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Ref.get(harness.threads).pipe(
                  Effect.map((threads) => {
                    const runs = threads.get(threadId);
                    return (runs === undefined ? null : shell(threadId, runs)) as never;
                  }),
                ),
              getThreadRecords: (threadId) =>
                Ref.get(harness.threads).pipe(
                  Effect.map((threads) => records(threadId, threads.get(threadId) ?? []) as never),
                ),
            }),
            NodeCrypto.layer,
            Scheduler.layer,
            Layer.mock(SecretRequests.SecretRequests)({}),
          ),
        ),
      );
      return yield* body.pipe(Effect.provideContext(context));
    }),
  );

const createTask = Effect.gen(function* () {
  const service = yield* ScheduledTaskService.ScheduledTaskService;
  const input = yield* decodeUpsertInput({
    title: "Nightly review",
    prompt: "Run the nightly review.",
    enabled: true,
    projectId: "project-follow",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "opencode", model: "opus/claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    schedule: { type: "interval", everyMs: 24 * 60 * minute },
  });
  return (yield* service.upsert(input)).task;
});

const currentTask = Effect.gen(function* () {
  const service = yield* ScheduledTaskService.ScheduledTaskService;
  const [task] = (yield* service.list()).tasks;
  assert.isDefined(task);
  return task!;
});

/** The scheduled run completes, then a run it woke is blocked (22 Oct nightly). */
const blockAfterWake = (harness: Harness, threadId: string, at: number) =>
  setRuns(harness, threadId, [
    { id: `${threadId}-run`, status: "completed", endsAt: at - minute },
    { id: `${threadId}-wake`, status: "failed", endsAt: at, blocked: true },
  ]);

const blockAfterWakeWithCategory = (harness: Harness, threadId: string, at: number) =>
  setRuns(harness, threadId, [
    { id: `${threadId}-run`, status: "completed", endsAt: at - minute },
    { id: `${threadId}-wake`, status: "failed", endsAt: at, blockedByCategory: true },
  ]);

it.effect("keeps a run running until its thread settles, then records the provider error", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const harness = yield* makeHarness;
    yield* withService(
      harness,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const task = yield* createTask;
        const ran = yield* service.runNow({ id: task.id });
        assert.equal(ran.task.lastRunStatus, "running");
        assert.equal(ran.task.runCount, 1);

        yield* TestClock.adjust("10 minutes");
        assert.equal((yield* currentTask).lastRunStatus, "running");

        yield* blockAfterWake(harness, "thread-1", T0 + 10 * minute);
        yield* TestClock.adjust(FOLLOW_QUIET_MS - minute);
        assert.equal((yield* currentTask).lastRunStatus, "running");

        yield* TestClock.adjust("2 minutes");
        const settled = yield* currentTask;
        assert.equal(settled.lastRunStatus, "failed");
        assert.equal(settled.lastRunError, "Provider blocked the response");
        assert.equal(settled.runCount, 1);
        // Not opted in: nothing is retried.
        assert.equal((yield* Ref.get(harness.launches)).length, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("records success once the thread has been quiet", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const harness = yield* makeHarness;
    yield* withService(
      harness,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const task = yield* createTask;
        yield* service.runNow({ id: task.id });
        yield* setRuns(harness, "thread-1", [
          { id: "thread-1-run", status: "completed", endsAt: T0 + minute },
        ]);
        yield* TestClock.adjust(FOLLOW_QUIET_MS + 2 * minute);
        const settled = yield* currentTask;
        assert.equal(settled.lastRunStatus, "succeeded");
        assert.isNull(settled.lastRunError);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("retries a blocked run once on the first fallback model and follows the retry", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const harness = yield* makeHarness;
    yield* withService(
      harness,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        const task = yield* createTask;
        const fallback = { instanceId: "opencode", model: "opus/gpt-6-astra" } as never;
        yield* writeBlockRetry(sql, task, { fallbacks: [fallback], limits: FULL });
        yield* service.runNow({ id: task.id });
        // An edit after the run started doesn't change what the retry runs.
        yield* service.upsert(
          yield* decodeUpsertInput({
            id: task.id,
            title: task.title,
            prompt: "Something else.",
            enabled: true,
            schedule: task.schedule,
            projectId: task.projectId,
            workspaceStrategy: task.workspaceStrategy,
            modelSelection: task.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: task.interactionMode,
          }),
        );

        yield* blockAfterWake(harness, "thread-1", T0 + 2 * minute);
        yield* TestClock.adjust(FOLLOW_QUIET_MS + 3 * minute);

        const launches = yield* Ref.get(harness.launches);
        assert.equal(launches.length, 2);
        const retry = launches[1]!;
        assert.isTrue(retry.commandId.endsWith(":retry:0"));
        assert.equal(retry.modelSelection.model, "opus/gpt-6-astra");
        assert.equal(retry.runtimeMode, "full-access");
        assert.equal(retry.initialMessage?.scheduledTaskId, task.id);
        assert.isTrue(retry.initialMessage?.text.startsWith("Run the nightly review.") ?? false);
        assert.include(retry.initialMessage?.text ?? "", "(t3-thread://v1/thread-1)");
        // The blocked thread is left alone and the run is still followed.
        assert.equal((yield* currentTask).lastRunStatus, "running");

        yield* setRuns(harness, "thread-2", [
          { id: "thread-2-run", status: "completed", endsAt: T0 + 9 * minute },
        ]);
        yield* TestClock.adjust(FOLLOW_QUIET_MS + minute);
        const settled = yield* currentTask;
        assert.equal(settled.lastRunStatus, "succeeded");
        assert.equal((yield* Ref.get(harness.launches)).length, 2);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("retries a content_filter category once even without the legacy code", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const harness = yield* makeHarness;
    yield* withService(
      harness,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        const task = yield* createTask;
        const fallback = { instanceId: "opencode", model: "opus/gpt-6-astra" } as never;
        yield* writeBlockRetry(sql, task, { fallbacks: [fallback], limits: FULL });
        yield* service.runNow({ id: task.id });

        yield* blockAfterWakeWithCategory(harness, "thread-1", T0 + 2 * minute);
        yield* TestClock.adjust(FOLLOW_QUIET_MS + 3 * minute);

        const launches = yield* Ref.get(harness.launches);
        assert.equal(launches.length, 2);
        assert.isTrue(launches[1]!.commandId.endsWith(":retry:0"));
        assert.equal(launches[1]!.modelSelection.model, "opus/gpt-6-astra");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("never retries a retry", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const harness = yield* makeHarness;
    yield* withService(
      harness,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        const task = yield* createTask;
        const fallbacks = [
          { instanceId: "opencode", model: "opus/gpt-6-astra" },
          { instanceId: "opencode", model: "layso/gpt-6-astra" },
        ] as never;
        yield* writeBlockRetry(sql, task, { fallbacks, limits: FULL });
        yield* service.runNow({ id: task.id });

        yield* blockAfterWake(harness, "thread-1", T0 + 2 * minute);
        yield* TestClock.adjust(FOLLOW_QUIET_MS + 3 * minute);
        assert.equal((yield* Ref.get(harness.launches)).length, 2);

        yield* blockAfterWake(harness, "thread-2", T0 + 9 * minute);
        yield* TestClock.adjust(FOLLOW_QUIET_MS + minute);
        const settled = yield* currentTask;
        assert.equal(settled.lastRunStatus, "failed");
        assert.equal(
          settled.lastRunError,
          "Retry after a blocked response failed: Provider blocked the response",
        );
        yield* TestClock.adjust("30 minutes");
        assert.equal((yield* Ref.get(harness.launches)).length, 2);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("never retries with broader modes than whoever turned the retry on", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const harness = yield* makeHarness;
    yield* withService(
      harness,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        const task = yield* createTask;
        // Turned on by an approval-required caller while a full-access launch was in flight.
        yield* writeBlockRetry(sql, task, {
          fallbacks: [{ instanceId: "opencode", model: "opus/gpt-6-astra" }] as never,
          limits: { runtimeMode: "approval-required", interactionMode: "default" },
        });
        yield* service.runNow({ id: task.id });

        yield* blockAfterWake(harness, "thread-1", T0 + 2 * minute);
        yield* TestClock.adjust(FOLLOW_QUIET_MS + 3 * minute);
        assert.equal((yield* Ref.get(harness.launches)).length, 1);
        const settled = yield* currentTask;
        assert.equal(settled.lastRunStatus, "failed");
        assert.include(settled.lastRunError ?? "", "The retry wasn't started");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("keeps following a run across a server restart", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const harness = yield* makeHarness;
    yield* withService(
      harness,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const task = yield* createTask;
        yield* service.runNow({ id: task.id });
      }),
    );
    yield* withService(
      harness,
      Effect.gen(function* () {
        assert.equal((yield* currentTask).lastRunStatus, "running");
        yield* setRuns(harness, "thread-1", [
          { id: "thread-1-run", status: "completed", endsAt: T0 + minute },
        ]);
        yield* TestClock.adjust(FOLLOW_QUIET_MS + 2 * minute);
        assert.equal((yield* currentTask).lastRunStatus, "succeeded");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("lets the next occurrence fire while a run is still followed", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const harness = yield* makeHarness;
    yield* withService(
      harness,
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const task = yield* createTask;
        yield* service.runNow({ id: task.id });
        // thread-1 never settles; the next daily occurrence still starts.
        yield* TestClock.adjust("1441 minutes");
        assert.equal((yield* Ref.get(harness.launches)).length, 2);
        const next = yield* currentTask;
        assert.equal(next.lastRunStatus, "running");
        assert.equal(next.runCount, 2);

        // Only the newest occurrence writes the status.
        yield* blockAfterWake(harness, "thread-1", T0 + 1441 * minute);
        yield* setRuns(harness, "thread-2", [
          { id: "thread-2-run", status: "completed", endsAt: T0 + 1441 * minute },
        ]);
        yield* TestClock.adjust(FOLLOW_QUIET_MS + minute);
        assert.equal((yield* currentTask).lastRunStatus, "succeeded");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
