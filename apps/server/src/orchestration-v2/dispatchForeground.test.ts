import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { McpCall } from "../ardud/analytics/McpCall.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

it.live.each(
  (["message.dispatch", "delegated_task.request"] as const).flatMap((type) =>
    (
      [
        "enabled",
        "disabled",
        "unavailable",
        "readiness-unavailable",
        "hydration-failure",
        "hydration-saved",
        "receipt-unavailable",
      ] as const
    ).map((state) => ({ type, state })),
  ),
)("$type pre-check with background held and foreground $state", ({ type, state }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "dispatch-foreground-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"));
    const stores = Layer.mergeAll(
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      EventStore.layer.pipe(Layer.provide(database)),
      CommandReceiptStore.layer.pipe(Layer.provide(database)),
    );
    const sink = EventSink.layer.pipe(Layer.provide(stores));
    const importer = LegacyV1ThreadImporter.layer.pipe(Layer.provide(Layer.merge(stores, sink)));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:dispatch-foreground");
      const thread = {
        ...idleThreadProjection(liveThreadShell(threadId)).thread,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
      };
      const instanceId = thread.modelSelection.instanceId;
      yield* events.write({
        events: [
          {
            id: EventId.make("event:dispatch-foreground"),
            type: "thread.created",
            threadId,
            occurredAt: thread.createdAt,
            payload: thread,
          },
        ],
      });
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
      const oldEntered = yield* Deferred.make<void>();
      const old = yield* Deferred.succeed(oldEntered, undefined).pipe(
        Effect.andThen(store.getThreadRecords(threadId, [])),
        NodeSqliteClient.readOnly,
        NodeSqliteClient.backgroundReads,
        Effect.forkChild,
      );
      yield* Deferred.await(oldEntered);
      let dispatched = false;
      const call: McpCall["Service"] = {
        callerResolved: true,
        callerResolveMs: 0,
        readerLane: "background",
        phase: "handler",
        saved: "unknown",
      };
      const realImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const realReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(
          ThreadManagementService.layerWithLegacyImporter.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
                Layer.succeed(LegacyV1ThreadImporter.LegacyV1ThreadImporter, {
                  ...realImporter,
                  ensureTranscript: (id) =>
                    state === "hydration-saved"
                      ? events
                          .write({
                            events: [
                              {
                                id: EventId.make("event:hydration:changed"),
                                type: "thread.metadata-updated",
                                threadId,
                                occurredAt: thread.createdAt,
                                payload: { ...thread, title: "hydrated" },
                              },
                            ],
                          })
                          .pipe(
                            Effect.as({ importedThreadCount: 1, importedMessageCount: 1 }),
                            Effect.mapError(
                              (cause) =>
                                new LegacyV1ThreadImporter.LegacyV1ThreadImportError({
                                  operation: "hydrate transcript for",
                                  cause,
                                }),
                            ),
                          )
                      : state === "readiness-unavailable" || state === "hydration-failure"
                        ? Effect.fail(
                            new LegacyV1ThreadImporter.LegacyV1ThreadImportError({
                              operation:
                                state === "readiness-unavailable"
                                  ? "check transcript readiness for"
                                  : "hydrate transcript for",
                              threadId: id,
                              cause: new Error("Reader lane unavailable"),
                            }),
                          )
                        : realImporter.ensureTranscript(id),
                }),
                Layer.succeed(CommandReceiptStore.CommandReceiptStoreV2, {
                  ...realReceipts,
                  getByCommandId: (id) =>
                    state === "receipt-unavailable"
                      ? Effect.fail(
                          new CommandReceiptStore.CommandReceiptStoreReadError({
                            commandId: id,
                            cause: new Error("Reader lane unavailable"),
                          }),
                        )
                      : realReceipts.getByCommandId(id),
                }),
                ServerSettings.layerTest({
                  ardudHarnessMigration: { selections: "apply" },
                  providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
                  projectSettingsOverrides: {
                    [thread.projectId]: {
                      providerInstances: { [instanceId]: { enabled: state !== "disabled" } },
                    },
                  },
                }),
                Layer.mock(Orchestrator.OrchestratorV2)({
                  getThreadRecords: (id, fields, filter) =>
                    (state === "unavailable" || state === "hydration-saved"
                      ? Effect.fail(
                          new ProjectionStore.ProjectionStoreReadError({
                            threadId: id,
                            cause: new Error("Reader lane unavailable (foreground)"),
                          }),
                        )
                      : store.getThreadRecords(id, fields, filter)
                    ).pipe(
                      NodeSqliteClient.readOnly,
                      Effect.mapError(
                        (cause) =>
                          new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
                      ),
                    ),
                  dispatch: () =>
                    events
                      .write({
                        events: [
                          {
                            id: EventId.make("event:dispatch-foreground:accepted"),
                            type: "thread.metadata-updated",
                            threadId,
                            occurredAt: thread.createdAt,
                            payload: { ...thread, title: "dispatch persisted" },
                          },
                        ],
                      })
                      .pipe(
                        Effect.map((storedEvents) => ({
                          sequence: storedEvents.at(-1)?.sequence ?? 0,
                          storedEvents,
                        })),
                        Effect.tap(() =>
                          Effect.sync(() => {
                            dispatched = true;
                          }),
                        ),
                        Effect.mapError(
                          (cause) =>
                            new Orchestrator.OrchestratorDispatchError({
                              commandId: CommandId.make("test"),
                              commandType: type,
                              cause,
                            }),
                        ),
                      ),
                }),
              ),
            ),
          ),
        ),
      );
      const commandId = CommandId.make("command:dispatch-foreground");
      const command =
        type === "message.dispatch"
          ? {
              type,
              commandId,
              threadId,
              messageId: MessageId.make("message:dispatch-foreground"),
              text: "test",
              attachments: [],
              dispatchMode: { type: "queue_after_active" as const },
              createdBy: "agent" as const,
              creationSource: "mcp" as const,
            }
          : {
              type,
              commandId,
              createdBy: "agent" as const,
              creationSource: "mcp" as const,
              parentThreadId: threadId,
              parentRunId: RunId.make("run:dispatch-foreground"),
              parentNodeId: NodeId.make("node:dispatch-foreground"),
              task: "test",
              modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model: "test" },
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
              completionWake: "always" as const,
            };
      // The unavailable case injects the nested lane error at the orchestrator boundary.
      const send = threads.dispatch(command).pipe(Effect.provideService(McpCall, call));
      if (
        state === "unavailable" ||
        state === "readiness-unavailable" ||
        state === "receipt-unavailable"
      ) {
        const error = yield* send.pipe(
          Effect.provideService(NodeSqliteClient.ReaderLane, "foreground"),
          Effect.flip,
        );
        expect(error.message).toContain("Nothing was saved; retry the same call.");
        expect(userFacingDispatchErrorMessage({ cause: error })).toBe(error.message);
        expect(call.saved).toBe(false);
      } else if (state === "hydration-saved") {
        const error = yield* Effect.flip(send);
        expect(error.message).toContain("Preflight changes were saved");
        expect(userFacingDispatchErrorMessage({ cause: error })).toBe(error.message);
        expect(call.saved).toBe("unknown");
        expect(
          (yield* store
            .getThreadRecords(threadId, [])
            .pipe(NodeSqliteClient.readOnly, NodeSqliteClient.foregroundReads)).thread.title,
        ).toBe("hydrated");
      } else if (state === "hydration-failure") {
        const error = yield* Effect.flip(send);
        expect(error.message).not.toContain("Nothing was saved");
        expect(call.saved).toBe("unknown");
      } else if (state === "disabled") {
        expect((yield* Effect.flip(send))._tag).toBe(
          "ThreadManagementProviderInstanceDisabledError",
        );
      } else {
        yield* send;
        expect(
          (yield* store
            .getThreadRecords(threadId, [])
            .pipe(NodeSqliteClient.readOnly, NodeSqliteClient.foregroundReads)).thread.title,
        ).toBe("dispatch persisted");
      }
      expect(dispatched).toBe(state === "enabled");
      expect(call.readerLane).toBe("foreground");
      expect(holder.pollUnsafe()).toBeUndefined();
      expect(old.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(old);
    }).pipe(Effect.provide(Layer.mergeAll(stores, sink, importer)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each(["message.dispatch", "delegated_task.request"] as const)(
  "the real orchestrator admits %s while the background reader is held",
  (type) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "dispatch-admission-" });
      const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const instanceId = ProviderInstanceId.make("codex");
      const selection = { instanceId, model: "gpt-6.1-sol" };
      const replay = ProviderReplayHarness.layerWithRegistry(
        { name: "dispatch-admission" },
        ProviderAdapterRegistry.layerSingle({
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: () => Effect.die("No provider process is needed for command admission"),
        }),
        { databaseLayer: database, runEffectWorker: false, recoverOnStartup: false },
      );
      const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
      const legacy = LegacyV1ThreadImporter.layer.pipe(
        Layer.provide(Layer.merge(database, replay)),
      );
      const management = ThreadManagementService.layerWithLegacyImporter.pipe(
        Layer.provide(Layer.mergeAll(replay, receipts, legacy, ServerSettings.layerTest())),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const threadId = ThreadId.make("thread:real-admission");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:real-admission"),
          threadId,
          projectId: ProjectId.make("project:real-admission"),
          title: "Real dispatch",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start:real-admission"),
          threadId,
          messageId: MessageId.make("start:real-admission"),
          text: "parent",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
        const run = runs[0]!;
        const parentNodeId = run.rootNodeId;
        if (parentNodeId === null)
          return yield* Effect.die("The seeded active run needs a root node");
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
        const oldEntered = yield* Deferred.make<void>();
        const old = yield* Deferred.succeed(oldEntered, undefined).pipe(
          Effect.andThen(orchestrator.getThreadRecords(threadId, [])),
          NodeSqliteClient.backgroundReads,
          Effect.forkChild,
        );
        yield* Deferred.await(oldEntered);
        const commandId = CommandId.make("command:real-admission");
        const result = yield* threads.dispatch(
          type === "message.dispatch"
            ? {
                type,
                commandId,
                threadId,
                messageId: MessageId.make("message:real-admission"),
                text: "queued",
                attachments: [],
                dispatchMode: { type: "queue_after_active" },
                createdBy: "agent",
                creationSource: "mcp",
              }
            : {
                type,
                commandId,
                parentThreadId: threadId,
                parentRunId: run.id,
                parentNodeId,
                task: "real admission",
                modelSelection: selection,
                runtimeMode: "full-access",
                interactionMode: "default",
                completionWake: "always",
                createdBy: "agent",
                creationSource: "mcp",
              },
        );
        expect(
          result.storedEvents.some(({ event }) =>
            type === "message.dispatch"
              ? event.type === "message.updated" &&
                event.payload.id === MessageId.make("message:real-admission")
              : event.type === "subagent.updated",
          ),
        ).toBe(true);
        const receiptStore = yield* CommandReceiptStore.CommandReceiptStoreV2;
        expect(
          (yield* receiptStore.getByCommandId(commandId).pipe(NodeSqliteClient.foregroundReads))
            ._tag,
        ).toBe("Some");
        expect(holder.pollUnsafe()).toBeUndefined();
        expect(old.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(old);
      }).pipe(Effect.provide(Layer.mergeAll(database, replay, receipts, management)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
