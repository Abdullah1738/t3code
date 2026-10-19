/**
 * Who is who in one mission, read from core records: roles and their bound
 * threads, lanes, open forks. Pure helpers over a loaded cast, so wake
 * resolution and membership stay testable without a store.
 */
import type {
  Lane,
  Mission,
  MissionActor,
  MissionFork,
  MissionId,
  Role,
  RoleBinding,
  ThreadId,
  WorkItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as MissionStore from "../store/MissionStore.ts";
import type { MemberKind } from "./model.ts";

export interface RouterCast {
  readonly missionId: MissionId;
  readonly mission: Mission | null;
  readonly roles: ReadonlyArray<Role>;
  /** Bound role bindings only. */
  readonly bindings: ReadonlyArray<RoleBinding>;
  readonly lanes: ReadonlyArray<Lane>;
  /** Open forks only. */
  readonly forks: ReadonlyArray<MissionFork>;
}

/**
 * A mission's whole cast. Membership and wake decisions read this, so it uses
 * the store's uncapped per-mission reads: a cast cut at a list limit would
 * silently drop members.
 */
export const readCast = (store: MissionStore.MissionStore["Service"], missionId: MissionId) =>
  Effect.gen(function* () {
    const mission = Option.getOrNull(yield* store.get("mission", missionId));
    const roles = yield* store.listAllInMission("role", missionId);
    const bindings = yield* store.listAllInMission("role-binding", missionId, ["bound"]);
    const lanes = yield* store.listAllInMission("lane", missionId);
    const forks = yield* store.listAllInMission("fork", missionId, ["open"]);
    const cast: RouterCast = { missionId, mission, roles, bindings, lanes, forks };
    return cast;
  });

const boundThreads = (cast: RouterCast, roleId: Role["id"]): ReadonlyArray<ThreadId> =>
  cast.bindings
    .filter((binding) => binding.roleId === roleId && binding.endedAt === null)
    .map((binding) => binding.threadId);

export const masterRoleOf = (cast: RouterCast): Role | null =>
  (cast.mission?.masterRoleId
    ? cast.roles.find((role) => role.id === cast.mission?.masterRoleId)
    : undefined) ??
  cast.roles.find((role) => role.kind === "master") ??
  null;

export const masterThreadsOf = (cast: RouterCast): ReadonlyArray<ThreadId> => {
  const master = masterRoleOf(cast);
  return master === null ? [] : boundThreads(cast, master.id);
};

/** The threads that speak for an actor right now. Owner, system and people have none. */
export const threadsOfActor = (cast: RouterCast, actor: MissionActor): ReadonlyArray<ThreadId> => {
  switch (actor._tag) {
    case "thread":
      return [actor.threadId];
    case "role":
      return boundThreads(cast, actor.roleId);
    case "lane": {
      const threadId = cast.lanes.find((lane) => lane.id === actor.laneId)?.threadId ?? null;
      return threadId === null ? [] : [threadId];
    }
    default:
      return [];
  }
};

/** Every actor a thread answers to in this mission: itself, its bound roles, its lanes. */
export const actorsOfThread = (
  cast: RouterCast,
  threadId: ThreadId,
): ReadonlyArray<MissionActor> => [
  { _tag: "thread", threadId },
  ...cast.roles
    .filter((role) => boundThreads(cast, role.id).includes(threadId))
    .map((role): MissionActor => ({ _tag: "role", roleId: role.id })),
  ...cast.lanes
    .filter((lane) => lane.threadId === threadId)
    .map((lane): MissionActor => ({ _tag: "lane", laneId: lane.id })),
];

/**
 * How a thread belongs to this mission from its records alone: bound to the
 * master role, or holding another role, a lane or an open fork. Explicit
 * attachments and thread lineage are added by the router.
 */
export const recordMembership = (cast: RouterCast, threadId: ThreadId): MemberKind | null => {
  if (masterThreadsOf(cast).includes(threadId)) return "master";
  const holdsRole = cast.bindings.some(
    (binding) => binding.endedAt === null && binding.threadId === threadId,
  );
  const holdsLane = cast.lanes.some(
    (lane) => lane.threadId === threadId && lane.status !== "retired",
  );
  const holdsFork = cast.forks.some((fork) => fork.forkThreadId === threadId);
  return holdsRole || holdsLane || holdsFork ? "created" : null;
};

/** The lane, else the role, a thread holds in this mission: what to call it. */
export const heldBy = (cast: RouterCast, threadId: ThreadId): MissionActor | null => {
  const [, ...held] = actorsOfThread(cast, threadId);
  return held.find((actor) => actor._tag === "lane") ?? held[0] ?? null;
};

export const labelOf = (cast: RouterCast, actor: MissionActor): string => {
  switch (actor._tag) {
    case "owner":
      return "owner";
    case "role":
      return cast.roles.find((role) => role.id === actor.roleId)?.name ?? actor.roleId;
    case "lane":
      return cast.lanes.find((lane) => lane.id === actor.laneId)?.name ?? actor.laneId;
    case "thread": {
      const held = heldBy(cast, actor.threadId);
      return held === null ? `thread ${actor.threadId}` : labelOf(cast, held);
    }
    case "system":
      return actor.component;
    case "person":
      return actor.name;
  }
};

/**
 * Who hears evidence about a work item: its lane (and the lane's lead role)
 * plus the verifiers on that lane, or the mission-wide verifiers when the
 * lane has none.
 */
export const itemWatchers = (
  cast: RouterCast,
  item: WorkItem | null,
): ReadonlyArray<MissionActor> => {
  if (item === null) return [];
  const lane = item.laneId === null ? null : cast.lanes.find((each) => each.id === item.laneId);
  const verifiers = cast.roles.filter((role) => role.kind === "verifier");
  const laneVerifiers = lane ? verifiers.filter((role) => role.laneId === lane.id) : [];
  const chosen = laneVerifiers.length > 0 ? laneVerifiers : verifiers.filter((r) => !r.laneId);
  return [
    ...(lane ? [{ _tag: "lane", laneId: lane.id } as const] : []),
    ...(lane?.leadRoleId ? [{ _tag: "role", roleId: lane.leadRoleId } as const] : []),
    ...chosen.map((role): MissionActor => ({ _tag: "role", roleId: role.id })),
  ];
};

/**
 * Who a broadcast control reaches when the room has no subscribers and it
 * names nobody: every lane with a thread and every non-master bound role.
 */
export const broadcastAudience = (cast: RouterCast): ReadonlyArray<MissionActor> => {
  const master = masterRoleOf(cast);
  const lanes = cast.lanes.filter((lane) => lane.threadId !== null && lane.status !== "retired");
  const laneThreads = new Set(lanes.map((lane) => lane.threadId));
  // One recipient per thread, so a receipt counts threads, not titles.
  return [
    ...lanes.map((lane): MissionActor => ({ _tag: "lane", laneId: lane.id })),
    ...cast.roles
      .filter((role) => {
        const threads = boundThreads(cast, role.id);
        return role.id !== master?.id && threads.some((threadId) => !laneThreads.has(threadId));
      })
      .map((role): MissionActor => ({ _tag: "role", roleId: role.id })),
  ];
};
