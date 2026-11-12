import { test } from "node:test";
import assert from "node:assert/strict";
import { actionIdAttributes } from "../../../apps/server/src/ardud/observability/actionCorrelation.ts";
test("action headers accept bounded opaque ids and reject malformed data", () => {
  assert.deepEqual(actionIdAttributes("action:test-1"), { "action.id": "action:test-1" });
  for (const value of [undefined, {}, "x".repeat(129), "line\nbreak", ""])
    assert.deepEqual(actionIdAttributes(value), {});
});
