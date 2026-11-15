import {
  AnalyticsReadInput,
  AnalyticsReadResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const AnalyticsRead = Tool.make("analytics_read", {
  description:
    "Read retained analytics for a UTC day (YYYY-MM-DD), filtered by kind, boardId, cardId, tool or outcome. kind=kanban.evaluator with boardId and day returns evaluatorStartsByTrigger and evaluatorOutcomes (purpose, trigger, outcome and reuse-miss reason); outcome=started filters to new threads. Every JSON reply fits 50,000 characters. Small days include all requested data; larger days return a compact rollup preview plus sections [{name, rows, chars}]. Fetch section by name, then repeat with cursor and the same filters while hasMore (limit may change). Section rows carry paths relative to the section, including nested lists. Cursors retain an immutable view until eviction (16 section snapshots) or restart; restart the section if expired. Oversized individual rows are trimmed and marked truncated. samples pages the retained mixed sample view (at most 500), not the event log.",
  parameters: AnalyticsReadInput,
  success: AnalyticsReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const AnalyticsToolkit = Toolkit.make(AnalyticsRead);
