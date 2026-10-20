import {
  isOwnerProvenance,
  MissionError,
  type Call,
  type MissionProvenance,
  type MissionRecordRef,
  type ReviseCallInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { settleDiscussion } from "./conditions.ts";
import type { WriteKit } from "./kit.ts";
import { isMasterOf } from "./master.ts";

const fail = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

const callRef = (call: Call): MissionRecordRef => ({
  kind: "call",
  id: call.id,
  label: call.title,
});

/** Calls are made by asks; core only revises one on a condition the owner stated in Discuss. */
export const makeCallWrites = (kit: WriteKit) => {
  const { store, conditions, serial, commit } = kit;

  const reviseCall = (provenance: MissionProvenance, input: ReviseCallInput) =>
    serial(
      Effect.gen(function* () {
        const found = yield* store.get("call", input.callId);
        if (Option.isNone(found)) {
          return yield* fail("not-found", `No call ${input.callId}.`);
        }
        const before = found.value;
        if (isOwnerProvenance(provenance)) {
          return yield* fail(
            "invalid",
            "The owner reacts to calls directly; owner conditions are for the master.",
          );
        }
        if (!(yield* isMasterOf(store, before.missionId, provenance))) {
          return yield* fail(
            "forbidden",
            `Only mission ${before.missionId}'s master revises its calls.`,
          );
        }
        yield* conditions.verify({ subject: callRef(before), condition: input.onOwnerCondition });
        const record: Call = {
          ...before,
          decision: input.decision,
          reason: input.reason ?? before.reason,
          ownerReaction: null,
          onOwnerCondition: input.onOwnerCondition,
        };
        return yield* commit(provenance, {
          missionId: before.missionId,
          kind: "call.revised",
          summary: `Call revised on the owner's condition: ${record.title} - ${record.decision}`,
          ref: callRef(record),
          upserts: [{ _tag: "call", record }],
          payload: { previousDecision: before.decision, previousReason: before.reason },
        });
      }),
    ).pipe(
      Effect.tap((result) =>
        settleDiscussion(conditions, result.ref, "Revised on your condition."),
      ),
    );

  return { reviseCall };
};
