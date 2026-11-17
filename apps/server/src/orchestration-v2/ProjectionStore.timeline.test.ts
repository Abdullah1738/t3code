import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Statement from "effect/sql/Statement";
import * as SqlClient from "effect/sql/SqlClient";
import { liveColumns } from "../ardud/persistence/historyArchiveSql.ts";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

const layer = ProjectionStore.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ROBOB_SQL_STATEMENT_METRICS: "true" } })),
  ),
);

it.effect(
  "bounds local timeline rows and preserves visibility, global positions and item lookup",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:bounded-timeline");
      const shell = liveThreadShell(threadId);
      const now = shell.createdAt;
      const thread = idleThreadProjection(shell).thread;
      yield* store.apply({
        id: EventId.make("create"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      });
      const statuses = ["completed", "rolled_back", "cancelled", "completed", "completed"] as const;
      const runs: OrchestrationV2Run[] = statuses.map((status, index) => ({
        id: RunId.make(`run:${index}`),
        threadId,
        ordinal: index + 1,
        providerInstanceId: shell.providerInstanceId,
        modelSelection: shell.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`input:${index}`),
        rootNodeId: NodeId.make(`node:${index}`),
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      }));
      for (const run of runs)
        yield* store.apply({
          id: EventId.make(`create:${run.id}`),
          type: "run.created",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: run,
        });
      const attempts = [3, 4].map((index) => ({
        id: RunAttemptId.make(`attempt:${index}`),
        runId: runs[index]!.id,
        attemptOrdinal: 1,
        rootNodeId: NodeId.make(`node:${index}`),
        providerInstanceId: shell.providerInstanceId,
        providerThreadId: ProviderThreadId.make(`provider-thread:${index}`),
        providerTurnId: ProviderTurnId.make(`provider-turn:${index}`),
        reason: "initial" as const,
        status: "superseded" as const,
        startedAt: now,
        completedAt: now,
      }));
      for (const attempt of attempts)
        yield* store.apply({
          id: EventId.make(`create:${attempt.id}`),
          type: "run-attempt.created",
          threadId,
          runId: attempt.runId,
          occurredAt: now,
          payload: attempt,
        });
      const body = (index: number, runIndex: number | null) => ({
        id: TurnItemId.make(`item:${String(index).padStart(3, "0")}`),
        threadId,
        runId: runIndex === null ? null : runs[runIndex]!.id,
        nodeId: runIndex === null ? null : NodeId.make(`node:${runIndex}`),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      });
      const items: OrchestrationV2TurnItem[] = [];
      for (let index = 0; index < 80; index++)
        items.push({
          ...body(index, null),
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          messageId: MessageId.make(`message:${index}`),
          text: "bounded",
          attachments: [],
        });
      items.push(
        {
          ...body(80, 1),
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          messageId: MessageId.make("rolled"),
          text: "hidden",
          attachments: [],
        },
        {
          ...body(81, 2),
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "queued_turn",
          messageId: MessageId.make("queued"),
          text: "hidden",
          attachments: [],
        },
        {
          ...body(82, 2),
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          messageId: MessageId.make("cancelled"),
          text: "visible",
          attachments: [],
        },
        { ...body(83, 3), type: "run_interrupt_result", message: "superseded" },
        { ...body(84, 4), type: "run_interrupt_request", message: "stop" },
        { ...body(85, 4), type: "run_interrupt_result", message: "paired stop" },
        { ...body(86, null), type: "system_notice", message: "activity" },
      );
      for (const item of items)
        yield* store.apply({
          id: EventId.make(`apply:${item.id}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: item,
        });
      const visible = items.filter(
        createOrchestrationV2TurnItemVisibility({ runs, attempts, items }),
      );
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      for (const view of ["activity", "messages"] as const) {
        for (const afterPosition of [-1, 79, 81, 1000]) {
          spans.length = 0;
          const result = yield* store
            .getTimelinePage(threadId, { view, limit: 1, afterPosition })
            .pipe(
              Effect.withTracer(tracer),
              Effect.provideService(Statement.SpanPropagationEnabled, true),
            );
          const matching = visible
            .map((item, position) => ({ item, position }))
            .filter(
              (row) =>
                row.position > afterPosition &&
                (view === "activity" ||
                  ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type)),
            );
          assert.equal(result.totalItems, visible.length);
          assert.deepEqual(
            result.items.map((row) => [row.item.id, row.position]),
            matching.slice(0, 1).map((row) => [row.item.id, row.position]),
          );
          assert.equal(result.hasMore, matching.length > 1);
          const sql = spans.filter((span) => span.name === "sqlite");
          assert.isAtMost(sql.length, 3);
          assert.isTrue(sql.every((span) => Number(span.attributes.get("db.rows_returned")) <= 2));
        }
      }
      const sql = yield* SqlClient.SqlClient;
      const columns = liveColumns("orchestration_v2_projection_turn_items");
      yield* sql.unsafe(`INSERT INTO ardud_base.orchestration_v2_projection_turn_items (${columns})
        SELECT ${columns} FROM main.orchestration_v2_projection_turn_items`);
      yield* sql.unsafe(`INSERT INTO ardud_archive.ardud_turn_items (${columns})
        SELECT ${columns} FROM main.orchestration_v2_projection_turn_items WHERE ordinal % 3 <> 0`);
      yield* sql`DELETE FROM main.orchestration_v2_projection_turn_items WHERE ordinal % 3 <> 2`;
      const tiered = yield* store.getTimelinePage(threadId, { view: "activity", limit: 100 });
      assert.equal(tiered.totalItems, visible.length);
      assert.deepEqual(
        tiered.items.map((row) => row.item.id),
        visible.map((item) => item.id),
      );
      assert.isFalse(tiered.hasMore);
      for (const item of items.slice(80)) {
        const result = yield* store.getTimelinePage(threadId, {
          view: "messages",
          limit: 1,
          itemId: item.id,
        });
        assert.deepEqual(
          result.items.map((row) => row.item.id),
          visible.some((row) => row.id === item.id) ? [item.id] : [],
        );
      }
    }).pipe(Effect.provide(layer)),
);
