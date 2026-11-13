// @effect-diagnostics nodeBuiltinImport:off - the fake OpenCode server is plain Node http.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";
import { controlDDL } from "../persistence/boardsSchema.ts";
import * as OpenCodeImporter from "./OpenCodeImporter.ts";
import { importedThreadId, OPENCODE_DRIVER } from "./transcript.ts";

const serve = (handler: NodeHttp.RequestListener) =>
  new Promise<{ readonly url: string; readonly close: () => void }>((resolve) => {
    const server = NodeHttp.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });

const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const parentId = importedThreadId("ses_parent");
const nativeInstance = ProviderInstanceId.make("claudeAgent");
const opencodeInstance = ProviderInstanceId.make("opencode");
const nativeProviderThreadId = ProviderThreadId.make("provider-thread:native-parent");
const parent: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "server",
  id: parentId,
  projectId: ProjectId.make("project:import-test"),
  title: "Migrated parent",
  providerInstanceId: nativeInstance,
  modelSelection: { instanceId: nativeInstance, model: "claude-opus-4-6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: nativeProviderThreadId,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

const hydrateChildren = Effect.fn("test.hydrateChildren")(function* (separateDatabase: boolean) {
  const requests: string[] = [];
  const server = yield* Effect.acquireRelease(
    Effect.promise(() =>
      serve((req, res) => {
        const path = req.url ?? "";
        requests.push(path);
        res.setHeader("content-type", "application/json");
        const send = (status: number, value: unknown) => {
          res.writeHead(status);
          res.end(JSON.stringify(value));
        };
        if (path.startsWith("/api/session?")) {
          return send(200, {
            data: [
              {
                id: "ses_parent",
                title: "Updated historical title",
                time: { created: 1_767_225_600_000, updated: 1_767_225_601_000 },
                location: { directory: "/project" },
              },
            ],
            cursor: {},
          });
        }
        if (path === "/api/project") return send(200, []);
        if (path.startsWith("/api/model?")) return send(200, { data: [] });
        if (path.startsWith("/api/session/ses_parent/message?")) {
          return send(200, {
            data: [
              {
                id: "msg_parent",
                type: "assistant",
                time: { created: 1_767_225_600_000 },
                content: ["ses_child", "ses_messages", "ses_deleted"].map((sessionID) => ({
                  type: "tool",
                  name: "subagent",
                  state: {
                    status: "completed",
                    input: { description: sessionID },
                    metadata: { sessionID },
                  },
                })),
              },
            ],
            cursor: {},
          });
        }
        if (path === "/api/session/ses_child") {
          return send(200, {
            data: { model: { providerID: "opus", id: "cc/child", variant: "max" } },
          });
        }
        if (path === "/api/session/ses_messages") return send(200, { data: {} });
        if (path.startsWith("/api/session/ses_messages/message?")) {
          return send(200, {
            data: [{ model: { providerID: "or", id: "original/model", variant: "high" } }],
            cursor: {},
          });
        }
        return send(404, {});
      }),
    ),
    (server) => Effect.sync(server.close),
  );
  {
    const boardContext = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
    const boardSql = Context.get(boardContext, SqlClient.SqlClient);
    if (separateDatabase) {
      yield* Effect.forEach(controlDDL, (ddl) => boardSql.unsafe(ddl), { discard: true });
    }
    const database = SqlitePersistence.layerMemory;
    const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(database),
    );
    const dependencies = Layer.mergeAll(
      stores,
      EventSink.layer.pipe(Layer.provide(stores)),
      IdAllocator.layer,
      ServerSettings.layerTest({
        providerInstances: {
          [opencodeInstance]: {
            driver: "opencode",
            config: { serverUrl: server.url, serverPassword: "test" },
          },
        },
      }),
      NodeServices.layer,
      separateDatabase
        ? Layer.succeed(
            BoardsDatabase.BoardsDatabase,
            BoardsDatabase.BoardsDatabase.of({
              sql: boardSql,
              ready: Effect.void,
              path: ":memory:",
            }),
          )
        : Layer.empty,
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const controlSql = yield* BoardsDatabase.client;
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const importer = yield* OpenCodeImporter.make;
      yield* sink.write({
        events: [
          {
            id: EventId.make("parent-created"),
            type: "thread.created",
            threadId: parentId,
            providerInstanceId: opencodeInstance,
            occurredAt: at,
            payload: {
              ...parent,
              providerInstanceId: opencodeInstance,
              modelSelection: { instanceId: opencodeInstance, model: "opus/old-parent" },
              activeProviderThreadId: null,
            },
          },
          {
            id: EventId.make("parent-native-provider"),
            type: "provider-thread.updated",
            threadId: parentId,
            driver: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: nativeInstance,
            occurredAt: at,
            payload: {
              id: nativeProviderThreadId,
              driver: ProviderDriverKind.make("claudeAgent"),
              providerInstanceId: nativeInstance,
              providerSessionId: null,
              appThreadId: parentId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("claudeAgent"),
                nativeId: "native-parent",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              createdAt: at,
              updatedAt: at,
            },
          },
          {
            id: EventId.make("parent-migrated"),
            type: "thread.provider-switched",
            threadId: parentId,
            providerInstanceId: nativeInstance,
            occurredAt: at,
            payload: parent,
          },
        ],
      });
      yield* controlSql`INSERT INTO ardud_opencode_import (native_session_id, thread_id, imported_at) VALUES ('ses_parent', ${parentId}, '2026-01-01T00:00:00.000Z')`;
      yield* controlSql`INSERT INTO ardud_opencode_import_state (native_session_id, thread_id) VALUES ('ses_parent', ${parentId})`;
      yield* controlSql`INSERT INTO ardud_thread_origin (thread_id, origin, created_at) VALUES (${parentId}, 'imessage', '2026-01-01T00:00:00.000Z')`;
      yield* importer.ensureTranscript(parentId);
      const childId = (id: string) =>
        ids.derive.threadFromProviderThread({
          driver: OPENCODE_DRIVER,
          providerInstanceId: opencodeInstance,
          nativeThreadId: id,
        });
      const child = yield* projections.getThreadProjection(childId("ses_child"));
      expect(child.thread.providerInstanceId).toBe(opencodeInstance);
      expect(child.thread.modelSelection).toEqual({
        instanceId: opencodeInstance,
        model: "opus/cc/child",
        options: [{ id: "variant", value: "max" }],
      });
      expect(child.providerThreads[0]?.nativeThreadRef).toMatchObject({
        driver: "opencode",
        nativeId: "ses_child",
      });
      const fromMessages = yield* projections.getThreadProjection(childId("ses_messages"));
      expect(fromMessages.thread.modelSelection).toEqual({
        instanceId: opencodeInstance,
        model: "or/original/model",
        options: [{ id: "variant", value: "high" }],
      });
      const deleted = yield* projections.getThreadProjection(childId("ses_deleted"));
      expect(deleted.thread.providerInstanceId).toBe(opencodeInstance);
      expect(deleted.thread.modelSelection.instanceId).toBe(opencodeInstance);
      const migratedParent = yield* projections.getThread(parentId);
      expect(migratedParent.modelSelection).toEqual(parent.modelSelection);
      expect(migratedParent.activeProviderThreadId).toBe(nativeProviderThreadId);
      expect(
        yield* controlSql`SELECT origin FROM ardud_thread_origin WHERE thread_id = ${childId("ses_child")}`,
      ).toEqual([{ origin: "imessage" }]);
      expect(
        yield* controlSql`SELECT transcript_head FROM ardud_opencode_import_state WHERE native_session_id = 'ses_parent'`,
      ).toEqual([{ transcript_head: "msg_parent" }]);
      expect(
        yield* controlSql`SELECT thread_id FROM ardud_opencode_import WHERE native_session_id = 'ses_child'`,
      ).toEqual([{ thread_id: childId("ses_child") }]);
      expect(
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_turn_item_positions WHERE thread_id = ${parentId}`,
      ).not.toEqual([{ count: 0 }]);
      yield* importer.ensureTranscript(parentId);
      expect(requests.filter((path) => path === "/api/session/ses_child")).toHaveLength(1);
      const updated = yield* importer.run();
      expect(updated.updated).toBe(1);
      expect(updated.failed).toBe(0);
      expect(
        yield* controlSql`SELECT session_updated_ms, title FROM ardud_opencode_import_state WHERE native_session_id = 'ses_parent'`,
      ).toEqual([{ session_updated_ms: 1_767_225_601_000, title: "Updated historical title" }]);
      expect((yield* projections.getThread(parentId)).title).toBe("Updated historical title");
      expect((yield* importer.run()).unchanged).toBe(1);
      if (separateDatabase) {
        expect(
          yield* sql`SELECT name FROM sqlite_schema WHERE name IN ('ardud_thread_origin', 'ardud_opencode_import', 'ardud_opencode_import_state')`,
        ).toEqual([]);
        expect(
          yield* boardSql`SELECT name FROM sqlite_schema WHERE name = 'orchestration_events'`,
        ).toEqual([]);
      }
    }).pipe(Effect.provide(dependencies));
  }
}, Effect.scoped);

it.effect(
  "hydrates historical children with their own OpenCode models after the parent migrates",
  () => hydrateChildren(false),
);

it.effect(
  "keeps imported mappings, origins and transcript state separate from orchestration writes",
  () => hydrateChildren(true),
);
