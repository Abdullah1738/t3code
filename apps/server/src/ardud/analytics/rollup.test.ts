import { assert, describe, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";

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

it("groups error routes, MCP codes and DB spans with bounded, lossless overflow", () => {
  const target = makeAccumulator();
  for (let i = 0; i < 40; i++) {
    for (const durationMs of [10, 100]) {
      accumulate(
        target,
        event({
          kind: "server.http",
          route: `route.${i}`,
          durationMs,
          props: { method: "POST", status: 503, errorTag: "Http5xx" },
        }),
      );
      accumulate(
        target,
        event({
          kind: "mcp.call",
          tool: `tool.${i}`,
          durationMs,
          outcome: "error",
          props: { code: "caller_unresolved" },
        }),
      );
      accumulate(
        target,
        event({
          kind: "server.mcp.error",
          durationMs,
          props: { method: `tool.${i}`, code: "caller_unresolved", errorTag: "McpToolError" },
        }),
      );
      accumulate(
        target,
        event({
          kind: "db.slow",
          durationMs,
          props: { span: `Service.${i}`, key: "reader", phase: "read", waitMs: 3 },
        }),
      );
    }
  }
  const rollup = finishRollup(target, "2026-11-13", ts);
  for (const rows of [rollup.errorsByRoute, rollup.mcpErrorsByCode, rollup.dbSlowBySpan]) {
    assert.lengthOf(rows, 25);
    assert.isTrue(rows.every((row) => row.p95Ms === 100));
  }
  assert.equal(
    rollup.errorsByRoute.reduce((sum, row) => sum + row.count, 0),
    160,
  );
  assert.equal(
    rollup.mcpErrorsByCode.reduce((sum, row) => sum + row.count, 0),
    80,
  );
  assert.equal(
    rollup.dbSlowBySpan.reduce((sum, row) => sum + row.count, 0),
    80,
  );
  assert.deepInclude(
    rollup.dbSlowBySpan.find((row) => row.span === "other")!,
    { count: 32, totalWaitMs: 96, maxMs: 100 },
  );
  assert.equal(
    rollup.dbSlowBySpan.reduce((sum, row) => sum + row.totalWaitMs, 0),
    240,
  );
});

it("keeps HTTP method/status/tag and DB connection/phase distinct", () => {
  const target = makeAccumulator();
  for (const method of ["GET", "POST"])
    for (const status of [400, 500])
      for (const errorTag of ["Interrupted", "Failure"]) {
        accumulate(
          target,
          event({ kind: "server.http", durationMs: 17, props: { method, status, errorTag } }),
        );
      }
  for (const key of ["reader", "writer"])
    for (const phase of ["read", "write"]) {
      accumulate(
        target,
        event({ kind: "db.slow", durationMs: 500, props: { span: "Service.read", key, phase } }),
      );
    }
  const rollup = finishRollup(target, "2026-11-13", ts);
  assert.lengthOf(rollup.errorsByRoute, 8);
  assert.lengthOf(rollup.dbSlowBySpan, 4);
  assert.isTrue(rollup.dbSlowBySpan.every((row) => row.totalWaitMs === 0));
});

it("preserves all 25 groups until overflow requires an other row", () => {
  const target = makeAccumulator();
  for (let i = 0; i < 25; i++)
    accumulate(
      target,
      event({ kind: "db.slow", durationMs: i, props: { span: `Service.${i}`, waitMs: 2 } }),
    );
  const exact = finishRollup(target, "2026-11-13", ts).dbSlowBySpan;
  assert.lengthOf(exact, 25);
  assert.isFalse(exact.some((row) => row.span === "other"));
  accumulate(
    target,
    event({ kind: "db.slow", durationMs: 99, props: { span: "Service.25", waitMs: 3 } }),
  );
  const overflow = finishRollup(target, "2026-11-13", ts).dbSlowBySpan;
  assert.lengthOf(overflow, 25);
  assert.deepInclude(
    overflow.find((row) => row.span === "other")!,
    { count: 2, totalWaitMs: 5, p95Ms: 99, maxMs: 99 },
  );
});
