import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";

import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";

// MCP's providerSessionId identifies the credential; the provider-thread owns the runtime id.
export const resolveCallerRuntime = Effect.fn("mcp.resolveCallerRuntime")(function* (
  credentials: McpProviderSessions.McpProviderSessions["Service"],
  caller: McpThreadInvocationScope["thread"],
  records: Pick<OrchestrationV2ThreadProjection, "thread" | "providerThreads">,
) {
  const current = yield* credentials.read(caller.threadId);
  if (
    current === undefined ||
    current.threadId !== caller.threadId ||
    current.providerInstanceId !== caller.providerInstanceId ||
    current.providerSessionId !== caller.providerSessionId ||
    current.runtimeProviderSessionId === undefined ||
    records.thread.id !== caller.threadId ||
    records.thread.archivedAt !== null ||
    records.thread.deletedAt !== null
  )
    return undefined;
  // A current credential can outlive its runtime attachment. Keep that distinct
  // from an invalid caller so reset can refuse before queuing any work.
  return {
    runtimeProviderSessionId:
      records.providerThreads.find(
        (thread) =>
          thread.id === records.thread.activeProviderThreadId &&
          thread.appThreadId === caller.threadId &&
          thread.providerInstanceId === caller.providerInstanceId &&
          thread.providerSessionId === current.runtimeProviderSessionId,
      )?.providerSessionId ?? undefined,
  };
});
