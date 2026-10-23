import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

export interface RunningBackgroundWork {
  readonly id: string;
  readonly title: string | null;
  readonly kind: string;
  /** A delegated task with its own T3 thread, stopped with `thread.stop`. */
  readonly appOwned: boolean;
}

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
    });
  }
  return running;
};

export const describeWork = (work: RunningBackgroundWork) =>
  `${work.kind} ${work.title === null ? work.id : `"${work.title}" (${work.id})`}`;
