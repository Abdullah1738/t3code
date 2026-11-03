/**
 * `/threads?active=true` and `/requests` start from the live and pending ids
 * in the projection tables instead of the whole shell snapshot, and still
 * apply the exact shell filters.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CONTROL_ROUTE_PREFIX, controlRouteLayer } from "./http.ts";

const askedAt = DateTime.makeUnsafe("2026-01-01T00:05:00.000Z");

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
        payload_json: "{}",
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
const snapshotFor = (location: "active" | "archive", extra: ReadonlyArray<OrchestrationV2ThreadShell>) => {
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

const makeHarness = (buildCommit?: string, extraShells: ReadonlyArray<OrchestrationV2ThreadShell> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* ProjectStore.make;
    yield* seedRows;
    const snapshotReads = yield* Ref.make(0);
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-control-listings" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getShellSnapshot: (options) =>
        Ref.update(snapshotReads, (count) => count + 1).pipe(
          Effect.as(snapshotFor(options?.location ?? "active", extraShells)),
        ),
      getThreadShell: (threadId) =>
        Effect.succeed(
          [...shells, ...extraShells].find((candidate) => candidate.id === threadId) ?? null,
        ),
      getThreadRecords: (threadId) => Effect.succeed(projectionFor(threadId)),
    });
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          controlRouteLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                  authenticateHttpRequest: () =>
                    Effect.succeed({
                      sessionId: AuthSessionId.make("session-cli"),
                      subject: "cli-issued-session",
                      method: "bearer-access-token" as const,
                      scopes: ["orchestration:read", "orchestration:operate"],
                    }),
                }),
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
        return { status: response.status, body: (await response.json()) as Record<string, any> };
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
    return { get, threadIds, snapshotReads };
  });

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

// `buildCommit` is main's startup-commit fixture; `extraShells` adds threads to the snapshot for one test.
const run = <A, E>(
  body: (h: Harness) => Effect.Effect<A, E>,
  buildCommit?: string,
  extraShells: ReadonlyArray<OrchestrationV2ThreadShell> = [],
) =>
  Effect.scoped(Effect.flatMap(makeHarness(buildCommit, extraShells), body)).pipe(
    Effect.provide(Sqlite.layerMemory),
  );

describe("control listings", () => {
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
  it.live("lists projects from the reader while the writer is held", () =>
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
        const response = yield* harness.get("/projects").pipe(
          Effect.timeout("5 seconds"),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
        yield* Fiber.join(writer);
        assert.strictEqual(response.status, 200);
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
  it.effect("lists active threads from live rows without the shell snapshot", () =>
    run(({ threadIds, snapshotReads }) =>
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
      }),
    ),
  );

  it.effect("keeps the shell snapshot for lists that include idle threads", () =>
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
        assert.strictEqual(yield* Ref.get(snapshotReads), 3);
      }),
    ),
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
          assert.deepStrictEqual(yield* threadIds("/threads?creationSource=provider&includeSubagents=true&limit=500"), [
            "native-child",
            "old-native-child",
          ]);
          // Exact match on the one non-web thread.
          assert.deepStrictEqual(yield* threadIds("/threads?creationSource=mobile&includeSubagents=true&limit=500"), [
            "app-thread",
          ]);
          // A comma list matches any of its values.
          assert.deepStrictEqual(yield* threadIds("/threads?creationSource=mobile,provider&includeSubagents=true&limit=500"), [
            "app-thread",
            "native-child",
            "old-native-child",
          ]);
          // updatedSince narrows the same filter: the 2025 child drops out, the 2026 child stays.
          assert.deepStrictEqual(
            yield* threadIds(
              `/threads?creationSource=provider&includeSubagents=true&updatedSince=${Date.parse("2025-12-31T00:00:00.000Z")}&limit=500`,
            ),
            ["native-child"],
          );
          // Without includeSubagents the child is hidden even when it matches creationSource.
          assert.deepStrictEqual(yield* threadIds("/threads?creationSource=provider&limit=500"), []);
          // The active=true fast path is untouched: an idle child is not active.
          assert.deepStrictEqual(yield* threadIds("/threads?active=true&includeSubagents=true&limit=500"), [
            "asks-waiting",
            "live-queued",
            "live-running",
            "live-subagent",
          ]);
        }),
      undefined,
      [nativeChild, appThread, oldNative],
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
});
