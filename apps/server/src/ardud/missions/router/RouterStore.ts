import {
  MissionMessage,
  ReadPosition,
  Subscription,
  type MissionId,
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

import type { MemberKind } from "./model.ts";

/**
 * Router tables. Rooms and knocks are core mission records; the high-volume
 * parts (messages, bodies, subscriptions, read positions, membership and the
 * doorbell bookkeeping) live here. Message writes run inside a core commit
 * (`MissionCommit.alongside`) so the room record, the `message.posted` event
 * and the message row land in one transaction.
 *
 * - `messages`: one row per message, `seq` per mission, optional idempotency key.
 * - `deliveries`: one row per (thread, message) that should wake the thread.
 *   `wake_id` set = covered by a doorbell; `read` = the thread read past it.
 * - `doorbells`: at most one outstanding wake per thread.
 * - `wakes`: every ring, for the noise meter's wasted-wake count.
 * - `members`: explicit membership (`thread:<id>` or `session:<id>`).
 */
const DDL = [
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
];

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

export class RouterStore extends Context.Service<
  RouterStore,
  {
    readonly lastMessageSeq: (missionId: MissionId) => Effect.Effect<number>;
    /** Runs inside a core commit; the row, its body and its deliveries land together. */
    readonly insertMessage: (input: {
      readonly message: MissionMessage;
      readonly body: string | null;
      readonly contentHash: string;
      readonly deliveries: ReadonlyArray<ThreadId>;
    }) => Effect.Effect<void>;
    readonly messageByKey: (
      missionId: MissionId,
      key: string,
    ) => Effect.Effect<StoredMessage | null>;
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

  return RouterStore.of({
    lastMessageSeq: (missionId) =>
      read(
        sql<{ readonly seq: number | null }>`
          SELECT MAX(seq) AS "seq" FROM ardud_mission_router_messages WHERE mission_id = ${missionId}
        `.pipe(Effect.map((rows) => Number(rows[0]?.seq ?? 0))),
      ),

    insertMessage: ({ message, body, contentHash, deliveries }) =>
      write(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO ardud_mission_router_messages ${sql.insert({
              mission_id: message.missionId,
              seq: message.seq,
              id: message.id,
              room_id: message.roomId,
              kind: message.kind,
              msg_key: message.key,
              content_hash: contentHash,
              created_at: message.createdAt,
              message_json: encodeMessage(message),
            })}
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
        }),
      ),

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
  });
});

export const layer = Layer.effect(RouterStore, make);
