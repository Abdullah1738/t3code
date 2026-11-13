import type { AnalyticsEvent, AnalyticsRollup as ContractRollup } from "@t3tools/contracts";
import { LONG_TASK_HISTOGRAM_RATIO } from "@t3tools/contracts";
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
  longTasks: new Map<
    string,
    {
      route: string;
      surface: AnalyticsEvent["surface"];
      count: number;
      totalMs: number;
      maxMs: number;
      wallTimeMs: number;
      histogram: Map<number, number>;
    }
  >(),
  answers: durations(),
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

export function accumulate(
  target: ReturnType<typeof makeAccumulator>,
  event: AnalyticsEvent,
): void {
  target.total++;
  increment(target.kinds, event.kind);
  if (event.props?.errorTag) increment(target.errors, event.props.errorTag);
  else if (event.errorTag) increment(target.errors, event.errorTag);
  else if (/error|fail/i.test(event.kind)) increment(target.errors, event.kind);
  else if ((event.props?.status ?? 0) >= 400)
    increment(target.errors, `status.${event.props!.status}`);

  if (event.kind === "performance.long-task-summary") {
    const props = event.props;
    const count = props?.count;
    const histogram = props?.histogram;
    // Individual samples overlap summaries. Only merge complete distributions, never percentiles.
    if (
      props &&
      count !== undefined &&
      Number.isInteger(count) &&
      histogram &&
      histogram.reduce((sum, [, n]) => sum + n, 0) === count &&
      props.totalMs !== undefined &&
      props.maxMs !== undefined &&
      props.wallTimeMs !== undefined
    ) {
      const key = boundedKey(target.longTasks, JSON.stringify([event.surface, event.route]));
      const group = target.longTasks.get(key) ?? {
        route: key === OTHER ? OTHER : event.route,
        surface: event.surface,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        wallTimeMs: 0,
        histogram: new Map<number, number>(),
      };
      group.count += count;
      group.totalMs += props.totalMs;
      group.maxMs = Math.max(group.maxMs, props.maxMs);
      group.wallTimeMs += props.wallTimeMs;
      for (const [bucket, n] of histogram)
        group.histogram.set(bucket, (group.histogram.get(bucket) ?? 0) + n);
      target.longTasks.set(key, group);
    }
  }

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
    longTasksByRoute: [...target.longTasks.values()]
      .map((group) => {
        let rank = Math.ceil(group.count * 0.95);
        let p95Ms: number | null = null;
        for (const [bucket, count] of [...group.histogram].sort(([a], [b]) => a - b)) {
          rank -= count;
          if (rank <= 0) {
            p95Ms = Math.min(group.maxMs, LONG_TASK_HISTOGRAM_RATIO ** bucket);
            break;
          }
        }
        return {
          route: group.route,
          surface: group.surface,
          count: group.count,
          totalMs: group.totalMs,
          maxMs: group.maxMs,
          p95Ms,
          wallTimeMs: group.wallTimeMs,
          wallTimeShare: group.wallTimeMs > 0 ? group.totalMs / group.wallTimeMs : null,
          approximate: group.count > 0,
        };
      })
      .sort(
        (a, b) =>
          b.totalMs - a.totalMs ||
          a.route.localeCompare(b.route) ||
          a.surface.localeCompare(b.surface),
      ),
    topSlowRpcs: [...target.rpcs]
      .map(([method, values]) => ({ method, ...summarize(values) }))
      .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0) || a.method.localeCompare(b.method))
      .slice(0, 20),
    askAnswerLatency: summarize(target.answers),
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
