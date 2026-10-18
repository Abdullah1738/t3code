/**
 * Who may change, run, or see the URL of a scheduled task. A task bound to a
 * thread puts text into that thread every time it fires, so every change to
 * it is a send into that thread: the caller must be allowed to reach the
 * bound thread (old and new) through the send guard. The caller that passes
 * becomes the task's recorded authority, which is who the runs speak as.
 *
 * The caller comes from `CurrentPrincipal`, set by the transport. Unset is an
 * in-process caller (master succession moving schedules), which passes.
 */
import {
  ScheduledTaskError,
  type ScheduledTask,
  type ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import {
  guardScheduledRun,
  guardSender,
  SendRefused,
  type SendGuardFailed,
} from "../router/guardPaths.ts";
import type { AuthorityStore } from "./authority.ts";
import { CurrentPrincipal, principalKey, samePrincipal, type GuardPrincipal } from "./principal.ts";

/**
 * Checks the current caller against every thread the task is or will be bound
 * to. Returns the caller (undefined for in-process callers). A refusal is a
 * `ScheduledTaskError` whose cause is the guard's `SendRefused`.
 */
export const authorizeScheduleChange = (input: {
  readonly taskId: ScheduledTaskId;
  readonly threads: ReadonlyArray<string | null | undefined>;
  readonly text: string;
}): Effect.Effect<GuardPrincipal | undefined, ScheduledTaskError> =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    if (principal === undefined || principal._tag === "owner") return principal;
    const threads = [...new Set(input.threads.filter((id): id is string => id != null))];
    for (const threadId of threads) {
      yield* guardSender({
        path: "schedule-edit",
        targetThreadId: ThreadId.make(threadId),
        from: principal,
        text: input.text,
        requestKey: `schedule-edit:${input.taskId}:${threadId}:${principalKey(principal)}:${input.text}`,
      }).pipe(
        Effect.mapError(
          (error) =>
            new ScheduledTaskError({ message: error.message, taskId: input.taskId, cause: error }),
        ),
      );
    }
    return principal;
  });

/**
 * What a save does to the task's recorded authority: the principal to bind,
 * `null` to clear it, or `undefined` to leave it. `withScheduleAuthority`
 * reads and binds it in the same transaction as the save, so a failed write
 * never leaves an older authority behind a newer task.
 *
 * A caller that passed the guard becomes the authority. An in-process create
 * has none, so a row left by an earlier task with the same id is cleared. An
 * in-process retarget (master succession) carries a thread's own schedule over
 * to the thread it moved to. Any other in-process save leaves the record
 * alone, so the runs keep speaking as whoever last authorized the task through
 * a transport; an in-process caller acting for someone runs as them by
 * providing `CurrentPrincipal`.
 */
export const scheduleAuthorityChange = (
  store: AuthorityStore,
  input: {
    readonly taskId: ScheduledTaskId;
    readonly principal: GuardPrincipal | undefined;
    readonly created: boolean;
    readonly previousThreadId: string | null;
    readonly threadId: string | null;
  },
): Effect.Effect<GuardPrincipal | null | undefined> =>
  Effect.gen(function* () {
    if (input.principal !== undefined) return input.principal;
    if (input.created) return null;
    if (
      input.previousThreadId === null ||
      input.threadId === null ||
      input.previousThreadId === input.threadId
    ) {
      return undefined;
    }
    const authority = yield* store.read("scheduled-task", input.taskId);
    return authority?._tag === "thread" && authority.threadId === input.previousThreadId
      ? { ...authority, threadId: ThreadId.make(input.threadId) }
      : undefined;
  });

/**
 * Runs a schedule write and its authority change (see
 * `scheduleAuthorityChange`) in one transaction, so the write and the
 * authority it runs under land together or not at all. A failed bind rolls the
 * write back and fails the call.
 */
export const withScheduleAuthority = <A, E, R>(input: {
  readonly sql: SqlClient.SqlClient;
  readonly store: AuthorityStore;
  readonly taskId: ScheduledTaskId;
  readonly authority: Effect.Effect<GuardPrincipal | null | undefined>;
  readonly write: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | ScheduledTaskError, R> =>
  input.sql
    .withTransaction(
      Effect.gen(function* () {
        const authority = yield* input.authority;
        const result = yield* input.write;
        if (authority !== undefined) {
          yield* input.store.bind("scheduled-task", input.taskId, authority).pipe(
            Effect.mapError(
              (cause) =>
                new ScheduledTaskError({
                  message: "Could not record who authorized the schedule task.",
                  taskId: input.taskId,
                  cause,
                }),
            ),
          );
        }
        return result;
      }),
    )
    .pipe(
      Effect.mapError((error) =>
        isSqlError(error)
          ? new ScheduledTaskError({
              message: "Could not save the schedule task.",
              taskId: input.taskId,
              cause: error,
            })
          : error,
      ),
    );

/**
 * Who a run speaks as: the invoker of a manual run, else the recorded
 * authority (scheduled and webhook runs have no caller).
 */
export const scheduleRunAuthority = (
  store: AuthorityStore,
  taskId: ScheduledTaskId,
): Effect.Effect<GuardPrincipal | null> =>
  Effect.gen(function* () {
    const invoker = yield* CurrentPrincipal;
    return invoker ?? (yield* store.read("scheduled-task", taskId));
  });

/** Guards one run of a bound task (see `scheduleRunAuthority`). */
export const guardScheduleRun = (
  store: AuthorityStore,
  input: {
    readonly task: { readonly id: ScheduledTaskId; readonly title: string };
    readonly targetThreadId: ThreadId;
    readonly text: string;
    readonly commandId: string;
  },
): Effect.Effect<void, SendRefused | SendGuardFailed> =>
  scheduleRunAuthority(store, input.task.id).pipe(
    Effect.flatMap((authority) => guardScheduledRun({ ...input, authority })),
  );

/**
 * A webhook URL is a standing way to put text into the bound thread, so only
 * the owner, the bound thread itself, and the task's recorded authority see
 * it. Unbound tasks start a fresh thread per run and keep upstream behaviour.
 */
export const webhookVisible = (
  store: AuthorityStore,
  principal: GuardPrincipal | undefined,
  task: Pick<ScheduledTask, "id" | "threadId">,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (principal === undefined || principal._tag === "owner" || task.threadId === null) {
      return true;
    }
    if (principal._tag === "thread" && principal.threadId === task.threadId) return true;
    const authority = yield* store.read("scheduled-task", task.id);
    return authority !== null && samePrincipal(authority, principal);
  });

/**
 * Drops the webhook endpoint if the caller may not see it. The whole endpoint
 * goes, since its `path` carries the token even when there is no public URL.
 */
export const withoutHiddenWebhook = <T extends Pick<ScheduledTask, "id" | "threadId" | "webhook">>(
  store: AuthorityStore,
  principal: GuardPrincipal | undefined,
  task: T,
): Effect.Effect<T> =>
  task.webhook === undefined
    ? Effect.succeed(task)
    : webhookVisible(store, principal, task).pipe(
        Effect.map((visible) => {
          if (visible) return task;
          const { webhook: _hidden, ...rest } = task;
          return rest as T;
        }),
      );

/** Drops webhook endpoints the caller may not see. */
export const withoutHiddenWebhooks = <T extends Pick<ScheduledTask, "id" | "threadId" | "webhook">>(
  store: AuthorityStore,
  principal: GuardPrincipal | undefined,
  tasks: ReadonlyArray<T>,
): Effect.Effect<Array<T>> =>
  Effect.forEach(tasks, (task) => withoutHiddenWebhook(store, principal, task));

/** Whether a schedule call failed because the guard refused it. */
export const refusedByGuard = (error: ScheduledTaskError): boolean =>
  error.cause instanceof SendRefused;
