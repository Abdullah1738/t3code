import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Statement from "effect/sql/Statement";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EventId,
  ThreadId,
  TurnItemId,
  MessageId,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { archiveHistoryPass } from "./HistoryArchive.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as Deferred from "effect/Deferred";
import { liveColumns } from "./historyArchiveSql.ts";
import { ArchiveSnapshotGate } from "./archiveSnapshotGate.ts";

const seedRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES ('old', 'project', 'Old', 'opencode', 'full-access', 'default', '2020-01-01', '2020-01-01', '{"archivedAt":null}')`;
  for (let index = 1; index <= 4; index++) {
    yield* sql`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES (${`event:${index}`}, 'thread', 'old', ${index}, ${index === 1 ? "thread.created" : "thread.metadata-updated"}, '2020-01-01', 'server', ${`{"index":${index}}`}, '{}', 2)`;
  }
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items
    (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
    VALUES ('item', 'old', 1, 'assistant_message', 'completed', '2020-01-01', '{"text":"cold"}')`;
});

const seed = TestClock.setTime(Date.UTC(2026, 10, 5)).pipe(Effect.andThen(seedRows));

const runPass = Effect.gen(function* () {
  const fiber = yield* archiveHistoryPass().pipe(Effect.forkChild);
  yield* TestClock.adjust("100 millis");
  return yield* Fiber.join(fiber);
});

it.effect("moves cold events and items without changing replay identities or cursors", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const before =
      yield* sql`SELECT sequence, event_id, stream_version, payload_json FROM orchestration_events ORDER BY sequence`;
    for (let pass = 0; pass < 5; pass++) yield* runPass;
    assert.deepEqual(
      yield* sql`SELECT sequence, event_id, stream_version, payload_json FROM ardud_history_events ORDER BY sequence`,
      before,
    );
    assert.deepEqual(yield* sql`SELECT event_id FROM orchestration_events ORDER BY sequence`, [
      { event_id: "event:1" },
      { event_id: "event:4" },
    ]);
    assert.deepEqual(
      yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items`,
      [],
    );
    assert.deepEqual(yield* sql`SELECT payload_json FROM ardud_history_turn_items`, [
      { payload_json: '{"text":"cold"}' },
    ]);
    const journal =
      yield* sql`SELECT table_name, row_key, through_event_sequence FROM ardud_history_archive_deletions ORDER BY sequence`;
    assert.lengthOf(journal, 1);
    assert.deepEqual(journal.at(-1), {
      table_name: "orchestration_v2_projection_turn_items",
      row_key: "item",
      through_event_sequence: 4,
    });
    // A repeated pass is idempotent, and a newer live value shadows the archive.
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('item', 'old', 1, 'assistant_message', 'completed', '2026-01-01', '{"text":"hot"}')`;
    assert.deepEqual(yield* sql`SELECT payload_json FROM ardud_history_turn_items`, [
      { payload_json: '{"text":"hot"}' },
    ]);
    assert.isTrue(
      (yield* Effect.exit(sql`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES ('event:2', 'thread', 'old', 5, 'thread.metadata-updated', '2026-01-01', 'server', '{}', '{}', 2)`))
        ._tag === "Failure",
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("does not delete a row changed after its archive copy commits", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    let changed = false;
    const race: Statement.Transformer = (statement) => {
      const [query] = statement.compile();
      if (changed || !/^\s*DELETE FROM "orchestration_events"/.test(query))
        return Effect.succeed(statement);
      changed = true;
      return sql`UPDATE orchestration_events SET payload_json = '{"changed":true}' WHERE sequence = 2`.pipe(
        Effect.orDie,
        Effect.as(statement),
      );
    };
    yield* runPass.pipe(Effect.provideService(Statement.CurrentTransformer, race));
    assert.isTrue(changed);
    assert.deepEqual(yield* sql`SELECT payload_json FROM ardud_history_events WHERE sequence = 2`, [
      { payload_json: '{"changed":true}' },
    ]);
    assert.deepEqual(yield* sql`SELECT * FROM ardud_history_archive_deletions`, []);
    for (let pass = 0; pass < 5; pass++) yield* runPass;
    assert.deepEqual(yield* sql`SELECT payload_json FROM ardud_history_events WHERE sequence = 2`, [
      { payload_json: '{"changed":true}' },
    ]);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("keeps oversized rows hot while progressing beyond them", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${"x".repeat(70_000)}`;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('small', 'old', 3, 'assistant_message', 'completed', '2020-01-01', '{}')`;
    for (let pass = 0; pass < 5; pass++) yield* runPass;
    assert.deepEqual(
      yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items ORDER BY turn_item_id`,
      [{ turn_item_id: "item" }],
    );
    assert.deepEqual(yield* sql`SELECT turn_item_id FROM ardud_archive.ardud_turn_items`, [
      { turn_item_id: "small" },
    ]);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("never archives a thread with unfinished work", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_turn_items SET status = 'running', type = 'command_execution'`;
    yield* runPass;
    assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM orchestration_events`, [{ n: 4 }]);
    assert.deepEqual(yield* sql`SELECT * FROM ardud_history_archive_deletions`, []);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("uses independent archive rowids when SQLite reuses a live rowid", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    for (let pass = 0; pass < 5; pass++) yield* runPass;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('second', 'old', 2, 'assistant_message', 'completed', '2020-01-01', '{}')`;
    for (let pass = 0; pass < 5; pass++) yield* runPass;
    const rows = yield* sql<{
      rowid: number;
      turn_item_id: string;
    }>`SELECT rowid, turn_item_id FROM ardud_history_turn_items ORDER BY turn_item_id`;
    assert.lengthOf(rows, 2);
    assert.equal(new Set(rows.map((row) => row.rowid)).size, 2);
    assert.isTrue(rows.every((row) => row.rowid < 0));
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

// Jumping TestClock after the file layer starts replays its checkpoint schedule.
// Real time also lets sleeps registered after worker replies complete normally.
it.live("attaches history on the file reader and preserves it across reopen", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "history-archive-" });
    const filename = path.join(dir, "statev2.sqlite");
    const layer = Sqlite.layerFromPath(filename);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* seedRows;
        for (let pass = 0; pass < 5; pass++) yield* archiveHistoryPass();
      }).pipe(Effect.provide(layer)),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          yield* sql`SELECT event_id FROM ardud_history_events ORDER BY sequence`.pipe(
            NodeSqliteClient.readOnly,
          ),
          [1, 2, 3, 4].map((index) => ({ event_id: `event:${index}` })),
        );
        assert.deepEqual(
          yield* sql`SELECT payload_json FROM ardud_history_turn_items`.pipe(
            NodeSqliteClient.readOnly,
          ),
          [{ payload_json: '{"text":"cold"}' }],
        );
      }).pipe(Effect.provide(Layer.fresh(Sqlite.layerFromPath(filename)))),
    );
    yield* fs.remove(path.join(dir, "archive.sqlite"));
    const missing = yield* Effect.scoped(
      Effect.void.pipe(Effect.provide(Layer.fresh(Sqlite.layerFromPath(filename)))),
    ).pipe(Effect.exit);
    assert.equal(missing._tag, "Failure");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("pins cold and hot snapshots before allowing a live shadow to be rearchived", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "archive-snapshot-" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* seedRows;
        const sql = yield* SqlClient.SqlClient;
        // Detect reader startup fallback before the concurrent writer would deadlock.
        const writeError =
          yield* sql`UPDATE orchestration_v2_projection_threads SET title = title WHERE 0`.pipe(
            NodeSqliteClient.readOnly,
            Effect.flip,
          );
        assert.include(String(writeError.reason.cause), "readonly database");
        const columns = liveColumns("orchestration_v2_projection_turn_items");
        yield* sql.unsafe(
          `INSERT INTO ardud_archive.ardud_turn_items (${columns}) SELECT ${columns} FROM orchestration_v2_projection_turn_items`,
        );
        yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
        const pinned = yield* Deferred.make<void>();
        const updated = yield* Deferred.make<void>();
        const reader = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`;
              yield* Deferred.succeed(pinned, undefined);
              yield* Deferred.await(updated);
              return yield* sql`SELECT payload_json FROM ardud_history_turn_items`;
            }),
          )
          .pipe(NodeSqliteClient.readOnly, Effect.forkChild);
        yield* Deferred.await(pinned);
        const gate = yield* ArchiveSnapshotGate;
        yield* gate.withPermits(1)(
          sql`UPDATE ardud_archive.ardud_turn_items SET payload_json = '{"text":"newer"}'`,
        );
        yield* Deferred.succeed(updated, undefined);
        assert.deepEqual(yield* Fiber.join(reader), [{ payload_json: '{"text":"cold"}' }]);
        assert.deepEqual(
          yield* sql`SELECT payload_json FROM ardud_history_turn_items`.pipe(
            NodeSqliteClient.readOnly,
          ),
          [{ payload_json: '{"text":"newer"}' }],
        );
        const nestedPinned = yield* Deferred.make<void>();
        const nestedUpdated = yield* Deferred.make<void>();
        const nested = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql.withTransaction(Effect.fail("nested rollback")).pipe(Effect.ignore);
              yield* Deferred.succeed(nestedPinned, undefined);
              yield* Deferred.await(nestedUpdated);
              return yield* sql`SELECT payload_json FROM ardud_history_turn_items`.unprepared;
            }),
          )
          .pipe(NodeSqliteClient.readOnly, Effect.forkChild);
        yield* Deferred.await(nestedPinned);
        yield* gate.withPermits(1)(
          sql`UPDATE ardud_archive.ardud_turn_items SET payload_json = '{"text":"newest"}'`,
        );
        yield* Deferred.succeed(nestedUpdated, undefined);
        assert.deepEqual(yield* Fiber.join(nested), [{ payload_json: '{"text":"newer"}' }]);
        assert.deepEqual(
          yield* sql`SELECT payload_json FROM ardud_history_turn_items`.pipe(
            NodeSqliteClient.readOnly,
          ),
          [{ payload_json: '{"text":"newest"}' }],
        );
      }).pipe(Effect.provide(Sqlite.layerFromPath(path.join(dir, "statev2.sqlite")))),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const integrationLayer = Layer.mergeAll(EventSink.layer, ProjectionMaintenance.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(ProjectionStore.layer, EventStore.layer, OrchestrationEventStore.layer),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect(
  "opens and pages a cold transcript, retries command reads, and rebuilds from cold events",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 10, 5));
      const sink = yield* EventSink.EventSinkV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const threadId = ThreadId.make("cold-integration");
      const old = DateTime.makeUnsafe("2020-01-01T00:00:00Z");
      yield* sink.write({
        events: [
          {
            id: EventId.make("cold:create"),
            type: "thread.created",
            threadId,
            occurredAt: old,
            payload: {
              id: threadId,
              projectId: ProjectId.make("project"),
              title: "Cold",
              createdBy: "user",
              creationSource: "web",
              providerInstanceId: ProviderInstanceId.make("opencode"),
              modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "test" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: old,
              updatedAt: old,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          },
        ],
      });
      for (let index = 1; index <= 3; index++) {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`cold:item:${index}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: old,
              payload: {
                id: TurnItemId.make(`cold:item:${index}`),
                threadId,
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: index,
                type: "assistant_message",
                status: "completed",
                text: `message ${index}`,
                updatedAt: old,
                messageId: MessageId.make(`message:${index}`),
                streaming: false,
                title: null,
                startedAt: old,
                completedAt: old,
              },
            },
          ],
        });
      }
      const before = yield* projection.getThreadProjection(threadId);
      const replayBefore = yield* store.readAgentEvents({ threadId }).pipe(Stream.runCollect);
      for (let pass = 0; pass < 6; pass++) yield* runPass;
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS n FROM orchestration_v2_projection_turn_items`,
        [{ n: 0 }],
      );
      assert.deepEqual(yield* projection.getThreadProjection(threadId), before);
      assert.deepEqual(
        yield* store.readAgentEvents({ threadId }).pipe(Stream.runCollect),
        replayBefore,
      );
      const snapshot = yield* projection.getThreadSnapshotWindow(threadId, { rowLimit: 100 });
      assert.lengthOf(snapshot.projection.turnItems, 3);
      const page = yield* projection.getTimelinePage(threadId, { limit: 100, view: "activity" });
      assert.lengthOf(page.items, 3);
      assert.isTrue((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* projection.getThreadProjection(threadId), before);
    }).pipe(Effect.provide(integrationLayer)),
);
