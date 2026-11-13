import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as Analytics from "./Analytics.ts";

const day = "2026-11-13";
const ts = `${day}T12:00:00.000Z`;
const event = (kind: string): AnalyticsEvent => ({ ts, kind, surface: "web", route: "board" });
const counter = (name: string, reason?: string) =>
  Metric.snapshot.pipe(
    Effect.map((snapshots) =>
      snapshots.reduce(
        (total, metric) =>
          total +
          (metric.id === name &&
          metric.type === "Counter" &&
          (reason === undefined || metric.attributes?.reason === reason)
            ? Number(metric.state.count)
            : 0),
        0,
      ),
    ),
  );
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(ts)));
  const config = Context.get(
    yield* Layer.build(ServerConfig.layerTest(".", { prefix: "analytics-storage-" })),
    ServerConfig.ServerConfig,
  );
  const fs = yield* FileSystem.FileSystem;
  const directory = `${config.logsDir}/analytics`;
  yield* fs.makeDirectory(directory, { recursive: true });
  return { fs, config, directory, active: `${directory}/${day}.ndjson` };
});
function open(
  setup: Effect.Success<typeof fixture>,
  fs = setup.fs,
  options: Partial<Analytics.AnalyticsOptions> = {},
) {
  return Layer.build(
    Analytics.layerWith(options).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
      Layer.provide(Layer.succeed(ServerConfig.ServerConfig, setup.config)),
    ),
  ).pipe(Effect.map((context) => Context.get(context, Analytics.Analytics)));
}
const failure = (method: string, file: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: file,
  });

const transientFailures = [
  { name: "stat before append", operation: "stat", prefix: "none" },
  { name: "rotation before append", operation: "rotate", prefix: "none" },
  { name: "append before writing bytes", operation: "append", prefix: "none" },
  { name: "append after a partial suffix", operation: "append", prefix: "partial" },
  { name: "append after writing its entire chunk", operation: "append", prefix: "all" },
] as const;

describe("Analytics storage failures", () => {
  it.effect.each(transientFailures)("retains accepted events after $name", (row) =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const seeds = [event("seed.0"), event("seed.1")];
      const initial = seeds.map((entry) => `${JSON.stringify(entry)}\n`).join("");
      yield* setup.fs.writeFileString(setup.active, initial);
      const failed = yield* Deferred.make<void>();
      let injected = false;
      const inject = Effect.gen(function* () {
        injected = true;
        yield* Deferred.succeed(failed, undefined);
        return yield* failure(row.operation, setup.active);
      });
      const fs = FileSystem.FileSystem.of({
        ...setup.fs,
        stat: (file) =>
          !injected && row.operation === "stat" && file === setup.active
            ? inject
            : setup.fs.stat(file),
        rename: (source, target) =>
          !injected && row.operation === "rotate" && source === setup.active
            ? inject
            : setup.fs.rename(source, target),
        writeFileString: (file, data, options) =>
          !injected && row.operation === "append" && file === setup.active
            ? Effect.gen(function* () {
                if (row.prefix !== "none")
                  yield* setup.fs.writeFileString(
                    file,
                    row.prefix === "all" ? data : data.slice(0, data.indexOf("\n") + 10),
                    options,
                  );
                return yield* inject;
              })
            : setup.fs.writeFileString(file, data, options),
      });
      const analytics = yield* open(setup, fs, {
        maxFileBytes: new TextEncoder().encode(initial).byteLength,
      });
      const accepted = [event("item.0"), event("item.1"), event("item.2")];
      yield* analytics.ingest({ events: accepted });
      yield* Deferred.await(failed);
      const result = yield* analytics.read({ day });
      for (const entry of [...seeds, ...accepted])
        assert.include(
          result.samples.map(({ kind }) => kind),
          entry.kind,
        );
      assert.equal(yield* counter("t3_analytics_dropped_events_total"), 0);
      if (row.operation === "append")
        assert.equal(yield* counter("t3_analytics_ambiguous_appends_total"), 1);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );

  it.effect.each(["stat", "append"] as const)(
    "bounds held plus pending capacity while %s is blocked",
    (operation) =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let first = true;
        const blocked = Effect.gen(function* () {
          first = false;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return yield* failure(operation, setup.active);
        });
        const fs = FileSystem.FileSystem.of({
          ...setup.fs,
          stat: (file) =>
            operation === "stat" && first && file === setup.active ? blocked : setup.fs.stat(file),
          writeFileString: (file, data, options) =>
            operation === "append" && first && file === setup.active
              ? blocked
              : setup.fs.writeFileString(file, data, options),
        });
        const analytics = yield* open(setup, fs, { queueCapacity: 3 });
        yield* Effect.gen(function* () {
          yield* analytics.ingest({ events: [event("item.0"), event("item.1")] });
          yield* Deferred.await(entered);
          yield* analytics.ingest({ events: [event("item.2")] });
          yield* analytics.record(event("drop.0"));
          assert.equal(
            (yield* analytics.ingest({ events: [event("drop.1")] }).pipe(Effect.flip)).operation,
            "ingest",
          );
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        const result = yield* analytics.read({ day });
        assert.deepStrictEqual(
          result.samples.map(({ kind }) => kind),
          ["item.2", "item.1", "item.0"],
        );
        assert.equal(
          result.samples.length + (yield* counter("t3_analytics_dropped_events_total", "capacity")),
          4,
        );
        assert.equal(yield* counter("t3_analytics_dropped_events_total", "capacity"), 1);
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      ),
  );

  it.effect("writes a contiguous prefix when a larger event cannot fit before a smaller one", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const seed = { ...event("seed.0"), threadId: "s".repeat(80) };
      const accepted = [
        event("item.0"),
        { ...event("item.1"), threadId: "b".repeat(200) },
        event("item.2"),
      ];
      const encoded = (entry: AnalyticsEvent) =>
        new TextEncoder().encode(`${JSON.stringify(entry)}\n`).byteLength;
      const cap = encoded(seed) + encoded(accepted[0]!) + encoded(accepted[2]!);
      assert.isAtMost(encoded(accepted[1]!), cap);
      assert.isAbove(encoded(seed) + encoded(accepted[0]!) + encoded(accepted[1]!), cap);
      yield* setup.fs.writeFileString(setup.active, `${JSON.stringify(seed)}\n`);
      const analytics = yield* open(setup, setup.fs, { maxFileBytes: cap });
      yield* analytics.ingest({ events: accepted });
      const result = yield* analytics.read({ day });
      assert.deepStrictEqual(
        result.samples.map(({ kind }) => kind),
        ["item.2", "item.1", "item.0", "seed.0"],
      );
      for (const file of (yield* setup.fs.readDirectory(setup.directory)).filter((name) =>
        name.endsWith(".ndjson"),
      )) {
        assert.isAtMost(Number((yield* setup.fs.stat(`${setup.directory}/${file}`)).size), cap);
      }
      assert.equal(yield* counter("t3_analytics_dropped_events_total"), 0);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );

  it.effect("retries on the timer without a new arrival and never spins on a queued wake", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const failed = yield* Deferred.make<void>();
      const written = yield* Deferred.make<void>();
      let failures = 0;
      const fs = FileSystem.FileSystem.of({
        ...setup.fs,
        stat: (file) =>
          file === setup.active && failures++ === 0
            ? Effect.gen(function* () {
                yield* Deferred.succeed(failed, undefined);
                return yield* failure("stat", file);
              })
            : setup.fs.stat(file),
        writeFileString: (file, data, options) =>
          setup.fs
            .writeFileString(file, data, options)
            .pipe(
              Effect.tap(() =>
                file === setup.active ? Deferred.succeed(written, undefined) : Effect.void,
              ),
            ),
      });
      const analytics = yield* open(setup, fs);
      yield* analytics.ingest({ events: [event("item.0")] });
      yield* Deferred.await(failed);
      yield* analytics.ingest({ events: [event("item.1")] });
      yield* TestClock.adjust("4 seconds");
      assert.equal(failures, 1);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(written);
      assert.equal((yield* analytics.read({ day })).samples.length, 2);
      assert.equal(yield* counter("t3_analytics_dropped_events_total"), 0);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );

  it.effect("counts retry exhaustion and frees capacity instead of leaving a poison queue", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const failed = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const exhausted = yield* Deferred.make<void>();
      const dropped = yield* Deferred.make<void>();
      const logger = Logger.make(({ message }) => {
        const values = Array.isArray(message) ? message : [message];
        if (
          values.some(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              "reason" in value &&
              value.reason === "retry-limit",
          )
        )
          Deferred.doneUnsafe(dropped, Effect.void);
      });
      let broken = true;
      let attempts = 0;
      const fs = FileSystem.FileSystem.of({
        ...setup.fs,
        stat: (file) =>
          broken && file === setup.active
            ? Effect.gen(function* () {
                attempts++;
                yield* Deferred.succeed(failed, undefined);
                if (attempts === 2) yield* Deferred.succeed(second, undefined);
                if (attempts === 3) yield* Deferred.succeed(exhausted, undefined);
                return yield* failure("stat", file);
              })
            : setup.fs.stat(file),
      });
      const analytics = yield* open(setup, fs, { queueCapacity: 2 }).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );
      yield* analytics.ingest({ events: [event("item.0"), event("item.1")] });
      yield* Deferred.await(failed);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(second);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(exhausted);
      yield* Deferred.await(dropped);
      assert.equal(attempts, 3);
      assert.equal(yield* counter("t3_analytics_dropped_events_total", "retry-limit"), 2);
      yield* TestClock.adjust("1 minute");
      assert.equal(attempts, 3);
      broken = false;
      yield* analytics.ingest({ events: [event("item.2"), event("item.3")] });
      assert.equal((yield* analytics.read({ day })).samples.length, 2);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );

  it.effect.each([true, false])(
    "accounts for the retained queue on shutdown (recovery=%s)",
    (recover) =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const scope = yield* Scope.make();
        const failed = yield* Deferred.make<void>();
        let broken = true;
        const fs = FileSystem.FileSystem.of({
          ...setup.fs,
          stat: (file) =>
            broken && file === setup.active
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(failed, undefined);
                  return yield* failure("stat", file);
                })
              : setup.fs.stat(file),
        });
        const analytics = yield* open(setup, fs).pipe(Effect.provideService(Scope.Scope, scope));
        yield* analytics.ingest({ events: [event("item.0"), event("item.1")] });
        yield* Deferred.await(failed);
        broken = !recover;
        yield* Scope.close(scope, Exit.void);
        const persisted = (yield* setup.fs.exists(setup.active))
          ? (yield* setup.fs.readFileString(setup.active)).trim().split("\n").length
          : 0;
        const dropped = yield* counter("t3_analytics_dropped_events_total", "shutdown");
        assert.equal(persisted + dropped, 2);
        assert.equal(dropped, recover ? 0 : 2);
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      ),
  );

  it.effect("bounds shutdown while an append never completes", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const scope = yield* Scope.make();
      const entered = yield* Deferred.make<void>();
      const fs = FileSystem.FileSystem.of({
        ...setup.fs,
        writeFileString: (file, data, options) =>
          file === setup.active
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : setup.fs.writeFileString(file, data, options),
      });
      const analytics = yield* open(setup, fs).pipe(Effect.provideService(Scope.Scope, scope));
      yield* analytics.ingest({ events: [event("item.0"), event("item.1")] });
      yield* Deferred.await(entered);
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(closing);
      assert.equal(yield* counter("t3_analytics_dropped_events_total", "shutdown"), 2);
      assert.equal(yield* counter("t3_analytics_ambiguous_appends_total"), 1);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );

  it.effect("counts expired queued events and logs only bounded drop diagnostics", () => {
    const warnings: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(message);
    });
    return Effect.gen(function* () {
      const setup = yield* fixture;
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(`${day}T23:59:59.000Z`)));
      const failed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fs = FileSystem.FileSystem.of({
        ...setup.fs,
        stat: (file) =>
          file === setup.active
            ? Effect.gen(function* () {
                yield* Deferred.succeed(failed, undefined);
                yield* Deferred.await(release);
                return yield* failure("stat", file);
              })
            : setup.fs.stat(file),
      });
      const analytics = yield* open(setup, fs, { retentionDays: 1 });
      yield* analytics.ingest({ events: [event("item.0"), event("item.1")] });
      yield* Deferred.await(failed);
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.succeed(release, undefined);
      yield* analytics.read({ day: "2026-11-14" });
      assert.equal(yield* counter("t3_analytics_dropped_events_total", "retention"), 2);
      assert.deepStrictEqual(warnings, [
        ["Analytics events dropped.", { count: 2, reason: "retention" }],
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    );
  });

  it.effect(
    "aggregates capacity warnings for a minute and flushes the remainder on shutdown",
    () => {
      const warnings: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        warnings.push(message);
      });
      return Effect.gen(function* () {
        const setup = yield* fixture;
        const scope = yield* Scope.make();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const fs = FileSystem.FileSystem.of({
          ...setup.fs,
          writeFileString: (file, data, options) =>
            file === setup.active
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  yield* setup.fs.writeFileString(file, data, options);
                })
              : setup.fs.writeFileString(file, data, options),
        });
        const analytics = yield* open(setup, fs, { queueCapacity: 1 }).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        yield* analytics.ingest({ events: [event("item.0")] });
        yield* Deferred.await(entered);
        yield* Effect.gen(function* () {
          for (let index = 0; index < 50; index++) yield* analytics.record(event("drop.0"));
          yield* TestClock.adjust("59 seconds");
          yield* analytics.record(event("drop.0"));
          assert.lengthOf(warnings, 1);
          yield* TestClock.adjust("1 second");
          yield* analytics.record(event("drop.0"));
          for (let index = 0; index < 3; index++) yield* analytics.record(event("drop.0"));
          assert.lengthOf(warnings, 2);
          assert.equal(yield* counter("t3_analytics_dropped_events_total", "capacity"), 55);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Scope.close(scope, Exit.void);
        assert.deepStrictEqual(warnings, [
          ["Analytics events dropped.", { count: 1, reason: "capacity" }],
          ["Analytics events dropped.", { count: 51, reason: "capacity" }],
          ["Analytics events dropped.", { count: 3, reason: "capacity" }],
        ]);
      }).pipe(
        Effect.provide(
          Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
        ),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      );
    },
  );
});

const seedLine = JSON.stringify(event("seed"));
const restartTails = [
  { name: "empty", contents: "", total: 1, invalid: 0 },
  { name: "LF", contents: `${seedLine}\n`, total: 2, invalid: 0 },
  { name: "CRLF", contents: `${seedLine}\r\n`, total: 2, invalid: 0 },
  { name: "CR only", contents: `${seedLine}\r`, total: 2, invalid: 0 },
  { name: "complete JSON without LF", contents: seedLine, total: 2, invalid: 0 },
  { name: "partial JSON", contents: `${seedLine}\n{"ts":`, total: 2, invalid: 1 },
  { name: "garbage", contents: `${seedLine}\nbroken`, total: 2, invalid: 1 },
  { name: "oversized partial", contents: `${seedLine}\n${"x".repeat(9000)}`, total: 2, invalid: 1 },
];
it.effect.each(restartTails)(
  "restart tail $name keeps warm and cold counts equal after append",
  (row) =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.fs.writeFileString(setup.active, row.contents);
      const warm = yield* Effect.scoped(
        Effect.gen(function* () {
          const analytics = yield* open(setup);
          yield* analytics.read({ day });
          yield* analytics.record(event("appended"));
          return yield* analytics.read({ day });
        }),
      );
      const cold = yield* Effect.scoped(
        Effect.gen(function* () {
          const analytics = yield* open(setup);
          return yield* analytics.read({ day });
        }),
      );
      assert.equal(warm.rollup.total, row.total);
      assert.equal(cold.rollup.total, row.total);
      assert.deepEqual(cold.rollup.kindCounts, warm.rollup.kindCounts);
      assert.equal(cold.rollup.invalidLines, row.invalid);
      assert.equal(warm.rollup.invalidLines, row.invalid);
      assert.equal(cold.rollup.kindCounts.appended, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([1, 2])(
  "rotates an unterminated tail with %s retained segments at the exact event size",
  (maxSegmentsPerDay) =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.fs.writeFileString(setup.active, seedLine);
      const appended = event("appended");
      const maxFileBytes = new TextEncoder().encode(`${JSON.stringify(appended)}\n`).byteLength;
      const analytics = yield* open(setup, setup.fs, { maxSegmentsPerDay, maxFileBytes });
      yield* analytics.record(appended);
      const result = yield* analytics.read({ day });
      assert.equal(result.rollup.total, maxSegmentsPerDay);
      assert.equal(result.rollup.kindCounts.appended, 1);
      assert.equal(result.rollup.invalidLines, 0);
      for (const file of (yield* setup.fs.readDirectory(setup.directory)).filter((name) =>
        name.endsWith(".ndjson"),
      )) {
        assert.isAtMost(
          Number((yield* setup.fs.stat(`${setup.directory}/${file}`)).size),
          maxFileBytes,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
