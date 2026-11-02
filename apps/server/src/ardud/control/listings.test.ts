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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
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
const snapshotFor = (location: "active" | "archive") => {
  const read = shells.filter(
    (candidate) => (candidate.archivedAt !== null) === (location === "archive"),
  );
  return {
    schemaVersion: 1,
    snapshotSequence: 1,
    threads: read.filter((candidate) => candidate.archivedAt === null),
    archivedThreads: read.filter((candidate) => candidate.archivedAt !== null),
  };
};

const makeHarness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* seedRows;
  const snapshotReads = yield* Ref.make(0);
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getShellSnapshot: (options) =>
      Ref.update(snapshotReads, (count) => count + 1).pipe(
        Effect.as(snapshotFor(options?.location ?? "active")),
      ),
    getThreadShell: (threadId) =>
      Effect.succeed(shells.find((candidate) => candidate.id === threadId) ?? null),
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
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/tmp/named",
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              ServerSettings.layerTest(),
              Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
                enqueueCommand: (effect) => effect,
              }),
              Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ServerSecretStore.ServerSecretStore)({}),
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-control-listings" }),
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

const run = <A, E>(body: (h: Effect.Success<typeof makeHarness>) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.flatMap(makeHarness, body)).pipe(Effect.provide(Sqlite.layerMemory));

describe("control listings", () => {
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
