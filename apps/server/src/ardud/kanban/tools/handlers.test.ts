import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  KanbanCardId,
  KanbanDiscussionId,
  KanbanError,
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
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
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
) => {
  const running = new Set<string>();
  const parents = new Map<ThreadId, ThreadId>();
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
      findLastFailure: () => Effect.succeed(null),
      latestRun: () => Effect.succeed(null),
      compactRun: () => Effect.succeed(null),
      launch: (input) => {
        const launch = Effect.sync(() => {
          launches.push(input.text);
          return ThreadId.make(`thread-${++launched}`);
        });
        return launchGate
          ? Deferred.succeed(launchGate.held, undefined).pipe(
              Effect.andThen(Deferred.await(launchGate.release)),
              Effect.andThen(launch),
            )
          : launch;
      },
      send: () => Effect.void,
      model: () => Effect.succeed(null),
      setModel: () => Effect.void,
      interrupt: () => Effect.void,
    }),
  );
  const boardFilesLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-kanban-tools-test-",
  }).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(ServerSettings.layerTest()));
  const serviceLayer =
    editCardError || postToCardError
      ? Layer.effect(
          KanbanService.KanbanService,
          Effect.map(KanbanService.KanbanService, (service) =>
            KanbanService.KanbanService.of({
              ...service,
              editCard: (...args) =>
                editCardError ? Effect.fail(editCardError) : service.editCard(...args),
              postToCard: (...args) =>
                postToCardError ? Effect.fail(postToCardError) : service.postToCard(...args),
            }),
          ),
        ).pipe(Layer.provide(KanbanService.layer))
      : KanbanService.layer;
  const layer = McpHttpServer.toolkitRegistration(KanbanToolkit, KanbanHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) => {
          const parentThreadId = parents.get(threadId) ?? null;
          const shell = liveThreadShell(threadId);
          return Effect.succeed({
            ...shell,
            lineage: {
              ...shell.lineage,
              parentThreadId,
              relationshipToParent: parentThreadId === null ? null : "subagent",
            },
          });
        },
      }),
    ),
    Layer.provideMerge(serviceLayer),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(threads),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(dbPath ? Sqlite.layerFromPath(dbPath) : Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(boardFilesLayer),
  );
  return { running, launches, parents, views, layer };
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

it.effect("compound board tools time out before making any first write", () =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { layer } = fakeThreads(undefined, undefined, undefined, { held, release });
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "held",
        name: "Held",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      yield* kanban.createCard(board.id, { title: "A", prompt: "A", description: "A" }, owner);
      const holder = yield* Effect.forkChild(kanban.dispatchNow);
      yield* Deferred.await(held);
      const evaluator = ThreadId.make("thread-evaluator");
      const create = yield* Effect.forkChild(
        call(evaluator, "discussion_create", {
          title: "Queued discussion",
          text: "First message",
        }),
      );
      const open = yield* Effect.forkChild(
        call(evaluator, "board_open", { slug: "queued", name: "Queued", icon: "rocket" }),
      );
      yield* TestClock.adjust(KanbanService.BOARD_WRITE_START_DEADLINE_MS + 1);
      for (const result of [yield* Fiber.join(create), yield* Fiber.join(open)]) {
        assert.isTrue(result.isError, result.text);
        assert.include(result.text, "Board busy: not written. Safe to retry once.");
      }
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
      assert.strictEqual((created.structured.discussion as { lastSeq: number }).lastSeq, 1);
      const opened = yield* call(evaluator, "board_open", {
        slug: "queued",
        name: "Queued",
        icon: "rocket",
      });
      assert.isFalse(opened.isError, opened.text);
      assert.strictEqual((opened.structured.board as { icon: string }).icon, "rocket");
    }).pipe(Effect.provide(layer));
  }),
);

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
      { id: "fastMode", value: true },
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

    const weighted = yield* call(evaluator, "card_edit", {
      card: card.id,
      models: [
        { ...opus, weight: 2 },
        { ...haiku, weight: 1 },
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
