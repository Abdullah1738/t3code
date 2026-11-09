import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import { HISTORY_TABLES, historyViewSql, liveColumns } from "./historyArchiveSql.ts";
import { shellItemCountSchema, shellItemCountTriggers } from "./shellItemCounts.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { initializeShellItemCounts } from "./shellItemCounts.ts";

it.effect("loads a fenced base seed and corrects newer hot and delta identities exactly once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "shell-count-seed-" });
      yield* fs.writeFileString(
        path.join(directory, "shell-item-count-seed.json"),
        JSON.stringify({
          baseFilename: "base.sqlite",
          sequence: 1,
          identity: "test",
          counts: [{ thread_id: "thread", run_id: "old", item_count: 2 }],
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`ATTACH DATABASE ${path.join(directory, "base.sqlite")} AS ardud_base`;
          yield* sql`ATTACH ':memory:' AS ardud_archive`;
          yield* sql`CREATE TABLE ardud_history_archive_identity(identity TEXT)`;
          yield* sql`INSERT INTO ardud_history_archive_identity VALUES ('test')`;
          for (const table of [
            "main.orchestration_v2_projection_turn_items",
            "ardud_archive.ardud_turn_items",
            "ardud_base.orchestration_v2_projection_turn_items",
          ]) {
            yield* sql.unsafe(
              `CREATE TABLE ${table}(turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT)`,
            );
          }
          yield* sql`CREATE TABLE main.orchestration_events(sequence INTEGER PRIMARY KEY,event_type TEXT,payload_json TEXT)`;
          yield* sql`CREATE TABLE ardud_base.orchestration_events(sequence INTEGER PRIMARY KEY)`;
          yield* sql`CREATE TABLE ardud_archive.ardud_events(sequence INTEGER PRIMARY KEY,event_type TEXT,payload_json TEXT)`;
          yield* sql`CREATE INDEX ardud_archive.ardud_events_sequence_idx ON ardud_events(sequence)`;
          yield* sql`INSERT INTO ardud_base.orchestration_events VALUES (1)`;
          yield* sql`INSERT INTO main.orchestration_events VALUES (1,'thread.created','{}'),(2,'turn-item.updated','{"id":"a"}'),(3,'turn-item.updated','{"id":"c"}')`;
          yield* sql`INSERT INTO ardud_base.orchestration_v2_projection_turn_items VALUES ('a','thread','old'),('b','thread','old')`;
          yield* sql`INSERT INTO main.orchestration_v2_projection_turn_items VALUES ('a','thread','new'),('c','thread',NULL)`;
          yield* sql`INSERT INTO ardud_archive.ardud_turn_items VALUES ('a','thread','shadowed'),('b','thread','delta')`;
          yield* initializeShellItemCounts(path.join(directory, "base.sqlite"));
          yield* fs.remove(path.join(directory, "shell-item-count-seed.json"));
          yield* initializeShellItemCounts(path.join(directory, "base.sqlite"));
          expect(
            yield* sql`SELECT run_key,item_count FROM ardud_shell_item_counts WHERE item_count > 0 ORDER BY run_key`,
          ).toEqual([
            { run_key: "", item_count: 1 },
            { run_key: "delta", item_count: 1 },
            { run_key: "new", item_count: 1 },
          ]);
          yield* sql`UPDATE main.orchestration_v2_projection_turn_items SET run_id='newer' WHERE turn_item_id='a'`;
          expect(
            yield* sql`SELECT item_count FROM ardud_shell_item_counts WHERE run_key='newer'`,
          ).toEqual([{ item_count: 1 }]);
        }).pipe(
          Effect.provide(
            NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") }),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it("maintains exact counts across shadowing, archive moves, regrouping and rollback", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec("ATTACH ':memory:' AS ardud_archive; ATTACH ':memory:' AS ardud_base");
    const tables = [
      "main.orchestration_v2_projection_turn_items",
      "ardud_archive.ardud_turn_items",
      "ardud_base.orchestration_v2_projection_turn_items",
    ];
    const columns = liveColumns(HISTORY_TABLES[1].live).split(", ");
    for (const table of tables)
      db.exec(`CREATE TABLE ${table} (
      ${table.includes("ardud_turn_items") ? "ardud_locator INTEGER," : ""}
      ${columns.map((name) => `${name} ${name === "ordinal" ? "INTEGER" : "TEXT"}${name === "turn_item_id" ? " PRIMARY KEY" : ""}`).join(",")})`);
    for (const sql of shellItemCountSchema) db.exec(sql);
    db.exec(historyViewSql(HISTORY_TABLES[1]));
    for (const sql of shellItemCountTriggers(true)) db.exec(sql);
    const check = () => {
      const actual = db
        .prepare(
          "SELECT thread_id, run_key, item_count FROM ardud_shell_item_counts WHERE item_count <> 0 ORDER BY thread_id, run_key",
        )
        .all();
      const expected = db
        .prepare(
          "SELECT thread_id, COALESCE(run_id, '') AS run_key, COUNT(*) AS item_count FROM ardud_history_turn_items GROUP BY thread_id, COALESCE(run_id, '') ORDER BY thread_id, run_key",
        )
        .all();
      expect(actual).toEqual(expected);
    };
    const exec = (sql: string) => {
      db.exec(sql);
      check();
    };
    exec(
      `INSERT INTO ${tables[2]}(turn_item_id,thread_id,run_id) VALUES ('a','thread','base'),('b','thread',NULL)`,
    );
    exec(`INSERT INTO ${tables[1]}(turn_item_id,thread_id,run_id) VALUES ('a','thread','delta')`);
    exec(
      `INSERT INTO ${tables[0]}(turn_item_id,thread_id,run_id) VALUES ('a','thread','hot'),('c','thread',NULL)`,
    );
    exec(`UPDATE ${tables[2]} SET run_id='hidden' WHERE turn_item_id='a'`);
    exec(`UPDATE ${tables[1]} SET run_id='hidden-delta' WHERE turn_item_id='a'`);
    exec(`UPDATE ${tables[0]} SET thread_id='other',run_id='moved' WHERE turn_item_id='a'`);
    exec(`DELETE FROM ${tables[0]} WHERE turn_item_id='a'`);
    exec(`DELETE FROM ${tables[1]} WHERE turn_item_id='a'`);
    exec(
      `INSERT INTO ${tables[1]}(turn_item_id,thread_id,run_id) SELECT turn_item_id,thread_id,run_id FROM ${tables[0]} WHERE turn_item_id='c'`,
    );
    exec(`DELETE FROM ${tables[0]} WHERE turn_item_id='c'`);
    db.exec("BEGIN");
    exec(`INSERT INTO ${tables[0]}(turn_item_id,thread_id,run_id) VALUES ('new','thread','run')`);
    db.exec("ROLLBACK");
    check();
  } finally {
    db.close();
  }
});
