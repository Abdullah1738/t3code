// Separate partial indexes keep visibility corrections independent of command
// output volume, including runs with many ordinary user-message items.
export const threadReadIndexes = (
  schema: "main" | "ardud_archive",
  table: "orchestration_v2_projection_turn_items" | "ardud_turn_items",
) => [
  `CREATE INDEX IF NOT EXISTS ${schema}.ardud_thread_read_queued_idx
    ON ${table}(thread_id, run_id, turn_item_id)
    WHERE type = 'user_message' AND json_extract(payload_json, '$.inputIntent') = 'queued_turn'`,
  `CREATE INDEX IF NOT EXISTS ${schema}.ardud_thread_read_interrupt_result_idx
    ON ${table}(thread_id, run_id, node_id, turn_item_id)
    WHERE type = 'run_interrupt_result'`,
  `CREATE INDEX IF NOT EXISTS ${schema}.ardud_thread_read_interrupt_request_idx
    ON ${table}(thread_id, run_id, turn_item_id)
    WHERE type = 'run_interrupt_request'`,
];
