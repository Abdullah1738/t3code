// oxlint-disable unicorn/require-post-message-target-origin -- Node Worker is not a browser Window.
// @effect-diagnostics nodeBuiltinImport:off -- heartbeat and worker lifecycle are native observability boundaries.
// @effect-diagnostics globalTimers:off -- the heartbeat must run independently of Effect scheduling.
// @effect-diagnostics globalDate:off -- native worker records use wall-clock timestamps.
import * as NodeWorkerThreads from "node:worker_threads";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import { bootId } from "../ardud/fast-install/report.ts";
import { recordServerAnalytics } from "./RpcInstrumentation.ts";
import {
  captureMainThreadStack,
  decideWatchdog,
  watchdogWorker,
  type BlockRecord,
  type InFlightCall,
  type WatchdogOptions,
} from "./mainThreadWatchdogWorker.ts";

export const defaultOptions: WatchdogOptions = {
  blockedAfterMs: 5000,
  stackAfterMs: 10_000,
  repeatMs: 30_000,
  stackCooldownMs: 300_000,
  checkIntervalMs: 1000,
  heartbeatMs: 250,
};

export function makeRegistry() {
  // Atomic 64-bit heartbeat, followed by a seqlock and bounded UTF-8 registry.
  const shared = new SharedArrayBuffer(8192);
  const heartbeat = new BigInt64Array(shared, 0, 1);
  const header = new Int32Array(shared, 8, 2);
  const bytes = new Uint8Array(shared, 16);
  const calls = new Map<number, InFlightCall>();
  let sequence = 0;
  const beat = () =>
    Atomics.store(heartbeat, 0, BigInt(Math.round(performance.timeOrigin + performance.now())));
  const publish = () => {
    const oldest = [...calls.values()].slice(0, 16);
    let encoded = new TextEncoder().encode(JSON.stringify(oldest));
    while (encoded.length > bytes.length) {
      oldest.pop();
      encoded = new TextEncoder().encode(JSON.stringify(oldest));
    }
    Atomics.add(header, 0, 1);
    bytes.set(encoded);
    Atomics.store(header, 1, encoded.length);
    Atomics.add(header, 0, 1);
  };
  beat();
  publish();
  return {
    shared,
    beat,
    enter(tool: string, args: unknown, callerThreadId?: string) {
      if (calls.size >= 128) return () => {};
      const input =
        typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
      const id = (value: unknown, pattern: RegExp) =>
        typeof value === "string" && value.length <= 512 && pattern.test(value) ? value : undefined;
      const boardId = id(input.boardId, /^[a-zA-Z0-9_-]+$/);
      const cardId = id(input.cardId ?? input.card, /^(?:card-[a-f0-9-]+|#?\d+)$/i);
      const caller = id(callerThreadId, /^[a-zA-Z0-9_.:/#@%+!~'()*-]+$/);
      const key = ++sequence;
      calls.set(key, {
        tool: /^[a-zA-Z0-9_]{1,80}$/.test(tool) ? tool : "unknown",
        ...(boardId ? { boardId } : {}),
        ...(cardId ? { cardId } : {}),
        ...(caller ? { callerThreadId: caller } : {}),
        startedAt: new Date().toISOString(),
      });
      publish();
      return () => {
        if (calls.delete(key)) publish();
      };
    },
  };
}

export const workerSource = () =>
  `(${watchdogWorker.toString()})(${decideWatchdog.toString()}, ${captureMainThreadStack.toString()})`;

export function startWatchdog(
  filePath: string,
  options: WatchdogOptions,
  onRecord: (row: BlockRecord) => void,
  onError: () => void = () => {},
) {
  const registry = makeRegistry();
  const worker = new NodeWorkerThreads.Worker(workerSource(), {
    eval: true,
    execArgv: [],
    workerData: { shared: registry.shared, filePath, options, pid: process.pid, bootId },
  });
  const timer = setInterval(registry.beat, options.heartbeatMs);
  timer.unref();
  const ready = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("watchdog exited")));
    worker.on("message", (row) => {
      if (row.kind === "ready") resolve();
      else if (row.kind === "blocked" || row.kind === "unblocked") onRecord(row);
      else if (row.kind === "watchdog-error") warn();
    });
  });
  let warned = false;
  const warn = () => {
    if (!warned) {
      warned = true;
      onError();
    }
  };
  worker.on("error", warn);
  worker.on("exit", (code) => {
    if (code !== 0) warn();
  });
  worker.unref();
  return {
    ...registry,
    ready,
    async stop() {
      clearInterval(timer);
      if (worker.threadId === -1) return;
      await new Promise<void>((resolve) => {
        worker.once("exit", () => resolve());
        worker.postMessage("stop");
      });
    },
  };
}

export class MainThreadWatchdog extends Context.Service<
  MainThreadWatchdog,
  {
    readonly enter: (tool: string, args: unknown, callerThreadId?: string) => () => void;
  }
>()("t3/observability/MainThreadWatchdog") {}

export const recordUnblocked = Effect.fn("server.main_thread_blocked")(function* (
  row: BlockRecord,
) {
  const analytics = yield* Analytics.Analytics;
  const tools = [...new Set(row.inFlight.map((call) => call.tool))];
  const boardIds = [
    ...new Set(row.inFlight.flatMap((call) => (call.boardId ? [call.boardId] : []))),
  ];
  yield* Effect.annotateCurrentSpan({
    durationMs: row.blockedForMs,
    tools,
    boardIds,
    frames: row.frames.slice(0, 3),
  });
  yield* recordServerAnalytics(analytics, {
    ts: row.at,
    kind: "server.main_thread_blocked",
    surface: "server",
    route: "main-thread",
    durationMs: row.blockedForMs,
    props: { tools, boardIds, frames: row.frames.slice(0, 3) },
  });
});

export const layer = Layer.effect(
  MainThreadWatchdog,
  Effect.gen(function* () {
    const enabled = yield* Config.String("T3_MAIN_THREAD_WATCHDOG").pipe(Config.withDefault("1"));
    if (enabled === "0") return MainThreadWatchdog.of({ enter: () => () => {} });
    const options = { ...defaultOptions };
    for (const [key, name] of Object.entries({
      blockedAfterMs: "BLOCKED_AFTER_MS",
      stackAfterMs: "STACK_AFTER_MS",
      repeatMs: "REPEAT_MS",
      stackCooldownMs: "STACK_COOLDOWN_MS",
      checkIntervalMs: "CHECK_INTERVAL_MS",
      heartbeatMs: "HEARTBEAT_MS",
    })) {
      const value = yield* Config.Number(`T3_MAIN_THREAD_WATCHDOG_${name}`).pipe(
        Config.withDefault(defaultOptions[key as keyof WatchdogOptions]),
      );
      if (Number.isFinite(value) && value > 0) options[key as keyof WatchdogOptions] = value;
    }
    const { logsDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const context = yield* Effect.context<Analytics.Analytics>();
    return yield* Effect.acquireRelease(
      Effect.try(() =>
        startWatchdog(
          path.join(logsDir, "main-thread-blocked.ndjson"),
          options,
          (row) => {
            if (row.kind === "unblocked") Effect.runForkWith(context)(recordUnblocked(row));
          },
          () => {
            Effect.runForkWith(context)(Effect.logWarning("main thread watchdog unavailable"));
          },
        ),
      ),
      (watchdog) => Effect.promise(() => watchdog.stop()),
    ).pipe(
      Effect.tap((watchdog) =>
        Effect.tryPromise(() => watchdog.ready).pipe(
          Effect.tapError(() => Effect.promise(() => watchdog.stop())),
        ),
      ),
      Effect.map(MainThreadWatchdog.of),
      Effect.catch(() =>
        Effect.logWarning("main thread watchdog unavailable").pipe(
          Effect.as(MainThreadWatchdog.of({ enter: () => () => {} })),
        ),
      ),
    );
  }),
);
