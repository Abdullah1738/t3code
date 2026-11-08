import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

const short = (text: string, limit = 512) =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

/** Shells are navigation/status, not a second copy of provider output or task prompts. */
export const compactShell = (thread: OrchestrationV2ThreadShell): OrchestrationV2ThreadShell => ({
  ...thread,
  title: short(thread.title),
  lastError: thread.lastError == null ? thread.lastError : short(thread.lastError, 1024),
  latestVisibleMessage:
    thread.latestVisibleMessage === null
      ? null
      : { ...thread.latestVisibleMessage, text: short(thread.latestVisibleMessage.text) },
  ...(thread.pendingBackgroundTasks === undefined
    ? {}
    : {
        pendingBackgroundTasks: thread.pendingBackgroundTasks.map((task) => ({
          ...task,
          ...(task.description === undefined ? {} : { description: short(task.description, 256) }),
        })),
      }),
  goal:
    thread.goal == null
      ? thread.goal
      : {
          ...thread.goal,
          objective: short(thread.goal.objective),
          ...(thread.goal.lastCheck === undefined
            ? {}
            : { lastCheck: short(thread.goal.lastCheck) }),
        },
});
