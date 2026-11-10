import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";

import { boardEventRoute, threadEventOf } from "./layer.ts";

// The route decides what the board does with each orchestration event. Thread
// state changes without a run status change (a question opens or resolves), so
// those events must reach the board, not just the terminal run updates.
const event = (type: string, payload: object = {}) =>
  ({ type, threadId: "thread-1", payload }) as unknown as OrchestrationV2DomainEvent;

describe("boardEventRoute", () => {
  it("ends a board turn only on a terminal run update", () => {
    assert.strictEqual(boardEventRoute(event("run.updated", { status: "completed" })), "turnEnd");
    assert.strictEqual(
      boardEventRoute(event("run.updated", { status: "running" })),
      "threadChanged",
    );
  });

  it("re-announces thread state when a question opens or resolves without a run update", () => {
    assert.strictEqual(boardEventRoute(event("runtime-request.updated")), "threadChanged");
  });

  it("ignores streamed output, which would reread the whole board on every paragraph", () => {
    for (const type of ["node.updated", "turn-item.updated", "provider-session.updated", "message.updated"]) {
      assert.isNull(boardEventRoute(event(type)), type);
    }
  });
});

describe("threadEventOf", () => {
  // A run or message started from anywhere (UI, control API, another board
  // action) moves the thread's read fence, so a stale rerun reads it again.
  it("names the thread for runs, messages and requests", () => {
    for (const type of ["run.created", "run.updated", "message.updated", "runtime-request.updated", "thread.model-selection.set"]) {
      assert.strictEqual(threadEventOf(event(type)), "thread-1", type);
    }
  });

  it("skips streamed output and events without a thread", () => {
    assert.isNull(threadEventOf(event("node.updated")));
    assert.isNull(threadEventOf(event("turn-item.updated")));
    assert.isNull(threadEventOf({ type: "project.created", payload: {} } as unknown as OrchestrationV2DomainEvent));
  });
});
