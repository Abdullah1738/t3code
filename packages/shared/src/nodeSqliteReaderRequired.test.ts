import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqliteClient from "./nodeSqliteClient.ts";

const filename = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "sqlite-required-reader-" }),
    "state.sqlite",
  );
});

it.live.each([
  { name: "unconfigured reader pool", options: { readerWorker: false } },
  {
    name: "failed reader initialization",
    options: {
      readerWorker: true,
      readerInitializationSql: ["SELECT * FROM missing_reader_fixture"],
    },
  },
])("requires a reader with $name while ordinary reads retain fallback", ({ options }) =>
  Effect.gen(function* () {
    const file = yield* filename;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode=WAL`;
      yield* sql`PRAGMA busy_timeout=0`;
      yield* sql`CREATE TABLE items(value INTEGER)`;
      yield* sql`INSERT INTO items VALUES(1)`;
      assert.deepEqual(yield* sql`SELECT value FROM items`.pipe(SqliteClient.readOnly), [
        { value: 1 },
      ]);
      const writer = new NodeSqlite.DatabaseSync(file);
      writer.exec("BEGIN IMMEDIATE; UPDATE items SET value=2");
      let entered = false;
      try {
        const error = yield* sql
          .withTransaction(
            Effect.sync(() => {
              entered = true;
            }),
          )
          .pipe(SqliteClient.requireReader, Effect.flip);
        assert.include(String(error.reason.cause), "Required SQLite reader unavailable");
        assert.isFalse(entered);
        const statementError = yield* sql`SELECT value FROM items`.pipe(
          SqliteClient.requireReader,
          Effect.flip,
        );
        assert.include(String(statementError.reason.cause), "Required SQLite reader unavailable");
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
      assert.deepEqual(
        yield* sql.withTransaction(sql`SELECT value FROM items`).pipe(SqliteClient.readOnly),
        [{ value: 1 }],
      );
    }).pipe(Effect.provide(SqliteClient.layer({ filename: file, ...options })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "retains a healthy reader snapshot through nested transactions while the writer commits",
  () =>
    Effect.gen(function* () {
      const file = yield* filename;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`CREATE TABLE items(value INTEGER)`;
        yield* sql`INSERT INTO items VALUES(1)`;
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              assert.deepEqual(yield* sql`SELECT value FROM items`, [{ value: 1 }]);
              const writer = new NodeSqlite.DatabaseSync(file);
              try {
                writer.exec("PRAGMA busy_timeout=0; UPDATE items SET value=2");
              } finally {
                writer.close();
              }
              return yield* sql.withTransaction(sql.withTransaction(sql`SELECT value FROM items`));
            }),
          )
          .pipe(SqliteClient.requireReader);
        assert.deepEqual(result, [{ value: 1 }]);
        assert.deepEqual(yield* sql`SELECT value FROM items`, [{ value: 2 }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: file, readerWorker: true })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("rejects a required-reader transaction nested inside a writer transaction", () =>
  Effect.gen(function* () {
    const file = yield* filename;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE items(value INTEGER)`;
      let entered = false;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO items VALUES(1)`;
          const error = yield* sql
            .withTransaction(
              Effect.sync(() => {
                entered = true;
              }),
            )
            .pipe(SqliteClient.requireReader, Effect.flip);
          assert.include(String(error.reason.cause), "inside writer transaction");
          assert.isFalse(entered);
        }),
      );
      assert.deepEqual(yield* sql`SELECT value FROM items`, [{ value: 1 }]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: file, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each([1, 2, 3])("requires a reader after %i ordinary savepoints", (depth) =>
  Effect.gen(function* () {
    const file = yield* filename;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode=WAL`;
      yield* sql`CREATE TABLE items(value INTEGER)`;
      yield* sql`INSERT INTO items VALUES(1)`;
      let snapshot = sql
        .withTransaction(sql`SELECT value FROM items`)
        .pipe(SqliteClient.requireReader);
      for (let n = 0; n < depth; n++) snapshot = sql.withTransaction(snapshot);
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            assert.deepEqual(yield* sql`SELECT value FROM items`, [{ value: 1 }]);
            const writer = new NodeSqlite.DatabaseSync(file);
            try {
              writer.exec("PRAGMA busy_timeout=0; UPDATE items SET value=2");
            } finally {
              writer.close();
            }
            return yield* snapshot;
          }),
        )
        .pipe(SqliteClient.readOnly);
      assert.deepEqual(result, [{ value: 1 }]);
      assert.deepEqual(yield* sql`SELECT value FROM items`, [{ value: 2 }]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: file, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each([
  { name: "writer", reader: false },
  { name: "read-only writer fallback", reader: true },
])("rejects required-reader acquisition through ordinary savepoints on a $name", ({ reader }) =>
  Effect.gen(function* () {
    const file = yield* filename;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const nested = sql.withTransaction(
        sql.withTransaction(sql`SELECT 1`).pipe(SqliteClient.requireReader),
      );
      const outer = sql.withTransaction(nested);
      const error = yield* (reader ? outer.pipe(SqliteClient.readOnly) : outer).pipe(Effect.flip);
      assert.include(String(error.reason.cause), "inside writer transaction");
    }).pipe(Effect.provide(SqliteClient.layer({ filename: file, readerWorker: false })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
