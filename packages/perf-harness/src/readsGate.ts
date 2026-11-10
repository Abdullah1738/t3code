// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
/**
 * Reads gate: do interactive reads inherit a long background read's wait?
 *
 * One run boots a server artifact on a fresh clone of a synthetic fixture and
 *  1. measures every probe idle,
 *  2. starts `holders` loops of the control API's full thread listing (an
 *     unpaged shell snapshot, the 9 Nov 19 s background holder) and measures
 *     the same probes while they hold the statev2 reader,
 *  3. aborts a burst of foreground requests mid-flight (client disconnects)
 *     and measures again,
 *  4. samples the server process tree's RSS, threads and disk I/O per phase.
 *
 * Probes: foreground views (shell page, thread bounded snapshot, thread
 * transcript, board snapshot over WS, discussion messages over WS), reserved
 * lanes (session auth, identity resolve) and a small indexed background read.
 *
 * usage: node packages/perf-harness/src/readsGate.ts FIXTURE LABEL SERVER_ENTRY OUT.json [default|off]
 *   `off` boots with ROBOB_STATEV2_FOREGROUND_READERS=0 and ROBOB_BOARDS_FOREGROUND_READERS=0.
 * No production database is read: the fixture must carry the synthetic marker.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  constants,
  cpSync,
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import {
  KanbanBoardId,
  KanbanDiscussionId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import { makeWsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";
import { artifactHash, percentiles } from "./metrics.ts";
import { observeExit } from "./process.ts";

const token = "synthetic-performance-credential-only";
const dist = (values: ReadonlyArray<number>) => {
  const d = percentiles(values);
  return { n: values.length, p50: d?.p50 ?? 0, p95: d?.p95 ?? 0, p99: d?.p99 ?? 0, max: d?.max ?? 0 };
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const readsGateWorkload = {
  version: 1,
  idleRounds: 20,
  holders: 2,
  holderWarmupMs: 1500,
  loadedMs: 40_000,
  roundGapMs: 400,
  abortBurst: 16,
  abortAfterMs: 30,
  afterAbortRounds: 10,
} as const;

export const FOREGROUND_PROBES = ["shell", "thread", "transcript", "board", "messages"] as const;
export const RESERVED_PROBES = ["auth", "identity"] as const;
export const BACKGROUND_PROBES = ["backgroundSmall"] as const;
export type Probe =
  | (typeof FOREGROUND_PROBES)[number]
  | (typeof RESERVED_PROBES)[number]
  | (typeof BACKGROUND_PROBES)[number];

interface ResourceSample {
  readonly at: string;
  readonly rssBytes: number;
  readonly hwmBytes: number;
  readonly threads: number;
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly processes: number;
}

// Linux only: the server pid plus every descendant (reader workers are threads; auth readers may be processes).
function sampleTree(root: number, at: string): ResourceSample | null {
  if (process.platform !== "linux") return null;
  const parents = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(name), Number(fields[1]));
    } catch {
      // exited
    }
  }
  const tree = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parents)
      if (!tree.has(pid) && tree.has(ppid)) {
        tree.add(pid);
        grew = true;
      }
  }
  let rss = 0,
    hwm = 0,
    threads = 0,
    readBytes = 0,
    writeBytes = 0;
  for (const pid of tree) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      rss += Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
      hwm += Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024;
      threads += Number(status.match(/^Threads:\s+(\d+)/m)?.[1] ?? 0);
      const io = readFileSync(`/proc/${pid}/io`, "utf8");
      readBytes += Number(io.match(/^read_bytes:\s+(\d+)/m)?.[1] ?? 0);
      writeBytes += Number(io.match(/^write_bytes:\s+(\d+)/m)?.[1] ?? 0);
    } catch {
      // exited
    }
  }
  return { at, rssBytes: rss, hwmBytes: hwm, threads, readBytes, writeBytes, processes: tree.size };
}

export interface ReadsGateRun {
  readonly label: string;
  readonly lanes: "default" | "off";
  readonly workload: typeof readsGateWorkload;
  readonly fixtureHash: string;
  readonly artifactHash: string;
  readonly startedAt: string;
  readonly host: { readonly cpus: number; readonly memBytes: number; readonly node: string };
  readonly probes: Record<string, Record<string, Array<number>>>;
  readonly failures: Record<string, Array<string>>;
  readonly holders: { readonly idleMs: number; readonly loadedMs: Array<number>; readonly failures: number };
  readonly aborted: { readonly issued: number; readonly completedBeforeAbort: number };
  readonly resources: Array<ResourceSample>;
  readonly summary: Record<string, Record<string, { n: number; p50: number; p95: number; p99: number; max: number }>>;
}

export async function readsGate(
  fixtureDir: string,
  label: string,
  serverEntry: string,
  lanes: "default" | "off" = "default",
): Promise<ReadsGateRun> {
  const pristine = resolve(fixtureDir);
  const fixture = JSON.parse(readFileSync(resolve(pristine, "fixture.json"), "utf8"));
  if (fixture.synthetic !== true) throw new Error("Synthetic fixture marker required");
  const home = mkdtempSync(resolve(tmpdir(), "robob-reads-gate-"));
  try {
    cpSync(pristine, home, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => path !== resolve(pristine, "perf"),
    });
    const port = await new Promise<number>((ok, fail) => {
      const s = createServer();
      s.once("error", fail);
      s.listen(0, "127.0.0.1", () => {
        const p = s.address();
        s.close(() => (typeof p === "object" && p ? ok(p.port) : fail(new Error("port"))));
      });
    });
    const origin = `http://127.0.0.1:${port}`;
    const logPath = resolve(home, `server-${label}.log`);
    const log = createWriteStream(logPath);
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=8192",
        resolve(serverEntry),
        "--base-dir",
        home,
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
          HOME: home,
          T3CODE_DEV_AUTH_TOKEN: token,
          T3CODE_TELEMETRY_ENABLED: "false",
          T3CODE_TRACE_FILE: resolve(home, "trace.ndjson"),
          ...(lanes === "off"
            ? { ROBOB_STATEV2_FOREGROUND_READERS: "0", ROBOB_BOARDS_FOREGROUND_READERS: "0" }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const lifetime = observeExit(child);
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    const probes: Record<string, Record<string, Array<number>>> = {};
    const failures: Record<string, Array<string>> = {};
    const record = (phase: string, probe: string, ms: number) =>
      ((probes[phase] ??= {})[probe] ??= []).push(ms);
    const fail = (probe: string, error: unknown) =>
      (failures[probe] ??= []).push(String(error instanceof Error ? error.message : error).slice(0, 300));
    const resources: Array<ResourceSample> = [];
    const sample = (at: string) => {
      const s = child.pid === undefined ? null : sampleTree(child.pid, at);
      if (s !== null) resources.push(s);
    };
    const request = async (path: string, signal?: AbortSignal) => {
      const start = performance.now();
      const response = await fetch(origin + path, {
        headers: {
          authorization: `Bearer ${token}`,
          "x-robob-action-id": randomUUID(),
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        },
        signal: signal ?? AbortSignal.timeout(120_000),
      });
      const body = await response.arrayBuffer();
      if (!response.ok)
        throw new Error(`${path}: HTTP ${response.status} ${new TextDecoder().decode(body).slice(0, 200)}`);
      return performance.now() - start;
    };
    const post = async (path: string, body: unknown) => {
      const response = await fetch(origin + path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.json() as Promise<{ ticket: string }>;
    };
    try {
      let ticket: string | undefined;
      const until = Date.now() + 180_000;
      while (!ticket && Date.now() < until) {
        if (lifetime.exited) throw new Error(`server exited ${child.exitCode}; see ${logPath}`);
        try {
          ticket = (await post("/api/auth/websocket-ticket", {})).ticket;
        } catch {
          await delay(250);
        }
      }
      if (!ticket) throw new Error("server readiness timed out");
      const socket = Socket.layerWebSocket(
        `${origin.replace("http:", "ws:")}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION_TEXT}&wsTicket=${encodeURIComponent(ticket)}`,
      ).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, (url) => new WebSocket(url))));
      const protocol = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)),
      );
      const boardId = KanbanBoardId.make("synthetic-board-0");
      const discussionId = KanbanDiscussionId.make("synthetic-board-0-card-0-discussion");
      const thread = "synthetic-thread-1";
      const holders = { idleMs: 0, loadedMs: [] as Array<number>, failures: 0 };
      const aborted = { issued: 0, completedBeforeAbort: 0 };
      await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* makeWsRpcProtocolClient;
          const timed = <A, E>(effect: Effect.Effect<A, E>) =>
            Effect.suspend(() => {
              const start = performance.now();
              return Effect.map(effect, () => performance.now() - start);
            });
          const run: Record<Probe, () => Promise<number>> = {
            shell: () => request("/api/orchestration/shell?paged=true"),
            thread: () => request(`/api/orchestration/threads/${thread}/bounded`),
            transcript: () => request(`/api/orchestration/threads/${thread}/transcript`),
            board: () =>
              Effect.runPromise(timed(Stream.runHead(client["kanban.subscribe"]({ boardId })))),
            messages: () =>
              Effect.runPromise(timed(client["kanban.messages"]({ discussionId, limit: 50 }))),
            auth: () => request("/api/auth/session"),
            identity: () =>
              request("/api/ardud/control/identity/resolve?nativeId=synthetic-native-unknown"),
            backgroundSmall: () =>
              request(
                `/api/ardud/control/threads?limit=5&updatedSince=${encodeURIComponent("2025-12-31T00:00:00.000Z")}`,
              ),
          };
          const all = [...FOREGROUND_PROBES, ...RESERVED_PROBES, ...BACKGROUND_PROBES] as const;
          const round = (phase: string) =>
            Promise.all(
              all.map(async (probe) => {
                try {
                  record(phase, probe, await run[probe]());
                } catch (error) {
                  fail(probe, error);
                }
              }),
            );
          yield* Effect.promise(async () => {
            // Warm every path (and its prepared statements) once.
            for (const probe of all) await run[probe]();
            holders.idleMs = await request("/api/ardud/control/threads");
            sample("idle-start");
            for (let i = 0; i < readsGateWorkload.idleRounds; i++) {
              await round("idle");
              await delay(readsGateWorkload.roundGapMs);
            }
            sample("idle-end");
            let stop = false;
            const loops = Array.from({ length: readsGateWorkload.holders }, async () => {
              while (!stop) {
                try {
                  holders.loadedMs.push(await request("/api/ardud/control/threads"));
                } catch {
                  holders.failures++;
                }
              }
            });
            await delay(readsGateWorkload.holderWarmupMs);
            const loadedUntil = performance.now() + readsGateWorkload.loadedMs;
            while (performance.now() < loadedUntil) {
              await round("loaded");
              await delay(readsGateWorkload.roundGapMs);
            }
            sample("loaded-end");
            // Client disconnects: requests aborted while their reads queue or run.
            await Promise.all(
              Array.from({ length: readsGateWorkload.abortBurst }, async (_, index) => {
                aborted.issued++;
                const path =
                  index % 2 === 0
                    ? "/api/orchestration/shell?paged=true"
                    : `/api/orchestration/threads/${thread}/bounded`;
                try {
                  await request(path, AbortSignal.timeout(readsGateWorkload.abortAfterMs));
                  aborted.completedBeforeAbort++;
                } catch {
                  // aborted, as intended
                }
              }),
            );
            for (let i = 0; i < readsGateWorkload.afterAbortRounds; i++) {
              await round("afterAbort");
              await delay(readsGateWorkload.roundGapMs);
            }
            stop = true;
            await Promise.all(loops);
            sample("end");
          });
        }).pipe(Effect.provide(protocol), Effect.scoped),
      );
      const summary: ReadsGateRun["summary"] = {};
      for (const [phase, byProbe] of Object.entries(probes))
        for (const [probe, values] of Object.entries(byProbe))
          (summary[phase] ??= {})[probe] = dist(values);
      (summary.holders ??= {}).loaded = dist(holders.loadedMs);
      return {
        label,
        lanes,
        workload: readsGateWorkload,
        fixtureHash: String(fixture.fixtureHash ?? ""),
        artifactHash: await artifactHash(resolve(serverEntry)),
        startedAt: new Date().toISOString(),
        host: { cpus: cpus().length, memBytes: totalmem(), node: process.version },
        probes,
        failures,
        holders,
        aborted,
        resources,
        summary,
      };
    } finally {
      child.kill("SIGTERM");
      await Promise.race([lifetime.exit, delay(15_000)]);
      if (!lifetime.exited) child.kill("SIGKILL");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [fixtureDir, label, entry, out, lanes] = process.argv.slice(2);
  if (!fixtureDir || !label || !entry || !out) {
    console.error("usage: readsGate.ts FIXTURE LABEL SERVER_ENTRY OUT.json [default|off]");
    process.exit(2);
  }
  if (!existsSync(entry)) throw new Error(`missing server entry ${entry}`);
  const result = await readsGate(fixtureDir, label, entry, lanes === "off" ? "off" : "default");
  writeFileSync(out, JSON.stringify(result, null, 1));
  const line = (phase: string) =>
    Object.entries(result.summary[phase] ?? {})
      .map(([probe, s]) => `${probe} p50=${Math.round(s.p50)} p95=${Math.round(s.p95)}`)
      .join(" | ");
  console.log(`[${label}] idle: ${line("idle")}`);
  console.log(`[${label}] loaded: ${line("loaded")}`);
  console.log(`[${label}] holders idle=${Math.round(result.holders.idleMs)}ms loaded n=${result.holders.loadedMs.length}`);
}
