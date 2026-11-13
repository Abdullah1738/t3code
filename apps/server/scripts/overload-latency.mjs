import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeHttp from "node:http";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Cause from "effect/Cause";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import { Tool, Toolkit } from "effect/ai";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EnvironmentId,
  NodeId,
  ThreadId,
  ProviderInstanceId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
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

const arg = (key, fallback) =>
  process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const revision = arg("revision", "UNSPECIFIED");
const out = NodePath.resolve(arg("out", "tmp/overload-latency"));
const samples = Number(arg("samples", "100"));
const compositionOnly = process.argv.includes("--check-composition");
if (!/^[0-9a-f]{40}$/.test(revision) || !Number.isInteger(samples) || samples < 1)
  throw new Error("Full revision and positive sample count required");
await NodeFSP.mkdir(out, { recursive: true });
const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "overload-latency-"));
const platformRequire = NodeModule.createRequire(
  import.meta.resolve("@effect/platform-node/NodeHttpServer"),
);
const sharedRequire = NodeModule.createRequire(
  platformRequire.resolve("@effect/platform-node-shared/package.json"),
);
const { WebSocketServer } = sharedRequire("ws");
const server = NodeHttp.createServer();
const wsServer = NodeHttp.createServer();
const sockets = new WebSocketServer({ server: wsServer, path: "/overload-archive" });
const telemetry = [];
let measuring = false;
const trace = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    const end = span.end.bind(span);
    let ended = false;
    span.end = (time, exit) => {
      if (
        measuring &&
        !ended &&
        (span.name === "Latency.tool" ||
          span.name.startsWith("sql.") ||
          [...span.attributes.keys()].some((key) => key.startsWith("db.")) ||
          span.name.startsWith("Mcp") ||
          span.name.startsWith("EnvironmentAuth.authenticateMcpClient"))
      ) {
        const attributes = Object.fromEntries(
          [...span.attributes].filter(
            ([key, value]) =>
              typeof value === "number" || key.startsWith("db.reader.") || key === "db.connection",
          ),
        );
        telemetry.push({
          name: span.name,
          durationMs: Number(time - span.startTime) / 1e6,
          attributes,
        });
      }
      ended = true;
      end(time, exit);
    };
    return span;
  },
});
const network = NodeHttpServer.layer(() => server, { host: "127.0.0.1", port: 0 });
const config = ServerConfig.layerTest(process.cwd(), home).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
);
const persistence = Sqlite.layerConfig.pipe(Layer.provideMerge(config));
const boards = Layer.unwrap(
  Effect.gen(function* () {
    const cfg = yield* ServerConfig.ServerConfig;
    return BoardsDatabase.layerFromPaths(
      NodePath.join(NodePath.dirname(cfg.dbPath), "boards.sqlite"),
      cfg.dbPath,
    );
  }),
).pipe(Layer.provideMerge(persistence));
const stores = Layer.mergeAll(
  ProjectionStore.layer,
  ProjectStore.layer,
  ControlStore.layer,
  CredentialStore.layer,
  ServerSecretStore.layer,
).pipe(Layer.provideMerge(boards));
const environmentId = EnvironmentId.make("environment:synthetic-latency");
const environment = Layer.mergeAll(
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  }),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("Unused descriptor"),
  }),
);
const auth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(stores),
  Layer.provideMerge(environment),
);
const registry = McpSessionRegistry.layer.pipe(
  Layer.provideMerge(auth),
  Layer.provideMerge(network),
);
const baseLayer = McpOAuth.layerMcpClientAuthenticator.pipe(Layer.provideMerge(registry));
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * values.length) - 1)];
const program = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()));
    const sql = yield* SqlClient.SqlClient;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const cfg = yield* ServerConfig.ServerConfig;
    const sessions = yield* SessionStore.SessionStore;
    const credentials = yield* McpSessionRegistry.McpSessionRegistry;
    const clients = yield* McpHttpServer.McpClientAuthenticator;
    const counts = Object.fromEntries(
      ["threads", "runs", "nodes"].map((kind) => [
        kind,
        compositionOnly ? 1 : shape.tables[`orchestration_v2_projection_${kind}`].rows,
      ]),
    );
    const at = "2026-11-13T00:00:00.000Z";
    const archived = compositionOnly ? 0 : latencyShape.threads.archived;
    const deleted = compositionOnly ? 0 : latencyShape.threads.deleted;
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('latency-project','Synthetic latency','/synthetic','[]',${at},${at})`;
    // SQL bulk seeding avoids millions of startup event transactions; payloads are wholly synthetic.
    for (const kind of ["threads", "runs", "nodes"]) {
      const stats = shape.tables[`orchestration_v2_projection_${kind}`].jsonBytes;
      for (let start = 0; start < counts[kind]; start += 1024) {
        const end = Math.min(counts[kind], start + 1024);
        const bytes = quantileValue(stats, (start + (end - start) / 2) / counts[kind]);
        const threadId = `latency-thread-${start % counts.threads}`;
        const template =
          kind === "threads"
            ? {
                id: `latency-thread-${start}`,
                projectId: "latency-project",
                title: `Synthetic ${start}`,
                providerInstanceId: "codex",
                modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdBy: "user",
                creationSource: "web",
                activeProviderThreadId: null,
                lineage: {
                  rootThreadId: `latency-thread-${start}`,
                  parentThreadId: null,
                  relationshipToParent: null,
                },
                forkedFrom: null,
                createdAt: at,
                updatedAt: at,
                archivedAt: start < archived ? at : null,
                settledOverride: null,
                settledAt: null,
                lastVisitedAt: null,
                deletedAt: start >= counts.threads - deleted ? at : null,
                syntheticPadding: "",
              }
            : kind === "runs"
              ? {
                  id: `latency-run-${start}`,
                  threadId,
                  ordinal: 1 + Math.floor(start / counts.threads),
                  providerInstanceId: "codex",
                  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
                  status: "completed",
                  requestedAt: at,
                  completedAt: at,
                  syntheticPadding: "",
                }
              : {
                  id: `latency-node-${start}`,
                  threadId,
                  runId: null,
                  parentNodeId: null,
                  rootNodeId: `latency-node-${start}`,
                  kind: "root_turn",
                  status: "completed",
                  countsForRun: true,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  runtimeRequestId: null,
                  checkpointScopeId: null,
                  startedAt: null,
                  completedAt: null,
                  syntheticPadding: "",
                };
        const padding = "x".repeat(Math.max(0, bytes - JSON.stringify(template).length));
        if (kind === "threads")
          yield* sql`
        WITH RECURSIVE n(i) AS (SELECT ${start} UNION ALL SELECT i+1 FROM n WHERE i+1<${end})
        INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,payload_json,provider_instance_id)
        SELECT 'latency-thread-'||i,'latency-project','Synthetic '||i,'codex','full-access','default',NULL,${at},${at},CASE WHEN i<${archived} THEN ${at} ELSE NULL END,CASE WHEN i>=${counts.threads - deleted} THEN ${at} ELSE NULL END,
        json_object('id','latency-thread-'||i,'projectId','latency-project','title','Synthetic '||i,'providerInstanceId','codex','modelSelection',json_object('instanceId','codex','model','gpt-6.1-sol'),'runtimeMode','full-access','interactionMode','default','branch',NULL,'worktreePath',NULL,'createdBy','user','creationSource','web','activeProviderThreadId',NULL,'lineage',json_object('rootThreadId','latency-thread-'||i,'parentThreadId',NULL,'relationshipToParent',NULL),'forkedFrom',NULL,'createdAt',${at},'updatedAt',${at},'archivedAt',CASE WHEN i<${archived} THEN ${at} ELSE NULL END,'settledOverride',NULL,'settledAt',NULL,'lastVisitedAt',NULL,'deletedAt',CASE WHEN i>=${counts.threads - deleted} THEN ${at} ELSE NULL END,'syntheticPadding',${padding}),'codex' FROM n`;
        if (kind === "runs")
          yield* sql`
        WITH RECURSIVE n(i) AS (SELECT ${start} UNION ALL SELECT i+1 FROM n WHERE i+1<${end})
        INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json)
        SELECT 'latency-run-'||i,'latency-thread-'||(i%${counts.threads}),1+CAST(i/${counts.threads} AS INTEGER),'codex','completed',${at},${at},json_object('id','latency-run-'||i,'threadId','latency-thread-'||(i%${counts.threads}),'ordinal',1+CAST(i/${counts.threads} AS INTEGER),'providerInstanceId','codex','modelSelection',json_object('instanceId','codex','model','gpt-6.1-sol'),'status','completed','requestedAt',${at},'completedAt',${at},'syntheticPadding',${padding}) FROM n`;
        if (kind === "nodes")
          yield* sql`
        WITH RECURSIVE n(i) AS (SELECT ${start} UNION ALL SELECT i+1 FROM n WHERE i+1<${end})
        INSERT INTO orchestration_v2_projection_nodes (node_id,thread_id,run_id,root_node_id,kind,status,payload_json)
        SELECT 'latency-node-'||i,'latency-thread-'||(i%${counts.threads}),NULL,'latency-node-'||i,'root_turn','completed',json_object('id','latency-node-'||i,'threadId','latency-thread-'||(i%${counts.threads}),'runId',NULL,'parentNodeId',NULL,'rootNodeId','latency-node-'||i,'kind','root_turn','status','completed','countsForRun',json('true'),'providerThreadId',NULL,'providerTurnId',NULL,'nativeItemRef',NULL,'runtimeRequestId',NULL,'checkpointScopeId',NULL,'startedAt',NULL,'completedAt',NULL,'syntheticPadding',${padding}) FROM n`;
      }
      process.stdout.write(`Seeded ${kind}: ${counts[kind]}\n`);
    }
    const observedCounts = {};
    for (const kind of ["threads", "runs", "nodes"]) {
      const rows = yield* sql.unsafe(
        `SELECT count(*) AS n FROM orchestration_v2_projection_${kind}`,
      );
      observedCounts[kind] = rows[0].n;
      if (rows[0].n !== counts[kind]) throw new Error(`Synthetic ${kind} count mismatch`);
    }
    process.stdout.write("Setup: counts verified\n");
    const indexStarted = NodePerfHooks.performance.now();
    yield* ensureShellLookupIndexes();
    const startupIndexMs = NodePerfHooks.performance.now() - indexStarted;
    process.stdout.write("Setup: startup index path complete\n");
    const indexes =
      yield* sql`SELECT name FROM sqlite_schema WHERE type='index' AND name='ardud_control_thread_candidates_idx'`;
    yield* sql`CREATE TABLE overload_latency_writer (id INTEGER PRIMARY KEY, value INTEGER)`;
    yield* sql`INSERT INTO overload_latency_writer VALUES (1,0)`;
    const node = {
      id: NodeId.make("latency-node-0"),
      threadId: ThreadId.make("latency-thread-0"),
      runId: null,
      parentNodeId: null,
      rootNodeId: NodeId.make("latency-node-0"),
      kind: "root_turn",
      status: "completed",
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: null,
      completedAt: null,
    };
    const point = projection.isNodeStored(node);
    const snapshots = (options) =>
      loadShellSnapshotParts({
        sql,
        readThreads: projection.readShellSnapshot(options),
        listProjects: projects.listShells(),
        latestSequence: Effect.succeed(0),
        ...(options?.threadIds ? { bounded: true } : {}),
      }).pipe(Effect.map((reply) => reply.threads));
    const threadLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
      getCallerRow: (id) => projection.getCallerRow(id).pipe(NodeSqliteClient.readOnly),
      getShellSnapshot: snapshots,
      getThreadShell: (id) => projection.getThreadShell(id).pipe(NodeSqliteClient.readOnly),
      getThreadRecords: (id, fields) =>
        projection.getThreadRecords(id, fields).pipe(NodeSqliteClient.readOnly),
    });
    const supporting = Layer.mergeAll(
      threadLayer,
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ProjectService.ProjectService)({
        listShells: (options) => projects.listShells(options),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/synthetic",
        scratchRoot: Effect.succeed(Option.none()),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
        latestAgentSequence: () => Effect.succeed(0),
      }),
      Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
        enqueueCommand: (effect) => effect,
      }),
      Layer.succeed(
        StartupPhaseLog.StartupPhaseLog,
        StartupPhaseLog.makeStartupPhaseLog(cfg.logsDir),
      ),
    );
    const toolkit = Toolkit.make(
      Tool.make("latency_point", {
        description: "Synthetic node lookup",
        success: Schema.Struct({ stored: Schema.Boolean }),
        failure: OrchestratorMcpFailure,
        failureMode: "return",
      }),
    );
    const tools = McpHttpServer.toolkitRegistration(
      toolkit,
      McpToolAccess.toLayer(toolkit, {
        latency_point: McpToolAccess.reads(() =>
          point.pipe(
            Effect.orDie,
            Effect.map((stored) => ({ stored })),
            Effect.withSpan("Latency.tool"),
          ),
        ),
      }),
    ).pipe(Layer.provideMerge(McpHttpServer.layerMcpTransport));
    const routes = Layer.mergeAll(controlRouteLayer, tools).pipe(
      Layer.provide(supporting),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
    );
    process.stdout.write("Setup: building real routes\n");
    yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.build,
    );
    process.stdout.write("Setup: real routes ready\n");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing isolated HTTP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const clientSession = yield* sessions.issue({
      subject: "mcp-client",
      method: "bearer-access-token",
      scopes: ["orchestration:read", "orchestration:operate"],
      runtimeModeCeiling: "full-access",
      client: { label: "Synthetic latency", deviceType: "bot" },
    });
    const controlSession = yield* sessions.issue({
      subject: "latency-control",
      method: "bearer-access-token",
      scopes: ["orchestration:read"],
      client: { label: "Synthetic control latency", deviceType: "bot" },
    });
    const issued = yield* credentials.issue({
      threadId: ThreadId.make("latency-thread-0"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const providerToken = issued.config.authorizationHeader.slice("Bearer ".length);
    const clientRequest = HttpServerRequest.fromWeb(
      new Request(`${origin}/mcp`, {
        headers: { authorization: `Bearer ${clientSession.token}` },
      }),
    );
    const get = Effect.tryPromise(async (signal) => {
      const reply = await fetch(`${origin}/api/ardud/control/threads?limit=1`, {
        signal,
        headers: { authorization: `Bearer ${controlSession.token}` },
      });
      const body = await reply.json();
      if (reply.status !== 200 || body.threads?.length !== 1)
        throw new Error("Control response failed logical-size check: " + JSON.stringify({ status: reply.status, count: body.threads?.length, ok: body.ok, error: body.error ?? body.message, total: body.total }));
    });
    const providerAuth = credentials
      .resolve(providerToken)
      .pipe(
        Effect.flatMap((scope) =>
          scope ? Effect.void : Effect.die("Issued provider credential rejected"),
        ),
      );
    const clientAuth = clients
      .authenticate(clientRequest)
      .pipe(
        Effect.flatMap((scope) =>
          scope ? Effect.void : Effect.die("Issued client credential rejected"),
        ),
      );
    const mcpHeaders = {
      authorization: `Bearer ${providerToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    const rpcResponse = (body, id) => {
      const frames = body.trim().startsWith("{")
        ? [body]
        : body
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6));
      return frames.map((frame) => JSON.parse(frame)).find((frame) => frame.id === id);
    };
    process.stdout.write("Setup: credentials issued\n");
    const initialized = yield* Effect.tryPromise(async () => {
      const reply = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "synthetic", version: "1" },
          },
        }),
      });
      const response = rpcResponse(await reply.text(), 1);
      if (reply.status !== 200 || !response?.result?.protocolVersion)
        throw new Error("MCP initialization failed");
      return reply.headers.get("mcp-session-id");
    });
    const transportHeaders = {
      ...mcpHeaders,
      ...(initialized ? { "mcp-session-id": initialized } : {}),
      "mcp-protocol-version": "2025-06-18",
    };
    yield* Effect.tryPromise(async () => {
      const reply = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: transportHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      await reply.text();
      if (![200, 202, 204].includes(reply.status))
        throw new Error("MCP initialized notification rejected");
    });
    let mcpSequence = 1;
    const wholeMcp = Effect.tryPromise(async (signal) => {
      const id = ++mcpSequence;
      const reply = await fetch(`${origin}/mcp`, {
        signal,
        method: "POST",
        headers: transportHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "latency_point", arguments: {} },
        }),
      });
      const response = rpcResponse(await reply.text(), id);
      const result = response?.result;
      const payload =
        result?.structuredContent ??
        result?.content
          ?.filter((item) => item.type === "text")
          .map((item) => {
            try {
              return JSON.parse(item.text);
            } catch {
              return null;
            }
          })
          .find((item) => typeof item?.stored === "boolean");
      if (reply.status !== 200 || result?.isError || typeof payload?.stored !== "boolean")
        throw new Error("MCP tool request did not execute the PK lookup");
    });
    process.stdout.write("Setup: MCP initialized\n");
    measuring = compositionOnly;
    yield* Effect.all([get, point, providerAuth, clientAuth, wholeMcp], { concurrency: 1 });
    process.stdout.write("Setup: all warm request streams served\n");
    if (compositionOnly) {
      const required = ["db.lock_wait_ms", "db.reader.hold_ms"];
      if (revision !== "dbc99fc3a4b817977bc23a57ea7c049da5d45190")
        required.push("db.reader.acquire_wait_ms", "db.statement.execution_ms");
      for (const key of required)
        if (!telemetry.some((span) => Number.isFinite(span.attributes[key])))
          throw new Error(`Setup required emitted diagnostic absent: ${key}`);
      return { mode: "composition-check", ready: true, revision, diagnostics: required };
    }
    const entered = yield* Deferred.make();
    const release = yield* Deferred.make();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    const writerEntered = yield* Deferred.make();
    const archiveRequested = yield* Deferred.make();
    const background = yield* sql
      .withTransaction(
        sql`SELECT thread_id FROM orchestration_v2_projection_threads LIMIT 1`.pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Deferred.await(release)),
        ),
      )
      .pipe(NodeSqliteClient.readOnly, NodeSqliteClient.backgroundReads, Effect.forkScoped);
    yield* Deferred.await(entered);
    const writer = yield* sql
      .withTransaction(
        sql`UPDATE overload_latency_writer SET value=value+1 WHERE id=1`.pipe(
          Effect.andThen(Deferred.succeed(writerEntered, undefined)),
          Effect.andThen(Deferred.await(release)),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(writerEntered);
    const context = yield* Effect.context();
    let archiveEntered = false;
    let archiveExit;
    let archiveFiber;
    yield* Effect.addFinalizer(() => (archiveFiber ? Fiber.interrupt(archiveFiber) : Effect.void));
    const onConnection = (socket) =>
      socket.on("message", () => {
        const archive = loadShellSnapshotParts({
          sql,
          readThreads: projection.readShellSnapshot({ location: "archive" }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                archiveEntered = true;
              }),
            ),
            Effect.tap(() => Deferred.await(release)),
          ),
          listProjects: projects.listShells(),
          latestSequence: Effect.succeed(0),
        }).pipe(NodeSqliteClient.foregroundReads);
        archiveFiber = Effect.runFork(
          Deferred.succeed(archiveRequested, undefined).pipe(
            Effect.andThen(archive),
            Effect.provide(context),
            Effect.withTracer(trace),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                archiveExit = exit._tag;
                socket.close();
              }),
            ),
          ),
        );
      });
    sockets.on("connection", onConnection);
    yield* Effect.acquireRelease(
      Effect.tryPromise(
        () =>
          new Promise((resolve, reject) => {
            wsServer.once("error", reject);
            wsServer.listen(0, "127.0.0.1", resolve);
          }),
      ),
      () => Effect.promise(() => new Promise((resolve) => wsServer.close(resolve))),
    );
    const wsAddress = wsServer.address();
    const ws = new WebSocket(`ws://127.0.0.1:${wsAddress.port}/overload-archive`);
    yield* Effect.tryPromise(
      () =>
        new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve, { once: true });
          ws.addEventListener("error", reject, { once: true });
        }),
    );
    ws.send(
      JSON.stringify({
        method: "orchestration.getShellSnapshot",
        params: { location: "archive" },
      }),
    );
    yield* Deferred.await(archiveRequested);
    const observations = {
      threads: [],
      nodePk: [],
      providerCredential: [],
      clientCredential: [],
      wholeMcp: [],
    };
    const measure = Effect.fn("Latency.measure")(function* (name, action) {
      const began = NodePerfHooks.performance.now();
      const exit = yield* action.pipe(
        Effect.as(true),
        Effect.timeoutOption("3 seconds"),
        Effect.exit,
      );
      observations[name].push({
        ms: NodePerfHooks.performance.now() - began,
        completed: exit._tag === "Success" && Option.isSome(exit.value),
        timedOut: exit._tag === "Success" && Option.isNone(exit.value),
        error: exit._tag === "Failure" ? String(exit.cause).slice(0, 160) : null,
        longReaderActive: background.pollUnsafe() === undefined,
        writerActive: writer.pollUnsafe() === undefined,
        archiveEntered,
      });
    });
    const measuredAt = new Date().toISOString();
    measuring = true;
    yield* Effect.gen(function* () {
      for (let i = 0; i < samples; i++)
        yield* Effect.all(
          [
            measure("threads", get),
            measure("nodePk", point),
            measure("providerCredential", providerAuth),
            measure("clientCredential", clientAuth),
            measure("wholeMcp", wholeMcp),
          ],
          { concurrency: 5 },
        );
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    yield* Fiber.join(background);
    yield* Fiber.join(writer);
    // The archive may have queued on the sole background slot; drain it before closing the server.
    yield* Effect.tryPromise(
      () =>
        new Promise((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) resolve();
          else ws.addEventListener("close", resolve, { once: true });
        }),
    ).pipe(Effect.timeout("120 seconds"));
    measuring = false;
    sockets.off("connection", onConnection);
    yield* Effect.promise(() => new Promise((resolve) => sockets.close(resolve)));
    const streams = Object.fromEntries(
      Object.entries(observations).map(([name, rows]) => [
        name,
        {
          count: rows.length,
          completed: rows.filter((row) => row.completed).length,
          p99MsLowerBound: percentile(
            rows.map((row) => row.ms),
            0.99,
          ),
          maxMsLowerBound: Math.max(...rows.map((row) => row.ms)),
          heldForEverySample: rows.every((row) => row.longReaderActive && row.writerActive),
          observations: rows,
        },
      ]),
    );
    return {
      scenario: "request-latency-1365",
      revision,
      home,
      samples,
      startedAt: measuredAt,
      completedAt: new Date().toISOString(),
      node: process.version,
      cpu: NodeOS.cpus()[0]?.model,
      runtimeFlags: process.execArgv,
      counts: observedCounts,
      archivedThreads: archived,
      deletedThreads: deleted,
      postSeedIndexEnsureMs: startupIndexMs,
      candidateIndexPresent: indexes.length === 1,
      archiveEntered,
      archiveExit,
      streams,
      telemetry,
      limitations: [
        "WS wire adapter is harness-owned and calls the real loadShellSnapshotParts path in a foreground request scope; production WS authentication/RPC decoding is outside it.",
        "Bulk SQL seed uses measured table counts and 1024-row quantile buckets; synthetic payloads contain no private values.",
        "Timed-out samples are right-censored lower bounds, never completed request latencies.",
        "Older revisions may lack acquire_wait_ms and worker execution telemetry; inclusive statement time is never relabelled as execution.",
      ],
    };
  }),
).pipe(
  Effect.provide(baseLayer),
  Effect.withTracer(trace),
  Effect.provideService(Statement.SpanPropagationEnabled, true),
  Effect.tap((result) =>
    Effect.tryPromise(() =>
      NodeFSP.writeFile(NodePath.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n"),
    ),
  ),
  Effect.tap(() =>
    Effect.sync(() => process.stdout.write(`Latency measurement complete: ${out}\n`)),
  ),
  Effect.tapCause((cause) =>
    Effect.sync(() =>
      process.stderr.write(
        Cause.pretty(cause).replace(/Bearer [A-Za-z0-9._~-]+/g, "Bearer [redacted]") + "\n",
      ),
    ),
  ),
);
NodeRuntime.runMain(program);
