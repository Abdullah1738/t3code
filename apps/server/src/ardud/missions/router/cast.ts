/**
 * Who is who in one mission, read from core records: roles and their bound
 * threads, lanes. Pure helpers over a loaded cast, so wake
 * resolution and membership stay testable without a store.
 */
import type {
  Lane,
  Mission,
  MissionActor,
  MissionId,
  Role,
  RoleBinding,
  SubMission,
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
  // --- routing additions ---
  readonly subMissions: ReadonlyArray<SubMission>;
  // --- end routing additions ---
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
    const subMissions = yield* store.listAllInMission("sub-mission", missionId);
    const cast: RouterCast = { missionId, mission, roles, bindings, lanes, subMissions };
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
 * master role, or holding another role or a lane. Explicit
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
  return holdsRole || holdsLane ? "created" : null;
};

/**
 * Who a mission thread's questions go to, nearest first: its lane's lead,
 * then its sub-mission's coordinator, then the master. Empty tiers are left
 * out and the thread is never its own lead. A master thread, or a thread
 * outside the mission, has no leads: its questions stay the owner's.
 */
export const leadTiersOf = (
  cast: RouterCast,
  threadId: ThreadId,
): ReadonlyArray<ReadonlyArray<ThreadId>> => {
  const masters = masterThreadsOf(cast);
  if (masters.includes(threadId) || recordMembership(cast, threadId) === null) return [];
  const held = (roleIds: ReadonlyArray<Role["id"] | null | undefined>) => [
    ...new Set(
      roleIds.flatMap((roleId) =>
        roleId == null ? [] : boundThreads(cast, roleId).filter((each) => each !== threadId),
      ),
    ),
  ];
  const roleLanes = new Set(
    cast.roles
      .filter((role) => role.laneId !== null && boundThreads(cast, role.id).includes(threadId))
      .map((role) => role.laneId),
  );
  const lanes = cast.lanes.filter(
    (lane) => lane.status !== "retired" && (lane.threadId === threadId || roleLanes.has(lane.id)),
  );
  const coordinators = lanes.map(
    (lane) =>
      cast.subMissions.find((sub) => sub.id === lane.subMissionId && sub.status !== "closed")
        ?.coordinatorRoleId,
  );
  return [
    held(lanes.map((lane) => lane.leadRoleId)),
    held(coordinators),
    masters.filter((each) => each !== threadId),
  ].filter((tier) => tier.length > 0);
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
      // ardud missions: fix-p3 - never a raw thread id in a room line
      return held === null ? "a thread" : labelOf(cast, held);
    }
    case "system":
      return systemLabel(actor.component);
    case "person":
      return actor.name;
  }
};

/** Import actors ("coord-import", "import:coord.db") read as one plain name. */
export const systemLabel = (component: string): string =>
  component === "coord-import" || component.startsWith("import:") ? "Import" : component;

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
 * A thread whose lanes in this mission are all parked. It wakes only for
 * messages that name it or come from the owner: a lane parks when its queue
 * is empty, and broadcasts, subscriptions and reminders would only burn turns.
 */
export const isParkedThread = (cast: RouterCast, threadId: ThreadId): boolean => {
  if (masterThreadsOf(cast).includes(threadId)) return false;
  const lanes = cast.lanes.filter(
    (lane) => lane.threadId === threadId && lane.status !== "retired",
  );
  return lanes.length > 0 && lanes.every((lane) => lane.status === "parked");
};

/** An actor whose threads are all parked lanes: ambient broadcasts neither wake it nor wait on its read. */
export const isParkedActor = (cast: RouterCast, actor: MissionActor): boolean => {
  const threads = threadsOfActor(cast, actor);
  return threads.length > 0 && threads.every((threadId) => isParkedThread(cast, threadId));
};

/**
 * Who a broadcast control reaches when the room has no subscribers and it
 * names nobody: every lane with a thread, and every non-master bound role
 * that doesn't run a lane. Parked lanes only hear the owner's broadcasts.
 */
export const broadcastAudience = (
  cast: RouterCast,
  options: { readonly fromOwner: boolean },
): ReadonlyArray<MissionActor> => {
  const master = masterRoleOf(cast);
  const live = cast.lanes.filter((lane) => lane.threadId !== null && lane.status !== "retired");
  const laneThreads = new Set(live.map((lane) => lane.threadId));
  const lanes = options.fromOwner ? live : live.filter((lane) => lane.status !== "parked");
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
