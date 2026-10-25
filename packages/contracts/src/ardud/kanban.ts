/**
 * Missions board (code name kanban): cards move through fixed stages, a
 * dispatcher starts agent threads for them from per-model pools, and
 * evaluators steer the work. Discussions are a chat store shared by owner,
 * card threads, evaluators and scripts.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
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

/** Priority 1 is the most urgent. */
export const KanbanPriority = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }));
export type KanbanPriority = typeof KanbanPriority.Type;

export const KanbanLinkKind = Schema.Literals(["pr", "linear", "url"]);
export type KanbanLinkKind = typeof KanbanLinkKind.Type;

export const KanbanLink = Schema.Struct({
  kind: KanbanLinkKind,
  url: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  /** PR state as last checked; null for links that have none. */
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

/** Every thread the board started: card work/review threads and evaluators. */
export const KanbanThreadLink = Schema.Struct({
  threadId: ThreadId,
  boardId: KanbanBoardId,
  cardId: Schema.NullOr(KanbanCardId),
  role: Schema.Literals(["work", "review", "evaluator"]),
  /** Evaluator purpose: `discussion:<id>`, `stalled`, `completed`, `deployed`, `check`, `setup`. */
  purpose: Schema.NullOr(Schema.String),
  discussionId: Schema.NullOr(KanbanDiscussionId),
  model: Schema.NullOr(ModelSelection),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanThreadLink = typeof KanbanThreadLink.Type;

export const KanbanCard = Schema.Struct({
  id: KanbanCardId,
  boardId: KanbanBoardId,
  /** Per-board sequence, shown as #12. */
  number: PositiveInt,
  title: Schema.String,
  description: Schema.String,
  prompt: Schema.String,
  stage: KanbanStage,
  priority: KanbanPriority,
  goalId: Schema.NullOr(KanbanGoalId),
  projects: Schema.Array(TrimmedNonEmptyString),
  /** Model the work thread runs on. */
  model: ModelSelection,
  /** T3 project the card's threads run in; null uses the board default. */
  projectId: Schema.NullOr(ProjectId),
  links: Schema.Array(KanbanLink),
  blockedBy: Schema.Array(KanbanCardId),
  stalled: Schema.NullOr(
    Schema.Struct({ reason: Schema.String, by: KanbanActor, at: IsoDateTime }),
  ),
  /** Set while the card sits in Needs Owner. */
  question: Schema.NullOr(Schema.String),
  /** Review chain name from the board; null uses the board default. */
  reviewChain: Schema.NullOr(TrimmedNonEmptyString),
  /** Position in the review chain while in review; reset when findings send it back. */
  reviewStep: NonNegativeInt,
  reviewRound: NonNegativeInt,
  activeThreadId: Schema.NullOr(ThreadId),
  activeRole: Schema.NullOr(Schema.Literals(["work", "review"])),
  /** Pool key (instance/model) the active thread holds a slot in. */
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
  ]),
  fromStage: Schema.NullOr(KanbanStage),
  toStage: Schema.NullOr(KanbanStage),
  body: Schema.NullOr(Schema.String),
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
  /** `instanceId/model`. */
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

export const KanbanBoard = Schema.Struct({
  id: KanbanBoardId,
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  defaultProjectId: Schema.NullOr(ProjectId),
  /** Writes titles, descriptions, goal stories and groups. */
  managerModel: ModelSelection,
  evaluatorModel: ModelSelection,
  defaultCardModel: ModelSelection,
  reviewChains: Schema.Array(KanbanReviewChain),
  defaultReviewChain: Schema.NullOr(TrimmedNonEmptyString),
  instructions: KanbanInstructions,
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanBoard = typeof KanbanBoard.Type;

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
]);
export type KanbanBlock = typeof KanbanBlock.Type;

export const KanbanAnswer = Schema.Struct({
  blockId: TrimmedNonEmptyString,
  by: KanbanActor,
  choice: Schema.Array(TrimmedNonEmptyString),
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
});
export type KanbanDiscussion = typeof KanbanDiscussion.Type;

export const KanbanScriptTrigger = Schema.Union([
  Schema.TaggedStruct("schedule", {
    everyMs: Schema.NullOr(PositiveInt),
    cron: Schema.NullOr(Schema.String),
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
  /** Absolute path; run by extension (.ts/.js with bun, .py with python3, .sh/.zsh with zsh). */
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
  lastActivityAt: Schema.NullOr(IsoDateTime),
});
export type KanbanThreadState = typeof KanbanThreadState.Type;

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

export const KanbanChange = Schema.Union([
  Schema.TaggedStruct("card", { card: KanbanCard }),
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
