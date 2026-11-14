import {
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import { McpCall } from "../ardud/analytics/McpCall.ts";
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
): Effect.fn.Return<CallerIdentity | null, OrchestratorV2Error | OrchestratorMcpFailure> {
  const call = yield* Effect.serviceOption(McpCall);
  const started = yield* Clock.monotonicTimeNanos;
  if (call._tag === "Some") {
    call.value.callerStarted = started;
    call.value.callerResolved = false;
    call.value.phase = "caller";
    call.value.readerLane = "foreground";
  }
  // Bounded point reads gate every tool call, like foreground control thread detail.
  const row = yield* McpDeadline.waitingOn(
    threads.getCallerRow(threadId).pipe(
      NodeSqliteClient.foregroundReads,
      Effect.mapError((cause) =>
        NodeSqliteClient.readerLaneFailure(cause) === undefined
          ? cause
          : new OrchestratorMcpFailure({
              code: "caller_unresolved",
              message: `Caller resolution could not acquire the foreground reader for thread ${threadId}. Nothing was saved; retry the same call.`,
            }),
      ),
    ),
    "statev2 foreground caller row",
  );
  if (row === null || row.deletedAt !== null) return null;
  if (
    row.pendingBackgroundTasks !== undefined ||
    row.archivedAt !== null ||
    row.providerInstanceId !== providerInstanceId ||
    ((row.forkedFrom === null || row.forkedFrom.type === "node") && row.activeRunId !== null)
  ) {
    if (call._tag === "Some") {
      call.value.callerResolved = true;
      call.value.phase = "handler";
      call.value.callerResolveMs += Number((yield* Clock.monotonicTimeNanos) - started) / 1e6;
      delete call.value.callerStarted;
    }
    return {
      ...row,
      pendingBackgroundTasks: row.pendingBackgroundTasks ?? [],
    } satisfies CallerIdentity;
  }
  // Only fork history or work exceeding the caller caps needs the exact shell.
  if (call._tag === "Some") call.value.readerLane = "background";
  const shell = yield* McpDeadline.waitingOn(
    threads.getThreadShell(threadId).pipe(NodeSqliteClient.backgroundReads),
    "statev2 background caller shell",
  );
  if (call._tag === "Some") {
    call.value.callerResolved = shell !== null && shell.deletedAt === null;
    if (call.value.callerResolved) call.value.phase = "handler";
    call.value.callerResolveMs += Number((yield* Clock.monotonicTimeNanos) - started) / 1e6;
    delete call.value.callerStarted;
  }
  return shell;
});
