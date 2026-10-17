import {
  MissionError,
  WS_METHODS,
  type ClientSurface,
  type MissionInboxInput,
  type MissionProvenance,
  type MissionSubscribeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ownerAppProvenance } from "./core/provenance.ts";
import type * as MissionService from "./MissionService.ts";

/**
 * Missions WS handlers, spread into the server's RPC group. Reads need
 * orchestration:read; mutations need orchestration:operate and only count as
 * the owner when the connection is a Robob client UI (web, desktop, mobile).
 */
export const makeMissionWsHandlers = (
  missions: MissionService.MissionService["Service"],
  connection: { readonly surface: ClientSurface | undefined; readonly sessionId: string },
) => {
  const provenance = ownerAppProvenance(connection);
  const asOwner = <I, A>(
    write: (provenance: MissionProvenance, input: I) => Effect.Effect<A, MissionError>,
  ) =>
    provenance === null
      ? (_input: I) =>
          Effect.fail(
            new MissionError({
              code: "provenance-required",
              detail: "Owner actions need a Robob web, desktop or mobile connection.",
            }),
          )
      : (input: I) => write(provenance, input);

  return {
    [WS_METHODS.missionsSubscribeList]: (_input: unknown) => missions.subscribeList,
    [WS_METHODS.missionsSubscribe]: (input: MissionSubscribeInput) =>
      missions.subscribe(input.missionId),
    [WS_METHODS.missionsInbox]: (input: MissionInboxInput) =>
      missions.subscribeInbox(input.missionId ?? null),
    [WS_METHODS.missionsCreate]: asOwner(missions.createMission),
    [WS_METHODS.missionsUpdate]: asOwner(missions.updateMission),
    [WS_METHODS.missionsSetStatus]: asOwner(missions.setMissionStatus),
    [WS_METHODS.missionsSetFocus]: asOwner(missions.setMissionFocus),
    [WS_METHODS.missionsSetSubMissionStatus]: asOwner(missions.setSubMissionStatus),
    [WS_METHODS.missionsReorderSubMissions]: asOwner(missions.reorderSubMissions),
    [WS_METHODS.missionsLockField]: asOwner(missions.lockField),
    [WS_METHODS.missionsMarkSeen]: asOwner(missions.markSeen),
  } as const;
};
