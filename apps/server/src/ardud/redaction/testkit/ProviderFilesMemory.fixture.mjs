import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import { planFile, rewriteFile, countFile } from "../providerFiles.ts";

const compress = NodeUtil.promisify(NodeZlib.gzip);
const needle = "fixture-secret-needle";
const marker = "[redacted]";
const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-memory-"));

async function archive(matched) {
  const line =
    JSON.stringify({
      type: "effect-span",
      attributes: { output: (matched ? needle : "unrelated") + "x".repeat(1900) },
    }) + "\n";
  const lines = Math.floor((16 * 1024 * 1024) / line.length);
  const text = line.repeat(lines);
  return {
    bytes: await compress(text, { level: 6 }),
    expandedBytes: text.length,
    matches: matched ? lines : 0,
  };
}

try {
  const sources = [await archive(false), await archive(true)];
  const plans = [];
  let expandedBytes = 0;
  let expectedMatches = 0;
  let maxRetainedHeap = 0;
  const checkpoint = () => {
    global.gc();
    maxRetainedHeap = Math.max(maxRetainedHeap, process.memoryUsage().heapUsed);
  };
  // Keep all plans alive, as ThreadRedaction does before it permits any mutation.
  for (let index = 0; index < 40; index++) {
    const source = sources[index % 2];
    const file = NodePath.join(directory, `server.trace.ndjson.${index + 1}.gz`);
    await NodeFSP.writeFile(file, source.bytes);
    plans.push(await planFile(file, [needle], marker));
    expandedBytes += source.expandedBytes;
    expectedMatches += source.matches;
    checkpoint();
  }
  let replaced = 0;
  let matchedArchives = 0;
  for (const plan of plans) {
    const result = await Effect.runPromise(rewriteFile(plan, [needle], marker));
    NodeAssert.equal(result.remainingAfter, 0);
    replaced += result.replaced;
    if (result.replaced > 0) matchedArchives++;
    checkpoint();
  }
  let remaining = 0;
  for (const plan of plans) {
    remaining += await countFile(plan.path, [needle]);
    checkpoint();
  }
  NodeAssert.equal(replaced, expectedMatches);
  console.log(
    JSON.stringify({
      archives: plans.length,
      expandedBytes,
      matchedArchives,
      replaced,
      remaining,
      maxRetainedHeap,
    }),
  );
} finally {
  await NodeFSP.rm(directory, { recursive: true, force: true });
}
