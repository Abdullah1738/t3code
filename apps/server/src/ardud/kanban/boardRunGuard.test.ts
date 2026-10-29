import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { refuseBoardRunDispatch } from "../../ws.ts";
import { OrchestrationV2DispatchCommandError } from "@t3tools/contracts";

// The owner's message.dispatch on a board-run thread is refused at the owner RPC
// entry. Board steering goes through KanbanThreads.send, not this RPC path; the
// service-level send is exercised by KanbanService.test.ts ("routes owner messages
// to the live thread"), which this guard does not touch.

const boardLink = {
  threadId: "thread-board",
  boardId: "board-1",
  cardId: null,
  role: "work",
  purpose: null,
  discussionId: null,
  model: null,
  startedAt: "2026-10-27T00:00:00.000Z",
  endedAt: null,
} as const;

const kanbanWith = (links: Record<string, unknown>) => ({
  caller: (threadId: string) => Effect.succeed((links[threadId] ?? null) as never),
});

const message = (threadId: string) =>
  ({
    type: "message.dispatch",
    commandId: "cmd-1",
    threadId,
  }) as never;

it.effect("refuses an owner message to a board-run thread with the read-only error", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      refuseBoardRunDispatch(kanbanWith({ "thread-board": boardLink }), message("thread-board")),
    );
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find(Cause.isFailReason);
      const error = failure?.error;
      assert.instanceOf(error, OrchestrationV2DispatchCommandError);
      assert.strictEqual(error?.message, "This thread belongs to a board run and is read-only.");
      assert.strictEqual(error?.detail, "board-thread-read-only");
      assert.strictEqual(error?.commandId, "cmd-1");
    }
  }),
);

it.effect("lets an owner message through for a thread the board did not start", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      refuseBoardRunDispatch(kanbanWith({}), message("thread-plain")),
    );
    assert.isTrue(Exit.isSuccess(exit));
  }),
);

it.effect("leaves non-message commands alone, even for a board-run thread", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      refuseBoardRunDispatch(kanbanWith({ "thread-board": boardLink }), {
        type: "thread.fork",
        commandId: "cmd-2",
        targetThreadId: "thread-board",
      } as never),
    );
    assert.isTrue(Exit.isSuccess(exit));
  }),
);
