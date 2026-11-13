/**
 * Board activity in a time window, from what the board already stores: card
 * events (moves, flags, review verdicts), asks (asked and answered times) and
 * the board's threads. Feeds board_get `since` (one short row per active card)
 * and board_activity (the day's rollup). Pure: callers pass the rows.
 */
import type {
  KanbanCard,
  KanbanCardEvent,
  KanbanOwnerAsk,
  KanbanPool,
  KanbanStage,
  KanbanThreadLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import * as Rules from "./rules.ts";

/** The longest window one read covers. */
export const ACTIVITY_MAX_WINDOW_MS = 72 * 60 * 60 * 1000;
/** The default window: the last day. */
export const ACTIVITY_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Characters one compact read stays under, well below the agents' tool output limit. */
export const COMPACT_READ_CHARS = 50_000;
/** Events card_get returns in its bounded form when no eventsLimit is given. */
export const CARD_EVENTS_DEFAULT = 40;
export const CARD_EVENTS_MAX = 200;
/** An event body longer than this is cut in card_get's bounded form; the full read keeps it. */
export const CARD_EVENT_BODY_CHARS = 2_000;
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
export const isFailure = (event: KanbanCardEvent) =>
  event.kind === "flagged" && (event.body ?? "").startsWith("Run failed");
export const isFlagCleared = (event: KanbanCardEvent) =>
  event.kind === "flagged" && event.body === "Cleared";
export const isStall = (event: KanbanCardEvent) => event.kind === "flagged" && !isFlagCleared(event);
const isTransition = (event: KanbanCardEvent) =>
  event.toStage !== null && event.fromStage !== event.toStage;

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
        card.asks.some((ask) => askTouched(ask, window) && (ask.closedAt !== null || card.settledAt === null)),
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

/**
 * One short row per card for board_get `since`: no prompt, description or
 * bodies; only what happened in the window.
 */
export const compactRow = (
  card: KanbanCard,
  events: ReadonlyArray<KanbanCardEvent>,
  window: ActivityWindow,
) => {
  const moves = events
    .filter(isTransition)
    .map((event) => [stamp(event.at), event.fromStage, event.toStage] as const);
  const reviews = events
    .filter((event) => event.kind === "review")
    .map(
      (event) =>
        [stamp(event.at), isPass(event) ? "pass" : "findings", event.head?.slice(0, 10) ?? null] as const,
    );
  const failures = events
    .filter(isFailure)
    .map((event) => [stamp(event.at), oneLine(event.body ?? "", 120)] as const);
  const asks = card.asks.filter((ask) => askTouched(ask, window)).map((ask) => askRow(ask, window.until));
  const comments = events.filter((event) => event.kind === "comment").length;
  return {
    number: card.number,
    title: clip(card.title, 100),
    stage: card.stage,
    priority: card.priority,
    ...(card.settledAt !== null ? { settled: true } : {}),
    ...(card.stalled !== null ? { stalled: oneLine(card.stalled.reason, 140) } : {}),
    ...(card.wait !== undefined ? { wait: oneLine(card.wait.note, 100) } : {}),
    ...(card.reviewRound > 0 ? { reviewRound: card.reviewRound } : {}),
    ...(moves.length > 0 ? { moves } : {}),
    ...(reviews.length > 0 ? { reviews } : {}),
    ...(failures.length > 0 ? { failures } : {}),
    ...(asks.length > 0 ? { asks } : {}),
    ...(comments > 0 ? { comments } : {}),
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

interface Span {
  readonly card: KanbanCard;
  readonly stage: KanbanStage;
  readonly from: string;
  readonly to: string | null;
}

/** Each card's stages inside the window, replayed from its transitions. */
export const stageSpans = (
  cards: ReadonlyArray<KanbanCard>,
  byCard: ReadonlyMap<string, ReadonlyArray<KanbanCardEvent>>,
  window: ActivityWindow,
): Array<Span> => {
  const spans: Array<Span> = [];
  for (const card of cards) {
    const transitions = (byCard.get(card.id) ?? []).filter(isTransition);
    if (transitions.length === 0) {
      // Nothing moved it: it sat in one stage all window. Only a held stage says anything then.
      if (
        card.settledAt === null &&
        card.createdAt < window.until &&
        (card.stage === "working" || card.stage === "in_review")
      )
        spans.push({
          card,
          stage: card.stage,
          from: card.createdAt > window.since ? card.createdAt : window.since,
          to: null,
        });
      continue;
    }
    const first = transitions[0]!;
    let stage: KanbanStage | null = first.fromStage;
    let from = window.since;
    for (const event of transitions) {
      if (stage !== null && event.at > from) spans.push({ card, stage, from, to: event.at });
      stage = event.toStage;
      from = event.at;
    }
    if (stage !== null && card.settledAt === null) spans.push({ card, stage, from, to: null });
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

const spanPool = (
  span: Span,
  at: string,
  threadsByCard: ReadonlyMap<string, ReadonlyArray<KanbanThreadLink>>,
) => {
  const role = span.stage === "in_review" ? "review" : "work";
  const thread = threadAt(span.card, role, at, threadsByCard);
  if (thread?.model) return Rules.poolKey(thread.model);
  return role === "work" ? Rules.poolKey(span.card.model) : "review (model unknown)";
};

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

const capped = <T>(items: ReadonlyArray<T>, max: number) =>
  items.length > max ? { items: items.slice(0, max), more: items.length - max } : { items };

export interface RollupInput {
  readonly window: ActivityWindow;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly events: ReadonlyArray<KanbanCardEvent>;
  readonly threads: ReadonlyArray<KanbanThreadLink>;
  readonly pools: ReadonlyArray<KanbanPool>;
}

/**
 * The window's rollup: ask-to-answer times, review rounds, time in each stage,
 * stalls, run failures by model, thread starts and restarts, and pool slot use
 * per hour. Slot use counts card time in working and in_review on the model of
 * the thread that ran it (cards hold their slot there, parked or not).
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

  // Asks
  const askItems: Array<ReturnType<typeof askRow> & { readonly card: number }> = [];
  const answeredMinutes: Array<number> = [];
  let open = 0;
  let closedNoAnswer = 0;
  for (const card of active) {
    for (const ask of card.asks) {
      if (!askTouched(ask, window)) continue;
      if (ask.closedAt === null && card.settledAt !== null) continue;
      const row = askRow(ask, until);
      askItems.push({ card: card.number, ...row });
      const answered = answeredAt(ask);
      if (answered !== null && inWindow(answered, window)) answeredMinutes.push(row.minutes ?? 0);
      else if (ask.closedAt === null) open++;
      else if (answered === null && inWindow(ask.closedAt, window)) closedNoAnswer++;
    }
  }
  askItems.sort((left, right) => left.askedAt.localeCompare(right.askedAt));
  answeredMinutes.sort((left, right) => left - right);

  // Reviews
  const reviewCards: Array<{
    card: number;
    title: string;
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
      title: clip(card.title, 80),
      rounds: reviews.length,
      pass,
      findings: reviews.length - pass,
      totalRounds: card.reviewRound,
    });
  }
  reviewCards.sort((left, right) => right.rounds - left.rounds || left.card - right.card);

  // Stages and pool slot use
  const spans = stageSpans(input.cards, byCard, window);
  const stages: Record<string, { hours: number; spans: number }> = {};
  const hourStarts: Array<number> = [];
  for (let at = Math.floor(time(window.since) / HOUR) * HOUR; at < time(until); at += HOUR)
    hourStarts.push(at);
  const used = new Map<string, Array<number>>();
  for (const span of spans) {
    const from = time(span.from);
    const to = time(span.to ?? until);
    const entry = (stages[span.stage] ??= { hours: 0, spans: 0 });
    entry.hours += (to - from) / HOUR;
    entry.spans++;
    if (span.stage !== "working" && span.stage !== "in_review") continue;
    const pool = spanPool(span, span.from, threadsByCard);
    let row = used.get(pool);
    if (!row) used.set(pool, (row = hourStarts.map(() => 0)));
    hourStarts.forEach((start, index) => {
      const overlap = Math.min(to, start + HOUR) - Math.max(from, start, time(window.since));
      if (overlap > 0) row[index]! += overlap / HOUR;
    });
  }
  for (const entry of Object.values(stages)) entry.hours = hours(entry.hours * HOUR);
  const longest = spans
    .filter((span) => span.stage !== "completed" && span.stage !== "deployed" && span.stage !== "verified")
    .map((span) => ({
      card: span.card.number,
      stage: span.stage,
      from: stamp(span.from),
      ...(span.to !== null ? { to: stamp(span.to) } : { ongoing: true }),
      hours: hours(time(span.to ?? until) - time(span.from)),
    }))
    .toSorted((left, right) => right.hours - left.hours)
    .slice(0, 15);

  // Stalls: a flag until it was cleared or the card started again.
  const stallItems: Array<{
    card: number;
    at: string;
    reason: string;
    until?: string;
    minutes: number;
    ongoing?: true;
  }> = [];
  for (const card of active) {
    const events = byCard.get(card.id) ?? [];
    events.forEach((event, index) => {
      if (!isStall(event)) return;
      const end = events
        .slice(index + 1)
        .find((next) => isFlagCleared(next) || (isTransition(next) && next.toStage === "working"));
      stallItems.push({
        card: card.number,
        at: stamp(event.at),
        reason: oneLine(event.body ?? "", 120),
        ...(end ? { until: stamp(end.at) } : card.stalled !== null ? { ongoing: true as const } : {}),
        minutes: minutesBetween(event.at, end?.at ?? until),
      });
    });
  }

  // Run failures by the model of the thread that failed.
  const failures: Record<string, { count: number; reasons: Array<string> }> = {};
  let failureCount = 0;
  for (const card of active) {
    for (const event of byCard.get(card.id) ?? []) {
      if (!isFailure(event)) continue;
      failureCount++;
      const role = event.fromStage === "in_review" ? "review" : "work";
      const thread = threadAt(card, role, event.at, threadsByCard);
      const pool = thread?.model
        ? Rules.poolKey(thread.model)
        : role === "work"
          ? Rules.poolKey(card.model)
          : "review (model unknown)";
      const entry = (failures[pool] ??= { count: 0, reasons: [] });
      entry.count++;
      const reason = oneLine((event.body ?? "").replace(/^Run failed:\s*/, ""), 120);
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
      const count = links.filter((link) => link.role === role && inWindow(link.startedAt, window)).length;
      const before = links.some((link) => link.role === role && link.startedAt < window.since);
      const threads = count + (before && count > 0 ? 1 : 0);
      if (threads > 1) restarts.push({ card: byNumber.get(cardId) ?? 0, role, threads });
    }
  }
  restarts.sort((left, right) => right.threads - left.threads || left.card - right.card);

  const build = (max: number) => ({
    window: { since: window.since, until },
    cards: { active: active.length, settled: active.filter((card) => card.settledAt !== null).length },
    asks: {
      answered: answeredMinutes.length,
      open,
      closedWithoutAnswer: closedNoAnswer,
      answerMinutes: {
        p50: percentile(answeredMinutes, 0.5),
        p90: percentile(answeredMinutes, 0.9),
        max: answeredMinutes.at(-1) ?? null,
      },
      ...capped(askItems, max),
    },
    reviews: {
      rounds: reviewCards.reduce((sum, row) => sum + row.rounds, 0),
      pass: reviewCards.reduce((sum, row) => sum + row.pass, 0),
      findings: reviewCards.reduce((sum, row) => sum + row.findings, 0),
      ...capped(reviewCards, max),
    },
    stages: { hours: stages, longest },
    stalls: { count: stallItems.length, ...capped(stallItems, max) },
    failures: { count: failureCount, byPool: failures },
    threads: { started, restarts: capped(restarts, max) },
    pools: {
      slots: Object.fromEntries(input.pools.map((pool) => [pool.key, pool.slots])),
      hours: hourStarts.map((start) => `${isoOf(start).slice(0, 13)}Z`),
      /** Average slots held per hour (card time in working + in_review). */
      used: Object.fromEntries(
        [...used].map(([pool, row]) => [pool, row.map((value) => Math.round(value * 100) / 100)]),
      ),
    },
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

/**
 * card_get's bounded form: the newest events before a cursor, long bodies cut,
 * closed asks without their blocks, drafts and options.
 */
export const boundedEvents = (
  events: ReadonlyArray<KanbanCardEvent>,
  limit: number,
  before: number | undefined,
) => {
  const older = before === undefined ? events : events.filter((event) => event.id < before);
  const page = older.slice(-limit);
  const out: Array<KanbanCardEvent & { readonly bodyChars?: number }> = [];
  let chars = 0;
  for (let index = page.length - 1; index >= 0; index--) {
    const event = page[index]!;
    const body = event.body;
    const cut =
      body !== null && body.length > CARD_EVENT_BODY_CHARS
        ? { ...event, body: clip(body, CARD_EVENT_BODY_CHARS), bodyChars: body.length }
        : event;
    const size = JSON.stringify(cut).length + 1;
    if (out.length > 0 && chars + size > COMPACT_READ_CHARS / 2) break;
    out.unshift(cut);
    chars += size;
  }
  const remaining = older.length - out.length;
  return {
    events: out,
    ...(remaining > 0 ? { eventsMore: { before: out[0]?.id ?? before ?? 0, older: remaining } } : {}),
  };
};

export const compactAsks = (card: KanbanCard): KanbanCard => ({
  ...card,
  asks: card.asks.map((ask) =>
    ask.closedAt === null
      ? ask
      : ({
          id: ask.id,
          text: clip(ask.text, 300),
          blocking: ask.blocking,
          by: ask.by,
          at: ask.at,
          seq: ask.seq,
          closedAt: ask.closedAt,
          ...(ask.kind !== undefined ? { kind: ask.kind } : {}),
          ...(ask.title !== undefined ? { title: ask.title } : {}),
          ...(ask.answer !== undefined
            ? {
                answer: {
                  ...ask.answer,
                  ...(ask.answer.text !== undefined ? { text: clip(ask.answer.text, 500) } : {}),
                  ...(ask.answer.note !== undefined ? { note: clip(ask.answer.note, 500) } : {}),
                },
              }
            : {}),
        } as KanbanOwnerAsk),
  ),
});

/** Parses since/until into a bounded window ending no later than now. */
export const parseWindow = (
  since: string | undefined,
  until: string | undefined,
  now: number,
): ActivityWindow | string => {
  // `until` is exclusive; by default it includes an event written in the same millisecond.
  const end = until === undefined ? now + 1 : Date.parse(until);
  if (!Number.isFinite(end)) return "until must be an ISO time.";
  const start = since === undefined ? end - ACTIVITY_DEFAULT_WINDOW_MS : Date.parse(since);
  if (!Number.isFinite(start)) return "since must be an ISO time.";
  if (start >= end) return "since must be before until.";
  if (end - start > ACTIVITY_MAX_WINDOW_MS) return "The window is at most 72 hours.";
  return { since: isoOf(start), until: isoOf(end) };
};
