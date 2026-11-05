import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import type { CutoverItem } from "./CutoverEngine.ts";
import * as CutoverStore from "./CutoverStore.ts";

const TestLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-store-" });
    return CutoverStore.layerWithOptions({ snapshotPath: path.join(directory, "plan.json") }).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    );
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

const item: CutoverItem = {
  key: "thread:thread-1",
  kind: "thread",
  ref: "thread-1",
  payload: { sourceRunId: "run-1", transcript: { summary: "summary", recent: ["a", "b"] } },
  wake: true,
};

it.effect("construction and reads never create the ledger", () =>
  Effect.gen(function* () {
    const store = yield* CutoverStore.CutoverStore;
    const sql = yield* SqlClient.SqlClient;
    assert.strictEqual(yield* store.read(), null);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_schema WHERE name = 'ardud_harness_cutover_items'`,
      [],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("atomically snapshots the ordered items and refuses to replace them on retry", () =>
  Effect.gen(function* () {
    const store = yield* CutoverStore.CutoverStore;
    const first = yield* store.start([item], [{ ref: "unsupported", reason: "not mapped" }]);
    assert.deepStrictEqual(first.items, [
      {
        ...item,
        state: "planned",
        phase: "switch",
        attempts: 0,
        reason: null,
        rollbackAttempts: 0,
        rolledBack: false,
      },
    ]);
    assert.deepStrictEqual(
      yield* store.start(
        [
          { ...item, payload: "wrong" },
          { ...item, key: "new" },
        ],
        [],
      ),
      first,
    );
    assert.deepStrictEqual(yield* store.read(), first);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("persists phase progress without rewriting the original payload", () =>
  Effect.gen(function* () {
    const store = yield* CutoverStore.CutoverStore;
    const snapshot = yield* store.start([item], []);
    yield* store.save({
      ...snapshot.items[0]!,
      payload: "must not replace payload",
      state: "failed",
      phase: "brief",
      attempts: 3,
      reason: "delivery unavailable",
      rollbackAttempts: 1,
      rolledBack: true,
    });
    const persisted = (yield* store.read())!.items[0]!;
    assert.deepStrictEqual(persisted, {
      ...item,
      state: "failed",
      phase: "brief",
      attempts: 3,
      reason: "delivery unavailable",
      rollbackAttempts: 1,
      rolledBack: true,
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("an empty snapshot remains distinguishable from a job that never started", () =>
  Effect.gen(function* () {
    const store = yield* CutoverStore.CutoverStore;
    assert.deepStrictEqual(yield* store.start([], []), { items: [], refusals: [] });
    assert.deepStrictEqual(yield* store.start([item], []), { items: [], refusals: [] });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("duplicate keys and unencodable payloads leave no table or partial claims", () =>
  Effect.gen(function* () {
    const store = yield* CutoverStore.CutoverStore;
    const sql = yield* SqlClient.SqlClient;
    assert.isTrue(Result.isFailure(yield* Effect.result(store.start([item, item], []))));
    const circular: { self?: unknown } = {};
    circular.self = circular;
    assert.isTrue(
      Result.isFailure(yield* Effect.result(store.start([{ ...item, payload: circular }], []))),
    );
    assert.strictEqual(yield* store.read(), null);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_schema WHERE name = 'ardud_harness_cutover_items'`,
      [],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "imports at most sixteen intents per transaction and resumes an interrupted frozen snapshot",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-import-" });
        const snapshotPath = path.join(directory, "plan.json");
        let crash = true;
        let previous = 0;
        const counts: Array<number> = [];
        const instrumented = new Proxy(sql, {
          get(target, property, receiver) {
            if (property !== "withTransaction") return Reflect.get(target, property, receiver);
            return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              sql.withTransaction(effect).pipe(
                Effect.tap(
                  Effect.gen(function* () {
                    const rows = yield* sql<{
                      count: number;
                    }>`SELECT COUNT(*) AS count FROM ardud_harness_cutover_items WHERE kind != 'snapshot'`;
                    const count = rows[0]!.count;
                    counts.push(count - previous);
                    previous = count;
                    if (count === 32 && crash)
                      return yield* Effect.die("crashed after a committed import batch");
                  }),
                ),
              );
          },
        });
        const context = yield* Layer.build(
          CutoverStore.layerWithOptions({ snapshotPath }).pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, instrumented)),
          ),
        );
        const store = yield* CutoverStore.CutoverStore.pipe(Effect.provide(context));
        const entries = Array.from({ length: 41 }, (_, index) => ({
          ...item,
          key: `thread:${index}`,
          ref: String(index),
        }));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(store.start(entries, []))));
        const partial = yield* store.read();
        assert.isTrue(partial!.initializing);
        assert.strictEqual(partial!.items.length, 41);
        assert.isTrue(partial!.items.every((row) => row.state === "planned"));
        const stat = yield* fs.stat(snapshotPath);
        assert.strictEqual(stat.mode & 0o777, 0o600);
        crash = false;
        const complete = yield* store.start([{ ...item, key: "replacement" }], []);
        assert.isUndefined(complete.initializing);
        assert.deepStrictEqual(
          complete.items.map((row) => row.key),
          entries.map((row) => row.key),
        );
        assert.isTrue(counts.every((count) => count >= 0 && count <= 16));
        assert.deepStrictEqual(
          (yield* store.read())!.items.map((row) => row.payload),
          entries.map((row) => row.payload),
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
);
