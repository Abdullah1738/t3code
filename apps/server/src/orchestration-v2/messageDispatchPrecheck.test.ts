import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

it.live.each(["committed", "uncommitted"] as const)(
  "message.dispatch precheck reads a %s thread while the writer is held",
  (state) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "dispatch-precheck-" });
      const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "gpt-6.1-sol" };
      const replay = ProviderReplayHarness.layerWithRegistry(
        { name: "dispatch-precheck" },
        ProviderAdapterRegistry.layerSingle({
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: () => Effect.die("No provider process is needed for command admission"),
        }),
        { databaseLayer: database, runEffectWorker: false, recoverOnStartup: false },
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:dispatch-precheck");
        const thread = {
          ...idleThreadProjection(liveThreadShell(threadId)).thread,
          modelSelection,
        };
        const create = projections.apply({
          id: EventId.make("event:dispatch-precheck"),
          type: "thread.created",
          threadId,
          occurredAt: thread.createdAt,
          payload: thread,
        });
        if (state === "committed") yield* create;
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (state === "uncommitted") yield* create;
              yield* Deferred.succeed(held, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(held);

        const milestone = yield* Deferred.make<"dispatchMessage" | "writer-slot">();
        const spans: Tracer.NativeSpan[] = [];
        const precheckSpans = new Set<string>();
        let reachedDispatchMessage = false;
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            if (options.name === "Orchestrator.dispatchMessage") {
              reachedDispatchMessage = true;
              Deferred.doneUnsafe(milestone, Effect.succeed("dispatchMessage"));
            }
            if (options.name === "ProjectionStore.getThread" && !reachedDispatchMessage)
              precheckSpans.add(span.spanId);
            const attribute = span.attribute.bind(span);
            span.attribute = (key, value) => {
              attribute(key, value);
              if (
                key === "db.reader.acquire_stage" &&
                value === "slot" &&
                span.attributes.get("db.connection") === "writer" &&
                Option.isSome(span.parent) &&
                precheckSpans.has(span.parent.value.spanId)
              )
                Deferred.doneUnsafe(milestone, Effect.succeed("writer-slot"));
            };
            return span;
          },
        });
        const messageId = MessageId.make("message:dispatch-precheck");
        const send = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:dispatch-precheck"),
            threadId,
            messageId,
            modelSelection,
            text: "queued",
            attachments: [],
            dispatchMode: { type: "defer_start" },
            createdBy: "agent",
            // Isolate dispatch.once from the separate MCP parent-fence read.
            creationSource: "web",
          })
          .pipe(
            NodeSqliteClient.backgroundReads,
            Effect.provideService(Statement.SpanPropagationEnabled, true),
            Effect.withTracer(tracer),
            Effect.forkChild,
          );
        yield* Effect.gen(function* () {
          expect(yield* Deferred.await(milestone)).toBe(
            state === "committed" ? "dispatchMessage" : "writer-slot",
          );
          expect(holder.pollUnsafe()).toBeUndefined();
          const reads = spans.filter(
            (span) =>
              span.name === "sqlite" &&
              Option.isSome(span.parent) &&
              precheckSpans.has(span.parent.value.spanId),
          );
          expect(reads.map((span) => span.attributes.get("db.connection"))).toEqual(
            state === "committed" ? ["reader"] : ["reader", "writer"],
          );
          expect(reads[0]?.attributes.get("db.reader.effective_lane")).toBe("foreground");
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(holder);
        const result = yield* Fiber.join(send);
        expect(reachedDispatchMessage).toBe(true);
        expect(
          result.storedEvents.some(
            ({ event }) => event.type === "message.updated" && event.payload.id === messageId,
          ),
        ).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(database, replay, ProjectionStore.layer.pipe(Layer.provide(database))),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
