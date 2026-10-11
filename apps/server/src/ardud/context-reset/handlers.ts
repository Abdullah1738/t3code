import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ContextResetService from "./ContextResetService.ts";
import { ContextResetToolkit } from "./tools.ts";

const handlers = {
  t3_context_reset: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ContextResetService.ContextResetService;
      return yield* service.reset(scope, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ContextResetToolkit.tools>;

export const layer = McpToolAccess.toLayer(ContextResetToolkit, handlers);
