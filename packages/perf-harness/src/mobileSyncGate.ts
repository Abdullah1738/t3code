// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
/**
 * Mobile sync gate: what a phone pays to get its thread list in sync and to open a thread,
 * on a synthetic fixture, over the driver's 10 Mbps / 100 ms RTT delivery simulation.
 *
 * It follows the client (packages/client-runtime/src/state/shell.ts):
 *
 * - cold sync: every paged shell page over HTTP (no idle-subagent omission: the mobile app
 *   does not ask for it), then the socket subscription resumed from the oldest page's
 *   sequence, until the server's `synchronized` marker. A writer keeps appending events
 *   meanwhile, as agents do on the live server;
 * - resume: the socket dropped while events kept arriving (app in the background), then one
 *   resubscribe from the last applied sequence, for several gap sizes;
 * - thread open: the bounded thread window over HTTP while shell loads are in flight.
 *
 * HTTP bodies are paced by `shapedFetch`. Socket frames are not paced; their link time is
 * added arithmetically (one round trip + bytes at the link rate) and reported separately.
 *
 * usage: node packages/perf-harness/src/mobileSyncGate.ts FIXTURE LABEL OUT.json
 * env:   ROBOB_PERF_SERVER_ENTRY (default apps/server/src/bin.ts), ROBOB_PERF_WRITES_PER_S
 *        (default 100), ROBOB_PERF_RECENT_FIRST=1 (ask for the recent page first, as a
 *        client built from this tree does); any other ROBOB_* switch is passed to the server.
 * The same file runs unchanged in the base tree (copy it there).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

// oxlint-disable-next-line t3code/no-rpc-permission-bypass -- The perf harness drives the raw WS protocol exactly as the mobile client does.
import { makeWsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";
import { mobileLink, shapedFetch } from "./network.ts";
import { configureOwnerAnswerMock } from "./ownerAnswerFixture.ts";
import { observeExit } from "./process.ts";

const [fixtureDir, label, out] = process.argv.slice(2);
if (!fixtureDir || !label || !out) {
  console.error("usage: mobileSyncGate.ts FIXTURE LABEL OUT.json");
  process.exit(2);
}

export const mobileSyncWorkload = {
  version: 1,
  recentThreads: 50,
  // The live server was 4,000+ events ahead when a 4-minute page load reached its socket
  // subscribe. The synthetic load finishes in seconds, so the rate is set to put the same
  // subscribe well past the 1,000-event replay gap.
  writesPerSecond: Number(process.env.ROBOB_PERF_WRITES_PER_S ?? 100),
  writerThreads: 32,
  resumeGaps: [200, 3_000, 12_000],
  resumeRepeats: 3,
  threadOpens: 40,
  shellLoaders: 3,
} as const;

// A client built from this tree asks for the most recently updated threads first; the
// installed mobile app does not. Older servers ignore the option.
const recentFirst = process.env.ROBOB_PERF_RECENT_FIRST === "1";
const token = "synthetic-performance-credential-only";
const delay = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const pct = (values: ReadonlyArray<number>, p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};
const linkMs = (bytes: number) => mobileLink.rttMs + (bytes * 8) / (mobileLink.mbps * 1000);

const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.resolve(fixtureDir, "fixture.json"), "utf8"),
);
if (fixture.synthetic !== true) throw new Error("Synthetic fixture marker required");
const home = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "robob-mobile-sync-"));
NodeFS.cpSync(NodePath.resolve(fixtureDir), home, {
  recursive: true,
  mode: NodeFS.constants.COPYFILE_FICLONE,
  filter: (path) => path !== NodePath.resolve(fixtureDir, "perf"),
});
NodeFS.mkdirSync(NodePath.resolve(home, "perf"), { recursive: true });
const mockScript = NodePath.resolve("apps/server/scripts/acp-mock-agent.ts");
if (NodeFS.existsSync(mockScript)) configureOwnerAnswerMock(home, mockScript);

const port = await new Promise<number>((ok, fail) => {
  const s = NodeNet.createServer();
  s.once("error", fail);
  s.listen(0, "127.0.0.1", () => {
    const p = s.address();
    s.close(() => (typeof p === "object" && p ? ok(p.port) : fail(new Error("port"))));
  });
});
const origin = `http://127.0.0.1:${port}`;
const serverEntry = process.env.ROBOB_PERF_SERVER_ENTRY ?? "apps/server/src/bin.ts";
const switches = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => name.startsWith("ROBOB_") && !name.startsWith("ROBOB_PERF_"),
  ),
);
const log = NodeFS.createWriteStream(NodePath.resolve(home, "perf", "server.log"));
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    "--max-old-space-size=8192",
    NodePath.resolve(serverEntry),
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
      ...switches,
      PATH: process.env.PATH,
      HOME: home,
      T3CODE_DEV_AUTH_TOKEN: token,
      T3CODE_TELEMETRY_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const lifetime = observeExit(child);
child.stdout?.pipe(log);
child.stderr?.pipe(log);

const headers = {
  authorization: `Bearer ${token}`,
  [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
};
const getJson = async (path: string, body?: unknown) => {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

interface ShellPage {
  readonly snapshotSequence: number;
  readonly threads: ReadonlyArray<{ readonly id: string }>;
  readonly page?: { readonly nextAfter: string | null };
}

/** One paged load, as the client runs it. `shaped` paces each body at the mobile link rate. */
const pagedLoad = async (input: {
  readonly shaped: boolean;
  readonly recent?: ReadonlySet<string>;
  readonly stop?: () => boolean;
}) => {
  const started = performance.now();
  const pages: Array<{ ms: number; bytes: number; threads: number }> = [];
  const seen = new Set<string>();
  let minSequence = Number.POSITIVE_INFINITY;
  let after: string | undefined;
  let recentCompleteMs: number | null = null;
  let recentCompletePage: number | null = null;
  while (input.stop?.() !== true) {
    const path = `/api/orchestration/shell?paged=true${recentFirst ? "&recentFirst=true" : ""}${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`;
    const pageStarted = performance.now();
    let text = "";
    let bytes = 0;
    if (input.shaped) {
      const result = await shapedFetch(async () => {
        const response = await fetch(origin + path, {
          headers,
          signal: AbortSignal.timeout(120_000),
        });
        // The shaped reader paces the body; keep a copy to decode the cursor.
        const [paced, copy] = response.body!.tee();
        void new Response(copy).text().then((value) => (text = value));
        return new Response(paced, { status: response.status });
      });
      bytes = result.bytes;
      // The copy settles with the paced branch.
      for (let i = 0; i < 100 && text.length === 0; i++) await delay(5);
    } else {
      const response = await fetch(origin + path, {
        headers,
        signal: AbortSignal.timeout(120_000),
      });
      text = await response.text();
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      bytes = Buffer.byteLength(text);
    }
    const page = JSON.parse(text) as ShellPage;
    for (const thread of page.threads) seen.add(thread.id);
    minSequence = Math.min(minSequence, page.snapshotSequence);
    pages.push({ ms: performance.now() - pageStarted, bytes, threads: page.threads.length });
    if (
      input.recent !== undefined &&
      recentCompleteMs === null &&
      [...input.recent].every((id) => seen.has(id))
    ) {
      recentCompleteMs = performance.now() - started;
      recentCompletePage = pages.length;
    }
    const next = page.page?.nextAfter ?? null;
    if (next === null) break;
    after = next;
  }
  return {
    ms: performance.now() - started,
    pages: pages.length,
    bytes: pages.reduce((sum, page) => sum + page.bytes, 0),
    threads: seen.size,
    firstPageMs: pages[0]?.ms ?? null,
    firstPageBytes: pages[0]?.bytes ?? null,
    pageMsP50: pct(
      pages.map((page) => page.ms),
      0.5,
    ),
    pageMsP95: pct(
      pages.map((page) => page.ms),
      0.95,
    ),
    recentCompleteMs,
    recentCompletePage,
    minSequence,
  };
};

const result: Record<string, unknown> = {
  label,
  workload: mobileSyncWorkload,
  link: mobileLink,
  fixture: { scale: fixture.scale, threads: fixture.threads, hash: fixture.fixtureHash },
  host: { cpus: NodeOS.cpus().length, node: process.version },
  serverEntry,
  switches,
  recentFirst,
};

try {
  let ticket: string | undefined;
  const until = Date.now() + 180_000;
  while (!ticket && Date.now() < until) {
    if (lifetime.exited) throw new Error(`Server exited; see ${home}/perf/server.log`);
    try {
      ticket = (await getJson("/api/auth/websocket-ticket", {})).ticket;
    } catch {
      await delay(250);
    }
  }
  if (!ticket) throw new Error("Server readiness timed out");

  // One socket = one RPC client. `bytes` counts that socket's received frames.
  // oxlint-disable-next-line t3code/prefer-effect-fn -- Standalone harness script; nothing traces it.
  const withSocket = <A>(
    use: (
      client: Effect.Success<typeof makeWsRpcProtocolClient>,
      received: () => number,
    ) => Effect.Effect<A, unknown, Scope.Scope>,
  ) =>
    Effect.gen(function* () {
      const wsTicket = (yield* Effect.promise(() => getJson("/api/auth/websocket-ticket", {})))
        .ticket as string;
      let bytes = 0;
      const socket = Socket.layerWebSocket(
        `${origin.replace("http:", "ws:")}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION_TEXT}&wsTicket=${encodeURIComponent(wsTicket)}`,
      ).pipe(
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor, (url) => {
            const ws = new WebSocket(url);
            ws.addEventListener("message", (event) => {
              bytes +=
                typeof event.data === "string"
                  ? Buffer.byteLength(event.data)
                  : event.data instanceof ArrayBuffer
                    ? event.data.byteLength
                    : 0;
            });
            return ws;
          }),
        ),
      );
      const protocol = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* makeWsRpcProtocolClient;
        return yield* use(client, () => bytes);
      }).pipe(Effect.scoped, Effect.provide(protocol));
    });

  /** Subscribe from a sequence (or cold) and read until the server says it is in sync. */
  const subscribeUntilSynchronized = (afterSequence: number | undefined) =>
    withSocket((client, received) =>
      Effect.gen(function* () {
        const started = performance.now();
        const kinds: Record<string, number> = {};
        let snapshotThreads = 0;
        let lastSequence = afterSequence ?? 0;
        yield* client["orchestration.subscribeShell"]({
          ...(afterSequence === undefined ? {} : { afterSequence }),
          requestCompletionMarker: true,
          acceptShellPages: true,
        }).pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runForEach((item) =>
            Effect.sync(() => {
              const authoritative =
                item.kind === "snapshot" && item.resolvedRepositoryIdentityRoots === undefined;
              const kind =
                item.kind === "snapshot" && !authoritative ? "snapshot.enrichment" : item.kind;
              kinds[kind] = (kinds[kind] ?? 0) + 1;
              if (authoritative && item.kind === "snapshot") {
                snapshotThreads += item.snapshot.threads.length;
                lastSequence = Math.max(lastSequence, item.snapshot.snapshotSequence);
              } else if ("sequence" in item) lastSequence = Math.max(lastSequence, item.sequence);
            }),
          ),
        );
        const ms = performance.now() - started;
        const bytes = received();
        return {
          ms,
          bytes,
          linkMs: linkMs(bytes),
          mobileMs: ms + linkMs(bytes),
          kinds,
          snapshotThreads,
          fullReload: (kinds.snapshot ?? 0) > 0,
          lastSequence,
        };
      }),
    );

  const headSequence = async () =>
    ((await getJson("/api/orchestration/shell?paged=true&after=~~~~~~~~")) as ShellPage)
      .snapshotSequence;

  await Effect.runPromise(
    withSocket((client) =>
      Effect.gen(function* () {
        const touch = (thread: number, note: string) =>
          client["orchestration.dispatchCommand"]({
            type: "thread.metadata.update",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: ThreadId.make(`synthetic-thread-${thread}`),
            title: `Synthetic ${thread} ${note}`,
          });
        // Active (unarchived) threads spread over the id order: the rows a phone user
        // looks for first. The fixture archives every tenth thread.
        const stride = Math.max(1, Math.floor(fixture.threads / mobileSyncWorkload.recentThreads));
        const recentIndexes = Array.from(
          { length: mobileSyncWorkload.recentThreads },
          (_, index) => {
            const thread = (index * stride + 7) % fixture.threads;
            return thread % 10 === 9 ? thread - 1 : thread;
          },
        );
        yield* Effect.forEach(recentIndexes, (thread) => touch(thread, "recent"), {
          concurrency: 8,
          discard: true,
        });
        const recent = new Set(recentIndexes.map((thread) => `synthetic-thread-${thread}`));

        // Warm caches the way a running server is warm; not measured.
        yield* Effect.promise(() => pagedLoad({ shaped: false }));

        // Cold sync under a steady event rate.
        let writing = true;
        let writes = 0;
        const writer = yield* Effect.gen(function* () {
          const everyMs = 1000 / mobileSyncWorkload.writesPerSecond;
          let next = performance.now();
          while (writing) {
            yield* touch(
              recentIndexes[writes % mobileSyncWorkload.writerThreads]!,
              `w${writes}`,
            ).pipe(Effect.ignore);
            writes++;
            next += everyMs;
            const wait = next - performance.now();
            if (wait > 0) yield* Effect.sleep(`${wait} millis`);
          }
        }).pipe(Effect.forkScoped);
        const sequenceBefore = yield* Effect.promise(headSequence);
        const coldStarted = performance.now();
        const http = yield* Effect.promise(() => pagedLoad({ shaped: true, recent }));
        const sequenceAtSubscribe = yield* Effect.promise(headSequence);
        const socket = yield* subscribeUntilSynchronized(http.minSequence);
        writing = false;
        yield* Effect.sleep("200 millis");
        result.coldSync = {
          http,
          eventsDuringHttp: sequenceAtSubscribe - http.minSequence,
          eventsPerSecond: (sequenceAtSubscribe - sequenceBefore) / (http.ms / 1000),
          socket,
          totalMs: performance.now() - coldStarted,
          totalMobileMs: http.ms + socket.mobileMs,
          totalBytes: http.bytes + socket.bytes,
        };
        void writer;

        // Resume after time in the background.
        const resumes: Array<Record<string, unknown>> = [];
        let cursor = socket.lastSequence;
        for (const gap of mobileSyncWorkload.resumeGaps) {
          const samples: Array<Effect.Success<ReturnType<typeof subscribeUntilSynchronized>>> = [];
          let appended = 0;
          for (let repeat = 0; repeat < mobileSyncWorkload.resumeRepeats; repeat++) {
            // Catch up first so every sample starts from an in-sync client.
            cursor = (yield* subscribeUntilSynchronized(cursor)).lastSequence;
            const from = yield* Effect.promise(headSequence);
            let sent = 0;
            while ((yield* Effect.promise(headSequence)) - from < gap) {
              const batch = Math.min(400, gap);
              yield* Effect.forEach(
                Array.from({ length: batch }, (_, index) => index),
                (index) =>
                  touch(
                    recentIndexes[(sent + index) % recentIndexes.length]!,
                    `g${gap}:${repeat}:${sent + index}`,
                  ).pipe(Effect.ignore),
                { concurrency: 16, discard: true },
              );
              sent += batch;
            }
            appended = (yield* Effect.promise(headSequence)) - from;
            const sample = yield* subscribeUntilSynchronized(cursor);
            cursor = sample.lastSequence;
            samples.push(sample);
          }
          resumes.push({
            gapRequested: gap,
            gapEvents: appended,
            fullReloads: samples.filter((sample) => sample.fullReload).length,
            serverMsP50: pct(
              samples.map((sample) => sample.ms),
              0.5,
            ),
            mobileMsP50: pct(
              samples.map((sample) => sample.mobileMs),
              0.5,
            ),
            mobileMsMax: Math.max(...samples.map((sample) => sample.mobileMs)),
            bytesP50: pct(
              samples.map((sample) => sample.bytes),
              0.5,
            ),
            kinds: samples.at(-1)?.kinds,
          });
        }
        result.resume = resumes;

        // Open a thread while shell loads are in flight.
        const open = async () => {
          const started = performance.now();
          const shaped = await shapedFetch(() =>
            fetch(
              `${origin}/api/orchestration/threads/synthetic-thread-1/bounded?compactTurnItems=1`,
              { headers, signal: AbortSignal.timeout(120_000) },
            ),
          );
          return { ms: performance.now() - started, bytes: shaped.bytes };
        };
        const idle: number[] = [];
        for (let i = 0; i < 10; i++) idle.push((yield* Effect.promise(open)).ms);
        let loading = true;
        const loaders = Array.from({ length: mobileSyncWorkload.shellLoaders }, async () => {
          while (loading) await pagedLoad({ shaped: false, stop: () => !loading });
        });
        yield* Effect.sleep("1 second");
        const loaded: number[] = [];
        let openBytes = 0;
        for (let i = 0; i < mobileSyncWorkload.threadOpens; i++) {
          const sample = yield* Effect.promise(open);
          loaded.push(sample.ms);
          openBytes = sample.bytes;
          yield* Effect.sleep("50 millis");
        }
        loading = false;
        yield* Effect.promise(() => Promise.all(loaders));
        result.threadOpen = {
          bytes: openBytes,
          idleMsP50: pct(idle, 0.5),
          underShellLoadMsP50: pct(loaded, 0.5),
          underShellLoadMsP95: pct(loaded, 0.95),
          underShellLoadMsMax: Math.max(...loaded),
        };
      }),
    ),
  );
  result.status = "ok";
} catch (error) {
  result.status = "failed";
  result.error = String(error instanceof Error ? (error.stack ?? error.message) : error);
  try {
    result.serverLogTail = NodeFS.readFileSync(
      NodePath.resolve(home, "perf", "server.log"),
      "utf8",
    ).slice(-4000);
  } catch {
    // No server log yet.
  }
} finally {
  child.kill("SIGTERM");
  await Promise.race([lifetime.exit, delay(15_000)]);
  if (!lifetime.exited) child.kill("SIGKILL");
  NodeFS.writeFileSync(NodePath.resolve(out), JSON.stringify(result, null, 2));
  NodeFS.rmSync(home, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "ok" ? 0 : 1);
