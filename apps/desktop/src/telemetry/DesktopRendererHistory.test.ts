import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";
import * as NodeEvents from "node:events";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "./DesktopRendererHistory.ts";

const rowSchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Number,
    event: Schema.String,
    rendererPid: Schema.NullOr(Schema.Number),
    cpu: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          percentMean: Schema.NullOr(Schema.Number),
          cumulativeSeconds: Schema.optional(Schema.NullOr(Schema.Number)),
          idleWakeupsPerSecond: Schema.optional(Schema.NullOr(Schema.Number)),
          percentMax: Schema.optional(Schema.NullOr(Schema.Number)),
          sampleCount: Schema.optional(Schema.Number),
        }),
      ),
    ),
    window: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          visible: Schema.optional(Schema.Boolean),
          focused: Schema.optional(Schema.Boolean),
          minimized: Schema.optional(Schema.Boolean),
          throttled: Schema.optional(Schema.Boolean),
          visiblePercent: Schema.optional(Schema.NullOr(Schema.Number)),
          focusedPercent: Schema.optional(Schema.NullOr(Schema.Number)),
          sampleCount: Schema.optional(Schema.Number),
        }),
      ),
    ),
    memory: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          startWorkingSetBytes: Schema.optional(Schema.Number),
          endWorkingSetBytes: Schema.optional(Schema.Number),
          peakWorkingSetBytes: Schema.optional(Schema.Number),
        }),
      ),
    ),
    hourStartedAtUnixMs: Schema.optional(Schema.Number),
    sampleCount: Schema.optional(Schema.Number),
  }),
);
const decodeRow = Schema.decodeUnknownEffect(rowSchema);

const makeFixture = Effect.fn("test.makeRendererHistoryFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "renderer-history-cpu-" });
  const written = yield* Deferred.make<void>();
  let pid = 7_001;
  let visible = true;
  let focused = true;
  let minimized = false;
  let throttled = false;
  let windowReads = 0;
  const contents = Object.assign(new NodeEvents.EventEmitter(), {
    id: 1,
    getOSProcessId: () => pid,
    isDestroyed: () => false,
    getBackgroundThrottling: () => throttled,
    getURL: () => {
      throw new Error("must not read URLs");
    },
    getTitle: () => {
      throw new Error("must not read titles");
    },
  }) as unknown as Electron.WebContents;
  const window = {
    isDestroyed: () => false,
    isVisible: () => {
      windowReads++;
      return visible;
    },
    isFocused: () => focused,
    isMinimized: () => minimized,
  } as Electron.BaseWindow;
  const metric: Electron.ProcessMetric = {
    pid,
    type: "Tab",
    creationTime: 1_000,
    cpu: { percentCPUUsage: 999, cumulativeCPUUsage: 10.25, idleWakeupsPerSecond: 2.5 },
    memory: { workingSetSize: 2_048, peakWorkingSetSize: 99_999 },
  };
  const layer = DesktopRendererHistory.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            logDir: directory,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          writeFile: (path, bytes, options) =>
            fs
              .writeFile(path, bytes, options)
              .pipe(Effect.tap(() => Deferred.succeed(written, undefined))),
        }),
      ),
    ),
  );
  return {
    contents,
    window,
    metric,
    layer,
    setPid: (next: number) => {
      pid = next;
      metric.pid = next;
    },
    hide: () => {
      visible = false;
      focused = false;
      minimized = true;
      throttled = true;
    },
    windowReads: () => windowReads,
    written: Deferred.await(written),
    seedLegacy: fs.writeFileString(
      `${directory}/renderer-history.ndjson`,
      '{"version":1,"event":"sample","rendererPid":7001,"memory":{"workingSetBytes":1024,"peakWorkingSetBytes":2048}}\n',
    ),
    read: () =>
      fs
        .readFileString(`${directory}/renderer-history.ndjson`)
        .pipe(
          Effect.flatMap((text) =>
            Effect.forEach(text.trim().split("\n"), (row) => decodeRow(row)),
          ),
        ),
  };
});

describe("renderer history CPU and hours", () => {
  it.effect(
    "records interval CPU, native hidden/minimized state, UTC hours and the two-minute floor",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* Effect.gen(function* () {
          const history = yield* DesktopRendererHistory.DesktopRendererHistory;
          yield* history.register(fixture.contents, { surface: "main" }, fixture.window);
          yield* history.recordMetrics([fixture.metric]);
          const reads = fixture.windowReads();
          yield* TestClock.adjust(Duration.minutes(1));
          yield* history.recordMetrics([fixture.metric]);
          assert.equal(fixture.windowReads(), reads);
          fixture.hide();
          yield* TestClock.adjust(Duration.minutes(1));
          fixture.metric.cpu.cumulativeCPUUsage = 70.25;
          fixture.metric.memory.workingSetSize = 4_096;
          yield* history.recordMetrics([fixture.metric]);
          yield* TestClock.adjust(Duration.minutes(2));
          fixture.metric.cpu.cumulativeCPUUsage = 190.25;
          fixture.metric.memory.workingSetSize = 3_072;
          yield* history.recordMetrics([fixture.metric]);
          yield* TestClock.adjust(Duration.minutes(56));
          yield* history.recordMetrics([fixture.metric]);
          yield* history.shutdown;
          yield* history.shutdown;
        }).pipe(Effect.provide(fixture.layer));
        const rows = yield* fixture.read();
        const samples = rows.filter((row) => row.event === "sample");
        assert.equal(samples.length, 4);
        assert.equal(samples[0]?.version, 2);
        assert.isNull(samples[0]?.cpu?.percentMean);
        assert.deepEqual(samples[1]?.cpu, {
          percentMean: 50,
          cumulativeSeconds: 70.25,
          idleWakeupsPerSecond: 2.5,
        });
        assert.equal(samples[2]?.cpu?.percentMean, 100);
        assert.deepEqual(samples[0]?.window, {
          visible: true,
          focused: true,
          minimized: false,
          throttled: false,
        });
        assert.deepEqual(samples[1]?.window, {
          visible: false,
          focused: false,
          minimized: true,
          throttled: true,
        });
        const hours = rows.filter((row) => row.event === "hour");
        assert.equal(hours.length, 2);
        assert.equal(hours[0]?.hourStartedAtUnixMs, 0);
        assert.equal(hours[0]?.sampleCount, 3);
        assert.deepEqual(hours[0]?.cpu, { percentMean: 75, percentMax: 100, sampleCount: 2 });
        assert.deepEqual(hours[0]?.memory, {
          startWorkingSetBytes: 2_048 * 1_024,
          endWorkingSetBytes: 3_072 * 1_024,
          peakWorkingSetBytes: 4_096 * 1_024,
        });
        assert.deepEqual(hours[0]?.window, {
          visiblePercent: 100 / 3,
          focusedPercent: 100 / 3,
          sampleCount: 3,
        });
        assert.equal(hours[1]?.hourStartedAtUnixMs, 3_600_000);
        assert.equal(hours[1]?.sampleCount, 1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    "pid",
    "creation-time",
    "counter-reset",
    "invalid-counter",
    "missing-metric",
    "crash",
  ] as const)("does not reuse a CPU baseline after %s", (scenario) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.gen(function* () {
        const history = yield* DesktopRendererHistory.DesktopRendererHistory;
        yield* history.register(fixture.contents, { surface: "main" }, fixture.window);
        yield* history.recordMetrics([fixture.metric]);
        yield* TestClock.adjust(Duration.minutes(2));
        fixture.metric.cpu.cumulativeCPUUsage = 70.25;
        if (scenario === "pid") fixture.setPid(7_002);
        if (scenario === "creation-time") fixture.metric.creationTime = 2_000;
        if (scenario === "counter-reset") fixture.metric.cpu.cumulativeCPUUsage = 1;
        if (scenario === "invalid-counter") fixture.metric.cpu.cumulativeCPUUsage = NaN;
        if (scenario === "crash") {
          fixture.contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
          fixture.contents.emit("dom-ready");
        }
        yield* history.recordMetrics(scenario === "missing-metric" ? [] : [fixture.metric]);
        if (scenario === "missing-metric" || scenario === "invalid-counter") {
          yield* TestClock.adjust(Duration.minutes(2));
          fixture.metric.cpu.cumulativeCPUUsage = 100;
          yield* history.recordMetrics([fixture.metric]);
        }
        yield* history.shutdown;
      }).pipe(Effect.provide(fixture.layer));
      const rows = yield* fixture.read();
      const samples = rows.filter((row) => row.event === "sample");
      for (const sample of samples) assert.isNull(sample.cpu?.percentMean ?? null);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "deduplicates shared processes and keeps unknown window observations out of percentages",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const second = Object.assign(new NodeEvents.EventEmitter(), {
          id: 2,
          getOSProcessId: () => 7_001,
          isDestroyed: () => false,
        }) as unknown as Electron.WebContents;
        yield* Effect.gen(function* () {
          const history = yield* DesktopRendererHistory.DesktopRendererHistory;
          yield* history.register(second, { surface: "preview" });
          yield* history.register(fixture.contents, { surface: "main" }, fixture.window);
          yield* history.recordMetrics([fixture.metric]);
          yield* TestClock.adjust(Duration.minutes(2));
          fixture.metric.cpu.cumulativeCPUUsage = 70.25;
          second.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
          second.emit("dom-ready");
          yield* history.recordMetrics([fixture.metric]);
          yield* history.shutdown;
        }).pipe(Effect.provide(fixture.layer));
        const rows = yield* fixture.read();
        const hours = rows.filter((row) => row.event === "hour");
        assert.equal(hours.length, 1);
        assert.equal(hours[0]?.sampleCount, 2);
        assert.deepEqual(hours[0]?.cpu, { percentMean: 50, percentMax: 50, sampleCount: 1 });
        assert.deepEqual(hours[0]?.window, {
          visiblePercent: 100,
          focusedPercent: 100,
          sampleCount: 2,
        });
        assert.isNull(rows.find((row) => row.event === "sample" && row.window === null)?.window);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads retained version-1 rows without CPU or window fields", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.seedLegacy;
      yield* Effect.gen(function* () {
        const history = yield* DesktopRendererHistory.DesktopRendererHistory;
        yield* history.register(fixture.contents, { surface: "main" }, fixture.window);
        yield* fixture.written;
        yield* history.shutdown;
      }).pipe(Effect.provide(fixture.layer));
      const rows = yield* fixture.read();
      assert.equal(rows.length, 2);
      const row = rows[0]!;
      assert.equal(rows[1]?.version, 2);
      assert.equal(row.version, 1);
      assert.isUndefined(row.cpu);
      assert.isUndefined(row.window);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
