import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for projection reads"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

it.live(
  "reads projections and project shells during a writer transaction and sees its own writes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-orchestrator-reader-" });
      const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const layerTest = Layer.mergeAll(
        database,
        ProjectionStore.layer.pipe(Layer.provide(database)),
        ProjectStore.layer.pipe(Layer.provide(database)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "projection-reader" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: database, runEffectWorker: false },
        ),
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project:reader");
        const threadId = ThreadId.make("thread:reader");
        const messageId = MessageId.make("message:reader");
        const itemId = TurnItemId.make("item:reader");
        const now = yield* DateTime.now;
        const timestamp = DateTime.formatIso(now);

        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (${projectId}, 'Project before', '/reader', '[]', ${timestamp}, ${timestamp})
      `;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-reader"),
          threadId,
          projectId,
          title: "Thread before",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const thread = yield* projections.getThread(threadId);
        const message = {
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role: "user" as const,
          text: "Message before",
          attachments: [],
          streaming: false,
          createdBy: "user" as const,
          creationSource: "web" as const,
          createdAt: now,
          updatedAt: now,
        };
        yield* projections.apply({
          id: EventId.make("reader:message-before"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: message,
        });
        const item = {
          id: itemId,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed" as const,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message" as const,
          createdBy: "user" as const,
          creationSource: "web" as const,
          messageId,
          inputIntent: "turn_start" as const,
          text: message.text,
          attachments: [],
        };
        yield* projections.apply({
          id: EventId.make("reader:item-before"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: item,
        });

        const readAll = Effect.all({
          records: orchestrator.getThreadRecords(threadId, ["messages"]),
          snapshot: orchestrator.getThreadSnapshot(threadId),
          window: orchestrator.getThreadSnapshotWindow(threadId, { rowLimit: 20 }),
          shellSnapshot: orchestrator.getShellSnapshot(),
          threadShell: orchestrator.getThreadShell(threadId),
          projectShell: projects.getShell(projectId),
          projectShells: projects.listShells(),
        });
        const assertContents = (
          result: Effect.Success<typeof readAll>,
          threadTitle: string,
          messageText: string,
          projectTitle: string,
        ) => {
          assert.equal(result.records.thread.title, threadTitle);
          assert.deepEqual(
            result.records.messages.map((item) => item.text),
            [messageText],
          );
          assert.equal(result.snapshot.projection.thread.title, threadTitle);
          assert.deepEqual(
            result.snapshot.projection.messages.map((item) => item.text),
            [messageText],
          );
          assert.equal(result.window.projection.thread.title, threadTitle);
          assert.deepEqual(
            result.window.projection.messages.map((item) => item.text),
            [messageText],
          );
          assert.equal(
            result.shellSnapshot.threads.find((item) => item.id === threadId)?.title,
            threadTitle,
          );
          assert.equal(result.threadShell?.title, threadTitle);
          assert.equal(Option.getOrUndefined(result.projectShell)?.title, projectTitle);
          assert.equal(
            result.projectShells.find((item) => item.id === projectId)?.title,
            projectTitle,
          );
        };

        const before = yield* readAll;
        assertContents(before, "Thread before", "Message before", "Project before");
        const held = yield* Deferred.make<Effect.Success<typeof readAll>>();
        const release = yield* Deferred.make<void>();
        const writer = yield* Effect.forkChild(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE projection_projects SET title = 'Project after' WHERE project_id = ${projectId}`;
              yield* projections.apply({
                id: EventId.make("reader:thread-after"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: { ...thread, title: "Thread after" },
              });
              yield* projections.apply({
                id: EventId.make("reader:message-after"),
                type: "message.updated",
                threadId,
                occurredAt: now,
                payload: { ...message, text: "Message after" },
              });
              yield* projections.apply({
                id: EventId.make("reader:item-after"),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: { ...item, text: "Message after" },
              });
              const ownWrites = yield* readAll;
              yield* Deferred.succeed(held, ownWrites);
              yield* Deferred.await(release);
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const ownWrites = yield* Deferred.await(held);
          assertContents(ownWrites, "Thread after", "Message after", "Project after");
          const during = yield* readAll;
          assert.deepEqual(during, before);
          assertContents(during, "Thread before", "Message before", "Project before");
        }).pipe(
          Effect.timeout("30 seconds"),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
        yield* Fiber.join(writer);
        const after = yield* readAll;
        assertContents(after, "Thread after", "Message after", "Project after");
      }).pipe(Effect.provide(layerTest));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
