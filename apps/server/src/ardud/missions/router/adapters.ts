import type { MissionMessage, ReadPosition } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AsksRooms } from "../asks/ports.ts";
import type { RouterImportSink } from "../import/apply.ts";
import type { RouterImport } from "../import/mapping.ts";
import { contentHashOf } from "./hash.ts";
import { MissionRouter } from "./MissionRouter.ts";
import { actorKey } from "./model.ts";
import { RouterStore, type RecipientRow } from "./RouterStore.ts";

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
  /** Highest read position per `<roomId>|<readerKey>`, stored and incoming. */
  const readMarks = (batch: RouterImport) =>
    Effect.gen(function* () {
      const marks = new Map<string, ReadPosition>();
      const keep = (position: ReadPosition) => {
        const id = `${position.roomId}|${actorKey(position.reader)}`;
        const prior = marks.get(id);
        if (prior === undefined || prior.seq < position.seq) marks.set(id, position);
      };
      const roomIds = new Set(batch.messages.map(({ message }) => message.roomId));
      for (const roomId of roomIds) (yield* rooms.readPositions(roomId)).forEach(keep);
      batch.readPositions.forEach(keep);
      return marks;
    });
  /**
   * coord's delivery rows survive the import only as `to` and cumulative read
   * positions, so the ledger is rebuilt from those: acked up to each reader's
   * position, pending for thread-backed actors, skipped for the rest.
   */
  const ledgerOf = (message: MissionMessage, marks: ReadonlyMap<string, ReadPosition>) =>
    message.to.map((actor): RecipientRow => {
      const key = actorKey(actor);
      const mark = marks.get(`${message.roomId}|${key}`);
      const threadBacked =
        actor._tag === "role" || actor._tag === "lane" || actor._tag === "thread";
      return {
        key,
        status: threadBacked ? "pending" : "skipped",
        ackedAt: mark !== undefined && mark.seq >= message.seq ? mark.updatedAt : null,
      };
    });
  const sink: RouterImportSink = {
    existing: (kind, ids) => rooms.existingIds(kind, ids),
    write: (batch) =>
      Effect.gen(function* () {
        const marks = yield* readMarks(batch);
        yield* rooms.insertMissing({
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
            recipients: ledgerOf(message, marks),
          })),
          subscriptions: batch.subscriptions.map((subscription) => ({
            subscription,
            key: actorKey(subscription.subscriber),
          })),
          readPositions: batch.readPositions.map((position) => ({
            position,
            key: actorKey(position.reader),
          })),
        });
      }),
  };
  return sink;
});
