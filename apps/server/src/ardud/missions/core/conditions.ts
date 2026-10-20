import { MissionError, type MissionRecordRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OwnerConditions } from "../discuss/OwnerConditions.ts";

type Conditions = OwnerConditions["Service"];

/** Without the router nothing verifies, so only the owner decides. */
const NO_OWNER_CONDITIONS: Conditions = {
  verify: () =>
    Effect.fail(
      new MissionError({
        code: "forbidden",
        detail: "Owner conditions are not available on this server; the owner decides.",
      }),
    ),
  settleFor: () => Effect.void,
};

/** The router's Discuss port when the server has one. */
export const ownerConditions = Effect.map(Effect.serviceOption(OwnerConditions), (found) =>
  Option.getOrElse(found, () => NO_OWNER_CONDITIONS),
);

/** Closes the owner's conversation about a record once it is settled; a failure only logs. */
export const settleDiscussion = (
  conditions: Conditions,
  subject: MissionRecordRef,
  note: string | null,
) =>
  conditions.settleFor({ subject, note }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Mission discussion did not settle", {
        subject: `${subject.kind}:${subject.id}`,
        detail: error.detail,
      }),
    ),
  );
