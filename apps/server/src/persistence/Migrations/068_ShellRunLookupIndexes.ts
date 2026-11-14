import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// CREATE INDEX always scans the table, even when an existing index covers its
// columns. Fault the fragmented table pages in before the migrator takes its
// writer lock; the DDL then reads cached pages without fetching JSON overflow.
export const warmShellRunLookupPages = Effect.fn("warmShellRunLookupPages")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`SELECT name FROM sqlite_schema WHERE type = 'table'
    AND name IN ('orchestration_v2_projection_threads', 'orchestration_v2_projection_runs')`;
  if (tables.length !== 2) return;
  const applied = yield* sql`SELECT 1 FROM effect_sql_migrations WHERE migration_id = 68`;
  if (applied.length !== 0) return;
  yield* sql`SELECT sum(length(project_id) + length(thread_id)
    + (deleted_at IS NULL) + (archived_at IS NULL))
    FROM orchestration_v2_projection_threads NOT INDEXED`;
  yield* sql`SELECT sum(length(thread_id) + length(run_id)
    + length(status) + length(COALESCE(completed_at, '')))
    FROM orchestration_v2_projection_runs NOT INDEXED`;
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keyset candidate pages stop after 100 project rows without sorting the whole project.
  yield* sql`CREATE INDEX ardud_shell_project_threads_idx
    ON orchestration_v2_projection_threads(project_id, thread_id)
    WHERE deleted_at IS NULL AND archived_at IS NULL`;
  // The archive and MCP candidate lists must skip completed history when looking for live work.
  yield* sql`CREATE INDEX ardud_shell_activity_run_idx
    ON orchestration_v2_projection_runs(thread_id, ordinal DESC, run_id DESC)
    WHERE status IN ('preparing', 'starting', 'running', 'waiting')`;
  // Filter cancelled-before-start runs at read time: parsing every payload at boot is expensive.
  yield* sql`CREATE INDEX ardud_shell_executed_run_idx
    ON orchestration_v2_projection_runs(thread_id, completed_at IS NULL DESC,
      completed_at DESC, ordinal DESC, run_id DESC)
    WHERE status <> 'queued'`;
});
