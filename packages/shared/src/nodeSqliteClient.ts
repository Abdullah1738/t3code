import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Borrower, Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

import {
  makeAuthReader,
  ReadOnly,
  RESERVED_READER_WATCHDOG_MS,
  retireAuthReader,
} from "./nodeSqliteAuthReader.ts";
import {
  bindSemaphore,
  effectiveLane,
  ForegroundScope,
  isReservedLane,
  makeReaderLanes,
  makeReaderPool,
  ReaderLane,
  readerBusy,
} from "./nodeSqliteReaderLanes.ts";

export { ReaderLane, readerLaneFailure } from "./nodeSqliteReaderLanes.ts";
export type { ReaderLaneName } from "./nodeSqliteReaderLanes.ts";
import type { ReaderLaneName } from "./nodeSqliteReaderLanes.ts";

import {
  annotateSqliteError,
  ErrorObserver,
  type SqliteErrorObserver,
} from "./nodeSqliteErrors.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly databaseRole?: "primary" | "replica" | "unknown" | undefined;
  readonly errorObserver?: SqliteErrorObserver | undefined;
  /** Reserve a bounded process for fresh session lookups. */
  readonly authReaderProcess?: boolean | undefined;
  /**
   * Reserved (auth/identity) lanes: an autocommit statement still running this
   * long retires its process. Callers stop waiting at readerStatementLimit and
   * get a typed "busy". Default max(30 s, 6 x readerStatementLimit).
   */
  readonly readerWedgeLimit?: Duration.Input | undefined;
  /** Reserve a separate bounded process for execution identity lookups. */
  readonly identityReaderProcess?: boolean | undefined;

  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  /** Diagnostic row counts and commit timestamps; off unless explicitly enabled. */
  readonly statementMetrics?: boolean | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /**
   * Ignored for in-memory databases, which a second connection cannot share.
   */
  readonly readerWorker?: boolean | undefined;
  /**
   * Reader workers reserved for `foregroundReads` (interactive views), on top
   * of the default reader that serves the background lane. 0 (the default)
   * sends foreground reads to the default reader: the single-reader layout.
   * Needs `readerWorker`.
   */
  readonly foregroundReaderSlots?: number | undefined;
  /** Default-reader (background lane) slots; 1 (the default) is the single shared reader. */
  readonly backgroundReaderSlots?: number | undefined;
  /** Extra connection-local SQL for foreground slots, after `readerInitializationSql` (e.g. a smaller cache). */
  readonly foregroundReaderInitializationSql?: ReadonlyArray<string> | undefined;
  /** Reads queued or running per lane before new ones fail with "Reader lane admission queue full". */
  readonly readerQueueLimits?:
    | { readonly foreground?: number | undefined; readonly background?: number | undefined }
    | undefined;
  /** Approximate per-statement result budget for reader workers; 0 or unset = unbounded. */
  readonly readerMaxResultBytes?:
    | { readonly foreground?: number | undefined; readonly background?: number | undefined }
    | number
    | undefined;
  readonly readerStartupTimeout?: Duration.Input | undefined;
  /** Connection-local attachments/views, repeated when a reader worker is replaced. */
  readonly readerInitializationSql?: ReadonlyArray<string> | undefined;
  /** Pin related WAL snapshots under writer exclusion before reading them. */
  readonly readerSnapshotSql?: ReadonlyArray<string> | undefined;
  readonly readerSnapshotLock?: Semaphore.Semaphore | undefined;
  /** A reader statement running this long is logged once with its SQL. Default 10 s. */
  readonly readerSlowStatement?: Duration.Input | undefined;
  /**
   * A reader statement running this long retires its worker: that statement
   * fails, and reads that had not started move to a fresh worker, instead of
   * every read in the process waiting behind one statement. Default 2 minutes.
   */
  readonly readerStatementLimit?: Duration.Input | undefined;
  /**
   * Ignored for in-memory databases.
   */
  readonly checkpointWorker?: boolean | undefined;
  /** Defer routine checkpoints until startup completes; WAL backpressure still takes priority. */
  readonly checkpointWorkerStart?: Effect.Effect<void> | undefined;
  /** Used by split stores to gate public access until their background copy commits. */
  readonly beforeAcquire?: Effect.Effect<void> | undefined;
}

// SqlClient masks transaction acquisition, so readOnly carries the caller's interruption policy.
/**
 * Wrap the whole transaction, as in
 * `sql.withTransaction(reads).pipe(readOnly)`. Inside an open write transaction
 * the reads keep using the writer, and a write attempted on the reader fails
 * with "attempt to write a readonly database".
 */
export const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    restore(Effect.provideService(effect, ReadOnly, restore)),
  );

const ReaderRequired = Context.Reference<boolean>(
  "@t3tools/shared/nodeSqliteClient/ReaderRequired",
  {
    defaultValue: () => false,
  },
);

/** Wrap the whole read transaction to fail acquisition rather than borrow the writer. */
export const requireReader = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  readOnly(Effect.provideService(effect, ReaderRequired, true));

interface Acquired {
  readonly connection: "writer" | "reader";
  readonly lockWaitMs: number;
  readonly lane?: ReaderLaneName;
  readonly slot?: number;
}

/** Request-local acquisition accounting, independent of tracing and statement sampling. */
export const ReaderWaitObserver = Context.Reference<((waitMs: number) => void) | undefined>(
  "@t3tools/shared/nodeSqliteClient/ReaderWaitObserver",
  { defaultValue: () => undefined },
);

const reportReaderWait = (fiber: Fiber.Fiber<unknown, unknown>, waitMs: number) => {
  try {
    fiber.getRef(ReaderWaitObserver)?.(waitMs);
  } catch {
    // Observation must not change SQL acquisition or its exit.
  }
};

/** A routed connection: the writer, a lane slot, or a reserved auth/identity reader. */
interface RouteTarget {
  readonly name: "writer" | "reader";
  readonly lane?: ReaderLaneName;
  readonly slot?: number;
  readonly connection: Connection;
  readonly lock: {
    readonly take: (permits: number) => Effect.Effect<unknown, SqlError>;
    readonly release: (permits: number) => Effect.Effect<unknown>;
    readonly withPermits: (
      permits: number,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
    readonly withPermitsIfAvailable: (
      permits: number,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
  };
}

const annotateAcquired = (
  fiber: Fiber.Fiber<unknown, unknown>,
  acquired: Acquired | undefined,
  transactionSpan?: Tracer.Span,
) => {
  const span = transactionSpan ?? Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (span?._tag !== "Span" || acquired === undefined) return;
  span.attribute("db.connection", acquired.connection);
  span.attribute("db.lock_wait_ms", acquired.lockWaitMs);
  span.attribute("db.reader.acquired", true);
  span.attribute("db.reader.wait_ms", acquired.lockWaitMs);
  if (acquired.connection === "reader")
    span.attribute("db.reader.acquire_wait_ms", acquired.lockWaitMs);
  span.attribute("db.reader.waiting", false);
  if (acquired.lane !== undefined) span.attribute("db.reader.lane", acquired.lane);
  if (acquired.slot !== undefined) span.attribute("db.reader.slot", acquired.slot);
};

const annotateHold = (fiber: Fiber.Fiber<unknown, unknown>, holdMs: number) => {
  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (span?._tag === "Span") span.attribute("db.reader.hold_ms", holdMs);
};

const readerWait = Metric.timer("t3_sqlite_reader_wait", {
  description: "Time a read waited for its reader lane slot, by lane and database.",
});
const readerHold = Metric.timer("t3_sqlite_reader_hold", {
  description: "Time a read (or read transaction) held its reader lane slot, by lane and database.",
});

interface TransactionPending {
  readonly owner: object;
  readonly started: bigint;
  acquired?: Acquired;
  permitStarted?: bigint;
  restore: typeof Effect.interruptible | undefined;
  retire?: Effect.Effect<void>;
  /** The transaction's span, annotated with the reader hold when the permit is released. */
  span?: Tracer.Span;
}

const TransactionAcquire = Context.Reference<TransactionPending | undefined>(
  "@t3tools/shared/nodeSqliteClient/TransactionAcquire",
  { defaultValue: () => undefined },
);

/** Observes only a successful outer writer COMMIT, before the fiber can yield. */
export const TransactionCommitObserver = Context.Reference<(() => void) | undefined>(
  "@t3tools/shared/nodeSqliteClient/TransactionCommitObserver",
  { defaultValue: () => undefined },
);

export interface SqliteStatementObservation {
  readonly operation: "read" | "write";
  readonly connection: "reader" | "writer";
  readonly lane?: ReaderLaneName;
  readonly durationMs: number;
  readonly outcome: "success" | "failure" | "interrupt";
  readonly span?: string;
  readonly waitMs?: number;
}

export interface SqliteStatementObserver {
  readonly slowThresholdMs: number;
  readonly record: (observation: SqliteStatementObservation) => Effect.Effect<void>;
}

/** Metadata only: neither SQL, bindings, database paths nor causes cross this boundary. */
export const StatementObserver = Context.Reference<SqliteStatementObserver | undefined>(
  "@t3tools/shared/nodeSqliteClient/StatementObserver",
  { defaultValue: () => undefined },
);
const observingStatement = Context.Reference(
  "@t3tools/shared/nodeSqliteClient/observingStatement",
  {
    defaultValue: () => false,
  },
);

// Each SQL statement already owns its tracing span; observation adds no per-statement span.
const observeStatement = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  operation: () => "read" | "write",
  connection: "reader" | "writer",
  fallback: SqliteStatementObserver | undefined,
  lane?: ReaderLaneName,
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    if (fiber.getRef(References.TracerEnabled) && fiber.getRef(Statement.SpanPropagationEnabled)) {
      let span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
      for (let depth = 0; span?._tag === "Span" && depth < 32; depth++) {
        if (span.name === "sqlite") {
          // Transaction statements reuse their connection and bypass the borrower.
          if (!span.attributes.has("db.connection")) span.attribute("db.connection", connection);
          if (lane !== undefined && !span.attributes.has("db.reader.lane"))
            span.attribute("db.reader.lane", lane);
          break;
        }
        span = Option.getOrUndefined(span.parent);
      }
    }
    const observer = fiber.getRef(StatementObserver) ?? fallback;
    if (observer === undefined || fiber.getRef(observingStatement)) return effect;
    const clock = fiber.getRef(Clock.Clock);
    const started = clock.monotonicTimeNanosUnsafe();
    return effect.pipe(
      Effect.onExit((exit) =>
        Effect.suspend(() => {
          const durationMs = Math.max(0, Number(clock.monotonicTimeNanosUnsafe() - started) / 1e6);
          if (durationMs < observer.slowThresholdMs) return Effect.void;
          const parent = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
          let current = parent;
          let span: string | undefined;
          for (let depth = 0; current?._tag === "Span" && depth < 32; depth++) {
            if (
              current.name !== "sqlite" &&
              current.name !== "sql.transaction" &&
              /^[a-zA-Z0-9_.:/#@%+-]{1,160}$/.test(current.name)
            ) {
              span = current.name;
              break;
            }
            current = Option.getOrUndefined(current.parent);
          }
          // Only the statement's acquisition belongs to it; a transaction parent's wait must not repeat.
          const wait =
            parent?._tag === "Span" && parent.name === "sqlite"
              ? parent.attributes.get("db.lock_wait_ms")
              : undefined;
          return observer.record({
            operation: operation(),
            connection,
            durationMs,
            ...(lane === undefined ? {} : { lane }),
            ...(span === undefined ? {} : { span }),
            ...(typeof wait === "number" && Number.isFinite(wait) && wait >= 0
              ? { waitMs: wait }
              : {}),
            outcome: Exit.isSuccess(exit)
              ? "success"
              : Exit.hasInterrupts(exit)
                ? "interrupt"
                : "failure",
          });
        }).pipe(
          Effect.provideService(observingStatement, true),
          Effect.catchCause(() => Effect.void),
        ),
      ),
    );
  });

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/** Fresh committed auth lookup, isolated from the base reader queue. */
export const authReadOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  readOnly(Effect.provideService(effect, ReaderLane, "auth"));

/**
 * Interactive reads: shell pages, thread detail, board/discussion views and
 * transcript checks on a user action. Applies to every `readOnly` read in the
 * effect (and fibers it forks); reserved auth/identity lookups inside keep
 * their own lane. Without a foreground pool they use the default reader.
 */
export const foregroundReads = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const scope = { active: true };
    return effect.pipe(
      Effect.provideService(ReaderLane, "foreground"),
      Effect.provideService(ForegroundScope, scope),
      Effect.ensuring(
        Effect.sync(() => {
          scope.active = false;
        }),
      ),
    );
  });

/** Sweeps, recovery, maintenance and polling. Same as untagged; use it at loop roots so a sweep started from a foreground fiber does not inherit that lane. */
export const backgroundReads = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, ReaderLane, "background");

/** Identity lookups have their own bounded process and never queue behind auth or views. */
export const identityReadOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  readOnly(Effect.provideService(effect, ReaderLane, "identity"));

const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`.
 */
const classifyError = (
  cause: unknown,
  message: string,
  operation: string,
  options?: SqliteClientConfig,
  connection = "writer",
) => {
  if (options)
    annotateSqliteError(
      cause,
      {
        file: options.filename,
        role: options.databaseRole ?? "primary",
        connection,
        operation,
        span: `sqlite.${connection}.${operation}`,
      },
      options.errorObserver,
    );
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

// Evaluated source instead of a worker file, so the reader also starts from
// bundles and single-executable builds that have no module file on disk.
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
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "unavailable", message: String(error && error.message ? error.message : error), errcode: error && error.errcode, errstr: error && error.errstr, code: error && error.code });
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
const claims = new Int32Array(workerData.claims);
// Bounded results: past maxResultBytes (approximate decoded size) the statement
// fails instead of handing the main thread an unbounded structured clone.
const rowBytes = (row) => {
  let bytes = 16;
  for (const key in row) {
    const value = row[key];
    bytes += typeof value === "string" ? value.length * 2 : value !== null && typeof value === "object" ? value.byteLength || 8 : 8;
  }
  return bytes;
};
const collect = (statement, params) => {
  const limit = workerData.maxResultBytes;
  if (!(limit > 0)) return statement.all(...params);
  const rows = [];
  let bytes = 0;
  for (const row of statement.iterate(...params)) {
    bytes += rowBytes(row);
    if (bytes > limit) throw new Error("Reader result exceeds " + limit + " bytes");
    rows.push(row);
  }
  return rows;
};
parentPort.on("message", ({ id, sql, params, cached, values, raw, safeIntegers }) => {
  // Claim the request before running it. The parent cancels a request whose
  // caller gave up, so a backlog of timed-out requests cannot keep the reader
  // busy after a stall, and cancels the rest when it retires this worker.
  const tag = (id % 0x7fffffff) + 1;
  if (Atomics.compareExchange(claims, id & workerData.claimsMask, tag, -tag) !== tag) {
    // Its caller is gone; should a live one ever see this, it must not read as empty rows.
    parentPort.postMessage({
      id,
      error: { operation: "execute", message: "reader request was cancelled before it ran", notStarted: true },
    });
    return;
  }
  parentPort.postMessage({ started: id });
  let operation = "open";
  const executionStarted = performance.now();
  try {
    if (db === undefined) throw new Error("database reader is unavailable");
    operation = "prepare";
    const statement = prepare(sql, cached);
    operation = "execute";
    statement.setReadBigInts(safeIntegers);
    if (statement.columns().length > 0) {
      statement.setReturnArrays(values);
      const rows = collect(statement, params);
      parentPort.postMessage({ id, rows, executionMs: performance.now() - executionStarted });
    } else {
      const result = statement.run(...params);
      parentPort.postMessage({ id, rows: raw ? result : [], executionMs: performance.now() - executionStarted });
    }
  } catch (error) {
    parentPort.postMessage({
      id,
      executionMs: performance.now() - executionStarted,
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

// makeReader receives per-lane options with a plain number.
const resolvedMaxResultBytes = (options: SqliteClientConfig): number =>
  typeof options.readerMaxResultBytes === "number" ? options.readerMaxResultBytes : 0;

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
  | { readonly id: number; readonly rows: ReadonlyArray<any>; readonly executionMs?: number }
  | {
      readonly id: number;
      readonly executionMs?: number;
      readonly error: {
        readonly operation: "open" | "prepare" | "execute";
        readonly message: string;
        readonly code?: unknown;
        readonly errcode?: unknown;
        readonly errstr?: unknown;
        /** The worker stopped before it started this statement. */
        readonly notStarted?: boolean;
      };
    };

// Request claims, shared with the reader worker. A slot holds `tag` while its
// request is queued; the worker swaps it for `-tag` before running it, and the
// parent swaps it for 0 to cancel. Exactly one side wins, so a request either
// ran or never will. A slot holds its own request's tag, so a stale claim
// never matches a later request.
const CLAIM_SLOTS = 65536;
const claimTag = (id: number) => (id % 0x7fffffff) + 1;
// Transaction control must reach the worker even after its caller gave up.
const isTransactionControl = (sql: string) =>
  /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql);

const readerFailureMessages = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const readerFailed = (
  options: SqliteClientConfig,
  cause: unknown,
  message: string,
  operation: string,
) => new SqlError({ reason: classifyError(cause, message, operation, options, "reader") });

// Reads a stopped worker never started. Nothing ran, so another worker may run them.
const notStarted = new WeakSet<SqlError>();

const readerRetirements = Metric.counter("t3_sqlite_reader_retirements_total", {
  description: "Reader workers stopped by the statement limit, a worker error or an exit.",
});
const readerRequeued = Metric.counter("t3_sqlite_reader_requeued_total", {
  description: "Reads moved to a replacement worker after theirs stopped before running them.",
});
const readerRetireFailed = Metric.counter("t3_sqlite_reader_retire_failed_total", {
  description: "Reads failed by a reader worker stopping, by reason.",
});

const neverRan = (exit: Exit.Exit<unknown, SqlError>) =>
  Exit.isFailure(exit) &&
  Option.exists(Exit.findErrorOption(exit), (error) => notStarted.has(error));

// A worker that keeps stopping must not keep restarting reads that never ran:
// past this many stops in the window, those reads fail as before.
const REQUEUE_RETIREMENT_BUDGET = 4;
const REQUEUE_RETIREMENT_WINDOW_MS = 60_000;

// COMMIT, ROLLBACK and ROLLBACK TO SAVEPOINT. On a reader they change nothing,
// so they succeed once the worker is gone instead of failing the cleanup.
const endsReadTransaction = (sql: string) => /^\s*ROLLBACK\b|^\s*COMMIT\b/i.test(sql);

/**
 * Each worker gets its own `Connection`, so a transaction stays on the worker
 * it began on: once that worker exits, its statements fail rather than silently
 * continuing outside the transaction on a replacement.
 *
 * Callers get a lease over that connection. A route resolves its worker before
 * it waits for the reader lock, so a worker can stop while reads queue behind
 * it. A lease whose worker stopped before running anything for it moves to the
 * replacement once; after any statement reached the worker it stays pinned.
 */
const makeReader = Effect.fnUntraced(function* (options: SqliteClientConfig) {
  const failed = (cause: unknown, message: string, operation: string) =>
    readerFailed(options, cause, message, operation);
  const snapshotLock = options.readerSnapshotLock ?? (yield* Semaphore.make(1));
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const slowStatementMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.readerSlowStatement ?? Duration.seconds(10)),
  );
  const statementLimitMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.readerStatementLimit ?? Duration.minutes(2)),
  );
  let current:
    | {
        readonly worker: NodeWorkerThreads.Worker;
        readonly connection: Connection;
        readonly started: Promise<ReaderStartup>;
      }
    | undefined;
  let unavailable = false;
  let closing = false;
  let nextRequestId = 0;
  // When recent workers stopped. Past the budget, reads that never ran fail
  // instead of moving, and no new worker starts until the window clears.
  let retiredAt: Array<number> = [];
  let coolingDown = false;
  const withinStopBudget = () => {
    const now = performance.now();
    retiredAt = retiredAt.filter((at) => now - at < REQUEUE_RETIREMENT_WINDOW_MS);
    return retiredAt.length <= REQUEUE_RETIREMENT_BUDGET;
  };
  const countFailed = (reason: string, amount = 1) =>
    amount > 0
      ? runFork(Metric.update(Metric.withAttributes(readerRetireFailed, { reason }), amount))
      : undefined;

  const start = () => {
    const claimsBuffer = new SharedArrayBuffer(CLAIM_SLOTS * Int32Array.BYTES_PER_ELEMENT);
    const claims = new Int32Array(claimsBuffer);
    // True when the parent took the request back before the worker claimed it.
    const cancel = (id: number) =>
      Atomics.compareExchange(claims, id & (CLAIM_SLOTS - 1), claimTag(id), 0) === claimTag(id);
    const worker = new NodeWorkerThreads.Worker(readerWorkerSource, {
      eval: true,
      workerData: {
        filename: options.filename,
        allowExtension: options.allowExtension ?? false,
        prepareCacheSize: options.prepareCacheSize ?? 200,
        initializationSql: options.readerInitializationSql ?? [],
        claims: claimsBuffer,
        claimsMask: CLAIM_SLOTS - 1,
        maxResultBytes: resolvedMaxResultBytes(options),
      },
    });
    let announce: (startup: ReaderStartup) => void = () => {};
    const started = new Promise<ReaderStartup>((resolve) => {
      announce = resolve;
    });
    let stoppedMessage: string | undefined;
    const pending = new Map<
      number,
      {
        readonly endsTransaction: boolean;
        readonly sql: string;
        readonly resume: (reply: ReaderReply) => void;
        startedAt?: number;
        reported?: boolean;
        abandoned?: boolean;
      }
    >();
    // The worker runs one statement at a time; this is the one it last started.
    let running: number | undefined;
    // One statement must not hold every read in the process: report a slow one
    // with its SQL, and past the limit retire the worker so new reads get a
    // fresh one. The retired thread ends once SQLite returns.
    // @effect-diagnostics-next-line globalTimers:off -- watches a worker that may block for hours; it must not wait on any fiber.
    const watchdog = setInterval(() => {
      if (running === undefined || stoppedMessage !== undefined) return;
      const request = pending.get(running);
      if (request?.startedAt === undefined) return;
      const elapsedMs = Math.round(performance.now() - request.startedAt);
      const details = {
        sql: request.sql.replace(/\s+/g, " ").trim().slice(0, 2000),
        elapsedMs,
        queued: pending.size - 1,
      };
      if (elapsedMs >= statementLimitMs) {
        const outcome = stop(
          `Database reader retired: a statement ran longer than ${statementLimitMs} ms`,
          "limit",
        );
        runFork(
          Effect.logError("SQLite reader statement exceeded its limit; reader worker retired", {
            ...details,
            failed: outcome.failed,
            requeueable: outcome.requeueable,
          }),
        );
        void worker.terminate();
      } else if (elapsedMs >= slowStatementMs && !request.reported) {
        request.reported = true;
        runFork(Effect.logWarning("SQLite reader statement is slow", details));
      }
    }, 1000);
    watchdog.unref();
    const stop = (message: string, reason: "limit" | "error" | "exit") => {
      const outcome = { failed: 0, requeueable: 0 };
      // A retirement terminates the worker, whose exit then reports here too.
      if (stoppedMessage !== undefined) return outcome;
      clearInterval(watchdog);
      running = undefined;
      stoppedMessage = message;
      announce({ type: "unavailable", message });
      if (current?.worker === worker) current = undefined;
      if (!closing) {
        retiredAt.push(performance.now());
        runFork(Metric.update(Metric.withAttributes(readerRetirements, { reason }), 1));
      }
      // Take back every request the worker has not claimed: those never ran
      // and never will, so another worker may run them. The rest have run.
      const entries = [...pending];
      pending.clear();
      for (const [id, request] of entries) {
        if (request.endsTransaction) {
          request.resume({ id, rows: [] });
          continue;
        }
        // An abandoned request has no caller left to fail or move.
        if (request.abandoned) continue;
        const started = !cancel(id);
        if (started) outcome.failed++;
        else outcome.requeueable++;
        request.resume({
          id,
          error: { operation: "execute", message, ...(started ? {} : { notStarted: true }) },
        });
      }
      if (!closing) countFailed("started", outcome.failed);
      return outcome;
    };
    worker.on("message", (reply: ReaderReply | ReaderStartup | { readonly started: number }) => {
      if ("type" in reply) {
        if (reply.type === "unavailable") failed(reply, "Failed to open reader", "open");
        announce(reply);
        if (pending.size === 0) worker.unref();
        return;
      }
      if ("started" in reply) {
        const request = pending.get(reply.started);
        if (request !== undefined) request.startedAt = performance.now();
        running = reply.started;
        return;
      }
      if (running === reply.id) running = undefined;
      const request = pending.get(reply.id);
      if (request === undefined) return;
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      request.resume(reply);
    });
    worker.on("error", (cause) => void stop(`Database reader failed: ${cause.message}`, "error"));
    worker.on("exit", (code) => void stop(`Database reader exited with code ${code}`, "exit"));

    const request = (input: ReaderRequest) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const endsTransaction = endsReadTransaction(input.sql);
        if (stoppedMessage !== undefined) {
          if (endsTransaction) return Effect.succeed([]);
          const error = failed(new Error(stoppedMessage), readerFailureMessages.execute, "execute");
          notStarted.add(error);
          return Effect.fail(error);
        }
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        return Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
          let id = nextRequestId++;
          // A slot still holding a queued request is not reused, or the worker
          // would skip that request; claimed and cancelled slots are free.
          for (let tries = 1; Atomics.load(claims, id & (CLAIM_SLOTS - 1)) > 0; tries++) {
            if (tries >= CLAIM_SLOTS) {
              resume(
                Effect.fail(
                  failed(
                    new Error("Reader request queue full"),
                    "Reader request queue full",
                    "readerAdmission",
                  ),
                ),
              );
              return;
            }
            id = nextRequestId++;
          }
          const entry: {
            readonly endsTransaction: boolean;
            readonly sql: string;
            readonly resume: (reply: ReaderReply) => void;
            startedAt?: number;
            abandoned?: boolean;
          } = {
            endsTransaction,
            sql: input.sql,
            resume: (reply) => {
              if (
                reply.executionMs !== undefined &&
                fiber.getRef(References.TracerEnabled) &&
                fiber.getRef(Statement.SpanPropagationEnabled)
              ) {
                const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
                if (span?._tag === "Span")
                  span.attribute("db.statement.execution_ms", reply.executionMs);
              }
              if ("rows" in reply) {
                resume(Effect.succeed(reply.rows));
                return;
              }
              const { operation, message, notStarted: neverRan, ...codes } = reply.error;
              const error = failed(
                Object.assign(new Error(message), codes),
                readerFailureMessages[operation],
                operation,
              );
              if (neverRan === true) notStarted.add(error);
              resume(Effect.fail(error));
            },
          };
          pending.set(id, entry);
          Atomics.store(claims, id & (CLAIM_SLOTS - 1), claimTag(id));
          if (pending.size === 1) worker.ref();
          const cached = input.cached && !hasLargeBinding(input.params);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage({ id, safeIntegers, ...input, cached });
          // An interrupted caller (an HTTP timeout, say) leaves its request
          // queued in the worker. Cancel it so the worker skips it if it has not
          // started; the entry stays until the worker answers.
          return Effect.sync(() => {
            if (!isTransactionControl(input.sql) && cancel(id)) entry.abandoned = true;
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
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
    current = { worker, connection, started };
    return current;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closing = true;
      await current?.worker.terminate();
    }),
  );

  const startupTimeout = Duration.fromInputUnsafe(
    options.readerStartupTimeout ?? Duration.seconds(10),
  );

  const turnOff = (reader: typeof current, reason: string) =>
    Effect.suspend(() => {
      if (reader !== undefined) {
        if (current === reader) current = undefined;
        void reader.worker.terminate();
      }
      if (unavailable) return Effect.succeed(undefined);
      unavailable = true;
      return Effect.logWarning("SQLite reader worker unavailable", {
        reason,
      }).pipe(Effect.as(undefined));
    });

  const acquireWorker = Effect.suspend((): Effect.Effect<Connection | undefined> => {
    if (unavailable) return Effect.succeed(undefined);
    // Workers that keep stopping must not be respawned for every read: reads
    // use the main connection, as for an unavailable reader, until it cools.
    if (current === undefined && !withinStopBudget()) {
      if (coolingDown) return Effect.succeed(undefined);
      coolingDown = true;
      return Effect.logWarning("SQLite reader workers keep stopping; reader cooling down", {
        stops: retiredAt.length,
        windowMs: REQUEUE_RETIREMENT_WINDOW_MS,
      }).pipe(Effect.as(undefined));
    }
    coolingDown = false;
    let reader: NonNullable<typeof current>;
    try {
      reader = current ?? start();
    } catch (cause) {
      return turnOff(undefined, String(cause));
    }
    return Effect.flatMap(
      Effect.withFiber((fiber) => {
        const restore = Context.get(fiber.context, ReadOnly) ?? identity;
        return restore(
          Effect.timeoutOption(
            Effect.promise(() => reader.started),
            startupTimeout,
          ),
        );
      }),
      (startup): Effect.Effect<Connection | undefined> =>
        // Another acquire may have timed out and retired this worker while this one
        // waited; a late "ready" must not hand out a worker that is being terminated.
        unavailable || current !== reader
          ? Effect.succeed(undefined)
          : Option.isSome(startup) && startup.value.type === "ready"
            ? Effect.succeed(reader.connection)
            : turnOff(
                reader,
                Option.isSome(startup) && startup.value.type === "unavailable"
                  ? startup.value.message
                  : `worker did not open the database within ${Duration.toMillis(startupTimeout)} ms`,
              ),
    );
  });

  const lease = (initial: Connection): Connection => {
    let bound = initial;
    // Set once a statement got past "never started": from then on this lease
    // may hold transaction or snapshot state on its worker, so it never moves.
    let pinned = false;
    let moved = false;
    const run = <A>(call: (connection: Connection) => Effect.Effect<A, SqlError>) =>
      Effect.suspend(() => call(bound)).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (!neverRan(exit)) pinned = true;
          }),
        ),
        Effect.catchIf(
          (error: SqlError) => notStarted.has(error),
          (error) => requeue(error, call),
        ),
      );
    const requeue = <A>(
      error: SqlError,
      call: (connection: Connection) => Effect.Effect<A, SqlError>,
    ): Effect.Effect<A, SqlError> =>
      Effect.suspend(() => {
        let refused: "pinned" | "moved" | "budget" | undefined;
        if (pinned) refused = "pinned";
        else if (moved) refused = "moved";
        else if (!withinStopBudget()) refused = "budget";
        if (refused !== undefined) {
          countFailed(refused);
          return Effect.fail(error);
        }
        moved = true;
        return Effect.flatMap(acquireWorker, (next) => {
          if (next === undefined || next === bound) {
            countFailed("unavailable");
            return Effect.fail(error);
          }
          bound = next;
          return Metric.update(readerRequeued, 1).pipe(
            Effect.andThen(Effect.annotateCurrentSpan("db.reader.requeued", true)),
            Effect.andThen(run(call)),
          );
        });
      });
    return {
      execute: (sql, params, rowTransform) =>
        run((connection) => connection.execute(sql, params, rowTransform)),
      executeRaw: (sql, params) => run((connection) => connection.executeRaw(sql, params)),
      executeValues: (sql, params) => run((connection) => connection.executeValues(sql, params)),
      executeValuesUnprepared: (sql, params) =>
        run((connection) => connection.executeValuesUnprepared(sql, params)),
      executeUnprepared: (sql, params, rowTransform) =>
        run((connection) => connection.executeUnprepared(sql, params, rowTransform)),
      executeStream: (sql, params, rowTransform) => bound.executeStream(sql, params, rowTransform),
    };
  };

  return Effect.map(acquireWorker, (connection) =>
    connection === undefined ? undefined : lease(connection),
  );
});

const CHECKPOINT_FRAMES = 1000;
const CHECKPOINT_IDLE_MS = 100;
const CHECKPOINT_BACKPRESSURE_FRAMES = 10 * CHECKPOINT_FRAMES;

// Evaluated source also works in bundles and single-executable builds.
const checkpointWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
process.on("uncaughtException", error => {
  parentPort.postMessage({ type: "db-error", errcode: error && error.errcode, errstr: error && error.errstr, code: error && error.code });
});
const { DatabaseSync } = require("node:sqlite");
const { statSync } = require("node:fs");
let db;
let frames;
let checkpoint;
let truncate;
let journalSizeLimit = -1;
let generation = 0;
let nextTruncateId = 0;
let pendingTruncate;
let pendingBarriers = 0;
let idle;
const initialize = () => {
  if (db !== undefined) return;
  // The writer switches to WAL after constructing the client.
  db = new DatabaseSync(workerData.filename);
  db.exec("PRAGMA busy_timeout = 5000;");
  const mode = String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  // macOS requires F_FULLFSYNC to flush the drive cache.
  db.exec("PRAGMA checkpoint_fullfsync = ON;");
   frames = db.prepare("PRAGMA main.wal_checkpoint(NOOP)");
   checkpoint = db.prepare("PRAGMA main.wal_checkpoint(PASSIVE)");
   truncate = db.prepare("PRAGMA main.wal_checkpoint(TRUNCATE)");
};
const atCeiling = (state) => state.log >= workerData.backpressureFrames;
const exceedsSizeLimit = () =>
  journalSizeLimit >= 0 && statSync(workerData.filename + "-wal").size > journalSizeLimit;
const schedule = (state, blocked) => {
  if (blocked || state.log - state.checkpointed >= workerData.frames) {
    idle = setTimeout(() => check(undefined, undefined, true), workerData.idleMs);
  }
};
const check = (id, nextJournalSizeLimit, force, nextGeneration = generation) => {
  initialize();
  if (Number.isSafeInteger(nextGeneration)) generation = Math.max(generation, nextGeneration);
  if (Number.isSafeInteger(nextJournalSizeLimit)) journalSizeLimit = nextJournalSizeLimit;
  let state = frames.get();
  const oversized = exceedsSizeLimit();
  if (force || state.log - state.checkpointed >= workerData.frames || oversized) {
    checkpoint.get();
    state = frames.get();
  }
  if (state.checkpointed === state.log && (atCeiling(state) || oversized)) {
    pendingTruncate = { truncateId: ++nextTruncateId, checkId: id, generation, state };
    parentPort.postMessage({
      type: "truncate-request",
      truncateId: pendingTruncate.truncateId,
      checkId: id,
      generation,
      ...state,
    });
    return;
  }
  const blocked = (atCeiling(state) || oversized) && state.checkpointed < state.log;
  parentPort.postMessage({ type: "checkpoint", id, generation, ...state, blocked });
  schedule(state, blocked);
};
const finishTruncate = (truncateId) => {
  if (pendingTruncate === undefined || pendingTruncate.truncateId !== truncateId) return;
  const pending = pendingTruncate;
  parentPort.postMessage({ type: "truncate-start", truncateId });
  let busy;
  // Admission is paused here; a pinned reader must not make truncation wait.
  db.exec("PRAGMA busy_timeout = 0;");
  try {
    busy = truncate.get().busy !== 0;
  } finally {
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  const state = frames.get();
  const blocked = (atCeiling(state) && (busy || state.checkpointed < state.log)) || exceedsSizeLimit();
  pendingTruncate = undefined;
  parentPort.postMessage({
    type: "checkpoint",
    id: pending.checkId,
    generation: pending.generation,
    truncateId,
    ...state,
    blocked,
  });
  while (pendingBarriers > 0) {
    pendingBarriers--;
    parentPort.postMessage("barrier");
  }
  schedule(state, blocked);
};
parentPort.on("message", (request) => {
  clearTimeout(idle);
  if (request && request.type === "truncate") {
    finishTruncate(request.truncateId);
    return;
  }
  const isBarrier = request === "barrier";
  if (pendingTruncate !== undefined) {
    if (isBarrier) pendingBarriers++;
    else if (request && request.type === "check") {
      // Retire the request without labeling the pending snapshot with a newer generation.
      parentPort.postMessage({
        type: "checkpoint",
        id: request.id,
        generation: pendingTruncate.generation,
        ...pendingTruncate.state,
        blocked: true,
      });
    }
    return;
  }
  const input = request && typeof request === "object" ? request : {};
  check(input.id, input.journalSizeLimit, input.force, input.generation);
  if (isBarrier) {
    if (pendingTruncate !== undefined) pendingBarriers++;
    else parentPort.postMessage("barrier");
  }
});
`;

interface WriterSetupStatement {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
}
interface WriterAttachment extends WriterSetupStatement {
  readonly schema: string;
  readonly filename: string;
}
interface WriterPragma {
  readonly schema: string;
  readonly name: string;
  readonly value: number | bigint | string;
}
interface WriterSchema {
  readonly schema: string;
  readonly sql: string;
}
interface WriterSetupReply {
  readonly attachments?: ReadonlyArray<WriterAttachment>;
  readonly settings?: ReadonlyArray<WriterPragma>;
  readonly schemas?: ReadonlyArray<WriterSchema>;
  readonly inTransaction?: boolean;
  readonly recoveryReady?: boolean;
}

// Recovery restores acknowledged connection state, never a history of SQL.
// In particular, SQLite can authorize ATTACH internally for VACUUM INTO.
const makeWriterSetup = () => {
  let attachments: ReadonlyArray<WriterAttachment> = [];
  let settings: ReadonlyArray<WriterPragma> = [];
  let schemas: ReadonlyArray<WriterSchema> = [];
  let inTransaction = false;
  let canRecover = true;
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const pragma = (entry: WriterPragma): WriterSetupStatement => ({
    sql: `PRAGMA ${entry.schema === "" ? "" : `${quote(entry.schema)}.`}${quote(entry.name)} = ${typeof entry.value === "string" ? `'${entry.value.replaceAll("'", "''")}'` : String(entry.value)}`,
    params: [],
  });
  const afterSchema = (entry: WriterPragma) =>
    entry.name === "query_only" || entry.name === "defer_foreign_keys";
  const reset = () => {
    if (inTransaction)
      settings = settings.map((entry) =>
        entry.name === "defer_foreign_keys" ? { ...entry, value: 0 } : entry,
      );
    inTransaction = false;
  };
  const record = (reply: WriterSetupReply) => {
    if (reply.recoveryReady !== undefined) canRecover = reply.recoveryReady;
    if (reply.attachments !== undefined) {
      attachments = reply.attachments;
      const present = new Set(["temp", ...attachments.map((entry) => entry.schema)]);
      schemas = schemas.filter((entry) => present.has(entry.schema));
    }
    if (reply.settings !== undefined) settings = reply.settings;
    if (reply.schemas !== undefined) schemas = reply.schemas;
    inTransaction = reply.inTransaction ?? inTransaction;
  };
  return {
    get attachments() {
      return attachments;
    },
    get canRecover() {
      return canRecover;
    },
    get globalMmap() {
      return settings.find((entry) => entry.schema === "" && entry.name === "mmap_size")?.value;
    },
    get entries(): ReadonlyArray<WriterSetupStatement> {
      const prerequisite = (entry: WriterPragma) =>
        entry.schema === "main" &&
        (entry.name === "encoding" || entry.name === "page_size" || entry.name === "auto_vacuum");
      return [
        ...settings.filter(prerequisite).map(pragma),
        ...attachments,
        ...settings.filter((entry) => !afterSchema(entry) && !prerequisite(entry)).map(pragma),
        ...schemas.map((entry) => ({ sql: entry.sql, params: [], restoreSchema: entry.schema })),
      ];
    },
    // These flags can prevent schema restoration, or be reset by that restoration.
    get postSetup() {
      return settings.filter(afterSchema).map(pragma);
    },
    record,
    reset,
  };
};

type WriterConnection = Connection & {
  readonly ensure: Effect.Effect<void, SqlError>;
  readonly release: Effect.Effect<void>;
};

// Each worker is one transaction generation. Replacement happens only after its
// borrower releases the writer permit, so an interrupted transaction cannot move.
const writerWorkerSource = `
const { parentPort, workerData, Worker } = require("node:worker_threads");
const { DatabaseSync, constants } = require("node:sqlite");
let cancelled = new Int32Array(workerData.cancelled);
const isCancelled = () => Atomics.load(cancelled, 0) !== 0;
let db;
const statements = new Map();
const classifications = new WeakMap();
let activeClassification;
let memorySchemas = new Set();
let deferredForeignKeys = false;
let configurationDirty = false;
let schemaDirty = false;
let attachmentsDirty = false;
let pendingAttachment;
let globalMmap = workerData.globalMmap;
let globalMmapPending = false;
let openingFailed = false;
let unsupportedConfiguration = false;
let availablePragmas;
const pendingPragmas = new Set();
const pendingVacuum = new Map();
const attachmentStatements = new Map((workerData.attachments ?? []).map(entry => [entry.schema, entry]));
const setupPragmas = new Set(["busy_timeout", "foreign_keys", "defer_foreign_keys", "synchronous",
  "fullfsync", "checkpoint_fullfsync", "journal_size_limit", "cache_size", "temp_store", "mmap_size",
  "wal_autocheckpoint", "query_only", "recursive_triggers", "trusted_schema", "locking_mode",
  "ignore_check_constraints", "automatic_index", "reverse_unordered_selects", "read_uncommitted",
  "count_changes", "short_column_names", "full_column_names", "cell_size_check", "legacy_alter_table",
  "cache_spill", "secure_delete", "analysis_limit", "threads", "max_page_count", "journal_mode", "encoding", "page_size", "auto_vacuum"]);
const setupActions = [constants.SQLITE_CREATE_TEMP_TABLE, constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TRIGGER, constants.SQLITE_CREATE_TEMP_VIEW,
  constants.SQLITE_DROP_TEMP_TABLE, constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_TRIGGER, constants.SQLITE_DROP_TEMP_VIEW];
const memorySchemaActions = [constants.SQLITE_CREATE_TABLE, constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_CREATE_TRIGGER, constants.SQLITE_CREATE_VIEW,
  constants.SQLITE_DROP_TABLE, constants.SQLITE_DROP_INDEX, constants.SQLITE_DROP_TRIGGER, constants.SQLITE_DROP_VIEW,
  constants.SQLITE_CREATE_VTABLE, constants.SQLITE_DROP_VTABLE];
const localPragmas = new Set(["application_id", "auto_vacuum", "encoding", "page_size", "journal_mode", "schema_version", "user_version"]);
const argumentPragmas = new Set(["table_info", "table_xinfo", "table_list", "index_info", "index_xinfo",
  "index_list", "foreign_key_list", "foreign_key_check", "integrity_check", "quick_check",
  "optimize", "incremental_vacuum", "wal_checkpoint"]);
const errorReply = (id, error, operation, extra = {}) => parentPort.postMessage({ id, ...extra, error: {
  operation, message: String(error.message || error), code: error.code,
  errcode: error.errcode, errstr: error.errstr,
}});
try {
  db = new DatabaseSync(workerData.filename, {
    readOnly: workerData.readonly, allowExtension: workerData.allowExtension,
  });
  if (typeof db.setAuthorizer === "function") db.setAuthorizer((code, action, argument, database) => {
    if (!activeClassification) return constants.SQLITE_OK;
    if (code === constants.SQLITE_ATTACH || code === constants.SQLITE_DETACH) {
      activeClassification.attachment = true;
      if (code === constants.SQLITE_ATTACH) activeClassification.attachmentLiteral = action;
    }
    if (setupActions.includes(code) || memorySchemaActions.includes(code) || code === constants.SQLITE_ALTER_TABLE) {
      activeClassification.schema = true;
    }
    if (code === constants.SQLITE_TRANSACTION || code === constants.SQLITE_SAVEPOINT) {
      activeClassification.write ||= action === "BEGIN";
      activeClassification.check ||= code === constants.SQLITE_SAVEPOINT || action === "COMMIT" || action === "ROLLBACK";
    } else if (code === constants.SQLITE_PRAGMA) {
      const name = action?.toLowerCase();
      activeClassification.configuration ||= argument !== null && setupPragmas.has(name);
      activeClassification.unreadableSpillThreshold ||= name === "cache_spill" && argument !== null &&
        Number.isFinite(Number(argument)) && Number(argument) > 1;
      activeClassification.globalMmap ||= name === "mmap_size" && argument !== null && database === null;
      if (argument !== null && (name === "page_size" || name === "auto_vacuum")) {
        (activeClassification.pendingVacuum ??= new Map()).set((database ?? "main") + ":" + name,
          { schema: database ?? "main", name, value: argument });
      }
      if (argument !== null && !setupPragmas.has(name) && !localPragmas.has(name) && !argumentPragmas.has(name)) {
        (activeClassification.unknownPragmas ??= new Set()).add(name);
      }
      activeClassification.schema ||= name === "temp_store" && argument !== null;
      activeClassification.journalMode ||= name === "journal_mode" && argument !== null;
      activeClassification.write ||= name === "optimize" || name === "incremental_vacuum" ||
        (name === "wal_checkpoint" && argument?.toLowerCase() !== "noop") ||
        (argument !== null && localPragmas.has(name));
    } else if (![constants.SQLITE_READ, constants.SQLITE_SELECT, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE].includes(code)) {
      activeClassification.write = true;
    }
    return constants.SQLITE_OK;
  });
  const schemaRestore = new Map();
  for (const entry of workerData.setup ?? []) {
    if (entry.restoreSchema !== undefined) {
      if (!schemaRestore.has(entry.restoreSchema)) {
        const quoted = '"' + entry.restoreSchema.replaceAll('"', '""') + '"';
        const version = Object.values(db.prepare("PRAGMA " + quoted + ".schema_version").get())[0];
        schemaRestore.set(entry.restoreSchema, Number(version) === 0);
      }
      if (!schemaRestore.get(entry.restoreSchema)) continue;
    }
    const statement = db.prepare(entry.sql);
    statement.setReadBigInts(true);
    if (statement.columns().length) statement.all(...entry.params);
    else statement.run(...entry.params);
    if (entry.filename !== undefined) {
      const attached = db.prepare("PRAGMA database_list").all().find(row => row.name === entry.schema);
      if (attached?.file !== entry.filename) throw new Error("SQLite attachment identity changed during recovery");
    }
  }
  if (workerData.setup?.length) {
    memorySchemas = new Set(db.prepare("PRAGMA database_list").all()
      .filter(row => row.name !== "main" && row.file === "").map(row => row.name));
  }
} catch (error) { openingFailed = true; errorReply(0, error, "open"); }
const quoteIdentifier = name => '"' + name.replaceAll('"', '""') + '"';
const databases = () => db.prepare("PRAGMA database_list").all();
const connectionSettings = () => {
  const settings = [{ schema: "", name: "locking_mode", value: db.prepare("PRAGMA locking_mode").get().locking_mode }];
  if (globalMmapPending) {
    const statement = db.prepare("PRAGMA mmap_size");
    statement.setReadBigInts(true);
    const value = statement.get()?.mmap_size;
    if (value !== undefined) globalMmap = value;
    globalMmapPending = false;
  }
  if (globalMmap !== undefined) settings.push({ schema: "", name: "mmap_size", value: globalMmap });
  const names = new Set(["main", ...databases().map(entry => entry.name)]);
  for (const schema of names) for (const name of setupPragmas) {
    // The checkpoint controller owns this hook and restores SQLite's default on failure.
    if (name === "wal_autocheckpoint" && workerData.checkpoint) continue;
    const statement = db.prepare("PRAGMA " + quoteIdentifier(schema) + "." + name);
    statement.setReadBigInts(true);
    const row = statement.get();
    const observed = row && Object.values(row)[0];
    const value = name === "cache_spill" && (typeof observed === "number" || typeof observed === "bigint") ? (Number(observed) === 0 ? "OFF" : "ON") : observed;
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") settings.push({ schema, name, value });
  }
  deferredForeignKeys = Boolean(db.prepare("PRAGMA defer_foreign_keys").get().defer_foreign_keys);
  return settings;
};
const volatileSchema = () => {
  const statements = [];
  const priority = { table: 0, index: 1, view: 2, trigger: 3 };
  for (const schema of memorySchemas) {
    const quoted = quoteIdentifier(schema);
    const shadows = new Set(db.prepare("PRAGMA " + quoted + ".table_list").all()
      .filter(entry => entry.type === "shadow").map(entry => entry.name));
    const rows = db.prepare("SELECT name AS name, type AS type, sql AS sql FROM " + quoted + ".sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid").all();
    for (const row of rows) {
      if (row.name.startsWith("sqlite_") || shadows.has(row.name)) continue;
      // sqlite_schema stores CREATE statements without their schema qualifier.
      const sql = row.sql.replace(/^(CREATE\\s+(?:(?:UNIQUE|VIRTUAL)\\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\\s+)/i, "$1" + quoted + ".");
      statements.push({ schema, sql, type: row.type });
    }
  }
  return statements.sort((left, right) => priority[left.type] - priority[right.type])
    .map(({ schema, sql }) => ({ schema, sql }));
};
const observeConnectionState = () => {
  const snapshot = {};
  if (attachmentsDirty) {
    const current = databases();
    const present = new Set(current.filter(entry => entry.name !== "main" && entry.name !== "temp").map(entry => entry.name));
    for (const name of attachmentStatements.keys()) if (!present.has(name)) attachmentStatements.delete(name);
    if (pendingAttachment) {
      const resolved = {};
      const previous = activeClassification;
      activeClassification = resolved;
      try { db.prepare(pendingAttachment.expandedSql ?? pendingAttachment.sql); }
      finally { activeClassification = previous; }
      for (const name of present) if (!attachmentStatements.has(name)) {
        const literal = resolved.attachmentLiteral;
        attachmentStatements.set(name, { schema: name, filename: current.find(entry => entry.name === name).file,
          ...(typeof literal === "string"
            ? { sql: "ATTACH DATABASE ? AS " + quoteIdentifier(name), params: [literal], replaySafe: true }
            : { sql: pendingAttachment.sql, params: pendingAttachment.params, replaySafe: false }) });
      }
    }
    pendingAttachment = undefined;
    attachmentsDirty = false;
    memorySchemas = new Set(current.filter(entry => entry.name !== "main" && entry.file === "").map(entry => entry.name));
    snapshot.attachments = [...attachmentStatements.values()];
    configurationDirty = true;
    schemaDirty = true;
  }
  if (deferredForeignKeys && !db.isTransaction) {
    const current = Boolean(db.prepare("PRAGMA defer_foreign_keys").get().defer_foreign_keys);
    configurationDirty ||= !current;
  }
  if (configurationDirty) {
    snapshot.attachments = [...attachmentStatements.values()];
    snapshot.settings = connectionSettings();
    configurationDirty = false;
  }
  if (schemaDirty && !db.isTransaction) {
    memorySchemas = new Set(databases().filter(entry => entry.name !== "main" && entry.file === "").map(entry => entry.name));
    snapshot.schemas = volatileSchema();
    schemaDirty = false;
  }
  return snapshot;
};
let recoveryFailureReported = false;
let recoveryFailureCause;
const recoverySnapshot = (classification, sql, params, expandedSql) => {
  globalMmapPending ||= Boolean(classification?.globalMmap);
  unsupportedConfiguration ||= Boolean(classification?.unreadableSpillThreshold);
  configurationDirty ||= Boolean(classification?.configuration) || pendingVacuum.size > 0 || globalMmapPending;
  schemaDirty ||= Boolean(classification?.schema);
  for (const [key, setting] of classification?.pendingVacuum ?? []) pendingVacuum.set(key, setting);
  for (const name of classification?.unknownPragmas ?? []) pendingPragmas.add(name);
  if (classification?.attachment || typeof db.setAuthorizer !== "function") {
    attachmentsDirty = true;
    const head = sql?.replace(/^(?:[;\\s]|--[^\\n]*(?:\\n|$)|\\/\\*[\\s\\S]*?\\*\\/)+/, "");
    if (/^ATTACH\\b/i.test(head ?? "")) pendingAttachment = { sql, params, expandedSql };
  }
  // Introspection can itself end a read transaction. Preserve the flag as it
  // stood after the user's SQL, rather than letting metadata reads consume it.
  let deferBefore;
  try {
    if (pendingPragmas.size) {
      availablePragmas ??= new Set(db.prepare("PRAGMA pragma_list").all().map(row => row.name));
      for (const name of pendingPragmas) if (availablePragmas.has(name)) unsupportedConfiguration = true;
      pendingPragmas.clear();
    }
    if (deferredForeignKeys || configurationDirty)
      deferBefore = Boolean(db.prepare("PRAGMA defer_foreign_keys").get().defer_foreign_keys);
    const snapshot = observeConnectionState();
    if (snapshot.settings) for (const [key, setting] of pendingVacuum) {
      const modes = { NONE: 0, FULL: 1, INCREMENTAL: 2 };
      const wanted = setting.name === "auto_vacuum" && setting.value.toUpperCase() in modes
        ? modes[setting.value.toUpperCase()] : Number(setting.value);
      const current = snapshot.settings.find(entry => entry.schema === setting.schema && entry.name === setting.name)?.value;
      if (Number(current) === wanted) pendingVacuum.delete(key);
    }
    if (deferBefore !== undefined && snapshot.settings) snapshot.settings = snapshot.settings.map(entry =>
      entry.name === "defer_foreign_keys" ? { ...entry, value: deferBefore ? 1 : 0 } : entry);
    const observed = !attachmentsDirty && (!recoveryFailureReported || (!configurationDirty && !schemaDirty));
    if (observed) { recoveryFailureReported = false; recoveryFailureCause = undefined; }
    // Unreadable settings and missing classification cannot be reconstructed safely.
    return { ...snapshot, recoveryReady: observed && pendingVacuum.size === 0 && !globalMmapPending && !unsupportedConfiguration &&
      [...attachmentStatements.values()].every(entry => entry.replaySafe !== false) && typeof db.setAuthorizer === "function" };
  } catch (cause) {
    // Metadata failure must not turn a successful COMMIT into a failed write.
    if (!recoveryFailureReported) parentPort.postMessage({ type: "recovery-error", error: {
      code: cause?.code, errcode: cause?.errcode, errstr: cause?.errstr,
    }});
    recoveryFailureReported = true;
    recoveryFailureCause = cause;
    configurationDirty = true;
    schemaDirty = true;
    return { recoveryReady: false };
  } finally {
    if (deferBefore) {
      try { db.exec("PRAGMA defer_foreign_keys = ON"); deferredForeignKeys = true; } catch {}
    }
  }
};
// Serialize statements while WAL admission is waiting on a pinned reader.
let queue = Promise.resolve();
let checkpointStarted = workerData.checkpointStarted;
let checkpoint;
let wakeAdmission = () => {};
const reportCheckpoint = (cause, connection = "checkpoint") => parentPort.postMessage({ type: "checkpoint-error", connection, error: {
  code: cause?.code, errcode: cause?.errcode, errstr: cause?.errstr,
}});
let checkpointAttempted = false;
const startCheckpoint = () => {
  if (checkpointAttempted || !workerData.checkpoint || workerData.readonly) return;
  checkpointAttempted = true;
  const warn = (reason) => parentPort.postMessage({ type: "checkpoint-warning", reason });
  if (typeof db.isTransaction !== "boolean" || typeof db.setAuthorizer !== "function") {
    warn("Node SQLite lacks transaction-state or statement-authorizer support");
    return;
  }
  const version = String(db.prepare("SELECT sqlite_version() AS version").get().version);
  const [major, minor] = version.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 51)) {
    warn("SQLite " + version + " has no NOOP checkpoint");
    return;
  }
  const frames = db.prepare("PRAGMA main.wal_checkpoint(NOOP)");
  let child;
  try { child = new Worker(workerData.checkpointSource, { eval: true, workerData: {
    filename: workerData.filename,
    frames: workerData.checkpointFrames,
    backpressureFrames: workerData.checkpointBackpressureFrames,
    idleMs: workerData.checkpointIdleMs,
  }}); } catch (cause) { warn(String(cause)); return; }
  let stopped = false;
  let generation = 0;
  let nextId = 0;
  let inFlight;
  let checkAgain = false;
  let blocked = false;
  let log = 0;
  let checkpointed = 0;
  let unknown = false;
  let truncate;
  const gated = () => !stopped && !db.isTransaction &&
    (unknown || blocked || truncate !== undefined || log >= workerData.checkpointBackpressureFrames);
  const handBack = (reason) => {
    if (stopped) return;
    stopped = true;
    truncate = undefined;
    try { db.exec("PRAGMA wal_autocheckpoint = " + workerData.checkpointFrames); } catch {}
    wakeAdmission();
    warn(reason);
  };
  const send = (message) => {
    try { child.postMessage(message); } catch (cause) { handBack(String(cause)); }
  };
  const acknowledge = () => {
    if (!truncate || truncate.acknowledged || stopped || db.isTransaction) return;
    truncate.acknowledged = true;
    send({ type: "truncate", truncateId: truncate.id });
  };
  const observe = () => {
    try {
      const state = frames.get();
      const nextLog = Number(state.log), nextCheckpointed = Number(state.checkpointed);
      if (!Number.isSafeInteger(nextLog) || !Number.isSafeInteger(nextCheckpointed))
        throw new Error("Invalid WAL frame counts");
      log = nextLog;
      checkpointed = nextCheckpointed;
      unknown = false;
    } catch (cause) { reportCheckpoint(cause, "writer"); unknown = true; }
  };
  const request = (force = false) => {
    if (stopped || db.isTransaction || (!checkpointStarted && !gated())) return;
    if (truncate !== undefined) { acknowledge(); return; }
    if (inFlight !== undefined) { checkAgain = true; return; }
    if (!force && !gated() && log - checkpointed < workerData.checkpointFrames) return;
    inFlight = ++nextId;
    // A PRAGMA prepared before its setting changes can return the old value on its first step.
    try { send({ type: "check", id: inFlight, generation,
      journalSizeLimit: Number(db.prepare("PRAGMA journal_size_limit").get().journal_size_limit), force: force || gated() }); }
    catch (cause) { handBack(String(cause)); }
  };
  const check = () => {
    if (stopped || db.isTransaction) return;
    generation++;
    observe();
    request();
    wakeAdmission();
  };
  child.on("error", cause => { reportCheckpoint(cause); handBack(cause.message); });
  child.on("exit", code => handBack("exited with code " + code));
  child.on("message", message => {
    if (stopped || !message || typeof message !== "object") return;
    if (message.type === "truncate-request" && typeof message.truncateId === "number") {
      truncate = { id: message.truncateId, acknowledged: false };
      blocked = true;
      acknowledge();
      return;
    }
    if (message.type === "db-error") {
      reportCheckpoint(message);
      handBack("SQLite checkpoint failed");
      void child.terminate();
      return;
    }
    if (message.type !== "checkpoint") return;
    const completedTruncate = truncate !== undefined && message.truncateId === truncate.id;
    if (completedTruncate) truncate = undefined;
    if ((completedTruncate || message.generation === generation) &&
      typeof message.log === "number" && typeof message.checkpointed === "number" &&
      typeof message.blocked === "boolean") {
      log = message.log; checkpointed = message.checkpointed;
      blocked = message.blocked; unknown = false;
    }
    if (message.id === inFlight) inFlight = undefined;
    if (checkAgain && inFlight === undefined) { checkAgain = false; request(true); }
    wakeAdmission();
  });
  db.exec("PRAGMA wal_autocheckpoint = 0");
  observe();
  child.unref();
  checkpoint = {
    check,
    async admit(id) {
      const started = gated() ? performance.now() : undefined;
      while (gated()) {
        if (isCancelled(id)) throw new Error("SQLite request cancelled before execution");
        parentPort.postMessage({ waiting: id });
        child.ref();
        await new Promise(resolve => { wakeAdmission = resolve; request(true); if (!gated()) resolve(); });
      }
      child.unref();
      return started === undefined ? 0 : performance.now() - started;
    },
    async close() { stopped = true; truncate = undefined; wakeAdmission(); await child.terminate(); },
  };
};
const enableWal = () => {
  if (String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase() === "wal") startCheckpoint();
};
try { if (db && workerData.checkpoint) enableWal(); } catch (cause) { reportCheckpoint(cause); }
if (db && !openingFailed) {
  try {
    for (const entry of workerData.postSetup ?? []) {
      const statement = db.prepare(entry.sql);
      statement.setReadBigInts(true);
      if (statement.columns().length) statement.all(...entry.params);
      else statement.run(...entry.params);
    }
    if (workerData.postSetup?.length) deferredForeignKeys = Boolean(db.prepare("PRAGMA defer_foreign_keys").get().defer_foreign_keys);
    parentPort.postMessage({ type: "ready" });
  } catch (error) { openingFailed = true; errorReply(0, error, "open"); }
}
parentPort.on("message", (request) => {
  if (request.cancel !== undefined) { wakeAdmission(); return; }
  queue = queue.then(async () => {
  const { id, sql, params, cached, values, raw, safeIntegers, close, checkpointStart } = request;
  cancelled = new Int32Array(request.cancellation ?? workerData.cancelled);
  let operation = "prepare";
  let mayWrite = false;
  let observedWrite = false;
  let executionStarted;
  let elapsedMs;
  let controlStarted;
  let controlMs;
  let checkpointWaitMs = 0;
  let priorRecovery = {};
  let classification;
  let executed = false;
  try {
    if (close) {
      operation = "close";
      if (checkpoint) await checkpoint.close();
      db.close();
      parentPort.postMessage({ id, rows: [] });
      parentPort.close();
      return;
    }
    if (request.rollbackIfOpen && !db.isTransaction) {
      parentPort.postMessage({ id, rows: [], inTransaction: false });
      return;
    }
    if (checkpointStart) {
      checkpointStarted = true;
      checkpoint?.check();
      parentPort.postMessage({ id, rows: [] });
      return;
    }
    // Resolve an earlier attachment change before another statement can change its identity.
    if (attachmentsDirty || globalMmapPending) priorRecovery = recoverySnapshot();
    if (globalMmapPending) throw recoveryFailureCause ?? new Error("SQLite mmap default state unavailable");
    if (isCancelled(id)) throw new Error("SQLite request cancelled before execution");
    executionStarted = performance.now();
    const entry = cached ? statements.get(sql) : undefined;
    let statement = entry && performance.now() - entry.at < workerData.prepareCacheTTL ? entry.statement : undefined;
    if (!statement) {
      classification = { write: typeof db.setAuthorizer !== "function", check: false, journalMode: false };
      activeClassification = classification;
      try { statement = db.prepare(sql); } finally { activeClassification = undefined; }
      classifications.set(statement, classification);
      if (cached) {
        if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
        statements.set(sql, { statement, at: performance.now() });
      }
    }
    classification = classifications.get(statement);
    if ((attachmentsDirty && (classification?.attachment || typeof db.setAuthorizer !== "function")) ||
      (globalMmapPending && classification?.configuration)) throw recoveryFailureCause ?? new Error("SQLite connection state unavailable");
    observedWrite = Boolean(classifications.get(statement)?.write || classifications.get(statement)?.check);
    mayWrite = observedWrite || db.isTransaction;
    configurationDirty ||= Boolean(classifications.get(statement)?.configuration) || typeof db.setAuthorizer !== "function";
    schemaDirty ||= Boolean(classifications.get(statement)?.schema) || typeof db.setAuthorizer !== "function";
    elapsedMs = performance.now() - executionStarted;
    executionStarted = undefined;
    if (classifications.get(statement)?.write) checkpointWaitMs = await checkpoint?.admit(id) ?? 0;
    if (isCancelled(id)) throw new Error("SQLite request cancelled before execution");
    operation = "execute";
    statement.setReadBigInts(safeIntegers);
    statement.setReturnArrays(values);
    const start = performance.now();
    executionStarted = start;
    if (/^\\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\\b/i.test(sql)) controlStarted = start;
    activeClassification = classifications.get(statement);
    const rows = statement.columns().length > 0 ? statement.all(...params) : (() => {
      const result = statement.run(...params);
      return raw ? result : [];
    })();
    executed = true;
    elapsedMs += performance.now() - executionStarted;
    if (controlStarted !== undefined) controlMs = performance.now() - controlStarted;
    executionStarted = undefined;
    activeClassification = undefined;
    observedWrite ||= Boolean(classifications.get(statement)?.write || classifications.get(statement)?.check);
    mayWrite ||= observedWrite;
    if (!checkpoint && classifications.get(statement)?.journalMode) {
      enableWal();
    }
    const committed = !db.isTransaction && /^\\s*(?:COMMIT|END|INSERT|UPDATE|DELETE|REPLACE)\\b/i.test(statement.sourceSQL);
    const committedTransaction = committed && /^\\s*(?:COMMIT|END)\\s*;?\\s*$/i.test(statement.sourceSQL);
    parentPort.postMessage({ id, rows, committed, committedTransaction, write: observedWrite, elapsedMs, controlMs, checkpointWaitMs,
      inTransaction: db.isTransaction,
      ...priorRecovery, ...recoverySnapshot(classification, sql, params, statement.expandedSQL) });
  } catch (error) {
    activeClassification = undefined;
    const statementElapsed = executionStarted === undefined ? elapsedMs : (elapsedMs ?? 0) + performance.now() - executionStarted;
    if (controlStarted !== undefined && controlMs === undefined) controlMs = performance.now() - controlStarted;
    const snapshot = db ? { ...priorRecovery, ...recoverySnapshot(classification && { ...classification, attachment: executed && classification.attachment }, sql, params) } : {};
    errorReply(id, error, operation, { ...snapshot, inTransaction: db?.isTransaction ?? false, write: observedWrite, elapsedMs: statementElapsed, controlMs, checkpointWaitMs });
  } finally {
    // Authorizer classification covers CTE/commented writes; transaction state
    // covers RELEASE/ROLLBACK. OR FAIL may persist rows despite throwing.
    if (mayWrite && db && !db.isTransaction) checkpoint?.check();
  }
  });
});
`;

// Worker lifecycle deadlines must fire independently of an Effect/TestClock.
const scheduleWorkerDeadline = (callback: () => void, milliseconds: number) =>
  // @effect-diagnostics-next-line globalTimers:off -- Native worker deadlines must not depend on the Effect clock.
  setTimeout(callback, milliseconds);

const makeWriterSession = Effect.fnUntraced(function* (
  options: SqliteClientConfig,
  statementObserver: SqliteStatementObserver | undefined,
  statementMetrics: boolean,
  setup: ReturnType<typeof makeWriterSetup>,
) {
  const failed = (cause: unknown, message: string, operation: string) =>
    new SqlError({ reason: classifyError(cause, message, operation, options, "writer") });
  const cancelledBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const worker = yield* Effect.try({
    try: () =>
      new NodeWorkerThreads.Worker(writerWorkerSource, {
        eval: true,
        workerData: {
          filename: options.filename,
          setup: setup.entries,
          postSetup: setup.postSetup,
          attachments: setup.attachments,
          globalMmap: setup.globalMmap,
          readonly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
          checkpoint: options.checkpointWorker ?? false,
          checkpointStarted: options.checkpointWorkerStart === undefined,
          checkpointSource: checkpointWorkerSource,
          checkpointFrames: CHECKPOINT_FRAMES,
          checkpointIdleMs: CHECKPOINT_IDLE_MS,
          checkpointBackpressureFrames: CHECKPOINT_BACKPRESSURE_FRAMES,
          cancelled: cancelledBuffer,
          prepareCacheSize: options.prepareCacheSize ?? 200,
          prepareCacheTTL: Duration.toMillis(
            Duration.fromInputUnsafe(options.prepareCacheTTL ?? "10 minutes"),
          ),
        },
      }),
    catch: (cause) => failed(cause, "Failed to open database", "open"),
  });
  type Reply = WriterSetupReply & {
    readonly id: number;
    readonly committed?: boolean;
    readonly committedTransaction?: boolean;
    readonly elapsedMs?: number;
    readonly controlMs?: number;
    readonly checkpointWaitMs?: number;
    readonly write?: boolean;
  } & (
      | { readonly rows: ReadonlyArray<any> }
      | {
          readonly error: {
            readonly operation: "open" | "prepare" | "execute" | "close";
            readonly message: string;
            readonly code?: unknown;
            readonly errcode?: unknown;
            readonly errstr?: unknown;
          };
        }
    );
  const pending = new Map<number, (reply: Reply) => void>();
  let nextId = 0;
  let stopped: string | undefined;
  let inTransaction = false;
  let announce: (error?: unknown) => void = () => {};
  let ready = false;
  const started = new Promise<unknown>((resolve) => {
    announce = resolve;
  });
  const startupTimer = scheduleWorkerDeadline(() => {
    stop("SQLite writer startup timed out after 10 seconds");
    void worker.terminate();
  }, 10_000);
  const stop = (message: string) => {
    if (stopped !== undefined) return;
    stopped = message;
    clearTimeout(startupTimer);
    announce(new Error(message));
    for (const [id, resume] of pending) resume({ id, error: { operation: "execute", message } });
    pending.clear();
  };
  worker.on(
    "message",
    (
      reply:
        | Reply
        | { type: "ready" }
        | { type: "checkpoint-warning"; reason: string }
        | { type: "recovery-error"; error: unknown }
        | { type: "checkpoint-error"; connection: "writer" | "checkpoint"; error: unknown }
        | { waiting: number },
    ) => {
      if ("type" in reply && reply.type === "recovery-error") {
        classifyError(
          Object.assign(new Error("SQLite writer recovery snapshot failed"), reply.error),
          "SQLite writer recovery snapshot failed",
          "recovery",
          options,
          "writer",
        );
        return;
      }
      if ("type" in reply && reply.type === "checkpoint-warning") {
        runFork(
          Effect.logWarning(
            "SQLite checkpoint worker unavailable; checkpoints run on the writer connection",
            { reason: reply.reason },
          ),
        );
        return;
      }
      if ("type" in reply && reply.type === "checkpoint-error") {
        classifyError(
          Object.assign(new Error("Checkpoint worker failed"), reply.error),
          "Checkpoint worker failed",
          "checkpoint",
          options,
          reply.connection,
        );
        return;
      }
      if ("waiting" in reply) return;
      if ("type" in reply && reply.type === "ready") {
        if (stopped !== undefined) return;
        clearTimeout(startupTimer);
        ready = true;
        announce();
        if (pending.size === 0) worker.unref();
        return;
      }
      if ("type" in reply) return;
      if (reply.id === 0 && "error" in reply) {
        clearTimeout(startupTimer);
        announce(Object.assign(new Error(reply.error.message), reply.error));
        return;
      }
      if (reply.inTransaction !== undefined) inTransaction = reply.inTransaction;
      const resume = pending.get(reply.id);
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      resume?.(reply);
    },
  );
  worker.on("error", (error) => stop(error.message));
  worker.on("exit", (code) => stop(`SQLite writer exited (${code}); outcome may be unknown`));

  const request: (
    input: Partial<ReaderRequest> & {
      close?: boolean;
      checkpointStart?: boolean;
      rollbackIfOpen?: boolean;
    },
    onClassification?: (write: boolean) => void,
  ) => Effect.Effect<ReadonlyArray<any>, SqlError> = (input, onClassification) =>
    Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
      const restore = fiber.getRef(TransactionAcquire)?.restore;
      const awaitingBegin = restore !== undefined && /^\s*BEGIN\b/i.test(input.sql ?? "");
      const execute = Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
        if (stopped !== undefined) {
          resume(Effect.fail(failed(new Error(stopped), "SQLite writer unavailable", "execute")));
          return;
        }
        const id = ++nextId;
        const cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        let acknowledge: () => void = () => {};
        const acknowledged = new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
        pending.set(id, (reply) => {
          acknowledge();
          onClassification?.(reply.write ?? false);
          const currentSpan = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
          try {
            // The writer permit includes pre-BEGIN WAL admission. Keep that wait
            // distinct from SQLite execution and the transaction body's work.
            if (reply.checkpointWaitMs !== undefined && reply.checkpointWaitMs > 0) {
              const transactionSpan = fiber.getRef(TransactionAcquire)?.span;
              for (const span of new Set([currentSpan, transactionSpan])) {
                if (span?._tag === "Span")
                  span.attribute(
                    "db.writer.checkpoint_wait_ms",
                    Number(span.attributes.get("db.writer.checkpoint_wait_ms") ?? 0) +
                      reply.checkpointWaitMs,
                  );
              }
            }
            if (
              fiber.getRef(References.TracerEnabled) &&
              fiber.getRef(Statement.SpanPropagationEnabled) &&
              currentSpan?._tag === "Span" &&
              reply.elapsedMs !== undefined
            ) {
              currentSpan.attribute("db.statement.execution_ms", reply.elapsedMs);
              currentSpan.attribute("db.execution.thread", "worker");
            }
          } catch {
            /* Timing must not change a statement's outcome. */
          }
          if (reply.controlMs !== undefined && currentSpan?._tag === "Span")
            try {
              const control = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i
                .exec(input.sql ?? "")?.[1]
                ?.toLowerCase();
              const prefix = `db.transaction.control.${control === "end" ? "commit" : control}`;
              currentSpan.attribute(
                `${prefix}_ms`,
                Number(currentSpan.attributes.get(`${prefix}_ms`) ?? 0) + reply.controlMs,
              );
              currentSpan.attribute(
                `${prefix}_count`,
                Number(currentSpan.attributes.get(`${prefix}_count`) ?? 0) + 1,
              );
            } catch {
              /* Timing must not change a transaction's outcome. */
            }
          if ("error" in reply) {
            if (reply.inTransaction === false) setup.reset();
            setup.record(reply);
            resume(
              Effect.fail(
                failed(
                  Object.assign(new Error(reply.error.message), reply.error),
                  reply.error.operation === "close"
                    ? "Failed to close database"
                    : readerFailureMessages[reply.error.operation],
                  reply.error.operation,
                ),
              ),
            );
          } else {
            if (input.sql !== undefined) setup.record(reply);
            // Observe after SQLite returns; tracing must never change a commit result.
            try {
              if (reply.committedTransaction) fiber.getRef(TransactionCommitObserver)?.();
              const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
              if (
                statementMetrics &&
                fiber.getRef(References.TracerEnabled) &&
                fiber.getRef(Statement.SpanPropagationEnabled) &&
                span?._tag === "Span"
              ) {
                span.attribute(
                  "db.rows_returned",
                  Array.isArray(reply.rows) ? reply.rows.length : 0,
                );
                span.attribute("db.stmt_status.available", false);
                if (reply.committed) {
                  span.attribute(
                    "db.commit.at_ms",
                    fiber.getRef(Clock.Clock).currentTimeMillisUnsafe(),
                  );
                  span.attribute("db.commit.duration_ms", reply.elapsedMs ?? 0);
                  span.attribute("db.commit.boundary", "sqlite-worker-returned");
                }
              }
            } catch {
              /* Observations cannot invalidate a commit. */
            }
            resume(Effect.succeed(reply.rows));
          }
        });
        worker.ref();
        try {
          const message = {
            ...input,
            // Structured clone drops named fields from built-in objects and rejects functions.
            ...(input.params === undefined
              ? {}
              : {
                  params: input.params.map((value) =>
                    typeof value === "function" ||
                    (typeof value === "object" && value !== null && !isBlob(value))
                      ? Object.fromEntries(Object.entries(value))
                      : value,
                  ),
                }),
            id,
            cancellation: cancellation.buffer,
            safeIntegers: Boolean(Context.get(fiber.context, Client.SafeIntegers)),
          };
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage(message);
        } catch (cause) {
          pending.delete(id);
          if (pending.size === 0) worker.unref();
          acknowledge();
          resume(Effect.fail(failed(cause, "Failed to send SQLite request", "execute")));
        }
        // Retain the permit until the worker confirms it skipped or finished SQL.
        return Effect.promise(() => {
          Atomics.store(cancellation, 0, 1);
          try {
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
            worker.postMessage({ cancel: id });
          } catch {}
          return acknowledged;
        }).pipe(
          Effect.andThen(
            awaitingBegin
              ? request({
                  sql: "ROLLBACK",
                  params: [],
                  cached: false,
                  values: false,
                  raw: false,
                }).pipe(Effect.ignore)
              : Effect.void,
          ),
        );
      });
      return awaitingBegin && restore !== undefined ? restore(execute) : execute;
    });
  yield* Effect.addFinalizer(() =>
    Effect.flatMap(
      Effect.sync(() =>
        scheduleWorkerDeadline(() => {
          void worker.terminate();
        }, 5000),
      ),
      (timer) =>
        (ready ? request({ close: true }) : Effect.void).pipe(
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => clearTimeout(timer))),
          Effect.ensuring(Effect.promise(() => worker.terminate())),
        ),
    ),
  );
  if (options.checkpointWorkerStart !== undefined) {
    yield* options.checkpointWorkerStart.pipe(
      Effect.andThen(request({ checkpointStart: true })),
      Effect.ignore,
      Effect.forkScoped,
    );
  }
  const startupError = yield* Effect.promise(() => started);
  if (startupError !== undefined)
    return yield* Effect.fail(failed(startupError, "Failed to open database", "open"));
  const run = (
    sql: string,
    params: ReadonlyArray<unknown>,
    values = false,
    raw = false,
    cached = true,
  ) => {
    let write = false;
    return observeStatement(
      request(
        {
          sql,
          params,
          values,
          raw,
          cached: cached && (options.prepareCacheSize ?? 200) > 0 && !hasLargeBinding(params),
        },
        (value) => {
          write = value;
        },
      ),
      () => (write ? "write" : "read"),
      "writer",
      statementObserver,
    );
  };
  const retire = Effect.promise(() => {
    stop("SQLite writer retired after transaction cleanup failed");
    return worker.terminate();
  }).pipe(Effect.asVoid);
  // A failed raw COMMIT retains SQLite's transaction while the caller owns its
  // reservation. Only the lease boundary may roll it back or retire the worker.
  const release = Effect.suspend(() =>
    stopped !== undefined
      ? retire
      : !inTransaction
        ? Effect.void
        : request({
            sql: "ROLLBACK",
            params: [],
            cached: false,
            values: false,
            raw: false,
            rollbackIfOpen: true,
          }).pipe(
            Effect.asVoid,
            Effect.catch(() => retire),
          ),
  );
  return {
    healthy: () => stopped === undefined,
    release,
    connection: identity<Connection>({
      execute(sql, params, transform) {
        const result = run(sql, params);
        return transform ? Effect.map(result, transform) : result;
      },
      executeRaw: (sql, params) => run(sql, params, false, true),
      executeValues: (sql, params) => run(sql, params, true),
      executeValuesUnprepared: (sql, params) => run(sql, params ?? [], true, false, false),
      executeUnprepared(sql, params, transform) {
        const result = run(sql, params ?? [], false, false, false);
        return transform ? Effect.map(result, transform) : result;
      },
      executeStream: () => Stream.die(new UnsupportedNodeSqliteOperationError()),
    }),
  };
});

const makeWriter = Effect.fnUntraced(function* (
  options: SqliteClientConfig,
  statementObserver: SqliteStatementObserver | undefined,
  statementMetrics: boolean,
) {
  const parentScope = yield* Effect.scope;
  const setup = makeWriterSetup();
  let sessionScope = yield* Scope.fork(parentScope, "sequential");
  const open = () =>
    makeWriterSession(options, statementObserver, statementMetrics, setup).pipe(
      Effect.provideService(Scope.Scope, sessionScope),
    );
  let session = yield* open();
  const ensure = Effect.suspend(() =>
    session.healthy()
      ? Effect.void
      : Effect.gen(function* () {
          yield* Scope.close(sessionScope, Exit.void);
          setup.reset();
          if (!setup.canRecover)
            return yield* new SqlError({
              reason: classifyError(
                new Error("SQLite connection state could not be observed"),
                "Failed to restore SQLite writer connection",
                "open",
                options,
                "writer",
              ),
            });
          sessionScope = yield* Scope.fork(parentScope, "sequential");
          session = yield* open();
        }),
  ).pipe(Effect.uninterruptible);
  return identity<WriterConnection>({
    ensure,
    release: Effect.suspend(() => session.release),
    execute: (sql, params, transform) =>
      Effect.suspend(() => session.connection.execute(sql, params, transform)),
    executeRaw: (sql, params) => Effect.suspend(() => session.connection.executeRaw(sql, params)),
    executeValues: (sql, params) =>
      Effect.suspend(() => session.connection.executeValues(sql, params)),
    executeValuesUnprepared: (sql, params) =>
      Effect.suspend(() => session.connection.executeValuesUnprepared(sql, params)),
    executeUnprepared: (sql, params, transform) =>
      Effect.suspend(() => session.connection.executeUnprepared(sql, params, transform)),
    executeStream: () => Stream.die(new UnsupportedNodeSqliteOperationError()),
  });
});

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  const transactionOwner = {};
  const pendingForClient = (fiber: Fiber.Fiber<unknown, unknown>) => {
    const pending = fiber.getRef(TransactionAcquire);
    return pending?.owner === transactionOwner ? pending : undefined;
  };
  options = { ...options, errorObserver: options.errorObserver ?? (yield* ErrorObserver) };
  const statementObserver = yield* StatementObserver;
  yield* checkNodeSqliteCompat();
  const statementMetrics =
    options.statementMetrics ??
    (yield* Config.Boolean("ROBOB_SQL_STATEMENT_METRICS").pipe(
      Config.withDefault(false),
      Effect.orDie,
    ));

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    if (isFileDatabase) return yield* makeWriter(options, statementObserver, statementMetrics);
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () =>
        new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "open", options),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to close database", "close", options),
          }),
      }).pipe(Effect.orDie),
    );

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    interface CheckpointClassification {
      backpressure: boolean;
      check: boolean;
    }
    const checkpointClassifications = new WeakMap<
      NodeSqlite.StatementSync,
      CheckpointClassification
    >();
    const mutatingPragmasWithValues = new Set([
      "application_id",
      "auto_vacuum",
      "journal_mode",
      "schema_version",
      "user_version",
    ]);
    const mutatesPragma = (name: string | null, value: string | null) => {
      const pragma = name?.toLowerCase();
      if (pragma === undefined) return false;
      if (pragma === "incremental_vacuum" || pragma === "optimize") return true;
      if (pragma === "wal_checkpoint") return value?.toLowerCase() !== "noop";
      return value !== null && mutatingPragmasWithValues.has(pragma);
    };
    let activeClassification: CheckpointClassification | undefined;
    const withClassification = <A>(
      classification: CheckpointClassification | undefined,
      f: () => A,
    ): A => {
      if (classification === undefined) return f();
      const previous = activeClassification;
      activeClassification = classification;
      try {
        return f();
      } finally {
        activeClassification = previous;
      }
    };
    if (typeof db.setAuthorizer === "function") {
      // SQLite may reprepare an expired statement while it executes. Keep this
      // callback installed and collect only around that statement's prepare/run.
      db.setAuthorizer((actionCode, action, argument) => {
        const classification = activeClassification;
        if (classification === undefined) return NodeSqlite.constants.SQLITE_OK;
        const constants = NodeSqlite.constants;
        if (actionCode === constants.SQLITE_TRANSACTION) {
          classification.backpressure ||= action === "BEGIN";
          classification.check ||= action === "COMMIT" || action === "ROLLBACK";
        } else if (actionCode === constants.SQLITE_SAVEPOINT) {
          classification.backpressure ||= action === "BEGIN";
          classification.check = true;
        } else if (actionCode === constants.SQLITE_PRAGMA && mutatesPragma(action, argument)) {
          classification.backpressure = true;
          classification.check = true;
        } else if (
          actionCode !== constants.SQLITE_READ &&
          actionCode !== constants.SQLITE_SELECT &&
          actionCode !== constants.SQLITE_FUNCTION &&
          actionCode !== constants.SQLITE_RECURSIVE &&
          actionCode !== constants.SQLITE_PRAGMA
        ) {
          classification.backpressure = true;
          classification.check = true;
        }
        return constants.SQLITE_OK;
      });
    }
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => {
          const classification = { backpressure: false, check: false };
          const statement = withClassification(classification, () => db.prepare(sql));
          checkpointClassifications.set(statement, classification);
          return statement;
        },
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare", options),
          }),
      });

    const prepareCache = yield* Cache.makeWith(prepare, {
      capacity: options.prepareCacheSize ?? 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
    });

    const statementFor = (sql: string, params: ReadonlyArray<unknown>) =>
      hasLargeBinding(params) ? prepare(sql) : Cache.get(prepareCache, sql);

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      mode: "rows" | "raw" | "values" = "rows",
    ) =>
      observeStatement(
        Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
          const classification = checkpointClassifications.get(statement);
          const control = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i
            .exec(statement.sourceSQL)?.[1]
            ?.toLowerCase();
          const execute = () => {
            const controlStart = control === undefined ? undefined : performance.now();
            let arrays = false;
            let result: Exit.Exit<ReadonlyArray<unknown>, SqlError>;
            try {
              const value = withClassification(classification, () => {
                statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
                if (hasRows(statement)) {
                  arrays = mode === "values";
                  if (arrays) statement.setReturnArrays(true);
                  return statement.all(...(params as any));
                }
                const result = statement.run(...(params as any));
                return mode === "raw" ? (result as unknown as ReadonlyArray<unknown>) : [];
              });
              const commitObserver = fiber.getRef(TransactionCommitObserver);
              if (
                commitObserver !== undefined &&
                !db.isTransaction &&
                /^\s*(?:COMMIT|END)\s*;?\s*$/i.test(statement.sourceSQL)
              ) {
                try {
                  commitObserver();
                } catch {
                  /* An observer cannot turn a successful COMMIT into a failed write. */
                }
              }
              if (statementMetrics) {
                // SQLite has returned and released the outer transaction. This marks
                // each commit, not an atomic receipt for a multi-write service call.
                try {
                  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
                  if (span?._tag === "Span") {
                    span.attribute("db.rows_returned", Array.isArray(value) ? value.length : 0);
                    span.attribute("db.stmt_status.available", false);
                    if (
                      !db.isTransaction &&
                      /^\s*(?:COMMIT|END|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement.sourceSQL)
                    ) {
                      span.attribute(
                        "db.commit.at_ms",
                        fiber.getRef(Clock.Clock).currentTimeMillisUnsafe(),
                      );
                      span.attribute("db.commit.boundary", "sqlite-returned");
                    }
                  }
                } catch {
                  /* Observing a committed write must never change its result. */
                }
              }
              result = Exit.succeed(value);
            } catch (cause) {
              result = Exit.fail(
                new SqlError({
                  reason: classifyError(cause, "Failed to execute statement", "execute", options),
                }),
              );
            } finally {
              if (controlStart !== undefined)
                try {
                  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
                  if (span?._tag === "Span") {
                    const operation = control === "end" ? "commit" : control;
                    const prefix = `db.transaction.control.${operation}`;
                    span.attribute(
                      `${prefix}_ms`,
                      Number(span.attributes.get(`${prefix}_ms`) ?? 0) +
                        performance.now() -
                        controlStart,
                    );
                    span.attribute(
                      `${prefix}_count`,
                      Number(span.attributes.get(`${prefix}_count`) ?? 0) + 1,
                    );
                  }
                } catch {
                  /* Timing must not change a transaction's outcome. */
                }
            }
            if (arrays) {
              try {
                statement.setReturnArrays(false);
              } catch (cause) {
                return Exit.die(
                  new SqlError({
                    reason: classifyError(
                      cause,
                      "Failed to reset statement result mode",
                      "resetResultMode",
                      options,
                    ),
                  }),
                );
              }
            }
            return result;
          };
          return execute();
        }),
        () => {
          const classification = checkpointClassifications.get(statement);
          return classification?.backpressure || classification?.check ? "write" : "read";
        },
        "writer",
        statementObserver,
      );

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatement(statement, params, raw ? "raw" : "rows"),
      );
    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatement(statement, params, "values"),
      );

    return identity<WriterConnection>({
      ensure: Effect.void,
      release: Effect.void,
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatement(statement, params ?? [], "values"),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [])),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;
  const readers = Boolean(options.readerWorker) && isFileDatabase;
  // All slots pin their WAL snapshots under one lock, so an archive mover sees one gate.
  const snapshotLock =
    options.readerSnapshotLock ??
    (options.readerSnapshotSql !== undefined ? yield* Semaphore.make(1) : undefined);
  const laneMaxResultBytes = (lane: "foreground" | "background") =>
    typeof options.readerMaxResultBytes === "number"
      ? options.readerMaxResultBytes
      : (options.readerMaxResultBytes?.[lane] ?? 0);
  const laneReader = (lane: "foreground" | "background") =>
    makeReader({
      ...options,
      readerSnapshotLock: snapshotLock,
      readerMaxResultBytes: laneMaxResultBytes(lane),
      readerInitializationSql:
        lane === "foreground"
          ? [
              ...(options.readerInitializationSql ?? []),
              ...(options.foregroundReaderInitializationSql ?? []),
            ]
          : options.readerInitializationSql,
    });
  // Only the explicit zero-foreground layout shares interactive reads with background.
  const background = readers
    ? yield* makeReaderPool({
        lane: "background",
        slots: yield* Effect.forEach(
          Array.from({ length: Math.max(1, Math.floor(options.backgroundReaderSlots ?? 1)) }),
          () => laneReader("background"),
        ),
        queueLimit: options.readerQueueLimits?.background ?? 1024,
      })
    : undefined;
  const foregroundSlots = readers ? Math.max(0, Math.floor(options.foregroundReaderSlots ?? 0)) : 0;
  const foreground =
    foregroundSlots > 0
      ? yield* makeReaderPool({
          lane: "foreground",
          slots: yield* Effect.forEach(Array.from({ length: foregroundSlots }), () =>
            laneReader("foreground"),
          ),
          queueLimit: options.readerQueueLimits?.foreground ?? 128,
        })
      : undefined;
  // Reserved (auth/identity) lanes: one limit bounds a statement and a
  // snapshot, and the wait for the lane follows it. A waiter must outlast one
  // statement plus the watchdog's detection lag (it abandons a caller up to one
  // tick after the limit), or a read queued just behind a slow statement times
  // out at admission (busy, not retryable) instead of reaching the fail-fast
  // path (never started, retryable). Default 5 s statement, 5.5 s admission.
  const reservedStatementLimit = options.readerStatementLimit ?? "5 seconds";
  const reservedAdmissionLimit = Duration.sum(
    Duration.fromInputUnsafe(reservedStatementLimit),
    Duration.millis(2 * RESERVED_READER_WATCHDOG_MS),
  );
  const acquireAuth =
    readers && options.authReaderProcess
      ? yield* makeReaderLanes(
          () =>
            makeAuthReader({
              ...options,
              readerStatementLimit: reservedStatementLimit,
            }),
          reservedAdmissionLimit,
        )
      : undefined;

  const acquireIdentity =
    readers && (options.identityReaderProcess ?? options.authReaderProcess)
      ? yield* makeReaderLanes(
          () =>
            makeAuthReader({
              ...options,
              readerStatementLimit: reservedStatementLimit,
            }),
          reservedAdmissionLimit,
        )
      : undefined;

  const writer: RouteTarget = { name: "writer", lock: bindSemaphore(semaphore), connection };
  const admission = Effect.withFiber((fiber) => {
    const wait = options.beforeAcquire ?? Effect.void;
    const restore = pendingForClient(fiber)?.restore;
    return restore === undefined ? wait : restore(wait);
  });
  const reservedReader = (lane: "auth" | "identity") =>
    lane === "identity" ? acquireIdentity : acquireAuth;
  const observedReaders = new WeakMap<Connection, Connection>();
  const originalReaders = new WeakMap<Connection, Connection>();
  const observeReaderConnection = (
    connection: Connection,
    lane: ReaderLaneName | undefined,
  ): Connection => {
    const existing = observedReaders.get(connection);
    if (existing !== undefined) return existing;
    const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      observeStatement(effect, () => "read", "reader", statementObserver, lane);
    const observed: Connection = {
      ...connection,
      execute: (sql, params, transform) => observe(connection.execute(sql, params, transform)),
      executeRaw: (sql, params) => observe(connection.executeRaw(sql, params)),
      executeValues: (sql, params) => observe(connection.executeValues(sql, params)),
      executeValuesUnprepared: (sql, params) =>
        observe(connection.executeValuesUnprepared(sql, params)),
      executeUnprepared: (sql, params, transform) =>
        observe(connection.executeUnprepared(sql, params, transform)),
    };
    observedReaders.set(connection, observed);
    originalReaders.set(observed, connection);
    return observed;
  };
  const viaPool = (
    pool: NonNullable<typeof background>,
    orElse: Effect.Effect<RouteTarget, SqlError>,
  ): Effect.Effect<RouteTarget, SqlError> =>
    Effect.flatMap(pool.acquire, (slot) =>
      slot === undefined
        ? orElse
        : Effect.succeed<RouteTarget>({
            name: "reader",
            lane: slot.lane,
            slot: slot.slot,
            lock: slot.lock,
            connection: slot.connection,
          }),
    );
  const route = (statementSpan?: Tracer.Span) =>
    Effect.andThen(
      admission,
      Effect.withFiber<RouteTarget, SqlError>((fiber) => {
        if (!Context.get(fiber.context, ReadOnly)) return Effect.succeed(writer);
        const writerFallback: Effect.Effect<RouteTarget, SqlError> = Context.get(
          fiber.context,
          ReaderRequired,
        )
          ? Effect.fail(readerBusy("Required SQLite reader unavailable", false))
          : Effect.succeed(writer);
        const requestedLane = Context.get(fiber.context, ReaderLane);
        const lane = effectiveLane(fiber.context);
        const pending = pendingForClient(fiber);
        const span =
          fiber.getRef(References.TracerEnabled) && fiber.getRef(Statement.SpanPropagationEnabled)
            ? (pending?.span ?? statementSpan)
            : undefined;
        if (span?._tag === "Span") {
          if (pending !== undefined) pending.span = span;
          span.attribute("db.reader.requested_lane", requestedLane);
          span.attribute("db.reader.effective_lane", lane);
          span.attribute(
            "db.reader.route_reason",
            lane === requestedLane ? "requested" : "foreground_scope_ended",
          );
          span.attribute("db.reader.waiting", true);
          span.attribute("db.reader.acquire_stage", "worker");
        }
        if (background === undefined) {
          if (span?._tag === "Span")
            span.attribute("db.reader.route_reason", "reader_pool_unconfigured");
          return writerFallback;
        }
        if (isReservedLane(lane)) {
          const reserved = reservedReader(lane);
          if (reserved !== undefined)
            return Effect.map(reserved, (reader): RouteTarget => ({
              name: "reader",
              lane,
              ...reader,
            }));
          if (span?._tag === "Span")
            span.attribute("db.reader.route_reason", "reserved_lane_unconfigured");
        }
        // Ordinary reads retain writer fallback; long snapshots can require a reader.
        const viaBackground = viaPool(
          background,
          Effect.suspend(() => {
            if (span?._tag === "Span")
              span.attribute("db.reader.route_reason", "background_worker_unavailable");
            return writerFallback;
          }),
        );
        if (lane === "foreground" && foreground !== undefined) {
          return viaPool(
            foreground,
            Effect.suspend(() => {
              if (span?._tag === "Span")
                span.attribute("db.reader.route_reason", "foreground_worker_unavailable");
              return Effect.fail(
                readerBusy("Reader lane unavailable: foreground worker unavailable", false),
              );
            }),
          );
        }
        if (lane === "foreground" && span?._tag === "Span") {
          span.attribute("db.reader.effective_lane", "background");
          span.attribute("db.reader.route_reason", "foreground_slots_zero");
        }
        return viaBackground;
      }),
    ).pipe(
      Effect.tap((target) =>
        Effect.withFiber((fiber) =>
          Effect.sync(() => {
            if (
              !fiber.getRef(References.TracerEnabled) ||
              !fiber.getRef(Statement.SpanPropagationEnabled)
            )
              return;
            const span = pendingForClient(fiber)?.span ?? statementSpan;
            if (span?._tag !== "Span") return;
            span.attribute("db.connection", target.name);
            span.attribute("db.reader.acquire_stage", "slot");
            span.attribute("db.reader.effective_lane", target.lane ?? "writer");
            if (target.lane !== undefined) span.attribute("db.reader.lane", target.lane);
            if (target.slot !== undefined) span.attribute("db.reader.slot", target.slot);
          }),
        ),
      ),
      Effect.map((target) =>
        target.name === "reader"
          ? { ...target, connection: observeReaderConnection(target.connection, target.lane) }
          : target,
      ),
    );

  const acquired = (target: RouteTarget, clock: Clock.Clock, start: bigint): Acquired => ({
    connection: target.name,
    lockWaitMs: Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000,
    ...(target.lane === undefined ? {} : { lane: target.lane }),
    ...(target.slot === undefined ? {} : { slot: target.slot }),
  });
  const dbName = String(options.spanAttributes?.["db.name"] ?? "sqlite");
  const observeReader = (target: RouteTarget, metric: typeof readerWait, ms: number) =>
    target.name === "reader"
      ? Metric.update(
          Metric.withAttributes(metric, { lane: target.lane ?? "background", db: dbName }),
          Duration.millis(ms),
        )
      : Effect.void;
  const holdMs = (clock: Clock.Clock, start: bigint) =>
    Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000;
  const writerBorrowBatchSize = 16;
  let writerBorrowsSinceYield = 0;
  const borrower: Borrower = <A, E, R>(use: (connection: Connection) => Effect.Effect<A, E, R>) =>
    Effect.withFiber((requestFiber) => {
      const span = Context.getOrUndefined(requestFiber.context, Tracer.ParentSpan);
      const clock = requestFiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      let started = false;
      const borrow = Effect.flatMap(route(span?._tag === "Span" ? span : undefined), (target) =>
        Effect.withFiber<A, E | SqlError, R>((fiber) => {
          const traced =
            fiber.getRef(References.TracerEnabled) &&
            fiber.getRef(Statement.SpanPropagationEnabled);
          const useConnection = Effect.suspend(() => {
            started = true;
            const grant = acquired(target, clock, start);
            if (target.name === "reader") reportReaderWait(requestFiber, grant.lockWaitMs);
            if (traced) annotateAcquired(fiber, grant);
            if (target.name !== "reader")
              return Effect.andThen(connection.ensure, use(target.connection));
            const granted = clock.monotonicTimeNanosUnsafe();
            return Effect.andThen(
              observeReader(target, readerWait, grant.lockWaitMs),
              use(target.connection).pipe(
                Effect.ensuring(
                  Effect.suspend(() => {
                    const held = holdMs(clock, granted);
                    if (traced) annotateHold(fiber, held);
                    return observeReader(target, readerHold, held);
                  }),
                ),
              ),
            );
          });
          const writerUse = Effect.onExit(useConnection, (exit) =>
            Effect.sync(() => {
              writerBorrowsSinceYield = Exit.hasInterrupts(exit)
                ? 0
                : Math.min(writerBorrowsSinceYield + 1, writerBorrowBatchSize);
            }),
          );
          const acquire =
            !options.checkpointWorker || target.name !== "writer"
              ? target.lock.withPermits(1)(useConnection)
              : Effect.flatMap(target.lock.withPermitsIfAvailable(1)(writerUse), (result) =>
                  Option.isSome(result)
                    ? Effect.succeed(result.value)
                    : target.lock.withPermits(1)(
                        Effect.andThen(
                          // Failed SQL also consumes the batch; cancellation hands off immediately.
                          Effect.suspend(() => {
                            if (writerBorrowsSinceYield < writerBorrowBatchSize) return Effect.void;
                            writerBorrowsSinceYield = 0;
                            return Effect.callback<void>((resume) => {
                              const immediate = setImmediate(() => resume(Effect.void));
                              return Effect.sync(() => clearImmediate(immediate));
                            });
                          }),
                          writerUse,
                        ),
                      ),
                );
          return Effect.onExit(acquire, (exit) =>
            Effect.sync(() => {
              if (started || !traced || span?._tag !== "Span") return;
              const wait = acquired(target, clock, start);
              span.attribute("db.connection", wait.connection);
              if (wait.lane !== undefined) span.attribute("db.reader.lane", wait.lane);
              if (wait.slot !== undefined) span.attribute("db.reader.slot", wait.slot);
              span.attribute("db.reader.waiting", true);
              span.attribute("db.reader.wait_interrupted", Exit.hasInterrupts(exit));
              span.attribute("db.lock_wait_ms", wait.lockWaitMs);
              span.attribute("db.reader.acquired", false);
              span.attribute("db.reader.wait_ms", wait.lockWaitMs);
              span.attribute("db.reader.acquire_wait_ms", wait.lockWaitMs);
            }),
          );
        }),
      );
      if (requestFiber.getRef(ReaderWaitObserver) === undefined) return borrow;
      return borrow.pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            if (!started && requestFiber.getRef(ReadOnly))
              reportReaderWait(requestFiber, holdMs(clock, start));
          }),
        ),
      );
    });
  const transactionAcquirer = Effect.withFiber((requestFiber) => {
    const clock = requestFiber.getRef(Clock.Clock);
    const start = clock.monotonicTimeNanosUnsafe();
    let acquiredSlot = false;
    const acquireReader = Effect.flatMap(route(), (target) =>
      Effect.uninterruptibleMask((restore) => {
        const fiber = Fiber.getCurrent()!;
        const scope = Context.getUnsafe(fiber.context, Scope.Scope);
        const pending = pendingForClient(fiber);
        if (pending !== undefined) pending.permitStarted = start;
        if (
          pending !== undefined &&
          target.name === "reader" &&
          target.lane !== undefined &&
          isReservedLane(target.lane)
        )
          pending.retire = retireAuthReader(
            originalReaders.get(target.connection) ?? target.connection,
          );
        const acquire = Effect.tap((pending?.restore ?? restore)(target.lock.take(1)), () => {
          const grant = acquired(target, clock, start);
          acquiredSlot = true;
          if (target.name === "reader") reportReaderWait(requestFiber, grant.lockWaitMs);
          if (pending !== undefined) pending.acquired = grant;
          if (
            pending !== undefined &&
            fiber.getRef(References.TracerEnabled) &&
            fiber.getRef(Statement.SpanPropagationEnabled)
          )
            annotateAcquired(fiber, grant, pending?.span);
          if (pending?.span !== undefined)
            pending.span.attribute("db.reader.acquire_stage", "acquired");
          const granted = clock.monotonicTimeNanosUnsafe();
          // The snapshot is pinned to this slot from BEGIN to COMMIT; its permit is the hold.
          return Effect.andThen(
            observeReader(target, readerWait, grant.lockWaitMs),
            Scope.addFinalizer(
              scope,
              (target.name === "writer" ? connection.release : Effect.void).pipe(
                Effect.ensuring(target.lock.release(1)),
                Effect.andThen(
                  Effect.suspend(() => {
                    const held = holdMs(clock, granted);
                    if (pending?.span !== undefined)
                      pending.span.attribute("db.reader.hold_ms", held);
                    return observeReader(target, readerHold, held);
                  }),
                ),
              ),
            ),
          );
        });
        return Effect.as(
          // A scheduler yield after taking the permit must not precede its release finalizer.
          Effect.andThen(
            Effect.provideService(acquire, Scheduler.PreventSchedulerYield, true),
            target.name === "writer" ? connection.ensure : Effect.void,
          ),
          target.connection,
        );
      }),
    );
    if (requestFiber.getRef(ReaderWaitObserver) === undefined) return acquireReader;
    return acquireReader.pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          if (!acquiredSlot && requestFiber.getRef(ReadOnly))
            reportReaderWait(requestFiber, holdMs(clock, start));
        }),
      ),
    );
  }).pipe(
    Effect.onExit((exit) =>
      Effect.withFiber((fiber) =>
        Effect.sync(() => {
          const pending = pendingForClient(fiber);
          if (pending?.acquired === undefined && pending?.span !== undefined) {
            pending.span.attribute("db.reader.waiting", true);
            pending.span.attribute("db.reader.acquired", false);
            pending.span.attribute(
              "db.reader.wait_ms",
              Number(
                fiber.getRef(Clock.Clock).monotonicTimeNanosUnsafe() -
                  (pending.permitStarted ?? pending.started),
              ) / 1e6,
            );
            pending.span.attribute("db.reader.wait_interrupted", Exit.hasInterrupts(exit));
            const waited =
              Number(fiber.getRef(Clock.Clock).monotonicTimeNanosUnsafe() - pending.started) / 1e6;
            pending.span.attribute("db.lock_wait_ms", waited);
            pending.span.attribute("db.reader.acquire_wait_ms", waited);
          }
        }),
      ),
    ),
  );

  const client = yield* Client.make({
    acquirer: transactionAcquirer,
    borrower,
    compiler,
    transactionAcquirer,
    // A deferred BEGIN only takes the write lock at the first write. If another
    // process commits after this transaction's first read, that write fails at
    // once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
  const withTransaction = client.withTransaction;
  return Object.assign(client, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.withFiber((fiber) =>
        Effect.uninterruptibleMask((restore) => {
          // Nested transactions bypass route(); retain the outer reader context for deeper savepoints.
          if (Context.getOption(fiber.context, client.transactionService)._tag === "Some") {
            return fiber.getRef(ReaderRequired) &&
              pendingForClient(fiber)?.acquired?.connection !== "reader"
              ? Effect.fail(
                  readerBusy("Required SQLite reader unavailable inside writer transaction", false),
                )
              : restore(withTransaction(effect));
          }
          // SqlClient masks setup; acquisition must preserve the caller's interruptibility.
          const pending: TransactionPending = {
            owner: transactionOwner,
            restore,
            started: fiber.getRef(Clock.Clock).monotonicTimeNanosUnsafe(),
          };
          const tracer = fiber.getRef(Tracer.Tracer);
          // SqlClient exposes its transaction span only to the body, after acquisition.
          // Capture that same span at creation so failed/interrupting acquisition is visible too.
          const transactionTracer: Tracer.Tracer = {
            ...tracer,
            span: (options) => {
              const span = tracer.span(options);
              if (options.name === "sql.transaction" && pending.span === undefined) {
                pending.span = span;
                if (
                  Context.get(fiber.context, ReadOnly) &&
                  Context.getOption(fiber.context, client.transactionService)._tag === "None"
                ) {
                  const requested = Context.get(fiber.context, ReaderLane);
                  const effective = effectiveLane(fiber.context);
                  span.attribute("db.reader.requested_lane", requested);
                  span.attribute("db.reader.effective_lane", effective);
                  span.attribute(
                    "db.reader.route_reason",
                    effective === requested ? "requested" : "foreground_scope_ended",
                  );
                  span.attribute("db.reader.waiting", true);
                  span.attribute("db.reader.acquire_stage", "admission");
                  span.attribute("db.reader.acquired", false);
                }
              }
              return span;
            },
          };
          const body = Effect.withFiber<A, E | SqlError, R>((fiber) => {
            annotateAcquired(fiber, pending.acquired, pending.span);
            const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
            if (span?._tag === "Span") pending.span = span;
            pending.restore = undefined;
            return pending.acquired?.connection === "reader" &&
              pending.acquired.lane !== undefined &&
              isReservedLane(pending.acquired.lane)
              ? Effect.timeoutOrElse(effect, {
                  duration: options.readerStatementLimit ?? "5 seconds",
                  orElse: () =>
                    Effect.fail(
                      new SqlError({
                        reason: classifySqliteError(new Error("Reserved reader snapshot expired"), {
                          operation: "readerSnapshot",
                          message: "Reserved reader snapshot expired",
                        }),
                      }),
                    ),
                }).pipe(
                  Effect.onExit((exit) =>
                    Exit.isFailure(exit) ? (pending.retire ?? Effect.void) : Effect.void,
                  ),
                )
              : effect;
          });
          return restore(
            withTransaction(body).pipe(
              Effect.provideService(TransactionAcquire, pending),
              Effect.withTracer(transactionTracer),
            ),
          );
        }),
      ),
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
