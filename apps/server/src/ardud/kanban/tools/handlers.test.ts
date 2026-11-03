import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  KanbanCardId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type KanbanActor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../../../mcp/McpToolAccess.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as KanbanService from "../engine/KanbanService.ts";
import * as KanbanModels from "../engine/models.ts";
import { KanbanThreads } from "../engine/threads.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import { opencodeTestProvider } from "../engine/testProviders.ts";
import * as KanbanHandlers from "./handlers.ts";
import { KanbanToolkit } from "./tools.ts";
import { ModelBody } from "../http.ts";

// Writes check the caller is the thread's live provider; liveThreadsLayer runs on codex.
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
const fakeThreads = (dbPath?: string) => {
  const running = new Set<string>();
  let launched = 0;
  const launches: Array<string> = [];
  const views: Array<string> = [];
  const threads = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      view: (threadId) =>
        Effect.sync(() => {
          views.push(threadId);
          return {
            threadId,
            projectId: ProjectId.make("project-1"),
            title: "thread",
            state: running.has(threadId) ? "running" : "idle",
            updatedAt: "2026-10-26T08:00:00.000Z",
            quietSince: "2026-10-26T08:00:00.000Z",
            runStartedAt: null,
            backgroundWork: 0,
            prs: [],
            archived: false,
          };
        }),
      find: () => Effect.succeed(null),
      lastFailure: () => Effect.succeed(null),
      latestRun: () => Effect.succeed(null),
      compactRun: () => Effect.succeed(null),
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input.text);
          return ThreadId.make(`thread-${++launched}`);
        }),
      send: () => Effect.void,
      model: () => Effect.succeed(null),
      setModel: () => Effect.void,
      interrupt: () => Effect.void,
    }),
  );
  const boardFilesLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-kanban-tools-test-",
  }).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(ServerSettings.layerTest()));
  const layer = McpHttpServer.toolkitRegistration(KanbanToolkit, KanbanHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(liveThreadsLayer),
    Layer.provideMerge(KanbanService.layer),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(threads),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(dbPath ? Sqlite.layerFromPath(dbPath) : Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(boardFilesLayer),
  );
  return { running, launches, views, layer };
};

const owner: KanbanActor = { _tag: "owner" };

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

it.effect(
  "a thread with several cards picks a card's discussion, but only of its own cards",
  () => {
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
      const other = yield* kanban.createCard(board.id, { prompt: "C", title: "C" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      running.add(thread);
      const second = (yield* kanban.createForThread(thread, { prompt: "B", title: "B" })).card;

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
      assert.include(theirs.text, `can't change card #${other.number}`);
    }).pipe(Effect.provide(layer));
  },
);

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

it.effect("board model inputs preserve native options and reject conflicting levels", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({ slug: "toy", name: "Toy", defaultProjectId: ProjectId.make("project-1") });
    const evaluator = ThreadId.make("thread-evaluator");
    const model = {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "max",
      options: [{ id: "fastMode", value: true }],
    };
    const set = yield* call(evaluator, "pool_set", { model, slots: 2 });
    assert.isFalse(set.isError, set.text);
    const pool = (yield* kanban.snapshot(board.id)).pools.find((entry) => entry.model.instanceId === "claudeAgent");
    assert.deepStrictEqual(pool?.model.options, [{ id: "fastMode", value: true }, { id: "effort", value: "max" }]);

    const rejected = yield* call(evaluator, "pool_set", {
      model: { ...model, variant: "high" }, slots: 3,
    });
    assert.isTrue(rejected.isError, rejected.text);
    assert.include(rejected.text, "effort and variant");
    assert.strictEqual((yield* kanban.snapshot(board.id)).pools.find((entry) => entry.key === pool?.key)?.slots, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("MCP model writes resolve legacy selections only under the apply flag", () => {
  const { layer } = fakeThreads();
  return Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const board = yield* kanban.ensureBoard({ slug: "toy", name: "Toy", defaultProjectId: ProjectId.make("project-1") });
    const evaluator = ThreadId.make("thread-evaluator");
    const opus = { instanceId: "opencode", model: "opus/claude-opus-5-5#high" };
    const haiku = { instanceId: "opencode", model: "opus/cc/claude-haiku-5-5#max" };

    // A separate level is accepted before migration without changing its identity.
    const legacy = { model: "opus/claude-opus-5-5", variant: "high" };
    const off = yield* call(evaluator, "pool_set", { model: legacy, slots: 0 });
    assert.isFalse(off.isError, off.text);
    assert.isTrue((yield* kanban.snapshot(board.id)).pools.some((pool) => pool.key === "opencode/opus/claude-opus-5-5#high"));

    yield* settings.updateSettings({ ardudHarnessMigration: { selections: "apply" } });
    const set = yield* call(evaluator, "pool_set", { model: opus, slots: 0 });
    assert.isFalse(set.isError, set.text);
    const setHaiku = yield* call(evaluator, "pool_set", { model: haiku, slots: 0 });
    assert.isFalse(setHaiku.isError, setHaiku.text);
    const pools = (yield* kanban.snapshot(board.id)).pools;
    assert.isTrue(pools.some((pool) => pool.key === "claudeAgent/claude-opus-5-5#high"));
    assert.isTrue(pools.some((pool) => pool.key === "claudeAgent/claude-haiku-5-5#max"));

    const created = yield* call(evaluator, "card_create", {
      prompt: "Mapped card", title: "Mapped card", description: "Explicit model",
      model: opus,
    });
    assert.isFalse(created.isError, created.text);
    const card = created.structured.card as { id: string; model: { instanceId: string; model: string } };
    assert.strictEqual(card.model.instanceId, "claudeAgent");
    assert.strictEqual(card.model.model, "claude-opus-5-5");

    const weightedCreated = yield* call(evaluator, "card_create", {
      prompt: "Weighted mapped card", title: "Weighted mapped card", description: "Weighted models",
      models: [{ ...opus, weight: 2 }, { ...haiku, weight: 1 }],
    });
    assert.isFalse(weightedCreated.isError, weightedCreated.text);
    const weightedCreatedCard = weightedCreated.structured.card as {
      models: ReadonlyArray<{ model: { instanceId: string } }>;
    };
    assert.deepStrictEqual(weightedCreatedCard.models.map((entry) => entry.model.instanceId), ["claudeAgent", "claudeAgent"]);

    const edited = yield* call(evaluator, "card_edit", { card: card.id, model: haiku });
    assert.isFalse(edited.isError, edited.text);
    assert.strictEqual((yield* kanban.card(KanbanCardId.make(card.id))).card.model.model, "claude-haiku-5-5");

    const weighted = yield* call(evaluator, "card_edit", {
      card: card.id, models: [{ ...opus, weight: 2 }, { ...haiku, weight: 1 }],
    });
    assert.isFalse(weighted.isError, weighted.text);
    const weightedCard = (yield* kanban.card(KanbanCardId.make(card.id))).card;
    assert.deepStrictEqual(weightedCard.models.map((entry) => entry.model.instanceId), ["claudeAgent", "claudeAgent"]);

    const conflict = yield* call(evaluator, "card_edit", {
      card: card.id, model: { ...opus, variant: "xhigh" },
    });
    assert.isTrue(conflict.isError, conflict.text);
    assert.include(conflict.text, "conflicting");
    assert.deepStrictEqual((yield* kanban.card(KanbanCardId.make(card.id))).card.models, weightedCard.models);

    const conflictCreate = yield* call(evaluator, "card_create", {
      prompt: "Refused card", title: "Refused card", description: "Should not be written",
      models: [{ ...opus, variant: "xhigh", weight: 1 }],
    });
    assert.isTrue(conflictCreate.isError, conflictCreate.text);
    assert.isFalse((yield* kanban.snapshot(board.id)).cards.some((candidate) => candidate.title === "Refused card"));

    const rejectedSet = yield* call(evaluator, "pool_set", {
      model: { ...opus, variant: "xhigh" }, slots: 8,
    });
    assert.isTrue(rejectedSet.isError, rejectedSet.text);
    assert.strictEqual((yield* kanban.snapshot(board.id)).pools.find((pool) => pool.key === "claudeAgent/claude-opus-5-5#high")?.slots, 0);

    // Use an unused native pool to exercise removal independently of card references.
    const astra = { instanceId: "opencode", model: "opus/gpt-6-astra#xhigh" };
    const setAstra = yield* call(evaluator, "pool_set", { model: astra, slots: 0 });
    assert.isFalse(setAstra.isError, setAstra.text);
    const rejectedRemove = yield* call(evaluator, "pool_remove", { model: { ...astra, effort: "high" } });
    assert.isTrue(rejectedRemove.isError, rejectedRemove.text);
    assert.isTrue((yield* kanban.snapshot(board.id)).pools.some((pool) => pool.key === "codex/gpt-6-astra#xhigh"));
    const removed = yield* call(evaluator, "pool_remove", { model: astra });
    assert.isFalse(removed.isError, removed.text);
    assert.isFalse((yield* kanban.snapshot(board.id)).pools.some((pool) => pool.key === "codex/gpt-6-astra#xhigh"));
  }).pipe(Effect.provide(layer));
});

it.effect("HTTP model input decodes full native options and legacy variants", () =>
  Effect.sync(() => {
    const decode = Schema.decodeUnknownResult(ModelBody);
    const native = decode({
      instanceId: "codex", model: "gpt-6.1-sol", effort: "high",
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

it.effect("evaluator_start gives a sweep its text and refuses a second running sweep of the kind", () => {
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
});

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
