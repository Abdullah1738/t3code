import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ImessageSendService from "./ImessageSendService.ts";
import { ImessageSendToolkit } from "./tools.ts";

const handlers = {
  imessage_send: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ImessageSendService.ImessageSendService;
      return yield* service.send(scope, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ImessageSendToolkit.tools>;

export const layer = McpToolAccess.toLayer(ImessageSendToolkit, handlers);
