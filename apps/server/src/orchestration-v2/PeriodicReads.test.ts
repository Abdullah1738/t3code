import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projection from "./ProjectionStore.ts";

it.effect(
  "periodic reads select live metadata, loaded native IDs and nonempty rosters despite history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projection = yield* Projection.ProjectionStoreV2;
      const threadId = ThreadId.make("seed");
      const projectId = ProjectId.make("seed-project");
      const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
      yield* projection.apply({
        id: EventId.make("seed-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Seed",
          providerInstanceId: ProviderInstanceId.make("synthetic"),
          modelSelection: { instanceId: ProviderInstanceId.make("synthetic"), model: "synthetic" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/live",
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      const session = ProviderSessionId.make("session-live");
      const providerThread = {
        id: ProviderThreadId.make("provider-live"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: session,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native-live",
          strength: "strong" as const,
        },
        nativeConversationHeadRef: null,
        contextUsage: null,
        nativeMetadata: null,
        goal: null,
        status: "idle" as const,
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [
          { taskId: "job-live", kind: "command" as const, description: "server" },
        ],
      };
      yield* projection.apply({
        id: EventId.make("provider-live"),
        type: "provider-thread.updated",
        threadId,
        driver: ProviderDriverKind.make("codex"),
        occurredAt: now,
        payload: providerThread,
      });
      const before = yield* projection.getPullRequestSyncSnapshot({ unsettledOnly: true });
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const q = span.attributes.get("db.query.text");
            if (typeof q === "string") statements.push(q);
          };
          return span;
        },
      });
      const addHistory = (count: number) => sql`
      INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, owner_node_id, provider, provider_session_id, status,
          first_run_ordinal, last_run_ordinal, updated_at, payload_json, provider_instance_id)
      SELECT 'history-' || value, thread_id, NULL, provider, provider_session_id, 'idle',
        NULL, NULL, updated_at,
        json_set(payload_json, '$.id', 'history-' || value, '$.nativeThreadRef.nativeId', 'old-' || value,
          '$.pendingBackgroundTasks', json('[]')), provider_instance_id
      FROM orchestration_v2_projection_provider_threads
      CROSS JOIN json_each(${JSON.stringify(Array.from({ length: count }, (_, i) => i))})
      WHERE provider_thread_id = 'provider-live'
    `;
      yield* addHistory(3000);
      yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
        interaction_mode, created_at, updated_at, archived_at, payload_json)
      SELECT 'settled-' || value, project_id, title, default_provider, provider_instance_id, runtime_mode,
        interaction_mode, created_at, updated_at, NULL,
        json_set(payload_json, '$.id', 'settled-' || value, '$.lineage.rootThreadId', 'settled-' || value,
          '$.settledAt', '2026-01-01T00:00:00.000Z')
      FROM orchestration_v2_projection_threads
      CROSS JOIN json_each(${JSON.stringify(Array.from({ length: 3000 }, (_, i) => i))})
      WHERE thread_id = ${threadId}`;
      // Invalid historical payloads make an accidental decode of history fail as well.
      yield* sql`UPDATE orchestration_v2_projection_provider_threads
      SET payload_json = json_object('nativeThreadRef', json_object('nativeId', 'old-invalid'))
      WHERE provider_thread_id LIKE 'history-%'`;
      assert.deepEqual(
        yield* projection
          .getProviderThreadsByNativeIds(session, ["native-live"])
          .pipe(Effect.withTracer(tracer)),
        [providerThread],
      );
      assert.deepEqual(yield* projection.getProviderThreadsByNativeIds(session, []), []);
      const after = yield* projection
        .getPullRequestSyncSnapshot({ unsettledOnly: true })
        .pipe(Effect.withTracer(tracer));
      assert.deepEqual(after, before);
      assert.lengthOf(
        (yield* projection.getPullRequestSyncSnapshot({ unsettledOnly: false })).threads,
        3001,
      );
      assert.lengthOf(
        (yield* projection.getPullRequestSyncSnapshot({ threadId, unsettledOnly: false })).threads,
        1,
      );
      for (const filter of [
        { providerSessionId: session, pendingBackgroundTasksOnly: true },
        { providerSessionId: session, providerThreadIds: [providerThread.id] },
      ]) {
        const records = yield* projection
          .getThreadRecords(threadId, ["providerThreads"], filter)
          .pipe(Effect.withTracer(tracer));
        assert.deepEqual(records.providerThreads, [providerThread]);
      }
      assert.lengthOf(
        (yield* projection.getThreadRecords(threadId, ["providerThreads"], {
          providerSessionId: session,
          providerThreadIds: [],
        })).providerThreads,
        0,
      );
      assert.lengthOf(
        (yield* projection.getThreadRecords(threadId, ["providerThreads"], {
          providerSessionId: ProviderSessionId.make("other"),
          pendingBackgroundTasksOnly: true,
        })).providerThreads,
        0,
      );
      const candidate = statements.find(
        (q) => q.includes("ORDER BY thread_id ASC") && q.includes("settledOverride"),
      )!;
      const planOf = (q: string) =>
        sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${q}`,
          Array.from({ length: (q.match(/\?/g) ?? []).length }, () => null),
        );
      const candidatePlan = (yield* planOf(candidate)).map((r) => r.detail).join("\n");
      assert.include(candidatePlan, "ardud_pr_sync_unsettled_idx");
      for (const [name, index] of [
        ["nativeThreadRef", "ardud_provider_threads_native_idx"],
        ["pendingBackgroundTasks", "ardud_provider_threads_background_idx"],
      ]) {
        const query = statements.find(
          (q) =>
            q.includes("SELECT payload_json") &&
            q.includes("provider_threads") &&
            q.includes(`INDEXED BY ${index}`),
        )!;
        const plan = (yield* planOf(query)).map((r) => r.detail).join("\n");
        assert.include(plan, index!, name);
        if (name === "pendingBackgroundTasks") {
          assert.include(plan, "ardud_provider_thread_subagent_owner_idx");
          assert.include(plan, "(provider_thread_id=? AND thread_id=?)");
        }
        assert.notMatch(plan, /SCAN n\b|SCAN s\b|LIST SUBQUERY.*nodes/);
      }
      assert.isFalse(
        statements.some((q) => /projection_runs|history_turn_items|projection_messages/.test(q)),
      );
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
        SELECT 'old-run-' || value, ${threadId}, value, 'codex', 'completed',
          '2026-01-01', '2026-01-01', '{}'
        FROM json_each(${JSON.stringify(Array.from({ length: 3000 }, (_, i) => i))})`;
      const liveRuns = yield* projection
        .getThreadRecords(threadId, ["runs"], {
          unfinishedRunsOnly: true,
        })
        .pipe(Effect.withTracer(tracer));
      assert.deepEqual(liveRuns.runs, []);
      const runQuery = statements.find((q) =>
        q.includes("INDEXED BY orchestration_v2_projection_runs_recovery_idx"),
      )!;
      assert.include(
        (yield* planOf(runQuery)).map((r) => r.detail).join("\n"),
        "orchestration_v2_projection_runs_recovery_idx",
      );
      yield* sql`INSERT INTO orchestration_v2_projection_nodes
        (node_id, thread_id, root_node_id, kind, status, payload_json)
        VALUES ('owner-node', ${threadId}, 'owner-node', 'root_turn', 'completed', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_subagents
        (subagent_id, thread_id, parent_node_id, provider, provider_thread_id, origin, status, updated_at, payload_json)
        VALUES ('related-subagent', ${threadId}, 'owner-node', 'codex', 'related-subagent-thread', 'native', 'completed', '2026-01-01', '{}')`;
      for (const relation of ["owner", "subagent"] as const) {
        const id = `related-${relation}-thread`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
          (provider_thread_id, thread_id, owner_node_id, provider, provider_session_id, status,
            updated_at, payload_json, provider_instance_id)
          SELECT ${id}, NULL, ${relation === "owner" ? "owner-node" : null}, provider,
            provider_session_id, status, updated_at,
            json_set(payload_json, '$.id', ${id}, '$.appThreadId', NULL,
              '$.ownerNodeId', ${relation === "owner" ? "owner-node" : null},
              '$.nativeThreadRef.nativeId', ${id}), provider_instance_id
          FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = 'provider-live'`;
        const related = yield* projection.getThreadRecords(threadId, ["providerThreads"], {
          providerSessionId: session,
          providerThreadIds: [id],
          pendingBackgroundTasksOnly: true,
        });
        assert.equal(related.providerThreads[0]?.id, id);
      }
    }).pipe(Effect.provide(Projection.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
