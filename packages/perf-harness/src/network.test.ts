import { test } from "node:test";
import assert from "node:assert/strict";
import { shapedFetch } from "./network.ts";
test("mobile simulation delivers real bytes after RTT and bandwidth pacing", async () => {
  const result = await shapedFetch(async () => new Response(new Uint8Array(125000)));
  assert.equal(result.bytes, 125000);
  assert.ok(result.ms >= 195);
});
