import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";

import * as SqliteClient from "./nodeSqliteClient.ts";
import { makeReaderPool } from "./nodeSqliteReaderLanes.ts";

// Lets reader worker threads make progress; the test clock does not move them.
const realPause = (ms: number) =>
  // @effect-diagnostics-next-line globalTimers:off -- waits on real worker threads, not on fibers.
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

// CPU-bound read of a known length (about 80 ns a row).
const slowRead = (sql: SqlClient.SqlClient, rows: number) =>
  sql.unsafe<{ last: number }>(
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${rows}) SELECT max(x) AS last FROM c`,
  );

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`, (rows) => rows[0]?.count);

const now = () => performance.now();

const withLanes = <A, E>(
  config: Partial<SqliteClient.SqliteClientConfig>,
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-lanes-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename, readerWorker: true, authReaderProcess: true, ...config }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const foreground = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(SqliteClient.readOnly, SqliteClient.foregroundReads);
const background = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(SqliteClient.readOnly, SqliteClient.backgroundReads);

// Records the lane/slot each read used, from its span attributes.
const spanAttributes = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const spans: Array<Record<string, unknown>> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const attribute = span.attribute.bind(span);
        const record: Record<string, unknown> = { name: options.name };
        spans.push(record);
        span.attribute = (key, value) => {
          record[key] = value;
          attribute(key, value);
        };
        return span;
      },
    });
    yield* effect.pipe(
      Effect.withTracer(tracer),
      Effect.provideService(Statement.SpanPropagationEnabled, true),
    );
    return spans;
  });

it.effect(
  "a foreground read does not wait behind a long background read",
  () =>
    withLanes({ foregroundReaderSlots: 1 }, (sql) =>
      Effect.gen(function* () {
        yield* background(countEntries(sql));
        yield* foreground(countEntries(sql));
        const long = yield* Effect.forkChild(background(slowRead(sql, 25_000_000)));
        yield* realPause(100);
        const started = now();
        assert.equal(yield* foreground(countEntries(sql)), 1);
        const foregroundMs = now() - started;
        // The background read is still running when the foreground one returns.
        assert.isUndefined(long.pollUnsafe());
        assert.isBelow(foregroundMs, 500);
        yield* Fiber.join(long);
      }),
    ),
  30_000,
);

it.effect(
  "with no foreground slots, foreground reads share the default reader (rollback layout)",
  () =>
    withLanes({ foregroundReaderSlots: 0 }, (sql) =>
      Effect.gen(function* () {
        yield* background(countEntries(sql));
        const long = yield* Effect.forkChild(background(slowRead(sql, 12_000_000)));
        yield* realPause(100);
        yield* foreground(countEntries(sql));
        // It had to wait for the long read: the single-reader behaviour.
        assert.isDefined(long.pollUnsafe());
      }),
    ),
  30_000,
);

it.effect(
  "auth and untagged reads keep their lanes while a foreground pool is configured",
  () =>
    withLanes({ foregroundReaderSlots: 1 }, (sql) =>
      Effect.gen(function* () {
        yield* background(countEntries(sql));
        const long = yield* Effect.forkChild(foreground(slowRead(sql, 25_000_000)));
        yield* realPause(100);
        const started = now();
        // Auth has its own process; untagged reads use the background lane.
        assert.equal(yield* SqliteClient.authReadOnly(countEntries(sql)), 1);
        assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
        assert.isBelow(now() - started, 500);
        assert.isUndefined(long.pollUnsafe());
        yield* Fiber.join(long);
      }),
    ),
  30_000,
);

it.effect(
  "spans name the lane and slot, with wait and hold",
  () =>
    withLanes({ foregroundReaderSlots: 2 }, (sql) =>
      Effect.gen(function* () {
        const spans = yield* spanAttributes(
          Effect.all([
            foreground(countEntries(sql)),
            background(countEntries(sql)),
            foreground(sql.withTransaction(countEntries(sql))),
          ]).pipe(Effect.orDie),
        );
        const reads = spans.filter((span) => span["db.connection"] === "reader");
        const lanes = reads.map((span) => span["db.reader.lane"]);
        assert.include(lanes, "foreground");
        assert.include(lanes, "background");
        for (const span of reads) {
          assert.isNumber(span["db.lock_wait_ms"]);
          assert.isNumber(span["db.reader.slot"]);
        }
        assert.isTrue(reads.some((span) => typeof span["db.reader.hold_ms"] === "number"));
        const transaction = spans.find((span) => span.name === "sql.transaction");
        assert.equal(transaction?.["db.reader.lane"], "foreground");
        assert.isNumber(transaction?.["db.reader.hold_ms"]);
      }),
    ),
  30_000,
);

it.effect(
  "a foreground transaction pins one slot's snapshot while another slot serves new reads",
  () =>
    withLanes({ foregroundReaderSlots: 2 }, (sql) =>
      Effect.gen(function* () {
        yield* foreground(countEntries(sql));
        const inside = yield* Effect.forkChild(
          foreground(
            sql.withTransaction(
              Effect.gen(function* () {
                const before = yield* countEntries(sql);
                yield* realPause(300);
                const after = yield* countEntries(sql);
                return [before, after] as const;
              }),
            ),
          ),
        );
        yield* realPause(100);
        // The writer commits while the snapshot is open (WAL readers never block it).
        yield* sql`INSERT INTO entries VALUES ('second')`;
        // A new foreground read lands on the other slot and sees the commit at once.
        const started = now();
        assert.equal(yield* foreground(countEntries(sql)), 2);
        assert.isBelow(now() - started, 250);
        // The pinned transaction kept its snapshot for both statements.
        assert.deepStrictEqual(yield* Fiber.join(inside), [1, 1]);
      }),
    ),
  30_000,
);

it.effect(
  "reads see a commit made just before them on every lane (read-after-write)",
  () =>
    withLanes({ foregroundReaderSlots: 2 }, (sql) =>
      Effect.gen(function* () {
        for (let index = 0; index < 20; index++) {
          yield* sql`INSERT INTO entries VALUES ('row')`;
          const expected = index + 2;
          assert.equal(yield* foreground(countEntries(sql)), expected);
          assert.equal(yield* background(countEntries(sql)), expected);
          assert.equal(yield* SqliteClient.authReadOnly(countEntries(sql)), expected);
        }
      }),
    ),
  30_000,
);

it.effect(
  "writes and checkpoints progress while a long foreground snapshot is open",
  () =>
    withLanes({ foregroundReaderSlots: 1, checkpointWorker: true }, (sql) =>
      Effect.gen(function* () {
        yield* foreground(countEntries(sql));
        const snapshot = yield* Effect.forkChild(
          foreground(
            sql.withTransaction(
              Effect.andThen(countEntries(sql), Effect.andThen(realPause(1500), countEntries(sql))),
            ),
          ),
        );
        yield* realPause(100);
        const started = now();
        for (let index = 0; index < 200; index++) yield* sql`INSERT INTO entries VALUES ('w')`;
        const writeMs = now() - started;
        assert.isBelow(writeMs, 1000);
        assert.isUndefined(snapshot.pollUnsafe());
        assert.equal(yield* Fiber.join(snapshot), 1);
        // A passive checkpoint can run past the closed snapshot.
        const rows = yield* sql<{ busy: number }>`PRAGMA wal_checkpoint(PASSIVE)`;
        assert.equal(rows[0]?.busy, 0);
        assert.equal(yield* background(countEntries(sql)), 201);
      }),
    ),
  30_000,
);

it.effect(
  "an interrupted queued foreground read leaves the lane and never runs",
  () =>
    withLanes({ foregroundReaderSlots: 1, readerQueueLimits: { foreground: 2 } }, (sql) =>
      Effect.gen(function* () {
        yield* foreground(countEntries(sql));
        const long = yield* Effect.forkChild(foreground(slowRead(sql, 12_000_000)));
        yield* realPause(50);
        // A client that disconnects while its read is queued.
        const queued = yield* Effect.forkChild(foreground(slowRead(sql, 400_000_000)));
        yield* realPause(50);
        yield* Fiber.interrupt(queued);
        // Its slot in the bounded queue is free again: two more fit (one queued, one running).
        const next = yield* Effect.forkChild(foreground(countEntries(sql)));
        yield* Fiber.join(long);
        const started = now();
        assert.equal(yield* Fiber.join(next), 1);
        // Had the interrupted 30 s read run, this would have waited for it.
        assert.isBelow(now() - started, 1000);
      }),
    ),
  30_000,
);

it.effect(
  "a full lane fails new reads at once with an explicit overload error",
  () =>
    withLanes({ foregroundReaderSlots: 1, readerQueueLimits: { foreground: 2 } }, (sql) =>
      Effect.gen(function* () {
        yield* foreground(countEntries(sql));
        const fibers = yield* Effect.forEach([0, 1], () =>
          Effect.forkChild(foreground(slowRead(sql, 6_000_000))),
        );
        yield* realPause(50);
        const error = yield* foreground(countEntries(sql)).pipe(Effect.flip);
        assert.include(String(error.reason.message), "Reader lane admission queue full");
        // Other lanes are unaffected.
        assert.equal(yield* background(countEntries(sql)), 1);
        yield* Effect.forEach(fibers, Fiber.join);
        assert.equal(yield* foreground(countEntries(sql)), 1);
      }),
    ),
  30_000,
);

it.effect(
  "a result over the lane budget fails with an explicit error",
  () =>
    withLanes({ foregroundReaderSlots: 1, readerMaxResultBytes: { foreground: 4096 } }, (sql) =>
      Effect.gen(function* () {
        for (let index = 0; index < 100; index++) yield* sql`INSERT INTO entries VALUES ('padding-padding')`;
        const error = yield* foreground(sql`SELECT name FROM entries`).pipe(Effect.flip);
        assert.include(String(error.reason.cause), "Reader result exceeds 4096 bytes");
        // The background lane has no budget here and the slot still serves small reads.
        assert.lengthOf(yield* background(sql`SELECT name FROM entries`), 101);
        assert.equal(yield* foreground(countEntries(sql)), 101);
      }),
    ),
  30_000,
);

it.effect(
  "a foreground slot retired mid-statement fails the started read, moves unstarted ones, and keeps the other lanes",
  () =>
    withLanes({ foregroundReaderSlots: 1, readerStatementLimit: 1000 }, (sql) =>
      Effect.gen(function* () {
        yield* foreground(countEntries(sql));
        // Started on the slot's worker, then past the limit: the worker is retired.
        const overrunning = yield* Effect.forkChild(foreground(slowRead(sql, 400_000_000)).pipe(Effect.flip));
        yield* realPause(100);
        // Never started: moves once to the replacement worker.
        const waiting = yield* Effect.forkChild(foreground(countEntries(sql)));
        // A background read during the stall is unaffected.
        const started = now();
        assert.equal(yield* background(countEntries(sql)), 1);
        assert.isBelow(now() - started, 500);
        assert.include(String((yield* Fiber.join(overrunning)).reason.cause), "Database reader retired");
        assert.equal(yield* Fiber.join(waiting), 1);
      }),
    ),
  30_000,
);

it.effect(
  "a foreground transaction whose slot retires fails instead of continuing on a replacement",
  () =>
    withLanes({ foregroundReaderSlots: 1, readerStatementLimit: 1000 }, (sql) =>
      Effect.gen(function* () {
        yield* foreground(countEntries(sql));
        const exit = yield* foreground(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* countEntries(sql);
              yield* slowRead(sql, 400_000_000);
              return yield* countEntries(sql);
            }),
          ),
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "Database reader retired");
        assert.equal(yield* foreground(countEntries(sql)), 1);
      }),
    ),
  30_000,
);

it.effect("pool picks the least loaded slot and bounds in-flight reads", () =>
  Effect.gen(function* () {
    const connection = {} as never;
    const pool = yield* makeReaderPool({
      lane: "foreground",
      slots: [Effect.succeed(connection), Effect.succeed(connection)],
      queueLimit: 3,
    });
    const first = yield* pool.acquire;
    const hold = yield* Effect.forkChild(first!.lock.withPermits(1)(Effect.never));
    yield* Effect.yieldNow;
    const second = yield* pool.acquire;
    assert.notEqual(second!.slot, first!.slot);
    assert.equal(pool.inFlight(), 1);
    const queued = yield* Effect.forkChild(first!.lock.withPermits(1)(Effect.void));
    const other = yield* Effect.forkChild(second!.lock.withPermits(1)(Effect.never));
    yield* Effect.yieldNow;
    assert.equal(pool.inFlight(), 3);
    const refused = yield* second!.lock.withPermits(1)(Effect.void).pipe(Effect.flip);
    assert.include(String(refused.reason.message), "Reader lane admission queue full");
    yield* Fiber.interrupt(queued);
    assert.equal(pool.inFlight(), 2);
    yield* Fiber.interrupt(hold);
    yield* Fiber.interrupt(other);
    assert.equal(pool.inFlight(), 0);
  }),
);
