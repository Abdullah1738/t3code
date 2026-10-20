import type { MissionListSnapshot } from "@t3tools/contracts";

const NONE: ReadonlySet<string> = new Set();

/**
 * Threads that belong to a mission. The owner reaches them from the mission
 * (lanes, roles), so the ordinary thread list leaves them out.
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
