import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ControlStore from "./ControlStore.ts";

const providerRow = (
  providerThreadId: string,
  threadId: string,
  driver: string,
  nativeId: string | null,
  updatedAt: string,
) => ({
  provider_thread_id: providerThreadId,
  thread_id: threadId,
  owner_node_id: null,
  provider: driver,
  provider_session_id: null,
  status: "idle",
  first_run_ordinal: 1,
  last_run_ordinal: 1,
  updated_at: updatedAt,
  driver,
  provider_instance_id: driver,
  payload_json: JSON.stringify({
    id: providerThreadId,
    driver,
    providerInstanceId: driver,
    appThreadId: threadId,
    nativeThreadRef: nativeId === null ? null : { driver, nativeId, strength: "strong" },
  }),
});

const threadRow = (threadId: string, activeProviderThreadId: string | null) => ({
  thread_id: threadId,
  project_id: "project",
  title: threadId,
  default_provider: "opencode",
  runtime_mode: "full-access",
  interaction_mode: "default",
  active_provider_thread_id: activeProviderThreadId,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  archived_at: null,
  deleted_at: null,
  provider_instance_id: "opencode",
  payload_json: JSON.stringify({
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    activeProviderThreadId,
    modelSelection: { instanceId: "opencode", model: "opus/claude-opus-5-5" },
  }),
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A migrated thread whose Claude binding has lost its native id. The old
  // OpenCode row was written later, so only the active binding can answer.
  yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(
    threadRow("t-detached", "pt-detached-claude"),
  )}`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
    providerRow("pt-detached-old", "t-detached", "opencode", "ses_detached_old", "2026-01-02T00:00:00.000Z"),
  )}`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
    providerRow("pt-detached-claude", "t-detached", "claudeAgent", null, "2026-01-01T00:00:00.000Z"),
  )}`;
  // A healthy migrated thread for contrast: its active Claude id is current.
  yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(
    threadRow("t-moved", "pt-moved-claude"),
  )}`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
    providerRow("pt-moved-old", "t-moved", "opencode", "ses_moved_old", "2026-01-02T00:00:00.000Z"),
  )}`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
    providerRow("pt-moved-claude", "t-moved", "claudeAgent", "claude-moved-uuid", "2026-01-01T00:00:00.000Z"),
  )}`;
});

const run = <A, E>(
  body: Effect.Effect<A, E, ControlStore.ControlStore | SqlClient.SqlClient>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed;
      return yield* body;
    }).pipe(Effect.provide(ControlStore.layer)),
  ).pipe(Effect.provide(Sqlite.layerMemory));

describe("ControlStore native ids", () => {
  it.effect("reports no current session id for a thread whose active binding has none", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ControlStore.ControlStore;
        const current = yield* store.nativeSessionIds(["t-detached"]);
        // The old ses_ is history, never the current id.
        assert.isFalse(current.has("t-detached"));
        const bindings = yield* store.nativeBindings(["t-detached"]);
        assert.isFalse(bindings.has("t-detached"));
        // It stays reachable by its historical id.
        assert.strictEqual(yield* store.threadIdForNativeSession("ses_detached_old"), "t-detached");
      }),
    ),
  );

  it.effect("reports the migrated thread's active Claude id as current", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ControlStore.ControlStore;
        const current = yield* store.nativeSessionIds(["t-moved"]);
        assert.strictEqual(current.get("t-moved"), "claude-moved-uuid");
      }),
    ),
  );

  it.effect("refuses a native id that two threads claim instead of picking the newest", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ControlStore.ControlStore;
        const sql = yield* SqlClient.SqlClient;
        // A second thread claims the same OpenCode session id.
        yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(
          threadRow("t-clash", "pt-clash"),
        )}`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(
          providerRow("pt-clash", "t-clash", "opencode", "ses_detached_old", "2026-01-03T00:00:00.000Z"),
        )}`;
        assert.isNull(yield* store.threadIdForNativeSession("ses_detached_old", "opencode"));
      }),
    ),
  );
});
