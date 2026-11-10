// @effect-diagnostics nodeBuiltinImport:off -- private SQLite reader process transport.
import * as NodeUtil from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import { identity } from "effect/Function";
import type { SqliteClientConfig } from "./nodeSqliteClient.ts";
import { startReaderProcess, type ReaderRuntime } from "./nodeSqliteReaderProcess.ts";
import { markNotStarted, readerBusy } from "./nodeSqliteReaderLanes.ts";

// Autocommit reads a process may still be finishing for callers that left.
const MAX_ABANDONED_READS = 16;
export const ReadOnly = Context.Reference<typeof Effect.interruptible | undefined>(
  "@t3tools/shared/nodeSqliteClient/ReadOnly",
  { defaultValue: () => undefined },
);
const retirements = new WeakMap<Connection, () => Promise<unknown>>();
export const retireAuthReader = (connection: Connection): Effect.Effect<void> =>
  Effect.asVoid(Effect.promise(() => retirements.get(connection)?.() ?? Promise.resolve()));

const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

/**
 * SQLite keeps its copy of a statement's text and blob parameters until the
 * statement is bound again or finalized, and `node:sqlite` cannot clear them.
 */
const LARGE_BINDING_SIZE = 64 * 1024;

const isBlob = (value: unknown): value is ArrayBufferView | ArrayBufferLike =>
  ArrayBuffer.isView(value) || NodeUtil.types.isAnyArrayBuffer(value);

const bindingSize = (value: unknown): number => {
  if (typeof value === "string") {
    return value.length;
  }
  return isBlob(value) ? value.byteLength : 0;
};

const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      if (
        (typeof param === "object" || typeof param === "function") &&
        param !== null &&
        !isBlob(param)
      ) {
        // `node:sqlite` takes named parameters as one object, callable or not.
        // Read data properties only: calling a getter here would run it twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          size += bindingSize(property.value);
        }
      } else {
        size += bindingSize(param);
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    return true;
  }
};

const readerWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  // A read-only open cannot be undone by SQL, unlike PRAGMA query_only.
  const next = new DatabaseSync(workerData.filename, {
    readOnly: true,
    allowExtension: workerData.allowExtension,
  });
  next.exec("PRAGMA busy_timeout = 5000;");
  // Sorts spill to temp files past cache_size; at the 2 MB default the shell
  // snapshot sort spilled on every read. Same size as the server's writer.
  next.exec("PRAGMA cache_size = -65536;");
  // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  for (const sql of workerData.initializationSql) next.exec(sql);
  next.exec("PRAGMA foreign_keys = ON; PRAGMA query_only = ON;");
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "unavailable", message: String(error && error.message ? error.message : error) });
}
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) return db.prepare(sql);
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  } else {
    statements.delete(sql);
  }
  statements.set(sql, statement);
  return statement;
};
parentPort.on("message", ({ id, sql, params, cached, values, raw, safeIntegers }) => {
  if (workerData.reportStarted) parentPort.postMessage({ started: id });
  let operation = "open";
  try {
    if (db === undefined) throw new Error("database reader is unavailable");
    operation = "prepare";
    const statement = prepare(sql, cached);
    operation = "execute";
    statement.setReadBigInts(safeIntegers);
    if (statement.columns().length > 0) {
      statement.setReturnArrays(values);
      parentPort.postMessage({ id, rows: statement.all(...params) });
    } else {
      const result = statement.run(...params);
      parentPort.postMessage({ id, rows: raw ? result : [] });
    }
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        operation,
        message: String(error && error.message ? error.message : error),
        code: error && error.code,
        errcode: error && error.errcode,
        errstr: error && error.errstr,
      },
    });
  }
});
`;

interface ReaderRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
}

type ReaderStartup =
  | { readonly type: "ready" }
  | { readonly type: "unavailable"; readonly message: string };

type ReaderReply =
  | { readonly id: number; readonly rows: ReadonlyArray<any> }
  | {
      readonly id: number;
      readonly error: {
        readonly operation: "open" | "prepare" | "execute";
        readonly message: string;
        readonly code?: unknown;
        readonly errcode?: unknown;
        readonly errstr?: unknown;
      };
    };

const readerFailureMessages = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const failed = (cause: unknown, message: string, operation: string) =>
  new SqlError({ reason: classifyError(cause, message, operation) });

// COMMIT, ROLLBACK and ROLLBACK TO SAVEPOINT. On a reader they change nothing,
// so they succeed once the worker is gone instead of failing the cleanup.
const endsReadTransaction = (sql: string) => /^\s*ROLLBACK\b|^\s*COMMIT\b/i.test(sql);

/**
 * Each worker gets its own `Connection`, so a transaction stays on the worker
 * it began on: once that worker exits, its statements fail rather than silently
 * continuing outside the transaction on a replacement.
 */
export const makeAuthReader = Effect.fnUntraced(function* (
  options: SqliteClientConfig,
  awaitStartup: (started: Promise<ReaderStartup>) => Effect.Effect<ReaderStartup> = (started) =>
    Effect.promise(() => started),
) {
  const snapshotLock = options.readerSnapshotLock ?? (yield* Semaphore.make(1));
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const slowStatementMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.readerSlowStatement ?? Duration.seconds(10)),
  );
  const statementLimitMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.readerStatementLimit ?? Duration.seconds(5)),
  );
  // An autocommit statement still running after this long means the process is
  // wedged, not slow: retire it. Callers already left at statementLimitMs.
  const wedgeLimitMs = Math.max(
    statementLimitMs,
    options.readerWedgeLimit === undefined
      ? Math.max(30_000, 6 * statementLimitMs)
      : Duration.toMillis(Duration.fromInputUnsafe(options.readerWedgeLimit)),
  );
  let current:
    | {
        readonly worker: ReaderRuntime;
        readonly connection: Connection;
        readonly started: Promise<ReaderStartup>;
        readonly isOpening: () => boolean;
        /** Acquisitions waiting for this process to open. */
        waiters: number;
      }
    | undefined;
  const runtimes = new Set<ReaderRuntime>();
  let retiring: Promise<unknown> = Promise.resolve();
  let nextRequestId = 0;

  const start = () => {
    const data = {
      filename: options.filename,
      allowExtension: options.allowExtension ?? false,
      prepareCacheSize: options.prepareCacheSize ?? 200,
      initializationSql: options.readerInitializationSql ?? [],
      reportStarted: false,
      // The child's own SIGKILL guard (it also bounds an orphan). The watchdog
      // below enforces the transaction and snapshot limits; arming the guard at
      // the statement limit killed every slow autocommit read in-process
      // ("exited with code null"), whatever the parent decided.
      statementLimitMs: wedgeLimitMs,
    };
    const worker: ReaderRuntime = startReaderProcess(readerWorkerSource, data);
    runtimes.add(worker);
    worker.on("exit", () => runtimes.delete(worker));
    if (worker.completion !== undefined) void worker.completion.then(() => runtimes.delete(worker));
    let opening = true;
    let announce: (startup: ReaderStartup) => void = () => {};
    const started = new Promise<ReaderStartup>((resolve) => {
      announce = (startup) => {
        if (startup.type === "ready") opening = false;
        resolve(startup);
      };
    });
    let stoppedMessage: string | undefined;
    interface PendingRead {
      readonly endsTransaction: boolean;
      readonly sql: string;
      readonly resume: (reply: ReaderReply) => void;
      readonly reject: (error: SqlError) => void;
      /** A statement outside any transaction on this connection. */
      readonly autocommit: boolean;
      readonly enqueuedAt: number;
      readonly settle: () => void;
      readonly settled: Promise<void>;
      /** When the worker (which runs one statement at a time) reached it. */
      execAt?: number;
      reported?: boolean;
      /** The caller gave up; the child still finishes it and its reply is dropped. */
      abandoned?: boolean;
    }
    const pending = new Map<number, PendingRead>();
    let abandonedCount = 0;
    // A BEGIN posted on this connection and not yet ended by COMMIT/ROLLBACK.
    let transactionOpen = false;
    // The worker runs one statement at a time; this is the one it last started.
    let running: number | undefined;
    let snapshotStartedAt: number | undefined;
    const startRunning = (id: number | undefined) => {
      running = id;
      const next = id === undefined ? undefined : pending.get(id);
      if (next !== undefined && next.execAt === undefined) next.execAt = performance.now();
    };
    // A caller that waited past the statement limit gets a typed "busy" and
    // leaves; the process keeps running the statement (an I/O stall is not a
    // wedge). Only autocommit reads are abandoned: a transaction keeps the
    // retire-on-limit rule below, which protects WAL checkpoints.
    const abandon = (entry: PendingRead) => {
      if (entry.abandoned) return;
      entry.abandoned = true;
      abandonedCount++;
      entry.reject(
        readerBusy(
          `Reader lane busy: no answer within ${statementLimitMs} ms`,
          entry.execAt !== undefined,
        ),
      );
      entry.settle();
    };
    // One statement must not hold every read in the process: report a slow one
    // with its SQL, and past the limit retire the worker so new reads get a
    // fresh one. Autocommit statements get the longer wedge limit. Retirement
    // waits for physical process exit.
    // @effect-diagnostics-next-line globalTimers:off -- watches a worker that may block for hours; it must not wait on any fiber.
    const watchdog = setInterval(() => {
      if (stoppedMessage !== undefined) return;
      const now = performance.now();
      if (snapshotStartedAt !== undefined && now - snapshotStartedAt >= statementLimitMs) {
        stop("Database reader retired: snapshot duration limit exceeded");
        void worker.terminate();
        return;
      }
      for (const entry of pending.values())
        if (entry.autocommit && !entry.abandoned && now - entry.enqueuedAt >= statementLimitMs)
          abandon(entry);
      if (running === undefined) return;
      const request = pending.get(running);
      if (request?.execAt === undefined) return;
      const elapsedMs = Math.round(now - request.execAt);
      const limitMs = request.autocommit ? wedgeLimitMs : statementLimitMs;
      const details = {
        sql: request.sql.replace(/\s+/g, " ").trim().slice(0, 2000),
        elapsedMs,
        queued: pending.size - 1,
        abandoned: abandonedCount,
      };
      if (elapsedMs >= limitMs) {
        runFork(
          Effect.logError(
            "SQLite reader statement exceeded its limit; reader worker retired",
            details,
          ),
        );
        stop(`Database reader retired: a statement ran longer than ${limitMs} ms`);
        void worker.terminate();
      } else if (elapsedMs >= slowStatementMs && !request.reported) {
        request.reported = true;
        runFork(Effect.logWarning("SQLite reader statement is slow", details));
      }
    }, 250);
    watchdog.unref();
    const stop = (message: string) => {
      // A retirement terminates the worker, whose exit then reports here too.
      if (stoppedMessage !== undefined) return;
      clearInterval(watchdog);
      running = undefined;
      stoppedMessage = message;
      announce({ type: "unavailable", message });
      if (current?.worker === worker) current = undefined;
      retiring = worker.terminate();
      for (const [id, request] of pending) {
        if (request.abandoned) {
          request.settle();
          continue;
        }
        if (request.endsTransaction && !/^\s*COMMIT\b/i.test(request.sql)) {
          const reply: ReaderReply = { id, rows: [] };
          void retiring.then(() => {
            request.resume(reply);
            request.settle();
          });
          continue;
        }
        const error = failed(new Error(message), readerFailureMessages.execute, "execute");
        // A read the worker never reached ran nothing and may be retried.
        if (request.execAt === undefined) markNotStarted(error);
        void retiring.then(() => {
          request.reject(error);
          request.settle();
        });
      }
      pending.clear();
      abandonedCount = 0;
    };
    worker.on("message", (reply: ReaderReply | ReaderStartup | { readonly started: number }) => {
      if ("type" in reply) {
        announce(reply);
        if (pending.size === 0) worker.unref();
        return;
      }
      if ("started" in reply) {
        const request = pending.get(reply.started);
        if (request !== undefined) request.execAt = performance.now();
        running = reply.started;
        return;
      }
      if (running === reply.id) running = undefined;
      const request = pending.get(reply.id);
      if (request === undefined) return;
      pending.delete(reply.id);
      startRunning(pending.keys().next().value);
      if (!("error" in reply)) {
        if (/^\s*BEGIN\b/i.test(request.sql)) snapshotStartedAt = performance.now();
        if (/^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(request.sql)) snapshotStartedAt = undefined;
      }
      if (pending.size === 0) worker.unref();
      if (request.abandoned) {
        abandonedCount--;
        return;
      }
      setImmediate(() => {
        request.resume(reply);
        request.settle();
      });
    });
    worker.on("error", (cause) => stop(`Database reader failed: ${cause.message}`));
    worker.on("exit", (code) => stop(`Database reader exited with code ${code}`));

    const request = (input: ReaderRequest) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const endsTransaction = endsReadTransaction(input.sql);
        if (stoppedMessage !== undefined) {
          const result =
            endsTransaction && !/^\s*COMMIT\b/i.test(input.sql)
              ? Effect.succeed([])
              : Effect.fail(
                  markNotStarted(
                    failed(new Error(stoppedMessage), readerFailureMessages.execute, "execute"),
                  ),
                );
          return Effect.andThen(
            Effect.promise(() => retiring),
            result,
          );
        }
        const beginsTransaction = /^\s*BEGIN\b/i.test(input.sql);
        const endsWholeTransaction = /^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(input.sql);
        const autocommit =
          !transactionOpen &&
          !beginsTransaction &&
          !/^\s*(?:COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(input.sql);
        // Backpressure: a process still finishing many abandoned reads answers
        // new ones with "busy" at once instead of queueing them behind it.
        if (autocommit && abandonedCount >= MAX_ABANDONED_READS)
          return Effect.fail(
            readerBusy(`Reader lane busy: ${abandonedCount} abandoned reads still running`, false),
          );
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        return Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
          const id = nextRequestId++;
          let settle: () => void = () => {};
          const settled = new Promise<void>((resolve) => {
            settle = resolve;
          });
          const entry: PendingRead = {
            endsTransaction,
            sql: input.sql,
            autocommit,
            enqueuedAt: performance.now(),
            settle,
            settled,
            reject: (error) => resume(Effect.fail(error)),
            resume: (reply) => {
              if ("rows" in reply) {
                resume(Effect.succeed(reply.rows));
                return;
              }
              const { operation, message, ...codes } = reply.error;
              resume(
                Effect.fail(
                  failed(
                    Object.assign(new Error(message), codes),
                    readerFailureMessages[operation],
                    operation,
                  ),
                ),
              );
            },
          };
          pending.set(id, entry);
          if (beginsTransaction) transactionOpen = true;
          if (endsWholeTransaction) transactionOpen = false;
          if (pending.size === 1) {
            worker.ref();
            startRunning(id);
          }
          const cached = input.cached && !hasLargeBinding(input.params);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage({ id, safeIntegers, ...input, cached });
          return Effect.suspend(() => {
            if (!pending.has(id) || entry.abandoned)
              return stoppedMessage === undefined
                ? Effect.void
                : Effect.asVoid(Effect.promise(() => retiring));
            // An autocommit read keeps its permit until the statement finishes
            // or passes the statement limit (then it is abandoned and the child
            // finishes it); a cancelled HTTP request no longer kills the process.
            if (entry.autocommit) return Effect.promise(() => entry.settled);
            // IPC cannot share the worker's abandoned bitmap. Keep the borrowed
            // permit until the submitted transaction work is physically gone.
            stop("Database reader retired: request interrupted");
            return Effect.asVoid(Effect.promise(() => retiring));
          });
        });
      });

    let snapshotTransaction = false;
    const pinSnapshots = Effect.forEach(
      options.readerSnapshotSql ?? [],
      (sql) => request({ sql, params: [], cached: true, values: false, raw: false }),
      { discard: true },
    );
    const withSnapshot = <A>(sql: string, effect: Effect.Effect<A, SqlError>) =>
      Effect.suspend(() => {
        if (
          snapshotTransaction ||
          options.readerSnapshotSql === undefined ||
          !/ardud_(?:archive|\w*history|turn_items)/i.test(sql)
        )
          return effect;
        return Effect.uninterruptibleMask((restore) =>
          snapshotLock
            .withPermits(1)(
              request({ sql: "BEGIN", params: [], cached: false, values: false, raw: false }).pipe(
                Effect.andThen(pinSnapshots),
              ),
            )
            .pipe(
              Effect.andThen(restore(effect)),
              Effect.ensuring(
                request({
                  sql: "ROLLBACK",
                  params: [],
                  cached: false,
                  values: false,
                  raw: false,
                }).pipe(Effect.ignore),
              ),
            ),
        );
      });
    const connection = identity<Connection>({
      execute(sql, params, rowTransform) {
        const effect = withSnapshot(
          sql,
          request({ sql, params, cached: true, values: false, raw: false }),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeRaw(sql, params) {
        return withSnapshot(sql, request({ sql, params, cached: true, values: false, raw: true }));
      },
      executeValues(sql, params) {
        return withSnapshot(sql, request({ sql, params, cached: true, values: true, raw: false }));
      },
      executeValuesUnprepared(sql, params) {
        return withSnapshot(
          sql,
          request({ sql, params: params ?? [], cached: false, values: true, raw: false }),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        // A read-only connection rejects BEGIN IMMEDIATE and BEGIN EXCLUSIVE,
        // and a deferred BEGIN is all a read snapshot needs.
        const statement = /^\s*BEGIN\b/i.test(sql) ? "BEGIN" : sql;
        const effect = request({
          sql: statement,
          params: params ?? [],
          cached: false,
          values: false,
          raw: false,
        });
        if (/^\s*BEGIN\b/i.test(sql) && options.readerSnapshotSql !== undefined) {
          // WAL snapshots are per attached DB. Pin both while no archive mover
          // can replace a cold row between their snapshot acquisitions.
          return Effect.uninterruptible(
            snapshotLock.withPermits(1)(
              effect.pipe(
                Effect.andThen(pinSnapshots),
                Effect.tap(() =>
                  Effect.sync(() => {
                    snapshotTransaction = true;
                  }),
                ),
                Effect.as([]),
              ),
            ),
          ).pipe(
            Effect.onError(() =>
              request({
                sql: "ROLLBACK",
                params: [],
                cached: false,
                values: false,
                raw: false,
              }).pipe(Effect.ignore),
            ),
          );
        }
        if (/^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql))
          return effect.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                snapshotTransaction = false;
              }),
            ),
          );
        if (/^\s*(?:SAVEPOINT|RELEASE|ROLLBACK TO)\b/i.test(sql)) return effect;
        const snapshot = withSnapshot(sql, effect);
        return rowTransform ? Effect.map(snapshot, rowTransform) : snapshot;
      },
      executeStream(_sql, _params) {
        return Stream.die(new Error("Auth reader does not support streams"));
      },
    });
    retirements.set(connection, () => {
      stop("Database auth reader retired: transaction interrupted or failed");
      return retiring;
    });
    current = { worker, connection, started, isOpening: () => opening, waiters: 0 };
    return current;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await Promise.all([...runtimes].map((runtime) => runtime.terminate()));
    }),
  );

  const startupTimeout = Duration.fromInputUnsafe(
    options.readerStartupTimeout ?? Duration.seconds(10),
  );

  const turnOff = Effect.fn("SqliteAuthReader.turnOff")(function* (
    reader: typeof current,
    reason: string,
  ) {
    if (reader !== undefined) {
      if (current === reader) current = undefined;
      retiring = reader.worker.terminate();
      yield* Effect.promise(() => retiring);
    }
    yield* Effect.logWarning("SQLite auth process unavailable; verification fails closed", {
      reason,
    });
    return undefined;
  });

  const acquire = (retried: boolean): Effect.Effect<Connection | undefined> =>
    Effect.andThen(
      Effect.promise(() => retiring),
      Effect.suspend((): Effect.Effect<Connection | undefined> => {
        let reader: NonNullable<typeof current>;
        try {
          reader = current ?? start();
        } catch (cause) {
          return turnOff(undefined, String(cause));
        }
        reader.waiters++;
        return Effect.flatMap(
          Effect.withFiber((fiber) => {
            const restore = Context.get(fiber.context, ReadOnly) ?? identity;
            return restore(Effect.timeoutOption(awaitStartup(reader.started), startupTimeout)).pipe(
              // Only the last caller waiting for this start reaps it. A cancelled
              // request (a client that gave up) used to retire a process other
              // callers were waiting for, failing all of them (10 Nov 2026:
              // 2,599 "startup interrupted" retirements, 6,189 lane failures).
              Effect.onInterrupt(() =>
                Effect.suspend(() =>
                  reader.isOpening() && reader.waiters <= 1
                    ? turnOff(reader, "startup interrupted")
                    : Effect.void,
                ),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  reader.waiters--;
                }),
              ),
            );
          }),
          (startup): Effect.Effect<Connection | undefined> =>
            // Another acquire may have timed out and retired this worker while this one
            // waited; a late "ready" must not hand out a worker that is being terminated.
            // Nothing ran for this caller, so it tries the replacement once.
            current !== reader
              ? retried
                ? Effect.as(
                    Effect.promise(() => retiring),
                    undefined,
                  )
                : acquire(true)
              : Option.isSome(startup) && startup.value.type === "ready"
                ? Effect.succeed(reader.connection)
                : turnOff(
                    reader,
                    Option.isSome(startup) && startup.value.type === "unavailable"
                      ? startup.value.message
                      : `worker did not open the database within ${Duration.toMillis(startupTimeout)} ms`,
                  ),
        );
      }),
    );
  return acquire(false);
});
