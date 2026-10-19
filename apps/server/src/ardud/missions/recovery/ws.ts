import {
  MISSIONS_RECOVERY_WS_METHODS as M,
  MissionError,
  type MissionId,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OWNER_SESSION_REQUIRED } from "../core/provenance.ts";
import type { RecoveryService } from "./RecoveryService.ts";

/**
 * Recovery WS handlers for the app. The status read needs orchestration:read;
 * resume and settings need orchestration:operate and run as the owner, so
 * they only work from a paired Robob client. The caller passes the owner
 * provenance it derived from the connection, or null when the connection is
 * not one. The master changes recovery through its MCP tools instead.
 */
export const makeRecoveryWsHandlers = (
  recovery: RecoveryService["Service"],
  owner: MissionProvenance | null,
) => {
  const asOwner = <I, A>(
    write: (provenance: MissionProvenance, input: I) => Effect.Effect<A, MissionError>,
  ) =>
    owner === null
      ? (_input: I) =>
          Effect.fail(
            new MissionError({
              code: "provenance-required",
              detail: OWNER_SESSION_REQUIRED,
            }),
          )
      : (input: I) => write(owner, input);

  return {
    [M.status]: (input: { readonly missionId: MissionId }) => recovery.status(input.missionId),
    [M.resume]: asOwner(recovery.resume),
    [M.settings]: asOwner(recovery.setSettings),
  } as const;
};
