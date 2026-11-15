/**
 * Board activity in a time window, from what the board already stores: card
 * events (moves, flags, review verdicts), asks (asked and answered times) and
 * the board's threads. Feeds board_get `since` (one short row per active card)
 * and board_activity (the day's rollup). Pure: callers pass the rows.
 */
import {
  KANBAN_BACKLOG,
  kanbanWithoutWait,
  kanbanWithoutDeciding,
  kanbanRetryNotBefore,
  KANBAN_DECIDE_MS,
  type KanbanBoard,
  type KanbanCard,
  type KanbanCardEvent,
  type KanbanOwnerAsk,
  type KanbanPool,
  type KanbanStage,
  type KanbanThreadLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { COMPACT_READ_CHARS } from "../../compactRead.ts";
export { COMPACT_READ_CHARS } from "../../compactRead.ts";
import type { SlotEvent } from "../store/KanbanStore.ts";

import * as Retries from "./retries.ts";
import * as Rules from "./rules.ts";
import { waitEventOf } from "./waits.ts";

/** The longest window one read covers. */
export const ACTIVITY_MAX_WINDOW_MS = 72 * 60 * 60 * 1000;
/** The default window: the last day. */
export const ACTIVITY_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Events card_get returns when no events page is asked for. */
export const CARD_EVENTS_DEFAULT = 20;
export const CARD_EVENTS_MAX = 200;
/** Characters one card_get reply stays under (oldest events are dropped whole to fit). */
export const CARD_GET_CHARS = 60_000;
/** Open cards over this long in one stage are listed. */
const LONG_OPEN_MS = 24 * 60 * 60 * 1000;
/** Open asks older than this are listed. */
const OLD_ASK_MS = 6 * 60 * 60 * 1000;
/** Cards with at least this many evaluator wakes in the window are listed. */
const EVALUATOR_WAKES_LISTED = 2;
/** Rows per rollup list at most; lists shrink together until the rollup fits ROLLUP_CHARS. */
const LIST_MAX = 150;
const ROLLUP_CHARS = 55_000;

export interface ActivityWindow {
  readonly since: string;
  readonly until: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const time = (iso: string) => Date.parse(iso);
const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
/** Minute precision is enough for a day's review and keeps rows short. */
const stamp = (iso: string) => `${iso.slice(0, 16)}Z`;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const oneLine = (text: string, max: number) => clip(text.replace(/\s+/g, " ").trim(), max);
const minutesBetween = (from: string, to: string) =>
  Math.max(0, Math.round((time(to) - time(from)) / MINUTE));
const hours = (ms: number) => Math.round((ms / HOUR) * 100) / 100;
const inWindow = (iso: string | null | undefined, window: ActivityWindow): iso is string =>
  iso !== null && iso !== undefined && iso >= window.since && iso < window.until;

export const isPass = (event: KanbanCardEvent) =>
  event.kind === "review" && event.body?.trim() === "clear";
/**
 * A run that failed, by what the board did next: stalled the card (a "Run failed"
 * flag), sent it back for its one retry, moved it to a fresh thread because the
 * thread got too long, or restarted a reviewer that stopped without a verdict
 * (no_verdict also covers the second time, when the board stalls the card).
 * A fresh start someone asked for is not a failure.
 */
export type FailureKind = "stalled" | "retried" | "fresh_thread" | "no_verdict" | "verdict_refused";
const FAILURE_PREFIXES: ReadonlyArray<readonly [FailureKind, string]> = [
  ["retried", Retries.RETRYING_EVENT],
  ["fresh_thread", Retries.FRESH_START_EVENT],
  ["no_verdict", Retries.NO_VERDICT_RESTARTED_EVENT],
];
export const failureKind = (event: KanbanCardEvent): FailureKind | null => {
  const body = event.body ?? "";
  if (event.kind === "flagged") {
    if (body.startsWith("Run failed")) return "stalled";
    if (event.actor._tag === "system" && body.startsWith(Retries.REFUSED_VERDICT_PREFIX))
      return "verdict_refused";
    return event.actor._tag === "system" && body === Retries.NO_VERDICT_REASON
      ? "no_verdict"
      : null;
  }
  if (event.kind !== "moved" || event.actor._tag !== "system") return null;
  return FAILURE_PREFIXES.find(([, prefix]) => body.startsWith(prefix))?.[0] ?? null;
};
export const isFailure = (event: KanbanCardEvent) => failureKind(event) !== null;
/** The provider's words for a failure, without the board's prefix. */
const failureReason = (event: KanbanCardEvent, max: number) => {
  const body = event.body ?? "";
  const prefix = FAILURE_PREFIXES.find(([, known]) => body.startsWith(known))?.[1];
  const rest = (prefix !== undefined ? body.slice(prefix.length) : body)
    .replace(/^Run failed\b/, "")
    .replace(/^[:,]?\s*/, "");
  return oneLine(rest || body, max);
};
export const isFlagCleared = (event: KanbanCardEvent) =>
  event.kind === "flagged" && event.body === "Cleared";
export const isStall = (event: KanbanCardEvent) =>
  event.kind === "flagged" && !isFlagCleared(event);
const isTransition = (event: KanbanCardEvent) =>
  event.toStage !== null && event.fromStage !== event.toStage;
/** An event that clears a stall: a new flag (or Cleared), any move, a review verdict or a wait set. */
const endsStall = (event: KanbanCardEvent) =>
  event.kind === "flagged" ||
  event.kind === "moved" ||
  event.kind === "review" ||
  isTransition(event) ||
  waitEventOf(event) === "set";

/** When the owner answered: the typed answer's time; plain asks keep only closedAt and count as closed. */
const answeredAt = (ask: KanbanOwnerAsk): string | null => ask.answer?.at ?? null;

const askTouched = (ask: KanbanOwnerAsk, window: ActivityWindow) =>
  ask.closedAt === null ||
  inWindow(ask.at, window) ||
  inWindow(answeredAt(ask), window) ||
  inWindow(ask.closedAt, window);

export const groupEvents = (events: ReadonlyArray<KanbanCardEvent>) => {
  const byCard = new Map<string, Array<KanbanCardEvent>>();
  for (const event of events) {
    const list = byCard.get(event.cardId);
    if (list) list.push(event);
    else byCard.set(event.cardId, [event]);
  }
  for (const list of byCard.values()) list.sort((left, right) => left.id - right.id);
  return byCard;
};

/** Cards with an event or an ask in the window (open asks count), in number order. */
export const activeCards = (
  cards: ReadonlyArray<KanbanCard>,
  byCard: ReadonlyMap<string, ReadonlyArray<KanbanCardEvent>>,
  window: ActivityWindow,
) =>
  cards
    .filter(
      (card) =>
        (byCard.get(card.id)?.length ?? 0) > 0 ||
        card.asks.some(
          (ask) => askTouched(ask, window) && (ask.closedAt !== null || card.settledAt === null),
        ),
    )
    .toSorted((left, right) => left.number - right.number);

const askRow = (ask: KanbanOwnerAsk, until: string) => {
  const answered = answeredAt(ask);
  const end = answered ?? (ask.closedAt === null ? until : null);
  return {
    id: ask.id,
    askedAt: stamp(ask.at),
    ...(answered !== null ? { answeredAt: stamp(answered) } : {}),
    ...(ask.closedAt !== null && answered === null ? { closedAt: stamp(ask.closedAt) } : {}),
    ...(ask.closedAt === null ? { open: true } : {}),
    ...(ask.blocking ? { blocking: true } : {}),
    ...(ask.answer?.verdict ? { verdict: ask.answer.verdict } : {}),
    ...(end !== null ? { minutes: minutesBetween(ask.at, end) } : {}),
  };
};

const STAGE_CODE: Record<KanbanStage, string> = {
  todo: "todo",
  working: "work",
  needs_review: "nrev",
  in_review: "rev",
  completed: "done",
  deployed: "dep",
  verified: "ver",
  needs_owner: "owner",
};

/** How to read a compact row; sent once per board_get `since` reply. */
export const COMPACT_LEGEND =
  "path: the card's stages in the window, in order (work=working, nrev=needs_review, rev=in_review, done=completed, dep=deployed, ver=verified, owner=needs_owner); verdicts: one letter per review in the window (P pass, F findings); times are UTC to the minute; minutes on an ask run from asked to answered (to now while open); card_get gives each event.";

/**
 * One short row per card for board_get `since`: no prompt, description or
 * bodies; only what happened in the window.
 */
export const compactRow = (
  card: KanbanCard,
  events: ReadonlyArray<KanbanCardEvent>,
  window: ActivityWindow,
) => {
  const transitions = events.filter(isTransition);
  const stages: Array<string> = [];
  for (const stage of [
    transitions[0]?.fromStage ?? null,
    ...transitions.map((event) => event.toStage),
  ]) {
    const code = stage === null ? null : STAGE_CODE[stage];
    if (code !== null && code !== stages.at(-1)) stages.push(code);
  }
  const verdicts = events
    .filter((event) => event.kind === "review")
    .map((event) => (isPass(event) ? "P" : "F"))
    .join("");
  const failures = events.filter(isFailure);
  const asks = card.asks
    .filter((ask) => askTouched(ask, window))
    .map((ask) => askRow(ask, window.until));
  const comments = events.filter((event) => event.kind === "comment").length;
  const last = events.at(-1);
  return {
    number: card.number,
    title: clip(card.title, 80),
    stage: card.stage,
    priority: card.priority,
    ...(card.settledAt !== null ? { settled: true } : {}),
    ...(card.stalled !== null ? { stalled: oneLine(card.stalled.reason, 100) } : {}),
    ...(card.wait !== undefined ? { wait: oneLine(card.wait.note, 80) } : {}),
    ...(stages.length > 1 ? { path: stages.join(">") } : {}),
    ...(verdicts !== "" ? { verdicts, reviewRound: card.reviewRound } : {}),
    ...(failures.length > 0
      ? {
          failures: failures.length,
          lastFailure: failureReason(failures.at(-1)!, 80),
        }
      : {}),
    ...(asks.length > 0 ? { asks } : {}),
    ...(comments > 0 ? { comments } : {}),
    ...(last !== undefined ? { lastEventAt: stamp(last.at) } : {}),
  };
};

/** Rows in number order after `after`, stopped at `limit` rows or COMPACT_READ_CHARS. */
export const pageRows = <R extends { readonly number: number }>(
  rows: ReadonlyArray<R>,
  after: number,
  limit: number,
  maxChars = COMPACT_READ_CHARS,
) => {
  const out: Array<R> = [];
  let chars = 0;
  const rest = rows.filter((row) => row.number > after);
  for (const row of rest) {
    const size = JSON.stringify(row).length + 1;
    if (out.length >= limit || (out.length > 0 && chars + size > maxChars)) break;
    out.push(row);
    chars += size;
  }
  const hasMore = rest.length > out.length;
  return { rows: out, hasMore, nextAfter: hasMore ? (out.at(-1)?.number ?? after) : null };
};

/**
 * A page of rows inside a reply that wraps them: the rows get what the wrapper
 * leaves of COMPACT_READ_CHARS, so the whole reply stays under it.
 */
export const pageRowsInReply = <R extends { readonly number: number }, Reply>(
  rows: ReadonlyArray<R>,
  after: number,
  limit: number,
  reply: (
    page: ReadonlyArray<R>,
    cursor: { readonly hasMore: boolean; readonly nextAfter: number | null },
  ) => Reply,
): Reply => {
  const wrapper = JSON.stringify(
    reply([], { hasMore: true, nextAfter: Number.MAX_SAFE_INTEGER }),
  ).length;
  const page = pageRows(rows, after, limit, COMPACT_READ_CHARS - wrapper);
  return reply(page.rows, { hasMore: page.hasMore, nextAfter: page.nextAfter });
};

interface Span {
  readonly card: KanbanCard;
  readonly stage: KanbanStage;
  /** Where the span starts inside the window. */
  readonly from: string;
  readonly to: string | null;
  /** When the card really entered the stage, if its history says; for dwell times. */
  readonly start: string | null;
}

/** Stages where time spent with no move still says something: held by a thread, or queued for one or for the owner. */
const SAT_STAGES: ReadonlySet<KanbanStage> = new Set([
  "todo",
  "working",
  "in_review",
  "needs_review",
  "needs_owner",
]);

/** Each card's stages inside the window, replayed from its transitions. */
export const stageSpans = (
  cards: ReadonlyArray<KanbanCard>,
  byCard: ReadonlyMap<string, ReadonlyArray<KanbanCardEvent>>,
  window: ActivityWindow,
  /** Each card's last stage change before the window, for the first span's real start. */
  prior: ReadonlyMap<string, KanbanCardEvent> = new Map(),
  after: ReadonlyMap<string, KanbanCardEvent> = new Map(),
): Array<Span> => {
  const spans: Array<Span> = [];
  for (const card of cards) {
    if (
      card.createdAt >= window.until ||
      (card.settledAt !== null && card.settledAt <= window.since)
    )
      continue;
    const transitions = (byCard.get(card.id) ?? []).filter(isTransition);
    const before = prior.get(card.id);
    const settled =
      card.settledAt !== null && card.settledAt < window.until ? card.settledAt : null;
    const limit = settled ?? window.until;
    if (transitions.length === 0) {
      const stage = before?.toStage ?? after.get(card.id)?.fromStage ?? card.stage;
      if (SAT_STAGES.has(stage))
        spans.push({
          card,
          stage,
          from: card.createdAt > window.since ? card.createdAt : window.since,
          to: settled,
          start: before?.at ?? (card.movedAt < window.until ? card.movedAt : null),
        });
      continue;
    }
    const first = transitions[0]!;
    let stage: KanbanStage | null = first.fromStage;
    let from = card.createdAt > window.since ? card.createdAt : window.since;
    let start: string | null = before !== undefined && before.toStage === stage ? before.at : null;
    for (const event of transitions) {
      const to = event.at < limit ? event.at : limit;
      if (stage !== null && to > from) spans.push({ card, stage, from, to, start });
      if (event.at >= limit) {
        from = limit;
        break;
      }
      stage = event.toStage;
      from = event.at;
      start = event.at;
    }
    if (stage !== null && from < limit) spans.push({ card, stage, from, to: settled, start });
  }
  return spans;
};

/** The thread that ran a card's role at a moment, for its model. */
const threadAt = (
  card: KanbanCard,
  role: "work" | "review",
  at: string,
  threadsByCard: ReadonlyMap<string, ReadonlyArray<KanbanThreadLink>>,
) =>
  (threadsByCard.get(card.id) ?? [])
    .filter((link) => link.role === role && link.startedAt <= at)
    .findLast((link) => link.endedAt === null || link.endedAt >= at);

/**
 * A card's waits in the window, from each wait set to the next wait end (both
 * stored forms, see waitEventOf). A wait already set when the window opened
 * counts from the window's start.
 */
const waitIntervals = (
  card: KanbanCard,
  events: ReadonlyArray<KanbanCardEvent>,
  since: string,
  until: string,
) => {
  const marks = events.flatMap((event) => {
    const mark = waitEventOf(event);
    return mark === null ? [] : [{ mark, at: time(event.at) }];
  });
  const wait = card.wait;
  if (wait !== undefined) {
    const at = time(wait.at);
    if (!marks.some((mark) => mark.mark === "set" && mark.at === at))
      marks.push({ mark: "set", at });
    const end = Math.min(
      time(wait.expiredAt ?? until),
      card.movedAt > wait.at ? time(card.movedAt) : time(until),
    );
    if (end < time(until)) marks.push({ mark: "end", at: end });
  }
  marks.sort((a, b) => a.at - b.at);
  const prior = marks.findLast((mark) => mark.at < time(since));
  const inside = marks.filter((mark) => mark.at >= time(since) && mark.at < time(until));
  const waitingAtStart = prior !== undefined ? prior.mark === "set" : inside[0]?.mark === "end";
  const waits: Array<readonly [number, number]> = [];
  let waitFrom: number | null = waitingAtStart ? time(since) : null;
  for (const { mark, at } of inside) {
    if (mark === "set" && waitFrom === null) waitFrom = at;
    else if (mark === "end" && waitFrom !== null) {
      waits.push([waitFrom, at]);
      waitFrom = null;
    }
  }
  if (waitFrom !== null) waits.push([waitFrom, time(until)]);
  return waits;
};

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

const capped = <T>(items: ReadonlyArray<T>, max: number) =>
  items.length > max ? { items: items.slice(0, max), more: items.length - max } : { items };

export interface RollupInput {
  readonly window: ActivityWindow;
  readonly board?: Pick<KanbanBoard, "pause" | "setup" | "archivedAt"> | null;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly events: ReadonlyArray<KanbanCardEvent>;
  readonly threads: ReadonlyArray<KanbanThreadLink>;
  readonly pools: ReadonlyArray<KanbanPool>;
  /** Last event per slot before since, then all events in the window, ordered by id. */
  readonly slotHistory?: {
    readonly events: ReadonlyArray<SlotEvent>;
    readonly recordedSince: string | null;
  };
  /** Each active card's last stage change before the window (see stageSpans). */
  readonly prior?: ReadonlyArray<KanbanCardEvent> | undefined;
  readonly readinessBefore?: ReadonlyArray<KanbanCardEvent>;
  /** First stage change at or after the window, for cards with no earlier stage history. */
  readonly after?: ReadonlyArray<KanbanCardEvent>;
}

/** Replay thread identities, preserving ledger order even when timestamps tie. */
const ledgerUsage = (
  input: RollupInput,
  hourStarts: ReadonlyArray<number>,
  spans: ReadonlyArray<Span>,
) => {
  const { window, pools } = input;
  const since = time(window.since),
    until = time(window.until);
  const history = input.slotHistory;
  const recordedSince = history?.recordedSince ?? null;
  const coverage = recordedSince === null ? until : Math.max(since, time(recordedSince));
  const holding = new Map<string, Set<string>>();
  const used = new Map<string, number[]>();
  const slotHours = new Map<string, number[]>();
  const queueWait = new Map<string, number[]>();
  const row = (rows: Map<string, number[]>, key: string) => {
    let values = rows.get(key);
    if (!values) rows.set(key, (values = hourStarts.map(() => 0)));
    return values;
  };
  const hourIndex = (at: number) => Math.floor(at / HOUR) - Math.floor(since / HOUR);
  const addHours = (
    rows: Map<string, number[]>,
    pool: string,
    from: number,
    to: number,
    count = 1,
  ) => {
    hourStarts.forEach((start, i) => {
      const overlap = Math.min(to, start + HOUR) - Math.max(from, start, coverage);
      if (overlap > 0) row(rows, pool)[i]! += (overlap * count) / HOUR;
    });
  };
  const events = (history?.events ?? [])
    .filter((event) => event.at < window.until)
    .toSorted((a, b) => a.id - b.id);
  const apply = (event: SlotEvent) => {
    const threads = holding.get(event.poolKey) ?? new Set<string>();
    if (event.kind === "take") threads.add(event.threadId);
    else threads.delete(event.threadId);
    holding.set(event.poolKey, threads);
  };
  for (const event of events) if (event.at < window.since) apply(event);
  // Split full-pool intervals on readiness changes as well as slot changes.
  const cuts = new Set([coverage, until]);
  for (const event of input.events)
    if (event.at >= window.since && event.at < window.until) cuts.add(time(event.at));
  for (const card of input.cards) {
    for (const at of [
      card.createdAt,
      card.movedAt,
      card.settledAt,
      card.stalled?.at,
      card.wait?.at,
      card.wait?.expiredAt,
      card.deciding?.since,
      ...(card.retries ?? []).map((retry) => retry.at),
      ...card.asks.flatMap((ask) => [ask.at, ask.closedAt]),
    ]) {
      if (at != null && time(at) > coverage && time(at) < until) cuts.add(time(at));
    }
    for (const at of [
      kanbanRetryNotBefore(card),
      card.deciding === undefined ? null : time(card.deciding.since) + KANBAN_DECIDE_MS,
    ]) {
      if (at !== null && at > coverage && at < until) cuts.add(at);
    }
  }
  const boundaries = [...cuts].filter((at) => at >= coverage && at <= until).sort((a, b) => a - b);
  const spansByCard = new Map<string, Span[]>();
  for (const span of spans) {
    const list = spansByCard.get(span.card.id) ?? [];
    list.push(span);
    spansByCard.set(span.card.id, list);
  }
  const beforeStages = new Map(
    (input.prior ?? []).map((event) => [event.cardId as string, event.toStage]),
  );
  const afterStages = new Map(
    (input.after ?? []).map((event) => [event.cardId as string, event.fromStage]),
  );
  const atStage = (card: KanbanCard, at: number) =>
    card.settledAt !== null && time(card.settledAt) <= at
      ? "verified"
      : (spansByCard
          .get(card.id)
          ?.find((span) => time(span.from) <= at && time(span.to ?? window.until) > at)?.stage ??
        beforeStages.get(card.id) ??
        afterStages.get(card.id) ??
        card.stage);
  const currentById = new Map(input.cards.map((card) => [card.id as string, card]));
  const readiness = groupEvents([...(input.readinessBefore ?? []), ...input.events]);
  const flags = new Map([...readiness].map(([id, events]) => [id, events.filter(endsStall)]));
  const stalledAt = (card: KanbanCard, at: number) => {
    const last = flags.get(card.id)?.findLast((event) => time(event.at) <= at);
    const snapshot = card.stalled;
    if (
      snapshot !== null &&
      time(snapshot.at) <= at &&
      (last === undefined || snapshot.at > last.at)
    )
      return snapshot;
    return last !== undefined && isStall(last)
      ? { at: last.at, by: last.actor, reason: last.body ?? "" }
      : null;
  };
  const todoSpans = spans
    .filter((span) => span.stage === "todo")
    .map((span) => {
      const card = span.card;
      const ownEvents = readiness.get(card.id) ?? [];
      const models =
        card.workThreadId === null && card.models.length > 0
          ? [...card.models].sort((a, b) => b.weight - a.weight).map((entry) => entry.model)
          : [card.model];
      const routes = [...new Set(models.map((model) => Rules.poolOf(pools, model)))];
      const dependencies = new Set<string>();
      const visit = (id: string) => {
        if (dependencies.has(id)) return;
        dependencies.add(id);
        for (const next of currentById.get(id)?.blockedBy ?? []) visit(next);
      };
      for (const id of card.blockedBy) visit(id);
      return {
        span,
        dependencies,
        waits: waitIntervals(card, ownEvents, window.since, window.until),
        routes,
      };
    });
  const configured = new Map(pools.map((pool) => [pool.key, pool.slots]));
  const queued = (from: number, to: number) => {
    if (input.board?.archivedAt != null || input.board?.setup?.status === "running") return;
    for (const { span, waits, routes, dependencies } of todoSpans) {
      const card = span.card;
      if (input.board?.pause && !input.board.pause.keep.includes(card.id)) continue;
      if (
        time(span.from) > from ||
        time(span.to ?? window.until) <= from ||
        time(card.createdAt) > from
      )
        continue;
      if (
        stalledAt(card, from) !== null ||
        waits.some(([a, b]) => a <= from && b > from) ||
        card.asks.some(
          (ask) =>
            ask.blocking &&
            time(ask.at) <= from &&
            (ask.closedAt === null || time(ask.closedAt) > from),
        )
      )
        continue;
      const candidate = {
        ...kanbanWithoutWait(
          card.deciding !== undefined && time(card.deciding.since) > from
            ? kanbanWithoutDeciding(card)
            : card,
        ),
        stage: "todo" as const,
        activeThreadId: null,
        activePool: null,
        stalled: null,
        settledAt: null,
        asks: [],
        retries: card.retries?.filter((retry) => time(retry.at) <= from),
      };
      const blockers = new Map<string, KanbanCard>();
      for (const id of dependencies) {
        const blocker = currentById.get(id);
        if (blocker && time(blocker.createdAt) <= from)
          blockers.set(id, {
            ...blocker,
            stage: atStage(blocker, from),
            stalled: stalledAt(blocker, from),
          });
      }
      if (!Rules.cardFlow(candidate, blockers, new Map(), from).ready) continue;
      // A weighted alternative with room (or a reusable held thread) is not pool wait.
      const candidates = routes.filter((key) => (configured.get(key) ?? 0) > 0);
      if (candidates.length === 0) continue;
      if (
        candidates.some(
          (key) =>
            holding.get(key)?.has(card.workThreadId ?? "") ||
            (holding.get(key)?.size ?? 0) < configured.get(key)!,
        )
      )
        continue;
      // Attribute a multi-model card once, to its highest-weight enabled route.
      addHours(queueWait, candidates[0]!, from, to);
    }
  };
  let cursor = coverage;
  let boundaryIndex = 0;
  const advance = (end: number) => {
    if (end <= cursor) return;
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]! < end) {
      const cut = boundaries[boundaryIndex++]!;
      if (cut <= cursor) continue;
      segment(cursor, cut);
      cursor = cut;
    }
    segment(cursor, end);
    cursor = end;
  };
  const segment = (from: number, to: number) => {
    for (const [pool, threads] of holding) {
      addHours(slotHours, pool, from, to, threads.size);
      hourStarts.forEach((start, i) => {
        if (Math.min(to, start + HOUR) > Math.max(from, start))
          row(used, pool)[i] = Math.max(row(used, pool)[i]!, threads.size);
      });
    }
    queued(from, to);
  };
  for (const event of events) {
    if (event.at < window.since) continue;
    const at = Math.max(cursor, time(event.at));
    advance(at);
    apply(event);
    if (at >= coverage && at < until) {
      const i = hourIndex(at);
      row(used, event.poolKey)[i] = Math.max(
        row(used, event.poolKey)[i]!,
        holding.get(event.poolKey)!.size,
      );
    }
  }
  advance(until);
  const values = (rows: Map<string, number[]>) =>
    Object.fromEntries(
      [...rows].map(([key, values]) => [
        key,
        values.map((value, i) =>
          hourStarts[i]! + HOUR <= coverage ? null : Math.round(value * 100) / 100,
        ),
      ]),
    );
  return {
    slots: Object.fromEntries(pools.map((pool) => [pool.key, pool.slots])),
    hours: hourStarts.map((at) => `${isoOf(at).slice(0, 13)}Z`),
    recordedSince,
    used: values(used),
    slotHours: values(slotHours),
    queueWait: values(queueWait),
    queueWaitBasis:
      "Ready todo card-hours while every routed pool was full; recorded stages/waits/flags, current board policy, routing, capacities, priority, subtasks and retry/evaluator holds. Multi-model cards count once on their highest-weight enabled route.",
  };
};

/** What a parked card waits on, as a category only: the wait kind, a blocker, a stall, the owner. */
const waitKind = (card: KanbanCard): string | null =>
  card.wait?.on ??
  (card.stalled !== null
    ? "stalled"
    : card.asks.some((ask) => ask.closedAt === null && ask.blocking)
      ? "owner"
      : card.blockedBy.length > 0
        ? "blocked"
        : null);

/**
 * The window's rollup: ask-to-answer times and old open asks, review rounds,
 * time in each stage with dwell percentiles, open cards long in one stage,
 * stalls, run failures by model, thread starts, restarts and evaluator wakes,
 * cards left in working or in_review with no thread, and ledger pool usage. No card titles or text: numbers, stages,
 * kinds and times only (run failure reasons are the provider's error words).
 */
export const rollup = (input: RollupInput) => {
  const { window } = input;
  const until = window.until;
  const byCard = groupEvents(input.events);
  const active = activeCards(input.cards, byCard, window);
  const threadsByCard = new Map<string, Array<KanbanThreadLink>>();
  for (const link of input.threads) {
    if (link.cardId === null) continue;
    const list = threadsByCard.get(link.cardId);
    if (list) list.push(link);
    else threadsByCard.set(link.cardId, [link]);
  }
  for (const list of threadsByCard.values())
    list.sort((left, right) => left.startedAt.localeCompare(right.startedAt));

  type AskItem = ReturnType<typeof askRow> & { readonly card: number };
  // Asks answered in the window are all listed; the rest (open, closed without
  // an answer) are listed newest first and cut first when the rollup is long.
  const answeredItems: Array<AskItem> = [];
  const otherAsks: Array<AskItem> = [];
  const answeredMinutes: Array<number> = [];
  let open = 0;
  let closedNoAnswer = 0;
  for (const card of active) {
    for (const ask of card.asks) {
      if (!askTouched(ask, window)) continue;
      if (ask.closedAt === null && card.settledAt !== null) continue;
      const row = { card: card.number, ...askRow(ask, until) };
      const answered = answeredAt(ask);
      if (answered !== null && inWindow(answered, window)) {
        answeredItems.push(row);
        answeredMinutes.push(row.minutes ?? 0);
        continue;
      }
      otherAsks.push(row);
      if (ask.closedAt === null) open++;
      else if (answered === null && inWindow(ask.closedAt, window)) closedNoAnswer++;
    }
  }
  answeredItems.sort(
    (left, right) =>
      (left.answeredAt ?? "").localeCompare(right.answeredAt ?? "") || left.card - right.card,
  );
  otherAsks.sort(
    (left, right) => right.askedAt.localeCompare(left.askedAt) || left.card - right.card,
  );
  answeredMinutes.sort((left, right) => left - right);

  const reviewCards: Array<{
    card: number;
    rounds: number;
    pass: number;
    findings: number;
    totalRounds: number;
  }> = [];
  for (const card of active) {
    const reviews = (byCard.get(card.id) ?? []).filter((event) => event.kind === "review");
    if (reviews.length === 0) continue;
    const pass = reviews.filter(isPass).length;
    reviewCards.push({
      card: card.number,
      rounds: reviews.length,
      pass,
      findings: reviews.length - pass,
      totalRounds: card.reviewRound,
    });
  }
  reviewCards.sort((left, right) => right.rounds - left.rounds || left.card - right.card);

  // Stages and pool slot use
  const prior = new Map((input.prior ?? []).map((event) => [event.cardId as string, event]));
  const after = new Map((input.after ?? []).map((event) => [event.cardId as string, event]));
  const spans = stageSpans(input.cards, byCard, window, prior, after);
  const stages: Record<
    string,
    {
      hours: number;
      spans: number;
      dwell?: { count: number; medianHours: number; p95Hours: number; maxHours: number };
    }
  > = {};
  const dwells = new Map<string, Array<number>>();
  const hourStarts: Array<number> = [];
  for (let at = Math.floor(time(window.since) / HOUR) * HOUR; at < time(until); at += HOUR)
    hourStarts.push(at);
  // Cards the board shows in working or in_review that no live thread runs.
  const idle: Array<{ card: number; stage: string; since: string }> = [];
  for (const span of spans) {
    const from = time(span.from);
    const to = time(span.to ?? until);
    const entry = (stages[span.stage] ??= { hours: 0, spans: 0 });
    entry.hours += (to - from) / HOUR;
    entry.spans++;
    // Dwell: how long a stage lasted, for stages that ended in the window and whose start is known.
    if (span.to !== null && span.start !== null) {
      const list = dwells.get(span.stage);
      const ms = time(span.to) - time(span.start);
      if (list) list.push(ms);
      else dwells.set(span.stage, [ms]);
    }
    if (span.stage !== "working" && span.stage !== "in_review") continue;
    if (
      span.to === null &&
      span.card.stage === span.stage &&
      span.card.movedAt < until &&
      span.card.activeThreadId === null
    )
      idle.push({ card: span.card.number, stage: span.stage, since: stamp(span.card.movedAt) });
  }
  const poolUsage = ledgerUsage(input, hourStarts, spans);
  idle.sort((left, right) => left.since.localeCompare(right.since));
  for (const [stage, entry] of Object.entries(stages)) {
    entry.hours = hours(entry.hours * HOUR);
    const list = (dwells.get(stage) ?? []).toSorted((left, right) => left - right);
    if (list.length > 0)
      entry.dwell = {
        count: list.length,
        medianHours: hours(percentile(list, 0.5)!),
        p95Hours: hours(percentile(list, 0.95)!),
        maxHours: hours(list.at(-1)!),
      };
  }
  // Open cards (not settled, verified or in the backlog) that have sat in their stage over 24 hours.
  const longOpen = input.cards
    .filter(
      (card) =>
        card.settledAt === null &&
        card.stage !== "verified" &&
        card.priority !== KANBAN_BACKLOG &&
        time(until) - time(card.movedAt) > LONG_OPEN_MS,
    )
    .map((card) => {
      const kind = waitKind(card);
      return {
        card: card.number,
        stage: card.stage,
        hours: hours(time(until) - time(card.movedAt)),
        ...(card.stalled !== null ? { stalled: true as const } : {}),
        ...(kind !== null ? { wait: kind } : {}),
      };
    })
    .toSorted((left, right) => right.hours - left.hours || left.card - right.card);
  const longOpenByStage: Record<string, number> = {};
  for (const row of longOpen) longOpenByStage[row.stage] = (longOpenByStage[row.stage] ?? 0) + 1;
  const longest = spans
    .filter(
      (span) =>
        span.stage !== "completed" && span.stage !== "deployed" && span.stage !== "verified",
    )
    .map((span) => ({
      card: span.card.number,
      stage: span.stage,
      from: stamp(span.from),
      ...(span.to !== null ? { to: stamp(span.to) } : { ongoing: true }),
      hours: hours(time(span.to ?? until) - time(span.from)),
    }))
    .toSorted((left, right) => right.hours - left.hours)
    .slice(0, 15);

  // Stalls: a flag until whatever cleared it. Every path that clears a stall
  // logs a move (answered ask, retry, evaluator, fresh start), a review verdict,
  // a new flag or a wait; a stall with none of those after it and no stall on
  // the card now ended somewhere the history doesn't say.
  const stallItems: Array<{
    card: number;
    at: string;
    kind: "run_failed" | "flagged" | "verdict_refused";
    until?: string;
    minutes?: number;
    ongoing?: true;
    endUnrecorded?: true;
  }> = [];
  for (const card of active) {
    const events = byCard.get(card.id) ?? [];
    events.forEach((event, index) => {
      if (!isStall(event)) return;
      const end = events.slice(index + 1).find(endsStall);
      const ongoing = end === undefined && card.stalled !== null;
      stallItems.push({
        card: card.number,
        at: stamp(event.at),
        kind:
          failureKind(event) === "verdict_refused"
            ? "verdict_refused"
            : isFailure(event)
              ? "run_failed"
              : "flagged",
        ...(end !== undefined
          ? { until: stamp(end.at), minutes: minutesBetween(event.at, end.at) }
          : ongoing
            ? { ongoing: true as const, minutes: minutesBetween(event.at, until) }
            : { endUnrecorded: true as const }),
      });
    });
  }

  // Run failures by the model of the thread that failed.
  const failures: Record<string, { count: number; reasons: Array<string> }> = {};
  const failuresByKind: Partial<Record<FailureKind, number>> = {};
  let failureCount = 0;
  for (const card of active) {
    for (const event of byCard.get(card.id) ?? []) {
      const kind = failureKind(event);
      if (kind === null) continue;
      failureCount++;
      failuresByKind[kind] = (failuresByKind[kind] ?? 0) + 1;
      const role = event.fromStage === "in_review" ? "review" : "work";
      const thread = threadAt(card, role, event.at, threadsByCard);
      const pool = thread?.model
        ? Rules.poolKey(thread.model)
        : role === "work"
          ? Rules.poolKey(card.model)
          : "review (model unknown)";
      const entry = (failures[pool] ??= { count: 0, reasons: [] });
      entry.count++;
      const reason = failureReason(event, 120);
      if (entry.reasons.length < 3 && !entry.reasons.includes(reason)) entry.reasons.push(reason);
    }
  }

  // Threads started in the window; a card with a second thread for the same role restarted.
  const started: Record<string, Record<string, number>> = {};
  const restarts: Array<{ card: number; role: string; threads: number }> = [];
  const byNumber = new Map(input.cards.map((card) => [card.id as string, card.number]));
  for (const link of input.threads) {
    if (!inWindow(link.startedAt, window)) continue;
    const role = link.role === "evaluator" ? "evaluator" : link.role;
    const pool = link.model ? Rules.poolKey(link.model) : "unknown";
    const row = (started[role] ??= {});
    row[pool] = (row[pool] ?? 0) + 1;
  }
  for (const [cardId, links] of threadsByCard) {
    for (const role of ["work", "review"] as const) {
      const count = links.filter(
        (link) => link.role === role && inWindow(link.startedAt, window),
      ).length;
      const before = links.some((link) => link.role === role && link.startedAt < window.since);
      const threads = count + (before && count > 0 ? 1 : 0);
      if (threads > 1) restarts.push({ card: byNumber.get(cardId) ?? 0, role, threads });
    }
  }
  restarts.sort((left, right) => right.threads - left.threads || left.card - right.card);

  // Evaluator wakes: evaluator threads the board started for a card in the window.
  const evaluatorWakes: Array<{ card: number; wakes: number }> = [];
  let evaluatorWakeCount = 0;
  for (const [cardId, links] of threadsByCard) {
    const wakes = links.filter(
      (link) => link.role === "evaluator" && inWindow(link.startedAt, window),
    ).length;
    evaluatorWakeCount += wakes;
    if (wakes >= EVALUATOR_WAKES_LISTED)
      evaluatorWakes.push({ card: byNumber.get(cardId) ?? 0, wakes });
  }
  evaluatorWakes.sort((left, right) => right.wakes - left.wakes || left.card - right.card);

  // Open asks older than 6 hours, oldest first.
  const oldAsks: Array<{
    card: number;
    ask: string;
    askedAt: string;
    hours: number;
    blocking?: true;
  }> = [];
  for (const card of input.cards) {
    if (card.settledAt !== null) continue;
    for (const ask of card.asks)
      if (ask.closedAt === null && time(until) - time(ask.at) > OLD_ASK_MS)
        oldAsks.push({
          card: card.number,
          ask: ask.id,
          askedAt: stamp(ask.at),
          hours: hours(time(until) - time(ask.at)),
          ...(ask.blocking ? { blocking: true as const } : {}),
        });
  }
  oldAsks.sort((left, right) => right.hours - left.hours || left.card - right.card);

  const build = (max: number) => ({
    window: { since: window.since, until },
    cards: {
      active: active.length,
      settled: active.filter((card) => card.settledAt !== null).length,
    },
    asks: {
      answered: answeredMinutes.length,
      open,
      closedWithoutAnswer: closedNoAnswer,
      answerMinutes: {
        p50: percentile(answeredMinutes, 0.5),
        p90: percentile(answeredMinutes, 0.9),
        max: answeredMinutes.at(-1) ?? null,
      },
      answeredItems,
      others: capped(otherAsks, max),
      openOver6h: { count: oldAsks.length, ...capped(oldAsks, max) },
    },
    reviews: {
      rounds: reviewCards.reduce((sum, row) => sum + row.rounds, 0),
      pass: reviewCards.reduce((sum, row) => sum + row.pass, 0),
      findings: reviewCards.reduce((sum, row) => sum + row.findings, 0),
      ...capped(reviewCards, max),
    },
    stages: {
      hours: stages,
      longest,
      openOver24h: { count: longOpen.length, byStage: longOpenByStage, ...capped(longOpen, max) },
      withoutThread: { count: idle.length, ...capped(idle, max) },
    },
    stalls: { count: stallItems.length, ...capped(stallItems, max) },
    failures: { count: failureCount, byKind: failuresByKind, byPool: failures },
    threads: {
      started,
      restarts: capped(restarts, max),
      evaluatorWakes: {
        count: evaluatorWakeCount,
        [`cardsWith${EVALUATOR_WAKES_LISTED}OrMore`]: capped(evaluatorWakes, max),
      },
    },
    pools: poolUsage,
  });
  let max = LIST_MAX;
  let result = build(max);
  // A busy window shortens every list alike (counts stay exact) so one call never overflows.
  while (max > 10 && JSON.stringify(result).length > ROLLUP_CHARS) {
    max = Math.floor(max * 0.7);
    result = build(max);
  }
  return result;
};

export type CardEventsRequest =
  | "all"
  | { readonly before?: number | undefined; readonly limit?: number | undefined }
  | undefined;

/**
 * card_get's events page: the newest `limit` (default 20) before `before`,
 * oldest first. Oldest events are dropped whole until the reply (card and
 * threads included, never trimmed) fits CARD_GET_CHARS; olderEvents is the
 * `before` that reads the page before, null at the start. "all" returns every
 * event, which can be more than a client takes.
 */
export const pageCardEvents = (
  rest: unknown,
  events: ReadonlyArray<KanbanCardEvent>,
  request: CardEventsRequest,
) => {
  const total = events.length;
  if (request === "all") return { events, eventsTotal: total, olderEvents: null };
  const before = request?.before;
  const limit = Math.min(Math.max(request?.limit ?? CARD_EVENTS_DEFAULT, 1), CARD_EVENTS_MAX);
  const older = before === undefined ? events : events.filter((event) => event.id < before);
  let page = older.slice(-limit);
  const size = (event: KanbanCardEvent) => JSON.stringify(event).length + 1;
  const baseChars = JSON.stringify({
    rest,
    eventsTotal: total,
    olderEvents: Number.MAX_SAFE_INTEGER,
    note: "x".repeat(160),
    events: [],
  }).length;
  let chars = baseChars + page.reduce((sum, event) => sum + size(event), 0);
  while (page.length > 0 && chars > CARD_GET_CHARS) {
    chars -= size(page[0]!);
    page = page.slice(1);
  }
  if (page.length > 0) {
    const first = page[0]!;
    return {
      events: page,
      eventsTotal: total,
      olderEvents: older.some((event) => event.id < first.id) ? first.id : null,
    };
  }
  const newest = older.at(-1);
  if (newest === undefined) return { events: [], eventsTotal: total, olderEvents: null };
  if (baseChars + size(newest) > CARD_GET_CHARS && baseChars <= CARD_GET_CHARS)
    return {
      events: [],
      eventsTotal: total,
      olderEvents: older.length > 1 ? newest.id : null,
      note: `Event ${newest.id} is too big to send with the card; events: "all" returns it.`,
    };
  return {
    events: [],
    eventsTotal: total,
    olderEvents: newest.id + 1,
    note: 'The card alone fills the reply; events: "all" returns its events.',
  };
};

const parseTime = (value: string, now: number) => {
  const trimmed = value.trim();
  if (/^now$/i.test(trimmed)) return now;
  const relative = /^(?:now-)?(\d{1,4})([mhd])$/i.exec(trimmed);
  if (relative !== null) {
    const unit = relative[2]!.toLowerCase();
    const scale = unit === "m" ? MINUTE : unit === "h" ? HOUR : 24 * HOUR;
    return now - Number(relative[1]) * scale;
  }
  return Date.parse(value);
};

/** Parses since/until into a window of at most 72 hours. */
export const parseWindow = (
  since: string | undefined,
  until: string | undefined,
  now: number,
): ActivityWindow | string => {
  const end = until === undefined ? now : parseTime(until, now);
  if (!Number.isFinite(end))
    return "until must be an ISO time or a relative time like now-24h or 24h.";
  // `until` is exclusive; by default it includes an event written in the same millisecond.
  const exclusiveEnd = until === undefined ? end + 1 : end;
  const start =
    since === undefined ? exclusiveEnd - ACTIVITY_DEFAULT_WINDOW_MS : parseTime(since, now);
  if (!Number.isFinite(start))
    return "since must be an ISO time or a relative time like now-24h or 24h.";
  if (start >= end)
    return `since ${isoOf(start)} is not before until ${isoOf(end)} (${until === undefined ? "now, server clock, UTC" : "explicit until, UTC"}).`;
  if (exclusiveEnd - start > ACTIVITY_MAX_WINDOW_MS) return "The window is at most 72 hours.";
  return { since: isoOf(start), until: isoOf(exclusiveEnd) };
};
