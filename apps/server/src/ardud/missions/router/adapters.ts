import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AsksRooms } from "../asks/ports.ts";
import type { RouterImportSink } from "../import/apply.ts";
import { contentHashOf } from "./hash.ts";
import { MissionRouter } from "./MissionRouter.ts";
import { actorKey } from "./model.ts";
import { RouterStore } from "./RouterStore.ts";

/** `mission_post` and the asks desk post through the router's rooms. */
export const asksRoomsLayer = Layer.effect(
  AsksRooms,
  Effect.gen(function* () {
    const router = yield* MissionRouter;
    return AsksRooms.of({ post: (input, provenance) => router.post(input, provenance) });
  }),
);

/**
 * The coord import's router side over the router tables. Writes only what
 * is missing and run inside the import's `import.applied` commit.
 */
export const routerImportSink = Effect.gen(function* () {
  const rooms = yield* RouterStore;
  const sink: RouterImportSink = {
    existing: (kind, ids) => rooms.existingIds(kind, ids),
    write: (batch) =>
      rooms.insertMissing({
        rooms: batch.rooms,
        messages: batch.messages.map(({ message, body }) => ({
          message,
          body,
          contentHash: contentHashOf({
            roomId: message.roomId,
            kind: message.kind,
            summary: message.summary,
            body,
            to: message.to,
            workItemId: message.workItemId,
            links: message.links,
            isCorrection: message.isCorrection,
          }),
        })),
        subscriptions: batch.subscriptions.map((subscription) => ({
          subscription,
          key: actorKey(subscription.subscriber),
        })),
        readPositions: batch.readPositions.map((position) => ({
          position,
          key: actorKey(position.reader),
        })),
      }),
  };
  return sink;
});
