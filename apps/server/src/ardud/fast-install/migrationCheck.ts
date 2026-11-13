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
import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
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
    if (NodeFS.existsSync(file) && (NodeFS.lstatSync(file).isSymbolicLink() || NodeFS.realpathSync(file) !== file)) {
      throw new Error("Migration clone files must not link outside their directory");
    }
  }
  const state = NodePath.join(root, "statev2.sqlite");
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
        Effect.provide(BoardsDatabase.layerFromPaths(NodePath.join(root, "boards.sqlite"), state).pipe(Layer.provide(NodeServices.layer))),
        Effect.scoped,
        Effect.timeout("20 seconds"),
      ),
    ),
  );
  console.log(JSON.stringify({ migrationCheck: "passed" }));
}
