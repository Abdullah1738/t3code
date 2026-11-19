// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- integration fixture uses an isolated native main thread and reports measured overhead.
import { describe, expect, it } from "@effect/vitest";
import * as NodeInspector from "node:inspector";
import { vi } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AnalyticsEvent } from "@t3tools/contracts";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as ServerConfig from "../config.ts";
import {
  layer,
  MainThreadWatchdog,
  recordUnblocked,
  defaultOptions,
  makeRegistry,
} from "./MainThreadWatchdog.ts";
import {
  captureMainThreadStack,
  decideWatchdog,
  type WatchdogState,
} from "./mainThreadWatchdogWorker.ts";

const decodeAnalyticsEvent = Schema.decodeUnknownEffect(AnalyticsEvent);

const options = {
  ...defaultOptions,
  blockedAfterMs: 200,
  stackAfterMs: 300,
  repeatMs: 500,
  stackCooldownMs: 1000,
};

describe("main-thread watchdog decisions", () => {
  it("starts, captures once, repeats, and ends using heartbeat time", () => {
    let state: WatchdogState = {};
    const tick = (now: number, heartbeat = 1000) => {
      const result = decideWatchdog(state, now, heartbeat, options);
      state = result.state;
      return result;
    };
    expect(tick(1199).kind).toBeUndefined();
    expect(tick(1200)).toMatchObject({ kind: "blocked", capture: false, starting: true });
    expect(tick(1300)).toMatchObject({ kind: "blocked", capture: true });
    expect(tick(1799).kind).toBeUndefined();
    expect(tick(1800)).toMatchObject({ kind: "blocked", capture: false });
    expect(tick(1820, 1810)).toMatchObject({ kind: "unblocked", durationMs: 810 });
    expect(tick(1830, 1810).kind).toBeUndefined();
    expect(tick(2010, 1810).capture).toBe(false);
    expect(tick(2110, 1810).capture).toBe(false);
    expect(tick(2300, 1810).capture).toBe(true);
    expect(tick(5000, 1810).capture).toBe(false);
  });
  it("does not capture short episodes and tolerates a future heartbeat", () => {
    const first = decideWatchdog({}, 1200, 1000, options);
    expect(decideWatchdog(first.state, 1250, 1240, options).capture).toBe(false);
    expect(decideWatchdog({}, 1000, 1001, options).kind).toBeUndefined();
  });
});

it("publishes bounded oldest calls, ids only, and releases them idempotently", () => {
  const registry = makeRegistry();
  const read = () =>
    JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(registry.shared, 16, new Int32Array(registry.shared, 8, 2)[1]),
      ),
    );
  const finish = registry.enter(
    "board_activity",
    { boardId: "board-test", card: "a private prompt", prompt: "secret" },
    "thread:test",
  );
  expect(read()).toEqual([
    {
      tool: "board_activity",
      boardId: "board-test",
      callerThreadId: "thread:test",
      startedAt: expect.any(String),
    },
  ]);
  for (let i = 0; i < 200; i++)
    registry.enter("card_get", { card: `#${i + 1}`, boardId: "x".repeat(512) });
  expect(read().length).toBeGreaterThan(0);
  expect(read().length).toBeLessThanOrEqual(16);
  expect(read()[0].tool).toBe("board_activity");
  expect(JSON.stringify(read())).not.toMatch(/secret|private|prompt/);
  finish();
  finish();
  expect(read()[0].tool).toBe("card_get");
});

it("records a real main-thread block and stack before recovery", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "main-thread-watchdog-"));
  const filePath = NodePath.join(dir, "main-thread-blocked.ndjson");
  const moduleUrl = new URL("./MainThreadWatchdog.ts", import.meta.url).href;
  const source = `
    import { startWatchdog, defaultOptions, makeRegistry } from ${JSON.stringify(moduleUrl)};
    import fs from 'node:fs';
    const keepAlive = setTimeout(() => { throw new Error('watchdog fixture deadline'); }, 10000);
    let recovered;
    const unblocked = new Promise(resolve => recovered = resolve);
    const rows = [];
    const watchdog = startWatchdog(${JSON.stringify(filePath)}, {
      ...defaultOptions, blockedAfterMs: 200, stackAfterMs: 300, checkIntervalMs: 25, heartbeatMs: 25,
    }, row => { rows.push(row); if (row.kind === 'unblocked') recovered(); });
    try {
      await watchdog.ready;
      const finish = watchdog.enter('board_activity', { boardId: 'board-test' });
      watchdog.beat();
      function testBlockingLoop() {
        const until = performance.now() + 1500;
        while (performance.now() < until) { Math.sqrt(performance.now()); }
      }
      testBlockingLoop();
      const endedAt = Date.now();
      const during = fs.readFileSync(${JSON.stringify(filePath)}, 'utf8');
      finish();
      await unblocked;
      const registry = makeRegistry();
      const start = performance.now();
      for (let i=0; i<10000; i++) {
        const done = registry.enter('board_activity', { boardId: 'board-test' }, 'thread:test');
        registry.beat(); done();
      }
      console.log(JSON.stringify({ rows, during, endedAt, perCallUs: (performance.now()-start)*1000/10000 }));
    } finally { await watchdog.stop(); clearTimeout(keepAlive); }
  `;
  try {
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      process.execPath,
      ["--input-type=module", "-e", source],
      { timeout: 15_000 },
    );
    const result = JSON.parse(stdout);
    const during = result.during
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    const captured = during.find((row: { frames?: Array<{ functionName: string }> }) =>
      row.frames?.some((frame) => frame.functionName === "testBlockingLoop"),
    );
    expect(captured).toMatchObject({
      kind: "blocked",
      bootId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      reportIntervalMs: defaultOptions.repeatMs,
      inFlight: [{ tool: "board_activity", boardId: "board-test", startedAt: expect.any(String) }],
    });
    expect(Date.parse(captured.at)).toBeLessThan(result.endedAt);
    expect(captured.captureMs).toBeGreaterThanOrEqual(0);
    expect(result.rows.filter((row: { kind: string }) => row.kind === "unblocked")).toHaveLength(1);
    expect(result.rows.at(-1).blockedForMs).toBeGreaterThanOrEqual(1400);
    console.log(
      `watchdog overhead: registry enter/exit + heartbeat ${result.perCallUs.toFixed(2)} us/call; inspector pause ${captured.captureMs.toFixed(2)} ms`,
    );
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

it.effect("kill switch skips worker startup without consulting server paths or analytics", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(layer).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3_MAIN_THREAD_WATCHDOG: "0" } })),
          ServerConfig.layerTest("/workspace", { prefix: "watchdog-disabled-" }),
          Layer.mock(Analytics.Analytics)({}),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
    const finish = Context.get(context, MainThreadWatchdog).enter("board_activity", {
      boardId: "board-test",
    });
    expect(finish()).toBeUndefined();
  }),
);

it.effect("records recovery metadata through the retained analytics schema", () =>
  Effect.gen(function* () {
    const events: AnalyticsEvent[] = [];
    yield* recordUnblocked({
      kind: "unblocked",
      pid: 12,
      bootId: "8d0efaf9-5dd4-400f-9db1-8308e5a591b0",
      reportIntervalMs: 30_000,
      episode: "12:1",
      at: "2026-11-18T03:00:00.000Z",
      blockedForMs: 7000,
      inFlight: [
        { tool: "board_activity", boardId: "board-test", startedAt: "2026-11-18T02:59:53.000Z" },
      ],
      frames: [
        { functionName: "testBlockingLoop", url: "test.ts", lineNumber: 12, columnNumber: 4 },
      ],
    }).pipe(
      Effect.provide(
        Layer.mock(Analytics.Analytics)({
          record: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        }),
      ),
    );
    expect(events).toHaveLength(1);
    const decoded = yield* decodeAnalyticsEvent(events[0]);
    expect(decoded).toMatchObject({
      kind: "server.main_thread_blocked",
      durationMs: 7000,
      props: {
        tools: ["board_activity"],
        boardIds: ["board-test"],
        frames: [{ functionName: "testBlockingLoop" }],
      },
    });
  }),
);

it.each(["OOM", "exception", "ambiguous", "assert", "debugCommand", "other-before-request"])(
  "disables and disconnects an unexpected %s pause without resuming",
  async (reason) => {
    const session = new NodeInspector.Session();
    const calls: string[] = [];
    vi.spyOn(session, "connectToMainThread").mockImplementation(() => {});
    vi.spyOn(session, "disconnect").mockImplementation(() => {
      calls.push("disconnect");
    });
    vi.spyOn(session, "post").mockImplementation(((
      method: string,
      callback: (error: Error | null) => void,
    ) => {
      calls.push(method);
      if (method === (reason === "other-before-request" ? "Debugger.enable" : "Debugger.pause"))
        session.emit("Debugger.paused", {
          params: { reason: reason === "other-before-request" ? "other" : reason, callFrames: [] },
        });
      callback(null);
    }) as NodeInspector.Session["post"]);
    const result = await captureMainThreadStack(session);
    expect(result.status).toBe("stack_capture_unexpected_pause");
    expect(result.frames).toEqual([]);
    expect(calls.slice(-2)).toEqual(["Debugger.disable", "disconnect"]);
    expect(calls).not.toContain("Debugger.resume");
  },
);

it("bounds a missing inspector pause and cleans up at the hard deadline", async () => {
  vi.useFakeTimers();
  try {
    const session = new NodeInspector.Session();
    const calls: string[] = [];
    vi.spyOn(session, "connectToMainThread").mockImplementation(() => {});
    vi.spyOn(session, "disconnect").mockImplementation(() => {
      calls.push("disconnect");
    });
    vi.spyOn(session, "post").mockImplementation(((
      method: string,
      callback: (error: Error | null) => void,
    ) => {
      calls.push(method);
      callback(null);
    }) as NodeInspector.Session["post"]);
    const capture = captureMainThreadStack(session, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await capture).status).toBe("stack_capture_timeout");
    expect(calls.slice(-2)).toEqual(["Debugger.disable", "disconnect"]);
    expect(calls).not.toContain("Debugger.resume");
  } finally {
    vi.useRealTimers();
  }
});
