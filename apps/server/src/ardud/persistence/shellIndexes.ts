import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Lives outside Migrations: the fork forbids new numbered upstream migrations.
// Idempotent, so it runs on every open, after runMigrations, for fresh and upgraded databases.
// Predicate must match the authored subqueries in ProjectionStore (INDEXED BY).
export const ensureShellLookupIndexes = Effect.fn("ensureShellLookupIndexes")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS ardud_v2_messages_latest_user_authored_idx
    ON orchestration_v2_projection_messages(thread_id, updated_at DESC, message_id DESC)
    WHERE role = 'user' AND json_extract(payload_json, '$.createdBy') = 'user'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS ardud_provider_turns_completed_idx
    ON orchestration_v2_projection_provider_turns(completed_at)
  `;
  // Only unfinished running turns need the second range scan.
  yield* sql`
    CREATE INDEX IF NOT EXISTS ardud_provider_turns_running_started_idx
    ON orchestration_v2_projection_provider_turns(started_at)
    WHERE completed_at IS NULL AND status = 'running'
  `;
});
