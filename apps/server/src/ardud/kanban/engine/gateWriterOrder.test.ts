import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { KanbanCard, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as KanbanStore from "../store/KanbanStore.ts";
import { fileTestLayer, makeFake, owner, toyBoard, workingCard } from "./askFlows.testkit.ts";
import * as BoardLocks from "./boardLocks.ts";
import * as SavedWrite from "./savedWrite.ts";

it.live(
  "dispatch and a foreign author's discussion post commit without a writer/gate cycle",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gate-writer-" });
      const authorHeld = yield* Deferred.make<void>();
      const resumeAuthor = yield* Deferred.make<void>();
      const dispatchHeld = yield* Deferred.make<void>();
      const resumeDispatch = yield* Deferred.make<void>();
      const postAdmission = yield* Deferred.make<void>();
      let target: KanbanCard["id"] | undefined;
      let author: ThreadId | undefined;
      let authorReads = 0;
      let resumed = false;
      const latchedStore = Layer.effect(
        KanbanStore.KanbanStore,
        Effect.map(KanbanStore.KanbanStore, (real) => ({
          ...real,
          threadLink: (id: string) =>
            Effect.gen(function* () {
              const row = yield* real.threadLink(id);
              // LockedStore's second lookup runs under the author's own board gate.
              if (id === author && ++authorReads === 2) {
                yield* Deferred.succeed(authorHeld, undefined);
                yield* Deferred.await(resumeAuthor);
              }
              return row;
            }),
          putCard: (row: KanbanCard) =>
            Effect.gen(function* () {
              if (row.id === target) {
                target = undefined;
                // The planning repair holds the gate immediately before its writer request.
                yield* Deferred.succeed(dispatchHeld, undefined);
                yield* Deferred.await(resumeDispatch);
              }
              return yield* real.putCard(row);
            }),
        })),
      ).pipe(Layer.provide(KanbanStore.layer));
      yield* Effect.gen(function* () {
        const { kanban, board } = yield* toyBoard("target");
        const foreign = yield* workingCard("Author");
        const card = yield* kanban.createCard(
          board.id,
          {
            title: "Dispatch me",
            prompt: "Work",
            subtasks: [{ text: "Work", owner: "work" }],
          },
          owner,
        );
        const discussion = yield* kanban.createDiscussion(board.id, "Messages", owner);
        yield* (yield* KanbanStore.KanbanStore).putCard({ ...card, wakeNote: "Do s99 again" });
        author = foreign.threadId;
        const posting = yield* Effect.forkChild(
          Effect.gen(function* () {
            const span = yield* Effect.currentSpan;
            return yield* kanban
              .post(discussion.id, foreign.worker, [{ _tag: "md", text: "Hello" }])
              .pipe(
                Effect.provideService(SavedWrite.traceObserver, {
                  span,
                  enter(stage) {
                    if (resumed && stage === "admission")
                      Deferred.doneUnsafe(postAdmission, Effect.void);
                    return () => {};
                  },
                  mark() {},
                }),
              );
          }).pipe(Effect.withSpan("test.concurrentPost")),
        );
        yield* Deferred.await(authorHeld);
        target = card.id;
        const dispatching = yield* Effect.forkChild(kanban.dispatchNow);
        yield* Deferred.await(dispatchHeld);
        resumed = true;
        yield* Deferred.succeed(resumeAuthor, undefined);
        // On the old ordering this admission happens while the post owns the writer.
        yield* Effect.raceFirst(Deferred.await(postAdmission), Fiber.join(posting));
        yield* Deferred.succeed(resumeDispatch, undefined);
        const message = yield* Fiber.join(posting);
        yield* Fiber.join(dispatching);
        assert.equal(message.seq, 1);
        assert.deepEqual(
          (yield* kanban.messages(discussion.id)).map((row) => row.blocks),
          [[{ _tag: "md", text: "Hello" }]],
        );
        assert.equal((yield* kanban.discussion(discussion.id)).lastSeq, 1);
        assert.equal((yield* kanban.card(card.id)).card.stage, "working");
      }).pipe(
        Effect.provideService(BoardLocks.writeWaitMs, 200),
        Effect.provide(fileTestLayer(fake.layer, path.join(dir, "state.sqlite"), latchedStore)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
