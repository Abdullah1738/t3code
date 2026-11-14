// @effect-diagnostics globalConsole:off globalConsoleInEffect:off - Record seeded before/after timings in the offbox log.
import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projection from "./ProjectionStore.ts";

const layer = Projection.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect(
  "archive and list candidates preserve shell output without materializing run history",
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
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: now,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const ids = Array.from({ length: 1000 }, (_, i) => `seed-${i}`);
      yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
        interaction_mode, created_at, updated_at, archived_at, payload_json)
      SELECT value, project_id, title, default_provider, provider_instance_id, runtime_mode,
        interaction_mode, created_at, updated_at, CASE WHEN key < 500 THEN archived_at ELSE NULL END,
        json_set(payload_json, '$.id', value, '$.lineage.rootThreadId', value,
          '$.archivedAt', CASE WHEN key < 500 THEN archived_at ELSE NULL END)
      FROM orchestration_v2_projection_threads CROSS JOIN json_each(${JSON.stringify(ids)})
      WHERE thread_id = ${threadId}`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      SELECT t.thread_id || '-run-' || value, t.thread_id, value, 'synthetic', 'completed',
        '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z',
        json_object('startedAt', '2026-01-01T00:00:00Z', 'padding', printf('%01024d', 0))
      FROM orchestration_v2_projection_threads t
      CROSS JOIN json_each(${JSON.stringify(Array.from({ length: 100 }, (_, i) => i + 1))})`;
      yield* sql`INSERT INTO ardud_shell_item_counts (thread_id, run_key, item_count)
      SELECT thread_id, run_id, 2 FROM orchestration_v2_projection_runs`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET
      status = CASE CAST(substr(thread_id, 6) AS INTEGER) % 6
        WHEN 0 THEN 'running' WHEN 1 THEN 'waiting' WHEN 2 THEN 'queued'
        WHEN 3 THEN 'cancelled' WHEN 4 THEN 'failed' ELSE 'completed' END,
      payload_json = json_set(payload_json, '$.queueHeld', json('true'), '$.startedAt',
        CASE WHEN CAST(substr(thread_id, 6) AS INTEGER) % 6 = 3 THEN NULL
        ELSE '2026-01-01T00:00:00Z' END)
      WHERE ordinal = 100`;
      const beforeStart = performance.now();
      // The unfiltered route retains the old materialized query: same fixture and wire derivation.
      const baseline = yield* projection.getShellSnapshot();
      const beforeMs = performance.now() - beforeStart;
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string" && query.includes("WITH shell_runs"))
              statements.push(query);
          };
          return span;
        },
      });
      const afterStart = performance.now();
      const archive = yield* projection
        .getShellSnapshot({ location: "archive" })
        .pipe(Effect.withTracer(tracer));
      const archiveMs = performance.now() - afterStart;
      assert.deepEqual(archive.archivedThreads, baseline.archivedThreads);
      assert.lengthOf(archive.threads, 0);
      const candidatesStart = performance.now();
      const candidates = yield* projection
        .getThreadListCandidates(projectId)
        .pipe(Effect.withTracer(tracer));
      const selected = candidates.toSorted((a, b) => b.id.localeCompare(a.id)).slice(0, 50);
      const page = yield* projection.getShellSnapshot({
        location: "active",
        threadIds: selected.map((c) => c.id),
      });
      const listMs = performance.now() - candidatesStart;
      const expectedById = new Map(baseline.threads.map((t) => [t.id, t]));
      assert.lengthOf(candidates, baseline.threads.length);
      for (const candidate of candidates) {
        const expected = expectedById.get(candidate.id)!;
        for (const key of Object.keys(candidate) as Array<keyof Projection.ThreadListCandidate>) {
          assert.deepEqual(candidate[key], expected[key], `${candidate.id}.${key}`);
        }
      }
      for (const shell of page.threads) assert.deepEqual(shell, expectedById.get(shell.id));
      assert.lengthOf(page.threads, 50);
      // Five full candidate pages plus the empty final page; only the result page reads counts.
      assert.lengthOf(statements, 7);
      for (const candidateQuery of statements.slice(1)) {
        assert.include(candidateQuery, "INDEXED BY ardud_shell_project_threads_idx");
        assert.include(candidateQuery, "0 AS item_count");
        assert.include(candidateQuery, "LIMIT ?");
      }
      for (const statement of statements) {
        const plan = yield* sql.unsafe<{ parent: number; detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
          Array.from({ length: (statement.match(/\?/g) ?? []).length }, () => null),
        );
        const details = plan.map((row) => row.detail).join("\n");
        assert.notMatch(
          details,
          /MATERIALIZE shell_runs|SCAN orchestration_v2_projection_runs/,
          details,
        );
        assert.match(details, /SEARCH .*USING INDEX ardud_shell_executed_run_idx/, details);
        assert.match(details, /SEARCH .*USING INDEX ardud_shell_activity_run_idx/, details);
        if (statement !== statements[0]) {
          assert.match(details, /SEARCH .*USING INDEX ardud_shell_project_threads_idx/, details);
          assert.isFalse(
            plan.some((row) => row.parent === 0 && /USE TEMP B-TREE/.test(row.detail)),
            details,
          );
        }
      }
      const archiveQuery = statements[0]!;
      const bindings = Array.from({ length: (archiveQuery.match(/\?/g) ?? []).length }, () => null);
      const beforeSqlStart = performance.now();
      const oldRows = yield* sql.unsafe(
        archiveQuery.replace("AS NOT MATERIALIZED", "AS MATERIALIZED"),
        bindings,
      );
      const beforeSqlMs = performance.now() - beforeSqlStart;
      const afterSqlStart = performance.now();
      const newRows = yield* sql.unsafe(archiveQuery, bindings);
      const afterSqlMs = performance.now() - afterSqlStart;
      assert.deepEqual(newRows, oldRows);
      console.log(
        JSON.stringify({
          fixtureThreads: 1001,
          fixtureRuns: 100100,
          beforeMs,
          archiveMs,
          listMs,
          beforeSqlMs,
          afterSqlMs,
        }),
      );
    }).pipe(Effect.provide(layer)),
);
