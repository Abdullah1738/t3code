import { assert, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";

const layerTest = Layer.mergeAll(
  ThreadSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: { readonly archivedAt?: DateTime.Utc; readonly deletedAt?: DateTime.Utc } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: { readonly minute?: number; readonly streaming?: boolean } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});

it.layer(layerTest)("ThreadSearch", (it) => {
  it.effect("returns one finished user or assistant match per active thread", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.make({ sliceSize: 2 });
      const project = ProjectId.make("project:search");
      const deletedProject = ProjectId.make("project:search-deleted");
      yield* createProject(project);
      yield* createProject(deletedProject);
      yield* Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
        projects.apply({
          sequence: 0,
          eventId: EventId.make("deleted:project"),
          aggregateKind: "project",
          aggregateId: deletedProject,
          occurredAt: DateTime.formatIso(at(2)),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId: deletedProject, deletedAt: DateTime.formatIso(at(2)) },
        }),
      );

      const both = ThreadId.make("thread:both");
      const assistantOnly = ThreadId.make("thread:assistant");
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        thread(both, project),
        message(both, "both-assistant", "assistant", "needle from the answer", { minute: 3 }),
        message(both, "both-user-old", "user", "older needle question", { minute: 1 }),
        message(both, "both-user-new", "user", "newer needle question", { minute: 2 }),
        thread(assistantOnly, project),
        message(assistantOnly, "assistant-only", "assistant", "needle in an answer"),
        message(assistantOnly, "assistant-streaming", "user", "needle still typing", {
          streaming: true,
        }),
        message(assistantOnly, "assistant-system", "system", "needle system prompt"),
        thread(ThreadId.make("thread:archived"), project, { archivedAt: at(1) }),
        message(ThreadId.make("thread:archived"), "archived", "user", "needle archived"),
        thread(ThreadId.make("thread:deleted"), project, { deletedAt: at(1) }),
        message(ThreadId.make("thread:deleted"), "deleted", "user", "needle deleted"),
        thread(ThreadId.make("thread:orphaned"), deletedProject),
        message(ThreadId.make("thread:orphaned"), "orphaned", "user", "needle orphaned"),
      ];
      yield* Effect.forEach(events, projections.apply, { discard: true });

      const result = yield* search.search({ query: "NEEDLE", limit: 20 });
      assert.deepEqual(
        result.matches.map((match) => [match.threadId, match.source, match.snippet]),
        [
          [both, "user", "newer needle question"],
          [assistantOnly, "assistant", "needle in an answer"],
        ],
      );
      assert.equal(result.complete, true);
      assert.equal(result.searchedBackTo, undefined);
      assert.lengthOf((yield* search.search({ query: "needle", limit: 1 })).matches, 1);
      assert.deepEqual((yield* search.search({ query: "ne%le" })).matches, []);
    }),
  );

  it.effect("reports an unreadable match as a decode failure", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-corrupt");
      const threadId = ThreadId.make("thread:corrupt");
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "corrupt", "user", "20260927")],
        projections.apply,
        { discard: true },
      );
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET payload_json = json_set(payload_json, '$.text', 20260927)
        WHERE message_id = 'corrupt'
      `;

      const error = yield* Effect.flip(search.search({ query: "0260927" }));
      assert.equal(error.operation, "decode");
    }),
  );
});

it.effect("searches on the reader worker while the writer is busy", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-search-" });
    const layerFile = Layer.mergeAll(
      ThreadSearch.layer,
      ProjectionStore.layer,
      ProjectStore.layer,
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-reader");
      const threadId = ThreadId.make("thread:reader");
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "reader", "user", "needle on the reader")],
        projections.apply,
        { discard: true },
      );

      const writerHeld = yield* Deferred.make<void>();
      const releaseWriter = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(writerHeld, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWriter)),
          ),
        ),
      );
      yield* Deferred.await(writerHeld);
      const result = yield* search.search({ query: "needle" });
      yield* Deferred.succeed(releaseWriter, undefined);
      yield* Fiber.join(writer);

      assert.deepEqual(
        result.matches.map((match) => match.threadId),
        [threadId],
      );
    }).pipe(Effect.provide(layerFile));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.layer(layerTest)("bounded ThreadSearch", (it) => {
  it.effect("returns matches and the oldest examined timestamp after a zero budget slice", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const project = ProjectId.make("project:budget");
      const threadId = ThreadId.make("thread:budget");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(threadId, project),
          message(threadId, "budget-old", "user", "needle old", { minute: 1 }),
          message(threadId, "budget-new", "assistant", "needle new", { minute: 2 }),
        ],
        projections.apply,
        { discard: true },
      );
      const search = yield* ThreadSearch.make({ sliceSize: 1, budgetMs: 0 });
      const result = yield* search.search({ query: "needle" });
      assert.equal(result.complete, false);
      assert.equal(result.searchedBackTo, DateTime.formatIso(at(2)));
      assert.deepEqual(
        result.matches.map((m) => m.snippet),
        ["needle new"],
      );
      const noMatch = yield* search.search({ query: "absent" });
      assert.equal(noMatch.complete, false);
      assert.equal(noMatch.searchedBackTo, DateTime.formatIso(at(2)));
      assert.deepEqual(noMatch.matches, []);
    }),
  );

  it.effect(
    "keeps SQLite ranking with out-of-order inserts, ties, filters and literal LIKE characters",
    () =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const project = ProjectId.make("project:parity");
        const other = ProjectId.make("project:parity-other");
        yield* createProject(project);
        yield* createProject(other);
        const a = ThreadId.make("parity:a");
        const b = ThreadId.make("parity:b");
        const c = ThreadId.make("parity:c");
        const events = [
          thread(a, project),
          thread(b, project),
          thread(c, other),
          message(a, "parity-a-new", "assistant", "needle answer", { minute: 9 }),
          message(b, "parity-b", "user", "needle user % _ !", { minute: 8 }),
          message(a, "parity-a-z", "user", "needle tied z % _ !", { minute: 2 }),
          message(a, "parity-a-\uE000", "user", "needle unicode BMP % _ !", { minute: 3 }),
          message(a, "parity-a-\u{10000}", "user", "needle unicode astral % _ !", { minute: 3 }),
          message(a, "parity-a-a", "user", "needle tied a % _ !", { minute: 2 }),
          message(c, "parity-c", "user", "needle other % _ !", { minute: 3 }),
          message(a, "parity-a-old", "user", "needle oldest", { minute: 1 }),
          thread(ThreadId.make("parity:archived"), project, { archivedAt: at(1) }),
          message(ThreadId.make("parity:archived"), "parity-archived", "user", "needle % _ !"),
        ];
        yield* Effect.forEach(events, projections.apply, { discard: true });
        yield* sql`UPDATE orchestration_v2_projection_threads SET updated_at = ${DateTime.formatIso(at(10))} WHERE thread_id = ${a}`;
        const search = yield* ThreadSearch.make({ sliceSize: 1 });
        for (const query of ["needle", "%", "_", "!", "% _ !", "NEEDLE", "ne%le", "ne_dle", "!!"]) {
          const pattern = `%${query.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
          for (const limit of [1, 50]) {
            const expected = yield* sql<{
              threadId: string;
              source: string;
              snippet: string;
              messageCreatedAt: string;
            }>`
            WITH ranked AS (
              SELECT t.thread_id AS threadId, m.role AS source,
                json_extract(m.payload_json, '$.text') AS snippet,
                m.created_at AS messageCreatedAt, t.updated_at,
                CASE m.role WHEN 'user' THEN 0 ELSE 1 END AS match_rank,
                ROW_NUMBER() OVER (PARTITION BY t.thread_id ORDER BY
                  CASE m.role WHEN 'user' THEN 0 ELSE 1 END, m.created_at DESC, m.message_id ASC) AS rn
              FROM orchestration_v2_projection_messages m
              JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
              JOIN projection_projects p ON p.project_id = t.project_id
              WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND p.deleted_at IS NULL
                AND m.streaming = 0 AND m.role IN ('user','assistant')
                AND json_extract(m.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
            ) SELECT threadId, source, snippet, messageCreatedAt FROM ranked WHERE rn = 1
              ORDER BY match_rank, updated_at DESC, threadId ASC LIMIT ${limit}
          `;
            const result = yield* search.search({ query, limit });
            assert.equal(result.complete, true);
            expect(
              result.matches.map(({ threadId, source, snippet, messageCreatedAt }) => ({
                threadId,
                source,
                snippet,
                messageCreatedAt,
              })),
            ).toEqual(expected);
          }
        }
        const scoped = yield* search.search({ query: "needle", projectId: other, limit: 1 });
        assert.deepEqual(
          scoped.matches.map((m) => m.threadId),
          [c],
        );
      }),
  );
});

it.effect("hands background slot 0 to a queued control read between search slices", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-search-fairness-" });
    const layerFile = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer).pipe(
      Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const project = ProjectId.make("project:fairness");
      const threadId = ThreadId.make("thread:fairness");
      yield* createProject(project);
      yield* projections.apply(thread(threadId, project));
      for (let i = 0; i < 12; i++) {
        yield* projections.apply(message(threadId, `fairness-${i}`, "user", `needle ${i}`));
      }
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let first = true;
      // Pause inside the first real read transaction so the control read is
      // queued behind search on the live pool's single background slot.
      const instrumented = new Proxy(sql, {
        get(target, key) {
          if (key !== "withTransaction") return Reflect.get(target, key);
          return <A, E, R>(body: Effect.Effect<A, E, R>) =>
            target.withTransaction(
              Effect.gen(function* () {
                if (first) {
                  first = false;
                  yield* Deferred.succeed(held, undefined);
                  yield* Deferred.await(release);
                }
                return yield* body;
              }),
            );
        },
      });
      const search = yield* ThreadSearch.make({ sliceSize: 1 }).pipe(
        Effect.provideService(SqlClient.SqlClient, instrumented),
      );
      const order: string[] = [];
      const searching = yield* Effect.forkChild(
        search.search({ query: "needle" }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              order.push("search");
            }),
          ),
        ),
      );
      yield* Deferred.await(held);
      const controlDone = yield* Deferred.make<void>();
      const control = yield* Effect.forkChild(
        sql`SELECT 1`.pipe(
          NodeSqliteClient.readOnly,
          NodeSqliteClient.backgroundReads,
          Effect.tap(() =>
            Effect.sync(() => {
              order.push("control");
            }),
          ),
          Effect.andThen(Deferred.succeed(controlDone, undefined)),
        ),
        { startImmediately: true },
      );
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(controlDone);
      yield* Fiber.join(control);
      const result = yield* Fiber.join(searching);
      assert.equal(result.complete, true);
      assert.deepEqual(order, ["control", "search"]);
    }).pipe(Effect.provide(layerFile));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
