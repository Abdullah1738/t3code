import {
  ImessageSendMcpInput,
  ImessageSendMcpResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ImessageSendService from "./ImessageSendService.ts";

export const IMESSAGE_SEND_DESCRIPTION =
  "Text the iMessage chat this thread serves (or `to` another chat, only from the owner's chat). In iMessage threads your final message is not sent: this is the only way to reply. Send whenever useful while you keep working; each call sends once. Use `file` for images or files (`text` becomes the caption). Plain text only. Refused outside iMessage chat threads.";

const ImessageSendTool = Tool.make("imessage_send", {
  description: IMESSAGE_SEND_DESCRIPTION,
  parameters: ImessageSendMcpInput,
  success: ImessageSendMcpResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ImessageSendService.ImessageSendService,
  ],
})
  .annotate(Tool.Title, "Send an iMessage")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ImessageSendToolkit = Toolkit.make(ImessageSendTool);
