import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import { warmShellRunLookupPages } from "../../persistence/Migrations/068_ShellRunLookupIndexes.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";

// Direct/offline persistence consumers finish migrations synchronously.
export class ShellRunLookupMigration extends Context.Reference<Deferred.Deferred<void> | undefined>(
  "t3/ardud/persistence/ShellRunLookupMigration",
  { defaultValue: () => undefined },
) {}

export const runBootMigrations = Effect.fn("runBootMigrations")(function* (
  filename: string,
  ready: Deferred.Deferred<void>,
) {
  const sql = yield* SqlClient.SqlClient;
  const activation = yield* ServerActivation;
  const tables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'effect_sql_migrations'`;
  const latest =
    tables.length === 0
      ? 0
      : (yield* sql<{ id: number }>`SELECT max(migration_id) AS id FROM effect_sql_migrations`)[0]
          ?.id;
  // Only 068 is optional lookup acceleration. Never postpone schema migrations,
  // or skip a later migration that might depend on these indexes.
  if (activation === undefined || latest !== 67 || migrationManifest.at(-1)?.[0] !== 68) {
    yield* runMigrations();
    yield* Deferred.succeed(ready, undefined);
    return;
  }
  yield* runMigrations({ toMigrationInclusive: 67 });
  yield* forkParked(
    Effect.gen(function* () {
      // Cold table scans can take minutes on APFS. A separate read connection
      // warms pages without owning the server writer or a write transaction.
      yield* Effect.gen(function* () {
        const reader = yield* SqlClient.SqlClient;
        yield* reader`PRAGMA cache_size = -65536`;
        yield* warmShellRunLookupPages();
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })));
      yield* runMigrations({ skipShellRunLookupPreparation: true });
      yield* Deferred.succeed(ready, undefined);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Shell lookup index migration did not finish; existing indexes remain in use",
          { cause },
        ),
      ),
    ),
  );
});
