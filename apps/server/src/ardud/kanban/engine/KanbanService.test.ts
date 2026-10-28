import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
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
} from "@t3tools/contracts";

import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import { modelSelectionOf } from "./defaults.ts";
import * as Rules from "./rules.ts";
import * as KanbanService from "./KanbanService.ts";
import { opencodeTestProvider } from "./testProviders.ts";
import { KanbanThreads, type KanbanThreadPr, type KanbanThreadView } from "./threads.ts";

interface FakeThread {
  readonly title: string;
  readonly model: ModelSelection;
  readonly messages: Array<string>;
  running: boolean;
}

const makeFake = Effect.gen(function* () {
  const threads = yield* Ref.make(new Map<string, FakeThread>());
  const interrupted: Array<string> = [];
  const prs = new Map<string, ReadonlyArray<KanbanThreadPr>>();
  const failures = new Map<string, OrchestrationV2ProviderFailure>();
  let next = 0;
  const layer = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      view: (threadId) =>
        Ref.get(threads).pipe(
          Effect.map((all): KanbanThreadView | null => {
            const thread = all.get(threadId);
            if (!thread) return null;
            return {
              threadId,
              projectId: ProjectId.make("project-1"),
              title: thread.title,
              state: thread.running ? "running" : "idle",
              updatedAt: "2026-10-25T13:00:00.000Z",
              prs: prs.get(threadId) ?? [],
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
          });
          return [threadId, copy] as const;
        }),
      send: (input) =>
        Ref.update(threads, (all) => {
          const thread = all.get(input.threadId);
          if (thread) thread.messages.push(input.text);
          return all;
        }),
      lastFailure: (threadId) => Effect.succeed(failures.get(threadId) ?? null),
      interrupt: (threadId) => Effect.sync(() => void interrupted.push(threadId)),
    }),
  );
  return { threads, layer, interrupted, prs, failures };
});

/** Board file storage (ServerConfig + FileSystem) that KanbanService now needs when built. */
const boardFilesLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-kanban-test-",
}).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(ServerSettings.layerTest()));

const testLayer = (fake: Layer.Layer<KanbanThreads>) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
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

const titledLayer = (fake: Layer.Layer<KanbanThreads>, asked: Array<string>) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
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
      // there would hold them back too.
      const busy: KanbanActor = {
        _tag: "evaluator",
        threadId: yield* kanban.startEvaluator(board.id, { kind: "setup", text: "Busy" }),
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
      const refused = yield* kanban
        .createCard(board.id, { prompt: "x", title: "x", model: astraHigh }, owner)
        .pipe(Effect.flip);
      assert.include(refused.detail, 'has no "high" variant; it offers: xhigh');

      const accepted = yield* kanban.createCard(
        board.id,
        { prompt: "x", title: "x", model: astraXhigh },
        owner,
      );
      const refusedEdit = yield* kanban
        .editCard(accepted.id, { model: astraHigh }, owner)
        .pipe(Effect.flip);
      assert.include(refusedEdit.detail, 'has no "high" variant; it offers: xhigh');
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
      assert.strictEqual((yield* Ref.get(fake.threads)).size, 0);
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
      // The Standard review step's model needs a slot for the review thread to start.
      yield* kanban.setPool(board.id, board.evaluatorModel, 1);
      const created = yield* kanban.createCard(board.id, { prompt: "x", title: "x" }, owner);
      yield* kanban.dispatchNow;
      const workThread = (yield* kanban.card(created.id)).card.activeThreadId!;
      yield* kanban.moveCard(created.id, "needs_review", "cardThread", {
        _tag: "thread",
        threadId: workThread,
      });
      yield* kanban.dispatchNow;
      const reviewCard = (yield* kanban.card(created.id)).card;
      const reviewThread = reviewCard.activeThreadId!;
      assert.strictEqual(
        reviewThread === null,
        false,
        `no review thread: ${JSON.stringify({ stage: reviewCard.stage, role: reviewCard.activeRole, stalled: reviewCard.stalled, pool: reviewCard.activePool })}`,
      );
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
