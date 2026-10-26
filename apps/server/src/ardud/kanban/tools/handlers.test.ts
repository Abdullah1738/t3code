import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type KanbanActor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../../../mcp/McpToolAccess.testkit.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as KanbanService from "../engine/KanbanService.ts";
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
    providerInstanceId: ProviderInstanceId.make("opencode"),
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
const running = new Set<string>();
let launched = 0;
const threads = Layer.succeed(
  KanbanThreads,
  KanbanThreads.of({
    view: (threadId) =>
      Effect.succeed({
        threadId,
        projectId: ProjectId.make("project-1"),
        title: "thread",
        state: running.has(threadId) ? "running" : "idle",
        updatedAt: "2026-10-26T08:00:00.000Z",
        prs: [],
      }),
    launch: () => Effect.sync(() => ThreadId.make(`thread-${++launched}`)),
    send: () => Effect.void,
    interrupt: () => Effect.void,
  }),
);

const testLayer = McpHttpServer.toolkitRegistration(KanbanToolkit, KanbanHandlers.layer).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(liveThreadsLayer),
  Layer.provideMerge(KanbanService.layer),
  Layer.provideMerge(threads),
  Layer.provideMerge(KanbanStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
  Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
);

const owner: KanbanActor = { _tag: "owner" };

it.effect("a work thread with nothing active defaults to the cards still its own", () =>
  Effect.gen(function* () {
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
  }).pipe(Effect.provide(testLayer)),
);
