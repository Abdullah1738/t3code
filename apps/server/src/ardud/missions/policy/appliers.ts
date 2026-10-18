/**
 * Applies accepted suggestions that belong to the policy track (roles, role
 * models, review policy, criticality guide, pools) through the same service
 * methods a person's edit uses, so the change lands on the timeline with the
 * decider's actor and provenance.
 *
 * Wiring: asks/wiring.ts registers `appliersFor(policy)` for the policy kinds
 * in asks' applier registry; asks calls it when such a suggestion is accepted.
 * Kinds other tracks own say so in the outcome.
 */
import {
  CriticalityTrigger,
  MissionError,
  MissionId,
  ModelSelection,
  PoolId,
  ReviewLadder,
  ReviewPolicy,
  ReviewStage,
  RoleId,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { SUGGESTION_OWNERS, SuggestionAppliers } from "../asks/ports.ts";
import type { SuggestionApplication } from "../asks/suggestionModel.ts";
import type * as PolicyService from "./PolicyService.ts";

const RoleModelAfter = Schema.Union([
  ModelSelection,
  Schema.Struct({ modelSelection: ModelSelection }),
]);
const RoleAfter = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  writesPublicText: Schema.optional(Schema.Boolean),
});
const PoolAfter = Schema.Struct({
  capacity: Schema.optional(Schema.Number),
  name: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Array(MissionId)),
});
const GuideAfter = Schema.Struct({
  text: Schema.String,
  hardTriggers: Schema.optional(Schema.Array(CriticalityTrigger)),
});
const PolicyAfter = Schema.Struct({
  stages: Schema.optional(Schema.Array(ReviewStage)),
  ladders: Schema.optional(Schema.Array(ReviewLadder)),
  commonRules: Schema.optional(Schema.Array(Schema.String)),
  judgedBy: Schema.optional(ReviewPolicy.fields.judgedBy),
});

const decodeRoleModel = Schema.decodeUnknownOption(RoleModelAfter);
const decodeRole = Schema.decodeUnknownOption(RoleAfter);
const decodePool = Schema.decodeUnknownOption(PoolAfter);
const decodeGuide = Schema.decodeUnknownOption(GuideAfter);
const decodePolicy = Schema.decodeUnknownOption(PolicyAfter);

const invalid = (detail: string) => Effect.fail(new MissionError({ code: "invalid", detail }));

const decoded = <A>(value: Option.Option<A>, kind: string) =>
  Option.match(value, {
    onNone: () => invalid(`The accepted ${kind} suggestion has a change the policy cannot read.`),
    onSome: (after: A) => Effect.succeed(after),
  });

const targetId = (application: SuggestionApplication, kind: string) =>
  application.target !== null && application.target.kind === kind
    ? Effect.succeed(application.target.id)
    : invalid(`The accepted suggestion does not point at a ${kind}.`);

/** Mission a review-policy or guide suggestion edits: its mission, else its target. */
const missionOf = (application: SuggestionApplication) => {
  if (application.suggestion.missionId !== null) {
    return Effect.succeed(application.suggestion.missionId);
  }
  const target = application.target;
  return target !== null && (target.kind === "review-policy" || target.kind === "mission")
    ? Effect.succeed(MissionId.make(target.id))
    : invalid("The accepted suggestion names no mission.");
};

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const applySuggestion = (
  policy: PolicyService.PolicyService["Service"],
  application: SuggestionApplication,
  provenance: MissionProvenance,
): Effect.Effect<string, MissionError> =>
  Effect.gen(function* () {
    const reason = `Accepted suggestion: ${application.suggestion.title}`;
    switch (application.targetKind) {
      case "role-model": {
        const roleId = RoleId.make(yield* targetId(application, "role"));
        const after = yield* decoded(decodeRoleModel(application.after), "role model");
        const modelSelection = "modelSelection" in after ? after.modelSelection : after;
        const result = yield* policy.setRoleModel(provenance, { roleId, modelSelection, reason });
        return `Applied: ${roleId} moves to ${modelSelection.model} at each holder's next turn (seq ${result.seq}).`;
      }
      case "role": {
        const roleId = RoleId.make(yield* targetId(application, "role"));
        const after = yield* decoded(decodeRole(application.after), "role");
        const name = nonEmpty(after.name);
        const result = yield* policy.updateRole(provenance, {
          roleId,
          ...(name !== undefined ? { name } : {}),
          ...(after.description !== undefined ? { description: after.description } : {}),
          ...(after.writesPublicText !== undefined
            ? { writesPublicText: after.writesPublicText }
            : {}),
        });
        return `Applied: role ${roleId} updated (seq ${result.seq}).`;
      }
      case "pool": {
        const poolId = PoolId.make(yield* targetId(application, "pool"));
        const after = yield* decoded(decodePool(application.after), "pool");
        const done: Array<string> = [];
        const name = nonEmpty(after.name);
        const unit = nonEmpty(after.unit);
        if (name !== undefined || unit !== undefined || after.priority !== undefined) {
          yield* policy.updatePool(provenance, {
            poolId,
            ...(name !== undefined ? { name } : {}),
            ...(unit !== undefined ? { unit } : {}),
            ...(after.priority !== undefined ? { priority: after.priority } : {}),
          });
          done.push("details");
        }
        if (after.capacity !== undefined) {
          yield* policy.setPoolCapacity(provenance, { poolId, capacity: after.capacity });
          done.push(`capacity ${after.capacity}`);
        }
        if (done.length === 0)
          return yield* invalid("The accepted pool suggestion changes nothing.");
        return `Applied: pool ${poolId} ${done.join(" and ")}.`;
      }
      case "criticality-guide": {
        const missionId = yield* missionOf(application);
        const after = yield* decoded(decodeGuide(application.after), "criticality guide");
        yield* policy.setCriticalityGuide(provenance, {
          missionId,
          text: after.text,
          ...(after.hardTriggers !== undefined ? { hardTriggers: after.hardTriggers } : {}),
        });
        return `Applied: criticality guide for ${missionId} updated.`;
      }
      case "review-policy": {
        const missionId = yield* missionOf(application);
        const after = yield* decoded(decodePolicy(application.after), "review policy");
        yield* policy.editReviewPolicy(provenance, {
          missionId,
          ...(after.stages !== undefined ? { stages: after.stages } : {}),
          ...(after.ladders !== undefined ? { ladders: after.ladders } : {}),
          ...(after.commonRules !== undefined ? { commonRules: after.commonRules } : {}),
          ...(after.judgedBy !== undefined ? { judgedBy: after.judgedBy } : {}),
        });
        return `Applied: review policy for ${missionId} updated.`;
      }
      default:
        return `Accepted; not applied yet: the ${SUGGESTION_OWNERS[application.targetKind]} service for ${application.targetKind} is not wired.`;
    }
  });

/** A `SuggestionAppliers` that applies policy kinds; other kinds keep the pending line. */
export const appliersFor = (policy: PolicyService.PolicyService["Service"]) =>
  SuggestionAppliers.of({
    apply: (application, provenance) => applySuggestion(policy, application, provenance),
  });
