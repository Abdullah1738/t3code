/**
 * Who may act as the owner on a board. The board's HTTP routes and WS RPCs
 * pass the constant owner actor to the engine, so the transport decides who
 * that is: only a session that carries the owner claim (minted from one of
 * the owner's pairing roots, see `SessionOrigins.ts`). The operate scope is
 * not enough, since every component credential, CLI-issued session and
 * Mac-made pairing link has it. Read from the session the cookie, bearer or
 * socket ticket maps to, never from the request.
 */
import { KanbanError, isPairedDeviceSubject } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isOwnerSession } from "../auth/provenance.ts";
import type { SessionOrigin } from "../auth/SessionOrigins.ts";

export interface OwnerGateSession {
  readonly sessionId: string;
  readonly subject: string;
  readonly origin?: SessionOrigin | undefined;
}

/** Shown as it is by the apps: what to do on a device that is his but was not paired as his. */
export const NOT_OWNER_DEVICE_MESSAGE =
  "This device isn't paired as yours. Pair it again from Settings > Connections in the Robob desktop app.";

export const NOT_OWNER_MESSAGE =
  "Only the owner does this, from a Robob app he paired. A token, a CLI session or a component credential is not the owner.";

/** Null for the owner's own session. Otherwise the refusal: `denied`, with a reason for a paired device. */
export const ownerRefusal = (session: OwnerGateSession): KanbanError | null => {
  if (isOwnerSession(session)) return null;
  if (session.origin?._tag === "component") {
    return new KanbanError({
      code: "denied",
      detail: `${NOT_OWNER_MESSAGE} This is the ${session.origin.component} component's session.`,
    });
  }
  if (session.origin === undefined && isPairedDeviceSubject(session.subject)) {
    return new KanbanError({
      code: "denied",
      detail: NOT_OWNER_DEVICE_MESSAGE,
      reason: "not_owner_device",
    });
  }
  return new KanbanError({ code: "denied", detail: NOT_OWNER_MESSAGE });
};

/**
 * The refusal for a paired device that is not the owner's, and null for any
 * other session. For owner checks that have their own refusal for everyone
 * else and only want to tell such a device how to become his.
 */
export const notOwnerDeviceRefusal = (session: OwnerGateSession): KanbanError | null => {
  const refusal = ownerRefusal(session);
  return refusal?.reason === "not_owner_device" ? refusal : null;
};

/** Fails with the refusal unless the session is the owner's own. */
export const requireOwner = (session: OwnerGateSession): Effect.Effect<void, KanbanError> => {
  const refusal = ownerRefusal(session);
  return refusal === null ? Effect.void : Effect.fail(refusal);
};
