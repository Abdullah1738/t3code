import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";
import * as Persistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { readCallerIdentity } from "../mcp/callerIdentity.ts";
import { isLiveCallerShell } from "../mcp/OrchestratorMcpService.ts";

const layer = ProjectionStore.layer.pipe(Layer.provideMerge(Persistence.layerMemory));

it.effect.each([
  "active",
  "fork",
  "archived",
  "deleted",
  "subagent",
  "empty",
  "rolled-back",
] as const)("%s caller row and liveness match the existing shell", (state) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const id = ThreadId.make(`caller:${state}`);
    const base = liveThreadShell(id);
    const now = base.createdAt;
    const runId = RunId.make(`run:${state}`);
    const thread = {
      ...idleThreadProjection(base).thread,
      archivedAt: state === "archived" ? now : null,
      deletedAt: state === "deleted" ? now : null,
      forkedFrom:
        state === "fork"
          ? { type: "run" as const, threadId: ThreadId.make("source"), runId }
          : null,
    };
    yield* store.apply({
      id: EventId.make(`created:${state}`),
      type: "thread.created",
      threadId: id,
      occurredAt: now,
      payload: thread,
    });
    if (state !== "empty") {
      yield* store.apply({
        id: EventId.make(`run:${state}`),
        type: "run.created",
        threadId: id,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: id,
          ordinal: 1,
          providerInstanceId: base.providerInstanceId,
          modelSelection: base.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`input:${state}`),
          rootNodeId: NodeId.make(`root:${state}`),
          activeAttemptId: null,
          status:
            state === "subagent"
              ? "completed"
              : state === "rolled-back"
                ? "rolled_back"
                : "running",
          requestedAt: now,
          startedAt: now,
          completedAt: state === "subagent" || state === "rolled-back" ? now : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
    }
    if (state === "subagent" || state === "rolled-back") {
      yield* store.apply({
        id: EventId.make(`provider:${state}`),
        type: "provider-thread.updated",
        threadId: id,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make(`provider:${state}`),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: base.providerInstanceId,
          providerSessionId: null,
          appThreadId: id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          pendingBackgroundTasks: [{ taskId: "native-subagent", kind: "subagent" }],
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    const row = yield* store.getCallerRow(id);
    const shell = yield* store.getThreadShell(id);
    if (shell === null) assert.isNull(row);
    else {
      assert.isNotNull(row);
      for (const key of [
        "id",
        "projectId",
        "deletedAt",
        "archivedAt",
        "runtimeMode",
        "interactionMode",
        "providerInstanceId",
        "activeRunId",
      ] as const) {
        assert.deepEqual(row![key], shell[key]);
      }
    }
    const sql = yield* SqlClient.SqlClient;
    const statements: string[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query === "string" && query.trimStart().startsWith("SELECT"))
            statements.push(query);
        };
        return span;
      },
    });
    yield* store
      .getCallerRow(id)
      .pipe(
        Effect.withTracer(tracer),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
      );
    assert.equal(statements.length, state === "deleted" ? 1 : 2);
    for (const query of statements) {
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, [id]);
      assert.isTrue(
        plan.some((p) => /SEARCH .* USING (?:COVERING )?(?:INDEX|PRIMARY KEY)/.test(p.detail)),
        JSON.stringify(plan),
      );
      assert.isFalse(
        plan.some((p) => /SCAN |TEMP B-TREE/.test(p.detail)),
        JSON.stringify(plan),
      );
    }
    const threads = yield* ThreadManagement.ThreadManagementService;
    let fallback = false;
    const identity = yield* readCallerIdentity(
      {
        ...threads,
        getCallerRow: (threadId) => store.getCallerRow(threadId).pipe(Effect.orDie),
        getThreadShell: (threadId) => {
          fallback = true;
          return store.getThreadShell(threadId).pipe(Effect.orDie);
        },
      },
      id,
      ProviderInstanceId.make("codex"),
    );
    assert.equal(fallback, state !== "active" && state !== "deleted");
    assert.equal(
      isLiveCallerShell(identity, base.providerInstanceId),
      isLiveCallerShell(shell, base.providerInstanceId),
    );
    if (state === "subagent") assert.isTrue(isLiveCallerShell(identity, base.providerInstanceId));
    if (state === "rolled-back" || state === "empty")
      assert.isFalse(isLiveCallerShell(identity, base.providerInstanceId));
  }).pipe(
    Effect.provide(Layer.merge(layer, Layer.mock(ThreadManagement.ThreadManagementService)({}))),
  ),
);
