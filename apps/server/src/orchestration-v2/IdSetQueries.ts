import type { ThreadId, RunId } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";
type PayloadRow = { readonly payload_json: string };
export const checkpointScopes = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  scopeIds: ReadonlyArray<string>,
) =>
  sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes INDEXED BY sqlite_autoindex_orchestration_v2_projection_checkpoint_scopes_1 WHERE thread_id = ${threadId} AND ${scopeIds.length === 1 ? sql`scope_id = ${scopeIds[0]}` : sql`scope_id IN (SELECT value FROM json_each(${JSON.stringify(scopeIds)}))`} ORDER BY ordinal_within_parent ASC, scope_id ASC`;
export const turnStartHistory = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  runIds?: ReadonlyArray<RunId>,
) => sql<PayloadRow>`
          SELECT payload_json FROM ardud_history_turn_items
          WHERE thread_id = ${threadId}
            AND type IN ('user_message','assistant_message','command_execution','error',
              'run_interrupt_result','file_change','proposed_plan')
            AND ${runIds === undefined ? sql`1` : sql`run_id IN (SELECT value FROM json_each(${JSON.stringify(runIds)}))`}
          ORDER BY ordinal ASC, turn_item_id ASC
        `;
export const nodes = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  nodeIds: ReadonlyArray<string | null>,
  ordered: boolean,
) =>
  sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes INDEXED BY sqlite_autoindex_orchestration_v2_projection_nodes_1 WHERE thread_id = ${threadId} AND ${nodeIds.length === 1 ? sql`node_id = ${nodeIds[0]}` : sql`node_id IN (SELECT value FROM json_each(${JSON.stringify(nodeIds)}))`} ${ordered ? sql`ORDER BY node_id ASC` : sql``}`;
