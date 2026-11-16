import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqlite from "node:sqlite";
import * as Sqlite from "./nodeSqliteClient.ts";
import { makeStatementStats, type StatementCompletion } from "./nodeSqliteStatementStats.ts";

const completion = (sql: string): StatementCompletion => ({
  database: "/private/userdata/statev2.sqlite",
  connection: "reader",
  lane: "background",
  sql,
  executionMs: 12,
  rows: 2,
  failed: false,
});

describe("statement statistics", () => {
  it("merges literal variants, separates lanes, and drains only counters", () => {
    const stats = makeStatementStats();
    stats.record(completion("SELECT value FROM entries WHERE id = 'private-value'"));
    stats.record({
      ...completion("SELECT value FROM entries WHERE id = 'another-value'"),
      failed: true,
    });
    stats.record({
      ...completion("SELECT value FROM entries WHERE id = 'another-value'"),
      lane: "foreground",
    });
    const rows = stats.drain();
    assert.strictEqual(rows.length, 2);
    assert.deepEqual(
      rows.map(({ calls, rows, failures, executionMs }) => ({
        calls,
        rows,
        failures,
        executionMs,
      })),
      [
        { calls: 2, rows: 4, failures: 1, executionMs: 24 },
        { calls: 1, rows: 2, failures: 0, executionMs: 12 },
      ],
    );
    assert.strictEqual(rows[0]!.database, "statev2.sqlite");
    assert.strictEqual(rows[0]!.sql, undefined);
    assert.strictEqual(JSON.stringify(rows).includes("private"), false);
    assert.deepEqual(stats.drain(), []);
  });

  it("bounds cardinality while preserving overflow work", () => {
    const stats = makeStatementStats(false, 2);
    for (let index = 0; index < 10; index++)
      stats.record(completion(`SELECT * FROM table_${index}`));
    const rows = stats.drain();
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(
      rows.reduce((sum, row) => sum + row.calls, 0),
      10,
    );
    assert.strictEqual(rows.find((row) => row.fingerprint === "overflow")?.calls, 8);
  });

  it("includes sanitized SQL only in the opt-in diagnostic", () => {
    const stats = makeStatementStats(true);
    stats.record(completion("SELECT value FROM entries WHERE id = 'private-value'"));
    assert.strictEqual(stats.drain()[0]!.sql, "SELECT value FROM entries WHERE id = ?");
  });

  it.effect.each([false, true])(
    "counts completed SQL with tracing disabled (workers=%s)",
    (workers) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const filename = workers ? path.join(dir, "test.sqlite") : ":memory:";
        if (workers)
          yield* Effect.sync(() => {
            const db = new NodeSqlite.DatabaseSync(filename);
            db.exec("PRAGMA journal_mode = WAL");
            db.close();
          });
        const stats = makeStatementStats(true);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE entries (id INTEGER PRIMARY KEY)`;
          yield* sql`INSERT INTO entries VALUES (1), (2)`;
          yield* sql`SELECT id FROM entries`.pipe(Sqlite.readOnly);
          if (workers) {
            yield* sql`SELECT id FROM entries WHERE id = 1`.pipe(Sqlite.authReadOnly);
            yield* sql`SELECT id FROM entries WHERE id = 1`.pipe(Sqlite.identityReadOnly);
          }
          yield* sql`SELECT id FROM missing_table`.pipe(Effect.flip);
        }).pipe(
          Effect.withTracerEnabled(false),
          Effect.provide(
            Sqlite.layer({
              filename,
              readerWorker: workers,
              authReaderProcess: workers,
              identityReaderProcess: workers,
            }),
          ),
          Effect.provideService(Sqlite.StatementStats, stats.record),
        );
        const rows = stats.drain();
        const select = rows.find((row) => row.sql === "SELECT id FROM entries");
        assert.strictEqual(select?.calls, 1);
        assert.strictEqual(select?.rows, 2);
        assert.strictEqual(select?.connection, workers ? "reader" : "writer");
        if (workers)
          assert.deepEqual(
            rows
              .filter((row) => row.connection === "reserved")
              .map((row) => row.lane)
              .sort(),
            ["auth", "identity"],
          );
        // A native prepare failure happens before execution; worker prepare and
        // execution share one request and report the failed attempt together.
        if (workers)
          assert.strictEqual(
            rows.find((row) => row.sql === "SELECT id FROM missing_table")?.failures,
            1,
          );
        assert.ok(rows.every((row) => row.executionMs >= 0));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
