import type { OrchestrationV2ThreadShell, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import type { CallerActiveRow } from "../orchestration-v2/ProjectionStore.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as McpDeadline from "./McpDeadline.ts";

export type CallerIdentity = CallerActiveRow &
  Pick<OrchestrationV2ThreadShell, "pendingBackgroundTasks">;

export const readCallerIdentity = Effect.fn("mcp.readCallerIdentity")(function* (
  threads: ThreadManagement.ThreadManagementService["Service"],
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId | undefined,
): Effect.fn.Return<CallerIdentity | null, OrchestratorV2Error> {
  // Bounded point reads gate every tool call, like foreground control thread detail.
  const row = yield* McpDeadline.waitingOn(
    threads.getCallerRow(threadId).pipe(NodeSqliteClient.foregroundReads),
    "statev2 foreground caller row",
  );
  if (row === null || row.deletedAt !== null) return null;
  if (
    row.archivedAt === null &&
    row.providerInstanceId === providerInstanceId &&
    (row.forkedFrom === null || row.forkedFrom.type === "node") &&
    row.activeRunId !== null
  ) {
    return { ...row, pendingBackgroundTasks: [] } satisfies CallerIdentity;
  }
  // Without an active run, native background subagents need the full shell's liveness facts.
  return yield* McpDeadline.waitingOn(
    threads.getThreadShell(threadId).pipe(NodeSqliteClient.backgroundReads),
    "statev2 background caller shell",
  );
});
