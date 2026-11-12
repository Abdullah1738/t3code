/** The ask tools as an agent calls them over MCP: card_ask, card_ask_change, card_ask_answer, discussion_post with ask. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CARD_ASK_TOOL_DESCRIPTION,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  kanbanAskChanges,
  kanbanAskWaitsOn,
  type KanbanActor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import { answerAskSecrets } from "../askSecrets.ts";
import * as KanbanService from "../engine/KanbanService.ts";
import * as KanbanModels from "../engine/models.ts";
import { opencodeTestProvider } from "../engine/testProviders.ts";
import { KanbanThreads } from "../engine/threads.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import * as KanbanHandlers from "./handlers.ts";
import { KanbanToolkit } from "./tools.ts";

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
      structured: (result.structuredContent ?? {}) as Record<string, any>,
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, threadCaller(threadId)),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const testLayer = () => {
  let launched = 0;
  const threads = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      view: (threadId) =>
        Effect.succeed({
          threadId,
          projectId: ProjectId.make("project-1"),
          title: "thread",
          state: "idle",
          updatedAt: "2026-11-10T08:00:00.000Z",
          quietSince: "2026-11-10T08:00:00.000Z",
          runStartedAt: null,
          backgroundWork: 0,
          prWatches: 0,
          prs: [],
          archived: false,
        }),
      find: () => Effect.succeed(null),
      lastFailure: () => Effect.succeed(null),
      findLastFailure: () => Effect.succeed(null),
      latestRun: () => Effect.succeed(null),
      compactRun: () => Effect.succeed(null),
      launch: () => Effect.sync(() => ThreadId.make(`thread-${++launched}`)),
      send: () => Effect.void,
      model: () => Effect.succeed(null),
      setModel: () => Effect.void,
      cancelQueued: () => Effect.succeed(false),
      interrupt: () => Effect.void,
    }),
  );
  return McpHttpServer.toolkitRegistration(KanbanToolkit, KanbanHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
      }),
    ),
    Layer.provideMerge(KanbanService.layer),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(threads),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-kanban-ask-tools-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ServerSettings.layerTest()),
      ),
    ),
  );
};

const owner: KanbanActor = { _tag: "owner" };
// A thread the board did not start acts as an evaluator.
const evaluator = ThreadId.make("thread-evaluator");

const setup = Effect.gen(function* () {
  const kanban = yield* KanbanService.KanbanService;
  const board = yield* kanban.ensureBoard({
    slug: "asks",
    name: "Asks",
    defaultProjectId: ProjectId.make("project-1"),
  });
  yield* kanban.setPool(board.id, board.defaultCardModel, 1);
  const card = yield* kanban.createCard(
    board.id,
    { prompt: "Long prompt text", title: "A" },
    owner,
  );
  return { kanban, board, card };
});

it.effect("card_ask takes a template with blocks and answers with a small summary", () =>
  Effect.gen(function* () {
    const { kanban, card } = yield* setup;
    const asked = yield* call(evaluator, "card_ask", {
      card: card.id,
      question: "Replace the tool description?",
      title: "card_get description",
      context: "The old one never says it returns history.",
      change: {
        label: "card_get description",
        before: "One card.",
        after: "One card with its history.",
      },
      batchKey: "tool-texts",
      blocks: [
        { _tag: "md", text: "Before and after, side by side" },
        {
          _tag: "html",
          html: "<table><tr><td>old</td><td>new</td></tr></table>",
          title: "Diff",
          height: 200,
        },
        { _tag: "image", url: "https://example.com/diff.png", alt: "The diff as a picture" },
      ],
    });
    assert.isFalse(asked.isError, asked.text);
    assert.deepStrictEqual(asked.structured, {
      card: {
        card: 1,
        stage: "todo",
        ask: { id: "q1", kind: "change", revision: 0, blocking: false, open: true, blocks: 3 },
      },
    });
    assert.notInclude(asked.text, "Long prompt text");
    const ask = (yield* kanban.card(card.id)).card.asks[0]!;
    assert.deepStrictEqual(kanbanAskChanges(ask), [
      {
        label: "card_get description",
        before: "One card.",
        after: "One card with its history.",
        format: "markdown",
      },
    ]);
    assert.strictEqual(ask.batchKey, "tool-texts");
    assert.strictEqual(ask.blocks?.length, 3);

    // The old call shape still works: plain option labels make a pick.
    const plain = yield* call(evaluator, "card_ask", {
      card: card.id,
      question: "Ship tonight?",
      options: ["Yes", { label: "No", detail: "Ships Monday", recommended: true }],
    });
    assert.isFalse(plain.isError, plain.text);
    assert.strictEqual(plain.structured.card.ask.kind, "decision");

    const mixed = yield* call(evaluator, "card_ask", {
      card: card.id,
      question: "Both?",
      draft: { text: "Hi" },
      action: { summary: "Send" },
    });
    assert.isTrue(mixed.isError);
    assert.include(mixed.text, "one thing per ask");
    const pick = yield* call(evaluator, "card_ask", {
      card: card.id,
      question: "Pick?",
      blocks: [
        { _tag: "choice", id: "c", style: "pick", question: "?", options: [], multi: false },
      ],
    });
    assert.isTrue(pick.isError);
    assert.include(pick.text, "put the answers in options");
    assert.strictEqual((yield* kanban.card(card.id)).card.asks.length, 2);
  }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "card_ask_change edits an open ask, and its action is an operation or an action body",
  () =>
    Effect.gen(function* () {
      const { kanban, card } = yield* setup;
      yield* call(evaluator, "card_ask", {
        card: card.id,
        question: "Deploy?",
        action: { summary: "Deploy build 41", command: "make deploy" },
      });
      const edited = yield* call(evaluator, "card_ask_change", {
        card: card.id,
        ask: "q1",
        action: { summary: "Deploy build 42", command: "make deploy", undo: "make rollback" },
        basis: "build 42",
        revisionNote: "Newer build",
      });
      assert.isFalse(edited.isError, edited.text);
      assert.deepStrictEqual(edited.structured.card.ask, {
        id: "q1",
        kind: "action",
        revision: 1,
        blocking: false,
        open: true,
        blocks: 0,
      });
      const ask = (yield* kanban.card(card.id)).card.asks[0]!;
      assert.strictEqual(ask.action?.summary, "Deploy build 42");
      assert.strictEqual(ask.revisionNote, "Newer build");

      const nothing = yield* call(evaluator, "card_ask_change", { card: card.id, ask: "q1" });
      assert.isTrue(nothing.isError);
      assert.include(nothing.text, "Pass the fields to change, or an action.");
      const async = yield* call(evaluator, "card_ask_change", {
        card: card.id,
        ask: "q1",
        blocking: false,
      });
      assert.isTrue(async.isError);
      assert.include(async.text, "can't be made async");

      // Edit and block in one call, then the old operations.
      const blocked = yield* call(evaluator, "card_ask_change", {
        card: card.id,
        ask: "q1",
        title: "Deploy go",
        blocking: true,
      });
      assert.isFalse(blocked.isError, blocked.text);
      assert.deepStrictEqual(
        [
          blocked.structured.card.stage,
          blocked.structured.card.ask.blocking,
          blocked.structured.card.ask.revision,
        ],
        ["needs_owner", true, 2],
      );
      const dropped = yield* call(evaluator, "card_ask_change", {
        card: card.id,
        ask: "q1",
        action: "drop",
      });
      assert.isFalse(dropped.isError, dropped.text);
      assert.isFalse(dropped.structured.card.ask.open);
      assert.strictEqual((yield* kanban.card(card.id)).card.asks[0]!.answer?.verdict, "dropped");

      yield* call(evaluator, "card_ask", { card: card.id, question: "Later?" });
      const operation = yield* call(evaluator, "card_ask_change", {
        card: card.id,
        ask: "q2",
        action: "block",
      });
      assert.isFalse(operation.isError, operation.text);
      assert.isTrue(operation.structured.card.ask.blocking);
    }).pipe(Effect.provide(testLayer())),
);

it.effect("discussion_post with ask replies on the ask without closing it", () =>
  Effect.gen(function* () {
    const { kanban, card } = yield* setup;
    yield* call(evaluator, "card_ask", { card: card.id, question: "Which fee?", blocking: true });
    yield* kanban.replyOnAsk(card.id, "q1", owner, [{ _tag: "md", text: "Fee on what?" }], "owner");
    assert.strictEqual(kanbanAskWaitsOn((yield* kanban.card(card.id)).card.asks[0]!), "agent");

    const posted = yield* call(evaluator, "discussion_post", {
      card: card.id,
      ask: "q1",
      text: "On withdrawals.",
      blocks: [{ _tag: "html", html: "<p>fee table</p>", title: "Fees", height: null }],
    });
    assert.isFalse(posted.isError, posted.text);
    assert.strictEqual(posted.structured.message.askId, "q1");
    assert.deepStrictEqual(
      posted.structured.message.blocks.map((block: { _tag: string }) => block._tag),
      ["md", "html"],
    );
    const after = (yield* kanban.card(card.id)).card;
    assert.isNull(after.asks[0]!.closedAt);
    assert.strictEqual(kanbanAskWaitsOn(after.asks[0]!), "owner");
    assert.strictEqual(after.stage, "needs_owner");

    // A reply on an ask is held to the ask's sizes: a page over 256 KB, or too many blocks.
    const page = yield* call(evaluator, "discussion_post", {
      card: card.id,
      ask: "q1",
      blocks: [{ _tag: "html", html: "x".repeat(256 * 1024 + 1), title: "Big", height: null }],
    });
    assert.isTrue(page.isError);
    assert.include(page.text, "an html block on a reply on an ask is at most 256 KB");
    const many = yield* call(evaluator, "discussion_post", {
      card: card.id,
      ask: "q1",
      blocks: Array.from({ length: 13 }, (_, index) => ({ _tag: "md", text: `Line ${index}` })),
    });
    assert.isTrue(many.isError);
    assert.include(many.text, "a reply on an ask takes at most 12 blocks (got 13)");
    assert.strictEqual(kanbanAskWaitsOn((yield* kanban.card(card.id)).card.asks[0]!), "owner");

    const missing = yield* call(evaluator, "discussion_post", {
      card: card.id,
      ask: "q7",
      text: "Hi",
    });
    assert.isTrue(missing.isError);
    assert.include(missing.text, "open ask q7");
  }).pipe(Effect.provide(testLayer())),
);

it.effect("card_ask_answer is for evaluators and for asks the owner handed over", () =>
  Effect.gen(function* () {
    const { kanban, card } = yield* setup;
    yield* kanban.dispatchNow;
    const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
    const asked = yield* call(worker, "card_ask", {
      question: "Post it?",
      draft: { text: "Hello.", target: "PR #9" },
    });
    assert.isFalse(asked.isError, asked.text);

    const fromWorker = yield* call(worker, "card_ask_answer", { ask: "q1", verdict: "approved" });
    assert.isTrue(fromWorker.isError);
    assert.include(fromWorker.text, "Only evaluators use this tool");
    const notHanded = yield* call(evaluator, "card_ask_answer", {
      card: card.id,
      ask: "q1",
      verdict: "approved",
    });
    assert.isTrue(notHanded.isError);
    assert.include(notHanded.text, "was not handed to the evaluator");

    yield* kanban.handAsk(card.id, "q1", "hand", owner);
    // Handed, it is with this board's evaluators. A thread the board did not start is not
    // one, whoever started it: it can neither decide the ask nor give it back.
    const outsider = yield* call(evaluator, "card_ask_answer", {
      card: card.id,
      ask: "q1",
      verdict: "approved",
    });
    assert.isTrue(outsider.isError);
    assert.include(outsider.text, "is with the evaluators of its own board");
    const outsiderReturn = yield* call(evaluator, "card_ask_change", {
      card: card.id,
      ask: "q1",
      action: "return",
    });
    assert.isTrue(outsiderReturn.isError);
    assert.include(outsiderReturn.text, "is with the evaluators of its own board");
    assert.isNull((yield* kanban.card(card.id)).card.asks[0]!.closedAt);

    const boardEvaluator = (yield* kanban.cardDiscussion(card.id)).evaluatorThreadId!;
    const returned = yield* call(boardEvaluator, "card_ask_change", {
      card: card.id,
      ask: "q1",
      action: "return",
    });
    assert.isFalse(returned.isError, returned.text);
    assert.isUndefined(returned.structured.card.ask.handed);
    const workerReturn = yield* call(worker, "card_ask_change", { ask: "q1", action: "return" });
    assert.isTrue(workerReturn.isError);

    yield* kanban.handAsk(card.id, "q1", "hand", owner);
    // An approval is answered for the revision that was read: without one it is refused
    // with the current revision, and one from before an edit is refused as stale.
    const blind = yield* call(boardEvaluator, "card_ask_answer", {
      card: card.id,
      ask: "q1",
      verdict: "approved",
    });
    assert.isTrue(blind.isError);
    assert.include(blind.text, "It is at revision 0");
    const stale = yield* call(boardEvaluator, "card_ask_answer", {
      card: card.id,
      ask: "q1",
      verdict: "approved",
      revision: 3,
    });
    assert.isTrue(stale.isError);
    assert.include(stale.text, "revision 0, you answered revision 3");
    assert.isNull((yield* kanban.card(card.id)).card.asks[0]!.closedAt);
    // Words alone decide nothing on an approval, from an evaluator as from the owner.
    const inWords = yield* call(boardEvaluator, "card_ask_answer", {
      card: card.id,
      ask: "q1",
      verdict: "answered",
      text: "Looks fine to me.",
      revision: 0,
    });
    assert.isTrue(inWords.isError);
    assert.include(
      inWords.text,
      "q1 on card #1 can't be answered in words alone: it takes approved or rejected.",
    );
    assert.isNull((yield* kanban.card(card.id)).card.asks[0]!.closedAt);
    const decided = yield* call(boardEvaluator, "card_ask_answer", {
      card: card.id,
      ask: "q1",
      verdict: "approved",
      finalDraft: "Hello, and thanks.",
      note: "Friendlier.",
      revision: 0,
    });
    assert.isFalse(decided.isError, decided.text);
    assert.isFalse(decided.structured.card.ask.open);
    const answer = (yield* kanban.card(card.id)).card.asks[0]!.answer!;
    assert.deepStrictEqual(
      [answer.verdict, answer.decision, answer.finalDraft, answer.draftEdited, answer.note],
      ["handed", "approved", "Hello, and thanks.", true, "Friendlier."],
    );
  }).pipe(Effect.provide(testLayer())),
);

it("the card_ask description says what he can give back, and stays short", () => {
  const description = KanbanToolkit.tools.card_ask.description ?? "";
  for (const word of [
    "approve or reject",
    "a pick",
    "values he fills in",
    "a file",
    "an edit of your draft",
    "a step he does himself",
    "seen",
    "Shortcuts",
    "One thing per ask",
    "notice",
    "respond",
    "blocks",
    "html",
    "alt text",
  ]) {
    assert.include(description, word);
  }
  assert.isBelow(description.length, 1_800);
  // The tool and any page that shows it read the same constant.
  assert.strictEqual(description, CARD_ASK_TOOL_DESCRIPTION);
  assert.include(CARD_ASK_TOOL_DESCRIPTION, "and then for what you do after it");
});

it.effect(
  "a secret field over the tools: asked with card_ask, and no tool reply ever shows the value",
  () =>
    Effect.gen(function* () {
      const { kanban, card } = yield* setup;
      const secrets = yield* SecretRequests.SecretRequests;
      const value = "ghp_T00L-reply-N3ver-shows-this";
      const replies: Array<string> = [];
      const tool = (name: string, args: Record<string, unknown>) =>
        call(evaluator, name, args).pipe(
          Effect.tap((result) =>
            Effect.sync(() => replies.push(`${result.text} ${JSON.stringify(result.structured)}`)),
          ),
        );

      const asked = yield* tool("card_ask", {
        card: card.id,
        question: "What is the GitHub token for the mirror job?",
        respond: {
          fields: [{ id: "token", label: "GitHub token", type: "secret", required: true }],
        },
      });
      assert.isFalse(asked.isError, asked.text);
      assert.strictEqual(asked.structured.card.ask.open, true);
      // A default would put a value on the card: refused, without repeating it.
      const withDefault = yield* tool("card_ask", {
        card: card.id,
        question: "And the other token?",
        respond: { fields: [{ label: "Token", type: "secret", default: value }] },
      });
      assert.isTrue(withDefault.isError);
      assert.include(withDefault.text, "takes no default");
      // An evaluator can't give it for him, and he can't hand it over either.
      const hand = yield* kanban.handAsk(card.id, "q1", "hand", owner).pipe(Effect.flip);
      assert.include(hand.detail, "the evaluator can't answer it");
      const forHim = yield* tool("card_ask_answer", {
        card: card.id,
        ask: "q1",
        verdict: "answered",
        values: { token: value },
      });
      assert.isTrue(forHim.isError);
      assert.include(forHim.text, "only the owner answers it");

      yield* answerAskSecrets(kanban, secrets)(
        {
          cardId: card.id,
          askId: "q1",
          answer: { verdict: "answered", revision: 0 },
          secrets: { token: value },
        },
        { _tag: "owner-app", surface: "desktop", sessionId: "session-1" },
      );
      const got = yield* tool("card_get", { card: card.id });
      assert.isFalse(got.isError, got.text);
      yield* tool("card_search", { query: "token" });
      yield* tool("discussion_read", {
        discussion: (yield* kanban.card(card.id)).card.discussionId,
      });
      assert.isAbove(replies.length, 5);
      for (const reply of replies) assert.notInclude(reply, value);
      assert.deepStrictEqual((yield* kanban.card(card.id)).card.asks[0]!.answer?.values, {
        token: { secret: true },
      });
    }).pipe(
      Effect.provide(
        SecretRequests.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(testLayer()),
        ),
      ),
    ),
);

it.effect("what a thread does through the board tools is its own, never the owner's", () =>
  Effect.gen(function* () {
    const { kanban, board, card } = yield* setup;
    yield* kanban.dispatchNow;
    const worker = (yield* kanban.card(card.id)).card.activeThreadId!;

    // The card's worker posts in its discussion: the message is the thread's.
    const posted = yield* call(worker, "discussion_post", { card: card.id, text: "Half done." });
    assert.isFalse(posted.isError, posted.text);
    assert.deepStrictEqual(posted.structured.message.author, { _tag: "thread", threadId: worker });

    // An evaluator files a card and opens a discussion: both are the evaluator's.
    const filed = yield* call(evaluator, "card_create", {
      board: board.id,
      title: "Follow-up",
      prompt: "Do the follow-up.",
    });
    assert.isFalse(filed.isError, filed.text);
    const cards = (yield* kanban.snapshot(board.id)).cards;
    assert.deepStrictEqual(cards.find((entry) => entry.title === "Follow-up")?.createdBy, {
      _tag: "evaluator",
      threadId: evaluator,
    });
    const opened = yield* call(evaluator, "discussion_create", {
      board: board.id,
      title: "Rollout plan",
      text: "Here is the plan.",
    });
    assert.isFalse(opened.isError, opened.text);
    const discussion = (yield* kanban.discussions(board.id)).find(
      (entry) => entry.title === "Rollout plan",
    )!;
    assert.deepStrictEqual(discussion.createdBy, { _tag: "evaluator", threadId: evaluator });

    // An approval the worker asks for is not approved by an agent saying so in the discussion.
    yield* call(worker, "card_ask", {
      card: card.id,
      question: "Deploy tonight?",
      blocking: true,
      action: { summary: "Deploy build 42" },
    });
    const said = yield* call(evaluator, "discussion_post", { card: card.id, text: "Approved." });
    assert.isFalse(said.isError, said.text);
    assert.strictEqual(said.structured.message.author._tag, "evaluator");
    const ask = (yield* kanban.card(card.id)).card.asks[0]!;
    assert.isNull(ask.closedAt);
    assert.isUndefined(ask.answer);
    // Nothing in any of it was written as the owner.
    const messages = yield* kanban.messages((yield* kanban.cardDiscussion(card.id)).id, {});
    assert.notInclude(
      messages.map((message) => message.author._tag),
      "owner",
    );
  }).pipe(Effect.provide(testLayer())),
);

it.effect("an action says what happens after it, and an old client reads it in the message", () =>
  Effect.gen(function* () {
    const { kanban, card } = yield* setup;
    const asked = yield* call(evaluator, "card_ask", {
      card: card.id,
      question: "Run the migration?",
      action: {
        summary: "Run migration 42 on staging",
        undo: "Run the down migration",
        then: "Post the before and after on the Linear ticket",
      },
    });
    assert.isFalse(asked.isError, asked.text);
    const stored = (yield* kanban.card(card.id)).card.asks[0]!;
    assert.strictEqual(stored.action?.then, "Post the before and after on the Linear ticket");
    const discussion = yield* kanban.cardDiscussion(card.id);
    const posted = yield* kanban.message(discussion.id, stored.seq!);
    const text = posted.blocks.flatMap((block) => (block._tag === "md" ? [block.text] : []));
    assert.include(
      text.join("\n"),
      "- Undo: Run the down migration\n- Then: Post the before and after on the Linear ticket",
    );

    // card_ask_change replaces it with the rest of the action, and it is held to its size.
    const changed = yield* call(evaluator, "card_ask_change", {
      card: card.id,
      ask: "q1",
      action: { summary: "Run migration 42 on staging", then: "Tell the on-call it is done" },
      revisionNote: "Different follow-up",
    });
    assert.isFalse(changed.isError, changed.text);
    const after = (yield* kanban.card(card.id)).card.asks[0]!;
    assert.deepStrictEqual(after.action, {
      summary: "Run migration 42 on staging",
      then: "Tell the on-call it is done",
    });
    const long = yield* call(evaluator, "card_ask_change", {
      card: card.id,
      ask: "q1",
      action: { summary: "Run migration 42 on staging", then: "x".repeat(2_001) },
    });
    assert.isTrue(long.isError);
    assert.include(long.text, "action then");
    // An ask without it reads as before.
    const plain = yield* call(evaluator, "card_ask", {
      card: card.id,
      question: "Restart the worker?",
      action: { summary: "Restart the worker" },
    });
    assert.isFalse(plain.isError, plain.text);
    const second = (yield* kanban.card(card.id)).card.asks[1]!;
    assert.notProperty(second.action!, "then");
  }).pipe(Effect.provide(testLayer())),
);
