import {
  LONG_TASK_HISTOGRAM_BUCKETS,
  LONG_TASK_HISTOGRAM_RATIO,
  type AnalyticsEvent,
} from "@t3tools/contracts";

type Props = NonNullable<AnalyticsEvent["props"]>;
const SAMPLE_BURST = 20;
const SAMPLE_REFILL_MS = 15 * 60_000;
export interface LongTaskEntry {
  readonly duration: number;
  readonly startedAt: number;
  readonly attribution?:
    | ReadonlyArray<{
        readonly containerType?: string;
        readonly containerName?: string;
      }>
    | undefined;
}
export interface LongTaskView {
  readonly screen: string;
  readonly visibleCardCount?: number;
  readonly visibleThreadCount?: number;
}
interface Context extends LongTaskView {
  route: string;
  at: number;
  active: boolean;
}
interface Summary {
  count: number;
  totalMs: number;
  maxMs: number;
  wallTimeMs: number;
  histogram: Map<number, number>;
  methods: Map<string, number>;
}

export function createLongTaskTracker(options: {
  now: () => number;
  emit: (
    kind: string,
    route: string,
    durationMs: number | undefined,
    props: Props,
    at: number,
  ) => void;
}) {
  let last = options.now();
  let active = true;
  let observed = false;
  // Preserve burst attribution without retaining thousands of samples during sustained stalls.
  let sampleCreditMs = SAMPLE_BURST * SAMPLE_REFILL_MS;
  let sampleRefilledAt = last;
  let context: Context = { route: "other", screen: "other", at: last, active };
  const contexts: Context[] = [context];
  const receipts: Array<{ at: number; method: string; bytes: number }> = [];
  const actions: Array<{ at: number; kind: string }> = [];
  const windows = new Map<number, { samples: number; routes: Map<string, Summary> }>();
  const minute = (at: number) => Math.floor(at / 60_000) * 60_000;
  const window = (at: number) => {
    const start = minute(at);
    let value = windows.get(start);
    if (!value) {
      value = { samples: 0, routes: new Map() };
      windows.set(start, value);
    }
    return value;
  };
  const summary = (at: number, route: string) => {
    const routes = window(at).routes;
    let value = routes.get(route);
    if (!value) {
      value = {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        wallTimeMs: 0,
        histogram: new Map(),
        methods: new Map(),
      };
      routes.set(route, value);
    }
    return value;
  };
  const emit = (complete: boolean) => {
    for (const [start, window] of windows) {
      if (!complete && start + 60_000 > options.now()) continue;
      for (const [route, value] of window.routes) {
        if (!observed) continue;
        if (!value.count && !value.wallTimeMs) continue;
        const histogram = [...value.histogram].sort(([a], [b]) => a - b);
        let rank = Math.ceil(value.count * 0.95);
        let p95Ms = value.maxMs;
        for (const [bucket, count] of histogram) {
          rank -= count;
          if (rank <= 0) {
            p95Ms = Math.min(value.maxMs, LONG_TASK_HISTOGRAM_RATIO ** bucket);
            break;
          }
        }
        const method = [...value.methods].sort(
          ([a, x], [b, y]) => y - x || a.localeCompare(b),
        )[0]?.[0];
        options.emit(
          "performance.long-task-summary",
          route,
          undefined,
          {
            count: value.count,
            totalMs: value.totalMs,
            maxMs: value.maxMs,
            wallTimeMs: value.wallTimeMs,
            ...(value.count ? { p95Ms } : {}),
            histogram,
            ...(method ? { method } : {}),
          },
          start,
        );
      }
      window.routes.clear();
      // Keep recent sample budgets after emission so late observer delivery cannot reset the cap.
      if (start < minute(options.now()) - 128 * 60_000) windows.delete(start);
    }
  };
  const advance = (at: number) => {
    at = Math.max(last, at);
    if (active && observed) {
      let cursor = last;
      while (cursor < at) {
        const end = Math.min(at, minute(cursor) + 60_000);
        summary(cursor, context.route).wallTimeMs += end - cursor;
        cursor = end;
      }
    }
    last = at;
  };
  const remember = () => {
    context = { ...context, at: options.now(), active };
    contexts.push(context);
    if (contexts.length > 128) contexts.shift();
  };
  return {
    enable() {
      advance(options.now());
      observed = true;
    },
    context(view: LongTaskView, route: string) {
      const at = options.now();
      advance(at);
      context = { ...view, route, at, active };
      remember();
    },
    received(method: string, bytes: number) {
      if (!active || !Number.isFinite(bytes) || bytes <= 0) return;
      receipts.push({ at: options.now(), method, bytes });
      // Retain a bounded history for observers delivered after a blocked main thread.
      if (receipts.length > 8192) receipts.splice(0, 1024);
    },
    action(kind: string) {
      actions.push({ at: options.now(), kind });
      if (actions.length > 128) actions.shift();
    },
    record(entry: LongTaskEntry) {
      if (
        !Number.isFinite(entry.duration) ||
        entry.duration < 50 ||
        !Number.isFinite(entry.startedAt)
      )
        return;
      const view = contexts.findLast((item) => item.at <= entry.startedAt) ?? {
        route: "other",
        screen: "other",
        active: true,
        visibleCardCount: 0,
        visibleThreadCount: 0,
      };
      if (!view.active) return;
      observed = true;
      const recent = new Map<string, { bytes: number; count: number }>();
      for (let i = receipts.length - 1; i >= 0; i--) {
        const item = receipts[i]!;
        if (item.at > entry.startedAt) continue;
        if (item.at < entry.startedAt - 1000) break;
        const value = recent.get(item.method) ?? { bytes: 0, count: 0 };
        value.bytes += item.bytes;
        value.count++;
        recent.set(item.method, value);
      }
      const value = summary(entry.startedAt, view.route);
      value.count++;
      value.totalMs += entry.duration;
      value.maxMs = Math.max(value.maxMs, entry.duration);
      const bucket = Math.min(
        LONG_TASK_HISTOGRAM_BUCKETS - 1,
        Math.ceil(Math.log(entry.duration) / Math.log(LONG_TASK_HISTOGRAM_RATIO)),
      );
      value.histogram.set(bucket, (value.histogram.get(bucket) ?? 0) + 1);
      let subscriptionBytes = 0,
        subscriptionMessages = 0;
      for (const [method, received] of recent) {
        subscriptionBytes += received.bytes;
        subscriptionMessages += received.count;
        value.methods.set(method, (value.methods.get(method) ?? 0) + received.bytes);
      }
      const budget = window(entry.startedAt);
      if (entry.duration <= 300 || budget.samples >= 20) return;
      const sampleAt = Math.max(sampleRefilledAt, entry.startedAt);
      sampleCreditMs = Math.min(
        SAMPLE_BURST * SAMPLE_REFILL_MS,
        sampleCreditMs + sampleAt - sampleRefilledAt,
      );
      sampleRefilledAt = sampleAt;
      if (sampleCreditMs < SAMPLE_REFILL_MS) return;
      sampleCreditMs -= SAMPLE_REFILL_MS;
      budget.samples++;
      const method = [...recent].sort(
        ([a, x], [b, y]) => y.bytes - x.bytes || a.localeCompare(b),
      )[0]?.[0];
      const action = actions.findLast(
        (item) => item.at <= entry.startedAt && item.at >= entry.startedAt - 2000,
      );
      const attribution = entry.attribution?.[0];
      options.emit(
        "performance.long-task",
        view.route,
        entry.duration,
        {
          screen: view.screen,
          visibleCardCount: view.visibleCardCount ?? 0,
          visibleThreadCount: view.visibleThreadCount ?? (view.screen === "thread" ? 1 : 0),
          subscriptionBytes,
          subscriptionMessages,
          ...(method ? { method } : {}),
          ...(action ? { ownerAction: action.kind } : {}),
          ...(attribution?.containerType ? { containerType: attribution.containerType } : {}),
          ...(attribution?.containerName ? { containerName: attribution.containerName } : {}),
        },
        entry.startedAt,
      );
    },
    flush(complete = false) {
      advance(options.now());
      emit(complete);
      if (complete) {
        active = false;
        remember();
      }
    },
    foreground() {
      advance(options.now());
      if (!active) {
        active = true;
        remember();
      }
    },
    pause() {
      advance(options.now());
      active = false;
      remember();
    },
  };
}
