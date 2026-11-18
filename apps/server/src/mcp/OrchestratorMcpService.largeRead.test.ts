import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Statement from "effect/sql/Statement";
import * as SqlClient from "effect/sql/SqlClient";
import {
  HISTORY_TABLES,
  historyViewSql,
  liveColumns,
} from "../ardud/persistence/historyArchiveSql.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import { McpCall } from "../ardud/analytics/McpCall.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const storage = ProjectionStore.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ROBOB_SQL_STATEMENT_METRICS: "true" } })),
  ),
);

it.live(
  "reads small pages from 50 and 6200 item worker histories",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      for (const size of [50, 6200]) {
        const threadId = ThreadId.make(`thread:large-read:${size}`);
        const shell = liveThreadShell(threadId);
        const now = shell.createdAt;
        yield* store.apply({
          id: EventId.make(`create:${size}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: idleThreadProjection(shell).thread,
        });
        const runs: OrchestrationV2Run[] = Array.from({ length: 5 }, (_, ordinal) => ({
          id: RunId.make(`${threadId}:run:${ordinal}`),
          threadId,
          ordinal: ordinal + 1,
          providerInstanceId: shell.providerInstanceId,
          modelSelection: shell.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`${threadId}:input:${ordinal}`),
          rootNodeId: NodeId.make(`${threadId}:root:${ordinal}`),
          activeAttemptId: null,
          status: "completed",
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
        for (let ordinal = 0; ordinal < size; ordinal++) {
          const run = runs[Math.min(4, Math.floor((ordinal * 5) / size))]!;
          const messageId = MessageId.make(`${threadId}:message:${ordinal}`);
          const base = {
            id: TurnItemId.make(`${threadId}:item:${String(ordinal).padStart(5, "0")}`),
            threadId,
            ordinal,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            status: "completed" as const,
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          };
          const text = `output ${ordinal} ` + "command output line\n".repeat(300);
          const actual: OrchestrationV2TurnItem =
            ordinal % 20 === 0
              ? ordinal % 40 === 0
                ? {
                    ...base,
                    type: "user_message",
                    messageId,
                    text,
                    attachments: [],
                    inputIntent: "turn_start",
                    createdBy: "user",
                    creationSource: "web",
                  }
                : {
                    ...base,
                    type: "assistant_message",
                    messageId,
                    text,
                    attachments: [],
                    streaming: false,
                  }
              : ordinal % 2 === 0
                ? {
                    ...base,
                    type: "dynamic_tool",
                    toolName: "exec_command",
                    input: { cmd: "rg example" },
                    output: text,
                  }
                : {
                    ...base,
                    type: "command_execution",
                    input: "rg example",
                    output: text,
                    exitCode: 0,
                  };
          yield* store.apply({
            id: EventId.make(`item:${actual.id}`),
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: actual,
          });
          if (actual.type === "user_message" || actual.type === "assistant_message")
            yield* store.apply({
              id: EventId.make(`message:${messageId}`),
              type: "message.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: messageId,
                threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                role: actual.type === "user_message" ? "user" : "assistant",
                text,
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
                createdBy: "user",
                creationSource: "web",
              },
            });
        }
      }
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        ServerSettings.layerTest(),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => store.getThreadShell(id).pipe(Effect.orDie),
          getProjectThreadRecords: (input, fields, filter) =>
            store.getThreadRecords(input.threadId, fields, filter).pipe(Effect.orDie),
          getThreadRecords: (id, fields, filter) =>
            store.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
          getTimelinePage: (id, options) => store.getTimelinePage(id, options).pipe(Effect.orDie),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapters.ProviderAdapterRegistryV2)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        for (let sample = 0; sample < 3; sample++)
          for (const size of [50, 6200])
            for (const view of ["messages", "activity"] as const) {
              const spans: Tracer.NativeSpan[] = [];
              const tracer = Tracer.make({
                span: (options) => {
                  const span = new Tracer.NativeSpan(options);
                  spans.push(span);
                  return span;
                },
              });
              const state: McpCall["Service"] = {
                callerResolved: false,
                callerResolveMs: 0,
                readerLane: "background",
                phase: "handler",
                saved: "unknown",
                threadRead: { readerWaitMs: 0, queryMs: 0, renderMs: 0, threadReadStages: [] },
              };
              const result = yield* service
                .readThread(
                  {
                    environmentId: EnvironmentId.make("large-read"),
                    requestNamespace: "large-read",
                    thread: undefined,
                    client: undefined,
                    capabilities: new Set(["orchestration"]),
                    issuedAt: 1,
                  },
                  {
                    threadId: ThreadId.make(`thread:large-read:${size}`),
                    view,
                    limit: view === "messages" ? 5 : 100,
                    maxCharsPerItem: 600,
                  },
                )
                .pipe(
                  Effect.provideService(McpCall, state),
                  Effect.withTracer(tracer),
                  Effect.provideService(Statement.SpanPropagationEnabled, true),
                );
              assert.equal(result.thread.itemCount, size);
              assert.lengthOf(
                result.items,
                view === "messages" ? Math.min(5, Math.ceil(size / 20)) : Math.min(100, size),
              );
              const queries = spans.filter((span) => span.name === "sqlite");
              assert.isAbove(queries.length, 0);
              assert.isAtMost(
                Math.max(...queries.map((span) => Number(span.attributes.get("db.rows_returned")))),
                view === "messages" ? 6 : 101,
                "page SQL returned rows outside page bound",
              );
              const hydration = queries.filter((span) =>
                String(span.attributes.get("db.query.text")).includes(
                  "SELECT payload_json FROM orchestration_v2_projection_messages",
                ),
              );
              assert.lengthOf(hydration, 1);
              const query = String(hydration[0]!.attributes.get("db.query.text"));
              const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, [
                result.thread.threadId,
                "[]",
              ]);
              // A thread/created-at range returns the same rows but visits every
              // stored message. The primary-key SEARCH bounds physical hydration.
              assert.isTrue(
                plan.some((row) =>
                  row.detail.includes(
                    "USING INDEX sqlite_autoindex_orchestration_v2_projection_messages_1 (message_id=?)",
                  ),
                ),
                "message hydration must use ID point lookups",
              );
              yield* Effect.log(
                JSON.stringify(
                  {
                    sample,
                    size,
                    view,
                    metrics: state.threadRead,
                    queries: spans
                      .filter((s) => s.name === "sqlite")
                      .map((s) => ({
                        rows: s.attributes.get("db.rows_returned"),
                      })),
                  },
                  (_, value) => (typeof value === "bigint" ? value.toString() : value),
                ),
              );
            }
        // Poison the type beyond the page/lookahead. A full window materialization
        // evaluates it and fails; a streaming page never touches those tail rows.
        yield* sql.unsafe(
          historyViewSql(HISTORY_TABLES[1]).replace(
            "ardud_history_turn_items",
            "ardud_read_probe_source",
          ),
        );
        yield* sql`DROP VIEW ardud_history_turn_items`;
        const columns = [
          "rowid",
          ...liveColumns("orchestration_v2_projection_turn_items").split(", "),
        ];
        yield* sql.unsafe(
          `CREATE TEMP VIEW ardud_history_turn_items AS SELECT ${columns
            .map((column) =>
              column === "type"
                ? "CASE WHEN thread_id = 'thread:large-read:6200' AND ordinal >= 200 THEN json_extract('unread-tail', '$') ELSE type END AS type"
                : column,
            )
            .join(", ")} FROM ardud_read_probe_source`,
        );
        for (const view of ["messages", "activity"] as const) {
          const page = yield* service.readThread(
            {
              environmentId: EnvironmentId.make("large-read"),
              requestNamespace: "large-read",
              thread: undefined,
              client: undefined,
              capabilities: new Set(["orchestration"]),
              issuedAt: 1,
            },
            {
              threadId: ThreadId.make("thread:large-read:6200"),
              view,
              limit: view === "messages" ? 5 : 100,
              maxCharsPerItem: 600,
            },
          );
          assert.equal(page.thread.itemCount, 6200);
          assert.equal(page.nextPosition, view === "messages" ? 80 : 99);
          assert.isTrue(page.hasMore);
        }
      }).pipe(
        Effect.provide(
          OrchestratorMcpService.layer.pipe(
            Layer.provide(McpProviderSessions.layer),
            Layer.provide(dependencies),
          ),
        ),
      );
    }).pipe(Effect.provide(storage)),
  { timeout: 120000 },
);
