import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface RunningBackgroundWork {
  readonly id: string;
  readonly title: string | null;
  readonly kind: string;
  /** A delegated task with its own T3 thread, stopped with `thread.stop`. */
  readonly appOwned: boolean;
  /** Where its output goes: "session ses_..." or "thread <id>", when known. */
  readonly location: string | null;
  readonly startedAt: string | null;
}

const nativeSession = (id: string | null | undefined) => {
  const match = /:native-thread:([^:]+)$/.exec(id ?? "");
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
};

// Only OpenCode child thread ids carry the child's own session. Muse's
// providerThreadId is the parent's thread, and Claude/Cursor child ids come
// from synthetic task ids, so for them the T3 child thread is the answer.
const locate = (
  driver: string | null | undefined,
  childThreadId: string | null | undefined,
  providerThreadId?: string | null,
) => {
  const session =
    driver === "opencode"
      ? (nativeSession(childThreadId) ?? nativeSession(providerThreadId))
      : null;
  if (session !== null) return `session ${session}`;
  return childThreadId == null ? null : `thread ${childThreadId}`;
};

type BackgroundProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "subagents" | "providerThreads"
>;

/**
 * Work that still runs for the thread. An OpenCode background subagent shows
 * up both as a subagent and on its provider thread's roster under the same
 * task id, so it counts once. A roster entry whose subagent already finished
 * is left over from a missed settle and does not count.
 */
export const runningBackgroundWork = (
  projection: BackgroundProjection,
): ReadonlyArray<RunningBackgroundWork> => {
  const known = new Map<string, OrchestrationV2ThreadProjection["subagents"][number]>();
  for (const subagent of projection.subagents) {
    const nativeId = subagent.nativeTaskRef?.nativeId;
    if (nativeId != null) known.set(nativeId, subagent);
    if (subagent.childThreadId != null) known.set(subagent.childThreadId, subagent);
  }
  const running: Array<RunningBackgroundWork> = projection.subagents
    .filter((subagent) => isOrchestrationV2WorkActive(subagent.status))
    .map((subagent) => ({
      id: subagent.nativeTaskRef?.nativeId ?? subagent.id,
      title: subagent.title ?? null,
      kind: subagent.origin === "app_owned" ? "delegated task" : "subagent",
      appOwned: subagent.origin === "app_owned",
      location:
        subagent.origin === "app_owned"
          ? locate(null, subagent.childThreadId)
          : locate(subagent.driver, subagent.childThreadId, subagent.providerThreadId),
      startedAt: DateTime.isDateTime(subagent.startedAt)
        ? DateTime.formatIso(subagent.startedAt).replace(/\.\d+Z$/, "Z")
        : null,
    }));
  const activeProviderThread = projection.providerThreads.find(
    (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
  );
  for (const task of activeProviderThread?.pendingBackgroundTasks ?? []) {
    const childThreadId = "childThreadId" in task ? task.childThreadId : undefined;
    const match =
      known.get(task.taskId) ??
      (childThreadId === undefined ? undefined : known.get(childThreadId));
    if (match !== undefined) continue;
    running.push({
      id: task.taskId,
      title: task.description ?? null,
      kind: task.kind,
      appOwned: false,
      location: locate(activeProviderThread?.driver, childThreadId),
      startedAt: null,
    });
  }
  return running;
};

export const describeWork = (work: RunningBackgroundWork) =>
  `${work.kind} ${work.title === null ? work.id : `"${work.title}" (${work.id})`}`;

/** Where the live work is and since when, so it isn't mistaken for lost work. */
export const describeRunningWork = (work: RunningBackgroundWork) =>
  [
    describeWork(work),
    ...(work.location === null ? [] : [`in ${work.location}`]),
    work.startedAt === null ? "still running" : `running since ${work.startedAt}`,
  ].join(", ");
