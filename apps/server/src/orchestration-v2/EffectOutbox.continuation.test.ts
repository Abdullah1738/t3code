import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

const layer = EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const continuation = (id: string, threadId: ThreadId, queued?: boolean) => ({
  id,
  threadId,
  commandId: CommandId.make(`command:${id}`),
  request: {
    type: "provider-runtime.continue" as const,
    sourceRunId: RunId.make(`run:${id}`),
    ...(queued === undefined ? {} : { queued }),
  },
});

// Writes the outbox table without the service: no production path does this, so
// a row written here is invisible exactly when the probe skipped the database.
const setStatus = (effectId: string, status: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`UPDATE orchestration_v2_effect_outbox SET status = ${status}
      WHERE effect_id = ${effectId}`,
  );
const insertRaw = (effectId: string, threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (
        ${effectId}, 'command:raw', ${threadId}, 'provider-runtime.continue',
        ${JSON.stringify({ type: "provider-runtime.continue", sourceRunId: "run:raw" })},
        'pending', 0, '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z',
        '2026-11-18T00:00:00.000Z'
      )
    `,
  );

it.effect("the probe skips the database for a thread with no continuation", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:quiet");
    assert.isFalse(yield* outbox.hasPendingRunContinuation(threadId));
    yield* insertRaw("effect:raw", threadId);
    assert.isNull(yield* outbox.pendingRunContinuation(threadId));
  }).pipe(Effect.provide(layer)),
);

it.effect("continuations an earlier process left are found after the seed", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:restarted");
    yield* insertRaw("effect:left", threadId);
    assert.equal(yield* outbox.pendingRunContinuation(threadId), "effect:left");
    yield* setStatus("effect:left", "succeeded");
    assert.isNull(yield* outbox.pendingRunContinuation(threadId));
  }).pipe(Effect.provide(layer)),
);

it.effect("an enqueued continuation is found until it settles, then the next one is", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:recovering");
    assert.isNull(yield* outbox.pendingRunContinuation(threadId));
    yield* outbox.enqueue([continuation("effect:first", threadId)]);
    assert.equal(yield* outbox.pendingRunContinuation(threadId), "effect:first");
    yield* setStatus("effect:first", "running");
    assert.equal(yield* outbox.pendingRunContinuation(threadId), "effect:first");
    yield* setStatus("effect:first", "succeeded");
    assert.isNull(yield* outbox.pendingRunContinuation(threadId));
    // The mark is gone, so the database is no longer read for this thread.
    yield* insertRaw("effect:raw", threadId);
    assert.isNull(yield* outbox.pendingRunContinuation(threadId));
    yield* outbox.enqueue([continuation("effect:second", threadId)]);
    assert.include(["effect:raw", "effect:second"], yield* outbox.pendingRunContinuation(threadId));
  }).pipe(Effect.provide(layer)),
);

it.effect("an empty probe keeps a continuation no statement has seen yet", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:uncommitted");
    assert.isNull(yield* outbox.pendingRunContinuation(threadId));
    yield* outbox.enqueue([continuation("effect:late", threadId)]);
    // Stands in for an insert whose transaction has not committed yet.
    yield* setStatus("effect:late", "cancelled");
    assert.isNull(yield* outbox.pendingRunContinuation(threadId));
    yield* setStatus("effect:late", "pending");
    assert.equal(yield* outbox.pendingRunContinuation(threadId), "effect:late");
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["claim", "cancel"] as const)(
  "a continuation the worker %ss counts as seen",
  (step) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make(`thread:${step}`);
      assert.isNull(yield* outbox.pendingRunContinuation(threadId));
      yield* outbox.enqueue([continuation("effect:handled", threadId)]);
      if (step === "claim") {
        const claimed = yield* outbox.claimNext({ workerId: "worker", leaseDurationMs: 60_000 });
        assert.equal(claimed._tag === "Some" ? claimed.value.id : null, "effect:handled");
        yield* setStatus("effect:handled", "succeeded");
      } else {
        const cancelled = yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-runtime.continue"],
          reason: "stopped",
        });
        assert.deepEqual(cancelled, ["effect:handled"]);
      }
      assert.isNull(yield* outbox.pendingRunContinuation(threadId));
      yield* insertRaw("effect:raw", threadId);
      assert.isNull(yield* outbox.pendingRunContinuation(threadId));
    }).pipe(Effect.provide(layer)),
);

it.effect("queued and already-present continuations do not mark the thread", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const queuedThread = ThreadId.make("thread:queued");
    assert.isNull(yield* outbox.pendingRunContinuation(queuedThread));
    yield* outbox.enqueue([continuation("effect:queued", queuedThread, true)]);
    assert.isNull(yield* outbox.pendingRunContinuation(queuedThread));

    const settledThread = ThreadId.make("thread:settled");
    yield* outbox.enqueue([continuation("effect:once", settledThread)]);
    assert.equal(yield* outbox.pendingRunContinuation(settledThread), "effect:once");
    yield* setStatus("effect:once", "succeeded");
    assert.isNull(yield* outbox.pendingRunContinuation(settledThread));
    // Same id again: the insert is ignored, so nothing new can be pending.
    yield* outbox.enqueue([continuation("effect:once", settledThread)]);
    yield* setStatus("effect:once", "pending");
    assert.isNull(yield* outbox.pendingRunContinuation(settledThread));
  }).pipe(Effect.provide(layer)),
);

it.effect("another outbox instance over the same database sees the marks", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:shared");
    assert.isNull(yield* outbox.pendingRunContinuation(threadId));
    yield* outbox.enqueue([continuation("effect:shared", threadId)]);
    const seenElsewhere = yield* Effect.flatMap(EffectOutbox.EffectOutboxV2, (other) =>
      other.pendingRunContinuation(threadId),
    ).pipe(Effect.provide(EffectOutbox.layer, { local: true }));
    assert.equal(seenElsewhere, "effect:shared");
  }).pipe(Effect.provide(layer)),
);
