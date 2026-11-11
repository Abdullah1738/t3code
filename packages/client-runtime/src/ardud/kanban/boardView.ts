import {
  KANBAN_BACKLOG,
  KANBAN_DECIDE_MS,
  KANBAN_DONE_STAGES,
  KANBAN_RETRY_BACKOFF_MS,
  KANBAN_WAIT_LIMIT_MS,
  kanbanCardNeedsOwner,
  kanbanHeldUpBy,
  kanbanOpenAsks,
  kanbanSchedule,
  kanbanScriptStep,
  kanbanWaitsOnEvaluator,
  type KanbanCard,
  type KanbanGoal,
  type KanbanSchedule,
  type KanbanStage,
  type KanbanThreadState,
} from "@t3tools/contracts";

import type { KanbanBoardState } from "./boardState.ts";
import { TRUTH_IDLE_STUCK_MS, TRUTH_QUIET_MS } from "./cardTruth.ts";
import {
  ACTIVE_STAGES,
  SHIPPED_STAGES,
  STAGE_LABELS,
  modelLetter,
  modelName,
  type BoardFilter,
  type CardFlag,
  type CardSteps,
  type GoalProgress,
  type GoalSummary,
  type GroupBy,
} from "./viewModel.ts";

/**
 * What a board tile shows. Everything on it is plain data derived from the card
 * and the few things around it the card depends on, so two views of an unchanged
 * card are the same object and a memoized tile skips its render. Ages are not in
 * it: the tile counts them from the stamps against the shared clock.
 */
export interface BoardTileView {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly stage: KanbanStage;
  readonly stageLabel: string;
  readonly priority: number;
  readonly settled: boolean;
  /** When it entered its stage; the tile's age counts from here. */
  readonly movedAt: string;
  readonly flag: CardFlag | null;
  /** Set with a stalled flag: the tile shows how long ago. */
  readonly flagSince: string | null;
  readonly goal: { readonly id: string; readonly name: string } | null;
  readonly pr: {
    readonly label: string;
    readonly url: string;
    readonly state: string | null;
  } | null;
  readonly model: { readonly name: string; readonly letter: string };
  readonly running: boolean;
  readonly needsInput: boolean;
  readonly unread: number;
  readonly subtasks: { readonly done: number; readonly total: number } | null;
}

export interface BoardCardRow {
  readonly kind: "card";
  readonly key: string;
  readonly card: BoardTileView;
}

/** A heading inside a lane: a stage inside Shipped. */
export interface BoardHeadRow {
  readonly kind: "head";
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

export type BoardRow = BoardCardRow | BoardHeadRow;

/** One column's worth of rows, top to bottom. */
export interface BoardLane {
  readonly key: string;
  readonly label: string;
  readonly summary: string | null;
  /** Cards in the lane. */
  readonly count: number;
  readonly rows: ReadonlyArray<BoardRow>;
}

export interface BoardModel {
  /** Cards passing the filter. */
  readonly total: number;
  /** To-Do, Working, Needs Review, In Review. Empty unless grouped by stage. */
  readonly active: ReadonlyArray<BoardLane>;
  /** Completed, Deployed, Verified. */
  readonly shipped: ReadonlyArray<BoardLane>;
  /** The three shipped stages as one lane, each under its heading. */
  readonly shippedRows: ReadonlyArray<BoardRow>;
  /** Cards held in Needs Owner, then cards with an ask he can answer now. `count` leaves out held cards whose asks wait on someone else. */
  readonly owner: BoardLane;
  /** Columns of every grouping but Stage. */
  readonly groups: ReadonlyArray<BoardLane>;
  readonly goals: ReadonlyArray<GoalSummary>;
}

export interface BoardViewParams {
  readonly filter: BoardFilter;
  readonly group: GroupBy;
}

export interface BoardViewEngine {
  /**
   * The board as its columns show it. Cached: the same state, parameters and a
   * clock that has not crossed any card's next threshold return the same object,
   * and after a change every lane, row and tile view that came out equal is the
   * object it was before.
   */
  readonly model: (state: KanbanBoardState, nowMs: number, params: BoardViewParams) => BoardModel;
  /** Per-card views built since the engine was made; for tests and measurements. */
  readonly computed: () => number;
}

/** Plain-data equality: primitives, arrays and objects of them. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (!same(a[index], b[index])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) if (!same(left[key], right[key])) return false;
  return true;
}

const sameItems = <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) => {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
};

/**
 * How long after one of a card's stamps something about it can change with no
 * change from the server: a retry's backoff ends, a thread counts as quiet, an
 * evaluator's time to decide runs out, a wait passes its limit, a card nothing
 * runs counts as stuck.
 */
const THRESHOLD_OFFSETS: ReadonlyArray<number> = [
  ...new Set([
    0,
    KANBAN_RETRY_BACKOFF_MS,
    TRUTH_QUIET_MS,
    KANBAN_DECIDE_MS,
    TRUTH_IDLE_STUCK_MS,
    ...Object.values(KANBAN_WAIT_LIMIT_MS).filter((limit): limit is number => limit !== null),
  ]),
];

/**
 * The next moment the clock alone changes what a card shows: the earliest
 * stamp-plus-offset still ahead of `nowMs`. Wider than strictly needed (not every
 * stamp meets every offset), never narrower.
 */
export function nextCardThresholdMs(
  card: KanbanCard,
  thread: KanbanThreadState | undefined,
  nowMs: number,
): number {
  let next = Number.POSITIVE_INFINITY;
  const consider = (iso: string | null | undefined) => {
    if (iso === null || iso === undefined) return;
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return;
    for (const offset of THRESHOLD_OFFSETS) {
      const when = at + offset;
      if (when > nowMs && when < next) next = when;
    }
  };
  consider(card.movedAt);
  consider(card.stalled?.at);
  consider(card.wait?.at);
  consider(card.wait?.until);
  consider(card.deciding?.since);
  for (const retry of card.retries ?? []) consider(retry.at);
  consider(thread?.lastActivityAt);
  for (const ask of card.asks) {
    if (ask.closedAt !== null) continue;
    consider(ask.expiresAt);
    consider(ask.snoozedUntil);
  }
  return next;
}

function prLabel(url: string, label: string | null): string {
  if (label) return label;
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? `#${match[1]}` : "PR";
}

/** The unfinished-or-not cards a card's view reads: its blockers, and theirs along its own work thread. */
function blockerIds(card: KanbanCard, cards: ReadonlyMap<string, KanbanCard>): string[] {
  const ids: string[] = [];
  if (card.blockedBy.length === 0 && card.wait?.card == null) return ids;
  const seen = new Set<string>([card.id]);
  const walk = (waiter: KanbanCard) => {
    for (const id of waiter.blockedBy) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      const blocker = cards.get(id);
      // kanbanHeldUpBy follows a blocker on the same work thread into its own blockers.
      if (
        blocker !== undefined &&
        card.workThreadId !== null &&
        blocker.workThreadId === card.workThreadId
      ) {
        walk(blocker);
      }
    }
  };
  walk(card);
  const target = card.wait?.card;
  if (target != null && !seen.has(target)) ids.push(target);
  return ids;
}

interface Entry {
  card: KanbanCard;
  /** The clock the view was built at, and until when it holds with nothing else changing. */
  at: number;
  validUntil: number;
  boardKey: string;
  thread: KanbanThreadState | undefined;
  goal: KanbanGoal | undefined;
  unread: number;
  depIds: ReadonlyArray<string>;
  deps: ReadonlyArray<KanbanCard | undefined>;
  view: BoardTileView;
  row: BoardCardRow;
  /** Ordering inputs that are not shown. */
  waits: boolean;
  needsOwner: boolean;
  firstAskAt: string;
}

/** What of the board itself a card's view reads. */
const boardKeyOf = (state: KanbanBoardState): string =>
  JSON.stringify([
    state.board.setup?.status ?? null,
    state.board.defaultReviewChain ?? null,
    (state.board.reviewChains ?? []).map((chain) => [chain.name, chain.steps.length]),
    state.board.pause?.keep ?? null,
  ]);

const filterKeyOf = (params: BoardViewParams): string =>
  JSON.stringify([
    params.group,
    params.filter.priorities ?? [],
    params.filter.goalIds ?? [],
    params.filter.projects ?? [],
    params.filter.models ?? [],
    params.filter.query ?? "",
    params.filter.settled ?? "hide",
  ]);

const GROUP_STAGE_ORDER = new Map<KanbanStage, number>(
  (
    [
      "needs_owner",
      "working",
      "in_review",
      "needs_review",
      "todo",
      "completed",
      "deployed",
      "verified",
    ] as const
  ).map((stage, index) => [stage, index]),
);

/** The schedule's clock only moves waiting cards up a step every few days: an hour is fine. */
const SCHEDULE_CLOCK_MS = 60 * 60 * 1000;

export function createBoardView(): BoardViewEngine {
  const entries = new Map<string, Entry>();
  const heads = new Map<string, BoardHeadRow>();
  const texts = new WeakMap<KanbanCard, string>();
  let computed = 0;

  let scheduleCards: ReadonlyMap<string, KanbanCard> | null = null;
  let scheduleBucket = -1;
  let schedule: ReadonlyMap<string, KanbanSchedule> = new Map();

  let boardRef: KanbanBoardState["board"] | null = null;
  let boardKey = "";

  let last: {
    state: KanbanBoardState;
    filterKey: string;
    at: number;
    validUntil: number;
    model: BoardModel;
  } | null = null;

  const entryFor = (card: KanbanCard, state: KanbanBoardState, nowMs: number): Entry => {
    const thread =
      card.activeThreadId === null ? undefined : state.threads.get(card.activeThreadId);
    const goal = card.goalId === null ? undefined : state.goals.get(card.goalId);
    const unread = card.discussionId === null ? 0 : (state.unread.get(card.discussionId) ?? 0);
    const known = entries.get(card.id);
    if (
      known !== undefined &&
      known.card === card &&
      known.boardKey === boardKey &&
      known.thread === thread &&
      known.goal === goal &&
      known.unread === unread &&
      nowMs >= known.at &&
      nowMs < known.validUntil
    ) {
      let fresh = true;
      for (let index = 0; index < known.depIds.length; index += 1) {
        if (state.cards.get(known.depIds[index]!) !== known.deps[index]) {
          fresh = false;
          break;
        }
      }
      if (fresh) return known;
    }

    computed += 1;
    const done = KANBAN_DONE_STAGES.has(card.stage);
    const blocker = done ? undefined : kanbanHeldUpBy(card, state.cards);
    const waitsOnEvaluator = kanbanWaitsOnEvaluator(card);
    const asks = card.settledAt === null ? kanbanOpenAsks(card) : [];
    const openAsk = asks.at(-1);
    const setupHolds =
      state.board.setup?.status === "running" &&
      card.settledAt === null &&
      card.activeThreadId === null &&
      card.stalled === null &&
      card.priority !== KANBAN_BACKLOG &&
      (card.stage === "todo" || card.stage === "needs_review");

    let flag: CardFlag | null = null;
    if (card.stalled !== null) {
      flag = { kind: "stalled", label: "Stalled" };
    } else if (card.stage === "needs_owner" && card.question) {
      flag = { kind: "ask", label: card.question, blocking: true };
    } else if (openAsk !== undefined) {
      const more = asks.length > 1 ? ` (+${asks.length - 1})` : "";
      flag = { kind: "ask", label: `${openAsk.text}${more}`, blocking: openAsk.blocking };
    } else if (card.priority === KANBAN_BACKLOG && !done) {
      flag = { kind: "blocked", label: "In the backlog" };
    } else if (setupHolds) {
      flag = { kind: "blocked", label: "Setup is running" };
    } else if (blocker !== undefined) {
      flag = {
        kind: "blocked",
        label:
          blocker.stage === "completed"
            ? `Waits for #${blocker.number} to be merged`
            : `After #${blocker.number}`,
      };
    } else if (waitsOnEvaluator) {
      flag = {
        kind: "blocked",
        label: kanbanScriptStep(card) ? "Waits on a script" : "Waits on the evaluator",
      };
    }

    const pr = card.links.find((link) => link.kind === "pr");
    const finished = card.subtasks.filter((subtask) => subtask.state !== "open").length;
    const view: BoardTileView = {
      id: card.id,
      number: card.number,
      title: card.title,
      stage: card.stage,
      stageLabel: STAGE_LABELS[card.stage],
      priority: card.priority,
      settled: card.settledAt !== null,
      movedAt: card.movedAt,
      flag,
      flagSince: card.stalled?.at ?? null,
      goal: goal ? { id: goal.id, name: goal.name } : null,
      pr: pr ? { label: prLabel(pr.url, pr.label), url: pr.url, state: pr.state } : null,
      model: { name: modelName(card.model), letter: modelLetter(card.model) },
      running: thread?.running ?? false,
      needsInput: thread?.needsInput ?? false,
      unread,
      subtasks: card.subtasks.length === 0 ? null : { done: finished, total: card.subtasks.length },
    };
    // A card the server sent again unchanged, or one whose surroundings changed in a
    // way it doesn't show, keeps the view (and the row) it had: its tile doesn't render.
    const kept = known !== undefined && same(known.view, view) ? known : undefined;
    const depIds = blockerIds(card, state.cards);
    const entry: Entry = {
      card,
      at: nowMs,
      validUntil: nextCardThresholdMs(card, thread, nowMs),
      boardKey,
      thread,
      goal,
      unread,
      depIds,
      deps: depIds.map((id) => state.cards.get(id)),
      view: kept?.view ?? view,
      row: kept?.row ?? { kind: "card", key: card.id, card: view },
      // Like the dispatcher: backlog and the evaluator's steps never start, and a
      // blocker on the card's own work thread doesn't count while that thread can go on.
      waits:
        card.stalled !== null ||
        card.priority === KANBAN_BACKLOG ||
        waitsOnEvaluator ||
        (done ? kanbanHeldUpBy(card, state.cards) : blocker) !== undefined,
      needsOwner: kanbanCardNeedsOwner(card, nowMs),
      firstAskAt: kanbanOpenAsks(card)[0]?.at ?? card.movedAt,
    };
    entries.set(card.id, entry);
    return entry;
  };

  const head = (key: string, label: string, count: number): BoardHeadRow => {
    const known = heads.get(key);
    if (known !== undefined && known.label === label && known.count === count) return known;
    const row: BoardHeadRow = { kind: "head", key, label, count };
    heads.set(key, row);
    return row;
  };

  const textOf = (card: KanbanCard): string => {
    let text = texts.get(card);
    if (text === undefined) {
      text = cardSearchText(card);
      texts.set(card, text);
    }
    return text;
  };

  const build = (
    state: KanbanBoardState,
    nowMs: number,
    params: BoardViewParams,
    previous: BoardModel | null,
  ): { model: BoardModel; validUntil: number } => {
    if (state.board !== boardRef) {
      boardRef = state.board;
      boardKey = boardKeyOf(state);
    }
    const bucket = Math.floor(nowMs / SCHEDULE_CLOCK_MS);
    if (state.cards !== scheduleCards || bucket !== scheduleBucket) {
      scheduleCards = state.cards;
      scheduleBucket = bucket;
      schedule = kanbanSchedule([...state.cards.values()], { nowMs: bucket * SCHEDULE_CLOCK_MS });
    }
    if (entries.size > state.cards.size) {
      for (const id of entries.keys()) if (!state.cards.has(id)) entries.delete(id);
    }

    const { filter } = params;
    const settled = filter.settled ?? "hide";
    const query = prepareQuery(filter.query ?? "");
    let validUntil = (bucket + 1) * SCHEDULE_CLOCK_MS;
    const visible: Entry[] = [];
    const goalCounts = new Map<string, { progress: Progress; needsOwner: number }>();
    for (const card of state.cards.values()) {
      const isSettled = card.settledAt !== null;
      const shown =
        !(settled === "hide" && isSettled) &&
        !(settled === "only" && !isSettled) &&
        matchesFacets(card, filter) &&
        (query === null || queryMatches(query, card, textOf(card)));
      // An open card keeps its view warm whatever the filter: goals count it, and a
      // cleared search shows it again without building anything.
      const entry = shown || !isSettled ? entryFor(card, state, nowMs) : null;
      if (entry !== null && entry.validUntil < validUntil) validUntil = entry.validUntil;
      if (card.goalId !== null) {
        let counts = goalCounts.get(card.goalId);
        if (counts === undefined) {
          counts = { progress: { verified: 0, shipped: 0, active: 0, todo: 0 }, needsOwner: 0 };
          goalCounts.set(card.goalId, counts);
        }
        if (card.stage === "verified") counts.progress.verified += 1;
        else if (KANBAN_DONE_STAGES.has(card.stage)) counts.progress.shipped += 1;
        else if (card.stage === "todo") counts.progress.todo += 1;
        else counts.progress.active += 1;
        if (entry?.needsOwner) counts.needsOwner += 1;
      }
      if (shown && entry !== null) visible.push(entry);
    }

    const rankOf = (entry: Entry) => schedule.get(entry.card.id)?.rank ?? entry.card.priority;
    const holdsOf = (entry: Entry) => schedule.get(entry.card.id)?.holds ?? 0;
    const byPick = (a: Entry, b: Entry) =>
      rankOf(a) - rankOf(b) ||
      holdsOf(b) - holdsOf(a) ||
      a.card.movedAt.localeCompare(b.card.movedAt) ||
      a.card.number - b.card.number;
    const oldestFirst = (a: Entry, b: Entry) =>
      a.card.movedAt.localeCompare(b.card.movedAt) || a.card.number - b.card.number;
    const newestFirst = (a: Entry, b: Entry) =>
      b.card.movedAt.localeCompare(a.card.movedAt) || b.card.number - a.card.number;
    // To-Do goes the way the dispatcher takes it: cards it can start, in pick order,
    // then the blocked and stalled ones it skips, so the top card goes next.
    const todoOrder = (a: Entry, b: Entry) => Number(a.waits) - Number(b.waits) || byPick(a, b);
    const orderFor = (stage: KanbanStage) =>
      stage === "todo" ? todoOrder : stage === "needs_review" ? oldestFirst : byPick;

    const lane = (
      key: string,
      label: string,
      summary: string | null,
      list: ReadonlyArray<Entry>,
      count: number,
      before: BoardLane | undefined,
    ): BoardLane => {
      const rows = list.map((entry) => entry.row);
      if (
        before !== undefined &&
        before.key === key &&
        before.label === label &&
        before.summary === summary &&
        before.count === count &&
        sameItems(before.rows, rows)
      ) {
        return before;
      }
      return { key, label, summary, count, rows };
    };
    const keepList = <T>(before: ReadonlyArray<T> | undefined, next: ReadonlyArray<T>) =>
      before !== undefined && sameItems(before, next) ? before : next;

    let active: ReadonlyArray<BoardLane> = keepList(previous?.active, []);
    let shipped: ReadonlyArray<BoardLane> = keepList(previous?.shipped, []);
    let shippedRows: ReadonlyArray<BoardRow> = keepList(previous?.shippedRows, []);
    let groups: ReadonlyArray<BoardLane> = keepList(previous?.groups, []);
    const byStage = new Map<KanbanStage, Entry[]>();
    for (const entry of visible) {
      const list = byStage.get(entry.card.stage);
      if (list === undefined) byStage.set(entry.card.stage, [entry]);
      else list.push(entry);
    }
    const stageLane = (
      stage: KanbanStage,
      order: (a: Entry, b: Entry) => number,
      before: ReadonlyArray<BoardLane> | undefined,
    ) => {
      const list = (byStage.get(stage) ?? []).sort(order);
      return lane(
        stage,
        STAGE_LABELS[stage],
        null,
        list,
        list.length,
        before?.find((entry) => entry.key === stage),
      );
    };

    // Held cards first, then cards whose open asks don't block them.
    const held = (byStage.get("needs_owner") ?? []).slice().sort(byPick);
    const asking = visible
      .filter((entry) => entry.card.stage !== "needs_owner" && entry.needsOwner)
      .sort((a, b) => a.firstAskAt.localeCompare(b.firstAskAt) || a.card.number - b.card.number);
    const owner = lane(
      "needs_owner",
      STAGE_LABELS.needs_owner,
      null,
      [...held, ...asking],
      asking.length + held.filter((entry) => entry.needsOwner).length,
      previous?.owner,
    );

    if (params.group === "stage") {
      active = keepList(
        previous?.active,
        ACTIVE_STAGES.map((stage) => stageLane(stage, orderFor(stage), previous?.active)),
      );
      shipped = keepList(
        previous?.shipped,
        SHIPPED_STAGES.map((stage) => stageLane(stage, newestFirst, previous?.shipped)),
      );
      shippedRows = keepList(
        previous?.shippedRows,
        shipped.flatMap((entry) => [
          head(`head:${entry.key}`, entry.label, entry.count),
          ...entry.rows,
        ]),
      );
    } else {
      const order = (a: Entry, b: Entry) =>
        (GROUP_STAGE_ORDER.get(a.card.stage) ?? 0) - (GROUP_STAGE_ORDER.get(b.card.stage) ?? 0) ||
        orderFor(a.card.stage)(a, b);
      const before = new Map(previous?.groups.map((entry) => [entry.key, entry]));
      const made: BoardLane[] = [];
      const add = (key: string, label: string, summary: string | null, list: Entry[]) => {
        list.sort(order);
        made.push(lane(key, label, summary, list, list.length, before.get(key)));
      };
      if (params.group === "similar") {
        const shown = new Map(visible.map((entry) => [entry.card.id as string, entry]));
        const placed = new Set<string>();
        for (const group of state.groups) {
          const members = group.cardIds.flatMap((id) => {
            const entry = shown.get(id);
            return entry ? [entry] : [];
          });
          if (members.length === 0) continue;
          for (const entry of members) placed.add(entry.card.id);
          add(group.id, group.name, group.summary, members);
        }
        const rest = visible.filter((entry) => !placed.has(entry.card.id));
        if (rest.length > 0) add("", "Ungrouped", null, rest);
      } else {
        const buckets = new Map<string, { label: string; list: Entry[] }>();
        const put = (key: string, label: string, entry: Entry) => {
          const bucket = buckets.get(key);
          if (bucket === undefined) buckets.set(key, { label, list: [entry] });
          else bucket.list.push(entry);
        };
        for (const entry of visible) {
          const card = entry.card;
          if (params.group === "goal") {
            const goal = card.goalId === null ? undefined : state.goals.get(card.goalId);
            put(goal?.id ?? "", goal?.name ?? "No goal", entry);
          } else if (params.group === "project") {
            if (card.projects.length === 0) put("", "No project", entry);
            for (const project of card.projects) put(project, project, entry);
          } else {
            const name = modelName(card.model);
            put(name, name, entry);
          }
        }
        const sorted = [...buckets.entries()].sort(([a, left], [b, right]) => {
          // The empty key ("No goal") goes last; the rest by size, then name.
          if (a === "" || b === "") return a === "" ? (b === "" ? 0 : 1) : -1;
          return right.list.length - left.list.length || left.label.localeCompare(right.label);
        });
        for (const [key, bucket] of sorted) add(key, bucket.label, null, bucket.list);
      }
      groups = keepList(previous?.groups, made);
    }

    const goalList: GoalSummary[] = [...state.goals.values()]
      .filter((goal) => goal.status === "active")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((goal) => {
        const counts = goalCounts.get(goal.id);
        const progress = counts?.progress ?? { verified: 0, shipped: 0, active: 0, todo: 0 };
        const summary: GoalSummary = {
          goal,
          progress: {
            ...progress,
            total: progress.verified + progress.shipped + progress.active + progress.todo,
          } satisfies GoalProgress,
          needsOwner: counts?.needsOwner ?? 0,
        };
        const before = previous?.goals.find((entry) => entry.goal === goal);
        return before !== undefined &&
          before.needsOwner === summary.needsOwner &&
          same(before.progress, summary.progress)
          ? before
          : summary;
      });
    const goals = keepList(previous?.goals, goalList);

    const model: BoardModel =
      previous !== null &&
      previous.total === visible.length &&
      previous.active === active &&
      previous.shipped === shipped &&
      previous.shippedRows === shippedRows &&
      previous.owner === owner &&
      previous.groups === groups &&
      previous.goals === goals
        ? previous
        : { total: visible.length, active, shipped, shippedRows, owner, groups, goals };
    return { model, validUntil };
  };

  return {
    model(state, nowMs, params) {
      const filterKey = filterKeyOf(params);
      if (
        last !== null &&
        last.state === state &&
        last.filterKey === filterKey &&
        nowMs >= last.at &&
        nowMs < last.validUntil
      ) {
        return last.model;
      }
      const built = build(state, nowMs, params, last?.model ?? null);
      last = { state, filterKey, at: nowMs, validUntil: built.validUntil, model: built.model };
      return built.model;
    },
    computed: () => computed,
  };
}

interface Progress {
  verified: number;
  shipped: number;
  active: number;
  todo: number;
}

/** Whether a card passes the facet narrowing (not the query or settled). */
function matchesFacets(card: KanbanCard, filter: BoardFilter): boolean {
  if (filter.priorities?.length && !filter.priorities.includes(card.priority)) return false;
  if (filter.goalIds?.length && !filter.goalIds.includes(card.goalId ?? "")) return false;
  if (filter.projects?.length) {
    const names = card.projects.length === 0 ? [""] : card.projects;
    if (!names.some((name) => filter.projects?.includes(name))) return false;
  }
  if (filter.models?.length && !filter.models.includes(modelName(card.model))) return false;
  return true;
}

/** Everything of a card a search reads, lower-cased once per card. */
export function cardSearchText(card: KanbanCard): string {
  return [
    `#${card.number}`,
    card.title,
    card.description,
    card.prompt,
    ...card.links.flatMap((link) => [link.label ?? "", link.url]),
  ]
    .join("\n")
    .toLowerCase();
}

interface PreparedQuery {
  readonly words: ReadonlyArray<string>;
  /** Set for a lone "12" or "#12": also finds cards whose number starts with it. */
  readonly number: string | null;
}

function prepareQuery(query: string): PreparedQuery | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  return {
    words: needle.split(/\s+/),
    number: /^#?\d+$/.test(needle) ? needle.replace(/^#/, "") : null,
  };
}

function queryMatches(query: PreparedQuery, card: KanbanCard, text: string): boolean {
  if (query.number !== null && String(card.number).startsWith(query.number)) return true;
  return query.words.every((word) => text.includes(word));
}

/**
 * Neighbours of a card in the lane it sits in, as the board shows it. A card in
 * several lanes steps through the first that holds it.
 */
export function boardSteps(model: BoardModel, group: GroupBy, cardId: string): CardSteps {
  const idsOf = (lane: BoardLane) =>
    lane.rows.flatMap((row) => (row.kind === "card" ? [row.card] : []));
  let lanes: ReadonlyArray<ReadonlyArray<BoardTileView>>;
  let afterSettle: string | null = null;
  if (group === "stage") {
    lanes = [...model.active, ...model.shipped, model.owner].map(idsOf);
    const verified = model.shipped.find((lane) => lane.key === "verified");
    const open = (verified ? idsOf(verified) : []).filter((card) => !card.settled);
    const openAt = open.findIndex((card) => card.id === cardId);
    afterSettle =
      openAt >= 0 ? (open[openAt + 1]?.id ?? open[openAt - 1]?.id ?? null) : (open[0]?.id ?? null);
  } else {
    lanes = model.groups.map(idsOf);
  }
  const lane = lanes.find((cards) => cards.some((card) => card.id === cardId)) ?? [];
  const index = lane.findIndex((card) => card.id === cardId);
  const at = (i: number) => (index >= 0 && i >= 0 && i < lane.length ? lane[i]!.id : null);
  return { previous: at(index - 1), next: at(index + 1), afterSettle };
}
