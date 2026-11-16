import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Analytics from "../../../ardud/analytics/Analytics.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AnalyticsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(AnalyticsToolkit, {
  analytics_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("orchestration"))
        return yield* new OrchestratorMcpFailure({
          reason: "capability_missing",
          code: "capability_denied",
          message: "This credential cannot read analytics.",
        });
      const analytics = yield* Effect.serviceOption(Analytics.Analytics);
      if (analytics._tag === "None")
        return yield* new OrchestratorMcpFailure({
          reason: "analytics_unavailable",
          code: "capability_denied",
          message: "Local analytics is unavailable.",
        });
      return yield* analytics.value.read(input).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Analytics could not be read.",
            }),
        ),
      );
    }),
  ),
});
