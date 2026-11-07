import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as CutoverEngine from "./CutoverEngine.ts";
import type { CutoverItem, CutoverPhase, CutoverPlan } from "./CutoverEngine.ts";
import * as CutoverStore from "./CutoverStore.ts";

const database = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-engine-" });
    return CutoverStore.layerWithOptions({ snapshotPath: path.join(directory, "plan.json") }).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    );
  }),
).pipe(Layer.provideMerge(NodeServices.layer));
const item = (ref: string, kind: CutoverItem["kind"] = "thread", wake = true): CutoverItem => ({
  key: `${kind}:${ref}`,
  kind,
  ref,
  payload: { sourceRunId: `source:${ref}`, summary: "summary", recent: ["recent-1", "recent-2"] },
  wake,
});
const plan = (items: ReadonlyArray<CutoverItem>): CutoverPlan => ({
  readiness: [{ id: "native", ready: true, reason: "ready" }],
  items,
  refusals: [],
});
const makeHarness = Effect.fn("CutoverTest.make")(function* (options: {
  readonly initial: CutoverPlan;
  readonly apply?: CutoverEngine.CutoverActions["Service"]["apply"];
  readonly check?: CutoverEngine.CutoverActions["Service"]["check"];
  readonly batchSize?: number;
}) {
  let current = options.initial;
  let plans = 0;
  const calls: Array<{ key: string; phase: CutoverPhase }> = [];
  const actions = CutoverEngine.CutoverActions.of({
    check:
      options.check ??
      (() =>
        Effect.sync(() => [
          ...current.readiness,
          ...current.refusals.map((entry) => ({
            id: entry.ref,
            ready: false,
            reason: entry.reason,
          })),
        ])),
    plan: Effect.sync(() => {
      plans += 1;
      return current;
    }),
    apply: (entry, phase) =>
      Effect.gen(function* () {
        calls.push({ key: entry.key, phase });
        if (options.apply) yield* options.apply(entry, phase);
      }),
  });
  const context = yield* Layer.build(
    CutoverEngine.layerWithOptions({
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      paceMillis: 0,
    }).pipe(Layer.provide(Layer.succeed(CutoverEngine.CutoverActions, actions))),
  );
  const engine = yield* CutoverEngine.HarnessCutover.pipe(Effect.provide(context));
  return {
    engine,
    actions,
    calls,
    setPlan: (next: CutoverPlan) =>
      Effect.sync(() => {
        current = next;
      }),
    planCount: () => plans,
  };
});

it.effect(
  "resumed batches use persisted readiness only and never re-read transcripts through plan",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, planCount, setPlan } = yield* makeHarness({
          initial: plan([item("one"), item("two")]),
          batchSize: 1,
          check: () => Effect.succeed([{ id: "persisted", ready: true, reason: "ready" }]),
        });
        yield* engine.run();
        yield* setPlan({
          ...plan([]),
          readiness: [],
          refusals: [{ ref: "fresh-only", reason: "must not replan" }],
        });
        yield* engine.run();
        yield* engine.run();
        assert.isTrue((yield* engine.run()).completed);
        assert.strictEqual(planCount(), 1);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect("resumed jobs fail closed without a persisted-readiness checker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* CutoverStore.CutoverStore;
      yield* store.start([item("one")], []);
      const context = yield* Layer.build(
        CutoverEngine.layerWithOptions({ paceMillis: 0 }).pipe(
          Layer.provide(
            Layer.succeed(CutoverEngine.CutoverActions, {
              plan: Effect.die("must not replan"),
              apply: () => Effect.die("must not mutate"),
            }),
          ),
        ),
      );
      const engine = yield* CutoverEngine.HarnessCutover.pipe(Effect.provide(context));
      const failure = yield* engine.run().pipe(Effect.flip);
      assert.strictEqual(failure.operation, "resume-readiness");
      assert.strictEqual((yield* store.read())!.items[0]!.attempts, 0);
    }),
  ).pipe(Effect.provide(database)),
);

it.effect("dry run and pre-run status do not create the ledger or deliver any actions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const expected = plan([item("one")]);
      const { engine, calls } = yield* makeHarness({ initial: expected });
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* engine.plan(), expected);
      assert.deepStrictEqual(yield* engine.status(), {
        active: false,
        completed: false,
        claimedThreadIds: [],
        claimedRuns: [],
        items: [],
        refusals: [],
      });
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_schema WHERE name = 'ardud_harness_cutover_items'`,
        [],
      );
    }),
  ).pipe(Effect.provide(database)),
);

it.effect(
  "readiness and per-record refusals prevent all writes, including creating the ledger",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, calls, setPlan } = yield* makeHarness({
          initial: {
            ...plan([item("one")]),
            readiness: [{ id: "native", ready: false, reason: "not configured" }],
          },
        });
        assert.deepStrictEqual((yield* engine.run()).refusals, [
          { ref: "native", reason: "not configured" },
        ]);
        yield* setPlan({
          ...plan([item("one")]),
          refusals: [{ ref: "one", reason: "children running" }],
        });
        assert.deepStrictEqual((yield* engine.run()).refusals, [
          { ref: "one", reason: "children running" },
        ]);
        const store = yield* CutoverStore.CutoverStore;
        assert.strictEqual(yield* store.read(), null);
        assert.deepStrictEqual(calls, []);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect("rechecks readiness on every resumed batch without changing existing rows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { engine, calls, setPlan, planCount } = yield* makeHarness({
        initial: plan([item("one"), item("two")]),
        batchSize: 1,
      });
      yield* engine.run();
      const before = yield* engine.status();
      yield* setPlan({
        ...plan([]),
        readiness: [{ id: "native", ready: false, reason: "offline" }],
      });
      const refused = yield* engine.run();
      assert.deepStrictEqual(refused.items, before.items);
      assert.deepStrictEqual(refused.claimedRuns, before.claimedRuns);
      assert.deepStrictEqual(refused.refusals, [{ ref: "native", reason: "offline" }]);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(planCount(), 1);
    }),
  ).pipe(Effect.provide(database)),
);

it.effect(
  "persists all thread claims before the first action and keeps the exact dependency order",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* CutoverStore.CutoverStore;
        const entries = [
          item("enable-native", "selection", false),
          item("wake"),
          item("future-default", "selection", false),
          item("idle", "thread", false),
          item("context", "card", false),
          item("complete", "finalize", false),
        ];
        let first = true;
        const { engine, calls } = yield* makeHarness({
          initial: plan(entries),
          apply: (entry, phase) =>
            Effect.gen(function* () {
              if (first) {
                first = false;
                const persisted = yield* store
                  .read()
                  .pipe(
                    Effect.mapError(
                      (cause) => new CutoverEngine.CutoverError({ operation: "test-read", cause }),
                    ),
                  );
                assert.deepStrictEqual(
                  persisted!.items.map((row) => row.key),
                  entries.map((row) => row.key),
                );
                assert.deepStrictEqual(
                  persisted!.items.map((row) => row.payload),
                  entries.map((row) => row.payload),
                );
              }
              assert.strictEqual(entry.key, `${entry.kind}:${entry.ref}`);
              if (phase === "brief") assert.strictEqual(entry.kind, "thread");
            }),
        });
        const status = yield* engine.run();
        assert.isTrue(status.completed);
        assert.isFalse(status.active);
        assert.deepStrictEqual(calls, [
          { key: "selection:enable-native", phase: "switch" },
          { key: "thread:wake", phase: "switch" },
          { key: "selection:future-default", phase: "switch" },
          { key: "thread:idle", phase: "switch" },
          { key: "card:context", phase: "switch" },
          { key: "thread:wake", phase: "brief" },
          { key: "thread:idle", phase: "brief" },
          { key: "finalize:complete", phase: "switch" },
        ]);
        assert.deepStrictEqual(status.claimedThreadIds, ["wake", "idle"]);
        yield* engine.run();
        assert.strictEqual(calls.length, 8);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "caps a batch at eight items and resumes the original snapshot instead of a changed plan",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entries = Array.from({ length: 10 }, (_, index) =>
          item(String(index), "thread", false),
        );
        const { engine, calls, setPlan } = yield* makeHarness({ initial: plan(entries) });
        const first = yield* engine.run();
        assert.strictEqual(calls.length, 8);
        assert.isTrue(first.active);
        assert.deepStrictEqual(
          first.claimedThreadIds,
          entries.map((entry) => entry.ref),
        );
        assert.deepStrictEqual(
          first.claimedRuns,
          entries.map((entry) => ({ threadId: entry.ref, runId: `source:${entry.ref}` })),
        );
        yield* setPlan(plan([item("should-not-be-added")]));
        const second = yield* engine.run();
        assert.isFalse(second.completed);
        assert.strictEqual(second.items.length, 10);
        assert.strictEqual(calls.length, 16);
        assert.isTrue((yield* engine.run()).completed);
        assert.strictEqual(calls.length, 20);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "defers drain or children without consuming attempts, then briefs only after a successful switch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let deferred = true;
        const { engine, calls } = yield* makeHarness({
          initial: plan([item("one")]),
          apply: (_entry, phase) =>
            phase === "switch" && deferred
              ? Effect.fail(new CutoverEngine.CutoverDeferred({ reason: "old run draining" }))
              : Effect.void,
        });
        for (let index = 0; index < 4; index += 1) {
          const status = yield* engine.run();
          assert.strictEqual(status.items[0]!.state, "planned");
          assert.strictEqual(status.items[0]!.attempts, 0);
          assert.strictEqual(status.items[0]!.reason, "old run draining");
          assert.deepStrictEqual(status.claimedRuns, [{ threadId: "one", runId: "source:one" }]);
        }
        assert.isFalse(calls.some((call) => call.phase === "brief"));
        deferred = false;
        assert.isTrue((yield* engine.run()).completed);
        assert.strictEqual(calls.filter((call) => call.phase === "brief").length, 1);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect("a deferred brief preserves switched progress and retries no switch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let deferred = true;
      const { engine, calls } = yield* makeHarness({
        initial: plan([item("one")]),
        apply: (_entry, phase) =>
          phase === "brief" && deferred
            ? Effect.fail(new CutoverEngine.CutoverDeferred({ reason: "owner request pending" }))
            : Effect.void,
      });
      const waiting = yield* engine.run();
      assert.strictEqual(waiting.items[0]!.state, "switched");
      assert.strictEqual(waiting.items[0]!.attempts, 0);
      deferred = false;
      assert.isTrue((yield* engine.run()).completed);
      assert.deepStrictEqual(
        calls.map((call) => call.phase),
        ["switch", "brief", "brief"],
      );
    }),
  ).pipe(Effect.provide(database)),
);

it.effect("three real failures rollback a thread, never brief it, and block finalize", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { engine, calls } = yield* makeHarness({
        initial: plan([item("one"), item("complete", "finalize", false)]),
        apply: (_entry, phase) =>
          phase === "switch"
            ? Effect.fail(new CutoverEngine.CutoverError({ operation: "switch" }))
            : Effect.void,
      });
      yield* engine.run();
      yield* engine.run();
      const failed = yield* engine.run();
      assert.strictEqual(failed.items[0]!.state, "failed");
      assert.strictEqual(failed.items[0]!.attempts, 3);
      assert.isTrue(failed.items[0]!.rolledBack);
      assert.deepStrictEqual(failed.claimedThreadIds, []);
      assert.isFalse(failed.completed);
      yield* engine.run();
      assert.deepStrictEqual(
        calls.map((call) => call.phase),
        ["switch", "switch", "switch", "rollback"],
      );
      assert.strictEqual(failed.items[1]!.attempts, 0);
    }),
  ).pipe(Effect.provide(database)),
);

it.effect("brief retries retain the switched phase without repeating the switch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { engine, calls } = yield* makeHarness({
        initial: plan([item("one")]),
        apply: (entry, phase) =>
          (entry.kind === "thread" && phase === "brief") ||
          (entry.kind === "selection" && phase === "switch")
            ? Effect.fail(new CutoverEngine.CutoverError({ operation: phase }))
            : Effect.void,
      });
      for (let index = 0; index < 7; index += 1) yield* engine.run();
      const status = yield* engine.status();
      assert.deepStrictEqual(
        calls.filter((call) => call.key === "thread:one").map((call) => call.phase),
        ["switch", "brief", "brief", "brief", "rollback"],
      );
      assert.isTrue(status.items.every((row) => row.rolledBack));
    }),
  ).pipe(Effect.provide(database)),
);

it.effect(
  "a crash after switch acknowledgement replays the deterministic key from persisted payload",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* CutoverStore.CutoverStore;
        let crash = true;
        let switches = 0;
        const nativeKeys = new Set<string>();
        const actions = CutoverEngine.CutoverActions.of({
          check: () => Effect.succeed([]),
          plan: Effect.succeed(plan([item("one")])),
          apply: (entry, phase) =>
            Effect.sync(() => {
              if (phase === "switch") {
                switches += 1;
                nativeKeys.add(entry.key);
              }
            }),
        });
        const unreliable = CutoverStore.CutoverStore.of({
          ...store,
          save: (entry) =>
            entry.state === "switched" && crash
              ? Effect.fail(
                  new CutoverStore.CutoverStoreError({ operation: "save-item", cause: "crash" }),
                )
              : store.save(entry),
        });
        const context = yield* Layer.build(
          CutoverEngine.layerWithOptions({ paceMillis: 0 }).pipe(
            Layer.provide(Layer.succeed(CutoverEngine.CutoverActions, actions)),
            Layer.provide(Layer.succeed(CutoverStore.CutoverStore, unreliable)),
          ),
        );
        const engine = yield* CutoverEngine.HarnessCutover.pipe(Effect.provide(context));
        assert.isTrue(Result.isFailure(yield* Effect.result(engine.run())));
        assert.strictEqual((yield* store.read())!.items[0]!.state, "planned");
        crash = false;
        const restarted = yield* makeHarness({ initial: plan([]), apply: actions.apply });
        assert.isTrue((yield* restarted.engine.run()).completed);
        assert.strictEqual(switches, 2);
        assert.strictEqual(nativeKeys.size, 1);
        assert.deepStrictEqual(
          restarted.calls.map((call) => call.key),
          ["thread:one", "thread:one"],
        );
      }),
    ).pipe(Effect.provide(database)),
);

it.effect("a crash after brief delivery retries only the brief with the same idempotency key", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* CutoverStore.CutoverStore;
      const original = item("one");
      let crash = true;
      const switches = new Set<string>();
      const briefKeys: Array<string> = [];
      const actions = CutoverEngine.CutoverActions.of({
        check: () => Effect.succeed([]),
        plan: Effect.succeed(plan([original])),
        apply: (entry, phase) =>
          Effect.sync(() => {
            if (phase === "switch") switches.add(entry.key);
            if (phase === "brief") briefKeys.push(entry.key);
          }),
      });
      const unreliable = CutoverStore.CutoverStore.of({
        ...store,
        save: (entry) =>
          entry.state === "briefed" && crash
            ? Effect.fail(
                new CutoverStore.CutoverStoreError({ operation: "save-item", cause: "crash" }),
              )
            : store.save(entry),
      });
      const context = yield* Layer.build(
        CutoverEngine.layerWithOptions({ paceMillis: 0 }).pipe(
          Layer.provide(Layer.succeed(CutoverEngine.CutoverActions, actions)),
          Layer.provide(Layer.succeed(CutoverStore.CutoverStore, unreliable)),
        ),
      );
      const engine = yield* CutoverEngine.HarnessCutover.pipe(Effect.provide(context));
      assert.isTrue(Result.isFailure(yield* Effect.result(engine.run())));
      const persisted = (yield* store.read())!.items[0]!;
      assert.strictEqual(persisted.state, "switched");
      assert.strictEqual(persisted.phase, "brief");
      crash = false;
      const restarted = yield* makeHarness({ initial: plan([]), apply: actions.apply });
      assert.isTrue((yield* restarted.engine.run()).completed);
      assert.strictEqual(switches.size, 1);
      assert.deepStrictEqual(briefKeys, [original.key, original.key]);
      assert.deepStrictEqual(restarted.calls, [{ key: original.key, phase: "brief" }]);
    }),
  ).pipe(Effect.provide(database)),
);

it.effect("rollback deferrals retain claims and retry restoration without another switch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let draining = true;
      const { engine, calls } = yield* makeHarness({
        initial: plan([item("one")]),
        apply: (_entry, phase) =>
          phase === "switch"
            ? Effect.fail(new CutoverEngine.CutoverError({ operation: "switch" }))
            : phase === "rollback" && draining
              ? Effect.fail(new CutoverEngine.CutoverDeferred({ reason: "native run draining" }))
              : Effect.void,
      });
      yield* engine.run();
      yield* engine.run();
      const waiting = yield* engine.run();
      assert.strictEqual(waiting.items[0]!.attempts, 3);
      assert.strictEqual(waiting.items[0]!.rollbackAttempts, 0);
      assert.isFalse(waiting.items[0]!.rolledBack);
      assert.deepStrictEqual(waiting.claimedThreadIds, ["one"]);
      draining = false;
      const restored = yield* engine.run();
      assert.isTrue(restored.items[0]!.rolledBack);
      assert.deepStrictEqual(restored.claimedThreadIds, []);
      assert.strictEqual(calls.filter((call) => call.phase === "switch").length, 3);
      assert.strictEqual(calls.filter((call) => call.phase === "rollback").length, 2);
    }),
  ).pipe(Effect.provide(database)),
);

it.effect("a failing rollback remains visible and cannot make finalize run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { engine, calls } = yield* makeHarness({
        initial: plan([item("one"), item("complete", "finalize", false)]),
        apply: (_entry, phase) => Effect.fail(new CutoverEngine.CutoverError({ operation: phase })),
      });
      for (let index = 0; index < 8; index += 1) yield* engine.run();
      const status = yield* engine.status();
      assert.strictEqual(status.items[0]!.attempts, 3);
      assert.strictEqual(status.items[0]!.rollbackAttempts, 3);
      assert.isFalse(status.items[0]!.rolledBack);
      assert.isFalse(status.completed);
      assert.deepStrictEqual(status.claimedThreadIds, ["one"]);
      assert.deepStrictEqual(
        calls.map((call) => call.phase),
        ["switch", "switch", "switch", "rollback", "rollback", "rollback"],
      );
    }),
  ).pipe(Effect.provide(database)),
);

it.effect("serializes concurrent batches without duplicate switch or brief actions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { engine, calls } = yield* makeHarness({
        initial: plan([item("one")]),
        apply: (_entry, phase) =>
          phase === "switch"
            ? Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              })
            : Effect.void,
      });
      const first = yield* engine.run().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* engine.run().pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepStrictEqual(
        calls.map((call) => call.phase),
        ["switch", "brief"],
      );
    }),
  ).pipe(Effect.provide(database)),
);

it.effect(
  "checks persisted targets even when the fresh plan no longer contains switched threads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let ready = true;
        const checked: Array<ReadonlyArray<string>> = [];
        const { engine, calls, setPlan } = yield* makeHarness({
          initial: plan([item("one"), item("two")]),
          batchSize: 1,
          check: (items) =>
            Effect.sync(() => {
              checked.push(items.map((entry) => entry.key));
              return [{ id: "persisted-route", ready, reason: "native route unavailable" }];
            }),
        });
        yield* engine.run();
        const before = yield* engine.status();
        yield* setPlan(plan([]));
        ready = false;
        const refused = yield* engine.run();
        assert.deepStrictEqual(refused.items, before.items);
        assert.deepStrictEqual(checked, [["thread:one", "thread:two"]]);
        assert.deepStrictEqual(refused.refusals, [
          { ref: "persisted-route", reason: "native route unavailable" },
        ]);
        assert.strictEqual(calls.length, 1);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect("restores stopped cards before any native wake across bounded batches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { engine, calls } = yield* makeHarness({
        initial: plan([
          item("worker"),
          item("card", "card", false),
          item("complete", "finalize", false),
        ]),
        batchSize: 1,
      });
      const first = yield* engine.run();
      assert.strictEqual(first.items[0]!.state, "switched");
      assert.deepStrictEqual(calls, [{ key: "thread:worker", phase: "switch" }]);
      yield* engine.run();
      assert.deepStrictEqual(calls.at(-1), { key: "card:card", phase: "switch" });
      yield* engine.run();
      assert.deepStrictEqual(calls.at(-1), { key: "thread:worker", phase: "brief" });
      assert.isTrue((yield* engine.run()).completed);
      assert.deepStrictEqual(calls.at(-1), { key: "finalize:complete", phase: "switch" });
    }),
  ).pipe(Effect.provide(database)),
);

it.effect(
  "a failed card blocks wakes while an exhausted thread does not block other switches",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, calls } = yield* makeHarness({
          initial: plan([item("bad"), item("good"), item("card", "card", false)]),
          apply: (entry, phase) =>
            entry.ref === "bad" || entry.kind === "card"
              ? Effect.fail(new CutoverEngine.CutoverError({ operation: phase }))
              : Effect.void,
        });
        for (let index = 0; index < 5; index += 1) yield* engine.run();
        assert.strictEqual(
          calls.filter((call) => call.key === "thread:bad" && call.phase === "switch").length,
          3,
        );
        assert.strictEqual(
          calls.filter((call) => call.key === "thread:good" && call.phase === "switch").length,
          1,
        );
        assert.isFalse(calls.some((call) => call.phase === "brief"));
        assert.isFalse((yield* engine.status()).completed);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "three failed selections restore through rollback and still block wakes and finalize",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, calls } = yield* makeHarness({
          initial: plan([
            item("default", "selection", false),
            item("worker"),
            item("card", "card", false),
            item("complete", "finalize", false),
          ]),
          apply: (entry, phase) =>
            entry.kind === "selection" && phase === "switch"
              ? Effect.fail(new CutoverEngine.CutoverError({ operation: phase }))
              : Effect.void,
        });
        yield* engine.run();
        yield* engine.run();
        const failed = yield* engine.run();
        assert.isTrue(failed.items[0]!.rolledBack);
        assert.strictEqual(failed.items[0]!.attempts, 3);
        yield* engine.run();
        assert.strictEqual(calls.filter((call) => call.key === "selection:default").length, 4);
        assert.isTrue(
          calls.some((call) => call.key === "thread:worker" && call.phase === "switch"),
        );
        assert.isFalse(
          calls.some((call) => call.phase === "brief" || call.key === "finalize:complete"),
        );
      }),
    ).pipe(Effect.provide(database)),
);

it.effect("repeated wake-cap deferrals preserve switch progress and the brief retry budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let atCapacity = true;
      const { engine, calls } = yield* makeHarness({
        initial: plan([item("worker"), item("card", "card", false)]),
        apply: (_entry, phase) =>
          phase === "brief" && atCapacity
            ? Effect.fail(
                new CutoverEngine.CutoverDeferred({ reason: "Three native starts are active." }),
              )
            : Effect.void,
      });
      for (let index = 0; index < 5; index += 1) {
        const waiting = yield* engine.run();
        assert.strictEqual(waiting.items[0]!.state, "switched");
        assert.strictEqual(waiting.items[0]!.attempts, 0);
        assert.strictEqual(waiting.items[1]!.state, "switched");
      }
      assert.strictEqual(calls.filter((call) => call.phase === "switch").length, 2);
      atCapacity = false;
      assert.isTrue((yield* engine.run()).completed);
    }),
  ).pipe(Effect.provide(database)),
);

it.effect("persisted deferrals yield to later switches, restored cards and native wakes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pending = Array.from({ length: 8 }, (_, index) => item(`pending-${index}`));
      const apply: CutoverEngine.CutoverActions["Service"]["apply"] = (entry, phase) =>
        phase === "switch" && entry.ref.startsWith("pending-")
          ? Effect.fail(new CutoverEngine.CutoverDeferred({ reason: "Owner question pending." }))
          : Effect.void;
      const first = yield* makeHarness({
        initial: plan([
          ...pending,
          item("ready"),
          item("card", "card", false),
          item("complete", "finalize", false),
        ]),
        apply,
      });
      const waiting = yield* first.engine.run();
      assert.strictEqual(first.calls.length, 8);
      assert.isTrue(
        waiting.items.slice(0, 8).every((row) => row.attempts === 0 && row.reason !== null),
      );

      const resumed = yield* makeHarness({ initial: plan([]), apply });
      const progressed = yield* resumed.engine.run();
      assert.deepStrictEqual(resumed.calls.slice(0, 3), [
        { key: "thread:ready", phase: "switch" },
        { key: "card:card", phase: "switch" },
        { key: "thread:ready", phase: "brief" },
      ]);
      assert.strictEqual(resumed.calls.length, 8);
      assert.strictEqual(progressed.items[8]!.state, "briefed");
      assert.strictEqual(progressed.items[9]!.state, "switched");
      assert.strictEqual(progressed.items[10]!.attempts, 0);
      assert.isTrue(progressed.items.slice(0, 8).every((row) => row.attempts === 0));
      assert.strictEqual(resumed.planCount(), 0);
      assert.isFalse(progressed.completed);
    }),
  ).pipe(Effect.provide(database)),
);

it.effect("deferred native wakes do not starve later unattempted briefs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pending = Array.from({ length: 8 }, (_, index) => item(`pending-${index}`));
      const { engine, calls } = yield* makeHarness({
        initial: plan([...pending, item("ready"), item("complete", "finalize", false)]),
        apply: (entry, phase) =>
          phase === "brief" && entry.ref.startsWith("pending-")
            ? Effect.fail(new CutoverEngine.CutoverDeferred({ reason: "Native start deferred." }))
            : Effect.void,
      });
      yield* engine.run();
      yield* engine.run();
      const before = calls.length;
      const progressed = yield* engine.run();
      assert.deepStrictEqual(calls.slice(before, before + 2), [
        { key: "thread:pending-7", phase: "brief" },
        { key: "thread:ready", phase: "brief" },
      ]);
      assert.strictEqual(calls.length - before, 8);
      assert.strictEqual(progressed.items[8]!.state, "briefed");
      assert.isTrue(progressed.items.slice(0, 8).every((row) => row.attempts === 0));
      assert.strictEqual(progressed.items[9]!.attempts, 0);
      assert.isFalse(progressed.completed);
    }),
  ).pipe(Effect.provide(database)),
);

it.effect(
  "finishes a frozen loading snapshot before any actions and refuses resumed import when readiness fails",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* CutoverStore.CutoverStore;
        const original = item("frozen");
        let initializing = true;
        let imports = 0;
        let ready = false;
        const actions = CutoverEngine.CutoverActions.of({
          plan: Effect.succeed(plan([])),
          check: (items) =>
            Effect.sync(() => {
              assert.deepStrictEqual(
                items.map((entry) => entry.key),
                [original.key],
              );
              return [{ id: "route", ready, reason: "offline" }];
            }),
          apply: (_entry, _phase) => Effect.sync(() => assert.isFalse(initializing)),
        });
        const loading = CutoverStore.CutoverStore.of({
          ...store,
          read: () =>
            initializing
              ? Effect.succeed({
                  items: [
                    {
                      ...original,
                      state: "planned" as const,
                      phase: "switch" as const,
                      attempts: 0,
                      reason: null,
                      rollbackAttempts: 0,
                      rolledBack: false,
                    },
                  ],
                  refusals: [],
                  initializing: true,
                })
              : store.read(),
          start: (_items, _refusals) =>
            Effect.gen(function* () {
              imports += 1;
              const snapshot = yield* store.start([original], []);
              initializing = false;
              return snapshot;
            }),
        });
        const context = yield* Layer.build(
          CutoverEngine.layerWithOptions({ paceMillis: 0 }).pipe(
            Layer.provide(Layer.succeed(CutoverEngine.CutoverActions, actions)),
            Layer.provide(Layer.succeed(CutoverStore.CutoverStore, loading)),
          ),
        );
        const engine = yield* CutoverEngine.HarnessCutover.pipe(Effect.provide(context));
        assert.isFalse((yield* engine.run()).completed);
        assert.strictEqual(imports, 0);
        ready = true;
        assert.isTrue((yield* engine.run()).completed);
        assert.strictEqual(imports, 1);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "keeps the ledger in memory across passes and loads deferred payloads only to apply them",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-engine-big-" });
        const storeContext = yield* Layer.build(
          CutoverStore.layerWithOptions({
            snapshotPath: path.join(directory, "plan.json"),
            maxInlinePayloadBytes: 256,
          }).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
        );
        const store = yield* CutoverStore.CutoverStore.pipe(Effect.provide(storeContext));
        let reads = 0;
        const counting = CutoverStore.CutoverStore.of({
          ...store,
          read: () => Effect.suspend(() => ((reads += 1), store.read())),
        });
        const target = { instanceId: "codex", model: "gpt-6.1-sol" };
        const big: CutoverItem = {
          key: "board:big",
          kind: "selection",
          ref: "big",
          payload: { scope: "board", after: { model: target, cards: "z".repeat(4000) } },
          wake: false,
        };
        const applied: Array<unknown> = [];
        const checked: Array<unknown> = [];
        const actions = CutoverEngine.CutoverActions.of({
          check: (items) =>
            Effect.sync(() => {
              checked.push(items.find((entry) => entry.key === "board:big")?.payload);
              return [];
            }),
          plan: Effect.succeed(plan([big, item("one"), item("two")])),
          apply: (entry, phase) =>
            Effect.sync(() => {
              if (entry.key === "board:big") applied.push({ phase, payload: entry.payload });
            }),
        });
        const context = yield* Layer.build(
          CutoverEngine.layerWithOptions({ paceMillis: 0, batchSize: 1 }).pipe(
            Layer.provide(Layer.succeed(CutoverEngine.CutoverActions, actions)),
            Layer.provide(Layer.succeed(CutoverStore.CutoverStore, counting)),
          ),
        );
        const engine = yield* CutoverEngine.HarnessCutover.pipe(Effect.provide(context));
        let state = yield* engine.run();
        for (let pass = 0; pass < 10 && !state.completed; pass++) state = yield* engine.run();
        assert.isTrue(state.completed);
        // The full payload reached apply exactly once; status and readiness saw only selection leaves.
        assert.deepStrictEqual(applied, [{ phase: "switch", payload: big.payload }]);
        for (const seen of checked) assert.deepStrictEqual(seen, [target]);
        assert.ok(!JSON.stringify(state).includes("zzzz"));
        // One read for the first pass and one inside start(); every later pass used the cache.
        assert.isAtMost(reads, 2);
        yield* engine.status();
        assert.isAtMost(reads, 2);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
