import type { ThreadId } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";
type ShellRunRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly ordinal: number;
};
type ShellRunItemCountRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly item_count: number;
};
type ShellPendingTurnItemRow = PayloadRow & {
  readonly thread_id: string;
  readonly owning_provider_instance_id: string | null;
};
type PayloadRow = {
  readonly payload_json: string;
};

export const selectShellRunRows = (
  sql: SqlClient.SqlClient,
  threadIds?: ReadonlyArray<ThreadId>,
) =>
  threadIds === undefined
    ? sql<ShellRunRow>`
            SELECT thread_id, run_id, ordinal
            FROM orchestration_v2_projection_runs
          `
    : sql<ShellRunRow>`
            SELECT thread_id, run_id, ordinal
            FROM orchestration_v2_projection_runs
            WHERE thread_id IN (SELECT value FROM json_each(${JSON.stringify(threadIds)}))
          `;

export const selectShellRunItemCounts = (
  sql: SqlClient.SqlClient,
  threadIds?: ReadonlyArray<ThreadId>,
) =>
  threadIds === undefined
    ? sql<ShellRunItemCountRow>`
            SELECT thread_id, run_key AS run_id, item_count
            FROM ardud_shell_item_counts
            WHERE run_key <> '' AND item_count > 0
          `
    : sql<ShellRunItemCountRow>`
            SELECT thread_id, run_key AS run_id, item_count
            FROM ardud_shell_item_counts
            WHERE run_key <> '' AND item_count > 0
              AND thread_id IN (SELECT value FROM json_each(${JSON.stringify(threadIds)}))
          `;

// Bind ID sets as one JSON value so full snapshots cannot exhaust SQLite variables.
export const selectShellProviderThreadRows = (
  sql: SqlClient.SqlClient,
  threadIds?: ReadonlyArray<ThreadId>,
) =>
  threadIds === undefined
    ? sql<PayloadRow & { readonly thread_id: string }>`
            SELECT thread_id, payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE thread_id IS NOT NULL
          `
    : sql<PayloadRow & { readonly thread_id: string }>`
            SELECT thread_id, payload_json
            FROM orchestration_v2_projection_provider_threads ${threadIds.length > 1000 ? sql`NOT INDEXED` : sql``}
            WHERE thread_id IN (SELECT value FROM json_each(${JSON.stringify(threadIds)}))
          `;

export const selectShellPendingTurnItemRows = (
  sql: SqlClient.SqlClient,
  threadIds?: ReadonlyArray<ThreadId>,
  activeRunIds: ReadonlyArray<string> = [],
) => sql<ShellPendingTurnItemRow>`
      SELECT i.thread_id, i.payload_json, p.provider_instance_id AS owning_provider_instance_id
      FROM orchestration_v2_projection_turn_items i
      LEFT JOIN orchestration_v2_projection_provider_threads p
        ON p.provider_thread_id = i.provider_thread_id
      LEFT JOIN orchestration_v2_projection_runs r
        ON r.run_id = i.run_id
      WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
        AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
        AND (i.run_id IS NULL OR r.status <> 'rolled_back')
        ${threadIds === undefined ? sql`` : sql`AND i.thread_id IN (SELECT value FROM json_each(${JSON.stringify(threadIds)}))`}
      ${
        activeRunIds.length === 0
          ? sql``
          : sql`
        -- Preserve the pending-item partial index; read other work only from running runs.
        UNION ALL
        SELECT i.thread_id, i.payload_json, NULL AS owning_provider_instance_id
        FROM orchestration_v2_projection_turn_items i
        WHERE i.run_id IN (SELECT value FROM json_each(${JSON.stringify(activeRunIds)}))
          AND i.type IN ('file_change', 'file_search', 'web_search', 'compaction')
          AND i.status IN ('running', 'waiting')
      `
      }
    `;
