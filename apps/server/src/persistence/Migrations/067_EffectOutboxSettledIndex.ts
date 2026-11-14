import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_effect_outbox_settled_idx
    ON orchestration_v2_effect_outbox(completed_at)
    WHERE status IN ('succeeded', 'cancelled')
  `;
});
