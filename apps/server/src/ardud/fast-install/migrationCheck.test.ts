// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Verify SQLite WAL state and raw preflight JSON output.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import { runMigrations } from "../../persistence/Migrations.ts";
import { runMigrationCheck } from "./migrationCheck.ts";

it.effect(
  "preflights inherited WAL with startup pragmas and no commit or last-close checkpoint",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-migration-check-" });
      const state = path.join(directory, "statev2.sqlite");
      yield* fs.writeFileString(path.join(directory, ".install-clone"), "synthetic");
      yield* runMigrations({ toMigrationInclusive: 67 }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: state })),
      );
      const seed = new NodeSqlite.DatabaseSync(state);
      seed.exec(`PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE inherited_pages (payload BLOB);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
        INSERT INTO inherited_pages SELECT zeroblob(4000) FROM n;`);
      let holder: NodeSqlite.DatabaseSync | undefined = new NodeSqlite.DatabaseSync(state, {
        readOnly: true,
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => holder?.close()));
      holder.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      seed.close();
      const records: Array<Record<string, unknown>> = [];
      const log = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
        if (typeof message !== "string" || !message.startsWith("{")) return;
        const record = JSON.parse(message) as Record<string, unknown>;
        records.push(record);
        if (record.phase === "migration-sqlite-settings") {
          // Once preflight owns its own reader, remove the fixture's connection.
          holder?.close();
          holder = undefined;
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => log.mockRestore()));
      yield* Effect.promise(() => runMigrationCheck(directory));
      assert.deepEqual(
        records.find((record) => record.phase === "migration-sqlite-settings"),
        {
          phase: "migration-sqlite-settings",
          journalMode: "wal",
          synchronous: 1,
          walAutocheckpoint: 0,
          checkpointFullfsync: 1,
          cacheSize: -65536,
        },
      );
      assert.deepEqual(records.at(-1), { migrationCheck: "passed" });
      assert.isTrue(records.some((record) => record.name === "ShellRunLookupIndexes"));
      assert.isTrue(records.some((record) => record.name === "boards"));
      assert.isTrue(yield* fs.exists(`${state}-wal`));
      const observer = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(state, { readOnly: true })),
        (db) => Effect.sync(() => db.close()),
      );
      const wal = observer.prepare("PRAGMA wal_checkpoint(NOOP)").get();
      assert.isAtLeast(Number(wal?.log), 1200);
      assert.equal(Number(wal?.checkpointed), 0);
      assert.deepEqual(observer.prepare("SELECT count(*) AS count FROM inherited_pages").get(), {
        count: 1200,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
