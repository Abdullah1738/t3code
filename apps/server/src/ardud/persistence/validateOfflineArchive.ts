// Offline verification uses the server's exact read-through SQL without starting
// recovery workers, acquiring server ownership, or writing either database.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  HISTORY_TABLES,
  historyViewSql,
  eventHistoryLookupViews,
  liveColumns,
} from "./historyArchiveSql.ts";

export function validateOfflineArchive(filename: string): void {
  const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    const pointer = db
      .prepare("SELECT filename FROM ardud_history_base_archive LIMIT 1")
      .get()?.filename;
    if (typeof pointer !== "string")
      throw new Error("Offline replacement has no base archive pointer.");
    const base = NodePath.resolve(NodePath.dirname(filename), pointer);
    db.prepare("ATTACH DATABASE ? AS ardud_base").run(
      `${NodeURL.pathToFileURL(base).href}?mode=ro`,
    );
    // Future writes go to a small delta; verification needs no on-disk delta.
    db.exec("ATTACH 'file::memory:?mode=memory' AS ardud_archive");
    for (const table of HISTORY_TABLES) {
      const columns = db.prepare(`PRAGMA main.table_info(${table.live})`).all();
      db.exec(`CREATE TABLE ardud_archive.${table.archive} (ardud_rowid INTEGER PRIMARY KEY,
        ardud_locator INTEGER GENERATED ALWAYS AS (-(1000000000000 + ardud_rowid)) STORED UNIQUE,
        ${columns.map((row) => `"${String(row.name).replaceAll('"', '""')}" ${row.type}`).join(", ")}, UNIQUE(${table.key}))`);
      db.exec(historyViewSql(table));
      // Preparing all columns detects schema drift without reading old payloads.
      db.prepare(`SELECT ${liveColumns(table.live)} FROM ${table.view} LIMIT 0`).all();
    }
    db.exec(
      "CREATE INDEX ardud_archive.ardud_events_command_idx ON ardud_events(command_id,sequence)",
    );
    db.exec("CREATE INDEX ardud_archive.ardud_events_sequence_idx ON ardud_events(sequence)");
    for (const view of eventHistoryLookupViews) db.exec(view);
    const thread = db
      .prepare(
        "SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id LIMIT 1",
      )
      .get()?.thread_id;
    if (typeof thread === "string") {
      db.prepare(
        "SELECT turn_item_id FROM ardud_history_turn_items WHERE thread_id=? ORDER BY ordinal LIMIT 1",
      ).get(thread);
      db.prepare(
        "SELECT sequence FROM ardud_history_events WHERE stream_id=? ORDER BY sequence DESC LIMIT 1",
      ).get(thread);
    }
    const liveMax = db
      .prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM main.orchestration_events")
      .get()?.n;
    const baseMax = db
      .prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM ardud_base.orchestration_events")
      .get()?.n;
    if (typeof liveMax !== "number" || typeof baseMax !== "number" || liveMax < baseMax)
      throw new Error("Replacement lost the application event high-water mark.");
  } finally {
    db.close();
  }
}
