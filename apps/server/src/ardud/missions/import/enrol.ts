// Enrols the coord actors coord.db binds to threads as coord members of the
// mission, so the coord shim keeps accepting them. It goes through
// `MissionRouter.setMember`, the method the owner and master use, under
// `import` provenance, after the mission record exists.
//
// Create-missing only: an actor already enrolled is left alone, and one the
// owner or master removed since (the latest `member.changed` for it is a
// removal) stays out and is reported as `differs`. A re-run writes nothing.

import type { MissionId, MissionProvenance } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// ardud missions: router (enrolment goes through the master's member method)
import { coordMemberPrincipal, MissionRouter } from "../router/MissionRouter.ts";
import { RouterStore } from "../router/RouterStore.ts";
import { MissionStore } from "../store/MissionStore.ts";
import type { KindDiff } from "./apply.ts";
import type { CoordEnrolment, ImportPlan } from "./mapping.ts";

export const ENROLMENT_KIND = "coord-enrolment";
export const ENROLMENT_SOURCE = "coord.db";

const provenance: MissionProvenance = { _tag: "import", source: ENROLMENT_SOURCE };

/** The part of a `member.changed` payload the removal scan reads. */
const decodeMemberChange = Schema.decodeUnknownOption(
  Schema.Struct({ principal: Schema.String, member: Schema.Boolean }),
);

/** The enrolment row of the diff, plus which actors it would enrol. */
export interface EnrolmentDiff extends KindDiff {
  readonly createIds: ReadonlyArray<string>;
}

/** Principals whose latest `member.changed` event in the mission removed them. */
const removedPrincipals = (missionId: MissionId, principals: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const store = yield* MissionStore;
    const latest = new Map<string, boolean>();
    let after = 0;
    for (;;) {
      const page = yield* store.eventsSince(missionId, after);
      if (page.length === 0) break;
      for (const event of page) {
        if (event.kind !== "member.changed") continue;
        const change = Option.getOrUndefined(decodeMemberChange(event.payload));
        if (change !== undefined && principals.has(change.principal))
          latest.set(change.principal, change.member);
      }
      after = page.at(-1)!.seq;
    }
    return new Set([...latest].filter(([, member]) => !member).map(([principal]) => principal));
  });

const diffEnrolments$ = (plan: ImportPlan) =>
  Effect.gen(function* () {
    const rooms = yield* RouterStore;
    const planned = plan.enrolments.enrol;
    const missing: CoordEnrolment[] = [];
    for (const e of planned) {
      const rows = yield* rooms.membersByPrincipal(coordMemberPrincipal(e.actor));
      if (!rows.some((row) => row.missionId === plan.missionId)) missing.push(e);
    }
    const removed =
      missing.length === 0
        ? new Set<string>()
        : yield* removedPrincipals(
            plan.missionId,
            new Set(missing.map((e) => coordMemberPrincipal(e.actor))),
          );
    const create = missing.filter((e) => !removed.has(coordMemberPrincipal(e.actor)));
    const differIds = missing
      .filter((e) => removed.has(coordMemberPrincipal(e.actor)))
      .map((e) => e.actor);
    const diff: EnrolmentDiff = {
      kind: ENROLMENT_KIND,
      planned: planned.length,
      create: create.length,
      unchanged: planned.length - missing.length,
      differs: differIds.length,
      close: 0,
      differIds,
      createIds: create.map((e) => e.actor),
    };
    return { diff, create };
  });

/** Compares the planned coord enrolments with the router's member rows. Writes nothing. */
export const diffEnrolments = (plan: ImportPlan) =>
  diffEnrolments$(plan).pipe(Effect.map((p) => p.diff));

/** Enrols the missing actors. Run after `applyImport`: membership needs the mission. */
export const applyEnrolments = (plan: ImportPlan) =>
  Effect.gen(function* () {
    const router = yield* MissionRouter;
    const { diff, create } = yield* diffEnrolments$(plan);
    for (const e of create) {
      yield* router.setMember(
        {
          missionId: plan.missionId,
          principal: { _tag: "coord", actor: e.actor },
          member: true,
        },
        provenance,
      );
    }
    return { diff, enrolled: create.map((e) => e.actor) };
  });
