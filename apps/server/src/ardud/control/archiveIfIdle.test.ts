/**
 * `POST /threads/:id/archive-if-idle` hands the idle check to the
 * orchestrator and reports a refusal as a 409 with its reason.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
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
import { OrchestratorDispatchError } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { OrchestratorThreadNotIdleError } from "../archive-if-idle/idle.ts";
import { CONTROL_ROUTE_PREFIX, controlRouteLayer } from "./http.ts";

const makeHarness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const known = new Set([
    "thread-idle",
    "thread-busy",
    "thread-broken",
    "thread-deleting",
    "thread-rejected",
  ]);
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const startupFailed = yield* Ref.make(false);
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(known.has(threadId) ? liveThreadShell(threadId) : null),
    getThreadRecords: (threadId) =>
      Effect.succeed(
        idleThreadProjection(liveThreadShell(threadId)) as OrchestrationV2ThreadProjection,
      ),
    dispatch: (command) =>
      Effect.gen(function* () {
        yield* Ref.update(dispatched, (all) => [...all, command]);
        if (command.type !== "thread.archive") return { sequence: 1, storedEvents: [] };
        const rejected = (cause: unknown) =>
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          });
        switch (command.threadId) {
          case "thread-busy":
            return yield* new OrchestratorThreadNotIdleError({
              commandId: command.commandId,
              threadId: command.threadId,
              reason: "running",
              detail: "Thread thread-busy has a running run.",
            });
          case "thread-broken":
            return yield* rejected(new Error("disk I/O error"));
          case "thread-deleting":
            known.delete(command.threadId);
            return yield* rejected(`Thread ${command.threadId} is deleted.`);
          case "thread-rejected":
            return yield* rejected(`Thread ${command.threadId} is already archived.`);
        }
        return { sequence: 1, storedEvents: [] };
      }),
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
                enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
                  Effect.flatMap(
                    Ref.get(startupFailed),
                    (
                      failed,
                    ): Effect.Effect<A, E | ServerRuntimeStartup.ServerRuntimeStartupError> =>
                      failed
                        ? Effect.fail(
                            new ServerRuntimeStartup.ServerRuntimeStartupError({
                              mode: "web",
                              host: null,
                              port: 0,
                              cause: new Error("listen failed"),
                            }),
                          )
                        : effect,
                  ),
              }),
              Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ServerSecretStore.ServerSecretStore)({}),
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-control-archive-if-idle" }),
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
  const post = (threadId: string, body?: string) =>
    Effect.promise(async () => {
      const response = await web.handler(
        new Request(`http://env.local${CONTROL_ROUTE_PREFIX}/threads/${threadId}/archive-if-idle`, {
          method: "POST",
          headers: { authorization: "Bearer shared", "content-type": "application/json" },
          ...(body === undefined ? {} : { body }),
        }),
      );
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    });
  return { post, dispatched, startupFailed };
});

const run = <A, E>(body: (h: Effect.Success<typeof makeHarness>) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.flatMap(makeHarness, body)).pipe(Effect.provide(Sqlite.layerMemory));

describe("control archive-if-idle", () => {
  it.effect("archives an idle thread and passes the expected session through", () =>
    run(({ post, dispatched }) =>
      Effect.gen(function* () {
        const response = yield* post(
          "thread-idle",
          JSON.stringify({ expectedSession: "  ses_current  " }),
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.ok, true);
        assert.strictEqual(response.body.archived, true);
        assert.strictEqual(response.body.thread.threadId, "thread-idle");

        const bare = yield* post("thread-idle");
        assert.strictEqual(bare.status, 200);

        const commands = yield* Ref.get(dispatched);
        assert.deepStrictEqual(
          commands.map((command) =>
            command.type === "thread.archive"
              ? { type: command.type, threadId: command.threadId, ifIdle: command.ifIdle }
              : { type: command.type },
          ),
          [
            {
              type: "thread.archive",
              threadId: ThreadId.make("thread-idle"),
              ifIdle: { expectedNativeSessionId: "ses_current" },
            },
            { type: "thread.archive", threadId: ThreadId.make("thread-idle"), ifIdle: {} },
          ],
        );
        // Each call is its own command, so a refusal is never replayed.
        assert.notStrictEqual(commands[0]!.commandId, commands[1]!.commandId);
      }),
    ),
  );

  it.effect("answers a refusal with 409 and its reason", () =>
    run(({ post }) =>
      Effect.gen(function* () {
        const response = yield* post("thread-busy", JSON.stringify({}));
        assert.strictEqual(response.status, 409);
        assert.deepStrictEqual(response.body, {
          ok: false,
          archived: false,
          error: {
            code: "not_idle",
            reason: "running",
            message: "Thread thread-busy has a running run.",
          },
        });
      }),
    ),
  );

  it.effect("rejects unknown threads and bad bodies before dispatching", () =>
    run(({ post, dispatched }) =>
      Effect.gen(function* () {
        const missing = yield* post("thread-missing");
        assert.strictEqual(missing.status, 404);
        assert.strictEqual(missing.body.error.code, "not_found");

        const bad = yield* post("thread-idle", JSON.stringify({ expectedSession: 5 }));
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(bad.body.error.code, "invalid_request");

        assert.strictEqual((yield* Ref.get(dispatched)).length, 0);
      }),
    ),
  );

  // The reaper retries a conflict later, so a broken server must not look like one.
  it.effect("tells failures apart from conflicts", () =>
    run(({ post, dispatched, startupFailed }) =>
      Effect.gen(function* () {
        const broken = yield* post("thread-broken");
        assert.strictEqual(broken.status, 500);
        assert.strictEqual(broken.body.error.code, "internal");

        const deleted = yield* post("thread-deleting");
        assert.strictEqual(deleted.status, 404);
        assert.strictEqual(deleted.body.error.code, "not_found");

        const rejected = yield* post("thread-rejected");
        assert.strictEqual(rejected.status, 409);
        assert.strictEqual(rejected.body.error.code, "conflict");

        yield* Ref.set(startupFailed, true);
        const starting = yield* post("thread-idle");
        assert.strictEqual(starting.status, 503);
        assert.strictEqual(starting.body.error.code, "unavailable");

        assert.deepStrictEqual(
          (yield* Ref.get(dispatched)).map((command) =>
            command.type === "thread.archive" ? command.threadId : command.type,
          ),
          ["thread-broken", "thread-deleting", "thread-rejected"],
        );
      }),
    ),
  );
});
