import type { AnalyticsEvent, AnalyticsRollup, RunUsageEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type { AnalyticsRollup } from "@t3tools/contracts";

const MAX_GROUPS = 128;
const EXACT_DURATIONS = 512;
const HISTOGRAM_RATIO = 1.02;
const OTHER = "__other__";

interface Durations {
  count: number;
  max: number;
  exact: number[];
  histogram: Map<number, number> | undefined;
}

interface AnalyticsLatency {
  readonly count: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
  readonly approximate: boolean;
}

const durations = (): Durations => ({ count: 0, max: 0, exact: [], histogram: undefined });

export const makeAccumulator = () => ({
  total: 0,
  invalidLines: 0,
  kinds: new Map<string, number>(),
  errors: new Map<string, number>(),
  rpcs: new Map<string, Durations>(),
  answers: durations(),
  usage: makeUsageAccumulator(),
});

function boundedKey<T>(groups: Map<string, T>, key: string): string {
  return groups.has(key) || groups.size < MAX_GROUPS ? key : OTHER;
}

function increment(groups: Map<string, number>, key: string): void {
  const bounded = boundedKey(groups, key);
  groups.set(bounded, (groups.get(bounded) ?? 0) + 1);
}

function bucket(value: number): number {
  return value === 0
    ? -Infinity
    : Math.ceil(Math.log(Math.max(0.000001, value)) / Math.log(HISTOGRAM_RATIO));
}

function addDuration(target: Durations, value: number): void {
  target.count++;
  target.max = Math.max(target.max, value);
  if (!target.histogram && target.exact.length < EXACT_DURATIONS) {
    target.exact.push(value);
    return;
  }
  if (!target.histogram) {
    target.histogram = new Map();
    for (const existing of target.exact) {
      const key = bucket(existing);
      target.histogram.set(key, (target.histogram.get(key) ?? 0) + 1);
    }
    target.exact = [];
  }
  const key = bucket(value);
  target.histogram.set(key, (target.histogram.get(key) ?? 0) + 1);
}

export function accumulate(
  target: ReturnType<typeof makeAccumulator>,
  event: AnalyticsEvent,
): void {
  target.total++;
  if ("runId" in event) accumulateUsage(target.usage, event);
  increment(target.kinds, event.kind);
  if (event.props?.errorTag) increment(target.errors, event.props.errorTag);
  else if (/error|fail/i.test(event.kind)) increment(target.errors, event.kind);
  else if ((event.props?.status ?? 0) >= 400)
    increment(target.errors, `status.${event.props!.status}`);

  if (
    /(^|[._-])rpc([._-]|$)/i.test(event.kind) &&
    event.props?.method &&
    event.durationMs !== undefined &&
    event.props?.phase !== "stream-lifetime"
  ) {
    const key = boundedKey(target.rpcs, event.props.method);
    let summary = target.rpcs.get(key);
    if (!summary) {
      summary = durations();
      target.rpcs.set(key, summary);
    }
    addDuration(summary, event.durationMs);
  }

  if (/ask/i.test(event.kind) && /answer|respond|resolv/i.test(event.kind)) {
    const duration =
      event.durationMs ??
      (event.props?.createdAt
        ? DateTime.toEpochMillis(DateTime.makeUnsafe(event.ts)) -
          DateTime.toEpochMillis(DateTime.makeUnsafe(event.props.createdAt))
        : undefined);
    if (duration !== undefined && duration >= 0) addDuration(target.answers, duration);
  }
}

function summarize(values: Durations): AnalyticsLatency {
  const sorted = values.histogram
    ? [...values.histogram].sort(([a], [b]) => a - b)
    : values.exact.toSorted((a, b) => a - b).map((value) => [value, 1] as const);
  const percentile = (quantile: number): number | null => {
    const rank = Math.ceil(values.count * quantile);
    let seen = 0;
    for (const [key, count] of sorted) {
      seen += count;
      if (seen >= rank) {
        return values.histogram
          ? Math.min(values.max, key === -Infinity ? 0 : HISTOGRAM_RATIO ** key)
          : key;
      }
    }
    return null;
  };
  return {
    count: values.count,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: values.count === 0 ? null : values.max,
    approximate: values.histogram !== undefined,
  };
}

export function finishRollup(
  target: ReturnType<typeof makeAccumulator>,
  day: string,
  generatedAt: string,
): AnalyticsRollup {
  return {
    day,
    generatedAt,
    scope: "retained-events",
    total: target.total,
    invalidLines: target.invalidLines,
    kindCounts: Object.fromEntries(target.kinds),
    errorCounts: Object.fromEntries(target.errors),
    topSlowRpcs: [...target.rpcs]
      .map(([method, values]) => ({ method, ...summarize(values) }))
      .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0) || a.method.localeCompare(b.method))
      .slice(0, 20),
    askAnswerLatency: summarize(target.answers),
    usage: finishUsage(target.usage),
  };
}

// A damaged file without newlines must not grow the reader's pending string indefinitely.
export function boundedLines(maxLength: number) {
  let pending = "";
  let oversized = false;
  return {
    push(chunk: string): ReadonlyArray<string | null> {
      const lines: Array<string | null> = [];
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf("\n", start);
        const end = newline === -1 ? chunk.length : newline;
        if (!oversized) {
          if (pending.length + end - start > maxLength) {
            pending = "";
            oversized = true;
          } else pending += chunk.slice(start, end);
        }
        if (newline === -1) break;
        lines.push(oversized ? null : pending);
        pending = "";
        oversized = false;
        start = newline + 1;
      }
      return lines;
    },
    finish(): ReadonlyArray<string | null> {
      return oversized ? [null] : pending.length === 0 ? [] : [pending];
    },
  };
}

const usageTotals = () => ({
  runs: 0,
  inputTokens: null as number | null,
  outputTokens: null as number | null,
  cachedInputTokens: null as number | null,
  reasoningTokens: null as number | null,
  wallMs: null as number | null,
  turnCount: 0,
  completeRuns: 0,
  partialRuns: 0,
  unavailableRuns: 0,
});
type UsageTotals = ReturnType<typeof usageTotals>;
const makeUsageAccumulator = () => ({
  totals: usageTotals(),
  models: new Map<string, { providerInstance: string; model: string; totals: UsageTotals }>(),
  roles: new Map<RunUsageEvent["role"], UsageTotals>(),
  boards: new Map<string, UsageTotals>(),
  cards: new Map<
    string,
    {
      boardId: string;
      cardId: string;
      totals: UsageTotals;
      evaluatorWakes: number;
      reviewRounds: Set<number>;
    }
  >(),
  seen: new Set<string>(),
});
function addUsage(target: UsageTotals, event: RunUsageEvent): void {
  target.runs++;
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "reasoningTokens",
    "wallMs",
  ] as const) {
    if (event[key] !== null) target[key] = (target[key] ?? 0) + event[key];
  }
  target.turnCount += event.turnCount;
  target.completeRuns += Number(event.usageStatus === "complete");
  target.partialRuns += Number(event.usageStatus === "partial");
  target.unavailableRuns += Number(event.usageStatus === "unavailable");
}
function accumulateUsage(
  target: ReturnType<typeof makeUsageAccumulator>,
  event: RunUsageEvent,
): void {
  // The writer can replay an ambiguous append; a run is billed only once in the rollup.
  if (target.seen.has(event.runId)) return;
  target.seen.add(event.runId);
  addUsage(target.totals, event);
  const modelKey = JSON.stringify([event.providerInstance, event.model]);
  const model = target.models.get(modelKey) ?? {
    providerInstance: event.providerInstance,
    model: event.model,
    totals: usageTotals(),
  };
  addUsage(model.totals, event);
  target.models.set(modelKey, model);
  const role = target.roles.get(event.role) ?? usageTotals();
  addUsage(role, event);
  target.roles.set(event.role, role);
  if (event.boardId !== undefined) {
    const board = target.boards.get(event.boardId) ?? usageTotals();
    addUsage(board, event);
    target.boards.set(event.boardId, board);
    if (event.cardId !== undefined) {
      const key = JSON.stringify([event.boardId, event.cardId]);
      const card = target.cards.get(key) ?? {
        boardId: event.boardId,
        cardId: event.cardId,
        totals: usageTotals(),
        evaluatorWakes: 0,
        reviewRounds: new Set<number>(),
      };
      addUsage(card.totals, event);
      card.evaluatorWakes += Number(event.role === "evaluator" || event.role === "discussion");
      if (event.role === "review" && event.reviewRound !== null)
        card.reviewRounds.add(event.reviewRound);
      target.cards.set(key, card);
    }
  }
}
function finishUsage(target: ReturnType<typeof makeUsageAccumulator>): AnalyticsRollup["usage"] {
  const cards = [...target.cards.values()].map(({ totals, reviewRounds, ...card }) => ({
    ...card,
    ...totals,
    reviewRounds: reviewRounds.size,
  }));
  const tie = (a: (typeof cards)[number], b: (typeof cards)[number]) =>
    a.boardId.localeCompare(b.boardId) || a.cardId.localeCompare(b.cardId);
  return {
    totals: target.totals,
    perModel: [...target.models.values()].map(({ totals, ...model }) => ({ ...model, ...totals })),
    perRole: [...target.roles].map(([role, totals]) => ({ role, ...totals })),
    perBoard: [...target.boards].map(([boardId, totals]) => ({ boardId, ...totals })),
    cards,
    // Cache and reasoning are subsets of input and output, never added twice.
    topCardsByTokens: cards
      .toSorted(
        (a, b) =>
          (b.inputTokens ?? 0) +
            (b.outputTokens ?? 0) -
            ((a.inputTokens ?? 0) + (a.outputTokens ?? 0)) || tie(a, b),
      )
      .slice(0, 20),
    topCardsByWallMs: cards
      .toSorted((a, b) => (b.wallMs ?? 0) - (a.wallMs ?? 0) || tie(a, b))
      .slice(0, 20),
  };
}
