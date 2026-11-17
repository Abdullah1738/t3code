import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import {
  ThreadRedactionInput,
  ThreadRedactionResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ThreadRedaction from "./ThreadRedaction.ts";

const RedactItemTool = Tool.make("t3_thread_redact_item", {
  description:
    "Owner only. Permanently replace one stopped thread tool item's output in Robob storage and supported provider files. Stop or interrupt the thread and background work first. Returns counts only. verify=true requires explicit compact:true to erase fragmented SQLite residue; VACUUM is heavy. Without it, logical redaction returns compacted:false and incomplete verification. Never put secret text in reason. needleFile optionally names an owned 0600 file; the caller removes it afterwards. Incomplete redaction keeps the readonly export paused. Retry an incomplete operation with the same item id on the original server; restarting requires explicit maintenance recovery. Card workers and thread credentials are denied.",
  parameters: ThreadRedactionInput,
  success: ThreadRedactionResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    ThreadManagementService.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
    ThreadRedaction.ThreadRedaction,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, false);

export const ThreadRedactionToolkit = Toolkit.make(RedactItemTool);
export const layer = McpToolAccess.toLayer(ThreadRedactionToolkit, {
  t3_thread_redact_item: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (
        scope.thread ||
        scope.client?.access !== "full-access" ||
        scope.client.maintenanceAuthorized !== true
      ) {
        return yield* new OrchestratorMcpFailure({
          reason: "maintenance_client_required",
          code: "capability_denied",
          message:
            "Redaction requires an owner-approved maintenance client. Thread and card-worker credentials are denied.",
        });
      }
      const service = yield* ThreadRedaction.ThreadRedaction;
      return yield* service
        .redactItem(input)
        .pipe(
          Effect.mapError(
            (e) =>
              new OrchestratorMcpFailure({
                reason: "invalid_args",
                code: "invalid_request",
                message: e.message,
              }),
          ),
        );
    }),
  ),
});
