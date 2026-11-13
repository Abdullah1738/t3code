import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerSql = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const at = DateTime.makeUnsafe("2026-11-05T12:00:00.000Z");
const providerInstanceId = ProviderInstanceId.make("opencode");
const candidate = (suffix: string): OrchestrationV2AppThread => {
  const id = ThreadId.make(`thread:cutover:${suffix}`);
  return {
    id,
    createdBy: "user",
    creationSource: "web",
    projectId: ProjectId.make("project:cutover"),
    title: suffix,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "source-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

const seed = Effect.fn("seedCutoverCandidates")(function* (
  threads: ReadonlyArray<OrchestrationV2AppThread>,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  for (const thread of threads.toReversed()) {
    yield* store.apply({
      id: EventId.make(`event:${thread.id}:created`),
      type: "thread.created",
      threadId: thread.id,
      occurredAt: at,
      payload: thread,
    });
  }
  return store;
});

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerSql],
] as const)("%s cutover inventory includes settled, board and subagent threads", ([, layer]) =>
  Effect.gen(function* () {
    const root = candidate("A-regular");
    const settled = {
      ...candidate("B-settled"),
      settledAt: at,
      settledOverride: "settled" as const,
    };
    const board = { ...candidate("Z-board"), creationSource: "mcp" as const };
    const child = {
      ...candidate("a-child"),
      creationSource: "mcp" as const,
      lineage: {
        rootThreadId: root.id,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const nativeChild = {
      ...child,
      ...candidate("b-native-child"),
      creationSource: "provider" as const,
      lineage: child.lineage,
    };
    const expected = [root, settled, board, child, nativeChild];
    const store = yield* seed([
      ...expected,
      { ...candidate("A-archived"), archivedAt: at },
      { ...candidate("B-deleted"), deletedAt: at },
    ]);

    const first = yield* store.listCutoverCandidates({ limit: 2 });
    assert.deepEqual(first, { threads: [root, settled], nextThreadId: settled.id });
    const second = yield* store.listCutoverCandidates({
      afterThreadId: first.nextThreadId!,
      limit: 2,
    });
    assert.deepEqual(second, { threads: [board, child], nextThreadId: child.id });
    const last = yield* store.listCutoverCandidates({
      afterThreadId: second.nextThreadId!,
      limit: 1,
    });
    assert.deepEqual(last, { threads: [nativeChild], nextThreadId: null });
    assert.deepEqual(yield* store.listCutoverCandidates({ limit: expected.length }), {
      threads: expected,
      nextThreadId: null,
    });
    assert.deepEqual(
      yield* store.listCutoverCandidates({ afterThreadId: nativeChild.id, limit: 2 }),
      {
        threads: [],
        nextThreadId: null,
      },
    );
    assert.deepEqual(
      yield* store.listCutoverCandidates({
        afterThreadId: ThreadId.make("thread:cutover:C-missing-cursor"),
        limit: 10,
      }),
      { threads: [board, child, nativeChild], nextThreadId: null },
    );
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerSql],
] as const)("%s cutover inventory clamps page sizes to 1 through 100", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    assert.deepEqual(yield* store.listCutoverCandidates({ limit: 0 }), {
      threads: [],
      nextThreadId: null,
    });
    const threads = Array.from({ length: 101 }, (_, i) => candidate(String(i).padStart(3, "0")));
    yield* seed(threads);
    for (const limit of [0, -10, 1.9]) {
      assert.deepEqual(yield* store.listCutoverCandidates({ limit }), {
        threads: [threads[0]!],
        nextThreadId: threads[0]!.id,
      });
    }
    const first = yield* store.listCutoverCandidates({ limit: 10_000 });
    assert.deepEqual(first, { threads: threads.slice(0, 100), nextThreadId: threads[99]!.id });
    assert.deepEqual(
      yield* store.listCutoverCandidates({ afterThreadId: first.nextThreadId!, limit: 100 }),
      {
        threads: [threads[100]!],
        nextThreadId: null,
      },
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("SQL cutover inventory reads only thread rows and defers lookahead decoding", () =>
  Effect.gen(function* () {
    const first = candidate("first");
    const lookahead = candidate("second");
    const store = yield* seed([first, lookahead]);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE ardud_kanban_threads (thread_id TEXT PRIMARY KEY)`;
    yield* sql`INSERT INTO ardud_kanban_threads (thread_id) VALUES (${first.id})`;
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.createdAt', 'invalid-date')
      WHERE thread_id = ${lookahead.id}
    `;
    const statements: Array<string> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query === "string") statements.push(query);
        };
        return span;
      },
    });
    assert.deepEqual(
      yield* store.listCutoverCandidates({ limit: 1 }).pipe(Effect.withTracer(tracer)),
      {
        threads: [first],
        nextThreadId: first.id,
      },
    );
    assert.lengthOf(statements, 1);
    assert.match(statements[0]!, /FROM orchestration_v2_projection_threads/);
    assert.notMatch(
      statements[0]!,
      /JOIN|orchestration_v2_projection_(runs|messages|turn_items|subagents)|ardud_kanban_threads/i,
    );
    assert.match(statements[0]!, /ORDER BY thread_id ASC\s+LIMIT/);
    const result = yield* store
      .listCutoverCandidates({ afterThreadId: first.id, limit: 1 })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure._tag, "ProjectionStoreSetupError");
  }).pipe(Effect.provide(layerSql)),
);
