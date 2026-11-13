import {
  AnalyticsReadInput,
  AnalyticsReadResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const AnalyticsRead = Tool.make("analytics_read", {
  description:
    "Read local owner-action, performance, run usage and error analytics for a UTC day (YYYY-MM-DD). Returns the daily rollup plus up to 500 recent samples, optionally filtered by kind, boardId or cardId. No prompts, messages or search text are recorded.",
  parameters: AnalyticsReadInput,
  success: AnalyticsReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const AnalyticsToolkit = Toolkit.make(AnalyticsRead);
