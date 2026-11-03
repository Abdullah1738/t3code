/**
 * Missions board (code name kanban): cards move through fixed stages, a
 * dispatcher starts agent threads for them from per-model pools, and
 * evaluators steer the work. Discussions are a chat store shared by owner,
 * card threads, evaluators and scripts.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ChatFileAttachment, ChatImageAttachment } from "../chatAttachment.ts";
import { ModelSelection } from "../modelSelection.ts";

const kanbanId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));

export const KanbanBoardId = kanbanId("KanbanBoardId");
export type KanbanBoardId = typeof KanbanBoardId.Type;
export const KanbanCardId = kanbanId("KanbanCardId");
export type KanbanCardId = typeof KanbanCardId.Type;
export const KanbanGoalId = kanbanId("KanbanGoalId");
export type KanbanGoalId = typeof KanbanGoalId.Type;
export const KanbanDiscussionId = kanbanId("KanbanDiscussionId");
export type KanbanDiscussionId = typeof KanbanDiscussionId.Type;
export const KanbanScriptId = kanbanId("KanbanScriptId");
export type KanbanScriptId = typeof KanbanScriptId.Type;
export const KanbanAutomationId = kanbanId("KanbanAutomationId");
export type KanbanAutomationId = typeof KanbanAutomationId.Type;

export const KANBAN_STAGES = [
  "todo",
  "working",
  "needs_review",
  "in_review",
  "completed",
  "deployed",
  "verified",
  "needs_owner",
] as const;
export const KanbanStage = Schema.Literals(KANBAN_STAGES);
export type KanbanStage = typeof KanbanStage.Type;

/** Stages that always have a live thread, and only the dispatcher moves a card into. */
export const KANBAN_THREAD_STAGES: ReadonlyArray<KanbanStage> = ["working", "in_review"];

export const KanbanActor = Schema.Union([
  Schema.TaggedStruct("owner", {}),
  /** A card's work or review thread. */
  Schema.TaggedStruct("thread", { threadId: ThreadId }),
  Schema.TaggedStruct("evaluator", { threadId: ThreadId }),
  Schema.TaggedStruct("script", { scriptId: KanbanScriptId }),
  Schema.TaggedStruct("system", { component: TrimmedNonEmptyString }),
]);
export type KanbanActor = typeof KanbanActor.Type;

/** Priority 1 is the most urgent, 4 the least; 5 is backlog. */
export const KanbanPriority = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }));
export type KanbanPriority = typeof KanbanPriority.Type;

/** A backlog card is never picked up; one with a thread is paused until it leaves. */
export const KANBAN_BACKLOG = 5;

export const KanbanLinkKind = Schema.Literals(["pr", "linear", "url"]);
export type KanbanLinkKind = typeof KanbanLinkKind.Type;

export const KanbanLink = Schema.Struct({
  kind: KanbanLinkKind,
  url: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  /** PR state as last checked on the work thread (syncPrs); null for other links, including PRs attached only as context. */
  state: Schema.NullOr(Schema.Literals(["open", "draft", "merged", "closed"])),
  checkedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanLink = typeof KanbanLink.Type;

/** One review chain: each step's model reviews until clear, then the next step takes over. */
export const KanbanReviewChain = Schema.Struct({
  name: TrimmedNonEmptyString,
  steps: Schema.Array(ModelSelection),
});
export type KanbanReviewChain = typeof KanbanReviewChain.Type;

/** Why a board thread is paused: its last run died on a provider outage. */
export const KanbanThreadPause = Schema.Struct({
  at: IsoDateTime,
  message: Schema.String,
  /** The failed run this pause is for; a different run is a new outage. */
  runId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type KanbanThreadPause = typeof KanbanThreadPause.Type;

/** Every thread the board started: card work/review threads and evaluators. */
export const KanbanThreadLink = Schema.Struct({
  threadId: ThreadId,
  boardId: KanbanBoardId,
  cardId: Schema.NullOr(KanbanCardId),
  role: Schema.Literals(["work", "review", "evaluator"]),
  /** Evaluator purpose: `discussion:<id>`, `stalled`, `completed`, `deployed`, `check`, `packets`, `setup`, `request`. */
  purpose: Schema.NullOr(Schema.String),
  discussionId: Schema.NullOr(KanbanDiscussionId),
  model: Schema.NullOr(ModelSelection),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  /** Set while its model is out of usage or down; the board wakes the thread when a probe passes. */
  paused: Schema.NullOr(KanbanThreadPause).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type KanbanThreadLink = typeof KanbanThreadLink.Type;

/** One model a card's work may start on; the highest weight with room wins. */
export const KanbanCardModel = Schema.Struct({
  model: ModelSelection,
  weight: PositiveInt,
});
export type KanbanCardModel = typeof KanbanCardModel.Type;

/** Who does a subtask: the card's worker, its reviewer, an evaluator, or a board script. */
export const KanbanSubtaskOwner = Schema.Literals(["work", "review", "evaluator", "script"]);
export type KanbanSubtaskOwner = typeof KanbanSubtaskOwner.Type;

/**
 * One piece of a card's plan. Subtasks with the same step go in any order; a
 * step opens once every subtask in an earlier step is done or skipped.
 */
export const KanbanSubtask = Schema.Struct({
  /** `s1`, `s2`, ... in the order they were added. */
  id: TrimmedNonEmptyString,
  step: PositiveInt,
  text: Schema.String,
  owner: KanbanSubtaskOwner,
  /** For a script's subtask: the name of the board script that does it. Absent: any script on the card's board. */
  script: Schema.optional(Schema.String),
  state: Schema.Literals(["open", "done", "skipped"]),
  /** What was done, or why it was skipped. */
  note: Schema.NullOr(Schema.String),
  doneBy: Schema.NullOr(KanbanActor),
  doneAt: Schema.NullOr(IsoDateTime),
});
export type KanbanSubtask = typeof KanbanSubtask.Type;

/**
 * A question for the owner. A blocking ask holds the card in Needs Owner; an
 * async one lets its work go on and can be made blocking later.
 */
export const KanbanOwnerAsk = Schema.Struct({
  /** `q1`, `q2`, ... per card; also the id of its pick block when it has options. */
  id: TrimmedNonEmptyString,
  text: Schema.String,
  blocking: Schema.Boolean,
  by: KanbanActor,
  at: IsoDateTime,
  /** The card discussion message that asked it; null when it wasn't posted. */
  seq: Schema.NullOr(PositiveInt),
  /** Set once answered or dropped. */
  closedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanOwnerAsk = typeof KanbanOwnerAsk.Type;

export const KanbanCard = Schema.Struct({
  id: KanbanCardId,
  boardId: KanbanBoardId,
  /** Per-board sequence, shown as #12. */
  number: PositiveInt,
  title: Schema.String,
  description: Schema.String,
  prompt: Schema.String,
  /** The card's flow, step by step: the work, its review and what comes after. */
  subtasks: Schema.Array(KanbanSubtask).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Highest subtask number ever handed out on this card, so a dropped id is never reused. */
  subtaskSeq: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  stage: KanbanStage,
  priority: KanbanPriority,
  goalId: Schema.NullOr(KanbanGoalId),
  projects: Schema.Array(TrimmedNonEmptyString),
  /** Model the work thread runs on. */
  model: ModelSelection,
  /**
   * Models the work may start on, highest weight first. A pool with room at
   * the top weight wins, ties at random. Empty means just `model`.
   */
  models: Schema.Array(KanbanCardModel).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** T3 project the card's threads run in; null uses the board default. */
  projectId: Schema.NullOr(ProjectId),
  links: Schema.Array(KanbanLink),
  blockedBy: Schema.Array(KanbanCardId),
  stalled: Schema.NullOr(
    Schema.Struct({ reason: Schema.String, by: KanbanActor, at: IsoDateTime }),
  ),
  /** Set while the card sits in Needs Owner. */
  question: Schema.NullOr(Schema.String),
  asks: Schema.Array(KanbanOwnerAsk).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Review chain name from the board; null uses the board default. */
  reviewChain: Schema.NullOr(TrimmedNonEmptyString),
  /** Position in the review chain while in review; reset when findings send it back. */
  reviewStep: NonNegativeInt,
  reviewRound: NonNegativeInt,
  activeThreadId: Schema.NullOr(ThreadId),
  activeRole: Schema.NullOr(Schema.Literals(["work", "review"])),
  /** Pool key (instance/model#level) the active thread holds a slot in. */
  activePool: Schema.NullOr(Schema.String),
  workThreadId: Schema.NullOr(ThreadId),
  reviewThreadId: Schema.NullOr(ThreadId),
  discussionId: Schema.NullOr(KanbanDiscussionId),
  /** Sent to the card's thread the next time the dispatcher starts or wakes it (findings, owner answer). */
  wakeNote: Schema.NullOr(Schema.String),
  /** Set when the server nudged the active thread after a turn ended without a card move. */
  nudgedAt: Schema.NullOr(IsoDateTime),
  settledAt: Schema.NullOr(IsoDateTime),
  createdBy: KanbanActor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  movedAt: IsoDateTime,
});
export type KanbanCard = typeof KanbanCard.Type;

/** The models a card's work may start on, highest weight first. */
export const kanbanCardModels = (card: KanbanCard): ReadonlyArray<KanbanCardModel> =>
  card.models.length > 0 ? card.models : [{ model: card.model, weight: 1 }];

export const kanbanOpenAsks = (card: Pick<KanbanCard, "asks">): ReadonlyArray<KanbanOwnerAsk> =>
  card.asks.filter((ask) => ask.closedAt === null);

/** A card in Needs Owner, or one with an open ask that doesn't block it yet. */
export const kanbanNeedsOwner = (card: Pick<KanbanCard, "asks" | "stage" | "settledAt">) =>
  card.settledAt === null && (card.stage === "needs_owner" || kanbanOpenAsks(card).length > 0);

/** The step the card is on: the first with an open subtask, or null when none is open. */
export const kanbanOpenStep = (card: Pick<KanbanCard, "subtasks">): number | null =>
  card.subtasks.reduce<number | null>(
    (step, subtask) =>
      subtask.state === "open" && (step === null || subtask.step < step) ? subtask.step : step,
    null,
  );

/** Open subtasks of the step the card is on, for one owner or all. */
export const kanbanStepSubtasks = (
  card: Pick<KanbanCard, "subtasks">,
  owner?: KanbanSubtask["owner"],
): ReadonlyArray<KanbanSubtask> => {
  const step = kanbanOpenStep(card);
  return card.subtasks.filter(
    (subtask) =>
      subtask.state === "open" &&
      subtask.step === step &&
      (owner === undefined || subtask.owner === owner),
  );
};

/**
 * True when the step a card is on needs the evaluator: it has an evaluator
 * subtask and nothing else but evaluator and script subtasks. A mixed step
 * still wakes the evaluator, for its own subtasks only.
 */
export const kanbanEvaluatorStep = (card: Pick<KanbanCard, "subtasks">): boolean => {
  const open = kanbanStepSubtasks(card);
  return (
    open.some((subtask) => subtask.owner === "evaluator") &&
    open.every((subtask) => subtask.owner === "evaluator" || subtask.owner === "script")
  );
};

/** True when the step a card is on is only board scripts' subtasks. */
export const kanbanScriptStep = (card: Pick<KanbanCard, "subtasks">): boolean => {
  const open = kanbanStepSubtasks(card);
  return open.length > 0 && open.every((subtask) => subtask.owner === "script");
};

/**
 * A todo card the dispatcher leaves alone because its step is the
 * evaluator's or a board script's. One with a wake note still goes back to
 * its worker: review findings and the owner's words have to reach it.
 */
export const kanbanWaitsOnEvaluator = (
  card: Pick<KanbanCard, "stage" | "wakeNote" | "subtasks">,
): boolean =>
  card.stage === "todo" &&
  card.wakeNote === null &&
  (kanbanEvaluatorStep(card) || kanbanScriptStep(card));

/** Stages past the work: a card here no longer blocks anything or waits on anything. */
export const KANBAN_DONE_STAGES: ReadonlySet<KanbanStage> = new Set([
  "completed",
  "deployed",
  "verified",
]);

const isOpenCard = (card: KanbanCard) =>
  !KANBAN_DONE_STAGES.has(card.stage) && card.settledAt === null;

/**
 * A completed card whose evaluator merge subtask is still open: review has
 * passed, but its work isn't on ardud/main yet. Completed means review-passed;
 * the merge is a later evaluator subtask.
 */
export const kanbanAwaitsMerge = (card: Pick<KanbanCard, "stage" | "subtasks">): boolean =>
  card.stage === "completed" &&
  card.subtasks.some(
    (subtask) =>
      subtask.state === "open" &&
      (subtask.owner === "evaluator" || subtask.owner === "script") &&
      // A merge action starts a clause ("merge router.ts into ...", "...; merge; deploy ...");
      // a check that only mentions a merge ("blocker's merge subtask") doesn't.
      /(?:^|[;:,.]\s*|\b(?:and|then)\s+)merge\b/i.test(subtask.text),
  );

/**
 * The first unfinished card holding `card` up, or undefined. A blocker on the
 * same work thread is no block, since that thread does both in order, unless
 * it can't go on itself: stalled, in the backlog, waiting on the owner or the
 * evaluator, or held up in turn. A completed blocker still holds while its
 * merge subtask is open; deployed and verified blockers never do.
 */
export function kanbanHeldUpBy(
  card: KanbanCard,
  byId: ReadonlyMap<string, KanbanCard>,
  thread: string | null = card.workThreadId,
): KanbanCard | undefined {
  // `path` is the chain being walked; meeting a card on it again is a loop, and nothing in a loop goes.
  const heldUp = (waiter: KanbanCard, path: Set<string>): KanbanCard | undefined => {
    for (const id of waiter.blockedBy) {
      const blocker = byId.get(id);
      if (blocker === undefined) continue;
      const done = KANBAN_DONE_STAGES.has(blocker.stage);
      if (done && !kanbanAwaitsMerge(blocker)) continue;
      if (thread === null || blocker.workThreadId !== thread) return blocker;
      // Same thread: it carries the blocker's commits on its own branch, so a finished blocker isn't held.
      if (done) continue;
      if (
        blocker.stalled !== null ||
        blocker.priority === KANBAN_BACKLOG ||
        blocker.stage === "needs_owner" ||
        kanbanWaitsOnEvaluator(blocker) ||
        path.has(blocker.id)
      ) {
        return blocker;
      }
      path.add(blocker.id);
      const deeper = heldUp(blocker, path);
      path.delete(blocker.id);
      if (deeper !== undefined) return blocker;
    }
    return undefined;
  };
  return heldUp(card, new Set([card.id]));
}

export interface KanbanBlocking {
  /** Open cards it holds up, the whole chain: if C waits on B and B waits on A, A holds up two. */
  readonly holds: number;
  /** The most urgent priority among the card and every open card it holds up. */
  readonly urgency: number;
}

/**
 * What each open card holds up. Done and settled cards are left out, and a
 * backlog card waiting on another doesn't count: nobody is going to do it.
 */
export function kanbanBlocking(cards: ReadonlyArray<KanbanCard>): Map<string, KanbanBlocking> {
  const byId = new Map(cards.map((card) => [card.id as string, card]));
  const waiters = new Map<string, Array<string>>();
  for (const card of cards) {
    if (!isOpenCard(card) || card.priority === KANBAN_BACKLOG) continue;
    for (const id of card.blockedBy) {
      const list = waiters.get(id) ?? [];
      list.push(card.id);
      waiters.set(id, list);
    }
  }
  const result = new Map<string, KanbanBlocking>();
  for (const card of cards) {
    if (!isOpenCard(card)) continue;
    // Breadth-first over the waiters; `seen` also ends a loop of blocks.
    const seen = new Set<string>([card.id]);
    const queue: Array<string> = [card.id];
    let urgency = card.priority;
    for (let i = 0; i < queue.length; i += 1) {
      for (const id of waiters.get(queue[i] ?? "") ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(id);
        urgency = Math.min(urgency, byId.get(id)?.priority ?? urgency);
      }
    }
    // A backlog card stays at the bottom whatever waits on it; only the owner takes it out.
    result.set(card.id, {
      holds: seen.size - 1,
      urgency: card.priority === KANBAN_BACKLOG ? KANBAN_BACKLOG : urgency,
    });
  }
  return result;
}

/**
 * The order todo cards get picked up in: most urgent first, where a card
 * holding up an urgent card is as urgent as that card; then the one holding
 * up the most other cards; then the one waiting longest. The dispatcher uses
 * it and the board's To-Do column shows it.
 */
export function kanbanPickOrder(cards: ReadonlyArray<KanbanCard>) {
  const blocking = kanbanBlocking(cards);
  const of = (card: KanbanCard) => blocking.get(card.id) ?? { holds: 0, urgency: card.priority };
  return (a: KanbanCard, b: KanbanCard) => {
    const x = of(a);
    const y = of(b);
    return (
      x.urgency - y.urgency ||
      y.holds - x.holds ||
      a.movedAt.localeCompare(b.movedAt) ||
      a.number - b.number
    );
  };
}

export const KanbanCardEvent = Schema.Struct({
  id: NonNegativeInt,
  cardId: KanbanCardId,
  at: IsoDateTime,
  actor: KanbanActor,
  kind: Schema.Literals([
    "created",
    "moved",
    "edited",
    "linked",
    "flagged",
    "comment",
    "thread",
    "review",
    "subtask",
  ]),
  fromStage: Schema.NullOr(KanbanStage),
  toStage: Schema.NullOr(KanbanStage),
  body: Schema.NullOr(Schema.String),
  /** Review events: the commit the reviewer reviewed, when it said. Null otherwise. */
  head: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type KanbanCardEvent = typeof KanbanCardEvent.Type;

export const KanbanGoal = Schema.Struct({
  id: KanbanGoalId,
  boardId: KanbanBoardId,
  name: TrimmedNonEmptyString,
  status: Schema.Literals(["active", "done"]),
  /** Scribe's current status, at most 15 minutes old while the goal moves. */
  now: Schema.NullOr(Schema.Struct({ text: Schema.String, at: IsoDateTime })),
  /** Numbered story for a non-technical reader, oldest first. */
  story: Schema.Array(Schema.Struct({ at: IsoDateTime, text: Schema.String })),
  createdAt: IsoDateTime,
});
export type KanbanGoal = typeof KanbanGoal.Type;

export const KanbanPool = Schema.Struct({
  /** `instanceId/model#level`, or `instanceId/model` for a model with no level. */
  key: TrimmedNonEmptyString,
  model: ModelSelection,
  slots: NonNegativeInt,
});
export type KanbanPool = typeof KanbanPool.Type;

/** View-only grouping of similar cards, written by the scribe. */
export const KanbanGroup = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  summary: Schema.String,
  cardIds: Schema.Array(KanbanCardId),
  updatedAt: IsoDateTime,
});
export type KanbanGroup = typeof KanbanGroup.Type;

export const KanbanInstructions = Schema.Struct({
  modelRouting: Schema.String,
  reviewerRouting: Schema.String,
  escalation: Schema.String,
});
export type KanbanInstructions = typeof KanbanInstructions.Type;

/** Icons a board can show; each client draws them from its own icon set. */
export const KANBAN_BOARD_ICONS = [
  "briefcase",
  "rocket",
  "code",
  "shield",
  "chart",
  "bot",
  "wallet",
  "flask",
  "server",
  "globe",
  "users",
  "wrench",
  "book",
  "bolt",
  "home",
  "heart",
  "target",
  "box",
  "database",
  "bug",
  "brain",
  "coins",
  "plane",
  "leaf",
] as const;
export const KanbanBoardIcon = Schema.Literals(KANBAN_BOARD_ICONS);
export type KanbanBoardIcon = typeof KanbanBoardIcon.Type;

/** Board summaries carry the image to every client, so it stays a small inline picture. */
export const KANBAN_BOARD_IMAGE_MAX = 40_000;
export const KanbanBoardIconImage = Schema.String.check(
  Schema.isMaxLength(KANBAN_BOARD_IMAGE_MAX),
  Schema.isPattern(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
);

/**
 * A board's first setup: the setup evaluator backfills the wiki while card work
 * is held. Null on boards that never ran one (existing rows decode as null).
 */
export const KanbanBoardSetup = Schema.Struct({
  status: Schema.Literals(["running", "done"]),
  discussionId: KanbanDiscussionId,
  threadId: ThreadId,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanBoardSetup = typeof KanbanBoardSetup.Type;

export const KanbanBoardPause = Schema.Struct({
  reason: TrimmedNonEmptyString,
  keep: Schema.Array(KanbanCardId),
  at: IsoDateTime,
  by: Schema.String,
});
export type KanbanBoardPause = typeof KanbanBoardPause.Type;

export const KanbanBoard = Schema.Struct({
  id: KanbanBoardId,
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** A name from KANBAN_BOARD_ICONS; stored as text so a retired name still decodes. */
  icon: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** An uploaded picture (data URL); shown before the named icon. */
  iconImage: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  defaultProjectId: Schema.NullOr(ProjectId),
  /** Writes titles, descriptions, goal stories and groups. */
  managerModel: ModelSelection,
  evaluatorModel: ModelSelection,
  defaultCardModel: ModelSelection,
  reviewChains: Schema.Array(KanbanReviewChain),
  defaultReviewChain: Schema.NullOr(TrimmedNonEmptyString),
  instructions: KanbanInstructions,
  setup: Schema.NullOr(KanbanBoardSetup).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  pause: Schema.NullOr(KanbanBoardPause).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanBoard = typeof KanbanBoard.Type;

/** The board's icon, or null when it has none or one this build doesn't know. */
export const kanbanBoardIcon = (board: KanbanBoard): KanbanBoardIcon | null =>
  KANBAN_BOARD_ICONS.find((name) => name === board.icon) ?? null;

const BlockId = TrimmedNonEmptyString;
const ChoiceOption = Schema.Struct({ id: TrimmedNonEmptyString, label: TrimmedNonEmptyString });

export const KanbanBlock = Schema.Union([
  Schema.TaggedStruct("md", { text: Schema.String }),
  Schema.TaggedStruct("collapse", { title: TrimmedNonEmptyString, text: Schema.String }),
  Schema.TaggedStruct("html", {
    html: Schema.String,
    title: Schema.NullOr(Schema.String),
    height: Schema.NullOr(PositiveInt),
  }),
  /** Poll and pick render the same way; poll shows everyone's answers, pick is a decision. */
  Schema.TaggedStruct("choice", {
    id: BlockId,
    style: Schema.Literals(["poll", "pick"]),
    question: TrimmedNonEmptyString,
    options: Schema.Array(ChoiceOption),
    multi: Schema.Boolean,
  }),
  Schema.TaggedStruct("card", { cardId: KanbanCardId }),
  Schema.TaggedStruct("image", { url: TrimmedNonEmptyString, alt: Schema.NullOr(Schema.String) }),
  /** A file uploaded through the attachment store; the board keeps it under its own id. */
  Schema.TaggedStruct("attachment", {
    attachment: Schema.Union([ChatImageAttachment, ChatFileAttachment]),
  }),
]);
export type KanbanBlock = typeof KanbanBlock.Type;

// Preserve poster text until the board service has checked it, rather than
// letting TrimmedNonEmptyString erase control characters during decoding.
const RawBoardText = Schema.toType(TrimmedNonEmptyString);
export const KanbanBlockInput = Schema.Union([
  Schema.TaggedStruct("md", { text: Schema.String }),
  Schema.TaggedStruct("collapse", { title: RawBoardText, text: Schema.String }),
  Schema.TaggedStruct("html", {
    html: Schema.String,
    title: Schema.NullOr(Schema.String),
    height: Schema.NullOr(PositiveInt),
  }),
  Schema.TaggedStruct("choice", {
    id: BlockId,
    style: Schema.Literals(["poll", "pick"]),
    question: RawBoardText,
    options: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, label: RawBoardText })),
    multi: Schema.Boolean,
  }),
  Schema.TaggedStruct("card", { cardId: KanbanCardId }),
  Schema.TaggedStruct("image", { url: TrimmedNonEmptyString, alt: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("attachment", {
    attachment: Schema.Union([ChatImageAttachment, ChatFileAttachment]),
  }),
]);

export const KanbanAnswer = Schema.Struct({
  blockId: TrimmedNonEmptyString,
  by: KanbanActor,
  choice: Schema.Array(TrimmedNonEmptyString),
  /** His own words, for a pick; null when he only picked options. */
  text: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  at: IsoDateTime,
});
export type KanbanAnswer = typeof KanbanAnswer.Type;

export const KanbanMessage = Schema.Struct({
  discussionId: KanbanDiscussionId,
  seq: PositiveInt,
  author: KanbanActor,
  /** Display name at post time ("Evaluator", "U1-U4 union reader", "Cert check"). */
  authorName: Schema.String,
  blocks: Schema.Array(KanbanBlock),
  answers: Schema.Array(KanbanAnswer),
  createdAt: IsoDateTime,
});
export type KanbanMessage = typeof KanbanMessage.Type;

export const KanbanParticipant = Schema.Struct({
  actor: KanbanActor,
  name: Schema.String,
  lastReadSeq: NonNegativeInt,
  /** Heartbeat-driven; typing while in the future. */
  typingUntil: Schema.NullOr(IsoDateTime),
  /** Agent was asked to reply here; "nudged" after one reminder at turn end. */
  owes: Schema.NullOr(Schema.Literals(["asked", "nudged"])),
  /** A turn-end reminder held by the board pause, to be retried after release. */
  deferred: Schema.optional(Schema.Boolean),
  /** Stable ID for retrying one deferred reminder after an ambiguous send. */
  deferredKey: Schema.optional(Schema.String),
});
export type KanbanParticipant = typeof KanbanParticipant.Type;

export const KanbanDiscussion = Schema.Struct({
  id: KanbanDiscussionId,
  boardId: KanbanBoardId,
  /** Set for a card's own discussion; channels have none. */
  cardId: Schema.NullOr(KanbanCardId),
  title: Schema.String,
  /** Channel evaluator thread (its work lives there). */
  evaluatorThreadId: Schema.NullOr(ThreadId),
  participants: Schema.Array(KanbanParticipant),
  lastSeq: NonNegativeInt,
  lastMessageAt: Schema.NullOr(IsoDateTime),
  createdBy: KanbanActor,
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  /** Set when the owner names it; the server stops writing titles for it then. */
  titleEditedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The owner put it away; a new message from anyone else brings it back. */
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Hidden until then, or until someone else posts. */
  snoozedUntil: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The owner pinned it: listed first and never settled automatically. */
  pinnedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** When the owner last brought it back (unsettle, unsnooze or unpin); the idle day before auto-settle restarts here. */
  reopenedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type KanbanDiscussion = typeof KanbanDiscussion.Type;

export const KanbanScriptTrigger = Schema.Union([
  Schema.TaggedStruct("schedule", {
    everyMs: Schema.NullOr(PositiveInt),
    cron: Schema.NullOr(Schema.String),
    /** The zone a cron line runs in (the server's), filled on read; null when unknown. */
    timeZone: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.TaggedStruct("event", {
    event: Schema.Literals(["card.created", "card.moved", "message.posted"]),
  }),
  Schema.TaggedStruct("webhook", {}),
  Schema.TaggedStruct("manual", {}),
]);
export type KanbanScriptTrigger = typeof KanbanScriptTrigger.Type;

export const KanbanScript = Schema.Struct({
  id: KanbanScriptId,
  boardId: KanbanBoardId,
  name: TrimmedNonEmptyString,
  /** Absolute path; run by extension (.ts/.js with bun, .py with python3, .sh with bash, .zsh with zsh). */
  path: TrimmedNonEmptyString,
  trigger: KanbanScriptTrigger,
  enabled: Schema.Boolean,
  createdBy: KanbanActor,
  createdAt: IsoDateTime,
  lastRun: Schema.NullOr(
    Schema.Struct({
      startedAt: IsoDateTime,
      endedAt: Schema.NullOr(IsoDateTime),
      exitCode: Schema.NullOr(Schema.Int),
    }),
  ),
});
export type KanbanScript = typeof KanbanScript.Type;

export const KanbanScriptRun = Schema.Struct({
  id: NonNegativeInt,
  scriptId: KanbanScriptId,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  /** Last 64KB of combined stdout/stderr. */
  output: Schema.String,
  trigger: Schema.String,
});
export type KanbanScriptRun = typeof KanbanScriptRun.Type;

export const KanbanAutomation = Schema.Struct({
  id: KanbanAutomationId,
  boardId: KanbanBoardId,
  name: TrimmedNonEmptyString,
  /** Backing scheduled task; its runs are the automation's history. */
  scheduledTaskId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type KanbanAutomation = typeof KanbanAutomation.Type;

export const KanbanWikiPage = Schema.Struct({
  boardId: KanbanBoardId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  updatedAt: IsoDateTime,
  updatedBy: KanbanActor,
});
export type KanbanWikiPage = typeof KanbanWikiPage.Type;

export const KanbanErrorCode = Schema.Literals([
  "not-found",
  "conflict",
  "invalid",
  "denied",
  "failed",
]);
export type KanbanErrorCode = typeof KanbanErrorCode.Type;

export class KanbanError extends Schema.TaggedError<KanbanError>()("KanbanError", {
  code: KanbanErrorCode,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Missions board ${this.code}: ${this.detail}`;
  }
}

/** Live state of a card's active thread, joined from orchestration. */
export const KanbanThreadState = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  running: Schema.Boolean,
  /** Waiting on its own built-in question, which nobody sees; running is false then. */
  needsInput: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  lastActivityAt: Schema.NullOr(IsoDateTime),
});
export type KanbanThreadState = typeof KanbanThreadState.Type;

/**
 * A board thread as the Threads view lists it: the link plus its card and live
 * state. `running` comes from the thread's real state, not from whether the
 * link has ended, so an idle persistent evaluator is not shown as running.
 */
export const KanbanThreadRow = Schema.Struct({
  threadId: ThreadId,
  boardId: KanbanBoardId,
  role: Schema.Literals(["work", "review", "evaluator"]),
  purpose: Schema.NullOr(Schema.String),
  cardId: Schema.NullOr(KanbanCardId),
  cardNumber: Schema.NullOr(PositiveInt),
  cardTitle: Schema.NullOr(Schema.String),
  discussionId: Schema.NullOr(KanbanDiscussionId),
  model: Schema.NullOr(ModelSelection),
  title: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  lastActivityAt: Schema.NullOr(IsoDateTime),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanThreadRow = typeof KanbanThreadRow.Type;

export const KanbanBoardSnapshot = Schema.Struct({
  board: KanbanBoard,
  cards: Schema.Array(KanbanCard),
  goals: Schema.Array(KanbanGoal),
  pools: Schema.Array(KanbanPool),
  groups: Schema.Array(KanbanGroup),
  threads: Schema.Array(KanbanThreadState),
  /** Unread owner messages per discussion. */
  unread: Schema.Array(Schema.Struct({ discussionId: KanbanDiscussionId, count: NonNegativeInt })),
});
export type KanbanBoardSnapshot = typeof KanbanBoardSnapshot.Type;

/** A board with the counts a board list shows, so the list needs no board feeds. */
export const KanbanBoardSummary = Schema.Struct({
  board: KanbanBoard,
  /** Unsettled cards waiting on the owner. */
  needsOwner: NonNegativeInt,
  /** Unsettled cards a thread is working on. */
  running: NonNegativeInt,
  /** Unread owner messages across the board's discussions. */
  unread: NonNegativeInt,
  /** Every thread the board started; thread lists leave them out, the board shows them. */
  threadIds: Schema.Array(ThreadId),
});
export type KanbanBoardSummary = typeof KanbanBoardSummary.Type;

/**
 * A board in one board list update. The stream's first list is whole. After
 * that a null board is unchanged since the stream's previous list and
 * threadIds holds only the threads started since then, so a count change
 * resends neither board pictures nor every thread id.
 */
export const KanbanBoardListEntry = Schema.Struct({
  boardId: KanbanBoardId,
  board: Schema.NullOr(KanbanBoard),
  needsOwner: NonNegativeInt,
  running: NonNegativeInt,
  unread: NonNegativeInt,
  threadIds: Schema.Array(ThreadId),
});
export type KanbanBoardListEntry = typeof KanbanBoardListEntry.Type;

export const KanbanChange = Schema.Union([
  // `by`: who saved the card, when the save came from a move. Script listeners need it to skip a script's own moves.
  Schema.TaggedStruct("card", { card: KanbanCard, by: Schema.optional(KanbanActor) }),
  Schema.TaggedStruct("cardRemoved", { cardId: KanbanCardId }),
  Schema.TaggedStruct("goal", { goal: KanbanGoal }),
  Schema.TaggedStruct("pools", { pools: Schema.Array(KanbanPool) }),
  Schema.TaggedStruct("board", { board: KanbanBoard }),
  Schema.TaggedStruct("groups", { groups: Schema.Array(KanbanGroup) }),
  Schema.TaggedStruct("thread", { thread: KanbanThreadState }),
  Schema.TaggedStruct("discussion", { discussion: KanbanDiscussion }),
  Schema.TaggedStruct("message", { message: KanbanMessage }),
  Schema.TaggedStruct("script", { script: KanbanScript }),
  Schema.TaggedStruct("scriptRun", { run: KanbanScriptRun }),
]);
export type KanbanChange = typeof KanbanChange.Type;
