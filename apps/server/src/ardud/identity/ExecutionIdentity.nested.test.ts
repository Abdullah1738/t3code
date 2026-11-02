import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ExecutionIdentity from "./ExecutionIdentity.ts";

describe("Claude nested execution identity", () => {
  it.fails("documents the unresolved ownership flattening until the source fix is verified", () => {
    assert.fail("Pending #296: nested Claude ownership is flattened by the adapter and resolver.");
  });
  it.effect("uses the owning node, including old flattened children, and isolates siblings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const now = "2026-01-01T00:00:00.000Z";
        const insertThread = (id: string, parent: string | null, active: string | null) =>
          sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
            thread_id: id, project_id: "project", title: id, default_provider: "claudeAgent",
            runtime_mode: "full-access", interaction_mode: "default",
            active_provider_thread_id: active, created_at: now, updated_at: now,
            archived_at: null, deleted_at: null, provider_instance_id: "claudeAgent",
            payload_json: JSON.stringify({ lineage: { parentThreadId: parent, rootThreadId: "root" } }),
          })}`;
        yield* insertThread("root", null, "pt");
        for (const id of ["a", "b", "leaf", "leaf-b"]) {
          // Old nested child threads have the root as their stored parent.
          yield* insertThread(id, "root", null);
        }
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert({
          provider_thread_id: "pt", thread_id: "root", owner_node_id: null,
          provider: "claudeAgent", provider_session_id: null, status: "idle",
          first_run_ordinal: 1, last_run_ordinal: 1, updated_at: now,
          driver: "claudeAgent", provider_instance_id: "claudeAgent",
          payload_json: JSON.stringify({ nativeThreadRef: { nativeId: "session" }, createdAt: now }),
        })}`;
        const insertAgent = (node: string, child: string, parentNode: string, native: string) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO orchestration_v2_projection_nodes ${sql.insert({
              node_id: node, thread_id: "root", run_id: null, parent_node_id: parentNode,
              root_node_id: "root-node", kind: "subagent", status: "running",
              provider_thread_id: "pt", provider_turn_id: null, runtime_request_id: null,
              checkpoint_scope_id: null, started_at: now, completed_at: null,
              payload_json: JSON.stringify({ id: node }),
            })}`;
            yield* sql`INSERT INTO orchestration_v2_projection_subagents ${sql.insert({
              subagent_id: node, thread_id: "root", run_id: null, parent_node_id: parentNode,
              provider: "claudeAgent", provider_thread_id: null, child_thread_id: child,
              origin: "provider_native", status: "running", started_at: now, completed_at: null,
              updated_at: now, driver: "claudeAgent", provider_instance_id: "claudeAgent",
              payload_json: JSON.stringify({ nativeTaskRef: { nativeId: native } }),
            })}`;
          });
        yield* insertAgent("node-a", "a", "root-node", "agent-a");
        yield* insertAgent("node-b", "b", "root-node", "agent-b");
        yield* insertAgent("node-leaf", "leaf", "node-a", "agent-leaf");
        yield* insertAgent("node-leaf-b", "leaf-b", "node-b", "agent-leaf-b");

        const resolve = (agentId: string) => identity.resolve({
          nativeId: "session", driver: "claudeAgent", agentId,
        });
        const a = yield* resolve("agent-a");
        const leaf = yield* resolve("agent-leaf");
        const sibling = yield* resolve("agent-leaf-b");
        assert.strictEqual(a.parentThreadId, "root");
        assert.strictEqual(leaf.parentThreadId, "a");
        assert.strictEqual(leaf.rootThreadId, "root");
        assert.strictEqual(sibling.parentThreadId, "b");
        assert.strictEqual(leaf.robobThreadId, "leaf");
        assert.strictEqual(sibling.robobThreadId, "leaf-b");

        // A placeholder task can be upserted before the parent Agent frame.
        yield* sql`UPDATE orchestration_v2_projection_subagents SET parent_node_id = 'root-node' WHERE subagent_id = 'node-leaf'`;
        yield* sql`UPDATE orchestration_v2_projection_nodes SET parent_node_id = 'root-node' WHERE node_id = 'node-leaf'`;
        assert.strictEqual((yield* resolve("agent-leaf")).parentThreadId, "root");
        yield* sql`UPDATE orchestration_v2_projection_subagents SET parent_node_id = 'node-a' WHERE subagent_id = 'node-leaf'`;
        yield* sql`UPDATE orchestration_v2_projection_nodes SET parent_node_id = 'node-a' WHERE node_id = 'node-leaf'`;
        assert.strictEqual((yield* resolve("agent-leaf")).parentThreadId, "a");

        // Duplicate native IDs are never assigned to an arbitrary sibling.
        yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json = ${JSON.stringify({ nativeTaskRef: { nativeId: "agent-leaf" } })} WHERE subagent_id = 'node-leaf-b'`;
        assert.strictEqual((yield* resolve("agent-leaf")).resolution, "ambiguous");
        yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json = ${JSON.stringify({ nativeTaskRef: { nativeId: "agent-leaf-b" } })} WHERE subagent_id = 'node-leaf-b'`;

        // An owner from another provider thread cannot prove this child's parent.
        yield* sql`UPDATE orchestration_v2_projection_nodes SET provider_thread_id = 'other' WHERE node_id = 'node-a'`;
        assert.strictEqual((yield* resolve("agent-leaf")).resolution, "unavailable");
        assert.strictEqual((yield* resolve("agent-leaf-b")).parentThreadId, "b");
      }).pipe(Effect.provide(ExecutionIdentity.layer)),
    ).pipe(Effect.provide(Sqlite.layerMemory)),
  );
});
