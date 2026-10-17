import {
  MissionError,
  Pool,
  PoolHold,
  type MissionId,
  type PoolHoldStatus,
  type PoolId,
  type PullRequestKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { HoldEntry } from "./pools.ts";
import { PoolSource } from "./sources.ts";

/**
 * Pool holds are high-volume, so they live in this track's own table instead
 * of core's record table; their timeline events still go to core's log. Like
 * core's store, storage faults are defects and only contract mismatches fail
 * typed. Rows are never deleted: the highest fence on a pool
 * keeps rising across released and reconciled holds, like coord claims.
 * Never add these to persistence/Migrations.ts (upstream owns that list).
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS ardud_mission_pool_holds (
    id TEXT PRIMARY KEY,
    pool_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    fence INTEGER NOT NULL,
    status TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL,
    lease_expires_at TEXT,
    hold_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (pool_id, fence)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_pool_holds_pool_status
    ON ardud_mission_pool_holds (pool_id, status)`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_pool_holds_mission_status
    ON ardud_mission_pool_holds (mission_id, status)`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_pool_sources (
    pool_id TEXT PRIMARY KEY,
    source_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_pools (
    id TEXT PRIMARY KEY,
    pool_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ardud_mission_review_index (
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    PRIMARY KEY (kind, record_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ardud_mission_review_index_pr
    ON ardud_mission_review_index (mission_id, repository, number, kind)`,
];

const invalid = (detail: string) => new MissionError({ code: "invalid", detail });

const OPEN_STATUSES: ReadonlyArray<PoolHoldStatus> = ["queued", "active", "reconcile-required"];

const holdCodec = Schema.fromJsonString(PoolHold);
const decodeHold = Schema.decodeUnknownEffect(holdCodec);
const encodeHold = Schema.encodeEffect(holdCodec);
const poolCodec = Schema.fromJsonString(Pool);
const decodePool = Schema.decodeUnknownEffect(poolCodec);
const encodePool = Schema.encodeEffect(poolCodec);
const sourceCodec = Schema.fromJsonString(PoolSource);
const decodeSource = Schema.decodeUnknownEffect(sourceCodec);
const encodeSource = Schema.encodeEffect(sourceCodec);

export interface HoldFilter {
  readonly poolId?: PoolId;
  readonly missionId?: string;
  /** Only queued, active and reconcile-required holds. */
  readonly openOnly?: boolean;
}

export interface PoolSourceRow {
  readonly poolId: PoolId;
  readonly source: PoolSource;
  readonly updatedAt: string;
}

/** Records the review plan reads per pull request. */
export type ReviewIndexKind = "criticality-verdict" | "review";

export class PolicyStore extends Context.Service<
  PolicyStore,
  {
    /** Open holds on one pool (queued, active, reconcile-required). */
    readonly openHolds: (poolId: PoolId) => Effect.Effect<ReadonlyArray<HoldEntry>, MissionError>;
    /** Highest fence ever issued on the pool, 0 if none. */
    readonly lastFence: (poolId: PoolId) => Effect.Effect<number, MissionError>;
    readonly holds: (filter: HoldFilter) => Effect.Effect<ReadonlyArray<HoldEntry>, MissionError>;
    readonly hold: (id: string) => Effect.Effect<HoldEntry | null, MissionError>;
    readonly saveHolds: (entries: ReadonlyArray<HoldEntry>) => Effect.Effect<void, MissionError>;
    /**
     * Pools live here rather than in core's record table: observers resample
     * usage often and that must not write timeline events, and a global pool
     * has no mission to log under.
     */
    readonly pools: Effect.Effect<ReadonlyArray<Pool>, MissionError>;
    readonly pool: (id: PoolId) => Effect.Effect<Pool | null, MissionError>;
    readonly savePool: (pool: Pool) => Effect.Effect<void, MissionError>;
    /** Lets the review plan load one pull request's records from core by id. */
    readonly indexReview: (
      kind: ReviewIndexKind,
      recordId: string,
      missionId: MissionId,
      pullRequest: PullRequestKey,
    ) => Effect.Effect<void, MissionError>;
    readonly reviewIds: (
      kind: ReviewIndexKind,
      missionId: MissionId,
      pullRequest: PullRequestKey,
    ) => Effect.Effect<ReadonlyArray<string>, MissionError>;
    readonly sources: Effect.Effect<ReadonlyArray<PoolSourceRow>, MissionError>;
    readonly setSource: (
      poolId: PoolId,
      source: PoolSource | null,
      now: string,
    ) => Effect.Effect<void, MissionError>;
  }
>()("t3/ardud/missions/policy/PolicyStore") {}

interface HoldRow {
  readonly hold_json: string;
  readonly ttl_seconds: number;
}

interface SourceRow {
  readonly pool_id: string;
  readonly source_json: string;
  readonly updated_at: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(DDL, (statement) => sql.unsafe(statement), { discard: true }).pipe(
    Effect.orDie,
  );

  const toEntries = (rows: ReadonlyArray<HoldRow>) =>
    Effect.forEach(rows, (row) =>
      decodeHold(row.hold_json).pipe(
        Effect.map((hold): HoldEntry => ({ hold, ttlSeconds: row.ttl_seconds })),
        Effect.mapError(() => invalid("A stored pool hold does not match the mission contract.")),
      ),
    );

  const holds = (filter: HoldFilter) =>
    Effect.gen(function* () {
      const conditions = [
        ...(filter.poolId === undefined ? [] : [sql`pool_id = ${filter.poolId}`]),
        ...(filter.missionId === undefined ? [] : [sql`mission_id = ${filter.missionId}`]),
        ...(filter.openOnly === true ? [sql.in("status", OPEN_STATUSES)] : []),
      ];
      const rows = yield* sql<HoldRow>`
        SELECT hold_json, ttl_seconds FROM ardud_mission_pool_holds
        WHERE ${sql.and(conditions)}
        ORDER BY pool_id, fence
      `.pipe(Effect.orDie);
      return yield* toEntries(rows);
    });

  const openHolds = (poolId: PoolId) => holds({ poolId, openOnly: true });

  const lastFence = (poolId: PoolId) =>
    sql<{ readonly fence: number | null }>`
      SELECT MAX(fence) AS fence FROM ardud_mission_pool_holds WHERE pool_id = ${poolId}
    `.pipe(
      Effect.map((rows) => Number(rows[0]?.fence ?? 0)),
      Effect.orDie,
    );

  const hold = (id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<HoldRow>`
        SELECT hold_json, ttl_seconds FROM ardud_mission_pool_holds WHERE id = ${id}
      `.pipe(Effect.orDie);
      const entries = yield* toEntries(rows);
      return entries[0] ?? null;
    });

  const saveHolds = (entries: ReadonlyArray<HoldEntry>) =>
    Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          const { hold } = entry;
          const json = yield* encodeHold(hold).pipe(
            Effect.mapError(() =>
              invalid(`Pool hold ${hold.id} does not match the mission contract.`),
            ),
          );
          yield* sql`
            INSERT INTO ardud_mission_pool_holds ${sql.insert({
              id: hold.id,
              pool_id: hold.poolId,
              mission_id: hold.missionId,
              fence: hold.fence,
              status: hold.status,
              ttl_seconds: entry.ttlSeconds,
              lease_expires_at: hold.leaseExpiresAt,
              hold_json: json,
              created_at: hold.createdAt,
              updated_at: hold.releasedAt ?? hold.takenAt ?? hold.createdAt,
            })}
            ON CONFLICT (id) DO UPDATE SET
              status = excluded.status,
              ttl_seconds = excluded.ttl_seconds,
              lease_expires_at = excluded.lease_expires_at,
              hold_json = excluded.hold_json,
              updated_at = excluded.updated_at
          `.pipe(Effect.orDie);
        }),
      { discard: true },
    );

  const pools = Effect.gen(function* () {
    const rows = yield* sql<{ readonly pool_json: string }>`
      SELECT pool_json FROM ardud_mission_pools ORDER BY id
    `.pipe(Effect.orDie);
    return yield* Effect.forEach(rows, (row) =>
      decodePool(row.pool_json).pipe(
        Effect.mapError(() => invalid("A stored pool does not match the mission contract.")),
      ),
    );
  });

  const pool = (id: PoolId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly pool_json: string }>`
        SELECT pool_json FROM ardud_mission_pools WHERE id = ${id}
      `.pipe(Effect.orDie);
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodePool(row.pool_json).pipe(
        Effect.mapError(() => invalid(`Pool ${id} does not match the mission contract.`)),
      );
    });

  const savePool = (value: Pool) =>
    Effect.gen(function* () {
      const json = yield* encodePool(value).pipe(
        Effect.mapError(() => invalid(`Pool ${value.id} does not match the mission contract.`)),
      );
      yield* sql`
        INSERT INTO ardud_mission_pools ${sql.insert({
          id: value.id,
          pool_json: json,
          created_at: value.createdAt,
          updated_at: value.updatedAt,
        })}
        ON CONFLICT (id) DO UPDATE SET
          pool_json = excluded.pool_json,
          updated_at = excluded.updated_at
      `.pipe(Effect.orDie);
    });

  const indexReview = (
    kind: ReviewIndexKind,
    recordId: string,
    missionId: MissionId,
    pullRequest: PullRequestKey,
  ) =>
    sql`
      INSERT INTO ardud_mission_review_index ${sql.insert({
        kind,
        record_id: recordId,
        mission_id: missionId,
        repository: pullRequest.repository.toLowerCase(),
        number: pullRequest.number,
      })}
      ON CONFLICT (kind, record_id) DO NOTHING
    `.pipe(Effect.asVoid, Effect.orDie);

  const reviewIds = (kind: ReviewIndexKind, missionId: MissionId, pullRequest: PullRequestKey) =>
    sql<{ readonly record_id: string }>`
      SELECT record_id FROM ardud_mission_review_index
      WHERE kind = ${kind}
        AND mission_id = ${missionId}
        AND repository = ${pullRequest.repository.toLowerCase()}
        AND number = ${pullRequest.number}
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.record_id)),
      Effect.orDie,
    );

  const sources = Effect.gen(function* () {
    const rows = yield* sql<SourceRow>`
      SELECT pool_id, source_json, updated_at FROM ardud_mission_pool_sources ORDER BY pool_id
    `.pipe(Effect.orDie);
    return yield* Effect.forEach(rows, (row) =>
      decodeSource(row.source_json).pipe(
        Effect.map((source): PoolSourceRow => ({
          poolId: row.pool_id as PoolId,
          source,
          updatedAt: row.updated_at,
        })),
        Effect.mapError(() => invalid(`The source of pool ${row.pool_id} does not match.`)),
      ),
    );
  });

  const setSource = (poolId: PoolId, source: PoolSource | null, now: string) =>
    Effect.gen(function* () {
      if (source === null) {
        yield* sql`DELETE FROM ardud_mission_pool_sources WHERE pool_id = ${poolId}`.pipe(
          Effect.orDie,
        );
        return;
      }
      const json = yield* encodeSource(source).pipe(
        Effect.mapError(() => invalid(`The source of pool ${poolId} does not match.`)),
      );
      yield* sql`
        INSERT INTO ardud_mission_pool_sources ${sql.insert({
          pool_id: poolId,
          source_json: json,
          updated_at: now,
        })}
        ON CONFLICT (pool_id) DO UPDATE SET
          source_json = excluded.source_json,
          updated_at = excluded.updated_at
      `.pipe(Effect.orDie);
    });

  return PolicyStore.of({
    openHolds,
    lastFence,
    holds,
    hold,
    saveHolds,
    pools,
    pool,
    savePool,
    indexReview,
    reviewIds,
    sources,
    setSource,
  });
});

export const layer = Layer.effect(PolicyStore, make);
