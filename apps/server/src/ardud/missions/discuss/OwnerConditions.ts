/**
 * Discuss: the owner talks to the master about a record (an ask, draft,
 * approval, call...) in an owner request whose `subject` is that record. The
 * master may then decide the record on a condition the owner stated there.
 *
 * Deciding services (asks, core) depend on this port only; the router
 * implements it over its owner-request records and rooms. A deciding service
 * calls `verify` before it records `decidedBy: master` with `onOwnerCondition`,
 * and `settleFor` after it settles the record, so the conversation closes with it.
 */
import type { MissionError, MissionRecordRef, OwnerCondition } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class OwnerConditions extends Context.Service<
  OwnerConditions,
  {
    /**
     * Succeeds only when `condition.requestId` is an owner request about
     * `subject` and `condition.quote` appears verbatim in one of the owner's own
     * messages in it. Fails `forbidden` otherwise.
     */
    readonly verify: (input: {
      readonly subject: MissionRecordRef;
      readonly condition: OwnerCondition;
    }) => Effect.Effect<void, MissionError>;
    /** Settles the open request about `subject`, if any. A no-op when there is none. */
    readonly settleFor: (input: {
      readonly subject: MissionRecordRef;
      readonly note: string | null;
    }) => Effect.Effect<void, MissionError>;
  }
>()("t3/ardud/missions/discuss/OwnerConditions") {}

/** For tests and for servers without the router: nothing verifies, nothing to settle. */
export const refuseAllLayer = (refuse: () => MissionError) =>
  Layer.succeed(
    OwnerConditions,
    OwnerConditions.of({
      verify: () => Effect.fail(refuse()),
      settleFor: () => Effect.void,
    }),
  );
