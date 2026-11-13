import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";
import { it } from "vite-plus/test";
import {
  historyViewSql,
  HISTORY_TABLES,
  liveColumns,
  emptyBaseSchemaSql,
} from "./historyArchiveSql.ts";

it("history union locators are stable and archive predicates use indexes", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec("ATTACH ':memory:' AS ardud_archive");
    db.exec("ATTACH ':memory:' AS ardud_base");
    for (const sql of emptyBaseSchemaSql) db.exec(sql);
    const item = HISTORY_TABLES[1];
    const columns = liveColumns(item.live).split(", ");
    db.exec(
      `CREATE TABLE ${item.live} (${columns.map((name) => `${name} ${name === "ordinal" ? "INTEGER" : "TEXT"}${name === "turn_item_id" ? " PRIMARY KEY" : ""}`).join(", ")})`,
    );
    db.exec(`CREATE TABLE ardud_archive.ardud_turn_items (ardud_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      ardud_locator INTEGER GENERATED ALWAYS AS (-(1000000000000+ardud_rowid)) STORED UNIQUE,
      ${columns.map((name) => `${name} ${name === "ordinal" ? "INTEGER" : "TEXT"}`).join(", ")}, UNIQUE(turn_item_id))`);
    db.exec(
      "CREATE INDEX ardud_archive.ardud_turn_items_thread_idx ON ardud_turn_items(thread_id, ordinal, turn_item_id)",
    );
    db.exec(historyViewSql(item));
    db.exec(
      "INSERT INTO ardud_archive.ardud_turn_items (turn_item_id, thread_id, ordinal) VALUES ('cold','thread',1)",
    );
    db.exec(
      `INSERT INTO ${item.live} (turn_item_id, thread_id, ordinal) VALUES ('hot','thread',2)`,
    );
    const rows = db
      .prepare("SELECT rowid, turn_item_id FROM ardud_history_turn_items ORDER BY ordinal")
      .all();
    NodeAssert.deepEqual(
      rows.map((row) => [row.rowid, row.turn_item_id]),
      [
        [-1000000000001, "cold"],
        [1, "hot"],
      ],
    );
    db.exec(
      `INSERT INTO ${item.live} (turn_item_id, thread_id, ordinal) VALUES ('cold','thread',3)`,
    );
    NodeAssert.equal(db.prepare("SELECT COUNT(*) AS n FROM ardud_history_turn_items").get()?.n, 2);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT payload_json FROM ardud_history_turn_items WHERE rowid = -1000000000001",
      )
      .all();
    NodeAssert.ok(
      plan.some((row) => String(row.detail).includes("ardud_locator=?")),
      JSON.stringify(plan),
    );
    const threadPlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT payload_json FROM ardud_history_turn_items WHERE thread_id = 'thread' ORDER BY ordinal",
      )
      .all();
    NodeAssert.ok(
      threadPlan.some((row) =>
        String(row.detail).includes("ardud_turn_items_thread_idx (thread_id=?"),
      ),
      JSON.stringify(threadPlan),
    );
  } finally {
    db.close();
  }
});
