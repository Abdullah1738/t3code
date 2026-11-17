import type {
  AnalyticsEvent,
  AnalyticsRollup,
  KanbanPoolChange,
  RunUsageEvent,
} from "@t3tools/contracts";
import { LONG_TASK_HISTOGRAM_RATIO } from "@t3tools/contracts";
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

interface McpGroup {
  tool: string;
  hour: string;
  build: string;
  bootId: string;
  durations: Durations;
  preHandler: Durations;
  failures: number;
  dispatchTimeouts: number;
  outcomes: Map<string, number>;
  savedCounts: Map<string, number>;
  reasonClasses: Map<string, number>;
  invalidFields: Map<string, number>;
  notFoundReasons: Map<string, number>;
  foundByCounts: Map<string, number>;
  idShapeCounts: Map<string, number>;
  errors: Map<
    string,
    { errorTag: string; errorPhase: NonNullable<AnalyticsEvent["errorPhase"]>; count: number }
  >;
}
interface RetryAttempt {
  ts: string;
  group: string;
  ok: boolean;
  detachedKey?: string;
}

interface DetachedResult {
  ts: string;
  outcome: "committed" | "failed" | "capped";
  afterCap: boolean;
}

function detachedKey(event: AnalyticsEvent, startedAt: string) {
  return JSON.stringify([
    event.tool,
    event.clientRequestId,
    event.ts.slice(0, 10),
    startedAt,
    event.bootId ?? "unknown",
  ]);
}

interface Breakdown {
  labels: Record<string, string | number | null>;
  durations: Durations;
  count: number;
  totalWaitMs: number;
  byReason: Map<string, number>;
  byRole: Map<string, number>;
  byCallerReaderLane: Map<string, number>;
  replyPhases: Map<string, Durations>;
  writePhases: Map<string, Durations>;
  contexts: Map<
    string,
    {
      errorTag: string;
      denyReason: string;
      callerRole: string;
      cardStage: string;
      count: number;
      durations: Durations;
      replyPhases: Map<string, Durations>;
      writePhases: Map<string, Durations>;
    }
  >;
}

// Fixed cardinality, including overflow. Keep all overflowing measurements, not just their count.
function breakdown(
  groups: Map<string, Breakdown>,
  labels: Breakdown["labels"],
  event: AnalyticsEvent,
  phases = false,
) {
  const identity = JSON.stringify(labels);
  let key = identity;
  if (!groups.has(identity) && groups.size >= 25) {
    if (!groups.has(OTHER)) {
      const last = [...groups.keys()].at(-1)!;
      const overflow = groups.get(last)!;
      groups.delete(last);
      overflow.labels = Object.fromEntries(
        Object.entries(overflow.labels).map(([k, v]) => [
          k,
          typeof v === "number" || v === null ? null : "other",
        ]),
      );
      groups.set(OTHER, overflow);
    }
    key = OTHER;
  }
  let group = groups.get(key);
  if (!group) {
    group = {
      labels:
        key === OTHER
          ? Object.fromEntries(
              Object.entries(labels).map(([k, v]) => [
                k,
                typeof v === "number" || v === null ? null : "other",
              ]),
            )
          : labels,
      durations: durations(),
      count: 0,
      totalWaitMs: 0,
      byReason: new Map(),
      byRole: new Map(),
      byCallerReaderLane: new Map(),
      replyPhases: new Map(),
      writePhases: new Map(),
      contexts: new Map(),
    };
    groups.set(key, group);
  }
  if (event.kind === "mcp.call") {
    const reason = event.denyReason ?? "unknown";
    const role = event.callerRole ?? "none";
    group.byReason.set(reason, (group.byReason.get(reason) ?? 0) + 1);
    group.byRole.set(role, (group.byRole.get(role) ?? 0) + 1);
    const callerLane = event.callerReaderLane ?? event.readerLane ?? "unknown";
    group.byCallerReaderLane.set(callerLane, (group.byCallerReaderLane.get(callerLane) ?? 0) + 1);
    const cardStage = event.cardStage ?? "unknown";
    const errorTag = event.errorTag ?? event.props?.code ?? "unknown";
    const identity = JSON.stringify([errorTag, reason, role, cardStage]);
    const key = group.contexts.has(identity) || group.contexts.size < MAX_GROUPS ? identity : OTHER;
    let context = group.contexts.get(key);
    if (!context) {
      context = {
        errorTag: key === OTHER ? "other" : errorTag,
        denyReason: key === OTHER ? "other" : reason,
        callerRole: key === OTHER ? "other" : role,
        cardStage: key === OTHER ? "other" : cardStage,
        count: 0,
        durations: durations(),
        replyPhases: new Map(),
        writePhases: new Map(),
      };
      group.contexts.set(key, context);
    }
    context.count++;
    if (event.durationMs !== undefined) addDuration(context.durations, event.durationMs);
    if (phases && (event.errorTag === "reply_timeout" || event.props?.code === "reply_timeout")) {
      for (const [phase, ms] of Object.entries(event.writePhases ?? {})) {
        for (const phases of [group.writePhases, context.writePhases]) {
          let times = phases.get(phase);
          if (!times) phases.set(phase, (times = durations()));
          addDuration(times, ms);
        }
      }
    }

    if (phases && (event.errorTag === "reply_timeout" || event.props?.code === "reply_timeout")) {
      for (const [phase, ms] of Object.entries(event.replyPhases ?? {})) {
        if (ms === undefined) continue;
        for (const phases of [group.replyPhases, context.replyPhases]) {
          let values = phases.get(phase);
          if (!values) phases.set(phase, (values = durations()));
          addDuration(values, ms);
        }
      }
    }
  }
  group.count++;
  if (event.durationMs !== undefined) addDuration(group.durations, event.durationMs);
  group.totalWaitMs += event.props?.waitMs ?? 0;
}

function finishBreakdown(groups: Map<string, Breakdown>) {
  return [...groups.values()]
    .map((group) => ({
      labels: group.labels,
      byReason: Object.fromEntries(group.byReason),
      byRole: Object.fromEntries(group.byRole),
      byCallerReaderLane: Object.fromEntries(group.byCallerReaderLane),
      replyPhases: Object.fromEntries(
        [...group.replyPhases].map(([phase, times]) => [phase, summarize(times)]),
      ),
      writePhases: Object.fromEntries(
        [...group.writePhases].map(([phase, times]) => [phase, summarize(times)]),
      ),
      contexts: [...group.contexts.values()].map((context) => ({
        errorTag: context.errorTag,
        denyReason: context.denyReason,
        callerRole: context.callerRole,
        cardStage: context.cardStage,
        ...summarize(context.durations),
        count: context.count,
        replyPhases: Object.fromEntries(
          [...context.replyPhases].map(([phase, times]) => [phase, summarize(times)]),
        ),
        writePhases: Object.fromEntries(
          [...context.writePhases].map(([phase, times]) => [phase, summarize(times)]),
        ),
      })),
      ...summarize(group.durations),
      count: group.count,
      totalWaitMs: group.totalWaitMs,
    }))
    .sort((a, b) => b.count - a.count);
}

export const durations = (): Durations => ({ count: 0, max: 0, exact: [], histogram: undefined });

export const makeAccumulator = () => ({
  runtimeSamples: new Map<
    string,
    {
      hour: string;
      samples: number;
      runningTurnsMax: number;
      runningTurnsSum: number;
      queuedRunsMax: number | null;
      load1Max: number;
      sampleMsMax: number;
    }
  >(),
  total: 0,
  invalidLines: 0,
  restartAdmissionOverflow: 0,
  restartAdmission: new Map<
    string,
    {
      bootId: string;
      hour: string;
      maxQueueDepth: number;
      admissions: number;
      failuresByRule: Record<string, number>;
      maxActiveObserved: number;
      maxActive: number;
      loadedObservations: number;
      observations: number;
      waits: Durations;
    }
  >(),
  kinds: new Map<string, number>(),
  textGenerationOverflow: 0,
  textGeneration: new Map<
    string,
    {
      labels: {
        hour: string;
        provider: string;
        operation: string;
        boardId: string | null;
        kind: "operation" | "child";
        outcome: NonNullable<AnalyticsRollup["textGeneration"]>[number]["outcome"];
      };
      durations: Durations;
    }
  >(),
  errors: new Map<string, number>(),
  routes: new Map<string, Breakdown>(),
  controlRoutes: new Map<
    string,
    {
      route: string;
      method: string;
      hour: string;
      durations: Durations;
      statuses: Map<string, number>;
      totalWaitMs: number;
      deadlineExceeded: number;
    }
  >(),
  mcpCodes: new Map<string, Breakdown>(),
  mcpReplyTimeouts: new Map<string, Breakdown>(),
  dbSpans: new Map<string, Breakdown>(),
  dbStatements: new Map<
    string,
    {
      database: string;
      connection: string;
      lane: string;
      fingerprint: string;
      family: string;
      calls: number;
      totalMs: number;
      maxMs: number;
      returnedRows: number;
      failures: number;
    }
  >(),
  processDiskRead: { readBytes: 0, sampleMs: 0, samples: 0, unavailableSamples: 0 },
  rpcs: new Map<string, Durations & { totalWaitMs: number; outcomes: Map<string, number> }>(),
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
  usage: makeUsageAccumulator(),
  boards: new Map<string, BoardGroup>(),
  tickPhases: new Map<string, { boardId: string; phase: string; durations: Durations }>(),
  evaluatorOutcomes: new Map<
    string,
    {
      boardId: string;
      trigger: string;
      purposeKind: string;
      outcome: string;
      reuseMissReason: string | null;
      count: number;
    }
  >(),
  evaluatorStartsByTrigger: new Map<string, { boardId: string; trigger: string; count: number }>(),
  claudeApiErrors: new Map<
    string,
    { status: number | null; model: string; host: string; attempts: number; giveUps: number }
  >(),
  mcp: new Map<string, McpGroup>(),
  retries: new Map<string, RetryAttempt[]>(),
  retryAttempts: 0,
  detached: new Map<string, DetachedResult[]>(),
  detachedOutcomes: 0,
  mcpOverflow: { groups: 0, retryAttempts: 0, detachedOutcomes: 0 },
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

export function addDuration(target: Durations, value: number): void {
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
  poolChanges: KanbanPoolChange[];
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
      poolChanges: [],
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
  if (event.kind === "kanban.assignment_wake_failed") increment(board.failures, "assignment_wake");
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
    event.kind === "kanban.pool_change" &&
    p.poolKey &&
    p.op &&
    p.actorKind &&
    p.fromSlots !== undefined &&
    p.toSlots !== undefined &&
    p.actorId !== undefined
  ) {
    if (board.poolChanges.length >= BOARD_LIMIT) board.overflow++;
    else
      board.poolChanges.push({
        at: event.ts,
        poolKey: p.poolKey,
        ...(p.fromPoolKey === undefined ? {} : { fromPoolKey: p.fromPoolKey }),
        fromSlots: p.fromSlots,
        toSlots: p.toSlots,
        op: p.op,
        actorKind: p.actorKind,
        actorId: p.actorId,
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
  correlationOnly = false,
): void {
  if (
    event.kind === "mcp.detached" &&
    event.tool &&
    event.clientRequestId &&
    event.startedAt &&
    (event.outcome === "committed" || event.outcome === "failed" || event.outcome === "capped")
  ) {
    if (target.detachedOutcomes >= 100_000) target.mcpOverflow.detachedOutcomes++;
    else {
      const key = detachedKey(event, event.startedAt);
      const results = target.detached.get(key) ?? [];
      results.push({ ts: event.ts, outcome: event.outcome, afterCap: event.afterCap === true });
      target.detached.set(key, results);
      target.detachedOutcomes++;
    }
  }
  // Related follow-ups inform a filtered call view without becoming selected events or samples.
  if (correlationOnly) return;
  if (event.kind === "provider.claude_api_error" && event.claudeApiError !== undefined) {
    const { status, model, host } = event.claudeApiError;
    const identity = JSON.stringify([status, model, host]);
    const key = boundedKey(target.claudeApiErrors, identity);
    const group = target.claudeApiErrors.get(key) ?? {
      ...(key === OTHER ? { status: null, model: OTHER, host: OTHER } : { status, model, host }),
      attempts: 0,
      giveUps: 0,
    };
    if (event.phase === "attempt") group.attempts++;
    if (event.phase === "give_up") group.giveUps++;
    target.claudeApiErrors.set(key, group);
  }
  if (
    event.kind === "server.runtime_sample" &&
    event.props?.runningTurns &&
    event.props.host &&
    event.props.sampleMs !== undefined
  ) {
    const hour = event.ts.slice(11, 13);
    const row = target.runtimeSamples.get(hour) ?? {
      hour,
      samples: 0,
      runningTurnsMax: 0,
      runningTurnsSum: 0,
      queuedRunsMax: null,
      load1Max: 0,
      sampleMsMax: 0,
    };
    row.samples++;
    row.runningTurnsMax = Math.max(row.runningTurnsMax, event.props.runningTurns.total);
    row.runningTurnsSum += event.props.runningTurns.total;
    if (event.props.queuedRuns !== undefined)
      row.queuedRunsMax = Math.max(row.queuedRunsMax ?? 0, event.props.queuedRuns);
    row.load1Max = Math.max(row.load1Max, event.props.host.load1);
    row.sampleMsMax = Math.max(row.sampleMsMax, event.props.sampleMs);
    target.runtimeSamples.set(hour, row);
  }
  const admission = event.restartAdmission;
  if (
    admission &&
    (event.kind === "restart.admission.admitted" || event.kind === "restart.admission.failed")
  ) {
    const bootId = event.bootId ?? "unknown";
    const hour = event.ts.slice(0, 13) + "Z";
    const key = JSON.stringify([bootId, hour]);
    let group = target.restartAdmission.get(key);
    if (!group && target.restartAdmission.size >= MAX_GROUPS) target.restartAdmissionOverflow++;
    else {
      if (!group) {
        group = {
          bootId,
          hour,
          maxQueueDepth: 0,
          admissions: 0,
          failuresByRule: {},
          maxActiveObserved: 0,
          maxActive: 0,
          loadedObservations: 0,
          observations: 0,
          waits: durations(),
        };
        target.restartAdmission.set(key, group);
      }
      group.observations++;
      group.loadedObservations += Number(admission.loaded);
      group.maxQueueDepth = Math.max(group.maxQueueDepth, admission.maxQueueDepth, admission.total);
      group.maxActiveObserved = Math.max(group.maxActiveObserved, admission.active);
      group.maxActive = Math.max(group.maxActive, admission.maxActive);
      if (event.kind === "restart.admission.admitted") {
        group.admissions++;
        addDuration(group.waits, admission.waitedMs);
      } else {
        const rule = admission.rule ?? "unknown";
        group.failuresByRule[rule] = (group.failuresByRule[rule] ?? 0) + 1;
      }
    }
  }
  boardAccumulate(target, event);
  target.total++;
  if ("runId" in event) accumulateUsage(target.usage, event);
  if (
    event.surface === "server" &&
    (event.kind === "text-generation.operation" || event.kind === "text-generation.child") &&
    event.props?.provider &&
    event.props.operation &&
    event.durationMs !== undefined
  ) {
    const labels = {
      hour: (event.startedAt ?? event.ts).slice(11, 13),
      provider: event.props.provider,
      operation: event.props.operation,
      boardId: event.boardId ?? null,
      kind: event.kind === "text-generation.child" ? ("child" as const) : ("operation" as const),
      outcome:
        event.outcome === "ok" ||
        event.outcome === "timeout" ||
        event.outcome === "refused" ||
        event.outcome === "interrupted" ||
        event.outcome === "interrupted_by_shutdown"
          ? event.outcome
          : ("error" as const),
    };
    const key = JSON.stringify(labels);
    // Bound all dimensions together. Overflow remains visible in kindCounts and raw day files.
    if (target.textGeneration.has(key) || target.textGeneration.size < 4096) {
      const group = target.textGeneration.get(key) ?? { labels, durations: durations() };
      addDuration(group.durations, event.durationMs);
      target.textGeneration.set(key, group);
    } else target.textGenerationOverflow++;
  }
  increment(target.kinds, event.kind);
  if (
    event.kind === "rpc.request" &&
    event.props?.httpRoute?.startsWith("/api/ardud/control/") &&
    event.props?.httpMethod &&
    event.durationMs !== undefined
  ) {
    const labels = {
      route: event.props.httpRoute,
      method: event.props.httpMethod,
      hour: (event.startedAt ?? event.ts).slice(0, 13),
    };
    const identity = JSON.stringify(labels);
    const key =
      target.controlRoutes.has(identity) || target.controlRoutes.size < 4096 ? identity : OTHER;
    let group = target.controlRoutes.get(key);
    if (!group) {
      group = {
        ...(key === OTHER ? { route: OTHER, method: OTHER, hour: OTHER } : labels),
        durations: durations(),
        statuses: new Map(),
        totalWaitMs: 0,
        deadlineExceeded: 0,
      };
      target.controlRoutes.set(key, group);
    }
    addDuration(group.durations, event.durationMs);
    increment(group.statuses, String(event.props.status ?? event.outcome ?? "unknown"));
    group.totalWaitMs += event.props.waitMs ?? 0;
    if (event.durationMs >= 15000) group.deadlineExceeded++;
  }
  if (event.props?.errorTag) increment(target.errors, event.props.errorTag);
  else if (event.errorTag) increment(target.errors, event.errorTag);
  else if (/error|fail/i.test(event.kind)) increment(target.errors, event.kind);
  else if ((event.props?.status ?? 0) >= 400)
    increment(target.errors, `status.${event.props!.status}`);

  const tag = event.props?.errorTag ?? event.errorTag;
  if (
    event.surface === "server" &&
    event.kind !== "mcp.call" &&
    (tag || (event.props?.status ?? 0) >= 400 || /error|fail/i.test(event.kind))
  ) {
    breakdown(
      target.routes,
      {
        route: event.route,
        method: event.props?.method ?? "unknown",
        status: event.props?.status ?? null,
        tag: tag ?? "unknown",
      },
      event,
    );
  }
  // The ledger is canonical: server.mcp.error is a compatibility event for the same call.
  if (event.kind === "mcp.call" && event.outcome !== undefined && event.outcome !== "ok") {
    breakdown(
      target.mcpCodes,
      { tool: event.tool ?? "unknown", code: event.props?.code ?? event.errorTag ?? "unknown" },
      event,
    );
    if (event.errorTag === "reply_timeout" || event.props?.code === "reply_timeout") {
      breakdown(
        target.mcpReplyTimeouts,
        { tool: event.tool ?? "unknown", code: "reply_timeout" },
        event,
        true,
      );
    }
  }
  if (event.kind === "db.slow") {
    breakdown(
      target.dbSpans,
      {
        span: event.props?.span ?? "unknown",
        key: event.props?.key ?? "unknown",
        phase: event.props?.phase ?? "unknown",
      },
      event,
    );
  }

  if (event.kind === "db.statement.summary") {
    const props = event.props;
    if (props?.count !== undefined && props.totalMs !== undefined && props.maxMs !== undefined) {
      const labels = {
        database: props.database ?? "unknown",
        connection: props.connection ?? "unknown",
        lane: props.lane ?? "unknown",
        fingerprint: props.sqlFingerprint ?? "unknown",
        family: props.key ?? "unknown",
      };
      const identity = JSON.stringify(labels);
      const key =
        target.dbStatements.has(identity) || target.dbStatements.size < 512 ? identity : OTHER;
      let row = target.dbStatements.get(key);
      if (!row) {
        row = {
          ...(key === OTHER
            ? {
                database: "other",
                connection: "other",
                lane: "other",
                fingerprint: "other",
                family: "other",
              }
            : labels),
          calls: 0,
          totalMs: 0,
          maxMs: 0,
          returnedRows: 0,
          failures: 0,
        };
        target.dbStatements.set(key, row);
      }
      row.calls += props.count;
      row.totalMs += props.totalMs;
      row.maxMs = Math.max(row.maxMs, props.maxMs);
      row.returnedRows += props.resultCount ?? 0;
      row.failures += props.failures ?? 0;
    }
  }
  if (event.kind === "db.process.disk_read") {
    const props = event.props;
    if (props?.readBytes !== undefined && props.sampleMs !== undefined) {
      target.processDiskRead.readBytes += props.readBytes;
      target.processDiskRead.sampleMs += props.sampleMs;
      target.processDiskRead.samples++;
    } else target.processDiskRead.unavailableSamples++;
  }

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
    event.kind === "kanban.evaluator" &&
    event.boardId &&
    event.trigger &&
    event.purposeKind &&
    event.outcome
  ) {
    if (event.outcome === "started") {
      const identity = JSON.stringify([event.boardId, event.trigger]);
      const key = boundedKey(target.evaluatorStartsByTrigger, identity);
      const group = target.evaluatorStartsByTrigger.get(key) ?? {
        boardId: key === OTHER ? OTHER : event.boardId,
        trigger: key === OTHER ? OTHER : event.trigger,
        count: 0,
      };
      group.count++;
      target.evaluatorStartsByTrigger.set(key, group);
    }
    const labels = {
      boardId: event.boardId,
      trigger: event.trigger,
      purposeKind: event.purposeKind,
      outcome: event.outcome,
      reuseMissReason: event.reuseMissReason ?? null,
    };
    const identity = JSON.stringify(labels);
    const key = boundedKey(target.evaluatorOutcomes, identity);
    const group =
      target.evaluatorOutcomes.get(key) ??
      (key === OTHER
        ? {
            boardId: OTHER,
            trigger: OTHER,
            purposeKind: OTHER,
            outcome: OTHER,
            reuseMissReason: null,
            count: 0,
          }
        : { ...labels, count: 0 });
    group.count++;
    target.evaluatorOutcomes.set(key, group);
  }

  if (
    event.kind === "kanban.tick_phase" &&
    event.surface === "server" &&
    event.boardId &&
    event.props?.phase &&
    event.durationMs !== undefined
  ) {
    const identity = JSON.stringify([event.boardId, event.props.phase]);
    const key = boundedKey(target.tickPhases, identity);
    let group = target.tickPhases.get(key);
    if (!group) {
      group = {
        boardId: key === OTHER ? OTHER : event.boardId,
        phase: key === OTHER ? OTHER : event.props.phase,
        durations: durations(),
      };
      target.tickPhases.set(key, group);
    }
    addDuration(group.durations, event.durationMs);
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
      summary = { ...durations(), totalWaitMs: 0, outcomes: new Map() };
      target.rpcs.set(key, summary);
    }
    addDuration(summary, event.durationMs);
    summary.totalWaitMs += event.props.waitMs ?? 0;
    if (event.outcome !== undefined) increment(summary.outcomes, event.outcome);
  }

  if (
    event.kind !== "ask.answer_sent" &&
    /ask/i.test(event.kind) &&
    /answer|respond|resolv/i.test(event.kind)
  ) {
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
    const bootId = event.bootId ?? "unknown";
    const key = JSON.stringify([event.tool, hour, build, bootId]);
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
        bootId,
        durations: durations(),
        preHandler: durations(),
        failures: 0,
        dispatchTimeouts: 0,
        outcomes: new Map(),
        savedCounts: new Map(),
        reasonClasses: new Map(),
        invalidFields: new Map(),
        notFoundReasons: new Map(),
        foundByCounts: new Map(),
        idShapeCounts: new Map(),
        errors: new Map(),
      };
      target.mcp.set(key, group);
    }
    addDuration(group.durations, event.durationMs ?? 0);
    const dispatchTimeout = event.outcome === "timeout" && event.errorPhase === "dispatch";
    if (dispatchTimeout) group.dispatchTimeouts++;
    if (event.preHandlerMs !== undefined) addDuration(group.preHandler, event.preHandlerMs);
    increment(group.outcomes, event.outcome);
    increment(group.savedCounts, String(event.saved ?? "n/a"));
    if (event.reasonClass) increment(group.reasonClasses, event.reasonClass);
    if (event.invalidField) increment(group.invalidFields, event.invalidField);
    if (event.props?.notFoundReason !== undefined)
      increment(group.notFoundReasons, event.props.notFoundReason);
    if (event.props?.foundBy !== undefined) increment(group.foundByCounts, event.props.foundBy);
    if (event.props?.idShape !== undefined) increment(group.idShapeCounts, event.props.idShape);
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
        attempts.push({
          ts: event.ts,
          group: key,
          ok: event.outcome === "ok",
          ...(dispatchTimeout
            ? { detachedKey: detachedKey(event, event.startedAt ?? event.ts) }
            : {}),
        });
        target.retries.set(identity, attempts);
        target.retryAttempts++;
      }
    }
  }
}

function durationPercentile(values: Durations) {
  const sorted = values.histogram
    ? [...values.histogram].sort(([a], [b]) => a - b)
    : values.exact.toSorted((a, b) => a - b).map((value) => [value, 1] as const);

  return (quantile: number): number | null => {
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
}

export function summarize(values: Durations): AnalyticsLatency {
  const percentile = durationPercentile(values);
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
  const detached = new Map<string, DetachedResult[]>();
  const matchedDetached = new Map<string, number>();
  for (const [key, events] of target.detached) {
    const results: DetachedResult[] = [];
    const caps: number[] = [];
    let nextCap = 0;
    for (const event of events.toSorted((a, b) => a.ts.localeCompare(b.ts))) {
      // A masked commit can settle after its cap; it replaces that observation, not another call.
      const capped = event.afterCap ? caps[nextCap++] : undefined;
      if (capped !== undefined) results[capped] = event;
      else {
        if (event.outcome === "capped") caps.push(results.length);
        results.push(event);
      }
    }
    detached.set(key, results);
  }
  const dispatchTimeouts = new Map<
    string,
    { committed: number; failed: number; capped: number; noOutcome: number }
  >();
  for (const [key, group] of target.mcp)
    dispatchTimeouts.set(key, {
      committed: 0,
      failed: 0,
      capped: 0,
      noOutcome: group.dispatchTimeouts,
    });
  for (const attempts of target.retries.values()) {
    // Detached emission and overlapping calls can arrive out of order, including across segments.
    const ordered = attempts.toSorted((a, b) => a.ts.localeCompare(b.ts));
    for (const attempt of ordered) {
      if (attempt.detachedKey === undefined) continue;
      const index = matchedDetached.get(attempt.detachedKey) ?? 0;
      const result = detached.get(attempt.detachedKey)?.[index];
      if (result === undefined) continue;
      matchedDetached.set(attempt.detachedKey, index + 1);
      const counts = dispatchTimeouts.get(attempt.group)!;
      counts.noOutcome--;
      counts[result.outcome]++;
    }
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1]!;
      if (previous.ok) continue;
      const count = retries.get(previous.group) ?? { failedThenRetried: 0, retrySucceeded: 0 };
      count.failedThenRetried++;
      if (ordered[index]!.ok) count.retrySucceeded++;
      retries.set(previous.group, count);
    }
  }
  const mcp = finishBreakdown(target.mcpCodes);
  return {
    day,
    generatedAt,
    scope: "retained-events",
    total: target.total,
    invalidLines: target.invalidLines,
    kindCounts: Object.fromEntries(target.kinds),
    claudeApiErrors: [...target.claudeApiErrors.values()],
    runtimeSamples: [...target.runtimeSamples.values()]
      .map(({ runningTurnsSum, ...row }) => ({
        ...row,
        runningTurnsAvg: runningTurnsSum / row.samples,
      }))
      .sort((a, b) => a.hour.localeCompare(b.hour)),
    restartAdmission: {
      scope: "server-wide",
      groupBy: "boot-hour",
      loadedTimeShare: null,
      basis:
        "Terminal-hour cohorts; admission waits only. Depth: run lifetime maximum. Active/load: terminal samples. Read without board/card/kind filters.",
      overflow: target.restartAdmissionOverflow,
      groups: [...target.restartAdmission.values()]
        .map(({ waits, ...group }) => {
          const percentile = durationPercentile(waits);
          return {
            ...group,
            wait: {
              count: waits.count,
              p50Ms: percentile(0.5),
              p90Ms: percentile(0.9),
              maxMs: waits.count ? waits.max : null,
              approximate: waits.histogram !== undefined,
            },
          };
        })
        .sort((a, b) => a.hour.localeCompare(b.hour) || a.bootId.localeCompare(b.bootId)),
    },
    evaluatorOutcomes: [...target.evaluatorOutcomes.values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    evaluatorStartsByTrigger: [...target.evaluatorStartsByTrigger.values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    textGenerationOverflow: target.textGenerationOverflow,
    textGeneration: [...target.textGeneration.values()]
      .map((group) => ({ ...group.labels, ...summarize(group.durations) }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    errorCounts: Object.fromEntries(target.errors),
    controlRoutes: [...target.controlRoutes.values()]
      .map(({ durations, statuses, ...labels }) => ({
        ...labels,
        statuses: Object.fromEntries(statuses),
        ...summarize(durations),
      }))
      .sort((a, b) =>
        JSON.stringify([a.hour, a.route, a.method]).localeCompare(
          JSON.stringify([b.hour, b.route, b.method]),
        ),
      ),
    errorsByRoute: finishBreakdown(target.routes).map((row) => ({
      route: String(row.labels.route),
      method: String(row.labels.method),
      status: typeof row.labels.status === "number" ? row.labels.status : null,
      tag: String(row.labels.tag),
      count: row.count,
      p50Ms: row.p50Ms,
      p95Ms: row.p95Ms,
      maxMs: row.maxMs,
      approximate: row.approximate,
    })),
    mcpErrorsByCode: mcp.map((row) => ({
      tool: String(row.labels.tool),
      code: String(row.labels.code),
      count: row.count,
      p50Ms: row.p50Ms,
      p95Ms: row.p95Ms,
      maxMs: row.maxMs,
      approximate: row.approximate,
    })),
    mcpFailureBreakdown: mcp.map((row) => ({
      tool: String(row.labels.tool),
      code: String(row.labels.code),
      count: row.count,
      p50Ms: row.p50Ms,
      p95Ms: row.p95Ms,
      maxMs: row.maxMs,
      approximate: row.approximate,
      byReason: row.byReason,
      byRole: row.byRole,
      byCallerReaderLane: row.byCallerReaderLane,
    })),
    mcpFailureContexts: mcp.flatMap((row) =>
      row.contexts.map(
        ({
          errorTag,
          denyReason,
          callerRole,
          cardStage,
          count,
          p50Ms,
          p95Ms,
          maxMs,
          approximate,
        }) => ({
          tool: String(row.labels.tool),
          code: String(row.labels.code),
          errorTag,
          denyReason,
          callerRole,
          cardStage,
          count,
          p50Ms,
          p95Ms,
          maxMs,
          approximate,
        }),
      ),
    ),
    mcpReplyTimeouts: finishBreakdown(target.mcpReplyTimeouts).flatMap((row) =>
      row.contexts.map((context) => ({
        tool: String(row.labels.tool),
        code: "reply_timeout" as const,
        ...context,
      })),
    ),
    dbStatementFamilies: [...target.dbStatements.values()].sort((a, b) => b.totalMs - a.totalMs),
    processDiskRead: { ...target.processDiskRead },
    dbSlowBySpan: finishBreakdown(target.dbSpans).map((row) => ({
      span: String(row.labels.span),
      key: String(row.labels.key),
      phase: String(row.labels.phase),
      count: row.count,
      p50Ms: row.p50Ms,
      p95Ms: row.p95Ms,
      maxMs: row.maxMs,
      approximate: row.approximate,
      totalWaitMs: row.totalWaitMs,
    })),
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
      .map(([method, values]) => ({
        method,
        ...summarize(values),
        totalWaitMs: values.totalWaitMs,
        outcomes: Object.fromEntries(values.outcomes),
      }))
      .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0) || a.method.localeCompare(b.method))
      .slice(0, 20),
    askAnswerLatency: summarize(target.answers),
    usage: finishUsage(target.usage),
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
      poolChanges: board.poolChanges.toSorted((a, b) => a.at.localeCompare(b.at)),
      poolUtilisation: [...board.pools.values()].map((pool) => ({
        ...pool,
        used: pool.used / pool.samples,
        slots: pool.slots / pool.samples,
        waiting: pool.waiting / pool.samples,
        utilisation: pool.slots === 0 ? null : pool.used / pool.slots,
      })),
      overflow: board.overflow,
    })),
    askLatency: {
      source: "unavailable",
      sentToSeen: summarize(durations()),
      seenToAnswered: summarize(durations()),
      createdToAnswered: summarize(durations()),
      answeredWithoutSeen: 0,
      openOver1hAtDayEnd: null,
      byBlocking: {},
      byKind: {},
    },
    tickPhases: [...target.tickPhases.values()]
      .map((group) => ({
        boardId: group.boardId,
        phase: group.phase,
        ...summarize(group.durations),
      }))
      .sort((a, b) => a.boardId.localeCompare(b.boardId) || a.phase.localeCompare(b.phase)),
    mcpCalls: [...target.mcp]
      .map(([key, group]) => ({
        tool: group.tool,
        hour: group.hour,
        build: group.build,
        bootId: group.bootId,
        ...summarize(group.durations),
        preHandler: summarize(group.preHandler),
        failures: group.failures,
        failureRate: group.failures / group.durations.count,
        outcomes: Object.fromEntries(group.outcomes),
        savedCounts: Object.fromEntries(group.savedCounts),
        reasonClasses: Object.fromEntries(group.reasonClasses),
        invalidFields: Object.fromEntries(group.invalidFields),
        dispatchTimeouts: dispatchTimeouts.get(key)!,
        notFoundReasons: Object.fromEntries(group.notFoundReasons),
        foundByCounts: Object.fromEntries(group.foundByCounts),
        idShapeCounts: Object.fromEntries(group.idShapeCounts),
        errors: [...group.errors.values()],
        ...(retries.get(key) ?? { failedThenRetried: 0, retrySucceeded: 0 }),
      }))
      .sort(
        (a, b) =>
          a.hour.localeCompare(b.hour) ||
          a.tool.localeCompare(b.tool) ||
          a.build.localeCompare(b.build) ||
          a.bootId.localeCompare(b.bootId),
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
