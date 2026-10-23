/**
 * ardud schedules: a scheduled run's status follows the work it started.
 *
 * Upstream marks a run "succeeded" as soon as its message is dispatched. Here
 * the row stays "running" while the run is followed. A task that starts a new
 * thread follows that thread (the run, its subagents and the runs they wake)
 * until it has been quiet for a while. A task bound to a thread follows only
 * the run its message queued, since other work shares that thread.
 *
 * A task can opt in to one retry on a fallback model when the provider blocked
 * the response. The blocked thread is left as it is so it can't write or send
 * again, and a retry is never retried.
 */
import {
  CommandId,
  MessageId,
  ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  RunId,
  type ScheduledTask,
  type ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { owedDelegatedCompletion } from "../archive-if-idle/idle.ts";
import { runningBackgroundWork } from "../context-reset/backgroundWork.ts";

const FOLLOWS_DDL = `CREATE TABLE IF NOT EXISTS ardud_scheduled_task_follows (
  task_id TEXT NOT NULL,
  task_created_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  since TEXT NOT NULL,
  fire_key TEXT NOT NULL,
  prompt TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open',
  retry_index INTEGER NOT NULL DEFAULT 0,
  blocked_thread_id TEXT,
  blocked_error TEXT,
  PRIMARY KEY (task_id, started_at)
)`;

const BLOCK_RETRY_DDL = `CREATE TABLE IF NOT EXISTS ardud_scheduled_task_block_retry (
  task_id TEXT PRIMARY KEY,
  task_created_at TEXT NOT NULL,
  fallbacks_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const ready = new WeakSet<SqlClient.SqlClient>();

export const ensureRunFollowTables = Effect.fn("ScheduledTaskRunFollow.ensureTables")(function* (
  sql: SqlClient.SqlClient,
): Effect.fn.Return<void, SqlError.SqlError> {
  if (ready.has(sql)) return;
  yield* sql.unsafe(FOLLOWS_DDL);
  yield* sql.unsafe(BLOCK_RETRY_DDL);
  // A table made inside a transaction that rolls back is gone again.
  if (Option.isNone(yield* Effect.serviceOption(sql.transactionService))) ready.add(sql);
});

export const followKey = (taskId: string, startedAt: string | null): string =>
  `${taskId}\u0000${startedAt ?? ""}`;

/**
 * How long a thread must stay quiet before its outcome counts. It covers the
 * gap between a run ending and the run it wakes starting, and restart recovery
 * resuming a cut thread a few minutes after Robob is back.
 */
export const FOLLOW_QUIET_MS = 5 * 60_000;

const BLOCKED_CODE = "provider.content-filter";
const BLOCKED_MESSAGE = "Provider blocked the response";
const LIVE_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export type FollowVerdict =
  | { readonly _tag: "wait" }
  | {
      readonly _tag: "settled";
      readonly status: "succeeded" | "failed";
      readonly error: string | null;
      readonly blocked: boolean;
    };

const WAIT: FollowVerdict = { _tag: "wait" };
const SUCCEEDED: FollowVerdict = {
  _tag: "settled",
  status: "succeeded",
  error: null,
  blocked: false,
};
const failed = (error: string, blocked = false): FollowVerdict => ({
  _tag: "settled",
  status: "failed",
  error,
  blocked,
});

type FollowedRun = Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "turnItems">;

export type FollowedThread = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "subagents"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "turnItems"
>;

const runOutcome = (
  run: OrchestrationV2Run,
  turnItems: FollowedRun["turnItems"],
): FollowVerdict => {
  if (run.status === "completed") return SUCCEEDED;
  if (run.status !== "failed") return failed(`The run ended ${run.status}.`);
  const failure = latestRootProviderFailure(run, turnItems);
  return failed(
    failure?.message ?? "The run failed.",
    failure?.code === BLOCKED_CODE || failure?.message === BLOCKED_MESSAGE,
  );
};

const latestCompletion = (projection: FollowedThread, sinceMs: number): number => {
  let latest = sinceMs;
  for (const work of [...projection.runs, ...projection.subagents]) {
    if (work.completedAt === null) continue;
    latest = Math.max(latest, DateTime.toEpochMillis(work.completedAt));
  }
  return latest;
};

/** A new thread's outcome, once nothing in it is still working or owed. */
export const threadVerdict = (
  projection: FollowedThread,
  sinceMs: number,
  nowMs: number,
): FollowVerdict => {
  const { thread, runs } = projection;
  if (thread.deletedAt !== null) return failed("The thread was deleted.");
  if (runs.some((run) => LIVE_RUN_STATUSES.has(run.status))) return WAIT;
  if (runs.some((run) => run.status === "queued" && run.queueHeld !== true)) return WAIT;
  if (projection.runtimeRequests.some((request) => request.status === "pending")) return WAIT;
  if (runningBackgroundWork(projection).length > 0) return WAIT;
  const runlessTurn = projection.providerTurns.some(
    (turn) =>
      turn.runAttemptId === null && (turn.status === "pending" || turn.status === "running"),
  );
  if (runlessTurn) return WAIT;
  if (owedDelegatedCompletion(projection) !== null) return WAIT;
  if (thread.limitRecovery?.autoResume === true) return WAIT;
  if (nowMs - latestCompletion(projection, sinceMs) < FOLLOW_QUIET_MS) return WAIT;

  // Held queued runs stay held; they never count as finished work.
  const held = runs.some((run) => run.status === "queued");
  const latest = latestExecutedRun(runs);
  if (latest === null) {
    return failed(held ? "The run is held in the thread's queue." : "The run never started.");
  }
  const outcome = runOutcome(latest, projection.turnItems);
  if (outcome._tag === "settled" && outcome.status === "succeeded" && held) {
    return failed("Work is still held in the thread's queue.");
  }
  return outcome;
};

/** A bound task's outcome: only the run its message queued. */
export const runVerdict = (projection: FollowedRun, runId: RunId): FollowVerdict => {
  if (projection.thread.deletedAt !== null) return failed("The thread was deleted.");
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return failed("The scheduled run is gone.");
  if (run.status === "queued" && run.queueHeld === true) {
    return failed("The run is held in the thread's queue.");
  }
  if (run.status === "queued" || LIVE_RUN_STATUSES.has(run.status)) return WAIT;
  return runOutcome(run, projection.turnItems);
};

export const blockedRetryPrompt = (
  prompt: string,
  title: string,
  blockedThreadId: string,
): string =>
  [
    prompt,
    "",
    "---",
    `This is a retry. The provider blocked the response in this scheduled task's first run, [${title}](t3-thread://v1/${blockedThreadId}). That thread is left as it is. Read it before redoing work it already finished.`,
  ].join("\n");

const FallbacksJson = Schema.fromJsonString(Schema.Array(ModelSelection));
const decodeFallbacks = Schema.decodeUnknownOption(FallbacksJson);
const encodeFallbacks = Schema.encodeEffect(FallbacksJson);

/** The task's fallback models for a blocked run, in order; empty when it hasn't opted in. */
export const readBlockRetry = Effect.fn("ScheduledTaskRunFollow.readBlockRetry")(function* (
  sql: SqlClient.SqlClient,
  task: Pick<ScheduledTask, "id" | "createdAt">,
): Effect.fn.Return<ReadonlyArray<ModelSelection>, SqlError.SqlError> {
  yield* ensureRunFollowTables(sql);
  // created_at ties the opt-in to this task, not a later one reusing its id.
  const rows = yield* sql<{ readonly fallbacks_json: string }>`
    SELECT fallbacks_json FROM ardud_scheduled_task_block_retry
    WHERE task_id = ${task.id} AND task_created_at = ${task.createdAt}
  `;
  const row = rows[0];
  if (row === undefined) return [];
  return Option.getOrElse(decodeFallbacks(row.fallbacks_json), () => []);
});

export const writeBlockRetry = Effect.fn("ScheduledTaskRunFollow.writeBlockRetry")(function* (
  sql: SqlClient.SqlClient,
  task: Pick<ScheduledTask, "id" | "createdAt">,
  fallbacks: ReadonlyArray<ModelSelection> | null,
): Effect.fn.Return<void, SqlError.SqlError> {
  yield* ensureRunFollowTables(sql);
  if (fallbacks === null) {
    yield* sql`DELETE FROM ardud_scheduled_task_block_retry WHERE task_id = ${task.id}`;
    return;
  }
  const json = yield* encodeFallbacks(fallbacks).pipe(Effect.orDie);
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO ardud_scheduled_task_block_retry (task_id, task_created_at, fallbacks_json, updated_at)
    VALUES (${task.id}, ${task.createdAt}, ${json}, ${nowIso})
    ON CONFLICT (task_id) DO UPDATE SET
      task_created_at = excluded.task_created_at,
      fallbacks_json = excluded.fallbacks_json,
      updated_at = excluded.updated_at
  `;
});

interface FollowRow {
  readonly task_id: string;
  readonly task_created_at: string;
  readonly started_at: string;
  readonly since: string;
  readonly fire_key: string;
  readonly prompt: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly attempt: number;
  readonly state: string;
  readonly retry_index: number;
  readonly blocked_thread_id: string | null;
  readonly blocked_error: string | null;
}

export interface FollowTarget {
  readonly threadId: ThreadId;
  /** Set for a bound task: only this run is followed. */
  readonly runId: RunId | null;
}

export interface RecordFollowInput {
  readonly task: ScheduledTask;
  readonly startedAtIso: string;
  readonly fireKey: string;
  readonly prompt: string;
  readonly target: FollowTarget;
}

const isThreadGone = (error: unknown): boolean =>
  Predicate.hasProperty(error, "cause") &&
  Predicate.hasProperty(error.cause, "_tag") &&
  error.cause._tag === "ProjectionStoreThreadNotFoundError";

export const makeRunFollower = (deps: {
  readonly sql: SqlClient.SqlClient;
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly launcher: ThreadLaunchService.ThreadLaunchService["Service"];
  readonly findTask: (
    id: ScheduledTaskId,
  ) => Effect.Effect<ScheduledTask | null, ScheduledTaskError>;
  readonly notifyChanged: Effect.Effect<void>;
}) => {
  const { sql, threads, launcher, findTask, notifyChanged } = deps;

  /** Starts following a dispatched run; call it in the transaction that records the dispatch. */
  const record = (input: RecordFollowInput) =>
    ensureRunFollowTables(sql).pipe(
      Effect.andThen(
        sql`
          INSERT INTO ardud_scheduled_task_follows
            (task_id, task_created_at, started_at, since, fire_key, prompt, thread_id, run_id)
          VALUES (
            ${input.task.id}, ${input.task.createdAt}, ${input.startedAtIso}, ${input.startedAtIso},
            ${input.fireKey}, ${input.prompt}, ${input.target.threadId}, ${input.target.runId}
          )
          ON CONFLICT (task_id, started_at) DO NOTHING
        `,
      ),
      Effect.asVoid,
    );

  /** Runs that are still followed; restart recovery leaves them to the follower. */
  const followedKeys = Effect.gen(function* () {
    yield* ensureRunFollowTables(sql);
    const rows = yield* sql<{ readonly task_id: string; readonly started_at: string }>`
      SELECT task_id, started_at FROM ardud_scheduled_task_follows
    `;
    return new Set(rows.map((row) => followKey(row.task_id, row.started_at)));
  });

  const dropFollow = (row: FollowRow) =>
    sql`
      DELETE FROM ardud_scheduled_task_follows
      WHERE task_id = ${row.task_id} AND started_at = ${row.started_at}
    `.pipe(Effect.asVoid);

  const settle = Effect.fn("ScheduledTaskRunFollow.settle")(function* (
    row: FollowRow,
    status: "succeeded" | "failed",
    error: string | null,
  ) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    // The guard writes only to the occurrence this follow belongs to.
    yield* sql.withTransaction(
      sql`
        UPDATE scheduled_tasks
        SET last_run_status = ${status}, last_run_error = ${error}, updated_at = ${nowIso}
        WHERE task_id = ${row.task_id} AND created_at = ${row.task_created_at}
          AND last_run_status = 'running' AND last_run_at = ${row.started_at}
      `.pipe(Effect.andThen(dropFollow(row))),
    );
    yield* notifyChanged;
  });

  const orGone = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.catchIf(isThreadGone, () => Effect.succeed(null)));

  const followThread = Effect.fn("ScheduledTaskRunFollow.followThread")(function* (row: FollowRow) {
    const threadId = ThreadId.make(row.thread_id);
    const shell = yield* orGone(threads.getThreadShell(threadId));
    if (shell === null) return failed("The thread is gone.");
    // Cheap checks first; the full read only happens once the thread looks idle.
    if (shell.activeRunId !== null || shell.pendingRuntimeRequest !== null) return WAIT;
    const nowMs = yield* Clock.currentTimeMillis;
    const latestEnd = shell.latestRunCompletedAt ?? null;
    const quietSince = Math.max(
      Date.parse(row.since),
      latestEnd === null ? 0 : DateTime.toEpochMillis(latestEnd),
    );
    if (nowMs - quietSince < FOLLOW_QUIET_MS) return WAIT;
    const records = yield* orGone(
      threads.getThreadRecords(
        threadId,
        ["runs", "subagents", "providerThreads", "providerTurns", "runtimeRequests", "turnItems"],
        { turnItemTypes: ["error"] },
      ),
    );
    if (records === null) return failed("The thread is gone.");
    return threadVerdict(records, Date.parse(row.since), nowMs);
  });

  const followRun = Effect.fn("ScheduledTaskRunFollow.followRun")(function* (
    row: FollowRow,
    runId: RunId,
  ) {
    const records = yield* orGone(
      threads.getThreadRecords(ThreadId.make(row.thread_id), ["runs", "turnItems"], {
        runIds: [runId],
        turnItemRunIds: [runId],
        turnItemTypes: ["error"],
      }),
    );
    if (records === null) return failed("The thread is gone.");
    return runVerdict(records, runId);
  });

  const retryBlocked = Effect.fn("ScheduledTaskRunFollow.retryBlocked")(function* (
    task: ScheduledTask,
    row: FollowRow,
    blockedThreadId: string,
    blockedError: string,
  ) {
    const fallbacks = yield* readBlockRetry(sql, task);
    for (let index = row.retry_index; index < fallbacks.length; index += 1) {
      const modelSelection = fallbacks[index];
      if (modelSelection === undefined) break;
      // Recorded before the launch: after a crash the retry resumes with the
      // same command id, which the launch treats as a replay.
      yield* sql`
        UPDATE ardud_scheduled_task_follows
        SET state = 'retrying', retry_index = ${index},
          blocked_thread_id = ${blockedThreadId}, blocked_error = ${blockedError}
        WHERE task_id = ${row.task_id} AND started_at = ${row.started_at}
      `;
      const launched = yield* Effect.exit(
        launcher.launch({
          commandId: CommandId.make(`scheduled-task:${row.fire_key}:retry:${index}`),
          projectId: task.projectId,
          title: `${task.title} (retry)`,
          modelSelection,
          runtimeMode: task.runtimeMode,
          interactionMode: task.interactionMode,
          workspaceStrategy: task.workspaceStrategy,
          initialMessage: {
            messageId: MessageId.make(`scheduled-task-message:${row.fire_key}:retry:${index}`),
            scheduledTaskId: task.id,
            text: blockedRetryPrompt(row.prompt, task.title, blockedThreadId),
            attachments: [],
          },
          createdBy: task.createdBy,
          creationSource: task.creationSource,
        }),
      );
      if (Exit.isSuccess(launched)) {
        const sinceIso = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE ardud_scheduled_task_follows
          SET state = 'open', attempt = 1, thread_id = ${launched.value.threadId}, since = ${sinceIso}
          WHERE task_id = ${row.task_id} AND started_at = ${row.started_at}
        `;
        return;
      }
      if (Cause.hasInterruptsOnly(launched.cause)) return yield* Effect.failCause(launched.cause);
      yield* Effect.logWarning("Could not start the retry of a blocked scheduled run", {
        taskId: task.id,
        model: modelSelection.model,
        cause: Cause.pretty(launched.cause),
      });
    }
    yield* settle(row, "failed", `${blockedError}. The retry on a fallback model did not start.`);
  });

  const followOne = Effect.fn("ScheduledTaskRunFollow.followOne")(function* (row: FollowRow) {
    const task = yield* findTask(ScheduledTaskId.make(row.task_id));
    // Deleted, recreated, or a newer occurrence took over the row.
    if (
      task === null ||
      task.createdAt !== row.task_created_at ||
      task.lastRunAt !== row.started_at ||
      task.lastRunStatus !== "running"
    ) {
      return yield* dropFollow(row);
    }
    if (row.state === "retrying") {
      return yield* retryBlocked(
        task,
        row,
        row.blocked_thread_id ?? row.thread_id,
        row.blocked_error ?? BLOCKED_MESSAGE,
      );
    }
    const verdict =
      row.run_id === null
        ? yield* followThread(row)
        : yield* followRun(row, RunId.make(row.run_id));
    if (verdict._tag === "wait") return;
    if (verdict.blocked && row.run_id === null && row.attempt === 0) {
      const fallbacks = yield* readBlockRetry(sql, task);
      if (fallbacks.length > 0) {
        return yield* retryBlocked(task, row, row.thread_id, verdict.error ?? BLOCKED_MESSAGE);
      }
    }
    const error =
      row.attempt > 0 && verdict.error !== null
        ? `Retry after a blocked response failed: ${verdict.error}`
        : verdict.error;
    yield* settle(row, verdict.status, error);
  });

  const sweep = Effect.gen(function* () {
    yield* ensureRunFollowTables(sql);
    const rows = yield* sql<FollowRow>`
      SELECT * FROM ardud_scheduled_task_follows ORDER BY started_at ASC, task_id ASC
    `;
    yield* Effect.forEach(
      rows,
      (row) =>
        followOne(row).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("Could not follow a scheduled task run", {
                  taskId: row.task_id,
                  threadId: row.thread_id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });

  return { record, followedKeys, sweep };
};
