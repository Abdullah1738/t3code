import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  type MissionId,
  type MissionProvenance,
  type SecretRequestAnswerInput,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OWNER_SESSION_REQUIRED } from "./provenance.ts";

/** Why a secret card refused an answer. Never echoes the request or the value. */
export const SECRET_ANSWER_OWNER_REQUIRED = `Only the owner can answer a secret request. ${OWNER_SESSION_REQUIRED}`;

/** Why a master's close was refused: it may decline or withdraw a card, never fill one. */
export const SECRET_VALUE_OWNER_ONLY =
  "A mission's master may decline or withdraw a member's secret request; only the owner supplies a value.";

/**
 * A secret card's answer. The owner's clients send `save` or `decline`;
 * `withdraw` closes the card as cancelled, as if the agent had stopped asking.
 */
export type SecretAnswer = SecretRequestAnswerInput["answer"] | { readonly type: "withdraw" };
export type SecretAnswerInput = Omit<SecretRequestAnswerInput, "answer"> & {
  readonly answer: SecretAnswer;
};

export const secretStatusOf = (answer: SecretAnswer) =>
  answer.type === "save" ? "saved" : answer.type === "decline" ? "declined" : "cancelled";

const grantKey = Symbol("MasterSecretClose");

/**
 * Proof that the master check passed for one card, bound to that card and
 * frozen. `MasterControls.closeSecretRequest` mints it in-process after reading
 * the mission's whole cast; a transport can't send one, since it never comes
 * from headers or a body.
 */
export class MasterSecretClose {
  readonly threadId: ThreadId;
  readonly turnItemId: TurnItemId;
  readonly missionId: MissionId;
  readonly master: MissionProvenance;

  constructor(
    key: typeof grantKey,
    input: {
      readonly threadId: ThreadId;
      readonly turnItemId: TurnItemId;
      readonly missionId: MissionId;
      readonly master: MissionProvenance;
    },
  ) {
    if (key !== grantKey) throw new Error("MasterSecretClose is minted by MasterControls only.");
    this.threadId = input.threadId;
    this.turnItemId = input.turnItemId;
    this.missionId = input.missionId;
    this.master = input.master;
    Object.freeze(this);
  }
}

// Grants this module minted. `instanceof` alone would accept an object built
// on the class prototype without running the constructor.
const minted = new WeakSet<MasterSecretClose>();

/** For `MasterControls.closeSecretRequest`, once the caller is the member's master. */
export const grantMasterSecretClose = (
  input: ConstructorParameters<typeof MasterSecretClose>[1],
) => {
  const grant = new MasterSecretClose(grantKey, input);
  minted.add(grant);
  return grant;
};

const refuse = (message: string) =>
  Effect.fail(
    new EnvironmentAuthorizationError({
      message,
      requiredScope: AuthOrchestrationOperateScope,
      requiredPermission: "owner",
    }),
  );

/**
 * A secret card is addressed to the owner, so only a session carrying the
 * paired owner claim saves a value into it. The control token, component
 * credentials, agents and chat bridges never reach a value into a card, and
 * the refusal happens before anything is stored or recorded. The one other
 * answer is a master's close: decline or withdraw, for this card only.
 */
export const requireSecretAnswerAuthority = (
  input: SecretAnswerInput,
  answeredBy: MissionProvenance | MasterSecretClose | null,
) => {
  if (answeredBy instanceof MasterSecretClose) {
    const sameCard =
      minted.has(answeredBy) &&
      answeredBy.threadId === input.threadId &&
      answeredBy.turnItemId === input.turnItemId;
    return sameCard && input.answer.type !== "save" ? Effect.void : refuse(SECRET_VALUE_OWNER_ONLY);
  }
  return answeredBy?._tag === "owner-app" ? Effect.void : refuse(SECRET_ANSWER_OWNER_REQUIRED);
};
