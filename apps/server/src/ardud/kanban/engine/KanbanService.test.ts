import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

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
      interrupt: () => Effect.void,
    }),
  );
  return { threads, layer };
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
