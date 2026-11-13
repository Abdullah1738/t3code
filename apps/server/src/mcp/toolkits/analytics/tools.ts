import {
  AnalyticsReadInput,
  AnalyticsReadResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const AnalyticsRead = Tool.make("analytics_read", {
  description:
    "Read local owner-action, performance, run usage and error analytics for a UTC day (YYYY-MM-DD). Returns the retained-events rollup and up to 500 recent samples; filter by kind, boardId, cardId, tool or outcome. kind=run.usage includes model, role, board and card totals plus top cards by tokens and wall time. kind=kanban.tick_phase returns tickPhases with per-board/phase count and p50Ms/p95Ms/maxMs; kanban.tick_overlap records passes limited to local waits. kind=mcp.call includes per-tool/hour/build/boot outcomes, phases, saved state and same-id retry counts (adjacent attempts, attributed to the failed call). Retry correlation covers the selected day's filtered rows only; mcpOverflow reports capped data. No prompts, messages, search text, arguments, result bodies or raw request ids are recorded.",
  parameters: AnalyticsReadInput,
  success: AnalyticsReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const AnalyticsToolkit = Toolkit.make(AnalyticsRead);
