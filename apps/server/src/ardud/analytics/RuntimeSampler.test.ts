import { assert, describe, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import * as Analytics from "./Analytics.ts";
import * as RuntimeSampler from "./RuntimeSampler.ts";

type Snapshot = Effect.Success<
  ReturnType<NonNullable<ProviderSessionManager.ProviderSessionManagerV2Shape["runtimeSnapshot"]>>
>;
const host = { load1: 12, load5: 8, load15: 4, rssMiB: 900, heapUsedMiB: 500 };
const snapshot: Snapshot = {
  turns: [
    { threadId: "work", provider: "codex", model: "sol" },
    { threadId: "review", provider: "codex", model: "sol" },
    { threadId: "evaluator", provider: "claudeAgent", model: "opus" },
    { threadId: "child", provider: "claudeAgent", model: "opus" },
    { threadId: "plain", provider: "opencode", model: "custom" },
    { threadId: "scheduled", provider: "codex", model: "sol" },
    { threadId: "discussion", provider: "codex", model: "sol" },
  ],
  providerSessions: { codex: 1, claudeAgent: 2, opencode: 1 },
};
const caller: NonNullable<KanbanStore.KanbanStoreShape["callerAnalytics"]> = (id) => {
  switch (id) {
    case "work":
      return { callerRole: "work" };
    case "review":
      return { callerRole: "review" };
    case "evaluator":
      return { callerRole: "evaluator" };
    case "child":
      return { callerRole: "work", callerKind: "delegated_child" };
    case "discussion":
      return { callerRole: "discussion" };
    default:
      return undefined;
  }
};

// Only the documented memory interfaces are available. Any hidden service access fails.
function only<A extends object>(value: A): A {
  return new Proxy(value, {
    get(target, key, receiver) {
      if (!(key in target)) throw new Error(`Unexpected dependency: ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
}
function dependencies(record: (row: AnalyticsEvent) => Effect.Effect<void>, state = snapshot) {
  return Layer.mergeAll(
    Layer.succeed(
      ProviderSessionManager.ProviderSessionManagerV2,
      only(
        ProviderSessionManager.ProviderSessionManagerV2.of({
          runtimeSnapshot: () => Effect.succeed(state),
          shutdown: Effect.die("not used"),
          sweepOrphanedThreads: () => Effect.die("not used"),
          observeThreadSessionUpdates: () => Effect.die("not used"),
          refreshThreadSessionUpdates: () => Effect.die("not used"),
          open: () => Effect.die("not used"),
          get: () => Effect.die("not used"),
          isLive: () => Effect.die("not used"),
          close: () => Effect.die("not used"),
          closeInstance: () => Effect.die("not used"),
          release: () => Effect.die("not used"),
          stopBackgroundWork: () => Effect.die("not used"),
          detach: () => Effect.die("not used"),
        }),
      ),
    ),
    // The sampler consumes only callerAnalytics; all SQL-backed store methods are absent.
    Layer.succeedContext(
      Context.make(
        KanbanStore.KanbanStore,
        only({ callerAnalytics: caller }) as KanbanStore.KanbanStoreShape,
      ),
    ),
    Layer.succeed(
      Analytics.Analytics,
      only(
        Analytics.Analytics.of({
          record,
          flush: Effect.die("not used"),
          ingest: () => Effect.die("not used"),
          read: () => Effect.die("not used"),
        }),
      ),
    ),
  );
}

describe("RuntimeSampler", () => {
  it("counts provider instances, models and each known origin, including unknowns", () => {
    const props = RuntimeSampler.runtimeSampleProps(snapshot, caller, host);
    assert.deepEqual(props.runningTurns, {
      total: 7,
      byProvider: { codex: 4, claudeAgent: 2, opencode: 1 },
      byModel: { sol: 4, opus: 2, custom: 1, other: 0 },
    });
    assert.deepEqual(props.runningByOrigin, {
      boardWork: 1,
      boardReview: 1,
      boardEvaluator: 1,
      delegatedChild: 1,
      scheduledTask: 0,
      other: 3,
    });
    assert.deepEqual(props.providerSessions, snapshot.providerSessions);
    assert.deepEqual(props.host, host);
    assert.isFalse("queuedRuns" in props);
  });

  it.each(["gpt-6.1-sol", "cx/gpt-6.1-sol[1m]", "vendor:My Model (preview)"])(
    "preserves model and provider ids: %s",
    (model) => {
      const props = RuntimeSampler.runtimeSampleProps(
        {
          turns: [{ threadId: "plain", provider: "custom:provider[2]", model }],
          providerSessions: {},
        },
        caller,
        host,
      );
      assert.equal(props.runningTurns.byModel[model], 1);
      assert.equal(props.runningTurns.byProvider["custom:provider[2]"], 1);
    },
  );

  it("keeps the top ten models with deterministic ties and lossless other", () => {
    const turns = Array.from({ length: 12 }, (_, index) => ({
      threadId: "plain",
      provider: "codex",
      model: `model-${String(index).padStart(2, "0")}`,
    }));
    const props = RuntimeSampler.runtimeSampleProps(
      { turns: [...turns, turns[11]!, { ...turns[0]!, model: "other" }], providerSessions: {} },
      caller,
      host,
    );
    assert.equal(Object.keys(props.runningTurns.byModel).length, 11);
    assert.equal(props.runningTurns.byModel["model-11"], 2);
    assert.equal(props.runningTurns.byModel.other, 3);
    assert.equal(
      Object.values(props.runningTurns.byModel).reduce((a, b) => a + b, 0),
      14,
    );
  });

  it.effect("samples with no SQL or filesystem service and measures real elapsed time", () =>
    Effect.gen(function* () {
      const rows: AnalyticsEvent[] = [];
      const context = yield* Layer.build(
        RuntimeSampler.layer.pipe(
          Layer.provide(
            dependencies(
              (row) =>
                Effect.sync(() => {
                  rows.push(row);
                }),
              { ...snapshot, turns: Array.from({ length: 50 }, () => snapshot.turns).flat() },
            ),
          ),
        ),
      );
      const sampler = Context.get(context, RuntimeSampler.RuntimeSampler);
      for (let i = 0; i < 100; i++) yield* sampler.sample();
      assert.equal(rows.length, 100);
      for (const row of rows) {
        assert.equal(row.kind, "server.runtime_sample");
        assert.equal(row.surface, "server");
        assert.isAbove(row.props!.sampleMs!, 0);
        assert.isAtLeast(row.props!.host!.rssMiB, 0);
        assert.isAtLeast(row.props!.host!.heapUsedMiB, 0);
      }
      const timings = rows.map((row) => row.props!.sampleMs!).sort((a, b) => a - b);
      // @effect-diagnostics-next-line globalConsoleInEffect:off -- This test exports measured evidence to the offbox check log.
      console.info(JSON.stringify({ sample: rows[99], sampleMsP99: timings[98] }));
    }),
  );

  it.effect("records every 60 seconds and stops with its scope", () =>
    Effect.gen(function* () {
      const rows = yield* Queue.unbounded<AnalyticsEvent>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            RuntimeSampler.layerScheduled.pipe(
              Layer.provide(dependencies((row) => Queue.offer(rows, row).pipe(Effect.asVoid))),
            ),
          );
          yield* Queue.take(rows);
          yield* TestClock.adjust("59 seconds");
          assert.equal(yield* Queue.size(rows), 0);
          yield* TestClock.adjust("1 second");
          assert.equal((yield* Queue.take(rows)).kind, "server.runtime_sample");
          yield* TestClock.adjust("60 seconds");
          yield* Queue.take(rows);
        }),
      );
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.size(rows), 0);
    }),
  );
});
