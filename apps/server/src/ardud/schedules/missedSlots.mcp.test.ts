import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ScheduledTaskId } from "@t3tools/contracts";
import { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";

const encodeRun = Schema.encodeSync(ThreadToolkit.tools.run_scheduled_task_now.successSchema);

it("keeps missed history and reason when the manual-run MCP response is encoded", () => {
  const history = [
    {
      slotAt: "2026-11-09T20:00:00.000Z",
      recordedAt: "2026-11-09T23:00:00.000Z",
      reason: "Robob unavailable",
      catchUpAt: null,
    },
  ];
  const result = encodeRun({
    taskId: ScheduledTaskId.make("scheduled-task:test"),
    threadId: null,
    lastRunStatus: "missed",
    lastRunError: "Robob unavailable",
    missedRuns: history,
    runCount: 0,
    nextRunAt: null,
  });
  expect(result.lastRunError).toBe("Robob unavailable");
  expect(result.missedRuns).toEqual(history);
});
