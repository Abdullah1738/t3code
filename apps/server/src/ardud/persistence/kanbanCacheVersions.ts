import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

const tables = [
  "ardud_kanban_boards",
  "ardud_kanban_cards",
  "ardud_kanban_goals",
  "ardud_kanban_pools",
  "ardud_kanban_discussions",
  "ardud_kanban_threads",
];

// One clock across tables prevents delete/reinsert and primary-key changes from
// reusing an identity. Transaction-local decodes must never enter the shared cache.
export const ensureKanbanCacheVersions = Effect.fn("ensureKanbanCacheVersions")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS ardud_kanban_cache_clock (
        id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL
          CHECK (typeof(version) = 'integer' AND version BETWEEN 0 AND 9007199254740991)
      )`;
      yield* sql`INSERT OR IGNORE INTO ardud_kanban_cache_clock (id, version) VALUES (1, 0)`;
      for (const table of tables) {
        const columns = yield* sql<{ name: string }>`PRAGMA table_info(${sql(table)})`;
        if (!columns.some((column) => column.name === "cache_version")) {
          // A constant default adds no per-row backfill, including on large boards.
          yield* sql.unsafe(
            `ALTER TABLE ${table} ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 0`,
          );
        }
        const changedColumns = columns
          .filter((column) => column.name !== "cache_version")
          .map((column) => `"${column.name}"`)
          .join(", ");
        for (const [suffix, event] of [
          ["insert", "INSERT"],
          ["update", `UPDATE OF ${changedColumns}`],
        ]) {
          yield* sql.unsafe(`CREATE TRIGGER IF NOT EXISTS ${table}_cache_${suffix}
            AFTER ${event} ON ${table} BEGIN
              UPDATE ardud_kanban_cache_clock SET version = version + 1 WHERE id = 1;
              UPDATE ${table} SET cache_version = (SELECT version FROM ardud_kanban_cache_clock WHERE id = 1)
                WHERE rowid = NEW.rowid;
            END`);
        }
      }
    }),
  );
});
