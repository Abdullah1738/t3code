import { ThreadId, TurnItemId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as McpAppModelContext from "./McpAppModelContext.ts";

const database = SqlitePersistence.layerMemory;
const layer = it.layer(
  Layer.merge(database, McpAppModelContext.layer.pipe(Layer.provide(database))),
);

const threadId = ThreadId.make("thread-context");
const forkId = ThreadId.make("thread-context-fork");

const insertAppItem = (itemId: string, runId: string, runStatus: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${runId}, ${threadId}, ${runId.length}, 'codex', ${runStatus}, '2026-01-01', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${itemId}, ${threadId}, ${runId}, 0, 'dynamic_tool', 'completed', '2026-01-01', '{}')
    `;
  });

layer("McpAppModelContext", (it) => {
  it.effect("sends only apps still in the thread's history, including a fork's", () =>
    Effect.gen(function* () {
      const store = yield* McpAppModelContext.McpAppModelContext;
      yield* insertAppItem("item-kept", "run-a", "completed");
      yield* insertAppItem("item-rolled-back", "run-bb", "rolled_back");
      const set = (thread: ThreadId, itemId: string, text: string) =>
        store.set({
          threadId: thread,
          itemId: TurnItemId.make(itemId),
          server: "todos",
          tool: "list_todos",
          text,
        });
      yield* set(threadId, "item-kept", "kept");
      yield* set(threadId, "item-rolled-back", "from a rolled-back run");
      yield* set(threadId, "item-deleted", "from an item that is gone");

      yield* set(forkId, "item-kept", "from the fork");
      yield* set(forkId, "item-rolled-back", "inherited before the rollback");

      const texts = (thread: ThreadId) =>
        store.forThread(thread).pipe(Effect.map((entries) => entries.map((entry) => entry.text)));
      assert.deepEqual(yield* texts(threadId), ["kept"]);
      assert.deepEqual(yield* texts(forkId), ["from the fork", "inherited before the rollback"]);

      yield* set(threadId, "item-kept", "");
      assert.deepEqual(yield* texts(threadId), []);
    }),
  );

  it.effect("looks up app items by id in every history store instead of scanning them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* McpAppModelContext.McpAppModelContext;
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
      yield* store.forThread(threadId).pipe(Effect.withTracer(tracer));
      const statement = statements.find((text) => text.includes("ardud_history_turn_items"));
      assert.isDefined(statement);
      const plan = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
      ))
        .map((row) => row.detail)
        .join("\n");
      // Each store is searched by turn_item_id; a co-routine or scan of the
      // history view walks the whole base archive.
      assert.notMatch(
        plan,
        /CO-ROUTINE ardud_history_turn_items|SCAN (?:main\.)?orchestration_v2_projection_turn_items|SCAN cold|SCAN base/,
      );
      assert.match(plan, /SEARCH cold USING .*\(turn_item_id=\?\)/);
      assert.match(plan, /SEARCH base USING .*\(turn_item_id=\?\)/);
    }),
  );
});
