import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { Switches } from "../perf/speedups.ts";

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
  // Control listings by updatedSince read the changed range newest first instead of
  // building every thread's shell (a 145 s reader stall on 9 Nov). Not partial on
  // deleted_at: a smaller partial index would win every plain "deleted_at IS NULL" scan
  // and quietly reorder or replan unrelated reads.
  yield* sql`
    CREATE INDEX IF NOT EXISTS ardud_v2_threads_updated_idx
    ON orchestration_v2_projection_threads(updated_at DESC, thread_id ASC)
  `;
  // The pull-request sweeps list every thread that has links, every ~23 s. Without this
  // they read each thread row's payload to test it (0.5-6 s on the live database, 10 Nov).
  // Its predicate is the sweep query's WHERE, term for term, so no other read can use it,
  // and the query's ORDER BY is the index order. A failure here only keeps the scan.
  yield* (
    (yield* Switches).threadsPullRequestIndex
      ? sql`
          CREATE INDEX IF NOT EXISTS ardud_v2_threads_pull_requests_idx
          ON orchestration_v2_projection_threads(updated_at ASC, thread_id ASC)
          WHERE deleted_at IS NULL
            AND json_extract(payload_json, '$.archivedAt') IS NULL
            AND json_array_length(payload_json, '$.pullRequests') > 0
        `
      : sql`DROP INDEX IF EXISTS ardud_v2_threads_pull_requests_idx`
  ).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not prepare the threads-with-pull-requests index", { cause }),
    ),
  );
  // Only unfinished running turns need the second range scan.
  yield* sql`
    CREATE INDEX IF NOT EXISTS ardud_provider_turns_running_started_idx
    ON orchestration_v2_projection_provider_turns(started_at)
    WHERE completed_at IS NULL AND status = 'running'
  `;
});
