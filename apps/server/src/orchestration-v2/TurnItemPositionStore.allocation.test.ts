import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("supplied run ordinals avoid reading the run projection, including ordinal zero", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const queries: string[] = [];
    const record: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        queries.push(statement.compile()[0]);
        return statement;
      });
    const threadId = ThreadId.make("thread:supplied-run-ordinal");
    for (const runOrdinal of [0, 2]) {
      assert.equal(
        yield* positions
          .allocate({
            threadId,
            turnItemId: TurnItemId.make(`item:supplied:${runOrdinal}`),
            runId: RunId.make("run:not-projected"),
            runOrdinal,
          })
          .pipe(Effect.provideService(Statement.CurrentTransformer, record)),
        runOrdinal * 1_000_000 + 1,
      );
    }
    assert.isFalse(queries.some((query) => query.includes("orchestration_v2_projection_runs")));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("allocates after the last position in the selected thread and run bucket", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:bucket-bounds");
    yield* sql`
      INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
      VALUES
        (${threadId}, 'item:unassigned', 1),
        (${threadId}, 'item:earlier-run', 1999999),
        (${threadId}, 'item:bucket-start', 2000000),
        (${threadId}, 'item:gap', 2000007),
        (${threadId}, 'item:later-run', 3000001),
        ('thread:other', 'item:gap', 2999999)
    `;
    const input = {
      threadId,
      turnItemId: TurnItemId.make("item:next"),
      runId: RunId.make("run:bucket"),
      runOrdinal: 2,
    };
    assert.equal(yield* positions.allocate(input), 2_000_008);
    assert.equal(
      yield* positions.allocate({ ...input, turnItemId: TurnItemId.make("item:after-next") }),
      2_000_009,
    );
    assert.equal(yield* positions.allocate({ ...input, runOrdinal: 3 }), 2_000_008);
    assert.equal(
      yield* positions.allocate({
        ...input,
        turnItemId: TurnItemId.make("item:empty"),
        runOrdinal: 4,
      }),
      4_000_001,
    );
    assert.equal(
      yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("item:unassigned-next"),
        runId: null,
      }),
      2,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("resolves missing run ordinals from the projection and falls back for unknown runs", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:run-lookup");
    const runId = RunId.make("run:projected");
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${runId}, ${threadId}, 3, 'codex', 'running', '2026-01-01T00:00:00.000Z', '{}')
    `;
    assert.equal(
      yield* positions.allocate({ threadId, runId, turnItemId: TurnItemId.make("item:lookup") }),
      3_000_001,
    );
    assert.equal(
      yield* positions.allocate({
        threadId,
        runId: RunId.make("run:missing"),
        turnItemId: TurnItemId.make("item:unknown-run"),
      }),
      1,
    );
    assert.equal(
      yield* positions.allocate({
        threadId,
        runId,
        runOrdinal: 2,
        turnItemId: TurnItemId.make("item:override"),
      }),
      2_000_001,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("allocation seeks the existing covering ordinal index without an aggregate or sort", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:allocation-plan");
    yield* sql`
      INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
      SELECT ${threadId}, 'item:history:' || value, 2000000 + value
      FROM json_each(${JSON.stringify(Array.from({ length: 2_000 }, (_, index) => index + 1))})
    `;
    const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const record: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        queries.push(statement.compile());
        return statement;
      });
    assert.equal(
      yield* positions
        .allocate({
          threadId,
          turnItemId: TurnItemId.make("item:next"),
          runId: null,
          runOrdinal: 2,
        })
        .pipe(Effect.provideService(Statement.CurrentTransformer, record)),
      2_002_001,
    );
    const insert = queries.find(([query]) =>
      query.includes("INSERT INTO orchestration_v2_turn_item_positions"),
    );
    assert.isDefined(insert);
    const [query, params] = insert!;
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${query}`,
      params,
    );
    assert.isTrue(
      plan.some((row) =>
        row.detail.includes(
          "USING COVERING INDEX sqlite_autoindex_orchestration_v2_turn_item_positions_2 (thread_id=? AND ordinal>? AND ordinal<?)",
        ),
      ),
    );
    assert.isFalse(plan.some((row) => /SCAN|TEMP B-TREE/.test(row.detail)));
    const bytecode = yield* sql.unsafe<{ readonly opcode: string }>(`EXPLAIN ${query}`, params);
    assert.isFalse(bytecode.some((row) => row.opcode === "AggStep" || row.opcode === "SorterOpen"));
  }).pipe(Effect.provide(layerTest)),
);
