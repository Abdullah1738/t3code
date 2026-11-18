// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { HISTORY_TABLES, historyViewSql, liveColumns } from "./historyArchiveSql.ts";
import { threadReadIndexes } from "./threadReadIndexes.ts";
import { threadReadCount } from "./threadReadCount.ts";

const tiers = [
  ["main", "orchestration_v2_projection_turn_items"],
  ["ardud_archive", "ardud_turn_items"],
  ["ardud_base", "orchestration_v2_projection_turn_items"],
] as const;

it.live.each([false, true])("bounds visibility corrections with sparse indexes=%s", (indexed) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [query, parameters] =
      sql`SELECT ${threadReadCount(sql, ThreadId.make("t"), { main: indexed, ardud_archive: indexed })} AS count`.compile();
    if (indexed) {
      for (const statement of [
        ...threadReadIndexes("main", "orchestration_v2_projection_turn_items"),
        ...threadReadIndexes("ardud_archive", "ardud_turn_items"),
      ])
        yield* sql.unsafe(statement);
    }
    const indexes = yield* Effect.forEach(tiers, ([schema, table]) =>
      sql.unsafe<{ sql: string }>(
        `SELECT sql FROM ${schema}.sqlite_schema WHERE type = 'index'
          AND tbl_name = '${table}' AND sql IS NOT NULL`,
      ),
    );
    for (const [schema, table] of tiers) {
      for (const state of [
        "completed",
        "cancelled",
        "superseded",
        "paired",
        "rolled_back",
      ] as const) {
        for (const layout of ["whole run", "small run"] as const) {
          const visits: number[] = [];
          for (const size of [50, 6200]) {
            const affected = layout === "small run" ? 25 : size;
            const result = yield* Effect.sync(() => {
              const db = new NodeSqlite.DatabaseSync(":memory:");
              let visited = 0;
              db.function("read_probe", { deterministic: true }, (value) => {
                visited++;
                return value;
              });
              try {
                db.exec(`ATTACH DATABASE ':memory:' AS ardud_archive;
                ATTACH DATABASE ':memory:' AS ardud_base;
                CREATE TABLE orchestration_v2_projection_runs
                  (run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, status TEXT);
                CREATE INDEX runs_thread ON orchestration_v2_projection_runs(thread_id, status);
                CREATE TABLE orchestration_v2_projection_run_attempts
                  (attempt_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, root_node_id TEXT, status TEXT);
                CREATE INDEX attempts_thread ON orchestration_v2_projection_run_attempts(thread_id, run_id);
                CREATE TABLE ardud_shell_item_counts
                  (thread_id TEXT, run_key TEXT, item_count INTEGER, PRIMARY KEY(thread_id, run_key)) WITHOUT ROWID;`);
                for (const [index, [source, name]] of tiers.entries()) {
                  // VIRTUAL type counts row evaluations even when no rows cross SQL.
                  // Production indexes are copied unchanged onto this instrumented table.
                  db.exec(`CREATE TABLE ${source}.${name}(
                  ardud_locator INTEGER, turn_item_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT,
                  node_id TEXT, provider_thread_id TEXT, provider_turn_id TEXT, parent_item_id TEXT,
                  ordinal INTEGER, original_type TEXT, type TEXT GENERATED ALWAYS AS (read_probe(original_type)) VIRTUAL,
                  status TEXT, updated_at TEXT, payload_json TEXT);`);
                  for (const { sql: definition } of indexes[index]!) {
                    db.exec(
                      definition.replace(
                        /^(CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?)(\S+)/i,
                        `$1${source}.$2`,
                      ),
                    );
                  }
                }
                db.exec(
                  historyViewSql(HISTORY_TABLES[1]).replace(
                    "rowid AS rowid, * FROM main.",
                    `rowid AS rowid, ${liveColumns("orchestration_v2_projection_turn_items")} FROM main.`,
                  ),
                );
                db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('r','t',1,?)").run(
                  state === "cancelled" || state === "rolled_back" ? state : "completed",
                );
                if (state === "superseded" || state === "paired" || state === "rolled_back") {
                  db.exec(
                    "INSERT INTO orchestration_v2_projection_run_attempts VALUES ('a','t','r','n','superseded')",
                  );
                }
                if (layout === "small run") {
                  db.exec(
                    "INSERT INTO orchestration_v2_projection_runs VALUES ('other','t',2,'completed')",
                  );
                }
                const insert = db.prepare(`INSERT INTO ${schema}.${table}
                (turn_item_id, thread_id, run_id, node_id, ordinal, original_type, payload_json)
                VALUES (?, 't', ?, 'n', ?, ?, ?)`);
                db.exec("BEGIN");
                for (let ordinal = 0; ordinal < size; ordinal++) {
                  const type =
                    ordinal === 10
                      ? "user_message"
                      : ordinal === 11
                        ? "run_interrupt_result"
                        : ordinal === 12 && state === "paired"
                          ? "run_interrupt_request"
                          : ordinal % 20 === 0
                            ? "user_message"
                            : "command_execution";
                  insert.run(
                    String(ordinal),
                    ordinal < affected ? "r" : "other",
                    ordinal,
                    type,
                    JSON.stringify({
                      inputIntent: ordinal === 10 ? "queued_turn" : "turn_start",
                      output: "command output\n".repeat(300),
                    }),
                  );
                }
                db.exec(`INSERT INTO ardud_shell_item_counts VALUES ('t','r',${affected});`);
                if (layout === "small run") {
                  db.prepare("INSERT INTO ardud_shell_item_counts VALUES ('t','other',?)").run(
                    size - affected,
                  );
                }
                db.exec("COMMIT");
                const plan = db
                  .prepare(`EXPLAIN QUERY PLAN ${query}`)
                  .all(...(parameters as NodeSqlite.SQLInputValue[]));
                visited = 0;
                const row = db.prepare(query).get(...(parameters as NodeSqlite.SQLInputValue[]));
                return { count: row?.count, visited, plan };
              } finally {
                db.close();
              }
            });
            assert.equal(
              result.count,
              state === "rolled_back"
                ? size - affected
                : size - (state === "cancelled" || state === "superseded" ? 1 : 0),
            );
            assert.isEmpty(
              result.plan.filter((row) =>
                /^SCAN (?:i|base|cold|request|(?:main\.|ardud_base\.|ardud_archive\.)?(?:orchestration_v2_projection_turn_items|ardud_turn_items))(?:\s|$)/.test(
                  String(row.detail),
                ),
              ),
              `${schema} ${state}: item tables must use index SEARCH`,
            );
            assert.isTrue(
              result.plan.some((row) => String(row.detail).startsWith("SEARCH base USING INDEX")),
            );
            assert.isAtMost(
              result.visited,
              schema === "ardud_base" || !indexed ? affected * 4 + 32 : 32,
              `${schema} ${state} ${size}: unrelated tool rows evaluated`,
            );
            visits.push(result.visited);
            yield* Effect.log(
              JSON.stringify({
                schema,
                state,
                layout,
                size,
                count: result.count,
                visited: result.visited,
              }),
            );
          }
          if (
            layout === "small run" ||
            (indexed && schema !== "ardud_base") ||
            state === "completed"
          ) {
            assert.equal(
              visits[0],
              visits[1],
              `${schema} ${state} ${layout}: fixed affected-run work`,
            );
          }
        }
      }
    }
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
