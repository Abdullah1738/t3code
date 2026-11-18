import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
import { threadReadIndexes } from "../ardud/persistence/threadReadIndexes.ts";
import { liveColumns } from "../ardud/persistence/historyArchiveSql.ts";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

const indexedDatabase = Layer.effect(
  SqlClient.SqlClient,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of [
      ...threadReadIndexes("main", "orchestration_v2_projection_turn_items"),
      ...threadReadIndexes("ardud_archive", "ardud_turn_items"),
    ])
      yield* sql.unsafe(statement);
    return sql;
  }),
).pipe(Layer.provide(Sqlite.layerMemory));

const layer = (ready: boolean) =>
  ProjectionStore.layer.pipe(
    Layer.provideMerge(ready ? indexedDatabase : Sqlite.layerMemory),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { ROBOB_SQL_STATEMENT_METRICS: "true" } }),
      ),
    ),
  );

it.effect.each(["ready", "main", "ardud_archive"] as const)(
  "bounds local timeline rows and preserves visibility, global positions and item lookup (indexes: %s)",
  (firstReady) =>
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
      if (firstReady !== "ready") {
        const sql = yield* SqlClient.SqlClient;
        const expectBuildingPage = Effect.fn("test.expectBuildingPage")(function* (
          main: boolean,
          archive: boolean,
        ) {
          spans.length = 0;
          const result = yield* store
            .getTimelinePage(threadId, { view: "activity", limit: 1 })
            .pipe(
              Effect.withTracer(tracer),
              Effect.provideService(Statement.SpanPropagationEnabled, true),
            );
          assert.equal(result.totalItems, visible.length);
          assert.deepEqual(
            result.items.map((row) => row.item.id),
            [visible[0]!.id],
          );
          assert.lengthOf(
            spans.filter((span) => span.name === "readThreadIndexAvailability"),
            1,
          );
          const statements = spans.filter((span) => span.name === "sqlite");
          assert.lengthOf(statements, 4);
          assert.lengthOf(
            statements.filter((span) =>
              String(span.attributes.get("db.query.text")).includes("sqlite_schema"),
            ),
            1,
          );
          const count = String(
            statements
              .find((span) =>
                String(span.attributes.get("db.query.text")).includes("AS total_items"),
              )
              ?.attributes.get("db.query.text"),
          );
          assert.equal(
            count.includes(
              "main.orchestration_v2_projection_turn_items i INDEXED BY ardud_thread_read_queued_idx",
            ),
            main,
          );
          assert.equal(
            count.includes(
              "ardud_archive.ardud_turn_items i INDEXED BY ardud_thread_read_queued_idx",
            ),
            archive,
          );
        });
        yield* expectBuildingPage(false, false);
        for (const schema of [
          firstReady,
          firstReady === "main" ? "ardud_archive" : "main",
        ] as const) {
          const statements = threadReadIndexes(
            schema,
            schema === "main" ? "orchestration_v2_projection_turn_items" : "ardud_turn_items",
          );
          for (const statement of statements.slice(0, 2)) yield* sql.unsafe(statement);
          yield* expectBuildingPage(
            schema === "ardud_archive" && firstReady === "main",
            schema === "main" && firstReady === "ardud_archive",
          );
          yield* sql.unsafe(statements[2]!);
          yield* expectBuildingPage(
            schema === "main" || firstReady === "main",
            schema === "ardud_archive" || firstReady === "ardud_archive",
          );
        }
      }
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
          assert.isFalse(spans.some((span) => span.name === "readThreadIndexAvailability"));
          assert.isFalse(
            sql.some((span) =>
              String(span.attributes.get("db.query.text")).includes("sqlite_schema"),
            ),
          );
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
    }).pipe(Effect.provide(layer(firstReady === "ready"))),
);

it.live.each(["page", "caller"] as const)(
  "keeps index hints valid when a %s snapshot predates another reader's promotion",
  (snapshotOwner) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "timeline-index-snapshot-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const pinned = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let pauseNext = false;
        const pauseInSnapshot = Effect.gen(function* () {
          yield* sql`SELECT rootpage FROM main.sqlite_schema LIMIT 1`;
          yield* sql`SELECT rootpage FROM ardud_archive.sqlite_schema LIMIT 1`;
          yield* Deferred.succeed(pinned, undefined);
          yield* Deferred.await(resume);
        });
        const delayedSql = new Proxy(sql, {
          get(target, key, receiver) {
            if (key !== "withTransaction") return Reflect.get(target, key, receiver);
            return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.suspend(() => {
                const pause = pauseNext;
                pauseNext = false;
                return sql.withTransaction(
                  pause ? Effect.andThen(pauseInSnapshot, effect) : effect,
                );
              });
          },
        });
        yield* Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const threadId = ThreadId.make("thread:snapshot-indexes");
          const shell = liveThreadShell(threadId);
          yield* store.apply({
            id: EventId.make("snapshot:create"),
            type: "thread.created",
            threadId,
            occurredAt: shell.createdAt,
            payload: idleThreadProjection(shell).thread,
          });
          const page = store.getTimelinePage(threadId, { view: "activity", limit: 1 });
          pauseNext = snapshotOwner === "page";
          const older = yield* (
            snapshotOwner === "caller"
              ? sql.withTransaction(Effect.andThen(pauseInSnapshot, page))
              : page
          ).pipe(
            NodeSqliteClient.requireReader,
            NodeSqliteClient.foregroundReads,
            Effect.forkChild,
          );
          yield* Deferred.await(pinned);
          for (const statement of [
            ...threadReadIndexes("main", "orchestration_v2_projection_turn_items"),
            ...threadReadIndexes("ardud_archive", "ardud_turn_items"),
          ])
            yield* sql.unsafe(statement);
          const newer = yield* page.pipe(
            NodeSqliteClient.requireReader,
            NodeSqliteClient.foregroundReads,
          );
          assert.equal(newer.totalItems, 0);
          yield* Deferred.succeed(resume, undefined);
          assert.deepEqual(yield* Fiber.join(older), newer);
          const spans: Tracer.NativeSpan[] = [];
          const tracer = Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);
              spans.push(span);
              return span;
            },
          });
          assert.deepEqual(
            yield* page.pipe(
              NodeSqliteClient.requireReader,
              NodeSqliteClient.foregroundReads,
              Effect.withTracer(tracer),
            ),
            newer,
          );
          assert.isFalse(spans.some((span) => span.name === "readThreadIndexAvailability"));
        }).pipe(
          Effect.provide(ProjectionStore.layer),
          Effect.provideService(SqlClient.SqlClient, delayedSql),
        );
      }).pipe(Effect.provide(Sqlite.layerFromPath(path.join(directory, "state.sqlite"))));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("constructs before archive attachment and discovers indexes built after attachment", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "timeline-index-attachment-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const databases = yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
      const archive = databases.find((row) => row.name === "ardud_archive")!.file;
      yield* sql`DETACH DATABASE ardud_archive`;
      yield* Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        yield* sql`ATTACH DATABASE ${archive} AS ardud_archive`;
        const threadId = ThreadId.make("thread:late-archive");
        const shell = liveThreadShell(threadId);
        yield* store.apply({
          id: EventId.make("late-archive:create"),
          type: "thread.created",
          threadId,
          occurredAt: shell.createdAt,
          payload: idleThreadProjection(shell).thread,
        });
        const spans: Tracer.NativeSpan[] = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const page = store
          .getTimelinePage(threadId, { view: "activity", limit: 1 })
          .pipe(Effect.withTracer(tracer));
        assert.equal((yield* page).totalItems, 0);
        assert.lengthOf(
          spans.filter((span) => span.name === "readThreadIndexAvailability"),
          1,
        );
        for (const statement of [
          ...threadReadIndexes("main", "orchestration_v2_projection_turn_items"),
          ...threadReadIndexes("ardud_archive", "ardud_turn_items"),
        ])
          yield* sql.unsafe(statement);
        spans.length = 0;
        assert.equal((yield* page).totalItems, 0);
        assert.lengthOf(
          spans.filter((span) => span.name === "readThreadIndexAvailability"),
          1,
        );
        spans.length = 0;
        assert.equal((yield* page).totalItems, 0);
        assert.isFalse(spans.some((span) => span.name === "readThreadIndexAvailability"));
      }).pipe(Effect.provide(ProjectionStore.layer));
    }).pipe(Effect.provide(Sqlite.layerFromPath(path.join(directory, "state.sqlite"))));
  }).pipe(Effect.provide(NodeServices.layer)),
);
