import {
  MissionError,
  WS_METHODS,
  type MessageBodyInput,
  type MissionProvenance,
  type MissionRoomsInput,
  type RoomPageInput,
  type RoomTuningInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ownerAppProvenance } from "../core/provenance.ts";
import type { MissionWsConnection } from "../ws.ts";
import type { MissionRouter } from "./MissionRouter.ts";

/** Readers that are not the paired owner app still read rooms, as a plain client. */
const CLIENT_READER: MissionProvenance = { _tag: "system", component: "ws-client" };

/**
 * Router WS handlers: rooms, pages, bodies and room wake rules for any
 * connection with read scope; posting, reading, subscriptions, members, knock
 * decisions, room tuning and the attention view only from a paired Robob
 * client session, with owner provenance from the session.
 */
export const makeRouterWsHandlers = (
  router: MissionRouter["Service"],
  connection: MissionWsConnection,
) => {
  const owner = ownerAppProvenance(connection);
  const reader = owner ?? CLIENT_READER;
  const asOwner =
    <I, A>(write: (input: I, provenance: MissionProvenance) => Effect.Effect<A, MissionError>) =>
    (input: I): Effect.Effect<A, MissionError> =>
      owner === null
        ? Effect.fail(
            new MissionError({
              code: "provenance-required",
              detail: "Owner actions need a paired Robob web, desktop or mobile session.",
            }),
          )
        : write(input, owner);

  return {
    [WS_METHODS.missionsRooms]: (input: MissionRoomsInput) => router.rooms(input.missionId, reader),
    [WS_METHODS.missionsRoomPage]: (input: RoomPageInput) => router.roomPage(input, reader),
    [WS_METHODS.missionsMessageBody]: (input: MessageBodyInput) =>
      router.messageBody(input, reader),
    [WS_METHODS.missionsPostMessage]: asOwner(router.post),
    [WS_METHODS.missionsMarkRead]: asOwner(router.markRead),
    [WS_METHODS.missionsSubscribeRoom]: asOwner(router.subscribe),
    [WS_METHODS.missionsSetMember]: asOwner(router.setMember),
    [WS_METHODS.missionsDecideKnock]: asOwner(router.decideKnock),
    [WS_METHODS.missionsRoomTuning]: (input: RoomTuningInput) => router.roomTuning(input, reader),
    [WS_METHODS.missionsTuneRoom]: asOwner(router.tuneRoom),
    // The attention view is the owner's and the master's, so it needs the paired session too.
    [WS_METHODS.missionsAttention]: asOwner(router.attention),
  } as const;
};
