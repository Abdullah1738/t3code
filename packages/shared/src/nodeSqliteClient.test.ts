import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Scheduler from "effect/Scheduler";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const writerWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const checkpointOwners = vi.hoisted(
  () => new WeakMap<NodeWorkerThreads.Worker, NodeWorkerThreads.Worker>(),
);
const silentWorkers = vi.hoisted(() => ({ on: false, readyOnTerminate: false }));
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));
const gatedWorker = vi.hoisted(() => ({ state: undefined as Int32Array | undefined }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  const { EventEmitter } = await import("node:events");
  const sqlite = await import("node:sqlite");
  type BridgeMessage = {
    readonly testCheckpoint: true;
    readonly childId: number;
    readonly kind: "create" | "postMessage" | "emit" | "terminated";
    readonly args: unknown[];
  };
  class CheckpointProxy extends EventEmitter {
    threadId: number;
    readonly writer: NodeWorkerThreads.Worker;
    readonly childId: number;
    constructor(writer: NodeWorkerThreads.Worker, childId: number, threadId: number) {
      super();
      this.writer = writer;
      this.childId = childId;
      this.threadId = threadId;
      // Native Workers retain an error listener even when a test only awaits exit.
      this.on("error", () => {});
    }
    send(kind: string, args: unknown[] = []) {
      actual.Worker.prototype.postMessage.call(this.writer, {
        testCheckpoint: true,
        childId: this.childId,
        kind,
        args,
      });
    }
    postMessage(...args: Parameters<NodeWorkerThreads.Worker["postMessage"]>) {
      this.send("postMessage", args);
    }
    override emit(event: string | symbol, ...args: unknown[]) {
      this.send("emit", [event, ...args]);
      if (event === "exit") this.threadId = -1;
      return super.emit(event, ...args);
    }
    terminate() {
      if (this.threadId === -1) return Promise.resolve(0);
      const terminated = new Promise<number>((resolve) => this.once("terminated", resolve));
      this.send("terminate");
      return terminated;
    }
  }
  class RecordedWorker extends actual.Worker {
    readonly checkpoints = new Map<number, CheckpointProxy>();
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      const writer = args[1]?.workerData?.cancelled !== undefined;
      if (writer && typeof args[0] === "string") {
        // The checkpoint belongs to the writer's thread. Bridge its real events
        // through proxies so the race tests can still hold and release messages.
        args = [
          args[0]
            .replace(
              'const { parentPort, workerData, Worker } = require("node:worker_threads");',
              `
            const { parentPort, workerData, Worker: NativeWorker } = require("node:worker_threads");
            const children = new Map();
            let nextChild = 0;
            let nextPause;
            let metadataFailures = 0;
            let attachmentMetadataFailures = 0;
            let attachmentDeferralFailures = 0;
            let globalMmapFailures = 0;
            let timedSql;
            let virtualClock;
            const nativeNow = performance.now.bind(performance);
            Object.defineProperty(performance, "now", { value: () => virtualClock ?? nativeNow() });
            const pausedStatements = new Map();
            const sqlitePrototype = require("node:sqlite").DatabaseSync.prototype;
            const nativePrepare = sqlitePrototype.prepare;
            sqlitePrototype.prepare = function(sql, ...args) {
              if (virtualClock !== undefined) {
                if (sql === timedSql) virtualClock += 100;
                if (sql.startsWith("SELECT name AS name, type AS type, sql AS sql FROM ")) virtualClock += 5000;
              }
              if (globalMmapFailures > 0 && sql === "PRAGMA mmap_size") {
                globalMmapFailures--;
                throw new Error("test mmap default metadata failure");
              }
              if (attachmentDeferralFailures > 0 && sql === "PRAGMA defer_foreign_keys") {
                attachmentDeferralFailures--;
                throw new Error("test attachment deferral metadata failure");
              }
              if (attachmentMetadataFailures > 0 && sql === "PRAGMA database_list") {
                attachmentMetadataFailures--;
                throw new Error("test attachment metadata failure");
              }
              if (metadataFailures > 0 && sql.startsWith("SELECT name AS name, type AS type, sql AS sql FROM ")) {
                metadataFailures--;
                throw new Error("test metadata read failure");
              }
              return nativePrepare.call(this, sql, ...args);
            };
            const statementPrototype = require("node:sqlite").StatementSync.prototype;
            const nativeRun = statementPrototype.run;
            statementPrototype.run = function(...args) {
              if (virtualClock !== undefined && this.sourceSQL === timedSql) virtualClock += 25;
              return nativeRun.apply(this, args);
            };
            const post = parentPort.postMessage.bind(parentPort);
            const on = parentPort.on.bind(parentPort);
            on("message", message => {
              if (message?.cancel !== undefined) post({ testWriterCancel: message.cancel });
              if (!message?.testCheckpoint) return;
              if (message.kind === "arm") { nextPause = message.args[0]; return; }
              if (message.kind === "fail-metadata") { metadataFailures = message.args[0]; return; }
              if (message.kind === "fail-attachments") { attachmentMetadataFailures = message.args[0]; return; }
              if (message.kind === "fail-attachment-deferral") { attachmentDeferralFailures = message.args[0]; return; }
              if (message.kind === "fail-global-mmap") { globalMmapFailures = message.args[0]; return; }
              if (message.kind === "time-prepare") { timedSql = message.args[0]; virtualClock = 0; return; }
              if (message.kind === "resume") {
                pausedStatements.get(message.args[0])?.();
                pausedStatements.delete(message.args[0]);
                return;
              }
              if (message.kind === "barrier") {
                setImmediate(() => post({ testWriterBarrier: message.args[0] }));
                return;
              }
              const child = children.get(message.childId);
              if (!child) return;
              if (message.kind === "emit") NativeWorker.prototype.emit.call(child, ...message.args);
              if (message.kind === "postMessage") NativeWorker.prototype.postMessage.call(child, ...message.args);
              if (message.kind === "terminate") child.terminate().then(code => post({
                testCheckpoint: true, childId: message.childId, kind: "terminated", args: [code],
              }));
            });
            parentPort.on = (event, listener) => on(event,
              event === "message" ? message => { if (!message?.testCheckpoint) listener(message); } : listener);
            const pauseStatement = async (point, id, sql, params) => {
              if (nextPause?.point !== point || !sql.includes(nextPause.sql) ||
                (nextPause.value !== undefined && params[0] !== nextPause.value)) return;
              nextPause = undefined;
              await new Promise(resolve => {
                pausedStatements.set(id, resolve);
                post({ testWriterPaused: id });
              });
            };
            class Worker extends NativeWorker {
              constructor(source, options) {
                super(workerData.testSilent ? "setInterval(() => {}, 1 << 30);" :
                  workerData.testFailure === undefined ? source :
                    "throw new Error(" + JSON.stringify(workerData.testFailure) + ");", options);
                this.childId = ++nextChild;
                children.set(this.childId, this);
                post({ testCheckpoint: true, childId: this.childId, kind: "create", args: [this.threadId] });
              }
              postMessage(...args) {
                post({ testCheckpoint: true, childId: this.childId, kind: "postMessage", args });
              }
              emit(event, ...args) {
                if (["message", "error", "exit"].includes(event)) {
                  post({ testCheckpoint: true, childId: this.childId, kind: "emit", args: [event, ...args] });
                  // Native Worker exit cleanup removes its terminate() listener
                  // as soon as emit returns, so lifecycle events cannot be held.
                  if (event !== "message") return super.emit(event, ...args);
                  return true;
                }
                return super.emit(event, ...args);
              }
            }
            if (!workerData.testAuthorizer) Object.defineProperty(
              require("node:sqlite").DatabaseSync.prototype, "setAuthorizer", { value: undefined });
            `,
            )
            .replace(
              'if (isCancelled(id)) throw new Error("SQLite request cancelled before execution");\n    executionStarted = performance.now();\n    const entry = cached',
              'await pauseStatement("elected", id, sql, params);\n    if (isCancelled(id)) throw new Error("SQLite request cancelled before execution");\n    executionStarted = performance.now();\n    const entry = cached',
            )
            .replace(
              'if (isCancelled(id)) throw new Error("SQLite request cancelled before execution");\n    operation = "execute";',
              'await pauseStatement("resumed", id, sql, params);\n    if (isCancelled(id)) throw new Error("SQLite request cancelled before execution");\n    operation = "execute";',
            ),
          {
            ...args[1],
            workerData: {
              ...args[1]?.workerData,
              testSilent: silentWorkers.on,
              testFailure: failingWorkers.message,
              testAuthorizer: typeof sqlite.DatabaseSync.prototype.setAuthorizer === "function",
            },
          },
        ];
      }
      if (!writer && gatedWorker.state !== undefined && typeof args[0] === "string") {
        args = [
          `
          (() => {
            const { parentPort, workerData } = require("node:worker_threads");
            const gates = new Int32Array(workerData.testGates);
            const postMessage = parentPort.postMessage.bind(parentPort);
            parentPort.postMessage = (reply) => {
              postMessage(reply);
              if (!("started" in reply) || Atomics.load(gates, 0) === 0) return;
              const started = Atomics.add(gates, 1, 1) + 1;
              Atomics.notify(gates, 1);
              while (Atomics.load(gates, 2) < started) {
                Atomics.wait(gates, 2, started - 1);
              }
            };
          })();
          ${args[0]}`,
          {
            ...args[1],
            workerData: { ...args[1]?.workerData, testGates: gatedWorker.state.buffer },
          },
        ];
        gatedWorker.state = undefined;
      }
      super(
        ...((!writer && silentWorkers.on
          ? ["setInterval(() => {}, 1 << 30);", { eval: true }]
          : !writer && failingWorkers.message !== undefined
            ? [`throw new Error(${JSON.stringify(failingWorkers.message)});`, { eval: true }]
            : args) as ConstructorParameters<typeof actual.Worker>),
      );
      (writer ? writerWorkers : startedWorkers).push(this);
    }
    override emit(event: string | symbol, ...args: unknown[]) {
      const message = args[0];
      if (
        event === "message" &&
        message !== null &&
        typeof message === "object" &&
        "testWriterBarrier" in message
      ) {
        return super.emit("test-writer-barrier", message.testWriterBarrier);
      }
      if (
        event === "message" &&
        message !== null &&
        typeof message === "object" &&
        "testWriterPaused" in message
      ) {
        return super.emit("test-writer-paused", message.testWriterPaused);
      }
      if (
        event === "message" &&
        message !== null &&
        typeof message === "object" &&
        "testWriterCancel" in message
      ) {
        return super.emit("test-writer-cancel", message.testWriterCancel);
      }
      if (
        event === "message" &&
        message !== null &&
        typeof message === "object" &&
        "testCheckpoint" in message
      ) {
        const { childId, kind, args: values } = message as BridgeMessage;
        if (kind === "create") {
          const checkpoint = new CheckpointProxy(this, childId, Number(values[0]));
          this.checkpoints.set(childId, checkpoint);
          startedWorkers.push(checkpoint as unknown as NodeWorkerThreads.Worker);
          checkpointOwners.set(checkpoint as unknown as NodeWorkerThreads.Worker, this);
        } else {
          const checkpoint = this.checkpoints.get(childId)!;
          if (kind === "postMessage")
            checkpoint.postMessage(
              ...(values as Parameters<NodeWorkerThreads.Worker["postMessage"]>),
            );
          if (kind === "emit") {
            if (values[0] === "message") checkpoint.emit("message", ...values.slice(1));
            else {
              if (values[0] === "exit") checkpoint.threadId = -1;
              EventEmitter.prototype.emit.call(checkpoint, values[0] as string, ...values.slice(1));
            }
          }
          if (kind === "terminated")
            EventEmitter.prototype.emit.call(checkpoint, "terminated", ...values);
        }
        return true;
      }
      return super.emit(event, ...args);
    }
    override terminate() {
      // A "ready" already queued when termination starts reaches the parent before "exit".
      if (silentWorkers.readyOnTerminate) this.emit("message", { type: "ready" });
      return super.terminate();
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

let writerBarrierId = 0;
const flushWriterBridge = (worker = writerWorkers.at(-1)!) =>
  new Promise<void>((resolve) => {
    const id = ++writerBarrierId;
    const onBarrier = (reply: number) => {
      if (reply !== id) return;
      worker.off("test-writer-barrier", onBarrier);
      resolve();
    };
    worker.on("test-writer-barrier", onBarrier);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
    worker.postMessage({ testCheckpoint: true, kind: "barrier", args: [id] });
  });
const writerBridgeBarrier = (worker = writerWorkers.at(-1)!) =>
  Effect.promise(() => flushWriterBridge(worker));

const pauseWriterStatement = (
  worker: NodeWorkerThreads.Worker,
  point: "elected" | "resumed",
  sql: string,
  value?: number,
) => {
  let id: number | undefined;
  const ready = new Promise<void>((resolve) =>
    worker.once("test-writer-paused", (requestId: number) => {
      id = requestId;
      resolve();
    }),
  );
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
  worker.postMessage({ testCheckpoint: true, kind: "arm", args: [{ point, sql, value }] });
  return {
    ready,
    release() {
      if (id === undefined) return;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      worker.postMessage({ testCheckpoint: true, kind: "resume", args: [id] });
      id = undefined;
    },
  };
};

const writerWaiting = (worker: NodeWorkerThreads.Worker) =>
  new Promise<void>((resolve) => {
    const onMessage = (message: unknown) => {
      if (message === null || typeof message !== "object" || !("waiting" in message)) return;
      worker.off("message", onMessage);
      resolve();
    };
    worker.on("message", onMessage);
  });

const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

const walContractLayer = Layer.effect(
  SqlClient.SqlClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-contract-" });
    const context = yield* Layer.build(
      SqliteClient.layer({
        filename: path.join(directory, "state.sqlite"),
        readerWorker: true,
      }),
    );
    const sql = Context.get(context, SqlClient.SqlClient);
    yield* sql`PRAGMA journal_mode = WAL`;
    return sql;
  }),
).pipe(Layer.provide(NodeServices.layer));

for (const [name, clientLayer] of [
  ["NodeSqliteClient", SqliteClient.layer({ filename: ":memory:" })],
  ["NodeSqliteClient WAL worker", walContractLayer],
] as const) {
  const layer = it.layer(clientLayer);
  layer(name, (it) => {
    it.effect(
      "observes slow read/write metadata, including returning writes, without SQL or bindings",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const observed: SqliteClient.SqliteStatementObservation[] = [];
          const observer: SqliteClient.SqliteStatementObserver = {
            slowThresholdMs: 0,
            record: (entry) =>
              Effect.sync(() => {
                observed.push(entry);
              }),
          };
          yield* Effect.gen(function* () {
            yield* sql`CREATE TABLE observed_statements(secret TEXT UNIQUE)`;
            yield* sql`SELECT 1 AS result`;
            yield* sql`WITH seed AS (SELECT 'private binding' AS value) INSERT INTO observed_statements SELECT value FROM seed RETURNING secret`;
            yield* sql`INSERT INTO observed_statements VALUES ('private binding')`.pipe(
              Effect.exit,
            );
          }).pipe(
            Effect.provideService(SqliteClient.StatementObserver, observer),
            Effect.withSpan("ObservedService.query"),
          );
          assert.deepEqual(
            observed.map((entry) => [entry.operation, entry.connection, entry.outcome]),
            [
              ["write", "writer", "success"],
              ["read", "writer", "success"],
              ["write", "writer", "success"],
              ["write", "writer", "failure"],
            ],
          );
          assert.isTrue(
            observed.every((entry) => Number.isFinite(entry.durationMs) && entry.durationMs >= 0),
          );
          assert.isTrue(observed.every((entry) => entry.span === "ObservedService.query"));
          assert.isTrue(observed.every((entry) => entry.waitMs === undefined || entry.waitMs >= 0));
          assert.isFalse(JSON.stringify(observed).includes("private"));
          assert.isFalse(JSON.stringify(observed).includes("observed_statements"));
          yield* sql`SELECT 2`.pipe(
            Effect.provideService(SqliteClient.StatementObserver, {
              ...observer,
              slowThresholdMs: Number.MAX_SAFE_INTEGER,
            }),
          );
          assert.equal(observed.length, 4);
          assert.deepEqual(
            yield* sql`SELECT 3 AS result`.pipe(
              Effect.provideService(SqliteClient.StatementObserver, {
                slowThresholdMs: 0,
                record: () => Effect.die("observer defect"),
              }),
            ),
            [{ result: 3 }],
          );
        }),
    );

    it.effect(
      "observes only successful outer commits and keeps observer errors out of SQL results",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          let commits = 0;
          yield* sql`CREATE TABLE observed_commits(value TEXT)`;
          const observe = () => {
            commits += 1;
          };
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO observed_commits VALUES ('outer')`;
                yield* sql.withTransaction(sql`INSERT INTO observed_commits VALUES ('nested')`);
                assert.equal(commits, 0);
              }),
            )
            .pipe(Effect.provideService(SqliteClient.TransactionCommitObserver, observe));
          assert.equal(commits, 1);
          yield* sql
            .withTransaction(
              sql`INSERT INTO observed_commits VALUES ('rolled back')`.pipe(
                Effect.andThen(Effect.fail("rollback")),
              ),
            )
            .pipe(
              Effect.provideService(SqliteClient.TransactionCommitObserver, observe),
              Effect.result,
            );
          assert.equal(commits, 1);
          yield* sql
            .withTransaction(sql`INSERT INTO observed_commits VALUES ('observer throws')`)
            .pipe(
              Effect.provideService(SqliteClient.TransactionCommitObserver, () => {
                throw new Error("observer");
              }),
            );
          assert.deepEqual(yield* sql`SELECT value FROM observed_commits`, [
            { value: "outer" },
            { value: "nested" },
            { value: "observer throws" },
          ]);
        }),
    );
    it.effect("retries preparing a query after the missing schema becomes available", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
        const error = yield* select.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");

        yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
        yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
        assert.deepEqual(yield* select, [{ name: "recovered" }]);
        assert.deepEqual(yield* select.values, [["recovered"]]);
      }),
    );

    it.effect("runs prepared queries and returns positional values", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
        yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

        const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.name, "alpha");
        assert.equal(rows[1]?.name, "beta");

        const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
        assert.equal(values.length, 2);
        assert.equal(values[0]?.[1], "alpha");
        assert.equal(values[1]?.[1], "beta");

        const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
          .valuesUnprepared;
        assert.deepEqual(unpreparedValues, values);
      }),
    );

    it.effect("preserves raw results, blobs and safe integers across execution paths", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE raw_entries(id INTEGER PRIMARY KEY, payload BLOB)`;
        const payload = new Uint8Array([0, 127, 255]);
        const result = yield* sql`INSERT INTO raw_entries(payload) VALUES (${payload})`.raw;
        assert.include(result, { changes: 1, lastInsertRowid: 1 });
        assert.deepEqual(yield* sql`SELECT payload FROM raw_entries`.unprepared, [{ payload }]);
        for (const query of [
          sql`SELECT id, payload FROM raw_entries`.values,
          sql`SELECT id, payload FROM raw_entries`.valuesUnprepared,
        ]) {
          assert.deepEqual(yield* query.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
            [1n, payload],
          ]);
          assert.deepEqual(yield* query, [[1, payload]]);
        }
        assert.deepEqual(
          yield* sql`SELECT ${9007199254740993n} AS large`.pipe(
            Effect.provideService(SqlClient.SafeIntegers, true),
          ),
          [{ large: 9007199254740993n }],
        );
        for (const binding of [{ $value: "named" }, Object.assign(() => {}, { $value: "named" })]) {
          assert.deepEqual(yield* sql.unsafe("SELECT length($value) AS size", [binding]), [
            { size: 5 },
          ]);
        }
      }),
    );

    it.effect("rolls back a nested savepoint while allowing its outer transaction to commit", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE savepoints(value TEXT)`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO savepoints VALUES ('outer')`;
            yield* sql
              .withTransaction(
                sql`INSERT INTO savepoints VALUES ('nested')`.pipe(
                  Effect.andThen(Effect.fail("rollback nested")),
                ),
              )
              .pipe(Effect.ignore);
            assert.deepEqual(yield* sql`SELECT value FROM savepoints`, [{ value: "outer" }]);
          }),
        );
        assert.deepEqual(yield* sql`SELECT value FROM savepoints`, [{ value: "outer" }]);
      }),
    );

    it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
      }),
    );

    it.effect("classifies constraint failures by their SQLite result code", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
        yield* sql`INSERT INTO constrained VALUES ('taken')`;

        const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
        assert(duplicate.reason._tag === "UniqueViolation");
        assert.equal(duplicate.reason.constraint, "constrained.name");

        const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
        assert.equal(missing.reason._tag, "ConstraintError");
      }),
    );
  });
}

it.effect("observes worker-reader statements with their lane and no query content", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const observed: SqliteClient.SqliteStatementObservation[] = [];
      const rows = yield* sql`SELECT name FROM entries`.pipe(
        SqliteClient.readOnly,
        Effect.provideService(SqliteClient.StatementObserver, {
          slowThresholdMs: 0,
          record: (entry) =>
            Effect.sync(() => {
              observed.push(entry);
            }),
        }),
      );
      assert.deepEqual(rows, [{ name: "first" }]);
      assert.deepEqual(
        observed.map((entry) => [entry.operation, entry.connection, entry.lane]),
        [["read", "reader", "background"]],
      );
      assert.isFalse(JSON.stringify(observed).includes("entries"));
    }),
  ),
);

const largeText = "x".repeat(64 * 1024 + 1);

it.effect("keeps large text and blob parameters off cached statements", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statements: Array<NodeSqlite.StatementSync> = [];
    const all = NodeSqlite.StatementSync.prototype.all;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
          this: NodeSqlite.StatementSync,
          ...params
        ) {
          statements.push(this);
          return all.apply(this, params);
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );

    const small = "small";
    const queries = [
      (value: string | Uint8Array | ArrayBuffer) => sql`SELECT length(${value}) AS size`,
      (value: string | Uint8Array | ArrayBuffer) =>
        sql.unsafe("SELECT length($value) AS size", [{ $value: value }]),
      (value: string | Uint8Array | ArrayBuffer) =>
        sql.unsafe("SELECT length($value) AS callable", [
          Object.assign(() => {}, { $value: value }),
        ]),
    ];
    const cached = new Set<NodeSqlite.StatementSync>();
    const large = new Set<NodeSqlite.StatementSync>();
    const largeBlobs = [new Uint8Array(64 * 1024 + 1), new ArrayBuffer(64 * 1024 + 1)];
    for (const value of [small, largeText, ...largeBlobs, small]) {
      const expected = typeof value === "string" ? value.length : value.byteLength;
      for (const query of queries) {
        assert.deepEqual((yield* query(value)).map(Object.values), [[expected]]);
        assert.deepEqual(yield* query(value).values, [[expected]]);
        for (const statement of statements.splice(0)) {
          (value === small ? cached : large).add(statement);
        }
      }
    }

    assert.equal(cached.size, queries.length);
    assert.equal(large.size, queries.length * 6);
    assert.isTrue(cached.isDisjointFrom(large));
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("reads integers on the values path as the caller asked, cached or not", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const value of ["small", largeText]) {
      const values = sql`SELECT 1 AS id, length(${value}) AS size`.values;
      assert.deepEqual(yield* values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
        [1n, BigInt(value.length)],
      ]);
      assert.deepEqual(yield* values, [[1, value.length]]);
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("leaves a parameter it cannot measure for the statement to handle", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const detached = new DataView(new ArrayBuffer(8));
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    // What a detached view binds as varies by Node version; match the statement itself.
    const native = new NodeSqlite.DatabaseSync(":memory:");
    const expected = native.prepare("SELECT length(?) AS size").all(detached);
    native.close();
    assert.deepEqual(yield* sql`SELECT length(${detached}) AS size`, expected);

    const throwing = {
      get $value(): string {
        throw new Error("unreadable");
      },
    };
    const error = yield* sql.unsafe("SELECT length($value) AS size", [throwing]).pipe(Effect.flip);
    assert.equal(error.reason.operation, "execute");

    let reads = 0;
    const counting = {
      get $value(): number {
        return ++reads;
      },
    };
    assert.deepEqual(yield* sql.unsafe("SELECT $value AS value", [counting]), [{ value: 1 }]);
    assert.equal(reads, 1);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // With a deferred BEGIN this commit lands and the write below fails
          // with SQLITE_BUSY_SNAPSHOT, which no busy timeout can wait out.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("lets the writer commit while a read-only transaction is open", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            // Holding the writer lock here would deadlock this join.
            yield* Fiber.join(writer);
            const after = yield* countEntries(sql);
            return { before, after };
          }),
        )
        .pipe(SqliteClient.readOnly);

      assert.deepEqual(counts, { before: 1, after: 1 });
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
    }),
  ),
);

it.effect("rejects a write in a read-only transaction", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('blocked')`)
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps the reader read-only even if a statement turns query_only off", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`PRAGMA query_only = OFF`;
            yield* sql`INSERT INTO entries VALUES ('blocked')`;
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps read-only work inside a write transaction on the writer", () =>
  withReaderClient((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO entries VALUES ('uncommitted')`;
        const count = yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
        assert.equal(count, 2);
      }),
    ),
  ),
);

it.effect("labels SQL spans with their connection and how long they waited for its lock", () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return withReaderClient((sql) =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      yield* Deferred.await(held);
      const statement = yield* Effect.forkChild(sql`SELECT 1`, { startImmediately: true });
      const transaction = yield* Effect.forkChild(sql.withTransaction(countEntries(sql)), {
        startImmediately: true,
      });
      yield* TestClock.adjust("25 millis");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(statement);
      yield* Fiber.join(transaction);
      yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
    }),
  ).pipe(
    Effect.provideService(Statement.SpanPropagationEnabled, true),
    Effect.withTracer(tracer),
    Effect.map(() => {
      const labeled = spans
        .filter((span) => span.attributes.has("db.connection"))
        .map((span) => [
          span.name,
          span.attributes.get("db.connection"),
          span.attributes.get("db.lock_wait_ms"),
        ]);
      assert.deepStrictEqual(labeled.slice(3), [
        ["sql.transaction", "writer", 0],
        ["sqlite", "writer", 25],
        ["sql.transaction", "writer", 25],
        ["sql.transaction", "reader", 0],
      ]);
    }),
  );
});

it.effect.each([false, true])(
  "records reader permit wait even before acquisition (interrupted=%s)",
  (interrupted) =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const spans: Tracer.NativeSpan[] = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            const attribute = span.attribute.bind(span);
            span.attribute = (key, value) => {
              attribute(key, value);
              if (
                key === "db.reader.acquire_stage" &&
                value === "slot" &&
                span.attributes.get("db.reader.requested_lane") === "foreground"
              )
                Deferred.doneUnsafe(waiting, Effect.void);
            };
            return span;
          },
        });
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* sql
          .withTransaction(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(SqliteClient.readOnly, Effect.forkChild);
        yield* Deferred.await(held);
        const waiter = yield* sql
          .withTransaction(countEntries(sql))
          .pipe(
            SqliteClient.readOnly,
            SqliteClient.foregroundReads,
            Effect.provideService(Statement.SpanPropagationEnabled, true),
            Effect.withTracer(tracer),
            Effect.forkChild,
          );
        yield* Deferred.await(waiting);
        yield* TestClock.adjust("25 millis");
        if (interrupted) yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        if (!interrupted) assert.equal(yield* Fiber.join(waiter), 1);
        const span = spans.find((span) => span.name === "sql.transaction")!;
        assert.equal(span.attributes.get("db.reader.requested_lane"), "foreground");
        assert.equal(span.attributes.get("db.reader.effective_lane"), "background");
        assert.equal(span.attributes.get("db.reader.acquired"), !interrupted);
        assert.equal(span.attributes.get("db.reader.wait_ms"), 25);
        assert.equal(
          span.attributes.get("db.reader.wait_interrupted"),
          interrupted ? true : undefined,
        );
        assert.equal(
          span.attributes.get("db.reader.acquire_stage"),
          interrupted ? "slot" : "acquired",
        );
      }),
    ),
);

it.effect("labels only the span of the statement or transaction that took the lock", () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = sql.withTransaction(sql`SELECT 1`);
    yield* transaction;
    yield* sql.withTransaction(transaction);
    yield* sql`SELECT 2`.pipe(Effect.withTracerEnabled(false));
  }).pipe(
    Effect.withSpan("caller"),
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    Effect.provideService(Statement.SpanPropagationEnabled, true),
    Effect.withTracer(tracer),
    Effect.map(() => {
      assert.deepStrictEqual(
        spans
          .filter((span) => span.name === "caller" || span.name === "sql.transaction")
          .map((span) => [span.name, span.attributes.get("db.connection")]),
        [
          ["caller", undefined],
          ["sql.transaction", "writer"],
          ["sql.transaction", "writer"],
          ["sql.transaction", undefined],
        ],
      );
    }),
  );
});

it.effect.each(["statement", "transaction", "reservation"] as const)(
  "a second client's %s labels its own acquisition inside another client's transaction",
  (mode) =>
    Effect.gen(function* () {
      const a = Context.get(
        yield* Layer.build(
          SqliteClient.layer({ filename: ":memory:", spanAttributes: { "db.name": "a" } }),
        ),
        SqlClient.SqlClient,
      );
      const b = Context.get(
        yield* Layer.build(
          SqliteClient.layer({ filename: ":memory:", spanAttributes: { "db.name": "b" } }),
        ),
        SqlClient.SqlClient,
      );
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const read =
        mode === "statement"
          ? b`SELECT 1`
          : mode === "transaction"
            ? b.withTransaction(b`SELECT 1`)
            : Effect.scoped(
                Effect.flatMap(b.reserve, (connection) =>
                  connection.execute("SELECT 1", [], undefined),
                ),
              );
      yield* a
        .withTransaction(read.pipe(SqliteClient.readOnly))
        .pipe(
          Effect.withTracer(tracer),
          Effect.provideService(Statement.SpanPropagationEnabled, true),
        );
      const parent = spans.find(
        (span) => span.name === "sql.transaction" && span.attributes.get("db.name") === "a",
      );
      assert.equal(parent?.attributes.get("db.connection"), "writer");
      assert.isUndefined(parent?.attributes.get("db.reader.requested_lane"));
      if (mode !== "reservation") {
        const own = spans.find(
          (span) => span.attributes.get("db.name") === "b" && span.attributes.has("db.connection"),
        );
        assert.equal(own?.attributes.get("db.connection"), "writer");
        assert.isNumber(own?.attributes.get("db.lock_wait_ms"));
        assert.equal(own?.attributes.get("db.reader.requested_lane"), "background");
      }
    }).pipe(Effect.scoped),
);

it.effect("keeps identity reads read-only and preserves an enclosing writer transaction", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const startedBefore = startedWorkers.length;
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.identityReadOnly), 1);
      const error = yield* sql`INSERT INTO entries VALUES ('refused')`.pipe(
        SqliteClient.identityReadOnly,
        Effect.flip,
      );
      assert.equal(error._tag, "SqlError");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.identityReadOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO entries VALUES ('committed')`;
          assert.equal(yield* countEntries(sql).pipe(SqliteClient.identityReadOnly), 2);
        }),
      );
    }),
  ),
);

it.effect("keeps large parameters off the reader worker's cached statements", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const read = (value: string) =>
        sql<{ size: number }>`SELECT length(${value}) AS size`.pipe(
          Effect.map((rows) => rows[0]?.size),
        );
      yield* countEntries(sql).pipe(SqliteClient.readOnly);
      const worker = startedWorkers.at(-1)!;
      const cached: Array<boolean> = [];
      const postMessage = worker.postMessage;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(worker, "postMessage").mockImplementation(function (
            this: NodeWorkerThreads.Worker,
            message: { readonly cached: boolean },
          ) {
            cached.push(message.cached);
            return postMessage.call(this, message);
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );

      assert.equal(yield* read("small").pipe(SqliteClient.readOnly), 5);
      assert.equal(yield* read(largeText).pipe(SqliteClient.readOnly), largeText.length);
      assert.deepEqual(cached, [true, false]);
    }).pipe(Effect.scoped),
  ),
);

it.effect("fails a read-only transaction whose reader stops, then starts a new reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const startedBefore = startedWorkers.length;
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* countEntries(sql);
            yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
            return yield* countEntries(sql);
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "Database reader exited");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 2);
    }),
  ),
);

it.effect("uses the writer for read-only work on an in-memory database", () =>
  Effect.gen(function* () {
    const startedBefore = startedWorkers.length;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE memory_entries(name TEXT NOT NULL)`;
    yield* sql`INSERT INTO memory_entries VALUES ('kept')`;

    const rows = yield* sql
      .withTransaction(sql<{ name: string }>`SELECT name FROM memory_entries`)
      .pipe(SqliteClient.readOnly);

    assert.deepEqual(rows, [{ name: "kept" }]);
    assert.equal(startedWorkers.length, startedBefore);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", readerWorker: true }))),
);

it.effect("keeps a nested transaction inside a read-only transaction on the reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const outer = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            yield* Fiber.join(writer);
            const nested = yield* sql.withTransaction(countEntries(sql));
            return { outer, nested };
          }),
        )
        .pipe(SqliteClient.readOnly);

      assert.deepEqual(counts, { outer: 1, nested: 1 });
    }),
  ),
);

const withFileClient = <A, E>(
  setup: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem | Scope.Scope>,
  options: Omit<Partial<SqliteClient.SqliteClientConfig>, "filename"> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-off-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      return yield* setup(yield* SqlClient.SqlClient, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true, ...options })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("uses the writer when the reader cannot open the database", () =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      yield* (yield* FileSystem.FileSystem).remove(filename);
      const startedBefore = startedWorkers.length;

      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

it.effect("uses the writer for a database that is not in WAL mode", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      const startedBefore = startedWorkers.length;

      yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('on the writer')`)
        .pipe(SqliteClient.readOnly);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

const captureWarnings = () => {
  const warnings: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  return { warnings, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

const silently = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      silentWorkers.on = true;
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        silentWorkers.on = false;
        silentWorkers.readyOnTerminate = false;
      }),
  );

it.effect("turns the reader off when its worker never opens the database", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      const read = yield* silently(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust("10 seconds");
          return yield* Fiber.join(fiber);
        }),
      );

      assert.equal(read, 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.lengthOf(warnings, 1);
    }),
  ).pipe(Effect.provide(logs));
});

it.effect("lets a read be cancelled while its worker is still starting", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* silently(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          );
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(fiber);
        }),
      );

      const next = yield* Effect.forkChild(
        sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      assert.equal(yield* Fiber.join(next), 0);
    }),
  ),
);

it.effect.each(["cold", "warm", "stalled"])(
  "completes an interrupted shutdown finalizer's read with a %s reader",
  (state) => {
    const { warnings, layer: logs } = captureWarnings();
    return withReaderClient((sql) => {
      const shutdown = Effect.gen(function* () {
        const read = sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
        if (state === "warm") yield* read;
        const registered = yield* Deferred.make<void>();
        const finalizing = yield* Deferred.make<void>();
        let observed: number | undefined;
        const fiber = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(finalizing, undefined);
                observed = yield* read;
              }).pipe(Effect.orDie),
            );
            yield* Deferred.succeed(registered, undefined);
            return yield* Effect.never;
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(registered);
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Deferred.await(finalizing);
        if (state === "stalled") yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interrupted);

        assert.equal(observed, 1);
        assert.lengthOf(warnings, state === "stalled" ? 1 : 0);
      });
      return state === "stalled" ? silently(shutdown) : shutdown;
    }).pipe(Effect.provide(logs));
  },
);

it.effect("logs one warning when concurrent first reads find the reader unavailable", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* (yield* FileSystem.FileSystem).remove(filename);
      const startedBefore = startedWorkers.length;

      const counts = yield* Effect.all(
        [
          sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepEqual(counts, [0, 0]);
      assert.equal(startedWorkers.length, startedBefore + 1);
      assert.lengthOf(warnings, 1);
    }),
  ).pipe(Effect.provide(logs));
});

it.effect("does not hand out a worker that reports ready after another read timed it out", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      const read = () => sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
      const counts = yield* silently(
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(read());
          yield* Effect.yieldNow;
          yield* TestClock.adjust("5 seconds");
          const second = yield* Effect.forkChild(read());
          yield* Effect.yieldNow;
          silentWorkers.readyOnTerminate = true;
          yield* TestClock.adjust("5 seconds");
          return [yield* Fiber.join(first), yield* Fiber.join(second)];
        }),
      );

      assert.deepEqual(counts, [1, 1]);
    }),
  ),
);

const withCheckpointClient = <A, E>(
  use: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem | Scope.Scope>,
  options: {
    readonly readerWorker?: boolean;
    readonly checkpointWorkerStart?: Effect.Effect<void>;
    readonly errorObserver?: SqliteClient.SqliteClientConfig["errorObserver"];
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-checkpoint-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* writerBridgeBarrier();
      return yield* use(sql, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true, ...options })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const supportsNoopCheckpoint = (() => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  const version = String(db.prepare("SELECT sqlite_version() AS version").get()?.version);
  db.close();
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 51);
})();

const checkpointWorkerReply = (worker: NodeWorkerThreads.Worker) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        let replies = 0;
        const onReply = (reply: unknown) => {
          if (reply !== "barrier") return;
          // Flush controller deliveries and their resulting sends before the next
          // barrier, which otherwise could overtake a coalesced check in the bridge.
          void flushWriterBridge(checkpointOwners.get(worker)).then(() => {
            if (++replies < 2) {
              // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
              worker.postMessage("barrier");
            } else {
              worker.off("message", onReply);
              resolve();
            }
          });
        };
        worker.on("message", onReply);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        worker.postMessage("barrier");
      }),
  );

const waitForCheckpointMessage = (worker: NodeWorkerThreads.Worker, id: unknown) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "checkpoint" &&
        "id" in message &&
        message.id === id
      ) {
        worker.off("message", onMessage);
        resolve(message as Record<string, unknown>);
      }
    };
    worker.on("message", onMessage);
  });

const waitForTruncateCompletion = (worker: NodeWorkerThreads.Worker) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "checkpoint" &&
        "truncateId" in message &&
        typeof message.truncateId === "number"
      ) {
        worker.off("message", onMessage);
        resolve(message as Record<string, unknown>);
      }
    };
    worker.on("message", onMessage);
  });

const holdWorkerMessage = (worker: NodeWorkerThreads.Worker, type: string) => {
  const emit = worker.emit.bind(worker) as (
    eventName: string | symbol,
    ...args: unknown[]
  ) => boolean;
  let held: unknown;
  let resolve: (message: unknown) => void = () => {};
  const ready = new Promise<unknown>((done) => {
    resolve = done;
  });
  const spy = vi.spyOn(worker, "emit").mockImplementation((eventName, ...args) => {
    const message = args[0];
    if (
      eventName === "message" &&
      held === undefined &&
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === type
    ) {
      held = message;
      resolve(message);
      return true;
    }
    return emit(eventName, ...args);
  });
  return {
    ready,
    deliver() {
      spy.mockRestore();
      if (held !== undefined) emit("message", held);
    },
    release() {
      spy.mockRestore();
      if (held !== undefined) emit("message", held);
    },
  };
};

const holdWriterReply = (worker: NodeWorkerThreads.Worker, sql: RegExp) => {
  const send = worker.postMessage.bind(worker);
  const emit = worker.emit.bind(worker) as (event: string | symbol, ...args: unknown[]) => boolean;
  let id: number | undefined;
  let held: unknown;
  let resolve = (_reply: unknown) => {};
  const ready = new Promise<unknown>((done) => {
    resolve = done;
  });
  const sent = vi.spyOn(worker, "postMessage").mockImplementation((...args) => {
    const message = args[0] as { sql?: string; id?: number };
    if (id === undefined && typeof message.sql === "string" && sql.test(message.sql))
      id = message.id;
    send(...args);
  });
  const received = vi.spyOn(worker, "emit").mockImplementation((event, ...args) => {
    const reply = args[0];
    if (
      event === "message" &&
      id !== undefined &&
      reply !== null &&
      typeof reply === "object" &&
      "id" in reply &&
      reply.id === id
    ) {
      held = reply;
      resolve(reply);
      return true;
    }
    return emit(event, ...args);
  });
  const discard = () => {
    sent.mockRestore();
    received.mockRestore();
    held = undefined;
  };
  return {
    ready,
    discard,
    deliver() {
      const reply = held;
      discard();
      if (reply !== undefined) emit("message", reply);
    },
  };
};

const pauseCheckpointRequests = (worker: NodeWorkerThreads.Worker) => {
  const queued: Array<Parameters<typeof worker.postMessage>> = [];
  const send = worker.postMessage.bind(worker);
  const spy = vi.spyOn(worker, "postMessage").mockImplementation((...args) => {
    queued.push(args);
  });
  let restored = false;
  return {
    queued,
    sendNext() {
      const args = queued.shift();
      if (args !== undefined) send(...args);
      return args?.[0];
    },
    release() {
      if (restored) return;
      restored = true;
      spy.mockRestore();
      for (const args of queued.splice(0)) send(...args);
    },
  };
};

const blockCheckpointBehindReader = (
  sql: SqlClient.SqlClient,
  filename: string,
  worker: NodeWorkerThreads.Worker,
) =>
  Effect.gen(function* () {
    yield* sql.unsafe("PRAGMA journal_size_limit = 1").unprepared;
    yield* sql.unsafe("CREATE TABLE entries(value INTEGER PRIMARY KEY)").unprepared;
    yield* sql.unsafe("CREATE TABLE pages(payload BLOB)").unprepared;
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
      (database) => Effect.sync(() => database.close()),
    );
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS count FROM entries").get();

    const checkpointRequests = pauseCheckpointRequests(worker);
    yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
    yield* sql.unsafe(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
      INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
    `).unprepared;
    yield* writerBridgeBarrier();

    const request = checkpointRequests.queued[0]?.[0];
    assert(typeof request === "object" && request !== null && "id" in request);
    const blocked = waitForCheckpointMessage(worker, (request as { readonly id: unknown }).id);
    checkpointRequests.sendNext();
    const state = yield* Effect.promise(() => blocked);
    assert.isTrue(state.blocked as boolean);
    assert.isAbove(state.log as number, 0);
    return { reader, checkpointRequests };
  });

const readCheckpointState = (db: NodeSqlite.DatabaseSync) => {
  const state = db.prepare("PRAGMA wal_checkpoint(NOOP)").get();
  if (typeof state?.log !== "number" || typeof state.checkpointed !== "number") {
    throw new Error("SQLite returned invalid WAL checkpoint frame counts");
  }
  return { log: state.log, checkpointed: state.checkpointed };
};

it.effect("defers routine checkpoints during startup and drains pending WAL on activation", () =>
  Effect.gen(function* () {
    const activated = yield* Deferred.make<void>();
    yield* withCheckpointClient(
      (sql, filename) =>
        Effect.gen(function* () {
          const worker = startedWorkers.at(-1)!;
          const send = vi.spyOn(worker, "postMessage");
          yield* Effect.addFinalizer(() => Effect.sync(() => send.mockRestore()));
          yield* sql`CREATE TABLE pages(payload BLOB)`;
          yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
            INSERT INTO pages SELECT randomblob(4000) FROM n`;
          const holder = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
            (db) => Effect.sync(() => db.close()),
          );
          const pending = readCheckpointState(holder);
          holder.exec("BEGIN IMMEDIATE");
          assert.isAbove(pending.log - pending.checkpointed, 1000);
          assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [{ count: 1200 }]);
          assert.equal(send.mock.calls.length, 0);
          holder.exec("ROLLBACK");
          assert.deepEqual(readCheckpointState(holder), pending);
          const reply = waitForCheckpointMessage(worker, 1);
          yield* Deferred.succeed(activated, undefined);
          const result = yield* Effect.promise(() => reply);
          assert.equal(result.checkpointed, result.log);
          assert.deepEqual(readCheckpointState(holder), {
            log: result.log,
            checkpointed: result.log,
          });
        }),
      { checkpointWorkerStart: Deferred.await(activated) },
    );
  }),
);

it.effect("keeps WAL backpressure active before startup activation", () =>
  withCheckpointClient(
    (sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        const requests = pauseCheckpointRequests(worker);
        yield* Effect.addFinalizer(() => Effect.sync(requests.release));
        yield* sql`CREATE TABLE pages(payload BLOB)`;
        yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 11000)
          INSERT INTO pages SELECT randomblob(4000) FROM n`;
        const observer = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
          (db) => Effect.sync(() => db.close()),
        );
        assert.isAtLeast(readCheckpointState(observer).log, 10000);
        yield* writerBridgeBarrier();
        assert.isAbove(requests.queued.length, 0);
        const mutation = yield* sql`INSERT INTO pages VALUES ('after checkpoint')`.pipe(
          Effect.forkChild,
        );
        requests.release();
        yield* Fiber.join(mutation);
        yield* checkpointWorkerReply(worker);
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [{ count: 11001 }]);
        const state = readCheckpointState(observer);
        assert.isBelow(state.log - state.checkpointed, 1000);
      }),
    { checkpointWorkerStart: Effect.never },
  ),
);

it.effect("checkpoints the WAL on the worker instead of the writer", () =>
  withCheckpointClient((sql, filename) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const walSize = Effect.map(fs.stat(`${filename}-wal`), (info) => Number(info.size));
      const worker = startedWorkers.at(-1)!;
      const checkpointRequests = pauseCheckpointRequests(worker);
      yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
      const replies: unknown[] = [];
      const onReply = (reply: unknown) => replies.push(reply);
      worker.on("message", onReply);
      yield* Effect.addFinalizer(() => Effect.sync(() => worker.off("message", onReply)));
      const limit = 1024 * 1024;
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${limit}`);
      const autocheckpoint = yield* sql<{
        readonly wal_autocheckpoint: number;
      }>`PRAGMA wal_autocheckpoint`;
      assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 0);
      assert.deepEqual(yield* sql`PRAGMA synchronous`, [{ synchronous: 2 }]);

      // About 1200 frames, past the 1000 that start a checkpoint.
      yield* sql`CREATE TABLE pages(payload BLOB)`;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
        INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
      `;
      const pending = yield* sql<{
        readonly log: number;
        readonly checkpointed: number;
      }>`PRAGMA wal_checkpoint(NOOP)`;
      assert.isAbove(pending[0]!.log, 1000);
      assert.isBelow(pending[0]!.checkpointed, pending[0]!.log);
      yield* writerBridgeBarrier();
      const requests = checkpointRequests.queued.map(([request]) => request);
      checkpointRequests.release();
      yield* checkpointWorkerReply(worker);
      const wal = yield* sql<{
        readonly log: number;
        readonly checkpointed: number;
      }>`PRAGMA wal_checkpoint(NOOP)`;
      assert.isAtMost(wal[0]!.log - wal[0]!.checkpointed, 1000);

      assert.isAtMost(
        yield* walSize,
        limit,
        JSON.stringify({ requests, replies, limit: yield* sql`PRAGMA journal_size_limit` }),
      );
      yield* sql`INSERT INTO pages(payload) VALUES (x'00')`;
      assert.isAtMost(yield* walSize, limit);
    }),
  ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "answers checks received while the worker waits for truncation acknowledgement",
  () =>
    withCheckpointClient((sql) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        const send = worker.postMessage.bind(worker);
        const truncateRequest = holdWorkerMessage(worker, "truncate-request");
        yield* Effect.addFinalizer(() => Effect.sync(truncateRequest.release));
        const checkpointRequests = pauseCheckpointRequests(worker);
        yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
        const replies: Array<unknown> = [];
        const onMessage = (message: unknown) => replies.push(message);
        worker.on("message", onMessage);
        yield* Effect.addFinalizer(() => Effect.sync(() => worker.off("message", onMessage)));

        yield* sql.unsafe("PRAGMA journal_size_limit = 1").unprepared;
        yield* sql.unsafe("CREATE TABLE pages(payload BLOB)").unprepared;
        yield* sql.unsafe(`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
          INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
        `).unprepared;
        yield* writerBridgeBarrier();
        checkpointRequests.sendNext();
        const pending = yield* Effect.promise(() => truncateRequest.ready);
        assert(typeof pending === "object" && pending !== null && "generation" in pending);
        assert.equal(typeof pending.generation, "number");

        // Queue a newer check before allowing the main thread to acknowledge truncation.
        send({ type: "check", id: "during-truncate", generation: Number(pending.generation) + 1 });
        truncateRequest.deliver();
        checkpointRequests.release();
        yield* checkpointWorkerReply(worker);
        const reply = replies.find(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "id" in message &&
            message.id === "during-truncate",
        );
        assert.include(reply, {
          type: "checkpoint",
          id: "during-truncate",
          generation: pending.generation,
          blocked: true,
        });
        yield* sql.unsafe("INSERT INTO pages(payload) VALUES (x'00')").unprepared;
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [{ count: 1201 }]);
      }),
    ),
);

it.effect("hands checkpoints back to the writer when the worker stops", () =>
  withCheckpointClient((sql) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
      const autocheckpoint = yield* sql<{
        readonly wal_autocheckpoint: number;
      }>`PRAGMA wal_autocheckpoint`;
      assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 1000);
    }),
  ),
);

it.effect("warns once and hands checkpoints back when the worker fails at startup", () => {
  const { warnings, layer: logs } = captureWarnings();
  const reason = "SQLite 3.50.4 has no NOOP checkpoint";
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      failingWorkers.message = reason;
    }),
    () =>
      withCheckpointClient((sql) =>
        Effect.gen(function* () {
          const worker = startedWorkers.at(-1)!;
          if (worker.threadId !== -1) {
            yield* Effect.promise(() => new Promise((resolve) => worker.once("exit", resolve)));
          }
          const autocheckpoint = yield* sql<{
            readonly wal_autocheckpoint: number;
          }>`PRAGMA wal_autocheckpoint`;
          assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 1000);
          assert.deepEqual(warnings, [
            [
              "SQLite checkpoint worker unavailable; checkpoints run on the writer connection",
              { reason },
            ],
          ]);
        }),
      ),
    () =>
      Effect.sync(() => {
        failingWorkers.message = undefined;
      }),
  ).pipe(Effect.provide(logs));
});

it.effect("does not warn when the client stops its checkpoint worker", () => {
  const { warnings, layer: logs } = captureWarnings();
  return Effect.gen(function* () {
    yield* withCheckpointClient(() => Effect.void);
    assert.lengthOf(warnings, 0);
  }).pipe(Effect.provide(logs));
});
it.effect("finishes masked database cleanup after its caller is interrupted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE cleanup_writes(value INTEGER PRIMARY KEY)`;
    const entered = yield* Deferred.make<void>();
    const work = yield* Effect.forkChild(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO cleanup_writes VALUES (1)`;
            yield* sql.withTransaction(sql`INSERT INTO cleanup_writes VALUES (2)`);
          }),
        ),
      ),
      { startImmediately: true },
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(work);
    assert.deepEqual(yield* sql`SELECT value FROM cleanup_writes ORDER BY value`.values, [
      [1],
      [2],
    ]);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const eventLoopTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

it.effect("owns the reader until a standalone statement has finished", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      yield* countEntries(sql).pipe(SqliteClient.readOnly);
      const worker = startedWorkers.at(-1)!;
      const send = worker.postMessage.bind(worker);
      let pending: Parameters<typeof worker.postMessage> | undefined;
      let interleaved = false;
      let announce = () => {};
      const ready = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const spy = vi.spyOn(worker, "postMessage").mockImplementation((...args) => {
        if (pending === undefined) {
          pending = args;
          announce();
        } else {
          interleaved = true;
          send(...args);
        }
      });
      const release = () => {
        spy.mockRestore();
        if (pending !== undefined) send(...pending);
        pending = undefined;
      };
      yield* Effect.gen(function* () {
        const read = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
          startImmediately: true,
        });
        yield* Effect.promise(() => ready);
        const entered = yield* Deferred.make<void>();
        const transaction = yield* Effect.forkChild(
          sql.withTransaction(Deferred.succeed(entered, undefined)).pipe(SqliteClient.readOnly),
          { startImmediately: true },
        );
        // Let the competing acquisition run while the first request remains held.
        yield* eventLoopTurn;
        assert.isFalse(interleaved, "the transaction must wait for the standalone read");
        assert.isFalse(yield* Deferred.isDone(entered));
        release();
        assert.equal(yield* Fiber.join(read), 1);
        yield* Fiber.join(transaction);
        assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      }).pipe(Effect.ensuring(Effect.sync(release)));
    }),
  ),
);

it.effect.each([
  { reservation: false, masked: false },
  { reservation: false, masked: true },
  { reservation: true, masked: false },
  { reservation: true, masked: true },
])(
  "preserves caller cancellation while waiting (reservation=$reservation, masked=$masked)",
  ({ reservation, masked }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(value INTEGER)`;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(held);
      const entered = yield* Deferred.make<void>();
      const body = sql`INSERT INTO entries VALUES (1)`.pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
      );
      const acquire = reservation
        ? Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* sql.reserve;
              yield* connection.executeUnprepared("INSERT INTO entries VALUES (1)", [], undefined);
              yield* Deferred.succeed(entered, undefined);
            }),
          )
        : sql.withTransaction(body);
      const waiter = yield* Effect.forkChild(masked ? Effect.uninterruptible(acquire) : acquire, {
        startImmediately: true,
      });
      const cancelled = yield* Effect.forkChild(Fiber.interrupt(waiter), {
        startImmediately: true,
      });
      yield* Effect.gen(function* () {
        yield* eventLoopTurn;
        assert.equal(cancelled.pollUnsafe() !== undefined, !masked);
        assert.isFalse(yield* Deferred.isDone(entered));
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(holder);
      yield* Fiber.join(cancelled);
      assert.equal(yield* Deferred.isDone(entered), masked);
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES (2)`);
      assert.deepEqual(
        yield* sql`SELECT value FROM entries ORDER BY value`.values,
        masked ? [[1], [2]] : [[2]],
      );
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const openDatabase = (filename: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (db) => Effect.sync(() => db.close()),
  );

it.effect.each([false, true])(
  "bounds a busy truncate without gating a reset WAL (resetDuringHandoff=%s)",
  (resetDuringHandoff) =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const worker = startedWorkers.at(-1)!;
        const reader = yield* openDatabase(filename);
        const observer = yield* openDatabase(filename);
        const limit = 1024 * 1024;
        const requests = pauseCheckpointRequests(worker);
        yield* Effect.addFinalizer(() => Effect.sync(requests.release));
        const truncation = holdWorkerMessage(worker, "truncate-request");
        yield* Effect.addFinalizer(() => Effect.sync(truncation.release));
        yield* sql.unsafe(`PRAGMA journal_size_limit = ${limit}`).unprepared;
        yield* sql`CREATE TABLE pages(payload BLOB)`;
        yield* sql`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
          INSERT INTO pages(payload) SELECT zeroblob(4000) FROM n
        `;
        yield* writerBridgeBarrier();
        // Reading before PASSIVE pins the last WAL frame even when every frame is copied.
        reader.exec("BEGIN");
        assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count, 1200);
        requests.sendNext();
        yield* Effect.promise(() => truncation.ready);
        const copied = readCheckpointState(observer);
        assert.equal(copied.checkpointed, copied.log);
        assert.isAbove(copied.log, 1000);
        assert.isBelow(copied.log, 10_000);
        assert.isAbove(Number((yield* fs.stat(`${filename}-wal`)).size), limit);

        if (resetDuringHandoff) {
          // Another connection can reset the WAL before the main thread acknowledges truncation.
          reader.exec("ROLLBACK");
          assert.equal(observer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy, 0);
          observer.exec("INSERT INTO pages VALUES (x'01')");
          reader.exec("BEGIN");
          assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count, 1201);
          assert.isAbove(readCheckpointState(observer).log, 0);
          assert.isBelow(readCheckpointState(observer).log, 10_000);
          assert.isAtMost(Number((yield* fs.stat(`${filename}-wal`)).size), limit);
        }

        const completed = waitForTruncateCompletion(worker);
        requests.release();
        const started = performance.now();
        truncation.deliver();
        const write = yield* Effect.forkChild(sql`INSERT INTO pages VALUES (x'02')`, {
          startImmediately: true,
        });
        const reply = yield* Effect.promise(() => completed);
        const elapsed = performance.now() - started;
        assert.equal(reply.log, reply.checkpointed);
        if (resetDuringHandoff) {
          yield* Fiber.join(write);
          assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [{ count: 1202 }]);
          assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count, 1201);
        } else {
          yield* eventLoopTurn;
          assert.isUndefined(write.pollUnsafe(), "the physical size limit must still gate writes");
          assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count, 1200);
        }
        reader.exec("ROLLBACK");
        yield* checkpointWorkerReply(worker);
        yield* Fiber.join(write);
        yield* sql`INSERT INTO pages VALUES (x'03')`;
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [
          { count: resetDuringHandoff ? 1203 : 1202 },
        ]);
        assert.isAtMost(Number((yield* fs.stat(`${filename}-wal`)).size), limit);
        assert.equal(reply.blocked, !resetDuringHandoff);
        // Both implementations eventually reply; only a bound distinguishes SQLite's 5s busy wait.
        assert.isBelow(elapsed, 1000, "TRUNCATE must return promptly while the reader stays open");
      }),
    ),
  { skip: !supportsNoopCheckpoint, timeout: 15_000 },
);

it.effect.each(["statement", "commit", "rollback", "partial failure", "worker failure"] as const)(
  "bounds a real WAL backlog and resumes writes (%s)",
  (mode) =>
    withCheckpointClient(
      (sql, filename) =>
        Effect.gen(function* () {
          const worker = startedWorkers.at(-1)!;
          yield* sql`PRAGMA journal_size_limit = 1048576`;
          yield* sql`CREATE TABLE pages(id INTEGER PRIMARY KEY, payload BLOB)`;
          yield* sql`INSERT INTO pages VALUES (12001, x'00')`;
          yield* checkpointWorkerReply(worker);
          const reader = yield* openDatabase(filename);
          const observer = yield* openDatabase(filename);
          reader.exec("BEGIN");
          reader.prepare("SELECT COUNT(*) FROM pages").get();
          const requests = pauseCheckpointRequests(worker);
          yield* Effect.addFinalizer(() => Effect.sync(requests.release));
          const insert = sql.unsafe(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${mode === "partial failure" ? 12001 : 12000})
        INSERT OR FAIL INTO pages SELECT i, zeroblob(4000) FROM n ORDER BY i
      `).unprepared;
          if (mode === "commit" || mode === "rollback") {
            const result = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* insert;
                  // Admission must not prevent an active transaction from finishing.
                  yield* sql`INSERT INTO pages VALUES (12002, x'00')`;
                  assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [
                    { count: 12002 },
                  ]);
                  if (mode === "rollback") return yield* Effect.fail("rollback");
                }),
              )
              .pipe(Effect.exit);
            assert.equal(result._tag, mode === "rollback" ? "Failure" : "Success");
          } else if (mode === "partial failure") {
            const error = yield* insert.pipe(Effect.flip);
            assert.equal(error.reason._tag, "ConstraintError");
          } else yield* insert;

          if (mode !== "rollback") {
            assert.isAbove(
              readCheckpointState(observer).log - readCheckpointState(observer).checkpointed,
              10_000,
            );
          }
          const finished = yield* Deferred.make<void>();
          const write = yield* Effect.forkChild(
            sql`INSERT INTO pages VALUES (12003, x'00')`.pipe(
              Effect.andThen(Deferred.succeed(finished, undefined)),
            ),
            { startImmediately: true },
          );
          yield* eventLoopTurn;
          const expected = mode === "rollback" ? 1 : mode === "commit" ? 12002 : 12001;
          if (mode !== "rollback") {
            assert.isFalse(yield* Deferred.isDone(finished));
            const before = Number(
              (yield* (yield* FileSystem.FileSystem).stat(`${filename}-wal`)).size,
            );
            assert.deepEqual(
              yield* sql`SELECT COUNT(*) AS count FROM pages`.pipe(SqliteClient.readOnly),
              [{ count: expected }],
            );
            yield* eventLoopTurn;
            assert.isFalse(yield* Deferred.isDone(finished));
            assert.equal(
              Number((yield* (yield* FileSystem.FileSystem).stat(`${filename}-wal`)).size),
              before,
            );
          }
          if (mode === "worker failure") {
            yield* Effect.promise(() => worker.terminate());
            yield* Fiber.join(write);
            assert.deepEqual(yield* sql`PRAGMA wal_autocheckpoint`, [{ wal_autocheckpoint: 1000 }]);
            reader.exec("ROLLBACK");
          } else {
            reader.exec("ROLLBACK");
            requests.release();
            yield* Fiber.join(write);
            yield* checkpointWorkerReply(worker);
            if (mode !== "rollback")
              assert.isAtMost(
                Number((yield* (yield* FileSystem.FileSystem).stat(`${filename}-wal`)).size),
                1048576,
              );
          }
          assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [
            { count: expected + 1 },
          ]);
          yield* sql.withTransaction(sql`INSERT INTO pages VALUES (12004, x'00')`);
        }),
      { readerWorker: true },
    ),
  { skip: !supportsNoopCheckpoint },
);

it.effect.each([
  { reserved: false, stage: "queued" },
  { reserved: true, stage: "queued" },
  { reserved: false, stage: "elected" },
  { reserved: true, stage: "elected" },
  { reserved: false, stage: "resumed" },
  { reserved: true, stage: "resumed" },
] as const)(
  "hands cancellation to the next writer (reserved=$reserved, stage=$stage)",
  ({ reserved, stage }) =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        const { reader, checkpointRequests } = yield* blockCheckpointBehindReader(
          sql,
          filename,
          worker,
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = reserved ? yield* sql.reserve : undefined;
            const insert = (value: number) =>
              connection
                ? connection.executeUnprepared("INSERT INTO entries VALUES (?)", [value], undefined)
                : sql`INSERT INTO entries VALUES (${value})`;
            const writer = writerWorkers.at(-1)!;
            const pause =
              stage === "queued"
                ? undefined
                : pauseWriterStatement(writer, stage, "INSERT INTO entries", 1);
            if (pause) yield* Effect.addFinalizer(() => Effect.sync(pause.release));
            const waiting = stage === "elected" ? pause!.ready : writerWaiting(writer);
            const first = yield* Effect.forkChild(insert(1), { startImmediately: true });
            const second = yield* Effect.forkChild(insert(2), { startImmediately: true });
            yield* Effect.promise(() => waiting);
            assert.isUndefined(first.pollUnsafe());
            assert.isUndefined(second.pollUnsafe());
            if (stage !== "queued") {
              checkpointRequests.release();
              reader.exec("ROLLBACK");
              yield* checkpointWorkerReply(worker);
              yield* Effect.promise(() => pause!.ready);
            }
            const cancelled = new Promise<void>((resolve) =>
              writer.once("test-writer-cancel", () => resolve()),
            );
            const interrupted = yield* Effect.forkChild(Fiber.interrupt(first), {
              startImmediately: true,
            });
            yield* Effect.promise(() => cancelled);
            pause?.release();
            yield* Fiber.join(interrupted);
            if (stage === "queued") {
              reader.exec("ROLLBACK");
              checkpointRequests.release();
              yield* checkpointWorkerReply(worker);
            }
            yield* Fiber.join(second);
          }),
        );
        yield* sql.withTransaction(sql`INSERT INTO entries VALUES (3)`);
        assert.deepEqual(yield* sql`SELECT value FROM entries ORDER BY value`.values, [[2], [3]]);
      }),
    ),
  { skip: !supportsNoopCheckpoint },
);

it.effect.each([false, true])(
  "keeps masked cleanup waiting at the checkpoint gate (transaction=%s)",
  (transaction) =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        const { reader, checkpointRequests } = yield* blockCheckpointBehindReader(
          sql,
          filename,
          worker,
        );
        const entered = yield* Deferred.make<void>();
        const cleanupEntered = yield* Deferred.make<void>();
        const work = yield* Effect.forkChild(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(cleanupEntered, undefined);
                const insert = sql.unsafe("INSERT INTO entries VALUES (1)").unprepared;
                yield* transaction ? sql.withTransaction(insert) : insert;
              }),
            ),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(entered);
        const interrupt = yield* Effect.forkChild(Fiber.interrupt(work), {
          startImmediately: true,
        });
        yield* Deferred.await(cleanupEntered);
        yield* Effect.yieldNow;
        assert.isUndefined(work.pollUnsafe());

        const truncateFinished = waitForTruncateCompletion(worker);
        checkpointRequests.release();
        reader.exec("ROLLBACK");
        yield* Effect.promise(() => truncateFinished);
        yield* Fiber.join(interrupt);
        assert.deepEqual(yield* sql.unsafe("SELECT value FROM entries").unprepared, [{ value: 1 }]);
      }),
    ),
  { skip: !supportsNoopCheckpoint },
);

it.effect.each(["PRAGMA incremental_vacuum(1)", "PRAGMA user_version = 42"])(
  "admits maintenance mutations through the checkpoint gate (%s)",
  (operation) =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
        yield* sql`VACUUM`;
        yield* sql`CREATE TABLE reclaim(payload BLOB)`;
        yield* sql`INSERT INTO reclaim VALUES (zeroblob(8000000))`;
        yield* sql`DELETE FROM reclaim`;
        yield* checkpointWorkerReply(worker);
        const { reader, checkpointRequests } = yield* blockCheckpointBehindReader(
          sql,
          filename,
          worker,
        );
        const before = (yield* sql<{ freelist_count: number }>`PRAGMA freelist_count`)[0]!
          .freelist_count;
        assert.isAbove(before, 0);
        const mutation = yield* Effect.forkChild(sql.unsafe(operation).unprepared, {
          startImmediately: true,
        });
        yield* eventLoopTurn;
        assert.isUndefined(mutation.pollUnsafe());
        assert.equal(reader.prepare("PRAGMA user_version").get()?.user_version, 0);
        reader.exec("ROLLBACK");
        checkpointRequests.release();
        yield* Fiber.join(mutation);
        if (operation.includes("incremental_vacuum")) {
          assert.isBelow(
            (yield* sql<{ freelist_count: number }>`PRAGMA freelist_count`)[0]!.freelist_count,
            before,
          );
        } else assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 42 }]);
        yield* sql.withTransaction(sql`INSERT INTO entries VALUES (1)`);
      }),
    ),
  { skip: !supportsNoopCheckpoint },
);

it.effect("keeps automatic checkpoints when mutation classification is unavailable", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        NodeSqlite.DatabaseSync.prototype,
        "setAuthorizer",
      )!;
      Object.defineProperty(NodeSqlite.DatabaseSync.prototype, "setAuthorizer", {
        configurable: true,
        value: undefined,
      });
      return descriptor;
    }),
    () =>
      withCheckpointClient((sql) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* sql`PRAGMA wal_autocheckpoint`, [{ wal_autocheckpoint: 1000 }]);
          assert.deepEqual(yield* sql`PRAGMA synchronous`, [{ synchronous: 2 }]);
          yield* sql`CREATE TABLE fallback(value INTEGER)`;
          yield* sql.withTransaction(sql`INSERT INTO fallback VALUES (1)`);
          assert.deepEqual(yield* sql`SELECT value FROM fallback`, [{ value: 1 }]);
          const count = writerWorkers.length;
          yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
          const failed = yield* sql`SELECT value FROM fallback`.pipe(Effect.flip);
          assert.include(String(failed.reason.cause), "connection state could not be observed");
          assert.equal(writerWorkers.length, count);
        }),
      ),
    (descriptor) =>
      Effect.sync(() =>
        Object.defineProperty(NodeSqlite.DatabaseSync.prototype, "setAuthorizer", descriptor),
      ),
  ),
);

it.effect.each(["successful", "failed"] as const)(
  "lets the event loop run while draining queued writes (%s)",
  (outcome) =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        const { reader, checkpointRequests } = yield* blockCheckpointBehindReader(
          sql,
          filename,
          worker,
        );
        let completed = 0;
        let resolveHeartbeat = (_completed: number) => {};
        const heartbeat = new Promise<number>((resolve) => {
          resolveHeartbeat = resolve;
        });
        const scheduler = new Scheduler.MixedScheduler("async", (task) => {
          const handle = setImmediate(task);
          return () => clearImmediate(handle);
        });
        const writeScheduler: Scheduler.Scheduler = {
          executionMode: scheduler.executionMode,
          makeDispatcher: () => scheduler.makeDispatcher(),
          shouldYield: () => false,
        };
        const writes = [];
        for (let value = 0; value < 20; value++) {
          writes.push(
            yield* Effect.forkChild(
              sql`INSERT INTO entries VALUES (${outcome === "failed" ? "invalid" : value})`.pipe(
                Effect.match({
                  onSuccess: () => assert.equal(outcome, "successful"),
                  onFailure: (error) => {
                    assert.equal(outcome, "failed");
                    assert.equal(error._tag, "SqlError");
                    assert.equal(error.reason.operation, "execute");
                    assert.include(String(error.reason.cause), "datatype mismatch");
                  },
                }),
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (++completed === 1) setImmediate(() => resolveHeartbeat(completed));
                  }),
                ),
                Effect.provideService(Scheduler.Scheduler, writeScheduler),
              ),
              { startImmediately: true },
            ),
          );
        }
        yield* eventLoopTurn;
        assert.equal(completed, 0);
        reader.exec("ROLLBACK");
        checkpointRequests.release();
        const completedAtHeartbeat = yield* Effect.promise(() => heartbeat);
        for (const write of writes) yield* Fiber.join(write);
        assert.equal(completed, writes.length);
        assert.deepEqual(
          yield* sql`SELECT value FROM entries ORDER BY value`,
          outcome === "failed"
            ? []
            : Array.from({ length: writes.length }, (_, value) => ({ value })),
        );
        assert.isBelow(completedAtHeartbeat, writes.length);
      }),
    ),
  { skip: !supportsNoopCheckpoint },
);

// Lets the reader worker's own thread make progress; the test clock does not move it.
const realPause = (ms: number) =>
  // @effect-diagnostics-next-line globalTimers:off -- waits on a real worker thread, not on fibers.
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

// CPU-bound reads of a known length: about 80 ns a row in SQLite.
const slowRead = (sql: SqlClient.SqlClient, rows: number) =>
  sql.unsafe<{ last: number }>(
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${rows}) SELECT max(x) AS last FROM c`,
  );

const withWatchedReader = <A, E>(
  options: { readonly slow: number; readonly limit: number },
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
  logger?: Layer.Layer<never>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-watchdog-" });
    const filename = path.join(directory, "state.sqlite");
    const client = SqliteClient.layer({
      filename,
      readerWorker: true,
      readerSlowStatement: options.slow,
      readerStatementLimit: options.limit,
    });
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(Effect.provide(logger === undefined ? client : Layer.provide(client, logger)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "retires a reader stuck on one statement so later reads use a fresh worker",
  () => {
    const { warnings, layer: logger } = captureWarnings();
    return withWatchedReader(
      { slow: 300, limit: 1500 },
      (sql) =>
        Effect.gen(function* () {
          yield* countEntries(sql).pipe(SqliteClient.readOnly);
          const startedBefore = startedWorkers.length;
          // About 30 s of work, far past the 1.5 s limit.
          const stuck = yield* Effect.forkChild(
            slowRead(sql, 400_000_000).pipe(SqliteClient.readOnly, Effect.flip),
          );
          yield* realPause(100);
          const queued = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly));
          const stuckError = yield* Fiber.join(stuck);
          assert.include(String(stuckError.reason.cause), "Database reader retired");
          // The queued read never ran on the retired worker, so it ran on the new one.
          assert.equal(yield* Fiber.join(queued), 1);
          // Later reads use the new worker instead of waiting for the old one.
          assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
          assert.equal(startedWorkers.length, startedBefore + 1);
          const slow = warnings.find((warning) =>
            JSON.stringify(warning).includes("SQLite reader statement is slow"),
          );
          // The warning names the statement, so a stall can be traced to its query.
          assert.include(JSON.stringify(slow), "WITH RECURSIVE c(x)");
        }),
      logger,
    );
  },
  20_000,
);

it.effect(
  "skips a queued read whose caller gave up before the worker reached it",
  () =>
    withWatchedReader({ slow: 60_000, limit: 120_000 }, (sql) =>
      Effect.gen(function* () {
        yield* countEntries(sql).pipe(SqliteClient.readOnly);
        // About 1 s, then a queued read of about 30 s that is abandoned.
        const first = yield* Effect.forkChild(
          slowRead(sql, 12_000_000).pipe(SqliteClient.readOnly),
        );
        yield* realPause(100);
        const abandoned = yield* Effect.forkChild(
          slowRead(sql, 400_000_000).pipe(SqliteClient.readOnly),
        );
        yield* realPause(100);
        yield* Fiber.interrupt(abandoned);
        assert.equal((yield* Fiber.join(first))[0]?.last, 12_000_000);
        // Had the worker run the abandoned read, this would wait about 30 s.
        // @effect-diagnostics-next-line globalDateInEffect:off -- measures real time spent in the worker thread.
        const started = Date.now();
        assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
        // @effect-diagnostics-next-line globalDateInEffect:off -- measures real time spent in the worker thread.
        assert.isBelow(Date.now() - started, 5_000);
      }),
    ),
  20_000,
);

it.effect(
  "fails only the overrunning read when its reader retires, and runs queued reads in order on the new worker",
  () =>
    withWatchedReader({ slow: 60_000, limit: 1500 }, (sql) =>
      Effect.gen(function* () {
        yield* countEntries(sql).pipe(SqliteClient.readOnly);
        const startedBefore = startedWorkers.length;
        const stuck = yield* Effect.forkChild(
          slowRead(sql, 400_000_000).pipe(SqliteClient.readOnly, Effect.flip),
        );
        yield* realPause(100);
        // Each of these resolves the busy worker, then waits for the reader lock.
        const finished: Array<number> = [];
        const queued: Array<Fiber.Fiber<number | undefined, SqlError.SqlError>> = [];
        for (let index = 0; index < 12; index++) {
          const read =
            index % 4 === 3
              ? // A read-only transaction that never began on the old worker moves too.
                sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly)
              : countEntries(sql).pipe(SqliteClient.readOnly);
          queued.push(
            yield* Effect.forkChild(
              read.pipe(Effect.tap(() => Effect.sync(() => finished.push(index)))),
            ),
          );
          yield* realPause(5);
        }
        // A caller that gives up while queued still ends at its own deadline.
        const abandoned = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly));
        yield* realPause(5);
        yield* Fiber.interrupt(abandoned);

        const stuckError = yield* Fiber.join(stuck);
        assert.include(String(stuckError.reason.cause), "Database reader retired");
        for (const fiber of queued) assert.equal(yield* Fiber.join(fiber), 1);
        assert.deepEqual(
          finished,
          Array.from({ length: 12 }, (_, index) => index),
        );
        // One replacement served every queued read.
        assert.equal(startedWorkers.length, startedBefore + 1);
      }),
    ),
  20_000,
);

it.effect(
  "moves a read the worker had queued behind an abandoned overrunning read",
  () =>
    withWatchedReader({ slow: 60_000, limit: 1500 }, (sql) =>
      Effect.gen(function* () {
        yield* countEntries(sql).pipe(SqliteClient.readOnly);
        const startedBefore = startedWorkers.length;
        // The caller gives up, which frees the lock, but the worker keeps running it.
        const overrunning = yield* Effect.forkChild(
          slowRead(sql, 400_000_000).pipe(SqliteClient.readOnly),
        );
        yield* realPause(100);
        yield* Fiber.interrupt(overrunning);
        // Posted to the worker, which has not reached it when the limit retires it.
        assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
        assert.equal(startedWorkers.length, startedBefore + 1);
      }),
    ),
  20_000,
);

it.effect(
  "does not replay a read the worker started while the parent was too busy to hear about it",
  () => {
    const gates = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
    gatedWorker.state = gates;
    // Only the parent's watchdog clock moves; worker progress uses the atomic gates.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    return withWatchedReader({ slow: 60_000, limit: 1500 }, (sql) =>
      Effect.gen(function* () {
        yield* countEntries(sql).pipe(SqliteClient.readOnly);
        const startedBefore = startedWorkers.length;
        const worker = startedWorkers.at(-1)!;
        const firstStarted = new Promise<{ started: number }>((resolve) =>
          worker.once("message", resolve),
        );
        Atomics.store(gates, 0, 1);
        const first = yield* Effect.forkChild(sql`SELECT 1`.pipe(SqliteClient.readOnly));
        // The parent knows read 1 started, but the worker cannot finish it yet.
        const firstMessage = yield* Effect.promise(() => firstStarted);
        assert.property(firstMessage, "started");
        assert.notEqual(Atomics.wait(gates, 1, 0, 10_000), "timed-out");
        assert.equal(Atomics.load(gates, 1), 1);
        yield* Fiber.interrupt(first);
        const postMessage = worker.postMessage.bind(worker);
        const secondPosted = new Promise<void>((resolve) => {
          vi.spyOn(worker, "postMessage").mockImplementationOnce((...args) => {
            postMessage(...args);
            resolve();
          });
        });
        const second = yield* Effect.forkChild(
          sql`SELECT 2`.pipe(SqliteClient.readOnly, Effect.flip),
        );
        yield* Effect.promise(() => secondPosted);
        // Stay on this stack until read 2 is claimed and the watchdog fires.
        // The parent cannot process read 1's result or read 2's started message.
        yield* Effect.sync(() => {
          Atomics.store(gates, 2, 1);
          Atomics.notify(gates, 2);
          while (Atomics.load(gates, 1) < 2) {
            assert.notEqual(Atomics.wait(gates, 1, 1, 10_000), "timed-out");
          }
          assert.equal(Atomics.load(gates, 1), 2);
          vi.advanceTimersByTime(2_000);
        });
        assert.include(String((yield* Fiber.join(second)).reason.cause), "Database reader retired");
        // Had the second read moved, a replacement would have run it too.
        assert.equal(startedWorkers.length, startedBefore);
        assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
        assert.equal(startedWorkers.length, startedBefore + 1);
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          gatedWorker.state = undefined;
          vi.useRealTimers();
        }),
      ),
    );
  },
  20_000,
);

it.effect(
  "fails a transaction's queued read when its reader retires instead of replaying it",
  () =>
    withWatchedReader({ slow: 60_000, limit: 1500 }, (sql) =>
      Effect.gen(function* () {
        yield* countEntries(sql).pipe(SqliteClient.readOnly);
        const startedBefore = startedWorkers.length;
        const error = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              assert.equal(yield* countEntries(sql), 1);
              // Inside the transaction both statements go straight to its worker.
              const overrunning = yield* Effect.forkChild(
                slowRead(sql, 400_000_000).pipe(Effect.flip),
              );
              yield* realPause(100);
              const queued = yield* countEntries(sql).pipe(Effect.flip);
              yield* Fiber.join(overrunning);
              return queued;
            }),
          )
          .pipe(SqliteClient.readOnly);
        assert.include(String(error.reason.cause), "Database reader retired");
        // Nothing from the transaction ran on a replacement.
        assert.equal(startedWorkers.length, startedBefore);
        assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
        assert.equal(startedWorkers.length, startedBefore + 1);
      }),
    ),
  20_000,
);

it.effect("stops moving queued reads and respawning readers when they keep stopping", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const outcomes: Array<string> = [];
      const workers: Array<number> = [];
      for (let round = 0; round < 6; round++) {
        workers.push(startedWorkers.length);
        const holding = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const transaction = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* countEntries(sql);
              yield* Deferred.succeed(holding, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(SqliteClient.readOnly, Effect.forkChild);
        yield* Deferred.await(holding);
        // Resolves the transaction's worker, then waits for the reader lock.
        const queued = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly));
        yield* realPause(20);
        yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(transaction);
        const exit = yield* Fiber.await(queued);
        outcomes.push(exit._tag);
      }
      // Four stops a minute may move reads; the fifth read that never ran fails.
      assert.deepEqual(outcomes, [
        "Success",
        "Success",
        "Success",
        "Success",
        "Failure",
        "Success",
      ]);
      // Each move started one replacement; after the fifth stop no worker
      // starts, and reads use the main connection instead.
      assert.deepEqual(
        workers.map((count) => count - workers[0]!),
        [0, 2, 3, 4, 5, 5],
      );
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length - workers[0]!, 5);
    }),
  ),
);

it.effect("marks committed writes separately from reads and rolled back writes", () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const attribute = span.attribute.bind(span);
      span.attribute = (key, value) => {
        if (key === "db.commit.boundary") throw new Error("exporter failure");
        attribute(key, value);
      };
      spans.push(span);
      return span;
    },
  });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE commits(value TEXT)`;
    yield* sql`INSERT INTO commits VALUES ('committed')`;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO commits VALUES ('rolled back')`;
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.ignore);
    yield* sql`SELECT * FROM commits`;
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename: ":memory:", statementMetrics: true })),
    Effect.provideService(Statement.SpanPropagationEnabled, true),
    Effect.withTracer(tracer),
    Effect.map(() => {
      const commits = spans.filter((span) => span.attributes.has("db.commit.at_ms"));
      assert.equal(commits.length, 1);
      assert.isNumber(commits[0]!.attributes.get("db.commit.at_ms"));
    }),
  );
});

it.effect("keeps statement metrics opt-in with explicit configuration taking precedence", () =>
  Effect.gen(function* () {
    for (const [option, env, expected] of [
      [undefined, {}, false],
      [undefined, { ROBOB_SQL_STATEMENT_METRICS: "true" }, true],
      [false, { ROBOB_SQL_STATEMENT_METRICS: "true" }, false],
      [true, {}, true],
    ] as const) {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE metrics(value TEXT)`;
        yield* sql`INSERT INTO metrics VALUES ('committed')`;
        assert.deepEqual(yield* sql`SELECT * FROM metrics`, [{ value: "committed" }]);
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:", statementMetrics: option })),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.withTracer(tracer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      );
      assert.equal(
        spans.some((span) => span.attributes.has("db.commit.at_ms")),
        expected,
      );
      assert.equal(
        spans.some((span) => span.attributes.has("db.rows_returned")),
        expected,
      );
    }
  }),
);

it.effect(
  "keeps memory databases on their local connection with both worker options enabled",
  () => {
    const readersBefore = startedWorkers.length;
    const writersBefore = writerWorkers.length;
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TEMP TABLE memory_state(value INTEGER)`;
      yield* sql.withTransaction(sql`INSERT INTO memory_state VALUES (1)`);
      assert.deepEqual(yield* sql`SELECT value FROM memory_state`.pipe(SqliteClient.readOnly), [
        { value: 1 },
      ]);
      assert.deepEqual(yield* sql`PRAGMA journal_mode`, [{ journal_mode: "memory" }]);
      assert.equal(startedWorkers.length, readersBefore);
      assert.equal(writerWorkers.length, writersBefore);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename: ":memory:", readerWorker: true, checkpointWorker: true }),
      ),
    );
  },
);

it.effect(
  "keeps worker statement metrics opt-in with explicit configuration taking precedence",
  () =>
    Effect.gen(function* () {
      for (const [option, env, expected] of [
        [undefined, {}, false],
        [undefined, { ROBOB_SQL_STATEMENT_METRICS: "true" }, true],
        [false, { ROBOB_SQL_STATEMENT_METRICS: "true" }, false],
        [true, {}, true],
      ] as const) {
        const spans: Array<Tracer.NativeSpan> = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        yield* withFileClient(
          (sql) =>
            Effect.gen(function* () {
              yield* sql`PRAGMA journal_mode=WAL`;
              yield* sql`CREATE TABLE metrics(value INTEGER)`;
              yield* sql`INSERT INTO metrics VALUES (1)`;
              assert.deepEqual(yield* sql`SELECT value FROM metrics`, [{ value: 1 }]);
            }),
          { statementMetrics: option },
        ).pipe(
          Effect.provideService(Statement.SpanPropagationEnabled, true),
          Effect.withTracer(tracer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        );
        assert.equal(
          spans.some((span) => span.attributes.has("db.commit.at_ms")),
          expected,
        );
        assert.equal(
          spans.some((span) => span.attributes.has("db.rows_returned")),
          expected,
        );
      }
    }),
);

it.effect.each(["success", "prepare error"] as const)(
  "measures worker preparation and execution without recovery bookkeeping (%s)",
  (outcome) => {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const statement =
      outcome === "success"
        ? "CREATE TEMP TABLE timed_metadata(value INTEGER)"
        : "SELECT missing_timed_column FROM sqlite_schema";
    return withFileClient(
      (sql) =>
        Effect.gen(function* () {
          const writer = writerWorkers.at(-1)!;
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          writer.postMessage({ testCheckpoint: true, kind: "time-prepare", args: [statement] });
          yield* writerBridgeBarrier(writer);
          const execute = sql.unsafe(statement).unprepared;
          if (outcome === "prepare error") {
            const error = yield* execute.pipe(Effect.flip, Effect.orDie);
            assert.equal(error.reason.operation, "prepare");
          } else {
            yield* execute;
          }
          const span = spans.find((entry) => entry.attributes.get("db.query.text") === statement);
          assert.isDefined(span);
          assert.equal(
            span!.attributes.get("db.statement.execution_ms"),
            outcome === "success" ? 125 : 100,
          );
        }),
      { readerWorker: false },
    ).pipe(
      Effect.provideService(Statement.SpanPropagationEnabled, true),
      Effect.withTracer(tracer),
    );
  },
);

it.effect("starts an ordinary file in a writer worker before WAL is enabled", () => {
  const writersBefore = writerWorkers.length;
  return withFileClient(
    (sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE local_state(value INTEGER)`;
        yield* sql.withTransaction(sql`INSERT INTO local_state VALUES (1)`);
        assert.deepEqual(yield* sql`SELECT value FROM local_state`, [{ value: 1 }]);
        assert.deepEqual(yield* sql`PRAGMA journal_mode`, [{ journal_mode: "delete" }]);
        assert.equal(writerWorkers.length, writersBefore + 1);
      }),
    { readerWorker: false },
  );
});

const walActivationStatements = [
  "PRAGMA journal_mode=WAL",
  "PRAGMA main.journal_mode='wal'",
  'PRAGMA "main"."journal_mode"(\'wal\')',
  "/* enable WAL */ PRAGMA journal_mode = WAL",
] as const;

it.effect.each(walActivationStatements)(
  "preserves a plain file's writer connection when WAL is enabled (%s)",
  (pragma) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-plain-wal-" });
      const filename = path.join(directory, "state.sqlite");
      const archivePath = path.join(directory, "archive.sqlite");
      const archive = yield* openDatabase(archivePath);
      archive.exec("CREATE TABLE entries(value INTEGER); INSERT INTO entries VALUES (2)");
      const count = writerWorkers.length;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE entries(value INTEGER)`;
        yield* sql`INSERT INTO entries VALUES (1)`;
        yield* sql`PRAGMA foreign_keys=ON`;
        yield* sql`PRAGMA busy_timeout=1234`;
        yield* sql`ATTACH DATABASE ${archivePath} AS archive`;
        yield* sql`CREATE TEMP TABLE local_buffer(value INTEGER)`;
        yield* sql`INSERT INTO temp.local_buffer VALUES (7)`;
        yield* sql`CREATE TEMP VIEW all_entries AS
          SELECT value FROM main.entries UNION ALL SELECT value FROM archive.entries`;
        assert.equal(writerWorkers.length, count + 1);
        assert.deepEqual(yield* sql`PRAGMA journal_mode`, [{ journal_mode: "delete" }]);
        yield* sql.unsafe(pragma).unprepared;
        assert.equal(writerWorkers.length, count + 1);
        assert.deepEqual(yield* sql`PRAGMA journal_mode`, [{ journal_mode: "wal" }]);
        assert.deepEqual(yield* sql`PRAGMA foreign_keys`, [{ foreign_keys: 1 }]);
        assert.deepEqual(yield* sql`PRAGMA busy_timeout`, [{ timeout: 1234 }]);
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM temp.local_buffer`, [
          { count: 1 },
        ]);
        assert.deepEqual(yield* sql`SELECT value FROM temp.local_buffer`.values, [[7]]);
        assert.deepEqual(yield* sql`SELECT value FROM all_entries ORDER BY value`.values, [
          [1],
          [2],
        ]);
        yield* sql.withTransaction(sql`INSERT INTO main.entries VALUES (3)`);
        assert.deepEqual(yield* sql`SELECT value FROM all_entries ORDER BY value`.values, [
          [1],
          [2],
          [3],
        ]);
        assert.equal(writerWorkers.length, count + 1);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(walActivationStatements)(
  "starts and closes the nested checkpoint for WAL activation (%s)",
  (pragma) => {
    const checkpointsBefore = startedWorkers.length;
    let checkpoint: NodeWorkerThreads.Worker | undefined;
    let writer: NodeWorkerThreads.Worker | undefined;
    return withFileClient(
      (sql) =>
        Effect.gen(function* () {
          writer = writerWorkers.at(-1)!;
          assert.equal(startedWorkers.length, checkpointsBefore);
          yield* sql.unsafe(pragma).unprepared;
          yield* writerBridgeBarrier(writer);
          assert.equal(startedWorkers.length, checkpointsBefore + 1);
          checkpoint = startedWorkers.at(-1)!;
          assert.strictEqual(checkpointOwners.get(checkpoint), writer);
          assert.deepEqual(yield* sql`PRAGMA wal_autocheckpoint`, [{ wal_autocheckpoint: 0 }]);
          assert.deepEqual(yield* sql`PRAGMA synchronous`, [{ synchronous: 2 }]);
          yield* sql`CREATE TABLE checkpoint_state(value INTEGER)`;
          yield* sql.withTransaction(sql`INSERT INTO checkpoint_state VALUES (1)`);
          assert.deepEqual(yield* sql`SELECT value FROM checkpoint_state`, [{ value: 1 }]);
        }),
      { readerWorker: false, checkpointWorker: true },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.equal(checkpoint?.threadId, -1);
          assert.equal(writer?.threadId, -1);
        }),
      ),
    );
  },
);

it.effect("retains transaction control timings on the caller span with a worker writer", () => {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return withFileClient((sql) =>
    Effect.gen(function* () {
      for (const statement of [
        "BEGIN",
        "SAVEPOINT nested",
        "RELEASE nested",
        "END",
        "BEGIN",
        "ROLLBACK",
      ])
        yield* sql.unsafe(statement).unprepared;
      const failed = yield* sql.unsafe("COMMIT").unprepared.pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      const span = yield* Effect.currentSpan;
      for (const [operation, count] of [
        ["begin", 2],
        ["savepoint", 1],
        ["release", 1],
        ["commit", 2],
        ["rollback", 1],
      ] as const) {
        assert.equal(span.attributes.get(`db.transaction.control.${operation}_count`), count);
        assert.isAtLeast(Number(span.attributes.get(`db.transaction.control.${operation}_ms`)), 0);
      }
    }).pipe(
      Effect.withSpan("worker-controls"),
      Effect.withTracer(tracer),
      Effect.provideService(Statement.SpanPropagationEnabled, false),
    ),
  );
});

it.effect("observes a commit only after the writer acknowledgement is delivered", () =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode=WAL`;
      yield* sql`CREATE TABLE ack_entries(value INTEGER)`;
      const observer = yield* openDatabase(filename);
      const writer = writerWorkers.at(-1)!;
      const held = holdWriterReply(writer, /^COMMIT$/i);
      yield* Effect.addFinalizer(() => Effect.sync(held.deliver));
      let commits = 0;
      const transaction = yield* sql.withTransaction(sql`INSERT INTO ack_entries VALUES (1)`).pipe(
        Effect.provideService(SqliteClient.TransactionCommitObserver, () => {
          commits++;
        }),
        Effect.forkChild,
      );
      yield* Effect.promise(() => held.ready);
      assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM ack_entries").get()?.count, 1);
      assert.equal(commits, 0);
      assert.isUndefined(transaction.pollUnsafe());
      held.deliver();
      yield* Fiber.join(transaction);
      assert.equal(commits, 1);
      yield* sql.withTransaction(sql`INSERT INTO ack_entries VALUES (2)`).pipe(
        Effect.provideService(SqliteClient.TransactionCommitObserver, () => {
          throw new Error("observer");
        }),
      );
      assert.deepEqual(yield* sql`SELECT value FROM ack_entries ORDER BY value`.values, [[1], [2]]);
    }),
  ),
);

it.effect.each([false, true])(
  "holds the writer permit until an interrupted statement acknowledges completion (transaction=%s)",
  (transactional) =>
    withFileClient((sql, filename) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`CREATE TABLE inflight_entries(value INTEGER)`;
        const writer = writerWorkers.at(-1)!;
        const held = holdWriterReply(writer, /^INSERT INTO inflight_entries/);
        yield* Effect.addFinalizer(() => Effect.sync(held.deliver));
        const insert = sql`INSERT INTO inflight_entries VALUES (1)`;
        const work = yield* (transactional ? sql.withTransaction(insert) : insert).pipe(
          Effect.forkChild,
        );
        yield* Effect.promise(() => held.ready);
        const cancelled = new Promise<void>((resolve) =>
          writer.once("test-writer-cancel", () => resolve()),
        );
        const interrupt = yield* Effect.forkChild(Fiber.interrupt(work), {
          startImmediately: true,
        });
        yield* Effect.promise(() => cancelled);
        const next = yield* Effect.forkChild(sql`INSERT INTO inflight_entries VALUES (2)`, {
          startImmediately: true,
        });
        yield* writerBridgeBarrier(writer);
        assert.isUndefined(interrupt.pollUnsafe());
        assert.isUndefined(next.pollUnsafe());
        const observer = yield* openDatabase(filename);
        assert.equal(
          observer.prepare("SELECT COUNT(*) AS count FROM inflight_entries").get()?.count,
          transactional ? 0 : 1,
        );
        held.deliver();
        yield* Fiber.join(interrupt);
        yield* Fiber.join(next);
        assert.deepEqual(
          yield* sql`SELECT value FROM inflight_entries ORDER BY value`.values,
          transactional ? [[2]] : [[1], [2]],
        );
      }),
    ),
);

it.effect(
  "keeps a crashed transaction on its lost session and recovers the next transaction on the same client",
  () =>
    withFileClient((sql, filename) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`CREATE TABLE crash_entries(value INTEGER)`;
        yield* sql`INSERT INTO crash_entries VALUES (1)`;
        const writer = writerWorkers.at(-1)!;
        const count = writerWorkers.length;
        const failed = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO crash_entries VALUES (2)`;
              yield* Effect.promise(() => writer.terminate());
              const first = yield* sql`SELECT value FROM crash_entries`.pipe(
                Effect.flip,
                Effect.orDie,
              );
              const second = yield* sql`INSERT INTO crash_entries VALUES (3)`.pipe(
                Effect.flip,
                Effect.orDie,
              );
              assert.include(String(first.reason.cause), "outcome may be unknown");
              assert.include(String(second.reason.cause), "outcome may be unknown");
              assert.equal(writerWorkers.length, count);
              return yield* Effect.fail(first);
            }),
          )
          .pipe(Effect.flip);
        assert.equal(failed._tag, "SqlError");
        assert.include(String(failed.reason.cause), "outcome may be unknown");
        assert.equal(writerWorkers.length, count);
        const observer = yield* openDatabase(filename);
        assert.deepEqual(observer.prepare("SELECT value FROM crash_entries").all(), [{ value: 1 }]);
        yield* sql.withTransaction(sql`INSERT INTO crash_entries VALUES (4)`);
        assert.equal(writerWorkers.length, count + 1);
        assert.deepEqual(yield* sql`SELECT value FROM crash_entries ORDER BY value`.values, [
          [1],
          [4],
        ]);
      }),
    ),
);

it.effect(
  "recovers after a lost commit acknowledgement without replaying the write or observer",
  () =>
    withFileClient((sql, filename) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`CREATE TABLE lost_ack(value INTEGER)`;
        const writer = writerWorkers.at(-1)!;
        const count = writerWorkers.length;
        const held = holdWriterReply(writer, /^COMMIT$/i);
        yield* Effect.addFinalizer(() => Effect.sync(held.discard));
        let commits = 0;
        const transaction = yield* sql.withTransaction(sql`INSERT INTO lost_ack VALUES (1)`).pipe(
          Effect.provideService(SqliteClient.TransactionCommitObserver, () => {
            commits++;
          }),
          Effect.flip,
          Effect.forkChild,
        );
        yield* Effect.promise(() => held.ready);
        const observer = yield* openDatabase(filename);
        assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM lost_ack").get()?.count, 1);
        held.discard();
        yield* Effect.promise(() => writer.terminate());
        const failure = yield* Fiber.join(transaction);
        assert.equal(failure._tag, "SqlError");
        assert.include(String(failure.reason.cause), "outcome may be unknown");
        assert.equal(commits, 0);
        assert.equal(writerWorkers.length, count);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* sql.reserve;
            assert.deepEqual(yield* connection.executeValues("SELECT value FROM lost_ack", []), [
              [1],
            ]);
          }),
        );
        assert.equal(writerWorkers.length, count + 1);
        assert.equal(commits, 0);
        yield* sql.withTransaction(sql`INSERT INTO lost_ack VALUES (2)`).pipe(
          Effect.provideService(SqliteClient.TransactionCommitObserver, () => {
            commits++;
          }),
        );
        assert.equal(commits, 1);
        assert.deepEqual(yield* sql`SELECT value FROM lost_ack ORDER BY value`.values, [[1], [2]]);
        assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM lost_ack").get()?.count, 2);
      }),
    ),
);

it.effect("keeps a lost writer reservation pinned until it releases the permit", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode=WAL`;
      yield* sql`CREATE TABLE reserved_entries(value INTEGER)`;
      const writer = writerWorkers.at(-1)!;
      const count = writerWorkers.length;
      const next = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* sql.reserve;
          yield* connection.executeUnprepared(
            "INSERT INTO reserved_entries VALUES (1)",
            [],
            undefined,
          );
          yield* Effect.promise(() => writer.terminate());
          const read = yield* connection
            .executeValues("SELECT value FROM reserved_entries", [])
            .pipe(Effect.flip);
          const write = yield* connection
            .executeUnprepared("INSERT INTO reserved_entries VALUES (2)", [], undefined)
            .pipe(Effect.flip);
          assert.include(String(read.reason.cause), "outcome may be unknown");
          assert.include(String(write.reason.cause), "outcome may be unknown");
          const queued = yield* Effect.forkChild(sql`INSERT INTO reserved_entries VALUES (3)`, {
            startImmediately: true,
          });
          yield* eventLoopTurn;
          assert.isUndefined(queued.pollUnsafe());
          assert.equal(writerWorkers.length, count);
          return queued;
        }),
      );
      yield* Fiber.join(next);
      assert.equal(writerWorkers.length, count + 1);
      assert.deepEqual(yield* sql`SELECT value FROM reserved_entries ORDER BY value`.values, [
        [1],
        [3],
      ]);
    }),
  ),
);

it.effect("restores writer settings, archive attachments and temp views after a crash", () =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      const archivePath = `${filename}.archive`;
      const archive = yield* openDatabase(archivePath);
      archive.exec("CREATE TABLE entries(id INTEGER); INSERT INTO entries VALUES (2)");
      yield* sql`PRAGMA journal_mode=WAL`;
      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY)`;
      yield* sql`CREATE TABLE children(parent_id INTEGER REFERENCES entries(id))`;
      yield* sql`INSERT INTO entries VALUES (1)`;
      yield* sql`PRAGMA foreign_keys=ON`;
      yield* sql`PRAGMA busy_timeout=1234`;
      yield* sql`ATTACH DATABASE ${archivePath} AS archive`;
      yield* sql`ATTACH DATABASE ':memory:' AS scratch`;
      yield* sql`CREATE TABLE scratch.local_buffer(value INTEGER)`;
      yield* sql`CREATE TEMP TABLE local_buffer(value INTEGER)`;
      yield* sql`CREATE TEMP VIEW all_entries AS
        SELECT id FROM main.entries UNION ALL SELECT id FROM archive.entries`;
      const duplicate = yield* sql`CREATE TEMP VIEW all_entries AS SELECT 99 AS id`.pipe(
        Effect.flip,
      );
      assert.equal(duplicate._tag, "SqlError");
      const writer = writerWorkers.at(-1)!;
      const count = writerWorkers.length;
      yield* Effect.promise(() => writer.terminate());
      assert.deepEqual(yield* sql`PRAGMA foreign_keys`, [{ foreign_keys: 1 }]);
      assert.deepEqual(yield* sql`PRAGMA busy_timeout`, [{ timeout: 1234 }]);
      assert.equal(writerWorkers.length, count + 1);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM scratch.local_buffer`, [
        { count: 0 },
      ]);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM temp.local_buffer`, [{ count: 0 }]);
      assert.deepEqual(yield* sql`SELECT id FROM all_entries ORDER BY id`.values, [[1], [2]]);
      const invalid = yield* sql`INSERT INTO children VALUES (99)`.pipe(Effect.flip);
      assert.equal(invalid._tag, "SqlError");
      assert.include(String(invalid.reason.cause), "FOREIGN KEY constraint failed");
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES (3)`);
      assert.deepEqual(yield* sql`SELECT id FROM all_entries ORDER BY id`.values, [[1], [2], [3]]);
      assert.equal(writerWorkers.length, count + 1);
    }),
  ),
);

it.effect.each(["transaction", "savepoint"] as const)(
  "restores effective connection settings after a rolled back %s without replaying rolled back schema",
  (boundary) =>
    withFileClient((sql, filename) =>
      Effect.gen(function* () {
        const archivePath = `${filename}.archive`;
        const archive = yield* openDatabase(archivePath);
        archive.exec("CREATE TABLE entries(value INTEGER); INSERT INTO entries VALUES (9)");
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`CREATE TABLE entries(value INTEGER)`;
        yield* sql`INSERT INTO entries VALUES (1)`;
        yield* sql`PRAGMA foreign_keys=ON`;
        yield* sql`PRAGMA foreign_keys=OFF`;
        yield* sql`PRAGMA busy_timeout=77`;
        const rolledBack = sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`PRAGMA busy_timeout=345`;
              // SQLite ignores foreign_keys changes while a transaction is active.
              yield* sql`PRAGMA foreign_keys=ON`;
              yield* sql`ATTACH DATABASE ${archivePath} AS archive`;
              yield* sql`CREATE TEMP VIEW rolled_back_entries AS SELECT value FROM main.entries`;
              yield* sql`INSERT INTO entries VALUES (2)`;
              return yield* Effect.fail("rollback setup");
            }),
          )
          .pipe(Effect.flip);
        if (boundary === "savepoint") {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE TEMP VIEW retained_entries AS SELECT value FROM main.entries`;
              assert.equal(yield* rolledBack, "rollback setup");
            }),
          );
        } else {
          assert.equal(yield* rolledBack, "rollback setup");
        }
        assert.deepEqual(yield* sql`PRAGMA foreign_keys`, [{ foreign_keys: 0 }]);
        assert.deepEqual(yield* sql`PRAGMA busy_timeout`, [{ timeout: 345 }]);
        const writer = writerWorkers.at(-1)!;
        const count = writerWorkers.length;
        yield* Effect.promise(() => writer.terminate());
        assert.deepEqual(yield* sql`PRAGMA foreign_keys`, [{ foreign_keys: 0 }]);
        assert.deepEqual(yield* sql`PRAGMA busy_timeout`, [{ timeout: 345 }]);
        assert.equal(writerWorkers.length, count + 1);
        assert.deepEqual(yield* sql`SELECT value FROM archive.entries`.values, [[9]]);
        assert.deepEqual(yield* sql`SELECT value FROM main.entries`.values, [[1]]);
        assert.deepEqual(
          yield* sql`SELECT COUNT(*) AS count FROM sqlite_temp_schema WHERE name='rolled_back_entries'`,
          [{ count: 0 }],
        );
        if (boundary === "savepoint") {
          assert.deepEqual(yield* sql`SELECT value FROM retained_entries`.values, [[1]]);
        }
      }),
    ),
);

it.effect.each([
  ["MiXeD", "mixed", "MIXED"],
  ['"With Space"', '"WITH SPACE"', '"with space"'],
  ["[BracketName]", "`bracketname`", '"BRACKETNAME"'],
  ["'ÄCase'", "'Äcase'", "'ÄCASE'"],
] as const)(
  "does not recover schema rolled back to a case-insensitive savepoint (%s)",
  ([opened, rolledBack, released]) =>
    withFileClient((sql) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* sql.reserve;
            yield* connection.executeUnprepared(`SAVEPOINT ${opened}`, [], undefined);
            yield* connection.executeUnprepared(
              "CREATE TEMP VIEW abandoned_view AS SELECT 1 AS value",
              [],
              undefined,
            );
            yield* connection.executeUnprepared(`ROLLBACK TO ${rolledBack}`, [], undefined);
            yield* connection.executeUnprepared(`RELEASE ${released}`, [], undefined);
          }),
        );
        yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
        assert.deepEqual(
          yield* sql`SELECT COUNT(*) AS count FROM sqlite_temp_schema WHERE name='abandoned_view'`,
          [{ count: 0 }],
        );
        yield* sql.withTransaction(sql`CREATE TABLE recovered(value INTEGER)`);
      }),
    ),
);

it.effect.each([
  ["plain", "VACUUM", false],
  ["schema qualified", "VACUUM main", false],
  ["comment prefixed", "/* maintenance */ VACUUM", false],
  ["comment prefixed schema", "-- maintenance\nVACUUM main", false],
  ["INTO literal", "VACUUM INTO", false],
  ["INTO bound", "VACUUM INTO", true],
  ["schema INTO literal", "VACUUM main INTO", false],
  ["schema INTO bound", "VACUUM main INTO", true],
  ["comment prefixed INTO", "/* backup */ VACUUM INTO", true],
  ["comment prefixed schema INTO", "-- backup\nVACUUM main INTO", true],
] as const)("recovers without repeating VACUUM maintenance (%s)", ([, statement, bound]) =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode=WAL`;
      yield* sql`CREATE TABLE vacuum_entries(value INTEGER)`;
      yield* sql`INSERT INTO vacuum_entries VALUES (1)`;
      const backupPath = `${filename}.backup`;
      const into = statement.endsWith("INTO");
      yield* sql.unsafe(
        into ? `${statement} ${bound ? "?" : `'${backupPath.replaceAll("'", "''")}'`}` : statement,
        into && bound ? [backupPath] : [],
      ).unprepared;
      if (into) {
        const backup = yield* openDatabase(backupPath);
        assert.deepEqual(backup.prepare("SELECT value FROM vacuum_entries").all(), [{ value: 1 }]);
        backup.exec(
          "CREATE TABLE backup_marker(value INTEGER); INSERT INTO backup_marker VALUES (7)",
        );
      }
      yield* sql`INSERT INTO vacuum_entries VALUES (2)`;
      const schemaVersion = yield* sql`PRAGMA main.schema_version`;
      const writer = writerWorkers.at(-1)!;
      const count = writerWorkers.length;
      yield* Effect.promise(() => writer.terminate());
      assert.deepEqual(yield* sql`SELECT value FROM vacuum_entries ORDER BY value`.values, [
        [1],
        [2],
      ]);
      assert.equal(writerWorkers.length, count + 1);
      assert.deepEqual(yield* sql`PRAGMA main.schema_version`, schemaVersion);
      if (into) {
        const backup = yield* openDatabase(backupPath);
        assert.deepEqual(backup.prepare("SELECT value FROM vacuum_entries").all(), [{ value: 1 }]);
        assert.deepEqual(backup.prepare("SELECT value FROM backup_marker").all(), [{ value: 7 }]);
      }
      yield* sql.withTransaction(sql`INSERT INTO vacuum_entries VALUES (3)`);
      assert.deepEqual(yield* sql`SELECT value FROM vacuum_entries ORDER BY value`.values, [
        [1],
        [2],
        [3],
      ]);
    }),
  ),
);

const temporaryAlterations = [
  {
    name: "rename table",
    clause: "RENAME TO renamed_table",
    table: "renamed_table",
    columns: ["original", "removable"],
  },
  {
    name: "add column",
    clause: "ADD COLUMN added TEXT NOT NULL DEFAULT 'seed'",
    table: "altered_table",
    columns: ["original", "removable", "added"],
  },
  {
    name: "rename column",
    clause: "RENAME COLUMN original TO renamed_column",
    table: "altered_table",
    columns: ["renamed_column", "removable"],
  },
  {
    name: "drop column",
    clause: "DROP COLUMN removable",
    table: "altered_table",
    columns: ["original"],
  },
] as const;

for (const schema of ["temp", "scratch"] as const) {
  for (const boundary of ["autocommit", "commit"] as const) {
    it.effect.each(temporaryAlterations)(
      `restores ${schema} ALTER TABLE after ${boundary} and a crash ($name)`,
      (alteration) =>
        withFileClient((sql) =>
          Effect.gen(function* () {
            yield* sql`PRAGMA journal_mode=WAL`;
            if (schema === "scratch") yield* sql`ATTACH DATABASE ':memory:' AS scratch`;
            const setup = Effect.gen(function* () {
              yield* sql.unsafe(
                `CREATE TABLE ${schema}.altered_table(original INTEGER, removable TEXT)`,
              ).unprepared;
              yield* sql.unsafe(`ALTER TABLE ${schema}.altered_table ${alteration.clause}`)
                .unprepared;
            });
            yield* boundary === "commit" ? sql.withTransaction(setup) : setup;
            const firstColumn = alteration.columns[0];
            yield* sql.unsafe(
              `INSERT INTO ${schema}.${alteration.table}(${firstColumn}) VALUES (7)`,
            ).unprepared;
            assert.deepEqual(
              yield* sql.unsafe(`SELECT ${firstColumn} FROM ${schema}.${alteration.table}`).values,
              [[7]],
            );
            const writer = writerWorkers.at(-1)!;
            const count = writerWorkers.length;
            yield* Effect.promise(() => writer.terminate());
            assert.deepEqual(
              (yield* sql.unsafe<{ name: string }>(
                `PRAGMA ${schema}.table_info(${alteration.table})`,
              )).map((column) => column.name),
              [...alteration.columns],
            );
            assert.equal(writerWorkers.length, count + 1);
            assert.deepEqual(
              yield* sql.unsafe(`SELECT name FROM ${schema}.sqlite_schema WHERE type='table'`),
              [{ name: alteration.table }],
            );
            assert.deepEqual(
              yield* sql.unsafe(`SELECT ${firstColumn} FROM ${schema}.${alteration.table}`).values,
              [],
            );
            yield* sql.unsafe(
              `INSERT INTO ${schema}.${alteration.table}(${firstColumn}) VALUES (8)`,
            ).unprepared;
            if (alteration.name === "add column") {
              assert.deepEqual(
                yield* sql.unsafe(`SELECT original, added FROM ${schema}.${alteration.table}`)
                  .values,
                [[8, "seed"]],
              );
            } else {
              assert.deepEqual(
                yield* sql.unsafe(`SELECT ${firstColumn} FROM ${schema}.${alteration.table}`)
                  .values,
                [[8]],
              );
            }
            yield* sql.unsafe(`DROP TABLE ${schema}.${alteration.table}`).unprepared;
            yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
            assert.deepEqual(
              yield* sql.unsafe(`SELECT name FROM ${schema}.sqlite_schema WHERE type='table'`),
              [],
            );
            assert.equal(writerWorkers.length, count + 2);
          }),
        ),
    );
  }
  for (const boundary of ["transaction", "savepoint"] as const) {
    it.effect.each(temporaryAlterations)(
      `does not restore ${schema} ALTER TABLE rolled back in a ${boundary} ($name)`,
      (alteration) =>
        withFileClient((sql) =>
          Effect.gen(function* () {
            yield* sql`PRAGMA journal_mode=WAL`;
            if (schema === "scratch") yield* sql`ATTACH DATABASE ':memory:' AS scratch`;
            yield* sql.unsafe(
              `CREATE TABLE ${schema}.altered_table(original INTEGER, removable TEXT)`,
            ).unprepared;
            const rolledBack = sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe(`ALTER TABLE ${schema}.altered_table ${alteration.clause}`)
                    .unprepared;
                  assert.deepEqual(
                    (yield* sql.unsafe<{ name: string }>(
                      `PRAGMA ${schema}.table_info(${alteration.table})`,
                    )).map((column) => column.name),
                    [...alteration.columns],
                  );
                  return yield* Effect.fail("rollback alteration");
                }),
              )
              .pipe(Effect.flip);
            if (boundary === "savepoint") {
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe(`CREATE TABLE ${schema}.retained_table(value INTEGER)`)
                    .unprepared;
                  assert.equal(yield* rolledBack, "rollback alteration");
                }),
              );
            } else {
              assert.equal(yield* rolledBack, "rollback alteration");
            }
            const writer = writerWorkers.at(-1)!;
            const count = writerWorkers.length;
            yield* Effect.promise(() => writer.terminate());
            assert.deepEqual(
              (yield* sql.unsafe<{ name: string }>(
                `PRAGMA ${schema}.table_info(altered_table)`,
              )).map((column) => column.name),
              ["original", "removable"],
            );
            assert.equal(writerWorkers.length, count + 1);
            assert.deepEqual(
              yield* sql.unsafe(
                `SELECT name FROM ${schema}.sqlite_schema WHERE type='table' ORDER BY name`,
              ),
              boundary === "savepoint"
                ? [{ name: "altered_table" }, { name: "retained_table" }]
                : [{ name: "altered_table" }],
            );
            yield* sql.unsafe(
              `INSERT INTO ${schema}.altered_table(original, removable) VALUES (1, 'kept')`,
            ).unprepared;
            assert.deepEqual(
              yield* sql.unsafe(`SELECT original, removable FROM ${schema}.altered_table`).values,
              [[1, "kept"]],
            );
          }),
        ),
    );
  }
}

it.effect.each(
  [
    { name: "no prefix", prefix: "" },
    { name: "a semicolon", prefix: "; " },
    { name: "repeated separators and a comment", prefix: ";; /* leading */ ; " },
    { name: "line and block comments", prefix: "-- leading\n; /* middle */ ; " },
  ].flatMap((form) => ["file", "memory"].map((target) => ({ ...form, target }))),
)("restores $target attachments after $name and a writer crash", ({ prefix, target }) =>
  withFileClient(
    (sql, filename) =>
      Effect.gen(function* () {
        const archive = target === "memory" ? ":memory:" : `${filename}.archive`;
        yield* sql.unsafe(`${prefix}ATTACH DATABASE ? AS archive`, [archive]).unprepared;
        yield* sql`CREATE TABLE archive.entries(value INTEGER)`;
        yield* sql`INSERT INTO archive.entries VALUES (2)`;
        const count = writerWorkers.length;
        yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
        assert.deepEqual(
          yield* sql`SELECT value FROM archive.entries`.values,
          target === "memory" ? [] : [[2]],
        );
        assert.equal(writerWorkers.length, count + 1);
        yield* sql`INSERT INTO archive.entries VALUES (3)`;
        assert.deepEqual(
          yield* sql`SELECT value FROM archive.entries ORDER BY value`.values,
          target === "memory" ? [[3]] : [[2], [3]],
        );
      }),
    { readerWorker: false },
  ),
);

it.effect.each(["commit", "rollback", "savepoint commit", "savepoint rollback"] as const)(
  "restores ordered temp setup and query_only after %s and a crash",
  (boundary) =>
    withFileClient((sql) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`CREATE TABLE query_only_entries(value INTEGER)`;
        yield* Effect.gen(function* () {
          const rollback = boundary.endsWith("rollback");
          const setup = sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE TEMP TABLE candidate_table(value INTEGER)`;
              yield* sql`PRAGMA query_only=ON`;
              if (rollback) return yield* Effect.fail("rollback query_only setup");
            }),
          );
          if (boundary.startsWith("savepoint")) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`CREATE TEMP TABLE retained_before(value INTEGER)`;
                if (rollback) {
                  assert.equal(yield* setup.pipe(Effect.flip), "rollback query_only setup");
                } else {
                  yield* setup;
                }
                assert.deepEqual(yield* sql`PRAGMA query_only`, [{ query_only: 1 }]);
                yield* sql`PRAGMA query_only=OFF`;
                yield* sql`CREATE TEMP TABLE retained_after(value INTEGER)`;
                yield* sql`PRAGMA query_only=ON`;
              }),
            );
          } else if (rollback) {
            assert.equal(yield* setup.pipe(Effect.flip), "rollback query_only setup");
          } else {
            yield* setup;
          }
          const expected = [
            ...(!rollback ? [{ name: "candidate_table" }] : []),
            ...(boundary.startsWith("savepoint")
              ? [{ name: "retained_after" }, { name: "retained_before" }]
              : []),
          ];
          assert.deepEqual(yield* sql`PRAGMA query_only`, [{ query_only: 1 }]);
          assert.deepEqual(
            yield* sql`SELECT name FROM sqlite_temp_schema WHERE type='table' ORDER BY name`,
            expected,
          );
          const writer = writerWorkers.at(-1)!;
          const count = writerWorkers.length;
          yield* Effect.promise(() => writer.terminate());
          assert.deepEqual(yield* sql`PRAGMA query_only`, [{ query_only: 1 }]);
          assert.equal(writerWorkers.length, count + 1);
          assert.deepEqual(
            yield* sql`SELECT name FROM sqlite_temp_schema WHERE type='table' ORDER BY name`,
            expected,
          );
          const readOnly = yield* sql`INSERT INTO query_only_entries VALUES (1)`.pipe(Effect.flip);
          assert.include(String(readOnly.reason.cause), "readonly");
          yield* sql`PRAGMA query_only=OFF`;
          for (const { name } of expected) {
            yield* sql.unsafe(`INSERT INTO temp.${name} VALUES (7)`).unprepared;
            assert.deepEqual(yield* sql.unsafe(`SELECT value FROM temp.${name}`).values, [[7]]);
          }
          yield* sql.withTransaction(sql`INSERT INTO query_only_entries VALUES (2)`);
          assert.deepEqual(yield* sql`SELECT value FROM query_only_entries`.values, [[2]]);
        }).pipe(Effect.ensuring(sql`PRAGMA query_only=OFF`.pipe(Effect.orDie)));
      }),
    ),
);

it.effect.each([
  ["outside transaction", [["PRAGMA defer_foreign_keys=ON", 1]], 1],
  [
    "explicit OFF",
    [
      ["PRAGMA defer_foreign_keys=ON", 1],
      ["PRAGMA defer_foreign_keys=OFF", 0],
    ],
    0,
  ],
  [
    "constant SELECT",
    [
      ["PRAGMA defer_foreign_keys=ON", 1],
      ["SELECT 1", 1],
    ],
    1,
  ],
  [
    "autocommit read",
    [
      ["PRAGMA defer_foreign_keys=ON", 1],
      ["SELECT * FROM deferral_parent", 0],
    ],
    0,
  ],
  [
    "autocommit write",
    [
      ["PRAGMA defer_foreign_keys=ON", 1],
      ["INSERT INTO deferral_parent VALUES (1)", 0],
    ],
    0,
  ],
  [
    "autocommit DDL",
    [
      ["PRAGMA defer_foreign_keys=ON", 1],
      ["CREATE TABLE deferral_extra(value INTEGER)", 0],
    ],
    0,
  ],
  [
    "commit",
    [
      ["BEGIN", 0],
      ["PRAGMA defer_foreign_keys=ON", 1],
      ["COMMIT", 0],
    ],
    0,
  ],
  [
    "rollback",
    [
      ["BEGIN", 0],
      ["PRAGMA defer_foreign_keys=ON", 1],
      ["ROLLBACK", 0],
    ],
    0,
  ],
  [
    "inherited setting commit",
    [
      ["PRAGMA defer_foreign_keys=ON", 1],
      ["BEGIN", 1],
      ["COMMIT", 0],
    ],
    0,
  ],
  [
    "root savepoint release",
    [
      ["SAVEPOINT root", 0],
      ["PRAGMA defer_foreign_keys=ON", 1],
      ["RELEASE root", 0],
    ],
    0,
  ],
  [
    "nested savepoint rollback",
    [
      ["BEGIN", 0],
      ["SAVEPOINT nested", 0],
      ["PRAGMA defer_foreign_keys=ON", 1],
      ["ROLLBACK TO nested", 1],
      ["RELEASE nested", 1],
      ["COMMIT", 0],
    ],
    0,
  ],
  [
    "crash inside transaction",
    [
      ["BEGIN", 0],
      ["PRAGMA defer_foreign_keys=ON", 1],
    ],
    0,
  ],
  [
    "crash after nested rollback",
    [
      ["BEGIN", 0],
      ["SAVEPOINT nested", 0],
      ["PRAGMA defer_foreign_keys=ON", 1],
      ["ROLLBACK TO nested", 1],
      ["RELEASE nested", 1],
    ],
    0,
  ],
] as const)(
  "restores SQLite effective defer_foreign_keys after %s and a crash",
  ([, steps, recovered]) =>
    withFileClient((sql) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`PRAGMA foreign_keys=ON`;
        yield* sql`CREATE TABLE deferral_parent(id INTEGER PRIMARY KEY)`;
        yield* sql`CREATE TABLE deferral_child(parent_id INTEGER REFERENCES deferral_parent(id))`;
        const native = yield* openDatabase(":memory:");
        native.exec(
          "PRAGMA foreign_keys=ON; CREATE TABLE deferral_parent(id INTEGER PRIMARY KEY); CREATE TABLE deferral_child(parent_id INTEGER REFERENCES deferral_parent(id))",
        );
        const count = writerWorkers.length;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* sql.reserve;
            for (const [statement, expected] of steps) {
              const prepared = native.prepare(statement);
              if (prepared.columns().length) prepared.all();
              else prepared.run();
              assert.equal(
                native.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys,
                expected,
              );
              yield* connection.executeUnprepared(statement, [], undefined);
              assert.deepEqual(yield* connection.executeValues("PRAGMA defer_foreign_keys", []), [
                [expected],
              ]);
            }
            yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
          }),
        );
        if (native.isTransaction) native.exec("ROLLBACK");
        assert.equal(
          native.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys,
          recovered,
        );
        assert.deepEqual(yield* sql`PRAGMA defer_foreign_keys`, [
          { defer_foreign_keys: recovered },
        ]);
        assert.equal(writerWorkers.length, count + 1);
        assert.deepEqual(yield* sql`PRAGMA foreign_keys`, [{ foreign_keys: 1 }]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* sql.reserve;
            yield* connection.executeUnprepared("BEGIN", [], undefined);
            if (recovered === 1) {
              yield* connection.executeUnprepared(
                "INSERT INTO deferral_child VALUES (99)",
                [],
                undefined,
              );
              const commit = yield* connection
                .executeUnprepared("COMMIT", [], undefined)
                .pipe(Effect.flip);
              assert.include(String(commit.reason.cause), "FOREIGN KEY constraint failed");
              native.exec("BEGIN; INSERT INTO deferral_child VALUES (99)");
              assert.throws(() => native.exec("COMMIT"), /FOREIGN KEY constraint failed/);
              assert.isTrue(native.isTransaction);
              assert.equal(
                native.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys,
                1,
              );
              assert.deepEqual(yield* connection.executeValues("PRAGMA defer_foreign_keys", []), [
                [1],
              ]);
              assert.deepEqual(
                yield* connection.executeValues("SELECT parent_id FROM deferral_child", []),
                [[99]],
              );
              native.exec("ROLLBACK");
            } else {
              const insert = yield* connection
                .executeUnprepared("INSERT INTO deferral_child VALUES (99)", [], undefined)
                .pipe(Effect.flip);
              assert.include(String(insert.reason.cause), "FOREIGN KEY constraint failed");
            }
            yield* connection.executeUnprepared("ROLLBACK", [], undefined);
          }),
        );
        assert.deepEqual(yield* sql`PRAGMA defer_foreign_keys`, [{ defer_foreign_keys: 0 }]);
        assert.deepEqual(yield* sql`SELECT parent_id FROM deferral_child`, []);
        assert.deepEqual(
          yield* sql`SELECT id FROM deferral_parent`.values,
          native
            .prepare("SELECT id FROM deferral_parent")
            .all()
            .map((row) => [row.id]),
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`PRAGMA defer_foreign_keys=ON`;
            yield* sql`INSERT INTO deferral_child VALUES (2)`;
            yield* sql`INSERT INTO deferral_parent VALUES (2)`;
          }),
        );
        assert.deepEqual(yield* sql`PRAGMA defer_foreign_keys`, [{ defer_foreign_keys: 0 }]);
        yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
        assert.deepEqual(yield* sql`PRAGMA defer_foreign_keys`, [{ defer_foreign_keys: 0 }]);
        assert.equal(writerWorkers.length, count + 2);
        assert.deepEqual(yield* sql`SELECT parent_id FROM deferral_child`, [{ parent_id: 2 }]);
      }),
    ),
);

it.effect.each(["managed transaction", "abandoned reservation"] as const)(
  "releases a failed deferred commit without losing its error or leaking its transaction (%s)",
  (boundary) =>
    withFileClient((sql, filename) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`PRAGMA foreign_keys=ON`;
        yield* sql`CREATE TABLE lease_parent(id INTEGER PRIMARY KEY)`;
        yield* sql`CREATE TABLE lease_child(parent_id INTEGER REFERENCES lease_parent(id))`;
        let reachedCommit = false;
        let commits = 0;
        const observeCommit = () => {
          commits++;
        };
        const failed = yield* Effect.gen(function* () {
          if (boundary === "managed transaction") {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`PRAGMA defer_foreign_keys=ON`;
                yield* sql`INSERT INTO lease_child VALUES (99)`;
                reachedCommit = true;
              }),
            );
          } else {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const connection = yield* sql.reserve;
                yield* connection.executeUnprepared("BEGIN", [], undefined);
                yield* connection.executeUnprepared("PRAGMA defer_foreign_keys=ON", [], undefined);
                yield* connection.executeUnprepared(
                  "INSERT INTO lease_child VALUES (99)",
                  [],
                  undefined,
                );
                reachedCommit = true;
                yield* connection.executeUnprepared("COMMIT", [], undefined);
              }),
            );
          }
        }).pipe(
          Effect.provideService(SqliteClient.TransactionCommitObserver, observeCommit),
          Effect.flip,
        );
        assert.isTrue(reachedCommit);
        assert.equal(failed._tag, "SqlError");
        assert.equal(failed.reason._tag, "ConstraintError");
        assert.equal(failed.reason.operation, "execute");
        assert.include(String(failed.reason.cause), "FOREIGN KEY constraint failed");
        assert.equal(commits, 0);
        const observer = yield* openDatabase(filename);
        assert.deepEqual(observer.prepare("SELECT parent_id FROM lease_child").all(), []);
        assert.deepEqual(yield* sql`PRAGMA defer_foreign_keys`, [{ defer_foreign_keys: 0 }]);
        assert.deepEqual(yield* sql`SELECT parent_id FROM lease_child`, []);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO lease_parent VALUES (1)`;
              yield* sql`INSERT INTO lease_child VALUES (1)`;
            }),
          )
          .pipe(Effect.provideService(SqliteClient.TransactionCommitObserver, observeCommit));
        assert.equal(commits, 1);
        assert.deepEqual(yield* sql`SELECT parent_id FROM lease_child`, [{ parent_id: 1 }]);
        assert.deepEqual(observer.prepare("SELECT parent_id FROM lease_child").all(), [
          { parent_id: 1 },
        ]);
      }),
    ),
);

it.effect.each([-1, 0, 1048576, 9007199254740993n])(
  "restores the exact journal_size_limit with safe integers after a crash (%s)",
  (limit) =>
    withFileClient((sql) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`CREATE TABLE limit_entries(value INTEGER)`;
        yield* sql`INSERT INTO limit_entries VALUES (1)`;
        assert.deepEqual(
          yield* sql
            .unsafe(`PRAGMA journal_size_limit=${limit}`)
            .pipe(Effect.provideService(SqlClient.SafeIntegers, true)),
          [{ journal_size_limit: BigInt(limit) }],
        );
        const writer = writerWorkers.at(-1)!;
        const count = writerWorkers.length;
        yield* Effect.promise(() => writer.terminate());
        assert.deepEqual(
          yield* sql`PRAGMA journal_size_limit`.pipe(
            Effect.provideService(SqlClient.SafeIntegers, true),
          ),
          [{ journal_size_limit: BigInt(limit) }],
        );
        assert.equal(writerWorkers.length, count + 1);
        yield* sql.withTransaction(sql`INSERT INTO limit_entries VALUES (2)`);
        assert.deepEqual(yield* sql`SELECT value FROM limit_entries ORDER BY value`.values, [
          [1],
          [2],
        ]);
      }),
    ),
);

it.effect.each([
  { name: "Uint8Array", make: () => new Uint8Array([1, 2, 3]) },
  { name: "offset view", make: () => new Uint8Array([0, 1, 2, 3, 0]).subarray(1, 4) },
  { name: "Buffer", make: () => Buffer.from([1, 2, 3]) },
  { name: "DataView", make: () => new DataView(new Uint8Array([1, 2, 3]).buffer) },
  { name: "Uint16Array", make: () => new Uint16Array([1, 2, 3]) },
  { name: "ArrayBuffer", make: () => new Uint8Array([1, 2, 3]).buffer },
  {
    name: "SharedArrayBuffer",
    make: () => {
      const value = new SharedArrayBuffer(3);
      new Uint8Array(value).set([1, 2, 3]);
      return value;
    },
  },
])("preserves native $name blob bindings", ({ make }) =>
  withFileClient(
    (sql) =>
      Effect.gen(function* () {
        const value = make();
        const native = yield* openDatabase(":memory:");
        const expected = native.prepare("SELECT hex(?) AS value").get(value)!.value;
        assert.deepEqual(yield* sql`SELECT hex(${value}) AS value`.values, [[expected]]);
        assert.deepEqual(yield* sql.unsafe("SELECT hex(?) AS value", [value]).unprepared, [
          { value: expected },
        ]);
        assert.deepEqual(
          yield* sql.unsafe("SELECT hex($value) AS value", [{ $value: value }]).values,
          [[expected]],
        );
      }),
    { readerWorker: false },
  ),
);

it.effect.each(["UTF-16le", "UTF-16be"] as const)(
  "restores pending main encoding before attaching a %s file",
  (encoding) =>
    withFileClient(
      (sql, filename) =>
        Effect.gen(function* () {
          const path = `${filename}.unicode`;
          const native = yield* openDatabase(path);
          native.exec(
            `PRAGMA encoding='${encoding}'; CREATE TABLE entries(value); INSERT INTO entries VALUES ('fixture')`,
          );
          yield* sql.unsafe(`PRAGMA encoding='${encoding}'`);
          yield* sql`ATTACH DATABASE ${path} AS archive`;
          const fs = yield* FileSystem.FileSystem;
          assert.equal(Number((yield* fs.stat(filename)).size), 0);
          yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
          assert.deepEqual(yield* sql`SELECT value FROM archive.entries`.values, [["fixture"]]);
          assert.deepEqual(yield* sql`PRAGMA encoding`.values, [[encoding]]);
        }),
      { readerWorker: false },
    ),
);

it.effect.each(
  [
    { pragma: "page_size", value: "8192", actual: 8192 },
    { pragma: "auto_vacuum", value: "FULL", actual: 1 },
  ].flatMap((setting) => [false, true].map((vacuum) => ({ ...setting, vacuum }))),
)(
  "tracks pending VACUUM setting $pragma=$value (vacuum=$vacuum)",
  ({ pragma, value, actual, vacuum }) =>
    withFileClient(
      (sql) =>
        Effect.gen(function* () {
          yield* sql`CREATE TABLE vacuum_pending(value INTEGER)`;
          yield* sql`INSERT INTO vacuum_pending VALUES (1)`;
          const before = yield* sql.unsafe(`PRAGMA ${pragma}`).values;
          yield* sql.unsafe(`PRAGMA ${pragma}='${value}'`);
          assert.deepEqual(yield* sql.unsafe(`PRAGMA ${pragma}`).values, before);
          if (vacuum) {
            yield* sql`VACUUM`;
            assert.deepEqual(yield* sql.unsafe(`PRAGMA ${pragma}`).values, [[actual]]);
          }
          const count = writerWorkers.length;
          yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
          if (vacuum) {
            assert.deepEqual(yield* sql.unsafe(`PRAGMA ${pragma}`).values, [[actual]]);
            assert.deepEqual(yield* sql`SELECT value FROM vacuum_pending`.values, [[1]]);
          } else {
            const failed = yield* sql`SELECT value FROM vacuum_pending`.pipe(Effect.flip);
            assert.include(String(failed.reason.cause), "connection state could not be observed");
            assert.equal(writerWorkers.length, count);
          }
        }),
      { readerWorker: false },
    ),
);

it.effect.each(
  [
    {
      statement: "PRAGMA case_sensitive_like=ON",
      check: "SELECT 'a' LIKE 'A'",
      expected: 0,
      unsafe: true,
    },
    {
      statement: "PRAGMA ignore_check_constraints=ON",
      check: "PRAGMA ignore_check_constraints",
      expected: 1,
      unsafe: false,
    },
    {
      statement: "PRAGMA page_size=8192",
      check: "PRAGMA page_size",
      expected: 8192,
      unsafe: false,
    },
  ].flatMap((setting) => [false, true].map((cached) => ({ ...setting, cached }))),
)(
  "records preparation-time settings after failed binding ($statement, cached=$cached)",
  ({ statement, check, expected, unsafe, cached }) =>
    withFileClient(
      (sql) =>
        Effect.gen(function* () {
          const native = yield* openDatabase(":memory:");
          assert.throws(() => native.prepare(statement).all(42));
          assert.equal(Object.values(native.prepare(check).get()!)[0], expected);
          const request = sql.unsafe(statement, [42]);
          const failed = yield* (cached ? request : request.unprepared).pipe(Effect.flip);
          assert.equal(failed._tag, "SqlError");
          assert.deepEqual(yield* sql.unsafe(check).values, [[expected]]);
          const count = writerWorkers.length;
          yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
          if (unsafe) {
            const unavailable = yield* sql.unsafe(check).pipe(Effect.flip);
            assert.include(
              String(unavailable.reason.cause),
              "connection state could not be observed",
            );
            assert.equal(writerWorkers.length, count);
          } else assert.deepEqual(yield* sql.unsafe(check).values, [[expected]]);
        }),
      { readerWorker: false },
    ),
);

it.effect.each([
  { name: "plain object", make: () => ({}) },
  { name: "null prototype", make: () => Object.create(null) as object },
  // @effect-diagnostics-next-line globalDate:off -- Native SQLite binding compatibility requires a Date instance.
  { name: "Date", make: () => new Date(0) },
  { name: "Map", make: () => new Map() },
  { name: "Set", make: () => new Set() },
  { name: "WeakMap", make: () => new WeakMap() },
  { name: "WeakSet", make: () => new WeakSet() },
  { name: "RegExp", make: () => /fixture/ },
  { name: "boxed number", make: () => Object(1) as object },
  { name: "class instance", make: () => new (class Binding {})() },
  { name: "callable", make: () => () => undefined },
])("preserves native named bindings on $name", ({ make }) =>
  withFileClient(
    (sql) =>
      Effect.gen(function* () {
        const bindings = Object.assign(make(), { $value: 42, $text: "fixture" });
        const native = yield* openDatabase(":memory:");
        const statement = "SELECT $value AS value, $text AS text";
        const expected = native.prepare(statement).all(bindings);
        assert.deepEqual(yield* sql.unsafe(statement, [bindings]), expected);
        assert.deepEqual(yield* sql.unsafe(statement, [bindings]).unprepared, expected);
        assert.deepEqual(yield* sql.unsafe(statement, [bindings]).values, [[42, "fixture"]]);
      }),
    { readerWorker: false },
  ),
);

it.effect.each([
  { pragma: "encoding", value: "UTF-8" },
  { pragma: "encoding", value: "UTF-16le" },
  { pragma: "encoding", value: "UTF-16be" },
  { pragma: "page_size", value: "512" },
  { pragma: "page_size", value: "8192" },
  { pragma: "page_size", value: "65536" },
  { pragma: "auto_vacuum", value: "NONE" },
  { pragma: "auto_vacuum", value: "FULL" },
  { pragma: "auto_vacuum", value: "INCREMENTAL" },
])("restores pending $pragma=$value before file initialization", ({ pragma, value }) =>
  withFileClient(
    (sql, filename) =>
      Effect.gen(function* () {
        yield* sql.unsafe(`PRAGMA ${pragma}='${value}'`);
        const before = yield* sql.unsafe(`PRAGMA ${pragma}`).values;
        yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
        assert.deepEqual(yield* sql.unsafe(`PRAGMA ${pragma}`).values, before);
        yield* sql`CREATE TABLE pending_entries(value INTEGER)`;
        yield* sql`INSERT INTO pending_entries VALUES (1)`;
        const native = yield* openDatabase(filename);
        assert.deepEqual(
          native
            .prepare(`PRAGMA ${pragma}`)
            .all()
            .map((row) => Object.values(row)),
          before,
        );
      }),
    { readerWorker: false },
  ),
);

it.effect.each([
  { global: "EXCLUSIVE", main: "NORMAL" },
  { global: "NORMAL", main: "EXCLUSIVE" },
  { global: "EXCLUSIVE", main: "EXCLUSIVE" },
  { global: "NORMAL", main: "NORMAL" },
])("restores default locking mode $global separately from main $main", ({ global, main }) =>
  withFileClient(
    (sql, filename) =>
      Effect.gen(function* () {
        yield* sql.unsafe(`PRAGMA locking_mode=${global}`);
        yield* sql.unsafe(`PRAGMA main.locking_mode=${main}`);
        const before = yield* sql`PRAGMA locking_mode`.values;
        const mainBefore = yield* sql`PRAGMA main.locking_mode`.values;
        yield* sql`ATTACH DATABASE ${`${filename}.first`} AS first`;
        const firstBefore = yield* sql`PRAGMA first.locking_mode`.values;
        yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
        assert.deepEqual(yield* sql`PRAGMA locking_mode`.values, before);
        assert.deepEqual(yield* sql`PRAGMA main.locking_mode`.values, mainBefore);
        assert.deepEqual(yield* sql`PRAGMA first.locking_mode`.values, firstBefore);
        yield* sql`ATTACH DATABASE ${`${filename}.second`} AS second`;
        assert.deepEqual(yield* sql`PRAGMA second.locking_mode`.values, before);
      }),
    { readerWorker: false },
  ),
);

it.effect.each([false, true])(
  "refuses unverified computed attachment options during recovery (bound=%s)",
  (bound) =>
    withFileClient((sql, filename) =>
      Effect.gen(function* () {
        const a = `${filename}.a`;
        const b = `${filename}.b`;
        for (const [path, value] of [
          [a, "A"],
          [b, "B"],
        ] as const) {
          const native = yield* openDatabase(path);
          native.exec(`CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('${value}')`);
        }
        yield* sql`CREATE TABLE locations(id INTEGER, path TEXT)`;
        yield* sql`INSERT INTO locations VALUES (1, ${a})`;
        yield* sql.unsafe(
          bound
            ? "ATTACH DATABASE (SELECT path FROM locations WHERE id=?) AS archive"
            : "ATTACH DATABASE (SELECT path FROM locations WHERE id=1) AS archive",
          bound ? [1] : [],
        );
        yield* sql`UPDATE locations SET path=${b}`;
        assert.deepEqual(yield* sql`SELECT value FROM archive.entries`.values, [["A"]]);
        const count = writerWorkers.length;
        yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
        const failed = yield* sql`SELECT value FROM archive.entries`.pipe(Effect.flip);
        assert.include(String(failed.reason.cause), "connection state could not be observed");
        assert.equal(writerWorkers.length, count);
        const main = yield* openDatabase(filename);
        main.prepare("UPDATE locations SET path=?").run(a);
        const stillUnsafe = yield* sql`SELECT value FROM archive.entries`.pipe(Effect.flip);
        assert.include(String(stillUnsafe.reason.cause), "connection state could not be observed");
        assert.equal(writerWorkers.length, count);
      }),
    ),
);

it.effect.each(["ro", "rw"].flatMap((mode) => [false, true].map((detach) => ({ mode, detach }))))(
  "does not change computed URI $mode access on recovery (detach=$detach)",
  ({ mode, detach }) =>
    withFileClient(
      (sql, filename) =>
        Effect.gen(function* () {
          const path = `${filename}.access`;
          const native = yield* openDatabase(path);
          native.exec("CREATE TABLE entries(value INTEGER); INSERT INTO entries VALUES (1)");
          yield* sql`CREATE TABLE locations(uri TEXT)`;
          yield* sql`INSERT INTO locations VALUES (${`file:${path}?mode=${mode}`})`;
          yield* sql`ATTACH DATABASE (SELECT uri FROM locations) AS archive`;
          if (mode === "ro") {
            const failed = yield* sql`INSERT INTO archive.entries VALUES (2)`.pipe(Effect.flip);
            assert.include(String(failed.reason.cause), "readonly");
          } else yield* sql`INSERT INTO archive.entries VALUES (2)`;
          yield* sql`UPDATE locations SET uri=${`file:${path}?mode=${mode === "ro" ? "rw" : "ro"}`}`;
          if (detach) yield* sql`DETACH DATABASE archive`;
          const count = writerWorkers.length;
          yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
          if (detach) {
            const databases = yield* sql<{ name: string }>`PRAGMA database_list`;
            assert.isFalse(databases.some((row) => row.name === "archive"));
            assert.equal(writerWorkers.length, count + 1);
          } else {
            const failed = yield* sql`SELECT value FROM archive.entries`.pipe(Effect.flip);
            assert.include(String(failed.reason.cause), "connection state could not be observed");
            assert.equal(writerWorkers.length, count);
          }
          assert.deepEqual(
            native
              .prepare("SELECT value FROM entries ORDER BY value")
              .all()
              .map((row) => row.value),
            mode === "ro" ? [1] : [1, 2],
          );
        }),
      { readerWorker: false },
    ),
);

it.effect.each(
  [1048576, 2097152].flatMap((global) => [0, 524288].map((main) => ({ global, main }))),
)("restores default mmap size $global separately from main $main", ({ global, main }) =>
  withFileClient(
    (sql, filename) =>
      Effect.gen(function* () {
        yield* sql.unsafe(`PRAGMA mmap_size=${global}`);
        yield* sql`ATTACH DATABASE ${`${filename}.first`} AS first`;
        const inherited = yield* sql`PRAGMA first.mmap_size`.values;
        yield* sql.unsafe(`PRAGMA main.mmap_size=${main}`);
        const current = yield* sql`PRAGMA main.mmap_size`.values;
        yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
        assert.deepEqual(yield* sql`PRAGMA main.mmap_size`.values, current);
        assert.deepEqual(yield* sql`PRAGMA first.mmap_size`.values, inherited);
        yield* sql`ATTACH DATABASE ${`${filename}.second`} AS second`;
        assert.deepEqual(yield* sql`PRAGMA second.mmap_size`.values, inherited);
      }),
    { readerWorker: false },
  ),
);

it.effect.each([1, 2])("retains an mmap default through %s observation failures", (failures) =>
  withFileClient(
    (sql, filename) =>
      Effect.gen(function* () {
        const writer = writerWorkers.at(-1)!;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        writer.postMessage({ testCheckpoint: true, kind: "fail-global-mmap", args: [failures] });
        yield* writerBridgeBarrier(writer);
        yield* sql`PRAGMA mmap_size=1048576`;
        const override = sql`PRAGMA main.mmap_size=0`;
        if (failures === 2) {
          const blocked = yield* override.pipe(Effect.flip);
          assert.include(String(blocked.reason.cause), "mmap default metadata failure");
        }
        yield* override;
        yield* Effect.promise(() => writer.terminate());
        assert.deepEqual(yield* sql`PRAGMA main.mmap_size`.values, [[0]]);
        yield* sql`ATTACH DATABASE ${`${filename}.after`} AS after`;
        assert.deepEqual(yield* sql`PRAGMA after.mmap_size`.values, [[1048576]]);
      }),
    { readerWorker: false },
  ),
);

it.effect("preserves a read-only URI attachment when its identity is verified", () =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      const path = `${filename}.archive`;
      const native = yield* openDatabase(path);
      native.exec("CREATE TABLE entries(value INTEGER); INSERT INTO entries VALUES (1)");
      yield* sql`ATTACH DATABASE ${`file:${path}?mode=ro`} AS archive`;
      const before = yield* sql`INSERT INTO archive.entries VALUES (2)`.pipe(Effect.flip);
      assert.include(String(before.reason.cause), "readonly");
      yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
      assert.deepEqual(yield* sql`SELECT value FROM archive.entries`.values, [[1]]);
      const after = yield* sql`INSERT INTO archive.entries VALUES (2)`.pipe(Effect.flip);
      assert.include(String(after.reason.cause), "readonly");
    }),
  ),
);

it.effect("preserves effective CHECK constraint enforcement through writer recovery", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA ignore_check_constraints=ON`;
      yield* sql`CREATE TABLE positive(value INTEGER CHECK(value>0))`;
      yield* sql`INSERT INTO positive VALUES (-1)`;
      yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
      assert.deepEqual(yield* sql`PRAGMA ignore_check_constraints`.values, [[1]]);
      yield* sql`INSERT INTO positive VALUES (-2)`;
      yield* sql`PRAGMA ignore_check_constraints=OFF`;
      const failed = yield* sql`INSERT INTO positive VALUES (-3)`.pipe(Effect.flip);
      assert.equal(failed.reason._tag, "ConstraintError");
      yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
      assert.deepEqual(yield* sql`PRAGMA ignore_check_constraints`.values, [[0]]);
      assert.deepEqual(yield* sql`SELECT value FROM positive ORDER BY value`.values, [[-2], [-1]]);
    }),
  ),
);

it.effect.each(
  (
    [
      ["automatic_index", 0],
      ["reverse_unordered_selects", 1],
      ["read_uncommitted", 1],
      ["count_changes", 1],
      ["short_column_names", 0],
      ["full_column_names", 1],
      ["cell_size_check", 1],
      ["legacy_alter_table", 1],
      ["cache_spill", 0],
      ["secure_delete", 1],
      ["analysis_limit", 37],
      ["threads", 2],
      ["max_page_count", 1000],
    ] as const
  ).map(([name, value]) => ({ name, value })),
)("restores effective connection pragma $name=$value", ({ name, value }) =>
  withFileClient(
    (sql) =>
      Effect.gen(function* () {
        yield* sql.unsafe(`PRAGMA ${name}=${value}`);
        const before = yield* sql.unsafe(`PRAGMA ${name}`).values;
        assert.isNotEmpty(before);
        yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
        assert.deepEqual(yield* sql.unsafe(`PRAGMA ${name}`).values, before);
      }),
    { readerWorker: false },
  ),
);

it.effect.each(["delete", "truncate", "persist", "memory", "off", "wal"] as const)(
  "restores effective file journal mode %s",
  (mode) =>
    withFileClient(
      (sql) =>
        Effect.gen(function* () {
          yield* sql.unsafe(`PRAGMA journal_mode=${mode}`);
          const before = yield* sql`PRAGMA journal_mode`.values;
          yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
          assert.deepEqual(yield* sql`PRAGMA journal_mode`.values, before);
        }),
      { readerWorker: false },
    ),
);

it.effect.each(["temp", "scratch"] as const)(
  "keeps recovery metadata stable with full qualified column names (%s)",
  (schema) =>
    withFileClient((sql) =>
      Effect.gen(function* () {
        if (schema === "scratch") yield* sql`ATTACH DATABASE ':memory:' AS scratch`;
        yield* sql`PRAGMA short_column_names=OFF`;
        yield* sql`PRAGMA full_column_names=ON`;
        yield* sql.unsafe(`CREATE TABLE ${schema}.entries(value INTEGER)`);
        yield* sql.unsafe(`INSERT INTO ${schema}.entries VALUES (1)`);
        yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
        assert.deepEqual(yield* sql`PRAGMA short_column_names`.values, [[0]]);
        assert.deepEqual(yield* sql`PRAGMA full_column_names`.values, [[1]]);
        yield* sql.unsafe(`INSERT INTO ${schema}.entries VALUES (2)`);
        assert.deepEqual(yield* sql.unsafe(`SELECT value FROM ${schema}.entries`).values, [[2]]);
      }),
    ),
);

it.effect("refuses recovery after a supported setting whose effective value cannot be read", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA case_sensitive_like=ON`;
      assert.deepEqual(yield* sql`SELECT 'a' LIKE 'A' AS value`.values, [[0]]);
      const count = writerWorkers.length;
      yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
      const failed = yield* sql`SELECT 'a' LIKE 'A' AS value`.pipe(Effect.flip);
      assert.include(String(failed.reason.cause), "connection state could not be observed");
      assert.equal(writerWorkers.length, count);
    }),
  ),
);

it.effect(
  "keeps recovery available after ignored pragmas and argument-bearing metadata reads",
  () =>
    withFileClient((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE pragma_entries(value INTEGER)`;
        yield* sql`PRAGMA unknown_test_setting=ON`;
        yield* sql`PRAGMA table_info(pragma_entries)`;
        yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pragma_entries`.values, [[0]]);
      }),
    ),
);

it.effect.each(
  (["scratch", "aux"] as const).flatMap((target) =>
    (["scratch first", "aux first"] as const).flatMap((order) =>
      (["table", "view"] as const).map((kind) => ({ target, order, kind })),
    ),
  ),
)("restores a temp trigger on attached $target $kind ($order)", ({ target, order, kind }) =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      for (const schema of order === "scratch first" ? ["scratch", "aux"] : ["aux", "scratch"]) {
        yield* sql.unsafe(`ATTACH DATABASE ':memory:' AS ${schema}`);
        yield* sql.unsafe(`CREATE TABLE ${schema}.entries(value INTEGER)`);
        yield* sql.unsafe(`CREATE VIEW ${schema}.entry_view AS SELECT value FROM entries`);
      }
      yield* sql`CREATE TEMP TABLE capture_log(value INTEGER)`;
      const targetName = `${target}.${kind === "table" ? "entries" : "entry_view"}`;
      yield* sql.unsafe(
        `CREATE TEMP TRIGGER capture ${kind === "table" ? "AFTER" : "INSTEAD OF"} INSERT ON ${targetName} BEGIN INSERT INTO capture_log VALUES (new.value); END`,
      );
      yield* sql.unsafe(`INSERT INTO ${targetName} VALUES (1)`);
      assert.deepEqual(yield* sql`SELECT value FROM temp.capture_log`.values, [[1]]);
      yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
      yield* sql.unsafe(`INSERT INTO ${targetName} VALUES (2)`);
      assert.deepEqual(yield* sql`SELECT value FROM temp.capture_log`.values, [[2]]);
    }),
  ),
);

it.effect.each([
  "db.statement.execution_ms",
  "db.execution.thread",
  "db.transaction.control.commit_ms",
  "db.transaction.control.commit_count",
  "db.rows_returned",
  "db.stmt_status.available",
  "db.commit.at_ms",
  "db.commit.duration_ms",
  "db.commit.boundary",
])("keeps worker acknowledgement and errors intact when %s annotation throws", (attribute) => {
  let enabled = false;
  let committing = false;
  let commitThrows = 0;
  let commits = 0;
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const annotate = span.attribute.bind(span);
      span.attribute = (key, value) => {
        annotate(key, value);
        if (enabled && key === attribute) {
          if (committing) commitThrows++;
          throw new Error("test annotation failure");
        }
      };
      return span;
    },
  });
  return withFileClient(
    (sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE annotation_entries(value INTEGER UNIQUE)`;
        enabled = true;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* sql.reserve;
            const execute = (statement: string) =>
              connection
                .executeUnprepared(statement, [], undefined)
                .pipe(Effect.withSpan("annotation-statement"));
            yield* execute("BEGIN");
            yield* execute("INSERT INTO annotation_entries VALUES (1)");
            committing = true;
            yield* execute("COMMIT").pipe(
              Effect.provideService(SqliteClient.TransactionCommitObserver, () => {
                commits++;
              }),
            );
            committing = false;
            assert.equal(commits, 1);
            assert.isAbove(commitThrows, 0);
            const failed = yield* execute("INSERT INTO annotation_entries VALUES (1)").pipe(
              Effect.flip,
            );
            assert.equal(failed.reason._tag, "UniqueViolation");
            yield* execute("INSERT INTO annotation_entries VALUES (2)");
          }),
        );
        enabled = false;
        yield* Effect.promise(() => writerWorkers.at(-1)!.terminate());
        assert.deepEqual(yield* sql`SELECT value FROM annotation_entries ORDER BY value`.values, [
          [1],
          [2],
        ]);
        assert.equal(commits, 1);
      }),
    { statementMetrics: true },
  ).pipe(Effect.withTracer(tracer), Effect.provideService(Statement.SpanPropagationEnabled, true));
});

it.effect.each(
  (["attach", "detach"] as const).flatMap((operation) =>
    (["file", "memory"] as const).flatMap((target) =>
      (["query", "attach", "detach", "crash"] as const).flatMap((followup) =>
        (["database list", "deferral"] as const).map((fault) => ({
          operation,
          target,
          followup,
          fault,
        })),
      ),
    ),
  ),
)(
  "reconciles $operation of $target after $fault metadata failure before $followup",
  ({ operation, target, followup, fault }) =>
    withFileClient((sql, filename) =>
      Effect.gen(function* () {
        const attachment = target === "memory" ? ":memory:" : `${filename}.scratch`;
        if (target === "file") {
          const native = yield* openDatabase(attachment);
          native.exec("CREATE TABLE entries(value INTEGER); INSERT INTO entries VALUES (1)");
        }
        yield* sql`ATTACH DATABASE ${`${filename}.stable`} AS stable`;
        if (operation === "detach") yield* sql`ATTACH DATABASE ${attachment} AS scratch`;
        if (fault === "deferral") yield* sql`PRAGMA defer_foreign_keys=ON`;
        const writer = writerWorkers.at(-1)!;
        const count = writerWorkers.length;
        const message = {
          testCheckpoint: true,
          kind: fault === "deferral" ? "fail-attachment-deferral" : "fail-attachments",
          args: [1],
        };
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        writer.postMessage(message);
        yield* writerBridgeBarrier(writer);
        if (operation === "attach") yield* sql`ATTACH DATABASE ${attachment} AS scratch`;
        else yield* sql`DETACH DATABASE scratch`;
        if (followup === "query") assert.deepEqual(yield* sql`SELECT 1 AS value`, [{ value: 1 }]);
        else if (followup === "attach") yield* sql`ATTACH DATABASE ${`${filename}.extra`} AS extra`;
        else if (followup === "detach") yield* sql`DETACH DATABASE stable`;
        yield* Effect.promise(() => writer.terminate());
        if (followup === "crash") {
          const unavailable = yield* sql`SELECT 1`.pipe(Effect.flip);
          assert.include(
            String(unavailable.reason.cause),
            "connection state could not be observed",
          );
          assert.equal(writerWorkers.length, count);
          return;
        }
        const names = new Set(
          (yield* sql<{ name: string }>`PRAGMA database_list`).map((row) => row.name),
        );
        assert.equal(names.has("scratch"), operation === "attach");
        assert.equal(names.has("stable"), followup !== "detach");
        assert.equal(names.has("extra"), followup === "attach");
        assert.equal(writerWorkers.length, count + 1);
        if (operation === "attach") {
          if (target === "memory") {
            yield* sql`CREATE TABLE scratch.entries(value INTEGER)`;
            yield* sql`INSERT INTO scratch.entries VALUES (2)`;
          }
          assert.deepEqual(yield* sql`SELECT value FROM scratch.entries`.values, [
            [target === "file" ? 1 : 2],
          ]);
        }
      }),
    ),
);

it.effect.each(["attach", "detach"] as const)(
  "retains a pending $s while repeated metadata failure rejects another attachment change",
  (operation) =>
    withFileClient((sql, filename) =>
      Effect.gen(function* () {
        const attachment = `${filename}.scratch`;
        if (operation === "detach") yield* sql`ATTACH DATABASE ${attachment} AS scratch`;
        const writer = writerWorkers.at(-1)!;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        writer.postMessage({ testCheckpoint: true, kind: "fail-attachments", args: [3] });
        yield* writerBridgeBarrier(writer);
        if (operation === "attach") yield* sql`ATTACH DATABASE ${attachment} AS scratch`;
        else yield* sql`DETACH DATABASE scratch`;
        const failed = yield* sql`ATTACH DATABASE ${`${filename}.extra`} AS extra`.pipe(
          Effect.flip,
        );
        assert.equal(failed._tag, "SqlError");
        assert.include(String(failed.reason.cause), "test attachment metadata failure");
        const names = new Set(
          (yield* sql<{ name: string }>`PRAGMA database_list`).map((row) => row.name),
        );
        assert.equal(names.has("scratch"), operation === "attach");
        assert.isFalse(names.has("extra"));
        yield* sql`ATTACH DATABASE ${`${filename}.extra`} AS extra`;
        yield* Effect.promise(() => writer.terminate());
        const reopened = new Set(
          (yield* sql<{ name: string }>`PRAGMA database_list`).map((row) => row.name),
        );
        assert.equal(reopened.has("scratch"), operation === "attach");
        assert.isTrue(reopened.has("extra"));
      }),
    ),
);

it.effect.each([false, true])(
  "keeps a commit successful when its recovery metadata fails (recapture=%s)",
  (recapture) =>
    withFileClient((sql, filename) =>
      Effect.gen(function* () {
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`CREATE TABLE metadata_entries(value INTEGER)`;
        const writer = writerWorkers.at(-1)!;
        const count = writerWorkers.length;
        let commits = 0;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE TEMP TABLE metadata_buffer(value INTEGER)`;
              yield* sql`INSERT INTO metadata_entries VALUES (1)`;
              // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
              writer.postMessage({ testCheckpoint: true, kind: "fail-metadata", args: [1] });
              yield* writerBridgeBarrier(writer);
            }),
          )
          .pipe(
            Effect.provideService(SqliteClient.TransactionCommitObserver, () => {
              commits++;
            }),
          );
        assert.equal(commits, 1);
        const observer = yield* openDatabase(filename);
        assert.deepEqual(observer.prepare("SELECT value FROM metadata_entries").all(), [
          { value: 1 },
        ]);
        if (recapture) {
          assert.deepEqual(yield* sql`SELECT 1 AS value`, [{ value: 1 }]);
        }
        yield* Effect.promise(() => writer.terminate());
        if (recapture) {
          assert.deepEqual(yield* sql`SELECT value FROM metadata_entries`, [{ value: 1 }]);
          assert.equal(writerWorkers.length, count + 1);
          assert.deepEqual(yield* sql`SELECT value FROM temp.metadata_buffer`, []);
        } else {
          for (let attempt = 0; attempt < 2; attempt++) {
            const unavailable = yield* sql`SELECT value FROM metadata_entries`.pipe(Effect.flip);
            assert.include(
              String(unavailable.reason.cause),
              "connection state could not be observed",
            );
            assert.equal(writerWorkers.length, count);
          }
        }
        assert.equal(commits, 1);
        assert.deepEqual(observer.prepare("SELECT value FROM metadata_entries").all(), [
          { value: 1 },
        ]);
      }),
    ),
);

it.effect(
  "reports a checkpoint database error once and resumes writes on automatic checkpoints",
  () => {
    const { warnings, layer: logs } = captureWarnings();
    const failures: string[] = [];
    return withCheckpointClient(
      (sql) =>
        Effect.gen(function* () {
          const checkpoint = startedWorkers.at(-1)!;
          checkpoint.emit("message", {
            type: "db-error",
            errcode: 11,
            errstr: "test checkpoint corruption",
            code: "ERR_SQLITE_ERROR",
          });
          yield* writerBridgeBarrier();
          assert.deepEqual(yield* sql`PRAGMA wal_autocheckpoint`, [{ wal_autocheckpoint: 1000 }]);
          yield* sql`CREATE TABLE after_checkpoint_error(value INTEGER)`;
          yield* sql.withTransaction(sql`INSERT INTO after_checkpoint_error VALUES (1)`);
          assert.deepEqual(yield* sql`SELECT value FROM after_checkpoint_error`, [{ value: 1 }]);
          assert.deepEqual(failures, ["checkpoint"]);
          assert.lengthOf(warnings, 1);
        }),
      {
        errorObserver: (_cause, context) => {
          failures.push(context.connection);
        },
      },
    ).pipe(Effect.provide(logs));
  },
);

it.effect(
  "preserves attached archives and snapshot consistency across writer transactions and reader replacement",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-archive-" });
      const filename = path.join(directory, "state.sqlite");
      const archivePath = path.join(directory, "archive.sqlite");
      const archive = yield* openDatabase(archivePath);
      archive.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO entries VALUES (2, 'archived')",
      );
      const attach = `ATTACH DATABASE '${archivePath.replaceAll("'", "''")}' AS archive`;
      const view =
        "CREATE TEMP VIEW all_entries AS SELECT * FROM main.entries UNION ALL SELECT * FROM archive.entries";
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT)`;
        yield* sql`INSERT INTO entries VALUES (1, 'live')`;
        yield* sql.unsafe(attach).unprepared;
        yield* sql.unsafe(view).unprepared;
        const expected = [
          [1, "live"],
          [2, "archived"],
        ];
        assert.deepEqual(
          yield* sql`SELECT id, value FROM all_entries ORDER BY id`.values,
          expected,
        );
        const moveRequested = yield* Deferred.make<void>();
        const move = yield* Deferred.await(moveRequested).pipe(
          Effect.andThen(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO archive.entries SELECT * FROM main.entries`;
                yield* sql`DELETE FROM main.entries`;
              }),
            ),
          ),
          Effect.forkChild,
        );
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              assert.deepEqual(
                yield* sql`SELECT id, value FROM all_entries ORDER BY id`.values,
                expected,
              );
              yield* Deferred.succeed(moveRequested, undefined);
              yield* Fiber.join(move);
              assert.deepEqual(
                yield* sql`SELECT id, value FROM all_entries ORDER BY id`.values,
                expected,
              );
            }),
          )
          .pipe(SqliteClient.readOnly);
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM main.entries`, [{ count: 0 }]);
        assert.deepEqual(
          yield* sql`SELECT id, value FROM all_entries ORDER BY id`.values.pipe(
            SqliteClient.readOnly,
          ),
          expected,
        );
        const reader = startedWorkers.at(-1)!;
        yield* Effect.promise(() => reader.terminate());
        assert.deepEqual(
          yield* sql`SELECT id, value FROM all_entries ORDER BY id`.values.pipe(
            SqliteClient.readOnly,
          ),
          expected,
        );
        assert.notStrictEqual(startedWorkers.at(-1), reader);
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename,
            readerWorker: true,
            readerInitializationSql: [attach, view],
            readerSnapshotSql: [
              "SELECT COUNT(*) FROM main.entries",
              "SELECT COUNT(*) FROM archive.entries",
            ],
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
