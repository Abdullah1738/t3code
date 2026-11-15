// @effect-diagnostics nodeBuiltinImport:off -- native fsync and same-directory atomic publication share a filesystem protocol.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";
import type * as NodeSqlite from "node:sqlite";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import { forkParked } from "../../serverActivation.ts";
import * as BoardsDatabase from "./BoardsDatabase.ts";
import * as Analytics from "../analytics/Analytics.ts";
import { backupSnapshotWorker, type BackupCommand } from "./backupSnapshotWorker.ts";

const stateTables = [
  "projection_projects",
  "orchestration_v2_projection_provider_session_bindings",
  "ardud_thread_origin",
  "ardud_opencode_import_state",
  "effect_sql_migrations",
  "scheduled_tasks",
];
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const MAX_TABLE_BYTES = 200 * 1024 * 1024;
const PAGE_ROWS = 128;

class BackupSnapshotError extends Schema.TaggedError<BackupSnapshotError>()("BackupSnapshotError", {
  table: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Backup snapshot failed at ${this.table}.`;
  }
}

export class BackupSnapshot extends Context.Service<
  BackupSnapshot,
  {
    readonly write: Effect.Effect<void>;
    readonly run: Effect.Effect<void>;
  }
>()("t3/ardud/persistence/BackupSnapshot") {}

interface Options {
  readonly outputPath: string;
  readonly serverVersion: string;
  readonly buildCommit: string;
  readonly maxTableBytes?: number;
  readonly startupDelay?: Duration.Input;
  readonly interval?: Duration.Input;
  /** Allows filesystem failure tests without changing the publication logic. */
  readonly beforePublish?: Effect.Effect<void>;
}

export const layerWithOptions = (options: Options) =>
  Layer.effect(
    BackupSnapshot,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const boards = yield* BoardsDatabase.BoardsDatabase;
      const lock = yield* Semaphore.make(1);
      const crypto = yield* Crypto.Crypto;
      const analytics = yield* Effect.serviceOption(Analytics.Analytics);
      const write = Effect.fn("BackupSnapshot.write")(function* () {
        const attempted = yield* lock.withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            const start = yield* Clock.currentTimeMillis;
            let table = "boards.sqlite";
            const dir = NodePath.dirname(options.outputPath);
            const nonce = yield* crypto
              .randomUUIDv4()
              .pipe(
                Effect.catch((cause) =>
                  Effect.logError("Backup snapshot error", { table: "tempfile", cause }).pipe(
                    Effect.as(undefined),
                  ),
                ),
              );
            if (nonce === undefined) return;
            const tempPath = NodePath.join(dir, `.backup-${nonce}.sqlite`);
            const io = Effect.fn("BackupSnapshot.io")(function* <A>(operation: () => Promise<A>) {
              return yield* Effect.tryPromise({
                try: operation,
                catch: (cause) => new BackupSnapshotError({ table, cause }),
              });
            });
            yield* Effect.logInfo("Backup snapshot start", { path: options.outputPath });
            const snapshot = Effect.scoped(
              Effect.gen(function* () {
                yield* boards.ready;
                yield* io(() => NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 }));
                // Reserve a private file before SQLite opens it, including during backup.
                yield* Effect.acquireUseRelease(
                  io(() => NodeFSP.open(tempPath, "wx", 0o600)),
                  () => Effect.void,
                  (handle) => io(() => handle.close()).pipe(Effect.orDie),
                );
                const worker = yield* Effect.acquireRelease(
                  Effect.try({
                    try: () =>
                      new NodeWorkerThreads.Worker(
                        `(${backupSnapshotWorker.toString()})(require('node:sqlite'),require('node:fs'),require('node:worker_threads').parentPort)`,
                        { eval: true, execArgv: [] },
                      ),
                    catch: (cause) => new BackupSnapshotError({ table, cause }),
                  }),
                  (worker) => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid),
                );
                const request = Effect.fn("BackupSnapshot.workerRequest")(
                  (command: BackupCommand) =>
                    Effect.callback<
                      { readonly names?: string[]; readonly tables?: Record<string, number> },
                      BackupSnapshotError
                    >((resume) => {
                      const failed = (cause: unknown) => {
                        cleanup();
                        resume(Effect.fail(new BackupSnapshotError({ table, cause })));
                      };
                      const message = (reply: {
                        ok: boolean;
                        error?: string;
                        names?: string[];
                        tables?: Record<string, number>;
                      }) => {
                        cleanup();
                        if (reply.ok) resume(Effect.succeed(reply));
                        else failed(new Error(reply.error));
                      };
                      const exit = (code: number) =>
                        failed(new Error(`Backup worker exited (${code})`));
                      const cleanup = () => {
                        worker.off("message", message);
                        worker.off("error", failed);
                        worker.off("exit", exit);
                      };
                      worker.once("message", message);
                      worker.once("error", failed);
                      worker.once("exit", exit);
                      // Node Worker messaging has no browser target origin.
                      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- node:worker_threads protocol
                      worker.postMessage(command);
                      return Effect.sync(() => {
                        worker.off("message", message);
                        worker.off("error", failed);
                        worker.off("exit", exit);
                      });
                    }),
                );
                const opened = yield* request({ op: "open", boardsPath: boards.path, tempPath });
                const names = new Set(opened.names);
                const copyState = sql
                  .withTransaction(
                    Effect.gen(function* () {
                      for (const name of stateTables) {
                        table = name;
                        const schema = yield* sql<{
                          sql: string;
                        }>`SELECT sql FROM sqlite_schema WHERE type='table' AND name=${name}`;
                        if (!schema[0]) {
                          yield* Effect.logWarning("Backup snapshot missing source table", {
                            table: name,
                          });
                          continue;
                        }
                        // dbstat constrains traversal to this btree; LIMIT bounds even an unexpectedly large table.
                        const pageSize = yield* sql<{ page_size: number }>`PRAGMA page_size`;
                        const maxBytes = options.maxTableBytes ?? MAX_TABLE_BYTES;
                        const maxPages = Math.floor(maxBytes / pageSize[0]!.page_size) + 1;
                        const size = yield* sql<{
                          bytes: number;
                        }>`SELECT coalesce(sum(pgsize),0) AS bytes FROM (SELECT pgsize FROM dbstat WHERE name=${name} LIMIT ${maxPages})`;
                        if (size[0]!.bytes > maxBytes)
                          return yield* new BackupSnapshotError({
                            table,
                            cause: new Error("Source table exceeds backup size limit"),
                          });
                        const info = yield* sql.unsafe<{ name: string; hidden: number }>(
                          `PRAGMA table_xinfo(${q(name)})`,
                        );
                        const columns = info
                          .filter((row) => row.hidden === 0)
                          .map((row) => row.name);
                        // Control tables moved to boards; preserve their current names and both data sets.
                        const target = names.has(name) ? `statev2_${name}` : name;
                        const original = schema[0].sql;
                        const create =
                          target === name
                            ? original
                            : `CREATE TABLE ${q(target)} ${original.slice(original.indexOf("("))}`;
                        yield* request({
                          op: "schema",
                          name: target,
                          sql: create,
                          columns,
                          source: original,
                        });
                        let offset = 0;
                        let cursor: NodeSqlite.SQLInputValue | undefined;
                        const hasRowid = !/WITHOUT\s+ROWID/i.test(original);
                        while (true) {
                          const select = columns.map(q).join(",");
                          const rows = yield* sql.unsafe<Record<string, NodeSqlite.SQLInputValue>>(
                            hasRowid
                              ? `SELECT _rowid_ AS __backup_cursor,${select} FROM ${q(name)} ${cursor === undefined ? "" : "WHERE _rowid_ > ?"} ORDER BY _rowid_ LIMIT ?`
                              : `SELECT ${select} FROM ${q(name)} LIMIT ? OFFSET ?`,
                            hasRowid
                              ? cursor === undefined
                                ? [PAGE_ROWS]
                                : [cursor, PAGE_ROWS]
                              : [PAGE_ROWS, offset],
                          );
                          if (rows.length === 0) break;
                          yield* request({ op: "rows", rows });
                          offset += rows.length;
                          cursor = rows.at(-1)!.__backup_cursor;
                          yield* Effect.sleep("5 millis");
                        }
                      }
                    }),
                  )
                  .pipe(
                    NodeSqliteClient.readOnly,
                    NodeSqliteClient.backgroundReads,
                    Effect.timeout("2 minutes"),
                  );
                yield* copyState;
                table = "backup_meta";
                const result = yield* request({
                  op: "finish",
                  writtenAt: DateTime.formatIso(yield* DateTime.now),
                  serverVersion: options.serverVersion,
                  buildCommit: options.buildCommit,
                });
                yield* options.beforePublish ?? Effect.void;
                table = "publish";
                // Once rename starts, finish directory durability and close every handle before cancellation.
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* io(() => NodeFSP.rename(tempPath, options.outputPath));
                    yield* Effect.acquireUseRelease(
                      io(() => NodeFSP.open(dir, "r")),
                      (directory) => io(() => directory.sync()),
                      (directory) => io(() => directory.close()).pipe(Effect.orDie),
                    );
                  }),
                );
                const stat = yield* io(() => NodeFSP.stat(options.outputPath));
                yield* Effect.logInfo("Backup snapshot done", {
                  path: options.outputPath,
                  bytes: stat.size,
                  tables: result.tables,
                  elapsedMs: (yield* Clock.currentTimeMillis) - start,
                });
                if (Option.isSome(analytics))
                  yield* analytics.value.record({
                    ts: DateTime.formatIso(yield* DateTime.now),
                    kind: "backup.snapshot",
                    surface: "server",
                    route: "persistence/backup",
                    outcome: "ok",
                    durationMs: (yield* Clock.currentTimeMillis) - start,
                    props: { bytes: stat.size, count: Object.keys(result.tables ?? {}).length },
                  });
              }),
            ).pipe(Effect.timeout("10 minutes"));
            yield* snapshot.pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.flatMap(Clock.currentTimeMillis, (now) =>
                      Effect.logError("Backup snapshot error", {
                        table,
                        cause,
                        elapsedMs: now - start,
                      }),
                    ),
              ),
              Effect.ensuring(
                Effect.promise(() =>
                  Promise.all(
                    ["", "-journal", "-wal", "-shm"].map((suffix) =>
                      NodeFSP.rm(tempPath + suffix, { force: true }),
                    ),
                  ),
                ).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Backup snapshot cleanup failed", { table, cause }),
                  ),
                ),
              ),
            );
          }),
        );
        if (Option.isNone(attempted))
          yield* Effect.logWarning("Backup snapshot skipped", { reason: "already_running" });
      });
      const run = Effect.sleep(options.startupDelay ?? "3 minutes").pipe(
        Effect.andThen(write()),
        Effect.andThen(
          Effect.forever(Effect.sleep(options.interval ?? "6 hours").pipe(Effect.andThen(write()))),
        ),
      );
      return BackupSnapshot.of({ write: write(), run });
    }),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // Backup consumers only. Recall sync must continue to use readonly/state.sqlite.
    const replicaPath =
      process.env.ROBOB_READONLY_DB ??
      NodePath.join(NodePath.dirname(config.dbPath), "readonly", "state.sqlite");
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const backup = yield* BackupSnapshot;
        yield* forkParked(backup.run);
      }),
    ).pipe(
      Layer.provideMerge(
        layerWithOptions({
          outputPath: NodePath.join(NodePath.dirname(replicaPath), "backup.sqlite"),
          serverVersion: packageJson.version,
          buildCommit: config.robobBuildCommit ?? "unknown",
        }),
      ),
    );
  }),
);
