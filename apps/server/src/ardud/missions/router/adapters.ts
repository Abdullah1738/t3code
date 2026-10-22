import type {
  Ask,
  InboxComment,
  MissionActor,
  MissionMessage,
  MissionRecordRef,
  ReadPosition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { askResolvedLine, AsksRooms, AsksSignals } from "../asks/ports.ts";
import { clipSummary } from "../asks/shared.ts";
import type { RouterImportSink } from "../import/apply.ts";
import type { RouterImport } from "../import/mapping.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { contentHashOf } from "./hash.ts";
import { controlRoomId, MissionRouter } from "./MissionRouter.ts";
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

const ASKS_PROVENANCE = { _tag: "system", component: "asks" } as const;

/**
 * Who should hear that a record is free again: a work item's holder or lane,
 * and lanes, roles and threads as themselves. Anything else has no thread.
 */
const ownerOfRecord = (store: MissionStore.MissionStore["Service"], ref: MissionRecordRef) =>
  Effect.gen(function* () {
    switch (ref.kind) {
      case "work-item": {
        const item = Option.getOrNull(yield* store.get("work-item", ref.id));
        if (item === null) return null;
        if (item.heldBy !== null) return item.heldBy;
        return item.laneId === null ? null : ({ _tag: "lane", laneId: item.laneId } as const);
      }
      case "lane": {
        const lane = Option.getOrNull(yield* store.get("lane", ref.id));
        return lane === null ? null : ({ _tag: "lane", laneId: lane.id } as const);
      }
      case "role": {
        const role = Option.getOrNull(yield* store.get("role", ref.id));
        return role === null ? null : ({ _tag: "role", roleId: role.id } as const);
      }
      default:
        return null;
    }
  });

const threadBacked = (actor: MissionActor) =>
  actor._tag === "role" || actor._tag === "lane" || actor._tag === "thread";

/**
 * Answered, withdrawn or superseded asks reach the asker and whoever holds the
 * released records as a decision in the mission's control room, so they ring
 * the doorbell like every other message. The key makes a replay a no-op.
 * A failed post is logged; it never fails the answer itself.
 */
export const asksSignalsLayer = Layer.effect(
  AsksSignals,
  Effect.gen(function* () {
    const router = yield* MissionRouter;
    const store = yield* MissionStore.MissionStore;
    const askResolved = (input: {
      readonly ask: Ask;
      readonly released: ReadonlyArray<MissionRecordRef>;
      readonly comments?: ReadonlyArray<InboxComment>;
    }) =>
      Effect.gen(function* () {
        const { ask, released } = input;
        const to = new Map<string, MissionActor>();
        const add = (actor: MissionActor | null) => {
          if (actor !== null && threadBacked(actor)) to.set(actorKey(actor), actor);
        };
        add(ask.askedBy);
        for (const ref of released) add(yield* ownerOfRecord(store, ref));
        if (to.size === 0) return;
        const line = askResolvedLine(ask, released, input.comments);
        const summary = clipSummary(line);
        yield* router.relay({
          input: {
            missionId: ask.missionId,
            roomId: controlRoomId(ask.missionId),
            kind: "decision",
            summary,
            ...(summary === line ? {} : { body: line }),
            to: [...to.values()],
            key: `ask:${ask.id}:${ask.status}:${ask.updatedAt}`,
          },
          provenance: ASKS_PROVENANCE,
          author: ASKS_PROVENANCE,
          authorThread: null,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("missions router: ask signal failed", { askId: input.ask.id, cause }),
        ),
      );
    return AsksSignals.of({ askResolved });
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
