import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Statement from "effect/sql/Statement";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as BoardsDatabase from "./BoardsDatabase.ts";
import { listDueTasks } from "../../scheduledTasks/ScheduledTaskService.ts";
import { controlDDL } from "./boardsSchema.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boards-split-" });
  const legacy = path.join(dir, "statev2.sqlite");
  const boards = path.join(dir, "boards.sqlite");
  yield* Effect.sync(() => {
    const db = new NodeSqlite.DatabaseSync(legacy);
    try {
      db.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE ardud_kanban_custom (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE INDEX custom_json ON ardud_kanban_custom(id, json);
        CREATE TABLE ardud_opencode_import (
          native_session_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, imported_at TEXT NOT NULL
        );
        INSERT INTO ardud_opencode_import VALUES ('ses_1', 'thread-1', '2026-11-05');
        CREATE TABLE unrelated_history (id INTEGER PRIMARY KEY, payload TEXT);
        CREATE TABLE ardud_kanban_card_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, json TEXT NOT NULL
        );
        INSERT INTO ardud_kanban_card_events VALUES (100, 'card-1', '{}');
        DELETE FROM ardud_kanban_card_events;
      `);
      for (const ddl of controlDDL) db.exec(ddl);
      db.exec(`INSERT INTO ardud_harness_selection_migration
        (id, version, scope, ref, before_json, after_json, applied_at)
        VALUES (7, 1, 'board', 'board:legacy', '{}', '{}', '2026-11-05');`);
      db.prepare(`INSERT INTO scheduled_tasks VALUES (
        'task-1', 'Scheduled test', 'Run', 1, ?, 'project-1', NULL, ?, ?,
        'full-access', 'default', 'user', 'server', '2026-11-05T00:00:00.000Z',
        '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z', NULL, 'never', NULL, 0, NULL, NULL
      )`).run(
        JSON.stringify({ type: "interval", everyMs: 60000 }),
        JSON.stringify({ type: "root" }),
        JSON.stringify({ instanceId: "opencode", model: "test" }),
      );
      const insert = db.prepare(
        "INSERT INTO ardud_kanban_custom (rowid, id, json) VALUES (?, ?, ?)",
      );
      for (let index = 0; index < 40; index++)
        insert.run(index - 2, `row-${index}`, `json-${index}`);
    } finally {
      db.close();
    }
  });
  return { legacy, boards };
});

it.live(
  "copies all kanban tables with rowids/indexes, leaves legacy untouched and never recopy on reopen",
  () =>
    Effect.gen(function* () {
      const { legacy, boards } = yield* fixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(BoardsDatabase.layerFromPaths(boards, legacy));
          const db = Context.get(context, BoardsDatabase.BoardsDatabase);
          yield* db.ready;
          const rows = yield* db.sql<{
            rowid: number;
            id: string;
          }>`SELECT rowid, id FROM ardud_kanban_custom ORDER BY rowid`;
          assert.strictEqual(rows.length, 40);
          assert.strictEqual(rows[0]?.rowid, -2);
          assert.strictEqual((yield* db.sql`SELECT * FROM ardud_opencode_import`).length, 1);
          assert.strictEqual(
            (yield* db.sql<{ id: number }>`SELECT id FROM ardud_harness_selection_migration`)[0]
              ?.id,
            7,
          );
          const due = yield* listDueTasks(DateTime.makeUnsafe("2026-11-05T01:00:00.000Z")).pipe(
            Effect.provideService(BoardsDatabase.BoardsDatabase, db),
            Effect.provideService(SqlClient.SqlClient, db.sql),
          );
          assert.strictEqual(due[0]?.id, "task-1");
          assert.strictEqual(
            (yield* db.sql`SELECT 1 FROM sqlite_schema WHERE name = 'unrelated_history'`).length,
            0,
          );
          assert.strictEqual(
            (yield* db.sql`SELECT 1 FROM sqlite_schema WHERE name = 'custom_json'`).length,
            1,
          );
          assert.strictEqual(
            (yield* db.sql<{
              id: number;
            }>`INSERT INTO ardud_kanban_card_events (card_id, json) VALUES ('card-2', '{}') RETURNING id`)[0]
              ?.id,
            101,
          );
          assert.strictEqual(
            (yield* db.sql<{
              completed: number;
            }>`SELECT completed FROM ardud_boards_migration WHERE table_name = '*'`)[0]?.completed,
            1,
          );
          yield* db.sql`DELETE FROM ardud_kanban_custom WHERE id = 'row-0'`;
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(BoardsDatabase.layerFromPaths(boards, legacy));
          const db = Context.get(context, BoardsDatabase.BoardsDatabase);
          yield* db.ready;
          assert.strictEqual((yield* db.sql`SELECT * FROM ardud_kanban_custom`).length, 39);
        }),
      );
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(legacy, { readOnly: true });
        try {
          assert.strictEqual(
            db.prepare("SELECT COUNT(*) AS n FROM ardud_kanban_custom").get()?.n,
            40,
          );
        } finally {
          db.close();
        }
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "returns its layer before copying, gates consumers and resumes an interrupted row cursor",
  () =>
    Effect.gen(function* () {
      const { legacy, boards } = yield* fixture;
      const paused = yield* Deferred.make<void>();
      let inserts = 0;
      const pause: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        if (query.startsWith('INSERT INTO "ardud_kanban_custom"') && ++inserts === 5) {
          return Deferred.succeed(paused, undefined).pipe(Effect.andThen(Effect.never));
        }
        return Effect.succeed(statement);
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(BoardsDatabase.layerFromPaths(boards, legacy));
          const db = Context.get(context, BoardsDatabase.BoardsDatabase);
          yield* Deferred.await(paused);
          const called = yield* Deferred.make<void>();
          const transactionCalled = yield* Deferred.make<void>();
          const consumer = yield* db.sql`SELECT 1 FROM ardud_kanban_custom`.pipe(
            Effect.andThen(Deferred.succeed(called, undefined)),
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          assert.isFalse(yield* Deferred.isDone(called));
          const transaction = yield* db.sql
            .withTransaction(db.sql`SELECT 1`)
            .pipe(
              Effect.andThen(Deferred.succeed(transactionCalled, undefined)),
              Effect.forkScoped,
            );
          yield* Effect.yieldNow;
          assert.isFalse(yield* Deferred.isDone(transactionCalled));
          yield* Fiber.interrupt(transaction);
          yield* Fiber.interrupt(consumer);
        }).pipe(Effect.provideService(Statement.CurrentTransformer, pause)),
      );

      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(boards, { readOnly: true });
        try {
          assert.strictEqual(
            db.prepare("SELECT COUNT(*) AS n FROM ardud_kanban_custom").get()?.n,
            4,
          );
          assert.strictEqual(
            db.prepare("SELECT completed FROM ardud_boards_migration WHERE table_name = '*'").get(),
            undefined,
          );
        } finally {
          db.close();
        }
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(BoardsDatabase.layerFromPaths(boards, legacy));
          const db = Context.get(context, BoardsDatabase.BoardsDatabase);
          yield* db.ready;
          assert.strictEqual((yield* db.sql`SELECT * FROM ardud_kanban_custom`).length, 40);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "board writes do not take the orchestration writer and reader routing survives the gate",
  () =>
    Effect.gen(function* () {
      const { legacy, boards } = yield* fixture;
      const stateContext = yield* Layer.build(NodeSqliteClient.layer({ filename: legacy }));
      const state = Context.get(stateContext, SqlClient.SqlClient);
      const context = yield* Layer.build(BoardsDatabase.layerFromPaths(boards, legacy));
      const db = Context.get(context, BoardsDatabase.BoardsDatabase);
      yield* db.ready;
      yield* state.withTransaction(
        Effect.gen(function* () {
          yield* state`INSERT INTO unrelated_history VALUES (1, 'orchestration write')`;
          yield* db.sql.withTransaction(
            db.sql`INSERT INTO ardud_kanban_custom VALUES ('independent', 'board write')`,
          );
          const rows =
            yield* db.sql`SELECT * FROM ardud_kanban_custom WHERE id = 'independent'`.pipe(
              NodeSqliteClient.readOnly,
            );
          assert.strictEqual(rows.length, 1);
        }),
      );
      assert.strictEqual(
        (yield* state`SELECT * FROM ardud_kanban_custom WHERE id = 'independent'`).length,
        0,
      );
      const readOnlyWrite = yield* db.sql`DELETE FROM ardud_kanban_custom`.pipe(
        NodeSqliteClient.readOnly,
        Effect.result,
      );
      assert.strictEqual(readOnlyWrite._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("two first-boot openers cannot replay stale rows after cutover", () =>
  Effect.gen(function* () {
    const { legacy, boards } = yield* fixture;
    const paused = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let blocked = false;
    const pause: Statement.Transformer = (statement) => {
      const [query] = statement.compile();
      if (
        !blocked &&
        query.includes('SELECT rowid AS __boards_rowid, * FROM "ardud_kanban_custom"')
      ) {
        blocked = true;
        return Deferred.succeed(paused, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(statement),
        );
      }
      return Effect.succeed(statement);
    };
    const first = yield* Layer.build(BoardsDatabase.layerFromPaths(boards, legacy)).pipe(
      Effect.provideService(Statement.CurrentTransformer, pause),
    );
    yield* Deferred.await(paused);
    const second = yield* Layer.build(BoardsDatabase.layerFromPaths(boards, legacy));
    const current = Context.get(second, BoardsDatabase.BoardsDatabase);
    yield* current.ready;
    yield* current.sql`DELETE FROM ardud_kanban_custom WHERE id = 'row-0'`;
    yield* Deferred.succeed(release, undefined);
    yield* Context.get(first, BoardsDatabase.BoardsDatabase).ready;
    assert.strictEqual((yield* current.sql`SELECT * FROM ardud_kanban_custom`).length, 39);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("identity import reads bypass a held boards reader", () =>
  Effect.gen(function* () {
    const { legacy, boards } = yield* fixture;
    const context = yield* Layer.build(BoardsDatabase.layerFromPaths(boards, legacy));
    const db = Context.get(context, BoardsDatabase.BoardsDatabase);
    yield* db.ready;
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const reader = yield* Effect.forkChild(
      db.sql
        .withTransaction(
          db.sql`SELECT 1`.pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(NodeSqliteClient.readOnly),
    );
    yield* Deferred.await(held);
    const rows = yield* db.sql<{
      thread_id: string;
    }>`SELECT thread_id FROM ardud_opencode_import WHERE native_session_id = 'ses_1'`.pipe(
      NodeSqliteClient.identityReadOnly,
      Effect.timeout("2 seconds"),
      Effect.ensuring(Deferred.succeed(release, undefined)),
    );
    yield* Fiber.join(reader);
    assert.strictEqual(rows[0]?.thread_id, "thread-1");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
