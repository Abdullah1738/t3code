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

/** A waiting To-Do card gains one priority step for every this long it has been startable. */
export const KANBAN_AGING_STEP_MS = 3 * 24 * 60 * 60 * 1000;
/** Most priority steps waiting alone can add. */
export const KANBAN_AGING_MAX_STEPS = 2;
/** Open cards a card must hold up (the whole chain) to gain one priority step, then two. */
export const KANBAN_FANOUT_STEPS: ReadonlyArray<number> = [10, 100];
/**
 * Fan-out and waiting never lift a card above this priority. P1 stays what the
 * owner marked P1, or what holds a P1 card up.
 */
export const KANBAN_BOOST_FLOOR = 2;

export interface KanbanSchedule extends KanbanBlocking {
  /**
   * The priority the card is picked at: `urgency`, lifted one step per
   * KANBAN_FANOUT_STEPS threshold its `holds` reaches and one step per
   * KANBAN_AGING_STEP_MS it has waited, never above KANBAN_BOOST_FLOOR.
   */
  readonly rank: number;
  /** Steps `holds` earned (0 to KANBAN_FANOUT_STEPS.length), before the floor. */
  readonly fanoutSteps: number;
  /** Steps waiting earned (0 to KANBAN_AGING_MAX_STEPS), before the floor. */
  readonly agingSteps: number;
  /**
   * Since when a To-Do card has had nothing unfinished to wait on: its last move, or
   * the last move of its latest finished blocker. Null for a card outside To-Do or
   * one that still waits on an unfinished card, which doesn't age.
   */
  readonly waitingSince: string | null;
}

export interface KanbanScheduleOptions {
  /**
   * The clock waiting is measured against. Left out, it is the newest `updatedAt` on
   * the board, so the same cards always give the same order.
   */
  readonly nowMs?: number | undefined;
  /**
   * Memory the exact `holds` count may use, in 32-bit words. Past it, the rest of the
   * counts are upper bounds (a card reached along two paths counts twice).
   */
  readonly maxWords?: number | undefined;
}

/** Default memory for exact counts: 64 MB, enough for about 20,000 open linked cards. */
const SCHEDULE_MAX_WORDS = 16_000_000;

const popcount = (word: number): number => {
  let v = word - ((word >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/**
 * The blocking graph of a board, walked once: for every open card, how many open
 * cards it holds up (the whole chain) and the most urgent priority among them.
 * Done and settled cards are left out, and a backlog card waiting on another doesn't
 * count: nobody is going to do it.
 *
 * Cards in a loop of blocks are one group (Tarjan), and the groups come out waiters
 * first, so each group's set of held-up cards is the union of the sets of the groups
 * right behind it. The sets are bitsets: the cost is cards plus edges, times one
 * word per 32 open cards for each edge.
 */
function blockingGraph(cards: ReadonlyArray<KanbanCard>, maxWords: number) {
  const open: Array<KanbanCard> = [];
  const index = new Map<string, number>();
  for (const card of cards) {
    if (!isOpenCard(card) || index.has(card.id)) continue;
    index.set(card.id, open.length);
    open.push(card);
  }
  const n = open.length;
  // Edges run blocker -> waiter, stored per blocker.
  const start = new Int32Array(n + 1);
  for (const waiter of open) {
    if (waiter.priority === KANBAN_BACKLOG) continue;
    for (const id of waiter.blockedBy) {
      const blocker = index.get(id);
      if (blocker !== undefined) start[blocker + 1] = (start[blocker + 1] ?? 0) + 1;
    }
  }
  for (let i = 0; i < n; i += 1) start[i + 1] = (start[i + 1] ?? 0) + (start[i] ?? 0);
  const targets = new Int32Array(start[n] ?? 0);
  const fill = start.slice(0, n);
  for (let w = 0; w < n; w += 1) {
    const waiter = open[w]!;
    if (waiter.priority === KANBAN_BACKLOG) continue;
    for (const id of waiter.blockedBy) {
      const blocker = index.get(id);
      if (blocker === undefined) continue;
      targets[fill[blocker]!] = w;
      fill[blocker] = fill[blocker]! + 1;
    }
  }

  // Tarjan's strongly connected components, with its own stack: a chain of blocks
  // can be thousands of cards long.
  const seenAt = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const group = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const stack = new Int32Array(n);
  const callNode = new Int32Array(n);
  const callEdge = new Int32Array(n);
  let stackSize = 0;
  let counter = 0;
  let groups = 0;
  let depth = 0;
  const enter = (v: number) => {
    seenAt[v] = counter;
    low[v] = counter;
    counter += 1;
    stack[stackSize] = v;
    stackSize += 1;
    onStack[v] = 1;
    callNode[depth] = v;
    callEdge[depth] = start[v]!;
    depth += 1;
  };
  for (let root = 0; root < n; root += 1) {
    if (seenAt[root] !== -1) continue;
    enter(root);
    while (depth > 0) {
      const v = callNode[depth - 1]!;
      const edge = callEdge[depth - 1]!;
      if (edge < start[v + 1]!) {
        callEdge[depth - 1] = edge + 1;
        const w = targets[edge]!;
        if (seenAt[w] === -1) enter(w);
        else if (onStack[w] === 1 && seenAt[w]! < low[v]!) low[v] = seenAt[w]!;
        continue;
      }
      depth -= 1;
      if (low[v] === seenAt[v]) {
        for (;;) {
          stackSize -= 1;
          const member = stack[stackSize]!;
          onStack[member] = 0;
          group[member] = groups;
          if (member === v) break;
        }
        groups += 1;
      }
      if (depth > 0) {
        const parent = callNode[depth - 1]!;
        if (low[v]! < low[parent]!) low[parent] = low[v]!;
      }
    }
  }

  // Members per group. Group ids are in the order Tarjan closed them: every group a
  // group holds up has a smaller id, so one pass in id order sees waiters first.
  const memberStart = new Int32Array(groups + 1);
  for (let v = 0; v < n; v += 1) memberStart[group[v]! + 1] = memberStart[group[v]! + 1]! + 1;
  for (let g = 0; g < groups; g += 1) memberStart[g + 1] = memberStart[g + 1]! + memberStart[g]!;
  const members = new Int32Array(n);
  const memberFill = memberStart.slice(0, groups);
  for (let v = 0; v < n; v += 1) {
    const g = group[v]!;
    members[memberFill[g]!] = v;
    memberFill[g] = memberFill[g]! + 1;
  }

  const words = (n + 31) >>> 5;
  let wordsLeft = maxWords;
  /** Cards each group holds up beyond itself; null for a group that holds none, or past the memory limit. */
  const reach: Array<Uint32Array | null> = Array.from({ length: groups }, () => null);
  const held = new Int32Array(groups);
  const exact = new Uint8Array(groups).fill(1);
  /** The most urgent priority in the group, and among the cards it holds up. */
  const own = new Int32Array(groups).fill(KANBAN_BACKLOG);
  const below = new Int32Array(groups).fill(KANBAN_BACKLOG);
  const lastUnion = new Int32Array(groups).fill(-1);
  for (let g = 0; g < groups; g += 1) {
    let set: Uint32Array | null = null;
    let sum = 0;
    let isExact = true;
    for (let m = memberStart[g]!; m < memberStart[g + 1]!; m += 1) {
      const v = members[m]!;
      const priority = open[v]!.priority;
      if (priority < own[g]!) own[g] = priority;
      for (let edge = start[v]!; edge < start[v + 1]!; edge += 1) {
        const child = group[targets[edge]!]!;
        if (child === g || lastUnion[child] === g) continue;
        lastUnion[child] = g;
        const urgent = Math.min(own[child]!, below[child]!);
        if (urgent < below[g]!) below[g] = urgent;
        const size = memberStart[child + 1]! - memberStart[child]!;
        sum += held[child]! + size;
        if (exact[child] === 0) isExact = false;
        if (!isExact) continue;
        if (set === null) {
          if (wordsLeft < words) {
            isExact = false;
            continue;
          }
          wordsLeft -= words;
          set = new Uint32Array(words);
        }
        const theirs = reach[child];
        if (theirs) for (let i = 0; i < words; i += 1) set[i] = set[i]! | theirs[i]!;
        for (let c = memberStart[child]!; c < memberStart[child + 1]!; c += 1) {
          const bit = members[c]!;
          set[bit >>> 5] = set[bit >>> 5]! | (1 << (bit & 31));
        }
      }
    }
    if (isExact && set !== null) {
      let count = 0;
      for (let i = 0; i < words; i += 1) count += popcount(set[i]!);
      held[g] = count;
      reach[g] = set;
    } else if (!isExact) {
      // An upper bound: every open card but this group's own.
      held[g] = Math.min(sum, n - (memberStart[g + 1]! - memberStart[g]!));
      exact[g] = 0;
    }
  }

  return {
    open,
    /** What the card at `open[v]` holds up: the others in its loop, and everything behind it. */
    of: (v: number): KanbanBlocking => {
      const g = group[v]!;
      const card = open[v]!;
      return {
        holds: held[g]! + (memberStart[g + 1]! - memberStart[g]!) - 1,
        // A backlog card stays at the bottom whatever waits on it; only the owner takes it out.
        urgency: card.priority === KANBAN_BACKLOG ? KANBAN_BACKLOG : Math.min(own[g]!, below[g]!),
      };
    },
  };
}

/**
 * What each open card holds up. Done and settled cards are left out, and a
 * backlog card waiting on another doesn't count: nobody is going to do it.
 */
export function kanbanBlocking(cards: ReadonlyArray<KanbanCard>): Map<string, KanbanBlocking> {
  const graph = blockingGraph(cards, SCHEDULE_MAX_WORDS);
  return new Map(graph.open.map((card, v) => [card.id as string, graph.of(v)]));
}

/**
 * How every open card on a board is ranked for pick-up, from one pass over the
 * blocking graph. A card's rank starts at its urgency (its own priority, or that of
 * the most urgent card it holds up) and is lifted, never above KANBAN_BOOST_FLOOR:
 * one step when it holds up 10 open cards and two at 100, and one step for every
 * 3 days a To-Do card has been startable, at most two.
 */
export function kanbanSchedule(
  cards: ReadonlyArray<KanbanCard>,
  options: KanbanScheduleOptions = {},
): Map<string, KanbanSchedule> {
  const graph = blockingGraph(cards, options.maxWords ?? SCHEDULE_MAX_WORDS);
  const byId = new Map(cards.map((card) => [card.id as string, card]));
  let nowMs = options.nowMs;
  if (nowMs === undefined) {
    let newest = "";
    for (const card of cards) if (card.updatedAt > newest) newest = card.updatedAt;
    nowMs = newest === "" ? 0 : Date.parse(newest);
  }
  const result = new Map<string, KanbanSchedule>();
  graph.open.forEach((card, v) => {
    const blocking = graph.of(v);
    let waitingSince: string | null = card.stage === "todo" ? card.movedAt : null;
    if (waitingSince !== null) {
      for (const id of card.blockedBy) {
        const blocker = byId.get(id);
        if (blocker === undefined) continue;
        if (!KANBAN_DONE_STAGES.has(blocker.stage) || kanbanAwaitsMerge(blocker)) {
          waitingSince = null;
          break;
        }
        if (blocker.movedAt > waitingSince) waitingSince = blocker.movedAt;
      }
    }
    const waited = waitingSince === null ? 0 : nowMs - Date.parse(waitingSince);
    // A stamp that doesn't parse ages nothing, rather than poisoning the order with NaN.
    const agingSteps = Number.isFinite(waited)
      ? Math.max(0, Math.min(KANBAN_AGING_MAX_STEPS, Math.floor(waited / KANBAN_AGING_STEP_MS)))
      : 0;
    const fanoutSteps = KANBAN_FANOUT_STEPS.filter((least) => blocking.holds >= least).length;
    const rank =
      blocking.urgency <= KANBAN_BOOST_FLOOR || card.priority === KANBAN_BACKLOG
        ? blocking.urgency
        : Math.max(KANBAN_BOOST_FLOOR, blocking.urgency - fanoutSteps - agingSteps);
    result.set(card.id, { ...blocking, rank, fanoutSteps, agingSteps, waitingSince });
  });
  return result;
}

/**
 * The order todo cards get picked up in: best rank first (see kanbanSchedule:
 * a card holding up an urgent card is as urgent as that card, and holding up
 * many cards or waiting for days lifts it); then the one holding up the most
 * other cards; then the one waiting longest. The dispatcher uses it and the
 * board's To-Do column shows it.
 */
export function kanbanPickOrder(
  cards: ReadonlyArray<KanbanCard>,
  options: KanbanScheduleOptions = {},
) {
  const schedule = kanbanSchedule(cards, options);
  const of = (card: KanbanCard) => schedule.get(card.id) ?? { holds: 0, rank: card.priority };
  return (a: KanbanCard, b: KanbanCard) => {
    const x = of(a);
    const y = of(b);
    return (
      x.rank - y.rank ||
      y.holds - x.holds ||
      a.movedAt.localeCompare(b.movedAt) ||
      a.number - b.number
    );
  };
}

export interface KanbanCardFlow {
  /** Open cards that can't start until this one is done, the whole chain. */
  readonly unblocks: number;
  /** The priority it is picked at; see kanbanSchedule. Its own priority for a done card. */
  readonly rank: number;
  /** A To-Do card nothing on the card itself keeps from starting (the board's pause and pools aside). */
  readonly ready: boolean;
  /** The unfinished cards it lists as blockers, including one its own work thread does first. */
  readonly waitsOn: ReadonlyArray<KanbanCard>;
  /** The card actually holding it up, if any; see kanbanHeldUpBy. */
  readonly heldUpBy: KanbanCard | undefined;
}

/**
 * What a board shows about one card's place in the queue. `schedule` is
 * kanbanSchedule of the same cards, built once per board.
 */
export function kanbanCardFlow(
  card: KanbanCard,
  byId: ReadonlyMap<string, KanbanCard>,
  schedule: ReadonlyMap<string, KanbanSchedule>,
): KanbanCardFlow {
  const entry = schedule.get(card.id);
  const open = isOpenCard(card);
  const waitsOn = open
    ? card.blockedBy.flatMap((id) => {
        const blocker = byId.get(id);
        return blocker !== undefined &&
          (!KANBAN_DONE_STAGES.has(blocker.stage) || kanbanAwaitsMerge(blocker))
          ? [blocker]
          : [];
      })
    : [];
  const heldUpBy = open ? kanbanHeldUpBy(card, byId) : undefined;
  return {
    unblocks: entry?.holds ?? 0,
    rank: entry?.rank ?? card.priority,
    ready:
      open &&
      card.stage === "todo" &&
      card.activeThreadId === null &&
      card.stalled === null &&
      card.priority !== KANBAN_BACKLOG &&
      !kanbanWaitsOnEvaluator(card) &&
      heldUpBy === undefined,
    waitsOn,
    heldUpBy,
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

/**
 * Set on a big md, collapse or html block in a list read: the text field holds a short preview
 * and the full block comes from the message read by seq. Optional, so older decoders drop them
 * and show the preview as the block.
 */
const KanbanBlockStub = {
  truncated: Schema.optional(Schema.Boolean),
  /** UTF-8 size of the full text or html. */
  fullBytes: Schema.optional(NonNegativeInt),
};

export const KanbanBlock = Schema.Union([
  Schema.TaggedStruct("md", { text: Schema.String, ...KanbanBlockStub }),
  Schema.TaggedStruct("collapse", {
    title: TrimmedNonEmptyString,
    text: Schema.String,
    ...KanbanBlockStub,
  }),
  Schema.TaggedStruct("html", {
    html: Schema.String,
    title: Schema.NullOr(Schema.String),
    height: Schema.NullOr(PositiveInt),
    ...KanbanBlockStub,
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
  /**
   * The board feed sends its first frame before reading thread state, which waits on the
   * orchestration store: `threads` is then empty and each active thread's state follows as
   * a `thread` change. Absent or false means `threads` is complete.
   */
  threadsPending: Schema.optionalKey(Schema.Boolean),
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
