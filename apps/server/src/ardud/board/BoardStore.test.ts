import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { blankRow } from "./BoardModel.ts";
import * as BoardStore from "./BoardStore.ts";

const TestLayer = BoardStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.layer(TestLayer)("session board store", (it) => {
  it.effect("creates its tables idempotently and round-trips rows and revision", () =>
    Effect.gen(function* () {
      const store = yield* BoardStore.BoardStore;
      const first = yield* store.load;
      assert.equal(first.meta.revision, 0);
      const row = {
        ...blankRow("thread-a", "A"),
        pending: true,
        scheduled: true,
        completedFrom: null,
        promptAt: 120,
        workRevision: 3,
        updatedAt: 120,
      };
      yield* store.save([row], 1);
      yield* store.save(
        [{ ...row, pending: false, reviewed: true, completedFrom: "scheduled" }],
        2,
      );
      const second = yield* store.load;
      assert.equal(second.meta.revision, 2);
      assert.equal(second.meta.activatedAt, first.meta.activatedAt);
      assert.deepStrictEqual(second.rows, [
        { ...row, pending: false, reviewed: true, completedFrom: "scheduled" },
      ]);
    }),
  );

  it.effect("reads the scheduled task behind each thread's latest prompt", () =>
    Effect.gen(function* () {
      const store = yield* BoardStore.BoardStore;
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(orchestration_v2_projection_messages)
      `;
      const message = (threadId: string, id: string, at: string, payload: object) => {
        const values: Record<string, unknown> = {
          message_id: id,
          thread_id: threadId,
          role: "user",
          updated_at: at,
          created_at: at,
          payload_json: JSON.stringify(payload),
        };
        for (const column of columns) {
          if (column.notnull === 1 && !(column.name in values)) values[column.name] = "x";
        }
        return sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert(values)}`;
      };
      yield* message("t-run", "m1", "2026-10-03T00:00:00.000Z", { scheduledTaskId: "task-a" });
      yield* message("t-later", "m2", "2026-10-03T00:00:00.000Z", { scheduledTaskId: "task-a" });
      yield* message("t-later", "m3", "2026-10-03T00:01:00.000Z", {});
      const scheduled = yield* store.scheduledThreads(["t-run", "t-later", "t-none"]);
      assert.deepStrictEqual([...scheduled], [["t-run", "task-a"]]);
    }),
  );
});
