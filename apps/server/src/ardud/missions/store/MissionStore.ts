// @effect-diagnostics nodeBuiltinImport:off - event ids only need a random UUID.
import * as NodeCrypto from "node:crypto";

import {
  MissionError,
  MissionEvent,
  MissionEventId,
  MissionRecord,
  type MissionActor,
  type MissionEventKind,
  type MissionId,
  type MissionProvenance,
  type MissionRecordRef,
  type MissionStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import {
  indexRecord,
  type MissionRecordOf,
  type MissionStoreKind,
  type MissionStoreRecord,
} from "./recordIndex.ts";

/**
 * Fork tables for missions, created idempotently in the server's own sqlite at
 * layer start. Never add these to persistence/Migrations.ts (upstream owns it).
 *
 * - `ardud_mission_records`: every contract record, keyed by (kind, id), stored
 *   as the encoded tagged `MissionRecord` plus query columns.
 * - `ardud_mission_events`: the append-only timeline, one row per commit.
 * - `ardud_mission_counters`: per-mission `seq` (`mission:<id>`) and the global
 *   list `revision`, bumped in the same transaction as the writes.
 * - `ardud_mission_owner_looks`: when the owner last opened each mission. Not a
 *   timeline item, so it bypasses the event log.
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS ardud_mission_records (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    mission_id TEXT,
    sub_mission_id TEXT,
    status TEXT,
    updated_at TEXT NOT NULL,
    seq INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_records_by_mission
    ON ardud_mission_records (mission_id, kind, updated_at)`,
  // --- router additions ---
  // Complete thread lookups for membership: which records name a thread.
  `CREATE INDEX IF NOT EXISTS ardud_mission_records_by_thread
    ON ardud_mission_records (json_extract(record_json, '$.record.threadId'), kind)`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_records_by_fork_thread
    ON ardud_mission_records (json_extract(record_json, '$.record.forkThreadId'), kind)`,
  // --- end router additions ---
  `CREATE TABLE IF NOT EXISTS ardud_mission_events (
    mission_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (mission_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_counters (
    scope TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_owner_looks (
    mission_id TEXT PRIMARY KEY,
    looked_at TEXT NOT NULL
  )`,
];

const REVISION_SCOPE = "revision";
const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 5000;
const MAX_EVENTS_PAGE = 500;
const SUMMARY_MAX = 400;

const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(MissionRecord));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(MissionRecord));
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(MissionEvent));
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(MissionEvent));

/** The timeline entry a commit writes. The store assigns id, seq and time. */
export interface MissionEventDraft {
  readonly missionId: MissionId;
  readonly kind: MissionEventKind;
  readonly actor: MissionActor;
  readonly provenance: MissionProvenance;
  /** Cut to the contract's 400 characters. */
  readonly summary: string;
  readonly subject: MissionRecordRef | null;
  readonly causedBy?: MissionEventId | null;
  readonly payload?: unknown;
  /** Defaults to now. Imports pass the original time. */
  readonly at?: string;
}

/**
 * The event every commit in scope follows from, when a write runs on behalf of
 * an earlier decision (an accepted suggestion applying through the owning
 * service's own method). A draft's own `causedBy` wins.
 */
export const MissionCause = Context.Reference<MissionEventId | null>(
  "t3/ardud/missions/store/MissionCause",
  { defaultValue: () => null },
);

export interface MissionCommit {
  readonly event: MissionEventDraft;
  readonly upserts?: ReadonlyArray<MissionStoreRecord>;
  readonly removes?: ReadonlyArray<MissionRecordRef>;
  /**
   * Extra writes (a track's own `ardud_mission_<x>` tables) that must commit
   * or roll back with this commit. Never call the store from inside your own
   * sql transaction; pass those writes here instead.
   */
  readonly alongside?: Effect.Effect<void, MissionError>;
}

export interface MissionCommitResult {
  readonly seq: number;
  readonly revision: number;
  readonly event: MissionEvent;
}

export interface MissionListFilter {
  /** `null` lists records with no mission (global rules, suggestions). */
  readonly missionId?: MissionId | null;
  readonly subMissionId?: string | null;
  /** Matches the query status column (see recordIndex.ts). */
  readonly status?: ReadonlyArray<string>;
  readonly ids?: ReadonlyArray<string>;
  readonly updatedSince?: string;
  readonly order?: "newest" | "oldest";
  readonly limit?: number;
}

// --- core additions ---
/** One page of a mission's records, newest change first. */
export interface MissionPageFilter {
  readonly missionId: MissionId;
  /** Matches the query status column (see recordIndex.ts). */
  readonly status?: ReadonlyArray<string>;
  /** Records whose `laneId` is this lane. */
  readonly laneId?: string;
  readonly offset: number;
  readonly limit: number;
}

export interface MissionRecordPage<R> {
  readonly records: ReadonlyArray<R>;
  /** Every record the filter matches, not just this page. */
  readonly total: number;
}
// --- end core additions ---

const cutSummary = (summary: string): string => {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return "(no summary)";
  return trimmed.length <= SUMMARY_MAX ? trimmed : `${trimmed.slice(0, SUMMARY_MAX - 1)}…`;
};

const invalid = (detail: string) => new MissionError({ code: "invalid", detail });

export class MissionStore extends Context.Service<
  MissionStore,
  {
    /** Writes records and one event atomically under the mission's next seq, then publishes. */
    readonly commit: (commit: MissionCommit) => Effect.Effect<MissionCommitResult, MissionError>;
    readonly upsert: (
      record: MissionStoreRecord,
      event: MissionEventDraft,
    ) => Effect.Effect<MissionCommitResult, MissionError>;
    readonly appendEvent: (event: MissionEventDraft) => Effect.Effect<MissionEvent, MissionError>;
    readonly get: <K extends MissionStoreKind>(
      kind: K,
      id: string,
    ) => Effect.Effect<Option.Option<MissionRecordOf<K>>, MissionError>;
    readonly list: <K extends MissionStoreKind>(
      kind: K,
      filter?: MissionListFilter,
    ) => Effect.Effect<ReadonlyArray<MissionRecordOf<K>>, MissionError>;
    /** Events with `seq > afterSeq`, oldest first, at most 500 per page. */
    readonly eventsSince: (
      missionId: MissionId,
      afterSeq: number,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<MissionEvent>, MissionError>;
    /** Newest events first, for feeds; with `beforeSeq`, the page older than it. */
    readonly recentEvents: (
      missionId: MissionId,
      limit: number,
      beforeSeq?: number,
    ) => Effect.Effect<ReadonlyArray<MissionEvent>, MissionError>;
    readonly latestSeq: (missionId: MissionId) => Effect.Effect<number>;
    readonly revision: Effect.Effect<number>;
    readonly ownerLastLookedAt: (missionId: MissionId) => Effect.Effect<string | null>;
    readonly markOwnerLooked: (missionId: MissionId, at: string) => Effect.Effect<void>;
    /**
     * Committed changes in commit order: each commit's record upserts and
     * removes, then its `event` upsert, all with the same (missionId, seq).
     */
    readonly subscribe: Effect.Effect<PubSub.Subscription<MissionStreamItem>, never, Scope.Scope>;
    // --- router additions ---
    /**
     * Every record of a kind in one mission, uncapped. For authorization
     * reads that must see the whole cast; `list` stops at its limit.
     */
    readonly listAllInMission: <K extends MissionStoreKind>(
      kind: K,
      missionId: MissionId,
      status?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<MissionRecordOf<K>>, MissionError>;
    /** Every record of a kind across all missions, uncapped (oldest first). */
    readonly listAll: <K extends MissionStoreKind>(
      kind: K,
      status?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<MissionRecordOf<K>>, MissionError>;
    /**
     * Every mission with a role binding or lane naming the thread, or a fork
     * that is the thread, in any status. Complete: an indexed lookup with no
     * limit, so a mission missing here cannot claim the thread by its records.
     */
    readonly missionsOfThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<MissionId>>;
    // --- end router additions ---
    // --- core additions ---
    /** One page and the matching total, both counted and sliced in SQL. */
    readonly listPage: <K extends MissionStoreKind>(
      kind: K,
      filter: MissionPageFilter,
    ) => Effect.Effect<MissionRecordPage<MissionRecordOf<K>>, MissionError>;
    // --- end core additions ---
  }
>()("t3/ardud/missions/store/MissionStore") {}

interface RecordRow {
  readonly recordJson: string;
}
interface EventRow {
  readonly eventJson: string;
}
interface CounterRow {
  readonly value: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(DDL, (statement) => sql.unsafe(statement), { discard: true }).pipe(
    Effect.orDie,
  );

  const changes = yield* PubSub.unbounded<MissionStreamItem>();
  // Serializes commit + publish so subscribers see each mission's seq in order.
  const commitLock = yield* Semaphore.make(1);

  const decodeStoredRecord = (kind: string, id: string, json: string) =>
    decodeRecord(json).pipe(
      Effect.mapError(() => invalid(`Stored ${kind} ${id} does not match the mission contract.`)),
    );

  const decodeStoredEvent = (missionId: string, json: string) =>
    decodeEvent(json).pipe(
      Effect.mapError(() =>
        invalid(`A stored event of mission ${missionId} does not match the contract.`),
      ),
    );

  const bump = (scope: string) =>
    sql<CounterRow>`
      INSERT INTO ardud_mission_counters (scope, value) VALUES (${scope}, 1)
      ON CONFLICT (scope) DO UPDATE SET value = value + 1
      RETURNING value AS "value"
    `.pipe(Effect.map((rows) => rows[0]?.value ?? 0));

  const readCounter = (scope: string) =>
    sql<CounterRow>`SELECT value AS "value" FROM ardud_mission_counters WHERE scope = ${scope}`.pipe(
      Effect.map((rows) => rows[0]?.value ?? 0),
      NodeSqliteClient.readOnly,
      Effect.orDie,
    );

  const commit = (input: MissionCommit) =>
    Effect.gen(function* () {
      const draft = input.event;
      const upserts = input.upserts ?? [];
      const removes = input.removes ?? [];
      const at = draft.at ?? DateTime.formatIso(yield* DateTime.now);
      const eventId = MissionEventId.make(`event-${NodeCrypto.randomUUID()}`);
      const cause = yield* MissionCause;

      // Encode before touching sqlite so invalid input never opens a transaction.
      const encodedRecords = yield* Effect.forEach(upserts, (entry) =>
        encodeRecord(entry).pipe(
          Effect.map((json) => ({ entry, index: indexRecord(entry), json })),
          Effect.mapError(() =>
            invalid(`The ${entry._tag} record does not match the mission contract.`),
          ),
        ),
      );

      const written = yield* Effect.gen(function* () {
        const seq = yield* bump(`mission:${draft.missionId}`);
        const revision = yield* bump(REVISION_SCOPE);
        const event: MissionEvent = {
          id: eventId,
          missionId: draft.missionId,
          seq,
          kind: draft.kind,
          actor: draft.actor,
          provenance: draft.provenance,
          summary: cutSummary(draft.summary),
          subject: draft.subject,
          causedBy: draft.causedBy ?? cause,
          payload: draft.payload ?? null,
          at,
        };
        const eventJson = yield* encodeEvent(event).pipe(
          Effect.mapError(() =>
            invalid(`The ${draft.kind} event does not match the mission contract.`),
          ),
        );
        for (const { entry, index, json } of encodedRecords) {
          const missionId = index.missionId === undefined ? draft.missionId : index.missionId;
          yield* sql`
            INSERT INTO ardud_mission_records ${sql.insert({
              kind: entry._tag,
              id: index.id,
              mission_id: missionId,
              sub_mission_id: index.subMissionId,
              status: index.status,
              updated_at: index.updatedAt,
              seq,
              record_json: json,
            })}
            ON CONFLICT (kind, id) DO UPDATE SET
              mission_id = excluded.mission_id,
              sub_mission_id = excluded.sub_mission_id,
              status = excluded.status,
              updated_at = excluded.updated_at,
              seq = excluded.seq,
              record_json = excluded.record_json
          `;
        }
        for (const ref of removes) {
          yield* sql`DELETE FROM ardud_mission_records WHERE kind = ${ref.kind} AND id = ${ref.id}`;
        }
        yield* sql`
          INSERT INTO ardud_mission_events ${sql.insert({
            mission_id: draft.missionId,
            seq,
            event_id: eventId,
            kind: draft.kind,
            at,
            event_json: eventJson,
          })}
        `;
        if (input.alongside !== undefined) yield* input.alongside;
        return { seq, revision, event };
      }).pipe(
        sql.withTransaction,
        // Storage faults are defects; contract failures stay typed.
        Effect.catchTags({ SqlError: (cause) => Effect.die(cause) }),
      );

      const items: Array<MissionStreamItem> = [
        ...encodedRecords.map(({ entry }): MissionStreamItem => ({
          _tag: "upsert",
          missionId: draft.missionId,
          seq: written.seq,
          record: entry,
        })),
        ...removes.map((ref): MissionStreamItem => ({
          _tag: "remove",
          missionId: draft.missionId,
          seq: written.seq,
          ref,
        })),
        {
          _tag: "upsert",
          missionId: draft.missionId,
          seq: written.seq,
          record: { _tag: "event", record: written.event },
        },
      ];
      yield* PubSub.publishAll(changes, items);
      return written;
    }).pipe(commitLock.withPermit);

  const get = <K extends MissionStoreKind>(kind: K, id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<RecordRow>`
        SELECT record_json AS "recordJson" FROM ardud_mission_records
        WHERE kind = ${kind} AND id = ${id}
      `.pipe(NodeSqliteClient.readOnly, Effect.orDie);
      const row = rows[0];
      if (row === undefined) return Option.none<MissionRecordOf<K>>();
      const decoded = yield* decodeStoredRecord(kind, id, row.recordJson);
      if (decoded._tag !== kind) {
        return yield* invalid(`Stored ${kind} ${id} holds a ${decoded._tag} record.`);
      }
      return Option.some(decoded.record as MissionRecordOf<K>);
    });

  const list = <K extends MissionStoreKind>(kind: K, filter: MissionListFilter = {}) =>
    Effect.gen(function* () {
      if (filter.ids !== undefined && filter.ids.length === 0) return [];
      if (filter.status !== undefined && filter.status.length === 0) return [];
      const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
      const clauses = [
        sql`kind = ${kind}`,
        ...(filter.missionId === undefined
          ? []
          : filter.missionId === null
            ? [sql`mission_id IS NULL`]
            : [sql`mission_id = ${filter.missionId}`]),
        ...(filter.subMissionId === undefined
          ? []
          : filter.subMissionId === null
            ? [sql`sub_mission_id IS NULL`]
            : [sql`sub_mission_id = ${filter.subMissionId}`]),
        ...(filter.status === undefined ? [] : [sql.in("status", filter.status)]),
        ...(filter.ids === undefined ? [] : [sql.in("id", filter.ids)]),
        ...(filter.updatedSince === undefined ? [] : [sql`updated_at > ${filter.updatedSince}`]),
      ];
      const order =
        filter.order === "oldest"
          ? sql`ORDER BY updated_at ASC, id ASC`
          : sql`ORDER BY updated_at DESC, id DESC`;
      const rows = yield* sql<RecordRow & { readonly id: string }>`
        SELECT id AS "id", record_json AS "recordJson" FROM ardud_mission_records
        WHERE ${sql.and(clauses)}
        ${order}
        LIMIT ${limit}
      `.pipe(NodeSqliteClient.readOnly, Effect.orDie);
      return yield* Effect.forEach(rows, (row) =>
        decodeStoredRecord(kind, row.id, row.recordJson).pipe(
          Effect.flatMap((decoded) =>
            decoded._tag === kind
              ? Effect.succeed(decoded.record as MissionRecordOf<K>)
              : Effect.fail(invalid(`Stored ${kind} ${row.id} holds a ${decoded._tag} record.`)),
          ),
        ),
      );
    });

  // --- router additions ---
  const listUncapped = <K extends MissionStoreKind>(
    kind: K,
    missionId: MissionId | null,
    status?: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      if (status !== undefined && status.length === 0) return [];
      const clauses = [
        sql`kind = ${kind}`,
        ...(missionId === null ? [] : [sql`mission_id = ${missionId}`]),
        ...(status === undefined ? [] : [sql.in("status", status)]),
      ];
      const rows = yield* sql<RecordRow & { readonly id: string }>`
        SELECT id AS "id", record_json AS "recordJson" FROM ardud_mission_records
        WHERE ${sql.and(clauses)}
        ORDER BY updated_at ASC, id ASC
      `.pipe(NodeSqliteClient.readOnly, Effect.orDie);
      return yield* Effect.forEach(rows, (row) =>
        decodeStoredRecord(kind, row.id, row.recordJson).pipe(
          Effect.flatMap((decoded) =>
            decoded._tag === kind
              ? Effect.succeed(decoded.record as MissionRecordOf<K>)
              : Effect.fail(invalid(`Stored ${kind} ${row.id} holds a ${decoded._tag} record.`)),
          ),
        ),
      );
    });

  const listAllInMission = <K extends MissionStoreKind>(
    kind: K,
    missionId: MissionId,
    status?: ReadonlyArray<string>,
  ) => listUncapped(kind, missionId, status);

  const listAll = <K extends MissionStoreKind>(kind: K, status?: ReadonlyArray<string>) =>
    listUncapped(kind, null, status);

  const missionsOfThread = (threadId: ThreadId) =>
    sql<{ readonly missionId: MissionId }>`
      SELECT DISTINCT mission_id AS "missionId" FROM (
        SELECT mission_id FROM ardud_mission_records
        WHERE json_extract(record_json, '$.record.threadId') = ${threadId}
          AND kind IN ('role-binding', 'lane')
        UNION
        SELECT mission_id FROM ardud_mission_records
        WHERE json_extract(record_json, '$.record.forkThreadId') = ${threadId}
          AND kind = 'fork'
      )
      WHERE mission_id IS NOT NULL
      ORDER BY mission_id
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.missionId)),
      NodeSqliteClient.readOnly,
      Effect.orDie,
    );
  // --- end router additions ---

  const eventsSince = (missionId: MissionId, afterSeq: number, limit = MAX_EVENTS_PAGE) =>
    Effect.gen(function* () {
      const bounded = Math.min(Math.max(limit, 1), MAX_EVENTS_PAGE);
      const rows = yield* sql<EventRow>`
        SELECT event_json AS "eventJson" FROM ardud_mission_events
        WHERE mission_id = ${missionId} AND seq > ${afterSeq}
        ORDER BY seq ASC
        LIMIT ${bounded}
      `.pipe(NodeSqliteClient.readOnly, Effect.orDie);
      return yield* Effect.forEach(rows, (row) => decodeStoredEvent(missionId, row.eventJson));
    });

  const recentEvents = (missionId: MissionId, limit: number, beforeSeq?: number) =>
    Effect.gen(function* () {
      const bounded = Math.min(Math.max(limit, 1), MAX_EVENTS_PAGE);
      const older = beforeSeq === undefined ? sql`` : sql`AND seq < ${beforeSeq}`;
      const rows = yield* sql<EventRow>`
        SELECT event_json AS "eventJson" FROM ardud_mission_events
        WHERE mission_id = ${missionId} ${older}
        ORDER BY seq DESC
        LIMIT ${bounded}
      `.pipe(NodeSqliteClient.readOnly, Effect.orDie);
      return yield* Effect.forEach(rows, (row) => decodeStoredEvent(missionId, row.eventJson));
    });

  // --- core additions ---
  const listPage = <K extends MissionStoreKind>(kind: K, filter: MissionPageFilter) =>
    Effect.gen(function* () {
      if (filter.status !== undefined && filter.status.length === 0) {
        return { records: [], total: 0 };
      }
      const where = sql.and([
        sql`kind = ${kind}`,
        sql`mission_id = ${filter.missionId}`,
        ...(filter.status === undefined ? [] : [sql.in("status", filter.status)]),
        ...(filter.laneId === undefined
          ? []
          : [sql`json_extract(record_json, '$.record.laneId') = ${filter.laneId}`]),
      ]);
      const counted = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS "total" FROM ardud_mission_records WHERE ${where}
      `.pipe(NodeSqliteClient.readOnly, Effect.orDie);
      const rows = yield* sql<RecordRow & { readonly id: string }>`
        SELECT id AS "id", record_json AS "recordJson" FROM ardud_mission_records
        WHERE ${where}
        ORDER BY updated_at DESC, id DESC
        LIMIT ${Math.max(filter.limit, 1)} OFFSET ${Math.max(filter.offset, 0)}
      `.pipe(NodeSqliteClient.readOnly, Effect.orDie);
      const records = yield* Effect.forEach(rows, (row) =>
        decodeStoredRecord(kind, row.id, row.recordJson).pipe(
          Effect.flatMap((decoded) =>
            decoded._tag === kind
              ? Effect.succeed(decoded.record as MissionRecordOf<K>)
              : Effect.fail(invalid(`Stored ${kind} ${row.id} holds a ${decoded._tag} record.`)),
          ),
        ),
      );
      return { records, total: counted[0]?.total ?? 0 };
    });
  // --- end core additions ---

  return MissionStore.of({
    commit,
    upsert: (record, event) => commit({ event, upserts: [record] }),
    appendEvent: (event) => commit({ event }).pipe(Effect.map((result) => result.event)),
    get,
    list,
    eventsSince,
    recentEvents,
    latestSeq: (missionId) => readCounter(`mission:${missionId}`),
    revision: readCounter(REVISION_SCOPE),
    ownerLastLookedAt: (missionId) =>
      sql<{ readonly lookedAt: string }>`
        SELECT looked_at AS "lookedAt" FROM ardud_mission_owner_looks WHERE mission_id = ${missionId}
      `.pipe(
        Effect.map((rows) => rows[0]?.lookedAt ?? null),
        NodeSqliteClient.readOnly,
        Effect.orDie,
      ),
    markOwnerLooked: (missionId, at) =>
      sql`
        INSERT INTO ardud_mission_owner_looks (mission_id, looked_at) VALUES (${missionId}, ${at})
        ON CONFLICT (mission_id) DO UPDATE SET looked_at = excluded.looked_at
      `.pipe(Effect.asVoid, Effect.orDie),
    subscribe: PubSub.subscribe(changes),
    // --- router additions ---
    listAllInMission,
    listAll,
    missionsOfThread,
    // --- end router additions ---
    // --- core additions ---
    listPage,
    // --- end core additions ---
  });
});

export const layer = Layer.effect(MissionStore, make);
