import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { blankRow } from "./BoardModel.ts";
import * as BoardStore from "./BoardStore.ts";
import { parseOpenChamberLedger, planOpenChamberImport } from "./openchamberImport.ts";

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

  it.effect("keeps the first origin written and lets an explicit set replace it", () =>
    Effect.gen(function* () {
      const store = yield* BoardStore.BoardStore;
      assert.equal(yield* store.rememberOrigins([{ threadId: "thread-o", origin: "imessage" }]), 1);
      assert.equal(yield* store.rememberOrigins([{ threadId: "thread-o", origin: "crw" }]), 0);
      assert.equal((yield* store.origins(["thread-o"])).get("thread-o"), "imessage");
      yield* store.setOrigin({ threadId: "thread-o", origin: "crw" });
      assert.equal((yield* store.origins()).get("thread-o"), "crw");
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

  it.effect("reads the OpenCode import mapping", () =>
    Effect.gen(function* () {
      const store = yield* BoardStore.BoardStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO ardud_opencode_import (native_session_id, thread_id, imported_at)
        VALUES ('ses_1', 'thread-1', '2026-10-03T00:00:00.000Z')
      `;
      const mapping = yield* store.importedThreads(["ses_1", "ses_missing"]);
      assert.deepStrictEqual([...mapping], [["ses_1", "thread-1"]]);
    }),
  );
});

it("maps OpenChamber records onto threads and keeps their lanes", () => {
  const ledger = parseOpenChamberLedger({
    version: 1,
    revision: 9,
    activatedAt: 50,
    records: [
      {
        sessionId: "ses_wait",
        title: "W",
        pending: true,
        reviewed: false,
        workRevision: 2,
        updatedAt: 10,
        prompt: { id: "m", createdAt: 10 },
      },
      {
        sessionId: "ses_back",
        title: "B",
        pending: false,
        reviewed: true,
        backlog: true,
        workRevision: 1,
        updatedAt: 11,
      },
      {
        sessionId: "ses_cron",
        title: "C",
        pending: true,
        reviewed: false,
        scheduled: true,
        workRevision: 1,
        updatedAt: 12,
      },
      {
        sessionId: "ses_done",
        title: "D",
        pending: false,
        reviewed: true,
        completedFrom: "waiting",
        workRevision: 4,
        updatedAt: 13,
      },
      {
        sessionId: "ses_chat",
        title: "I",
        pending: false,
        reviewed: true,
        origin: "imessage",
        workRevision: 1,
        updatedAt: 14,
      },
      {
        sessionId: "ses_child",
        title: "S",
        pending: true,
        reviewed: false,
        parentId: "ses_wait",
        workRevision: 1,
        updatedAt: 15,
      },
      {
        sessionId: "ses_unmapped",
        title: "U",
        pending: true,
        reviewed: false,
        workRevision: 1,
        updatedAt: 16,
      },
    ],
  });
  const mapping = new Map(
    ["wait", "back", "cron", "done", "chat", "child"].map((name) => [`ses_${name}`, `t_${name}`]),
  );
  const plan = planOpenChamberImport(ledger, mapping);
  assert.deepStrictEqual(plan.summary, {
    total: 7,
    unmapped: 1,
    children: 1,
    origins: 1,
    lanes: { waiting: 1, backlog: 1, scheduled: 1, reviewed: 2 },
  });
  assert.deepStrictEqual(plan.origins, [{ threadId: "t_chat", origin: "imessage" }]);
  const rows = new Map(plan.rows.map((row) => [row.threadId, row]));
  assert.isTrue(rows.get("t_wait")?.pending);
  assert.equal(rows.get("t_wait")?.promptAt, 10);
  assert.isTrue(rows.get("t_back")?.backlog);
  assert.isTrue(rows.get("t_cron")?.scheduled);
  assert.equal(rows.get("t_done")?.completedFrom, "waiting");
  assert.isFalse(rows.has("t_child"));
});
