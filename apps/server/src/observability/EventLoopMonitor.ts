// @effect-diagnostics nodeBuiltinImport:off - native delay/GC observations require Node hooks and event-loop delivery.
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeV8 from "node:v8";

import { RotatingFileSink } from "@t3tools/shared/logging";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as Metrics from "./Metrics.ts";

// Node's delay histogram wakes a native timer every RESOLUTION_MS and records the
// gap between wakeups, so an idle loop reads about RESOLUTION_MS and a stall of S
// reads between S and S + RESOLUTION_MS. We subtract the resolution, so a delay can
// undercount a stall by up to RESOLUTION_MS.
const RESOLUTION_MS = 1000;
const STALL_THRESHOLD_MS = 2000;
const SAMPLE_INTERVAL = "30 seconds";
const STALL_LOG_MAX_BYTES = 256 * 1024;
// Encoding bursts have exhausted the heap below 75% of V8's limit. Capture
// space statistics before those bursts, while respecting smaller heap limits.
const HIGH_HEAP_BYTES = 1.5 * 1024 ** 3;
const HIGH_HEAP_RATIO = 0.75;

/** Delay in ns, active time in ms, CPU in µs. */
export interface EventLoopReadings {
  readonly delayMaxNs: number;
  readonly activeMs: number;
  readonly utilization: number;
  readonly usage: Pick<
    NodeJS.ResourceUsage,
    | "userCPUTime"
    | "systemCPUTime"
    | "majorPageFault"
    | "minorPageFault"
    | "involuntaryContextSwitches"
  >;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly gc: {
    readonly count: number;
    readonly totalMs: number;
    readonly maxMs: number;
    readonly majorCount: number;
    readonly majorMaxMs: number;
  };
  /** Wall time the readings cover. */
  readonly elapsedMs: number;
  /** Sampling boundary, before waiting for native GC notification delivery. */
  readonly sampledAt?: string;
}

export const makeGcWindow = () => {
  const empty = () => ({
    count: 0,
    totalMs: 0,
    maxMs: 0,
    majorCount: 0,
    majorMaxMs: 0,
  });
  let stats = empty();
  let closing: { until: number; stats: ReturnType<typeof empty> } | undefined;
  return {
    record(
      entries: ReadonlyArray<
        Pick<NodePerfHooks.PerformanceEntry, "duration" | "startTime"> & {
          readonly detail?: { readonly kind?: number };
        }
      >,
    ) {
      for (const entry of entries) {
        const major = entry.detail?.kind === NodePerfHooks.constants.NODE_PERFORMANCE_GC_MAJOR;
        const target =
          closing !== undefined && entry.startTime + entry.duration <= closing.until
            ? closing.stats
            : stats;
        target.count++;
        target.totalMs += entry.duration;
        target.maxMs = Math.max(target.maxMs, entry.duration);
        if (major) {
          target.majorCount++;
          target.majorMaxMs = Math.max(target.majorMaxMs, entry.duration);
        }
      }
    },
    close(until: number) {
      closing = { until, stats };
      stats = empty();
    },
    read() {
      if (closing !== undefined) {
        const result = closing.stats;
        closing = undefined;
        return result;
      }
      const result = stats;
      stats = empty();
      return result;
    },
  };
};

// Node skips the first gap after a reset, so a stall right at a sample boundary can be missed.
export const makeNodeSampler = Effect.gen(function* () {
  const gc = makeGcWindow();
  const { histogram, observer } = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: RESOLUTION_MS });
      const observer = new NodePerfHooks.PerformanceObserver((list) =>
        gc.record(list.getEntries()),
      );
      observer.observe({ entryTypes: ["gc"] });
      histogram.enable();
      return { histogram, observer };
    }),
    ({ histogram, observer }) =>
      Effect.sync(() => {
        observer.disconnect();
        histogram.disable();
      }),
  );
  let elu = NodePerfHooks.performance.eventLoopUtilization();
  let usage = process.resourceUsage();
  let sampledAt = NodePerfHooks.performance.now();

  // @effect-diagnostics-next-line returnEffectInGen:off - the read effect is the result.
  return Effect.suspend(() => {
    const nextElu = NodePerfHooks.performance.eventLoopUtilization();
    const nextUsage = process.resourceUsage();
    const nextSampledAt = NodePerfHooks.performance.now();
    const memory = process.memoryUsage();
    const loop = NodePerfHooks.performance.eventLoopUtilization(nextElu, elu);
    gc.close(nextSampledAt);
    const readings = {
      delayMaxNs: histogram.max,
      activeMs: loop.active,
      utilization: loop.utilization,
      usage: {
        userCPUTime: nextUsage.userCPUTime - usage.userCPUTime,
        systemCPUTime: nextUsage.systemCPUTime - usage.systemCPUTime,
        majorPageFault: nextUsage.majorPageFault - usage.majorPageFault,
        minorPageFault: nextUsage.minorPageFault - usage.minorPageFault,
        involuntaryContextSwitches:
          nextUsage.involuntaryContextSwitches - usage.involuntaryContextSwitches,
      },
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      elapsedMs: nextSampledAt - sampledAt,
      sampledAt: DateTime.formatIso(
        DateTime.makeUnsafe(NodePerfHooks.performance.timeOrigin + nextSampledAt),
      ),
    };
    histogram.reset();
    elu = nextElu;
    usage = nextUsage;
    sampledAt = nextSampledAt;
    // Native GC notifications can arrive after the sampling timer. Let them reach
    // the observer before finalizing; GC after the boundary belongs to the next window.
    return Effect.promise(async () => {
      await NodeTimersPromises.setImmediate();
      await NodeTimersPromises.setImmediate();
      gc.record(observer.takeRecords());
      return { ...readings, gc: gc.read() };
    });
  });
});

export const stallMs = ({ delayMaxNs, activeMs }: EventLoopReadings) => {
  const delayMs = Math.round(delayMaxNs / 1e6) - RESOLUTION_MS;
  // libuv's clock keeps running while the system sleeps on macOS and Windows, so a
  // sleep also reads as delay, but the loop spent it idle in poll.
  if (delayMs <= STALL_THRESHOLD_MS || activeMs < delayMs) return undefined;
  return delayMs;
};

// Untraced: it runs inside every 30-second tick, which already has the monitor's own span.
const recordGauges = Effect.fnUntraced(function* (readings: EventLoopReadings) {
  const cpuMs = (readings.usage.userCPUTime + readings.usage.systemCPUTime) / 1000;
  yield* Metric.update(Metrics.serverResidentBytes, readings.rssBytes);
  yield* Metric.update(Metrics.serverHeapUsedBytes, readings.heapUsedBytes);
  yield* Metric.update(Metrics.serverEventLoopUtilization, readings.utilization);
  yield* Metric.update(
    Metrics.serverEventLoopDelayMax,
    Math.max(0, Math.round(readings.delayMaxNs / 1e6) - RESOLUTION_MS),
  );
  if (readings.elapsedMs > 0) {
    yield* Metric.update(Metrics.serverCpuUtilization, cpuMs / readings.elapsedMs);
  }
});

const encodeStallLine = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export interface StallLogOptions {
  readonly filePath: string;
  readonly maxBytes: number;
}

export const layerWith = (
  makeSampler: Effect.Effect<Effect.Effect<EventLoopReadings>, never, Scope.Scope>,
  stallLog: StallLogOptions,
  readHeapSpaces: typeof NodeV8.getHeapSpaceStatistics = NodeV8.getHeapSpaceStatistics,
  heapLimitBytes: number = NodeV8.getHeapStatistics().heap_size_limit,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sample = yield* makeSampler;
      const stallSink = yield* Effect.try(
        () =>
          new RotatingFileSink({
            filePath: stallLog.filePath,
            maxBytes: stallLog.maxBytes,
            maxFiles: 1,
            throwOnError: true,
          }),
      ).pipe(
        Effect.catch(() =>
          Effect.logWarning("event loop stall log unavailable", {
            filePath: stallLog.filePath,
          }).pipe(Effect.as(undefined)),
        ),
      );
      let heapUsedMbPrev = 0;
      const tick = Effect.gen(function* () {
        const readings = yield* sample;
        const previousHeap = heapUsedMbPrev;
        heapUsedMbPrev = Math.round(readings.heapUsedBytes / 1024 / 1024);
        yield* recordGauges(readings);
        if (
          readings.heapUsedBytes > Math.min(HIGH_HEAP_BYTES, heapLimitBytes * HIGH_HEAP_RATIO) &&
          stallSink !== undefined
        ) {
          const at = readings.sampledAt ?? DateTime.formatIso(yield* DateTime.now);
          yield* Effect.try(() => {
            return {
              at,
              kind: "heap-spaces",
              heapUsedMb: Math.round(readings.heapUsedBytes / 1024 / 1024),
              heapLimitMb: Math.round(heapLimitBytes / 1024 / 1024),
              rssMb: Math.round(readings.rssBytes / 1024 / 1024),
              spaces: readHeapSpaces().map((space) => ({
                name: space.space_name,
                usedMb: Math.round(space.space_used_size / 1024 / 1024),
                sizeMb: Math.round(space.space_size / 1024 / 1024),
              })),
            };
          }).pipe(
            Effect.flatMap(encodeStallLine),
            Effect.flatMap((line) => Effect.try(() => stallSink.write(`${line}\n`))),
            Effect.catch(() =>
              Effect.logWarning("event loop heap spaces log write failed", {
                filePath: stallLog.filePath,
              }),
            ),
          );
        }
        const delayMaxMs = stallMs(readings);
        if (delayMaxMs === undefined) {
          // Silence must be distinguishable from a sampler blocked on the event loop.
          if (stallSink !== undefined) {
            const time = readings.sampledAt ?? DateTime.formatIso(yield* DateTime.now);
            yield* encodeStallLine({
              time,
              kind: "sample",
              gcTotalMs: readings.gc.totalMs,
              gcMajorMaxMs: readings.gc.majorMaxMs,
              rssMb: Math.round(readings.rssBytes / 1024 / 1024),
            }).pipe(
              Effect.flatMap((line) => Effect.try(() => stallSink.write(`${line}\n`))),
              Effect.catch(() =>
                Effect.logWarning("event loop sample log write failed", {
                  filePath: stallLog.filePath,
                }),
              ),
            );
          }
          return;
        }
        const { utilization, usage, rssBytes } = readings;
        const attributes = {
          delayMaxMs,
          gcCount: readings.gc.count,
          gcTotalMs: readings.gc.totalMs,
          gcMaxMs: readings.gc.maxMs,
          gcMajorCount: readings.gc.majorCount,
          gcMajorMaxMs: readings.gc.majorMaxMs,
          heapUsedMb: heapUsedMbPrev,
          heapUsedMbPrev: previousHeap,
          ...(readings.sampledAt === undefined ? {} : { sampledAt: readings.sampledAt }),
          utilization: Math.round(utilization * 100) / 100,
          cpuUserMs: Math.round(usage.userCPUTime / 1000),
          cpuSystemMs: Math.round(usage.systemCPUTime / 1000),
          majorPageFaults: usage.majorPageFault,
          minorPageFaults: usage.minorPageFault,
          involuntaryContextSwitches: usage.involuntaryContextSwitches,
          rssMb: Math.round(rssBytes / 1024 / 1024),
        };
        yield* Effect.logWarning(`event loop stalled for ${delayMaxMs} ms`).pipe(
          Effect.withSpan("server.eventLoop.stall", { root: true, level: "Warn", attributes }),
        );
        if (stallSink !== undefined) {
          const time = readings.sampledAt ?? DateTime.formatIso(yield* DateTime.now);
          yield* encodeStallLine({ time, ...attributes }).pipe(
            Effect.flatMap((line) => Effect.try(() => stallSink.write(`${line}\n`))),
            Effect.catch(() =>
              Effect.logWarning("event loop stall log write failed", {
                filePath: stallLog.filePath,
              }),
            ),
          );
        }
      });
      const wait = Effect.sleep(SAMPLE_INTERVAL);
      // The layer builds before the rest of the server, so the first sample covers
      // startup work such as migrations and projection bootstrap. That can block the
      // loop for seconds on a large database, so skip it rather than warn at every
      // launch.
      yield* wait.pipe(
        Effect.andThen(
          sample.pipe(
            Effect.tap((readings) =>
              Effect.sync(() => {
                heapUsedMbPrev = Math.round(readings.heapUsedBytes / 1024 / 1024);
              }),
            ),
          ),
        ),
        Effect.andThen(wait.pipe(Effect.andThen(tick), Effect.forever)),
        Effect.forkScoped,
      );
    }),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { serverTracePath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerWith(makeNodeSampler, {
      filePath: path.join(path.dirname(serverTracePath), "event-loop-stalls.ndjson"),
      maxBytes: STALL_LOG_MAX_BYTES,
    });
  }),
);
