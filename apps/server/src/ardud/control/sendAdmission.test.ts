import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as LegacyV1ThreadImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CONTROL_ROUTE_PREFIX, controlRouteLayer } from "./http.ts";

it.live.each(
  (["codex", "claudeAgent"] as const).flatMap((provider) =>
    (["queue", "auto"] as const).map((mode) => ({ provider, mode })),
  ),
)(
  "$provider $mode control send saves with background and queued startup work held",
  ({ provider, mode }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-send-admission-" });
      const database = Sqlite.layerFromPath(path.join(directory, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const instanceId = ProviderInstanceId.make(provider);
      const selection = { instanceId, model: "test-model" };
      const replay = ProviderReplayHarness.layerWithRegistry(
        { name: "control-send-admission" },
        ProviderAdapterRegistry.layerSingle({
          instanceId,
          driver: ProviderDriverKind.make(provider),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: () => Effect.die("Admission must not start a provider"),
        }),
        { databaseLayer: database, runEffectWorker: false, recoverOnStartup: false },
      );
      const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
      const legacy = LegacyV1ThreadImporter.layer.pipe(
        Layer.provide(Layer.merge(database, replay)),
      );
      const settings = ServerSettings.layerTest({
        ardudHarnessMigration: { selections: "apply" },
      });
      const management = ThreadManagementService.layerWithLegacyImporter.pipe(
        Layer.provide(Layer.mergeAll(replay, receipts, legacy, settings)),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const receiptStore = yield* CommandReceiptStore.CommandReceiptStoreV2;
        const threadId = ThreadId.make("thread:control-admission");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:control-admission"),
          threadId,
          projectId: ProjectId.make("project:control-admission"),
          title: "Control admission",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const gate = yield* ServerRuntimeStartup.makeCommandGate;
        const queuedEntered = yield* Deferred.make<void>();
        const releaseQueued = yield* Deferred.make<void>();
        const queued = yield* gate
          .enqueueCommand(
            Deferred.succeed(queuedEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseQueued)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* gate.signalCommandReady;
        yield* Deferred.await(queuedEntered);
        let currentGate = gate;
        const startupEntered = yield* Deferred.make<void>();
        const startupFinished = yield* Deferred.make<void>();
        let holdStartup = false;
        const postCommitEntered = yield* Deferred.make<void>();
        const releasePostCommit = yield* Deferred.make<void>();
        const web = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              controlRouteLayer.pipe(
                Layer.provide(Layer.succeed(NodeSqliteClient.ReaderLane, "background")),
                Layer.provide(
                  Layer.mergeAll(
                    replay,
                    Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                      authenticateHttpRequest: () =>
                        Effect.succeed({
                          sessionId: AuthSessionId.make("test"),
                          subject: "test",
                          method: "bearer-access-token" as const,
                          scopes: ["orchestration:read", "orchestration:operate"],
                        }),
                    }),
                    // Override the replay harness's partial mock with the real management service.
                    Layer.succeed(ThreadManagementService.ThreadManagementService, {
                      ...threads,
                      sendToThread: (input) =>
                        threads.sendToThread(input).pipe(
                          Effect.tap(() => Deferred.succeed(postCommitEntered, undefined)),
                          Effect.tap(() => Deferred.await(releasePostCommit)),
                        ),
                    }),
                    database,
                    settings,
                    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
                    Layer.mock(ProjectService.ProjectService)({}),
                    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                      namedProjectsRoot: "/test",
                    }),
                    Layer.mock(ProviderRegistry.ProviderRegistry)({
                      getProviders: Effect.succeed([
                        {
                          instanceId,
                          driver: provider,
                          enabled: true,
                          installed: true,
                          status: "ready",
                          models: [{ slug: selection.model, name: "Test" }],
                        },
                      ] as never),
                    }),
                    Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
                      ...gate,
                      enqueueCommand: (effect) =>
                        Effect.gen(function* () {
                          if (holdStartup) yield* Deferred.succeed(startupEntered, undefined);
                          return yield* currentGate.enqueueCommand(
                            effect.pipe(
                              Effect.tap(() =>
                                holdStartup
                                  ? Deferred.succeed(startupFinished, undefined)
                                  : Effect.void,
                              ),
                            ),
                          );
                        }),
                    }),
                    Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
                    Layer.mock(ServerSecretStore.ServerSecretStore)({}),
                    ServerConfig.layerTest(process.cwd(), {
                      prefix: "control-send-admission-http",
                    }),
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
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* sql
          .withTransaction(
            sql`SELECT thread_id FROM orchestration_v2_projection_threads`.pipe(
              Effect.andThen(Deferred.succeed(held, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
          )
          .pipe(NodeSqliteClient.readOnly, NodeSqliteClient.backgroundReads, Effect.forkChild);
        yield* Deferred.await(held);
        const commandId = CommandId.make(`ardud-control:send:${threadId}:control-admission`);
        const request = (requestId = "control-admission", abortSignal?: AbortSignal) =>
          Effect.promise(async (signal) => {
            const response = await web.handler(
              new Request(
                `http://env.local${CONTROL_ROUTE_PREFIX}/threads/${encodeURIComponent(threadId)}/send`,
                {
                  signal: abortSignal ?? signal,
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ text: "save once", mode, clientRequestId: requestId }),
                },
              ),
            );
            const text = await response.text();
            return {
              status: response.status,
              body: text.length === 0 ? null : (JSON.parse(text) as unknown),
            };
          }).pipe(Effect.timeout("5 seconds"));
        const first = yield* request();
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({
          ok: true,
          threadId,
          messageId: commandId,
          delivery: "started",
        });
        expect(
          (yield* receiptStore.getByCommandId(commandId).pipe(NodeSqliteClient.foregroundReads))
            ._tag,
        ).toBe("Some");
        const repeated = yield* request();
        expect(repeated).toEqual(first);
        const records = yield* orchestrator
          .getThreadRecords(threadId, ["messages"], {
            messageIds: [MessageId.make(commandId)],
          })
          .pipe(NodeSqliteClient.foregroundReads);
        expect(records.messages).toHaveLength(1);
        expect(holder.pollUnsafe()).toBeUndefined();
        expect(queued.pollUnsafe()).toBeUndefined();
        expect(yield* Deferred.isDone(postCommitEntered)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Deferred.await(postCommitEntered);
        yield* Deferred.succeed(releasePostCommit, undefined);
        yield* Deferred.succeed(releaseQueued, undefined);
        yield* Fiber.join(queued);
        currentGate = yield* ServerRuntimeStartup.makeCommandGate;
        holdStartup = true;
        const abort = new AbortController();
        const cancelled = yield* request("cancelled-before-ready", abort.signal).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(startupEntered);
        yield* Effect.yieldNow;
        yield* Effect.sync(() => abort.abort());
        expect((yield* Fiber.join(cancelled)).status).toBe(499);
        yield* currentGate.signalCommandReady;
        // The queued readiness marker may finish later; it must not carry a message.
        yield* Deferred.await(startupFinished);
        const cancelledId = CommandId.make(`ardud-control:send:${threadId}:cancelled-before-ready`);
        expect(
          (yield* receiptStore.getByCommandId(cancelledId).pipe(NodeSqliteClient.foregroundReads))
            ._tag,
        ).toBe("None");
      }).pipe(Effect.provide(Layer.mergeAll(database, replay, receipts, management)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
