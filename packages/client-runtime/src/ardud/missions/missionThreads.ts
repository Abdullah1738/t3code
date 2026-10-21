import type { MissionListSnapshot, ThreadAttachment } from "@t3tools/contracts";

const NONE: ReadonlySet<string> = new Set();

/**
 * Threads that belong to a mission. The owner reaches them from the mission
 * (lanes, roles, reviews), so the ordinary thread list leaves them out.
 */
export function missionThreadIds(list: MissionListSnapshot | undefined): ReadonlySet<string> {
  if (list === undefined) return NONE;
  const ids = new Set<string>();
  for (const mission of list.missions) {
    for (const id of mission.threadIds ?? []) ids.add(id);
  }
  return ids.size === 0 ? NONE : ids;
}

/** Drops mission threads, keeping the same array when nothing is dropped. */
export function withoutMissionThreads<T extends { readonly id: string }>(
  threads: ReadonlyArray<T>,
  missionThreads: ReadonlySet<string>,
): ReadonlyArray<T> {
  if (missionThreads.size === 0) return threads;
  const kept = threads.filter((thread) => !missionThreads.has(thread.id));
  return kept.length === threads.length ? threads : kept;
}

// ardud missions: crw-threads
export interface AttachedThreadRow {
  readonly threadId: ThreadAttachment["threadId"];
  readonly title: string;
  /** "repo#123", without the owner, or null for a thread with no PR. */
  readonly pullRequest: string | null;
  readonly updatedAt: string;
}

export interface AttachedThreadGroups {
  /** Work still running: shown in full. */
  readonly open: ReadonlyArray<AttachedThreadRow>;
  /** Settled PRs, newest first: clients fold these. */
  readonly closed: ReadonlyArray<AttachedThreadRow>;
}

/** The threads a component (crw) runs for the mission, for the Reviews group. */
export function attachedThreadGroups(
  attached: ReadonlyArray<ThreadAttachment> | undefined,
): AttachedThreadGroups {
  const rows = (state: ThreadAttachment["state"]) =>
    (attached ?? [])
      .filter((thread) => thread.state === state)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((thread): AttachedThreadRow => ({
        threadId: thread.threadId,
        title: thread.title,
        pullRequest:
          thread.pullRequest === null
            ? null
            : `${thread.pullRequest.repository.split("/").at(-1)}#${thread.pullRequest.number}`,
        updatedAt: thread.updatedAt,
      }));
  return { open: rows("open"), closed: rows("closed") };
}
