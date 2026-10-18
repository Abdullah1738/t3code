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
 * Records who authorized a save. An in-process retarget (master succession)
 * carries a thread's own schedule over to the thread it moved to; any other
 * in-process save leaves the record alone.
 */
export const recordScheduleAuthority = (
  store: AuthorityStore,
  input: {
    readonly taskId: ScheduledTaskId;
    readonly principal: GuardPrincipal | undefined;
    readonly previousThreadId: string | null;
    readonly threadId: string | null;
  },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (input.principal !== undefined) {
      return yield* store.record("scheduled-task", input.taskId, input.principal);
    }
    if (
      input.previousThreadId === null ||
      input.threadId === null ||
      input.previousThreadId === input.threadId
    ) {
      return;
    }
    const authority = yield* store.read("scheduled-task", input.taskId);
    if (authority?._tag === "thread" && authority.threadId === input.previousThreadId) {
      yield* store.record("scheduled-task", input.taskId, {
        ...authority,
        threadId: ThreadId.make(input.threadId),
      });
    }
  });

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

/** Drops webhook URLs the caller may not see. */
export const withoutHiddenWebhooks = <T extends Pick<ScheduledTask, "id" | "threadId" | "webhook">>(
  store: AuthorityStore,
  principal: GuardPrincipal | undefined,
  tasks: ReadonlyArray<T>,
): Effect.Effect<Array<T>> =>
  Effect.forEach(tasks, (task) =>
    task.webhook === undefined
      ? Effect.succeed(task)
      : webhookVisible(store, principal, task).pipe(
          Effect.map((visible) => {
            if (visible) return task;
            const { webhook: _hidden, ...rest } = task;
            return rest as T;
          }),
        ),
  );

/** Whether a schedule call failed because the guard refused it. */
export const refusedByGuard = (error: ScheduledTaskError): boolean =>
  error.cause instanceof SendRefused;
