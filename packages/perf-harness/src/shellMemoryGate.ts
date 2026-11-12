// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native memory and wall time outside the application runtime.
/**
 * Shell memory gate: how much heap the client keeps and peaks at while it applies a full
 * paged thread list, measured on the real client-runtime code (shell state, HTTP loader,
 * page merge, deferred pull request fill, thread shell atoms).
 *
 * The pages come from an in-process fetch with synthetic rows sized like the live list
 * (desktop on 10 Nov 2026: about 18,000 active threads, 1.1-1.7 MB per 500-row page).
 *
 * usage: node --expose-gc packages/perf-harness/src/shellMemoryGate.ts [OUT.json]
 * env:   ROBOB_PERF_SHELL_THREADS (default 18000), ROBOB_PERF_SHELL_ROW_BYTES (default 2600),
 *        ROBOB_PERF_SHELL_MAX_PEAK_MB (gate, default 512), ROBOB_PERF_SHELL_MAX_RETAINED_MB
 *        (default 256), both above the heap before the load.
 *
 * No React here: the renderer OOM of 10 Nov 2026 was the sidebar drawing every row, which
 * shellMemoryBrowserGate.ts measures. This gate catches the runtime side (page merges,
 * retained pages, link fills) cheaply, without a browser.
 */
import * as NodeFS from "node:fs";
import * as NodeV8 from "node:v8";

import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../../client-runtime/src/connection/model.ts";
import * as EnvironmentSupervisor from "../../client-runtime/src/connection/supervisor.ts";
import * as Persistence from "../../client-runtime/src/platform/persistence.ts";
import * as RpcHttp from "../../client-runtime/src/rpc/http.ts";
import type * as RpcSession from "../../client-runtime/src/rpc/session.ts";
import type { WsRpcProtocolClient } from "../../client-runtime/src/rpc/protocol.ts";
import { makeEnvironmentShellState } from "../../client-runtime/src/state/shell.ts";
import * as ShellSnapshotLoader from "../../client-runtime/src/state/shellSnapshotHttp.ts";
import type { EnvironmentCatalogState } from "../../client-runtime/src/state/connections.ts";
import { createEnvironmentThreadShellAtoms } from "../../client-runtime/src/state/threadShell.ts";
import {
  v2Project,
  v2ThreadShell,
} from "../../client-runtime/src/state/orchestrationV2TestFixtures.ts";

const out = process.argv[2];
const threadCount = Number(process.env.ROBOB_PERF_SHELL_THREADS ?? 18_000);
const rowBytes = Number(process.env.ROBOB_PERF_SHELL_ROW_BYTES ?? 2_600);
const maxPeakMb = Number(process.env.ROBOB_PERF_SHELL_MAX_PEAK_MB ?? 512);
const maxRetainedMb = Number(process.env.ROBOB_PERF_SHELL_MAX_RETAINED_MB ?? 256);
const RECENT_PAGE = 150;
const PAGE = 500;
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("Run with node --expose-gc");

const MB = 1024 * 1024;
const environmentId = EnvironmentId.make("environment-memory");
const TARGET = new PrimaryConnectionTarget({
  environmentId,
  label: "Memory gate",
  httpBaseUrl: "https://memory.example.test",
  wsBaseUrl: "wss://memory.example.test",
});
const PREPARED: PreparedConnection = {
  environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

// Wire rows: the fixture row, encoded, then grown to the live size with the fields that
// carry text on the live list (titles, latest message, branch, worktree, pull requests).
const encodeRow = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadShell));
const base = encodeRow(v2ThreadShell) as Record<string, unknown>;
const projects = Array.from({ length: 40 }, (_, i) => ({
  ...v2Project,
  id: `project-${i}`,
  title: `Project ${i}`,
  workspaceRoot: `/workspace/project-${i}`,
}));
const wireRow = (i: number, textLength: number) => {
  const id = `thread-${String(i).padStart(6, "0")}`;
  const at = new Date(Date.UTC(2026, 10, 1) + i * 1_000).toISOString();
  const row: Record<string, unknown> = {
    ...base,
    id,
    projectId: projects[i % projects.length]!.id,
    title: `Synthetic thread ${i} about a long enough subject line to look real`,
    branch: `robob/task-${i}`,
    worktreePath: `/Users/synthetic/checkouts/task-${i}`,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    latestVisibleMessage: {
      id: `message-${i}`,
      role: "assistant",
      text: "x".repeat(textLength),
      updatedAt: at,
    },
    latestUserMessageAt: at,
    itemCount: 40 + (i % 100),
    visibleItemCount: 20 + (i % 50),
    createdAt: at,
    updatedAt: at,
  };
  if (i % 7 === 0) {
    row.pullRequests = [
      {
        host: "github.com",
        repository: "synthetic/repo",
        number: 1 + (i % 900),
        url: `https://github.com/synthetic/repo/pull/${1 + (i % 900)}`,
        source: "created",
        linkedAt: at,
        snapshot: null,
        stack: null,
      },
    ];
  }
  return row;
};
const probeLength = JSON.stringify(wireRow(0, 0)).length;
const textLength = Math.max(0, rowBytes - probeLength);
const rows = Array.from({ length: threadCount }, (_, i) => wireRow(i, textLength));
const recentIds = rows.slice(-RECENT_PAGE).toReversed();

let pageCount = 0;
let pageBytes = 0;
const pageMarks: Array<{ page: number; heapUsedMb: number; atMs: number }> = [];
const started = performance.now();
const fetchFn: typeof fetch = async (request) => {
  const url = new URL(request instanceof Request ? request.url : String(request));
  const after = url.searchParams.get("after");
  let threads: typeof rows;
  let nextAfter: string | null;
  if (after === null) {
    threads = recentIds;
    nextAfter = "walk:0";
  } else {
    const start = Number(after.slice("walk:".length));
    threads = rows.slice(start, start + PAGE);
    nextAfter = start + PAGE >= rows.length ? null : `walk:${start + PAGE}`;
  }
  const body = JSON.stringify({
    schemaVersion: 1,
    snapshotSequence: 1_000 + pageCount,
    projects,
    threads,
    archivedThreads: [],
    page: { after, nextAfter },
  });
  pageCount += 1;
  pageBytes += body.length;
  pageMarks.push({
    page: pageCount,
    heapUsedMb: process.memoryUsage().heapUsed / MB,
    atMs: performance.now() - started,
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
};

// Peak: sampled between tasks plus at every page boundary. V8's own peak counter catches
// what runs inside a long synchronous merge.
let peakHeapUsed = 0;
const sample = () => {
  const used = process.memoryUsage().heapUsed;
  if (used > peakHeapUsed) peakHeapUsed = used;
};
const sampler = setInterval(sample, 20);

const program = Effect.gen(function* () {
  const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => {
      // The server answers a complete list's resume with its marker.
      Queue.offerUnsafe(events, { kind: "synchronized" });
      return Stream.fromQueue(events);
    },
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({
      environment: { serverVersion: "memory-gate" },
      shellResumeCompletionMarker: true,
      shellResumeAcrossSessions: true,
      shellSnapshotPagination: true,
    } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  let saves = 0;
  let savedBytes = 0;
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    // The web store encodes the whole list to one JSON string per save.
    saveShell: (_id, snapshot) =>
      Effect.sync(() => {
        saves += 1;
        savedBytes = JSON.stringify(snapshot).length;
      }),
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const loaderLayer = ShellSnapshotLoader.layer.pipe(
    Layer.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
  );
  const loader = yield* ShellSnapshotLoader.ShellSnapshotLoader.pipe(Effect.provide(loaderLayer));
  const state = yield* makeEnvironmentShellState().pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, loader),
    Effect.provideService(ShellSnapshotLoader.OmitIdleSubagents, true),
  );

  // The web sidebar reads the list through these atoms; mount them like a screen does.
  const registry = AtomRegistry.make();
  const snapshotSource = Atom.make<OrchestrationV2ShellSnapshot | null>(null);
  const catalog = {
    isReady: true,
    entries: new Map([[environmentId, { enabled: true }]]),
    disabledEnvironmentIds: new Set(),
  } as unknown as EnvironmentCatalogState;
  const shells = createEnvironmentThreadShellAtoms({
    catalogValueAtom: Atom.make(() => catalog),
    snapshotAtom: () => snapshotSource,
  });
  const unmount = [
    registry.mount(shells.environmentThreadIndexAtom(environmentId)),
    registry.mount(shells.environmentThreadRefsAtom(environmentId)),
    registry.mount(shells.threadShellsAtom),
    registry.mount(shells.navigationThreadShellsAtom),
  ];
  let updates = 0;
  const live = yield* SubscriptionRef.changes(state).pipe(
    Stream.tap((value) =>
      Effect.sync(() => {
        updates += 1;
        registry.set(snapshotSource, Option.getOrNull(value.snapshot));
        sample();
      }),
    ),
    Stream.filter((value) => value.status === "live" && Option.isSome(value.snapshot)),
    Stream.runHead,
  );
  const elapsedMs = performance.now() - started;
  const snapshot = Option.getOrThrow(Option.getOrThrow(live).snapshot);
  // Let the deferred link fill and the first save land.
  yield* Effect.sleep("1500 millis");
  sample();
  gc();
  const retained = process.memoryUsage().heapUsed;
  for (const stop of unmount) stop();
  return {
    threads: snapshot.threads.length,
    elapsedMs,
    updates,
    saves,
    savedMb: savedBytes / MB,
    retainedMb: retained / MB,
  };
}).pipe(Effect.scoped);

gc();
const baselineMb = process.memoryUsage().heapUsed / MB;
const result = await Effect.runPromise(program);
clearInterval(sampler);
const heapStats = NodeV8.getHeapStatistics();
const report = {
  workload: { threadCount, rowBytes, recentPage: RECENT_PAGE, page: PAGE },
  pages: pageCount,
  wireMb: pageBytes / MB,
  baselineMb,
  peakHeapUsedMb: peakHeapUsed / MB,
  peakMallocedMb: heapStats.peak_malloced_memory / MB,
  totalHeapMb: heapStats.total_heap_size / MB,
  ...result,
  pageMarks,
  gate: { maxPeakMb, maxRetainedMb },
};
const peakAboveBaseline = report.peakHeapUsedMb - baselineMb;
const retainedAboveBaseline = report.retainedMb - baselineMb;
const failures = [
  ...(result.threads !== threadCount ? [`list has ${result.threads} of ${threadCount} rows`] : []),
  ...(peakAboveBaseline > maxPeakMb
    ? [`peak ${peakAboveBaseline.toFixed(0)} MB > ${maxPeakMb}`]
    : []),
  ...(retainedAboveBaseline > maxRetainedMb
    ? [`retained ${retainedAboveBaseline.toFixed(0)} MB > ${maxRetainedMb}`]
    : []),
];
const summary = {
  ...report,
  peakAboveBaselineMb: peakAboveBaseline,
  retainedAboveBaselineMb: retainedAboveBaseline,
  failures,
};
if (out) NodeFS.writeFileSync(out, JSON.stringify(summary, null, 2));
const { pageMarks: marks, ...printed } = summary;
console.log(
  JSON.stringify({ ...printed, pageHeapMb: marks.map((m) => Math.round(m.heapUsedMb)) }, null, 2),
);
process.exit(failures.length === 0 ? 0 : 1);
