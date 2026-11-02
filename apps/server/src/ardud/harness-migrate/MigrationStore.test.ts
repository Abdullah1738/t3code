import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { MigrationStore, layer, type LedgerEntry } from "./MigrationStore.ts";

const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  threadId: "thread-1",
  version: 1,
  sourceSession: "ses_abc",
  sourceDigest: "deadbeef",
  targetDriver: "claudeAgent",
  targetInstance: "claudeAgent",
  targetNativeId: "11111111-2222-4333-8444-555555555555",
  home: "/Users/ardud/.robob/harness-homes/claude",
  cliVersion: "2.1.316",
  state: "staged",
  error: null,
  firstResumeConfirmedAt: null,
  createdAt: "2026-11-02T05:00:00.000Z",
  updatedAt: "2026-11-02T05:00:00.000Z",
  originalSelectionJson: '{"instanceId":"opencode","model":"opus/claude-opus-5-5"}',
  ...overrides,
});

const storeLayer = layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("creates the ledger and returns null for a thread with no row", () =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;
    const found = yield* store.get("missing-thread");
    assert.strictEqual(found, null);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("round-trips an inserted row with every column", () =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;
    yield* store.insert(entry());
    const read = yield* store.get("thread-1");
    assert.deepStrictEqual(read, entry());
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("moves a row through committed and then confirmed, keeping the first-resume time", () =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;
    yield* store.insert(entry());
    yield* store.setState({ threadId: "thread-1", state: "committed", updatedAt: "2026-11-02T05:01:00.000Z" });
    yield* store.setState({
      threadId: "thread-1",
      state: "confirmed",
      updatedAt: "2026-11-02T05:02:00.000Z",
      firstResumeConfirmedAt: "2026-11-02T05:02:00.000Z",
    });
    // A later state change without a confirmation time must not erase the first one.
    yield* store.setState({ threadId: "thread-1", state: "confirmed", updatedAt: "2026-11-02T05:03:00.000Z" });
    const read = yield* store.get("thread-1");
    assert.strictEqual(read?.state, "confirmed");
    assert.strictEqual(read?.firstResumeConfirmedAt, "2026-11-02T05:02:00.000Z");
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("lists rows oldest first", () =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;
    yield* store.insert(entry({ threadId: "thread-b", createdAt: "2026-11-02T05:10:00.000Z" }));
    yield* store.insert(entry({ threadId: "thread-a", createdAt: "2026-11-02T05:05:00.000Z" }));
    const rows = yield* store.list();
    assert.deepStrictEqual(
      rows.map((row) => row.threadId),
      ["thread-a", "thread-b"],
    );
  }).pipe(Effect.provide(storeLayer)),
);
