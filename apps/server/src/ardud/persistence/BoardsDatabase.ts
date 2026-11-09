import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { ensureRunFollowTables } from "../schedules/runFollow.ts";
import { controlDDL, controlTables } from "./boardsSchema.ts";
import { kanbanDDL } from "./kanbanSchema.ts";
import { withStartupPhase } from "../observability/StartupPhaseLog.ts";

export class BoardsDatabase extends Context.Service<
  BoardsDatabase,
  {
    readonly sql: SqlClient.SqlClient;
    readonly ready: Effect.Effect<void>;
    readonly path: string;
  }
>()("t3/ardud/persistence/BoardsDatabase") {}

// Tests and standalone legacy tools may still supply a single in-memory client.
// The production persistence layer always supplies BoardsDatabase.
export const client = Effect.gen(function* () {
  const boards = yield* Effect.serviceOption(BoardsDatabase);
  return Option.isSome(boards) ? boards.value.sql : yield* SqlClient.SqlClient;
});

export const initialize = Effect.fn("BoardsDatabase.initialize")(function* <A, E, R>(
  legacyDDL: Effect.Effect<A, E, R>,
) {
  const boards = yield* Effect.serviceOption(BoardsDatabase);
  if (Option.isNone(boards)) yield* legacyDDL;
});

// Startup must not wait for a first-boot copy. Consumers' actual SQL waits for
// ready, while their boot-only recovery can run in a scoped background fiber.
export const onReady = Effect.fn("BoardsDatabase.onReady")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const boards = yield* Effect.serviceOption(BoardsDatabase);
  if (Option.isNone(boards)) {
    yield* effect;
  } else {
    yield* boards.value.ready.pipe(
      Effect.andThen(effect),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("Boards database recovery failed", { cause }),
      ),
      Effect.forkScoped,
    );
  }
});

const markerDDL = `CREATE TABLE IF NOT EXISTS ardud_boards_migration (
  table_name TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0
)`;

interface LegacyTable {
  readonly name: string;
  readonly sql: string;
}

const copyTables = Effect.fn("BoardsDatabase.copyTables")(function* (
  source: SqlClient.SqlClient,
  target: SqlClient.SqlClient,
) {
  const tables = yield* source<LegacyTable>`
    SELECT name, sql FROM sqlite_schema
    WHERE type = 'table' AND (name GLOB 'ardud_kanban_*' OR name IN ${source.in(controlTables)})
    ORDER BY name
  `.pipe(NodeSqliteClient.readOnly);
  const hasSequence =
    (yield* source`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'`.pipe(
      NodeSqliteClient.readOnly,
    )).length > 0;

  for (const table of tables) {
    const marker = yield* target<{ last_rowid: number; completed: number }>`
      SELECT last_rowid, completed FROM ardud_boards_migration WHERE table_name = ${table.name}
    `;
    if (marker[0]?.completed === 1) continue;
    // Also carry unknown/newer kanban tables, without scanning unrelated history.
    yield* target.unsafe(
      table.sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?/i, "CREATE TABLE IF NOT EXISTS "),
    );
    const indexes = yield* source<{ sql: string }>`
      SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ${table.name} AND sql IS NOT NULL
    `.pipe(NodeSqliteClient.readOnly);
    for (const index of indexes) {
      yield* target.unsafe(
        index.sql.replace(
          /^CREATE (UNIQUE )?INDEX\s+(?:IF NOT EXISTS\s+)?/i,
          "CREATE $1INDEX IF NOT EXISTS ",
        ),
      );
      yield* Effect.sleep("1 millis");
    }
    let cursor = marker[0]?.last_rowid;
    while (true) {
      const rows = yield* source<Record<string, unknown> & { __boards_rowid: number }>`
        SELECT rowid AS __boards_rowid, * FROM ${source(table.name)}
        ${cursor === undefined ? source.literal("") : source`WHERE rowid > ${cursor}`} ORDER BY rowid LIMIT 16
      `.pipe(NodeSqliteClient.readOnly);
      if (rows.length === 0) {
        const sequence = hasSequence
          ? yield* source<{
              seq: number;
            }>`SELECT seq FROM sqlite_sequence WHERE name = ${table.name}`.pipe(
              NodeSqliteClient.readOnly,
            )
          : [];
        yield* target.withTransaction(
          Effect.gen(function* () {
            const current = yield* target<{ completed: number }>`
            SELECT completed FROM ardud_boards_migration WHERE table_name = ${table.name}
          `;
            if (current[0]?.completed === 1) return;
            if (sequence[0] !== undefined) {
              yield* target`DELETE FROM sqlite_sequence WHERE name = ${table.name}`;
              yield* target`INSERT INTO sqlite_sequence (name, seq) VALUES (${table.name}, ${sequence[0]!.seq})`;
            }
            yield* target`
          INSERT INTO ardud_boards_migration (table_name, last_rowid, completed)
          VALUES (${table.name}, ${cursor ?? 0}, 1)
          ON CONFLICT(table_name) DO UPDATE SET completed = 1
        `;
          }),
        );
        break;
      }
      // One row + its cursor per transaction. Large JSON records cannot turn
      // a batch into a long-held writer; interruptions replay at most one row.
      for (const { __boards_rowid: rowid, ...row } of rows) {
        yield* target.withTransaction(
          Effect.gen(function* () {
            // A CLI may open the same store during first boot. Its stale copy
            // must not restore rows deleted after the server completed cutover.
            const current = yield* target<{ completed: number; last_rowid: number }>`
              SELECT completed, last_rowid FROM ardud_boards_migration WHERE table_name = ${table.name}
            `;
            if (
              current[0]?.completed === 1 ||
              (current[0] !== undefined && current[0].last_rowid >= rowid)
            )
              return;
            yield* target`INSERT INTO ${target(table.name)} ${target.insert({ rowid, ...row })}`;
            yield* target`
              INSERT INTO ardud_boards_migration (table_name, last_rowid, completed)
              VALUES (${table.name}, ${rowid}, 0)
              ON CONFLICT(table_name) DO UPDATE SET last_rowid = excluded.last_rowid
            `;
          }),
        );
        cursor = rowid;
        yield* Effect.sleep("1 millis");
      }
    }
  }
  yield* target`
    INSERT INTO ardud_boards_migration (table_name, completed) VALUES ('*', 1)
    ON CONFLICT(table_name) DO UPDATE SET completed = 1
  `;
});

export const layerFromPaths = (dbPath: string, legacyPath: string) =>
  Layer.effect(
    BoardsDatabase,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
      const ready = yield* Deferred.make<void>();
      // The raw client is private to the copier; public operations are gated at
      // acquisition, retaining the driver's reader routing and transaction spans.
      const bypassReady = Context.Reference<boolean>("t3/boards/bypassReady", {
        defaultValue: () => false,
      });
      const context = yield* withStartupPhase(
        "boards.open",
        Layer.build(
          NodeSqliteClient.layer({
            filename: dbPath,
            readerWorker: true,
            identityReaderProcess: true,
            checkpointWorker: true,
            beforeAcquire: Effect.flatMap(bypassReady, (bypass) =>
              bypass ? Effect.void : Deferred.await(ready),
            ),
            spanAttributes: { "db.name": path.basename(dbPath) },
          }),
        ),
      );
      const sql = Context.get(context, SqlClient.SqlClient);
      const raw = sql;
      const setup = Effect.gen(function* () {
        yield* raw`PRAGMA busy_timeout = 100`;
        yield* raw`PRAGMA journal_mode = WAL`;
        yield* raw`PRAGMA synchronous = NORMAL`;
        yield* raw`PRAGMA checkpoint_fullfsync = ON`;
        yield* raw`PRAGMA journal_size_limit = 33554432`;
        yield* Effect.forEach([markerDDL, ...kanbanDDL, ...controlDDL], (ddl) => raw.unsafe(ddl), {
          discard: true,
        });
        yield* ensureRunFollowTables(raw);

        const complete = yield* raw<{ completed: number }>`
      SELECT completed FROM ardud_boards_migration WHERE table_name = '*'
    `;
        if (complete[0]?.completed === 1) {
          yield* Deferred.succeed(ready, undefined);
        } else {
          const migrate = Effect.scoped(
            Effect.gen(function* () {
              if (yield* fs.exists(legacyPath)) {
                const sourceContext = yield* Layer.build(
                  NodeSqliteClient.layer({
                    filename: legacyPath,
                    readonly: true,
                    readerWorker: true,
                    spanAttributes: { "db.name": "boards-legacy-source" },
                  }),
                );
                yield* copyTables(Context.get(sourceContext, SqlClient.SqlClient), raw);
              } else {
                yield* raw`INSERT INTO ardud_boards_migration (table_name, completed) VALUES ('*', 1)`;
              }
              yield* Deferred.succeed(ready, undefined);
              yield* Effect.logInfo("Boards database migration complete");
            }),
          );
          yield* withStartupPhase("boards.migrate", migrate).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logError(
                    "Boards database migration paused; retrying from its last committed row",
                    { cause },
                  ).pipe(Effect.andThen(Effect.sleep("5 seconds"))),
            ),
            Effect.repeat({ while: () => !Deferred.isDoneUnsafe(ready) }),
            Effect.forkScoped,
          );
        }
      });
      yield* withStartupPhase("boards.setup", setup).pipe(Effect.provideService(bypassReady, true));
      return BoardsDatabase.of({ sql, ready: Deferred.await(ready), path: dbPath });
    }).pipe((effect) => withStartupPhase("boards.initialize", effect)),
  );

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerFromPaths(path.join(path.dirname(dbPath), "boards.sqlite"), dbPath);
  }),
);
