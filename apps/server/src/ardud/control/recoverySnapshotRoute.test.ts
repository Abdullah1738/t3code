/**
 * GET /recovery/snapshot: the route's contract. Scope, the required `active`
 * parameter, the JSON shape and the cursor/limit pass-through. The paging and
 * probe rules are covered by ardud/recovery/RecoverySnapshot.test.ts.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
import * as ControlStore from "./ControlStore.ts";
import * as ExecutionIdentity from "../identity/ExecutionIdentity.ts";
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

const makeHarness = (scopes: ReadonlyArray<string>, liveIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const web = HttpRouter.toWebHandler(
      controlRouteLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            session(scopes),
            Layer.mock(ControlStore.ControlStore)({
              liveThreadIds: () => Effect.succeed(liveIds),
            }),
            Layer.mock(ExecutionIdentity.ExecutionIdentity)({
              currentNative: () => Effect.succeed(new Map()),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
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

  it.effect("returns the page shape with threads and nextCursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { get } = yield* makeHarness(["orchestration:read"], ["thread-a"]);
        const response = yield* get("/recovery/snapshot?active=true&limit=10");
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.ok, true);
        assert.deepStrictEqual(response.body.threads, []);
        assert.strictEqual(response.body.nextCursor, null);
      }),
    ).pipe(Effect.provide(Sqlite.layerMemory)),
  );
});
