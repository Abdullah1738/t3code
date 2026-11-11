import type { DatabaseStorageStatus } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveHostCliCommand } from "../cli/invocation.ts";
import {
  archiveHistoryPass,
  historyArchivePacing,
  nextHistoryArchiveDelayMs,
} from "../ardud/persistence/HistoryArchive.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { forkParked } from "../serverActivation.ts";

/** A slow disk must not turn minute-by-minute reclamation into a backlog. */
const RECLAIM_PAGES_PER_PASS = 16;
const RECLAIM_MAX_DURATION_MS = 100;
const COMPACTION_INTERVAL = Duration.hours(24);
const COMPACTION_MIN_PAGE_INTERVAL_MS = 25;
const COMPACTION_MAX_PAGES_PER_SCAN = 20;
const COMPACTION_MAX_DURATION_MS = 2_000;

export class DatabaseStorage extends Context.Service<
  DatabaseStorage,
  {
    /** Return free pages to the filesystem on databases with incremental auto_vacuum. */
    readonly reclaim: Effect.Effect<void>;
    /** Current file accounting, re-published after each maintenance pass. Null until first read. */
    readonly status: Stream.Stream<DatabaseStorageStatus | null>;
  }
>()("t3/persistence/DatabaseStorage") {}

/**
 * Deletes a bounded window of superseded history daily and hands a small number
 * of freed pages back to the filesystem every minute. Deleted events are superseded by a
 * retained event with a higher sequence, so a client replaying from an older
 * cursor still reaches the same state; no replay boundary is published.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statusRef = yield* SubscriptionRef.make<DatabaseStorageStatus | null>(null);

  // The notice shows this verbatim; quote for the host's shell. Desktop
  // installs have no `t3` on PATH, so the command names their launcher.
  const { command: compactCommand } = yield* resolveHostCliCommand("doctor", [
    "--base-dir",
    config.baseDir,
  ]);
  // `t3 doctor --base-dir` repairs <baseDir>/userdata. A dev server without
  // an explicit home keeps its state in <baseDir>/dev instead, so there the
  // command would target the live install; publish no status at all.
  const doctorTargetsThisDatabase =
    path.resolve(config.dbPath) ===
    path.resolve(config.baseDir, "userdata", path.basename(config.dbPath));
  const publishStatus = Effect.gen(function* () {
    if (!doctorTargetsThisDatabase) return;
    const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    const pageSize = size[0]?.page_size ?? 0;
    const next: DatabaseStorageStatus = {
      databaseBytes: (pages[0]?.page_count ?? 0) * pageSize,
      reclaimableBytes: (free[0]?.freelist_count ?? 0) * pageSize,
      incrementalVacuumEnabled: mode[0]?.auto_vacuum === 2,
      compactCommand,
    };
    // Every set reaches each open Storage page; most passes change nothing.
    if (!Equal.equals(yield* SubscriptionRef.get(statusRef), next)) {
      yield* SubscriptionRef.set(statusRef, next);
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Database storage inspection failed", { cause })),
  );

  const reclaim = Effect.gen(function* () {
    const started = yield* Clock.monotonicTimeNanos;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    if (mode[0]?.auto_vacuum !== 2) return;
    // Each statement frees at most one page; release the writer between them.
    for (let page = 0; page < RECLAIM_PAGES_PER_PASS; page++) {
      if (
        Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000 >=
        RECLAIM_MAX_DURATION_MS
      )
        break;
      const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      if ((free[0]?.freelist_count ?? 0) === 0) break;
      if (
        Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000 >=
        RECLAIM_MAX_DURATION_MS
      )
        break;
      yield* sql`PRAGMA incremental_vacuum(1)`;
      yield* Effect.sleep("2 millis");
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Database space reclamation failed", { cause })),
  );

  // Remember the bounded pass, not a full-store sweep. Starting from the newest
  // events again is safe without persisting the per-entity replay anchors.
  const compactedAtPath = path.join(path.dirname(config.dbPath), "compacted-at");
  const compact = Effect.gen(function* () {
    const result = yield* maintenance.compactEventStoreWith({
      minPageIntervalMs: COMPACTION_MIN_PAGE_INTERVAL_MS,
      minDeleteIntervalMs: 5,
      maxPagesPerScan: COMPACTION_MAX_PAGES_PER_SCAN,
      maxDurationMs: COMPACTION_MAX_DURATION_MS,
      maxDeletePayloadBytes: 64 * 1024,
    });
    const completedAt = yield* Clock.currentTimeMillis;
    yield* fs.writeFileString(compactedAtPath, String(completedAt)).pipe(Effect.ignore);
    if (
      result.deletedEventCount > 0 ||
      result.deletedReceiptCount > 0 ||
      result.consideredTextEventCount > 0
    ) {
      yield* Effect.logInfo("Compacted orchestration history", result);
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Orchestration history compaction failed", { cause }),
    ),
  );
  const lastCompactedAt = yield* fs.readFileString(compactedAtPath).pipe(
    Effect.map(Number),
    Effect.orElseSucceed(() => Number.NaN),
  );
  const intervalMs = Duration.toMillis(COMPACTION_INTERVAL);
  const untilDueMs = Number.isFinite(lastCompactedAt)
    ? lastCompactedAt + intervalMs - (yield* Clock.currentTimeMillis)
    : 0;
  const firstCompactionDelay = Duration.millis(
    Math.min(intervalMs, Math.max(Duration.toMillis(Duration.minutes(1)), untilDueMs)),
  );

  yield* forkParked(
    Effect.sleep(firstCompactionDelay).pipe(
      Effect.andThen(
        compact.pipe(
          Effect.andThen(publishStatus),
          Effect.repeat(Schedule.spaced(COMPACTION_INTERVAL)),
        ),
      ),
    ),
  );
  // ardud: archive passes are paced and back off under contention (HistoryArchive.ts,
  // historyArchivePacing). On 11 Nov 2026 back-to-back passes (25 ms apart) sat in the
  // single background reader queue and the writer queue for 60-140 s each.
  const archivePacing = historyArchivePacing();
  if (archivePacing.paused) {
    yield* Effect.logInfo("History archive paused by ROBOB_HISTORY_ARCHIVE_PAUSED");
  } else {
    const archiveLoop = Effect.gen(function* () {
      let contendedStreak = 0;
      while (true) {
        const passStarted = yield* Clock.currentTimeMillis;
        const pass = yield* archiveHistoryPass(archivePacing).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("History archive pass failed", { cause }).pipe(Effect.as(undefined)),
          ),
        );
        const durationMs = (yield* Clock.currentTimeMillis) - passStarted;
        contendedStreak = pass?.contended === true ? contendedStreak + 1 : 0;
        yield* Effect.sleep(
          Duration.millis(
            nextHistoryArchiveDelayMs(archivePacing, { durationMs, contendedStreak }),
          ),
        );
      }
    });
    yield* forkParked(Effect.sleep("1 minute").pipe(Effect.andThen(archiveLoop)));
  }
  yield* forkParked(
    publishStatus.pipe(
      Effect.andThen(Effect.sleep("1 minute")),
      Effect.andThen(
        reclaim.pipe(Effect.andThen(publishStatus), Effect.repeat(Schedule.spaced("1 minute"))),
      ),
    ),
  );

  return DatabaseStorage.of({ reclaim, status: SubscriptionRef.changes(statusRef) });
});

export const layer = Layer.effect(DatabaseStorage, make);
