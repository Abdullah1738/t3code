import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import {
  HISTORY_TABLES,
  historyViewSql,
  liveColumns,
  eventHistoryLookupViews,
  archiveFilename,
  emptyBaseSchemaSql,
} from "./historyArchiveSql.ts";
import { HistoryArchiveDurability } from "./archiveCheckpoint.ts";
import { ArchiveSnapshotGate } from "./archiveSnapshotGate.ts";
import * as NodeURL from "node:url";
import { initializeShellItemCounts } from "./shellItemCounts.ts";
import { withStartupPhase } from "../observability/StartupPhaseLog.ts";

class HistoryArchiveMissing extends Schema.TaggedError<HistoryArchiveMissing>()(
  "HistoryArchiveMissing",
  {},
) {
  override get message() {
    return "History archive is missing or belongs to a different database. Restore the matching archive.sqlite before opening this database.";
  }
}

/**
 * How archive commits reach disk.
 *
 * - `writer` (offline tools, the default): `synchronous = FULL` plus `fullfsync = ON` on
 *   the connection, so every archive commit is an F_FULLFSYNC where it runs.
 * - `worker` (the live server): the writer connection keeps no `fullfsync` and the
 *   archive commits with `synchronous = NORMAL`, so the event-loop thread never waits
 *   for the drive cache. `archiveHistoryPass` asks `HistoryArchiveDurability.syncArchive`
 *   (a full F_FULLFSYNC checkpoint in a worker) before it deletes the hot row.
 *   `fullfsync` is per connection, not per attached database: left ON it also applied
 *   to main's syncs on the live writer.
 */
export type HistoryArchiveDurabilityMode = "writer" | "worker";

export const initializeHistoryArchive = Effect.fn("HistoryArchive.initialize")(function* (
  baseFilename?: string,
  options?: { readonly durability?: HistoryArchiveDurabilityMode },
) {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
  const filename = databases.find((row) => row.name === "main")?.file ?? "";
  const archivePath = filename === "" ? ":memory:" : archiveFilename(filename);
  yield* sql`CREATE TABLE IF NOT EXISTS ardud_history_archive_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), has_cold_rows INTEGER NOT NULL DEFAULT 0)`;
  const coldState = yield* sql<{
    has_cold_rows: number;
  }>`SELECT has_cold_rows FROM ardud_history_archive_state WHERE singleton = 1`;
  if (filename !== "" && coldState[0]?.has_cold_rows === 1) {
    const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
    if (Option.isNone(fs) || !(yield* fs.value.exists(archivePath)))
      return yield* new HistoryArchiveMissing();
  }
  yield* sql`ATTACH DATABASE ${archivePath} AS ardud_archive`;
  yield* sql`PRAGMA ardud_archive.journal_mode = WAL`;
  // Copy and commit before deleting from main. FULL makes the archive copy
  // durable even when the OS loses main's later NORMAL-synchronous commit.
  yield* sql`PRAGMA ardud_archive.synchronous = FULL`;
  yield* sql`PRAGMA fullfsync = ON`;
  yield* sql`CREATE TABLE IF NOT EXISTS ardud_history_archive_identity (identity TEXT PRIMARY KEY)`;
  yield* sql`CREATE TABLE IF NOT EXISTS ardud_archive.ardud_identity (identity TEXT PRIMARY KEY)`;
  const mainIdentity = yield* sql<{
    identity: string;
  }>`SELECT identity FROM ardud_history_archive_identity LIMIT 1`;
  const coldIdentity = yield* sql<{
    identity: string;
  }>`SELECT identity FROM ardud_archive.ardud_identity LIMIT 1`;
  if (mainIdentity[0] !== undefined && mainIdentity[0].identity !== coldIdentity[0]?.identity) {
    return yield* new HistoryArchiveMissing();
  }
  if (mainIdentity[0] === undefined) {
    // Archive identity commits first, before main records the binding.
    if (coldIdentity[0] === undefined)
      yield* sql`INSERT INTO ardud_archive.ardud_identity VALUES (lower(hex(randomblob(16))))`;
    yield* sql`INSERT INTO ardud_history_archive_identity SELECT identity FROM ardud_archive.ardud_identity LIMIT 1`;
  }
  if (baseFilename === undefined) {
    yield* sql`ATTACH DATABASE ':memory:' AS ardud_base`;
    for (const statement of emptyBaseSchemaSql) yield* sql.unsafe(statement);
  } else {
    yield* sql`ATTACH DATABASE ${`${NodeURL.pathToFileURL(baseFilename).href}?mode=ro`} AS ardud_base`;
  }
  for (const table of HISTORY_TABLES) {
    yield* withStartupPhase(
      table.live === "orchestration_events" ? "sqlite.archive-events" : "sqlite.archive-turn-items",
      Effect.gen(function* () {
        const columns = yield* sql.unsafe<{ name: string; type: string }>(
          `PRAGMA main.table_info(${table.live})`,
        );
        const columnSql = columns.map((column) => `"${column.name}" ${column.type}`).join(", ");
        yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS ardud_archive.${table.archive} (
      ardud_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      ardud_locator INTEGER GENERATED ALWAYS AS (-(1000000000000 + ardud_rowid)) STORED UNIQUE,
      ${columnSql}, UNIQUE (${table.key}))`);
        yield* sql.unsafe(
          table.live === "orchestration_events"
            ? `CREATE INDEX IF NOT EXISTS ardud_archive.ardud_events_stream_idx ON ardud_events(stream_id, sequence)`
            : `CREATE INDEX IF NOT EXISTS ardud_archive.ardud_turn_items_thread_idx ON ardud_turn_items(thread_id, ordinal, turn_item_id)`,
        );
        if (table.live === "orchestration_events") {
          yield* sql`CREATE INDEX IF NOT EXISTS ardud_archive.ardud_events_command_idx ON ardud_events(command_id, sequence)`;
          yield* sql`CREATE INDEX IF NOT EXISTS ardud_archive.ardud_events_sequence_idx ON ardud_events(sequence)`;
          yield* sql`CREATE INDEX IF NOT EXISTS ardud_archive.ardud_events_identity_idx ON ardud_events(event_id)`;
        } else {
          yield* sql`CREATE INDEX IF NOT EXISTS ardud_archive.ardud_turn_items_run_idx ON ardud_turn_items(run_id, ordinal)`;
          yield* sql`CREATE INDEX IF NOT EXISTS ardud_archive.ardud_turn_items_node_idx ON ardud_turn_items(node_id, ordinal)`;
          yield* sql`CREATE INDEX IF NOT EXISTS ardud_archive.ardud_turn_items_provider_turn_idx ON ardud_turn_items(provider_turn_id)`;
          yield* sql`CREATE INDEX IF NOT EXISTS ardud_archive.ardud_turn_items_failed_error_idx
        ON ardud_turn_items(thread_id, run_id, node_id, updated_at DESC, ordinal DESC, turn_item_id DESC)
        WHERE type = 'error' AND status = 'failed'`;
          yield* sql`CREATE INDEX IF NOT EXISTS ardud_archive.ardud_turn_items_user_message_idx
        ON ardud_turn_items(thread_id, ordinal, turn_item_id) WHERE type = 'user_message'`;
        }
        yield* sql.unsafe(historyViewSql(table));
      }),
    );
  }
  for (const view of eventHistoryLookupViews) yield* sql.unsafe(view);
  yield* withStartupPhase("sqlite.archive-shell-counts", initializeShellItemCounts(baseFilename));
  yield* sql`CREATE TABLE IF NOT EXISTS ardud_history_archive_cursor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), thread_id TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS ardud_history_archive_progress (
    thread_id TEXT PRIMARY KEY, phase INTEGER NOT NULL DEFAULT 0,
    event_sequence INTEGER NOT NULL DEFAULT 0, item_ordinal INTEGER NOT NULL DEFAULT -1,
    item_id TEXT NOT NULL DEFAULT '', durable_revision INTEGER NOT NULL DEFAULT -1)`;
  yield* sql`CREATE TABLE IF NOT EXISTS ardud_history_archive_deletions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    row_key TEXT NOT NULL,
    through_event_sequence INTEGER NOT NULL,
    archived_at TEXT NOT NULL)`;
  yield* sql`CREATE TEMP TRIGGER IF NOT EXISTS ardud_archive_event_identity
    BEFORE INSERT ON main.orchestration_events
    WHEN EXISTS (SELECT 1 FROM ardud_events WHERE event_id = NEW.event_id)
      OR EXISTS (SELECT 1 FROM ardud_base.orchestration_events WHERE event_id = NEW.event_id)
    BEGIN SELECT RAISE(ABORT, 'event identity exists in history archive'); END`;
  if (options?.durability === "worker") {
    // The identity binding above committed under FULL + fullfsync, archive first. From
    // here on archive copies are made durable by the worker barrier before any delete.
    yield* sql`PRAGMA fullfsync = OFF`;
    yield* sql`PRAGMA ardud_archive.synchronous = NORMAL`;
  }
});

const retentionDays = () => {
  const configured = Number(process.env.T3CODE_HISTORY_RETENTION_DAYS ?? 7);
  return Number.isFinite(configured) && configured >= 1 ? configured : 7;
};

const envInteger = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

/**
 * Pacing for the archive loop, read once at startup. Overrides (restart, no rebuild):
 *
 * - `ROBOB_HISTORY_ARCHIVE_PAUSED=1`: no passes at all.
 * - `ROBOB_HISTORY_ARCHIVE_MIN_INTERVAL_MS` (default 250): the least idle time between
 *   two passes. The gap is also at least as long as the pass that just ran.
 * - `ROBOB_HISTORY_ARCHIVE_CONTENTION_MS` (default 1000): a pass that waits this long
 *   for a reader slot, the writer, a durability barrier or the snapshot gate stops and
 *   reports contention.
 * - `ROBOB_HISTORY_ARCHIVE_BACKOFF_MS` (default 10000) and
 *   `ROBOB_HISTORY_ARCHIVE_MAX_BACKOFF_MS` (default 300000): after a contended pass the
 *   loop waits the backoff, doubling per consecutive contended pass up to the max.
 */
export interface HistoryArchivePacing {
  readonly paused: boolean;
  readonly minIntervalMs: number;
  readonly contentionMs: number;
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
}

export const historyArchivePacing = (
  env: NodeJS.ProcessEnv = process.env,
): HistoryArchivePacing => {
  const paused = ["1", "true", "yes", "on"].includes(
    (env.ROBOB_HISTORY_ARCHIVE_PAUSED ?? "").trim().toLowerCase(),
  );
  const minIntervalMs = envInteger(
    env,
    "ROBOB_HISTORY_ARCHIVE_MIN_INTERVAL_MS",
    250,
    25,
    3_600_000,
  );
  const backoffMs = envInteger(env, "ROBOB_HISTORY_ARCHIVE_BACKOFF_MS", 10_000, 100, 3_600_000);
  return {
    paused,
    minIntervalMs,
    contentionMs: envInteger(env, "ROBOB_HISTORY_ARCHIVE_CONTENTION_MS", 1_000, 50, 600_000),
    backoffMs,
    maxBackoffMs: Math.max(
      backoffMs,
      envInteger(env, "ROBOB_HISTORY_ARCHIVE_MAX_BACKOFF_MS", 300_000, 100, 3_600_000),
    ),
  };
};

/**
 * Idle time after a pass. Passes never run back to back: the gap is at least the pass's
 * own duration (so archiving uses at most half the wall clock) and the minimum interval.
 * A contended pass (or a run of them) waits the doubling backoff instead, so the loop
 * stays off the writer and the background reader while they are congested.
 */
export const nextHistoryArchiveDelayMs = (
  pacing: HistoryArchivePacing,
  pass: { readonly durationMs: number; readonly contendedStreak: number },
): number => {
  const paced = Math.max(pacing.minIntervalMs, Math.ceil(pass.durationMs));
  if (pass.contendedStreak <= 0) return paced;
  const backoff = pacing.backoffMs * 2 ** Math.min(pass.contendedStreak - 1, 30);
  return Math.max(paced, Math.min(pacing.maxBackoffMs, backoff));
};

export interface HistoryArchivePassResult {
  readonly moved: number;
  /** The pass stopped early because the database was congested; back off. */
  readonly contended: boolean;
}

// One row per commit is intentional: a single tool payload can own thousands of
// overflow pages. A row count alone cannot promise a disk-latency deadline.
const MAX_ROWS_PER_PASS = 16;
// Large overflow chains cannot be deleted within an interactive writer budget.
// Leave those rows hot for the coordinator's offline maintenance pass.
const MAX_ROW_BYTES = 64 * 1024;

type ArchivePassPacing = Pick<HistoryArchivePacing, "contentionMs">;

export const archiveHistoryPass = Effect.fn("HistoryArchive.pass")(
  function* (passPacing?: ArchivePassPacing) {
    const pacing = passPacing ?? historyArchivePacing();
    const sql = yield* SqlClient.SqlClient;
    const started = yield* Clock.currentTimeMillis;
    const cutoff = DateTime.formatIso(DateTime.makeUnsafe(started - retentionDays() * 86_400_000));
    // Every step below can queue behind other work: the single background reader slot, the
    // writer (including its WAL checkpoint admission), the snapshot gate or a barrier.
    // - A read that completed is never thrown away, however long it queued: a slow read
    //   only limits the pass to one unit of progress (a cursor advance or one row), so a
    //   lane that is always ~1 s slow still lets archiving move forward, at the paced gap.
    // - Contention on a step that holds the writer or the snapshot gate (the progress
    //   write, the copy, the delete) or a failed durability barrier ends the pass as
    //   contended, and the loop backs off.
    const slow = (startedAt: number) =>
      Clock.currentTimeMillis.pipe(Effect.map((now) => now - startedAt >= pacing.contentionMs));
    const result = (moved: number, contended: boolean): HistoryArchivePassResult => ({
      moved,
      contended,
    });
    const cursor = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM ardud_history_archive_cursor WHERE singleton = 1`;
    // Keyset over the existing primary key; never build an index over 226 GB on boot.
    const discoveryStarted = yield* Clock.currentTimeMillis;
    const next = yield* sql<{ thread_id: string; updated_at: string; payload_json: string }>`
    SELECT thread_id, updated_at, payload_json FROM orchestration_v2_projection_threads
    WHERE thread_id > ${cursor[0]?.thread_id ?? ""} ORDER BY thread_id LIMIT 1
  `.pipe(NodeSqliteClient.readOnly);
    let readsSlow = yield* slow(discoveryStarted);
    const thread = next[0];
    const advance = (threadId: string) => sql`
    INSERT INTO ardud_history_archive_cursor (singleton, thread_id) VALUES (1, ${threadId})
    ON CONFLICT(singleton) DO UPDATE SET thread_id = excluded.thread_id`;
    if (thread === undefined) {
      yield* advance("");
      return result(0, false);
    }
    const eligible = sql`EXISTS (
    SELECT 1 FROM orchestration_v2_projection_threads AS thread
    WHERE thread.thread_id = ${thread.thread_id} AND thread.updated_at = ${thread.updated_at}
      AND (thread.updated_at < ${cutoff} OR json_extract(thread.payload_json, '$.archivedAt') IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS run
        WHERE run.thread_id = thread.thread_id AND run.status IN ('queued','preparing','starting','running','waiting'))
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests AS request
        WHERE request.thread_id = thread.thread_id AND request.status IN ('pending','waiting'))
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox AS effect INDEXED BY orchestration_v2_effect_outbox_claim_idx
        WHERE effect.thread_id = thread.thread_id AND effect.status IN ('pending','running'))
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents AS subagent
        WHERE subagent.thread_id = thread.thread_id AND subagent.status IN ('pending','starting','running','waiting'))
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items AS item
        WHERE item.thread_id = thread.thread_id AND item.status IN ('pending','starting','running','waiting'))
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_legacy_imports AS legacy
        WHERE legacy.thread_id = thread.thread_id AND legacy.transcript_imported_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads AS provider
        WHERE provider.thread_id = thread.thread_id
          AND json_array_length(provider.payload_json, '$.pendingBackgroundTasks') > 0)
  )`;
    const eligibilityStarted = yield* Clock.currentTimeMillis;
    const allowed = yield* sql<{ allowed: number; revision: number }>`SELECT ${eligible} AS allowed,
    (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${thread.thread_id}) AS revision`.pipe(
      NodeSqliteClient.readOnly,
    );
    if (yield* slow(eligibilityStarted)) readsSlow = true;
    if (allowed[0]?.allowed !== 1) {
      yield* advance(thread.thread_id);
      return result(0, false);
    }
    // Every runtime transition appends an event in the same transaction. Recheck
    // that fence on the writer instead of rescanning all runtime rows per delete.
    const unchanged = sql`EXISTS (SELECT 1 FROM orchestration_v2_projection_threads
      WHERE thread_id = ${thread.thread_id} AND updated_at = ${thread.updated_at})
    AND (SELECT MAX(sequence) FROM orchestration_events WHERE aggregate_kind = 'thread'
      AND stream_id = ${thread.thread_id}) = ${allowed[0]!.revision}`;
    let moved = 0;
    const writerStarted = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO ardud_history_archive_progress (thread_id) VALUES (${thread.thread_id})
    ON CONFLICT(thread_id) DO NOTHING`;
    if (yield* slow(writerStarted)) return result(0, true);
    const progress = (yield* sql<{
      phase: number;
      event_sequence: number;
      item_ordinal: number;
      item_id: string;
      durable_revision: number;
    }>`
    SELECT phase, event_sequence, item_ordinal, item_id, durable_revision FROM ardud_history_archive_progress WHERE thread_id = ${thread.thread_id}`)[0]!;
    const database = (yield* sql<{ name: string; file: string }>`PRAGMA database_list`).find(
      (row) => row.name === "main",
    )?.file;
    const durability = yield* Effect.serviceOption(HistoryArchiveDurability);
    if (database !== "" && progress.durable_revision !== allowed[0]!.revision) {
      if (Option.isNone(durability) || !(yield* durability.value.flushHistorySource))
        return result(0, true);
      yield* sql`UPDATE ardud_history_archive_progress SET durable_revision = ${allowed[0]!.revision}
      WHERE thread_id = ${thread.thread_id}`;
    }
    // Discovery may wait behind interactive reads; only row work consumes this
    // deadline, otherwise a slow discovery would starve this cursor forever.
    const workStarted = yield* Clock.currentTimeMillis;
    // After a slow read, one moved (or skipped) row is this pass's unit of progress.
    const withinBudget = () =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => moved === 0 || (!readsSlow && now - workStarted < 50)),
      );
    for (const table of HISTORY_TABLES) {
      if (table.live === "orchestration_events" && progress.phase > 0) continue;
      while (moved < MAX_ROWS_PER_PASS && (yield* withinBudget())) {
        const condition =
          table.live === "orchestration_events"
            ? sql`stream_id = ${thread.thread_id} AND aggregate_kind = 'thread'
            AND application_event_version = 2 AND event_type <> 'thread.created'
            AND sequence > ${progress.event_sequence}
            AND sequence < (SELECT MAX(sequence) FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${thread.thread_id})`
            : sql`thread_id = ${thread.thread_id} AND status NOT IN ('pending','starting','running','waiting')
            AND (ordinal, turn_item_id) > (${progress.item_ordinal}, ${progress.item_id})`;
        const candidateStarted = yield* Clock.currentTimeMillis;
        const candidates =
          table.live === "orchestration_events"
            ? yield* sql<{
                archive_key: number;
                ordinal: number;
                payload_json: string | null;
              }>`SELECT sequence AS archive_key, 0 AS ordinal,
            CASE WHEN octet_length(payload_json) <= ${MAX_ROW_BYTES} THEN payload_json END AS payload_json
            FROM orchestration_events WHERE ${condition} ORDER BY sequence LIMIT 1`.pipe(
                NodeSqliteClient.readOnly,
              )
            : yield* sql<{
                archive_key: string;
                ordinal: number;
                payload_json: string | null;
              }>`SELECT turn_item_id AS archive_key, ordinal,
            CASE WHEN octet_length(payload_json) <= ${MAX_ROW_BYTES} THEN payload_json END AS payload_json
            FROM orchestration_v2_projection_turn_items WHERE ${condition} ORDER BY ordinal, turn_item_id LIMIT 1`.pipe(
                NodeSqliteClient.readOnly,
              );
        if (yield* slow(candidateStarted)) readsSlow = true;
        const row = candidates[0];
        if (row === undefined) {
          if (table.live === "orchestration_events") {
            yield* sql`UPDATE ardud_history_archive_progress SET phase = 1 WHERE thread_id = ${thread.thread_id}`;
          }
          break;
        }
        const saveProgress =
          table.live === "orchestration_events"
            ? sql`UPDATE ardud_history_archive_progress SET event_sequence = ${row.archive_key} WHERE thread_id = ${thread.thread_id}`
            : sql`UPDATE ardud_history_archive_progress SET item_ordinal = ${row.ordinal}, item_id = ${row.archive_key} WHERE thread_id = ${thread.thread_id}`;
        const advanceProgress = () => {
          if (table.live === "orchestration_events")
            progress.event_sequence = Number(row.archive_key);
          else {
            progress.item_ordinal = row.ordinal;
            progress.item_id = String(row.archive_key);
          }
        };
        if (row.payload_json === null) {
          advanceProgress();
          yield* saveProgress;
          moved++;
          yield* Effect.sleep("1 millis");
          continue;
        }
        const columns = liveColumns(table.live);
        // Two separate commits, never an attached-WAL cross-database transaction:
        // archive first (durable), then guarded deletion. A crash can only duplicate.
        // Do not promote data written after the source durability barrier.
        const copy =
          table.live === "orchestration_events"
            ? sql`INSERT INTO ardud_archive.ardud_events (${sql.unsafe(columns)})
          SELECT ${sql.unsafe(columns)} FROM orchestration_events
          WHERE sequence = ${row.archive_key} AND payload_json = ${row.payload_json} AND ${unchanged}
          ON CONFLICT(sequence) DO UPDATE SET ${sql.unsafe(
            columns
              .split(", ")
              .map((column) => `${column} = excluded.${column}`)
              .join(", "),
          )}`
            : sql`INSERT INTO ardud_archive.ardud_turn_items (${sql.unsafe(columns)})
          SELECT ${sql.unsafe(columns)} FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${row.archive_key} AND payload_json = ${row.payload_json} AND ${unchanged}
          ON CONFLICT(turn_item_id) DO UPDATE SET ${sql.unsafe(
            columns
              .split(", ")
              .map((column) => `${column} = excluded.${column}`)
              .join(", "),
          )}`;
        // While the copy holds the snapshot gate, no reader on any lane can begin a
        // snapshot. Waiting for the writer (or its checkpoint admission) inside the gate
        // would stall interactive reads for as long as the writer is congested, so give
        // up the wait after the contention budget. The upsert is idempotent; a copy that
        // never ran is simply retried by a later pass.
        const copied = copy.pipe(
          Effect.as(true),
          Effect.timeoutOrElse({
            duration: Duration.millis(pacing.contentionMs),
            orElse: () => Effect.succeed(false),
          }),
        );
        const gate = yield* Effect.serviceOption(ArchiveSnapshotGate);
        const copyStarted = yield* Clock.currentTimeMillis;
        if (!(yield* Option.isSome(gate) ? gate.value.withPermits(1)(copied) : copied))
          return result(moved, true);
        const copySlow = yield* slow(copyStarted);
        // The archive copy must be on disk before main forgets the row. The live writer
        // commits archive rows without syncing; the worker makes them durable here.
        if (database !== "") {
          if (Option.isNone(durability) || !(yield* durability.value.syncArchive))
            return result(moved, true);
        }
        yield* Effect.yieldNow;
        const deleteStarted = yield* Clock.currentTimeMillis;
        const deleted = yield* sql.withTransaction(
          Effect.gen(function* () {
            const deletedRows = yield* sql<{
              deleted_key: string | number;
            }>`DELETE FROM ${sql(table.live)}
          WHERE ${sql(table.key)} = ${row.archive_key} AND payload_json = ${row.payload_json}
            AND EXISTS (SELECT 1 FROM ${sql(`ardud_archive.${table.archive}`)} AS cold
              WHERE cold.${sql(table.key)} = ${row.archive_key} AND cold.payload_json = ${row.payload_json})
            AND ${unchanged}
          RETURNING ${sql(table.key)} AS deleted_key`;
            // Replica consumers need projection removals. Event history is retained
            // under the same sequence in archive; journaling every event would grow
            // another multi-gigabyte history table in main.
            if (deletedRows.length > 0 && table.live !== "orchestration_events") {
              yield* sql`INSERT INTO ardud_history_archive_deletions
            (table_name, row_key, through_event_sequence, archived_at)
            SELECT ${table.live}, ${String(row.archive_key)}, COALESCE(MAX(sequence), 0), ${DateTime.formatIso(DateTime.makeUnsafe(started))}
            FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${thread.thread_id}`;
            }
            if (deletedRows.length > 0) {
              yield* sql`INSERT INTO ardud_history_archive_state (singleton, has_cold_rows) VALUES (1, 1)
            ON CONFLICT(singleton) DO UPDATE SET has_cold_rows = 1 WHERE has_cold_rows = 0`;
            }
            return deletedRows.length;
          }),
        );
        if (deleted === 0) return result(moved, false);
        advanceProgress();
        yield* saveProgress;
        moved++;
        if (copySlow || (yield* slow(deleteStarted))) return result(moved, true);
        yield* Effect.sleep("1 millis");
      }
      if (moved >= MAX_ROWS_PER_PASS || !(yield* withinBudget())) return result(moved, false);
    }
    yield* advance(thread.thread_id);
    yield* sql`DELETE FROM ardud_history_archive_progress WHERE thread_id = ${thread.thread_id}`;
    return result(moved, false);
  },
  (effect, _pacing?: ArchivePassPacing) => NodeSqliteClient.backgroundReads(effect),
);
