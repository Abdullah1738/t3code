/**
 * GET /recovery/snapshot: the route's contract. Scope, the required `active`
 * parameter, the JSON shape and the cursor/limit pass-through. The paging and
 * probe rules are covered by ardud/recovery/RecoverySnapshot.test.ts.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AuthSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { CONTROL_ROUTE_PREFIX, controlRouteLayer } from "./http.ts";

const session = (scopes: ReadonlyArray<string>) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("session-recovery-route"),
        subject: "recovery-route-test",
        method: "bearer-access-token" as const,
        scopes,
      } as never),
  });

const makeHarness = (scopes: ReadonlyArray<string>, activeIds: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const web = HttpRouter.toWebHandler(
      controlRouteLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            session(scopes),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              pageActiveThreadIds: () =>
                sql`SELECT 1`.pipe(NodeSqliteClient.readOnly, Effect.as(activeIds), Effect.orDie),
              getShellSnapshot: () =>
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 1,
                  threads: [],
                  archivedThreads: [],
                } as never),
              getThreadShell: () => Effect.succeed(null),
              getThreadRecords: () =>
                Effect.succeed({
                  runs: [],
                  providerThreads: [],
                  runtimeRequests: [],
                  subagents: [],
                } as never),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
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
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-control-recovery-route" }),
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
    return { get };
  });

describe("GET /recovery/snapshot", () => {
  it.live.each([true, false])(
    "reads the native binding while writer and background reader are held (active=%s)",
    (active) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "recovery-reader-" });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const threadId = ThreadId.make("thread-native-binding");
            const nativeId = "native-recovery-route";
            yield* sql`INSERT INTO orchestration_v2_projection_threads
            (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
             interaction_mode, active_provider_thread_id, created_at, updated_at, payload_json)
            VALUES (${threadId}, 'project', 'Recovery', 'codex', 'codex', 'full-access',
              'default', 'provider-native-binding', '2026-11-15', '2026-11-15', '{}')`;
            yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
            (provider_thread_id, thread_id, owner_node_id, provider, provider_session_id, status,
             first_run_ordinal, last_run_ordinal, updated_at, driver, provider_instance_id, payload_json)
            VALUES ('provider-native-binding', ${threadId}, NULL, 'codex', NULL, 'idle',
              1, 1, '2026-11-15', 'codex', 'codex',
              ${JSON.stringify({ nativeThreadRef: { nativeId } })})`;
            yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
            (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
            VALUES ('pending-native-binding', ${threadId}, 'node', 'user_input', 'pending',
              '2026-11-15', '{}')`;
            const { get } = yield* makeHarness(["orchestration:read"], [threadId]);
            const path = `/recovery/snapshot?active=${active}&limit=1`;
            // Build the HTTP layer before holding the writer; startup DDL needs it.
            const warmup = yield* get(path);
            assert.strictEqual(warmup.status, 200);
            assert.strictEqual(warmup.body.threads[0]?.nativeId, nativeId);
            const writerEntered = yield* Deferred.make<void>();
            const releaseWriter = yield* Deferred.make<void>();
            const writer = yield* sql
              .withTransaction(
                Deferred.succeed(writerEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseWriter)),
                ),
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(writerEntered);
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const holder = yield* sql
              .withTransaction(
                sql`SELECT 1`.pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Deferred.await(release)),
                ),
              )
              .pipe(NodeSqliteClient.readOnly, NodeSqliteClient.backgroundReads, Effect.forkChild);
            yield* Deferred.await(entered);
            const result = yield* get(path).pipe(
              Effect.timeout("5 seconds"),
              Effect.ensuring(Deferred.succeed(release, undefined)),
              Effect.ensuring(Deferred.succeed(releaseWriter, undefined)),
            );
            assert.strictEqual(result.status, 200);
            assert.strictEqual(result.body.threads.length, 1);
            assert.strictEqual(result.body.threads[0].threadId, threadId);
            assert.strictEqual(result.body.threads[0].nativeId, nativeId);
            assert.strictEqual(result.body.nextCursor, null);
            yield* Fiber.join(holder);
            yield* Fiber.join(writer);
          }).pipe(Effect.provide(Sqlite.layerFromPath(`${dir}/fixture.sqlite`)));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requires the read scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { get } = yield* makeHarness([], []);
        const response = yield* get("/recovery/snapshot?active=true");
        assert.strictEqual(response.status, 403);
        assert.strictEqual(response.body.ok, false);
      }),
    ).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect("rejects a request without the active parameter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { get } = yield* makeHarness(["orchestration:read"], []);
        const response = yield* get("/recovery/snapshot");
        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.ok, false);
        assert.strictEqual(response.body.error.code, "invalid_request");
      }),
    ).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect.each([true, false])(
    "returns the page shape with threads and nextCursor (active=%s)",
    (active) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { get } = yield* makeHarness(["orchestration:read"], []);
          const response = yield* get(`/recovery/snapshot?active=${active}&limit=10`);
          assert.strictEqual(response.status, 200);
          assert.strictEqual(response.body.ok, true);
          assert.deepStrictEqual(response.body.threads, []);
          assert.strictEqual(response.body.nextCursor, null);
        }),
      ).pipe(Effect.provide(Sqlite.layerMemory)),
  );
});
