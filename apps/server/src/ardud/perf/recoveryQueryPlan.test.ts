// @effect-diagnostics globalConsole:off globalConsoleInEffect:off
import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Projection from "../../orchestration-v2/ProjectionStore.ts";
const database = Sqlite.layerMemory;
const layer = Projection.layer.pipe(Layer.provideMerge(database));
it.effect("startup recovery query registry uses hot indexed thread worksets", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projection = yield* Projection.ProjectionStoreV2;
    const threadId = ThreadId.make("synthetic-thread");
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
    yield* projection.apply({
      id: EventId.make("created"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("synthetic"),
        title: "Synthetic",
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
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const statements: string[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options),
          end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          const q = span.attributes.get("db.query.text");
          if (typeof q === "string" && /^\s*SELECT/i.test(q)) statements.push(q);
        };
        return span;
      },
    });
    yield* projection.getRuntimeRecoveryProjection(threadId).pipe(Effect.withTracer(tracer));
    assert.equal(statements.length, 11);
    // Exercise the ownership paths even when appThreadId is absent. Completed
    // nodes/subagents still supply ownership for a live provider thread.
    yield* sql`INSERT INTO orchestration_v2_projection_nodes
      (node_id,thread_id,root_node_id,kind,status,payload_json)
      VALUES ('owner',${threadId},'owner','root_turn','completed','{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id,thread_id,parent_node_id,provider,provider_thread_id,origin,status,updated_at,payload_json)
      VALUES ('child',${threadId},'owner','synthetic','via-child','provider_native','completed','2026-01-01','{}')`;
    for (const [id, owner] of [
      ["via-owner", "owner"],
      ["via-child", null],
      ["unrelated", null],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id,owner_node_id,provider,status,updated_at,payload_json)
        VALUES (${id},${owner},'synthetic','active','2026-01-01',${JSON.stringify(id)})`;
    }
    const providerQuery = statements.find((q) =>
      q.includes("SELECT provider_thread.payload_json"),
    )!;
    const bindings = new Array((providerQuery.match(/\?/g) ?? []).length).fill(threadId);
    const selected = yield* sql.unsafe<{ payload_json: string }>(providerQuery, bindings);
    assert.deepEqual(selected.map((r) => JSON.parse(r.payload_json)).sort(), ["via-child", "via-owner"]);

    for (const statement of statements) {
      assert.notMatch(
        statement,
        /ardud_(?:history|archive|base)/i,
        "recovery must never open transcript archives",
      );
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement}`);
      console.log(JSON.stringify({ route: "startup.recovery", statement, plan }));
      assert.deepEqual(
        plan.filter((p) => /\bSCAN\b/i.test(p.detail)),
        [],
        statement,
      );
    }
  }).pipe(Effect.provide(layer)),
);
