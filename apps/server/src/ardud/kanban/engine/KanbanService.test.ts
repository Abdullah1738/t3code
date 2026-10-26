import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProjectId, ThreadId, type KanbanActor, type ModelSelection } from "@t3tools/contracts";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import * as KanbanService from "./KanbanService.ts";
import { KanbanThreads, type KanbanThreadView } from "./threads.ts";

interface FakeThread {
  readonly title: string;
  readonly model: ModelSelection;
  readonly messages: Array<string>;
  running: boolean;
}

const makeFake = Effect.gen(function* () {
  const threads = yield* Ref.make(new Map<string, FakeThread>());
  const interrupted: Array<string> = [];
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
              prs: [],
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
      interrupt: (threadId) => Effect.sync(() => void interrupted.push(threadId)),
    }),
  );
  return { threads, layer, interrupted };
});

const testLayer = (fake: Layer.Layer<KanbanThreads>) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
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
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(second.id)).card.stage, "working");
      assert.strictEqual((yield* kanban.card(first.id)).card.stage, "todo");
      assert.strictEqual((yield* kanban.card(blocked.id)).card.stage, "todo");

      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      yield* kanban.dispatchNow;
      assert.strictEqual((yield* kanban.card(first.id)).card.stage, "working");
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
  yield* kanban.setPool(board.id, board.defaultCardModel, 1);
  return { kanban, board };
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

it.effect("board summaries count running, waiting and unread as they change", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const { kanban, board } = yield* toyBoard;
      const card = yield* kanban.createCard(board.id, { prompt: "A", title: "A" }, owner);
      const pull = yield* Stream.toPull(kanban.boardSummaries);
      // Each pull takes what is queued, one list per batch; the last is the list now.
      const latest = Effect.map(pull, (chunk) => {
        const { board: summarized, ...counts } = chunk.at(-1)![0]!;
        assert.strictEqual(summarized.id, board.id);
        return counts;
      });
      assert.deepStrictEqual(yield* latest, { needsOwner: 0, running: 0, unread: 0 });

      yield* kanban.dispatchNow;
      assert.deepStrictEqual(yield* latest, { needsOwner: 0, running: 1, unread: 0 });

      const thread = (yield* kanban.card(card.id)).card.activeThreadId!;
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

      const discussion = yield* kanban.cardDiscussion(card.id);
      yield* kanban.markRead(discussion.id, owner, discussion.lastSeq);
      assert.deepStrictEqual(yield* latest, { needsOwner: 1, running: 0, unread: 0 });
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
