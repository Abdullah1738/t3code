import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OWNER_SESSION_REQUIRED } from "./provenance.ts";

/** Why a secret card refused an answer. Never echoes the request or the value. */
export const SECRET_ANSWER_OWNER_REQUIRED = `Only the owner can answer a secret request. ${OWNER_SESSION_REQUIRED}`;

/**
 * A secret card is addressed to the owner, so only a session carrying the
 * paired owner claim saves or declines it. The control token, component
 * credentials, agents and chat bridges never reach a value into a card, and
 * the refusal happens before anything is stored or recorded.
 */
export const requireOwnerSecretAnswer = (answeredBy: MissionProvenance | null) =>
  answeredBy?._tag === "owner-app"
    ? Effect.void
    : Effect.fail(
        new EnvironmentAuthorizationError({
          message: SECRET_ANSWER_OWNER_REQUIRED,
          requiredScope: AuthOrchestrationOperateScope,
          requiredPermission: "owner",
        }),
      );
