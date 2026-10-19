// @effect-diagnostics nodeBuiltinImport:off - record ids only need a random UUID.
import * as NodeCrypto from "node:crypto";

import {
  MissionError,
  MissionId,
  isOwnerProvenance,
  type MissionActor,
  type MissionErrorCode,
  type MissionEventKind,
  type MissionProvenance,
  type MissionRecordRef,
  type Role,
  type RoleBinding,
  type RoleId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Semaphore from "effect/Semaphore";

import { actorOf } from "../core/provenance.ts";
import type * as MissionService from "../MissionService.ts";
import type * as MissionStore from "../store/MissionStore.ts";
import type * as PolicyStore from "./PolicyStore.ts";
import type { PolicySampler, PolicySuccession, PolicyThreads } from "./ports.ts";
import {
  LANE_ROLE_KINDS,
  MISSION_ROLE_KINDS,
  defaultLaneRoles,
  defaultMissionRoles,
  defaultRoleId,
  newRole,
} from "./roles.ts";

/** Everything the policy service composes. Ops modules take this instead of yielding services. */
export interface PolicyDeps {
  readonly store: MissionStore.MissionStore["Service"];
  readonly missions: MissionService.MissionService["Service"];
  readonly policyStore: PolicyStore.PolicyStore["Service"];
  readonly threads: PolicyThreads["Service"];
  readonly succession: PolicySuccession["Service"];
  readonly sampler: PolicySampler["Service"];
  /** Serializes read-compute-write on pools and holds. */
  readonly holdLock: Semaphore.Semaphore;
}

const isMissionError = Schema.is(MissionError);

/** Runs a pure policy function: its MissionError becomes the failure, anything else is a defect. */
export const attempt = <A>(run: () => A): Effect.Effect<A, MissionError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(run());
    } catch (error) {
      return isMissionError(error) ? Effect.fail(error) : Effect.die(error);
    }
  });

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const newId = (prefix: string): string => `${prefix}-${NodeCrypto.randomUUID()}`;

export const shortId = (prefix: string): string =>
  `${prefix}-${NodeCrypto.randomUUID().slice(0, 8)}`;

export const failWith = (code: MissionErrorCode, detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

export const failIf = (error: MissionError | null): Effect.Effect<void, MissionError> =>
  error === null ? Effect.void : Effect.fail(error);

/** Provenance for writes the policy makes on its own (model alignment, hold expiry, triggers). */
export const POLICY_PROVENANCE: MissionProvenance = { _tag: "system", component: "mission-policy" };
export const GOVERNOR_PROVENANCE: MissionProvenance = { _tag: "system", component: "governor" };

// ardud missions: core
/**
 * The policy's own components. Only these (and imports) act with a master's
 * reach. A component that calls in from outside (crw over HTTP, an MCP client,
 * the control API) is just a named caller: it takes holds and records what it
 * read, but it does not govern.
 */
const INTERNAL_COMPONENTS: ReadonlySet<string> = new Set([
  "mission-policy",
  "governor",
  "review-policy",
]);

/** Timeline for changes that belong to no mission (global pools). Same id the asks track uses. */
export const GLOBAL_TIMELINE = MissionId.make("missions-global");

/** Who is asking, resolved against one mission. */
export interface Caller {
  readonly provenance: MissionProvenance;
  readonly byOwner: boolean;
  /** The policy's own components and imports: may do what a master may. */
  readonly trusted: boolean;
  readonly threadId: ThreadId | null;
  /** The caller's role in the mission, proved by an active binding of its thread. */
  readonly role: Role | null;
  readonly isMaster: boolean;
  readonly actor: MissionActor;
}

/** Caller with no mission context (global pools). Agents count as their thread. */
export const baseCaller = (provenance: MissionProvenance): Caller => ({
  provenance,
  byOwner: isOwnerProvenance(provenance),
  trusted:
    (provenance._tag === "system" && INTERNAL_COMPONENTS.has(provenance.component)) ||
    provenance._tag === "import",
  threadId: provenance._tag === "agent" ? provenance.threadId : null,
  role: null,
  isMaster: false,
  actor:
    provenance._tag === "agent"
      ? { _tag: "thread", threadId: provenance.threadId }
      : actorOf(provenance),
});

export const requireMission = (deps: PolicyDeps, missionId: MissionId) =>
  deps.store.get("mission", missionId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => failWith("not-found", `No mission ${missionId}.`),
        onSome: Effect.succeed,
      }),
    ),
  );

/** Every active binding in a mission. Complete: never one capped page. */
export const activeBindings = (deps: PolicyDeps, missionId: MissionId) =>
  deps.store.listAllInMission("role-binding", missionId, ["bound"]);

/** Records by id, each read on its own, so no page limit can drop one. */
export const rolesByIds = (deps: PolicyDeps, ids: ReadonlyArray<RoleId>) =>
  Effect.forEach([...new Set(ids)], (id) => deps.store.get("role", id)).pipe(
    Effect.map((found) => found.flatMap((entry) => Option.toArray(entry))),
  );

/** The roles a thread actively holds in one mission, and that mission's master role id. */
const threadRoles = (deps: PolicyDeps, missionId: MissionId, threadId: ThreadId) =>
  Effect.gen(function* () {
    const bindings = yield* activeBindings(deps, missionId);
    const roleIds = bindings
      .filter((binding) => binding.threadId === threadId)
      .map((binding) => binding.roleId);
    const roles = roleIds.length === 0 ? [] : yield* rolesByIds(deps, roleIds);
    const mission = yield* deps.store.get("mission", missionId);
    const masterRoleId = Option.match(mission, {
      onNone: () => null,
      onSome: (record) => record.masterRoleId,
    });
    return { roles, masterRoleId };
  });

/**
 * An agent's role comes from an active binding of its own thread in that
 * mission, never from what it claims. A claimed role id only picks among the
 * thread's real roles.
 */
export const resolveCaller = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  missionId: MissionId,
): Effect.Effect<Caller, MissionError> =>
  Effect.gen(function* () {
    const base = baseCaller(provenance);
    if (provenance._tag !== "agent") return base;
    const { roles, masterRoleId } = yield* threadRoles(deps, missionId, provenance.threadId);
    const role =
      roles.find((candidate) => candidate.id === provenance.roleId) ??
      roles.find((candidate) => candidate.kind === "master") ??
      roles[0] ??
      null;
    if (role === null) return base;
    return {
      ...base,
      role,
      isMaster: role.kind === "master" || role.id === masterRoleId,
      actor: { _tag: "role", roleId: role.id },
    };
  });

export const mayGovern = (caller: Caller): boolean =>
  caller.byOwner || caller.trusted || caller.isMaster;

/**
 * A caller for changes that span missions (pools of any scope). The owner,
 * the policy's own components and the master of any mission may make them; an agent
 * acts as its master role, preferring one in `preferred`.
 */
export const governingCaller = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  preferred: MissionId | null,
): Effect.Effect<Caller, MissionError> =>
  Effect.gen(function* () {
    const base = baseCaller(provenance);
    if (provenance._tag !== "agent") return base;
    if (preferred !== null) {
      const local = yield* resolveCaller(deps, provenance, preferred);
      if (local.isMaster) return local;
    }
    // Every mission the thread touches comes from an index, never a capped page.
    for (const missionId of yield* deps.store.missionsOfThread(provenance.threadId)) {
      if (missionId === preferred) continue;
      const { roles, masterRoleId } = yield* threadRoles(deps, missionId, provenance.threadId);
      const role = roles.find(
        (candidate) => candidate.kind === "master" || candidate.id === masterRoleId,
      );
      if (role !== undefined) {
        return { ...base, role, isMaster: true, actor: { _tag: "role", roleId: role.id } };
      }
    }
    return base;
  });

export const requireGovern = (caller: Caller, action: string) =>
  mayGovern(caller)
    ? Effect.void
    : failWith("forbidden", `Only the owner or the mission's master can ${action}.`);

export const roleRef = (role: Role): MissionRecordRef => ({
  kind: "role",
  id: role.id,
  label: role.name,
});

export const eventDraft = (
  caller: Pick<Caller, "actor" | "provenance">,
  missionId: MissionId,
  kind: MissionEventKind,
  summary: string,
  subject: MissionRecordRef | null,
  payload?: unknown,
): MissionStore.MissionEventDraft => ({
  missionId,
  kind,
  actor: caller.actor,
  provenance: caller.provenance,
  summary,
  subject,
  payload: payload ?? null,
});

export const systemCaller = (provenance: MissionProvenance) => baseCaller(provenance);

/** Stored roles plus the registry defaults nobody has changed yet (not stored). */
export interface MissionRoles {
  readonly stored: ReadonlyArray<Role>;
  readonly defaults: ReadonlyArray<Role>;
  readonly all: ReadonlyArray<Role>;
}

export const missionRoles = (
  deps: PolicyDeps,
  missionId: MissionId,
  now: string,
): Effect.Effect<MissionRoles, MissionError> =>
  Effect.gen(function* () {
    // Complete reads, newest first like the page they replace.
    const stored = (yield* deps.store.listAllInMission("role", missionId)).toReversed();
    const lanes = yield* deps.store.listAllInMission("lane", missionId);
    const storedIds = new Set<string>(stored.map((role) => role.id));
    const defaults = [
      ...defaultMissionRoles(missionId, now),
      ...lanes
        .filter((lane) => lane.status !== "retired")
        .flatMap((lane) => defaultLaneRoles(missionId, lane.id, now)),
    ].filter((role) => !storedIds.has(role.id));
    return { stored, defaults, all: [...stored, ...defaults] };
  });

export interface FoundRole {
  readonly role: Role;
  readonly stored: boolean;
}

/** A stored role, or a registry default named by its id (`<mission>:<kind>[:<lane>]`). */
export const findRole = (
  deps: PolicyDeps,
  roleId: RoleId,
  now: string,
): Effect.Effect<FoundRole, MissionError> =>
  Effect.gen(function* () {
    const stored = yield* deps.store.get("role", roleId);
    if (Option.isSome(stored)) return { role: stored.value, stored: true };
    for (const kind of MISSION_ROLE_KINDS) {
      const suffix = `:${kind}`;
      if (!roleId.endsWith(suffix)) continue;
      const missionId = roleId.slice(0, -suffix.length) as MissionId;
      const mission = yield* deps.store.get("mission", missionId);
      if (Option.isSome(mission) && defaultRoleId(missionId, kind) === roleId) {
        return { role: newRole({ missionId, kind }, now), stored: false };
      }
    }
    for (const kind of LANE_ROLE_KINDS) {
      const marker = `:${kind}:`;
      const index = roleId.lastIndexOf(marker);
      if (index <= 0) continue;
      const missionId = roleId.slice(0, index) as MissionId;
      const laneId = roleId.slice(index + marker.length);
      const lane = yield* deps.store.get("lane", laneId);
      if (
        Option.isSome(lane) &&
        lane.value.missionId === missionId &&
        lane.value.status !== "retired" &&
        defaultRoleId(missionId, kind, lane.value.id) === roleId
      ) {
        return { role: newRole({ missionId, kind, laneId: lane.value.id }, now), stored: false };
      }
    }
    return yield* failWith("not-found", `No role ${roleId}.`);
  });

export const roleUpsert = (role: Role) => ({ _tag: "role" as const, record: role });
export const bindingUpsert = (binding: RoleBinding) => ({
  _tag: "role-binding" as const,
  record: binding,
});
