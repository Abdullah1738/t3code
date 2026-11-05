import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import { ensureShellLookupIndexes } from "../ardud/persistence/shellIndexes.ts";
import * as ServerConfig from "../config.ts";
import { withStartupPhase } from "../ardud/observability/StartupPhaseLog.ts";
import { initializeHistoryArchive } from "../ardud/persistence/HistoryArchive.ts";
import { historyReaderSql, baseArchiveFilename } from "../ardud/persistence/historyArchiveSql.ts";
import { archiveCheckpointLayer } from "../ardud/persistence/archiveCheckpoint.ts";
import { ArchiveSnapshotGate } from "../ardud/persistence/archiveSnapshotGate.ts";
import * as Semaphore from "effect/Semaphore";
// Reads only a tiny installation marker before constructing reader workers.
import * as NodeSqlite from "node:sqlite";

export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

export const runSqliteSetupPhases = Effect.fn("runSqliteSetupPhases")(function* <E1, R1, E2, R2>(
  migrations: Effect.Effect<void, E1, R1>,
  indexes: Effect.Effect<void, E2, R2>,
) {
  yield* withStartupPhase("sqlite.migrations", migrations);
  yield* withStartupPhase("sqlite.shell-indexes", indexes);
});

const layerSetup = Layer.effectDiscard(
  withStartupPhase(
    "sqlite.setup",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      // Only an empty file can switch modes here; an existing database needs the
      // offline VACUUM that `t3 doctor` runs, which rebuilds it with pointer maps.
      const tables = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
      if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      // FULL fsyncs the WAL on every commit, on the main thread. Every provider
      // event is its own commit, so a slow or busy disk stalls the event loop
      // and clients drop. In WAL mode NORMAL only fsyncs at checkpoints. It
      // cannot corrupt the database and an app crash loses nothing; an OS crash
      // or power loss can roll back commits since the last checkpoint.
      yield* sql`PRAGMA synchronous = NORMAL;`;
      // Checkpoints are now the only sync, and macOS fsync() does not flush the
      // drive cache. F_FULLFSYNC makes them reach disk; other platforms ignore it.
      yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
      // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
      // largest size until the last connection closes.
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
      // A sort holds up to cache_size in memory, then spills to a temp file. At
      // the 2 MB default the shell snapshot sort (~26 MB) spilled on every read,
      // about 26 MB a second of disk writes. temp_store = MEMORY would stop that
      // too, but leaves index builds and large search sorts without a bound.
      // The reader worker uses the same 64 MB.
      yield* sql`PRAGMA cache_size = -65536;`;
      yield* runSqliteSetupPhases(runMigrations(), ensureShellLookupIndexes());
      const baseMarker =
        yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'ardud_history_base_archive'`;
      const baseRows =
        baseMarker.length === 0
          ? []
          : yield* sql<{
              filename: string;
            }>`SELECT filename FROM ardud_history_base_archive LIMIT 1`;
      const mainRows = yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
      const mainFilename = mainRows.find((row) => row.name === "main")?.file ?? "";
      const baseFilename =
        baseRows[0] === undefined
          ? undefined
          : baseArchiveFilename(mainFilename, baseRows[0].filename);
      yield* withStartupPhase(
        "sqlite.history-archive",
        initializeHistoryArchive(baseFilename).pipe(
          Effect.catchTags({ HistoryArchiveMissing: Effect.die }),
        ),
      );
      // No planner statistics. Collecting them reads every page of the large
      // tables, and stats taken while a table was small make the planner scan it
      // once it grows. Without them SQLite assumes large tables and uses indexes;
      // the few queries that still pick a worse index name theirs with INDEXED BY.
      // Older builds collected stats, so clear them. A connection loads stats
      // when it opens, so this one must reload them after the delete.
      const statTables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'`;
      if (statTables.length > 0) {
        yield* sql`DELETE FROM sqlite_stat1;`;
        yield* sql`ANALYZE sqlite_schema;`;
      }
    }),
  ),
);

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  const snapshotGate = yield* Semaphore.make(1);
  const baseFilename = yield* Effect.sync(() => {
    const marker = new NodeSqlite.DatabaseSync(dbPath);
    try {
      const exists = marker
        .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'ardud_history_base_archive'")
        .get();
      const row =
        exists === undefined
          ? undefined
          : marker.prepare("SELECT filename FROM ardud_history_base_archive LIMIT 1").get();
      return typeof row?.filename === "string"
        ? path.resolve(path.dirname(dbPath), row.filename)
        : undefined;
    } finally {
      marker.close();
    }
  });

  return Layer.provideMerge(
    Layer.mergeAll(
      Layer.provideMerge(archiveCheckpointLayer(dbPath), layerSetup),
      Layer.succeed(ArchiveSnapshotGate, snapshotGate),
    ),
    Layer.effectContext(
      withStartupPhase(
        "sqlite.open",
        Layer.build(
          NodeSqliteClient.layer({
            filename: dbPath,
            readerWorker: true,
            readerInitializationSql: historyReaderSql(dbPath, baseFilename),
            readerSnapshotSql: [
              "SELECT rootpage FROM main.sqlite_schema LIMIT 1",
              "SELECT rootpage FROM ardud_archive.sqlite_schema LIMIT 1",
              "SELECT rootpage FROM ardud_base.sqlite_schema LIMIT 1",
            ],
            readerSnapshotLock: snapshotGate,
            // Checkpoints sync the database, with F_FULLFSYNC on macOS. Run them off
            // the event loop so a slow flush cannot stall clients.
            checkpointWorker: true,
            spanAttributes: {
              "db.name": path.basename(dbPath),
              "service.name": "t3code-server",
            },
          }),
        ),
      ),
    ),
  );
}, Layer.unwrap);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* withStartupPhase("sqlite.initialize", initializeV2Database(dbPath));
    return layerFromPath(dbPath);
  }),
);
