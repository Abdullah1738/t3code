import {
  MissionError,
  type EnvironmentAuthorizationError,
  type MissionId,
  type MissionProvenance,
  type SecretRequestError,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { isParticipant, standingOf } from "../asks/standing.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { castOf, missionsMasteredBy } from "./master.ts";
import { actorOf } from "./provenance.ts";
import { grantMasterSecretClose } from "./secrets.ts";

export interface CloseSecretRequestInput {
  readonly missionId: MissionId;
  /** The member thread whose card it is. */
  readonly threadId: ThreadId;
  readonly turnItemId: TurnItemId;
  readonly closeAs: "decline" | "withdraw";
}

export interface CloseSecretRequestResult {
  readonly seq: number;
  readonly status: "declined" | "cancelled";
}

/** Master controls that reach past a single mission's records. */
export class MasterControls extends Context.Service<
  MasterControls,
  {
    /**
     * The caller as the master of some mission (its master role), or null.
     * Found from the store's complete thread index, so a master is never
     * missed because a capped mission list left its mission out. A thread
     * that masters several missions must name the one it acts for
     * (`actingFor`); naming one it does not master is forbidden.
     */
    readonly asAnyMaster: (
      provenance: MissionProvenance,
      actingFor?: MissionId,
    ) => Effect.Effect<MissionProvenance | null, MissionError>;
    /**
     * A mission master's hold on its members' secret cards: it may decline one
     * (the agent hears no) or withdraw it (closed as cancelled), never fill
     * one. The value stays the owner's, answered from the owner's own session.
     */
    readonly closeSecretRequest: (
      provenance: MissionProvenance,
      input: CloseSecretRequestInput,
    ) => Effect.Effect<CloseSecretRequestResult, MissionError>;
  }
>()("t3/ardud/missions/core/MasterControls") {}

const forbidden = (detail: string) => new MissionError({ code: "forbidden", detail });

const fromSecretError = (error: SecretRequestError | EnvironmentAuthorizationError) => {
  if (error._tag === "EnvironmentAuthorizationError") return forbidden(error.message);
  switch (error.reason) {
    case "not_found":
      return new MissionError({ code: "not-found", detail: error.message });
    case "already_answered":
    case "agent_stopped":
      return new MissionError({ code: "conflict", detail: error.message });
    default:
      return new MissionError({ code: "invalid", detail: error.message });
  }
};

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const secrets = yield* SecretRequests.SecretRequests;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const readCard = (threadId: ThreadId, turnItemId: TurnItemId) =>
    threads
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError(
          () =>
            new MissionError({
              code: "invalid",
              detail: `The card on thread ${threadId} could not be read.`,
            }),
        ),
        Effect.map(({ turnItems }) => {
          const card = turnItems.find((item) => item.id === turnItemId);
          return card?.type === "secret_request" ? card : null;
        }),
      );

  const asAnyMaster: MasterControls["Service"]["asAnyMaster"] = (provenance, actingFor) =>
    Effect.gen(function* () {
      const mastered = yield* missionsMasteredBy(store, provenance);
      if (actingFor !== undefined && !mastered.includes(actingFor)) {
        return yield* forbidden(`You are not mission ${actingFor}'s master.`);
      }
      if (actingFor === undefined && mastered.length > 1) {
        return yield* new MissionError({
          code: "invalid",
          detail: `You master missions ${mastered.join(", ")}; name the one you act for (actingFor).`,
        });
      }
      const missionId = actingFor ?? mastered[0];
      if (missionId === undefined) return null;
      return standingOf(yield* castOf(store, missionId), provenance).caller.provenance;
    });

  const closeSecretRequest: MasterControls["Service"]["closeSecretRequest"] = (provenance, input) =>
    Effect.gen(function* () {
      if (provenance._tag !== "agent") {
        return yield* forbidden(
          "Only a mission's master closes a member's secret request; the owner answers cards in Robob.",
        );
      }
      const cast = yield* castOf(store, input.missionId);
      if (cast.mission === null) {
        return yield* new MissionError({
          code: "not-found",
          detail: `Mission ${input.missionId} does not exist.`,
        });
      }
      const master = standingOf(cast, provenance);
      if (!master.isMaster) {
        return yield* forbidden(
          `Only mission ${input.missionId}'s master closes its members' secret requests.`,
        );
      }
      const memberProvenance = { _tag: "agent", threadId: input.threadId, roleId: null } as const;
      if (!isParticipant(standingOf(cast, memberProvenance))) {
        return yield* forbidden(
          `Thread ${input.threadId} holds no role, lane or fork in mission ${input.missionId}.`,
        );
      }
      // Enlisting a thread doesn't make it this master's alone: a thread that
      // also works in a mission this caller doesn't master keeps its cards.
      for (const otherId of yield* store.missionsOfThread(input.threadId)) {
        if (otherId === input.missionId) continue;
        const other = yield* castOf(store, otherId);
        if (
          isParticipant(standingOf(other, memberProvenance)) &&
          !standingOf(other, provenance).isMaster
        ) {
          return yield* forbidden(
            `Thread ${input.threadId} also works in mission ${otherId}, which you don't master.`,
          );
        }
      }
      const before = yield* readCard(input.threadId, input.turnItemId);
      if (before === null) {
        return yield* new MissionError({
          code: "not-found",
          detail: `Thread ${input.threadId} has no secret request ${input.turnItemId}.`,
        });
      }
      if (before.secretStatus !== "pending") {
        return yield* new MissionError({
          code: "conflict",
          detail: `The secret request was already ${before.secretStatus}.`,
        });
      }
      const status = input.closeAs === "decline" ? "declined" : "cancelled";
      const payload = { threadId: input.threadId, turnItemId: input.turnItemId, closedAs: status };
      const actor = actorOf(master.caller.provenance);
      // The timeline entry goes first: the card lives in the thread's own
      // store, so a close that lands is never missing from the timeline. A
      // close that doesn't land is undone by a second entry.
      const closed = yield* store.appendEvent({
        missionId: input.missionId,
        kind: "secret-request.closed",
        actor,
        provenance: master.caller.provenance,
        summary:
          input.closeAs === "decline"
            ? `Declined a secret request from thread ${input.threadId}.`
            : `Withdrew a secret request from thread ${input.threadId}.`,
        subject: null,
        payload,
      });
      const undo = (error: MissionError) =>
        store
          .appendEvent({
            missionId: input.missionId,
            kind: "secret-request.close-failed",
            actor,
            provenance: master.caller.provenance,
            summary: `The secret request from thread ${input.threadId} stayed open: ${error.detail}`,
            subject: null,
            causedBy: closed.id,
            payload,
          })
          .pipe(Effect.andThen(Effect.fail(error)));
      // The owner's decline runs through the same method; the grant only
      // lets this card be declined or withdrawn.
      yield* secrets
        .answer(
          {
            threadId: input.threadId,
            turnItemId: input.turnItemId,
            answer: { type: input.closeAs },
          },
          grantMasterSecretClose({
            threadId: input.threadId,
            turnItemId: input.turnItemId,
            missionId: input.missionId,
            master: master.caller.provenance,
          }),
        )
        .pipe(Effect.mapError(fromSecretError), Effect.catch(undo));
      // A close that loses a race to the owner's answer changes nothing.
      const after = yield* readCard(input.threadId, input.turnItemId);
      if (after?.secretStatus !== status) {
        return yield* undo(
          new MissionError({
            code: "conflict",
            detail: "The secret request was answered before your close was recorded.",
          }),
        );
      }
      return { seq: closed.seq, status };
    });

  return MasterControls.of({ asAnyMaster, closeSecretRequest });
});

export const layer = Layer.effect(MasterControls, make);
