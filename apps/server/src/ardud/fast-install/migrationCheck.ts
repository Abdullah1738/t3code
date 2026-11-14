// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalConsoleInEffect:off preferSchemaOverJson:off -- Standalone preflight validates paths before its Effect runtime and writes machine-readable stdout.
import { reconcileV2PreviewMigration } from "../../persistence/reconcileV2PreviewMigration.ts";
import { assertMigrationCompatibility } from "./migrationCompatibility.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import { warmShellRunLookupPages } from "../../persistence/Migrations/068_ShellRunLookupIndexes.ts";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";

export async function runMigrationCheck(directory: string) {
  const root = NodeFS.realpathSync(directory);
  const live = NodePath.resolve(NodeOS.homedir(), ".robob/userdata");
  if (
    root === live ||
    (NodeFS.existsSync(live) && root === NodeFS.realpathSync(live)) ||
    !NodeFS.existsSync(NodePath.join(root, ".install-clone"))
  ) {
    throw new Error("Migration check requires a marked, isolated install clone");
  }
  for (const name of ["statev2.sqlite", "boards.sqlite"]) {
    const file = NodePath.join(root, name);
    if (
      NodeFS.existsSync(file) &&
      (NodeFS.lstatSync(file).isSymbolicLink() || NodeFS.realpathSync(file) !== file)
    ) {
      throw new Error("Migration clone files must not link outside their directory");
    }
  }
  const state = NodePath.join(root, "statev2.sqlite");
  const closingReaders: NodeSqlite.DatabaseSync[] = [];
  const holdThroughWriterClose = (filename: string) => {
    const reader = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
    closingReaders.push(reader);
    reader.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
  };
  const timed = Effect.fn("MigrationCheck.timed")(function* <A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
  ) {
    const start = performance.now();
    const result = yield* effect;
    const durationMs = performance.now() - start;
    console.log(JSON.stringify({ phase: "migration", name, durationMs }));
    if (durationMs > 20_000) throw new Error(`Migration ${name} exceeded 20 seconds`);
    return result;
  });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Match startup's WAL commits before any migration or read preparation.
        // This disposable clone has no activation/checkpoint worker; writeback is
        // not part of schema compatibility. The read-only last close preserves WAL.
        yield* sql`PRAGMA busy_timeout = 5000`;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* sql`PRAGMA wal_autocheckpoint = 0`;
        const existing = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'`;
        if (existing[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`PRAGMA synchronous = NORMAL`;
        yield* sql`PRAGMA checkpoint_fullfsync = ON`;
        yield* sql`PRAGMA journal_size_limit = 33554432`;
        yield* sql`PRAGMA cache_size = -65536`;
        holdThroughWriterClose(state);
        console.log(
          JSON.stringify({
            phase: "migration-sqlite-settings",
            journalMode: (yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`)[0]
              ?.journal_mode,
            synchronous: (yield* sql<{ synchronous: number }>`PRAGMA synchronous`)[0]?.synchronous,
            walAutocheckpoint: (yield* sql<{
              wal_autocheckpoint: number;
            }>`PRAGMA wal_autocheckpoint`)[0]?.wal_autocheckpoint,
            checkpointFullfsync: (yield* sql<{
              checkpoint_fullfsync: number;
            }>`PRAGMA checkpoint_fullfsync`)[0]?.checkpoint_fullfsync,
            cacheSize: (yield* sql<{ cache_size: number }>`PRAGMA cache_size`)[0]?.cache_size,
          }),
        );
        yield* timed("preview-history", reconcileV2PreviewMigration());
        const tables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'effect_sql_migrations'`;
        const rows = tables.length
          ? yield* sql<{
              migration_id: number;
              name: string;
            }>`SELECT migration_id, name FROM effect_sql_migrations`
          : [];
        assertMigrationCompatibility(rows, migrationManifest);
        const latest = Math.max(0, ...rows.map((row) => row.migration_id));
        // Page reads happen before the migrator acquires its writer. Report them
        // separately so the per-migration budget measures the warmed DDL path.
        if (latest >= 55 && latest < 68) {
          const start = performance.now();
          yield* warmShellRunLookupPages();
          console.log(
            JSON.stringify({
              phase: "migration-read-preparation",
              durationMs: performance.now() - start,
            }),
          );
        }
        for (const [id, name] of migrationManifest) {
          if (id > latest) yield* timed(name, runMigrations({ toMigrationInclusive: id }));
        }
        yield* timed("schema-validation", runMigrations());
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: state }))),
    );
    await Effect.runPromise(
      timed(
        "boards",
        Effect.gen(function* () {
          const boards = yield* BoardsDatabase.BoardsDatabase;
          yield* boards.ready;
          holdThroughWriterClose(boards.path);
        }).pipe(
          Effect.provide(
            BoardsDatabase.layerFromPaths(NodePath.join(root, "boards.sqlite"), state).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Effect.scoped,
          Effect.timeout("20 seconds"),
        ),
      ),
    );
  } finally {
    for (const reader of closingReaders) reader.close();
  }
  console.log(JSON.stringify({ migrationCheck: "passed" }));
}
