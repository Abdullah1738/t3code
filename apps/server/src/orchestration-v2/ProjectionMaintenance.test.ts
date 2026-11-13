import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layer = ProjectionMaintenance.layer.pipe(
  Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 105)
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, actor_kind, payload_json, metadata_json, application_event_version
    ) SELECT 'event:' || n, 'thread', 'thread:fixture', n, 'message.updated',
      '2026-01-01T00:00:00.000Z', 'server', '{"id":"message:fixture"}', '{}', 2 FROM history
  `;
});

const sequences = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{
    readonly sequence: number;
  }>`SELECT sequence FROM orchestration_events ORDER BY sequence`).map((row) => row.sequence);
});

it.effect("rebuild preserves cold rollback copies instead of deleting across WAL stores", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* sql`INSERT INTO ardud_archive.ardud_turn_items (
      ardud_rowid, turn_item_id, thread_id, ordinal, payload_json
    ) VALUES (-1, 'stale', 'removed-thread', 1, '{}')`;
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.deepEqual(yield* sql`SELECT turn_item_id FROM ardud_archive.ardud_turn_items`, [
      { turn_item_id: "stale" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("bounds each table's scan and preserves oldest/newest through fresh passes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* seed;
    yield* sql`INSERT INTO orchestration_v2_legacy_imports (
      thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count
    ) VALUES ('imported', 'now', 'now', 'now', 1)`;
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 105)
      INSERT INTO orchestration_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
      ) SELECT 'receipt:' || n, 'thread', 'imported', 'now', n, 'accepted', 'legacy' FROM history
    `;
    const scans = { events: 0, receipts: 0 };
    const deletes: ReadonlyArray<unknown>[] = [];
    const observe: Statement.Transformer = (statement) => {
      const [query, params] = statement.compile();
      if (/^\s*SELECT\s+event\.sequence/.test(query)) scans.events++;
      if (/^\s*SELECT\s+receipt\.rowid/.test(query)) scans.receipts++;
      if (/^\s*DELETE FROM orchestration_(events|command_receipts)/.test(query))
        deletes.push(params);
      return Effect.succeed(statement);
    };
    const result = yield* maintenance
      .compactEventStoreWith({ minPageIntervalMs: 0, maxPagesPerScan: 1 })
      .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    assert.deepEqual(scans, { events: 1, receipts: 1 });
    assert.equal(result.deletedEventCount, 48);
    assert.equal(result.deletedReceiptCount, 50);
    assert.lengthOf(deletes, 98);
    assert.isTrue(deletes.every((params) => params.length === 1));
    assert.deepEqual(yield* sequences, [...Array.from({ length: 56 }, (_, i) => i + 1), 105]);
    const next = yield* maintenance.compactEventStoreWith({
      minPageIntervalMs: 0,
      maxPagesPerScan: 1,
    });
    assert.equal(next.deletedEventCount, 48);
    assert.deepEqual(yield* sequences, [1, 2, 3, 4, 5, 6, 7, 8, 105]);
    yield* maintenance.compactEventStore;
    assert.deepEqual(yield* sequences, [1, 105]);
  }).pipe(Effect.provide(layer)),
);

it.effect("stops between single-row deletes when its elapsed budget expires", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* seed;
    const clock = yield* Clock.Clock;
    const sleeping = yield* Queue.unbounded<void>();
    const observedClock: Clock.Clock = {
      ...clock,
      sleep: (duration) =>
        Queue.offer(sleeping, undefined).pipe(Effect.andThen(clock.sleep(duration))),
    };
    const fiber = yield* maintenance
      .compactEventStoreWith({
        minPageIntervalMs: 0,
        minDeleteIntervalMs: 5,
        maxPagesPerScan: 20,
        maxDurationMs: 12,
      })
      .pipe(Effect.provideService(Clock.Clock, observedClock), Effect.forkChild);
    for (let i = 0; i < 3; i++) {
      yield* Queue.take(sleeping);
      // The writer is available during every pause.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS responsiveness (id INTEGER)`;
      yield* TestClock.adjust("5 millis");
    }
    const result = yield* Fiber.join(fiber);
    assert.equal(result.deletedEventCount, 3);
    assert.deepEqual(yield* sequences, [...Array.from({ length: 101 }, (_, i) => i + 1), 105]);
    yield* maintenance.compactEventStore;
    assert.deepEqual(yield* sequences, [1, 105]);
  }).pipe(Effect.provide(layer)),
);

it.effect("does no deletes after a discovery statement exhausts the pass budget", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* seed;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let pages = 0;
    const slowRead: Statement.Transformer = (statement) => {
      if (!/^\s*SELECT\s+event\.sequence/.test(statement.compile()[0]))
        return Effect.succeed(statement);
      pages++;
      return Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(statement),
      );
    };
    const fiber = yield* maintenance
      .compactEventStoreWith({ minPageIntervalMs: 0, maxDurationMs: 100 })
      .pipe(Effect.provideService(Statement.CurrentTransformer, slowRead), Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("100 millis");
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(fiber);
    assert.equal(pages, 1);
    assert.equal(result.deletedEventCount, 0);
    assert.lengthOf(yield* sequences, 105);
  }).pipe(Effect.provide(layer)),
);

it.effect("can interrupt between deletes and restart without losing replay anchors", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* seed;
    const clock = yield* Clock.Clock;
    const sleeping = yield* Deferred.make<void>();
    const fiber = yield* maintenance
      .compactEventStoreWith({ minPageIntervalMs: 0, minDeleteIntervalMs: 5 })
      .pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: (duration) =>
            Deferred.succeed(sleeping, undefined).pipe(Effect.andThen(clock.sleep(duration))),
        }),
        Effect.forkChild,
      );
    yield* Deferred.await(sleeping);
    yield* Fiber.interrupt(fiber);
    assert.lengthOf(yield* sequences, 104);
    yield* maintenance.compactEventStore;
    assert.deepEqual(yield* sequences, [1, 105]);
  }).pipe(Effect.provide(layer)),
);

it.effect("counts only the text payloads actually deleted before the pass budget expires", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = "2026-01-01T00:00:00.000Z";
    const payload = JSON.stringify({
      id: "item:fixture",
      threadId: "thread:fixture",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      type: "reasoning",
      text: "retained text",
      streaming: true,
    });
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 5)
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) SELECT 'event:' || n, 'thread', 'thread:fixture', n, 'turn-item.updated',
        ${now}, 'server', ${payload}, '{}', 2 FROM history
    `;
    const clock = yield* Clock.Clock;
    const sleeping = yield* Deferred.make<void>();
    const fiber = yield* maintenance
      .compactEventStoreWith({
        minPageIntervalMs: 0,
        minDeleteIntervalMs: 5,
        maxDurationMs: 5,
      })
      .pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: (duration) =>
            Deferred.succeed(sleeping, undefined).pipe(Effect.andThen(clock.sleep(duration))),
        }),
        Effect.forkChild,
      );
    yield* Deferred.await(sleeping);
    yield* TestClock.adjust("5 millis");
    const result = yield* Fiber.join(fiber);
    assert.equal(result.consideredTextEventCount, 5);
    assert.equal(result.deletedEventCount, 1);
    assert.equal(result.deletedTextEventCount, 1);
    assert.equal(result.retainedTextEventCount, 4);
    assert.equal(result.deletedTextPayloadBytes, Buffer.byteLength(payload));
    assert.deepEqual(yield* sequences, [1, 2, 3, 5]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "defers oversized text candidates to offline compaction without losing either endpoint",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const now = "2026-01-01T00:00:00.000Z";
      const payload = {
        id: "item:fixture",
        threadId: "thread:fixture",
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
        type: "reasoning",
        text: "small",
        streaming: true,
      };
      for (let n = 1; n <= 5; n++) {
        const text = n === 3 ? "é".repeat(40_000) : "small";
        yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (${`event:${n}`}, 'thread', 'thread:fixture', ${n}, 'turn-item.updated',
        ${now}, 'server', ${JSON.stringify({ ...payload, text })}, '{}', 2)`;
      }
      const bounded = {
        minPageIntervalMs: 0,
        maxPagesPerScan: 1,
        maxDeletePayloadBytes: 64 * 1024,
      };
      const result = yield* maintenance.compactEventStoreWith(bounded);
      assert.equal(result.deletedEventCount, 2);
      assert.equal(result.deletedTextEventCount, 2);
      assert.equal(result.consideredTextEventCount, 4);
      assert.deepEqual(yield* sequences, [1, 3, 5]);
      assert.equal((yield* maintenance.compactEventStoreWith(bounded)).deletedEventCount, 0);
      assert.deepEqual(yield* sequences, [1, 3, 5]);
      assert.equal((yield* maintenance.compactEventStore).deletedTextEventCount, 1);
      assert.deepEqual(yield* sequences, [1, 5]);
    }).pipe(Effect.provide(layer)),
);
