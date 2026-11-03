// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
    NodeFS.readFileSync(NodePath.join(tempDir, "startup-phases.ndjson"), "utf8")
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

it.effect("logs the actual SQLite open, setup, migration and index boundaries", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-phases-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      yield* SqlClient.SqlClient;
    }).pipe(
      Effect.provide(
        SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
      Effect.provide(StartupPhaseLog.layer(tempDir)),
    );
    const records = NodeFS.readFileSync(NodePath.join(tempDir, "startup-phases.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { phase: string; outcome: string });
    assert.deepEqual(
      records.map(({ phase, outcome }) => [phase, outcome]),
      [
        ["sqlite.open", "start"],
        ["sqlite.open", "success"],
        ["sqlite.setup", "start"],
        ["sqlite.migrations", "start"],
        ["sqlite.migrations", "success"],
        ["sqlite.shell-indexes", "start"],
        ["sqlite.shell-indexes", "success"],
        ["sqlite.setup", "success"],
      ],
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

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
