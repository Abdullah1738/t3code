import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { LiveStatus, Observation } from "./BoardModel.ts";

/**
 * How the board reads a t3 thread shell. A run that is `waiting` has ended its
 * turn but still drains background work (subagents, background commands), so
 * the card stays Running instead of asking for review.
 */
function liveStatusOf(shell: OrchestrationV2ThreadShell): LiveStatus {
  switch (shell.activityRunStatus) {
    case "preparing":
    case "starting":
    case "running":
      return "working";
    case "waiting":
      return "background";
    default:
      break;
  }
  if (shell.status === "queued") return "queued";
  if ((shell.pendingBackgroundTasks?.length ?? 0) > 0) return "background";
  return "idle";
}

const millis = (value: DateTime.Utc | null | undefined): number | null =>
  value === null || value === undefined ? null : DateTime.toEpochMillis(value);

export function observationFromShell(
  shell: OrchestrationV2ThreadShell | null,
  threadId: string,
): Observation {
  if (shell === null || shell.deletedAt !== null) return { threadId, deleted: true };
  const request = shell.pendingRuntimeRequest;
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    parentId: shell.lineage.parentThreadId,
    rootId: shell.lineage.rootThreadId,
    relationship: shell.lineage.relationshipToParent,
    promptAt: millis(shell.latestUserMessageAt),
    live: liveStatusOf(shell),
    attention:
      request === null
        ? null
        : { kind: request.kind === "user_input" ? "question" : "approval", count: 1 },
    model: shell.modelSelection.model,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    archived: shell.archivedAt !== null,
    settled: shell.settledOverride === "settled",
  };
}
