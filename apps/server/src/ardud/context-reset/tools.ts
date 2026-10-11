import {
  ContextResetMcpInput,
  ContextResetMcpResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ContextResetService from "./ContextResetService.ts";

const ContextResetTool = Tool.make("t3_context_reset", {
  description:
    "Needs an agent running inside a T3 thread. Use when your context is nearly full and you want to keep working in this same thread. Write a resume note first (point it at the plan or notes file), then call this as the last action of the turn: T3 ends your current provider session and starts a fresh one in this thread with the note as its only context. The thread, its history, workspace, model, schedules and watchers stay the same. Refused while this thread has running background subagents or tasks; wait for them first. If this tool fails, fall back to t3_thread_launch with the same note.",
  parameters: ContextResetMcpInput,
  success: ContextResetMcpResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ContextResetService.ContextResetService,
  ],
})
  .annotate(Tool.Title, "Reset this thread's context")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ContextResetToolkit = Toolkit.make(ContextResetTool);
