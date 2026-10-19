import {
  MissionId,
  MissionMessage,
  ReadPosition,
  Room,
  Subscription,
  type MissionMessageId,
  type MissionMessageKind,
  type RoomId,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { actorKey, type MemberKind } from "./model.ts";

/**
 * Router tables. Knocks are core mission records (the owner inbox reads them);
 * rooms and the high-volume parts (messages, bodies, subscriptions, read
 * positions, membership and the doorbell bookkeeping) live here. Writes run
 * inside a core commit (`MissionCommit.alongside`) so the timeline event and
 * the router rows land in one transaction.
 *
 * - `rooms`: one row per room; `lastSeq`/`lastMessageAt` move with each post.
 * - `messages`: one row per message, `seq` per mission, optional idempotency key.
 * - `deliveries`: one row per (thread, message) that should wake the thread.
 *   `wake_id` set = covered by a doorbell; `read` = the thread read past it.
 * - `doorbells`: at most one outstanding wake per thread.
 * - `wakes`: every ring, for the noise meter's wasted-wake count.
 * - `members`: explicit membership (`thread:<id>` or `session:<id>`).
 * - `recipients`: coord's delivery ledger, one row per (message, recipient
 *   actor key) with `pending`/`skipped` and an ack time. It answers the coord
 *   shim's inbox and ack the way coord.db did; wakes stay with `deliveries`.
 * - `tuning`: per-room mute flag and when the owner or master last tuned it.
 * - `reminders`: deliveries that got their one reminder. Still unread after it
 *   means the master's attention view, never another ring.
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_rooms (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    room_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_router_rooms_by_mission
    ON ardud_mission_router_rooms (mission_id, kind)`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_messages (
    mission_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    room_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    msg_key TEXT,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    message_json TEXT NOT NULL,
    PRIMARY KEY (mission_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_router_messages_by_room
    ON ardud_mission_router_messages (room_id, seq)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ardud_mission_router_messages_by_key
    ON ardud_mission_router_messages (mission_id, msg_key) WHERE msg_key IS NOT NULL`,
  // Owner-request keys carry the iMessage id, which must post once across missions.
  `CREATE INDEX IF NOT EXISTS ardud_mission_router_messages_by_bare_key
    ON ardud_mission_router_messages (msg_key) WHERE msg_key IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_bodies (
    message_id TEXT PRIMARY KEY,
    body TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_subscriptions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    subscriber_key TEXT NOT NULL,
    subscription_json TEXT NOT NULL,
    UNIQUE (room_id, subscriber_key)
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_reads (
    room_id TEXT NOT NULL,
    reader_key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    position_json TEXT NOT NULL,
    PRIMARY KEY (room_id, reader_key)
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_members (
    mission_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    added_at TEXT NOT NULL,
    PRIMARY KEY (mission_id, principal)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_router_members_by_principal
    ON ardud_mission_router_members (principal)`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_deliveries (
    thread_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    room_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    wake_id TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, mission_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_router_deliveries_by_wake
    ON ardud_mission_router_deliveries (wake_id)`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_doorbells (
    thread_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    outstanding INTEGER NOT NULL,
    wake_id TEXT,
    rung_seq INTEGER,
    rung_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_wakes (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    up_to_seq INTEGER NOT NULL,
    rung_at TEXT NOT NULL,
    settled_at TEXT,
    acted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_recipients (
    mission_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    room_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL,
    acked_at TEXT,
    PRIMARY KEY (mission_id, seq, recipient)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_router_recipients_by_actor
    ON ardud_mission_router_recipients (mission_id, recipient, seq)`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_tuning (
    room_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    muted INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_reminders (
    thread_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    reminded_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, mission_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_router_reminders_by_mission
    ON ardud_mission_router_reminders (mission_id, seq)`,
  // How far each feed (the master inbox) has read a mission's event log.
  `CREATE TABLE IF NOT EXISTS ardud_mission_router_feed_cursors (
    component TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (component, mission_id)
  )`,
];

/** The feed-cursor row that marks a feed as having run once. */
const FEED_STARTED = "";

const encodeRoom = Schema.encodeSync(Schema.fromJsonString(Room));
const decodeRoom = Schema.decodeUnknownSync(Schema.fromJsonString(Room));
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(MissionMessage));
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(MissionMessage));
const encodeSubscription = Schema.encodeSync(Schema.fromJsonString(Subscription));
const decodeSubscription = Schema.decodeUnknownSync(Schema.fromJsonString(Subscription));
const encodeReadPosition = Schema.encodeSync(Schema.fromJsonString(ReadPosition));
const decodeReadPosition = Schema.decodeUnknownSync(Schema.fromJsonString(ReadPosition));

export interface DeliveryRow {
  readonly threadId: ThreadId;
  readonly missionId: MissionId;
  readonly seq: number;
  readonly roomId: RoomId;
  readonly messageId: MissionMessageId;
  readonly wakeId: string | null;
}

export interface DoorbellRow {
  readonly threadId: ThreadId;
  readonly missionId: MissionId;
  readonly outstanding: boolean;
  readonly wakeId: string | null;
  readonly rungSeq: number | null;
  readonly rungAt: string | null;
}

export interface MemberRow {
  readonly missionId: MissionId;
  readonly principal: string;
  readonly kind: MemberKind;
  readonly label: string | null;
}

export interface StoredMessage {
  readonly message: MissionMessage;
  readonly contentHash: string;
}

export interface TuningRow {
  readonly roomId: RoomId;
  readonly missionId: MissionId;
  readonly muted: boolean;
  readonly updatedAt: string;
}

/** A delivery reminded once and still unread. */
export interface AttentionRow {
  readonly threadId: ThreadId;
  readonly message: MissionMessage;
  readonly remindedAt: string;
}

/** One coord-ledger row: who a message was for and whether it should wake them. */
export interface RecipientRow {
  readonly key: string;
  readonly status: "pending" | "skipped";
  readonly ackedAt: string | null;
}

/** A message as the coord inbox sees it for one actor. */
export interface RecipientEntry {
  readonly message: MissionMessage;
  readonly body: string | null;
  readonly delivery: "pending" | "skipped" | "acked";
  readonly ackedAt: string | null;
}

/** What a create-if-missing batch (the coord import) writes. */
export interface RouterBatch {
  readonly rooms: ReadonlyArray<Room>;
  readonly messages: ReadonlyArray<{
    readonly message: MissionMessage;
    readonly body: string | null;
    readonly contentHash: string;
    readonly recipients?: ReadonlyArray<RecipientRow>;
  }>;
  readonly subscriptions: ReadonlyArray<{
    readonly subscription: Subscription;
    readonly key: string;
  }>;
  readonly readPositions: ReadonlyArray<{ readonly position: ReadPosition; readonly key: string }>;
}

export type RouterRowKind = "room" | "message" | "subscription" | "read-position";

export class RouterStore extends Context.Service<
  RouterStore,
  {
    /** Inserts or replaces a room. Runs inside a core commit. */
    readonly putRoom: (room: Room) => Effect.Effect<void>;
    readonly room: (id: RoomId) => Effect.Effect<Room | null>;
    readonly rooms: (missionId: MissionId) => Effect.Effect<ReadonlyArray<Room>>;
    /**
     * Which ids already exist. Read positions use `<roomId>|<readerKey>`.
     */
    readonly existingIds: (
      kind: RouterRowKind,
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlySet<string>>;
    /** Create-if-missing; existing rows are left as they are. Runs inside a core commit. */
    readonly insertMissing: (batch: RouterBatch) => Effect.Effect<void>;
    readonly lastMessageSeq: (missionId: MissionId) => Effect.Effect<number>;
    /** Runs inside a core commit; the row, its body and its deliveries land together. */
    readonly insertMessage: (input: {
      readonly message: MissionMessage;
      readonly body: string | null;
      readonly contentHash: string;
      readonly deliveries: ReadonlyArray<ThreadId>;
      readonly recipients?: ReadonlyArray<RecipientRow>;
    }) => Effect.Effect<void>;
    readonly messageBySeq: (
      missionId: MissionId,
      seq: number,
    ) => Effect.Effect<MissionMessage | null>;
    /**
     * Coord inbox: messages with a ledger row for any of `keys`, oldest first.
     * Never an owner request's: those words stay out of coord.
     */
    readonly recipientInbox: (input: {
      readonly missionId: MissionId;
      readonly keys: ReadonlyArray<string>;
      readonly after: number;
      readonly unackedOnly: boolean;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<RecipientEntry>>;
    /** Ledger rows of one message for any of `keys`. */
    readonly recipientsOf: (
      missionId: MissionId,
      seq: number,
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<RecipientRow>>;
    readonly ackRecipients: (input: {
      readonly missionId: MissionId;
      readonly keys: ReadonlyArray<string>;
      readonly at: string;
      /** One message, or everything in `roomId` up to `upToSeq`. */
      readonly scope:
        | { readonly _tag: "seq"; readonly seq: number }
        | { readonly _tag: "room"; readonly roomId: RoomId; readonly upToSeq: number };
    }) => Effect.Effect<void>;
    /** Lowest unacked ledger seq in a room for any of `keys`, or null. */
    readonly firstUnacked: (
      missionId: MissionId,
      roomId: RoomId,
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<number | null>;
    /** Marks one message's delivery to a thread read. */
    readonly readDelivery: (
      threadId: ThreadId,
      missionId: MissionId,
      seq: number,
    ) => Effect.Effect<void>;
    readonly messageByKey: (
      missionId: MissionId,
      key: string,
    ) => Effect.Effect<StoredMessage | null>;
    /** Missions holding a message with this key (an iMessage id posts once anywhere). */
    readonly keyMissions: (key: string) => Effect.Effect<ReadonlyArray<MissionId>>;
    readonly messageById: (id: MissionMessageId) => Effect.Effect<MissionMessage | null>;
    readonly messageBody: (id: MissionMessageId) => Effect.Effect<string | null>;
    /** Newest `limit` messages of a room below `beforeSeq`, returned oldest first. */
    readonly roomMessages: (
      roomId: RoomId,
      beforeSeq: number | null,
      limit: number,
    ) => Effect.Effect<{
      readonly messages: ReadonlyArray<MissionMessage>;
      readonly hasOlder: boolean;
    }>;
    /** A room's first message and how many it holds (owner requests' transcripts). */
    readonly roomOpening: (roomId: RoomId) => Effect.Effect<{
      readonly first: MissionMessage | null;
      readonly total: number;
    }>;
    /**
     * Per room of a mission: every message, and those after the owner's read
     * mark that the owner did not write. Rooms with no messages are absent.
     */
    readonly roomCounts: (
      missionId: MissionId,
    ) => Effect.Effect<
      ReadonlyMap<string, { readonly total: number; readonly unreadForOwner: number }>
    >;
    readonly roomKindsSince: (
      roomId: RoomId,
      sinceIso: string,
    ) => Effect.Effect<ReadonlyArray<MissionMessageKind>>;
    readonly upsertSubscription: (subscription: Subscription, key: string) => Effect.Effect<void>;
    readonly subscriptions: (roomId: RoomId) => Effect.Effect<ReadonlyArray<Subscription>>;
    /** Read positions only move forward. Returns the stored position. */
    readonly advanceRead: (position: ReadPosition, key: string) => Effect.Effect<ReadPosition>;
    readonly readPositions: (roomId: RoomId) => Effect.Effect<ReadonlyArray<ReadPosition>>;
    readonly putMember: (row: MemberRow, at: string) => Effect.Effect<void>;
    readonly removeMember: (missionId: MissionId, principal: string) => Effect.Effect<boolean>;
    readonly membersByPrincipal: (principal: string) => Effect.Effect<ReadonlyArray<MemberRow>>;
    readonly unreadDeliveries: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<DeliveryRow>>;
    readonly coverDeliveries: (threadId: ThreadId, wakeId: string) => Effect.Effect<void>;
    readonly readDeliveries: (
      threadId: ThreadId,
      roomId: RoomId,
      upToSeq: number,
    ) => Effect.Effect<void>;
    readonly doorbell: (threadId: ThreadId) => Effect.Effect<DoorbellRow | null>;
    readonly ring: (input: {
      readonly threadId: ThreadId;
      readonly missionId: MissionId;
      readonly wakeId: string;
      readonly upToSeq: number;
      readonly at: string;
    }) => Effect.Effect<void>;
    /** Clears an outstanding doorbell and settles its wake. True when one was outstanding. */
    readonly settle: (threadId: ThreadId, at: string) => Effect.Effect<boolean>;
    readonly markActed: (threadId: ThreadId) => Effect.Effect<void>;
    readonly wastedWakesSince: (roomId: RoomId, sinceIso: string) => Effect.Effect<number>;
    readonly tuning: (roomId: RoomId) => Effect.Effect<TuningRow | null>;
    /** Runs inside a core commit (the `room.tuned` event). */
    readonly putTuning: (row: TuningRow) => Effect.Effect<void>;
    /** Unread deliveries never reminded whose message was posted at or before `cutoffIso`. */
    readonly staleDeliveries: (cutoffIso: string) => Effect.Effect<ReadonlyArray<DeliveryRow>>;
    readonly lastReminderAt: (threadId: ThreadId) => Effect.Effect<string | null>;
    readonly markReminded: (rows: ReadonlyArray<DeliveryRow>, at: string) => Effect.Effect<void>;
    /** Reminded deliveries of a mission that are still unread, oldest first. */
    readonly attention: (
      missionId: MissionId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<AttentionRow>>;
    /** Whether a feed finished its first run (after which it replays what it missed). */
    readonly feedStarted: (component: string) => Effect.Effect<boolean>;
    /** Marks a feed's first run done, once every mission has its cursor. */
    readonly markFeedStarted: (component: string, at: string) => Effect.Effect<void>;
    /** Every mission cursor a feed holds. */
    readonly feedCursors: (component: string) => Effect.Effect<ReadonlyMap<MissionId, number>>;
    /** Cursors only move forward. */
    readonly advanceFeedCursor: (input: {
      readonly component: string;
      readonly missionId: MissionId;
      readonly seq: number;
      readonly at: string;
    }) => Effect.Effect<void>;
  }
>()("t3/ardud/missions/router/RouterStore") {}

interface MessageRow {
  readonly json: string;
  readonly contentHash: string;
}

interface DeliveryDbRow {
  readonly threadId: string;
  readonly missionId: string;
  readonly seq: number;
  readonly roomId: string;
  readonly messageId: string;
  readonly wakeId: string | null;
}

interface DoorbellDbRow {
  readonly threadId: string;
  readonly missionId: string;
  readonly outstanding: number;
  readonly wakeId: string | null;
  readonly rungSeq: number | null;
  readonly rungAt: string | null;
}

interface MemberDbRow {
  readonly missionId: string;
  readonly principal: string;
  readonly kind: string;
  readonly label: string | null;
}

interface InboxDbRow {
  readonly json: string;
  readonly body: string | null;
  readonly open: number;
  readonly status: string | null;
  readonly ackedAt: string | null;
}

const toStatus = (status: string | null): "pending" | "skipped" =>
  status === "pending" ? "pending" : "skipped";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(DDL, (statement) => sql.unsafe(statement), { discard: true }).pipe(
    Effect.orDie,
  );

  // Router SQL faults are defects, like the core store's.
  const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(NodeSqliteClient.readOnly, Effect.orDie);
  const write = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.orDie);

  const toDelivery = (row: DeliveryDbRow): DeliveryRow => ({
    threadId: row.threadId as ThreadId,
    missionId: row.missionId as MissionId,
    seq: Number(row.seq),
    roomId: row.roomId as RoomId,
    messageId: row.messageId as MissionMessageId,
    wakeId: row.wakeId,
  });

  const toMember = (row: MemberDbRow): MemberRow => ({
    missionId: row.missionId as MissionId,
    principal: row.principal,
    kind: row.kind as MemberKind,
    label: row.label,
  });

  const roomRow = (room: Room) => ({
    id: room.id,
    mission_id: room.missionId,
    kind: room.kind,
    created_at: room.createdAt,
    room_json: encodeRoom(room),
  });

  const messageRows = (input: {
    readonly message: MissionMessage;
    readonly contentHash: string;
  }) => ({
    mission_id: input.message.missionId,
    seq: input.message.seq,
    id: input.message.id,
    room_id: input.message.roomId,
    kind: input.message.kind,
    msg_key: input.message.key,
    content_hash: input.contentHash,
    created_at: input.message.createdAt,
    message_json: encodeMessage(input.message),
  });

  const insertRecipients = (
    message: MissionMessage,
    recipients: ReadonlyArray<RecipientRow> | undefined,
  ) =>
    Effect.forEach(
      recipients ?? [],
      (row) => sql`
        INSERT INTO ardud_mission_router_recipients ${sql.insert({
          mission_id: message.missionId,
          seq: message.seq,
          room_id: message.roomId,
          recipient: row.key,
          status: row.status,
          acked_at: row.ackedAt,
        })}
        ON CONFLICT DO NOTHING
      `,
      { discard: true },
    );

  const existingIn = (
    kind: RouterRowKind,
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<{ readonly id: string }>, SqlError> => {
    switch (kind) {
      case "room":
        return sql<{ readonly id: string }>`
          SELECT id AS "id" FROM ardud_mission_router_rooms WHERE ${sql.in("id", ids)}
        `;
      case "message":
        return sql<{ readonly id: string }>`
          SELECT id AS "id" FROM ardud_mission_router_messages WHERE ${sql.in("id", ids)}
        `;
      case "subscription":
        return sql<{ readonly id: string }>`
          SELECT id AS "id" FROM ardud_mission_router_subscriptions WHERE ${sql.in("id", ids)}
        `;
      case "read-position": {
        const roomIds = [...new Set(ids.map((id) => id.slice(0, id.indexOf("|"))))];
        const wanted = new Set(ids);
        return sql<{ readonly id: string }>`
          SELECT room_id || '|' || reader_key AS "id" FROM ardud_mission_router_reads
          WHERE ${sql.in("room_id", roomIds)}
        `.pipe(Effect.map((rows) => rows.filter((row) => wanted.has(row.id))));
      }
    }
  };

  return RouterStore.of({
    putRoom: (room) =>
      write(sql`
        INSERT INTO ardud_mission_router_rooms ${sql.insert(roomRow(room))}
        ON CONFLICT (id) DO UPDATE SET
          kind = excluded.kind,
          room_json = excluded.room_json
      `),

    room: (id) =>
      read(
        sql<{ readonly json: string }>`
          SELECT room_json AS "json" FROM ardud_mission_router_rooms WHERE id = ${id}
        `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : decodeRoom(rows[0].json)))),
      ),

    rooms: (missionId) =>
      read(
        sql<{ readonly json: string }>`
          SELECT room_json AS "json" FROM ardud_mission_router_rooms
          WHERE mission_id = ${missionId} ORDER BY created_at, id
        `.pipe(Effect.map((rows) => rows.map((row) => decodeRoom(row.json)))),
      ),

    existingIds: (kind, ids) =>
      ids.length === 0
        ? Effect.succeed(new Set<string>())
        : read(existingIn(kind, ids).pipe(Effect.map((rows) => new Set(rows.map((r) => r.id))))),

    insertMissing: (batch) =>
      write(
        Effect.gen(function* () {
          for (const room of batch.rooms) {
            yield* sql`
              INSERT INTO ardud_mission_router_rooms ${sql.insert(roomRow(room))}
              ON CONFLICT DO NOTHING
            `;
          }
          for (const entry of batch.messages) {
            const inserted = yield* sql<{ readonly id: string }>`
              INSERT INTO ardud_mission_router_messages ${sql.insert(messageRows(entry))}
              ON CONFLICT DO NOTHING
              RETURNING id AS "id"
            `;
            if (inserted.length > 0 && entry.body !== null) {
              yield* sql`
                INSERT INTO ardud_mission_router_bodies ${sql.insert({
                  message_id: entry.message.id,
                  body: entry.body,
                })}
                ON CONFLICT DO NOTHING
              `;
            }
            if (inserted.length > 0) yield* insertRecipients(entry.message, entry.recipients);
          }
          for (const { subscription, key } of batch.subscriptions) {
            yield* sql`
              INSERT INTO ardud_mission_router_subscriptions ${sql.insert({
                id: subscription.id,
                room_id: subscription.roomId,
                subscriber_key: key,
                subscription_json: encodeSubscription(subscription),
              })}
              ON CONFLICT DO NOTHING
            `;
          }
          for (const { position, key } of batch.readPositions) {
            yield* sql`
              INSERT INTO ardud_mission_router_reads ${sql.insert({
                room_id: position.roomId,
                reader_key: key,
                seq: position.seq,
                position_json: encodeReadPosition(position),
              })}
              ON CONFLICT DO NOTHING
            `;
          }
        }),
      ),

    lastMessageSeq: (missionId) =>
      read(
        sql<{ readonly seq: number | null }>`
          SELECT MAX(seq) AS "seq" FROM ardud_mission_router_messages WHERE mission_id = ${missionId}
        `.pipe(Effect.map((rows) => Number(rows[0]?.seq ?? 0))),
      ),

    insertMessage: ({ message, body, contentHash, deliveries, recipients }) =>
      write(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO ardud_mission_router_messages ${sql.insert(
              messageRows({ message, contentHash }),
            )}
          `;
          if (body !== null) {
            yield* sql`
              INSERT INTO ardud_mission_router_bodies ${sql.insert({
                message_id: message.id,
                body,
              })}
            `;
          }
          for (const threadId of deliveries) {
            yield* sql`
              INSERT INTO ardud_mission_router_deliveries ${sql.insert({
                thread_id: threadId,
                mission_id: message.missionId,
                seq: message.seq,
                room_id: message.roomId,
                message_id: message.id,
                wake_id: null,
                read: 0,
              })}
              ON CONFLICT (thread_id, mission_id, seq) DO NOTHING
            `;
          }
          yield* insertRecipients(message, recipients);
        }),
      ),

    messageBySeq: (missionId, seq) =>
      read(
        sql<{ readonly json: string }>`
          SELECT message_json AS "json" FROM ardud_mission_router_messages
          WHERE mission_id = ${missionId} AND seq = ${seq}
        `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : decodeMessage(rows[0].json)))),
      ),

    recipientInbox: ({ missionId, keys, after, unackedOnly, limit }) =>
      keys.length === 0
        ? Effect.succeed([])
        : read(
            sql<InboxDbRow>`
              SELECT m.message_json AS "json", b.body AS "body",
                SUM(CASE WHEN r.acked_at IS NULL THEN 1 ELSE 0 END) AS "open",
                MIN(CASE WHEN r.acked_at IS NULL THEN r.status END) AS "status",
                MAX(r.acked_at) AS "ackedAt"
              FROM ardud_mission_router_recipients r
              JOIN ardud_mission_router_messages m
                ON m.mission_id = r.mission_id AND m.seq = r.seq
              LEFT JOIN ardud_mission_router_bodies b ON b.message_id = m.id
              LEFT JOIN ardud_mission_router_rooms room ON room.id = r.room_id
              WHERE r.mission_id = ${missionId} AND r.seq > ${after}
                AND ${sql.in("r.recipient", keys)}
                AND (room.kind IS NULL OR room.kind <> 'owner-request')
              GROUP BY r.seq
              ${unackedOnly ? sql`HAVING SUM(CASE WHEN r.acked_at IS NULL THEN 1 ELSE 0 END) > 0` : sql``}
              ORDER BY r.seq
              LIMIT ${limit}
            `.pipe(
              Effect.map((rows) =>
                rows.map((row): RecipientEntry => ({
                  message: decodeMessage(row.json),
                  body: row.body,
                  delivery: Number(row.open) > 0 ? toStatus(row.status) : "acked",
                  ackedAt: Number(row.open) > 0 ? null : row.ackedAt,
                })),
              ),
            ),
          ),

    recipientsOf: (missionId, seq, keys) =>
      keys.length === 0
        ? Effect.succeed([])
        : read(
            sql<{
              readonly key: string;
              readonly status: string;
              readonly ackedAt: string | null;
            }>`
              SELECT recipient AS "key", status AS "status", acked_at AS "ackedAt"
              FROM ardud_mission_router_recipients
              WHERE mission_id = ${missionId} AND seq = ${seq} AND ${sql.in("recipient", keys)}
              ORDER BY recipient
            `.pipe(
              Effect.map((rows) =>
                rows.map((row) => ({
                  key: row.key,
                  status: toStatus(row.status),
                  ackedAt: row.ackedAt,
                })),
              ),
            ),
          ),

    ackRecipients: ({ missionId, keys, at, scope }) =>
      keys.length === 0
        ? Effect.void
        : write(sql`
            UPDATE ardud_mission_router_recipients SET acked_at = ${at}
            WHERE mission_id = ${missionId} AND acked_at IS NULL
              AND ${sql.in("recipient", keys)}
              AND ${
                scope._tag === "seq"
                  ? sql`seq = ${scope.seq}`
                  : sql`room_id = ${scope.roomId} AND seq <= ${scope.upToSeq}`
              }
          `),

    firstUnacked: (missionId, roomId, keys) =>
      keys.length === 0
        ? Effect.succeed(null)
        : read(
            sql<{ readonly seq: number | null }>`
              SELECT MIN(seq) AS "seq" FROM ardud_mission_router_recipients
              WHERE mission_id = ${missionId} AND room_id = ${roomId} AND acked_at IS NULL
                AND ${sql.in("recipient", keys)}
            `.pipe(Effect.map((rows) => (rows[0]?.seq == null ? null : Number(rows[0].seq)))),
          ),

    readDelivery: (threadId, missionId, seq) =>
      write(sql`
        UPDATE ardud_mission_router_deliveries SET read = 1
        WHERE thread_id = ${threadId} AND mission_id = ${missionId} AND seq = ${seq}
      `),

    messageByKey: (missionId, key) =>
      read(
        sql<MessageRow>`
          SELECT message_json AS "json", content_hash AS "contentHash"
          FROM ardud_mission_router_messages
          WHERE mission_id = ${missionId} AND msg_key = ${key}
        `.pipe(
          Effect.map((rows) => {
            const row = rows[0];
            return row === undefined
              ? null
              : { message: decodeMessage(row.json), contentHash: row.contentHash };
          }),
        ),
      ),

    keyMissions: (key) =>
      read(
        sql<{ readonly missionId: string }>`
          SELECT DISTINCT mission_id AS "missionId"
          FROM ardud_mission_router_messages
          WHERE msg_key = ${key}
        `.pipe(Effect.map((rows) => rows.map((row) => MissionId.make(row.missionId)))),
      ),

    messageById: (id) =>
      read(
        sql<{ readonly json: string }>`
          SELECT message_json AS "json" FROM ardud_mission_router_messages WHERE id = ${id}
        `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : decodeMessage(rows[0].json)))),
      ),

    messageBody: (id) =>
      read(
        sql<{ readonly body: string }>`
          SELECT body AS "body" FROM ardud_mission_router_bodies WHERE message_id = ${id}
        `.pipe(Effect.map((rows) => rows[0]?.body ?? null)),
      ),

    roomMessages: (roomId, beforeSeq, limit) =>
      read(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly json: string }>`
            SELECT message_json AS "json" FROM ardud_mission_router_messages
            WHERE room_id = ${roomId}
              ${beforeSeq === null ? sql`` : sql`AND seq < ${beforeSeq}`}
            ORDER BY seq DESC
            LIMIT ${limit + 1}
          `;
          const hasOlder = rows.length > limit;
          const messages = rows
            .slice(0, limit)
            .map((row) => decodeMessage(row.json))
            .toReversed();
          return { messages, hasOlder };
        }),
      ),

    roomOpening: (roomId) =>
      read(
        Effect.gen(function* () {
          const first = yield* sql<{ readonly json: string }>`
            SELECT message_json AS "json" FROM ardud_mission_router_messages
            WHERE room_id = ${roomId}
            ORDER BY seq ASC
            LIMIT 1
          `;
          const counted = yield* sql<{ readonly total: number }>`
            SELECT COUNT(*) AS "total" FROM ardud_mission_router_messages WHERE room_id = ${roomId}
          `;
          return {
            first: first[0] === undefined ? null : decodeMessage(first[0].json),
            total: Number(counted[0]?.total ?? 0),
          };
        }),
      ),

    roomCounts: (missionId) =>
      read(
        sql<{ readonly roomId: string; readonly total: number; readonly unread: number }>`
          SELECT m.room_id AS "roomId",
            COUNT(*) AS "total",
            SUM(CASE WHEN m.seq > COALESCE(r.seq, 0)
              AND json_extract(m.message_json, '$.author._tag') != 'owner' THEN 1 ELSE 0 END) AS "unread"
          FROM ardud_mission_router_messages m
          LEFT JOIN ardud_mission_router_reads r
            ON r.room_id = m.room_id AND r.reader_key = ${actorKey({ _tag: "owner" })}
          WHERE m.mission_id = ${missionId}
          GROUP BY m.room_id
        `.pipe(
          Effect.map(
            (rows) =>
              new Map(
                rows.map((row) => [
                  row.roomId,
                  { total: Number(row.total), unreadForOwner: Number(row.unread ?? 0) },
                ]),
              ),
          ),
        ),
      ),

    roomKindsSince: (roomId, sinceIso) =>
      read(
        sql<{ readonly kind: MissionMessageKind }>`
          SELECT kind AS "kind" FROM ardud_mission_router_messages
          WHERE room_id = ${roomId} AND created_at >= ${sinceIso}
        `.pipe(Effect.map((rows) => rows.map((row) => row.kind))),
      ),

    upsertSubscription: (subscription, key) =>
      write(sql`
        INSERT INTO ardud_mission_router_subscriptions ${sql.insert({
          id: subscription.id,
          room_id: subscription.roomId,
          subscriber_key: key,
          subscription_json: encodeSubscription(subscription),
        })}
        ON CONFLICT (room_id, subscriber_key) DO UPDATE SET
          subscription_json = excluded.subscription_json
      `),

    subscriptions: (roomId) =>
      read(
        sql<{ readonly json: string }>`
          SELECT subscription_json AS "json" FROM ardud_mission_router_subscriptions
          WHERE room_id = ${roomId} ORDER BY subscriber_key
        `.pipe(Effect.map((rows) => rows.map((row) => decodeSubscription(row.json)))),
      ),

    advanceRead: (position, key) =>
      write(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO ardud_mission_router_reads ${sql.insert({
              room_id: position.roomId,
              reader_key: key,
              seq: position.seq,
              position_json: encodeReadPosition(position),
            })}
            ON CONFLICT (room_id, reader_key) DO UPDATE SET
              seq = excluded.seq,
              position_json = excluded.position_json
            WHERE excluded.seq > ardud_mission_router_reads.seq
          `;
          const rows = yield* sql<{ readonly json: string }>`
            SELECT position_json AS "json" FROM ardud_mission_router_reads
            WHERE room_id = ${position.roomId} AND reader_key = ${key}
          `;
          return rows[0] === undefined ? position : decodeReadPosition(rows[0].json);
        }),
      ),

    readPositions: (roomId) =>
      read(
        sql<{ readonly json: string }>`
          SELECT position_json AS "json" FROM ardud_mission_router_reads WHERE room_id = ${roomId}
        `.pipe(Effect.map((rows) => rows.map((row) => decodeReadPosition(row.json)))),
      ),

    putMember: (row, at) =>
      write(sql`
        INSERT INTO ardud_mission_router_members ${sql.insert({
          mission_id: row.missionId,
          principal: row.principal,
          kind: row.kind,
          label: row.label,
          added_at: at,
        })}
        ON CONFLICT (mission_id, principal) DO UPDATE SET
          kind = excluded.kind,
          label = excluded.label
      `),

    removeMember: (missionId, principal) =>
      write(
        sql<{ readonly principal: string }>`
          DELETE FROM ardud_mission_router_members
          WHERE mission_id = ${missionId} AND principal = ${principal}
          RETURNING principal AS "principal"
        `.pipe(Effect.map((rows) => rows.length > 0)),
      ),

    membersByPrincipal: (principal) =>
      read(
        sql<MemberDbRow>`
          SELECT mission_id AS "missionId", principal AS "principal", kind AS "kind", label AS "label"
          FROM ardud_mission_router_members WHERE principal = ${principal}
          ORDER BY added_at
        `.pipe(Effect.map((rows) => rows.map(toMember))),
      ),

    unreadDeliveries: (threadId) =>
      read(
        sql<DeliveryDbRow>`
          SELECT thread_id AS "threadId", mission_id AS "missionId", seq AS "seq",
            room_id AS "roomId", message_id AS "messageId", wake_id AS "wakeId"
          FROM ardud_mission_router_deliveries
          WHERE thread_id = ${threadId} AND read = 0
          ORDER BY mission_id, seq
        `.pipe(Effect.map((rows) => rows.map(toDelivery))),
      ),

    coverDeliveries: (threadId, wakeId) =>
      write(sql`
        UPDATE ardud_mission_router_deliveries SET wake_id = ${wakeId}
        WHERE thread_id = ${threadId} AND read = 0 AND wake_id IS NULL
      `),

    readDeliveries: (threadId, roomId, upToSeq) =>
      write(sql`
        UPDATE ardud_mission_router_deliveries SET read = 1
        WHERE thread_id = ${threadId} AND room_id = ${roomId} AND seq <= ${upToSeq}
      `),

    doorbell: (threadId) =>
      read(
        sql<DoorbellDbRow>`
          SELECT thread_id AS "threadId", mission_id AS "missionId", outstanding AS "outstanding",
            wake_id AS "wakeId", rung_seq AS "rungSeq", rung_at AS "rungAt"
          FROM ardud_mission_router_doorbells WHERE thread_id = ${threadId}
        `.pipe(
          Effect.map((rows) => {
            const row = rows[0];
            return row === undefined
              ? null
              : {
                  threadId: row.threadId as ThreadId,
                  missionId: row.missionId as MissionId,
                  outstanding: Number(row.outstanding) === 1,
                  wakeId: row.wakeId,
                  rungSeq: row.rungSeq === null ? null : Number(row.rungSeq),
                  rungAt: row.rungAt,
                };
          }),
        ),
      ),

    ring: ({ threadId, missionId, wakeId, upToSeq, at }) =>
      write(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO ardud_mission_router_doorbells ${sql.insert({
              thread_id: threadId,
              mission_id: missionId,
              outstanding: 1,
              wake_id: wakeId,
              rung_seq: upToSeq,
              rung_at: at,
            })}
            ON CONFLICT (thread_id) DO UPDATE SET
              mission_id = excluded.mission_id,
              outstanding = 1,
              wake_id = excluded.wake_id,
              rung_seq = excluded.rung_seq,
              rung_at = excluded.rung_at
          `;
          yield* sql`
            INSERT INTO ardud_mission_router_wakes ${sql.insert({
              id: wakeId,
              thread_id: threadId,
              mission_id: missionId,
              up_to_seq: upToSeq,
              rung_at: at,
              settled_at: null,
              acted: 0,
            })}
            ON CONFLICT (id) DO NOTHING
          `;
          yield* sql`
            UPDATE ardud_mission_router_deliveries SET wake_id = ${wakeId}
            WHERE thread_id = ${threadId} AND read = 0 AND wake_id IS NULL
          `;
        }).pipe(sql.withTransaction),
      ),

    settle: (threadId, at) =>
      write(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly wakeId: string | null }>`
            UPDATE ardud_mission_router_doorbells SET outstanding = 0
            WHERE thread_id = ${threadId} AND outstanding = 1
            RETURNING wake_id AS "wakeId"
          `;
          const wakeId = rows[0]?.wakeId ?? null;
          if (wakeId !== null) {
            yield* sql`
              UPDATE ardud_mission_router_wakes SET settled_at = ${at}
              WHERE id = ${wakeId} AND settled_at IS NULL
            `;
          }
          return rows.length > 0;
        }).pipe(sql.withTransaction),
      ),

    markActed: (threadId) =>
      write(sql`
        UPDATE ardud_mission_router_wakes SET acted = 1
        WHERE thread_id = ${threadId} AND acted = 0 AND settled_at IS NULL
      `),

    wastedWakesSince: (roomId, sinceIso) =>
      read(
        sql<{ readonly count: number }>`
          SELECT COUNT(DISTINCT w.id) AS "count"
          FROM ardud_mission_router_wakes w
          JOIN ardud_mission_router_deliveries d ON d.wake_id = w.id
          WHERE d.room_id = ${roomId}
            AND w.settled_at IS NOT NULL
            AND w.acted = 0
            AND w.rung_at >= ${sinceIso}
        `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0))),
      ),

    tuning: (roomId) =>
      read(
        sql<{
          readonly roomId: string;
          readonly missionId: string;
          readonly muted: number;
          readonly updatedAt: string;
        }>`
          SELECT room_id AS "roomId", mission_id AS "missionId", muted AS "muted",
            updated_at AS "updatedAt"
          FROM ardud_mission_router_tuning WHERE room_id = ${roomId}
        `.pipe(
          Effect.map((rows) => {
            const row = rows[0];
            return row === undefined
              ? null
              : {
                  roomId: row.roomId as RoomId,
                  missionId: row.missionId as MissionId,
                  muted: Number(row.muted) === 1,
                  updatedAt: row.updatedAt,
                };
          }),
        ),
      ),

    putTuning: (row) =>
      write(sql`
        INSERT INTO ardud_mission_router_tuning ${sql.insert({
          room_id: row.roomId,
          mission_id: row.missionId,
          muted: row.muted ? 1 : 0,
          updated_at: row.updatedAt,
        })}
        ON CONFLICT (room_id) DO UPDATE SET
          muted = excluded.muted,
          updated_at = excluded.updated_at
      `),

    staleDeliveries: (cutoffIso) =>
      read(
        sql<DeliveryDbRow>`
          SELECT d.thread_id AS "threadId", d.mission_id AS "missionId", d.seq AS "seq",
            d.room_id AS "roomId", d.message_id AS "messageId", d.wake_id AS "wakeId"
          FROM ardud_mission_router_deliveries d
          JOIN ardud_mission_router_messages m
            ON m.mission_id = d.mission_id AND m.seq = d.seq
          LEFT JOIN ardud_mission_router_reminders r
            ON r.thread_id = d.thread_id AND r.mission_id = d.mission_id AND r.seq = d.seq
          WHERE d.read = 0 AND r.thread_id IS NULL AND m.created_at <= ${cutoffIso}
          ORDER BY d.thread_id, d.mission_id, d.seq
        `.pipe(Effect.map((rows) => rows.map(toDelivery))),
      ),

    lastReminderAt: (threadId) =>
      read(
        sql<{ readonly at: string | null }>`
          SELECT MAX(reminded_at) AS "at"
          FROM ardud_mission_router_reminders WHERE thread_id = ${threadId}
        `.pipe(Effect.map((rows) => rows[0]?.at ?? null)),
      ),

    markReminded: (rows, at) =>
      write(
        Effect.forEach(
          rows,
          (row) => sql`
            INSERT INTO ardud_mission_router_reminders ${sql.insert({
              thread_id: row.threadId,
              mission_id: row.missionId,
              seq: row.seq,
              reminded_at: at,
            })}
            ON CONFLICT (thread_id, mission_id, seq) DO NOTHING
          `,
          { discard: true },
        ).pipe(sql.withTransaction),
      ),

    attention: (missionId, limit) =>
      read(
        sql<{ readonly threadId: string; readonly json: string; readonly remindedAt: string }>`
          SELECT r.thread_id AS "threadId", m.message_json AS "json",
            r.reminded_at AS "remindedAt"
          FROM ardud_mission_router_reminders r
          JOIN ardud_mission_router_deliveries d
            ON d.thread_id = r.thread_id AND d.mission_id = r.mission_id AND d.seq = r.seq
          JOIN ardud_mission_router_messages m
            ON m.mission_id = r.mission_id AND m.seq = r.seq
          WHERE r.mission_id = ${missionId} AND d.read = 0
          ORDER BY r.seq, r.thread_id
          LIMIT ${limit}
        `.pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              threadId: row.threadId as ThreadId,
              message: decodeMessage(row.json),
              remindedAt: row.remindedAt,
            })),
          ),
        ),
      ),

    feedStarted: (component) =>
      read(
        sql<{ readonly component: string }>`
          SELECT component AS "component" FROM ardud_mission_router_feed_cursors
          WHERE component = ${component} AND mission_id = ${FEED_STARTED}
        `.pipe(Effect.map((rows) => rows.length > 0)),
      ),

    markFeedStarted: (component, at) =>
      write(sql`
        INSERT INTO ardud_mission_router_feed_cursors ${sql.insert({
          component,
          mission_id: FEED_STARTED,
          seq: 0,
          updated_at: at,
        })}
        ON CONFLICT (component, mission_id) DO NOTHING
      `),

    feedCursors: (component) =>
      read(
        sql<{ readonly missionId: string; readonly seq: number }>`
          SELECT mission_id AS "missionId", seq AS "seq"
          FROM ardud_mission_router_feed_cursors
          WHERE component = ${component} AND mission_id <> ${FEED_STARTED}
        `.pipe(
          Effect.map(
            (rows) => new Map(rows.map((row) => [row.missionId as MissionId, Number(row.seq)])),
          ),
        ),
      ),

    advanceFeedCursor: ({ component, missionId, seq, at }) =>
      write(sql`
        INSERT INTO ardud_mission_router_feed_cursors ${sql.insert({
          component,
          mission_id: missionId,
          seq,
          updated_at: at,
        })}
        ON CONFLICT (component, mission_id) DO UPDATE SET
          seq = MAX(seq, excluded.seq),
          updated_at = excluded.updated_at
      `),
  });
});

export const layer = Layer.effect(RouterStore, make);
