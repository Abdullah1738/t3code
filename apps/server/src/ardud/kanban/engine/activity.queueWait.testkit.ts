import {
  KANBAN_DECIDE_MS,
  KanbanBoardId,
  KanbanCardId,
  ProviderInstanceId,
  ThreadId,
  kanbanRetryNotBefore,
  kanbanWithoutDeciding,
  kanbanWithoutWait,
  type KanbanCard,
  type KanbanCardEvent,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { SlotEvent } from "../store/KanbanStore.ts";

import * as Activity from "./activity.ts";
import * as Rules from "./rules.ts";

type RollupInput = Activity.RollupInput;
type Span = ReturnType<typeof Activity.stageSpans>[number];

export const HOUR = 3_600_000;
const time = (iso: string) => Date.parse(iso);
const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

// Frozen from b6990f1f6ee6: keep the scan-based replay independent of the optimized ledger.
// stageSpans and dispatcher contracts remain shared; the replay and its readiness helpers do not.
const waitEventOf = (event: Pick<KanbanCardEvent, "kind" | "body">): "set" | "end" | null => {
  if (event.kind === "wait_set") return "set";
  if (event.kind === "wait_cleared" || event.kind === "wait_expired") return "end";
  if (event.kind !== "edited" || event.body === null) return null;
  if (event.body.startsWith("Waiting ")) return "set";
  if (event.body.startsWith("Wait ended: ") || event.body.startsWith("Wait expired: "))
    return "end";
  return null;
};

const isFlagCleared = (event: KanbanCardEvent) =>
  event.kind === "flagged" && event.body === "Cleared";
const isStall = (event: KanbanCardEvent) => event.kind === "flagged" && !isFlagCleared(event);
const isTransition = (event: KanbanCardEvent) =>
  event.toStage !== null && event.fromStage !== event.toStage;
/** An event that clears a stall: a new flag (or Cleared), any move, a review verdict or a wait set. */
const endsStall = (event: KanbanCardEvent) =>
  event.kind === "flagged" ||
  event.kind === "moved" ||
  event.kind === "review" ||
  isTransition(event) ||
  waitEventOf(event) === "set";

const groupEvents = (events: ReadonlyArray<KanbanCardEvent>) => {
  const byCard = new Map<string, Array<KanbanCardEvent>>();
  for (const event of events) {
    const list = byCard.get(event.cardId);
    if (list) list.push(event);
    else byCard.set(event.cardId, [event]);
  }
  for (const list of byCard.values()) list.sort((left, right) => left.id - right.id);
  return byCard;
};

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

const legacyLedgerUsage = (
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

export const fixtureSpans = (input: RollupInput) =>
  Activity.stageSpans(
    input.cards,
    groupEvents(input.events),
    input.window,
    new Map((input.prior ?? []).map((event) => [event.cardId as string, event])),
    new Map((input.after ?? []).map((event) => [event.cardId as string, event])),
  );

export const legacyPools = (input: RollupInput) => {
  const hourStarts: number[] = [];
  for (
    let at = Math.floor(time(input.window.since) / HOUR) * HOUR;
    at < time(input.window.until);
    at += HOUR
  )
    hourStarts.push(at);
  return legacyLedgerUsage(input, hourStarts, fixtureSpans(input));
};

export const BEFORE = "2026-11-10T00:00:00.000Z";
export const SINCE = "2026-11-12T00:00:00.000Z";
export const at = (hours: number) => isoOf(time(SINCE) + hours * HOUR);
export const models = {
  primary: { instanceId: ProviderInstanceId.make("opencode"), model: "opus/claude-opus-5-5" },
  secondary: { instanceId: ProviderInstanceId.make("opencode"), model: "opus/claude-sonnet-5-5" },
  free: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  disabled: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
};
export const keys = {
  primary: Rules.poolKey(models.primary),
  secondary: Rules.poolKey(models.secondary),
  free: Rules.poolKey(models.free),
  disabled: Rules.poolKey(models.disabled),
};

export const fixtureCard = (id: string, patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id: KanbanCardId.make(id),
  boardId: KanbanBoardId.make("queue-wait"),
  number: 1,
  title: id,
  description: "",
  prompt: "do it",
  stage: "todo",
  priority: 3,
  goalId: null,
  projects: [],
  model: models.primary,
  models: [],
  subtasks: [],
  subtaskSeq: 0,
  projectId: null,
  links: [],
  blockedBy: [],
  stalled: null,
  question: null,
  asks: [],
  reviewChain: null,
  reviewStep: 0,
  reviewRound: 0,
  activeThreadId: null,
  activeRole: null,
  activePool: null,
  workThreadId: null,
  reviewThreadId: null,
  discussionId: null,
  wakeNote: null,
  nudgedAt: null,
  settledAt: null,
  createdBy: { _tag: "owner" },
  createdAt: BEFORE,
  updatedAt: BEFORE,
  movedAt: BEFORE,
  ...patch,
});

export const fixtureAsk = (
  id: string,
  start: string,
  end: string | null,
  blocking = true,
): KanbanOwnerAsk => ({
  id,
  text: "Continue?",
  at: start,
  closedAt: end,
  blocking,
  by: { _tag: "owner" },
  seq: null,
  ...(end === null ? {} : { answer: { verdict: "approve", by: { _tag: "owner" }, at: end } }),
});

export const fixtureEvent = (
  id: number,
  cardId: string,
  when: string,
  kind: KanbanCardEvent["kind"] = "comment",
  patch: Partial<KanbanCardEvent> = {},
): KanbanCardEvent => ({
  id,
  cardId: KanbanCardId.make(cardId),
  at: when,
  actor: { _tag: "system", component: "dispatcher" },
  kind,
  fromStage: null,
  toStage: null,
  body: null,
  head: null,
  ...patch,
});

export const fixtureSlot = (
  id: number,
  kind: SlotEvent["kind"],
  threadId: string,
  when: string,
  poolKey = keys.primary,
): SlotEvent => ({
  id,
  boardId: "queue-wait",
  poolKey,
  threadId,
  cardId: null,
  kind,
  at: when,
  why: kind === "take" ? "start" : "card_left",
});

export const fixtureWait = (
  start: string,
  end: string | null = null,
): NonNullable<KanbanCard["wait"]> => ({
  on: "ci",
  script: null,
  args: null,
  pr: "https://example.com/pull/1875",
  card: null,
  ask: null,
  until: null,
  sinceHead: null,
  note: "CI",
  by: { _tag: "owner" },
  at: start,
  wakeRole: null,
  expiredAt: end,
  status: null,
  lastCheckedAt: null,
  failures: 0,
  problem: null,
});

export const fixtureInput = (patch: Partial<RollupInput> = {}): RollupInput => ({
  window: { since: SINCE, until: at(4) },
  cards: [],
  events: [],
  threads: [],
  pools: [
    { key: keys.primary, model: models.primary, slots: 2 },
    { key: keys.secondary, model: models.secondary, slots: 1 },
    { key: keys.free, model: models.free, slots: 1 },
    { key: keys.disabled, model: models.disabled, slots: 0 },
  ],
  slotHistory: {
    recordedSince: BEFORE,
    events: [
      fixtureSlot(1, "take", "primary-1", BEFORE),
      fixtureSlot(2, "take", "primary-2", BEFORE),
      fixtureSlot(3, "take", "secondary-1", BEFORE, keys.secondary),
      fixtureSlot(4, "release", "primary-2", at(2)),
      fixtureSlot(5, "take", "primary-2", at(3)),
    ],
  },
  ...patch,
});

/** Synthetic counts from #1875; no live board data is needed. */
export const crpkoShape = (): RollupInput => {
  const cuts = Array.from({ length: 4_833 }, (_, i) => at((24 * (i + 1)) / 4_834));
  cuts[0] = at(6);
  cuts[1] = at(9);
  cuts[2] = at(18);
  cuts.sort();
  const point = (i: number) => cuts[i % cuts.length]!;
  const cards = Array.from({ length: 4_728 }, (_, i) => {
    if (i >= 1_335)
      return fixtureCard(`history-${i}`, {
        number: i + 1,
        stage: "verified",
        settledAt: BEFORE,
      });
    let patch: Partial<KanbanCard> = {};
    switch (i % 12) {
      case 1:
        patch = {
          models: [
            { model: models.secondary, weight: 1 },
            { model: models.primary, weight: 3 },
            { model: models.disabled, weight: 10 },
          ],
        };
        break;
      case 2:
        patch = {
          models: [
            { model: models.primary, weight: 4 },
            { model: models.free, weight: 1 },
          ],
        };
        break;
      case 3:
        patch = {
          stalled: { at: point(700 + i), reason: "Run failed: test", by: { _tag: "owner" } },
        };
        break;
      case 4:
        patch = { wait: fixtureWait(point(1_200 + i), point(2_400 + i)) };
        break;
      case 5:
        patch = { asks: [fixtureAsk(`ask-${i}`, point(500 + i), point(2_000 + i))] };
        break;
      case 6:
        patch = { blockedBy: [KanbanCardId.make(`history-${1_335 + (i % 24)}`)] };
        break;
      case 7:
        patch = { workThreadId: ThreadId.make("primary-1") };
        break;
      case 8:
        patch = { asks: [fixtureAsk(`open-${i}`, point(800 + i), null)] };
        break;
      case 9:
        patch = { blockedBy: [KanbanCardId.make("missing")] };
        break;
      case 10:
        patch = { priority: 5 };
        break;
    }
    return fixtureCard(`queue-${i}`, { number: i + 1, ...patch });
  });
  const events = cuts.map((when, i) => fixtureEvent(10_000 + i, `queue-${i % 1_335}`, when));
  const prior: KanbanCardEvent[] = [];
  for (let i = 0; i < 24; i++) {
    const index = 1_335 + i;
    const settledAt = point(1_800 + i * 40);
    cards[index] = fixtureCard(`history-${index}`, {
      number: index + 1,
      stage: "verified",
      settledAt,
      movedAt: settledAt,
    });
    prior.push(fixtureEvent(i + 1, cards[index]!.id, BEFORE, "moved", { toStage: "working" }));
    events.push(
      fixtureEvent(20_000 + i, cards[index]!.id, settledAt, "moved", {
        fromStage: "working",
        toStage: "verified",
      }),
    );
  }
  // A shared-thread chain and cycle exercise transitive blocker reconstruction.
  const shared = ThreadId.make("detached-chain");
  cards[0] = { ...cards[0]!, workThreadId: shared, blockedBy: [cards[12]!.id] };
  cards[12] = { ...cards[12]!, workThreadId: shared, blockedBy: [cards[1_335]!.id] };
  cards[24] = { ...cards[24]!, workThreadId: shared, blockedBy: [cards[36]!.id] };
  cards[36] = { ...cards[36]!, workThreadId: shared, blockedBy: [cards[24]!.id] };
  // Paired markers share existing cuts, keeping the readiness boundary count exact.
  for (let i = 0; i < 600; i++) {
    const id = `queue-${i}`;
    const kind = i % 2 === 0 ? "flagged" : "wait_set";
    events.push(
      fixtureEvent(30_000 + i * 2, id, point(900 + i), kind, {
        body: kind === "flagged" ? "Run failed: test" : "Waiting for CI",
      }),
    );
    events.push(
      fixtureEvent(
        30_001 + i * 2,
        id,
        point(2_800 + i),
        kind === "flagged" ? "flagged" : "wait_cleared",
        {
          body: kind === "flagged" ? "Cleared" : "Wait ended: clear",
        },
      ),
    );
  }
  while (events.length < 6_224) {
    const i = events.length;
    events.push(fixtureEvent(40_000 + i, `queue-${i % 1_335}`, point(i)));
  }
  const readinessBefore = Array.from({ length: 5_465 }, (_, i) =>
    fixtureEvent(100 + i, `queue-${i % 1_335}`, BEFORE, i % 3 === 0 ? "wait_cleared" : "flagged", {
      body: i % 3 === 0 ? "Wait ended: clear" : "Cleared",
    }),
  );
  return fixtureInput({
    window: { since: SINCE, until: at(24) },
    cards,
    events: events.toSorted((a, b) => a.id - b.id),
    readinessBefore,
    prior,
    slotHistory: {
      recordedSince: BEFORE,
      events: [
        fixtureSlot(1, "take", "primary-1", BEFORE),
        fixtureSlot(2, "take", "primary-2", BEFORE),
        fixtureSlot(3, "take", "secondary-1", BEFORE, keys.secondary),
        fixtureSlot(4, "release", "primary-2", at(6)),
        fixtureSlot(5, "take", "primary-2", at(9)),
        fixtureSlot(6, "release", "primary-2", at(18)),
        fixtureSlot(7, "release", "secondary-1", at(18), keys.secondary),
      ],
    },
  });
};

export const readinessBoundaryCount = (input: RollupInput) => {
  const since = time(input.window.since);
  const until = time(input.window.until);
  const cuts = new Set([since, until]);
  const add = (at: string | null | undefined) => {
    if (at != null && time(at) > since && time(at) < until) cuts.add(time(at));
  };
  for (const event of input.events) add(event.at);
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
    ])
      add(at);
    const retry = kanbanRetryNotBefore(card);
    if (retry !== null) add(isoOf(retry));
    if (card.deciding !== undefined) add(isoOf(time(card.deciding.since) + KANBAN_DECIDE_MS));
  }
  return cuts.size;
};
