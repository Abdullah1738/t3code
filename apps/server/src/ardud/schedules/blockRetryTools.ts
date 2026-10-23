import {
  OrchestratorMcpFailure,
  ScheduledTaskBlockRetryMcpInput,
  ScheduledTaskBlockRetryMcpResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { assertTargetWithinLimits, loadCaller, unavailable } from "../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { readBlockRetry, writeBlockRetry } from "./runFollow.ts";

const ScheduledTaskBlockRetryTool = Tool.make("t3_scheduled_task_block_retry", {
  description:
    "Read or set a scheduled task's retry for blocked responses. When a run of a task that starts a new thread ends with 'Provider blocked the response', T3 starts one new thread on the first fallback model that launches, with the original prompt and a link to the blocked thread. The blocked thread is left as it is, and the retry is never retried. Pass fallbacks to turn it on, null to turn it off, or leave it out to read it. Tasks bound to an existing thread can't retry.",
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
      const { limits } = yield* loadCaller();
      const schedules = yield* ScheduledTaskService.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const { tasks } = yield* schedules.list().pipe(Effect.mapError(unavailable));
      const task = tasks.find((candidate) => candidate.id === input.scheduledTaskId);
      if (task === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "task_not_found",
          message: "The scheduled task was not found.",
        });
      }
      // The retry runs with the task's modes, so a caller can't arm more than it may run.
      yield* assertTargetWithinLimits(limits, task);
      if (input.fallbacks !== undefined) {
        if (input.fallbacks !== null && task.threadId !== null) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Only tasks that start a new thread can retry; this one posts into an existing thread.",
          });
        }
        yield* writeBlockRetry(sql, task, input.fallbacks).pipe(Effect.mapError(unavailable));
      }
      const fallbacks = yield* readBlockRetry(sql, task).pipe(Effect.mapError(unavailable));
      return { scheduledTaskId: task.id, fallbacks };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ScheduledTaskBlockRetryToolkit.tools>;

export const layer = McpToolAccess.toLayer(ScheduledTaskBlockRetryToolkit, handlers);
