import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  OrchestrationV2RuntimeRequestJson,
  RuntimeRequestId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { shellSummary } from "../ardud/control/model.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projection from "./ProjectionStore.ts";

const layer = Projection.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("control summaries retain every response field while skipping history metadata", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projection = yield* Projection.ProjectionStoreV2;
    const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    const stamp = DateTime.formatIso(at);
    const names = [
      "running",
      "waiting",
      "queue",
      "held",
      "rolled",
      "limit-queue",
      "limit-cancel",
      "fork",
      "archived",
    ];
    const ids = names.map((name) => ThreadId.make(name));
    for (const id of ids) {
      const thread = idleThreadProjection(liveThreadShell(id)).thread;
      yield* projection.apply({
        id: EventId.make(`create:${id}`),
        type: "thread.created",
        threadId: id,
        occurredAt: at,
        payload: {
          ...thread,
          archivedAt: id === "archived" ? at : null,
          forkedFrom:
            id === "fork"
              ? {
                  type: "run",
                  threadId: ThreadId.make("archived"),
                  runId: RunId.make("archived:1"),
                }
              : null,
        },
      });
    }
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      SELECT t.thread_id || ':' || value, t.thread_id, value, 'codex', 'completed', ${stamp}, ${stamp},
        json_object('startedAt', ${stamp}, 'rootNodeId', t.thread_id || ':node:' || value)
      FROM orchestration_v2_projection_threads t
      CROSS JOIN json_each(${JSON.stringify(Array.from({ length: 128 }, (_, i) => i + 1))})`;
    yield* sql`INSERT INTO ardud_shell_item_counts(thread_id, run_key, item_count)
      SELECT thread_id, run_id, 2 FROM orchestration_v2_projection_runs`;
    const run = (
      threadId: string,
      ordinal: number,
      status: string,
      held = false,
      started = true,
    ) => sql`
      INSERT INTO orchestration_v2_projection_runs ${sql.insert({
        run_id: `${threadId}:${ordinal}`,
        thread_id: threadId,
        ordinal,
        provider: "codex",
        status,
        requested_at: stamp,
        completed_at: ["failed", "cancelled", "rolled_back"].includes(status) ? stamp : null,
        payload_json: JSON.stringify({
          startedAt: started ? stamp : null,
          queueHeld: held,
          rootNodeId: `${threadId}:node:${ordinal}`,
        }),
      })}`;
    yield* run("running", 129, "running");
    yield* run("running", 130, "queued");
    yield* run("waiting", 129, "waiting");
    yield* run("queue", 129, "queued");
    yield* run("held", 129, "queued", true);
    yield* run("rolled", 129, "rolled_back");
    for (const name of ["limit-queue", "limit-cancel"]) {
      yield* run(name, 129, "failed");
      yield* run(name, 130, name === "limit-queue" ? "queued" : "cancelled", false, false);
      const runId = RunId.make(`${name}:129`);
      const nodeId = NodeId.make(`${name}:node:129`);
      yield* projection.apply({
        id: EventId.make(`failure:${name}`),
        type: "turn-item.updated",
        threadId: ThreadId.make(name),
        runId,
        nodeId,
        driver: ProviderDriverKind.make("codex"),
        occurredAt: at,
        payload: {
          id: TurnItemId.make(`error:${name}`),
          threadId: ThreadId.make(name),
          runId,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "failed",
          title: "Limit",
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "error",
          failure: {
            class: "usage_limit",
            message: "Plan limit reached.",
            resetAt: null,
            code: null,
            retryable: null,
          },
        },
      });
    }
    const requestJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(OrchestrationV2RuntimeRequestJson),
    )({
      id: RuntimeRequestId.make("question"),
      nodeId: NodeId.make("queue:node:129"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: at,
      resolvedAt: null,
    });
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES ('question', 'queue', 'queue:node:129', 'user_input', 'pending', ${stamp}, ${requestJson})`;
    const secretRun = RunId.make("running:129");
    const secretNode = NodeId.make("running:node:129");
    yield* projection.apply({
      id: EventId.make("secret"),
      type: "turn-item.updated",
      threadId: ThreadId.make("running"),
      runId: secretRun,
      nodeId: secretNode,
      driver: ProviderDriverKind.make("codex"),
      occurredAt: at,
      payload: {
        id: TurnItemId.make("secret"),
        threadId: ThreadId.make("running"),
        runId: secretRun,
        nodeId: secretNode,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "waiting",
        title: null,
        startedAt: at,
        completedAt: null,
        updatedAt: at,
        type: "secret_request",
        label: "Test credential",
        reason: "Test pending input",
        secretStatus: "pending",
      },
    });
    for (const location of ["active", "archive"] as const) {
      const full = yield* projection.getShellSnapshot({ threadIds: ids, location });
      const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const narrow = yield* projection
        .getShellSnapshot({ threadIds: ids, location, summaryOnly: true })
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) => {
            statements.push(statement.compile());
            return Effect.succeed(statement);
          }),
        );
      const allFull = [...full.threads, ...full.archivedThreads];
      const allNarrow = [...narrow.threads, ...narrow.archivedThreads];
      const serialize = (shell: (typeof allFull)[number]) =>
        shellSummary(shell, { origin: "automation", nativeSessionId: "native-id" });
      assert.deepEqual(allNarrow.map(serialize), allFull.map(serialize));
      assert.isTrue(allFull.some((shell) => shell.itemCount > 0));
      assert.isTrue(
        allNarrow.every((shell) => shell.itemCount === 0 && shell.latestVisibleMessage === null),
      );
      if (location === "active") {
        assert.equal(
          allNarrow.find((shell) => shell.id === "limit-queue")?.latestRunId,
          "limit-queue:129",
        );
        assert.equal(
          allNarrow.find((shell) => shell.id === "limit-cancel")?.lastError,
          "Plan limit reached.",
        );
        assert.equal(
          allNarrow.find((shell) => shell.id === "running")?.pendingRuntimeRequest?.id,
          "secret",
        );
        assert.equal(
          allNarrow.find((shell) => shell.id === "queue")?.pendingRuntimeRequest?.id,
          "question",
        );
      }
      const statement = statements.find(([text]) => text.includes("WITH shell_runs"));
      assert.isDefined(statement);
      const [text, bindings] = statement!;
      assert.notMatch(
        statements.map(([query]) => query).join("\n"),
        /FROM ardud_shell_item_counts|FROM orchestration_v2_projection_messages|FROM orchestration_v2_projection_plans|FROM orchestration_v2_projection_provider_threads/,
      );
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${text}`, bindings);
      const details = plan.map((row) => row.detail).join("\n");
      assert.match(details, /USING INDEX ardud_caller_active_run_idx/);
      assert.match(details, /USING INDEX ardud_shell_activity_run_idx/);
      assert.notMatch(details, /MATERIALIZE shell_runs|SCAN orchestration_v2_projection_runs/);
    }
  }).pipe(Effect.provide(layer)),
);
