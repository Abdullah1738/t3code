import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keyset candidate pages stop after 100 project rows without sorting the whole project.
  yield* sql`CREATE INDEX ardud_shell_project_threads_idx
    ON orchestration_v2_projection_threads(project_id, thread_id)
    WHERE deleted_at IS NULL AND json_extract(payload_json, '$.archivedAt') IS NULL`;
  // The archive and MCP candidate lists must skip completed history when looking for live work.
  yield* sql`CREATE INDEX ardud_shell_activity_run_idx
    ON orchestration_v2_projection_runs(thread_id, ordinal DESC, run_id DESC)
    WHERE status IN ('preparing', 'starting', 'running', 'waiting')`;
  // Matches latestExecutedRun's completion order, including open runs before finished ones.
  yield* sql`CREATE INDEX ardud_shell_executed_run_idx
    ON orchestration_v2_projection_runs(thread_id, completed_at IS NULL DESC,
      completed_at DESC, ordinal DESC, run_id DESC)
    WHERE status <> 'queued'
      AND NOT (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL)`;
});
