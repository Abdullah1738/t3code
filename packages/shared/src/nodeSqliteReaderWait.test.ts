import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqliteClient from "./nodeSqliteClient.ts";
import * as NodeSqlite from "node:sqlite";
import * as TestClock from "effect/testing/TestClock";

it.effect.each([false, true])(
  "#1747 snapshots stay live through queued reader acquisition (transaction=%s)",
  (transaction) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* sql
          .withTransaction(
            sql`SELECT 1`.pipe(
              Effect.andThen(Deferred.succeed(held, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
          )
          .pipe(SqliteClient.readOnly, Effect.withSpan("KanbanAskFeed.read"), Effect.forkChild);
        yield* Deferred.await(held);
        const entered = yield* Deferred.make<void>();
        const snapshots = new Set<() => SqliteClient.ReaderSnapshot>();
        const waiter = yield* (
          transaction ? sql.withTransaction(sql`SELECT 1`) : sql`SELECT 1`
        ).pipe(
          SqliteClient.readOnly,
          Effect.provideService(SqliteClient.ReaderSnapshotObserver, (snapshot) => {
            snapshots.add(snapshot);
            Deferred.doneUnsafe(entered, Effect.void);
            return () => {
              snapshots.delete(snapshot);
            };
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust(5_000);
        assert.lengthOf([...snapshots], 1);
        const snapshot = [...snapshots][0]!();
        assert.deepInclude(snapshot, {
          db: "boards",
          connection: "reader",
          lane: "background",
          slot: 0,
          stage: "slot",
          queueDepth: 1,
          oldestInFlightAgeMs: 5_000,
        });
        yield* Fiber.interrupt(waiter);
        assert.equal(snapshots.size, 0);
        assert.equal(snapshot.queueDepth, 1);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        assert.deepEqual(
          yield* sql`SELECT 1 AS n`.pipe(
            SqliteClient.readOnly,
            Effect.provideService(SqliteClient.ReaderSnapshotObserver, () => {
              throw new Error("observer");
            }),
          ),
          [{ n: 1 }],
        );
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename: path.join(dir, "boards.sqlite"),
            readerWorker: true,
            spanAttributes: { "db.name": "boards" },
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "counts reader acquisitions once per borrow or transaction even with tracing disabled",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(path.join(dir, "test.sqlite"));
        try {
          db.exec("PRAGMA journal_mode = WAL");
        } finally {
          db.close();
        }
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const waits: number[] = [];
        const granted: string[] = [];
        let pending = 0;
        const started = () => {
          pending++;
          return (lane: string, acquired: boolean) => {
            if (!acquired) return;
            pending--;
            granted.push(lane);
          };
        };
        yield* sql`SELECT 1`.pipe(SqliteClient.readOnly);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT 1`;
              yield* sql`SELECT 2`;
            }),
          )
          .pipe(SqliteClient.readOnly, SqliteClient.foregroundReads);
        assert.equal(waits.length, 0);
        yield* sql`SELECT 1`.pipe(
          SqliteClient.readOnly,
          Effect.provideService(SqliteClient.ReaderWaitStartedObserver, started),
          Effect.provideService(SqliteClient.ReaderWaitObserver, (ms) => waits.push(ms)),
        );
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT 1`;
              yield* sql`SELECT 2`;
            }),
          )
          .pipe(
            SqliteClient.readOnly,
            SqliteClient.foregroundReads,
            Effect.provideService(SqliteClient.ReaderWaitStartedObserver, started),
            Effect.provideService(SqliteClient.ReaderWaitObserver, (ms) => waits.push(ms)),
          );
        assert.equal(waits.length, 2);
        assert.equal(pending, 0);
        assert.deepEqual(granted, ["background", "foreground"]);
        assert.isTrue(waits.every((ms) => Number.isFinite(ms) && ms >= 0));
        assert.deepEqual(
          yield* sql`SELECT 3 AS n`.pipe(
            SqliteClient.readOnly,
            Effect.provideService(SqliteClient.ReaderWaitStartedObserver, () => {
              throw new Error("observer");
            }),
            Effect.provideService(SqliteClient.ReaderWaitObserver, () => {
              throw new Error("observer");
            }),
          ),
          [{ n: 3 }],
        );
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename: path.join(dir, "test.sqlite"),
            readerWorker: true,
            foregroundReaderSlots: 1,
          }),
        ),
        Effect.withTracerEnabled(false),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each([false, true])(
  "records interrupted reader acquisition (transaction=%s)",
  (transaction) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waits: number[] = [];
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const read = transaction ? sql.withTransaction(sql`SELECT 1`) : sql`SELECT 1`;
        const fiber = yield* Effect.forkChild(
          read.pipe(
            SqliteClient.readOnly,
            Effect.provideService(SqliteClient.ReaderWaitObserver, (ms) => waits.push(ms)),
          ),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        assert.equal(waits.length, 1);
        assert.isAbove(waits[0]!, 0);
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename: path.join(dir, "test.sqlite"),
            readerWorker: true,
            beforeAcquire: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
