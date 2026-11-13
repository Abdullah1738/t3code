import type { AnalyticsEvent, AnalyticsRollup as ContractRollup } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

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

export type AnalyticsRollup = ContractRollup;

interface McpGroup {
  tool: string;
  hour: string;
  build: string;
  durations: Durations;
  failures: number;
  outcomes: Map<string, number>;
  savedCounts: Map<string, number>;
  errors: Map<
    string,
    { errorTag: string; errorPhase: NonNullable<AnalyticsEvent["errorPhase"]>; count: number }
  >;
}
interface RetryAttempt {
  ts: string;
  group: string;
  ok: boolean;
}

const durations = (): Durations => ({ count: 0, max: 0, exact: [], histogram: undefined });

export const makeAccumulator = () => ({
  total: 0,
  invalidLines: 0,
  kinds: new Map<string, number>(),
  errors: new Map<string, number>(),
  rpcs: new Map<string, Durations>(),
  answers: durations(),
  boards: new Map<string, BoardGroup>(),
  mcp: new Map<string, McpGroup>(),
  retries: new Map<string, RetryAttempt[]>(),
  retryAttempts: 0,
  mcpOverflow: { groups: 0, retryAttempts: 0 },
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

interface AskObservation {
  ts: string;
  closed: boolean;
  rank: number;
  cardId: string;
  key: string;
  kind: string;
  blocking: boolean;
  createdAt: string;
}
interface BoardGroup {
  moves: Map<string, { from: string; to: string; count: number }>;
  stages: Map<string, Durations>;
  reviews: Map<string, { rounds: number; verdicts: number }>;
  verdicts: Map<string, number>;
  reviewDuration: Durations;
  stalls: Map<string, { sets: number; clears: number; durations: Durations }>;
  failures: Map<string, number>;
  restarts: number;
  asks: Map<string, AskObservation>;
  snapshotRows: number;
  snapshots: Map<string, { expected: number | undefined; asks: Map<string, AskObservation> }>;
  pools: Map<
    string,
    { hour: string; poolKey: string; samples: number; used: number; slots: number; waiting: number }
  >;
  overflow: number;
}
const BOARD_LIMIT = 20_000;
function boardAccumulate(target: ReturnType<typeof makeAccumulator>, event: AnalyticsEvent) {
  if (!event.boardId || !(event.kind.startsWith("kanban.") || event.kind === "ask.answered"))
    return;
  let board = target.boards.get(event.boardId);
  if (!board) {
    if (target.boards.size >= MAX_GROUPS) return;
    board = {
      moves: new Map(),
      stages: new Map(),
      reviews: new Map(),
      verdicts: new Map(),
      reviewDuration: durations(),
      stalls: new Map(),
      failures: new Map(),
      restarts: 0,
      asks: new Map(),
      snapshotRows: 0,
      snapshots: new Map(),
      pools: new Map(),
      overflow: 0,
    };
    target.boards.set(event.boardId, board);
  }
  const p = event.props;
  if (!p) return;
  if (event.kind === "kanban.card_move" && p.from && p.to) {
    const key = boundedKey(board.moves, JSON.stringify([p.from, p.to]));
    const move = board.moves.get(key) ?? {
      from: key === OTHER ? OTHER : p.from,
      to: key === OTHER ? OTHER : p.to,
      count: 0,
    };
    move.count++;
    board.moves.set(key, move);
    if (p.msInPrevStage !== undefined) {
      const stage = boundedKey(board.stages, p.from);
      const values = board.stages.get(stage) ?? durations();
      addDuration(values, p.msInPrevStage);
      board.stages.set(stage, values);
    }
  }
  if (event.kind === "kanban.review_verdict") {
    if (p.verdict) increment(board.verdicts, p.verdict);
    if (event.durationMs !== undefined) addDuration(board.reviewDuration, event.durationMs);
    if (event.cardId) {
      if (!board.reviews.has(event.cardId) && board.reviews.size >= BOARD_LIMIT) board.overflow++;
      else {
        const review = board.reviews.get(event.cardId) ?? { rounds: 0, verdicts: 0 };
        review.rounds = Math.max(review.rounds, p.round ?? 0);
        review.verdicts++;
        board.reviews.set(event.cardId, review);
      }
    }
  }
  if (event.kind === "kanban.stall" && p.reasonClass) {
    const key = boundedKey(board.stalls, p.reasonClass);
    const stall = board.stalls.get(key) ?? { sets: 0, clears: 0, durations: durations() };
    if (p.action === "set") stall.sets++;
    if (p.action === "clear") {
      stall.clears++;
      if (p.ageMs !== undefined) addDuration(stall.durations, p.ageMs);
    }
    board.stalls.set(key, stall);
  }
  if (event.kind === "kanban.worker_failed") increment(board.failures, p.errorClass ?? "other");
  if (event.kind === "kanban.worker_restarted") board.restarts++;
  if (event.kind === "kanban.ask_snapshot" || event.kind === "kanban.ask_pending") {
    let snapshot = board.snapshots.get(event.ts);
    if (!snapshot && board.snapshots.size >= MAX_GROUPS) {
      board.overflow++;
      return;
    }
    if (!snapshot) {
      snapshot = { expected: undefined, asks: new Map() };
      board.snapshots.set(event.ts, snapshot);
    }
    if (event.kind === "kanban.ask_snapshot") snapshot.expected = p.count;
    if (event.kind === "kanban.ask_pending" && event.cardId && p.key && p.createdAt) {
      const key = JSON.stringify([event.cardId, p.key]);
      if (!snapshot.asks.has(key) && board.snapshotRows >= BOARD_LIMIT) board.overflow++;
      else {
        if (!snapshot.asks.has(key)) board.snapshotRows++;
        snapshot.asks.set(key, {
          ts: event.ts,
          rank: 1,
          closed: false,
          cardId: event.cardId,
          key: p.key,
          kind: p.kind ?? "question",
          blocking: p.blocking ?? false,
          createdAt: p.createdAt,
        });
      }
    }
  }
  if (
    ["kanban.ask_opened", "kanban.ask_updated", "kanban.ask_closed", "ask.answered"].includes(
      event.kind,
    ) &&
    event.cardId &&
    p.key &&
    p.createdAt
  ) {
    const key = JSON.stringify([event.cardId, p.key]);
    const old = board.asks.get(key);
    const closed = event.kind === "kanban.ask_closed" || event.kind === "ask.answered";
    const rank = closed ? 3 : event.kind === "kanban.ask_updated" ? 2 : 0;
    if (!old && board.asks.size >= BOARD_LIMIT) board.overflow++;
    else if (!old || event.ts > old.ts || (event.ts === old.ts && rank >= old.rank))
      board.asks.set(key, {
        ts: event.ts,
        rank,
        closed,
        cardId: event.cardId,
        key: p.key,
        kind: p.kind ?? "question",
        blocking: p.blocking ?? false,
        createdAt: p.createdAt,
      });
  }
  if (
    event.kind === "kanban.pool_usage" &&
    p.poolKey &&
    p.used !== undefined &&
    p.slots !== undefined
  ) {
    const hour = `${event.ts.slice(0, 13)}:00:00.000Z`;
    const key = JSON.stringify([hour, p.poolKey]);
    if (!board.pools.has(key) && board.pools.size >= BOARD_LIMIT) {
      board.overflow++;
      return;
    }
    const pool = board.pools.get(key) ?? {
      hour,
      poolKey: p.poolKey,
      samples: 0,
      used: 0,
      slots: 0,
      waiting: 0,
    };
    pool.samples++;
    pool.used += p.used;
    pool.slots += p.slots;
    pool.waiting += p.waiting ?? 0;
    board.pools.set(key, pool);
  }
}

export function accumulate(
  target: ReturnType<typeof makeAccumulator>,
  event: AnalyticsEvent,
): void {
  boardAccumulate(target, event);
  target.total++;
  increment(target.kinds, event.kind);
  if (event.props?.errorTag) increment(target.errors, event.props.errorTag);
  else if (event.errorTag) increment(target.errors, event.errorTag);
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

  if (event.kind === "mcp.call" && event.tool && event.outcome) {
    const hour = `${event.ts.slice(0, 13)}:00:00.000Z`;
    const build = event.build ?? "unknown";
    const key = JSON.stringify([event.tool, hour, build]);
    let group = target.mcp.get(key);
    if (!group) {
      // Bound both high-cardinality build groups and retry identities on damaged/untrusted logs.
      if (target.mcp.size >= 16_384) {
        target.mcpOverflow.groups++;
        return;
      }
      group = {
        tool: event.tool,
        hour,
        build,
        durations: durations(),
        failures: 0,
        outcomes: new Map(),
        savedCounts: new Map(),
        errors: new Map(),
      };
      target.mcp.set(key, group);
    }
    addDuration(group.durations, event.durationMs ?? 0);
    increment(group.outcomes, event.outcome);
    increment(group.savedCounts, String(event.saved ?? "unknown"));
    if (event.outcome !== "ok") {
      group.failures++;
      const errorTag = event.errorTag ?? "unknown";
      const errorPhase = event.errorPhase ?? "handler";
      const errorKey = boundedKey(group.errors, JSON.stringify([errorTag, errorPhase]));
      const entry = group.errors.get(errorKey) ?? {
        errorTag: errorKey === OTHER ? OTHER : errorTag,
        errorPhase,
        count: 0,
      };
      entry.count++;
      group.errors.set(errorKey, entry);
    }
    if (event.clientRequestId) {
      if (target.retryAttempts >= 100_000) target.mcpOverflow.retryAttempts++;
      else {
        const identity = JSON.stringify([
          event.tool,
          event.callerThreadId ?? "",
          event.clientRequestId,
        ]);
        const attempts = target.retries.get(identity) ?? [];
        attempts.push({ ts: event.ts, group: key, ok: event.outcome === "ok" });
        target.retries.set(identity, attempts);
        target.retryAttempts++;
      }
    }
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

function finishBoardAsks(board: BoardGroup, day: string, generatedAt: string) {
  const ordered = [...board.snapshots].sort(([a], [b]) => b.localeCompare(a));
  const complete = ordered.find(
    ([, snapshot]) => snapshot.expected !== undefined && snapshot.expected === snapshot.asks.size,
  );
  const asOf = complete?.[0] ?? null;
  const asks = new Map(complete?.[1].asks ?? []);
  for (const [key, observation] of board.asks) {
    const prior = asks.get(key);
    if (
      (asOf === null || observation.ts >= asOf) &&
      (!prior ||
        observation.ts > prior.ts ||
        (observation.ts === prior.ts && observation.rank >= prior.rank))
    )
      asks.set(key, observation);
  }
  const at = Date.parse(day < generatedAt.slice(0, 10) ? `${day}T23:59:59.999Z` : generatedAt);
  return {
    openAsks: [...asks.values()]
      .filter((ask) => !ask.closed)
      .map(({ ts: _ts, rank: _rank, closed: _closed, ...ask }) => ({
        ...ask,
        ageMs: Math.max(0, at - Date.parse(ask.createdAt)),
      })),
    openAsksAsOf: asOf,
    incompleteAskSnapshots: ordered.filter(
      ([, snapshot]) => snapshot.expected === undefined || snapshot.expected !== snapshot.asks.size,
    ).length,
  };
}

export function finishRollup(
  target: ReturnType<typeof makeAccumulator>,
  day: string,
  generatedAt: string,
): AnalyticsRollup {
  const retries = new Map<string, { failedThenRetried: number; retrySucceeded: number }>();
  for (const attempts of target.retries.values()) {
    // Detached emission and overlapping calls can arrive out of order, including across segments.
    const ordered = attempts.toSorted((a, b) => a.ts.localeCompare(b.ts));
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1]!;
      if (previous.ok) continue;
      const count = retries.get(previous.group) ?? { failedThenRetried: 0, retrySucceeded: 0 };
      count.failedThenRetried++;
      if (ordered[index]!.ok) count.retrySucceeded++;
      retries.set(previous.group, count);
    }
  }
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
    boards: [...target.boards].map(([boardId, board]) => ({
      boardId,
      moves: [...board.moves.values()],
      timeInStage: [...board.stages].map(([stage, values]) => ({ stage, ...summarize(values) })),
      reviewRounds: [...board.reviews].map(([cardId, value]) => ({ cardId, ...value })),
      verdictCounts: Object.fromEntries(board.verdicts),
      reviewDuration: summarize(board.reviewDuration),
      stalls: [...board.stalls].map(([reasonClass, value]) => ({
        reasonClass,
        sets: value.sets,
        clears: value.clears,
        ...summarize(value.durations),
      })),
      failureCounts: Object.fromEntries(board.failures),
      restarts: board.restarts,
      ...finishBoardAsks(board, day, generatedAt),
      poolUtilisation: [...board.pools.values()].map((pool) => ({
        ...pool,
        used: pool.used / pool.samples,
        slots: pool.slots / pool.samples,
        waiting: pool.waiting / pool.samples,
        utilisation: pool.slots === 0 ? null : pool.used / pool.slots,
      })),
      overflow: board.overflow,
    })),
    mcpCalls: [...target.mcp]
      .map(([key, group]) => ({
        tool: group.tool,
        hour: group.hour,
        build: group.build,
        ...summarize(group.durations),
        failures: group.failures,
        failureRate: group.failures / group.durations.count,
        outcomes: Object.fromEntries(group.outcomes),
        savedCounts: Object.fromEntries(group.savedCounts),
        errors: [...group.errors.values()],
        ...(retries.get(key) ?? { failedThenRetried: 0, retrySucceeded: 0 }),
      }))
      .sort(
        (a, b) =>
          a.hour.localeCompare(b.hour) ||
          a.tool.localeCompare(b.tool) ||
          a.build.localeCompare(b.build),
      ),
    mcpOverflow: { ...target.mcpOverflow },
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
