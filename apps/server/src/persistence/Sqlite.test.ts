import { ErrorObserver, sqliteErrorDetails } from "@t3tools/shared/nodeSqliteErrors";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { WAL_SIZE_LIMIT_BYTES } from "./Sqlite.ts";
import { ensureShellLookupIndexes } from "../ardud/persistence/shellIndexes.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as StartupPhaseLog from "../ardud/observability/StartupPhaseLog.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ShellRunLookupMigration } from "../ardud/persistence/shellRunLookupMigration.ts";
import * as Statement from "effect/sql/Statement";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

it.effect("logs migration before a blocked shell-index phase", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-phases-"));
  const read = () =>
    NodeFS.readFileSync(NodePath.join(tempDir, "boot.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { phase: string; outcome: string });
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fiber = yield* SqlitePersistence.runSqliteSetupPhases(
      Effect.void,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.provide(StartupPhaseLog.layer(tempDir)), Effect.forkChild);
    yield* Deferred.await(entered);
    assert.deepEqual(
      read().map(({ phase, outcome }) => [phase, outcome]),
      [
        ["sqlite.migrations", "start"],
        ["sqlite.migrations", "success"],
        ["sqlite.shell-indexes", "start"],
      ],
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    assert.deepEqual(read().at(-1)?.outcome, "success");
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("logs the actual SQLite open, setup, migration, index and archive boundaries", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-phases-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      yield* SqlClient.SqlClient;
    }).pipe(
      Effect.provide(
        SqlitePersistence.layerFromPath(dbPath).pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(StartupPhaseLog.layer(tempDir)),
        ),
      ),
    );
    const records = NodeFS.readFileSync(NodePath.join(tempDir, "boot.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { phase: string; outcome: string });
    assert.deepEqual(
      records
        .filter(({ phase }) => !/^sqlite\.migration\.\d+$/.test(phase))
        .map(({ phase, outcome }) => [phase, outcome]),
      [
        ["sqlite.marker", "start"],
        ["sqlite.marker", "success"],
        ["sqlite.open", "start"],
        ["sqlite.open", "success"],
        ["sqlite.setup", "start"],
        ["sqlite.pragmas", "start"],
        ["sqlite.pragmas", "success"],
        ["sqlite.migrations", "start"],
        ["sqlite.migrations", "success"],
        ["sqlite.shell-indexes", "start"],
        ["sqlite.shell-indexes", "success"],
        ["sqlite.archive-marker", "start"],
        ["sqlite.archive-marker", "success"],
        ["sqlite.history-archive", "start"],
        ["sqlite.archive-events", "start"],
        ["sqlite.archive-events", "success"],
        ["sqlite.archive-turn-items", "start"],
        ["sqlite.archive-turn-items", "success"],
        ["sqlite.archive-shell-counts", "start"],
        ["sqlite.archive-shell-counts", "success"],
        ["sqlite.history-archive", "success"],
        ["sqlite.planner-statistics", "start"],
        ["sqlite.planner-statistics", "success"],
        ["sqlite.setup", "success"],
      ],
    );
    assert.equal(
      records.filter(
        ({ phase, outcome }) => /^sqlite\.migration\.\d+$/.test(phase) && outcome === "success",
      ).length,
      68,
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect(
  "boots existing shell counts with inherited WAL and a held write lock before activation",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-startup-wal-"));
    const filename = NodePath.join(directory, "state.sqlite");
    const persistence = SqlitePersistence.layerFromPath(filename).pipe(
      Layer.provide(NodeServices.layer),
    );
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* SqlClient.SqlClient;
      }).pipe(Effect.provide(persistence));
      const seed = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "-e",
          `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(process.argv[1]);
         db.exec('PRAGMA wal_autocheckpoint=0; CREATE TABLE startup_pages(payload BLOB)');
         db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1200) INSERT INTO startup_pages SELECT randomblob(4000) FROM n');
         process.exit(0);`,
          filename,
        ],
        { encoding: "utf8" },
      );
      assert.equal(seed.status, 0, seed.stderr);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const holder = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
            (db) => Effect.sync(() => db.close()),
          );
          const pending = holder.prepare("PRAGMA wal_checkpoint(NOOP)").get();
          assert.isAbove(Number(pending?.log) - Number(pending?.checkpointed), 1000);
          const log = StartupPhaseLog.makeStartupPhaseLog(directory);
          const startupLog = {
            ...log,
            start: (...args: Parameters<typeof log.start>) => {
              if (args[0] === "sqlite.archive-shell-counts") holder.exec("BEGIN IMMEDIATE");
              return log.start(...args);
            },
          };
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.isTrue(holder.isTransaction);
            assert.deepEqual(yield* sql`SELECT ready FROM ardud_shell_item_count_state`, [
              { ready: 1 },
            ]);
            assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM startup_pages`, [
              { count: 1200 },
            ]);
            assert.deepEqual((yield* sql`PRAGMA wal_checkpoint(NOOP)`)[0], pending);
            holder.exec("ROLLBACK");
            yield* sql`INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json)
            VALUES ('startup-item','startup-thread',0,'text','completed','now','{}')`;
            assert.deepEqual(
              yield* sql`SELECT thread_id, run_key, item_count FROM ardud_shell_item_counts`,
              [{ thread_id: "startup-thread", run_key: "", item_count: 1 }],
            );
          }).pipe(
            Effect.provide(
              SqlitePersistence.layerFromPath(filename).pipe(
                Layer.provide(NodeServices.layer),
                Layer.provide(Layer.succeed(ServerActivation, Effect.never)),
                Layer.provide(Layer.succeed(StartupPhaseLog.StartupPhaseLog, startupLog)),
              ),
            ),
          );
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect(
  "boots a pending lookup migration with inherited WAL before warming or taking its writer",
  () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-pending-migration-wal-"),
    );
    const filename = NodePath.join(directory, "state.sqlite");
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* SqlClient.SqlClient;
      }).pipe(
        Effect.provide(
          SqlitePersistence.layerFromPath(filename).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      const seed = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "-e",
          `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA wal_autocheckpoint=0; DELETE FROM effect_sql_migrations WHERE migration_id=68;         DROP INDEX ardud_shell_project_threads_idx; DROP INDEX ardud_shell_activity_run_idx;         DROP INDEX ardud_shell_executed_run_idx; CREATE TABLE startup_pages(payload BLOB);         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1200)         INSERT INTO startup_pages SELECT randomblob(4000) FROM n');
      process.exit(0);
    `,
          filename,
        ],
        { encoding: "utf8" },
      );
      assert.equal(seed.status, 0, seed.stderr);
      const activation = yield* Deferred.make<void>();
      const warmEntered = yield* Deferred.make<void>();
      const releaseWarm = yield* Deferred.make<void>();
      const observe: Statement.Transformer = (statement) =>
        Effect.gen(function* () {
          if (statement.compile()[0].includes("NOT INDEXED")) {
            yield* Deferred.succeed(warmEntered, undefined);
            yield* Deferred.await(releaseWarm);
          }
          return statement;
        });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ready = yield* ShellRunLookupMigration;
        assert.isDefined(ready);
        assert.isFalse(yield* Deferred.isDone(ready!));
        assert.isFalse(yield* Deferred.isDone(warmEntered));
        assert.deepEqual(yield* sql`SELECT max(migration_id) AS id FROM effect_sql_migrations`, [
          { id: 67 },
        ]);
        const pending = (yield* sql<{
          log: number;
          checkpointed: number;
        }>`PRAGMA wal_checkpoint(NOOP)`)[0]!;
        assert.isAbove(pending.log - pending.checkpointed, 1000);
        assert.isBelow(pending.log, 10000);
        yield* Deferred.succeed(activation, undefined);
        yield* Deferred.await(warmEntered);
        // Even while preparation is parked, the server writer accepts work.
        yield* sql`INSERT INTO startup_pages VALUES (X'01')`;
        assert.deepEqual(yield* sql`SELECT count(*) AS count FROM startup_pages`, [
          { count: 1201 },
        ]);
        yield* Deferred.succeed(releaseWarm, undefined);
        yield* Deferred.await(ready!);
        assert.deepEqual(yield* sql`SELECT max(migration_id) AS id FROM effect_sql_migrations`, [
          { id: 68 },
        ]);
        assert.lengthOf(
          yield* sql`SELECT name FROM sqlite_schema WHERE name IN
        ('ardud_shell_project_threads_idx', 'ardud_shell_activity_run_idx', 'ardud_shell_executed_run_idx')`,
          3,
        );
      }).pipe(
        Effect.provide(
          SqlitePersistence.layerFromPath(filename).pipe(
            Layer.provide(NodeServices.layer),
            Layer.provide(Layer.succeed(ServerActivation, Deferred.await(activation))),
          ),
        ),
        Effect.provideService(Statement.CurrentTransformer, observe),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );

it.effect.each(["absent", "empty", "filename"] as const)(
  "reads a %s archive marker without checkpointing the startup WAL",
  (marker) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sqlite-marker-wal-"));
    const filename = NodePath.join(directory, "state.sqlite");
    return Effect.gen(function* () {
      if (marker === "filename") {
        const identity = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (yield* sql<{
            identity: string;
          }>`SELECT identity FROM ardud_history_archive_identity`)[0]!.identity;
        }).pipe(
          Effect.provide(
            SqlitePersistence.layerFromPath(NodePath.join(directory, "base.sqlite")).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        NodeFS.writeFileSync(
          NodePath.join(directory, "shell-item-count-seed.json"),
          JSON.stringify({ baseFilename: "base.sqlite", sequence: 0, identity, counts: [] }),
        );
      }
      // Exit without sqlite3_close so the next connection inherits committed WAL frames.
      const seeded = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "-e",
          `const { DatabaseSync } = require("node:sqlite");
           const db = new DatabaseSync(process.argv[1]);
           db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
           db.exec("CREATE TABLE marker_probe(value TEXT); INSERT INTO marker_probe VALUES ('committed');");
           if (process.argv[2] !== "absent") db.exec("CREATE TABLE ardud_history_base_archive(filename TEXT)");
           if (process.argv[2] === "filename") db.exec("INSERT INTO ardud_history_base_archive VALUES ('base.sqlite')");
           process.exit(0);`,
          filename,
          marker,
        ],
        { encoding: "utf8" },
      );
      assert.equal(seeded.status, 0, seeded.stderr);
      const before = {
        main: NodeFS.readFileSync(filename),
        wal: NodeFS.readFileSync(`${filename}-wal`),
      };
      assert.isAbove(before.wal.length, 0);
      let afterMarker: typeof before | undefined;
      const logger = StartupPhaseLog.makeStartupPhaseLog(directory);
      const startupLog = {
        ...logger,
        end: (...args: Parameters<typeof logger.end>) => {
          logger.end(...args);
          if (args[0] === "sqlite.marker" && args[3] === "success") {
            afterMarker = {
              main: NodeFS.readFileSync(filename),
              wal: NodeFS.existsSync(`${filename}-wal`)
                ? NodeFS.readFileSync(`${filename}-wal`)
                : Buffer.alloc(0),
            };
          }
        },
      };
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(afterMarker, before);
        assert.deepEqual(
          [...(yield* sql`SELECT value FROM marker_probe`)],
          [{ value: "committed" }],
        );
        const bases = yield* sql<{ file: string; name: string }>`PRAGMA database_list`.pipe(
          NodeSqliteClient.readOnly,
        );
        assert.equal(
          bases.find((row) => row.name === "ardud_base")?.file,
          marker === "filename" ? NodePath.join(directory, "base.sqlite") : "",
        );
      }).pipe(
        Effect.provide(
          SqlitePersistence.layerFromPath(filename).pipe(
            Layer.provide(NodeServices.layer),
            Layer.provide(Layer.succeed(StartupPhaseLog.StartupPhaseLog, startupLog)),
          ),
        ),
      );
      const reopened = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
      try {
        assert.deepEqual(
          { ...reopened.prepare("PRAGMA integrity_check").get() },
          { integrity_check: "ok" },
        );
      } finally {
        reopened.close();
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect.each([
  { journal: "DELETE", interrupted: false },
  { journal: "DELETE", interrupted: true },
  { journal: "TRUNCATE", interrupted: false },
  { journal: "TRUNCATE", interrupted: true },
  { journal: "PERSIST", interrupted: false },
  { journal: "PERSIST", interrupted: true },
  { journal: "WAL", interrupted: false },
  { journal: "WAL", interrupted: true },
  { journal: "MEMORY", interrupted: false },
  { journal: "OFF", interrupted: false },
])(
  "opens $journal databases with interrupted=$interrupted transactions",
  ({ journal, interrupted }) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sqlite-marker-recovery-"));
    const filename = NodePath.join(directory, "state.sqlite");
    return Effect.gen(function* () {
      const seeded = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "-e",
          `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(process.argv[1]);
         db.exec("PRAGMA journal_mode=" + process.argv[2]);
         db.exec("PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=1;");
         db.exec("CREATE TABLE marker_probe(value TEXT); INSERT INTO marker_probe VALUES ('committed');");
         if (process.argv[3] === "true") {
           db.exec("BEGIN IMMEDIATE; UPDATE marker_probe SET value='uncommitted';");
           db.exec("CREATE TABLE pending_probe(payload BLOB)");
           db.exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<50) INSERT INTO pending_probe SELECT randomblob(4096) FROM n");
         } else db.close();
         process.exit(0);`,
          filename,
          journal,
          String(interrupted),
        ],
        { encoding: "utf8" },
      );
      assert.equal(seeded.status, 0, seeded.stderr);
      if (journal !== "WAL" && interrupted) {
        const readonly = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
        try {
          const failure = assert.throws(() =>
            readonly.prepare("SELECT * FROM sqlite_schema").all(),
          );
          assert.equal(sqliteErrorDetails(failure)?.errcode, 776);
        } finally {
          readonly.close();
        }
      }
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          [...(yield* sql`SELECT value FROM marker_probe`)],
          [{ value: "committed" }],
        );
        assert.deepEqual(
          [...(yield* sql`SELECT name FROM sqlite_schema WHERE name='pending_probe'`)],
          [],
        );
        assert.deepEqual([...(yield* sql`PRAGMA integrity_check`)], [{ integrity_check: "ok" }]);
      }).pipe(
        Effect.provide(
          SqlitePersistence.layerFromPath(filename).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 300);
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
    assert.deepEqual([...rows], [{ id: 1 }]);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("limits the WAL file size in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly journal_size_limit: number }>`PRAGMA journal_size_limit`;
    assert.equal(rows[0]?.journal_size_limit, WAL_SIZE_LIMIT_BYTES);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      // Stats from a nearly empty table, as an older build collected on a new install.
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

const authoredIndexSql = (sql: SqlClient.SqlClient) =>
  sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND name = 'ardud_v2_messages_latest_user_authored_idx'
  `;

it.effect("installs the authored-message shell index on fresh and reopened databases", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-authored-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    const first = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* authoredIndexSql(sql);
    }).pipe(Effect.provide(persistence()));
    assert.lengthOf(first, 1);
    assert.include(
      first[0]!.sql,
      "WHERE role = 'user' AND json_extract(payload_json, '$.createdBy') = 'user'",
    );

    const reopened = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureShellLookupIndexes();
      return yield* authoredIndexSql(sql);
    }).pipe(Effect.provide(persistence()));
    assert.deepEqual(reopened, first);

    const memory = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* authoredIndexSql(sql);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory));
    assert.lengthOf(memory, 1);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("only fsyncs the database file at WAL checkpoints", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-sync-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
    assert.equal(rows[0]?.synchronous, 1);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("gives the writer and the reader a 64 MB cache so sorts stay off disk", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-cache-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE cache_probe(id INTEGER PRIMARY KEY)`;
    const writer = yield* sql<{ readonly cache_size: number }>`PRAGMA cache_size`;
    const reader = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly cache_size: number }>`PRAGMA cache_size`;
          // Only the read-only reader refuses this, so the rows above came from it.
          const write = yield* sql`INSERT INTO cache_probe(id) VALUES (${1})`.pipe(Effect.flip);
          assert.include(String(write.reason.cause), "readonly database");
          return rows;
        }),
      )
      .pipe(NodeSqliteClient.readOnly);
    assert.equal(writer[0]?.cache_size, -65536);
    assert.equal(reader[0]?.cache_size, -65536);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("applies busy_timeout in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
    assert.equal(rows[0]?.timeout, 5000);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("enables checkpoint_fullfsync in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly checkpoint_fullfsync: number;
    }>`PRAGMA checkpoint_fullfsync`;
    assert.equal(rows[0]?.checkpoint_fullfsync, 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("records a raw startup marker failure before the routed client opens", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sqlite-marker-"));
  const filename = NodePath.join(directory, "state.sqlite");
  NodeFS.writeFileSync(filename, "bad database".repeat(1024));
  const observations: unknown[] = [];
  return Effect.exit(Layer.build(SqlitePersistence.layerFromPath(filename))).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.equal(observations.length, 1);
        assert.equal(sqliteErrorDetails(observations[0])?.errcode, 26);
        assert.equal(sqliteErrorDetails(observations[0])?.context?.connection, "startup-marker");
      }),
    ),
    Effect.provideService(ErrorObserver, (cause) => observations.push(cause)),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
