import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeHttp from "node:http";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import { Tool, Toolkit } from "effect/ai";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EnvironmentId, NodeId, ThreadId, ProviderInstanceId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as ServerConfig from "../src/config.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as Sqlite from "../src/persistence/Sqlite.ts";
import * as BoardsDatabase from "../src/ardud/persistence/BoardsDatabase.ts";
import * as ControlStore from "../src/ardud/control/ControlStore.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../src/orchestration-v2/ProjectStore.ts";
import { loadShellSnapshotParts } from "../src/orchestration-v2/ShellStream.ts";
import * as ThreadManagement from "../src/orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../src/orchestration-v2/ThreadLaunchService.ts";
import * as Orchestrator from "../src/orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../src/orchestration-v2/ProviderSessionManager.ts";
import * as ProviderRegistry from "../src/provider/ProviderRegistry.ts";
import * as ProjectService from "../src/project/ProjectService.ts";
import * as ManagedProjectFolders from "../src/project/ManagedProjectFolders.ts";
import * as OrchestrationEventStore from "../src/persistence/OrchestrationEventStore.ts";
import * as StartupPhaseLog from "../src/ardud/observability/StartupPhaseLog.ts";
import * as ServerRuntimeStartup from "../src/serverRuntimeStartup.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as SessionStore from "../src/auth/SessionStore.ts";
import * as McpOAuth from "../src/auth/McpOAuth.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../src/mcp/McpSessionRegistry.ts";
import * as CredentialStore from "../src/ardud/mcp/CredentialStore.ts";
import * as McpHttpServer from "../src/mcp/McpHttpServer.ts";
import * as McpToolAccess from "../src/mcp/McpToolAccess.ts";
import { controlRouteLayer } from "../src/ardud/control/http.ts";
import { ensureShellLookupIndexes } from "../src/ardud/persistence/shellIndexes.ts";
import shape from "../../../scripts/overload-harness/shape.json" with { type: "json" };
import latencyShape from "../../../scripts/overload-harness/latency-shape.json" with { type: "json" };
import { quantileValue } from "../src/ardud/perf/overloadShape.ts";

if (process.argv.includes("--check-imports")) process.exit(0);

const arg = (key, fallback) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const revision = arg("revision", "UNSPECIFIED");
const out = NodePath.resolve(arg("out", "tmp/overload-latency"));
const samples = Number(arg("samples", "100"));
if (!/^[0-9a-f]{40}$/.test(revision) || !Number.isInteger(samples) || samples < 1) throw new Error("Full revision and positive sample count required");
await NodeFSP.mkdir(out, { recursive: true });
const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "overload-latency-"));
const require = NodeModule.createRequire(import.meta.url);
const { WebSocketServer } = require("ws");
const server = NodeHttp.createServer();
const wsServer = NodeHttp.createServer();
const sockets = new WebSocketServer({ server: wsServer, path: "/overload-archive" });
const telemetry = [];
let measuring = false;
const trace = Tracer.make({ span(options) {
  const span = new Tracer.NativeSpan(options);
  const end = span.end.bind(span);
  span.end = (time, exit) => {
    if (measuring && (span.name === "Latency.tool" || span.name.startsWith("sql.") || span.name.startsWith("Mcp") || span.name.startsWith("EnvironmentAuth.authenticateMcpClient"))) {
      const attributes = Object.fromEntries([...span.attributes].filter(([key, value]) => typeof value === "number" || key.startsWith("db.reader.") || key === "db.connection"));
      telemetry.push({ name: span.name, durationMs: Number(time - span.startTime) / 1e6, attributes });
    }
    end(time, exit);
  };
  return span;
} });
const network = NodeHttpServer.layer(() => server, { host: "127.0.0.1", port: 0 });
const config = ServerConfig.layerTest(process.cwd(), home).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(ServerSettings.layerTest()));
const persistence = Sqlite.layerConfig.pipe(Layer.provideMerge(config));
const boards = Layer.unwrap(Effect.gen(function* () {
  const cfg = yield* ServerConfig.ServerConfig;
  return BoardsDatabase.layerFromPaths(NodePath.join(NodePath.dirname(cfg.dbPath), "boards.sqlite"), cfg.dbPath);
})).pipe(Layer.provideMerge(persistence));
const stores = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer, ControlStore.layer, CredentialStore.layer, ServerSecretStore.layer).pipe(Layer.provideMerge(boards));
const environmentId = EnvironmentId.make("environment:synthetic-latency");
const environment = Layer.mergeAll(
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
  Layer.succeed(ServerEnvironment.ServerEnvironment, { getEnvironmentId: Effect.succeed(environmentId), getDescriptor: Effect.die("Unused descriptor") }),
);
const auth = EnvironmentAuth.layer.pipe(Layer.provideMerge(stores), Layer.provideMerge(environment));
const registry = McpSessionRegistry.layer.pipe(Layer.provideMerge(auth), Layer.provideMerge(network));
const baseLayer = McpOAuth.layerMcpClientAuthenticator.pipe(Layer.provideMerge(registry));
const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * values.length) - 1)];
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const cfg = yield* ServerConfig.ServerConfig;
  const sessions = yield* SessionStore.SessionStore;
  const credentials = yield* McpSessionRegistry.McpSessionRegistry;
  const clients = yield* McpHttpServer.McpClientAuthenticator;
  const counts = Object.fromEntries(["threads", "runs", "nodes"].map(kind => [kind, shape.tables[`orchestration_v2_projection_${kind}`].rows]));
  const at = "2026-11-13T00:00:00.000Z";
  const archived = latencyShape.threads.archived;
  const deleted = latencyShape.threads.deleted;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('latency-project','Synthetic latency','/synthetic','[]',${at},${at})`;
  // SQL bulk seeding avoids millions of startup event transactions; payloads are wholly synthetic.
  for (const kind of ["threads", "runs", "nodes"]) {
    const stats = shape.tables[`orchestration_v2_projection_${kind}`].jsonBytes;
    for (let start = 0; start < counts[kind]; start += 1024) {
      const end = Math.min(counts[kind], start + 1024);
      const bytes = quantileValue(stats, (start + (end - start) / 2) / counts[kind]);
      const padding = "x".repeat(Math.max(0, bytes - (kind === "threads" ? 1000 : 700)));
      if (kind === "threads") yield* sql`
        WITH RECURSIVE n(i) AS (SELECT ${start} UNION ALL SELECT i+1 FROM n WHERE i+1<${end})
        INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,payload_json,provider_instance_id)
        SELECT 'latency-thread-'||i,'latency-project','Synthetic '||i,'codex','full-access','default',NULL,${at},${at},CASE WHEN i<${archived} THEN ${at} ELSE NULL END,CASE WHEN i>=${counts.threads-deleted} THEN ${at} ELSE NULL END,
        json_object('id','latency-thread-'||i,'projectId','latency-project','title','Synthetic '||i,'providerInstanceId','codex','modelSelection',json_object('instanceId','codex','model','gpt-6.1-sol'),'runtimeMode','full-access','interactionMode','default','branch',NULL,'worktreePath',NULL,'createdBy','user','creationSource','web','activeProviderThreadId',NULL,'lineage',json_object('rootThreadId','latency-thread-'||i,'parentThreadId',NULL,'relationshipToParent',NULL),'forkedFrom',NULL,'createdAt',${at},'updatedAt',${at},'archivedAt',CASE WHEN i<${archived} THEN ${at} ELSE NULL END,'settledOverride',NULL,'settledAt',NULL,'lastVisitedAt',NULL,'deletedAt',CASE WHEN i>=${counts.threads-deleted} THEN ${at} ELSE NULL END,'syntheticPadding',${padding}),'codex' FROM n`;
      if (kind === "runs") yield* sql`
        WITH RECURSIVE n(i) AS (SELECT ${start} UNION ALL SELECT i+1 FROM n WHERE i+1<${end})
        INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json)
        SELECT 'latency-run-'||i,'latency-thread-'||(i%${counts.threads}),1+CAST(i/${counts.threads} AS INTEGER),'codex','completed',${at},${at},json_object('id','latency-run-'||i,'threadId','latency-thread-'||(i%${counts.threads}),'ordinal',1+CAST(i/${counts.threads} AS INTEGER),'providerInstanceId','codex','modelSelection',json_object('instanceId','codex','model','gpt-6.1-sol'),'status','completed','requestedAt',${at},'completedAt',${at},'syntheticPadding',${padding}) FROM n`;
      if (kind === "nodes") yield* sql`
        WITH RECURSIVE n(i) AS (SELECT ${start} UNION ALL SELECT i+1 FROM n WHERE i+1<${end})
        INSERT INTO orchestration_v2_projection_nodes (node_id,thread_id,run_id,root_node_id,kind,status,payload_json)
        SELECT 'latency-node-'||i,'latency-thread-'||(i%${counts.threads}),NULL,'latency-node-'||i,'root_turn','completed',json_object('id','latency-node-'||i,'threadId','latency-thread-'||(i%${counts.threads}),'runId',NULL,'parentNodeId',NULL,'rootNodeId','latency-node-'||i,'kind','root_turn','status','completed','countsForRun',1,'providerThreadId',NULL,'providerTurnId',NULL,'nativeItemRef',NULL,'runtimeRequestId',NULL,'checkpointScopeId',NULL,'startedAt',NULL,'completedAt',NULL,'syntheticPadding',${padding}) FROM n`;
    }
    process.stdout.write(`Seeded ${kind}: ${counts[kind]}\n`);
  }
  const indexStarted = NodePerfHooks.performance.now();
  yield* ensureShellLookupIndexes;
  const startupIndexMs = NodePerfHooks.performance.now() - indexStarted;
  const indexes = yield* sql`SELECT name FROM sqlite_schema WHERE type='index' AND name='ardud_control_thread_candidates_idx'`;
  yield* sql`CREATE TABLE overload_latency_writer (id INTEGER PRIMARY KEY, value INTEGER)`;
  yield* sql`INSERT INTO overload_latency_writer VALUES (1,0)`;
  const node = { id: NodeId.make("latency-node-0"), threadId: ThreadId.make("latency-thread-0"), runId: null, parentNodeId: null, rootNodeId: NodeId.make("latency-node-0"), kind: "root_turn", status: "completed", countsForRun: true, providerThreadId: null, providerTurnId: null, nativeItemRef: null, runtimeRequestId: null, checkpointScopeId: null, startedAt: null, completedAt: null };
  const point = projection.isNodeStored(node);
  const snapshots = options => loadShellSnapshotParts({ sql, readThreads: projection.readShellSnapshot(options), listProjects: projects.listShells(), latestSequence: Effect.succeed(0), ...(options?.threadIds ? { bounded: true } : {}) }).pipe(Effect.map(reply => reply.threads));
  const threadLayer = Layer.mock(ThreadManagement.ThreadManagementService)({ getCallerRow: id => projection.getCallerRow(id).pipe(NodeSqliteClient.readOnly), getShellSnapshot: snapshots, getThreadShell: id => projection.getThreadShell(id).pipe(NodeSqliteClient.readOnly), getThreadRecords: (id, fields) => projection.getThreadRecords(id, fields).pipe(NodeSqliteClient.readOnly) });
  const supporting = Layer.mergeAll(threadLayer,
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}), Layer.mock(Orchestrator.OrchestratorV2)({}),
    Layer.mock(ProjectService.ProjectService)({ listShells: options => projects.listShells(options) }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/synthetic", scratchRoot: Effect.succeed(Option.none()) }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({}), Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({ latestAgentSequence: () => Effect.succeed(0) }),
    Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({ enqueueCommand: effect => effect }),
    Layer.succeed(StartupPhaseLog.StartupPhaseLog, StartupPhaseLog.makeStartupPhaseLog(cfg.logsDir)),
  );
  const toolkit = Toolkit.make(Tool.make("latency_point", { description: "Synthetic node lookup", success: Schema.Struct({ stored: Schema.Boolean }), failure: OrchestratorMcpFailure, failureMode: "return" }));
  const tools = McpHttpServer.toolkitRegistration(toolkit, McpToolAccess.toLayer(toolkit, { latency_point: McpToolAccess.reads(() => point.pipe(Effect.orDie, Effect.map(stored => ({ stored })), Effect.withSpan("Latency.tool"))) })).pipe(Layer.provideMerge(McpHttpServer.layerMcpTransport));
  const routes = Layer.mergeAll(controlRouteLayer, tools).pipe(Layer.provide(supporting), Layer.provide(HttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(Etag.layerWeak))));
  yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(Layer.build);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing isolated HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const clientSession = yield* sessions.issue({ subject: "mcp-client", method: "bearer-access-token", scopes: ["orchestration:read", "orchestration:operate"], runtimeModeCeiling: "full-access", client: { label: "Synthetic latency", deviceType: "bot" } });
  const issued = yield* credentials.issue({ threadId: ThreadId.make("latency-thread-0"), providerInstanceId: ProviderInstanceId.make("codex") });
  const providerToken = issued.config.authorizationHeader.slice("Bearer ".length);
  const clientRequest = HttpServerRequest.fromWeb(new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${clientSession.token}` } }));
  const get = Effect.tryPromise(async signal => {
    const reply = await fetch(`${origin}/api/ardud/control/threads?limit=1`, { signal, headers: { authorization: `Bearer ${clientSession.token}` } });
    const body = await reply.json();
    if (reply.status !== 200 || body.threads?.length !== 1) throw new Error("Control response failed logical-size check");
  });
  const providerAuth = credentials.resolve(providerToken).pipe(Effect.flatMap(scope => scope ? Effect.void : Effect.die("Issued provider credential rejected")));
  const clientAuth = clients.authenticate(clientRequest).pipe(Effect.flatMap(scope => scope ? Effect.void : Effect.die("Issued client credential rejected")));
  const mcpHeaders = { authorization: `Bearer ${providerToken}`, accept: "application/json, text/event-stream", "content-type": "application/json" };
  const initialized = yield* Effect.tryPromise(async () => {
    const reply = await fetch(`${origin}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } } }) });
    await reply.text(); if (reply.status !== 200) throw new Error("MCP initialization failed"); return reply.headers.get("mcp-session-id");
  });
  const wholeMcp = Effect.tryPromise(async signal => {
    const reply = await fetch(`${origin}/mcp`, { signal, method: "POST", headers: { ...mcpHeaders, "mcp-session-id": initialized, "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "latency_point", arguments: {} } }) });
    await reply.text(); if (reply.status !== 200) throw new Error("MCP tool request failed");
  });
  yield* Effect.all([get, point, providerAuth, clientAuth, wholeMcp], { concurrency: 1 });
  const entered = yield* Deferred.make(); const release = yield* Deferred.make();
  const writerEntered = yield* Deferred.make(); const archiveRequested = yield* Deferred.make();
  const background = yield* sql.withTransaction(sql`SELECT thread_id FROM orchestration_v2_projection_threads LIMIT 1`.pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Deferred.await(release)))).pipe(NodeSqliteClient.readOnly, NodeSqliteClient.backgroundReads, Effect.forkScoped);
  yield* Deferred.await(entered);
  const writer = yield* sql.withTransaction(sql`UPDATE overload_latency_writer SET value=value+1 WHERE id=1`.pipe(Effect.andThen(Deferred.succeed(writerEntered, undefined)), Effect.andThen(Deferred.await(release)))).pipe(Effect.forkScoped);
  yield* Deferred.await(writerEntered);
  const context = yield* Effect.context();
  let archiveEntered = false;
  let archiveExit;
  const onConnection = socket => socket.on("message", () => {
    const archive = loadShellSnapshotParts({ sql, readThreads: projection.readShellSnapshot({ location: "archive" }).pipe(Effect.tap(() => Effect.sync(() => { archiveEntered = true; })), Effect.tap(() => Deferred.await(release))), listProjects: projects.listShells(), latestSequence: Effect.succeed(0) }).pipe(NodeSqliteClient.foregroundReads);
    Effect.runFork(Deferred.succeed(archiveRequested, undefined).pipe(Effect.andThen(archive), Effect.provide(context), Effect.withTracer(trace), Effect.onExit(exit => Effect.sync(() => { archiveExit = exit._tag; socket.close(); }))));
  });
  sockets.on("connection", onConnection);
  yield* Effect.acquireRelease(Effect.tryPromise(() => new Promise((resolve, reject) => { wsServer.once("error", reject); wsServer.listen(0, "127.0.0.1", resolve); })), () => Effect.promise(() => new Promise(resolve => wsServer.close(resolve))));
  const wsAddress = wsServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${wsAddress.port}/overload-archive`);
  yield* Effect.tryPromise(() => new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); }));
  ws.send(JSON.stringify({ method: "orchestration.getShellSnapshot", params: { location: "archive" } }));
  yield* Deferred.await(archiveRequested);
  const observations = { threads: [], nodePk: [], providerCredential: [], clientCredential: [], wholeMcp: [] };
  const measure = Effect.fn("Latency.measure")(function* (name, action) {
    const began = NodePerfHooks.performance.now();
    const exit = yield* action.pipe(Effect.as(true), Effect.timeoutOption("3 seconds"), Effect.exit);
    observations[name].push({ ms: NodePerfHooks.performance.now() - began, completed: exit._tag === "Success" && Option.isSome(exit.value), timedOut: exit._tag === "Success" && Option.isNone(exit.value), error: exit._tag === "Failure" ? String(exit.cause).slice(0, 160) : null, longReaderActive: background.pollUnsafe() === undefined, writerActive: writer.pollUnsafe() === undefined, archiveEntered });
  });
  const measuredAt = new Date().toISOString();
  measuring = true;
  yield* Effect.gen(function* () {
    for (let i = 0; i < samples; i++) yield* Effect.all([measure("threads", get), measure("nodePk", point), measure("providerCredential", providerAuth), measure("clientCredential", clientAuth), measure("wholeMcp", wholeMcp)], { concurrency: 5 });
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
  yield* Fiber.join(background); yield* Fiber.join(writer);
  // The archive may have queued on the sole background slot; drain it before closing the server.
  yield* Effect.tryPromise(() => new Promise(resolve => { if (ws.readyState === WebSocket.CLOSED) resolve(); else ws.addEventListener("close", resolve, { once: true }); })).pipe(Effect.timeout("120 seconds"));
  measuring = false;
  sockets.off("connection", onConnection);
  yield* Effect.promise(() => new Promise(resolve => sockets.close(resolve)));
  const streams = Object.fromEntries(Object.entries(observations).map(([name, rows]) => [name, { count: rows.length, completed: rows.filter(row => row.completed).length, p99MsLowerBound: percentile(rows.map(row => row.ms), .99), maxMsLowerBound: Math.max(...rows.map(row => row.ms)), heldForEverySample: rows.every(row => row.longReaderActive && row.writerActive), observations: rows }]));
  return { scenario: "request-latency-1365", revision, home, samples, startedAt: measuredAt, completedAt: new Date().toISOString(), node: process.version, cpu: NodeOS.cpus()[0]?.model, runtimeFlags: process.execArgv, counts, archivedThreads: archived, deletedThreads: deleted, postSeedIndexEnsureMs: startupIndexMs, candidateIndexPresent: indexes.length === 1, archiveEntered, archiveExit, streams, telemetry, limitations: ["WS wire adapter is harness-owned and calls the real loadShellSnapshotParts path in a foreground request scope; production WS authentication/RPC decoding is outside it.", "Bulk SQL seed uses measured table counts and 1024-row quantile buckets; synthetic payloads contain no private values.", "Timed-out samples are right-censored lower bounds, never completed request latencies.", "Older revisions may lack acquire_wait_ms and worker execution telemetry; inclusive statement time is never relabelled as execution."] };
})).pipe(Effect.provide(baseLayer), Effect.withTracer(trace)));
await NodeFSP.writeFile(NodePath.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
process.stdout.write(`Latency measurement complete: ${out}\n`);
