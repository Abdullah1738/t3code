import { test } from "node:test";
import assert from "node:assert/strict";
import { compare } from "./compare.ts";
import { percentiles, type Run } from "./metrics.ts";

function evidence(sha: string, answerMs = 100): Run[] {
  return Array.from({ length: 10 }, (_, repeat) => {
    const requests = Object.fromEntries(["boards", "board", "discussion", "post", "move", "answer"].map((name) =>
      [name + ".response.ms", Array(40).fill(name === "answer" ? answerMs : 100)]));
    return { gateVersion: "paired-bootstrap-v2", sha, repeat, scale: "5x", agents: 128,
      fixtureHash: "fixture", hardwareHash: "host", harnessHash: "harness", runtimeHash: "runtime", seed: 42,
      correctness: "unmeasured", requests,
      ownerAnswers: { workload: "owner-answers-v2", rpcAnswers: 40, consumedAsks: 40, routedAsks: 40, launchedEvaluators: 10, mockProvider: "acp-local", mockDelivered: 40, liveDelivery: "unmeasured" },
      metrics: { ...Object.fromEntries(Object.entries(requests).map(([key, values]) => [key, percentiles(values)!.p95])),
        "answer.response.ms.p95": answerMs, "eventLoop.p99.ms": 10, "eventLoop.max.ms": 20, "wal.writeBytesPerOp": 100 }, gaps: [],
    };
  });
}
const budgets = { metrics: { "answer.response.ms.p95": { max: 500 } } };

test("owner-answer response and mock delivery coverage cannot silently disappear", () => {
  const base = evidence("base"), candidate = evidence("candidate");
  assert.partialDeepStrictEqual(compare(base, candidate, budgets), {
    performanceVerdict: "pass", budgetVerdict: "incomplete",
    ownerAnswerCoverage: { asks: "pass", mockDelivery: "pass", liveDelivery: "unmeasured" },
    ownerAnswerTarget: { verdict: "pass", candidateP95Ms: 100 },
  });
  delete candidate[0]!.requests!["answer.response.ms"];
  assert.equal(compare(base, candidate, budgets).performanceVerdict, "incomplete");
  const short = evidence("candidate");
  short[0]!.requests!["answer.response.ms"]!.pop();
  assert.equal(compare(base, short, budgets).ownerAnswerTarget.verdict, "incomplete");
  const repeated = evidence("candidate");
  repeated[0]!.requests!["answer.response.ms"]!.push(100);
  assert.equal(compare(base, repeated, budgets).performanceVerdict, "incomplete");
  const noAsks = evidence("candidate");
  noAsks[0]!.ownerAnswers!.consumedAsks = 39;
  assert.equal(compare(base, noAsks, budgets).performanceVerdict, "incomplete");
  const mixed = evidence("candidate");
  mixed[0]!.ownerAnswers!.rpcAnswers = 20;
  assert.equal(compare(base, mixed, budgets).performanceVerdict, "incomplete");
  const old = evidence("candidate");
  old[0]!.ownerAnswers!.workload = "owner-answers-v1";
  assert.equal(compare(base, old, budgets).performanceVerdict, "incomplete");
  const noDelivery = evidence("candidate");
  noDelivery[0]!.ownerAnswers!.mockDelivered = 0;
  assert.equal(compare(base, noDelivery, budgets).ownerAnswerCoverage.mockDelivery, "unmeasured");
});

test("5x pooled owner-answer p95 must be strictly below 500ms even with no relative regression", () => {
  for (const [ms, verdict] of [[499, "pass"], [500, "fail"], [501, "fail"]] as const) {
    const result = compare(evidence("base", ms), evidence("candidate", ms), budgets);
    assert.equal(result.ownerAnswerTarget.verdict, verdict);
    assert.equal(result.performanceVerdict, verdict);
  }
  const base = evidence("base", 600), candidate = evidence("candidate", 600);
  for (const run of [...base, ...candidate]) run.scale = "1x";
  assert.equal(compare(base, candidate, budgets).ownerAnswerTarget.verdict, "not-applicable");
});

test("owner-answer p95 shift and clustered p99 regression are gated", () => {
  assert.equal(compare(evidence("base", 100), evidence("candidate", 120), budgets).performanceVerdict, "fail");
  const base = evidence("base"), candidate = evidence("candidate");
  for (const run of candidate) run.requests!["answer.response.ms"]![39] = 150;
  assert.partialDeepStrictEqual(compare(base, candidate, budgets), {
    performanceVerdict: "fail", tails: { "answer.response.ms": { verdict: "fail", ratio: 1.5 } },
  });
});
