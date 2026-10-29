import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ProjectId,
  ThreadId,
  type KanbanActor,
  type KanbanBlock,
  type ModelSelection,
  type OrchestrationV2ProviderFailure,
  type ServerProvider,
} from "@t3tools/contracts";

import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import * as KanbanModels from "./models.ts";
import { modelSelectionOf } from "./defaults.ts";
import * as Rules from "./rules.ts";
import * as KanbanService from "./KanbanService.ts";
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
  stuck?: boolean;
  archived: boolean;
}

const makeFake = Effect.gen(function* () {
  const threads = yield* Ref.make(new Map<string, FakeThread>());
  const interrupted: Array<string> = [];
  const prs = new Map<string, ReadonlyArray<KanbanThreadPr>>();
  const failures = new Map<string, OrchestrationV2ProviderFailure>();
  const sends: Array<{ threadId: string; model: ModelSelection | undefined }> = [];
  const modelSwitches: Array<{ threadId: string; model: ModelSelection }> = [];
  let next = 0;
  const layer = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      model: (threadId) =>
        Effect.sync(() => {
          const switched = modelSwitches.filter((s) => s.threadId === threadId).at(-1);
          if (switched) return switched.model;
          return null;
        }),
      view: (threadId) =>
        Ref.get(threads).pipe(
          Effect.map((all): KanbanThreadView | null => {
            const thread = all.get(threadId);
            if (!thread) return null;
            return {
              threadId,
              projectId: ProjectId.make("project-1"),
              title: thread.title,
              state: thread.stuck ? "needs-input" : thread.running ? "running" : "idle",
              updatedAt: "2026-10-25T13:00:00.000Z",
              prs: prs.get(threadId) ?? [],
              archived: thread.archived,
            };
          }),
        ),
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
            if (thread) thread.messages.push(input.text);
            sends.push({ threadId: input.threadId, model: input.model });
            return Effect.void;
          }),
        ),
      setModel: (threadId, model) =>
        Effect.sync(() => void modelSwitches.push({ threadId, model })),
      lastFailure: (threadId) => Effect.succeed(failures.get(threadId) ?? null),
      interrupt: (threadId) => Effect.sync(() => void interrupted.push(threadId)),
    }),
  );
  return { threads, layer, interrupted, prs, failures, sends, modelSwitches };
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

const owner: KanbanActor = { _tag: "owner" };

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
      assert.strictEqual(
        threads.find((link) => link.threadId === workThread)?.cardId,
        created.id,
      );
      // Board threads are the only ones the owner path refuses.
      assert.isNotNull(yield* kanban.caller(workThread));
      assert.isNull(yield* kanban.caller(ThreadId.make("thread-not-from-a-board")));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("asksSomething spots a question, a choice or a call for the evaluator", () =>
  Effect.sync(() => {
    const ask = (blocks: ReadonlyArray<KanbanBlock>) =>
      KanbanService.asksSomething(blocks, KanbanService.blocksText(blocks, () => null));
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
      const created = yield* kanban.createCard(board.id, { prompt: "PIN pad", title: "PIN" }, owner);
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
        yield* kanban.moveCard(card.id, "completed", "evaluator", evaluator);
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
      assert.deepStrictEqual(afterRemove.links.map((link) => link.url), [B]);
      const replaced = yield* kanban.editCard(
        created.id,
        { removeLinks: [B], links: [{ url: C }] },
        owner,
      );
      assert.deepStrictEqual(replaced.links.map((link) => link.url), [C]);
      const refused = yield* kanban
        .editCard(created.id, { removeLinks: ["https://example.com/nope"] }, owner)
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "invalid");
      const unchanged = (yield* kanban.card(created.id)).card;
      assert.deepStrictEqual(unchanged.links.map((link) => link.url), [C]);
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
      yield* kanban.editCard(
        card.id,
        { links: [{ url: contract, label: "contract" }] },
        evaluator,
      );
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

it.effect("another evaluator's change that hands a card's step to its evaluator wakes it once", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 8);
      const owner: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval") };
      const other: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval-other") };
      const reviewed = Effect.fn(function* (
        title: string,
        plan: ReadonlyArray<{ text: string; owner: "work" | "review" | "evaluator"; step?: number }>,
      ) {
        const card = yield* kanban.createCard(board.id, { prompt: title, title, subtasks: plan }, owner);
        yield* kanban.dispatchNow;
        const workThread = (yield* kanban.card(card.id)).card.activeThreadId!;
        const pr = `https://github.com/o/r/pull/${card.number}`;
        fake.prs.set(workThread, [{ url: pr, title, state: "open" }]);
        const worker: KanbanActor = { _tag: "thread", threadId: workThread };
        yield* kanban.markSubtask(card.id, "s1", "done", null, worker, "work");
        yield* kanban.moveCard(card.id, "needs_review", "cardThread", worker);
        yield* kanban.dispatchNow;
        yield* kanban.reviewResult((yield* kanban.card(card.id)).card.activeThreadId!, "clear", []);
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
      yield* kanban.markSubtask(b.id, "s3", "done", "gate passed", { _tag: "evaluator", threadId: ThreadId.make(ownB) }, "evaluator");
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
      const waitingC = (yield* Ref.get(fake.threads)).get(ownC)!.messages.filter((text) =>
        text.includes("waiting on your subtasks"),
      ).length;
      yield* kanban.markSubtask(c.id, "s3", "done", "A", other, "evaluator");
      const waitingAfterA = (yield* Ref.get(fake.threads)).get(ownC)!.messages.filter((text) =>
        text.includes("waiting on your subtasks"),
      ).length;
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
      yield* kanban.moveCard(theirs.id, "completed", "evaluator", evaluator);
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
      yield* kanban.moveCard(card.id, "completed", "evaluator", evaluator);
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
      yield* kanban.moveCard(other.id, "completed", "evaluator", evaluator);
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
      assert.include(messages.at(-1)?.blocks.map((b) => ("text" in b ? b.text : "")).join(""), "Setup is done");

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

it.effect("an owner's new channel goes to the board's live evaluator", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const setup = yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Set it up" });

      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);

      assert.strictEqual((yield* kanban.discussion(channel.id)).evaluatorThreadId, setup);
      const all = [...(yield* Ref.get(fake.threads)).entries()];
      assert.strictEqual(all.filter(([, view]) => view.title.startsWith("Evaluator")).length, 1);
      assert.include(all.find(([id]) => id === setup)![1].messages.at(-1) ?? "", "Round fees up");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an archived evaluator is stopped and its discussion moves to a live one", () =>
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

      assert.strictEqual((yield* kanban.discussion(opened.id)).evaluatorThreadId, request);
      assert.include(fake.interrupted, setup);
      const all = yield* Ref.get(fake.threads);
      assert.isFalse(all.get(setup)!.messages.some((text) => text.includes("Still there?")));
      assert.include(all.get(request)!.messages.at(-1) ?? "", "Still there?");
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

it.effect("a board evaluator whose turn ended still takes the owner's new channel", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const request = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Add a card" });
      yield* kanban.turnEnded(request);
      const store = yield* KanbanStore.KanbanStore;
      assert.isNotNull((yield* store.threadLink(request))?.endedAt ?? null);

      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);

      assert.strictEqual((yield* kanban.discussion(channel.id)).evaluatorThreadId, request);
      const all = [...(yield* Ref.get(fake.threads)).values()];
      assert.strictEqual(all.filter((view) => view.title.startsWith("Evaluator")).length, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("twenty newer non-evaluator links don't hide the live board evaluator", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const request = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Add a card" });
      const store = yield* KanbanStore.KanbanStore;
      for (let i = 0; i < 20; i += 1) {
        yield* store.putThreadLink({
          threadId: ThreadId.make(`noise-${i}`),
          boardId: board.id,
          cardId: null,
          role: "work",
          purpose: null,
          discussionId: null,
          model: null,
          startedAt: "2026-10-25T13:00:00.000Z",
          endedAt: null,
        });
      }

      const channel = yield* kanban.createDiscussion(board.id, "Fees", owner);
      yield* kanban.post(channel.id, owner, [{ _tag: "md", text: "Round fees up" }]);

      assert.strictEqual((yield* kanban.discussion(channel.id)).evaluatorThreadId, request);
      const all = [...(yield* Ref.get(fake.threads)).values()];
      assert.strictEqual(all.filter((view) => view.title.startsWith("Evaluator")).length, 1);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("an owner's pick on an archived evaluator's choice reaches its replacement", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const request = yield* kanban.startEvaluator(board.id, { kind: "request", text: "Add a card" });
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
      assert.include(all.get(next!)!.messages.join("\n"), "Owner answered \"Round up?\"");
    }).pipe(Effect.provide(testLayer(fake.layer)));
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

class ModelDown extends Data.TaggedError("ModelDown")<{}> {}

const groupAsks = (asked: ReadonlyArray<string>) => asked.filter((prompt) => prompt.startsWith("You group"));
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
              return { proposals: [{ name: "Search", summary: "People find things.", cards: [1, 2, 3] }] };
            }
            if (input.prompt.startsWith("You keep a work board's goals")) {
              if (goalAsks(asked).length <= goalFailures) return yield* Effect.fail(new ModelDown());
              const id = /Goal (\S+):/.exec(input.prompt)?.[1] ?? "";
              return {
                assign: [{ card: 2, goal: id }],
                goals: [{ id, now: "Two login cards in progress.", story: "Should be dropped." }],
              };
            }
            if (asked.filter((prompt) => prompt.startsWith("You group")).length <= failures) {
              return yield* Effect.fail(new ModelDown());
            }
            return { groups: [{ id: null, name: "Login", summary: "Sign-in work.", cards: [1, 2] }] };
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

it.effect("the scribe proposes a goal in Goal ideas, once, and his answer goes to an evaluator", () =>
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

const threeLoginCards = (kanban: Effect.Success<typeof KanbanService.KanbanService>, boardId: string) =>
  Effect.forEach(
    [
      ["A", "Login form"],
      ["B", "Login button"],
      ["C", "Login errors"],
    ],
    ([prompt, title]) => kanban.createCard(boardId as never, { prompt: prompt!, title: title!, description: "Sign-in" }, owner),
  );

it.effect("an unanswered proposal still blocks a new one after 20+ replies, with no time passing", () =>
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
      const ideas = (yield* kanban.discussions(board.id)).find((entry) => entry.title === "Goal ideas")!;
      for (let index = 0; index < 205; index++) {
        yield* kanban.post(ideas.id, owner, [{ _tag: "md", text: `reply ${index}` }]);
      }
      yield* kanban.tick;
      assert.lengthOf(asked.filter((prompt) => prompt.startsWith("You suggest goals")), 1);
      assert.lengthOf(yield* kanban.messages(ideas.id, { limit: 300 }), 206);
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
      const ideas = (yield* kanban.discussions(board.id)).find((entry) => entry.title === "Goal ideas")!;
      const [first] = yield* kanban.messages(ideas.id);
      yield* kanban.answer(ideas.id, first!.seq, "goal-1", ["skip"], owner);
      for (let index = 0; index < 205; index++) {
        yield* kanban.post(ideas.id, owner, [{ _tag: "md", text: `reply ${index}` }]);
      }
      yield* TestClock.adjust("25 hours");
      yield* kanban.tick;
      // The skipped Search proposal is still in the history: it is not posted again.
      const messages = yield* kanban.messages(ideas.id, { limit: 300 });
      const choices = messages.flatMap((message) => message.blocks.filter((block) => block._tag === "choice"));
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
      const ideas = (yield* kanban.discussions(board.id)).find((entry) => entry.title === "Goal ideas");
      assert.isTrue(ideas !== undefined);
      assert.lengthOf(yield* kanban.messages(ideas!.id), 1);
      assert.lengthOf(asked.filter((prompt) => prompt.startsWith("You suggest goals")), 1);
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
      yield* kanban.updateDiscussion(snoozed.id, { snoozedUntil: "2999-01-01T09:00:00.000Z" }, owner);

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

it.effect("a new board starts with empty instructions, no review chains and a 0-slot pool per model", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "fresh",
        name: "Fresh",
        defaultProjectId: null,
      });
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
      // The pool's variant wins: a card asking for high on an xhigh pool runs at xhigh.
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "x", title: "x", model: astraHigh },
        owner,
      );
      assert.strictEqual(created.model.options?.find((o) => o.id === "variant")?.value, "xhigh");

      const accepted = yield* kanban.createCard(
        board.id,
        { prompt: "x", title: "x", model: astraXhigh },
        owner,
      );
      const edited = yield* kanban.editCard(accepted.id, { model: astraHigh }, owner);
      assert.strictEqual(edited.model.options?.find((o) => o.id === "variant")?.value, "xhigh");
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

it.effect("the pool's variant wins on create and edit", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      yield* kanban.setPool(board.id, astraXhigh, 1);
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "x", title: "x", model: astraHigh },
        owner,
      );
      assert.strictEqual(created.model.options?.find((o) => o.id === "variant")?.value, "xhigh");
      const edited = yield* kanban.editCard(
        created.id,
        { models: [{ model: astraHigh, weight: 1 }] },
        owner,
      );
      assert.strictEqual(edited.model.options?.find((o) => o.id === "variant")?.value, "xhigh");
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the pool's variant wins for a create without an explicit model", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      // Opus offers high, so a high board default is valid; the Opus xhigh pool wins anyway.
      const opusHigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "high" });
      const opusXhigh = modelSelectionOf({ model: "opus/claude-opus-5-5", variant: "xhigh" });
      yield* kanban.setPool(board.id, opusXhigh, 1);
      yield* kanban.updateBoard(board.id, { defaultCardModel: opusHigh });
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      assert.strictEqual(created.model.options?.find((o) => o.id === "variant")?.value, "xhigh");
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

it.effect("steer on a sibling card after a shared thread's model switch carries the new model", () =>
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
      const card = yield* kanban.createCard(board.id, { prompt: "x", title: "x", model: astraXhigh }, owner);
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
      assert.isTrue(
        evaluators.some((t) => t.messages.some((m) => m.includes("run failed"))),
      );
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

      const slotsOf = (key: string) =>
        Effect.map(
          kanban.snapshot(board.id),
          (snapshot) => snapshot.pools.find((pool) => pool.key === key)!.slots,
        );
      yield* kanban.tick;
      assert.strictEqual(yield* slotsOf(Rules.poolKey(gone)), 2);
      yield* kanban.tick;
      assert.strictEqual(yield* slotsOf(Rules.poolKey(gone)), 0);
      assert.strictEqual(yield* slotsOf(Rules.poolKey(board.defaultCardModel)), 2);
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
        (entry) => entry.key === Rules.poolKey(haiku),
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
      assert.isTrue(added.some((pool) => pool.key === Rules.poolKey(haiku) && pool.slots === 0));
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

it.effect("removePool refuses a pool that a card's pinned work model is on, even with weighted candidates", () =>
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
      const weightedB = modelSelectionOf({ model: "opus/cx/gpt-6.1-sol", instanceId: "opencode" });
      const weightedC = modelSelectionOf({ model: "opus/cc/claude-haiku-5-5", instanceId: "opencode" });
      yield* Ref.set(
        listed,
        new Map<string, KanbanModels.ListedModelEntry>([
          [instance, new Set([board.defaultCardModel.model, pinned.model, weightedB.model, weightedC.model])],
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
