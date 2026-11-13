import { assert, describe, it } from "@effect/vitest";
import type { AnalyticsEvent, RunUsageEvent } from "@t3tools/contracts";

import { accumulate, boundedLines, finishRollup, makeAccumulator } from "./rollup.ts";

const ts = "2026-11-13T12:00:00.000Z";
const event = (input: Partial<AnalyticsEvent> = {}): AnalyticsEvent => ({
  ts,
  kind: "server.rpc",
  surface: "server",
  route: "kanban.list",
  ...input,
});

describe("analytics rollups", () => {
  it("counts kinds and errors, ranks real RPC timings, and measures answered asks", () => {
    const accumulator = makeAccumulator();
    for (const durationMs of [10, 20, 30, 40, 100]) {
      accumulate(accumulator, event({ durationMs, props: { method: "kanban.list" } }));
    }
    accumulate(
      accumulator,
      event({ durationMs: 500, props: { method: "threads.read", errorTag: "NotFound" } }),
    );
    accumulate(
      accumulator,
      event({
        kind: "rpc.summary",
        surface: "web",
        props: { method: "client.aggregate", count: 20, p50Ms: 100, p95Ms: 200 },
      }),
    );
    accumulate(accumulator, event({ kind: "ownerAsk.answered", durationMs: 1_000 }));
    accumulate(
      accumulator,
      event({ kind: "ownerAsk.answered", props: { createdAt: "2026-11-13T11:59:57.000Z" } }),
    );
    accumulate(accumulator, event({ kind: "ownerAsk.created", durationMs: 99_999 }));
    accumulate(
      accumulator,
      event({
        durationMs: 3_600_000,
        props: { method: "subscribeThread", phase: "stream-lifetime" },
      }),
    );
    const rollup = finishRollup(accumulator, "2026-11-13", ts);
    assert.equal(rollup.total, 11);
    assert.equal(rollup.kindCounts["server.rpc"], 7);
    assert.deepStrictEqual(rollup.errorCounts, { NotFound: 1 });
    assert.deepStrictEqual(
      rollup.topSlowRpcs.map(({ method, count, p50Ms, p95Ms }) => ({
        method,
        count,
        p50Ms,
        p95Ms,
      })),
      [
        { method: "threads.read", count: 1, p50Ms: 500, p95Ms: 500 },
        { method: "kanban.list", count: 5, p50Ms: 30, p95Ms: 100 },
      ],
    );
    assert.deepStrictEqual(rollup.askAnswerLatency, {
      count: 2,
      p50Ms: 1_000,
      p95Ms: 3_000,
      maxMs: 3_000,
      approximate: false,
    });
  });

  it("bounds group cardinality and switches large timing groups to a bounded histogram", () => {
    const accumulator = makeAccumulator();
    for (let index = 1; index <= 1_000; index++) {
      accumulate(accumulator, event({ durationMs: index, props: { method: "kanban.list" } }));
    }
    const rollup = finishRollup(accumulator, "2026-11-13", ts);
    const timings = accumulator.rpcs.get("kanban.list")!;
    assert.lengthOf(timings.exact, 0);
    assert.isBelow(timings.histogram!.size, 400);
    const rpc = rollup.topSlowRpcs.find(({ method }) => method === "kanban.list")!;
    assert.isTrue(rpc.approximate);
    assert.isAtLeast(rpc.p50Ms!, 500);
    assert.isBelow(rpc.p50Ms!, 510);
    assert.isAtLeast(rpc.p95Ms!, 950);
    assert.isBelow(rpc.p95Ms!, 969);
    for (let index = 1; index <= 1_000; index++) {
      accumulate(
        accumulator,
        event({ kind: `kind.${index}`, props: { errorTag: `error.${index}` } }),
      );
      accumulate(accumulator, event({ durationMs: index, props: { method: `method.${index}` } }));
    }
    assert.isAtMost(accumulator.kinds.size, 129);
    assert.isAtMost(accumulator.errors.size, 129);
    assert.isAtMost(accumulator.rpcs.size, 129);
    assert.isAtMost(finishRollup(accumulator, "2026-11-13", ts).topSlowRpcs.length, 20);
  });

  it("keeps line fragments bounded and resumes after a damaged oversized line", () => {
    const lines = boundedLines(8);
    assert.deepStrictEqual(lines.push("abc"), []);
    assert.deepStrictEqual(lines.push("def\ng"), ["abcdef"]);
    assert.deepStrictEqual(lines.push("x".repeat(1_000_000)), []);
    assert.deepStrictEqual(lines.push("\nok\nlast"), [null, "ok"]);
    assert.deepStrictEqual(lines.finish(), ["last"]);
  });

  it("preserves submillisecond precision after switching to approximate percentiles", () => {
    const accumulator = makeAccumulator();
    for (let index = 0; index < 1_000; index++) {
      accumulate(
        accumulator,
        event({ durationMs: index < 999 ? 0.25 : 10, props: { method: "fast.read" } }),
      );
    }
    const timings = finishRollup(accumulator, "2026-11-13", ts).topSlowRpcs[0]!;
    assert.isTrue(timings.approximate);
    assert.isAtLeast(timings.p50Ms!, 0.25);
    assert.isBelow(timings.p50Ms!, 0.255);
  });
});

it("rolls up usage by model, role, board and card, without counting cache twice", () => {
  const accumulator = makeAccumulator();
  const row: RunUsageEvent = {
    ts,
    kind: "run.usage",
    surface: "server",
    route: "provider",
    runId: "run:1",
    threadId: "thread:one",
    boardId: "robob",
    cardId: "card:one",
    role: "work",
    providerInstance: "codex",
    model: "gpt-6.1-sol",
    effort: "max",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 80,
    reasoningTokens: 10,
    wallMs: 1000,
    turnCount: 1,
    endReason: "completed",
    usageStatus: "complete",
    reviewRound: null,
  };
  accumulate(accumulator, row);
  accumulate(accumulator, row); // An ambiguous append replay.
  for (const [runId, role, reviewRound] of [
    ["2", "review", 1],
    ["3", "review", 1],
    ["4", "review", 2],
    ["5", "evaluator", null],
  ] as const)
    accumulate(accumulator, { ...row, runId, role, reviewRound });
  accumulate(accumulator, {
    ...row,
    runId: "6",
    cardId: "card:two",
    model: "unsupported",
    role: "discussion",
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
    wallMs: 10000,
    usageStatus: "unavailable",
  });
  const usage = finishRollup(accumulator, "2026-11-13", ts).usage;
  assert.equal(usage.totals.runs, 6);
  assert.equal(usage.totals.inputTokens, 500);
  assert.equal(usage.totals.outputTokens, 100);
  assert.equal(usage.totals.cachedInputTokens, 400);
  assert.equal(usage.totals.reasoningTokens, 50);
  assert.equal(usage.totals.wallMs, 15000);
  assert.equal(usage.perBoard[0]?.runs, 6);
  assert.equal(usage.perRole.find((r) => r.role === "review")?.runs, 3);
  assert.equal(usage.perModel.find((r) => r.model === "unsupported")?.inputTokens, null);
  assert.equal(usage.cards.find((r) => r.cardId === "card:one")?.reviewRounds, 2);
  assert.equal(usage.cards.find((r) => r.cardId === "card:one")?.evaluatorWakes, 1);
  assert.equal(usage.cards.find((r) => r.cardId === "card:two")?.evaluatorWakes, 1);
  assert.equal(usage.topCardsByTokens[0]?.cardId, "card:one");
  assert.equal(usage.topCardsByWallMs[0]?.cardId, "card:two");
  for (let i = 0; i < 25; i++)
    accumulate(accumulator, { ...row, runId: `extra:${i}`, cardId: `card:extra:${i}` });
  assert.equal(finishRollup(accumulator, "2026-11-13", ts).usage.topCardsByTokens.length, 20);
});
