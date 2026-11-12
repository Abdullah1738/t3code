import { test } from "node:test";
import assert from "node:assert/strict";
import { random, scales } from "./fixture.ts";
test("seed repeatability and production scale sizes", () => {
  const a = random(42),
    b = random(42),
    c = random(43);
  const aa = Array.from({ length: 100 }, a),
    bb = Array.from({ length: 100 }, b),
    cc = Array.from({ length: 100 }, c);
  assert.deepEqual(aa, bb);
  assert.notDeepEqual(aa, cc);
  assert.equal(scales["5x"].threads, 5 * scales["1x"].threads);
  assert.equal(scales["10x"].nodes, 10 * scales["1x"].nodes);
});
