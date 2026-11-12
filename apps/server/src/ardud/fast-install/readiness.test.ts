import { assert, it } from "@effect/vitest";
import { canServeBeforeRecovery } from "./readiness.ts";

it("serves reads while fencing writes and WebSocket commands during recovery", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) assert.isTrue(canServeBeforeRecovery(method));
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    assert.isFalse(canServeBeforeRecovery(method));
  assert.isFalse(canServeBeforeRecovery("GET", "websocket"));
  assert.isFalse(canServeBeforeRecovery("GET", "WebSocket"));
});
