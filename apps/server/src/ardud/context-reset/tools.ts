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
    "Needs an agent running inside a T3 thread. Only for a fresh start the user or a bridge asks for, not for a large context: the provider compacts by itself. Write a resume note first (point it at the plan or notes file), then call this as the last action of the turn: T3 ends your current provider session and starts a fresh one in this thread with the note as its only context. The thread, its history, workspace, model, schedules and watchers stay the same. Refused while this thread has running background subagents or tasks (the refusal names them); wait for them, or pass cancelBackgroundWork: true to stop them first and get them listed at the end of the resume note.",
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
