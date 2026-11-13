import { assert, describe, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";

import { sampleMix } from "./samples.ts";
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
  it("rolls MCP calls up by tool/hour/build and correlates adjacent retries across hours and builds", () => {
    const accumulator = makeAccumulator();
    const call = (input: Partial<AnalyticsEvent>): AnalyticsEvent =>
      event({
        kind: "mcp.call",
        tool: "card_update",
        build: "old",
        callerThreadId: "caller",
        clientRequestId: "a".repeat(64),
        durationMs: 10,
        outcome: "error",
        saved: false,
        errorTag: "caller_unresolved",
        errorPhase: "caller",
        ...input,
      });
    // Emission can complete out of order. A different caller/tool must never count as a retry.
    for (const row of [
      call({ ts: "2026-11-13T13:01:00.000Z", build: "new", outcome: "ok", durationMs: 40 }),
      call({ ts: "2026-11-13T12:02:00.000Z", outcome: "timeout", durationMs: 30 }),
      call({ ts: "2026-11-13T12:01:00.000Z", durationMs: 20 }),
      call({ callerThreadId: "other", outcome: "ok" }),
      call({ tool: "card_move", outcome: "ok" }),
      call({
        clientRequestId: "b".repeat(64),
        outcome: "refused",
        errorTag: "board_busy",
        errorPhase: "handler",
      }),
    ])
      accumulate(accumulator, row);
    const rollup = finishRollup(accumulator, "2026-11-13", ts);
    const old = rollup.mcpCalls.find(
      (group) => group.tool === "card_update" && group.build === "old",
    )!;
    assert.deepInclude(old, {
      count: 4,
      failures: 3,
      failureRate: 0.75,
      p50Ms: 10,
      p95Ms: 30,
      maxMs: 30,
      failedThenRetried: 2,
      retrySucceeded: 1,
    });
    assert.deepEqual(old.outcomes, { error: 1, timeout: 1, ok: 1, refused: 1 });
    assert.deepEqual(old.errors, [
      { errorTag: "caller_unresolved", errorPhase: "caller", count: 2 },
      { errorTag: "board_busy", errorPhase: "handler", count: 1 },
    ]);
    assert.equal(
      rollup.mcpCalls.find((group) => group.build === "new")!.hour,
      "2026-11-13T13:00:00.000Z",
    );
    assert.deepEqual(rollup.mcpOverflow, { groups: 0, retryAttempts: 0 });
    assert.deepEqual(finishRollup(accumulator, "2026-11-13", ts), rollup);
  });
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

describe("board analytics", () => {
  it("rolls up metadata, durations, cross-day asks and pool snapshots out of order", () => {
    const acc = makeAccumulator();
    const boardId = "board-crpko";
    const rows: Partial<AnalyticsEvent>[] = [
      {
        kind: "kanban.card_move",
        cardId: "a",
        props: { from: "todo", to: "working", msInPrevStage: 100 },
      },
      {
        kind: "kanban.card_move",
        cardId: "b",
        props: { from: "todo", to: "working", msInPrevStage: 1000 },
      },
      {
        kind: "kanban.review_verdict",
        cardId: "a",
        durationMs: 30,
        props: { round: 2, chain: "sol", verdict: "clear", head: "abcdef1" },
      },
      {
        kind: "kanban.review_verdict",
        cardId: "a",
        durationMs: 90,
        props: { round: 1, chain: "sol", verdict: "feedback", head: "abcdef2" },
      },
      { kind: "kanban.stall", props: { action: "set", reasonClass: "timeout", ageMs: 0 } },
      { kind: "kanban.stall", props: { action: "clear", reasonClass: "timeout", ageMs: 300 } },
      {
        kind: "kanban.worker_failed",
        props: { errorClass: "variant_unavailable", poolKey: "sol" },
      },
      { kind: "kanban.worker_restarted", props: { phase: "fresh" } },
      { kind: "kanban.ask_snapshot", props: { count: 1 } },
      {
        kind: "kanban.ask_pending",
        cardId: "a",
        props: {
          key: "q1",
          createdAt: "2026-11-12T12:00:00.000Z",
          kind: "approval",
          blocking: true,
        },
      },
      { kind: "ask.answered", cardId: "b", props: { key: "q1", createdAt: ts } },
      { kind: "kanban.ask_opened", cardId: "b", props: { key: "q1", createdAt: ts } },
      { kind: "kanban.ask_closed", cardId: "c", props: { key: "q1", createdAt: ts } },
      { kind: "kanban.pool_usage", props: { poolKey: "sol", used: 2, slots: 4, waiting: 3 } },
      { kind: "kanban.pool_usage", props: { poolKey: "sol", used: 4, slots: 4, waiting: 1 } },
      { kind: "kanban.pool_usage", props: { poolKey: "paused", used: 0, slots: 0, waiting: 1 } },
    ];
    for (const row of rows.toReversed()) accumulate(acc, event({ ...row, boardId }));
    accumulate(
      acc,
      event({ kind: "kanban.worker_failed", boardId: "other", props: { errorClass: "other" } }),
    );
    const result = finishRollup(acc, "2026-11-13", ts);
    const board = result.boards.find((b) => b.boardId === boardId)!;
    assert.deepEqual(board.moves, [{ from: "todo", to: "working", count: 2 }]);
    assert.deepInclude(board.timeInStage[0], { stage: "todo", p50Ms: 100, p95Ms: 1000 });
    assert.deepEqual(board.reviewRounds, [{ cardId: "a", rounds: 2, verdicts: 2 }]);
    assert.deepEqual(board.verdictCounts, { feedback: 1, clear: 1 });
    assert.deepInclude(board.stalls[0], { sets: 1, clears: 1, p50Ms: 300 });
    assert.deepEqual(board.failureCounts, { variant_unavailable: 1 });
    assert.equal(board.restarts, 1);
    assert.lengthOf(board.openAsks, 1);
    assert.deepInclude(board.openAsks[0], {
      cardId: "a",
      key: "q1",
      ageMs: 86_400_000,
      blocking: true,
    });
    assert.deepInclude(
      board.poolUtilisation.find((p) => p.poolKey === "sol"),
      { used: 3, slots: 4, waiting: 2, utilisation: 0.75, samples: 2 },
    );
    assert.isNull(board.poolUtilisation.find((p) => p.poolKey === "paused")!.utilisation);
    assert.equal(result.boards.length, 2);
  });
  it("mixes rare board kinds before UI noise, caps each kind and uses timestamps across segments", () => {
    const mix = sampleMix(100);
    for (let i = 0; i < 500; i++) mix.add(event({ kind: "performance.long-task" }));
    for (let i = 0; i < 100; i++) mix.add(event({ kind: "kanban.queue_depth" }));
    mix.add(event({ kind: "kanban.card_move" }));
    mix.add(event({ kind: "kanban.review_verdict" }));
    const rows = mix.finish();
    assert.isTrue(rows.slice(0, 3).some((row) => row.kind === "kanban.card_move"));
    assert.isTrue(rows.slice(0, 3).some((row) => row.kind === "kanban.review_verdict"));
    assert.equal(rows.filter((row) => row.kind === "kanban.queue_depth").length, 50);
    const exact = sampleMix(1, "server.rpc");
    exact.add(event({ ts: "2026-11-13T13:00:00.000Z" }));
    exact.add(event({ ts }));
    assert.equal(exact.finish()[0]?.ts, "2026-11-13T13:00:00.000Z");
  });
});

it("retains the last complete backlog when a newer snapshot loses rows", () => {
  const acc = makeAccumulator();
  const boardId = "board-crpko";
  const emit = (kind: string, at: string, cardId?: string, props?: AnalyticsEvent["props"]) =>
    accumulate(
      acc,
      event({ boardId, kind, ts: at, ...(cardId ? { cardId } : {}), ...(props ? { props } : {}) }),
    );
  const earlier = "2026-11-13T11:00:00.000Z";
  emit("kanban.ask_pending", earlier, "a", { key: "q1", createdAt: earlier });
  emit("kanban.ask_snapshot", earlier, undefined, { count: 1 });
  emit("kanban.ask_snapshot", ts, undefined, { count: 2 });
  emit("kanban.ask_pending", ts, "b", { key: "q1", createdAt: earlier });
  let board = finishRollup(acc, "2026-11-13", ts).boards[0]!;
  assert.equal(board.openAsksAsOf, earlier);
  assert.equal(board.incompleteAskSnapshots, 1);
  assert.deepEqual(
    board.openAsks.map((ask) => ask.cardId),
    ["a"],
  );
  emit("kanban.ask_opened", ts, "c", {
    key: "q1",
    kind: "question",
    blocking: false,
    createdAt: ts,
  });
  emit("kanban.ask_updated", ts, "c", {
    key: "q1",
    kind: "approval",
    blocking: true,
    createdAt: ts,
  });
  board = finishRollup(acc, "2026-11-13", ts).boards[0]!;
  assert.deepInclude(
    board.openAsks.find((ask) => ask.cardId === "c"),
    { kind: "approval", blocking: true },
  );
  emit("kanban.ask_snapshot", "2026-11-13T13:00:00.000Z", undefined, { count: 0 });
  assert.lengthOf(
    finishRollup(acc, "2026-11-13", "2026-11-13T13:00:00.000Z").boards[0]!.openAsks,
    0,
  );
});
