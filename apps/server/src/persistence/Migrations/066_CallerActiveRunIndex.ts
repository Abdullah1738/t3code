import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A missing active run must not scan the caller's completed history.
  yield* sql`
    CREATE INDEX IF NOT EXISTS ardud_caller_active_run_idx
    ON orchestration_v2_projection_runs(thread_id, ordinal DESC, run_id DESC)
    WHERE status IN ('preparing', 'starting', 'running')
  `;
});
