import {
  SuggestionId,
  type GovernorView,
  type Lane,
  type MissionError,
  type MissionId,
  type PoolHold,
  type Role,
  type Suggestion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  GOVERNOR_PROVENANCE,
  eventDraft,
  missionRoles,
  nowIso,
  systemCaller,
  type PolicyDeps,
} from "./context.ts";
import {
  admissionOrder,
  decide,
  type GovernorAction,
  type GovernorDecision,
  type GovernorInput,
  type MissionUse,
} from "./governor.ts";
import { livePools } from "./poolOps.ts";
import { countsAgainstCapacity } from "./pools.ts";
import type { PolicySuggestions } from "./ports.ts";

/**
 * `apply` parks and resumes lanes itself (at safe points only), `suggest`
 * turns every action into a suggestion for the master, `off` only reports.
 * Nothing in any mode touches models.
 */
export type GovernorMode = "apply" | "suggest" | "off";

/** What one server remembers between ticks so it does not repeat itself. */
export interface GovernorMemory {
  /** Lanes already told they park at their next safe point, by reason. */
  readonly warned: Map<string, string>;
  /** Suggestion keys already proposed. Asks also refuses duplicates. */
  readonly proposed: Set<string>;
}

export const makeGovernorMemory = (): GovernorMemory => ({
  warned: new Map(),
  proposed: new Set(),
});

const SCAN_LIMIT = 5000;

/** Everything the pure governor reads, from the store and the pools. */
export const governorInput = (
  deps: PolicyDeps,
  now: string,
): Effect.Effect<GovernorInput, MissionError> =>
  Effect.gen(function* () {
    const missions = yield* deps.store.list("mission", { limit: SCAN_LIMIT });
    const subMissions = yield* deps.store.list("sub-mission", { limit: SCAN_LIMIT });
    const lanes = yield* deps.store.list("lane", { limit: SCAN_LIMIT });
    const roles: Array<Role> = [];
    for (const mission of missions) {
      if (mission.status === "archived") continue;
      roles.push(...(yield* missionRoles(deps, mission.id, now)).all);
    }
    const live = yield* livePools(deps, now);
    const usage: Array<MissionUse> = [];
    const queued: Array<PoolHold> = [];
    for (const { pool, entries } of live) {
      const byMission = new Map<MissionId, number>();
      for (const { hold } of entries) {
        if (countsAgainstCapacity(hold)) {
          byMission.set(hold.missionId, (byMission.get(hold.missionId) ?? 0) + hold.amount);
        } else if (hold.status === "queued") {
          queued.push(hold);
        }
      }
      for (const [missionId, used] of byMission) usage.push({ missionId, poolId: pool.id, used });
    }
    return {
      missions,
      subMissions,
      lanes,
      roles,
      pools: live.map((entry) => entry.pool),
      usage,
      queued,
      now,
    };
  });

/** The governor's reading and what its next tick would do. Read-only. */
export const governorView = (deps: PolicyDeps): Effect.Effect<GovernorView, MissionError> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const input = yield* governorInput(deps, now);
    const decision = decide(input);
    return {
      pressure: decision.pressure.map((entry) => ({ ...entry })),
      shares: decision.shares.map((share) => ({ ...share })),
      actions: decision.actions.map(({ _tag, laneId, missionId, reason }) => ({
        action: _tag,
        laneId,
        missionId,
        reason,
      })),
      admissions: admissionOrder(input).map((admission) => ({ ...admission })),
      at: now,
    };
  });

const laneRef = (lane: Lane | undefined, laneId: string) => ({
  kind: "lane" as const,
  id: laneId,
  ...(lane ? { label: lane.name } : {}),
});

/** A governor action as a suggestion, for `suggest` mode. */
const actionSuggestion = (
  action: GovernorAction,
  lane: Lane | undefined,
  now: string,
): Suggestion => {
  const parking = action._tag !== "resume";
  const status = parking ? "parked" : "idle";
  const name = lane?.name ?? action.laneId;
  return {
    id: SuggestionId.make(`governor:lane:${action.laneId}:${status}`),
    missionId: action.missionId,
    targetKind: "lane",
    target: laneRef(lane, action.laneId),
    title: parking ? `Park ${name}` : `Resume ${name}`,
    before: lane ? { status: lane.status } : null,
    after: { status },
    diffText: `status ${lane?.status ?? "?"} -> ${status}`,
    why: action.reason,
    evidence: [laneRef(lane, action.laneId)],
    author: "governor",
    acceptor: "master",
    status: "open",
    dismissReason: null,
    outcome: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: now,
  };
};

const suggestionKey = (suggestion: Suggestion) =>
  `${suggestion.id}:${JSON.stringify(suggestion.after)}`;

const applyAction = (
  deps: PolicyDeps,
  memory: GovernorMemory,
  action: GovernorAction,
  lane: Lane | undefined,
) =>
  Effect.gen(function* () {
    switch (action._tag) {
      case "park":
        memory.warned.delete(action.laneId);
        yield* deps.missions.upsertLane(GOVERNOR_PROVENANCE, {
          missionId: action.missionId,
          laneId: action.laneId,
          status: "parked",
          statusReason: action.reason,
        });
        return;
      case "resume":
        memory.warned.delete(action.laneId);
        yield* deps.missions.upsertLane(GOVERNOR_PROVENANCE, {
          missionId: action.missionId,
          laneId: action.laneId,
          status: "idle",
          statusReason: null,
        });
        return;
      case "park-at-safe-point": {
        if (memory.warned.get(action.laneId) === action.reason) return;
        memory.warned.set(action.laneId, action.reason);
        yield* deps.store.appendEvent(
          eventDraft(
            systemCaller(GOVERNOR_PROVENANCE),
            action.missionId,
            "governor.action",
            `${lane?.name ?? action.laneId} parks at its next safe point (step done, locks released, handoff written): ${action.reason}`,
            laneRef(lane, action.laneId),
            { action: action._tag, laneId: action.laneId, reason: action.reason },
          ),
        );
        return;
      }
    }
  });

/**
 * One governor pass: read pools and lanes, decide, then act according to the
 * mode. Failures of single actions are logged; the pass carries on.
 */
export const runGovernor = (
  deps: PolicyDeps,
  suggestions: PolicySuggestions["Service"],
  memory: GovernorMemory,
  mode: GovernorMode,
): Effect.Effect<GovernorDecision, MissionError> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const input = yield* governorInput(deps, now);
    const decision = decide(input);
    if (mode === "off") return decision;
    const lanes = new Map(input.lanes.map((lane) => [lane.id as string, lane]));
    const proposals = [...decision.suggestions];
    for (const action of decision.actions) {
      const lane = lanes.get(action.laneId);
      if (mode === "suggest") {
        proposals.push(actionSuggestion(action, lane, now));
        continue;
      }
      yield* applyAction(deps, memory, action, lane).pipe(
        Effect.catch((error) =>
          Effect.logWarning("mission governor action failed", {
            action: action._tag,
            laneId: action.laneId,
            detail: error.detail,
          }),
        ),
      );
    }
    for (const proposal of proposals) {
      const key = suggestionKey(proposal);
      if (memory.proposed.has(key)) continue;
      memory.proposed.add(key);
      yield* suggestions.propose(proposal);
    }
    return decision;
  });
