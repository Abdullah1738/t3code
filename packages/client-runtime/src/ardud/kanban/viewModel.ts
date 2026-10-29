import {
  KANBAN_BACKLOG,
  KANBAN_DONE_STAGES,
  kanbanHeldUpBy,
  kanbanNeedsOwner,
  kanbanOpenAsks,
  kanbanOpenStep,
  kanbanPickOrder,
  kanbanWaitsOnEvaluator,
  type KanbanActor,
  type KanbanAnswer,
  type KanbanBlock,
  type KanbanBoard,
  type KanbanCard,
  type KanbanDiscussion,
  type KanbanGoal,
  type KanbanMessage,
  type KanbanStage,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { ageView } from "../common/time.ts";
import type { KanbanBoardState } from "./boardState.ts";
import { linkLabels } from "./links.ts";

export const STAGE_LABELS: Record<KanbanStage, string> = {
  todo: "To-Do",
  working: "Working",
  needs_review: "Needs Review",
  in_review: "In Review",
  completed: "Completed",
  deployed: "Deployed",
  verified: "Verified",
  needs_owner: "Needs Owner",
};

export const ACTIVE_STAGES = ["todo", "working", "needs_review", "in_review"] as const;
export const SHIPPED_STAGES = ["completed", "deployed", "verified"] as const;

export const isDoneStage = (stage: KanbanStage) => KANBAN_DONE_STAGES.has(stage);

/** "Opus", "Haiku", "Sol", "Astra", or the bare model id. */
export function modelName(model: ModelSelection | null): string {
  if (model === null) return "";
  const id = model.model.split("/").at(-1) ?? model.model;
  for (const [needle, name] of [
    ["haiku", "Haiku"],
    ["opus", "Opus"],
    ["sonnet", "Sonnet"],
    ["sol", "Sol"],
    ["astra", "Astra"],
  ] as const) {
    if (id.includes(needle)) return name;
  }
  return id;
}

export function modelVariant(model: ModelSelection | null): string | null {
  const options = Array.isArray(model?.options) ? model.options : [];
  const variant = options.find((option) => option.id === "variant")?.value;
  return typeof variant === "string" ? variant : null;
}

export const modelLetter = (model: ModelSelection | null) =>
  modelName(model).charAt(0).toUpperCase();

/**
 * The composer picker's value (instance, model, effort/variant) as the board's
 * ModelSelection. The board stores the variant as an option named "variant".
 */
export function boardModelSelection(input: {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly variant?: string | null | undefined;
}): ModelSelection {
  const { instanceId, model, variant } = input;
  return variant
    ? { instanceId, model, options: [{ id: "variant", value: variant }] }
    : { instanceId, model };
}

/**
 * Whether a pool's model is still in the composer's model list. Mirrors the
 * server rule in card #48: an instance missing from a non-empty list, disabled,
 * or not offering the slug is missing; null means unknown and must not be read as missing.
 */
export function poolListed(
  model: { readonly instanceId: ProviderInstanceId; readonly model: string },
  providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly enabled: boolean;
    readonly models: ReadonlyArray<{ readonly slug: string; readonly isCustom?: boolean }>;
  }>,
  settings: {
    readonly providerModelPreferences?:
      | Readonly<Record<string, { readonly hiddenModels: ReadonlyArray<string> } | undefined>>
      | null
      | undefined;
  },
): boolean | null {
  if (providers.length === 0) return null;
  const provider = providers.find((entry) => entry.instanceId === model.instanceId);
  if (!provider || !provider.enabled) return false;
  if (provider.models.length === 0) return null;
  const hidden = new Set(settings.providerModelPreferences?.[model.instanceId]?.hiddenModels ?? []);
  return provider.models.some(
    (entry) => entry.slug === model.model && (entry.isCustom === true || !hidden.has(entry.slug)),
  );
}

export type CardFlag =
  | { readonly kind: "stalled"; readonly label: string }
  | { readonly kind: "blocked"; readonly label: string }
  /** `blocking` false: an async ask; the card's work goes on. */
  | { readonly kind: "ask"; readonly label: string; readonly blocking: boolean };

export interface CardView {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly stage: KanbanStage;
  readonly stageLabel: string;
  readonly priority: number;
  readonly age: string;
  readonly flag: CardFlag | null;
  readonly goal: { readonly id: string; readonly name: string } | null;
  readonly pr: {
    readonly label: string;
    readonly url: string;
    readonly state: string | null;
  } | null;
  readonly model: { readonly name: string; readonly letter: string };
  readonly running: boolean;
  readonly unread: number;
  /** Subtasks done or skipped out of all, or null for a card with no plan. */
  readonly subtasks: { readonly done: number; readonly total: number } | null;
  readonly card: KanbanCard;
}

function prLabel(url: string, label: string | null): string {
  if (label) return label;
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? `#${match[1]}` : "PR";
}

/** The banner every board view shows while the board's first setup runs; null otherwise. */
export interface SetupBannerView {
  readonly discussionId: string;
  readonly label: string;
}

export function setupBanner(board: KanbanBoard): SetupBannerView | null {
  if (board.setup?.status !== "running") return null;
  return { discussionId: board.setup.discussionId, label: "Setup is ongoing · View setup" };
}

/**
 * A card the board's running setup holds: it would otherwise start (todo or
 * needs_review, not running, settled or backlog). Mirrors the waiting filter in
 * planDispatch, so a card that's already running doesn't claim it is waiting.
 */
function setupHolds(card: KanbanCard, board: KanbanBoard): boolean {
  if (board.setup?.status !== "running") return false;
  if (card.settledAt !== null || card.activeThreadId !== null) return false;
  if (card.stalled !== null || card.priority === KANBAN_BACKLOG) return false;
  return card.stage === "todo" || card.stage === "needs_review";
}

export function cardView(card: KanbanCard, state: KanbanBoardState, nowMs: number): CardView {
  const goal = card.goalId === null ? undefined : state.goals.get(card.goalId);
  const pr = card.links.find((link) => link.kind === "pr");
  const asks = card.settledAt === null ? kanbanOpenAsks(card) : [];
  const openAsk = asks.at(-1);
  let flag: CardFlag | null = null;
  if (card.stalled !== null) {
    const since = ageView(card.stalled.at, nowMs)?.label;
    flag = { kind: "stalled", label: since && since !== "now" ? `Stalled ${since}` : "Stalled" };
  } else if (card.stage === "needs_owner" && card.question) {
    flag = { kind: "ask", label: card.question, blocking: true };
  } else if (openAsk !== undefined) {
    const more = asks.length > 1 ? ` (+${asks.length - 1})` : "";
    flag = { kind: "ask", label: `${openAsk.text}${more}`, blocking: openAsk.blocking };
  } else if (card.priority === KANBAN_BACKLOG && !isDoneStage(card.stage)) {
    // Shown like a block: the card waits, here on the owner taking it out.
    flag = { kind: "blocked", label: "In the backlog" };
  } else if (setupHolds(card, state.board)) {
    // planDispatch starts no card work or review while a board's first setup runs.
    flag = { kind: "blocked", label: "Setup is running" };
  } else {
    const blocker = isDoneStage(card.stage) ? undefined : kanbanHeldUpBy(card, state.cards);
    if (blocker !== undefined) {
      flag = { kind: "blocked", label: `After #${blocker.number}` };
    } else if (kanbanWaitsOnEvaluator(card)) {
      flag = { kind: "blocked", label: "Waits on the evaluator" };
    }
  }
  const thread = card.activeThreadId === null ? undefined : state.threads.get(card.activeThreadId);
  const finished = card.subtasks.filter((subtask) => subtask.state !== "open").length;
  return {
    id: card.id,
    number: card.number,
    title: card.title,
    stage: card.stage,
    stageLabel: STAGE_LABELS[card.stage],
    priority: card.priority,
    age: ageView(card.movedAt, nowMs)?.label ?? "",
    flag,
    goal: goal ? { id: goal.id, name: goal.name } : null,
    pr: pr ? { label: prLabel(pr.url, pr.label), url: pr.url, state: pr.state } : null,
    model: { name: modelName(card.model), letter: modelLetter(card.model) },
    running: thread?.running ?? false,
    unread: card.discussionId === null ? 0 : (state.unread.get(card.discussionId) ?? 0),
    subtasks: card.subtasks.length === 0 ? null : { done: finished, total: card.subtasks.length },
    card,
  };
}

export interface AskView {
  readonly id: string;
  readonly text: string;
  readonly blocking: boolean;
  /** Who asked: Worker, Reviewer, Evaluator, Script, Owner. */
  readonly by: string;
  readonly age: string;
}

/** A card's open asks, oldest first. Blocking ones can't be made blocking again. */
export function askViews(card: KanbanCard, nowMs: number): ReadonlyArray<AskView> {
  if (card.settledAt !== null) return [];
  return kanbanOpenAsks(card).map((ask) => ({
    id: ask.id,
    text: ask.text,
    blocking: ask.blocking,
    by:
      ask.by._tag === "thread"
        ? "Worker"
        : ask.by._tag === "evaluator"
          ? "Evaluator"
          : ask.by._tag === "script"
            ? "Script"
            : ask.by._tag === "owner"
              ? "Owner"
              : "Board",
    age: ageView(ask.at, nowMs)?.label ?? "",
  }));
}

export const SUBTASK_OWNER_LABELS = {
  work: "Worker",
  review: "Reviewer",
  evaluator: "Evaluator",
} as const;

export interface SubtaskStepView {
  readonly step: number;
  /** Done or skipped steps are past; the open step is now; later steps wait. */
  readonly when: "past" | "now" | "later";
  readonly subtasks: KanbanCard["subtasks"];
}

/** A card's subtasks grouped by step, in order, with where the card is. */
export function subtaskSteps(card: Pick<KanbanCard, "subtasks">): ReadonlyArray<SubtaskStepView> {
  const current = kanbanOpenStep(card);
  const steps = new Map<number, Array<KanbanCard["subtasks"][number]>>();
  for (const subtask of card.subtasks) {
    const list = steps.get(subtask.step) ?? [];
    list.push(subtask);
    steps.set(subtask.step, list);
  }
  return [...steps]
    .sort(([a], [b]) => a - b)
    .map(([step, subtasks]) => ({
      step,
      when: current === null || step < current ? "past" : step === current ? "now" : "later",
      subtasks,
    }));
}

export type SettledFilter = "hide" | "only" | "include";

export interface BoardFilter {
  /** Empty or missing: no narrowing. Values within a facet match any (OR); facets all match (AND). */
  readonly priorities?: ReadonlyArray<number>;
  /** Goal ids; "" matches cards with no goal. */
  readonly goalIds?: ReadonlyArray<string>;
  /** Project names; "" matches cards in no project. */
  readonly projects?: ReadonlyArray<string>;
  /** modelName() values; "" matches cards with no model. */
  readonly models?: ReadonlyArray<string>;
  readonly query?: string;
  /** Settled cards: hidden by default. */
  readonly settled?: SettledFilter;
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

/**
 * Every word must appear in the card's number, title, description, prompt or
 * links, like the agents' card_search; a lone "12" or "#12" also finds cards
 * whose number starts with it.
 */
export function cardMatches(card: KanbanCard, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (/^#?\d+$/.test(needle) && String(card.number).startsWith(needle.replace(/^#/, ""))) {
    return true;
  }
  const text = [
    `#${card.number}`,
    card.title,
    card.description,
    card.prompt,
    ...card.links.flatMap((link) => [link.label ?? "", link.url]),
  ]
    .join("\n")
    .toLowerCase();
  return needle.split(/\s+/).every((word) => text.includes(word));
}

/** Cards on the board matching the filter; settled ones only when asked for. */
export function visibleCards(state: KanbanBoardState, filter: BoardFilter = {}): KanbanCard[] {
  const settled = filter.settled ?? "hide";
  const cards: KanbanCard[] = [];
  for (const card of state.cards.values()) {
    if (settled === "hide" && card.settledAt !== null) continue;
    if (settled === "only" && card.settledAt === null) continue;
    if (!matchesFacets(card, filter)) continue;
    if (filter.query && !cardMatches(card, filter.query)) continue;
    cards.push(card);
  }
  return cards;
}

type CardOrder = (a: KanbanCard, b: KanbanCard) => number;

const oldestFirst: CardOrder = (a, b) => a.movedAt.localeCompare(b.movedAt) || a.number - b.number;
// Like the dispatcher: backlog and the evaluator's steps never start, and a
// blocker on the card's own work thread doesn't count while that thread can go on.
const waitsToStart = (card: KanbanCard, state: KanbanBoardState) =>
  card.stalled !== null ||
  card.priority === KANBAN_BACKLOG ||
  kanbanWaitsOnEvaluator(card) ||
  kanbanHeldUpBy(card, state.cards) !== undefined;
/**
 * How each stage lists its cards, built once per board. To-Do goes the way the
 * dispatcher takes it: cards it can start, in pick order, then the blocked and
 * stalled ones it skips, so the top card goes next. Reviews start oldest first.
 */
const stageOrders = (state: KanbanBoardState) => {
  const byPick = kanbanPickOrder([...state.cards.values()]);
  const waits = new Map<string, boolean>();
  const waiting = (card: KanbanCard) => {
    let known = waits.get(card.id);
    if (known === undefined) {
      known = waitsToStart(card, state);
      waits.set(card.id, known);
    }
    return known;
  };
  const todo: CardOrder = (a, b) => Number(waiting(a)) - Number(waiting(b)) || byPick(a, b);
  return (stage: KanbanStage): CardOrder =>
    stage === "todo" ? todo : stage === "needs_review" ? oldestFirst : byPick;
};
const firstAskAt = (card: KanbanCard) => kanbanOpenAsks(card)[0]?.at ?? card.movedAt;
const oldestAskFirst = (a: KanbanCard, b: KanbanCard) =>
  firstAskAt(a).localeCompare(firstAskAt(b)) || a.number - b.number;
const newestFirst = (a: KanbanCard, b: KanbanCard) =>
  b.movedAt.localeCompare(a.movedAt) || b.number - a.number;

export interface StageColumn {
  readonly stage: KanbanStage;
  readonly label: string;
  readonly cards: ReadonlyArray<CardView>;
}

export interface StageBoard {
  readonly active: ReadonlyArray<StageColumn>;
  /** Completed, Deployed and Verified, stacked in one column. */
  readonly shipped: ReadonlyArray<StageColumn>;
  readonly owner: StageColumn;
  readonly total: number;
}

export function stageBoard(
  state: KanbanBoardState,
  nowMs: number,
  filter: BoardFilter = {},
): StageBoard {
  const cards = visibleCards(state, filter);
  const orderFor = stageOrders(state);
  const column = (stage: KanbanStage, order = orderFor(stage)): StageColumn => ({
    stage,
    label: STAGE_LABELS[stage],
    cards: cards
      .filter((card) => card.stage === stage)
      .sort(order)
      .map((card) => cardView(card, state, nowMs)),
  });
  return {
    active: ACTIVE_STAGES.map((stage) => column(stage)),
    shipped: SHIPPED_STAGES.map((stage) => column(stage, newestFirst)),
    // Waiting cards first, then cards whose open asks don't block them.
    owner: {
      stage: "needs_owner",
      label: STAGE_LABELS.needs_owner,
      cards: [
        ...column("needs_owner").cards,
        ...cards
          .filter((card) => card.stage !== "needs_owner" && kanbanNeedsOwner(card))
          .sort(oldestAskFirst)
          .map((card) => cardView(card, state, nowMs)),
      ],
    },
    total: cards.length,
  };
}

export type GroupBy = "stage" | "goal" | "similar" | "project" | "model";

export interface CardGroup {
  readonly key: string;
  readonly label: string;
  readonly summary: string | null;
  readonly cards: ReadonlyArray<CardView>;
}

const STAGE_ORDER = new Map<KanbanStage, number>(
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
const byStageThenPick = (state: KanbanBoardState): CardOrder => {
  const orderFor = stageOrders(state);
  return (a, b) =>
    (STAGE_ORDER.get(a.stage) ?? 0) - (STAGE_ORDER.get(b.stage) ?? 0) || orderFor(a.stage)(a, b);
};

/** Columns for every grouping but Stage. A card in several projects shows in each. */
export function groupCards(
  state: KanbanBoardState,
  by: Exclude<GroupBy, "stage">,
  nowMs: number,
  filter: BoardFilter = {},
): CardGroup[] {
  const cards = visibleCards(state, filter);
  const visible = new Map(cards.map((card) => [card.id, card]));
  const order = byStageThenPick(state);
  const view = (list: KanbanCard[]) => list.sort(order).map((card) => cardView(card, state, nowMs));

  if (by === "similar") {
    const placed = new Set<string>();
    const groups: CardGroup[] = [];
    for (const group of state.groups) {
      const members = group.cardIds.flatMap((id) => {
        const card = visible.get(id);
        return card ? [card] : [];
      });
      if (members.length === 0) continue;
      for (const card of members) placed.add(card.id);
      groups.push({
        key: group.id,
        label: group.name,
        summary: group.summary,
        cards: view(members),
      });
    }
    const rest = cards.filter((card) => !placed.has(card.id));
    if (rest.length > 0)
      groups.push({ key: "", label: "Ungrouped", summary: null, cards: view(rest) });
    return groups;
  }

  const buckets = new Map<string, { label: string; cards: KanbanCard[] }>();
  const add = (key: string, label: string, card: KanbanCard) => {
    const bucket = buckets.get(key) ?? { label, cards: [] };
    bucket.cards.push(card);
    buckets.set(key, bucket);
  };
  for (const card of cards) {
    if (by === "goal") {
      const goal = card.goalId === null ? undefined : state.goals.get(card.goalId);
      add(goal?.id ?? "", goal?.name ?? "No goal", card);
    } else if (by === "project") {
      if (card.projects.length === 0) add("", "No project", card);
      for (const project of card.projects) add(project, project, card);
    } else {
      const name = modelName(card.model);
      add(name, name, card);
    }
  }
  return [...buckets.entries()]
    .sort(([a, left], [b, right]) => {
      // The empty key ("No goal") goes last; the rest by size, then name.
      if (a === "" || b === "") return a === "" ? 1 : -1;
      return right.cards.length - left.cards.length || left.label.localeCompare(right.label);
    })
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      summary: null,
      cards: view(bucket.cards),
    }));
}

export interface CardSteps {
  readonly previous: string | null;
  readonly next: string | null;
  /** The Verified card to open after settling this one; null closes. */
  readonly afterSettle: string | null;
}

/**
 * Neighbours of a card in the column it sits in, as the board shows it. A card in
 * several groups steps through the first group that holds it.
 */
export function cardSteps(
  state: KanbanBoardState,
  nowMs: number,
  filter: BoardFilter,
  group: GroupBy,
  cardId: string,
): CardSteps {
  let lanes: ReadonlyArray<ReadonlyArray<CardView>>;
  let afterSettle: string | null = null;
  if (group === "stage") {
    const board = stageBoard(state, nowMs, filter);
    lanes = [...board.active, ...board.shipped, board.owner].map((column) => column.cards);
    const verified = board.shipped.find((column) => column.stage === "verified");
    const open = (verified?.cards ?? []).filter((view) => view.card.settledAt === null);
    const openAt = open.findIndex((view) => view.id === cardId);
    afterSettle =
      openAt >= 0 ? (open[openAt + 1]?.id ?? open[openAt - 1]?.id ?? null) : (open[0]?.id ?? null);
  } else {
    lanes = groupCards(state, group, nowMs, filter).map((g) => g.cards);
  }

  const lane = lanes.find((cards) => cards.some((view) => view.id === cardId)) ?? [];
  const index = lane.findIndex((view) => view.id === cardId);
  const at = (i: number) => (index >= 0 && i >= 0 && i < lane.length ? lane[i]!.id : null);
  return { previous: at(index - 1), next: at(index + 1), afterSettle };
}

export interface GoalProgress {
  readonly verified: number;
  /** Completed or deployed, not yet verified. */
  readonly shipped: number;
  readonly active: number;
  readonly todo: number;
  readonly total: number;
}

export function goalProgress(state: KanbanBoardState, goalId: string): GoalProgress {
  let verified = 0;
  let shipped = 0;
  let active = 0;
  let todo = 0;
  for (const card of state.cards.values()) {
    if (card.goalId !== goalId) continue;
    if (card.stage === "verified") verified += 1;
    else if (isDoneStage(card.stage)) shipped += 1;
    else if (card.stage === "todo") todo += 1;
    else active += 1;
  }
  return { verified, shipped, active, todo, total: verified + shipped + active + todo };
}

export interface GoalSummary {
  readonly goal: KanbanGoal;
  readonly progress: GoalProgress;
  readonly needsOwner: number;
}

export function activeGoals(state: KanbanBoardState): GoalSummary[] {
  return [...state.goals.values()]
    .filter((goal) => goal.status === "active")
    .map((goal) => ({
      goal,
      progress: goalProgress(state, goal.id),
      needsOwner: [...state.cards.values()].filter(
        (card) => card.goalId === goal.id && kanbanNeedsOwner(card),
      ).length,
    }))
    .sort((a, b) => a.goal.createdAt.localeCompare(b.goal.createdAt));
}

export interface GoalPage {
  readonly goal: KanbanGoal;
  readonly progress: GoalProgress;
  readonly projects: ReadonlyArray<string>;
  readonly now: { readonly text: string; readonly age: string } | null;
  readonly story: ReadonlyArray<{ readonly at: string; readonly text: string }>;
  readonly stages: ReadonlyArray<StageColumn>;
}

export function goalPage(state: KanbanBoardState, goalId: string, nowMs: number): GoalPage | null {
  const goal = state.goals.get(goalId);
  if (goal === undefined) return null;
  const cards = [...state.cards.values()].filter((card) => card.goalId === goalId);
  const projects = [...new Set(cards.flatMap((card) => card.projects))].sort();
  const orderFor = stageOrders(state);
  const order: KanbanStage[] = [
    "needs_owner",
    "working",
    "in_review",
    "needs_review",
    "todo",
    "completed",
    "deployed",
    "verified",
  ];
  return {
    goal,
    progress: goalProgress(state, goalId),
    projects,
    now: goal.now ? { text: goal.now.text, age: ageView(goal.now.at, nowMs)?.label ?? "" } : null,
    story: goal.story,
    stages: order
      .map((stage) => ({
        stage,
        label: STAGE_LABELS[stage],
        cards: cards
          .filter((card) => card.stage === stage)
          .sort(orderFor(stage))
          .map((card) => cardView(card, state, nowMs)),
      }))
      .filter((column) => column.cards.length > 0),
  };
}

/** Plain text of a message, for list previews and notifications. */
export function blockText(block: KanbanBlock): string {
  switch (block._tag) {
    case "md":
      return linkLabels(block.text);
    case "collapse":
      return block.title;
    case "html":
      return block.title ?? "Page";
    case "choice":
      return block.question;
    case "card":
      return "Card";
    case "image":
      return block.alt ?? "Image";
    case "attachment":
      return block.attachment.name || (block.attachment.type === "image" ? "Image" : "File");
  }
}

export function messagePreview(message: KanbanMessage): string {
  const text = message.blocks.map(blockText).join(" ").replace(/\s+/g, " ").trim();
  return message.author._tag === "owner" ? text : `${message.authorName}: ${text}`;
}

export interface DiscussionRow {
  readonly id: string;
  readonly title: string;
  readonly cardId: string | null;
  readonly unread: number;
  readonly preview: string;
  readonly at: string | null;
  readonly settledAt: string | null;
  /** Set while the snooze still holds at the time the rows were built. */
  readonly snoozedUntil: string | null;
  readonly pinnedAt: string | null;
}

export interface DiscussionGroups {
  readonly pinned: ReadonlyArray<DiscussionRow>;
  readonly active: ReadonlyArray<DiscussionRow>;
  readonly snoozed: ReadonlyArray<DiscussionRow>;
  readonly settled: ReadonlyArray<DiscussionRow>;
}

/** A snooze holds until its time passes; then the discussion is active again. */
export const discussionSnoozed = (
  discussion: Pick<KanbanDiscussion, "snoozedUntil">,
  nowMs: number,
): boolean => {
  if (discussion.snoozedUntil === null) return false;
  const wakeMs = Date.parse(discussion.snoozedUntil);
  return Number.isFinite(wakeMs) && wakeMs > nowMs;
};

/**
 * Discussions newest first in four groups, like sidebar threads. Settled wins
 * over snoozed, snoozed over pinned, pinned over active; a lapsed snooze counts
 * as active. `query` matches the title and the latest message preview.
 * `hideCards` drops card discussions (board channels stay); `unreadOnly` keeps
 * only discussions with unread messages. All filters combine.
 */
export function discussionRows(
  state: KanbanBoardState,
  nowMs: number,
  options: {
    readonly query?: string;
    readonly hideCards?: boolean;
    readonly unreadOnly?: boolean;
  } = {},
): DiscussionGroups {
  const needle = options.query?.trim().toLowerCase() ?? "";
  const pinned: DiscussionRow[] = [];
  const active: DiscussionRow[] = [];
  const snoozed: DiscussionRow[] = [];
  const settled: DiscussionRow[] = [];
  const rows = [...state.discussions.values()]
    .filter((discussion) => discussion.archivedAt === null)
    .map((discussion) => {
      const last = state.lastMessages.get(discussion.id);
      const sleeping = discussion.settledAt === null && discussionSnoozed(discussion, nowMs);
      return {
        id: discussion.id,
        title: discussion.title,
        cardId: discussion.cardId,
        unread: state.unread.get(discussion.id) ?? 0,
        preview: last ? messagePreview(last) : "",
        at: discussion.lastMessageAt ?? discussion.createdAt,
        settledAt: discussion.settledAt,
        snoozedUntil: sleeping ? discussion.snoozedUntil : null,
        pinnedAt: discussion.pinnedAt,
      } satisfies DiscussionRow;
    })
    .filter(
      (row) =>
        (!needle ||
          row.title.toLowerCase().includes(needle) ||
          row.preview.toLowerCase().includes(needle)) &&
        !(options.hideCards && row.cardId !== null) &&
        !(options.unreadOnly && row.unread === 0),
    )
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  for (const row of rows) {
    if (row.settledAt !== null) settled.push(row);
    else if (row.snoozedUntil !== null) snoozed.push(row);
    else if (row.pinnedAt !== null) pinned.push(row);
    else active.push(row);
  }
  return { pinned, active, snoozed, settled };
}

/** The earliest snooze still holding, so a screen knows when to regroup. */
export function nextDiscussionWakeMs(state: KanbanBoardState, nowMs: number): number | null {
  let next: number | null = null;
  for (const discussion of state.discussions.values()) {
    if (discussion.settledAt !== null || !discussionSnoozed(discussion, nowMs)) continue;
    const wakeMs = Date.parse(discussion.snoozedUntil ?? "");
    if (next === null || wakeMs < next) next = wakeMs;
  }
  return next;
}

export const totalUnread = (state: KanbanBoardState) => {
  let total = 0;
  for (const count of state.unread.values()) total += count;
  return total;
};

export type AvatarKind = "owner" | "evaluator" | "agent" | "script" | "system";

export function avatarOf(actor: KanbanActor, name: string): { kind: AvatarKind; letter: string } {
  const kind: AvatarKind =
    actor._tag === "thread"
      ? "agent"
      : actor._tag === "owner"
        ? "owner"
        : actor._tag === "evaluator"
          ? "evaluator"
          : actor._tag === "script"
            ? "script"
            : "system";
  return { kind, letter: (kind === "owner" ? "Y" : name.charAt(0) || "?").toUpperCase() };
}

/** A stable identity for an actor, for list keys and comparisons. */
export const actorKey = (actor: KanbanActor): string => {
  switch (actor._tag) {
    case "owner":
      return "owner";
    case "thread":
    case "evaluator":
      return `${actor._tag}:${actor.threadId}`;
    case "script":
      return `script:${actor.scriptId}`;
    case "system":
      return `system:${actor.component}`;
  }
};

export interface PresenceFace {
  readonly key: string;
  readonly name: string;
  readonly kind: AvatarKind;
  readonly letter: string;
}

export interface Presence {
  /** Others who have read up to the owner's newest message. */
  readonly seenBy: ReadonlyArray<PresenceFace>;
  readonly typing: ReadonlyArray<PresenceFace>;
}

export function discussionPresence(
  discussion: KanbanDiscussion,
  messages: ReadonlyArray<KanbanMessage>,
  nowMs: number,
): Presence {
  const lastOwn = messages.findLast((message) => message.author._tag === "owner");
  const others = discussion.participants.filter((entry) => entry.actor._tag !== "owner");
  const face = (entry: (typeof others)[number]): PresenceFace => ({
    key: actorKey(entry.actor),
    name: entry.name,
    ...avatarOf(entry.actor, entry.name),
  });
  return {
    seenBy:
      lastOwn === undefined
        ? []
        : others.filter((entry) => entry.lastReadSeq >= lastOwn.seq).map(face),
    typing: others
      .filter((entry) => entry.typingUntil !== null && Date.parse(entry.typingUntil) > nowMs)
      .map(face),
  };
}

/** Messages in seq order without duplicates; a later copy of a seq wins (answers). */
export function mergeMessages(
  current: ReadonlyArray<KanbanMessage>,
  incoming: ReadonlyArray<KanbanMessage>,
): KanbanMessage[] {
  const bySeq = new Map<number, KanbanMessage>();
  for (const message of current) bySeq.set(message.seq, message);
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function sameActor(a: KanbanActor, b: KanbanActor) {
  return actorKey(a) === actorKey(b);
}

export interface PoolView {
  readonly key: string;
  readonly name: string;
  readonly variant: string | null;
  readonly slots: number;
  readonly busy: number;
  readonly model: ModelSelection;
}

export function poolViews(state: KanbanBoardState): PoolView[] {
  return state.pools.map((pool) => {
    // A slot belongs to a thread, and one thread can carry several cards.
    const threads = new Set<string>();
    for (const card of state.cards.values()) {
      if (card.activePool === pool.key && card.activeThreadId !== null) {
        threads.add(card.activeThreadId);
      }
    }
    return {
      key: pool.key,
      name: modelName(pool.model),
      variant: modelVariant(pool.model),
      slots: pool.slots,
      busy: threads.size,
      model: pool.model,
    };
  });
}

/** The owner's answer to this choice block, or null when he hasn't answered it. */
export function ownerChoiceAnswer(
  block: Extract<KanbanBlock, { _tag: "choice" }>,
  answers: ReadonlyArray<KanbanAnswer>,
): KanbanAnswer | null {
  return (
    answers.find((answer) => answer.blockId === block.id && answer.by._tag === "owner") ?? null
  );
}

/** Mirrors the server's answer rule so Send buttons match what it accepts. */
export function canSendChoice(
  block: Extract<KanbanBlock, { _tag: "choice" }>,
  choice: ReadonlyArray<string>,
  text: string,
): boolean {
  const words = text.trim() !== "";
  if (block.style === "poll") return choice.length > 0 && !words;
  if (block.multi) return choice.length > 0 || words;
  return (choice.length === 1 && !words) || (choice.length === 0 && words);
}
