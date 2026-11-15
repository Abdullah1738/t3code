import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Analytics from "../../analytics/Analytics.ts";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  KanbanCard,
  KanbanRelease,
  KanbanCardId,
  KanbanBoardId,
  KanbanDiscussionId,
  KanbanScriptId,
  KanbanError,
  KanbanMessage,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type KanbanActor,
  type KanbanAskChange,
  type KanbanBoard,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Result from "effect/Result";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import { OrchestratorProjectionError } from "../../../orchestration-v2/Orchestrator.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as KanbanService from "../engine/KanbanService.ts";
import * as KanbanModels from "../engine/models.ts";
import { KanbanThreads, KanbanThreadError } from "../engine/threads.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import { opencodeTestProvider } from "../engine/testProviders.ts";
import * as KanbanHandlers from "./handlers.ts";
import { boardReleaseSummary, compactBoard } from "../engine/boardReplies.ts";
import { COMPACT_READ_CHARS } from "../../compactRead.ts";
import * as McpBoardReplies from "../engine/mcpBoardReplies.ts";
import { KanbanToolkit } from "./tools.ts";
import { ModelBody } from "../http.ts";

// Writes check the caller is the thread's live provider; the fake runs on codex.
const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const decodeKanbanCard = Schema.decodeUnknownEffect(KanbanCard);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const call = (threadId: ThreadId, name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.map((result) => ({
      isError: result.isError === true,
      text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      structured: (result.structuredContent ?? {}) as Record<string, unknown>,
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, threadCaller(threadId)),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

// Threads launch idle; `running` keeps a work thread's slot between cards.
const fakeThreads = (
  dbPath?: string,
  editCardError?: KanbanError,
  postToCardError?: KanbanError,
  launchGate?: { held: Deferred.Deferred<void>; release: Deferred.Deferred<void> },
  replyControl?: {
    mode: "encode" | "slow" | "budget" | "conflict" | "pre-save";
    saved: Deferred.Deferred<void>;
    enabled?: () => boolean;
  },
  delivery?: {
    readonly findExisting: boolean;
    readonly send: KanbanThreads["Service"]["send"];
    readonly queuedRuns?: KanbanThreads["Service"]["queuedRuns"];
    readonly cancelQueued?: KanbanThreads["Service"]["cancelQueued"];
  },
) => {
  const running = new Set<string>();
  const queued = new Set<string>();
  const rejectSends = new Set<string>();
  const parents = new Map<ThreadId, ThreadId>();
  const missing = new Set<ThreadId>();
  const deleted = new Set<ThreadId>();
  const unreadable = new Set<ThreadId>();
  const models = new Map<ThreadId, ModelSelection>();
  let launched = 0;
  const launches: Array<string> = [];
  const views: Array<string> = [];
  const latestRuns = new Map<
    ThreadId,
    NonNullable<Effect.Success<ReturnType<KanbanThreads["Service"]["latestRun"]>>>
  >();
  const targetViews = new Map<
    ThreadId,
    Partial<import("../engine/threads.ts").KanbanThreadView> | null
  >();
  const interrupts: ThreadId[] = [];
  const viewControl = { beforeRead: (_threadId: ThreadId): Effect.Effect<void> => Effect.void };
  const queueControl = { beforeRead: (_threadId: ThreadId): Effect.Effect<void> => Effect.void };
  const callerControl = { beforeRead: (): Effect.Effect<void> => Effect.void };
  const storeControl: {
    afterBoardWrite?: () => Effect.Effect<void>;
    beforeThreadLink?: () => Effect.Effect<void>;
    beforeClaimContext?: () => Effect.Effect<void>;
    beforeCardWrite?: () => Effect.Effect<void, KanbanStore.KanbanStoreError>;
    beforeCardEvent?: (
      event: KanbanStore.NewCardEvent,
    ) => Effect.Effect<void, KanbanStore.KanbanStoreError>;
  } = {};
  const storeLayer = Layer.effect(
    KanbanStore.KanbanStore,
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      return KanbanStore.KanbanStore.of({
        ...store,
        threadLink: (id) =>
          Effect.suspend(() => storeControl.beforeThreadLink?.() ?? Effect.void).pipe(
            Effect.andThen(store.threadLink(id)),
          ),
        putCard: (card) =>
          Effect.suspend(() => storeControl.beforeCardWrite?.() ?? Effect.void).pipe(
            Effect.andThen(store.putCard(card)),
          ),
        putBoardWithPools: (...args) =>
          store
            .putBoardWithPools(...args)
            .pipe(
              Effect.tap(() =>
                Effect.suspend(() => storeControl.afterBoardWrite?.() ?? Effect.void),
              ),
            ),
        addCardEvent: (event, applicationId) =>
          Effect.suspend(() => storeControl.beforeCardEvent?.(event) ?? Effect.void).pipe(
            Effect.andThen(store.addCardEvent(event, applicationId)),
          ),
      });
    }),
  ).pipe(Layer.provide(KanbanStore.layer));
  const view: KanbanThreads["Service"]["view"] = (threadId) =>
    Effect.suspend(() => viewControl.beforeRead(threadId)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          views.push(threadId);
          if (targetViews.get(threadId) === null) return null;
          return {
            threadId,
            projectId: ProjectId.make("project-1"),
            title: "thread",
            state: running.has(threadId) ? ("running" as const) : ("idle" as const),
            updatedAt: "2026-10-26T08:00:00.000Z",
            quietSince: "2026-10-26T08:00:00.000Z",
            runStartedAt: null,
            lastActivityAt: null,
            backgroundWork: 0,
            prWatches: 0,
            prs: [],
            archived: false,
            ...targetViews.get(threadId),
          };
        }),
      ),
    );
  const threads = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      pendingUserInputs: () => Effect.succeed([]),
      claimContext: (threadId) =>
        Effect.suspend(() => storeControl.beforeClaimContext?.() ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => ({
              projectId: ProjectId.make("project-1"),
              model: models.get(threadId)!,
            })),
          ),
        ),
      view,
      find: delivery?.findExisting ? view : () => Effect.succeed(null),
      lastFailure: () => Effect.succeed(null),
      findLastFailure: () => Effect.succeed(null),
      latestRun: (threadId) => Effect.sync(() => latestRuns.get(threadId) ?? null),
      runSettled: () => Effect.succeed(true),
      compactRun: () => Effect.succeed(null),
      launch: (input) => {
        const launch = Effect.sync(() => {
          launches.push(input.text);
          const threadId = ThreadId.make(`thread-${++launched}`);
          models.set(threadId, input.model);
          return threadId;
        });
        return launchGate
          ? Deferred.succeed(launchGate.held, undefined).pipe(
              Effect.andThen(Deferred.await(launchGate.release)),
              Effect.andThen(launch),
            )
          : launch;
      },
      send:
        delivery?.send ??
        ((input) =>
          rejectSends.has(input.threadId)
            ? Effect.fail(new KanbanThreadError({ operation: "send", detail: "send failed" }))
            : Effect.void),
      model: (threadId) => Effect.sync(() => models.get(threadId) ?? null),
      setModel: (threadId, model) =>
        Effect.sync(() => {
          models.set(threadId, model);
        }),
      withdraw: () => Effect.void,
      queuedRuns:
        delivery?.queuedRuns ??
        ((threadId) =>
          Effect.suspend(() => queueControl.beforeRead(threadId)).pipe(
            Effect.andThen(
              Effect.sync(() => (queued.has(threadId) ? [{ status: "queued" } as never] : [])),
            ),
          )),
      cancelQueued: delivery?.cancelQueued ?? (() => Effect.succeed(false)),
      interrupt: (threadId) =>
        Effect.sync(() => {
          interrupts.push(threadId);
        }),
    }),
  );
  const boardFilesLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-kanban-tools-test-",
  }).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(ServerSettings.layerTest()));
  const reply = <A extends object>(card: A): Effect.Effect<A, KanbanError> =>
    replyControl === undefined || replyControl.enabled?.() === false
      ? Effect.succeed(card)
      : Deferred.succeed(replyControl.saved, undefined).pipe(
          Effect.andThen(
            Effect.suspend((): Effect.Effect<A, KanbanError> => {
              if (replyControl.mode === "conflict")
                return Effect.fail(
                  new KanbanError({
                    code: "conflict",
                    detail:
                      "Board changed during this operation. Re-read its state before retrying.",
                  }),
                );
              if (replyControl.mode === "slow") return Effect.never;
              if (replyControl.mode === "budget")
                return Effect.succeed({ ...card, prompt: "x".repeat(6 * 1024 * 1024) });
              return Effect.sync(() =>
                Object.assign(card, {
                  brokenReply: {
                    toJSON() {
                      throw new Error("reply encoding failed");
                    },
                  },
                }),
              );
            }),
          ),
        );
  const serviceLayer =
    editCardError || postToCardError || replyControl
      ? Layer.effect(
          KanbanService.KanbanService,
          Effect.map(KanbanService.KanbanService, (service) =>
            KanbanService.KanbanService.of({
              ...service,
              editCard: (...args) =>
                editCardError
                  ? Effect.fail(editCardError)
                  : service.editCard(...args).pipe(Effect.flatMap(reply)),
              reportBug: (...args) =>
                replyControl?.mode === "pre-save" && replyControl.enabled?.() !== false
                  ? Deferred.succeed(replyControl.saved, undefined).pipe(
                      Effect.andThen(Effect.never),
                    )
                  : service.reportBug(...args).pipe(Effect.flatMap(reply)),
              moveCard: (...args) => service.moveCard(...args).pipe(Effect.flatMap(reply)),
              reviewResult: (...args) => service.reviewResult(...args).pipe(Effect.flatMap(reply)),
              markSubtask: (...args) => service.markSubtask(...args).pipe(Effect.flatMap(reply)),
              changeAsk: (...args) =>
                service.changeAsk(...args).pipe(
                  Effect.flatMap(reply),
                  Effect.map((card) =>
                    replyControl?.mode === "encode"
                      ? new Proxy(card, {
                          get(target, field, receiver) {
                            if (field === "number") throw new Error("ask summary encoding failed");
                            return Reflect.get(target, field, receiver);
                          },
                        })
                      : card,
                  ),
                ),
              postToCard: (...args) =>
                postToCardError
                  ? Effect.fail(postToCardError)
                  : replyControl?.mode === "pre-save"
                    ? Deferred.succeed(replyControl.saved, undefined).pipe(
                        Effect.andThen(Effect.never),
                      )
                    : service.postToCard(...args).pipe(Effect.flatMap(reply)),
              post: (...args) =>
                postToCardError
                  ? Effect.fail(postToCardError)
                  : replyControl?.mode === "pre-save"
                    ? Deferred.succeed(replyControl.saved, undefined).pipe(
                        Effect.andThen(Effect.never),
                      )
                    : service.post(...args).pipe(Effect.flatMap(reply)),
            }),
          ),
        ).pipe(Layer.provide(KanbanService.layer))
      : KanbanService.layer;
  const layer = McpHttpServer.toolkitRegistration(KanbanToolkit, KanbanHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getCallerRow: (threadId) =>
          Effect.suspend(() => callerControl.beforeRead()).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (unreadable.has(threadId))
                  return Effect.fail(new OrchestratorProjectionError({ threadId }));
                if (missing.has(threadId)) return Effect.succeed(null);
                const shell = liveThreadShell(threadId);
                return Effect.succeed({
                  ...shell,
                  deletedAt: deleted.has(threadId) ? shell.updatedAt : null,
                });
              }),
            ),
          ),
        getThreadShell: (threadId) =>
          Effect.suspend(() => callerControl.beforeRead()).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (unreadable.has(threadId)) {
                  return Effect.fail(new OrchestratorProjectionError({ threadId }));
                }
                if (missing.has(threadId)) return Effect.succeed(null);
                const parentThreadId = parents.get(threadId) ?? null;
                const shell = liveThreadShell(threadId);
                return Effect.succeed({
                  ...shell,
                  deletedAt: deleted.has(threadId) ? shell.updatedAt : null,
                  lineage: {
                    ...shell.lineage,
                    parentThreadId,
                    relationshipToParent: parentThreadId === null ? null : ("subagent" as const),
                  },
                });
              }),
            ),
          ),
      }),
    ),
    Layer.provideMerge(serviceLayer),
    Layer.provideMerge(ThreadCommandExecutor.layer),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(threads),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(dbPath ? Sqlite.layerFromPath(dbPath) : Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(boardFilesLayer),
  );
  return {
    running,
    queued,
    launches,
    parents,
    missing,
    deleted,
    unreadable,
    views,
    viewControl,
    queueControl,
    targetViews,
    latestRuns,
    interrupts,
    callerControl,
    storeControl,
    rejectSends,
    layer,
  };
};

const decodeRelease = Schema.decodeUnknownSync(KanbanRelease);
const owner: KanbanActor = { _tag: "owner" };
const decodeMessage = Schema.decodeUnknownEffect(KanbanMessage);
const decodeCard = Schema.decodeUnknownSync(KanbanCard);

it.live("card_flag saves its stalled reason while the board background reader is held", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "board-flag-reader-" });
    const state = Context.get(
      yield* Layer.build(
        NodeSqliteClient.layer({
          filename: path.join(directory, "boards.sqlite"),
          readerWorker: true,
          foregroundReaderSlots: 1,
          backgroundReaderSlots: 1,
        }),
      ),
      SqlClient.SqlClient,
    );
    yield* state`PRAGMA journal_mode = WAL`;
    yield* state`CREATE TABLE thread_link_probe (value INTEGER)`;
    const fake = fakeThreads();
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "flag-reader",
        name: "Flag reader",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const card = yield* kanban.createCard(board.id, { title: "Work", prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* state
        .withTransaction(
          state`SELECT * FROM thread_link_probe`.pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(NodeSqliteClient.readOnly, Effect.forkChild);
      yield* Deferred.await(held);
      fake.storeControl.beforeThreadLink = () =>
        state`SELECT * FROM thread_link_probe`.pipe(
          NodeSqliteClient.readOnly,
          Effect.orDie,
          Effect.asVoid,
        );
      yield* Effect.gen(function* () {
        const result = yield* call(worker, "card_flag", {
          card: card.id,
          stalled: true,
          reason: "Waiting on the new head",
        }).pipe(Effect.timeout("5 seconds"));
        assert.isFalse(result.isError, result.text);
        assert.strictEqual(
          (yield* kanban.card(card.id)).card.stalled?.reason,
          "Waiting on the new head",
        );
        assert.isUndefined(holder.pollUnsafe());
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(holder);
    }).pipe(
      Effect.provide(
        fake.layer.pipe(
          // The held reader may delay notifications after the production commit reply.
          Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred")),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["subtask_done", "report_bug"] as const)(
  "%s saves an attached active worker's result while the state background reader is held",
  (tool) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "board-caller-reader-" });
      yield* Effect.gen(function* () {
        const state = Context.get(
          yield* Layer.build(
            NodeSqliteClient.layer({
              filename: path.join(directory, "caller.sqlite"),
              readerWorker: true,
              // Statev2 reserves an identity reader for caller lookups.
              identityReaderProcess: true,
              foregroundReaderSlots: 1,
              backgroundReaderSlots: 1,
            }),
          ),
          SqlClient.SqlClient,
        );
        yield* state`PRAGMA journal_mode = WAL`;
        yield* state`CREATE TABLE caller_probe (value INTEGER)`;
        yield* state`INSERT INTO caller_probe VALUES (1)`;
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const fake = fakeThreads();
        yield* Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          const board = yield* kanban.ensureBoard({
            slug: "busy-caller",
            name: "Busy caller",
            defaultProjectId: ProjectId.make("project-1"),
          });
          yield* kanban.setPool(board.id, board.defaultCardModel, 1);
          const work = yield* kanban.createCard(
            board.id,
            {
              title: "Work",
              prompt: "Work",
              subtasks: [{ step: 1, owner: "work", text: "Implement" }],
            },
            owner,
          );
          const bug = yield* kanban.createCard(
            board.id,
            { title: "Known bug", prompt: "Fix" },
            owner,
          );
          yield* kanban.dispatchNow;
          const active = (yield* kanban.card(work.id)).card;
          const worker = active.activeThreadId!;
          assert.equal(active.activeRole, "work");
          const holder = yield* state
            .withTransaction(
              Effect.gen(function* () {
                yield* state`SELECT * FROM caller_probe`;
                yield* Deferred.succeed(held, undefined);
                yield* Deferred.await(release);
              }),
            )
            .pipe(NodeSqliteClient.readOnly, Effect.forkChild);
          yield* Deferred.await(held);
          fake.callerControl.beforeRead = () =>
            state
              .withTransaction(state`SELECT * FROM caller_probe`)
              .pipe(NodeSqliteClient.readOnly, Effect.orDie, Effect.asVoid);
          yield* Effect.gen(function* () {
            const result = yield* call(
              worker,
              tool,
              tool === "subtask_done"
                ? {
                    card: work.id,
                    subtask: "s1",
                    state: "done",
                    note: "Saved while busy",
                  }
                : {
                    boardId: board.id,
                    cardHint: `#${bug.number}`,
                    title: "Known bug",
                    evidence: "Reader held",
                  },
            );
            assert.isFalse(result.isError, result.text);
            assert.isFalse(yield* Deferred.isDone(release));
            if (tool === "subtask_done") {
              assert.equal((yield* kanban.card(work.id)).card.subtasks[0]?.state, "done");
            } else {
              assert.isTrue(
                (yield* kanban.card(bug.id)).events.some(
                  (event) => event.kind === "comment" && event.body?.includes("Reader held"),
                ),
              );
            }
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
          yield* Fiber.join(holder);
        }).pipe(Effect.provide(fake.layer));
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("card_edit reports control characters to an evaluator", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "text-guard",
      name: "Text guard",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const card = yield* kanban.createCard(
      board.id,
      { prompt: "Fix it", title: "Fix it", description: "Explicit" },
      owner,
    );
    const result = yield* call(ThreadId.make("thread-evaluator"), "card_edit", {
      card: card.id,
      comment: "ok\u0000\u0000",
    });
    assert.isTrue(result.isError);
    assert.include(result.text, "control character U+0000");
    assert.isFalse((yield* kanban.card(card.id)).events.some((event) => event.kind === "comment"));
  }).pipe(Effect.provide(layer));
});

it.effect("discussion tools refuse corrupted text before creating a discussion", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "post-guard",
      name: "Post guard",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const card = yield* kanban.createCard(
      board.id,
      { prompt: "Fix it", title: "Fix it", description: "Explicit" },
      owner,
    );
    const evaluator = ThreadId.make("thread-evaluator");
    const before = yield* kanban.discussions(board.id);
    const posted = yield* call(evaluator, "discussion_post", { card: card.id, text: "bad\u0000" });
    assert.isTrue(posted.isError);
    assert.include(posted.text, "message has a control character U+0000 at offset 3");
    assert.deepStrictEqual(yield* kanban.discussions(board.id), before);
    assert.isNull((yield* kanban.card(card.id)).card.discussionId);
    const created = yield* call(evaluator, "discussion_create", {
      title: "New discussion",
      text: "bad\u0000",
    });
    assert.isTrue(created.isError);
    assert.include(created.text, "message has a control character U+0000 at offset 3");
    assert.deepStrictEqual(yield* kanban.discussions(board.id), before);
  }).pipe(Effect.provide(layer));
});

it.effect("MCP rejects controls in raw trimmed fields before any write", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "raw-text",
      name: "Raw text",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const card = yield* kanban.createCard(
      board.id,
      { prompt: "Fix it", title: "Fix it", description: "Explicit" },
      owner,
    );
    const evaluator = ThreadId.make("thread-evaluator");
    const discussionsBefore = yield* kanban.discussions(board.id);
    const tests = [
      { _tag: "collapse", title: "\u000bReport\u000c", text: "text" },
      {
        _tag: "choice",
        id: "x",
        style: "pick",
        question: "\u000bQuestion",
        options: [],
        multi: false,
      },
      {
        _tag: "choice",
        id: "x",
        style: "pick",
        question: "Question",
        options: [{ id: "a", label: "\u000bLabel" }],
        multi: false,
      },
    ];
    for (const block of tests) {
      const result = yield* call(evaluator, "discussion_create", {
        title: "Test",
        blocks: [block],
      });
      assert.isTrue(result.isError, result.text);
      assert.include(result.text, "message has a control character U+000B at offset 0");
      assert.deepStrictEqual(yield* kanban.discussions(board.id), discussionsBefore);
    }
    const title = yield* call(evaluator, "discussion_create", { title: "\u000bTitle\u000c" });
    assert.isTrue(title.isError, title.text);
    assert.include(title.text, "title has a control character U+000B at offset 0 (2 in all)");
    assert.deepStrictEqual(yield* kanban.discussions(board.id), discussionsBefore);

    const wikiBefore = yield* kanban.wiki(board.id);
    const wiki = yield* call(evaluator, "wiki_write", {
      slug: "test",
      title: "\u000bTitle\u000c",
      body: "body",
    });
    assert.isTrue(wiki.isError, wiki.text);
    assert.include(wiki.text, "title has a control character U+000B at offset 0");
    assert.deepStrictEqual(yield* kanban.wiki(board.id), wikiBefore);

    const before = yield* kanban.card(card.id);
    const edit = yield* call(evaluator, "card_edit", {
      card: card.id,
      subtasks: [{ text: "\u000bSubtask\u000c", owner: "work" }],
    });
    assert.isTrue(edit.isError, edit.text);
    assert.include(edit.text, "subtask text has a control character U+000B at offset 0");
    assert.deepStrictEqual(yield* kanban.card(card.id), before);

    const cardsBefore = yield* kanban.cards(board.id);
    const createdCard = yield* call(evaluator, "card_create", {
      prompt: "New card",
      title: "New card",
      description: "Explicit",
      subtasks: [{ text: "\u000bSubtask\u000c", owner: "work" }],
    });
    assert.isTrue(createdCard.isError, createdCard.text);
    assert.include(createdCard.text, "subtask text has a control character U+000B at offset 0");
    assert.deepStrictEqual(yield* kanban.cards(board.id), cardsBefore);

    const clean = yield* call(evaluator, "discussion_create", {
      title: "  Clean  ",
      blocks: [
        {
          _tag: "choice",
          id: "pick",
          style: "pick",
          question: "  Question  ",
          options: [{ id: "a", label: "  Answer  " }],
          multi: false,
        },
      ],
    });
    assert.isFalse(clean.isError, clean.text);
    const discussion = clean.structured.discussion as { id: string; title: string };
    assert.strictEqual(discussion.title, "Clean");
    const messages = yield* kanban.messages(KanbanDiscussionId.make(discussion.id));
    const block = messages[0]!.blocks[0]!;
    assert.strictEqual(block._tag, "choice");
    if (block._tag === "choice") {
      assert.strictEqual(block.question, "Question");
      assert.strictEqual(block.options[0]?.label, "Answer");
    }
  }).pipe(Effect.provide(layer));
});

it.effect("#769 review replies name exact replays and refuse expired verdicts", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "review-reply",
      name: "Review reply",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 2);
    const card = yield* kanban.createCard(board.id, { title: "Review", prompt: "Review" }, owner);
    yield* kanban.dispatchNow;
    const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
    yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
      _tag: "thread",
      threadId: worker,
    });
    yield* kanban.dispatchNow;
    const reviewer = (yield* kanban.card(card.id)).card.activeThreadId!;
    const first = yield* call(reviewer, "card_review_result", {
      verdict: "clear",
      head: "abc1234",
    });
    assert.isFalse(first.isError, first.text);
    assert.strictEqual(first.structured.recorded, true);
    const replay = yield* call(reviewer, "card_review_result", {
      verdict: "clear",
      head: "abc1234",
    });
    assert.isFalse(replay.isError, replay.text);
    assert.strictEqual(replay.structured.recorded, false);
    const review = (yield* kanban.card(card.id)).events.findLast(
      (event) => event.kind === "review",
    )!;
    assert.strictEqual(
      replay.structured.note,
      `Already recorded as review event ${review.id} at ${review.at}; not saved again.`,
    );
    assert.deepStrictEqual(replay.structured.card, first.structured.card);
    assert.lengthOf(
      (yield* kanban.card(card.id)).events.filter((event) => event.kind === "review"),
      1,
    );
    const before = yield* kanban.card(card.id);
    yield* TestClock.adjust("11 minutes");
    const expired = yield* call(reviewer, "card_review_result", {
      verdict: "clear",
      head: "abc1234",
    });
    assert.isTrue(expired.isError, expired.text);
    assert.include(expired.text, "stage completed");
    assert.include(expired.text, "review step 1 of 1");
    assert.include(expired.text, "Your verdict was not recorded.");
    assert.deepStrictEqual(yield* kanban.card(card.id), before);
  }).pipe(Effect.provide(layer));
});

it.effect("a work thread with nothing active defaults to the cards still its own", () => {
  const { running, layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "toy",
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 2);
    const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
    yield* kanban.dispatchNow;
    const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
    const self: KanbanActor = { _tag: "thread", threadId: thread };
    running.add(thread);
    const second = (yield* kanban.createForThread(thread, { prompt: "B", title: "B" })).card;

    // Two cards working: it has to say which.
    const ambiguous = yield* call(thread, "card_get", {});
    assert.isTrue(ambiguous.isError);
    assert.include(ambiguous.text, `#${first.number}, #${second.number}`);

    // The first, the one on its link, goes back to todo and starts on another thread.
    yield* kanban.moveCard(first.id, "todo", "owner", owner);
    yield* kanban.dispatchNow;
    assert.notStrictEqual((yield* kanban.card(first.id)).card.workThreadId, thread);

    // The other waits on the owner, so nothing is active on this thread.
    yield* kanban.moveCard(second.id, "needs_owner", "cardThread", self, { question: "Which?" });
    assert.lengthOf(yield* kanban.carried(thread), 0);

    const got = yield* call(thread, "card_get", {});
    assert.isFalse(got.isError, got.text);
    assert.strictEqual((got.structured.card as { id: string }).id, second.id);

    const read = yield* call(thread, "discussion_read", {});
    assert.isFalse(read.isError, read.text);
    const discussion = yield* kanban.cardDiscussion(second.id);
    assert.strictEqual((read.structured.discussion as { id: string }).id, discussion.id);
  }).pipe(Effect.provide(layer));
});

it.effect("card_update preserves the not-written error from the board service", () => {
  const error = new KanbanError({
    code: "failed",
    detail: "Board busy: not written. Safe to retry once.",
  });
  const { layer } = fakeThreads(undefined, error);
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({ slug: "busy", name: "Busy", defaultProjectId: null });
    const card = yield* kanban.createCard(
      board.id,
      { title: "A", prompt: "A", description: "A" },
      owner,
    );
    const result = yield* call(ThreadId.make("thread-busy-test"), "card_update", {
      card: card.id,
      description: "New",
    });
    assert.isTrue(result.isError);
    assert.include(result.text, error.message);
    assert.strictEqual((yield* kanban.card(card.id)).card.description, "A");
  }).pipe(Effect.provide(layer));
});

it.effect("discussion_post to a card leaves no discussion when the write is refused", () => {
  const error = new KanbanError({
    code: "failed",
    detail: "Board busy: not written. Safe to retry once.",
  });
  const { layer } = fakeThreads(undefined, undefined, error);
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "post-busy",
      name: "Busy",
      defaultProjectId: null,
    });
    const card = yield* kanban.createCard(
      board.id,
      { title: "A", prompt: "A", description: "A" },
      owner,
    );
    const before = yield* kanban.card(card.id);
    const result = yield* call(ThreadId.make("thread-busy-test"), "discussion_post", {
      card: card.id,
      text: "Must not post",
    });
    assert.isTrue(result.isError);
    assert.include(result.text, error.message);
    assert.deepStrictEqual(yield* kanban.card(card.id), before);
    assert.lengthOf(yield* kanban.discussions(board.id), 0);
  }).pipe(Effect.provide(layer));
});

it.effect("card_update with an unchanged description returns ok and adds no event", () => {
  const { running, layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "retry-edit",
      name: "Retry",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
    yield* kanban.dispatchNow;
    const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
    running.add(thread);
    const first = yield* call(thread, "card_update", {
      card: card.id,
      description: "New description",
    });
    assert.isFalse(first.isError, first.text);
    const before = yield* kanban.card(card.id);
    assert.lengthOf(
      before.events.filter((event) => event.kind === "edited"),
      1,
    );
    const repeat = yield* call(thread, "card_update", {
      card: card.id,
      description: "New description",
    });
    assert.isFalse(repeat.isError, repeat.text);
    assert.deepStrictEqual((yield* kanban.card(card.id)).events, before.events);
    const comment = { card: card.id, comment: "Same comment" };
    const firstComment = yield* call(thread, "card_update", comment);
    assert.isFalse(firstComment.isError, firstComment.text);
    const beforeRepeatComment = yield* kanban.card(card.id);
    const repeatComment = yield* call(thread, "card_update", comment);
    assert.isFalse(repeatComment.isError, repeatComment.text);
    assert.deepStrictEqual((yield* kanban.card(card.id)).events, beforeRepeatComment.events);
  }).pipe(Effect.provide(layer));
});

it.effect("discussion_post repeated returns the same message", () => {
  const { running, layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "retry-post",
      name: "Retry",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
    yield* kanban.dispatchNow;
    const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
    running.add(thread);
    const first = yield* call(thread, "discussion_post", { card: card.id, text: "Status update" });
    assert.isFalse(first.isError, first.text);
    const second = yield* call(thread, "discussion_post", { card: card.id, text: "Status update" });
    assert.isFalse(second.isError, second.text);
    const firstMessage = first.structured.message as {
      discussionId: KanbanDiscussionId;
      seq: number;
    };
    const secondMessage = second.structured.message as {
      discussionId: KanbanDiscussionId;
      seq: number;
    };
    assert.deepStrictEqual(secondMessage, firstMessage);
    assert.lengthOf(yield* kanban.messages(firstMessage.discussionId), 1);
    assert.lengthOf(
      (yield* kanban.discussions(board.id)).filter((entry) => entry.cardId === card.id),
      1,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a work thread is directed to its own discussion without creating another card's", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "post-guidance",
      name: "Post guidance",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const own = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
    yield* kanban.dispatchNow;
    const thread = (yield* kanban.card(own.id)).card.activeThreadId!;
    const other = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);

    const refused = yield* call(thread, "discussion_post", {
      card: `#${other.number}`,
      text: "For the other card",
    });
    assert.isTrue(refused.isError, refused.text);
    assert.include(refused.text, "capability_denied");
    assert.include(
      refused.text,
      `This thread works on other cards; it can't post on card #${other.number}. Post it in your own card's discussion; the board's evaluator carries it over.`,
    );
    assert.isNull((yield* kanban.card(other.id)).card.discussionId);

    const posted = yield* call(thread, "discussion_post", {
      card: `#${own.number}`,
      text: "For the evaluator to carry over",
    });
    assert.isFalse(posted.isError, posted.text);
    const message = yield* decodeMessage(posted.structured.message);
    const discussionId = (yield* kanban.card(own.id)).card.discussionId;
    assert.strictEqual(discussionId, message.discussionId);
    assert.deepStrictEqual(yield* kanban.messages(message.discussionId), [message]);
    assert.isNull((yield* kanban.card(other.id)).card.discussionId);
  }).pipe(Effect.provide(layer));
});

it.effect("a work thread reads another card's discussion but cannot post to that card", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "toy",
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const own = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
    yield* kanban.dispatchNow;
    const thread = (yield* kanban.card(own.id)).card.activeThreadId!;
    const other = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
    const discussion = yield* kanban.cardDiscussion(other.id);
    const scribe: KanbanActor = { _tag: "system", component: "test" };
    yield* kanban.post(discussion.id, scribe, [{ _tag: "md", text: "Earlier message" }]);
    const latest = yield* kanban.post(discussion.id, scribe, [
      { _tag: "md", text: "Read this message" },
    ]);
    const cardRefs = [`#${other.number}`, String(other.number), other.id];

    for (const target of [...cardRefs.map((card) => ({ card })), { discussionId: discussion.id }]) {
      const read = yield* call(thread, "discussion_read", { ...target, afterSeq: 1 });
      assert.isFalse(read.isError, read.text);
      assert.strictEqual((read.structured.discussion as { id: string }).id, discussion.id);
      assert.deepStrictEqual(read.structured.messages, [latest]);
    }

    for (const card of cardRefs) {
      const posted = yield* call(thread, "discussion_post", { card, text: "Not mine" });
      assert.isTrue(posted.isError);
      assert.include(
        posted.text,
        `This thread works on other cards; it can't post on card #${other.number}. Post it in your own card's discussion; the board's evaluator carries it over.`,
      );
    }
    assert.lengthOf(yield* kanban.messages(discussion.id), 2);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["work", "review"] as const)(
  "a %s thread cannot post to another card's discussion by id",
  (role) => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "post-ownership",
        name: "Post ownership",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const own = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      let thread = (yield* kanban.card(own.id)).card.activeThreadId!;
      if (role === "review") {
        yield* kanban.moveCard(own.id, "needs_review", "cardThread", {
          _tag: "thread",
          threadId: thread,
        });
        yield* kanban.dispatchNow;
        thread = (yield* kanban.card(own.id)).card.activeThreadId!;
      }
      assert.strictEqual((yield* kanban.caller(thread))?.role, role);
      const other = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
      const discussion = yield* kanban.cardDiscussion(other.id);
      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Earlier message" }]);
      const before = yield* kanban.discussion(discussion.id);
      const messages = yield* kanban.messages(discussion.id);

      const posted = yield* call(thread, "discussion_post", {
        discussionId: discussion.id,
        text: "Not mine",
      });
      assert.isTrue(posted.isError, posted.text);
      assert.include(posted.text, "capability_denied");
      assert.include(
        posted.text,
        `This thread works on other cards; it can't post on card #${other.number}. Post it in your own card's discussion; the board's evaluator carries it over.`,
      );
      assert.deepStrictEqual(yield* kanban.discussion(discussion.id), before);
      assert.deepStrictEqual(yield* kanban.messages(discussion.id), messages);

      const channel = yield* kanban.createDiscussion(board.id, "Channel", owner);
      assert.isNull(channel.cardId);
      const channelPost = yield* call(thread, "discussion_post", {
        discussionId: channel.id,
        text: "Channel update",
      });
      assert.isFalse(channelPost.isError, channelPost.text);
      const message = yield* decodeMessage(channelPost.structured.message);
      assert.deepStrictEqual(yield* kanban.messages(channel.id), [message]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a work thread can post to its own card's discussion by id", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "own-post",
      name: "Own post",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
    yield* kanban.dispatchNow;
    const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
    const discussion = yield* kanban.cardDiscussion(card.id);
    const posted = yield* call(thread, "discussion_post", {
      discussionId: discussion.id,
      text: "Own card update",
    });
    assert.isFalse(posted.isError, posted.text);
    const message = yield* decodeMessage(posted.structured.message);
    assert.deepStrictEqual(yield* kanban.messages(discussion.id), [message]);
    assert.strictEqual((yield* kanban.discussion(discussion.id)).lastSeq, discussion.lastSeq + 1);
  }).pipe(Effect.provide(layer));
});

it.effect("an evaluator can post to a card's discussion by id", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "evaluator-post",
      name: "Evaluator post",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const card = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
    const discussion = yield* kanban.cardDiscussion(card.id);
    const evaluator = yield* kanban.startEvaluator(board.id, { kind: "check" });
    assert.strictEqual((yield* kanban.caller(evaluator))?.role, "evaluator");
    const posted = yield* call(evaluator, "discussion_post", {
      discussionId: discussion.id,
      text: "Evaluator update",
    });
    assert.isFalse(posted.isError, posted.text);
    const message = yield* decodeMessage(posted.structured.message);
    assert.deepStrictEqual(yield* kanban.messages(discussion.id), [message]);
    assert.strictEqual((yield* kanban.discussion(discussion.id)).lastSeq, discussion.lastSeq + 1);
  }).pipe(Effect.provide(layer));
});

it.effect("discussion_read resolves card numbers on the caller's board", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "toy",
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const own = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
    yield* kanban.dispatchNow;
    const thread = (yield* kanban.card(own.id)).card.activeThreadId!;
    const otherBoard = yield* kanban.ensureBoard({
      slug: "elsewhere",
      name: "Elsewhere",
      defaultProjectId: null,
    });
    yield* kanban.createCard(otherBoard.id, { prompt: "C", title: "C" }, owner);
    const elsewhere = yield* kanban.createCard(otherBoard.id, { prompt: "D", title: "D" }, owner);
    const other = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
    assert.strictEqual(other.number, elsewhere.number);
    const discussion = yield* kanban.cardDiscussion(other.id);

    for (const card of [`#${other.number}`, String(other.number)]) {
      const read = yield* call(thread, "discussion_read", { card });
      assert.isFalse(read.isError, read.text);
      assert.strictEqual((read.structured.discussion as { id: string }).id, discussion.id);
    }
    const onlyElsewhere = yield* kanban.createCard(
      otherBoard.id,
      { prompt: "E", title: "E" },
      owner,
    );
    const missing = yield* call(thread, "discussion_read", { card: `#${onlyElsewhere.number}` });
    assert.isTrue(missing.isError);
    assert.include(missing.text, `No card #${onlyElsewhere.number} on Toy.`);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a thread with several cards must pick a discussion and can post only to cards it still works on",
  () => {
    const { running, layer } = fakeThreads();
    let waiting: Deferred.Deferred<AnalyticsEvent> | undefined;
    let waitingTool = "card_get";
    const sink = Layer.mock(Analytics.Analytics)({
      record: (event) =>
        event.kind === "mcp.call" && event.tool === waitingTool && waiting
          ? Deferred.succeed(waiting, event).pipe(Effect.asVoid)
          : Effect.void,
    });
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const other = yield* kanban.createCard(board.id, { prompt: "C", title: "C" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      running.add(thread);
      const second = (yield* kanban.createForThread(thread, { prompt: "B", title: "B" })).card;

      for (const ref of [`#${second.number}`, String(second.number), second.id]) {
        waiting = yield* Deferred.make<AnalyticsEvent>();
        yield* call(thread, "card_get", { card: ref });
        const captured = yield* Deferred.await(waiting);
        assert.equal(captured.boardId, board.id);
        assert.equal(captured.cardId, second.id);
        assert.equal(captured.props?.cardNumber, second.number);
      }

      const cardByNumber = yield* call(thread, "card_get", { card: `#${second.number}` });
      assert.isFalse(cardByNumber.isError, cardByNumber.text);
      assert.strictEqual((cardByNumber.structured.card as { id: string }).id, second.id);
      assert.strictEqual((cardByNumber.structured.card as { prompt: string }).prompt, "B");
      const missing = yield* call(thread, "card_get", { card: "#99999" });
      assert.isTrue(missing.isError);
      assert.include(missing.text, "No card #99999 on Toy.");

      const boardResult = yield* call(thread, "board_get", {});
      assert.isFalse(boardResult.isError, boardResult.text);
      assert.strictEqual(
        boardResult.structured.prompts,
        "omitted; card_get returns a card's prompt",
      );
      const snapshot = boardResult.structured.board as { cards: Array<{ prompt: string }> };
      assert.lengthOf(snapshot.cards, 3);
      assert.isTrue(snapshot.cards.every((card) => card.prompt === ""));
      const firstPage = yield* call(thread, "board_get", { limit: 1 });
      const page = firstPage.structured.board as {
        cards: Array<{
          number: number;
          description?: string;
          owner: string | null;
          status: string;
        }>;
        page: { hasMore: boolean; nextAfter: number };
      };
      assert.lengthOf(page.cards, 1);
      assert.isUndefined(page.cards[0]!.description);
      assert.isString(page.cards[0]!.status);
      assert.isTrue(page.page.hasMore);
      const secondPage = yield* call(thread, "board_get", { limit: 1, after: page.page.nextAfter });
      assert.strictEqual(
        (secondPage.structured.board as typeof page).cards[0]!.number,
        page.cards[0]!.number + 1,
      );

      const unnamed = yield* call(thread, "discussion_post", { text: "hi" });
      assert.isTrue(unnamed.isError);
      assert.include(unnamed.text, "Pass card or discussionId");

      const posted = yield* call(thread, "discussion_post", {
        card: `#${second.number}`,
        text: "Done with B",
      });
      assert.isFalse(posted.isError, posted.text);
      const discussion = yield* kanban.cardDiscussion(second.id);
      const read = yield* call(thread, "discussion_read", { card: String(second.number) });
      assert.isFalse(read.isError, read.text);
      assert.strictEqual((read.structured.discussion as { id: string }).id, discussion.id);
      assert.include(read.text, "Done with B");

      const theirs = yield* call(thread, "discussion_post", {
        card: `#${other.number}`,
        text: "Not mine",
      });
      assert.isTrue(theirs.isError);
      assert.include(theirs.text, `can't post on card #${other.number}`);
      assert.include(theirs.text, "your own card's discussion");
      for (const [index, ref] of [`#${other.number}`, String(other.number), other.id].entries()) {
        waiting = yield* Deferred.make<AnalyticsEvent>();
        waitingTool = "card_create";
        const created = yield* call(thread, "card_create", {
          title: `Follow-up ${index}`,
          prompt: `Task ${index}`,
          blockedBy: [ref],
        });
        assert.isFalse(created.isError, created.text);
        const createdCard = created.structured.card as { id: string; number: number };
        const createdRow = yield* Deferred.await(waiting);
        assert.equal(createdRow.cardId, createdCard.id);
        assert.equal(createdRow.props?.cardNumber, createdCard.number);
        assert.equal(createdRow.saved, true);

        waiting = yield* Deferred.make<AnalyticsEvent>();
        waitingTool = "card_edit";
        const edited = yield* call(ThreadId.make("outside-editor"), "card_edit", {
          card: second.id,
          blockedBy: [ref],
        });
        assert.isFalse(edited.isError, edited.text);
        const editRow = yield* Deferred.await(waiting);
        assert.equal(editRow.cardId, second.id);
        assert.equal(editRow.props?.cardNumber, second.number);
        assert.equal(editRow.saved, true);

        waiting = yield* Deferred.make<AnalyticsEvent>();
        waitingTool = "card_wait";
        yield* call(thread, "card_wait", {
          card: second.id,
          on: "card",
          waitsOn: ref,
          note: "Dependency",
        });
        const waitRow = yield* Deferred.await(waiting);
        assert.equal(waitRow.cardId, second.id);
        assert.equal(waitRow.props?.cardNumber, second.number);

        waiting = yield* Deferred.make<AnalyticsEvent>();
        waitingTool = "board_pause";
        const paused = yield* call(ThreadId.make("outside-editor"), "board_pause", {
          boardId: board.id,
          reason: "Test pause",
          keep: [ref],
        });
        assert.isFalse(paused.isError, paused.text);
        const pauseRow = yield* Deferred.await(waiting);
        assert.equal(pauseRow.boardId, board.id);
        assert.isUndefined(pauseRow.cardId);
        assert.isUndefined(pauseRow.props?.cardNumber);
      }
    }).pipe(Effect.provide(layer.pipe(Layer.provide(sink))));
  },
);

it.effect("nightly pages include early active cards among more than 500 settled cards", () => {
  const { running, layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const board = yield* kanban.ensureBoard({
      slug: "nightly-coverage",
      name: "Nightly coverage",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const early = yield* kanban.createCard(board.id, { prompt: "Old", title: "Old" }, owner);
    yield* Effect.forEach(
      Array.from({ length: 510 }, (_, i) => i + 1),
      (number) =>
        store.putCard({
          ...early,
          id: number === 1 ? early.id : KanbanCardId.make(`settled-${number}`),
          number,
          stage: "verified",
          settledAt: early.createdAt,
        }),
    );
    yield* TestClock.adjust(Duration.hours(30));
    yield* kanban.editCard(early.id, { comment: "Active today" }, owner);
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const current = yield* kanban.createCard(
      board.id,
      { prompt: "Current", title: "Current" },
      owner,
    );
    yield* kanban.dispatchNow;
    const thread = (yield* kanban.card(current.id)).card.activeThreadId!;
    running.add(thread);
    yield* TestClock.adjust(Duration.minutes(1));
    const since = DateTime.formatIso(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 24 * 60 * 60 * 1000),
    );
    const read = (args: Record<string, unknown>) =>
      call(thread, "board_get", args).pipe(
        Effect.map((result) => {
          assert.isFalse(result.isError, result.text);
          return result.structured.board as {
            activeCards?: number;
            cards: Array<{ number: number; settled?: boolean }>;
            page: { hasMore: boolean; nextAfter: number | null };
          };
        }),
      );

    const first = yield* read({ since, limit: 1 });
    assert.strictEqual(first.activeCards, 2);
    assert.deepStrictEqual(
      first.cards.map((row) => row.number),
      [1],
    );
    assert.isTrue(first.cards[0]!.settled);
    assert.isTrue(first.page.hasMore);
    const last = yield* read({ since, limit: 1, after: first.page.nextAfter });
    assert.deepStrictEqual(
      last.cards.map((row) => row.number),
      [current.number],
    );
    assert.isFalse(last.page.hasMore);

    const skipped = yield* read({ since, after: 60 });
    assert.deepStrictEqual(
      skipped.cards.map((row) => row.number),
      [current.number],
    );
    const restarted = yield* read({ since, after: 0, limit: 500 });
    assert.deepStrictEqual(
      restarted.cards.map((row) => row.number),
      [1, current.number],
    );
    assert.isFalse(restarted.page.hasMore);

    const unfiltered = yield* read({ limit: 500 });
    assert.isAbove(unfiltered.cards.length, 0);
    assert.isBelow(unfiltered.cards.length, 500);
    assert.isTrue(unfiltered.page.hasMore);
    const all = [...unfiltered.cards];
    let cursor = unfiltered.page;
    while (cursor.hasMore) {
      const remainder = yield* read({ limit: 500, after: cursor.nextAfter });
      all.push(...remainder.cards);
      cursor = remainder.page;
    }
    assert.deepStrictEqual(
      all.map((row) => row.number),
      Array.from({ length: current.number }, (_, i) => i + 1),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("board_get plain pages stay under 50k and cover 600 detailed cards exactly once", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const board = yield* kanban.ensureBoard({
      slug: "large-pages",
      name: "Large pages",
      defaultProjectId: null,
    });
    const seed = yield* kanban.createCard(board.id, { title: "Seed", prompt: "Details" }, owner);
    const selection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.1-sol",
      options: [
        { id: "reasoningEffort", value: "xhigh" },
        { id: "extra", value: "o".repeat(800) },
      ],
    };
    const detailed = {
      ...seed,
      title: "Long title ".repeat(70),
      question: "Question ".repeat(120),
      stalled: { reason: "Stalled ".repeat(150), at: seed.createdAt, by: owner },
      model: selection,
      models: Array.from({ length: 3 }, (_, i) => ({ model: selection, weight: i + 1 })),
      asks: Array.from({ length: 5 }, (_, i) => ({
        id: `q${i + 1}`,
        text: "Ask ".repeat(300),
        blocking: false,
        by: owner,
        at: seed.createdAt,
        seq: null,
        closedAt: i < 3 ? seed.createdAt : null,
      })),
    };
    for (let number = 1; number <= 600; number++) {
      yield* store.putCard({
        ...detailed,
        id: number === 1 ? seed.id : KanbanCardId.make(`detailed-${number}`),
        number,
      });
    }
    // This is the old plain handler's complete 500-card reply, including its wrapper.
    const snapshot = yield* kanban.replySnapshot(board.id, { after: 0, limit: 501 });
    const before = JSON.stringify({
      board: {
        ...compactBoard({ ...snapshot, cards: snapshot.cards.slice(0, 500) }),
        page: { limit: 500, hasMore: true, nextAfter: 500 },
      },
      prompts: "omitted; card_get returns a card's prompt",
    }).length;
    assert.isAbove(before, COMPACT_READ_CHARS);
    const seen: number[] = [];
    let after = 0;
    let firstSize = 0;
    for (let pages = 0; pages < 600; pages++) {
      const reply = yield* call(ThreadId.make("reader"), "board_get", {
        boardId: board.id,
        limit: 500,
        after,
      });
      assert.isFalse(reply.isError, reply.text);
      const chars = JSON.stringify(reply.structured).length;
      assert.isAtMost(chars, COMPACT_READ_CHARS);
      assert.isAtMost(reply.text.length, COMPACT_READ_CHARS);
      if (after === 0) firstSize = chars;
      const page = reply.structured.board as {
        cards: Array<ReturnType<typeof McpBoardReplies.cardRow>>;
        page: { limit: number; hasMore: boolean; nextAfter: number | null };
      };
      assert.strictEqual(page.page.limit, 500);
      assert.isAbove(page.cards.length, 0);
      for (const row of page.cards) {
        assert.deepStrictEqual(
          row.asks.map((ask) => ask.id),
          ["q4", "q5"],
        );
        assert.isTrue(row.asks.every((ask) => ask.closedAt === null && ask.text.length <= 513));
        assert.isAtMost(row.question!.length, 513);
        assert.isAtMost(row.stalled!.reason.length, 513);
        assert.deepStrictEqual(row.model, { model: selection.model, variant: "xhigh" });
        assert.deepStrictEqual(
          row.models,
          [1, 2, 3].map((weight) => ({ model: selection.model, variant: "xhigh", weight })),
        );
      }
      seen.push(...page.cards.map((row) => row.number));
      if (!page.page.hasMore) {
        assert.isNull(page.page.nextAfter);
        break;
      }
      assert.strictEqual(page.page.nextAfter, page.cards.at(-1)!.number);
      assert.isAbove(page.page.nextAfter!, after);
      after = page.page.nextAfter!;
    }
    assert.deepStrictEqual(
      seen,
      Array.from({ length: 600 }, (_, i) => i + 1),
    );
    yield* Effect.logInfo(
      `board_get fixture: 500-card reply before=${before} chars; capped first page=${firstSize} chars`,
    ).pipe(Effect.provideService(References.MinimumLogLevel, "Info"));
    // The HTTP route still receives the original asks, question, stalled reason and model options.
    const http = compactBoard({ ...snapshot, cards: [detailed] }).cards[0]!;
    assert.lengthOf(http.asks, 5);
    assert.strictEqual(http.question, detailed.question);
    assert.deepStrictEqual(http.stalled, detailed.stalled);
    assert.deepStrictEqual(http.models, detailed.models);
    assert.deepStrictEqual(http.model, selection);
    const mcp = McpBoardReplies.cardRow(http);
    assert.deepStrictEqual(
      mcp.asks.map((ask) => ask.id),
      ["q4", "q5"],
    );
    assert.strictEqual(mcp.question?.length, 513);
    assert.strictEqual(mcp.stalled?.reason.length, 513);
  }).pipe(Effect.provide(layer));
});

it.effect("board_get later pages retain their own live thread states", () => {
  const fake = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const board = yield* kanban.ensureBoard({
      slug: "live-pages",
      name: "Live pages",
      defaultProjectId: null,
    });
    const seed = yield* kanban.createCard(board.id, { title: "Live", prompt: "Details" }, owner);
    for (let number = 1; number <= 3; number++) {
      const threadId = ThreadId.make(`live-${number}`);
      fake.running.add(threadId);
      yield* store.putCard({
        ...seed,
        id: number === 1 ? seed.id : KanbanCardId.make(`live-${number}`),
        number,
        stage: "working",
        activeThreadId: threadId,
      });
    }
    yield* store.putBoard({
      ...board,
      instructions: { ...board.instructions, modelRouting: "i".repeat(14_000) },
    });
    for (let after = 0; after < 3; after++) {
      const reply = yield* call(ThreadId.make("reader"), "board_get", {
        boardId: board.id,
        limit: 1,
        after,
      });
      assert.isFalse(reply.isError, reply.text);
      assert.isAtMost(JSON.stringify(reply.structured).length, COMPACT_READ_CHARS);
      const page = reply.structured.board as {
        cards: Array<{ number: number }>;
        threads: Array<{ threadId: string; running: boolean }>;
      };
      assert.deepStrictEqual(
        page.cards.map((row) => row.number),
        [after + 1],
      );
      assert.deepStrictEqual(
        page.threads.map((thread) => [thread.threadId, thread.running]),
        [[`live-${after + 1}`, true]],
      );
    }
  }).pipe(Effect.provide(fake.layer));
});

it.effect("board_get fits a huge row and metadata and advances with and without since", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const board = yield* kanban.ensureBoard({
      slug: "huge-row",
      name: "Huge row",
      defaultProjectId: null,
    });
    const seed = yield* kanban.createCard(board.id, { title: "Huge", prompt: "Details" }, owner);
    const asks = Array.from({ length: 3_000 }, (_, i) => ({
      id: `q${i + 1}`,
      text: "Ask ".repeat(300),
      blocking: false,
      by: owner,
      at: seed.createdAt,
      seq: null,
      closedAt: null,
    }));
    yield* store.putCard({ ...seed, asks });
    yield* store.putCard({
      ...seed,
      id: KanbanCardId.make("following"),
      number: 2,
      title: "Following",
      asks: [{ ...asks[0]!, text: "Still open" }],
    });
    yield* store.putBoard({
      ...board,
      instructions: { ...board.instructions, modelRouting: "instructions ".repeat(20_000) },
    });
    for (const extra of [{}, { since: "now-24h" }]) {
      const first = yield* call(ThreadId.make("reader"), "board_get", {
        boardId: board.id,
        limit: 1,
        ...extra,
      });
      assert.isFalse(first.isError, first.text);
      assert.isAtMost(JSON.stringify(first.structured).length, COMPACT_READ_CHARS);
      assert.isAtMost(first.text.length, COMPACT_READ_CHARS);
      const page = first.structured.board as {
        cards: Array<{ id?: string; number: number; truncated?: boolean }>;
        page: { hasMore: boolean; nextAfter: number | null };
      };
      assert.strictEqual(page.cards[0]?.number, 1);
      assert.isTrue(page.cards[0]?.truncated);
      if (!("since" in extra)) assert.strictEqual(page.cards[0]?.id, seed.id);
      assert.isTrue(page.page.hasMore);
      assert.strictEqual(page.page.nextAfter, 1);
      const last = yield* call(ThreadId.make("reader"), "board_get", {
        boardId: board.id,
        limit: 1,
        after: 1,
        ...extra,
      });
      assert.isFalse(last.isError, last.text);
      assert.isAtMost(JSON.stringify(last.structured).length, COMPACT_READ_CHARS);
      if (!("since" in extra)) {
        assert.include(String(first.structured.prompts), "oversized board metadata shortened");
        assert.include(String(last.structured.prompts), "on the first page");
      }
      const end = last.structured.board as typeof page;
      assert.deepStrictEqual(
        end.cards.map((row) => row.number),
        [2],
      );
      assert.isFalse(end.page.hasMore);
      assert.isNull(end.page.nextAfter);
      const empty = yield* call(ThreadId.make("reader"), "board_get", {
        boardId: board.id,
        after: 2,
        ...extra,
      });
      assert.isFalse(empty.isError, empty.text);
      assert.isAtMost(JSON.stringify(empty.structured).length, COMPACT_READ_CHARS);
      assert.lengthOf((empty.structured.board as typeof page).cards, 0);
    }
  }).pipe(Effect.provide(layer));
});

it.effect(
  "compact reads: board_get since, card_get pages, discussion_read limit, board_activity",
  () => {
    const { running, layer } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const quiet = yield* kanban.createCard(
        board.id,
        { prompt: "Q", title: "Quiet", priority: 4 },
        owner,
      );
      yield* TestClock.adjust(Duration.hours(30));
      const busy = yield* kanban.createCard(
        board.id,
        // About Crpko #69's size: a 38 KB prompt and a long comment history.
        { prompt: "P".repeat(38_000), title: "Busy", priority: 1 },
        owner,
      );
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(busy.id)).card.activeThreadId!;
      running.add(thread);
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator-1") };
      yield* kanban.askOwner(
        busy.id,
        { question: "Ship it?", blocking: false, options: ["Yes", "No"] },
        evaluator,
        "evaluator",
      );
      yield* TestClock.adjust(Duration.minutes(20));
      yield* kanban.answerAsk(
        busy.id,
        "q1",
        { verdict: "picked", optionIds: ["o1"], revision: 0 },
        owner,
      );
      for (let index = 0; index < 60; index++) {
        yield* kanban.editCard(busy.id, { comment: `${index} ${"c".repeat(3_000)}` }, owner);
        yield* kanban.postToCard(busy.id, owner, [
          { _tag: "md", text: `${index} ${"m".repeat(2_000)}` },
        ]);
      }
      yield* TestClock.adjust(Duration.minutes(5));
      const now = yield* Clock.currentTimeMillis;
      const since = DateTime.formatIso(DateTime.makeUnsafe(now - 24 * 60 * 60 * 1000));

      const full = yield* call(thread, "board_get", {});
      assert.isFalse(full.isError, full.text);
      assert.lengthOf((full.structured.board as { cards: Array<unknown> }).cards, 2);

      const compact = yield* call(thread, "board_get", { since });
      assert.isFalse(compact.isError, compact.text);
      assert.isAtMost(compact.text.length, 50_000);
      const view = compact.structured.board as {
        activeCards: number;
        cards: Array<{
          number: number;
          prompt?: string;
          asks?: Array<{ id: string; minutes?: number; answeredAt?: string }>;
          comments?: number;
        }>;
        page: { hasMore: boolean };
      };
      assert.strictEqual(view.activeCards, 1);
      assert.deepStrictEqual(
        view.cards.map((card) => card.number),
        [busy.number],
      );
      assert.notInclude(compact.text, `"number":${quiet.number},`);
      assert.isUndefined(view.cards[0]!.prompt);
      assert.strictEqual(view.cards[0]!.asks?.[0]?.minutes, 20);
      // The 60 comments plus the ask and its answer.
      assert.isAtLeast(view.cards[0]!.comments ?? 0, 60);
      assert.isFalse(view.page.hasMore);
      const relativeCompact = yield* call(thread, "board_get", { since: "now-24h" });
      assert.isFalse(relativeCompact.isError, relativeCompact.text);
      assert.deepStrictEqual(relativeCompact.structured.board, compact.structured.board);
      const tooOld = yield* call(thread, "board_get", {
        since: DateTime.formatIso(DateTime.makeUnsafe(now - 80 * 60 * 60 * 1000)),
      });
      assert.isTrue(tooOld.isError);
      assert.include(tooOld.text, "at most 72 hours");

      const all = yield* call(thread, "card_get", { card: `#${busy.number}`, events: "all" });
      assert.isFalse(all.isError, all.text);
      const allEvents = all.structured.events as Array<{ id: number }>;
      assert.isAbove(JSON.stringify(all.structured).length, 150_000);
      assert.strictEqual(all.structured.eventsTotal, allEvents.length);
      assert.isNull(all.structured.olderEvents);

      const latest = yield* call(thread, "card_get", { card: `#${busy.number}` });
      assert.isFalse(latest.isError, latest.text);
      assert.isAtMost(JSON.stringify(latest.structured).length, 60_000);
      assert.strictEqual((latest.structured.card as { prompt: string }).prompt.length, 38_000);
      assert.strictEqual(latest.structured.eventsTotal, allEvents.length);
      const page = latest.structured.events as Array<{ id: number; body: string | null }>;
      assert.isAbove(page.length, 0);
      assert.isAtMost(page.length, 20);
      assert.strictEqual(page.at(-1)!.id, allEvents.at(-1)!.id);
      assert.strictEqual(latest.structured.olderEvents, page[0]!.id);
      assert.isArray(latest.structured.threads);
      // Walk the cursor back to the first event: every event once, in order.
      const walked = [...page];
      let cursor = latest.structured.olderEvents as number | null;
      while (cursor !== null) {
        const older = yield* call(thread, "card_get", {
          card: `#${busy.number}`,
          events: { before: cursor, limit: 50 },
        });
        assert.isFalse(older.isError, older.text);
        assert.isAtMost(JSON.stringify(older.structured).length, 60_000);
        assert.deepStrictEqual(older.structured.card, {
          id: busy.id,
          number: busy.number,
          title: busy.title,
          stage: "working",
          boardId: board.id,
        });
        assert.notProperty(older.structured, "threads");
        walked.unshift(...(older.structured.events as typeof page));
        cursor = older.structured.olderEvents as number | null;
      }
      assert.deepStrictEqual(
        walked.map((entry) => entry.id),
        allEvents.map((entry) => entry.id),
      );

      const allMessages = yield* call(thread, "discussion_read", { card: `#${busy.number}` });
      assert.isAbove(allMessages.text.length, 120_000);
      const messagePage = yield* call(thread, "discussion_read", {
        card: `#${busy.number}`,
        limit: 40,
      });
      assert.isFalse(messagePage.isError, messagePage.text);
      assert.isBelow(messagePage.text.length, 60_000);
      const messages = messagePage.structured.messages as Array<{ seq: number }>;
      assert.isAtMost(messages.length, 40);
      assert.strictEqual(messagePage.structured.earlierBefore, messages[0]!.seq);

      const rollup = yield* call(thread, "board_activity", {});
      assert.isFalse(rollup.isError, rollup.text);
      assert.isBelow(rollup.text.length, 60_000);
      const activity = rollup.structured.activity as {
        boardId: string;
        asks: {
          answered: number;
          answeredItems: Array<{ card: number; id: string; minutes?: number }>;
        };
        cards: { active: number };
      };
      assert.strictEqual(activity.boardId, board.id);
      assert.strictEqual(activity.cards.active, 1);
      assert.strictEqual(activity.asks.answered, 1);
      assert.deepStrictEqual(activity.asks.answeredItems[0], {
        ...activity.asks.answeredItems[0],
        card: busy.number,
        id: "q1",
        minutes: 20,
      });
      const relativeRollup = yield* call(thread, "board_activity", { since: "24h", until: "now" });
      assert.isFalse(relativeRollup.isError, relativeRollup.text);
      assert.deepStrictEqual(
        (relativeRollup.structured.activity as { asks: unknown }).asks,
        activity.asks,
      );
      const futureSince = DateTime.formatIso(DateTime.makeUnsafe(now + 60 * 60 * 1000));
      for (const name of ["board_get", "board_activity"]) {
        const future = yield* call(thread, name, { since: futureSince });
        assert.isTrue(future.isError);
        assert.include(future.text, futureSince);
        assert.include(future.text, DateTime.formatIso(DateTime.makeUnsafe(now)));
        assert.include(future.text, "now, server clock, UTC");
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("card_get pages a card whose prompt fills the first reply", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "toy",
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const giant = yield* kanban.createCard(
      board.id,
      { prompt: "G".repeat(70_000), title: "Giant" },
      owner,
    );
    yield* kanban.dispatchNow;
    const detail = yield* kanban.card(giant.id);
    const thread = detail.card.activeThreadId!;
    const first = yield* call(thread, "card_get", { card: giant.id, events: { limit: 100 } });
    assert.isFalse(first.isError, first.text);
    assert.deepStrictEqual(first.structured.card, detail.card);
    assert.deepStrictEqual(first.structured.threads, detail.threads);
    assert.deepStrictEqual(first.structured.events, []);
    let cursor = first.structured.olderEvents as number | null;
    assert.isNotNull(cursor);
    const seen: number[] = [];
    const cursors = new Set<number>();
    for (let count = 0; cursor !== null && count < 200; count++) {
      assert.isFalse(cursors.has(cursor));
      cursors.add(cursor);
      const page = yield* call(thread, "card_get", {
        card: giant.id,
        events: { before: cursor, limit: 2 },
      });
      assert.isFalse(page.isError, page.text);
      assert.deepStrictEqual(page.structured.card, {
        id: giant.id,
        number: giant.number,
        title: giant.title,
        stage: detail.card.stage,
        boardId: board.id,
      });
      assert.notProperty(page.structured, "threads");
      assert.isAtMost(JSON.stringify(page.structured).length, 60_000);
      seen.unshift(...(page.structured.events as Array<{ id: number }>).map((event) => event.id));
      const next = page.structured.olderEvents as number | null;
      if (next !== null) assert.isBelow(next, cursor);
      cursor = next;
    }
    assert.isNull(cursor);
    assert.deepStrictEqual(
      seen,
      detail.events.map((event) => event.id),
    );
  }).pipe(Effect.provide(layer));
});

it.live("card and discussion tools answer while the SQLite writer is held", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kanban-tools-reader-" });
    const { layer, views } = fakeThreads(path.join(directory, "state.sqlite"));
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const sql = yield* SqlClient.SqlClient;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "Reader packet", title: "Reader", description: "Reader" },
        owner,
      );
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      assert.isNotNull(thread);
      const discussion = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(discussion.id, { _tag: "system", component: "test" }, [
        { _tag: "md", text: "Read this" },
      ]);
      const viewsBeforeSearch = views.length;
      const search = yield* call(thread, "card_search", { query: "Reader packet" });
      assert.isFalse(search.isError, search.text);
      assert.strictEqual(search.structured.total, 1);
      assert.strictEqual(views.length, viewsBeforeSearch);
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
      const reads = yield* Effect.all({
        number: call(thread, "card_get", { card: `#${card.number}` }),
        implicit: call(thread, "card_get", {}),
        search: call(thread, "card_search", { query: "Reader packet" }),
        discussion: call(thread, "discussion_read", { card: `#${card.number}` }),
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.ensuring(Deferred.succeed(releaseWriter, undefined)),
      );
      yield* Fiber.join(writer);
      for (const result of Object.values(reads)) assert.isFalse(result.isError, result.text);
      assert.strictEqual((reads.number.structured.card as { id: string }).id, card.id);
      assert.strictEqual((reads.implicit.structured.card as { id: string }).id, card.id);
      assert.strictEqual(reads.search.structured.total, 1);
      assert.include(reads.discussion.text, "Read this");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("board_open gives a board its icon only while it has none", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const evaluator = ThreadId.make("thread-evaluator");
    const opened = yield* call(evaluator, "board_open", {
      slug: "toy",
      name: "Toy",
      icon: "rocket",
    });
    assert.isFalse(opened.isError, opened.text);
    assert.strictEqual((opened.structured.board as { icon: string }).icon, "rocket");

    const board = (yield* kanban.boards)[0]!;
    yield* kanban.updateBoard(board.id, { icon: "leaf" });
    const again = yield* call(evaluator, "board_open", { slug: "toy", name: "Toy", icon: "bug" });
    assert.strictEqual((again.structured.board as { icon: string }).icon, "leaf");

    // Names outside the list never reach the board.
    const unknown = yield* call(evaluator, "board_open", {
      slug: "toy",
      name: "Toy",
      icon: "nope",
    }).pipe(Effect.flip);
    assert.include(String(unknown), "Invalid parameters");
  }).pipe(Effect.provide(layer));
});

it.effect("wiki_write edits preserve surrounding bytes and return a compact result", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "wiki",
      name: "Wiki",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const evaluator = ThreadId.make("thread-evaluator");
    const body = `${"unchanged 𐐀\r\n".repeat(12_000)}old sentence\nend\n`;
    const created = yield* call(evaluator, "wiki_write", {
      slug: "Large Page",
      title: "Kept title",
      body,
    });
    assert.isFalse(created.isError, created.text);
    assert.strictEqual((created.structured.page as { body: string }).body, body);
    const edited = yield* call(evaluator, "wiki_write", {
      slug: " Large Page! ",
      edits: [{ oldString: "old sentence", newString: "$& new sentence" }],
    });
    assert.isFalse(edited.isError, edited.text);
    const [saved] = yield* kanban.wiki(board.id);
    assert.strictEqual(
      saved?.body,
      body.replace("old sentence", () => "$& new sentence"),
    );
    assert.strictEqual(saved?.title, "Kept title");
    assert.deepStrictEqual(edited.structured.page, {
      boardId: board.id,
      slug: "large-page",
      title: "Kept title",
      updatedAt: saved?.updatedAt,
      updatedBy: saved?.updatedBy,
      bodyLength: saved?.body.length,
      edits: 1,
    });
    assert.isBelow(edited.text.length, 1_000);

    const replaced = yield* call(evaluator, "wiki_write", {
      slug: "large-page",
      body: "replacement",
    });
    assert.isFalse(replaced.isError, replaced.text);
    assert.strictEqual((replaced.structured.page as { title: string }).title, "Kept title");
    const untitled = yield* call(evaluator, "wiki_write", { slug: "new-page", body: "" });
    assert.isFalse(untitled.isError, untitled.text);
    assert.strictEqual((untitled.structured.page as { title: string }).title, "new-page");
  }).pipe(Effect.provide(layer));
});

it.effect("wiki_write refuses invalid edits without changing the stored page", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "wiki",
      name: "Wiki",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const evaluator = ThreadId.make("thread-evaluator");
    yield* kanban.writeWiki(
      board.id,
      { slug: "page", title: "Original", body: "one two two" },
      owner,
    );
    const before = yield* kanban.wiki(board.id);
    const cases = [
      {
        input: { edits: [{ oldString: "missing", newString: "new" }] },
        error: "edit 1: expected 1, found 0 occurrences of",
      },
      {
        input: { edits: [{ oldString: "two", newString: "new" }] },
        error: "edit 1: expected 1, found 2 occurrences of",
      },
      {
        input: {
          title: "Not saved",
          edits: [
            { oldString: "one", newString: "changed" },
            { oldString: "missing", newString: "bad" },
          ],
        },
        error: "edit 2: expected 1, found 0",
      },
      {
        input: { body: "replace", edits: [{ oldString: "one", newString: "new" }] },
        error: "exactly one of body or edits",
      },
      { input: {}, error: "exactly one of body or edits" },
      {
        input: { slug: "missing", edits: [{ oldString: "one", newString: "new" }] },
        error: "no wiki page missing; create it with body",
      },
      {
        input: { edits: [{ oldString: "one", newString: "bad\u0000" }] },
        error: "wiki body has a control character U+0000",
      },
      {
        input: { title: "bad\u000b", edits: [{ oldString: "one", newString: "new" }] },
        error: "title has a control character U+000B",
      },
    ];
    for (const { input, error } of cases) {
      const result = yield* call(evaluator, "wiki_write", { slug: "page", ...input });
      assert.isTrue(result.isError, result.text);
      assert.include(result.text, error);
      assert.deepStrictEqual(yield* kanban.wiki(board.id), before);
    }
    // Direct callers must obey the same rules as MCP callers.
    for (const input of [
      {},
      { body: "new", edits: [] },
      { edits: [] },
      { edits: Array.from({ length: 51 }, () => ({ oldString: "one", newString: "x" })) },
      { edits: [{ oldString: "", newString: "x" }] },
      ...[0, -1, 1.5, Number.NaN].map((count) => ({
        edits: [{ oldString: "one", newString: "x", count }],
      })),
    ]) {
      const result = yield* kanban
        .writeWiki(board.id, { slug: "page", ...input }, owner)
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      assert.deepStrictEqual(yield* kanban.wiki(board.id), before);
    }
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const work = yield* kanban.createCard(
      board.id,
      {
        prompt: "Worker",
        title: "Worker",
        description: "Worker",
        subtasks: [{ step: 1, owner: "work", text: "Implement" }],
      },
      owner,
    );
    yield* kanban.dispatchNow;
    const worker = (yield* kanban.card(work.id)).card.activeThreadId!;
    assert.isNotNull(worker);
    const denied = yield* call(worker, "wiki_write", {
      boardId: board.id,
      slug: "page",
      edits: [{ oldString: "one", newString: "new" }],
    });
    assert.isTrue(denied.isError, denied.text);
    assert.include(denied.text, "Only evaluators");
    assert.deepStrictEqual(yield* kanban.wiki(board.id), before);
  }).pipe(Effect.provide(layer));
});

it.effect("wiki_write schema rejects empty edits, empty oldString and invalid counts", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    for (const edits of [
      [],
      Array.from({ length: 51 }, () => ({ oldString: "old", newString: "new" })),
      [{ oldString: "", newString: "new" }],
      ...[0, -1, 1.5].map((count) => [{ oldString: "old", newString: "new", count }]),
    ]) {
      const error = yield* call(ThreadId.make("thread-evaluator"), "wiki_write", {
        slug: "page",
        edits,
      }).pipe(Effect.flip);
      assert.include(String(error), "Invalid parameters");
    }
  }).pipe(Effect.provide(layer));
});

it.effect(
  "wiki_write applies sequential literal edits with non-overlapping counts and saves no-ops",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "wiki",
        name: "Wiki",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const evaluator = ThreadId.make("thread-evaluator");
      yield* kanban.writeWiki(
        board.id,
        { slug: "page", title: "Original", body: "aaaa token" },
        owner,
      );
      const result = yield* call(evaluator, "wiki_write", {
        slug: "page",
        title: " Updated ",
        edits: [
          { oldString: "aa", newString: "$&", count: 2 },
          { oldString: "$&$&", newString: "done" },
          { oldString: "token", newString: "" },
        ],
      });
      assert.isFalse(result.isError, result.text);
      const [saved] = yield* kanban.wiki(board.id);
      assert.strictEqual(saved?.body, "done ");
      assert.strictEqual(saved?.title, "Updated");
      yield* TestClock.adjust("1 second");
      const noop = yield* call(evaluator, "wiki_write", {
        slug: "page",
        edits: [{ oldString: "done", newString: "done" }],
      });
      assert.isFalse(noop.isError, noop.text);
      const [after] = yield* kanban.wiki(board.id);
      assert.strictEqual(after?.body, saved?.body);
      assert.notStrictEqual(after?.updatedAt, saved?.updatedAt);
      assert.deepStrictEqual(after?.updatedBy, { _tag: "evaluator", threadId: evaluator });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("wiki writes serialize concurrent edits and full-body replacements", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "wiki",
      name: "Wiki",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.writeWiki(board.id, { slug: "page", body: "anchor" }, owner);
    yield* Effect.all(
      Array.from({ length: 20 }, (_, i) =>
        kanban.writeWiki(
          board.id,
          {
            slug: "page",
            edits: [{ oldString: "anchor", newString: `edit-${i} anchor` }],
          },
          owner,
        ),
      ),
      { concurrency: "unbounded" },
    );
    const [saved] = yield* kanban.wiki(board.id);
    for (let i = 0; i < 20; i++) assert.include(saved!.body, `edit-${i} `);
    const [edited, replaced] = yield* Effect.all(
      [
        kanban.writeWiki(
          board.id,
          { slug: "page", edits: [{ oldString: "anchor", newString: "edited" }] },
          owner,
        ),
        kanban.writeWiki(board.id, { slug: "page", body: "replacement anchor" }, owner),
      ],
      { concurrency: "unbounded" },
    );
    const [final] = yield* kanban.wiki(board.id);
    assert.strictEqual(replaced.body, "replacement anchor");
    assert.isTrue(
      (edited.body === "replacement edited" && final?.body === edited.body) ||
        (edited.body === saved!.body.replace("anchor", "edited") && final?.body === replaced.body),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("wiki_read sections and outlines ignore fences and keep page metadata", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "wiki",
      name: "Wiki",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const thread = ThreadId.make("thread-evaluator");
    const section = "## Deploy\ntext\n```md\n# Fake\n```\n### Nested\nchild\n";
    const body = `# Root\n${section}## Next\nnext\n## DEPLOY\nsecond`;
    const page = yield* kanban.writeWiki(board.id, { slug: "page", title: "Page", body }, owner);
    const selected = yield* call(thread, "wiki_read", { slug: "page", section: "deploy" });
    assert.isFalse(selected.isError, selected.text);
    assert.deepStrictEqual(selected.structured.pages, [
      { ...page, body: section, note: "2 headings match; returned the first" },
    ]);
    const outline = yield* call(thread, "wiki_read", { slug: "page", outline: true });
    assert.isFalse(outline.isError, outline.text);
    assert.deepStrictEqual(outline.structured.pages, [
      {
        ...page,
        body: [
          "0: # Root",
          "7: ## Deploy",
          `${body.indexOf("### Nested")}: ### Nested`,
          `${body.indexOf("## Next")}: ## Next`,
          `${body.indexOf("## DEPLOY")}: ## DEPLOY`,
        ].join("\n"),
      },
    ]);
    for (const section of ["missing", "Fake"]) {
      const missing = yield* call(thread, "wiki_read", { slug: "page", section });
      assert.isTrue(missing.isError, missing.text);
      assert.include(missing.text, "headings: Root, Deploy, Nested, Next, DEPLOY");
      assert.include(missing.text, "wiki_section_unknown");
    }
    for (const input of [
      { section: "Deploy" },
      { outline: true },
      { slugs: ["page"], section: "Deploy" },
    ]) {
      const invalid = yield* call(thread, "wiki_read", input);
      assert.isTrue(invalid.isError, invalid.text);
      assert.include(invalid.text, "require slug");
    }
    const both = yield* call(thread, "wiki_read", {
      slug: "page",
      section: "Deploy",
      outline: true,
    });
    assert.isTrue(both.isError, both.text);
    assert.include(both.text, "Pass section or outline");
  }).pipe(Effect.provide(layer));
});

it.effect("wiki_read lists metadata by default and reads requested page bodies", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "wiki",
      name: "Wiki",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const thread = ThreadId.make("thread-evaluator");
    const empty = yield* call(thread, "wiki_read", {});
    assert.isFalse(empty.isError, empty.text);
    assert.deepStrictEqual(empty.structured, {
      pages: [],
      index: [],
      hint: "Pass slug to read a page.",
    });

    const charlie = yield* kanban.writeWiki(
      board.id,
      { slug: "charlie", title: "Charlie", body: "Full Charlie body" },
      owner,
    );
    const alpha = yield* kanban.writeWiki(
      board.id,
      { slug: "alpha", title: "Alpha", body: "café" },
      owner,
    );
    const bravo = yield* kanban.writeWiki(
      board.id,
      { slug: "bravo", title: "Bravo", body: "Full Bravo body" },
      owner,
    );
    const index = yield* call(thread, "wiki_read", {});
    assert.isFalse(index.isError, index.text);
    assert.deepStrictEqual(index.structured, {
      pages: [],
      index: [
        { slug: "alpha", title: "Alpha", updatedAt: alpha.updatedAt, bytes: 5 },
        { slug: "bravo", title: "Bravo", updatedAt: bravo.updatedAt, bytes: 15 },
        { slug: "charlie", title: "Charlie", updatedAt: charlie.updatedAt, bytes: 17 },
      ],
      hint: "Pass slug to read a page.",
    });
    assert.notInclude(index.text, '"body"');
    assert.notInclude(index.text, alpha.body);
    assert.deepStrictEqual(JSON.parse(index.text), index.structured);

    const single = yield* call(thread, "wiki_read", { slug: " alpha " });
    assert.isFalse(single.isError, single.text);
    assert.deepStrictEqual(single.structured, { pages: [alpha] });
    const unknown = yield* call(thread, "wiki_read", { slug: "missing" });
    assert.isFalse(unknown.isError, unknown.text);
    assert.deepStrictEqual(unknown.structured, { pages: [] });

    const batch = yield* call(thread, "wiki_read", {
      slugs: [" charlie ", "missing", "alpha"],
    });
    assert.isFalse(batch.isError, batch.text);
    assert.deepStrictEqual(batch.structured, {
      pages: [charlie, alpha],
      missing: ["missing"],
    });
    const missing = yield* call(thread, "wiki_read", { slugs: ["missing"] });
    assert.isFalse(missing.isError, missing.text);
    assert.deepStrictEqual(missing.structured, { pages: [], missing: ["missing"] });
    const maximum = yield* call(thread, "wiki_read", { slugs: Array(20).fill("alpha") });
    assert.isFalse(maximum.isError, maximum.text);
    assert.deepStrictEqual(maximum.structured, { pages: Array(20).fill(alpha), missing: [] });
  }).pipe(Effect.provide(layer));
});

it.effect("wiki_read refuses conflicting selectors and invalid slug batches", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    yield* kanban.ensureBoard({
      slug: "wiki",
      name: "Wiki",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const thread = ThreadId.make("thread-evaluator");
    const both = yield* call(thread, "wiki_read", { slug: "a", slugs: ["b"] });
    assert.isTrue(both.isError, both.text);
    assert.include(both.text, "Pass slug or slugs, not both.");
    for (const slugs of [[], Array(21).fill("a"), [""], ["   "], [1]]) {
      const error = yield* call(thread, "wiki_read", { slugs }).pipe(Effect.flip);
      assert.include(String(error), "Invalid parameters");
    }
  }).pipe(Effect.provide(layer));
});

it.effect("wiki_read keeps a 230-page board's index below 50 KB", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "large-wiki",
      name: "Large wiki",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const body = "A shared lesson. ".repeat(440);
    for (let i = 0; i < 230; i++) {
      yield* kanban.writeWiki(
        board.id,
        { slug: `lesson-${i}`, title: `Shared lesson ${i}`, body },
        owner,
      );
    }
    const result = yield* call(ThreadId.make("thread-evaluator"), "wiki_read", {});
    assert.isFalse(result.isError, result.text);
    assert.deepStrictEqual(result.structured.pages, []);
    assert.lengthOf(result.structured.index as unknown[], 230);
    assert.notInclude(result.text, '"body"');
    assert.isBelow(Buffer.byteLength(result.text, "utf8"), 50_000);
  }).pipe(Effect.provide(layer));
});

it.effect("board helpers resolve delegated ancestry without widening role-bound tools", () => {
  const { layer, parents, missing, deleted, unreadable } = fakeThreads(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { findExisting: true, send: () => Effect.void },
  );
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const boardA = yield* kanban.ensureBoard({
      slug: "first",
      name: "First",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(boardA.id, boardA.defaultCardModel, 1);
    const cardA = yield* kanban.createCard(boardA.id, { prompt: "First card" }, owner);
    yield* kanban.dispatchNow;
    const workerA = (yield* kanban.card(cardA.id)).card.activeThreadId!;
    assert.isNotNull(workerA);
    const boardB = yield* kanban.ensureBoard({
      slug: "second",
      name: "Second",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(boardB.id, boardB.defaultCardModel, 1);
    const cardB = yield* kanban.createCard(boardB.id, { prompt: "Second card" }, owner);
    yield* kanban.dispatchNow;
    const workerB = (yield* kanban.card(cardB.id)).card.activeThreadId!;
    assert.isNotNull(workerB);
    const pageA = yield* kanban.writeWiki(boardA.id, { slug: "a", title: "A", body: "A" }, owner);
    const pageB = yield* kanban.writeWiki(boardB.id, { slug: "b", title: "B", body: "B" }, owner);
    const indexA = { slug: "a", title: "A", updatedAt: pageA.updatedAt, bytes: 1 };
    const indexB = { slug: "b", title: "B", updatedAt: pageB.updatedAt, bytes: 1 };
    const child = ThreadId.make("first-child");
    const grandchild = ThreadId.make("first-grandchild");
    const root = ThreadId.make("linkless-root");
    parents.set(child, workerA);
    parents.set(grandchild, child);
    const delegated = ThreadId.make(
      "thread:delegated-task:command%3Amcp%3A471%3Adelegate-task%3Aread-board",
    );
    parents.set(delegated, workerA);

    for (const thread of [child, grandchild, delegated]) {
      const wiki = yield* call(thread, "wiki_read", {});
      assert.isFalse(wiki.isError, wiki.text);
      assert.deepStrictEqual(wiki.structured.pages, []);
      assert.deepStrictEqual(wiki.structured.index, [indexA]);
      const board = yield* call(thread, "board_get", {});
      assert.isFalse(board.isError, board.text);
      assert.strictEqual((board.structured.board as { board: { id: string } }).board.id, boardA.id);
      const search = yield* call(thread, "card_search", { query: "First" });
      assert.isFalse(search.isError, search.text);
      assert.strictEqual(search.structured.total, 1);
      const byNumber = yield* call(thread, "card_get", { card: `#${cardA.number}` });
      assert.isFalse(byNumber.isError, byNumber.text);
      assert.strictEqual((byNumber.structured.card as { id: string }).id, cardA.id);
      const discussion = yield* call(thread, "discussion_read", { card: `#${cardA.number}` });
      assert.isFalse(discussion.isError, discussion.text);
      assert.strictEqual((discussion.structured.discussion as { cardId: string }).cardId, cardA.id);
      const noDefault = yield* call(thread, "card_get", {});
      assert.isTrue(noDefault.isError);
      assert.include(noDefault.text, "this thread has no card of its own");
      const create = yield* call(thread, "card_create", { prompt: "No implicit write" });
      assert.isTrue(create.isError);
      assert.include(create.text, "Pass boardId: this thread and its parents are not on a board.");
      const post = yield* call(thread, "discussion_post", {
        card: `#${cardA.number}`,
        text: `Report from ${thread}`,
      });
      assert.isFalse(post.isError, post.text);
      const message = post.structured.message as { discussionId: string; author: unknown };
      const byId = yield* call(thread, "discussion_post", {
        discussionId: message.discussionId,
        text: `Report by discussion id from ${thread}`,
      });
      assert.isFalse(byId.isError, byId.text);
      assert.deepStrictEqual(
        (byId.structured.message as { author: unknown }).author,
        message.author,
      );
      assert.strictEqual(message.discussionId, (yield* kanban.card(cardA.id)).card.discussionId);
      for (const input of [{}, { boardId: boardA.id }]) {
        const update = yield* call(thread, "card_update", {
          card: `#${cardA.number}`,
          comment: "Denied",
          ...input,
        });
        const subtask = yield* call(thread, "subtask_done", {
          card: `#${cardA.number}`,
          subtask: "s1",
          state: "done",
          ...input,
        });
        for (const denied of [update, subtask]) {
          assert.isTrue(denied.isError);
          assert.match(denied.text, /Pass boardId|not assigned to that card/);
        }
      }
      const noDiscussion = yield* call(thread, "discussion_post", { text: "No default" });
      assert.isTrue(noDiscussion.isError);
      assert.include(
        noDiscussion.text,
        "Pass discussionId: this thread has no discussion of its own.",
      );
      assert.isNull(yield* kanban.caller(thread));
      const write = yield* call(thread, "wiki_write", { slug: "no", title: "No", body: "No" });
      assert.isTrue(write.isError);
      assert.include(write.text, "Pass boardId: this thread and its parents are not on a board.");
      const deniedPause = yield* call(thread, "board_pause", { boardId: "first", clear: true });
      assert.isTrue(deniedPause.isError);
      assert.include(deniedPause.text, "Only evaluators");
    }
    yield* TestClock.adjust("1 minute");
    const evaluator = yield* kanban.startEvaluator(boardA.id, {
      kind: "request",
      text: "Read cards",
    });
    const evaluatorChild = ThreadId.make("evaluator-child");
    parents.set(evaluatorChild, evaluator);
    const evaluatorCard = yield* call(evaluatorChild, "card_get", { card: `#${cardA.number}` });
    assert.isFalse(evaluatorCard.isError, evaluatorCard.text);
    assert.strictEqual((evaluatorCard.structured.card as { id: string }).id, cardA.id);
    const evaluatorPost = yield* call(evaluatorChild, "discussion_post", {
      card: `#${cardA.number}`,
      text: "Evaluator helper report",
    });
    assert.isFalse(evaluatorPost.isError, evaluatorPost.text);
    assert.strictEqual(
      (evaluatorPost.structured.message as { discussionId: string }).discussionId,
      (yield* kanban.card(cardA.id)).card.discussionId,
    );

    for (const boardId of [boardB.slug, boardB.id]) {
      for (const card of [`#${cardB.number}`, `${cardB.number}`, ` #${cardB.number} `]) {
        const explicitCard = yield* call(root, "card_get", { card, boardId });
        assert.isFalse(explicitCard.isError, explicitCard.text);
        assert.strictEqual((explicitCard.structured.card as { id: string }).id, cardB.id);
        const explicitPost = yield* call(root, "discussion_post", {
          card,
          boardId,
          text: `Explicit ${boardId} ${card}`,
        });
        assert.isFalse(explicitPost.isError, explicitPost.text);
        const explicitRead = yield* call(root, "discussion_read", { card, boardId });
        assert.isFalse(explicitRead.isError, explicitRead.text);
        assert.strictEqual(
          (explicitRead.structured.discussion as { cardId: string }).cardId,
          cardB.id,
        );
      }
    }
    const idIgnoresBoard = yield* call(child, "card_get", {
      card: cardB.id,
      boardId: "does-not-exist",
    });
    assert.isFalse(idIgnoresBoard.isError, idIgnoresBoard.text);
    assert.strictEqual((idIgnoresBoard.structured.card as { id: string }).id, cardB.id);
    const noNumberBoard = yield* call(root, "card_get", { card: `#${cardA.number}` });
    assert.isTrue(noNumberBoard.isError);
    assert.include(
      noNumberBoard.text,
      "Pass boardId: this thread and its parents are not on a board",
    );

    for (const thread of [root, workerA, child]) {
      const explicit = yield* call(thread, "wiki_read", { boardId: "second" });
      assert.isFalse(explicit.isError, explicit.text);
      assert.deepStrictEqual(explicit.structured.pages, []);
      assert.deepStrictEqual(explicit.structured.index, [indexB]);
    }
    const filtered = yield* call(child, "wiki_read", { boardId: boardB.id, slug: "a" });
    assert.isFalse(filtered.isError, filtered.text);
    assert.deepStrictEqual(filtered.structured.pages, []);
    const unknown = yield* call(child, "wiki_read", { boardId: "not-a-board" });
    assert.isTrue(unknown.isError);
    assert.include(unknown.text, "No Missions board");
    assert.include(unknown.text, "not-a-board");
    const noBoard = yield* call(root, "wiki_read", {});
    assert.isTrue(noBoard.isError);
    assert.include(noBoard.text, "Pass boardId: this thread and its parents are not on a board.");

    // The nearer linked board wins even if that thread itself has a linked parent.
    parents.set(workerB, workerA);
    const nested = ThreadId.make("second-child");
    parents.set(nested, workerB);
    const nearest = yield* call(nested, "wiki_read", {});
    assert.isFalse(nearest.isError, nearest.text);
    assert.deepStrictEqual(nearest.structured.pages, []);
    assert.deepStrictEqual(nearest.structured.index, [indexB]);

    for (const [kind, broken] of [
      ["missing", missing],
      ["deleted", deleted],
      ["unreadable", unreadable],
    ] as const) {
      const parent = ThreadId.make(`${kind}-parent`);
      const descendant = ThreadId.make(`${kind}-child`);
      parents.set(descendant, parent);
      broken.add(parent);
      const result = yield* call(descendant, "wiki_read", {});
      assert.isTrue(result.isError);
      assert.include(result.text, "Pass boardId: this thread and its parents are not on a board.");
    }
    const cycleA = ThreadId.make("cycle-a");
    const cycleB = ThreadId.make("cycle-b");
    parents.set(cycleA, cycleB);
    parents.set(cycleB, cycleA);
    const cycleResult = yield* call(cycleA, "wiki_read", {});
    assert.isTrue(cycleResult.isError);
    assert.include(
      cycleResult.text,
      "Pass boardId: this thread and its parents are not on a board.",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("an unreadable ancestry still falls back to the only open board", () => {
  const { layer, parents, unreadable } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "only",
      name: "Only",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const page = yield* kanban.writeWiki(
      board.id,
      { slug: "one", title: "One", body: "One" },
      owner,
    );
    const parent = ThreadId.make("unreadable-parent");
    const child = ThreadId.make("unreadable-child");
    parents.set(child, parent);
    unreadable.add(parent);
    const result = yield* call(child, "wiki_read", {});
    assert.isFalse(result.isError, result.text);
    assert.deepStrictEqual(result.structured.pages, []);
    assert.deepStrictEqual(result.structured.index, [
      { slug: "one", title: "One", updatedAt: page.updatedAt, bytes: 3 },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("board_pause is evaluator-only and resolves kept numbers on the selected board", () => {
  const { layer, parents } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "toy",
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const workerCard = yield* kanban.createCard(board.id, { prompt: "Worker" }, owner);
    yield* kanban.dispatchNow;
    const worker = (yield* kanban.card(workerCard.id)).card.activeThreadId!;
    const denied = yield* call(worker, "board_pause", { reason: "No" });
    assert.isTrue(denied.isError);
    assert.include(denied.text, "Only evaluators");
    const child = ThreadId.make("worker-child");
    const grandchild = ThreadId.make("worker-grandchild");
    parents.set(child, worker);
    parents.set(grandchild, child);
    for (const descendant of [child, grandchild]) {
      const deniedChild = yield* call(descendant, "board_pause", { boardId: "toy", clear: true });
      assert.isTrue(deniedChild.isError);
      assert.include(deniedChild.text, "Only evaluators");
    }
    yield* kanban.updateBoard(board.id, {
      reviewChains: [{ name: "Standard", steps: [board.evaluatorModel] }],
      defaultReviewChain: "Standard",
    });
    yield* kanban.setPool(board.id, board.evaluatorModel, 2);
    yield* kanban.moveCard(workerCard.id, "needs_review", "cardThread", {
      _tag: "thread",
      threadId: worker,
    });
    yield* kanban.dispatchNow;
    const reviewing = (yield* kanban.card(workerCard.id)).card;
    assert.strictEqual(reviewing.activeRole, "review");
    assert.isNotNull(reviewing.activeThreadId);
    const reviewer = reviewing.activeThreadId!;
    const deniedReview = yield* call(reviewer, "board_pause", { reason: "No" });
    assert.isTrue(deniedReview.isError);
    assert.include(deniedReview.text, "Only evaluators");

    const other = yield* kanban.ensureBoard({
      slug: "other",
      name: "Other",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const reviewChild = ThreadId.make("review-helper");
    parents.set(reviewChild, reviewer);
    const page = yield* kanban.writeWiki(
      board.id,
      { slug: "review", title: "Review", body: "Read only review rules" },
      owner,
    );
    const reviewWiki = yield* call(reviewChild, "wiki_read", {});
    assert.isFalse(reviewWiki.isError, reviewWiki.text);
    assert.deepStrictEqual(reviewWiki.structured.pages, []);
    assert.deepStrictEqual(reviewWiki.structured.index, [
      { slug: "review", title: "Review", updatedAt: page.updatedAt, bytes: 22 },
    ]);
    const reviewCard = yield* call(reviewChild, "card_get", { card: `#${workerCard.number}` });
    assert.isFalse(reviewCard.isError, reviewCard.text);
    assert.strictEqual((reviewCard.structured.card as { id: string }).id, workerCard.id);
    const keep = yield* kanban.createCard(other.id, { prompt: "Keep" }, owner);
    const evaluator = ThreadId.make("thread-evaluator");
    const paused = yield* call(evaluator, "board_pause", {
      boardId: "other",
      keep: [`#${keep.number}`],
      reason: "Ship first",
    });
    assert.isFalse(paused.isError, paused.text);
    const result = paused.structured.board as {
      pause: { keep: string[]; reason: string; by: string };
    };
    assert.deepStrictEqual(result.pause.keep, [keep.id]);
    assert.strictEqual(result.pause.reason, "Ship first");
    assert.strictEqual(result.pause.by, `evaluator ${evaluator}`);
    assert.isNull((yield* kanban.snapshot(board.id)).board.pause);

    const wrongBoard = yield* call(evaluator, "board_pause", {
      boardId: "toy",
      keep: [keep.id],
      reason: "Wrong board",
    });
    assert.isTrue(wrongBoard.isError);
    assert.include(wrongBoard.text, keep.id);
    const missingReason = yield* call(evaluator, "board_pause", { boardId: "other" });
    assert.isTrue(missingReason.isError);
    const deniedClear = yield* call(worker, "board_pause", { clear: true });
    assert.isTrue(deniedClear.isError);
    const lifted = yield* call(evaluator, "board_pause", { boardId: "other", clear: true });
    assert.isFalse(lifted.isError, lifted.text);
    assert.isNull((lifted.structured.board as { pause: unknown }).pause);
  }).pipe(Effect.provide(layer));
});

it.effect("compound board tools progress while a dispatch launch waits", () =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { layer, launches } = fakeThreads(undefined, undefined, undefined, { held, release });
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "held",
        name: "Held",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const card = yield* kanban.createCard(
        board.id,
        { title: "A", prompt: "A", description: "A" },
        owner,
      );
      const dispatch = yield* Effect.forkChild(kanban.dispatchNow);
      yield* Deferred.await(held);
      const before = yield* kanban.card(card.id);
      const evaluator = ThreadId.make("thread-evaluator");
      const create = yield* Effect.forkChild(
        call(evaluator, "discussion_create", {
          title: "During launch",
          text: "First message",
        }),
      );
      const created = yield* Fiber.join(create);
      assert.isFalse(created.isError, created.text);
      const discussion = created.structured.discussion as {
        id: KanbanDiscussionId;
        lastSeq: number;
      };
      assert.strictEqual(discussion.lastSeq, 1);

      // Resolve the implicit discussion board before opening a second board.
      const open = yield* Effect.forkChild(
        call(evaluator, "board_open", { slug: "opened", name: "Opened", icon: "rocket" }),
      );
      const opened = yield* Fiber.join(open);
      assert.isFalse(opened.isError, opened.text);
      assert.strictEqual((opened.structured.board as { icon: string }).icon, "rocket");
      const discussions = yield* kanban.discussions(board.id);
      assert.deepStrictEqual(
        discussions.map((entry) => entry.id),
        [discussion.id],
      );
      const messages = yield* kanban.messages(discussion.id);
      assert.lengthOf(messages, 1);
      assert.deepStrictEqual(messages[0]!.blocks, [{ _tag: "md", text: "First message" }]);
      const boards = yield* kanban.boards;
      assert.lengthOf(boards, 2);
      assert.strictEqual(boards.find((entry) => entry.slug === "opened")?.icon, "rocket");
      assert.isUndefined(dispatch.pollUnsafe());
      assert.lengthOf(launches, 0);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(dispatch);
      assert.lengthOf(launches, 1);
      // A discussion and another board changed nothing this card's start depends on,
      // so the launch is kept rather than abandoned.
      const after = yield* kanban.card(card.id);
      assert.strictEqual(before.card.stage, "todo");
      assert.strictEqual(after.card.stage, "working");
      assert.strictEqual(after.card.activeThreadId, ThreadId.make("thread-1"));
      assert.lengthOf(after.threads, 1);
      assert.strictEqual(after.threads[0]!.threadId, ThreadId.make("thread-1"));
      assert.isNull(after.threads[0]!.endedAt);
      assert.deepStrictEqual(yield* kanban.discussions(board.id), discussions);
      assert.deepStrictEqual(yield* kanban.messages(discussion.id), messages);
      assert.deepStrictEqual(yield* kanban.boards, boards);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.provide(layer));
  }),
);

it.effect(
  "compound board tools time out before any write while selection migration is locked",
  () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      const clock = yield* Clock.Clock;
      let admissions = 0;
      const admissionClock: Clock.Clock = {
        ...clock,
        sleep: (duration) =>
          Effect.gen(function* () {
            if (
              Duration.toMillis(duration) === KanbanService.BOARD_WRITE_START_DEADLINE_MS &&
              ++admissions === 2
            )
              yield* Deferred.succeed(waiting, undefined);
            return yield* clock.sleep(duration);
          }),
      };
      const { layer, launches } = fakeThreads();
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const board = yield* kanban.ensureBoard({
          slug: "held",
          name: "Held",
          defaultProjectId: null,
        });
        const holder = yield* Effect.forkChild(
          kanban.withSelectionMigrationLock(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(held);
        const evaluator = ThreadId.make("thread-evaluator");
        const create = yield* Effect.forkChild(
          call(evaluator, "discussion_create", {
            title: "Queued discussion",
            text: "First message",
          }).pipe(Effect.provideService(Clock.Clock, admissionClock)),
        );
        const open = yield* Effect.forkChild(
          call(evaluator, "board_open", { slug: "queued", name: "Queued", icon: "rocket" }).pipe(
            Effect.provideService(Clock.Clock, admissionClock),
          ),
        );
        // Caller resolution does async SQL; advance only once both calls await admission.
        yield* Deferred.await(waiting);
        yield* TestClock.adjust(KanbanService.BOARD_WRITE_START_DEADLINE_MS + 1);
        for (const result of [yield* Fiber.join(create), yield* Fiber.join(open)]) {
          assert.isTrue(result.isError, result.text);
          assert.match(
            result.text,
            /Board busy: not written \(waited 120s behind [01]; most time: selectionMigration 120s\). Safe to retry once\./,
          );
        }
        assert.isUndefined(holder.pollUnsafe());
        assert.lengthOf(yield* kanban.discussions(board.id), 0);
        assert.isFalse((yield* kanban.boards).some((entry) => entry.slug === "queued"));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        assert.lengthOf(yield* kanban.discussions(board.id), 0);
        assert.isFalse((yield* kanban.boards).some((entry) => entry.slug === "queued"));

        const created = yield* call(evaluator, "discussion_create", {
          title: "Real discussion",
          text: "First message",
        });
        assert.isFalse(created.isError, created.text);
        const discussion = created.structured.discussion as {
          id: KanbanDiscussionId;
          lastSeq: number;
        };
        assert.strictEqual(discussion.lastSeq, 1);
        assert.lengthOf(yield* kanban.discussions(board.id), 1);
        assert.lengthOf(yield* kanban.messages(discussion.id), 1);
        const opened = yield* call(evaluator, "board_open", {
          slug: "queued",
          name: "Queued",
          icon: "rocket",
        });
        assert.isFalse(opened.isError, opened.text);
        assert.strictEqual((opened.structured.board as { icon: string }).icon, "rocket");
        assert.lengthOf(yield* kanban.boards, 2);
        assert.lengthOf(launches, 0);
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(layer),
        Effect.provideService(Clock.Clock, admissionClock),
      );
    }),
);

it.effect(
  "pool tools target boardId without changing the evaluator's board and default to the caller's board",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const other = yield* kanban.ensureBoard({
        slug: "other",
        name: "Other",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const evaluator = yield* kanban.startEvaluator(board.id, {
        kind: "request",
        text: "Manage pools",
      });
      const original = (yield* kanban.snapshot(board.id)).pools;
      for (const boardId of [other.slug, other.id]) {
        const set = yield* call(evaluator, "pool_set", {
          boardId,
          model: other.defaultCardModel,
          slots: 6,
        });
        assert.isFalse(set.isError, set.text);
        assert.strictEqual(
          (yield* kanban.snapshot(other.id)).pools.find(
            (p) => p.model.model === other.defaultCardModel.model,
          )?.slots,
          6,
        );
        assert.deepStrictEqual((yield* kanban.snapshot(board.id)).pools, original);
      }
      const local = yield* call(evaluator, "pool_set", { model: board.defaultCardModel, slots: 2 });
      assert.isFalse(local.isError, local.text);
      const localPools = (yield* kanban.snapshot(board.id)).pools;
      assert.strictEqual(
        localPools.find((p) => p.model.model === board.defaultCardModel.model)?.slots,
        2,
      );
      assert.strictEqual(
        (yield* kanban.snapshot(other.id)).pools.find(
          (p) => p.model.model === other.defaultCardModel.model,
        )?.slots,
        6,
      );

      const unused = { instanceId: "opencode", model: "opus/gpt-6-astra", variant: "xhigh" };
      for (const boardId of [board.id, other.id]) {
        assert.isFalse(
          (yield* call(evaluator, "pool_set", { boardId, model: unused, slots: 0 })).isError,
        );
      }
      assert.isFalse(
        (yield* call(evaluator, "pool_remove", { boardId: other.slug, model: unused })).isError,
      );
      assert.strictEqual((yield* kanban.snapshot(board.id)).pools.length, localPools.length + 1);
      assert.strictEqual(
        (yield* kanban.snapshot(other.id)).pools.some((p) => p.model.model === unused.model),
        false,
      );
      assert.isFalse((yield* call(evaluator, "pool_remove", { model: unused })).isError);
      assert.deepStrictEqual((yield* kanban.snapshot(board.id)).pools, localPools);

      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const card = yield* kanban.createCard(board.id, { prompt: "Worker" }, owner);
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
      const before = (yield* kanban.snapshot(other.id)).pools;
      for (const name of ["pool_set", "pool_remove"]) {
        const denied = yield* call(worker, name, {
          boardId: other.id,
          model: other.defaultCardModel,
          slots: 8,
        });
        assert.isTrue(denied.isError);
        assert.include(denied.text, "Only evaluators");
        const missing = yield* call(evaluator, name, {
          boardId: "missing",
          model: other.defaultCardModel,
        });
        assert.isTrue(missing.isError);
        assert.include(missing.text, "No Missions board");
        assert.include(missing.text, "missing");
      }
      assert.deepStrictEqual((yield* kanban.snapshot(other.id)).pools, before);
    }).pipe(Effect.provide(layer));
  },
);

const instructionFixture = Effect.fn("instructionFixture")(function* (
  input: {
    slug?: string;
    name?: string;
    field?: keyof KanbanBoard["instructions"];
    label?: string;
    before?: string;
    after?: string;
    changes?: ReadonlyArray<KanbanAskChange>;
  } = {},
) {
  const kanban = yield* KanbanService.KanbanService;
  const made = yield* kanban.ensureBoard({
    slug: input.slug ?? "offbox",
    name: input.name ?? "Offbox",
    defaultProjectId: ProjectId.make("project-1"),
  });
  const board = yield* kanban.updateBoard(made.id, {
    instructions: {
      escalation: "Ask first.\nEvery release.",
      modelRouting: "Current model routing",
      reviewerRouting: "Current reviewer routing",
    },
  });
  const evaluator = yield* kanban.startEvaluator(board.id, {
    kind: "request",
    text: "Instructions",
  });
  const card = yield* kanban.createCard(board.id, { prompt: "Approve instructions" }, owner);
  const field = input.field ?? "escalation";
  const text = input.after ?? "Release under the standing approval.";
  yield* kanban.askOwner(
    card.id,
    {
      question: "Apply these instructions?",
      blocking: false,
      kind: "change",
      ...(input.changes
        ? { changes: input.changes }
        : {
            change: {
              label: input.label ?? "Offbox board instructions: escalation",
              before: input.before ?? board.instructions[field],
              after: text,
              format: "text",
            },
          }),
    },
    { _tag: "evaluator", threadId: evaluator },
    "evaluator",
  );
  yield* kanban.answerAsk(card.id, "q1", { verdict: "approved", revision: 0 }, owner);
  return { kanban, board, evaluator, card, field, text };
});

it.effect("board_instructions_set applies an approved change, records it and retries once", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, board, evaluator, card, text } = yield* instructionFixture();
    // Old approvals stored the single entry as `change`; new asks store `changes`.
    const store = yield* KanbanStore.KanbanStore;
    const approved = (yield* kanban.card(card.id)).card;
    yield* store.putCard({
      ...approved,
      asks: approved.asks.map((ask) => ({ ...ask, change: ask.changes![0], changes: undefined })),
    });
    const input = { field: "escalation", text, card: `#${card.number}`, ask: "q1" };
    const result = yield* call(evaluator, "board_instructions_set", input);
    assert.isFalse(result.isError, result.text);
    assert.strictEqual(result.structured.applied, true);
    const readback = yield* call(evaluator, "board_get", {});
    const snapshot = readback.structured.board as { board: KanbanBoard };
    assert.deepStrictEqual(snapshot.board.instructions, {
      ...board.instructions,
      escalation: text,
    });
    const appliedComment = `Applied escalation on board offbox from q1 (by ${evaluator})`;
    const events = (yield* kanban.card(card.id)).events;
    assert.strictEqual(events.filter((event) => event.body === appliedComment).length, 1);
    assert.deepInclude(
      events.find((event) => event.body === appliedComment),
      {
        kind: "comment",
        actor: { _tag: "evaluator", threadId: evaluator },
      },
    );
    const retry = yield* call(evaluator, "board_instructions_set", input);
    assert.isFalse(retry.isError, retry.text);
    assert.strictEqual(retry.structured.applied, false);
    assert.strictEqual(retry.structured.reason, "already set");
    assert.deepStrictEqual((yield* kanban.card(card.id)).events, events);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "board_instructions_set preserves the audit across a concurrent cross-board comment",
  () => {
    const { layer, storeControl } = fakeThreads();
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    return Effect.gen(function* () {
      const { kanban, board, evaluator, card, text } = yield* instructionFixture();
      const target = yield* kanban.ensureBoard({
        slug: "target",
        name: "Target",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.updateBoard(target.id, { instructions: board.instructions });
      const store = yield* KanbanStore.KanbanStore;
      const approved = (yield* kanban.card(card.id)).card;
      yield* store.putCard({
        ...approved,
        asks: approved.asks.map((ask) => ({
          ...ask,
          changes: ask.changes!.map((change) => ({ ...change, label: "Target escalation" })),
        })),
      });
      storeControl.afterBoardWrite = () => {
        delete storeControl.afterBoardWrite;
        return kanban
          .editCard(card.id, { comment: "Concurrent card update" }, owner)
          .pipe(Effect.orDie, Effect.forkChild, Effect.flatMap(Fiber.join), Effect.asVoid);
      };
      const input = { boardId: target.id, field: "escalation", text, card: card.id, ask: "q1" };
      const first = yield* call(evaluator, "board_instructions_set", input);
      assert.isFalse(first.isError, first.text);
      assert.strictEqual(first.structured.applied, true);
      assert.strictEqual((yield* kanban.snapshot(target.id)).board.instructions.escalation, text);
      const retry = yield* call(evaluator, "board_instructions_set", input);
      assert.isFalse(retry.isError, retry.text);
      assert.strictEqual(retry.structured.applied, false);
      const events = (yield* kanban.card(card.id)).events;
      assert.lengthOf(
        events.filter((event) => event.body === "Concurrent card update"),
        1,
      );
      assert.lengthOf(
        events.filter((event) => event.body?.startsWith("Applied escalation on board target")),
        1,
      );
      const appliedLogs = logs.filter(
        (message) => Array.isArray(message) && message[0] === "kanban board instructions applied",
      );
      assert.lengthOf(appliedLogs, 1);
      assert.deepInclude((appliedLogs[0] as unknown[])[1], {
        boardId: target.id,
        field: "escalation",
        cardId: card.id,
        askId: "q1",
        threadId: evaluator,
      });
    }).pipe(
      Effect.provide(Layer.mergeAll(layer, Logger.layer([logger], { mergeWithExisting: false }))),
    );
  },
);

it.effect.each([false, true])(
  "board_instructions_set recovers a failed audit once with cross-board=%s",
  (crossBoard) => {
    const { layer, storeControl } = fakeThreads();
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    return Effect.gen(function* () {
      const { kanban, board, evaluator, card, text } = yield* instructionFixture();
      const target = crossBoard
        ? yield* kanban.ensureBoard({
            slug: "target",
            name: "Target",
            defaultProjectId: ProjectId.make("project-1"),
          })
        : board;
      if (crossBoard) {
        yield* kanban.updateBoard(target.id, { instructions: board.instructions });
        const store = yield* KanbanStore.KanbanStore;
        const approved = (yield* kanban.card(card.id)).card;
        yield* store.putCard({
          ...approved,
          asks: approved.asks.map((ask) => ({
            ...ask,
            changes: ask.changes!.map((change) => ({ ...change, label: "Target escalation" })),
          })),
        });
      }
      storeControl.beforeCardEvent = (event) => {
        if (!event.body?.startsWith("Applied ")) return Effect.void;
        delete storeControl.beforeCardEvent;
        return Effect.fail(
          new KanbanStore.KanbanStoreError({ operation: "audit regression", cause: "unavailable" }),
        );
      };
      const input = { boardId: target.id, field: "escalation", text, card: card.id, ask: "q1" };
      const first = yield* call(evaluator, "board_instructions_set", input);
      assert.isTrue(first.isError, first.text);
      assert.strictEqual((yield* kanban.snapshot(target.id)).board.instructions.escalation, text);
      assert.lengthOf(
        (yield* kanban.card(card.id)).events.filter((event) => event.body?.startsWith("Applied ")),
        0,
      );
      const retryEvaluator = ThreadId.make("retry-evaluator");
      const retries = yield* Effect.all(
        [
          call(evaluator, "board_instructions_set", input),
          call(retryEvaluator, "board_instructions_set", input),
        ],
        { concurrency: "unbounded" },
      );
      for (const retry of retries) {
        assert.isFalse(retry.isError, retry.text);
        assert.strictEqual(retry.structured.applied, false);
        assert.strictEqual(retry.structured.reason, "already set");
      }
      const events = (yield* kanban.card(card.id)).events;
      assert.lengthOf(
        events.filter((event) =>
          event.body?.startsWith(`Applied escalation on board ${target.slug}`),
        ),
        1,
      );
      assert.lengthOf(
        logs.filter(
          (message) => Array.isArray(message) && message[0] === "kanban board instructions applied",
        ),
        1,
      );
      const again = yield* call(retryEvaluator, "board_instructions_set", input);
      assert.isFalse(again.isError, again.text);
      assert.deepStrictEqual((yield* kanban.card(card.id)).events, events);
    }).pipe(
      Effect.provide(Layer.mergeAll(layer, Logger.layer([logger], { mergeWithExisting: false }))),
    );
  },
);

it.effect.each([
  { crossBoard: false, sameActor: false, failAudit: false },
  { crossBoard: false, sameActor: true, failAudit: false },
  { crossBoard: true, sameActor: false, failAudit: false },
  { crossBoard: true, sameActor: true, failAudit: false },
  { crossBoard: false, sameActor: false, failAudit: true },
  { crossBoard: false, sameActor: true, failAudit: true },
  { crossBoard: true, sameActor: false, failAudit: true },
  { crossBoard: true, sameActor: true, failAudit: true },
])(
  "board_instructions_set audits reapplication: crossBoard=$crossBoard sameActor=$sameActor failAudit=$failAudit",
  ({ crossBoard, sameActor, failAudit }) => {
    const { layer, storeControl } = fakeThreads();
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    return Effect.gen(function* () {
      const { kanban, board, evaluator, card, text } = yield* instructionFixture();
      const store = yield* KanbanStore.KanbanStore;
      const target = crossBoard
        ? yield* kanban.ensureBoard({
            slug: "target",
            name: "Target",
            defaultProjectId: ProjectId.make("project-1"),
          })
        : board;
      if (crossBoard) {
        yield* kanban.updateBoard(target.id, { instructions: board.instructions });
        const approved = (yield* kanban.card(card.id)).card;
        yield* store.putCard({
          ...approved,
          asks: approved.asks.map((ask) => ({
            ...ask,
            changes: ask.changes!.map((change) => ({ ...change, label: "Target escalation" })),
          })),
        });
      }
      const input = { boardId: target.id, field: "escalation", text, card: card.id, ask: "q1" };
      const first = yield* call(evaluator, "board_instructions_set", input);
      assert.isFalse(first.isError, first.text);
      assert.strictEqual(first.structured.applied, true);
      yield* kanban.updateBoard(target.id, { instructions: board.instructions });
      if (failAudit) {
        storeControl.beforeCardEvent = (event) => {
          if (!event.body?.startsWith("Applied ")) return Effect.void;
          delete storeControl.beforeCardEvent;
          return Effect.fail(
            new KanbanStore.KanbanStoreError({ operation: "reapply audit", cause: "unavailable" }),
          );
        };
      }
      const secondEvaluator = sameActor ? evaluator : ThreadId.make("second-evaluator");
      const second = yield* call(secondEvaluator, "board_instructions_set", input);
      assert.strictEqual(second.isError, failAudit, second.text);
      if (!failAudit) assert.strictEqual(second.structured.applied, true);
      assert.strictEqual((yield* kanban.snapshot(target.id)).board.instructions.escalation, text);
      const pending = yield* store.pendingInstructionApplications(
        card.id,
        target.id,
        "escalation",
        "q1",
      );
      assert.lengthOf(pending, failAudit ? 1 : 0);
      const retries = yield* Effect.all(
        [
          call(evaluator, "board_instructions_set", input),
          call(ThreadId.make("retry-evaluator"), "board_instructions_set", input),
        ],
        { concurrency: "unbounded" },
      );
      for (const retry of retries) {
        assert.isFalse(retry.isError, retry.text);
        assert.strictEqual(retry.structured.applied, false);
      }
      const applied = (yield* kanban.card(card.id)).events.filter((event) =>
        event.body?.startsWith(`Applied escalation on board ${target.slug} from q1`),
      );
      assert.lengthOf(applied, 2);
      assert.deepStrictEqual(
        applied.map((event) => event.actor),
        [
          { _tag: "evaluator", threadId: evaluator },
          { _tag: "evaluator", threadId: secondEvaluator },
        ],
      );
      const appliedLogs = logs.filter(
        (message) => Array.isArray(message) && message[0] === "kanban board instructions applied",
      );
      assert.lengthOf(appliedLogs, 2);
      const applicationIds = appliedLogs.map(
        (message) => ((message as unknown[])[1] as { applicationId: string }).applicationId,
      );
      assert.strictEqual(new Set(applicationIds).size, 2);
      assert.lengthOf(
        yield* store.pendingInstructionApplications(card.id, target.id, "escalation", "q1"),
        0,
      );
      const again = yield* call(secondEvaluator, "board_instructions_set", input);
      assert.isFalse(again.isError, again.text);
      assert.deepStrictEqual(
        (yield* kanban.card(card.id)).events.filter((event) => event.body?.startsWith("Applied ")),
        applied,
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(layer, Logger.layer([logger], { mergeWithExisting: false }))),
    );
  },
);

it.effect(
  "board_instructions_set commits its application receipt atomically with the board",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, board, evaluator, card, text } = yield* instructionFixture();
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER fail_instruction_receipt BEFORE INSERT ON ardud_kanban_instruction_applications
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`;
      const result = yield* call(evaluator, "board_instructions_set", {
        field: "escalation",
        text,
        card: card.id,
        ask: "q1",
      });
      assert.isTrue(result.isError, result.text);
      assert.deepStrictEqual(
        (yield* kanban.snapshot(board.id)).board.instructions,
        board.instructions,
      );
      assert.lengthOf(
        yield* store.pendingInstructionApplications(card.id, board.id, "escalation", "q1"),
        0,
      );
      assert.lengthOf(
        (yield* kanban.card(card.id)).events.filter((event) => event.body?.startsWith("Applied ")),
        0,
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["audit-marker", "card-save"] as const)(
  "board_instructions_set keeps one audit when %s storage fails",
  (stage) => {
    const { layer } = fakeThreads();
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    return Effect.gen(function* () {
      const { kanban, board, evaluator, card, text } = yield* instructionFixture();
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      if (stage === "audit-marker") {
        yield* sql`CREATE TRIGGER fail_audit_write BEFORE UPDATE OF audit_event_id ON ardud_kanban_instruction_applications
          BEGIN SELECT RAISE(ABORT, 'audit marker unavailable'); END`;
      } else {
        yield* sql`CREATE TRIGGER fail_audit_write BEFORE UPDATE ON ardud_kanban_cards
          BEGIN SELECT RAISE(ABORT, 'card save unavailable'); END`;
      }
      const input = { boardId: board.id, field: "escalation", text, card: card.id, ask: "q1" };
      const first = yield* call(evaluator, "board_instructions_set", input);
      assert.isTrue(first.isError, first.text);
      assert.strictEqual((yield* kanban.snapshot(board.id)).board.instructions.escalation, text);
      assert.lengthOf(
        yield* store.pendingInstructionApplications(card.id, board.id, "escalation", "q1"),
        stage === "audit-marker" ? 1 : 0,
      );
      assert.lengthOf(
        (yield* kanban.card(card.id)).events.filter((event) => event.body?.startsWith("Applied ")),
        stage === "audit-marker" ? 0 : 1,
      );
      yield* sql`DROP TRIGGER fail_audit_write`;
      const retry = yield* call(evaluator, "board_instructions_set", input);
      assert.isFalse(retry.isError, retry.text);
      assert.strictEqual(retry.structured.applied, false);
      assert.lengthOf(
        (yield* kanban.card(card.id)).events.filter((event) => event.body?.startsWith("Applied ")),
        1,
      );
      assert.lengthOf(
        logs.filter(
          (message) => Array.isArray(message) && message[0] === "kanban board instructions applied",
        ),
        1,
      );
      assert.lengthOf(
        yield* store.pendingInstructionApplications(card.id, board.id, "escalation", "q1"),
        0,
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(layer, Logger.layer([logger], { mergeWithExisting: false }))),
    );
  },
);

it.effect("board_instructions_set recovers a pending audit after rebuilding the service", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "instruction-audit-restart-" });
    const db = path.join(directory, "state.sqlite");
    const first = fakeThreads(db);
    const fixture = yield* Effect.gen(function* () {
      const { kanban, board, evaluator, card, text } = yield* instructionFixture();
      first.storeControl.beforeCardEvent = (event) =>
        event.body?.startsWith("Applied ")
          ? Effect.fail(
              new KanbanStore.KanbanStoreError({
                operation: "audit restart",
                cause: "unavailable",
              }),
            )
          : Effect.void;
      const input = { boardId: board.id, field: "escalation", text, card: card.id, ask: "q1" };
      const result = yield* call(evaluator, "board_instructions_set", input);
      assert.isTrue(result.isError, result.text);
      assert.strictEqual((yield* kanban.snapshot(board.id)).board.instructions.escalation, text);
      return { input, evaluator, cardId: card.id, boardId: board.id };
    }).pipe(Effect.provide(first.layer));
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const result = yield* call(
        ThreadId.make("after-restart-evaluator"),
        "board_instructions_set",
        fixture.input,
      );
      assert.isFalse(result.isError, result.text);
      assert.strictEqual(result.structured.applied, false);
      const comments = (yield* kanban.card(fixture.cardId)).events.filter((event) =>
        event.body?.startsWith("Applied "),
      );
      assert.lengthOf(comments, 1);
      assert.deepStrictEqual(comments[0]?.actor, {
        _tag: "evaluator",
        threadId: fixture.evaluator,
      });
      const store = yield* KanbanStore.KanbanStore;
      assert.lengthOf(
        yield* store.pendingInstructionApplications(
          fixture.cardId,
          fixture.boardId,
          "escalation",
          "q1",
        ),
        0,
      );
    }).pipe(Effect.provide(fakeThreads(db).layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("board_instructions_set matches each board's entry in a multi-change ask", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, board, evaluator, card } = yield* instructionFixture({
      changes: [
        {
          label: "Offbox escalation",
          before: "Ask first.\nEvery release.",
          after: "Offbox approved",
          format: "text",
        },
        {
          label: "Agent Tools: when to ask",
          before: "Tools before",
          after: "Tools approved",
          format: "text",
        },
      ],
    });
    const made = yield* kanban.ensureBoard({
      slug: "agent-tools",
      name: "Agent Tools",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const tools = yield* kanban.updateBoard(made.id, {
      instructions: { ...made.instructions, escalation: "Tools before" },
    });
    const input = { field: "escalation", card: card.id, ask: "q1" };
    const denied = yield* call(evaluator, "board_instructions_set", {
      ...input,
      boardId: tools.slug,
      text: "Offbox approved",
    });
    assert.isTrue(denied.isError, denied.text);
    assert.include(denied.text, "approved after");
    for (const [boardId, text] of [
      [board.id, "Offbox approved"],
      [tools.slug, "Tools approved"],
    ]) {
      const applied = yield* call(evaluator, "board_instructions_set", { ...input, boardId, text });
      assert.isFalse(applied.isError, applied.text);
      assert.strictEqual(applied.structured.applied, true);
    }
    assert.strictEqual(
      (yield* kanban.snapshot(board.id)).board.instructions.escalation,
      "Offbox approved",
    );
    assert.strictEqual(
      (yield* kanban.snapshot(tools.id)).board.instructions.escalation,
      "Tools approved",
    );
    assert.lengthOf(
      (yield* kanban.card(card.id)).events.filter((event) => event.body?.startsWith("Applied ")),
      2,
    );
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  { state: "open", message: "still open" },
  { state: "dropped", message: "dropped" },
  { state: "rejected", message: "rejected" },
  { state: "non-owner", message: "not answered by the owner" },
  { state: "answered", message: "does not have the owner's approval" },
  { state: "no-answer", message: "not answered by the owner" },
  { state: "wrong-after", message: "approved after" },
  { state: "changed-before", message: "the board's text changed since he approved it; ask again" },
  { state: "no-field", message: "no change entry labelled" },
  { state: "wrong-field", message: "no change entry labelled" },
  { state: "missing-ask", message: "ask q9" },
  { state: "internal-space", message: "approved after" },
] as const)("board_instructions_set refuses $state without writing", ({ state, message }) => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, board, evaluator, card, text } = yield* instructionFixture();
    const store = yield* KanbanStore.KanbanStore;
    const fresh = (yield* kanban.card(card.id)).card;
    const ask = fresh.asks[0]!;
    yield* store.putCard({
      ...fresh,
      asks: [
        {
          ...ask,
          ...(state === "open" ? { closedAt: null } : {}),
          ...(state === "no-answer" ? { answer: undefined } : {}),
          ...(["dropped", "rejected", "answered"].includes(state)
            ? { answer: { ...ask.answer!, verdict: state } }
            : {}),
          ...(state === "non-owner"
            ? { answer: { ...ask.answer!, by: { _tag: "evaluator", threadId: evaluator } } }
            : {}),
          ...(state === "no-field"
            ? {
                changes: ask.changes!.map((entry) => ({
                  ...entry,
                  label: "Offbox board instructions",
                })),
              }
            : {}),
        },
      ],
    });
    if (state === "changed-before") {
      yield* kanban.updateBoard(board.id, {
        instructions: { ...board.instructions, escalation: "Changed later" },
      });
    }
    const before = yield* kanban.card(card.id);
    const instructions = (yield* kanban.snapshot(board.id)).board.instructions;
    const result = yield* call(evaluator, "board_instructions_set", {
      field: state === "wrong-field" ? "modelRouting" : "escalation",
      text:
        state === "wrong-after"
          ? "Unapproved text"
          : state === "internal-space"
            ? text.replace(" ", "  ")
            : text,
      card: card.id,
      ask: state === "missing-ask" ? "q9" : "q1",
    });
    assert.isTrue(result.isError, result.text);
    assert.include(result.text, message);
    assert.deepStrictEqual((yield* kanban.snapshot(board.id)).board.instructions, instructions);
    assert.deepStrictEqual(yield* kanban.card(card.id), before);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  {
    slug: "9router",
    name: "Router",
    field: "escalation",
    label: "9ROUTER board instructions: escalation",
    ok: true,
  },
  {
    slug: "agent-tools",
    name: "Agent Tools",
    field: "escalation",
    label: "Agent Tools: when to ask",
    ok: true,
  },
  {
    slug: "agent-tools",
    name: "Agent Tools",
    field: "modelRouting",
    label: "(agent-tools) model routing",
    ok: true,
  },
  {
    slug: "agent-tools",
    name: "Agent Tools",
    field: "modelRouting",
    label: "agent-tools/modelRouting",
    ok: true,
  },
  {
    slug: "agent-tools",
    name: "Agent Tools",
    field: "reviewerRouting",
    label: "Agent Tools — reviewer routing",
    ok: true,
  },
  {
    slug: "agent-tools",
    name: "Agent Tools",
    field: "reviewerRouting",
    label: "agent-tools: reviewerRouting",
    ok: true,
  },
  { slug: "offbox", name: "Offbox", field: "escalation", label: "preoffbox escalation", ok: false },
  { slug: "offbox", name: "Offbox", field: "escalation", label: "offbox2 escalation", ok: false },
  {
    slug: "offbox",
    name: "Offbox",
    field: "escalation",
    label: "offbox_extra escalation",
    ok: false,
  },
  { slug: "offbox", name: "Offbox", field: "escalation", label: "éoffbox escalation", ok: false },
  { slug: "offbox", name: "Offbox", field: "escalation", label: "offbox escalations", ok: false },
  {
    slug: "offbox",
    name: "Offbox",
    field: "modelRouting",
    label: "offbox modelRoutingExtra",
    ok: false,
  },
] as const)("board_instructions_set checks whole board and field labels: $label", (row) => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, board, evaluator, card, text } = yield* instructionFixture(row);
    const result = yield* call(evaluator, "board_instructions_set", {
      field: row.field,
      text,
      card: card.id,
      ask: "q1",
    });
    assert.strictEqual(result.isError, !row.ok, result.text);
    assert.strictEqual(
      (yield* kanban.snapshot(board.id)).board.instructions[row.field],
      row.ok ? text : board.instructions[row.field],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("board_instructions_set normalizes only CRLF and outer whitespace", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, board, evaluator, card } = yield* instructionFixture({
      before: "  Ask first.\r\nEvery release.\n",
      after: " Approved\r\ntext. ",
    });
    const text = "\nApproved\ntext.\n";
    const result = yield* call(evaluator, "board_instructions_set", {
      field: "escalation",
      text,
      card: card.id,
      ask: "q1",
    });
    assert.isFalse(result.isError, result.text);
    assert.strictEqual((yield* kanban.snapshot(board.id)).board.instructions.escalation, text);
  }).pipe(Effect.provide(layer));
});

it.effect("board_instructions_set requires approval even when text is already set", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, board, evaluator, card, text } = yield* instructionFixture();
    yield* kanban.updateBoard(board.id, {
      instructions: { ...board.instructions, escalation: text },
    });
    const store = yield* KanbanStore.KanbanStore;
    const fresh = (yield* kanban.card(card.id)).card;
    yield* store.putCard({ ...fresh, asks: fresh.asks.map((ask) => ({ ...ask, closedAt: null })) });
    const result = yield* call(evaluator, "board_instructions_set", {
      field: "escalation",
      text,
      card: card.id,
      ask: "q1",
    });
    assert.isTrue(result.isError, result.text);
    assert.include(result.text, "still open");
  }).pipe(Effect.provide(layer));
});

it.effect("board_instructions_set refuses work and review threads", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, board, card, text } = yield* instructionFixture();
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    yield* kanban.dispatchNow;
    const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
    assert.isNotNull(worker);
    const store = yield* KanbanStore.KanbanStore;
    const link = yield* kanban.caller(worker);
    assert.isNotNull(link);
    for (const role of ["work", "review"] as const) {
      yield* store.putThreadLink({ ...link!, role });
      const result = yield* call(worker, "board_instructions_set", {
        field: "escalation",
        text,
        card: card.id,
        ask: "q1",
      });
      assert.isTrue(result.isError, result.text);
      assert.include(result.text, "Only evaluators");
    }
    assert.deepStrictEqual(
      (yield* kanban.snapshot(board.id)).board.instructions,
      board.instructions,
    );
  }).pipe(Effect.provide(layer));
});

const settingsFixture = Effect.fn("settingsFixture")(function* (
  input: {
    label?: string;
    before?: string;
    after?: string;
    changes?: ReadonlyArray<KanbanAskChange>;
  } = {},
) {
  return yield* instructionFixture({
    slug: "crpko",
    name: "Crpko",
    label: "Crpko guessed gates",
    before: "(unset)",
    after: "money, secret",
    ...input,
  });
});

it.effect.each([false, true])(
  "board_settings_set applies an approved change and retries idempotently: legacy=%s",
  (legacy) => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, board, evaluator, card } = yield* settingsFixture();
      if (legacy) {
        const store = yield* KanbanStore.KanbanStore;
        const fresh = (yield* kanban.card(card.id)).card;
        yield* store.putCard({
          ...fresh,
          asks: fresh.asks.map((ask) => ({ ...ask, change: ask.changes![0], changes: undefined })),
        });
      }
      const input = {
        card: `#${card.number}`,
        ask: "q1",
        setting: "guessedGates",
        value: ["secret", "money"],
      };
      const result = yield* call(evaluator, "board_settings_set", input);
      assert.isFalse(result.isError, result.text);
      assert.strictEqual(result.structured.applied, true);
      assert.deepStrictEqual((yield* kanban.snapshot(board.id)).board.guessedGates, [
        "money",
        "secret",
      ]);
      const readback = yield* call(evaluator, "board_get", {});
      assert.deepStrictEqual(
        (readback.structured.board as { board: KanbanBoard }).board.guessedGates,
        ["money", "secret"],
      );
      const events = (yield* kanban.card(card.id)).events;
      assert.lengthOf(
        events.filter(
          (event) => event.body === `Applied guessedGates on board crpko from q1 (by ${evaluator})`,
        ),
        1,
      );
      const retry = yield* call(evaluator, "board_settings_set", input);
      assert.isFalse(retry.isError, retry.text);
      assert.strictEqual(retry.structured.applied, false);
      assert.strictEqual(retry.structured.reason, "already set");
      assert.deepStrictEqual((yield* kanban.card(card.id)).events, events);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  { state: "open", message: "still open" },
  { state: "dropped", message: "dropped" },
  { state: "rejected", message: "rejected" },
  { state: "picked", message: "does not have the owner's approval" },
  { state: "non-owner", message: "not answered by the owner" },
  { state: "no-answer", message: "not answered by the owner" },
  { state: "missing-ask", message: "ask q9" },
  { state: "wrong-after", message: "approved after" },
  { state: "changed-before", message: "the board's setting changed since he approved it" },
  { state: "wrong-board", message: "no change entry labelled" },
  { state: "wrong-setting", message: "no change entry labelled" },
] as const)("board_settings_set refuses $state without writing", ({ state, message }) => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, board, evaluator, card } = yield* settingsFixture();
    const store = yield* KanbanStore.KanbanStore;
    const fresh = (yield* kanban.card(card.id)).card;
    const ask = fresh.asks[0]!;
    yield* store.putCard({
      ...fresh,
      asks: [
        {
          ...ask,
          ...(state === "open" ? { closedAt: null } : {}),
          ...(state === "no-answer" ? { answer: undefined } : {}),
          ...(["dropped", "rejected", "picked"].includes(state)
            ? { answer: { ...ask.answer!, verdict: state } }
            : {}),
          ...(state === "non-owner"
            ? { answer: { ...ask.answer!, by: { _tag: "evaluator", threadId: evaluator } } }
            : {}),
          ...(["wrong-board", "wrong-setting"].includes(state)
            ? {
                changes: ask.changes!.map((entry) => ({
                  ...entry,
                  label: state === "wrong-board" ? "Robob guessed gates" : "Crpko escalation",
                })),
              }
            : {}),
        },
      ],
    });
    if (state === "changed-before")
      yield* kanban.updateBoard(board.id, { guessedGates: ["deploy", "money", "secret"] });
    const before = yield* kanban.card(card.id);
    const settings = (yield* kanban.snapshot(board.id)).board.guessedGates;
    const result = yield* call(evaluator, "board_settings_set", {
      card: card.id,
      ask: state === "missing-ask" ? "q9" : "q1",
      setting: "guessedGates",
      value: state === "wrong-after" ? ["deploy"] : ["money", "secret"],
    });
    assert.isTrue(result.isError, result.text);
    assert.include(result.text, message);
    assert.deepStrictEqual((yield* kanban.snapshot(board.id)).board.guessedGates, settings);
    assert.deepStrictEqual(yield* kanban.card(card.id), before);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  { label: "Crpko guessed gates", ok: true },
  { label: "CRPKO guessedGates", ok: true },
  { label: "(crpko)/guessedGates", ok: true },
  { label: "precrpko guessed gates", ok: false },
  { label: "crpko2 guessed gates", ok: false },
  { label: "crpko_extra guessed gates", ok: false },
  { label: "écrpko guessed gates", ok: false },
  { label: "Crpko guessedGatesExtra", ok: false },
  { label: "Crpko guessed gates_extra", ok: false },
] as const)(
  "board_settings_set matches whole board and setting labels: $label",
  ({ label, ok }) => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, board, evaluator, card } = yield* settingsFixture({ label });
      const result = yield* call(evaluator, "board_settings_set", {
        card: card.id,
        ask: "q1",
        setting: "guessedGates",
        value: ["money", "secret"],
      });
      assert.strictEqual(result.isError, !ok, result.text);
      assert.deepStrictEqual(
        (yield* kanban.snapshot(board.id)).board.guessedGates,
        ok ? ["money", "secret"] : undefined,
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  {
    before: "deploy, money, secret",
    after: "money, secret",
    current: ["secret", "deploy", "money"],
    value: ["secret", "money"],
    ok: true,
  },
  {
    before: "  (unset)\r\n",
    after: " money, secret\r\n",
    current: undefined,
    value: ["money", "secret"],
    ok: true,
  },
  { before: "money, secret", after: "", current: ["money", "secret"], value: [], ok: true },
  { before: "", after: "money, secret", current: [], value: ["money", "secret"], ok: true },
  {
    before: "(unset)",
    after: "money,secret",
    current: undefined,
    value: ["money", "secret"],
    ok: false,
  },
  {
    before: "(unset)",
    after: "secret, money",
    current: undefined,
    value: ["money", "secret"],
    ok: false,
  },
  { before: "(unset)", after: "money, secret", current: [], value: ["money", "secret"], ok: false },
] as const)("board_settings_set compares canonical values: before=$before after=$after", (row) => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, board, evaluator, card } = yield* settingsFixture({
      before: row.before,
      after: row.after,
    });
    if (row.current !== undefined)
      yield* kanban.updateBoard(board.id, { guessedGates: row.current });
    const result = yield* call(evaluator, "board_settings_set", {
      card: card.id,
      ask: "q1",
      setting: "guessedGates",
      value: row.value,
    });
    assert.strictEqual(result.isError, !row.ok, result.text);
    assert.deepStrictEqual(
      (yield* kanban.snapshot(board.id)).board.guessedGates,
      row.ok ? [...row.value].sort() : row.current,
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "board_settings_set requires approval when the value is already set and refuses non-evaluators",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, board, evaluator, card } = yield* settingsFixture();
      yield* kanban.updateBoard(board.id, { guessedGates: ["money", "secret"] });
      const store = yield* KanbanStore.KanbanStore;
      const fresh = (yield* kanban.card(card.id)).card;
      yield* store.putCard({
        ...fresh,
        asks: fresh.asks.map((ask) => ({ ...ask, closedAt: null })),
      });
      const input = {
        card: card.id,
        ask: "q1",
        setting: "guessedGates",
        value: ["money", "secret"],
      };
      const denied = yield* call(evaluator, "board_settings_set", input);
      assert.isTrue(denied.isError, denied.text);
      assert.include(denied.text, "still open");
      const link = (yield* kanban.caller(evaluator))!;
      for (const role of ["work", "review"] as const) {
        yield* store.putThreadLink({ ...link, role, cardId: card.id });
        const result = yield* call(evaluator, "board_settings_set", input);
        assert.isTrue(result.isError, result.text);
        assert.include(result.text, "Only evaluators");
        const direct = yield* kanban
          .applyApprovedSettings(board.id, "guessedGates", ["money", "secret"], card.id, "q1", {
            _tag: "thread",
            threadId: evaluator,
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(direct));
      }
      assert.deepStrictEqual((yield* kanban.snapshot(board.id)).board.guessedGates, [
        "money",
        "secret",
      ]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([false, true])(
  "board_settings_set recovers failed audits and reapplications: crossBoard=%s",
  (crossBoard) => {
    const { layer, storeControl } = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, board, evaluator, card } = yield* settingsFixture();
      const store = yield* KanbanStore.KanbanStore;
      const target = crossBoard
        ? yield* kanban.ensureBoard({
            slug: "target",
            name: "Target",
            defaultProjectId: ProjectId.make("project-1"),
          })
        : board;
      if (crossBoard) {
        const fresh = (yield* kanban.card(card.id)).card;
        yield* store.putCard({
          ...fresh,
          asks: fresh.asks.map((ask) => ({
            ...ask,
            changes: ask.changes!.map((entry) => ({ ...entry, label: "Target guessed gates" })),
          })),
        });
      }
      storeControl.beforeCardEvent = (event) => {
        if (!event.body?.startsWith("Applied ")) return Effect.void;
        delete storeControl.beforeCardEvent;
        return Effect.fail(
          new KanbanStore.KanbanStoreError({ operation: "settings audit", cause: "unavailable" }),
        );
      };
      const input = {
        boardId: target.id,
        card: card.id,
        ask: "q1",
        setting: "guessedGates",
        value: ["money", "secret"],
      };
      const first = yield* call(evaluator, "board_settings_set", input);
      assert.isTrue(first.isError, first.text);
      assert.deepStrictEqual((yield* kanban.snapshot(target.id)).board.guessedGates, [
        "money",
        "secret",
      ]);
      assert.lengthOf(
        yield* store.pendingInstructionApplications(card.id, target.id, "guessedGates", "q1"),
        1,
      );
      const retry = yield* call(evaluator, "board_settings_set", input);
      assert.isFalse(retry.isError, retry.text);
      assert.strictEqual(retry.structured.applied, false);
      yield* kanban.updateBoard(target.id, { guessedGates: undefined });
      const reapplied = yield* call(evaluator, "board_settings_set", input);
      assert.isFalse(reapplied.isError, reapplied.text);
      assert.strictEqual(reapplied.structured.applied, true);
      assert.lengthOf(
        yield* store.pendingInstructionApplications(card.id, target.id, "guessedGates", "q1"),
        0,
      );
      const events = (yield* kanban.card(card.id)).events.filter((event) =>
        event.body?.startsWith(`Applied guessedGates on board ${target.slug} from q1`),
      );
      assert.lengthOf(events, 2);
      assert.deepStrictEqual(
        events.map((event) => event.actor),
        [
          { _tag: "evaluator", threadId: evaluator },
          { _tag: "evaluator", threadId: evaluator },
        ],
      );
      if (crossBoard) assert.isUndefined((yield* kanban.snapshot(board.id)).board.guessedGates);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("board_settings_set commits the application receipt atomically with the board", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, board, evaluator, card } = yield* settingsFixture();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER fail_settings_receipt BEFORE INSERT ON ardud_kanban_instruction_applications BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`;
    const result = yield* call(evaluator, "board_settings_set", {
      card: card.id,
      ask: "q1",
      setting: "guessedGates",
      value: ["money", "secret"],
    });
    assert.isTrue(result.isError, result.text);
    assert.isUndefined((yield* kanban.snapshot(board.id)).board.guessedGates);
    const store = yield* KanbanStore.KanbanStore;
    assert.lengthOf(
      yield* store.pendingInstructionApplications(card.id, board.id, "guessedGates", "q1"),
      0,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("board model inputs preserve native options and reject conflicting levels", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "toy",
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const evaluator = ThreadId.make("thread-evaluator");
    const model = {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "max",
      options: [{ id: "fastMode", value: true }],
    };
    const set = yield* call(evaluator, "pool_set", { model, slots: 2 });
    assert.isFalse(set.isError, set.text);
    const pool = (yield* kanban.snapshot(board.id)).pools.find(
      (entry) => entry.model.instanceId === "claudeAgent",
    );
    assert.deepStrictEqual(pool?.model.options, [
      { id: "fastMode", value: false },
      { id: "effort", value: "max" },
    ]);

    const rejected = yield* call(evaluator, "pool_set", {
      model: { ...model, variant: "high" },
      slots: 3,
    });
    assert.isTrue(rejected.isError, rejected.text);
    assert.include(rejected.text, "effort and variant");
    assert.strictEqual(
      (yield* kanban.snapshot(board.id)).pools.find((entry) => entry.key === pool?.key)?.slots,
      2,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("MCP model writes resolve legacy selections only under the apply flag", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const board = yield* kanban.ensureBoard({
      slug: "toy",
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const evaluator = ThreadId.make("thread-evaluator");
    const opus = { instanceId: "opencode", model: "opus/claude-opus-5-5#high" };
    const haiku = { instanceId: "opencode", model: "opus/cc/claude-haiku-5-5#max" };

    // A separate level is accepted before migration without changing its identity.
    const legacy = { model: "opus/claude-opus-5-5", variant: "high" };
    const off = yield* call(evaluator, "pool_set", { model: legacy, slots: 0 });
    assert.isFalse(off.isError, off.text);
    assert.isTrue(
      (yield* kanban.snapshot(board.id)).pools.some(
        (pool) => pool.key === "opencode/opus/claude-opus-5-5#high",
      ),
    );

    yield* settings.updateSettings({ ardudHarnessMigration: { selections: "apply" } });
    const set = yield* call(evaluator, "pool_set", { model: opus, slots: 0 });
    assert.isFalse(set.isError, set.text);
    const setHaiku = yield* call(evaluator, "pool_set", { model: haiku, slots: 0 });
    assert.isFalse(setHaiku.isError, setHaiku.text);
    const pools = (yield* kanban.snapshot(board.id)).pools;
    assert.isTrue(pools.some((pool) => pool.key === "claudeAgent/claude-opus-5-5#high"));
    assert.isTrue(pools.some((pool) => pool.key === "claudeAgent/claude-haiku-5-5#max"));

    const created = yield* call(evaluator, "card_create", {
      prompt: "Mapped card",
      title: "Mapped card",
      description: "Explicit model",
      model: opus,
    });
    assert.isFalse(created.isError, created.text);
    const card = created.structured.card as {
      id: string;
      model: { instanceId: string; model: string };
    };
    assert.strictEqual(card.model.instanceId, "claudeAgent");
    assert.strictEqual(card.model.model, "claude-opus-5-5");

    const weightedCreated = yield* call(evaluator, "card_create", {
      prompt: "Weighted mapped card",
      title: "Weighted mapped card",
      description: "Weighted models",
      models: [
        { ...opus, weight: 2 },
        { ...haiku, weight: 1 },
      ],
    });
    assert.isFalse(weightedCreated.isError, weightedCreated.text);
    const weightedCreatedCard = weightedCreated.structured.card as {
      models: ReadonlyArray<{ model: { instanceId: string } }>;
    };
    assert.deepStrictEqual(
      weightedCreatedCard.models.map((entry) => entry.model.instanceId),
      ["claudeAgent", "claudeAgent"],
    );

    const edited = yield* call(evaluator, "card_edit", { card: card.id, model: haiku });
    assert.isFalse(edited.isError, edited.text);
    assert.strictEqual(
      (yield* kanban.card(KanbanCardId.make(card.id))).card.model.model,
      "claude-haiku-5-5",
    );
    const nativeHaiku = { instanceId: "claudeAgent", model: "claude-haiku-5-5", effort: "max" };
    const applied = yield* call(evaluator, "card_edit", { card: card.id, model: nativeHaiku });
    assert.isFalse(applied.isError, applied.text);

    const routedList = yield* call(evaluator, "card_edit", {
      card: card.id,
      models: [
        { ...opus, weight: 2 },
        { ...haiku, weight: 1 },
      ],
    });
    assert.isFalse(routedList.isError, routedList.text);
    assert.deepStrictEqual(
      (yield* kanban.card(KanbanCardId.make(card.id))).card.models.map(
        (entry) => entry.model.instanceId,
      ),
      ["claudeAgent", "claudeAgent"],
    );
    const weighted = yield* call(evaluator, "card_edit", {
      card: card.id,
      models: [
        { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "high", weight: 2 },
        { ...nativeHaiku, weight: 1 },
      ],
    });
    assert.isFalse(weighted.isError, weighted.text);
    const weightedCard = (yield* kanban.card(KanbanCardId.make(card.id))).card;
    assert.deepStrictEqual(
      weightedCard.models.map((entry) => entry.model.instanceId),
      ["claudeAgent", "claudeAgent"],
    );

    const conflict = yield* call(evaluator, "card_edit", {
      card: card.id,
      model: { ...opus, variant: "xhigh" },
    });
    assert.isTrue(conflict.isError, conflict.text);
    assert.include(conflict.text, "conflicting");
    assert.deepStrictEqual(
      (yield* kanban.card(KanbanCardId.make(card.id))).card.models,
      weightedCard.models,
    );

    const conflictCreate = yield* call(evaluator, "card_create", {
      prompt: "Refused card",
      title: "Refused card",
      description: "Should not be written",
      models: [{ ...opus, variant: "xhigh", weight: 1 }],
    });
    assert.isTrue(conflictCreate.isError, conflictCreate.text);
    assert.isFalse(
      (yield* kanban.snapshot(board.id)).cards.some(
        (candidate) => candidate.title === "Refused card",
      ),
    );

    const rejectedSet = yield* call(evaluator, "pool_set", {
      model: { ...opus, variant: "xhigh" },
      slots: 8,
    });
    assert.isTrue(rejectedSet.isError, rejectedSet.text);
    assert.strictEqual(
      (yield* kanban.snapshot(board.id)).pools.find(
        (pool) => pool.key === "claudeAgent/claude-opus-5-5#high",
      )?.slots,
      0,
    );

    // Use an unused native pool to exercise removal independently of card references.
    const astra = { instanceId: "opencode", model: "opus/gpt-6-astra#xhigh" };
    const setAstra = yield* call(evaluator, "pool_set", { model: astra, slots: 0 });
    assert.isFalse(setAstra.isError, setAstra.text);
    const rejectedRemove = yield* call(evaluator, "pool_remove", {
      model: { ...astra, effort: "high" },
    });
    assert.isTrue(rejectedRemove.isError, rejectedRemove.text);
    assert.isTrue(
      (yield* kanban.snapshot(board.id)).pools.some(
        (pool) => pool.key === "codex/gpt-6-astra#xhigh",
      ),
    );
    const removed = yield* call(evaluator, "pool_remove", { model: astra });
    assert.isFalse(removed.isError, removed.text);
    assert.isFalse(
      (yield* kanban.snapshot(board.id)).pools.some(
        (pool) => pool.key === "codex/gpt-6-astra#xhigh",
      ),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("HTTP model input decodes full native options and legacy variants", () =>
  Effect.sync(() => {
    const decode = Schema.decodeUnknownResult(ModelBody);
    const native = decode({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      options: [{ id: "serviceTier", value: "priority" }],
    });
    assert.isTrue(Result.isSuccess(native));
    if (Result.isSuccess(native)) {
      assert.deepStrictEqual(native.success.options, [{ id: "serviceTier", value: "priority" }]);
      assert.strictEqual(native.success.effort, "high");
    }
    const legacy = decode({ model: "opus/gpt-6-astra", variant: "xhigh" });
    assert.isTrue(Result.isSuccess(legacy));
    if (Result.isSuccess(legacy)) assert.strictEqual(legacy.success.variant, "xhigh");
  }),
);

it.effect(
  "evaluator_start gives a sweep its text and refuses a second running sweep of the kind",
  () => {
    const { running, launches, layer } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const evaluator = ThreadId.make("thread-evaluator");

      const first = yield* call(evaluator, "evaluator_start", {
        boardId: "toy",
        kind: "stalled",
        text: "Only card #437",
      });
      assert.isFalse(first.isError, first.text);
      assert.include(launches.at(-1) ?? "", "Only card #437");

      running.add(first.structured.threadId as string);
      const refused = yield* call(evaluator, "evaluator_start", {
        boardId: "toy",
        kind: "stalled",
        text: "Only card #438",
      });
      assert.isTrue(refused.isError);
      assert.include(refused.text, first.structured.threadId as string);
      assert.strictEqual(launches.length, 1);

      const request = yield* call(evaluator, "evaluator_start", {
        boardId: "toy",
        kind: "request",
        text: "Look at #437",
      });
      assert.isFalse(request.isError, request.text);
      assert.strictEqual(launches.at(-1)!.split("Look at #437").length, 2);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a card thread may start only a request evaluator, stamped with its card", () => {
  const { launches, layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "toy",
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.ensureBoard({
      slug: "tools",
      name: "Tools",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 2);
    const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
    yield* kanban.dispatchNow;
    const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
    const card = (yield* kanban.card(first.id)).card;
    const before = launches.length;

    const stalled = yield* call(thread, "evaluator_start", { boardId: "tools", kind: "stalled" });
    assert.isTrue(stalled.isError);
    assert.include(stalled.text, "only a request evaluator");
    assert.strictEqual(launches.length, before);

    const handed = yield* call(thread, "evaluator_start", {
      boardId: "tools",
      kind: "request",
      text: "offbox lost run-1",
    });
    assert.isFalse(handed.isError, handed.text);
    const brief = launches.at(-1) ?? "";
    assert.include(brief, "offbox lost run-1");
    assert.include(brief, `kanban-card/${first.id}`);
    assert.include(brief, `#${card.number}`);
    assert.include(brief, thread);
    assert.include(brief, 'the "Toy" board');

    const empty = yield* call(thread, "evaluator_start", {
      boardId: "tools",
      kind: "request",
      text: "  ",
    });
    assert.isTrue(empty.isError);
  }).pipe(Effect.provide(layer));
});

it.effect("card_search finds cards by words or number and hides settled ones by default", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "toy",
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const kafka = yield* kanban.createCard(
      board.id,
      { prompt: "Rotate the broker certs", title: "Kafka cert expiry" },
      owner,
    );
    const docs = yield* kanban.createCard(
      board.id,
      { prompt: "Write the onboarding guide", title: "Docs" },
      owner,
    );
    const evaluator = ThreadId.make("thread-evaluator");
    const numbers = (result: { structured: Record<string, unknown> }) =>
      (result.structured.cards as ReadonlyArray<{ number: number }>).map((card) => card.number);

    const words = yield* call(evaluator, "card_search", { query: "broker KAFKA" });
    assert.isFalse(words.isError, words.text);
    assert.deepStrictEqual(numbers(words), [kafka.number]);

    const byNumber = yield* call(evaluator, "card_search", { query: `#${docs.number}` });
    assert.deepStrictEqual(numbers(byNumber), [docs.number]);

    // Empty query lists every open card, newest first.
    const all = yield* call(evaluator, "card_search", { query: "", limit: 1 });
    assert.deepStrictEqual(numbers(all), [docs.number]);
    assert.strictEqual(all.structured.total, 2);

    yield* kanban.moveCard(kafka.id, "verified", "owner", owner);
    yield* kanban.settleCard(kafka.id);
    const hidden = yield* call(evaluator, "card_search", { query: "kafka" });
    assert.deepStrictEqual(numbers(hidden), []);
    const settled = yield* call(evaluator, "card_search", {
      query: "kafka",
      includeSettled: true,
    });
    assert.deepStrictEqual(numbers(settled), [kafka.number]);

    const staged = yield* call(evaluator, "card_search", { query: "", stage: "verified" });
    assert.deepStrictEqual(numbers(staged), []);

    // "#1" also appears in #10-#12; the exact card still comes first under the limit.
    for (let index = 3; index <= 12; index += 1) {
      yield* kanban.createCard(
        board.id,
        { prompt: `Step ${index}`, title: `Step ${index}` },
        owner,
      );
    }
    const exact = yield* call(evaluator, "card_search", {
      query: `#${kafka.number}`,
      includeSettled: true,
      limit: 1,
    });
    assert.deepStrictEqual(numbers(exact), [kafka.number]);
  }).pipe(Effect.provide(layer));
});

it.effect("discussion_read keeps blocks whole, caps a reply near 1 MB and reads one by seq", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "big-read",
      name: "Big read",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const discussion = yield* kanban.createDiscussion(board.id, "Big", owner);
    const scribe: KanbanActor = { _tag: "system", component: "scribe" };
    const big = "b".repeat(400 * 1024);
    const huge = "h".repeat(1200 * 1024);
    for (let index = 0; index < 4; index++) {
      yield* kanban.post(discussion.id, scribe, [{ _tag: "md", text: big }]);
    }
    yield* kanban.post(discussion.id, scribe, [{ _tag: "md", text: huge }]);
    const reader = ThreadId.make("thread-reader");

    const latest = yield* call(reader, "discussion_read", { discussionId: discussion.id });
    assert.isFalse(latest.isError, latest.text);
    const latestMessages = latest.structured.messages as Array<{
      seq: number;
      blocks: Array<{ text: string; truncated?: boolean }>;
    }>;
    // The newest alone is past the cap: it comes as a stub with a pointer to the seq read.
    assert.deepStrictEqual(
      latestMessages.map((message) => message.seq),
      [5],
    );
    assert.isTrue(latestMessages[0]!.blocks[0]!.truncated);
    assert.include(String(latest.structured.note), "seq: 5");
    assert.strictEqual(latest.structured.earlierBefore, 5);

    const earlier = yield* call(reader, "discussion_read", {
      discussionId: discussion.id,
      beforeSeq: 5,
    });
    const earlierMessages = earlier.structured.messages as Array<{
      seq: number;
      blocks: Array<{ text: string; truncated?: boolean }>;
    }>;
    // Whole blocks, about 1 MB at most: two of the four 400 KB messages.
    assert.deepStrictEqual(
      earlierMessages.map((message) => message.seq),
      [3, 4],
    );
    assert.strictEqual(earlierMessages[0]!.blocks[0]!.text, big);
    assert.strictEqual(earlier.structured.earlierBefore, 3);

    const one = yield* call(reader, "discussion_read", { discussionId: discussion.id, seq: 5 });
    const oneMessages = one.structured.messages as Array<{
      seq: number;
      blocks: Array<{ text: string }>;
    }>;
    assert.strictEqual(oneMessages[0]!.blocks[0]!.text, huge);
    assert.isUndefined(one.structured.earlierBefore);
  }).pipe(Effect.provide(layer));
});

it.effect("board defaults follow the work thread; unbound callers must disambiguate", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "bound",
      name: "Bound",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const other = yield* kanban.ensureBoard({
      slug: "other",
      name: "Other",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const card = yield* kanban.createCard(board.id, { title: "Work", prompt: "Work" }, owner);
    yield* kanban.dispatchNow;
    const thread = (yield* kanban.card(card.id)).card.workThreadId!;
    const updated = yield* call(thread, "card_update", {
      card: `#${card.number}`,
      comment: "Saved without boardId",
    });
    assert.isFalse(updated.isError, updated.text);
    assert.strictEqual((updated.structured.card as { id: string }).id, card.id);
    const unbound = ThreadId.make("unbound");
    const refused = yield* call(unbound, "board_get", {});
    assert.isTrue(refused.isError);
    assert.include(refused.text, "Candidate board ids:");
    assert.include(refused.text, board.id);
    assert.include(refused.text, other.id);
    // The card reference itself is enough when its number occurs on one board only.
    const found = yield* call(unbound, "card_get", { card: `#${card.number}` });
    assert.isFalse(found.isError, found.text);
    yield* kanban.createCard(other.id, { title: "Other work", prompt: "Other work" }, owner);
    assert.isTrue((yield* call(unbound, "card_get", { card: `#${card.number}` })).isError);
    const explicit = yield* call(unbound, "card_get", {
      boardId: board.id,
      card: `#${card.number}`,
    });
    assert.isFalse(explicit.isError, explicit.text);
    // Knowing the other board does not grant a worker evaluator powers or another card.
    assert.isTrue((yield* call(thread, "card_edit", { card: card.id, title: "No" })).isError);
    const foreign = (yield* kanban.cards(other.id))[0]!;
    const dependent = yield* kanban.createCard(
      other.id,
      { title: "Dependent", prompt: "Dependent" },
      owner,
    );
    const edited = yield* call(unbound, "card_edit", {
      card: dependent.id,
      blockedBy: [`#${foreign.number}`],
    });
    assert.isFalse(edited.isError, edited.text);
    assert.deepStrictEqual((edited.structured.card as { blockedBy: string[] }).blockedBy, [
      foreign.id,
    ]);

    assert.isTrue(
      (yield* call(thread, "card_update", {
        boardId: other.id,
        card: `#${foreign.number}`,
        comment: "No",
      })).isError,
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "board lookup recovers from card ownership and a discussion evaluator without a link",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const board = yield* kanban.ensureBoard({
        slug: "inferred",
        name: "Inferred",
        defaultProjectId: null,
      });
      yield* kanban.ensureBoard({ slug: "unrelated", name: "Unrelated", defaultProjectId: null });
      const card = yield* kanban.createCard(board.id, { title: "Work", prompt: "Work" }, owner);
      const worker = ThreadId.make("unlinked-worker");
      yield* store.putCard({
        ...card,
        activeThreadId: worker,
        workThreadId: worker,
        activeRole: "work",
      });
      const result = yield* call(worker, "board_get", {});
      assert.isFalse(result.isError, result.text);
      const discussion = yield* kanban.cardDiscussion(card.id);
      const evaluator = ThreadId.make("unlinked-discussion-evaluator");
      yield* store.putDiscussion({ ...discussion, evaluatorThreadId: evaluator });
      const inferred = yield* call(evaluator, "board_get", {});
      assert.isFalse(inferred.isError, inferred.text);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("card_edit analytics separates invalid subtask plans from approval refusals", () => {
  const fake = fakeThreads();
  let pending: Deferred.Deferred<AnalyticsEvent> | undefined;
  const sink = Layer.mock(Analytics.Analytics)({
    record: (event) =>
      pending && event.kind === "mcp.call" && event.tool === "card_edit"
        ? Deferred.succeed(pending, event).pipe(Effect.asVoid)
        : Effect.void,
  });
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "plan-reasons",
      name: "Plan reasons",
      defaultProjectId: null,
    });
    const card = yield* kanban.createCard(
      board.id,
      {
        title: "Plan",
        prompt: "Work",
        subtasks: [
          { text: "Implement", owner: "work" },
          { text: "Pay the invoice", owner: "evaluator", gate: "money" },
        ],
      },
      owner,
    );
    const cases = [
      {
        subtasks: [{ id: "s999" }],
        reason: "subtask_not_found",
        message: "the card has no subtask s999. Existing subtask ids: s1, s2",
      },
      {
        subtasks: [{ id: "s1" }, { id: "s1" }],
        reason: "invalid_args",
        message: "subtask s1 is listed twice",
      },
      {
        subtasks: [{ text: "New" }],
        reason: "invalid_args",
        message: "a new subtask needs text and owner",
      },
      {
        subtasks: [{ owner: "work" }],
        reason: "invalid_args",
        message: "a new subtask needs text and owner",
      },
      {
        subtasks: [{ text: " ", owner: "work" }],
        reason: "invalid_args",
        message: "Expected a non-blank string",
      },
      {
        subtasks: [{ text: "Implement", owner: "work", gate: "money" }],
        reason: "invalid_args",
        message: "a deploy, money or secret step must be owned by the evaluator or a script",
      },
      {
        subtasks: [{ id: "s2", clearGate: "This gate was added by mistake" }],
        reason: "approval_required",
        message: "only Abdullah's answer clears it",
      },
    ] as const;
    for (const row of cases) {
      pending = yield* Deferred.make<AnalyticsEvent>();
      const result = yield* call(ThreadId.make("plan-evaluator"), "card_edit", {
        card: card.id,
        subtasks: row.subtasks,
      }).pipe(Effect.result);
      if (Result.isFailure(result)) {
        assert.include(String(result.failure), row.message);
      } else {
        assert.isTrue(result.success.isError);
        assert.include(result.success.text, row.message);
      }
      const recorded = yield* Deferred.await(pending);
      assert.equal(recorded.denyReason, row.reason);
      assert.equal(
        recorded.errorTag,
        row.reason === "approval_required" ? "capability_denied" : "invalid_request",
      );
      assert.equal(recorded.cardId, card.id);
      assert.notInclude(JSON.stringify(recorded), row.message);
      assert.deepStrictEqual((yield* kanban.card(card.id)).card.subtasks, card.subtasks);
    }
  }).pipe(Effect.provide(fake.layer.pipe(Layer.provide(sink))));
});

it.effect(
  "subtasks advertise their limit, reject long text in the schema and list existing ids",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "limits",
        name: "Limits",
        defaultProjectId: null,
      });
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Work",
          prompt: "Work",
          subtasks: [
            { text: "First", owner: "work" },
            { text: "Second", owner: "review" },
          ],
        },
        owner,
      );
      const evaluator = ThreadId.make("evaluator");
      const missing = yield* call(evaluator, "subtask_done", {
        card: card.id,
        subtask: "s9",
        state: "done",
      });
      assert.isTrue(missing.isError);
      assert.include(missing.text, "Existing subtask ids: s1, s2");
      const parameters = KanbanToolkit.tools.card_edit.parametersSchema;
      const tooLong = Schema.decodeUnknownExit(parameters)({
        card: card.id,
        subtasks: [{ text: "x".repeat(501), owner: "work" }],
      });
      assert.strictEqual(tooLong._tag, "Failure");
      assert.strictEqual(
        Schema.decodeUnknownExit(parameters)({
          card: card.id,
          subtasks: [{ text: "x".repeat(500), owner: "work" }],
        })._tag,
        "Success",
      );
      assert.include(JSON.stringify(Schema.toJsonSchemaDocument(parameters)), '"maxLength":500');
      const kept = yield* call(evaluator, "card_edit", {
        card: card.id,
        subtasks: [{ id: "s1" }, { id: "s2" }],
      });
      assert.isFalse(kept.isError, kept.text);
      assert.deepStrictEqual((yield* kanban.card(card.id)).card.subtasks, card.subtasks);
      for (const input of [{ text: "New" }, { owner: "work" }]) {
        const refused = yield* call(evaluator, "card_edit", {
          card: card.id,
          subtasks: [{ id: "s1" }, { id: "s2" }, input],
        });
        assert.isTrue(refused.isError);
        assert.include(refused.text, "a new subtask needs text and owner");
        assert.deepStrictEqual((yield* kanban.card(card.id)).card.subtasks, card.subtasks);
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  { hint: "omitted", allowed: true, assignToSelf: false },
  { hint: "own-id", allowed: true, assignToSelf: false },
  { hint: "own-slug", allowed: true, assignToSelf: false },
  { hint: "padded-own-id", allowed: true, assignToSelf: false },
  { hint: "padded-own-slug", allowed: true, assignToSelf: false },
  { hint: "foreign-id", allowed: false, assignToSelf: false },
  { hint: "padded-foreign-id", allowed: false, assignToSelf: false },
  { hint: "foreign-slug", allowed: false, assignToSelf: false },
  { hint: "padded-foreign-slug", allowed: false, assignToSelf: false },
  { hint: "unknown", allowed: false, assignToSelf: false },
  { hint: "omitted", allowed: true, assignToSelf: true },
  { hint: "own-id", allowed: true, assignToSelf: true },
  { hint: "own-slug", allowed: true, assignToSelf: true },
  { hint: "padded-own-id", allowed: true, assignToSelf: true },
  { hint: "padded-own-slug", allowed: true, assignToSelf: true },
  { hint: "foreign-id", allowed: false, assignToSelf: true },
  { hint: "padded-foreign-id", allowed: false, assignToSelf: true },
  { hint: "foreign-slug", allowed: false, assignToSelf: true },
  { hint: "padded-foreign-slug", allowed: false, assignToSelf: true },
  { hint: "unknown", allowed: false, assignToSelf: true },
] as const)(
  "worker card_create scope: $hint, assignToSelf=$assignToSelf",
  ({ hint, allowed, assignToSelf }) => {
    const { layer, running } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const own = yield* kanban.ensureBoard({
        slug: "own",
        name: "Own",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const foreign = yield* kanban.ensureBoard({
        slug: "foreign",
        name: "Foreign",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const reviewChain = "Origin review";
      yield* kanban.updateBoard(own.id, {
        reviewChains: [{ name: reviewChain, steps: [own.evaluatorModel] }],
        defaultReviewChain: reviewChain,
      });
      const goal = yield* kanban.setGoal(own.id, { name: "Origin goal" });
      yield* kanban.setPool(own.id, own.defaultCardModel, 1);
      const origin = yield* kanban.createCard(
        own.id,
        { title: "Origin", prompt: "Origin", goalId: goal.id, reviewChain },
        owner,
      );
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(origin.id)).card.workThreadId!;
      running.add(worker);
      const boardId = {
        omitted: undefined,
        "own-id": own.id,
        "own-slug": own.slug,
        "padded-own-id": `  ${own.id}  `,
        "padded-own-slug": `  ${own.slug}  `,
        "foreign-id": foreign.id,
        "padded-foreign-id": `  ${foreign.id}  `,
        "foreign-slug": foreign.slug,
        "padded-foreign-slug": `  ${foreign.slug}  `,
        unknown: "missing-board",
      }[hint];
      const result = yield* call(worker, "card_create", {
        ...(boardId === undefined ? {} : { boardId }),
        title: "Follow-up",
        prompt: "Follow-up",
        assignToSelf,
      });
      assert.strictEqual(result.isError, !allowed, result.text);
      assert.lengthOf(yield* kanban.cards(foreign.id), 0);
      if (!allowed) {
        assert.lengthOf(yield* kanban.cards(own.id), 1);
        if (hint !== "unknown") assert.include(result.text, "own board");
        return;
      }
      const created = (yield* kanban.cards(own.id)).find((card) => card.id !== origin.id)!;
      assert.strictEqual(created.boardId, own.id);
      assert.strictEqual(created.goalId, goal.id);
      assert.strictEqual(created.reviewChain, reviewChain);
      if (assignToSelf) assert.strictEqual(created.workThreadId, worker);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  { discussions: ["a"], candidates: ["a"] },
  { discussions: ["a", "a"], candidates: ["a"] },
  { discussions: ["a", "b"], candidates: ["a", "b"] },
  { discussions: ["a", "a", "b"], candidates: ["a", "b"] },
  { discussions: ["b", "a"], candidates: ["a", "b"] },
] as const)("discussion board inference: $discussions", ({ discussions, candidates }) => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const a = yield* kanban.ensureBoard({ slug: "a", name: "A", defaultProjectId: null });
    const b = yield* kanban.ensureBoard({ slug: "b", name: "B", defaultProjectId: null });
    const unrelated = yield* kanban.ensureBoard({
      slug: "unrelated",
      name: "Unrelated",
      defaultProjectId: null,
    });
    const boards = { a, b };
    const evaluator = ThreadId.make("unlinked-evaluator");
    for (const [index, key] of discussions.entries()) {
      const discussion = yield* kanban.createDiscussion(
        boards[key].id,
        `Discussion ${index}`,
        owner,
      );
      const posted = yield* call(evaluator, "discussion_post", {
        discussionId: discussion.id,
        text: `Taking discussion ${index}`,
      });
      assert.isFalse(posted.isError, posted.text);
      assert.strictEqual((yield* kanban.discussion(discussion.id)).evaluatorThreadId, evaluator);
    }
    assert.isNull(yield* kanban.caller(evaluator));
    const read = yield* call(evaluator, "board_get", {});
    const created = yield* call(evaluator, "card_create", {
      title: "Default board",
      prompt: "Default board",
    });
    const ambiguous = candidates.length > 1;
    assert.strictEqual(read.isError, ambiguous, read.text);
    assert.strictEqual(created.isError, ambiguous, created.text);
    if (ambiguous) {
      assert.include(
        read.text,
        `Candidate board ids: ${candidates.map((key) => boards[key].id).join(", ")}`,
      );
      assert.notInclude(read.text, unrelated.id);
      assert.lengthOf(yield* kanban.cards(a.id), 0);
      assert.lengthOf(yield* kanban.cards(b.id), 0);
    } else {
      assert.strictEqual((created.structured.card as { boardId: string }).boardId, a.id);
    }
    const explicit = yield* call(evaluator, "card_create", {
      boardId: b.id,
      title: "Explicit id",
      prompt: "Explicit id",
    });
    assert.isFalse(explicit.isError, explicit.text);
    assert.strictEqual((explicit.structured.card as { boardId: string }).boardId, b.id);
    const bySlug = yield* call(evaluator, "card_create", {
      boardId: a.slug,
      title: "Explicit slug",
      prompt: "Explicit slug",
    });
    assert.isFalse(bySlug.isError, bySlug.text);
    assert.strictEqual((bySlug.structured.card as { boardId: string }).boardId, a.id);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["id", "number", "implicit", "board", "edit", "noop", "comment", "links"] as const)(
  "agent read %s consumes a claim used outside the board send wrapper",
  (form) => {
    let send: KanbanThreads["Service"]["send"] = () => Effect.void;
    const { layer } = fakeThreads(undefined, undefined, undefined, undefined, undefined, {
      findExisting: true,
      send: (input) => Effect.suspend(() => send(input)),
    });
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const server = yield* McpServer.McpServer;
      const board = yield* kanban.ensureBoard({
        slug: "consume",
        name: "Consume",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const card = yield* kanban.createCard(
        board.id,
        { title: "Consume", prompt: "Consume" },
        owner,
      );
      yield* kanban.dispatchNow;
      const current = (yield* kanban.card(card.id)).card;
      assert.isNotNull(current.workThreadId);
      assert.isNull(current.stalled);
      const thread = current.workThreadId!;
      yield* store.putCard({
        ...current,
        stage: "todo",
        activeThreadId: null,
        activeRole: null,
        activePool: null,
      });
      send = () => {
        send = () => Effect.void;
        const request =
          form === "board"
            ? call(thread, "board_get", { boardId: board.id })
            : form === "edit" || form === "noop" || form === "comment" || form === "links"
              ? call(thread, "card_update", {
                  card: card.id,
                  ...(form === "edit" ? { description: "Changed while delivery waits" } : {}),
                  ...(form === "comment" ? { comment: "I am working on this" } : {}),
                  ...(form === "links" ? { links: [{ url: "https://example.com/change" }] } : {}),
                })
              : call(
                  thread,
                  "card_get",
                  form === "id"
                    ? { card: card.id }
                    : form === "number"
                      ? { card: `#${card.number}` }
                      : {},
                );
        return Effect.forkChild(
          request.pipe(Effect.provideService(McpServer.McpServer, server)),
        ).pipe(
          Effect.flatMap(Fiber.join),
          Effect.tap((reply) =>
            Effect.sync(() => {
              assert.isFalse(reply.isError, reply.text);
              const read =
                form === "board"
                  ? (reply.structured.board as { cards: Array<{ activeThreadId: string }> })
                      .cards[0]!
                  : (reply.structured.card as { activeThreadId: string });
              assert.strictEqual(read.activeThreadId, thread);
            }),
          ),
          Effect.orDie,
          Effect.andThen(
            Effect.fail(
              new KanbanThreadError({
                operation: "send",
                detail: "Final rejection",
                rejected: true,
              }),
            ),
          ),
        );
      };
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(card.id)).card.activeThreadId, thread);
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: thread,
      });
    }).pipe(Effect.provide(layer));
  },
);

// card_wait: an evaluator (a thread outside the board) parks a reviewed card that no thread runs.
const waitFixture = Effect.gen(function* () {
  const kanban = yield* KanbanService.KanbanService;
  const store = yield* KanbanStore.KanbanStore;
  const board = yield* kanban.ensureBoard({
    slug: "toy",
    name: "Toy",
    defaultProjectId: ProjectId.make("project-1"),
  });
  const pr = "https://github.com/acme/app/pull/12";
  const created = yield* kanban.createCard(
    board.id,
    {
      prompt: "Review PR 12",
      title: "Review PR 12",
      description: "External PR",
      links: [{ url: pr }],
    },
    owner,
  );
  // As the dispatcher leaves it after a review: in review, no thread.
  const reviewed = { ...created, stage: "in_review" as const, reviewStep: 1 };
  yield* store.putCard(reviewed);
  const other = yield* kanban.createCard(
    board.id,
    { prompt: "Parent work", title: "Parent work", description: "Explicit" },
    owner,
  );
  return { kanban, store, board, card: reviewed, other, pr };
});
const evaluatorThread = ThreadId.make("outside-evaluator");

it.effect("card_wait sets a push wait from the card's last review, logs it and clears it", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, store, card, pr } = yield* waitFixture;
    const head = "f8eac05b9a19d81842c9247e3b448895656bf778";

    // No reviewed commit on the card yet, and none passed: nothing to compare a push against.
    const blind = yield* call(evaluatorThread, "card_wait", {
      card: `#${card.number}`,
      on: "push",
      note: "Jashwanth to push the fix",
    });
    assert.isTrue(blind.isError);
    assert.include(blind.text, "a push wait needs head");

    yield* store.addCardEvent({
      cardId: card.id,
      at: "2026-11-10T08:00:00.000Z",
      actor: { _tag: "thread", threadId: ThreadId.make("reviewer") },
      kind: "review",
      fromStage: "in_review",
      toStage: "in_review",
      body: "clear",
      head,
    });
    const set = yield* call(evaluatorThread, "card_wait", {
      card: `#${card.number}`,
      on: "push",
      note: "Jashwanth to push the fix",
    });
    assert.isFalse(set.isError, set.text);
    const waiting = (yield* kanban.card(card.id)).card;
    assert.deepInclude(waiting.wait, {
      on: "push",
      pr,
      sinceHead: head,
      note: "Jashwanth to push the fix",
      wakeRole: null,
      expiredAt: null,
    });
    assert.deepStrictEqual(waiting.wait?.by, { _tag: "evaluator", threadId: evaluatorThread });
    assert.strictEqual(waiting.stage, "in_review");
    // The engine acts on waits now, so the reply carries no "not live" caveat.
    assert.isUndefined(set.structured.note);
    // The board feed carries it to clients.
    const fed = (yield* kanban.replySnapshot(waiting.boardId)).cards.find(
      (entry) => entry.id === card.id,
    );
    assert.strictEqual(fed?.wait?.on, "push");

    const events = (yield* kanban.card(card.id)).events;
    // Logged as a plain edit until the wait event kinds are live: an installed
    // client that doesn't know them can't load a card whose history has one.
    assert.deepInclude(events.at(-1), {
      kind: "edited",
      body: "Waiting for the author to push to app#12: Jashwanth to push the fix",
    });

    // A second wait replaces the first: a card has one.
    const replaced = yield* call(evaluatorThread, "card_wait", {
      card: `#${card.number}`,
      on: "merge",
      pr: "#12",
      note: "merge go given, waiting for it to land",
      wakeRole: "evaluator",
    });
    assert.isFalse(replaced.isError, replaced.text);
    assert.deepInclude((yield* kanban.card(card.id)).card.wait, {
      on: "merge",
      sinceHead: null,
      wakeRole: "evaluator",
    });

    const cleared = yield* call(evaluatorThread, "card_wait", {
      card: `#${card.number}`,
      clear: true,
    });
    assert.isFalse(cleared.isError, cleared.text);
    const after = yield* kanban.card(card.id);
    assert.isUndefined(after.card.wait);
    assert.deepInclude(after.events.at(-1), {
      kind: "edited",
      body: "Wait ended: cleared by hand (was waiting for app#12 to merge)",
    });
    const again = yield* call(evaluatorThread, "card_wait", {
      card: `#${card.number}`,
      clear: true,
    });
    assert.isTrue(again.isError);
    assert.include(again.text, "has no wait to clear");
  }).pipe(Effect.provide(layer));
});

it.effect("card_wait accepts a cross-board waitsOn id", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, store, card } = yield* waitFixture;
    const foreign = yield* kanban.ensureBoard({
      slug: "foreign",
      name: "Foreign",
      defaultProjectId: null,
    });
    const target = yield* kanban.createCard(
      foreign.id,
      { prompt: "Dependency", title: "Dependency", description: "Explicit" },
      owner,
    );
    const reply = yield* call(evaluatorThread, "card_wait", {
      card: card.id,
      on: "card",
      waitsOn: target.id,
      wakeRole: "evaluator",
      note: "foreign dependency",
    });
    assert.isFalse(reply.isError, reply.text);
    const detail = yield* kanban.card(card.id);
    assert.deepInclude(detail.card.wait, { on: "card", card: target.id, wakeRole: "evaluator" });
    assert.include(detail.events.at(-1)?.body ?? "", `#${target.number} (Foreign)`);
    const summary = yield* call(evaluatorThread, "board_get", { boardId: card.boardId });
    assert.isFalse(summary.isError, summary.text);
    assert.include(
      JSON.stringify(summary.structured),
      `Waiting for card #${target.number} (Foreign)`,
    );
    const paged = yield* call(evaluatorThread, "board_get", { boardId: card.boardId, limit: 1 });
    assert.include(
      JSON.stringify(paged.structured),
      `Waiting for card #${target.number} (Foreign)`,
    );
    const expectedTarget = {
      id: target.id,
      number: target.number,
      boardId: foreign.id,
      boardName: "Foreign",
    };
    assert.deepStrictEqual(detail.card.wait?.cardTarget, expectedTarget);
    const read = yield* call(evaluatorThread, "card_get", { card: card.id });
    assert.include(JSON.stringify(read.structured), `"boardName":"Foreign"`);
    const apiPage = yield* kanban.cardPage({ board: card.boardId, fields: ["wait"], limit: 1 });
    assert.deepStrictEqual(apiPage.cards[0]?.wait?.cardTarget, expectedTarget);
    assert.deepStrictEqual(
      (yield* kanban.cards(card.boardId)).find((entry) => entry.id === card.id)?.wait?.cardTarget,
      expectedTarget,
    );
    for (const snapshot of [
      yield* kanban.snapshot(card.boardId),
      yield* kanban.replySnapshot(card.boardId),
    ]) {
      assert.isFalse(snapshot.cards.some((entry) => entry.id === target.id));
      assert.deepStrictEqual(
        snapshot.cards.find((entry) => entry.id === card.id)?.wait?.cardTarget,
        expectedTarget,
      );
    }
    assert.isUndefined(
      (yield* store.card(card.id))?.wait?.cardTarget,
      "display metadata is not persisted",
    );
    yield* kanban.updateBoard(foreign.id, { name: "Renamed foreign" });
    assert.strictEqual(
      (yield* kanban.card(card.id)).card.wait?.cardTarget?.boardName,
      "Renamed foreign",
    );
    yield* kanban.updateBoard(foreign.id, { name: "Foreign" });
    const moved = yield* call(evaluatorThread, "card_move", { card: card.id, to: "todo" });
    assert.isFalse(moved.isError, moved.text);
    assert.include(String(moved.structured.message), `#${target.number} (Foreign)`);
    const cleared = yield* kanban.card(card.id);
    assert.isUndefined(cleared.card.wait);
    assert.isTrue(
      cleared.events.some((event) => event.body?.includes(`card #${target.number} (Foreign)`)),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("card_wait validates the PR, the card, the time and the owner question it names", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, card, other } = yield* waitFixture;
    const wait = (args: Record<string, unknown>) =>
      call(evaluatorThread, "card_wait", { card: `#${card.number}`, note: "why", ...args });

    const missing = yield* wait({});
    assert.isTrue(missing.isError);
    assert.include(missing.text, "Pass on");

    const noNote = yield* call(evaluatorThread, "card_wait", {
      card: `#${card.number}`,
      on: "merge",
    });
    assert.isTrue(noNote.isError);
    assert.include(noNote.text, "one-line note");

    const wrongPr = yield* wait({ on: "merge", pr: "https://github.com/acme/app/pull/99" });
    assert.isTrue(wrongPr.isError);
    assert.include(wrongPr.text, "has no pull request app#99; it has app#12");

    const noCard = yield* wait({ on: "card" });
    assert.isTrue(noCard.isError);
    assert.include(noCard.text, "say which card");
    const ghost = yield* wait({ on: "card", waitsOn: "#999" });
    assert.isTrue(ghost.isError);
    assert.include(ghost.text, "No card #999");
    const self = yield* wait({ on: "card", waitsOn: `#${card.number}` });
    assert.isTrue(self.isError);
    assert.include(self.text, "can't wait on itself");

    const held = yield* wait({ on: "card", waitsOn: `#${other.number}`, note: "after the parent" });
    assert.isFalse(held.isError, held.text);
    assert.deepInclude((yield* kanban.card(card.id)).card.wait, { on: "card", card: other.id });
    assert.strictEqual(
      (yield* kanban.card(card.id)).events.at(-1)?.body,
      `Waiting for card #${other.number}: after the parent`,
    );

    // The test clock starts at the epoch.
    const past = yield* wait({ on: "time", until: "1969-12-31T00:00:00.000Z" });
    assert.isTrue(past.isError);
    assert.include(past.text, "until is in the past");
    const far = yield* wait({ on: "time", until: "1970-03-01T00:00:00.000Z" });
    assert.isTrue(far.isError);
    assert.include(far.text, "more than 30 days ahead");
    const timed = yield* wait({ on: "time", until: "1970-01-02T09:00:00.000Z", note: "recheck" });
    assert.isFalse(timed.isError, timed.text);
    assert.deepInclude((yield* kanban.card(card.id)).card.wait, {
      on: "time",
      until: "1970-01-02T09:00:00.000Z",
    });
    const never = yield* wait({ on: "time" });
    assert.isTrue(never.isError);
    assert.include(never.text, "a time wait needs until");

    // owner_go rides on a real question: without one it points at card_ask.
    const noAsk = yield* wait({ on: "owner_go" });
    assert.isTrue(noAsk.isError);
    assert.include(noAsk.text, "ask it first with card_ask");
    const asked = yield* call(evaluatorThread, "card_ask", {
      card: `#${card.number}`,
      question: "Merge PR 12 now?",
    });
    assert.isFalse(asked.isError, asked.text);
    const go = yield* wait({ on: "owner_go", ask: "q1", note: "merge go" });
    assert.isFalse(go.isError, go.text);
    assert.deepInclude((yield* kanban.card(card.id)).card.wait, { on: "owner_go", ask: "q1" });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "card_wait takes over a stalled flag, holds a To-Do card back from the dispatcher, and defers its running worker's wait",
  () => {
    const { layer, running: liveThreads } = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, store, board, card, other } = yield* waitFixture;

      // How evaluators park cards today: a stalled flag with the wait in its reason.
      yield* kanban.flagCard(card.id, "Waiting on jashwanth9845 for a new head on app#12.", {
        _tag: "evaluator",
        threadId: evaluatorThread,
      });
      const set = yield* call(evaluatorThread, "card_wait", {
        card: `#${card.number}`,
        on: "merge",
        note: "author merges after the fix",
      });
      assert.isFalse(set.isError, set.text);
      const waiting = yield* kanban.card(card.id);
      assert.isNull(waiting.card.stalled);
      assert.include(
        waiting.events.at(-1)?.body ?? "",
        "replaces the stalled flag: Waiting on jashwanth9845",
      );

      // To-Do: the wait holds the card back. The dispatcher has a free slot and leaves it alone.
      const todo = yield* call(evaluatorThread, "card_wait", {
        card: `#${other.number}`,
        on: "time",
        until: "1970-01-02T00:00:00.000Z",
        note: "later",
      });
      assert.isFalse(todo.isError, todo.text);
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      yield* kanban.dispatchNow;
      const held = (yield* kanban.card(other.id)).card;
      assert.strictEqual(held.stage, "todo");
      assert.isNull(held.activeThreadId);
      assert.strictEqual(held.wait?.on, "time");

      // Cleared, it is an ordinary To-Do card again and the dispatcher starts it.
      const cleared = yield* call(evaluatorThread, "card_wait", {
        card: `#${other.number}`,
        clear: true,
      });
      assert.isFalse(cleared.isError, cleared.text);
      yield* kanban.dispatchNow;
      const running = (yield* kanban.card(other.id)).card;
      assert.isNotNull(running.activeThreadId);
      liveThreads.add(running.activeThreadId!);
      // The wait must not free the slot while this worker still runs.
      const own = yield* call(running.activeThreadId!, "card_wait", {
        on: "time",
        until: "1970-01-02T00:00:00.000Z",
        note: "later",
      });
      assert.isFalse(own.isError, own.text);
      assert.include(own.text, "Wait set; it starts when your turn ends. End your turn now.");
      yield* store.putCard({ ...(yield* kanban.card(running.id)).card, links: card.links });
      const ci = yield* call(running.activeThreadId!, "card_wait", {
        on: "ci",
        pr: card.links[0]!.url,
        note: "checks finish",
      });
      assert.isTrue(ci.isError);
      assert.include(
        ci.text,
        "This card is yours and you are running, so the board can't park it. Waiting on CI for a PR: call watch_pull_request on it and end your turn; the board waits while the watch is on and the watch wakes you.",
      );
      const evaluator = yield* call(evaluatorThread, "card_wait", {
        card: `#${running.number}`,
        on: "ci",
        note: "checks finish",
      });
      assert.isTrue(evaluator.isError);
      assert.include(
        evaluator.text,
        `card #${running.number} has a running thread, so it isn't waiting. Set the wait once the thread has handed the card on`,
      );
      const after = (yield* kanban.card(running.id)).card;
      assert.strictEqual(after.wait?.on, "time");
      assert.strictEqual(after.activeThreadId, running.activeThreadId);
      // And it can't touch another thread's card.
      const foreign = yield* call(running.activeThreadId!, "card_wait", {
        card: `#${card.number}`,
        clear: true,
      });
      assert.isTrue(foreign.isError);
      assert.include(foreign.text, "works on other cards");
      assert.isDefined((yield* store.card(card.id))?.wait);
    }).pipe(Effect.provide(layer));
  },
);

const ownedWaitFixture = Effect.gen(function* () {
  const fixture = yield* waitFixture;
  yield* fixture.kanban.setPool(fixture.board.id, fixture.board.defaultCardModel, 1);
  yield* fixture.kanban.dispatchNow;
  const owned = (yield* fixture.kanban.card(fixture.other.id)).card;
  assert.isNotNull(owned.workThreadId);
  return { ...fixture, owned, worker: owned.workThreadId! };
});

it.effect("a worker's deferred wait is parked under turn admission", () => {
  const fake = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, store, owned, worker } = yield* ownedWaitFixture;
    fake.running.add(worker);
    const set = yield* call(worker, "card_wait", {
      on: "time",
      until: "1970-01-01T01:00:00.000Z",
      note: "retry later",
    });
    assert.isFalse(set.isError, set.text);
    fake.running.delete(worker);
    const writing = yield* Deferred.make<void>();
    const commit = yield* Deferred.make<void>();
    const attempting = yield* Deferred.make<void>();
    fake.storeControl.beforeCardEvent = (event) =>
      event.body === "Turn ended; parked on the worker's wait"
        ? Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(commit)))
        : Effect.void;
    const parking = yield* kanban.turnEnded(worker).pipe(Effect.forkChild);
    yield* Deferred.await(writing);
    const admission = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const starting = yield* Deferred.succeed(attempting, undefined).pipe(
      Effect.andThen(
        admission.withLock(
          worker,
          Effect.gen(function* () {
            const parked = yield* store.card(owned.id);
            assert.isNull(parked?.activeThreadId);
            assert.strictEqual(parked?.workThreadId, worker);
            fake.running.add(worker);
          }),
        ),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(attempting);
    assert.isFalse(fake.running.has(worker));
    yield* Deferred.succeed(commit, undefined);
    yield* Fiber.join(parking);
    yield* Fiber.join(starting);
    assert.isTrue(fake.running.has(worker));
  }).pipe(Effect.provide(fake.layer));
});

it.effect("#1462 evaluator parks an idle worker and expiry wakes that same thread", () => {
  const sends: Array<{ threadId: ThreadId; text: string }> = [];
  const fake = fakeThreads(undefined, undefined, undefined, undefined, undefined, {
    findExisting: true,
    send: (input) =>
      Effect.sync(() => {
        sends.push(input);
      }),
  });
  return Effect.gen(function* () {
    const { kanban, owned, worker } = yield* ownedWaitFixture;
    const result = yield* call(evaluatorThread, "card_wait", {
      card: owned.id,
      on: "time",
      until: "1970-01-01T01:00:00.000Z",
      note: "retry the deployment",
      wakeRole: "work",
    });
    assert.isFalse(result.isError, result.text);
    const parked = (yield* kanban.card(owned.id)).card;
    assert.strictEqual(parked.stage, "todo");
    assert.isNull(parked.activeThreadId);
    assert.isNull(parked.activeRole);
    assert.isNull(parked.activePool);
    assert.strictEqual(parked.workThreadId, worker);
    assert.strictEqual(parked.wait?.on, "time");
    yield* kanban.dispatchNow;
    assert.isNull((yield* kanban.card(owned.id)).card.activeThreadId);
    yield* TestClock.adjust("1 hour");
    yield* kanban.tick;
    yield* kanban.dispatchNow;
    const woke = (yield* kanban.card(owned.id)).card;
    assert.isUndefined(woke.wait);
    assert.strictEqual(woke.activeThreadId, worker);
    assert.strictEqual(woke.workThreadId, worker);
    assert.isTrue(
      sends.some((send) => send.threadId === worker && send.text.includes("retry the deployment")),
    );
    assert.lengthOf(fake.launches, 1);
  }).pipe(Effect.provide(fake.layer));
});

it.effect.each(["running", "queued", "race"] as const)(
  "#1462 evaluator refuses a worker with %s work before committing a wait",
  (state) => {
    const fake = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, owned, worker } = yield* ownedWaitFixture;
      if (state === "running") fake.running.add(worker);
      if (state === "queued") fake.queued.add(worker);
      let reads = 0;
      if (state === "race")
        fake.viewControl.beforeRead = (id) =>
          Effect.sync(() => {
            if (id === worker && ++reads === 2) fake.running.add(worker);
          });
      const before = yield* kanban.card(owned.id);
      const result = yield* call(evaluatorThread, "card_wait", {
        card: owned.id,
        on: "time",
        until: "1970-01-01T01:00:00.000Z",
        note: "retry the deployment",
        wakeRole: "work",
      });
      assert.isTrue(result.isError, result.text);
      assert.include(result.text, "has a running thread, so it isn't waiting");
      const after = yield* kanban.card(owned.id);
      assert.isUndefined(after.card.wait);
      assert.strictEqual(after.card.activeThreadId, worker);
      assert.strictEqual(after.card.stage, "working");
      assert.deepStrictEqual(after.events, before.events);
      if (state === "race") assert.strictEqual(reads, 2);
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect.each([2, 3])("#1462 refuses a turn starting during queue read %s", (startAtRead) => {
  const fake = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, owned, worker } = yield* ownedWaitFixture;
    let queueReads = 0;
    fake.queued.has = (id) => {
      if (id === worker && ++queueReads === startAtRead) fake.running.add(worker);
      return false;
    };
    const result = yield* call(evaluatorThread, "card_wait", {
      card: owned.id,
      on: "time",
      until: "1970-01-01T01:00:00.000Z",
      note: "retry the deployment",
      wakeRole: "work",
    });
    const after = (yield* kanban.card(owned.id)).card;
    assert.isTrue(fake.running.has(worker), "the new turn started before the wait write");
    assert.isTrue(
      result.isError,
      `accepted a live turn: stage=${after.stage}, activeThreadId=${after.activeThreadId}, wait=${after.wait?.on}`,
    );
    assert.isUndefined(after.wait);
    assert.strictEqual(after.activeThreadId, worker);
  }).pipe(Effect.provide(fake.layer));
});

it.effect.each(["event", "card"] as const)(
  "#1462 turn admission waits through the %s write",
  (boundary) => {
    const fake = fakeThreads();
    return Effect.gen(function* () {
      const { store, owned, worker } = yield* ownedWaitFixture;
      const admission = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const writing = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const attempting = yield* Deferred.make<void>();
      const holdCommit = Deferred.succeed(writing, undefined).pipe(
        Effect.andThen(Deferred.await(commit)),
      );
      if (boundary === "event") {
        fake.storeControl.beforeCardEvent = (event) =>
          event.cardId === owned.id && event.body?.startsWith("Waiting ")
            ? holdCommit
            : Effect.void;
      } else {
        fake.storeControl.beforeCardWrite = () => holdCommit;
      }
      const parking = yield* call(evaluatorThread, "card_wait", {
        card: owned.id,
        on: "time",
        until: "1970-01-01T01:00:00.000Z",
        note: "retry the deployment",
        wakeRole: "work",
      }).pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const starting = yield* Deferred.succeed(attempting, undefined).pipe(
        Effect.andThen(
          admission.withLock(
            worker,
            Effect.gen(function* () {
              const parked = yield* store.card(owned.id);
              assert.strictEqual(parked?.wait?.on, "time");
              assert.isNull(parked?.activeThreadId);
              fake.running.add(worker);
            }),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(attempting);
      assert.isFalse(fake.running.has(worker));
      yield* Deferred.succeed(commit, undefined);
      const result = yield* Fiber.join(parking);
      assert.isFalse(result.isError, result.text);
      yield* Fiber.join(starting);
      assert.isTrue(fake.running.has(worker));
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect.each(["move", "answer", "clear"] as const)(
  "#1462 an evaluator-parked worker accepts a later %s",
  (action) => {
    const fake = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, owned, worker } = yield* ownedWaitFixture;
      const result = yield* call(evaluatorThread, "card_wait", {
        card: owned.id,
        on: "time",
        until: "1970-01-01T01:00:00.000Z",
        note: "retry the deployment",
        wakeRole: "work",
      });
      assert.isFalse(result.isError, result.text);
      if (action === "answer") {
        const answer = yield* kanban.answerWait(
          owned.id,
          { result: "wake", note: "deployment is ready" },
          { script: null },
          { _tag: "system", component: "test" },
          true,
        );
        assert.include(answer, "woke its worker");
      } else {
        const changed = yield* call(
          evaluatorThread,
          action === "move" ? "card_move" : "card_wait",
          {
            card: owned.id,
            ...(action === "move"
              ? { to: "needs_review", note: "ready for review" }
              : { clear: true }),
          },
        );
        assert.isFalse(changed.isError, changed.text);
      }
      const after = yield* kanban.card(owned.id);
      assert.isUndefined(after.card.wait);
      assert.strictEqual(after.card.workThreadId, worker);
      if (action === "move") {
        assert.strictEqual(after.card.stage, "needs_review");
        assert.include(after.events.at(-2)?.body ?? "", "the card was moved to needs_review");
      } else assert.strictEqual(after.card.stage, "todo");
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect.each([
  { tool: "card_update", mode: "encode" },
  { tool: "card_update", mode: "slow" },
  { tool: "card_update", mode: "budget" },
  { tool: "card_edit", mode: "conflict" },
  { tool: "card_edit", mode: "encode" },
  { tool: "card_move", mode: "conflict" },
] as const)("saved $tool gets a read-back success when its reply is $mode", ({ tool, mode }) =>
  Effect.gen(function* () {
    const saved = yield* Deferred.make<void>();
    const fake = fakeThreads(undefined, undefined, undefined, undefined, { mode, saved });
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "reply",
        name: "Reply",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "Fix reply", title: "Fix reply" },
        { _tag: "owner" },
      );
      const request = yield* call(ThreadId.make("outside"), tool, {
        card: card.id,
        ...(tool === "card_move"
          ? { to: "needs_review", note: "Saved exactly once" }
          : { comment: "Saved exactly once" }),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(saved);
      if (mode === "slow") yield* TestClock.adjust("25 seconds");
      const reply = yield* Fiber.join(request);
      assert.isFalse(reply.isError);
      assert.include(reply.text, "Saved");
      assert.strictEqual(reply.structured.saved, true);
      const detail = yield* kanban.card(card.id);
      if (tool === "card_move") assert.strictEqual(detail.card.stage, "needs_review");
      assert.lengthOf(
        detail.events.filter((event) => event.body === "Saved exactly once"),
        1,
      );
    }).pipe(Effect.provide(fake.layer));
  }),
);

it.effect.each(["card_move", "card_review_result", "subtask_done", "subtask_done_repeat"] as const)(
  "card-thread %s distinguishes a saved reply conflict from a refused repeat",
  (tool) =>
    Effect.gen(function* () {
      const saved = yield* Deferred.make<void>();
      let enabled = false;
      const fake = fakeThreads(undefined, undefined, undefined, undefined, {
        mode: "conflict",
        saved,
        enabled: () => enabled,
      });
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const board = yield* kanban.ensureBoard({
          slug: "worker-reply",
          name: "Worker reply",
          defaultProjectId: ProjectId.make("project-1"),
        });
        yield* kanban.setPool(board.id, board.defaultCardModel, 3);
        const card = yield* kanban.createCard(
          board.id,
          {
            title: "Reply",
            prompt: "Reply",
            subtasks: [
              { step: 1, owner: "work", text: "Implement" },
              { step: 2, owner: "review", text: "Review" },
            ],
          },
          owner,
        );
        yield* kanban.dispatchNow;
        const worker = (yield* kanban.card(card.id)).card.workThreadId!;
        if (tool !== "subtask_done") {
          yield* kanban.markSubtask(
            card.id,
            "s1",
            "done",
            "Done",
            { _tag: "thread", threadId: worker },
            "work",
          );
        }
        let caller = worker;
        if (tool === "card_review_result") {
          yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
            _tag: "thread",
            threadId: worker,
          });
          yield* kanban.dispatchNow;
          caller = (yield* kanban.card(card.id)).card.reviewThreadId!;
        }
        enabled = true;
        const result = yield* call(
          caller,
          tool === "subtask_done_repeat" ? "subtask_done" : tool,
          tool === "card_move"
            ? { card: card.id, to: "needs_review", note: "Saved once" }
            : tool === "card_review_result"
              ? { verdict: "clear", head: "27a1b1e0" }
              : { card: card.id, subtask: "s1", state: "done", note: "Saved once" },
        );
        if (tool === "subtask_done_repeat") {
          assert.isTrue(result.isError, result.text);
          assert.include(result.text, "subtask s1 is already done");
          assert.isUndefined(result.structured.saved);
          const detail = yield* kanban.card(card.id);
          assert.lengthOf(
            detail.events.filter((event) => event.kind === "subtask"),
            1,
          );
          assert.strictEqual(detail.card.subtasks[0]?.note, "Done");
          return;
        }
        assert.isFalse(result.isError, result.text);
        assert.strictEqual(result.structured.saved, true);
        const detail = yield* kanban.card(card.id);
        assert.deepStrictEqual(result.structured.card, {
          id: card.id,
          number: card.number,
          stage: detail.card.stage,
        });
        assert.lengthOf(
          detail.events.filter((event) =>
            tool === "card_review_result"
              ? event.kind === "review" && event.head === "27a1b1e0"
              : event.body?.includes("Saved once"),
          ),
          1,
        );
        if (tool === "card_move") assert.strictEqual(detail.card.stage, "needs_review");
        if (tool === "card_review_result")
          assert.strictEqual(detail.card.subtasks[1]?.state, "done");
        if (tool.startsWith("subtask_done"))
          assert.strictEqual(detail.card.subtasks[0]?.note, "Saved once");
      }).pipe(Effect.provide(fake.layer));
    }),
);

it.effect.each(["card_move", "card_review_result"] as const)(
  "%s keeps its saved result when a concurrent board edit invalidates post-commit I/O",
  (tool) =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const fake = fakeThreads(undefined, undefined, undefined, undefined, undefined, {
        findExisting: true,
        send: () => Effect.void,
      });
      const warnings: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        warnings.push(message);
      });
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const store = yield* KanbanStore.KanbanStore;
        const board = yield* kanban.ensureBoard({
          slug: "board-race",
          name: "Board race",
          defaultProjectId: ProjectId.make("project-1"),
        });
        yield* kanban.setPool(board.id, board.defaultCardModel, 3);
        const card = yield* kanban.createCard(
          board.id,
          {
            title: "Race",
            prompt: "Race",
            subtasks: [
              { step: 1, owner: "work", text: "Implement" },
              { step: 2, owner: "review", text: "Review" },
              { step: 3, owner: "evaluator", text: "Merge" },
            ],
          },
          owner,
        );
        yield* kanban.postToCard(card.id, owner, [{ _tag: "md", text: "Prepare the handoff" }]);
        yield* kanban.dispatchNow;
        const worker = (yield* kanban.card(card.id)).card.workThreadId!;
        yield* kanban.markSubtask(
          card.id,
          "s1",
          "done",
          "Done",
          { _tag: "thread", threadId: worker },
          "work",
        );
        let caller = worker;
        if (tool === "card_review_result") {
          yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
            _tag: "thread",
            threadId: worker,
          });
          yield* kanban.dispatchNow;
          caller = (yield* kanban.card(card.id)).card.reviewThreadId!;
        }
        let blocked = false;
        fake.viewControl.beforeRead = () =>
          Effect.gen(function* () {
            if (blocked) return;
            const events = yield* store.cardEvents(card.id).pipe(Effect.orDie);
            if (
              !events.some((event) =>
                tool === "card_move"
                  ? event.kind === "moved" && event.body === "Saved race"
                  : event.kind === "review" && event.head === "27a1b1e0",
              )
            )
              return;
            blocked = true;
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(resume);
          });
        warnings.length = 0;
        const request = yield* call(
          caller,
          tool,
          tool === "card_move"
            ? { card: card.id, to: "needs_review", note: "Saved race" }
            : { verdict: "clear", head: "27a1b1e0" },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(held);
        yield* kanban.updateBoard(board.id, { name: "Changed concurrently" });
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.join(request);
        assert.isFalse(result.isError, result.text);
        const detail = yield* kanban.card(card.id);
        assert.isUndefined(result.structured.saved);
        assert.deepStrictEqual(result.structured.card, detail.card);
        const applied = detail.card;
        assert.lengthOf(
          detail.events.filter((event) =>
            tool === "card_move"
              ? event.kind === "moved" && event.body === "Saved race"
              : event.kind === "review" && event.head === "27a1b1e0",
          ),
          1,
        );
        if (tool === "card_move") assert.strictEqual(applied.stage, "needs_review");
        else assert.strictEqual(detail.card.subtasks[1]?.state, "done");
        assert.isFalse(result.isError);
        if (tool === "card_review_result") assert.strictEqual(result.structured.recorded, true);
      }).pipe(
        Effect.ensuring(Deferred.succeed(resume, undefined)),
        Effect.provide(
          fake.layer.pipe(
            Layer.provide(Layer.succeed(KanbanService.DeferWriteEffects, false)),
            Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
          ),
        ),
      );
    }),
);

it.effect("a worker keeps a pre-save conflict and does not change its card", () => {
  const fake = fakeThreads(
    undefined,
    new KanbanError({
      code: "conflict",
      detail: "Board changed during this operation. Re-read its state before retrying.",
    }),
  );
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "pre-conflict",
      name: "Pre-conflict",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const card = yield* kanban.createCard(
      board.id,
      { title: "Before save", prompt: "Before save" },
      owner,
    );
    yield* kanban.dispatchNow;
    const before = yield* kanban.card(card.id);
    const result = yield* call(before.card.workThreadId!, "card_update", {
      card: card.id,
      comment: "Not saved",
    });
    assert.isTrue(result.isError, result.text);
    assert.include(result.text, "Board changed during this operation");
    assert.isUndefined(result.structured.saved);
    assert.deepStrictEqual(yield* kanban.card(card.id), before);
  }).pipe(Effect.provide(fake.layer));
});

it.effect("card_move annotates queued review and refuses to interrupt a live reviewer", () => {
  const fake = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "move-reply",
      name: "Move reply",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 3);
    const card = yield* kanban.createCard(board.id, { prompt: "Move", title: "Move" }, owner);
    yield* kanban.dispatchNow;
    const worker = (yield* kanban.card(card.id)).card.workThreadId!;
    const first = yield* call(worker, "card_move", { card: card.id, to: "needs_review" });
    assert.isFalse(first.isError);
    const before = yield* kanban.card(card.id);
    const retry = yield* call(worker, "card_move", {
      card: card.id,
      to: "needs_review",
      note: "Other note",
    });
    assert.isFalse(retry.isError);
    assert.include(retry.text, "already queued for review; note added");
    const annotated = yield* kanban.card(card.id);
    assert.deepStrictEqual(annotated.card, before.card);
    assert.deepStrictEqual(annotated.events.slice(0, -1), before.events);
    assert.strictEqual(annotated.events.at(-1)?.body, "Other note");
    const comment = yield* call(worker, "card_update", {
      card: card.id,
      comment: "New head 14a4c162",
    });
    assert.isFalse(comment.isError, comment.text);
    yield* kanban.dispatchNow;
    const after = yield* kanban.card(card.id);
    assert.strictEqual(after.card.stage, "in_review");
    const dispatched = yield* call(worker, "card_move", { card: card.id, to: "needs_review" });
    assert.isTrue(dispatched.isError);
    assert.include(dispatched.text, "is being reviewed by another thread");
    assert.deepStrictEqual((yield* kanban.card(card.id)).events, after.events);
  }).pipe(Effect.provide(fake.layer));
});

it.effect("subtask advancement does not let the worker interrupt review after dispatch", () => {
  const fake = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const board = yield* kanban.ensureBoard({
      slug: "advance-dispatch",
      name: "Advance dispatch",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 3);
    const card = yield* kanban.createCard(
      board.id,
      {
        prompt: "CI finish",
        title: "CI finish",
        subtasks: [
          { step: 1, owner: "work", text: "Wait for CI" },
          { step: 2, owner: "review", text: "Review" },
        ],
      },
      owner,
    );
    yield* kanban.dispatchNow;
    const working = (yield* kanban.card(card.id)).card;
    const worker = working.workThreadId!;
    yield* store.putCard({
      ...working,
      stage: "todo",
      activeThreadId: null,
      activeRole: null,
      activePool: null,
    });
    const waiting = (yield* kanban.card(card.id)).card;
    assert.strictEqual(waiting.stage, "todo");
    assert.isNull(waiting.activeThreadId);
    assert.strictEqual(waiting.workThreadId, worker);
    const done = yield* call(worker, "subtask_done", {
      card: card.id,
      subtask: "s1",
      state: "done",
      note: "CI passed",
    });
    assert.isFalse(done.isError, done.text);
    const advanced = yield* kanban.card(card.id);
    assert.strictEqual(advanced.card.stage, "needs_review");
    const advance = advanced.events.findLast((event) => event.kind === "moved");
    assert.deepStrictEqual(advance?.actor, { _tag: "thread", threadId: worker });
    assert.strictEqual(advance?.fromStage, "todo");
    assert.strictEqual(advance?.toStage, "needs_review");
    assert.strictEqual(advance?.body, "Next step is the review");
    yield* kanban.dispatchNow;
    const reviewing = yield* kanban.card(card.id);
    const reviewer = reviewing.card.activeThreadId!;
    assert.strictEqual(reviewing.card.stage, "in_review");
    assert.strictEqual(reviewing.card.activeRole, "review");
    assert.isNotNull(reviewer);
    assert.notStrictEqual(reviewer, worker);
    const moved = yield* call(worker, "card_move", { card: card.id, to: "needs_review" });
    assert.isTrue(moved.isError, moved.text);
    assert.include(moved.text, "is being reviewed by another thread");
    const unrelated: KanbanActor = {
      _tag: "thread",
      threadId: ThreadId.make("unrelated-worker"),
    };
    const denied = yield* kanban
      .moveCard(card.id, "needs_review", "cardThread", unrelated)
      .pipe(Effect.flip);
    assert.strictEqual(denied.code, "denied");
    assert.include(denied.detail, "not assigned");
    const after = yield* kanban.card(card.id);
    assert.deepStrictEqual(after.events, reviewing.events);
    assert.deepStrictEqual(after.card, reviewing.card);
    assert.strictEqual(after.card.activeThreadId, reviewer);
  }).pipe(Effect.provide(fake.layer));
});

it.effect.each(["conflict", "encode"] as const)(
  "saved card_ask_change gets read-back success after %s reply failure",
  (mode) =>
    Effect.gen(function* () {
      const saved = yield* Deferred.make<void>();
      const fake = fakeThreads(undefined, undefined, undefined, undefined, { mode, saved });
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const board = yield* kanban.ensureBoard({
          slug: "ask-reply",
          name: "Ask reply",
          defaultProjectId: ProjectId.make("project-1"),
        });
        const card = yield* kanban.createCard(board.id, { prompt: "Ask", title: "Ask" }, owner);
        yield* kanban.askOwner(card.id, { question: "Proceed?", blocking: false }, owner, "owner");
        const reply = yield* call(ThreadId.make("outside"), "card_ask_change", {
          card: card.id,
          ask: "q1",
          action: "drop",
        });
        assert.isFalse(reply.isError, reply.text);
        assert.include(reply.text, "Saved");
        assert.strictEqual(reply.structured.saved, true);
        const detail = yield* kanban.card(card.id);
        assert.isNotNull(detail.card.asks[0]!.closedAt);
        assert.lengthOf(
          detail.events.filter((event) => event.body?.startsWith("Dropped q1:")),
          1,
        );
      }).pipe(Effect.provide(fake.layer));
    }),
);

it.effect(
  "card_ask_change keeps the error when discussion association saved but ask closure did not",
  () => {
    const fake = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const board = yield* kanban.ensureBoard({
        slug: "ask-open",
        name: "Ask open",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const card = yield* kanban.createCard(board.id, { prompt: "Ask", title: "Ask" }, owner);
      const evaluator = yield* kanban.startEvaluator(board.id, {
        kind: "request",
        text: "Context",
      });
      const asked = yield* kanban.askOwner(
        card.id,
        { question: "Proceed?", blocking: true },
        { _tag: "evaluator", threadId: evaluator },
        "evaluator",
      );
      yield* store.putCard({ ...asked, discussionId: null });
      const putCard = store.putCard;
      const failing = vi
        .spyOn(store, "putCard")
        .mockImplementation((next) =>
          next.id === card.id && next.asks[0]?.closedAt !== null
            ? Effect.die(new Error("ask-close write failed"))
            : putCard(next),
        );
      const reply = yield* call(ThreadId.make("outside"), "card_ask_change", {
        card: card.id,
        ask: "q1",
        action: "drop",
      });
      assert.isTrue(reply.isError, reply.text);
      assert.notStrictEqual(reply.structured.saved, true);
      const after = (yield* kanban.card(card.id)).card;
      assert.isNotNull(after.discussionId);
      assert.isNull(after.asks[0]!.closedAt);
      assert.strictEqual(after.stage, "needs_owner");
      failing.mockRestore();
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect.each(
  (["card", "discussion"] as const).flatMap((target) =>
    (["conflict", "encode", "slow"] as const).flatMap((mode) =>
      [false, true].map((dedupe) => ({ target, mode, dedupe })),
    ),
  ),
)(
  "saved discussion_post ($target, $mode, dedupe=$dedupe) returns its sequence",
  ({ target, mode, dedupe }) =>
    Effect.gen(function* () {
      const saved = yield* Deferred.make<void>();
      const fake = fakeThreads(undefined, undefined, undefined, undefined, { mode, saved });
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const board = yield* kanban.ensureBoard({
          slug: "post-reply",
          name: "Reply",
          defaultProjectId: ProjectId.make("project-1"),
        });
        const card = yield* kanban.createCard(board.id, { title: "Post", prompt: "Post" }, owner);
        const discussion = yield* kanban.cardDiscussion(card.id);
        const thread = ThreadId.make("outside");
        if (dedupe) {
          const store = yield* KanbanStore.KanbanStore;
          yield* store.putMessage({
            discussionId: discussion.id,
            seq: 1,
            author: { _tag: "evaluator", threadId: thread },
            authorName: "Agent",
            blocks: [{ _tag: "md", text: "Saved exactly once" }],
            answers: [],
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
          });
          yield* store.putDiscussion({ ...discussion, lastSeq: 1 });
        }
        const request = yield* call(thread, "discussion_post", {
          ...(target === "card" ? { card: card.id } : { discussionId: discussion.id }),
          text: "Saved exactly once",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(saved);
        if (mode === "slow") yield* TestClock.adjust("25 seconds");
        const result = yield* Fiber.join(request);
        assert.isFalse(result.isError, result.text);
        assert.strictEqual(result.structured.saved, true);
        assert.deepStrictEqual(result.structured.message, { discussionId: discussion.id, seq: 1 });
        assert.deepStrictEqual(
          (yield* kanban.messages(discussion.id)).map(({ seq, author, blocks }) => ({
            seq,
            author,
            blocks,
          })),
          [
            {
              seq: 1,
              author: { _tag: "evaluator", threadId: thread },
              blocks: [{ _tag: "md", text: "Saved exactly once" }],
            },
          ],
        );
      }).pipe(Effect.provide(fake.layer));
    }),
);

it.effect.each(["card", "discussion"] as const)(
  "discussion_post to %s keeps a conflict when no message was saved",
  (target) => {
    const error = new KanbanError({
      code: "conflict",
      detail: "Board changed during this operation. Re-read its state before retrying.",
    });
    const fake = fakeThreads(undefined, undefined, error);
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "post-conflict",
        name: "Conflict",
        defaultProjectId: null,
      });
      const card = yield* kanban.createCard(board.id, { title: "Post", prompt: "Post" }, owner);
      const discussion = yield* kanban.cardDiscussion(card.id);
      const result = yield* call(ThreadId.make("outside"), "discussion_post", {
        ...(target === "card" ? { card: card.id } : { discussionId: discussion.id }),
        text: "Not saved",
      });
      assert.isTrue(result.isError, result.text);
      assert.include(result.text, "Board changed");
      assert.lengthOf(yield* kanban.messages(discussion.id), 0);
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect.each(["card", "discussion"] as const)(
  "discussion_post to %s says not saved when its reply times out before a save",
  (target) =>
    Effect.gen(function* () {
      const saved = yield* Deferred.make<void>();
      const fake = fakeThreads(undefined, undefined, undefined, undefined, {
        mode: "pre-save",
        saved,
      });
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const board = yield* kanban.ensureBoard({
          slug: "post-timeout",
          name: "Timeout",
          defaultProjectId: null,
        });
        const card = yield* kanban.createCard(board.id, { title: "Post", prompt: "Post" }, owner);
        const discussion = yield* kanban.cardDiscussion(card.id);
        const request = yield* call(ThreadId.make("outside"), "discussion_post", {
          ...(target === "card" ? { card: card.id } : { discussionId: discussion.id }),
          text: "Not saved",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(saved);
        yield* TestClock.adjust("25 seconds");
        const result = yield* Fiber.join(request);
        assert.isTrue(result.isError, result.text);
        assert.strictEqual(result.structured.saved, false);
        assert.include(result.text, "Not saved (board busy). Safe to retry.");
        assert.lengthOf(yield* kanban.messages(discussion.id), 0);
      }).pipe(Effect.provide(fake.layer));
    }),
);

const boardScript = (boardId: string, name: string, enabled = true) =>
  ({
    id: `script-${name}`,
    boardId,
    name,
    path: `/tmp/board-scripts/${name}.py`,
    trigger: { _tag: "manual" },
    enabled,
    createdBy: owner,
    createdAt: "2026-11-01T10:00:00.000Z",
    lastRun: null,
  }) as never;

it.effect(
  "card_wait parks a card on a board script's check, and only on one the board has turned on",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, store, board, card } = yield* waitFixture;
      const wait = (args: Record<string, unknown>) =>
        call(evaluatorThread, "card_wait", {
          card: `#${card.number}`,
          note: "ENG-123 to reach Done",
          ...args,
        });

      const none = yield* wait({ script: "linear-state" });
      assert.isTrue(none.isError);
      assert.include(none.text, "this board has no script named linear-state");

      yield* store.putScript(boardScript(board.id, "linear-state", false));
      const off = yield* wait({ on: "script", script: "linear-state" });
      assert.isTrue(off.isError);
      assert.include(off.text, "the linear-state script is turned off");

      yield* store.putScript(boardScript(board.id, "linear-state"));
      const unnamed = yield* wait({ on: "script" });
      assert.isTrue(unnamed.isError);
      assert.include(unnamed.text, "names the board script that checks it");
      // The built-in names are reserved: a script can't be put behind one.
      const behind = yield* wait({ on: "merge", script: "linear-state" });
      assert.isTrue(behind.isError);
      assert.include(behind.text, "a script can't stand in for it");
      const big = yield* wait({ script: "linear-state", args: { blob: "x".repeat(2100) } });
      assert.isTrue(big.isError);
      assert.include(big.text, "args is too big");

      // Naming the script is enough: on defaults to script.
      const set = yield* wait({
        script: "linear-state",
        args: { issue: "ENG-123", state: "Done", everyMs: 600_000 },
      });
      assert.isFalse(set.isError, set.text);
      const waiting = yield* kanban.card(card.id);
      assert.deepInclude(waiting.card.wait, {
        on: "script",
        script: "linear-state",
        args: { issue: "ENG-123", state: "Done", everyMs: 600_000 },
        status: null,
        failures: 0,
      });
      assert.strictEqual(
        waiting.events.at(-1)?.body,
        "Waiting for the linear-state script's check: ENG-123 to reach Done",
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a check's answer holds with a status, fails without dropping the wait, or wakes; only the card's own check may answer",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, store, board, card } = yield* waitFixture;
      yield* store.putScript(boardScript(board.id, "linear-state"));
      yield* store.putScript(boardScript(board.id, "deploy-landed"));
      const script: KanbanActor = { _tag: "script", scriptId: "script-linear-state" as never };
      const set = yield* call(evaluatorThread, "card_wait", {
        card: `#${card.number}`,
        script: "linear-state",
        note: "ENG-123 to reach Done",
      });
      assert.isFalse(set.isError, set.text);
      const answer = (
        result: Parameters<typeof kanban.answerWait>[1],
        from: string | null = "linear-state",
        wired = true,
      ) => Effect.result(kanban.answerWait(card.id, result, { script: from }, script, wired));
      const failure = (result: Result.Result<string, { readonly detail: string }>) =>
        Result.isFailure(result) ? result.failure.detail : `ok: ${result.success}`;

      // With the engine switched off nothing changes, and the script is told why.
      assert.include(
        failure(yield* answer({ result: "hold", status: "In Review" }, "linear-state", false)),
        "waits are not live on this board yet",
      );
      assert.isNull((yield* kanban.card(card.id)).card.wait?.status ?? null);

      const held = yield* answer({ result: "hold", status: "In Review" });
      assert.deepStrictEqual(Result.getOrNull(held), `card #${card.number} still waits.`);
      assert.deepInclude((yield* kanban.card(card.id)).card.wait, {
        status: "In Review",
        failures: 0,
      });

      // Another script's check can't answer for this card, and a hold can't be pushed from outside.
      assert.include(
        failure(yield* answer({ result: "wake", note: "deployed" }, "deploy-landed")),
        "does not wait on the deploy-landed script",
      );
      assert.include(failure(yield* answer({ result: "hold" }, null)), "only a wake can be pushed");

      for (const _ of [1, 2]) yield* answer({ result: "fail", reason: "Linear said 401" });
      const twice = (yield* kanban.card(card.id)).card;
      assert.deepInclude(twice.wait, {
        failures: 2,
        problem: "Linear said 401",
        status: "In Review",
      });
      const third = yield* answer({ result: "fail", reason: "Linear said 401" });
      assert.include(Result.getOrNull(third) ?? "", "failed 3 times in a row");
      const failing = yield* kanban.card(card.id);
      assert.strictEqual(failing.card.wait?.failures, 3);
      assert.strictEqual(failing.card.stage, "in_review");
      assert.strictEqual(
        failing.events.at(-1)?.body,
        "Wait check failing: 3 failures in a row while waiting for the linear-state script's check: Linear said 401",
      );

      const woke = yield* answer({ result: "wake", to: "work", note: "ENG-123 is Done" });
      assert.deepStrictEqual(
        Result.getOrNull(woke),
        `Ended the wait on card #${card.number} and woke its worker.`,
      );
      const after = yield* kanban.card(card.id);
      assert.isUndefined(after.card.wait);
      assert.strictEqual(after.card.stage, "todo");
      assert.include(
        after.card.wakeNote ?? "",
        "ENG-123 is Done. It was waiting for the linear-state script's check",
      );
      assert.deepInclude(after.events.at(-1), {
        kind: "edited",
        body: "Wait ended: ENG-123 is Done",
        fromStage: "in_review",
        toStage: "todo",
        actor: script,
      });
      // The wait is gone: a late answer is refused, not applied twice.
      assert.include(failure(yield* answer({ result: "hold" })), "is not waiting");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a pushed wake ends any wait on a waiting card, and is refused on a running card or one with no wait",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, store, board, card, other } = yield* waitFixture;
      const webhook: KanbanActor = { _tag: "script", scriptId: "script-deploy-hook" as never };
      const push = (cardId: typeof card.id, to?: "work" | "review" | "evaluator" | "none") =>
        Effect.result(
          kanban.answerWait(
            cardId,
            { result: "wake", note: "v2.4.1 is live in prod", ...(to ? { to } : {}) },
            { script: null },
            webhook,
            true,
          ),
        );
      const detail = (result: Result.Result<string, { readonly detail: string }>) =>
        Result.isFailure(result) ? result.failure.detail : `ok: ${result.success}`;

      assert.include(detail(yield* push(card.id)), `card #${card.number} is not waiting`);

      // A built-in wait, not a script one: a pushed wake still ends it.
      const set = yield* call(evaluatorThread, "card_wait", {
        card: `#${card.number}`,
        on: "merge",
        note: "waiting for the release PR",
      });
      assert.isFalse(set.isError, set.text);
      const waited = { wait: (yield* kanban.card(card.id)).card.wait! };
      const woke = yield* push(card.id, "review");
      assert.deepStrictEqual(
        Result.getOrNull(woke),
        `Ended the wait on card #${card.number} and woke its reviewer.`,
      );
      const after = (yield* kanban.card(card.id)).card;
      assert.isUndefined(after.wait);
      assert.strictEqual(after.stage, "needs_review");
      assert.include(
        after.wakeNote ?? "",
        "v2.4.1 is live in prod. It was waiting for app#12 to merge",
      );

      // Two slots: the woken review takes one, the To-Do card the other.
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      yield* kanban.dispatchNow;
      const running = (yield* kanban.card(other.id)).card;
      assert.isNotNull(running.activeThreadId);
      assert.include(detail(yield* push(other.id)), "is not waiting");
      // A wait left on a card a thread has since picked up: the thread has it, the wake is refused.
      yield* store.putCard({
        ...running,
        wait: waited.wait,
      });
      assert.include(
        detail(yield* push(other.id)),
        `card #${other.number} has a running thread, so it isn't waiting`,
      );
      assert.isDefined((yield* store.card(other.id))?.wait);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "report_bug lets a worker append cross-board sightings and stamps evaluator fallback",
  () => {
    const { launches, layer } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "source",
        name: "Source",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const tools = yield* kanban.ensureBoard({
        slug: "tools",
        name: "Tools",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const work = yield* kanban.createCard(
        board.id,
        { prompt: "Work", title: "Source work" },
        owner,
      );
      yield* kanban.dispatchNow;
      const reporter = (yield* kanban.card(work.id)).card.activeThreadId!;
      const bug = yield* kanban.createCard(
        tools.id,
        { prompt: "Fix tool", title: "Known tool problem" },
        owner,
      );
      const before = launches.length;
      const input = {
        boardId: "tools",
        title: "Different words",
        evidence: "run-1 failed",
        cardHint: `${tools.slug}#${bug.number}`,
      };
      const appended = yield* call(reporter, "report_bug", input);
      assert.isFalse(appended.isError, appended.text);
      assert.strictEqual(appended.structured.appendedTo, `#${bug.number}`);
      const duplicate = yield* call(reporter, "report_bug", input);
      assert.isFalse(duplicate.isError, duplicate.text);
      assert.isTrue(duplicate.structured.deduped);
      assert.strictEqual(launches.length, before + 1);
      const fallback = yield* call(reporter, "report_bug", {
        boardId: "tools",
        title: "Novel parser crash",
        evidence: "run-2 failed",
      });
      assert.isFalse(fallback.isError, fallback.text);
      assert.isString(fallback.structured.threadId);
      assert.strictEqual(launches.length, before + 2);
      assert.include(launches.at(-1)!, "Novel parser crash");
      assert.include(launches.at(-1)!, `kanban-card/${work.id}`);
      assert.include(launches.at(-1)!, 'the "Source" board');
      assert.include(launches.at(-1)!, reporter);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  { outcome: "sighting", mode: "slow" },
  { outcome: "sighting", mode: "conflict" },
  { outcome: "deduped sighting", mode: "slow" },
  { outcome: "evaluator", mode: "slow" },
  { outcome: "evaluator", mode: "conflict" },
] as const)("report_bug protects a saved $outcome when its reply is $mode", ({ outcome, mode }) =>
  Effect.gen(function* () {
    const saved = yield* Deferred.make<void>();
    let enabled = false;
    const recorded = yield* Deferred.make<AnalyticsEvent>();
    const initialRecorded = yield* Deferred.make<void>();
    const sink = Layer.mock(Analytics.Analytics)({
      record: (event) =>
        event.kind === "mcp.call" && event.tool === "report_bug"
          ? enabled
            ? Deferred.succeed(recorded, event).pipe(Effect.asVoid)
            : Deferred.succeed(initialRecorded, undefined).pipe(Effect.asVoid)
          : Effect.void,
    });
    const fake = fakeThreads(undefined, undefined, undefined, undefined, {
      mode,
      saved,
      enabled: () => enabled,
    });
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "bug-reply",
        name: "Bug replies",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const card = yield* kanban.createCard(
        board.id,
        { title: "Known tool", prompt: "Fix" },
        owner,
      );
      const thread = ThreadId.make("outside");
      const input = {
        boardId: board.slug,
        title: "Novel parser crash",
        evidence: "run-1 failed",
        ...(outcome === "evaluator" ? {} : { cardHint: `#${card.number}` }),
      };
      if (outcome === "deduped sighting") {
        const first = yield* call(thread, "report_bug", input);
        assert.isFalse(first.isError, first.text);
        yield* Deferred.await(initialRecorded);
      }
      enabled = true;
      const request = yield* call(thread, "report_bug", input).pipe(Effect.forkChild);
      yield* Deferred.await(saved);
      if (mode === "slow") yield* TestClock.adjust("25 seconds");
      const result = yield* Fiber.join(request);
      assert.isFalse(result.isError, result.text);
      assert.strictEqual(result.structured.saved, true);
      const row = yield* Deferred.await(recorded);
      assert.equal(row.errorTag, mode === "slow" ? "reply_timeout" : "reply_error");
      assert.equal(row.saved, true);
      if (outcome !== "evaluator") {
        assert.equal(row.cardId, card.id);
        assert.equal(row.cardNumber, card.number);
        assert.equal(row.cardStage, card.stage);
      }
      if (outcome === "evaluator") {
        assert.isString(result.structured.threadId);
        assert.lengthOf(fake.launches, 1);
        assert.include(result.text, "Do not submit another report");
      } else {
        assert.strictEqual(result.structured.appendedTo, `#${card.number}`);
        const sightings = (yield* kanban.card(card.id)).events.filter(
          (event) => event.body === "sighting\n\nrun-1 failed",
        );
        assert.lengthOf(sightings, 1);
        assert.lengthOf(fake.launches, 1);
        enabled = false;
        const retry = yield* call(thread, "report_bug", input);
        assert.isTrue(retry.structured.deduped);
      }
    }).pipe(Effect.provide(fake.layer.pipe(Layer.provide(sink))));
  }),
);

it.effect("#1156 report_bug returns a durable queue result when evaluator slots are full", () => {
  const fake = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "bug-caps",
      name: "Bug caps",
      defaultProjectId: ProjectId.make("project-1"),
    });
    for (let i = 0; i < 12; i++)
      yield* kanban.submitEvaluator(board.id, { kind: "request", text: `Fill ${i}` });
    const result = yield* call(ThreadId.make("outside"), "report_bug", {
      boardId: board.slug,
      title: "Novel parser crash",
      evidence: "Retain this evidence",
    });
    assert.isFalse(result.isError, result.text);
    assert.isTrue(result.structured.queued);
    assert.isNumber(result.structured.queueId);
    assert.lengthOf(fake.launches, 12);
    yield* TestClock.adjust("1 minute");
    yield* kanban.tick;
    assert.lengthOf(fake.launches, 13);
    assert.include(fake.launches.at(-1)!, "Retain this evidence");
  }).pipe(Effect.provide(fake.layer));
});

it.effect("report_bug is safe to retry if its reply times out before any write", () =>
  Effect.gen(function* () {
    const saved = yield* Deferred.make<void>();
    const fake = fakeThreads(undefined, undefined, undefined, undefined, {
      mode: "pre-save",
      saved,
    });
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "bug-timeout",
        name: "Bug timeout",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const request = yield* call(ThreadId.make("outside"), "report_bug", {
        boardId: board.slug,
        title: "Novel parser crash",
        evidence: "failure",
      }).pipe(Effect.forkChild);
      yield* Deferred.await(saved);
      yield* TestClock.adjust("25 seconds");
      const result = yield* Fiber.join(request);
      assert.isTrue(result.isError, result.text);
      assert.strictEqual(result.structured.saved, false);
      assert.include(result.text, "Nothing was saved; retry with the same arguments.");
      assert.lengthOf(fake.launches, 0);
    }).pipe(Effect.provide(fake.layer));
  }),
);

it.effect("report_bug reconciles a request evaluator after launch starts without a receipt", () =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fake = fakeThreads(undefined, undefined, undefined, { held, release });
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "bug-launch-timeout",
        name: "Bug launch timeout",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const request = yield* call(ThreadId.make("outside"), "report_bug", {
        boardId: board.slug,
        title: "Novel parser crash",
        evidence: "failure",
      }).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      yield* TestClock.adjust("25 seconds");
      const result = yield* Fiber.join(request);
      assert.isFalse(result.isError, result.text);
      assert.isTrue(result.structured.saved);
      assert.isTrue(result.structured.queued);
      assert.isNumber(result.structured.queueId);
      assert.isString(result.structured.evaluatorKey);
      assert.include(result.text, "Do not submit another report");
      assert.lengthOf(fake.launches, 0);
      yield* Deferred.succeed(release, undefined);
      assert.lengthOf(fake.launches, 0);
      const input = { boardId: board.slug, title: "Novel parser crash", evidence: "failure" };
      const retry = yield* call(ThreadId.make("outside"), "report_bug", input);
      assert.isFalse(retry.isError, retry.text);
      assert.isString(retry.structured.threadId);
      const repeated = yield* call(ThreadId.make("outside"), "report_bug", input);
      assert.strictEqual(repeated.structured.threadId, retry.structured.threadId);
      assert.lengthOf(fake.launches, 1);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.provide(fake.layer));
  }),
);

it.effect("board_nightly_review toggles on and off with read-back and rejects card workers", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "nightly",
      name: "Nightly",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const evaluator = ThreadId.make("thread-evaluator");
    const on = yield* call(evaluator, "board_nightly_review", {
      boardId: board.slug,
      enabled: true,
      timeOfDay: "01:15",
    });
    assert.isFalse(on.isError, on.text);
    assert.strictEqual((yield* kanban.snapshot(board.id)).board.nightlyReview?.enabled, true);
    const off = yield* call(evaluator, "board_nightly_review", {
      boardId: board.slug,
      enabled: false,
    });
    assert.isFalse(off.isError, off.text);
    const read = yield* call(evaluator, "board_get", { boardId: board.slug });
    assert.isFalse(read.isError, read.text);
    const returned = read.structured.board as {
      board: { nightlyReview: { enabled: boolean; timeOfDay: string } };
    };
    assert.strictEqual(returned.board.nightlyReview.enabled, false);
    assert.strictEqual(returned.board.nightlyReview.timeOfDay, "01:15");
    const saved = (yield* kanban.snapshot(board.id)).board.nightlyReview!;
    assert.strictEqual(saved.enabled, false);
    assert.strictEqual(saved.timeOfDay, "01:15");
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const card = yield* kanban.createCard(board.id, { prompt: "Worker" }, owner);
    yield* kanban.dispatchNow;
    const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
    const denied = yield* call(worker, "board_nightly_review", { enabled: true });
    assert.isTrue(denied.isError);
    assert.include(denied.text, "Only evaluators");
  }).pipe(Effect.provide(layer));
});

it.effect.each([true, false])("card_move reports its wait decision (keepWait=%s)", (keepWait) => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, card, other } = yield* waitFixture;
    const set = yield* call(evaluatorThread, "card_wait", {
      card: card.id,
      on: "card",
      waitsOn: other.id,
      note: "dependency first",
    });
    assert.isFalse(set.isError, set.text);
    yield* TestClock.adjust("1 minute");
    const result = yield* call(evaluatorThread, "card_move", {
      card: card.id,
      to: "todo",
      keepWait,
    });
    assert.isFalse(result.isError, result.text);
    assert.include(
      result.text,
      `Wait for card #${other.number} ${keepWait ? "kept" : "cleared by this move; set it again with card_wait or pass keepWait"}`,
    );
    const saved = (yield* kanban.card(card.id)).card;
    assert.strictEqual(saved.wait !== undefined, keepWait);
    if (keepWait) assert.strictEqual(saved.wait?.at, saved.movedAt);
    else
      assert.isTrue(
        (yield* kanban.card(card.id)).events.some(
          (event) =>
            event.body ===
            `Wait ended: the card was moved to todo; it was waiting for card #${other.number}`,
        ),
      );
  }).pipe(Effect.provide(layer));
});

it.effect("card_create and card_edit report guessed gates and expose clearGate", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "gate-results",
      name: "Gate results",
      defaultProjectId: null,
    });
    const evaluator = ThreadId.make("gate-evaluator");
    const created = yield* call(evaluator, "card_create", {
      boardId: board.id,
      title: "Guesses",
      prompt: "Work",
      subtasks: [
        { text: "Tell the reporter once installed", owner: "evaluator", gate: null },
        { text: "Do the operation", owner: "evaluator", gate: "money" },
        { text: "Test restart handling", owner: "work" },
        { text: "Review the release", owner: "review" },
      ],
    });
    assert.isFalse(created.isError, created.text);
    assert.deepStrictEqual(created.structured.gated, [
      { id: "s1", gate: "deploy", source: "guessed" },
    ]);
    assert.strictEqual(
      created.structured.message,
      "s1 got a guessed deploy gate from its wording; if that's wrong, pass clearGate with a reason on this id",
    );
    const card = yield* decodeKanbanCard(created.structured.card);
    const edited = yield* call(evaluator, "card_edit", {
      card: card.id,
      subtasks: [{ id: "s1", gate: null }, { id: "s2", gate: "money" }, { id: "s3" }, { id: "s4" }],
    });
    assert.isFalse(edited.isError, edited.text);
    assert.deepStrictEqual(edited.structured.gated, [
      { id: "s1", gate: "deploy", source: "guessed" },
    ]);
    assert.strictEqual((yield* kanban.card(card.id)).card.subtasks[0]!.gate, "deploy");
    const cleared = yield* call(evaluator, "card_edit", {
      card: card.id,
      subtasks: [
        { id: "s1", clearGate: "This is a report, nothing goes live" },
        { id: "s2" },
        { id: "s3" },
        { id: "s4" },
      ],
    });
    assert.isFalse(cleared.isError, cleared.text);
    assert.deepStrictEqual(cleared.structured.gated, []);
    assert.lengthOf((yield* kanban.card(card.id)).card.asks, 1);
    const reworded = yield* call(evaluator, "card_edit", {
      card: card.id,
      subtasks: [
        { id: "s1", text: "Tell both reporters once installed" },
        { id: "s2" },
        { id: "s3" },
        { id: "s4" },
      ],
    });
    assert.isFalse(reworded.isError, reworded.text);
    assert.deepStrictEqual(reworded.structured.gated, []);
    const saved = (yield* kanban.card(card.id)).card;
    assert.lengthOf(saved.asks, 1);
    assert.strictEqual(saved.subtasks[0]!.gateCleared?.text, "Tell both reporters once installed");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "card_edit clears three finished guesses and card_move verifies without reopening",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const board = yield* kanban.ensureBoard({
        slug: "finished-gates",
        name: "Finished gates",
        defaultProjectId: null,
      });
      const evaluator = ThreadId.make("finished-gate-evaluator");
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "9router finished steps",
          prompt: "Work",
          subtasks: [7, 8, 10].map((number) => ({
            text: `Tell reporter ${number} once installed`,
            owner: "evaluator" as const,
          })),
        },
        { _tag: "owner" },
      );
      const finished = card.subtasks.map((subtask) => ({
        ...subtask,
        state: "done" as const,
        note: "Reporter told",
        doneBy: { _tag: "evaluator" as const, threadId: evaluator },
        doneAt: card.updatedAt,
      }));
      yield* store.putCard({ ...card, subtasks: finished });
      const refused = yield* call(evaluator, "card_move", { card: card.id, to: "verified" });
      assert.isTrue(refused.isError, refused.text);
      assert.include(refused.text, "clearGate");
      const patch = {
        card: card.id,
        subtasks: finished.map(({ id }) => ({
          id,
          clearGate: "This only reports the result; nothing goes live",
        })),
      };
      const edited = yield* call(evaluator, "card_edit", patch);
      assert.isFalse(edited.isError, edited.text);
      assert.deepStrictEqual(edited.structured.gated, []);
      const saved = (yield* kanban.card(card.id)).card;
      for (const [index, task] of saved.subtasks.entries()) {
        const { gate: _gate, gateSource: _source, ...history } = finished[index]!;
        const { gateCleared, ...rest } = task;
        assert.deepStrictEqual(rest, history);
        assert.strictEqual(gateCleared?.gate, "deploy");
      }
      assert.lengthOf(saved.asks, 3);
      const retry = yield* call(evaluator, "card_edit", patch);
      assert.isFalse(retry.isError, retry.text);
      assert.deepStrictEqual(retry.structured.gated, []);
      assert.lengthOf((yield* kanban.card(card.id)).card.asks, 3);
      const moved = yield* call(evaluator, "card_move", { card: card.id, to: "verified" });
      assert.isFalse(moved.isError, moved.text);
      assert.strictEqual((yield* kanban.card(card.id)).card.stage, "verified");
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["open", "done", "skipped"] as const)(
  "card_edit rejects a %s clear with no gate",
  (state) => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const board = yield* kanban.ensureBoard({
        slug: "no-gate",
        name: "No gate",
        defaultProjectId: null,
      });
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "No gate",
          prompt: "Work",
          subtasks: [{ text: "Read the result", owner: "evaluator" }],
        },
        { _tag: "owner" },
      );
      yield* store.putCard({
        ...card,
        subtasks: card.subtasks.map((subtask) => ({ ...subtask, state })),
      });
      const reply = yield* call(ThreadId.make("no-gate-evaluator"), "card_edit", {
        card: card.id,
        subtasks: [{ id: "s1", clearGate: "This only reads the result" }],
      });
      assert.isTrue(reply.isError, reply.text);
      assert.include(reply.text, "subtask s1 has no gate to clear");
      assert.lengthOf((yield* kanban.card(card.id)).card.asks, 0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("guessed gate results follow allocated ids even when plan steps are out of order", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "sorted-gates",
      name: "Sorted gates",
      defaultProjectId: null,
    });
    const card = yield* kanban.createCard(
      board.id,
      {
        title: "Sort plan",
        prompt: "Work",
        subtasks: [{ text: "Read result", owner: "evaluator" }],
      },
      owner,
    );
    yield* kanban.markSubtask(card.id, "s1", "done", "Read", owner, "evaluator");
    const edited = yield* call(ThreadId.make("gate-evaluator"), "card_edit", {
      card: card.id,
      subtasks: [
        { text: "Restart Robob", owner: "evaluator", step: 5 },
        { text: "Pay the invoice", owner: "evaluator", step: 2, gate: null },
      ],
    });
    assert.isFalse(edited.isError, edited.text);
    assert.deepStrictEqual(edited.structured.gated, [
      { id: "s2", gate: "deploy", source: "guessed" },
      { id: "s3", gate: "money", source: "guessed" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("board_get returns the board's persisted gate guessing policy", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "gate-policy",
      name: "Gate policy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const thread = yield* kanban.startEvaluator(board.id, {
      kind: "request",
      text: "Read board policy",
    });
    for (const guessedGates of [["money", "secret"], [], ["deploy", "money", "secret"]] as const) {
      yield* kanban.updateBoard(board.id, { guessedGates });
      const result = yield* call(thread, "board_get", { boardId: board.id });
      assert.isFalse(result.isError);
      const snapshot = result.structured.board as {
        board: { guessedGates: ReadonlyArray<string> };
      };
      assert.deepStrictEqual(snapshot.board.guessedGates, guessedGates);
    }
  }).pipe(Effect.provide(layer));
});

it.effect("tool results respect disabled board guesses after create and edit", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "disabled-guesses",
      name: "Disabled guesses",
      defaultProjectId: null,
    });
    yield* kanban.updateBoard(board.id, { guessedGates: [] });
    const evaluator = ThreadId.make("guess-evaluator");
    const made = yield* call(evaluator, "card_create", {
      boardId: board.id,
      title: "Disabled",
      prompt: "Work",
      subtasks: [{ text: "Restart the helper", owner: "evaluator", gate: null }],
    });
    assert.isFalse(made.isError, made.text);
    assert.deepStrictEqual(made.structured.gated, []);
    const card = yield* decodeKanbanCard(made.structured.card);
    const edited = yield* call(evaluator, "card_edit", {
      card: card.id,
      subtasks: [{ id: "s1", gate: null }],
    });
    assert.isFalse(edited.isError, edited.text);
    assert.deepStrictEqual(edited.structured.gated, []);
  }).pipe(Effect.provide(layer));
});

const clearGateCallerCases = [
  { label: "worker child", role: "work", shape: "plain", state: "healthy", linked: false },
  { label: "worker grandchild", role: "work", shape: "nested", state: "healthy", linked: false },
  { label: "native task child", role: "work", shape: "task", state: "healthy", linked: false },
  { label: "reviewer child", role: "review", shape: "plain", state: "healthy", linked: false },
  { label: "evaluator child", role: "evaluator", shape: "plain", state: "healthy", linked: false },
  {
    label: "outside orchestrator child",
    role: null,
    shape: "plain",
    state: "healthy",
    linked: false,
  },
  { label: "linked evaluator child", role: "work", shape: "plain", state: "healthy", linked: true },
  { label: "missing parent", role: "work", shape: "plain", state: "missing", linked: false },
  { label: "deleted parent", role: "work", shape: "plain", state: "deleted", linked: false },
  { label: "unreadable parent", role: "work", shape: "plain", state: "unreadable", linked: false },
  { label: "self cycle", role: "work", shape: "plain", state: "self-cycle", linked: false },
  { label: "parent cycle", role: "work", shape: "plain", state: "parent-cycle", linked: false },
] as const;

it.effect.each(
  clearGateCallerCases.flatMap((row) =>
    (["card_edit", "subtask_done"] as const).map((tool) => ({ ...row, tool })),
  ),
)("$tool caller ancestry: $label", (row) => {
  const { layer, parents, missing, deleted, unreadable } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "clear-ancestry",
      name: "Clear ancestry",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const work = yield* kanban.createCard(
      board.id,
      { title: "Parent work", prompt: "Work" },
      owner,
    );
    yield* kanban.dispatchNow;
    const worker = (yield* kanban.card(work.id)).card.activeThreadId!;
    assert.isNotNull(worker);
    const store = yield* KanbanStore.KanbanStore;
    const link = yield* kanban.caller(worker);
    assert.isNotNull(link);
    const parent = row.role === null ? ThreadId.make("outside-root") : worker;
    if (row.role !== null) yield* store.putThreadLink({ ...link!, role: row.role });
    const child = ThreadId.make(
      row.shape === "task" ? "thread:delegated-task:command%3Amcp%3Aclear-gate" : "gate-child",
    );
    parents.set(child, parent);
    if (row.shape === "nested") {
      const middle = ThreadId.make("gate-middle");
      parents.set(child, middle);
      parents.set(middle, parent);
    }
    if (row.linked) yield* store.putThreadLink({ ...link!, threadId: child, role: "evaluator" });
    if (row.state === "missing") missing.add(parent);
    if (row.state === "deleted") deleted.add(parent);
    if (row.state === "unreadable") unreadable.add(parent);
    if (row.state === "self-cycle") parents.set(child, child);
    if (row.state === "parent-cycle") parents.set(parent, child);
    for (const [gate, text] of [
      ["deploy", "Restart Robob now"],
      ["money", "Pay the invoice"],
      ["secret", "Share the token"],
    ] as const) {
      const card = yield* kanban.createCard(
        board.id,
        {
          title: `Guessed ${gate}`,
          prompt: `Gate ${gate}`,
          subtasks: [{ text, owner: "evaluator" }],
        },
        owner,
      );
      assert.strictEqual(card.subtasks[0]!.gate, gate);
      const before = yield* kanban.card(card.id);
      const refused = yield* call(child, row.tool, {
        card: card.id,
        ...(row.tool === "card_edit"
          ? { subtasks: [{ id: "s1", clearGate: "This gate was guessed incorrectly" }] }
          : { subtask: "s1", state: "skipped", note: "This gate was filed incorrectly" }),
      });
      assert.isTrue(refused.isError, refused.text);
      assert.match(
        refused.text,
        /only the board evaluator|Cannot verify the calling thread's ancestry/,
      );
      assert.deepStrictEqual(yield* kanban.card(card.id), before);
    }
  }).pipe(Effect.provide(layer));
});

it.effect.each(["outside orchestrator", "board evaluator"] as const)(
  "clearGate caller ancestry allows a top-level %s",
  (role) => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "clear-root",
        name: "Clear root",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const root =
        role === "board evaluator"
          ? yield* kanban.startEvaluator(board.id, { kind: "request", text: "Review the gate" })
          : ThreadId.make("outside-root");
      const card = yield* kanban.createCard(
        board.id,
        {
          title: "Top-level clear",
          prompt: "Work",
          subtasks: [{ text: "Pay the invoice", owner: "evaluator" }],
        },
        owner,
      );
      const cleared = yield* call(root, "card_edit", {
        card: card.id,
        subtasks: [{ id: "s1", clearGate: "This is only a test invoice fixture" }],
      });
      assert.isFalse(cleared.isError, cleared.text);
      const saved = (yield* kanban.card(card.id)).card;
      assert.isUndefined(saved.subtasks[0]!.gate);
      assert.deepStrictEqual(saved.subtasks[0]!.gateCleared?.by, {
        _tag: "evaluator",
        threadId: root,
      });
      assert.lengthOf(saved.asks, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "report_bug attributes ID/slug targets for worker/outside callers and novel/sighting outcomes",
  () => {
    const fake = fakeThreads();
    let pending:
      | { ledger: Deferred.Deferred<AnalyticsEvent>; generic: Deferred.Deferred<AnalyticsEvent> }
      | undefined;
    const sink = Layer.mock(Analytics.Analytics)({
      record: (event) => {
        if (!pending) return Effect.void;
        if (event.kind === "mcp.call" && event.tool === "report_bug")
          return Deferred.succeed(pending.ledger, event).pipe(Effect.asVoid);
        if (
          (event.kind === "server.mcp" || event.kind === "server.mcp.error") &&
          event.props?.method === "report_bug"
        )
          return Deferred.succeed(pending.generic, event).pipe(Effect.asVoid);
        return Effect.void;
      },
    });
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const source = yield* kanban.ensureBoard({
        slug: "report-source",
        name: "Report source",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(source.id, source.defaultCardModel, 1);
      const work = yield* kanban.createCard(source.id, { title: "Work", prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(work.id)).card.activeThreadId!;
      fake.running.add(worker);
      const other = yield* kanban.ensureBoard({
        slug: "report-target",
        name: "Report target",
        defaultProjectId: ProjectId.make("project-1"),
      });
      let index = 0;
      for (const target of [source, other]) {
        const known = yield* kanban.createCard(
          target.id,
          { title: "Known storage problem", prompt: "Fix" },
          owner,
        );
        for (const caller of [worker, ThreadId.make("outside-reporter")]) {
          for (const boardId of [target.id, target.slug]) {
            for (const outcome of ["novel", "sighting"] as const) {
              pending = {
                ledger: yield* Deferred.make<AnalyticsEvent>(),
                generic: yield* Deferred.make<AnalyticsEvent>(),
              };
              const result = yield* call(caller, "report_bug", {
                boardId,
                title: outcome === "novel" ? `Novel unrelated failure ${index++}` : known.title,
                evidence: "private-input",
                ...(outcome === "sighting" ? { cardHint: `#${known.number}` } : {}),
              });
              assert.isFalse(result.isError, result.text);
              for (const row of [
                yield* Deferred.await(pending.ledger),
                yield* Deferred.await(pending.generic),
              ]) {
                assert.equal(row.boardId, target.id);
                assert.equal(row.props?.boardId, target.id);
                assert.notInclude(JSON.stringify(row), "private-input");
                if (outcome === "novel") {
                  assert.isUndefined(row.cardId);
                  assert.isUndefined(row.props?.cardNumber);
                } else {
                  assert.equal(row.cardId, known.id);
                  assert.equal(row.props?.cardNumber, known.number);
                  if (row.kind === "mcp.call") assert.equal(row.cardStage, known.stage);
                }
              }
            }
          }
        }
      }
    }).pipe(Effect.provide(fake.layer.pipe(Layer.provide(sink))));
  },
);

it.effect(
  "discussion target attribution for explicit read/seq/post across caller, board and discussion kinds",
  () => {
    const fake = fakeThreads();
    let pending:
      | {
          tool: string;
          ledger: Deferred.Deferred<AnalyticsEvent>;
          generic: Deferred.Deferred<AnalyticsEvent>;
        }
      | undefined;
    const sink = Layer.mock(Analytics.Analytics)({
      record: (event) => {
        if (!pending) return Effect.void;
        if (event.kind === "mcp.call" && event.tool === pending.tool)
          return Deferred.succeed(pending.ledger, event).pipe(Effect.asVoid);
        if (
          (event.kind === "server.mcp" || event.kind === "server.mcp.error") &&
          event.props?.method === pending.tool
        )
          return Deferred.succeed(pending.generic, event).pipe(Effect.asVoid);
        return Effect.void;
      },
    });
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const source = yield* kanban.ensureBoard({
        slug: "discussion-source",
        name: "Source",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(source.id, source.defaultCardModel, 1);
      const work = yield* kanban.createCard(source.id, { title: "Work", prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(work.id)).card.activeThreadId!;
      fake.running.add(worker);
      const other = yield* kanban.ensureBoard({
        slug: "discussion-target",
        name: "Target",
        defaultProjectId: ProjectId.make("project-1"),
      });
      for (const board of [source, other]) {
        const card = yield* kanban.createCard(
          board.id,
          { title: "Discuss", prompt: "Task" },
          owner,
        );
        const attached = yield* kanban.cardDiscussion(card.id);
        const standalone = yield* kanban.createDiscussion(board.id, "Stand-alone", owner);
        for (const discussion of [attached, standalone]) {
          const seed = yield* kanban.post(discussion.id, owner, [
            { _tag: "md", text: "private-seed" },
          ]);
          if (discussion.cardId)
            yield* kanban.askOwner(
              card.id,
              { question: "private-question", blocking: false },
              owner,
              "owner",
            );
          for (const caller of [worker, ThreadId.make("outside-discussion-reader")]) {
            for (const operation of [
              "read",
              "seq",
              "post",
              ...(discussion.cardId ? (["ask"] as const) : []),
            ] as const) {
              const tool =
                operation === "post" || operation === "ask" ? "discussion_post" : "discussion_read";
              pending = {
                tool,
                ledger: yield* Deferred.make<AnalyticsEvent>(),
                generic: yield* Deferred.make<AnalyticsEvent>(),
              };
              const result = yield* call(caller, tool, {
                discussionId: discussion.id,
                ...(operation === "ask"
                  ? { boardId: board.id, card: card.id, ask: "q1", text: "private-reply" }
                  : operation === "post"
                    ? { text: "private-post" }
                    : operation === "seq"
                      ? { seq: seed.seq }
                      : {}),
              });
              const denied =
                caller === worker &&
                discussion.cardId !== null &&
                (operation === "post" || operation === "ask");
              assert.equal(result.isError, denied, result.text);
              if (denied) {
                assert.include(result.text, "capability_denied");
                assert.include(
                  result.text,
                  operation === "post"
                    ? `can't post on card #${card.number}`
                    : `can't change card #${card.number}`,
                );
              }
              for (const row of [
                yield* Deferred.await(pending.ledger),
                yield* Deferred.await(pending.generic),
              ]) {
                assert.equal(row.boardId, board.id);
                assert.equal(row.props?.boardId, board.id);
                assert.equal(row.cardId, discussion.cardId ?? undefined);
                assert.equal(row.props?.cardNumber, discussion.cardId ? card.number : undefined);
                assert.notInclude(JSON.stringify(row), "private-seed");
                assert.notInclude(JSON.stringify(row), "private-post");
                assert.notInclude(JSON.stringify(row), "private-question");
                assert.notInclude(JSON.stringify(row), "private-reply");
              }
            }
          }
        }
      }
    }).pipe(Effect.provide(fake.layer.pipe(Layer.provide(sink))));
  },
);

it.effect(
  "real board-busy KanbanError keeps its analytics refusal through card_update encoding",
  () => {
    const fake = fakeThreads(
      undefined,
      new KanbanError({
        code: "conflict",
        detail: "Board busy: not written (held 2m by private-operation). Safe to retry once.",
        saved: false,
      }),
    );
    return Effect.gen(function* () {
      const ledger = yield* Deferred.make<AnalyticsEvent>();
      const generic = yield* Deferred.make<AnalyticsEvent>();
      const sink = Layer.mock(Analytics.Analytics)({
        record: (event) =>
          event.kind === "mcp.call" && event.tool === "card_update"
            ? Deferred.succeed(ledger, event).pipe(Effect.asVoid)
            : event.kind === "server.mcp.error" && event.props?.method === "card_update"
              ? Deferred.succeed(generic, event).pipe(Effect.asVoid)
              : Effect.void,
      });
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const board = yield* kanban.ensureBoard({
          slug: "busy-analytics",
          name: "Busy",
          defaultProjectId: null,
        });
        const card = yield* kanban.createCard(board.id, { title: "Busy", prompt: "Task" }, owner);
        const result = yield* call(ThreadId.make("outside"), "card_update", {
          card: card.id,
          comment: "private-comment",
        });
        assert.isTrue(result.isError, result.text);
        const row = yield* Deferred.await(ledger);
        assert.equal(row.outcome, "refused");
        assert.equal(row.saved, false);
        for (const event of [row, yield* Deferred.await(generic)]) {
          assert.equal(event.props?.code, "board_busy");
          assert.equal(event.props?.saved, false);
          assert.notInclude(JSON.stringify(event), "private");
        }
      }).pipe(Effect.provide(fake.layer.pipe(Layer.provide(sink))));
    });
  },
);

const defaultDiscussionCases = (["discussion_read", "discussion_post"] as const).flatMap((tool) =>
  (["fresh", "existing", "owned", "multiple", "none"] as const).map((selection) => ({
    tool,
    selection,
  })),
);
it.effect.each(defaultDiscussionCases)(
  "default worker discussion attribution: $tool with $selection selection",
  ({ tool, selection }) => {
    const fake = fakeThreads();
    return Effect.gen(function* () {
      const ledger = yield* Deferred.make<AnalyticsEvent>();
      const generic = yield* Deferred.make<AnalyticsEvent>();
      const sink = Layer.mock(Analytics.Analytics)({
        record: (event) =>
          event.kind === "mcp.call" && event.tool === tool
            ? Deferred.succeed(ledger, event).pipe(Effect.asVoid)
            : (event.kind === "server.mcp" || event.kind === "server.mcp.error") &&
                event.props?.method === tool
              ? Deferred.succeed(generic, event).pipe(Effect.asVoid)
              : Effect.void,
      });
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const board = yield* kanban.ensureBoard({
          slug: "default-discussion",
          name: "Default",
          defaultProjectId: ProjectId.make("project-1"),
        });
        yield* kanban.setPool(board.id, board.defaultCardModel, 2);
        const first = yield* kanban.createCard(
          board.id,
          { title: "First", prompt: "private-prompt" },
          owner,
        );
        yield* kanban.dispatchNow;
        const worker = (yield* kanban.card(first.id)).card.activeThreadId!;
        fake.running.add(worker);
        let selected = first;
        if (selection === "owned" || selection === "multiple")
          selected = (yield* kanban.createForThread(worker, {
            title: "Second",
            prompt: "private-prompt",
          })).card;
        if (selection !== "fresh") {
          const discussion = yield* kanban.cardDiscussion(selected.id);
          yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "private-message" }]);
        }
        if (selection === "owned" || selection === "none") {
          yield* kanban.moveCard(first.id, "todo", "owner", owner);
          yield* kanban.dispatchNow;
          assert.notEqual((yield* kanban.card(first.id)).card.workThreadId, worker);
          if (selection === "owned")
            yield* kanban.moveCard(
              selected.id,
              "needs_owner",
              "cardThread",
              { _tag: "thread", threadId: worker },
              { question: "private-question" },
            );
          assert.lengthOf(yield* kanban.carried(worker), 0);
          assert.deepEqual(
            (yield* kanban.ownCards(worker)).map((card) => card.id),
            selection === "owned" ? [selected.id] : [],
          );
        }
        const refused = selection === "multiple" || selection === "none";
        const result = yield* call(
          worker,
          tool,
          tool === "discussion_post" ? { text: "private-post" } : {},
        );
        assert.equal(result.isError, refused, result.text);
        const rows = [yield* Deferred.await(ledger), yield* Deferred.await(generic)];
        for (const row of rows) {
          assert.equal(row.boardId, board.id);
          assert.equal(row.props?.boardId, board.id);
          assert.equal(row.cardId, refused ? undefined : selected.id);
          assert.equal(row.props?.cardNumber, refused ? undefined : selected.number);
          assert.notInclude(JSON.stringify(row), "private");
        }
        if (!refused) {
          const discussion = yield* kanban.cardDiscussion(selected.id);
          if (tool === "discussion_read")
            assert.equal((result.structured.discussion as { id: string }).id, discussion.id);
          else {
            assert.equal(
              (result.structured.message as { discussionId: string }).discussionId,
              discussion.id,
            );
            assert.deepInclude(
              (yield* kanban.messages(discussion.id)).flatMap((message) => message.blocks),
              { _tag: "md", text: "private-post" },
            );
          }
        }
      }).pipe(Effect.provide(fake.layer.pipe(Layer.provide(sink))));
    });
  },
);

it.effect(
  "standing approvals require the owner, cover named boards, preserve history and never clear money",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, store, board, card } = yield* waitFixture;
      const other = yield* kanban.ensureBoard({
        slug: "second",
        name: "Second",
        defaultProjectId: null,
      });
      const evaluator = yield* kanban.startEvaluator(board.id, {
        kind: "request",
        text: "Record standing deploy approvals",
      });
      const actor = { _tag: "evaluator", threadId: evaluator } as const;
      const grant = {
        action: "grant",
        boards: ["toy", "second"],
        card: card.id,
        ask: "q1",
        quote: "These boards may release",
        sourceThreadId: "owner-thread",
        saidAt: card.createdAt,
      };
      const ask = {
        id: "q1",
        text: "Approve standing deploy approval for toy and second",
        blocking: false,
        by: actor,
        at: card.createdAt,
        seq: null,
        closedAt: card.createdAt,
        answer: { verdict: "approved" as const, by: owner, at: card.createdAt },
      };
      for (const bad of [
        { ...ask, closedAt: null, answer: undefined },
        { ...ask, answer: { ...ask.answer, verdict: "dropped" as const } },
        { ...ask, answer: { ...ask.answer, by: actor } },
        { ...ask, text: "Approve standing deploy approval for toy and second-other" },
      ]) {
        yield* store.putCard({ ...card, asks: [bad] });
        const denied = yield* call(evaluator, "board_standing_approval", grant);
        assert.isTrue(denied.isError, denied.text);
        assert.deepStrictEqual((yield* kanban.snapshot(board.id)).board.standingApprovals, []);
      }
      yield* store.putCard({ ...card, asks: [ask] });
      const release = yield* kanban.createCard(
        board.id,
        {
          title: "Ship tool",
          description: "Ready",
          prompt: "Ship tool",
          subtasks: [
            { text: "Deploy spectrum-bridge", owner: "evaluator" },
            { text: "Pay the invoice", owner: "evaluator" },
          ],
        },
        actor,
      );
      yield* kanban.askOwner(
        release.id,
        { question: "Release go?", blocking: false, batchKey: "release-standing-20261113" },
        actor,
        "evaluator",
      );
      const granted = yield* call(evaluator, "board_standing_approval", grant);
      assert.isFalse(granted.isError, granted.text);
      assert.deepStrictEqual(granted.structured.openReleaseAsks, [
        { board: "toy", card: release.number, ask: "q1" },
      ]);
      for (const selected of [board, other]) {
        const read = yield* call(evaluator, "board_get", { boardId: selected.slug });
        assert.isFalse(read.isError, read.text);
        assert.lengthOf(
          (read.structured.board as { board: { standingApprovals: unknown[] } }).board
            .standingApprovals,
          1,
        );
      }
      const record = (yield* kanban.snapshot(board.id)).board.standingApprovals[0]!;
      const done = yield* call(evaluator, "subtask_done", {
        card: release.id,
        subtask: "s1",
        state: "done",
        note: "Installed",
      });
      assert.isFalse(done.isError, done.text);
      const detail = yield* kanban.card(release.id);
      assert.include(detail.card.subtasks[0]!.note!, `cleared by standing approval ${record.id}`);
      assert.isTrue(
        detail.events.some((event) =>
          event.body?.includes(`cleared by standing approval ${record.id}`),
        ),
      );
      const money = yield* call(evaluator, "subtask_done", {
        card: release.id,
        subtask: "s2",
        state: "done",
        note: "Paid",
      });
      assert.isTrue(money.isError);
      const secondEvaluator = ThreadId.make("second-evaluator");
      yield* store.putThreadLink({
        ...(yield* kanban.caller(evaluator))!,
        threadId: secondEvaluator,
      });
      const drop = yield* call(secondEvaluator, "card_ask_change", {
        card: release.id,
        ask: "q1",
        action: "drop",
      });
      assert.isFalse(drop.isError, drop.text);
      const superseded = yield* call(evaluator, "board_standing_approval", grant);
      assert.isFalse(superseded.isError, superseded.text);
      const history = (yield* kanban.snapshot(board.id)).board.standingApprovals;
      assert.strictEqual(history[0]!.revokeReason, "superseded");
      const revoked = yield* call(secondEvaluator, "board_standing_approval", {
        action: "revoke",
        reason: "Owner withdrew approval",
      });
      assert.isFalse(revoked.isError, revoked.text);
      const reset = yield* call(evaluator, "subtask_done", {
        card: release.id,
        subtask: "s1",
        state: "open",
      });
      assert.isFalse(reset.isError, reset.text);
      const after = yield* call(evaluator, "subtask_done", {
        card: release.id,
        subtask: "s1",
        state: "done",
        note: "Installed",
      });
      assert.isTrue(after.isError);
      assert.include(after.text, "no standing deploy approval");
      for (const action of ["grant", "revoke"] as const) {
        const refused = yield* kanban
          .standingApproval(
            board.id,
            { action, reason: "Withdrawn" },
            { _tag: "script", scriptId: KanbanScriptId.make("script-one") },
          )
          .pipe(Effect.flip);
        assert.strictEqual(refused.code, "denied");
      }
      const workThread = ThreadId.make("standing-work");
      yield* store.putThreadLink({
        ...(yield* kanban.caller(evaluator))!,
        threadId: workThread,
        role: "work",
        cardId: release.id,
      });
      for (const input of [grant, { action: "revoke", reason: "No" }]) {
        const denied = yield* call(workThread, "board_standing_approval", input);
        assert.isTrue(denied.isError);
        assert.include(denied.text, "capability_denied");
      }
      const denied = yield* call(workThread, "card_create", {
        title: "Owner only",
        prompt: "Owner only",
        subtasks: [{ text: "Do it", owner: "evaluator", ownerOnly: true }],
      });
      assert.isTrue(denied.isError);
      assert.include(denied.text, "only evaluators");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "standing approval picks and board-name fields are checked without changing owner-only steps",
  () => {
    const { layer } = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, store, board, card } = yield* waitFixture;
      const evaluator = yield* kanban.startEvaluator(board.id, {
        kind: "request",
        text: "Set standing deploy approval",
      });
      const actor = { _tag: "evaluator", threadId: evaluator } as const;
      const grant = {
        action: "grant",
        card: card.id,
        ask: "q1",
        quote: "toy may release",
        sourceThreadId: "owner-thread",
        saidAt: card.createdAt,
      };
      const ask = {
        id: "q1",
        text: "Standing deploy approval",
        blocking: false,
        by: actor,
        at: card.createdAt,
        seq: null,
        closedAt: card.createdAt,
        options: [{ id: "o1", label: "Approve" }],
        answer: { verdict: "picked" as const, optionIds: ["o1"], by: owner, at: card.createdAt },
      };
      for (const fields of [
        { text: "Approve toy" },
        { title: "Approve TOY" },
        { action: { summary: "Deploy toy" } },
        { action: { summary: "Deploy", target: "toy" } },
      ]) {
        yield* store.putCard({ ...card, asks: [{ ...ask, ...fields }] });
        const result = yield* call(evaluator, "board_standing_approval", grant);
        assert.isFalse(result.isError, result.text);
      }
      for (const label of ["No", "Show status", "Approve after tests"]) {
        yield* store.putCard({
          ...card,
          asks: [{ ...ask, text: "toy deploy approval", options: [{ id: "o1", label }] }],
        });
        const result = yield* call(evaluator, "board_standing_approval", grant);
        assert.isTrue(result.isError, label);
      }
      for (const { labels, picks, approved } of [
        { labels: ["Tag and deploy now", "Wait"], picks: ["o1"], approved: true },
        { labels: ["Tag and deploy now", "Install tonight"], picks: ["o1"], approved: false },
        { labels: ["Tag and deploy now"], picks: ["o1"], approved: false },
        { labels: ["Tag and deploy now", "Approve", "Wait"], picks: ["o1", "o2"], approved: false },
        { labels: ["Approve", "Deploy now"], picks: ["o1", "o2"], approved: true },
        { labels: ["Deploy now", "Wait"], picks: ["o3"], approved: false },
      ]) {
        yield* store.putCard({
          ...card,
          asks: [
            {
              ...ask,
              text: "Standing deploy approval for toy",
              options: labels.map((label, index) => ({ id: `o${index + 1}`, label })),
              answer: { ...ask.answer, optionIds: picks },
            },
          ],
        });
        const result = yield* call(evaluator, "board_standing_approval", grant);
        assert.strictEqual(result.isError, !approved, JSON.stringify({ labels, picks }));
      }
      const step = yield* kanban.createCard(
        board.id,
        {
          title: "Owner-only restart",
          prompt: "Restart Robob",
          subtasks: [
            { text: "Restart Robob to pick up the watcher", owner: "evaluator", ownerOnly: true },
          ],
        },
        actor,
      );
      const edited = yield* kanban.editCard(
        step.id,
        { subtasks: [{ id: "s1", text: step.subtasks[0]!.text }] },
        actor,
      );
      assert.isTrue(edited.subtasks[0]!.ownerOnly);
      const denied = yield* call(evaluator, "subtask_done", {
        card: step.id,
        subtask: "s1",
        state: "done",
        note: "Restarted",
      });
      assert.isTrue(denied.isError);
      assert.include(denied.text, "marked owner-only");
      yield* kanban.askOwner(
        step.id,
        { question: "Approve s1 restart?", action: { summary: "Restart Robob" }, blocking: false },
        actor,
        "evaluator",
      );
      yield* kanban.answerAsk(step.id, "q1", { verdict: "approved", revision: 0 }, owner);
      const done = yield* call(evaluator, "subtask_done", {
        card: step.id,
        subtask: "s1",
        state: "done",
        note: "Restarted",
      });
      assert.isFalse(done.isError, done.text);
      assert.notInclude((yield* kanban.card(step.id)).card.subtasks[0]!.note!, "standing approval");
      for (const role of ["work", "review"] as const) {
        const threadId = ThreadId.make(`denied-${role}`);
        yield* store.putThreadLink({
          ...(yield* kanban.caller(evaluator))!,
          threadId,
          role,
          cardId: step.id,
        });
        for (const input of [grant, { action: "revoke", reason: "Withdrawn" }]) {
          const reply = yield* call(threadId, "board_standing_approval", input);
          assert.isTrue(reply.isError, role);
          assert.include(reply.text, "capability_denied");
        }
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["normal", "released"] as const)(
  "card_next answers after a %s worker moves to review",
  (state) =>
    Effect.gen(function* () {
      const { layer, running, viewControl } = fakeThreads();
      const ledger = yield* Deferred.make<AnalyticsEvent>();
      const sink = Layer.mock(Analytics.Analytics)({
        record: (event) =>
          event.kind === "mcp.call" && event.tool === "card_next"
            ? Deferred.succeed(ledger, event).pipe(Effect.asVoid)
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const store = yield* KanbanStore.KanbanStore;
        const board = yield* kanban.ensureBoard({
          slug: "next",
          name: "Next",
          defaultProjectId: ProjectId.make("project-1"),
        });
        yield* kanban.setPool(board.id, board.defaultCardModel, 1);
        const card = yield* kanban.createCard(
          board.id,
          { title: "Finish", prompt: "Finish" },
          { _tag: "owner" },
        );
        yield* kanban.dispatchNow;
        const thread = (yield* kanban.card(card.id)).card.workThreadId!;
        if (state === "released") {
          yield* store.putCard({
            ...(yield* store.card(card.id))!,
            stage: "todo",
            activeThreadId: null,
            activeRole: null,
            activePool: null,
            stalled: {
              by: { _tag: "system", component: "dispatcher" },
              reason: "Stale queued runs on the thread",
              at: "2026-11-14T05:17:40.565Z",
            },
          });
        }
        running.add(thread);
        const moved = yield* call(thread, "card_move", { card: card.id, to: "needs_review" });
        assert.isFalse(moved.isError, moved.text);
        viewControl.beforeRead = () => Effect.die("card_next must not read thread activity");
        const next = yield* call(thread, "card_next", {});
        assert.isFalse(next.isError, next.text);
        assert.deepEqual(next.structured.carrying, []);
        assert.isArray(next.structured.candidates);
        assert.equal(typeof next.structured.holdsSlot, "boolean");
        const row = yield* Deferred.await(ledger);
        assert.isTrue(row.callerResolved);
        assert.equal(row.readerLane, "writer");
        assert.deepEqual(
          row.cardNextStages!.slice(0, 2).map((part) => part.stage),
          ["caller", "occupancy"],
        );
        assert.isTrue(row.cardNextStages!.every((part) => part.completed));
        assert.notInclude(JSON.stringify(row), "Finish");
      }).pipe(Effect.provide(layer.pipe(Layer.provide(sink))));
    }),
);

it.effect.each(["foreground", "identity"] as const)(
  "card_next records a stalled %s caller as a retryable timeout with partial timings",
  (lane) =>
    Effect.gen(function* () {
      const { layer, storeControl } = fakeThreads();
      const entered = yield* Deferred.make<void>();
      const ledger = yield* Deferred.make<AnalyticsEvent>();
      const sink = Layer.mock(Analytics.Analytics)({
        record: (event) =>
          event.kind === "mcp.call" && event.tool === "card_next"
            ? Deferred.succeed(ledger, event).pipe(Effect.asVoid)
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        let thread = ThreadId.make("blocked-caller");
        if (lane === "identity") {
          const kanban = yield* KanbanService.KanbanService;
          const board = yield* kanban.ensureBoard({
            slug: "identity-next",
            name: "Identity next",
            defaultProjectId: ProjectId.make("project-1"),
          });
          yield* kanban.setPool(board.id, board.defaultCardModel, 1);
          const card = yield* kanban.createCard(
            board.id,
            { title: "Lookup", prompt: "private-lookup" },
            owner,
          );
          yield* kanban.dispatchNow;
          thread = (yield* kanban.card(card.id)).card.workThreadId!;
        }
        const block = () =>
          Effect.gen(function* () {
            assert.equal(yield* NodeSqliteClient.ReaderLane, lane);
            const start = yield* NodeSqliteClient.ReaderWaitStartedObserver;
            start?.(lane);
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          });
        if (lane === "identity") storeControl.beforeClaimContext = block;
        else storeControl.beforeThreadLink = block;
        const request = yield* call(thread, "card_next", {}).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("2 seconds");
        const result = yield* Fiber.join(request);
        assert.isTrue(result.isError);
        assert.include(result.text, "card_next is busy");
        assert.equal(result.structured.code, "lookup_timeout");
        const row = yield* Deferred.await(ledger);
        assert.equal(row.outcome, "timeout");
        assert.equal(row.errorTag, "lookup_timeout");
        assert.equal(row.errorPhase, "caller");
        assert.equal(row.readerLane, lane);
        assert.isFalse(row.callerResolved);
        assert.isAtLeast(row.callerResolveMs!, 2000);
        assert.isAtLeast(row.cardNextStages![0]!.durationMs, 2000);
        assert.isAtLeast(row.cardNextStages![0]!.readerWaitMs, 2000);
        assert.isFalse(row.cardNextStages![0]!.completed);
      }).pipe(Effect.provide(layer.pipe(Layer.provide(sink))));
    }),
);

const releaseFixture = Effect.gen(function* () {
  const { kanban, store, board } = yield* waitFixture;
  const evaluator = yield* kanban.startEvaluator(board.id, {
    kind: "request",
    text: "Release pacing",
  });
  const actor = { _tag: "evaluator", threadId: evaluator } as const;
  const at = DateTime.formatIso(yield* DateTime.now);
  const approval = {
    id: "sa-pacing",
    gate: "deploy" as const,
    quote: "Boards may release on their own",
    sourceThreadId: "owner-thread",
    saidAt: at,
    approvedAsk: { cardId: "source", askId: "q1" },
    recordedAt: at,
    recordedBy: evaluator,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
  };
  yield* store.putBoard({ ...board, standingApprovals: [approval] });
  let releaseNumber = 0;
  const create = (
    patch: { interrupting?: boolean; ownerOnly?: boolean; gate?: "deploy"; service?: string } = {
      interrupting: true,
    },
  ) =>
    kanban.createCard(
      board.id,
      {
        title: `Apply build ${++releaseNumber}`,
        prompt: "Apply build",
        subtasks: [{ text: "Apply build", owner: "evaluator", ...patch }],
      },
      actor,
    );
  return { kanban, store, board, evaluator, actor, approval, create };
});

it.effect(
  "interrupting releases persist receipts, pace other cards, and expose the compact window",
  () => {
    return Effect.gen(function* () {
      const { kanban, store, board, actor, approval, evaluator, create } = yield* releaseFixture;
      const first = yield* create();
      const done = yield* kanban.markSubtask(
        first.id,
        "s1",
        "done",
        "Installed",
        actor,
        "evaluator",
      );
      const firstAt = done.subtasks[0]!.doneAt!;
      let ledger = (yield* kanban.snapshot(board.id)).board.releaseLedger!;
      assert.deepStrictEqual(ledger, [
        {
          boardId: board.id,
          cardId: first.id,
          cardNumber: first.number,
          subtaskId: "s1",
          at: firstAt,
          critical: null,
          approvalId: approval.id,
        },
      ]);
      yield* TestClock.adjust("3 hours");
      const second = yield* create();
      const denied = yield* kanban
        .markSubtask(second.id, "s1", "done", "Installed", actor, "evaluator")
        .pipe(Effect.flip);
      assert.include(denied.detail, "inside the 4 h release window");
      assert.include(denied.detail, `last release #${first.number}`);
      assert.include(denied.detail, "next window");
      assert.lengthOf((yield* kanban.snapshot(board.id)).board.releaseLedger!, 1);
      const read = yield* call(evaluator, "board_get", { boardId: board.slug });
      const compact = (
        read.structured.board as {
          board: { releaseLedger: ReadonlyArray<unknown>; nextReleaseWindowAt: string | null };
        }
      ).board;
      assert.deepStrictEqual(compact.releaseLedger, ledger);
      assert.strictEqual(
        compact.nextReleaseWindowAt,
        DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(firstAt), { hours: 4 })),
      );
      const ordinary = yield* create({ gate: "deploy" });
      yield* kanban.markSubtask(ordinary.id, "s1", "done", "Installed", actor, "evaluator");
      assert.lengthOf((yield* kanban.snapshot(board.id)).board.releaseLedger!, 1);
      yield* kanban.markSubtask(
        second.id,
        "s1",
        "done",
        "critical: server will not start after .10",
        actor,
        "evaluator",
      );
      ledger = (yield* kanban.snapshot(board.id)).board.releaseLedger!;
      assert.strictEqual(ledger[1]!.critical, "server will not start after .10");
      yield* TestClock.adjust(4 * 3_600_000 + 60_000);
      const third = yield* create();
      yield* kanban.markSubtask(third.id, "s1", "done", null, actor, "evaluator");
      assert.lengthOf((yield* kanban.snapshot(board.id)).board.releaseLedger!, 3);
      // Later lifecycle checks must not reject a release against its own receipt.
      yield* kanban.moveCard(third.id, "verified", "evaluator", actor);
      const worker = ThreadId.make("pacing-worker");
      yield* store.putThreadLink({
        ...(yield* kanban.caller(evaluator))!,
        threadId: worker,
        role: "work",
        cardId: first.id,
      });
      for (const interrupting of [true, false]) {
        const refused = yield* call(worker, "card_create", {
          title: "Release",
          prompt: "Release",
          subtasks: [{ text: "Apply build", owner: "evaluator", interrupting }],
        });
        assert.isTrue(refused.isError);
        assert.include(refused.text, "only evaluators");
        const edit = yield* kanban
          .editCard(
            second.id,
            { subtasks: [{ id: "s1", interrupting }] },
            { _tag: "thread", threadId: worker },
          )
          .pipe(Effect.flip);
        assert.include(edit.detail, "only evaluators");
      }
    }).pipe(Effect.provide(fakeThreads().layer));
  },
);

const releasePeer = Effect.fn("test.releasePeer")(function* (
  fixture: Effect.Success<typeof releaseFixture>,
) {
  const { kanban, store, board, approval } = fixture;
  const health = yield* kanban.ensureBoard({
    slug: "health",
    name: "Health",
    defaultProjectId: board.defaultProjectId,
  });
  const evaluator = yield* kanban.startEvaluator(health.id, { kind: "request", text: "Release" });
  const actor = { _tag: "evaluator", threadId: evaluator } as const;
  yield* store.putBoard({ ...health, standingApprovals: [approval] });
  return { board: health, actor, evaluator };
});

it.effect("replays Watchers #66 versus telegram #64 and Health #22 across boards", () =>
  Effect.gen(function* () {
    const fixture = yield* releaseFixture;
    const { kanban, store, board, evaluator, create } = fixture;
    const health = yield* releasePeer(fixture);
    const card = yield* create({ interrupting: true, service: " RoBoB-Watch " });
    assert.strictEqual(card.subtasks[0]!.service, "robob-watch");
    const row = {
      boardId: board.id,
      cardId: card.id,
      cardNumber: 64,
      subtaskId: "s1",
      at: "2026-11-15T08:07:00.000Z",
      service: "telegram-bridge",
      critical: null,
      approvalId: "sa-pacing",
    };
    yield* store.putBoard({ ...(yield* kanban.snapshot(board.id)).board, releaseLedger: [row] });
    yield* store.putBoard({
      ...(yield* kanban.snapshot(health.board.id)).board,
      releaseLedger: [
        {
          ...row,
          boardId: health.board.id,
          service: "robob-watch",
          cardNumber: 22,
          at: "2026-11-15T02:13:00.000Z",
        },
      ],
    });
    yield* TestClock.adjust(
      Date.parse("2026-11-15T05:00:00.000Z") - (yield* Clock.currentTimeMillis),
    );
    const refused = yield* call(evaluator, "subtask_done", {
      card: card.id,
      subtask: "s1",
      state: "done",
    });
    assert.isTrue(refused.isError);
    assert.include(
      refused.text,
      "last robob-watch release Health #22 at 02:13Z, next window 06:13Z",
    );
    for (const extra of [{}, { since: "24h" }]) {
      const read = yield* call(evaluator, "board_get", { ...extra, boardId: board.slug });
      assert.isFalse(read.isError, read.text);
      const summary = extra.since
        ? read.structured.board
        : (read.structured.board as { board: unknown }).board;
      assert.deepStrictEqual(
        (summary as { nextReleaseWindowByService: unknown }).nextReleaseWindowByService,
        {
          "robob-watch": "2026-11-15T06:13:00.000Z",
          "telegram-bridge": "2026-11-15T12:07:00.000Z",
        },
      );
    }
    yield* TestClock.adjust(4 * 3_600_000 + 11 * 60_000);
    const done = yield* call(evaluator, "subtask_done", {
      card: card.id,
      subtask: "s1",
      state: "done",
    });
    assert.isFalse(done.isError, done.text);
    const foreign = yield* kanban.createCard(
      health.board.id,
      {
        title: "Apply build",
        prompt: "Apply build",
        subtasks: [
          { text: "Apply build", owner: "evaluator", interrupting: true, service: "robob-watch" },
        ],
      },
      health.actor,
    );
    const denied = yield* kanban
      .markSubtask(foreign.id, "s1", "done", null, health.actor, "evaluator")
      .pipe(Effect.flip);
    assert.include(denied.detail, `last robob-watch release ${board.name} #${card.number}`);
    assert.include(denied.detail, "next window 13:11Z");
  }).pipe(Effect.provide(fakeThreads().layer)),
);

it.effect("post-hoc ticks keep restart time, ledger ordering and the original window", () =>
  Effect.gen(function* () {
    const { kanban, store, board, actor, evaluator, create } = yield* releaseFixture;
    const card = yield* create({ interrupting: true, service: "robob-watch" });
    const base = yield* Clock.currentTimeMillis;
    const iso = (hours: number) =>
      DateTime.formatIso(DateTime.makeUnsafe(base + hours * 3_600_000));
    const row = {
      boardId: board.id,
      cardId: card.id,
      cardNumber: 1,
      subtaskId: "s1",
      at: iso(1.5),
      service: "robob-watch",
      critical: null,
      approvalId: "sa-pacing",
    };
    yield* store.putBoard({
      ...(yield* kanban.snapshot(board.id)).board,
      releaseLedger: [row, { ...row, at: iso(4), service: "telegram-bridge" }],
    });
    yield* TestClock.adjust("5 hours");
    const done = yield* call(evaluator, "subtask_done", {
      card: card.id,
      subtask: "s1",
      state: "done",
      releasedAt: iso(2),
    });
    assert.isFalse(done.isError, done.text);
    const ledger = (yield* kanban.snapshot(board.id)).board.releaseLedger!;
    assert.deepStrictEqual(
      ledger.map((entry) => entry.at),
      [iso(1.5), iso(2), iso(4)],
    );
    assert.deepStrictEqual(ledger[1], {
      ...row,
      cardNumber: card.number,
      at: iso(2),
      postHoc: true,
    });
    const read = yield* call(evaluator, "board_get", { boardId: board.slug });
    const summary = (
      read.structured.board as {
        board: { releaseLedger: unknown; nextReleaseWindowByService: unknown };
      }
    ).board;
    assert.deepStrictEqual(summary.releaseLedger, ledger);
    assert.deepStrictEqual(summary.nextReleaseWindowByService, {
      "robob-watch": iso(6),
      "telegram-bridge": iso(8),
    });
    const next = yield* create({ interrupting: true, service: "robob-watch" });
    const refused = yield* kanban
      .markSubtask(next.id, "s1", "done", null, actor, "evaluator")
      .pipe(Effect.flip);
    assert.include(refused.detail, `next window ${iso(6).slice(11, 16)}Z`);
    yield* TestClock.adjust("1 hour");
    yield* kanban.markSubtask(next.id, "s1", "done", null, actor, "evaluator");
  }).pipe(Effect.provide(fakeThreads().layer)),
);

it.effect.each([
  { name: "future", delta: 60_001, interrupting: true, state: "done" as const, message: "future" },
  {
    name: "before creation",
    delta: -1,
    interrupting: true,
    state: "done" as const,
    message: "createdAt",
  },
  {
    name: "non-interrupting",
    delta: 0,
    interrupting: false,
    state: "done" as const,
    message: "interrupting",
  },
  { name: "skipped", delta: 0, interrupting: true, state: "skipped" as const, message: "done" },
  { name: "open", delta: 0, interrupting: true, state: "open" as const, message: "done" },
  {
    name: "malformed",
    delta: 0,
    interrupting: true,
    state: "done" as const,
    message: "ISO datetime",
  },
  {
    name: "calendar rollover",
    delta: 0,
    interrupting: true,
    state: "done" as const,
    message: "ISO datetime",
  },
  {
    name: "midnight rollover",
    delta: 0,
    interrupting: true,
    state: "done" as const,
    message: "ISO datetime",
  },
])("refuses releasedAt $name", ({ name, delta, interrupting, state, message }) =>
  Effect.gen(function* () {
    const { kanban, board, actor, create } = yield* releaseFixture;
    const card = yield* create({ interrupting });
    const at =
      new Map([
        ["malformed", "yesterday"],
        ["calendar rollover", "2026-02-30T12:00:00.000Z"],
        ["midnight rollover", "2026-01-01T24:00:00.000Z"],
      ]).get(name) ?? DateTime.formatIso(DateTime.makeUnsafe(Date.parse(card.createdAt) + delta));
    const refused = yield* kanban
      .markSubtask(card.id, "s1", state, null, actor, "evaluator", at)
      .pipe(Effect.flip);
    assert.include(refused.detail, message);
    assert.lengthOf((yield* kanban.snapshot(board.id)).board.releaseLedger ?? [], 0);
  }).pipe(Effect.provide(fakeThreads().layer)),
);

it.effect("accepts releasedAt within clock skew and canonicalizes timezone offsets", () =>
  Effect.gen(function* () {
    const { kanban, board, actor, create } = yield* releaseFixture;
    const card = yield* create();
    const at = DateTime.formatIso(DateTime.makeUnsafe(Date.parse(card.createdAt) + 60_000));
    const offset = DateTime.formatIso(DateTime.makeUnsafe(Date.parse(at) + 4 * 3_600_000)).replace(
      "Z",
      "+04:00",
    );
    yield* kanban.markSubtask(card.id, "s1", "done", null, actor, "evaluator", offset);
    assert.strictEqual((yield* kanban.snapshot(board.id)).board.releaseLedger![0]!.at, at);
  }).pipe(Effect.provide(fakeThreads().layer)),
);

it.effect("only evaluators can set or clear service via create and edit", () =>
  Effect.gen(function* () {
    const { kanban, store, evaluator, create } = yield* releaseFixture;
    const card = yield* create({ interrupting: true, service: "robob" });
    const worker = ThreadId.make("service-worker");
    yield* store.putThreadLink({
      ...(yield* kanban.caller(evaluator))!,
      threadId: worker,
      role: "work",
      cardId: card.id,
    });
    for (const service of ["robob", null]) {
      for (const [tool, input] of [
        [
          "card_create",
          {
            title: "Apply",
            prompt: "Apply",
            subtasks: [{ text: "Apply build", owner: "evaluator", service }],
          },
        ],
        ["card_edit", { card: card.id, subtasks: [{ id: "s1", service }] }],
      ] as const) {
        const refused = yield* call(worker, tool, input);
        assert.isTrue(refused.isError);
        assert.include(refused.text.toLowerCase(), "only evaluators");
      }
      const edit = yield* kanban
        .editCard(
          card.id,
          { subtasks: [{ id: "s1", service }] },
          { _tag: "thread", threadId: worker },
        )
        .pipe(Effect.flip);
      assert.include(edit.detail, "only evaluators");
      assert.include(edit.detail, "service");
    }
    const cleared = yield* call(evaluator, "card_edit", {
      card: card.id,
      subtasks: [{ id: "s1", service: null }],
    });
    assert.isFalse(cleared.isError, cleared.text);
    assert.isUndefined((yield* kanban.card(card.id)).card.subtasks[0]!.service);
  }).pipe(Effect.provide(fakeThreads().layer)),
);

it("old release receipts decode without service or postHoc", () => {
  const old = {
    boardId: KanbanBoardId.make("legacy"),
    cardId: KanbanCardId.make("card-1"),
    cardNumber: 1,
    subtaskId: "s1",
    at: "2026-11-15T02:13:00.000Z",
    critical: null,
    approvalId: null,
  };
  assert.deepStrictEqual(decodeRelease(old), old);
});

it.effect("board readback reconciles a release committed after the board inventory read", () =>
  Effect.gen(function* () {
    const { kanban, board, actor, create } = yield* releaseFixture;
    const earlierBoards = yield* kanban.boards;
    const card = yield* create({ interrupting: true, service: "robob-watch" });
    yield* kanban.markSubtask(card.id, "s1", "done", null, actor, "evaluator");
    const fresh = (yield* kanban.replySnapshot(board.id)).board;
    const at = DateTime.formatIso(yield* DateTime.now);
    const summary = boardReleaseSummary(fresh, at, earlierBoards);
    const next = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(at), { hours: 4 }));
    assert.lengthOf(summary.releaseLedger, 1);
    assert.strictEqual(summary.nextReleaseWindowAt, next);
    assert.deepStrictEqual(summary.nextReleaseWindowByService, { "robob-watch": next });
  }).pipe(Effect.provide(fakeThreads().layer)),
);

it.effect("a stalled review tick does not block an ordinary tick on another board", () => {
  const fake = fakeThreads();
  return Effect.gen(function* () {
    const fixture = yield* releaseFixture;
    const { kanban, store, actor, create } = fixture;
    const peer = yield* releasePeer(fixture);
    const card = yield* create({});
    const workThreadId = ThreadId.make("stalled-review-work");
    yield* store.putCard({
      ...card,
      stage: "needs_review",
      reviewFindingsPending: false,
      workThreadId,
      activeThreadId: null,
      subtasks: [{ ...card.subtasks[0]!, owner: "review", text: "Review result" }],
    });
    const other = yield* kanban.createCard(
      peer.board.id,
      {
        title: "Check result",
        prompt: "Check result",
        subtasks: [{ text: "Check result", owner: "evaluator" }],
      },
      peer.actor,
    );
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    fake.viewControl.beforeRead = (id) =>
      id === workThreadId
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
        : Effect.void;
    const review = yield* kanban
      .markSubtask(card.id, "s1", "done", "Reviewed", actor, "evaluator")
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const done = yield* kanban.markSubtask(
      other.id,
      "s1",
      "done",
      "Checked",
      peer.actor,
      "evaluator",
    );
    assert.strictEqual(done.subtasks[0]!.state, "done");
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(review);
  }).pipe(Effect.provide(fake.layer));
});

it.effect("a second release cannot hold the board lock while the first prunes wakes", () => {
  const fake = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, store, board, actor, create } = yield* releaseFixture;
    const first = yield* create({ interrupting: true, service: "robob-watch" });
    const second = yield* create({ interrupting: true, service: "robob-watch" });
    const threadId = ThreadId.make("prune-release-worker");
    yield* store.putCard({
      ...first,
      stage: "needs_review",
      workThreadId: threadId,
      subtasks: [
        ...first.subtasks,
        {
          ...first.subtasks[0]!,
          id: "s2",
          step: 2,
          text: "Implement next change",
          owner: "work",
          interrupting: false,
          service: undefined,
          gate: undefined,
        },
      ],
    });
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    fake.queueControl.beforeRead = (id) =>
      id === threadId
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
        : Effect.void;
    const initial = yield* kanban
      .markSubtask(first.id, "s1", "done", null, actor, "evaluator")
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const logger = Logger.make(({ message }) => {
      if (Array.isArray(message) && message[0] === "kanban release admission waiting")
        Deferred.doneUnsafe(secondEntered, Effect.void);
    });
    const later = yield* kanban
      .markSubtask(second.id, "s1", "done", null, actor, "evaluator")
      .pipe(
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.result,
        Effect.forkScoped,
      );
    yield* Deferred.await(secondEntered);
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(initial);
    const denied = yield* Fiber.join(later);
    assert.isTrue(Result.isFailure(denied));
    if (Result.isFailure(denied))
      assert.include(denied.failure.detail, "inside the 4 h release window");
    assert.lengthOf((yield* kanban.snapshot(board.id)).board.releaseLedger!, 1);
    assert.strictEqual((yield* kanban.card(first.id)).card.subtasks[0]!.state, "done");
  }).pipe(Effect.provide(fake.layer));
});

it.effect("parallel same-service ticks on different boards admit one release", () =>
  Effect.gen(function* () {
    const fixture = yield* releaseFixture;
    const { kanban, board, actor, create } = fixture;
    const peer = yield* releasePeer(fixture);
    const first = yield* create({ interrupting: true, service: "robob-watch" });
    const second = yield* kanban.createCard(
      peer.board.id,
      {
        title: "Apply",
        prompt: "Apply",
        subtasks: [
          { text: "Apply build", owner: "evaluator", interrupting: true, service: "robob-watch" },
        ],
      },
      peer.actor,
    );
    const results = yield* Effect.all(
      [
        kanban.markSubtask(first.id, "s1", "done", null, actor, "evaluator").pipe(Effect.result),
        kanban
          .markSubtask(second.id, "s1", "done", null, peer.actor, "evaluator")
          .pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    assert.lengthOf(results.filter(Result.isSuccess), 1);
    const count =
      ((yield* kanban.snapshot(board.id)).board.releaseLedger?.length ?? 0) +
      ((yield* kanban.snapshot(peer.board.id)).board.releaseLedger?.length ?? 0);
    assert.strictEqual(count, 1);
  }).pipe(Effect.provide(fakeThreads().layer)),
);

it.effect(
  "on-card owner yes overrides pacing and ownerOnly; other boards have independent windows",
  () =>
    Effect.gen(function* () {
      const { kanban, store, board, actor, create } = yield* releaseFixture;
      const first = yield* create();
      yield* kanban.markSubtask(first.id, "s1", "done", null, actor, "evaluator");
      const restricted = yield* create({ interrupting: true, ownerOnly: true });
      const denied = yield* kanban
        .markSubtask(
          restricted.id,
          "s1",
          "done",
          "critical: server will not start",
          actor,
          "evaluator",
        )
        .pipe(Effect.flip);
      assert.include(denied.detail, "marked owner-only");
      for (const card of [restricted, yield* create()]) {
        yield* kanban.askOwner(
          card.id,
          { question: "Approve s1", action: { summary: "Apply build" }, blocking: false },
          actor,
          "evaluator",
        );
        yield* kanban.answerAsk(card.id, "q1", { verdict: "approved", revision: 0 }, owner);
        yield* kanban.markSubtask(card.id, "s1", "done", "Installed", actor, "evaluator");
        assert.strictEqual(
          (yield* kanban.snapshot(board.id)).board.releaseLedger!.at(-1)!.approvalId,
          null,
        );
      }
      const other = yield* kanban.ensureBoard({
        slug: "another",
        name: "Another",
        defaultProjectId: board.defaultProjectId,
      });
      const otherEvaluator = yield* kanban.startEvaluator(other.id, {
        kind: "request",
        text: "Release",
      });
      const otherActor = { _tag: "evaluator", threadId: otherEvaluator } as const;
      const saved = (yield* kanban.snapshot(board.id)).board;
      yield* store.putBoard({
        ...other,
        standingApprovals: saved.standingApprovals,
        releaseLedger: saved.releaseLedger,
      });
      const card = yield* kanban.createCard(
        other.id,
        {
          title: "Apply",
          prompt: "Apply",
          subtasks: [{ text: "Apply build", owner: "evaluator", interrupting: true }],
        },
        otherActor,
      );
      yield* kanban.markSubtask(card.id, "s1", "done", null, otherActor, "evaluator");
      const noApproval = yield* create();
      yield* store.putBoard({ ...saved, standingApprovals: [] });
      const no = yield* kanban
        .markSubtask(
          noApproval.id,
          "s1",
          "done",
          "critical: server will not start",
          actor,
          "evaluator",
        )
        .pipe(Effect.flip);
      assert.include(no.detail, "no standing deploy approval");
    }).pipe(Effect.provide(fakeThreads().layer)),
);

it.effect("parallel evaluators cannot clear two interrupting releases in one window", () =>
  Effect.gen(function* () {
    const { kanban, board, actor, create } = yield* releaseFixture;
    const cards = [yield* create(), yield* create()];
    const results = yield* Effect.all(
      cards.map((card) =>
        kanban.markSubtask(card.id, "s1", "done", null, actor, "evaluator").pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    assert.lengthOf(results.filter(Result.isSuccess), 1);
    assert.lengthOf((yield* kanban.snapshot(board.id)).board.releaseLedger!, 1);
  }).pipe(Effect.provide(fakeThreads().layer)),
);

it.effect("release ledger and pacing survive rebuilding the service on the same database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "release-pacing-restart-" });
    const db = path.join(dir, "state.sqlite");
    const saved = yield* Effect.gen(function* () {
      const { kanban, board, actor, create } = yield* releaseFixture;
      const first = yield* create();
      yield* kanban.markSubtask(first.id, "s1", "done", null, actor, "evaluator");
      const next = yield* create();
      return {
        boardId: board.id,
        nextId: next.id,
        actor,
        ledger: (yield* kanban.snapshot(board.id)).board.releaseLedger,
      };
    }).pipe(Effect.provide(fakeThreads(db).layer));
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      assert.deepStrictEqual(
        (yield* kanban.snapshot(saved.boardId)).board.releaseLedger,
        saved.ledger,
      );
      const refused = yield* kanban
        .markSubtask(saved.nextId, "s1", "done", null, saved.actor, "evaluator")
        .pipe(Effect.flip);
      assert.include(refused.detail, "inside the 4 h release window");
    }).pipe(Effect.provide(fakeThreads(db).layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("release receipt rolls back if completion fails, and retains only the newest 200", () => {
  const fake = fakeThreads();
  return Effect.gen(function* () {
    const { kanban, store, board, actor, create, evaluator } = yield* releaseFixture;
    const card = yield* create();
    fake.storeControl.beforeCardWrite = () =>
      Effect.fail(
        new KanbanStore.KanbanStoreError({ operation: "write card", cause: "unavailable" }),
      );
    const failed = yield* kanban
      .markSubtask(card.id, "s1", "done", null, actor, "evaluator")
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(failed));
    assert.lengthOf((yield* kanban.snapshot(board.id)).board.releaseLedger!, 0);
    assert.strictEqual((yield* kanban.card(card.id)).card.subtasks[0]!.state, "open");
    delete fake.storeControl.beforeCardWrite;
    const saved = (yield* kanban.snapshot(board.id)).board;
    const at = DateTime.formatIso(yield* DateTime.now);
    const history = Array.from({ length: 205 }, (_, index) => ({
      boardId: board.id,
      cardId: card.id,
      cardNumber: index + 1,
      subtaskId: "s1",
      at,
      critical: null,
      approvalId: "sa-pacing",
    }));
    yield* store.putBoard({ ...saved, releaseLedger: history });
    yield* TestClock.adjust(4 * 3_600_000 + 60_000);
    yield* kanban.markSubtask(card.id, "s1", "done", null, actor, "evaluator");
    const ledger = (yield* kanban.snapshot(board.id)).board.releaseLedger!;
    assert.lengthOf(ledger, 200);
    assert.strictEqual(ledger[0]!.cardNumber, 7);
    const read = yield* call(evaluator, "board_get", { boardId: board.slug });
    const compact = (
      read.structured.board as {
        board: { releaseLedger: ReadonlyArray<unknown>; nextReleaseWindowAt: string | null };
      }
    ).board;
    assert.deepStrictEqual(compact.releaseLedger, ledger.slice(-5));
    yield* TestClock.adjust(4 * 3_600_000 + 60_000);
    const open = yield* call(evaluator, "board_get", { boardId: board.slug });
    assert.strictEqual(
      (open.structured.board as { board: { nextReleaseWindowAt: string | null } }).board
        .nextReleaseWindowAt,
      null,
    );
  }).pipe(Effect.provide(fake.layer));
});

it.effect.each([
  { name: "unreviewed", reviewRound: 0, pending: undefined, expected: undefined },
  { name: "legacy", reviewRound: 1, pending: undefined, expected: false },
  { name: "repaired clear", reviewRound: 1, pending: false, expected: false },
  { name: "repaired findings", reviewRound: 1, pending: true, expected: true },
])(
  "$name findings repair cannot commit a release completion before its receipt",
  ({ reviewRound, pending, expected }) => {
    const fake = fakeThreads();
    return Effect.gen(function* () {
      const { kanban, store, board, actor, create } = yield* releaseFixture;
      const card = yield* create();
      const { reviewFindingsPending: _pending, ...legacy } = card;
      const { interrupting: _interrupting, gate: _gate, ...review } = card.subtasks[0]!;
      yield* store.putCard({
        ...legacy,
        reviewRound,
        ...(pending === undefined ? {} : { reviewFindingsPending: pending }),
        subtasks: [
          ...card.subtasks,
          { ...review, id: "s2", step: 2, owner: "review", text: "Review build" },
        ],
      });
      fake.storeControl.beforeCardEvent = (event) =>
        event.kind === "subtask"
          ? Effect.fail(
              new KanbanStore.KanbanStoreError({
                operation: "subtask event",
                cause: "unavailable after findings repair",
              }),
            )
          : Effect.void;
      const failed = yield* kanban
        .markSubtask(card.id, "s1", "done", null, actor, "evaluator")
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(failed));
      assert.strictEqual((yield* store.card(card.id))!.subtasks[0]!.state, "open");
      assert.lengthOf((yield* kanban.snapshot(board.id)).board.releaseLedger!, 0);
      delete fake.storeControl.beforeCardEvent;
      yield* kanban.markSubtask(card.id, "s1", "done", null, actor, "evaluator");
      const saved = (yield* store.card(card.id))!;
      assert.strictEqual(saved.reviewFindingsPending, expected);
      assert.strictEqual(saved.subtasks[0]!.state, "done");
      assert.lengthOf((yield* kanban.snapshot(board.id)).board.releaseLedger!, 1);
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect("a top-level board evaluator skips an explicit gate through subtask_done", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "skip-root",
      name: "Skip root",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const root = yield* kanban.startEvaluator(board.id, {
      kind: "request",
      text: "Review the gate",
    });
    const card = yield* kanban.createCard(
      board.id,
      {
        title: "Misfiled gate",
        prompt: "Work",
        subtasks: [{ text: "Edit fork source", owner: "evaluator", gate: "deploy" }],
      },
      owner,
    );
    const skipped = yield* call(root, "subtask_done", {
      card: card.id,
      subtask: "s1",
      state: "skipped",
      note: "Only edits fork code",
    });
    assert.isFalse(skipped.isError, skipped.text);
    const saved = (yield* kanban.card(card.id)).card;
    assert.deepStrictEqual(saved.subtasks[0]!.gateSkipped?.by, {
      _tag: "evaluator",
      threadId: root,
    });
    const refused = yield* call(root, "subtask_done", {
      card: card.id,
      subtask: "s1",
      state: "done",
      note: "Did it",
    });
    assert.isTrue(refused.isError);
    assert.include(refused.text, "needs Abdullah's approval");
  }).pipe(Effect.provide(layer));
});

it.effect("a worker's later-step subtask refusal keeps its message and fixed reason", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "reason",
      name: "Reason",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 3);
    const card = yield* kanban.createCard(
      board.id,
      {
        title: "Steps",
        prompt: "Work",
        subtasks: [
          { text: "First", owner: "work", step: 1 },
          { text: "Second", owner: "work", step: 2 },
        ],
      },
      owner,
    );
    yield* kanban.dispatchNow;
    const worker = (yield* kanban.card(card.id)).card.workThreadId!;
    const denied = yield* call(worker, "subtask_done", {
      card: card.id,
      subtask: "s2",
      state: "done",
    });
    assert.isTrue(denied.isError);
    assert.include(denied.text, "subtask s2 is in step 2; finish step 1 first");
    assert.include(denied.text, "subtask_not_in_current_step");
    const move = yield* call(worker, "card_move", { card: card.id, to: "in_review" });
    assert.isTrue(move.isError);
    assert.include(move.text, "stage_owned_by_dispatcher");
  }).pipe(Effect.provide(layer));
});

it.effect.each(["idle", "busy", "home-moved-on"] as const)(
  "evaluator forThread atomically assigns to an existing %s thread and queues its brief",
  (state) => {
    const sent: Array<Parameters<KanbanThreads["Service"]["send"]>[0]> = [];
    const fake = fakeThreads(undefined, undefined, undefined, undefined, undefined, {
      findExisting: true,
      send: (input) =>
        Effect.sync(() => {
          sent.push(input);
          return "assignment-run";
        }),
    });
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "handoff",
        name: "Handoff",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const origin = yield* kanban.createCard(
        board.id,
        { title: "Origin", prompt: "Origin" },
        owner,
      );
      const other = yield* kanban.createCard(board.id, { title: "Other", prompt: "Other" }, owner);
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(origin.id)).card.workThreadId!;
      const second = (yield* kanban.card(other.id)).card.workThreadId!;
      if (state === "home-moved-on")
        yield* kanban.moveCard(origin.id, "needs_review", "cardThread", {
          _tag: "thread",
          threadId: worker,
        });
      if (state === "busy") fake.running.add(worker);
      const evaluator = yield* kanban.startEvaluator(board.id, { kind: "check" });
      const launches = fake.launches.length;
      sent.length = 0;
      const created = yield* call(evaluator, "card_create", {
        forThread: worker,
        title: "Follow-up",
        description: "Explicit",
        prompt: "Use the existing context",
      });
      assert.isFalse(created.isError, created.text);
      const card = decodeCard(created.structured.card);
      assert.strictEqual(card.stage, "working");
      assert.strictEqual(card.activeThreadId, worker);
      assert.deepStrictEqual(card.createdBy, { _tag: "evaluator", threadId: evaluator });
      assert.deepStrictEqual(card.model, board.defaultCardModel);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0]!.threadId, worker);
      assert.strictEqual(sent[0]!.mode, "queue");
      assert.include(sent[0]!.text, "Use the existing context");
      assert.lengthOf(fake.interrupts, 0);
      if (state === "busy") {
        assert.isTrue(fake.running.has(worker));
        assert.strictEqual((yield* kanban.card(origin.id)).card.stage, "working");
      }
      const stolen = yield* call(second, "card_claim", { card: card.id });
      assert.isTrue(stolen.isError, stolen.text);
      const events = (yield* kanban.card(card.id)).events;
      assert.isTrue(
        events.some((event) => event.actor._tag === "evaluator" && event.body?.includes(worker)),
      );
      // Keep the completed home card from starting its review during this tick.
      if (state === "home-moved-on") yield* kanban.flagCard(origin.id, "Review later", owner);
      yield* kanban.dispatchNow;
      assert.strictEqual(fake.launches.length, launches);
      assert.strictEqual((yield* kanban.card(card.id)).card.activeThreadId, worker);
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect.each([
  "worker",
  "reviewer",
  "unlinked",
  "both",
  "foreign-board",
  "missing",
  "ended",
  "paused",
  "stopped",
  "cancelled",
  "archived",
  "model",
  "project",
  "backlog",
  "needs-owner",
  "full-batch",
  "target-reviewer",
] as const)("evaluator forThread refuses %s before inserting anything", (reason) => {
  const fake = fakeThreads(undefined, undefined, undefined, undefined, undefined, {
    findExisting: true,
    send: () => Effect.void,
  });
  const expectedReasons = {
    worker: "role_not_allowed",
    reviewer: "role_not_allowed",
    unlinked: "role_not_allowed",
    both: "invalid_args",
    "foreign-board": "cross_board",
    missing: "resource_not_found",
    ended: "target_thread_unavailable",
    paused: "target_thread_unavailable",
    stopped: "target_thread_stopped",
    cancelled: "target_thread_stopped",
    archived: "target_thread_unavailable",
    model: "model_pool_mismatch",
    project: "project_mismatch",
    backlog: "stage_not_allowed",
    "needs-owner": "stage_not_allowed",
    "full-batch": "thread_batch_full",
    "target-reviewer": "role_not_allowed",
  } as const;
  let pending: Deferred.Deferred<AnalyticsEvent> | undefined;
  const sink = Layer.mock(Analytics.Analytics)({
    record: (event) =>
      pending && event.kind === "mcp.call" && event.tool === "card_create"
        ? Deferred.succeed(pending, event).pipe(Effect.asVoid)
        : Effect.void,
  });
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const board = yield* kanban.ensureBoard({
      slug: "handoff-refusal",
      name: "Refusal",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 1);
    const origin = yield* kanban.createCard(board.id, { title: "Origin", prompt: "Origin" }, owner);
    yield* kanban.dispatchNow;
    const worker = (yield* kanban.card(origin.id)).card.workThreadId!;
    const evaluator = yield* kanban.startEvaluator(board.id, { kind: "check" });
    const link = (yield* store.threadLink(worker))!;
    if (reason === "foreign-board") {
      const other = yield* kanban.ensureBoard({
        slug: "foreign",
        name: "Foreign",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* store.putThreadLink({ ...link, boardId: other.id });
    }
    if (reason === "ended")
      yield* store.putThreadLink({ ...link, endedAt: "2026-10-26T08:00:00.000Z" });
    if (reason === "paused")
      yield* store.putThreadLink({
        ...link,
        paused: { message: "Quota", at: "2026-10-26T08:00:00.000Z", runId: null },
      });
    if (reason === "missing") fake.targetViews.set(worker, null);
    if (reason === "stopped" || reason === "cancelled")
      fake.latestRuns.set(worker, {
        runId: "stopped-run",
        status: reason === "cancelled" ? "cancelled" : "interrupted",
        message: "Stop",
      });
    if (reason === "archived") fake.targetViews.set(worker, { archived: true });
    if (reason === "reviewer" || reason === "target-reviewer")
      yield* store.putThreadLink({ ...link, role: "review" });
    if (reason === "full-batch")
      for (const n of [1, 2, 3])
        yield* kanban.createForThread(worker, { title: `Extra ${n}`, prompt: `Extra ${n}` });
    if (reason === "model")
      yield* kanban.setPool(
        board.id,
        {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "opus/gpt-6-astra",
          options: [{ id: "variant", value: "xhigh" }],
        },
        1,
      );
    const before = yield* kanban.cards(board.id);
    pending = yield* Deferred.make<AnalyticsEvent>();
    const result = yield* call(
      reason === "worker" || reason === "reviewer"
        ? worker
        : reason === "unlinked"
          ? ThreadId.make("outside")
          : evaluator,
      "card_create",
      {
        forThread: worker,
        title: "Refused",
        description: "Explicit",
        prompt: "Must not be saved",
        ...(reason === "both" ? { assignToSelf: true } : {}),
        ...(reason === "backlog" ? { priority: 5 } : {}),
        ...(reason === "needs-owner" ? { stage: "needs_owner", question: "Wait?" } : {}),
        ...(reason === "project" ? { projectId: "another-project" } : {}),
        ...(reason === "model"
          ? { model: { instanceId: "opencode", model: "opus/gpt-6-astra#xhigh" } }
          : {}),
      },
    );
    assert.isTrue(result.isError, result.text);
    assert.deepStrictEqual(yield* kanban.cards(board.id), before);
    assert.include(result.text, "Nothing was saved");
    const row = yield* Deferred.await(pending);
    assert.equal(row.denyReason, expectedReasons[reason]);
    assert.equal(row.errorTag, reason === "missing" ? "invalid_request" : "capability_denied");
    assert.equal(row.saved, reason === "missing" ? "unknown" : false);
    assert.equal(
      row.callerRole,
      reason === "worker"
        ? "work"
        : reason === "reviewer"
          ? "review"
          : reason === "unlinked"
            ? "none"
            : "evaluator",
    );
    assert.notInclude(JSON.stringify(row), "Must not be saved");
    assert.notInclude(JSON.stringify(row), "Nothing was saved");
  }).pipe(Effect.provide(fake.layer.pipe(Layer.provide(sink))));
});

it.effect.each(["queued", "in-flight"] as const)(
  "#1574 releasing a card withdraws its %s assignment without dropping sibling work",
  (timing) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const enqueued = yield* Deferred.make<void>();
      const withdrawn = yield* Deferred.make<void>();
      const runs: Array<{
        id: string;
        userMessageId: string;
        ordinal: number;
        status: "queued" | "cancelled";
      }> = [];
      const cancelled: string[] = [];
      const fake = fakeThreads(undefined, undefined, undefined, undefined, undefined, {
        findExisting: true,
        send: (input) =>
          Effect.gen(function* () {
            if (!input.coalesce?.startsWith("assignment:")) return;
            yield* Deferred.succeed(entered, undefined);
            if (timing === "in-flight") yield* Deferred.await(resume);
            runs.push({
              id: "assignment-run",
              userMessageId: `kanban:${input.coalesce}:delivery`,
              ordinal: 2,
              status: "queued",
            });
            yield* Deferred.succeed(enqueued, undefined);
            return "assignment-run";
          }),
        queuedRuns: () =>
          Effect.sync(
            () =>
              runs as unknown as Effect.Success<ReturnType<KanbanThreads["Service"]["queuedRuns"]>>,
          ),
        cancelQueued: (_thread, id) =>
          Effect.gen(function* () {
            const run = runs.find((run) => run.id === id);
            if (!run || run.status !== "queued") return false;
            run.status = "cancelled";
            cancelled.push(id);
            yield* Deferred.succeed(withdrawn, undefined);
            return true;
          }),
      });
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const board = yield* kanban.ensureBoard({
          slug: "assignment-release",
          name: "Assignment release",
          defaultProjectId: ProjectId.make("project-1"),
        });
        yield* kanban.setPool(board.id, board.defaultCardModel, 1);
        const origin = yield* kanban.createCard(
          board.id,
          { prompt: "Origin", title: "Origin" },
          owner,
        );
        yield* kanban.dispatchNow;
        const threadId = (yield* kanban.card(origin.id)).card.workThreadId!;
        const evaluator = yield* kanban.startEvaluator(board.id, { kind: "check" });
        const creating = yield* call(evaluator, "card_create", {
          forThread: threadId,
          prompt: "Follow-up",
          title: "Follow-up",
          description: "Explicit",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        assert.isFalse((yield* Fiber.join(creating)).isError);
        if (timing === "queued") yield* Deferred.await(enqueued);
        const card = (yield* kanban.cards(board.id)).find((card) => card.id !== origin.id)!;
        runs.push({
          id: "sibling-assignment",
          userMessageId: `kanban:assignment:${origin.id}:sibling`,
          ordinal: 3,
          status: "queued",
        });
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", { _tag: "thread", threadId });
        yield* Deferred.succeed(resume, undefined);
        yield* Deferred.await(withdrawn);
        assert.deepEqual(cancelled, ["assignment-run"]);
        assert.equal(runs.find((run) => run.id === "sibling-assignment")?.status, "queued");
        assert.equal((yield* kanban.card(origin.id)).card.activeThreadId, threadId);
        assert.lengthOf(fake.interrupts, 0);
      }).pipe(
        Effect.provide(
          fake.layer.pipe(Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred"))),
        ),
        Effect.ensuring(Deferred.succeed(resume, undefined)),
      );
    }),
);
