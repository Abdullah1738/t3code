// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
import { observeExit } from "./process.ts";
import { shapedFetch } from "./network.ts";
import { assertRuntime } from "./runtime.ts";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
  mkdirSync,
  createWriteStream,
  statSync,
  cpSync,
  constants,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cpus, totalmem, platform, arch } from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import {
  CommandId,
  ThreadId,
  KanbanBoardId,
  KanbanDiscussionId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import { makeWsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";
import { phaseMetrics, appendLedger, hash, artifactHash, type Run } from "./metrics.ts";
const token = "synthetic-performance-credential-only";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// ext4 may fall back from FICLONE to a buffered multi-GB copy. Flush both
// inputs and clones before profiling so preparation writeback cannot contend
// with the measured WAL/checkpoint workload.
function flushFixtureDatabases(home: string) {
  for (const name of ["statev2.sqlite", "boards.sqlite", "archive.sqlite"]) {
    const fd = openSync(resolve(home, "userdata", name), "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
function dirtyPages() {
  if (process.platform !== "linux") return undefined;
  const memory = readFileSync("/proc/meminfo", "utf8");
  return {
    dirtyBytes: Number(memory.match(/^Dirty:\s+(\d+)/m)?.[1] ?? 0) * 1024,
    writebackBytes: Number(memory.match(/^Writeback:\s+(\d+)/m)?.[1] ?? 0) * 1024,
  };
}

export async function drive(
  home: string,
  sha: string,
  repeat: number,
  ledger: string,
  serverEntry = "apps/server/dist/bin.mjs",
  harnessHash?: string,
): Promise<Run> {
  assertRuntime();
  const attemptId = randomUUID();
  appendLedger(ledger + ".attempts", {
    attemptId,
    sha,
    repeat,
    status: "started",
    at: new Date().toISOString(),
  });
  let completed = false;
  const pristine = resolve(home);
  const runHome = mkdtempSync(resolve(tmpdir(), "robob-perf-run-"));
  let prepared = false;
  try {
    const sourceFixture = JSON.parse(readFileSync(resolve(pristine, "fixture.json"), "utf8"));
    if (sourceFixture.synthetic !== true) throw new Error("Synthetic fixture marker required");
    const dirtyBefore = dirtyPages();
    const syncStarted = performance.now();
    flushFixtureDatabases(pristine);
    const sourceSyncMs = performance.now() - syncStarted;
    const cloneStarted = performance.now();
    cpSync(pristine, runHome, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => path !== resolve(pristine, "perf"),
    });
    const cloneMs = performance.now() - cloneStarted;
    const dirtyBeforeCloneSync = dirtyPages();
    const cloneSyncStarted = performance.now();
    flushFixtureDatabases(runHome);
    appendLedger(ledger + ".preparation", {
      sha, repeat, sourceSyncMs, cloneMs,
      cloneSyncMs: performance.now() - cloneSyncStarted,
      dirtyBefore, dirtyBeforeCloneSync, dirtyAfterCloneSync: dirtyPages(),
    });
    home = runHome;
    const fixture = JSON.parse(readFileSync(resolve(home, "fixture.json"), "utf8"));
    if (fixture.synthetic !== true) throw new Error("Synthetic fixture marker required");
    const port = await new Promise<number>((ok, fail) => {
      const s = createServer();
      s.once("error", fail);
      s.listen(0, "127.0.0.1", () => {
        const p = s.address();
        s.close(() => (typeof p === "object" && p ? ok(p.port) : fail(new Error("port"))));
      });
    });
    prepared = true;
    return await drivePrepared(port, fixture);
  } finally {
    try {
      if (!prepared)
        appendLedger(ledger + ".attempts", {
          attemptId,
          sha,
          repeat,
          status: "failed",
          stage: "prepare",
        });
    } finally {
      rmSync(runHome, { recursive: true, force: true });
    }
  }
  async function drivePrepared(
    port: number,
    fixture: { agents: number; fixtureHash: string; seed: number; scale: string },
  ): Promise<Run> {
    const origin = `http://127.0.0.1:${port}`;
    mkdirSync(resolve(home, "perf"), { recursive: true });
    const log = createWriteStream(resolve(home, "perf", `server-${repeat}.log`));
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=8192",
        "--import",
        resolve("packages/perf-harness/src/sampler.ts"),
        resolve(serverEntry),
        "--base-dir",
        resolve(home),
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--mode",
        "web",
        "--dev-url",
        "http://127.0.0.1:9",
        "--no-browser",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: resolve(home),
          T3CODE_DEV_AUTH_TOKEN: token,
          T3CODE_TELEMETRY_ENABLED: "false",
          ROBOB_PERF_SAMPLE_FILE: resolve(home, "perf", `samples-${repeat}.json`),
          T3CODE_TRACE_FILE: resolve(home, "perf", `trace-${repeat}.ndjson`),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const lifetime = observeExit(child);
    const childExit = lifetime.exit;
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    const metrics: Record<string, number | null> = { rowsVisited: null };
    const gaps = [
      "Native paint/device timings unmeasured",
      "Driver body-delivery simulation: 10 Mbps / 100 ms RTT; native cursor resume unmeasured",
      "USB SSD/fsync latency unmeasured",
      "Rows visited unavailable from node:sqlite",
      "Durable commit boundary unavailable on base; response includes delivery",
    ];
    const actionIds = new Set<string>();
    const request = async (path: string, body?: unknown, measured = true) => {
      const start = performance.now(),
        actionId = randomUUID();
      if (measured && !path.includes("websocket-ticket")) actionIds.add(actionId);
      const response = await fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-robob-action-id": actionId,
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60000),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok)
        throw new Error(
          `${path}: HTTP ${response.status}: ${new TextDecoder().decode(bytes).slice(0, 500)}`,
        );
      return {
        value: JSON.parse(new TextDecoder().decode(bytes)),
        bytes: bytes.byteLength,
        ms: performance.now() - start,
      };
    };
    const measure = async (key: string, run: () => Promise<{ ms: number; bytes: number }>) => {
      const r = await run();
      metrics[key + ".response.ms"] = r.ms;
      metrics[key + ".bytes"] = r.bytes;
    };
    let stop = false;
    const background: Promise<void>[] = [];
    let backgroundFailure: unknown;
    let httpLoadStarted = false;
    const startHttpLoad = () => {
      httpLoadStarted = true;
            for (let agent = 0; agent < fixture.agents; agent++)
              background.push(
                (async () => {
                  while (!stop) {
                    await request(
                      `/api/ardud/kanban/discussions/synthetic-board-0-card-${1 + (agent % 3)}-discussion/messages`,
                      { text: `Synthetic load ${agent}` },
                      false,
                    );
                    await delay(500);
                  }
                })(),
              );
            for (const job of background)
              void job.catch((error) => {
                backgroundFailure = error;
                stop = true;
              });
    };
    try {
      let ticket: string | undefined;
      const until = Date.now() + 120000;
      while (!ticket && Date.now() < until) {
        if (lifetime.exited)
          throw new Error(
            `Synthetic server exited ${child.exitCode}; see ${home}/perf/server-${repeat}.log`,
          );
        try {
          ticket = (await request("/api/auth/websocket-ticket", {})).value.ticket;
        } catch {
          await delay(200);
        }
      }
      if (!ticket) throw new Error("Synthetic server readiness timed out");
      await new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error("Profiler start timeout")), 30000);
        const started = (message: { type?: string }) => {
          if (message.type === "perf-failed") { clearTimeout(timer); fail(new Error("Sampler start failed")); return; }
          if (message.type !== "perf-started") return;
          clearTimeout(timer); child.off("message", started); ok();
        };
        child.on("message", started);
        child.send({ type: "perf-start" });
      });
      const discussionId = "synthetic-board-0-card-0-discussion";
      if (process.env.ROBOB_PERF_LEGACY_BURST === "1") {
        gaps.push("Attribution-only legacy HTTP burst before WebSocket handshake");
        startHttpLoad();
      }
      const socket = Socket.layerWebSocket(
        `${origin.replace("http:", "ws:")}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION_TEXT}&wsTicket=${encodeURIComponent(ticket)}`,
      ).pipe(
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor, (url) => {
            const ws = new WebSocket(url);
            ws.addEventListener("message", (event) => {
              const bytes =
                typeof event.data === "string"
                  ? Buffer.byteLength(event.data)
                  : event.data instanceof ArrayBuffer
                    ? event.data.byteLength
                    : 0;
              metrics["ws.receivedPayloadBytes"] =
                (metrics["ws.receivedPayloadBytes"] ?? 0) + bytes;
            });
            return ws;
          }),
        ),
      );
      const protocol = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* makeWsRpcProtocolClient;
          // Establish the authenticated socket before introducing HTTP contention.
          yield* client["kanban.messages"]({
            discussionId: KanbanDiscussionId.make(discussionId), limit: 1,
          });
          if (!httpLoadStarted) startHttpLoad();
          const loadFibers = yield* Effect.forEach(
            Array.from({ length: fixture.agents }, (_, i) => i),
            (agent) =>
              Effect.gen(function* () {
                let tick = 0;
                while (!stop) {
                  yield* client["orchestration.dispatchCommand"]({
                    type: "thread.metadata.update",
                    commandId: CommandId.make(randomUUID()),
                    threadId: ThreadId.make(`synthetic-thread-${agent}`),
                    title: `Synthetic activity ${agent}:${++tick}`,
                  });
                  yield* Effect.sleep("500 millis");
                }
              }).pipe(Effect.forkScoped),
          );
          // Include sustained activity, not only the first admission burst.
          yield* Effect.sleep("10 seconds");
          const boardId = KanbanBoardId.make("synthetic-board-0");
          const boardAction = randomUUID(),
            listAction = randomUUID(),
            discussionAction = randomUUID();
          for (const id of [boardAction, listAction, discussionAction]) actionIds.add(id);
          const startedBoards = performance.now();
          const boards = yield* Stream.runHead(
            client["kanban.boards"]({}, { headers: { "x-robob-action-id": listAction } }),
          );
          metrics["boards.response.ms"] = performance.now() - startedBoards;
          metrics["boards.decodedBytes"] = Buffer.byteLength(JSON.stringify(boards));
          const startedBoard = performance.now();
          const board = yield* Stream.runHead(
            client["kanban.subscribe"](
              { boardId },
              { headers: { "x-robob-action-id": boardAction } },
            ),
          );
          metrics["board.response.ms"] = performance.now() - startedBoard;
          metrics["board.decodedBytes"] = Buffer.byteLength(JSON.stringify(board));
          const started = performance.now();
          const messages = yield* client["kanban.messages"]({
            discussionId: KanbanDiscussionId.make(discussionId),
            limit: 50,
          }).pipe(RpcClient.withHeaders({ "x-robob-action-id": discussionAction }));
          metrics["discussion.response.ms"] = performance.now() - started;
          metrics["discussion.decodedBytes"] = Buffer.byteLength(JSON.stringify(messages));
          yield* Effect.promise(() =>
            measure("post", () =>
              request(`/api/ardud/kanban/discussions/${discussionId}/messages`, {
                text: `Synthetic repeat ${repeat}`,
              }),
            ),
          );
          yield* Effect.promise(() =>
            measure("move", () =>
              request("/api/ardud/kanban/cards/synthetic-board-0-card-3/move", {
                to: "needs_owner",
                question: "Synthetic question",
              }),
            ),
          );
          yield* Effect.promise(() =>
            measure("mobile.coldFirstPage", () => request("/api/orchestration/shell?paged=true")),
          );
          const shapedPage = () => shapedFetch(() => fetch(origin + "/api/orchestration/shell?paged=true", {
            headers: { authorization: `Bearer ${token}`, [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
            signal: AbortSignal.timeout(60000),
          }));
          yield* Effect.promise(() => measure("mobile.shapedColdFirstPage", shapedPage));
          // Suspension drops the connection/cache in this HTTP-only fallback.
          // Keep the native resume gate missing until its cursor path is driven.
          yield* Effect.sleep("1 second");
          yield* Effect.promise(() => measure("mobile.shapedFullRefreshResume", shapedPage));
          metrics["mobile.coldFirstPage.p95.ms"] = null;
          metrics["mobile.resume.p95.ms"] = null;
          stop = true;
          yield* Effect.forEach(loadFibers, Fiber.join, { discard: true });
        }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("120 seconds")),
      );
      stop = true;
      await Promise.all(background);
      if (backgroundFailure) throw backgroundFailure;
      metrics["wal.bytes"] = (() => {
        try {
          return statSync(resolve(home, "userdata/statev2.sqlite-wal")).size;
        } catch {
          return 0;
        }
      })();
      await new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error("Sampler timeout")), 30000);
        child.on("message", (message: { type?: string }) => {
          if (message.type !== "perf-stopped") return;
          clearTimeout(timer);
          ok();
        });
        child.send({ type: "perf-stop" });
      });
      const samples = JSON.parse(
        readFileSync(resolve(home, "perf", `samples-${repeat}.json`), "utf8"),
      );
      metrics["eventLoop.p99.ms"] = samples.eventLoopP99Ms;
      metrics["server.rss.bytes"] = samples.rssBytes;
      metrics["eventLoop.max.ms"] = samples.eventLoopMaxMs;
      if (samples.profileError) gaps.push(`CPU profile unavailable: ${samples.profileError}`);
      let traceFlushed = true;
      child.kill("SIGTERM");
      await Promise.race([childExit, delay(30000)]);
      if (!lifetime.exited) {
        child.kill("SIGKILL");
        gaps.push("Server required forced shutdown; trace phases unmeasured");
        traceFlushed = false;
      }
      try {
        if (!traceFlushed) throw new Error("Unflushed trace");
        const spans = readFileSync(resolve(home, "perf", `trace-${repeat}.ndjson`), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const selected = new Set<string>(
          spans.filter((s) => actionIds.has(s.attributes?.["action.id"])).map((s) => s.spanId),
        );
        let changed = true;
        while (changed) {
          changed = false;
          for (const span of spans)
            if (selected.has(span.parentSpanId) && !selected.has(span.spanId)) {
              selected.add(span.spanId);
              changed = true;
            }
        }
        const phases = phaseMetrics(spans.filter((s) => selected.has(s.spanId)));
        for (const [name, distribution] of Object.entries(phases))
          metrics[`phase.${name}.p95.ms`] = distribution?.p95 ?? null;
      } catch {
        gaps.push("Trace flush not available before shutdown");
      }
      appendLedger(ledger + ".environment", {
        sha,
        repeat,
        node: process.version,
        sqlite: process.versions.sqlite,
        cpu: cpus()[0]?.model,
        cpuCount: cpus().length,
        ramBytes: totalmem(),
        platform: platform(),
        arch: arch(),
      });
      const run: Run = {
        workloadMode: process.env.ROBOB_PERF_LEGACY_BURST === "1" ? "legacy-burst" : "steady",
        sha,
        ...(harnessHash ? { harnessHash } : {}),
        serverHash: await artifactHash(resolve(serverEntry)),
        repeat,
        fixtureHash: fixture.fixtureHash,
        runtimeHash: hash({ node: process.version, sqlite: process.versions.sqlite }),
        hardwareHash: hash({
          cpu: cpus()[0]?.model,
          count: cpus().length,
          totalmem: totalmem(),
          platform: platform(),
          arch: arch(),
        }),
        seed: fixture.seed,
        scale: fixture.scale,
        agents: fixture.agents,
        correctness: "unmeasured",
        metrics,
        gaps,
      };
      appendLedger(ledger, run);
      completed = true;
      return run;
    } finally {
      appendLedger(ledger + ".attempts", {
        attemptId,
        sha,
        repeat,
        status: completed ? "completed" : "failed",
        at: new Date().toISOString(),
      });
      stop = true;
      await Promise.allSettled(background);
      // Preserve CPU evidence on timeouts and failed actions too.
      if (!lifetime.exited && !existsSync(resolve(home, "perf", `samples-${repeat}.json`))) {
        await new Promise<void>((ok) => {
          const timer = setTimeout(ok, 30000);
          child.once("message", () => { clearTimeout(timer); ok(); });
          child.send({ type: "perf-stop" });
        });
      }
      if (!lifetime.exited) {
        child.kill("SIGTERM");
        await Promise.race([childExit, delay(30000)]);
        if (!lifetime.exited) {
          child.kill("SIGKILL");
          await childExit;
        }
      }
      log.end();
      cpSync(resolve(home, "perf"), resolve(ledger + ".artifacts", `repeat-${repeat}-${attemptId}`), {
        recursive: true,
      });
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [home, sha, ledger, repeats = "5", entry = "apps/server/dist/bin.mjs"] =
    process.argv.slice(2);
  for (let i = 0; i < Number(repeats); i++) {
    try { console.log(await drive(home!, sha!, i, ledger!, entry)); }
    catch (error) {
      appendLedger(ledger! + ".failures", { sha, repeat: i, status: "failed", error: String(error) });
      console.error(error);
      process.exitCode = 1;
    }
  }
}
