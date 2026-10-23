import { MissionError, MissionId, OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { callerProvenance } from "../tools/handlers.ts";
import { ScribeService } from "./ScribeService.ts";

/**
 * Report tools. The mission's master keeps a report it wrote (or rewrote) on
 * the mission's report list; the caller comes from the invocation, never from
 * parameters.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ScribeService,
];

const OpenItem = Schema.Struct({
  ref: Schema.String.annotate({ description: "Record ref kind:id, e.g. work-item:robob:wi:x." }),
  label: Schema.String,
  since: Schema.String.annotate({ description: "ISO time it was first left open." }),
});

const ReportPutInput = Schema.Struct({
  missionId: MissionId,
  kind: Schema.Literals(["update", "daily"]),
  coversFrom: Schema.String.annotate({ description: "ISO start of the window." }),
  coversTo: Schema.String.annotate({
    description:
      "ISO end of the window. Saving again for the same kind and end adds a revision and keeps the old text.",
  }),
  text: Schema.String.annotate({ description: "The report markdown, kept exactly as given." }),
  open: Schema.optional(Schema.Array(OpenItem)).annotate({
    description: "Items left open, for the next report to close out.",
  }),
  facts: Schema.optional(Schema.Unknown).annotate({
    description: "The facts pack the text was written from (JSON).",
  }),
});

const ReportPutTool = Tool.make("mission_report_put", {
  description:
    "Keep a written report (4h update or daily) on the mission's report list, as the mission's master. The same kind and window end again adds a revision; lists show the newest. A daily hides older dailies whose window it overlaps. Returns the report id, revision and what it hides.",
  parameters: ReportPutInput,
  success: Schema.Struct({ report: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Save a mission report")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Strict, true);

export const ReportsToolkit = Toolkit.make(ReportPutTool);

const REFUSALS: ReadonlySet<MissionError["code"]> = new Set([
  "forbidden",
  "provenance-required",
  "provenance-invalid",
  "locked",
]);

const toolFailure = (error: MissionError) =>
  new OrchestratorMcpFailure({
    code: REFUSALS.has(error.code) ? "capability_denied" : "invalid_request",
    message: error.message,
  });

const handlers = {
  mission_report_put: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const scribe = yield* ScribeService;
      const report = yield* scribe.putReport(callerProvenance(scope), input);
      return { report };
    }).pipe(
      Effect.catchTags({
        MissionError: (error) => Effect.fail(toolFailure(error)),
        ScribeStoreError: (error) =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `The report store failed: ${error.operation}.`,
            }),
          ),
      }),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof ReportsToolkit.tools>;

export const layer = McpToolAccess.toLayer(ReportsToolkit, handlers);
