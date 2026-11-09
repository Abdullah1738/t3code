import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import * as ReplyBuilders from "../../http/ReplyBuilders.ts";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { vi } from "vite-plus/test";

import {
  AuthOrchestrationOperateScope,
  clientRpcRequiredScopes,
  KANBAN_WS_METHODS,
  KanbanBoard,
  KanbanDiscussionId,
  KanbanCardId,
  KanbanBlock,
  KanbanBlockInput,
  KanbanScriptId,
  KANBAN_WS_METHODS as M,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type KanbanActor,
  type KanbanError,
  type KanbanScript,
  type ModelSelection,
  type OrchestrationV2ProviderFailure,
  type ServerProvider,
} from "@t3tools/contracts";

import * as ServerConfig from "../../../config.ts";
import { RPC_REQUIRED_SCOPES } from "../../../auth/RpcAuthorization.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import { makeKanbanWsHandlers } from "../ws.ts";
import * as KanbanModels from "./models.ts";
import {
  DEFAULT_CARD_MODEL,
  DEFAULT_EVALUATOR_MODEL,
  DEFAULT_MANAGER_MODEL,
  modelSelectionOf,
} from "./defaults.ts";
import * as Rules from "./rules.ts";
import * as KanbanService from "./KanbanService.ts";
import type { KanbanScriptsShape } from "./ScriptService.ts";
import { opencodeTestProvider } from "./testProviders.ts";
import {
  KanbanThreadError,
  KanbanThreads,
  type KanbanThreadPr,
  type KanbanThreadView,
} from "./threads.ts";

interface FakeThread {
  readonly title: string;
  readonly model: ModelSelection;
  readonly messages: Array<string>;
  running: boolean;
  runStartedAt?: string;
  stuck?: boolean;
  quietSince?: string;
  background?: number;
  archived: boolean;
}

const makeFake = Effect.gen(function* () {
  const threads = yield* Ref.make(new Map<string, FakeThread>());
  const interrupted: Array<string> = [];
  const prs = new Map<string, ReadonlyArray<KanbanThreadPr>>();
  const failures = new Map<
    string,
    OrchestrationV2ProviderFailure & { readonly model?: ModelSelection | null }
  >();
  const failureReads: Array<string> = [];
  const missingFailureRunIds = new Set<string>();
  const lastRuns = new Map<string, { runId: string; status: string; message: string | null }>();
  const runHistory = new Map<string, { status: string; message: string | null }>();
  // One run id per stored failure object (the same run reports the same id).
  const runIds = new WeakMap<object, string>();
  let nextRun = 0;
  const failureOf = (threadId: string) => {
    const failure = failures.get(threadId);
    if (!failure) return null;
    if (!runIds.has(failure)) runIds.set(failure, `run-${(nextRun += 1)}`);
    return { ...failure, runId: missingFailureRunIds.has(threadId) ? null : runIds.get(failure)! };
  };
  const sends: Array<{
    threadId: string;
    model: ModelSelection | undefined;
    key: string | undefined;
  }> = [];
  const modelSwitches: Array<{ threadId: string; model: ModelSelection }> = [];
  // Threads whose sends are refused, to test a wake that doesn't land.
  const rejectSends = new Set<string>();
  const runOnSend = new Set<string>();
  const commitThenReject = new Set<string>();
  const conclusiveReject = new Set<string>();
  const acceptedKeys = new Set<string>();
  // The next this-many thread reads fail, like a projection read error.
  const failReads = { left: 0 };
  const failFailureReads = { left: 0 };
  const findCalls: Array<ThreadId> = [];
  const findControl: {
    beforeRead?: (threadId: ThreadId, attempt: number) => Effect.Effect<void, KanbanThreadError>;
  } = {};
  const failureControl: {
    beforeRead?: (threadId: ThreadId, attempt: number) => Effect.Effect<void, KanbanThreadError>;
  } = {};
  const sendControl: { afterSend?: (threadId: ThreadId, text: string) => void } = {};
  let next = 0;
  // Like production, updatedAt always moves with the clock (shared provider-session bumps).
  const read = (threadId: ThreadId) =>
    Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
      Ref.get(threads).pipe(
        Effect.map((all): KanbanThreadView | null => {
          const thread = all.get(threadId);
          if (!thread) return null;
          return {
            threadId,
            projectId: ProjectId.make("project-1"),
            title: thread.title,
            state: thread.stuck ? "needs-input" : thread.running ? "running" : "idle",
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
            quietSince: thread.quietSince ?? "2026-10-25T13:00:00.000Z",
            runStartedAt: thread.runStartedAt ?? null,
            backgroundWork: thread.background ?? 0,
            prs: prs.get(threadId) ?? [],
            archived: thread.archived,
          };
        }),
      ),
    );
  const find = (threadId: ThreadId): Effect.Effect<KanbanThreadView | null, KanbanThreadError> =>
    Effect.suspend(() => {
      findCalls.push(threadId);
      const attempt = findCalls.filter((id) => id === threadId).length;
      return (findControl.beforeRead?.(threadId, attempt) ?? Effect.void).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (failReads.left === 0) return read(threadId);
            failReads.left -= 1;
            return Effect.fail(new KanbanThreadError({ operation: "view", detail: "read failed" }));
          }),
        ),
      );
    });
  const layer = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      model: (threadId) =>
        Effect.sync(() => {
          const switched = modelSwitches.filter((s) => s.threadId === threadId).at(-1);
          if (switched) return switched.model;
          return null;
        }),
      // Like production, view answers null when the read fails.
      view: (threadId) => find(threadId).pipe(Effect.catchCause(() => Effect.succeed(null))),
      find,
      launch: (input) =>
        Ref.modify(threads, (all) => {
          next += 1;
          const threadId = ThreadId.make(`thread-${next}`);
          const copy = new Map(all);
          copy.set(threadId, {
            title: input.title,
            model: input.model,
            messages: [input.text],
            running: false,
            archived: false,
          });
          return [threadId, copy] as const;
        }),
      // Like production, an archived thread takes no messages.
      send: (input) =>
        Ref.get(threads).pipe(
          Effect.flatMap((all) => {
            const thread = all.get(input.threadId);
            if (thread?.archived) {
              return Effect.fail(
                new KanbanThreadError({ operation: "send", detail: "thread is archived" }),
              );
            }
            if (input.key && acceptedKeys.has(input.key)) {
              // An accepted key is idempotent: record the attempt, deliver nothing.
              sends.push({ threadId: input.threadId, model: input.model, key: input.key });
              return Effect.void;
            }
            if (conclusiveReject.delete(input.threadId)) {
              return Effect.fail(
                new KanbanThreadError({ operation: "send", detail: "rejected", rejected: true }),
              );
            }
            if (rejectSends.has(input.threadId)) {
              return Effect.fail(new KanbanThreadError({ operation: "send", detail: "refused" }));
            }
            if (thread) thread.messages.push(input.text);
            if (input.text === "/compact") {
              const run = {
                runId: `compact-${(nextRun += 1)}`,
                status: "completed",
                message: input.text,
              };
              lastRuns.set(input.threadId, run);
              runHistory.set(run.runId, run);
              sends.push({ threadId: input.threadId, model: input.model, key: input.key });
              return Effect.succeed(run.runId);
            } else if (thread?.running) {
              lastRuns.set(input.threadId, {
                runId: `wake-${(nextRun += 1)}`,
                status: "running",
                message: input.text,
              });
            }
            if (thread && runOnSend.has(input.threadId)) thread.running = true;
            sends.push({ threadId: input.threadId, model: input.model, key: input.key });
            if (input.key) acceptedKeys.add(input.key);
            if (commitThenReject.delete(input.threadId)) {
              return Effect.fail(
                new KanbanThreadError({ operation: "send", detail: "projection read failed" }),
              );
            }
            sendControl.afterSend?.(input.threadId, input.text);
            return Effect.void;
          }),
        ),
      setModel: (threadId, model) =>
        Effect.sync(() => void modelSwitches.push({ threadId, model })),
      // Each stored failure is one executed run; a repeat notification of it reports the same runId.
      lastFailure: (threadId) =>
        Effect.sync(() => {
          failureReads.push(threadId);
          return failureOf(threadId);
        }),
      findLastFailure: (threadId) =>
        Effect.suspend(() => {
          failureReads.push(threadId);
          const attempt = failureReads.filter((id) => id === threadId).length;
          return (failureControl.beforeRead?.(threadId, attempt) ?? Effect.void).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (failFailureReads.left === 0) return Effect.succeed(failureOf(threadId));
                failFailureReads.left -= 1;
                return Effect.fail(
                  new KanbanThreadError({ operation: "lastFailure", detail: "read failed" }),
                );
              }),
            ),
          );
        }),
      latestRun: (threadId) => Effect.succeed(lastRuns.get(threadId) ?? null),
      compactRun: (_threadId, runId) => Effect.succeed(runHistory.get(runId) ?? null),
      interrupt: (threadId) => Effect.sync(() => void interrupted.push(threadId)),
    }),
  );
  return {
    threads,
    layer,
    interrupted,
    prs,
    failures,
    failureReads,
    missingFailureRunIds,
    lastRuns,
    runHistory,
    sends,
    modelSwitches,
    rejectSends,
    runOnSend,
    commitThenReject,
    conclusiveReject,
    failReads,
    failFailureReads,
    findCalls,
    findControl,
    failureControl,
    sendControl,
  };
});

/** Board file storage (ServerConfig + FileSystem) that KanbanService now needs when built. */
const boardFilesLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-kanban-test-",
}).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(ServerSettings.layerTest()));

/** A composer list that a test can change between ticks. */
const listedLayer = (listed: Ref.Ref<KanbanModels.ListedModels | null>) =>
  Layer.succeed(
    KanbanModels.KanbanModels,
    KanbanModels.KanbanModels.of({ listed: Ref.get(listed) }),
  );

const testLayer = (
  fake: Layer.Layer<KanbanThreads>,
  models: Layer.Layer<KanbanModels.KanbanModels> = KanbanModels.layerTest(null),
  providers: ReadonlyArray<ServerProvider> = [opencodeTestProvider()],
) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(models),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer(providers)),
    Layer.provideMerge(boardFilesLayer),
  );

/** testLayer on a real file database, which has a reader connection. */
const fileTestLayer = (fake: Layer.Layer<KanbanThreads>, dbPath: string) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(boardFilesLayer),
  );

const observedStoreLayer = (observe: (discussionId: KanbanDiscussionId) => Effect.Effect<void>) =>
  Layer.effect(
    KanbanStore.KanbanStore,
    Effect.map(KanbanStore.KanbanStore, (real) =>
      KanbanStore.KanbanStore.of({
        ...real,
        putDiscussion: (discussion) =>
          real
            .putDiscussion(discussion)
            .pipe(
              Effect.tap(() =>
                discussion.participants.some(
                  (participant) =>
                    participant.actor._tag === "owner" &&
                    discussion.lastSeq > 0 &&
                    participant.lastReadSeq === discussion.lastSeq,
                )
                  ? observe(discussion.id)
                  : Effect.void,
              ),
            ),
      }),
    ),
  );

const observedTestLayer = (
  fake: Layer.Layer<KanbanThreads>,
  observe: (discussionId: KanbanDiscussionId) => Effect.Effect<void>,
) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(observedStoreLayer(observe).pipe(Layer.provide(KanbanStore.layer))),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(boardFilesLayer),
  );

const owner: KanbanActor = { _tag: "owner" };

it.effect("refuses corrupted board text before saving and preserves clean comments", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "text-guard",
        name: "Text guard",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Fix it", title: "Fix it", description: "Explicit" },
        owner,
      );
      const before = yield* kanban.card(created.id);
      const error = yield* kanban
        .editCard(created.id, { comment: "ok\u0000\u0000", description: "not saved" }, owner)
        .pipe(Effect.flip);
      assert.strictEqual(error.code, "invalid");
      assert.include(error.detail, "comment has a control character U+0000 at offset 2");
      const after = yield* kanban.card(created.id);
      assert.deepStrictEqual(after.events, before.events);
      assert.strictEqual(after.card.description, before.card.description);

      const comment = "§ tab\tline\nend";
      yield* kanban.editCard(created.id, { comment }, owner);
      const events = (yield* kanban.card(created.id)).events;
      assert.strictEqual(events.filter((event) => event.kind === "comment").at(-1)?.body, comment);

      const cardsBefore = yield* kanban.cards(board.id);
      const badPrompt = yield* kanban
        .createCard(board.id, { prompt: "bad\u0001", title: "Bad prompt" }, owner)
        .pipe(Effect.flip);
      assert.strictEqual(badPrompt.code, "invalid");
      assert.include(badPrompt.detail, "prompt has a control character U+0001 at offset 3");
      assert.deepStrictEqual(yield* kanban.cards(board.id), cardsBefore);

      const discussion = yield* kanban.createDiscussion(board.id, "Discussion", owner);
      const messages = yield* kanban.messages(discussion.id);
      const badPost = yield* kanban
        .post(discussion.id, owner, [{ _tag: "md", text: "bad\u0000" }])
        .pipe(Effect.flip);
      assert.strictEqual(badPost.code, "invalid");
      assert.include(badPost.detail, "message has a control character U+0000 at offset 3");
      assert.deepStrictEqual(yield* kanban.messages(discussion.id), messages);
      assert.strictEqual((yield* kanban.discussion(discussion.id)).lastSeq, discussion.lastSeq);
      const blocks: ReadonlyArray<KanbanBlock> = [
        { _tag: "collapse", title: "ok", text: "bad\u0002" },
        { _tag: "collapse", title: "bad\u0002", text: "ok" },
        { _tag: "html", title: null, html: "bad\u0002", height: null },
        { _tag: "html", title: "bad\u0002", html: "ok", height: null },
        {
          _tag: "choice",
          id: "id",
          style: "pick",
          question: "bad\u0002",
          options: [],
          multi: false,
        },
        {
          _tag: "choice",
          id: "id",
          style: "pick",
          question: "ok",
          options: [{ id: "id", label: "bad\u0002" }],
          multi: false,
        },
        { _tag: "image", url: "https://example.com/image", alt: "bad\u0002" },
      ];
      for (const block of blocks) {
        const rejected = yield* kanban.post(discussion.id, owner, [block]).pipe(Effect.flip);
        assert.strictEqual(rejected.code, "invalid");
        assert.include(rejected.detail, "message has a control character U+0002 at offset 3");
      }
      assert.deepStrictEqual(yield* kanban.messages(discussion.id), messages);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the shared HTTP and WS block input preserves controls for service validation", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "raw-blocks",
        name: "Raw blocks",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const discussion = yield* kanban.createDiscussion(board.id, "Test", owner);
      const decode = Schema.decodeUnknownEffect(KanbanBlockInput);
      const existingDecode = Schema.decodeUnknownEffect(KanbanBlock);
      const legacy = yield* existingDecode({
        _tag: "collapse",
        title: "\u000bOld\u000c",
        text: "text",
      });
      assert.strictEqual(legacy._tag === "collapse" ? legacy.title : null, "Old");
      const blocks = yield* Effect.all([
        decode({ _tag: "collapse", title: "\u000bReport\u000c", text: "text" }),
        decode({
          _tag: "choice",
          id: "x",
          style: "pick",
          question: "\u000bQuestion",
          options: [],
          multi: false,
        }),
        decode({
          _tag: "choice",
          id: "x",
          style: "pick",
          question: "Question",
          options: [{ id: "a", label: "\u000bLabel" }],
          multi: false,
        }),
      ]);
      const ws = makeKanbanWsHandlers(kanban, {} as KanbanScriptsShape);
      for (const block of blocks) {
        const error = yield* ws[M.messagePost]({
          discussionId: discussion.id,
          blocks: [block],
        }).pipe(Effect.flip);
        assert.strictEqual(error.code, "invalid");
        assert.include(error.detail, "message has a control character U+000B at offset 0");
      }
      assert.deepStrictEqual(yield* kanban.messages(discussion.id), []);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.live("saves a 20,000-character description on a 1,700-card board", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const board = yield* kanban.ensureBoard({
        slug: "large-write",
        name: "Large write",
        defaultProjectId: null,
      });
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "Test", title: "Test", description: "Original" },
        owner,
      );
      yield* sql.withTransaction(
        Effect.forEach(
          Array.from({ length: 1699 }, (_, i) => i + 2),
          (number) =>
            store.putCard({ ...card, id: KanbanCardId.make(`card-seed-${number}`), number }),
          { discard: true },
        ),
      );
      assert.strictEqual((yield* store.cards(board.id)).length, 1700);
      const description = "x".repeat(20_000);
      yield* kanban.editCard(card.id, { description }, owner);
      assert.strictEqual((yield* kanban.card(card.id)).card.description, description);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a stalled launch holds no board write lock and cannot overwrite a newer card", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const lockHeld = yield* Deferred.make<void>();
    const releaseLock = yield* Deferred.make<void>();
    const blockedThreads = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (threads) =>
        KanbanThreads.of({
          ...threads,
          launch: (input) =>
            Deferred.succeed(lockHeld, undefined).pipe(
              Effect.andThen(Deferred.await(releaseLock)),
              Effect.andThen(threads.launch(input)),
            ),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "A", description: "Original" },
        owner,
      );
      const dispatch = yield* Effect.forkChild(kanban.dispatchNow);
      yield* Deferred.await(lockHeld);
      yield* kanban.editCard(card.id, { description: "Newer description" }, owner);
      const other = yield* kanban.ensureBoard({
        slug: "other",
        name: "Other",
        defaultProjectId: null,
      });
      const otherCard = yield* kanban.createCard(
        other.id,
        { prompt: "Other", title: "Other", description: "Other" },
        owner,
      );
      yield* kanban.editCard(otherCard.id, { title: "Other edited" }, owner);
      assert.strictEqual((yield* kanban.card(otherCard.id)).card.title, "Other edited");
      assert.strictEqual((yield* kanban.card(card.id)).card.description, "Newer description");
      yield* Deferred.succeed(releaseLock, undefined);
      yield* Fiber.join(dispatch);
      const after = yield* kanban.card(card.id);
      assert.strictEqual(after.card.description, "Newer description");
      assert.strictEqual(after.card.stage, "todo");
      assert.isNull(after.card.activeThreadId);
      assert.strictEqual(fake.interrupted.length, 1);
    }).pipe(Effect.provide(testLayer(blockedThreads)));
  }),
);

/** Holds only the first launch until `release`, so a test can write the board meanwhile. */
const holdFirstLaunch = (fake: Effect.Success<typeof makeFake>) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let launches = 0;
    const layer = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (threads) =>
        KanbanThreads.of({
          ...threads,
          launch: (input) =>
            Effect.suspend(() =>
              (launches += 1) === 1
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(threads.launch(input)),
                  )
                : threads.launch(input),
            ),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    return { entered, release, layer };
  });

it.effect("writes to other cards during a launch neither abandon it nor stop the next start", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const { entered, release, layer } = yield* holdFirstLaunch(fake);
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const second = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
      const dispatch = yield* Effect.forkChild(kanban.dispatchNow);
      yield* Deferred.await(entered);
      // A busy board: other cards are created and commented on while the launch is out.
      const bystander = yield* kanban.createCard(board.id, { prompt: "C", title: "C" }, owner);
      yield* kanban.editCard(bystander.id, { comment: "busy" }, owner);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(dispatch);
      assert.deepStrictEqual(fake.interrupted, []);
      for (const id of [first.id, second.id]) {
        const after = (yield* kanban.card(id)).card;
        assert.strictEqual(after.stage, "working");
        assert.isNotNull(after.activeThreadId);
      }
    }).pipe(Effect.provide(testLayer(layer)));
  }),
);

it.effect("a start abandoned for its own card's edit still lets the rest of the plan start", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const { entered, release, layer } = yield* holdFirstLaunch(fake);
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const second = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
      const dispatch = yield* Effect.forkChild(kanban.dispatchNow);
      yield* Deferred.await(entered);
      yield* kanban.editCard(first.id, { description: "Changed during launch" }, owner);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(dispatch);
      // The stale start is undone exactly once; the next card still starts in the same pass.
      assert.strictEqual(fake.interrupted.length, 1);
      const a = (yield* kanban.card(first.id)).card;
      assert.strictEqual(a.stage, "todo");
      assert.isNull(a.activeThreadId);
      assert.strictEqual(a.description, "Changed during launch");
      const b = (yield* kanban.card(second.id)).card;
      assert.strictEqual(b.stage, "working");
      assert.isNotNull(b.activeThreadId);
    }).pipe(Effect.provide(testLayer(layer)));
  }),
);

it.effect("a planned start re-checks its card and skips one that moved on before it ran", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const { entered, release, layer } = yield* holdFirstLaunch(fake);
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const second = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
      const dispatch = yield* Effect.forkChild(kanban.dispatchNow);
      yield* Deferred.await(entered);
      // Planned from the earlier snapshot, but stalled before its turn came.
      yield* kanban.flagCard(second.id, "hold it", owner);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(dispatch);
      const b = (yield* kanban.card(second.id)).card;
      assert.strictEqual(b.stage, "todo");
      assert.isNull(b.activeThreadId);
      assert.isNull(b.workThreadId);
      assert.deepStrictEqual(fake.interrupted, []);
    }).pipe(Effect.provide(testLayer(layer)));
  }),
);

it.effect(
  "an evaluator launch waiting on another service permits board writes and rejects stale setup",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const delayed = Layer.effect(
        KanbanThreads,
        Effect.map(KanbanThreads, (threads) =>
          KanbanThreads.of({
            ...threads,
            launch: (input) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(threads.launch(input)),
              ),
          }),
        ),
      ).pipe(Layer.provide(fake.layer));
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const setup = yield* Effect.forkChild(
          kanban.startSetup(board.id, { evaluatorModel: board.evaluatorModel }).pipe(Effect.flip),
        );
        yield* Deferred.await(entered);
        yield* kanban.updateBoard(board.id, { name: "Renamed during setup launch" });
        const card = yield* kanban.createCard(
          board.id,
          { prompt: "A", title: "A", description: "A" },
          owner,
        );
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual((yield* Fiber.join(setup)).code, "conflict");
        assert.strictEqual((yield* kanban.card(card.id)).card.stage, "todo");
        const saved = (yield* kanban.snapshot(board.id)).board;
        assert.strictEqual(saved.name, "Renamed during setup launch");
        assert.isNull(saved.setup);
        assert.strictEqual(fake.interrupted.length, 1);
      }).pipe(Effect.provide(testLayer(delayed)));
    }),
);

it.effect("a thread repeating the same edit writes nothing", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00Z"));
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "repeat-edit",
        name: "Repeat",
        defaultProjectId: null,
      });
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const worker: KanbanActor = { _tag: "thread", threadId: ThreadId.make("edit-author") };
      const patch = { description: "  description X  " };
      const first = yield* kanban.editCard(card.id, patch, worker);
      const before = yield* kanban.card(card.id);
      yield* TestClock.adjust("5 minutes");
      const repeated = yield* kanban.editCard(card.id, patch, worker);
      const after = yield* kanban.card(card.id);
      assert.deepStrictEqual(repeated, first);
      assert.strictEqual(repeated.updatedAt, first.updatedAt);
      assert.deepStrictEqual(after.events, before.events);
      assert.lengthOf(
        after.events.filter((event) => event.kind === "edited"),
        1,
      );
      const link = { links: [{ url: " https://example.com/a ", label: "A" }] };
      yield* kanban.editCard(card.id, link, worker);
      const linked = yield* kanban.card(card.id);
      yield* kanban.editCard(card.id, link, worker);
      assert.deepStrictEqual((yield* kanban.card(card.id)).events, linked.events);
      const relabelled = yield* kanban.editCard(
        card.id,
        { links: [{ url: "https://example.com/a", label: "B" }] },
        worker,
      );
      assert.strictEqual(relabelled.links[0]?.label, "B");
      const renamed = yield* kanban.editCard(card.id, { title: "Other" }, worker);
      assert.strictEqual(renamed.title, "Other");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a transcript read waiting in turn-end handling does not block board edits", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "A", description: "Original" },
        owner,
      );
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
      fake.failureControl.beforeRead = () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
      const ending = yield* Effect.forkChild(kanban.turnEnded(threadId).pipe(Effect.exit));
      yield* Deferred.await(entered);
      yield* kanban.editCard(card.id, { description: "During transcript read" }, owner);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(ending);
      assert.strictEqual((yield* kanban.card(card.id)).card.description, "During transcript read");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a stalled send releases the card's board lock without losing an intervening edit", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const delayed = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (threads) =>
        KanbanThreads.of({
          ...threads,
          send: (input) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(threads.send(input)),
            ),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "A", description: "Original" },
        owner,
      );
      yield* kanban.dispatchNow;
      const steering = yield* Effect.forkChild(
        kanban.cardThread(card.id, "steer", "Continue", owner).pipe(Effect.flip),
      );
      yield* Deferred.await(entered);
      yield* kanban.editCard(card.id, { description: "During send" }, owner);
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual((yield* Fiber.join(steering)).code, "conflict");
      assert.strictEqual((yield* kanban.card(card.id)).card.description, "During send");
    }).pipe(Effect.provide(testLayer(delayed)));
  }),
);

it.effect("a thread's repeated comment within 10 minutes is saved once", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00Z"));
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "repeat-comment",
        name: "Repeat",
        defaultProjectId: null,
      });
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const author: KanbanActor = { _tag: "thread", threadId: ThreadId.make("comment-author") };
      const first = yield* kanban.editCard(card.id, { comment: "  C  " }, author);
      const before = yield* kanban.card(card.id);
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* kanban.editCard(card.id, { comment: "C" }, author), first);
      assert.deepStrictEqual((yield* kanban.card(card.id)).events, before.events);
      yield* TestClock.adjust("11 minutes");
      yield* kanban.editCard(card.id, { comment: "C" }, author);
      const worker: KanbanActor = { _tag: "thread", threadId: ThreadId.make("different-author") };
      yield* kanban.editCard(card.id, { comment: "C" }, worker);
      yield* kanban.editCard(card.id, { comment: "D" }, worker);
      yield* kanban.editCard(card.id, { description: "intervening edit" }, worker);
      yield* kanban.editCard(card.id, { comment: "D" }, worker);
      let detail = yield* kanban.card(card.id);
      assert.deepStrictEqual(
        detail.events.filter((event) => event.kind === "comment").map((event) => event.body),
        ["C", "C", "C", "D", "D"],
      );

      const combined = { description: "combined", comment: "combined comment" };
      const saved = yield* kanban.editCard(card.id, combined, author);
      detail = yield* kanban.card(card.id);
      yield* TestClock.adjust("10 minutes");
      assert.deepStrictEqual(yield* kanban.editCard(card.id, combined, author), saved);
      assert.deepStrictEqual((yield* kanban.card(card.id)).events, detail.events);
      yield* TestClock.adjust(1);
      yield* kanban.editCard(card.id, combined, author);
      assert.lengthOf((yield* kanban.card(card.id)).events, detail.events.length + 2);

      // An empty patch remains an edit; it must not be classified as a retry.
      const beforeEmpty = yield* kanban.card(card.id);
      assert.isFalse(
        KanbanService.editRepeats(
          beforeEmpty.card,
          {},
          beforeEmpty.events,
          author,
          yield* Clock.currentTimeMillis,
        ),
      );
      yield* kanban.editCard(card.id, {}, author);
      assert.strictEqual(
        (yield* kanban.card(card.id)).card.updatedAt,
        yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("only thread and evaluator repeats skip card edits and comments", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00Z"));
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "retry-edit-actors",
        name: "Retry actors",
        defaultProjectId: null,
      });
      const cases: ReadonlyArray<{ actor: KanbanActor; writes: number }> = [
        { actor: owner, writes: 2 },
        { actor: { _tag: "script", scriptId: KanbanScriptId.make("script-test") }, writes: 2 },
        { actor: { _tag: "system", component: "test" }, writes: 2 },
        { actor: { _tag: "thread", threadId: ThreadId.make("worker-test") }, writes: 1 },
        { actor: { _tag: "evaluator", threadId: ThreadId.make("evaluator-test") }, writes: 1 },
      ];
      for (const { actor, writes } of cases) {
        const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
        const description = { description: "Description" };
        yield* kanban.editCard(card.id, description, actor);
        yield* TestClock.adjust("1 minute");
        yield* kanban.editCard(card.id, description, actor);
        const link = { links: [{ url: "https://example.com/a", label: "A" }] };
        yield* kanban.editCard(card.id, link, actor);
        yield* kanban.editCard(card.id, link, actor);
        yield* kanban.editCard(card.id, { comment: "Same comment" }, actor);
        yield* kanban.editCard(card.id, { comment: "Same comment" }, actor);
        const combined = { description: "Combined", comment: "Combined comment" };
        yield* kanban.editCard(card.id, combined, actor);
        yield* kanban.editCard(card.id, combined, actor);
        const events = (yield* kanban.card(card.id)).events;
        assert.strictEqual(events.filter((event) => event.kind === "edited").length, writes * 2);
        assert.strictEqual(events.filter((event) => event.kind === "linked").length, writes);
        assert.strictEqual(events.filter((event) => event.kind === "comment").length, writes * 2);
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("only thread and evaluator repeats skip discussion and card posts", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00Z"));
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "retry-post-actors",
        name: "Retry actors",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const cases: ReadonlyArray<{ actor: KanbanActor; writes: number }> = [
        { actor: owner, writes: 2 },
        { actor: { _tag: "script", scriptId: KanbanScriptId.make("script-test") }, writes: 2 },
        { actor: { _tag: "system", component: "test" }, writes: 2 },
        { actor: { _tag: "thread", threadId: ThreadId.make("worker-test") }, writes: 1 },
        { actor: { _tag: "evaluator", threadId: ThreadId.make("evaluator-test") }, writes: 1 },
      ];
      for (const { actor, writes } of cases) {
        const discussion = yield* kanban.createDiscussion(board.id, "Posts", owner);
        const blocks = [{ _tag: "md", text: "Same post" }] as const;
        const first = yield* kanban.post(discussion.id, actor, blocks);
        yield* TestClock.adjust("1 minute");
        const second = yield* kanban.post(discussion.id, actor, blocks);
        assert.strictEqual(second.seq, first.seq + writes - 1);
        assert.lengthOf(yield* kanban.messages(discussion.id), writes);

        const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
        const cardFirst = yield* kanban.postToCard(card.id, actor, blocks);
        const cardSecond = yield* kanban.postToCard(card.id, actor, blocks);
        assert.strictEqual(cardSecond.seq, cardFirst.seq + writes - 1);
        assert.lengthOf(yield* kanban.messages(cardFirst.discussionId), writes);
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("both repeated owner posts reach the card's work thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "repeat-owner-delivery",
        name: "Repeat owner delivery",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
      const before = (yield* Ref.get(fake.threads)).get(threadId)!.messages.length;
      const blocks = [{ _tag: "md", text: "Same instruction" }] as const;
      const first = yield* kanban.postToCard(card.id, owner, blocks);
      const second = yield* kanban.postToCard(card.id, owner, blocks);
      assert.strictEqual(second.seq, first.seq + 1);
      const delivered = (yield* Ref.get(fake.threads)).get(threadId)!.messages.slice(before);
      assert.lengthOf(delivered, 2);
      assert.isTrue(delivered.every((text) => text.includes("Same instruction")));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("owner repeats through the board websocket are saved twice", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const ws = makeKanbanWsHandlers(kanban, {} as KanbanScriptsShape);
      const board = yield* kanban.ensureBoard({
        slug: "owner-ws-repeat",
        name: "Owner WS repeat",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* ws[M.cardPatch]({ cardId: card.id, comment: "Same comment" });
      yield* ws[M.cardPatch]({ cardId: card.id, comment: "Same comment" });
      const comments = (yield* kanban.card(card.id)).events.filter(
        (event) => event.kind === "comment" && event.body === "Same comment",
      );
      assert.lengthOf(comments, 2);
      const discussion = yield* kanban.cardDiscussion(card.id);
      const post = {
        discussionId: discussion.id,
        blocks: [{ _tag: "md", text: "Same post" }],
      } as const;
      const first = yield* ws[M.messagePost](post);
      const second = yield* ws[M.messagePost](post);
      assert.strictEqual(second.seq, first.seq + 1);
      assert.lengthOf(yield* kanban.messages(discussion.id), 2);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("repeating the same post returns the first message", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00Z"));
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "repeat-post",
        name: "Repeat",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const discussion = yield* kanban.createDiscussion(board.id, "Posts", owner);
      const author: KanbanActor = { _tag: "thread", threadId: ThreadId.make("author-a") };
      const other: KanbanActor = { _tag: "thread", threadId: ThreadId.make("author-b") };
      const blocks = [{ _tag: "collapse", title: "  Details  ", text: "X" }] as const;
      const first = yield* kanban.post(discussion.id, author, blocks);
      const before = yield* kanban.discussion(discussion.id);
      yield* TestClock.adjust("1 minute");
      const alreadyNormalized = [{ _tag: "collapse", title: "Details", text: "X" }] as const;
      assert.deepStrictEqual(yield* kanban.post(discussion.id, author, alreadyNormalized), first);
      assert.deepStrictEqual(yield* kanban.discussion(discussion.id), before);
      assert.lengthOf(yield* kanban.messages(discussion.id), 1);
      assert.notStrictEqual((yield* kanban.post(discussion.id, other, blocks)).seq, first.seq);
      yield* kanban.post(discussion.id, other, [{ _tag: "md", text: "different" }]);
      yield* TestClock.adjust("11 minutes");
      yield* kanban.post(discussion.id, other, [{ _tag: "md", text: "different" }]);
      assert.lengthOf(yield* kanban.messages(discussion.id), 4);

      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const post = yield* kanban.postToCard(card.id, author, [{ _tag: "md", text: "One" }]);
      const again = yield* kanban.postToCard(card.id, author, [{ _tag: "md", text: "One" }]);
      assert.deepStrictEqual(again, post);
      assert.lengthOf(yield* kanban.messages(post.discussionId), 1);
      assert.lengthOf(
        (yield* kanban.discussions(board.id)).filter((entry) => entry.cardId === card.id),
        1,
      );

      // Skipping a retry must not re-route a worker's question to the evaluator.
      const questionBoard = yield* kanban.ensureBoard({
        slug: "retry-question",
        name: "Questions",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(questionBoard.id, questionBoard.defaultCardModel, 1);
      const questionCard = yield* kanban.createCard(
        questionBoard.id,
        { prompt: "Q", title: "Q" },
        owner,
      );
      yield* kanban.dispatchNow;
      const workerId = (yield* kanban.card(questionCard.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId: workerId };
      yield* kanban.postToCard(questionCard.id, worker, [{ _tag: "md", text: "What now?" }]);
      const discussionAfterQuestion = yield* kanban.cardDiscussion(questionCard.id);
      const evaluatorId = discussionAfterQuestion.evaluatorThreadId!;
      assert.isNotNull(evaluatorId);
      const beforeRetry = (yield* Ref.get(fake.threads)).get(evaluatorId)!.messages.length;
      yield* kanban.postToCard(questionCard.id, worker, [{ _tag: "md", text: "What now?" }]);
      assert.strictEqual(
        (yield* Ref.get(fake.threads)).get(evaluatorId)!.messages.length,
        beforeRetry,
      );

      // Two distinct asks must each have their own message and sequence, even with identical text.
      yield* kanban.askOwner(card.id, { question: "Same?", blocking: false }, owner, "owner");
      const twice = yield* kanban.askOwner(
        card.id,
        { question: "Same?", blocking: false },
        owner,
        "owner",
      );
      assert.notStrictEqual(twice.asks[0]?.seq, twice.asks[1]?.seq);
      const cardDiscussion = yield* kanban.cardDiscussion(card.id);
      const system: KanbanActor = { _tag: "system", component: "test" };
      const a = yield* kanban.post(cardDiscussion.id, system, [{ _tag: "md", text: "notice" }]);
      const b = yield* kanban.post(cardDiscussion.id, system, [{ _tag: "md", text: "notice" }]);
      assert.notStrictEqual(a.seq, b.seq);
      const image = [{ _tag: "image", url: "https://example.com/a.png", alt: null }] as const;
      const c = yield* kanban.post(cardDiscussion.id, owner, image);
      const d = yield* kanban.post(cardDiscussion.id, owner, image);
      assert.notStrictEqual(c.seq, d.seq);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a started write finishes after the start deadline", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let target: KanbanCardId | null = null;
    const gatedStore = Layer.effect(
      KanbanStore.KanbanStore,
      Effect.map(KanbanStore.KanbanStore, (store) =>
        KanbanStore.KanbanStore.of({
          ...store,
          putCard: (card) =>
            card.id === target && card.description === "Started"
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                  Effect.andThen(store.putCard(card)),
                )
              : store.putCard(card),
        }),
      ),
    ).pipe(Layer.provide(KanbanStore.layer));
    const layer = KanbanService.layer.pipe(
      Layer.provideMerge(fake.layer),
      Layer.provideMerge(KanbanModels.layerTest(null)),
      Layer.provideMerge(gatedStore),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
      Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
      Layer.provideMerge(boardFilesLayer),
    );
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "started",
        name: "Started",
        defaultProjectId: null,
      });
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "A", description: "Original" },
        owner,
      );
      target = card.id;
      const sibling = yield* kanban.createCard(
        board.id,
        { prompt: "B", title: "B", description: "Original" },
        owner,
      );
      const otherBoard = yield* kanban.ensureBoard({
        slug: "independent",
        name: "Independent",
        defaultProjectId: null,
      });
      const other = yield* kanban.createCard(
        otherBoard.id,
        { prompt: "C", title: "C", description: "Original" },
        owner,
      );
      const write = yield* Effect.forkChild(
        kanban.editCard(card.id, { description: "Started" }, owner),
      );
      yield* Deferred.await(started);
      yield* kanban.editCard(sibling.id, { description: "Sibling progresses" }, owner);
      yield* kanban.editCard(other.id, { description: "Other board progresses" }, owner);
      const queued = yield* Effect.forkChild(
        kanban.editCard(card.id, { description: "Expired" }, owner).pipe(Effect.flip),
      );
      yield* TestClock.adjust(KanbanService.BOARD_WRITE_START_DEADLINE_MS + 1);
      assert.include((yield* Fiber.join(queued)).message, "Board busy: not written");
      assert.isUndefined(write.pollUnsafe());
      yield* Deferred.succeed(finish, undefined);
      assert.strictEqual((yield* Fiber.join(write)).description, "Started");
      assert.strictEqual((yield* kanban.card(card.id)).card.description, "Started");
      assert.strictEqual((yield* kanban.card(sibling.id)).card.description, "Sibling progresses");
      assert.strictEqual((yield* kanban.card(other.id)).card.description, "Other board progresses");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("new board defaults follow the migration setting without rewriting existing boards", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const original = yield* kanban.ensureBoard({
        slug: "original",
        name: "Original",
        defaultProjectId: null,
      });
      assert.deepStrictEqual(original.managerModel, DEFAULT_MANAGER_MODEL);
      assert.deepStrictEqual(original.evaluatorModel, DEFAULT_EVALUATOR_MODEL);
      assert.deepStrictEqual(original.defaultCardModel, DEFAULT_CARD_MODEL);

      yield* settings.updateSettings({ ardudHarnessMigration: { selections: "dryrun" } });
      const dryrun = yield* kanban.ensureBoard({
        slug: "dryrun",
        name: "Dry run",
        defaultProjectId: null,
      });
      assert.deepStrictEqual(dryrun.managerModel, DEFAULT_MANAGER_MODEL);
      assert.deepStrictEqual(dryrun.defaultCardModel, DEFAULT_CARD_MODEL);

      yield* settings.updateSettings({ ardudHarnessMigration: { selections: "apply" } });
      const mapped = yield* kanban.ensureBoard({
        slug: "mapped",
        name: "Mapped",
        defaultProjectId: null,
      });
      assert.deepStrictEqual(mapped.managerModel, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-5-5",
        options: [{ id: "effort", value: "xhigh" }],
      });
      assert.deepStrictEqual(mapped.defaultCardModel, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      });
      assert.deepStrictEqual(mapped.evaluatorModel, mapped.defaultCardModel);
      const pools = (yield* kanban.snapshot(mapped.id)).pools;
      assert.deepStrictEqual(
        pools.map((pool) => pool.key),
        ["claudeAgent/claude-haiku-5-5#xhigh", "claudeAgent/claude-opus-5-5#high"],
      );
      assert.deepStrictEqual(
        (yield* kanban.ensureBoard({ slug: "original", name: "Again", defaultProjectId: null }))
          .managerModel,
        DEFAULT_MANAGER_MODEL,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "WS board creation, updates, pools and setup canonicalize legacy selections at the service boundary",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const service = yield* KanbanService.KanbanService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const ws = makeKanbanWsHandlers(service, {} as KanbanScriptsShape);
        const legacy = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
        const expected: ModelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "xhigh" }],
        };
        const off = yield* ws[M.boardCreate]({
          slug: "legacy-ws",
          name: "Legacy",
          defaultProjectId: null,
          evaluatorModel: legacy,
        });
        assert.deepStrictEqual(off.evaluatorModel, legacy);
        yield* settings.updateSettings({ ardudHarnessMigration: { selections: "apply" } });
        const board = yield* ws[M.boardCreate]({
          slug: "native-ws",
          name: "Native",
          defaultProjectId: ProjectId.make("project-1"),
          evaluatorModel: legacy,
        });
        assert.deepStrictEqual(board.evaluatorModel, expected);
        const updated = yield* ws[M.boardUpdate]({
          boardId: board.id,
          managerModel: legacy,
          reviewChains: [{ name: "review", steps: [legacy] }],
        });
        assert.deepStrictEqual(updated.managerModel, expected);
        assert.deepStrictEqual(updated.reviewChains[0]?.steps[0], expected);
        const pools = yield* ws[M.poolSet]({ boardId: board.id, model: legacy, slots: 2 });
        assert.isTrue(
          pools.some(
            (pool) => pool.key === "claudeAgent/claude-opus-5-5#xhigh" && pool.slots === 2,
          ),
        );
        yield* ws[M.setupStart]({ boardId: board.id, evaluatorModel: legacy, text: "setup" });
        assert.deepStrictEqual((yield* service.snapshot(board.id)).board.evaluatorModel, expected);
        const launched = yield* Ref.get(fake.threads);
        assert.isTrue(
          [...launched.values()].some((thread) => thread.model.instanceId === "claudeAgent"),
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("runs a card from To-Do through work, review findings, fix and a clear review", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Fix the flaky test", title: "Flaky test" },
        owner,
      );
      assert.strictEqual(created.stage, "todo");
      assert.strictEqual(created.number, 1);

      yield* kanban.dispatchNow;
      let card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.stage, "working");
      assert.isNotNull(card.activeThreadId);
      const workThread = card.activeThreadId!;
      assert.strictEqual(card.workThreadId, workThread);

      // The worker can't move its card to Completed, only to review.
      const thread: KanbanActor = { _tag: "thread", threadId: workThread };
      const denied = yield* kanban
        .moveCard(created.id, "completed", "cardThread", thread)
        .pipe(Effect.flip);
      assert.strictEqual(denied.code, "denied");

      yield* kanban.moveCard(created.id, "needs_review", "cardThread", thread, { note: "done" });
      card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.stage, "needs_review");
      assert.isNull(card.activeThreadId);

      yield* kanban.dispatchNow;
      card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.stage, "in_review");
      const reviewThread = card.activeThreadId!;
      assert.notStrictEqual(reviewThread, workThread);

      yield* kanban.reviewResult(reviewThread, "findings", ["Test still sleeps 2s"]);
      card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.stage, "todo");
      assert.strictEqual(card.reviewRound, 1);

      // The fix goes back to the same work thread with the findings.
      yield* kanban.dispatchNow;
      card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.stage, "working");
      assert.strictEqual(card.activeThreadId, workThread);
      const workMessages = (yield* Ref.get(fake.threads)).get(workThread)!.messages;
      assert.include(workMessages.at(-1) ?? "", "Test still sleeps 2s");

      yield* kanban.moveCard(created.id, "needs_review", "cardThread", thread);
      yield* kanban.dispatchNow;
      card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.activeThreadId, reviewThread);
      yield* kanban.reviewResult(reviewThread, "clear", []);
      card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.stage, "completed");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an evaluator can't complete or deploy an unreviewed card; the owner can", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "A",
          title: "A",
          subtasks: [
            { text: "Do it", owner: "work" },
            { text: "Review it", owner: "review" },
          ],
        },
        owner,
      );
      const toCompleted = yield* kanban
        .moveCard(card.id, "completed", "evaluator", evaluator)
        .pipe(Effect.flip);
      assert.strictEqual(toCompleted.code, "denied");
      assert.include(toCompleted.detail ?? "", "s2");
      const toDeployed = yield* kanban
        .moveCard(card.id, "deployed", "evaluator", evaluator)
        .pipe(Effect.flip);
      assert.strictEqual(toDeployed.code, "denied");
      assert.include(toDeployed.detail ?? "", "s2");

      const byOwner = yield* kanban.moveCard(card.id, "completed", "owner", owner);
      assert.strictEqual(byOwner.stage, "completed");
      const stillDenied = yield* kanban
        .moveCard(card.id, "deployed", "evaluator", evaluator)
        .pipe(Effect.flip);
      assert.strictEqual(stillDenied.code, "denied");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a reviewed card goes on to deployed", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId: workThread };
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker, { note: "done" });
      yield* kanban.dispatchNow;
      const reviewThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const reviewMessages = (yield* Ref.get(fake.threads)).get(reviewThread)!.messages;
      assert.include(reviewMessages[0] ?? "", "Verdict:");
      yield* kanban.reviewResult(reviewThread, "clear", []);
      assert.strictEqual((yield* kanban.card(card.id)).card.stage, "completed");
      const deployed = yield* kanban.moveCard(card.id, "deployed", "evaluator", evaluator);
      assert.strictEqual(deployed.stage, "deployed");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a review event records the head the reviewer passed", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Fix the flaky test", title: "Flaky test" },
        owner,
      );
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const thread: KanbanActor = { _tag: "thread", threadId: workThread };
      yield* kanban.moveCard(created.id, "needs_review", "cardThread", thread, { note: "done" });
      yield* kanban.dispatchNow;
      const reviewThread = (yield* kanban.card(created.id)).card.activeThreadId!;

      const invalid = yield* kanban
        .reviewResult(reviewThread, "clear", [], "not-a-sha")
        .pipe(Effect.flip);
      assert.strictEqual(invalid.code, "invalid");
      assert.strictEqual((yield* kanban.card(created.id)).card.stage, "in_review");

      // A findings round without a head stores head null on its review event.
      yield* kanban.reviewResult(reviewThread, "findings", ["Test still sleeps 2s"]);
      yield* kanban.dispatchNow;
      yield* kanban.moveCard(created.id, "needs_review", "cardThread", thread);
      yield* kanban.dispatchNow;
      const secondReview = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.reviewResult(secondReview, "clear", [], " ABC1234DEF ");

      const reviews = (yield* kanban.card(created.id)).events.filter(
        (event) => event.kind === "review",
      );
      assert.deepStrictEqual(
        reviews.map((event) => event.head),
        [null, "abc1234def"],
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const startReplayReview = Effect.gen(function* () {
  const kanban = yield* KanbanService.KanbanService;
  const board = yield* kanban.ensureBoard({
    slug: "replay",
    name: "Replay",
    defaultProjectId: ProjectId.make("project-1"),
  });
  yield* kanban.setPool(board.id, board.defaultCardModel, 2);
  const card = yield* kanban.createCard(board.id, { prompt: "Review", title: "Review" }, owner);
  yield* kanban.dispatchNow;
  const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
  const worker: KanbanActor = { _tag: "thread", threadId: workThread };
  yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
  yield* kanban.dispatchNow;
  const reviewing = (yield* kanban.card(card.id)).card;
  assert.strictEqual(reviewing.stage, "in_review");
  assert.isNotNull(reviewing.activeThreadId);
  assert.notStrictEqual(reviewing.activeThreadId, workThread);
  return { kanban, card, worker, reviewThread: reviewing.activeThreadId! };
});

it.effect("ignores a repeated clear with the same normalized head", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, reviewThread } = yield* startReplayReview;
      const first = yield* kanban.reviewResult(reviewThread, "clear", [], "abc1234");
      const before = yield* kanban.card(card.id);
      const sends = fake.sends.length;
      const replay = yield* kanban.reviewResult(reviewThread, "clear", [], " ABC1234 ");
      const after = yield* kanban.card(card.id);
      assert.deepStrictEqual(replay, first);
      assert.deepStrictEqual(after.card, before.card);
      assert.deepStrictEqual(after.events, before.events);
      assert.strictEqual(after.card.stage, first.stage);
      assert.strictEqual(after.card.reviewStep, first.reviewStep);
      assert.strictEqual(after.card.reviewRound, first.reviewRound);
      assert.lengthOf(
        after.events.filter((event) => event.kind === "review"),
        1,
      );
      assert.strictEqual(fake.sends.length, sends);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("ignores repeated findings without bumping the review round", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, reviewThread } = yield* startReplayReview;
      const first = yield* kanban.reviewResult(
        reviewThread,
        "findings",
        ["Fee is wrong"],
        "abc1234",
      );
      const before = yield* kanban.card(card.id);
      const replay = yield* kanban.reviewResult(
        reviewThread,
        "findings",
        [" Fee is wrong "],
        "abc1234",
      );
      const after = yield* kanban.card(card.id);
      assert.strictEqual(first.reviewRound, 1);
      assert.deepStrictEqual(replay, first);
      assert.deepStrictEqual(after.card, before.card);
      assert.deepStrictEqual(after.events, before.events);
      assert.lengthOf(
        after.events.filter((event) => event.kind === "review"),
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("rejects verdict replays that differ or lack a valid head", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, reviewThread } = yield* startReplayReview;
      yield* kanban.reviewResult(reviewThread, "findings", ["Fee is wrong"], "abc1234");
      const before = yield* kanban.card(card.id);
      const attempts = [
        { verdict: "clear" as const, findings: [] as string[], head: "abc1234" },
        { verdict: "findings" as const, findings: ["Fee is incorrect"], head: "abc1234" },
        { verdict: "findings" as const, findings: ["Fee is wrong"], head: "def1234" },
        { verdict: "findings" as const, findings: ["Fee is wrong"], head: undefined },
        { verdict: "findings" as const, findings: ["Fee is wrong"], head: "invalid" },
      ];
      for (const attempt of attempts) {
        const error = yield* kanban
          .reviewResult(reviewThread, attempt.verdict, attempt.findings, attempt.head)
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "conflict");
        assert.strictEqual(error.detail, `card #${card.number} is not in review with this thread`);
      }
      const after = yield* kanban.card(card.id);
      assert.deepStrictEqual(after.card, before.card);
      assert.deepStrictEqual(after.events, before.events);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("rejects an old reviewer's replay after another thread records a review", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, reviewThread } = yield* startReplayReview;
      yield* kanban.reviewResult(reviewThread, "findings", ["Fee is wrong"], "abc1234");
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: workThread,
      });
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(card.id)).card.activeThreadId, reviewThread);
      yield* kanban.cardThread(card.id, "reset", "Fresh review", owner);
      yield* kanban.dispatchNow;
      const nextReview = (yield* kanban.card(card.id)).card.activeThreadId!;
      assert.notStrictEqual(nextReview, reviewThread);
      assert.strictEqual((yield* kanban.card(card.id)).card.stage, "in_review");
      yield* kanban.reviewResult(nextReview, "findings", ["Fee is wrong"], "abc1234");
      const before = yield* kanban.card(card.id);
      const error = yield* kanban
        .reviewResult(reviewThread, "findings", ["Fee is wrong"], "abc1234")
        .pipe(Effect.flip);
      assert.strictEqual(error.code, "conflict");
      const after = yield* kanban.card(card.id);
      assert.deepStrictEqual(after.card, before.card);
      assert.deepStrictEqual(after.events, before.events);
      assert.lengthOf(
        after.events.filter((event) => event.kind === "review"),
        2,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("records the same verdict normally when the review thread is live or late again", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, card, worker, reviewThread } = yield* startReplayReview;
      yield* kanban.reviewResult(reviewThread, "findings", ["Fee is wrong"], "abc1234");
      for (const late of [false, true]) {
        yield* kanban.dispatchNow;
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
        yield* kanban.dispatchNow;
        const reviewing = (yield* kanban.card(card.id)).card;
        assert.strictEqual(reviewing.activeThreadId, reviewThread);
        if (late) {
          yield* kanban.flagCard(card.id, "Needs attention", {
            _tag: "thread",
            threadId: reviewThread,
          });
        }
        yield* kanban.reviewResult(reviewThread, "findings", ["Fee is wrong"], "abc1234");
      }
      const after = yield* kanban.card(card.id);
      assert.strictEqual(after.card.reviewRound, 3);
      assert.strictEqual(after.card.stalled?.reason, "Needs attention");
      assert.lengthOf(
        after.events.filter((event) => event.kind === "review"),
        3,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("tells the card's evaluator to decide scope after the third findings round", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Keep the review loop short", title: "Review loop" },
        owner,
      );
      const note = "got review findings for the third time";
      const evaluatorNotes = () =>
        Ref.get(fake.threads).pipe(
          Effect.map((threads) =>
            [...threads.values()].flatMap((thread) =>
              thread.messages.filter((message) => message.includes(note)),
            ),
          ),
        );

      for (let round = 1; round <= 3; round++) {
        yield* kanban.dispatchNow;
        let card = (yield* kanban.card(created.id)).card;
        const workThread = card.activeThreadId!;
        const thread: KanbanActor = { _tag: "thread", threadId: workThread };
        yield* kanban.moveCard(created.id, "needs_review", "cardThread", thread, { note: "done" });
        yield* kanban.dispatchNow;
        card = (yield* kanban.card(created.id)).card;
        const reviewThread = card.activeThreadId!;
        yield* kanban.reviewResult(reviewThread, "findings", [`Round ${round} finding`]);
        card = (yield* kanban.card(created.id)).card;
        assert.strictEqual(card.reviewRound, round);
        if (round < 3) assert.lengthOf(yield* evaluatorNotes(), 0);
      }

      assert.lengthOf(yield* evaluatorNotes(), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("walks the critical chain on the same review thread, switching models", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", variant: "xhigh" });
      const astra = modelSelectionOf({ model: "opus/gpt-6-astra", variant: "xhigh" });
      yield* kanban.updateBoard(board.id, {
        reviewChains: [{ name: "Critical", steps: [sol, astra] }],
        defaultReviewChain: "Critical",
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      yield* kanban.setPool(board.id, sol, 2);
      yield* kanban.setPool(board.id, astra, 2);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Change fee rounding", title: "Fee rounding", reviewChain: "Critical" },
        owner,
      );
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.moveCard(created.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: workThread,
      });
      yield* kanban.dispatchNow;
      let card = (yield* kanban.card(created.id)).card;
      const reviewThread = card.activeThreadId!;
      assert.include(card.activePool ?? "", "gpt-6.1-sol");

      yield* kanban.reviewResult(reviewThread, "clear", []);
      card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.stage, "needs_review");
      assert.strictEqual(card.reviewStep, 1);

      yield* kanban.dispatchNow;
      card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.activeThreadId, reviewThread);
      assert.include(card.activePool ?? "", "gpt-6-astra");

      yield* kanban.reviewResult(reviewThread, "clear", []);
      card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.stage, "completed");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an earlier step's turn end doesn't stop the chain step running in the same thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", variant: "xhigh" });
      const astra = modelSelectionOf({ model: "opus/gpt-6-astra", variant: "xhigh" });
      yield* kanban.updateBoard(board.id, {
        reviewChains: [{ name: "Critical", steps: [sol, astra] }],
        defaultReviewChain: "Critical",
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      yield* kanban.setPool(board.id, sol, 2);
      yield* kanban.setPool(board.id, astra, 2);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Change fee rounding", title: "Fee rounding", reviewChain: "Critical" },
        owner,
      );
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.moveCard(created.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: workThread,
      });
      yield* kanban.dispatchNow;
      const reviewThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.reviewResult(reviewThread, "clear", []);
      yield* kanban.dispatchNow;
      yield* setRunning(fake, reviewThread, true);

      // Step 1's run reports its end again while step 2 runs.
      yield* kanban.turnEnded(reviewThread);
      yield* kanban.turnEnded(reviewThread);
      let card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.stage, "in_review");
      assert.strictEqual(card.activeThreadId, reviewThread);
      assert.isNull(card.stalled);
      assert.isNull(card.nudgedAt);
      const texts = (yield* Ref.get(fake.threads)).get(reviewThread)!.messages;
      assert.isFalse(texts.some((text) => text.includes("record your verdict")));

      yield* kanban.reviewResult(reviewThread, "findings", ["Rounding drops a cent"]);
      card = (yield* kanban.card(created.id)).card;
      assert.strictEqual(card.stage, "todo");
      assert.strictEqual(card.reviewRound, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a reviewer's verdict after it lost its slot counts until the card moves on", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const toReview = Effect.fn("toReview")(function* (title: string) {
        const card = yield* kanban.createCard(board.id, { prompt: title, title }, owner);
        yield* kanban.dispatchNow;
        const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
          _tag: "thread",
          threadId: workThread,
        });
        yield* kanban.turnEnded(workThread);
        yield* kanban.dispatchNow;
        const reviewThread = (yield* kanban.card(card.id)).card.activeThreadId!;
        assert.notStrictEqual(reviewThread, workThread);
        return { card, reviewThread };
      });

      // The dispatcher flags a reviewer that ended twice without a verdict.
      const quiet = yield* toReview("A");
      yield* kanban.turnEnded(quiet.reviewThread);
      yield* kanban.turnEnded(quiet.reviewThread);
      let card = (yield* kanban.card(quiet.card.id)).card;
      assert.strictEqual(card.stage, "needs_review");
      assert.strictEqual(card.stalled?.reason, "Reviewer stopped without a verdict");
      yield* kanban.reviewResult(quiet.reviewThread, "clear", []);
      card = (yield* kanban.card(quiet.card.id)).card;
      assert.strictEqual(card.stage, "completed");
      assert.isNull(card.stalled);
      const again = yield* kanban.reviewResult(quiet.reviewThread, "clear", []).pipe(Effect.flip);
      assert.strictEqual(again.code, "conflict");

      // A reviewer's own flag frees the slot; its verdict still lands, the flag stays.
      const flagged = yield* toReview("B");
      const self: KanbanActor = { _tag: "thread", threadId: flagged.reviewThread };
      yield* kanban.flagCard(flagged.card.id, "Needs the owner's OK to message Ayush", self);
      yield* kanban.reviewResult(flagged.reviewThread, "findings", ["Fee is wrong"]);
      card = (yield* kanban.card(flagged.card.id)).card;
      assert.strictEqual(card.stage, "todo");
      assert.strictEqual(card.reviewRound, 1);
      assert.strictEqual(card.stalled?.reason, "Needs the owner's OK to message Ayush");

      // Once someone moves the card on, the old reviewer's verdict is refused.
      const moved = yield* toReview("C");
      yield* kanban.flagCard(moved.card.id, "Stuck", {
        _tag: "thread",
        threadId: moved.reviewThread,
      });
      yield* kanban.moveCard(moved.card.id, "todo", "owner", owner);
      const refused = yield* kanban.reviewResult(moved.reviewThread, "clear", []).pipe(Effect.flip);
      assert.strictEqual(refused.code, "conflict");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

// A critical chain whose step 1 lost its slot: its late clear moves nothing
// (needs_review -> needs_review), so a second clear must still be refused, and
// step 2 has to dispatch into the same thread as usual.
const chainStepOneLostSlot = (flag: "dispatcher" | "self") =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug: "toy",
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", variant: "xhigh" });
    const astra = modelSelectionOf({ model: "opus/gpt-6-astra", variant: "xhigh" });
    yield* kanban.updateBoard(board.id, {
      reviewChains: [{ name: "Critical", steps: [sol, astra] }],
      defaultReviewChain: "Critical",
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 2);
    yield* kanban.setPool(board.id, sol, 2);
    yield* kanban.setPool(board.id, astra, 2);
    const created = yield* kanban.createCard(
      board.id,
      { prompt: "Change fee rounding", title: "Fee rounding", reviewChain: "Critical" },
      owner,
    );
    yield* kanban.dispatchNow;
    const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
    yield* kanban.moveCard(created.id, "needs_review", "cardThread", {
      _tag: "thread",
      threadId: workThread,
    });
    yield* kanban.dispatchNow;
    const reviewThread = (yield* kanban.card(created.id)).card.activeThreadId!;

    if (flag === "dispatcher") {
      yield* kanban.turnEnded(reviewThread);
      yield* kanban.turnEnded(reviewThread);
      assert.strictEqual(
        (yield* kanban.card(created.id)).card.stalled?.reason,
        "Reviewer stopped without a verdict",
      );
    } else {
      yield* kanban.flagCard(created.id, "Needs the owner's OK", {
        _tag: "thread",
        threadId: reviewThread,
      });
    }

    yield* kanban.reviewResult(reviewThread, "clear", []);
    let card = (yield* kanban.card(created.id)).card;
    assert.strictEqual(card.stage, "needs_review");
    assert.strictEqual(card.reviewStep, 1);

    const duplicate = yield* kanban.reviewResult(reviewThread, "clear", []).pipe(Effect.flip);
    assert.strictEqual(duplicate.code, "conflict");
    card = (yield* kanban.card(created.id)).card;
    assert.strictEqual(card.reviewStep, 1);

    // The dispatcher's flag is cleared by the verdict, so step 2 dispatches into
    // the same thread. A reviewer's own flag still holds the card for the
    // evaluator: nothing is dispatched until someone answers it.
    yield* kanban.dispatchNow;
    card = (yield* kanban.card(created.id)).card;
    if (flag === "dispatcher") {
      assert.strictEqual(card.activeThreadId, reviewThread);
      assert.include(card.activePool ?? "", "gpt-6-astra");
    } else {
      assert.isNull(card.activeThreadId);
      assert.isNotNull(card.stalled);
    }
    return { kanban, created, reviewThread };
  });

it.effect("a step-1 verdict that lost its slot is accepted once, after a dispatcher flag", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* chainStepOneLostSlot("dispatcher");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a step-1 verdict that lost its slot is accepted once, after a self flag", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* chainStepOneLostSlot("self");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("routes owner messages to the live thread, or to an evaluator when none", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Add a retry", title: "Retry" },
        owner,
      );
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;

      const discussion = yield* kanban.cardDiscussion(created.id);
      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Use 3 attempts" }]);
      const sent = (yield* Ref.get(fake.threads)).get(workThread)!.messages;
      assert.include(sent.at(-1) ?? "", "Use 3 attempts");
      let current = yield* kanban.discussion(discussion.id);
      const worker = current.participants.find(
        (participant) => participant.actor._tag === "thread",
      );
      assert.strictEqual(worker?.owes, "asked");
      assert.isNotNull(worker?.typingUntil);

      // The turn ends without a reply: one nudge, then nothing more.
      yield* kanban.turnEnded(workThread);
      current = yield* kanban.discussion(discussion.id);
      assert.strictEqual(
        current.participants.find((participant) => participant.actor._tag === "thread")?.owes,
        "nudged",
      );
      yield* kanban.post(discussion.id, { _tag: "thread", threadId: workThread }, [
        { _tag: "md", text: "Done, 3 attempts" },
      ]);
      current = yield* kanban.discussion(discussion.id);
      assert.strictEqual(current.lastSeq, 2);
      assert.isNull(
        current.participants.find((participant) => participant.actor._tag === "thread")?.owes,
      );

      // A separate channel starts its own evaluator.
      const channel = yield* kanban.createDiscussion(board.id, "Kafka TLS", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "When do certs expire?" }]);
      current = yield* kanban.discussion(channel.id);
      assert.isNotNull(current.evaluatorThreadId);
      const link = yield* kanban.caller(current.evaluatorThreadId!);
      assert.strictEqual(link?.role, "evaluator");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("announces a finished one-shot evaluator so its thread stops showing as running", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const ended = Stream.runHead(
        Stream.filter(
          yield* kanban.changes,
          ({ change }) => change._tag === "thread" && change.thread.running === false,
        ),
      );
      const setup = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });

      yield* kanban.turnEnded(setup);

      const announced = yield* ended;
      assert.isTrue(Option.isSome(announced));
      if (Option.isSome(announced) && announced.value.change._tag === "thread") {
        assert.strictEqual(announced.value.change.thread.threadId, setup);
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("announces a worker that ends after moving its card to needs owner", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const ended = Stream.runHead(
        Stream.filter(
          yield* kanban.changes,
          ({ change }) =>
            change._tag === "thread" &&
            change.thread.threadId === thread &&
            change.thread.running === false,
        ),
      );
      // The worker stops and its card waits on the owner: the dispatcher finds no
      // carried card to nudge, yet the run has finished and must say so.
      yield* kanban.moveCard(
        card.id,
        "needs_owner",
        "cardThread",
        { _tag: "thread", threadId: thread },
        { question: "Which fee?" },
      );
      yield* kanban.turnEnded(thread);

      assert.isTrue(Option.isSome(yield* ended));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("lists a board's card and evaluator threads, and marks board threads as board runs", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "threads",
        name: "Threads",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Add a retry", title: "Retry" },
        owner,
      );
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;

      const channel = yield* kanban.createDiscussion(board.id, "Certs", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "When do certs expire?" }]);
      const evaluatorThread = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;

      const threads = yield* kanban.threads(board.id);
      const roles = new Map(threads.map((link) => [link.threadId, link.role]));
      assert.strictEqual(roles.get(workThread), "work");
      assert.strictEqual(roles.get(evaluatorThread), "evaluator");
      assert.strictEqual(threads.find((link) => link.threadId === workThread)?.cardId, created.id);
      // Board threads are the only ones the owner path refuses.
      assert.isNotNull(yield* kanban.caller(workThread));
      assert.isNull(yield* kanban.caller(ThreadId.make("thread-not-from-a-board")));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("asksSomething spots a question, a choice or a call for the evaluator", () =>
  Effect.sync(() => {
    const ask = (blocks: ReadonlyArray<KanbanBlock>) =>
      KanbanService.asksSomething(
        blocks,
        KanbanService.blocksText(blocks, () => null),
      );
    assert.isFalse(ask([{ _tag: "md", text: "Done, 3 attempts" }]));
    assert.isFalse(ask([{ _tag: "md", text: "Logs at http://host/api?limit=200 look clean." }]));
    assert.isTrue(ask([{ _tag: "md", text: "Which layout should I use?" }]));
    assert.isTrue(ask([{ _tag: "md", text: "Should I keep it?\nThe rest is done." }]));
    assert.isTrue(ask([{ _tag: "md", text: "Evaluator help needed on card #2." }]));
    assert.isTrue(
      ask([
        {
          _tag: "choice",
          id: "q1",
          style: "pick",
          question: "Grid or row",
          options: [{ id: "a", label: "Grid" }],
          multi: false,
        },
      ]),
    );
  }),
);

it.effect("a worker's question in its card discussion reaches the discussion's evaluator", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "PIN pad", title: "PIN" },
        owner,
      );
      yield* kanban.dispatchNow;
      const worker: KanbanActor = {
        _tag: "thread",
        threadId: (yield* kanban.card(created.id)).card.activeThreadId!,
      };
      const discussion = yield* kanban.cardDiscussion(created.id);

      // A status update wakes nobody.
      yield* kanban.post(discussion.id, worker, [{ _tag: "md", text: "Tests pass, moving on." }]);
      assert.isNull((yield* kanban.discussion(discussion.id)).evaluatorThreadId);

      yield* kanban.post(discussion.id, worker, [
        { _tag: "md", text: "Should the PIN pad shuffle its digits?" },
      ]);
      let current = yield* kanban.discussion(discussion.id);
      const evaluatorId = current.evaluatorThreadId;
      assert.isNotNull(evaluatorId);
      const evaluator = (yield* Ref.get(fake.threads)).get(evaluatorId!)!;
      assert.include(evaluator.messages.at(-1) ?? "", "Should the PIN pad shuffle its digits?");
      assert.include(evaluator.messages.at(-1) ?? "", `card #${created.number}`);
      assert.isTrue(
        current.participants.every((participant) => participant.owes === null),
        "a worker's question owes no reply",
      );

      // The same evaluator hears a choice and a call for help.
      const heard = evaluator.messages.length;
      yield* kanban.post(discussion.id, worker, [
        {
          _tag: "choice",
          id: "q1",
          style: "pick",
          question: "Which layout",
          options: [
            { id: "a", label: "Grid" },
            { id: "b", label: "Row" },
          ],
          multi: false,
        },
      ]);
      yield* kanban.post(discussion.id, worker, [
        { _tag: "md", text: "Evaluator help needed: check the 9999 path." },
      ]);
      current = yield* kanban.discussion(discussion.id);
      assert.strictEqual(current.evaluatorThreadId, evaluatorId);
      assert.lengthOf(evaluator.messages, heard + 2);
      assert.include(evaluator.messages.at(-2) ?? "", "Which layout");
      assert.include(evaluator.messages.at(-1) ?? "", "9999 path");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("respects pool sizes and blocked cards", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const first = yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "A", priority: 2 },
        owner,
      );
      const second = yield* kanban.createCard(
        board.id,
        { prompt: "B", title: "B", priority: 1 },
        owner,
      );
      const blocked = yield* kanban.createCard(
        board.id,
        { prompt: "C", title: "C", priority: 1, blockedBy: [first.id] },
        owner,
      );
      // A is P2 but holds up C, a P1 card, so it goes as a P1 that holds
      // something up, ahead of B.
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(first.id)).card.stage, "working");
      assert.strictEqual((yield* kanban.card(second.id)).card.stage, "todo");
      assert.strictEqual((yield* kanban.card(blocked.id)).card.stage, "todo");

      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(second.id)).card.stage, "working");
      assert.strictEqual((yield* kanban.card(blocked.id)).card.stage, "todo");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("lets one work thread carry several cards and hold its slot between them", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const first = yield* kanban.createCard(
        board.id,
        { prompt: "Fee rounding", title: "A" },
        owner,
      );
      const related = yield* kanban.createCard(
        board.id,
        { prompt: "Fee display", title: "B", blockedBy: [first.id] },
        owner,
      );
      const other = yield* kanban.createCard(board.id, { prompt: "Other", title: "C" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      assert.strictEqual((yield* kanban.card(other.id)).card.stage, "todo");

      // The thread is busy with the first card; it creates one for itself.
      const setRunning = (running: boolean) =>
        Ref.update(fake.threads, (all) => {
          all.get(thread)!.running = running;
          return all;
        });
      yield* setRunning(true);
      const created = yield* kanban.createForThread(thread, { prompt: "Fee tests", title: "D" });
      assert.strictEqual(created.card.stage, "working");
      assert.strictEqual(created.card.activeThreadId, thread);
      assert.include(created.brief, `#${created.card.number}`);

      // B waits on A, which this thread carries, so it can be taken too.
      const next = yield* kanban.nextCards(thread);
      assert.deepStrictEqual(
        next.candidates.map((candidate) => candidate.card.id),
        [related.id],
      );
      yield* kanban.claimCard(thread, related.id);
      assert.strictEqual((yield* kanban.carried(thread)).length, 3);

      // Still one slot: the unrelated card waits.
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(other.id)).card.stage, "todo");

      // Each card goes to review on its own; the thread keeps the slot while it has work.
      const actor: KanbanActor = { _tag: "thread", threadId: thread };
      for (const id of [first.id, related.id, created.card.id]) {
        yield* kanban.moveCard(id, "needs_review", "cardThread", actor);
      }
      assert.strictEqual((yield* kanban.carried(thread)).length, 0);
      // The held slot lasts for the turn: no review or other card starts yet.
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(other.id)).card.stage, "todo");
      assert.strictEqual((yield* kanban.card(first.id)).card.stage, "needs_review");
      assert.isTrue((yield* kanban.nextCards(thread)).holdsSlot);
      assert.deepStrictEqual(fake.interrupted, []);

      // The turn ends with nothing taken: the slot frees and the queue moves.
      yield* setRunning(false);
      yield* kanban.turnEnded(thread);
      yield* kanban.dispatchNow;
      const stages = yield* Effect.forEach([first.id, other.id], (id) =>
        kanban.card(id).pipe(Effect.map((detail) => detail.card.stage)),
      );
      assert.deepStrictEqual(stages, ["in_review", "todo"]);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a card moved to the backlog pauses, and goes back to its thread when it leaves", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      const second = yield* kanban.createForThread(thread, { prompt: "B", title: "B" });

      // One card of a batch: the thread is told to pause it and goes on.
      yield* kanban.editCard(second.card.id, { priority: 5 }, owner);
      assert.deepStrictEqual(fake.interrupted, []);
      const sent = (yield* Ref.get(fake.threads)).get(thread)!.messages;
      assert.include(sent.at(-1) ?? "", "backlog");
      let paused = (yield* kanban.card(second.card.id)).card;
      assert.strictEqual(paused.stage, "todo");
      assert.isNull(paused.activeThreadId);
      assert.strictEqual(paused.workThreadId, thread);

      // The last card: the thread stops.
      yield* kanban.editCard(first.id, { priority: 5 }, owner);
      assert.deepStrictEqual(fake.interrupted, [thread]);
      yield* kanban.dispatchNow;
      paused = (yield* kanban.card(first.id)).card;
      assert.strictEqual(paused.stage, "todo");
      assert.isNull(paused.activeThreadId);

      // Out of the backlog, it goes back to the same thread.
      yield* kanban.editCard(first.id, { priority: 2 }, owner);
      yield* kanban.dispatchNow;
      const resumed = (yield* kanban.card(first.id)).card;
      assert.strictEqual(resumed.stage, "working");
      assert.strictEqual(resumed.activeThreadId, thread);
      const after = (yield* Ref.get(fake.threads)).get(thread)!.messages;
      assert.include(after.at(-1) ?? "", "is back with you");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("stopping one card of a batch tells the thread instead of interrupting it", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
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
      const second = yield* kanban.createForThread(thread, { prompt: "B", title: "B" });

      // An evaluator stops the second card; the thread goes on with the first.
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      yield* kanban.cardThread(second.card.id, "stop", "not needed", evaluator);
      assert.deepStrictEqual(fake.interrupted, []);
      const sent = (yield* Ref.get(fake.threads)).get(thread)!.messages;
      assert.include(sent.at(-1) ?? "", `#${second.card.number}`);
      assert.include(sent.at(-1) ?? "", `#${first.number}`);
      const stopped = (yield* kanban.card(second.card.id)).card;
      assert.strictEqual(stopped.stage, "todo");
      // Dropped for good: it won't rejoin this thread once unflagged.
      assert.strictEqual(stopped.workThreadId, null);

      // The last card stopping interrupts the thread.
      yield* kanban.cardThread(first.id, "stop", "", evaluator);
      assert.deepStrictEqual(fake.interrupted, [thread]);

      // Card history lists the thread for both cards.
      const threads = (yield* kanban.card(second.card.id)).threads;
      assert.deepStrictEqual(
        threads.map((link) => link.threadId),
        [thread],
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const toyBoard = Effect.gen(function* () {
  const kanban = yield* KanbanService.KanbanService;
  const board = yield* kanban.ensureBoard({
    slug: "toy",
    name: "Toy",
    defaultProjectId: ProjectId.make("project-1"),
  });
  const chained = yield* kanban.updateBoard(board.id, {
    reviewChains: [
      { name: "Standard", steps: [board.evaluatorModel] },
      {
        name: "Critical",
        steps: [board.evaluatorModel, board.defaultCardModel],
      },
    ],
    defaultReviewChain: "Standard",
  });
  yield* kanban.setPool(chained.id, chained.defaultCardModel, 1);
  return { kanban, board: chained };
});

const setBackground = (fake: Effect.Success<typeof makeFake>, threadId: string, count: number) =>
  Ref.update(fake.threads, (all) => {
    all.get(threadId)!.background = count;
    return all;
  });

const setRunning = (fake: Effect.Success<typeof makeFake>, threadId: string, running: boolean) =>
  Ref.update(fake.threads, (all) => {
    all.get(threadId)!.running = running;
    return all;
  });

it.effect("refuses a take without leaving a card behind", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const other = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
      yield* kanban.dispatchNow;
      const mine = (yield* kanban.card(first.id)).card.activeThreadId!;
      const theirs = (yield* kanban.card(other.id)).card.activeThreadId!;
      assert.notStrictEqual(mine, theirs);

      // Blocked by another thread's unfinished card: refused, and no card is made.
      const before = (yield* kanban.snapshot(board.id)).cards.length;
      const refused = yield* kanban
        .createForThread(mine, { prompt: "C", title: "C", blockedBy: [other.id] })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "denied");
      assert.strictEqual((yield* kanban.snapshot(board.id)).cards.length, before);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a thread without a slot can't claim from a full pool", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      // Its card waits on the owner and its turn ends: the thread holds no slot.
      yield* kanban.moveCard(
        first.id,
        "needs_owner",
        "cardThread",
        { _tag: "thread", threadId: thread },
        { question: "Which fee?" },
      );
      yield* kanban.turnEnded(thread);
      const second = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(second.id)).card.stage, "working");
      const waiting = yield* kanban.createCard(board.id, { prompt: "C", title: "C" }, owner);
      const denied = yield* kanban.claimCard(thread, waiting.id).pipe(Effect.flip);
      assert.strictEqual(denied.code, "denied");
      assert.include(denied.detail, "no free slot");
      assert.strictEqual((yield* kanban.card(waiting.id)).card.stage, "todo");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("tick frees a held slot once the thread stops running", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      yield* setRunning(fake, thread, true);
      yield* kanban.moveCard(first.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: thread,
      });
      // The review runs on the same pool; the held slot keeps it waiting.
      yield* kanban.tick;
      assert.strictEqual((yield* kanban.card(first.id)).card.stage, "needs_review");
      // The turn end was missed; the next tick sees the thread idle.
      yield* setRunning(fake, thread, false);
      yield* kanban.tick;
      assert.strictEqual((yield* kanban.card(first.id)).card.stage, "in_review");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a card whose thread is gone starts again on a new one", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      const second = yield* kanban.createForThread(thread, { prompt: "B", title: "B" });
      // The thread is deleted while it carries both cards.
      yield* Ref.update(fake.threads, (all) => {
        const copy = new Map(all);
        copy.delete(thread);
        return copy;
      });
      // One miss could be a read error; the second one lets the cards go.
      yield* kanban.tick;
      assert.strictEqual((yield* kanban.card(first.id)).card.activeThreadId, thread);
      yield* kanban.tick;
      const restarted = yield* Effect.forEach([first.id, second.card.id], (id) =>
        kanban.card(id).pipe(Effect.map((detail) => detail.card)),
      );
      const fresh = restarted.find((card) => card.stage === "working");
      assert.isDefined(fresh);
      assert.notStrictEqual(fresh?.activeThreadId, thread);
      // The other waits for the pool, not for the dead thread.
      const waiting = restarted.find((card) => card !== fresh);
      assert.strictEqual(waiting?.stage, "todo");
      assert.strictEqual(waiting?.workThreadId, null);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a batch card the owner pulls back to todo doesn't rejoin the thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const first = yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "A", reviewChain: "Critical" },
        owner,
      );
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      yield* setRunning(fake, thread, true);
      const second = yield* kanban.createForThread(thread, {
        prompt: "B",
        title: "B",
        reviewChain: "Standard",
      });
      // Follow-up work keeps the chain of the card it came from.
      assert.strictEqual(second.card.reviewChain, "Critical");
      yield* kanban.moveCard(second.card.id, "todo", "owner", owner);
      const pulled = (yield* kanban.card(second.card.id)).card;
      assert.strictEqual(pulled.workThreadId, null);
      yield* kanban.dispatchNow;
      const restarted = (yield* kanban.card(second.card.id)).card;
      assert.strictEqual(restarted.stage, "working");
      assert.notStrictEqual(restarted.activeThreadId, thread);
      const sent = (yield* Ref.get(fake.threads)).get(thread)!.messages;
      assert.notInclude(sent.join("\n"), "is back with you");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a card restarted on a new thread keeps what it was woken with", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* kanban.cardThread(card.id, "stop", "Hold on.", owner);
      // The owner's stop is not the thread's to lift.
      const lifted = yield* kanban
        .flagCard(card.id, null, { _tag: "thread", threadId: thread })
        .pipe(Effect.flip);
      assert.strictEqual(lifted.code, "denied");
      yield* Ref.update(fake.threads, (all) => {
        const copy = new Map(all);
        copy.delete(thread);
        return copy;
      });
      yield* kanban.cardThread(card.id, "wake", "Use the staging database.", owner);
      yield* kanban.dispatchNow;
      const restarted = (yield* kanban.card(card.id)).card;
      assert.strictEqual(restarted.stage, "working");
      assert.notStrictEqual(restarted.activeThreadId, thread);
      const brief = (yield* Ref.get(fake.threads)).get(restarted.activeThreadId!)!.messages[0];
      assert.include(brief, "Waiting for this card:\nUse the staging database.");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const overflow = {
  class: "provider_error",
  code: "provider.invalid-request",
  message: "[400]: prompt is too long: 1000528 tokens > 1000000 maximum",
} as OrchestrationV2ProviderFailure;

it.effect("a work thread that gets too long compacts before starting a fresh thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const oldThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      // A note arriving while the card is working must survive maintenance.
      const store = yield* KanbanStore.KanbanStore;
      const running = (yield* kanban.card(created.id)).card;
      yield* store.putCard({ ...running, wakeNote: "Keep this note." });
      const before = (yield* Ref.get(fake.threads)).get(oldThread)!.messages.length;
      fake.failures.set(oldThread, overflow);
      yield* kanban.turnEnded(oldThread);
      const old = (yield* Ref.get(fake.threads)).get(oldThread)!;
      assert.deepStrictEqual(old.messages.slice(before), ["/compact"]);
      const detail = yield* kanban.card(created.id);
      const moved = detail.card;
      assert.strictEqual(moved.stage, "todo");
      assert.isNull(moved.stalled);
      assert.strictEqual(moved.workThreadId, oldThread);
      assert.strictEqual(moved.wakeNote, "Keep this note.");
      assert.isNull(moved.activeThreadId);
      assert.isTrue(
        detail.events.some(
          (event) =>
            event.kind === "moved" &&
            event.body?.startsWith("Thread too long; compacting it before the next run") === true,
        ),
      );
      // The next dispatch waits until compaction ends, then wakes the same thread.
      old.running = true;
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(created.id)).card.stage, "todo");
      assert.deepStrictEqual(old.messages.slice(before), ["/compact"]);
      old.running = false;
      fake.failures.delete(oldThread);
      yield* kanban.dispatchNow;
      const resumed = (yield* kanban.card(created.id)).card;
      assert.strictEqual(resumed.stage, "working");
      assert.strictEqual(resumed.activeThreadId, oldThread);
      assert.strictEqual(old.messages.length, before + 2);
      assert.include(old.messages.at(-1)!, "Keep this note.");
      fake.failures.set(oldThread, overflow);
      yield* kanban.turnEnded(oldThread);
      assert.isNull((yield* kanban.card(created.id)).card.workThreadId);
      yield* kanban.dispatchNow;
      const fresh = (yield* kanban.card(created.id)).card;
      assert.strictEqual(fresh.stage, "working");
      assert.notStrictEqual(fresh.activeThreadId, oldThread);
      const first = (yield* Ref.get(fake.threads)).get(fresh.activeThreadId!)!.messages[0];
      assert.include(first, "Fresh thread:");
      assert.include(first, "x");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a busy work thread is not sent a compact turn behind its failed run", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const view = (yield* Ref.get(fake.threads)).get(thread)!;
      const before = view.messages.length;
      view.running = true;
      fake.failures.set(thread, overflow);
      yield* kanban.turnEnded(thread);
      assert.strictEqual(view.messages.length, before);
      assert.strictEqual((yield* kanban.card(created.id)).card.stage, "working");
      view.running = false;
      yield* kanban.turnEnded(thread);
      assert.deepStrictEqual(view.messages.slice(before), ["/compact"]);
      assert.strictEqual((yield* kanban.card(created.id)).card.stage, "todo");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a failed thread read retries the compact path on the next tick", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const messages = (yield* Ref.get(fake.threads)).get(thread)!.messages;
      fake.failures.set(thread, overflow);
      // State publishing and PR sync read before the compact safety check.
      fake.failReads.left = 3;
      yield* kanban.turnEnded(thread);
      assert.strictEqual((yield* kanban.card(created.id)).card.stage, "working");
      yield* kanban.tick;
      assert.include(messages, "/compact");
      assert.strictEqual((yield* kanban.card(created.id)).card.workThreadId, thread);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a failed worker that resumes during PR sync keeps its working card", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const state = (yield* Ref.get(fake.threads)).get(thread)!;
      fake.failures.set(thread, {
        class: "provider_error",
        code: "provider.invalid-request",
        message: "invalid previous request",
      } as OrchestrationV2ProviderFailure);
      const reached = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      fake.findCalls.length = 0;
      fake.findControl.beforeRead = (id, attempt) =>
        id === thread && attempt === 5
          ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(resume)))
          : Effect.void;
      const tick = yield* Effect.forkChild(kanban.tick);
      yield* Deferred.await(reached);
      state.running = true;
      fake.failures.delete(thread);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(tick);
      const after = yield* kanban.card(created.id);
      assert.strictEqual(after.card.stage, "working");
      assert.strictEqual(after.card.activeThreadId, thread);
      assert.isNull(after.card.stalled);
      assert.isFalse(
        after.events.some((event) => event.body?.includes("invalid previous request")),
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a new failed run during PR sync does not release cards for the old failure", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const failure = {
        class: "provider_error",
        code: "provider.invalid-request",
        message: "invalid previous request",
      } as OrchestrationV2ProviderFailure;
      fake.failures.set(thread, failure);
      const reached = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      fake.findCalls.length = 0;
      fake.findControl.beforeRead = (id, attempt) =>
        id === thread && attempt === 5
          ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(resume)))
          : Effect.void;
      const tick = yield* Effect.forkChild(kanban.tick);
      yield* Deferred.await(reached);
      fake.failures.set(thread, { ...failure });
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(tick);
      const after = yield* kanban.card(created.id);
      assert.strictEqual(after.card.stage, "working");
      assert.strictEqual(after.card.activeThreadId, thread);
      assert.isNull(after.card.stalled);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a failed worker whose run has not changed is still flagged on tick", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      fake.failures.set(thread, {
        class: "provider_error",
        code: "provider.invalid-request",
        message: "invalid previous request",
      } as OrchestrationV2ProviderFailure);
      yield* kanban.tick;
      const after = yield* kanban.card(created.id);
      assert.strictEqual(after.card.stage, "todo");
      assert.isNull(after.card.activeThreadId);
      assert.strictEqual(after.card.stalled?.reason, "Run failed: invalid previous request");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a held sibling does not prevent another shared card from recovering on repeated ticks",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        yield* kanban.setPool(board.id, board.defaultCardModel, 1);
        const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
        yield* kanban.dispatchNow;
        const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
        const second = yield* kanban.createForThread(thread, { prompt: "B", title: "B" });
        yield* kanban.flagCard(second.card.id, "Owner hold", owner);
        const waiting = yield* kanban.createCard(board.id, { prompt: "C", title: "C" }, owner);
        fake.failures.set(thread, {
          class: "provider_error",
          code: "provider.invalid-request",
          message: "invalid previous request",
        } as OrchestrationV2ProviderFailure);
        let releasedEvents: number[] | null = null;
        for (let i = 0; i < 2; i++) {
          yield* kanban.tick;
          const aDetail = yield* kanban.card(first.id);
          const a = aDetail.card;
          const b = (yield* kanban.card(second.card.id)).card;
          assert.strictEqual(a.stage, "todo");
          assert.isNull(a.activeThreadId);
          assert.strictEqual(a.stalled?.reason, "Run failed: invalid previous request");
          assert.strictEqual(b.stalled?.reason, "Owner hold");
          assert.strictEqual(b.stalled?.by._tag, "owner");
          assert.strictEqual(b.activeThreadId, thread);
          assert.isFalse((yield* kanban.carried(thread)).some((card) => card.id === first.id));
          const holding = Rules.poolThreads((yield* kanban.snapshot(board.id)).cards);
          assert.isNotNull(b.activePool);
          assert.deepStrictEqual([...holding.get(b.activePool!)!], [thread]);
          assert.strictEqual((yield* kanban.card(waiting.id)).card.stage, "todo");
          const ids = aDetail.events.map((event) => event.id);
          if (releasedEvents !== null) assert.deepStrictEqual(ids, releasedEvents);
          releasedEvents = ids;
        }
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a held sibling remains held when a shared worker compacts after failure", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      const second = (yield* kanban.createForThread(thread, { prompt: "B", title: "B" })).card;
      yield* kanban.flagCard(second.id, "Owner hold", owner);
      yield* kanban.setPool(board.id, board.defaultCardModel, 0);
      fake.failures.set(thread, { ...overflow });
      for (let i = 0; i < 2; i++) {
        yield* kanban.tick;
        const a = (yield* kanban.card(first.id)).card;
        const b = (yield* kanban.card(second.id)).card;
        assert.strictEqual(a.stage, "todo");
        assert.strictEqual(a.workThreadId, thread);
        assert.isNull(a.activeThreadId);
        assert.isNull(a.stalled);
        assert.strictEqual(b.stalled?.reason, "Owner hold");
        assert.strictEqual(b.activeThreadId, thread);
      }
      const messages = (yield* Ref.get(fake.threads)).get(thread)!.messages;
      assert.strictEqual(messages.filter((message) => message === "/compact").length, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("later ticks ignore the same failure after its work card is released", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const threadState = (yield* Ref.get(fake.threads)).get(thread)!;
      fake.failures.set(thread, { ...overflow });

      // Keep the same failed-run identity and prevent the normal dispatcher
      // from waking it, while the thread remains idle for the backstop.
      yield* kanban.turnEnded(thread);
      const released = yield* kanban.card(created.id);
      assert.strictEqual(released.card.stage, "todo");
      assert.isNull(released.card.activeThreadId);
      assert.strictEqual(released.card.workThreadId, thread);
      assert.strictEqual(
        threadState.messages.filter((message) => message === "/compact").length,
        1,
      );
      yield* kanban.setPool(board.id, board.defaultCardModel, 0);
      const messages = [...threadState.messages];
      const eventIds = released.events.map((event) => event.id);
      const reads = fake.failureReads.length;

      yield* kanban.tick;
      yield* kanban.tick;
      const after = yield* kanban.card(created.id);
      assert.strictEqual(after.card.stage, "todo");
      assert.strictEqual(after.card.workThreadId, thread);
      assert.isNull(after.card.activeThreadId);
      assert.deepStrictEqual(threadState.messages, messages);
      assert.deepStrictEqual(
        after.events.map((event) => event.id),
        eventIds,
      );
      assert.strictEqual(fake.failureReads.length, reads);

      // The fresh-thread path likewise releases it; stale failures cannot be replayed.
      fake.failures.delete(thread);
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(created.id)).card.activeThreadId, thread);
      fake.failures.set(thread, { ...overflow });
      yield* kanban.turnEnded(thread);
      const fresh = yield* kanban.card(created.id);
      assert.strictEqual(fresh.card.stage, "todo");
      assert.isNull(fresh.card.workThreadId);
      assert.isNull(fresh.card.activeThreadId);
      const freshEventIds = fresh.events.map((event) => event.id);
      const freshMessages = [...threadState.messages];
      const freshReads = fake.failureReads.length;
      // Prevent tick's normal dispatcher from launching the replacement yet.
      yield* kanban.setPool(board.id, board.defaultCardModel, 0);
      yield* kanban.tick;
      yield* kanban.tick;
      assert.deepStrictEqual(
        (yield* kanban.card(created.id)).events.map((event) => event.id),
        freshEventIds,
      );
      assert.deepStrictEqual(threadState.messages, freshMessages);
      assert.strictEqual(fake.failureReads.length, freshReads);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("one recent compact attempt covers a newly claimed card on the same thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      const messages = (yield* Ref.get(fake.threads)).get(thread)!.messages;
      fake.failures.set(thread, { ...overflow });
      yield* kanban.turnEnded(thread);
      fake.failures.delete(thread);
      yield* kanban.dispatchNow;
      const second = yield* kanban.createForThread(thread, { prompt: "B", title: "B" });
      const before = messages.length;
      fake.failures.set(thread, { ...overflow });
      yield* kanban.turnEnded(thread);
      assert.strictEqual(messages.length, before);
      assert.isNull((yield* kanban.card(first.id)).card.workThreadId);
      assert.isNull((yield* kanban.card(second.card.id)).card.workThreadId);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const handoffFull = {
  class: "provider_error",
  code: null,
  message:
    "Insufficient context allowance for the provider handoff. Compact the target conversation or use a larger-context model; the current request has not been truncated.",
} as never;

it.effect("a work thread refused for handoff context starts the card on a fresh thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const oldThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const before = (yield* Ref.get(fake.threads)).get(oldThread)!.messages.length;
      fake.failures.set(oldThread, handoffFull);
      yield* kanban.turnEnded(oldThread);
      assert.strictEqual((yield* Ref.get(fake.threads)).get(oldThread)!.messages.length, before);
      const moved = (yield* kanban.card(created.id)).card;
      assert.strictEqual(moved.stage, "todo");
      assert.isNull(moved.stalled);
      assert.isNull(moved.workThreadId);
      assert.isNull(moved.activeThreadId);
      yield* kanban.dispatchNow;
      const fresh = (yield* kanban.card(created.id)).card;
      assert.strictEqual(fresh.stage, "working");
      assert.notStrictEqual(fresh.activeThreadId, oldThread);
      const first = (yield* Ref.get(fake.threads)).get(fresh.activeThreadId!)!.messages[0];
      assert.include(first, "Fresh thread:");
      assert.include(first, "x");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an overflow after compaction and a fresh start within the hour is flagged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const first = (yield* kanban.card(created.id)).card.activeThreadId!;
      fake.failures.set(first, overflow);
      yield* kanban.turnEnded(first);
      fake.failures.delete(first);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(created.id)).card.activeThreadId, first);
      fake.failures.set(first, overflow);
      yield* kanban.turnEnded(first);
      yield* kanban.dispatchNow;
      const second = (yield* kanban.card(created.id)).card.activeThreadId!;
      assert.notStrictEqual(second, first);
      fake.failures.set(second, overflow);
      yield* kanban.turnEnded(second);
      const flagged = (yield* kanban.card(created.id)).card;
      assert.strictEqual(flagged.stage, "todo");
      assert.match(flagged.stalled?.reason ?? "", /^Run failed: .*prompt is too long/);
      assert.strictEqual(flagged.workThreadId, second);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a rejected compact send takes the fresh-thread path", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      fake.rejectSends.add(thread);
      fake.failures.set(thread, overflow);
      yield* kanban.turnEnded(thread);
      const moved = (yield* kanban.card(created.id)).card;
      assert.strictEqual(moved.stage, "todo");
      assert.isNull(moved.stalled);
      assert.isNull(moved.workThreadId);
      yield* kanban.dispatchNow;
      const fresh = (yield* kanban.card(created.id)).card.activeThreadId!;
      assert.notStrictEqual(fresh, thread);
      assert.include((yield* Ref.get(fake.threads)).get(fresh)!.messages[0], "Fresh thread:");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a compact turn that fails after acceptance starts a fresh thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      fake.failures.set(thread, { ...overflow });
      yield* kanban.turnEnded(thread);
      const oldMessages = (yield* Ref.get(fake.threads)).get(thread)!.messages;
      assert.strictEqual(oldMessages.at(-1), "/compact");
      // The accepted maintenance turn itself then fails, rather than the send.
      fake.failures.set(thread, {
        ...overflow,
        message: "This provider does not support context compaction.",
      });
      const runId = fake.lastRuns.get(thread)!.runId;
      fake.lastRuns.set(thread, { runId, status: "failed", message: "/compact" });
      fake.runHistory.set(runId, { status: "failed", message: "/compact" });
      yield* kanban.turnEnded(thread);
      yield* kanban.dispatchNow;
      const moved = (yield* kanban.card(created.id)).card;
      assert.strictEqual(moved.stage, "todo");
      assert.isNull(moved.workThreadId);
      assert.isNull(moved.stalled);
      yield* kanban.dispatchNow;
      const fresh = (yield* kanban.card(created.id)).card.activeThreadId!;
      assert.notStrictEqual(fresh, thread);
      assert.include((yield* Ref.get(fake.threads)).get(fresh)!.messages[0], "Fresh thread:");
      assert.strictEqual(oldMessages.at(-1), "/compact");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a later unrelated turn does not hide a completed compaction", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      fake.failures.set(thread, { ...overflow });
      yield* kanban.turnEnded(thread);
      fake.failures.delete(thread);
      fake.lastRuns.set(thread, {
        runId: "later-run",
        status: "completed",
        message: "Another task",
      });
      yield* kanban.dispatchNow;
      const resumed = (yield* kanban.card(created.id)).card;
      assert.strictEqual(resumed.stage, "working");
      assert.strictEqual(resumed.activeThreadId, thread);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("one compact turn covers all work cards sharing a thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      const second = yield* kanban.createForThread(thread, { prompt: "B", title: "B" });
      const messages = (yield* Ref.get(fake.threads)).get(thread)!.messages;
      const before = messages.length;
      fake.failures.set(thread, overflow);
      yield* kanban.turnEnded(thread);
      assert.deepStrictEqual(messages.slice(before), ["/compact"]);
      for (const id of [first.id, second.card.id]) {
        const detail = yield* kanban.card(id);
        assert.strictEqual(detail.card.stage, "todo");
        assert.strictEqual(detail.card.workThreadId, thread);
        assert.isNull(detail.card.stalled);
        assert.isTrue(
          detail.events.some(
            (event) =>
              event.body?.startsWith("Thread too long; compacting it before the next run") === true,
          ),
        );
      }
      (yield* Ref.get(fake.threads)).get(thread)!.running = true;
      yield* kanban.dispatchNow;
      assert.deepStrictEqual(messages.slice(before), ["/compact"]);
      assert.strictEqual((yield* kanban.card(first.id)).card.stage, "todo");
      assert.strictEqual((yield* kanban.card(second.card.id)).card.stage, "todo");
      (yield* Ref.get(fake.threads)).get(thread)!.running = false;
      fake.failures.delete(thread);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(first.id)).card.activeThreadId, thread);
      assert.strictEqual((yield* kanban.card(second.card.id)).card.activeThreadId, thread);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a review thread that gets too long gets a fresh review", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.moveCard(created.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: workThread,
      });
      yield* kanban.turnEnded(workThread);
      yield* kanban.dispatchNow;
      const oldReview = (yield* kanban.card(created.id)).card.activeThreadId!;
      fake.failures.set(oldReview, overflow);
      yield* kanban.turnEnded(oldReview);
      const moved = (yield* kanban.card(created.id)).card;
      assert.strictEqual(moved.stage, "needs_review");
      assert.isNull(moved.stalled);
      assert.isNull(moved.reviewThreadId);
      yield* kanban.dispatchNow;
      const fresh = (yield* kanban.card(created.id)).card;
      assert.strictEqual(fresh.stage, "in_review");
      assert.notStrictEqual(fresh.activeThreadId, oldReview);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a later chain step that gets too long restarts on a complete fresh brief", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", variant: "xhigh" });
      const astra = modelSelectionOf({ model: "opus/gpt-6-astra", variant: "xhigh" });
      yield* kanban.updateBoard(board.id, {
        reviewChains: [{ name: "Critical", steps: [sol, astra] }],
        defaultReviewChain: "Critical",
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      yield* kanban.setPool(board.id, sol, 2);
      yield* kanban.setPool(board.id, astra, 2);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Change fee rounding", title: "Fee rounding", reviewChain: "Critical" },
        owner,
      );
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.moveCard(created.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: workThread,
      });
      yield* kanban.dispatchNow;
      const firstReview = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.reviewResult(firstReview, "clear", []);
      yield* kanban.dispatchNow;
      const stepTwo = (yield* kanban.card(created.id)).card;
      assert.strictEqual(stepTwo.reviewStep, 1);
      const oldStepTwo = stepTwo.activeThreadId!;
      fake.failures.set(oldStepTwo, overflow);
      yield* kanban.turnEnded(oldStepTwo);
      const moved = (yield* kanban.card(created.id)).card;
      assert.strictEqual(moved.stage, "needs_review");
      assert.strictEqual(moved.reviewStep, 1);
      assert.isNull(moved.reviewThreadId);
      yield* kanban.dispatchNow;
      const fresh = (yield* kanban.card(created.id)).card;
      assert.notStrictEqual(fresh.activeThreadId, oldStepTwo);
      assert.strictEqual(fresh.reviewStep, 1);
      const brief = (yield* Ref.get(fake.threads)).get(fresh.activeThreadId!)!.messages[0];
      assert.include(brief, "What the card asked for:");
      assert.include(brief, "Change fee rounding");
      assert.include(brief, "step 2 of 2");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a reset on a review card delivers its note to the fresh review", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.moveCard(created.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: workThread,
      });
      yield* kanban.turnEnded(workThread);
      yield* kanban.dispatchNow;
      const oldReview = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.cardThread(created.id, "reset", "Check the rounding path.", owner);
      const reset = (yield* kanban.card(created.id)).card;
      assert.strictEqual(reset.stage, "needs_review");
      assert.isNull(reset.reviewThreadId);
      assert.include(fake.interrupted, oldReview);
      yield* kanban.dispatchNow;
      const fresh = (yield* kanban.card(created.id)).card;
      assert.strictEqual(fresh.stage, "in_review");
      assert.notStrictEqual(fresh.activeThreadId, oldReview);
      const brief = (yield* Ref.get(fake.threads)).get(fresh.activeThreadId!)!.messages[0];
      assert.include(brief, "Check the rounding path.");
      assert.include(brief, "What the card asked for:");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("card_thread reset starts a working card on a fresh thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.cardThread(created.id, "reset", "Pick up at step 3.", owner);
      const reset = (yield* kanban.card(created.id)).card;
      assert.strictEqual(reset.stage, "todo");
      assert.isNull(reset.workThreadId);
      assert.isNull(reset.stalled);
      assert.include(fake.interrupted, thread);
      yield* kanban.dispatchNow;
      const fresh = (yield* kanban.card(created.id)).card;
      assert.notStrictEqual(fresh.activeThreadId, thread);
      const first = (yield* Ref.get(fake.threads)).get(fresh.activeThreadId!)!.messages[0];
      assert.include(first, "Pick up at step 3.");
      assert.include(first, "Fresh thread:");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("card_thread reset clears a flagged card's dead thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      fake.failures.set(thread, {
        class: "provider_error",
        code: "provider.no-route",
        message: "Variant unavailable for opus/gpt-6-astra: high",
      } as never);
      yield* kanban.turnEnded(thread);
      assert.isNotNull((yield* kanban.card(created.id)).card.stalled);
      assert.strictEqual((yield* kanban.card(created.id)).card.workThreadId, thread);
      yield* kanban.cardThread(created.id, "reset", "", owner);
      const reset = (yield* kanban.card(created.id)).card;
      assert.isNull(reset.stalled);
      assert.isNull(reset.workThreadId);
      yield* kanban.dispatchNow;
      const fresh = (yield* kanban.card(created.id)).card;
      assert.strictEqual(fresh.stage, "working");
      assert.notStrictEqual(fresh.activeThreadId, thread);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a card that moved to another thread no longer counts as this thread's", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      yield* setRunning(fake, thread, true);
      const moved = yield* kanban.createForThread(thread, { prompt: "X", title: "X" });
      yield* kanban.moveCard(moved.card.id, "todo", "owner", owner);
      yield* kanban.dispatchNow;
      const elsewhere = (yield* kanban.card(moved.card.id)).card;
      assert.strictEqual(elsewhere.stage, "working");
      assert.notStrictEqual(elsewhere.workThreadId, thread);
      // Waiting on #X is waiting on the other thread now.
      const waiting = yield* kanban.createCard(
        board.id,
        { prompt: "Y", title: "Y", blockedBy: [moved.card.id] },
        owner,
      );
      const refused = yield* kanban.claimCard(thread, waiting.id).pipe(Effect.flip);
      assert.strictEqual(refused.code, "denied");
      const next = yield* kanban.nextCards(thread);
      assert.notInclude(
        next.candidates.map((candidate) => candidate.card.id as string),
        waiting.id as string,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("board summaries count running, waiting and unread, and list the board's threads", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const pull = yield* Stream.toPull(kanban.boardSummaries);
      // Each pull takes what is queued, one list per batch; the last is the list now.
      const latest = Effect.map(pull, (chunk) => {
        const { board: summarized, boardId, ...counts } = chunk.at(-1)![0]!;
        assert.strictEqual(boardId, board.id);
        return { ...counts, sentBoard: summarized !== null };
      });
      assert.deepStrictEqual(yield* latest, {
        needsOwner: 0,
        running: 0,
        unread: 0,
        threadIds: [],
        sentBoard: true,
      });

      // After the first list only what changed comes: no board, only new threads.
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      assert.deepStrictEqual(yield* latest, {
        needsOwner: 0,
        running: 1,
        unread: 0,
        threadIds: [thread],
        sentBoard: false,
      });

      yield* kanban.moveCard(
        card.id,
        "needs_owner",
        "cardThread",
        { _tag: "thread", threadId: thread },
        { question: "Which fee?" },
      );
      const waiting = yield* latest;
      assert.strictEqual(waiting.needsOwner, 1);
      assert.strictEqual(waiting.running, 0);
      assert.isAbove(waiting.unread, 0);
      assert.deepStrictEqual(waiting.threadIds, []);

      const discussion = yield* kanban.cardDiscussion(card.id);
      yield* kanban.markRead(discussion.id, owner, discussion.lastSeq);
      const read = yield* latest;
      assert.deepStrictEqual([read.needsOwner, read.unread], [1, 0]);
      // A fresh list reads them from the links, not from the feed.
      const fresh = Option.getOrThrow(yield* kanban.boardSummaries.pipe(Stream.runHead));
      assert.includeMembers([...fresh[0]!.threadIds], [thread]);
    }).pipe(Effect.scoped, Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the board feed leaves prompts out; card reads and snapshots keep them", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Packet text", title: "A" }, owner);
      const pull = yield* Stream.toPull(kanban.watch(board.id));
      const firstEvents = Array.from(yield* pull);
      const snapshotEvent = firstEvents.find((event) => event._tag === "snapshot");
      assert.isDefined(snapshotEvent);
      if (snapshotEvent?._tag !== "snapshot") return;
      assert.strictEqual(snapshotEvent.snapshot.cards[0]!.prompt, "");
      assert.strictEqual(snapshotEvent.snapshot.cards[0]!.title, "A");

      yield* kanban.editCard(card.id, { priority: 2 }, owner);
      const nextEvents = Array.from(yield* pull);
      const changed = nextEvents.find(
        (event) => event._tag === "change" && event.change._tag === "card",
      );
      assert.isDefined(changed);
      if (changed?._tag !== "change" || changed.change._tag !== "card") return;
      assert.strictEqual(changed.change.card.prompt, "");
      assert.strictEqual(changed.change.card.priority, 2);

      assert.strictEqual((yield* kanban.card(card.id)).card.prompt, "Packet text");
      assert.strictEqual((yield* kanban.snapshot(board.id)).cards[0]!.prompt, "Packet text");
    }).pipe(Effect.scoped, Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the board feed's first frame does not wait on thread state", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* Ref.update(fake.threads, (all) => {
        all.get(thread)!.running = true;
        return all;
      });
      // Thread reads stall, like the orchestration reader queue on a busy server.
      const release = yield* Deferred.make<void>();
      fake.findControl.beforeRead = (id) =>
        id === thread ? Deferred.await(release) : Effect.void;

      const pull = yield* Stream.toPull(kanban.watch(board.id));
      const first = Array.from(yield* pull);
      const snapshotEvent = first.find((event) => event._tag === "snapshot");
      assert.isDefined(snapshotEvent);
      if (snapshotEvent?._tag !== "snapshot") return;
      assert.strictEqual(snapshotEvent.snapshot.cards[0]!.activeThreadId, thread);
      assert.deepStrictEqual(snapshotEvent.snapshot.threads, []);
      assert.isTrue(snapshotEvent.snapshot.threadsPending);
      assert.isFalse(yield* Deferred.isDone(release));

      yield* Deferred.succeed(release, undefined);
      const filled = Array.from(yield* pull).find(
        (event) => event._tag === "change" && event.change._tag === "thread",
      );
      assert.isDefined(filled);
      if (filled?._tag !== "change" || filled.change._tag !== "thread") return;
      assert.strictEqual(filled.change.thread.threadId, thread);
      assert.isTrue(filled.change.thread.running);

      // The full snapshot still carries thread state inline.
      const full = yield* kanban.snapshot(board.id);
      assert.isUndefined(full.threadsPending);
      assert.strictEqual(full.threads[0]?.threadId, thread);
    }).pipe(Effect.scoped, Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a thread can't reword or replace a flag someone else set", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const self: KanbanActor = { _tag: "thread", threadId: thread };
      yield* kanban.flagCard(card.id, "Hold on, waiting for the fee table", owner);
      for (const reason of ["I'm fine now", null]) {
        const refused = yield* kanban.flagCard(card.id, reason, self).pipe(Effect.flip);
        assert.strictEqual(refused.code, "denied");
      }
      assert.strictEqual(
        (yield* kanban.card(card.id)).card.stalled?.reason,
        "Hold on, waiting for the fee table",
      );
      // Its own flag stays its own to change.
      yield* kanban.flagCard(card.id, null, owner);
      yield* kanban.flagCard(card.id, "Blocked on CI", self);
      yield* kanban.flagCard(card.id, null, self);
      assert.isNull((yield* kanban.card(card.id)).card.stalled);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const nudgesTo = (fake: Effect.Success<typeof makeFake>, threadId: string) =>
  Ref.get(fake.threads).pipe(
    Effect.map(
      (all) =>
        all
          .get(threadId)!
          .messages.filter((text) => text.includes("still in Working and your turn ended")).length,
    ),
  );

const evaluatorNotesFor = (fake: Effect.Success<typeof makeFake>, text: string) =>
  Ref.get(fake.threads).pipe(
    Effect.map(
      (all) =>
        [...all.values()]
          .filter((thread) => thread.title.startsWith("Evaluator"))
          .flatMap((thread) => thread.messages)
          .filter((message) => message.includes(text)).length,
    ),
  );

it.effect("a worker is nudged at every quiet turn end", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* setRunning(fake, thread, true);
      yield* kanban.turnEnded(thread);
      assert.strictEqual(yield* nudgesTo(fake, thread), 0);
      yield* setRunning(fake, thread, false);
      for (const expected of [1, 2, 3, 4, 5]) {
        yield* kanban.turnEnded(thread);
        assert.strictEqual(yield* nudgesTo(fake, thread), expected);
      }
      assert.strictEqual(yield* evaluatorNotesFor(fake, `#${card.number}`), 0);
      const after = (yield* kanban.card(card.id)).card;
      assert.strictEqual(after.stage, "working");
      assert.strictEqual(after.activeThreadId, thread);
      assert.isNotNull(after.nudgedAt);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a worker that flags its own card tells the card's evaluator", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const self: KanbanActor = { _tag: "thread", threadId: thread };
      yield* kanban.flagCard(card.id, "Env broken: no node modules", self);
      const after = (yield* kanban.card(card.id)).card;
      assert.strictEqual(after.stage, "todo");
      assert.strictEqual(after.stalled?.reason, "Env broken: no node modules");
      assert.isNull(after.activeThreadId);
      assert.strictEqual(yield* evaluatorNotesFor(fake, `#${card.number}`), 1);
      assert.strictEqual(yield* evaluatorNotesFor(fake, "Env broken: no node modules"), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a failed read does not forget a status ask, so the next tick does not repeat it", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const evaluator = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Busy" });
      yield* setRunStart(fake, evaluator, true, "2026-10-25T13:00:00.000Z");
      yield* TestClock.adjust("46 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* statusAsksTo(fake, evaluator), 1);
      fake.failReads.left = 1;
      yield* kanban.tick;
      assert.strictEqual(fake.failReads.left, 0, "the injected read failure was consumed");
      yield* kanban.tick;
      assert.strictEqual(yield* statusAsksTo(fake, evaluator), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const statusAsksTo = (fake: Effect.Success<typeof makeFake>, threadId: string) =>
  Ref.get(fake.threads).pipe(
    Effect.map(
      (all) =>
        all
          .get(threadId)!
          .messages.filter((text) => text.includes("Board check: this turn has been running"))
          .length,
    ),
  );

const setRunStart = (
  fake: Effect.Success<typeof makeFake>,
  threadId: string,
  running: boolean,
  runStartedAt: string,
) =>
  Ref.update(fake.threads, (all) => {
    const thread = all.get(threadId)!;
    thread.running = running;
    thread.runStartedAt = runStartedAt;
    return all;
  });

it.effect("a long evaluator turn is asked for a status at 45 minutes, then hourly", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const evaluator = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Busy" });
      yield* setRunStart(fake, evaluator, true, "2026-10-25T13:00:00.000Z");
      yield* TestClock.adjust("44 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* statusAsksTo(fake, evaluator), 0);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* statusAsksTo(fake, evaluator), 1);
      const ask = (yield* Ref.get(fake.threads)).get(evaluator)!.messages.at(-1) ?? "";
      assert.strictEqual(
        ask,
        "Board check: this turn has been running for 46 minutes. If your last ETA in the discussion still holds, carry on without posting. Otherwise post one line there with discussion_post: what's done and the new ETA. After a second missed ETA, stop researching: file what's left as cards with what you know, post the summary, and end the turn.",
      );
      yield* kanban.tick;
      assert.strictEqual(yield* statusAsksTo(fake, evaluator), 1);
      yield* TestClock.adjust("60 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* statusAsksTo(fake, evaluator), 2);
      // A new run starts over: no ask until its own 45 minutes pass.
      yield* setRunStart(fake, evaluator, true, "2026-10-25T14:46:00.000Z");
      yield* TestClock.adjust("10 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* statusAsksTo(fake, evaluator), 2);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

// The wake starts or steers the discussion's evaluator, a thread the fake assigns, so count across all threads.
const stepWaitsTo = (fake: Effect.Success<typeof makeFake>) =>
  Ref.get(fake.threads).pipe(
    Effect.map(
      (all) =>
        [...all.values()]
          .flatMap((thread) => thread.messages)
          .filter((text) => text.includes("has waited")).length,
    ),
  );

const ownerWaitsTo = (fake: Effect.Success<typeof makeFake>, threadId: string) =>
  Ref.get(fake.threads).pipe(
    Effect.map(
      (all) =>
        all.get(threadId)!.messages.filter((text) => text.includes("has no reply yet")).length,
    ),
  );

it.effect(
  "a todo card waiting on its evaluator's packet wakes the card's evaluator once, after 15 minutes at P1",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
        const { kanban, board } = yield* toyBoard;
        yield* kanban.createCard(
          board.id,
          {
            prompt: "Packet card",
            title: "Packet",
            priority: 1,
            subtasks: [
              { step: 1, owner: "evaluator", text: "Packet" },
              { step: 2, owner: "work", text: "Build" },
            ],
          },
          { _tag: "evaluator", threadId: ThreadId.make("eval") },
        );
        // The first tick starts the wait clock.
        yield* kanban.tick;
        yield* TestClock.adjust("14 minutes");
        yield* kanban.tick;
        assert.strictEqual(yield* stepWaitsTo(fake), 0);
        yield* TestClock.adjust("2 minutes");
        yield* kanban.tick;
        assert.strictEqual(yield* stepWaitsTo(fake), 1);
        yield* TestClock.adjust("60 minutes");
        yield* kanban.tick;
        assert.strictEqual(yield* stepWaitsTo(fake), 1);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a P3 card waits an hour before the wake", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      yield* kanban.createCard(
        board.id,
        {
          prompt: "Packet card",
          title: "Packet",
          priority: 3,
          subtasks: [
            { step: 1, owner: "evaluator", text: "Packet" },
            { step: 2, owner: "work", text: "Build" },
          ],
        },
        { _tag: "evaluator", threadId: ThreadId.make("eval-p3") },
      );
      yield* kanban.tick;
      yield* TestClock.adjust("16 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 0);
      yield* TestClock.adjust("45 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an evaluator-stalled step never wakes over multiple ticks", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval-stalled") };
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Wait for the author",
          title: "Author fix",
          priority: 3,
          subtasks: [{ step: 1, owner: "evaluator", text: "Author fix round" }],
        },
        evaluator,
      );
      yield* kanban.flagCard(card.id, "Waiting for the author", evaluator);
      yield* kanban.tick;
      yield* TestClock.adjust("60 minutes");
      yield* kanban.tick;
      yield* TestClock.adjust("60 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 0);
      assert.strictEqual((yield* kanban.card(card.id)).card.stalled?.by._tag, "evaluator");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("clearing an evaluator stall starts a fresh step-wait clock", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval-clear") };
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Wait for the author",
          title: "Author fix",
          priority: 3,
          subtasks: [{ step: 1, owner: "evaluator", text: "Author fix round" }],
        },
        evaluator,
      );
      yield* kanban.tick;
      yield* TestClock.adjust("40 minutes");
      yield* kanban.flagCard(card.id, "Waiting for the author", evaluator);
      yield* kanban.tick;
      yield* TestClock.adjust("120 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 0);
      yield* kanban.flagCard(card.id, null, evaluator);
      yield* kanban.tick;
      yield* TestClock.adjust("59 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 0);
      yield* TestClock.adjust("1 minute");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 1);
      yield* TestClock.adjust("60 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each([
  { action: "flag" as const, afterWake: false },
  { action: "flag" as const, afterWake: true },
  { action: "stop" as const, afterWake: false },
  { action: "stop" as const, afterWake: true },
])("a brief evaluator $action after wake=$afterWake starts a fresh wait", ({ action, afterWake }) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval-brief") };
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Wait for the author",
          title: "Author fix",
          priority: 3,
          subtasks: [{ step: 1, owner: "evaluator", text: "Author fix round" }],
        },
        evaluator,
      );
      yield* kanban.tick;
      yield* TestClock.adjust(afterWake ? "60 minutes" : "40 minutes");
      if (afterWake) yield* kanban.tick;
      const before = afterWake ? 1 : 0;
      assert.strictEqual(yield* stepWaitsTo(fake), before);
      if (action === "flag") {
        yield* kanban.flagCard(card.id, "Waiting for the author", evaluator);
      } else {
        yield* kanban.cardThread(card.id, "stop", "Waiting for the author", evaluator);
      }
      assert.strictEqual((yield* kanban.card(card.id)).card.stalled?.by._tag, "evaluator");
      yield* kanban.flagCard(card.id, null, evaluator);
      yield* kanban.tick;
      yield* TestClock.adjust("59 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), before);
      yield* TestClock.adjust("1 minute");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), before + 1);
      yield* TestClock.adjust("60 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), before + 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each([
  { _tag: "system", component: "dispatcher" },
  { _tag: "owner" },
  { _tag: "thread", threadId: ThreadId.make("another-worker") },
  { _tag: "script", scriptId: KanbanScriptId.make("script-test") },
] as const)("a step stalled by $_tag still wakes its evaluator", (stalledBy) =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Packet card",
          title: "Packet",
          priority: 3,
          subtasks: [{ step: 1, owner: "evaluator", text: "Packet" }],
        },
        { _tag: "evaluator", threadId: ThreadId.make("eval-other-stall") },
      );
      yield* kanban.flagCard(card.id, "A different kind of stall", stalledBy);
      yield* kanban.tick;
      yield* TestClock.adjust("60 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 1);
      yield* TestClock.adjust("60 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a newly flagged card is rechecked before its evaluator is woken", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const control: { cardId?: KanbanCardId; armed: boolean; changed: boolean } = {
      armed: false,
      changed: false,
    };
    const racingStore = Layer.effect(
      KanbanStore.KanbanStore,
      Effect.map(KanbanStore.KanbanStore, (real) =>
        KanbanStore.KanbanStore.of({
          ...real,
          cards: (boardId) =>
            real.cards(boardId).pipe(
              Effect.tap((cards) => {
                const card = cards.find((item) => item.id === control.cardId);
                if (!control.armed || !card) return Effect.void;
                control.armed = false;
                control.changed = true;
                return real.putCard({
                  ...card,
                  stalled: {
                    reason: "Waiting for the author",
                    by: { _tag: "evaluator", threadId: ThreadId.make("eval-race") },
                    at: "2026-10-25T14:00:00.000Z",
                  },
                });
              }),
            ),
        }),
      ),
    );
    const layer = KanbanService.layer.pipe(
      Layer.provideMerge(fake.layer),
      Layer.provideMerge(KanbanModels.layerTest(null)),
      Layer.provideMerge(racingStore.pipe(Layer.provide(KanbanStore.layer))),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
      Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
      Layer.provideMerge(boardFilesLayer),
    );
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Packet card",
          title: "Packet",
          priority: 3,
          subtasks: [{ step: 1, owner: "evaluator", text: "Packet" }],
        },
        { _tag: "evaluator", threadId: ThreadId.make("eval-race") },
      );
      yield* kanban.tick;
      yield* TestClock.adjust("60 minutes");
      control.cardId = card.id;
      control.armed = true;
      yield* kanban.tick;
      assert.isTrue(control.changed);
      assert.strictEqual((yield* kanban.card(card.id)).card.stalled?.by._tag, "evaluator");
      assert.strictEqual(yield* stepWaitsTo(fake), 0);
      // Clear before another scan sees the flag; the fresh recheck must discard the old wait.
      yield* kanban.flagCard(card.id, null, {
        _tag: "evaluator",
        threadId: ThreadId.make("eval-race"),
      });
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 0);
      yield* TestClock.adjust("59 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 0);
      yield* TestClock.adjust("1 minute");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 1);
      yield* TestClock.adjust("60 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a card whose evaluator step changes starts its own clock", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Packet card",
          title: "Packet",
          priority: 1,
          subtasks: [
            { step: 1, owner: "evaluator", text: "Packet" },
            { step: 2, owner: "work", text: "Build" },
          ],
        },
        { _tag: "evaluator", threadId: ThreadId.make("eval-change") },
      );
      yield* kanban.tick;
      yield* TestClock.adjust("10 minutes");
      yield* kanban.tick;
      // A new evaluator subtask changes the key: the clock restarts at this tick.
      yield* kanban.editCard(
        card.id,
        {
          subtasks: [
            { step: 1, owner: "evaluator", text: "Packet" },
            { step: 1, owner: "evaluator", text: "Second packet" },
            { step: 2, owner: "work", text: "Build" },
          ],
        },
        owner,
      );
      yield* TestClock.adjust("10 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 0);
      yield* TestClock.adjust("16 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "an owner message a running evaluator hasn't answered gets one reminder after 15 minutes",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
        const { kanban, board } = yield* toyBoard;
        const channel = yield* kanban.createDiscussion(board.id, "Talk", owner);
        yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Please answer" }]);
        const evaluator = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
        assert.isNotNull(evaluator);
        yield* setRunStart(fake, evaluator, true, "2026-10-25T13:00:00.000Z");
        yield* TestClock.adjust("14 minutes");
        yield* kanban.tick;
        assert.strictEqual(yield* ownerWaitsTo(fake, evaluator), 0);
        yield* TestClock.adjust("2 minutes");
        yield* kanban.tick;
        assert.strictEqual(yield* ownerWaitsTo(fake, evaluator), 1);
        yield* kanban.tick;
        yield* TestClock.adjust("30 minutes");
        yield* kanban.tick;
        assert.strictEqual(yield* ownerWaitsTo(fake, evaluator), 1);
        // The evaluator answers; the owner writes again: a fresh 15 minutes, one more reminder.
        yield* kanban.post(channel.id, { _tag: "evaluator", threadId: evaluator }, [
          { _tag: "md", text: "On it" },
        ]);
        yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Still waiting" }]);
        yield* TestClock.adjust("16 minutes");
        yield* kanban.tick;
        assert.strictEqual(yield* ownerWaitsTo(fake, evaluator), 2);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("an idle evaluator gets no tick reminder", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Idle talk", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Hello?" }]);
      const evaluator = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      yield* setRunStart(fake, evaluator, false, "2026-10-25T13:00:00.000Z");
      yield* TestClock.adjust("60 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* ownerWaitsTo(fake, evaluator), 0);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a packet wake never goes to a settled or archived card discussion", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Packet card",
          title: "Packet",
          priority: 1,
          subtasks: [
            { step: 1, owner: "evaluator", text: "Packet" },
            { step: 2, owner: "work", text: "Build" },
          ],
        },
        { _tag: "evaluator", threadId: ThreadId.make("eval-settled") },
      );
      const discussion = yield* kanban.cardDiscussion(card.id);
      yield* kanban.tick;
      // The card is settled (so its discussion is) before the wait is over: nobody is woken.
      yield* kanban.moveCard(card.id, "verified", "owner", owner);
      yield* kanban.settleCard(card.id);
      assert.isNotNull((yield* kanban.discussion(discussion.id)).settledAt);
      yield* TestClock.adjust("16 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* stepWaitsTo(fake), 0);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an owner reminder is keyed to the owner's message, not later system posts", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Sys", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Please answer" }]);
      const evaluator = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      yield* setRunStart(fake, evaluator, true, "2026-10-25T13:00:00.000Z");
      yield* TestClock.adjust("14 minutes");
      // A system post lands at +14: it must not restart the owner's clock.
      yield* kanban.post(channel.id, { _tag: "system", component: "scribe" }, [
        { _tag: "md", text: "Status" },
      ]);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* ownerWaitsTo(fake, evaluator), 1);
      yield* TestClock.adjust("30 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* ownerWaitsTo(fake, evaluator), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

// Fails the next `allReadFailures.remaining` owner-wait reads; a full-history read always dies,
// so the tick is shown never to read the whole discussion.
const allReadFailures = { remaining: 0 };
const failingAllReadStore = Layer.effect(
  KanbanStore.KanbanStore,
  Effect.gen(function* () {
    const real = yield* KanbanStore.KanbanStore;
    return {
      ...real,
      allMessages: () => Effect.die("the tick read a whole discussion"),
      ownerWait: (id) =>
        allReadFailures.remaining > 0
          ? ((allReadFailures.remaining -= 1),
            Effect.fail(
              new KanbanStore.KanbanStoreError({
                operation: "read owner wait",
                cause: "injected",
              }),
            ))
          : real.ownerWait(id),
    };
  }),
);

it.effect("the owner-wait reminder reads no whole discussion", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Big talk", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "First" }]);
      const evaluator = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      yield* setRunStart(fake, evaluator, true, "2026-10-25T13:00:00.000Z");
      yield* kanban.post(channel.id, { _tag: "evaluator", threadId: evaluator }, [
        { _tag: "md", text: "x".repeat(200_000) },
      ]);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Second" }]);
      for (let i = 0; i < 5; i++) {
        yield* kanban.post(channel.id, { _tag: "system", component: "scribe" }, [
          { _tag: "md", text: `Status ${i}` },
        ]);
      }
      yield* TestClock.adjust("16 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* ownerWaitsTo(fake, evaluator), 1);
      // The evaluator answers after the owner's latest message: no more reminders.
      yield* kanban.post(channel.id, { _tag: "evaluator", threadId: evaluator }, [
        { _tag: "md", text: "Done" },
      ]);
      yield* kanban.post(channel.id, { _tag: "system", component: "scribe" }, [
        { _tag: "md", text: "Later status" },
      ]);
      const ask = yield* (yield* KanbanStore.KanbanStore).ownerWait(channel.id);
      assert.deepStrictEqual(ask && { seq: ask.seq, answered: ask.answered }, {
        seq: 3,
        answered: true,
      });
    }).pipe(Effect.provide(failingAllReadLayer(fake.layer)));
  }),
);

// testLayer with the store's full-history read failing on demand.
const failingAllReadLayer = (fake: Layer.Layer<KanbanThreads>) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(failingAllReadStore.pipe(Layer.provide(KanbanStore.layer))),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(boardFilesLayer),
  );

it.effect("a failed owner-wait history read skips only that discussion, not the tick", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Broken read", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Hello" }]);
      const evaluator = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      yield* setRunStart(fake, evaluator, true, "2026-10-25T13:00:00.000Z");
      // A dispatchable card on the same board must still start after the failing read.
      const card = yield* kanban.createCard(board.id, { prompt: "Ship", title: "Ship" }, owner);
      allReadFailures.remaining = 1;
      yield* TestClock.adjust("16 minutes");
      yield* kanban.tick;
      assert.strictEqual(allReadFailures.remaining, 0, "the injected read failure was consumed");
      assert.strictEqual(yield* ownerWaitsTo(fake, evaluator), 0);
      assert.strictEqual((yield* kanban.card(card.id)).card.stage, "working");
    }).pipe(Effect.provide(failingAllReadLayer(fake.layer)));
  }),
);

it.effect("an owner message stays reminded when the discussion has 50+ later system posts", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Window", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Old question" }]);
      const evaluator = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      yield* setRunStart(fake, evaluator, true, "2026-10-25T13:00:00.000Z");
      // More than a page of system posts after the owner's message, none answered.
      for (let i = 0; i < 55; i++) {
        yield* kanban.post(channel.id, { _tag: "system", component: "scribe" }, [
          { _tag: "md", text: `Status ${i}` },
        ]);
      }
      yield* TestClock.adjust("16 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* ownerWaitsTo(fake, evaluator), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a script-only post never triggers an owner reminder", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Script", owner);
      yield* kanban.post(channel.id, { _tag: "system", component: "script" }, [
        { _tag: "md", text: "Ran" },
      ]);
      yield* TestClock.adjust("60 minutes");
      yield* kanban.tick;
      // No owner message at all: no thread was sent an owner reminder.
      const sent = (yield* Ref.get(fake.threads))
        .values()
        .toArray()
        .flatMap((thread) => thread.messages)
        .filter((text) => text.includes("has no reply yet")).length;
      assert.strictEqual(sent, 0);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an evaluator that is not running gets no status ask", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const evaluator = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Idle" });
      yield* setRunStart(fake, evaluator, false, "2026-10-25T13:00:00.000Z");
      yield* TestClock.adjust("60 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* statusAsksTo(fake, evaluator), 0);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the tick nudges a quiet worker and interrupts one stuck on its own question", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* TestClock.adjust("29 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* nudgesTo(fake, thread), 0);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* nudgesTo(fake, thread), 1);
      yield* kanban.tick;
      assert.strictEqual(yield* nudgesTo(fake, thread), 1);
      yield* Ref.update(fake.threads, (all) => {
        all.get(thread)!.stuck = true;
        return all;
      });
      yield* TestClock.adjust("31 minutes");
      yield* kanban.tick;
      assert.isTrue(fake.interrupted.includes(thread));
      assert.strictEqual(yield* nudgesTo(fake, thread), 1);
      yield* kanban.tick;
      assert.strictEqual(fake.interrupted.filter((id) => id === thread).length, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a 165-slot tick reuses one successful planning read per exact thread, only for that tick",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
        const kanban = yield* KanbanService.KanbanService;
        const store = yield* KanbanStore.KanbanStore;
        const ids: Array<ThreadId> = [];
        const cardIds: Array<KanbanCardId> = [];
        const boards = [];
        for (let b = 0; b < 3; b++) {
          const board = yield* kanban.ensureBoard({
            slug: `probe-${b}`,
            name: `Probe ${b}`,
            defaultProjectId: ProjectId.make("project-1"),
          });
          for (const pool of yield* store.pools(board.id)) {
            yield* kanban.setPool(board.id, pool.model, 0);
          }
          yield* kanban.setPool(board.id, board.defaultCardModel, 55);
          boards.push(board);
          const seed = yield* kanban.createCard(
            board.id,
            { title: `Seed ${b}`, prompt: `Seed ${b}`, description: "Fixture" },
            owner,
          );
          yield* kanban.dispatchNow;
          const template = (yield* kanban.card(seed.id)).card;
          const seedThread = template.activeThreadId!;
          assert.strictEqual(template.stage, "working");
          yield* setRunning(fake, seedThread, true);
          ids.push(seedThread);
          cardIds.push(seed.id);
          for (let i = 1; i < 55; i++) {
            const threadId = ThreadId.make(`fixture-${b}-${i}`);
            const cardId = KanbanCardId.make(`fixture-card-${b}-${i}`);
            yield* Ref.update(fake.threads, (all) => {
              all.set(threadId, {
                title: `Worker ${b}-${i}`,
                model: board.defaultCardModel,
                messages: [],
                running: true,
                archived: false,
              });
              return all;
            });
            yield* store.putCard({
              ...template,
              id: cardId,
              number: i + 1,
              activeThreadId: threadId,
              workThreadId: threadId,
            });
            ids.push(threadId);
            cardIds.push(cardId);
          }
          // Five additional cards share the first thread on each board.
          for (let i = 0; i < 5; i++) {
            const cardId = KanbanCardId.make(`fixture-carried-${b}-${i}`);
            yield* store.putCard({ ...template, id: cardId, number: 56 + i });
            cardIds.push(cardId);
          }
        }
        assert.strictEqual(ids.length, 165);
        assert.strictEqual(new Set(ids).size, 165);
        assert.strictEqual(cardIds.length, 180);
        let slots = 0;
        for (const board of boards) {
          slots += (yield* store.pools(board.id)).reduce((sum, pool) => sum + pool.slots, 0);
          assert.strictEqual((yield* store.cards(board.id)).length, 60);
        }
        assert.strictEqual(slots, 165);

        for (let tick = 1; tick <= 2; tick++) {
          fake.findCalls.length = 0;
          yield* kanban.tick;
          const counts = new Map(ids.map((id) => [id, 0]));
          for (const id of fake.findCalls) counts.set(id, (counts.get(id) ?? 0) + 1);
          assert.strictEqual(fake.findCalls.length, 165, `tick ${tick} actual find calls`);
          assert.strictEqual(counts.size, 165);
          for (const id of ids) assert.strictEqual(counts.get(id), 1, `${id}, tick ${tick}`);
        }
        for (const board of boards) {
          const cards = yield* store.cards(board.id);
          assert.isTrue(cards.every((card) => card.stage === "working" && card.nudgedAt === null));
        }
        assert.strictEqual(fake.sends.length, 0);
        assert.deepStrictEqual(fake.interrupted, []);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("failed planning and confirmation reads are not cached or counted as missing", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const store = yield* KanbanStore.KanbanStore;
      const first = yield* kanban.createCard(board.id, { title: "A", prompt: "A" }, owner);
      yield* kanban.dispatchNow;
      const active = (yield* kanban.card(first.id)).card;
      const thread = active.activeThreadId!;
      const secondId = KanbanCardId.make("shared-failure-card");
      yield* store.putCard({ ...active, id: secondId, number: active.number + 1 });
      yield* setRunning(fake, thread, true);
      yield* kanban.setPool(board.id, board.defaultCardModel, 0);
      const intact = Effect.gen(function* () {
        for (const id of [first.id, secondId]) {
          const card = (yield* kanban.card(id)).card;
          assert.strictEqual(card.stage, "working");
          assert.strictEqual(card.activeThreadId, thread);
        }
      });
      const error = () => new KanbanThreadError({ operation: "view", detail: "transient" });

      // A second card gets a new read after the first planning read fails.
      fake.findCalls.length = 0;
      fake.findControl.beforeRead = (id, attempt) =>
        id === thread && attempt === 1 ? Effect.fail(error()) : Effect.void;
      yield* kanban.tick;
      assert.strictEqual(fake.findCalls.filter((id) => id === thread).length, 2);
      yield* intact;

      // The first confirmed absence is not enough to release either card.
      delete fake.findControl.beforeRead;
      yield* Ref.update(fake.threads, (all) => {
        all.delete(thread);
        return all;
      });
      fake.findCalls.length = 0;
      yield* kanban.tick;
      assert.isAtLeast(fake.findCalls.filter((id) => id === thread).length, 2);
      yield* intact;

      // The confirming read fails in what would have been the second missing tick.
      fake.findCalls.length = 0;
      fake.findControl.beforeRead = (id, attempt) =>
        id === thread && attempt === 2 ? Effect.fail(error()) : Effect.void;
      yield* kanban.tick;
      assert.isAtLeast(fake.findCalls.filter((id) => id === thread).length, 2);
      yield* intact;

      // Two new confirmed missing ticks, not one, are required after the error.
      delete fake.findControl.beforeRead;
      fake.findCalls.length = 0;
      yield* kanban.tick;
      assert.isAtLeast(fake.findCalls.filter((id) => id === thread).length, 2);
      yield* intact;
      fake.findCalls.length = 0;
      yield* kanban.tick;
      assert.isAtLeast(fake.findCalls.filter((id) => id === thread).length, 2);
      for (const id of [first.id, secondId]) {
        const detail = yield* kanban.card(id);
        assert.strictEqual(detail.card.stage, "todo");
        assert.isNull(detail.card.activeThreadId);
        assert.isNull(detail.card.workThreadId);
        assert.isTrue(detail.events.some((event) => event.body === "Its thread is gone"));
      }
      assert.deepStrictEqual(fake.interrupted, []);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect.each([false, true])(
  "a worker that resumes after planning is left alone (initially stuck: %s)",
  (initiallyStuck) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
        const { kanban, board } = yield* toyBoard;
        const card = yield* kanban.createCard(board.id, { title: "A", prompt: "A" }, owner);
        yield* kanban.dispatchNow;
        const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
        const state = (yield* Ref.get(fake.threads)).get(thread)!;
        state.stuck = initiallyStuck;
        const before = [...state.messages];
        yield* TestClock.adjust("31 minutes");
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        fake.findCalls.length = 0;
        fake.findControl.beforeRead = (id, attempt) =>
          id === thread && attempt === 2
            ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void;
        const tick = yield* Effect.forkChild(kanban.tick);
        yield* Deferred.await(reached);
        state.stuck = false;
        state.running = true;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(tick);
        assert.strictEqual(fake.findCalls.filter((id) => id === thread).length, 2);
        const after = (yield* kanban.card(card.id)).card;
        assert.strictEqual(after.stage, "working");
        assert.strictEqual(after.activeThreadId, thread);
        assert.isNull(after.nudgedAt);
        assert.deepStrictEqual(state.messages, before);
        assert.deepStrictEqual(fake.interrupted, []);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a worker nudge invalidates its shell observation before another carried card", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const store = yield* KanbanStore.KanbanStore;
      const first = yield* kanban.createCard(board.id, { title: "A", prompt: "A" }, owner);
      yield* kanban.dispatchNow;
      const active = (yield* kanban.card(first.id)).card;
      const thread = active.activeThreadId!;
      const secondId = KanbanCardId.make("shared-nudge-card");
      yield* store.putCard({ ...active, id: secondId, number: active.number + 1 });
      const state = (yield* Ref.get(fake.threads)).get(thread)!;
      const before = [...state.messages];
      fake.sendControl.afterSend = (id) => {
        if (id === thread) state.running = true;
      };
      yield* TestClock.adjust("31 minutes");
      fake.findCalls.length = 0;
      yield* kanban.tick;
      assert.strictEqual(fake.findCalls.filter((id) => id === thread).length, 3);
      assert.strictEqual(yield* nudgesTo(fake, thread), 1);
      assert.strictEqual(state.messages.length, before.length + 1);
      assert.isNotNull((yield* kanban.card(first.id)).card.nudgedAt);
      const second = (yield* kanban.card(secondId)).card;
      assert.strictEqual(second.stage, "working");
      assert.strictEqual(second.activeThreadId, thread);
      assert.isNull(second.nudgedAt);
      assert.deepStrictEqual(fake.interrupted, []);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "the tick interrupts a worker stuck on its own question even while the shell's updatedAt keeps moving",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
        const { kanban, board } = yield* toyBoard;
        const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
        yield* kanban.dispatchNow;
        const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
        yield* Ref.update(fake.threads, (all) => {
          all.get(thread)!.stuck = true;
          all.get(thread)!.quietSince = "2026-10-25T13:00:00.000Z";
          return all;
        });
        yield* TestClock.adjust("31 minutes");
        yield* kanban.tick;
        assert.isTrue(fake.interrupted.includes(thread));
        const events = (yield* kanban.card(card.id)).events;
        assert.isTrue(
          events.some(
            (event) =>
              event.kind === "thread" && event.body === "Interrupted: stuck on its own question",
          ),
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a thread stuck on its own question shows as needing input, not running", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const entryOf = Effect.map(kanban.snapshot(board.id), (snapshot) =>
        snapshot.threads.find((entry) => entry.threadId === thread)!,
      );
      yield* Ref.update(fake.threads, (all) => {
        all.get(thread)!.stuck = true;
        return all;
      });
      const stuck = yield* entryOf;
      assert.isFalse(stuck.running);
      assert.isTrue(stuck.needsInput);
      yield* Ref.update(fake.threads, (all) => {
        all.get(thread)!.stuck = false;
        return all;
      });
      yield* setRunning(fake, thread, true);
      const busy = yield* entryOf;
      assert.isTrue(busy.running);
      assert.isFalse(busy.needsInput);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("announces a mid-turn question so the board stops showing the thread as running", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const stuckAnnounced = Stream.runHead(
        Stream.filter(
          yield* kanban.changes,
          ({ change }) =>
            change._tag === "thread" &&
            change.thread.threadId === thread &&
            change.thread.needsInput === true,
        ),
      );
      yield* Ref.update(fake.threads, (all) => {
        all.get(thread)!.stuck = true;
        return all;
      });
      yield* kanban.notifyThreadChanged(thread);
      const announced = yield* stuckAnnounced;
      assert.isTrue(Option.isSome(announced));
      if (Option.isSome(announced) && announced.value.change._tag === "thread") {
        assert.isFalse(announced.value.change.thread.running);
      }

      // Answering the question clears the ask glyph on the next change.
      const resumed = Stream.runHead(
        Stream.filter(
          yield* kanban.changes,
          ({ change }) =>
            change._tag === "thread" &&
            change.thread.threadId === thread &&
            change.thread.needsInput === false &&
            change.thread.running === true,
        ),
      );
      yield* Ref.update(fake.threads, (all) => {
        all.get(thread)!.stuck = false;
        return all;
      });
      yield* setRunning(fake, thread, true);
      yield* kanban.notifyThreadChanged(thread);
      assert.isTrue(Option.isSome(yield* resumed));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a work thread's own cards are the ones it took and still has", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      const self: KanbanActor = { _tag: "thread", threadId: thread };
      yield* setRunning(fake, thread, true);
      const second = yield* kanban.createForThread(thread, { prompt: "B", title: "B" });
      const ids = (cards: ReadonlyArray<{ readonly id: string }>) => cards.map((c) => c.id);

      // Pulled back to todo while the thread goes on: it starts fresh, no longer this thread's.
      yield* kanban.moveCard(first.id, "todo", "owner", owner);
      assert.deepStrictEqual(ids(yield* kanban.ownCards(thread)), [second.card.id]);

      // The other waits on the owner: nothing is active, it is still the thread's own.
      yield* kanban.moveCard(second.card.id, "needs_owner", "cardThread", self, {
        question: "Which?",
      });
      assert.deepStrictEqual(ids(yield* kanban.carried(thread)), []);
      assert.deepStrictEqual(ids(yield* kanban.ownCards(thread)), [second.card.id]);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a weighted card starts on the next model when the top one is full, and keeps it", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const opus = board.defaultCardModel;
      const haiku = { instanceId: opus.instanceId, model: "opus/cc/claude-haiku-5-5" };
      for (const pool of (yield* kanban.snapshot(board.id)).pools) {
        yield* kanban.setPool(board.id, pool.model, 0);
      }
      yield* kanban.setPool(board.id, opus, 1);
      yield* kanban.setPool(board.id, haiku, 1);

      const refused = yield* kanban
        .createCard(
          board.id,
          {
            prompt: "x",
            models: [
              { model: opus, weight: 1 },
              { model: opus, weight: 2 },
            ],
          },
          owner,
        )
        .pipe(Effect.flip);
      assert.include(refused.detail, "listed twice");

      const first = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const weighted = yield* kanban.createCard(
        board.id,
        {
          prompt: "B",
          title: "B",
          models: [
            { model: haiku, weight: 20 },
            { model: opus, weight: 60 },
          ],
        },
        owner,
      );
      // Highest weight first, and the card names the model it would start on.
      assert.deepStrictEqual(
        weighted.models.map((entry) => entry.weight),
        [60, 20],
      );
      assert.strictEqual(weighted.model.model, opus.model);

      yield* kanban.dispatchNow;
      const started = (yield* kanban.card(weighted.id)).card;
      assert.strictEqual((yield* kanban.card(first.id)).card.stage, "working");
      assert.strictEqual(started.stage, "working");
      assert.strictEqual(started.model.model, haiku.model);
      const thread = [...(yield* Ref.get(fake.threads)).values()].find(
        (entry) => entry.model.model === haiku.model,
      );
      assert.isDefined(thread);

      // One model on edit clears the list.
      const single = yield* kanban.editCard(weighted.id, { model: opus }, owner);
      assert.deepStrictEqual(single.models, []);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("only the owner answers a card waiting on him; a script post leaves it waiting", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* kanban.moveCard(
        card.id,
        "needs_owner",
        "cardThread",
        { _tag: "thread", threadId: thread },
        { question: "Which fee?" },
      );
      const discussion = yield* kanban.cardDiscussion(card.id);

      yield* kanban.post(discussion.id, { _tag: "script", scriptId: "script-1" as never }, [
        { _tag: "md", text: "Fees are 2%" },
      ]);
      const waiting = (yield* kanban.card(card.id)).card;
      assert.strictEqual(waiting.stage, "needs_owner");
      assert.strictEqual(waiting.question, "Which fee?");

      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Use 2%" }]);
      const answered = (yield* kanban.card(card.id)).card;
      assert.notStrictEqual(answered.stage, "needs_owner");
      assert.include(answered.wakeNote ?? "", "Use 2%");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "an owner's answer to an evaluator's question goes to the evaluator, not the worker",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
        const card = yield* kanban.createCard(
          board.id,
          {
            prompt: "Fix the fee",
            title: "Fee",
            subtasks: [
              { text: "Write the PR", owner: "work" },
              { text: "Tell the reporter", owner: "evaluator" },
            ],
          },
          evaluator,
        );
        yield* kanban.dispatchNow;
        const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
        const worker: KanbanActor = { _tag: "thread", threadId: workThread };
        yield* kanban.markSubtask(card.id, "s1", "done", "PR #4", worker, "work");
        yield* kanban.moveCard(card.id, "completed", "owner", owner);
        yield* kanban.moveCard(card.id, "needs_owner", "evaluator", evaluator, {
          question: "Post this to the reporter?",
        });
        const discussion = yield* kanban.cardDiscussion(card.id);
        yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Yes, post it" }]);
        const answered = (yield* kanban.card(card.id)).card;
        assert.strictEqual(answered.stage, "completed");
        assert.isNull(answered.question);
        assert.isNull(answered.wakeNote);
        const all = yield* Ref.get(fake.threads);
        assert.notInclude(all.get(workThread)!.messages.join("\n"), "Yes, post it");
        const evaluators = [...all.entries()].filter(([id]) => id !== workThread);
        assert.isTrue(
          evaluators.some(([, thread]) =>
            thread.messages.some((text) => text.includes("Yes, post it")),
          ),
        );
        yield* kanban.dispatchNow;
        assert.isNull((yield* kanban.card(card.id)).card.activeThreadId);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a card follows its subtasks: work, review, the evaluator's step, then work again", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      // Room for the work thread to keep its slot while a reviewer runs.
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Fix the fee",
          title: "Fee",
          subtasks: [
            { text: "Write the PR", owner: "work" },
            { text: "Review", owner: "review" },
            { text: "Merge and deploy", owner: "evaluator" },
            { text: "Tell the reporter", owner: "evaluator", step: 3 },
            { text: "Follow-up fix", owner: "work" },
          ],
        },
        evaluator,
      );
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId: workThread };

      const early = yield* kanban
        .moveCard(card.id, "needs_review", "cardThread", worker)
        .pipe(Effect.flip);
      assert.include(early.detail, "s1");
      const notYours = yield* kanban
        .markSubtask(card.id, "s3", "done", null, worker, "work")
        .pipe(Effect.flip);
      assert.include(notYours.detail, "evaluator");

      yield* kanban.markSubtask(card.id, "s1", "done", "PR #4", worker, "work");
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
      yield* kanban.dispatchNow;
      const reviewThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* kanban.reviewResult(reviewThread, "clear", []);
      let current = (yield* kanban.card(card.id)).card;
      assert.strictEqual(current.subtasks.find((s) => s.id === "s2")?.state, "done");
      assert.strictEqual(current.stage, "completed");

      // The step is the evaluator's alone: an evaluator is told, and the card
      // can't be sent to a worker until that step is done.
      const told = [...(yield* Ref.get(fake.threads)).values()].filter((thread) =>
        thread.messages.some((text) => text.includes("waiting on your subtasks: s3, s4")),
      );
      assert.strictEqual(told.length, 1);
      const back = yield* kanban
        .moveCard(card.id, "todo", "evaluator", evaluator)
        .pipe(Effect.flip);
      assert.include(back.detail, "s3, s4");
      yield* kanban.dispatchNow;
      assert.isNull((yield* kanban.card(card.id)).card.activeThreadId);
      const verified = yield* kanban
        .moveCard(card.id, "verified", "evaluator", evaluator)
        .pipe(Effect.flip);
      assert.include(verified.detail, "s3");

      yield* kanban.markSubtask(card.id, "s3", "done", "deployed", evaluator, "evaluator");
      yield* kanban.markSubtask(card.id, "s4", "skipped", "no reporter", evaluator, "evaluator");
      yield* kanban.dispatchNow;
      current = (yield* kanban.card(card.id)).card;
      assert.strictEqual(current.stage, "working");
      assert.strictEqual(current.activeThreadId, workThread);
      const messages = (yield* Ref.get(fake.threads)).get(workThread)!.messages;
      assert.include(messages.at(-1) ?? "", "Follow-up fix");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a passed review hands the card back to its worker when the next step is work", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      // Room for the work thread to keep its slot while a reviewer runs.
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Two parts",
          title: "Two parts",
          subtasks: [
            { text: "Part one", owner: "work" },
            { text: "Review one", owner: "review" },
            { text: "Part two", owner: "work" },
          ],
        },
        owner,
      );
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId: workThread };
      yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
      yield* kanban.dispatchNow;
      const reviewThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* kanban.reviewResult(reviewThread, "clear", []);
      const back = (yield* kanban.card(card.id)).card;
      assert.strictEqual(back.stage, "todo");
      assert.include(back.wakeNote ?? "", "Part two");
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(card.id)).card.activeThreadId, workThread);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "an evaluator's second card with the same source link is refused while the first is open",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
        const links = [{ url: "file:///tmp/packet-00.md" }];
        const first = yield* kanban.createCard(
          board.id,
          { prompt: "Fix one", title: "Fix one", links },
          evaluator,
        );
        const refused = yield* kanban
          .createCard(board.id, { prompt: "Fix two", title: "Fix two", links }, evaluator)
          .pipe(Effect.flip);
        assert.strictEqual(refused.code, "conflict");
        assert.include(refused.detail, `card #${first.number}`);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a same title, different case and spacing, is refused for an evaluator", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      yield* kanban.createCard(board.id, { prompt: "A", title: "Fix the fanout" }, evaluator);
      const refused = yield* kanban
        .createCard(board.id, { prompt: "B", title: "  fix   THE fanout " }, evaluator)
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "conflict");
      assert.include(refused.detail, "same title");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a card with no title is refused when its fallback title matches an open card", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      yield* kanban.createCard(board.id, { prompt: "A", title: "Fix the fanout" }, evaluator);
      const refused = yield* kanban
        .createCard(board.id, { prompt: "  fix   THE fanout " }, evaluator)
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "conflict");
      assert.include(refused.detail, "same title");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the same title is allowed once the first card is verified", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const first = yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "Fix the fanout" },
        evaluator,
      );
      yield* kanban.moveCard(first.id, "verified", "owner", owner);
      const second = yield* kanban.createCard(
        board.id,
        { prompt: "B", title: "Fix the fanout" },
        evaluator,
      );
      assert.notStrictEqual(second.id, first.id);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("shared t3-context and PR links don't count as a twin", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const links = [
        { url: "t3-context://v1/kanban-card/card-parent" },
        { url: "https://github.com/acme/app/pull/12" },
        { url: "https://linear.app/acme/issue/ACM-1" },
      ];
      yield* kanban.createCard(board.id, { prompt: "A", title: "Follow-up one", links }, evaluator);
      const second = yield* kanban.createCard(
        board.id,
        { prompt: "B", title: "Follow-up two", links },
        evaluator,
      );
      assert.isString(second.id);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the owner can still create a twin", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const links = [{ url: "file:///tmp/packet-00.md" }];
      yield* kanban.createCard(board.id, { prompt: "A", title: "Same", links }, owner);
      const twin = yield* kanban.createCard(board.id, { prompt: "B", title: "Same", links }, owner);
      assert.isString(twin.id);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a thread's new card waits for an evaluator's packet; the owner's goes straight on", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      const thread: KanbanActor = { _tag: "thread", threadId: ThreadId.make("worker-1") };
      const noted = yield* kanban.createCard(
        board.id,
        {
          prompt: "Retry the fee job",
          title: "Retry",
          subtasks: [
            { text: "Fix it", owner: "work" },
            { text: "Tell QA", owner: "evaluator", step: 2 },
          ],
        },
        thread,
      );
      assert.deepStrictEqual(
        noted.subtasks.map((subtask) => [subtask.id, subtask.step, subtask.owner]),
        [
          ["s1", 1, "evaluator"],
          ["s2", 2, "work"],
          ["s3", 3, "evaluator"],
        ],
      );
      const told = [...(yield* Ref.get(fake.threads)).values()].filter((view) =>
        view.messages.some((text) => text.includes("waiting on your subtasks: s1")),
      );
      assert.strictEqual(told.length, 1);

      const owners = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
      assert.deepStrictEqual(owners.subtasks, []);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(owners.id)).card.stage, "working");
      assert.strictEqual((yield* kanban.card(noted.id)).card.stage, "todo");
      assert.isNull((yield* kanban.card(noted.id)).card.activeThreadId);

      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      yield* kanban.editCard(
        noted.id,
        { prompt: "Packet: retry with backoff in fees.ts" },
        evaluator,
      );
      yield* kanban.markSubtask(noted.id, "s1", "done", null, evaluator, "evaluator");
      yield* kanban.dispatchNow;
      const started = (yield* kanban.card(noted.id)).card;
      assert.strictEqual(started.stage, "working");
      const messages = (yield* Ref.get(fake.threads)).get(started.activeThreadId!)!.messages;
      assert.include(messages[0] ?? "", "retry with backoff");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("links come off by URL, and both together replace one", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const A = "https://github.com/o/r/pull/1";
      const B = "https://github.com/o/r/pull/2";
      const C = "https://github.com/o/r/pull/3";
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Links", title: "Links", links: [{ url: A }, { url: B }] },
        owner,
      );
      const afterRemove = yield* kanban.editCard(created.id, { removeLinks: [A] }, owner);
      assert.deepStrictEqual(
        afterRemove.links.map((link) => link.url),
        [B],
      );
      const replaced = yield* kanban.editCard(
        created.id,
        { removeLinks: [B], links: [{ url: C }] },
        owner,
      );
      assert.deepStrictEqual(
        replaced.links.map((link) => link.url),
        [C],
      );
      const refused = yield* kanban
        .editCard(created.id, { removeLinks: ["https://example.com/nope"] }, owner)
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "invalid");
      const unchanged = (yield* kanban.card(created.id)).card;
      assert.deepStrictEqual(
        unchanged.links.map((link) => link.url),
        [C],
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a context PR doesn't hold a reviewed card once its own PR lands", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const plan = [
        { text: "Write the PR", owner: "work" as const },
        { text: "Review", owner: "review" as const },
      ];
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "Context", title: "Context", subtasks: plan },
        evaluator,
      );
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const pr = "https://github.com/o/r/pull/50";
      const contract = "https://github.com/o/broker/pull/62";
      fake.prs.set(workThread, [{ url: pr, title: "Own", state: "open" }]);
      const worker: KanbanActor = { _tag: "thread", threadId: workThread };
      yield* kanban.editCard(card.id, { links: [{ url: contract, label: "contract" }] }, evaluator);
      yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
      yield* kanban.dispatchNow;
      yield* kanban.reviewResult((yield* kanban.card(card.id)).card.activeThreadId!, "clear", []);
      assert.strictEqual((yield* kanban.card(card.id)).card.stage, "in_review");
      fake.prs.set(workThread, [{ url: pr, title: "Own", state: "merged" }]);
      yield* kanban.tick;
      assert.strictEqual((yield* kanban.card(card.id)).card.stage, "completed");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an evaluator hears once when a reviewed card waits on it for its PRs", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const plan = [
        { text: "Write the PR", owner: "work" as const },
        { text: "Review", owner: "review" as const },
        { text: "Merge it", owner: "evaluator" as const },
        { text: "Follow-up", owner: "work" as const },
      ];
      const reviewed = Effect.fn(function* (title: string) {
        const card = yield* kanban.createCard(
          board.id,
          { prompt: title, title, subtasks: plan },
          evaluator,
        );
        yield* kanban.dispatchNow;
        const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
        const pr = `https://github.com/o/r/pull/${card.number}`;
        fake.prs.set(workThread, [{ url: pr, title, state: "open" }]);
        const worker: KanbanActor = { _tag: "thread", threadId: workThread };
        yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
        yield* kanban.dispatchNow;
        yield* kanban.reviewResult((yield* kanban.card(card.id)).card.activeThreadId!, "clear", []);
        return { card: (yield* kanban.card(card.id)).card, workThread, pr };
      });
      const toldAbout = Effect.fn(function* (number: number) {
        const texts = [...(yield* Ref.get(fake.threads)).values()].flatMap(
          (thread) => thread.messages,
        );
        return texts.filter((text) => text.includes(`Card #${number} (`)).length;
      });

      // Merged by the evaluator while it waits in review: back to its worker.
      const first = yield* reviewed("First");
      assert.strictEqual(first.card.stage, "in_review");
      assert.isNull(first.card.activeThreadId);
      assert.strictEqual(yield* toldAbout(first.card.number), 1);
      const discussion = yield* kanban.cardDiscussion(first.card.id);
      assert.isTrue(
        discussion.participants.every((participant) => participant.owes === null),
        "a step note owes no reply",
      );
      yield* kanban.markSubtask(first.card.id, "s3", "done", "merged", evaluator, "evaluator");
      const back = (yield* kanban.card(first.card.id)).card;
      assert.strictEqual(back.stage, "todo");
      assert.include(back.wakeNote ?? "", "Follow-up");

      // Its PR lands on its own: completed, and the evaluator isn't told twice.
      const second = yield* reviewed("Second");
      fake.prs.set(second.workThread, [{ url: second.pr, title: "Second", state: "merged" }]);
      yield* kanban.tick;
      assert.strictEqual((yield* kanban.card(second.card.id)).card.stage, "completed");
      assert.strictEqual(yield* toldAbout(second.card.number), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "another evaluator's change that hands a card's step to its evaluator wakes it once",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        yield* kanban.setPool(board.id, board.defaultCardModel, 8);
        const owner: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
        const other: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval-other") };
        const reviewed = Effect.fn(function* (
          title: string,
          plan: ReadonlyArray<{
            text: string;
            owner: "work" | "review" | "evaluator";
            step?: number;
          }>,
        ) {
          const card = yield* kanban.createCard(
            board.id,
            { prompt: title, title, subtasks: plan },
            owner,
          );
          yield* kanban.dispatchNow;
          const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
          const pr = `https://github.com/o/r/pull/${card.number}`;
          fake.prs.set(workThread, [{ url: pr, title, state: "open" }]);
          const worker: KanbanActor = { _tag: "thread", threadId: workThread };
          yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
          yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
          yield* kanban.dispatchNow;
          yield* kanban.reviewResult(
            (yield* kanban.card(card.id)).card.activeThreadId!,
            "clear",
            [],
          );
          return (yield* kanban.card(card.id)).card;
        });
        const notes = Effect.fn(function* (threadId: string, ids: string) {
          const thread = (yield* Ref.get(fake.threads)).get(threadId);
          return (thread?.messages ?? []).filter((text) =>
            text.includes(`waiting on your subtasks: ${ids}`),
          ).length;
        });
        const evaluators = Effect.fn(function* () {
          return [...(yield* Ref.get(fake.threads)).values()].filter((thread) =>
            thread.title.startsWith("Evaluator:"),
          ).length;
        });
        const planAB = [
          { text: "Write the PR", owner: "work" as const },
          { text: "Review", owner: "review" as const },
          { text: "Astra gate", owner: "evaluator" as const },
          { text: "Act on the verdict", owner: "evaluator" as const },
        ];

        // A: the other evaluator finishes the gate: the discussion's evaluator hears the next step, not started.
        const a = yield* reviewed("A", planAB);
        const ownA = (yield* kanban.cardDiscussion(a.id)).evaluatorThreadId!;
        assert.strictEqual(yield* notes(ownA, "s3"), 1);
        const before = yield* evaluators();
        yield* kanban.markSubtask(a.id, "s3", "done", "gate passed", other, "evaluator");
        assert.strictEqual(yield* notes(ownA, "s4"), 1);
        const told = [...(yield* Ref.get(fake.threads)).get(ownA)!.messages].pop() ?? "";
        assert.include(told, "Another evaluator");
        assert.strictEqual(yield* evaluators(), before);

        // B: the card's own evaluator's change needs no note.
        const b = yield* reviewed("B", planAB);
        const ownB = (yield* kanban.cardDiscussion(b.id)).evaluatorThreadId!;
        yield* kanban.markSubtask(
          b.id,
          "s3",
          "done",
          "gate passed",
          { _tag: "evaluator", threadId: ThreadId.make(ownB) },
          "evaluator",
        );
        assert.strictEqual(yield* notes(ownB, "s4"), 0);

        // C: a step with two evaluator gates: the other evaluator finishing one does not re-wake; the next step does.
        const planC = [
          { text: "Write the PR", owner: "work" as const },
          { text: "Review", owner: "review" as const },
          { text: "Gate A", owner: "evaluator" as const, step: 3 },
          { text: "Gate B", owner: "evaluator" as const, step: 3 },
          { text: "Act", owner: "evaluator" as const },
        ];
        const c = yield* reviewed("C", planC);
        const ownC = (yield* kanban.cardDiscussion(c.id)).evaluatorThreadId!;
        const waitingC = (yield* Ref.get(fake.threads))
          .get(ownC)!
          .messages.filter((text) => text.includes("waiting on your subtasks")).length;
        yield* kanban.markSubtask(c.id, "s3", "done", "A", other, "evaluator");
        const waitingAfterA = (yield* Ref.get(fake.threads))
          .get(ownC)!
          .messages.filter((text) => text.includes("waiting on your subtasks")).length;
        assert.strictEqual(waitingAfterA, waitingC);
        yield* kanban.markSubtask(c.id, "s4", "done", "B", other, "evaluator");
        assert.strictEqual(yield* notes(ownC, "s5"), 1);

        // D: card_edit by another evaluator that hands the card its step.
        const d = yield* reviewed("D", [
          { text: "Write the PR", owner: "work" as const },
          { text: "Review", owner: "review" as const },
          { text: "Merge", owner: "evaluator" as const },
        ]);
        const ownD = (yield* kanban.cardDiscussion(d.id)).evaluatorThreadId!;
        yield* kanban.editCard(
          d.id,
          {
            subtasks: [
              { id: "s1", text: "Write the PR", owner: "work" },
              { id: "s2", text: "Review", owner: "review" },
              { text: "Merge after the Astra gate", owner: "evaluator" },
            ],
          },
          other,
        );
        assert.strictEqual(yield* notes(ownD, "s4"), 1);

        // E: no discussion, so nothing starts.
        const eCard = yield* kanban.createCard(
          board.id,
          {
            prompt: "Gate",
            title: "Gate",
            subtasks: [
              { text: "Gate", owner: "evaluator" as const },
              { text: "Act", owner: "evaluator" as const },
            ],
          },
          owner,
        );
        const threadsBefore = (yield* Ref.get(fake.threads)).size;
        yield* kanban.markSubtask(eCard.id, "s1", "done", null, other, "evaluator");
        assert.strictEqual((yield* kanban.card(eCard.id)).card.discussionId, null);
        assert.strictEqual((yield* Ref.get(fake.threads)).size, threadsBefore);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "an owner's answer sends a reviewed card back to waiting, a mid-review one to review",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        yield* kanban.setPool(board.id, board.defaultCardModel, 3);
        const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
        const created = yield* kanban.createCard(
          board.id,
          {
            prompt: "Fee rounding",
            title: "Fee rounding",
            reviewChain: "Critical",
            subtasks: [
              { text: "Write the PR", owner: "work" },
              { text: "Review", owner: "review" },
              { text: "Merge and release", owner: "evaluator" },
            ],
          },
          evaluator,
        );
        yield* kanban.dispatchNow;
        const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
        fake.prs.set(workThread, [
          { url: "https://github.com/o/r/pull/9", title: "PR", state: "open" },
        ]);
        const worker: KanbanActor = { _tag: "thread", threadId: workThread };
        yield* kanban.markSubtask(created.id, "s1", "done", null, worker, "work");
        yield* kanban.moveCard(created.id, "needs_review", "cardThread", worker);
        yield* kanban.dispatchNow;
        const reviewThread = (yield* kanban.card(created.id)).card.activeThreadId!;
        yield* kanban.reviewResult(reviewThread, "clear", []);
        yield* kanban.dispatchNow;

        // Asked mid-review (step 2 running): the answer reruns that step.
        const midway = yield* kanban.askOwner(
          created.id,
          { question: "Hold the release?", blocking: true, options: ["Yes", "No"] },
          evaluator,
          "evaluator",
        );
        assert.strictEqual(midway.stage, "needs_owner");
        assert.strictEqual(midway.reviewStep, 1);
        let talk = yield* kanban.cardDiscussion(created.id);
        yield* kanban.answer(
          talk.id,
          midway.asks.at(-1)!.seq!,
          midway.asks.at(-1)!.id,
          ["o2"],
          owner,
        );
        assert.strictEqual((yield* kanban.card(created.id)).card.stage, "needs_review");
        yield* kanban.dispatchNow;
        const rerun = (yield* kanban.card(created.id)).card;
        assert.strictEqual(rerun.stage, "in_review");
        assert.isNotNull(rerun.activeThreadId);
        yield* kanban.reviewResult(rerun.activeThreadId!, "clear", []);
        const reviewed = (yield* kanban.card(created.id)).card;
        assert.strictEqual(reviewed.stage, "in_review");
        assert.isNull(reviewed.activeThreadId);
        assert.strictEqual(reviewed.reviewStep, 2);

        // Asked after the chain passed: the answer leaves it waiting, no reviewer woken.
        const reviewMessages = (yield* Ref.get(fake.threads)).get(reviewThread)!.messages.length;
        const waiting = yield* kanban.askOwner(
          created.id,
          { question: "Release it?", blocking: true, options: ["Ship it", "Hold"] },
          evaluator,
          "evaluator",
        );
        assert.strictEqual(waiting.stage, "needs_owner");
        talk = yield* kanban.cardDiscussion(created.id);
        yield* kanban.answer(
          talk.id,
          waiting.asks.at(-1)!.seq!,
          waiting.asks.at(-1)!.id,
          ["o1"],
          owner,
        );
        yield* kanban.dispatchNow;
        const back = (yield* kanban.card(created.id)).card;
        assert.strictEqual(back.stage, "in_review");
        assert.isNull(back.activeThreadId);
        assert.strictEqual(back.reviewStep, 2);
        assert.strictEqual(
          (yield* Ref.get(fake.threads)).get(reviewThread)!.messages.length,
          reviewMessages,
          "the reviewer isn't woken for a step it passed",
        );
        const others = [...(yield* Ref.get(fake.threads)).entries()].filter(
          ([id]) => id !== workThread && id !== reviewThread,
        );
        assert.isTrue(
          others.some(([, thread]) => thread.messages.some((text) => text.includes("Ship it"))),
          "the evaluator hears the answer",
        );

        // Its PR lands: the evaluator's step is next.
        fake.prs.set(workThread, [
          { url: "https://github.com/o/r/pull/9", title: "PR", state: "merged" },
        ]);
        yield* kanban.tick;
        assert.strictEqual((yield* kanban.card(created.id)).card.stage, "completed");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("the owner's own question and a pick on an evaluator's go where they belong", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      // The owner parks a working card with a question; his reply wakes its worker.
      const mine = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      yield* kanban.moveCard(mine.id, "needs_owner", "owner", owner, { question: "Hold on" });
      const mineTalk = yield* kanban.cardDiscussion(mine.id);
      yield* kanban.post(mineTalk.id, owner, [{ _tag: "md", text: "Use 3%" }]);
      const woken = (yield* kanban.card(mine.id)).card;
      assert.strictEqual(woken.stage, "todo");
      assert.include(woken.wakeNote ?? "", "Use 3%");

      // An evaluator's approval as a pick: the card goes back where it was.
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const theirs = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
      yield* kanban.moveCard(theirs.id, "completed", "owner", owner);
      yield* kanban.moveCard(theirs.id, "needs_owner", "evaluator", evaluator, {
        question: "Post it?",
      });
      const talk = yield* kanban.cardDiscussion(theirs.id);
      const asked = yield* kanban.post(talk.id, evaluator, [
        {
          _tag: "choice",
          id: "c1",
          style: "pick",
          question: "Post it?",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          multi: false,
        },
      ]);
      yield* kanban.answer(talk.id, asked.seq, "c1", ["yes"], owner);
      const answered = (yield* kanban.card(theirs.id)).card;
      assert.strictEqual(answered.stage, "completed");
      assert.isNull(answered.question);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an async ask lets the work go on; the owner's answer reaches the thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId };

      const asked = yield* kanban.askOwner(
        card.id,
        { question: "Which fee?", blocking: false },
        worker,
        "cardThread",
      );
      assert.strictEqual(asked.stage, "working");
      assert.strictEqual(asked.activeThreadId, threadId);
      assert.deepStrictEqual(
        asked.asks.map((ask) => [ask.id, ask.blocking, ask.closedAt]),
        [["q1", false, null]],
      );
      assert.isNotNull(asked.asks[0]!.seq);
      const counted = yield* kanban.boardSummaries.pipe(Stream.runHead);
      assert.strictEqual(Option.getOrThrow(counted)[0]!.needsOwner, 1);

      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Use 2%" }]);
      const answered = (yield* kanban.card(card.id)).card;
      assert.strictEqual(answered.stage, "working");
      assert.isNotNull(answered.asks[0]!.closedAt);
      const messages = (yield* Ref.get(fake.threads)).get(threadId)!.messages;
      assert.strictEqual(messages.filter((text) => text.includes("Use 2%")).length, 1);
      assert.deepStrictEqual(fake.interrupted, []);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the owner makes an ask blocking: the card waits, then wakes with his pick", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId };
      const asked = yield* kanban.askOwner(
        card.id,
        { question: "Ship tonight?", blocking: false, options: ["Yes", "No"] },
        worker,
        "cardThread",
      );

      const blocked = yield* kanban.changeAsk(card.id, "q1", "block", owner, "owner");
      assert.strictEqual(blocked.stage, "needs_owner");
      assert.strictEqual(blocked.question, "Ship tonight?");
      assert.isNull(blocked.activeThreadId);
      assert.strictEqual(blocked.workThreadId, threadId);
      assert.deepStrictEqual(
        blocked.asks.map((ask) => [ask.id, ask.blocking]),
        [["q1", true]],
      );
      assert.deepStrictEqual(fake.interrupted, [threadId]);

      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.answer(talk.id, asked.asks[0]!.seq!, "q1", ["o1"], owner);
      const woken = (yield* kanban.card(card.id)).card;
      assert.strictEqual(woken.stage, "todo");
      assert.include(woken.wakeNote ?? "", "Yes");
      assert.isNotNull(woken.asks[0]!.closedAt);
      yield* kanban.dispatchNow;
      const resumed = (yield* kanban.card(card.id)).card;
      assert.strictEqual(resumed.activeThreadId, threadId);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a multi ask posts a tick-several pick and wakes the card with every pick", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId };
      const talk = yield* kanban.cardDiscussion(card.id);

      // A plain pick (no multi) still posts a single pick.
      yield* kanban.askOwner(
        card.id,
        { question: "Pick one?", blocking: false, options: ["X", "Y"] },
        worker,
        "cardThread",
      );
      const single = yield* kanban.messages(talk.id);
      assert.deepStrictEqual(
        single.at(-1)?.blocks.map((b) => (b._tag === "choice" ? b.multi : null)),
        [false],
      );

      const asked = yield* kanban.askOwner(
        card.id,
        { question: "Which?", blocking: true, options: ["A", "B", "C"], multi: true },
        worker,
        "cardThread",
      );
      const posted = yield* kanban.messages(talk.id);
      assert.deepStrictEqual(
        posted.at(-1)?.blocks.map((b) => (b._tag === "choice" ? b.multi : null)),
        [true],
      );

      yield* kanban.answer(talk.id, asked.asks.at(-1)!.seq!, "q2", ["o1", "o3"], owner);
      const woken = (yield* kanban.card(card.id)).card;
      assert.strictEqual(woken.stage, "todo");
      assert.include(woken.wakeNote ?? "", "A");
      assert.include(woken.wakeNote ?? "", "C");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a blocked ask answered in his own words wakes the card with them", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId };
      const asked = yield* kanban.askOwner(
        card.id,
        { question: "Ship tonight?", blocking: false, options: ["Yes", "No"] },
        worker,
        "cardThread",
      );
      yield* kanban.changeAsk(card.id, "q1", "block", owner, "owner");

      const talk = yield* kanban.cardDiscussion(card.id);
      const answered = yield* kanban.answer(
        talk.id,
        asked.asks[0]!.seq!,
        "q1",
        [],
        owner,
        "Wait for Monday",
      );
      const ownAnswer = answered.answers.find((entry) => entry.by._tag === "owner");
      assert.deepStrictEqual(ownAnswer?.choice, []);
      assert.strictEqual(ownAnswer?.text, "Wait for Monday");
      const woken = (yield* kanban.card(card.id)).card;
      assert.strictEqual(woken.stage, "todo");
      assert.include(woken.wakeNote ?? "", "Wait for Monday");
      assert.isNotNull(woken.asks[0]!.closedAt);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an async ask answered in his own words reaches the working thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId };
      const asked = yield* kanban.askOwner(
        card.id,
        { question: "Ship tonight?", blocking: false, options: ["Yes", "No"] },
        worker,
        "cardThread",
      );

      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.answer(talk.id, asked.asks[0]!.seq!, "q1", [], owner, "Use 2%");
      const after = (yield* kanban.card(card.id)).card;
      assert.strictEqual(after.stage, "working");
      assert.isNotNull(after.asks[0]!.closedAt);
      const sent = (yield* Ref.get(fake.threads)).get(threadId)!.messages;
      assert.strictEqual(sent.filter((message) => message.includes("Use 2%")).length, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("own words are refused where they don't fit", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.moveCard(card.id, "completed", "owner", owner);
      const talk = yield* kanban.cardDiscussion(card.id);
      const poll = yield* kanban.post(talk.id, evaluator, [
        {
          _tag: "choice",
          id: "p1",
          style: "poll",
          question: "Which?",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          multi: false,
        },
      ]);
      const refused = yield* kanban
        .answer(talk.id, poll.seq, "p1", ["yes"], owner, "maybe")
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "invalid");

      const single = yield* kanban.post(talk.id, evaluator, [
        {
          _tag: "choice",
          id: "s1",
          style: "pick",
          question: "Ship?",
          options: [{ id: "yes", label: "Yes" }],
          multi: false,
        },
      ]);
      const both = yield* kanban
        .answer(talk.id, single.seq, "s1", ["yes"], owner, "maybe")
        .pipe(Effect.flip);
      assert.strictEqual(both.code, "invalid");
      const blank = yield* kanban
        .answer(talk.id, single.seq, "s1", [], owner, "   ")
        .pipe(Effect.flip);
      assert.strictEqual(blank.code, "invalid");

      const multi = yield* kanban.post(talk.id, evaluator, [
        {
          _tag: "choice",
          id: "m1",
          style: "pick",
          question: "Which?",
          options: [{ id: "a", label: "A" }],
          multi: true,
        },
      ]);
      const stored = yield* kanban.answer(talk.id, multi.seq, "m1", ["a"], owner, "and b");
      const answer = stored.answers.find((entry) => entry.blockId === "m1");
      assert.deepStrictEqual(answer?.choice, ["a"]);
      assert.strictEqual(answer?.text, "and b");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a dropped ask tells its asker; an evaluator's blocking ask goes back where it was", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId };
      yield* kanban.askOwner(card.id, { question: "Logo?", blocking: false }, worker, "cardThread");
      const dropped = yield* kanban.changeAsk(card.id, "q1", "drop", owner, "owner");
      assert.isNotNull(dropped.asks[0]!.closedAt);
      assert.strictEqual(dropped.stage, "working");
      const messages = (yield* Ref.get(fake.threads)).get(threadId)!.messages;
      assert.isTrue(messages.some((text) => text.includes("was dropped by the owner")));
      const gone = yield* kanban.changeAsk(card.id, "q1", "drop", owner, "owner").pipe(Effect.flip);
      assert.strictEqual(gone.code, "not-found");

      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const other = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
      yield* kanban.moveCard(other.id, "completed", "owner", owner);
      const waiting = yield* kanban.askOwner(
        other.id,
        { question: "Post it?", blocking: true, options: ["Approve", "Drop"] },
        evaluator,
        "evaluator",
      );
      assert.strictEqual(waiting.stage, "needs_owner");
      assert.strictEqual(waiting.asks.length, 1);
      const talk = yield* kanban.cardDiscussion(other.id);
      yield* kanban.answer(talk.id, waiting.asks[0]!.seq!, "q1", ["o1"], owner);
      const back = (yield* kanban.card(other.id)).card;
      assert.strictEqual(back.stage, "completed");
      assert.isNull(back.question);
      assert.isNotNull(back.asks[0]!.closedAt);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the worker's answer survives an evaluator's later blocking ask", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId };
      yield* kanban.askOwner(
        card.id,
        { question: "Which fee?", blocking: true },
        worker,
        "cardThread",
      );
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const both = yield* kanban.askOwner(
        card.id,
        { question: "Tell QA too?", blocking: true },
        evaluator,
        "evaluator",
      );
      assert.strictEqual(both.question, "Tell QA too?");

      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "2%, and yes" }]);
      const woken = (yield* kanban.card(card.id)).card;
      assert.strictEqual(woken.stage, "todo");
      assert.include(woken.wakeNote ?? "", "2%, and yes");
      assert.isTrue(woken.asks.every((ask) => ask.closedAt !== null));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the owner's answer to his own question frees a card that never ran", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.moveCard(card.id, "needs_owner", "owner", owner, {
        question: "Do we need this?",
      });
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Yes, go" }]);
      const freed = (yield* kanban.card(card.id)).card;
      assert.strictEqual(freed.stage, "todo");
      assert.isNull(freed.question);
      assert.isTrue(freed.asks.every((ask) => ask.closedAt !== null));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a late pick on a closed ask answers nothing else", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId };
      const first = yield* kanban.askOwner(
        card.id,
        { question: "Color?", blocking: false, options: ["Red", "Blue"] },
        worker,
        "cardThread",
      );
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Red" }]);
      yield* kanban.askOwner(
        card.id,
        { question: "Ship it?", blocking: true },
        worker,
        "cardThread",
      );

      yield* kanban.answer(talk.id, first.asks[0]!.seq!, "q1", ["o2"], owner);
      const still = (yield* kanban.card(card.id)).card;
      assert.strictEqual(still.stage, "needs_owner");
      assert.isNull(still.asks[1]!.closedAt);
      assert.strictEqual(still.question, "Ship it?");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("new cards from a script share one packets evaluator", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const thread: KanbanActor = { _tag: "thread", threadId: ThreadId.make("worker-1") };
      for (const title of ["A", "B", "C"]) {
        yield* kanban.createCard(board.id, { prompt: title, title }, thread);
      }
      const evaluators = [...(yield* Ref.get(fake.threads)).values()].filter(
        (view) => view.title === "Evaluator: packets",
      );
      assert.strictEqual(evaluators.length, 1);
      const texts = evaluators[0]!.messages;
      assert.strictEqual(
        texts.filter((text) => text.includes("waiting on your subtasks")).length,
        3,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a sweep gets its text, and a board runs one sweep of a kind at a time", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const stalled = yield* kanban.startEvaluator(board.id, { kind: "stalled" }, "Only card #7");
      const launched = (yield* Ref.get(fake.threads)).get(stalled)!;
      assert.include(launched.messages[0] ?? "", "Stalled sweep");
      assert.include(launched.messages[0] ?? "", "Only card #7");

      yield* setRunning(fake, stalled, true);
      const refused = yield* kanban
        .startEvaluator(board.id, { kind: "stalled" }, "Only card #8")
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "conflict");
      assert.include(refused.detail, stalled);
      assert.strictEqual((yield* Ref.get(fake.threads)).size, 1);

      yield* kanban.startEvaluator(board.id, { kind: "check" });
      assert.strictEqual((yield* Ref.get(fake.threads)).size, 2);

      yield* setRunning(fake, stalled, false);
      yield* kanban.startEvaluator(board.id, { kind: "stalled" }, "Only card #9");
      assert.strictEqual((yield* Ref.get(fake.threads)).size, 3);

      yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look at #7" });
      yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look at #7" });
      assert.strictEqual((yield* Ref.get(fake.threads)).size, 5);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the owner's reply in an evaluator's discussion goes to that evaluator", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const setup = yield* kanban.startEvaluator(board.id, {
        kind: "setup",
        text: "Set the board up",
      });
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: setup };

      const opened = yield* kanban.createDiscussion(board.id, "Setup", evaluator);
      assert.strictEqual(opened.evaluatorThreadId, setup);
      yield* kanban.post(opened.id, evaluator, [{ _tag: "md", text: "Here is the plan" }]);
      yield* kanban.post(opened.id, owner, [{ _tag: "md", text: "Sounds good" }]);

      const current = yield* kanban.discussion(opened.id);
      assert.strictEqual(current.evaluatorThreadId, setup);
      const all = [...(yield* Ref.get(fake.threads)).entries()];
      assert.strictEqual(all.filter(([, view]) => view.title.startsWith("Evaluator")).length, 1);
      assert.include(all.find(([id]) => id === setup)![1].messages.at(-1) ?? "", "Sounds good");

      // An owner's discussion with no evaluator yet belongs to the first one that speaks.
      const channel = yield* kanban.createDiscussion(board.id, "Later", owner);
      yield* kanban.post(channel.id, evaluator, [{ _tag: "md", text: "Picking this up" }]);
      assert.strictEqual((yield* kanban.discussion(channel.id)).evaluatorThreadId, setup);

      // A card's discussion keeps its own evaluator, which knows the card.
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const cardTalk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(cardTalk.id, evaluator, [{ _tag: "md", text: "A note on #1" }]);
      assert.isNull((yield* kanban.discussion(cardTalk.id)).evaluatorThreadId);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("pauses a board for kept cards, validates the request and lifts the hold", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const alreadyRunning = yield* kanban.createCard(board.id, { prompt: "Running" }, owner);
      yield* kanban.dispatchNow;
      const runningThread = (yield* kanban.card(alreadyRunning.id)).card.activeThreadId!;
      const kept = yield* kanban.createCard(board.id, { prompt: "Keep", title: "Keep" }, owner);
      const held = yield* kanban.createCard(board.id, { prompt: "Hold", title: "Hold" }, owner);
      const otherBoard = yield* kanban.ensureBoard({
        slug: "other",
        name: "Other",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const elsewhere = yield* kanban.createCard(otherBoard.id, { prompt: "Elsewhere" }, owner);
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("evaluator") };

      const changes = yield* kanban.changes;
      const paused = yield* kanban.pauseBoard(
        board.id,
        { reason: "  Ship first  ", keep: [kept.id] },
        evaluator,
      );
      assert.deepStrictEqual(paused.pause, {
        reason: "Ship first",
        keep: [kept.id],
        at: paused.pause!.at,
        by: "evaluator evaluator",
      });
      assert.strictEqual((yield* kanban.snapshot(board.id)).board.pause?.reason, "Ship first");
      const published = yield* Stream.runHead(
        Stream.filter(
          changes,
          ({ change }) => change._tag === "board" && change.board.pause !== null,
        ),
      );
      assert.isTrue(Option.isSome(published));
      assert.strictEqual(
        (yield* kanban.card(alreadyRunning.id)).card.activeThreadId,
        runningThread,
      );
      assert.notInclude(fake.interrupted, runningThread);
      const deniedSteer = yield* kanban
        .cardThread(alreadyRunning.id, "steer", "Resume work", owner)
        .pipe(Effect.flip);
      assert.include(deniedSteer.message, "the board is paused");
      const deniedWake = yield* kanban
        .cardThread(alreadyRunning.id, "wake", "Resume work", owner)
        .pipe(Effect.flip);
      assert.include(deniedWake.message, "the board is paused");
      yield* setRunning(fake, runningThread, true);
      const deniedRunningSteer = yield* kanban
        .cardThread(alreadyRunning.id, "steer", "Finish the current turn", owner)
        .pipe(Effect.flip);
      assert.include(deniedRunningSteer.message, "the board is paused");
      yield* setRunning(fake, runningThread, false);

      const unknown = KanbanCardId.make("missing-card");
      for (const id of [unknown, elsewhere.id]) {
        const error = yield* kanban
          .pauseBoard(board.id, { reason: "Bad", keep: [id] }, owner)
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "invalid");
        assert.include(error.message, id);
      }
      const emptyReason = yield* kanban
        .pauseBoard(board.id, { reason: "  ", keep: [] }, owner)
        .pipe(Effect.flip);
      assert.strictEqual(emptyReason.code, "invalid");
      const refused = yield* kanban
        .pauseBoard(board.id, null, { _tag: "thread", threadId: ThreadId.make("work") })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "denied");
      assert.strictEqual((yield* kanban.snapshot(board.id)).board.pause?.reason, "Ship first");

      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      yield* kanban.dispatchNow;
      const running = (yield* kanban.card(kept.id)).card;
      assert.strictEqual(running.stage, "working");
      assert.strictEqual((yield* kanban.card(held.id)).card.stage, "todo");
      const thread = running.activeThreadId!;
      const claim = yield* kanban.claimCard(thread, held.id).pipe(Effect.flip);
      assert.include(claim.message, "the board is paused");
      const before = (yield* kanban.snapshot(board.id)).cards.length;
      const create = yield* kanban
        .createForThread(thread, { prompt: "A new card" })
        .pipe(Effect.flip);
      assert.include(create.message, "the board is paused");
      assert.lengthOf((yield* kanban.snapshot(board.id)).cards, before);
      assert.strictEqual((yield* kanban.card(kept.id)).card.activeThreadId, thread);
      assert.notInclude(fake.interrupted, thread);

      const ownerPause = yield* kanban.pauseBoard(
        board.id,
        { reason: "Hold", keep: [kept.id] },
        owner,
      );
      assert.strictEqual(ownerPause.pause?.by, "owner");
      assert.isNull((yield* kanban.pauseBoard(board.id, null, owner)).pause);
      assert.isNull((yield* kanban.pauseBoard(board.id, null, owner)).pause);
      yield* kanban.cardThread(alreadyRunning.id, "steer", "Resume after the lift", owner);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(held.id)).card.stage, "working");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "the owner pause RPC is guarded, records the owner, and legacy boards decode unpaused",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const { pause: _pause, ...legacy } = board;
        assert.isNull((yield* Schema.decodeEffect(KanbanBoard)(legacy)).pause);
        assert.strictEqual(
          RPC_REQUIRED_SCOPES[KANBAN_WS_METHODS.boardPause],
          AuthOrchestrationOperateScope,
        );
        assert.deepStrictEqual(clientRpcRequiredScopes(KANBAN_WS_METHODS.boardPause, {}), [
          AuthOrchestrationOperateScope,
        ]);
        const handlers = makeKanbanWsHandlers(kanban, {} as KanbanScriptsShape);
        const paused = yield* handlers[KANBAN_WS_METHODS.boardPause]({
          boardId: board.id,
          reason: "Hold",
        });
        assert.strictEqual(paused.pause?.by, "owner");
        assert.deepStrictEqual(paused.pause?.keep, []);
        const lifted = yield* handlers[KANBAN_WS_METHODS.boardPause]({
          boardId: board.id,
          clear: true,
        });
        assert.isNull(lifted.pause);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("holds worker and reviewer turn-end nudges until the board is unpaused", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      const work = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      const review = yield* kanban.createCard(board.id, { prompt: "Review" }, owner);
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(work.id)).card.activeThreadId!;
      const reviewWorker = (yield* kanban.card(review.id)).card.activeThreadId!;
      yield* kanban.moveCard(review.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: reviewWorker,
      });
      yield* kanban.dispatchNow;
      const reviewer = (yield* kanban.card(review.id)).card.activeThreadId!;
      const before = fake.sends.length;
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
      yield* kanban.turnEnded(worker);
      yield* kanban.turnEnded(reviewer);
      assert.lengthOf(fake.sends, before);
      assert.strictEqual((yield* kanban.card(work.id)).card.stage, "working");
      assert.strictEqual((yield* kanban.card(review.id)).card.stage, "in_review");
      yield* kanban.pauseBoard(board.id, null, owner);
      assert.lengthOf(fake.sends, before + 2);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("defers an unanswered card discussion for held workers and reviewers until lift", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      const work = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      const review = yield* kanban.createCard(board.id, { prompt: "Review" }, owner);
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(work.id)).card.activeThreadId!;
      const reviewWorker = (yield* kanban.card(review.id)).card.activeThreadId!;
      yield* kanban.moveCard(review.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: reviewWorker,
      });
      yield* kanban.dispatchNow;
      const reviewer = (yield* kanban.card(review.id)).card.activeThreadId!;
      const workTalk = yield* kanban.cardDiscussion(work.id);
      const reviewTalk = yield* kanban.cardDiscussion(review.id);
      yield* kanban.post(workTalk.id, owner, [{ _tag: "md", text: "Question for worker" }]);
      yield* kanban.post(reviewTalk.id, owner, [{ _tag: "md", text: "Question for reviewer" }]);
      const before = fake.sends.length;
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
      yield* kanban.turnEnded(worker);
      yield* kanban.turnEnded(reviewer);
      assert.lengthOf(fake.sends, before);
      for (const [talk, thread] of [
        [workTalk, worker],
        [reviewTalk, reviewer],
      ] as const) {
        const participant = (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        );
        assert.strictEqual(participant?.owes, "asked");
        assert.isNull(participant?.typingUntil ?? null);
      }
      fake.runOnSend.add(worker);
      fake.runOnSend.add(reviewer);
      yield* kanban.pauseBoard(board.id, null, owner);
      for (const [talk, thread] of [
        [workTalk, worker],
        [reviewTalk, reviewer],
      ] as const) {
        const participant = (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        );
        assert.strictEqual(participant?.owes, "nudged");
        const texts = (yield* Ref.get(fake.threads)).get(thread)!.messages;
        assert.lengthOf(
          texts.filter((text) => text.includes("The owner is waiting for your reply")),
          1,
        );
        assert.isTrue((yield* Ref.get(fake.threads)).get(thread)!.running);
      }
      yield* kanban.tick;
      for (const thread of [worker, reviewer]) {
        const texts = (yield* Ref.get(fake.threads)).get(thread)!.messages;
        assert.lengthOf(
          texts.filter((text) => text.includes("The owner is waiting for your reply")),
          1,
        );
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("retries a refused deferred discussion reminder, without marking it sent", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
      yield* kanban.turnEnded(thread);
      fake.rejectSends.add(thread);
      yield* kanban.pauseBoard(board.id, null, owner);
      const owing = (yield* kanban.discussion(talk.id)).participants.find(
        (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
      );
      assert.strictEqual(owing?.owes, "asked");
      yield* kanban.turnEnded(thread);
      const stillOwing = (yield* kanban.discussion(talk.id)).participants.find(
        (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
      );
      assert.strictEqual(stillOwing?.owes, "asked");
      fake.rejectSends.delete(thread);
      yield* kanban.tick;
      const nudged = (yield* kanban.discussion(talk.id)).participants.find(
        (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
      );
      assert.strictEqual(nudged?.owes, "nudged");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a refused deferred review reminder takes priority over duplicate review turn ends", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Review" }, owner);
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: worker,
      });
      yield* kanban.turnEnded(worker);
      yield* kanban.dispatchNow;
      const reviewer = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* kanban.turnEnded(reviewer);
      const nudgedAt = (yield* kanban.card(card.id)).card.nudgedAt;
      assert.isNotNull(nudgedAt);
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
      yield* kanban.turnEnded(reviewer);
      fake.rejectSends.add(reviewer);
      yield* kanban.pauseBoard(board.id, null, owner);
      yield* kanban.turnEnded(reviewer);
      const stillReviewing = (yield* kanban.card(card.id)).card;
      assert.strictEqual(stillReviewing.stage, "in_review");
      assert.strictEqual(stillReviewing.nudgedAt, nudgedAt);
      assert.strictEqual(
        (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === reviewer,
        )?.owes,
        "asked",
      );
      fake.rejectSends.delete(reviewer);
      yield* kanban.tick;
      assert.strictEqual((yield* kanban.card(card.id)).card.stage, "in_review");
      assert.lengthOf(
        (yield* Ref.get(fake.threads))
          .get(reviewer)!
          .messages.filter((text) => text.includes("The owner is waiting for your reply")),
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a deferred reminder retry uses the same delivery after an ambiguous send", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
      yield* kanban.turnEnded(thread);
      fake.commitThenReject.add(thread);
      yield* kanban.pauseBoard(board.id, null, owner);
      assert.strictEqual(
        (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        )?.owes,
        "asked",
      );
      yield* kanban.tick;
      yield* kanban.tick;
      assert.lengthOf(
        (yield* Ref.get(fake.threads))
          .get(thread)!
          .messages.filter((text) => text.includes("The owner is waiting for your reply")),
        1,
      );
      assert.strictEqual(
        (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        )?.owes,
        "nudged",
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a conclusively rejected reminder rotates its key and retries", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
      const oldKey = (yield* kanban.discussion(talk.id)).participants.find(
        (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
      )?.deferredKey;
      assert.isDefined(oldKey);
      yield* kanban.turnEnded(thread);
      fake.conclusiveReject.add(thread);
      yield* kanban.pauseBoard(board.id, null, owner);
      const deferred = (yield* kanban.discussion(talk.id)).participants.find(
        (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
      );
      assert.strictEqual(deferred?.owes, "asked");
      assert.notStrictEqual(deferred?.deferredKey, oldKey);
      yield* kanban.tick;
      assert.lengthOf(
        (yield* Ref.get(fake.threads))
          .get(thread)!
          .messages.filter((text) => text.includes("The owner is waiting for your reply")),
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a failed failure-state read keeps the deferred reminder until the read recovers", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
      yield* kanban.turnEnded(thread);
      fake.failFailureReads.left = 1;
      yield* kanban.pauseBoard(board.id, null, owner);
      assert.lengthOf(
        (yield* Ref.get(fake.threads))
          .get(thread)!
          .messages.filter((text) => text.includes("The owner is waiting for your reply")),
        0,
      );
      yield* kanban.tick;
      assert.lengthOf(
        (yield* Ref.get(fake.threads))
          .get(thread)!
          .messages.filter((text) => text.includes("The owner is waiting for your reply")),
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an unreadable failure on a delayed turn end never restarts the failed thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
      yield* kanban.turnEnded(thread);
      fake.failures.set(thread, {
        class: "provider_error",
        code: "provider.internal",
        message: "failed",
        retryable: false,
      });
      yield* kanban.pauseBoard(board.id, null, owner);
      const before = (yield* Ref.get(fake.threads)).get(thread)!.messages.length;
      fake.failFailureReads.left = 1;
      yield* kanban.turnEnded(thread);
      assert.lengthOf((yield* Ref.get(fake.threads)).get(thread)!.messages, before);
      assert.isTrue(
        (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        )?.deferred,
      );
      yield* kanban.tick;
      assert.lengthOf((yield* Ref.get(fake.threads)).get(thread)!.messages, before);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a missed failed worker turn is retried before an eligible sibling's quiet backstop",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const held = yield* kanban.createCard(board.id, { prompt: "Held" }, owner);
        yield* kanban.dispatchNow;
        const thread = (yield* kanban.card(held.id)).card.activeThreadId!;
        const kept = (yield* kanban.createForThread(thread, { prompt: "Kept" })).card;
        const talk = yield* kanban.cardDiscussion(held.id);
        yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
        yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [kept.id] }, owner);
        yield* kanban.turnEnded(thread);
        yield* kanban.moveCard(held.id, "needs_review", "cardThread", {
          _tag: "thread",
          threadId: thread,
        });
        fake.failures.set(thread, {
          class: "provider_error",
          code: "provider.internal",
          message: "failed",
          retryable: false,
        });
        fake.failFailureReads.left = 2;
        const before = (yield* Ref.get(fake.threads)).get(thread)!.messages.length;
        yield* kanban.turnEnded(thread);
        yield* TestClock.adjust("31 minutes");
        yield* kanban.tick;
        assert.lengthOf((yield* Ref.get(fake.threads)).get(thread)!.messages, before);
        assert.strictEqual((yield* kanban.card(kept.id)).card.stage, "working");
        yield* kanban.tick;
        assert.lengthOf((yield* Ref.get(fake.threads)).get(thread)!.messages, before);
        const failed = (yield* kanban.card(kept.id)).card;
        assert.strictEqual(failed.stage, "todo");
        assert.include(failed.stalled?.reason ?? "", "Run failed");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a worker resumed during an unresolved turn-end retry keeps its card", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      fake.failures.set(thread, {
        class: "provider_error",
        code: "provider.invalid-request",
        message: "old failure",
      } as OrchestrationV2ProviderFailure);
      fake.failFailureReads.left = 1;
      yield* kanban.turnEnded(thread);
      assert.strictEqual((yield* kanban.card(card.id)).card.stage, "working");
      const reached = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      fake.findCalls.length = 0;
      fake.findControl.beforeRead = (id, attempt) =>
        id === thread && attempt === 2
          ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(resume)))
          : Effect.void;
      const tick = yield* Effect.forkChild(kanban.tick);
      yield* Deferred.await(reached);
      (yield* Ref.get(fake.threads)).get(thread)!.running = true;
      fake.failures.delete(thread);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(tick);
      const after = (yield* kanban.card(card.id)).card;
      assert.strictEqual(after.stage, "working");
      assert.strictEqual(after.activeThreadId, thread);
      assert.isNull(after.stalled);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a missing failed-run identity cannot be used for tick recovery", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      fake.failures.set(thread, {
        class: "provider_error",
        code: "provider.invalid-request",
        message: "failure",
      } as OrchestrationV2ProviderFailure);
      fake.missingFailureRunIds.add(thread);
      yield* kanban.tick;
      assert.strictEqual((yield* kanban.card(card.id)).card.stage, "working");
      fake.missingFailureRunIds.delete(thread);
      yield* kanban.tick;
      const after = (yield* kanban.card(card.id)).card;
      assert.strictEqual(after.stage, "todo");
      assert.include(after.stalled?.reason ?? "", "Run failed");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an unreadable failure while fencing recovery remains unresolved for the next tick", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      fake.failures.set(thread, {
        class: "provider_error",
        code: "provider.invalid-request",
        message: "failure",
      } as OrchestrationV2ProviderFailure);
      fake.failureReads.length = 0;
      fake.failureControl.beforeRead = (id, attempt) =>
        id === thread && attempt === 3
          ? Effect.fail(new KanbanThreadError({ operation: "lastFailure", detail: "read failed" }))
          : Effect.void;
      yield* kanban.tick;
      assert.strictEqual((yield* kanban.card(card.id)).card.stage, "working");
      delete fake.failureControl.beforeRead;
      yield* kanban.tick;
      const after = (yield* kanban.card(card.id)).card;
      assert.strictEqual(after.stage, "todo");
      assert.include(after.stalled?.reason ?? "", "Run failed");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("one deferred retry leaves another asked discussion for a later turn", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const first = yield* kanban.createCard(board.id, { prompt: "First" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(first.id)).card.activeThreadId!;
      const second = (yield* kanban.createForThread(thread, { prompt: "Second" })).card;
      const talkA = yield* kanban.cardDiscussion(first.id);
      const talkB = yield* kanban.cardDiscussion(second.id);
      yield* kanban.post(talkA.id, owner, [{ _tag: "md", text: "First question" }]);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
      yield* kanban.turnEnded(thread);
      yield* kanban.post(talkB.id, owner, [{ _tag: "md", text: "Second question" }]);
      fake.rejectSends.add(thread);
      yield* kanban.pauseBoard(board.id, null, owner);
      yield* kanban.turnEnded(thread);
      const secondParticipant = (yield* kanban.discussion(talkB.id)).participants.find(
        (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
      );
      assert.strictEqual(secondParticipant?.owes, "asked");
      assert.isTrue(secondParticipant?.deferred);
      fake.rejectSends.delete(thread);
      yield* kanban.tick;
      yield* kanban.tick;
      const messages = (yield* Ref.get(fake.threads)).get(thread)!.messages;
      assert.lengthOf(
        messages.filter((text) => text.includes("The owner is waiting for your reply")),
        2,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "keeps each deferred participant in the same discussion and drops a settled reminder",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        yield* kanban.setPool(board.id, board.defaultCardModel, 3);
        const card = yield* kanban.createCard(board.id, { prompt: "Both" }, owner);
        yield* kanban.dispatchNow;
        const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
        const talk = yield* kanban.cardDiscussion(card.id);
        yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Worker question" }]);
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
          _tag: "thread",
          threadId: worker,
        });
        yield* kanban.dispatchNow;
        const reviewer = (yield* kanban.card(card.id)).card.activeThreadId!;
        yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Reviewer question" }]);
        yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
        yield* kanban.reviewResult(reviewer, "findings", ["Fix"]);
        yield* kanban.turnEnded(worker);
        yield* kanban.turnEnded(reviewer);
        yield* kanban.pauseBoard(board.id, null, owner);
        const participants = (yield* kanban.discussion(talk.id)).participants;
        for (const thread of [worker, reviewer]) {
          assert.strictEqual(
            participants.find(
              (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
            )?.owes,
            "nudged",
          );
        }
        const settled = yield* kanban.createCard(board.id, { prompt: "Settled" }, owner);
        yield* kanban.dispatchNow;
        const held = (yield* kanban.card(settled.id)).card.activeThreadId!;
        const settledTalk = yield* kanban.cardDiscussion(settled.id);
        yield* kanban.post(settledTalk.id, owner, [{ _tag: "md", text: "No longer needed" }]);
        yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
        yield* kanban.turnEnded(held);
        yield* kanban.updateDiscussion(settledTalk.id, { settled: true }, owner);
        const before = (yield* Ref.get(fake.threads)).get(held)!.messages.length;
        yield* kanban.pauseBoard(board.id, null, owner);
        const after = (yield* Ref.get(fake.threads)).get(held)!.messages.slice(before);
        assert.isFalse(after.some((text) => text.includes("The owner is waiting for your reply")));
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("settling a held sibling discussion does not block the kept sibling's work", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const held = yield* kanban.createCard(board.id, { prompt: "Held" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(held.id)).card.activeThreadId!;
      const kept = (yield* kanban.createForThread(thread, { prompt: "Kept" })).card;
      const talk = yield* kanban.cardDiscussion(held.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [kept.id] }, owner);
      yield* kanban.turnEnded(thread);
      yield* kanban.moveCard(held.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: thread,
      });
      yield* kanban.updateDiscussion(talk.id, { settled: true }, owner);
      const before = (yield* Ref.get(fake.threads)).get(thread)!.messages.length;
      yield* kanban.tick;
      const messages = (yield* Ref.get(fake.threads)).get(thread)!.messages.slice(before);
      assert.isTrue(messages.some((text) => text.includes("Working")));
      assert.isFalse(messages.some((text) => text.includes("The owner is waiting for your reply")));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an open held sibling discussion does not block the kept sibling's work", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const held = yield* kanban.createCard(board.id, { prompt: "Held" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(held.id)).card.activeThreadId!;
      const kept = (yield* kanban.createForThread(thread, { prompt: "Kept" })).card;
      const talk = yield* kanban.cardDiscussion(held.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [kept.id] }, owner);
      yield* kanban.turnEnded(thread);
      yield* kanban.moveCard(held.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: thread,
      });
      const before = (yield* Ref.get(fake.threads)).get(thread)!.messages.length;
      fake.runOnSend.add(thread);
      yield* kanban.tick;
      const messages = (yield* Ref.get(fake.threads)).get(thread)!.messages.slice(before);
      assert.isTrue(messages.some((text) => text.includes("Working")));
      assert.isFalse(messages.some((text) => text.includes("The owner is waiting for your reply")));
      assert.strictEqual(
        (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        )?.owes,
        "asked",
      );
      yield* setRunning(fake, thread, false);
      yield* kanban.turnEnded(thread);
      assert.isTrue((yield* Ref.get(fake.threads)).get(thread)!.running);
      assert.strictEqual(
        (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        )?.owes,
        "asked",
      );
      // A duplicate event while the next kept turn is running cannot clear it either.
      yield* kanban.turnEnded(thread);
      assert.strictEqual(
        (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        )?.owes,
        "asked",
      );
      // A heartbeat for the active sibling must not clear the held deferral.
      yield* kanban.tick;
      yield* setRunning(fake, thread, false);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      assert.strictEqual(
        (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        )?.owes,
        "asked",
      );
      assert.isTrue(
        (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        )?.deferred,
      );
      // A failed turn on the kept card must not consume the held question.
      fake.failures.set(thread, {
        class: "provider_error",
        code: "provider.internal",
        message: "failed",
        retryable: false,
      });
      yield* setRunning(fake, thread, false);
      yield* kanban.turnEnded(thread);
      assert.isTrue(
        (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        )?.deferred,
      );
      yield* setRunning(fake, thread, false);
      yield* kanban.pauseBoard(board.id, null, owner);
      assert.isFalse(
        (yield* Ref.get(fake.threads))
          .get(thread)!
          .messages.some((text) => text.includes("The owner is waiting for your reply")),
      );
      fake.failures.delete(thread);
      yield* kanban.tick;
      const all = (yield* Ref.get(fake.threads)).get(thread)!.messages;
      assert.lengthOf(
        all.filter((text) => text.includes("The owner is waiting for your reply")),
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a released reviewer's deferred discussion survives a service restart and board lift",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { board, reviewer, talk } = yield* Effect.gen(function* () {
          const { kanban, board } = yield* toyBoard;
          const card = yield* kanban.createCard(board.id, { prompt: "Review" }, owner);
          yield* kanban.dispatchNow;
          const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
          yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
            _tag: "thread",
            threadId: worker,
          });
          yield* kanban.turnEnded(worker);
          yield* kanban.dispatchNow;
          const reviewer = (yield* kanban.card(card.id)).card.activeThreadId!;
          const talk = yield* kanban.cardDiscussion(card.id);
          yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Check this" }]);
          yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
          yield* kanban.reviewResult(reviewer, "findings", ["Fix"]);
          assert.isNull((yield* kanban.card(card.id)).card.activeThreadId);
          yield* kanban.turnEnded(reviewer);
          const participant = (yield* kanban.discussion(talk.id)).participants.find(
            (entry) => entry.actor._tag === "thread" && entry.actor.threadId === reviewer,
          );
          assert.isTrue(participant?.deferred);
          return { board, reviewer, talk };
        }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
        yield* Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          const count = () =>
            Ref.get(fake.threads).pipe(
              Effect.map(
                (threads) =>
                  threads
                    .get(reviewer)!
                    .messages.filter((text) => text.includes("The owner is waiting for your reply"))
                    .length,
              ),
            );
          yield* kanban.tick;
          assert.strictEqual(yield* count(), 0);
          // A failed send is still pending after a restart and is retried by tick.
          fake.rejectSends.add(reviewer);
          yield* kanban.pauseBoard(board.id, null, owner);
          assert.isTrue(
            (yield* kanban.discussion(talk.id)).participants.find(
              (entry) => entry.actor._tag === "thread" && entry.actor.threadId === reviewer,
            )?.deferred,
          );
          fake.rejectSends.delete(reviewer);
          yield* kanban.tick;
          assert.strictEqual(yield* count(), 1);
          const participant = (yield* kanban.discussion(talk.id)).participants.find(
            (entry) => entry.actor._tag === "thread" && entry.actor.threadId === reviewer,
          );
          assert.strictEqual(participant?.owes, "nudged");
          assert.isNotTrue(participant?.deferred);
          yield* kanban.tick;
          assert.strictEqual(yield* count(), 1);
        }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
      }).pipe(Effect.provide(probeDeps(fake.layer)));
    }),
);

it.effect("reconciles a missed reviewer turn-end across restart before lifting the board", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { board, reviewer, talk } = yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const card = yield* kanban.createCard(board.id, { prompt: "Review" }, owner);
        yield* kanban.dispatchNow;
        const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
          _tag: "thread",
          threadId: worker,
        });
        yield* kanban.turnEnded(worker);
        yield* kanban.dispatchNow;
        const reviewer = (yield* kanban.card(card.id)).card.activeThreadId!;
        const talk = yield* kanban.cardDiscussion(card.id);
        yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
        yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
        yield* kanban.reviewResult(reviewer, "findings", ["Fix"]);
        assert.isNull((yield* kanban.card(card.id)).card.activeThreadId);
        // The service exits without receiving the reviewer's turn-end event.
        return { board, reviewer, talk };
      }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        fake.failReads.left = 1;
        yield* kanban.pauseBoard(board.id, null, owner);
        fake.failReads.left = 0;
        yield* kanban.tick;
        assert.lengthOf(
          (yield* Ref.get(fake.threads))
            .get(reviewer)!
            .messages.filter((text) => text.includes("The owner is waiting for your reply")),
          1,
        );
        assert.strictEqual(
          (yield* kanban.discussion(talk.id)).participants.find(
            (entry) => entry.actor._tag === "thread" && entry.actor.threadId === reviewer,
          )?.owes,
          "nudged",
        );
      }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
    }).pipe(Effect.provide(probeDeps(fake.layer)));
  }),
);

it.effect(
  "preserves a question on a running held reviewer if the board lifts before turn end",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const card = yield* kanban.createCard(board.id, { prompt: "Review" }, owner);
        yield* kanban.dispatchNow;
        const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
          _tag: "thread",
          threadId: worker,
        });
        yield* kanban.turnEnded(worker);
        yield* kanban.dispatchNow;
        const reviewer = (yield* kanban.card(card.id)).card.activeThreadId!;
        yield* setRunning(fake, reviewer, true);
        const talk = yield* kanban.cardDiscussion(card.id);
        yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
        yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
        yield* kanban.reviewResult(reviewer, "findings", ["Fix"]);
        yield* kanban.tick;
        yield* kanban.pauseBoard(board.id, null, owner);
        const before = (yield* Ref.get(fake.threads)).get(reviewer)!.messages.length;
        yield* setRunning(fake, reviewer, false);
        yield* kanban.turnEnded(reviewer);
        const messages = (yield* Ref.get(fake.threads)).get(reviewer)!.messages.slice(before);
        assert.lengthOf(
          messages.filter((text) => text.includes("The owner is waiting for your reply")),
          1,
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("settling a question while its reviewer is running prevents a later reminder", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Review" }, owner);
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: worker,
      });
      yield* kanban.turnEnded(worker);
      yield* kanban.dispatchNow;
      const reviewer = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* setRunning(fake, reviewer, true);
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
      yield* kanban.updateDiscussion(talk.id, { settled: true }, owner);
      yield* kanban.pauseBoard(board.id, null, owner);
      const before = (yield* Ref.get(fake.threads)).get(reviewer)!.messages.length;
      yield* setRunning(fake, reviewer, false);
      yield* kanban.turnEnded(reviewer);
      assert.isFalse(
        (yield* Ref.get(fake.threads))
          .get(reviewer)!
          .messages.slice(before)
          .some((text) => text.includes("The owner is waiting for your reply")),
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a stale event cannot deliver a deferred reminder while its new kept turn is running",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
        yield* kanban.dispatchNow;
        const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
        const talk = yield* kanban.cardDiscussion(card.id);
        yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
        yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
        yield* kanban.turnEnded(thread);
        yield* setRunning(fake, thread, true);
        const before = (yield* Ref.get(fake.threads)).get(thread)!.messages.length;
        yield* kanban.pauseBoard(board.id, null, owner);
        yield* kanban.turnEnded(thread);
        assert.lengthOf((yield* Ref.get(fake.threads)).get(thread)!.messages, before);
        const participant = (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        );
        assert.strictEqual(participant?.owes, "asked");
        assert.isTrue(participant?.deferred);
        yield* setRunning(fake, thread, false);
        yield* kanban.tick;
        assert.lengthOf(
          (yield* Ref.get(fake.threads))
            .get(thread)!
            .messages.filter((text) => text.includes("The owner is waiting for your reply")),
          1,
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("an owner-settled deferred discussion stays silent at a later turn end", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
      yield* kanban.turnEnded(thread);
      yield* kanban.updateDiscussion(talk.id, { settled: true }, owner);
      assert.isNull(
        (yield* kanban.discussion(talk.id)).participants.find(
          (entry) => entry.actor._tag === "thread" && entry.actor.threadId === thread,
        )?.owes,
      );
      const before = (yield* Ref.get(fake.threads)).get(thread)!.messages.length;
      yield* kanban.turnEnded(thread);
      yield* kanban.pauseBoard(board.id, null, owner);
      yield* kanban.turnEnded(thread);
      const messages = (yield* Ref.get(fake.threads)).get(thread)!.messages.slice(before);
      assert.isFalse(messages.some((text) => text.includes("The owner is waiting for your reply")));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("does not nudge a batched worker for a kept card while it carries a held card", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const first = yield* kanban.createCard(board.id, { prompt: "First" }, owner);
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(first.id)).card.activeThreadId!;
      const second = (yield* kanban.createForThread(worker, { prompt: "Second" })).card;
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [first.id] }, owner);
      const deniedSteer = yield* kanban
        .cardThread(first.id, "steer", "Go", owner)
        .pipe(Effect.flip);
      const deniedWake = yield* kanban.cardThread(first.id, "wake", "Go", owner).pipe(Effect.flip);
      assert.include(deniedSteer.message, "the board is paused");
      assert.include(deniedWake.message, "the board is paused");
      const before = (yield* Ref.get(fake.threads)).get(worker)!.messages.length;
      yield* kanban.turnEnded(worker);
      yield* TestClock.adjust("31 minutes");
      yield* kanban.tick;
      assert.strictEqual((yield* Ref.get(fake.threads)).get(worker)!.messages.length, before);
      yield* kanban.pauseBoard(board.id, { reason: "Both", keep: [first.id, second.id] }, owner);
      assert.strictEqual((yield* Ref.get(fake.threads)).get(worker)!.messages.length, before + 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("setup_done ends a running setup; only its own thread or the owner may end it", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const setup = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });
      const running = (yield* kanban.boards).find((b) => b.id === board.id)!;
      assert.strictEqual(running.setup?.status, "running");
      assert.strictEqual(running.setup?.threadId, setup);
      const setupDiscussionId = running.setup!.discussionId;

      // A second setup while one runs is refused.
      const again = yield* Effect.exit(
        kanban.startEvaluator(board.id, { kind: "setup", text: "Again" }),
      );
      assert.isTrue(Exit.isFailure(again));

      // Another evaluator can't end it.
      const other: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("t-other") };
      assert.isTrue(Exit.isFailure(yield* Effect.exit(kanban.endSetup(board.id, other))));
      assert.strictEqual(
        (yield* kanban.boards).find((b) => b.id === board.id)!.setup?.status,
        "running",
      );

      // The setup thread ends it; a line lands in the Setup discussion.
      const done = yield* kanban.endSetup(board.id, { _tag: "evaluator", threadId: setup });
      assert.strictEqual(done.setup?.status, "done");
      assert.isNotNull(done.setup?.finishedAt);
      const messages = yield* kanban.messages(setupDiscussionId);
      assert.include(
        messages
          .at(-1)
          ?.blocks.map((b) => ("text" in b ? b.text : ""))
          .join(""),
        "Setup is done",
      );

      // Ending again is refused: nothing is running.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(kanban.endSetup(board.id, owner))));

      // A fresh setup can start after the first one ends.
      const next = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Round two" });
      assert.isString(next);
      // The owner can end a running setup too.
      yield* kanban.endSetup(board.id, owner);
      assert.strictEqual(
        (yield* kanban.boards).find((b) => b.id === board.id)!.setup?.status,
        "done",
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("setupStart saves the picked model, starts setup once and refuses a second start", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const picked = {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "opus/claude-opus-5-5",
      };
      const started = yield* kanban.startSetup(board.id, { evaluatorModel: picked });
      const after = (yield* kanban.boards).find((b) => b.id === board.id)!;
      assert.strictEqual(after.evaluatorModel.model, "opus/claude-opus-5-5");
      assert.strictEqual(Rules.modelLevel(after.evaluatorModel), "high");
      assert.strictEqual(after.setup?.status, "running");
      assert.strictEqual(after.setup?.discussionId, started.discussionId);
      assert.deepStrictEqual(
        (yield* Ref.get(fake.threads)).get(after.setup!.threadId)!.model,
        after.evaluatorModel,
      );
      // The setup evaluator talks in the Setup discussion it was handed.
      const discussion = yield* kanban.discussion(started.discussionId);
      assert.strictEqual(discussion.title, "Setup");

      // A second start while setup runs is refused and starts nothing.
      const again = yield* Effect.exit(
        kanban.startSetup(board.id, { evaluatorModel: picked, text: "Again" }),
      );
      assert.isTrue(Exit.isFailure(again));
      assert.strictEqual(
        (yield* kanban.boards).find((b) => b.id === board.id)!.setup?.discussionId,
        started.discussionId,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("setupStart preserves an explicit Opus level and a different model without one", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const picked = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
      yield* kanban.startSetup(board.id, { evaluatorModel: picked });
      const after = (yield* kanban.boards).find((b) => b.id === board.id)!;
      assert.deepStrictEqual(after.evaluatorModel, picked);
      assert.deepStrictEqual(
        (yield* Ref.get(fake.threads)).get(after.setup!.threadId)!.model,
        picked,
      );
      const invalid = yield* Effect.exit(
        kanban.createBoard({
          slug: "invalid-effort",
          name: "Invalid effort",
          defaultProjectId: null,
          evaluatorModel: { ...picked, options: [{ id: "variant", value: true }] },
        }),
      );
      assert.isTrue(Exit.isFailure(invalid));

      const otherBoard = yield* kanban.createBoard({
        slug: "setup-other",
        name: "Other setup",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const other = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol" });
      yield* kanban.startSetup(otherBoard.id, { evaluatorModel: other });
      assert.deepStrictEqual((yield* kanban.snapshot(otherBoard.id)).board.evaluatorModel, other);
      assert.isNull(Rules.modelLevel(other));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a setup can adopt an existing discussion as its Setup discussion", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      // An older board discussion, opened before setup existed.
      const existing = yield* kanban.createDiscussion(board.id, "Robob setup notes", owner);
      const setup = yield* kanban.startEvaluator(board.id, {
        kind: "setup",
        text: "Set it up",
        discussionId: existing.id,
      });
      const running = (yield* kanban.boards).find((b) => b.id === board.id)!;
      assert.strictEqual(running.setup?.discussionId, existing.id);
      assert.strictEqual(running.setup?.threadId, setup);
      assert.strictEqual((yield* kanban.discussion(existing.id)).evaluatorThreadId, setup);
      // It did not create a second Setup discussion.
      assert.strictEqual((yield* kanban.discussions(board.id)).length, 1);
      yield* kanban.endSetup(board.id, owner);

      // A discussion from another board is refused.
      const other = yield* kanban.ensureBoard({
        slug: "other",
        name: "Other",
        defaultProjectId: ProjectId.make("project-other"),
      });
      const foreign = yield* kanban.createDiscussion(other.id, "Elsewhere", owner);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            kanban.startEvaluator(board.id, {
              kind: "setup",
              text: "Set it up",
              discussionId: foreign.id,
            }),
          ),
        ),
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("adopting a discussion that already has an evaluator hands it to the setup thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      // An older evaluator already owns this discussion.
      const old = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look at it" });
      const oldEvaluator: KanbanActor = { _tag: "evaluator", threadId: old };
      const existing = yield* kanban.createDiscussion(board.id, "Robob setup notes", oldEvaluator);
      assert.strictEqual((yield* kanban.discussion(existing.id)).evaluatorThreadId, old);

      const setup = yield* kanban.startEvaluator(board.id, {
        kind: "setup",
        text: "Set it up",
        discussionId: existing.id,
      });
      // Ownership moved: owner replies reach the setup thread, not the old one.
      assert.strictEqual((yield* kanban.discussion(existing.id)).evaluatorThreadId, setup);
      yield* kanban.post(existing.id, owner, [{ _tag: "md", text: "Where are we?" }]);
      const all = [...(yield* Ref.get(fake.threads)).entries()];
      assert.include(all.find(([id]) => id === setup)![1].messages.at(-1) ?? "", "Where are we?");

      // The setup thread can end setup from there.
      const done = yield* kanban.endSetup(board.id, { _tag: "evaluator", threadId: setup });
      assert.strictEqual(done.setup?.status, "done");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const setArchived = (fake: Effect.Success<typeof makeFake>, threadId: string) =>
  Ref.update(fake.threads, (all) => {
    all.get(threadId)!.archived = true;
    return all;
  });

it.effect("an owner's new channel starts its own evaluator", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const setup = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });

      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);

      const next = (yield* kanban.discussion(channel.id)).evaluatorThreadId;
      assert.isNotNull(next);
      assert.notStrictEqual(next, setup);
      const all = yield* Ref.get(fake.threads);
      assert.strictEqual(
        [...all.values()].filter((view) => view.title.startsWith("Evaluator")).length,
        2,
      );
      assert.include(all.get(next!)!.messages.join("\n"), "Round fees up");
      assert.isFalse(all.get(setup)!.messages.some((text) => text.includes("Round fees up")));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an archived evaluator is stopped and its discussion gets a new evaluator", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const setup = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: setup };
      const opened = yield* kanban.createDiscussion(board.id, "Setup", evaluator);
      assert.strictEqual(opened.evaluatorThreadId, setup);
      const request = yield* kanban.startEvaluator(board.id, {
        kind: "request",
        text: "Add a card",
      });
      yield* setArchived(fake, setup);

      yield* kanban.post(opened.id, owner, [{ _tag: "md", text: "Still there?" }]);

      const next = (yield* kanban.discussion(opened.id)).evaluatorThreadId;
      assert.isNotNull(next);
      assert.notStrictEqual(next, setup);
      assert.notStrictEqual(next, request);
      assert.include(fake.interrupted, setup);
      const all = yield* Ref.get(fake.threads);
      assert.isFalse(all.get(setup)!.messages.some((text) => text.includes("Still there?")));
      assert.isFalse(all.get(request)!.messages.some((text) => text.includes("Still there?")));
      assert.include(all.get(next!)!.messages.join("\n"), "Still there?");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an archived evaluator with no live one is replaced", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const setup = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: setup };
      const opened = yield* kanban.createDiscussion(board.id, "Setup", evaluator);
      yield* setArchived(fake, setup);

      yield* kanban.post(opened.id, owner, [{ _tag: "md", text: "Still there?" }]);

      const next = (yield* kanban.discussion(opened.id)).evaluatorThreadId;
      assert.isNotNull(next);
      assert.notStrictEqual(next, setup);
      assert.include(fake.interrupted, setup);
      const all = yield* Ref.get(fake.threads);
      assert.isFalse(all.get(setup)!.messages.some((text) => text.includes("Still there?")));
      assert.include(all.get(next!)!.messages.join("\n"), "Still there?");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a new channel doesn't go to an ended request evaluator", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const request = yield* kanban.startEvaluator(board.id, {
        kind: "request",
        text: "Add a card",
      });
      yield* kanban.turnEnded(request);
      const store = yield* KanbanStore.KanbanStore;
      assert.isNotNull((yield* store.threadLink(request))?.endedAt ?? null);

      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);

      const next = (yield* kanban.discussion(channel.id)).evaluatorThreadId;
      assert.isNotNull(next);
      assert.notStrictEqual(next, request);
      const all = [...(yield* Ref.get(fake.threads)).values()];
      assert.strictEqual(all.filter((view) => view.title.startsWith("Evaluator")).length, 2);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an owner's pick on an archived evaluator's choice reaches its replacement", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const request = yield* kanban.startEvaluator(board.id, {
        kind: "request",
        text: "Add a card",
      });
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: request };
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      const asked = yield* kanban.post(channel.id, evaluator, [
        {
          _tag: "choice",
          id: "c1",
          style: "pick",
          question: "Round up?",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          multi: false,
        },
      ]);
      yield* setArchived(fake, request);

      yield* kanban.answer(channel.id, asked.seq, "c1", ["yes"], owner);

      const next = (yield* kanban.discussion(channel.id)).evaluatorThreadId;
      assert.isNotNull(next);
      assert.notStrictEqual(next, request);
      assert.include(fake.interrupted, request);
      const all = yield* Ref.get(fake.threads);
      assert.isFalse(all.get(request)!.messages.some((text) => text.includes("Owner answered")));
      assert.include(all.get(next!)!.messages.join("\n"), 'Owner answered "Round up?"');
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

// Provider outage tests: the probe answers when probe.ok is true, dies otherwise.
const outage: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  code: "provider.invalid-request",
  message: "Third-party apps now draw from your extra usage, not your plan limits.",
  retryable: null,
} as never;
const probe: {
  ok: boolean;
  calls: number;
  block?: { reached: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
} = { ok: false, calls: 0 };
/** Everything but the service, so a test can start a second service on the same store. */
const probeDeps = (fake: Layer.Layer<KanbanThreads>, failPosts = false) =>
  fake.pipe(
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(
      failPosts
        ? failingPostStore.pipe(Layer.provide(KanbanStore.layer))
        : failingRekeyStore.pipe(Layer.provide(KanbanStore.layer)),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(
      Layer.mock(TextGeneration.TextGeneration)({
        generateJson: (() =>
          Effect.gen(function* () {
            probe.calls += 1;
            if (probe.block) {
              const { reached, release } = probe.block;
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
            }
            return yield* probe.ok ? Effect.succeed({ ok: true }) : Effect.die("out of usage");
          })) as never,
      }),
    ),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(boardFilesLayer),
  );
const probeLayer = (fake: Layer.Layer<KanbanThreads>) =>
  KanbanService.layer.pipe(Layer.provideMerge(probeDeps(fake)));

it.effect("review259r3: the quiet backstop records a missed outage so probes can recover it", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = true;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      fake.failures.set(thread, outage);
      yield* TestClock.adjust("31 minutes");
      yield* kanban.tick;
      assert.isNotNull((yield* kanban.caller(thread))?.paused ?? null);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isTrue(probe.calls > 0);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect(
  "review259r3: a deferred question must not hide a missed failed turn from the backstop",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
        yield* kanban.dispatchNow;
        const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
        const talk = yield* kanban.cardDiscussion(card.id);
        yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
        yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
        fake.failures.set(thread, {
          class: "provider_error",
          code: "provider.internal",
          message: "failed",
          retryable: false,
        });
        yield* kanban.pauseBoard(board.id, null, owner);
        yield* TestClock.adjust("31 minutes");
        yield* kanban.tick;
        yield* kanban.tick;
        const failed = (yield* kanban.card(card.id)).card;
        assert.strictEqual(failed.stage, "todo");
        assert.include(failed.stalled?.reason ?? "", "Run failed");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect(
  "a missed outage during a board pause is handled on lift and its deferred question waits for recovery",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      probe.ok = true;
      probe.calls = 0;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const card = yield* kanban.createCard(board.id, { prompt: "Work" }, owner);
        yield* kanban.dispatchNow;
        const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
        const talk = yield* kanban.cardDiscussion(card.id);
        yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Question" }]);
        yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [] }, owner);
        fake.failures.set(thread, outage);
        yield* kanban.pauseBoard(board.id, null, owner);
        yield* kanban.tick;
        assert.isNotNull((yield* kanban.caller(thread))?.paused ?? null);
        assert.isTrue(
          (yield* kanban.discussion(talk.id)).participants.some(
            (entry) =>
              entry.actor._tag === "thread" &&
              entry.actor.threadId === thread &&
              entry.deferred &&
              entry.owes === "asked",
          ),
        );
        const reminders = () =>
          Ref.get(fake.threads).pipe(
            Effect.map((all) =>
              all
                .get(thread)!
                .messages.filter((text) => text.includes("The owner is waiting for your reply")),
            ),
          );
        assert.lengthOf(yield* reminders(), 0);
        yield* TestClock.adjust("5 minutes");
        yield* kanban.probeOutages;
        assert.isTrue(probe.calls > 0);
        fake.failures.delete(thread); // The recovery run is now eligible to answer.
        yield* kanban.tick;
        assert.lengthOf(yield* reminders(), 1);
      }).pipe(Effect.provide(probeLayer(fake.layer)));
    }),
);

it.effect("a stale successful probe cannot clear an outage reported during the probe", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = true;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      const first = yield* kanban.createCard(board.id, { prompt: "First" }, owner);
      const second = yield* kanban.createCard(board.id, { prompt: "Second" }, owner);
      yield* kanban.dispatchNow;
      const a = (yield* kanban.card(first.id)).card.activeThreadId!;
      const b = (yield* kanban.card(second.id)).card.activeThreadId!;
      fake.failures.set(a, outage);
      yield* kanban.turnEnded(a);
      yield* TestClock.adjust("5 minutes");
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      probe.block = { reached, release };
      const running = yield* kanban.probeOutages.pipe(Effect.forkScoped);
      yield* Deferred.await(reached);
      fake.failures.set(b, outage);
      yield* kanban.turnEnded(b);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      delete probe.block;
      assert.isNotNull((yield* kanban.caller(a))?.paused);
      assert.isNotNull((yield* kanban.caller(b))?.paused);
      yield* kanban.probeOutages;
      assert.isNull((yield* kanban.caller(a))?.paused ?? null);
      assert.isNull((yield* kanban.caller(b))?.paused ?? null);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          delete probe.block;
        }),
      ),
      Effect.scoped,
      Effect.provide(probeLayer(fake.layer)),
    );
  }),
);

it.effect("a work run that dies on an outage is paused, not flagged or nudged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const before = (yield* Ref.get(fake.threads)).get(workThread)!.messages.length;
      fake.failures.set(workThread, outage);
      yield* kanban.turnEnded(workThread);
      const messages = (yield* Ref.get(fake.threads)).get(workThread)!.messages;
      assert.strictEqual(messages.length, before);
      const held = (yield* kanban.card(created.id)).card;
      assert.strictEqual(held.stage, "working");
      assert.strictEqual(held.activeThreadId, workThread);
      assert.isNull(held.stalled);
      assert.match((yield* kanban.caller(workThread))?.paused?.message ?? "", /extra usage/);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a work run that times out waiting for response headers is paused, not flagged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const before = (yield* Ref.get(fake.threads)).get(workThread)!.messages.length;
      fake.failures.set(workThread, {
        class: "provider_error",
        code: "provider.internal",
        message: "Timed out waiting for response headers",
      } as never);
      yield* kanban.turnEnded(workThread);
      const messages = (yield* Ref.get(fake.threads)).get(workThread)!.messages;
      assert.strictEqual(messages.length, before);
      const held = (yield* kanban.card(created.id)).card;
      assert.strictEqual(held.stage, "working");
      assert.strictEqual(held.activeThreadId, workThread);
      assert.isNull(held.stalled);
      assert.match((yield* kanban.caller(workThread))?.paused?.message ?? "", /response headers/);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an outage after a card_edit model switch holds the thread's live model", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", variant: "xhigh" });
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      yield* kanban.setPool(board.id, sol, 3);
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.editCard(created.id, { model: sol }, owner);
      fake.failures.set(workThread, outage);
      yield* kanban.turnEnded(workThread);
      const paused = yield* kanban.caller(workThread);
      assert.strictEqual(paused?.model?.model, "opus/cx/gpt-6.1-sol");
      // Sol is down; the card's old model still takes work.
      const onSol = yield* kanban.createCard(
        board.id,
        { prompt: "s", title: "s", model: sol },
        owner,
      );
      const plain = yield* kanban.createCard(board.id, { prompt: "p", title: "p" }, owner);
      yield* kanban.dispatchNow;
      assert.isNull((yield* kanban.card(onSol.id)).card.activeThreadId);
      assert.isNotNull((yield* kanban.card(plain.id)).card.activeThreadId);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an outage is filed under the failed run's model", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", variant: "xhigh" });
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(created.id)).card.activeThreadId!;
      fake.modelSwitches.push({ threadId, model: board.defaultCardModel });
      fake.failures.set(threadId, { ...outage, model: sol });
      yield* kanban.turnEnded(threadId);
      const link = yield* kanban.caller(threadId);
      assert.isNotNull(link?.paused);
      assert.deepStrictEqual(link?.model, sol);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a down pool takes no new card; a weighted card starts on its other model", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", variant: "xhigh" });
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      yield* kanban.setPool(board.id, sol, 1);
      const first = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(first.id)).card.activeThreadId!;
      fake.failures.set(workThread, outage);
      yield* kanban.turnEnded(workThread);
      const weighted = yield* kanban.createCard(
        board.id,
        {
          prompt: "x",
          title: "W",
          models: [
            { model: board.defaultCardModel, weight: 2 },
            { model: sol, weight: 1 },
          ],
        } as never,
        owner,
      );
      const plain = yield* kanban.createCard(board.id, { prompt: "x", title: "P" }, owner);
      yield* kanban.dispatchNow;
      const w = (yield* kanban.card(weighted.id)).card;
      assert.include(w.activePool ?? "", "gpt-6.1-sol");
      const p = (yield* kanban.card(plain.id)).card;
      assert.strictEqual(p.stage, "todo");
      assert.isNull(p.activeThreadId);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a recovered provider waits for a board hold without blocking the kept card's pool", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = true;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      const held = yield* kanban.createCard(board.id, { prompt: "Held" }, owner);
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(held.id)).card.activeThreadId!;
      const before = (yield* Ref.get(fake.threads)).get(worker)!.messages.length;
      fake.failures.set(worker, outage);
      yield* kanban.turnEnded(worker);
      const kept = yield* kanban.createCard(board.id, { prompt: "Kept" }, owner);
      yield* kanban.pauseBoard(board.id, { reason: "Hold", keep: [kept.id] }, owner);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.strictEqual((yield* Ref.get(fake.threads)).get(worker)!.messages.length, before);
      assert.isNotNull((yield* kanban.caller(worker))?.paused);
      // A duplicate notification for the same failed run must not close the recovered pool.
      yield* kanban.turnEnded(worker);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(kept.id)).card.stage, "working");
      const keptWorker = (yield* kanban.card(kept.id)).card.activeThreadId!;
      fake.failures.set(keptWorker, outage);
      yield* kanban.turnEnded(keptWorker);
      // The second outage is real. Lifting the hold must not send to the first worker yet.
      yield* kanban.pauseBoard(board.id, null, owner);
      assert.strictEqual((yield* Ref.get(fake.threads)).get(worker)!.messages.length, before);
      fake.rejectSends.add(keptWorker);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isNotNull((yield* kanban.caller(keptWorker))?.paused);
      yield* kanban.tick;
      yield* kanban.probeOutages;
      assert.strictEqual((yield* Ref.get(fake.threads)).get(worker)!.messages.length, before);
      assert.isNotNull((yield* kanban.caller(worker))?.paused);
      fake.rejectSends.delete(keptWorker);
      yield* kanban.probeOutages;
      yield* kanban.tick;
      assert.strictEqual((yield* Ref.get(fake.threads)).get(worker)!.messages.length, before + 1);
      assert.isNull((yield* kanban.caller(worker))?.paused ?? null);
      assert.isNull((yield* kanban.caller(keptWorker))?.paused ?? null);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("probeOutages backs off, then wakes paused threads when the model answers", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const before = (yield* Ref.get(fake.threads)).get(workThread)!.messages.length;
      fake.failures.set(workThread, outage);
      yield* kanban.turnEnded(workThread);
      yield* kanban.probeOutages;
      assert.strictEqual(probe.calls, 0);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.strictEqual(probe.calls, 1);
      assert.isNotNull((yield* kanban.caller(workThread))?.paused);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.strictEqual(probe.calls, 1);
      probe.ok = true;
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.strictEqual(probe.calls, 2);
      const messages = (yield* Ref.get(fake.threads)).get(workThread)!.messages;
      assert.strictEqual(messages.length, before + 1);
      assert.include(messages[messages.length - 1] ?? "", "answers again");
      assert.isNull((yield* kanban.caller(workThread))?.paused ?? null);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("a paused evaluator is kept open and woken", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const threadId = yield* kanban.startEvaluator(board.id, {
        kind: "request",
        text: "Look at it",
      });
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      const link = yield* kanban.caller(threadId);
      assert.isNull(link?.endedAt ?? null);
      assert.isNotNull(link?.paused);
      probe.ok = true;
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      const messages = (yield* Ref.get(fake.threads)).get(threadId)!.messages;
      assert.include(messages[messages.length - 1] ?? "", "answers again");
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

const stopping = {
  class: "provider_error",
  code: null,
  message: "OpenCode is still stopping the previous turn. Send the message again in a moment.",
} as never;

it.effect("a stale turn end while the retry waits on input does not clear the failure streak", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      fake.failures.set(e, stopping);
      yield* kanban.turnEnded(e);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      fake.failures.delete(e);
      const retry = (yield* Ref.get(fake.threads)).get(e)!;
      retry.running = true;
      retry.stuck = true;
      yield* kanban.turnEnded(e);
      retry.stuck = false;
      retry.running = false;
      fake.failures.set(e, { ...(stopping as object) } as never);
      yield* kanban.turnEnded(e);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      assert.strictEqual(
        retry.messages.filter((text) => text.includes("one automatic retry")).length,
        1,
      );
      assert.notStrictEqual((yield* kanban.discussion(channel.id)).evaluatorThreadId, e);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("review135r2: a stale turn end while retry runs does not clear the failure streak", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      fake.failures.set(e, stopping);
      yield* kanban.turnEnded(e);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      // Production lastFailure is null when the latest executed run is still running.
      fake.failures.delete(e);
      (yield* Ref.get(fake.threads)).get(e)!.running = true;
      yield* kanban.turnEnded(e);
      (yield* Ref.get(fake.threads)).get(e)!.running = false;
      fake.failures.set(e, { ...(stopping as object) } as never);
      yield* kanban.turnEnded(e);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      const messages = (yield* Ref.get(fake.threads)).get(e)!.messages;
      assert.strictEqual(messages.filter((text) => text.includes("one automatic retry")).length, 1);
      assert.notStrictEqual((yield* kanban.discussion(channel.id)).evaluatorThreadId, e);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("review135r2: an intervening outage preserves the non-outage failure streak", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = true;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      fake.failures.set(e, stopping);
      yield* kanban.turnEnded(e);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Continue now" }]);
      fake.failures.set(e, outage);
      yield* kanban.turnEnded(e);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isNull((yield* kanban.caller(e))!.paused);
      fake.failures.set(e, { ...(stopping as object) } as never);
      yield* kanban.turnEnded(e);
      assert.notStrictEqual((yield* kanban.discussion(channel.id)).evaluatorThreadId, e);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("review135: a replacement setup evaluator can finish setup", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const first = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });
      const setup = (yield* kanban.boards).find((b) => b.id === board.id)!.setup!;
      fake.failures.set(first, {
        class: "provider_error",
        code: null,
        message: "prompt is too long",
      } as never);
      yield* kanban.turnEnded(first);
      const fresh = (yield* kanban.discussion(setup.discussionId)).evaluatorThreadId!;
      assert.notStrictEqual(fresh, first);
      yield* kanban.endSetup(board.id, { _tag: "evaluator", threadId: fresh });
      assert.strictEqual(
        (yield* kanban.boards).find((b) => b.id === board.id)!.setup!.status,
        "done",
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("review135: an outage pauses a previously scheduled retry", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      fake.failures.set(e, stopping);
      yield* kanban.turnEnded(e);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Continue now" }]);
      fake.failures.set(e, outage);
      yield* kanban.turnEnded(e);
      assert.isNotNull((yield* kanban.caller(e))!.paused);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      const messages = (yield* Ref.get(fake.threads)).get(e)!.messages;
      assert.strictEqual(messages.filter((text) => text.includes("one automatic retry")).length, 0);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("review135: duplicate failure notifications do not consume the retry", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      fake.failures.set(e, stopping);
      yield* kanban.turnEnded(e);
      yield* kanban.turnEnded(e);
      assert.strictEqual((yield* kanban.discussion(channel.id)).evaluatorThreadId, e);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      const messages = (yield* Ref.get(fake.threads)).get(e)!.messages;
      assert.strictEqual(messages.filter((text) => text.includes("one automatic retry")).length, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("review135: a rejected retry send hands off once without breaking the tick", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      fake.failures.set(e, stopping);
      yield* kanban.turnEnded(e);
      fake.rejectSends.add(e);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      const fresh = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      assert.notStrictEqual(fresh, e);
      yield* kanban.tick;
      assert.strictEqual((yield* kanban.discussion(channel.id)).evaluatorThreadId, fresh);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("review135: a given-up ask routes to the card discussion evaluator", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const evaluator = yield* kanban.startEvaluator(board.id, {
        kind: "request",
        text: "Look at it",
      });
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.askOwner(
        card.id,
        { question: "Ship?", blocking: false, options: ["A", "B"] },
        { _tag: "evaluator", threadId: evaluator },
        "evaluator",
      );
      fake.failures.set(evaluator, {
        class: "provider_error",
        code: null,
        message: "prompt is too long",
      } as never);
      yield* kanban.turnEnded(evaluator);
      const before = (yield* Ref.get(fake.threads)).get(evaluator)!.messages.length;
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.answer(talk.id, 1, "q1", ["o1"], owner);
      const current = yield* kanban.discussion(talk.id);
      assert.isNotNull(current.evaluatorThreadId);
      assert.notStrictEqual(current.evaluatorThreadId, evaluator);
      assert.strictEqual((yield* Ref.get(fake.threads)).get(evaluator)!.messages.length, before);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("review135: a clean replacement run resets the discussion handoff budget", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      const full = { class: "provider_error", code: null, message: "prompt is too long" } as never;
      fake.failures.set(e, full);
      yield* kanban.turnEnded(e);
      const n = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      yield* kanban.turnEnded(n);
      fake.failures.set(n, full);
      yield* kanban.turnEnded(n);
      const next = (yield* kanban.discussion(channel.id)).evaluatorThreadId;
      assert.isNotNull(next);
      assert.notStrictEqual(next, n);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const lastText = (messages: ReadonlyArray<{ readonly blocks: ReadonlyArray<unknown> }>) =>
  messages
    .at(-1)
    ?.blocks.map((b) => ("text" in (b as object) ? (b as { text: string }).text : ""))
    .join("") ?? "";

it.effect("a failed evaluator run is retried once after two minutes", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      const count = () =>
        Effect.gen(function* () {
          const msgs = (yield* Ref.get(fake.threads)).get(e)!.messages;
          return msgs.filter((m) => String(m).includes("one automatic retry")).length;
        });
      fake.failures.set(e, stopping);
      yield* kanban.turnEnded(e);
      yield* TestClock.adjust("1 minute");
      yield* kanban.tick;
      assert.strictEqual(yield* count(), 0);
      yield* TestClock.adjust("1 minute");
      yield* kanban.tick;
      assert.strictEqual(yield* count(), 1);
      yield* kanban.tick;
      assert.strictEqual(yield* count(), 1);
      assert.strictEqual((yield* kanban.discussion(channel.id)).evaluatorThreadId, e);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an evaluator failure kept through an unreadable shell probe is still retried", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      const count = () =>
        Effect.gen(function* () {
          const msgs = (yield* Ref.get(fake.threads)).get(e)!.messages;
          return msgs.filter((m) => String(m).includes("one automatic retry")).length;
        });
      fake.failures.set(e, stopping);
      // The turn end can't read the failure, so it stays unresolved for the tick.
      fake.failFailureReads.left = 1;
      yield* kanban.turnEnded(e);
      // On the tick, the first read is the turn end's view; the second is the
      // shell probe that checks the failed run is still current.
      const base = fake.findCalls.filter((id) => id === e).length;
      fake.findControl.beforeRead = (id, attempt) =>
        id === e && attempt === base + 2
          ? Effect.fail(new KanbanThreadError({ operation: "view", detail: "read failed" }))
          : Effect.void;
      yield* kanban.tick;
      delete fake.findControl.beforeRead;
      yield* kanban.tick;
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* count(), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an evaluator that recovers is not retried", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      fake.failures.set(e, stopping);
      yield* kanban.turnEnded(e);
      fake.failures.delete(e);
      yield* kanban.turnEnded(e);
      yield* TestClock.adjust("3 minutes");
      yield* kanban.tick;
      const msgs = (yield* Ref.get(fake.threads)).get(e)!.messages;
      assert.isFalse(msgs.some((m) => String(m).includes("one automatic retry")));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an evaluator that fails twice is replaced in its discussion", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      fake.failures.set(e, stopping);
      yield* kanban.turnEnded(e);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      // The retry is a new executed run, so its failure is a new object with its own run id.
      fake.failures.set(e, { ...(stopping as object) } as never);
      yield* kanban.turnEnded(e);
      const n = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      assert.notStrictEqual(n, e);
      const nMsgs = (yield* Ref.get(fake.threads)).get(n)!.messages.map(String).join("\n");
      assert.include(nMsgs, "stopped on an error");
      assert.include(nMsgs, e);
      assert.include(lastText(yield* kanban.messages(channel.id)), "A new evaluator takes over");
      fake.failures.set(n, stopping);
      yield* kanban.turnEnded(n);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      // The retry of n is its own executed run, so it fails with a fresh failure object.
      fake.failures.set(n, { ...(stopping as object) } as never);
      yield* kanban.turnEnded(n);
      assert.isNull((yield* kanban.discussion(channel.id)).evaluatorThreadId);
      assert.include(
        lastText(yield* kanban.messages(channel.id)),
        "No new one starts automatically",
      );
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Still there?" }]);
      assert.isNotNull((yield* kanban.discussion(channel.id)).evaluatorThreadId);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a full context replaces the evaluator without a retry", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      const e = (yield* kanban.discussion(channel.id)).evaluatorThreadId!;
      fake.failures.set(e, {
        class: "provider_error",
        code: null,
        message: "prompt is too long: 213000 tokens > 200000 maximum",
      } as never);
      yield* kanban.turnEnded(e);
      assert.notStrictEqual((yield* kanban.discussion(channel.id)).evaluatorThreadId, e);
      const msgs = (yield* Ref.get(fake.threads)).get(e)!.messages;
      assert.isFalse(msgs.some((m) => String(m).includes("one automatic retry")));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a one-shot evaluator that keeps failing is reported in Evaluator errors", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const t = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look at it" });
      fake.failures.set(t, stopping);
      yield* kanban.turnEnded(t);
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      // The retry is a new executed run, so its failure is a new object with its own run id.
      fake.failures.set(t, { ...(stopping as object) } as never);
      yield* kanban.turnEnded(t);
      const channel = (yield* kanban.discussions(board.id)).find(
        (d) => d.title === "Evaluator errors",
      );
      assert.isDefined(channel);
      assert.include(lastText(yield* kanban.messages(channel!.id)), t);
      assert.isNotNull((yield* kanban.caller(t))?.endedAt);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the backstop doesn't nudge a paused worker", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const before = (yield* Ref.get(fake.threads)).get(workThread)!.messages.length;
      fake.failures.set(workThread, outage);
      yield* kanban.turnEnded(workThread);
      yield* TestClock.adjust("31 minutes");
      yield* kanban.tick;
      assert.strictEqual((yield* Ref.get(fake.threads)).get(workThread)!.messages.length, before);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a reused, already ended evaluator is still woken when its model recovers", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const threadId = yield* kanban.startEvaluator(board.id, { kind: "request", text: "First" });
      yield* kanban.turnEnded(threadId);
      assert.isNotNull((yield* kanban.caller(threadId))?.endedAt ?? null);
      // Reuse the ended evaluator, then fail that run on an outage.
      yield* kanban.startEvaluator(board.id, { kind: "request", text: "Again" });
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      assert.isNotNull((yield* kanban.caller(threadId))?.paused);
      probe.ok = true;
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      const messages = (yield* Ref.get(fake.threads)).get(threadId)!.messages;
      assert.include(messages[messages.length - 1] ?? "", "answers again");
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("a paused link gets exactly one wake when its probe passes", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const threadId = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Once" });
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      const before = (yield* Ref.get(fake.threads)).get(threadId)!.messages.length;
      probe.ok = true;
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      yield* kanban.probeOutages;
      const after = (yield* Ref.get(fake.threads)).get(threadId)!.messages.length;
      assert.strictEqual(after - before, 1);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("a wake reuses one command key per outage", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = true;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const saved = yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const { board } = yield* toyBoard;
        const threadId = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look" });
        fake.failures.set(threadId, outage);
        yield* kanban.turnEnded(threadId);
        const link = (yield* kanban.caller(threadId))!;
        assert.isNotNull(link.paused);
        yield* TestClock.adjust("5 minutes");
        yield* kanban.probeOutages;
        assert.isNull((yield* kanban.caller(threadId))?.paused ?? null);
        return link;
      }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));

      // Restore the persisted pause to simulate a crash after the send but before its clear.
      const store = yield* KanbanStore.KanbanStore;
      yield* store.putThreadLink(saved);
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        yield* kanban.probeOutages;
        const wakes = fake.sends.filter((send) => send.threadId === saved.threadId);
        assert.strictEqual(wakes.length, 2);
        assert.match(wakes[0]?.key ?? "", /^wake:[a-f0-9]{32}$/);
        assert.strictEqual(wakes[1]?.key, wakes[0]?.key);
        assert.isNull((yield* kanban.caller(saved.threadId))?.paused ?? null);

        // A later failure is a distinct outage epoch on that same link.
        fake.failures.set(saved.threadId, { ...outage });
        yield* kanban.turnEnded(saved.threadId);
        assert.notStrictEqual((yield* kanban.caller(saved.threadId))?.paused?.at, saved.paused?.at);
        yield* TestClock.adjust("5 minutes");
        yield* kanban.probeOutages;
        const later = fake.sends.filter((send) => send.threadId === saved.threadId);
        assert.strictEqual(later.length, 3);
        assert.notStrictEqual(later[2]?.key, later[0]?.key);
      }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
    }).pipe(Effect.provide(probeDeps(fake.layer)));
  }),
);

it.effect("a new failed run after an accepted but uncleared wake gets its own wake", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = true;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const saved = yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const { board } = yield* toyBoard;
        const threadId = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look" });
        fake.failures.set(threadId, outage);
        yield* kanban.turnEnded(threadId);
        const link = (yield* kanban.caller(threadId))!;
        assert.isNotNull(link.paused);
        assert.isString(link.paused!.runId);
        yield* TestClock.adjust("5 minutes");
        yield* kanban.probeOutages;
        assert.isNull((yield* kanban.caller(threadId))?.paused ?? null);
        assert.strictEqual(fake.sends.filter((send) => send.threadId === threadId).length, 1);
        return link;
      }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));

      // The accepted wake survived but its pause clear didn't.
      const store = yield* KanbanStore.KanbanStore;
      yield* store.putThreadLink(saved);
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        fake.failures.set(saved.threadId, { ...outage });
        yield* TestClock.adjust("1 minute");
        yield* kanban.turnEnded(saved.threadId);
        const next = (yield* kanban.caller(saved.threadId))?.paused;
        assert.isNotNull(next);
        assert.isDefined(next);
        assert.isString(next?.runId);
        assert.notStrictEqual(next?.at, saved.paused?.at);
        assert.notStrictEqual(next?.runId, saved.paused?.runId);
        yield* TestClock.adjust("5 minutes");
        yield* kanban.probeOutages;
        const wakes = fake.sends.filter((send) => send.threadId === saved.threadId);
        assert.strictEqual(wakes.length, 2);
        assert.match(wakes[0]?.key ?? "", /^wake:[a-f0-9]{32}$/);
        assert.match(wakes[1]?.key ?? "", /^wake:[a-f0-9]{32}$/);
        assert.notStrictEqual(wakes[1]?.key, wakes[0]?.key);
        assert.isNull((yield* kanban.caller(saved.threadId))?.paused ?? null);
      }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
    }).pipe(Effect.provide(probeDeps(fake.layer)));
  }),
);

it.effect("the same failed run reported twice keeps its outage epoch", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = true;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const threadId = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look" });
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      const first = (yield* kanban.caller(threadId))?.paused;
      assert.isNotNull(first);
      assert.isDefined(first);
      assert.isString(first?.runId);
      yield* TestClock.adjust("1 minute");
      yield* kanban.turnEnded(threadId);
      const second = (yield* kanban.caller(threadId))?.paused;
      assert.strictEqual(second?.at, first?.at);
      assert.strictEqual(second?.runId, first?.runId);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      yield* kanban.probeOutages;
      assert.strictEqual(fake.sends.filter((send) => send.threadId === threadId).length, 1);
      assert.isNull((yield* kanban.caller(threadId))?.paused ?? null);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("a legacy pause keeps its epoch when the failure has no run id", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const threadId = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look" });
      fake.failures.set(threadId, outage);
      fake.missingFailureRunIds.add(threadId);
      yield* kanban.turnEnded(threadId);
      const first = (yield* kanban.caller(threadId))?.paused;
      assert.isDefined(first);
      assert.isNotNull(first);
      assert.isNull(first?.runId);
      yield* TestClock.adjust("1 minute");
      yield* kanban.turnEnded(threadId);
      const second = (yield* kanban.caller(threadId))?.paused;
      assert.strictEqual(second?.at, first?.at);
      assert.isNull(second?.runId);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a rejected wake keeps the pause and is retried on the next probe", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const threadId = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look" });
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      probe.ok = true;
      fake.rejectSends.add(threadId);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isNotNull((yield* kanban.caller(threadId))?.paused);
      fake.rejectSends.delete(threadId);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isNull((yield* kanban.caller(threadId))?.paused ?? null);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("a restarted service holds a paused model's pool before its first probe", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const board = yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
        yield* kanban.dispatchNow;
        const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
        fake.failures.set(workThread, outage);
        yield* kanban.turnEnded(workThread);
        return board;
      }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
      // A new service on the same store: its outage map starts empty.
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        yield* kanban.setPool(board.id, board.defaultCardModel, 2);
        const waiting = yield* kanban.createCard(board.id, { prompt: "y", title: "y" }, owner);
        yield* kanban.dispatchNow;
        assert.strictEqual((yield* kanban.card(waiting.id)).card.stage, "todo");
        assert.strictEqual(probe.calls, 0);
        probe.ok = true;
        yield* kanban.probeOutages;
        assert.strictEqual(probe.calls, 1);
        yield* kanban.dispatchNow;
        assert.strictEqual((yield* kanban.card(waiting.id)).card.stage, "working");
      }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
    }).pipe(Effect.provide(probeDeps(fake.layer)));
  }),
);

it.effect("a failed thread read keeps the wake, and it lands once reads recover", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const threadId = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look" });
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      const before = (yield* Ref.get(fake.threads)).get(threadId)!.messages.length;
      probe.ok = true;
      fake.failReads.left = 1;
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isNotNull((yield* kanban.caller(threadId))?.paused);
      assert.strictEqual((yield* Ref.get(fake.threads)).get(threadId)!.messages.length, before);
      yield* kanban.probeOutages;
      const messages = (yield* Ref.get(fake.threads)).get(threadId)!.messages;
      assert.strictEqual(messages.length, before + 1);
      assert.include(messages.at(-1) ?? "", "answers again");
      assert.isNull((yield* kanban.caller(threadId))?.paused ?? null);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("an archived paused evaluator lets its model's pool take work again", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      // The evaluator and the cards share one model, so its pause holds the card pool.
      assert.strictEqual(
        Rules.poolKey(board.evaluatorModel),
        Rules.poolKey(board.defaultCardModel),
      );
      const threadId = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look" });
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(created.id)).card.stage, "todo");
      yield* setArchived(fake, threadId);
      probe.ok = true;
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isNull((yield* kanban.caller(threadId))?.paused ?? null);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(created.id)).card.stage, "working");
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("a paused one-shot evaluator resumed by hand stays resumed after its run", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const threadId = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look" });
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      assert.isNotNull((yield* kanban.caller(threadId))?.paused);
      // The owner told it to go on in the thread, and that run succeeded.
      fake.failures.delete(threadId);
      yield* kanban.turnEnded(threadId);
      const link = yield* kanban.caller(threadId);
      assert.isNull(link?.paused ?? null);
      assert.isNotNull(link?.endedAt ?? null);
      const before = (yield* Ref.get(fake.threads)).get(threadId)!.messages.length;
      probe.ok = true;
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.strictEqual(probe.calls, 0);
      assert.strictEqual((yield* Ref.get(fake.threads)).get(threadId)!.messages.length, before);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("an outage recorded while a probe run is under way stays down and is woken later", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", variant: "xhigh" });
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      yield* kanban.setPool(board.id, sol, 3);
      const first = yield* kanban.createCard(board.id, { prompt: "a", title: "a" }, owner);
      const second = yield* kanban.createCard(
        board.id,
        { prompt: "b", title: "b", model: sol },
        owner,
      );
      yield* kanban.dispatchNow;
      const firstThread = (yield* kanban.card(first.id)).card.activeThreadId!;
      const secondThread = (yield* kanban.card(second.id)).card.activeThreadId!;
      fake.failures.set(firstThread, outage);
      yield* kanban.turnEnded(firstThread);
      yield* TestClock.adjust("5 minutes");
      // Hold the probe run at its first clock read, record the second outage, then let it go.
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const clock = yield* Clock.Clock;
      let held = false;
      const holdingClock: Clock.Clock = {
        ...clock,
        currentTimeMillis: Effect.gen(function* () {
          if (!held) {
            held = true;
            yield* Deferred.succeed(reached, undefined);
            yield* Deferred.await(release);
          }
          return yield* clock.currentTimeMillis;
        }),
      };
      probe.ok = true;
      const probing = yield* kanban.probeOutages.pipe(
        Effect.provideService(Clock.Clock, holdingClock),
        Effect.forkScoped,
      );
      yield* Deferred.await(reached);
      fake.failures.set(secondThread, outage);
      yield* kanban.turnEnded(secondThread);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(probing);
      assert.isNull((yield* kanban.caller(firstThread))?.paused ?? null);
      assert.isNotNull((yield* kanban.caller(secondThread))?.paused ?? null);
      const waiting = yield* kanban.createCard(
        board.id,
        { prompt: "c", title: "c", model: sol },
        owner,
      );
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(waiting.id)).card.stage, "todo");
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isNull((yield* kanban.caller(secondThread))?.paused ?? null);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

const titledLayer = (fake: Layer.Layer<KanbanThreads>, asked: Array<string>) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(
      Layer.mock(TextGeneration.TextGeneration)({
        generateThreadTitle: (input) =>
          Effect.sync(() => {
            asked.push(input.message);
            return { title: "Kafka cert expiry" };
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo" } as never)),
      }),
    ),
    Layer.provideMerge(boardFilesLayer),
  );

it.effect("an owner's channel gets a title from his first message, unless he named it", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const asked: Array<string> = [];
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const titled = Stream.runHead(
        Stream.filter(
          yield* kanban.changes,
          ({ change }) =>
            change._tag === "discussion" && change.discussion.title === "Kafka cert expiry",
        ),
      );

      const channel = yield* kanban.createDiscussion(board.id, "When do the Kafka", owner);
      yield* kanban.post(channel.id, owner, [
        { _tag: "md", text: "When do the Kafka certs expire?" },
      ]);
      assert.isTrue(Option.isSome(yield* titled));
      assert.strictEqual((yield* kanban.discussion(channel.id)).title, "Kafka cert expiry");
      assert.deepStrictEqual(asked, ["When do the Kafka certs expire?"]);

      // Only the first owner message names it.
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "And the CA?" }]);
      assert.lengthOf(asked, 1);

      // A channel the owner named keeps his title.
      const named = yield* kanban.createDiscussion(board.id, "Draft", owner);
      const renamed = yield* kanban.updateDiscussion(named.id, { title: "  Fees  " }, owner);
      assert.strictEqual(renamed.title, "Fees");
      assert.isNotNull(renamed.titleEditedAt);
      yield* kanban.post(named.id, owner, [{ _tag: "md", text: "Round fees up" }]);
      assert.lengthOf(asked, 1);
      assert.strictEqual((yield* kanban.discussion(named.id)).title, "Fees");

      // A card's discussion keeps the card's title.
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const cardTalk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(cardTalk.id, owner, [{ _tag: "md", text: "Note" }]);
      assert.lengthOf(asked, 1);

      const blank = yield* kanban
        .updateDiscussion(named.id, { title: " " }, owner)
        .pipe(Effect.flip);
      assert.strictEqual(blank.code, "invalid");
      const agent = yield* kanban
        .updateDiscussion(
          named.id,
          { title: "Mine" },
          { _tag: "evaluator", threadId: ThreadId.make("t") },
        )
        .pipe(Effect.flip);
      assert.strictEqual(agent.code, "denied");
    }).pipe(Effect.scoped, Effect.provide(titledLayer(fake.layer, asked)));
  }),
);

it.effect("an owner's channel title waits until its evaluator routing is attached", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const asked: Array<string> = [];
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const delayed = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (threads) =>
        KanbanThreads.of({
          ...threads,
          launch: (input) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(threads.launch(input)),
            ),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Kafka", owner);
      const titled = Stream.runHead(
        Stream.filter(
          yield* kanban.changes,
          ({ change }) =>
            change._tag === "discussion" && change.discussion.title === "Kafka cert expiry",
        ),
      );
      const posting = yield* kanban
        .post(channel.id, owner, [{ _tag: "md", text: "When do the Kafka certs expire?" }])
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
      assert.deepEqual(asked, []);
      yield* Deferred.succeed(release, undefined);
      const message = yield* Fiber.join(posting);
      assert.strictEqual(message.seq, 1);
      assert.isTrue(Option.isSome(yield* titled));
      const discussion = yield* kanban.discussion(channel.id);
      assert.strictEqual(discussion.title, "Kafka cert expiry");
      assert.strictEqual(discussion.evaluatorThreadId, "thread-1");
      assert.strictEqual(discussion.lastSeq, 1);
      assert.deepEqual(asked, ["When do the Kafka certs expire?"]);
      assert.strictEqual((yield* Ref.get(fake.threads)).size, 1);
      assert.deepEqual(fake.interrupted, []);
    }).pipe(Effect.scoped, Effect.provide(titledLayer(delayed, asked)));
  }),
);

class ModelDown extends Data.TaggedError("ModelDown")<{}> {}

const groupAsks = (asked: ReadonlyArray<string>) =>
  asked.filter((prompt) => prompt.startsWith("You group"));
const goalAsks = (asked: ReadonlyArray<string>) =>
  asked.filter((prompt) => prompt.startsWith("You keep a work board's goals"));

const scribeLayer = (
  fake: Layer.Layer<KanbanThreads>,
  asked: Array<string>,
  failures = 0,
  calls?: Queue.Queue<string>,
  goalFailures = 0,
  proposalHold?: Deferred.Deferred<void>,
) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(
      Layer.mock(TextGeneration.TextGeneration)({
        generateJson: ((input: { readonly prompt: string }) =>
          Effect.gen(function* () {
            asked.push(input.prompt);
            if (calls) yield* Queue.offer(calls, input.prompt);
            if (input.prompt.startsWith("You suggest goals")) {
              if (proposalHold) yield* Deferred.await(proposalHold);
              return {
                proposals: [{ name: "Search", summary: "People find things.", cards: [1, 2, 3] }],
              };
            }
            if (input.prompt.startsWith("You keep a work board's goals")) {
              if (goalAsks(asked).length <= goalFailures)
                return yield* Effect.fail(new ModelDown());
              const id = /Goal (\S+):/.exec(input.prompt)?.[1] ?? "";
              return {
                assign: [{ card: 2, goal: id }],
                goals: [{ id, now: "Two login cards in progress.", story: "Should be dropped." }],
              };
            }
            if (asked.filter((prompt) => prompt.startsWith("You group")).length <= failures) {
              return yield* Effect.fail(new ModelDown());
            }
            return {
              groups: [{ id: null, name: "Login", summary: "Sign-in work.", cards: [1, 2] }],
            };
          })) as never,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo" } as never)),
      }),
    ),
    Layer.provideMerge(boardFilesLayer),
  );

it.effect("the scribe groups a board's open cards when they change, at most every 10 minutes", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const asked: Array<string> = [];
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const grouped = Effect.gen(function* () {
        const changes = yield* kanban.changes;
        return Stream.runHead(Stream.filter(changes, ({ change }) => change._tag === "groups"));
      });

      const first = yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "Login form", description: "Sign-in page" },
        owner,
      );
      const second = yield* kanban.createCard(
        board.id,
        { prompt: "B", title: "Login errors", description: "Sign-in errors" },
        owner,
      );

      const firstRun = yield* (yield* grouped).pipe(Effect.forkScoped);
      yield* kanban.tick;
      assert.isTrue(Option.isSome(yield* Fiber.join(firstRun)));
      const groups = (yield* kanban.snapshot(board.id)).groups;
      assert.lengthOf(groups, 1);
      assert.strictEqual(groups[0]?.name, "Login");
      assert.deepStrictEqual(groups[0]?.cardIds, [first.id, second.id]);
      assert.lengthOf(groupAsks(asked), 1);
      assert.include(groupAsks(asked)[0] ?? "", "#1 |");

      // Nothing changed: no new run.
      yield* kanban.tick;
      assert.lengthOf(groupAsks(asked), 1);

      // A new card changes the fingerprint, but the last run was under 10 minutes ago.
      yield* kanban.createCard(
        board.id,
        { prompt: "C", title: "Logout", description: "Sign-out" },
        owner,
      );
      yield* kanban.tick;
      assert.lengthOf(groupAsks(asked), 1);

      yield* TestClock.adjust("10 minutes");
      const secondRun = yield* (yield* grouped).pipe(Effect.forkScoped);
      yield* kanban.tick;
      assert.isTrue(Option.isSome(yield* Fiber.join(secondRun)));
      assert.lengthOf(groupAsks(asked), 2);
    }).pipe(Effect.scoped, Effect.provide(scribeLayer(fake.layer, asked)));
  }),
);

it.effect(
  "the scribe proposes a goal in Goal ideas, once, and his answer goes to an evaluator",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const asked: Array<string> = [];
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const posted = Stream.runHead(
          Stream.filter(yield* kanban.changes, ({ change }) => change._tag === "message"),
        );
        for (const [prompt, title] of [
          ["A", "Login form"],
          ["B", "Login button"],
          ["C", "Login errors"],
        ] as const) {
          yield* kanban.createCard(board.id, { prompt, title, description: "Sign-in" }, owner);
        }
        yield* kanban.tick;
        assert.isTrue(Option.isSome(yield* posted));
        const ideas = (yield* kanban.discussions(board.id)).find(
          (entry) => entry.title === "Goal ideas",
        )!;
        const [first] = yield* kanban.messages(ideas.id);
        const choice = first!.blocks.find((block) => block._tag === "choice");
        assert.equal(
          choice?._tag === "choice" ? choice.question : "",
          'Make goal "Search"? People find things. Cards: #1, #2, #3',
        );

        // Unanswered and under 24 hours old: no second post.
        yield* TestClock.adjust("1 hour");
        yield* kanban.tick;
        assert.lengthOf(yield* kanban.messages(ideas.id), 1);

        yield* kanban.answer(ideas.id, first!.seq, "goal-1", ["make"], owner);
        const threads = [...(yield* Ref.get(fake.threads)).values()];
        assert.isTrue(
          threads.some((thread) =>
            thread.messages.some((text) => text.includes('Owner answered "Make goal')),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(scribeLayer(fake.layer, asked)));
    }),
);

const threeLoginCards = (
  kanban: Effect.Success<typeof KanbanService.KanbanService>,
  boardId: string,
) =>
  Effect.forEach(
    [
      ["A", "Login form"],
      ["B", "Login button"],
      ["C", "Login errors"],
    ],
    ([prompt, title]) =>
      kanban.createCard(
        boardId as never,
        { prompt: prompt!, title: title!, description: "Sign-in" },
        owner,
      ),
  );

it.effect(
  "an unanswered proposal still blocks a new one after 20+ replies, with no time passing",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const asked: Array<string> = [];
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const posted = Stream.runHead(
          Stream.filter(yield* kanban.changes, ({ change }) => change._tag === "message"),
        );
        yield* threeLoginCards(kanban, board.id);
        yield* kanban.tick;
        assert.isTrue(Option.isSome(yield* posted));
        const ideas = (yield* kanban.discussions(board.id)).find(
          (entry) => entry.title === "Goal ideas",
        )!;
        for (let index = 0; index < 205; index++) {
          yield* kanban.post(ideas.id, owner, [{ _tag: "md", text: `reply ${index}` }]);
        }
        yield* kanban.tick;
        assert.lengthOf(
          asked.filter((prompt) => prompt.startsWith("You suggest goals")),
          1,
        );
        assert.lengthOf(yield* (yield* KanbanStore.KanbanStore).allMessages(ideas.id), 206);
      }).pipe(Effect.scoped, Effect.provide(scribeLayer(fake.layer, asked)));
    }),
);

it.effect("a skipped proposal is not proposed again after 100+ replies", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const asked: Array<string> = [];
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const posted = Stream.runHead(
        Stream.filter(yield* kanban.changes, ({ change }) => change._tag === "message"),
      );
      yield* threeLoginCards(kanban, board.id);
      yield* kanban.tick;
      assert.isTrue(Option.isSome(yield* posted));
      const ideas = (yield* kanban.discussions(board.id)).find(
        (entry) => entry.title === "Goal ideas",
      )!;
      const [first] = yield* kanban.messages(ideas.id);
      yield* kanban.answer(ideas.id, first!.seq, "goal-1", ["skip"], owner);
      for (let index = 0; index < 205; index++) {
        yield* kanban.post(ideas.id, owner, [{ _tag: "md", text: `reply ${index}` }]);
      }
      yield* TestClock.adjust("25 hours");
      yield* kanban.tick;
      // The skipped Search proposal is still in the history: it is not posted again.
      const messages = yield* (yield* KanbanStore.KanbanStore).allMessages(ideas.id);
      const choices = messages.flatMap((message) =>
        message.blocks.filter((block) => block._tag === "choice"),
      );
      assert.lengthOf(choices, 1);
    }).pipe(Effect.scoped, Effect.provide(scribeLayer(fake.layer, asked)));
  }),
);

it.effect("two overlapping proposal runs post the same proposal only once", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const asked: Array<string> = [];
    const hold = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* threeLoginCards(kanban, board.id);
      yield* kanban.tick;
      // The first run is still waiting on the model; a later tick must not start another.
      yield* TestClock.adjust("30 minutes");
      yield* kanban.tick;
      yield* TestClock.adjust("30 minutes");
      yield* kanban.tick;
      yield* Deferred.succeed(hold, undefined);
      yield* TestClock.adjust("1 second");
      const ideas = (yield* kanban.discussions(board.id)).find(
        (entry) => entry.title === "Goal ideas",
      );
      assert.isTrue(ideas !== undefined);
      assert.lengthOf(yield* kanban.messages(ideas!.id), 1);
      assert.lengthOf(
        asked.filter((prompt) => prompt.startsWith("You suggest goals")),
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(scribeLayer(fake.layer, asked, 0, undefined, 0, hold)));
  }),
);

it.effect("a failed scribe run is retried after the cooldown, even with cards unchanged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const asked: Array<string> = [];
    const calls = yield* Queue.unbounded<string>();
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const changes = yield* kanban.changes;
      const grouped = Effect.gen(function* () {
        return Stream.runHead(Stream.filter(changes, ({ change }) => change._tag === "groups"));
      });
      yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "Login form", description: "Sign-in page" },
        owner,
      );
      yield* kanban.createCard(
        board.id,
        { prompt: "B", title: "Login errors", description: "Sign-in errors" },
        owner,
      );

      // The first model call fails: no groups land and the board is not marked done.
      yield* kanban.tick;
      yield* Queue.take(calls);
      assert.lengthOf(groupAsks(asked), 1);
      assert.lengthOf((yield* kanban.snapshot(board.id)).groups, 0);

      // Cards unchanged, under the cooldown: no retry.
      yield* kanban.tick;
      assert.lengthOf(groupAsks(asked), 1);

      // Cooldown passed, cards unchanged: the failed attempt is retried and succeeds.
      yield* TestClock.adjust("10 minutes");
      const retried = yield* (yield* grouped).pipe(Effect.forkScoped);
      yield* kanban.tick;
      yield* Queue.take(calls);
      assert.isTrue(Option.isSome(yield* Fiber.join(retried)));
      assert.lengthOf(groupAsks(asked), 2);
      assert.lengthOf((yield* kanban.snapshot(board.id)).groups, 1);

      // Success with unchanged cards: no further runs.
      yield* TestClock.adjust("10 minutes");
      yield* kanban.tick;
      assert.lengthOf(groupAsks(asked), 2);
    }).pipe(Effect.scoped, Effect.provide(scribeLayer(fake.layer, asked, 1, calls)));
  }),
);

it.effect("the scribe puts a goal-less card in a matching goal and writes the goal's Now", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const asked: Array<string> = [];
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const login = yield* kanban.setGoal(board.id, { name: "Login" });
      const changed = Effect.gen(function* () {
        const changes = yield* kanban.changes;
        return Stream.runHead(Stream.filter(changes, ({ change }) => change._tag === "goal"));
      });
      const first = yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "Login form", description: "Sign-in page", goalId: login.id },
        owner,
      );
      const second = yield* kanban.createCard(
        board.id,
        { prompt: "B", title: "Login errors", description: "Sign-in errors" },
        owner,
      );

      const run = yield* (yield* changed).pipe(Effect.forkScoped);
      yield* kanban.tick;
      assert.isTrue(Option.isSome(yield* Fiber.join(run)));

      assert.strictEqual((yield* kanban.card(second.id)).card.goalId, login.id);
      assert.strictEqual((yield* kanban.card(first.id)).card.goalId, login.id);
      const goal = (yield* kanban.snapshot(board.id)).goals.find((entry) => entry.id === login.id);
      assert.strictEqual(goal?.now?.text, "Two login cards in progress.");
      assert.lengthOf(goal?.story ?? [], 0);
    }).pipe(Effect.scoped, Effect.provide(scribeLayer(fake.layer, asked)));
  }),
);

it.effect("a failed goal scribe run is retried after the cooldown, even with cards unchanged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const asked: Array<string> = [];
    const calls = yield* Queue.unbounded<string>();
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const login = yield* kanban.setGoal(board.id, { name: "Login" });
      yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "Login form", description: "Sign-in page", goalId: login.id },
        owner,
      );
      const goalChange = Effect.gen(function* () {
        const changes = yield* kanban.changes;
        return Stream.runHead(Stream.filter(changes, ({ change }) => change._tag === "goal"));
      });

      // The first goal call fails; no Now lands and the attempt is not marked done.
      yield* kanban.tick;
      yield* Queue.take(calls);
      assert.lengthOf(goalAsks(asked), 1);
      assert.strictEqual((yield* kanban.snapshot(board.id)).goals[0]?.now, null);

      // Cards unchanged, under the cooldown: no retry.
      yield* kanban.tick;
      assert.lengthOf(goalAsks(asked), 1);

      // Cooldown passed, cards unchanged: the failed pass is retried and writes the Now.
      yield* TestClock.adjust("10 minutes");
      const written = yield* (yield* goalChange).pipe(Effect.forkScoped);
      yield* kanban.tick;
      yield* Queue.take(calls);
      assert.isTrue(Option.isSome(yield* Fiber.join(written)));
      assert.lengthOf(goalAsks(asked), 2);
      assert.strictEqual(
        (yield* kanban.snapshot(board.id)).goals[0]?.now?.text,
        "Two login cards in progress.",
      );
    }).pipe(Effect.scoped, Effect.provide(scribeLayer(fake.layer, asked, 0, calls, 1)));
  }),
);

it.effect("the owner settles and snoozes a discussion; someone else posting brings it back", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = {
        _tag: "evaluator",
        threadId: yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set up" }),
      };
      const talk = yield* kanban.createDiscussion(board.id, "Setup", evaluator);

      let current = yield* kanban.updateDiscussion(talk.id, { settled: true }, owner);
      assert.isNotNull(current.settledAt);
      // The owner's own post leaves it settled.
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Thanks" }]);
      assert.isNotNull((yield* kanban.discussion(talk.id)).settledAt);
      yield* kanban.post(talk.id, evaluator, [{ _tag: "md", text: "One more thing" }]);
      assert.isNull((yield* kanban.discussion(talk.id)).settledAt);

      const later = "2999-01-01T09:00:00.000Z";
      current = yield* kanban.updateDiscussion(talk.id, { settled: true }, owner);
      current = yield* kanban.updateDiscussion(talk.id, { snoozedUntil: later }, owner);
      assert.strictEqual(current.snoozedUntil, later);
      assert.isNull(current.settledAt);
      // Settling clears the snooze; unsettling and unsnoozing undo.
      current = yield* kanban.updateDiscussion(talk.id, { settled: true }, owner);
      assert.isNull(current.snoozedUntil);
      current = yield* kanban.updateDiscussion(talk.id, { settled: false }, owner);
      assert.isNull(current.settledAt);
      current = yield* kanban.updateDiscussion(talk.id, { snoozedUntil: later }, owner);
      current = yield* kanban.updateDiscussion(talk.id, { snoozedUntil: null }, owner);
      assert.isNull(current.snoozedUntil);

      yield* kanban.updateDiscussion(talk.id, { snoozedUntil: later }, owner);
      yield* kanban.post(talk.id, evaluator, [{ _tag: "md", text: "Done" }]);
      assert.isNull((yield* kanban.discussion(talk.id)).snoozedUntil);

      const past = yield* kanban
        .updateDiscussion(talk.id, { snoozedUntil: "1969-12-31T00:00:00.000Z" }, owner)
        .pipe(Effect.flip);
      assert.strictEqual(past.code, "invalid");
      const both = yield* kanban
        .updateDiscussion(talk.id, { settled: true, snoozedUntil: later }, owner)
        .pipe(Effect.flip);
      assert.strictEqual(both.code, "invalid");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("idle discussions settle themselves after a day", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = {
        _tag: "evaluator",
        threadId: yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set up" }),
      };
      const channel = yield* kanban.createDiscussion(board.id, "Channel", evaluator);
      const pinned = yield* kanban.createDiscussion(board.id, "Pinned", evaluator);
      const snoozed = yield* kanban.createDiscussion(board.id, "Snoozed", evaluator);
      // Its own evaluator thread: the others share one, so a running thread
      // there would hold them back too. Not a second setup: a board refuses one
      // while its setup is running.
      const busy: KanbanActor = {
        _tag: "evaluator",
        threadId: yield* kanban.startEvaluator(board.id, { kind: "request", text: "Busy" }),
      };
      const working = yield* kanban.createDiscussion(board.id, "Working", busy);
      yield* kanban.updateDiscussion(pinned.id, { pinned: true }, owner);
      yield* kanban.updateDiscussion(
        snoozed.id,
        { snoozedUntil: "2999-01-01T09:00:00.000Z" },
        owner,
      );

      const card = yield* kanban.createCard(board.id, { prompt: "Ship", title: "Ship" }, owner);
      const cardTalk = yield* kanban.cardDiscussion(card.id);

      // The evaluator thread is running before the first idle day elapses, so
      // its discussion must wait even though its quiet time has passed.
      const runningThread = working.evaluatorThreadId;
      assert.isNotNull(runningThread);
      yield* setRunning(fake, runningThread, true);
      yield* TestClock.adjust("25 hours");
      yield* kanban.tick;
      assert.isNotNull((yield* kanban.discussion(channel.id)).settledAt);
      assert.isNull((yield* kanban.discussion(pinned.id)).settledAt);
      assert.isNull((yield* kanban.discussion(snoozed.id)).settledAt);
      assert.isNull((yield* kanban.discussion(cardTalk.id)).settledAt);
      assert.isNull((yield* kanban.discussion(working.id)).settledAt);
      yield* setRunning(fake, runningThread, false);
      yield* kanban.tick;
      assert.isNotNull((yield* kanban.discussion(working.id)).settledAt);

      // A verified card's discussion settles on the tick after its card does.
      yield* kanban.moveCard(card.id, "verified", "owner", owner);
      yield* kanban.tick;
      assert.isNotNull((yield* kanban.discussion(cardTalk.id)).settledAt);

      // Unsettling brings it back; the day starts again from there.
      yield* kanban.updateDiscussion(channel.id, { settled: false }, owner);
      yield* kanban.tick;
      assert.isNull((yield* kanban.discussion(channel.id)).settledAt);
      yield* TestClock.adjust("25 hours");
      yield* kanban.tick;
      assert.isNotNull((yield* kanban.discussion(channel.id)).settledAt);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("settling a card settles its discussion; waking it brings it back", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "Ship", title: "Ship" }, owner);
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.moveCard(card.id, "verified", "owner", owner);
      yield* kanban.settleCard(card.id);
      assert.isNotNull((yield* kanban.discussion(talk.id)).settledAt);

      yield* kanban.cardThread(card.id, "wake", "again", owner);
      assert.isNull((yield* kanban.discussion(talk.id)).settledAt);

      // A pinned discussion stays out when its card settles.
      const keep = yield* kanban.createCard(board.id, { prompt: "Keep", title: "Keep" }, owner);
      const pinnedTalk = yield* kanban.cardDiscussion(keep.id);
      yield* kanban.updateDiscussion(pinnedTalk.id, { pinned: true }, owner);
      yield* kanban.moveCard(keep.id, "verified", "owner", owner);
      yield* kanban.settleCard(keep.id);
      const stillPinned = yield* kanban.discussion(pinnedTalk.id);
      assert.isNull(stillPinned.settledAt);
      assert.isNotNull(stillPinned.pinnedAt);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("pinning a discussion", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator: KanbanActor = {
        _tag: "evaluator",
        threadId: yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set up" }),
      };
      const talk = yield* kanban.createDiscussion(board.id, "Pin me", evaluator);
      yield* kanban.updateDiscussion(talk.id, { settled: true }, owner);

      let current = yield* kanban.updateDiscussion(talk.id, { pinned: true }, owner);
      assert.isNotNull(current.pinnedAt);
      assert.isNull(current.settledAt);

      current = yield* kanban.updateDiscussion(talk.id, { settled: true }, owner);
      assert.isNull(current.pinnedAt);
      assert.isNotNull(current.settledAt);

      current = yield* kanban.updateDiscussion(talk.id, { pinned: true }, owner);
      current = yield* kanban.updateDiscussion(talk.id, { pinned: false }, owner);
      assert.isNull(current.pinnedAt);
      assert.isNotNull(current.reopenedAt);

      const both = yield* kanban
        .updateDiscussion(talk.id, { pinned: true, settled: true }, owner)
        .pipe(Effect.flip);
      assert.strictEqual(both.code, "invalid");
      const denied = yield* kanban
        .updateDiscussion(talk.id, { pinned: true }, evaluator)
        .pipe(Effect.flip);
      assert.strictEqual(denied.code, "denied");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "an evaluator that only asked on a card stops typing there while it works elsewhere",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const setup = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });
        const evaluator: KanbanActor = { _tag: "evaluator", threadId: setup };
        const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
        yield* kanban.askOwner(
          card.id,
          { question: "Ship?", blocking: false, options: ["A", "B"] },
          evaluator,
          "evaluator",
        );
        yield* kanban.answer((yield* kanban.cardDiscussion(card.id)).id, 1, "q1", ["o1"], owner);
        yield* setRunning(fake, setup, true);

        const talk = yield* kanban.cardDiscussion(card.id);
        const before = talk.participants.find((p) => p.actor._tag === "evaluator");
        assert.isNotNull(before?.typingUntil);

        yield* TestClock.adjust("2 minutes");
        yield* kanban.tick;
        const after = (yield* kanban.cardDiscussion(card.id)).participants.find(
          (p) => p.actor._tag === "evaluator",
        );
        assert.isNull(after?.typingUntil);
        assert.isNull(after?.owes);

        // A board channel's own evaluator is home there, so it keeps typing.
        const channel = yield* kanban.createDiscussion(board.id, "Channel", owner);
        yield* kanban.post(channel.id, evaluator, [{ _tag: "md", text: "On it" }]);
        yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Thanks" }]);
        yield* TestClock.adjust("2 minutes");
        yield* kanban.tick;
        const home = (yield* kanban.discussion(channel.id)).participants.find(
          (p) => p.actor._tag === "evaluator",
        );
        assert.isNotNull(home?.typingUntil);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("turn end clears typing where an agent isn't home, without a nudge", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const setup = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: setup };
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.askOwner(
        card.id,
        { question: "Ship?", blocking: false, options: ["A", "B"] },
        evaluator,
        "evaluator",
      );
      yield* kanban.answer((yield* kanban.cardDiscussion(card.id)).id, 1, "q1", ["o1"], owner);

      yield* kanban.turnEnded(setup);
      const talk = yield* kanban.cardDiscussion(card.id);
      const participant = talk.participants.find((p) => p.actor._tag === "evaluator");
      assert.isNull(participant?.typingUntil);
      assert.isNull(participant?.owes);
      const texts = (yield* Ref.get(fake.threads)).get(setup)!.messages;
      assert.strictEqual(
        texts.filter((text) => text.includes("is waiting for your reply")).length,
        0,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an adopted evaluator is nudged once at turn end", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const setup = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: setup };
      const opened = yield* kanban.createDiscussion(board.id, "Setup", evaluator);
      yield* kanban.post(opened.id, owner, [{ _tag: "md", text: "Question?" }]);

      yield* kanban.turnEnded(setup);
      const current = yield* kanban.discussion(opened.id);
      const participant = current.participants.find((p) => p.actor._tag === "evaluator");
      assert.strictEqual(participant?.owes, "nudged");
      const texts = (yield* Ref.get(fake.threads)).get(setup)!.messages;
      assert.strictEqual(
        texts.filter((text) => text.includes("is waiting for your reply")).length,
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a card discussion's new evaluator takes over from the evaluator that asked", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const setup = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: setup };
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.askOwner(
        card.id,
        { question: "Ship?", blocking: false, options: ["A", "B"] },
        evaluator,
        "evaluator",
      );
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.answer(talk.id, 1, "q1", ["o1"], owner);

      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Actually, go with B" }]);
      const current = yield* kanban.discussion(talk.id);
      assert.notStrictEqual(current.evaluatorThreadId, setup);
      const next = current.evaluatorThreadId!;

      const threads = yield* Ref.get(fake.threads);
      const handoffs = threads.get(setup)!.messages.filter((text) => text.includes(next));
      assert.strictEqual(handoffs.length, 1);
      assert.include(handoffs[0]!, `card #${card.number}`);
      const setupPart = current.participants.find(
        (p) => p.actor._tag === "evaluator" && p.actor.threadId === setup,
      );
      assert.isNull(setupPart?.typingUntil ?? null);
      assert.isNull(setupPart?.owes ?? null);
      assert.include(
        threads.get(next)!.messages[0] ?? "",
        `Evaluator ${setup} asked here before you`,
      );

      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "And one more thing" }]);
      const again = (yield* Ref.get(fake.threads))
        .get(setup)!
        .messages.filter((text) => text.includes(next));
      assert.strictEqual(again.length, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("turn end after a reviewer's verdict still nudges its unanswered card discussion", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: workThread,
      });
      // The pool has one slot: the work thread's turn must end before the reviewer can start.
      yield* kanban.turnEnded(workThread);
      yield* kanban.dispatchNow;
      const reviewThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      assert.notStrictEqual(reviewThread, workThread);
      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Check the fee too" }]);

      // The verdict releases the reviewer's card; its turn end must still nudge.
      yield* kanban.reviewResult(reviewThread, "findings", ["Fee is wrong"]);
      assert.isNull((yield* kanban.card(card.id)).card.activeThreadId);
      yield* kanban.turnEnded(reviewThread);

      const reviewer = (yield* kanban.discussion(talk.id)).participants.find(
        (p) => p.actor._tag === "thread" && p.actor.threadId === reviewThread,
      );
      assert.strictEqual(reviewer?.owes, "nudged");
      const texts = (yield* Ref.get(fake.threads)).get(reviewThread)!.messages;
      assert.strictEqual(
        texts.filter((text) => text.includes("is waiting for your reply")).length,
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a home owner message survives the typing lapse and still gets its nudge", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const setup = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: setup };
      const opened = yield* kanban.createDiscussion(board.id, "Setup", evaluator);
      yield* kanban.post(opened.id, owner, [{ _tag: "md", text: "Question?" }]);

      // The evaluator is idle and home here: typing lapses, the owed reply stays.
      yield* TestClock.adjust("2 minutes");
      yield* kanban.tick;
      const lapsed = (yield* kanban.discussion(opened.id)).participants.find(
        (p) => p.actor._tag === "evaluator",
      );
      assert.isNull(lapsed?.typingUntil);
      assert.strictEqual(lapsed?.owes, "asked");

      yield* kanban.turnEnded(setup);
      const nudged = (yield* kanban.discussion(opened.id)).participants.find(
        (p) => p.actor._tag === "evaluator",
      );
      assert.strictEqual(nudged?.owes, "nudged");
      const texts = (yield* Ref.get(fake.threads)).get(setup)!.messages;
      assert.strictEqual(
        texts.filter((text) => text.includes("is waiting for your reply")).length,
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a new board starts with empty instructions, no review chains and a 0-slot pool per model",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const board = yield* kanban.ensureBoard({
          slug: "fresh",
          name: "Fresh",
          defaultProjectId: null,
        });
        const opus = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "high" });
        assert.deepStrictEqual(
          board.managerModel,
          modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "xhigh" }),
        );
        assert.deepStrictEqual(board.evaluatorModel, opus);
        assert.deepStrictEqual(board.defaultCardModel, opus);
        assert.strictEqual(board.instructions.modelRouting, "");
        assert.strictEqual(board.instructions.reviewerRouting, "");
        assert.strictEqual(board.instructions.escalation, "");
        assert.deepStrictEqual(board.reviewChains, []);
        assert.strictEqual(board.defaultReviewChain, null);
        const snapshot = yield* kanban.snapshot(board.id);
        const keys = snapshot.pools.map((pool) => pool.key).sort();
        const expected = [
          Rules.poolKey(board.managerModel),
          Rules.poolKey(board.evaluatorModel),
          Rules.poolKey(board.defaultCardModel),
        ]
          .filter((key, index, all) => all.indexOf(key) === index)
          .sort();
        assert.deepStrictEqual(keys, expected);
        for (const pool of snapshot.pools) assert.strictEqual(pool.slots, 0);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("createBoard uses the same default models as ensureBoard", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.createBoard({
        slug: "fresh-create",
        name: "Fresh create",
        defaultProjectId: null,
      });
      const opus = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "high" });
      assert.deepStrictEqual(
        board.managerModel,
        modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "xhigh" }),
      );
      assert.deepStrictEqual(board.evaluatorModel, opus);
      assert.deepStrictEqual(board.defaultCardModel, opus);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("new boards fill only missing levels on their matching default models", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const provider = opencodeTestProvider();
    const providerWithFastMode: ServerProvider = {
      ...provider,
      models: provider.models.map((model) =>
        model.slug === "opus/claude-opus-5-5"
          ? {
              ...model,
              capabilities: {
                ...model.capabilities,
                optionDescriptors: [
                  ...(model.capabilities?.optionDescriptors ?? []),
                  { id: "thinking", label: "Thinking", type: "boolean" },
                ],
              },
            }
          : model,
      ),
    };
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const opus = modelSelectionOf({ model: "opus/claude-opus-5-5" });
      const withOtherOption = { ...opus, options: [{ id: "thinking", value: true }] };
      const board = yield* kanban.createBoard({
        slug: "picked-defaults",
        name: "Picked defaults",
        defaultProjectId: null,
        evaluatorModel: withOtherOption,
      });
      assert.deepStrictEqual(board.evaluatorModel.options, [
        { id: "thinking", value: true },
        { id: "variant", value: "high" },
      ]);
      assert.strictEqual(Rules.modelLevel(board.defaultCardModel), "high");
      const stored = (yield* kanban.snapshot(board.id)).board;
      assert.deepStrictEqual(stored.evaluatorModel, board.evaluatorModel);
      assert.deepStrictEqual(stored.defaultCardModel, board.defaultCardModel);
      const pools = (yield* kanban.snapshot(board.id)).pools;
      const cardPool = pools.find((pool) => pool.key === Rules.poolKey(board.defaultCardModel));
      assert.deepStrictEqual(cardPool?.model, board.defaultCardModel);
      const card = yield* kanban.createCard(board.id, { prompt: "A default card" }, owner);
      assert.deepStrictEqual(card.model, board.defaultCardModel);

      const plain = yield* kanban.createBoard({
        slug: "plain-picked-default",
        name: "Plain picked default",
        defaultProjectId: null,
        evaluatorModel: opus,
      });
      assert.strictEqual(Rules.modelLevel(plain.evaluatorModel), "high");

      const explicit = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
      const other = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol" });
      const alternative = yield* kanban.createBoard({
        slug: "other-defaults",
        name: "Other defaults",
        defaultProjectId: null,
        evaluatorModel: other,
      });
      assert.deepStrictEqual(alternative.evaluatorModel, other);
      assert.isNull(Rules.modelLevel(alternative.evaluatorModel));

      const ensured = yield* kanban.ensureBoard({
        slug: "ensure-picked-defaults",
        name: "Ensured defaults",
        defaultProjectId: null,
        managerModel: opus,
        evaluatorModel: explicit,
        defaultCardModel: withOtherOption,
      });
      assert.deepStrictEqual(ensured.managerModel, opus);
      assert.deepStrictEqual(ensured.evaluatorModel, explicit);
      assert.deepStrictEqual(ensured.defaultCardModel.options, board.evaluatorModel.options);
      const ensuredPools = (yield* kanban.snapshot(ensured.id)).pools;
      assert.deepStrictEqual(
        ensuredPools.find((pool) => pool.key === Rules.poolKey(ensured.defaultCardModel))?.model,
        ensured.defaultCardModel,
      );
      const sameManager = yield* kanban.ensureBoard({
        slug: "same-manager",
        name: "Same manager",
        defaultProjectId: null,
        managerModel: {
          ...withOtherOption,
          options: [...withOtherOption.options, { id: "variant", value: "high" }],
        },
        defaultCardModel: opus,
      });
      assert.strictEqual(
        Rules.poolKey(sameManager.managerModel),
        Rules.poolKey(sameManager.defaultCardModel),
      );
      assert.deepStrictEqual(
        (yield* kanban.snapshot(sameManager.id)).pools.find(
          (pool) => pool.key === Rules.poolKey(sameManager.defaultCardModel),
        )?.model,
        sameManager.defaultCardModel,
      );
      const otherCard = yield* kanban.ensureBoard({
        slug: "ensure-other-card",
        name: "Other card",
        defaultProjectId: null,
        defaultCardModel: other,
      });
      assert.deepStrictEqual(otherCard.defaultCardModel, other);
    }).pipe(
      Effect.provide(testLayer(fake.layer, KanbanModels.layerTest(null), [providerWithFastMode])),
    );
  }),
);

it.effect("new board and setup defaults follow canonical model routing", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const nativeProvider: ServerProvider = {
      ...opencodeTestProvider(),
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        {
          slug: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "Xhigh" },
                ],
              },
              { id: "thinking", label: "Thinking", type: "boolean" },
            ],
          },
        },
      ],
    };
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const legacy = modelSelectionOf({ model: "opus/claude-opus-5-5" });
      const native = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
        options: [{ id: "thinking", value: true }],
      };
      const unmapped = yield* kanban.createBoard({
        slug: "native-routing-off",
        name: "Native routing off",
        defaultProjectId: null,
        evaluatorModel: native,
      });
      assert.deepStrictEqual(unmapped.evaluatorModel, native);

      yield* settings.updateSettings({ ardudHarnessMigration: { selections: "apply" } });
      const expected = { ...native, options: [...native.options, { id: "effort", value: "high" }] };
      const board = yield* kanban.createBoard({
        slug: "routed-picked-defaults",
        name: "Routed defaults",
        defaultProjectId: ProjectId.make("project-1"),
        evaluatorModel: native,
      });
      assert.deepStrictEqual(board.evaluatorModel, expected);
      assert.strictEqual(Rules.modelLevel(board.defaultCardModel), "high");
      assert.strictEqual(board.defaultCardModel.instanceId, native.instanceId);
      const ensured = yield* kanban.ensureBoard({
        slug: "routed-card-default",
        name: "Routed card default",
        defaultProjectId: null,
        defaultCardModel: legacy,
      });
      assert.strictEqual(Rules.modelLevel(ensured.defaultCardModel), "high");
      assert.strictEqual(ensured.defaultCardModel.instanceId, native.instanceId);

      const explicit = {
        ...native,
        options: [...native.options, { id: "effort", value: "xhigh" }],
      };
      const explicitBoard = yield* kanban.createBoard({
        slug: "native-explicit",
        name: "Native explicit",
        defaultProjectId: ProjectId.make("project-1"),
        evaluatorModel: explicit,
      });
      assert.deepStrictEqual(explicitBoard.evaluatorModel, explicit);
      yield* kanban.startSetup(explicitBoard.id, { evaluatorModel: explicit });
      assert.deepStrictEqual(
        (yield* kanban.snapshot(explicitBoard.id)).board.evaluatorModel,
        explicit,
      );
      const refused = yield* Effect.exit(
        kanban.createBoard({
          slug: "native-invalid",
          name: "Native invalid",
          defaultProjectId: null,
          evaluatorModel: { ...native, options: [{ id: "effort", value: "unavailable" }] },
        }),
      );
      assert.isTrue(Exit.isFailure(refused));

      yield* kanban.startSetup(board.id, { evaluatorModel: native });
      const after = (yield* kanban.snapshot(board.id)).board;
      assert.deepStrictEqual(after.evaluatorModel, expected);
      assert.deepStrictEqual(
        (yield* Ref.get(fake.threads)).get(after.setup!.threadId)!.model,
        expected,
      );
    }).pipe(
      Effect.provide(
        testLayer(fake.layer, KanbanModels.layerTest(null), [
          opencodeTestProvider(),
          nativeProvider,
        ]),
      ),
    );
  }),
);

it.effect("a board created with picked models uses them and pools exactly those", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const picked = modelSelectionOf({ model: "opus/gpt-6-astra", variant: "xhigh" });
      const board = yield* kanban.ensureBoard({
        slug: "picked",
        name: "Picked",
        defaultProjectId: null,
        evaluatorModel: picked,
        defaultCardModel: picked,
      });
      assert.deepStrictEqual(board.evaluatorModel, picked);
      assert.deepStrictEqual(board.defaultCardModel, picked);
      const snapshot = yield* kanban.snapshot(board.id);
      const keys = snapshot.pools.map((pool) => pool.key).sort();
      assert.deepStrictEqual(
        keys,
        [Rules.poolKey(picked), Rules.poolKey(board.managerModel)].sort(),
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("updateBoard with a new evaluator model adds a 0-slot pool without resizing others", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "grow",
        name: "Grow",
        defaultProjectId: null,
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const newModel = modelSelectionOf({ model: "opus/gpt-6-astra", variant: "xhigh" });
      yield* kanban.updateBoard(board.id, { evaluatorModel: newModel });
      const pools = (yield* kanban.snapshot(board.id)).pools;
      const added = pools.find((pool) => pool.key === Rules.poolKey(newModel));
      assert.isDefined(added);
      assert.strictEqual(added!.slots, 0);
      const card = pools.find((pool) => pool.key === Rules.poolKey(board.defaultCardModel));
      assert.strictEqual(card!.slots, 2);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("ensureBoard on an existing board leaves its settings and pools untouched", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const again = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Other name",
        defaultProjectId: null,
      });
      assert.strictEqual(again.id, board.id);
      assert.strictEqual(again.name, "Toy");
      assert.deepStrictEqual(again.reviewChains, board.reviewChains);
      const pool = (yield* kanban.snapshot(board.id)).pools.find(
        (entry) => entry.key === Rules.poolKey(board.defaultCardModel),
      );
      assert.strictEqual(pool!.slots, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("reopening a board keeps its explicitly selected Opus xhigh models and pools", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const opusXhigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
      const board = yield* kanban.ensureBoard({
        slug: "kept-variants",
        name: "Kept variants",
        defaultProjectId: null,
        evaluatorModel: opusXhigh,
        defaultCardModel: opusXhigh,
      });
      yield* kanban.setPool(board.id, opusXhigh, 2);
      const before = (yield* kanban.snapshot(board.id)).pools;
      const again = yield* kanban.ensureBoard({
        slug: "kept-variants",
        name: "Another name",
        defaultProjectId: null,
      });
      assert.deepStrictEqual(again.managerModel, board.managerModel);
      assert.deepStrictEqual(again.evaluatorModel, opusXhigh);
      assert.deepStrictEqual(again.defaultCardModel, opusXhigh);
      assert.deepStrictEqual((yield* kanban.snapshot(board.id)).pools, before);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a board's picked models keep their options (variant) through creation", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const evaluatorModel = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
      const defaultCardModel = modelSelectionOf({ model: "opus/gpt-6-astra", variant: "xhigh" });
      const board = yield* kanban.ensureBoard({
        slug: "variants",
        name: "Variants",
        defaultProjectId: null,
        evaluatorModel,
        defaultCardModel,
      });
      assert.deepStrictEqual(board.evaluatorModel, evaluatorModel);
      assert.deepStrictEqual(board.defaultCardModel, defaultCardModel);
      const keys = (yield* kanban.snapshot(board.id)).pools.map((pool) => pool.key);
      assert.include(keys, Rules.poolKey(evaluatorModel));
      assert.include(keys, Rules.poolKey(defaultCardModel));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const astraHigh = modelSelectionOf({ model: "opus/gpt-6-astra", variant: "high" });
const astraXhigh = modelSelectionOf({ model: "opus/gpt-6-astra", variant: "xhigh" });

it.effect("refuses a model or variant the provider doesn't offer, and names what it offers", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const astraPool = yield* kanban.setPool(board.id, astraXhigh, 2);
      assert.isDefined(astraPool);
      // A card asking for high on an xhigh-only pool is refused, never run at xhigh instead.
      const refusedCreate = yield* kanban
        .createCard(board.id, { prompt: "x", title: "x", model: astraHigh }, owner)
        .pipe(Effect.flip);
      assert.include(refusedCreate.detail, 'has no "high" variant; it offers: xhigh');

      const accepted = yield* kanban.createCard(
        board.id,
        { prompt: "x", title: "x", model: astraXhigh },
        owner,
      );
      const editRefused = yield* kanban
        .editCard(accepted.id, { model: astraHigh }, owner)
        .pipe(Effect.flip);
      assert.include(editRefused.detail, 'has no "high" variant; it offers: xhigh');
      yield* kanban.editCard(accepted.id, { model: astraXhigh }, owner);

      const poolRefused = yield* kanban.setPool(board.id, astraHigh, 1).pipe(Effect.flip);
      assert.include(poolRefused.detail, 'has no "high" variant; it offers: xhigh');

      const chainRefused = yield* kanban
        .updateBoard(board.id, {
          reviewChains: [{ name: "Critical", steps: [astraHigh] }],
        })
        .pipe(Effect.flip);
      assert.include(chainRefused.detail, 'has no "high" variant; it offers: xhigh');
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("pausing a pool at a variant the provider doesn't offer keeps the pool's variant", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, astraXhigh, 2);
      const paused = yield* kanban.setPool(board.id, astraXhigh, 0);
      const pool = paused.find((candidate) => candidate.key === Rules.poolKey(astraXhigh));
      assert.strictEqual(pool?.slots, 0);
      assert.strictEqual(pool?.model.options?.find((o) => o.id === "variant")?.value, "xhigh");

      const created = yield* kanban.createCard(
        board.id,
        { prompt: "x", title: "x", model: astraXhigh },
        owner,
      );
      assert.strictEqual(created.model.options?.find((o) => o.id === "variant")?.value, "xhigh");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a second offered level of a pooled model is its own pool, and each level's cards run on it",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const opusHigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "high" });
        const opusXhigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
        yield* kanban.setPool(board.id, opusHigh, 2);
        const pools = yield* kanban.setPool(board.id, opusXhigh, 1);
        assert.notStrictEqual(Rules.poolKey(opusHigh), Rules.poolKey(opusXhigh));
        assert.strictEqual(pools.find((pool) => pool.key === Rules.poolKey(opusHigh))?.slots, 2);
        assert.strictEqual(pools.find((pool) => pool.key === Rules.poolKey(opusXhigh))?.slots, 1);

        const xhigh = yield* kanban.createCard(
          board.id,
          { prompt: "x", title: "x", model: opusXhigh },
          owner,
        );
        const high = yield* kanban.createCard(
          board.id,
          { prompt: "h", title: "h", model: opusHigh },
          owner,
        );
        const waits = yield* kanban.createCard(
          board.id,
          { prompt: "w", title: "w", model: opusXhigh },
          owner,
        );
        assert.strictEqual(Rules.modelLevel(high.model), "high");
        assert.strictEqual(Rules.modelLevel(xhigh.model), "xhigh");
        yield* kanban.dispatchNow;
        assert.strictEqual((yield* kanban.card(high.id)).card.activePool, Rules.poolKey(opusHigh));
        assert.strictEqual(
          (yield* kanban.card(xhigh.id)).card.activePool,
          Rules.poolKey(opusXhigh),
        );
        // The xhigh pool's one slot is taken; the high pool's free slot doesn't run an xhigh card.
        assert.strictEqual((yield* kanban.card(waits.id)).card.stage, "todo");

        // With two Opus pools, a request with no level names no pool.
        const opus = modelSelectionOf({ model: "opus/claude-opus-5-5" });
        const ambiguous = yield* kanban.setPool(board.id, opus, 3).pipe(Effect.flip);
        assert.strictEqual(ambiguous.code, "invalid");
        assert.include(
          ambiguous.detail,
          "opus/claude-opus-5-5 has pools at high, xhigh; name the level",
        );
        const removeAmbiguous = yield* kanban.removePool(board.id, opus).pipe(Effect.flip);
        assert.include(removeAmbiguous.detail, "name the level");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a no-level set or remove with a no-level pool and a leveled pool names the level", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const astraPlain = modelSelectionOf({ model: "opus/gpt-6-astra" });
      yield* kanban.setPool(board.id, astraPlain, 1);
      yield* kanban.setPool(board.id, astraXhigh, 2);
      const set = yield* kanban.setPool(board.id, astraPlain, 3).pipe(Effect.flip);
      assert.strictEqual(set.code, "invalid");
      assert.include(set.detail, "name the level");
      const removed = yield* kanban.removePool(board.id, astraPlain).pipe(Effect.flip);
      assert.include(removed.detail, "name the level");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a no-level pool named by its key stays addressable once a second level is added", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      // Add model on a provider with no default: the first add is level-less, the next leveled.
      const astraPlain = modelSelectionOf({ model: "opus/gpt-6-astra" });
      const first = yield* kanban.setPool(board.id, astraPlain, 0);
      const plainKey = first.find((pool) => Rules.modelLevel(pool.model) === null)?.key;
      assert.isDefined(plainKey);
      yield* kanban.setPool(board.id, astraXhigh, 0);
      // The original row's controls send its own key: they reach that pool, not the leveled one.
      const resized = yield* kanban.setPool(board.id, astraPlain, 2, { replaces: plainKey });
      assert.strictEqual(resized.find((pool) => pool.key === plainKey)?.slots, 2);
      const paused = yield* kanban.setPool(board.id, astraPlain, 0, { replaces: plainKey });
      assert.strictEqual(paused.find((pool) => pool.key === plainKey)?.slots, 0);
      const removed = yield* kanban.removePool(board.id, astraPlain, { replaces: plainKey });
      assert.isUndefined(removed.find((pool) => pool.key === plainKey));
      assert.strictEqual(removed.filter((pool) => pool.model.model === astraXhigh.model).length, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an alias with an explicit level runs on that level's pool, not the first", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const opusHigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "high" });
      const opusXhigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
      yield* kanban.setPool(board.id, opusXhigh, 1);
      yield* kanban.setPool(board.id, opusHigh, 1);
      const alias = modelSelectionOf({
        instanceId: "opus",
        model: "claude-opus-5-5",
        variant: "xhigh",
      });
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "a", title: "a", model: alias },
        owner,
      );
      assert.strictEqual(Rules.modelLevel(created.model), "xhigh");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "an effort alias at a level no pool has is refused, not run on another level's pool",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const claudeXhigh: ModelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-5-5",
          options: [{ id: "effort", value: "xhigh" }],
        };
        yield* kanban.setPool(board.id, claudeXhigh, 1);
        const alias: ModelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-5-5",
          options: [{ id: "effort", value: "max" }],
        };
        const refused = yield* kanban
          .createCard(board.id, { prompt: "a", title: "a", model: alias }, owner)
          .pipe(Effect.flip);
        assert.include(String(refused.message ?? refused), "no pool runs");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a short model name with two level pools of one model still resolves to the level", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const opusXhigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
      const opusHigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "high" });
      yield* kanban.setPool(board.id, opusXhigh, 1);
      yield* kanban.setPool(board.id, opusHigh, 1);
      // Short name, default instance: both pools are levels of the one model opus/claude-opus-5-5.
      const short = modelSelectionOf({ model: "claude-opus-5-5", variant: "xhigh" });
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "s", title: "s", model: short },
        owner,
      );
      assert.strictEqual(Rules.modelLevel(created.model), "xhigh");
      assert.strictEqual(created.model.model, "opus/claude-opus-5-5");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "changing a pool's level moves its open cards and running thread, not finished cards",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const opusXhigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
        const oldKey = Rules.poolKey(board.defaultCardModel);
        // toyBoard's card pool is the default card model (Opus high) with 1 slot.
        const running = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
        yield* kanban.dispatchNow;
        const thread = (yield* kanban.card(running.id)).card.activeThreadId!;
        const waiting = yield* kanban.createCard(board.id, { prompt: "B", title: "B" }, owner);
        const done = yield* kanban.createCard(board.id, { prompt: "C", title: "C" }, owner);
        yield* kanban.moveCard(done.id, "completed", "owner", owner);
        assert.strictEqual(Rules.modelLevel(waiting.model), "high");

        const pools = yield* kanban.setPool(board.id, opusXhigh, undefined, { replaces: oldKey });

        assert.isFalse(pools.some((pool) => pool.key === oldKey));
        assert.strictEqual(pools.find((pool) => pool.key === Rules.poolKey(opusXhigh))?.slots, 1);
        const after = (yield* kanban.card(running.id)).card;
        assert.strictEqual(Rules.modelLevel(after.model), "xhigh");
        assert.strictEqual(after.activePool, Rules.poolKey(opusXhigh));
        assert.strictEqual(Rules.modelLevel((yield* kanban.card(waiting.id)).card.model), "xhigh");
        assert.strictEqual(Rules.modelLevel((yield* kanban.card(done.id)).card.model), "high");
        const switches = fake.modelSwitches.filter((entry) => entry.threadId === thread);
        assert.strictEqual(switches.length, 1);
        assert.strictEqual(Rules.modelLevel(switches[0]!.model), "xhigh");
        const events = (yield* kanban.card(waiting.id)).events;
        assert.isTrue(
          events.some((event) => event.kind === "edited" && event.body === "model level: xhigh"),
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("a level change refuses a level another pool of the model already has", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const haikuMax = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "max" });
      // toyBoard already has the manager's Haiku xhigh pool.
      yield* kanban.setPool(board.id, haikuMax, 2);
      const refused = yield* kanban
        .setPool(board.id, haikuMax, undefined, { replaces: Rules.poolKey(board.managerModel) })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "conflict");
      assert.include(refused.detail, "already has a pool at max");
      const other = yield* kanban
        .setPool(board.id, board.defaultCardModel, undefined, { replaces: Rules.poolKey(haikuMax) })
        .pipe(Effect.flip);
      assert.include(other.detail, "a level change keeps the model");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a work thread holding its slot between cards follows its pool's new level", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const opusXhigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      // The thread's own move mid-turn: it keeps the slot as a hold until its turn ends.
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: thread,
      });
      yield* kanban.setPool(board.id, opusXhigh, undefined, {
        replaces: Rules.poolKey(board.defaultCardModel),
      });
      // Its hold is on the new pool, so a follow-up card on its (xhigh) pool is its own to take.
      const follow = yield* kanban.createForThread(thread, { prompt: "B", title: "B" });
      assert.strictEqual(follow.card.activePool, Rules.poolKey(opusXhigh));
      assert.strictEqual(Rules.modelLevel(follow.card.model), "xhigh");
      // Its card is in review, so only the hold names the thread: it still switches live.
      const switched = fake.modelSwitches.filter((entry) => entry.threadId === thread);
      assert.strictEqual(switched.length, 1);
      assert.strictEqual(Rules.modelLevel(switched[0]!.model), "xhigh");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a level change keeps the composer's model check, as a plain setPool does", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const listed = yield* Ref.make<KanbanModels.ListedModels | null>(null);
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const haikuMax = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "max" });
      // A pause (0 slots) is allowed while the model is listed; then the model leaves the list.
      yield* kanban.setPool(board.id, board.managerModel, 0);
      yield* Ref.set(
        listed,
        new Map([
          [board.managerModel.instanceId as string, new Set([board.defaultCardModel.model])],
        ]),
      );
      // Same key: resizing the hidden model's pool is refused.
      const sameKey = yield* kanban
        .setPool(board.id, board.managerModel, 1, { replaces: Rules.poolKey(board.managerModel) })
        .pipe(Effect.flip);
      assert.strictEqual(sameKey.code, "invalid");
      assert.include(sameKey.detail, "isn't in the model list");
      // Rekey: a level change to the hidden model is refused too.
      const rekey = yield* kanban
        .setPool(board.id, haikuMax, 1, { replaces: Rules.poolKey(board.managerModel) })
        .pipe(Effect.flip);
      assert.strictEqual(rekey.code, "invalid");
      assert.include(rekey.detail, "isn't in the model list");
      const pools = (yield* kanban.snapshot(board.id)).pools;
      assert.strictEqual(
        pools.find((pool) => pool.key === Rules.poolKey(board.managerModel))?.slots,
        0,
      );
    }).pipe(Effect.provide(testLayer(fake.layer, listedLayer(listed))));
  }),
);

it.effect("a zero-slot level change never switches a running card to an unoffered level", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const invalid = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "ultra" });
      const running = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(running.id)).card.activeThreadId!;
      const oldKey = Rules.poolKey(board.defaultCardModel);
      // A pause of the same pool keeps its stored level (the plain path's exemption).
      const paused = yield* kanban.setPool(board.id, invalid, 0);
      assert.strictEqual(paused.find((pool) => pool.key === oldKey)?.slots, 0);
      assert.strictEqual(Rules.modelLevel((yield* kanban.card(running.id)).card.model), "high");
      // A level change at 0 slots still stores and switches to `invalid`: refused.
      const refused = yield* kanban
        .setPool(board.id, invalid, 0, { replaces: oldKey })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "invalid");
      assert.strictEqual(Rules.modelLevel((yield* kanban.card(running.id)).card.model), "high");
      assert.isFalse(fake.modelSwitches.some((entry) => entry.threadId === thread));
      assert.isTrue((yield* kanban.snapshot(board.id)).pools.some((pool) => pool.key === oldKey));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a level change whose write fails leaves the pool and its cards on the old level", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const opusXhigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
      const oldKey = Rules.poolKey(board.defaultCardModel);
      const waiting = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      rekeyFailures.remaining = 1;
      const failed = yield* kanban
        .setPool(board.id, opusXhigh, undefined, { replaces: oldKey })
        .pipe(Effect.flip);
      assert.strictEqual(rekeyFailures.remaining, 0);
      assert.strictEqual(failed.code, "failed");
      const pools = (yield* kanban.snapshot(board.id)).pools;
      assert.isTrue(pools.some((pool) => pool.key === oldKey));
      assert.isFalse(pools.some((pool) => pool.key === Rules.poolKey(opusXhigh)));
      const after = yield* kanban.card(waiting.id);
      assert.strictEqual(Rules.modelLevel(after.card.model), "high");
      assert.isFalse(after.events.some((event) => event.body === "model level: xhigh"));
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("a pause at a level the provider doesn't offer, with two pools, needs the level", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const haikuMax = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "max" });
      const haikuXhigh = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "xhigh" });
      const haikuUltra = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "ultra" });
      yield* kanban.setPool(board.id, haikuMax, 3);
      yield* kanban.setPool(board.id, haikuXhigh, 1);
      const refused = yield* kanban.setPool(board.id, haikuUltra, 0).pipe(Effect.flip);
      assert.include(refused.detail, 'has no "ultra" variant');
      const pools = (yield* kanban.snapshot(board.id)).pools;
      assert.strictEqual(pools.find((pool) => pool.key === Rules.poolKey(haikuMax))?.slots, 3);
      assert.strictEqual(pools.find((pool) => pool.key === Rules.poolKey(haikuXhigh))?.slots, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a resize with no level keeps the model's one pool and its level", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const pools = yield* kanban.setPool(
        board.id,
        modelSelectionOf({ model: "opus/claude-opus-5-5" }),
        3,
      );
      const opus = pools.filter((pool) => pool.model.model === "opus/claude-opus-5-5");
      assert.strictEqual(opus.length, 1);
      assert.strictEqual(opus[0]?.slots, 3);
      assert.strictEqual(opus[0]?.key, Rules.poolKey(board.defaultCardModel));
      assert.strictEqual(Rules.modelLevel(opus[0]!.model), "high");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an outage on one level of a model holds every pool of that model", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const opusXhigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      yield* kanban.setPool(board.id, opusXhigh, 2);
      const first = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(first.id)).card.activeThreadId!;
      fake.failures.set(workThread, outage);
      yield* kanban.turnEnded(workThread);
      const xhigh = yield* kanban.createCard(
        board.id,
        { prompt: "xhigh", title: "xhigh", model: opusXhigh },
        owner,
      );
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(xhigh.id)).card.stage, "todo");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "pools stored under the old instance/model key are rekeyed at start, with their cards",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      // The manager's pool (toyBoard: Haiku xhigh); like the live boards, one pool per model.
      const haiku = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "xhigh" });
      const legacy = modelSelectionOf({ model: "gpt-6-astra" });
      yield* Effect.gen(function* () {
        const { board, cardId, order } = yield* Effect.gen(function* () {
          const { kanban, board } = yield* toyBoard;
          const store = yield* KanbanStore.KanbanStore;
          yield* kanban.setPool(board.id, haiku, 3);
          const card = yield* kanban.createCard(
            board.id,
            { prompt: "x", title: "x", model: haiku },
            owner,
          );
          yield* kanban.dispatchNow;
          // Write the rows as the old code stored them: key instance/model, level only in the model.
          for (const pool of yield* store.pools(board.id)) {
            yield* store.rekeyBoard(
              board.id,
              [{ from: pool.key, pool: { ...pool, key: Rules.modelKey(pool.model) } }],
              [],
            );
          }
          yield* store.putPool(board.id, { key: Rules.poolKey(legacy), model: legacy, slots: 0 });
          const running = (yield* store.card(card.id))!;
          assert.strictEqual(running.activePool, Rules.poolKey(haiku));
          yield* store.putCard({ ...running, activePool: Rules.modelKey(haiku) });
          const order = (yield* store.pools(board.id)).map((pool) => pool.model);
          return { board, cardId: card.id, order };
        }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
        // A new service on the same store rekeys before anything reads.
        yield* Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          const pools = (yield* kanban.snapshot(board.id)).pools;
          assert.deepStrictEqual(
            pools.map((pool) => pool.key),
            order.map((model) => Rules.poolKey(model)),
          );
          assert.include(
            pools.map((pool) => pool.key),
            "opencode/opus/cc/claude-haiku-5-5#xhigh",
          );
          assert.include(
            pools.map((pool) => pool.key),
            "opencode/gpt-6-astra",
          );
          assert.strictEqual((yield* kanban.card(cardId)).card.activePool, Rules.poolKey(haiku));
        }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
        // A third start changes nothing.
        yield* Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          const pools = (yield* kanban.snapshot(board.id)).pools;
          assert.deepStrictEqual(
            pools.map((pool) => pool.key),
            order.map((model) => Rules.poolKey(model)),
          );
        }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
      }).pipe(Effect.provide(probeDeps(fake.layer)));
    }),
);

it.effect.each([false, true])(
  "first-boot requests wait for pool rekey with transient read failure %s",
  (failFirstRead) =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const store = yield* KanbanStore.KanbanStore;
        const { board } = yield* toyBoard.pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
        const haiku = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "xhigh" });
        const oldKey = Rules.modelKey(haiku);
        const pool = (yield* store.pools(board.id)).find(
          (pool) => pool.key === Rules.poolKey(haiku),
        )!;
        yield* store.rekeyBoard(
          board.id,
          [{ from: pool.key, pool: { ...pool, key: oldKey, slots: 1 } }],
          [],
        );
        const sql = yield* SqlClient.SqlClient;
        const ready = yield* Deferred.make<void>();
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const failed = yield* Deferred.make<void>();
        let attempts = 0;
        const rekeying = Layer.succeed(
          KanbanStore.KanbanStore,
          KanbanStore.KanbanStore.of({
            ...store,
            boards: Effect.suspend(() => {
              attempts++;
              return failFirstRead && attempts === 1
                ? Deferred.succeed(failed, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new KanbanStore.KanbanStoreError({
                          operation: "read boards",
                          cause: "transient",
                        }),
                      ),
                    ),
                  )
                : store.boards;
            }),
            rekeyBoard: (id, pools, cards) =>
              Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(store.rekeyBoard(id, pools, cards)),
              ),
          }),
        );
        yield* Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          const changed = yield* Deferred.make<void>();
          const write = yield* kanban
            .setPool(board.id, haiku, 2)
            .pipe(Effect.andThen(Deferred.succeed(changed, undefined)), Effect.forkScoped);
          yield* Effect.yieldNow;
          assert.isFalse(yield* Deferred.isDone(changed));
          const snapshots = yield* Effect.forEach([1, 2], () =>
            kanban.watch(board.id).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped),
          );
          yield* Effect.yieldNow;
          const builders = yield* ReplyBuilders.ReplyBuilders;
          assert.isTrue(
            yield* builders.interactive.takeIfAvailable(2),
            "board startup waits must not occupy reply builders",
          );
          yield* builders.interactive.release(2);
          yield* Deferred.succeed(ready, undefined);
          if (failFirstRead) {
            yield* Deferred.await(failed);
            assert.isFalse(yield* Deferred.isDone(changed));
            yield* TestClock.adjust("1 second");
          }
          yield* Deferred.await(reached);
          assert.isFalse(yield* Deferred.isDone(changed));
          assert.isTrue(
            yield* builders.interactive.takeIfAvailable(2),
            "pool rekey waits must not occupy reply builders",
          );
          yield* builders.interactive.release(2);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(write);
          yield* Effect.forEach(snapshots, Fiber.join);
          const pools = yield* store.pools(board.id);
          assert.isFalse(pools.some((pool) => pool.key === oldKey));
          assert.strictEqual(pools.find((pool) => pool.key === Rules.poolKey(haiku))?.slots, 2);
          assert.isAtLeast(attempts, failFirstRead ? 2 : 1);
        }).pipe(
          Effect.provide(Layer.fresh(KanbanService.layer).pipe(Layer.provide(rekeying))),
          Effect.provideService(
            BoardsDatabase.BoardsDatabase,
            BoardsDatabase.BoardsDatabase.of({
              sql,
              ready: Deferred.await(ready),
              path: ":memory:",
            }),
          ),
          Effect.provide(ReplyBuilders.layer),
        );
      }).pipe(Effect.provide(probeDeps(fake.layer)));
    }),
);

it.effect(
  "a failed rekey leaves cards and pools on old keys, and dispatch still honours the slot",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const haiku = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "xhigh" });
      yield* Effect.gen(function* () {
        const { board, runningId, waitingId } = yield* Effect.gen(function* () {
          const { kanban, board } = yield* toyBoard;
          const store = yield* KanbanStore.KanbanStore;
          yield* kanban.setPool(board.id, haiku, 1);
          const running = yield* kanban.createCard(
            board.id,
            { prompt: "a", title: "a", model: haiku },
            owner,
          );
          yield* kanban.dispatchNow;
          // Old rows: pool and card keyed instance/model, level only in the model.
          const running0 = (yield* store.card(running.id))!;
          const moves = (yield* store.pools(board.id)).map((pool) => ({
            from: pool.key,
            pool: { ...pool, key: Rules.modelKey(pool.model) },
          }));
          yield* store.rekeyBoard(board.id, moves, [
            { ...running0, activePool: Rules.modelKey(haiku) },
          ]);
          const waiting = yield* kanban.createCard(
            board.id,
            { prompt: "b", title: "b", model: haiku },
            owner,
          );
          return { board, runningId: running.id, waitingId: waiting.id };
        }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));

        // The first start's rekey write fails: startup must survive, nothing half-moved.
        rekeyFailures.remaining = 1;
        yield* Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          const store = yield* KanbanStore.KanbanStore;
          const pools = (yield* kanban.snapshot(board.id)).pools;
          assert.deepStrictEqual(
            pools.map((pool) => pool.key),
            pools.map((pool) => Rules.modelKey(pool.model)),
          );
          assert.strictEqual((yield* store.card(runningId))!.activePool, Rules.modelKey(haiku));
          // Dispatch still counts the running card against the one slot.
          yield* kanban.dispatchNow;
          assert.strictEqual((yield* kanban.card(runningId)).card.stage, "working");
          assert.strictEqual((yield* kanban.card(waitingId)).card.stage, "todo");
        }).pipe(Effect.provide(Layer.fresh(KanbanService.layer)));
        assert.strictEqual(rekeyFailures.remaining, 0);
      }).pipe(Effect.provide(probeDeps(fake.layer)));
    }),
);

it.effect("the pool's variant wins on create and edit", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, astraXhigh, 1);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "x", title: "x", model: astraXhigh },
        owner,
      );
      assert.strictEqual(created.model.options?.find((o) => o.id === "variant")?.value, "xhigh");
      const refused = yield* kanban
        .editCard(created.id, { models: [{ model: astraHigh, weight: 1 }] }, owner)
        .pipe(Effect.flip);
      assert.include(refused.detail, 'has no "high" variant; it offers: xhigh');
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the pool's variant wins for a create without an explicit model", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      // A default with no level resolves to the existing high pool's level.
      const opus = modelSelectionOf({ model: "opus/claude-opus-5-5" });
      const updated = yield* kanban.updateBoard(board.id, { defaultCardModel: opus });
      assert.isNull(Rules.modelLevel(updated.defaultCardModel));
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      assert.strictEqual(created.model.options?.find((o) => o.id === "variant")?.value, "high");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a card model change moves its open thread to the new pool's slot", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const haiku = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "xhigh" });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      yield* kanban.setPool(board.id, haiku, 1);
      const card = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const started = (yield* kanban.card(card.id)).card;
      assert.strictEqual(started.activePool, Rules.poolKey(board.defaultCardModel));
      yield* kanban.editCard(card.id, { model: haiku }, owner);
      const moved = (yield* kanban.card(card.id)).card;
      assert.strictEqual(moved.activePool, Rules.poolKey(haiku));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "steer on a sibling card after a shared thread's model switch carries the new model",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const haiku = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "xhigh" });
        yield* kanban.setPool(board.id, board.defaultCardModel, 2);
        yield* kanban.setPool(board.id, haiku, 1);
        const first = yield* kanban.createCard(board.id, { prompt: "a", title: "a" }, owner);
        yield* kanban.dispatchNow;
        const thread = (yield* kanban.card(first.id)).card.activeThreadId;
        assert.isNotNull(thread);
        const second = yield* kanban.createForThread(thread!, { prompt: "b", title: "b" });
        const sharedId = second.card.id;
        assert.strictEqual(second.card.activeThreadId, thread);
        // A switch on the first card moves the whole shared thread to Haiku.
        yield* kanban.editCard(first.id, { model: haiku }, owner);
        const sibling = (yield* kanban.card(sharedId)).card;
        assert.strictEqual(sibling.model.model, haiku.model);
        yield* kanban.cardThread(sharedId, "steer", "go on", owner);
        assert.strictEqual(fake.sends[fake.sends.length - 1]?.model?.model, haiku.model);
        yield* kanban.cardThread(sharedId, "wake", "again", owner);
        assert.strictEqual(fake.sends[fake.sends.length - 1]?.model?.model, haiku.model);
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("steer through a released sibling keeps the thread on the switched model", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const haiku = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "xhigh" });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      yield* kanban.setPool(board.id, haiku, 1);
      const a = yield* kanban.createCard(board.id, { prompt: "a", title: "a" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(a.id)).card.activeThreadId;
      assert.isNotNull(thread);
      const b = yield* kanban.createForThread(thread!, { prompt: "b", title: "b" });
      // B goes to review and is released from the thread; A stays on it.
      const bThread: KanbanActor = { _tag: "thread", threadId: thread! };
      yield* kanban.moveCard(b.card.id, "needs_review", "cardThread", bThread, { note: "done" });
      assert.strictEqual((yield* kanban.card(b.card.id)).card.stage, "needs_review");
      yield* kanban.editCard(a.id, { model: haiku }, owner);
      yield* kanban.cardThread(b.card.id, "steer", "go on", owner);
      assert.strictEqual(fake.sends[fake.sends.length - 1]?.model?.model, haiku.model);
      assert.strictEqual(fake.sends[fake.sends.length - 1]?.threadId, thread);
      // A is released too, so the thread has no active card left; it still runs Haiku.
      const aThread: KanbanActor = { _tag: "thread", threadId: thread! };
      yield* kanban.moveCard(a.id, "needs_review", "cardThread", aThread, { note: "done" });
      yield* kanban.cardThread(b.card.id, "steer", "again", owner);
      assert.strictEqual(fake.sends[fake.sends.length - 1]?.model?.model, haiku.model);
      assert.strictEqual(fake.sends[fake.sends.length - 1]?.threadId, thread);
      // The turn ends: the hold goes, and only the thread's live model still names Haiku.
      yield* kanban.turnEnded(thread!);
      // A follow-up card on that thread, with no model, inherits the switched Haiku model
      // and takes the Haiku slot instead of being denied for running Opus.
      const follow = yield* kanban.createForThread(thread!, { prompt: "c", title: "c" });
      assert.strictEqual(follow.card.model.model, haiku.model);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a card model change switches its open work thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const haiku = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", variant: "xhigh" });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const card = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const started = (yield* kanban.card(card.id)).card;
      assert.isNotNull(started.activeThreadId);
      yield* kanban.setPool(board.id, haiku, 1);
      yield* kanban.editCard(card.id, { model: haiku }, owner);
      const switches = fake.modelSwitches.filter((s) => s.threadId === started.activeThreadId);
      assert.strictEqual(switches.length, 1);
      assert.strictEqual(switches[0]!.model.model, "opus/cc/claude-haiku-5-5");
      yield* kanban.editCard(card.id, { priority: 2 }, owner);
      assert.strictEqual(
        fake.modelSwitches.filter((s) => s.threadId === started.activeThreadId).length,
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("steer carries the card's model to its thread", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, astraXhigh, 1);
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "x", title: "x", model: astraXhigh },
        owner,
      );
      yield* kanban.dispatchNow;
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      yield* kanban.cardThread(card.id, "steer", "go on", evaluator);
      const last = fake.sends[fake.sends.length - 1];
      assert.strictEqual(last?.model?.model, astraXhigh.model);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("ensureBoard refuses a default card model the provider doesn't offer", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const refused = yield* kanban
        .ensureBoard({
          slug: "bad-toy",
          name: "Bad toy",
          defaultProjectId: ProjectId.make("project-1"),
          defaultCardModel: astraHigh,
        })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "invalid");
      assert.include(refused.detail, "it offers: xhigh");
      const boards = yield* kanban.boards;
      assert.isFalse(boards.some((board) => board.slug === "bad-toy"));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("repairing one review-chain step is not blocked by another invalid step", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const missing = modelSelectionOf({ model: "opus/retired-model" });
      const repaired = modelSelectionOf({ model: "opus/gpt-6-astra", variant: "xhigh" });
      // Both steps are invalid under the fake catalog: one unknown model, one bad variant.
      // Written to the store directly: updateBoard itself now refuses them.
      const store = yield* KanbanStore.KanbanStore;
      const current = (yield* store.boards).find((candidate) => candidate.id === board.id);
      yield* store.putBoard({
        ...current!,
        reviewChains: [{ name: "Critical", steps: [missing, astraHigh] }],
      });
      const stored = yield* kanban.updateBoard(board.id, {
        reviewChains: [{ name: "Critical", steps: [repaired, astraXhigh] }],
      });
      assert.deepStrictEqual(stored.reviewChains[0]?.steps, [repaired, astraXhigh]);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a card stored with an invalid model is not started and is flagged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      const store = yield* KanbanStore.KanbanStore;
      // A pool for the bad model lets dispatch pick the card, so the refusal is what stops it.
      // Written to the store directly: setPool itself now refuses the model.
      yield* store.putPool(board.id, {
        key: Rules.poolKey(astraHigh),
        model: astraHigh,
        slots: 1,
      });
      const stored = yield* store.card(created.id);
      yield* store.putCard({ ...stored!, model: astraHigh });
      yield* kanban.dispatchNow;
      const after = (yield* kanban.card(created.id)).card;
      assert.isNull(after.activeThreadId);
      assert.isTrue(after.stalled?.reason.startsWith("Model refused") === true);
      // The refusal starts only the discussion evaluator's note; no work or review thread.
      const launched = [...(yield* Ref.get(fake.threads)).values()];
      const workOrReview = launched.filter((t) => !t.title.startsWith("Evaluator:"));
      assert.strictEqual(workOrReview.length, 0);
      assert.isTrue(launched.some((t) => t.title.startsWith("Evaluator:")));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a work run that fails is flagged todo and never nudged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const before = (yield* Ref.get(fake.threads)).get(workThread)!.messages.length;
      fake.failures.set(workThread, {
        class: "provider_error",
        code: "provider.no-route",
        message: "Variant unavailable for opus/gpt-6-astra: high",
      } as never);
      yield* kanban.turnEnded(workThread);
      const messages = (yield* Ref.get(fake.threads)).get(workThread)!.messages;
      assert.strictEqual(messages.length, before);
      const flagged = (yield* kanban.card(created.id)).card;
      assert.strictEqual(flagged.stage, "todo");
      assert.isNull(flagged.activeThreadId);
      assert.match(flagged.stalled?.reason ?? "", /^Run failed: Variant unavailable/);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a review run that fails is flagged needs_review and never nudged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      // The work turn ends after the move, which frees the slot the move held.
      yield* kanban.moveCard(created.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: workThread,
      });
      yield* kanban.turnEnded(workThread);
      yield* kanban.dispatchNow;
      const reviewThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      assert.notStrictEqual(reviewThread, workThread);
      const before = (yield* Ref.get(fake.threads)).get(reviewThread)!.messages.length;
      fake.failures.set(reviewThread, {
        class: "provider_error",
        code: "provider.no-route",
        message: "Variant unavailable",
      } as never);
      yield* kanban.turnEnded(reviewThread);
      assert.strictEqual((yield* Ref.get(fake.threads)).get(reviewThread)!.messages.length, before);
      const flagged = (yield* kanban.card(created.id)).card;
      assert.strictEqual(flagged.stage, "needs_review");
      assert.match(flagged.stalled?.reason ?? "", /^Run failed: /);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a failed work run with an unanswered owner message is not nudged and is flagged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const discussion = yield* kanban.cardDiscussion(created.id);
      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Use 3 attempts" }]);
      const before = (yield* Ref.get(fake.threads)).get(workThread)!.messages.length;
      fake.failures.set(workThread, {
        class: "provider_error",
        code: "provider.no-route",
        message: "Variant unavailable for opus/gpt-6-astra: high",
      } as never);
      yield* kanban.turnEnded(workThread);
      assert.strictEqual((yield* Ref.get(fake.threads)).get(workThread)!.messages.length, before);
      const flagged = (yield* kanban.card(created.id)).card;
      assert.strictEqual(flagged.stage, "todo");
      assert.isNull(flagged.activeThreadId);
      assert.match(flagged.stalled?.reason ?? "", /^Run failed: /);
      // The evaluator hears about the failure in the card's discussion.
      const evaluators = [...(yield* Ref.get(fake.threads)).values()].filter((t) =>
        t.title.startsWith("Evaluator:"),
      );
      assert.isTrue(evaluators.some((t) => t.messages.some((m) => m.includes("run failed"))));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a failed review run with an unanswered owner message is not nudged and is flagged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.evaluatorModel, 1);
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      // The work turn's move frees the slot, then the review starts.
      yield* kanban.moveCard(created.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: workThread,
      });
      yield* kanban.turnEnded(workThread);
      yield* kanban.dispatchNow;
      const reviewThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      const discussion = yield* kanban.cardDiscussion(created.id);
      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Check the rounding" }]);
      const before = (yield* Ref.get(fake.threads)).get(reviewThread)!.messages.length;
      fake.failures.set(reviewThread, {
        class: "provider_error",
        code: "provider.no-route",
        message: "Variant unavailable",
      } as never);
      yield* kanban.turnEnded(reviewThread);
      assert.strictEqual((yield* Ref.get(fake.threads)).get(reviewThread)!.messages.length, before);
      const flagged = (yield* kanban.card(created.id)).card;
      assert.strictEqual(flagged.stage, "needs_review");
      assert.match(flagged.stalled?.reason ?? "", /^Run failed: /);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a fully qualified model with a refused variant is named even with no pool", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      // No Astra pool on this board: the refusal still names what the model offers.
      const refused = yield* kanban
        .createCard(board.id, { prompt: "x", title: "x", model: astraHigh }, owner)
        .pipe(Effect.flip);
      assert.include(refused.detail, 'has no "high" variant; it offers: xhigh');
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a pool whose model leaves the composer's list drops to 0 slots on the second tick", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const listed = yield* Ref.make<KanbanModels.ListedModels | null>(null);
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const gone = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", instanceId: "opencode" });
      yield* kanban.setPool(board.id, gone, 2);
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const instance = board.defaultCardModel.instanceId as string;
      const stillListed: KanbanModels.ListedModels = new Map([
        [instance, new Set([board.defaultCardModel.model])],
      ]);
      yield* Ref.set(listed, stillListed);

      // `gone` names no level, so it resized the board's one Haiku pool (the manager's, xhigh).
      const slotsOf = (model: ModelSelection) =>
        Effect.map(
          kanban.snapshot(board.id),
          (snapshot) =>
            snapshot.pools.find((pool) => Rules.modelKey(pool.model) === Rules.modelKey(model))!
              .slots,
        );
      yield* kanban.tick;
      assert.strictEqual(yield* slotsOf(gone), 2);
      yield* kanban.tick;
      assert.strictEqual(yield* slotsOf(gone), 0);
      assert.strictEqual(yield* slotsOf(board.defaultCardModel), 2);
    }).pipe(Effect.provide(testLayer(fake.layer, listedLayer(listed))));
  }),
);

it.effect("with an unknown composer list no pool is zeroed", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const haiku = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", instanceId: "opencode" });
      yield* kanban.setPool(board.id, haiku, 2);
      yield* kanban.tick;
      yield* kanban.tick;
      const pool = (yield* kanban.snapshot(board.id)).pools.find(
        (entry) => Rules.modelKey(entry.model) === Rules.modelKey(haiku),
      );
      assert.strictEqual(pool!.slots, 2);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("setPool refuses an unlisted model with slots and adds a listed one at 0", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const listed = yield* Ref.make<KanbanModels.ListedModels | null>(null);
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const instance = board.defaultCardModel.instanceId as string;
      const haiku = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", instanceId: "opencode" });
      // The provider offers Astra, so the model check passes; the composer list leaves it out (hidden).
      const other = modelSelectionOf({ model: "opus/gpt-6-astra", instanceId: "opencode" });
      yield* Ref.set(
        listed,
        new Map<string, KanbanModels.ListedModelEntry>([
          [instance, new Set([board.defaultCardModel.model, haiku.model])],
        ]),
      );

      const refused = yield* kanban.setPool(board.id, other, 1).pipe(Effect.flip);
      assert.strictEqual(refused.code, "invalid");
      assert.include(refused.detail, "isn't in the model list");
      const added = yield* kanban.setPool(board.id, haiku, 0);
      assert.isTrue(
        added.some(
          (pool) => Rules.modelKey(pool.model) === Rules.modelKey(haiku) && pool.slots === 0,
        ),
      );
    }).pipe(Effect.provide(testLayer(fake.layer, listedLayer(listed))));
  }),
);

it.effect("removePool refuses a pool in use or with slots, and drops an unused 0-slot pool", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const listed = yield* Ref.make<KanbanModels.ListedModels | null>(null);
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const instance = board.defaultCardModel.instanceId as string;
      const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", instanceId: "opencode" });
      yield* Ref.set(
        listed,
        new Map<string, KanbanModels.ListedModelEntry>([
          [instance, new Set([board.defaultCardModel.model, sol.model])],
        ]),
      );

      const busy = yield* kanban.removePool(board.id, board.evaluatorModel).pipe(Effect.flip);
      assert.strictEqual(busy.code, "invalid");

      yield* kanban.setPool(board.id, sol, 1);
      const withSlots = yield* kanban.removePool(board.id, sol).pipe(Effect.flip);
      assert.strictEqual(withSlots.code, "invalid");

      yield* kanban.setPool(board.id, sol, 0);
      const pools = yield* kanban.removePool(board.id, sol);
      assert.isFalse(pools.some((pool) => pool.key === Rules.poolKey(sol)));
      const snapshot = yield* kanban.snapshot(board.id);
      assert.isFalse(snapshot.pools.some((pool) => pool.key === Rules.poolKey(sol)));
    }).pipe(Effect.provide(testLayer(fake.layer, listedLayer(listed))));
  }),
);

it.effect(
  "removePool refuses a pool that a card's pinned work model is on, even with weighted candidates",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const listed = yield* Ref.make<KanbanModels.ListedModels | null>(null);
      yield* Effect.gen(function* () {
        const kanban = yield* KanbanService.KanbanService;
        const store = yield* KanbanStore.KanbanStore;
        const board = yield* kanban.ensureBoard({
          slug: "toy",
          name: "Toy",
          defaultProjectId: ProjectId.make("project-1"),
        });
        const instance = board.defaultCardModel.instanceId as string;
        // Models the test provider offers; the pinned one is none of the board's own models.
        const pinned = modelSelectionOf({ model: "opus/gpt-6-astra", instanceId: "opencode" });
        const weightedB = modelSelectionOf({
          model: "opus/cx/gpt-6.1-sol",
          instanceId: "opencode",
        });
        const weightedC = modelSelectionOf({
          model: "opus/cc/claude-haiku-5-5",
          instanceId: "opencode",
        });
        yield* Ref.set(
          listed,
          new Map<string, KanbanModels.ListedModelEntry>([
            [
              instance,
              new Set([
                board.defaultCardModel.model,
                pinned.model,
                weightedB.model,
                weightedC.model,
              ]),
            ],
          ]),
        );
        yield* kanban.setPool(board.id, pinned, 0);
        yield* kanban.setPool(board.id, weightedB, 0);
        yield* kanban.setPool(board.id, weightedC, 0);

        const card = yield* kanban.createCard(
          board.id,
          {
            prompt: "pinned",
            title: "Pinned",
            models: [
              { model: weightedB, weight: 2 },
              { model: weightedC, weight: 1 },
            ],
          },
          owner,
        );
        // A persisted unsettled card whose pinned work model is A but candidates are B and C.
        yield* store.putCard({ ...card, model: pinned });

        const refused = yield* kanban.removePool(board.id, pinned).pipe(Effect.flip);
        assert.strictEqual(refused.code, "invalid");
        assert.include(refused.detail, `card #${card.number} uses`);
      }).pipe(Effect.provide(testLayer(fake.layer, listedLayer(listed))));
    }),
);

it.effect("setPool 0 pauses an existing pool whose model left a non-empty provider catalog", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const listed = yield* Ref.make<KanbanModels.ListedModels | null>(null);
    const retired = modelSelectionOf({ model: "opus/retired-model", instanceId: "opencode" });
    const kept = opencodeTestProvider();
    // The provider still offers other models, but no longer offers the retired slug.
    const catalogWithout = [
      { ...kept, models: kept.models.filter((model) => model.slug !== "opus/retired-model") },
    ];
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const instance = board.defaultCardModel.instanceId as string;
      yield* Ref.set(
        listed,
        new Map<string, KanbanModels.ListedModelEntry>([
          [instance, new Set([board.defaultCardModel.model, retired.model])],
        ]),
      );
      // A pool that already has slots, written as if it were created before the slug was retired.
      yield* store.putPool(board.id, { key: Rules.poolKey(retired), model: retired, slots: 2 });

      const pools = yield* kanban.setPool(board.id, retired, 0);
      assert.isTrue(pools.some((pool) => pool.key === Rules.poolKey(retired) && pool.slots === 0));
    }).pipe(Effect.provide(testLayer(fake.layer, listedLayer(listed), catalogWithout)));
  }),
);

it.effect("a script's step leaves the evaluator alone until the script is done", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      const store = yield* KanbanStore.KanbanStore;
      const scriptId = KanbanScriptId.make("script-land");
      const script: KanbanScript = {
        id: scriptId,
        boardId: board.id,
        name: "land",
        path: "/tmp/land.sh",
        trigger: { _tag: "manual" },
        enabled: true,
        createdBy: owner,
        createdAt: "2026-10-29T00:00:00Z",
        lastRun: null,
      };
      yield* store.putScript(script);
      const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const scriptActor: KanbanActor = { _tag: "script", scriptId };
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Fix the fee",
          title: "Fee",
          subtasks: [
            { text: "Write the PR", owner: "work" },
            { text: "Review", owner: "review" },
            { text: "Merge the PR", owner: "script", script: "land", step: 3 },
            { text: "Tell the reporter", owner: "evaluator", step: 4 },
          ],
        },
        evaluator,
      );
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      const worker: KanbanActor = { _tag: "thread", threadId: workThread };
      yield* kanban.markSubtask(card.id, "s1", "done", "PR #4", worker, "work");
      yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
      yield* kanban.dispatchNow;
      const reviewThread = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* kanban.reviewResult(reviewThread, "clear", []);
      assert.strictEqual((yield* kanban.card(card.id)).card.stage, "completed");

      const told = [...(yield* Ref.get(fake.threads)).values()].filter((thread) =>
        thread.messages.some((text) => text.includes("waiting on your subtasks")),
      );
      assert.strictEqual(told.length, 0);

      yield* kanban.markSubtask(card.id, "s3", "done", "merged abc1234", scriptActor, "script");
      const wakes = [...(yield* Ref.get(fake.threads)).values()].flatMap((thread) =>
        thread.messages.filter((text) => text.includes("waiting on your subtasks: s4")),
      );
      assert.strictEqual(wakes.length, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

const messageText = (messages: ReadonlyArray<{ readonly blocks: ReadonlyArray<unknown> }>) =>
  messages
    .at(-1)
    ?.blocks.map((block) => ("text" in (block as object) ? (block as { text: string }).text : ""))
    .join("") ?? "";

it.effect("an outage posts one board alert, then one back message", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const firstCard = yield* kanban.createCard(board.id, { prompt: "x", title: "x0" }, owner);
      const secondCard = yield* kanban.createCard(board.id, { prompt: "x", title: "x1" }, owner);
      yield* kanban.dispatchNow;
      // Both cards start before either fails: a paused key holds later dispatches.
      const threadIds: Array<ThreadId> = [
        (yield* kanban.card(firstCard.id)).card.activeThreadId!,
        (yield* kanban.card(secondCard.id)).card.activeThreadId!,
      ];
      for (const threadId of threadIds) {
        fake.failures.set(threadId, outage);
        yield* kanban.turnEnded(threadId);
      }
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      const alertsAfterFirst = (yield* kanban.discussions(board.id)).filter(
        (discussion) => discussion.title === "Provider outages" && discussion.cardId === null,
      );
      assert.strictEqual(alertsAfterFirst.length, 1);
      const discussionId = alertsAfterFirst[0]!.id;
      const first = yield* kanban.messages(discussionId);
      assert.strictEqual(first.length, 1);
      assert.include(messageText(first), "2 threads paused");
      assert.deepStrictEqual(first[0]?.author, { _tag: "system", component: "provider-watch" });

      yield* TestClock.adjust("10 minutes");
      yield* kanban.probeOutages;
      assert.strictEqual((yield* kanban.messages(discussionId)).length, 1);

      probe.ok = true;
      yield* TestClock.adjust("20 minutes");
      yield* kanban.probeOutages;
      const all = yield* kanban.messages(discussionId);
      assert.strictEqual(all.length, 2);
      assert.include(messageText(all), "answers again");
      assert.include(messageText(all), "2 paused threads woken");
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("a quick outage that never gets probed posts nothing", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = true;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(created.id)).card.activeThreadId!;
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isNull((yield* kanban.caller(threadId))?.paused ?? null);
      const alerts = (yield* kanban.discussions(board.id)).filter(
        (discussion) => discussion.title === "Provider outages",
      );
      assert.strictEqual(alerts.length, 0);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

const outageTitled = (messages: ReadonlyArray<{ readonly blocks: ReadonlyArray<unknown> }>) =>
  messages.map((message) => messageText([message]));

it.effect("staggered outages on two boards are each announced once, and each recovers once", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const boardB = yield* kanban.ensureBoard({
        slug: "other",
        name: "Other",
        defaultProjectId: ProjectId.make("project-other"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      yield* kanban.setPool(boardB.id, boardB.defaultCardModel, 1);
      // Both boards run the same model, so both threads share one pool key.
      assert.strictEqual(boardB.defaultCardModel.model, board.defaultCardModel.model);

      const cardA = yield* kanban.createCard(board.id, { prompt: "x", title: "a" }, owner);
      const cardB = yield* kanban.createCard(boardB.id, { prompt: "x", title: "b" }, owner);
      // One dispatch: both threads are running before anything fails.
      yield* kanban.dispatchNow;
      const threadA = (yield* kanban.card(cardA.id)).card.activeThreadId!;
      const threadB = (yield* kanban.card(cardB.id)).card.activeThreadId!;

      const alertOf = (boardId: typeof board.id) =>
        kanban
          .discussions(boardId)
          .pipe(
            Effect.map((all) =>
              all.find(
                (discussion) =>
                  discussion.title === "Provider outages" && discussion.cardId === null,
              ),
            ),
          );

      // Board A's thread fails first: A is announced, B is not yet.
      fake.failures.set(threadA, outage);
      yield* kanban.turnEnded(threadA);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      const alertA = (yield* alertOf(board.id))!;
      const bAfterA = yield* alertOf(boardB.id);
      assert.isUndefined(bAfterA);
      const aMessages = yield* kanban.messages(alertA.id);
      assert.strictEqual(aMessages.length, 1);
      assert.include(messageText(aMessages), "1 thread paused");

      // Board B's thread fails later: B is announced once, A keeps its one message.
      fake.failures.set(threadB, outage);
      yield* kanban.turnEnded(threadB);
      yield* TestClock.adjust("10 minutes");
      yield* kanban.probeOutages;
      const alertB = (yield* alertOf(boardB.id))!;
      const bMessages = yield* kanban.messages(alertB.id);
      assert.strictEqual(bMessages.length, 1);
      assert.include(messageText(bMessages), "1 thread paused");
      assert.strictEqual((yield* kanban.messages(alertA.id)).length, 1);

      // Recovery: each board gets exactly one "answers again", and both threads are unpaused.
      probe.ok = true;
      yield* TestClock.adjust("20 minutes");
      yield* kanban.probeOutages;
      const recoveredA = outageTitled(yield* kanban.messages(alertA.id)).filter((text) =>
        text.includes("answers again"),
      );
      const recoveredB = outageTitled(yield* kanban.messages(alertB.id)).filter((text) =>
        text.includes("answers again"),
      );
      assert.strictEqual(recoveredA.length, 1);
      assert.strictEqual(recoveredB.length, 1);
      assert.isNull((yield* kanban.caller(threadA))?.paused ?? null);
      assert.isNull((yield* kanban.caller(threadB))?.paused ?? null);
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

it.effect("an outage on an already scanned board survives a cross-board probe snapshot", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let blockedBoard: string | null = null;
    const gatedStore = Layer.effect(
      KanbanStore.KanbanStore,
      Effect.map(KanbanStore.KanbanStore, (store) =>
        KanbanStore.KanbanStore.of({
          ...store,
          threadLinks: (filter) =>
            Effect.suspend(() => {
              if ("boardId" in filter && filter.boardId === blockedBoard && !filter.open) {
                blockedBoard = null;
                return Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(store.threadLinks(filter)),
                );
              }
              return store.threadLinks(filter);
            }),
        }),
      ),
    ).pipe(Layer.provide(KanbanStore.layer));
    const layer = KanbanService.layer.pipe(
      Layer.provideMerge(fake.layer),
      Layer.provideMerge(KanbanModels.layerTest(null)),
      Layer.provideMerge(gatedStore),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
      Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
      Layer.provideMerge(boardFilesLayer),
    );
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const boardB = yield* kanban.ensureBoard({
        slug: "scan-b",
        name: "Scan B",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", variant: "xhigh" });
      yield* kanban.setPool(boardB.id, sol, 1);
      const cardA = yield* kanban.createCard(
        board.id,
        { prompt: "a", title: "a", description: "a" },
        owner,
      );
      const cardB = yield* kanban.createCard(
        boardB.id,
        { prompt: "b", title: "b", description: "b", model: sol },
        owner,
      );
      yield* kanban.dispatchNow;
      const threadA = (yield* kanban.card(cardA.id)).card.activeThreadId!;
      const threadB = (yield* kanban.card(cardB.id)).card.activeThreadId!;
      fake.failures.set(threadB, outage);
      yield* kanban.turnEnded(threadB);
      blockedBoard = boardB.id;
      const probing = yield* Effect.forkChild(kanban.probeOutages);
      yield* Deferred.await(reached);
      fake.failures.set(threadA, outage);
      yield* kanban.turnEnded(threadA);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(probing);
      const waiting = yield* kanban.createCard(
        board.id,
        { prompt: "wait", title: "wait", description: "wait" },
        owner,
      );
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(waiting.id)).card.stage, "todo");
      assert.isNotNull((yield* kanban.caller(threadA))?.paused);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a new outage on an already woken board survives another board's recovery send", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let blockedThread: ThreadId | null = null;
    const delayed = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (threads) =>
        KanbanThreads.of({
          ...threads,
          send: (input) =>
            input.threadId === blockedThread
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(threads.send(input)),
                )
              : threads.send(input),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    probe.ok = true;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const boardB = yield* kanban.ensureBoard({
        slug: "recovery-b",
        name: "Recovery B",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(boardB.id, boardB.defaultCardModel, 1);
      const cardA = yield* kanban.createCard(
        board.id,
        { prompt: "a", title: "a", description: "a" },
        owner,
      );
      const cardB = yield* kanban.createCard(
        boardB.id,
        { prompt: "b", title: "b", description: "b" },
        owner,
      );
      yield* kanban.dispatchNow;
      const threadA = (yield* kanban.card(cardA.id)).card.activeThreadId!;
      const threadB = (yield* kanban.card(cardB.id)).card.activeThreadId!;
      fake.failures.set(threadA, outage);
      fake.failures.set(threadB, outage);
      yield* kanban.turnEnded(threadA);
      yield* kanban.turnEnded(threadB);
      blockedThread = threadB;
      yield* TestClock.adjust("5 minutes");
      const probing = yield* Effect.forkChild(kanban.probeOutages);
      yield* Deferred.await(reached);
      fake.failures.set(threadA, { ...outage });
      yield* kanban.turnEnded(threadA);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(probing);
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      const waiting = yield* kanban.createCard(
        board.id,
        { prompt: "wait", title: "wait", description: "wait" },
        owner,
      );
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(waiting.id)).card.stage, "todo");
      assert.isNotNull((yield* kanban.caller(threadA))?.paused);
    }).pipe(Effect.provide(probeLayer(delayed)));
  }),
);

it.effect("a failed outage post is retried by the next probe, and recovery waits for it", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(created.id)).card.activeThreadId!;
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      // The first announce post fails; the probe still runs and keeps the pause.
      postFailures.remaining = 1;
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isNotNull((yield* kanban.caller(threadId))?.paused);
      // The discussion is created before the post; the failed post leaves no message in it.
      const failedAlert = (yield* kanban.discussions(board.id)).find(
        (discussion) => discussion.title === "Provider outages",
      );
      assert.strictEqual((yield* kanban.messages(failedAlert!.id)).length, 0);
      // The next failed probe retries the announcement.
      yield* TestClock.adjust("10 minutes");
      yield* kanban.probeOutages;
      const discussionId = (yield* kanban.discussions(board.id)).find(
        (discussion) => discussion.title === "Provider outages",
      )!.id;
      assert.strictEqual((yield* kanban.messages(discussionId)).length, 1);
      assert.include(messageText(yield* kanban.messages(discussionId)), "1 thread paused");

      probe.ok = true;
      yield* TestClock.adjust("20 minutes");
      yield* kanban.probeOutages;
      const texts = outageTitled(yield* kanban.messages(discussionId));
      assert.strictEqual(texts.length, 2);
      assert.include(texts[1] ?? "", "answers again");
    }).pipe(Effect.provide(failingPostProbeLayer(fake.layer)));
  }),
);

it.effect("a refused wake is not announced as woken", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const threadId = (yield* kanban.card(created.id)).card.activeThreadId!;
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      const discussionId = (yield* kanban.discussions(board.id)).find(
        (discussion) => discussion.title === "Provider outages",
      )!.id;

      // The wake is refused: the link stays paused and no recovery is announced.
      probe.ok = true;
      fake.rejectSends.add(threadId);
      yield* TestClock.adjust("20 minutes");
      yield* kanban.probeOutages;
      assert.isNotNull((yield* kanban.caller(threadId))?.paused);
      assert.strictEqual(
        outageTitled(yield* kanban.messages(discussionId)).filter((text) =>
          text.includes("answers again"),
        ).length,
        0,
      );

      // The wake lands on the next passing probe and is counted once.
      fake.rejectSends.delete(threadId);
      yield* TestClock.adjust("20 minutes");
      yield* kanban.probeOutages;
      assert.isNull((yield* kanban.caller(threadId))?.paused ?? null);
      const texts = outageTitled(yield* kanban.messages(discussionId));
      const recoveries = texts.filter((text) => text.includes("answers again"));
      assert.strictEqual(recoveries.length, 1);
      assert.include(recoveries[0] ?? "", "1 paused thread woken");
    }).pipe(Effect.provide(probeLayer(fake.layer)));
  }),
);

const failingRecoveryPostProbeLayer = (fake: Layer.Layer<KanbanThreads>) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(
      fake.pipe(
        Layer.provideMerge(KanbanModels.layerTest(null)),
        Layer.provideMerge(failingPostStore.pipe(Layer.provide(KanbanStore.layer))),
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(
          Layer.mock(TextGeneration.TextGeneration)({
            generateJson: (() => {
              probe.calls += 1;
              if (probe.ok) {
                postFailures.remaining = postFailures.afterPass;
                postFailures.afterPass = 0;
              }
              return probe.ok ? Effect.succeed({ ok: true }) : Effect.die("out of usage");
            }) as never,
          }),
        ),
        Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
        Layer.provideMerge(boardFilesLayer),
      ),
    ),
  );

const failingPostProbeLayer = (fake: Layer.Layer<KanbanThreads>) =>
  KanbanService.layer.pipe(Layer.provideMerge(probeDeps(fake, true)));

// Fail a paused-link count or the subsequent discussion read during an outage alert.
const linkFailures = { remaining: 0, alertReads: 0 };
const failingLinkStore = Layer.effect(
  KanbanStore.KanbanStore,
  Effect.gen(function* () {
    const real = yield* KanbanStore.KanbanStore;
    return {
      ...real,
      threadLinks: (filter) => {
        return linkFailures.remaining > 0
          ? ((linkFailures.remaining -= 1),
            Effect.fail(
              new KanbanStore.KanbanStoreError({
                operation: "read thread links",
                cause: "injected",
              }),
            ))
          : real.threadLinks(filter);
      },
      discussions: (boardId) =>
        linkFailures.alertReads > 0
          ? ((linkFailures.alertReads -= 1),
            Effect.fail(
              new KanbanStore.KanbanStoreError({
                operation: "read discussions",
                cause: "injected",
              }),
            ))
          : real.discussions(boardId),
    };
  }),
);

// Fails the next `rekeyFailures.remaining` board rekeys, as a write error mid-migration would.
const rekeyFailures = { remaining: 0 };
const failingRekeyStore = Layer.effect(
  KanbanStore.KanbanStore,
  Effect.gen(function* () {
    const real = yield* KanbanStore.KanbanStore;
    return {
      ...real,
      rekeyBoard: (boardId, pools, cards) =>
        rekeyFailures.remaining > 0
          ? ((rekeyFailures.remaining -= 1),
            Effect.fail(
              new KanbanStore.KanbanStoreError({ operation: "rekey board", cause: "injected" }),
            ))
          : real.rekeyBoard(boardId, pools, cards),
    };
  }),
);

// Fails the next `postFailures.remaining` writes of a "provider-watch" outage post.
const postFailures = { remaining: 0, afterPass: 0 };
const failingPostStore = Layer.effect(
  KanbanStore.KanbanStore,
  Effect.gen(function* () {
    const real = yield* KanbanStore.KanbanStore;
    return {
      ...real,
      putMessage: (message) =>
        message.author._tag === "system" && postFailures.remaining > 0
          ? ((postFailures.remaining -= 1),
            Effect.fail(
              new KanbanStore.KanbanStoreError({ operation: "write message", cause: "injected" }),
            ))
          : real.putMessage(message),
    };
  }),
);

it.effect("a failed recovery-alert post still wakes the paused thread on a passing probe", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    probe.ok = false;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const threadId = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Look" });
      fake.failures.set(threadId, outage);
      yield* kanban.turnEnded(threadId);
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isNotNull((yield* kanban.caller(threadId))?.paused);

      // The probe passes, the wake lands, and the optional recovery post fails.
      probe.ok = true;
      postFailures.afterPass = 1;
      yield* TestClock.adjust("20 minutes");
      yield* kanban.probeOutages;
      assert.strictEqual(postFailures.remaining, 0);
      assert.isNull((yield* kanban.caller(threadId))?.paused ?? null);
    }).pipe(Effect.provide(failingRecoveryPostProbeLayer(fake.layer)));
  }),
);

// Two models: A (the board default) fails, B (Sol) passes. The model-aware probe arms the
// threadLinks failure when A's probe fails, so the read lands in the announcement scan that
// runs right after the failed probe, not in the snapshot read before it.
const twoModelProbeLayer = (fake: Layer.Layer<KanbanThreads>, armAfterA: () => void) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(
      fake.pipe(
        Layer.provideMerge(KanbanModels.layerTest(null)),
        Layer.provideMerge(failingLinkStore.pipe(Layer.provide(KanbanStore.layer))),
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(
          Layer.mock(TextGeneration.TextGeneration)({
            generateJson: ((input: { readonly modelSelection: ModelSelection }) => {
              probe.calls += 1;
              // Sol is down until the test sets probe.ok; A stays down throughout.
              if (input.modelSelection.model === "opus/cx/gpt-6.1-sol") {
                return probe.ok ? Effect.succeed({ ok: true }) : Effect.die("out of usage");
              }
              armAfterA();
              return Effect.die("out of usage");
            }) as never,
          }),
        ),
        Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
        Layer.provideMerge(boardFilesLayer),
      ),
    ),
  );

const twoModelScenario = (failure: "count" | "discussion") =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    linkFailures.remaining = 0;
    linkFailures.alertReads = 0;
    probe.calls = 0;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const { board } = yield* toyBoard;
      const sol = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", variant: "xhigh" });
      yield* kanban.setPool(board.id, board.defaultCardModel, 2);
      yield* kanban.setPool(board.id, sol, 2);
      // Thread A runs the default model and thread B runs Sol; both pause on their own model.
      const cardA = yield* kanban.createCard(board.id, { prompt: "a", title: "a" }, owner);
      const cardB = yield* kanban.createCard(board.id, { prompt: "b", title: "b" }, owner);
      yield* kanban.dispatchNow;
      const threadA = (yield* kanban.card(cardA.id)).card.activeThreadId!;
      const threadB = (yield* kanban.card(cardB.id)).card.activeThreadId!;
      yield* kanban.editCard(cardB.id, { model: sol }, owner);
      fake.failures.set(threadA, outage);
      fake.failures.set(threadB, outage);
      yield* kanban.turnEnded(threadA);
      yield* kanban.turnEnded(threadB);
      assert.isNotNull((yield* kanban.caller(threadA))?.paused);
      assert.isNotNull((yield* kanban.caller(threadB))?.paused);
      // A's failed probe arms one failure in its optional alert.
      probe.ok = false;
      yield* TestClock.adjust("5 minutes");
      yield* kanban.probeOutages;
      assert.isNotNull((yield* kanban.caller(threadA))?.paused);
      assert.isNotNull((yield* kanban.caller(threadB))?.paused);
      // Next run: A still fails, B's probe passes and must still wake B.
      probe.ok = true;
      yield* TestClock.adjust("20 minutes");
      yield* kanban.probeOutages;
      assert.isNull((yield* kanban.caller(threadB))?.paused ?? null);
      assert.isNotNull((yield* kanban.caller(threadA))?.paused);
    }).pipe(
      Effect.provide(
        twoModelProbeLayer(fake.layer, () => {
          if (failure === "count") linkFailures.remaining = 1;
          else linkFailures.alertReads = 1;
        }),
      ),
    );
  });

it.effect("a failed outage-alert count scan does not skip the next model's probe", () =>
  twoModelScenario("count"),
);
it.effect("a failed outage-alert discussion read does not skip the next model's probe", () =>
  twoModelScenario("discussion"),
);

// Counts the reviewer's "record your verdict" nudges sent to a thread.
const verdictNudges = (fake: Effect.Success<typeof makeFake>, threadId: string) =>
  Ref.get(fake.threads).pipe(
    Effect.map(
      (all) =>
        all.get(threadId)!.messages.filter((text) => text.includes("record your verdict")).length,
    ),
  );

// Reviews a card and returns its reviewer thread, ready for turn ends.
const reviewerOf = Effect.fn("reviewerOf")(function* (
  kanban: Effect.Success<typeof toyBoard>["kanban"],
  boardId: Effect.Success<typeof toyBoard>["board"]["id"],
) {
  const card = yield* kanban.createCard(boardId, { prompt: "A", title: "A" }, owner);
  yield* kanban.dispatchNow;
  const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
  yield* kanban.moveCard(card.id, "needs_review", "cardThread", {
    _tag: "thread",
    threadId: workThread,
  });
  yield* kanban.turnEnded(workThread);
  yield* kanban.dispatchNow;
  return { cardId: card.id, reviewThread: (yield* kanban.card(card.id)).card.activeThreadId! };
});

it.effect("a reviewer that resumes after planning is not requeued", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const { cardId, reviewThread } = yield* reviewerOf(kanban, board.id);
      yield* kanban.turnEnded(reviewThread);
      assert.strictEqual(yield* verdictNudges(fake, reviewThread), 1);
      const before = (yield* kanban.card(cardId)).card;
      assert.strictEqual(before.stage, "in_review");
      assert.isNotNull(before.nudgedAt);
      const state = (yield* Ref.get(fake.threads)).get(reviewThread)!;
      const messages = [...state.messages];
      yield* TestClock.adjust("31 minutes");
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      fake.findCalls.length = 0;
      fake.findControl.beforeRead = (id, attempt) =>
        id === reviewThread && attempt === 2
          ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void;
      const tick = yield* Effect.forkChild(kanban.tick);
      yield* Deferred.await(reached);
      state.running = true;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(tick);
      assert.strictEqual(fake.findCalls.filter((id) => id === reviewThread).length, 2);
      const after = yield* kanban.card(cardId);
      assert.strictEqual(after.card.stage, "in_review");
      assert.strictEqual(after.card.activeThreadId, reviewThread);
      assert.strictEqual(after.card.nudgedAt, before.nudgedAt);
      assert.isNull(after.card.stalled);
      assert.isFalse(
        after.events.some((event) => event.body === "Reviewer stopped without a verdict"),
      );
      assert.deepStrictEqual(state.messages, messages);
      assert.deepStrictEqual(fake.interrupted, []);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "a reviewer waiting on its own subagents isn't nudged or flagged when its turn ends",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
        const { kanban, board } = yield* toyBoard;
        const { cardId, reviewThread } = yield* reviewerOf(kanban, board.id);
        yield* setBackground(fake, reviewThread, 2);
        yield* kanban.turnEnded(reviewThread);
        yield* kanban.turnEnded(reviewThread);
        let card = (yield* kanban.card(cardId)).card;
        assert.strictEqual(card.stage, "in_review");
        assert.strictEqual(card.activeThreadId, reviewThread);
        assert.isNull(card.stalled);
        assert.isNull(card.nudgedAt);
        assert.strictEqual(yield* verdictNudges(fake, reviewThread), 0);

        yield* setBackground(fake, reviewThread, 0);
        yield* kanban.turnEnded(reviewThread);
        card = (yield* kanban.card(cardId)).card;
        assert.isNotNull(card.nudgedAt);
        assert.strictEqual(yield* verdictNudges(fake, reviewThread), 1);
        yield* kanban.turnEnded(reviewThread);
        card = (yield* kanban.card(cardId)).card;
        assert.strictEqual(card.stage, "needs_review");
        assert.strictEqual(card.stalled?.reason, "Reviewer stopped without a verdict");
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("background work past the grace no longer holds a reviewer", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const { reviewThread } = yield* reviewerOf(kanban, board.id);
      yield* setBackground(fake, reviewThread, 1);
      yield* TestClock.adjust("61 minutes");
      yield* kanban.turnEnded(reviewThread);
      assert.strictEqual(yield* verdictNudges(fake, reviewThread), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the tick catches a reviewer whose turn end was skipped", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const { cardId, reviewThread } = yield* reviewerOf(kanban, board.id);
      yield* setBackground(fake, reviewThread, 1);
      yield* kanban.turnEnded(reviewThread);
      assert.strictEqual(yield* verdictNudges(fake, reviewThread), 0);
      yield* setBackground(fake, reviewThread, 0);
      yield* TestClock.adjust("31 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* verdictNudges(fake, reviewThread), 1);
      yield* kanban.tick;
      assert.strictEqual(yield* verdictNudges(fake, reviewThread), 1);
      yield* TestClock.adjust("31 minutes");
      yield* kanban.tick;
      const card = (yield* kanban.card(cardId)).card;
      assert.strictEqual(card.stage, "needs_review");
      assert.strictEqual(card.stalled?.reason, "Reviewer stopped without a verdict");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a worker waiting on its own subagents isn't nudged", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-25T13:00:00.000Z"));
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* setBackground(fake, thread, 1);
      yield* kanban.turnEnded(thread);
      assert.strictEqual(yield* nudgesTo(fake, thread), 0);
      yield* TestClock.adjust("31 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* nudgesTo(fake, thread), 0);
      yield* TestClock.adjust("30 minutes");
      yield* kanban.tick;
      assert.strictEqual(yield* nudgesTo(fake, thread), 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.live("answers board reads while the SQLite writer is held", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kanban-reader-" });
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const sql = yield* SqlClient.SqlClient;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Read me", title: "Reader" },
        owner,
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
      const reads = yield* Effect.all({
        boards: kanban.boards,
        snapshot: kanban.snapshot(board.id),
        card: kanban.card(created.id),
        threads: kanban.threads(board.id),
        discussions: kanban.discussions(board.id),
        wiki: kanban.wiki(board.id),
      }).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.succeed(releaseWriter, undefined);
      yield* Fiber.join(writer);

      assert.isTrue(reads.boards.some((entry) => entry.id === board.id));
      assert.deepEqual(
        reads.snapshot.cards.map((card) => card.id),
        [created.id],
      );
      assert.strictEqual(reads.card.card.id, created.id);
    }).pipe(Effect.provide(fileTestLayer(fake.layer, path.join(directory, "state.sqlite"))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a quiet tick reads the board without waiting for the SQLite writer", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kanban-tick-" });
    const dbPath = path.join(directory, "state.sqlite");
    const fake = yield* makeFake;

    const tracedTick = (tick: Effect.Effect<void, KanbanError>) => {
      const spans: Array<Tracer.NativeSpan> = [];
      const statementStarted = Deferred.makeUnsafe<void>();
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const attribute = span.attribute.bind(span);
          span.attribute = (key, value) => {
            attribute(key, value);
            if (
              key === "db.query.text" &&
              typeof value === "string" &&
              /^\s*SELECT\b/i.test(value) &&
              /\bardud_kanban_/i.test(value)
            ) {
              Deferred.doneUnsafe(statementStarted, Effect.void);
            }
          };
          spans.push(span);
          return span;
        },
      });
      const run = tick.pipe(
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.withTracer(tracer),
      );
      const statements = () =>
        spans.flatMap((span) => {
          const text = span.attributes.get("db.query.text");
          return typeof text === "string"
            ? [{ text, connection: span.attributes.get("db.connection") }]
            : [];
        });
      return { run, statements, statementStarted };
    };
    const boardSelects = (statements: ReturnType<ReturnType<typeof tracedTick>["statements"]>) =>
      statements.filter(({ text }) => /^\s*SELECT\b/i.test(text) && /\bardud_kanban_/i.test(text));
    const counts = (statements: ReturnType<typeof boardSelects>) => ({
      writer: statements.filter(({ connection }) => connection === "writer").length,
      reader: statements.filter(({ connection }) => connection === "reader").length,
      unknown: statements.filter(
        ({ connection }) => connection !== "writer" && connection !== "reader",
      ).length,
    });
    const countSql = (run: Effect.Effect<void, KanbanError>) =>
      Effect.gen(function* () {
        const measurement = tracedTick(run);
        yield* measurement.run.pipe(Effect.timeout("5 seconds"));
        const statements = measurement.statements();
        assert.isTrue(statements.every(({ text }) => /^\s*SELECT\b/i.test(text)));
        return boardSelects(statements);
      });

    // The previous store used run rather than runRead for these methods. Suppressing
    // readOnly reproduces that routing without changing the shared worktree.
    const oldRouting = yield* Effect.sync(() =>
      vi
        .spyOn(NodeSqliteClient, "readOnly")
        .mockImplementation(
          <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => effect,
        ),
    );
    const before = yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      const board = yield* kanban.ensureBoard({
        slug: "quiet-tick",
        name: "Quiet tick",
        defaultProjectId: null,
      });
      for (const title of ["First", "Second"]) {
        yield* kanban.createCard(board.id, { prompt: title, title, description: title }, owner);
      }
      const cards = yield* store.cards(board.id);
      const pools = yield* store.pools(board.id);
      assert.lengthOf(cards, 2);
      assert.isTrue(cards.every((card) => card.stage === "todo" && card.activeThreadId === null));
      assert.isAbove(pools.length, 0);
      assert.isTrue(pools.every((pool) => pool.slots === 0));
      const events = yield* Effect.forEach(cards, (card) => store.cardEvents(card.id));

      // Settle the one-time scribe/proposal checks and outage scan before measuring.
      yield* kanban.tick;
      const tickSelects = yield* countSql(kanban.tick);
      const dispatchSelects = yield* countSql(kanban.dispatchNow);
      for (const selects of [tickSelects, dispatchSelects]) {
        assert.isAbove(selects.length, 0);
        assert.deepStrictEqual(counts(selects), { writer: selects.length, reader: 0, unknown: 0 });
      }
      for (const table of ["ardud_kanban_boards", "ardud_kanban_cards", "ardud_kanban_pools"]) {
        assert.isTrue(
          tickSelects.some(({ text }) => text.includes(table)),
          table,
        );
      }

      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      yield* Effect.gen(function* () {
        yield* Deferred.await(held).pipe(Effect.timeout("5 seconds"));
        const blocked = tracedTick(kanban.tick);
        const tick = yield* Effect.acquireRelease(Effect.forkChild(blocked.run), (fiber) =>
          Deferred.succeed(release, undefined).pipe(
            Effect.andThen(Fiber.await(writer)),
            Effect.andThen(Fiber.await(fiber).pipe(Effect.timeoutOption("5 seconds"))),
            Effect.asVoid,
          ),
        );
        yield* Effect.gen(function* () {
          yield* Deferred.await(blocked.statementStarted).pipe(Effect.timeout("5 seconds"));
          assert.isTrue(
            boardSelects(blocked.statements()).some(({ connection }) => connection === undefined),
          );
          // Join is interruptible even though the guarded tick itself is not.
          assert.isTrue(
            Option.isNone(yield* Fiber.join(tick).pipe(Effect.timeoutOption("250 millis"))),
          );
          assert.isUndefined(writer.pollUnsafe());
          assert.isUndefined(tick.pollUnsafe());
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(writer).pipe(Effect.timeout("5 seconds"));
        yield* Fiber.join(tick).pipe(Effect.timeout("5 seconds"));
        const resumed = boardSelects(blocked.statements());
        assert.deepStrictEqual(
          resumed.map(({ text }) => text),
          tickSelects.map(({ text }) => text),
        );
        assert.deepStrictEqual(counts(resumed), {
          writer: tickSelects.length,
          reader: 0,
          unknown: 0,
        });
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.await(writer))),
        ),
      );
      return { board, cards, pools, events, tickSelects, dispatchSelects };
    }).pipe(
      Effect.provide(fileTestLayer(fake.layer, dbPath)),
      Effect.ensuring(Effect.sync(() => oldRouting.mockRestore())),
    );

    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const sql = yield* SqlClient.SqlClient;
      yield* kanban.tick;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      const measurement = tracedTick(kanban.tick);
      yield* Effect.gen(function* () {
        yield* Deferred.await(held).pipe(Effect.timeout("5 seconds"));
        const tick = yield* Effect.acquireRelease(Effect.forkChild(measurement.run), (fiber) =>
          Deferred.succeed(release, undefined).pipe(
            Effect.andThen(Fiber.await(writer)),
            Effect.andThen(Fiber.await(fiber).pipe(Effect.timeoutOption("5 seconds"))),
            Effect.asVoid,
          ),
        );
        yield* Effect.gen(function* () {
          yield* Fiber.join(tick).pipe(Effect.timeout("5 seconds"));
          assert.isUndefined(writer.pollUnsafe());
        });
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.await(writer))),
        ),
      );
      yield* Fiber.join(writer);
      const statements = measurement.statements();
      const selects = boardSelects(statements);
      const dispatchSelects = yield* countSql(kanban.dispatchNow);
      assert.deepStrictEqual(
        selects.map(({ text }) => text),
        before.tickSelects.map(({ text }) => text),
      );
      assert.deepStrictEqual(counts(selects), {
        writer: 0,
        reader: before.tickSelects.length,
        unknown: 0,
      });
      assert.deepStrictEqual(
        dispatchSelects.map(({ text }) => text),
        before.dispatchSelects.map(({ text }) => text),
      );
      assert.deepStrictEqual(counts(dispatchSelects), {
        writer: 0,
        reader: before.dispatchSelects.length,
        unknown: 0,
      });
      assert.isTrue(statements.every(({ text }) => /^\s*SELECT\b/i.test(text)));
      assert.deepStrictEqual(yield* store.cards(before.board.id), before.cards);
      assert.deepStrictEqual(yield* store.pools(before.board.id), before.pools);
      assert.deepStrictEqual(
        yield* Effect.forEach(before.cards, (card) => store.cardEvents(card.id)),
        before.events,
      );
      assert.strictEqual((yield* Ref.get(fake.threads)).size, 0);
      assert.lengthOf(fake.sends, 0);
    }).pipe(Effect.provide(fileTestLayer(fake.layer, dbPath)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("card lookups by number and an existing card discussion don't wait for the writer", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-kanban-card-reader-",
    });
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const sql = yield* SqlClient.SqlClient;
      const board = yield* kanban.ensureBoard({
        slug: "toy",
        name: "Toy",
        defaultProjectId: ProjectId.make("project-1"),
      });
      yield* kanban.setPool(board.id, board.defaultCardModel, 1);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Read me", title: "Reader", description: "Reader" },
        owner,
      );
      const discussion = yield* kanban.cardDiscussion(created.id);
      yield* kanban.dispatchNow;
      const thread = (yield* kanban.card(created.id)).card.activeThreadId!;
      assert.isNotNull(thread);
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
        card: kanban.cardByNumber(board.id, created.number),
        cards: kanban.cards(board.id),
        discussion: kanban.cardDiscussion(created.id),
        caller: kanban.caller(thread),
        carried: kanban.carried(thread),
        ownCards: kanban.ownCards(thread),
        summaries: Stream.runCollect(Stream.take(kanban.boardSummaries, 1)),
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.ensuring(Deferred.succeed(releaseWriter, undefined)),
      );
      yield* Fiber.join(writer);
      assert.strictEqual(reads.card?.id, created.id);
      assert.isTrue(reads.cards.some((card) => card.id === created.id));
      assert.strictEqual(reads.discussion.id, discussion.id);
      assert.strictEqual(reads.caller?.cardId, created.id);
      assert.isTrue(reads.carried.some((card) => card.id === created.id));
      assert.isTrue(reads.ownCards.some((card) => card.id === created.id));
      assert.isTrue(
        Array.from(reads.summaries).some((entries) =>
          entries.some((entry) => entry.boardId === board.id),
        ),
      );
    }).pipe(Effect.provide(fileTestLayer(fake.layer, path.join(directory, "state.sqlite"))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("an existing discussion and deferred read don't wait for the board lock", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const lockHeld = yield* Deferred.make<void>();
    const releaseLock = yield* Deferred.make<void>();
    const marked = yield* Deferred.make<void>();
    const blockedThreads = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (threads) =>
        KanbanThreads.of({
          ...threads,
          launch: (input) =>
            Deferred.succeed(lockHeld, undefined).pipe(
              Effect.andThen(Deferred.await(releaseLock)),
              Effect.andThen(threads.launch(input)),
            ),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "Lock test", title: "Lock test", description: "Lock test" },
        owner,
      );
      const discussion = yield* kanban.cardDiscussion(card.id);
      const message = yield* kanban.post(discussion.id, { _tag: "system", component: "test" }, [
        { _tag: "md", text: "Hello" },
      ]);
      const dispatch = yield* Effect.forkChild(kanban.dispatchNow);
      yield* Deferred.await(lockHeld);
      const read = yield* Effect.gen(function* () {
        const existing = yield* kanban.cardDiscussion(card.id);
        yield* kanban.markReadSoon(discussion.id, owner, message.seq);
        const current = yield* kanban.discussion(discussion.id);
        return { existing, current };
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.ensuring(Deferred.succeed(releaseLock, undefined)),
      );
      assert.strictEqual(read.existing.id, discussion.id);
      assert.notStrictEqual(
        read.current.participants.find((participant) => participant.actor._tag === "owner")
          ?.lastReadSeq,
        message.seq,
      );
      yield* Fiber.join(dispatch);
      yield* Deferred.await(marked).pipe(Effect.timeout("5 seconds"));
      const after = yield* kanban.discussion(discussion.id);
      assert.strictEqual(
        after.participants.find((participant) => participant.actor._tag === "owner")?.lastReadSeq,
        message.seq,
      );
    }).pipe(
      Effect.provide(
        observedTestLayer(blockedThreads, () =>
          Deferred.succeed(marked, undefined).pipe(Effect.asVoid),
        ),
      ),
    );
  }),
);

it.live("concurrent requests create a missing card discussion only once", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const readPair = yield* Deferred.make<void>();
    const releaseReads = yield* Deferred.make<void>();
    let target: KanbanCardId | null = null;
    let reads = 0;
    const gatedStore = Layer.effect(
      KanbanStore.KanbanStore,
      Effect.map(KanbanStore.KanbanStore, (real) =>
        KanbanStore.KanbanStore.of({
          ...real,
          card: (cardId) =>
            real.card(cardId).pipe(
              Effect.flatMap((card) =>
                cardId === target && card?.discussionId === null && reads < 2
                  ? Effect.gen(function* () {
                      reads += 1;
                      if (reads === 2) yield* Deferred.succeed(readPair, undefined);
                      yield* Deferred.await(releaseReads);
                      return card;
                    })
                  : Effect.succeed(card),
              ),
            ),
        }),
      ),
    );
    const layer = KanbanService.layer.pipe(
      Layer.provideMerge(fake.layer),
      Layer.provideMerge(KanbanModels.layerTest(null)),
      Layer.provideMerge(gatedStore.pipe(Layer.provide(KanbanStore.layer))),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
      Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
      Layer.provideMerge(boardFilesLayer),
    );
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "A", title: "A", description: "A" },
        owner,
      );
      target = card.id;
      const lookup = yield* Effect.forkChild(
        Effect.all([kanban.cardDiscussion(card.id), kanban.cardDiscussion(card.id)], {
          concurrency: "unbounded",
        }),
      );
      yield* Deferred.await(readPair).pipe(
        Effect.timeout("5 seconds"),
        Effect.ensuring(Deferred.succeed(releaseReads, undefined)),
      );
      const discussions = yield* Fiber.join(lookup).pipe(Effect.timeout("5 seconds"));
      assert.strictEqual(reads, 2);
      assert.strictEqual(new Set(discussions.map((discussion) => discussion.id)).size, 1);
      assert.strictEqual(
        (yield* kanban.discussions(board.id)).filter((discussion) => discussion.cardId === card.id)
          .length,
        1,
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.live("markReadSoon records the read later", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const marked = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const discussion = yield* kanban.createDiscussion(board.id, "Read later", owner);
      const message = yield* kanban.post(discussion.id, { _tag: "system", component: "test" }, [
        { _tag: "md", text: "Hello" },
      ]);
      assert.notStrictEqual(
        (yield* kanban.discussion(discussion.id)).participants.find(
          (participant) => participant.actor._tag === "owner",
        )?.lastReadSeq,
        message.seq,
      );
      yield* kanban.markReadSoon(discussion.id, owner, message.seq);
      yield* Deferred.await(marked).pipe(Effect.timeout("5 seconds"));
      const current = yield* kanban.discussion(discussion.id);
      assert.strictEqual(
        current.participants.find((participant) => participant.actor._tag === "owner")?.lastReadSeq,
        message.seq,
      );
    }).pipe(
      Effect.provide(
        observedTestLayer(fake.layer, () =>
          Deferred.succeed(marked, undefined).pipe(Effect.asVoid),
        ),
      ),
    );
  }),
);

it.live("markReadSoon logs a failed read mark without failing the caller", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const logged = yield* Deferred.make<void>();
    const logger = Logger.make<unknown, void>(({ message }) => {
      if (Array.isArray(message) && message.includes("kanban mark read failed")) {
        Deferred.doneUnsafe(logged, Effect.void);
      }
    });
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      yield* kanban.markReadSoon(KanbanDiscussionId.make("disc-missing"), owner, 1);
      yield* Deferred.await(logged).pipe(Effect.timeout("5 seconds"));
    }).pipe(
      Effect.provide(
        Layer.merge(testLayer(fake.layer), Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  }),
);

const scribe: KanbanActor = { _tag: "system", component: "scribe" };

it.effect("message pages are cut by size, page back with beforeSeq and stub big blocks", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Big", owner);
      const bigMd = "m".repeat(900 * 1024);
      const bigHtml = `<h1>Report</h1>${"h".repeat(1024 * 1024)}`;
      // 250 messages with three 1 MB-ish blocks among them.
      for (let seq = 1; seq <= 250; seq++) {
        const blocks: Array<KanbanBlock> =
          seq === 10
            ? [{ _tag: "html", html: bigHtml, title: "Report", height: null }]
            : seq === 120 || seq === 249
              ? [{ _tag: "md", text: bigMd }]
              : [{ _tag: "md", text: `${seq} ${"w".repeat(4_000)}` }];
        yield* kanban.post(channel.id, scribe, blocks);
      }
      const latest = yield* kanban.messages(channel.id);
      const bytes = latest.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
      assert.isAtMost(latest.length, 50);
      assert.isAtLeast(latest.length, 1);
      assert.isAtMost(bytes, 256 * 1024);
      assert.strictEqual(latest.at(-1)!.seq, 250);
      // Seqs have no holes inside a page.
      latest.forEach((message, index) => assert.strictEqual(message.seq, latest[0]!.seq + index));
      const stub = latest.find((message) => message.seq === 249)!.blocks[0]!;
      assert.strictEqual(stub._tag, "md");
      if (stub._tag === "md") {
        assert.isTrue(stub.truncated);
        assert.strictEqual(stub.fullBytes, bigMd.length);
        assert.isAtMost(stub.text.length, 2_100);
      }
      // Older clients asking for 200 still get a size-bounded page.
      const ws = makeKanbanWsHandlers(kanban, {} as KanbanScriptsShape);
      const legacy = yield* ws[M.messages]({ discussionId: channel.id, limit: 200 });
      assert.isAtMost(
        legacy.reduce((sum, message) => sum + JSON.stringify(message).length, 0),
        256 * 1024,
      );
      assert.strictEqual(legacy.at(-1)!.seq, 250);
      // Paging back reaches the first message without gaps or repeats.
      const seen: Array<number> = latest.map((message) => message.seq);
      let before = latest[0]!.seq;
      while (before > 1) {
        const page = yield* ws[M.messages]({ discussionId: channel.id, beforeSeq: before });
        assert.isAbove(page.length, 0);
        assert.strictEqual(page.at(-1)!.seq, before - 1);
        seen.unshift(...page.map((message) => message.seq));
        before = page[0]!.seq;
      }
      assert.deepStrictEqual(
        seen,
        Array.from({ length: 250 }, (_, index) => index + 1),
      );
      // The html stub keeps its tag and title; the full message comes by seq.
      const early = yield* ws[M.messages]({ discussionId: channel.id, beforeSeq: 11, limit: 1 });
      const html = early[0]!.blocks[0]!;
      assert.strictEqual(html._tag, "html");
      if (html._tag === "html") {
        assert.isTrue(html.truncated);
        assert.strictEqual(html.title, "Report");
        assert.include(html.html, "Report");
        assert.isBelow(html.html.length, 200);
      }
      const full = yield* ws[M.message]({ discussionId: channel.id, seq: 10 });
      const fullBlock = full.blocks[0]!;
      assert.strictEqual(fullBlock._tag === "html" ? fullBlock.html : "", bigHtml);
      assert.isUndefined(fullBlock._tag === "html" ? fullBlock.truncated : true);
      const missing = yield* ws[M.message]({ discussionId: channel.id, seq: 999 }).pipe(
        Effect.flip,
      );
      assert.strictEqual(missing.code, "not-found");
      // A stub decodes as a block, so older and newer clients read the same shape.
      yield* Schema.decodeUnknownEffect(KanbanBlock)(stub);
      // A window between two cursors.
      const one = yield* ws[M.messages]({
        discussionId: channel.id,
        afterSeq: 248,
        beforeSeq: 250,
      });
      assert.deepStrictEqual(
        one.map((message) => message.seq),
        [249],
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the board feed sends big message blocks as stubs", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Feed", owner);
      const events = yield* kanban.watch(board.id).pipe(
        Stream.filter((event) => event._tag === "change" && event.change._tag === "message"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const posted = yield* kanban.post(channel.id, scribe, [
        { _tag: "md", text: "z".repeat(100 * 1024) },
      ]);
      // The poster gets the message in full.
      assert.strictEqual(
        posted.blocks[0]?._tag === "md" && posted.blocks[0].text.length,
        100 * 1024,
      );
      const [event] = yield* Fiber.join(events);
      assert.strictEqual(event?._tag, "change");
      if (event?._tag === "change" && event.change._tag === "message") {
        const block = event.change.message.blocks[0]!;
        assert.isTrue(block._tag === "md" && block.truncated === true);
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a read already marked never waits on the board lock", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    const lockHeld = yield* Deferred.make<void>();
    const releaseLock = yield* Deferred.make<void>();
    const blockedThreads = Layer.effect(
      KanbanThreads,
      Effect.map(KanbanThreads, (threads) =>
        KanbanThreads.of({
          ...threads,
          launch: (input) =>
            Deferred.succeed(lockHeld, undefined).pipe(
              Effect.andThen(Deferred.await(releaseLock)),
              Effect.andThen(threads.launch(input)),
            ),
        }),
      ),
    ).pipe(Layer.provide(fake.layer));
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const channel = yield* kanban.createDiscussion(board.id, "Read", owner);
      const message = yield* kanban.post(channel.id, scribe, [{ _tag: "md", text: "Hi" }]);
      yield* kanban.markRead(channel.id, owner, message.seq);
      yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const dispatch = yield* Effect.forkChild(kanban.dispatchNow);
      yield* Deferred.await(lockHeld);
      // Launch is waiting outside the lock: reads and new read marks return at once.
      yield* kanban.markRead(channel.id, owner, message.seq);
      yield* kanban.markRead(channel.id, owner, message.seq + 5);
      yield* kanban.markRead(channel.id, { _tag: "evaluator", threadId: ThreadId.make("e") }, 1);
      yield* Deferred.succeed(releaseLock, undefined);
      yield* Fiber.join(dispatch);
    }).pipe(Effect.provide(testLayer(blockedThreads)));
  }),
);

it.effect(
  "saved owner answers and posts reach their evaluator while other cards write during view",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const evaluator = yield* kanban.startEvaluator(board.id, {
          kind: "request",
          text: "Busy board",
        });
        const other = yield* kanban.createCard(
          board.id,
          { prompt: "Other", title: "Other" },
          owner,
        );
        const channel = yield* kanban.createDiscussion(board.id, "Choice", owner);
        const asked = yield* kanban.post(channel.id, { _tag: "evaluator", threadId: evaluator }, [
          {
            _tag: "choice",
            id: "busy-choice",
            style: "pick",
            question: "Proceed?",
            options: [{ id: "yes", label: "Yes" }],
            multi: false,
          },
        ]);
        let writes = 0;
        fake.findControl.beforeRead = () =>
          Effect.forkChild(
            kanban.editCard(other.id, { description: `Concurrent write ${++writes}` }, owner).pipe(
              Effect.asVoid,
              Effect.mapError(
                () => new KanbanThreadError({ operation: "view", detail: "writer failed" }),
              ),
            ),
          ).pipe(Effect.flatMap(Fiber.join));
        yield* kanban.answer(channel.id, asked.seq, "busy-choice", ["yes"], owner);
        yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Saved busy owner post" }]);
        assert.isAbove(writes, 0);
        const messages = (yield* Ref.get(fake.threads)).get(evaluator)!.messages;
        assert.strictEqual(
          messages.filter((text) => text.includes('Owner answered "Proceed?"')).length,
          1,
        );
        assert.strictEqual(
          messages.filter((text) => text.includes("Saved busy owner post")).length,
          1,
        );
        assert.isTrue(
          fake.sends
            .filter((send) => send.threadId === evaluator)
            .slice(-2)
            .every((send) => send.key?.startsWith("owner-")),
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("an accepted owner answer retried after a send error is delivered once", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Retry" });
      const channel = yield* kanban.createDiscussion(board.id, "Retry", owner);
      yield* kanban.post(channel.id, { _tag: "evaluator", threadId: evaluator }, [
        { _tag: "md", text: "Ready" },
      ]);
      fake.commitThenReject.add(evaluator);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Accepted owner reply" }]);
      const messages = (yield* Ref.get(fake.threads)).get(evaluator)!.messages;
      assert.strictEqual(
        messages.filter((text) => text.includes("Accepted owner reply")).length,
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("a pending owner post retains every evaluator asker after asks close", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const first = yield* kanban.startEvaluator(board.id, { kind: "request", text: "First" });
      const second = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Second" });
      const card = yield* kanban.createCard(board.id, { prompt: "Asks", title: "Asks" }, owner);
      yield* kanban.askOwner(
        card.id,
        { question: "One?", blocking: false },
        { _tag: "evaluator", threadId: first },
        "evaluator",
      );
      yield* kanban.askOwner(
        card.id,
        { question: "Two?", blocking: false },
        { _tag: "evaluator", threadId: second },
        "evaluator",
      );
      const discussion = yield* kanban.cardDiscussion(card.id);
      fake.rejectSends.add(second);
      yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Both saved askers" }]);
      fake.rejectSends.delete(second);
      yield* TestClock.adjust("6 seconds");
      const all = yield* Ref.get(fake.threads);
      for (const id of [first, second])
        assert.strictEqual(
          all.get(id)!.messages.filter((text) => text.includes("Both saved askers")).length,
          1,
        );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("repeating an identical owner answer reuses its persisted send key", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const evaluator = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Pick" });
      const channel = yield* kanban.createDiscussion(board.id, "Retry pick", owner);
      const asked = yield* kanban.post(channel.id, { _tag: "evaluator", threadId: evaluator }, [
        {
          _tag: "choice",
          id: "retry-choice",
          style: "pick",
          question: "Again?",
          options: [{ id: "yes", label: "Yes" }],
          multi: false,
        },
      ]);
      const first = yield* kanban.answer(channel.id, asked.seq, "retry-choice", ["yes"], owner);
      yield* TestClock.adjust("1 second");
      const second = yield* kanban.answer(channel.id, asked.seq, "retry-choice", ["yes"], owner);
      assert.strictEqual(first.answers[0]!.at, second.answers[0]!.at);
      const messages = (yield* Ref.get(fake.threads)).get(evaluator)!.messages;
      assert.strictEqual(
        messages.filter((text) => text.includes('Owner answered "Again?"')).length,
        1,
      );
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect(
  "handoff keys do not consume owner answers and launched evaluators hear an answer once",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard;
        const old = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Old" });
        const live = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Live" });
        const card = yield* kanban.createCard(
          board.id,
          { prompt: "Multiple", title: "Multiple" },
          owner,
        );
        yield* kanban.askOwner(
          card.id,
          { question: "Old?", blocking: false },
          { _tag: "evaluator", threadId: old },
          "evaluator",
        );
        yield* kanban.askOwner(
          card.id,
          { question: "Live?", blocking: false },
          { _tag: "evaluator", threadId: live },
          "evaluator",
        );
        const discussion = yield* kanban.cardDiscussion(card.id);
        yield* setArchived(fake, old);
        yield* kanban.post(discussion.id, owner, [{ _tag: "md", text: "Retained launch answer" }]);
        const replacement = (yield* kanban.discussion(discussion.id)).evaluatorThreadId!;
        assert.isNotNull(replacement);
        const all = yield* Ref.get(fake.threads);
        for (const id of [live, replacement]) {
          assert.strictEqual(
            all.get(id)!.messages.filter((text) => text.includes("Retained launch answer")).length,
            1,
          );
        }
        assert.isTrue(
          fake.sends.some((send) => send.threadId === live && send.key?.includes("handoff:")),
        );
      }).pipe(Effect.provide(testLayer(fake.layer)));
    }),
);

it.effect("worker-triggered evaluator handoffs use distinct keys for every prior asker", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const first = yield* kanban.startEvaluator(board.id, { kind: "request", text: "First" });
      const second = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Second" });
      const card = yield* kanban.createCard(
        board.id,
        { prompt: "Handoff", title: "Handoff" },
        owner,
      );
      yield* kanban.dispatchNow;
      const worker = (yield* kanban.card(card.id)).card.activeThreadId!;
      yield* kanban.askOwner(
        card.id,
        { question: "One?", blocking: false },
        { _tag: "evaluator", threadId: first },
        "evaluator",
      );
      yield* kanban.askOwner(
        card.id,
        { question: "Two?", blocking: false },
        { _tag: "evaluator", threadId: second },
        "evaluator",
      );
      const discussion = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(discussion.id, { _tag: "thread", threadId: worker }, [
        { _tag: "md", text: "Can an evaluator help?" },
      ]);
      const replacement = (yield* kanban.discussion(discussion.id)).evaluatorThreadId!;
      assert.isNotNull(replacement);
      for (const id of [first, second]) {
        assert.isTrue(
          fake.sends.some(
            (send) => send.threadId === id && send.key === `handoff:${replacement}:${id}`,
          ),
        );
      }
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
