import type * as Electron from "electron";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeRotatingLogFileWriter } from "../app/DesktopObservability.ts";

export interface RendererIdentity {
  readonly surface: "main" | "preview" | "splash" | "picture-in-picture" | "devtools";
  readonly tabId?: string;
}

export class DesktopRendererHistory extends Context.Service<
  DesktopRendererHistory,
  {
    readonly register: (
      webContents: Electron.WebContents,
      identity: RendererIdentity,
      window?: Electron.BaseWindow,
    ) => Effect.Effect<void>;
    readonly recordMetrics: (metrics: ReadonlyArray<Electron.ProcessMetric>) => Effect.Effect<void>;
    readonly shutdown: Effect.Effect<void>;
  }
>()("@t3tools/desktop/telemetry/DesktopRendererHistory") {}

interface RendererMemory {
  readonly sampledAtUnixMs: number;
  // Electron reports process-wide working sets in KiB, not JavaScript heaps.
  readonly kind: "electron-process-working-set";
  readonly workingSetBytes: number;
  readonly peakWorkingSetBytes: number;
}

interface RendererCpu {
  readonly percentMean: number | null;
  readonly cumulativeSeconds: number | null;
  readonly idleWakeupsPerSecond: number | null;
}

interface RendererWindow {
  readonly visible: boolean;
  readonly focused: boolean;
  readonly minimized: boolean;
  readonly throttled: boolean;
}

interface RendererRecord {
  readonly version: 2;
  readonly mainPid: number;
  readonly mainSessionStartedAtUnixMs: number;
  readonly timestampUnixMs: number;
  readonly event:
    | "created"
    | "identified"
    | "dom-ready"
    | "sample"
    | "render-process-gone"
    | "destroyed";
  readonly webContentsId: number;
  readonly surface: RendererIdentity["surface"];
  readonly tabId?: string;
  readonly rendererPid: number | null;
  readonly rendererPidSource: "current" | "last-known" | "unavailable";
  readonly rendererCreationTimeMs: number | null;
  readonly memory: RendererMemory | null;
  readonly cpu: RendererCpu | null;
  readonly window: RendererWindow | null;
  readonly reason?: Electron.RenderProcessGoneDetails["reason"];
  readonly exitCode?: number;
}

interface RendererHourRecord {
  readonly version: 2;
  readonly event: "hour";
  readonly mainPid: number;
  readonly mainSessionStartedAtUnixMs: number;
  readonly timestampUnixMs: number;
  readonly hourStartedAtUnixMs: number;
  readonly rendererPid: number;
  readonly rendererCreationTimeMs: number | null;
  readonly sampleCount: number;
  readonly cpu: {
    readonly percentMean: number | null;
    readonly percentMax: number | null;
    readonly sampleCount: number;
  };
  readonly memory: {
    readonly startWorkingSetBytes: number;
    readonly endWorkingSetBytes: number;
    readonly peakWorkingSetBytes: number;
  };
  readonly window: {
    readonly visiblePercent: number | null;
    readonly focusedPercent: number | null;
    readonly sampleCount: number;
  };
}

interface RendererHour {
  readonly hourStartedAtUnixMs: number;
  readonly rendererPid: number;
  readonly rendererCreationTimeMs: number | null;
  sampleCount: number;
  cpuCount: number;
  cpuSum: number;
  cpuMax: number | null;
  readonly startWorkingSetBytes: number;
  endWorkingSetBytes: number;
  peakWorkingSetBytes: number;
  windowCount: number;
  visibleCount: number;
  focusedCount: number;
}

interface TrackedRenderer {
  readonly webContents: Electron.WebContents;
  identity: RendererIdentity;
  window: Electron.BaseWindow | undefined;
  cpu: RendererCpu | null;
  pid: number | null;
  creationTimeMs: number | null;
  memory: RendererMemory | null;
  gone: boolean;
  readonly removeListeners: () => void;
}

const finiteNonnegative = (value: number | undefined): number | null =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
const nonnegative = (value: number): number | null => {
  const valid = finiteNonnegative(value);
  return valid === null ? null : Math.round(valid);
};

const readWindow = (renderer: TrackedRenderer): RendererWindow | null => {
  try {
    const window = renderer.window;
    if (window === undefined || window.isDestroyed() || renderer.webContents.isDestroyed())
      return null;
    return {
      visible: window.isVisible(),
      focused: window.isFocused(),
      minimized: window.isMinimized(),
      throttled: renderer.webContents.getBackgroundThrottling(),
    };
  } catch {
    // Contents and their owner can disappear in different Electron callbacks.
    return null;
  }
};

const make = Effect.fn("DesktopRendererHistory.make")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const path = yield* Path.Path;
  const clock = yield* Clock.Clock;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const mainSessionStartedAtUnixMs = clock.currentTimeMillisUnsafe();
  const records = yield* Queue.sliding<RendererRecord | RendererHourRecord>(256);
  const active = new Map<number, TrackedRenderer>();
  const hours = new Map<string, RendererHour>();
  let accepting = true;
  const writer = yield* makeRotatingLogFileWriter({
    filePath: path.join(environment.logDir, "renderer-history.ndjson"),
    maxBytes: 256 * 1024,
    maxFiles: 2,
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("Renderer incident history could not be opened.").pipe(
        Effect.as({ writeText: (_chunk: string) => Effect.void }),
      ),
    ),
  );

  const writeRecord = Effect.fn("DesktopRendererHistory.writeRecord")(
    (record: RendererRecord | RendererHourRecord) =>
      writer.writeText(`${JSON.stringify(record)}\n`).pipe(Effect.ignore),
  );
  const writerFiber = yield* Effect.forever(
    Effect.uninterruptibleMask((restore) =>
      restore(Queue.take(records)).pipe(Effect.flatMap(writeRecord)),
    ).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.void,
      ),
    ),
  ).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        while (Queue.sizeUnsafe(records) > 0) {
          const pending = yield* Queue.takeAll(records);
          yield* Effect.forEach(pending, writeRecord, { discard: true });
        }
      }),
    ),
    Effect.forkScoped,
  );

  // Desktop owns these process samples; writing here avoids an analytics RPC or
  // another sampler. Hours are UTC buckets of samples (by end timestamp): CPU is
  // mean/max of valid two-minute interval means, memory peak is sampled working
  // set (not the lifetime high-water mark), visibility/focus are % of known-window
  // samples. Shared PIDs count once, with any visible/focused owner counting true.
  // Null CPU/window percentages mean no valid observations, not zero usage.
  const flushHour = (hour: RendererHour): void => {
    Queue.offerUnsafe(records, {
      version: 2,
      event: "hour",
      mainPid: process.pid,
      mainSessionStartedAtUnixMs,
      timestampUnixMs: clock.currentTimeMillisUnsafe(),
      hourStartedAtUnixMs: hour.hourStartedAtUnixMs,
      rendererPid: hour.rendererPid,
      rendererCreationTimeMs: hour.rendererCreationTimeMs,
      sampleCount: hour.sampleCount,
      cpu: {
        percentMean: hour.cpuCount === 0 ? null : hour.cpuSum / hour.cpuCount,
        percentMax: hour.cpuMax,
        sampleCount: hour.cpuCount,
      },
      memory: {
        startWorkingSetBytes: hour.startWorkingSetBytes,
        endWorkingSetBytes: hour.endWorkingSetBytes,
        peakWorkingSetBytes: hour.peakWorkingSetBytes,
      },
      window: {
        visiblePercent:
          hour.windowCount === 0 ? null : (hour.visibleCount * 100) / hour.windowCount,
        focusedPercent:
          hour.windowCount === 0 ? null : (hour.focusedCount * 100) / hour.windowCount,
        sampleCount: hour.windowCount,
      },
    });
  };

  const readPid = (renderer: TrackedRenderer): RendererRecord["rendererPidSource"] => {
    try {
      if (!renderer.gone && !renderer.webContents.isDestroyed()) {
        const pid = renderer.webContents.getOSProcessId();
        if (Number.isInteger(pid) && pid > 0) {
          if (pid !== renderer.pid) {
            renderer.pid = pid;
            renderer.creationTimeMs = null;
            renderer.memory = null;
            renderer.cpu = null;
          }
          return "current";
        }
      }
    } catch {
      // Electron can remove a guest before its destruction callback runs.
    }
    return renderer.pid === null ? "unavailable" : "last-known";
  };
  const record = (
    renderer: TrackedRenderer,
    event: RendererRecord["event"],
    details?: Electron.RenderProcessGoneDetails,
  ): RendererRecord => {
    const rendererPidSource = readPid(renderer);
    const row: RendererRecord = {
      version: 2,
      mainPid: process.pid,
      mainSessionStartedAtUnixMs,
      timestampUnixMs: clock.currentTimeMillisUnsafe(),
      event,
      webContentsId: renderer.webContents.id,
      ...renderer.identity,
      rendererPid: renderer.pid,
      rendererPidSource,
      rendererCreationTimeMs: renderer.creationTimeMs,
      memory: renderer.memory,
      cpu: renderer.cpu,
      window: readWindow(renderer),
      ...(details === undefined
        ? {}
        : {
            reason: details.reason,
            ...(Number.isFinite(details.exitCode)
              ? { exitCode: Math.round(details.exitCode) }
              : {}),
          }),
    };
    Queue.offerUnsafe(records, row);
    return row;
  };

  const register = Effect.fn("DesktopRendererHistory.register")(
    (webContents: Electron.WebContents, identity: RendererIdentity, window?: Electron.BaseWindow) =>
      Effect.sync(() => {
        if (!accepting || webContents.isDestroyed()) return;
        const boundedIdentity: RendererIdentity = {
          surface: identity.surface,
          ...(identity.tabId === undefined ? {} : { tabId: identity.tabId.slice(0, 128) }),
        };
        const existing = active.get(webContents.id);
        if (existing !== undefined) {
          if (window !== undefined) existing.window = window;
          if (
            existing.identity.surface !== boundedIdentity.surface ||
            existing.identity.tabId !== boundedIdentity.tabId
          ) {
            existing.identity = boundedIdentity;
            record(existing, "identified");
          }
          return;
        }
        const onDomReady = () => {
          if (renderer.gone) {
            renderer.pid = null;
            renderer.creationTimeMs = null;
            renderer.memory = null;
            renderer.cpu = null;
            renderer.gone = false;
          }
          record(renderer, "dom-ready");
        };
        const onDevToolsOpened = () => {
          const tools = webContents.devToolsWebContents;
          if (tools)
            runFork(
              register(tools, {
                surface: "devtools",
                ...(renderer.identity.tabId === undefined
                  ? {}
                  : { tabId: renderer.identity.tabId }),
              }),
            );
        };
        const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
          readPid(renderer);
          renderer.gone = true;
          record(renderer, "render-process-gone", details);
        };
        const onDestroyed = () => {
          record(renderer, "destroyed");
          active.delete(webContents.id);
          renderer.removeListeners();
        };
        const renderer: TrackedRenderer = {
          webContents,
          identity: boundedIdentity,
          window,
          cpu: null,
          pid: null,
          creationTimeMs: null,
          memory: null,
          gone: false,
          removeListeners: () => {
            webContents.removeListener("dom-ready", onDomReady);
            webContents.removeListener("devtools-opened", onDevToolsOpened);
            webContents.removeListener("render-process-gone", onGone);
            webContents.removeListener("destroyed", onDestroyed);
          },
        };
        active.set(webContents.id, renderer);
        webContents.on("dom-ready", onDomReady);
        webContents.on("devtools-opened", onDevToolsOpened);
        webContents.on("render-process-gone", onGone);
        webContents.once("destroyed", onDestroyed);
        record(renderer, "created");
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.void,
        ),
      ),
  );

  let lastSampledAtUnixMs = -Infinity;
  const sampleMetrics = Effect.fn("DesktopRendererHistory.sampleMetrics")(
    (metrics: ReadonlyArray<Electron.ProcessMetric>) =>
      Effect.sync(() => {
        if (!accepting) return;
        const sampledAtUnixMs = clock.currentTimeMillisUnsafe();
        lastSampledAtUnixMs = sampledAtUnixMs;
        const byPid = new Map(metrics.map((metric) => [metric.pid, metric]));
        const observed = new Map<
          string,
          {
            pid: number;
            creationTimeMs: number | null;
            memory: RendererMemory;
            cpu: RendererCpu | null;
            window: RendererWindow | null;
          }
        >();
        for (const renderer of active.values()) {
          const pidSource = readPid(renderer);
          // A last-known PID may already have been reused by another process.
          const metric =
            pidSource !== "current" || renderer.pid === null ? undefined : byPid.get(renderer.pid);
          if (metric !== undefined) {
            const creationTimeMs = nonnegative(metric.creationTime);
            const cumulativeSeconds = finiteNonnegative(metric.cpu.cumulativeCPUUsage);
            const previousSeconds = renderer.cpu?.cumulativeSeconds;
            const elapsedMs =
              sampledAtUnixMs - (renderer.memory?.sampledAtUnixMs ?? sampledAtUnixMs);
            renderer.cpu = {
              // A first reading, PID reuse or reset has no trustworthy interval.
              percentMean:
                creationTimeMs !== null &&
                creationTimeMs === renderer.creationTimeMs &&
                previousSeconds != null &&
                cumulativeSeconds !== null &&
                cumulativeSeconds >= previousSeconds &&
                elapsedMs > 0
                  ? ((cumulativeSeconds - previousSeconds) * 100_000) / elapsedMs
                  : null,
              cumulativeSeconds,
              idleWakeupsPerSecond: finiteNonnegative(metric.cpu.idleWakeupsPerSecond),
            };
            renderer.creationTimeMs = creationTimeMs;
            renderer.memory = {
              sampledAtUnixMs,
              kind: "electron-process-working-set",
              workingSetBytes: nonnegative(metric.memory.workingSetSize * 1024) ?? 0,
              peakWorkingSetBytes: nonnegative(metric.memory.peakWorkingSetSize * 1024) ?? 0,
            };
          } else {
            renderer.cpu = null;
            renderer.memory = null;
          }
          // A process can host multiple contents; these rows must not be summed.
          const sample = record(renderer, "sample");
          if (metric !== undefined && renderer.pid !== null && renderer.memory !== null) {
            const key = `${renderer.pid}:${renderer.creationTimeMs}`;
            const window = sample.window;
            const existing = observed.get(key);
            if (existing === undefined)
              observed.set(key, {
                pid: renderer.pid,
                creationTimeMs: renderer.creationTimeMs,
                memory: renderer.memory,
                cpu: renderer.cpu,
                window,
              });
            else {
              // Another contents may have just restarted inside a shared process.
              if (existing.cpu?.percentMean == null) existing.cpu = renderer.cpu;
              if (window !== null)
                existing.window = {
                  ...window,
                  visible: window.visible || existing.window?.visible === true,
                  focused: window.focused || existing.window?.focused === true,
                };
            }
          }
        }
        const hourStartedAtUnixMs = Math.floor(sampledAtUnixMs / 3_600_000) * 3_600_000;
        for (const [key, hour] of hours) {
          if (hour.hourStartedAtUnixMs !== hourStartedAtUnixMs || !observed.has(key)) {
            flushHour(hour);
            hours.delete(key);
          }
        }
        for (const [key, sample] of observed) {
          const { memory, window } = sample;
          let hour = hours.get(key);
          if (hour === undefined) {
            hour = {
              hourStartedAtUnixMs,
              rendererPid: sample.pid,
              rendererCreationTimeMs: sample.creationTimeMs,
              sampleCount: 0,
              cpuCount: 0,
              cpuSum: 0,
              cpuMax: null,
              startWorkingSetBytes: memory.workingSetBytes,
              endWorkingSetBytes: memory.workingSetBytes,
              peakWorkingSetBytes: memory.workingSetBytes,
              windowCount: 0,
              visibleCount: 0,
              focusedCount: 0,
            };
            hours.set(key, hour);
          }
          hour.sampleCount++;
          const cpu = sample.cpu?.percentMean;
          if (cpu != null) {
            hour.cpuCount++;
            hour.cpuSum += cpu;
            hour.cpuMax = Math.max(hour.cpuMax ?? cpu, cpu);
          }
          hour.endWorkingSetBytes = memory.workingSetBytes;
          hour.peakWorkingSetBytes = Math.max(hour.peakWorkingSetBytes, memory.workingSetBytes);
          if (window !== null) {
            hour.windowCount++;
            hour.visibleCount += Number(window.visible);
            hour.focusedCount += Number(window.focused);
          }
        }
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.void,
        ),
      ),
  );
  // The publisher may call every second; skipped history samples must not
  // create tracing spans or read window state at that cadence.
  const recordMetrics = (metrics: ReadonlyArray<Electron.ProcessMetric>) =>
    Effect.suspend(() =>
      clock.currentTimeMillisUnsafe() - lastSampledAtUnixMs < 120_000
        ? Effect.void
        : sampleMetrics(metrics),
    );
  const shutdown = Effect.sync(() => {
    accepting = false;
    for (const hour of hours.values()) flushHour(hour);
    hours.clear();
    for (const renderer of active.values()) renderer.removeListeners();
    active.clear();
  }).pipe(Effect.andThen(Fiber.interrupt(writerFiber)), Effect.asVoid);
  yield* Effect.addFinalizer(() => shutdown);

  return DesktopRendererHistory.of({ register, recordMetrics, shutdown });
});

export const layer = Layer.effect(DesktopRendererHistory, make());
