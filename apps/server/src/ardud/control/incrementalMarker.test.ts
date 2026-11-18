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
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ControlStore from "./ControlStore.ts";

it.effect("event change marker covers tied and backward message, run and request timestamps", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const control = yield* ControlStore.ControlStore;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("incremental-marker");
    const thread = idleThreadProjection(liveThreadShell(threadId)).thread;
    const epoch = DateTime.toEpochMillis(thread.updatedAt);
    const persist = (event: OrchestrationV2DomainEvent) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* events.appendAgentEvents({ events: [event] });
          yield* projections.apply(event);
        }),
      );
    yield* persist({
      id: EventId.make("create"),
      type: "thread.created",
      threadId,
      occurredAt: thread.updatedAt,
      payload: thread,
    });
    let tick = 0;
    const apply = (event: OrchestrationV2DomainEvent) =>
      Effect.gen(function* () {
        const before = (yield* control.changeMarkers([threadId])).get(threadId)!;
        // Exercise forward, equal and backward clocks on separately committed events.
        const now = DateTime.makeUnsafe(epoch + [1000, 1000, 1000, 0][tick % 4]!);
        tick++;
        yield* persist(
          event.type === "message.updated"
            ? { ...event, occurredAt: now, payload: { ...event.payload, updatedAt: now } }
            : { ...event, occurredAt: now },
        );
        const after = (yield* control.changeMarkers([threadId])).get(threadId)!;
        assert.isAbove(after, before, event.id);
        assert.equal(
          DateTime.toEpochMillis((yield* projections.getThreadShell(threadId))!.updatedAt),
          DateTime.toEpochMillis(now),
        );
      });
    assert.equal((yield* control.changeMarkers(["missing"])).get("missing"), 0);
    const markerPlan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT sequence FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
      WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = ${threadId}
      ORDER BY sequence DESC LIMIT 1`;
    assert.isTrue(
      markerPlan.some((row) =>
        /SEARCH orchestration_events USING (?:COVERING )?INDEX idx_orchestration_events_agent_stream_sequence/.test(
          row.detail,
        ),
      ),
    );
    assert.isFalse(
      markerPlan.some((row) => /SCAN orchestration_events|TEMP B-TREE/.test(row.detail)),
    );
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
        ["revised", false],
      ] as const) {
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
            updatedAt: thread.updatedAt,
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
    const beforeUnrelated = (yield* control.changeMarkers([threadId])).get(threadId);
    const other = idleThreadProjection(liveThreadShell(ThreadId.make("unrelated-marker"))).thread;
    yield* persist({
      id: EventId.make("other-create"),
      type: "thread.created",
      threadId: other.id,
      occurredAt: other.updatedAt,
      payload: other,
    });
    assert.equal((yield* control.changeMarkers([threadId])).get(threadId), beforeUnrelated);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ProjectionStore.layer, ControlStore.layer, OrchestrationEventStore.layer).pipe(
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  ),
);
