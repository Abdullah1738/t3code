import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { kanbanDDL } from "./kanbanSchema.ts";
import { ensureKanbanCacheVersions } from "./kanbanCacheVersions.ts";

const fixtures = [
  ["ardud_kanban_boards", { id: "board", slug: "board", json: "{}" }],
  ["ardud_kanban_cards", { id: "card", board_id: "board", number: 1, stage: "todo", json: "{}" }],
  ["ardud_kanban_goals", { id: "goal", board_id: "board", json: "{}" }],
  ["ardud_kanban_pools", { board_id: "board", key: "pool", json: "{}" }],
  ["ardud_kanban_discussions", { id: "discussion", board_id: "board", json: "{}" }],
  ["ardud_kanban_threads", { thread_id: "thread", board_id: "board", json: "{}" }],
] as const;

it.effect("versions every cached table's inserts, replacements and updates of every column", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.forEach(kanbanDDL, (ddl) => sql.unsafe(ddl), { discard: true });
    yield* ensureKanbanCacheVersions(sql);
    yield* sql`PRAGMA recursive_triggers = ON`;
    let last = 0;
    for (const [table, row] of fixtures) {
      const version = Effect.gen(function* () {
        const rows = yield* sql<{ cache_version: number }>`SELECT cache_version FROM ${sql(table)}`;
        assert.isAbove(rows[0]!.cache_version, last);
        last = rows[0]!.cache_version;
      });
      yield* sql`INSERT INTO ${sql(table)} ${sql.insert(row)}`;
      yield* version;
      yield* sql`UPDATE ${sql(table)} SET json = '{"new":true}', cache_version = 0`;
      yield* version;
      // Cover every original column, including SQL-only summary fields and composite keys.
      for (const column of Object.keys(row)) {
        yield* sql`UPDATE ${sql(table)} SET ${sql(column)} = ${sql(column)}`;
        yield* version;
      }
      yield* sql`INSERT OR REPLACE INTO ${sql(table)} ${sql.insert(row)}`;
      yield* version;
      yield* sql`DELETE FROM ${sql(table)}`;
      yield* sql`INSERT INTO ${sql(table)} ${sql.insert(row)}`;
      yield* version;
    }
    yield* ensureKanbanCacheVersions(sql);
    const clock = yield* sql<{ version: number }>`SELECT version FROM ardud_kanban_cache_clock`;
    assert.strictEqual(clock[0]!.version, last);
    // Refuse overflow rather than silently rounding two revisions to the same JS number.
    yield* sql`UPDATE ardud_kanban_cache_clock SET version = 9007199254740991`;
    const failed = yield* sql`UPDATE ardud_kanban_boards SET json = '{}'`.pipe(Effect.flip);
    assert.isDefined(failed);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.live(
  "logs first-start and repeated migration time on a synthetic live-size database",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "kanban-cache-migration-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* Effect.forEach(kanbanDDL, (ddl) => sql.unsafe(ddl), { discard: true });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (let i = 0; i < 5610; i++) {
              yield* sql`INSERT INTO ardud_kanban_cards (id, board_id, number, stage, json)
            VALUES (${`card-${i}`}, ${i < 4290 ? "big" : "small"}, ${i}, 'todo', ${JSON.stringify({ prompt: "a".repeat(8192) })})`;
            }
            for (let i = 0; i < 3224; i++) {
              yield* sql`INSERT INTO ardud_kanban_discussions (id, board_id, json)
            VALUES (${`discussion-${i}`}, 'big', ${JSON.stringify({ title: "a".repeat(8192) })})`;
            }
          }),
        );
        const start = performance.now();
        yield* ensureKanbanCacheVersions(sql);
        const firstMs = performance.now() - start;
        const again = performance.now();
        yield* ensureKanbanCacheVersions(sql);
        const repeatMs = performance.now() - again;
        const unchanged = yield* sql<{
          total: number;
        }>`SELECT count(*) AS total FROM ardud_kanban_cards WHERE cache_version = 0`;
        assert.strictEqual(unchanged[0]!.total, 5610);
        yield* sql`UPDATE ardud_kanban_cards SET json = '{"prompt":"changed"}' WHERE id = 'card-0'`;
        const changed = yield* sql<{
          cache_version: number;
        }>`SELECT cache_version FROM ardud_kanban_cards WHERE id = 'card-0'`;
        assert.isAbove(changed[0]!.cache_version, 0);
        yield* Effect.logInfo("KANBAN_CACHE_VERSION_MIGRATION", {
          cards: 5610,
          discussions: 3224,
          firstMs,
          repeatMs,
        });
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: path.join(dir, "boards.sqlite") })),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  60_000,
);
