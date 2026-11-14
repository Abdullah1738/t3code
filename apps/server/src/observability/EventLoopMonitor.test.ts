// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - regression exercises native GC notification and timer phase ordering.
import * as NodeTimers from "node:timers";
import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as EventLoopMonitor from "./EventLoopMonitor.ts";

const ms = (value: number) => value * 1e6;

// Node reports a stall of S as a gap of up to S + 1 s, the histogram resolution.
const stalled: EventLoopMonitor.EventLoopReadings = {
  delayMaxNs: ms(5_950),
  activeMs: 6_200,
  utilization: 0.176,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
  heapUsedBytes: 512 * 1024 * 1024,
  gc: { count: 3, totalMs: 450.5, maxMs: 400, majorCount: 1, majorMaxMs: 400 },
  elapsedMs: 30_000,
};
const quiet: EventLoopMonitor.EventLoopReadings = { ...stalled, delayMaxNs: ms(2_950) };

const monitor = (
  samples: Array<EventLoopMonitor.EventLoopReadings>,
  stallLog: EventLoopMonitor.StallLogOptions = { filePath: "\0", maxBytes: 1 },
) =>
  Layer.build(
    EventLoopMonitor.layerWith(
      Effect.succeed(Effect.sync(() => samples.shift() ?? quiet)),
      stallLog,
    ),
  );

describe("EventLoopMonitor", () => {
  it.effect("records a warning span only for samples that saw a stall", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      yield* Effect.gen(function* () {
        yield* monitor([stalled, quiet, { ...stalled, sampledAt: "1970-01-01T00:01:29.999Z" }]);
        yield* TestClock.adjust("60 seconds");
        assert.lengthOf(spans, 0);
        yield* TestClock.adjust("30 seconds");
      }).pipe(Effect.scoped, Effect.withTracer(tracer));

      assert.deepStrictEqual(
        spans.map((span) => span.name),
        ["server.eventLoop.stall"],
      );
      const [span] = spans;
      assert.deepStrictEqual(Object.fromEntries(span!.attributes), {
        delayMaxMs: 4_950,
        utilization: 0.18,
        cpuUserMs: 310,
        cpuSystemMs: 96,
        majorPageFaults: 8_412,
        minorPageFaults: 20_031,
        involuntaryContextSwitches: 57,
        rssMb: 1536,
        gcCount: 3,
        gcTotalMs: 450.5,
        gcMaxMs: 400,
        gcMajorCount: 1,
        gcMajorMaxMs: 400,
        heapUsedMb: 512,
        heapUsedMbPrev: 512,
        sampledAt: "1970-01-01T00:01:29.999Z",
      });
      assert.deepStrictEqual(
        span!.events.map(([name, , attributes]) => [name, attributes["effect.logLevel"]]),
        [["event loop stalled for 4950 ms", "WARN"]],
      );
    }),
  );

  it.effect("includes native GC delivered after the sampling timer, including startup", () =>
    Effect.gen(function* () {
      NodeV8.setFlagsFromString("--expose_gc");
      const collect: () => void = NodeVM.runInNewContext("gc");
      const sample = yield* EventLoopMonitor.makeNodeSampler;
      // Sampling in the GC timer prevents native notification delivery before the read.
      const startup = yield* Effect.callback<EventLoopMonitor.EventLoopReadings>((resume) => {
        // @effect-diagnostics-next-line globalTimersInEffect:off -- real timer orders GC delivery before the production sampler.
        const timer = NodeTimers.setTimeout(() => {
          collect();
          resume(sample);
        }, 0);
        return Effect.sync(() => NodeTimers.clearTimeout(timer));
      });
      assert.strictEqual(startup.gc.majorCount, 1);
      assert.isAbove(startup.gc.majorMaxMs, 0);
      const firstReported = yield* sample;
      assert.strictEqual(firstReported.gc.majorCount, 0);
      assert.strictEqual(firstReported.gc.majorMaxMs, 0);
    }).pipe(Effect.scoped),
  );

  it("routes delayed entries by GC completion time across a closing window", () => {
    const gc = EventLoopMonitor.makeGcWindow();
    gc.record([{ startTime: 0, duration: 2 }]);
    gc.close(10);
    gc.record([
      {
        startTime: 5,
        duration: 3,
        detail: { kind: NodePerfHooks.constants.NODE_PERFORMANCE_GC_MAJOR },
      },
      { startTime: 8, duration: 2 },
      { startTime: 9, duration: 3 },
      { startTime: 11, duration: 4 },
    ]);
    assert.deepStrictEqual(gc.read(), {
      count: 3,
      totalMs: 7,
      maxMs: 3,
      majorCount: 1,
      majorMaxMs: 3,
    });
    gc.close(20);
    assert.deepStrictEqual(gc.read(), {
      count: 2,
      totalMs: 7,
      maxMs: 4,
      majorCount: 0,
      majorMaxMs: 0,
    });
    gc.close(30);
    assert.strictEqual(gc.read().count, 0);
  });

  it.effect("resets GC each window and keeps the previous quiet tick's heap", () =>
    Effect.gen(function* () {
      const gc = EventLoopMonitor.makeGcWindow();
      gc.record([
        {
          startTime: 0,
          duration: 12.5,
          detail: { kind: NodePerfHooks.constants.NODE_PERFORMANCE_GC_MINOR },
        },
        {
          startTime: 0,
          duration: 400,
          detail: { kind: NodePerfHooks.constants.NODE_PERFORMANCE_GC_MAJOR },
        },
        {
          startTime: 0,
          duration: 500,
          detail: { kind: NodePerfHooks.constants.NODE_PERFORMANCE_GC_MAJOR },
        },
        {
          startTime: 0,
          duration: 2,
          detail: { kind: NodePerfHooks.constants.NODE_PERFORMANCE_GC_INCREMENTAL },
        },
      ]);
      const first = gc.read();
      assert.deepStrictEqual(first, {
        count: 4,
        totalMs: 914.5,
        maxMs: 500,
        majorCount: 2,
        majorMaxMs: 500,
      });
      const second = gc.read();
      assert.deepStrictEqual(second, {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        majorCount: 0,
        majorMaxMs: 0,
      });
      gc.record([{ startTime: 0, duration: 3 }]);
      assert.deepStrictEqual(gc.read(), {
        count: 1,
        totalMs: 3,
        maxMs: 3,
        majorCount: 0,
        majorMaxMs: 0,
      });
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-event-loop-" });
      const filePath = `${directory}/event-loop-stalls.ndjson`;
      yield* monitor(
        [
          quiet,
          { ...quiet, heapUsedBytes: 1100 * 1024 ** 2, gc: first },
          { ...stalled, heapUsedBytes: 500 * 1024 ** 2, gc: second },
        ],
        { filePath, maxBytes: 4096 },
      );
      yield* TestClock.adjust("90 seconds");
      const rows = (yield* fs.readFileString(filePath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepStrictEqual(rows[0], {
        time: "1970-01-01T00:01:00.000Z",
        kind: "sample",
        rssMb: 1536,
        gcTotalMs: 914.5,
        gcMajorMaxMs: 500,
      });
      assert.strictEqual(rows[1].gcCount, 0);
      assert.strictEqual(rows[1].gcTotalMs, 0);
      assert.strictEqual(rows[1].gcMaxMs, 0);
      assert.strictEqual(rows[1].gcMajorCount, 0);
      assert.strictEqual(rows[1].gcMajorMaxMs, 0);
      assert.strictEqual(rows[1].heapUsedMbPrev, 1100);
      assert.strictEqual(rows[1].heapUsedMb, 500);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("exports the server's memory, CPU and event loop from each sample", () =>
    Effect.gen(function* () {
      yield* monitor([quiet, stalled]);
      yield* TestClock.adjust("60 seconds");

      const gauges = Object.fromEntries(
        (yield* Metric.snapshot).flatMap((snapshot) =>
          snapshot.id.startsWith("t3_server_") && snapshot.type === "Gauge"
            ? [[snapshot.id, snapshot.state.value]]
            : [],
        ),
      );
      assert.deepStrictEqual(gauges, {
        t3_server_resident_bytes: 1536 * 1024 * 1024,
        t3_server_heap_used_bytes: 512 * 1024 * 1024,
        t3_server_event_loop_utilization: 0.176,
        t3_server_event_loop_delay_max: 4_950,
        // 406 ms of CPU over 30 s of wall time.
        t3_server_cpu_utilization: 406 / 30_000,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("writes heartbeats on quiet ticks so missing samples are observable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-event-loop-" });
      const filePath = `${directory}/event-loop-stalls.ndjson`;
      yield* monitor([quiet, quiet, quiet], { filePath, maxBytes: 4096 });
      yield* TestClock.adjust("90 seconds");
      const rows = (yield* fs.readFileString(filePath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepStrictEqual(rows, [
        {
          time: "1970-01-01T00:01:00.000Z",
          kind: "sample",
          rssMb: 1536,
          gcTotalMs: 450.5,
          gcMajorMaxMs: 400,
        },
        {
          time: "1970-01-01T00:01:30.000Z",
          kind: "sample",
          rssMb: 1536,
          gcTotalMs: 450.5,
          gcMajorMaxMs: 400,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps each stall as one line in a capped stall log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-event-loop-" });
      const filePath = `${directory}/event-loop-stalls.ndjson`;
      yield* monitor(
        [
          stalled,
          stalled,
          stalled,
          { ...stalled, delayMaxNs: ms(7_000), sampledAt: "1970-01-01T00:01:59.999Z" },
        ],
        {
          filePath,
          maxBytes: 300,
        },
      );
      yield* TestClock.adjust("120 seconds");

      const lines = (yield* fs.readFileString(filePath)).trim().split("\n");
      assert.deepStrictEqual(
        lines.map((line) => JSON.parse(line)),
        [
          {
            time: "1970-01-01T00:01:59.999Z",
            sampledAt: "1970-01-01T00:01:59.999Z",
            delayMaxMs: 6_000,
            gcCount: 3,
            gcTotalMs: 450.5,
            gcMaxMs: 400,
            gcMajorCount: 1,
            gcMajorMaxMs: 400,
            heapUsedMb: 512,
            heapUsedMbPrev: 512,
            utilization: 0.18,
            cpuUserMs: 310,
            cpuSystemMs: 96,
            majorPageFaults: 8_412,
            minorPageFaults: 20_031,
            involuntaryContextSwitches: 57,
            rssMb: 1536,
          },
        ],
      );
      assert.lengthOf((yield* fs.readFileString(`${filePath}.1`)).trim().split("\n"), 1);
      assert.isFalse(yield* fs.exists(`${filePath}.2`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { limitMb: 4096, thresholdMb: 1536, usedMb: 1638.4 },
    { limitMb: 2048, thresholdMb: 1536, usedMb: 1536 + 1 / 1024 / 1024 },
    { limitMb: 1024, thresholdMb: 768, usedMb: 800 },
  ])(
    "records heap spaces once per tick above the lower threshold ($limitMb MiB limit)",
    ({ limitMb, thresholdMb, usedMb }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-event-loop-" });
        const filePath = `${directory}/event-loop-stalls.ndjson`;
        const samples = [
          quiet,
          { ...quiet, heapUsedBytes: thresholdMb * 1024 * 1024 },
          { ...stalled, heapUsedBytes: usedMb * 1024 * 1024 },
          { ...quiet, heapUsedBytes: usedMb * 1024 * 1024 },
        ];
        yield* Layer.build(
          EventLoopMonitor.layerWith(
            Effect.succeed(Effect.sync(() => samples.shift() ?? quiet)),
            { filePath, maxBytes: 4096 },
            () => [
              {
                space_name: "large_object_space",
                space_size: 128 * 1024 * 1024,
                space_used_size: 100 * 1024 * 1024,
                space_available_size: 0,
                physical_space_size: 128 * 1024 * 1024,
              },
            ],
            limitMb * 1024 * 1024,
          ),
        );
        yield* TestClock.adjust("120 seconds");
        const lines = (yield* fs.readFileString(filePath))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const heaps = lines.filter((line) => line.kind === "heap-spaces");
        assert.lengthOf(heaps, 2);
        assert.lengthOf(
          lines.filter((line) => line.delayMaxMs !== undefined),
          1,
        );
        assert.notStrictEqual(heaps[0].at, heaps[1].at);
        const line = heaps[0];
        assert.isString(line.at);
        assert.deepStrictEqual(
          { ...line, at: "timestamp" },
          {
            at: "timestamp",
            kind: "heap-spaces",
            heapUsedMb: Math.round(usedMb),
            heapLimitMb: limitMb,
            rssMb: 1536,
            spaces: [{ name: "large_object_space", usedMb: 100, sizeMb: 128 }],
          },
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps sampling after heap-space collection throws", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-event-loop-" });
      const filePath = `${directory}/event-loop-stalls.ndjson`;
      let calls = 0;
      yield* Layer.build(
        EventLoopMonitor.layerWith(
          Effect.succeed(Effect.succeed({ ...quiet, heapUsedBytes: 1.6 * 1024 ** 3 })),
          { filePath, maxBytes: 4096 },
          () => {
            calls++;
            if (calls === 1) throw new Error("unavailable");
            return [];
          },
          4 * 1024 ** 3,
        ),
      );
      yield* TestClock.adjust("90 seconds");
      assert.strictEqual(calls, 2);
      const lines = (yield* fs.readFileString(filePath)).trim().split("\n");
      assert.lengthOf(lines, 3);
      assert.lengthOf(
        lines.filter((line) => JSON.parse(line).kind === "heap-spaces"),
        1,
      );
      assert.lengthOf(
        lines.filter((line) => JSON.parse(line).kind === "sample"),
        2,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("warns when a stall cannot be written to the stall log", () => {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(Array.isArray(message) ? message[0] : message);
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-event-loop-" });
      yield* monitor([stalled, stalled], { filePath, maxBytes: 1024 * 1024 });
      yield* TestClock.adjust("60 seconds");
      assert.deepStrictEqual(warnings, [
        "event loop stalled for 4950 ms",
        "event loop stall log write failed",
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it("ignores delay the loop spent idle, such as a system sleep", () => {
    // Waking from sleep reads as a long gap, but the loop was idle in poll for it.
    const asleep: EventLoopMonitor.EventLoopReadings = {
      ...stalled,
      delayMaxNs: ms(600_000),
      activeMs: 900,
    };
    assert.isUndefined(EventLoopMonitor.stallMs(asleep));
    assert.strictEqual(EventLoopMonitor.stallMs({ ...asleep, activeMs: 600_000 }), 599_000);
  });
});
