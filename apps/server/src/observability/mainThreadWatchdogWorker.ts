// oxlint-disable unicorn/require-post-message-target-origin -- Node MessagePort is not a browser Window.
// @effect-diagnostics nodeBuiltinImport:off -- serialized worker entry; Node APIs must remain independent of the main loop.
// @effect-diagnostics globalTimers:off globalDate:off -- the worker must observe and timestamp blocks without an Effect runtime.
import type * as NodeInspector from "node:inspector";
import type * as NodeWorkerThreads from "node:worker_threads";

export interface WatchdogOptions {
  readonly blockedAfterMs: number;
  readonly stackAfterMs: number;
  readonly repeatMs: number;
  readonly stackCooldownMs: number;
  readonly checkIntervalMs: number;
  readonly heartbeatMs: number;
}
export interface InFlightCall {
  readonly tool: string;
  readonly boardId?: string;
  readonly cardId?: string;
  readonly callerThreadId?: string;
  readonly startedAt: string;
}
export interface StackFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}
export interface BlockRecord {
  readonly kind: "blocked" | "unblocked";
  readonly pid: number;
  readonly bootId: string;
  readonly reportIntervalMs: number;
  readonly episode: string;
  readonly at: string;
  readonly blockedForMs: number;
  readonly inFlight: ReadonlyArray<InFlightCall>;
  readonly frames: ReadonlyArray<StackFrame>;
  readonly captureMs?: number;
}
export interface WatchdogState {
  since?: number;
  lastWriteAt?: number;
  captureAttempted?: boolean;
  lastCaptureAt?: number;
}

// Clock and thresholds are inputs so cooldowns and episode transitions need no timers in tests.
export function decideWatchdog(
  state: WatchdogState,
  now: number,
  heartbeat: number,
  options: WatchdogOptions,
) {
  const age = Math.max(0, now - heartbeat);
  const blocked = age >= options.blockedAfterMs;
  const starting = blocked && state.since === undefined;
  const ending = !blocked && state.since !== undefined;
  const next = { ...state };
  if (starting) {
    next.since = heartbeat;
    next.captureAttempted = false;
  }
  const capture =
    blocked &&
    !next.captureAttempted &&
    age >= options.stackAfterMs &&
    now - (next.lastCaptureAt ?? -Infinity) >= options.stackCooldownMs;
  const write =
    blocked && (starting || capture || now - (next.lastWriteAt ?? 0) >= options.repeatMs);
  if (capture) {
    next.captureAttempted = true;
    next.lastCaptureAt = now;
  }
  if (write) next.lastWriteAt = now;
  const durationMs = ending ? Math.max(0, heartbeat - state.since!) : age;
  if (ending) {
    delete next.since;
    delete next.lastWriteAt;
    delete next.captureAttempted;
  }
  return {
    state: next,
    starting,
    capture,
    kind: ending ? ("unblocked" as const) : write ? ("blocked" as const) : undefined,
    durationMs,
  };
}

export async function captureMainThreadStack(
  session: Pick<
    NodeInspector.Session,
    "connectToMainThread" | "post" | "on" | "removeAllListeners" | "disconnect"
  >,
  timeoutMs = 2000,
) {
  const result: {
    frames: StackFrame[];
    captureMs: number;
    status?:
      | "stack_capture_timeout"
      | "stack_capture_unexpected_pause"
      | "stack_capture_error"
      | "stack-unavailable";
    pauseReason?: string;
  } = { frames: [], captureMs: 0 };
  let connected = false;
  let closed = false;
  let requested = false;
  let observed = false;
  let pausedAt: number | undefined;
  // V8 can pause on OOM while Debugger is enabled. Disable before disconnecting,
  // and never resume an unexpected pause into another near-limit pause.
  const close = () => {
    if (!connected || closed) return;
    closed = true;
    try {
      session.post("Debugger.disable", () => {});
    } catch {
      /* Disconnect is still required. */
    } finally {
      session.disconnect();
    }
  };
  let rejectCapture: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectCapture = () => reject(new Error("capture cancelled"));
  });
  const timer = setTimeout(() => {
    result.status = "stack_capture_timeout";
    close();
    rejectCapture();
  }, timeoutMs);
  const post = (method: string) =>
    new Promise<void>((resolve, reject) => {
      if (closed) {
        reject(new Error("capture closed"));
        return;
      }
      session.post(method, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  try {
    session.connectToMainThread();
    connected = true;
    const scripts = new Map<string, string>();
    session.on("Debugger.scriptParsed", (event) => {
      if (scripts.size < 4096) scripts.set(event.params.scriptId, event.params.url);
    });
    let resolvePause: (event: NodeInspector.Debugger.PausedEventDataType) => void = () => {};
    const paused = new Promise<NodeInspector.Debugger.PausedEventDataType>((resolve) => {
      resolvePause = resolve;
    });
    session.on("Debugger.paused", (event) => {
      if (event.params.reason !== "other" || !requested || observed) {
        result.status = "stack_capture_unexpected_pause";
        result.pauseReason = /^[a-zA-Z_-]{1,80}$/.test(event.params.reason)
          ? event.params.reason
          : "unexpected";
        result.frames = [];
        close();
        rejectCapture();
        return;
      }
      observed = true;
      pausedAt = performance.now();
      resolvePause(event.params);
    });
    await Promise.race([
      (async () => {
        await post("Debugger.enable");
        requested = true;
        await post("Debugger.pause");
        const event = await paused;
        if (closed) return;
        const safeName = (name: string) =>
          /^[\w.$ <>:/-]{0,160}$/.test(name) ? name : "anonymous";
        result.frames = event.callFrames.slice(0, 40).map((frame) => ({
          functionName: safeName(frame.functionName),
          url: safeName(
            (frame.url || scripts.get(frame.location.scriptId) || "")
              .split(/[?#]/)[0]!
              .replace(/\\/g, "/")
              .split("/")
              .at(-1) || "",
          ),
          lineNumber: frame.location.lineNumber + 1,
          columnNumber: frame.location.columnNumber ?? 0,
        }));
        await post("Debugger.resume");
      })(),
      cancelled,
    ]);
  } catch {
    result.status ??= connected ? "stack_capture_error" : "stack-unavailable";
    result.frames = [];
  } finally {
    clearTimeout(timer);
    close();
    session.removeAllListeners();
    if (pausedAt !== undefined) result.captureMs = performance.now() - pausedAt;
  }
  return result;
}

// Self-contained, like SpawnClient's worker: also works in Electron and the single-file CLI bundle.
export async function watchdogWorker(
  decide: typeof decideWatchdog,
  capture: typeof captureMainThreadStack,
) {
  const { workerData, parentPort } =
    (await import("node:worker_threads")) as typeof NodeWorkerThreads;
  const fs = await import("node:fs");
  const path = await import("node:path");
  const inspector = await import("node:inspector");
  const data = workerData as {
    shared: SharedArrayBuffer;
    filePath: string;
    options: WatchdogOptions;
    pid: number;
    bootId: string;
  };
  const { shared, filePath, options, pid, bootId } = data;
  const reportIntervalMs = Math.max(options.repeatMs, options.checkIntervalMs);
  const heartbeat = new BigInt64Array(shared, 0, 1);
  const header = new Int32Array(shared, 8, 2);
  const bytes = new Uint8Array(shared, 16);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  const write = (
    row:
      | BlockRecord
      | { kind: string; at: string; pid: number; bootId: string; pauseReason?: string },
  ) => {
    const line = JSON.stringify(row) + "\n";
    const length = Buffer.byteLength(line);
    if (size + length > 5 * 1024 * 1024) {
      fs.renameSync(filePath, filePath + ".1");
      size = 0;
    }
    // This file has one writer and deliberately never uses the main thread's sink.
    fs.appendFileSync(filePath, line, { mode: 0o600 });
    size += length;
    parentPort!.postMessage(row);
  };
  let snapshot: InFlightCall[] = [];
  const readRegistry = () => {
    const before = Atomics.load(header, 0);
    if (before % 2 !== 0) return snapshot;
    const length = Atomics.load(header, 1);
    if (length < 0 || length > bytes.length) return snapshot;
    const copy = bytes.slice(0, length);
    if (before !== Atomics.load(header, 0)) return snapshot;
    try {
      snapshot = JSON.parse(new TextDecoder().decode(copy));
    } catch {
      /* Keep the last complete snapshot during publication. */
    }
    return snapshot;
  };
  let stacksAvailable = true;
  const captureStack = async () => {
    if (!stacksAvailable) return { frames: [] as StackFrame[] };
    const result = await capture(new inspector.Session());
    if (result.status) {
      if (result.status === "stack-unavailable") stacksAvailable = false;
      write({
        kind: result.status,
        at: new Date().toISOString(),
        pid,
        bootId,
        ...(result.pauseReason ? { pauseReason: result.pauseReason } : {}),
      });
    }
    return result;
  };
  let state: WatchdogState = {};
  let inFlight: ReadonlyArray<InFlightCall> = [];
  let stack: { frames: ReadonlyArray<StackFrame>; captureMs?: number } = { frames: [] };
  let episode = "";
  let ticking = false;
  let stopping = false;
  parentPort!.on("message", (message) => {
    if (message === "stop") {
      stopping = true;
      clearInterval(timer);
      if (!ticking) parentPort!.close();
    }
  });
  const timer = setInterval(async () => {
    if (ticking || stopping) return;
    ticking = true;
    try {
      const now = performance.timeOrigin + performance.now();
      const beat = Number(Atomics.load(heartbeat, 0));
      const decision = decide(state, now, beat, options);
      state = decision.state;
      if (decision.starting) {
        inFlight = readRegistry();
        stack = { frames: [] };
        episode = `${bootId}:${beat}`;
      }
      if (decision.kind) {
        // Persist evidence even if connecting the inspector later fails or takes its deadline.
        if (decision.capture && decision.starting) {
          write({
            kind: "blocked",
            pid,
            bootId,
            reportIntervalMs,
            episode,
            at: new Date().toISOString(),
            blockedForMs: decision.durationMs,
            inFlight,
            ...stack,
          });
        }
        if (decision.capture) stack = await captureStack();
        write({
          kind: decision.kind,
          pid,
          bootId,
          reportIntervalMs,
          episode,
          at: new Date().toISOString(),
          blockedForMs: decision.durationMs,
          inFlight,
          ...stack,
        });
      }
    } catch {
      // Never crash the server or copy arbitrary native error text into diagnostics.
      parentPort!.postMessage({ kind: "watchdog-error" });
    } finally {
      ticking = false;
      if (stopping) parentPort!.close();
    }
  }, options.checkIntervalMs);
  parentPort!.postMessage({ kind: "ready" });
}
