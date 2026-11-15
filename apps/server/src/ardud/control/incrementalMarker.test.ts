import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ControlStore from "./ControlStore.ts";

it.effect("thread change marker covers inserts, streaming, completion and pending requests", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const control = yield* ControlStore.ControlStore;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("incremental-marker");
    const thread = idleThreadProjection(liveThreadShell(threadId)).thread;
    const epoch = DateTime.toEpochMillis(thread.updatedAt);
    yield* projections.apply({
      id: EventId.make("create"),
      type: "thread.created",
      threadId,
      occurredAt: thread.updatedAt,
      payload: thread,
    });
    let tick = 0;
    const apply = (event: OrchestrationV2DomainEvent) =>
      Effect.gen(function* () {
        const previous = epoch + tick * 1000;
        tick++;
        const now = DateTime.makeUnsafe(epoch + tick * 1000);
        yield* projections.apply({ ...event, occurredAt: now });
        assert.equal(
          DateTime.toEpochMillis((yield* projections.getThreadShell(threadId))!.updatedAt),
          epoch + tick * 1000,
        );
        const filter = {
          since: previous,
          location: "active" as const,
          includeSubagents: true,
          parentThreadId: null,
          projectId: null,
          limit: 10,
        };
        assert.deepStrictEqual(
          (yield* control.threadCandidatePage(filter)).map((t) => t.threadId),
          [threadId],
        );
        const rows = yield* sql<{
          updated_at: string;
          payload_at: string;
        }>`SELECT updated_at, json_extract(payload_json, '$.updatedAt') AS payload_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
        assert.equal(rows[0]!.updated_at, DateTime.formatIso(now));
        assert.equal(rows[0]!.payload_at, DateTime.formatIso(now));
      });
    const runId = RunId.make("run:marker");
    const nodeId = NodeId.make("node:marker");
    const common = { threadId, occurredAt: thread.updatedAt };
    for (const [id, role] of [
      ["user", "user"],
      ["assistant", "assistant"],
      ["system", "system"],
    ] as const) {
      for (const [text, streaming] of [
        ["first", true],
        ["expanded", true],
        ["finished", false],
      ] as const) {
        const updatedAt = DateTime.makeUnsafe(epoch + (tick + 1) * 1000);
        yield* apply({
          ...common,
          id: EventId.make(`${id}:${text}`),
          type: "message.updated",
          payload: {
            id: MessageId.make(id),
            threadId,
            runId,
            nodeId,
            role,
            createdBy: "agent",
            creationSource: "provider",
            text,
            attachments: [],
            streaming,
            createdAt: thread.createdAt,
            updatedAt,
          },
        });
      }
    }
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: thread.providerInstanceId,
      modelSelection: thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("user"),
      rootNodeId: nodeId,
      activeAttemptId: null,
      status: "running" as const,
      requestedAt: thread.createdAt,
      startedAt: thread.createdAt,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* apply({ ...common, id: EventId.make("run-start"), type: "run.created", payload: run });
    yield* apply({
      ...common,
      id: EventId.make("run-end"),
      type: "run.updated",
      payload: {
        ...run,
        status: "completed",
        completedAt: DateTime.makeUnsafe(epoch + (tick + 1) * 1000),
      },
    });
    yield* apply({
      ...common,
      id: EventId.make("pending"),
      type: "runtime-request.updated",
      payload: {
        id: RuntimeRequestId.make("request:marker"),
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: thread.createdAt,
        resolvedAt: null,
      },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ProjectionStore.layer, ControlStore.layer).pipe(
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  ),
);
