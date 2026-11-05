import {
  OrchestratorMcpFailure,
  ScheduledTaskBlockRetryMcpInput,
  ScheduledTaskBlockRetryMcpResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { assertTargetWithinLimits, loadCaller, unavailable } from "../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { readBlockRetry, retryableLaunchModes, writeBlockRetry } from "./runFollow.ts";

const ScheduledTaskBlockRetryTool = Tool.make("t3_scheduled_task_block_retry", {
  description:
    "Read or set a scheduled task's retry for blocked responses. When a run of a task that starts a new thread ends with 'Provider blocked the response', T3 starts one new thread on the first fallback model that launches, with the original prompt and a link to the blocked thread. The blocked thread is left as it is, and the retry is never retried. The retry keeps the blocked run's modes and is skipped if those are broader than yours. Pass fallbacks to turn it on, null to turn it off, or leave it out to read it. Tasks bound to an existing thread can't retry.",
  parameters: ScheduledTaskBlockRetryMcpInput,
  success: ScheduledTaskBlockRetryMcpResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ScheduledTaskService.ScheduledTaskService,
    SqlClient.SqlClient,
  ],
})
  .annotate(Tool.Title, "Retry a scheduled task's blocked runs")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ScheduledTaskBlockRetryToolkit = Toolkit.make(ScheduledTaskBlockRetryTool);

const handlers = {
  t3_scheduled_task_block_retry: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { threads, limits } = yield* loadCaller();
      const schedules = yield* ScheduledTaskService.ScheduledTaskService;
      const sql = yield* BoardsDatabase.client;
      const { tasks } = yield* schedules.list().pipe(Effect.mapError(unavailable));
      const task = tasks.find((candidate) => candidate.id === input.scheduledTaskId);
      if (task === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "task_not_found",
          message: "The scheduled task was not found.",
        });
      }
      // The same bar as update_scheduled_task: the task's modes, and a bound
      // thread's current modes, must be within the caller's.
      yield* assertTargetWithinLimits(limits, task);
      if (task.threadId !== null) {
        const bound = yield* threads
          .getThreadShell(task.threadId)
          .pipe(Effect.mapError(unavailable));
        if (bound !== null && bound.deletedAt === null) {
          yield* assertTargetWithinLimits(limits, bound);
        }
      }
      if (input.fallbacks !== undefined) {
        if (input.fallbacks !== null && task.threadId !== null) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Only tasks that start a new thread can retry; this one posts into an existing thread.",
          });
        }
        if (input.fallbacks !== null) {
          // A run already started keeps the modes it started with, and so would its retry.
          const inFlight = yield* retryableLaunchModes(sql, task).pipe(
            Effect.mapError(unavailable),
          );
          for (const modes of inFlight) yield* assertTargetWithinLimits(limits, modes);
        }
        // The caller's modes go with it, so a retry can't run broader than the caller can.
        const setting =
          input.fallbacks === null
            ? null
            : {
                fallbacks: input.fallbacks,
                limits: {
                  runtimeMode: limits.runtimeMode,
                  interactionMode: limits.interactionMode,
                },
              };
        yield* writeBlockRetry(sql, task, setting).pipe(Effect.mapError(unavailable));
      }
      const setting = yield* readBlockRetry(sql, task).pipe(Effect.mapError(unavailable));
      return { scheduledTaskId: task.id, fallbacks: setting?.fallbacks ?? [] };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ScheduledTaskBlockRetryToolkit.tools>;

export const layer = McpToolAccess.toLayer(ScheduledTaskBlockRetryToolkit, handlers);
