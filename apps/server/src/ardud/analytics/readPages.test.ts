import { describe, expect, it } from "@effect/vitest";
import {
  AnalyticsReadResult,
  type AnalyticsEvent,
  type AnalyticsReadInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { COMPACT_READ_CHARS } from "../compactRead.ts";
import { accumulate, finishRollup, makeAccumulator } from "./rollup.ts";
import { makeReadPager } from "./readPages.ts";

const day = "2026-11-14";
const event = (input: Partial<AnalyticsEvent> = {}): AnalyticsEvent => ({
  ts: `${day}T12:00:00.000Z`,
  kind: "mcp.call",
  surface: "server",
  route: "mcp",
  ...input,
});
const finish = (events: AnalyticsEvent[]) => {
  const accumulator = makeAccumulator();
  for (const row of events) accumulate(accumulator, row);
  return finishRollup(accumulator, day, `${day}T23:59:59.999Z`);
};
const decodeResult = Schema.decodeUnknownSync(AnalyticsReadResult);
const chars = (value: unknown) => JSON.stringify(value).length;
function check(result: AnalyticsReadResult) {
  expect(chars(result)).toBeLessThanOrEqual(COMPACT_READ_CHARS);
  expect(decodeResult(result)).toEqual(result);
}
// Reconstruct independently of the pager's flattening so missing and duplicate nested rows fail.
function restore(rows: NonNullable<AnalyticsReadResult["rows"]>) {
  let root: unknown;
  const paths = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify(row.path);
    expect(paths.has(key)).toBe(false);
    paths.add(key);
    if (!row.path.length) {
      root = row.value;
      continue;
    }
    root ??= typeof row.path[0] === "number" ? [] : {};
    let target = root as Record<string | number, unknown>;
    row.path.forEach((part, index) => {
      if (index === row.path.length - 1) target[part] = row.value;
      else {
        target[part] ??= typeof row.path[index + 1] === "number" ? [] : {};
        target = target[part] as typeof target;
      }
    });
  }
  return root;
}
const largeEvents: AnalyticsEvent[] = [];
for (let board = 0; board < 80; board++) {
  for (let pool = 0; pool < (board === 0 ? 120 : 20); pool++)
    largeEvents.push(
      event({
        kind: "kanban.pool_usage",
        boardId: `board-${board}`,
        props: { poolKey: `pool-${pool}`, used: 1, slots: 2, waiting: 1 },
      }),
    );
  largeEvents.push(
    event({
      boardId: `board-${board}`,
      tool: `tool-${board}-${"t".repeat(140)}`,
      build: "b".repeat(160),
      bootId: "c".repeat(512),
      durationMs: board * 100,
      outcome: "error",
      errorTag: "failure",
      errorPhase: "handler",
    }),
  );
  largeEvents.push({
    ts: `${day}T12:00:00.000Z`,
    kind: "run.usage",
    surface: "server",
    route: "run",
    runId: `run-${board}`,
    threadId: `thread-${board}`,
    role: "work",
    providerInstance: "codex",
    model: `model-${board}`,
    effort: null,
    boardId: `board-${board}`,
    cardId: `card-${board}`,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    wallMs: board * 1_000,
    turnCount: 1,
    endReason: "completed",
    usageStatus: "complete",
    reviewRound: null,
  });
}
const large = finish(largeEvents);

describe("analytics read budget", () => {
  it("pages MCP diagnostic groups with their reasons, roles and phase percentiles intact", () => {
    const rollup = finish([
      event({
        tool: "card_edit",
        cardNumber: 4336,
        callerCardNumber: 4336,
        callerRole: "work",
        callerKind: "board_thread",
        cardStage: "working",
        outcome: "refused",
        errorTag: "capability_denied",
        denyReason: "not_card_owner",
        durationMs: 10,
      }),
      event({
        tool: "card_edit",
        cardNumber: 4336,
        callerCardNumber: 4336,
        callerRole: "work",
        callerKind: "board_thread",
        cardStage: "working",
        outcome: "timeout",
        errorTag: "reply_timeout",
        replyStage: "ack",
        durationMs: 310,
        replyPhases: { admission: 10, read: 20, commit: 30, ack: 250 },
        writePhases: { lockWait: 10, read: 20, write: 30, replyWait: 250 },
      }),
      event({
        tool: "card_edit",
        cardNumber: 4336,
        callerCardNumber: 4336,
        callerRole: "review",
        callerKind: "board_thread",
        cardStage: "in_review",
        outcome: "timeout",
        errorTag: "reply_timeout",
        replyStage: "commit",
        durationMs: 555,
        replyPhases: { admission: 10, read: 20, commit: 500, ack: 25 },
        writePhases: { lockWait: 10, read: 20, write: 500, replyWait: 25 },
      }),
    ]);
    const pager = makeReadPager();
    const selection = { day, kind: "mcp.call", tool: "card_edit", cardNumber: 4336 } as const;
    const names = ["mcpFailureBreakdown", "mcpFailureContexts", "mcpReplyTimeouts"] as const;
    expect(pager.read(selection, rollup, []).sections.map(({ name }) => name)).toEqual(
      expect.arrayContaining([...names]),
    );
    expect(rollup.mcpReplyTimeouts!.some((row) => (row.replyPhases.ack?.p95Ms ?? 0) > 0)).toBe(
      true,
    );
    for (const section of names) {
      const input = { ...selection, section, limit: 1 };
      let page = pager.read(input, rollup, []);
      expect(page.hasMore).toBe(true);
      const rows = [...page.rows!];
      let pages = 1;
      check(page);
      while (page.hasMore) {
        page = pager.resume({ ...input, cursor: page.cursor! })!;
        check(page);
        rows.push(...page.rows!);
        expect(++pages).toBeLessThan(10);
      }
      expect(restore(rows)).toEqual(rollup[section]);
    }
  });

  it.each([
    { name: "unfiltered retry", from: undefined, to: undefined, allowed: true },
    { name: "added filter", from: undefined, to: 4336, allowed: false },
    { name: "same card", from: 4336, to: 4336, allowed: true },
    { name: "different card", from: 4336, to: 4339, allowed: false },
    { name: "omitted filter", from: 4336, to: undefined, allowed: false },
  ])("binds cardNumber on cursor continuation: $name", ({ from, to, allowed }) => {
    const common = { day, section: "samples", limit: 1 } as const;
    const pager = makeReadPager();
    const first = pager.read(
      { ...common, ...(from === undefined ? {} : { cardNumber: from }) },
      finish([]),
      [event(), event()],
    );
    expect(first.cursor).toBeDefined();
    const next = pager.resume({
      ...common,
      cursor: first.cursor!,
      ...(to === undefined ? {} : { cardNumber: to }),
    });
    if (allowed) {
      expect(next).toBeDefined();
      check(next!);
      expect(next!.hasMore).toBe(false);
    } else expect(next).toBeUndefined();
  });

  it("returns a bounded summary and an exact index for every top-level group", () => {
    expect(chars(large)).toBeGreaterThan(150_000);
    const result = makeReadPager().read({ day }, large, largeEvents.slice(0, 500));
    check(result);
    expect(result.truncated).toBe(true);
    expect(result.next).toContain("section");
    expect(result.sections.map((section) => section.name)).toEqual([
      ...Object.keys(large),
      "samples",
    ]);
    for (const section of result.sections)
      expect(section.chars).toBe(
        chars(section.name === "samples" ? largeEvents.slice(0, 500) : large[section.name]),
      );
    expect(result.rollup.mcpCalls[0]?.maxMs).toBe(7900);
    expect(
      makeReadPager().read({ day, limit: 1 }, large, largeEvents).samples.length,
    ).toBeLessThanOrEqual(1);
    expect(result.rollup.usage.topCardsByTokens).toEqual(
      large.usage.topCardsByTokens.slice(0, result.rollup.usage.topCardsByTokens.length),
    );
    expect(result.summary.mcpCalls).toBe(80);
    expect(result.summary.mcpFailures).toBe(80);
  });

  it("pages every section to completion with each nested row exactly once", () => {
    const pager = makeReadPager();
    const samples = largeEvents.slice(0, 500);
    for (const { name, rows: count } of pager.read({ day }, large, samples).sections) {
      const input = { day, section: name, limit: 500 };
      let page = pager.read(input, large, samples);
      const rows = [...page.rows!];
      let pages = 1;
      check(page);
      while (page.hasMore) {
        expect(page.cursor).toBeDefined();
        page = pager.resume({ ...input, cursor: page.cursor! })!;
        check(page);
        rows.push(...page.rows!);
        expect(++pages).toBeLessThan(200);
      }
      expect(page.cursor).toBeUndefined();
      expect(rows.length).toBe(count);
      expect(restore(rows)).toEqual(name === "samples" ? samples : large[name]);
    }
  });

  it("keeps even oversized count maps under budget with totals and a complete section index", () => {
    const counts = Object.fromEntries(
      Array.from({ length: 128 }, (_, n) => [`kind-${n}-${"k".repeat(145)}`, n]),
    );
    const rollup = {
      ...finish([]),
      total: 123,
      kindCounts: counts,
      errorCounts: counts,
      boards: [{ ...large.boards[0]!, verdictCounts: counts, failureCounts: counts }],
    };
    const result = makeReadPager().read({ day }, rollup, []);
    check(result);
    expect(result.summary.events).toBe(123);
    expect(result.truncated).toBe(true);
    expect(result.sections.find((section) => section.name === "kindCounts")?.chars).toBe(
      chars(counts),
    );
  });

  it("keeps small days and requested samples whole", () => {
    const samples = [event()];
    const rollup = finish(samples);
    const result = makeReadPager().read({ day }, rollup, samples);
    check(result);
    expect(result.rollup).toEqual(rollup);
    expect(result.samples).toEqual(samples);
    expect(result.cursor).toBeUndefined();
    expect(result.truncated).toBeUndefined();
  });

  it("budgets samples, retains immutable cursors and supports page retries and changed limits", () => {
    const pager = makeReadPager();
    const samples = Array.from({ length: 500 }, (_, n) =>
      event({ cardId: `card-${n}`, threadId: "x".repeat(7_000) }),
    );
    const input: AnalyticsReadInput = {
      day,
      kind: "mcp.call",
      tool: "analytics_read",
      boardId: "board-crpko",
      section: "samples",
      limit: 500,
    };
    const first = pager.read(input, finish([]), samples);
    check(first);
    expect(first.rows!.length).toBeLessThan(500);
    expect(first.hasMore).toBe(true);
    const original = structuredClone(samples);
    samples[20] = event({ cardId: "changed" });
    samples.push(event({ cardId: "appended" }));
    const nextInput = { ...input, cursor: first.cursor!, limit: 2 };
    const second = pager.resume(nextInput)!;
    check(second);
    expect(pager.resume(nextInput)).toEqual(second);
    expect(pager.resume({ ...nextInput, tool: "other" })).toBeUndefined();
    expect(pager.resume({ ...nextInput, section: "mcpCalls" })).toBeUndefined();
    const all = [...first.rows!, ...second.rows!];
    let page = second;
    while (page.hasMore) {
      page = pager.resume({ ...input, cursor: page.cursor! })!;
      check(page);
      all.push(...page.rows!);
    }
    expect(restore(all)).toEqual(original);
  });

  it("rejects expired, malformed and mismatched cursors without silently starting a different view", () => {
    const pager = makeReadPager();
    const input: AnalyticsReadInput = {
      day,
      kind: "mcp.call",
      boardId: "a",
      cardId: "one",
      tool: "card_get",
      outcome: "error",
      responseDelivery: "closed",
      section: "samples",
      limit: 1,
    };
    const first = pager.read(input, finish([]), [event(), event()]);
    for (const changed of [
      { day: "2026-11-13" },
      { kind: "client.click" },
      { boardId: "b" },
      { cardId: "two" },
      { tool: "other" },
      { outcome: "ok" as const },
      { responseDelivery: "finished" as const },
      { section: "boards" as const },
    ])
      expect(pager.resume({ ...input, cursor: first.cursor!, ...changed })).toBeUndefined();
    for (const cursor of [
      "",
      "bad",
      first.cursor!.replace(":1", ":-1"),
      first.cursor!.replace(":1", ":1.1"),
      first.cursor!.replace(":1", ":9999999999999999"),
    ])
      expect(pager.resume({ ...input, cursor })).toBeUndefined();
    for (let n = 0; n < 16; n++) pager.read(input, finish([]), [event(), event()]);
    expect(pager.resume({ ...input, cursor: first.cursor! })).toBeUndefined();
  });

  it("trims an oversized single row and declares the loss, with subsequent rows still reachable", () => {
    const pager = makeReadPager();
    const samples = [event({ threadId: "x".repeat(100_000) }), event({ cardId: "next" })];
    const first = pager.read({ day, section: "samples", limit: 1 }, finish([]), samples);
    check(first);
    expect(first.rows![0]!.truncated).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.next).toContain("trimmed");
    const last = pager.resume({ day, section: "samples", cursor: first.cursor! })!;
    check(last);
    expect(last.rows![0]!.value).toEqual(samples[1]);
    expect(last.hasMore).toBe(false);
  });
});
