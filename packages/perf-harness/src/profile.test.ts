import { test } from "node:test";
import assert from "node:assert/strict";
import { rank } from "./profile.ts";
test("profile attribution counts every sample once, including native descendants", () => {
  const frame = (functionName: string) => ({ functionName, url: "", lineNumber: 0, columnNumber: 0 });
  const result = rank({ nodes: [
    { id: 1, callFrame: frame("sql"), children: [2] },
    { id: 2, callFrame: frame("native") },
    { id: 3, callFrame: frame("idle") },
  ], samples: [2, 1, 3], timeDeltas: [4000, 1000, 5000] }, f => f.functionName === "sql" ? "sql.ts:10" : undefined);
  assert.equal(result.totalMs, 10);
  assert.deepEqual(result.blockers.find(b => b.location === "sql.ts:10"), { location: "sql.ts:10", ms: 5, elapsedSharePct: 50 });
  assert.equal(result.blockers.reduce((sum, b) => sum + b.elapsedSharePct, 0), 100);
});
