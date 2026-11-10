// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native memory and wall time outside the application runtime.
/**
 * Browser shell memory gate: the built web app (apps/web/dist, the same bundle the desktop
 * renderer loads) in a headless Chrome against this tree's server on a synthetic fixture,
 * while it loads the whole thread list. Samples the renderer's V8 heap over CDP.
 *
 * Scenarios:
 * - cold: a fresh profile pairs and loads every shell page;
 * - reload: the same profile reloads (the cached list is on disk), as after ⌘R;
 * - crash: the renderer is crashed mid-load and a new one opens, as after an OOM.
 *   Reports whether the new renderer restarted the walk at page one.
 *
 * usage: node packages/perf-harness/src/shellMemoryBrowserGate.ts FIXTURE OUT.json
 *   FIXTURE from `node packages/perf-harness/src/fixture.ts DIR shell`.
 * env:   ROBOB_PERF_CHROME (headless shell binary; default `taste chrome`),
 *        ROBOB_PERF_SHELL_MAX_PEAK_MB (default 1024), ROBOB_PERF_SHELL_MAX_RETAINED_MB
 *        (default 512), ROBOB_PERF_CRASH_AT_PAGE (default 12), ROBOB_PERF_HEAP_PROFILE=1
 *        (write sampling heap profiles next to OUT.json), ROBOB_PERF_SCENARIOS
 *        (default "cold,reload,crash"), ROBOB_PERF_WRITES_PER_S (default 30),
 *        ROBOB_PERF_PROFILE_AT_PAGE=N (heap + CPU profile once N pages landed).
 * Fails when a renderer crashes, a list never completes, the heap peak or the heap kept after
 * a forced GC passes its limit, or the renderer after a crash starts the walk at page one.
 * Requires apps/web/dist built from this tree. Never prints the pairing URL.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

// oxlint-disable-next-line t3code/no-rpc-permission-bypass -- The perf harness drives the raw WS protocol to write events, as mobileSyncGate does.
import { makeWsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";
import { observeExit } from "./process.ts";

const [fixtureDir, out] = process.argv.slice(2);
if (!fixtureDir || !out) {
  console.error("usage: shellMemoryBrowserGate.ts FIXTURE OUT.json");
  process.exit(2);
}
const maxPeakMb = Number(process.env.ROBOB_PERF_SHELL_MAX_PEAK_MB ?? 1_024);
const maxRetainedMb = Number(process.env.ROBOB_PERF_SHELL_MAX_RETAINED_MB ?? 512);
const crashAtPage = Number(process.env.ROBOB_PERF_CRASH_AT_PAGE ?? 12);
const heapProfiles = process.env.ROBOB_PERF_HEAP_PROFILE === "1";
const scenarios = (process.env.ROBOB_PERF_SCENARIOS ?? "cold,reload,crash").split(",");
// Diagnostics: capture a sampling heap profile and a CPU profile once this many pages landed.
const profileAtPage = Number(process.env.ROBOB_PERF_PROFILE_AT_PAGE ?? 0);
// The live server wrote ~30 events/s while the list loaded (10 Nov 2026). Thread updates
// reach the client as shell stream events on the rows it is loading.
const writesPerSecond = Number(process.env.ROBOB_PERF_WRITES_PER_S ?? 30);
const writerThreads = 64;
const token = "synthetic-performance-credential-only";
const MB = 1024 * 1024;
const delay = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.resolve(fixtureDir, "fixture.json"), "utf8"),
);
if (fixture.synthetic !== true) throw new Error("Synthetic fixture marker required");
if (!NodeFS.existsSync(NodePath.resolve("apps/web/dist/index.html")))
  throw new Error("Build apps/web first (apps/web/dist/index.html is missing)");

const work = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "robob-shell-memory-"));
const home = NodePath.resolve(work, "home");
NodeFS.cpSync(NodePath.resolve(fixtureDir), home, {
  recursive: true,
  mode: NodeFS.constants.COPYFILE_FICLONE,
});

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = NodeNet.createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address();
      s.close(() => (typeof p === "object" && p ? ok(p.port) : fail(new Error("port"))));
    });
  });
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const serverEntry = NodePath.resolve(
  process.env.ROBOB_PERF_SERVER_ENTRY ?? "apps/server/src/bin.ts",
);
const switches = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => name.startsWith("ROBOB_") && !name.startsWith("ROBOB_PERF_"),
  ),
);
const serverEnv = {
  ...switches,
  PATH: process.env.PATH,
  HOME: home,
  T3CODE_TELEMETRY_ENABLED: "false",
  T3CODE_DEV_AUTH_TOKEN: token,
};
const serverLog = NodeFS.createWriteStream(NodePath.resolve(work, "server.log"));
const server = NodeChildProcess.spawn(
  process.execPath,
  [
    "--max-old-space-size=8192",
    serverEntry,
    "serve",
    "--base-dir",
    home,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--no-browser",
    NodePath.resolve(home, "workspace"),
  ],
  { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
);
NodeFS.mkdirSync(NodePath.resolve(home, "workspace"), { recursive: true });
const serverExit = observeExit(server);
server.stdout?.pipe(serverLog);
server.stderr?.pipe(serverLog);

let chrome: NodeChildProcess.ChildProcess | undefined;
const cleanup = () => {
  chrome?.kill("SIGKILL");
  server.kill("SIGTERM");
};
process.on("exit", cleanup);

for (let i = 0; ; i++) {
  if (i > 240) throw new Error(`server did not answer (see ${work}/server.log)`);
  const ready = await fetch(`${origin}/.well-known/t3/environment`)
    .then((r) => r.ok)
    .catch(() => false);
  if (ready) break;
  await delay(500);
}

const pairUrl = await new Promise<string>((ok, fail) => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      serverEntry,
      "auth",
      "pairing",
      "create",
      "--base-dir",
      home,
      "--ttl",
      "15m",
      "--label",
      "shell-memory-gate",
      "--base-url",
      origin,
      "--json",
    ],
    { env: serverEnv, stdio: ["ignore", "pipe", "ignore"] },
  );
  let text = "";
  child.stdout.on("data", (chunk) => (text += chunk));
  child.on("exit", (code) => {
    const json = text.slice(text.indexOf("{"));
    try {
      ok(JSON.parse(json).pairUrl);
    } catch {
      fail(new Error(`pairing create failed (exit ${code})`));
    }
  });
});

// The event writer: metadata updates on unsettled and settled rows, over the socket.
let writing = writesPerSecond > 0;
let writes = 0;
const writerDone = (async () => {
  if (!writing) return;
  const ticket = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  }).then((r) => r.json());
  const socketLayer = Socket.layerWebSocket(
    `${origin.replace("http:", "ws:")}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION_TEXT}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
  ).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, (url) => new WebSocket(url))));
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
  const threadCount = Number(fixture.threads ?? 20_000);
  // The first rows the sidebar shows unsettled (every 60th) plus settled ones.
  const targets = Array.from(
    { length: writerThreads },
    (_, i) => (i % 2 === 0 ? i * 60 : i * 97 + 1) % threadCount,
  ).map((i) => (i % 10 === 9 ? i - 1 : i));
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* makeWsRpcProtocolClient;
      const everyMs = 1000 / writesPerSecond;
      let next = performance.now();
      while (writing) {
        const thread = targets[writes % targets.length]!;
        yield* client["orchestration.dispatchCommand"]({
          type: "thread.metadata.update",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId: ThreadId.make(`synthetic-thread-${thread}`),
          title: `Synthetic ${thread}: investigate and fix a realistic task, write ${writes}`,
        }).pipe(Effect.ignore);
        writes++;
        next += everyMs;
        const wait = next - performance.now();
        if (wait > 0) yield* Effect.sleep(`${wait} millis`);
      }
    }).pipe(Effect.scoped, Effect.provide(protocol)),
  );
})();

const chromePath =
  process.env.ROBOB_PERF_CHROME ??
  NodeChildProcess.execFileSync("taste", ["chrome"], { encoding: "utf8" }).trim();
const profileDir = NodePath.resolve(work, "chrome-profile");
chrome = NodeChildProcess.spawn(
  chromePath,
  [
    "--headless",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    "--enable-precise-memory-info",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const browserWs = await new Promise<string>((ok, fail) => {
  let text = "";
  const timer = setTimeout(() => fail(new Error("chrome did not start")), 30_000);
  chrome!.stderr!.on("data", (chunk) => {
    text += chunk;
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
    if (match) {
      clearTimeout(timer);
      ok(match[1]!);
    }
  });
});

type Listener = (params: any, sessionId?: string) => void;
const socket = new WebSocket(browserWs);
await new Promise<void>((ok, fail) => {
  socket.addEventListener("open", () => ok(), { once: true });
  socket.addEventListener("error", () => fail(new Error("cdp connect")), { once: true });
});
let nextId = 1;
const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
const listeners = new Map<string, Set<Listener>>();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry?.fail(new Error(`${message.error.message}`));
    else entry?.ok(message.result);
    return;
  }
  for (const listener of listeners.get(message.method) ?? [])
    listener(message.params, message.sessionId);
});
const send = (method: string, params: object = {}, sessionId?: string, timeoutMs = 60_000) =>
  new Promise<any>((ok, fail) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      fail(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      ok: (v) => (clearTimeout(timer), ok(v)),
      fail: (e) => (clearTimeout(timer), fail(e)),
    });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const on = (method: string, listener: Listener) => {
  let set = listeners.get(method);
  if (!set) listeners.set(method, (set = new Set()));
  set.add(listener);
  return () => set!.delete(listener);
};

interface ShellRequest {
  readonly requestId: string;
  readonly after: string | null;
  readonly startedMs: number;
  bytes?: number;
  finishedMs?: number;
  last?: boolean;
}

const runScenario = async (name: string, navigateTo: string) => {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("HeapProfiler.enable", {}, sessionId);
  if (heapProfiles || profileAtPage > 0)
    await send("HeapProfiler.startSampling", { samplingInterval: 262_144 }, sessionId);
  if (profileAtPage > 0) {
    await send("Profiler.enable", {}, sessionId);
    await send("Profiler.setSamplingInterval", { interval: 1000 }, sessionId);
    await send("Profiler.start", {}, sessionId);
  }
  let profiledAtPage = false;
  const started = performance.now();
  const at = () => performance.now() - started;
  const requests = new Map<string, ShellRequest>();
  const shell: ShellRequest[] = [];
  let crashed = false;
  let completeMs: number | null = null;
  const stops = [
    on("Inspector.targetCrashed", (_p, s) => {
      if (s === sessionId) crashed = true;
    }),
    on("Network.requestWillBeSent", (p, s) => {
      if (s !== sessionId || !String(p.request.url).includes("/api/orchestration/shell")) return;
      const url = new URL(p.request.url);
      if (url.searchParams.get("paged") !== "true") return;
      const request = {
        requestId: p.requestId,
        after: url.searchParams.get("after"),
        startedMs: at(),
      };
      requests.set(p.requestId, request);
      shell.push(request);
    }),
    on("Network.loadingFinished", (p, s) => {
      const request = s === sessionId ? requests.get(p.requestId) : undefined;
      if (!request) return;
      request.bytes = p.encodedDataLength;
      request.finishedMs = at();
      void send("Network.getResponseBody", { requestId: p.requestId }, sessionId)
        .then((body) => {
          const text: string = body.base64Encoded
            ? Buffer.from(body.body, "base64").toString()
            : body.body;
          request.last = /"nextAfter":null/.test(text.slice(-400));
          if (request.last && completeMs === null) completeMs = request.finishedMs!;
        })
        .catch(() => undefined);
    }),
  ];
  const samples: Array<{ ms: number; usedMb: number; totalMb: number }> = [];
  let peak = { ms: 0, usedMb: 0 };
  let sampling = true;
  const sampler = (async () => {
    while (sampling && !crashed) {
      const usage = await send("Runtime.getHeapUsage", {}, sessionId, 30_000).catch(() => null);
      if (usage) {
        const sample = { ms: at(), usedMb: usage.usedSize / MB, totalMb: usage.totalSize / MB };
        samples.push(sample);
        if (sample.usedMb > peak.usedMb) peak = { ms: sample.ms, usedMb: sample.usedMb };
      }
      await delay(100);
    }
  })();
  await send("Page.navigate", { url: navigateTo }, sessionId);

  // Done: the last page has landed and the heap has had 8 s to settle, or the renderer died.
  const deadline = performance.now() + 300_000;
  let crashRequested = false;
  while (!crashed && performance.now() < deadline) {
    if (
      name === "crash-first" &&
      !crashRequested &&
      shell.filter((r) => r.finishedMs).length >= crashAtPage
    ) {
      crashRequested = true;
      await send("Page.crash", {}, sessionId, 5_000).catch(() => undefined);
      crashed = true;
      break;
    }
    if (completeMs !== null && at() - completeMs > 8_000) break;
    if (
      profileAtPage > 0 &&
      !profiledAtPage &&
      shell.filter((r) => r.finishedMs).length >= profileAtPage
    ) {
      profiledAtPage = true;
      const [{ profile: heap }, { profile: cpu }] = await Promise.all([
        send("HeapProfiler.getSamplingProfile", {}, sessionId, 300_000),
        send("Profiler.stop", {}, sessionId, 300_000),
      ]);
      NodeFS.writeFileSync(`${out}.${name}.page${profileAtPage}.heapprofile`, JSON.stringify(heap));
      NodeFS.writeFileSync(`${out}.${name}.page${profileAtPage}.cpuprofile`, JSON.stringify(cpu));
    }
    await delay(250);
  }
  sampling = false;
  await sampler;
  let retainedMb: number | null = null;
  let profileFile: string | null = null;
  if (!crashed) {
    if (heapProfiles) {
      const { profile } = await send("HeapProfiler.getSamplingProfile", {}, sessionId, 120_000);
      profileFile = `${out}.${name}.heapprofile`;
      NodeFS.writeFileSync(profileFile, JSON.stringify(profile));
      await send("HeapProfiler.stopSampling", {}, sessionId, 120_000).catch(() => undefined);
    }
    await send("HeapProfiler.collectGarbage", {}, sessionId, 120_000);
    const usage = await send("Runtime.getHeapUsage", {}, sessionId);
    retainedMb = usage.usedSize / MB;
  }
  for (const stop of stops) stop();
  await send("Target.closeTarget", { targetId }).catch(() => undefined);
  const finished = shell.filter((r) => r.finishedMs !== undefined);
  return {
    name,
    crashed,
    pagesRequested: shell.length,
    pagesFinished: finished.length,
    pageOneRequests: shell.filter((r) => r.after === null).length,
    firstAfter: shell[0]?.after ?? null,
    wireMb: finished.reduce((sum, r) => sum + (r.bytes ?? 0), 0) / MB,
    completeMs,
    peakUsedMb: peak.usedMb,
    peakAtMs: peak.ms,
    retainedMb,
    profileFile,
    samples: samples
      .filter((_, i) => i % 5 === 0)
      .map((s) => [Math.round(s.ms), Math.round(s.usedMb)]),
    pages: shell.map((r) => [
      Math.round(r.startedMs),
      Math.round(r.finishedMs ?? -1),
      Math.round((r.bytes ?? 0) / 1024),
    ]),
  };
};

const results: Array<Awaited<ReturnType<typeof runScenario>>> = [];
try {
  // Pair once; every later scenario reuses the profile's session cookie and cached list.
  if (scenarios.includes("cold")) results.push(await runScenario("cold", pairUrl));
  else results.push(await runScenario("pair", pairUrl));
  if (scenarios.includes("reload")) results.push(await runScenario("reload", origin));
  if (scenarios.includes("crash")) {
    results.push(await runScenario("crash-first", origin));
    results.push(await runScenario("crash-resume", origin));
  }
} finally {
  writing = false;
  await Promise.race([writerDone, delay(5_000)]);
  socket.close();
  cleanup();
  await Promise.race([serverExit.exit, delay(5_000)]);
}

const failures: string[] = [];
for (const result of results) {
  if (result.name === "crash-first") continue;
  if (result.crashed) failures.push(`${result.name}: renderer crashed`);
  if (result.completeMs === null) failures.push(`${result.name}: list never completed`);
  if (result.peakUsedMb > maxPeakMb)
    failures.push(`${result.name}: peak ${result.peakUsedMb.toFixed(0)} MB > ${maxPeakMb}`);
  if (result.retainedMb !== null && result.retainedMb > maxRetainedMb)
    failures.push(`${result.name}: retained ${result.retainedMb.toFixed(0)} MB > ${maxRetainedMb}`);
  if (result.name === "crash-resume" && result.pageOneRequests > 0)
    failures.push("crash-resume: the new renderer started the walk at page one");
}
const report = {
  writer: { writesPerSecond, writes },
  fixture: { threads: fixture.threads ?? null, hash: fixture.fixtureHash ?? null },
  gate: { maxPeakMb, maxRetainedMb, crashAtPage },
  results,
  failures,
};
NodeFS.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      ...report,
      results: results.map(({ samples: _s, pages: _p, ...rest }) => rest),
    },
    null,
    2,
  ),
);
NodeFS.rmSync(work, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
