import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";

import { boardEventRoute } from "./layer.ts";

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
    for (const type of [
      "runtime-request.updated",
      "node.updated",
      "turn-item.updated",
      "provider-session.updated",
    ]) {
      assert.strictEqual(boardEventRoute(event(type)), "threadChanged", type);
    }
  });

  it("ignores events that do not change a thread's live state", () => {
    assert.isNull(boardEventRoute(event("message.updated")));
  });
});
