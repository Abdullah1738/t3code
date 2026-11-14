import * as DatabaseDiagnostics from "../../persistence/DatabaseDiagnostics.ts";
/**
 * `/threads?active=true` and `/requests` start from the live and pending ids
 * in the projection tables instead of the whole shell snapshot, and still
 * apply the exact shell filters.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  OrchestrationV2AppThreadJson,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CONTROL_ROUTE_PREFIX, controlRouteLayer } from "./http.ts";
import * as StartupPhaseLog from "../observability/StartupPhaseLog.ts";

const askedAt = DateTime.makeUnsafe("2026-01-01T00:05:00.000Z");
const encodeThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

const shell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({ ...liveThreadShell(ThreadId.make(id)), ...overrides });

const idle = { status: "completed", activeRunId: null } as const;
const waiting = (requestId: string) => ({
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make(requestId),
    kind: "user_input" as const,
    createdAt: askedAt,
  },
});

/**
 * Every shell the store knows. `live-*` have an unfinished run row, `asks-*`
 * a pending request row, `quiet` neither.
 */
const shells: ReadonlyArray<OrchestrationV2ThreadShell> = [
  shell("live-running"),
  shell("live-queued", { status: "queued", activeRunId: null }),
  // A run row that has not ended yet while the shell already reads idle.
  shell("live-settling", idle),
  shell("live-archived", { archivedAt: askedAt }),
  shell("live-deleted", { deletedAt: askedAt }),
  shell("live-subagent", {
    lineage: {
      rootThreadId: ThreadId.make("live-running"),
      parentThreadId: ThreadId.make("live-running"),
      relationshipToParent: "subagent",
    },
  }),
  shell("asks-waiting", { ...idle, ...waiting("request-waiting") }),
  shell("asks-archived", { ...idle, ...waiting("request-archived"), archivedAt: askedAt }),
  shell("quiet", idle),
  shell("migrated"),
];

const projectionFor = (threadId: ThreadId): OrchestrationV2ThreadProjection => {
  const found = shells.find((candidate) => candidate.id === threadId) ?? shell(threadId);
  const pending = found.pendingRuntimeRequest;
  return {
    ...idleThreadProjection(found),
    runtimeRequests:
      pending === null
        ? []
        : [
            {
              id: pending.id,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: pending.createdAt,
            },
          ],
  } as unknown as OrchestrationV2ThreadProjection;
};

const seedRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const run = (threadId: string, ordinal: number, status: string) =>
    sql`
      INSERT INTO orchestration_v2_projection_runs ${sql.insert({
        run_id: `run:${threadId}:${ordinal}`,
        thread_id: threadId,
        ordinal,
        provider: "codex",
        status,
        requested_at: "2026-01-01T00:00:00.000Z",
        completed_at: null,
        payload_json: "{}",
      })}
    `;
  const request = (threadId: string, requestId: string, status: string) =>
    sql`
      INSERT INTO orchestration_v2_projection_runtime_requests ${sql.insert({
        runtime_request_id: requestId,
        thread_id: threadId,
        node_id: "node",
        provider_turn_id: null,
        kind: "user_input",
        status,
        created_at: "2026-01-01T00:05:00.000Z",
        resolved_at: null,
        payload_json: JSON.stringify({
          id: requestId,
          nodeId: "node",
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status,
          responseCapability: { type: "message" },
          createdAt: "2026-01-01T00:05:00.000Z",
          resolvedAt: null,
        }),
      })}
    `;
  yield* run("live-running", 1, "completed");
  yield* run("live-running", 2, "running");
  yield* run("live-queued", 1, "queued");
  yield* run("live-settling", 1, "waiting");
  yield* run("live-archived", 1, "running");
  yield* run("live-deleted", 1, "running");
  yield* run("live-subagent", 1, "starting");
  // A thread whose shell is gone by the time the list reads it.
  yield* run("live-vanished", 1, "running");
  yield* run("quiet", 1, "completed");
  yield* request("asks-waiting", "request-waiting", "pending");
  yield* request("asks-archived", "request-archived", "pending");
  yield* request("quiet", "request-answered", "resolved");
  // A thread migrated from OpenCode to Claude: the old ses_ row was written
  // later than the Claude row, so only activeProviderThreadId picks the right id.
  yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
    thread_id: "migrated",
    project_id: "project",
    title: "migrated",
    default_provider: "claudeAgent",
    runtime_mode: "full-access",
    interaction_mode: "default",
    active_provider_thread_id: "pt-migrated-claude",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
    deleted_at: null,
    provider_instance_id: "claudeAgent",
    payload_json: JSON.stringify({
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "migrated" },
      activeProviderThreadId: "pt-migrated-claude",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    }),
  })}`;
  for (const [providerThreadId, driver, nativeId, updatedAt] of [
    ["pt-migrated-claude", "claudeAgent", "claude-session-uuid", "2026-01-01T00:00:00.000Z"],
    ["pt-migrated-oc", "opencode", "ses_migrated_old", "2026-01-02T00:00:00.000Z"],
  ] as const) {
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert({
      provider_thread_id: providerThreadId,
      thread_id: "migrated",
      owner_node_id: null,
      provider: driver,
      provider_session_id: null,
      status: "idle",
      first_run_ordinal: 1,
      last_run_ordinal: 1,
      updated_at: updatedAt,
      driver,
      provider_instance_id: driver,
      payload_json: JSON.stringify({
        id: providerThreadId,
        driver,
        providerInstanceId: driver,
        appThreadId: "migrated",
        nativeThreadRef: { driver, nativeId, strength: "strong" },
      }),
    })}`;
  }
});

// Shaped like the real snapshot: the location picks which threads are read,
// and archived ones always come back under archivedThreads.
const snapshotFor = (
  location: "active" | "archive",
  extra: ReadonlyArray<OrchestrationV2ThreadShell>,
) => {
  const read = [...shells, ...extra].filter(
    (candidate) => (candidate.archivedAt !== null) === (location === "archive"),
  );
  return {
    schemaVersion: 1,
    snapshotSequence: 1,
    threads: read.filter((candidate) => candidate.archivedAt === null),
    archivedThreads: read.filter((candidate) => candidate.archivedAt !== null),
  };
};

const makeHarness = (
  buildCommit?: string,
  extraShells: ReadonlyArray<OrchestrationV2ThreadShell> = [],
  // Shells deleted after their projection row was read: the row stays, the shell read is null.
  vanished: ReadonlySet<string> = new Set(),
  // Failures the session check returns, in order, before it succeeds.
  authFailures: Array<unknown> = [],
  realSnapshots = false,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* ProjectStore.make;
    if (!realSnapshots) yield* seedRows;
    const projection = realSnapshots
      ? yield* ProjectionStore.ProjectionStoreV2.pipe(Effect.provide(ProjectionStore.layer))
      : undefined;
    // Light-row listings and shell reads must see the same persisted threads.
    for (const extra of [...shells, ...extraShells]) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: extra.id,
        project_id: extra.projectId,
        title: extra.title,
        default_provider: "codex",
        runtime_mode: "full-access",
        interaction_mode: "default",
        active_provider_thread_id: null,
        created_at: DateTime.formatIso(extra.createdAt),
        updated_at: DateTime.formatIso(extra.updatedAt),
        archived_at: extra.archivedAt === null ? null : DateTime.formatIso(extra.archivedAt),
        deleted_at: extra.deletedAt === null ? null : DateTime.formatIso(extra.deletedAt),
        provider_instance_id: "codex",
        payload_json: yield* encodeThreadPayload(idleThreadProjection(extra).thread).pipe(
          Effect.orDie,
        ),
      })} ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at`;
    }
    const snapshotReads = yield* Ref.make(0);
    // Targeted (threadIds) shell reads and one-thread shell reads, counted apart.
    const targetedReads = yield* Ref.make<Array<ReadonlyArray<string>>>([]);
    const shellReads = yield* Ref.make(0);
    const recordReads = yield* Ref.make(0);
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-control-listings" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    const startupLog = StartupPhaseLog.makeStartupPhaseLog(config.logsDir);
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getShellSnapshot: (options) => {
        const ids = options?.threadIds;
        if (projection !== undefined) {
          return (
            ids === undefined
              ? Ref.update(snapshotReads, (count) => count + 1)
              : Ref.update(targetedReads, (reads) => [...reads, ids])
          ).pipe(Effect.andThen(projection.getShellSnapshot(options)), Effect.orDie);
        }
        if (ids !== undefined) {
          const full = snapshotFor(options?.location ?? "active", extraShells);
          const keep = (candidate: OrchestrationV2ThreadShell) =>
            ids.includes(candidate.id) && !vanished.has(candidate.id);
          return Ref.update(targetedReads, (reads) => [...reads, ids]).pipe(
            Effect.as({
              ...full,
              snapshotSequence: 0,
              threads: full.threads.filter(keep),
              archivedThreads: full.archivedThreads.filter(keep),
            }),
          );
        }
        return Ref.update(snapshotReads, (count) => count + 1).pipe(
          Effect.as(snapshotFor(options?.location ?? "active", extraShells)),
        );
      },
      getThreadShell: (threadId) =>
        sql
          .withTransaction(sql`SELECT 1`)
          .pipe(
            Effect.orDie,
            Effect.andThen(Ref.update(shellReads, (count) => count + 1)),
            Effect.as(
              vanished.has(threadId)
                ? null
                : ([...shells, ...extraShells].find((candidate) => candidate.id === threadId) ??
                    null),
            ),
          ),
      getThreadRecords: (threadId) =>
        Ref.update(recordReads, (n) => n + 1).pipe(Effect.as(projectionFor(threadId))),
    });
    const diagnostics = yield* Effect.serviceOption(DatabaseDiagnostics.DatabaseDiagnostics);
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          controlRouteLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                  authenticateHttpRequest: () =>
                    Effect.suspend(() =>
                      authFailures.length > 0
                        ? Effect.fail(
                            new EnvironmentAuth.ServerAuthSessionCredentialValidationError({
                              cause: authFailures.shift(),
                            }),
                          )
                        : sql`SELECT 1`.pipe(
                            NodeSqliteClient.authReadOnly,
                            Effect.orDie,
                            Effect.as({
                              sessionId: AuthSessionId.make("session-cli"),
                              subject: "cli-issued-session",
                              method: "bearer-access-token" as const,
                              scopes: ["orchestration:read", "orchestration:operate"],
                            }),
                          ),
                    ),
                }),
                Option.isSome(diagnostics)
                  ? Layer.succeed(DatabaseDiagnostics.DatabaseDiagnostics, diagnostics.value)
                  : Layer.empty,
                threads,
                Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
                Layer.mock(Orchestrator.OrchestratorV2)({}),
                Layer.mock(ProjectService.ProjectService)({
                  listShells: (options) =>
                    projects.listShells(options).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProjectService.ProjectOperationError({
                            operation: "list-projects",
                            cause,
                          }),
                      ),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/tmp/named",
                  scratchRoot: Effect.succeed(Option.none()),
                }),
                Layer.mock(ProviderRegistry.ProviderRegistry)({}),
                ServerSettings.layerTest(),
                Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
                  enqueueCommand: (effect) => effect,
                }),
                Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
                  latestAgentSequence: () => Effect.succeed(42),
                }),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
                Layer.mock(ServerSecretStore.ServerSecretStore)({}),
                Layer.succeed(ServerConfig.ServerConfig, {
                  ...config,
                  robobBuildCommit: buildCommit,
                }),
                Layer.succeed(SqlClient.SqlClient, sql),
                Layer.succeed(StartupPhaseLog.StartupPhaseLog, startupLog),
              ).pipe(Layer.provideMerge(NodeServices.layer)),
            ),
            Layer.provide(
              HttpPlatform.layer.pipe(
                Layer.provideMerge(NodeServices.layer),
                Layer.provideMerge(Etag.layerWeak),
              ),
            ),
          ),
          { disableLogger: true },
        ),
      ),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const get = (path: string) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request(`http://env.local${CONTROL_ROUTE_PREFIX}${path}`, {
            headers: { authorization: "Bearer shared" },
          }),
        );
        return {
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
          body: (await response.json()) as Record<string, any>,
        };
      });
    const threadIds = (path: string) =>
      get(path).pipe(
        Effect.map((response) => {
          assert.strictEqual(response.status, 200);
          return (response.body.threads as ReadonlyArray<{ threadId: string }>)
            .map((thread) => thread.threadId)
            .toSorted();
        }),
      );
    return {
      get,
      threadIds,
      snapshotReads,
      targetedReads,
      shellReads,
      recordReads,
      startupLog,
      sql,
    };
  });

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

// `buildCommit` is main's startup-commit fixture; `extraShells` adds threads to the snapshot for one test.
const run = <A, E>(
  body: (h: Harness) => Effect.Effect<A, E>,
  buildCommit?: string,
  extraShells: ReadonlyArray<OrchestrationV2ThreadShell> = [],
  vanished: ReadonlySet<string> = new Set(),
  authFailures: Array<unknown> = [],
) =>
  Effect.scoped(
    Effect.flatMap(makeHarness(buildCommit, extraShells, vanished, authFailures), body),
  ).pipe(Effect.provide(Sqlite.layerMemory));

describe("control listings", () => {
  it.effect("includes current boot phase timings in the authenticated install report", () =>
    run(({ get, startupLog }) =>
      Effect.gen(function* () {
        const id = startupLog.start("sqlite.migrations", 1000);
        startupLog.end("sqlite.migrations", 6000, 5000, "success", undefined, id);
        const response = yield* get("/install-report");
        assert.equal(response.status, 200);
        assert.equal(response.body.bootId, response.body.startup.bootId);
        assert.includeDeepMembers(response.body.startup.phases, [
          {
            id,
            phase: "sqlite.migrations",
            startedAt: "1970-01-01T00:00:01.000Z",
            endedAt: "1970-01-01T00:00:06.000Z",
            durationMs: 5000,
            outcome: "success",
          },
        ]);
        assert.isTrue(
          response.body.startup.phases.some(
            (phase: { phase: string; outcome: string }) =>
              phase.phase === "http.control-routes" && phase.outcome === "success",
          ),
        );
      }),
    ),
  );
  it.effect("health retains primary corruption after SQL requests work again", () =>
    Effect.gen(function* () {
      let now = 0;
      const monitor = DatabaseDiagnostics.createDatabaseMonitor(
        () => now,
        () => {},
      );
      monitor.observe(
        { errcode: 779 },
        {
          file: "/isolated/state.sqlite",
          role: "primary",
          connection: "reader",
          operation: "execute",
          span: "test",
        },
      );
      yield* run(({ get }) =>
        Effect.gen(function* () {
          const first = yield* get("/health");
          assert.equal(first.body.status, "degraded");
          assert.equal(first.body.databaseErrors[0].errcode, 779);
          now = 300_000;
          const next = yield* get("/health");
          assert.equal(next.body.status, "recovered-unverified");
          assert.equal(next.body.databaseErrors[0].file, "/isolated/state.sqlite");
        }),
      ).pipe(
        Effect.provideService(DatabaseDiagnostics.DatabaseDiagnostics, {
          health: Effect.sync(monitor.health),
        }),
      );
    }),
  );

  it.effect("reports a validated build commit captured at startup", () =>
    Effect.gen(function* () {
      for (const [input, expected] of [
        ["abcdef012345", "abcdef012345"],
        [undefined, null],
        ["unknown", null],
        ["ABCDEF012345", null],
        ["abcdef012345\n", null],
      ] as const) {
        yield* run(
          ({ get }) =>
            Effect.gen(function* () {
              const first = yield* get("/health");
              const second = yield* get("/health");
              assert.strictEqual(first.status, 200);
              assert.strictEqual(first.body.status, "healthy");
              assert.strictEqual(first.body.sequence, 42);
              assert.strictEqual(first.body.buildCommit, expected);
              assert.strictEqual(second.body.buildCommit, expected);
              assert.match(first.body.serverStartedAt, /^\d{4}-\d{2}-\d{2}T/);
              assert.strictEqual(second.body.serverStartedAt, first.body.serverStartedAt);
            }),
          input,
        );
      }
    }),
  );
  it.live("lists projects and pending requests from the reader while the writer is held", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-control-projects-reader-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const harness = yield* makeHarness();
        yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('reader-project', 'Reader project', '/workspace/reader', '[]',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        // Initialize route layers and their DDL before testing a request.
        assert.strictEqual((yield* harness.get("/projects")).status, 200);
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* Effect.forkChild(
          sql.withTransaction(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(held);
        const [response, requests] = yield* Effect.all([
          harness.get("/projects"),
          harness.get("/requests"),
        ]).pipe(Effect.timeout("5 seconds"), Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(writer);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(requests.status, 200);
        assert.deepEqual(
          requests.body.requests.map((row: { requestId: string }) => row.requestId),
          ["request-waiting"],
        );
        assert.deepStrictEqual(response.body.projects, [
          {
            projectId: "reader-project",
            title: "Reader project",
            workspaceRoot: "/workspace/reader",
            defaultModel: null,
            scratch: false,
          },
        ]);
      }).pipe(Effect.provide(Sqlite.layerFromPath(path.join(dir, "state.sqlite"))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  const requestHoldCases = (["background reader", "writer"] as const).flatMap((heldConnection) =>
    ["", "?origin=none", "?origin=automation", "?origin=missing"].map((suffix) => ({
      heldConnection,
      suffix,
    })),
  );
  it.live.each(requestHoldCases)(
    "GET requests$suffix completes while the $heldConnection is held",
    ({ heldConnection, suffix }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "control-requests-latency-" });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const inherited = shell("asks-inherited", {
            ...idle,
            ...waiting("request-inherited"),
            lineage: {
              rootThreadId: ThreadId.make("live-running"),
              parentThreadId: ThreadId.make("live-running"),
              relationshipToParent: "subagent",
            },
          });
          const harness = yield* makeHarness(undefined, [inherited]);
          assert.equal((yield* harness.get("/requests")).status, 200);
          yield* sql`INSERT INTO ardud_thread_origin (thread_id, origin, created_at)
            VALUES ('live-running', 'automation', '2026-01-01T00:00:00.000Z')`;
          yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
            (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status,
              created_at, resolved_at, payload_json)
            SELECT 'request-inherited', 'asks-inherited', node_id, provider_turn_id, kind,
              status, '2026-01-01T00:06:00.000Z', resolved_at,
              json_set(payload_json, '$.id', 'request-inherited',
                '$.createdAt', '2026-01-01T00:06:00.000Z')
            FROM orchestration_v2_projection_runtime_requests
            WHERE runtime_request_id = 'request-waiting'`;
          const expected = yield* harness.get(`/requests${suffix}`);
          assert.equal(expected.status, 200);
          assert.deepEqual(
            expected.body.requests.map((row: { requestId: string }) => row.requestId),
            suffix === "?origin=missing"
              ? []
              : suffix === "?origin=automation"
                ? ["request-inherited"]
                : suffix === "?origin=none"
                  ? ["request-waiting"]
                  : ["request-waiting", "request-inherited"],
          );
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const hold = sql.withTransaction(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          );
          const holder = yield* (
            heldConnection === "background reader"
              ? hold.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.backgroundReads)
              : hold
          ).pipe(Effect.forkChild);
          yield* Deferred.await(held);
          yield* Effect.gen(function* () {
            for (let index = 0; index < 2; index += 1) {
              const response = yield* harness.get(`/requests${suffix}`);
              assert.equal(response.status, 200);
              assert.deepEqual(response.body, expected.body);
            }
            assert.isUndefined(holder.pollUnsafe());
            assert.equal(yield* Ref.get(harness.recordReads), 0);
            assert.equal(yield* Ref.get(harness.snapshotReads), 0);
          }).pipe(
            Effect.timeout("500 millis"),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          );
          yield* Fiber.join(holder);
        }).pipe(Effect.provide(Sqlite.layerFromPath(path.join(dir, "state.sqlite"))));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // All listing forms must keep candidate reads AND summary enrichment on the request lane.
  it.live.each([
    "limit=1",
    "limit=1&active=true",
    "limit=1&ids=quiet",
    "limit=1&ids=quiet&active=false",
    "limit=1&state=idle",
    "limit=1&updatedSince=2025-01-01T00:00:00.000Z",
    "limit=1&origin=none",
    "limit=1&archived=true",
    "limit=1&includeSubagents=true",
  ])(
    "GET threads %s completes during a long candidate scan and a writer",
    (query) => Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "control-list-latency-" });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const harness = yield* makeHarness();
          assert.equal((yield* harness.get(`/threads?${query}`)).status, 200);
          const readerHeld = yield* Deferred.make<void>();
          const writerHeld = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const hold = (signal: Deferred.Deferred<void>) =>
            Deferred.succeed(signal, undefined).pipe(Effect.andThen(Deferred.await(release)));
          // Model the old unbounded candidate scan's held snapshot, without a sleep.
          const reader = yield* sql
            .withTransaction(
              sql`SELECT thread_id, json_extract(payload_json, '$.lineage.parentThreadId')
                FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL`.pipe(
                Effect.andThen(hold(readerHeld)),
              ),
            )
            .pipe(NodeSqliteClient.readOnly, NodeSqliteClient.backgroundReads, Effect.forkChild);
          const writer = yield* sql.withTransaction(hold(writerHeld)).pipe(Effect.forkChild);
          yield* Deferred.await(readerHeld);
          yield* Deferred.await(writerHeld);
          yield* Effect.gen(function* () {
            const responses = yield* Effect.all(
              [harness.get(`/threads?${query}`), harness.get(`/threads?${query}`)],
              { concurrency: 2 },
            );
            for (const response of responses) {
              assert.equal(response.status, 200);
              assert.lengthOf(response.body.threads, 1);
            }
            yield* sql`SELECT 1`.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.foregroundReads);
            assert.isUndefined(reader.pollUnsafe());
            assert.isUndefined(writer.pollUnsafe());
            assert.equal(yield* Ref.get(harness.snapshotReads), 0);
            assert.isTrue(
              (yield* Ref.get(harness.targetedReads)).every((ids) => ids.length <= 128),
            );
          }).pipe(
            Effect.timeout("500 millis"),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          );
          yield* Fiber.join(reader);
          yield* Fiber.join(writer);
        }).pipe(Effect.provide(Sqlite.layerFromPath(path.join(dir, "state.sqlite"))));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists active threads from live rows without the shell snapshot", () =>
    run(({ threadIds, snapshotReads, targetedReads, shellReads }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* threadIds("/threads?active=true"), [
          "asks-waiting",
          "live-queued",
          "live-running",
        ]);
        assert.deepStrictEqual(
          yield* threadIds("/threads?active=true&includeSubagents=true&limit=500"),
          ["asks-waiting", "live-queued", "live-running", "live-subagent"],
        );
        assert.deepStrictEqual(yield* threadIds("/threads?active=true&archived=true"), [
          "asks-archived",
          "live-archived",
        ]);
        assert.deepStrictEqual(yield* threadIds("/threads?state=queued,needs-input"), [
          "asks-waiting",
          "live-queued",
        ]);
        assert.strictEqual(yield* Ref.get(snapshotReads), 0);
        // One bounded read per list (indexed IN list), never one shell transaction per thread.
        const targeted = yield* Ref.get(targetedReads);
        assert.strictEqual(targeted.length, 4);
        assert.ok(targeted.every((ids) => ids.length > 0 && ids.length <= 400));
        assert.strictEqual(yield* Ref.get(shellReads), 0);
      }),
    ),
  );

  it.effect("explicit and empty ids load only their requested shells", () =>
    run(({ threadIds, snapshotReads, targetedReads }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* threadIds("/threads?ids=quiet"), ["quiet"]);
        assert.deepStrictEqual(yield* threadIds("/threads?ids=quiet&active=true"), []);
        assert.deepStrictEqual(yield* threadIds("/threads?ids="), []);
        assert.deepStrictEqual(yield* threadIds("/threads?ids=missing"), []);
        assert.equal(yield* Ref.get(snapshotReads), 0);
        assert.deepStrictEqual(yield* Ref.get(targetedReads), [["quiet"], ["quiet"], ["missing"]]);
      }),
    ),
  );

  it.effect("loads only matching shells for lists that include idle threads", () =>
    run(({ threadIds, snapshotReads }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* threadIds("/threads?active=false"), [
          "live-settling",
          "quiet",
        ]);
        assert.deepStrictEqual(yield* threadIds("/threads?state=idle,running"), [
          "live-running",
          "live-settling",
          "migrated",
          "quiet",
        ]);
        assert.deepStrictEqual(yield* threadIds("/threads?archived=true&state=running"), [
          "live-archived",
        ]);
        assert.deepStrictEqual(yield* threadIds("/threads?archived=true&state=idle,running"), [
          "live-archived",
        ]);
        assert.strictEqual(yield* Ref.get(snapshotReads), 0);
      }),
    ),
  );

  it.live(
    "pages default listings with the full listing's fields, filters and total",
    () => {
      const extra = Array.from({ length: 2_500 }, (_, index) =>
        shell(`page-${String(index).padStart(4, "0")}`, {
          ...idle,
          updatedAt: DateTime.makeUnsafe(1_800_000_000_000 + Math.floor(index / 2) * 1_000),
          ...(index % 7 === 0 ? { creationSource: "mobile" as const } : {}),
          ...(index % 11 === 0 ? { projectId: ProjectId.make("other") } : {}),
          ...(index % 13 === 0 ? { archivedAt: askedAt } : {}),
          ...(index % 17 === 0 ? { deletedAt: askedAt } : {}),
          ...(index % 19 === 0
            ? {
                lineage: {
                  rootThreadId: ThreadId.make("quiet"),
                  parentThreadId: ThreadId.make("quiet"),
                  relationshipToParent: "subagent" as const,
                },
              }
            : {}),
        }),
      );
      return Effect.scoped(
        Effect.gen(function* () {
          const { get, snapshotReads, targetedReads, sql } = yield* makeHarness(
            undefined,
            extra,
            new Set(),
            [],
            true,
          );
          yield* sql`INSERT INTO ardud_thread_origin (thread_id, origin, created_at)
          VALUES ('quiet', 'imessage', '2026-01-01T00:00:00.000Z'),
                 ('page-2498', 'telegram', '2026-01-01T00:00:00.000Z')`;
          // Selecting every fixture id supplies an independent reference for candidate paging.
          // Both paths use the real projection store against the same seeded database.
          const ids = [...shells, ...extra].map((row) => row.id).join(",");
          for (const query of [
            "",
            "limit=1",
            "limit=2",
            "limit=0",
            "limit=9000",
            "limit=invalid",
            "archived=true&limit=1",
            "includeSubagents=true&limit=2",
            "creationSource=mobile,provider&includeSubagents=true&limit=1",
            "creationSource=",
            "projectId=other&limit=1",
            "projectId=missing",
            "origin=none&limit=1",
            "origin=imessage&includeSubagents=true&limit=2",
            "origin=telegram&limit=1",
            "origin=missing",
            "origin=",
          ]) {
            const beforeStart = yield* Clock.currentTimeMillis;
            const previous = yield* get(`/threads?ids=${ids}&${query}`);
            const beforeMs = (yield* Clock.currentTimeMillis) - beforeStart;
            assert.strictEqual(previous.status, 200);
            yield* Ref.set(snapshotReads, 0);
            yield* Ref.set(targetedReads, []);
            const afterStart = yield* Clock.currentTimeMillis;
            const current = yield* get(`/threads?${query}`);
            const afterMs = (yield* Clock.currentTimeMillis) - afterStart;
            assert.strictEqual(current.status, 200);
            assert.deepStrictEqual(current.body, previous.body, query);
            assert.strictEqual(yield* Ref.get(snapshotReads), 0, query);
            const pages = yield* Ref.get(targetedReads);
            assert.strictEqual(
              pages.flat().length,
              (current.body.threads as ReadonlyArray<unknown>).length,
              `only the returned shells are built: ${query}`,
            );
            if (query === "" || query === "limit=1") {
              yield* Effect.logInfo("control listing seeded parity", {
                query,
                seededThreads: shells.length + extra.length,
                beforeMs,
                afterMs,
                total: current.body.total,
                builtShells: pages.flat().length,
              });
            }
          }
        }),
      ).pipe(Effect.provide(Sqlite.layerMemory));
    },
    { timeout: 60_000 },
  );

  it.effect("filters /threads by creationSource, with includeSubagents and updatedSince", () => {
    // A provider-native child (idle, subagent lineage) and an app thread. Their updatedAt values differ so
    // updatedSince actually splits them.
    const nativeChild = shell("native-child", {
      creationSource: "provider",
      createdBy: "agent",
      updatedAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      lineage: {
        rootThreadId: ThreadId.make("live-running"),
        parentThreadId: ThreadId.make("live-running"),
        relationshipToParent: "subagent",
      },
      ...idle,
    });
    // Not web: every harness shell defaults to web, so a mobile match is this thread alone.
    const appThread = shell("app-thread", {
      creationSource: "mobile",
      updatedAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      ...idle,
    });
    const oldNative = shell("old-native-child", {
      creationSource: "provider",
      createdBy: "agent",
      updatedAt: DateTime.makeUnsafe("2025-12-01T00:00:00.000Z"),
      lineage: {
        rootThreadId: ThreadId.make("live-running"),
        parentThreadId: ThreadId.make("live-running"),
        relationshipToParent: "subagent",
      },
      ...idle,
    });
    return run(
      ({ threadIds }) =>
        Effect.gen(function* () {
          // Only the provider-native children, whatever the lineage.
          assert.deepStrictEqual(
            yield* threadIds("/threads?creationSource=provider&includeSubagents=true&limit=500"),
            ["native-child", "old-native-child"],
          );
          // Exact match on the one non-web thread.
          assert.deepStrictEqual(
            yield* threadIds("/threads?creationSource=mobile&includeSubagents=true&limit=500"),
            ["app-thread"],
          );
          // A comma list matches any of its values.
          assert.deepStrictEqual(
            yield* threadIds(
              "/threads?creationSource=mobile,provider&includeSubagents=true&limit=500",
            ),
            ["app-thread", "native-child", "old-native-child"],
          );
          // updatedSince narrows the same filter: the 2025 child drops out, the 2026 child stays.
          assert.deepStrictEqual(
            yield* threadIds(
              `/threads?creationSource=provider&includeSubagents=true&updatedSince=${Date.parse("2025-12-31T00:00:00.000Z")}&limit=500`,
            ),
            ["native-child"],
          );
          // Without includeSubagents the child is hidden even when it matches creationSource.
          assert.deepStrictEqual(
            yield* threadIds("/threads?creationSource=provider&limit=500"),
            [],
          );
          // The active=true fast path is untouched: an idle child is not active.
          assert.deepStrictEqual(
            yield* threadIds("/threads?active=true&includeSubagents=true&limit=500"),
            ["asks-waiting", "live-queued", "live-running", "live-subagent"],
          );
        }),
      undefined,
      [nativeChild, appThread, oldNative],
    );
  });

  it.effect("lists /threads?updatedSince from the changed rows, never the shell snapshot", () => {
    const at = (iso: string) => DateTime.makeUnsafe(iso);
    const changed = (
      id: string,
      iso: string,
      overrides: Partial<OrchestrationV2ThreadShell> = {},
    ) =>
      shell(id, {
        ...idle,
        updatedAt: at(iso),
        lineage: {
          rootThreadId: ThreadId.make(id),
          parentThreadId: null,
          relationshipToParent: null,
        },
        ...overrides,
      });
    const extra = [
      changed("new-1", "2026-03-01T00:00:03.000Z"),
      changed("new-2", "2026-03-01T00:00:02.000Z", { projectId: "other" as never }),
      changed("new-3", "2026-03-01T00:00:01.000Z"),
      // Exactly at the cut: updatedSince is exclusive.
      changed("edge", "2026-03-01T00:00:00.000Z"),
      changed("stale", "2026-02-01T00:00:00.000Z"),
      changed("new-archived", "2026-03-01T00:00:04.000Z", {
        archivedAt: at("2026-03-01T00:00:04.000Z"),
      }),
      changed("new-deleted", "2026-03-01T00:00:04.000Z", {
        deletedAt: at("2026-03-01T00:00:04.000Z"),
      }),
      changed("new-child", "2026-03-01T00:00:05.000Z", {
        creationSource: "provider",
        lineage: {
          rootThreadId: ThreadId.make("new-3"),
          parentThreadId: ThreadId.make("new-3"),
          relationshipToParent: "subagent",
        },
      }),
    ];
    const since = Date.parse("2026-03-01T00:00:00.000Z");
    return run(
      ({ get, snapshotReads, sql }) =>
        Effect.gen(function* () {
          const list = (query: string) =>
            get(`/threads?updatedSince=${since}${query}`).pipe(
              Effect.map((response) => {
                assert.strictEqual(response.status, 200);
                return {
                  total: response.body.total as number,
                  ids: (response.body.threads as ReadonlyArray<{ threadId: string }>).map(
                    (thread) => thread.threadId,
                  ),
                };
              }),
            );
          // Newest first, cut to the limit, total still counts every match.
          assert.deepStrictEqual(yield* list("&limit=2"), { total: 3, ids: ["new-1", "new-2"] });
          assert.deepStrictEqual(yield* list("&limit=50"), {
            total: 3,
            ids: ["new-1", "new-2", "new-3"],
          });
          // ISO form of the same instant.
          assert.deepStrictEqual(
            (yield* get("/threads?updatedSince=2026-03-01T00:00:00.000Z&limit=50")).body.total,
            3,
          );
          assert.deepStrictEqual(yield* list("&includeSubagents=true&limit=2"), {
            total: 4,
            ids: ["new-child", "new-1"],
          });
          assert.deepStrictEqual(yield* list("&creationSource=provider&includeSubagents=true"), {
            total: 1,
            ids: ["new-child"],
          });
          assert.deepStrictEqual(yield* list("&parentThreadId=new-3"), {
            total: 1,
            ids: ["new-child"],
          });
          assert.deepStrictEqual(yield* list("&projectId=other"), { total: 1, ids: ["new-2"] });
          assert.deepStrictEqual(yield* list("&archived=true"), {
            total: 1,
            ids: ["new-archived"],
          });
          // A state filter that can match idle threads reads the changed range's shells.
          assert.deepStrictEqual(yield* list("&state=idle&limit=1"), { total: 3, ids: ["new-1"] });
          assert.deepStrictEqual(yield* list("&active=false&includeSubagents=true"), {
            total: 4,
            ids: ["new-child", "new-1", "new-2", "new-3"],
          });
          // Origins: a child inherits its root's origin.
          yield* sql`INSERT INTO ardud_thread_origin (thread_id, origin, created_at) VALUES ('new-3', 'imessage', '2026-03-01T00:00:00.000Z')`;
          assert.deepStrictEqual(yield* list("&origin=imessage&includeSubagents=true"), {
            total: 2,
            ids: ["new-child", "new-3"],
          });
          assert.deepStrictEqual(yield* list("&origin=none&limit=1"), { total: 2, ids: ["new-1"] });
          assert.strictEqual(yield* Ref.get(snapshotReads), 0);
        }),
      undefined,
      extra,
    );
  });

  it.effect("candidate pages preserve totals and limits across state and origin filters", () => {
    const extra = Array.from({ length: 270 }, (_, i) =>
      shell(`batch-${String(i).padStart(3, "0")}`, {
        ...(i % 2 === 0 ? idle : {}),
        updatedAt: DateTime.makeUnsafe("2026-03-01T00:00:00.000Z"),
      }),
    );
    return run(
      ({ get, sql }) =>
        Effect.gen(function* () {
          for (let i = 0; i < extra.length; i += 3) {
            yield* sql`INSERT INTO ardud_thread_origin (thread_id, origin, created_at)
          VALUES (${extra[i]!.id}, 'imessage', '2026-03-01T00:00:00.000Z')`;
          }
          const cases = [
            { suffix: "&limit=200", total: 270, length: 200, first: ["batch-000", "batch-001"] },
            {
              suffix: "&state=idle&limit=2",
              total: 135,
              length: 2,
              first: ["batch-000", "batch-002"],
            },
            {
              suffix: "&origin=imessage&limit=2",
              total: 90,
              length: 2,
              first: ["batch-000", "batch-003"],
            },
            {
              suffix: "&state=idle&origin=imessage&limit=2",
              total: 45,
              length: 2,
              first: ["batch-000", "batch-006"],
            },
          ];
          for (const row of cases) {
            const response = yield* get(
              `/threads?updatedSince=2026-02-01T00:00:00.000Z${row.suffix}`,
            );
            assert.equal(response.status, 200);
            assert.equal(response.body.total, row.total, row.suffix);
            const ids = (response.body.threads as ReadonlyArray<{ threadId: string }>).map(
              (thread) => thread.threadId,
            );
            assert.lengthOf(ids, row.length);
            assert.equal(new Set(ids).size, row.length);
            assert.deepEqual(ids.slice(0, 2), row.first);
          }
        }),
      undefined,
      extra,
    );
  });

  it.effect("lists /threads?parentThreadId children without the shell snapshot", () => {
    const at = (iso: string) => DateTime.makeUnsafe(iso);
    const child = (id: string, iso: string, parent: string, overrides = {}) =>
      shell(id, {
        ...idle,
        updatedAt: at(iso),
        creationSource: "provider",
        lineage: {
          rootThreadId: ThreadId.make(parent),
          parentThreadId: ThreadId.make(parent),
          relationshipToParent: "subagent",
        },
        ...overrides,
      });
    const extra = [
      child("child-new", "2026-03-01T00:00:02.000Z", "parent-a"),
      // Old children are listed too: there is no updatedSince cut.
      child("child-old", "2020-01-01T00:00:00.000Z", "parent-a"),
      child("child-other", "2026-03-01T00:00:03.000Z", "parent-b"),
      // No updatedSince means no time filter at all, including the epoch and before it.
      child("child-epoch", "1970-01-01T00:00:00.000Z", "parent-a"),
      child("child-pre-epoch", "1969-12-31T23:59:59.000Z", "parent-a"),
      child("child-archived", "2026-03-01T00:00:04.000Z", "parent-a", {
        archivedAt: at("2026-03-01T00:00:04.000Z"),
      }),
      child("child-deleted", "2026-03-01T00:00:05.000Z", "parent-a", {
        deletedAt: at("2026-03-01T00:00:05.000Z"),
      }),
    ];
    return run(
      ({ get, snapshotReads }) =>
        Effect.gen(function* () {
          const list = (query: string) =>
            get(`/threads?parentThreadId=parent-a${query}`).pipe(
              Effect.map((response) => {
                assert.strictEqual(response.status, 200);
                return {
                  total: response.body.total as number,
                  ids: (response.body.threads as ReadonlyArray<{ threadId: string }>).map(
                    (thread) => thread.threadId,
                  ),
                };
              }),
            );
          // The agent-tooling shape seen on 11 Nov 2026: newest first, every live child.
          assert.deepStrictEqual(yield* list("&includeSubagents=true&limit=500"), {
            total: 4,
            ids: ["child-new", "child-old", "child-epoch", "child-pre-epoch"],
          });
          assert.deepStrictEqual(yield* list("&limit=1"), { total: 4, ids: ["child-new"] });
          assert.deepStrictEqual(yield* list("&archived=true"), {
            total: 1,
            ids: ["child-archived"],
          });
          assert.deepStrictEqual(yield* list("&active=false"), {
            total: 4,
            ids: ["child-new", "child-old", "child-epoch", "child-pre-epoch"],
          });
          // An explicit updatedSince still cuts exactly, at the epoch too.
          assert.deepStrictEqual(yield* list("&updatedSince=0"), {
            total: 2,
            ids: ["child-new", "child-old"],
          });
          assert.strictEqual(yield* Ref.get(snapshotReads), 0);
        }),
      undefined,
      extra,
    );
  });

  it.effect(
    "orders /threads?updatedSince ties by thread id and refills vanished candidates",
    () => {
      const at = DateTime.makeUnsafe("2026-03-01T00:00:01.000Z");
      const tied = (id: string) =>
        shell(id, {
          ...idle,
          updatedAt: at,
          lineage: {
            rootThreadId: ThreadId.make(id),
            parentThreadId: null,
            relationshipToParent: null,
          },
        });
      const since = Date.parse("2026-03-01T00:00:00.000Z");
      return run(
        ({ get }) =>
          Effect.gen(function* () {
            const page = (limit: number, suffix = "") =>
              get(`/threads?updatedSince=${since}&limit=${limit}${suffix}`).pipe(
                Effect.map((response) => ({
                  total: response.body.total as number,
                  ids: (response.body.threads as ReadonlyArray<{ threadId: string }>).map(
                    (thread) => thread.threadId,
                  ),
                })),
              );
            // Equal timestamps keep the full listing's thread id order; tie-a vanished after
            // the range read, so tie-b fills its place and total drops it.
            assert.deepStrictEqual(yield* page(1), { total: 2, ids: ["tie-b"] });
            assert.deepStrictEqual(yield* page(5), { total: 2, ids: ["tie-b", "tie-c"] });
            assert.deepStrictEqual(yield* page(1, "&origin=none"), { total: 2, ids: ["tie-b"] });
            assert.deepStrictEqual(yield* page(5, "&origin=none"), {
              total: 2,
              ids: ["tie-b", "tie-c"],
            });
          }),
        undefined,
        [tied("tie-c"), tied("tie-a"), tied("tie-b")],
        new Set(["tie-a"]),
      );
    },
  );

  const staleAt = DateTime.makeUnsafe("2026-03-01T00:00:01.000Z");
  const staleSince = Date.parse("2026-03-01T00:00:00.000Z");
  const unavailableCandidates: ReadonlyArray<{
    name: string;
    changed: Partial<OrchestrationV2ThreadShell>;
    query: string;
  }> = [
    { name: "missing", changed: {}, query: "" },
    { name: "archived", changed: { archivedAt: staleAt }, query: "" },
    { name: "deleted", changed: { deletedAt: staleAt }, query: "" },
    {
      name: "older date",
      changed: { updatedAt: DateTime.subtract(staleAt, { seconds: 2 }) },
      query: "",
    },
    {
      name: "other project",
      changed: { projectId: ProjectId.make("moved") },
      query: "&projectId=project:mcp-test",
    },
    { name: "other source", changed: { creationSource: "provider" }, query: "&creationSource=web" },
    {
      name: "other parent",
      changed: {
        lineage: {
          rootThreadId: ThreadId.make("tie-a"),
          parentThreadId: ThreadId.make("moved"),
          relationshipToParent: null,
        },
      },
      query: "&parentThreadId=original-parent",
    },
    {
      name: "subagent",
      changed: {
        lineage: {
          rootThreadId: ThreadId.make("tie-a"),
          parentThreadId: ThreadId.make("original-parent"),
          relationshipToParent: "subagent",
        },
      },
      query: "",
    },
  ];
  it.effect.each(
    unavailableCandidates.flatMap((row) =>
      (["none", "direct", "inherited"] as const).map((origin) => ({ row, origin })),
    ),
  )("refills $origin origin results after a candidate is $row.name", ({ row, origin }) => {
        const candidates = ["tie-a", "tie-b", "tie-c"].map((id) => {
          const candidate = shell(id, {
            ...idle,
            updatedAt: staleAt,
            lineage: {
              rootThreadId: ThreadId.make(id),
              parentThreadId: ThreadId.make("original-parent"),
              relationshipToParent: null,
            },
            ...(id === "tie-a" ? row.changed : {}),
          });
          return origin === "inherited"
            ? {
                ...candidate,
                lineage: { ...candidate.lineage, rootThreadId: ThreadId.make("origin-root") },
              }
            : candidate;
        });
        return run(
          ({ get, sql }) =>
            Effect.gen(function* () {
              // Candidate metadata is the earlier version; the shell read observes the change.
              yield* sql`UPDATE orchestration_v2_projection_threads
            SET deleted_at = NULL, project_id = 'project:mcp-test', updated_at = ${DateTime.formatIso(staleAt)},
              payload_json = json_set(payload_json, '$.archivedAt', NULL,
                '$.lineage.relationshipToParent', NULL, '$.lineage.parentThreadId', 'original-parent', '$.creationSource', 'web')
            WHERE thread_id = 'tie-a'`;
              if (origin !== "none") {
                for (const id of origin === "inherited"
                  ? ["origin-root"]
                  : ["tie-a", "tie-b", "tie-c"]) {
                  yield* sql`INSERT INTO ardud_thread_origin (thread_id, origin, created_at)
                VALUES (${id}, 'imessage', '2026-03-01T00:00:00.000Z')`;
                }
              }
              for (const limit of [1, 2, 5]) {
                const response = yield* get(
                  `/threads?updatedSince=${staleSince}&origin=${origin === "none" ? "none" : "imessage"}&limit=${limit}${row.query}`,
                );
                assert.equal(response.status, 200);
                assert.equal(response.body.total, 2);
                assert.deepEqual(
                  (response.body.threads as ReadonlyArray<{ threadId: string }>).map(
                    (thread) => thread.threadId,
                  ),
                  ["tie-b", "tie-c"].slice(0, limit),
                );
              }
            }),
          undefined,
          candidates,
          row.name === "missing" ? new Set(["tie-a"]) : new Set(),
        );
      });

  it.effect("refills across a whole unavailable origin-filtered candidate page", () => {
    const ids = Array.from({ length: 130 }, (_, i) => `refill-${String(i).padStart(3, "0")}`);
    const candidates = ids.map((id) => shell(id, { ...idle, updatedAt: staleAt }));
    return run(
      ({ get }) =>
        Effect.gen(function* () {
          for (const limit of [1, 2]) {
            const response = yield* get(
              `/threads?updatedSince=${staleSince}&origin=none&limit=${limit}`,
            );
            assert.equal(response.status, 200);
            assert.equal(response.body.total, 2);
            assert.deepEqual(
              (response.body.threads as ReadonlyArray<{ threadId: string }>).map(
                (thread) => thread.threadId,
              ),
              ids.slice(128, 128 + limit),
            );
          }
        }),
      undefined,
      candidates,
      new Set(ids.slice(0, 128)),
    );
  });

  it.effect("orders /threads?updatedSince ties by thread id like the full listing", () => {
    const at = DateTime.makeUnsafe("2026-03-01T00:00:01.000Z");
    const tied = (id: string) =>
      shell(id, {
        ...idle,
        updatedAt: at,
        lineage: {
          rootThreadId: ThreadId.make(id),
          parentThreadId: null,
          relationshipToParent: null,
        },
      });
    const since = Date.parse("2026-03-01T00:00:00.000Z");
    return run(
      ({ get }) =>
        Effect.gen(function* () {
          const response = yield* get(`/threads?updatedSince=${since}&limit=2`);
          assert.deepStrictEqual(
            (response.body.threads as ReadonlyArray<{ threadId: string }>).map(
              (thread) => thread.threadId,
            ),
            ["tie-a", "tie-b"],
          );
          assert.strictEqual(response.body.total, 3);
        }),
      undefined,
      [tied("tie-c"), tied("tie-a"), tied("tie-b")],
    );
  });

  it.effect("lists pending requests from pending rows without the shell snapshot", () =>
    run(({ get, snapshotReads }) =>
      Effect.gen(function* () {
        const response = yield* get("/requests");
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(
          (response.body.requests as ReadonlyArray<Record<string, unknown>>).map((request) => ({
            threadId: request.threadId,
            requestId: request.requestId,
            kind: request.kind,
          })),
          [{ threadId: "asks-waiting", requestId: "request-waiting", kind: "question" }],
        );
        assert.strictEqual(yield* Ref.get(snapshotReads), 0);
      }),
    ),
  );

  it.effect(
    "keeps pending request details, order and inherited origin without reading history",
    () =>
      run(
        ({ get, sql, recordReads }) =>
          Effect.gen(function* () {
            const at = "2026-01-01T00:01:00.000Z";
            for (const [threadId, id, kind, status] of [
              ["asks-second", "approval", "command", "pending"],
              ["asks-second", "question", "user_input", "pending"],
              ["asks-child", "child", "user_input", "pending"],
              ["asks-second", "answered", "user_input", "resolved"],
              ["asks-deleted", "deleted", "user_input", "pending"],
              ["asks-vanished", "vanished", "user_input", "pending"],
              ["quiet", "stale", "user_input", "pending"],
            ]) {
              yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests ${sql.insert({
                runtime_request_id: id,
                thread_id: threadId,
                node_id: `node:${id}`,
                provider_turn_id: null,
                kind,
                status,
                created_at: at,
                resolved_at: null,
                payload_json: JSON.stringify({
                  id,
                  nodeId: `node:${id}`,
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind,
                  status,
                  createdAt: at,
                  resolvedAt: null,
                  responseCapability: { type: "message" },
                }),
              })}`;
            }
            yield* sql`INSERT INTO ardud_thread_origin VALUES ('asks-second', 'imessage', ${at})`;
            for (const [threadId, requestId, type, ordinal, title] of [
              ["asks-second", "approval", "approval_request", 4, "Allow command"],
              ["asks-second", "approval", "approval_request", 8, "Later duplicate"],
              ["asks-second", "question", "user_input_request", 5, "Choose"],
              ["asks-second", "answered", "user_input_request", 1, "Answered"],
            ] as const) {
              const id = `item:${requestId}:${ordinal}`;
              yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
                turn_item_id: id,
                thread_id: threadId,
                node_id: `node:${requestId}`,
                ordinal,
                type,
                status: "pending",
                updated_at: at,
                payload_json: JSON.stringify({
                  id,
                  threadId,
                  nodeId: `node:${requestId}`,
                  runId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal,
                  type,
                  status: "pending",
                  title,
                  startedAt: null,
                  completedAt: null,
                  updatedAt: at,
                  requestId,
                  ...(type === "approval_request"
                    ? { requestKind: "command", prompt: "pwd" }
                    : { questions: [] }),
                }),
              })}`;
            }
            // Pending details can still be in the cold store after an offline split.
            yield* sql`INSERT INTO ardud_archive.ardud_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id,
         provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json)
        SELECT turn_item_id, thread_id, run_id, node_id, provider_thread_id,
          provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'item:question:5'`;
            yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'item:question:5'`;
            const early = { status: "pending", createdAt: at, canRespond: true };
            const named = [
              {
                threadId: "asks-child",
                title: "asks-child",
                origin: "imessage",
                rootThreadId: "asks-second",
                requestId: "child",
                kind: "question",
                requestKind: "user_input",
                ...early,
              },
              {
                threadId: "asks-second",
                title: "Allow command",
                origin: "imessage",
                rootThreadId: "asks-second",
                requestId: "approval",
                kind: "approval",
                requestKind: "command",
                ...early,
                prompt: "pwd",
                options: null,
              },
              {
                threadId: "asks-second",
                title: "Choose",
                origin: "imessage",
                rootThreadId: "asks-second",
                requestId: "question",
                kind: "question",
                requestKind: "user_input",
                ...early,
                questions: [],
              },
            ];
            const none = [
              {
                threadId: "asks-waiting",
                title: "asks-waiting",
                origin: null,
                rootThreadId: "asks-waiting",
                requestId: "request-waiting",
                kind: "question",
                requestKind: "user_input",
                status: "pending",
                createdAt: "2026-01-01T00:05:00.000Z",
                canRespond: true,
              },
            ];
            for (const [suffix, expected] of [
              ["", [...named, ...none]],
              ["?origin=none", none],
              ["?origin=imessage", named],
              ["?origin=watcher", []],
            ] as const) {
              const response = yield* get(`/requests${suffix}`);
              assert.equal(response.status, 200);
              assert.deepEqual(response.body, { ok: true, requests: expected });
            }
            assert.equal(yield* Ref.get(recordReads), 0);
          }),
        undefined,
        [
          shell("asks-second", { ...idle, ...waiting("approval") }),
          shell("asks-child", {
            ...idle,
            ...waiting("child"),
            lineage: {
              parentThreadId: ThreadId.make("asks-second"),
              rootThreadId: ThreadId.make("asks-second"),
              relationshipToParent: "subagent",
            },
          }),
          shell("asks-deleted", { ...idle, ...waiting("deleted"), deletedAt: askedAt }),
        ],
      ),
  );

  it.effect("lists a migrated thread under its current native id, not the old ses_", () =>
    run(({ get }) =>
      Effect.gen(function* () {
        const response = yield* get("/threads/migrated");
        assert.strictEqual(response.status, 200);
        const thread = response.body.thread as Record<string, unknown>;
        assert.strictEqual(thread.nativeSessionId, "claude-session-uuid");
        assert.deepStrictEqual(thread.native, {
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          nativeId: "claude-session-uuid",
        });
      }),
    ),
  );

  it.effect("resolves a native id through /identity/resolve", () =>
    run(({ get }) =>
      Effect.gen(function* () {
        const response = yield* get(
          "/identity/resolve?nativeId=claude-session-uuid&driver=claudeAgent",
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.ok, true);
        assert.strictEqual(response.body.identity.resolution, "resolved");
        assert.strictEqual(response.body.identity.robobThreadId, "migrated");
        assert.strictEqual(response.body.identity.executionKind, "top-level");
        assert.strictEqual(response.body.identity.driver, "claudeAgent");
      }),
    ),
  );

  it.live("authenticates and resolves identity while a shell snapshot holds the reader", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-control-identity-reader-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const harness = yield* makeHarness();
        const url = "/identity/resolve?nativeId=claude-session-uuid&driver=claudeAgent";
        assert.strictEqual((yield* harness.get(url)).status, 200);
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const reader = yield* Effect.forkChild(
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT 1`;
                yield* Deferred.succeed(held, undefined);
                yield* Deferred.await(release);
              }),
            )
            .pipe(NodeSqliteClient.readOnly),
        );
        yield* Deferred.await(held);
        const response = yield* harness
          .get(url)
          .pipe(Effect.timeout("2 seconds"), Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(reader);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.identity.resolution, "resolved");
        assert.strictEqual(response.body.identity.robobThreadId, "migrated");
      }).pipe(Effect.provide(Sqlite.layerFromPath(path.join(dir, "state.sqlite"))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // A lane that never ran the session read (process replaced, admission queue full).
  const laneUnavailable = () =>
    new SqlError({
      reason: classifySqliteError(new Error("Reader lane unavailable"), {
        operation: "readerAdmission",
        message: "Reader lane unavailable",
      }),
    });
  // A started read whose reader process stopped under it.
  const laneStopped = () =>
    new Error("Session verification failed", {
      cause: new Error("Database reader exited with code null"),
    });

  it.effect("retries a session read the auth lane never ran, once", () =>
    run(
      ({ get }) =>
        Effect.gen(function* () {
          const response = yield* get(
            "/identity/resolve?nativeId=claude-session-uuid&driver=claudeAgent",
          );
          assert.strictEqual(response.status, 200);
          assert.strictEqual(response.body.identity.robobThreadId, "migrated");
        }),
      undefined,
      [],
      new Set(),
      [laneUnavailable()],
    ),
  );

  it.effect("answers a busy reader lane with 503 and Retry-After, not 500", () =>
    run(
      ({ get }) =>
        Effect.gen(function* () {
          for (const path of [
            "/identity/resolve?nativeId=claude-session-uuid&driver=claudeAgent",
            "/identity/resolve?nativeId=claude-session-uuid&driver=claudeAgent",
            "/threads/migrated",
          ]) {
            const response = yield* get(path);
            assert.strictEqual(response.status, 503);
            assert.strictEqual(response.retryAfter, "1");
            assert.strictEqual(response.body.error.code, "unavailable");
          }
          // A started read is not replayed: one failure, one 503.
          assert.strictEqual((yield* get("/threads/migrated")).status, 200);
        }),
      undefined,
      [],
      new Set(),
      // Two retryable failures in a row exhaust the single retry.
      [laneUnavailable(), laneUnavailable(), laneStopped(), laneStopped()],
    ),
  );

  it.effect("keeps a non-lane authentication failure an internal error", () =>
    run(
      ({ get }) =>
        Effect.gen(function* () {
          const response = yield* get("/threads/migrated");
          assert.strictEqual(response.status, 500);
          assert.isNull(response.retryAfter);
        }),
      undefined,
      [],
      new Set(),
      [new Error("disk full")],
    ),
  );
});
