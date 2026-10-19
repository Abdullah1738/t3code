import type {
  Lane,
  Mission,
  MissionActor,
  MissionId,
  MissionProvenance,
  Role,
  RoleBinding,
  ThreadId,
} from "@t3tools/contracts";

import type { MissionCaller } from "./shared.ts";

/** The mission records a caller's identity is resolved against. */
export interface MissionCast {
  readonly missionId: MissionId;
  readonly mission: Mission | null;
  readonly roles: ReadonlyArray<Role>;
  readonly bindings: ReadonlyArray<RoleBinding>;
  readonly lanes: ReadonlyArray<Lane>;
}

/**
 * Who a caller is in one mission. Provenance comes from the transport (the
 * calling thread, the owner's app session); roles and lanes are looked up
 * from the thread, never taken from input.
 */
export interface Standing {
  readonly missionId: MissionId;
  readonly caller: MissionCaller;
  readonly isMaster: boolean;
  readonly roles: ReadonlyArray<Role>;
  readonly lanes: ReadonlyArray<Lane>;
  readonly masterThreadId: ThreadId | null;
}

const activeBinding = (cast: MissionCast, role: Role): RoleBinding | null =>
  cast.bindings.find((binding) => binding.roleId === role.id && binding.endedAt === null) ?? null;

const masterRole = (cast: MissionCast): Role | null =>
  (cast.mission?.masterRoleId
    ? cast.roles.find((role) => role.id === cast.mission?.masterRoleId)
    : undefined) ??
  cast.roles.find((role) => role.kind === "master") ??
  null;

export const masterThreadOf = (cast: MissionCast): ThreadId | null => {
  const role = masterRole(cast);
  return role === null ? null : (activeBinding(cast, role)?.threadId ?? null);
};

/** The thread that speaks for an actor right now, if any. */
export const threadOfActor = (cast: MissionCast, actor: MissionActor): ThreadId | null => {
  switch (actor._tag) {
    case "thread":
      return actor.threadId;
    case "role": {
      const role = cast.roles.find((candidate) => candidate.id === actor.roleId);
      return role === undefined ? null : (activeBinding(cast, role)?.threadId ?? null);
    }
    case "lane":
      return cast.lanes.find((lane) => lane.id === actor.laneId)?.threadId ?? null;
    default:
      return null;
  }
};

export const standingOf = (cast: MissionCast, provenance: MissionProvenance): Standing => {
  const base = {
    missionId: cast.missionId,
    masterThreadId: masterThreadOf(cast),
  };
  switch (provenance._tag) {
    case "owner-app":
    case "owner-imessage":
      return {
        ...base,
        caller: { provenance, actors: [{ _tag: "owner" }] },
        isMaster: false,
        roles: [],
        lanes: [],
      };
    case "system":
    case "import": {
      const component =
        provenance._tag === "system" ? provenance.component : `import:${provenance.source}`;
      return {
        ...base,
        caller: { provenance, actors: [{ _tag: "system", component }] },
        isMaster: false,
        roles: [],
        lanes: [],
      };
    }
    case "agent": {
      const threadId = provenance.threadId;
      const roles = cast.roles.filter((role) => activeBinding(cast, role)?.threadId === threadId);
      const lanes = cast.lanes.filter((lane) => lane.threadId === threadId);
      const master = masterRole(cast);
      const isMaster = master !== null && roles.some((role) => role.id === master.id);
      const speaksAs = (isMaster ? master : null) ?? roles[0] ?? null;
      const actors: MissionActor[] = [
        { _tag: "thread", threadId },
        ...roles.map((role): MissionActor => ({ _tag: "role", roleId: role.id })),
        ...lanes.map((lane): MissionActor => ({ _tag: "lane", laneId: lane.id })),
      ];
      return {
        ...base,
        caller: {
          provenance: { _tag: "agent", threadId, roleId: speaksAs?.id ?? null },
          actors,
        },
        isMaster,
        roles,
        lanes,
      };
    }
  }
};

/** A thread with no role or lane in the mission is a bystander there. */
export const isParticipant = (standing: Standing): boolean =>
  standing.roles.length > 0 || standing.lanes.length > 0;

/** The identity an agent asks as: the master role, then any role, then its lane. */
export const defaultAsker = (standing: Standing): MissionActor | null => {
  if (standing.isMaster && standing.caller.provenance._tag === "agent") {
    const roleId = standing.caller.provenance.roleId;
    if (roleId !== null) return { _tag: "role", roleId };
  }
  const role = standing.roles[0];
  if (role !== undefined) return { _tag: "role", roleId: role.id };
  const lane = standing.lanes[0];
  if (lane !== undefined) return { _tag: "lane", laneId: lane.id };
  return null;
};
