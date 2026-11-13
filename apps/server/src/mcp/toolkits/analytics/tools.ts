import {
  AnalyticsReadInput,
  AnalyticsReadResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const AnalyticsRead = Tool.make("analytics_read", {
  description:
    "Read local analytics for a UTC day (YYYY-MM-DD). Returns the retained-events rollup and up to 500 samples mixed by kind (50 per kind by default, board kinds first); filter by kind, boardId, tool or outcome. Board rollups include stage dwell, review rounds/verdicts, stalls, failures, open asks and hourly pool snapshots; board reads omit performance.long-task. Open asks are observed at the latest complete hourly backlog snapshot plus later events; incompleteAskSnapshots reports snapshots with missing rows, with ages at read time (day-end for past days). kind=mcp.call includes per-tool/hour/build outcomes, phases, saved state and same-id retry counts (adjacent attempts, attributed to the failed call). Retry correlation covers the selected day's filtered rows only; mcpOverflow reports capped data. No arguments, result bodies or raw request ids are recorded.",
  parameters: AnalyticsReadInput,
  success: AnalyticsReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const AnalyticsToolkit = Toolkit.make(AnalyticsRead);
