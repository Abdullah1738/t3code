/**
 * Which of the old holder's schedules a role succession may move. Schedules
 * name a thread, not a mission or a role, so the old thread's schedules count
 * as the role's only while that thread serves nothing else: a thread that also
 * holds another role or lane here, or works in another live mission, keeps
 * every schedule it has.
 */
import type { Lane, MissionError, Role, RoleBinding, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { MissionCast } from "../asks/standing.ts";
import { castOf } from "../core/master.ts";
import { provenancePrincipal } from "../guard/principal.ts";
import type { Caller, PolicyDeps } from "./context.ts";
import type { SuccessionScope } from "./ports.ts";

const activeBindings = (cast: MissionCast) =>
  cast.bindings.filter((binding) => binding.endedAt === null);

const liveLanes = (cast: MissionCast): ReadonlyArray<Lane> =>
  cast.lanes.filter((lane) => lane.status !== "retired");

export const successionScope = (
  deps: PolicyDeps,
  input: { readonly role: Role; readonly ended: RoleBinding; readonly caller: Caller },
): Effect.Effect<SuccessionScope, MissionError> =>
  Effect.gen(function* () {
    const from = input.ended.threadId;
    const here = yield* castOf(deps.store, input.role.missionId);
    const members = new Set<ThreadId>([
      ...activeBindings(here).map((binding) => binding.threadId),
      ...liveLanes(here).flatMap((lane) => (lane.threadId === null ? [] : [lane.threadId])),
    ]);
    const reasons: Array<string> = [];
    const keepsWorkHere =
      activeBindings(here).some(
        (binding) => binding.threadId === from && binding.id !== input.ended.id,
      ) || liveLanes(here).some((lane) => lane.threadId === from && lane.id !== input.role.laneId);
    if (keepsWorkHere) reasons.push("it still holds another role or lane in this mission");
    for (const missionId of yield* deps.store.missionsOfThread(from)) {
      if (missionId === input.role.missionId) continue;
      const other = yield* castOf(deps.store, missionId);
      if (other.mission === null || other.mission.status === "archived") continue;
      const serves =
        activeBindings(other).some((binding) => binding.threadId === from) ||
        liveLanes(other).some((lane) => lane.threadId === from);
      if (serves) reasons.push(`it also works in mission ${other.mission.title}`);
    }
    return {
      decider: input.caller.trusted ? undefined : provenancePrincipal(input.caller.provenance),
      shared:
        reasons.length === 0
          ? null
          : `Schedules on ${from} stay there because ${reasons.join(" and ")}.`,
      members,
    };
  });
