import { assert, describe, it } from "@effect/vitest";
import type { AnalyticsEvent, RunUsageEvent } from "@t3tools/contracts";
import { LONG_TASK_HISTOGRAM_RATIO } from "@t3tools/contracts";

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
  it("sums statement work and actual process bytes without counting unavailable intervals as idle", () => {
    const target = makeAccumulator();
    for (const connection of ["reader", "reader", "export"])
      accumulate(
        target,
        event({
          kind: "db.statement.summary",
          props: {
            database: "statev2.sqlite",
            connection,
            lane: "background",
            sqlFingerprint: "abc",
            key: "SELECT:threads",
            count: 12,
            totalMs: 20,
            maxMs: 5,
            resultCount: 6,
            failures: 1,
          },
        }),
      );
    accumulate(
      target,
      event({ kind: "db.process.disk_read", props: { readBytes: 1000, sampleMs: 60000 } }),
    );
    accumulate(
      target,
      event({ kind: "db.process.disk_read", props: { readBytes: 0, sampleMs: 60000 } }),
    );
    accumulate(target, event({ kind: "db.process.disk_read", props: { reason: "unavailable" } }));
    const result = finishRollup(target, "2026-11-13", ts);
    assert.deepInclude(result.dbStatementFamilies?.[0], {
      connection: "reader",
      calls: 24,
      totalMs: 40,
      maxMs: 5,
      returnedRows: 12,
      failures: 2,
    });
    assert.strictEqual(result.dbStatementFamilies?.length, 2);
    assert.deepEqual(result.processDiskRead, {
      readBytes: 1000,
      sampleMs: 120000,
      samples: 2,
      unavailableSamples: 1,
    });
  });

  it("groups control routes by UTC hour and method, retaining statuses and deadline counts", () => {
    const target = makeAccumulator();
    const sample = (durationMs: number, status: number, hour = "12", method = "GET") =>
      event({
        kind: "rpc.request",
        route: "/api/ardud/control/threads/:threadId",
        ts: `2026-11-13T${hour}:00:00.000Z`,
        durationMs,
        props: {
          method: "control.thread",
          httpRoute: "/api/ardud/control/threads/:threadId",
          httpMethod: method,
          status,
          waitMs: 4,
        },
      });
    accumulate(target, sample(10, 200));
    accumulate(target, sample(15000, 503));
    accumulate(target, sample(30, 200, "13"));
    accumulate(target, sample(40, 409, "12", "PATCH"));
    accumulate(target, { ...sample(50, 200, "13"), startedAt: "2026-11-13T12:59:59.999Z" });
    accumulate(
      target,
      event({
        kind: "rpc.request",
        route: "control.thread",
        durationMs: 999,
        props: { method: "control.thread" },
      }),
    );
    const rows = finishRollup(target, "2026-11-13", ts).controlRoutes!;
    assert.equal(rows.length, 3);
    assert.deepInclude(
      rows.find((row) => row.hour.endsWith("12") && row.method === "GET"),
      {
        count: 3,
        p50Ms: 50,
        p95Ms: 15000,
        maxMs: 15000,
        statuses: { "200": 2, "503": 1 },
        totalWaitMs: 12,
        deadlineExceeded: 1,
      },
    );
    assert.equal(rows.find((row) => row.hour.endsWith("13"))!.p95Ms, 30);
    assert.equal(rows.find((row) => row.method === "PATCH")!.p95Ms, 40);
  });

  it("bounds control route cardinality without dropping overflow durations", () => {
    const target = makeAccumulator();
    for (let i = 0; i < 4100; i++)
      accumulate(
        target,
        event({
          kind: "rpc.request",
          route: `/api/ardud/control/route-${i}`,
          durationMs: i,
          props: {
            httpMethod: "GET",
            httpRoute: `/api/ardud/control/route-${i}`,
            method: "control.test",
            status: 200,
          },
        }),
      );
    const rows = finishRollup(target, "2026-11-13", ts).controlRoutes!;
    assert.equal(rows.length, 4097);
    assert.equal(
      rows.reduce((sum, row) => sum + row.count, 0),
      4100,
    );
    assert.equal(rows.find((row) => row.route === "__other__")!.maxMs, 4099);
  });
  it("counts actual children separately from operations by provider, board and launch hour beyond the sample limit", () => {
    const target = makeAccumulator();
    for (let i = 0; i < 600; i++)
      accumulate(
        target,
        event({
          kind: "text-generation.child",
          boardId: "board-robob",
          durationMs: 20,
          startedAt: "2026-11-13T11:59:59.000Z",
          outcome: "ok",
          props: {
            provider: "claude",
            operation: "generateJson:writeGroups",
            count: 1,
            exitCode: 0,
          },
        }),
      );
    accumulate(
      target,
      event({
        kind: "text-generation.operation",
        boardId: "board-robob",
        durationMs: 50,
        outcome: "error",
        props: { provider: "claude", operation: "generateJson:writeGroups", count: 1 },
      }),
    );
    accumulate(
      target,
      event({
        kind: "text-generation.child",
        boardId: "board-other",
        durationMs: 10,
        outcome: "interrupted",
        props: { provider: "codex", operation: "generateThreadTitle", count: 1 },
      }),
    );
    const rows = finishRollup(target, "2026-11-13", ts).textGeneration!;
    assert.equal(rows.length, 3);
    const many = rows.find((row) => row.count === 600)!;
    assert.closeTo(many.p50Ms!, 20, 0.4);
    assert.closeTo(many.p95Ms!, 20, 0.4);
    assert.deepEqual(
      { ...many, p50Ms: 20, p95Ms: 20 },
      {
        hour: "11",
        provider: "claude",
        operation: "generateJson:writeGroups",
        boardId: "board-robob",
        kind: "child",
        outcome: "ok",
        count: 600,
        p50Ms: 20,
        p95Ms: 20,
        maxMs: 20,
        approximate: true,
      },
    );
    assert.equal(rows.find((row) => row.kind === "operation")?.outcome, "error");
    assert.equal(rows.find((row) => row.provider === "codex")?.outcome, "interrupted");
  });

  it("rolls server tick phases up independently by board and phase, including idle phases", () => {
    const accumulator = makeAccumulator();
    const phase = (boardId: string, phase: string, durationMs: number) =>
      event({
        kind: "kanban.tick_phase",
        boardId,
        durationMs,
        props: { phase, count: 2, tickId: "tick-1" },
      });
    for (const duration of [10, 20, 90])
      accumulate(accumulator, phase("a", "thread_status", duration));
    accumulate(accumulator, phase("a", "event_persistence", 0));
    accumulate(accumulator, phase("b", "thread_status", 1_000));
    // Older ticks and overlaps have no phase sample; incomplete and client-shaped rows don't invent one.
    accumulate(accumulator, event({ kind: "kanban.tick", boardId: "a", durationMs: 900_000 }));
    accumulate(accumulator, event({ kind: "kanban.tick_overlap", boardId: "a" }));
    accumulate(accumulator, event({ kind: "kanban.tick_phase", boardId: "a", durationMs: 10 }));
    accumulate(
      accumulator,
      event({ kind: "kanban.tick_phase", boardId: "a", props: { phase: "thread_status" } }),
    );
    accumulate(accumulator, { ...phase("a", "thread_status", 10_000), surface: "web" });
    const rollup = finishRollup(accumulator, "2026-11-13", ts);
    assert.deepEqual(rollup.tickPhases, [
      {
        boardId: "a",
        phase: "event_persistence",
        count: 1,
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
        approximate: false,
      },
      {
        boardId: "a",
        phase: "thread_status",
        count: 3,
        p50Ms: 20,
        p95Ms: 90,
        maxMs: 90,
        approximate: false,
      },
      {
        boardId: "b",
        phase: "thread_status",
        count: 1,
        p50Ms: 1_000,
        p95Ms: 1_000,
        maxMs: 1_000,
        approximate: false,
      },
    ]);
    assert.equal(rollup.kindCounts["kanban.tick_overlap"], 1);
  });

  it("separates restart interruptions by boot and tool", () => {
    const accumulator = makeAccumulator();
    for (const [bootId, tool] of [
      ["boot-a", "delegate_task"],
      ["boot-b", "delegate_task"],
      ["boot-a", "card_update"],
      ["boot-a", "delegate_task"],
    ] as const) {
      accumulate(
        accumulator,
        event({ kind: "mcp.call", bootId, tool, outcome: "interrupted_by_shutdown" }),
      );
    }
    assert.deepEqual(
      finishRollup(accumulator, "2026-11-13", ts).mcpCalls.map(({ bootId, tool, outcomes }) => ({
        bootId,
        tool,
        outcomes,
      })),
      [
        { bootId: "boot-a", tool: "card_update", outcomes: { interrupted_by_shutdown: 1 } },
        { bootId: "boot-a", tool: "delegate_task", outcomes: { interrupted_by_shutdown: 2 } },
        { bootId: "boot-b", tool: "delegate_task", outcomes: { interrupted_by_shutdown: 1 } },
      ],
    );
  });

  it("merges long-task histograms by route and surface without counting individual samples twice", () => {
    const accumulator = makeAccumulator();
    const bucket = (ms: number) => Math.ceil(Math.log(ms) / Math.log(LONG_TASK_HISTOGRAM_RATIO));
    const summary = (
      props: NonNullable<AnalyticsEvent["props"]>,
      surface: AnalyticsEvent["surface"] = "desktop",
    ) => event({ kind: "performance.long-task-summary", route: "board", surface, props });
    accumulate(
      accumulator,
      summary({
        count: 99,
        totalMs: 9900,
        maxMs: 100,
        wallTimeMs: 60_000,
        histogram: [[bucket(100), 99]],
      }),
    );
    accumulate(
      accumulator,
      summary({
        count: 1,
        totalMs: 500,
        maxMs: 500,
        wallTimeMs: 60_000,
        histogram: [[bucket(500), 1]],
      }),
    );
    accumulate(
      accumulator,
      summary({ count: 0, totalMs: 0, maxMs: 0, wallTimeMs: 60_000, histogram: [] }),
    );
    accumulate(
      accumulator,
      event({ kind: "performance.long-task", surface: "desktop", route: "board", durationMs: 500 }),
    );
    accumulate(
      accumulator,
      summary(
        { count: 1, totalMs: 800, maxMs: 800, wallTimeMs: 10_000, histogram: [[bucket(800), 1]] },
        "web",
      ),
    );
    // An inconsistent distribution must not create a misleading percentile.
    accumulate(
      accumulator,
      summary({ count: 1000, totalMs: 10, maxMs: 10, wallTimeMs: 60_000, histogram: [[0, 1]] }),
    );
    const rows = finishRollup(accumulator, "2026-11-13", ts).longTasksByRoute;
    assert.lengthOf(rows, 2);
    assert.deepInclude(rows[0], {
      route: "board",
      surface: "desktop",
      count: 100,
      totalMs: 10_400,
      maxMs: 500,
      wallTimeMs: 180_000,
      wallTimeShare: 10_400 / 180_000,
      approximate: true,
    });
    assert.isAtLeast(rows[0]!.p95Ms!, 100);
    assert.isBelow(rows[0]!.p95Ms!, 102);
    assert.equal(rows[1]!.p95Ms, 800);
  });
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
      call({
        ts: "2026-11-13T12:01:00.000Z",
        durationMs: 20,
        errorFields: ["limit", "events.limit", "limit"],
      }),
      call({ callerThreadId: "other", outcome: "ok" }),
      call({ tool: "card_move", outcome: "ok" }),
      call({
        clientRequestId: "b".repeat(64),
        outcome: "refused",
        errorTag: "board_busy",
        errorPhase: "handler",
        errorFields: ["limit"],
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
    assert.deepEqual(old.errorFields, { limit: 2, "events.limit": 1 });
    assert.deepEqual(old.errors, [
      { errorTag: "caller_unresolved", errorPhase: "caller", count: 2 },
      { errorTag: "board_busy", errorPhase: "handler", count: 1 },
    ]);
    assert.equal(
      rollup.mcpCalls.find((group) => group.build === "new")!.hour,
      "2026-11-13T13:00:00.000Z",
    );
    assert.deepEqual(rollup.mcpOverflow, { groups: 0, retryAttempts: 0, detachedOutcomes: 0 });
    assert.deepEqual(finishRollup(accumulator, "2026-11-13", ts), rollup);
  });
  it("keeps deadline stages separate from dispatch and historical handler failures", () => {
    const accumulator = makeAccumulator();
    for (const errorPhase of [
      "parent_records",
      "parent_records",
      "dispatch",
      "handler",
      undefined,
    ] as const)
      accumulate(
        accumulator,
        event({
          kind: "mcp.call",
          tool: "delegate_task",
          outcome: "timeout",
          errorTag: "delegation_timeout",
          ...(errorPhase === undefined ? {} : { errorPhase }),
        }),
      );
    const rollup = finishRollup(accumulator, "2026-11-13", ts);
    assert.sameDeepMembers(
      [...rollup.mcpCalls[0]!.errors],
      [
        { errorTag: "delegation_timeout", errorPhase: "parent_records", count: 2 },
        { errorTag: "delegation_timeout", errorPhase: "handler", count: 2 },
        { errorTag: "delegation_timeout", errorPhase: "dispatch", count: 1 },
      ],
    );
    assert.equal(rollup.mcpFailureBreakdown![0]!.count, 5);
    assert.equal(rollup.mcpFailureContexts![0]!.count, 5);
  });
  it("keeps pre-handler percentiles separate and skips historical calls without timing", () => {
    const accumulator = makeAccumulator();
    for (const preHandlerMs of [undefined, undefined, 0, 20, 80]) {
      accumulate(
        accumulator,
        event({
          kind: "mcp.call",
          tool: "card_get",
          outcome: "ok",
          durationMs: 10,
          ...(preHandlerMs === undefined ? {} : { preHandlerMs }),
        }),
      );
    }
    accumulate(
      accumulator,
      event({
        kind: "mcp.call",
        tool: "card_move",
        outcome: "ok",
        durationMs: 100,
      }),
    );
    const rollup = finishRollup(accumulator, "2026-11-13", ts);
    assert.deepInclude(
      rollup.mcpCalls.find((row) => row.tool === "card_get"),
      {
        count: 5,
        p50Ms: 10,
        p95Ms: 10,
        maxMs: 10,
        preHandler: { count: 3, p50Ms: 20, p95Ms: 80, maxMs: 80, approximate: false },
      },
    );
    assert.deepEqual(rollup.mcpCalls.find((row) => row.tool === "card_move")!.preHandler, {
      count: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      approximate: false,
    });
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
      accumulate(
        accumulator,
        event({
          kind: "kanban.tick_phase",
          boardId: `board-${index}`,
          durationMs: index,
          props: { phase: "thread_status" },
        }),
      );
    }
    assert.isAtMost(accumulator.kinds.size, 129);
    assert.isAtMost(accumulator.errors.size, 129);
    assert.isAtMost(accumulator.rpcs.size, 129);
    assert.isAtMost(accumulator.tickPhases.size, 129);
    assert.equal(
      finishRollup(accumulator, "2026-11-13", ts).tickPhases!.find(
        (group) => group.phase === "__other__",
      )!.count,
      872,
    );
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
      { kind: "kanban.assignment_wake_failed", props: { count: 1 } },
      { kind: "kanban.assignment_wake_failed", props: { count: 2 } },
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
    assert.deepEqual(board.failureCounts, { variant_unavailable: 1, assignment_wake: 2 });
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

it("retains pool configuration changes per board alongside pool snapshots beyond sample limits", () => {
  const target = makeAccumulator();
  for (let index = 0; index < 501; index++)
    accumulate(
      target,
      event({
        kind: "kanban.pool_change",
        boardId: "board-a",
        props: {
          poolKey: "codex/sol#xhigh",
          fromSlots: index,
          toSlots: index + 1,
          op: "set",
          actorKind: "owner",
          actorId: null,
        },
      }),
    );
  accumulate(
    target,
    event({
      kind: "kanban.pool_change",
      boardId: "board-b",
      props: {
        poolKey: "codex/sol#xhigh",
        fromSlots: 2,
        toSlots: 0,
        op: "auto_zero",
        actorKind: "system",
        actorId: null,
      },
    }),
  );
  const boards = finishRollup(target, "2026-11-13", ts).boards;
  assert.equal(boards.find((board) => board.boardId === "board-a")!.poolChanges!.length, 501);
  assert.deepEqual(boards.find((board) => board.boardId === "board-b")!.poolChanges, [
    {
      at: ts,
      poolKey: "codex/sol#xhigh",
      fromSlots: 2,
      toSlots: 0,
      op: "auto_zero",
      actorKind: "system",
      actorId: null,
    },
  ]);
});

it("groups fixed denial reasons and roles and measures each timeout phase separately", () => {
  const target = makeAccumulator();
  for (const [callerRole, denyReason] of [
    ["work", "not_card_owner"],
    ["work", "not_card_owner"],
    ["review", "role_not_allowed"],
  ] as const) {
    accumulate(
      target,
      event({
        kind: "mcp.call",
        tool: "subtask_done",
        outcome: "refused",
        errorTag: "capability_denied",
        callerRole,
        denyReason,
        durationMs: 20,
      }),
    );
  }
  for (const ms of [10, 20, 100])
    accumulate(
      target,
      event({
        kind: "mcp.call",
        tool: "card_edit",
        outcome: "timeout",
        errorTag: "reply_timeout",
        callerRole: "evaluator",
        durationMs: 25000,
        replyPhases: { admission: ms, read: 2, commit: 3, ack: 4 },
        writePhases: { lockWait: ms, read: 2, write: 3, replyWait: 4 },
      }),
    );
  for (const errorTag of ["Defect", "McpToolError"])
    accumulate(
      target,
      event({
        kind: "mcp.call",
        tool: "probe",
        outcome: "error",
        errorTag,
        props: { code: "unknown" },
        durationMs: 1,
      }),
    );
  const rollup = finishRollup(target, "2026-11-13", ts);
  assert.deepEqual(
    rollup
      .mcpFailureContexts!.filter((row) => row.tool === "probe")
      .map((row) => row.errorTag)
      .sort(),
    ["Defect", "McpToolError"],
  );
  const rows = rollup.mcpFailureBreakdown!;
  const denied = rows.find((row) => row.tool === "subtask_done")!;
  assert.deepEqual(denied.byReason, { not_card_owner: 2, role_not_allowed: 1 });
  assert.deepEqual(denied.byRole, { work: 2, review: 1 });
  const timeout = rollup.mcpReplyTimeouts!.find((row) => row.tool === "card_edit")!;
  assert.equal(timeout.callerRole, "evaluator");
  assert.deepEqual(rows.find((row) => row.tool === "card_edit")!.byRole, { evaluator: 3 });
  assert.deepEqual(timeout.replyPhases.admission, {
    count: 3,
    p50Ms: 20,
    p95Ms: 100,
    maxMs: 100,
    approximate: false,
  });
  assert.equal(timeout.replyPhases.ack?.p95Ms, 4);
  assert.equal(timeout.writePhases.replyWait?.p95Ms, 4);
  assert.equal(
    rollup.mcpFailureContexts!.find((row) => row.tool === "card_edit")?.callerRole,
    "evaluator",
  );
});

it("keeps caller reader lanes separate from handler database lanes", () => {
  const target = makeAccumulator();
  const lanes = [
    { callerReaderLane: "identity", readerLane: "identity" },
    { callerReaderLane: "background", readerLane: "foreground" },
    { readerLane: "foreground" },
    { callerReaderLane: "foreground" },
    {},
  ] as const;
  for (const lane of lanes)
    accumulate(
      target,
      event({
        kind: "mcp.call",
        tool: "t3_thread_read",
        outcome: "timeout",
        errorTag: "lookup_timeout",
        durationMs: 95550,
        ...lane,
      }),
    );
  accumulate(
    target,
    event({
      kind: "db.slow",
      durationMs: 65960,
      props: { span: "loadReadableThread", key: "reader.background", phase: "slot", waitMs: 65960 },
    }),
  );
  const rollup = finishRollup(target, "2026-11-13", ts);
  assert.deepEqual(rollup.mcpFailureBreakdown![0]!.byCallerReaderLane, {
    foreground: 2,
    identity: 1,
    background: 1,
    unknown: 1,
  });
  assert.equal(rollup.mcpErrorsByCode[0]!.count, 5);
  assert.deepInclude(rollup.dbSlowBySpan[0], {
    key: "reader.background",
    count: 1,
    totalWaitMs: 65960,
  });
});

it("#1490 counts evaluator starts by origin without treating steers and queued inputs as starts", () => {
  const target = makeAccumulator();
  for (const outcome of ["started", "reused", "merged", "queued_spawn_cap"] as const)
    accumulate(
      target,
      event({
        kind: "kanban.evaluator",
        boardId: "board-offbox",
        purposeKind: "discussion",
        trigger: "discussion_post",
        outcome,
      }),
    );
  accumulate(
    target,
    event({
      kind: "kanban.evaluator",
      boardId: "board-offbox",
      purposeKind: "request",
      trigger: "report_bug",
      outcome: "started",
      reuseMissReason: "no_card_reuse_scope",
    }),
  );
  const result = finishRollup(target, "2026-11-13", ts);
  assert.deepEqual(result.evaluatorStartsByTrigger, [
    { boardId: "board-offbox", trigger: "discussion_post", count: 1 },
    { boardId: "board-offbox", trigger: "report_bug", count: 1 },
  ]);
  assert.equal(
    result.evaluatorOutcomes!.reduce((n, row) => n + row.count, 0),
    5,
  );
  assert.deepEqual(result.errorCounts, {});
});

it("counts and bounds refusal classes and fields per tool and hour", () => {
  const target = makeAccumulator();
  for (let i = 0; i < 160; i++)
    accumulate(
      target,
      event({
        kind: "mcp.call",
        tool: "card_create",
        outcome: "error",
        saved: false,
        reasonClass: i % 2 === 0 ? "duplicate_title" : "missing_required",
        invalidField: `field${i}`,
      }),
    );
  accumulate(
    target,
    event({
      kind: "mcp.call",
      tool: "wiki_read",
      outcome: "error",
      reasonClass: "not_found",
      invalidField: "slug",
    }),
  );
  const rows = finishRollup(target, "2026-11-13", ts).mcpCalls;
  const write = rows.find((row) => row.tool === "card_create")!;
  assert.deepEqual(write.reasonClasses, { duplicate_title: 80, missing_required: 80 });
  assert.equal(Object.keys(write.invalidFields).length, 129);
  assert.equal(
    Object.values(write.invalidFields).reduce((sum, count) => sum + count, 0),
    160,
  );
  assert.deepEqual(write.savedCounts, { false: 160 });
  const read = rows.find((row) => row.tool === "wiki_read")!;
  assert.deepEqual(read.reasonClasses, { not_found: 1 });
  assert.deepEqual(read.invalidFields, { slug: 1 });
  assert.deepEqual(read.savedCounts, { "n/a": 1 });
});
const timeoutCall = (input: Partial<AnalyticsEvent> = {}) =>
  event({
    kind: "mcp.call",
    route: "mcp",
    tool: "delegate_task",
    outcome: "timeout",
    errorPhase: "dispatch",
    clientRequestId: "a".repeat(64),
    callerThreadId: "caller",
    build: "test",
    bootId: "boot",
    durationMs: 10000,
    ...input,
  });
const detachedResult = (input: Partial<AnalyticsEvent> = {}) =>
  timeoutCall({
    ts: "2026-11-13T12:00:15.000Z",
    kind: "mcp.detached",
    outcome: "committed",
    startedAt: ts,
    lateMs: 5000,
    ...input,
  });
const finishDetached = (events: AnalyticsEvent[]) => {
  const target = makeAccumulator();
  for (const event of events) accumulate(target, event);
  return finishRollup(target, "2026-11-13", ts);
};

it("splits dispatch timeouts into matched outcomes and missing results", () => {
  const rows = finishDetached([
    timeoutCall(),
    timeoutCall({ clientRequestId: "b".repeat(64) }),
    detachedResult(),
  ]).mcpCalls;
  assert.deepEqual(rows[0]!.dispatchTimeouts, { committed: 1, failed: 0, capped: 0, noOutcome: 1 });
});

it.each([false, true])(
  "matches overlapping same-id retries once, independent of emission order (reversed=%s)",
  (reverse) => {
    const events = [
      timeoutCall(),
      timeoutCall({ ts: "2026-11-13T12:00:20.000Z" }),
      timeoutCall({ ts: "2026-11-13T12:00:40.000Z" }),
      timeoutCall({ ts: "2026-11-13T12:00:50.000Z", outcome: "ok" }),
      detachedResult({ startedAt: "2026-11-13T12:00:20.000Z", ts: "2026-11-13T12:01:00.000Z" }),
    ];
    const target = makeAccumulator();
    for (const event of reverse ? events.toReversed() : events) accumulate(target, event);
    const rollup = finishRollup(target, "2026-11-13", ts);
    assert.deepEqual(rollup.mcpCalls[0]!.dispatchTimeouts, {
      committed: 1,
      failed: 0,
      capped: 0,
      noOutcome: 2,
    });
    assert.deepEqual(finishRollup(target, "2026-11-13", ts), rollup);
  },
);

it.each(["committed", "failed", "capped"] as const)(
  "counts %s once, including an after-cap settlement",
  (outcome) => {
    const rows = [timeoutCall(), detachedResult({ outcome: "capped" })];
    if (outcome !== "capped")
      rows.push(detachedResult({ outcome, ts: "2026-11-13T12:02:10.000Z", afterCap: true }));
    const counts = { committed: 0, failed: 0, capped: 0, noOutcome: 0, [outcome]: 1 };
    assert.deepEqual(finishDetached(rows.toReversed()).mcpCalls[0]!.dispatchTimeouts, counts);
    if (outcome !== "capped")
      assert.deepEqual(finishDetached([rows[0]!, rows[2]!]).mcpCalls[0]!.dispatchTimeouts, counts);
  },
);

it.each([
  { tool: "other" },
  { clientRequestId: "b".repeat(64) },
  { bootId: "other" },
  { ts: "2026-11-14T00:00:01.000Z" },
  { startedAt: "2026-11-13T12:00:01.000Z" },
])("does not cross correlation boundaries: %j", (boundary) => {
  assert.deepEqual(
    finishDetached([timeoutCall(), detachedResult(boundary)]).mcpCalls[0]!.dispatchTimeouts,
    { committed: 0, failed: 0, capped: 0, noOutcome: 1 },
  );
});

it("attributes a late result to the call's original UTC hour", () => {
  const call = timeoutCall({ ts: "2026-11-13T12:59:55.000Z" });
  const result = detachedResult({ ts: "2026-11-13T13:00:15.000Z", startedAt: call.ts });
  const row = finishDetached([result, call]).mcpCalls[0]!;
  assert.equal(row.hour, "2026-11-13T12:00:00.000Z");
  assert.equal(row.dispatchTimeouts!.committed, 1);
});

it("keeps unkeyed timeouts and bounds detached observations without counting one call twice", () => {
  const target = makeAccumulator();
  accumulate(target, timeoutCall());
  const { clientRequestId: _requestId, ...unkeyed } = timeoutCall();
  accumulate(target, unkeyed);
  for (let index = 0; index < 100001; index++) accumulate(target, detachedResult());
  const result = finishRollup(target, "2026-11-13", ts);
  assert.deepEqual(result.mcpCalls[0]!.dispatchTimeouts, {
    committed: 1,
    failed: 0,
    capped: 0,
    noOutcome: 1,
  });
  assert.equal(result.mcpOverflow.detachedOutcomes, 1);
  assert.equal(target.detachedOutcomes, 100000);
});

it.each(["failed", "noOutcome"] as const)(
  "keeps a never-saved first dispatch %s when only its same-id retry commits (#1559 watcher sighting)",
  (firstOutcome) => {
    const first = timeoutCall({ ts: "2026-11-13T12:59:40.000Z" });
    const retry = timeoutCall({ ts: "2026-11-13T13:00:05.000Z" });
    const retryResult = detachedResult({ startedAt: retry.ts, ts: "2026-11-13T13:00:20.000Z" });
    const events = [retryResult, retry, first];
    if (firstOutcome === "failed")
      events.push(
        detachedResult({
          startedAt: first.ts,
          ts: "2026-11-13T12:59:51.000Z",
          outcome: "failed",
          props: { cause: "unknown" },
        }),
      );
    const rows = finishDetached(events).mcpCalls;
    assert.deepEqual(rows[0]!.dispatchTimeouts, {
      committed: 0,
      failed: firstOutcome === "failed" ? 1 : 0,
      capped: 0,
      noOutcome: firstOutcome === "noOutcome" ? 1 : 0,
    });
    assert.deepEqual(rows[1]!.dispatchTimeouts, {
      committed: 1,
      failed: 0,
      capped: 0,
      noOutcome: 0,
    });
  },
);

it("keeps runtime, restart-admission and Git rate rollups within the combined day budget", () => {
  const accumulator = makeAccumulator();
  for (let minute = 0; minute < 1440; minute++) {
    accumulate(accumulator, {
      ts: `2026-11-13T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
      kind: "server.runtime_sample",
      surface: "server",
      route: "server",
      props: {
        runningTurns: { total: minute % 60, byProvider: {}, byModel: {} },
        ...(minute % 2 === 0 ? { queuedRuns: minute % 60 } : {}),
        host: { load1: (minute % 60) * 2, load5: 1, load15: 1, rssMiB: 10, heapUsedMiB: 5 },
        sampleMs: (minute % 60) / 100,
      },
    });
  }
  for (let minute = 0; minute < 1440; minute++) {
    const at = `2026-11-13T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
    accumulate(
      accumulator,
      event({
        ts: at,
        kind: "vcs.git_exec_rate",
        props: {
          total: 120,
          distinctCwds: 20,
          maxPerSecond: 10,
          windowMs: 60_000,
          overflow: 0,
          top: Array.from({ length: 20 }, (_, index) => ({
            operation: `GitManager.op${index}`,
            subcommand: "status",
            cwdHash: index.toString(16).padStart(16, "0"),
            count: 6,
          })),
        },
      }),
    );
    accumulate(
      accumulator,
      event({
        ts: at,
        kind: "restart.admission.admitted",
        bootId: "boot-one",
        restartAdmission: {
          sourceRunId: `source-${minute}`,
          classification: "continuation",
          queuedAtMs: 0,
          waitedMs: minute,
          positionAtEntry: 12,
          position: 1,
          total: 7,
          maxQueueDepth: 20,
          active: 1,
          maxActive: 4,
          loaded: true,
        },
      }),
    );
  }
  const rollup = finishRollup(accumulator, "2026-11-13", "2026-11-14T00:00:00.000Z");
  assert.equal(rollup.runtimeSamples!.length, 24);
  assert.deepEqual(rollup.runtimeSamples![0], {
    hour: "00",
    samples: 60,
    runningTurnsMax: 59,
    runningTurnsAvg: 29.5,
    queuedRunsMax: 58,
    load1Max: 118,
    sampleMsMax: 0.59,
  });
  assert.equal(rollup.total, 4320);
  assert.equal(rollup.kindCounts["vcs.git_exec_rate"], 1440);
  assert.equal(rollup.kindCounts["restart.admission.admitted"], 1440);
  assert.equal(rollup.restartAdmission!.groups.length, 24);
  assert.equal(rollup.restartAdmission!.groups[0]!.admissions, 60);
  assert.isBelow(JSON.stringify(rollup).length, 50_000);
});

it("does not turn an unavailable queue count into zero", () => {
  const accumulator = makeAccumulator();
  accumulate(accumulator, {
    ts: "2026-11-13T12:00:00.000Z",
    kind: "server.runtime_sample",
    surface: "server",
    route: "server",
    props: {
      runningTurns: { total: 0, byProvider: {}, byModel: {} },
      host: { load1: 0, load5: 0, load15: 0, rssMiB: 1, heapUsedMiB: 1 },
      sampleMs: 0.1,
    },
  });
  assert.equal(
    finishRollup(accumulator, "2026-11-13", "2026-11-14T00:00:00.000Z").runtimeSamples![0]!
      .queuedRunsMax,
    null,
  );
});

describe("restart admission rollup", () => {
  const admission = (waitedMs: number, input: Partial<AnalyticsEvent> = {}): AnalyticsEvent =>
    event({
      kind: "restart.admission.admitted",
      bootId: "boot-one",
      restartAdmission: {
        sourceRunId: "source-" + waitedMs,
        classification: "continuation",
        queuedAtMs: 0,
        waitedMs,
        positionAtEntry: 12,
        position: 1,
        total: 7,
        maxQueueDepth: 20,
        active: 1,
        maxActive: 4,
        loaded: true,
      },
      ...input,
    });
  it("reports waits, depth, active reservations and each bound rule by boot/hour", () => {
    const target = makeAccumulator();
    for (const waitedMs of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])
      accumulate(target, admission(waitedMs));
    for (const rule of ["no_progress", "no_progress", "absolute_backstop", "wall_time"] as const)
      accumulate(
        target,
        admission(1800000, {
          kind: "restart.admission.failed",
          restartAdmission: {
            ...admission(0).restartAdmission!,
            rule,
            waitedMs: 1800000,
            maxQueueDepth: 34,
            active: 2,
          },
        }),
      );
    accumulate(target, admission(50, { bootId: "boot-two" }));
    accumulate(target, admission(80, { ts: "2026-11-13T13:00:00.000Z" }));
    const result = finishRollup(target, "2026-11-13", ts).restartAdmission!;
    assert.strictEqual(result.scope, "server-wide");
    assert.strictEqual(result.loadedTimeShare, null);
    assert.strictEqual(result.groups.length, 3);
    assert.deepEqual(result.groups[0], {
      bootId: "boot-one",
      hour: "2026-11-13T12Z",
      admissions: 10,
      maxQueueDepth: 34,
      maxActiveObserved: 2,
      maxActive: 4,
      observations: 14,
      loadedObservations: 14,
      failuresByRule: { no_progress: 2, absolute_backstop: 1, wall_time: 1 },
      wait: { count: 10, p50Ms: 500, p90Ms: 900, maxMs: 1000, approximate: false },
    });
  });
  it("bounds boot/hour groups and exposes overflow", () => {
    const target = makeAccumulator();
    for (let i = 0; i < 140; i++) accumulate(target, admission(i, { bootId: "boot-" + i }));
    const result = finishRollup(target, "2026-11-13", ts).restartAdmission!;
    assert.strictEqual(result.groups.length, 128);
    assert.strictEqual(result.overflow, 12);
  });
});

it("counts a pending create receipt separately from saved and unknown without a dispatch failure", () => {
  const { errorPhase: _errorPhase, ...pendingCall } = timeoutCall({
    outcome: "ok",
    saved: "pending_create",
    fenceToReplyMs: 2000,
  });
  const rows = finishDetached([pendingCall, detachedResult()]).mcpCalls;
  assert.deepEqual(rows[0]!.savedCounts, { pending_create: 1 });
  assert.equal(rows[0]!.failures, 0);
  assert.deepEqual(rows[0]!.dispatchTimeouts, { committed: 0, failed: 0, capped: 0, noOutcome: 0 });
});
