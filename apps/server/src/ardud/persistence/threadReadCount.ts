import type { ThreadId } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

// Counts already follow hot/delta/base shadowing transactionally. Only cancelled
// inputs and legacy superseded interrupts need item-level visibility corrections.
export const threadReadCount = (sql: SqlClient.SqlClient, threadId: ThreadId) => {
  const branches = [
    { table: sql`main.orchestration_v2_projection_turn_items`, winner: sql`1` },
    {
      table: sql`ardud_archive.ardud_turn_items`,
      winner: sql`NOT EXISTS (SELECT 1 FROM main.orchestration_v2_projection_turn_items hot
        WHERE hot.turn_item_id = i.turn_item_id)`,
    },
    {
      table: sql`ardud_base.orchestration_v2_projection_turn_items`,
      winner: sql`NOT EXISTS (SELECT 1 FROM main.orchestration_v2_projection_turn_items hot
        WHERE hot.turn_item_id = i.turn_item_id)
        AND NOT EXISTS (SELECT 1 FROM ardud_archive.ardud_turn_items delta
          WHERE delta.turn_item_id = i.turn_item_id)`,
    },
  ];
  const hidden = branches.flatMap(({ table, winner }) => [
    sql`SELECT i.turn_item_id
      FROM orchestration_v2_projection_runs r CROSS JOIN ${table} i
      WHERE r.thread_id = ${threadId} AND r.status = 'cancelled'
        AND i.thread_id = ${threadId} AND i.run_id = r.run_id
        AND i.type = 'user_message' AND json_extract(i.payload_json, '$.inputIntent') = 'queued_turn'
        AND ${winner}`,
    sql`SELECT i.turn_item_id
      FROM orchestration_v2_projection_run_attempts a CROSS JOIN ${table} i
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
