import { reconcileV2PreviewMigration } from "../../persistence/reconcileV2PreviewMigration.ts";
import { assertMigrationCompatibility } from "./migrationCompatibility.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { realpathSync, existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";

export async function runMigrationCheck(directory: string) {
  const root = realpathSync(directory);
  const live = resolve(homedir(), ".robob/userdata");
  if (
    root === live ||
    (existsSync(live) && root === realpathSync(live)) ||
    !existsSync(join(root, ".install-clone"))
  ) {
    throw new Error("Migration check requires a marked, isolated install clone");
  }
  for (const name of ["statev2.sqlite", "boards.sqlite"]) {
    const file = join(root, name);
    if (existsSync(file) && (lstatSync(file).isSymbolicLink() || realpathSync(file) !== file)) {
      throw new Error("Migration clone files must not link outside their directory");
    }
  }
  const state = join(root, "statev2.sqlite");
  const timed = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const start = performance.now();
      const result = yield* effect;
      const durationMs = performance.now() - start;
      console.log(JSON.stringify({ phase: "migration", name, durationMs }));
      if (durationMs > 20_000) throw new Error(`Migration ${name} exceeded 20 seconds`);
      return result;
    });
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
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
        yield* (yield* BoardsDatabase.BoardsDatabase).ready;
      }).pipe(
        Effect.provide(BoardsDatabase.layerFromPaths(join(root, "boards.sqlite"), state)),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
        Effect.timeout("20 seconds"),
      ),
    ),
  );
  console.log(JSON.stringify({ migrationCheck: "passed" }));
}
