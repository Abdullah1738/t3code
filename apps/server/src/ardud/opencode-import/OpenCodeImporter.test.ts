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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
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

it("hydrates historical children with their own OpenCode models after the parent migrates", async () => {
  const requests: string[] = [];
  const server = await serve((req, res) => {
    const path = req.url ?? "";
    requests.push(path);
    res.setHeader("content-type", "application/json");
    const send = (status: number, value: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(value));
    };
    if (path.startsWith("/api/session/ses_parent/message?")) {
      return send(200, {
        data: [{
          id: "msg_parent",
          type: "assistant",
          time: { created: 1_767_225_600_000 },
          content: ["ses_child", "ses_messages", "ses_deleted"].map((sessionID) => ({
            type: "tool",
            name: "subagent",
            state: { status: "completed", input: { description: sessionID }, metadata: { sessionID } },
          })),
        }],
        cursor: {},
      });
    }
    if (path === "/api/session/ses_child") {
      return send(200, { data: { model: { providerID: "opus", id: "cc/child", variant: "max" } } });
    }
    if (path === "/api/session/ses_messages") return send(200, { data: {} });
    if (path.startsWith("/api/session/ses_messages/message?")) {
      return send(200, { data: [{ model: { providerID: "or", id: "original/model", variant: "high" } }], cursor: {} });
    }
    return send(404, {});
  });
  try {
    const database = SqlitePersistence.layerMemory;
    const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(Layer.provideMerge(database));
    const dependencies = Layer.mergeAll(
      stores,
      EventSink.layer.pipe(Layer.provide(stores)),
      IdAllocator.layer,
      ServerSettings.layerTest({
        providerInstances: {
          [opencodeInstance]: { driver: "opencode", config: { serverUrl: server.url, serverPassword: "test" } },
        },
      }),
      NodeServices.layer,
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
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
                nativeThreadRef: { driver: ProviderDriverKind.make("claudeAgent"), nativeId: "native-parent", strength: "strong" },
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
        yield* sql`INSERT INTO ardud_opencode_import (native_session_id, thread_id, imported_at) VALUES ('ses_parent', ${parentId}, '2026-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO ardud_opencode_import_state (native_session_id, thread_id) VALUES ('ses_parent', ${parentId})`;
        yield* importer.ensureTranscript(parentId);
        const childId = (id: string) => ids.derive.threadFromProviderThread({
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
        expect(child.providerThreads[0]?.nativeThreadRef).toMatchObject({ driver: "opencode", nativeId: "ses_child" });
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
        yield* importer.ensureTranscript(parentId);
        expect(requests.filter((path) => path === "/api/session/ses_child")).toHaveLength(1);
      }).pipe(Effect.provide(dependencies)),
    );
  } finally {
    server.close();
  }
});
