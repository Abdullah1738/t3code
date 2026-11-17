import type { ThreadId } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export const readThreadIndexAvailability = Effect.fn("readThreadIndexAvailability")(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql<{ schema_name: string; name: string }>`
    SELECT 'main' AS schema_name, name FROM main.sqlite_schema
      WHERE name IN ('ardud_thread_read_queued_idx', 'ardud_thread_read_interrupt_result_idx', 'ardud_thread_read_interrupt_request_idx')
    UNION ALL SELECT 'ardud_archive', name FROM ardud_archive.sqlite_schema
      WHERE name IN ('ardud_thread_read_queued_idx', 'ardud_thread_read_interrupt_result_idx', 'ardud_thread_read_interrupt_request_idx')`;
  return {
    main: rows.filter((row) => row.schema_name === "main").length === 3,
    ardud_archive: rows.filter((row) => row.schema_name === "ardud_archive").length === 3,
  };
});

// Counts already follow hot/delta/base shadowing transactionally. Only cancelled
// inputs and legacy superseded interrupts need item-level visibility corrections.
export const threadReadCount = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  indexes = { main: false, ardud_archive: false },
) => {
  const branches = [
    {
      table: sql`main.orchestration_v2_projection_turn_items`,
      winner: sql`1`,
      queued: indexes.main
        ? sql`INDEXED BY ardud_thread_read_queued_idx`
        : sql`INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx`,
      interrupted: indexes.main
        ? sql`INDEXED BY ardud_thread_read_interrupt_result_idx`
        : sql`INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx`,
    },
    {
      table: sql`ardud_archive.ardud_turn_items`,
      queued: indexes.ardud_archive
        ? sql`INDEXED BY ardud_thread_read_queued_idx`
        : sql`INDEXED BY ardud_turn_items_run_idx`,
      interrupted: indexes.ardud_archive
        ? sql`INDEXED BY ardud_thread_read_interrupt_result_idx`
        : sql`INDEXED BY ardud_turn_items_run_idx`,
      winner: sql`NOT EXISTS (SELECT 1 FROM main.orchestration_v2_projection_turn_items hot
        WHERE hot.turn_item_id = i.turn_item_id)`,
    },
    {
      table: sql`ardud_base.orchestration_v2_projection_turn_items`,
      queued: sql``,
      interrupted: sql``,
      winner: sql`NOT EXISTS (SELECT 1 FROM main.orchestration_v2_projection_turn_items hot
        WHERE hot.turn_item_id = i.turn_item_id)
        AND NOT EXISTS (SELECT 1 FROM ardud_archive.ardud_turn_items delta
          WHERE delta.turn_item_id = i.turn_item_id)`,
    },
  ];
  // The immutable base retains run-index range searches for exact totals. Only
  // writable stores have the sparse visibility indexes; never require them on base.
  const hidden = branches.flatMap(({ table, winner, queued, interrupted }) => [
    sql`SELECT i.turn_item_id
      FROM orchestration_v2_projection_runs r CROSS JOIN ${table} i ${queued}
      WHERE r.thread_id = ${threadId} AND r.status = 'cancelled'
        AND i.thread_id = ${threadId} AND i.run_id = r.run_id
        AND i.type = 'user_message' AND json_extract(i.payload_json, '$.inputIntent') = 'queued_turn'
        AND ${winner}`,
    sql`SELECT i.turn_item_id
      FROM orchestration_v2_projection_run_attempts a CROSS JOIN ${table} i ${interrupted}
      WHERE a.thread_id = ${threadId} AND a.status = 'superseded'
        AND i.thread_id = ${threadId} AND i.run_id = a.run_id AND i.node_id = a.root_node_id
        AND i.type = 'run_interrupt_result' AND ${winner}
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = ${threadId} AND r.run_id = i.run_id AND r.status = 'rolled_back')
        AND NOT EXISTS (SELECT 1 FROM ardud_history_turn_items request
          WHERE request.thread_id = ${threadId} AND request.run_id = i.run_id
            AND request.type = 'run_interrupt_request')`,
  ]);
  return sql`(
    SELECT COALESCE(SUM(c.item_count), 0)
    FROM ardud_shell_item_counts c LEFT JOIN orchestration_v2_projection_runs r
      ON r.thread_id = c.thread_id AND r.run_id = NULLIF(c.run_key, '')
    WHERE c.thread_id = ${threadId} AND COALESCE(r.status, '') <> 'rolled_back'
  ) - (SELECT COUNT(*) FROM (${sql.join(" UNION ", false)(hidden)}))`;
};
