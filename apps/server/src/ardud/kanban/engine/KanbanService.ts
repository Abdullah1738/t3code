import { kanbanReasonClass } from "../../analytics/McpFailureReason.ts";
import { backgroundCommandWakeKey } from "../../../orchestration-v2/backgroundCommandWake.ts";
import * as CardNextMetrics from "../../analytics/CardNextMetrics.ts";
import * as WikiReadTiming from "../../analytics/WikiReadTiming.ts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { classifyReply } from "./ownerReplies.ts";
import {
  ownerReplyDiscussion,
  ownerReplyKey,
  ownerReplyPending,
  postRecoveryIdentity,
  postRecoveryKey,
  postRecoveryPending,
} from "./ownerReplyWake.ts";
import {
  EVALUATOR_LIMITS,
  matchingCards,
  requestCardReferences,
  requestThreadIds,
} from "./evaluatorAdmission.ts";
import * as NodeUtil from "node:util";
// @effect-diagnostics nodeBuiltinImport:off - record ids only need a random UUID.
import * as NodeCrypto from "node:crypto";
import type { ThreadManagementTerminalRunStatus } from "../../../orchestration-v2/ThreadManagementService.ts";

import {
  KANBAN_BACKLOG,
  MessageId,
  type OrchestrationV2Run,
  type KanbanMoveOptions,
  KANBAN_DONE_STAGES,
  KANBAN_THREAD_STAGES,
  kanbanCardModels,
  kanbanEvaluatorStep,
  kanbanScriptStep,
  kanbanAskExpired,
  kanbanAskIsFreeText,
  kanbanAskRevision,
  kanbanNeedsOwner,
  kanbanOpenAsks,
  kanbanStepSubtasks,
  kanbanWorkStep,
  kanbanOpenStep,
  kanbanReviewAlreadyDone,
  kanbanDeciding,
  kanbanWaiting,
  kanbanWithoutDeciding,
  kanbanWithoutWait,
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  KanbanError,
  KanbanGoalId,
  type KanbanActor,
  type KanbanBlock,
  type ChatAttachment,
  type KanbanBoard,
  KanbanStandingApproval,
  type KanbanBoardListEntry,
  type KanbanBoardSnapshot,
  KanbanCard,
  type KanbanSubtask,
  type KanbanCardEvent,
  type KanbanCardModel,
  type KanbanChange,
  type KanbanDiscussion,
  type KanbanGoal,
  type KanbanGroup,
  type KanbanLink,
  type KanbanMessage,
  type KanbanAskAnswer,
  type KanbanAskFeed,
  type KanbanOwnerAsk,
  type KanbanParticipant,
  type KanbanPool,
  type KanbanStage,
  type KanbanThreadLink,
  type KanbanWait,
  type KanbanThreadRow,
  type KanbanThreadState,
  type KanbanWikiPage,
  KanbanNightlyReviewSettings,
  type KanbanNightlyReview,
  type ModelSelection,
  type AnalyticsEvent,
  type EvaluatorTrigger,
  type EvaluatorOutcome,
  type EvaluatorReuseMissReason,
  type ProviderOptionSelection,
  type ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { effortOptionId } from "@t3tools/client-runtime/ardud/models/harnessRouting";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import { nightlyLocalTime } from "./nightly.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import {
  actorKey,
  cardWrites,
  KanbanStore,
  KanbanStoreError,
  type InstructionApplication,
  type SlotEventWhy,
  type SlotEvent,
} from "../store/KanbanStore.ts";
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import * as AskFeed from "./askFeed.ts";
import * as Asks from "./asks.ts";
import { modelProblem } from "./modelCheck.ts";
import * as Briefs from "./briefs.ts";
import { bugMatches } from "./bugMatches.ts";
import { makeBoardAttachments } from "./attachments.ts";
import * as ServerConfig from "../../../config.ts";
import * as FileSystem from "effect/FileSystem";
import * as Defaults from "./defaults.ts";
import * as Retries from "./retries.ts";
import * as Rules from "./rules.ts";
import * as Scribe from "./scribe.ts";
import * as Subtasks from "./subtasks.ts";
import { applyExactEdits, type ExactEdits } from "./exactEdits.ts";
import { KanbanWaitPrs } from "./waitPrs.ts";
import * as Waits from "./waits.ts";
import * as Summaries from "./summaries.ts";
import * as Text from "./text.ts";
import * as Pages from "./messagePages.ts";
import { wikiOutline, wikiSection } from "./wikiSections.ts";
import * as BoardReplies from "./boardReplies.ts";
import * as ReplyBuilders from "../../http/ReplyBuilders.ts";
import { KanbanThreads, KanbanThreadError, queuedWakes, type KanbanThreadView } from "./threads.ts";
import { KanbanModels, isListed } from "./models.ts";
import { selectionRoutingEnabled } from "./selectionSettings.ts";
import { planCutoverCardRestore, type RestoreCutoverCardInput } from "./cutoverCards.ts";
import * as BoardLocks from "./boardLocks.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as LockedStore from "./lockedStore.ts";
import * as TickTimings from "./tickTimings.ts";
import * as SavedWrite from "./savedWrite.ts";
import * as Analytics from "../../analytics/Analytics.ts";
import * as BoardAnalytics from "./analytics.ts";
import * as EvaluatorAnalytics from "./evaluatorAnalytics.ts";
import { McpCall, resolvedContext } from "../../analytics/McpCall.ts";
import {
  askKind,
  askTimingProps,
  markAskTiming,
  type AskSurface,
  type AskChannel,
} from "../../analytics/askLatency.ts";
import {
  analyticsErrorTag,
  recordServerAnalytics,
} from "../../../observability/RpcInstrumentation.ts";

// Analytics metadata must not revoke an edit's post-save work or a dispatch claim.
function sameCardState(left: KanbanCard | null, right: KanbanCard): boolean {
  const state = (card: KanbanCard | null) => {
    if (card === null) return null;
    const { analyticsStageEnteredAt: _analyticsStageEnteredAt, ...rest } = card;
    return rest;
  };
  return NodeUtil.isDeepStrictEqual(state(left), state(right));
}

/** Typing shows while an agent's turn runs; refreshed by the tick, cleared at turn end. */
const TYPING_MS = 90_000;
export const BOARD_WRITE_START_DEADLINE_MS = BoardLocks.WRITE_WAIT_MS;

const encodeBugReportIdentity = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeWakeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isKanbanThreadError = Schema.is(KanbanThreadError);
const assignmentRolledBack = (event: KanbanCardEvent) =>
  /^Assignment wake did not complete(?:$|:)/.test(event.body ?? "") ||
  event.body === "Assignment changed after wake was accepted";

const wakeKey = (threadId: string, at: string) =>
  `wake:${NodeCrypto.createHash("sha256").update(`${threadId}|${at}`).digest("hex").slice(0, 32)}`;

/**
 * Same option list in the same order. A value that isn't a primitive compares by reference,
 * so it reads as changed and gets checked: the safe direction for a validation skip.
 */
function sameOptions(
  left: ReadonlyArray<ProviderOptionSelection>,
  right: ReadonlyArray<ProviderOptionSelection>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((option, index) => {
    const other = right[index];
    return other !== undefined && option.id === other.id && option.value === other.value;
  });
}
const OWNER_NAME = "You";
const DEFAULT_NIGHTLY_REVIEW = Schema.decodeUnknownSync(KanbanNightlyReviewSettings)({
  enabled: false,
});

type EvaluatorLaunch =
  | { readonly threadId: ThreadId }
  | { readonly queued: true; readonly queueId: number };
type EvaluatorSubmission =
  | EvaluatorLaunch
  | { readonly matched: true; readonly card: KanbanCard; readonly sightingAppended: true };

interface EvaluatorJob {
  readonly mergedKeys?: ReadonlyArray<string>;
  readonly purpose: Briefs.EvaluatorPurpose;
  readonly extra: {
    readonly trigger?: EvaluatorTrigger;
    readonly reuseMissReason?: EvaluatorReuseMissReason;
    readonly analyticsCapRecorded?: boolean;
    readonly requestBody?: string | undefined;
    readonly reporterThreadId?: ThreadId | undefined;
    readonly forceNew?: boolean | undefined;
    readonly intakeMerges?: number;
    readonly delivering?: boolean;
    readonly analyticsCardId?: string | null;
    readonly text?: string | undefined;
    readonly cardId?: KanbanCardId | null;
    readonly key?: string;
    readonly note?: boolean;
    readonly seq?: number;
    readonly answer?: EvaluatorAnswer;
    readonly recoveryPost?: { readonly discussionId: KanbanDiscussionId; readonly seq: number };
    readonly retainedDeliveryStarted?: boolean;
    readonly routingPost?: PostRoutingPost;
    readonly model?: ModelSelection;
  };
}
interface EvaluatorAnswer {
  readonly discussionId: KanbanDiscussionId;
  readonly seq: number;
  readonly blockId: string;
  readonly at: string;
  readonly choice: ReadonlyArray<string>;
  readonly text: string | null;
}
interface EvaluatorQueueRow {
  readonly id: number;
  readonly job_key: string;
  readonly board_id: string;
  readonly card_id: string | null;
  readonly json: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly thread_id: string | null;
  readonly done_at: string | null;
}

export interface NewLink {
  readonly url: string;
  readonly label?: string | null | undefined;
  readonly kind?: KanbanLink["kind"] | undefined;
}

export interface NewCard {
  readonly prompt: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly priority?: number | undefined;
  readonly goalId?: KanbanGoal["id"] | null | undefined;
  readonly projects?: ReadonlyArray<string> | undefined;
  readonly model?: ModelSelection | undefined;
  /** Weighted models to start on; wins over `model`. */
  readonly models?: ReadonlyArray<KanbanCardModel> | undefined;
  readonly projectId?: ProjectId | null | undefined;
  readonly links?: ReadonlyArray<NewLink> | undefined;
  readonly blockedBy?: ReadonlyArray<KanbanCard["id"]> | undefined;
  readonly stage?: "todo" | "needs_owner" | undefined;
  readonly question?: string | null | undefined;
  readonly reviewChain?: string | null | undefined;
  readonly subtasks?: ReadonlyArray<Subtasks.SubtaskInput> | undefined;
}

export interface CardPatch {
  readonly basedOn?: string | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly prompt?: string | undefined;
  readonly promptEdits?: typeof ExactEdits.Type | undefined;
  readonly subtaskEdits?: typeof ExactEdits.Type | undefined;
  readonly priority?: number | undefined;
  readonly goalId?: KanbanGoal["id"] | null | undefined;
  readonly projects?: ReadonlyArray<string> | undefined;
  /** One model; clears any weighted list. */
  readonly model?: ModelSelection | undefined;
  /** Weighted models to start on; wins over `model`. */
  readonly models?: ReadonlyArray<KanbanCardModel> | undefined;
  readonly projectId?: ProjectId | null | undefined;
  /** Added or relabelled by URL. */
  readonly links?: ReadonlyArray<NewLink> | undefined;
  /** Taken off by URL before `links` is applied, so both together replace a link. */
  readonly removeLinks?: ReadonlyArray<string> | undefined;
  readonly blockedBy?: ReadonlyArray<KanbanCard["id"]> | undefined;
  readonly reviewChain?: string | null | undefined;
  /** The whole plan: an id alone keeps it unchanged; done/skipped ids can't be rewritten. Open ones left out go, done ones stay. */
  readonly subtasks?: ReadonlyArray<Subtasks.SubtaskInput> | undefined;
  readonly comment?: string | undefined;
}

/** The owner's changes to a discussion; `settled: false`, `snoozedUntil: null` and `pinned: false` undo. */
export interface DiscussionPatch {
  readonly title?: string | undefined;
  readonly settled?: boolean | undefined;
  readonly snoozedUntil?: string | null | undefined;
  readonly pinned?: boolean | undefined;
}

export interface GoalInput {
  readonly id?: KanbanGoal["id"] | undefined;
  readonly name?: string | undefined;
  readonly status?: KanbanGoal["status"] | undefined;
  readonly now?: string | undefined;
  /** Appended to the numbered story. */
  readonly story?: string | undefined;
}

export type BoardPatch = {
  readonly archived?: boolean | undefined;
  readonly nightlyReview?: KanbanNightlyReviewSettings | null | undefined;
} & Partial<
  Pick<
    KanbanBoard,
    | "name"
    | "icon"
    | "iconImage"
    | "defaultProjectId"
    | "managerModel"
    | "evaluatorModel"
    | "defaultCardModel"
    | "reviewChains"
    | "defaultReviewChain"
    | "guessedGates"
    | "instructions"
  >
>;

export interface CardDetail {
  readonly card: KanbanCard;
  readonly events: ReadonlyArray<KanbanCardEvent>;
  readonly threads: ReadonlyArray<KanbanThreadLink>;
}

export interface ClaimResult {
  readonly card: KanbanCard;
  /** What the thread should do for the card: its task, facts and any waiting note. */
  readonly brief: string;
}

export interface NextCards {
  readonly carrying: ReadonlyArray<KanbanCard>;
  readonly candidates: ReadonlyArray<Rules.Candidate>;
  readonly holdsSlot: boolean;
}

export type KanbanWatchEvent =
  | { readonly _tag: "snapshot"; readonly snapshot: KanbanBoardSnapshot }
  | { readonly _tag: "change"; readonly change: KanbanChange };

export interface CardWaitInput {
  readonly on: KanbanWait["on"];
  readonly note: string;
  readonly pr?: string | null | undefined;
  /** The card to wait on, for `card`. */
  readonly card?: KanbanCard["id"] | null | undefined;
  readonly ask?: string | null | undefined;
  readonly until?: string | null | undefined;
  /** For `push`: the reviewed commit. Left out, the card's latest review event's head. */
  readonly head?: string | null | undefined;
  readonly wakeRole?: Waits.WaitRole | null | undefined;
  /** For `script`: the board script that checks it, by name. */
  readonly script?: string | null | undefined;
  /** For `script`: what the check is told. */
  readonly args?: Readonly<Record<string, unknown>> | null | undefined;
}

/** One answer of a batch (`answerWaits`). */
export interface WaitAnswerFor {
  /** The card: its id, or its number on the board. */
  readonly card: KanbanCard["id"] | number;
  readonly answer: Waits.WaitAnswer;
  /** The board script that answered; null for a wake pushed from outside the card's check. */
  readonly script: string | null;
  /** The wait the answer is for (see `answerWait`); left out: whatever wait the card has. */
  readonly expect?: string | null;
}

export type WaitAnswerOutcome =
  | { readonly ok: true; readonly cardId: KanbanCard["id"]; readonly text: string }
  | {
      readonly ok: false;
      readonly cardId: KanbanCard["id"] | null;
      readonly code: KanbanError["code"];
      readonly detail: string;
    };

const decodeStandingApproval = Schema.decodeUnknownEffect(KanbanStandingApproval);

export interface StandingApprovalInput {
  readonly action: "grant" | "revoke";
  readonly boards?: ReadonlyArray<string> | undefined;
  readonly quote?: string | undefined;
  readonly sourceThreadId?: string | undefined;
  readonly saidAt?: string | undefined;
  readonly cardId?: KanbanCardId | undefined;
  readonly ask?: string | undefined;
  readonly id?: string | undefined;
  readonly reason?: string | undefined;
}

export interface KanbanServiceShape {
  readonly ready: Effect.Effect<void>;
  readonly boards: Effect.Effect<ReadonlyArray<KanbanBoard>, KanbanError>;
  readonly withSelectionMigrationLock: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly ensureBoard: (input: {
    readonly slug: string;
    readonly name: string;
    readonly defaultProjectId: ProjectId | null;
    readonly managerModel?: ModelSelection | undefined;
    readonly evaluatorModel?: ModelSelection | undefined;
    readonly defaultCardModel?: ModelSelection | undefined;
  }) => Effect.Effect<KanbanBoard, KanbanError>;
  /**
   * The owner's create: fails with conflict when the slug is taken. The check and the insert
   * run under one lock, so two creates for the same slug cannot both succeed.
   */
  readonly createBoard: (input: {
    readonly slug: string;
    readonly name: string;
    readonly defaultProjectId: ProjectId | null;
    readonly evaluatorModel?: ModelSelection | undefined;
  }) => Effect.Effect<KanbanBoard, KanbanError>;
  readonly openBoard: (input: {
    readonly slug: string;
    readonly name: string;
    readonly defaultProjectId: ProjectId | null;
    readonly icon?: string | null | undefined;
  }) => Effect.Effect<KanbanBoard, KanbanError>;
  readonly purgeBoard: (
    boardId: KanbanBoardId,
    actor: KanbanActor,
  ) => Effect.Effect<void, KanbanError>;
  readonly updateBoard: (
    boardId: KanbanBoard["id"],
    patch: BoardPatch,
    actor?: KanbanActor,
  ) => Effect.Effect<KanbanBoard, KanbanError>;
  readonly applyApprovedInstructions: (
    boardId: KanbanBoardId,
    field: keyof KanbanBoard["instructions"],
    text: string,
    cardId: KanbanCard["id"],
    askId: string,
    actor: KanbanActor,
  ) => Effect.Effect<
    { readonly board: KanbanBoard; readonly applied: boolean; readonly reason?: string },
    KanbanError
  >;
  readonly applyApprovedSettings: (
    boardId: KanbanBoardId,
    setting: "guessedGates",
    value: NonNullable<KanbanBoard["guessedGates"]>,
    cardId: KanbanCard["id"],
    askId: string,
    actor: KanbanActor,
  ) => Effect.Effect<
    { readonly board: KanbanBoard; readonly applied: boolean; readonly reason?: string },
    KanbanError
  >;
  readonly standingApproval: (
    boardId: KanbanBoard["id"],
    input: StandingApprovalInput,
    actor: KanbanActor,
  ) => Effect.Effect<
    {
      boards: ReadonlyArray<KanbanBoard>;
      openReleaseAsks: ReadonlyArray<{ board: string; card: number; ask: string }>;
    },
    KanbanError
  >;
  readonly revokeStandingApproval: (
    boardId: KanbanBoard["id"],
    id: string | undefined,
    reason: string,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanBoard, KanbanError>;
  readonly setNightlyReview: (
    boardId: KanbanBoard["id"],
    input: {
      readonly enabled: boolean;
      readonly timeOfDay?: string | undefined;
      readonly timeZone?: string | undefined;
    },
  ) => Effect.Effect<KanbanBoard, KanbanError>;
  readonly nightlyTick: Effect.Effect<void, KanbanError>;
  readonly snapshot: (
    boardId: KanbanBoard["id"],
  ) => Effect.Effect<KanbanBoardSnapshot, KanbanError>;
  readonly replySnapshot: (
    boardId: KanbanBoard["id"],
    page?: { readonly after: number; readonly limit: number },
  ) => Effect.Effect<KanbanBoardSnapshot, KanbanError>;
  readonly cardPage: (input: {
    readonly board: KanbanBoardId;
    readonly after?: number;
    readonly limit?: number;
    readonly open?: boolean;
    readonly fields?: ReadonlyArray<string>;
  }) => Effect.Effect<
    {
      readonly cards: ReadonlyArray<Partial<KanbanCard>>;
      readonly page: {
        readonly limit: number;
        readonly hasMore: boolean;
        readonly nextAfter: number | null;
      };
    },
    KanbanError
  >;
  readonly watch: (boardId: KanbanBoard["id"]) => Stream.Stream<KanbanWatchEvent, KanbanError>;
  /** Every board with its list counts, then what changed whenever a count, board or thread does. */
  readonly boardSummaries: Stream.Stream<ReadonlyArray<KanbanBoardListEntry>, KanbanError>;
  /** Sends a change from another board service (scripts) to every watcher. */
  readonly announce: (boardId: KanbanBoard["id"], change: KanbanChange) => Effect.Effect<void>;
  /** Every board change from the moment the scope subscribes. */
  readonly changes: Effect.Effect<
    Stream.Stream<{ readonly boardId: KanbanBoard["id"]; readonly change: KanbanChange }>,
    never,
    Scope.Scope
  >;

  readonly card: (cardId: KanbanCard["id"]) => Effect.Effect<CardDetail, KanbanError>;
  /** What board activity reads for a window: every card, the window's events, the board's threads and pools. */
  readonly activity: (
    boardId: KanbanBoard["id"],
    window: { readonly since: string; readonly until: string },
  ) => Effect.Effect<
    {
      readonly board: KanbanBoard | null;
      readonly cards: ReadonlyArray<KanbanCard>;
      readonly events: ReadonlyArray<KanbanCardEvent>;
      readonly threads: ReadonlyArray<KanbanThreadLink>;
      readonly pools: ReadonlyArray<KanbanPool>;
      readonly dispatchCards: ReadonlyArray<KanbanCard>;
      readonly holds: ReadonlyMap<string, string>;
      readonly dispatchPools: ReadonlyArray<KanbanPool>;
      readonly reviews: ReadonlyMap<string, Rules.ReviewEvidence>;
      readonly workThreadHomes: ReadonlyMap<string, KanbanCard | null>;
      readonly assignmentWakeRetries: ReadonlyMap<string, Rules.AssignmentWakeRetry>;
      readonly slotHistory: {
        readonly events: ReadonlyArray<SlotEvent>;
        readonly recordedSince: string | null;
      };
      /** Each card with an event in the window: its last stage change before it. */
      readonly prior: ReadonlyArray<KanbanCardEvent>;
      readonly readinessBefore: ReadonlyArray<KanbanCardEvent>;
      readonly after: ReadonlyArray<KanbanCardEvent>;
    },
    KanbanError
  >;
  readonly cardByNumber: (
    boardId: KanbanBoard["id"],
    number: number,
  ) => Effect.Effect<KanbanCard | null, KanbanError>;
  readonly cards: (
    boardId: KanbanBoard["id"],
    options?: { readonly includeSettled: boolean },
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanError>;
  readonly createCard: (
    boardId: KanbanBoard["id"],
    input: NewCard,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  readonly editCard: (
    cardId: KanbanCard["id"],
    patch: CardPatch,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  readonly moveCard: (
    cardId: KanbanCard["id"],
    to: KanbanStage,
    role: Rules.MoveRole,
    actor: KanbanActor,
    options?: KanbanMoveOptions,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  readonly flagCard: (
    cardId: KanbanCard["id"],
    reason: string | null,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  /**
   * Sets what a card with no running thread waits on (replacing any wait it
   * had, and a stalled flag the caller may clear), or clears it with null.
   * `pr` is the PR's URL, "#544" or "repo#544" from the card's links.
   */
  readonly waitCard: (
    cardId: KanbanCard["id"],
    input: CardWaitInput | null,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  /**
   * Applies a wait check's answer to a waiting card: hold (with a status
   * line), wake or fail. `script` is the board script that answered, which
   * must be the one the card waits on; null is a wake pushed from outside the
   * check, which ends whatever wait the card has now. `expect` ties the answer
   * to one wait: the identity of the wait the check was asked about
   * (`Waits.waitIdentity`), or the `at` it was set. An answer for a wait the
   * card no longer has is refused, so a check that outlives its wait cannot end
   * the one that replaced it. Refused, with the reason, when the card has no
   * wait or a thread is running it. Returns what happened in one line.
   */
  readonly answerWait: (
    cardId: KanbanCard["id"],
    answer: Waits.WaitAnswer,
    from: { readonly script: string | null; readonly expect?: string | null },
    actor: KanbanActor,
    wired?: boolean,
  ) => Effect.Effect<string, KanbanError>;
  /**
   * `answerWait` for many cards of one board at once: a script run's answers,
   * and the hold or fail for every card it did not answer. One write, with the
   * board's cards read once for all of them. An answer that changes nothing
   * (a hold with the status the wait already shows) writes nothing. One
   * outcome per answer, in order: what happened, or why it was refused. A
   * refused answer does not stop the ones after it.
   */
  readonly answerWaits: (
    boardId: KanbanBoard["id"],
    answers: ReadonlyArray<WaitAnswerFor>,
    actor: KanbanActor,
    wired?: boolean,
  ) => Effect.Effect<ReadonlyArray<WaitAnswerOutcome>, KanbanError>;
  /** Reattaches an existing thread without starting a turn or lifting the board pause. */
  readonly restoreCutoverCard: (input: RestoreCutoverCardInput) => Effect.Effect<void, KanbanError>;
  readonly settleCard: (cardId: KanbanCard["id"]) => Effect.Effect<KanbanCard, KanbanError>;
  /**
   * Asks the owner a question on a card. A blocking ask holds the card in
   * Needs Owner (a card thread's own card must be in Working); an async one
   * leaves it where it is. Options make it a pick.
   */
  readonly askOwner: (
    cardId: KanbanCard["id"],
    input: Asks.AskFieldsInput & {
      readonly question: string;
      readonly blocking: boolean;
    },
    actor: KanbanActor,
    role: Rules.MoveRole,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  /** Makes an open ask blocking, or drops it (the asker hears it was dropped). */
  readonly changeAsk: (
    cardId: KanbanCard["id"],
    askId: string,
    action: "block" | "drop",
    actor: KanbanActor,
    role: Rules.MoveRole,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  /**
   * The asker (or an evaluator) edits an open ask. Every edit bumps its
   * revision, shows the new version in the ask's discussion and gives the
   * owner the turn back.
   */
  readonly editAsk: (
    cardId: KanbanCard["id"],
    askId: string,
    edit: Asks.AskEdit,
    actor: KanbanActor,
    role: Rules.MoveRole,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  /**
   * The owner's answer to one ask (or an evaluator's, for an ask he handed
   * over): it closes, the answer is stored on it, and whoever asked is woken
   * with the verdict, his note and the text to post. A stale ask (expired, or
   * revised since `revision`) fails with `conflict`. `heard` is false when
   * nobody but the answerer was told.
   */
  readonly answerAsk: (
    cardId: KanbanCard["id"],
    askId: string,
    input: Asks.AskAnswerInput,
    actor: KanbanActor,
    /** The refs for the secret fields he filled in privately; only the wake text carries them. */
    secrets?: Asks.AskSecretRefs,
  ) => Effect.Effect<{ readonly card: KanbanCard; readonly heard: boolean }, KanbanError>;
  readonly noteAskTiming: (
    cardId: KanbanCard["id"],
    askId: string,
    receipt:
      | { readonly type: "seen"; readonly surface: AskSurface; readonly at?: string | undefined }
      | {
          readonly type: "notified";
          readonly channel: AskChannel;
          readonly at?: string | undefined;
        },
  ) => Effect.Effect<void, KanbanError>;
  /**
   * Who may use the refs for an open ask's secret fields (`fieldIds`), and the
   * project its card's threads run in. Fails when the ask is closed or one of
   * the ids is not a secret field on it.
   */
  readonly askSecretPlan: (
    cardId: KanbanCard["id"],
    askId: string,
    fieldIds: ReadonlyArray<string>,
  ) => Effect.Effect<
    {
      readonly redeemer: Asks.AskSecretRef["redeemer"];
      readonly threadId: string | null;
      readonly projectId: ProjectId | null;
    },
    KanbanError
  >;
  /**
   * Owner words answer this ask; ambiguous choices wait for confirmation.
   * An agent reply gives the owner the turn back without closing the ask.
   */
  readonly replyOnAsk: (
    cardId: KanbanCard["id"],
    askId: string,
    actor: KanbanActor,
    blocks: ReadonlyArray<KanbanBlock>,
    role: Rules.MoveRole,
    revision?: number,
  ) => Effect.Effect<KanbanMessage, KanbanError>;
  /**
   * The owner hands one ask to the evaluator or takes it back; an evaluator
   * returns it. `always` marks a hand-over as "and asks like it from now on".
   */
  readonly handAsk: (
    cardId: KanbanCard["id"],
    askId: string,
    action: "hand" | "take_back" | "return",
    actor: KanbanActor,
    always?: boolean,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  /**
   * The owner puts one ask away until a time, or (null) takes the snooze off.
   * The ask stays open and keeps holding its card; no thread is told.
   */
  readonly snoozeAsk: (
    cardId: KanbanCard["id"],
    askId: string,
    until: string | null,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  /** Records the evaluator thread an "every time" hand-over started, while the ask is still handed. */
  readonly noteHandEvaluator: (
    cardId: KanbanCard["id"],
    askId: string,
    threadId: ThreadId,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  /** One ask, open or closed, with its blocks whole (the card holds big ones as stubs). */
  readonly askDetail: (
    cardId: KanbanCard["id"],
    askId: string,
  ) => Effect.Effect<
    {
      readonly boardId: KanbanBoard["id"];
      readonly cardId: KanbanCard["id"];
      readonly cardNumber: number;
      readonly discussionId: KanbanCard["discussionId"];
      readonly ask: KanbanOwnerAsk;
    },
    KanbanError
  >;
  /** Every open ask across boards (or on one), with an optional window of closed ones. */
  readonly askFeed: (input: AskFeed.AskFeedInput) => Effect.Effect<KanbanAskFeed, KanbanError>;
  /** Marks a subtask done, skipped (with why) or, for evaluators and the owner, open again. */
  readonly markSubtask: (
    cardId: KanbanCard["id"],
    subtaskId: string,
    state: "open" | "done" | "skipped",
    note: string | null,
    actor: KanbanActor,
    role: Subtasks.SubtaskRole,
    releasedAt?: string,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  /**
   * A board script hands its open subtask back to the card's evaluator with
   * what failed: the subtask becomes the evaluator's and the evaluator is
   * woken once, with the note.
   */
  readonly handBack: (
    cardId: KanbanCard["id"],
    subtaskId: string,
    note: string,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanCard, KanbanError>;
  /** `head` is the reviewed commit, stored on the review event. */
  readonly reviewResult: (
    threadId: ThreadId,
    verdict: "clear" | "findings",
    findings: ReadonlyArray<string>,
    head?: string | null,
  ) => Effect.Effect<
    { readonly card: KanbanCard; readonly recorded: boolean; readonly note?: string },
    KanbanError
  >;
  readonly cardThread: (
    cardId: KanbanCard["id"],
    action: "steer" | "stop" | "wake" | "reset",
    text: string,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanCard, KanbanError>;

  /**
   * Sets one pool's slots. With `replaces` (a pool key), that pool moves to `model`'s level
   * and its open cards follow; `slots` undefined keeps its slot count.
   */
  readonly setPool: (
    boardId: KanbanBoard["id"],
    model: ModelSelection,
    slots: number | undefined,
    options?: { readonly replaces?: string | undefined },
  ) => Effect.Effect<ReadonlyArray<KanbanPool>, KanbanError>;
  readonly removePool: (
    boardId: KanbanBoard["id"],
    model: ModelSelection,
    options?: { readonly replaces?: string | undefined },
  ) => Effect.Effect<ReadonlyArray<KanbanPool>, KanbanError>;
  readonly setGoal: (
    boardId: KanbanBoard["id"],
    input: GoalInput,
  ) => Effect.Effect<KanbanGoal, KanbanError>;
  readonly setGroups: (
    boardId: KanbanBoard["id"],
    groups: ReadonlyArray<Omit<KanbanGroup, "updatedAt">>,
  ) => Effect.Effect<void, KanbanError>;

  readonly discussions: (
    boardId: KanbanBoard["id"],
  ) => Effect.Effect<ReadonlyArray<KanbanDiscussion>, KanbanError>;
  /** Every thread a board started (work, review, evaluator), open or ended. */
  readonly threads: (
    boardId: KanbanBoard["id"],
  ) => Effect.Effect<ReadonlyArray<KanbanThreadRow>, KanbanError>;
  readonly discussion: (id: KanbanDiscussion["id"]) => Effect.Effect<KanbanDiscussion, KanbanError>;
  readonly createDiscussion: (
    boardId: KanbanBoard["id"],
    title: string,
    actor: KanbanActor,
    blocks?: ReadonlyArray<KanbanBlock>,
  ) => Effect.Effect<KanbanDiscussion, KanbanError>;
  /** Owner only: rename, settle, snooze or pin a discussion. */
  readonly updateDiscussion: (
    discussionId: KanbanDiscussion["id"],
    patch: DiscussionPatch,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanDiscussion, KanbanError>;
  readonly cardDiscussion: (
    cardId: KanbanCard["id"],
  ) => Effect.Effect<KanbanDiscussion, KanbanError>;
  /**
   * The newest messages after `afterSeq` and before `beforeSeq`, oldest first, cut by count
   * and by encoded size (never empty while any match). List reads stub big blocks; `full`
   * keeps them whole for agents, under its own `maxBytes`.
   */
  readonly messages: (
    id: KanbanDiscussion["id"],
    options?: MessagePageOptions,
  ) => Effect.Effect<ReadonlyArray<KanbanMessage>, KanbanError>;
  /** One message with every block in full. */
  readonly message: (
    id: KanbanDiscussion["id"],
    seq: number,
  ) => Effect.Effect<KanbanMessage, KanbanError>;
  /** Absolute path an agent can open for a board attachment, or null. */
  readonly attachmentPath: (attachment: ChatAttachment) => string | null;
  readonly post: (
    discussionId: KanbanDiscussion["id"],
    author: KanbanActor,
    blocks: ReadonlyArray<KanbanBlock>,
  ) => Effect.Effect<KanbanMessage, KanbanError>;
  readonly postToCard: (
    cardId: KanbanCard["id"],
    author: KanbanActor,
    blocks: ReadonlyArray<KanbanBlock>,
  ) => Effect.Effect<KanbanMessage, KanbanError>;
  readonly answer: (
    discussionId: KanbanDiscussion["id"],
    seq: number,
    blockId: string,
    choice: ReadonlyArray<string>,
    by: KanbanActor,
    text?: string | null,
  ) => Effect.Effect<KanbanMessage, KanbanError>;
  readonly markRead: (
    discussionId: KanbanDiscussion["id"],
    actor: KanbanActor,
    seq: number,
  ) => Effect.Effect<void, KanbanError>;
  readonly markReadSoon: (
    discussionId: KanbanDiscussion["id"],
    actor: KanbanActor,
    seq: number,
  ) => Effect.Effect<void>;

  readonly wiki: (
    boardId: KanbanBoard["id"],
    options?: {
      readonly slug?: string | undefined;
      readonly slugs?: ReadonlyArray<string> | undefined;
      readonly section?: string | undefined;
      readonly outline?: boolean | undefined;
    },
  ) => Effect.Effect<ReadonlyArray<KanbanWikiPage & { readonly note?: string }>, KanbanError>;
  readonly wikiIndex: (
    boardId: KanbanBoard["id"],
  ) => Effect.Effect<Effect.Success<ReturnType<KanbanStore["Service"]["wikiIndex"]>>, KanbanError>;
  readonly writeWiki: (
    boardId: KanbanBoard["id"],
    page: {
      readonly slug: string;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
      readonly edits?:
        | ReadonlyArray<{
            readonly oldString: string;
            readonly newString: string;
            readonly count?: number | undefined;
          }>
        | undefined;
    },
    actor: KanbanActor,
  ) => Effect.Effect<KanbanWikiPage, KanbanError>;

  /**
   * The owner's "Start setup": saves the evaluator model, starts the setup evaluator
   * and returns the Setup discussion it talks in. Refused while setup already runs.
   */
  readonly startSetup: (
    boardId: KanbanBoard["id"],
    input: { readonly evaluatorModel: ModelSelection; readonly text?: string | undefined },
  ) => Effect.Effect<{ readonly discussionId: KanbanDiscussionId }, KanbanError>;
  /**
   * Ends a board's running setup: the owner's "End setup" (actor owner) or the
   * setup evaluator's setup_done (actor evaluator, only its own thread).
   */
  readonly endSetup: (
    boardId: KanbanBoard["id"],
    actor: KanbanActor,
  ) => Effect.Effect<KanbanBoard, KanbanError>;
  readonly pauseBoard: (
    boardId: KanbanBoard["id"],
    pause: { readonly reason: string; readonly keep: ReadonlyArray<KanbanCardId> } | null,
    actor: KanbanActor,
    callerAncestors?: ReadonlyArray<string>,
  ) => Effect.Effect<KanbanBoard, KanbanError>;
  /**
   * Starts an evaluator thread for a board job (setup, owner request, sweeps).
   * A running sweep of the same kind is refused (conflict) and named.
   */
  readonly startEvaluator: (
    boardId: KanbanBoard["id"],
    purpose: Briefs.EvaluatorPurpose,
    text?: string,
  ) => Effect.Effect<ThreadId, KanbanError>;
  readonly submitEvaluator: (
    boardId: KanbanBoard["id"],
    purpose: Briefs.EvaluatorPurpose,
    options?: {
      readonly text?: string;
      readonly matchText?: string;
      readonly callerThreadId?: ThreadId;
      readonly forceNew?: boolean | undefined;
    },
  ) => Effect.Effect<EvaluatorSubmission, KanbanError>;
  readonly evaluatorStatus: (
    boardId: KanbanBoardId,
    handle: { readonly queueId?: number; readonly threadId?: string },
  ) => Effect.Effect<
    {
      readonly saved: boolean;
      readonly queued: boolean;
      readonly queueId?: number;
      readonly threadId?: ThreadId;
      readonly cards: ReadonlyArray<Pick<KanbanCard, "id" | "number" | "title" | "stage">>;
    },
    KanbanError
  >;
  readonly reportBug: (input: {
    readonly boardId: string;
    readonly threadId: ThreadId;
    readonly title: string;
    readonly evidence: string;
    readonly cardHint?: string | undefined;
    readonly callerUnverifiedReason?: SavedWrite.UnverifiedReporterReason | undefined;
  }) => Effect.Effect<
    {
      readonly appendedTo?: string;
      readonly deduped?: boolean;
      readonly candidates?: ReadonlyArray<{
        readonly id: KanbanCardId;
        readonly number: number;
        readonly title: string;
        readonly score: number;
      }>;
      readonly threadId?: ThreadId;
      readonly queued?: boolean;
      readonly queueId?: number;
    },
    KanbanError
  >;
  readonly resolveBoard: (
    threadId: ThreadId,
    input: {
      readonly boardId?: string | undefined;
      readonly card?: string | undefined;
      readonly discussionId?: string | undefined;
    },
  ) => Effect.Effect<KanbanBoard, KanbanError>;
  /** Coordinate a board tool request with provisional assignment delivery. */
  readonly agentCall: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | KanbanError, R>;
  /** The board link of a calling thread, or null for threads the board did not start. */
  readonly callerAnalytics?: NonNullable<KanbanStore["Service"]["callerAnalytics"]>;
  readonly caller: (threadId: string) => Effect.Effect<KanbanThreadLink | null, KanbanError>;
  /** Cards a work thread is working on right now. */
  readonly carried: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanError>;
  /** Cards a work thread took that are still its own, working or not, in the order it took them. */
  readonly ownCards: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanError>;
  /** A work thread takes a todo card into its own run (same pool and project). */
  readonly claimCard: (
    threadId: ThreadId,
    cardId: KanbanCard["id"],
  ) => Effect.Effect<ClaimResult, KanbanError>;
  /** Creates and takes a card atomically; evaluator assignments also queue its brief. */
  readonly createForThread: (
    threadId: ThreadId,
    input: NewCard,
    assignment?: {
      readonly boardId: KanbanBoard["id"];
      readonly actor: Extract<KanbanActor, { _tag: "evaluator" }>;
    },
  ) => Effect.Effect<ClaimResult, KanbanError>;
  /** Related todo cards a work thread could take next, with why. */
  readonly nextCards: (threadId: ThreadId) => Effect.Effect<NextCards, KanbanError>;

  /** Runs dispatch for every board now. */
  readonly dispatchNow: Effect.Effect<void, KanbanError>;
  /** Handles a finished turn of a board thread now. */
  readonly turnEnded: (
    threadId: ThreadId,
    startTimeout?: StartTimeout,
  ) => Effect.Effect<void, KanbanError>;
  readonly reconcileRunCancellation: (
    threadId: ThreadId,
    runId: string,
  ) => Effect.Effect<void, KanbanError>;
  readonly notifyRunCancellation: (threadId: ThreadId, runId: string) => Effect.Effect<void>;
  /** Periodic upkeep: typing heartbeat, PR states, dispatch. */
  readonly tick: Effect.Effect<void, KanbanError>;
  /** Probes the models paused threads wait on and wakes them when one answers. */
  readonly probeOutages: Effect.Effect<void, KanbanError>;
  /** Queues a finished turn for the worker. */
  readonly notifyTurnEnded: (
    threadId: ThreadId,
    startTimeout?: StartTimeout,
  ) => Effect.Effect<void>;
  /**
   * Something changed a thread (a run, a message, a request), from the board or
   * anywhere else: stale reruns read it again instead of replaying.
   */
  readonly threadEvent: (threadId: string) => Effect.Effect<void>;
  /** Announces a board thread's live state (running, needs input) as it changes mid-turn. */
  readonly notifyThreadChanged: (threadId: ThreadId) => Effect.Effect<void, KanbanError>;
  /** Background worker: runs queued dispatch kicks and turn ends; never returns. */
  readonly worker: Effect.Effect<never>;
}

export class KanbanService extends Context.Service<KanbanService, KanbanServiceShape>()(
  "t3/ardud/kanban/engine/KanbanService",
) {}

interface StartTimeout {
  readonly restartAdmission?: boolean;
  readonly runId: string;
  readonly reason: string;
}
type Job =
  | { readonly _tag: "kick" }
  | { readonly _tag: "cancelReason"; readonly threadId: ThreadId; readonly runId: string }
  | { readonly _tag: "turnEnd"; readonly threadId: ThreadId; readonly startTimeout?: StartTimeout };

/** A slot a work thread keeps between cards (see `holds`). */
interface Hold {
  readonly boardId: string;
  readonly pool: string;
  readonly at: number;
  // Superseded accepted work occupies capacity until its turn finishes.
  readonly preservedTurn?: true;
}

// A held slot is meant to last to the end of the thread's turn; past this a
// stuck thread gives it back.
const HOLD_MAX_MS = 30 * 60_000;
const holdIsLive = (held: Hold, view: KanbanThreadView | null, now: number) =>
  view !== null &&
  view.state !== "idle" &&
  (held.preservedTurn === true || now - held.at <= HOLD_MAX_MS);
/** Thread views the wait pass reads at once, in its one read outside the gate. */
const WAIT_VIEW_READS = 8;
const waitingToRun = (card: KanbanCard, now: number) =>
  card.activeThreadId === null &&
  (Retries.heldForRetry(card, now) || (Waits.WAITS_ENGINE_WIRED && kanbanWaiting(card)));
const withoutDetachedSteer = (card: KanbanCard) => {
  if (card.detachedSteerAt === undefined) return card;
  const { detachedSteerAt: _steer, ...rest } = card;
  return rest;
};
// An evaluator turn that has run this long is asked for a one-line status, then again every hour.
const STATUS_FIRST_MS = 45 * 60_000;
const STATUS_EVERY_MS = 60 * 60_000;
const EVALUATOR_ERRORS_TITLE = "Evaluator errors";
// The approved legacy Sol xhigh route maps to native Codex. Keep the replacement in standard mode.
const REFUSAL_EVALUATOR_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [
    { id: "reasoningEffort", value: "xhigh" },
    { id: "serviceTier", value: "default" },
  ],
};
// A todo card whose step is only evaluator subtasks (its packet) nobody has done
// gets its evaluator woken once: a card made by an evaluator wakes nobody else.
const STEP_WAIT_P1_MS = 15 * 60_000;
const STEP_WAIT_MS = 60 * 60_000;
const waitingOnSystemStall = (card: KanbanCard) =>
  card.stalled?.by._tag === "system" &&
  card.activeThreadId === null &&
  card.settledAt === null &&
  card.priority !== KANBAN_BACKLOG &&
  !Waits.waitSkipsNudge(card) &&
  !Waits.decidingHolds(card);
const stallWakeMarker = (at: string) => `System stall surfaced to evaluator (flagged ${at})`;
const STALL_WAKE_PREFIX = "kanban-stall:";
const stallWakeKey = (card: KanbanCard) => `${STALL_WAKE_PREFIX}${card.id}:${card.stalled!.at}`;
const systemStallDue = (card: KanbanCard, now: number) =>
  waitingOnSystemStall(card) &&
  now - Date.parse(card.stalled!.at) >= (card.priority === 1 ? STEP_WAIT_P1_MS : STEP_WAIT_MS);
const waitingOnEvaluatorStep = (card: KanbanCard) =>
  card.stage === "todo" &&
  !kanbanWorkStep(card) &&
  card.priority !== KANBAN_BACKLOG &&
  card.settledAt === null &&
  card.activeThreadId === null &&
  card.stalled?.by._tag !== "evaluator" &&
  // Parked on a wait: its evaluator is told when that ends, not reminded meanwhile.
  !Waits.waitSkipsNudge(card) &&
  // Held for its evaluator, who was just told: no second reminder while it decides.
  !Waits.decidingHolds(card) &&
  kanbanEvaluatorStep(card);
// An owner message a running evaluator hasn't answered gets one reminder; its turn
// end covers an idle evaluator, so the tick doesn't double it.
const OWNER_WAIT_MS = 15 * 60_000;
const POST_RECOVERY_MS = 3 * 60_000;
// A Now someone wrote this recently (an evaluator, by hand) is not overwritten by the scribe.
const SCRIBE_KEEPS_NOW_MS = 5 * 60_000;

const DISCUSSION_TITLE_MAX = 80;
export interface MessagePageOptions {
  readonly afterSeq?: number;
  readonly beforeSeq?: number;
  /** Default 50 for list reads, 200 for full ones; never more than 200. */
  readonly limit?: number;
  /** Big blocks whole (agent reads); list reads send them as stubs. */
  readonly full?: boolean;
  readonly maxBytes?: number;
}

/** Past this many messages a discussion has long had the owner's first one. */
const TITLE_SCAN_MAX = 20;

const WriterOutput = Schema.Struct({ title: Schema.String, description: Schema.String });
const ProbeOutput = Schema.Struct({ ok: Schema.Boolean });

const uuid = () => NodeCrypto.randomUUID();

const failWith = (
  code: KanbanError["code"],
  detail: string,
  reason: NonNullable<KanbanError["reason"]> = code === "not-found"
    ? "resource_not_found"
    : code === "conflict"
      ? "conflict"
      : code === "failed"
        ? "operation_failed"
        : "invalid_args",
  reasonClass: NonNullable<KanbanError["reasonClass"]> = kanbanReasonClass(code, reason),
  invalidField?: string,
) =>
  Effect.fail(
    new KanbanError({
      code,
      detail,
      reason,
      reasonClass,
      ...(invalidField === undefined ? {} : { invalidField }),
    }),
  );

/** A refused answer, with the revision the ask is at when that is why. */
const failAnswer = (problem: Asks.AskProblem) =>
  Effect.fail(
    new KanbanError({
      code: problem.code,
      detail: problem.detail,
      reason: "invalid_args",
      reasonClass: problem.reasonClass ?? kanbanReasonClass(problem.code),
      ...(problem.invalidField === undefined ? {} : { invalidField: problem.invalidField }),
      ...(problem.revision === undefined ? {} : { revision: problem.revision }),
    }),
  );

const checkText = (fields: ReadonlyArray<readonly [string, string | null | undefined]>) => {
  const problem = Text.textProblem(fields);
  return problem ? failWith("invalid", problem) : Effect.void;
};

const cardTextFields = (input: NewCard | CardPatch) =>
  [
    ["title", input.title],
    ["description", input.description],
    ["prompt", input.prompt],
    ...("question" in input ? [["question", input.question] as const] : []),
    ...("comment" in input ? [["comment", input.comment] as const] : []),
    ...(input.subtasks ?? []).flatMap(
      (subtask) =>
        [
          ["subtask text", subtask.text],
          ["clearGate reason", subtask.clearGate],
        ] as const,
    ),
  ] as const;

const normalizeMessageBlock = (block: KanbanBlock): KanbanBlock => {
  // Stub marks belong to list reads; a stored block is always whole.
  if (block._tag === "md" || block._tag === "collapse" || block._tag === "html") {
    const { truncated: _truncated, fullBytes: _fullBytes, ...whole } = block;
    return whole._tag === "collapse" ? { ...whole, title: whole.title.trim() } : whole;
  }
  if (block._tag === "choice") {
    return {
      ...block,
      question: block.question.trim(),
      options: block.options.map((option) => ({ ...option, label: option.label.trim() })),
    };
  }
  return block;
};

export const messageTextFields = (blocks: ReadonlyArray<KanbanBlock>) => {
  const fields: Array<readonly [string, string | null]> = [];
  for (const block of blocks) {
    switch (block._tag) {
      case "md":
        fields.push(["message", block.text]);
        break;
      case "collapse":
        fields.push(["message", block.title], ["message", block.text]);
        break;
      case "html":
        fields.push(["message", block.html], ["message", block.title]);
        break;
      case "choice":
        fields.push(["message", block.question]);
        for (const option of block.options) fields.push(["message", option.label]);
        break;
      case "image":
        fields.push(["message", block.alt]);
        break;
    }
  }
  return fields;
};

const isKanbanError = Schema.is(KanbanError);
const isKanbanStoreError = Schema.is(KanbanStoreError);

const toKanbanError = (error: unknown): KanbanError => {
  if (isKanbanError(error)) return error;
  if (isKanbanStoreError(error) && isKanbanError(error.cause)) return error.cause;
  const detail =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : String(error);
  return new KanbanError({ code: "failed", detail });
};

const clampPriority = (value: number | undefined, fallback: number) => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(KANBAN_BACKLOG, Math.max(1, Math.round(value)));
};

const linkKind = (url: string): KanbanLink["kind"] => {
  if (parseChangeRequestUrl(url) !== null) return "pr";
  if (/linear\.app\//.test(url)) return "linear";
  return "url";
};

export const mergeLinks = (
  existing: ReadonlyArray<KanbanLink>,
  added: ReadonlyArray<NewLink>,
): ReadonlyArray<KanbanLink> => {
  const next = [...existing];
  for (const input of added) {
    const url = input.url.trim();
    if (url.length === 0) continue;
    const index = next.findIndex((link) => link.url === url);
    if (index >= 0) {
      const current = next[index]!;
      next[index] = { ...current, label: input.label ?? current.label };
      continue;
    }
    next.push({
      kind: input.kind ?? linkKind(url),
      url,
      label: input.label ?? null,
      state: null,
      checkedAt: null,
    });
  }
  return next;
};

const RETRY_WINDOW_MS = 10 * 60_000;

const isRetryActor = (actor: KanbanActor) => actor._tag === "thread" || actor._tag === "evaluator";

const withinRetryWindow = (at: string, nowMs: number) => {
  return nowMs - Date.parse(at) <= RETRY_WINDOW_MS;
};

export const editRepeats = (
  card: KanbanCard,
  patch: CardPatch,
  events: ReadonlyArray<KanbanCardEvent>,
  actor: KanbanActor,
  nowMs: number,
): boolean => {
  if (!isRetryActor(actor)) return false;
  const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (
    fields.length === 0 ||
    fields.some(([key]) => !["description", "links", "comment"].includes(key))
  ) {
    return false;
  }
  if (patch.description !== undefined && patch.description.trim() !== card.description)
    return false;
  for (const link of patch.links ?? []) {
    const url = link.url.trim();
    if (!url) continue;
    const existing = card.links.find((entry) => entry.url === url);
    if (!existing || (link.label !== undefined && link.label !== existing.label)) return false;
  }
  const comment = patch.comment?.trim();
  if (comment) {
    const last = events.at(-1);
    if (
      !last ||
      last.kind !== "comment" ||
      actorKey(last.actor) !== actorKey(actor) ||
      last.body !== comment ||
      !withinRetryWindow(last.at, nowMs)
    )
      return false;
  }
  return true;
};

const fallbackTitle = (prompt: string) => {
  const first = prompt.trim().split("\n")[0] ?? "";
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}...` : first || "Untitled";
};

const formatFileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Plain text of a message for agents; `pathOf` gives an attachment's absolute path. */
export const blocksText = (
  blocks: ReadonlyArray<KanbanBlock>,
  pathOf: (attachment: ChatAttachment) => string | null,
) =>
  blocks
    .map((block) => {
      switch (block._tag) {
        case "md":
          return block.text;
        case "collapse":
          return `${block.title}\n${block.text}`;
        case "html":
          return `[visual${block.title ? `: ${block.title}` : ""}]`;
        case "choice":
          return `${block.question} (${block.multi ? "pick any" : "pick one"}: ${block.options.map((option) => `${option.id} = ${option.label}`).join(", ")})`;
        case "card":
          return `[card ${block.cardId}]`;
        case "image":
          return `[image${block.alt ? `: ${block.alt}` : ""}]`;
        case "attachment": {
          const { attachment } = block;
          const path = pathOf(attachment) ?? "unavailable";
          return attachment.type === "image"
            ? `[image ${attachment.name}: ${path}]`
            : `[file ${attachment.name}, ${formatFileSize(attachment.sizeBytes)}: ${path}]`;
        }
      }
    })
    .join("\n\n");

/** A post wants an answer: a choice, a question mark ending a sentence, or a call for the evaluator. */
export const asksSomething = (blocks: ReadonlyArray<KanbanBlock>, text: string) =>
  blocks.some((block) => block._tag === "choice") ||
  /\?(\s|$)/.test(text) ||
  /\bevaluator\b/i.test(text);

const roleName = (role: KanbanThreadLink["role"]) =>
  role === "work" ? "Worker" : role === "review" ? "Reviewer" : "Evaluator";

const withDefaultLevel = (selection: ModelSelection, fallback: ModelSelection): ModelSelection => {
  if (
    Rules.modelLevel(selection) !== null ||
    Rules.modelKey(selection) !== Rules.modelKey(fallback)
  ) {
    return selection;
  }
  const effortId = effortOptionId(fallback.instanceId);
  if (selection.options?.some((option) => option.id === effortId)) return selection;
  const effort = fallback.options?.find((option) => option.id === effortId);
  return effort === undefined
    ? selection
    : { ...selection, options: [...(selection.options ?? []), effort] };
};

const collapseEvaluatorReplies = Context.Reference<boolean>("KanbanCollapseEvaluatorReplies", {
  defaultValue: () => false,
});

const ownerDeliveryKey = Context.Reference<string | undefined>("KanbanOwnerDeliveryKey", {
  defaultValue: () => undefined,
});
const evaluatorAnswer = Context.Reference<EvaluatorAnswer | undefined>("KanbanEvaluatorAnswer", {
  defaultValue: () => undefined,
});

const ownerDelivered = Context.Reference<Set<string> | undefined>("KanbanOwnerDelivered", {
  defaultValue: () => undefined,
});

/** The durable route row a delivery attempt works for; launches record their thread on it. */
const ownerRouteRow = Context.Reference<number | undefined>("KanbanOwnerRouteRow", {
  defaultValue: () => undefined,
});

/**
 * How owner answers and posts reach their agents.
 * - `deferred` (production): the reply returns once the answer or post and its
 *   route row are committed; delivery runs in the background and replays after a restart.
 * - `await`: the same durable route row and drain, but the reply waits for the
 *   first delivery attempt (the default, so tests observe delivery synchronously).
 * - `inline`: the pre-durable path with no route row (rollback:
 *   `ROBOB_KANBAN_INLINE_OWNER_ROUTES=1`).
 */
export type OwnerRouteMode = "deferred" | "await" | "inline";
/** A route still failing after this long is closed as undeliverable, with a notice. */
const OWNER_ROUTE_GIVE_UP_MS = 10 * 60_000;
/**
 * Run states after which a thread no longer acts on its instruction: thread
 * management's terminal states, kept exhaustive by the record's key type.
 */
const FINISHED_RUN: Record<ThreadManagementTerminalRunStatus, true> = {
  completed: true,
  failed: true,
  cancelled: true,
  interrupted: true,
  rolled_back: true,
};
const FINISHED_RUN_STATUSES: ReadonlySet<string> = new Set(Object.keys(FINISHED_RUN));
/** How long a durable owner post's title write may hold its discussion's drain. */
const OWNER_ROUTE_TITLE_DEADLINE = "20 seconds";
/** `noticed` value of a route whose give-up is decided but whose notice may not be posted yet. */
const OWNER_ROUTE_GIVING_UP = 2;
/** Whether stale reruns reuse their earlier attempt's thread reads (see `BoardLocks.outsideRead`). */
export const ReplayReads = Context.Reference<boolean>("KanbanReplayReads", {
  defaultValue: () => true,
});
/**
 * Whether card and discussion writes reply on commit and leave their thread
 * follow-ons to the route drains (see `guardDeferred`). Needs a durable route mode.
 */
export const DeferWriteEffects = Context.Reference<boolean>("KanbanDeferWriteEffects", {
  defaultValue: () => true,
});
export const OwnerRouteMode = Context.Reference<OwnerRouteMode>("KanbanOwnerRouteMode", {
  defaultValue: () => "await",
});
const effectRouteReads = Context.Reference("KanbanEffectRouteReads", {
  defaultValue: () => false,
});

interface OwnerRoutePost {
  readonly kind: "post";
  readonly seq: number;
  readonly createdAt: string;
  /** Older rows are owner posts. */
  readonly authorKind?: "owner" | "script";
  readonly cardId?: KanbanCardId | null;
  /** The discussion's title is written from this post once its route is delivered. */
  readonly writeTitle?: boolean;
}
interface PostRoutingPost {
  readonly discussionId: KanbanDiscussionId;
  readonly seq: number;
  readonly authorKind: KanbanActor["_tag"];
}
interface PostRoutingTarget {
  target: "live_thread" | "steer" | "start" | "none";
  readonly post: PostRoutingPost;
  phase?: string;
  threadId?: ThreadId;
  boardId?: KanbanBoardId;
  cardId?: KanbanCardId | null;
  outcome?: EvaluatorOutcome;
}
const postRoutingTarget = Context.Reference<PostRoutingTarget | undefined>(
  "KanbanPostRoutingTarget",
  {
    defaultValue: () => undefined,
  },
);
const recoveryPost = Context.Reference<EvaluatorJob["extra"]["recoveryPost"]>(
  "KanbanRecoveryPost",
  {
    defaultValue: () => undefined,
  },
);
interface OwnerRouteAnswer {
  readonly kind: "answer";
  readonly seq: number;
  readonly blockId: string;
  readonly at: string;
  readonly note: string;
  /** What was answered; two answers in the same millisecond still differ here. */
  readonly choice?: ReadonlyArray<string>;
  readonly text?: string | null;
}
/**
 * A follow-on of a board write that talks to a thread (or reads one to decide
 * whether to). Saved as its own route row after the write commits and run by
 * the lane's drain, so the write replies without waiting on thread I/O.
 */
/** A stop or a drop/pause note saved for a thread and not yet run (see `pendingStops`). */
type PendingRelease =
  | { readonly kind: "interrupt"; readonly reason: string; readonly cancelQueued?: boolean }
  | { readonly kind: "note"; readonly text: string; readonly mode?: "steer" };
type SentStopTarget =
  | { readonly runId: string; readonly messageId?: never }
  | { readonly messageId: string; readonly runId?: never };
type BoardEffectBody =
  | { readonly kind: "assignment"; readonly cardId: KanbanCardId; readonly threadId: string }
  | {
      readonly kind: "send";
      readonly threadId: string;
      readonly text: string;
      /** Re-read a plan notification at delivery, including its worker eligibility. */
      readonly planCardId?: KanbanCardId;
      /** Inline only, a failed send is dropped as before; a saved one retries like any other. */
      readonly bestEffort?: boolean;
    }
  | {
      readonly kind: "interrupt";
      readonly threadId: string;
      readonly reason: string;
      readonly cancelQueued?: boolean;
    }
  | ({ readonly kind: "stopSend"; readonly threadId: string } & SentStopTarget)
  /**
   * A card taken off a thread that keeps other cards (drop or pause note).
   * Pending like a stop: it reaches the thread before anything the board
   * sends or attaches to it next, so it can't land after the thread takes
   * the card again.
   */
  | {
      readonly kind: "release";
      readonly threadId: string;
      readonly text: string;
      readonly mode?: "steer";
    }
  /** A card's new model on its open work thread; a failed switch is retried. */
  | { readonly kind: "setModel"; readonly threadId: string; readonly model: ModelSelection }
  /** Sent only while the evaluator thread is live, as a dropped ask's note. */
  | { readonly kind: "tellEvaluator"; readonly threadId: string; readonly text: string }
  | {
      readonly kind: "toEvaluator";
      readonly discussionId: string;
      readonly text: string;
      readonly note: boolean;
      readonly authorThreadId?: string;
      /** The card is held for this evaluator's decision (`deciding`): delivery marks it told. */
      readonly decides?: boolean;
    }
  | {
      readonly kind: "evaluatorTurn";
      readonly before: KanbanCard | null;
      readonly after: KanbanCard;
      readonly actor: KanbanActor;
    }
  | ({ readonly kind: "tellAnswered" } & AnsweredNotice)
  | { readonly kind: "syncPrs"; readonly cardId: string }
  | { readonly kind: "noteDiscussion"; readonly cardId: string; readonly text: string };
type BoardEffect = BoardEffectBody & {
  readonly evaluatorTrigger?: EvaluatorTrigger;
  readonly evaluatorCardId?: string | null;
};
interface OwnerRouteEffect {
  readonly kind: "effect";
  readonly effect: BoardEffect;
  /**
   * Downgrade guard: builds before this payload read any non-post row as an
   * answer at `seq`. No message has seq -1, so they close it as not-saved at
   * once instead of retrying it at the head of the lane.
   */
  readonly seq: -1;
}
type OwnerRoutePayload = OwnerRoutePost | OwnerRouteAnswer | OwnerRouteEffect;

/** Who hears that asks were answered or dropped (see `answerAsks` / `tellAnswered`). */
interface AnsweredNotice {
  readonly singleEvaluator?: boolean;
  readonly discussionId: string;
  readonly cardId: string;
  readonly text: string;
  readonly note: boolean;
  readonly answeredBy: KanbanActor;
  readonly answered: ReadonlyArray<KanbanOwnerAsk>;
  /** Threads already told by the write itself (a woken worker gets it as its wake note). */
  readonly told: ReadonlyArray<string>;
  /** The evaluator whose blocking ask held the card, told first. */
  readonly unblockEvaluator: string | null;
}

/**
 * Collects a write's thread follow-ons while `guardDeferred` runs it. Cleared
 * at the start of every attempt, so a stale rerun keeps only its own; closed
 * once the write returns, after which `later` runs inline (a fiber the write
 * forked must not add to a list nobody saves).
 */
interface EffectSink {
  readonly effects: Array<{
    readonly boardId: string;
    readonly lane: string;
    readonly effect: BoardEffect;
  }>;
  closed: boolean;
}
const effectSink = Context.Reference<EffectSink | undefined>("KanbanEffectSink", {
  defaultValue: () => undefined,
});
interface BoardPublication {
  readonly boardId: KanbanBoard["id"];
  readonly change: KanbanChange;
}
const reviewGateDrains = Context.Reference<Set<string> | undefined>("KanbanReviewGateDrains", {
  defaultValue: () => undefined,
});
const analyticsSink = Context.Reference<Array<AnalyticsEvent> | undefined>("KanbanAnalyticsSink", {
  defaultValue: () => undefined,
});
const publicationSink = Context.Reference<Array<BoardPublication> | undefined>(
  "KanbanPublicationSink",
  {
    defaultValue: () => undefined,
  },
);

/**
 * Dispatch kicks asked for by a tick's own steps. The tick dispatches as its last
 * step, so while its steps run a kick is only noted here: queued, it started the
 * worker's dispatcher under the rest of the tick, whose card starts made the tick
 * stale, and a tick that has already written or sent cannot start over. On the
 * 4,000-card soak that cost one tick in eight that ran with no other traffic
 * (release-20261110c, 11 Nov 2026): each had handled a failed run, which kicks.
 */
interface TickKicks {
  held: boolean;
  asked: boolean;
  stoppedCards: Set<string>;
}
const tickKicks = Context.Reference<TickKicks | undefined>("KanbanTickKicks", {
  defaultValue: () => undefined,
});
const tickQueueDepths = Context.Reference<
  { todo?: number; needs_review?: number; evaluator?: number } | undefined
>("KanbanTickQueueDepths", { defaultValue: () => undefined });

/**
 * The asks a durable owner route answers, fixed by its first attempt. Routing
 * closes only these, so a retry never answers an ask opened after the message.
 */
const ownerAnswerAt = Context.Reference<string | undefined>("KanbanOwnerAnswerAt", {
  defaultValue: () => undefined,
});
export const askAnswerVia = Context.Reference<"single" | "batch" | undefined>(
  "KanbanAskAnswerVia",
  { defaultValue: () => undefined },
);
const ownerRouteAsks = Context.Reference<ReadonlySet<string> | undefined>("KanbanOwnerRouteAsks", {
  defaultValue: () => undefined,
});

const evaluatorDeliveryObserved = Context.Reference<
  ((identity: string) => Effect.Effect<void>) | undefined
>("KanbanEvaluatorDeliveryObserved", { defaultValue: () => undefined });

const make = Effect.gen(function* () {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  // Measurements run inside the board operation's existing spans.
  const recordAnalytics = Effect.fnUntraced(function* (
    event: Omit<AnalyticsEvent, "ts" | "surface" | "route"> & {
      readonly ts?: string;
      readonly surface?: AnalyticsEvent["surface"];
    },
  ) {
    if (Option.isNone(analytics)) return;
    const recorded: AnalyticsEvent = {
      ...event,
      ts: event.ts ?? DateTime.formatIso(yield* DateTime.now),
      surface: event.surface ?? "server",
      route: "kanban",
    };
    const buffered = yield* analyticsSink;
    if (buffered !== undefined) buffered.push(recorded);
    else yield* recordServerAnalytics(analytics.value, recorded);
  });
  // Observation shares the post/drain span; no second span per routing decision.
  const observePostRouting = Effect.fnUntraced(function* <A, E, R>(
    discussion: Pick<KanbanDiscussion, "id"> &
      Partial<Pick<KanbanDiscussion, "boardId" | "cardId">>,
    message: { readonly author: Pick<KanbanActor, "_tag">; readonly seq: number },
    effect: Effect.Effect<A, E, R>,
    phase = "routed",
  ) {
    const target: PostRoutingTarget = {
      target: "none",
      post: { discussionId: discussion.id, seq: message.seq, authorKind: message.author._tag },
    };
    return yield* effect.pipe(
      Effect.provideService(postRoutingTarget, target),
      Effect.onExit((exit) =>
        recordAnalytics({
          kind: "kanban.post_routing",
          ...((target.boardId ?? discussion.boardId) === undefined
            ? {}
            : { boardId: target.boardId ?? discussion.boardId }),
          discussionId: discussion.id,
          ...((target.cardId ?? discussion.cardId) == null
            ? {}
            : { cardId: (target.cardId ?? discussion.cardId)! }),
          ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
          outcome: Exit.isSuccess(exit) ? (target.outcome ?? "ok") : "error",
          ...(Exit.isFailure(exit) ? { errorTag: analyticsErrorTag(exit.cause) } : {}),
          props: {
            actor: message.author._tag,
            seq: message.seq,
            target: target.target,
            phase: target.phase ?? phase,
          },
        }).pipe(
          Effect.provideService(analyticsSink, undefined),
          Effect.catchCause(() => Effect.void),
        ),
      ),
    );
  });
  const evaluatorMeasurements = new Set<string>();
  // Measurements share the start/send span; bounded recent identities suppress retries.
  const recordEvaluator = Effect.fnUntraced(function* (
    identity: string,
    event: {
      boardId: string;
      cardId?: string | null | undefined;
      threadId?: string | null | undefined;
      purposeKind: NonNullable<AnalyticsEvent["purposeKind"]>;
      trigger: NonNullable<AnalyticsEvent["trigger"]>;
      outcome: EvaluatorOutcome;
      reuseMissReason?: EvaluatorReuseMissReason;
    },
  ) {
    if (Option.isNone(analytics) || evaluatorMeasurements.has(identity)) return;
    evaluatorMeasurements.add(identity);
    if (evaluatorMeasurements.size > 8192)
      evaluatorMeasurements.delete(evaluatorMeasurements.values().next().value!);
    const { cardId, threadId, ...labels } = event;
    // Thread I/O already happened, even if board reconciliation later abandons the launch.
    // These observations must survive discarding the board write's analytics buffer.
    yield* recordServerAnalytics(analytics.value, {
      ...labels,
      ts: DateTime.formatIso(yield* DateTime.now),
      surface: "server",
      route: "kanban",
      ...(cardId == null ? {} : { cardId }),
      ...(threadId == null ? {} : { threadId }),
      kind: "kanban.evaluator",
    });
  });
  const analyticsActors = new WeakMap<KanbanCard, KanbanActor>();
  const preparedTransitions = new WeakSet<KanbanCard>();
  const scopedWakeSends = new Map<
    ThreadId,
    Set<{ scope: string; stale: boolean; archived: KanbanBoardId | null }>
  >();
  const archivedThreads = new Map<ThreadId, KanbanBoardId>();
  const poolHours = new Map<string, number>();
  const failedRuns = new Set<string>();
  const pendingCancelReasons = new Map<
    string,
    Map<KanbanCard["id"], Pick<KanbanCard, "id" | "boardId">>
  >();
  const stoppedRunCards = new Map<
    string,
    { runId: string; card: Pick<KanbanCard, "id" | "boardId" | "activePool" | "model"> }
  >();
  const observeStop = (
    id: string,
    result: { outcome: "requested"; runId: string } | { outcome: "noop" } | void,
  ) => {
    const pending = stoppedRunCards.get(id);
    if (!pending) return;
    if (result?.outcome === "requested")
      stoppedRunCards.set(id, { ...pending, runId: result.runId });
    else if (result?.outcome === "noop") stoppedRunCards.delete(id);
  };
  const poolWaits = new Map<
    string,
    { boardId: string; pool: string; movedAt: string; at: number }
  >();
  const context =
    yield* Effect.context<import("../../../serverSettings.ts").ServerSettingsService>();
  const locks = yield* BoardLocks.make();
  const ownerRouteMode = yield* OwnerRouteMode;
  const replayReads = yield* ReplayReads;
  const deferWrites = (yield* DeferWriteEffects) && ownerRouteMode !== "inline";
  const durableOwnerRoutes = ownerRouteMode !== "inline";
  const routingEnabled = locks.outside(
    selectionRoutingEnabled.pipe(Effect.provideContext(context)),
    undefined,
    true,
  );
  const canonicalModel = Effect.fn("KanbanService.canonicalModel")(function* (
    selection: ModelSelection,
  ) {
    if (!(yield* routingEnabled)) return selection;
    const result = Defaults.modelSelectionResult(selection, true);
    return result.kind === "conflict"
      ? yield* failWith("invalid", result.reason)
      : result.selection;
  });
  const boardSql = yield* BoardsDatabase.client;
  const timedStore = TickTimings.store(yield* KanbanStore);
  // Nested routing and posting helpers read these rows too. Keep their reader
  // admission outside the gate; `outside` revalidates the operation on return.
  // Transaction reads use the writer and must retain its board permits.
  // The store read already owns the tracing boundary.
  const readRouteRow = <A, E, R>(read: Effect.Effect<A, E, R>) =>
    Effect.withFiber((fiber) =>
      Context.get(fiber.context, effectRouteReads) &&
      Option.isNone(Context.getOption(fiber.context, boardSql.transactionService))
        ? locks.outside(read, undefined, true)
        : read,
    );
  const rawStore = new Proxy(timedStore, {
    get(target, key, receiver) {
      if (key === "card") return (id: KanbanCardId) => readRouteRow(target.card(id));
      if (key === "discussion")
        return (id: KanbanDiscussionId) => readRouteRow(target.discussion(id));
      return Reflect.get(target, key, receiver);
    },
  });
  const tickSql = <A extends object = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...args: Array<unknown>
  ) =>
    TickTimings.measure(
      /^\s*(SELECT|WITH)\b/i.test(strings[0] ?? "") ? "board_load" : "event_persistence",
      boardSql<A>(strings, ...args),
      true,
    );
  const tickTransaction: typeof boardSql.withTransaction = (effect) =>
    TickTimings.measure(
      "event_persistence",
      rawStore.observeCallerWrites(boardSql.withTransaction(effect)),
      true,
    );
  // Read admission keeps SavedWrite's commit marker at the first persisted write.
  const boardTransaction = Effect.fn("KanbanService.boardTransaction")(function* <A, E, R>(
    boardId: string,
    effect: Effect.Effect<A, E, R>,
    resource?: string,
  ) {
    return yield* locks.run(
      locks
        .access(boardId, Effect.void, false, resource)
        .pipe(Effect.andThen(tickTransaction(effect))),
    );
  });
  const store = LockedStore.wrap(rawStore, locks);
  const threadIo = yield* KanbanThreads;
  const turnAdmission = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const inFlightSends = new Map<ThreadId, number>();
  const pendingLaunches = new Map<KanbanBoardId, number>();
  const delivering = new Map<
    KanbanCard["id"],
    {
      readonly threadId: ThreadId;
      touched: boolean;
      accepted: boolean;
      revoked: boolean;
      rollingBack: boolean;
    }
  >();
  const assignmentWakeRetries = new Map<string, Rules.AssignmentWakeRetry>();
  const agentCalls = new Map<ThreadId, number>();
  const rollingBack = (threadId: ThreadId) =>
    [...delivering.values()].some(
      (pending) => pending.threadId === threadId && pending.rollingBack,
    );
  const trackSend = Effect.fn("KanbanService.trackSend")(function* <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) {
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        inFlightSends.set(threadId, (inFlightSends.get(threadId) ?? 0) + 1);
        for (const pending of delivering.values()) {
          if (pending.threadId === threadId) pending.touched = true;
        }
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          const remaining = (inFlightSends.get(threadId) ?? 1) - 1;
          if (remaining === 0) inFlightSends.delete(threadId);
          else inFlightSends.set(threadId, remaining);
        }),
    );
  });
  // Host readings for the pull requests waits point at. Provided around the
  // board layers (server.ts); without it a wait only sees what work threads know.
  const waitPrs = yield* Effect.serviceOption(KanbanWaitPrs);
  // Bumped before and after anything this process does to a thread, so a stale
  // rerun never replays a read of it taken across that change (see `outsideRead`).
  const threadFences = new Map<string, number>();
  const touch = (threadId: string) =>
    void threadFences.set(threadId, (threadFences.get(threadId) ?? 0) + 1);
  const touching = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      touch(threadId);
      return effect.pipe(Effect.ensuring(Effect.sync(() => touch(threadId))));
    });
  // A deferred interrupt (a card let go of its thread) is pending from the
  // moment its route row is saved until it runs. Nothing this board sends to
  // that thread goes out before it: the send runs the stop first, so a late
  // interrupt never cuts a run started after it was asked for. Keyed by route.
  // Drop and pause notes (`release`) are pending the same way.
  const pendingStops = new Map<string, Map<string, PendingRelease>>();
  const inFlightStops = new Map<ThreadId, number>();
  // An interrupt acknowledgement only commits an effect; its provider may still be running.
  const pendingRunStops = new Map<ThreadId, string>();
  const stoppedRoutes = new Set<string>();
  const stopping = yield* Semaphore.make(1);
  // Everything the board does that sets a thread's model (a switch, a send that
  // carries a model) holds that thread's model lock, so a saved switch that read
  // an older model can never land after a newer one. Never taken under a gate.
  const modelLocks = new Map<string, Semaphore.Semaphore>();
  const threadModelLock = (threadId: string) => {
    let lock = modelLocks.get(threadId);
    if (!lock) modelLocks.set(threadId, (lock = Semaphore.makeUnsafe(1)));
    return lock;
  };
  const withThreadModel = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => threadModelLock(threadId).withPermits(1)(effect));
  const restoreWorkModel = Effect.fn("KanbanService.restoreWorkModel")(
    function* (threadId: ThreadId, cardId: KanbanCard["id"], locked = false) {
      const restoring = Effect.gen(function* () {
        const carried = yield* rawStore.cardsByThread(threadId);
        const source = yield* rawStore.card(cardId);
        const committed =
          carried.find((card) => card.activeRole === "work") ??
          (source?.workThreadId === threadId ? source : undefined);
        if (committed === undefined) return;
        yield* touching(threadId, threadIo.setModel(threadId, committed.model));
      });
      yield* locked ? restoring : withThreadModel(threadId, restoring);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("kanban thread model reconciliation failed", { cause }),
    ),
  );
  const ensureWorkModel = Effect.fn("KanbanService.ensureWorkModel")(function* (
    threadId: ThreadId,
    model: ModelSelection,
    cardId: KanbanCard["id"],
    locked = false,
  ) {
    let current: ModelSelection | null = null;
    const read = yield* locks.outside(Effect.exit(threadIo.model(threadId)), undefined, true);
    if (read._tag === "Success") {
      current = read.value;
      if (current !== null && modelSelectionsEqual(current, model)) return null;
    }
    const checking = Effect.exit(
      Effect.gen(function* () {
        current = yield* threadIo.model(threadId);
        if (current !== null && modelSelectionsEqual(current, model)) return true;
        yield* touching(threadId, threadIo.setModel(threadId, model));
        current = null;
        current = yield* threadIo.model(threadId);
        return current !== null && modelSelectionsEqual(current, model);
      }),
    );
    const checked =
      read._tag === "Failure"
        ? read
        : yield* locks.outside(locked ? checking : withThreadModel(threadId, checking), () =>
            locked ? Effect.void : restoreWorkModel(threadId, cardId),
          );
    if (checked._tag === "Success" && checked.value === true) return null;
    const reason = `Thread model differs from card model: thread runs ${current === null ? "unknown" : Rules.poolKey(current)}, card runs ${Rules.poolKey(model)}`;
    return checked._tag === "Failure" ? `${reason}; ${String(checked.cause)}` : reason;
  });
  const stopResource = (threadId: string) => `stops:${threadId}`;
  // A sibling's drop note must not revoke an assignment whose claim is already saved.
  const interruptResource = (threadId: string) => `interrupts:${threadId}`;
  const addPendingStop = (threadId: string, routeKey: string, entry: PendingRelease) => {
    let stops = pendingStops.get(threadId);
    if (!stops) pendingStops.set(threadId, (stops = new Map()));
    stops.set(routeKey, entry);
  };
  const releaseOf = (effect: BoardEffect): PendingRelease | null =>
    effect.kind === "interrupt"
      ? { kind: "interrupt", reason: effect.reason, cancelQueued: effect.cancelQueued === true }
      : effect.kind === "release"
        ? {
            kind: "note",
            text: effect.text,
            ...(effect.mode === undefined ? {} : { mode: effect.mode }),
          }
        : null;
  // A failed close fails the stop like a failed interrupt: the send waiting on it fails too.
  // Notes a stop made obsolete close as `superseded`, never as delivered.
  const closeStopRows = Effect.fn("KanbanService.closeStopRows")(
    function* (keys: ReadonlyArray<string>, superseded: ReadonlyArray<string> = []) {
      const at = yield* nowIso;
      yield* tickTransaction(
        Effect.gen(function* () {
          yield* tickSql`
            UPDATE ardud_kanban_owner_routes
            SET done_at = ${at}, json = json_set(json, '$.outcome', 'delivered')
            WHERE route_key IN ${boardSql.in(keys)} AND done_at IS NULL
          `;
          if (superseded.length === 0) return;
          yield* tickSql`
            UPDATE ardud_kanban_owner_routes
            SET done_at = ${at}, json = json_set(json, '$.outcome', 'superseded')
            WHERE route_key IN ${boardSql.in(superseded)} AND done_at IS NULL
          `;
        }),
      );
    },
    Effect.mapError(
      (error) =>
        new KanbanThreadError({
          operation: "interrupt",
          detail: `stop not saved: ${error.message}`,
        }),
    ),
  );
  /**
   * Runs the thread's pending stops and notes, if any; callers hold no board
   * gate. A drain passes its own route: skipped when a send already ran it.
   * Notes are keyed sends (a retry never delivers one twice), in the order
   * they were saved. A pending stop supersedes them: the thread has no card
   * left to carry on with, so they close unsent and the stop runs alone (a
   * failing note can't hold it up). No note is saved after a stop: a thread
   * with a stop pending takes no card until it has run.
   */
  const runPendingStops = (
    threadId: string,
    route?: { readonly key: string; readonly entry: PendingRelease },
  ) =>
    Effect.suspend(() =>
      route === undefined && !pendingStops.has(threadId)
        ? Effect.void
        : stopping.withPermits(1)(
            Effect.suspend(() => {
              if (route !== undefined && stoppedRoutes.delete(route.key)) return Effect.void;
              const stops = pendingStops.get(threadId);
              const entries = [...(stops?.entries() ?? [])];
              if (route !== undefined && !entries.some(([key]) => key === route.key)) {
                entries.push([route.key, route.entry]);
              }
              if (entries.length === 0) return Effect.void;
              const keys = entries.map(([key]) => key);
              const id = ThreadId.make(threadId);
              const stop = entries.find(([, entry]) => entry.kind === "interrupt")?.[1];
              const cancelQueued = entries.some(
                ([, entry]) => entry.kind === "interrupt" && entry.cancelQueued === true,
              );
              const notes = entries.filter(([, entry]) => entry.kind === "note");
              const superseded = stop === undefined ? [] : notes.map(([key]) => key);
              const run =
                stop?.kind === "interrupt"
                  ? cancelQueued
                    ? interruptThread(id, stop.reason, true)
                    : threadIo
                        .interrupt(id, stop.reason)
                        .pipe(Effect.tap((result) => Effect.sync(() => observeStop(id, result))))
                  : Effect.forEach(
                      notes,
                      ([key, entry]) =>
                        entry.kind === "note"
                          ? trackSend(
                              id,
                              threadIo
                                .send({
                                  threadId: id,
                                  text: entry.text,
                                  key: `${key}:note`,
                                  ...(entry.mode === undefined ? {} : { mode: entry.mode }),
                                })
                                .pipe(
                                  // A refused steer must never become a later wake.
                                  Effect.catchIf(
                                    (error) =>
                                      error.detail === "thread not found" ||
                                      (entry.mode === "steer" &&
                                        (error.rejected || error.detail === "no running turn")),
                                    () => Effect.void,
                                  ),
                                ),
                            )
                          : Effect.void,
                      { discard: true },
                    );
              return touching(threadId, run).pipe(
                Effect.tap(() =>
                  stop === undefined
                    ? Effect.void
                    : dropHold(ThreadId.make(threadId), "thread_stopped"),
                ),
                // Closed durably before the lock is released: a restart must not
                // reload a stop that already ran and cut the run a send starts
                // next (packages/protocol-models/stops.qnt, `stepVolatile`).
                Effect.andThen(
                  closeStopRows(
                    keys.filter((key) => !superseded.includes(key)),
                    superseded,
                  ),
                ),
                Effect.tap(() =>
                  Effect.sync(() => {
                    for (const key of keys) {
                      stops?.delete(key);
                      // The drain of that route skips it; the caller's own route is done here.
                      if (key !== route?.key) stoppedRoutes.add(key);
                    }
                    if (stops?.size === 0) pendingStops.delete(threadId);
                  }),
                ),
              );
            }),
          ),
    );
  const threadRead = <A, E, R>(read: string, threadId: string, effect: Effect.Effect<A, E, R>) =>
    TickTimings.measure(
      "thread_status",
      replayReads
        ? locks.outsideRead(`${read}:${threadId}`, () => threadFences.get(threadId) ?? 0, effect)
        : locks.outside(effect, undefined, true),
    );
  const abandonLaunch = Effect.fn("KanbanService.abandonLaunch")(
    function* (input: Parameters<typeof threadIo.launch>[0], id: ThreadId) {
      // The ended link comes first: a keyed owner-route replay must see this
      // launch as abandoned even if the process stops before the interrupt.
      const existing = yield* rawStore.threadLink(id);
      const [source, role] = input.key.split(":");
      const card =
        role === "work" || role === "review"
          ? yield* rawStore.card(KanbanCardId.make(source!))
          : null;
      const at = yield* nowIso;
      yield* rawStore.putThreadLink(
        existing
          ? { ...existing, endedAt: at }
          : {
              threadId: id,
              boardId: card?.boardId ?? KanbanBoardId.make(source!),
              cardId: card?.id ?? null,
              role: role === "work" || role === "review" ? role : "evaluator",
              purpose: null,
              discussionId: null,
              model: input.model,
              startedAt: at,
              endedAt: at,
              paused: null,
            },
      );
    },
    (effect, _input, id) =>
      effect.pipe(
        Effect.ignore,
        Effect.ensuring(
          touching(
            id,
            threadIo.interrupt(
              id,
              "Board state changed during launch",
              true,
              undefined,
              undefined,
              "superseded",
            ),
          ).pipe(Effect.ignore),
        ),
      ),
  );
  const interruptThread = Effect.fn("KanbanService.interruptThread")(
    <E = never>(
      id: ThreadId,
      reason: string,
      cancelQueued?: boolean,
      runId?: string,
      acknowledged: Effect.Effect<void, E> = Effect.void,
      cancelReason: OrchestrationV2Run["cancelReason"] = "card_stop",
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          inFlightStops.set(id, (inFlightStops.get(id) ?? 0) + 1);
          if (runId !== undefined) pendingRunStops.set(id, runId);
        }),
        () =>
          locks.outside(
            touching(
              id,
              threadIo.interrupt(id, reason, cancelQueued, runId, undefined, cancelReason),
            ).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  observeStop(id, result);
                  if (result?.outcome === "requested") pendingRunStops.set(id, result.runId);
                  else if (runId !== undefined && pendingRunStops.get(id) === runId)
                    pendingRunStops.delete(id);
                }),
              ),
              Effect.tap((result) => (result?.outcome === "noop" ? Effect.void : acknowledged)),
            ),
          ),
        () =>
          Effect.sync(() => {
            const left = (inFlightStops.get(id) ?? 1) - 1;
            if (left === 0) inFlightStops.delete(id);
            else inFlightStops.set(id, left);
          }),
      ),
  );
  const ownerPostSeq = Context.Reference<number | undefined>("KanbanOwnerPostSeq", {
    defaultValue: () => undefined,
  });
  const launchReconcile = Context.Reference<((id: ThreadId) => Effect.Effect<boolean>) | undefined>(
    "KanbanLaunchReconcile",
    { defaultValue: () => undefined },
  );
  const discardWake = Effect.fn("KanbanService.discardWake")(
    function* (threadId: ThreadId, runId: string | void, wakeMessageId?: string) {
      if (runId === undefined && wakeMessageId === undefined) return;
      const wake = (yield* threadIo.queuedRuns(threadId)).find(
        (run) =>
          run.status === "queued" &&
          (runId === undefined ? run.userMessageId === wakeMessageId : run.id === runId),
      );
      if (wake !== undefined) yield* touching(threadId, threadIo.cancelQueued(threadId, wake.id));
    },
    Effect.retry({ times: 1 }),
    Effect.tapError((error) => Effect.logWarning("kanban stale wake withdrawal failed", { error })),
  );

  const stopSentRun = Effect.fn("KanbanService.stopSentRun")(function* (
    threadId: ThreadId,
    runId: string,
  ) {
    // A restored board may already own another run and queue in this thread.
    yield* touching(threadId, threadIo.cancelQueued(threadId, runId));
    yield* interruptThread(
      threadId,
      "Board deleted while sending",
      false,
      runId,
      Effect.void,
      "superseded",
    );
  });

  const saveSendStop = Effect.fn("KanbanService.saveSendStop")(function* (
    boardId: KanbanBoardId,
    threadId: ThreadId,
    target: SentStopTarget,
  ) {
    yield* saveEffects([
      {
        boardId,
        lane: `archive:${boardId}/${threadId}/${uuid()}`,
        effect: { kind: "stopSend", threadId, ...target },
      },
    ]).pipe(
      Effect.mapError(
        (error) =>
          new KanbanThreadError({
            operation: "interrupt",
            detail: String(error),
          }),
      ),
    );
  });

  const sendThread = Effect.fn("KanbanService.sendThread")(function* (
    input: Parameters<typeof threadIo.send>[0],
    acknowledge?: { failed: boolean },
    acknowledged?: Effect.Effect<boolean>,
    isAssignment = false,
  ) {
    if (archivedThreads.has(input.threadId))
      return yield* new KanbanThreadError({
        operation: "send",
        detail: "Board is deleted",
        rejected: true,
      });
    const key = yield* ownerDeliveryKey;
    const delivered = yield* ownerDelivered;
    const answer = input.key === undefined;
    if (answer && delivered?.has(input.threadId)) return;
    const wake = {
      scope: input.model === undefined && input.mode !== "steer" ? (input.coalesce ?? "") : "",
      stale: false,
      archived: null as KanbanBoardId | null,
    };
    if (wake !== undefined) {
      let pending = scopedWakeSends.get(input.threadId);
      if (pending === undefined) scopedWakeSends.set(input.threadId, (pending = new Set()));
      pending.add(wake);
    }
    const evaluatorAttribution = yield* EvaluatorAnalytics.attribution;
    const sent = touching(
      input.threadId,
      threadIo
        .send({
          ...input,
          onAccepted: Effect.fn("KanbanService.observeEvaluatorDelivery")(
            function* (identity: string) {
              const observer = yield* evaluatorDeliveryObserved;
              if (observer !== undefined) return yield* observer(identity);
              if (Option.isNone(analytics)) return;
              const link = yield* rawStore
                .threadLink(input.threadId)
                .pipe(NodeSqliteClient.readOnly);
              if (link?.role !== "evaluator") return;
              yield* recordEvaluator(`send:${identity}`, {
                boardId: evaluatorAttribution?.boardId ?? link.boardId,
                cardId:
                  evaluatorAttribution === undefined ? link.cardId : evaluatorAttribution.cardId,
                threadId: input.threadId,
                purposeKind: EvaluatorAnalytics.purposeKind(link.purpose),
                trigger: (yield* EvaluatorAnalytics.origin) ?? "thread_send",
                outcome: "reused",
              });
            },
            Effect.catchCause(() => Effect.void),
          ),
          ...(wake === undefined
            ? {}
            : { isStale: () => wake.stale || input.isStale?.() === true }),
          ...(key === undefined
            ? {}
            : { key: `${key}:${input.threadId}:${input.key ?? "answer"}` }),
        })
        .pipe(
          Effect.tapError((error) =>
            wake.archived && (error.sentRunId !== undefined || error.wakeMessageId !== undefined)
              ? saveSendStop(
                  wake.archived,
                  input.threadId,
                  error.sentRunId === undefined
                    ? { messageId: error.wakeMessageId! }
                    : { runId: error.sentRunId },
                )
              : wake.stale
                ? discardWake(input.threadId, undefined, error.wakeMessageId)
                : Effect.void,
          ),
          Effect.flatMap((runId) =>
            wake.archived
              ? runId === undefined
                ? Effect.void
                : saveSendStop(wake.archived, input.threadId, { runId })
              : wake.stale
                ? discardWake(input.threadId, runId).pipe(Effect.asVoid)
                : Effect.succeed(runId),
          ),
        ),
    );
    const delivery = Effect.andThen(
      runPendingStops(input.threadId),
      input.model === undefined ? sent : withThreadModel(input.threadId, sent),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (answer && !wake?.stale) delivered?.add(input.threadId);
        }),
      ),
    );
    const deliveryOutside = locks.outside(
      acknowledge
        ? delivery.pipe(
            Effect.catchCause(() =>
              Effect.sync(() => {
                acknowledge.failed = true;
              }),
            ),
          )
        : delivery,
      wake === undefined
        ? undefined
        : (runId) =>
            wake.stale
              ? discardWake(input.threadId, runId).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("kanban abandoned wake withdrawal failed", { cause }),
                  ),
                )
              : Effect.void,
      false,
      acknowledge ? Effect.succeed(true) : acknowledged,
    );
    // An assignment send cannot count as a consumer of its own pending claim.
    return yield* (
      isAssignment ? deliveryOutside : trackSend(input.threadId, deliveryOutside)
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (wake === undefined) return;
          const pending = scopedWakeSends.get(input.threadId);
          pending?.delete(wake);
          if (pending?.size === 0) scopedWakeSends.delete(input.threadId);
        }),
      ),
    );
  });
  const threads: typeof threadIo = {
    remove: (id) => locks.outside(touching(id, threadIo.remove(id))),
    claimContext: (id) => threadRead("claimContext", id, threadIo.claimContext(id)),
    pendingUserInputs: (id) =>
      TickTimings.measure(
        "thread_status",
        locks.outside(threadIo.pendingUserInputs(id), undefined, true),
      ),
    queuedRuns: (id, includeActive) =>
      locks.outside(threadIo.queuedRuns(id, includeActive), undefined, true),
    backgroundStoppedSince: (id, since) =>
      locks.outside(threadIo.backgroundStoppedSince(id, since), undefined, true),
    view: (id) => threadRead("view", id, threadIo.view(id)),
    find: (id) => threadRead("find", id, threadIo.find(id)),
    model: (id, activeRun = false) =>
      threadRead(activeRun ? "activeModel" : "model", id, threadIo.model(id, activeRun)),
    lastFailure: (id) => threadRead("lastFailure", id, threadIo.lastFailure(id)),
    findLastFailure: (id) => threadRead("findLastFailure", id, threadIo.findLastFailure(id)),
    acceptedSend: (key: string) =>
      threadIo.acceptedSend
        ? locks.outside(threadIo.acceptedSend(key), undefined, true)
        : Effect.succeed(null),
    latestRun: (id, afterRunId) =>
      afterRunId === undefined
        ? threadRead("latestRun", id, threadIo.latestRun(id))
        : locks.outside(threadIo.latestRun(id, afterRunId), undefined, true),
    compactRun: (id, run) => locks.outside(touching(id, threadIo.compactRun(id, run))),
    runSettled: (id, run) =>
      TickTimings.measure(
        "thread_status",
        locks.outside(threadIo.runSettled(id, run), undefined, true),
      ),
    launch: Effect.fn("KanbanService.launchThread")(function* (
      input: Parameters<typeof threadIo.launch>[0],
    ) {
      const [source, role] = input.key.split(":");
      const boardId =
        role === "work" || role === "review"
          ? (yield* store
              .card(KanbanCardId.make(source!))
              .pipe(
                Effect.mapError(
                  (error) => new KanbanThreadError({ operation: "launch", detail: String(error) }),
                ),
              ))?.boardId
          : KanbanBoardId.make(source!);
      if (boardId === undefined)
        return yield* new KanbanThreadError({
          operation: "launch",
          detail: "The launch's card no longer exists.",
        });
      pendingLaunches.set(boardId, (pendingLaunches.get(boardId) ?? 0) + 1);
      let retained = false;
      const releasePending = Effect.sync(() => {
        const left = (pendingLaunches.get(boardId) ?? 1) - 1;
        if (left === 0) pendingLaunches.delete(boardId);
        else pendingLaunches.set(boardId, left);
      });
      return yield* Effect.flatMap(launchReconcile, (reconcile) => {
        let launched: ThreadId | undefined;
        let launchFailure: KanbanThreadError | undefined;
        return locks
          .outside(
            threadIo.launch(input).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  launchFailure = error;
                }),
              ),
              Effect.tap((id) =>
                Effect.sync(() => {
                  launched = id;
                  touch(id);
                }),
              ),
              Effect.tap((id) =>
                Effect.gen(function* () {
                  (yield* ownerDelivered)?.add(id);
                  // Durable before the discussion names it, so a replay never sends again
                  // what this launch's first message already carried.
                  const row = yield* ownerRouteRow;
                  if (row !== undefined) {
                    yield* tickSql`
                    UPDATE ardud_kanban_owner_routes SET launched = json_insert(launched, '$[#]', ${id})
                    WHERE id = ${row} AND NOT EXISTS (SELECT 1 FROM json_each(launched) WHERE value = ${id})
                  `.pipe(
                      Effect.mapError(
                        (error) =>
                          new KanbanThreadError({ operation: "launch", detail: String(error) }),
                      ),
                    );
                  }
                }),
              ),
              // Reconcile provider failures as values too: otherwise a concurrent
              // comment masks them with BoardStateChanged before the start guard.
              Effect.result,
            ),
            () => (launched === undefined ? Effect.void : abandonLaunch(input, launched)),
            false,
            reconcile === undefined
              ? undefined
              : Effect.suspend(() =>
                  launched === undefined ? Effect.succeed(true) : reconcile(launched),
                ),
          )
          .pipe(
            // Resource fences still revoke successful launches; a failed launch
            // must reach the assignment-aware start handler with its typed error.
            Effect.catchDefect((defect) => {
              if (!(defect instanceof BoardLocks.BoardStateChanged) || launchFailure === undefined)
                return Effect.die(defect);
              // Compensation needs the refusal; board deferral needs the exhausted budget too.
              return defect instanceof BoardLocks.DispatchReadBudgetExceeded
                ? Effect.failCause(Cause.combine(Cause.fail(launchFailure), Cause.die(defect)))
                : Effect.fail(launchFailure);
            }),
            Effect.flatMap((result) =>
              Result.isSuccess(result)
                ? Effect.succeed(result.success)
                : Effect.fail(result.failure),
            ),
            Effect.tap((id) =>
              Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* locks.launched(id, abandonLaunch(input, id));
                  // Attachment may still release the gate. Keep purge blocked through
                  // the owning operation, after its abandonment compensation finishes.
                  yield* locks.launched(
                    `pending-launch:${NodeCrypto.randomUUID()}`,
                    releasePending,
                  );
                  retained = true;
                }),
              ),
            ),
          );
      }).pipe(Effect.ensuring(Effect.suspend(() => (retained ? Effect.void : releasePending))));
    }),
    send: sendThread,
    withdraw: (input) => locks.outside(touching(input.threadId, threadIo.withdraw(input))),
    setModel: (id, model) =>
      locks.outside(withThreadModel(id, touching(id, threadIo.setModel(id, model)))),
    cancelQueued: (id, run, cancelReason) =>
      locks.outside(touching(id, threadIo.cancelQueued(id, run, cancelReason))),
    // Best effort, as before, for the board's own inline stops; saved stops use `runPendingStops`.
    interrupt: (id, reason, cancelQueued, runId, _messageId, cancelReason) =>
      interruptThread(id, reason, cancelQueued, runId, Effect.void, cancelReason).pipe(
        Effect.ignore,
      ),
  };
  /** Thread reads that confirm the current run: always read, never replayed. */
  const freshThreads = {
    laterStartedRun: (threadId: ThreadId, failedRunId: string) =>
      locks.outside(threadIo.latestRun(threadId, failedRunId), undefined, true),
    unsettledRuns: (threadId: ThreadId) =>
      locks.outside(threadIo.queuedRuns(threadId, true), undefined, true),
    model: (threadId: ThreadId) => locks.outside(threadIo.model(threadId), undefined, true),
    find: (threadId: ThreadId) => locks.outside(threadIo.find(threadId), undefined, true),
    findLastFailure: (threadId: ThreadId) =>
      locks.outside(threadIo.findLastFailure(threadId), undefined, true),
  };
  // A saved model switch applies the model the thread's cards have now, not the
  // one it was saved with: switches saved on different card lanes may run in
  // any order, and the last to run must leave the newest model. It holds the
  // thread's model lock from that read to its switch, so any newer model (an
  // edit, a dispatch send) lands after it. The read is a plain committed read.
  const switchToLatestModel = (threadId: string) =>
    withThreadModel(
      threadId,
      Effect.gen(function* () {
        const cards = yield* rawStore.cardsByThread(threadId);
        const working = cards.find((card) => card.activeRole === "work");
        // No card works on it any more: the switch is obsolete.
        if (working === undefined) return;
        yield* touching(threadId, threadIo.setModel(ThreadId.make(threadId), working.model));
      }),
    );
  /**
   * A write's thread follow-on. While `guardDeferred` runs the write (durable
   * route modes) it is saved after the write and run by its lane's drain;
   * otherwise it runs here, as before.
   */
  const later = <E, R>(
    boardId: string,
    lane: string,
    effect: BoardEffect,
    inline: Effect.Effect<unknown, E, R>,
  ): Effect.Effect<void, E, R> =>
    Effect.flatMap(EvaluatorAnalytics.origin, (origin) =>
      Effect.gen(function* () {
        const sink = yield* effectSink;
        const current = yield* EvaluatorAnalytics.attribution;
        const cardId =
          effect.evaluatorCardId !== undefined
            ? effect.evaluatorCardId
            : effect.kind === "evaluatorTurn"
              ? effect.after.id
              : "cardId" in effect
                ? effect.cardId
                : effect.kind === "send" && effect.planCardId !== undefined
                  ? effect.planCardId
                  : current?.cardId;
        const trigger =
          effect.evaluatorTrigger ??
          origin ??
          (effect.kind === "evaluatorTurn"
            ? "step_transition"
            : effect.kind === "tellAnswered"
              ? "owner_answer"
              : "discussion_post");
        if (sink === undefined || sink.closed)
          return yield* Effect.asVoid(inline).pipe(
            Effect.provideService(EvaluatorAnalytics.origin, trigger),
            Effect.provideService(
              EvaluatorAnalytics.attribution,
              cardId === undefined ? current : { boardId, cardId },
            ),
          );
        sink.effects.push({
          boardId,
          lane,
          effect: {
            ...effect,
            evaluatorTrigger: trigger,
            ...(cardId === undefined ? {} : { evaluatorCardId: cardId }),
          },
        });
        return;
      }),
    );
  /** A card's follow-ons run in order in its discussion's lane, or its own when it has none. */
  const cardLane = (card: KanbanCard) => card.discussionId ?? `card:${card.id}`;
  // Notifications must neither reacquire the caller's permit nor die with its MCP request.
  const forkPostCommit = <E, R>(effect: Effect.Effect<unknown, E, R>) =>
    locks.independent(locks.run(effect)).pipe(
      Effect.provideService(BoardLocks.operationName, "postCommit"),
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban saved write post-commit work failed", { cause }),
      ),
      Effect.provideService(BoardLocks.writeWaitMs, BoardLocks.WRITE_WAIT_MS),
      Effect.provideService(TickTimings.current, undefined),
      SavedWrite.background,
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const modelIo = yield* KanbanModels;
  const models = { ...modelIo, listed: locks.outside(modelIo.listed, undefined, true) };
  const textIo = yield* TextGeneration.TextGeneration;
  const textGeneration: typeof textIo = {
    ...textIo,
    generateThreadTitle: (input) => locks.outside(textIo.generateThreadTitle(input)),
    ...(textIo.generateJson
      ? {
          generateJson: <S extends Schema.Top>(input: TextGeneration.JsonGenerationInput<S>) =>
            locks.outside(textIo.generateJson!(input)),
        }
      : {}),
  };
  const projectIo = yield* ProjectService.ProjectService;
  const projects = {
    getById: (id: ProjectId) => locks.outside(projectIo.getById(id), undefined, true),
  };
  const providerIo = yield* ProviderRegistry.ProviderRegistry;
  const providerRegistry = {
    getProviders: locks.outside(providerIo.getProviders, undefined, true),
  };
  const serverConfig = yield* ServerConfig.ServerConfig;
  // Installed builds supply their commit; unversioned dev servers check once per boot.
  const reviewGateBuild = serverConfig.robobBuildCommit ?? NodeCrypto.randomUUID();
  const attachmentIo = makeBoardAttachments(serverConfig, yield* FileSystem.FileSystem);
  const attachments: typeof attachmentIo = {
    ...attachmentIo,
    claim: (id, blocks) =>
      blocks.some((block) => block._tag === "attachment")
        ? locks.outside(attachmentIo.claim(id, blocks), (claim) =>
            attachmentIo.release(claim.claimedPaths),
          )
        : attachmentIo.claim(id, blocks),
    release: (paths) => locks.outside(attachmentIo.release(paths)),
  };
  const scope = yield* Effect.scope;
  const startupReady = yield* Deferred.make<void>();
  // Serialize dispatch and evaluator routing, not state writes. These may wait on a launch.
  const dispatching = new Map<string, Semaphore.Semaphore>();
  const evaluating = new Map<string, Semaphore.Semaphore>();
  // This per-discussion permit also marks an in-flight launch; later posts wait for its save.
  const routing = new Map<string, Semaphore.Semaphore>();
  const enqueueEvaluatorOnly = Context.Reference("KanbanEnqueueEvaluatorOnly", {
    defaultValue: () => false,
  });
  const handedOff = new Set<string>();
  const ticking = new Map<string, Semaphore.Semaphore>();
  const turnEnding = new Map<string, Semaphore.Semaphore>();
  const starting = new Map<
    string,
    {
      readonly cardId: string;
      readonly pool: string;
      readonly threadId: string | null;
      readonly wakeThreadId: ThreadId | null;
    }
  >();
  const pendingWakes = new Map<string, ThreadId>();
  const waking = (threadId: ThreadId) =>
    [...pendingWakes.values()].includes(threadId) ||
    [...starting.values()].some((entry) => entry.wakeThreadId === threadId);
  const settingUp = new Set<string>();
  /** Runs `effect` alone per key; it opens its own lock operations (serial: exactly one). */
  const serialEach = <A, E, R>(
    all: Map<string, Semaphore.Semaphore>,
    key: string,
    effect: Effect.Effect<A, E, R>,
    stateScope = true,
    whenBusy?: Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend(() => {
      const started = performance.now();
      let mutex = all.get(key);
      if (!mutex) {
        mutex = Semaphore.makeUnsafe(1);
        all.set(key, mutex);
      }
      const run = Effect.gen(function* () {
        // The permit wait was invisible in traces: it dominated slow owner answers.
        yield* Effect.annotateCurrentSpan("serial.wait_ms", performance.now() - started);
        return yield* locks.fresh(stateScope ? locks.run(effect) : effect);
      });
      return locks.outside(
        whenBusy === undefined
          ? TickTimings.admission(mutex.withPermits(1), run)
          : mutex
              .withPermitsIfAvailable(1)(run)
              .pipe(
                Effect.flatMap((result) =>
                  Option.isSome(result)
                    ? Effect.succeed(result.value)
                    : locks.fresh(locks.run(whenBusy)),
                ),
              ),
        undefined,
        false,
        undefined,
        { writesTrackedInside: true },
      );
    }).pipe(
      Effect.withSpan("KanbanService.serial", {
        attributes: {
          "serial.queue":
            all === routing
              ? "routing"
              : all === evaluating
                ? "evaluating"
                : all === dispatching
                  ? "dispatching"
                  : all === ticking
                    ? "ticking"
                    : "turnEnding",
          "serial.key": key,
        },
      }),
    );
  const serial = <A, E, R>(
    all: Map<string, Semaphore.Semaphore>,
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => serialEach(all, key, effect);

  // Admission can persist a job while another caller drains launches. Only the
  // drain needs the evaluator permit; the normal tick recovers the queued job.
  const evaluatorAdmission = <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
    enqueueWhenBusy = true,
  ) =>
    serialEach(
      evaluating,
      key,
      effect,
      true,
      enqueueWhenBusy ? effect.pipe(Effect.provideService(enqueueEvaluatorOnly, true)) : undefined,
    );

  const changes = yield* PubSub.unbounded<BoardPublication>();
  const jobs = yield* Queue.unbounded<Job>();
  const kickPending = yield* Ref.make(false);
  /**
   * Work threads whose last card moved on mid-turn keep their slot until the
   * turn ends, so they can take a related card while they have the context.
   * Lost on restart, which only frees slots; tick drops one whose turn ended
   * or that outlived HOLD_MAX_MS.
   */
  const holds = yield* Ref.make<ReadonlyMap<ThreadId, Hold>>(new Map());
  // Evaluators whose last run failed for a non-outage reason: retried once, then given up.
  // In memory on purpose: a restart starts the streaks over.
  const evaluatorFailures = yield* Ref.make<
    ReadonlyMap<
      ThreadId,
      {
        readonly dueAt: number;
        readonly message: string;
        readonly state: "retry" | "sent" | "gone" | "paused";
        readonly runId: string | null;
        readonly ownerDiscussion?: KanbanDiscussionId;
        readonly recoveryPost?: NonNullable<ReturnType<typeof postRecoveryIdentity>>;
      }
    >
  >(new Map());
  // Discussions that already got a fresh evaluator after a give-up, until one finishes a run cleanly.
  const replaced = yield* Ref.make<ReadonlySet<KanbanDiscussion["id"]>>(new Set());
  // Evaluator threads asked for a status: the run it was asked in and when. A new run starts over.
  const statusAsked = yield* Ref.make<
    ReadonlyMap<ThreadId, { readonly run: string; readonly at: number }>
  >(new Map());
  const backgroundWaits = new Map<
    ThreadId,
    {
      boardId: string;
      quietSince: string;
      jobs: Map<string, { label: string; endedAt: number | null }>;
    }
  >();
  const observeBackground = (
    boardId: string,
    threadId: ThreadId,
    view: KanbanThreadView,
    now: number,
  ) => {
    if (view.state !== "idle") {
      backgroundWaits.delete(threadId);
      return;
    }
    const pending = view.backgroundJobs ?? [];
    let wait = backgroundWaits.get(threadId);
    // A provider wake may have run and finished between board ticks.
    if (wait?.quietSince !== view.quietSince) {
      wait = { boardId, quietSince: view.quietSince, jobs: new Map() };
      backgroundWaits.set(threadId, wait);
    }
    const live = new Set(pending.map((job) => job.taskId));
    for (const job of pending)
      wait.jobs.set(job.taskId, {
        label: job.description ?? job.taskId,
        endedAt: null,
      });
    for (const [id, job] of wait.jobs) {
      if (!live.has(id) && job.endedAt === null) job.endedAt = now;
    }
    if (wait.jobs.size === 0) backgroundWaits.delete(threadId);
  };

  // Cards waiting on evaluator subtasks: the step's subtask ids, when the wait began, and whether woken.
  const stepWaits = yield* Ref.make<
    ReadonlyMap<
      KanbanCard["id"],
      {
        readonly key: string;
        readonly since: number;
        readonly woken: boolean;
      }
    >
  >(new Map());
  const forgetStepWait = (cardId: KanbanCard["id"]) =>
    Ref.update(stepWaits, (all) => {
      if (!all.has(cardId)) return all;
      const next = new Map(all);
      next.delete(cardId);
      return next;
    });
  // One reminder per recipient and owner action, including answers on older messages.
  const ownerWaits = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const hold = (
    threadId: ThreadId,
    boardId: string,
    pool: string,
    cardId: string,
    knownCards?: ReadonlyArray<KanbanCard>,
  ) =>
    Effect.flatMap(nowMillis, (at) =>
      Ref.update(holds, (all) =>
        new Map(all).set(threadId, { ...all.get(threadId), boardId, pool, at }),
      ).pipe(Effect.andThen(syncSlot(boardId, threadId, "hold", cardId, knownCards))),
    );
  /** One board's held slots, thread id to pool, as the rules take them. `except`: a start's own key. */
  const boardHolds = (boardId: string, except?: string) =>
    Effect.map(
      Ref.get(holds),
      (all) =>
        new Map([
          ...[...all].flatMap(([threadId, held]) =>
            held.boardId === boardId ? [[threadId as string, held.pool] as const] : [],
          ),
          ...[...starting]
            .filter(([key]) => key.startsWith(`${boardId}:`) && key !== except)
            .map(([key, value]) => [value.threadId ?? key, value.pool] as const),
        ]),
    );
  // Threads confirmed missing at the previous tick; a failed read is not a miss.
  const missing = yield* Ref.make<ReadonlyMap<string, ReadonlySet<ThreadId>>>(new Map());
  // Pool keys whose model is out of usage or down, with when to probe next. In memory:
  // after a restart seedDown rebuilds it from the paused thread links.
  const down = yield* Ref.make<
    ReadonlyMap<
      string,
      {
        readonly delayMs: number;
        readonly nextAt: number;
        // Boards whose "Provider outages" post for this outage landed. Per board, so a
        // board that failed later is still announced by a later probe.
        readonly announced: ReadonlySet<KanbanBoard["id"]>;
        // Boards that already got their "answers again" post for this outage.
        readonly recovered: ReadonlySet<KanbanBoard["id"]>;
      }
    >
  >(new Map());
  // Remember recovered runs so their late events cannot reopen an outage.
  const recoveredThreads = yield* Ref.make<ReadonlyMap<string, string | null>>(new Map());
  // Invalidates a probe when another failed run arrives while it is in flight.
  const outageGeneration = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const deferredNudges = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  const unresolvedTurnEnds = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  const turnEndConflicts = yield* Ref.make<
    ReadonlyMap<ThreadId, { readonly committed: boolean; readonly link: KanbanThreadLink }>
  >(new Map());
  // History survives a reattachment (which resets nudgedAt); cache it after one read.
  const silentStops = new Map<string, { threadId: string; runId: string; at: string } | null>();
  const scanned = yield* Ref.make(false);
  // Pools whose model was off the composer's list at the last tick, as
  // `${boardId}:${poolKey}`. A pool is zeroed only on the second miss in a row.
  const unlistedPools = yield* Ref.make<ReadonlySet<string>>(new Set());
  // Per board: the open-card fingerprint of the scribe's last attempt, when it started,
  // and whether that attempt grouped the board. A failed attempt is retried after the
  // cooldown even when the cards did not change.
  const goalsScribed = yield* Ref.make<
    ReadonlyMap<
      KanbanBoardId,
      { readonly fingerprint: string; readonly at: number; readonly done: boolean }
    >
  >(new Map());
  const scribed = yield* Ref.make<
    ReadonlyMap<
      KanbanBoardId,
      { readonly fingerprint: string; readonly at: number; readonly done: boolean }
    >
  >(new Map());
  const proposalsChecked = yield* Ref.make<ReadonlyMap<KanbanBoardId, number>>(new Map());
  // Boards with a goal-ideas model call still running: a second one would post the same proposal.
  const proposalsRunning = yield* Ref.make<ReadonlySet<KanbanBoardId>>(new Set());
  // Boards with a groups or goals scribe call still running. A call can outlast the
  // SCRIBE_EVERY_MS cooldown, and the next tick must not start a second one beside it.
  const groupsRunning = yield* Ref.make<ReadonlySet<KanbanBoardId>>(new Set());
  const goalsRunning = yield* Ref.make<ReadonlySet<KanbanBoardId>>(new Set());
  // Cards with a title writer running, each with the write asked for meanwhile (null when
  // none): its fields and the card's title and description at the time. One writer per card; the asked-for write runs after it, on the latest card.
  type WriterFields = { readonly title: boolean; readonly description: boolean };
  type WriterAsk = {
    readonly fields: WriterFields;
    readonly asked: Pick<KanbanCard, "title" | "description">;
  };
  type WritersRunning = ReadonlyMap<KanbanCardId, WriterAsk | null>;
  const titlesRunning = yield* Ref.make<WritersRunning>(new Map());
  const dropHold = Effect.fn("KanbanService.dropHold")(function* (
    threadId: ThreadId,
    why: SlotEventWhy = "hold_end",
    cardId: string | null = null,
    expected?: Hold,
  ) {
    const held = yield* Ref.modify(holds, (all) => {
      const current = all.get(threadId);
      if (current === undefined || (expected !== undefined && current !== expected))
        return [undefined, all] as const;
      const next = new Map(all);
      next.delete(threadId);
      return [current, next] as const;
    });
    if (held === undefined) return;
    yield* syncSlot(held.boardId, threadId, why, cardId);
  }, Effect.uninterruptible);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const withWaitTargets = Effect.fn("KanbanService.withWaitTargets")(function* (
    cards: ReadonlyArray<KanbanCard>,
    knownTargets?: CardWriteSnapshot["waitTargets"],
  ) {
    const targets = new Map<string, KanbanCard | null>(cards.map((card) => [card.id, card]));
    const names = new Map<KanbanBoardId, string>();
    for (const id of new Set(
      cards.flatMap((card) =>
        card.wait?.on === "card" && card.wait.card !== null ? [card.wait.card] : [],
      ),
    )) {
      if (!targets.has(id))
        targets.set(
          id,
          knownTargets
            ? (knownTargets.get(id) ?? null)
            : yield* rawStore.card(KanbanCardId.make(id)),
        );
    }
    return yield* Effect.forEach(cards, (card) =>
      Effect.gen(function* () {
        const wait = card.wait;
        if (wait?.on !== "card" || wait.card === null) return card;
        const target = targets.get(wait.card);
        if (!target) return { ...card, wait: { ...wait, cardTarget: null } };
        let boardName: string | null = null;
        if (target.boardId !== card.boardId) {
          boardName =
            names.get(target.boardId) ??
            (knownTargets
              ? knownTargets.get(target.id)?.boardName
              : (yield* rawStore.board(target.boardId))?.name) ??
            target.boardId;
          names.set(target.boardId, boardName);
        }
        return {
          ...card,
          wait: {
            ...wait,
            cardTarget: {
              id: target.id,
              number: target.number,
              boardId: target.boardId,
              boardName,
            },
          },
        };
      }),
    );
  });
  const publish = (boardId: KanbanBoard["id"], change: KanbanChange, waitTargetsReady = false) =>
    Effect.flatMap(publicationSink, (sink) => {
      if (sink === undefined)
        return Effect.gen(function* () {
          const shown =
            change._tag === "card" && !waitTargetsReady
              ? {
                  ...change,
                  card: (yield* withWaitTargets([change.card]).pipe(
                    Effect.catchCause(() => Effect.succeed([change.card])),
                  ))[0]!,
                }
              : change;
          yield* PubSub.publish(changes, { boardId, change: shown });
        });
      sink.push({ boardId, change });
      return Effect.void;
    });

  // Announced so thread lists can leave the board's threads out as they start.
  const linkThread = Effect.fn("KanbanService.linkThread")(function* (
    link: KanbanThreadLink,
    title: string,
    receiptKey?: string,
  ) {
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* store.putThreadLink(link);
        if (link.role === "evaluator") {
          yield* locks.attached(link.threadId);
          yield* SavedWrite.record({ kind: "evaluator", threadId: link.threadId, key: receiptKey });
        }
      }),
    );
    yield* publish(link.boardId, {
      _tag: "thread",
      thread: {
        threadId: link.threadId,
        title,
        running: true,
        needsInput: false,
        lastActivityAt: link.startedAt,
      },
    });
    if (link.role === "evaluator" && link.discussionId === null)
      yield* locks.attached(link.threadId);
  });

  const kick = Effect.gen(function* () {
    // Inside a tick's steps: its own dispatch, right after them, is the kick.
    const ticking = yield* tickKicks;
    if (ticking?.held) {
      ticking.asked = true;
      return;
    }
    const pending = yield* Ref.getAndSet(kickPending, true);
    if (!pending) yield* Queue.offer(jobs, { _tag: "kick" });
  });

  const boardOf = Effect.fn("KanbanService.boardOf")(function* (boardId: string) {
    const board = yield* locks.access(
      boardId,
      rawStore.board(KanbanBoardId.make(boardId)),
      false,
      "board",
    );
    if (!board)
      return yield* failWith(
        "not-found",
        `board ${boardId}`,
        "resource_not_found",
        "not_found",
        "boardId",
      );
    return board;
  });

  /** Fails before a board stores or starts a model/variant the provider doesn't offer. */
  const checkModel = Effect.fn("KanbanService.checkModel")(function* (model: ModelSelection) {
    const problem = modelProblem(yield* providerRegistry.getProviders, model);
    if (problem !== null) return yield* failWith("invalid", problem);
  });

  /**
   * Agents write model ids in many shapes ("opus/x" vs instance "opus" + "x"). Match the
   * request to one of the board's pools so the dispatcher can run it; a model with no pool
   * would sit in To-Do forever. The pool's variant wins, so every card on a pool runs at the
   * board's variant.
   */
  const poolModel = Effect.fn("KanbanService.poolModel")(function* (
    boardId: KanbanBoardId,
    model: ModelSelection,
  ) {
    model = yield* canonicalModel(model);
    const pools = yield* store.pools(boardId);
    const joined = `${model.instanceId}/${model.model}`;
    // An alias names the model without its instance; Rules.aliasPool matches it to its pool.
    const match = Rules.poolFor(pools, model) ?? Rules.aliasPool(pools, model);
    if (!match) {
      // A model the provider refuses is named as such, even when no pool exists for it.
      yield* checkModel(model);
      return yield* failWith(
        "invalid",
        `no pool runs ${joined}; pools: ${pools.map((pool) => pool.model.model).join(", ") || "none"}`,
      );
    }
    const options = new Map(
      (match.model.options ?? model.options ?? []).map((option) => [option.id, option]),
    );
    if (match.model.options !== undefined) {
      // Pool effort wins, but replacing the entire list loses carried caller options.
      for (const option of model.options ?? []) {
        if (
          option.id !== effortOptionId(model.instanceId) &&
          option.id !== "variant" &&
          !options.has(option.id)
        )
          options.set(option.id, option);
      }
    }
    const selected = {
      instanceId: match.model.instanceId,
      model: match.model.model,
      ...(options.size > 0 ? { options: [...options.values()] } : {}),
    } satisfies ModelSelection;
    yield* checkModel(selected);
    return selected;
  });

  /** Each weighted model mapped to a pool, one entry per pool, highest weight first. */
  const cardModels = Effect.fn("KanbanService.cardModels")(function* (
    boardId: KanbanBoardId,
    models: ReadonlyArray<KanbanCardModel>,
  ) {
    if (models.length === 0) return yield* failWith("invalid", "models needs at least one model");
    const pools = yield* store.pools(boardId);
    const mapped: Array<KanbanCardModel> = [];
    for (const entry of models) {
      if (!Number.isInteger(entry.weight) || entry.weight < 1) {
        return yield* failWith("invalid", "each model's weight is a whole number above 0");
      }
      const model = yield* poolModel(boardId, entry.model);
      if (mapped.some((other) => Rules.poolOf(pools, other.model) === Rules.poolOf(pools, model))) {
        return yield* failWith("invalid", `${Rules.poolOf(pools, model)} is listed twice`);
      }
      mapped.push({ model, weight: entry.weight });
    }
    return mapped.toSorted((a, b) => b.weight - a.weight);
  });

  const cardOf = Effect.fn("KanbanService.cardOf")(function* (cardId: KanbanCard["id"]) {
    const card = yield* store.card(cardId);
    if (!card)
      return yield* failWith(
        "not-found",
        `card ${cardId}`,
        "resource_not_found",
        "not_found",
        "card",
      );
    return card;
  });

  const discussionOf = Effect.fn("KanbanService.discussionOf")(function* (
    id: KanbanDiscussion["id"],
  ) {
    const discussion = yield* store.discussion(id);
    if (!discussion)
      return yield* failWith(
        "not-found",
        `discussion ${id}`,
        "resource_not_found",
        "not_found",
        "discussionId",
      );
    return discussion;
  });

  // Runs inside the primary read/post span. Internal discussion lookups can refer
  // to related cards, so they must not replace the tool's target.
  const captureDiscussionContext = Effect.fnUntraced(function* (discussion: KanbanDiscussion) {
    const call = yield* Effect.serviceOption(McpCall);
    if (call._tag === "None" || call.value.cardId !== undefined) return;
    const card = discussion.cardId === null ? null : yield* store.card(discussion.cardId);
    yield* resolvedContext({
      boardId: discussion.boardId,
      ...(discussion.cardId === null ? {} : { id: discussion.cardId }),
      ...(card === null ? {} : { number: card.number, stage: card.stage }),
    });
  });

  const goalOf = Effect.fn("KanbanService.goalOf")(function* (card: KanbanCard) {
    if (card.goalId === null) return null;
    return (yield* store.goals(card.boardId)).find((goal) => goal.id === card.goalId) ?? null;
  });

  const threadState = Effect.fn("KanbanService.threadState")(function* (threadId: ThreadId) {
    const view = yield* threads.view(threadId);
    if (!view) return [];
    const state: KanbanThreadState = {
      threadId,
      title: view.title,
      running: view.state !== "idle" && view.state !== "needs-input",
      needsInput: view.state === "needs-input",
      lastActivityAt: view.updatedAt,
    };
    return [state];
  });

  // Running threads first, then ended history newest first, bounded: a busy board
  // accumulates sweeps, and the Threads view must not list all of them.
  const THREAD_ROWS_ENDED_LIMIT = 200;
  const threadRowsOf = Effect.fn("KanbanService.threadRowsOf")(function* (
    boardId: KanbanBoard["id"],
  ) {
    const links = yield* store.threadLinks({ boardId, open: false });
    const cards = new Map((yield* store.cards(boardId)).map((card) => [card.id, card]));
    const rows = yield* Effect.forEach(
      links,
      (link) =>
        Effect.gen(function* () {
          const view = yield* threads.view(link.threadId);
          const card = link.cardId === null ? undefined : cards.get(link.cardId);
          return {
            threadId: link.threadId,
            boardId: link.boardId,
            role: link.role,
            purpose: link.purpose,
            cardId: link.cardId,
            cardNumber: card?.number ?? null,
            cardTitle: card?.title ?? null,
            discussionId: link.discussionId,
            model: link.model,
            title: view?.title ?? null,
            running: view !== null && view.state !== "idle" && view.state !== "needs-input",
            lastActivityAt: view?.updatedAt ?? null,
            startedAt: link.startedAt,
            endedAt: link.endedAt,
          };
        }),
      { concurrency: 8 },
    );
    const running = rows.filter((row) => row.running);
    const ended = rows
      .filter((row) => !row.running)
      .sort((a, b) =>
        (b.lastActivityAt ?? b.startedAt).localeCompare(a.lastActivityAt ?? a.startedAt),
      )
      .slice(0, THREAD_ROWS_ENDED_LIMIT);
    return [...running, ...ended];
  });

  const liveThreadIds = (cards: ReadonlyArray<Pick<KanbanCard, "activeThreadId">>) => [
    ...new Set(cards.flatMap((card) => (card.activeThreadId ? [card.activeThreadId] : []))),
  ];

  const snapshotOf = Effect.fn("KanbanService.snapshotOf")(function* (
    boardId: KanbanBoard["id"],
    feed = false,
    page?: { readonly after: number; readonly limit: number },
    // The board feed fills thread state after its first frame (see watch).
    deferThreads = false,
  ) {
    const board = yield* boardOf(boardId);
    const cards = yield* withWaitTargets(
      yield* feed ? store.feedCards(boardId, page) : store.cards(boardId),
    );
    const live = liveThreadIds(cards);
    const states = deferThreads ? [] : yield* Effect.forEach(live, threadState, { concurrency: 8 });
    const discussions = yield* store.discussions(boardId);
    const unread = discussions.flatMap((discussion) => {
      const owner = discussion.participants.find(
        (participant) => participant.actor._tag === "owner",
      );
      const count = discussion.lastSeq - (owner?.lastReadSeq ?? 0);
      return count > 0 ? [{ discussionId: discussion.id, count }] : [];
    });
    return {
      board,
      cards: feed ? cards.map(BoardReplies.feedCard) : cards,
      goals: (yield* feed ? store.feedGoals(boardId) : store.goals(boardId)).map((goal) =>
        feed ? BoardReplies.feedGoal(goal) : goal,
      ),
      pools: yield* store.pools(boardId),
      groups: yield* store.groups(boardId),
      threads: states.flat(),
      ...(deferThreads && live.length > 0 ? { threadsPending: true } : {}),
      unread,
    } satisfies KanbanBoardSnapshot;
  });

  // Keep each board/thread's persisted pools, including transient multi-pool states.
  // Only update the cache after its row commits, so a failed append remains retryable.
  const slotState = new Map<string, Map<string, Set<string>>>();
  const slotWrites = Semaphore.makeUnsafe(1);
  const syncSlot = Effect.fn("KanbanService.syncSlot")(function* (
    boardId: string,
    threadId: string,
    why: SlotEventWhy,
    cardId: string | null,
    knownCards?: ReadonlyArray<KanbanCard>,
  ) {
    yield* SavedWrite.bestEffort(
      slotWrites.withPermits(1)(
        Effect.gen(function* () {
          const cards = (knownCards ?? (yield* rawStore.cardsByThread(threadId))).filter(
            (card) => card.boardId === boardId,
          );
          const held = (yield* Ref.get(holds)).get(ThreadId.make(threadId));
          const current = Rules.poolThreads(
            cards,
            new Map(held?.boardId === boardId ? [[threadId, held.pool]] : []),
          );
          const board = slotState.get(boardId) ?? new Map<string, Set<string>>();
          const before = board.get(threadId) ?? new Set<string>();
          const at = yield* nowIso;
          for (const kind of ["release", "take"] as const) {
            for (const poolKey of kind === "release" ? [...before] : current.keys()) {
              if (kind === "release" ? current.has(poolKey) : before.has(poolKey)) continue;
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* rawStore.addSlotEvent({
                    boardId,
                    poolKey,
                    threadId,
                    cardId,
                    kind,
                    at,
                    why,
                  });
                  if (kind === "release") before.delete(poolKey);
                  else before.add(poolKey);
                  if (before.size === 0) board.delete(threadId);
                  else board.set(threadId, before);
                  slotState.set(boardId, board);
                }),
              );
            }
          }
        }),
      ),
      undefined,
    );
  });
  const seedSlots = Effect.fn("KanbanService.seedSlots")(function* () {
    const rows = yield* rawStore.openSlots();
    slotState.clear();
    for (const row of rows) {
      const board = slotState.get(row.boardId) ?? new Map<string, Set<string>>();
      const pools = board.get(row.threadId) ?? new Set<string>();
      pools.add(row.poolKey);
      board.set(row.threadId, pools);
      slotState.set(row.boardId, board);
    }
  });
  const reconcileSlots = Effect.fn("KanbanService.reconcileSlots")(function* () {
    const affected = new Map<string, Set<string>>();
    for (const [boardId, threads] of slotState) affected.set(boardId, new Set(threads.keys()));
    for (const board of yield* rawStore.boards) {
      const threads = affected.get(board.id) ?? new Set<string>();
      for (const card of yield* rawStore.cards(board.id)) {
        if (card.activeThreadId !== null && card.activePool !== null)
          threads.add(card.activeThreadId);
      }
      affected.set(board.id, threads);
    }
    for (const [boardId, threads] of affected) {
      for (const threadId of threads) yield* syncSlot(boardId, threadId, "restart", null);
    }
  });

  const prepareTransition = Effect.fn("KanbanService.prepareTransition")(function* (
    card: KanbanCard,
    knownBefore?: KanbanCard,
  ) {
    if (preparedTransitions.has(card)) return;
    const before = knownBefore ?? (yield* store.card(card.id));
    if (
      before !== null &&
      ((before.activeThreadId !== null && before.activeThreadId !== card.activeThreadId) ||
        (before.stage !== card.stage &&
          !KANBAN_THREAD_STAGES.includes(card.stage) &&
          ["working", "in_review", "needs_review"].includes(before.stage)))
    ) {
      for (const id of new Set([before.activeThreadId, before.workThreadId])) {
        if (id !== null)
          yield* pruneWakes(id, card.id, card.discussionId, knownBefore !== undefined);
      }
    }
    // The event and card write share this immutable candidate; never re-read a fallible queue between them.
    preparedTransitions.add(card);
  });

  interface CardWriteSnapshot {
    readonly before: KanbanCard;
    readonly board: KanbanBoard;
    readonly reviewLink: KanbanThreadLink | null;
    readonly events: ReadonlyArray<KanbanCardEvent>;
    readonly slots: ReadonlyMap<string, ReadonlyArray<KanbanCard>>;
    readonly waitTargets: ReadonlyMap<string, KanbanCard & { readonly boardName?: string }>;
    readonly workCards: ReadonlyArray<KanbanCardId>;
  }

  // Callers hold the lock, and log a card's event before saving it: clients
  // re-read the card's history when its change is published.

  // `by` is set when a move saved the card, so a script's own move doesn't re-trigger a card.moved script.
  const saveCard = Effect.fn("KanbanService.saveCard")(function* (
    incoming: KanbanCard,
    by?: KanbanActor,
    dispatchMetadata = false,
    slotWhy?: SlotEventWhy | false,
    releaseBoard?: KanbanBoard,
    snapshot?: CardWriteSnapshot,
  ) {
    yield* prepareTransition(incoming, snapshot?.before);
    const actor: KanbanActor = analyticsActors.get(incoming) ??
      by ?? { _tag: "system", component: "dispatcher" };
    let card = incoming;
    const previous =
      snapshot?.before ?? (yield* SavedWrite.bestEffort(rawStore.card(card.id), null));
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (
          card.asks.some(
            (ask) => ask.timing === undefined && ask.seq === null && ask.closedAt === null,
          )
        ) {
          const previous = snapshot?.before ?? (yield* store.card(card.id));
          card = {
            ...card,
            asks: card.asks.map((ask) => {
              const timing = previous?.asks.find((old) => old.id === ask.id)?.timing;
              return ask.timing === undefined && timing !== undefined ? { ...ask, timing } : ask;
            }),
          };
          const fresh = card.asks.filter(
            (ask) =>
              ask.timing === undefined &&
              ask.seq === null &&
              ask.closedAt === null &&
              !previous?.asks.some((old) => old.id === ask.id),
          );
          if (fresh.length > 0) {
            const rows = yield* boardSql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM ardud_kanban_cards c, json_each(c.json, '$.asks') a WHERE instr(c.json, '"closedAt":null') > 0 AND json_extract(a.value, '$.closedAt') IS NULL AND COALESCE(json_extract(a.value, '$.to'), 'owner') != 'evaluator'`;
            card = {
              ...card,
              asks: card.asks.map((ask) => {
                const index = fresh.findIndex((entry) => entry.id === ask.id);
                return index < 0
                  ? ask
                  : {
                      ...ask,
                      timing: {
                        kind: askKind(ask),
                        openAsksAtCreation: (rows[0]?.count ?? 0) + index,
                      },
                    };
              }),
            };
          }
        }
        if (card.reviewThreadId !== null) {
          const active = card.settledAt === null && card.activeThreadId === card.reviewThreadId;
          const queued =
            card.stage === "needs_review" &&
            Rules.reviewThreadToReuse(snapshot?.board ?? (yield* boardOf(card.boardId)), card) ===
              card.reviewThreadId;
          if (!active && !queued)
            yield* endReviewLink(card.reviewThreadId, undefined, snapshot?.reviewLink);
        }
        let before = snapshot?.before ?? (yield* store.card(card.id));
        if (
          Option.isSome(analytics) &&
          before !== null &&
          before.analyticsStageEnteredAt === undefined
        ) {
          // Seed old cards from their actual transition history, since queue age may predate it.
          const stage = before.stage;
          const entered = (snapshot?.events ?? (yield* store.cardEvents(card.id))).findLast(
            (event) => event.toStage === stage && event.fromStage !== event.toStage,
          );
          const since =
            entered !== undefined && Date.parse(entered.at) > Date.parse(before.movedAt)
              ? entered.at
              : before.movedAt;
          before = { ...before, analyticsStageEnteredAt: since };
        }
        if (Option.isSome(analytics))
          card = {
            ...card,
            analyticsStageEnteredAt:
              before === null || before.stage !== card.stage || before.movedAt !== card.movedAt
                ? yield* nowIso
                : (before.analyticsStageEnteredAt ?? before.movedAt),
          };
        // Other mutations must not roll back a version used as an edit's basedOn.
        if (before !== null && Date.parse(card.updatedAt) < Date.parse(before.updatedAt))
          card = { ...card, updatedAt: before.updatedAt };
        // A release completion and its pacing receipt must survive the same restart.
        const write = releaseBoard
          ? boardTransaction(
              card.boardId,
              store.putBoard(releaseBoard).pipe(Effect.andThen(store.putCard(card))),
            )
          : snapshot
            ? store.updateCard(card, snapshot.before)
            : store.putCard(card);
        yield* dispatchMetadata ? locks.dispatchMetadata(write) : write;
        yield* SavedWrite.record({ kind: "card", card });
        for (const event of BoardAnalytics.cardEvents(before, card, actor))
          yield* recordAnalytics(event);
        if (card.stalled?.by._tag === "evaluator") yield* forgetStepWait(card.id);

        if (
          slotWhy !== false &&
          (previous?.activePool !== card.activePool ||
            previous?.activeThreadId !== card.activeThreadId)
        ) {
          const why =
            slotWhy ??
            (previous?.activeThreadId === card.activeThreadId &&
            previous?.activePool !== null &&
            card.activePool !== null
              ? "pool_moved"
              : "card_left");
          for (const threadId of new Set([previous?.activeThreadId, card.activeThreadId])) {
            if (threadId != null)
              yield* syncSlot(
                card.boardId,
                threadId,
                why,
                card.id,
                snapshot?.slots.get(threadId)?.map((row) => (row.id === card.id ? card : row)),
              );
          }
        }
      }),
    );
    if (releaseBoard)
      yield* SavedWrite.bestEffort(
        publish(card.boardId, { _tag: "board", board: releaseBoard }),
        undefined,
      );
    yield* SavedWrite.bestEffort(
      Effect.gen(function* () {
        const shown = snapshot ? (yield* withWaitTargets([card], snapshot.waitTargets))[0]! : card;
        yield* publish(
          card.boardId,
          by === undefined ? { _tag: "card", card: shown } : { _tag: "card", card: shown, by },
          snapshot !== undefined,
        );
      }),
      undefined,
    );
  });

  const logEvent = Effect.fn("KanbanService.logEvent")(function* (
    card: KanbanCard,
    actor: KanbanActor,
    kind: KanbanCardEvent["kind"],
    extra: {
      readonly at?: string;
      readonly fromStage?: KanbanStage | null;
      readonly toStage?: KanbanStage | null;
      readonly body?: string | null;
      readonly sourceThreadId?: ThreadId;
      readonly head?: string | null;
      readonly instructionApplication?: InstructionApplication;
      readonly undoAssignment?: true;
      readonly assignmentWake?: NonNullable<KanbanCardEvent["assignmentWake"]>;
      readonly before?: KanbanCard;
    } = {},
  ) {
    if (extra.undoAssignment) preparedTransitions.add(card);
    else yield* prepareTransition(card, extra.before);
    analyticsActors.set(card, actor);
    const write = store.addCardEvent(
      {
        cardId: card.id,
        at: extra.at ?? (yield* nowIso),
        actor,
        kind,
        fromStage: extra.fromStage ?? null,
        toStage: extra.toStage ?? null,
        body: extra.body ?? null,
        ...(extra.sourceThreadId === undefined ? {} : { sourceThreadId: extra.sourceThreadId }),
        head: extra.head ?? null,
        ...(extra.assignmentWake === undefined ? {} : { assignmentWake: extra.assignmentWake }),
      },
      extra.instructionApplication?.id,
      card,
    );
    if (extra.instructionApplication === undefined) {
      const event = yield* write;
      if (kind === "moved" && actor._tag !== "system") {
        if (card.activeThreadId === null && ["todo", "needs_review"].includes(card.stage))
          assignmentWakeRetries.set(card.id, { movedAt: card.movedAt, attempts: 0, retryAt: 0 });
        else assignmentWakeRetries.delete(card.id);
      }
      return event;
    }
    const application = extra.instructionApplication;
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const event = yield* write;
        yield* Effect.logInfo(
          application.field === "guessedGates"
            ? "kanban board settings applied"
            : "kanban board instructions applied",
          {
            boardId: application.boardId,
            board: application.boardSlug,
            field: application.field,
            cardId: application.cardId,
            askId: application.askId,
            threadId: application.threadId,
            applicationId: application.id,
          },
        );
        return event;
      }),
    );
  });

  /**
   * A card held for its evaluator (`deciding`, set by the write that ended its
   * wait): the note reached that evaluator, so the end of its turn lets the card go.
   */
  const decidingTold = Effect.fn("KanbanService.decidingTold")(function* (
    cardId: KanbanCard["id"] | null,
  ) {
    const card = cardId === null ? null : yield* store.card(cardId);
    if (!card || card.deciding === undefined || card.deciding.toldAt !== null) return;
    const at = yield* nowIso;
    yield* saveCard({ ...card, deciding: { ...card.deciding, toldAt: at }, updatedAt: at });
  });
  /**
   * Lets a card held for its evaluator go: the hold comes off and the dispatcher
   * and the tick treat the card as they would without it. `told`: only a hold
   * whose note was delivered (the evaluator's turn ending means nothing before
   * that). `body` goes in the card's history.
   */
  const endDeciding = Effect.fn("KanbanService.endDeciding")(function* (
    cardId: KanbanCard["id"] | null,
    options: { readonly told?: boolean; readonly body?: string } = {},
  ) {
    const card = cardId === null ? null : yield* store.card(cardId);
    if (!card || card.deciding === undefined) return;
    if (options.told === true && card.deciding.toldAt === null) return;
    const next: KanbanCard = { ...kanbanWithoutDeciding(card), updatedAt: yield* nowIso };
    if (options.body !== undefined) {
      yield* logEvent(next, { _tag: "system", component: "waits" }, "edited", {
        body: options.body,
      });
    }
    yield* saveCard(next);
    yield* kick;
  });

  const release = (card: KanbanCard) =>
    ({
      ...withoutDetachedSteer(card),
      activeThreadId: null,
      activeRole: null,
      activePool: null,
    }) satisfies KanbanCard;

  const settleDetachedSteer = Effect.fn("KanbanService.settleDetachedSteer")(function* (
    card: KanbanCard | null,
    view: KanbanThreadView | null,
    fence: number | undefined,
  ) {
    if (
      card?.detachedSteerAt !== undefined &&
      view?.state === "idle" &&
      card.workThreadId === view.threadId &&
      fence === (threadFences.get(view.threadId) ?? 0)
    ) {
      const next = { ...withoutDetachedSteer(card), updatedAt: yield* nowIso };
      yield* saveCard(next);
      return next;
    }
    return card;
  });

  const upgradeFindings = Effect.fn("KanbanService.upgradeFindings")(function* (
    cards: ReadonlyArray<KanbanCard>,
    persist = true,
    cardEvents: typeof rawStore.cardEvents = store.cardEvents,
  ) {
    return yield* Effect.forEach(cards, (card) =>
      Effect.gen(function* () {
        const open = kanbanStepSubtasks(card);
        if (
          card.reviewFindingsPending !== undefined ||
          card.reviewRound === 0 ||
          open.length === 0 ||
          !open.every((s) => s.owner === "review")
        )
          return card;
        // Older workers consumed their only findings marker. Read the actual
        // verdict once: a historical findings round alone is not a pending bounce.
        const verdict = (yield* cardEvents(card.id)).findLast((e) => e.kind === "review");
        const next = {
          ...card,
          reviewFindingsPending: verdict?.toStage === "todo" && verdict.body !== "clear",
        };
        if (persist) {
          yield* saveCard(next);
          yield* kick;
        }
        return next;
      }),
    );
  });

  const releaseToQueue = (card: KanbanCard, at: string): KanbanCard => ({
    ...release(card),
    stage:
      card.stage === "working" ? "todo" : card.stage === "in_review" ? "needs_review" : card.stage,
    updatedAt: at,
  });

  // Logged when a card leaves a thread that got too long; a repeat inside an hour is flagged.
  const FRESH_START = Retries.FRESH_START_EVENT;
  const COMPACT_FIRST = "Thread too long; compacting it before the next run";
  const happenedRecently = (card: KanbanCard, at: string, prefix: string) =>
    store
      .cardEvents(card.id)
      .pipe(
        Effect.map((events) =>
          events.some(
            (event) =>
              event.body?.startsWith(prefix) === true &&
              Date.parse(at) - Date.parse(event.at) < Rules.CONTEXT_FULL_RETRY_MS,
          ),
        ),
      );
  const freshStartedRecently = (card: KanbanCard, at: string) =>
    happenedRecently(card, at, FRESH_START);
  const compactedRecently = (card: KanbanCard, at: string) =>
    happenedRecently(card, at, COMPACT_FIRST);
  // A released todo card records maintenance even when it shares the thread
  // with other cards that were not running when the compaction was requested.
  const threadCompacting = Effect.fn("KanbanService.threadCompacting")(function* (
    threadId: ThreadId,
    cards: ReadonlyArray<KanbanCard>,
  ) {
    let latest: KanbanCardEvent | undefined;
    for (const candidate of cards) {
      if (
        candidate.stage !== "todo" ||
        candidate.activeThreadId !== null ||
        candidate.workThreadId !== threadId
      )
        continue;
      const lastMove = (yield* store.cardEvents(candidate.id)).findLast(
        (event) => event.kind === "moved",
      );
      if (
        lastMove?.body?.startsWith(COMPACT_FIRST) &&
        (latest === undefined || lastMove.id > latest.id)
      ) {
        latest = lastMove;
      }
    }
    return latest;
  });
  const withFreshNote = (note: string | null | undefined) =>
    [note?.trim(), Briefs.FRESH_THREAD_NOTE].filter((part): part is string => !!part).join("\n\n");

  const endReviewLink = Effect.fn("KanbanService.endReviewLink")(function* (
    threadId: ThreadId | null,
    at?: string,
    known?: KanbanThreadLink | null,
  ) {
    if (threadId === null) return;
    const link = known === undefined ? yield* store.threadLink(threadId) : known;
    if (link?.role !== "review" || link.endedAt !== null) return;
    yield* store.putThreadLink({ ...link, endedAt: at ?? (yield* nowIso) });
  });

  const pruneWakes = Effect.fn("KanbanService.pruneWakes")(function* (
    threadId: ThreadId,
    cardId: string,
    discussionId: string | null,
    outsideCancellation = false,
  ) {
    const scopes = [
      "nudge",
      `step:${cardId}`,
      `assignment:${cardId}`,
      `plan:${cardId}`,
      `owner:${cardId}`,
      ...(discussionId === null ? [] : [`owner:${discussionId}`]),
    ];
    // Queue reads can wait on statev2's reader. Replay a fenced read after a
    // concurrent board write; no card transition has been saved at this point.
    const queued = yield* Effect.gen(function* () {
      while (true) {
        const fence = threadFences.get(threadId) ?? 0;
        const runs = yield* threadRead("pruneWakes", threadId, threadIo.queuedRuns(threadId));
        // A send still in flight must withdraw its own stale result. If it
        // finished during the read, scan again to include what it enqueued.
        for (const pending of scopedWakeSends.get(threadId) ?? []) {
          if (scopes.includes(pending.scope)) pending.stale = true;
        }
        if (fence === (threadFences.get(threadId) ?? 0)) return runs;
      }
    });
    const wakes = queuedWakes(queued, Infinity, scopes);
    if (wakes.length === 0) return;
    const cancel = Effect.gen(function* () {
      const cancelling = yield* locks
        .independent(
          Effect.forEach(
            wakes,
            (wake) => touching(threadId, threadIo.cancelQueued(threadId, wake.id)),
            {
              discard: true,
            },
          ),
        )
        .pipe(Effect.interruptible, Effect.forkIn(scope));
      yield* Fiber.join(cancelling).pipe(
        Effect.interruptible,
        Effect.timeout("5 seconds"),
        // A dispatched cancellation may be finishing an uninterruptible commit.
        // It only names old run IDs; don't keep the gate while it acknowledges.
        Effect.ensuring(Effect.sync(() => cancelling.interruptUnsafe())),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.fail(
              new KanbanThreadError({
                operation: "cancel",
                detail: "Wake cleanup exceeded 5 seconds; the card transition was not saved.",
              }),
            ),
        }),
      );
    });
    // Cancellation reads statev2 before and after its command. Snapshot-backed
    // transitions release the gate for both; cancelling these specific old run
    // IDs is idempotent, so a generation change may safely repeat the cleanup.
    yield* outsideCancellation ? locks.outside(cancel, undefined, true) : cancel;
  });

  /**
   * A card leaves its live thread. The thread's own move happens mid-turn, so
   * the turn finishes by itself; a work thread with no card left keeps its
   * slot until then. Anyone else stops the thread, or, when it still carries
   * other cards, tells it to drop this one. True when the thread goes on
   * with other cards.
   */
  const letGo = Effect.fn("KanbanService.letGo")(function* (
    card: KanbanCard,
    bySelf: boolean,
    what: string,
    {
      until = null,
      respectPause = false,
      threadId = card.activeThreadId,
      cancelQueued = false,
      snapshot,
    }: {
      /** Set to pause the card instead of dropping it: when it comes back. */
      readonly until?: string | null;
      readonly respectPause?: boolean;
      readonly threadId?: ThreadId | null;
      readonly cancelQueued?: boolean;
      readonly snapshot?: CardWriteSnapshot | undefined;
    } = {},
  ) {
    if (threadId === null) return false;
    if (threadId === card.reviewThreadId)
      yield* endReviewLink(threadId, undefined, snapshot?.reviewLink);
    const pending = delivering.get(card.id);
    if (pending?.threadId === threadId) pending.revoked = true;
    const others =
      card.activeRole === "work" || cancelQueued
        ? (snapshot?.slots.get(threadId) ?? (yield* store.cardsByThread(threadId))).filter(
            (other) => other.id !== card.id,
          )
        : [];
    if (bySelf) {
      if (
        card.activeRole === "work" &&
        others.every((other) => delivering.has(other.id)) &&
        card.activePool !== null
      ) {
        yield* hold(
          threadId,
          card.boardId,
          card.activePool,
          card.id,
          snapshot?.slots.get(threadId),
        );
      }
      return others.length > 0;
    }
    if (others.length === 0) {
      const reason = `Card #${card.number} ${what}`;
      yield* later(
        card.boardId,
        cardLane(card),
        { kind: "interrupt", threadId, reason, cancelQueued },
        threads.interrupt(threadId, reason, cancelQueued),
      );
      return false;
    }
    const board = respectPause ? yield* boardOf(card.boardId) : null;
    // A live held worker must hear about the flag, without waking an idle one.
    const steerOnly = board?.pause && others.some((other) => !board.pause!.keep.includes(other.id));
    const text =
      until !== null
        ? Briefs.pauseCardText(card, what, until, others)
        : Briefs.dropCardText(card, what, others);
    yield* later(
      card.boardId,
      cardLane(card),
      { kind: "release", threadId, text, ...(steerOnly ? { mode: "steer" as const } : {}) },
      threads
        .send({ threadId, text, ...(steerOnly ? { mode: "steer" as const } : {}) })
        .pipe(Effect.ignore),
    );
    return true;
  });

  const waitTargetFacts = Effect.fn("KanbanService.waitTargetFacts")(function* (
    target: KanbanCard,
    sourceBoardId: KanbanBoardId,
    boardNames = new Map<KanbanBoardId, string>(),
  ) {
    if (target.boardId === sourceBoardId) return target;
    let boardName = boardNames.get(target.boardId);
    if (boardName === undefined) {
      boardName = (yield* store.board(target.boardId))?.name ?? target.boardId;
      boardNames.set(target.boardId, boardName);
    }
    return { ...target, boardName };
  });

  const moveWait = Effect.fn("KanbanService.moveWait")(function* (
    card: KanbanCard,
    to: KanbanStage,
    at: string,
    actor: KanbanActor,
    keep = false,
    snapshot?: CardWriteSnapshot,
  ) {
    if (card.wait === undefined) return card;
    if (keep) return { ...card, wait: { ...card.wait, at } };
    const dependency =
      card.wait.card === null
        ? null
        : snapshot
          ? (snapshot.waitTargets.get(card.wait.card) ?? null)
          : yield* store.card(KanbanCardId.make(card.wait.card));
    const cards =
      dependency === null
        ? undefined
        : new Map([
            [
              dependency.id as string,
              snapshot ? dependency : yield* waitTargetFacts(dependency, card.boardId),
            ],
          ]);
    const next = kanbanWithoutWait(card);
    yield* logEvent(next, actor, Waits.waitEventKind("wait_cleared"), {
      at,
      ...(snapshot === undefined ? {} : { before: snapshot.before }),
      body: Waits.waitEndedBody(
        `the card was moved to ${to}; it was waiting ${Waits.waitingFor(card.wait, cards)}`,
      ),
    });
    return next;
  });

  const endCardThreads = Effect.fn("KanbanService.endCardThreads")(function* (
    card: KanbanCard,
    what: string,
  ) {
    yield* endReviewLink(card.reviewThreadId);
    let kept = false;
    for (const threadId of new Set([card.activeThreadId, card.workThreadId, card.reviewThreadId])) {
      if (threadId === null) continue;
      const shared = yield* letGo(card, false, what, { threadId, cancelQueued: true });
      if (!shared) yield* dropHold(threadId, "thread_stopped", card.id);
      if (threadId === card.workThreadId && shared) kept = true;
    }
    return kept;
  });

  const moveUnlocked = Effect.fn("KanbanService.moveUnlocked")(function* (
    card: KanbanCard,
    to: KanbanStage,
    role: Rules.MoveRole,
    actor: KanbanActor,
    options: KanbanMoveOptions = {},
    snapshot?: CardWriteSnapshot,
  ) {
    const board = snapshot?.board ?? (yield* boardOf(card.boardId));
    const check = Rules.checkMove(role, card, to);
    if (!check.ok)
      return yield* failWith(
        "denied",
        check.reason,
        ("denyReason" in check ? check.denyReason : undefined) ?? "role_not_allowed",
      );
    const waitFrom =
      card.stage === "needs_owner" && to === "needs_review"
        ? (snapshot
            ? snapshot.events.findLast(
                (event) => event.kind === "moved" && event.toStage === "needs_owner",
              )
            : yield* askedBy(card)
          )?.fromStage
        : null;
    // A pause only resumes a review when its recorded origin and counter
    // identify an unfinished chain. Work-origin and unknown pauses start over.
    const resumeReview =
      (waitFrom === "in_review" || waitFrom === "needs_review") &&
      !Rules.reviewFinished(card, Rules.chainFor(board, card)?.steps.length ?? 1);
    const at = yield* nowIso;
    const leaving = card.activeThreadId !== null && !KANBAN_THREAD_STAGES.includes(to);
    const bySelf = role === "cardThread";
    // A card waiting on the owner comes back to its thread with the answer.
    const kept = !leaving
      ? false
      : to === "needs_owner"
        ? yield* letGo(card, bySelf, "waits on the owner's answer", {
            until: "with the answer",
            snapshot,
          })
        : yield* letGo(card, bySelf, `moved to ${to}`, { snapshot });
    // Pulled back to todo while its thread goes on with other cards: the
    // thread was told to drop it, so it starts fresh instead of rejoining.
    const base = leaving
      ? {
          ...release(card),
          workThreadId: kept && !bySelf && to === "todo" ? null : card.workThreadId,
        }
      : card;
    const asked = options.question?.trim() || null;
    let next: KanbanCard = {
      // A real move ends the attempt its automatic retry belonged to.
      ...Retries.withoutRetries(
        yield* moveWait(
          base,
          to,
          at,
          actor,
          card.activeThreadId === null &&
            (options.keepWait === true ||
              ((to === "completed" || to === "deployed") &&
                card.subtasks.some(
                  (subtask) =>
                    subtask.state === "open" &&
                    (subtask.owner === "evaluator" || subtask.owner === "script"),
                ))),
          snapshot,
        ),
      ),
      stage: to,
      ...(to === "needs_review" ? { reviewFindingsPending: false } : {}),
      movedAt: at,
      updatedAt: at,
      question: to === "needs_owner" ? (asked ?? card.question) : null,
      reviewStep:
        to === "needs_review" &&
        (card.stage === "working" ||
          card.stage === "todo" ||
          (card.stage === "needs_owner" && !resumeReview))
          ? 0
          : card.reviewStep,
    };
    // The question becomes a blocking ask, unless it is one already (made blocking).
    if (
      to === "needs_owner" &&
      asked !== null &&
      !kanbanOpenAsks(card).some((ask) => ask.blocking && ask.text === asked)
    ) {
      next = Asks.addAsk(next, asked, true, actor, at);
    }
    // Moved out of Needs Owner without an answer: its blocking asks are over,
    // and their askers hear it (a worker in its wake note when it is next).
    const dropped =
      card.stage === "needs_owner" && to !== "needs_owner"
        ? kanbanOpenAsks(card).filter((ask) => ask.blocking && actorKey(ask.by) !== actorKey(actor))
        : [];
    if (card.stage === "needs_owner" && to !== "needs_owner") {
      next = Asks.closeAsks(next, at, (ask) => ask.blocking);
    }
    const workerDropped = dropped.filter(
      (ask) => ask.by._tag === "thread" && ask.by.threadId === next.workThreadId,
    );
    if (to === "todo" && workerDropped.length > 0) {
      const texts = workerDropped.map((ask) =>
        Asks.droppedText(next, ask, actor._tag === "owner", board.guessedGates),
      );
      next = { ...next, wakeNote: [next.wakeNote, ...texts].filter(Boolean).join("\n\n") };
    }
    yield* logEvent(next, actor, "moved", {
      fromStage: card.stage,
      toStage: to,
      body: options.note ?? null,
      ...(snapshot === undefined ? {} : { before: snapshot.before }),
    });
    yield* saveCard(next, actor, false, undefined, undefined, snapshot);
    for (const ask of dropped) {
      if (ask.by._tag !== "evaluator") continue;
      const evaluator = ask.by.threadId;
      const text = Asks.droppedText(next, ask, actor._tag === "owner", board.guessedGates);
      yield* later(
        next.boardId,
        cardLane(next),
        {
          kind: "tellEvaluator",
          threadId: evaluator,
          text,
          evaluatorTrigger: (yield* EvaluatorAnalytics.origin) ?? "step_transition",
          evaluatorCardId: next.id,
        },
        Effect.gen(function* () {
          if (!(yield* liveEvaluator(evaluator))) return;
          yield* threads.send({ threadId: evaluator, text }).pipe(Effect.ignore);
        }),
      );
    }
    yield* kick;
    return next;
  });

  const reviewEvidence = Effect.fn("KanbanService.reviewEvidence")(function* (
    board: KanbanBoard,
    card: KanbanCard,
  ) {
    const events = yield* store.cardEvents(card.id);
    const verdict = events.findLast((event) => event.kind === "review") ?? null;
    const view = card.workThreadId === null ? null : yield* threads.view(card.workThreadId);
    const solo =
      card.workThreadId !== null &&
      (view?.prs.length ?? 0) > 0 &&
      (yield* store.threadCards(card.workThreadId)).every((id) => id === card.id);
    const heads = (view?.prs ?? [])
      .filter((pr) => solo || card.links.some((link) => link.kind === "pr" && link.url === pr.url))
      .flatMap((pr) => (pr.observedHead ? [pr.observedHead] : []));
    // Explicit handbacks invalidate the prior verdict even without a PR watch.
    // Automatic subtask advancement does not request another review of unchanged work.
    const requested =
      (card.reviewStep > 0 && card.reviewStep < (Rules.chainFor(board, card)?.steps.length ?? 1)) ||
      events.some(
        (event) =>
          event.id > (verdict?.id ?? 0) &&
          event.kind === "moved" &&
          event.toStage === "needs_review" &&
          event.body !== "Next step is the review",
      );
    return { heads, verdict, requested };
  });

  const placeFinishedReview = Effect.fn("KanbanService.placeFinishedReview")(function* (
    board: KanbanBoard,
    card: KanbanCard,
    actor: KanbanActor,
    ids: string,
  ) {
    const steps = Math.max(1, Rules.chainFor(board, card)?.steps.length ?? 1);
    const cleared = Rules.applyReviewResult({ ...card, reviewStep: steps - 1 }, steps, "clear");
    const to = kanbanOpenStep(card) !== null ? "todo" : cleared.stage;
    const at = yield* nowIso;
    const next: KanbanCard = {
      ...Retries.withoutRetries(release(yield* moveWait(card, to, at, actor))),
      stage: to,
      reviewStep: Subtasks.workAfterReview(card) ? 0 : cleared.reviewStep,
      reviewFindingsPending: false,
      wakeNote: Subtasks.workAfterReview(card)
        ? Subtasks.nextStepNote("The review passed. ")
        : null,
      nudgedAt: null,
      movedAt: at,
      updatedAt: at,
    };
    const owner = kanbanStepSubtasks(next)[0]?.owner;
    yield* logEvent(next, actor, "moved", {
      fromStage: card.stage,
      toStage: to,
      body: `Review step already done (${ids}); ${owner === undefined ? (to === "completed" ? "plan completed" : "waiting for PRs to land") : `next step is the ${Subtasks.OWNER_NAMES[owner]}'s`}`,
    });
    yield* saveCard(next, actor);
    yield* laterEvaluatorTurn(card, next, actor);
    return next;
  });

  const reviewPlanClear = (card: KanbanCard) =>
    card.reviewFindingsPending !== true &&
    !card.subtasks.some(
      (subtask) =>
        subtask.state === "open" && (subtask.owner === "work" || subtask.owner === "review"),
    ) &&
    !kanbanOpenAsks(card).some((ask) => ask.blocking);

  const trackedPrs = (card: KanbanCard) =>
    card.links.filter((link) => link.kind === "pr" && link.state !== null);

  const logStageSync = Effect.fn("KanbanService.logStageSync")(function* (card: KanbanCard) {
    yield* Effect.logInfo("kanban.stage_sync", {
      card: card.id,
      boardId: card.boardId,
      from: "in_review",
      to: "completed",
      reason: "review clear and PRs merged",
      prStates: trackedPrs(card).map((pr) => pr.state),
    });
  });

  const syncReviewedStage = Effect.fn("KanbanService.syncReviewedStage")(function* (
    card: KanbanCard,
  ) {
    if (
      card.stage !== "in_review" ||
      card.activeThreadId !== null ||
      card.settledAt !== null ||
      card.stalled !== null ||
      !reviewPlanClear(card) ||
      trackedPrs(card).length === 0 ||
      !Rules.prsLanded(card)
    )
      return card;
    const board = yield* boardOf(card.boardId);
    if (!Rules.reviewFinished(card, Rules.chainFor(board, card)?.steps.length ?? 1)) return card;
    const at = yield* nowIso;
    if (Waits.decidingHolds(card, Date.parse(at))) return card;
    const actor: KanbanActor = { _tag: "system", component: "dispatcher" };
    // A wait belongs to the remaining evaluator/script plan, not the finished review.
    const next: KanbanCard = {
      ...(yield* moveWait(card, "completed", at, actor, true)),
      stage: "completed",
      movedAt: at,
      updatedAt: at,
    };
    yield* logEvent(next, actor, "moved", {
      fromStage: card.stage,
      toStage: next.stage,
      body: "review clear and PRs merged",
    });
    yield* saveCard(next);
    yield* logStageSync(next);
    yield* laterEvaluatorTurn(card, next, actor);
    return next;
  });

  /**
   * Copies the work thread's tracked PRs (same source as the sidebar) onto the
   * card. A thread that carried several cards attaches PRs per card itself, so
   * then only the states of PRs already on the card are refreshed.
   */
  const syncPrs = Effect.fn("KanbanService.syncPrs")(function* (
    source: KanbanCard,
    canSave?: () => Effect.Effect<boolean>,
    snapshot?: CardWriteSnapshot,
  ) {
    // Follow-up runs after releasing the original permit. Fence its own current row before I/O.
    const card = snapshot?.before ?? (yield* cardOf(source.id));
    if (card.workThreadId !== source.workThreadId) return card;
    if (card.workThreadId === null) return card;
    const revision = yield* locks.resourceVersion(card.boardId, `card:${card.id}`);
    const view = yield* threads.view(card.workThreadId);
    const current = snapshot?.before ?? (yield* cardOf(card.id));
    // A dispatch tolerates concurrent PR metadata writes, but their newer result wins this read.
    if ((yield* locks.resourceVersion(card.boardId, `card:${card.id}`)) !== revision)
      return current;
    if (!view || view.prs.length === 0) {
      if (canSave && !(yield* canSave())) return current;
      return yield* syncReviewedStage(current);
    }
    const at = yield* nowIso;
    const solo = (snapshot?.workCards ?? (yield* store.threadCards(card.workThreadId))).every(
      (id) => id === card.id,
    );
    let changed = false;
    let links = mergeLinks(
      card.links,
      view.prs
        .filter((pr) => solo && !card.links.some((link) => link.url === pr.url))
        .map((pr) => ({ url: pr.url, label: pr.title, kind: "pr" as const })),
    );
    if (links.length !== card.links.length) changed = true;
    links = links.map((link) => {
      const pr = view.prs.find((candidate) => candidate.url === link.url);
      if (!pr || (link.state === pr.state && link.kind === "pr")) return link;
      changed = true;
      return { ...link, kind: "pr" as const, state: pr.state, checkedAt: at };
    });
    if (canSave && !(yield* canSave())) return card;
    // Reconcile unchanged metadata too: older releases left already-merged cards in review.
    if (!changed) return yield* syncReviewedStage(card);
    const next = {
      ...card,
      links,
      // Callers may reuse this snapshot; keep the edit-base floor saveCard persists.
      updatedAt: Date.parse(at) < Date.parse(card.updatedAt) ? card.updatedAt : at,
    };
    yield* saveCard(
      next,
      undefined,
      links.length === card.links.length,
      undefined,
      undefined,
      snapshot,
    );
    return yield* syncReviewedStage(next);
  });

  const writeTitle = Effect.fn("KanbanService.writeTitle")(function* (
    cardId: KanbanCard["id"],
    fields: { readonly title: boolean; readonly description: boolean },
    // The card's title and description when the write was asked for; an edit after that wins.
    asked?: Pick<KanbanCard, "title" | "description">,
  ) {
    const generateJson = textGeneration.generateJson;
    if (!generateJson) return;
    const card = yield* cardOf(cardId);
    const board = yield* boardOf(card.boardId);
    const projectId = card.projectId ?? board.defaultProjectId;
    if (projectId === null) return;
    const project = yield* projects.getById(projectId);
    if (Option.isNone(project)) return;
    const written = yield* generateJson({
      cwd: project.value.workspaceRoot,
      operationLabel: "writeTitle",
      boardId: board.id,
      prompt: Briefs.writerPrompt(card),
      outputSchema: WriterOutput,
      modelSelection: board.managerModel,
      timeoutMs: Scribe.BOARD_TEXT_HANG_GUARD_MS,
    });
    yield* locks.run(
      Effect.gen(function* () {
        const current = yield* cardOf(cardId);
        const title = written.title.trim().slice(0, 80);
        const description = written.description.trim();
        const basis = asked ?? card;
        yield* saveCard({
          ...current,
          title:
            fields.title &&
            title &&
            current.title === card.title &&
            current.title === basis.title &&
            current.prompt === card.prompt
              ? title
              : current.title,
          description:
            fields.description &&
            description &&
            current.description === card.description &&
            current.description === basis.description &&
            current.prompt === card.prompt
              ? description
              : current.description,
          updatedAt: yield* nowIso,
        });
      }),
      cardId,
    );
  });

  // Runs the writer, then any write asked for while it ran, until none is left.
  const writerRuns = (
    cardId: KanbanCard["id"],
    fields: WriterFields,
    asked?: WriterAsk["asked"],
  ): Effect.Effect<void> =>
    writeTitle(cardId, fields, asked).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban title writer failed", { cardId, cause }),
      ),
      Effect.andThen(
        Ref.modify(titlesRunning, (all): [WriterAsk | null, WritersRunning] => {
          const next = all.get(cardId) ?? null;
          if (next !== null) return [next, new Map(all).set(cardId, null)];
          const rest = new Map(all);
          rest.delete(cardId);
          return [null, rest];
        }),
      ),
      Effect.flatMap((next) =>
        next === null ? Effect.void : writerRuns(cardId, next.fields, next.asked),
      ),
    );
  // At most one writer per card. A later ask (an edited prompt) waits for it, and the newest
  // ask's fields win: each reflects what the owner had written by then.
  // The claim and the fork are one step, so an interrupt cannot leave a claim with no writer;
  // the writer itself stays interruptible, so closing the scope still kills its CLI child.
  const forkWriter = (cardId: KanbanCard["id"], fields: WriterFields) =>
    cardOf(cardId).pipe(
      Effect.flatMap((card) => {
        const ask: WriterAsk = {
          fields,
          asked: { title: card.title, description: card.description },
        };
        return Effect.uninterruptibleMask((restore) =>
          Ref.modify(titlesRunning, (all): [boolean, WritersRunning] => [
            !all.has(cardId),
            new Map(all).set(cardId, all.has(cardId) ? ask : null),
          ]).pipe(
            Effect.flatMap((start) =>
              start
                ? restore(writerRuns(cardId, fields, ask.asked)).pipe(
                    Effect.onInterrupt(() =>
                      Ref.update(titlesRunning, (all) => {
                        const rest = new Map(all);
                        rest.delete(cardId);
                        return rest;
                      }),
                    ),
                    Effect.provideService(BoardLocks.writeWaitMs, BoardLocks.WRITE_WAIT_MS),
                    Effect.provideService(TickTimings.current, undefined),
                    SavedWrite.background,
                    Effect.forkIn(scope),
                  )
                : Effect.void,
            ),
          ),
        );
      }),
      Effect.catch((error) =>
        Effect.logWarning("kanban title writer failed", { cardId, cause: error }),
      ),
      Effect.asVoid,
    );

  // The scribe regroups a board's open cards with the board's cheap model. Groups are
  // view-only, but card_next offers same-group cards, so they batch similar work.
  const writeGroups = Effect.fn("KanbanService.writeGroups")(function* (boardId: KanbanBoardId) {
    const generateJson = textGeneration.generateJson;
    if (!generateJson) return;
    const board = yield* boardOf(boardId);
    if (board.defaultProjectId === null) return;
    const project = yield* projects.getById(board.defaultProjectId);
    if (Option.isNone(project)) return;
    const output = yield* generateJson({
      cwd: project.value.workspaceRoot,
      operationLabel: "writeGroups",
      boardId: boardId,
      prompt: Scribe.groupsPrompt(yield* store.cards(boardId), yield* store.groups(boardId)),
      outputSchema: Scribe.ScribeGroupsOutput,
      modelSelection: board.managerModel,
      timeoutMs: Scribe.BOARD_TEXT_HANG_GUARD_MS,
    });
    yield* locks.run(
      Effect.gen(function* () {
        // Cards may have changed during the call: map numbers against the current ones.
        const groups = Scribe.toGroups(
          output,
          yield* store.cards(boardId),
          yield* store.groups(boardId),
          () => "grp-" + uuid().slice(0, 8),
        );
        const at = yield* nowIso;
        const next = groups.map((group) => ({ ...group, updatedAt: at }));
        yield* store.putGroups(boardId, next);
        yield* publish(boardId, { _tag: "groups", groups: next });
        yield* Ref.update(scribed, (all) => {
          const attempt = all.get(boardId);
          return attempt === undefined
            ? all
            : new Map(all).set(boardId, { ...attempt, done: true });
        });
      }),
    );
  });
  // The tick adds the board to groupsRunning before forking; the run takes it out however it ends.
  const forkGroups = (boardId: KanbanBoardId) =>
    writeGroups(boardId).pipe(
      Effect.catchCause((cause) => Effect.logWarning("kanban scribe failed", { boardId, cause })),
      Effect.ensuring(
        Ref.update(groupsRunning, (all) => new Set([...all].filter((id) => id !== boardId))),
      ),
      Effect.provideService(BoardLocks.writeWaitMs, BoardLocks.WRITE_WAIT_MS),
      Effect.provideService(TickTimings.current, undefined),
      SavedWrite.background,
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  // The scribe also keeps each active goal's Now current and adds Story lines when its
  // cards finish. It never moves a card that already has a goal.
  const writeGoals = Effect.fn("KanbanService.writeGoals")(function* (boardId: KanbanBoardId) {
    const generateJson = textGeneration.generateJson;
    if (!generateJson) return;
    const board = yield* boardOf(boardId);
    if (board.defaultProjectId === null) return;
    const project = yield* projects.getById(board.defaultProjectId);
    if (Option.isNone(project)) return;
    // Cards that finish during the call wait for the next pass: the Story cutoff is the
    // time this snapshot was read, not the time the write lands.
    const snapshotMs = yield* nowMillis;
    const snapshotGoals = yield* store.goals(boardId);
    const output = yield* generateJson({
      cwd: project.value.workspaceRoot,
      operationLabel: "writeGoals",
      boardId: boardId,
      prompt: Scribe.goalsPrompt(yield* store.cards(boardId), snapshotGoals),
      outputSchema: Scribe.ScribeGoalsOutput,
      modelSelection: board.managerModel,
      timeoutMs: Scribe.BOARD_TEXT_HANG_GUARD_MS,
    });
    yield* locks.run(
      Effect.gen(function* () {
        const cards = yield* store.cards(boardId);
        const goals = yield* store.goals(boardId);
        const updates = Scribe.toGoalUpdates(output, cards, goals, snapshotMs);
        const at = yield* nowIso;
        const nowMs = yield* nowMillis;
        const scribe: KanbanActor = { _tag: "system", component: "scribe" };
        // A Now held back for a fresh hand-written one is retried after the cooldown.
        let held = false;
        for (const { cardId, goalId } of updates.assign) {
          const card = cards.find((entry) => entry.id === cardId);
          const goal = goals.find((entry) => entry.id === goalId);
          if (!card || !goal || card.goalId !== null) continue;
          const next: KanbanCard = { ...card, goalId, updatedAt: at };
          yield* saveCard(next);
          yield* logEvent(next, scribe, "edited", { body: `Scribe put it in goal "${goal.name}"` });
        }
        for (const update of updates.goals) {
          const goal = goals.find((entry) => entry.id === update.id);
          if (!goal) continue;
          // A Now written while the call ran is newer than the answer, however long it took.
          const was = snapshotGoals.find((entry) => entry.id === goal.id)?.now ?? null;
          const keepNow =
            update.now === "" ||
            was?.at !== goal.now?.at ||
            was?.text !== goal.now?.text ||
            (goal.now !== null && nowMs - Date.parse(goal.now.at) < SCRIBE_KEEPS_NOW_MS);
          if (keepNow && update.now !== "") held = true;
          if (keepNow && update.story === null) continue;
          const next: KanbanGoal = {
            ...goal,
            now: keepNow ? goal.now : { text: update.now, at },
            story:
              update.story === null
                ? goal.story
                : [
                    ...goal.story,
                    { at: DateTime.formatIso(DateTime.makeUnsafe(snapshotMs)), text: update.story },
                  ],
          };
          yield* store.putGoal(next);
          yield* publish(boardId, { _tag: "goal", goal: next });
        }
        yield* Ref.update(goalsScribed, (all) => {
          const attempt = all.get(boardId);
          return attempt === undefined
            ? all
            : new Map(all).set(boardId, { ...attempt, done: !held });
        });
      }),
    );
  });
  const forkGoals = (boardId: KanbanBoardId) =>
    writeGoals(boardId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban goal scribe failed", { boardId, cause }),
      ),
      Effect.ensuring(
        Ref.update(goalsRunning, (all) => new Set([...all].filter((id) => id !== boardId))),
      ),
      Effect.provideService(BoardLocks.writeWaitMs, BoardLocks.WRITE_WAIT_MS),
      Effect.provideService(TickTimings.current, undefined),
      SavedWrite.background,
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  const scribeActor: KanbanActor = { _tag: "system", component: "scribe" };
  // The board's "Goal ideas" discussion: the newest open one the scribe made.
  const ideasDiscussion = Effect.fn("KanbanService.ideasDiscussion")(function* (
    boardId: KanbanBoardId,
  ) {
    // A settled ideas channel is reused and reopened by the next proposal.
    return yield* store.latestSystemDiscussion(boardId, "scribe");
  });
  // Every message of the Goal ideas discussion, oldest first: a long run of replies must
  // not hide an earlier proposal from the duplicate check or the 24-hour gate.
  const ideaMessages = Effect.fn("KanbanService.ideaMessages")(function* (
    discussionId: KanbanDiscussionId,
  ) {
    return yield* store.allMessages(discussionId);
  });
  const writeProposals = Effect.fn("KanbanService.writeProposals")(function* (
    boardId: KanbanBoardId,
  ) {
    const generateJson = textGeneration.generateJson;
    if (!generateJson) return;
    const board = yield* boardOf(boardId);
    if (board.defaultProjectId === null) return;
    const project = yield* projects.getById(board.defaultProjectId);
    if (Option.isNone(project)) return;
    const ideas = yield* ideasDiscussion(boardId);
    const past = ideas === null ? [] : Scribe.pastProposals(yield* ideaMessages(ideas.id));
    const output = yield* generateJson({
      cwd: project.value.workspaceRoot,
      operationLabel: "writeProposals",
      boardId,
      prompt: Scribe.proposalsPrompt(
        yield* store.cards(boardId),
        yield* store.goals(boardId),
        past,
      ),
      outputSchema: Scribe.ScribeProposalsOutput,
      modelSelection: board.managerModel,
      timeoutMs: Scribe.BOARD_TEXT_HANG_GUARD_MS,
    });
    yield* locks.run(
      Effect.gen(function* () {
        // The model call ran without the lock: re-read the history and the due check now, so a
        // proposal that landed meanwhile is respected.
        const current = yield* ideasDiscussion(boardId);
        const currentMessages = current === null ? [] : yield* ideaMessages(current.id);
        const currentPast = Scribe.pastProposals(currentMessages);
        const cards = yield* store.cards(boardId);
        const goals = yield* store.goals(boardId);
        const last =
          currentMessages.filter((message) => message.author._tag === "system").at(-1) ?? null;
        if (!Scribe.proposalDue(cards, goals, last, yield* nowMillis)) return;
        const proposals = Scribe.toProposals(output, cards, goals, currentPast);
        if (proposals.length === 0) return;
        const discussion =
          current ?? (yield* newDiscussion(boardId, Scribe.GOAL_IDEAS_TITLE, null, scribeActor));
        yield* postUnlocked(discussion.id, scribeActor, Scribe.proposalBlocks(proposals), false);
      }),
    );
  });
  const forkProposals = (boardId: KanbanBoardId) =>
    writeProposals(boardId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban goal ideas failed", { boardId, cause }),
      ),
      Effect.ensuring(
        Ref.update(proposalsRunning, (all) => new Set([...all].filter((id) => id !== boardId))),
      ),
      Effect.provideService(BoardLocks.writeWaitMs, BoardLocks.WRITE_WAIT_MS),
      Effect.provideService(TickTimings.current, undefined),
      SavedWrite.background,
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  // Callers hold the lock.

  const withParticipant = (
    discussion: KanbanDiscussion,
    actor: KanbanActor,
    name: string,
    patch: Partial<Omit<KanbanParticipant, "actor">>,
  ): KanbanDiscussion => {
    const key = actorKey(actor);
    const index = discussion.participants.findIndex(
      (participant) => actorKey(participant.actor) === key,
    );
    const current: KanbanParticipant =
      index >= 0
        ? discussion.participants[index]!
        : { actor, name, lastReadSeq: 0, typingUntil: null, owes: null };
    // A new answer, ask or delivered reminder supersedes an earlier pause deferral.
    const updated = {
      ...current,
      ...(patch.owes !== undefined && patch.deferred === undefined && current.deferred
        ? { deferred: false }
        : {}),
      ...patch,
      ...(patch.owes === "asked" ? { askedSeq: patch.lastReadSeq ?? current.lastReadSeq } : {}),
    };
    const participants = [...discussion.participants];
    if (index >= 0) participants[index] = updated;
    else participants.push(updated);
    return { ...discussion, participants };
  };

  const deferParticipant = (
    discussion: KanbanDiscussion,
    participant: KanbanParticipant,
  ): KanbanDiscussion =>
    withParticipant(discussion, participant.actor, participant.name, {
      deferred: true,
      deferredKey:
        participant.deferred && participant.deferredKey
          ? participant.deferredKey
          : NodeCrypto.randomUUID(),
    });

  const adoptEvaluator = (
    discussion: KanbanDiscussion,
    evaluator: Extract<KanbanActor, { _tag: "evaluator" }>,
  ): KanbanDiscussion =>
    discussion.evaluatorThreadId !== null
      ? discussion
      : withParticipant(
          { ...discussion, evaluatorThreadId: evaluator.threadId },
          evaluator,
          "Evaluator",
          {},
        );

  const discussionForSave = (discussion: KanbanDiscussion): KanbanDiscussion =>
    discussion.settledAt !== null || discussion.archivedAt !== null
      ? {
          ...discussion,
          participants: discussion.participants.map((participant) =>
            participant.deferred
              ? { ...participant, deferred: false, owes: null, typingUntil: null }
              : participant,
          ),
        }
      : discussion;

  const saveDiscussion = Effect.fn("KanbanService.saveDiscussion")(function* (
    discussion: KanbanDiscussion,
  ) {
    const next = discussionForSave(discussion);
    yield* store.putDiscussion(next);
    yield* publish(next.boardId, { _tag: "discussion", discussion: next });
    return next;
  });

  const writeDiscussionTitle = Effect.fn("KanbanService.writeDiscussionTitle")(function* (
    discussionId: KanbanDiscussion["id"],
    message: string,
  ) {
    const discussion = yield* discussionOf(discussionId);
    const board = yield* boardOf(discussion.boardId);
    if (board.defaultProjectId === null) return;
    const project = yield* projects.getById(board.defaultProjectId);
    if (Option.isNone(project)) return;
    const written = yield* textGeneration.generateThreadTitle({
      cwd: project.value.workspaceRoot,
      message,
      boardId: board.id,
      modelSelection: board.managerModel,
    });
    const title = written.title.trim().slice(0, DISCUSSION_TITLE_MAX);
    if (!title) return;
    yield* locks.run(
      Effect.gen(function* () {
        const current = yield* discussionOf(discussionId);
        // The owner may have renamed it while the title was being written.
        if (current.titleEditedAt !== null) return;
        yield* saveDiscussion({ ...current, title });
      }),
    );
  });

  /**
   * An owner's channel he never renamed gets a written title from his first
   * message. Card discussions keep the card's title; agents name their own.
   */
  const wantsWrittenTitle = Effect.fn("KanbanService.wantsWrittenTitle")(function* (
    discussion: KanbanDiscussion,
  ) {
    if (
      discussion.cardId !== null ||
      discussion.titleEditedAt !== null ||
      discussion.createdBy._tag !== "owner"
    ) {
      return false;
    }
    if (discussion.lastSeq === 0) return true;
    if (discussion.lastSeq > TITLE_SCAN_MAX) return false;
    const earlier = yield* store.messages(discussion.id, { limit: TITLE_SCAN_MAX + 1 });
    // `discussion` is as it was before the post being routed, which is already stored.
    return !earlier.some(
      (message) => message.seq <= discussion.lastSeq && message.author._tag === "owner",
    );
  });

  // The client's first-line title stays when the writer fails.
  const forkDiscussionTitle = (discussionId: KanbanDiscussion["id"], message: string) =>
    writeDiscussionTitle(discussionId, message).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban discussion title writer failed", { discussionId, cause }),
      ),
      Effect.provideService(BoardLocks.writeWaitMs, BoardLocks.WRITE_WAIT_MS),
      Effect.provideService(TickTimings.current, undefined),
      SavedWrite.background,
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const makeDiscussion = (
    boardId: KanbanBoard["id"],
    title: string,
    cardId: KanbanCard["id"] | null,
    actor: KanbanActor,
    at: string,
  ): KanbanDiscussion => {
    const opened: KanbanDiscussion = {
      id: KanbanDiscussionId.make(`disc-${uuid()}`),
      boardId,
      cardId,
      title: title.trim() || "Discussion",
      evaluatorThreadId: null,
      participants: [
        {
          actor: { _tag: "owner" },
          name: OWNER_NAME,
          lastReadSeq: 0,
          typingUntil: null,
          owes: null,
        },
      ],
      lastSeq: 0,
      lastMessageAt: null,
      createdBy: actor,
      createdAt: at,
      archivedAt: null,
      titleEditedAt: null,
      settledAt: null,
      snoozedUntil: null,
      pinnedAt: null,
      reopenedAt: null,
    };
    // The evaluator that opens a discussion is the one the owner's replies go to.
    return actor._tag === "evaluator" ? adoptEvaluator(opened, actor) : opened;
  };

  const newDiscussion = Effect.fn("KanbanService.newDiscussion")(function* (
    boardId: KanbanBoard["id"],
    title: string,
    cardId: KanbanCard["id"] | null,
    actor: KanbanActor,
  ) {
    return yield* saveDiscussion(makeDiscussion(boardId, title, cardId, actor, yield* nowIso));
  });

  const cardDiscussionUnlocked = Effect.fn("KanbanService.cardDiscussionUnlocked")(function* (
    cardId: KanbanCard["id"],
  ) {
    const card = yield* cardOf(cardId);
    if (card.discussionId !== null) {
      const existing = yield* store.discussion(card.discussionId);
      if (existing) return existing;
    }
    const discussion = yield* newDiscussion(
      card.boardId,
      `#${card.number} ${card.title}`,
      card.id,
      {
        _tag: "system",
        component: "kanban",
      },
    );
    // Opening the discussion changes no assignment input.
    yield* saveCard({ ...card, discussionId: discussion.id }, undefined, true);
    return discussion;
  });

  const typingUntil = DateTime.now.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.add(now, { milliseconds: TYPING_MS }))),
  );

  /**
   * Delivers text to an agent on behalf of a discussion and marks it as owing a
   * reply. A `note` (the board telling an evaluator its step came) owes none.
   */
  const deliver = Effect.fn("KanbanService.deliver")(
    function* (
      discussion: KanbanDiscussion,
      actor: KanbanActor,
      name: string,
      threadId: ThreadId,
      text: string,
      note = false,
      key?: string,
      recoveredPost?: EvaluatorJob["extra"]["recoveryPost"],
    ) {
      const seq = recoveredPost?.seq ?? (yield* ownerPostSeq) ?? discussion.lastSeq;
      const sendKey = recoveredPost
        ? postRecoveryKey(
            recoveredPost.discussionId,
            recoveredPost.seq,
            key ?? `${threadId}:reused`,
          )
        : key;
      const observed = yield* postRoutingTarget;
      if (observed && observed.target !== "start") {
        observed.target = actor._tag === "thread" ? "live_thread" : "steer";
        observed.threadId = threadId;
      }
      yield* locks.outside(
        threads.send({
          threadId,
          text,
          ...(sendKey ? { key: sendKey } : {}),
        }),
        undefined,
        false,
        Effect.succeed(true),
      );
      const current = yield* discussionOf(discussion.id);
      const progressed = current.participants.some(
        (p) => actorKey(p.actor) === actorKey(actor) && p.lastReadSeq > seq,
      );
      const next = withParticipant(
        current,
        actor,
        name,
        note || progressed
          ? {}
          : {
              lastReadSeq: seq,
              typingUntil: yield* typingUntil,
              owes: recoveredPost ? "nudged" : "asked",
            },
      );
      yield* saveDiscussion(next);
      return next;
    },
    (effect, discussion) =>
      effect.pipe(EvaluatorAnalytics.forCard(discussion.boardId, discussion.cardId)),
  );

  const launchEvaluator = Effect.fn("KanbanService.startEvaluatorUnlocked")(function* (
    board: KanbanBoard,
    purpose: Briefs.EvaluatorPurpose,
    extra: EvaluatorJob["extra"] = {},
  ) {
    if (board.archivedAt !== null)
      return yield* failWith("denied", "Board is deleted", "board_deleted");
    if (board.defaultProjectId === null) {
      return yield* failWith("invalid", `board ${board.slug} has no default project`);
    }
    if (purpose.kind === "setup" && board.setup?.status === "running") {
      return yield* failWith("invalid", `board ${board.slug} is already in setup`);
    }
    const at = yield* nowIso;
    const launchKey = extra.key ?? uuid();
    // The setup evaluator talks in a Setup discussion, so the owner has somewhere to read and reply.
    // An existing discussion can be adopted as the Setup one (boards set up before this existed).
    let setupDiscussion: KanbanDiscussion | null = null;
    if (purpose.kind === "setup") {
      if (purpose.discussionId) {
        const existing = yield* discussionOf(KanbanDiscussionId.make(purpose.discussionId));
        if (existing.boardId !== board.id) {
          return yield* failWith("invalid", "the Setup discussion must be on this board");
        }
        setupDiscussion = existing;
      } else {
        setupDiscussion = yield* newDiscussion(board.id, "Setup", null, {
          _tag: "system",
          component: "setup",
        });
      }
    }
    const nightlyDiscussion =
      purpose.kind === "nightly" && purpose.discussionId
        ? yield* discussionOf(KanbanDiscussionId.make(purpose.discussionId))
        : null;
    const evaluatorModel =
      extra.model ??
      (purpose.kind === "nightly"
        ? (board.nightlyReview?.model ?? DEFAULT_NIGHTLY_REVIEW.model)
        : board.evaluatorModel);
    const brief = Briefs.evaluatorBrief(board, purpose);
    const title = Briefs.evaluatorTitle(purpose);
    const launchInput = (key: string) => ({
      key: `${board.id}:eval:${Briefs.purposeKey(purpose)}:${key}`,
      ...(extra.recoveryPost === undefined
        ? {}
        : {
            messageId: MessageId.make(
              `kanban:${postRecoveryKey(extra.recoveryPost.discussionId, extra.recoveryPost.seq, key)}`,
            ),
          }),
      onStarted: (threadId: ThreadId) =>
        recordEvaluator(`start:${threadId}`, {
          boardId: board.id,
          cardId: extra.analyticsCardId === undefined ? extra.cardId : extra.analyticsCardId,
          threadId,
          purposeKind: purpose.kind,
          trigger: extra.trigger ?? "legacy_queue",
          outcome: "started",
          reuseMissReason: extra.reuseMissReason ?? "legacy_queue",
        }),
      projectId: board.defaultProjectId!,
      title,
      model: evaluatorModel,
      text: extra.text ? `${brief}\n\n${extra.text}` : brief,
    });
    const inheritedReconcile = yield* launchReconcile;
    const launchDiscussion =
      setupDiscussion ??
      nightlyDiscussion ??
      (purpose.kind === "discussion" && inheritedReconcile === undefined
        ? yield* discussionOf(KanbanDiscussionId.make(purpose.discussionId))
        : null);
    // Concurrent queue admission does not change this launch's inputs. Recheck
    // those inputs instead of rejecting every intervening board generation.
    const reconcileInputs = Effect.fn("KanbanService.reconcileEvaluatorLaunch")(function* () {
      const current = (yield* rawStore.boards).find((candidate) => candidate.id === board.id);
      if (!NodeUtil.isDeepStrictEqual(current, board)) return false;
      if (launchDiscussion === null) return true;
      const discussion = yield* rawStore.discussion(launchDiscussion.id);
      // Discussion ownership is reconciled after launch against the latest owner.
      // Setup/nightly still write their captured channel and need its full snapshot.
      return purpose.kind === "discussion"
        ? discussion !== null &&
            discussion.boardId === launchDiscussion.boardId &&
            discussion.cardId === launchDiscussion.cardId &&
            discussion.title === launchDiscussion.title &&
            discussion.settledAt === launchDiscussion.settledAt &&
            discussion.snoozedUntil === launchDiscussion.snoozedUntil
        : NodeUtil.isDeepStrictEqual(discussion, launchDiscussion);
    });
    const launch = (key: string) =>
      reserveEvaluatorSpawn(board.id, extra.cardId ?? null, launchInput(key).key).pipe(
        Effect.andThen(threads.launch(launchInput(key))),
        Effect.provideService(
          launchReconcile,
          purpose.kind !== "request" && purpose.kind !== "setup"
            ? (inheritedReconcile ?? reconcileInputs)
            : reconcileInputs,
        ),
      );
    const routeKey =
      extra.key ?? ((yield* ownerRouteRow) === undefined ? undefined : yield* ownerDeliveryKey);
    let threadId: ThreadId | undefined;
    if (routeKey === undefined) {
      threadId = yield* launch(launchKey);
    } else {
      // A durable owner route launches under a stable key, so a replay after a
      // restart gets the evaluator it already started instead of a second one.
      // A launch the board abandoned has an ended link; the next attempt is fresh.
      for (let attempt = 0; threadId === undefined; attempt += 1) {
        if (attempt >= 8) {
          return yield* failWith("failed", "evaluator launch was abandoned 8 times");
        }
        const launched = yield* launch(`${routeKey}:${attempt}`);
        const link = yield* rawStore.threadLink(launched);
        if (link === null || link.endedAt === null) threadId = launched;
        // The ended link is written before its interrupt; a restart between the two
        // leaves the abandoned evaluator running. It must be seen stopped before the
        // next one starts with the same instruction; otherwise the route retries.
        else {
          yield* threads.interrupt(
            launched,
            "Board state changed during launch",
            true,
            undefined,
            undefined,
            "superseded",
          );
          const run = yield* threads.latestRun(launched).pipe(Effect.mapError(toKanbanError));
          if (run !== null && !FINISHED_RUN_STATUSES.has(run.status)) {
            return yield* failWith("failed", `abandoned evaluator ${launched} is still running`);
          }
        }
      }
    }
    if (threadId === undefined) return yield* failWith("failed", "evaluator launch gave no thread");
    if (purpose.kind === "discussion") {
      const discussionId = KanbanDiscussionId.make(purpose.discussionId);
      const current = yield* reconcileDiscussionOwner(discussionId, threadId);
      if (current.evaluatorThreadId !== null && current.evaluatorThreadId !== threadId) {
        yield* locks.outside(
          abandonLaunch(launchInput(launchKey), threadId),
          undefined,
          false,
          Effect.succeed(true),
        );
        yield* locks.attached(threadId);
        const saved = yield* reconcileDiscussionOwner(discussionId, threadId);
        if (saved.evaluatorThreadId === null || saved.evaluatorThreadId === threadId) {
          return yield* failWith("conflict", "Discussion evaluator changed during launch cleanup");
        }
        return threadId;
      }
    }
    yield* linkThread(
      {
        threadId,
        boardId: board.id,
        cardId: extra.cardId ?? null,
        role: "evaluator",
        purpose: Briefs.purposeKey(purpose),
        discussionId:
          purpose.kind === "discussion"
            ? KanbanDiscussionId.make(purpose.discussionId)
            : (setupDiscussion?.id ?? nightlyDiscussion?.id ?? null),
        model: evaluatorModel,
        startedAt: at,
        endedAt: null,
        paused: null,
      },
      title,
      extra.key,
    );
    if (nightlyDiscussion) {
      yield* saveDiscussion(
        withParticipant(
          { ...nightlyDiscussion, evaluatorThreadId: threadId },
          { _tag: "evaluator", threadId },
          "Evaluator",
          {},
        ),
      );
    }
    if (setupDiscussion) {
      // The setup evaluator owns the Setup discussion even when an older evaluator
      // already had it: owner replies and setup_done must reach this thread.
      yield* saveDiscussion(
        withParticipant(
          { ...setupDiscussion, evaluatorThreadId: threadId },
          { _tag: "evaluator", threadId },
          "Evaluator",
          {},
        ),
      );
      const running: KanbanBoard = {
        ...board,
        setup: {
          status: "running",
          discussionId: setupDiscussion.id,
          threadId,
          startedAt: at,
          finishedAt: null,
        },
      };
      yield* store.putBoard(running);
      yield* publish(board.id, { _tag: "board", board: running });
      yield* locks.attached(threadId);
    }
    return threadId;
  });

  const openRequestCards = Effect.fn("KanbanService.openRequestCards")(function* (
    boardId: KanbanBoardId,
  ) {
    const cards: KanbanCard[] = [];
    let after = 0;
    for (;;) {
      const page = yield* locks.access(
        boardId,
        store.cardPage(boardId, { after, limit: 200, open: true }),
      );
      cards.push(...page);
      if (page.length < 200) return cards;
      after = page.at(-1)!.number;
    }
  });

  const requestLinks = Effect.fn("KanbanService.requestLinks")(function* (
    boardId: KanbanBoardId,
    text: string,
  ) {
    const links = yield* Effect.forEach(requestThreadIds(text), (id) => store.threadLink(id));
    const associated: KanbanThreadLink[] = [];
    for (const link of links) {
      if (!link || link.boardId !== boardId) continue;
      associated.push(link);
      for (const cardId of yield* store.threadCards(link.threadId))
        if (cardId !== link.cardId) associated.push({ ...link, cardId });
    }
    return associated;
  });

  const isBoardEvaluator = Effect.fn("KanbanService.isBoardEvaluator")(function* (
    threadId: ThreadId,
    boardId: KanbanBoardId,
  ) {
    const link = yield* store.threadLink(threadId);
    return link?.role === "evaluator" && link.boardId === boardId;
  });

  const eligibleDiscussionEvaluator = Effect.fn("KanbanService.eligibleDiscussionEvaluator")(
    function* (threadId: ThreadId, boardId: KanbanBoardId) {
      if (!(yield* isBoardEvaluator(threadId, boardId))) return false;
      if ((yield* Ref.get(evaluatorFailures)).get(threadId)?.state === "gone") return false;
      const view = yield* threads.find(threadId);
      const now = yield* nowMillis;
      return (
        !!view &&
        !view.archived &&
        (view.state !== "idle" || now - Date.parse(view.quietSince) < EVALUATOR_LIMITS.reuseMs)
      );
    },
  );

  const reconcileDiscussionOwner = Effect.fn("KanbanService.reconcileDiscussionOwner")(function* (
    discussionId: KanbanDiscussionId,
    launched: ThreadId,
  ) {
    for (;;) {
      const discussion = yield* discussionOf(discussionId);
      const owner = discussion.evaluatorThreadId;
      if (owner === null || owner === launched) return discussion;
      const eligible = yield* eligibleDiscussionEvaluator(owner, discussion.boardId);
      // The thread read releases the permit; a newly saved owner gets its own check.
      const current = yield* discussionOf(discussionId);
      if (current.evaluatorThreadId !== owner) continue;
      return eligible ? current : yield* saveDiscussion({ ...current, evaluatorThreadId: null });
    }
  });

  const cardEvaluatorLinks = Effect.fn("KanbanService.cardEvaluatorLinks")(function* (
    card: KanbanCard,
  ) {
    const links = [...(yield* store.threadLinks({ cardId: card.id }))];
    if (card.createdBy._tag === "evaluator") {
      const creator = yield* store.threadLink(card.createdBy.threadId);
      if (
        creator?.boardId === card.boardId &&
        !links.some((link) => link.threadId === creator.threadId)
      )
        links.push(creator);
    }
    return links;
  });

  const reusableEvaluator = Effect.fn("KanbanService.reusableEvaluator")(function* (
    card: KanbanCard,
    observation?: EvaluatorAnalytics.ReuseObservation,
  ) {
    const ids = new Set<ThreadId>();
    if (card.discussionId) {
      const discussion = yield* store.discussion(card.discussionId);
      if (discussion?.evaluatorThreadId) ids.add(discussion.evaluatorThreadId);
    }
    const links = yield* cardEvaluatorLinks(card);
    for (const link of links.toReversed())
      if (link.role === "evaluator" && link.cardId === card.id) ids.add(link.threadId);
    for (const ask of card.asks.toReversed())
      if (ask.by._tag === "evaluator") ids.add(ask.by.threadId);
    if (card.createdBy._tag === "evaluator") ids.add(card.createdBy.threadId);
    const now = yield* nowMillis;
    const rejected = new Set<EvaluatorReuseMissReason>();
    for (const id of ids) {
      // Ordinary tool callers also have evaluator actor tags; only board links prove the role.
      if (!(yield* isBoardEvaluator(id, card.boardId))) continue;
      if ((yield* Ref.get(evaluatorFailures)).get(id)?.state === "gone") {
        rejected.add("failed");
        continue;
      }
      const view = yield* threads.find(id);
      if (!view || view.archived) {
        rejected.add(view ? "archived" : "missing");
        continue;
      }
      if (view.state !== "idle" || now - Date.parse(view.quietSince) < EVALUATOR_LIMITS.reuseMs)
        return id;
      const link = links.find((entry) => entry.threadId === id);
      if (link?.endedAt && now - Date.parse(link.endedAt) < EVALUATOR_LIMITS.reuseMs) return id;
      rejected.add("idle_expired");
    }
    if (observation)
      observation.reason =
        rejected.size === 0
          ? "no_candidates"
          : rejected.size === 1
            ? [...rejected][0]!
            : "all_candidates_rejected";
    return null;
  });

  const appendSighting = Effect.fn("KanbanService.appendSighting")(function* (
    card: KanbanCard,
    text: string,
    caller?: ThreadId,
  ) {
    yield* logEvent(card, { _tag: "system", component: "evaluator-admission" }, "comment", {
      body: `sighting from ${caller ?? "board"}: ${text.slice(0, 400)}`,
      ...(caller === undefined ? {} : { sourceThreadId: caller }),
    });
  });

  const reserveEvaluatorSpawn = Effect.fn("KanbanService.reserveEvaluatorSpawn")(function* (
    boardId: KanbanBoardId,
    cardId: KanbanCardId | null,
    key: string,
  ) {
    const existing =
      yield* tickSql`SELECT launch_key FROM ardud_kanban_evaluator_spawns WHERE launch_key = ${key}`;
    if (existing.length > 0) return;
    const now = yield* nowMillis;
    const boardSince = DateTime.formatIso(
      DateTime.makeUnsafe(now - EVALUATOR_LIMITS.boardWindowMs),
    );
    const cardSince = DateTime.formatIso(DateTime.makeUnsafe(now - EVALUATOR_LIMITS.cardSpawnMs));
    const recent = yield* tickSql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM ardud_kanban_evaluator_spawns WHERE board_id = ${boardId} AND at > ${boardSince}`;
    const cardRecent = cardId
      ? yield* tickSql`SELECT launch_key FROM ardud_kanban_evaluator_spawns WHERE board_id = ${boardId} AND card_id = ${cardId} AND at > ${cardSince} LIMIT 1`
      : [];
    if (recent[0]!.count >= EVALUATOR_LIMITS.boardSpawns || cardRecent.length > 0)
      return yield* failWith(
        "conflict",
        "Evaluator queued (spawn cap); it will start when a board slot is free.",
      );
    const at = yield* nowIso;
    yield* locks.access(
      boardId,
      tickSql`INSERT INTO ardud_kanban_evaluator_spawns (launch_key, board_id, card_id, at) VALUES (${key}, ${boardId}, ${cardId}, ${at})`,
      true,
      "evaluator-queue",
    );
  });

  // Only intake duplicates use this. Answers, verdicts, wait endings, stalls,
  // first handoffs, nightly and setup always keep their own delivery paths.
  const requestIdentity = (text: string, forceNew = false) => {
    const body = text.trim().replace(/\s+/g, " ");
    return NodeCrypto.createHash("sha256")
      .update(forceNew ? encodeBugReportIdentity([body, "forceNew"]) : body)
      .digest("hex");
  };

  const duplicateRequest = Effect.fn("KanbanService.duplicateRequest")(function* (
    boardId: KanbanBoardId,
    text: string,
    reporterThreadId: ThreadId | undefined,
    key: string,
    trigger: EvaluatorTrigger,
    cardId?: KanbanCardId | null,
    forceNew = false,
  ) {
    const since = DateTime.formatIso(
      DateTime.makeUnsafe((yield* nowMillis) - EVALUATOR_LIMITS.requestDuplicateMs),
    );
    const body = requestIdentity(text, forceNew);
    // A long queue wait must leave the caller a full retry window after delivery.
    const duplicate =
      (yield* tickSql<EvaluatorQueueRow>`SELECT q.* FROM ardud_kanban_evaluator_requests r
      JOIN ardud_kanban_evaluator_queue q ON q.id = r.queue_id
      WHERE r.board_id = ${boardId} AND r.body = ${body}
      AND r.reporter_thread_id = ${reporterThreadId ?? ""}
      AND (q.done_at IS NULL OR q.done_at > ${since})
      AND (${cardId ?? null} IS NULL OR q.card_id = ${cardId ?? null})`)[0];
    if (duplicate) {
      yield* recordEvaluator(`duplicate:${key}`, {
        boardId: boardId,
        cardId: cardId ?? duplicate.card_id,
        purposeKind: "request",
        trigger: trigger,
        outcome: "merged",
        threadId: duplicate.thread_id,
        reuseMissReason: "duplicate",
      });
      return {
        cardId: duplicate.card_id,
        key: duplicate.job_key,
        queueId: duplicate.id,
        result: duplicate.thread_id
          ? { threadId: ThreadId.make(duplicate.thread_id) }
          : { queued: true as const, queueId: duplicate.id },
      };
    }
    return null;
  });

  const rememberRequest = Effect.fn("KanbanService.rememberRequest")(function* (
    boardId: KanbanBoardId,
    extra: Pick<EvaluatorJob["extra"], "requestBody" | "reporterThreadId" | "forceNew">,
    queueId: number,
    at: string,
  ) {
    if (extra.requestBody === undefined) return;
    const body = requestIdentity(extra.requestBody, extra.forceNew);
    yield* tickSql`INSERT INTO ardud_kanban_evaluator_requests (board_id, body, reporter_thread_id, queue_id, admitted_at)
      VALUES (${boardId}, ${body}, ${extra.reporterThreadId ?? ""}, ${queueId}, ${at})
      ON CONFLICT(board_id, body, reporter_thread_id) DO UPDATE SET queue_id = excluded.queue_id, admitted_at = excluded.admitted_at`;
  });

  const finishIntakeMerge = Effect.fn("KanbanService.finishIntakeMerge")(function* (
    boardId: KanbanBoardId,
    row: EvaluatorQueueRow,
    job: EvaluatorJob,
    threadId: ThreadId,
    parentId?: number,
  ) {
    const at = yield* nowIso;
    const completed = yield* locks.access(
      boardId,
      tickTransaction(
        Effect.gen(function* () {
          const changed = yield* tickSql<{ id: number }>`UPDATE ardud_kanban_evaluator_queue
        SET thread_id = ${threadId}, done_at = ${at} WHERE id = ${row.id} AND done_at IS NULL RETURNING id`;
          if (changed.length === 0) return false;
          const parent =
            parentId ??
            (yield* tickSql<{ id: number }>`SELECT id FROM ardud_kanban_evaluator_queue
        WHERE board_id = ${boardId} AND thread_id = ${threadId} AND started_at IS NOT NULL
        AND json_extract(json, '$.purpose.kind') = 'request' ORDER BY id LIMIT 1`)[0]?.id;
          if (parent !== undefined)
            yield* tickSql`UPDATE ardud_kanban_evaluator_queue SET json = json_set(json,
          '$.extra.intakeMerges', COALESCE(json_extract(json, '$.extra.intakeMerges'), 0) + 1) WHERE id = ${parent}`;
          return true;
        }),
      ),
      true,
      "evaluator-queue",
    );
    // Completion owns this observation. Recovery never emits it again for a done job.
    if (completed)
      yield* recordEvaluator(`intake:${row.job_key}`, {
        boardId,
        purposeKind: "request",
        trigger: job.extra.trigger ?? "evaluator_start",
        outcome: "merged",
        threadId,
      });
  });

  const finishRetainedDelivery = Effect.fn("KanbanService.finishRetainedDelivery")(function* (
    boardId: KanbanBoardId,
    row: EvaluatorQueueRow,
    job: EvaluatorJob,
    threadId: ThreadId,
  ) {
    // Acceptance can survive a crash before deliver saves the reader. Complete
    // that receipt before releasing admission ownership to the waiting-post sweep.
    if (job.purpose.kind === "discussion" && !job.extra.note) {
      const discussion = yield* discussionOf(KanbanDiscussionId.make(job.purpose.discussionId));
      const seq = job.extra.recoveryPost?.seq ?? job.extra.seq ?? discussion.lastSeq;
      const reader = discussion.participants.find(
        (p) => p.actor._tag === "evaluator" && p.actor.threadId === threadId,
      );
      if (!reader || reader.lastReadSeq < seq)
        yield* saveDiscussion(
          withParticipant(discussion, { _tag: "evaluator", threadId }, "Evaluator", {
            lastReadSeq: seq,
            typingUntil: yield* typingUntil,
            owes: job.extra.recoveryPost ? "nudged" : "asked",
          }),
        );
    }
    const at = yield* nowIso;
    const changed = yield* locks.access(
      boardId,
      tickSql<{
        id: number;
      }>`UPDATE ardud_kanban_evaluator_queue SET thread_id = ${threadId}, done_at = ${at}
        WHERE id = ${row.id} AND done_at IS NULL RETURNING id`,
      true,
      "evaluator-queue",
    );
    if (changed.length > 0)
      yield* recordEvaluator(`retained:${row.job_key}`, {
        boardId,
        cardId: row.card_id,
        threadId,
        purposeKind: EvaluatorAnalytics.purposeKind(
          (yield* store.threadLink(threadId))?.purpose ?? null,
        ),
        trigger: job.extra.trigger ?? "legacy_queue",
        outcome: "reused",
      });
  });

  const admitEvaluator = Effect.fn("KanbanService.admitEvaluator")(function* (
    board: KanbanBoard,
    purpose: Briefs.EvaluatorPurpose,
    input: EvaluatorJob["extra"],
    sighting?: {
      readonly actor: KanbanActor;
      readonly body: string | null;
      readonly sourceThreadId?: ThreadId;
      readonly at?: string;
      readonly onCommitted?: (card: KanbanCard) => void;
    },
    requestAdmission?: {
      readonly at: string;
      readonly duplicateKey: string;
      readonly onDuplicate: (key: string) => void;
    },
  ) {
    const at = requestAdmission?.at ?? (yield* nowIso);
    const extra = {
      ...input,
      analyticsCardId:
        input.analyticsCardId !== undefined
          ? input.analyticsCardId
          : input.cardId !== undefined
            ? input.cardId
            : ((yield* EvaluatorAnalytics.attribution)?.cardId ?? null),
      trigger:
        input.trigger ??
        (yield* EvaluatorAnalytics.origin) ??
        EvaluatorAnalytics.triggerFor(purpose.kind),
      reuseMissReason:
        input.model !== undefined
          ? ("forced_new" as const)
          : (input.reuseMissReason ??
            (input.cardId ? ("not_attempted" as const) : ("no_card_reuse_scope" as const))),
      answer: input.answer ?? (yield* evaluatorAnswer),
    };
    let sightingCard: KanbanCard | undefined;
    const persistSighting = Effect.gen(function* () {
      if (sighting === undefined) return;
      if (!extra.cardId) return yield* failWith("invalid", "A sighting needs a card");
      const current = yield* cardOf(extra.cardId);
      sightingCard = current;
      if (sighting.body === null) return;
      sightingCard = { ...current, updatedAt: sighting.at ?? (yield* nowIso) };
      yield* logEvent(sightingCard, sighting.actor, "comment", {
        body: sighting.body,
        at: sightingCard.updatedAt,
        ...(sighting.sourceThreadId === undefined
          ? {}
          : { sourceThreadId: sighting.sourceThreadId }),
      });
      yield* store.putCard(sightingCard);
    });
    const acknowledgeSighting = Effect.gen(function* () {
      if (sightingCard === undefined) return;
      sighting?.onCommitted?.(sightingCard);
      yield* SavedWrite.record({ kind: "card", card: sightingCard });
    });
    const publishSighting = Effect.gen(function* () {
      if (sightingCard === undefined) return;
      yield* resolvedContext({
        boardId: board.id,
        id: sightingCard.id,
        number: sightingCard.number,
      });
      yield* publish(board.id, { _tag: "card", card: sightingCard });
    });
    if (board.defaultProjectId === null)
      return yield* failWith("invalid", `board ${board.slug} has no default project`);
    if (purpose.kind === "setup" && board.setup?.status === "running")
      return yield* failWith("invalid", `board ${board.slug} is already in setup`);
    if ((purpose.kind === "setup" || purpose.kind === "discussion") && purpose.discussionId) {
      const discussion = yield* discussionOf(KanbanDiscussionId.make(purpose.discussionId));
      if (discussion.boardId !== board.id)
        return yield* failWith("invalid", "the evaluator discussion must be on this board");
    }
    const key = extra.key ?? (yield* ownerDeliveryKey) ?? uuid();
    // Only request intake is deduped; answers, verdicts, waits, stalls, first handoffs,
    // nightly and setup runs must always reach their own delivery paths.
    if (
      (purpose.kind === "request" || extra.requestBody !== undefined) &&
      (!extra.forceNew || extra.reporterThreadId !== undefined)
    ) {
      const duplicate = yield* duplicateRequest(
        board.id,
        extra.requestBody ?? (purpose.kind === "request" ? purpose.text : ""),
        extra.reporterThreadId,
        requestAdmission?.duplicateKey ?? key,
        extra.trigger,
        extra.cardId,
        extra.forceNew,
      );
      if (duplicate) {
        if (requestAdmission !== undefined) {
          requestAdmission.onDuplicate(duplicate.key);
          yield* SavedWrite.locateReport({
            kind: "evaluator",
            boardId: board.id,
            keyPrefix: duplicate.key,
          });
        }
        yield* SavedWrite.record(
          "threadId" in duplicate.result
            ? { kind: "evaluator", key: duplicate.key, threadId: duplicate.result.threadId }
            : { kind: "evaluatorQueue", key: duplicate.key, queueId: duplicate.queueId },
        );
        if (sighting !== undefined && duplicate.cardId !== null) {
          sightingCard = yield* cardOf(KanbanCardId.make(duplicate.cardId));
          yield* acknowledgeSighting;
          yield* publishSighting;
        }
        return "threadId" in duplicate.result || (yield* enqueueEvaluatorOnly)
          ? duplicate.result
          : yield* drainEvaluatorQueue(board.id, duplicate.key);
      }
      extra.requestBody = (extra.requestBody ?? (purpose.kind === "request" ? purpose.text : ""))
        .trim()
        .replace(/\s+/g, " ");
    }
    // A stall wake has its own eligibility and delivery key; never merge it into an owner job.
    // Recovery bodies have independent cancellation identities. Keep them in separate
    // jobs; the queue still shares the discussion's evaluator when those jobs drain.
    if (
      purpose.kind === "discussion" &&
      extra.model === undefined &&
      extra.answer === undefined &&
      extra.recoveryPost === undefined &&
      !key.startsWith(STALL_WAKE_PREFIX)
    ) {
      const pending =
        (yield* tickSql<EvaluatorQueueRow>`SELECT * FROM ardud_kanban_evaluator_queue WHERE board_id = ${board.id}
          AND json_extract(json, '$.purpose.kind') = 'discussion'
          AND ((${extra.cardId ?? null} IS NOT NULL AND card_id = ${extra.cardId ?? null}) OR
            (json_extract(json, '$.purpose.kind') = 'discussion' AND json_extract(json, '$.purpose.discussionId') = ${purpose.discussionId}))
          AND job_key NOT LIKE 'kanban-stall:%'
          AND done_at IS NULL AND started_at IS NULL AND json_extract(json, '$.extra.answer') IS NULL
          AND json_extract(json, '$.extra.recoveryPost') IS NULL
          AND COALESCE(json_extract(json, '$.extra.retainedDeliveryStarted'), 0) = 0
          AND COALESCE(json_extract(json, '$.extra.delivering'), 0) = 0 ORDER BY id LIMIT 1`)[0];
      if (pending && pending.job_key !== key) {
        // @effect-diagnostics-next-line preferSchemaOverJson:off -- queue rows are written by this method.
        const job = JSON.parse(pending.json) as EvaluatorJob;
        if (job.mergedKeys?.includes(key)) return { queued: true as const, queueId: pending.id };
        // @effect-diagnostics-next-line preferSchemaOverJson:off -- retain every owner follow-up until launch.
        const merged = JSON.stringify({
          ...job,
          mergedKeys: [...(job.mergedKeys ?? []), key],
          extra: {
            ...job.extra,
            ...(job.extra.requestBody === undefined && extra.requestBody !== undefined
              ? { requestBody: extra.requestBody, reporterThreadId: extra.reporterThreadId }
              : {}),
            text: [job.extra.text, extra.text].filter(Boolean).join("\n\n"),
            seq: Math.max(job.extra.seq ?? 0, extra.seq ?? 0),
            note: job.extra.note === true && extra.note === true,
          },
        });
        const didMerge = yield* locks.access(
          board.id,
          tickTransaction(
            Effect.gen(function* () {
              const updated = yield* tickSql<{ id: number }>`UPDATE ardud_kanban_evaluator_queue
                SET json = ${merged} WHERE id = ${pending.id} AND json = ${pending.json}
                AND done_at IS NULL AND started_at IS NULL
                AND COALESCE(json_extract(json, '$.extra.delivering'), 0) = 0 RETURNING id`;
              if (updated.length === 0) return false;
              // Evidence and its delivery intent survive the same restart. Real
              // inputs (answers, verdicts, waits and handoffs) keep their own paths.
              yield* persistSighting;
              yield* rememberRequest(board.id, extra, pending.id, at);
              return true;
            }),
          ).pipe(
            Effect.tap((merged) =>
              merged
                ? SavedWrite.record({ kind: "evaluatorQueue", key, queueId: pending.id }).pipe(
                    Effect.andThen(acknowledgeSighting),
                    Effect.ensuring(
                      recordEvaluator(`merged:${key}`, {
                        boardId: board.id,
                        cardId:
                          extra.analyticsCardId === undefined
                            ? extra.cardId
                            : extra.analyticsCardId,
                        purposeKind: purpose.kind,
                        trigger: extra.trigger,
                        outcome: "merged",
                        threadId: pending.thread_id,
                      }),
                    ),
                  )
                : Effect.void,
            ),
          ),
          true,
          "evaluator-queue",
        );
        if (didMerge) {
          yield* publishSighting;
          if (extra.cardId)
            yield* appendSighting(
              yield* cardOf(extra.cardId),
              extra.text ?? "Discussion follow-up",
            );
          if (extra.requestBody !== undefined && !(yield* enqueueEvaluatorOnly)) {
            const reused = yield* drainEvaluatorQueue(board.id, pending.job_key, true);
            if ("threadId" in reused) return reused;
          }
          return { queued: true as const, queueId: pending.id };
        }
      }
    }
    let nightly: { readonly board: KanbanBoard; readonly discussion: KanbanDiscussion } | null =
      null;
    if (purpose.kind === "nightly" && !purpose.discussionId) {
      const review = board.nightlyReview ?? {
        ...DEFAULT_NIGHTLY_REVIEW,
        lastRunAt: null,
        lastRunDay: null,
        lastDiscussionId: null,
      };
      const { day } = nightlyLocalTime(Date.parse(at), review.timeZone);
      const discussion = makeDiscussion(
        board.id,
        `Nightly review, ${day}`,
        null,
        {
          _tag: "system",
          component: "nightly-review",
        },
        at,
      );
      purpose = { ...purpose, discussionId: discussion.id, day };
      const since = Date.parse(at) - 24 * 60 * 60 * 1000;
      const sources = (yield* store.discussions(board.id))
        .filter(
          (source) =>
            source.id !== discussion.id &&
            Date.parse(source.lastMessageAt ?? source.createdAt) >= since,
        )
        .map((source) => ({
          id: source.id,
          title: source.title,
          lastMessageAt: source.lastMessageAt,
        }));
      const sourceText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        sources,
      ).pipe(Effect.orDie);
      extra.text = [
        extra.text,
        `Discussions active in the last 24 hours (read with discussion_read):\n${sourceText}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const next = {
        ...board,
        nightlyReview: {
          ...review,
          lastRunAt: at,
          lastRunDay: day,
          lastDiscussionId: discussion.id,
        },
      };
      nightly = { board: next, discussion };
    }
    // @effect-diagnostics-next-line preferSchemaOverJson:off -- internal durable job, same shape as its caller.
    const json = JSON.stringify({ purpose, extra });
    const enqueue = tickSql<{ id: number; created_at: string }>`
      INSERT INTO ardud_kanban_evaluator_queue (job_key, board_id, card_id, json, created_at)
      VALUES (${key}, ${board.id}, ${extra.cardId ?? null}, ${json}, ${at})
      ON CONFLICT (job_key) DO UPDATE SET job_key = excluded.job_key
      RETURNING id, created_at
    `;
    if (nightly) {
      const saved = nightly;
      // The daily marker must never outlive a failed admission without its recoverable job.
      yield* locks.access(
        board.id,
        Effect.gen(function* () {
          const rows = yield* tickTransaction(
            Effect.gen(function* () {
              yield* rawStore.putDiscussion(saved.discussion);
              yield* rawStore.putBoard(saved.board);
              return yield* enqueue;
            }),
          );
          yield* SavedWrite.record({ kind: "evaluatorQueue", key, queueId: rows[0]!.id });
        }),
        true,
      );
      yield* publish(board.id, { _tag: "discussion", discussion: saved.discussion });
      yield* publish(board.id, { _tag: "board", board: saved.board });
    } else {
      yield* locks
        .access(
          board.id,
          Effect.uninterruptible(
            Effect.gen(function* () {
              const queueId = yield* tickTransaction(
                Effect.gen(function* () {
                  const row = (yield* enqueue)[0]!;
                  // Commit evidence, delivery intent and dedupe before acknowledging the report.
                  yield* persistSighting;
                  yield* rememberRequest(board.id, extra, row.id, row.created_at);
                  return row.id;
                }),
              );
              yield* SavedWrite.record({ kind: "evaluatorQueue", key, queueId });
              yield* acknowledgeSighting;
            }),
          ),
          true,
          "evaluator-queue",
        )
        .pipe(Effect.withSpan("KanbanService.evaluatorQueueWrite"));
    }
    yield* publishSighting;
    if (
      purpose.kind === "discussion" &&
      extra.requestBody !== undefined &&
      !(yield* enqueueEvaluatorOnly)
    ) {
      // A different card's spawn cap cannot hold a sighting for an existing
      // evaluator. This pass only delivers; launch order and caps stay intact.
      const reused = yield* drainEvaluatorQueue(board.id, key, true);
      if ("threadId" in reused) return reused;
    }
    if (yield* enqueueEvaluatorOnly) {
      const rows =
        yield* tickSql<EvaluatorQueueRow>`SELECT * FROM ardud_kanban_evaluator_queue WHERE job_key = ${key}`;
      return { queued: true as const, queueId: rows[0]!.id };
    }
    return yield* drainEvaluatorQueue(board.id, key);
  });

  const drainEvaluatorQueue = Effect.fn("KanbanService.drainEvaluatorQueue")(function* (
    boardId: KanbanBoardId,
    wanted?: string,
    reuseOnly = false,
  ): Effect.fn.Return<
    EvaluatorLaunch,
    KanbanError | KanbanStoreError | KanbanThreadError | SqlError.SqlError
  > {
    let rows = yield* (
      reuseOnly
        ? tickSql<EvaluatorQueueRow>`SELECT * FROM ardud_kanban_evaluator_queue WHERE board_id = ${boardId} AND job_key = ${wanted ?? ""} AND done_at IS NULL`
        : tickSql<EvaluatorQueueRow>`SELECT * FROM ardud_kanban_evaluator_queue WHERE board_id = ${boardId} AND done_at IS NULL ORDER BY id`
    ).pipe(NodeSqliteClient.readOnly);
    if (rows.length > 0 && (yield* boardOf(boardId)).archivedAt !== null)
      return { queued: true, queueId: rows[0]!.id };
    const depths = yield* tickQueueDepths;
    if (depths !== undefined && !reuseOnly) depths.evaluator = rows.length;
    if (!reuseOnly) {
      // Busy admissions can only enqueue. Recover their known-card deliveries
      // before any unrelated spawn cap, without changing launch order or caps.
      const sightings = rows.filter((row) => {
        const job = JSON.parse(row.json) as EvaluatorJob;
        return (
          row.started_at === null &&
          job.purpose.kind === "discussion" &&
          job.extra.requestBody !== undefined
        );
      });
      for (const sighting of sightings) yield* drainEvaluatorQueue(boardId, sighting.job_key, true);
      if (sightings.length > 0)
        rows = yield* tickSql<EvaluatorQueueRow>`SELECT * FROM ardud_kanban_evaluator_queue
          WHERE board_id = ${boardId} AND done_at IS NULL ORDER BY id`.pipe(
          NodeSqliteClient.readOnly,
        );
    }
    // The queue-drain span already covers cap observations, including repeats that emit nothing.
    const recordSpawnCap = Effect.fnUntraced(
      function* (row: EvaluatorQueueRow, job: EvaluatorJob) {
        if (job.extra.analyticsCapRecorded || Option.isNone(analytics)) return;
        yield* locks.access(
          boardId,
          tickSql`UPDATE ardud_kanban_evaluator_queue SET json = json_set(json, '$.extra.analyticsCapRecorded', json('true')) WHERE id = ${row.id}`,
          true,
          "evaluator-queue",
        );
        yield* recordEvaluator(`cap:${row.job_key}`, {
          boardId,
          cardId: job.extra.analyticsCardId === undefined ? row.card_id : job.extra.analyticsCardId,
          purposeKind: job.purpose.kind,
          trigger: job.extra.trigger ?? "legacy_queue",
          outcome: "queued_spawn_cap",
          threadId: row.thread_id,
        });
      },
      Effect.catchCause(() => Effect.void),
    );
    // The drain span covers cap handling, including reuse that needs no launch.
    const recordBlocked = Effect.fnUntraced(
      function* (head: EvaluatorQueueRow) {
        const headIndex = rows.findIndex((row) => row.id === head.id);
        // Caps limit starts, not delivery to an existing request evaluator. Answers,
        // verdicts, waits, stalls, first handoffs, nightly and setup never merge here.
        for (const row of rows.slice(headIndex + 1)) {
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- rows are written by admitEvaluator.
          const job = JSON.parse(row.json) as EvaluatorJob;
          if (
            row.card_id === null &&
            row.started_at === null &&
            job.purpose.kind === "request" &&
            !job.extra.forceNew
          )
            yield* drainEvaluatorQueue(boardId, row.job_key, true);
        }
        const pending = new Set(
          (yield* tickSql<{ id: number }>`SELECT id FROM ardud_kanban_evaluator_queue
          WHERE board_id = ${boardId} AND done_at IS NULL AND id >= ${head.id}`).map(
            (row) => row.id,
          ),
        );
        yield* Effect.forEach(
          rows.slice(headIndex).filter((row) => pending.has(row.id)),
          (row) => recordSpawnCap(row, JSON.parse(row.json) as EvaluatorJob),
          { discard: true },
        );
      },
      Effect.catchCause(() => Effect.void),
    );
    let result: EvaluatorLaunch | undefined;
    for (const queued of rows) {
      // Earlier launches release the board lock, allowing later jobs to merge.
      const row = (yield* locks.access(
        boardId,
        tickSql<EvaluatorQueueRow>`SELECT * FROM ardud_kanban_evaluator_queue WHERE id = ${queued.id} AND done_at IS NULL`,
        false,
        "evaluator-queue",
      ))[0];
      if (!row) continue;
      // A discussion may have acquired an owner while its launch was queued.
      // Deliver its retained text there before considering another spawn.
      // @effect-diagnostics-next-line preferSchemaOverJson:off -- only written by admitEvaluator.
      let job = JSON.parse(row.json) as EvaluatorJob;
      const route = Effect.gen(function* () {
        const observed = row.job_key !== wanted ? yield* postRoutingTarget : undefined;
        if (
          job.extra.recoveryPost &&
          !(yield* postRecoveryPending(
            store,
            job.extra.recoveryPost.discussionId,
            job.extra.recoveryPost.seq,
          ))
        ) {
          if (observed) observed.phase = "queue_stale";
          yield* locks.access(
            boardId,
            tickSql`UPDATE ardud_kanban_evaluator_queue SET done_at = ${yield* nowIso} WHERE id = ${row.id}`,
            true,
            "evaluator-queue",
          );
          return;
        }
        if (row.job_key.startsWith(STALL_WAKE_PREFIX)) {
          const card = row.card_id ? yield* store.card(KanbanCardId.make(row.card_id)) : null;
          const discussion =
            job.purpose.kind === "discussion"
              ? yield* store.discussion(KanbanDiscussionId.make(job.purpose.discussionId))
              : null;
          if (
            !card ||
            card.stalled?.by._tag !== "system" ||
            card.settledAt !== null ||
            stallWakeKey(card) !== row.job_key
          ) {
            yield* locks.access(
              boardId,
              tickSql`UPDATE ardud_kanban_evaluator_queue SET done_at = ${yield* nowIso} WHERE id = ${row.id}`,
              true,
              "evaluator-queue",
            );
            return;
          }
          if (!discussion || discussion.settledAt !== null || discussion.archivedAt !== null)
            return;
          const board = yield* boardOf(boardId);
          if (
            !systemStallDue(card, yield* nowMillis) ||
            (board.pause && !board.pause.keep.includes(card.id))
          )
            return;
        }
        if (job.extra.answer) {
          const expected = job.extra.answer;
          const message = yield* store.message(expected.discussionId, expected.seq);
          const current = message?.answers.find(
            (answer) => answer.blockId === expected.blockId && answer.by._tag === "owner",
          );
          if (
            !current ||
            current.at !== expected.at ||
            current.text !== expected.text ||
            !NodeUtil.isDeepStrictEqual(current.choice, expected.choice)
          ) {
            const at = yield* nowIso;
            yield* locks.access(
              boardId,
              tickSql`UPDATE ardud_kanban_evaluator_queue SET done_at = ${at} WHERE id = ${row.id}`,
              true,
              "evaluator-queue",
            );
            return;
          }
        }
        const currentBoard = yield* boardOf(boardId);
        if (
          job.purpose.kind === "nightly" &&
          job.purpose.scheduled &&
          (!currentBoard.nightlyReview?.enabled || currentBoard.archivedAt !== null)
        ) {
          const at = yield* nowIso;
          yield* locks.access(
            boardId,
            tickSql`UPDATE ardud_kanban_evaluator_queue SET done_at = ${at} WHERE id = ${row.id}`,
            true,
            "evaluator-queue",
          );
          return;
        }
        // Intake bursts retain every request. Real card events (answers, verdicts,
        // wait endings, stalls and first handoffs), nightly and setup never enter here.
        if (
          job.purpose.kind === "request" &&
          row.card_id === null &&
          row.started_at === null &&
          !job.extra.forceNew &&
          job.extra.model === undefined
        ) {
          // A durable accepted send owns its original recipient even after the
          // reuse window expires. Reconcile it before selecting or starting a thread.
          const recovered = yield* threads.acceptedSend!(row.job_key);
          if (recovered) {
            yield* finishIntakeMerge(boardId, row, job, recovered);
            if (row.job_key === wanted) result = { threadId: recovered };
            return;
          }
          const now = yield* nowMillis;
          const since = DateTime.formatIso(
            DateTime.makeUnsafe(now - EVALUATOR_LIMITS.requestReuseMs),
          );
          const candidates =
            yield* tickSql<EvaluatorQueueRow>`SELECT * FROM ardud_kanban_evaluator_queue
            WHERE board_id = ${boardId} AND card_id IS NULL AND started_at > ${since}
            AND thread_id IS NOT NULL AND json_extract(json, '$.purpose.kind') = 'request'
            AND COALESCE(json_extract(json, '$.extra.intakeMerges'), 0) < ${EVALUATOR_LIMITS.requestMerges}
            ORDER BY id DESC`;
          let merged = false;
          for (const candidate of candidates) {
            const threadId = ThreadId.make(candidate.thread_id!);
            let accepted: string | undefined;
            let attempted = false;
            const delivered = yield* Effect.gen(function* () {
              const view = yield* threads.find(threadId);
              if (
                (yield* Ref.get(evaluatorFailures)).get(threadId)?.state === "gone" ||
                !view ||
                view.archived ||
                (view.state === "idle" &&
                  now - Date.parse(view.quietSince) >= EVALUATOR_LIMITS.requestReuseMs)
              )
                return false;
              const requestText = [
                job.purpose.kind === "request" ? job.purpose.text : "",
                job.extra.text,
              ]
                .filter(Boolean)
                .join("\n\n");
              const reporter = job.extra.reporterThreadId;
              attempted = true;
              yield* threads
                .send({
                  threadId,
                  text:
                    reporter && !requestText.includes(`t3-thread://v1/${reporter}`)
                      ? `Reported by thread [${reporter}](t3-thread://v1/${reporter}).\n\n${requestText}`
                      : requestText,
                  key: row.job_key,
                  // Intake must survive the active turn ending after acceptance.
                  // Auto delivery steers live turns and retains a durable follow-up.
                })
                .pipe(
                  Effect.provideService(ownerDeliveryKey, undefined),
                  Effect.provideService(
                    EvaluatorAnalytics.origin,
                    job.extra.trigger ?? "evaluator_start",
                  ),
                  Effect.provideService(evaluatorDeliveryObserved, (identity) =>
                    Effect.sync(() => {
                      accepted = identity;
                    }),
                  ),
                  EvaluatorAnalytics.forCard(boardId, null),
                );
              return true;
            }).pipe(Effect.catch(() => Effect.succeed(accepted !== undefined)));
            const recipient = delivered ? threadId : yield* threads.acceptedSend!(row.job_key);
            if (!recipient) {
              if (attempted) break;
              continue;
            }
            yield* finishIntakeMerge(
              boardId,
              row,
              job,
              recipient,
              recipient === threadId ? candidate.id : undefined,
            );
            if (row.job_key === wanted) result = { threadId: recipient };
            merged = true;
            break;
          }
          if (merged) return;
          job = {
            ...job,
            extra: {
              ...job.extra,
              reuseMissReason: candidates.length > 0 ? "all_candidates_rejected" : "no_candidates",
            },
          };
        }
        // A started job may already have delivered its initial message. Recover
        // its stable launch before treating an attached evaluator as another owner.
        if (job.purpose.kind === "discussion" && row.started_at === null) {
          const retainedKey = job.extra.recoveryPost
            ? postRecoveryKey(
                job.extra.recoveryPost.discussionId,
                job.extra.recoveryPost.seq,
                `${row.job_key}:retained`,
              )
            : `${row.job_key}:retained`;
          const recovered = yield* threads.acceptedSend!(retainedKey);
          if (recovered) {
            if (observed) {
              observed.target = "steer";
              observed.threadId = recovered;
              observed.outcome = "reused";
            }
            yield* finishRetainedDelivery(boardId, row, job, recovered);
            if (row.job_key === wanted) result = { threadId: recovered };
            return;
          }
          let discussion = yield* discussionOf(KanbanDiscussionId.make(job.purpose.discussionId));
          // A replacement that names its own model (a safeguard refusal moving to
          // Sol) must start fresh rather than land on the refused thread.
          const reuse: EvaluatorAnalytics.ReuseObservation = {
            reason: job.extra.model !== undefined ? "forced_new" : "no_candidates",
          };
          const owner =
            job.extra.model !== undefined
              ? null
              : row.card_id
                ? yield* reusableEvaluator(yield* cardOf(KanbanCardId.make(row.card_id)), reuse)
                : discussion.evaluatorThreadId !== null &&
                    (yield* eligibleDiscussionEvaluator(
                      discussion.evaluatorThreadId,
                      discussion.boardId,
                    ))
                  ? discussion.evaluatorThreadId
                  : null;
          if (!owner && job.extra.reuseMissReason === "not_attempted")
            job = { ...job, extra: { ...job.extra, reuseMissReason: reuse.reason } };
          if (owner) {
            if (discussion.evaluatorThreadId !== owner)
              discussion = yield* saveDiscussion({ ...discussion, evaluatorThreadId: owner });
            // Freeze the retained body before provider I/O releases the board lock.
            // Later sightings get another row; none may join an in-flight send.
            const claimed = yield* locks.access(
              boardId,
              tickSql<{ json: string }>`UPDATE ardud_kanban_evaluator_queue
                SET json = json_set(json, '$.extra.delivering', json('true'),
                  '$.extra.retainedDeliveryStarted', json('true'))
                WHERE id = ${row.id} AND done_at IS NULL RETURNING json`,
              true,
              "evaluator-queue",
            );
            if (claimed.length === 0) return;
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- internal queue body frozen above.
            job = JSON.parse(claimed[0]!.json) as EvaluatorJob;
            let accepted: string | undefined;
            const delivered = yield* deliver(
              discussion,
              { _tag: "evaluator", threadId: owner },
              "Evaluator",
              owner,
              job.extra.text ?? "Discussion follow-up",
              job.extra.note,
              `${row.job_key}:retained`,
              job.extra.recoveryPost,
            ).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(accepted !== undefined)),
              Effect.provideService(evaluatorDeliveryObserved, (identity) =>
                Effect.sync(() => {
                  accepted = identity;
                }),
              ),
              Effect.provideService(ownerDeliveryKey, undefined),
              Effect.provideService(ownerPostSeq, job.extra.seq),
              Effect.provideService(EvaluatorAnalytics.origin, job.extra.trigger ?? "legacy_queue"),
            );
            const recipient = delivered ? owner : yield* threads.acceptedSend!(retainedKey);
            if (recipient) {
              if (observed) {
                observed.threadId = recipient;
                observed.outcome = "reused";
              }
              yield* finishRetainedDelivery(boardId, row, job, recipient);
              if (row.job_key === wanted) result = { threadId: recipient };
              return;
            }
            yield* Ref.update(evaluatorFailures, (all) =>
              new Map(all).set(owner, {
                state: "gone" as const,
                dueAt: 0,
                message: "Sighting delivery failed",
                runId: null,
              }),
            );
            yield* saveDiscussion({
              ...(yield* discussionOf(discussion.id)),
              evaluatorThreadId: null,
            });
          }
        }
        const existingSweep = ["stalled", "completed", "deployed", "check", "nightly"].includes(
          job.purpose.kind,
        )
          ? yield* runningSweep(boardId, job.purpose.kind)
          : job.purpose.kind === "setup" && currentBoard.setup?.status === "running"
            ? currentBoard.setup.threadId
            : null;
        if (existingSweep) {
          const text = [job.purpose.kind === "setup" ? job.purpose.text : undefined, job.extra.text]
            .filter(Boolean)
            .join("\n\n");
          if (text)
            yield* threads
              .send({ threadId: existingSweep, text, key: `${row.job_key}:sweep` })
              .pipe(
                Effect.provideService(ownerDeliveryKey, undefined),
                Effect.provideService(
                  EvaluatorAnalytics.origin,
                  job.extra.trigger ?? "legacy_queue",
                ),
                EvaluatorAnalytics.forCard(
                  boardId,
                  job.extra.analyticsCardId === undefined ? row.card_id : job.extra.analyticsCardId,
                ),
              );
          const at = yield* nowIso;
          yield* locks.access(
            boardId,
            tickSql`UPDATE ardud_kanban_evaluator_queue SET thread_id = ${existingSweep}, done_at = ${at} WHERE id = ${row.id}`,
            true,
            "evaluator-queue",
          );
          if (row.job_key === wanted) result = { threadId: existingSweep };
          return;
        }
        if (reuseOnly) return;
        const now = yield* nowMillis;
        const since = DateTime.formatIso(DateTime.makeUnsafe(now - EVALUATOR_LIMITS.boardWindowMs));
        const recent = yield* tickSql<{ count: number }>`
          SELECT COUNT(*) AS count FROM ardud_kanban_evaluator_queue
          WHERE board_id = ${boardId} AND started_at > ${since}
        `;
        if (row.started_at === null && recent[0]!.count >= EVALUATOR_LIMITS.boardSpawns) {
          if (observed) {
            observed.phase = "queue_waiting";
            observed.outcome = "queued_spawn_cap";
          }
          yield* recordBlocked(row);
          return "blocked" as const;
        }
        const board = yield* boardOf(boardId);
        const at = yield* nowIso;
        // Reserve before releasing the board lock for provider I/O. A failed or
        // interrupted launch keeps its stable key and reservation for replay.
        if (row.card_id && row.started_at === null) {
          const links = yield* cardEvaluatorLinks(yield* cardOf(KanbanCardId.make(row.card_id)));
          if (
            links.some(
              (link) =>
                link.role === "evaluator" &&
                now - Date.parse(link.startedAt) < EVALUATOR_LIMITS.cardSpawnMs,
            )
          ) {
            if (observed) {
              observed.phase = "queue_waiting";
              observed.outcome = "queued_spawn_cap";
            }
            yield* recordBlocked(row);
            return "blocked" as const;
          }
        }
        // Freeze the current body with its launch reservation: an earlier launch
        // may have released the lock while this row acquired more evidence.
        const claimed = yield* locks.access(
          boardId,
          tickSql<{ json: string }>`UPDATE ardud_kanban_evaluator_queue
            SET started_at = COALESCE(started_at, ${at}),
              json = json_set(json, '$.extra.delivering', json('true'),
                '$.extra.reuseMissReason', ${job.extra.reuseMissReason ?? "not_attempted"})
            WHERE id = ${row.id} AND done_at IS NULL RETURNING json`,
          true,
          "evaluator-queue",
        );
        if (claimed.length === 0) return;
        // @effect-diagnostics-next-line preferSchemaOverJson:off -- internal queue body frozen above.
        job = JSON.parse(claimed[0]!.json) as EvaluatorJob;
        if (observed) observed.target = "start";
        let threadId = yield* launchEvaluator(board, job.purpose, {
          ...job.extra,
          key: row.job_key,
        }).pipe(
          Effect.provideService(
            ownerRouteRow,
            row.job_key === wanted ? yield* ownerRouteRow : undefined,
          ),
          Effect.catchTags({
            KanbanError: (error) =>
              error.detail.startsWith("Evaluator queued (")
                ? Effect.succeed(null)
                : Effect.fail(error),
          }),
        );
        if (threadId === null) {
          if (observed) {
            observed.phase = "queue_waiting";
            observed.outcome = "queued_spawn_cap";
          }
          yield* recordBlocked(row);
          return "blocked" as const;
        }
        if (observed) {
          observed.threadId = threadId;
          observed.outcome = "started";
        }
        if (job.purpose.kind === "discussion") {
          const discussion = yield* reconcileDiscussionOwner(
            KanbanDiscussionId.make(job.purpose.discussionId),
            threadId,
          );
          const winner = discussion.evaluatorThreadId;
          if (winner !== null && winner !== threadId) {
            if (observed) {
              observed.target = "steer";
              observed.threadId = winner;
              observed.outcome = "reused";
            }
            yield* deliver(
              discussion,
              { _tag: "evaluator", threadId: winner },
              "Evaluator",
              winner,
              job.extra.text ?? "Discussion follow-up",
              job.extra.note,
              `${row.job_key}:retained`,
              job.extra.recoveryPost,
            ).pipe(
              Effect.provideService(ownerDeliveryKey, undefined),
              Effect.provideService(ownerPostSeq, job.extra.seq),
              Effect.provideService(EvaluatorAnalytics.origin, job.extra.trigger ?? "legacy_queue"),
            );
            threadId = winner;
          } else if ((yield* rawStore.threadLink(threadId))?.endedAt != null)
            return yield* failWith("conflict", "Queued discussion evaluator ended during launch");
        }
        const discussionId =
          job.purpose.kind === "discussion"
            ? KanbanDiscussionId.make(job.purpose.discussionId)
            : row.card_id && job.extra.seq !== undefined
              ? (yield* cardOf(KanbanCardId.make(row.card_id))).discussionId
              : null;
        if (discussionId && (row.job_key !== wanted || job.extra.requestBody !== undefined)) {
          const discussion = yield* discussionOf(discussionId);
          const seq = job.extra.seq ?? discussion.lastSeq;
          const progressed = discussion.participants.some(
            (p) =>
              p.actor._tag === "evaluator" && p.actor.threadId === threadId && p.lastReadSeq > seq,
          );
          yield* saveDiscussion(
            withParticipant(
              { ...discussion, evaluatorThreadId: threadId },
              { _tag: "evaluator", threadId },
              "Evaluator",
              progressed
                ? {}
                : job.extra.note
                  ? { lastReadSeq: seq }
                  : {
                      lastReadSeq: seq,
                      typingUntil: yield* typingUntil,
                      owes: job.extra.recoveryPost ? "nudged" : "asked",
                    },
            ),
          );
          const setupBoard = yield* boardOf(boardId);
          if (
            setupBoard.setup?.status === "running" &&
            setupBoard.setup.discussionId === discussionId &&
            setupBoard.setup.threadId !== threadId
          ) {
            const next = { ...setupBoard, setup: { ...setupBoard.setup, threadId } };
            yield* store.putBoard(next);
            yield* publish(boardId, { _tag: "board", board: next });
          }
          yield* locks.attached(threadId);
          yield* resumeDiscussionHandoffs(discussionId, threadId).pipe(
            Effect.provideService(EvaluatorAnalytics.origin, job.extra.trigger ?? "legacy_queue"),
          );
        }
        yield* locks.access(
          boardId,
          tickSql`UPDATE ardud_kanban_evaluator_queue SET thread_id = ${threadId}, done_at = ${at} WHERE id = ${row.id}`,
          true,
          "evaluator-queue",
        );
        if (row.job_key === wanted) result = { threadId };
      });
      const post = job.extra.routingPost;
      const decision = yield* post && row.job_key !== wanted
        ? observePostRouting(
            {
              id: post.discussionId,
              boardId,
              cardId: row.card_id ? KanbanCardId.make(row.card_id) : null,
            },
            { author: { _tag: post.authorKind }, seq: post.seq },
            route,
            "queue",
          )
        : route;
      if (decision === "blocked") break;
    }
    if (result) return result;
    const saved =
      wanted === undefined
        ? undefined
        : (yield* tickSql<EvaluatorQueueRow>`SELECT * FROM ardud_kanban_evaluator_queue WHERE job_key = ${wanted}`)[0];
    return saved?.thread_id
      ? { threadId: ThreadId.make(saved.thread_id) }
      : { queued: true, queueId: saved?.id ?? rows[0]?.id ?? 0 };
  });

  const startEvaluatorUnlocked = (
    board: KanbanBoard,
    purpose: Briefs.EvaluatorPurpose,
    extra: EvaluatorJob["extra"] & { readonly coalesce?: string } = {},
  ) =>
    evaluatorAdmission(
      board.id,
      Effect.gen(function* () {
        const current = yield* boardOf(board.id);
        if (current.archivedAt !== null)
          return yield* failWith("denied", "Board is deleted", "board_deleted");
        if (["stalled", "completed", "deployed", "check", "nightly"].includes(purpose.kind)) {
          const running = yield* runningSweep(board.id, purpose.kind);
          if (running)
            return yield* failWith(
              "conflict",
              `a ${purpose.kind} sweep is already running on this board (thread ${running})`,
            );
        }
        if (purpose.kind === "packets") {
          for (const link of (yield* store.threadLinks({
            boardId: board.id,
            open: true,
          })).toReversed()) {
            if (
              link.role !== "evaluator" ||
              link.purpose !== "packets" ||
              !(yield* liveEvaluator(link.threadId))
            )
              continue;
            if (extra.text)
              yield* threads.send({
                threadId: link.threadId,
                text: extra.text,
                ...(extra.coalesce === undefined ? {} : { coalesce: extra.coalesce }),
              });
            return link.threadId;
          }
        }
        if (extra.cardId && extra.model === undefined) {
          const now = yield* nowMillis;
          const latest = (yield* cardEvaluatorLinks(yield* cardOf(extra.cardId))).findLast(
            (link) =>
              link.role === "evaluator" &&
              now - Date.parse(link.startedAt) < EVALUATOR_LIMITS.cardSpawnMs,
          );
          if (latest) {
            yield* appendSighting(
              yield* cardOf(extra.cardId),
              extra.text ?? (purpose.kind === "request" ? purpose.text : "Evaluator follow-up"),
            );
            // Discussion text needs delivery even when the capped predecessor is gone.
            // Keep it queued until a replacement can be admitted.
            if (purpose.kind !== "discussion") return latest.threadId;
          }
        }
        if (purpose.kind === "setup") settingUp.add(board.id);
        return yield* admitEvaluator(current, purpose, extra).pipe(
          Effect.flatMap((result) =>
            "threadId" in result
              ? Effect.succeed(result.threadId)
              : failWith(
                  "conflict",
                  `Evaluator queued (${"queueId" in result ? result.queueId : 0}); it will start when a board slot is free.`,
                ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (purpose.kind === "setup") settingUp.delete(board.id);
            }),
          ),
        );
      }),
      // Packet/setup callers need the preceding launch's ownership before reuse.
      purpose.kind === "discussion",
    );

  /**
   * Ends a running setup. Only the owner or the setup thread itself may end it.
   * Card work resumes on the next dispatch tick (planDispatch reads setup status).
   */
  const endSetupUnlocked = Effect.fn("KanbanService.endSetupUnlocked")(function* (
    boardId: KanbanBoard["id"],
    actor: KanbanActor,
  ) {
    const board = yield* boardOf(boardId);
    const setup = board.setup;
    if (setup === null || setup.status !== "running") {
      return yield* failWith("invalid", `board ${board.slug} has no setup running`);
    }
    const isSetupThread = actor._tag === "evaluator" && actor.threadId === setup.threadId;
    if (actor._tag !== "owner" && !isSetupThread) {
      return yield* failWith(
        "denied",
        "only the owner or the setup evaluator ends setup",
        "role_not_allowed",
      );
    }
    const at = yield* nowIso;
    const done: KanbanBoard = {
      ...board,
      setup: { ...setup, status: "done", finishedAt: at },
    };
    yield* store.putBoard(done);
    yield* publish(board.id, { _tag: "board", board: done });
    const discussion = yield* discussionOf(setup.discussionId);
    const author: KanbanActor = isSetupThread ? actor : { _tag: "system", component: "setup" };
    yield* postUnlocked(
      discussion.id,
      author,
      [{ _tag: "md", text: "Setup is done. Card work and review resume." }],
      false,
    );
    yield* kick;
    return done;
  });

  const pauseBoardUnlocked = Effect.fn("KanbanService.pauseBoardUnlocked")(function* (
    boardId: KanbanBoard["id"],
    pause: { readonly reason: string; readonly keep: ReadonlyArray<KanbanCardId> } | null,
    actor: KanbanActor,
    callerAncestors: ReadonlyArray<string>,
  ) {
    if (actor._tag !== "owner" && actor._tag !== "evaluator") {
      return yield* failWith(
        "denied",
        "only the owner or an evaluator pauses a board",
        "role_not_allowed",
      );
    }
    for (const id of callerAncestors) {
      const link = yield* store.threadLink(id);
      if (link?.role === "work" || link?.role === "review") {
        return yield* failWith(
          "denied",
          "Only evaluators use this tool, not card threads or their children.",
          "role_not_allowed",
        );
      }
    }
    const board = yield* boardOf(boardId);
    let nextPause: KanbanBoard["pause"] = null;
    if (pause !== null) {
      const reason = pause.reason.trim();
      if (!reason) return yield* failWith("invalid", "a board pause needs a reason");
      const cards = yield* store.cards(board.id);
      const ids = new Set(cards.map((card) => card.id));
      for (const id of pause.keep) {
        if (!ids.has(id)) return yield* failWith("invalid", `card ${id} is not on this board`);
      }
      nextPause = {
        reason,
        keep: pause.keep,
        at: yield* nowIso,
        by: actor._tag === "owner" ? "owner" : `${actor._tag} ${actor.threadId}`,
      };
    }
    // Before changing the hold, recover turn ends that may have been missed.
    if (board.pause !== null) yield* reconcileHeldDiscussions(board);
    const next: KanbanBoard = { ...board, pause: nextPause };
    if (next.pause !== null) yield* reconcileHeldDiscussions(next);
    yield* store.putBoard(next);
    yield* publish(board.id, { _tag: "board", board: next });
    yield* wakeRecovered(next);
    const discussionWakes = yield* wakeDiscussionNudges(next);
    yield* wakeBoardNudges(next, discussionWakes);
    yield* kick;
    return next;
  });

  /**
   * The thread of an open, non-idle sweep of this kind, or null. An open link
   * whose thread went idle (e.g. after a restart) does not block a new sweep.
   */
  const runningSweep = Effect.fn("KanbanService.runningSweep")(function* (
    boardId: KanbanBoard["id"],
    kind: string,
  ) {
    const open = yield* store.threadLinks({ boardId, open: true });
    for (const link of open.toReversed()) {
      if (
        link.role !== "evaluator" ||
        link.purpose !== kind ||
        (kind !== "nightly" && link.discussionId !== null)
      )
        continue;
      const view = yield* threads.view(link.threadId);
      if (view && view.state !== "idle") return link.threadId;
    }
    return null;
  });

  /** Live evaluators that asked on a card; a new card evaluator takes it over from them. */
  const liveEvaluatorAskers = Effect.fn("KanbanService.liveEvaluatorAskers")(function* (
    card: KanbanCard,
  ) {
    const ids: ThreadId[] = [];
    for (const ask of card.asks) {
      if (ask.by._tag !== "evaluator" || ids.includes(ask.by.threadId)) continue;
      if (!(yield* isBoardEvaluator(ask.by.threadId, card.boardId))) continue;
      if (!(yield* liveEvaluator(ask.by.threadId))) continue;
      const view = yield* threads.find(ask.by.threadId);
      if (!view || view.state === "idle") continue;
      ids.push(ask.by.threadId);
    }
    return ids;
  });

  /**
   * An evaluator that exists, is not archived, and was not given up after failing.
   * Archived and given-up ones are gone for routing.
   */
  const liveEvaluator = Effect.fn("KanbanService.liveEvaluator")(function* (threadId: ThreadId) {
    if ((yield* Ref.get(evaluatorFailures)).get(threadId)?.state === "gone") return false;
    const view = yield* threads.view(threadId);
    return !!view && !view.archived;
  });

  // An attached evaluator's notices are resumed on route replay; durable send
  // keys distinguish notices already accepted before a service restart.
  const resumeDiscussionHandoffs = Effect.fn("KanbanService.resumeDiscussionHandoffs")(function* (
    discussionId: KanbanDiscussionId,
    threadId: ThreadId,
    reconcileSaved = true,
  ) {
    const discussion = yield* discussionOf(discussionId);
    if (discussion.evaluatorThreadId !== threadId || discussion.cardId === null) return;
    const card = yield* store.card(discussion.cardId);
    if (card === null) return;
    const handoffPriors = [
      ...new Set(
        card.asks.flatMap((ask) =>
          ask.by._tag === "evaluator" && ask.by.threadId !== threadId ? [ask.by.threadId] : [],
        ),
      ),
    ];
    for (const priorId of handoffPriors) {
      if (priorId === threadId) continue;
      if (!(yield* isBoardEvaluator(priorId, card.boardId))) continue;
      const key = `discussion-handoff:${discussionId}:${priorId}`;
      if (handedOff.has(key)) continue;
      if ((yield* Ref.get(evaluatorFailures)).get(priorId)?.state === "gone") continue;
      const prior = yield* locks.outside(
        threadIo.view(priorId),
        undefined,
        true,
        reconcileSaved ? Effect.succeed(true) : undefined,
      );
      if (
        !prior ||
        prior.archived ||
        (prior.state === "idle" &&
          (yield* nowMillis) - Date.parse(prior.quietSince) >= EVALUATOR_LIMITS.reuseMs)
      )
        continue;
      if ((yield* discussionOf(discussionId)).evaluatorThreadId !== threadId) break;
      // Save first: a response to this notice must reach the attached evaluator.
      // The durable send key prevents repeat notices after a service restart too.
      yield* locks
        .outside(
          threads
            .send({
              threadId: priorId,
              key,
              text: Briefs.cardHandoffText(card.number, discussionId, threadId),
            })
            // The key must survive route retries and evaluator replacements in
            // this discussion, independently of the post that triggered the launch.
            .pipe(
              Effect.provideService(ownerDeliveryKey, undefined),
              EvaluatorAnalytics.forCard(card.boardId, card.id),
            ),
          undefined,
          false,
          reconcileSaved ? Effect.succeed(true) : undefined,
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              handedOff.add(key);
            }),
          ),
          Effect.ignore,
        );
    }
  });

  /**
   * The discussion's evaluator gets the text: an existing one is steered,
   * otherwise one starts. A `note` owes no reply in the discussion.
   */
  const routeEvaluator = Effect.fn("KanbanService.toEvaluator")(
    function* (
      discussion: KanbanDiscussion,
      text: string,
      note = false,
      deliveryKey?: string,
      coalesce?: string,
      model?: ModelSelection,
    ) {
      if ((yield* boardOf(discussion.boardId)).archivedAt !== null) return discussion;
      const recovery = yield* recoveryPost;
      const actorOf = (threadId: ThreadId): KanbanActor => ({ _tag: "evaluator", threadId });
      const deliverSaved = Effect.fn("KanbanService.deliverDiscussionEvaluator")(function* (
        current: KanbanDiscussion,
        resumeHandoffs = true,
      ) {
        const threadId = current.evaluatorThreadId!;
        const observed = yield* postRoutingTarget;
        if (observed && observed.target !== "start") {
          observed.target = "steer";
          observed.threadId = threadId;
        }
        const seq = (yield* ownerPostSeq) ?? current.lastSeq;
        if (!note && recovery) {
          yield* deliver(
            current,
            actorOf(threadId),
            "Evaluator",
            threadId,
            text,
            false,
            undefined,
            recovery,
          );
          if (resumeHandoffs) yield* resumeDiscussionHandoffs(current.id, threadId, false);
          return yield* discussionOf(current.id);
        }
        yield* locks.outside(
          threads.send({
            threadId,
            text,
            ...(deliveryKey === undefined ? {} : { key: deliveryKey, keyAcrossThreads: true }),
            ...(coalesce === undefined ? {} : { coalesce }),
          }),
          undefined,
          false,
          deliveryKey === undefined
            ? Effect.map(
                rawStore.discussion(current.id),
                (saved) => saved?.evaluatorThreadId === threadId,
              )
            : undefined,
        );
        const saved = yield* discussionOf(current.id);
        const progressed = saved.participants.some(
          (p) => actorKey(p.actor) === actorKey(actorOf(threadId)) && p.lastReadSeq > seq,
        );
        // A reply posted while delivery was outside the permit already answered this text.
        yield* saveDiscussion(
          withParticipant(
            saved,
            actorOf(threadId),
            "Evaluator",
            note || progressed
              ? {}
              : {
                  lastReadSeq: seq,
                  typingUntil: yield* typingUntil,
                  owes: "asked",
                },
          ),
        );
        if (resumeHandoffs)
          yield* resumeDiscussionHandoffs(current.id, threadId, deliveryKey === undefined);
        return yield* discussionOf(current.id);
      });
      const originalOwner = discussion.evaluatorThreadId;
      if (originalOwner !== null) {
        const prior = yield* threads.find(originalOwner);
        if (prior?.archived) {
          yield* threads.interrupt(
            originalOwner,
            `Replaced as evaluator of "${discussion.title}"`,
            false,
            undefined,
            undefined,
            "superseded",
          );
          discussion = yield* discussionOf(discussion.id);
        }
      }
      const owningCard = discussion.cardId ? yield* store.card(discussion.cardId) : null;
      const reuse: EvaluatorAnalytics.ReuseObservation = {
        reason: owningCard ? "no_candidates" : "no_card_reuse_scope",
      };
      const ownerId =
        model !== undefined
          ? null
          : owningCard
            ? yield* reusableEvaluator(owningCard, reuse)
            : originalOwner;
      if (ownerId !== null) {
        const view = yield* locks.outside(
          threadIo.find(ownerId),
          undefined,
          true,
          deliveryKey === undefined
            ? Effect.map(
                rawStore.discussion(discussion.id),
                (saved) => saved?.evaluatorThreadId === originalOwner,
              )
            : undefined,
        );
        discussion = yield* discussionOf(discussion.id);
        const now = yield* nowMillis;
        if (
          view &&
          !view.archived &&
          (view.state !== "idle" ||
            now - Date.parse(view.quietSince) < EVALUATOR_LIMITS.reuseMs ||
            owningCard !== null)
        ) {
          if (discussion.evaluatorThreadId !== ownerId)
            discussion = yield* saveDiscussion({ ...discussion, evaluatorThreadId: ownerId });
          const ownerLink = yield* rawStore.threadLink(ownerId);
          return yield* deliverSaved(
            discussion,
            ownerLink?.purpose === `discussion:${discussion.id}`,
          );
        }
        reuse.reason = !view ? "missing" : view.archived ? "archived" : "idle_expired";
        if (view)
          yield* threads.interrupt(
            ownerId,
            `Replaced as evaluator of "${discussion.title}"`,
            false,
            undefined,
            undefined,
            "superseded",
          );
      }
      discussion = yield* discussionOf(discussion.id);
      if (discussion.evaluatorThreadId !== null) {
        if (
          discussion.evaluatorThreadId !== originalOwner &&
          (yield* eligibleDiscussionEvaluator(discussion.evaluatorThreadId, discussion.boardId))
        )
          return yield* deliverSaved(discussion, false);
        discussion = yield* saveDiscussion({ ...discussion, evaluatorThreadId: null });
      }
      const board = yield* boardOf(discussion.boardId);
      const card = discussion.cardId ? yield* store.card(discussion.cardId) : null;
      if (card && (yield* EvaluatorAnalytics.origin) === "step_reminder") {
        const step = Rules.inReviewEvaluatorStepsOnly(card)
          ? `review:${card.reviewRound}:${card.reviewStep}`
          : Subtasks.subtaskIds(kanbanStepSubtasks(card, "evaluator"));
        // A live evaluator may disappear during routing. This final check only
        // suppresses stale reminders; real events and first handoffs still launch.
        if (yield* staleStepReminder(card, step)) return discussion;
      }
      // One evaluator per card discussion: the evaluators that asked on the card
      // hear it is handed over, and stop typing there.
      const priors = card ? yield* liveEvaluatorAskers(card) : [];
      const priorText = priors.length > 0 ? Briefs.priorAskerText(priors) : undefined;
      const seq = recovery?.seq ?? (yield* ownerPostSeq) ?? discussion.lastSeq;
      // The launch serializer owns a fresh operation; reload this caller's snapshot
      // after it returns so posts made during the launch survive the attachment.
      const observed = yield* postRoutingTarget;
      if (observed) observed.target = "start";
      const threadId = yield* locks
        .outside(
          startEvaluatorUnlocked(
            board,
            {
              kind: "discussion",
              discussionId: discussion.id,
              title: discussion.title,
              cardNumber: card?.number ?? null,
            },
            {
              // Recovery carries the post in its guarded initial run, including
              // when admission delays launch. Other keyed questions send after admission.
              text:
                deliveryKey === undefined || recovery !== undefined
                  ? priorText
                    ? `${text}\n\n${priorText}`
                    : text
                  : priorText,
              ...(deliveryKey === undefined ? {} : { key: deliveryKey }),
              cardId: discussion.cardId,
              trigger: (yield* EvaluatorAnalytics.origin) ?? "discussion_post",
              reuseMissReason: reuse.reason,
              ...(model === undefined ? {} : { model }),
              note,
              seq,
              ...(recovery === undefined ? {} : { recoveryPost: recovery }),
              ...(observed === undefined ? {} : { routingPost: observed.post }),
            },
          ).pipe(
            Effect.provideService(launchReconcile, () =>
              Effect.gen(function* () {
                const current = yield* rawStore.discussion(discussion.id);
                // Only discussion ownership decides this launch; unrelated board
                // metadata must not abandon a thread that already has its brief.
                return current !== null;
              }).pipe(Effect.orDie),
            ),
          ),
          undefined,
          false,
          deliveryKey === undefined ? Effect.succeed(true) : undefined,
        )
        .pipe(
          Effect.catchTags({
            KanbanError: (error) =>
              deliveryKey === undefined && error.detail.startsWith("Evaluator queued (")
                ? Effect.sync(() => {
                    if (observed) observed.outcome = "queued_spawn_cap";
                    return null;
                  })
                : Effect.fail(error),
          }),
        );
      if (threadId === null) return yield* discussionOf(discussion.id);
      if (observed) observed.threadId = threadId;

      const current = yield* reconcileDiscussionOwner(discussion.id, threadId);
      if (current.evaluatorThreadId !== null && current.evaluatorThreadId !== threadId) {
        return yield* deliverSaved(current, false);
      }
      if ((yield* rawStore.threadLink(threadId))?.endedAt != null) {
        return yield* failWith("conflict", "Discussion evaluator changed after launch cleanup");
      }
      const latestCard = card ? yield* store.card(card.id) : null;
      const handoffPriors = [
        ...new Set(
          latestCard?.asks.flatMap((ask) =>
            ask.by._tag === "evaluator" && ask.by.threadId !== threadId ? [ask.by.threadId] : [],
          ) ?? [],
        ),
      ];
      const progressed = current.participants.some(
        (p) => actorKey(p.actor) === actorKey(actorOf(threadId)) && p.lastReadSeq > seq,
      );
      let next = withParticipant(
        { ...current, evaluatorThreadId: threadId },
        actorOf(threadId),
        "Evaluator",
        progressed
          ? {}
          : note
            ? { lastReadSeq: seq }
            : {
                lastReadSeq: seq,
                typingUntil: yield* typingUntil,
                owes: recovery ? "nudged" : "asked",
              },
      );
      for (const priorId of handoffPriors) {
        const prior = actorOf(priorId);
        if (next.participants.some((p) => actorKey(p.actor) === actorKey(prior))) {
          next = withParticipant(next, prior, "Evaluator", { typingUntil: null, owes: null });
        }
      }
      yield* saveDiscussion(next);
      yield* locks.attached(threadId);
      yield* resumeDiscussionHandoffs(discussion.id, threadId, deliveryKey === undefined);
      // A replaced setup evaluator hands the running setup to its successor, or setup_done is denied.
      const setupBoard = yield* boardOf(discussion.boardId);
      if (
        setupBoard.setup?.status === "running" &&
        setupBoard.setup.discussionId === discussion.id &&
        setupBoard.setup.threadId !== threadId
      ) {
        const running: KanbanBoard = {
          ...setupBoard,
          setup: { ...setupBoard.setup, threadId },
        };
        yield* store.putBoard(running);
        yield* publish(running.id, { _tag: "board", board: running });
      }
      return deliveryKey === undefined || recovery !== undefined
        ? yield* discussionOf(discussion.id)
        : yield* deliverSaved(yield* discussionOf(discussion.id));
    },
    (effect, discussion) =>
      effect.pipe(EvaluatorAnalytics.forCard(discussion.boardId, discussion.cardId)),
  );

  const toEvaluator = <E = never>(
    discussion: KanbanDiscussion,
    text: string,
    note = false,
    authorThreadId?: ThreadId,
    deliveryKey?: string,
    canRoute?: Effect.Effect<boolean, E>,
    coalesce?: string,
    model?: ModelSelection,
  ) =>
    serial(
      routing,
      discussion.id,
      Effect.gen(function* () {
        let current = yield* discussionOf(discussion.id);
        if (canRoute !== undefined && !(yield* canRoute)) {
          return yield* failWith("conflict", "Card thread question routing changed");
        }
        if (authorThreadId !== undefined && current.evaluatorThreadId === authorThreadId)
          return current;
        if (
          current.evaluatorThreadId !== null &&
          (yield* Ref.get(evaluatorFailures)).get(current.evaluatorThreadId)?.state === "gone"
        ) {
          current = yield* saveDiscussion({ ...current, evaluatorThreadId: null });
        }
        return yield* routeEvaluator(current, text, note, deliveryKey, coalesce, model);
      }),
    );

  /** A board note to the card's discussion evaluator; a failed note never breaks the caller. */
  const noteDiscussion = (card: KanbanCard, text: string, model?: ModelSelection) =>
    cardDiscussionUnlocked(card.id).pipe(
      Effect.flatMap((discussion) =>
        toEvaluator(discussion, text, true, undefined, undefined, undefined, undefined, model),
      ),
      Effect.asVoid,
    );

  /** The move that put a card in needs_owner: who asked, and where the card was. */
  const askedBy = Effect.fn("KanbanService.askedBy")(function* (card: KanbanCard) {
    const events = yield* store.cardEvents(card.id);
    return events.findLast((event) => event.kind === "moved" && event.toStage === "needs_owner");
  });

  const stepReminderSignature = Effect.fn("KanbanService.stepReminderSignature")(function* (
    cardId: KanbanCardId,
  ) {
    const card = yield* cardOf(cardId);
    const events = yield* tickSql<{
      id: number;
    }>`SELECT id FROM ardud_kanban_card_events WHERE card_id = ${cardId} ORDER BY id DESC LIMIT 1`;
    const links = yield* store.threadLinks({ cardId });
    // Poll timestamps and reminder clocks carry no new card input. The latest
    // immutable event still detects edits, including those to the same field value.
    const { updatedAt: _updatedAt, nudgedAt: _nudgedAt, ...state } = card;
    const references = card.links.map(({ checkedAt: _checkedAt, ...link }) => link);
    const snapshot = stableStringify({ card: { ...state, links: references }, events, links });
    return NodeCrypto.createHash("sha256").update(snapshot).digest("hex");
  });
  const rememberEvaluatorStep = Effect.fn("KanbanService.rememberEvaluatorStep")(function* (
    card: KanbanCard,
    key: string,
  ) {
    const signature = yield* stepReminderSignature(card.id);
    yield* tickSql`INSERT INTO ardud_kanban_evaluator_reminders (card_id, step_key, signature)
      VALUES (${card.id}, ${key}, ${signature}) ON CONFLICT(card_id) DO UPDATE SET step_key = excluded.step_key, signature = excluded.signature`;
  });
  const staleStepReminder = Effect.fn("KanbanService.staleStepReminder")(function* (
    card: KanbanCard,
    key: string,
  ) {
    const previous = (yield* tickSql<{
      step_key: string;
      signature: string;
    }>`SELECT step_key, signature FROM ardud_kanban_evaluator_reminders WHERE card_id = ${card.id}`)[0];
    if (
      !previous ||
      previous.step_key !== key ||
      previous.signature !== (yield* stepReminderSignature(card.id))
    )
      return false;
    const evaluator = yield* reusableEvaluator(card);
    const view = evaluator ? yield* threads.find(evaluator) : null;
    if (view && !view.archived && view.state !== "idle") return false;
    // Only unchanged periodic reminders may disappear. Answers, verdicts, waits,
    // stalls, first step handoffs, nightly and setup remain real events.
    yield* recordEvaluator(`stale-reminder:${uuid()}`, {
      boardId: card.boardId,
      cardId: card.id,
      purposeKind: "discussion",
      trigger: "step_reminder",
      outcome: "merged",
      threadId: evaluator,
      reuseMissReason: "stale_reminder",
    });
    return true;
  });

  const wakeReviewedEvaluator = Effect.fn("KanbanService.wakeReviewedEvaluator")(function* (
    cardId: KanbanCardId,
  ) {
    const discussion = yield* cardDiscussionUnlocked(cardId);
    // Transition notifications and periodic recovery share the delivery lock and persisted clock.
    yield* serial(
      routing,
      discussion.id,
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const board = yield* boardOf(card.boardId);
        const now = yield* nowMillis;
        if (
          board.archivedAt !== null ||
          !Rules.reviewEvaluatorWakeDue(card, Rules.chainFor(board, card)?.steps.length ?? 1, now)
        )
          return;
        const currentDiscussion = yield* discussionOf(discussion.id);
        if (currentDiscussion.archivedAt !== null || currentDiscussion.settledAt !== null) return;
        const reminderKey = `review:${card.reviewRound}:${card.reviewStep}`;
        if (
          (yield* EvaluatorAnalytics.origin) === "step_reminder" &&
          (yield* staleStepReminder(card, reminderKey))
        )
          return;
        const at = DateTime.formatIso(DateTime.makeUnsafe(now));
        const text = Briefs.evaluatorStepText(card);
        // If delivery succeeds but saving its clock fails, retry the same provider message key.
        const previous =
          card.nudgedAt === null ? `first:${card.movedAt}` : `after:${card.nudgedAt}`;
        const key = `review-step:${card.id}:${card.reviewRound}:${card.reviewStep}:${previous}`;
        // Saved follow-ons and ticks must share this key without the saved effect's prefix.
        yield* routeEvaluator(currentDiscussion, text, true, key, `step:${card.id}`).pipe(
          Effect.provideService(ownerDeliveryKey, undefined),
        );
        const latest = yield* cardOf(card.id);
        if (
          latest.stage !== "in_review" ||
          latest.activeThreadId !== null ||
          latest.reviewStep !== card.reviewStep ||
          latest.reviewRound !== card.reviewRound
        )
          return;
        yield* saveCard({
          ...latest,
          nudgedAt: at,
          updatedAt: at,
          wakeNote: latest.wakeNote === card.wakeNote ? text : latest.wakeNote,
        });
        yield* logEvent(latest, { _tag: "system", component: "dispatcher" }, "thread", {
          at,
          body: "Evaluator review-step wake",
        });
        yield* rememberEvaluatorStep(yield* cardOf(card.id), reminderKey);
      }),
    );
  });

  /**
   * A card whose step became the evaluator's (a new card waiting on its packet,
   * a review, an owner's move or a worker's last subtask) tells the card
   * discussion's evaluator, which
   * would otherwise never hear of it. A change by the card's own discussion evaluator needs no note. Another evaluator's (one carrying a review back from its own card) reaches the discussion's live evaluator, but never starts one.
   * The wake is keyed on the step's subtasks alone, so a card moving between
   * waiting stages (in_review to completed when its PRs land) isn't told twice.
   */
  // in_review with no thread: its review passed and it waits for its PRs.
  const stepTurn = (card: KanbanCard) =>
    !kanbanWaiting(card) &&
    !kanbanWorkStep(card) &&
    kanbanEvaluatorStep(card) &&
    card.activeThreadId === null &&
    card.settledAt === null &&
    (card.stage === "todo" ||
      card.stage === "in_review" ||
      (KANBAN_DONE_STAGES.has(card.stage) && card.stage !== "verified"))
      ? Subtasks.subtaskIds(kanbanStepSubtasks(card, "evaluator"))
      : null;
  /** The pure first check of `evaluatorTurn`: whether the change starts an evaluator step. */
  const evaluatorTurnDue = (before: KanbanCard | null, after: KanbanCard) => {
    const now = stepTurn(after);
    return now !== null && !(before !== null && now === stepTurn(before));
  };
  /** `evaluatorTurn` as a write's follow-on (see `later`); nothing is saved when no step is due. */
  const laterEvaluatorTurn = (before: KanbanCard | null, after: KanbanCard, actor: KanbanActor) =>
    evaluatorTurnDue(before, after)
      ? later(
          after.boardId,
          cardLane(after),
          { kind: "evaluatorTurn", before, after, actor },
          evaluatorTurn(before, after, actor),
        )
      : Effect.void;
  /** Fails when its note or launch fails; a saved follow-on retries on that. */
  const evaluatorTurnStrict = Effect.fn("KanbanService.evaluatorTurn")(
    function* (before: KanbanCard | null, after: KanbanCard, actor: KanbanActor) {
      if (actor._tag !== "evaluator" && Rules.inReviewEvaluatorStepsOnly(after)) {
        yield* wakeReviewedEvaluator(after.id);
        return;
      }
      const turn = stepTurn;
      const now = turn(after);
      if (now === null) return;
      if (before !== null && now === turn(before)) return;
      if ((yield* boardOf(after.boardId)).archivedAt !== null) return;
      if (actor._tag === "evaluator") {
        // An evaluator's change never starts an evaluator: one is already on the card.
        if (before === null || after.discussionId === null) return;
        // Part of a step its evaluator already heard about got done: nothing new.
        const told =
          turn(before) === null
            ? null
            : new Set(kanbanStepSubtasks(before, "evaluator").map((subtask) => subtask.id));
        if (
          told !== null &&
          kanbanStepSubtasks(after, "evaluator").every((subtask) => told.has(subtask.id))
        ) {
          return;
        }
        const discussion = yield* store.discussion(after.discussionId);
        const own = discussion?.evaluatorThreadId ?? null;
        if (discussion === null || own === null || own === actor.threadId) return;
        if (!(yield* liveEvaluator(own))) return;
        yield* toEvaluator(
          discussion,
          Briefs.evaluatorStepFromOtherText(after, actor.threadId),
          true,
          undefined,
          undefined,
          undefined,
          `step:${after.id}`,
        );
        return;
      }
      const text = Briefs.evaluatorStepText(after);
      if (before === null) {
        // New cards share one packets evaluator, so a script making twenty
        // cards starts one thread, not twenty.
        const open = yield* store.threadLinks({ boardId: after.boardId, open: true });
        for (const link of open.toReversed()) {
          if (link.role !== "evaluator" || link.purpose !== "packets") continue;
          if (!(yield* liveEvaluator(link.threadId))) continue;
          yield* threads.send({ threadId: link.threadId, text, coalesce: `step:${after.id}` });
          return;
        }
        yield* startEvaluatorUnlocked(
          yield* boardOf(after.boardId),
          { kind: "packets" },
          { text, coalesce: `step:${after.id}` },
        );
        return;
      }
      const discussion = yield* cardDiscussionUnlocked(after.id);
      yield* toEvaluator(
        discussion,
        text,
        true,
        undefined,
        undefined,
        undefined,
        `step:${after.id}`,
      );
      yield* rememberEvaluatorStep(yield* cardOf(after.id), now);
    },
    (effect, _before, after) =>
      Effect.flatMap(EvaluatorAnalytics.origin, (trigger) =>
        effect.pipe(
          Effect.provideService(EvaluatorAnalytics.origin, trigger ?? "step_transition"),
          EvaluatorAnalytics.forCard(after.boardId, after.id),
        ),
      ),
  );
  const evaluatorTurn = (before: KanbanCard | null, after: KanbanCard, actor: KanbanActor) =>
    evaluatorTurnStrict(before, after, actor).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban evaluator step note failed", { cardId: after.id, cause }),
      ),
    );

  /**
   * The owner answers asks on a card (`which` picks them): they close, and
   * each asker hears the answer once. A card waiting in Needs Owner with no
   * blocking ask left goes back where it was. Its worker gets the answer as
   * the wake note when it is back in todo and the question was the worker's,
   * or anyone's but an evaluator's (often an approval, which goes to the
   * evaluator instead). A `note` (a dropped ask) owes no reply. Returns the
   * threads told and the discussion as it is now.
   */
  const answerAsks = Effect.fn("KanbanService.answerAsks")(function* (
    discussion: KanbanDiscussion,
    card: KanbanCard,
    text: string,
    which: (ask: KanbanOwnerAsk) => boolean,
    /** Who answered when it isn't the owner (an evaluator dropping an ask): not told. */
    answeredBy: KanbanActor = { _tag: "owner" },
    note = false,
    /** A typed answer to store on the asks it closes, and how the card's move reads in its history. */
    record?: { readonly answer: KanbanAskAnswer; readonly moved: string },
  ) {
    const at = yield* nowIso;
    const open = kanbanOpenAsks(card);
    const answered = open.filter(which);
    let next = Asks.closeAsks(
      card,
      at,
      which,
      () => record?.answer ?? Asks.plainAnswer(answeredBy, at, note),
    );
    let current = discussion;
    const told = new Set<string>(
      answeredBy._tag === "thread" || answeredBy._tag === "evaluator" ? [answeredBy.threadId] : [],
    );
    let unblockEvaluator: string | null = null;
    const unblock =
      card.stage === "needs_owner" &&
      Asks.openBlockingAsk(next) === undefined &&
      (answered.some((ask) => ask.blocking) || !open.some((ask) => ask.blocking));
    if (unblock) {
      const board = yield* boardOf(card.boardId);
      const asked = yield* askedBy(card);
      const asker = Asks.openBlockingAsk(card)?.by ?? asked?.actor;
      const back = asked?.fromStage ?? "todo";
      // A card asked about mid-review reruns its step; one whose chain already
      // passed was only waiting (on its PRs or the evaluator) and goes back to
      // waiting, so the last reviewer isn't woken for a step it cleared.
      const reviewed =
        back === "in_review" &&
        Rules.reviewFinished(card, Rules.chainFor(board, card)?.steps.length ?? 1);
      const gated = next.subtasks.some(
        (subtask) =>
          Subtasks.gateOf(subtask, board.guessedGates) !== undefined &&
          (subtask.state === "open" ||
            Subtasks.approvalProblem(
              next,
              subtask,
              board.standingApprovals,
              board.guessedGates,
              subtask.state === "skipped" ? "skip" : "do",
            ) !== null),
      );
      const stage =
        back === "verified" && gated
          ? "completed"
          : back === "working"
            ? "todo"
            : back === "in_review" && !reviewed
              ? "needs_review"
              : back;
      const workThread = card.workThreadId;
      const wake =
        workThread !== null &&
        stage === "todo" &&
        (asker?._tag !== "evaluator" ||
          answered.some((ask) => ask.by._tag === "thread" && ask.by.threadId === workThread));
      next = {
        ...(yield* moveWait(next, stage, at, answeredBy)),
        stage,
        question: null,
        stalled: null,
        wakeNote: wake ? [next.wakeNote, text].filter(Boolean).join("\n\n") : next.wakeNote,
        movedAt: at,
        updatedAt: at,
      };
      yield* logEvent(next, answeredBy, "moved", {
        fromStage: card.stage,
        toStage: stage,
        body: record?.moved ?? (answeredBy._tag === "owner" ? "Owner replied" : "Question dropped"),
      });
      if (wake && workThread !== null) {
        current = withParticipant(
          current,
          { _tag: "thread", threadId: workThread },
          "Worker",
          note ? { lastReadSeq: current.lastSeq } : { lastReadSeq: current.lastSeq, owes: "asked" },
        );
        yield* saveDiscussion(current);
        told.add(workThread);
      }
      if (asker?._tag === "evaluator" && !told.has(asker.threadId))
        unblockEvaluator = asker.threadId;
    } else if (next !== card) {
      // Still waiting: the question shown is the blocking ask whose asker gets the answer.
      const blocking = next.stage === "needs_owner" ? Asks.openBlockingAsk(next) : undefined;
      next = { ...next, question: blocking?.text ?? next.question, updatedAt: at };
    }
    const via = yield* askAnswerVia;
    const answeredIds = new Set(answered.map((ask) => ask.id));
    if (answeredIds.size > 0)
      next = {
        ...next,
        asks: next.asks.map((ask) =>
          answeredIds.has(ask.id)
            ? {
                ...ask,
                timing: {
                  ...ask.timing,
                  answeredVia:
                    via ??
                    (record === undefined || record.answer.text !== undefined
                      ? "free_text"
                      : "single"),
                },
              }
            : ask,
        ),
      };
    if (answeredBy._tag === "owner" && answered.length > 0)
      next = yield* recheckReviewGate(next, yield* boardOf(next.boardId), true);
    // Saved before anyone is told: the card's new state never waits on a thread.
    if (next !== card) {
      analyticsActors.set(next, answeredBy);
      yield* saveCard(next);
    }
    if (answeredBy._tag === "owner")
      for (const ask of next.asks) {
        if (!answeredIds.has(ask.id) || ask.answer?.verdict === "dropped") continue;
        yield* recordAnalytics({
          kind: "ask.answered",
          boardId: next.boardId,
          cardId: next.id,
          durationMs: Math.max(0, Date.parse(ask.answer?.at ?? at) - Date.parse(ask.at)),
          props: askTimingProps(ask),
        });
      }
    const notice: AnsweredNotice = {
      singleEvaluator: yield* collapseEvaluatorReplies,
      discussionId: current.id,
      cardId: next.id,
      text,
      note,
      answeredBy,
      answered,
      told: [...told],
      unblockEvaluator,
    };
    const deferred = yield* effectSink;
    if (deferred !== undefined && !deferred.closed) {
      if (answered.length > 0 || unblockEvaluator !== null)
        deferred.effects.push({
          boardId: next.boardId,
          lane: current.id,
          effect: {
            kind: "tellAnswered",
            ...notice,
            evaluatorTrigger: answeredBy._tag === "owner" ? "owner_answer" : "card_ask",
          },
        });
    } else {
      const heard = yield* tellAnswered(notice, current, next);
      current = heard.discussion;
      for (const id of heard.told) told.add(id);
    }
    if (unblock) yield* kick;
    return { told, discussion: current, card: next };
  });

  /**
   * The telling half of `answerAsks`: the evaluator whose blocking ask held the
   * card first, then each asker where they are, a live one directly and anyone
   * else through the card discussion's evaluator.
   */
  const tellAnswered = Effect.fn("KanbanService.tellAnswered")(
    function* (notice: AnsweredNotice, discussion: KanbanDiscussion, card: KanbanCard) {
      if ((yield* boardOf(card.boardId)).archivedAt !== null)
        return { discussion, told: new Set<string>(notice.told) };
      const { text, note, answeredBy } = notice;
      let current = discussion;
      const told = new Set<string>(notice.told);
      const evaluatorAskers = new Set<ThreadId>();
      if (notice.singleEvaluator)
        for (const ask of notice.answered)
          if (
            ask.by._tag === "evaluator" &&
            (yield* isBoardEvaluator(ask.by.threadId, card.boardId))
          )
            evaluatorAskers.add(ask.by.threadId);
      const evaluatorOwner = notice.singleEvaluator ? yield* reusableEvaluator(card) : null;
      if (notice.singleEvaluator && !evaluatorOwner && evaluatorAskers.size > 0) {
        current = yield* toEvaluator(current, text, note);
        if (current.evaluatorThreadId) told.add(current.evaluatorThreadId);
      }
      const unblockTarget = notice.singleEvaluator ? evaluatorOwner : notice.unblockEvaluator;
      if (unblockTarget !== null && !told.has(unblockTarget)) {
        const threadId = ThreadId.make(unblockTarget);
        if (yield* liveEvaluator(threadId)) {
          current = yield* deliver(
            current,
            { _tag: "evaluator", threadId },
            "Evaluator",
            threadId,
            text,
            note,
          );
          told.add(threadId);
        } else {
          current = yield* toEvaluator(current, text, note);
          if (current.evaluatorThreadId !== null) told.add(current.evaluatorThreadId);
        }
      }
      for (const ask of notice.answered) {
        const collapse = ask.by._tag === "evaluator" && evaluatorAskers.has(ask.by.threadId);
        if (collapse && !evaluatorOwner) continue;
        const by =
          collapse && evaluatorOwner
            ? { _tag: "evaluator" as const, threadId: evaluatorOwner }
            : ask.by;
        // Whoever answers or drops their own question isn't told about it.
        if (actorKey(by) === actorKey(answeredBy)) continue;
        if (by._tag === "thread" || by._tag === "evaluator") {
          if (told.has(by.threadId)) continue;
          const role = by._tag === "evaluator" ? "Evaluator" : roleName(card.activeRole ?? "work");
          const live =
            by._tag === "thread"
              ? by.threadId === card.activeThreadId
              : yield* liveEvaluator(by.threadId);
          if (live) {
            current = yield* deliver(current, by, role, by.threadId, text, note);
            told.add(by.threadId);
            continue;
          }
        } else if (told.size > 0) {
          // The owner's own note: the card going back already carries the answer.
          continue;
        }
        if (current.evaluatorThreadId !== null && told.has(current.evaluatorThreadId)) continue;
        current = yield* toEvaluator(
          current,
          by._tag === "thread" ? Asks.passOnText(card, ask, text) : text,
          note,
        );
        if (current.evaluatorThreadId !== null) told.add(current.evaluatorThreadId);
      }
      return { told, discussion: current };
    },
    (effect, notice, _discussion, card) =>
      effect.pipe(
        EvaluatorAnalytics.forCard(card.boardId, card.id),
        Effect.provideService(
          EvaluatorAnalytics.origin,
          notice.answeredBy._tag === "owner" ? "owner_answer" : "card_ask",
        ),
      ),
  );

  /**
   * Owner (or script) text in a discussion reaches whoever owns it. On a
   * card, an owner reply answers its open asks (see `answerAsks`), and the
   * card's live thread hears it too. Otherwise it goes to the card's live
   * thread, else the discussion's evaluator. A pick passes `pick`: only those
   * asks are answered, and the live thread hears it only when nobody did. A
   * script post never sends a waiting card back to work.
   */
  const recordOwnerReply: (
    card: KanbanCard,
    ask: KanbanOwnerAsk,
    words: string,
    source?: {
      readonly at: string;
      readonly seq: number;
      readonly revision?: number | undefined;
      readonly input?: Asks.AskAnswerInput;
    },
  ) => ReturnType<KanbanServiceShape["answerAsk"]> = Effect.fn("KanbanService.recordOwnerReply")(
    function* (
      card: KanbanCard,
      ask: KanbanOwnerAsk,
      words: string,
      source?: {
        readonly at: string;
        readonly seq: number;
        readonly revision?: number | undefined;
        readonly input?: Asks.AskAnswerInput;
      },
    ) {
      if (source && ask.revisedAt && source.at < ask.revisedAt)
        return yield* failWith(
          "conflict",
          `${ask.id} changed after this reply was written; answer its current revision`,
        );
      const valid = Asks.answerFor(
        card,
        ask,
        {
          ...source?.input,
          verdict: "text",
          text: words,
          revision: source?.revision ?? (kanbanAskRevision(ask) === 0 ? 0 : undefined),
        },
        { _tag: "owner" },
        yield* nowIso,
      );
      if (Asks.isAskProblem(valid)) return yield* failAnswer(valid);
      const classification = classifyReply(ask, words);
      if ("candidates" in classification) {
        const discussion = yield* cardDiscussionUnlocked(card.id);
        if (
          source &&
          ask.confirmation !== undefined &&
          ask.confirmation.revision === kanbanAskRevision(ask) &&
          ask.confirmation.note === valid.note &&
          NodeUtil.isDeepStrictEqual(ask.confirmation.values, valid.values) &&
          ask.confirmation.finalDraft === valid.finalDraft
        ) {
          const shown = yield* store.message(discussion.id, ask.confirmation.seq);
          if (
            shown?.blocks.some(
              (block) =>
                block._tag === "choice" && block.question === `“${words}” — which did you mean?`,
            )
          )
            return { card, heard: false };
        }
        const confirmation = yield* postUnlocked(
          discussion.id,
          ask.by,
          [
            {
              _tag: "choice",
              id: ask.id,
              style: "pick",
              multi: false,
              question: `“${words}” — which did you mean?`,
              options: classification.candidates.map(({ id, label }) => ({ id, label })),
            },
          ],
          false,
          false,
          false,
          ask.id,
        );
        const fresh = yield* cardOf(card.id);
        const next = {
          ...Asks.clearClarify(
            Asks.updateAsk(fresh, ask.id, {
              confirmation: {
                seq: confirmation.seq,
                revision: kanbanAskRevision(ask),
                sourceSeq: source?.seq ?? confirmation.seq,
                text: words,
                ...(valid.note ? { note: valid.note } : {}),
                ...(valid.values ? { values: valid.values } : {}),
                ...(valid.finalDraft ? { finalDraft: valid.finalDraft } : {}),
              },
            }),
            ask.id,
          ),
          updatedAt: confirmation.createdAt,
        };
        yield* saveCard(next);
        return { card: next, heard: false };
      }
      // A reply may decide the question while leaving required structured fields unfilled.
      // Keep those words as text; only a complete checked answer can authorize a gate.
      const input = { ...source?.input, ...classification.answer };
      const checked = Asks.answerFor(card, ask, input, { _tag: "owner" }, yield* nowIso);
      const answer =
        Asks.isAskProblem(checked) && checked.code === "invalid"
          ? { ...input, verdict: "text" }
          : input;
      return yield* answerAskUnlocked(card.id, ask.id, answer, { _tag: "owner" }).pipe(
        Effect.provideService(ownerAnswerAt, source?.at),
      );
    },
    Effect.mapError(toKanbanError),
  );

  const routeToOwnerAgent = Effect.fn("KanbanService.routeToOwnerAgent")(function* (
    discussion: KanbanDiscussion,
    text: string,
    from: "owner" | "script" = "owner",
    pick?: (ask: KanbanOwnerAsk) => boolean,
    /** When the owner wrote it: asks raised later are not what he replied to. */
    asOf?: string,
    words?: string,
    sourceSeq?: number,
  ) {
    let current = discussion;
    if (current.cardId !== null) {
      let card = yield* cardOf(current.cardId);
      let told = new Set<string>();
      if (from === "owner" && kanbanNeedsOwner(card)) {
        const frozen = yield* ownerRouteAsks;
        const nowMs = yield* nowMillis;
        const eligible = kanbanOpenAsks(card).filter(
          (ask) =>
            (pick === undefined || pick(ask)) &&
            (frozen === undefined || frozen.has(ask.id)) &&
            (asOf === undefined || ask.at <= asOf) &&
            !kanbanAskExpired(ask, nowMs),
        );
        if (words !== undefined && eligible.length === 1 && !kanbanAskIsFreeText(eligible[0]!)) {
          yield* recordOwnerReply(card, eligible[0]!, words, {
            at: asOf ?? (yield* nowIso),
            seq: sourceSeq ?? 1,
            revision: kanbanAskRevision(eligible[0]!),
          }).pipe(Effect.provideService(collapseEvaluatorReplies, pick === undefined));
          return;
        }
        // Unscoped discussion text cannot choose between several independent asks.
        const result = yield* answerAsks(
          current,
          card,
          text,
          (ask) => eligible.some((entry) => entry.id === ask.id) && Asks.takesReply(ask, nowMs),
        ).pipe(Effect.provideService(collapseEvaluatorReplies, pick === undefined));
        ({ told, discussion: current } = result);
        card = yield* cardOf(card.id);
      }
      if (pick && told.size > 0) return;
      if (card.activeThreadId !== null && card.activeRole !== null) {
        const observed = yield* postRoutingTarget;
        if (observed) {
          observed.target = "live_thread";
          observed.threadId = card.activeThreadId;
        }
        if (!told.has(card.activeThreadId)) {
          yield* deliver(
            current,
            { _tag: "thread", threadId: card.activeThreadId },
            roleName(card.activeRole),
            card.activeThreadId,
            text,
          );
        }
        return;
      }
      if (told.size > 0) return;
    }
    // The serialized route reloads its inputs and may reconcile concurrent posts.
    // Resume its parent with that current snapshot; no earlier row is used below.
    yield* locks.outside(toEvaluator(current, text), undefined, false, Effect.succeed(true));
  });

  const postNeedsReader = Effect.fn("KanbanService.postNeedsReader")(function* (
    discussionId: KanbanDiscussionId,
    seq: number,
  ) {
    const discussion = yield* discussionOf(discussionId);
    if (
      discussion.cardId === null ||
      discussion.settledAt !== null ||
      discussion.archivedAt !== null
    )
      return false;
    const waiting = yield* store.ownerWait(discussionId, true);
    if (waiting === null || waiting.seq !== seq || waiting.answered) return false;
    const card = yield* cardOf(discussion.cardId);
    for (const participant of discussion.participants) {
      const actor = participant.actor;
      if (participant.lastReadSeq < seq) continue;
      if (actor._tag === "evaluator" && actor.threadId === discussion.evaluatorThreadId) {
        if (yield* liveEvaluator(actor.threadId)) return false;
      } else if (actor._tag === "thread" && actor.threadId === card.activeThreadId) {
        const view = yield* threads.find(actor.threadId);
        if (view && !view.archived) return false;
      }
    }
    // A committed route or admitted launch already owns delivery. Recheck under
    // the routing serializer too, so the sweep cannot race the normal path.
    const pending = yield* tickSql<{ id: number }>`
      SELECT id FROM ardud_kanban_owner_routes
      WHERE route_key = ${ownerPostKey({ discussionId, seq, createdAt: waiting.createdAt })}
        AND done_at IS NULL LIMIT 1
    `;
    if (pending.length > 0) return false;
    const admitting = yield* tickSql<{ id: number }>`
      SELECT id FROM ardud_kanban_evaluator_queue
      WHERE board_id = ${discussion.boardId} AND done_at IS NULL
        AND (card_id = ${discussion.cardId} OR
          json_extract(json, '$.purpose.discussionId') = ${discussion.id})
      LIMIT 1
    `;
    return admitting.length === 0;
  });

  const ownerDeliveries = new Map<string, Set<string>>();
  /** A durable route row a delivery attempt works for (see `deliverOwnerRoute`). */
  interface SavedOwnerRow {
    readonly id: number;
    readonly boardId?: KanbanBoardId;
    readonly cardId?: KanbanCardId | null;
    readonly launched: ReadonlyArray<string>;
    /** The askers that hear this answer, fixed by its first delivery attempt. */
    readonly askers: { readonly ids: ReadonlyArray<string>; readonly needsOwner: boolean } | null;
    /** Run first inside the locked attempt: null when the route still stands. */
    readonly check?: Effect.Effect<OwnerRouteClosed | null, KanbanError>;
    /** Set when `check` closed the route instead of routing it. */
    closed?: OwnerRouteClosed;
  }
  type OwnerRouteClosed = "not-saved" | "superseded";
  /**
   * Saving succeeds independently of delivery. Every retry starts with fresh board state.
   * A durable route row gets one attempt here: its discussion's drain retries it in
   * order and checks before each attempt that it still stands.
   */
  const routeSavedOwner = <E>(
    discussionId: KanbanDiscussion["id"],
    key: string,
    route: Effect.Effect<unknown, E>,
    row?: SavedOwnerRow,
    asks?: ReadonlySet<string>,
  ) => {
    let delivered = ownerDeliveries.get(key);
    if (!delivered) ownerDeliveries.set(key, (delivered = new Set()));
    // Evaluators this route already started carried the text in their first message.
    for (const id of row?.launched ?? []) delivered.add(id);
    // A saved route checks that it still stands inside the same board operation
    // that routes it, so an answer changed meanwhile is seen before anything is sent.
    const body =
      row?.check === undefined
        ? route
        : row.check.pipe(
            Effect.flatMap((closed) =>
              closed === null ? route : Effect.sync(() => (row.closed = closed)),
            ),
          );
    const attempt = locks
      .fresh(locks.run(body))
      .pipe(
        Effect.provideService(ownerDeliveryKey, key),
        Effect.provideService(ownerDelivered, delivered),
        Effect.provideService(ownerRouteRow, row?.id),
        Effect.provideService(ownerRouteAsks, row === undefined ? undefined : asks),
      );
    if (row !== undefined) return attempt.pipe(Effect.asVoid);
    const retry = (remaining: number): Effect.Effect<void> =>
      attempt.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("kanban saved owner message delivery pending", {
              discussionId,
              key,
              cause,
            });
            if (remaining > 0) {
              yield* Effect.yieldNow;
              return yield* retry(remaining - 1);
            }
            // Visible evidence survives a process restart even if the retry worker cannot.
            yield* ownerDeliveryNotice(
              discussionId,
              `Owner message delivery pending (${key}). Retrying in the background.`,
            ).pipe(Effect.ignore);
            yield* attempt.pipe(
              Effect.asVoid,
              Effect.catchCause((failure) =>
                Effect.logWarning("kanban owner delivery retry failed", { key, failure }).pipe(
                  Effect.andThen(Effect.fail("pending")),
                ),
              ),
              Effect.retry(Schedule.spaced("5 seconds")),
              Effect.provideService(BoardLocks.writeWaitMs, BoardLocks.WRITE_WAIT_MS),
              Effect.provideService(TickTimings.current, undefined),
              SavedWrite.background,
              Effect.forkIn(scope),
            );
          }),
        ),
      );
    return retry(3);
  };
  const ownerDeliveryNotice = (discussionId: KanbanDiscussion["id"], text: string) =>
    locks
      .fresh(
        locks.run(
          postUnlocked(
            discussionId,
            { _tag: "system", component: "owner-delivery" },
            [{ _tag: "md", text }],
            false,
          ),
        ),
      )
      .pipe(Effect.asVoid);

  interface OwnerRouteRecord {
    readonly id: number;
    readonly route_key: string;
    readonly board_id: string;
    readonly discussion_id: string;
    readonly json: string;
    readonly launched: string;
    readonly noticed: number;
    readonly done_at: string | null;
  }
  const markOwnerRouteDone = Effect.fn("KanbanService.markOwnerRouteDone")(
    function* (id: number, outcome: string) {
      const at = yield* nowIso;
      yield* tickSql`
        UPDATE ardud_kanban_owner_routes
        SET done_at = ${at}, json = json_set(json, '$.outcome', ${outcome})
        WHERE id = ${id} AND done_at IS NULL
      `;
    },
    (effect, id) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          // Left pending: the next drain replays it, and its sends are keyed.
          Effect.logWarning("kanban owner route could not be marked done", { id, cause }),
        ),
      ),
  );

  /**
   * The commit half of an owner answer or post: its routing obligation, written
   * in the same transaction as the message, so an acknowledged write always has
   * one. A row whose message no longer matches is closed when it is drained.
   */
  const saveOwnerRoute = Effect.fn("KanbanService.saveOwnerRoute")(
    function* (
      boardId: KanbanBoardId,
      discussionId: KanbanDiscussion["id"],
      key: string,
      payload: OwnerRoutePayload,
    ) {
      const at = yield* nowIso;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const json = JSON.stringify(payload);
      // The key covers the message and the answer's content and time, so the same
      // answer saved again (a retried request) keeps its route, outcome and askers.
      yield* tickSql`
        INSERT INTO ardud_kanban_owner_routes (route_key, board_id, discussion_id, json, created_at)
        VALUES (${key}, ${boardId}, ${discussionId}, ${json}, ${at})
        ON CONFLICT (route_key) DO NOTHING
      `;
    },
    (effect) => effect.pipe(Effect.mapError(toKanbanError)),
  );
  const routeRetainingAskers = Effect.fn("KanbanService.routeRetainingAskers")(function* <E>(
    discussionId: KanbanDiscussion["id"],
    key: string,
    text: string,
    route: Effect.Effect<unknown, E>,
    askId?: string,
    row?: SavedOwnerRow,
  ) {
    const initial = yield* rawStore.discussion(discussionId);
    const card = initial?.cardId ? yield* rawStore.card(initial.cardId) : null;
    const specific = card?.asks.find((ask) => ask.id === askId);
    const recorded = row?.askers ?? null;
    const nowMs = yield* nowMillis;
    // Freeze open-ask eligibility before routing closes it; late picks retain no asker.
    const asks = recorded
      ? (card?.asks ?? []).filter((ask) => recorded.ids.includes(ask.id))
      : specific
        ? specific.closedAt === null
          ? [specific]
          : []
        : card
          ? kanbanOpenAsks(card).filter((ask) => !kanbanAskExpired(ask, nowMs))
          : [];
    const needsOwner = recorded ? recorded.needsOwner : card?.stage === "needs_owner";
    if (row !== undefined && recorded === null) {
      // Routing closes these asks. A replay after a restart must still tell
      // the same askers, so they are fixed before the first attempt runs.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const askers = JSON.stringify({ ids: asks.map((ask) => ask.id), needsOwner });
      yield* tickSql`
          UPDATE ardud_kanban_owner_routes SET json = json_set(json, '$.askers', json(${askers}))
          WHERE id = ${row.id}
        `;
    }
    yield* routeSavedOwner(
      discussionId,
      key,
      Effect.gen(function* () {
        yield* route;
        for (const ask of asks) {
          const by = ask.by;
          if (
            by._tag === "evaluator" &&
            card &&
            askId === undefined &&
            (yield* isBoardEvaluator(by.threadId, card.boardId))
          ) {
            const current = yield* discussionOf(discussionId);
            const target = yield* reusableEvaluator(card);
            if (target) {
              yield* deliver(
                current,
                { _tag: "evaluator", threadId: target },
                "Evaluator",
                target,
                text,
              );
              continue;
            }
            yield* toEvaluator(current, text);
            continue;
          }
          if (by._tag !== "thread" && by._tag !== "evaluator") continue;
          // A blocked worker receives its answer through the saved wake note.
          if (by._tag === "thread" && needsOwner && by.threadId === card?.workThreadId) continue;
          const current = yield* discussionOf(discussionId);
          const next = current.cardId ? yield* cardOf(current.cardId) : null;
          const live =
            by._tag === "evaluator"
              ? yield* liveEvaluator(by.threadId)
              : by.threadId === next?.activeThreadId;
          if (live)
            yield* deliver(
              current,
              by,
              by._tag === "evaluator" ? "Evaluator" : "Worker",
              by.threadId,
              text,
            );
          else
            yield* toEvaluator(
              current,
              next && by._tag === "thread" ? Asks.passOnText(next, ask, text) : text,
            );
        }
      }),
      row,
      new Set(asks.map((ask) => ask.id)),
    );
  }, Effect.mapError(toKanbanError));
  const ownerPostRoute = Effect.fn("KanbanService.ownerPostRoute")(
    function* (message: KanbanMessage, key: string, row?: SavedOwnerRow) {
      const initial = yield* discussionOf(message.discussionId);
      const observed = yield* postRoutingTarget;
      if (observed) {
        observed.boardId = initial.boardId;
        observed.cardId = initial.cardId;
      }
      if (message.author._tag === "script") {
        return yield* routeSavedOwner(
          message.discussionId,
          key,
          Effect.gen(function* () {
            const current = yield* discussionOf(message.discussionId);
            yield* routeToOwnerAgent(
              current,
              `Script "${message.authorName}" posted in "${current.title}" (discussion ${current.id}):\n\n${blocksText(message.blocks, attachments.pathOf)}`,
              "script",
            );
          }),
          row,
        );
      }
      const text = Briefs.ownerMessageText(
        initial.title,
        initial.id,
        blocksText(message.blocks, attachments.pathOf),
      );
      yield* routeRetainingAskers(
        message.discussionId,
        key,
        text,
        Effect.gen(function* () {
          yield* routeToOwnerAgent(
            yield* discussionOf(message.discussionId),
            text,
            "owner",
            undefined,
            message.createdAt,
            blocksText(message.blocks, attachments.pathOf),
            message.seq,
          );
        }),
        undefined,
        row,
      );
    },
    (effect, message, _key, row?: SavedOwnerRow) =>
      observePostRouting(
        {
          id: message.discussionId,
          ...(row?.boardId === undefined ? {} : { boardId: row.boardId }),
          ...(row?.cardId === undefined ? {} : { cardId: row.cardId }),
        },
        message,
        effect,
      ).pipe(
        Effect.provideService(ownerPostSeq, message.seq),
        Effect.provideService(EvaluatorAnalytics.origin, "discussion_post"),
        Effect.mapError(toKanbanError),
      ),
  );
  const routeOwnerPost = (message: KanbanMessage) =>
    message.author._tag !== "owner" && message.author._tag !== "script"
      ? Effect.void
      : durableOwnerRoutes
        ? afterOwnerCommit(message.discussionId)
        : ownerPostRoute(message, `owner-post:${message.discussionId}:${message.seq}`);
  const ownerPostKey = (message: Pick<KanbanMessage, "discussionId" | "seq" | "createdAt">) =>
    `owner-post:${message.discussionId}:${message.seq}:${message.createdAt}`;

  /** Choice answers follow the current evaluator or active worker, except open asks. */
  const ownerAnswerRoute = Effect.fn("KanbanService.ownerAnswerRoute")(function* (
    discussionId: KanbanDiscussion["id"],
    seq: number,
    blockId: string,
    note: string,
    key: string,
    answered: EvaluatorAnswer,
    row?: SavedOwnerRow,
  ) {
    yield* routeRetainingAskers(
      discussionId,
      key,
      note,
      Effect.gen(function* () {
        const discussion = yield* discussionOf(discussionId);
        const message = yield* store.message(discussionId, seq);
        if (!message) return yield* failWith("not-found", `message ${seq}`);
        const card = discussion.cardId === null ? null : yield* cardOf(discussion.cardId);
        // A pick on an ask answers that ask alone.
        const ask = card?.asks.find((entry) => entry.id === blockId && entry.seq === seq);
        if (card !== null && ask !== undefined && ask.closedAt === null) {
          yield* routeToOwnerAgent(discussion, note, "owner", (open) => open.id === ask.id);
          return;
        }
        if (card !== null && ask !== undefined) {
          // A late pick follows current ownership and closes nothing else.
          const by = ask.by;
          if (by._tag === "thread" && by.threadId === card.activeThreadId) {
            yield* deliver(discussion, by, roleName(card.activeRole ?? "work"), by.threadId, note);
          } else if (
            by._tag === "evaluator" &&
            by.threadId === discussion.evaluatorThreadId &&
            (yield* liveEvaluator(by.threadId))
          ) {
            yield* deliver(discussion, by, "Evaluator", by.threadId, note);
          } else {
            yield* toEvaluator(
              discussion,
              by._tag === "thread" ? Asks.passOnText(card, ask, note) : note,
            );
          }
          return;
        }
        // A pick on a card waiting on the owner answers it like a reply does.
        const waiting = card !== null && card.stage === "needs_owner";
        const author = message.author;
        if (
          !waiting &&
          ((author._tag === "evaluator" &&
            author.threadId === discussion.evaluatorThreadId &&
            (yield* liveEvaluator(author.threadId))) ||
            (author._tag === "thread" && author.threadId === card?.activeThreadId))
        ) {
          yield* deliver(discussion, author, message.authorName, author.threadId, note);
          return;
        }
        yield* routeToOwnerAgent(discussion, note);
      }),
      blockId,
      row,
    ).pipe(
      Effect.provideService(evaluatorAnswer, answered),
      Effect.provideService(EvaluatorAnalytics.origin, "owner_answer"),
    );
  }, Effect.mapError(toKanbanError));

  const sendPlanChanged = Effect.fn("KanbanService.sendPlanChanged")(function* (
    cardId: KanbanCardId,
    threadId: ThreadId,
    key?: string,
  ) {
    const card = (yield* upgradeFindings([yield* cardOf(cardId)]))[0]!;
    if (card.activeThreadId !== threadId || (card.activeRole === "work" && !kanbanWorkStep(card)))
      return;
    yield* threads.send({
      threadId,
      text: Briefs.planChangedText(card),
      coalesce: `plan:${card.id}`,
      ...(key ? { key } : {}),
    });
  });

  /**
   * One saved owner route: its message must still be the one it was saved
   * for (a row whose message never committed, or an answer the owner has
   * since changed, is closed without delivery). Delivery marks it done.
   */
  /** One saved write follow-on, as the write would have run it inline. */
  // Failures propagate, so the drain retries and finally closes the row
  // undeliverable with a notice; only success marks it delivered.
  // Any failure is the drain's to retry or give up on.
  const runBoardEffect = (
    effect: BoardEffect,
    routeKey: string,
  ): Effect.Effect<
    unknown,
    KanbanError | KanbanStoreError | KanbanThreadError | SqlError.SqlError
  > => {
    switch (effect.kind) {
      case "assignment":
        return sendCreatedAssignment(effect.cardId, ThreadId.make(effect.threadId), "effect");
      case "send":
        if (effect.planCardId !== undefined)
          return sendPlanChanged(effect.planCardId, ThreadId.make(effect.threadId), "effect");
        return threads.send({
          threadId: ThreadId.make(effect.threadId),
          text: effect.text,
          key: "effect",
        });
      case "stopSend":
        return effect.runId !== undefined
          ? locks.outside(stopSentRun(ThreadId.make(effect.threadId), effect.runId))
          : locks.outside(
              touching(
                ThreadId.make(effect.threadId),
                threadIo.interrupt(
                  ThreadId.make(effect.threadId),
                  "Board deleted while sending",
                  false,
                  undefined,
                  effect.messageId,
                  "superseded",
                ),
              ),
            );
      case "interrupt":
      case "release":
        // Already run if a send to the thread came first (see `pendingStops`).
        return locks.outside(
          runPendingStops(effect.threadId, { key: routeKey, entry: releaseOf(effect)! }),
        );
      case "setModel":
        return locks.outside(switchToLatestModel(effect.threadId));
      case "tellEvaluator":
        return Effect.gen(function* () {
          const threadId = ThreadId.make(effect.threadId);
          if (!(yield* liveEvaluator(threadId))) return;
          yield* threads.send({ threadId, text: effect.text, key: "effect" });
        });
      case "toEvaluator":
        return Effect.gen(function* () {
          const discussion = yield* discussionOf(KanbanDiscussionId.make(effect.discussionId));
          yield* toEvaluator(
            discussion,
            effect.text,
            effect.note,
            effect.authorThreadId === undefined ? undefined : ThreadId.make(effect.authorThreadId),
          );
          // Delivered: the card it is about is let go when this evaluator's turn ends.
          if (effect.decides === true) yield* decidingTold(discussion.cardId);
        });
      case "evaluatorTurn":
        return evaluatorTurnStrict(effect.before, effect.after, effect.actor);
      case "tellAnswered":
        return Effect.gen(function* () {
          const discussion = yield* discussionOf(KanbanDiscussionId.make(effect.discussionId));
          const card = yield* cardOf(KanbanCardId.make(effect.cardId));
          yield* tellAnswered(effect, discussion, card);
        });
      case "noteDiscussion":
        return Effect.gen(function* () {
          yield* noteDiscussion(yield* cardOf(KanbanCardId.make(effect.cardId)), effect.text);
        });
      case "syncPrs":
        return Effect.gen(function* () {
          yield* syncPrs(yield* cardOf(KanbanCardId.make(effect.cardId)));
        });
    }
  };
  const runEffectRoute = Effect.fn("KanbanService.runEffectRoute")(function* (
    record: OwnerRouteRecord,
    effect: BoardEffect,
  ) {
    yield* Effect.annotateCurrentSpan("effect.kind", effect.kind);
    const row: SavedOwnerRow = {
      id: record.id,
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      launched: JSON.parse(record.launched) as ReadonlyArray<string>,
      askers: null,
    };
    yield* routeSavedOwner(
      KanbanDiscussionId.make(record.discussion_id),
      record.route_key,
      runBoardEffect(effect, record.route_key).pipe(
        Effect.provideService(effectRouteReads, true),
        Effect.provideService(
          EvaluatorAnalytics.attribution,
          effect.evaluatorCardId === undefined
            ? undefined
            : { boardId: record.board_id, cardId: effect.evaluatorCardId },
        ),
        Effect.provideService(
          EvaluatorAnalytics.origin,
          effect.evaluatorTrigger ??
            (effect.kind === "evaluatorTurn"
              ? "step_transition"
              : effect.kind === "tellAnswered"
                ? "owner_answer"
                : "legacy_queue"),
        ),
      ),
      row,
    );
    return yield* markOwnerRouteDelivered(record);
  });
  /** A pending or given-up notice: in the lane's discussion, or on the card for a card lane. */
  const routeNotice = (lane: string, text: string) =>
    lane.startsWith("archive:")
      ? locks
          .fresh(
            locks.run(
              Effect.gen(function* () {
                const boardId = KanbanBoardId.make(lane.slice("archive:".length).split("/")[0]!);
                const title = "Board deletion";
                const discussion =
                  (yield* store.discussions(boardId)).find(
                    (entry) => entry.title === title && entry.archivedAt === null,
                  ) ??
                  (yield* newDiscussion(boardId, title, null, {
                    _tag: "system",
                    component: "owner-delivery",
                  }));
                yield* postUnlocked(
                  discussion.id,
                  { _tag: "system", component: "owner-delivery" },
                  [{ _tag: "md", text }],
                  false,
                );
              }),
            ),
          )
          .pipe(Effect.asVoid)
      : lane.startsWith("card:")
        ? locks
            .fresh(
              locks.run(
                Effect.gen(function* () {
                  const card = yield* store.card(KanbanCardId.make(lane.slice("card:".length)));
                  if (card === null) return;
                  yield* logEvent(
                    card,
                    { _tag: "system", component: "owner-delivery" },
                    "comment",
                    {
                      body: text,
                    },
                  );
                }),
              ),
            )
            .pipe(Effect.asVoid)
        : ownerDeliveryNotice(KanbanDiscussionId.make(lane), text);
  const routeWhat = (record: OwnerRouteRecord) => {
    const payload = ownerRoutePayload(record);
    return payload.kind === "effect"
      ? `Board follow-up (${payload.effect.kind})`
      : payload.kind === "post" && payload.authorKind === "script"
        ? "Script post"
        : "Owner message";
  };

  /**
   * After a write that collected follow-ons commits: each is saved as its own
   * route row in one transaction, in its lane's order, and its drain started.
   */
  const saveEffectRows = Effect.fn("KanbanService.saveEffectRows")(function* (
    effects: EffectSink["effects"],
  ) {
    const lanes = new Set<string>();
    const stops: Array<[string, string, PendingRelease, string]> = [];
    yield* tickTransaction(
      Effect.forEach(
        effects,
        ({ boardId, lane, effect }) => {
          lanes.add(lane);
          const routeKey = `effect:${uuid()}`;
          if (effect.kind === "interrupt" || effect.kind === "release") {
            stops.push([effect.threadId, routeKey, releaseOf(effect)!, boardId]);
          }
          return saveOwnerRoute(
            KanbanBoardId.make(boardId),
            KanbanDiscussionId.make(lane),
            routeKey,
            { kind: "effect", effect, seq: -1 },
          );
        },
        { discard: true },
      ),
    );
    // Registered before the stop resource moves, so a take settling old notes
    // reruns if another is saved meanwhile. Dispatch refuses a pending stop;
    // sends drain pending releases before their message.
    for (const [threadId, routeKey, entry] of stops) addPendingStop(threadId, routeKey, entry);
    for (const [threadId, , entry, boardId] of stops) {
      yield* locks.access(boardId, Effect.void, true, stopResource(threadId));
      if (entry.kind === "interrupt")
        yield* locks.access(boardId, Effect.void, true, interruptResource(threadId));
    }
    return lanes;
  });
  /** After a restart, stops saved and not yet run hold their threads' sends again. */
  const loadPendingStops = Effect.fn("KanbanService.loadPendingStops")(function* () {
    const rows = yield* tickSql<{
      route_key: string;
      thread_id: string;
      kind: string;
      reason: string | null;
      cancel_queued: number | null;
      text: string | null;
      mode: "steer" | null;
    }>`
      SELECT route_key,
             json_extract(json, '$.effect.threadId') AS thread_id,
             json_extract(json, '$.effect.kind') AS kind,
             json_extract(json, '$.effect.reason') AS reason,
             json_extract(json, '$.effect.cancelQueued') AS cancel_queued,
             json_extract(json, '$.effect.text') AS text,
             json_extract(json, '$.effect.mode') AS mode
      FROM ardud_kanban_owner_routes
      WHERE done_at IS NULL AND json_extract(json, '$.kind') = 'effect'
        AND json_extract(json, '$.effect.kind') IN ('interrupt', 'release')
      ORDER BY id
    `;
    for (const row of rows) {
      addPendingStop(
        row.thread_id,
        row.route_key,
        row.kind === "release"
          ? {
              kind: "note",
              text: row.text ?? "",
              ...(row.mode === "steer" ? { mode: "steer" as const } : {}),
            }
          : { kind: "interrupt", reason: row.reason ?? "", cancelQueued: row.cancel_queued === 1 },
      );
    }
  });
  /**
   * Follow-ons of a write that failed, saved after its operation ended: each
   * board's rows, stop registrations and stop-resource bumps run in one fresh
   * board-wide operation, so no card-scoped assignment can commit between a
   * stop being saved and its resource moving (as inside the write itself).
   */
  const saveEffects = Effect.fn("KanbanService.saveEffects")(function* (
    effects: EffectSink["effects"],
  ) {
    const byBoard = new Map<string, Array<EffectSink["effects"][number]>>();
    for (const entry of effects) {
      let entries = byBoard.get(entry.boardId);
      if (!entries) byBoard.set(entry.boardId, (entries = []));
      entries.push(entry);
    }
    for (const [boardId, entries] of byBoard) {
      const lanes = yield* locks.fresh(locks.board(boardId, saveEffectRows(entries)));
      for (const lane of lanes) yield* afterOwnerCommit(lane);
    }
  });

  const runOwnerRoute = Effect.fn("KanbanService.runOwnerRoute")(function* (
    record: OwnerRouteRecord,
  ) {
    const payload = ownerRoutePayload(record);
    if (
      !(payload.kind === "effect" && ["interrupt", "stopSend"].includes(payload.effect.kind)) &&
      (yield* boardOf(KanbanBoardId.make(record.board_id))).archivedAt !== null
    ) {
      if (payload.kind === "effect" && payload.effect.kind === "release")
        return yield* closeGivenUpStop(record, payload.effect.threadId, "board-deleted");
      return yield* markOwnerRouteDone(record.id, "board-deleted");
    }
    if (payload.kind === "effect") return yield* runEffectRoute(record, payload.effect);
    const discussionId = KanbanDiscussionId.make(record.discussion_id);
    // Checked before the attempt and again inside its board operation (see `routeSavedOwner`).
    const check = (read: typeof rawStore.message) =>
      read(discussionId, payload.seq).pipe(
        Effect.map((message): OwnerRouteClosed | null => {
          if (payload.kind === "post") {
            return message === null ||
              message.author._tag !== (payload.authorKind ?? "owner") ||
              message.createdAt !== payload.createdAt
              ? "not-saved"
              : null;
          }
          const entry = message?.answers.find(
            (answer) => answer.blockId === payload.blockId && answer.by._tag === "owner",
          );
          if (message === null || entry === undefined) return "not-saved";
          // The owner changed this answer since: the newer one has its own route.
          const changed =
            entry.at !== payload.at ||
            (payload.choice !== undefined &&
              (entry.text !== (payload.text ?? null) ||
                entry.choice.length !== payload.choice.length ||
                entry.choice.some((id, index) => id !== payload.choice![index])));
          return changed ? "superseded" : null;
        }),
      );
    const before = yield* check(rawStore.message);
    if (before !== null) return yield* markOwnerRouteDone(record.id, before);
    const message = (yield* rawStore.message(discussionId, payload.seq))!;
    const row: SavedOwnerRow = {
      id: record.id,
      boardId: KanbanBoardId.make(record.board_id),
      ...(payload.kind === "post" && payload.cardId !== undefined
        ? { cardId: payload.cardId }
        : {}),
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      launched: JSON.parse(record.launched) as ReadonlyArray<string>,
      askers: payload.askers ?? null,
      check: check(store.message).pipe(Effect.mapError(toKanbanError)),
    };
    if (payload.kind === "post") {
      yield* ownerPostRoute(message, record.route_key, row);
      if (row.closed !== undefined) return yield* markOwnerRouteDone(record.id, row.closed);
      // As inline: the title is written once routing has attached the evaluator.
      // It completes before the route closes, so a restart in between writes it on replay.
      if (payload.writeTitle === true) yield* writeOwnerTitle(discussionId, message);
      return yield* markOwnerRouteDelivered(record);
    }
    const legacyAnswer = message.answers.find(
      (answer) => answer.blockId === payload.blockId && answer.by._tag === "owner",
    );
    yield* ownerAnswerRoute(
      discussionId,
      payload.seq,
      payload.blockId,
      payload.note,
      record.route_key,
      {
        discussionId,
        seq: payload.seq,
        blockId: payload.blockId,
        at: payload.at,
        choice: payload.choice ?? legacyAnswer?.choice ?? [],
        text: payload.choice === undefined ? (legacyAnswer?.text ?? null) : (payload.text ?? null),
      },
      row,
    );
    if (row.closed !== undefined) return yield* markOwnerRouteDone(record.id, row.closed);
    return yield* markOwnerRouteDelivered(record);
  });
  // Rows are written by this module from its own payload types.
  const ownerRoutePayload = (record: OwnerRouteRecord) =>
    JSON.parse(record.json) as OwnerRoutePayload & {
      readonly askers?: SavedOwnerRow["askers"];
    };
  // The client's first-line title stays when the writer fails or runs past its
  // deadline; the deadline keeps later routes in the discussion from waiting long.
  const writeOwnerTitle = (discussionId: KanbanDiscussion["id"], message: KanbanMessage) =>
    writeDiscussionTitle(discussionId, blocksText(message.blocks, attachments.pathOf)).pipe(
      Effect.timeout(OWNER_ROUTE_TITLE_DEADLINE),
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban discussion title writer failed", { discussionId, cause }),
      ),
    );
  const markOwnerRouteDelivered = (record: OwnerRouteRecord) =>
    markOwnerRouteDone(record.id, "delivered").pipe(
      Effect.ensuring(Effect.sync(() => ownerDeliveries.delete(record.route_key))),
    );

  const readOwnerRoute = (id: number) =>
    tickSql<OwnerRouteRecord>`
      SELECT id, route_key, board_id, discussion_id, json, launched, noticed, done_at
      FROM ardud_kanban_owner_routes WHERE id = ${id}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => rows[0]),
    );

  /**
   * One saved route through to its outcome. It stays at its discussion's head
   * until it is delivered, closed as no longer standing, or given up on, so a
   * later post never overtakes it. `settle` releases `await` callers once the
   * first attempts failed and only slow retries are left.
   */
  const deliverOwnerRoute = Effect.fn("KanbanService.deliverOwnerRoute")(function* (
    id: number,
    settle: Effect.Effect<void>,
  ) {
    let firstFailure: number | null = null;
    for (let attempt = 0; ; attempt += 1) {
      // Re-read every time: an earlier attempt may have fixed its askers or launches.
      const record = yield* readOwnerRoute(id);
      if (record === undefined || record.done_at !== null) return;
      if (record.noticed === OWNER_ROUTE_GIVING_UP) return yield* giveUpOwnerRoute(record);
      const exit = yield* Effect.exit(runOwnerRoute(record));
      if (Exit.isSuccess(exit)) return;
      yield* Effect.logWarning("kanban saved owner message delivery pending", {
        id,
        key: record.route_key,
        cause: exit.cause,
      });
      if (attempt < 3) {
        yield* Effect.yieldNow;
        continue;
      }
      const now = yield* Clock.currentTimeMillis;
      if (firstFailure === null) {
        firstFailure = now;
        if (record.noticed === 0) {
          yield* tickSql`UPDATE ardud_kanban_owner_routes SET noticed = 1 WHERE id = ${id}`.pipe(
            Effect.ignore,
          );
          yield* routeNotice(
            record.discussion_id,
            `${routeWhat(record)} delivery pending (${record.route_key}). Retrying in the background.`,
          ).pipe(Effect.ignore);
        }
        yield* settle;
      } else if (now - firstFailure >= OWNER_ROUTE_GIVE_UP_MS) {
        // The decision is saved first, so a restart finishes the notice instead of retrying.
        yield* tickSql`
          UPDATE ardud_kanban_owner_routes SET noticed = ${OWNER_ROUTE_GIVING_UP} WHERE id = ${id}
        `.pipe(Effect.mapError(toKanbanError));
        return yield* giveUpOwnerRoute(record);
      }
      yield* Effect.sleep("5 seconds");
    }
  });

  /**
   * Closes a route given up on. The notice is posted before the row closes, so
   * a stop in between posts it again on replay rather than never.
   */
  /**
   * A stop that could not be delivered: its notice is written first, while the
   * row is still open (a stop ending between the two replays the give-up, as
   * other routes do), then the row is closed under the stop lock, so it either
   * already ran from a send (and stays delivered) or is dropped from the
   * pending stops before any send could run it. Skipped when a send ran it
   * before the notice.
   */
  const stopRowOpen = (record: OwnerRouteRecord) =>
    tickSql<{ id: number }>`
      SELECT id FROM ardud_kanban_owner_routes WHERE id = ${record.id} AND done_at IS NULL
    `.pipe(Effect.map((rows) => rows.length > 0));
  const closeGivenUpStop = (
    record: OwnerRouteRecord,
    threadId: string,
    outcome = "undeliverable",
  ) =>
    locks.outside(
      stopping.withPermits(1)(
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* tickSql`
            UPDATE ardud_kanban_owner_routes
            SET done_at = ${at}, json = json_set(json, '$.outcome', ${outcome})
            WHERE id = ${record.id} AND done_at IS NULL
          `;
          const stops = pendingStops.get(threadId);
          stops?.delete(record.route_key);
          if (stops?.size === 0) pendingStops.delete(threadId);
          stoppedRoutes.delete(record.route_key);
        }),
      ),
    );
  const giveUpOwnerRoute = Effect.fn("KanbanService.giveUpOwnerRoute")(function* (
    record: OwnerRouteRecord,
  ) {
    const discussionId = KanbanDiscussionId.make(record.discussion_id);
    const stop = ownerRoutePayload(record);
    if (
      stop.kind === "effect" &&
      (stop.effect.kind === "interrupt" || stop.effect.kind === "release")
    ) {
      if (!(yield* stopRowOpen(record))) return;
      yield* routeNotice(
        record.discussion_id,
        stop.effect.kind === "interrupt"
          ? `Stopping thread ${stop.effect.threadId} could not be confirmed (${record.route_key}) after 10 minutes of retries; it may still be working on the card it was let go from. The board stops holding its sends for this stop once this outcome is saved.`
          : `Telling thread ${stop.effect.threadId} to let go of a card could not be confirmed (${record.route_key}) after 10 minutes of retries; it may still be working on it. The board stops holding its sends for this note once this outcome is saved.`,
      );
      return yield* closeGivenUpStop(record, stop.effect.threadId);
    }
    yield* routeNotice(
      record.discussion_id,
      `${routeWhat(record)} delivery could not be confirmed (${record.route_key}) after 10 minutes of retries. Some of it may already have reached an agent, so check the discussion before posting it again.`,
    );
    const payload = ownerRoutePayload(record);
    if (payload.kind === "post" && payload.writeTitle === true) {
      // The post stays in the discussion, so its title is still written.
      const message = yield* rawStore.message(discussionId, payload.seq);
      if (message !== null && message.createdAt === payload.createdAt) {
        yield* writeOwnerTitle(discussionId, message);
      }
    }
    yield* markOwnerRouteDone(record.id, "undeliverable");
  });

  /**
   * Discussions with a running drain. `dirty` asks it to look again before it
   * stops; `waiters` are `await` callers released when it stops or a route it
   * holds falls back to slow retries.
   */
  interface OwnerDrain {
    dirty: boolean;
    /** The route at its head has fallen back to slow retries. */
    slow: boolean;
    readonly waiters: Array<Deferred.Deferred<void>>;
  }
  const ownerRouteDrains = new Map<string, OwnerDrain>();
  const releaseOwnerWaiters = (state: OwnerDrain) =>
    Effect.suspend(() =>
      Effect.forEach(state.waiters.splice(0), (waiter) => Deferred.succeed(waiter, undefined), {
        discard: true,
      }),
    );
  const runOwnerDrain = Effect.fn("KanbanService.drainOwnerRoutes", { root: true })(
    function* (discussionId: string, state: OwnerDrain) {
      yield* Effect.annotateCurrentSpan("discussion.id", discussionId);
      while (true) {
        state.dirty = false;
        const rows = yield* tickSql<{ id: number }>`
          SELECT id FROM ardud_kanban_owner_routes
          WHERE discussion_id = ${discussionId} AND done_at IS NULL ORDER BY id
        `.pipe(NodeSqliteClient.readOnly);
        for (const row of rows) {
          yield* deliverOwnerRoute(
            row.id,
            Effect.suspend(() => {
              state.slow = true;
              return releaseOwnerWaiters(state);
            }),
          );
          state.slow = false;
        }
        // Checked and released in one step, so a route saved meanwhile is never missed.
        const finished = yield* Effect.sync(() => {
          if (state.dirty) return false;
          ownerRouteDrains.delete(discussionId);
          return true;
        });
        if (finished) return;
      }
    },
    (effect, discussionId, state) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          // Pending rows stay for the sweep or the next restart.
          Effect.logWarning("kanban owner routes stopped draining", { discussionId, cause }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (ownerRouteDrains.get(discussionId) === state) ownerRouteDrains.delete(discussionId);
          }),
        ),
        Effect.ensuring(releaseOwnerWaiters(state)),
      ),
  );

  /** Starts the discussion's drain, or asks the running one to look again. */
  const triggerOwnerDrain = Effect.fn("KanbanService.triggerOwnerDrain")(function* (
    discussionId: string,
  ) {
    const waiter = yield* Deferred.make<void>();
    const state = yield* Effect.sync(() => {
      const active = ownerRouteDrains.get(discussionId);
      if (active) {
        active.dirty = true;
        // Behind a route in slow retries, a caller waits for no attempt of its own.
        if (!active.slow) active.waiters.push(waiter);
        return active.slow ? "settled" : null;
      }
      const started: OwnerDrain = { dirty: false, slow: false, waiters: [waiter] };
      ownerRouteDrains.set(discussionId, started);
      return started;
    });
    if (state === "settled") yield* Deferred.succeed(waiter, undefined);
    // Deferred delivery (and its retries) is background work even when an owner's RPC triggered it.
    else if (state !== null)
      yield* runOwnerDrain(discussionId, state).pipe(
        NodeSqliteClient.backgroundReads,
        Effect.provideService(BoardLocks.writeWaitMs, BoardLocks.WRITE_WAIT_MS),
        Effect.provideService(TickTimings.current, undefined),
        SavedWrite.background,
        Effect.forkIn(scope),
      );
    return waiter;
  });

  /**
   * After an owner answer or post commits: in production the reply returns now
   * and delivery follows in its own trace; `await` waits until the discussion's
   * drain has run this route, or a route ahead of it fell back to slow retries.
   */
  const afterOwnerCommit = (discussionId: string): Effect.Effect<void> =>
    triggerOwnerDrain(discussionId).pipe(
      Effect.flatMap((waiter) =>
        ownerRouteMode === "deferred" ? Effect.void : Deferred.await(waiter),
      ),
    );

  /** Replays pending owner routes; `minAgeMs` leaves fresh ones to their own drain. */
  const sweepOwnerRoutes = Effect.fn("KanbanService.sweepOwnerRoutes")(
    function* (minAgeMs: number) {
      const before = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { milliseconds: minAgeMs }),
      );
      const pending = yield* tickSql<{ discussion_id: string }>`
        SELECT DISTINCT discussion_id FROM ardud_kanban_owner_routes
        WHERE done_at IS NULL AND created_at <= ${before}
      `.pipe(NodeSqliteClient.readOnly);
      for (const row of pending) yield* triggerOwnerDrain(row.discussion_id);
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban owner route sweep failed", { cause }),
        ),
      ),
  );

  /** Internal posts, including asks that own a sequence, must not deduplicate. */
  const postUnlocked = Effect.fn("KanbanService.postUnlocked")(function* (
    discussionId: KanbanDiscussion["id"],
    author: KanbanActor,
    blocks: ReadonlyArray<KanbanBlock>,
    route = true,
    dedupe = false,
    /** Commit an owner or script post with its routing obligation. */
    saveRoute = false,
    /** The ask whose discussion the message belongs to. */
    askId?: string,
    /** With askId, for a message that is the ask itself: the revision it shows. */
    askRevision?: number,
    captureContext = false,
  ) {
    yield* checkText(messageTextFields(blocks));
    if (blocks.length === 0)
      return yield* failWith(
        "invalid",
        "a message needs at least one block",
        "invalid_args",
        "missing_required",
        "blocks",
      );
    const discussion = yield* discussionOf(discussionId);
    if (captureContext) yield* captureDiscussionContext(discussion);
    if (
      dedupe &&
      isRetryActor(author) &&
      discussion.lastSeq > 0 &&
      !blocks.some((block) => block._tag === "attachment" || block._tag === "image")
    ) {
      const last = yield* store.message(discussionId, discussion.lastSeq);
      if (
        last &&
        actorKey(last.author) === actorKey(author) &&
        withinRetryWindow(last.createdAt, yield* Clock.currentTimeMillis)
      ) {
        // The comparison deliberately matches the persisted JSON representation of normalized blocks.
        const sameBlocks =
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify(blocks.map(normalizeMessageBlock)) === JSON.stringify(last.blocks);
        if (sameBlocks) {
          yield* SavedWrite.record({ kind: "message", message: last });
          yield* observePostRouting(discussion, last, Effect.void, "deduplicated");
          return last;
        }
      }
    }
    const at = yield* nowIso;
    let authorName = OWNER_NAME;
    if (author._tag === "thread" || author._tag === "evaluator") {
      const link = yield* store.threadLink(author.threadId);
      authorName = link ? roleName(link.role) : "Agent";
    } else if (author._tag === "script") {
      authorName = (yield* store.script(author.scriptId))?.name ?? "Script";
    } else if (author._tag === "system") {
      authorName = "Board";
    }
    // Board files are kept on purpose: nothing deletes them yet. Claimed paths
    // are released if the message never gets stored.
    const claim = yield* attachments.claim(discussion.boardId, blocks.map(normalizeMessageBlock));
    const storedBlocks = [...claim.blocks];
    const message: KanbanMessage = {
      discussionId,
      seq: discussion.lastSeq + 1,
      author,
      authorName,
      blocks: storedBlocks,
      answers: [],
      createdAt: at,
      ...(askId === undefined ? {} : { askId }),
      ...(askId === undefined || askRevision === undefined ? {} : { askRevision }),
    };
    const writeTitle = author._tag === "owner" && (yield* wantsWrittenTitle(discussion));
    const durablePost = saveRoute && (author._tag === "owner" || author._tag === "script");
    // A board discussion with no evaluator yet belongs to the first one that
    // speaks in it. Card discussions keep starting their own, which knows the card.
    const owned =
      author._tag === "evaluator" && discussion.cardId === null
        ? adoptEvaluator(discussion, author)
        : discussion;
    // Someone else speaking brings a settled or snoozed discussion back, like a thread waking.
    const woken =
      author._tag === "owner" ? owned : { ...owned, settledAt: null, snoozedUntil: null };
    const posted = discussionForSave(
      withParticipant({ ...woken, lastSeq: message.seq, lastMessageAt: at }, author, authorName, {
        lastReadSeq: message.seq,
        typingUntil: null,
        owes: null,
      }),
    );
    // The acknowledged sequence must survive cancellation with its message.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* boardTransaction(
          discussion.boardId,
          Effect.gen(function* () {
            if (durablePost) {
              yield* saveOwnerRoute(discussion.boardId, discussionId, ownerPostKey(message), {
                kind: "post",
                seq: message.seq,
                createdAt: message.createdAt,
                authorKind: author._tag as "owner" | "script",
                cardId: discussion.cardId,
                writeTitle,
              });
            }
            yield* store.putMessage(message);
            yield* store.putDiscussion(posted);
          }),
          `discussion:${discussionId}`,
        ).pipe(Effect.onError(() => attachments.release(claim.claimedPaths)));
        yield* SavedWrite.record({ kind: "message", message });
      }),
    );
    yield* publish(discussion.boardId, { _tag: "discussion", discussion: posted });
    yield* publish(discussion.boardId, { _tag: "message", message });

    const text = blocksText(storedBlocks, attachments.pathOf);
    if (!route) {
      yield* observePostRouting(posted, message, Effect.void, durablePost ? "pending" : "skipped");
      // A durable owner post's title follows its delivery (see `runOwnerRoute`).
      if (writeTitle && !durablePost) yield* forkDiscussionTitle(discussion.id, text);
      return message;
    }
    yield* observePostRouting(
      posted,
      message,
      Effect.gen(function* () {
        if (author._tag === "owner") {
          yield* routeToOwnerAgent(
            posted,
            Briefs.ownerMessageText(posted.title, posted.id, text),
            "owner",
            undefined,
            message.createdAt,
            text,
          ).pipe(Effect.provideService(EvaluatorAnalytics.origin, "discussion_post"));
        } else if (author._tag === "script") {
          yield* routeToOwnerAgent(
            posted,
            `Script "${authorName}" posted in "${posted.title}" (discussion ${posted.id}):\n\n${text}`,
            "script",
          ).pipe(Effect.provideService(EvaluatorAnalytics.origin, "discussion_post"));
        } else if (author._tag === "evaluator" && posted.cardId !== null) {
          // An evaluator in a card discussion speaks to the card's live thread too.
          const card = yield* cardOf(posted.cardId);
          if (card.activeThreadId !== null && card.activeThreadId !== author.threadId) {
            const threadId = card.activeThreadId;
            const observed = yield* postRoutingTarget;
            if (observed) {
              observed.target = "live_thread";
              observed.threadId = threadId;
            }
            const relay = `Evaluator in the discussion of card #${card.number} (${posted.id}):\n\n${text}`;
            yield* later(
              posted.boardId,
              posted.id,
              { kind: "send", threadId, text: relay, evaluatorCardId: posted.cardId },
              threads.send({ threadId, text: relay }),
            );
          }
        } else if (
          author._tag === "thread" &&
          posted.cardId !== null &&
          asksSomething(storedBlocks, text)
        ) {
          // Nothing else reads a worker's post, so its question goes to the discussion's evaluator.
          const card = yield* cardOf(posted.cardId);
          const question = Briefs.workerQuestionText(card.number, posted.id, author.threadId, text);
          yield* later(
            posted.boardId,
            posted.id,
            {
              kind: "toEvaluator",
              discussionId: posted.id,
              text: question,
              note: true,
              evaluatorTrigger: "card_ask",
            },
            toEvaluator(posted, question, true).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("kanban worker question routing failed", {
                  cardId: card.id,
                  cause,
                }),
              ),
            ),
          );
        }
        if (posted.cardId !== null && author._tag !== "owner" && author._tag !== "script") {
          const current = yield* discussionOf(posted.id);
          const isDiscussionEvaluator =
            author._tag === "evaluator" && current.evaluatorThreadId === author.threadId;
          // Worker questions above already route with their specific brief.
          if (
            !isDiscussionEvaluator &&
            !(author._tag === "thread" && asksSomething(storedBlocks, text))
          ) {
            const textToEvaluator = `${authorName} posted in "${posted.title}" (discussion ${posted.id}):\n\n${text}`;
            const authorThreadId =
              author._tag === "thread" || author._tag === "evaluator" ? author.threadId : undefined;
            yield* later(
              posted.boardId,
              posted.id,
              {
                kind: "toEvaluator",
                discussionId: posted.id,
                evaluatorTrigger: "discussion_post",
                text: textToEvaluator,
                note: true,
                ...(authorThreadId === undefined ? {} : { authorThreadId }),
              },
              toEvaluator(current, textToEvaluator, true, authorThreadId),
            );
          }
        }
      }),
    );
    // A title write must not invalidate this post while routing releases the board lock.
    if (writeTitle) yield* forkDiscussionTitle(discussion.id, text);
    return message;
  });

  /**
   * Whether a discussion is the thread's home: it is the discussion the thread
   * evaluates, or its own link's discussion, or a card discussion for a card
   * the thread works on or carries. Elsewhere the thread was only told things,
   * so it never types there or gets a nudge.
   */
  const isHome = Effect.fn("KanbanService.isHome")(function* (
    discussion: KanbanDiscussion,
    threadId: ThreadId,
  ) {
    if (discussion.evaluatorThreadId === threadId) return true;
    const link = yield* store.threadLink(threadId);
    if (link?.discussionId === discussion.id) return true;
    if (discussion.cardId === null) return false;
    // A reviewer's card is released when its verdict lands, but its turn end still owes the discussion.
    if (link?.cardId === discussion.cardId) return true;
    const card = yield* store.card(discussion.cardId);
    if (card?.activeThreadId === threadId) return true;
    return (yield* store.threadCards(threadId)).includes(discussion.cardId);
  });

  const discussionHeld = (
    board: KanbanBoard,
    discussion: KanbanDiscussion,
    link: KanbanThreadLink,
    carried: ReadonlyArray<KanbanCard>,
  ) =>
    board.pause !== null &&
    link.role !== "evaluator" &&
    ((discussion.cardId !== null && !board.pause.keep.includes(discussion.cardId)) ||
      carried.some((card) => !board.pause!.keep.includes(card.id)) ||
      (carried.length === 0 && link.cardId !== null && !board.pause.keep.includes(link.cardId)));

  const reconcileHeldDiscussions = Effect.fn("KanbanService.reconcileHeldDiscussions")(function* (
    board: KanbanBoard,
  ) {
    if (board.pause === null) return;
    for (const initial of yield* store.openDiscussions(board.id)) {
      if (initial.settledAt !== null || initial.archivedAt !== null) continue;
      let discussion = initial;
      for (const participant of initial.participants) {
        if (
          participant.actor._tag !== "thread" ||
          participant.owes !== "asked" ||
          participant.deferred
        )
          continue;
        const threadId = participant.actor.threadId;
        const link = yield* store.threadLink(threadId);
        if (!link || link.boardId !== board.id || link.role === "evaluator") continue;
        if (!(yield* isHome(discussion, threadId))) continue;
        if (!discussionHeld(board, discussion, link, yield* store.cardsByThread(threadId)))
          continue;
        discussion = deferParticipant(discussion, participant);
      }
      if (discussion !== initial) yield* saveDiscussion(discussion);
    }
  });

  const discussionWaitHeld = Effect.fn("KanbanService.discussionWaitHeld")(function* (
    discussion: KanbanDiscussion,
    link: KanbanThreadLink,
  ) {
    if (link.role === "evaluator") return false;
    if (discussion.cardId === null && (yield* store.cardsByThread(link.threadId)).length > 0)
      return false;
    const now = yield* nowMillis;
    const id = discussion.cardId ?? link.cardId;
    const card = id === null ? null : yield* store.card(id);
    return (
      card !== null &&
      (card.workThreadId === link.threadId || card.reviewThreadId === link.threadId) &&
      waitingToRun(card, now)
    );
  });

  const sendDiscussionReminder = Effect.fn("KanbanService.sendDiscussionReminder")(function* (
    discussion: KanbanDiscussion,
    threadId: ThreadId,
    action: string,
  ) {
    return yield* threads
      .send({
        threadId,
        text: Briefs.nudgeDiscussionText(discussion.id),
        coalesce: `owner:${discussion.cardId ?? discussion.id}`,
        key: ownerReplyKey(discussion.id, threadId, action),
      })
      .pipe(
        Effect.provideService(EvaluatorAnalytics.origin, "discussion_nudge"),
        EvaluatorAnalytics.forCard(discussion.boardId, discussion.cardId),
        Effect.result,
      );
  });

  const recordDiscussionReminder = Effect.fn("KanbanService.recordDiscussionReminder")(function* (
    discussion: KanbanDiscussion,
    participant: KanbanParticipant,
    sent: Effect.Success<ReturnType<typeof sendDiscussionReminder>>,
    retry: boolean,
  ) {
    if (Result.isFailure(sent)) {
      if (participant.deferred && sent.failure.rejected) {
        yield* saveDiscussion(
          withParticipant(discussion, participant.actor, participant.name, {
            deferredKey: NodeCrypto.randomUUID(),
          }),
        );
      }
      if (retry || participant.deferred) return true;
    }
    yield* saveDiscussion(
      withParticipant(discussion, participant.actor, participant.name, {
        owes: "nudged",
        typingUntil: yield* typingUntil,
      }),
    );
    return true;
  });

  /** A deferral must leave the turn's reminder attempt available for an active sibling. */
  const settleParticipant = Effect.fn("KanbanService.settleParticipant")(function* (
    discussion: KanbanDiscussion,
    threadId: ThreadId,
    retry = false,
  ) {
    const participant = discussion.participants.find(
      (candidate) =>
        (candidate.actor._tag === "thread" || candidate.actor._tag === "evaluator") &&
        candidate.actor.threadId === threadId,
    );
    if (!participant) return false;
    if (discussion.settledAt !== null || discussion.archivedAt !== null) return false;
    if (participant.owes === "asked") {
      const link = yield* store.threadLink(threadId);
      const board = yield* boardOf(discussion.boardId);
      if (board.archivedAt !== null) return false;
      if (link && (yield* discussionWaitHeld(discussion, link))) {
        yield* saveDiscussion(
          withParticipant(
            deferParticipant(discussion, participant),
            participant.actor,
            participant.name,
            { typingUntil: null },
          ),
        );
        return false;
      }
      if (board.pause && link && link.role !== "evaluator") {
        const carried = yield* store.cardsByThread(threadId);
        if (discussionHeld(board, discussion, link, carried)) {
          yield* saveDiscussion(
            withParticipant(
              deferParticipant(discussion, participant),
              participant.actor,
              participant.name,
              { typingUntil: null },
            ),
          );
          return false;
        }
      }
      const action = yield* ownerReplyPending(store, discussion.id, threadId);
      if (action === null) return false;
      const sent = yield* sendDiscussionReminder(discussion, threadId, action);
      return yield* recordDiscussionReminder(discussion, participant, sent, retry);
    }
    if (participant.typingUntil !== null || participant.owes !== null) {
      yield* saveDiscussion(
        withParticipant(discussion, participant.actor, participant.name, {
          owes: null,
          typingUntil: null,
        }),
      );
    }
    return false;
  });

  const settleWhenTurnEnds = Effect.fn("KanbanService.settleWhenTurnEnds")(function* (
    discussion: KanbanDiscussion,
    threadId: ThreadId,
    discussionAttempted: boolean,
  ) {
    const participant = discussion.participants.find(
      (candidate) =>
        (candidate.actor._tag === "thread" || candidate.actor._tag === "evaluator") &&
        candidate.actor.threadId === threadId,
    );
    if (discussion.settledAt !== null || discussion.archivedAt !== null) return false;
    if (participant?.owes === "asked" && discussionAttempted) {
      if (participant.actor._tag === "thread" && !participant.deferred) {
        yield* saveDiscussion(deferParticipant(discussion, participant));
      }
      return false;
    }
    // A reminder held for another card must not turn the kept card's turns
    // into attempts to reply to that held discussion.
    if (participant?.deferred && participant.owes === "asked") {
      const link = yield* store.threadLink(threadId);
      if (link?.paused) return false;
      const board = yield* boardOf(discussion.boardId);
      if (link && discussionHeld(board, discussion, link, yield* store.cardsByThread(threadId))) {
        if (participant.typingUntil !== null) {
          yield* saveDiscussion(
            withParticipant(discussion, participant.actor, participant.name, { typingUntil: null }),
          );
        }
        return false;
      }
      const view = yield* threads.view(threadId);
      if (
        !view ||
        view.archived ||
        view.state !== "idle" ||
        Rules.waitingOnBackground(view, yield* nowMillis)
      )
        return false;
      return yield* settleParticipant(discussion, threadId, true);
    }
    const attempted = participant?.actor._tag === "thread" && participant.owes === "asked";
    if (attempted) {
      const link = yield* store.threadLink(threadId);
      const board = yield* boardOf(discussion.boardId);
      if (link && discussionHeld(board, discussion, link, yield* store.cardsByThread(threadId))) {
        yield* settleParticipant(discussion, threadId);
        return false;
      }
    }
    const reminded = yield* settleParticipant(discussion, threadId);
    return attempted && reminded;
  });

  const assignmentState = (row: KanbanCard) => ({
    stage: row.stage,
    activeThreadId: row.activeThreadId,
    activeRole: row.activeRole,
    activePool: row.activePool,
    workThreadId: row.workThreadId,
    reviewThreadId: row.reviewThreadId,
    reviewStep: row.reviewStep,
    reviewRound: row.reviewRound,
    reviewFindingsPending: row.reviewFindingsPending,
    projectId: row.projectId,
    reviewChain: row.reviewChain,
    model: row.model,
    models: row.models,
    stalled: row.stalled,
    wait: row.wait,
    priority: row.priority,
    settledAt: row.settledAt,
    blockedBy: row.blockedBy,
    subtasks: row.subtasks,
    task: row.prompt.trim() || row.description.trim() || row.title,
    targets: row.links
      .map(({ kind, url }) => ({ kind, url }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.url.localeCompare(b.url)),
    wakeNote: row.wakeNote,
  });

  const saveDispatchCard = Effect.fn("KanbanService.saveDispatchCard")(function* (
    card: KanbanCard,
    slotWhy?: SlotEventWhy,
  ) {
    const current = yield* cardOf(card.id);
    const saved = {
      ...card,
      links: current.links,
      discussionId: current.discussionId,
      updatedAt: yield* nowIso,
    };
    if (preparedTransitions.has(card)) preparedTransitions.add(saved);
    yield* saveCard(saved, undefined, false, slotWhy);
    return saved;
  });

  // Each dispatch owns this view. Store write notifications refresh only
  // changed rows, including this pass's writes and independent store writers.
  const dispatchCardPass = (boardId: KanbanBoardId, changed: Set<KanbanCardId>) => {
    let rows: Map<string, KanbanCard | null> | undefined;
    let snapshot: ReadonlyArray<KanbanCard> = [];
    let dirty = true;
    const candidate = (card: KanbanCard) =>
      card.settledAt === null &&
      (["todo", "working", "needs_review", "in_review"].includes(card.stage) ||
        card.wait !== undefined ||
        card.deciding !== undefined ||
        card.activeThreadId !== null);
    const read = locks.access(
      boardId,
      Effect.gen(function* () {
        const loaded = rows !== undefined;
        if (rows === undefined)
          rows = new Map((yield* rawStore.dispatchCards(boardId)).map((card) => [card.id, card]));
        if (loaded && changed.size === 0 && !dirty) return snapshot;
        // Row refresh and dependency expansion must both finish before reusing the snapshot.
        dirty = true;
        while (changed.size > 0) {
          const ids = [...changed];
          changed.clear();
          // A write notification may precede its enclosing transaction's commit.
          // Taking the writer waits for that commit (or rollback) before refreshing.
          const fresh = yield* tickTransaction(Effect.forEach(ids, (id) => rawStore.card(id))).pipe(
            // A cancelled refresh must not lose the writes the next plan needs to see.
            Effect.onError(() =>
              Effect.sync(() => {
                for (const id of ids) changed.add(id);
              }),
            ),
            Effect.mapError(
              (cause) => new KanbanStoreError({ operation: "refresh dispatch cards", cause }),
            ),
          );
          for (let i = 0; i < ids.length; i++) rows.set(ids[i]!, fresh[i]!);
        }
        const cards = new Map<string, KanbanCard>();
        const pending = [...rows.values()].flatMap((card) =>
          card !== null && candidate(card) ? [card] : [],
        );
        for (let i = 0; i < pending.length; i++) {
          const card = pending[i]!;
          if (cards.has(card.id) || card.settledAt !== null) continue;
          cards.set(card.id, card);
          if (KANBAN_DONE_STAGES.has(card.stage)) continue;
          // Completed cards can still block on an evaluator's merge subtask;
          // needs_owner cards can block too. Load named dependencies, not history.
          for (const id of card.blockedBy) {
            if (!rows.has(id)) rows.set(id, yield* rawStore.card(KanbanCardId.make(id)));
            const dependency = rows.get(id);
            if (dependency?.boardId === boardId && !cards.has(id)) pending.push(dependency);
          }
        }
        snapshot = [...cards.values()].sort((a, b) => a.number - b.number);
        dirty = false;
        return snapshot;
      }),
    );
    return { read };
  };

  const workThreadHomes = Effect.fn("KanbanService.workThreadHomes")(function* (
    cards: ReadonlyArray<KanbanCard>,
    fresh = false,
  ) {
    const ids = [
      ...new Set(
        cards.flatMap((card) =>
          card.stage === "todo" && card.workThreadId !== null ? [card.workThreadId] : [],
        ),
      ),
    ];
    const byId = fresh ? undefined : new Map(cards.map((card) => [card.id, card]));
    const homes = new Map<string, KanbanCard | null>();
    for (const link of yield* rawStore.threadLinksByIds(ids)) {
      // Finished home cards are absent from the dispatch snapshot.
      if (link.cardId !== null)
        homes.set(link.threadId, byId?.get(link.cardId) ?? (yield* rawStore.card(link.cardId)));
    }
    return homes;
  });

  /** Only this card's changes and relevant board writes invalidate its start. */
  const startCard = Effect.fn("KanbanService.startCard")(function* (
    boardId: KanbanBoard["id"],
    dispatch: Rules.Dispatch,
    planned: KanbanCard,
    destination: { newThread: boolean; expectedCard: KanbanCard; valid: Effect.Effect<boolean> },
    pass: ReturnType<typeof dispatchCardPass>,
  ) {
    const board = yield* boardOf(boardId);
    if (settingUp.has(board.id)) return;
    const card = yield* cardOf(dispatch.cardId);
    // Planning and starting use separate snapshots; confirm before any side effect.
    const confirmed = Rules.confirmDispatch(
      board,
      planned,
      yield* pass.read,
      Rules.maskDownPools(yield* store.pools(board.id), new Set((yield* Ref.get(down)).keys())),
      yield* boardHolds(board.id, `${board.id}:${dispatch.cardId}`),
      dispatch,
    );
    if (!confirmed) return;
    const projectId = card.projectId ?? board.defaultProjectId;
    const at = yield* nowIso;
    const system: KanbanActor = { _tag: "system", component: "dispatcher" };
    if (projectId === null) {
      const next = {
        ...card,
        stalled: { reason: "No project set for this card", by: system, at },
        updatedAt: at,
      };
      yield* logEvent(next, system, "flagged", { body: "No project set for this card" });
      destination.expectedCard = yield* saveDispatchCard(next);
      return;
    }
    const refused = modelProblem(yield* providerRegistry.getProviders, dispatch.model);
    if (refused !== null) {
      const reason = `Model refused: ${refused}`;
      const next = { ...card, stalled: { reason, by: system, at }, updatedAt: at };
      yield* logEvent(next, system, "flagged", { body: reason });
      destination.expectedCard = yield* saveDispatchCard(next);
      yield* recordAnalytics({
        kind: "kanban.worker_failed",
        boardId: card.boardId,
        cardId: card.id,
        props: {
          poolKey: dispatch.pool,
          model: BoardAnalytics.label(dispatch.model.model),
          errorClass: BoardAnalytics.reasonClass(reason),
        },
      });
      yield* noteDiscussion(card, Briefs.modelRefusedText(card, refused)).pipe(
        Effect.provideService(EvaluatorAnalytics.origin, "stall_run_failure"),
        Effect.catchCause((cause) => Effect.logWarning("kanban model note failed", { cause })),
      );
      return;
    }
    const goal = yield* goalOf(card);
    // A fresh start leaves the old work thread with its own cards.
    const existing = dispatch.fresh
      ? null
      : dispatch.role === "work"
        ? card.workThreadId
        : Rules.reviewThreadToReuse(board, card);
    // Reset releases the home card before its old run finishes stopping.
    // Claimed cards must wait for that reservation even with a fresh destination.
    if (dispatch.freshReason !== undefined && card.workThreadId !== null)
      yield* refusePendingStop(card.workThreadId);
    let threadId: ThreadId | null = null;
    let adoptRunning = false;
    let runStateAtSend = "idle";
    const events = existing === null ? [] : yield* store.cardEvents(card.id);
    // Dispatcher claims/rollbacks are retries. An explicit handoff, Stop or reopen
    // is a new assignment even when the same subtask is still open.
    const epoch =
      events.findLast(
        (event) =>
          (event.fromStage !== event.toStage ||
            (event.kind === "moved" && event.body === "Woken")) &&
          !(event.actor._tag === "system" && event.actor.component === "dispatcher"),
      )?.id ?? 0;
    const rollback = events.findLast(assignmentRolledBack);
    const rollbackAt = rollback?.at;
    const assignmentKey =
      existing === null
        ? null
        : wakeKey(
            existing,
            encodeWakeIdentity({
              card: card.id,
              role: dispatch.role,
              epoch,
              step: kanbanOpenStep(card),
              subtasks: card.subtasks
                .filter((task) => task.state === "open" && task.step === kanbanOpenStep(card))
                .map(({ id, text, owner }) => ({ id, text, owner })),
              reviewStep: card.reviewStep,
              reviewRound: card.reviewRound,
              retries: card.retries ?? [],
              model: dispatch.model,
              note: card.wakeNote,
              task: card.prompt.trim() || card.description.trim() || card.title,
              targets: card.links.map((link) => link.url).sort(),
            }),
          );
    if (existing !== null) {
      // A pending interrupt invalidates the running view used for orphan adoption.
      yield* settlePendingNotes(board.id, existing, true);
      yield* refusePendingStop(existing);
      // Do not mistake a failed projection read for a missing work thread.
      const existingRead =
        dispatch.role === "work" ? yield* Effect.result(threads.find(existing)) : null;
      if (existingRead?._tag === "Failure") return;
      let view = existingRead === null ? yield* threads.view(existing) : existingRead.success;
      const priorDelivery = delivering.get(card.id);
      if (priorDelivery?.threadId === existing && !priorDelivery.revoked) return;
      if (rollbackAt !== undefined && assignmentKey !== null) {
        // A crash after rollback can leave the old assignment alive. Repair its
        // withdrawal before the busy-thread guard can defer this card again.
        const withdrawn = yield* threads.withdraw({
          threadId: rollback?.assignmentWake?.threadId ?? existing,
          key: rollback?.assignmentWake?.key ?? assignmentKey,
          retryWithdrawn: true,
          withdrawalBefore: rollbackAt,
          text: `The board changed while assigning card #${card.number}. Re-read card_get before acting on that assignment; keep working on your other cards.`,
        });
        if (withdrawn === "pending") return;
        const refreshed = yield* Effect.result(threads.find(existing));
        if (Result.isFailure(refreshed)) return;
        view = refreshed.success;
      }
      runStateAtSend = view?.runStatus ?? view?.state ?? "missing";
      const compactEvent =
        dispatch.role === "work" ? yield* threadCompacting(existing, yield* pass.read) : undefined;
      if (dispatch.joins && !view) {
        // The thread holding the slot is gone: the card stops pointing at it,
        // so the next pass gives it a slot of its own instead of joining again.
        yield* dropHold(existing);
        destination.expectedCard = yield* saveDispatchCard({
          ...card,
          workThreadId: null,
          updatedAt: at,
        });
        yield* kick;
        return;
      }
      if (view && dispatch.role === "work") {
        const reason = yield* ensureWorkModel(existing, dispatch.model, card.id);
        if (reason !== null) {
          const next = { ...card, stalled: { reason, by: system, at }, updatedAt: at };
          yield* logEvent(next, system, "flagged", { body: reason });
          destination.expectedCard = yield* saveDispatchCard(next);
          yield* noteDiscussion(card, Briefs.threadModelDiffersText(card, reason)).pipe(
            Effect.provideService(EvaluatorAnalytics.origin, "stall_run_failure"),
            Effect.catchCause((cause) => Effect.logWarning("kanban model note failed", { cause })),
          );
          return;
        }
      }
      // A previous send may have started the run before its claim conflicted.
      // Repair that orphan without queueing another assignment behind the live turn.
      const isOwnAssignment = (
        messageId: string | null | undefined,
        requestedAt: string | null | undefined,
      ) =>
        assignmentKey !== null &&
        messageId !== undefined &&
        messageId !== null &&
        (messageId === `kanban:${assignmentKey}` ||
          new RegExp(`^kanban:${assignmentKey}:retry:[0-9]+$`).test(messageId)) &&
        (rollback === undefined ||
          (requestedAt !== undefined &&
            requestedAt !== null &&
            Date.parse(requestedAt) > Date.parse(rollback.at)));
      if (
        view &&
        (view.state === "queued" || view.state === "running") &&
        dispatch.role === "work" &&
        card.workThreadId === existing
      ) {
        adoptRunning =
          isOwnAssignment(view.runMessageId, view.runRequestedAt) &&
          ["queued", "preparing", "starting", "running"].includes(view.runStatus ?? view.state);
        if (!adoptRunning) {
          const queued = yield* threads.queuedRuns(existing);
          adoptRunning = queued.some((run) =>
            isOwnAssignment(run.userMessageId, DateTime.formatIso(run.requestedAt)),
          );
        }
      }
      if (view && view.state !== "idle" && !adoptRunning) {
        // A batch can plan several joins before its first card starts. If that
        // first card is waiting for compaction, none may queue behind it.
        const waitingForCompact =
          dispatch.role === "work" &&
          compactEvent !== undefined &&
          (yield* store.cardsByThread(existing)).length === 0;
        if (waitingForCompact) return;
        if (view.state === "running") {
          // Starting late does not renew a delivery superseded before provider admission.
          if (
            rollback !== undefined &&
            (view.runRequestedAt == null ||
              Date.parse(view.runRequestedAt) <= Date.parse(rollback.at))
          )
            return;
          const ownershipChange = events.findLast(
            (event) =>
              event.fromStage !== event.toStage &&
              ((event.fromStage !== null && KANBAN_THREAD_STAGES.includes(event.fromStage)) ||
                (event.toStage !== null && KANBAN_THREAD_STAGES.includes(event.toStage))),
          );
          // An acknowledged interrupt may still be stopping the old provider run.
          // Persisted ownership changes keep it ineligible across retries, reopen and restart.
          if (
            ownershipChange !== undefined &&
            ownershipChange.fromStage !== null &&
            KANBAN_THREAD_STAGES.includes(ownershipChange.fromStage) &&
            (ownershipChange.toStage === null ||
              !KANBAN_THREAD_STAGES.includes(ownershipChange.toStage)) &&
            (ownershipChange.actor._tag !== "thread" ||
              ownershipChange.actor.threadId !== existing) &&
            (view.runStartedAt === null ||
              Date.parse(view.runStartedAt) <= Date.parse(ownershipChange.at))
          )
            return;
          // A run predating a wake has not received its instructions yet.
          if (
            card.wakeNote !== null &&
            (view.runStartedAt === null ||
              !(Date.parse(view.runStartedAt) > Date.parse(card.movedAt)))
          )
            return;
          if (dispatch.role === "review") {
            const verdict = events.findLast(
              (event) =>
                event.kind === "review" &&
                event.actor._tag === "thread" &&
                event.actor.threadId === existing,
            );
            // A verdict ends that run's ownership; the next chain step needs its own brief.
            if (
              verdict &&
              (view.runStartedAt === null ||
                !(Date.parse(view.runStartedAt) > Date.parse(verdict.at)))
            )
              return;
            const model = yield* threads.model(existing, true);
            if (model === null || Rules.poolKey(model) !== Rules.poolKey(dispatch.model)) return;
          }
          adoptRunning = true;
        } else if (!dispatch.joins) return;
      }
      if (view?.state === "idle" && compactEvent !== undefined) {
        const compactRunId = compactEvent.body?.match(/\[compact-run ([^\]]+)\]$/)?.[1];
        const latest =
          compactRunId === undefined
            ? yield* Effect.result(threads.latestRun(existing))
            : yield* Effect.result(threads.compactRun(existing, compactRunId));
        // A failed read or the original failure is not proof that maintenance
        // finished; wait rather than silently abandon the thread.
        if (
          latest._tag === "Failure" ||
          latest.success?.message?.trim().toLowerCase() !== "/compact"
        )
          return;
        if (latest.success.status !== "completed") {
          if (!["failed", "cancelled", "interrupted"].includes(latest.success.status)) return;
          // An accepted send can still fail as a provider maintenance run.
          const fresh: KanbanCard = {
            ...card,
            workThreadId: null,
            wakeNote: withFreshNote(card.wakeNote),
            // Preserve queue age and any parked wait during recovery.
            updatedAt: at,
          };
          yield* logEvent(fresh, system, "moved", {
            fromStage: card.stage,
            toStage: "todo",
            body: `${FRESH_START}: compaction failed`,
          });
          destination.expectedCard = yield* saveDispatchCard(fresh);
          yield* kick;
          return;
        }
      }
      if (view) {
        threadId = existing;
      }
      if (!view && dispatch.role === "work") {
        // Its old thread is gone, so a block by that thread's work counts again.
        const byId = new Map((yield* pass.read).map((c) => [c.id as string, c]));
        if (Rules.isBlocked(card, byId, null)) {
          destination.expectedCard = yield* saveDispatchCard({
            ...card,
            workThreadId: null,
            updatedAt: at,
          });
          return;
        }
      }
    }
    const synced = dispatch.role === "review" && !adoptRunning ? yield* syncPrs(card) : card;
    destination.expectedCard = synced;
    let text: string;
    if (dispatch.role === "work") {
      const comments =
        threadId === null && synced.workThreadId !== null
          ? (yield* store.cardEvents(card.id)).flatMap((event) =>
              event.body &&
              (event.kind === "comment" ||
                (event.kind === "moved" && event.toStage === "needs_review"))
                ? [event.body]
                : [],
            )
          : [];
      text = threadId ? Briefs.wakeText(synced) : Briefs.workBrief(board, synced, goal, comments);
    } else {
      const events = yield* store.cardEvents(card.id);
      const findings = events
        .filter(
          (event) =>
            event.kind === "review" &&
            event.toStage === "todo" &&
            event.body &&
            event.body !== "clear",
        )
        .map((event) => event.body ?? "");
      const latestMove = events.findLast((event) => event.kind === "moved");
      text = Briefs.reviewBrief(
        board,
        synced,
        goal,
        Rules.chainFor(board, synced),
        findings,
        threadId === null,
        latestMove?.body === Retries.REVIEW_GATE_REQUEUED_EVENT ? latestMove.head : null,
      );
    }
    const reused = threadId;
    if (reused !== null) {
      // A release saved during the thread reads must settle before a later attempt.
      yield* refusePendingStop(reused);
    }
    if (threadId === null) {
      destination.newThread = true;
      const title =
        dispatch.role === "work"
          ? `#${card.number} ${card.title}`
          : `#${card.number} review: ${card.title}`;
      threadId = yield* threads.launch({
        key: `${card.id}:${dispatch.role}:${at}`,
        projectId,
        title,
        model: dispatch.model,
        text,
      });
      yield* linkThread(
        {
          threadId,
          boardId: board.id,
          cardId: card.id,
          role: dispatch.role,
          purpose: null,
          discussionId: null,
          model: dispatch.model,
          startedAt: at,
          endedAt: null,
          paused: null,
        },
        title,
      );
      yield* logEvent(card, system, "thread", { body: `${dispatch.role} thread ${threadId}` });
      if (dispatch.freshReason !== undefined)
        yield* logEvent(card, system, "thread", { body: dispatch.freshReason });
    }
    const priorHold = (yield* Ref.get(holds)).get(threadId);
    if (dispatch.role === "work") {
      yield* store.addThreadCard(threadId, card.id, at);
    }
    const to: KanbanStage = dispatch.role === "work" ? "working" : "in_review";
    const next: KanbanCard = {
      ...(yield* moveWait(synced, to, at, system)),
      // A weighted card runs on the model that had room; its thread keeps it.
      model: dispatch.role === "work" ? dispatch.model : synced.model,
      stage: to,
      activeThreadId: threadId,
      activeRole: dispatch.role,
      activePool: dispatch.pool,
      workThreadId: dispatch.role === "work" ? threadId : synced.workThreadId,
      reviewThreadId: dispatch.role === "review" ? threadId : synced.reviewThreadId,
      wakeNote: dispatch.role === "work" ? null : synced.wakeNote,
      nudgedAt: null,
      movedAt: at,
      updatedAt: at,
    };
    const pending =
      reused !== null && !adoptRunning
        ? {
            threadId: reused,
            touched: (inFlightSends.get(reused) ?? 0) > 0 || (agentCalls.get(reused) ?? 0) > 0,
            accepted: false,
            revoked: false,
            rollingBack: false,
          }
        : null;
    const key = pending !== null ? assignmentKey : null;
    const releasePriorHold = Ref.update(holds, (all) => {
      // Release only the hold captured before the claim; a concurrent replacement still owns its slot.
      if (reused === null || priorHold === undefined || all.get(reused) !== priorHold) return all;
      const next = new Map(all);
      next.delete(reused);
      return next;
    }).pipe(
      Effect.andThen(reused === null ? Effect.void : syncSlot(board.id, reused, "join", card.id)),
    );
    let cleaned = false;
    let failureTag = "interrupted";
    const cleanup = Effect.suspend(() => {
      if (cleaned || reused === null || key === null || pending === null) return Effect.void;
      cleaned = true;
      return locks.unlock.pipe(
        Effect.andThen(
          locks.fresh(
            locks.board(
              board.id,
              Effect.gen(function* () {
                const current = yield* cardOf(card.id);
                const owns =
                  current.activeThreadId === reused &&
                  current.activeRole === dispatch.role &&
                  current.stage === to &&
                  current.movedAt === at;
                // A live consumer already owns this claim independently of the assignment send.
                const accepted =
                  owns && !pending.revoked && pending.accepted && (yield* destination.valid);
                if (owns && !pending.revoked && (pending.touched || accepted)) {
                  assignmentWakeRetries.delete(card.id);
                  yield* releasePriorHold;
                  return false;
                }
                if (pending.accepted) {
                  const heldAt = yield* nowMillis;
                  // Withdrawal steers the preserved turn; retain its slot until it ends.
                  yield* Ref.update(holds, (all) =>
                    new Map(all).set(reused, {
                      boardId: board.id,
                      pool: dispatch.pool,
                      at: heldAt,
                      ...all.get(reused),
                      preservedTurn: true,
                    }),
                  );
                  yield* syncSlot(board.id, reused, "hold", card.id);
                }
                if (owns && !pending.revoked) {
                  // Admission and this decision are synchronous: no new consumer may see the claim during the save.
                  pending.rollingBack = true;
                  // A changed assignment still revokes its old brief; that is not a failed delivery.
                  const superseded = pending.accepted;
                  const previous = assignmentWakeRetries.get(card.id);
                  const attempts = (previous?.movedAt === card.movedAt ? previous.attempts : 0) + 1;
                  const failedAt = yield* nowMillis;
                  const reason = superseded
                    ? "Assignment changed after wake was accepted"
                    : `Assignment wake did not complete: ${failureTag} (attempt ${attempts})`;
                  const restored: KanbanCard = {
                    ...current,
                    // An undelivered hand-off must not consume the old wait's requested wake.
                    ...(current.wait === undefined && card.wait !== undefined
                      ? { wait: card.wait }
                      : {}),
                    stage: card.stage,
                    activeThreadId: card.activeThreadId,
                    activeRole: card.activeRole,
                    activePool: card.activePool,
                    wakeNote: current.wakeNote === next.wakeNote ? card.wakeNote : current.wakeNote,
                    nudgedAt: current.nudgedAt === next.nudgedAt ? card.nudgedAt : current.nudgedAt,
                    movedAt: card.movedAt,
                    ...(!superseded && attempts >= 5
                      ? {
                          stalled: {
                            reason: `${reason} (${attempts} consecutive failures)`,
                            by: system,
                            at: DateTime.formatIso(DateTime.makeUnsafe(failedAt)),
                          },
                        }
                      : {}),
                    updatedAt: yield* nowIso,
                  };
                  yield* logEvent(restored, system, "moved", {
                    fromStage: current.stage,
                    toStage: restored.stage,
                    body: reason,
                    assignmentWake: { threadId: reused, key },
                    // No consumer owns this claim; interrupted rollback cannot wait on thread I/O.
                    undoAssignment: true,
                  });
                  destination.expectedCard = yield* saveDispatchCard(restored);
                  if (restored.stalled !== null)
                    yield* logEvent(restored, system, "flagged", { body: restored.stalled.reason });
                  if (!superseded) {
                    const backoffMs = Math.min(600_000, 30_000 * 2 ** (attempts - 1));
                    assignmentWakeRetries.set(card.id, {
                      movedAt: restored.movedAt,
                      attempts,
                      retryAt: failedAt + backoffMs,
                    });
                    yield* Effect.logWarning("kanban.assignment_wake_failed", {
                      cardId: card.id,
                      threadId: reused,
                      wakeKey: key,
                      attempt: attempts,
                      runStateAtSend,
                      errorClass: failureTag,
                      rollbackCause: "not_touched",
                      backoffMs,
                    });
                    yield* recordAnalytics({
                      kind: "kanban.assignment_wake_failed",
                      boardId: board.id,
                      cardId: card.id,
                      threadId: reused,
                      outcome: failureTag === "interrupted" ? "interrupted" : "error",
                      props: {
                        key,
                        count: attempts,
                        round: attempts,
                        phase: runStateAtSend,
                        operation: dispatch.role,
                        errorClass: failureTag,
                        errorTag: failureTag,
                        reasonClass: "not_touched",
                        ageMs: backoffMs,
                      },
                    });
                  }
                }
                return true;
              }),
            ),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban assignment rollback failed", {
            cardId: card.id,
            errorTag: analyticsErrorTag(cause),
          }).pipe(Effect.as(!pending.accepted && !pending.touched)),
        ),
        Effect.flatMap((withdraw) =>
          withdraw
            ? touching(
                reused,
                threadIo
                  .withdraw({
                    threadId: reused,
                    key,
                    retryWithdrawn: true,
                    text: `The board changed while assigning card #${card.number}. Re-read card_get before acting on that assignment; keep working on your other cards.`,
                  })
                  .pipe(Effect.asVoid),
              )
            : Effect.void,
        ),
        Effect.ensuring(
          Effect.sync(() => {
            pendingWakes.delete(key);
            delivering.delete(card.id);
          }),
        ),
      );
    });
    if (pending !== null && key !== null) {
      // Register before saving: cancellation must not leave a claim without its wake.
      yield* locks.launched(key, cleanup);
      pendingWakes.set(key, pending.threadId);
      delivering.set(card.id, pending);
    }
    yield* Effect.gen(function* () {
      yield* logEvent(next, system, "moved", { fromStage: card.stage, toStage: to });
      destination.expectedCard = yield* saveDispatchCard(next, dispatch.joins ? "join" : "start");
      if (dispatch.role === "review" && card.reviewThreadId !== threadId) {
        yield* endReviewLink(card.reviewThreadId, at);
      }
      // The saved claim replaces the pending reservation, including its batch count.
      starting.delete(`${board.id}:${card.id}`);
      if (reused !== null) {
        const link = yield* store.threadLink(reused);
        if (
          link &&
          (!modelSelectionsEqual(link.model ?? board.evaluatorModel, dispatch.model) ||
            (dispatch.role === "review" && link.endedAt !== null))
        ) {
          yield* store.putThreadLink({
            ...link,
            model: dispatch.model,
            endedAt: dispatch.role === "review" ? null : link.endedAt,
          });
        }
      }
      yield* locks.attached(threadId);
      if (adoptRunning) {
        assignmentWakeRetries.delete(card.id);
        yield* dropHold(threadId, "join");
        return;
      }
      if (reused !== null && key !== null) {
        yield* sendThread(
          {
            threadId: reused,
            text,
            model: dispatch.model,
            key,
            isStale: () => pending?.revoked === true,
            retryWithdrawn: true,
            ...(rollbackAt === undefined ? {} : { withdrawalBefore: rollbackAt }),
            withdrawalText: `The board changed while assigning card #${card.number}. Re-read card_get before acting on that assignment; keep working on your other cards.`,
            onCommitted: () => {
              if (pending !== null) pending.accepted = true;
              assignmentWakeRetries.delete(card.id);
            },
          },
          undefined,
          undefined,
          true,
        ).pipe(
          // Assignment withdrawal must use the same key as its send.
          Effect.provideService(ownerDeliveryKey, undefined),
        );
        // An owner stop can revoke delivery before its card write returns.
        if (pending?.revoked) {
          yield* cleanup;
          return;
        }
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* locks.attached(key);
            pendingWakes.delete(key);
            delivering.delete(card.id);
            yield* releasePriorHold;
          }),
        );
      }
    }).pipe(
      Effect.onError((cause) => {
        const failure = cause.reasons.find((reason) => reason._tag === "Fail");
        const error = failure?._tag === "Fail" ? failure.error : undefined;
        failureTag = cause.reasons.some(
          (reason) =>
            reason._tag === "Die" && reason.defect instanceof BoardLocks.BoardStateChanged,
        )
          ? "board_state_changed"
          : Cause.isTimeoutError(error)
            ? "timeout"
            : isKanbanThreadError(error)
              ? error.rejected
                ? "send_rejected"
                : /stale/i.test(error.detail)
                  ? "stale_wake"
                  : /projection/i.test(error.detail)
                    ? "projection_unavailable"
                    : /busy/i.test(error.detail)
                      ? "thread_busy"
                      : /steer/i.test(error.detail)
                        ? "steer_failed"
                        : "thread_io_failed"
              : failure !== undefined
                ? "send_failed"
                : cause.reasons.some((reason) => reason._tag === "Die")
                  ? "defect"
                  : "interrupted";
        return cleanup;
      }),
    );
    poolWaits.delete(card.id);
    const dispatchedAt = yield* nowMillis;
    yield* recordAnalytics({
      kind: "kanban.dispatch",
      boardId: board.id,
      cardId: card.id,
      threadId,
      durationMs: Math.max(0, dispatchedAt - Date.parse(card.movedAt)),
      props: { poolKey: dispatch.pool, phase: dispatch.role, span: "KanbanService.startCard" },
    });
  });

  const recordPoolWaits = Effect.fnUntraced(function* (
    board: KanbanBoard,
    cards: ReadonlyArray<KanbanCard>,
    pools: ReadonlyArray<KanbanPool>,
    holds: ReadonlyMap<string, string>,
    attempted: ReadonlySet<string>,
    now: number,
    reviews: ReadonlyMap<string, Rules.ReviewEvidence>,
    homes: ReadonlyMap<string, KanbanCard | null>,
  ) {
    if (Option.isNone(analytics)) return;
    // Reuse the dispatcher's blockers, retry and pause gates, relaxing capacity alone.
    const capacity = cards.length + holds.size + 1;
    const expanded = pools.map((pool) => ({ ...pool, slots: capacity }));
    for (const card of cards) {
      const models =
        card.stage === "needs_review"
          ? [Rules.nextModel(board, card)].filter((model) => model !== null)
          : kanbanCardModels(card).map((entry) => entry.model);
      for (const model of models)
        if (Rules.poolFor(expanded, model) === undefined)
          expanded.push({ key: Rules.poolKey(model), model, slots: capacity });
    }
    const waiting = Rules.planDispatch(
      board,
      cards,
      expanded,
      holds,
      undefined,
      now,
      attempted,
      reviews,
      homes,
      assignmentWakeRetries,
    );
    const waitingIds = new Set(waiting.map((entry) => entry.cardId as string));
    for (const [id, entry] of poolWaits)
      if (entry.boardId === board.id && !waitingIds.has(id)) poolWaits.delete(id);
    const hour = Math.floor(now / 3_600_000);
    if (poolHours.get(board.id) !== hour) {
      const usage = Rules.poolThreads(cards, holds);
      for (const pool of yield* store.pools(board.id))
        yield* recordAnalytics({
          kind: "kanban.pool_usage",
          boardId: board.id,
          props: {
            poolKey: pool.key,
            used: usage.get(pool.key)?.size ?? 0,
            slots: pool.slots,
            waiting: waiting.filter((entry) => entry.pool === pool.key).length,
          },
        });
      const ts = DateTime.formatIso(DateTime.makeUnsafe(now));
      // A common timestamp makes the empty snapshot and its rows unambiguous on read.
      const openCards = yield* store.openCards(board.id);
      yield* recordAnalytics({
        kind: "kanban.ask_snapshot",
        boardId: board.id,
        ts,
        props: {
          count: openCards.reduce(
            (sum, card) => sum + card.asks.filter((ask) => ask.closedAt === null).length,
            0,
          ),
        },
      });
      for (const card of openCards)
        for (const ask of card.asks)
          if (ask.closedAt === null)
            yield* recordAnalytics({
              kind: "kanban.ask_pending",
              boardId: board.id,
              cardId: card.id,
              ts,
              props: {
                key: BoardAnalytics.label(ask.id),
                kind: BoardAnalytics.label(ask.kind ?? "question"),
                blocking: ask.blocking,
                createdAt: ask.at,
              },
            });
      poolHours.set(board.id, hour);
    }
    const byId = new Map(cards.map((card) => [card.id, card]));
    for (const entry of waiting) {
      const card = byId.get(entry.cardId)!;
      const prior = poolWaits.get(card.id);
      if (prior?.pool === entry.pool && prior.movedAt === card.movedAt && now - prior.at < 60_000)
        continue;
      poolWaits.set(card.id, {
        boardId: board.id,
        pool: entry.pool,
        movedAt: card.movedAt,
        at: now,
      });
      const pool = pools.find((pool) => pool.key === entry.pool);
      yield* recordAnalytics({
        kind: "kanban.waiting_for_pool",
        boardId: board.id,
        cardId: card.id,
        durationMs: Math.max(0, now - Date.parse(card.movedAt)),
        props: {
          poolKey: entry.pool,
          phase: entry.role,
          reason: pool === undefined ? "missing_pool" : pool.slots === 0 ? "no_slots" : "capacity",
        },
      });
    }
  });

  // Hydrate only new queue entries; the event keeps the backoff across a server restart.
  const loadAssignmentRetries = Effect.fn("KanbanService.loadAssignmentRetries")(function* (
    boardId: KanbanBoardId,
    cards: ReadonlyArray<KanbanCard>,
  ) {
    const queued = cards.filter(
      (card) =>
        card.activeThreadId === null &&
        (card.stage === "todo"
          ? card.workThreadId !== null
          : card.stage === "needs_review" && card.reviewThreadId !== null) &&
        card.stalled === null &&
        card.settledAt === null &&
        assignmentWakeRetries.get(card.id)?.movedAt !== card.movedAt,
    );
    const events = yield* store.lastTransitions(
      boardId,
      queued.map((card) => card.id),
      Number.MAX_SAFE_INTEGER,
    );
    const byCard = new Map(events.map((event) => [event.cardId, event]));
    for (const card of queued) {
      let event = byCard.get(card.id);
      // Same-stage manual wakes preserve queue age, so movedAt alone cannot reset a retry.
      if (event?.body?.startsWith("Assignment wake did not complete:"))
        event = (yield* store.cardEvents(card.id)).findLast((event) => event.kind === "moved");
      const match = event?.body?.match(
        /^Assignment wake did not complete: [a-z_]+ \(attempt ([1-5])\)$/,
      );
      const attempts =
        match &&
        event?.actor._tag === "system" &&
        event.actor.component === "dispatcher" &&
        Date.parse(event.at) >= Date.parse(card.movedAt)
          ? Number(match[1])
          : 0;
      assignmentWakeRetries.set(card.id, {
        movedAt: card.movedAt,
        attempts,
        retryAt:
          attempts === 0
            ? 0
            : Date.parse(event!.at) + Math.min(600_000, 30_000 * 2 ** (attempts - 1)),
      });
    }
  });

  const dispatchUnlocked = Effect.fn("KanbanService.dispatchUnlocked")(function* (
    boardId?: string,
    stoppedCards: ReadonlySet<string> = new Set(),
  ) {
    if (boardId === undefined) yield* Ref.set(kickPending, false);
    const random = yield* Random.Random;
    const pick = (count: number) => Math.floor(random.nextDoubleUnsafe() * count);
    yield* seedDown;
    const results = yield* locks.outside(
      Effect.forEach(
        boardId === undefined
          ? yield* store.boards
          : [yield* store.board(KanbanBoardId.make(boardId))].filter((board) => board !== null),
        (candidate) =>
          serialEach(
            dispatching,
            candidate.id,
            Effect.gen(function* () {
              const changed = yield* rawStore.watchCardWrites(candidate.id);
              const pass = dispatchCardPass(candidate.id, changed);
              const attempted = new Set(stoppedCards);
              while (true) {
                // Replan after each attempt so a failed head leaves room for lower cards.
                const planned = yield* TickTimings.measure(
                  "dependency_checks",
                  locks.run(
                    Effect.gen(function* () {
                      const board = yield* boardOf(candidate.id);
                      if (board.archivedAt !== null || settingUp.has(board.id)) return null;
                      const cards = yield* upgradeFindings(yield* pass.read);
                      yield* loadAssignmentRetries(board.id, cards);
                      const depths = yield* tickQueueDepths;
                      if (depths !== undefined) {
                        depths.todo = cards.filter(
                          (card) => card.stage === "todo" && card.settledAt === null,
                        ).length;
                        depths.needs_review = cards.filter(
                          (card) => card.stage === "needs_review" && card.settledAt === null,
                        ).length;
                      }
                      // Old releases could leave a worker instruction after its last
                      // work subtask closed. Repair that persisted note without sending it.
                      for (let i = 0; i < cards.length; i++) {
                        const card = cards[i]!;
                        if (
                          card.stage !== "todo" ||
                          card.wakeNote === null ||
                          card.subtasks.length === 0
                        )
                          continue;
                        const note = Subtasks.pendingWakeNote(card);
                        if (note === card.wakeNote) continue;
                        const repaired = { ...card, wakeNote: note };
                        yield* saveCard(repaired);
                        cards[i] = repaired;
                      }
                      const reviews = new Map<string, Rules.ReviewEvidence>();
                      for (let i = 0; i < cards.length; i++) {
                        const card = cards[i]!;
                        if (
                          !kanbanReviewAlreadyDone(card) ||
                          card.activeThreadId !== null ||
                          card.settledAt !== null ||
                          card.stalled !== null ||
                          card.priority === KANBAN_BACKLOG ||
                          board.setup?.status === "running" ||
                          (board.pause !== null && !board.pause.keep.includes(card.id)) ||
                          kanbanWaiting(card) ||
                          kanbanDeciding(card, yield* nowMillis)
                        )
                          continue;
                        const synced = yield* syncPrs(card);
                        cards[i] = synced;
                        const evidence = yield* reviewEvidence(board, synced);
                        reviews.set(card.id, evidence);
                        if (!kanbanReviewAlreadyDone(synced, evidence)) continue;
                        cards[i] = yield* placeFinishedReview(
                          board,
                          synced,
                          { _tag: "system", component: "dispatcher" },
                          Subtasks.subtaskIds(
                            card.subtasks.filter((s) => s.owner === "review" && s.state !== "open"),
                          ),
                        );
                      }
                      const pools = Rules.maskDownPools(
                        yield* store.pools(board.id),
                        new Set((yield* Ref.get(down)).keys()),
                      );
                      const held = yield* boardHolds(board.id);
                      const now = yield* nowMillis;
                      const homes = yield* workThreadHomes(cards);
                      const dispatch = Rules.planDispatch(
                        board,
                        cards,
                        pools,
                        held,
                        pick,
                        now,
                        attempted,
                        reviews,
                        homes,
                        assignmentWakeRetries,
                      )[0];
                      if (!dispatch) {
                        yield* TickTimings.measure(
                          "pool_accounting",
                          recordPoolWaits(
                            board,
                            cards,
                            pools,
                            held,
                            attempted,
                            now,
                            reviews,
                            homes,
                          ),
                        );
                        return null;
                      }
                      const card = cards.find((card) => card.id === dispatch.cardId);
                      return card ? { boardId: board.id, dispatch, card } : null;
                    }),
                  ),
                );
                if (!planned) break;
                const { boardId, dispatch, card } = planned;
                attempted.add(dispatch.cardId);
                const key = `${boardId}:${dispatch.cardId}`;
                const destination = {
                  valid: Effect.succeed(true),
                  expectedCard: card,
                  newThread:
                    dispatch.fresh ||
                    (dispatch.role === "work" ? card.workThreadId : card.reviewThreadId) === null,
                };
                // Preparation reads may wait on the background reader. Take the
                // card lock only after they finish; scopeDispatch confirms them again.
                const board = yield* boardOf(boardId);
                const pool = (yield* store.pools(board.id)).find(
                  (entry) => entry.key === dispatch.pool,
                );
                starting.set(key, {
                  cardId: card.id,
                  pool: dispatch.pool,
                  threadId: dispatch.joins ? card.workThreadId : null,
                  wakeThreadId: dispatch.fresh
                    ? null
                    : dispatch.role === "work"
                      ? card.workThreadId
                      : card.reviewThreadId,
                });
                // The scope belongs to this start, not the planning pass or its siblings.
                const continuePass = yield* locks
                  .run(
                    Effect.gen(function* () {
                      const wakeThreadId = destination.newThread
                        ? null
                        : dispatch.role === "work"
                          ? card.workThreadId
                          : card.reviewThreadId;
                      const sourceThreadId =
                        dispatch.freshReason === undefined ? null : card.workThreadId;
                      const stopThreadId = sourceThreadId ?? wakeThreadId;
                      const assignmentState = ({
                        links,
                        updatedAt: _updatedAt,
                        discussionId: _discussionId,
                        analyticsStageEnteredAt: _analyticsStageEnteredAt,
                        ...card
                      }: KanbanCard) => ({
                        ...card,
                        links: links.map(
                          ({ state: _state, checkedAt: _checkedAt, ...link }) => link,
                        ),
                      });
                      const boardAssignmentState = (row: KanbanBoard) => ({
                        archivedAt: row.archivedAt,
                        held: row.pause !== null && !row.pause.keep.includes(card.id),
                        settingUp: row.setup?.status === "running",
                        projectId: card.projectId ?? row.defaultProjectId,
                        chain: dispatch.role === "review" ? Rules.chainFor(row, card) : null,
                        reviewModel: dispatch.role === "review" ? Rules.nextModel(row, card) : null,
                        instructions:
                          dispatch.role === "review"
                            ? row.instructions.reviewerRouting.trim()
                            : destination.newThread
                              ? row.instructions.escalation.trim()
                              : null,
                      });
                      destination.valid = Effect.gen(function* () {
                        if (
                          sourceThreadId !== null &&
                          (yield* Effect.result(refusePendingStop(sourceThreadId)))._tag ===
                            "Failure"
                        )
                          return false;
                        const currentBoard = (yield* rawStore.boards).find(
                          (row) => row.id === board.id,
                        );
                        const currentCard = yield* rawStore.card(card.id);
                        if (
                          currentCard === null ||
                          !NodeUtil.isDeepStrictEqual(
                            assignmentState(currentCard),
                            assignmentState(destination.expectedCard),
                          )
                        )
                          return false;
                        if (
                          !currentBoard ||
                          currentBoard.archivedAt !== null ||
                          settingUp.has(board.id) ||
                          currentBoard.setup?.status === "running" ||
                          (currentBoard.pause && !currentBoard.pause.keep.includes(card.id))
                        )
                          return false;
                        if (
                          !NodeUtil.isDeepStrictEqual(
                            boardAssignmentState(currentBoard),
                            boardAssignmentState(board),
                          )
                        )
                          return false;
                        if (
                          dispatch.role === "review" &&
                          !modelSelectionsEqual(Rules.nextModel(currentBoard, card), dispatch.model)
                        )
                          return false;
                        const cards = yield* pass.read;
                        const pools = Rules.maskDownPools(
                          yield* rawStore.pools(board.id),
                          new Set((yield* Ref.get(down)).keys()),
                        );
                        const currentPool = pools.find((entry) => entry.key === dispatch.pool);
                        if (
                          pool === undefined ||
                          pool.slots <= 0 ||
                          currentPool === undefined ||
                          currentPool.slots < pool.slots ||
                          !NodeUtil.isDeepStrictEqual(currentPool.model, pool.model)
                        )
                          return false;
                        if (
                          (Rules.poolThreads(cards, yield* boardHolds(board.id, key)).get(
                            dispatch.pool,
                          )?.size ?? 0) > currentPool.slots
                        )
                          return false;
                        if (
                          dispatch.role === "work" &&
                          !destination.newThread &&
                          currentBoard.pause &&
                          currentCard.workThreadId !== null &&
                          cards.some(
                            (other) =>
                              other.activeThreadId === currentCard.workThreadId &&
                              !currentBoard.pause!.keep.includes(other.id),
                          )
                        )
                          return false;
                        // Once the claim commits, it owns its slot. Re-planning it as
                        // unassigned can reject the accepted wake against its own hold.
                        // Card/board/model/pool and stop fences above still revoke it.
                        if (
                          currentCard.activeThreadId !== null &&
                          currentCard.activeThreadId === destination.expectedCard.activeThreadId &&
                          currentCard.activeRole === dispatch.role &&
                          currentCard.stage === (dispatch.role === "work" ? "working" : "in_review")
                        )
                          return (
                            dispatch.role === "review" ||
                            !Rules.isBlocked(
                              currentCard,
                              new Map(cards.map((row) => [row.id as string, row])),
                              currentCard.activeThreadId,
                            )
                          );
                        // Keep siblings for blockers and capacity without planning their starts.
                        const selected = {
                          ...card,
                          workThreadId:
                            destination.newThread && dispatch.role === "work"
                              ? null
                              : card.workThreadId,
                        };
                        const eligible = Rules.planDispatch(
                          currentBoard,
                          cards.map((entry) =>
                            entry.id === card.id
                              ? selected
                              : { ...entry, settledAt: entry.settledAt ?? card.updatedAt },
                          ),
                          pools.filter((pool) => pool.key === dispatch.pool),
                          yield* boardHolds(board.id, key),
                          undefined,
                          yield* nowMillis,
                          undefined,
                          kanbanReviewAlreadyDone(selected)
                            ? new Map([
                                [selected.id, yield* reviewEvidence(currentBoard, selected)],
                              ])
                            : undefined,
                          // The home can move after pass.read; validate persisted rows.
                          yield* workThreadHomes(cards, true),
                          assignmentWakeRetries,
                        ).find((entry) => entry.cardId === card.id);
                        return (
                          eligible !== undefined &&
                          eligible.role === dispatch.role &&
                          modelSelectionsEqual(eligible.model, dispatch.model) &&
                          (destination.newThread || !eligible.fresh)
                        );
                      }).pipe(Effect.orDie);
                      yield* locks.scopeDispatch(
                        board.id,
                        [
                          `card:${card.id}`,
                          ...(stopThreadId === null ? [] : [interruptResource(stopThreadId)]),
                        ],
                        destination.valid,
                      );
                      yield* TickTimings.measure(
                        "start_card",
                        startCard(boardId, dispatch, card, destination, pass),
                      );
                    }),
                    card.id,
                  )
                  .pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        starting.delete(key);
                      }),
                    ),
                    Effect.tapError((error) =>
                      error._tag !== "KanbanThreadError" || error.retryable === true
                        ? Effect.void
                        : locks.fresh(
                            locks.run(
                              Effect.gen(function* () {
                                const current = yield* cardOf(card.id);
                                // Committed/ambiguous sends still own the card. Rollback changes
                                // timestamps, so compare assignment inputs before holding it.
                                if (
                                  current.activeThreadId !== null ||
                                  (assignmentWakeRetries.get(card.id)?.movedAt ===
                                    current.movedAt &&
                                    (assignmentWakeRetries.get(card.id)?.attempts ?? 0) > 0) ||
                                  !NodeUtil.isDeepStrictEqual(
                                    assignmentState(current),
                                    assignmentState(card),
                                  )
                                )
                                  return;
                                const at = yield* nowIso;
                                const actor: KanbanActor = {
                                  _tag: "system",
                                  component: "dispatcher",
                                };
                                const reason = `Thread start failed: ${error.detail}. Clear this flag after checking the provider.`;
                                const held = {
                                  ...current,
                                  stalled: { reason, by: actor, at },
                                  updatedAt: at,
                                };
                                yield* logEvent(held, actor, "flagged", { body: reason });
                                yield* saveCard(held);
                                yield* recordAnalytics({
                                  kind: "kanban.worker_failed",
                                  boardId: card.boardId,
                                  cardId: card.id,
                                  props: {
                                    poolKey: dispatch.pool,
                                    model: BoardAnalytics.label(dispatch.model.model),
                                    errorClass: BoardAnalytics.reasonClass(error.detail),
                                  },
                                });
                              }),
                              card.id,
                            ),
                          ),
                    ),
                    Effect.as(true),
                    Effect.catchCause((cause) =>
                      Effect.logWarning("kanban dispatch failed", {
                        cardId: dispatch.cardId,
                        errorTag: analyticsErrorTag(cause),
                      }).pipe(
                        Effect.andThen(
                          cause.reasons.some((reason) =>
                            reason._tag === "Fail"
                              ? Schema.is(KanbanStoreError)(reason.error)
                              : reason._tag === "Die" && Schema.is(KanbanStoreError)(reason.defect),
                          )
                            ? Effect.failCause(cause)
                            : Effect.succeed(
                                !cause.reasons.some(
                                  (reason) =>
                                    reason._tag === "Die" &&
                                    reason.defect instanceof BoardLocks.DispatchReadBudgetExceeded,
                                ),
                              ),
                        ),
                      ),
                    ),
                  );
                // The reader may still be stalled; don't immediately retake the planning gate.
                if (!continuePass) break;
              }
            }).pipe(Effect.scoped),
            false,
          ).pipe(
            Effect.tapCause((cause) =>
              Effect.logWarning("kanban board dispatch failed", {
                boardId: candidate.id,
                errorTag: analyticsErrorTag(cause),
              }),
            ),
            Effect.exit,
          ),
        { concurrency: 8, discard: false },
      ),
    );
    for (const result of results)
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
  });

  /** The outage key of the model a board thread runs on: per model, whatever its level. */
  const linkKey = (link: KanbanThreadLink, board: KanbanBoard) =>
    Rules.modelKey(link.model ?? board.evaluatorModel);

  /**
   * Every paused thread link on every live board, ended or not: a reused evaluator is
   * ended but still reachable. `open: false` already returns every link (open ones too),
   * so one scan covers both; a thread id seen twice would otherwise wake twice.
   */
  const pausedLinks = Effect.gen(function* () {
    const found: Array<{ readonly link: KanbanThreadLink; readonly board: KanbanBoard }> = [];
    const seen = new Set<string>();
    for (const board of yield* store.boards) {
      if (board.archivedAt !== null) continue;
      for (const link of yield* store.threadLinks({ boardId: board.id, open: false })) {
        if (link.paused === null || seen.has(link.threadId)) continue;
        seen.add(link.threadId);
        found.push({ link, board });
      }
    }
    return found;
  });

  /**
   * After a restart `down` is empty, so the first dispatch rebuilds it from the
   * persisted pauses before planning: a known-down model takes no new card while
   * its first probe is still to come. Each key is probed right away. Callers hold the lock.
   */
  const seedDown = Effect.gen(function* () {
    if (yield* Ref.get(scanned)) return;
    const now = yield* nowMillis;
    const keys = new Set<string>();
    const recovered = yield* Ref.get(recoveredThreads);
    for (const { link, board } of yield* pausedLinks) {
      if (!recovered.has(link.threadId)) keys.add(linkKey(link, board));
    }
    yield* Ref.update(down, (map) => {
      const next = new Map(map);
      for (const key of keys) {
        if (!next.has(key))
          next.set(key, {
            delayMs: Rules.PROBE_FIRST_MS,
            nextAt: now,
            announced: new Set(),
            recovered: new Set(),
          });
      }
      return next;
    });
    // Set last: a failed read is retried on the next dispatch.
    yield* Ref.set(scanned, true);
  });

  /** Pauses on the failed run's model, keeping its epoch on repeat reports and reopening evaluators. */
  const pauseThread = Effect.fn("KanbanService.pauseThread")(function* (
    link: KanbanThreadLink,
    model: ModelSelection,
    message: string,
    runId: string | null,
  ) {
    yield* Ref.update(recoveredThreads, (map) => {
      const next = new Map(map);
      next.delete(link.threadId);
      return next;
    });
    const at = yield* nowIso;
    const now = yield* nowMillis;
    const sameRun = link.paused !== null && link.paused.runId === runId;
    yield* store.putThreadLink({
      ...link,
      model,
      endedAt: link.role === "evaluator" ? null : link.endedAt,
      paused: { at: sameRun ? link.paused!.at : at, message, runId },
    });
    const key = Rules.modelKey(model);
    if (runId === null || link.paused?.runId !== runId) {
      yield* Ref.update(outageGeneration, (map) => new Map(map).set(key, (map.get(key) ?? 0) + 1));
    }
    yield* Ref.update(down, (map) =>
      map.has(key)
        ? map
        : new Map(map).set(key, {
            delayMs: Rules.PROBE_FIRST_MS,
            nextAt: now + Rules.PROBE_FIRST_MS,
            announced: new Set(),
            recovered: new Set(),
          }),
    );
  });

  const OUTAGE_TITLE = "Provider outages";
  const outageActor: KanbanActor = { _tag: "system", component: "provider-watch" };

  /**
   * Posts to the "Provider outages" discussion of each board with its supplied count.
   * Returns the boards whose post landed. A failed post
   * is logged and left out, so the caller retries it next time; it never fails the probe.
   */
  const alertBoards = Effect.fn("KanbanService.alertBoards")(function* (
    counts: ReadonlyMap<KanbanBoard["id"], number>,
    text: (count: number) => string,
  ) {
    const delivered = new Set<KanbanBoard["id"]>();
    for (const [boardId, count] of counts) {
      const posted = yield* Effect.gen(function* () {
        const existing = (yield* store.discussions(boardId)).find(
          (discussion) =>
            discussion.cardId === null &&
            discussion.archivedAt === null &&
            discussion.title === OUTAGE_TITLE,
        );
        const discussion =
          existing ?? (yield* newDiscussion(boardId, OUTAGE_TITLE, null, outageActor));
        yield* postUnlocked(discussion.id, outageActor, [{ _tag: "md", text: text(count) }], false);
      }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban outage alert failed", { boardId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (posted) delivered.add(boardId);
    }
    return delivered;
  });

  /**
   * Wakes every thread paused on `key`. A link is cleared only after its wake is
   * accepted: a failed send keeps the pause and the down key so a later probe retries.
   * Callers hold the lock.
   */
  const resumeKey = Effect.fn("KanbanService.resumeKey")(function* (key: string) {
    const generation = (yield* Ref.get(outageGeneration)).get(key) ?? 0;
    let failed = false;
    const woken = new Map<KanbanBoard["id"], number>();
    for (const { link, board } of yield* pausedLinks) {
      if (link.paused === null || linkKey(link, board) !== key) continue;
      const pausedRun =
        link.role === "evaluator" && link.paused.runId !== null
          ? yield* threads.compactRun(link.threadId, link.paused.runId)
          : null;
      const recovery = postRecoveryIdentity(pausedRun?.messageId ?? "");
      if (
        pausedRun?.messageId?.startsWith("kanban:post-recovery:") &&
        (recovery === null ||
          !(yield* postRecoveryPending(store, recovery.discussionId, recovery.seq)))
      ) {
        yield* store.putThreadLink({ ...link, paused: null });
        yield* Ref.update(evaluatorFailures, (all) => {
          const next = new Map(all);
          next.delete(link.threadId);
          return next;
        });
        continue;
      }
      // Only a thread that still owns its work and isn't already running again.
      let live = link.role === "evaluator";
      if (link.role === "work")
        live = (yield* upgradeFindings(yield* store.cardsByThread(link.threadId))).some(
          kanbanWorkStep,
        );
      if (link.role === "review" && link.cardId !== null) {
        live = (yield* store.card(link.cardId))?.activeThreadId === link.threadId;
      }
      if (!live) {
        yield* store.putThreadLink({ ...link, paused: null });
        continue;
      }
      const recovered = yield* Ref.get(recoveredThreads);
      if (recovered.has(link.threadId)) continue;
      if (board.pause && link.role !== "evaluator") {
        const carried = yield* store.cardsByThread(link.threadId);
        if (carried.some((card) => !board.pause!.keep.includes(card.id))) {
          const runId =
            link.paused?.runId ?? (yield* threads.lastFailure(link.threadId))?.runId ?? null;
          yield* Ref.update(recoveredThreads, (map) => new Map(map).set(link.threadId, runId));
          continue;
        }
      }
      // A failed read is not a deleted thread: keep the wake for the next probe.
      const found = yield* Effect.result(threads.find(link.threadId));
      if (Result.isFailure(found)) {
        failed = true;
        continue;
      }
      // Deleted, archived (it takes no messages) or running again: nothing to wake,
      // and its pause must not hold the pool down.
      const view = found.success;
      if (view === null || view.archived || view.state !== "idle") {
        yield* store.putThreadLink({ ...link, paused: null });
        continue;
      }
      const sent = yield* threads
        .send({
          threadId: link.threadId,
          text: Briefs.providerBackText(link.paused.message),
          key: recovery
            ? postRecoveryKey(
                recovery.discussionId,
                recovery.seq,
                `outage:${link.threadId}:${link.paused.at}`,
              )
            : wakeKey(link.threadId, link.paused.at),
        })
        .pipe(
          Effect.provideService(EvaluatorAnalytics.origin, "stall_run_failure"),
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        );
      if (!sent) {
        failed = true;
        continue;
      }
      yield* Ref.update(recoveredThreads, (map) =>
        new Map(map).set(link.threadId, link.paused?.runId ?? null),
      );
      yield* store.putThreadLink({ ...link, paused: null });
      woken.set(board.id, (woken.get(board.id) ?? 0) + 1);
    }
    // Report accepted wakes only, once on each board that saw the outage.
    yield* Effect.gen(function* () {
      const state = (yield* Ref.get(down)).get(key);
      if (state === undefined) return;
      const counts = new Map(
        [...woken].filter(([id]) => state.announced.has(id) && !state.recovered.has(id)),
      );
      if (counts.size === 0) return;
      const backed = yield* alertBoards(
        counts,
        (count) =>
          `${key} answers again. ${count} paused thread${count === 1 ? "" : "s"} woken where they stopped.`,
      );
      yield* Ref.update(down, (map) => {
        const entry = map.get(key);
        if (!entry) return map;
        return new Map(map).set(key, {
          ...entry,
          recovered: new Set([...entry.recovered, ...backed]),
        });
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban outage recovery alert failed", { key, cause }),
      ),
    );
    if (failed || ((yield* Ref.get(outageGeneration)).get(key) ?? 0) !== generation) return;
    yield* Ref.update(down, (map) => {
      const next = new Map(map);
      next.delete(key);
      return next;
    });
    yield* kick;
  });

  const recoveringBoards = new Set<string>();
  const wakeRecovered = Effect.fn("KanbanService.wakeRecovered")(function* (board: KanbanBoard) {
    // Reserve before any read: unpause and overlapping ticks share one recovery pass.
    if (recoveringBoards.has(board.id)) return;
    recoveringBoards.add(board.id);
    yield* Effect.gen(function* () {
      const recovered = yield* Ref.get(recoveredThreads);
      if (recovered.size === 0) return;
      // A global pausedLinks scan makes every board's tick queue on every other
      // board. Select only this board's recovered links before taking any gate.
      const candidates = (yield* locks.outside(
        rawStore.threadLinksByIds([...recovered.keys()]),
        undefined,
        true,
      )).filter((link) => link.boardId === board.id && link.paused !== null);
      if (candidates.length === 0) return;
      yield* tickStep(
        board.id,
        "wakeRecovered",
        locks.access(
          board.id,
          Effect.gen(function* () {
            for (const candidate of candidates) {
              // #1656's helper checks the board generation before consuming the
              // snapshot, including legacy findings reads, after reader admission.
              const { currentBoard, link, carried } = yield* locks.outside(
                Effect.gen(function* () {
                  const currentBoard = yield* rawStore.board(board.id);
                  const link = yield* rawStore.threadLink(candidate.threadId);
                  const carried = yield* upgradeFindings(
                    yield* rawStore.cardsByThread(candidate.threadId),
                    false,
                    rawStore.cardEvents,
                  );
                  return { currentBoard, link, carried };
                }),
                undefined,
                true,
              );
              if (
                currentBoard === null ||
                currentBoard.archivedAt !== null ||
                link?.boardId !== board.id ||
                link.paused === null ||
                !(yield* Ref.get(recoveredThreads)).has(link.threadId)
              )
                continue;
              if (carried.length === 0 || (link.role === "work" && !carried.some(kanbanWorkStep))) {
                yield* store.putThreadLink({ ...link, paused: null });
                yield* Ref.update(recoveredThreads, (map) => {
                  const next = new Map(map);
                  next.delete(link.threadId);
                  return next;
                });
                continue;
              }
              if (
                currentBoard.pause &&
                carried.some((card) => !currentBoard.pause!.keep.includes(card.id))
              )
                continue;
              if ((yield* Ref.get(down)).has(linkKey(link, currentBoard))) continue;
              const found = yield* Effect.result(threads.find(link.threadId));
              if (Result.isFailure(found)) continue;
              const view = found.success;
              if (view !== null && !view.archived && view.state === "idle") {
                const sent = yield* threads
                  .send({
                    threadId: link.threadId,
                    text: Briefs.providerBackText(link.paused.message),
                    key: wakeKey(link.threadId, link.paused.at),
                  })
                  .pipe(
                    Effect.as(true),
                    Effect.catchCause(() => Effect.succeed(false)),
                  );
                if (!sent) continue;
              }
              yield* store.putThreadLink({ ...link, paused: null });
            }
          }),
        ),
      );
    }).pipe(Effect.ensuring(Effect.sync(() => recoveringBoards.delete(board.id))));
  });

  const recoverySkipAt = new Map<string, number>();
  const skipRestartRecovery = Effect.fn("KanbanService.skipRestartRecovery")(function* (
    threadId: ThreadId,
    cards: ReadonlyArray<KanbanCard>,
    view: KanbanThreadView | null,
  ) {
    const recovery = view?.restartRecovery;
    if (recovery === undefined) return false;
    const now = yield* nowMillis;
    for (const [id, at] of recoverySkipAt) {
      if (now - at >= 10 * 60_000) recoverySkipAt.delete(id);
    }
    for (const planned of cards) {
      const card = yield* store.card(planned.id);
      if (
        card?.stage !== "working" ||
        card.activeRole !== "work" ||
        card.activeThreadId !== threadId
      )
        continue;
      if (recoverySkipAt.has(card.id)) continue;
      yield* recordAnalytics({
        kind: "kanban.nudge_skipped",
        boardId: card.boardId,
        cardId: card.id,
        threadId,
        props: { reason: "restart_recovery_pending", ...recovery },
      });
      recoverySkipAt.set(card.id, now);
    }
    return true;
  });

  const nudgeThread = Effect.fn("KanbanService.nudgeThread")(function* (
    threadId: ThreadId,
    cards: ReadonlyArray<KanbanCard>,
    text: string,
  ) {
    if (
      (yield* threads.queuedRuns(threadId)).some(
        (run) => !run.userMessageId.startsWith("kanban:wake:"),
      )
    ) {
      yield* Effect.logDebug("kanban nudge skipped: unread message queued", { threadId });
      return;
    }
    // The send is accepted before the gate resumes. Acknowledge it on current rows,
    // like discussion delivery, so a concurrent edit cannot replay the same nudge.
    // Errors can follow acceptance; a skipped send must leave the nudge attempt available.
    const attempt = { failed: false };
    const runId = yield* sendThread({ threadId, text, coalesce: "nudge" }, attempt).pipe(
      Effect.catchCause(() =>
        Effect.sync(() => {
          attempt.failed = true;
        }),
      ),
    );
    if (runId === undefined && !attempt.failed) return;
    const sent = runId !== undefined;
    const at = yield* nowIso;
    for (const card of cards) {
      const current = yield* store.card(card.id);
      if (
        current === null ||
        current.activeThreadId !== threadId ||
        current.stage !== card.stage ||
        current.activeRole !== card.activeRole ||
        current.movedAt !== card.movedAt ||
        current.nudgedAt !== card.nudgedAt
      )
        continue;
      const next = {
        ...current,
        ...(sent && current.activeRole === "work" && current.wakeNote === card.wakeNote
          ? { wakeNote: null }
          : {}),
        nudgedAt: at,
        updatedAt: at,
      };
      if (current.activeRole === "work")
        yield* logEvent(next, { _tag: "system", component: "dispatcher" }, "thread", {
          body: Rules.WORKER_NUDGE_EVENT,
        });
      yield* saveCard(next);
    }
  });

  const parkWorkerWaits = Effect.fn("KanbanService.parkWorkerWaits")(function* (
    threadId: ThreadId,
    cards: ReadonlyArray<KanbanCard>,
  ) {
    for (const card of cards) {
      if (
        !Rules.workerWaitDeferred(card) ||
        card.workThreadId !== threadId ||
        card.stalled !== null ||
        (yield* activeWaitThreadRunning(card, threads))
      )
        continue;
      const next = releaseToQueue(card, yield* nowIso);
      // Cleanup can take turn admission itself; finish it before locking, then
      // confirm idleness under the same lock used by evaluator parking.
      yield* prepareTransition(next);
      yield* turnAdmission.withLock(
        threadId,
        Effect.gen(function* () {
          if (
            !sameCardState(yield* store.card(card.id), card) ||
            (yield* activeWaitThreadRunning(card, threadIo)) ||
            Retries.heldByPause(yield* boardOf(card.boardId), card)
          )
            return;
          yield* logEvent(next, { _tag: "system", component: "dispatcher" }, "moved", {
            fromStage: card.stage,
            toStage: next.stage,
            body: "Turn ended; parked on the worker's wait",
          });
          yield* saveCard(next);
          yield* kick;
        }),
      );
    }
  });

  const advanceFinishedWorker = Effect.fn("KanbanService.advanceFinishedWorker")(function* (
    card: KanbanCard,
  ) {
    const threadId = card.activeThreadId;
    if (
      threadId === null ||
      card.stage !== "working" ||
      card.activeRole !== "work" ||
      card.settledAt !== null ||
      card.stalled !== null ||
      kanbanWorkStep(card) ||
      card.wait !== undefined ||
      kanbanOpenAsks(card).some((ask) => ask.blocking) ||
      Waits.decidingHolds(card) ||
      waking(threadId)
    )
      return card;
    card = (yield* upgradeFindings([card]))[0]!;
    if (kanbanWorkStep(card)) return card;
    const review = kanbanStepSubtasks(card, "review").length > 0;
    if (!review && !kanbanEvaluatorStep(card) && !kanbanScriptStep(card)) return card;
    if (review && !Rules.checkMove("cardThread", card, "needs_review").ok) return card;
    const view = yield* freshThreads.find(threadId);
    if (
      view?.state !== "idle" ||
      view.backgroundWork > 0 ||
      Rules.waitingOnBackground(view, yield* nowMillis) ||
      (yield* threads.queuedRuns(threadId)).length > 0
    )
      return card;
    if (
      [...(backgroundWaits.get(threadId)?.jobs.values() ?? [])].some((job) => job.endedAt !== null)
    )
      return card;
    const at = yield* nowIso;
    const reason = review ? "review_step" : "evaluator_step";
    const next: KanbanCard = {
      ...Retries.withoutRetries(release(card)),
      stage: review ? "needs_review" : "todo",
      ...(review ? { reviewStep: 0, reviewFindingsPending: false } : { wakeNote: null }),
      question: null,
      nudgedAt: null,
      movedAt: at,
      updatedAt: at,
    };
    // Wake cleanup may take admission itself. Finish it before locking, then
    // recheck the card and thread together so a worker's own move wins the race.
    yield* prepareTransition(next);
    const sink: EffectSink = { effects: [], closed: false };
    const publications: Array<BoardPublication> = [];
    const measurements: AnalyticsEvent[] = [];
    const observer = yield* SavedWrite.observer;
    const receipts: SavedWrite.Saved[] = [];
    let lanes = new Set<string>();
    const saved = yield* turnAdmission.withLock(
      threadId,
      Effect.gen(function* () {
        const live = yield* threadIo.find(threadId);
        if (
          !sameCardState(yield* store.card(card.id), card) ||
          live?.state !== "idle" ||
          live.backgroundWork > 0 ||
          Rules.waitingOnBackground(live, yield* nowMillis) ||
          (yield* threadIo.queuedRuns(threadId)).length > 0 ||
          (yield* store.threadLink(threadId))?.paused ||
          Retries.heldByPause(yield* boardOf(card.boardId), card) ||
          waking(threadId)
        )
          return false;
        const actor: KanbanActor = { _tag: "system", component: "dispatcher" };
        const ageMs = BoardAnalytics.elapsed(at, card.analyticsStageEnteredAt ?? card.movedAt);
        // Turn-end and tick have no write-effect sink. Save the handoff and its
        // evaluator obligation together so a rejected notification can replay.
        lanes = yield* Effect.uninterruptible(
          boardTransaction(
            card.boardId,
            Effect.gen(function* () {
              yield* logEvent(next, actor, "moved", {
                fromStage: card.stage,
                toStage: next.stage,
                body: `Auto-advanced: ${reason}; ${ageMs} ms in Working`,
              });
              yield* saveCard(next, actor, false, false);
              yield* recordAnalytics({
                kind: "kanban.card.autoAdvanced",
                boardId: card.boardId,
                cardId: card.id,
                threadId,
                props: {
                  number: card.number,
                  from: card.stage,
                  to: next.stage,
                  actor: "system",
                  reasonClass: reason,
                  msInPrevStage: ageMs,
                },
              });
              yield* laterEvaluatorTurn(card, next, actor);
              return yield* saveEffectRows(sink.effects);
            }).pipe(
              Effect.provideService(SavedWrite.observer, (receipt) => {
                receipts.push(receipt);
              }),
              Effect.provideService(effectSink, sink),
              Effect.provideService(publicationSink, publications),
              Effect.provideService(analyticsSink, measurements),
              Effect.ensuring(
                Effect.sync(() => {
                  sink.closed = true;
                }),
              ),
            ),
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                for (const receipt of receipts) observer(receipt);
              }),
            ),
            // The slot cache and returned receipts must only reflect committed state.
            Effect.tap(() => syncSlot(card.boardId, threadId, "card_left", card.id)),
          ),
        );
        return true;
      }),
    );
    if (!saved) return yield* cardOf(card.id);
    for (const measurement of measurements) yield* recordAnalytics(measurement);
    for (const publication of publications) yield* publish(publication.boardId, publication.change);
    for (const lane of lanes) yield* triggerOwnerDrain(lane);
    yield* kick;
    return next;
  });

  /** Nudge a stopped worker once, then release cards still idle after the grace. */
  const nudgeWorker = Effect.fn("KanbanService.nudgeWorker")(function* (
    threadId: ThreadId,
    planned: ReadonlyArray<KanbanCard>,
    runtimeFailureRunId: string | null = null,
  ) {
    if (waking(threadId)) return;
    for (const card of planned) yield* advanceFinishedWorker(card);
    yield* parkWorkerWaits(threadId, planned);
    const cards: Array<KanbanCard> = [];
    for (const initial of planned) {
      const current = yield* store.card(initial.id);
      if (
        current === null ||
        current.stage !== initial.stage ||
        current.activeRole !== initial.activeRole ||
        current.activeThreadId !== initial.activeThreadId ||
        current.activeThreadId !== threadId ||
        current.movedAt !== initial.movedAt ||
        current.nudgedAt !== initial.nudgedAt
      )
        continue;
      cards.push(current);
    }
    const board = cards[0] ? yield* boardOf(cards[0].boardId) : null;
    // A batched thread may carry both kept and held cards. Do not start it for a
    // kept sibling while another card it owns is held.
    const carried = yield* store.cardsByThread(threadId);
    if (board?.pause && carried.some((card) => !board.pause!.keep.includes(card.id))) {
      yield* Ref.update(deferredNudges, (set) => new Set(set).add(threadId));
      return;
    }
    // A parked sibling must not be woken by another card on the same thread.
    if (
      carried.some(
        (card) => card.wait !== undefined || kanbanOpenAsks(card).some((ask) => ask.blocking),
      )
    )
      return;
    const nudge = (yield* upgradeFindings(cards)).filter(
      (card) =>
        card.stage === "working" &&
        card.activeRole === "work" &&
        card.stalled === null &&
        (!board?.pause || board.pause.keep.includes(card.id)),
    );
    if (nudge.length === 0) return;
    yield* Ref.update(deferredNudges, (set) => {
      const next = new Set(set);
      next.delete(threadId);
      return next;
    });
    const view = yield* freshThreads.find(threadId);
    if (yield* skipRestartRecovery(threadId, nudge, view)) return;
    if ((yield* threads.queuedRuns(threadId)).length > 0) return;
    const now = yield* nowMillis;
    if (view?.state !== "idle") return;
    if (runtimeFailureRunId !== null) {
      const failure = yield* freshThreads.findLastFailure(threadId);
      if (failure?.runId !== runtimeFailureRunId || !Rules.isRuntimeFailure(failure)) return;
    } else if (Rules.waitingOnBackground(view, now)) return;
    const latestBoard = board ? yield* boardOf(board.id) : null;
    if ((yield* store.threadLink(threadId))?.paused || waking(threadId)) return;
    const latestCarried = yield* store.cardsByThread(threadId);
    if (
      latestCarried.some(
        (card) =>
          (latestBoard !== null && Retries.heldByPause(latestBoard, card)) ||
          card.wait !== undefined ||
          kanbanOpenAsks(card).some((ask) => ask.blocking),
      )
    )
      return;
    const at = yield* nowIso;
    const first: Array<KanbanCard> = [];
    const released: Array<KanbanCard> = [];
    for (const planned of nudge) {
      const card = yield* store.card(planned.id);
      if (
        card === null ||
        card.activeThreadId !== threadId ||
        card.activeRole !== "work" ||
        card.stage !== "working" ||
        !sameCardState(card, planned) ||
        card.stalled !== null
      )
        continue;
      if (runtimeFailureRunId !== null) {
        if (Rules.failedTurnResumeDue(card, view, now)) first.push(card);
        continue;
      }
      const nudged =
        card.nudgedAt !== null && Rules.workerHandoffNudged(card, yield* store.cardEvents(card.id));
      // An evaluator-only step still gets its normal chance to advance before
      // the idle backstop asks the worker to finish its handoff.
      if (
        !nudged &&
        (kanbanWorkStep(card) ||
          Rules.workerWorkDone(card) ||
          Rules.workerQuietDue(card, view, now))
      )
        first.push(card);
      if (!nudged || !Rules.workerQuietDue(card, view, now)) continue;
      const done = Rules.workerWorkDone(card);
      const next: KanbanCard = {
        ...Retries.withoutRetries(release(card)),
        stage: done ? "needs_review" : "todo",
        ...(done ? { reviewStep: 0, reviewFindingsPending: false } : {}),
        nudgedAt: null,
        movedAt: at,
        updatedAt: at,
      };
      const reason = done
        ? "Work thread idle with work done; moved to review"
        : "Work thread idle; slot freed";
      // Cleanup can yield to turn admission. Finish it before taking that
      // non-reentrant lock, then confirm the turn cannot resume before saving.
      yield* prepareTransition(next);
      const saved = yield* turnAdmission.withLock(
        threadId,
        Effect.gen(function* () {
          const queued = yield* threadIo.queuedRuns(threadId);
          const live = yield* threadIo.find(threadId);
          const liveBoard = yield* boardOf(card.boardId);
          const held = (yield* store.cardsByThread(threadId)).some(
            (entry) =>
              Retries.heldByPause(liveBoard, entry) ||
              entry.wait !== undefined ||
              kanbanOpenAsks(entry).some((ask) => ask.blocking),
          );
          if (
            held ||
            (yield* store.threadLink(threadId))?.paused ||
            queued.length > 0 ||
            live?.state !== "idle" ||
            Rules.waitingOnBackground(live, yield* nowMillis) ||
            !Rules.workerQuietDue(card, live, yield* nowMillis) ||
            !sameCardState(yield* store.card(card.id), card)
          )
            return false;
          yield* logEvent(next, { _tag: "system", component: "dispatcher" }, "moved", {
            fromStage: card.stage,
            toStage: next.stage,
            body: reason,
          });
          yield* saveCard(next);
          return true;
        }),
      );
      if (!saved) continue;
      (yield* tickKicks)?.stoppedCards.add(card.id);
      if (!done) released.push(next);
      yield* kick;
    }
    const recovery =
      runtimeFailureRunId !== null
        ? "Your turn ended on a tool-host or provider-runtime failure. Reconcile running commands and offbox runs first: use offbox wait <run> for the existing run. Never start a duplicate run or kill a running command as recovery. Then continue.\n\n"
        : "";
    if (first.length > 0)
      yield* nudgeThread(threadId, first, recovery + Briefs.nudgeWorkText(first));
    for (const card of released)
      yield* noteDiscussion(card, `Card #${card.number}: Work thread idle; slot freed`).pipe(
        Effect.provideService(EvaluatorAnalytics.origin, "stall_run_failure"),
        Effect.ignore,
      );
  });

  // A board setting can wrap several recoveries; publish and drain after its outer commit.
  const commitReviewGate = Effect.fn("KanbanService.commitReviewGate")(function* <A, E, R>(
    boardId: string,
    effect: Effect.Effect<A, E, R>,
  ) {
    const outerPublications = yield* publicationSink;
    const outerMeasurements = yield* analyticsSink;
    const outerDrains = yield* reviewGateDrains;
    const drains = outerDrains ?? new Set<string>();
    const publications = outerPublications ?? [];
    const measurements = outerMeasurements ?? [];
    const observer = yield* SavedWrite.observer;
    const receipts: SavedWrite.Saved[] = [];
    const result = yield* Effect.uninterruptible(
      boardTransaction(
        boardId,
        effect.pipe(
          Effect.provideService(SavedWrite.observer, (saved) => {
            receipts.push(saved);
          }),
          Effect.provideService(reviewGateDrains, drains),
          Effect.provideService(publicationSink, publications),
          Effect.provideService(analyticsSink, measurements),
        ),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const receipt of receipts) observer(receipt);
          }),
        ),
      ),
    );
    if (outerMeasurements === undefined)
      for (const measurement of measurements) yield* recordAnalytics(measurement);
    if (outerPublications === undefined)
      for (const publication of publications)
        yield* publish(publication.boardId, publication.change);
    if (outerDrains === undefined)
      for (const lane of drains) yield* forkPostCommit(afterOwnerCommit(lane));
    return result;
  });

  const saveReviewGateState = Effect.fn("KanbanService.saveReviewGateState")(function* (
    before: KanbanCard,
    next: KanbanCard,
    options: {
      readonly flagReason?: string;
      readonly notice?: string;
      readonly head?: string | null;
    },
  ) {
    const system: KanbanActor = { _tag: "system", component: "dispatcher" };
    yield* prepareTransition(next);
    // The receipt must never survive a failed card save, and a retained flag
    // must retain its evaluator notification across a process exit too.
    yield* commitReviewGate(
      next.boardId,
      Effect.gen(function* () {
        const checked = yield* logEvent(
          next,
          system,
          options.flagReason === undefined ? "comment" : "flagged",
          {
            body: options.flagReason ?? Retries.reviewGateBuildEvent(reviewGateBuild),
            ...(options.flagReason === undefined
              ? {}
              : { fromStage: before.stage, toStage: next.stage }),
          },
        );
        if (options.flagReason === undefined && next !== before)
          yield* logEvent(next, system, "moved", {
            fromStage: before.stage,
            toStage: next.stage,
            body: Retries.REVIEW_GATE_REQUEUED_EVENT,
            head: options.head ?? null,
          });
        if (options.notice !== undefined) {
          yield* saveOwnerRoute(
            next.boardId,
            KanbanDiscussionId.make(cardLane(next)),
            `review-gate:${next.id}:${checked.id}`,
            {
              kind: "effect",
              seq: -1,
              effect: { kind: "noteDiscussion", cardId: next.id, text: options.notice },
            },
          );
          (yield* reviewGateDrains)?.add(cardLane(next));
        }
        yield* saveCard(next);
      }),
    );
  });

  const recheckReviewGate = Effect.fn("KanbanService.recheckReviewGate")(function* (
    card: KanbanCard,
    board: KanbanBoard,
    changed = false,
  ) {
    if (changed && card.stage === "in_review" && card.activeRole === "review") {
      const events = yield* store.cardEvents(card.id);
      if (
        Retries.gateRefusedVerdict(card, events) !== null ||
        events.some(
          (event) =>
            event.actor._tag === "system" &&
            event.body === Retries.reviewGateBuildEvent(reviewGateBuild),
        )
      )
        yield* logEvent(card, { _tag: "system", component: "dispatcher" }, "comment", {
          body: Retries.REVIEW_GATE_CHANGED_EVENT,
        });
      return card;
    }
    if (
      card.stage !== "needs_review" ||
      card.activeThreadId !== null ||
      card.stalled?.by._tag !== "system" ||
      !(
        card.stalled.reason.startsWith(Retries.REFUSED_VERDICT_PREFIX) ||
        card.stalled.reason === Retries.NO_VERDICT_REASON
      )
    )
      return card;
    const events = yield* store.cardEvents(card.id);
    const refused = Retries.gateRefusedVerdict(card, events);
    if (refused === null) return card;
    const receipt = Retries.reviewGateBuildEvent(reviewGateBuild);
    const lastCheck = events.findLast(
      (event) => event.actor._tag === "system" && event.body === receipt,
    );
    if (
      !changed &&
      lastCheck !== undefined &&
      !events.some(
        (event) =>
          event.id > lastCheck.id &&
          event.actor._tag === "system" &&
          event.body === Retries.REVIEW_GATE_CHANGED_EVENT,
      )
    )
      return card;
    const currentStep = kanbanOpenStep(card);
    // Use the verdict's approval check, also retaining a real owner gate in the
    // current plan step if an edit changed who owns that step.
    const relevant = new Set([
      ...Subtasks.reviewSubtasksToPass(card),
      ...card.subtasks.filter(
        (subtask) => subtask.step === currentStep && subtask.state === "open",
      ),
    ]);
    const missing = [...relevant]
      .map((subtask) =>
        Subtasks.approvalProblem(card, subtask, board.standingApprovals, board.guessedGates),
      )
      .find((problem) => problem !== null);
    if (missing || Asks.openBlockingAsk(card) !== undefined) {
      yield* saveReviewGateState(card, card, {
        notice: Briefs.workerFlaggedText(card, missing ?? "An owner question is still unanswered"),
      });
      return card;
    }
    const next: KanbanCard = {
      ...release(card),
      stage: "needs_review",
      stalled: null,
      nudgedAt: null,
      // Recovery retains queue age, parked waits, and every retry record.
      updatedAt: DateTime.formatIso(
        DateTime.makeUnsafe(Math.max(yield* Clock.currentTimeMillis, Date.parse(card.updatedAt))),
      ),
    };
    yield* saveReviewGateState(card, next, { head: Retries.gateRefusalHead(refused) });
    yield* kick;
    return next;
  });

  const recheckBoardReviewGates = Effect.fn("KanbanService.recheckBoardReviewGates")(function* (
    board: KanbanBoard,
  ) {
    for (const card of yield* store.openCards(board.id)) {
      yield* recheckReviewGate(card, board, true);
    }
  });

  /** Refused verdicts flag immediately; a missing verdict gets a nudge and one restart first. */
  const reviewerStopped = Effect.fn("KanbanService.reviewerStopped")(function* (
    planned: KanbanCard,
    threadId: ThreadId,
  ) {
    if (waking(threadId)) return;
    const card = yield* store.card(planned.id);
    if (
      card === null ||
      card.stage !== "in_review" ||
      card.stage !== planned.stage ||
      card.activeRole !== "review" ||
      card.activeRole !== planned.activeRole ||
      card.activeThreadId !== planned.activeThreadId ||
      card.activeThreadId !== threadId ||
      card.movedAt !== planned.movedAt ||
      card.nudgedAt !== planned.nudgedAt
    )
      return;
    const board = yield* boardOf(card.boardId);
    if (board.pause && !board.pause.keep.includes(card.id)) {
      yield* Ref.update(deferredNudges, (set) => new Set(set).add(threadId));
      return;
    }
    yield* Ref.update(deferredNudges, (set) => {
      const next = new Set(set);
      next.delete(threadId);
      return next;
    });
    const at = yield* nowIso;
    const system: KanbanActor = { _tag: "system", component: "dispatcher" };
    const refused = Retries.refusedVerdict(card, yield* store.cardEvents(card.id), threadId);
    if (refused === null && card.nudgedAt === null) {
      yield* nudgeThread(threadId, [card], Briefs.nudgeReviewText(card));
      return;
    }
    // A reviewer that still has no verdict after the nudge frees its slot. The first
    // time the review is started again once (see Retries); the second time it is flagged.
    const reason =
      refused === null ? Retries.NO_VERDICT_REASON : `${Retries.REFUSED_VERDICT_PREFIX}${refused}`;
    const retry =
      refused !== null
        ? { _tag: "flag" as const }
        : Retries.decideRetry({
            kind: "no_verdict",
            role: "review",
            retries: card.retries,
            paused: Retries.heldByPause(board, card),
            nowMs: Date.parse(at),
            at,
          });
    if (retry._tag === "hold" || retry._tag === "wait") return;
    yield* endReviewLink(card.reviewThreadId, at);
    if (retry._tag === "restart") {
      const again: KanbanCard = {
        ...release(card),
        stage: "needs_review",
        stalled: null,
        nudgedAt: null,
        retries: retry.retries,
        // Preserve queue age and any parked wait during recovery.
        updatedAt: at,
      };
      yield* logEvent(again, system, "moved", {
        fromStage: card.stage,
        toStage: again.stage,
        body: Retries.NO_VERDICT_RESTARTED_EVENT,
      });
      yield* saveCard(again);
      yield* kick;
      return;
    }
    const next: KanbanCard = {
      ...Retries.withoutRetries(release(card)),
      stage: "needs_review",
      stalled: { reason, by: system, at },
      nudgedAt: null,
      // Preserve queue age and any parked wait during recovery.
      updatedAt: at,
    };
    if (Retries.gateRefusedVerdict(next, yield* store.cardEvents(card.id)) !== null) {
      yield* saveReviewGateState(card, next, {
        flagReason: reason,
        notice: Briefs.workerFlaggedText(next, reason),
      });
      yield* kick;
      return;
    }
    yield* logEvent(next, system, "flagged", {
      fromStage: card.stage,
      toStage: next.stage,
      body: reason,
    });
    yield* saveCard(next);
    yield* kick;
  });

  const boardNudgeThreads = Effect.fn("KanbanService.boardNudgeThreads")(function* (
    boardId: string,
  ) {
    const deferred = yield* Ref.get(deferredNudges);
    if (deferred.size === 0) return [];
    return (yield* locks.outside(rawStore.threadLinksByIds([...deferred]), undefined, true))
      .filter((link) => link.boardId === boardId)
      .map((link) => link.threadId);
  });

  const wakeBoardNudges = Effect.fn("KanbanService.wakeBoardNudges")(function* (
    board: KanbanBoard,
    discussionWakes: ReadonlySet<ThreadId>,
    candidates?: ReadonlyArray<ThreadId>,
  ) {
    for (const threadId of candidates ?? (yield* boardNudgeThreads(board.id))) {
      if (!(yield* Ref.get(deferredNudges)).has(threadId)) continue;
      const cards = yield* store.openCards(board.id);
      const carried = cards.filter((card) => card.activeThreadId === threadId);
      if (carried.length === 0) {
        const link = yield* store.threadLink(threadId);
        if (link?.boardId === board.id) {
          yield* Ref.update(deferredNudges, (set) => {
            const next = new Set(set);
            next.delete(threadId);
            return next;
          });
        }
        continue;
      }
      if (carried.some((card) => board.pause && !board.pause.keep.includes(card.id))) continue;
      if ((yield* store.threadLink(threadId))?.paused) continue;
      if ((yield* Ref.get(unresolvedTurnEnds)).has(threadId)) continue;
      if (discussionWakes.has(threadId)) continue;
      const view = yield* threads.view(threadId);
      if (
        carried.some((card) => card.stage === "working" && card.activeRole === "work") &&
        (yield* skipRestartRecovery(threadId, carried, view))
      )
        continue;
      const foundFailure = yield* Effect.result(threads.findLastFailure(threadId));
      if (Result.isFailure(foundFailure)) {
        yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
        continue;
      }
      if (foundFailure.success !== null) {
        yield* turnEndedUnlocked(threadId, undefined, true);
        continue;
      }
      if (!view || view.state !== "idle" || Rules.waitingOnBackground(view, yield* nowMillis))
        continue;
      const review = carried.find((card) => card.activeRole === "review");
      if (review) yield* reviewerStopped(review, threadId);
      else yield* nudgeWorker(threadId, carried);
    }
  });

  // The persisted deferral belongs to the participant even after its card is released.
  const wakeDiscussionNudges = Effect.fn("KanbanService.wakeDiscussionNudges")(
    function* (board: KanbanBoard, wakes = new Set<ThreadId>()) {
      // Collection admission can queue for seconds too. Only candidate validation
      // and recording own a board operation; thread I/O runs between those operations.
      const candidates = [];
      for (const discussion of yield* store.openDiscussions(board.id)) {
        if (discussion.settledAt !== null || discussion.archivedAt !== null) continue;
        for (const participant of discussion.participants) {
          if (
            participant.actor._tag !== "thread" ||
            !participant.deferred ||
            participant.owes !== "asked"
          )
            continue;
          // Legacy participants have no stable ask cursor; prefer a conservative
          // creation-time age over dating their ask from a later read or status.
          const ask =
            participant.askedSeq === undefined || participant.askedSeq === 0
              ? null
              : yield* store.message(discussion.id, participant.askedSeq);
          candidates.push({
            discussionId: discussion.id,
            threadId: participant.actor.threadId,
            deferredKey: participant.deferredKey,
            lastReadSeq: participant.lastReadSeq,
            askedSeq: participant.askedSeq,
            askedAt: ask?.createdAt ?? discussion.createdAt,
          });
        }
      }
      candidates.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
      let sends = 0;
      for (const candidate of candidates) {
        if (sends >= 10) break;
        const { threadId } = candidate;
        if ((yield* Ref.get(unresolvedTurnEnds)).has(threadId) || wakes.has(threadId)) continue;
        const prepare = Effect.gen(function* () {
          const discussion = yield* store.discussion(candidate.discussionId);
          if (!discussion || discussion.settledAt !== null || discussion.archivedAt !== null)
            return null;
          const participant = discussion.participants.find(
            (entry) => entry.actor._tag === "thread" && entry.actor.threadId === threadId,
          );
          if (
            !participant?.deferred ||
            participant.owes !== "asked" ||
            participant.deferredKey !== candidate.deferredKey ||
            participant.lastReadSeq !== candidate.lastReadSeq ||
            participant.askedSeq !== candidate.askedSeq
          )
            return null;
          const link = yield* store.threadLink(threadId);
          const currentBoard = yield* boardOf(board.id);
          if (
            currentBoard.archivedAt !== null ||
            !link ||
            link.boardId !== board.id ||
            link.paused ||
            (yield* Ref.get(unresolvedTurnEnds)).has(threadId)
          )
            return null;
          if (yield* discussionWaitHeld(discussion, link)) return null;
          if (discussionHeld(currentBoard, discussion, link, yield* store.cardsByThread(threadId)))
            return null;
          if (!(yield* isHome(discussion, threadId))) {
            yield* saveDiscussion(
              withParticipant(discussion, participant.actor, participant.name, {
                owes: null,
                typingUntil: null,
              }),
            );
            return null;
          }
          const action = yield* ownerReplyPending(store, discussion.id, threadId).pipe(
            locks.dispatchRead,
          );
          return action === null ? null : { discussion, participant, action };
        });
        const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          locks.step(
            locks.boundedReads(effect),
            undefined,
            "KanbanService.tickStep:wakeDiscussionNudges",
          );
        // A read budget miss ends this pass; retrying immediately would keep taking
        // the gate from writers while the same reader remains backed up.
        const processed = yield* Effect.gen(function* () {
          if (!(yield* locked(prepare))) return;
          const view = yield* threads.view(threadId);
          if (
            !view ||
            view.archived ||
            view.state !== "idle" ||
            Rules.waitingOnBackground(view, yield* nowMillis)
          )
            return;
          const failure = yield* Effect.result(threads.findLastFailure(threadId));
          const ready = yield* locked(prepare);
          if (!ready) return;
          if (Result.isFailure(failure) || failure.success !== null) {
            wakes.add(threadId);
            // The serial turn-end handler needs an operation parent so its own
            // commits advance the pause caller's snapshot when it resumes.
            if (Result.isSuccess(failure))
              yield* locked(turnEndedUnlocked(threadId, undefined, true));
            return;
          }
          // An attempted reminder wins over a work nudge, including a refused send.
          wakes.add(threadId);
          sends += 1;
          const sent = yield* sendDiscussionReminder(ready.discussion, threadId, ready.action);
          yield* locked(
            Effect.gen(function* () {
              const fresh = yield* prepare;
              if (fresh)
                yield* recordDiscussionReminder(fresh.discussion, fresh.participant, sent, true);
              const stillAsked = fresh
                ? Result.isFailure(sent)
                : (yield* store.discussion(candidate.discussionId))?.participants.some(
                    (entry) =>
                      entry.actor._tag === "thread" &&
                      entry.actor.threadId === threadId &&
                      entry.owes === "asked",
                  );
              if (!stillAsked) {
                yield* Ref.update(deferredNudges, (set) => {
                  const next = new Set(set);
                  next.delete(threadId);
                  return next;
                });
              }
            }),
          );
        }).pipe(
          Effect.as(true),
          Effect.catchDefect((defect) =>
            defect instanceof BoardLocks.BoardReadBudgetExceeded
              ? Effect.succeed(false)
              : Effect.die(defect),
          ),
        );
        if (!processed) break;
      }
      return wakes;
    },
    (effect) => locks.outside(locks.fresh(effect)),
  );

  /**
   * An evaluator failed twice (or ran out of context): it is given up. Its discussions
   * get a fresh evaluator once; a one-shot evaluator is handed to its card or reported.
   */
  const evaluatorGiveUp = Effect.fn("KanbanService.evaluatorGiveUp")(function* (
    link: KanbanThreadLink,
    message: string,
    recoveredPost?: EvaluatorJob["extra"]["recoveryPost"],
    refusal?: { readonly model: string },
  ) {
    const threadId = link.threadId;
    const replacementModel =
      refusal !== undefined && !["gpt-6.1-sol", "opus/cx/gpt-6.1-sol"].includes(refusal.model)
        ? REFUSAL_EVALUATOR_MODEL
        : undefined;
    yield* Ref.update(evaluatorFailures, (all) =>
      new Map(all).set(threadId, { dueAt: 0, message, state: "gone", runId: null }),
    );
    if (link.discussionId === null) {
      const current = (yield* store.threadLink(threadId)) ?? link;
      if (current.endedAt === null) {
        yield* store.putThreadLink({ ...current, endedAt: yield* nowIso });
      }
    }
    const actor: KanbanActor = { _tag: "system", component: "evaluator-watch" };
    const homes = (yield* store.discussions(link.boardId)).filter(
      (entry) => entry.evaluatorThreadId === threadId && entry.archivedAt === null,
    );
    for (const home of homes) {
      yield* Effect.gen(function* () {
        const recovery = recoveredPost?.discussionId === home.id ? recoveredPost : undefined;
        if (recovery && !(yield* postRecoveryPending(store, recovery.discussionId, recovery.seq)))
          return;
        const fresh = refusal
          ? replacementModel !== undefined
          : !(yield* Ref.get(replaced)).has(home.id);
        yield* postUnlocked(
          home.id,
          actor,
          [{ _tag: "md", text: Briefs.evaluatorGoneText(message, fresh) }],
          false,
        );
        const cleared = { ...(yield* discussionOf(home.id)), evaluatorThreadId: null };
        if (fresh) {
          yield* Ref.update(replaced, (all) => new Set(all).add(home.id));
          const original = recovery ? yield* store.message(home.id, recovery.seq) : null;
          const text = Briefs.evaluatorTakeoverText(threadId, message);
          const route = toEvaluator(
            cleared,
            original ? `${text}\n\n${blocksText(original.blocks, attachments.pathOf)}` : text,
            false,
            undefined,
            recovery
              ? postRecoveryKey(home.id, recovery.seq, `replacement:${threadId}`)
              : undefined,
            recovery ? postRecoveryPending(store, home.id, recovery.seq) : undefined,
            undefined,
            replacementModel,
          ).pipe(
            Effect.provideService(EvaluatorAnalytics.origin, "stall_run_failure"),
            Effect.provideService(recoveryPost, recovery),
          );
          yield* original ? observePostRouting(cleared, original, route, "replacement") : route;
        } else {
          yield* saveDiscussion(cleared);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban evaluator give-up failed", { threadId, cause }),
        ),
      );
    }
    if (homes.length > 0 || recoveredPost !== undefined) return;
    yield* Effect.gen(function* () {
      const card = link.cardId !== null ? yield* store.card(link.cardId) : null;
      if (card) {
        if (refusal && replacementModel === undefined) {
          yield* postUnlocked(
            (yield* cardDiscussionUnlocked(card.id)).id,
            actor,
            [{ _tag: "md", text: `${message} No replacement starts automatically.` }],
            false,
          );
          return;
        }
        yield* noteDiscussion(
          card,
          Briefs.evaluatorTakeoverText(threadId, message),
          replacementModel,
        ).pipe(Effect.provideService(EvaluatorAnalytics.origin, "stall_run_failure"));
        return;
      }
      const title = (yield* threads.view(threadId))?.title ?? link.purpose ?? "evaluator";
      const existing = (yield* store.discussions(link.boardId)).find(
        (entry) =>
          entry.cardId === null &&
          entry.archivedAt === null &&
          entry.title === EVALUATOR_ERRORS_TITLE,
      );
      const channel =
        existing ?? (yield* newDiscussion(link.boardId, EVALUATOR_ERRORS_TITLE, null, actor));
      yield* postUnlocked(
        channel.id,
        actor,
        [
          {
            _tag: "md",
            text: refusal
              ? `Evaluator [${title}](t3-thread://v1/${threadId}) stopped: ${message}.${replacementModel === undefined ? " No replacement starts automatically." : " A fresh evaluator takes over on Sol xhigh."}`
              : Briefs.evaluatorLostText(title, threadId, message),
          },
        ],
        false,
      );
      if (replacementModel !== undefined) {
        yield* startEvaluatorUnlocked(
          yield* boardOf(link.boardId),
          {
            kind: "request",
            text: Briefs.evaluatorTakeoverText(threadId, message),
          },
          {
            key: `refusal:${threadId}`,
            model: replacementModel,
            trigger: "stall_run_failure",
          },
        ).pipe(
          Effect.catchTags({
            KanbanError: (error) =>
              error.detail.startsWith("Evaluator queued (") ? Effect.void : Effect.fail(error),
          }),
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban evaluator give-up failed", { threadId, cause }),
      ),
    );
  });

  const finishStartTimeout = Effect.fn("KanbanService.finishStartTimeout")(function* (
    threadId: ThreadId,
    link: KanbanThreadLink,
    startTimeout: StartTimeout,
    at: string,
  ) {
    if (startTimeout.restartAdmission) {
      const runs = yield* freshThreads.unsettledRuns(threadId);
      if (runs.some((run) => run.id !== startTimeout.runId)) return;
      if (yield* freshThreads.laterStartedRun(threadId, startTimeout.runId)) return;
    }
    const ids =
      link.role === "work" ? yield* store.threadCards(threadId) : link.cardId ? [link.cardId] : [];
    for (const id of ids) {
      const current = yield* store.card(id);
      if (
        current === null ||
        current.stalled !== null ||
        (current.activeThreadId !== null && current.activeThreadId !== threadId) ||
        !(link.role === "work"
          ? current.workThreadId === threadId && ["todo", "working"].includes(current.stage)
          : link.role === "review" &&
            current.reviewThreadId === threadId &&
            ["needs_review", "in_review"].includes(current.stage))
      )
        continue;
      const by: KanbanActor = { _tag: "system", component: "dispatcher" };
      const reason = `Run failed: ${startTimeout.reason}${
        startTimeout.restartAdmission
          ? " The card's evaluator can clear this flag; a new run on its work thread clears it automatically."
          : ""
      }`;
      const next = releaseToQueue(
        {
          ...Retries.withoutRetries(current),
          stalled: {
            reason,
            by,
            at,
            ...(startTimeout.restartAdmission && link.role === "work"
              ? { runFailure: { threadId, runId: startTimeout.runId } }
              : {}),
          },
        },
        at,
      );
      yield* logEvent(next, by, "flagged", {
        fromStage: current.stage,
        toStage: next.stage,
        body: `${reason}\nRun: ${startTimeout.runId}`,
      });
      yield* saveCard(next);
    }
    yield* kick;
    return;
  });

  const turnEndCard = Effect.fn("KanbanService.turnEndCard")(function* (id: KanbanCard["id"]) {
    // Reader admission can take minutes. The enclosing operation revalidates
    // its board generation before using this snapshot after reacquiring the gate.
    return yield* locks.outside(rawStore.card(id), undefined, true);
  });

  const finishTurn = Effect.fn("KanbanService.turnEndedUnlocked")(function* (
    threadId: ThreadId,
    expectedFailedWorkRunId?: string,
    fromTick = false,
    startTimeout?: StartTimeout,
  ) {
    yield* Effect.annotateCurrentSpan("kanban.thread_id", threadId);
    // The previous turn can end after the next assignment saves but before its wake lands.
    if (waking(threadId) && startTimeout === undefined) {
      yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
      return;
    }
    const link = yield* store.threadLink(threadId);
    if (!link) return;
    yield* Effect.annotateCurrentSpan("kanban.board_id", link.boardId);
    if (link.cardId !== null) yield* Effect.annotateCurrentSpan("kanban.card_id", link.cardId);
    const at = yield* nowIso;
    // Queue promotion can already have replaced this failed run. Its deadline
    // still belongs to cards on this thread, including cards with no pool slot.
    if (startTimeout !== undefined)
      return yield* finishStartTimeout(threadId, link, startTimeout, at);
    // Every board-thread turn end is announced, so the Threads view rereads the run
    // as finished even when the dispatcher leaves the card as it is (a worker that
    // moved to needs_owner, a one-shot evaluator, and so on).
    // The turn has ended, so the run is not running: the provider's view can lag this event.
    const viewFence = threadFences.get(threadId) ?? 0;
    const view = yield* threads.view(threadId);
    yield* publish(link.boardId, {
      _tag: "thread",
      thread: {
        threadId,
        title: view?.title ?? link.purpose ?? link.role,
        running: false,
        needsInput: false,
        lastActivityAt: at,
      },
    });
    let card = yield* settleDetachedSteer(
      link.cardId ? yield* turnEndCard(link.cardId) : null,
      view,
      viewFence,
    );
    const carriedIds = link.role === "work" ? yield* store.threadCards(threadId) : [];

    if (link.role !== "evaluator") {
      const board = yield* boardOf(link.boardId);
      const carried = board.pause !== null ? yield* store.cardsByThread(threadId) : [];
      if (board.pause !== null && carried.some((entry) => !board.pause!.keep.includes(entry.id))) {
        // A stopped run's delayed event must not undo a cutover restore before its wake lands.
        yield* Ref.update(deferredNudges, (all) => new Set(all).add(threadId));
        for (const discussion of yield* store.discussions(board.id)) {
          const participant = discussion.participants.find(
            (entry) => entry.actor._tag === "thread" && entry.actor.threadId === threadId,
          );
          if (!participant || (participant.typingUntil === null && participant.owes === null))
            continue;
          const deferred =
            participant.owes === "asked" && !participant.deferred
              ? deferParticipant(discussion, participant)
              : discussion;
          yield* saveDiscussion(
            withParticipant(deferred, participant.actor, participant.name, { typingUntil: null }),
          );
        }
        return;
      }
    }

    const discussionIds = new Set<string>();
    if (link.discussionId) discussionIds.add(link.discussionId);
    if (card?.discussionId) discussionIds.add(card.discussionId);
    for (const id of carriedIds) {
      const other =
        id === card?.id
          ? card
          : yield* settleDetachedSteer(yield* turnEndCard(id), view, viewFence);
      if (other?.discussionId) discussionIds.add(other.discussionId);
    }
    // A run that failed (the provider refused the model or variant, or a route is gone)
    // would only loop on a nudge, so the failure is read first and nothing is nudged.
    const lastFailure = yield* Effect.result(threads.findLastFailure(threadId));
    // Never treat an unreadable provider result as a successful turn end.
    if (Result.isFailure(lastFailure)) {
      yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
      return;
    }
    yield* Ref.update(unresolvedTurnEnds, (all) => {
      const next = new Set(all);
      next.delete(threadId);
      return next;
    });
    const failure = lastFailure.success;
    if (failure?.code === "restart_admission_timeout") {
      if (failure.runId == null) {
        yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
        return;
      }
      return yield* finishStartTimeout(
        threadId,
        link,
        {
          runId: failure.runId,
          reason: failure.message,
          restartAdmission: true,
        },
        at,
      );
    }
    if (fromTick && failure !== null && expectedFailedWorkRunId === undefined) {
      if (failure.runId == null) {
        yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
        return;
      }
      expectedFailedWorkRunId = failure.runId;
    }
    const failedRunIsCurrent = Effect.fn("KanbanService.failedRunIsCurrent")(function* () {
      if (expectedFailedWorkRunId === undefined) return true;
      // Never replayed: this confirms which run is current right now.
      const found = yield* Effect.result(freshThreads.find(threadId));
      // An unreadable shell is not a superseded run: keep the turn end for the next tick.
      if (Result.isFailure(found)) {
        yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
        return false;
      }
      if (found.success?.state !== "idle") return false;
      const latest = yield* Effect.result(freshThreads.findLastFailure(threadId));
      if (Result.isFailure(latest)) {
        yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
        return false;
      }
      return latest.success?.runId === expectedFailedWorkRunId;
    });
    if (
      expectedFailedWorkRunId !== undefined &&
      (failure?.runId !== expectedFailedWorkRunId || !(yield* failedRunIsCurrent()))
    )
      return;
    // Out of usage or down: a nudge or a flag can't help, so the thread waits for
    // probeOutages to wake it on the same model.
    if (Option.isSome(analytics) && link.role !== "evaluator") {
      const stopped = stoppedRunCards.get(threadId);
      const lastRun =
        failure === null || stopped !== undefined
          ? yield* threads.latestRun(threadId).pipe(Effect.orElseSucceed(() => null))
          : null;
      const observedRun =
        failure === null
          ? lastRun
          : failure.runId == null
            ? null
            : lastRun?.runId === failure.runId
              ? lastRun
              : yield* threads
                  .compactRun(threadId, failure.runId)
                  .pipe(Effect.orElseSucceed(() => null));
      const interrupted = lastRun?.status === "interrupted" || lastRun?.status === "cancelled";
      const observations: Array<{
        card: Pick<KanbanCard, "id" | "boardId" | "activePool" | "model">;
        runId: string;
        errorClass: string;
        cancelReason?: OrchestrationV2Run["cancelReason"];
        cancelDetail?: string | undefined;
        model: ModelSelection | null;
      }> = [];
      if (failure !== null || interrupted) {
        const affected =
          link.role === "work"
            ? yield* store.cardsByThread(threadId)
            : card === null || card.activeThreadId !== threadId || card.activeRole !== "review"
              ? []
              : [card];
        for (const entry of affected)
          observations.push({
            card: entry,
            runId: failure?.runId ?? lastRun?.runId ?? link.startedAt,
            errorClass:
              failure === null
                ? "interrupted"
                : BoardAnalytics.reasonClass(failure.message, failure.category),
            model: failure?.model ?? lastRun?.model ?? null,
            cancelReason: observedRun?.cancelReason,
            cancelDetail: observedRun?.cancelDetail,
          });
      }
      if (stopped !== undefined) {
        // A new run may already be current when the stopped run's notification arrives.
        const terminal =
          lastRun?.runId === stopped.runId
            ? lastRun
            : yield* threads
                .compactRun(threadId, stopped.runId)
                .pipe(Effect.orElseSucceed(() => null));
        if (terminal?.status === "interrupted" || terminal?.status === "cancelled")
          observations.push({
            card: stopped.card,
            runId: stopped.runId,
            errorClass: "interrupted",
            model: terminal.model ?? null,
            cancelReason: terminal.cancelReason,
            cancelDetail: terminal.cancelDetail,
          });
        if (
          terminal !== null &&
          ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
            terminal.status,
          )
        )
          stoppedRunCards.delete(threadId);
      }
      for (const observation of observations) {
        const { card: entry, runId, errorClass, model } = observation;
        const identity = `${entry.id}:${threadId}:${runId}`;
        if (failedRuns.has(identity)) continue;
        yield* recordAnalytics({
          kind: "kanban.worker_failed",
          boardId: entry.boardId,
          cardId: entry.id,
          threadId,
          props: {
            poolKey: entry.activePool ?? (model === null ? "unknown" : Rules.poolKey(model)),
            model: model === null ? "unknown" : BoardAnalytics.label(model.model),
            errorClass,
            runId,
            ...(observation.cancelReason === undefined
              ? {}
              : { cancelReason: observation.cancelReason }),
          },
        });
        if (observation.cancelReason !== undefined) {
          yield* store.addCardEvent({
            cardId: entry.id,
            at: yield* nowIso,
            actor: { _tag: "system", component: "dispatcher" },
            kind: "comment",
            fromStage: null,
            toStage: null,
            head: null,
            body: `Run ${runId} ended (${observation.cancelReason}${observation.cancelDetail === undefined ? "" : `: ${observation.cancelDetail}`})`,
          });
        }
        failedRuns.add(identity);
        if (
          errorClass === "interrupted" &&
          (observation.cancelReason === undefined ||
            observation.cancelReason === "provider_cancelled" ||
            observation.cancelReason === "provider_interrupted")
        ) {
          const key = `${threadId}:${runId}`;
          const cards = pendingCancelReasons.get(key) ?? new Map();
          cards.set(entry.id, { id: entry.id, boardId: entry.boardId });
          pendingCancelReasons.set(key, cards);
          if (pendingCancelReasons.size > 4096)
            pendingCancelReasons.delete(pendingCancelReasons.keys().next().value!);
        }
        if (failedRuns.size > 4096) failedRuns.delete(failedRuns.values().next().value!);
      }
    }
    if (link.role === "work")
      yield* parkWorkerWaits(threadId, yield* store.cardsByThread(threadId));
    const outage = failure !== null && Rules.isOutage(failure) ? failure : null;
    if (
      outage !== null &&
      (link.role !== "work" || (yield* store.cardsByThread(threadId)).length > 0)
    ) {
      // A card_edit switches the open thread's model without touching its link.
      // The failed run's own selection wins because that is the model that is down.
      const model =
        outage.model ??
        (yield* threads.model(threadId)) ??
        link.model ??
        (yield* boardOf(link.boardId)).evaluatorModel;
      const recovered = yield* Ref.get(recoveredThreads);
      const runId = outage.runId ?? null;
      if (!recovered.has(threadId) || runId === null || recovered.get(threadId) !== runId) {
        yield* pauseThread(link, model, outage.message, runId);
      }
    } else if (link.paused !== null) yield* store.putThreadLink({ ...link, paused: null });
    // Discussions the thread evaluates, or is still typing or owing in after
    // being told something there (which the link and card don't name).
    const failedRun =
      link.role === "evaluator" && failure?.runId
        ? yield* threads.compactRun(threadId, failure.runId)
        : null;
    const ownerDiscussion = failedRun
      ? yield* ownerReplyDiscussion(store, failedRun.messageId ?? "", failedRun.message ?? "")
      : null;
    const recoveryPost = postRecoveryIdentity(failedRun?.messageId ?? "");
    let discussionAttempted = false;
    for (const discussion of yield* store.discussions(link.boardId)) {
      const participant = discussion.participants.find(
        (candidate) =>
          (candidate.actor._tag === "thread" || candidate.actor._tag === "evaluator") &&
          candidate.actor.threadId === threadId,
      );
      const pending =
        participant !== undefined &&
        (participant.typingUntil !== null || participant.owes !== null);
      if (
        !discussionIds.has(discussion.id) &&
        discussion.evaluatorThreadId !== threadId &&
        !pending
      ) {
        continue;
      }
      if (yield* isHome(discussion, threadId)) {
        // A failed run gets no discussion nudge: it would start another run on the same selection.
        if (failure === null) {
          const attempted: boolean = yield* settleWhenTurnEnds(
            discussion,
            threadId,
            discussionAttempted,
          );
          discussionAttempted ||= attempted;
        } else if (
          (participant?.deferred && participant.owes === "asked") ||
          (ownerDiscussion === discussion.id &&
            participant !== undefined &&
            participant.owes !== null)
        ) {
          if (participant.typingUntil !== null) {
            yield* saveDiscussion(
              withParticipant(discussion, participant.actor, participant.name, {
                typingUntil: null,
              }),
            );
          }
        } else if (participant && pending) {
          yield* saveDiscussion(
            withParticipant(discussion, participant.actor, participant.name, {
              owes: null,
              typingUntil: null,
            }),
          );
        }
        continue;
      }
      // Told something here, not put in charge: its typing ends without a nudge.
      if (participant && pending) {
        yield* saveDiscussion(
          withParticipant(discussion, participant.actor, participant.name, {
            owes: null,
            typingUntil: null,
          }),
        );
      }
    }

    if (link.role === "evaluator") {
      if (
        (failedRun?.messageId?.startsWith("kanban:wake:owner:") &&
          (ownerDiscussion === null ||
            (yield* ownerReplyPending(store, ownerDiscussion, threadId)) === null)) ||
        (failedRun?.messageId?.startsWith("kanban:post-recovery:") &&
          (recoveryPost === null ||
            !(yield* postRecoveryPending(store, recoveryPost.discussionId, recoveryPost.seq))))
      ) {
        if (failedRun?.messageId?.startsWith("kanban:post-recovery:")) {
          const current = yield* store.threadLink(threadId);
          if (current && current.paused?.runId === failure?.runId)
            yield* store.putThreadLink({ ...current, paused: null });
        }
        yield* Ref.update(evaluatorFailures, (all) => {
          const next = new Map(all);
          next.delete(threadId);
          return next;
        });
        return;
      }
      const entry = (yield* Ref.get(evaluatorFailures)).get(threadId);
      // A clean run clears the thread's failure state and frees its discussions for a fresh replacement.
      if (failure === null) {
        // lastFailure is also null while the latest run is still going or waiting on
        // input/approval, and a delayed terminal event for an older run must not clear
        // a live retry's streak. Only a thread that is idle has finished its run. A gone
        // thread (null view) counts as finished, so its one-shot link still ends.
        const state = (yield* threads.view(threadId))?.state;
        if (state !== undefined && state !== "idle") return;
        yield* Ref.update(evaluatorFailures, (all) => {
          const next = new Map(all);
          next.delete(threadId);
          return next;
        });
        for (const discussion of yield* store.discussions(link.boardId)) {
          if (discussion.evaluatorThreadId !== threadId) continue;
          yield* Ref.update(replaced, (all) => {
            const next = new Set(all);
            next.delete(discussion.id);
            return next;
          });
          // A card held for this evaluator's decision after its wait ended: the turn
          // it was told in is over, so whatever it left the card as stands.
          yield* endDeciding(discussion.cardId, { told: true });
        }
      }
      // A paused evaluator stays open so it can be woken, and a retry keeps the link
      // open so the run after it can end it. `link` is stale once its pause was set
      // or cleared above, so the current row is ended.
      const endLink = Effect.gen(function* () {
        if (link.discussionId !== null || link.endedAt !== null) return;
        const current = (yield* store.threadLink(threadId)) ?? link;
        yield* store.putThreadLink({ ...current, endedAt: at });
      });
      if (failure === null) {
        yield* endLink;
        return;
      }
      if (outage !== null) {
        // An outage pauses the thread for probeOutages; a retry scheduled before it must not fire.
        // Parked, not deleted: the streak survives until a clean run, and the next
        // non-outage failure after the probe still hands off instead of retrying.
        if (entry !== undefined && entry.state === "retry") {
          yield* Ref.update(evaluatorFailures, (all) =>
            new Map(all).set(threadId, { ...entry, state: "paused" }),
          );
        }
        return;
      }
      if (entry?.state === "gone") {
        yield* endLink;
        return;
      }
      // The same executed run can be reported twice (a repeated turn-end or a metadata update).
      if (entry !== undefined && failure.runId != null && entry.runId === failure.runId) return;
      if (failure.code === "model_refusal") {
        const category = /\[([^\]]+)\]/.exec(failure.message)?.[1];
        const model =
          (failure.model ?? link.model ?? (yield* threads.model(threadId)))?.model ??
          "unknown model";
        yield* evaluatorGiveUp(
          link,
          `safeguard refusal${category === undefined ? "" : ` [${category}]`} on ${model}: ${failure.message}`,
          recoveryPost ?? undefined,
          { model },
        );
        return;
      }
      if (entry !== undefined || Rules.isContextFull(failure)) {
        yield* evaluatorGiveUp(link, failure.message, recoveryPost ?? undefined);
        return;
      }
      const dueAt = (yield* nowMillis) + Rules.EVALUATOR_RETRY_MS;
      yield* Ref.update(evaluatorFailures, (all) =>
        new Map(all).set(threadId, {
          dueAt,
          message: failure.message,
          state: "retry",
          runId: failure.runId ?? null,
          ...(ownerDiscussion === null ? {} : { ownerDiscussion }),
          ...(recoveryPost === null ? {} : { recoveryPost }),
        }),
      );
      return;
    }
    const system: KanbanActor = { _tag: "system", component: "dispatcher" };
    const held = (yield* Ref.get(holds)).get(threadId);
    if (held !== undefined) {
      // A terminal event may belong to a cancelled queued wake or an older run.
      // Confirm the current turn ended before giving its between-card slot away.
      const current = yield* freshThreads.find(threadId);
      if (!holdIsLive(held, current, yield* nowMillis)) {
        yield* dropHold(threadId, "hold_end", null, held);
        yield* kick;
      }
    }
    if (link.role === "work") {
      const carried = yield* Effect.forEach(yield* store.cardsByThread(threadId), (entry) =>
        syncPrs(entry, expectedFailedWorkRunId === undefined ? undefined : failedRunIsCurrent),
      );
      if (carried.length === 0) {
        yield* kick;
        return;
      }
      // Paused: the card keeps its thread until probeOutages wakes it.
      if (outage !== null) return;
      if (failure !== null && Rules.isRuntimeFailure(failure)) {
        const fresh = yield* freshThreads.find(threadId);
        if (yield* skipRestartRecovery(threadId, carried, fresh)) return;
        if (fresh?.state !== "idle" || !(yield* failedRunIsCurrent())) return;
        const latestFailure = yield* freshThreads.findLastFailure(threadId);
        if (failure.runId == null || latestFailure?.runId !== failure.runId) return;
        const now = yield* nowMillis;
        const due = carried.filter((entry) => Rules.failedTurnResumeDue(entry, fresh, now));
        if (due.length > 0) yield* nudgeWorker(threadId, due, failure.runId);
        return;
      }
      if (failure !== null) {
        // Pending work keeps a deferred wait owned until a later idle turn end.
        const recovering = carried.filter((entry) => !Rules.workerWaitDeferred(entry));
        if (recovering.length === 0) return;
        const reason = `Run failed: ${failure.message}`;
        const hasCurrentCarriedWork = Effect.fn("KanbanService.hasCurrentCarriedWork")(
          function* () {
            if (!(yield* failedRunIsCurrent())) return false;
            let eligible = false;
            for (const entry of recovering) {
              const current = yield* store.card(entry.id);
              if (
                current !== null &&
                current.stage === "working" &&
                current.activeRole === "work" &&
                current.activeThreadId === threadId &&
                current.stalled === null &&
                !Rules.workerWaitDeferred(current)
              )
                eligible = true;
            }
            return eligible && (yield* failedRunIsCurrent());
          },
        );
        const recentCompactions = yield* Effect.forEach(recovering, (entry) =>
          compactedRecently(entry, at),
        );
        const hasRecentCompaction = recentCompactions.some(Boolean);
        const candidates =
          Rules.isContextFull(failure) && !Rules.isHandoffBudget(failure) && !hasRecentCompaction
            ? yield* Effect.filter(recovering, (entry) =>
                freshStartedRecently(entry, at).pipe(Effect.map((recent) => !recent)),
              )
            : [];
        // One maintenance turn covers every card sharing this thread. Start it
        // only when idle: a queued turn could be held behind the failed run.
        const found = candidates.length > 0 ? yield* Effect.result(threads.find(threadId)) : null;
        if (found?._tag === "Failure") return;
        const view = found?.success ?? null;
        if (view !== null && view.state !== "idle") return;
        if (expectedFailedWorkRunId !== undefined && !(yield* hasCurrentCarriedWork())) return;
        // The send-then-save gap is accepted: a crash leaves /compact's turn
        // end to normal handling (usually a nudge or flag).
        const compactSent =
          view?.state === "idle"
            ? yield* Effect.result(threads.send({ threadId, text: "/compact" }))
            : null;
        for (const oldEntry of recovering) {
          if (
            expectedFailedWorkRunId === undefined &&
            !sameCardState(yield* store.card(oldEntry.id), oldEntry)
          )
            continue;
          let entry = oldEntry;
          if (expectedFailedWorkRunId !== undefined) {
            const current = yield* store.card(entry.id);
            if (
              current === null ||
              current.stage !== "working" ||
              current.activeRole !== "work" ||
              current.activeThreadId !== threadId ||
              current.stalled !== null ||
              Rules.workerWaitDeferred(current)
            )
              continue;
            entry = current;
            if (compactSent?._tag === "Success") {
              // The accepted maintenance turn replaces the failed run; only its
              // own recorded run may release these cards after the send.
              if (typeof compactSent.success !== "string") return;
              const latest = yield* Effect.result(threads.latestRun(threadId));
              if (Result.isFailure(latest) || latest.success?.runId !== compactSent.success) return;
            } else if (!(yield* failedRunIsCurrent())) return;
          }
          if (
            compactSent?._tag === "Success" &&
            candidates.some((candidate) => candidate.id === entry.id)
          ) {
            const compacting: KanbanCard = {
              ...release(entry),
              stage: "todo",
              stalled: null,
              nudgedAt: null,
              // Preserve queue age and any parked wait during recovery.
              updatedAt: at,
            };
            yield* logEvent(compacting, system, "moved", {
              fromStage: entry.stage,
              toStage: "todo",
              body: `${COMPACT_FIRST}: ${failure.message}${
                typeof compactSent.success === "string"
                  ? ` [compact-run ${compactSent.success}]`
                  : ""
              }`,
            });
            yield* saveCard(compacting);
            continue;
          }
          // A thread too long to send again can't run the card: the next
          // dispatch starts it on a fresh thread.
          const startFresh =
            Rules.isContextFull(failure) && !(yield* freshStartedRecently(entry, at));
          if (expectedFailedWorkRunId !== undefined) {
            const current = yield* store.card(entry.id);
            if (
              current === null ||
              current.stage !== "working" ||
              current.activeRole !== "work" ||
              current.activeThreadId !== threadId ||
              current.stalled !== null ||
              Rules.workerWaitDeferred(current)
            )
              continue;
            entry = current;
          }
          if (startFresh) {
            if (
              expectedFailedWorkRunId !== undefined &&
              compactSent?._tag !== "Success" &&
              !(yield* failedRunIsCurrent())
            )
              return;
            const fresh: KanbanCard = {
              ...release(entry),
              stage: "todo",
              workThreadId: null,
              stalled: null,
              nudgedAt: null,
              wakeNote: withFreshNote(entry.wakeNote),
              // Preserve queue age and any parked wait during recovery.
              updatedAt: at,
            };
            yield* logEvent(fresh, system, "moved", {
              fromStage: entry.stage,
              toStage: "todo",
              body: `${FRESH_START}: ${failure.message}`,
            });
            yield* saveCard(fresh);
            continue;
          }
          // The first failure a retry can help is run again once (see Retries): the
          // card goes back to To-Do unflagged, with its thread and no slot. The
          // dispatcher holds it back for the backoff, then wakes the same thread like
          // any other start. Anything else is flagged.
          const retry = Retries.decideRetry({
            kind: "run_failed",
            role: "work",
            failure,
            retries: entry.retries,
            paused: Retries.heldByPause(yield* boardOf(entry.boardId), entry),
            nowMs: Date.parse(at),
            at,
            startedAtMs: Date.parse(entry.movedAt),
          });
          if (retry._tag === "hold") continue;
          const next: KanbanCard =
            retry._tag === "wait"
              ? {
                  ...release(entry),
                  stage: "todo",
                  stalled: null,
                  nudgedAt: null,
                  retries: retry.retries,
                  wakeNote: Retries.withRetryNote(entry.wakeNote, failure.message),
                  // movedAt stays: back in the queue the card keeps the age it had.
                  updatedAt: at,
                }
              : {
                  ...Retries.withoutRetries(release(entry)),
                  stage: "todo",
                  stalled: { reason, by: system, at },
                  nudgedAt: null,
                  // Preserve queue age and any parked wait during recovery.
                  updatedAt: at,
                };
          if (
            expectedFailedWorkRunId !== undefined &&
            compactSent?._tag !== "Success" &&
            !(yield* failedRunIsCurrent())
          )
            return;
          if (retry._tag === "wait") {
            yield* logEvent(next, system, "moved", {
              fromStage: entry.stage,
              toStage: "todo",
              body: `${Retries.RETRYING_EVENT}: ${failure.message}`,
            });
            yield* saveCard(next);
            continue;
          }
          yield* logEvent(next, system, "flagged", {
            fromStage: entry.stage,
            toStage: "todo",
            body: reason,
          });
          yield* saveCard(next);
          yield* noteDiscussion(
            next,
            Briefs.runFailedText(next, "work", failure.message, "todo"),
          ).pipe(
            Effect.provideService(EvaluatorAnalytics.origin, "stall_run_failure"),
            Effect.catchCause((cause) => Effect.logWarning("kanban run note failed", { cause })),
          );
        }
        yield* kick;
        return;
      }
      // A card can't sit in Working while its worker is stopped: every quiet
      // turn end nudges it (see nudgeWorker).
      const view = yield* threads.view(threadId);
      if (yield* skipRestartRecovery(threadId, carried, view)) return;
      // A repeated run event can arrive while the thread runs again.
      if (view === null || view.state !== "idle") return;
      // The run ended without failing: a retry it was on is over, and the next
      // failure on these cards gets its own.
      const settled = yield* Effect.forEach(carried, (entry) => {
        const cleared = Retries.withoutRoleRetries(entry, "work");
        if (cleared === entry) return Effect.succeed(entry);
        const next: KanbanCard = { ...cleared, updatedAt: at };
        return saveCard(next).pipe(Effect.as(next));
      });
      observeBackground(link.boardId, threadId, view, yield* nowMillis);
      if (
        [...(backgroundWaits.get(threadId)?.jobs.values() ?? [])].some(
          (job) => job.endedAt !== null,
        )
      )
        return;
      // A worker waiting on its own subagents hasn't stopped.
      if (Rules.waitingOnBackground(view, yield* nowMillis)) return;
      if (discussionAttempted) return;
      yield* nudgeWorker(threadId, settled);
      return;
    }
    if (!card) return;
    if (card.activeThreadId !== threadId) {
      yield* kick;
      return;
    }
    if (outage !== null) return;
    if (failure !== null) {
      const startFresh = Rules.isContextFull(failure) && !(yield* freshStartedRecently(card, at));
      if (expectedFailedWorkRunId !== undefined) {
        const current = yield* store.card(card.id);
        if (
          current === null ||
          current.stage !== "in_review" ||
          current.activeRole !== "review" ||
          current.activeThreadId !== threadId ||
          current.stalled !== null ||
          !(yield* failedRunIsCurrent())
        )
          return;
        card = current;
      }
      if (startFresh) {
        yield* endReviewLink(card.reviewThreadId, at);
        const fresh: KanbanCard = {
          ...release(card),
          stage: "needs_review",
          reviewThreadId: null,
          stalled: null,
          nudgedAt: null,
          // Preserve queue age and any parked wait during recovery.
          updatedAt: at,
        };
        yield* logEvent(fresh, system, "moved", {
          fromStage: card.stage,
          toStage: "needs_review",
          body: `${FRESH_START}: ${failure.message}`,
        });
        yield* saveCard(fresh);
        yield* kick;
        return;
      }
      const reason = `Run failed: ${failure.message}`;
      // As for a worker: the first failure a retry can help is run again once. The
      // card goes back to Needs review with no slot and waits out the backoff there.
      const retry = Retries.decideRetry({
        kind: "run_failed",
        role: "review",
        failure,
        retries: card.retries,
        paused: Retries.heldByPause(yield* boardOf(card.boardId), card),
        nowMs: Date.parse(at),
        at,
        startedAtMs: Date.parse(card.movedAt),
      });
      if (retry._tag === "hold") return;
      yield* endReviewLink(card.reviewThreadId, at);
      if (retry._tag === "wait") {
        const waiting: KanbanCard = {
          ...release(card),
          stage: "needs_review",
          stalled: null,
          nudgedAt: null,
          retries: retry.retries,
          // movedAt stays: back in the queue the card keeps the age it had.
          updatedAt: at,
        };
        yield* logEvent(waiting, system, "moved", {
          fromStage: card.stage,
          toStage: waiting.stage,
          body: `${Retries.RETRYING_EVENT}: ${failure.message}`,
        });
        yield* saveCard(waiting);
        yield* kick;
        return;
      }
      const next: KanbanCard = {
        ...Retries.withoutRetries(release(card)),
        stage: "needs_review",
        stalled: { reason, by: system, at },
        nudgedAt: null,
        // Preserve queue age and any parked wait during recovery.
        updatedAt: at,
      };
      yield* logEvent(next, system, "flagged", {
        fromStage: card.stage,
        toStage: next.stage,
        body: reason,
      });
      yield* saveCard(next);
      yield* noteDiscussion(
        next,
        Briefs.runFailedText(next, "review", failure.message, "needs_review"),
      ).pipe(
        Effect.provideService(EvaluatorAnalytics.origin, "stall_run_failure"),
        Effect.catchCause((cause) => Effect.logWarning("kanban run note failed", { cause })),
      );
      yield* kick;
      return;
    }
    // Run updates repeat after a run ends (its checkpoint lands later), so an
    // end heard while the thread runs again is an earlier turn's, such as the
    // chain step before the one now running in this thread.
    const latest = yield* threads.view(threadId);
    if (latest !== null && latest.state !== "idle") return;
    // Its own subagents still run: their results wake it, so it hasn't stopped.
    if (latest !== null && Rules.waitingOnBackground(latest, yield* nowMillis)) return;
    if (discussionAttempted) return;
    yield* reviewerStopped(card, threadId);
  });

  const turnEndRecovered = Effect.fn("KanbanService.turnEndRecovered")(function* (
    threadId: ThreadId,
  ) {
    if ((yield* Ref.get(unresolvedTurnEnds)).has(threadId)) return;
    const previous = yield* Ref.modify(turnEndConflicts, (all) => {
      const next = new Map(all);
      next.delete(threadId);
      return [all.get(threadId), next];
    });
    if (previous)
      yield* Effect.logInfo("kanban turn end recovered", {
        boardId: previous.link.boardId,
        cardId: previous.link.cardId,
        threadId,
      });
  });

  const turnEndedUnlocked = (
    threadId: ThreadId,
    runId?: string,
    retry = false,
    startTimeout?: StartTimeout,
  ) =>
    serial(turnEnding, threadId, finishTurn(threadId, runId, retry, startTimeout)).pipe(
      Effect.catchDefect((defect) =>
        Effect.gen(function* () {
          if (defect instanceof BoardLocks.BoardStateChanged)
            yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
          return yield* Effect.die(defect);
        }),
      ),
      Effect.tap(() => turnEndRecovered(threadId)),
    );

  const tickStep = Effect.fn("KanbanService.tickStep")(function* <A, E, R>(
    boardId: string,
    step: string,
    effect: Effect.Effect<A, E, R>,
    cardId?: string,
    turnEnd?: KanbanThreadLink,
  ) {
    yield* Effect.annotateCurrentSpan({ "kanban.board_id": boardId, "kanban.tick_step": step });
    return yield* TickTimings.measure(
      /discussion|nudge/i.test(step)
        ? "discussion_updates"
        : /pool/i.test(step)
          ? "pool_accounting"
          : /wait|block|depend/i.test(step)
            ? "dependency_checks"
            : "card_evaluation",
      locks.step(effect, cardId, `KanbanService.tickStep:${step}`).pipe(
        Effect.map(Option.some),
        Effect.catchDefect((defect) =>
          Effect.gen(function* () {
            if (!(defect instanceof BoardLocks.BoardStateChanged)) return yield* Effect.die(defect);
            if (turnEnd) {
              const previous = (yield* Ref.get(turnEndConflicts)).get(turnEnd.threadId);
              if (previous?.committed === defect.committed) return Option.none<A>();
              yield* Ref.update(turnEndConflicts, (all) =>
                new Map(all).set(turnEnd.threadId, { committed: defect.committed, link: turnEnd }),
              );
            }
            yield* Effect.logWarning("kanban tick step skipped", {
              boardId,
              step,
              cardId: cardId ?? turnEnd?.cardId ?? null,
              ...(turnEnd ? { threadId: turnEnd.threadId, committed: defect.committed } : {}),
            });
            return Option.none<A>();
          }),
        ),
      ),
    );
  });

  const overdueWaitWarnings = new Map<string, { boardId: string; at: string }>();
  const localWaitPasses = new Set<string>();
  // These checks only need board state. In particular, do not put them behind
  // evaluator delivery, thread reads, or the running maintenance tick's guard.
  const tickLocalWaits = Effect.fn("KanbanService.tickLocalWaits")(function* (board: KanbanBoard) {
    const boardId = board.id;
    if (!Waits.WAITS_ENGINE_WIRED || localWaitPasses.has(boardId)) return;
    localWaitPasses.add(boardId);
    const started = yield* nowMillis;
    const stats = { parked: 0, checked: 0, ended: 0, expired: 0, failed: 0, overdue: 0 };
    const checkedCards: number[] = [];
    const failedCards: number[] = [];
    const overdueCards: number[] = [];
    yield* Effect.gen(function* () {
      if (board.archivedAt !== null) return;
      const all = yield* store.openCards(board.id);
      const parked = all.filter((card) => card.wait !== undefined && card.activeThreadId === null);
      stats.parked = parked.length;
      const waitCards = new Map(all.map((card) => [card.id as string, card]));
      const boardNames = new Map<KanbanBoardId, string>();
      const facts: Waits.WaitFacts = {
        nowMs: started,
        prs: [],
        cards: waitCards,
      };
      for (const id of new Set(
        parked.flatMap((card) =>
          card.wait?.on === "card" && card.wait.card !== null ? [card.wait.card] : [],
        ),
      )) {
        if (waitCards.has(id)) continue;
        const dependency = yield* store.card(KanbanCardId.make(id));
        if (dependency) waitCards.set(id, yield* waitTargetFacts(dependency, board.id, boardNames));
      }
      const pending = new Map(parked.map((card) => [card.id, card]));
      const deliveryLanes = new Set<string>();
      const timed = new Set(
        all.filter((card) => card.wait?.on === "time").map((card) => card.id as string),
      );
      for (const [id, warning] of overdueWaitWarnings) {
        if (warning.boardId === boardId && !timed.has(id)) overdueWaitWarnings.delete(id);
      }
      for (const card of parked) {
        if (card.wait?.on !== "time" && card.wait?.on !== "card" && card.wait?.on !== "owner_go")
          continue;
        stats.checked += 1;
        checkedCards.push(card.number);
        const quiet = Waits.resolveWait(
          card,
          facts,
          {
            chainLength: Rules.chainFor(board, card)?.steps.length ?? 1,
          },
          yield* nowIso,
        );
        if (quiet._tag === "none" || (quiet._tag === "hold" && quiet.save === null)) continue;
        const outcome = yield* Effect.result(
          tickStep(
            boardId,
            "localWait",
            Effect.gen(function* () {
              const freshBoard = yield* boardOf(boardId);
              if (freshBoard.archivedAt !== null) return "none";
              const current = yield* store.card(card.id);
              if (!current || current.activeThreadId !== null || current.wait === undefined)
                return "none";
              // The wait may have been replaced since planning, including by a PR wait.
              if (
                current.wait.on !== "time" &&
                current.wait.on !== "card" &&
                current.wait.on !== "owner_go"
              )
                return "none";
              const cards = new Map(facts.cards);
              for (const id of new Set([
                ...(current.wait.card === null ? [] : [current.wait.card]),
                ...current.blockedBy,
              ])) {
                const dependency = yield* store.card(KanbanCardId.make(id));
                if (dependency)
                  cards.set(id, yield* waitTargetFacts(dependency, board.id, boardNames));
                else cards.delete(id);
              }
              const now = yield* nowMillis;
              const resolved = Waits.resolveWait(
                current,
                { ...facts, nowMs: now, cards },
                {
                  chainLength: Rules.chainFor(freshBoard, current)?.steps.length ?? 1,
                },
                yield* nowIso,
              );
              // Save the ended wait and its notification together. Delivery must
              // never keep the next local check behind thread I/O.
              const sink: EffectSink = { effects: [], closed: false };
              const publications: Array<BoardPublication> = [];
              const measurements: AnalyticsEvent[] = [];
              if (resolved._tag === "hold") {
                if (resolved.save !== null) yield* prepareTransition(resolved.save);
              } else if (resolved._tag !== "none") yield* prepareTransition(resolved.card);
              const lanes = yield* boardTransaction(
                boardId,
                Effect.gen(function* () {
                  yield* applyWaitStep(resolved, { _tag: "system", component: "waits" });
                  return yield* saveEffectRows(sink.effects);
                }).pipe(
                  Effect.provideService(effectSink, sink),
                  Effect.provideService(publicationSink, publications),
                  Effect.provideService(analyticsSink, measurements),
                  Effect.ensuring(
                    Effect.sync(() => {
                      sink.closed = true;
                    }),
                  ),
                ),
              );
              // Consumers can read or run scripts as soon as a change is published.
              // Nothing from a rolled-back wait or discussion may reach them.
              for (const measurement of measurements) yield* recordAnalytics(measurement);
              for (const publication of publications)
                yield* publish(publication.boardId, publication.change);
              for (const lane of lanes) deliveryLanes.add(lane);
              return resolved._tag;
            }),
            card.id,
          ),
        );
        if (Result.isFailure(outcome) || Option.isNone(outcome.success)) {
          stats.failed += 1;
          failedCards.push(card.number);
        } else if (outcome.success.value === "end") {
          stats.ended += 1;
          pending.delete(card.id);
        } else if (outcome.success.value === "expire") {
          stats.expired += 1;
          pending.delete(card.id);
        }
        if (Result.isFailure(outcome) || Option.isNone(outcome.success)) {
          const persisted = yield* store.card(card.id);
          if (persisted) pending.set(card.id, persisted);
          else pending.delete(card.id);
        }
      }
      // Read persisted state: an attempted end whose save failed is still overdue
      // and is retried from the row on the next tick, with no in-memory completion.
      const now = yield* nowMillis;
      for (const card of pending.values()) {
        const wait = card.wait;
        if (wait?.on !== "time" || card.activeThreadId !== null || wait.expiredAt !== null)
          continue;
        const overdueMs = now - Date.parse(wait.until ?? "");
        if (overdueMs > 2 * 60_000) overdueCards.push(card.number);
        if (overdueMs > 5 * 60_000 && overdueWaitWarnings.get(card.id)?.at !== wait.at) {
          overdueWaitWarnings.set(card.id, { boardId, at: wait.at });
          yield* Effect.logWarning("kanban time wait overdue", {
            boardId,
            card: card.number,
            until: wait.until,
            overdueMs,
          });
        }
      }
      stats.overdue = overdueCards.length;
      for (const lane of deliveryLanes) yield* triggerOwnerDrain(lane);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban local wait pass failed", { boardId, cause }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              stats.failed += 1;
            }),
          ),
        ),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          const durationMs = (yield* nowMillis) - started;
          yield* Effect.annotateCurrentSpan({
            "kanban.board_id": boardId,
            ...stats,
            durationMs,
            overdueCards,
          });
          const decodeCache = yield* store.decodeCacheStats;
          yield* Effect.annotateCurrentSpan("kanban.decode_cache", decodeCache);
          yield* Effect.logInfo("kanban wait pass", {
            decodeCache,
            boardId,
            scope: "local",
            ...stats,
            durationMs,
            checkedCards,
            failedCards,
            overdueCards,
          });
          localWaitPasses.delete(boardId);
        }),
      ),
    );
  });

  /** One board's maintenance before its own dispatch. */
  const tickSteps = Effect.fn("KanbanService.tickSteps")(function* (
    boardId: string,
    turnEndLinks: ReadonlyMap<string, KanbanThreadLink>,
  ) {
    // Config survives only this pass. Keep the board/epoch dependencies in every
    // step, and reread after a board write or migration (including a step rerun).
    let config: { board: KanbanBoard | null; version: number; epoch: number } | undefined;
    const readTickBoard = locks.access(
      boardId,
      Effect.gen(function* () {
        const version = yield* locks.resourceVersion(boardId, "board");
        const epoch = yield* locks.resourceVersion(boardId, "epoch");
        if (config === undefined || config.version !== version || config.epoch !== epoch) {
          const board = yield* rawStore.board(KanbanBoardId.make(boardId));
          config = { board, version, epoch };
        }
        return config.board;
      }),
      false,
      "board",
    );
    const tickBoardOf = Effect.gen(function* () {
      const board = yield* readTickBoard;
      if (!board)
        return yield* failWith(
          "not-found",
          `board ${boardId}`,
          "resource_not_found",
          "not_found",
          "boardId",
        );
      return board;
    });
    const now = yield* nowMillis;
    // A launch already owns this drain; maintenance must still see its persisted
    // deciding hold while provider I/O is pending.
    let evaluatorMutex = evaluating.get(boardId);
    if (!evaluatorMutex) {
      evaluatorMutex = Semaphore.makeUnsafe(1);
      evaluating.set(boardId, evaluatorMutex);
    }
    yield* locks
      .outside(
        evaluatorMutex.withPermitsIfAvailable(1)(
          locks.fresh(locks.run(drainEvaluatorQueue(KanbanBoardId.make(boardId)))),
        ),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban evaluator queue delivery pending", { boardId, cause }),
        ),
      );
    for (const threadId of yield* Ref.get(unresolvedTurnEnds)) {
      const planned = turnEndLinks.get(threadId);
      const link =
        planned === undefined
          ? null
          : yield* locks.access(planned.boardId, Effect.succeed(planned));
      if (link?.boardId !== boardId) continue;
      const result = yield* serialEach(
        turnEnding,
        threadId,
        tickStep(boardId, "turnEnd", finishTurn(threadId, undefined, true), undefined, link),
        false,
      );
      if (Option.isNone(result))
        yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
      else yield* turnEndRecovered(threadId);
    }
    // This is planning data only. A failed read must remain distinct from a
    // successful absence, and nothing survives this invocation of the tick.
    const makeViews = () => {
      const views = new Map<ThreadId, KanbanThreadView | null>();
      // Cleanup must not use an idle reading taken before a concurrent wake.
      const viewFences = new Map<ThreadId, number>();
      const freshFind = (threadId: ThreadId) =>
        threads.find(threadId).pipe(
          Effect.map((view) => Option.some(view)),
          Effect.catch(() => Effect.succeed(Option.none<KanbanThreadView | null>())),
          Effect.tap(() =>
            Effect.sync(() => {
              views.delete(threadId);
            }),
          ),
        );
      const confirmFind = (threadId: ThreadId) =>
        Effect.suspend(() => {
          const fence = threadFences.get(threadId) ?? 0;
          return freshFind(threadId).pipe(
            Effect.tap((found) =>
              Effect.sync(() => {
                if (Option.isSome(found)) {
                  views.set(threadId, found.value);
                  viewFences.set(threadId, fence);
                }
              }),
            ),
          );
        });
      const planFind = (threadId: ThreadId) =>
        Effect.suspend(() => {
          if (views.has(threadId)) return Effect.succeed(Option.some(views.get(threadId)!));
          const fence = threadFences.get(threadId) ?? 0;
          return freshFind(threadId).pipe(
            Effect.tap((found) =>
              Effect.sync(() => {
                if (Option.isSome(found)) {
                  views.set(threadId, found.value);
                  viewFences.set(threadId, fence);
                }
              }),
            ),
          );
        });
      const planView = (threadId: ThreadId) =>
        planFind(threadId).pipe(Effect.map((found) => Option.getOrNull(found)));
      return { views, viewFences, freshFind, confirmFind, planFind, planView };
    };
    const { views, freshFind, planFind, planView } = makeViews();
    // Ordinary between-card holds expire; preserved assignments still occupy a live turn.
    for (const [threadId, held] of yield* Ref.get(holds)) {
      if (held.boardId !== boardId) continue;
      const view = yield* planView(threadId);
      const keep = holdIsLive(held, view, now);
      if (!keep) {
        const current = yield* freshFind(threadId);
        if (Option.isNone(current)) continue;
        if (holdIsLive(held, current.value, now)) continue;
        views.delete(threadId);
        yield* dropHold(threadId, "hold_end", null, held);
        yield* kick;
      }
    }
    // A failed evaluator's one retry, once its wait is over.
    for (const [threadId, entry] of yield* Ref.get(evaluatorFailures)) {
      if (entry.state !== "retry" || entry.dueAt > now) continue;
      if ((yield* store.threadLink(threadId))?.boardId !== boardId) continue;
      const found = yield* planFind(threadId);
      if (Option.isNone(found)) continue;
      // Sending or changing the retry depends on the current run, not the plan.
      const fresh = yield* freshFind(threadId);
      if (Option.isNone(fresh)) continue;
      const view = fresh.value;
      if (!view || view.archived) {
        yield* Ref.update(evaluatorFailures, (all) => {
          const next = new Map(all);
          next.delete(threadId);
          return next;
        });
        continue;
      }
      const setState = (state: "sent") =>
        Ref.update(evaluatorFailures, (all) => new Map(all).set(threadId, { ...entry, state }));
      if (view.state !== "idle") {
        yield* setState("sent");
        continue;
      }
      const failure = yield* Effect.result(threads.findLastFailure(threadId));
      if (Result.isFailure(failure)) {
        yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
        continue;
      }
      if (
        failure.success === null ||
        (entry.runId !== null && failure.success.runId !== entry.runId)
      )
        continue;
      const action =
        entry.ownerDiscussion === undefined
          ? undefined
          : yield* ownerReplyPending(store, entry.ownerDiscussion, threadId);
      if (
        action === null ||
        (entry.recoveryPost !== undefined &&
          !(yield* postRecoveryPending(
            store,
            entry.recoveryPost.discussionId,
            entry.recoveryPost.seq,
          )))
      ) {
        yield* Ref.update(evaluatorFailures, (all) => {
          const next = new Map(all);
          next.delete(threadId);
          return next;
        });
        continue;
      }
      const sent = yield* threads
        .send({
          threadId,
          text: Briefs.evaluatorRetryText(entry.message),
          ...(entry.recoveryPost !== undefined
            ? {
                key: postRecoveryKey(
                  entry.recoveryPost.discussionId,
                  entry.recoveryPost.seq,
                  `${threadId}:automatic-retry:${entry.runId}`,
                ),
              }
            : entry.ownerDiscussion === undefined || action === undefined
              ? {}
              : {
                  key: `${ownerReplyKey(entry.ownerDiscussion, threadId, action)}:automatic-retry`,
                  coalesce: `owner:${entry.ownerDiscussion}`,
                }),
        })
        .pipe(
          Effect.provideService(EvaluatorAnalytics.origin, "stall_run_failure"),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("kanban evaluator retry failed", { threadId, cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
      views.delete(threadId);
      yield* setState("sent");
      if (!sent) {
        const link = yield* store.threadLink(threadId);
        if (link) {
          views.clear();
          yield* evaluatorGiveUp(link, entry.message, entry.recoveryPost);
          views.clear();
        }
      }
    }
    const missed = new Set<ThreadId>();
    const failedMissingReads = new Set<ThreadId>();
    const before = (yield* Ref.get(missing)).get(boardId) ?? new Set<ThreadId>();
    yield* locks.outside(
      Effect.forEach(
        [yield* readTickBoard].filter((board) => board !== null),
        (candidate) =>
          Effect.gen(function* () {
            let board = yield* tickBoardOf;
            if (board.archivedAt !== null) {
              for (const [threadId, wait] of backgroundWaits)
                if (wait.boardId === board.id) backgroundWaits.delete(threadId);
              return;
            }
            const { views, viewFences, freshFind, confirmFind, planFind, planView } = makeViews();
            const step = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, cardId?: string) =>
              tickStep(
                candidate.id,
                name,
                Effect.gen(function* () {
                  board = yield* tickBoardOf;
                  return yield* effect;
                }),
                cardId,
              );
            yield* wakeRecovered(board);
            yield* step(
              "reconcileHeldDiscussions",
              Effect.suspend(() => reconcileHeldDiscussions(board)),
            );
            // Attempted reminders retain precedence even when the step later conflicts.
            const discussionWakes = new Set<ThreadId>();
            yield* step(
              "wakeDiscussionNudges",
              Effect.suspend(() => wakeDiscussionNudges(board, discussionWakes)),
            );
            const deferredBoardThreads = yield* boardNudgeThreads(board.id);
            if (deferredBoardThreads.length > 0)
              yield* step(
                "wakeBoardNudges",
                Effect.suspend(() => wakeBoardNudges(board, discussionWakes, deferredBoardThreads)),
              );
            views.clear();
            let boardCards: ReadonlyArray<KanbanCard> | undefined;
            const cardsForPlan = Effect.suspend(() =>
              boardCards === undefined
                ? store.openCards(board.id).pipe(
                    Effect.tap((cards) =>
                      Effect.sync(() => {
                        boardCards = cards;
                      }),
                    ),
                  )
                : Effect.succeed(boardCards),
            );
            const invalidateCards = () => {
              boardCards = undefined;
            };
            const eligibleBackgroundWorkers = new Set(
              (yield* cardsForPlan).flatMap((card) =>
                card.stage === "working" && card.activeRole === "work" && card.activeThreadId
                  ? [card.activeThreadId]
                  : card.stage === "todo" && card.workThreadId
                    ? [card.workThreadId]
                    : [],
              ),
            );
            for (const [threadId, wait] of backgroundWaits)
              if (wait.boardId === board.id && !eligibleBackgroundWorkers.has(threadId))
                backgroundWaits.delete(threadId);
            const savedCard = (card: KanbanCard) => {
              if (boardCards !== undefined) {
                boardCards = boardCards
                  .map((existing) => (existing.id === card.id ? card : existing))
                  .filter((entry) => entry.settledAt === null);
              }
            };
            const updateCard = savedCard;
            yield* step(
              "scribe",
              Effect.gen(function* () {
                // The scribe regroups at most every SCRIBE_EVERY_MS, and only when open cards changed.
                const fingerprint = Scribe.groupsFingerprint(yield* cardsForPlan);
                const last = (yield* Ref.get(scribed)).get(board.id);
                const cooled = last === undefined || now - last.at >= Scribe.SCRIBE_EVERY_MS;
                // A failed attempt is retried once the cooldown has passed, cards changed or not.
                const due =
                  fingerprint !== "" &&
                  cooled &&
                  !(yield* Ref.get(groupsRunning)).has(board.id) &&
                  (last === undefined || !last.done || fingerprint !== last.fingerprint);
                if (due) {
                  yield* Ref.update(scribed, (all) =>
                    new Map(all).set(board.id, { fingerprint, at: now, done: false }),
                  );
                  yield* Ref.update(groupsRunning, (all) => new Set(all).add(board.id));
                  yield* forkGroups(board.id);
                }
                const goals = yield* store.goals(board.id);
                // Goal stories include finished cards; other maintenance plans only need open rows.
                const goalsPrint = Scribe.goalsFingerprint(
                  goals.some((goal) => goal.status === "active")
                    ? yield* store.cards(board.id)
                    : [],
                  goals,
                );
                const lastGoals = (yield* Ref.get(goalsScribed)).get(board.id);
                // A failed or held-back attempt is retried after the cooldown, cards unchanged or not.
                const goalsDue =
                  goalsPrint !== "" &&
                  !(yield* Ref.get(goalsRunning)).has(board.id) &&
                  (lastGoals === undefined || now - lastGoals.at >= Scribe.SCRIBE_EVERY_MS) &&
                  (lastGoals === undefined ||
                    !lastGoals.done ||
                    goalsPrint !== lastGoals.fingerprint);
                if (goalsDue) {
                  yield* Ref.update(goalsScribed, (all) =>
                    new Map(all).set(board.id, { fingerprint: goalsPrint, at: now, done: false }),
                  );
                  yield* Ref.update(goalsRunning, (all) => new Set(all).add(board.id));
                  yield* forkGoals(board.id);
                }
                // Goal ideas: checked every PROPOSAL_CHECK_MS per board, asked only when due.
                const checked = (yield* Ref.get(proposalsChecked)).get(board.id);
                const running = (yield* Ref.get(proposalsRunning)).has(board.id);
                if (
                  !running &&
                  (checked === undefined || now - checked >= Scribe.PROPOSAL_CHECK_MS)
                ) {
                  yield* Ref.update(proposalsChecked, (all) => new Map(all).set(board.id, now));
                  const ideas = yield* ideasDiscussion(board.id);
                  const last =
                    ideas === null
                      ? null
                      : ((yield* ideaMessages(ideas.id))
                          .filter((message) => message.author._tag === "system")
                          .at(-1) ?? null);
                  if (
                    Scribe.proposalDue(yield* cardsForPlan, yield* store.goals(board.id), last, now)
                  ) {
                    yield* Ref.update(proposalsRunning, (all) => new Set(all).add(board.id));
                    yield* forkProposals(board.id);
                  }
                }
              }),
            );
            // Repair stalled cards that held slots before flags released them.
            for (const initial of yield* cardsForPlan) {
              if (initial.stalled === null || initial.activeThreadId === null) continue;
              yield* step(
                "releaseStalled",
                Effect.gen(function* () {
                  const current = yield* store.card(initial.id);
                  if (
                    current === null ||
                    current.stalled === null ||
                    current.activeThreadId === null
                  )
                    return;
                  yield* letGo(current, false, "is stalled", {
                    until: "after the flag is cleared",
                    respectPause: true,
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("kanban stalled-slot thread release failed", {
                        cardId: current.id,
                        cause,
                      }),
                    ),
                  );
                  const next = releaseToQueue(current, yield* nowIso);
                  // Attribution also controls whether the old reviewer may submit a late verdict.
                  yield* logEvent(next, current.stalled.by, "flagged", {
                    fromStage: current.stage,
                    toStage: next.stage,
                    body: `Released stalled slot: ${current.stalled.reason}`,
                  });
                  yield* saveCard(next);
                  updateCard(next);
                }),
                initial.id,
              );
            }
            for (const initial of yield* cardsForPlan) {
              if (initial.stalled === null) continue;
              yield* step(
                "recheckReviewGate",
                Effect.gen(function* () {
                  const current = yield* store.card(initial.id);
                  if (current === null) return;
                  const next = yield* recheckReviewGate(current, board);
                  if (next !== current) updateCard(next);
                }),
                initial.id,
              );
            }
            // A card whose thread was deleted goes back to its queue for a new one.
            for (const initial of yield* cardsForPlan) {
              if (initial.activeThreadId === null) continue;
              yield* step(
                "missingThread",
                Effect.gen(function* () {
                  const card = yield* store.card(initial.id);
                  if (!card) return;

                  if (board.pause !== null && !board.pause.keep.includes(card.id)) return;
                  const threadId = card.activeThreadId;
                  if (threadId === null) return;
                  const planned = yield* planFind(threadId);
                  if (Option.isNone(planned)) {
                    failedMissingReads.add(threadId);
                    missed.delete(threadId);
                    return;
                  }
                  if (planned.value !== null) {
                    missed.delete(threadId);
                    return;
                  }
                  if (failedMissingReads.has(threadId)) return;
                  // A failed probe cannot count as a miss, even if an earlier read was absent.
                  const confirmed = yield* confirmFind(threadId);
                  if (Option.isNone(confirmed) || confirmed.value !== null) {
                    if (Option.isNone(confirmed)) failedMissingReads.add(threadId);
                    views.delete(threadId);
                    missed.delete(threadId);
                    return;
                  }
                  missed.add(threadId);
                  if (!before.has(threadId)) return;
                  const current = yield* store.card(card.id);
                  if (current === null || current.activeThreadId !== threadId) return;
                  const at = yield* nowIso;
                  const review = current.activeRole === "review";
                  const next: KanbanCard = {
                    ...release(current),
                    stage: review ? "needs_review" : "todo",
                    workThreadId: review ? current.workThreadId : null,
                    reviewThreadId: review ? null : current.reviewThreadId,
                    // Preserve queue age and any parked wait during recovery.
                    updatedAt: at,
                  };
                  if (review) yield* endReviewLink(current.reviewThreadId, at);
                  yield* logEvent(next, { _tag: "system", component: "dispatcher" }, "moved", {
                    fromStage: current.stage,
                    toStage: next.stage,
                    body: "Its thread is gone",
                  });
                  yield* saveCard(next);
                  updateCard(next);
                }),
                initial.id,
              );
            }
            // The same backstop covers a running thread even after its card was detached.
            for (const initial of yield* cardsForPlan) {
              const threadFor = (card: KanbanCard) =>
                card.activeThreadId ??
                (card.stage === "todo"
                  ? card.workThreadId
                  : card.stage === "needs_review"
                    ? card.reviewThreadId
                    : null);
              const threadId = threadFor(initial);
              if (threadId === null || initial.stalled !== null) continue;
              // A stop can promote queued work, so a delivered steer stays visible until idle.
              if (
                waitingToRun(initial, now) &&
                (initial.detachedSteerAt === undefined || initial.workThreadId !== threadId)
              )
                continue;
              yield* step(
                "silentRunBackstop",
                Effect.gen(function* () {
                  const view = yield* planView(threadId);
                  if (view?.state === "idle" && initial.detachedSteerAt !== undefined) {
                    const card = yield* store.card(initial.id);
                    if (card?.detachedSteerAt !== initial.detachedSteerAt) return;
                    const settled = yield* settleDetachedSteer(
                      card,
                      view,
                      viewFences.get(threadId),
                    );
                    if (settled && settled !== card) updateCard(settled);
                    return;
                  }
                  if (view?.state !== "running") return;
                  const card = yield* store.card(initial.id);
                  if (!card || card.stalled !== null || threadFor(card) !== threadId) return;
                  if (board.pause && !board.pause.keep.includes(card.id)) return;
                  if (
                    card.stage === "working" &&
                    card.activeRole === "work" &&
                    (yield* skipRestartRecovery(threadId, [card], view))
                  )
                    return;
                  if (
                    (yield* Ref.get(unresolvedTurnEnds)).has(threadId) ||
                    discussionWakes.has(threadId) ||
                    (yield* store.threadLink(threadId))?.paused
                  )
                    return;
                  // Detached cards must never stop another card's worker, even across boards.
                  if (
                    card.activeThreadId === null &&
                    (yield* store.cardsByThread(threadId)).some((other) => other.id !== card.id)
                  )
                    return;
                  const due = Rules.runSilentDue(card, view, now);
                  if (!silentStops.has(card.id)) {
                    const event = (yield* store.cardEvents(card.id)).findLast(
                      (event) =>
                        event.kind === "thread" && event.body?.startsWith("No activity for "),
                    );
                    const match = event?.body?.match(/\nThread: ([^\n]+)\nRun: ([^\n]+)$/);
                    silentStops.set(
                      card.id,
                      event && match
                        ? { threadId: match[1]!, runId: match[2]!, at: event.at }
                        : null,
                    );
                  }
                  const previous = silentStops.get(card.id);
                  // Keep queue ownership in orchestration (#618/#812). A pre-clear wake
                  // promoted after our interrupt needs evaluator recovery, not queue deletion.
                  const stale =
                    previous != null &&
                    previous.threadId === threadId &&
                    view.runId != null &&
                    previous.runId !== view.runId &&
                    view.runRequestedAt != null &&
                    Date.parse(view.runRequestedAt) < Date.parse(previous.at);
                  if (!due && !stale) return;
                  const fresh = yield* freshFind(threadId);
                  const current = yield* store.card(card.id);
                  if (
                    Option.isNone(fresh) ||
                    fresh.value === null ||
                    !current ||
                    current.stalled !== null ||
                    threadFor(current) !== threadId ||
                    (board.pause && !board.pause.keep.includes(current.id)) ||
                    (yield* store.threadLink(threadId))?.paused ||
                    fresh.value.runId !== view.runId ||
                    fresh.value.state !== "running" ||
                    (current.activeThreadId === null &&
                      (yield* store.cardsByThread(threadId)).some(
                        (other) => other.id !== current.id,
                      ))
                  )
                    return;
                  if (
                    current.stage === "working" &&
                    current.activeRole === "work" &&
                    (yield* skipRestartRecovery(threadId, [current], fresh.value))
                  )
                    return;
                  if (!stale && !Rules.runSilentDue(current, fresh.value, now)) return;
                  const at = yield* nowIso;
                  const system: KanbanActor = { _tag: "system", component: "dispatcher" };
                  if (
                    stale ||
                    (previous != null && now - Date.parse(previous.at) <= 2 * Rules.RUN_SILENT_MS)
                  ) {
                    const reason = stale
                      ? "Stale queued runs on the thread"
                      : "Run went silent twice";
                    yield* endReviewLink(current.reviewThreadId, at);
                    const next = releaseToQueue(
                      { ...current, stalled: { reason, by: system, at } },
                      at,
                    );
                    yield* logEvent(next, system, "flagged", {
                      fromStage: current.stage,
                      toStage: next.stage,
                      body: reason,
                    });
                    yield* saveCard(next);
                    updateCard(next);
                    yield* kick;
                    return;
                  }
                  const minutes = Math.floor(
                    (now - Date.parse(fresh.value.lastActivityAt!)) / 60000,
                  );
                  const reason = `No activity for ${minutes} min; the board stopped the run`;
                  const runId = fresh.value.runId;
                  // A successful interrupt can't be replayed after a concurrent edit.
                  // Save its acknowledgement before reacquiring the original snapshot.
                  yield* interruptThread(
                    threadId,
                    reason,
                    false,
                    runId ?? undefined,
                    locks.fresh(
                      locks.run(
                        Effect.gen(function* () {
                          (yield* tickKicks)?.stoppedCards.add(current.id);
                          const stopped = yield* store.card(current.id);
                          if (!stopped) return;
                          yield* logEvent(stopped, system, "thread", {
                            body: `${reason}\nThread: ${threadId}\nRun: ${runId ?? "unknown"}`,
                          });
                          silentStops.set(current.id, {
                            threadId,
                            runId: runId ?? "unknown",
                            at,
                          });
                          if (threadFor(stopped) !== threadId) return;
                          yield* saveCard({ ...stopped, nudgedAt: at, updatedAt: at });
                        }),
                        current.id,
                      ),
                    ),
                    "task_stalled",
                  ).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        views.delete(threadId);
                        invalidateCards();
                      }),
                    ),
                  );
                }),
                initial.id,
              );
            }
            const routedQuestionThreads = new Set<ThreadId>();
            for (const initial of yield* cardsForPlan) {
              if (
                initial.activeThreadId === null ||
                (initial.activeRole !== "work" && initial.activeRole !== "review")
              )
                continue;
              yield* step(
                "nativeQuestion",
                Effect.gen(function* () {
                  const card = yield* store.card(initial.id);
                  if (!card || card.activeThreadId === null) return;
                  if (card.activeRole !== "work" && card.activeRole !== "review") return;
                  if (board.pause && !board.pause.keep.includes(card.id)) return;
                  const threadId = card.activeThreadId;
                  if ((yield* store.threadLink(threadId))?.paused) return;
                  const view = yield* planView(threadId);
                  if (view?.state !== "needs-input") return;
                  const requests = yield* threads
                    .pendingUserInputs(threadId)
                    .pipe(Effect.catchCause(() => Effect.succeed([])));
                  if (requests.length === 0) return;
                  const current = yield* store.card(card.id);
                  if (
                    current?.activeThreadId !== threadId ||
                    current.activeRole !== card.activeRole
                  )
                    return;
                  const events = yield* store.cardEvents(card.id);
                  for (const request of requests) {
                    // Include the thread in the persisted marker: providers may reuse request ids.
                    const body = `Asked its own question (request ${request.requestId}); sent to the evaluator\nThread: ${threadId}`;
                    const routed = events.some(
                      (event) =>
                        event.kind === "thread" &&
                        event.actor._tag === "system" &&
                        event.actor.component === "dispatcher" &&
                        event.body === body,
                    );
                    if (!routed) {
                      const text = [
                        `Card #${card.number}: ${card.title}`,
                        `Role: ${card.activeRole}`,
                        `Thread: [${view.title}](t3-thread://v1/${threadId})`,
                        `Request id: ${request.requestId}`,
                        ...request.questions.flatMap((question) => [
                          `${question.header}: ${question.question}`,
                          ...question.options.map(
                            (option) => `- ${option.label}: ${option.description}`,
                          ),
                        ]),
                        "This card's thread is waiting on its own question. Answer it with t3_pending_request_respond (threadId, requestId) when it's a call you can make. When it's Abdullah's call, ask him with card_ask and answer the thread with his reply. If the question no longer applies, steer the thread with card_thread.",
                      ].join("\n\n");
                      const key = `question:${NodeCrypto.createHash("sha256")
                        .update(
                          `${card.id.length}:${card.id}${threadId.length}:${threadId}${request.requestId}`,
                        )
                        .digest("hex")}`;
                      // Unlike a saved-write follow-up, routing must stop on a concurrent pause or unbind.
                      const sent = yield* Effect.result(
                        cardDiscussionUnlocked(current.id).pipe(
                          Effect.flatMap((discussion) =>
                            toEvaluator(
                              discussion,
                              text,
                              true,
                              undefined,
                              key,
                              Effect.gen(function* () {
                                const latestBoard = yield* boardOf(card.boardId);
                                const latestCard = yield* store.card(card.id);
                                return (
                                  latestCard?.activeThreadId === threadId &&
                                  latestCard.activeRole === card.activeRole &&
                                  (latestBoard.pause === null ||
                                    latestBoard.pause.keep.includes(card.id)) &&
                                  !(yield* store.threadLink(threadId))?.paused
                                );
                              }),
                            ),
                          ),
                          Effect.provideService(EvaluatorAnalytics.origin, "card_ask"),
                        ),
                      );
                      if (Result.isFailure(sent)) continue;
                      yield* logEvent(
                        current,
                        { _tag: "system", component: "dispatcher" },
                        "thread",
                        {
                          body,
                        },
                      );
                    }
                    routedQuestionThreads.add(threadId);
                  }
                }),
                initial.id,
              );
            }
            const backgroundRecoveryHolds = new Set<ThreadId>();
            for (const initial of yield* cardsForPlan) {
              const threadId =
                initial.activeRole === "work"
                  ? initial.activeThreadId
                  : initial.stage === "todo"
                    ? initial.workThreadId
                    : null;
              if (
                threadId === null ||
                initial.wait !== undefined ||
                Retries.heldForRetry(initial, now) ||
                (board.pause && !board.pause.keep.includes(initial.id))
              )
                continue;
              yield* step(
                "backgroundWakeBackstop",
                Effect.gen(function* () {
                  if ((yield* store.threadLink(threadId))?.paused) return;
                  const view = yield* planView(threadId);
                  if (view === null) return;
                  observeBackground(board.id, threadId, view, now);
                  const wait = backgroundWaits.get(threadId);
                  if (!wait) return;
                  const ended = [...wait.jobs].filter(([, job]) => job.endedAt !== null);
                  if (ended.length === 0) return;
                  backgroundRecoveryHolds.add(threadId);
                  if (!ended.some(([, job]) => now - job.endedAt! >= 120_000)) return;
                  if (yield* threads.backgroundStoppedSince(threadId, wait.quietSince)) {
                    backgroundWaits.delete(threadId);
                    return;
                  }
                  const fresh = yield* freshFind(threadId);
                  const current = yield* store.card(initial.id);
                  const carried = yield* store.cardsByThread(threadId);
                  const latestBoard = yield* boardOf(board.id);
                  if (
                    Option.isNone(fresh) ||
                    fresh.value?.state !== "idle" ||
                    fresh.value.quietSince !== wait.quietSince ||
                    current === null ||
                    (current.activeThreadId ?? current.workThreadId) !== threadId ||
                    !["working", "todo"].includes(current.stage) ||
                    current.wait !== undefined ||
                    Retries.heldForRetry(current, now) ||
                    kanbanOpenAsks(current).some((ask) => ask.blocking) ||
                    carried.some(
                      (card) =>
                        Retries.heldByPause(latestBoard, card) ||
                        card.wait !== undefined ||
                        kanbanOpenAsks(card).some((ask) => ask.blocking),
                    ) ||
                    waking(threadId) ||
                    (yield* threads.queuedRuns(threadId)).length > 0
                  )
                    return;
                  for (const [itemId, job] of ended) {
                    if (
                      now - job.endedAt! < 120_000 ||
                      fresh.value.backgroundJobs?.some((task) => task.taskId === itemId)
                    )
                      continue;
                    yield* sendThread({
                      threadId,
                      key: backgroundCommandWakeKey(threadId, itemId),
                      text: `Background work finished: ${job.label.slice(0, 200)}`,
                      mode: "queue",
                    });
                    wait.jobs.delete(itemId);
                    yield* logEvent(
                      current,
                      { _tag: "system", component: "dispatcher" },
                      "thread",
                      {
                        body: `Background work finished; woke its worker: ${job.label.slice(0, 200)}`,
                      },
                    );
                  }
                  if (wait.jobs.size === 0) backgroundWaits.delete(threadId);
                }),
                initial.id,
              );
            }
            // Backstop for a missed turn end, or a worker stuck on its own question.
            for (const initial of yield* cardsForPlan) {
              if (
                initial.activeThreadId === null ||
                initial.activeRole !== "work" ||
                initial.stalled !== null
              )
                continue;
              yield* step(
                "workerBackstop",
                Effect.gen(function* () {
                  const plannedCard = yield* store.card(initial.id);
                  if (!plannedCard) return;

                  const card = plannedCard;
                  const threadId = card.activeThreadId;
                  if (threadId === null || card.activeRole !== "work" || card.stalled !== null)
                    return;
                  if (board.pause && !board.pause.keep.includes(card.id)) return;
                  if ((yield* Ref.get(unresolvedTurnEnds)).has(threadId)) return;
                  if (discussionWakes.has(threadId) || backgroundRecoveryHolds.has(threadId))
                    return;
                  const view = yield* planView(threadId);
                  if (yield* skipRestartRecovery(threadId, [card], view)) return;
                  // Provider recovery owns nudges, but a deferred wait can park
                  // once the work that held it after the outage has drained.
                  if ((yield* store.threadLink(threadId))?.paused) {
                    yield* parkWorkerWaits(threadId, [card]);
                    const saved = yield* store.card(card.id);
                    if (saved) updateCard(saved);
                    else invalidateCards();
                    return;
                  }
                  const foundFailure = yield* Effect.result(threads.findLastFailure(threadId));
                  if (Result.isFailure(foundFailure)) {
                    yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
                    return;
                  }
                  if (foundFailure.success !== null) {
                    if (foundFailure.success.runId == null) {
                      yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
                      return;
                    }
                    const fresh = yield* freshFind(threadId);
                    const current = yield* store.card(card.id);
                    if (
                      Option.isNone(fresh) ||
                      fresh.value?.state !== "idle" ||
                      current?.activeThreadId !== threadId ||
                      current.activeRole !== "work" ||
                      current.stage !== "working" ||
                      current.stalled !== null ||
                      (board.pause !== null && !board.pause.keep.includes(current.id)) ||
                      (yield* store.threadLink(threadId))?.paused
                    )
                      return;
                    views.clear();
                    yield* turnEndedUnlocked(threadId, foundFailure.success.runId).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          views.clear();
                          invalidateCards();
                        }),
                      ),
                    );

                    return;
                  }
                  if (view === null || Rules.waitingOnBackground(view, now)) return;
                  const advanced = yield* advanceFinishedWorker(card);
                  if (advanced.stage !== "working" || advanced.activeThreadId !== threadId) {
                    updateCard(advanced);
                    views.delete(threadId);
                    return;
                  }
                  if (!Rules.workerQuietDue(card, view, now)) return;
                  const fresh = yield* freshFind(threadId);
                  const current = yield* store.card(card.id);
                  if (
                    Option.isNone(fresh) ||
                    fresh.value === null ||
                    current?.activeThreadId !== threadId ||
                    current.activeRole !== "work" ||
                    (board.pause !== null && !board.pause.keep.includes(current.id)) ||
                    fresh.value.state !== view.state ||
                    (yield* store.threadLink(threadId))?.paused ||
                    Rules.waitingOnBackground(fresh.value, now) ||
                    !Rules.workerQuietDue(current, fresh.value, now)
                  )
                    return;
                  // A newly failed idle run is handled by the failure backstop next tick.
                  if (fresh.value.state === "idle") {
                    const latestFailure = yield* Effect.result(threads.findLastFailure(threadId));
                    if (Result.isFailure(latestFailure)) {
                      yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
                      return;
                    }
                    if (latestFailure.success !== null) return;
                  }
                  views.delete(threadId);
                  if (fresh.value.state === "needs-input") {
                    if (routedQuestionThreads.has(threadId)) return;
                    // Its turn end after the interrupt brings the nudge.
                    yield* threads.interrupt(
                      threadId,
                      "Stuck on its own question; the board nudges it",
                      false,
                      undefined,
                      undefined,
                      "task_stalled",
                    );
                    const at = yield* nowIso;
                    yield* logEvent(
                      current,
                      { _tag: "system", component: "dispatcher" },
                      "thread",
                      {
                        body: "Interrupted: stuck on its own question",
                      },
                    );
                    const interrupted = { ...current, nudgedAt: at, updatedAt: at };
                    yield* saveCard(interrupted);
                    updateCard(interrupted);
                    return;
                  }
                  yield* nudgeWorker(threadId, [current]);
                  const saved = yield* store.card(current.id);
                  if (saved) updateCard(saved);
                  else invalidateCards();
                }),
                initial.id,
              );
            }
            // Backstop for a reviewer left idle with no verdict: a turn end skipped while
            // its own background work ran, or one that never arrived.
            for (const initial of yield* cardsForPlan) {
              if (initial.activeThreadId === null || initial.activeRole !== "review") continue;
              yield* step(
                "reviewerBackstop",
                Effect.gen(function* () {
                  const card = yield* store.card(initial.id);
                  if (!card) return;

                  const threadId = card.activeThreadId;
                  if (threadId === null || card.activeRole !== "review") return;
                  if (board.pause && !board.pause.keep.includes(card.id)) return;
                  if ((yield* Ref.get(unresolvedTurnEnds)).has(threadId)) return;
                  if (discussionWakes.has(threadId)) return;
                  if ((yield* store.threadLink(threadId))?.paused) return;
                  const foundFailure = yield* Effect.result(threads.findLastFailure(threadId));
                  if (Result.isFailure(foundFailure)) {
                    yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
                    return;
                  }
                  if (foundFailure.success !== null) {
                    views.clear();
                    yield* turnEndedUnlocked(threadId, undefined, true).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          views.clear();
                          invalidateCards();
                        }),
                      ),
                    );
                    return;
                  }
                  const view = yield* planView(threadId);
                  if (
                    view === null ||
                    Rules.waitingOnBackground(view, now) ||
                    !Rules.reviewerQuietDue(card, view, now)
                  )
                    return;
                  const fresh = yield* freshFind(threadId);
                  const current = yield* store.card(card.id);
                  if (
                    Option.isNone(fresh) ||
                    fresh.value === null ||
                    current?.activeThreadId !== threadId ||
                    current.activeRole !== "review" ||
                    (board.pause !== null && !board.pause.keep.includes(current.id)) ||
                    (yield* store.threadLink(threadId))?.paused ||
                    Rules.waitingOnBackground(fresh.value, now) ||
                    !Rules.reviewerQuietDue(current, fresh.value, now)
                  )
                    return;
                  const latestFailure = yield* Effect.result(threads.findLastFailure(threadId));
                  if (Result.isFailure(latestFailure)) {
                    yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
                    return;
                  }
                  if (latestFailure.success !== null) return;
                  views.delete(threadId);
                  yield* reviewerStopped(current, threadId);
                  const saved = yield* store.card(current.id);
                  if (saved) updateCard(saved);
                  else invalidateCards();
                }),
                initial.id,
              );
            }
            // A long evaluator turn gets a status ask at 45 minutes, then hourly, so nobody waits blind.
            for (const initial of yield* store.threadLinks({ boardId: board.id, open: true })) {
              if (initial.role !== "evaluator") continue;
              // Most open links are idle reusable evaluators or card workers.
              // Plan before taking the gate; only an ask or cleanup needs a step
              // and its fresh link/thread checks. Never cache this across ticks.
              const planned = yield* planFind(initial.threadId);
              if (Option.isNone(planned)) continue;
              const view = planned.value;
              const asked = (yield* Ref.get(statusAsked)).get(initial.threadId);
              if (view?.state !== "running" || view.runStartedAt === null) {
                if (asked === undefined) continue;
              } else if (
                asked?.run === view.runStartedAt
                  ? now - asked.at < STATUS_EVERY_MS
                  : now - Date.parse(view.runStartedAt) < STATUS_FIRST_MS
              ) {
                continue;
              }
              yield* step(
                "evaluatorStatus",
                Effect.gen(function* () {
                  const link = yield* store.threadLink(initial.threadId);
                  if (!link) return;
                  if (link.role !== "evaluator") return;
                  // A failed read skips this thread and keeps its ask record, so a blip
                  // can't make the next healthy tick ask again inside the hour.
                  const read = yield* planFind(link.threadId);
                  if (Option.isNone(read)) return;
                  let view = read.value;
                  if (view?.state !== "running" || view.runStartedAt === null) {
                    if (!(yield* Ref.get(statusAsked)).has(link.threadId)) return;
                    const fresh = yield* freshFind(link.threadId);
                    if (Option.isNone(fresh)) return;
                    view = fresh.value;
                    if (view?.state === "running" && view.runStartedAt !== null) return;
                    yield* Ref.update(statusAsked, (all) => {
                      if (!all.has(link.threadId)) return all;
                      const next = new Map(all);
                      next.delete(link.threadId);
                      return next;
                    });
                    return;
                  }
                  const run = view.runStartedAt;
                  const started = Date.parse(run);
                  const asked = (yield* Ref.get(statusAsked)).get(link.threadId);
                  const due =
                    asked?.run === run
                      ? now - asked.at >= STATUS_EVERY_MS
                      : now - started >= STATUS_FIRST_MS;
                  if (!due) return;
                  const fresh = yield* freshFind(link.threadId);
                  const currentLink = yield* store.threadLink(link.threadId);
                  if (
                    Option.isNone(fresh) ||
                    fresh.value?.state !== "running" ||
                    fresh.value.runStartedAt !== run ||
                    currentLink?.endedAt !== null ||
                    currentLink.role !== "evaluator" ||
                    currentLink.boardId !== board.id
                  )
                    return;
                  views.delete(link.threadId);
                  const minutes = Math.round((now - started) / 60_000);
                  const sent = yield* threads
                    .send({
                      threadId: link.threadId,
                      text: `Board check: this turn has been running for ${minutes} minutes. If your last ETA in the discussion still holds, carry on without posting. Otherwise post one line there with discussion_post: what's done and the new ETA. After a second missed ETA, stop researching: file what's left as cards with what you know, post the summary, and end the turn.`,
                    })
                    .pipe(
                      Effect.provideService(EvaluatorAnalytics.origin, "tick_check"),
                      Effect.as(true),
                      Effect.catchCause((cause) =>
                        Effect.logWarning("kanban evaluator status ask failed", {
                          threadId: link.threadId,
                          cause,
                        }).pipe(Effect.as(false)),
                      ),
                    );
                  if (sent) {
                    yield* Ref.update(statusAsked, (all) =>
                      new Map(all).set(link.threadId, { run, at: now }),
                    );
                  }
                }),
              );
            }
            for (const initial of yield* cardsForPlan) {
              if (
                !Rules.reviewEvaluatorWakeDue(
                  initial,
                  Rules.chainFor(board, initial)?.steps.length ?? 1,
                  now,
                )
              )
                continue;
              yield* step(
                "reviewEvaluatorStep",
                wakeReviewedEvaluator(initial.id).pipe(
                  Effect.provideService(EvaluatorAnalytics.origin, "step_reminder"),
                ),
                initial.id,
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("kanban reviewed evaluator step wake failed", {
                    cardId: initial.id,
                    cause,
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    views.clear();
                    invalidateCards();
                  }),
                ),
              );
            }
            // Backlog and evaluator-flagged cards stay parked. System stalls keep
            // one durable wake; periodic step notices compare their last delivered state.
            for (const initial of yield* cardsForPlan) {
              if (!waitingOnSystemStall(initial) && !waitingOnEvaluatorStep(initial)) {
                yield* forgetStepWait(initial.id);
                continue;
              }
              yield* step(
                "evaluatorStep",
                Effect.gen(function* () {
                  const card = yield* store.card(initial.id);
                  if (!card) return;

                  const stalled = waitingOnSystemStall(card);
                  if (!stalled && !waitingOnEvaluatorStep(card)) {
                    yield* forgetStepWait(card.id);
                    return;
                  }
                  if (stalled && board.pause && !board.pause.keep.includes(card.id)) return;
                  const key = stalled
                    ? `stall:${card.stalled!.at}`
                    : Subtasks.subtaskIds(kanbanStepSubtasks(card, "evaluator"));
                  const previousWait = (yield* Ref.get(stepWaits)).get(card.id);
                  // Stall age survives restarts; a recorded wake also survives temporary waits.
                  const wait =
                    previousWait?.key === key
                      ? previousWait
                      : {
                          key,
                          since: stalled ? Date.parse(card.stalled!.at) : now,
                          woken:
                            stalled &&
                            (yield* store.cardEvents(card.id)).some(
                              (event) =>
                                event.kind === "comment" &&
                                event.body?.startsWith(stallWakeMarker(card.stalled!.at)),
                            ),
                        };
                  if (wait !== previousWait) {
                    yield* Ref.update(stepWaits, (all) => new Map(all).set(card.id, wait));
                    if (!stalled) return;
                  }
                  const limit = card.priority === 1 ? STEP_WAIT_P1_MS : STEP_WAIT_MS;
                  if (now - wait.since < limit) return;
                  if (stalled && wait.woken) return;
                  const current = yield* store.card(card.id);
                  const currentWait = (yield* Ref.get(stepWaits)).get(card.id);
                  if (
                    current !== null &&
                    !(stalled ? waitingOnSystemStall(current) : waitingOnEvaluatorStep(current))
                  ) {
                    yield* forgetStepWait(card.id);
                    return;
                  }
                  if (
                    current === null ||
                    (stalled
                      ? `stall:${current.stalled!.at}`
                      : Subtasks.subtaskIds(kanbanStepSubtasks(current, "evaluator"))) !== key ||
                    currentWait !== wait ||
                    now - wait.since < (current.priority === 1 ? STEP_WAIT_P1_MS : STEP_WAIT_MS)
                  )
                    return;
                  const currentBoard = yield* boardOf(current.boardId);
                  if (
                    stalled &&
                    currentBoard.pause &&
                    !currentBoard.pause.keep.includes(current.id)
                  )
                    return;
                  if (!stalled && (yield* staleStepReminder(current, key))) {
                    yield* Ref.update(stepWaits, (all) =>
                      new Map(all).set(current.id, { ...wait, since: now, woken: false }),
                    );
                    return;
                  }
                  const minutes = Math.round((now - wait.since) / 60_000);
                  // A settled or archived discussion is finished: its evaluator isn't woken for it.
                  views.clear();
                  invalidateCards();
                  const woke = yield* cardDiscussionUnlocked(card.id).pipe(
                    Effect.flatMap((discussion) =>
                      discussion.settledAt !== null || discussion.archivedAt !== null
                        ? Effect.succeed(false)
                        : toEvaluator(
                            discussion,
                            stalled
                              ? `Card #${current.number} has been system-stalled for ${minutes} minutes with no thread or wait: ${current.stalled!.reason}. Check the blocker and clear the flag or park the card with card_wait.`
                              : Briefs.evaluatorStepWaitingText(current, minutes),
                            true,
                            undefined,
                            stalled ? stallWakeKey(current) : undefined,
                            stalled
                              ? Effect.gen(function* () {
                                  const latest = yield* store.card(current.id);
                                  const board = yield* boardOf(current.boardId);
                                  const talk = yield* store.discussion(discussion.id);
                                  return (
                                    talk !== null &&
                                    talk.settledAt === null &&
                                    talk.archivedAt === null &&
                                    latest !== null &&
                                    systemStallDue(latest, yield* nowMillis) &&
                                    stallWakeKey(latest) === stallWakeKey(current) &&
                                    (!board.pause || board.pause.keep.includes(latest.id))
                                  );
                                })
                              : undefined,
                            stalled ? undefined : `step:${current.id}`,
                          ).pipe(
                            Effect.provideService(
                              EvaluatorAnalytics.origin,
                              stalled ? "system_stall" : "step_reminder",
                            ),
                            Effect.as(true),
                          ),
                    ),
                    Effect.catchCause((cause) =>
                      Effect.logWarning("kanban evaluator step wake failed", {
                        cardId: card.id,
                        cause,
                      }).pipe(Effect.as(false)),
                    ),
                    Effect.ensuring(
                      Effect.sync(() => {
                        views.clear();
                        invalidateCards();
                      }),
                    ),
                  );
                  if (woke) {
                    if (!stalled) yield* rememberEvaluatorStep(yield* cardOf(current.id), key);
                    if (stalled) {
                      yield* logEvent(
                        current,
                        { _tag: "system", component: "dispatcher" },
                        "comment",
                        {
                          body: `${stallWakeMarker(current.stalled!.at)}: #${current.number}, ${minutes} minutes; ${current.stalled!.reason}`,
                        },
                      );
                    }
                    yield* Ref.update(stepWaits, (all) =>
                      new Map(all).set(card.id, {
                        ...wait,
                        since: stalled ? wait.since : now,
                        woken: stalled,
                      }),
                    );
                  }
                }),
                initial.id,
              );
            }
            // An owner message a running evaluator hasn't answered gets one reminder. An idle
            // evaluator is covered by its turn-end nudge, so it isn't pinged here.
            for (const initial of yield* store.openDiscussions(board.id)) {
              if (
                initial.settledAt !== null ||
                initial.archivedAt !== null ||
                initial.lastSeq === 0 ||
                (initial.cardId === null &&
                  !initial.participants.some(
                    (p) => p.actor._tag === "evaluator" && p.owes === "asked",
                  ))
              )
                continue;
              yield* step(
                "ownerReminder",
                Effect.gen(function* () {
                  const discussion = yield* store.discussion(initial.id);
                  if (!discussion) return;

                  if (discussion.settledAt !== null || discussion.archivedAt !== null) return;
                  // A post can commit before routing attaches any participant. Recover that
                  // gap here too; the same reply guard drops a queued wake once answered.
                  if (discussion.cardId !== null) {
                    const waiting = yield* store.ownerWait(discussion.id, true);
                    if (
                      waiting !== null &&
                      now - Date.parse(waiting.createdAt) >= POST_RECOVERY_MS &&
                      (yield* postNeedsReader(discussion.id, waiting.seq))
                    ) {
                      const message = yield* store.message(discussion.id, waiting.seq);
                      if (message) {
                        const text = blocksText(message.blocks, attachments.pathOf);
                        // Participant order survives reuse of an older evaluator. The last
                        // completed admission is the durable delivery generation instead.
                        const prior = (yield* tickSql<{ id: number }>`
                          SELECT id FROM ardud_kanban_evaluator_queue
                          WHERE board_id = ${discussion.boardId} AND done_at IS NOT NULL
                            AND json_extract(json, '$.purpose.kind') = 'discussion'
                            AND json_extract(json, '$.purpose.discussionId') = ${discussion.id}
                          ORDER BY id DESC LIMIT 1
                        `)[0];
                        yield* observePostRouting(
                          discussion,
                          message,
                          toEvaluator(
                            discussion,
                            message.author._tag === "script"
                              ? `Script "${message.authorName}" posted in "${discussion.title}" (discussion ${discussion.id}):\n\n${text}`
                              : Briefs.ownerMessageText(discussion.title, discussion.id, text),
                            false,
                            undefined,
                            ownerReplyKey(
                              discussion.id,
                              "unassigned",
                              `post:${waiting.seq}:after:${prior?.id ?? "none"}`,
                            ),
                            postNeedsReader(discussion.id, waiting.seq),
                            `owner:${discussion.cardId}`,
                          ).pipe(
                            Effect.provideService(EvaluatorAnalytics.origin, "discussion_nudge"),
                            Effect.provideService(recoveryPost, {
                              discussionId: discussion.id,
                              seq: waiting.seq,
                            }),
                          ),
                          "recovery",
                        );
                        return;
                      }
                    }
                  }
                  // Only a discussion whose evaluator owes a reply can have an owner reminder due.
                  const owing = discussion.participants.filter(
                    (participant) =>
                      participant.actor._tag === "evaluator" && participant.owes === "asked",
                  );
                  if (owing.length === 0) return;
                  // A failed read skips only this discussion, never the tick.
                  yield* Effect.gen(function* () {
                    for (const participant of owing) {
                      const actor = participant.actor;
                      if (actor._tag !== "evaluator") continue;
                      const evaluatorId = actor.threadId;
                      const reply = yield* store.ownerReply(discussion.id, evaluatorId, true);
                      if (reply === null || reply.answered) continue;
                      const idleMs = now - Date.parse(reply.createdAt);
                      if (idleMs < OWNER_WAIT_MS) continue;
                      const waitingKey = `${discussion.id}:${evaluatorId}`;
                      if ((yield* Ref.get(ownerWaits)).get(waitingKey) === reply.key) continue;
                      const read = yield* planFind(evaluatorId);
                      if (Option.isNone(read) || read.value?.state !== "running") continue;
                      const fresh = yield* freshFind(evaluatorId);
                      if (
                        Option.isNone(fresh) ||
                        fresh.value?.state !== "running" ||
                        fresh.value.runStartedAt !== read.value.runStartedAt
                      )
                        continue;
                      views.delete(evaluatorId);
                      const minutes = Math.round(idleMs / 60_000);
                      const action = yield* ownerReplyPending(store, discussion.id, evaluatorId);
                      if (action === null) continue;
                      const sent = yield* threads
                        .send({
                          threadId: evaluatorId,
                          text: Briefs.ownerWaitingText(discussion, minutes),
                          coalesce: `owner:${discussion.cardId ?? discussion.id}`,
                          key: ownerReplyKey(discussion.id, evaluatorId, action),
                        })
                        .pipe(
                          Effect.provideService(EvaluatorAnalytics.origin, "discussion_nudge"),
                          EvaluatorAnalytics.forCard(discussion.boardId, discussion.cardId),
                          Effect.as(true),
                          Effect.catchCause((cause) =>
                            Effect.logWarning("kanban owner message reminder failed", {
                              threadId: evaluatorId,
                              cause,
                            }).pipe(Effect.as(false)),
                          ),
                        );
                      if (sent) {
                        yield* Ref.update(ownerWaits, (all) =>
                          new Map(all).set(waitingKey, reply.key),
                        );
                      }
                    }
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("kanban owner wait check failed", {
                        discussionId: discussion.id,
                        cause,
                      }),
                    ),
                  );
                }),
                initial.cardId ?? undefined,
              );
            }
            // Finished discussions must not extend typing leases.
            for (const initial of yield* store.openDiscussions(board.id)) {
              if (!initial.participants.some((p) => p.typingUntil !== null)) continue;
              yield* step(
                "typing",
                Effect.gen(function* () {
                  const discussion = yield* store.discussion(initial.id);
                  if (!discussion) return;

                  let next = discussion;
                  for (const participant of discussion.participants) {
                    if (participant.typingUntil === null) continue;
                    const actor = participant.actor;
                    if (actor._tag !== "thread" && actor._tag !== "evaluator") continue;
                    const view = yield* planView(actor.threadId);
                    // Typing is kept alive only where the agent is working on a reply.
                    // Once it lapses, a non-home thread's owes go too; home keeps them so
                    // its turn end still nudges.
                    const home =
                      view && view.state !== "idle" && (yield* isHome(discussion, actor.threadId));
                    if (!home && Date.parse(participant.typingUntil) >= now) continue;
                    const fresh = yield* freshFind(actor.threadId);
                    if (Option.isNone(fresh)) continue;
                    const currentView = fresh.value;
                    if (
                      currentView &&
                      currentView.state !== "idle" &&
                      (yield* isHome(discussion, actor.threadId))
                    ) {
                      next = withParticipant(next, actor, participant.name, {
                        typingUntil: yield* typingUntil,
                      });
                    } else if (Date.parse(participant.typingUntil) < now) {
                      const home = yield* isHome(discussion, actor.threadId);
                      next = withParticipant(next, actor, participant.name, {
                        typingUntil: null,
                        ...(home ? {} : { owes: null }),
                      });
                    }
                  }
                  if (next !== discussion) yield* saveDiscussion(next);
                }),
                initial.cardId ?? undefined,
              );
            }
            // Idle discussions settle themselves.
            const idleNow = yield* nowIso;
            for (const initial of yield* store.openDiscussions(board.id)) {
              if (initial.settledAt !== null || initial.archivedAt !== null) continue;
              yield* step(
                "settleDiscussion",
                Effect.gen(function* () {
                  const discussion = yield* store.discussion(initial.id);
                  if (!discussion) return;

                  const card = discussion.cardId ? yield* store.card(discussion.cardId) : null;
                  if (!Rules.discussionSettleDue(discussion, card, now)) return;
                  const openLinks = yield* store.threadLinks({ boardId: board.id, open: true });
                  const threadIds = [
                    discussion.evaluatorThreadId,
                    card?.activeThreadId ?? null,
                    ...openLinks
                      .filter(
                        (link) =>
                          link.discussionId === discussion.id ||
                          (discussion.cardId !== null && link.cardId === discussion.cardId),
                      )
                      .map((link) => link.threadId),
                  ];
                  let working = false;
                  for (const threadId of threadIds) {
                    if (threadId === null) continue;
                    const view = yield* planView(threadId);
                    if (view !== null && view.state !== "idle") working = true;
                  }
                  if (working) return;
                  // Settling is a mutation based on all participating threads being idle.
                  for (const threadId of new Set(threadIds)) {
                    if (threadId === null) continue;
                    const fresh = yield* freshFind(threadId);
                    if (
                      Option.isNone(fresh) ||
                      (fresh.value !== null && fresh.value.state !== "idle")
                    ) {
                      working = true;
                      break;
                    }
                  }
                  if (working) return;
                  const current = yield* store.discussion(discussion.id);
                  const currentCard = current?.cardId ? yield* store.card(current.cardId) : null;
                  if (!current || !Rules.discussionSettleDue(current, currentCard, now)) return;
                  yield* saveDiscussion({ ...current, settledAt: idleNow, snoozedUntil: null });
                }),
                initial.cardId ?? undefined,
              );
            }
            // Cards held for their evaluator after a wait ended: a hold that ran out, or
            // that a move or a thread has overtaken, comes off here.
            for (const initial of yield* cardsForPlan) {
              if (initial.deciding === undefined || Waits.decidingHolds(initial, now)) continue;
              yield* step(
                "endDeciding",
                Effect.gen(function* () {
                  const card = yield* store.card(initial.id);
                  if (!card) return;

                  if (card.deciding === undefined || Waits.decidingHolds(card, now)) return;
                  const current = yield* store.card(card.id);
                  if (
                    !current ||
                    current.deciding === undefined ||
                    Waits.decidingHolds(current, now)
                  )
                    return;
                  // Still held but for the clock: the evaluator did not decide in time, or
                  // was never told (its note could not be delivered). The history says which.
                  yield* endDeciding(
                    current.id,
                    Waits.decidingHolds(current)
                      ? {
                          body:
                            current.deciding.toldAt === null
                              ? Waits.DECIDING_NEVER_TOLD
                              : Waits.DECIDING_RAN_OUT,
                        }
                      : {},
                  );
                  invalidateCards();
                }),
                initial.id,
              );
            }
            // Waits: each parked card's check is asked once a tick, and a wait that
            // ended is cleared here, before the PRs-landed step below.
            const parked = Waits.WAITS_ENGINE_WIRED
              ? (yield* cardsForPlan).filter(
                  (card) =>
                    card.wait !== undefined &&
                    card.activeThreadId === null &&
                    card.wait.on !== "time" &&
                    card.wait.on !== "card" &&
                    card.wait.on !== "owner_go",
                )
              : [];
            if (parked.length > 0) {
              // Planning reads are shared once per board, outside any state gate.
              // Only a card with a change enters its own operation below.
              const watched = [
                ...new Set(
                  parked.flatMap((card) =>
                    card.wait?.pr == null || card.workThreadId === null ? [] : [card.workThreadId],
                  ),
                ),
              ];
              const unread = watched.filter((threadId) => !views.has(threadId));
              // A script's waits are read for by its own pass (ScriptService.checkWaits).
              const builtIn = parked.filter((card) => card.wait?.on !== "script");
              const known = watched.flatMap((threadId) => views.get(threadId)?.prs ?? []);
              const reader = Option.getOrNull(waitPrs);
              const read = Effect.gen(function* () {
                const found = yield* Effect.forEach(
                  unread,
                  (threadId) =>
                    threadIo.find(threadId).pipe(
                      Effect.map((view) => [threadId, view] as const),
                      // A failed read is not an absent thread: nothing is known this tick.
                      Effect.catch(() => Effect.succeed(null)),
                    ),
                  { concurrency: WAIT_VIEW_READS },
                );
                const live: Array<Waits.WaitPrFacts> = [
                  ...known,
                  ...found.flatMap((entry) => entry?.[1]?.prs ?? []),
                ];
                const requests = Waits.waitPrRequests(builtIn, board, live);
                return {
                  found,
                  readings:
                    requests.length > 0 && reader !== null
                      ? (yield* reader.read(requests)).readings
                      : Waits.mergePrReadings(live),
                };
              });
              const nothingOutside =
                unread.length === 0 &&
                (reader === null || Waits.waitPrRequests(builtIn, board, known).length === 0);
              const pass = nothingOutside
                ? { found: [], readings: Waits.mergePrReadings(known) }
                : replayReads
                  ? yield* locks.outsideRead(
                      // A rerun that wants other threads read is another read.
                      `waits:${board.id}:${unread.join(",")}`,
                      // Fences only grow, so the sum moves when any of these threads was touched.
                      () =>
                        unread.reduce(
                          (sum, threadId) => sum + (threadFences.get(threadId) ?? 0),
                          0,
                        ),
                      read,
                    )
                  : yield* locks.outside(read, undefined, true);
              for (const entry of pass.found) {
                if (entry !== null) views.set(entry[0], entry[1]);
              }
              const facts: Waits.WaitFacts = {
                nowMs: now,
                prs: pass.readings,
                prsByKey: Waits.indexPrReadings(pass.readings),
                cards: new Map((yield* cardsForPlan).map((card) => [card.id as string, card])),
              };
              const waits: KanbanActor = { _tag: "system", component: "waits" };
              const at = yield* nowIso;
              const chainLength = (card: KanbanCard) =>
                Rules.chainFor(board, card)?.steps.length ?? 1;
              // A wait that holds with nothing new costs its check and nothing else: the
              // card is the one this tick already loaded. Only a card with something to
              // save has its row read.
              const steps: Array<Exclude<Waits.WaitStep, { readonly _tag: "none" }>> = [];
              for (const card of parked) {
                const quiet = Waits.resolveWait(
                  card,
                  facts,
                  { chainLength: chainLength(card) },
                  at,
                );
                if (quiet._tag === "none" || (quiet._tag === "hold" && quiet.save === null))
                  continue;
                const current = yield* store.card(card.id);
                if (!current || current.wait === undefined) continue;
                const step = Waits.resolveWait(
                  current,
                  facts,
                  { chainLength: chainLength(current) },
                  at,
                );
                if (step._tag === "none" || (step._tag === "hold" && step.save === null)) continue;
                steps.push(
                  // A PR no thread watches: the card's link takes the merge the host reported.
                  step._tag === "end"
                    ? { ...step, card: Waits.withLandedLinks(step.card, facts.prs, at) }
                    : step,
                );
              }
              // Save non-notifying steps first, then notify. Each application has
              // its own commit guard: an already saved/sent action is never replayed.
              const tells = (step: (typeof steps)[number]) =>
                step._tag !== "hold" && step.wake.to === "evaluator";
              const apply = Effect.fn("KanbanService.applyTickWait")(function* (
                planned: (typeof steps)[number],
              ) {
                const id = planned._tag === "hold" ? planned.save?.id : planned.card.id;
                if (id === undefined) return;
                yield* step(
                  "wait",
                  Effect.gen(function* () {
                    const current = yield* store.card(id);
                    if (!current || current.wait === undefined || current.activeThreadId !== null)
                      return;
                    const cards = new Map(facts.cards);
                    for (const id of new Set([
                      ...(current.wait.card === null ? [] : [current.wait.card]),
                      ...current.blockedBy,
                    ])) {
                      const dependency = yield* store.card(KanbanCardId.make(id));
                      if (dependency) cards.set(id, dependency);
                      else cards.delete(id);
                    }
                    const freshFacts = { ...facts, cards };
                    const resolved = Waits.resolveWait(
                      current,
                      freshFacts,
                      { chainLength: chainLength(current) },
                      at,
                    );
                    if (
                      resolved._tag === "none" ||
                      (resolved._tag === "hold" && resolved.save === null)
                    )
                      return;
                    yield* applyWaitStep(
                      resolved._tag === "end"
                        ? {
                            ...resolved,
                            card: Waits.withLandedLinks(resolved.card, freshFacts.prs, at),
                          }
                        : resolved,
                      waits,
                    );
                  }),
                  id,
                );
              });
              for (const planned of steps) if (!tells(planned)) yield* apply(planned);
              for (const planned of steps) if (tells(planned)) yield* apply(planned);
              if (steps.length > 0) invalidateCards();
              // A note may have started or woken an evaluator's thread.
              if (steps.some(tells)) views.clear();
            }
            // Reviewed cards wait in review until their PRs land.
            // syncPrs and evaluatorTurn can change cards and send to other threads.
            for (const initial of yield* cardsForPlan) {
              if (initial.stage !== "in_review" || initial.activeThreadId !== null) continue;
              yield* step(
                "landing",
                Effect.gen(function* () {
                  const card = yield* store.card(initial.id);
                  if (!card) return;

                  if (card.stage !== "in_review" || card.activeThreadId !== null) return;
                  // PR completion can finish the review while an evaluator's wait stays parked.
                  const refreshed = yield* syncPrs(card);
                  invalidateCards();
                  if (refreshed.stage !== "in_review") return;
                  // Parked on a wait: it stays in review until the wait pass above ends it.
                  if (Waits.WAITS_ENGINE_WIRED && Waits.waitHoldsDispatch(refreshed)) return;
                  const chain = Rules.chainFor(board, card);
                  if (!Rules.reviewFinished(card, chain?.steps.length ?? 1)) return;
                  const current = yield* store.card(card.id);
                  if (
                    !current ||
                    current.stage !== "in_review" ||
                    current.activeThreadId !== null ||
                    (Waits.WAITS_ENGINE_WIRED && Waits.waitHoldsDispatch(current)) ||
                    !Rules.reviewFinished(
                      current,
                      Rules.chainFor(board, current)?.steps.length ?? 1,
                    )
                  )
                    return;
                  // Its wait just ended and its evaluator was told: that decision comes first.
                  if (Waits.decidingHolds(current, now)) return;
                  views.clear();
                  invalidateCards();
                  const synced = current;
                  if (!Rules.prsLanded(synced)) return;
                  // The plan's next step decides where it goes: the worker's sends it
                  // back to work, a review-only one to review, else it's completed.
                  const to: KanbanStage =
                    kanbanStepSubtasks(synced, "work").length > 0
                      ? "todo"
                      : kanbanStepSubtasks(synced, "review").length > 0
                        ? "needs_review"
                        : "completed";
                  if (to === "completed" && !reviewPlanClear(synced)) return;
                  const at = yield* nowIso;
                  const dispatcher: KanbanActor = { _tag: "system", component: "dispatcher" };
                  const landed: KanbanCard = {
                    ...(yield* moveWait(synced, to, at, dispatcher)),
                    stage: to,
                    reviewStep: to === "completed" ? synced.reviewStep : 0,
                    wakeNote:
                      to === "todo"
                        ? [synced.wakeNote, Subtasks.nextStepNote("The PRs landed. ")]
                            .filter((part) => part !== null)
                            .join("\n\n")
                        : synced.wakeNote,
                    movedAt: at,
                    updatedAt: at,
                  };
                  yield* logEvent(landed, dispatcher, "moved", {
                    fromStage: synced.stage,
                    toStage: to,
                    body: "PRs landed",
                  });
                  yield* saveCard(landed);
                  yield* evaluatorTurn(synced, landed, dispatcher);
                  views.clear();
                }),
                initial.id,
              );
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("kanban board tick failed", { boardId: candidate.id, cause }),
            ),
          ),
        { concurrency: 8, discard: true },
      ),
    );
    // A pool whose model left the composer's list drops to 0 slots after two
    // ticks in a row, so a provider refresh blip never pauses a board. A model
    // that returns is not raised back up; the owner does that.
    const listed = yield* models.listed;
    const unlistedBefore = yield* Ref.get(unlistedPools);
    const unlistedNow = new Set<string>();
    for (const candidate of [yield* readTickBoard].filter((board) => board !== null)) {
      yield* tickStep(
        candidate.id,
        "unlistedPools",
        Effect.gen(function* () {
          const board = yield* tickBoardOf;
          if (board.archivedAt !== null) return;
          let zeroed = false;
          for (const pool of yield* store.pools(board.id)) {
            if (pool.slots === 0 || isListed(listed, pool.model) !== false) continue;
            const id = `${board.id}:${pool.key}`;
            unlistedNow.add(id);
            if (!unlistedBefore.has(id)) continue;
            yield* store.putPool(board.id, { ...pool, slots: 0 });
            yield* Effect.logInfo(
              `board ${board.slug}: pool ${pool.key} left the model list, now 0 slots`,
            );
            zeroed = true;
          }
          if (zeroed) {
            yield* publish(board.id, { _tag: "pools", pools: yield* store.pools(board.id) });
            yield* kick;
          }
        }),
      );
    }
    yield* Ref.update(
      unlistedPools,
      (all) =>
        new Set([...all].filter((key) => !key.startsWith(`${boardId}:`)).concat([...unlistedNow])),
    );
    yield* Ref.update(missing, (all) => new Map(all).set(boardId, missed));
  });

  const runningTicks = new Map<
    string,
    { tickId: string; timing: ReturnType<typeof TickTimings.make> }
  >();
  const tickBoard = Effect.fn("KanbanService.tickBoard")(function* (
    board: KanbanBoard,
    turnEndLinks: ReadonlyMap<string, KanbanThreadLink>,
  ) {
    const boardId = board.id;
    yield* Effect.annotateCurrentSpan("kanban.board_id", boardId);
    const tickId = NodeCrypto.randomUUID();
    yield* Effect.annotateCurrentSpan("kanban.tick_id", tickId);
    const timing = yield* TickTimings.create;
    // No yield between testing and reserving the board, even during a burst.
    const previous = runningTicks.get(boardId);
    const busy = previous !== undefined;
    if (!busy) runningTicks.set(boardId, { tickId, timing });
    else {
      previous.timing.overlappingTicks++;
      yield* recordAnalytics({
        kind: "kanban.tick_overlap",
        boardId,
        props: { tickId, activeTickId: previous.tickId, reason: "local_waits_only" },
      }).pipe(Effect.catchCause(() => Effect.void));
    }
    const depths: { todo?: number; needs_review?: number; evaluator?: number } = {};
    const kicks: TickKicks = { held: true, asked: false, stoppedCards: new Set() };
    yield* tickLocalWaits(board).pipe(
      Effect.andThen(
        busy
          ? Effect.void
          : serialEach(
              ticking,
              boardId,
              TickTimings.measure("card_evaluation", tickSteps(boardId, turnEndLinks)),
              false,
            ),
      ),
      Effect.provideService(tickKicks, kicks),
      Effect.ensuring(
        Effect.sync(() => {
          kicks.held = false;
        }),
      ),
      Effect.andThen(
        busy
          ? Effect.suspend(() => (kicks.asked ? kick : Effect.void))
          : dispatchUnlocked(boardId, kicks.stoppedCards),
      ),
      Effect.onExit((exit) =>
        Effect.suspend(() => (Exit.isSuccess(exit) || !kicks.asked ? Effect.void : kick)),
      ),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          // A busy tick only runs local waits; timing it would skew tick durations.
          if (Option.isNone(analytics) || busy) return;
          const summary = timing.finish();
          for (const phase of summary.phases)
            yield* recordAnalytics({
              kind: "kanban.tick_phase",
              boardId,
              durationMs: phase.durationMs,
              props: { tickId, phase: phase.phase, count: phase.count },
            });
          yield* recordAnalytics({
            kind: "kanban.tick",
            boardId,
            durationMs: summary.durationMs,
            props: {
              span: "KanbanService.tickBoard",
              tickId,
              cardsScanned: summary.cardsScanned,
              cardsChanged: summary.cardsChanged,
              dbMs: summary.dbMs,
              queueWaitMs: summary.queueWaitMs,
              heapMB: process.memoryUsage().heapUsed / 1024 / 1024,
              overlappingTicks: timing.overlappingTicks,
              ...(Exit.isFailure(exit) ? { errorTag: analyticsErrorTag(exit.cause) } : {}),
            },
          });
          for (const [phase, depth] of [
            ...Object.entries(depths),
            ["jobs", Math.max(0, yield* Queue.size(jobs))],
          ] as const)
            yield* recordAnalytics({
              kind: "kanban.queue_depth",
              boardId,
              props: { phase, depth },
            });
        }).pipe(Effect.catchCause(() => Effect.void)),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (!busy) runningTicks.delete(boardId);
        }),
      ),
      Effect.provideService(tickQueueDepths, Option.isSome(analytics) ? depths : undefined),
      Effect.provideService(
        TickTimings.current,
        !busy && Option.isSome(analytics) ? timing : undefined,
      ),
    );
  });
  const tickUnlocked = Effect.fn("KanbanService.tickUnlocked")(function* () {
    // A failed board must not interrupt the other boards, but callers still see its error.
    for (const boardId of new Set((yield* store.pendingBoardPurges).map((row) => row.boardId)))
      yield* guardReady("board.purge.retry", finishPurge(boardId), undefined, boardId);
    const turnEndLinks = new Map(
      (yield* rawStore.threadLinksByIds([...(yield* Ref.get(unresolvedTurnEnds))])).map(
        (link) => [link.threadId, link] as const,
      ),
    );
    const results = yield* Effect.forEach(
      yield* store.boards,
      (board) => Effect.exit(tickBoard(board, turnEndLinks)),
      {
        concurrency: "unbounded",
        discard: false,
      },
    );
    for (const result of results)
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
  });

  /** One tiny generation on `model`: true when its provider answers. */
  const probeModel = (model: ModelSelection): Effect.Effect<boolean> => {
    const generateJson = textGeneration.generateJson;
    if (!generateJson) return Effect.succeed(false);
    return generateJson({
      cwd: serverConfig.cwd,
      operationLabel: "probeModel",
      prompt: 'Health check from the missions board. Reply with {"ok": true}.',
      outputSchema: ProbeOutput,
      modelSelection: model,
    }).pipe(
      Effect.timeout("90 seconds"),
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    );
  };

  // Runs outside the lock: a probe can take a minute and must not hold the board.
  const probeOutagesNow = Effect.fn("KanbanService.probeOutages")(function* () {
    // Nothing down and the links already read once since start: skip the read.
    if ((yield* Ref.get(down)).size === 0 && (yield* Ref.get(scanned))) return;
    const seededAt = yield* nowMillis;
    // The scan visits boards independently. Preserve outages whose generation changes
    // during it, including failures recorded on a board already scanned.
    const models = yield* locks.run(
      Effect.gen(function* () {
        const before = yield* Ref.get(outageGeneration);
        yield* seedDown;
        const found = new Map<string, ModelSelection>();
        const recovered = yield* Ref.get(recoveredThreads);
        for (const { link, board } of yield* pausedLinks) {
          if (recovered.has(link.threadId)) continue;
          const model = link.model ?? board.evaluatorModel;
          found.set(Rules.modelKey(model), model);
        }
        // A key whose threads all came back on their own is up again. A key with paused
        // links but no state is marked down now, so dispatch holds it while the probe
        // below is in flight.
        const after = yield* Ref.get(outageGeneration);
        yield* Ref.update(down, (map) => {
          const next = new Map(
            [...map].filter(([key]) => found.has(key) || before.get(key) !== after.get(key)),
          );
          for (const key of found.keys()) {
            // nextAt is now: the loop below probes it right away.
            if (!next.has(key))
              next.set(key, {
                delayMs: Rules.PROBE_FIRST_MS,
                nextAt: seededAt,
                announced: new Set(),
                recovered: new Set(),
              });
          }
          return next;
        });
        return found;
      }),
    );
    // Outages recorded from here on add their own keys and wait for the next run.
    for (const [key, model] of models) {
      const now = yield* nowMillis;
      // No state after a restart: probe right away.
      const state = (yield* Ref.get(down)).get(key);
      if (state !== undefined && now < state.nextAt) continue;
      const generation = (yield* Ref.get(outageGeneration)).get(key) ?? 0;
      const answered = yield* probeModel(model);
      const current = yield* locks.run(
        Effect.gen(function* () {
          if (((yield* Ref.get(outageGeneration)).get(key) ?? 0) !== generation) return false;
          if (answered) yield* resumeKey(key);
          return true;
        }),
      );
      if (!current || answered) continue;
      const delayMs =
        state === undefined ? Rules.PROBE_FIRST_MS : Rules.nextProbeDelay(state.delayMs);
      yield* Ref.update(down, (map) =>
        new Map(map).set(key, {
          delayMs,
          nextAt: now + delayMs,
          announced: state?.announced ?? new Set(),
          recovered: state?.recovered ?? new Set(),
        }),
      );
      // The whole announcement is optional: a failed read here must not skip the next model's probe.
      yield* Effect.gen(function* () {
        // One alert per board per outage, after the first failed probe, so threads that die in the same minutes are counted.
        // A board whose post failed is not marked announced and is retried by the next failed probe.
        yield* locks.run(
          Effect.gen(function* () {
            const counts = new Map<KanbanBoard["id"], number>();
            const announced = (yield* Ref.get(down)).get(key)?.announced ?? new Set();
            for (const { link, board } of yield* pausedLinks) {
              if (linkKey(link, board) === key && !announced.has(board.id)) {
                counts.set(board.id, (counts.get(board.id) ?? 0) + 1);
              }
            }
            if (counts.size === 0) return;
            const posted = yield* alertBoards(
              counts,
              (count) =>
                `${key} is out of usage or down: ${count} thread${count === 1 ? "" : "s"} paused. They wake by themselves when a probe passes (every 5 to 30 minutes). Cards that list another model start there meanwhile.`,
            );
            yield* Ref.update(down, (map) => {
              const entry = map.get(key);
              if (!entry) return map;
              return new Map(map).set(key, {
                ...entry,
                announced: new Set([...entry.announced, ...posted]),
              });
            });
          }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban outage alert failed", { key, cause }),
        ),
      );
    }
  });

  const guardReady = <A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
    cardId?: string,
    boardId?: string,
  ) =>
    locks.run(boardId === undefined ? effect : locks.access(boardId, effect), cardId).pipe(
      Effect.provideService(BoardLocks.operationName, name),
      Effect.catchDefect((defect) =>
        defect instanceof BoardLocks.BoardStateChanged
          ? Effect.fail(
              new KanbanError({
                code: "conflict",
                saved: defect.committed ? null : false,
                detail: defect.committed
                  ? BoardLocks.MAY_HAVE_APPLIED
                  : "Board changed during this operation. Re-read its state before retrying.",
              }),
            )
          : isKanbanError(defect)
            ? Effect.fail(defect)
            : Effect.die(defect),
      ),
      Effect.mapError(toKanbanError),
    );
  const guard = <A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
    cardId?: string,
    boardId?: string,
  ) => Deferred.await(startupReady).pipe(Effect.andThen(guardReady(name, effect, cardId, boardId)));
  /**
   * A write that replies once its state is committed: thread follow-ons it
   * makes through `later` are saved as route rows as its last step, still
   * inside its board operation, so rows keep the order of the writes that
   * made them; the drains start once it returns. A follow-on collected by an
   * attempt that then failed is still saved (after it, unordered), as the
   * inline path would already have run it. `inline` route mode runs them inline.
   */
  const guardDeferred = <A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
    cardId?: string,
    boardId?: string,
  ) =>
    deferWrites
      ? Effect.suspend(() => {
          const sink: EffectSink = { effects: [], closed: false };
          let lanes = new Set<string>();
          const attempt = Effect.suspend(() => {
            // A stale rerun starts over; it keeps only its own follow-ons.
            sink.effects.length = 0;
            return effect;
          }).pipe(
            Effect.tap(() =>
              Effect.suspend(() => {
                sink.closed = true;
                if (sink.effects.length === 0) return Effect.void;
                const saving = [...sink.effects];
                sink.effects.length = 0;
                return saveEffectRows(saving).pipe(
                  Effect.tap((saved) => Effect.sync(() => (lanes = saved))),
                );
              }),
            ),
            Effect.provideService(effectSink, sink),
          );
          return guard(name, attempt, cardId, boardId).pipe(
            Effect.onExit((exit) =>
              Effect.suspend(() => {
                sink.closed = true;
                const started = Effect.forEach(lanes, afterOwnerCommit, { discard: true });
                if (sink.effects.length === 0) return started;
                const saving = saveEffects([...sink.effects]);
                // A failed write's follow-ons are saved too, but never replace its error.
                return Exit.isSuccess(exit)
                  ? Effect.andThen(started, saving)
                  : Effect.andThen(
                      started,
                      saving.pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning("kanban write follow-ons not saved", { cause }),
                        ),
                      ),
                    );
              }),
            ),
            Effect.mapError(toKanbanError),
          );
        })
      : guard(name, effect, cardId, boardId);
  const agentCall: KanbanServiceShape["agentCall"] = Effect.fn("KanbanService.agentCall")(
    function* <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) {
      return yield* Effect.acquireUseRelease(
        // These in-memory markers must be atomic with delivery/rollback, but need no board lock or I/O.
        Effect.sync(() => {
          if (rollingBack(threadId)) return false;
          agentCalls.set(threadId, (agentCalls.get(threadId) ?? 0) + 1);
          for (const pending of delivering.values()) {
            if (pending.threadId === threadId) pending.touched = true;
          }
          return true;
        }).pipe(
          Effect.flatMap((admitted) =>
            admitted
              ? Effect.void
              : failWith("conflict", "Assignment is being rolled back; retry shortly."),
          ),
        ),
        () => effect,
        () =>
          Effect.sync(() => {
            const remaining = (agentCalls.get(threadId) ?? 1) - 1;
            if (remaining === 0) agentCalls.delete(threadId);
            else agentCalls.set(threadId, remaining);
          }),
      );
    },
  );
  const savedCardGuard = <E, R>(
    name: string,
    effect: Effect.Effect<KanbanCard, E, R>,
    cardId?: string,
    isSaved: (card: KanbanCard) => boolean = () => true,
  ) =>
    Effect.suspend(() => {
      let target = cardId;
      return SavedWrite.subSteps(
        name,
        SavedWrite.recover(guardDeferred(name, effect, cardId), (saved) => {
          if (saved.kind !== "card") return undefined;
          target ??= saved.card.id;
          return saved.card.id === target && isSaved(saved.card) ? saved.card : undefined;
        }),
        name === "card.move",
      );
    });
  const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Deferred.await(startupReady).pipe(Effect.andThen(effect), Effect.mapError(toKanbanError));
  // Pure SELECTs. On the reader they don't queue behind the one SQLite writer,
  // which a single write can hold for 15 s under load.
  const readDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    read(effect.pipe(NodeSqliteClient.readOnly));

  /** Every model a board uses, deduped by pool key. */
  const boardModels = (board: KanbanBoard): Array<ModelSelection> => {
    const seen = new Map<string, ModelSelection>();
    const add = (model: ModelSelection) => {
      const key = Rules.poolKey(model);
      if (!seen.has(key)) seen.set(key, model);
    };
    add(board.managerModel);
    add(board.evaluatorModel);
    // A shared pool drives card options, so the card default wins when keys match.
    seen.set(Rules.poolKey(board.defaultCardModel), board.defaultCardModel);
    for (const chain of board.reviewChains) for (const step of chain.steps) add(step);
    return [...seen.values()];
  };

  /**
   * The 0-slot pools a board still needs for its models; existing pools are never touched.
   * A model with a pool at any level needs none, so a new board default level adds no pool.
   */
  const missingPools = (
    existing: ReadonlyArray<KanbanPool>,
    models: ReadonlyArray<ModelSelection>,
  ): Array<KanbanPool> => {
    const added: Array<KanbanPool> = [];
    for (const model of models) {
      if (Rules.poolFor([...existing, ...added], model)) continue;
      added.push({ key: Rules.poolKey(model), model, slots: 0 });
    }
    return added;
  };

  const createBoard: KanbanServiceShape["createBoard"] = (input) =>
    guard(
      "board.create",
      Effect.gen(function* () {
        yield* checkText([["name", input.name]]);
        const slug = input.slug.trim().toLowerCase();
        if ((yield* store.boards).some((board) => board.slug === slug)) {
          return yield* failWith("conflict", `a board with slug ${slug} already exists`);
        }
        return yield* insertBoardUnlocked({ ...input, slug });
      }),
      undefined,
      `board-${input.slug.trim().toLowerCase()}`,
    );

  /** Inserts a board for a slug. Callers hold the lock and have checked the slug is free. */
  const insertBoardUnlocked = Effect.fn("KanbanService.insertBoardUnlocked")(function* (input: {
    readonly slug: string;
    readonly name: string;
    readonly defaultProjectId: ProjectId | null;
    readonly managerModel?: ModelSelection | undefined;
    readonly evaluatorModel?: ModelSelection | undefined;
    readonly defaultCardModel?: ModelSelection | undefined;
  }) {
    const managerModel = yield* canonicalModel(
      input.managerModel ?? Defaults.DEFAULT_MANAGER_MODEL,
    );
    const evaluatorDefault = yield* canonicalModel(Defaults.DEFAULT_EVALUATOR_MODEL);
    const cardDefault = yield* canonicalModel(Defaults.DEFAULT_CARD_MODEL);
    const evaluatorModel = input.evaluatorModel
      ? withDefaultLevel(yield* canonicalModel(input.evaluatorModel), evaluatorDefault)
      : evaluatorDefault;
    const defaultCardModel = input.defaultCardModel
      ? withDefaultLevel(yield* canonicalModel(input.defaultCardModel), cardDefault)
      : cardDefault;
    if (input.managerModel) yield* checkModel(managerModel);
    if (input.evaluatorModel) yield* checkModel(evaluatorModel);
    if (input.defaultCardModel) yield* checkModel(defaultCardModel);
    const slug = input.slug.trim().toLowerCase();
    const board: KanbanBoard = {
      id: KanbanBoardId.make(`board-${slug}`),
      slug,
      name: input.name.trim() || slug,
      icon: null,
      iconImage: null,
      defaultProjectId: input.defaultProjectId,
      managerModel,
      evaluatorModel,
      defaultCardModel,
      reviewChains: [],
      defaultReviewChain: null,
      guessedGates: undefined,
      standingApprovals: [],
      instructions: Defaults.DEFAULT_INSTRUCTIONS,
      setup: null,
      pause: null,
      nightlyReview: null,
      createdAt: yield* nowIso,
      archivedAt: null,
    };
    yield* store.putBoardWithPools(board, missingPools([], boardModels(board)));
    yield* publish(board.id, { _tag: "board", board });
    return board;
  });

  const ensureBoard: KanbanServiceShape["ensureBoard"] = (input) =>
    guard(
      "board.ensure",
      Effect.gen(function* () {
        yield* checkText([["name", input.name]]);
        const slug = input.slug.trim().toLowerCase();
        const existing = (yield* store.boards).find((board) => board.slug === slug);
        if (existing) return existing;
        return yield* insertBoardUnlocked({ ...input, slug });
      }),
      undefined,
      `board-${input.slug.trim().toLowerCase()}`,
    );

  const updateBoardUnlocked = Effect.fn("KanbanService.updateBoardUnlocked")(function* (
    boardId: KanbanBoard["id"],
    patch: BoardPatch,
    application?: InstructionApplication,
    actor?: KanbanActor,
    archiveLanes?: Set<string>,
  ) {
    if (patch.archived !== undefined && actor?._tag !== "owner")
      return yield* failWith(
        "denied",
        "Only the owner can delete or restore a board.",
        "role_not_allowed",
      );
    const { archived, ...fields } = patch;
    if (patch.name !== undefined && patch.name.trim() === "") {
      return yield* failWith("invalid", "A board needs a name");
    }
    yield* checkText([
      ["name", patch.name],
      ["model routing", patch.instructions?.modelRouting],
      ["reviewer routing", patch.instructions?.reviewerRouting],
      ["escalation", patch.instructions?.escalation],
    ]);
    const board = yield* boardOf(boardId);
    if (
      archived !== undefined &&
      archived === (board.archivedAt !== null) &&
      Object.keys(fields).length === 0
    )
      return board;
    const managerModel = patch.managerModel
      ? yield* canonicalModel(patch.managerModel)
      : board.managerModel;
    const evaluatorModel = patch.evaluatorModel
      ? yield* canonicalModel(patch.evaluatorModel)
      : board.evaluatorModel;
    const defaultCardModel = patch.defaultCardModel
      ? yield* canonicalModel(patch.defaultCardModel)
      : board.defaultCardModel;
    const reviewChains =
      patch.reviewChains === undefined
        ? board.reviewChains
        : yield* Effect.forEach(patch.reviewChains, (chain) =>
            Effect.map(Effect.forEach(chain.steps, canonicalModel), (steps) => ({
              ...chain,
              steps,
            })),
          );
    let nightlyReview: KanbanNightlyReview | null = board.nightlyReview;
    if (patch.nightlyReview !== undefined) {
      if (patch.nightlyReview === null) {
        nightlyReview = nightlyReview ? { ...nightlyReview, enabled: false } : null;
      } else {
        const settings = yield* Schema.decodeUnknownEffect(KanbanNightlyReviewSettings)(
          patch.nightlyReview,
        ).pipe(
          Effect.mapError(
            () =>
              new KanbanError({
                code: "invalid",
                detail: "Invalid nightly review time or time zone",
              }),
          ),
        );
        const model = yield* canonicalModel(settings.model);
        if (settings.enabled) yield* checkModel(model);
        nightlyReview = {
          ...settings,
          model,
          lastRunAt: board.nightlyReview?.lastRunAt ?? null,
          lastRunDay: board.nightlyReview?.lastRunDay ?? null,
          lastDiscussionId: board.nightlyReview?.lastDiscussionId ?? null,
        };
      }
    }
    const next: KanbanBoard = {
      ...board,
      ...fields,
      archivedAt:
        archived === undefined
          ? board.archivedAt
          : archived
            ? (board.archivedAt ?? (yield* nowIso))
            : null,
      nightlyReview,
      managerModel,
      evaluatorModel,
      defaultCardModel,
      reviewChains,
    };
    if (patch.managerModel) yield* checkModel(managerModel);
    if (patch.evaluatorModel) yield* checkModel(evaluatorModel);
    if (patch.defaultCardModel) yield* checkModel(defaultCardModel);
    // Only steps that differ from the stored chain are checked. A step already saved
    // (even if its model has since left the catalog) must not block fixing another step.
    for (const chain of patch.reviewChains === undefined ? [] : reviewChains) {
      const stored = board.reviewChains.find((c) => c.name === chain.name);
      for (const [index, step] of chain.steps.entries()) {
        const previous = stored?.steps[index];
        const unchanged =
          previous !== undefined &&
          previous.instanceId === step.instanceId &&
          previous.model === step.model &&
          sameOptions(previous.options ?? [], step.options ?? []);
        if (!unchanged) yield* checkModel(step);
      }
    }
    const pools =
      archived !== undefined && Object.keys(fields).length === 0
        ? []
        : missingPools(yield* store.pools(board.id), boardModels(next));
    if (archived === true && board.archivedAt === null) {
      const at = next.archivedAt!;
      const cards = yield* store.cards(board.id);
      const links = yield* store.threadLinks({ boardId: board.id, open: false });
      const discussions = yield* store.discussions(board.id);
      const ids = new Set(
        [
          ...links.map((link) => link.threadId),
          ...cards.flatMap((card) => [card.activeThreadId, card.workThreadId, card.reviewThreadId]),
          ...discussions.map((discussion) => discussion.evaluatorThreadId),
        ].filter((id): id is ThreadId => id !== null),
      );
      const reason = `Board "${board.name}" was deleted`;
      const stops = [...ids].map((threadId) => ({
        threadId,
        lane: `archive:${board.id}/${threadId}`,
        key: `effect:${uuid()}`,
      }));
      const publications: Array<BoardPublication> = [];
      const measurements: AnalyticsEvent[] = [];
      // The timestamp, releases and stop obligations must survive or roll back together.
      // Slot synchronization follows the outer commit so rollback cannot advance its cache.
      yield* tickTransaction(
        Effect.gen(function* () {
          yield* store.putBoardWithPools(next, pools, application);
          for (const stop of stops) {
            yield* saveOwnerRoute(board.id, KanbanDiscussionId.make(stop.lane), stop.key, {
              kind: "effect",
              seq: -1,
              effect: { kind: "interrupt", threadId: stop.threadId, reason, cancelQueued: true },
            });
          }
          for (const card of cards) {
            if (card.activeThreadId === null) continue;
            const released = {
              ...release(card),
              stage:
                card.stage === "working"
                  ? ("todo" as const)
                  : card.stage === "in_review"
                    ? ("needs_review" as const)
                    : card.stage,
              movedAt: at,
              updatedAt: at,
            };
            // The board Stop owns queue cancellation; release must do no thread I/O in this transaction.
            preparedTransitions.add(released);
            yield* endReviewLink(card.reviewThreadId, at);
            yield* saveCard(released, undefined, false, false);
          }
        }).pipe(
          Effect.provideService(publicationSink, publications),
          Effect.provideService(analyticsSink, measurements),
        ),
      ).pipe(
        Effect.andThen(
          Effect.forEach(
            new Map(
              cards.flatMap((card) =>
                card.activeThreadId === null ? [] : [[card.activeThreadId, card.id] as const],
              ),
            ),
            ([threadId, cardId]) => syncSlot(board.id, threadId, "card_left", cardId),
            { discard: true },
          ),
        ),
        Effect.uninterruptible,
      );
      for (const stop of stops) {
        archiveLanes?.add(stop.lane);
        addPendingStop(stop.threadId, stop.key, { kind: "interrupt", reason, cancelQueued: true });
        archivedThreads.set(stop.threadId, board.id);
        for (const pending of scopedWakeSends.get(stop.threadId) ?? []) {
          pending.stale = true;
          pending.archived = board.id;
        }
        yield* locks.access(board.id, Effect.void, true, stopResource(stop.threadId));
        yield* locks.access(board.id, Effect.void, true, interruptResource(stop.threadId));
      }
      for (const card of cards) {
        const pending = delivering.get(card.id);
        if (pending) pending.revoked = true;
      }
      for (const measurement of measurements) yield* recordAnalytics(measurement);
      for (const publication of publications)
        yield* publish(publication.boardId, publication.change);
    } else {
      const write = store.putBoardWithPools(next, pools, application);
      yield* !NodeUtil.isDeepStrictEqual(board.guessedGates, next.guessedGates)
        ? commitReviewGate(board.id, write.pipe(Effect.andThen(recheckBoardReviewGates(next))))
        : write;
    }
    if (pools.length > 0) {
      yield* publish(board.id, { _tag: "pools", pools: yield* store.pools(board.id) });
    }
    yield* publish(board.id, { _tag: "board", board: next });
    if (archived === false && board.archivedAt !== null) {
      for (const [threadId, archivedBoard] of archivedThreads)
        if (archivedBoard === board.id) archivedThreads.delete(threadId);
    }
    yield* kick;
    return next;
  });

  const updateBoard: KanbanServiceShape["updateBoard"] = (boardId, patch, actor) =>
    Effect.suspend(() => {
      const lanes = new Set<string>();
      return guard(
        "board.update",
        updateBoardUnlocked(boardId, patch, undefined, actor, lanes),
        undefined,
        boardId,
      ).pipe(Effect.onExit(() => Effect.forEach(lanes, afterOwnerCommit, { discard: true })));
    });

  const finishPurge = Effect.fn("KanbanService.finishPurge")(function* (boardId: KanbanBoardId) {
    const pending = (yield* store.pendingBoardPurges).filter((row) => row.boardId === boardId);
    for (const { threadId } of pending) {
      yield* Effect.gen(function* () {
        yield* threads.remove(threadId);
        yield* store.finishBoardPurgeThread(boardId, threadId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Board thread deletion will retry", { boardId, threadId, cause }),
        ),
      );
    }
    yield* publish(boardId, {
      _tag: "purgeThreads",
      boardId,
      threadIds: (yield* store.pendingBoardPurges)
        .filter((row) => row.boardId === boardId)
        .map((row) => row.threadId),
    });
  });

  const purgeBoard = Effect.fn("KanbanService.purgeBoard")(function* (
    boardId: KanbanBoardId,
    actor: KanbanActor,
  ) {
    if (actor._tag !== "owner")
      return yield* failWith("denied", "Only the owner can erase a board.", "role_not_allowed");
    yield* guard(
      "board.purge",
      Effect.gen(function* () {
        const board = yield* store.board(boardId);
        if (board !== null) {
          if (board.archivedAt === null)
            return yield* failWith("invalid", "Delete the board first.");
          if ((pendingLaunches.get(boardId) ?? 0) > 0)
            return yield* failWith(
              "conflict",
              "The board's threads are starting. Try erasing it again.",
            );
          const ids = yield* store.boardThreadIds(boardId);
          let stopping = false;
          for (const threadId of ids) {
            yield* threads.interrupt(threadId, `Board "${board.name}" is being erased`, true);
            const view = yield* threads.find(threadId);
            if (view !== null && (view.state !== "idle" || view.backgroundWork > 0))
              stopping = true;
          }
          if (stopping)
            return yield* failWith(
              "conflict",
              "The board's threads are stopping. Try erasing it again.",
            );
          yield* store.purgeBoard(boardId);
        }
        yield* finishPurge(boardId);
        yield* publish(boardId, { _tag: "boardRemoved", boardId });
      }),
      undefined,
      boardId,
    );
  });

  const applyApprovedInstructions: KanbanServiceShape["applyApprovedInstructions"] = Effect.fn(
    "KanbanService.applyApprovedInstructions",
  )(function* (boardId, field, text, cardId, askId, actor) {
    if (actor._tag !== "evaluator") {
      return yield* failWith("denied", "Only evaluators use this tool.", "role_not_allowed");
    }
    const result = yield* guard(
      "board.applyApprovedInstructions",
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const ask = card.asks.find((entry) => entry.id === askId);
        if (!ask)
          return yield* failWith(
            "not-found",
            `ask ${askId} on card #${card.number}`,
            undefined,
            "bad_reference",
            "ask",
          );
        if (!ask.closedAt)
          return yield* failWith("denied", `ask ${askId} is still open`, "ask_open");
        if (ask.answer?.verdict === "dropped") {
          return yield* failWith("denied", `ask ${askId} was dropped`, "ask_dropped");
        }
        if (ask.answer?.verdict === "rejected") {
          return yield* failWith("denied", `ask ${askId} was rejected`, "ask_rejected");
        }
        if (ask.answer?.by._tag !== "owner") {
          return yield* failWith(
            "denied",
            `ask ${askId} was not answered by the owner`,
            "answer_not_owner",
          );
        }
        if (ask.answer.verdict !== "approved") {
          return yield* failWith(
            "denied",
            `ask ${askId} does not have the owner's approval`,
            "approval_required",
          );
        }
        const board = yield* boardOf(boardId);
        const namesField = {
          escalation: ["escalation", "when to ask"],
          modelRouting: ["model routing", "modelRouting"],
          reviewerRouting: ["reviewer routing", "reviewerRouting"],
        }[field];
        const names = (label: string, name: string) => {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "iu").test(label);
        };
        const changes = [ask.change, ...(ask.changes ?? [])]
          .filter((entry) => entry !== undefined)
          .filter(
            (entry) =>
              (names(entry.label, board.slug) || names(entry.label, board.name)) &&
              namesField.some((name) => names(entry.label, name)),
          );
        if (changes.length === 0) {
          return yield* failWith(
            "denied",
            `ask ${askId} has no change entry labelled for board ${board.slug} and field ${field}`,
            "approval_change_missing",
          );
        }
        const normalized = (value: string) => value.replace(/\r\n/g, "\n").trim();
        const approved = changes.filter((entry) => normalized(entry.after) === normalized(text));
        if (approved.length === 0) {
          return yield* failWith(
            "denied",
            `text differs from the approved after in ask ${askId}`,
            "approved_payload_mismatch",
          );
        }
        if (normalized(board.instructions[field]) === normalized(text)) {
          return { board, applied: false, reason: "already set" };
        }
        if (
          !approved.some(
            (entry) => normalized(entry.before) === normalized(board.instructions[field]),
          )
        ) {
          return yield* failWith(
            "denied",
            "the board's text changed since he approved it; ask again",
            "approval_base_changed",
          );
        }
        const application: InstructionApplication = {
          id: NodeCrypto.randomUUID(),
          boardId: board.id,
          boardSlug: board.slug,
          cardId,
          field,
          askId,
          threadId: actor.threadId,
        };
        const next = yield* updateBoardUnlocked(
          board.id,
          {
            instructions: { ...board.instructions, [field]: text },
          },
          application,
        );
        return { board: next, applied: true };
      }),
    );
    // Receipts commit with the board write. A fresh card operation drains them
    // independently, so failed audits can retry without hiding later applications.
    yield* guard(
      "board.auditApprovedInstructions",
      Effect.gen(function* () {
        for (const application of yield* store.pendingInstructionApplications(
          cardId,
          boardId,
          field,
          askId,
        )) {
          yield* editCard(
            cardId,
            {
              comment: `Applied ${application.field} on board ${application.boardSlug} from ${application.askId} (by ${application.threadId})`,
            },
            { _tag: "evaluator", threadId: application.threadId },
            application,
          );
        }
      }),
      cardId,
    );
    return result;
  });

  const applyApprovedSettings: KanbanServiceShape["applyApprovedSettings"] = Effect.fn(
    "KanbanService.applyApprovedSettings",
  )(function* (boardId, setting, value, cardId, askId, actor) {
    if (actor._tag !== "evaluator") {
      return yield* failWith("denied", "Only evaluators use this tool.", "role_not_allowed");
    }
    const result = yield* guard(
      "board.applyApprovedSettings",
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const ask = card.asks.find((entry) => entry.id === askId);
        if (!ask)
          return yield* failWith(
            "not-found",
            `ask ${askId} on card #${card.number}`,
            undefined,
            "bad_reference",
            "ask",
          );
        if (!ask.closedAt)
          return yield* failWith("denied", `ask ${askId} is still open`, "ask_open");
        if (ask.answer?.verdict === "dropped") {
          return yield* failWith("denied", `ask ${askId} was dropped`, "ask_dropped");
        }
        if (ask.answer?.verdict === "rejected") {
          return yield* failWith("denied", `ask ${askId} was rejected`, "ask_rejected");
        }
        if (ask.answer?.by._tag !== "owner") {
          return yield* failWith(
            "denied",
            `ask ${askId} was not answered by the owner`,
            "answer_not_owner",
          );
        }
        if (ask.answer.verdict !== "approved") {
          return yield* failWith(
            "denied",
            `ask ${askId} does not have the owner's approval`,
            "approval_required",
          );
        }
        const board = yield* boardOf(boardId);
        const namesField = ["guessed gates", "guessedGates"];
        const names = (label: string, name: string) => {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "iu").test(label);
        };
        const changes = [ask.change, ...(ask.changes ?? [])]
          .filter((entry) => entry !== undefined)
          .filter(
            (entry) =>
              (names(entry.label, board.slug) || names(entry.label, board.name)) &&
              namesField.some((name) => names(entry.label, name)),
          );
        if (changes.length === 0) {
          return yield* failWith(
            "denied",
            `ask ${askId} has no change entry labelled for board ${board.slug} and setting ${setting}`,
            "approval_change_missing",
          );
        }
        const normalized = (value: string) => value.replace(/\r\n/g, "\n").trim();
        const guessedGates = [...value].sort();
        const text = guessedGates.join(", ");
        const current =
          board.guessedGates === undefined ? "(unset)" : [...board.guessedGates].sort().join(", ");
        const approved = changes.filter((entry) => normalized(entry.after) === normalized(text));
        if (approved.length === 0) {
          return yield* failWith(
            "denied",
            `value differs from the approved after in ask ${askId}`,
            "approved_payload_mismatch",
          );
        }
        if (normalized(current) === normalized(text)) {
          return { board, applied: false, reason: "already set" };
        }
        if (!approved.some((entry) => normalized(entry.before) === normalized(current))) {
          return yield* failWith(
            "denied",
            "the board's setting changed since he approved it; ask again",
            "approval_base_changed",
          );
        }
        const application: InstructionApplication = {
          id: NodeCrypto.randomUUID(),
          boardId: board.id,
          boardSlug: board.slug,
          cardId,
          field: setting,
          askId,
          threadId: actor.threadId,
        };
        const next = yield* updateBoardUnlocked(
          board.id,
          {
            guessedGates,
          },
          application,
        );
        return { board: next, applied: true };
      }),
    );
    // Receipts commit with the board write. A fresh card operation drains them
    // independently, so failed audits can retry without hiding later applications.
    yield* guard(
      "board.auditApprovedSettings",
      Effect.gen(function* () {
        for (const application of yield* store.pendingInstructionApplications(
          cardId,
          boardId,
          setting,
          askId,
        )) {
          yield* editCard(
            cardId,
            {
              comment: `Applied ${application.field} on board ${application.boardSlug} from ${application.askId} (by ${application.threadId})`,
            },
            { _tag: "evaluator", threadId: application.threadId },
            application,
          );
        }
      }),
      cardId,
    );
    return result;
  });

  const checkStandingEvaluator = Effect.fn("KanbanService.checkStandingEvaluator")(function* (
    actor: KanbanActor,
  ) {
    if (actor._tag !== "evaluator")
      return yield* failWith(
        "denied",
        "only evaluators may grant or revoke standing approvals",
        "role_not_allowed",
      );
    const link = yield* store.threadLink(actor.threadId);
    if (link?.role !== "evaluator")
      return yield* failWith(
        "denied",
        "only evaluators may grant or revoke standing approvals",
        "role_not_allowed",
      );
  });

  const saveStandingApprovals = Effect.fn("KanbanService.saveStandingApprovals")(function* (
    board: KanbanBoard,
    standingApprovals: ReadonlyArray<KanbanStandingApproval>,
    action: string,
  ) {
    const next = { ...board, standingApprovals };
    yield* commitReviewGate(
      board.id,
      store.putBoard(next).pipe(Effect.andThen(recheckBoardReviewGates(next))),
    );
    yield* publish(board.id, { _tag: "board", board: next });
    yield* Effect.logInfo("kanban.standing-approval", {
      boardId: board.id,
      action,
      records: standingApprovals.map((entry) => ({
        id: entry.id,
        recordedBy: entry.recordedBy,
        revokedBy: entry.revokedBy,
        revokedAt: entry.revokedAt,
      })),
    });
    return next;
  });

  const revokeStandingUnlocked = Effect.fn("KanbanService.revokeStandingUnlocked")(function* (
    board: KanbanBoard,
    id: string | undefined,
    reason: string,
    actor: KanbanActor,
  ) {
    if (!reason.trim())
      return yield* failWith("invalid", "revoking a standing approval needs a reason");
    const at = yield* nowIso;
    return yield* saveStandingApprovals(
      board,
      board.standingApprovals.map((entry) =>
        entry.revokedAt === null && (id === undefined || entry.id === id)
          ? {
              ...entry,
              revokedAt: at,
              revokedBy:
                actor._tag === "owner" ? "owner" : actor._tag === "evaluator" ? actor.threadId : "",
              revokeReason: reason.trim(),
            }
          : entry,
      ),
      "revoke",
    );
  });

  const revokeStandingApproval: KanbanServiceShape["revokeStandingApproval"] = (
    boardId,
    id,
    reason,
    actor,
  ) =>
    guard(
      "board.standing-approval.revoke",
      Effect.gen(function* () {
        if (actor._tag !== "owner") yield* checkStandingEvaluator(actor);
        yield* checkText([["reason", reason]]);
        return yield* revokeStandingUnlocked(yield* boardOf(boardId), id, reason, actor);
      }),
    );

  const standingApproval: KanbanServiceShape["standingApproval"] = (boardId, input, actor) =>
    guard(
      "board.standing-approval",
      Effect.gen(function* () {
        yield* checkStandingEvaluator(actor);
        if (actor._tag !== "evaluator")
          return yield* failWith(
            "denied",
            "only evaluators may grant or revoke standing approvals",
            "role_not_allowed",
          );
        const own = yield* boardOf(boardId);
        const slugs = [...new Set(input.boards ?? [own.slug])];
        if (slugs.length === 0) return yield* failWith("invalid", "name at least one board");
        const all = yield* store.boards;
        const boards: KanbanBoard[] = [];
        for (const slug of slugs) {
          const board = all.find((entry) => entry.slug === slug);
          if (!board) return yield* failWith("not-found", `board slug ${slug}`);
          boards.push(board);
        }
        yield* checkText([
          ["quote", input.quote],
          ["reason", input.reason],
          ["sourceThreadId", input.sourceThreadId],
        ]);
        const changed: KanbanBoard[] = [];
        const openReleaseAsks: { board: string; card: number; ask: string }[] = [];
        if (input.action === "revoke") {
          if (!input.reason?.trim())
            return yield* failWith("invalid", "revoking a standing approval needs a reason");
          for (const board of boards)
            changed.push(
              yield* revokeStandingUnlocked(
                yield* boardOf(board.id),
                input.id,
                input.reason,
                actor,
              ),
            );
          return { boards: changed, openReleaseAsks };
        }
        if (!input.cardId || !input.ask)
          return yield* failWith("invalid", "grant needs an owner-approved card and ask");
        const card = yield* cardOf(input.cardId);
        const ask = card.asks.find((entry) => entry.id === input.ask);
        const answer = ask?.answer;
        const others =
          answer?.optionIds?.length === 1
            ? (ask?.options ?? [])
                .filter((option) => !answer.optionIds!.includes(option.id))
                .map((option) => option.label)
            : [];
        if (
          !ask?.closedAt ||
          answer?.by._tag !== "owner" ||
          !(
            answer.verdict === "approved" ||
            (answer.verdict === "picked" &&
              Boolean(answer.optionIds?.length) &&
              answer.optionIds!.every((id) => {
                const option = ask.options?.find((entry) => entry.id === id);
                return (
                  option !== undefined &&
                  Subtasks.approvesGate(
                    option.label,
                    "deploy",
                    ask.action?.summary ?? ask.text,
                    others,
                  )
                );
              }))
          )
        )
          return yield* failWith(
            "denied",
            "grant needs a closed ask approved by the owner (not open, dropped or answered by an evaluator)",
            "approval_required",
          );
        const words = `${ask.text} ${ask.title ?? ""} ${ask.action?.summary ?? ""} ${ask.action?.target ?? ""}`;
        for (const board of boards) {
          if (
            !words
              .toLowerCase()
              .split(/[^a-z0-9_-]+/)
              .includes(board.slug)
          )
            return yield* failWith(
              "denied",
              `owner-approved ask must name board ${board.slug} as a whole word`,
              "approval_board_not_named",
            );
        }
        const at = yield* nowIso;
        const record = yield* decodeStandingApproval({
          id: `sa-${uuid()}`,
          gate: "deploy",
          quote: input.quote,
          sourceThreadId: input.sourceThreadId,
          saidAt: input.saidAt,
          approvedAsk: { cardId: card.id, askId: ask.id },
          recordedAt: at,
          recordedBy: actor.threadId,
          revokedAt: null,
          revokedBy: null,
          revokeReason: null,
        }).pipe(
          Effect.mapError(
            () =>
              new KanbanError({
                code: "invalid",
                detail: "grant needs quote, sourceThreadId and a valid saidAt",
              }),
          ),
        );
        for (const board of boards) {
          const current = yield* boardOf(board.id);
          const history = current.standingApprovals.map((entry) =>
            entry.revokedAt === null
              ? { ...entry, revokedAt: at, revokedBy: actor.threadId, revokeReason: "superseded" }
              : entry,
          );
          changed.push(
            yield* saveStandingApprovals(
              current,
              [...history, { ...record, id: `sa-${uuid()}` }],
              "grant",
            ),
          );
          for (const card of yield* store.openCards(board.id))
            for (const ask of kanbanOpenAsks(card)) {
              if (
                /(?:^|[^a-z])(?:deploy|release|install|restart)[a-z]*/i.test(
                  `${ask.batchKey ?? ""} ${ask.text}`,
                )
              )
                openReleaseAsks.push({ board: board.slug, card: card.number, ask: ask.id });
            }
        }
        yield* kick;
        return { boards: changed, openReleaseAsks };
      }),
    );

  const openBoard: KanbanServiceShape["openBoard"] = (input) =>
    guard(
      "board.open",
      Effect.gen(function* () {
        const slug = input.slug.trim().toLowerCase();
        const board =
          (yield* store.boards).find((existing) => existing.slug === slug) ??
          (yield* insertBoardUnlocked({ ...input, slug }));
        const patch: BoardPatch = {
          ...(input.defaultProjectId && board.defaultProjectId === null
            ? { defaultProjectId: input.defaultProjectId }
            : {}),
          ...(input.icon && board.icon === null ? { icon: input.icon } : {}),
        };
        return Object.keys(patch).length === 0
          ? board
          : yield* updateBoardUnlocked(board.id, patch);
      }),
      undefined,
      `board-${input.slug.trim().toLowerCase()}`,
    );

  /**
   * The open card an evaluator's or a thread's new card would duplicate: the same
   * title, or the same source link. PR, Linear and card links are left out, since
   * follow-up cards share those legitimately.
   */
  const openTwin = (
    cards: ReadonlyArray<KanbanCard>,
    input: NewCard,
  ): { readonly card: KanbanCard; readonly why: "title" | "source link" } | null => {
    const squash = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
    // The title draftCard will save, so an omitted title matches its fallback.
    const prompt = input.prompt.trim();
    const saved = input.title?.trim() || (prompt.length > 0 ? fallbackTitle(prompt) : "");
    const title = saved ? squash(saved) : "";
    // Shared follow-up links don't count: study parents (t3-context) and PR or Linear links.
    const sourceUrl = (url: string) => !url.startsWith("t3-context://") && linkKind(url) === "url";
    const urls = new Set(
      (input.links ?? [])
        .filter((link) => (link.kind ?? linkKind(link.url.trim())) === "url")
        .map((link) => link.url.trim())
        .filter(sourceUrl),
    );
    for (const card of cards) {
      if (card.settledAt !== null || KANBAN_DONE_STAGES.has(card.stage)) continue;
      if (title && squash(card.title) === title) return { card, why: "title" };
      if (card.links.some((link) => link.kind === "url" && urls.has(link.url))) {
        return { card, why: "source link" };
      }
    }
    return null;
  };

  /** Evaluators and threads don't file a second open card for the same request. */
  const refuseTwin = Effect.fn("KanbanService.refuseTwin")(function* (
    boardId: KanbanBoard["id"],
    input: NewCard,
    actor: KanbanActor,
  ) {
    if (actor._tag !== "evaluator" && actor._tag !== "thread") return;
    const twin = openTwin(yield* store.openCards(boardId), input);
    if (twin) {
      return yield* failWith(
        "conflict",
        `card #${twin.card.number} "${twin.card.title}" is already open with the same ${twin.why}; add to it (card_edit / comment) instead of a second card`,
        "conflict",
        twin.why === "title" ? "duplicate_title" : "duplicate_link",
        twin.why === "title" ? "title" : "links",
      );
    }
  });

  /** A new card as it would be saved; nothing is written yet. */
  const draftCard = Effect.fn("KanbanService.draftCard")(function* (
    boardId: KanbanBoard["id"],
    input: NewCard,
    actor: KanbanActor,
  ) {
    const board = yield* boardOf(boardId);
    const prompt = input.prompt.trim();
    if (prompt.length === 0 && !input.title?.trim()) {
      return yield* failWith(
        "invalid",
        "a card needs a prompt or a title",
        "invalid_args",
        "missing_required",
        "title",
      );
    }
    const at = yield* nowIso;
    const stage = input.stage ?? "todo";
    const models = input.models ? yield* cardModels(boardId, input.models) : [];
    if (
      actor._tag !== "evaluator" &&
      input.subtasks?.some(
        (entry) =>
          entry.ownerOnly !== undefined ||
          entry.interrupting !== undefined ||
          entry.service !== undefined,
      )
    )
      return yield* failWith(
        "denied",
        "only evaluators may set or clear ownerOnly, interrupting or service",
        "role_not_allowed",
      );
    const plan = Subtasks.planSubtasks([], input.subtasks ?? [], 0, at, board.guessedGates);
    if (!plan.ok)
      return yield* failWith("invalid", plan.reason, plan.denyReason, "other", "subtasks");
    yield* checkScriptNames(boardId, plan.subtasks);
    return {
      id: KanbanCardId.make(`card-${uuid()}`),
      boardId,
      number: yield* store.nextCardNumber(boardId),
      title: input.title?.trim() || fallbackTitle(prompt),
      description: input.description?.trim() ?? "",
      prompt,
      subtasks: plan.subtasks,
      subtaskSeq: plan.subtaskSeq,
      stage,
      priority: clampPriority(input.priority, 3),
      goalId: input.goalId ?? null,
      projects: input.projects ?? [],
      model: models[0]?.model ?? (yield* poolModel(boardId, input.model ?? board.defaultCardModel)),
      // One model needs no list.
      models: models.length > 1 ? models : [],
      projectId: input.projectId ?? null,
      links: mergeLinks([], input.links ?? []),
      blockedBy: input.blockedBy ?? [],
      stalled: null,
      question: stage === "needs_owner" ? (input.question ?? null) : null,
      asks:
        stage === "needs_owner" && input.question?.trim()
          ? [
              {
                id: "q1",
                text: input.question.trim(),
                blocking: true,
                by: actor,
                at,
                seq: null,
                closedAt: null,
              },
            ]
          : [],
      reviewChain: input.reviewChain ?? null,
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
      createdBy: actor,
      createdAt: at,
      updatedAt: at,
      movedAt: at,
    } satisfies KanbanCard;
  });

  /** Saves a drafted card; the writer fills in a missing title or description. */
  const insertCard = Effect.fn("KanbanService.insertCard")(function* (
    card: KanbanCard,
    input: NewCard,
  ) {
    yield* logEvent(card, card.createdBy, "created", { toStage: card.stage });
    yield* saveCard(card);
    const needTitle = !input.title?.trim();
    const needDescription = !input.description?.trim();
    if (card.prompt.length > 0 && (needTitle || needDescription)) {
      yield* forkWriter(card.id, { title: needTitle, description: needDescription });
    }
    yield* kick;
    return card;
  });

  const createCardUnlocked = Effect.fn("KanbanService.createCardUnlocked")(function* (
    boardId: KanbanBoard["id"],
    input: NewCard,
    actor: KanbanActor,
  ) {
    yield* checkText(cardTextFields(input));
    // A thread's or a script's card waits for an evaluator to write its packet;
    // the owner's and the evaluators' own come written.
    const packet = Subtasks.needsPacketStep(actor);
    const fields = packet
      ? { ...input, subtasks: Subtasks.withPacketStep(input.subtasks ?? []) }
      : input;
    yield* refuseTwin(boardId, fields, actor);
    const card = yield* insertCard(yield* draftCard(boardId, fields, actor), fields);
    if (packet) yield* laterEvaluatorTurn(null, card, actor);
    const ask = Asks.openBlockingAsk(card);
    return ask ? yield* postAsk(card, ask, []) : card;
  });

  const createCard: KanbanServiceShape["createCard"] = (boardId, input, actor) =>
    guardDeferred("card.create", createCardUnlocked(boardId, input, actor));

  /**
   * Where a work thread stands: its board, pool, project, the cards it carries
   * and the card it started on, whose review chain and goal new cards inherit.
   */
  const workThreadOf = Effect.fn("KanbanService.workThreadOf")(function* (
    threadId: ThreadId,
    compact = false,
  ) {
    const reader = compact ? rawStore : store;
    const link = yield* reader.threadLink(threadId);
    if (!link || link.role !== "work") {
      return yield* failWith("denied", "only a card's work thread takes cards", "role_not_allowed");
    }
    const board = yield* boardOf(link.boardId);
    // A single caller row must not wait behind interactive state snapshots.
    const context = compact
      ? yield* threads.claimContext(threadId).pipe(NodeSqliteClient.identityReadOnly)
      : null;
    const view = compact
      ? context
      : yield* threads.view(threadId).pipe(Effect.withSpan("read.workThread.view"));
    if (!view)
      return yield* failWith(
        "not-found",
        `thread ${threadId}`,
        "resource_not_found",
        "bad_reference",
        "threadId",
      );
    const carried = yield* reader.cardsByThread(threadId);
    const held = (yield* Ref.get(holds)).get(threadId);
    // Past the last card and the hold, the thread's own model still names its pool.
    const pool =
      carried[0]?.activePool ??
      held?.pool ??
      Rules.poolOf(
        yield* reader.pools(board.id),
        context?.model ??
          (yield* threads.model(threadId).pipe(Effect.withSpan("read.workThread.model"))) ??
          link.model ??
          board.defaultCardModel,
      );
    const origin = compact
      ? null
      : (carried[0] ?? (link.cardId ? yield* store.card(link.cardId) : null));
    return {
      link,
      board,
      projectId: view.projectId,
      carried,
      origin,
      pool,
    };
  });

  const takeCapacity = Effect.fn("KanbanService.takeCapacity")(function* (
    threadId: ThreadId,
    thread: {
      readonly board: KanbanBoard;
      readonly pool: string;
      readonly carried: ReadonlyArray<KanbanCard>;
    },
  ) {
    const pools = yield* store.pools(thread.board.id);
    const slots = pools.find((pool) => pool.key === thread.pool)?.slots ?? 0;
    const held = (yield* Ref.get(holds)).get(threadId);
    const holdsSlot =
      thread.carried.length > 0 || (held?.boardId === thread.board.id && held.pool === thread.pool);
    const carrying =
      thread.carried.length +
      [...starting.values()].filter((pending) => pending.threadId === threadId).length;
    let eligible = slots > 0 && carrying < Rules.MAX_BATCH;
    if (eligible && !holdsSlot) {
      const occupied = new Set(yield* store.poolThreadIds(thread.board.id, thread.pool));
      for (const [id, pool] of yield* boardHolds(thread.board.id)) {
        if (pool === thread.pool) occupied.add(id);
      }
      eligible = occupied.size < slots;
    }
    return { pools, slots, carrying, holdsSlot, eligible };
  });

  /** Every card a thread has carried, owned now or not. */
  const carriedIds = Effect.fn("KanbanService.carriedIds")(function* (threadId: ThreadId) {
    const ids = new Set<string>(yield* store.threadCards(threadId));
    // Threads started before batching only have their first card on the link.
    const link = yield* store.threadLink(threadId);
    if (link?.cardId) ids.add(link.cardId);
    return ids;
  });

  /** Fails unless the work thread may take `card` now (see `Rules.checkClaim`). */
  /**
   * A card let go of this thread and its stop hasn't run yet: the thread is
   * about to be cut, so nothing attaches work to it until then (claims,
   * follow-ups, cutover restores). Checked under the board gate before any
   * write; stops are only registered in board-wide operations.
   */
  const refusePendingStop = Effect.fn("KanbanService.refusePendingStop")(function* (
    threadId: string,
  ) {
    const id = ThreadId.make(threadId);
    const stoppedRun = pendingRunStops.get(id);
    if (stoppedRun !== undefined) {
      const settled = yield* threads
        .runSettled(id, stoppedRun)
        .pipe(Effect.orElseSucceed(() => false));
      if (settled && pendingRunStops.get(id) === stoppedRun) pendingRunStops.delete(id);
    }
    if (inFlightStops.has(id) || pendingRunStops.has(id))
      return yield* failWith(
        "conflict",
        "This thread is being stopped; it can't take another card until that stop has finished.",
      );
    const pending = [...(pendingStops.get(threadId)?.values() ?? [])];
    if (pending.length === 0) return;
    return yield* pending.some((entry) => entry.kind === "interrupt")
      ? failWith(
          "conflict",
          "This thread is being stopped (the board let it go of a card); it can't take another card until that stop has run.",
        )
      : failWith(
          "conflict",
          "The board is still telling this thread to let go of a card; try again in a moment.",
        );
  });
  /**
   * A thread taking a card first gets the drop and pause notes still pending
   * for it (outside the gate, as dispatch does before reusing a thread). A
   * note saved meanwhile moves the thread's stop resource, so the take reruns
   * and sends it too. Pending stops are left to refuse the take.
   */
  const settlePendingNotes = (boardId: string, threadId: string, includeStops = false) =>
    Effect.suspend(() => {
      const pending = [...(pendingStops.get(threadId)?.values() ?? [])];
      if (
        pending.length === 0 ||
        (inFlightStops.has(ThreadId.make(threadId)) &&
          pending.some((entry) => entry.kind === "interrupt" && entry.cancelQueued === true)) ||
        (!includeStops && pending.some((entry) => entry.kind === "interrupt"))
      ) {
        return Effect.void;
      }
      // A note that fails to go out stays pending; the take is then refused below.
      return locks.access(boardId, Effect.void, false, stopResource(threadId)).pipe(
        Effect.andThen(
          // Safe to rerun when stale (a note saved meanwhile): sends are keyed and
          // closes durable, so a rerun sends only what is still pending.
          locks.outside(
            runPendingStops(threadId).pipe(
              Effect.catchTags({ KanbanThreadError: () => Effect.void }),
            ),
            undefined,
            true,
          ),
        ),
      );
    });
  const checkTake = Effect.fn("KanbanService.checkTake")(function* (
    thread: {
      readonly board: KanbanBoard;
      readonly pool: string;
      readonly projectId: ProjectId;
      readonly carried: ReadonlyArray<KanbanCard>;
    },
    threadId: ThreadId,
    card: KanbanCard,
  ) {
    yield* settlePendingNotes(thread.board.id, threadId);
    yield* refusePendingStop(threadId);
    if (starting.has(`${card.boardId}:${card.id}`)) {
      return yield* failWith(
        "conflict",
        `card #${card.number} is starting; wait for its assignment`,
      );
    }
    if (settingUp.has(card.boardId))
      return yield* failWith("denied", "Setup is starting", "board_setup_starting");
    if (card.boardId !== thread.board.id) {
      return yield* failWith("denied", `card #${card.number} is on another board`, "cross_board");
    }
    const cards = yield* store.openCards(card.boardId);
    const capacity = yield* takeCapacity(threadId, thread);
    const check = Rules.checkClaim(thread.board, card, {
      threadId,
      pool: thread.pool,
      projectId: thread.projectId,
      byId: new Map(cards.map((entry) => [entry.id as string, entry])),
      carrying: capacity.carrying,
      slots: capacity.slots,
      pools: capacity.pools,
      nowMs: yield* nowMillis,
    });
    if (!check.ok)
      return yield* failWith(
        "denied",
        check.reason,
        ("denyReason" in check ? check.denyReason : undefined) ?? "role_not_allowed",
      );
    if (!capacity.eligible) {
      return yield* failWith(
        "denied",
        `no free slot on ${thread.pool}; leave it in todo`,
        "pool_full",
      );
    }
  });

  /** Puts a checked todo card on its new work thread. */
  const takeCard = Effect.fn("KanbanService.takeCard")(function* (
    threadId: ThreadId,
    pool: string,
    card: KanbanCard,
    how: string,
    actor: KanbanActor = { _tag: "thread", threadId },
  ) {
    // Checked in `checkTake` before anything is written; again here, defensively.
    yield* refusePendingStop(threadId);
    const at = yield* nowIso;
    const next: KanbanCard = {
      ...(yield* moveWait(card, "working", at, actor)),
      model: Rules.modelOnPool(card, pool, yield* store.pools(card.boardId)) ?? card.model,
      stage: "working",
      activeThreadId: threadId,
      activeRole: "work",
      activePool: pool,
      workThreadId: threadId,
      wakeNote: null,
      nudgedAt: null,
      movedAt: at,
      updatedAt: at,
    };
    // Threads started before batching never recorded their first card; without
    // it the board would take this thread for a one-card thread and copy all
    // its PRs onto the new card.
    const link = yield* store.threadLink(threadId);
    if (link?.cardId) yield* store.addThreadCard(threadId, link.cardId, link.startedAt);
    yield* store.addThreadCard(threadId, card.id, at);
    if (card.workThreadId !== threadId) {
      yield* logEvent(next, actor, "thread", { body: `work thread ${threadId}` });
    }
    yield* logEvent(next, actor, "moved", { fromStage: card.stage, toStage: "working", body: how });
    yield* saveCard(next, undefined, false, "join");
    yield* dropHold(threadId, "join");
    return {
      card: next,
      brief: Briefs.claimBrief(next, yield* goalOf(next), card.wakeNote),
    } satisfies ClaimResult;
  });

  const claimCard: KanbanServiceShape["claimCard"] = (threadId, cardId) =>
    SavedWrite.subSteps(
      "card.claim",
      guard(
        "card.claim",
        Effect.gen(function* () {
          // Repairs and pending notes do not acknowledge the requested claim.
          const { thread, card } = yield* Effect.gen(function* () {
            yield* reconcileRunFailureUnlocked(threadId).pipe(
              Effect.withSpan("reconcile.runFailure"),
            );
            const thread = yield* workThreadOf(threadId);
            const card = (yield* upgradeFindings([yield* cardOf(cardId)]))[0]!;
            yield* checkTake(thread, threadId, card);
            return { thread, card };
          }).pipe(SavedWrite.preparatory);
          return yield* takeCard(threadId, thread.pool, card, "Taken by its work thread");
        }),
      ),
      true,
    );

  const sendCreatedAssignment = Effect.fn("KanbanService.sendCreatedAssignment")(function* (
    cardId: KanbanCardId,
    threadId: ThreadId,
    key: string,
  ) {
    const card = yield* cardOf(cardId);
    if (card.stage !== "working" || card.activeThreadId !== threadId || card.activeRole !== "work")
      return;
    yield* refusePendingStop(threadId);
    yield* sendThread(
      {
        threadId,
        text: Briefs.claimBrief(card, yield* goalOf(card), card.wakeNote),
        key,
        mode: "queue",
        coalesce: `assignment:${card.id}`,
      },
      undefined,
      undefined,
      true,
    );
  });

  // The card is checked as a draft first, so a refused take leaves nothing
  // behind for the dispatcher to start twice.
  const createForThread: KanbanServiceShape["createForThread"] = (threadId, input, assignment) =>
    guardDeferred(
      "card.createForThread",
      Effect.gen(function* () {
        const { thread, fields, draft, actor } = yield* Effect.gen(function* () {
          yield* checkText(cardTextFields(input));
          const thread = yield* workThreadOf(threadId);
          if (assignment !== undefined) {
            if (thread.board.id !== assignment.boardId)
              return yield* failWith(
                "denied",
                "The target work thread is on another board. Nothing was saved.",
                "cross_board",
              );
            const view = yield* threads.find(threadId);
            if (
              thread.link.endedAt !== null ||
              thread.link.paused !== null ||
              !view ||
              view.archived
            )
              return yield* failWith(
                "denied",
                "The target work thread is stopped, ended or missing. Nothing was saved.",
                "target_thread_unavailable",
              );
            const latest = view.state === "idle" ? yield* threads.latestRun(threadId) : null;
            if (latest?.status === "cancelled" || latest?.status === "interrupted")
              return yield* failWith(
                "denied",
                "The target work thread was stopped. Nothing was saved.",
                "target_thread_stopped",
              );
            if (input.stage === "needs_owner" || input.priority === KANBAN_BACKLOG)
              return yield* failWith(
                "denied",
                "forThread needs a todo card outside the backlog. Nothing was saved.",
                "stage_not_allowed",
              );
          }
          // The thread's live model comes first: a switch moves the thread even after every
          // card that carried the switch is released, and the held slot follows it.
          const live = yield* threads.model(threadId);
          const pools = yield* store.pools(thread.board.id);
          const model = input.model
            ? yield* poolModel(thread.board.id, input.model)
            : (live ??
              thread.carried[0]?.model ??
              thread.link.model ??
              pools.find((pool) => pool.key === thread.pool)?.model ??
              thread.board.defaultCardModel);
          // A weighted list is checked by the take: one of its models must run here.
          if (!input.models && Rules.poolOf(pools, model) !== thread.pool) {
            return yield* failWith(
              "denied",
              `this thread runs ${thread.pool}; the card runs on ${Rules.poolOf(pools, model)}. Nothing was saved.`,
              "model_pool_mismatch",
            );
          }
          const fields: NewCard = {
            ...input,
            model,
            stage: "todo",
            question: null,
            projectId:
              input.projectId ??
              (thread.projectId === thread.board.defaultProjectId ? null : thread.projectId),
            // Follow-up work keeps the scrutiny of the card it came from.
            reviewChain: thread.origin ? thread.origin.reviewChain : (input.reviewChain ?? null),
            goalId: input.goalId ?? thread.origin?.goalId ?? null,
          };
          const actor: KanbanActor = assignment?.actor ?? { _tag: "thread", threadId };
          yield* refuseTwin(thread.board.id, fields, actor);
          const draft = yield* draftCard(thread.board.id, fields, actor);
          yield* checkTake(thread, threadId, draft);
          return { thread, fields, draft, actor };
        }).pipe(
          Effect.mapError((cause) => {
            const error = toKanbanError(cause);
            return assignment === undefined || error.detail.endsWith("Nothing was saved.")
              ? error
              : new KanbanError({
                  code: error.code,
                  reason: error.reason ?? "operation_failed",
                  ...(error.reasonClass === undefined ? {} : { reasonClass: error.reasonClass }),
                  ...(error.invalidField === undefined ? {} : { invalidField: error.invalidField }),
                  detail: `${error.detail}. Nothing was saved.`,
                });
          }),
        );
        const card = yield* insertCard(draft, fields);
        const result = yield* takeCard(
          threadId,
          thread.pool,
          card,
          assignment === undefined
            ? "Created and taken by its work thread"
            : `Assigned by evaluator ${assignment.actor.threadId} to work thread ${threadId}`,
          actor,
        );
        if (assignment !== undefined)
          yield* later(
            card.boardId,
            cardLane(result.card),
            { kind: "assignment", cardId: card.id, threadId },
            sendCreatedAssignment(card.id, threadId, `created:${card.id}`),
          );
        return result;
      }),
    );

  const nextCards: KanbanServiceShape["nextCards"] = Effect.fn("KanbanService.nextCards")(
    function* (threadId) {
      yield* Effect.annotateCurrentSpan("kanban.thread_id", threadId);
      return yield* readDb(
        Effect.gen(function* () {
          const thread = yield* CardNextMetrics.stage("caller", workThreadOf(threadId, true));
          const { pools, slots, carrying, holdsSlot, eligible } = yield* CardNextMetrics.stage(
            "occupancy",
            takeCapacity(threadId, thread),
          );
          const empty = {
            carrying: thread.carried,
            candidates: [],
            holdsSlot,
          } satisfies NextCards;
          if (!eligible) return empty;
          const { cards, seeds, groups } = yield* CardNextMetrics.stage(
            "cards",
            Effect.gen(function* () {
              const carried = yield* carriedIds(threadId);
              if (carried.size === 0) return { cards: [], seeds: [], groups: [] };
              // Include every blocker recursively so a held card cannot look claimable.
              const cards = yield* store.claimCards(thread.board.id, [...carried]);
              return {
                cards,
                seeds: cards.filter(
                  (card) => carried.has(card.id) && card.workThreadId === threadId,
                ),
                groups: yield* store.groups(thread.board.id),
              };
            }),
          );
          const input = {
            board: thread.board,
            cards,
            groups,
            seeds,
            threadId,
            pool: thread.pool,
            projectId: thread.projectId,
            carrying,
            slots,
            pools,
          };
          // Ranking the whole board cannot affect an empty or single-card answer.
          const candidates = yield* CardNextMetrics.stage(
            "rules",
            Effect.sync(() =>
              Rules.relatedCandidates({ ...input, rankingCards: [], limit: cards.length }),
            ),
          );
          if (candidates.length <= 1) return { ...empty, candidates };
          const rankingCards = yield* CardNextMetrics.stage(
            "ranking",
            store.schedulingCards(thread.board.id),
          );
          return {
            ...empty,
            candidates: yield* CardNextMetrics.stage(
              "rules",
              Effect.sync(() => Rules.relatedCandidates({ ...input, rankingCards })),
            ),
          };
        }),
      ).pipe(NodeSqliteClient.foregroundReads);
    },
  );

  /**
   * A card moved to the backlog while a thread has it is paused: the thread
   * lets go, and the card keeps its work thread, so leaving the backlog
   * sends it back to that thread.
   */
  const pauseIfBacklog = Effect.fn("KanbanService.pauseIfBacklog")(function* (
    card: KanbanCard,
    next: KanbanCard,
    actor: KanbanActor,
    at: string,
  ) {
    if (next.priority !== KANBAN_BACKLOG || card.activeThreadId === null) return next;
    yield* letGo(card, false, "was moved to the backlog", { until: "when it leaves the backlog" });
    const paused: KanbanCard = {
      ...release(
        yield* moveWait(
          next,
          card.stage === "working"
            ? "todo"
            : card.stage === "in_review"
              ? "needs_review"
              : card.stage,
          at,
          actor,
        ),
      ),
      stage:
        card.stage === "working"
          ? "todo"
          : card.stage === "in_review"
            ? "needs_review"
            : card.stage,
      movedAt: at,
    };
    yield* logEvent(paused, actor, "moved", {
      fromStage: card.stage,
      toStage: paused.stage,
      body: "Paused in the backlog",
    });
    return paused;
  });

  const editCard = (
    cardId: KanbanCard["id"],
    inputPatch: CardPatch,
    actor: KanbanActor,
    instructionApplication?: InstructionApplication,
  ): ReturnType<KanbanServiceShape["editCard"]> => {
    let lockedWork: ThreadId | null = null;
    let releaseModel: Effect.Effect<void> = Effect.void;
    let confirmingModel = false;
    const editing = savedCardGuard(
      "card.update",
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const { promptEdits, subtaskEdits, basedOn, ...fields } = inputPatch;
        let patch: CardPatch = fields;
        if (promptEdits !== undefined) {
          if (patch.prompt !== undefined)
            return yield* failWith("invalid", "pass prompt or promptEdits, not both");
          const prompt = (yield* applyExactEdits([card.prompt], promptEdits))[0]!;
          yield* checkText([["prompt", prompt]]);
          if (!prompt.trim()) return yield* failWith("invalid", "a card needs a prompt");
          if (prompt !== card.prompt && prompt.trim() !== card.prompt) patch = { ...patch, prompt };
        }
        if (subtaskEdits !== undefined) {
          if (patch.subtasks !== undefined)
            return yield* failWith("invalid", "pass subtasks or subtaskEdits, not both");
          const open = card.subtasks.filter((subtask) => subtask.state === "open");
          const texts = yield* applyExactEdits(
            open.map((subtask) => subtask.text),
            subtaskEdits,
          );
          yield* checkText(texts.map((text) => ["subtask text", text] as const));
          const changed = new Map(
            open.flatMap((subtask, index) =>
              texts[index]!.trim() === subtask.text ? [] : [[subtask.id, texts[index]!] as const],
            ),
          );
          if (changed.size > 0)
            patch = {
              ...patch,
              subtasks: card.subtasks.map((subtask) => ({
                id: subtask.id,
                ...(changed.has(subtask.id)
                  ? { text: changed.get(subtask.id)!, script: subtask.script }
                  : {}),
              })),
            };
        }
        yield* checkText(cardTextFields(patch));
        const currentWork =
          (card.activeRole === "work" ? card.activeThreadId : null) ?? card.workThreadId;
        if ((patch.model || patch.models) && currentWork !== lockedWork) {
          return yield* failWith(
            "conflict",
            "Card work thread changed before the model edit; re-read and retry.",
          );
        }
        // Instruction audits deduplicate by receipt: two real applications can
        // have identical comments, even from the same evaluator.
        const protectedFields = (["prompt", "subtasks"] as const).filter(
          (field) => patch[field] !== undefined,
        );
        if (
          (promptEdits !== undefined || subtaskEdits !== undefined) &&
          Object.values(patch).every((value) => value === undefined)
        )
          return card;
        const checkBase = basedOn !== undefined && protectedFields.length > 0;
        const baseMs = basedOn === undefined ? NaN : Date.parse(basedOn);
        if (
          checkBase &&
          (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            basedOn!,
          ) ||
            !Number.isFinite(baseMs) ||
            DateTime.formatIso(DateTime.makeUnsafe(`${basedOn!.slice(0, 10)}T00:00:00.000Z`)).slice(
              0,
              10,
            ) !== basedOn!.slice(0, 10))
        )
          return yield* failWith(
            "invalid",
            "basedOn must be the ISO updatedAt from the card you read",
          );
        if (checkBase && baseMs > Date.parse(card.updatedAt))
          return yield* failWith(
            "invalid",
            "basedOn cannot be newer than the card's current updatedAt; read it again with card_get",
          );
        const events =
          checkBase ||
          (instructionApplication === undefined && isRetryActor(actor) && patch.comment?.trim())
            ? yield* store.cardEvents(card.id)
            : [];
        if (
          instructionApplication === undefined &&
          editRepeats(card, patch, events, actor, yield* Clock.currentTimeMillis)
        )
          return card;
        if (checkBase) {
          const conflict = events.find(
            (event) =>
              (event.kind === "edited" || event.kind === "linked") &&
              Date.parse(event.at) > baseMs &&
              actorKey(event.actor) !== actorKey(actor) &&
              event.body
                ?.split(",")
                .some((field) =>
                  protectedFields.some((protectedField) => field.trim() === protectedField),
                ),
          );
          if (conflict) {
            const changed = conflict
              .body!.split(",")
              .map((field) => field.trim())
              .filter((field) =>
                protectedFields.some((protectedField) => field === protectedField),
              );
            const by = conflict.actor;
            const who =
              by._tag === "evaluator" || by._tag === "thread"
                ? `${by._tag} thread ${by.threadId}`
                : by._tag === "system"
                  ? `system ${by.component}`
                  : by._tag === "script"
                    ? `script ${by.scriptId}`
                    : "owner";
            return yield* failWith(
              "conflict",
              `card #${card.number}'s ${changed.join(" and ")} was changed at ${conflict.at} by ${who}, after the ${basedOn} version you based this edit on. Read it again with card_get, merge your change into the current prompt/subtasks, and retry with basedOn set to its updatedAt.`,
            );
          }
        }
        // updatedAt is the edit base: distinguish writes in the same clock millisecond.
        const at = DateTime.formatIso(
          DateTime.makeUnsafe(
            Math.max(
              yield* Clock.currentTimeMillis,
              Date.parse(card.updatedAt) + (protectedFields.length > 0 ? 1 : 0),
            ),
          ),
        );
        const pools = yield* store.pools(card.boardId);
        const models = patch.models ? yield* cardModels(card.boardId, patch.models) : null;
        const model = models
          ? // A card with a work thread stays on its pool while the list still has it; the list's
            // entry carries the pool's variant, so a variant change sticks.
            ((card.workThreadId !== null
              ? models.find(
                  (entry) => Rules.poolOf(pools, entry.model) === Rules.poolOf(pools, card.model),
                )?.model
              : undefined) ??
            models[0]?.model ??
            card.model)
          : patch.model
            ? yield* poolModel(card.boardId, patch.model)
            : card.model;
        if (
          patch.subtasks?.some((input) => input.clearGate !== undefined) &&
          actor._tag !== "evaluator" &&
          actor._tag !== "owner"
        ) {
          return yield* failWith(
            "denied",
            "only the board evaluator can clear a guessed gate",
            "role_not_allowed",
          );
        }
        const board = yield* boardOf(card.boardId);
        if (
          actor._tag !== "evaluator" &&
          patch.subtasks?.some(
            (entry) =>
              entry.ownerOnly !== undefined ||
              entry.interrupting !== undefined ||
              entry.service !== undefined,
          )
        )
          return yield* failWith(
            "denied",
            "only evaluators may set or clear ownerOnly, interrupting or service",
            "role_not_allowed",
          );
        const plan = patch.subtasks
          ? Subtasks.planSubtasks(
              card.subtasks,
              patch.subtasks,
              card.subtaskSeq,
              at,
              board.guessedGates,
              actor,
            )
          : null;
        if (plan && !plan.ok)
          return yield* failWith(
            plan.code ?? "invalid",
            plan.reason,
            plan.denyReason,
            kanbanReasonClass(plan.code ?? "invalid", plan.denyReason),
            "subtasks",
          );
        if (plan?.ok) {
          for (const subtask of card.subtasks) {
            if (subtask.state !== "open") continue;
            const replacement = plan.subtasks.find((entry) => entry.id === subtask.id);
            if (replacement?.gateCleared && replacement.gateCleared !== subtask.gateCleared)
              continue;
            if (replacement && Subtasks.gateOf(replacement, board.guessedGates) !== undefined)
              continue;
            const missing = Subtasks.approvalProblem(
              card,
              subtask,
              board.standingApprovals,
              board.guessedGates,
              "skip",
            );
            if (actor._tag !== "owner" && missing)
              return yield* failWith("denied", missing, "approval_required");
          }
          yield* checkScriptNames(card.boardId, plan.subtasks);
        }
        const removeUrls = (patch.removeLinks ?? []).map((url) => url.trim());
        for (const url of removeUrls) {
          if (!card.links.some((link) => link.url === url))
            return yield* failWith("invalid", `card #${card.number} has no link ${url}`);
        }
        const keptLinks = card.links.filter((link) => !removeUrls.includes(link.url));
        const links = patch.links ? mergeLinks(keptLinks, patch.links) : keptLinks;
        let next: KanbanCard = {
          ...card,
          title: patch.title?.trim() || card.title,
          description: patch.description?.trim() ?? card.description,
          prompt: patch.prompt?.trim() || card.prompt,
          subtasks: plan?.ok ? plan.subtasks : card.subtasks,
          subtaskSeq: plan?.ok ? plan.subtaskSeq : card.subtaskSeq,
          wakeNote: plan?.ok
            ? Subtasks.pendingWakeNote({ ...card, subtasks: plan.subtasks })
            : card.wakeNote,
          priority: clampPriority(patch.priority, card.priority),
          goalId: patch.goalId === undefined ? card.goalId : patch.goalId,
          projects: patch.projects ?? card.projects,
          model,
          models: models ? (models.length > 1 ? models : []) : patch.model ? [] : card.models,
          projectId: patch.projectId === undefined ? card.projectId : patch.projectId,
          links,
          blockedBy: patch.blockedBy ?? card.blockedBy,
          reviewChain: patch.reviewChain === undefined ? card.reviewChain : patch.reviewChain,
          updatedAt: at,
        };
        if (
          patch.model &&
          !modelSelectionsEqual(yield* poolModel(card.boardId, patch.model), next.model)
        ) {
          return yield* failWith(
            "invalid",
            `Asked for ${Rules.poolKey(patch.model)}; card keeps ${Rules.poolKey(next.model)} because its models list selects a different work model.`,
          );
        }
        const workThread =
          (next.activeRole === "work" ? next.activeThreadId : null) ?? next.workThreadId;
        if ((patch.model || patch.models) && workThread !== null) {
          confirmingModel = true;
          const reason = yield* ensureWorkModel(workThread, next.model, card.id, true);
          if (reason !== null) {
            return yield* failWith(
              "invalid",
              `Asked for ${Rules.poolKey(next.model)}; card keeps ${Rules.poolKey(card.model)}. ${reason}`,
            );
          }
        }
        if (plan?.ok) {
          for (const subtask of plan.subtasks) {
            const cleared = subtask.gateCleared;
            const previous = card.subtasks.find((entry) => entry.id === subtask.id);
            const previousClear = previous?.gateCleared;
            if (
              !cleared ||
              (previousClear &&
                cleared.gate === previousClear.gate &&
                cleared.at === previousClear.at &&
                actorKey(cleared.by) === actorKey(previousClear.by))
            )
              continue;
            yield* logEvent(next, actor, "comment", {
              body: `Cleared guessed ${cleared.gate} gate on ${subtask.id} ("${cleared.text}"): ${cleared.reason}`,
            });
            if (actor._tag === "owner") continue;
            const text =
              `An evaluator cleared the ${cleared.gate} gate the board guessed on ${subtask.id}: "${cleared.text}". Reason: ${cleared.reason}.` +
              (previous?.gateSource === undefined ? " (origin not recorded: an older gate)" : "");
            const title = `Gate cleared on #${card.number} ${subtask.id}`;
            next = Asks.closeAsks(
              next,
              at,
              (ask) =>
                ask.kind === "notice" &&
                ask.batchKey === "gate-cleared" &&
                ask.title === title &&
                ask.answer === undefined,
            );
            const askId = Asks.nextAskId(next);
            next = Asks.updateAsk(Asks.addAsk(next, text, false, actor, at), askId, {
              kind: "notice",
              respond: { ack: true },
              title,
              batchKey: "gate-cleared",
            });
          }
        }
        const changed = Object.entries(patch)
          .filter(([key, value]) => key !== "comment" && value !== undefined)
          .map(([key]) => key);
        if (changed.length > 0)
          yield* logEvent(next, actor, patch.links || patch.removeLinks ? "linked" : "edited", {
            at,
            body: changed.join(", "),
          });
        if (patch.comment?.trim())
          yield* logEvent(next, actor, "comment", {
            body: patch.comment.trim(),
            ...(instructionApplication === undefined ? {} : { instructionApplication }),
          });
        if (plan?.ok) next = yield* recheckReviewGate(next, board, true);
        const paused = yield* pauseIfBacklog(card, next, actor, at);
        // An open work thread now runs the new model's pool, so the card's slot moves with it.
        const saved =
          paused.activeThreadId !== null &&
          paused.activeRole === "work" &&
          paused.activePool !== Rules.poolOf(pools, paused.model)
            ? { ...paused, activePool: Rules.poolOf(pools, paused.model) }
            : paused;
        // Once one card is saved, finish its shared model and hold updates before
        // cancellation can run cleanup against a partially updated thread.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* saveCard(saved, undefined, false, false);
            if (
              workThread !== null &&
              !modelSelectionsEqual(card.model, saved.model) &&
              sameCardState(yield* cardOf(saved.id), saved)
            ) {
              // The thread now runs the new model's pool; its slot follows, so the pool
              // counts and the one-slot limit stay right. Cards sharing the thread take the
              // same model, so a steer or wake to any of them keeps the thread on it.
              const newPool = Rules.poolOf(pools, saved.model);
              for (const other of yield* store.cardsByThread(workThread)) {
                if (other.id === saved.id) continue;
                yield* saveCard(
                  { ...other, model: saved.model, activePool: newPool },
                  undefined,
                  false,
                  false,
                );
              }
              const held = (yield* Ref.get(holds)).get(workThread);
              if (held !== undefined && held.boardId === saved.boardId && held.pool !== newPool) {
                yield* Ref.update(holds, (all) =>
                  new Map(all).set(workThread, { ...held, pool: newPool }),
                );
              }
            }
            yield* releaseModel;
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                for (const threadId of new Set([
                  card.activeThreadId,
                  saved.activeThreadId,
                  workThread,
                ])) {
                  if (threadId !== null)
                    yield* syncSlot(
                      saved.boardId,
                      threadId,
                      !modelSelectionsEqual(card.model, saved.model) ||
                        (card.activePool !== saved.activePool && saved.activePool !== null)
                        ? "pool_moved"
                        : "card_left",
                      saved.id,
                    );
                }
              }),
            ),
          ),
        );
        yield* laterEvaluatorTurn(card, saved, actor);
        if (patch.prompt?.trim() && patch.prompt.trim() !== card.prompt && !patch.title) {
          yield* forkWriter(card.id, { title: true, description: !patch.description });
        }
        if (
          plan?.ok &&
          saved.activeThreadId !== null &&
          (saved.activeRole !== "work" || kanbanWorkStep(saved)) &&
          sameCardState(yield* cardOf(saved.id), saved)
        ) {
          // A notification can start an idle worker, so evaluator/script steps
          // wait for eligible work; its next brief contains the current plan.
          const threadId = saved.activeThreadId;
          const text = Briefs.planChangedText(saved);
          yield* later(
            saved.boardId,
            cardLane(saved),
            { kind: "send", threadId, text, bestEffort: true, planCardId: saved.id },
            sendPlanChanged(saved.id, threadId).pipe(Effect.ignore),
          );
        }
        yield* kick;
        return saved;
      }),
      Object.keys(inputPatch).every((key) =>
        [
          "title",
          "description",
          "comment",
          "links",
          "removeLinks",
          "prompt",
          "promptEdits",
          "projects",
        ].includes(key),
      )
        ? cardId
        : undefined,
    );
    if (!inputPatch.model && !inputPatch.models) return editing;
    // Keep the model lock through confirmation, commit and any restoration. A newer
    // edit must not switch its thread before an older edit has finished restoring it.
    return Effect.gen(function* () {
      const card = yield* read(rawStore.card(cardId));
      lockedWork =
        (card?.activeRole === "work" ? card.activeThreadId : null) ?? card?.workThreadId ?? null;
      if (lockedWork === null) return yield* editing;
      const threadId = lockedWork;
      const lock = threadModelLock(threadId);
      return yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          yield* lock.take(1);
          let held = true;
          releaseModel = Effect.suspend(() => {
            if (!held) return Effect.void;
            held = false;
            return Effect.asVoid(lock.release(1));
          });
          return Effect.uninterruptible(
            Effect.suspend(() =>
              held && confirmingModel
                ? restoreWorkModel(threadId, cardId, true).pipe(Effect.ensuring(releaseModel))
                : releaseModel,
            ),
          );
        }),
        () => editing,
        (finish) => finish,
      );
    });
  };

  const moveCard: KanbanServiceShape["moveCard"] = (cardId, to, role, actor, options) =>
    savedCardGuard(
      "card.move",
      Effect.gen(function* () {
        yield* checkText([
          ["note", options?.note],
          ["question", options?.question],
        ]);
        const location = yield* locks.outside(
          rawStore.card(cardId).pipe(Effect.withSpan("card.move.read.location")),
          undefined,
          true,
        );
        if (!location) return yield* failWith("not-found", `card ${cardId}`);
        yield* locks.access(location.boardId, Effect.void);
        // Every read finishes outside the gate; outside() checks the board
        // generation before any guard or write can use this snapshot.
        const snapshot = yield* locks.outside(
          Effect.gen(function* () {
            const card = yield* rawStore.card(cardId).pipe(Effect.withSpan("card.move.read.card"));
            if (!card) return yield* failWith("not-found", `card ${cardId}`);
            const board = yield* rawStore
              .board(card.boardId)
              .pipe(Effect.withSpan("card.move.read.board"));
            if (!board) return yield* failWith("not-found", `board ${card.boardId}`);
            const slots = new Map<string, ReadonlyArray<KanbanCard>>();
            if (card.activeThreadId !== null)
              slots.set(
                card.activeThreadId,
                yield* rawStore
                  .cardsByThread(card.activeThreadId)
                  .pipe(Effect.withSpan("card.move.read.slots")),
              );
            const waitTargets = new Map<string, KanbanCard & { readonly boardName?: string }>();
            if (card.wait?.card != null) {
              const target = yield* rawStore
                .card(KanbanCardId.make(card.wait.card))
                .pipe(Effect.withSpan("card.move.read.waitTarget"));
              if (target) {
                const boardName =
                  target.boardId === card.boardId
                    ? undefined
                    : ((yield* rawStore
                        .board(target.boardId)
                        .pipe(Effect.withSpan("card.move.read.waitBoard")))?.name ??
                      target.boardId);
                waitTargets.set(target.id, {
                  ...target,
                  ...(boardName === undefined ? {} : { boardName }),
                });
              }
            }
            return {
              before: card,
              board,
              slots,
              waitTargets,
              events: yield* rawStore
                .cardEvents(card.id)
                .pipe(Effect.withSpan("card.move.read.events")),
              workCards:
                card.workThreadId === null
                  ? []
                  : yield* rawStore
                      .threadCards(card.workThreadId)
                      .pipe(Effect.withSpan("card.move.read.workCards")),
              reviewLink:
                card.reviewThreadId === null
                  ? null
                  : yield* rawStore
                      .threadLink(card.reviewThreadId)
                      .pipe(Effect.withSpan("card.move.read.reviewLink")),
            } satisfies CardWriteSnapshot;
          }).pipe(Effect.withSpan("card.move.read.snapshot")),
          undefined,
          true,
        );
        const card = snapshot.before;
        // An idle handoff can commit before the worker's delayed card_move.
        // A new review request still needs its note and follows the normal path.
        if (
          role === "cardThread" &&
          actor._tag === "thread" &&
          actor.threadId === card.workThreadId &&
          card.activeThreadId === null &&
          card.stage === "needs_review" &&
          to === "needs_review" &&
          !options?.note?.trim() &&
          snapshot.events
            .findLast((event) => event.kind === "moved")
            ?.body?.startsWith("Auto-advanced: review_step;")
        )
          return card;
        if (
          role === "cardThread" &&
          actor._tag === "thread" &&
          card.settledAt === null &&
          (card.activeThreadId === actor.threadId || card.workThreadId === actor.threadId)
        ) {
          if (
            to === card.stage &&
            to !== "needs_review" &&
            (card.activeThreadId === actor.threadId || isUnattachedOwnThread(card, actor))
          )
            return card;
        }
        const ownReviewHandoff =
          role === "cardThread" &&
          isUnattachedOwnThread(card, actor, ["in_review", "completed", "needs_review"]);
        const answeredRunStall =
          to === "needs_review" &&
          role === "cardThread" &&
          actor._tag === "thread" &&
          card.workThreadId === actor.threadId &&
          // A queued review's system flag belongs to its reviewer, not the old worker.
          (card.stage === "todo" || card.stage === "working") &&
          (card.activeThreadId === null ||
            (card.activeThreadId === actor.threadId && card.activeRole === "work")) &&
          card.stalled?.by._tag === "system" &&
          card.stalled.by.component === "dispatcher" &&
          ["Stale queued runs on the thread", "Run went silent twice"].includes(
            card.stalled.reason,
          );
        const clearNote = `Cleared system stall: ${card.stalled?.reason}; the card's own work thread submitted it for review.`;
        if (role === "cardThread") {
          if (actor._tag !== "thread" || card.activeThreadId !== actor.threadId) {
            if (
              !ownReviewHandoff &&
              (!isUnattachedOwnThread(card, actor) || card.stage !== "todo")
            ) {
              yield* checkCardThread(card, actor, role, true);
            }
            if (to !== "needs_review") {
              if (ownReviewHandoff) yield* checkCardThread(card, actor, role, true);
              return yield* failWith(
                "denied",
                `card #${card.number} has no thread attached: you can only move it to needs_review; use card_ask for an owner question`,
                "review_handoff_only",
              );
            }
          }
          if (ownReviewHandoff && !options?.note?.trim()) {
            return yield* failWith(
              "invalid",
              "needs_review needs a note naming the new head",
              undefined,
              "missing_required",
              "note",
            );
          }
          if (ownReviewHandoff && card.stage === "needs_review") {
            yield* logEvent(card, actor, "comment", {
              body: options!.note!.trim(),
              before: snapshot.before,
            });
            yield* saveCard(card, actor, false, undefined, undefined, snapshot);
            return card;
          }
          if (to === "needs_owner" && !options?.question?.trim()) {
            return yield* failWith(
              "invalid",
              "needs_owner needs the question for the owner",
              undefined,
              "missing_required",
              "question",
            );
          }
          const work = kanbanStepSubtasks(card, "work");
          if (to === "needs_review" && work.length > 0) {
            return yield* failWith(
              "denied",
              `card #${card.number} still has ${Subtasks.subtaskIds(work)} to do: mark each done (or skipped, with why) with subtask_done first`,
              "work_subtasks_open",
            );
          }
        }
        if (to === "verified" && role !== "owner") {
          const board = snapshot.board;
          const open = card.subtasks.filter((subtask) => subtask.state === "open");
          const missing = card.subtasks
            .map((subtask) =>
              Subtasks.approvalProblem(
                card,
                subtask,
                board.standingApprovals,
                board.guessedGates,
                subtask.state === "skipped" ? "skip" : "do",
              ),
            )
            .find((problem) => problem !== null);
          if (open.length > 0) {
            const reason = `card #${card.number} still has ${Subtasks.subtaskIds(open)} open: mark each done or skipped first`;
            return yield* failWith(
              "denied",
              missing ? `${reason}; ${missing}` : reason,
              "subtasks_open",
            );
          }
          if (missing) return yield* failWith("denied", missing, "approval_required");
        }
        if ((to === "completed" || to === "deployed") && role !== "owner") {
          const board = snapshot.board;
          const blocked = Rules.reviewGate(card, Rules.chainFor(board, card)?.steps.length ?? 1);
          if (blocked !== null) return yield* failWith("denied", blocked, "review_incomplete");
          if (role === "evaluator" && card.workThreadId !== null) {
            const reviewed = snapshot.events.findLast((event) => event.kind === "review")?.head;
            if (reviewed) {
              const view = yield* threads.view(card.workThreadId);
              const changed = view?.prs.find(
                (pr) =>
                  pr.observedHead &&
                  card.links.some((link) => link.kind === "pr" && link.url === pr.url) &&
                  !pr.observedHead.toLowerCase().startsWith(reviewed.toLowerCase()) &&
                  !reviewed.toLowerCase().startsWith(pr.observedHead.toLowerCase()),
              );
              if (changed?.observedHead)
                return yield* failWith(
                  "denied",
                  `card #${card.number} was cleared at ${reviewed.slice(0, 7)} but its PR is now at ${changed.observedHead.slice(0, 7)}: send it back to needs_review`,
                  "review_head_changed",
                );
            }
          }
        }
        if (role === "evaluator" && to === "todo" && kanbanEvaluatorStep(card)) {
          return yield* failWith(
            "denied",
            `card #${card.number}'s step is yours (${Subtasks.subtaskIds(kanbanStepSubtasks(card))}): do it, or add work subtasks with card_edit, before sending it back to todo`,
            "evaluator_step_pending",
          );
        }
        let source = card;
        let moveOptions = options ?? {};
        if (ownReviewHandoff) {
          const reset = Rules.applyReviewResult(card, 1, "findings");
          source = {
            ...card,
            subtasks: card.subtasks.map((subtask) =>
              subtask.owner === "review"
                ? { ...subtask, state: "open" as const, note: null, doneBy: null, doneAt: null }
                : subtask,
            ),
            reviewStep: reset.reviewStep,
            reviewRound: reset.reviewRound,
            reviewFindingsPending: false,
            wakeNote: null,
            nudgedAt: null,
          };
          const reviewed = snapshot.events.findLast((event) => event.kind === "review")?.head;
          moveOptions = {
            ...moveOptions,
            note: `${options!.note!.trim()}\nThe earlier clear${reviewed ? ` at ${reviewed}` : ""} no longer counts; review restarted.`,
          };
        }
        if (answeredRunStall) {
          source = { ...source, stalled: null };
          yield* logEvent(source, actor, "flagged", { body: "Cleared", before: snapshot.before });
          yield* logEvent(source, actor, "comment", { body: clearNote, before: snapshot.before });
        }
        const moved = yield* moveUnlocked(source, to, role, actor, moveOptions, snapshot);
        const deferred = yield* effectSink;
        if (deferred === undefined || deferred.closed) {
          yield* forkPostCommit(
            Effect.gen(function* () {
              yield* evaluatorTurn(card, moved, actor);
              if (to === "needs_review") yield* syncPrs(moved);
            }),
          );
        } else {
          yield* laterEvaluatorTurn(card, moved, actor);
        }
        if (to === "needs_review") {
          // The PR read is thread state: a deferred write returns the card without it.
          if (deferred !== undefined && !deferred.closed && moved.workThreadId !== null)
            deferred.effects.push({
              boardId: moved.boardId,
              lane: cardLane(moved),
              effect: { kind: "syncPrs", cardId: moved.id },
            });
          return moved;
        }
        return moved;
      }),
    ).pipe(
      Effect.flatMap((moved) => {
        const ask = Asks.openBlockingAsk(moved);
        // The ask sequence belongs in the reply, but the move's permit must
        // already be released before its bounded follow-up takes another one.
        return to === "needs_owner" && ask !== undefined && ask.seq === null
          ? SavedWrite.bestEffort(
              guardDeferred(
                "card.move.postAsk",
                Effect.gen(function* () {
                  const current = yield* cardOf(moved.id);
                  const pending = current.asks.find((entry) => entry.id === ask.id);
                  if (
                    pending === undefined ||
                    pending.closedAt !== null ||
                    pending.seq !== null ||
                    kanbanAskRevision(pending) !== kanbanAskRevision(ask)
                  )
                    return current;
                  return yield* postAsk(current, pending, []);
                }),
              ),
              moved,
            )
          : Effect.succeed(moved);
      }),
    );

  const restoreCutoverCard: KanbanServiceShape["restoreCutoverCard"] = Effect.fn(
    "KanbanService.restoreCutoverCard",
  )(function* (input: RestoreCutoverCardInput) {
    const view = yield* read(threads.find(input.threadId));
    if (view === null || view.archived) {
      return yield* failWith(
        "not-found",
        `existing thread ${input.threadId} is missing or archived`,
      );
    }
    yield* guard(
      "card.restoreCutover",
      Effect.gen(function* () {
        // Take the card's board permit before acquiring its SQLite writer.
        yield* cardOf(input.cardId);
        yield* refusePendingStop(input.threadId);
        const restored = yield* Effect.uninterruptible(
          tickTransaction(
            Effect.gen(function* () {
              const card = (yield* upgradeFindings([yield* cardOf(input.cardId)]))[0]!;
              const board = yield* boardOf(card.boardId);
              const plan = planCutoverCardRestore({
                restore: input,
                board,
                card,
                // Validation rejects foreign links; keep their reads in this SQL snapshot
                // without requesting a second board's gate while holding the writer.
                link: yield* rawStore.threadLink(input.threadId),
                threadCards: yield* rawStore.threadCards(input.threadId),
                cards: yield* store.cards(board.id),
                pools: yield* store.pools(board.id),
                holds: yield* boardHolds(board.id),
                at: yield* nowIso,
              });
              if (!plan.ok) return yield* Effect.fail(plan.error);
              if (!plan.changed) return null;
              const restoredCard = { ...plan.card, analyticsStageEnteredAt: yield* nowIso };
              yield* store.putCard(restoredCard);
              yield* store.putThreadLink(plan.link);
              yield* logEvent(
                plan.card,
                { _tag: "system", component: "harness-cutover" },
                "thread",
                {
                  fromStage: card.stage,
                  toStage: plan.card.stage,
                  body: `Restored existing ${plan.link.role} thread after cutover`,
                },
              );
              return { before: card, after: restoredCard };
            }),
          ).pipe(
            Effect.tap((restored) =>
              restored?.after.activeThreadId != null
                ? syncSlot(
                    restored.after.boardId,
                    restored.after.activeThreadId,
                    "restore",
                    restored.after.id,
                  )
                : Effect.void,
            ),
          ),
        );
        if (restored !== null) {
          for (const event of BoardAnalytics.cardEvents(restored.before, restored.after, {
            _tag: "system",
            component: "harness-cutover",
          }))
            yield* recordAnalytics(event);
          yield* publish(restored.after.boardId, { _tag: "card", card: restored.after });
        }
      }),
      input.cardId,
    );
  });

  /** Posts an ask in the card's discussion (never routed: it's for the owner) and keeps its seq. */
  const postAsk = Effect.fn("KanbanService.postAsk")(function* (
    card: KanbanCard,
    ask: KanbanOwnerAsk,
    options: ReadonlyArray<string>,
    multi = false,
    /** The typed part of the ask (kind, context, options, draft...), stored with its seq. */
    fields: Asks.AskFields = {},
  ) {
    const discussion = yield* cardDiscussionUnlocked(card.id);
    // The ask's own blocks lead the message: the post path checks them and keeps the files,
    // and the card holds them trimmed (see `Asks.storedBlocks`).
    const rich = fields.blocks ?? [];
    const message = yield* postUnlocked(
      discussion.id,
      ask.by,
      [...rich, ...Asks.askBlocks({ ...ask, ...fields }, options, multi)],
      false,
      false,
      false,
      ask.id,
      kanbanAskRevision(ask),
    );
    const current = yield* cardOf(card.id);
    const existing = current.asks.find((entry) => entry.id === ask.id)!;
    const next = Asks.updateAsk(current, ask.id, {
      ...fields,
      timing: {
        ...existing.timing,
        kind: askKind({ ...existing, ...fields }),
      },
      ...Asks.storedBlocks(message.blocks, rich.length),
      seq: message.seq,
    });
    yield* saveCard(next);
    return next;
  });

  /** Keeps an ask's files before the card changes, so a file that can't be kept refuses the whole ask. */
  const adoptAskFiles = Effect.fn("KanbanService.adoptAskFiles")(function* (
    boardId: KanbanBoard["id"],
    fields: Asks.AskFields,
  ) {
    if (!fields.blocks?.some((block) => block._tag === "attachment")) return fields;
    const claim = yield* attachments.claim(boardId, fields.blocks.map(normalizeMessageBlock));
    return { ...fields, blocks: Asks.askOnly(claim.blocks) } satisfies Asks.AskFields;
  });

  const isUnattachedOwnThread = (
    card: KanbanCard,
    actor: KanbanActor,
    stages: ReadonlyArray<KanbanStage> = ["todo", "needs_owner"],
  ) =>
    actor._tag === "thread" &&
    card.activeThreadId === null &&
    card.workThreadId === actor.threadId &&
    card.settledAt === null &&
    stages.includes(card.stage);

  const checkCardThread = (
    card: KanbanCard,
    actor: KanbanActor,
    role: Rules.MoveRole,
    forMove = false,
  ) =>
    role === "cardThread" && (actor._tag !== "thread" || card.activeThreadId !== actor.threadId)
      ? failWith(
          "denied",
          forMove &&
            actor._tag === "thread" &&
            card.workThreadId === actor.threadId &&
            card.settledAt === null
            ? card.activeRole === "review" && card.activeThreadId !== null
              ? `card #${card.number} is being reviewed by another thread; a clear at an older head is refused at merge, so put the new head in a card_update comment and the reviewer or evaluator will pick it up`
              : card.activeThreadId === null && card.stage === "needs_review"
                ? `card #${card.number} is already queued for review with no thread attached; its reviewer will read the PR's current head. Put the new head in a card_update comment`
                : card.activeThreadId === null &&
                    (card.stage === "in_review" || card.stage === "completed")
                  ? `card #${card.number} is in review with no thread; its work thread may only send it back with card_move to needs_review and a note naming the new head`
                  : `card #${card.number} is not assigned to this thread`
            : `card #${card.number} is not assigned to this thread`,
          "not_card_owner",
        )
      : Effect.void;

  const askOwner: KanbanServiceShape["askOwner"] = (cardId, input, actor, role) =>
    guardDeferred(
      "card.ask",
      Effect.gen(function* () {
        yield* checkText([
          ["question", input.question],
          ...Asks.askTextFields(input),
          ...messageTextFields(input.blocks ?? []),
        ]);
        const card = yield* cardOf(cardId);
        if (!isUnattachedOwnThread(card, actor)) yield* checkCardThread(card, actor, role);
        const question = input.question.trim();
        if (!question)
          return yield* failWith(
            "invalid",
            "an ask needs the question",
            undefined,
            "missing_required",
            "question",
          );
        const written = Asks.askFields(input, { blocking: input.blocking, card });
        if (Asks.isAskProblem(written)) return yield* failAnswer(written);
        if (written.to === "evaluator" && actor._tag !== "thread") {
          return yield* failWith(
            "invalid",
            "only a card's thread asks the evaluator: ask the owner",
          );
        }
        const fields = yield* adoptAskFiles(card.boardId, written);
        if (card.settledAt !== null)
          return yield* failWith("denied", "card is settled", "card_settled");
        const at = yield* nowIso;
        let next: KanbanCard;
        if (!input.blocking) {
          next = { ...Asks.addAsk(card, question, false, actor, at), updatedAt: at };
          yield* logEvent(next, actor, "comment", { body: `Asked the owner: ${question}` });
          yield* saveCard(next);
        } else if (card.stage === "needs_owner") {
          // Already waiting on the owner: one more question to answer.
          next = { ...Asks.addAsk(card, question, true, actor, at), question, updatedAt: at };
          yield* logEvent(next, actor, "comment", { body: `Asked the owner: ${question}` });
          yield* saveCard(next);
        } else {
          next = yield* moveUnlocked(card, "needs_owner", role, actor, { question });
          yield* laterEvaluatorTurn(card, next, actor);
        }
        const ask = next.asks.at(-1);
        if (!ask) return next;
        const asked = yield* postAsk(next, ask, [], false, fields);
        if (fields.to !== "evaluator") return asked;
        // Asked to the evaluator: it starts out where a handed ask is.
        const handed = { ...Asks.markHanded(asked, ask.id, at), updatedAt: at };
        yield* saveCard(handed);
        const stored = handed.asks.find((entry) => entry.id === ask.id) ?? ask;
        const talk = yield* cardDiscussionUnlocked(card.id);
        const text = Asks.handText(handed, stored, false);
        yield* later(
          handed.boardId,
          talk.id,
          {
            kind: "toEvaluator",
            discussionId: talk.id,
            text,
            note: false,
            evaluatorTrigger: "card_ask",
          },
          toEvaluator(talk, text),
        );
        return handed;
      }),
    );

  const changeAsk: KanbanServiceShape["changeAsk"] = (cardId, askId, action, actor, role) =>
    savedCardGuard(
      "ask.change",
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        if (!isUnattachedOwnThread(card, actor)) yield* checkCardThread(card, actor, role);
        const ask = Asks.findOpenAsk(card, askId);
        if (!ask)
          return yield* failWith(
            "not-found",
            `open ask ${askId} on card #${card.number}`,
            undefined,
            "bad_reference",
            "ask",
          );
        const at = yield* nowIso;
        if (action === "drop") {
          const discussion = yield* cardDiscussionUnlocked(card.id);
          const fresh = yield* cardOf(card.id);
          // Logged first: answerAsks saves the card, which tells the clients to re-read.
          yield* logEvent(fresh, actor, "comment", { body: `Dropped ${ask.id}: ${ask.text}` });
          const result = yield* answerAsks(
            discussion,
            fresh,
            Asks.droppedText(
              fresh,
              ask,
              actor._tag === "owner",
              (yield* boardOf(fresh.boardId)).guessedGates,
            ),
            (open) => open.id === ask.id,
            actor,
            true,
          );
          return result.card;
        }
        if (ask.blocking) return yield* failWith("invalid", `${ask.id} already blocks the card`);
        const blocking = Asks.updateAsk(card, ask.id, { blocking: true });
        if (card.stage === "needs_owner") {
          const question = Asks.openBlockingAsk(blocking)?.text ?? ask.text;
          const next = { ...blocking, question, updatedAt: at };
          yield* logEvent(next, actor, "comment", { body: `Made ${ask.id} blocking` });
          yield* saveCard(next);
          return next;
        }
        const next = yield* moveUnlocked(blocking, "needs_owner", role, actor, {
          question: ask.text,
          note: `Made ${ask.id} blocking`,
        });
        yield* laterEvaluatorTurn(card, next, actor);
        return next;
      }),
      undefined,
      (saved) => {
        if (saved.id !== cardId) return false;
        const ask = saved.asks.find((entry) => entry.id === askId);
        return (
          ask !== undefined &&
          (action === "drop"
            ? ask.closedAt !== null
            : ask.closedAt === null && ask.blocking && saved.stage === "needs_owner")
        );
      },
    );

  const openAskOf = (card: KanbanCard, askId: string) => {
    const ask = Asks.findOpenAsk(card, askId);
    return ask
      ? Effect.succeed(ask)
      : failWith(
          "not-found",
          `open ask ${askId} on card #${card.number}`,
          undefined,
          "bad_reference",
          "ask",
        );
  };

  const editAsk: KanbanServiceShape["editAsk"] = (cardId, askId, edit, actor, role) =>
    guard(
      "ask.edit",
      Effect.gen(function* () {
        yield* checkText([
          ["question", edit.question],
          ["revisionNote", edit.revisionNote],
          ...Asks.askTextFields(edit),
          ...messageTextFields(edit.blocks ?? []),
        ]);
        const card = yield* cardOf(cardId);
        if (!isUnattachedOwnThread(card, actor)) yield* checkCardThread(card, actor, role);
        const ask = yield* openAskOf(card, askId);
        const at = yield* nowIso;
        const written = Asks.reviseAsk(ask, edit, at, card);
        if (Asks.isAskProblem(written)) return yield* failAnswer(written);
        const { blocks: _blocks, ...revised } = written;
        // New blocks replace the old ones; otherwise the last version's come along whole.
        const kept = ask.blocks?.length ?? 0;
        const rich: ReadonlyArray<KanbanBlock> =
          edit.blocks !== undefined
            ? ((yield* adoptAskFiles(card.boardId, { blocks: written.blocks ?? [] })).blocks ?? [])
            : kept > 0 && ask.seq !== null && card.discussionId !== null
              ? ((yield* store.message(card.discussionId, ask.seq))?.blocks.slice(0, kept) ?? [])
              : [];
        // The new version is a message on the ask, and the one a pick answers from now on.
        const discussion = yield* cardDiscussionUnlocked(card.id);
        const message = yield* postUnlocked(
          discussion.id,
          actor,
          [...rich, { _tag: "md", text: Asks.revisedLine(revised) }, ...Asks.askBlocks(revised)],
          false,
          false,
          false,
          ask.id,
          kanbanAskRevision(revised),
        );
        const edited = Asks.replaceAsk(yield* cardOf(card.id), {
          ...revised,
          timing: { ...revised.timing, kind: askKind(revised) },
          ...Asks.storedBlocks(message.blocks, rich.length),
          seq: message.seq,
          ...(ask.firstSeq === undefined && ask.seq !== null ? { firstSeq: ask.seq } : {}),
        });
        const next: KanbanCard = {
          ...edited,
          question:
            edited.stage === "needs_owner"
              ? (Asks.openBlockingAsk(edited)?.text ?? edited.question)
              : edited.question,
          updatedAt: at,
        };
        yield* logEvent(next, actor, "comment", { body: Asks.revisedLine(revised) });
        yield* saveCard(next);
        return next;
      }),
    );

  const askSecretPlan: KanbanServiceShape["askSecretPlan"] = (cardId, askId, fieldIds) =>
    readDb(
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const ask = card.asks.find((entry) => entry.id === askId);
        if (!ask)
          return yield* failWith(
            "not-found",
            `ask ${askId} on card #${card.number}`,
            undefined,
            "bad_reference",
            "ask",
          );
        const plan = Asks.secretPlan(card, ask, fieldIds);
        if (Asks.isAskProblem(plan))
          return yield* failWith(
            plan.code,
            plan.detail,
            "approval_required",
            plan.reasonClass,
            plan.invalidField,
          );
        const projectId = card.projectId ?? (yield* boardOf(card.boardId)).defaultProjectId;
        return { ...plan, projectId };
      }),
    );

  /**
   * A handed ask is with the evaluators of its card's board: the threads that
   * board started as evaluators. Another board's evaluator is not one, and
   * neither is a thread no board started (an outside thread, or a card
   * thread's subagent, which has no link of its own).
   */
  const checkHandedTo = Effect.fn("KanbanService.checkHandedTo")(function* (
    card: KanbanCard,
    ask: KanbanOwnerAsk,
    actor: KanbanActor,
  ) {
    const link = actor._tag === "evaluator" ? yield* store.threadLink(actor.threadId) : null;
    if (link === null || link.role !== "evaluator" || link.boardId !== card.boardId) {
      return yield* failWith(
        "denied",
        `${ask.id} on card #${card.number} is with the evaluators of its own board: this thread is not one of them`,
        "evaluator_board_mismatch",
      );
    }
  });

  const answerAsk: KanbanServiceShape["answerAsk"] = (cardId, askId, input, actor, secrets) =>
    guardDeferred("ask.answer", answerAskUnlocked(cardId, askId, input, actor, secrets));
  /** The one place an ask is answered: by the answer route, a tool, or a pick on its message. */
  const answerAskUnlocked = (
    ...[cardId, askId, input, actor, secrets]: Parameters<KanbanServiceShape["answerAsk"]>
  ): ReturnType<KanbanServiceShape["answerAsk"]> =>
    // Suspended only to keep the body where it was: it is `answerAsk` as before.
    Effect.suspend(() =>
      Effect.gen(function* () {
        yield* checkText(Asks.answerTextFields(input));
        const card = yield* cardOf(cardId);
        const ask = card.asks.find((entry) => entry.id === askId);
        if (!ask)
          return yield* failWith(
            "not-found",
            `ask ${askId} on card #${card.number}`,
            undefined,
            "bad_reference",
            "ask",
          );
        const byOwner = actor._tag === "owner";
        if (
          byOwner &&
          input.verdict === "answered" &&
          input.text?.trim() &&
          Asks.pickOptions(ask).length > 0 &&
          Object.keys(secrets ?? {}).length === 0
        ) {
          // Check the revision and expiry before classifying words against today's options.
          const checked = Asks.answerFor(
            card,
            ask,
            { ...input, verdict: "text" },
            actor,
            yield* nowIso,
          );
          if (Asks.isAskProblem(checked)) return yield* failAnswer(checked);
          return yield* recordOwnerReply(card, ask, input.text, {
            at: yield* nowIso,
            seq: 1,
            revision: input.revision,
            input,
          });
        }
        if (!byOwner && ask.handedAt === undefined) {
          return yield* failWith(
            "denied",
            `${ask.id} on card #${card.number} was not handed to the evaluator: only the owner answers it`,
            "ask_not_handed",
          );
        }
        if (!byOwner) yield* checkHandedTo(card, ask, actor);
        const checked = Asks.answerFor(
          card,
          ask,
          input,
          actor,
          yield* nowIso,
          new Set(Object.keys(secrets ?? {})),
        );
        if (Asks.isAskProblem(checked)) return yield* failAnswer(checked);
        // The files he gave are kept before the card changes: one that can't be refuses the answer.
        let answer = checked;
        const originalAt = yield* ownerAnswerAt;
        if (originalAt !== undefined)
          answer = { ...answer, at: originalAt as KanbanAskAnswer["at"] };
        const given = Asks.answerFiles(ask, checked);
        if (given.length > 0) {
          const claim = yield* attachments.claim(
            card.boardId,
            given.flatMap((entry) =>
              entry.files.map((attachment) => ({ _tag: "attachment" as const, attachment })),
            ),
          );
          const kept = claim.blocks.flatMap((block) =>
            block._tag === "attachment" ? [block.attachment] : [],
          );
          let from = 0;
          const values: Record<string, unknown> = { ...checked.values };
          for (const entry of given) {
            values[entry.fieldId] = kept.slice(from, from + entry.files.length);
            from += entry.files.length;
          }
          answer = { ...checked, values: values as NonNullable<KanbanAskAnswer["values"]> };
        }
        const discussion = yield* cardDiscussionUnlocked(card.id);
        // Both the ask and its current confirmation show the same recorded decision.
        const answerSeqs = new Set([
          ask.seq,
          ask.confirmation?.revision === kanbanAskRevision(ask) ? ask.confirmation.seq : null,
        ]);
        for (const seq of answerSeqs) {
          if (seq === null || seq === undefined) continue;
          const asked = yield* store.message(discussion.id, seq);
          const block = asked?.blocks.find(
            (entry): entry is Extract<KanbanBlock, { _tag: "choice" }> =>
              entry._tag === "choice" && entry.id === ask.id,
          );
          if (!asked || !block) continue;
          let display = Asks.blockAnswer(ask, answer);
          if (display.choice.some((id) => !block.options.some((option) => option.id === id))) {
            // The form can choose outside the confirmation's candidates; keep that decision visible.
            const labels = Asks.pickOptions(ask)
              .filter((option) => display.choice.includes(option.id))
              .map((option) => option.label)
              .join(", ");
            display = { ...display, text: [labels, display.text].filter(Boolean).join("\n\n") };
          }
          const key = actorKey(actor);
          const shown: KanbanMessage = {
            ...asked,
            answers: [
              ...asked.answers.filter(
                (entry) => !(entry.blockId === ask.id && actorKey(entry.by) === key),
              ),
              { blockId: ask.id, by: actor, ...display, at: answer.at },
            ],
          };
          yield* store.putMessage(shown);
          yield* publish(discussion.boardId, { _tag: "message", message: shown });
        }
        const fresh = yield* cardOf(card.id);
        const moved = `${byOwner ? "Owner" : "Evaluator, for the owner,"} ${answer.decision ?? answer.verdict} ${ask.id}`;
        // Logged first: answerAsks saves the card, which tells the clients to re-read.
        yield* logEvent(fresh, actor, "comment", { body: moved });
        const result = yield* answerAsks(
          discussion,
          fresh,
          Asks.answerText(fresh, ask, answer, attachments.pathOf, secrets),
          (open) => open.id === ask.id,
          actor,
          false,
          { answer, moved },
        );
        const self = byOwner ? null : (actor as { readonly threadId?: string }).threadId;
        // Deferred, the telling runs after this write: who will hear is read from the card
        // instead (a worker running the card, or an evaluator other than the answerer).
        const sink = yield* effectSink;
        const willHear =
          sink !== undefined &&
          !sink.closed &&
          ((ask.by._tag === "thread" && ask.by.threadId === result.card.activeThreadId) ||
            (ask.by._tag === "evaluator" && ask.by.threadId !== self));
        return {
          card: result.card,
          heard:
            result.card.wakeNote !== fresh.wakeNote ||
            willHear ||
            [...result.told].some((threadId) => threadId !== self),
        };
      }),
    ).pipe(Effect.mapError(toKanbanError));

  const replyOnAsk: KanbanServiceShape["replyOnAsk"] = (
    cardId,
    askId,
    actor,
    blocks,
    role,
    revision,
  ) => guardDeferred("ask.reply", replyOnAskUnlocked(cardId, askId, actor, blocks, role, revision));
  /** A reply on an ask: from its route or tool, or his words typed on its pick block. */
  const replyOnAskUnlocked = (
    ...[cardId, askId, actor, blocks, role, revision]: Parameters<KanbanServiceShape["replyOnAsk"]>
  ) =>
    // Suspended only to keep the body where it was: it is `replyOnAsk` as before.
    Effect.suspend(() =>
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        if (!isUnattachedOwnThread(card, actor)) yield* checkCardThread(card, actor, role);
        const ask = yield* openAskOf(card, askId);
        // Read beside the ask, so held to the ask's sizes, whoever writes it.
        const tooBig = Asks.replyBlocksProblem(blocks);
        if (tooBig) return yield* failWith(tooBig.code, tooBig.detail, "invalid_args");
        const discussion = yield* cardDiscussionUnlocked(card.id);
        // Never routed as an owner reply: that would answer every open ask on the card.
        const message = yield* postUnlocked(
          discussion.id,
          actor,
          blocks,
          false,
          actor._tag !== "owner",
          false,
          ask.id,
        );
        const fresh = yield* cardOf(card.id);
        if (actor._tag !== "owner") {
          // The agent replied: it is the owner's turn again, and a snoozed ask comes back.
          const next = Asks.wakeFromSnooze(
            Asks.clearClarify(fresh, ask.id),
            ask.id,
            message.createdAt,
          );
          if (next !== fresh) yield* saveCard({ ...next, updatedAt: message.createdAt });
          return message;
        }
        const said = blocksText(message.blocks, attachments.pathOf);
        yield* recordOwnerReply(fresh, ask, said, {
          at: message.createdAt,
          seq: message.seq,
          revision,
        });
        return message;
      }),
    );

  const handAsk: KanbanServiceShape["handAsk"] = (cardId, askId, action, actor, always) =>
    guardDeferred(
      "ask.hand",
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const ask = yield* openAskOf(card, askId);
        const ref = `${ask.id} on card #${card.number}`;
        if ((action === "return") === (actor._tag === "owner")) {
          return yield* failWith(
            "denied",
            action === "return"
              ? "only an evaluator returns a handed ask"
              : "only the owner hands an ask over or takes it back",
            "role_not_allowed",
          );
        }
        const at = yield* nowIso;
        if (action === "return") yield* checkHandedTo(card, ask, actor);
        if (action !== "hand") {
          if (ask.handedAt === undefined) {
            return yield* failWith("invalid", `${ref} is not with the evaluator`);
          }
          const next = { ...Asks.clearHanded(card, ask.id), updatedAt: at };
          yield* logEvent(next, actor, "comment", {
            body:
              action === "return"
                ? `Evaluator returned ${ask.id} to the owner`
                : `Owner took ${ask.id} back`,
          });
          yield* saveCard(next);
          return next;
        }
        if (ask.handedAt !== undefined) {
          return yield* failWith("invalid", `${ref} is already with the evaluator`);
        }
        const unfit = Asks.handProblem(card, ask);
        if (unfit) return yield* failWith(unfit.code, unfit.detail, "invalid_args");
        const discussion = yield* cardDiscussionUnlocked(card.id);
        const next = {
          ...Asks.markHanded(yield* cardOf(card.id), ask.id, at, always === true),
          updatedAt: at,
        };
        yield* logEvent(next, actor, "comment", {
          body: `Owner handed ${ask.id} to the evaluator${always === true ? ", and asks like it from now on" : ""}`,
        });
        yield* saveCard(next);
        const text = Asks.handText(next, ask);
        yield* later(
          next.boardId,
          discussion.id,
          {
            kind: "toEvaluator",
            discussionId: discussion.id,
            text,
            note: false,
            evaluatorTrigger: "card_ask",
          },
          toEvaluator(discussion, text),
        );
        return next;
      }),
    );

  const snoozeAsk: KanbanServiceShape["snoozeAsk"] = (cardId, askId, until, actor) =>
    guard(
      "ask.snooze",
      Effect.gen(function* () {
        if (actor._tag !== "owner") {
          return yield* failWith("denied", "only the owner snoozes an ask", "role_not_allowed");
        }
        const card = yield* cardOf(cardId);
        const ask = card.asks.find((entry) => entry.id === askId);
        if (!ask)
          return yield* failWith(
            "not-found",
            `ask ${askId} on card #${card.number}`,
            undefined,
            "bad_reference",
            "ask",
          );
        const at = yield* nowIso;
        const snoozed = Asks.snoozeAsk(card, ask, until, at);
        if (Asks.isAskProblem(snoozed)) return yield* failAnswer(snoozed);
        const next = { ...snoozed, updatedAt: at };
        yield* saveCard(next);
        return next;
      }),
    );

  const noteHandEvaluator: KanbanServiceShape["noteHandEvaluator"] = (cardId, askId, threadId) =>
    guard(
      "ask.noteHandEvaluator",
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const next = Asks.markHandEvaluator(card, askId, threadId);
        if (next !== card) yield* saveCard(next);
        return next;
      }),
    );

  const askDetail: KanbanServiceShape["askDetail"] = (cardId, askId) =>
    readDb(
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const ask = card.asks.find((entry) => entry.id === askId);
        if (!ask)
          return yield* failWith(
            "not-found",
            `ask ${askId} on card #${card.number}`,
            undefined,
            "bad_reference",
            "ask",
          );
        const kept = ask.blocks?.length ?? 0;
        // The card holds big blocks as stubs; the ask's message holds them whole.
        const asked =
          kept > 0 && ask.seq !== null && card.discussionId !== null
            ? yield* store.message(card.discussionId, ask.seq)
            : null;
        return {
          boardId: card.boardId,
          cardId: card.id,
          cardNumber: card.number,
          discussionId: card.discussionId,
          ask: asked ? { ...ask, blocks: Asks.askOnly(asked.blocks.slice(0, kept)) } : ask,
        };
      }),
    );

  const askFeed: KanbanServiceShape["askFeed"] = (input) =>
    readDb(nowIso.pipe(Effect.flatMap((at) => AskFeed.readAskFeed(boardSql, input, at))));

  const noteAskTiming: KanbanServiceShape["noteAskTiming"] = (cardId, askId, receipt) =>
    guardDeferred(
      "ask.timing",
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const ask = card.asks.find((entry) => entry.id === askId);
        if (ask === undefined) return yield* failWith("not-found", "ask not found");
        const now = yield* nowIso;
        const observed = receipt.at ?? now;
        if (receipt.type === "seen" && Math.abs(Date.parse(observed) - Date.parse(now)) > 300_000)
          return yield* failWith(
            "invalid",
            "receipt time is outside the clock window",
            undefined,
            "bad_time",
            "at",
          );
        const at =
          receipt.type === "seen" && Number.isFinite(Date.parse(observed))
            ? DateTime.formatIso(
                DateTime.makeUnsafe(
                  Math.min(Date.parse(now), Math.max(Date.parse(ask.at), Date.parse(observed))),
                ),
              )
            : observed;
        if (!Number.isFinite(Date.parse(at)) || at < ask.at || at > now)
          return yield* failWith(
            "invalid",
            "receipt time is outside the ask lifetime",
            undefined,
            "bad_time",
            "at",
          );
        const updated = markAskTiming(
          ask,
          receipt.type,
          receipt.type === "seen" ? receipt.surface : receipt.channel,
          at,
        );
        if (updated === ask) return;
        yield* store.putCard(Asks.updateAsk(card, askId, { timing: updated.timing }));
        yield* recordAnalytics({
          kind: receipt.type === "seen" ? "ask.seen" : "ask.notified",
          surface: receipt.type === "seen" ? receipt.surface : "server",
          boardId: card.boardId,
          cardId,
          props: {
            ...askTimingProps(updated),
            ...(receipt.type === "seen" ? { originKind: receipt.surface } : {}),
          },
        });
      }),
      cardId,
    );

  const flagCard: KanbanServiceShape["flagCard"] = (cardId, reason, actor) => {
    const write = savedCardGuard(
      "card.flag",
      Effect.gen(function* () {
        yield* checkText([["reason", reason]]);
        const card = yield* cardOf(cardId);
        // A stop from the owner, an evaluator or another thread is theirs to lift
        // or reword; a thread replacing it with its own flag could then clear it.
        const by = card.stalled?.by;
        if (
          actor._tag === "thread" &&
          by !== undefined &&
          !(by._tag === "thread" && by.threadId === actor.threadId)
        ) {
          const hint =
            card.activeThreadId === actor.threadId
              ? "; move it to needs_owner if you can't go on"
              : "";
          return yield* failWith(
            "denied",
            `card #${card.number} was flagged by someone else; only they can change or clear it${hint}`,
            "flag_owner_mismatch",
          );
        }
        const at = yield* nowIso;
        const selfFlag =
          reason !== null && actor._tag === "thread" && card.activeThreadId === actor.threadId;
        if (selfFlag && card.activeRole === "review") yield* endReviewLink(card.reviewThreadId, at);
        if (reason !== null && card.activeThreadId !== null && !selfFlag) {
          yield* letGo(card, false, "is stalled", {
            until: "after the flag is cleared",
            respectPause: true,
          });
        }
        const flagged: KanbanCard = {
          ...(reason !== null && card.activeThreadId !== null && Rules.workerWaitDeferred(card)
            ? yield* moveWait(card, "todo", at, actor)
            : card),
          stalled: reason === null ? null : { reason, by: actor, at },
          updatedAt: at,
        };
        // A stalled card holds no slot, whoever flagged it.
        const next: KanbanCard =
          reason !== null && card.activeThreadId !== null ? releaseToQueue(flagged, at) : flagged;
        yield* logEvent(next, actor, "flagged", {
          fromStage: card.stage,
          toStage: next.stage,
          body: reason ?? "Cleared",
        });
        yield* saveCard(next);
        yield* kick;
        if (selfFlag && reason !== null) {
          const text = Briefs.workerFlaggedText(next, reason);
          yield* later(
            next.boardId,
            cardLane(next),
            {
              kind: "noteDiscussion",
              cardId: next.id,
              text,
              evaluatorTrigger: "stall_run_failure",
            },
            forkPostCommit(noteDiscussion(next, text)),
          );
        }
        return next;
      }),
    );
    return (
      actor._tag === "thread" && reason === null ? reconcileRunFailure(actor.threadId) : Effect.void
    ).pipe(Effect.andThen(write));
  };

  const activeWaitThreadRunning = Effect.fn("KanbanService.activeWaitThreadRunning")(function* (
    card: KanbanCard,
    io: typeof threadIo,
  ) {
    if (card.activeThreadId === null) return false;
    const queued = yield* io.queuedRuns(card.activeThreadId);
    const view = yield* io.view(card.activeThreadId);
    // A missing/failed read cannot prove the owner is idle. PR watches alone may park.
    return queued.length > 0 || view?.state !== "idle" || view.backgroundWork > 0;
  });

  const waitCard: KanbanServiceShape["waitCard"] = (cardId, input, actor) =>
    guard(
      "card.wait",
      Effect.gen(function* () {
        yield* checkText([["note", input?.note]]);
        const card = yield* cardOf(cardId);
        const at = yield* nowIso;
        if (input === null) {
          if (card.wait === undefined) {
            // Held for its evaluator after a wait ended: clearing lets it carry on now.
            if (card.deciding !== undefined) {
              const next: KanbanCard = { ...kanbanWithoutDeciding(card), updatedAt: at };
              yield* logEvent(next, actor, Waits.waitEventKind("wait_cleared"), {
                body: "No longer held for the evaluator: the card carries on",
              });
              yield* saveCard(next);
              yield* kick;
              return next;
            }
            return yield* failWith("invalid", `card #${card.number} has no wait to clear`);
          }
          const next: KanbanCard = {
            ...kanbanWithoutDeciding(kanbanWithoutWait(card)),
            updatedAt: at,
          };
          const dependency =
            card.wait.card === null ? null : yield* store.card(KanbanCardId.make(card.wait.card));
          const known =
            dependency === null
              ? undefined
              : new Map([
                  [dependency.id as string, yield* waitTargetFacts(dependency, card.boardId)],
                ]);
          yield* logEvent(next, actor, Waits.waitEventKind("wait_cleared"), {
            body: Waits.waitClearedBody(card.wait, known),
          });
          yield* saveCard(next);
          yield* kick;
          return next;
        }
        const onPr = input.on === "push" || input.on === "merge" || input.on === "ci";
        const link = onPr && input.pr?.trim() ? Waits.findPrLink(card, input.pr) : null;
        if (link === "ambiguous") {
          return yield* failWith(
            "invalid",
            `card #${card.number} has several pull requests matching ${input.pr}: pass its URL`,
          );
        }
        const target = input.on === "card" && input.card ? yield* store.card(input.card) : null;
        const targetBoard = target === null ? null : yield* store.board(target.boardId);
        if (target !== null && targetBoard === null) {
          return yield* failWith("invalid", `card #${target.number} is on a deleted board`);
        }
        if (target !== null && targetBoard !== null && targetBoard.archivedAt !== null) {
          return yield* failWith(
            "invalid",
            `card #${target.number} is on archived board ${targetBoard.name}`,
          );
        }
        // The reviewed commit is on the card already: its latest review event.
        const reviewed =
          input.on === "push" && !input.head?.trim()
            ? ((yield* store.cardEvents(card.id)).findLast(
                (event) => event.kind === "review" && event.head !== null,
              )?.head ?? null)
            : null;
        const request: Waits.WaitRequest = {
          on: input.on,
          note: input.note,
          // An unknown ref goes through as written, so the refusal names it.
          pr: onPr ? (link?.url ?? input.pr?.trim() ?? null) : null,
          card: target,
          ask: input.ask?.trim() || null,
          until: input.until?.trim() || null,
          sinceHead: input.head?.trim() || reviewed,
          wakeRole: input.wakeRole ?? null,
          script:
            input.on === "script"
              ? {
                  name: input.script?.trim() ?? "",
                  found: (yield* store.scripts(card.boardId)).filter(
                    (script) => script.name === input.script?.trim(),
                  ),
                }
              : null,
          args: input.args ?? null,
        };
        const check = Waits.checkWait(
          card,
          request,
          actor,
          yield* nowMillis,
          Waits.WAITS_ENGINE_WIRED,
          yield* activeWaitThreadRunning(card, threads),
        );
        if (!check.ok)
          return yield* failWith(check.code, check.reason, check.denyReason ?? "invalid_args");
        const wait = Waits.newWait(request, actor, at);
        // A new wait is a decision: a hold for the evaluator from the last one ends here.
        const next: KanbanCard = {
          ...kanbanWithoutDeciding(
            card.activeThreadId === null || check.deferredUntilTurnEnds
              ? card
              : releaseToQueue(card, at),
          ),
          wait,
          stalled: null,
          updatedAt: at,
        };
        const known =
          target === null
            ? undefined
            : new Map([[target.id as string, yield* waitTargetFacts(target, card.boardId)]]);
        // Cleanup may cancel queued wakes through turn admission, so finish it
        // before taking that non-reentrant lock. Logging/saving reuse this candidate.
        yield* prepareTransition(next);
        const park = Effect.gen(function* () {
          if (yield* activeWaitThreadRunning(card, threadIo)) {
            const live = Waits.checkWait(card, request, actor, yield* nowMillis);
            if (!live.ok)
              return yield* failWith(live.code, live.reason, live.denyReason ?? "invalid_args");
          }
          yield* logEvent(next, actor, Waits.waitEventKind("wait_set"), {
            fromStage: card.stage === next.stage ? null : card.stage,
            toStage: card.stage === next.stage ? null : next.stage,
            body:
              Waits.waitSetBody(wait, known) +
              (check.deferredUntilTurnEnds ? " (starts when your turn ends)" : "") +
              (card.stalled !== null ? ` (replaces the stalled flag: ${card.stalled.reason})` : ""),
          });
          yield* saveCard(next);
          if (check.deferredUntilTurnEnds && actor._tag === "thread")
            yield* recordAnalytics({
              kind: "wait_set",
              boardId: card.boardId,
              cardId: card.id,
              threadId: actor.threadId,
              callerRole: "work",
              props: {
                on: wait.on,
                ...(wait.until === null
                  ? {}
                  : { until: DateTime.formatIso(DateTime.makeUnsafe(wait.until)) }),
                ...(wait.script === null ? {} : { script: BoardAnalytics.label(wait.script) }),
              },
            });
        });
        // The board gate alone cannot order this write against new turns.
        yield* card.activeThreadId === null
          ? park
          : turnAdmission.withLock(card.activeThreadId, park);
        if (card.activeThreadId !== null) yield* kick;
        return next;
      }),
    );

  /**
   * Carries out what a check's answer means for a card: save it, log the
   * event, wake whoever is next. The tick's wait pass and answerWait share it.
   */
  const applyWaitStep = Effect.fn("KanbanService.applyWaitStep")(function* (
    step: Waits.WaitStep,
    actor: KanbanActor,
  ) {
    if (step._tag === "none") return;
    if (step._tag === "hold") {
      if (step.save !== null) yield* saveCard(step.save);
      return;
    }
    // The wait ended and the card is held for its evaluator (`deciding`): the hold is
    // part of this write. A queued note's drain marks the card told after delivery.
    // Inline callers mark it now because they may not be able to save after sending.
    const decides = step._tag === "end" && step.card.deciding !== undefined;
    const sink = yield* effectSink;
    const sentHere = sink === undefined || sink.closed;
    const card: KanbanCard =
      decides && sentHere && step.card.deciding !== undefined
        ? {
            ...step.card,
            deciding: { ...step.card.deciding, toldAt: step.card.deciding.since },
          }
        : step.card;
    yield* logEvent(card, actor, step.event.kind, {
      body: step.event.body,
      fromStage: step.event.fromStage,
      toStage: step.event.toStage,
    });
    yield* saveCard(card);
    if (step.wake.to === "evaluator") {
      // A thread follow-on like any other: saved and sent by its lane's drain
      // under a deferred write or local wait pass; inline callers send outside the gate.
      const text = step.wake.text;
      const discussion = yield* cardDiscussionUnlocked(step.card.id);
      // A card left in review with nobody on it is the evaluator's to decide. There the
      // text is an ask, not a note: the evaluator owes the card's discussion a reply.
      const note = !(step._tag === "end" && step.card.stage === "in_review");
      yield* later(
        step.card.boardId,
        discussion.id,
        {
          kind: "toEvaluator",
          discussionId: discussion.id,
          text,
          note,
          decides,
          evaluatorTrigger:
            step._tag === "end"
              ? "wait_ended"
              : step._tag === "expire"
                ? "wait_expired"
                : "wait_failing",
        },
        // A send that fails told nobody, so nothing is left to wait for and the hold
        // comes off.
        toEvaluator(discussion, text, note).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("kanban wait note failed", { cardId: step.card.id, cause }).pipe(
              Effect.andThen(
                decides
                  ? endDeciding(step.card.id, {
                      body: "The evaluator could not be told that the wait ended: the card carries on",
                    }).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          ),
        ),
      );
    }
    // Back in To-Do or Needs Review with its wake note: the dispatcher takes it from here.
    else if (step.wake.to !== "none") yield* kick;
  });

  const answerWaits: KanbanServiceShape["answerWaits"] = (
    boardId,
    answers,
    actor,
    wired = Waits.WAITS_ENGINE_WIRED,
  ) =>
    // Deferred: the notes to evaluators are saved with the write and sent by their lanes' drains.
    guardDeferred(
      "card.answerWaits",
      Effect.gen(function* () {
        if (!wired) {
          return yield* failWith(
            "conflict",
            "waits are not live on this board yet: nothing changed",
          );
        }
        if (answers.length === 0) return [];
        const board = yield* boardOf(boardId);
        // The board's cards, read once for the whole batch. This write holds the board,
        // so they stay current; a card this batch changes is replaced in the map.
        const all = yield* store.cards(boardId);
        const cards = new Map(all.map((entry) => [entry.id as string, entry]));
        const byNumber = new Map(all.map((entry) => [entry.number, entry.id as string]));
        const nowMs = yield* nowMillis;
        const at = yield* nowIso;
        const outcomes: Array<WaitAnswerOutcome> = [];
        // Notes to evaluators go last: where they are sent inline they leave the board's
        // gate, and a write that has left it cannot start over.
        const telling: Array<Exclude<Waits.WaitStep, { readonly _tag: "none" | "hold" }>> = [];
        for (const { card: ref, answer, script, expect } of answers) {
          const card = cards.get(typeof ref === "number" ? (byNumber.get(ref) ?? "") : ref);
          const refuse = (code: KanbanError["code"], detail: string) =>
            void outcomes.push({ ok: false, cardId: card?.id ?? null, code, detail });
          if (card === undefined) {
            refuse(
              "not-found",
              typeof ref === "number" ? `No card #${ref} on this board.` : "No such card.",
            );
            continue;
          }
          const n = `card #${card.number}`;
          if (card.wait === undefined) {
            refuse("conflict", `${n} is not waiting`);
            continue;
          }
          if (card.activeThreadId !== null) {
            refuse("conflict", `${n} has a running thread, so it isn't waiting`);
            continue;
          }
          if (!kanbanWaiting(card)) {
            refuse("conflict", `${n} was moved since its wait was set`);
            continue;
          }
          if (script === null) {
            if (answer.result !== "wake") {
              refuse("invalid", "only a wake can be pushed to a waiting card");
              continue;
            }
          } else if (card.wait.on !== "script" || card.wait.script !== script) {
            refuse(
              "denied",
              `${n} does not wait on the ${script} script: only the check a card waits on can answer for it (a wake line ends any wait)`,
            );
            continue;
          }
          // The wait may have been replaced while the check ran: the card is the one
          // this write holds.
          if (
            expect != null &&
            expect !== Waits.waitIdentity(card.wait) &&
            expect !== card.wait.at
          ) {
            refuse(
              "conflict",
              `${n} waits on something else now: this answer was for the wait it had before and is dropped`,
            );
            continue;
          }
          const problem = Text.textProblem([
            ["note", answer.result === "wake" ? answer.note : null],
          ]);
          if (problem !== null) {
            refuse("invalid", problem);
            continue;
          }
          const step = Waits.applyAnswer(
            card,
            answer,
            { nowMs, cards },
            { chainLength: Rules.chainFor(board, card)?.steps.length ?? 1 },
            at,
          );
          const done = (text: string) => void outcomes.push({ ok: true, cardId: card.id, text });
          // Still waiting with nothing new to show: nothing is written.
          if (step._tag === "none" || step._tag === "hold") {
            if (step._tag === "hold" && step.save !== null) {
              yield* applyWaitStep(step, actor);
              cards.set(card.id, step.save);
            }
            done(`${n} still waits.`);
            continue;
          }
          cards.set(card.id, step.card);
          if (step.wake.to === "evaluator") telling.push(step);
          else yield* applyWaitStep(step, actor);
          done(
            step._tag === "end"
              ? step.wake.to === "none"
                ? `Ended the wait on ${n}.`
                : `Ended the wait on ${n} and woke ${step.wake.to === "work" ? "its worker" : step.wake.to === "review" ? "its reviewer" : "the evaluator"}.`
              : step._tag === "failing"
                ? `${n} still waits; its check has failed ${card.wait.failures + 1} times in a row and the evaluator was told.`
                : `${n} still waits, past its limit; the evaluator was told.`,
          );
        }
        for (const step of telling) yield* applyWaitStep(step, actor);
        return outcomes;
      }),
      undefined,
      boardId,
    );

  const answerWait: KanbanServiceShape["answerWait"] = Effect.fn("KanbanService.answerWait")(
    function* (cardId, answer, from, actor, wired) {
      // Only to find the card's board: the batch reads the card again under its lock.
      const card = yield* cardOf(cardId).pipe(Effect.mapError(toKanbanError));
      const [outcome] = yield* answerWaits(
        card.boardId,
        [{ card: card.id, answer, script: from.script, expect: from.expect ?? null }],
        actor,
        wired,
      );
      if (outcome === undefined) return yield* failWith("conflict", "nothing changed");
      return outcome.ok
        ? outcome.text
        : yield* failWith(outcome.code, outcome.detail, "script_wait_owner_mismatch");
    },
  );

  const settleCard: KanbanServiceShape["settleCard"] = (cardId) =>
    guard(
      "card.settle",
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        if (card.stage !== "verified")
          return yield* failWith(
            "denied",
            "only verified cards can be settled",
            "card_not_verified",
          );
        const at = yield* nowIso;
        const next = { ...card, settledAt: at, updatedAt: at };
        yield* logEvent(next, { _tag: "owner" }, "edited", { body: "Settled" });
        yield* saveCard(next);
        if (card.discussionId !== null) {
          const discussion = yield* store.discussion(card.discussionId);
          if (
            discussion !== null &&
            discussion.settledAt === null &&
            discussion.pinnedAt === null
          ) {
            yield* saveDiscussion({ ...discussion, settledAt: at, snoozedUntil: null });
          }
        }
        return next;
      }),
    );

  // Board locks are independent; serialize release receipts so two boards cannot admit the same service together.
  const releaseTicks = yield* Semaphore.make(1);
  const markSubtask: KanbanServiceShape["markSubtask"] = Effect.fn("KanbanService.markSubtask")(
    function* (cardId, subtaskId, state, note, actor, role, releasedAt) {
      // Admission precedes board locks: completing a step can release them for thread I/O.
      const observed = yield* readDb(rawStore.card(cardId));
      const paced =
        state === "done" &&
        observed?.subtasks.some((entry) => entry.id === subtaskId && entry.interrupting);
      const completing = savedCardGuard(
        "subtask.done",
        Effect.gen(function* () {
          yield* checkText([["note", note]]);
          const card = yield* cardOf(cardId);
          const scriptName = role === "script" ? (yield* scriptFor(card, actor)).name : null;
          const gated = card.subtasks.find((subtask) => subtask.id === subtaskId);
          if (state === "done" && gated?.interrupting && !paced)
            return yield* failWith(
              "conflict",
              "The subtask became interrupting during admission; re-read the card and retry.",
            );
          const board = yield* boardOf(card.boardId);
          const at = yield* nowIso;
          let releaseAt: string | undefined;
          if (releasedAt !== undefined) {
            const millis = Date.parse(releasedAt);
            if (
              !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
                releasedAt,
              ) ||
              !Number.isFinite(millis) ||
              DateTime.formatIso(
                DateTime.makeUnsafe(`${releasedAt.slice(0, 10)}T00:00:00.000Z`),
              ).slice(0, 10) !== releasedAt.slice(0, 10)
            )
              return yield* failWith(
                "invalid",
                "releasedAt must be an ISO datetime",
                "invalid_args",
                "bad_time",
                "releasedAt",
              );
            if (state !== "done" || !gated?.interrupting)
              return yield* failWith(
                "invalid",
                "releasedAt requires marking an interrupting subtask done",
              );
            if (millis > Date.parse(at) + 60_000)
              return yield* failWith(
                "invalid",
                "releasedAt cannot be in the future (beyond 1 minute of clock skew)",
              );
            if (millis < Date.parse(card.createdAt))
              return yield* failWith(
                "invalid",
                "releasedAt cannot be before the card's createdAt",
                "invalid_args",
                "bad_time",
                "releasedAt",
              );
            releaseAt = DateTime.formatIso(DateTime.makeUnsafe(millis));
          }
          const releaseBoards =
            gated?.interrupting && gated.service ? yield* store.boards : [board];
          const standing = {
            approvals: board.standingApprovals,
            ledger: releaseBoards.flatMap((entry) => entry.releaseLedger ?? []),
            boardNames: new Map(releaseBoards.map((entry) => [entry.id as string, entry.name])),
            releasedAt: releaseAt,
            boardId: board.id,
            at,
            note,
          };
          const candidate = gated && {
            ...gated,
            state,
            ...(state !== "skipped" ? { gateSkipped: undefined } : {}),
          };
          const missing =
            candidate && state !== "open"
              ? Subtasks.approvalProblem(
                  card,
                  candidate,
                  standing,
                  board.guessedGates,
                  state === "skipped" ? "skip" : "do",
                )
              : null;
          const skipGate =
            missing &&
            state === "skipped" &&
            actor._tag === "evaluator" &&
            (gated?.owner === "evaluator" || gated?.owner === "script")
              ? Subtasks.gateOf(gated, board.guessedGates)
              : undefined;
          const reason = note?.trim() ?? "";
          if (skipGate && (reason.length < 10 || reason.length > 300)) {
            return yield* failWith(
              "invalid",
              "skipping a gated step needs a reason of 10 to 300 characters in note",
            );
          }
          const check = Subtasks.checkMark(card, subtaskId, state, role, note, scriptName);
          if (!check.ok) return yield* failWith("denied", check.reason, check.denyReason);
          if (actor._tag !== "owner" && missing && !skipGate)
            return yield* failWith("denied", missing, "approval_required");
          const cleared =
            candidate &&
            state === "done" &&
            actor._tag !== "owner" &&
            Subtasks.gateOf(candidate, board.guessedGates) === "deploy" &&
            !candidate.ownerOnly &&
            Subtasks.approvalProblem(card, candidate, [], board.guessedGates) !== null
              ? board.standingApprovals.find((entry) => entry.revokedAt === null)
              : undefined;
          const completionNote = cleared
            ? [note?.trim(), `cleared by standing approval ${cleared.id}`]
                .filter(Boolean)
                .join("; ")
            : note;
          const subtasks = Subtasks.markSubtask(
            card.subtasks,
            subtaskId,
            state,
            completionNote,
            actor,
            at,
          ).map((subtask) =>
            subtask.id === subtaskId && skipGate
              ? {
                  ...subtask,
                  gateSkipped: { gate: skipGate, reason, by: actor, at, text: subtask.text },
                }
              : subtask,
          );
          // The completed candidate is saved only with its release receipt below.
          let marked = (yield* upgradeFindings(
            [
              {
                ...card,
                subtasks,
                wakeNote: Subtasks.pendingWakeNote({ ...card, subtasks }),
                updatedAt: at,
              },
            ],
            false,
          ))[0]!;
          const text = card.subtasks.find((subtask) => subtask.id === subtaskId)?.text ?? "";
          yield* logEvent(marked, actor, "subtask", {
            body: `${subtaskId} ${state}: ${text}${completionNote?.trim() ? ` (${completionNote.trim()})` : ""}`,
          });
          if (skipGate) {
            yield* logEvent(marked, actor, "comment", {
              body: `Skipped ${skipGate}-gated ${subtaskId} ("${text}") without owner approval: ${reason}`,
            });
            const askId = Asks.nextAskId(marked);
            marked = Asks.updateAsk(
              Asks.addAsk(
                marked,
                `An evaluator skipped ${subtaskId}, a ${skipGate}-gated step, without your approval: "${text}". Reason: ${reason}. It was not done; marking it done still needs your OK.`,
                false,
                actor,
                at,
              ),
              askId,
              {
                kind: "notice",
                respond: { ack: true },
                title: `Gate skipped on #${card.number} ${subtaskId}`,
                batchKey: "gate-skipped",
              },
            );
          }
          if (
            state !== "open" &&
            gated?.owner === "review" &&
            gated.step === kanbanOpenStep(card) &&
            marked.activeThreadId === null &&
            marked.settledAt === null &&
            kanbanReviewAlreadyDone(marked)
          ) {
            analyticsActors.set(marked, actor);
            yield* saveCard(marked);
            const synced = yield* syncPrs(marked);
            const evidence = yield* reviewEvidence(board, synced);
            // Ticking the review explicitly answers a pending review request, but
            // cannot reuse a verdict for a different known head.
            const next = kanbanReviewAlreadyDone(synced, { ...evidence, requested: false })
              ? yield* placeFinishedReview(board, synced, actor, subtaskId)
              : synced;
            yield* kick;
            return next;
          }
          const idle =
            (marked.stage === "todo" || Subtasks.BACK_TO_WORK_FROM.has(marked.stage)) &&
            marked.activeThreadId === null &&
            marked.settledAt === null;
          const opened = (owner: "work" | "review") =>
            kanbanStepSubtasks(card, owner).length === 0 &&
            kanbanStepSubtasks(marked, owner).length > 0;
          // A gate before a pending findings bounce exposes review subtasks,
          // but the worker still owes fixes before that review can run again.
          const to: KanbanStage | null = !idle
            ? null
            : opened("work") || (opened("review") && kanbanWorkStep(marked))
              ? "todo"
              : opened("review") &&
                  kanbanStepSubtasks(marked, "work").length === 0 &&
                  marked.stage !== "needs_review"
                ? "needs_review"
                : null;
          const plan = Subtasks.nextStepNote();
          const next: KanbanCard =
            to === null
              ? marked
              : {
                  ...(yield* moveWait(marked, to, at, actor)),
                  stage: to,
                  reviewStep: 0,
                  // Findings or the owner's words already waiting stay ahead of the plan.
                  wakeNote:
                    to === "todo"
                      ? [marked.wakeNote, plan].filter((part) => part !== null).join("\n\n")
                      : marked.wakeNote,
                  movedAt: at,
                };
          if (to !== null && card.stage !== to) {
            yield* logEvent(next, actor, "moved", {
              fromStage: card.stage,
              toStage: to,
              body: to === "todo" ? "Next step is the worker's" : "Next step is the review",
            });
          }
          analyticsActors.set(next, actor);
          // The actor goes with the save: a card a script's subtask moved is a move by that script.
          const releaseBoard =
            gated?.interrupting && state === "done"
              ? {
                  ...board,
                  releaseLedger: [
                    ...(board.releaseLedger ?? []),
                    {
                      boardId: board.id,
                      cardId: card.id,
                      cardNumber: card.number,
                      subtaskId,
                      at: releaseAt ?? at,
                      ...(gated.service === undefined ? {} : { service: gated.service }),
                      ...(releaseAt === undefined ? {} : { postHoc: true }),
                      critical: Subtasks.criticalReleaseReason(note),
                      approvalId: cleared?.id ?? null,
                    },
                  ]
                    .toSorted((a, b) => a.at.localeCompare(b.at))
                    .slice(-200),
                }
              : undefined;
          yield* saveCard(
            next,
            to !== null && card.stage !== to ? actor : undefined,
            false,
            undefined,
            releaseBoard,
          );
          const advanced = yield* advanceFinishedWorker(next);
          if (advanced === next) yield* laterEvaluatorTurn(card, next, actor);
          yield* kick;
          return advanced;
        }),
      );
      if (!paced) return yield* completing;
      const immediate = yield* completing.pipe(releaseTicks.withPermitsIfAvailable(1));
      if (Option.isSome(immediate)) return immediate.value;
      yield* Effect.logDebug("kanban release admission waiting", { cardId, subtaskId });
      return yield* completing.pipe(releaseTicks.withPermits(1));
    },
  );

  /** Only a board script does a script's subtask, and only on its own board. */
  const scriptFor = Effect.fn("KanbanService.scriptFor")(function* (
    card: KanbanCard,
    actor: KanbanActor,
  ) {
    if (actor._tag !== "script")
      return yield* failWith("denied", "only a board script does this", "role_not_allowed");
    const script = yield* store.script(actor.scriptId);
    if (script === null || script.boardId !== card.boardId) {
      return yield* failWith(
        "denied",
        `card #${card.number} isn't on this script's board`,
        "cross_board",
      );
    }
    return script;
  });

  const handBack: KanbanServiceShape["handBack"] = (cardId, subtaskId, note, actor) =>
    guard(
      "subtask.handBack",
      Effect.gen(function* () {
        yield* checkText([["note", note]]);
        const card = yield* cardOf(cardId);
        const script = yield* scriptFor(card, actor);
        const check = Subtasks.checkHandBack(card, subtaskId, script.name, note);
        if (!check.ok)
          return yield* failWith(
            "denied",
            check.reason,
            ("denyReason" in check ? check.denyReason : undefined) ?? "role_not_allowed",
          );
        const at = yield* nowIso;
        const trimmed = note.trim();
        const text = card.subtasks.find((subtask) => subtask.id === subtaskId)?.text ?? "";
        const next: KanbanCard = {
          ...card,
          subtasks: Subtasks.handBack(card.subtasks, subtaskId, trimmed),
          updatedAt: at,
        };
        yield* logEvent(next, actor, "subtask", {
          body: `${subtaskId} handed back to the evaluator: ${text} (${trimmed})`,
        });
        yield* saveCard(next);
        // One wake for the hand-back itself: the evaluator hears the note once.
        yield* noteDiscussion(
          next,
          Briefs.handBackText(next, subtaskId, script.name, trimmed),
        ).pipe(
          Effect.provideService(EvaluatorAnalytics.origin, "step_transition"),
          Effect.catchCause((cause) => Effect.logWarning("kanban hand-back note failed", cause)),
        );
        yield* kick;
        return next;
      }),
    );

  /** A script's subtask names a script on this board: a misspelt name would leave its step waiting for good. */
  const checkScriptNames = Effect.fn("KanbanService.checkScriptNames")(function* (
    boardId: KanbanBoard["id"],
    subtasks: ReadonlyArray<KanbanSubtask>,
  ) {
    const names = new Set(
      (yield* store.scripts(boardId)).map((script) => script.name.toLowerCase()),
    );
    for (const subtask of subtasks) {
      if (subtask.state !== "open" || subtask.script === undefined) continue;
      if (!names.has(subtask.script.toLowerCase())) {
        return yield* failWith(
          "invalid",
          `subtask ${subtask.id}: no script named "${subtask.script}" on this board`,
        );
      }
    }
  });

  /**
   * A reviewer that lost its slot mid-review (the dispatcher's no-verdict flag,
   * or its own card_flag) still owns the step while nothing has moved the card
   * since, so its verdict counts. A recorded verdict or any later move closes it.
   */
  const lateReviewer = Effect.fn("KanbanService.lateReviewer")(function* (
    card: KanbanCard,
    threadId: ThreadId,
    knownEvents?: ReadonlyArray<KanbanCardEvent>,
  ) {
    if (
      card.stage !== "needs_review" ||
      card.activeThreadId !== null ||
      card.reviewThreadId !== threadId ||
      card.settledAt !== null
    ) {
      return false;
    }
    const events = knownEvents ?? (yield* store.cardEvents(card.id));
    // A recorded verdict closes the window even when it leaves the stage as is
    // (a late clear logs needs_review -> needs_review), so it counts as a move.
    const left = events.findLast(
      (event) =>
        event.kind === "review" ||
        (event.fromStage !== null && event.toStage !== null && event.fromStage !== event.toStage),
    );
    return (
      left?.kind === "flagged" &&
      left.fromStage === "in_review" &&
      (left.actor._tag === "system" ||
        (left.actor._tag === "thread" && left.actor.threadId === threadId))
    );
  });

  const REVIEW_REPLAY_WINDOW_MS = 10 * 60_000;
  const reviewResult: KanbanServiceShape["reviewResult"] = (threadId, verdict, findings, head) =>
    Effect.suspend(() => {
      let attempted: KanbanCard | undefined;
      let savingVerdict = false;
      return SavedWrite.recover(
        guardDeferred(
          "card.reviewResult",
          Effect.gen(function* () {
            yield* checkText(findings.map((finding) => ["finding", finding] as const));
            const location = yield* locks.outside(rawStore.threadLink(threadId), undefined, true);
            if (location) yield* locks.access(location.boardId, Effect.void);
            const link = yield* locks.outside(rawStore.threadLink(threadId), undefined, true);
            if (!link || link.role !== "review" || link.cardId === null) {
              return yield* failWith(
                "denied",
                "only a card's review thread records a review result",
                "role_not_allowed",
              );
            }
            const initialCard = yield* turnEndCard(link.cardId);
            if (!initialCard) return yield* failWith("not-found", `card ${link.cardId}`);
            let card = initialCard;
            attempted = card;
            const live = card.activeThreadId === threadId && card.stage === "in_review";
            const events = yield* locks.outside(rawStore.cardEvents(card.id), undefined, true);
            const late = !live && (yield* lateReviewer(card, threadId, events));
            const sha = head?.trim().toLowerCase() || null;
            const body =
              verdict === "findings"
                ? findings.map((line) => `- ${line.trim()}`).join("\n")
                : "clear";
            if (!live && !late) {
              if (sha !== null && /^[0-9a-f]{7,40}$/.test(sha)) {
                const lastReview = events.findLast((event) => event.kind === "review");
                const at = yield* nowIso;
                const ageMs =
                  lastReview === undefined
                    ? Number.NaN
                    : Date.parse(at) - Date.parse(lastReview.at);
                const dispatchedSince =
                  lastReview !== undefined &&
                  events.some(
                    (event) =>
                      event.id > lastReview.id &&
                      event.kind === "moved" &&
                      event.toStage === "in_review",
                  );
                if (
                  lastReview?.actor._tag === "thread" &&
                  lastReview.actor.threadId === threadId &&
                  lastReview.head === sha &&
                  lastReview.body === body &&
                  ageMs >= 0 &&
                  ageMs <= REVIEW_REPLAY_WINDOW_MS &&
                  card.movedAt === lastReview.at &&
                  lastReview.toStage === card.stage &&
                  !dispatchedSince
                ) {
                  yield* Effect.logInfo("kanban review result replay ignored", {
                    cardId: card.id,
                    threadId,
                    head: sha,
                  });
                  return {
                    card,
                    recorded: false,
                    note: `Already recorded as review event ${lastReview.id} at ${lastReview.at}; not saved again.`,
                  };
                }
              }
              const board = yield* locks.outside(rawStore.board(card.boardId), undefined, true);
              if (!board) return yield* failWith("not-found", `board ${card.boardId}`);
              const steps = Rules.chainFor(board, card)?.steps.length ?? 1;
              const step = Math.min(card.reviewStep + 1, steps);
              return yield* failWith(
                "conflict",
                `card #${card.number} is not in review with this thread (stage ${card.stage}, review step ${step} of ${steps}${card.stage === "needs_review" ? " waits for the dispatcher" : ""}). Your verdict was not recorded. Check card_get for the current assignment.`,
              );
            }
            if (verdict === "findings" && findings.length === 0) {
              return yield* failWith(
                "invalid",
                "findings need at least one line",
                undefined,
                "missing_required",
                "findings",
              );
            }
            if (sha !== null && !/^[0-9a-f]{7,40}$/.test(sha)) {
              return yield* failWith(
                "invalid",
                "head is the commit you reviewed: 7 to 40 hex characters",
              );
            }
            const board = yield* locks.outside(rawStore.board(card.boardId), undefined, true);
            if (!board) return yield* failWith("not-found", `board ${card.boardId}`);
            let snapshot: CardWriteSnapshot = yield* locks.outside(
              Effect.gen(function* () {
                const slots = new Map<string, ReadonlyArray<KanbanCard>>();
                if (card.activeThreadId !== null)
                  slots.set(
                    card.activeThreadId,
                    yield* rawStore.cardsByThread(card.activeThreadId),
                  );
                const waitTargets = new Map<string, KanbanCard & { readonly boardName?: string }>();
                if (card.wait?.card != null) {
                  const target = yield* rawStore.card(KanbanCardId.make(card.wait.card));
                  if (target) {
                    const boardName =
                      target.boardId === card.boardId
                        ? undefined
                        : ((yield* rawStore.board(target.boardId))?.name ?? target.boardId);
                    waitTargets.set(target.id, {
                      ...target,
                      ...(boardName === undefined ? {} : { boardName }),
                    });
                  }
                }
                return {
                  before: card,
                  board,
                  events,
                  slots,
                  waitTargets,
                  workCards:
                    card.workThreadId === null
                      ? []
                      : yield* rawStore.threadCards(card.workThreadId),
                  reviewLink:
                    card.reviewThreadId === threadId
                      ? link
                      : card.reviewThreadId === null
                        ? null
                        : yield* rawStore.threadLink(card.reviewThreadId),
                };
              }),
              undefined,
              true,
            );
            card = yield* syncPrs(card, undefined, snapshot);
            snapshot = { ...snapshot, before: card };
            const chain = Rules.chainFor(board, card);
            const outcome = Rules.applyReviewResult(card, chain?.steps.length ?? 1, verdict);
            const at = yield* nowIso;
            // Only the last chain verdict closes the plan's next review step,
            // even when earlier work still needs ticking off.
            const passed = verdict === "clear" && !outcome.continueReview;
            const reviewSubtasks = passed ? Subtasks.reviewSubtasksToPass(card) : [];
            if (passed) {
              for (const subtask of reviewSubtasks) {
                const missing = Subtasks.approvalProblem(
                  card,
                  subtask,
                  board.standingApprovals,
                  board.guessedGates,
                );
                if (missing) return yield* failWith("denied", missing, "approval_required");
              }
            }
            const subtasks = passed
              ? Subtasks.passReview(card, { _tag: "thread", threadId }, at)
              : card.subtasks;
            const moreWork = passed && Subtasks.workAfterReview({ subtasks });
            const unfinishedWork = kanbanStepSubtasks({ subtasks }, "work");
            const reviewPlanStep = reviewSubtasks[0]?.step;
            const earlierWork =
              reviewPlanStep !== undefined &&
              moreWork &&
              unfinishedWork.some((work) => work.step < reviewPlanStep);
            const to = moreWork
              ? "todo"
              : outcome.continueReview
                ? "needs_review"
                : outcome.stage === "completed" &&
                    !reviewPlanClear({ ...card, subtasks, reviewFindingsPending: false })
                  ? "in_review"
                  : outcome.stage;
            const prCompletion = to === "completed" && trackedPrs(card).length > 0;
            const next: KanbanCard = {
              // A verdict is a review that ended normally: its retry record goes.
              ...Retries.withoutRetries(
                release(
                  yield* moveWait(
                    card,
                    to,
                    at,
                    { _tag: "thread", threadId },
                    prCompletion,
                    snapshot,
                  ),
                ),
              ),
              // The dispatcher's no-verdict flag is answered by the verdict; a
              // reviewer's own flag stays for the evaluator.
              stalled: late && card.stalled?.by._tag === "system" ? null : card.stalled,
              subtasks,
              stage: to,
              reviewStep: moreWork && !earlierWork ? 0 : outcome.reviewStep,
              reviewRound: outcome.reviewRound,
              reviewFindingsPending: verdict === "findings",
              wakeNote:
                verdict === "findings"
                  ? `Review findings (round ${card.reviewRound + 1}):\n${body}\n\nFix them, then card_move to needs_review.`
                  : earlierWork
                    ? `The review${sha ? ` at ${sha}` : ""} passed. Tick your open subtasks (${Subtasks.subtaskIds(unfinishedWork)}) with subtask_done, then card_move to needs_review. Don't change code.`
                    : moreWork
                      ? Subtasks.nextStepNote("The review passed. ")
                      : // A review start keeps the card's wake note so the reviewer reads it
                        // (startCard). The verdict is where it has been read: without this it
                        // came back in every later review brief.
                        null,
              nudgedAt: null,
              movedAt: at,
              updatedAt: at,
            };
            yield* logEvent(next, { _tag: "thread", threadId }, "review", {
              at,
              fromStage: card.stage,
              toStage: next.stage,
              body,
              head: sha,
              before: card,
            });
            savingVerdict = true;
            yield* saveCard(next, undefined, false, undefined, undefined, snapshot);
            if (prCompletion) {
              // Keep the verdict body intact for review evidence and replay detection.
              yield* logEvent(next, { _tag: "thread", threadId }, "comment", {
                at,
                body: "review clear and PRs merged",
                before: next,
              });
              yield* logStageSync(next);
            }
            const reviewStartedAt = live
              ? card.movedAt
              : (events.findLast((event) => event.toStage === "in_review")?.at ?? link.startedAt);
            yield* recordAnalytics({
              kind: "kanban.review_verdict",
              boardId: card.boardId,
              cardId: card.id,
              threadId,
              durationMs: BoardAnalytics.elapsed(at, reviewStartedAt),
              props: {
                round: card.reviewRound + 1,
                chain: BoardAnalytics.label(chain?.name ?? "none"),
                verdict: verdict === "clear" ? "clear" : "feedback",
                ...(sha === null ? {} : { head: sha }),
              },
            });
            yield* kick;
            const actor: KanbanActor = { _tag: "thread", threadId };
            if (evaluatorTurnDue(card, next))
              yield* later(
                next.boardId,
                cardLane(next),
                {
                  kind: "evaluatorTurn",
                  before: card,
                  after: next,
                  actor,
                  evaluatorTrigger: "review_verdict",
                },
                forkPostCommit(evaluatorTurn(card, next, actor)),
              );
            if (verdict === "findings" && next.reviewRound === 3) {
              const text = `#${card.number} got review findings for the third time. Findings:\n${body}\n\nDecide the scope now: steer the worker on what must still be fixed here, move the rest to a new card, or accept what's left with a note on the card.`;
              yield* later(
                next.boardId,
                cardLane(next),
                {
                  kind: "noteDiscussion",
                  cardId: next.id,
                  text,
                  evaluatorTrigger: "review_verdict",
                },
                forkPostCommit(noteDiscussion(next, text)),
              );
            }
            return { card: next, recorded: true };
          }),
        ),
        (saved) =>
          // A PR metadata save does not acknowledge the subsequent verdict.
          savingVerdict && saved.kind === "card" && saved.card.id === attempted?.id
            ? { card: saved.card, recorded: true }
            : undefined,
      ).pipe(
        Effect.tapError((error) => {
          const initial = attempted;
          if (
            initial !== undefined &&
            (initial.activeRole !== "review" || initial.activeThreadId !== threadId)
          )
            return Effect.void;
          return guardDeferred(
            "card.reviewResult.refused",
            Effect.gen(function* () {
              const link = yield* locks.outside(rawStore.threadLink(threadId), undefined, true);
              const cardId = initial?.id ?? link?.cardId;
              if (cardId == null) return;
              const boardId = initial?.boardId ?? link?.boardId;
              if (boardId !== undefined) yield* locks.access(boardId, Effect.void);
              const card = yield* turnEndCard(cardId);
              if (!card) return yield* failWith("not-found", `card ${cardId}`);
              if (
                card.activeRole !== "review" ||
                card.activeThreadId !== threadId ||
                (initial !== undefined && card.movedAt !== initial.movedAt)
              )
                return;
              const sha = head?.trim().toLowerCase() || null;
              // Invalid heads may contain the delimiter used to read back the refusal reason.
              const shortHead =
                sha === null
                  ? "unknown head"
                  : /^[0-9a-f]{7,40}$/.test(sha)
                    ? sha.slice(0, 8)
                    : "invalid head";
              const body = `${Retries.REFUSED_VERDICT_PREFIX}${verdict} at ${shortHead}: ${error.detail}`;
              const events = yield* locks.outside(rawStore.cardEvents(card.id), undefined, true);
              if (
                events.some(
                  (event) =>
                    event.kind === "comment" &&
                    event.actor._tag === "thread" &&
                    event.actor.threadId === threadId &&
                    event.at >= card.movedAt &&
                    event.head === sha &&
                    event.body === body,
                )
              )
                return;
              const shown = yield* locks.outside(withWaitTargets([card]), undefined, true);
              yield* logEvent(card, { _tag: "thread", threadId }, "comment", {
                body,
                head: sha,
                before: card,
              });
              yield* publish(card.boardId, { _tag: "card", card: shown[0]! }, true);
            }),
            initial?.id,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("kanban review refusal could not be recorded", { cause }),
            ),
          );
        }),
        (effect) => SavedWrite.subSteps("card.reviewResult", effect),
      );
    });

  const cardThread: KanbanServiceShape["cardThread"] = (cardId, action, text, actor) =>
    savedCardGuard(
      "card.thread",
      Effect.gen(function* () {
        if ((action === "steer" || action === "wake") && !text.trim())
          return yield* failWith("invalid", `${action} needs text: pass the message as text`);
        yield* checkText([["note", text]]);
        const stored = yield* cardOf(cardId);
        const card = (yield* upgradeFindings([stored], false))[0]!;
        if (action !== "stop" && (yield* boardOf(card.boardId)).archivedAt !== null)
          return yield* failWith("denied", "Board is deleted", "board_deleted");
        if (
          (action === "steer" || action === "wake") &&
          card.activeRole !== "review" &&
          !kanbanWorkStep(card)
        ) {
          const open = kanbanStepSubtasks(card);
          const owners = [...new Set(open.map((subtask) => subtask.owner))];
          const step =
            open.length === 0
              ? "All subtasks are finished."
              : `Step ${kanbanOpenStep(card)} (${Subtasks.subtaskIds(open)}) belongs to ${owners.join(" and ")}.`;
          const next = owners.includes("review")
            ? "The dispatcher starts the reviewer; use card_move to needs_review if the card is still in working."
            : open.length === 0
              ? "Add work subtasks with card_edit, then wake."
              : "Complete that step, or add work subtasks with card_edit, then wake.";
          return yield* failWith(
            "denied",
            `card #${card.number}: no worker step open. ${step} ${next}`,
            "work_step_missing",
          );
        }
        if (card !== stored) yield* saveCard(card);
        const at = yield* nowIso;
        const wakeNote = Subtasks.pendingWakeNote({
          ...card,
          wakeNote: [card.wakeNote, text.trim()].filter(Boolean).join("\n\n") || null,
        });
        if (action === "steer") {
          const threadId = card.activeThreadId ?? card.workThreadId;
          if (threadId === null)
            return yield* failWith("invalid", `card #${card.number} has no thread`);
          const board = yield* boardOf(card.boardId);
          if (board.pause && !board.pause.keep.includes(card.id)) {
            return yield* failWith(
              "denied",
              `the board is paused: ${board.pause.reason}`,
              "board_paused",
            );
          }
          if (
            board.pause &&
            (yield* store.cardsByThread(threadId)).some(
              (entry) => !board.pause!.keep.includes(entry.id),
            )
          ) {
            return yield* failWith(
              "denied",
              `the board is paused: ${board.pause.reason}`,
              "board_paused",
            );
          }
          // A released sibling still points at the shared thread. The thread runs its own
          // current model (a switch moved it, and it survives every card's release), so a
          // steer sends that rather than the sibling's stale one.
          const threadModel = card.activeThreadId === null ? yield* threads.model(threadId) : null;
          const model =
            card.activeRole === "review"
              ? Rules.nextModel(yield* boardOf(card.boardId), card)
              : (threadModel ?? card.model);
          yield* sendThread(
            { threadId, text, model, flushQueued: "steer" },
            undefined,
            Effect.succeed(true),
          );
          const current = yield* cardOf(cardId);
          // A worker owns its explicit wait even when another signal starts a run.
          let next = current;
          if (current.activeThreadId === null && current.workThreadId === threadId) {
            if (
              card.wait !== undefined &&
              !(card.wait.by._tag === "thread" && card.wait.by.threadId === threadId) &&
              NodeUtil.isDeepStrictEqual(current.wait, card.wait)
            )
              next = kanbanWithoutWait(next);
            if (
              card.retries !== undefined &&
              NodeUtil.isDeepStrictEqual(current.retries, card.retries)
            )
              next = Retries.withoutRetries(next);
            const deliveredAt = yield* nowIso;
            next = {
              ...next,
              detachedSteerAt: deliveredAt,
              nudgedAt: null,
              updatedAt: deliveredAt,
            };
          }
          yield* logEvent(next, actor, "thread", { body: `Steered: ${text}` });
          // Recording delivery supersedes idle reads taken before the signal was saved.
          if (next !== current) yield* touching(threadId, saveCard(next));
          return next;
        }
        if (action === "stop") {
          if (card.activeThreadId === null) {
            for (const threadId of new Set([card.workThreadId, card.reviewThreadId])) {
              if (threadId === null) continue;
              const others = (yield* store.cardsByThread(threadId)).filter(
                (other) => other.id !== card.id,
              );
              if (others.length > 0)
                return yield* failWith(
                  "denied",
                  `Thread carries another attached card (#${others[0]!.number}); left it running`,
                  "shared_thread_in_use",
                );
            }
          }
          if (Option.isSome(analytics))
            for (const id of new Set([
              card.activeThreadId,
              card.workThreadId,
              card.reviewThreadId,
            ])) {
              if (
                id === null ||
                (yield* store.cardsByThread(id)).some((other) => other.id !== card.id)
              )
                continue;
              const run = yield* threads.latestRun(id).pipe(Effect.orElseSucceed(() => null));
              if (
                run === null ||
                ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
                  run.status,
                )
              )
                continue;
              stoppedRunCards.set(id, {
                runId: run.runId,
                card: {
                  id: card.id,
                  boardId: card.boardId,
                  activePool: card.activePool,
                  model: run.model ?? card.model,
                },
              });
              if (stoppedRunCards.size > 4096)
                stoppedRunCards.delete(stoppedRunCards.keys().next().value!);
            }
          const kept = yield* endCardThreads(
            card,
            text.trim() ? `was stopped: ${text.trim()}` : "was stopped",
          );
          const next: KanbanCard = {
            ...release(
              yield* moveWait(
                card,
                KANBAN_THREAD_STAGES.includes(card.stage) ? "todo" : card.stage,
                at,
                actor,
              ),
            ),
            // A thread that goes on with other cards dropped this one for good.
            workThreadId: kept ? null : card.workThreadId,
            stage: KANBAN_THREAD_STAGES.includes(card.stage) ? "todo" : card.stage,
            stalled: { reason: text.trim() || "Stopped", by: actor, at },
            movedAt: at,
            updatedAt: at,
          };
          yield* logEvent(next, actor, "flagged", {
            fromStage: card.stage,
            toStage: next.stage,
            body: next.stalled?.reason ?? null,
          });
          yield* saveCard(next, undefined, false, "thread_stopped");
          return next;
        }
        if (action === "reset") {
          yield* endCardThreads(card, "moved to a fresh thread");
          const stage: KanbanCard["stage"] =
            card.stage === "working"
              ? "todo"
              : card.stage === "in_review"
                ? "needs_review"
                : card.stage;
          const next: KanbanCard = {
            ...release(yield* moveWait(card, stage, at, actor)),
            workThreadId: null,
            reviewThreadId: null,
            stage,
            stalled: null,
            nudgedAt: null,
            wakeNote: stage === "todo" ? withFreshNote(wakeNote) : wakeNote,
            movedAt: at,
            updatedAt: at,
          };
          yield* logEvent(next, actor, "moved", {
            fromStage: card.stage,
            toStage: stage,
            body: text.trim() ? `${FRESH_START}: ${text.trim()}` : FRESH_START,
          });
          yield* saveCard(next);
          yield* kick;
          return next;
        }
        if (card.activeThreadId !== null) {
          const board = yield* boardOf(card.boardId);
          if (board.pause && !board.pause.keep.includes(card.id)) {
            return yield* failWith(
              "denied",
              `the board is paused: ${board.pause.reason}`,
              "board_paused",
            );
          }
          if (
            board.pause &&
            (yield* store.cardsByThread(card.activeThreadId)).some(
              (entry) => !board.pause!.keep.includes(entry.id),
            )
          ) {
            return yield* failWith(
              "denied",
              `the board is paused: ${board.pause.reason}`,
              "board_paused",
            );
          }
          const model =
            card.activeRole === "review"
              ? Rules.nextModel(yield* boardOf(card.boardId), card)
              : card.model;
          const threadId = card.activeThreadId;
          yield* sendThread(
            { threadId, text, model, flushQueued: "wake" },
            undefined,
            Effect.succeed(true),
          );
          return yield* cardOf(cardId);
        }
        const next: KanbanCard = {
          // Woken out of Needs Owner: the wake text stands in for the answer.
          ...Asks.closeAsks(
            yield* moveWait(
              card,
              card.stage === "needs_review" ? "needs_review" : "todo",
              at,
              actor,
            ),
            at,
            (ask) => ask.blocking && card.stage === "needs_owner",
          ),
          stage: card.stage === "needs_review" ? "needs_review" : "todo",
          stalled: null,
          question: null,
          settledAt: null,
          wakeNote,
          movedAt: card.stage === "todo" || card.stage === "needs_review" ? card.movedAt : at,
          updatedAt: at,
        };
        yield* logEvent(next, actor, "moved", {
          fromStage: card.stage,
          toStage: next.stage,
          body: "Woken",
        });
        yield* saveCard(next);
        if (card.settledAt !== null && card.discussionId !== null) {
          const discussion = yield* store.discussion(card.discussionId);
          if (discussion !== null && discussion.settledAt !== null) {
            yield* saveDiscussion({ ...discussion, settledAt: null, reopenedAt: at });
          }
        }
        yield* laterEvaluatorTurn(card, next, actor);
        yield* kick;
        return next;
      }),
    );

  /**
   * The pool a pool request names: its exact level's pool; else, for a request with no
   * level, the model's only pool. A model with pools at several levels needs the level.
   * Undefined: no pool yet.
   */
  const namedPool = Effect.fn("KanbanService.namedPool")(function* (
    pools: ReadonlyArray<KanbanPool>,
    model: ModelSelection,
  ) {
    const same = pools.filter((pool) => Rules.modelKey(pool.model) === Rules.modelKey(model));
    const exact = same.find((pool) => Rules.poolKey(pool.model) === Rules.poolKey(model));
    // A named level is exact: its pool, or none (a new pool at that level).
    if (Rules.modelLevel(model) !== null) return exact;
    // A request with no level must name one only when the model has several pools.
    if (same.length > 1) {
      const levels = same.map((pool) => Rules.modelLevel(pool.model) ?? "no level").join(", ");
      return yield* failWith("invalid", `${model.model} has pools at ${levels}; name the level`);
    }
    return same[0];
  });

  /**
   * Moves pool `from` to `to` (same row, new key and level) with the cards still to run on it,
   * in one transaction (store.rekeyBoard). An open card's work model and weighted entries that
   * resolve to `from` take the new level; a slot a card or a thread between cards holds on
   * `from` moves to `to`. Done and settled cards keep the level they ran at. A running work
   * thread switches for its next turn; review threads aren't switched, their next step reads
   * the chain.
   */
  const movePoolLevel = Effect.fn("KanbanService.movePoolLevel")(function* (
    board: KanbanBoard,
    pools: ReadonlyArray<KanbanPool>,
    from: KanbanPool,
    to: KanbanPool,
  ) {
    const at = yield* nowIso;
    // `pools` is read before the move: a card is on `from` when its model resolves to it now.
    const onPool = (entry: ModelSelection) => Rules.poolOf(pools, entry) === from.key;
    const moved: Array<{
      readonly card: KanbanCard;
      readonly leveled: boolean;
      readonly work: boolean;
    }> = [];
    for (const card of yield* store.cards(board.id)) {
      const moveSlot = card.activePool === from.key;
      const open = card.settledAt === null && !KANBAN_DONE_STAGES.has(card.stage);
      const work = open && onPool(card.model);
      const weighted = open && card.models.some((entry) => onPool(entry.model));
      if (!moveSlot && !work && !weighted) continue;
      moved.push({
        card: {
          ...card,
          model: work ? to.model : card.model,
          models: weighted
            ? card.models.map((entry) =>
                onPool(entry.model) ? { ...entry, model: to.model } : entry,
              )
            : card.models,
          activePool: moveSlot ? to.key : card.activePool,
          updatedAt: work || weighted ? at : card.updatedAt,
        },
        leveled: work || weighted,
        work,
      });
    }
    const movedThreads = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* store.rekeyBoard(
          board.id,
          [{ from: from.key, pool: to }],
          moved.map((entry) => entry.card),
        );
        const movedThreads = new Map<string, string | null>();
        for (const { card } of moved) {
          if (card.activeThreadId !== null) movedThreads.set(card.activeThreadId, card.id);
        }
        for (const [threadId, held] of yield* Ref.get(holds)) {
          if (held.boardId === board.id && held.pool === from.key && !movedThreads.has(threadId))
            movedThreads.set(threadId, null);
        }
        yield* Ref.update(
          holds,
          (all) =>
            new Map(
              [...all].map(([threadId, held]) =>
                held.boardId === board.id && held.pool === from.key
                  ? [threadId, { ...held, pool: to.key }]
                  : [threadId, held],
              ),
            ),
        );
        for (const [threadId, cardId] of movedThreads)
          yield* syncSlot(board.id, threadId, "pool_moved", cardId);
        return movedThreads;
      }),
    );
    const actor: KanbanActor = { _tag: "system", component: "pools" };
    const level = Rules.modelLevel(to.model) ?? "default";
    const switched = new Set<string>();
    for (const { card, leveled, work } of moved) {
      // Logged before the publish: clients re-read the card's history when it's published.
      if (leveled) yield* logEvent(card, actor, "edited", { body: `model level: ${level}` });
      yield* publish(board.id, { _tag: "card", card });
      const workThread =
        (card.activeRole === "work" ? card.activeThreadId : null) ?? card.workThreadId;
      if (work && workThread !== null && !switched.has(workThread)) {
        switched.add(workThread);
        yield* threads
          .setModel(workThread, to.model)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("kanban thread model switch failed", { cardId: card.id, cause }),
            ),
          );
      }
    }
    // A held slot (a work thread between cards) moves with its pool and keeps its start time.
    // Its thread also switches: its last card may already be in review, so `moved` may not
    // name it.
    const held = yield* Ref.get(holds);
    for (const [threadId, hold] of held) {
      if (hold.boardId !== board.id || !movedThreads.has(threadId)) continue;
      if (!switched.has(threadId)) {
        switched.add(threadId);
        yield* threads
          .setModel(threadId, to.model)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("kanban thread model switch failed", { threadId, cause }),
            ),
          );
      }
    }
  });

  /** Moves the pool at `replaces` to `model`'s level, keeping its row and, unless given, its slots. */
  const changePoolLevel = Effect.fn("KanbanService.changePoolLevel")(function* (
    board: KanbanBoard,
    model: ModelSelection,
    slots: number | undefined,
    replaces: string,
  ) {
    const pools = yield* store.pools(board.id);
    const from = pools.find((pool) => pool.key === replaces);
    if (!from) return yield* failWith("not-found", `pool ${replaces}`);
    if (Rules.modelKey(from.model) !== Rules.modelKey(model)) {
      return yield* failWith(
        "invalid",
        `${replaces} runs ${from.model.model}; a level change keeps the model`,
      );
    }
    const key = Rules.poolKey(model);
    const count = slots === undefined ? from.slots : Math.max(0, Math.round(slots));
    // A pause (0 slots) of the same pool may keep an unoffered level, as on the plain path.
    // A level change always stores `model`, and a running card is switched to it, so it
    // always passes the same checks as a plain setPool.
    const pausingSame = count === 0 && key === from.key;
    if (!pausingSame) {
      yield* checkModel(model);
      const listed = isListed(yield* models.listed, model);
      if (listed === false) {
        return yield* failWith(
          "invalid",
          `${key} isn't in the model list; pick a model the composer offers`,
        );
      }
    }
    if (key === from.key) {
      if (count === from.slots) return pools;
      yield* store.putPool(board.id, { ...from, slots: count });
      return yield* store.pools(board.id);
    }
    if (pools.some((pool) => pool.key === key)) {
      return yield* failWith(
        "conflict",
        `${model.model} already has a pool at ${Rules.modelLevel(model) ?? "no level"}`,
      );
    }
    yield* movePoolLevel(board, pools, from, { key, model, slots: count });
    return yield* store.pools(board.id);
  });

  const setPool: KanbanServiceShape["setPool"] = (boardId, model, slots, options) =>
    guard(
      "pool.set",
      Effect.gen(function* () {
        model = yield* canonicalModel(model);
        const board = yield* boardOf(boardId);
        if (options?.replaces !== undefined) {
          const changed = yield* changePoolLevel(board, model, slots, options.replaces);
          yield* publish(boardId, { _tag: "pools", pools: changed });
          yield* kick;
          return changed;
        }
        if (slots === undefined)
          return yield* failWith(
            "invalid",
            "slots is required",
            "invalid_args",
            "missing_required",
            "slots",
          );
        const count = Math.max(0, Math.round(slots));
        const pools = yield* store.pools(board.id);
        const same = pools.filter((pool) => Rules.modelKey(pool.model) === Rules.modelKey(model));
        const offered = Result.isSuccess(yield* Effect.result(checkModel(model)));
        // A pause at a level the provider doesn't offer pauses the model's only pool.
        const existing =
          (yield* namedPool(pools, model)) ??
          (count === 0 && !offered && same.length === 1 ? same[0] : undefined);
        // Pausing an existing pool must always work, even when its model has left the
        // provider's catalog: the pool is being stopped, not started.
        const pausing = count === 0 && existing !== undefined;
        // A resize that names no level, or a pause at an unoffered level, keeps the pool's
        // stored model, so a pool's level is never dropped or replaced by an unoffered one.
        const stored =
          existing !== undefined && (Rules.modelLevel(model) === null || (pausing && !offered))
            ? existing.model
            : model;
        if (!pausing) yield* checkModel(stored);
        // Unknown (null) never blocks; only a model the composer is known not to offer does.
        const listed = isListed(yield* models.listed, stored);
        if (listed === false && !pausing) {
          return yield* failWith(
            "invalid",
            `${Rules.poolKey(stored)} isn't in the model list; pick a model the composer offers`,
          );
        }
        yield* store.putPool(boardId, {
          key: existing?.key ?? Rules.poolKey(stored),
          model: stored,
          slots: count,
        });
        const saved = yield* store.pools(boardId);
        yield* publish(boardId, { _tag: "pools", pools: saved });
        yield* kick;
        return saved;
      }),
    );

  const removePool: KanbanServiceShape["removePool"] = (boardId, model, options) =>
    guard(
      "pool.remove",
      Effect.gen(function* () {
        model = yield* canonicalModel(model);
        const board = yield* boardOf(boardId);
        const pools = yield* store.pools(board.id);
        // A named key is the exact pool, even for a level-less request on a model with several pools.
        const pool =
          options?.replaces !== undefined
            ? pools.find((candidate) => candidate.key === options.replaces)
            : yield* namedPool(pools, model);
        if (!pool) return yield* failWith("not-found", `pool ${Rules.poolKey(model)}`);
        const key = pool.key;
        // A model with no pool at its own level runs on its model's first pool (Rules.poolFor).
        const runsHere = (used: ModelSelection) => Rules.poolFor(pools, used)?.key === key;
        if (pool.slots > 0) {
          return yield* failWith(
            "invalid",
            `${key} has ${pool.slots} slots; set it to 0 before removing`,
          );
        }
        const boardUses: Array<[string, ModelSelection | undefined]> = [
          ["the manager model", board.managerModel],
          ["the evaluator model", board.evaluatorModel],
          ["the default card model", board.defaultCardModel],
        ];
        for (const [label, used] of boardUses) {
          if (used && runsHere(used)) {
            return yield* failWith("invalid", `${label} uses ${key}`);
          }
        }
        for (const chain of board.reviewChains) {
          if (chain.steps.some(runsHere)) {
            return yield* failWith("invalid", `a review chain uses ${key}`);
          }
        }
        for (const card of yield* store.cards(board.id)) {
          if (card.activePool === key && card.activeThreadId !== null) {
            return yield* failWith("invalid", `a thread is running on ${key}`);
          }
          if (card.settledAt !== null) continue;
          // card.model is the pinned work model, kept even when weighted candidates exist.
          if (Rules.modelOnPool(card, key, pools) !== null) {
            return yield* failWith("invalid", `card #${card.number} uses ${key}`);
          }
        }
        yield* store.removePool(board.id, key);
        const left = yield* store.pools(board.id);
        yield* publish(boardId, { _tag: "pools", pools: left });
        yield* kick;
        return left;
      }),
    );

  const setGoal: KanbanServiceShape["setGoal"] = (boardId, input) =>
    guard(
      "goal.set",
      Effect.gen(function* () {
        yield* checkText([
          ["name", input.name],
          ["now", input.now],
          ["story", input.story],
        ]);
        const goals = yield* store.goals(boardId);
        const at = yield* nowIso;
        const existing = input.id ? goals.find((goal) => goal.id === input.id) : undefined;
        if (input.id && !existing) return yield* failWith("not-found", `goal ${input.id}`);
        if (!existing && !input.name?.trim())
          return yield* failWith(
            "invalid",
            "a new goal needs a name",
            "invalid_args",
            "missing_required",
            "name",
          );
        const base: KanbanGoal = existing ?? {
          id: KanbanGoalId.make(`goal-${uuid()}`),
          boardId,
          name: input.name!.trim(),
          status: "active",
          now: null,
          story: [],
          createdAt: at,
        };
        const goal: KanbanGoal = {
          ...base,
          name: input.name?.trim() || base.name,
          status: input.status ?? base.status,
          now: input.now?.trim() ? { text: input.now.trim(), at } : base.now,
          story: input.story?.trim()
            ? [...base.story, { at, text: input.story.trim() }]
            : base.story,
        };
        yield* store.putGoal(goal);
        yield* publish(boardId, { _tag: "goal", goal });
        return goal;
      }),
    );

  const setGroups: KanbanServiceShape["setGroups"] = (boardId, groups) =>
    guard(
      "groups.set",
      Effect.gen(function* () {
        yield* checkText(
          groups.flatMap((group) => [
            ["name", group.name] as const,
            ["summary", group.summary] as const,
          ]),
        );
        const at = yield* nowIso;
        const next = groups.map((group) => ({ ...group, name: group.name.trim(), updatedAt: at }));
        yield* store.putGroups(boardId, next);
        yield* publish(boardId, { _tag: "groups", groups: next });
      }),
    );

  const createDiscussion: KanbanServiceShape["createDiscussion"] = (
    boardId,
    title,
    actor,
    blocks,
  ) =>
    guard(
      "discussion.create",
      Effect.gen(function* () {
        yield* checkText([["title", title]]);
        yield* boardOf(boardId);
        const discussion = yield* newDiscussion(boardId, title, null, actor);
        if (!blocks?.length) return discussion;
        // Opening owner blocks commit with their route, like any owner post: the
        // after-commit drain only delivers what has a route row.
        yield* postUnlocked(
          discussion.id,
          actor,
          blocks,
          actor._tag !== "owner",
          false,
          durableOwnerRoutes,
        );
        return yield* discussionOf(discussion.id);
      }),
    ).pipe(
      Effect.tap((discussion) =>
        actor._tag === "owner" && blocks?.length
          ? rawStore.message(discussion.id, discussion.lastSeq).pipe(
              Effect.flatMap((message) => (message ? routeOwnerPost(message) : Effect.void)),
              Effect.mapError(toKanbanError),
            )
          : Effect.void,
      ),
    );

  const updateDiscussion: KanbanServiceShape["updateDiscussion"] = (discussionId, patch, actor) =>
    guard(
      "discussion.update",
      Effect.gen(function* () {
        yield* checkText([["title", patch.title]]);
        if (actor._tag !== "owner") {
          return yield* failWith(
            "denied",
            "only the owner renames, settles, snoozes or pins",
            "role_not_allowed",
          );
        }
        const discussion = yield* discussionOf(discussionId);
        const at = yield* nowIso;
        let next = discussion;
        if (patch.title !== undefined) {
          const title = patch.title.trim().slice(0, DISCUSSION_TITLE_MAX);
          if (!title)
            return yield* failWith(
              "invalid",
              "a discussion needs a title",
              "invalid_args",
              "missing_required",
              "title",
            );
          next = { ...next, title, titleEditedAt: at };
        }
        if (patch.settled === true && typeof patch.snoozedUntil === "string") {
          return yield* failWith("invalid", "settle or snooze, not both");
        }
        if (
          patch.pinned === true &&
          (patch.settled === true || typeof patch.snoozedUntil === "string")
        ) {
          return yield* failWith("invalid", "pin, settle or snooze one at a time");
        }
        if (patch.pinned === true) {
          next = { ...next, pinnedAt: next.pinnedAt ?? at, settledAt: null, snoozedUntil: null };
        } else if (patch.pinned === false && next.pinnedAt !== null) {
          next = { ...next, pinnedAt: null, reopenedAt: at };
        }
        if (patch.settled === true)
          next = { ...next, settledAt: at, snoozedUntil: null, pinnedAt: null };
        else if (patch.settled === false && next.settledAt !== null) {
          next = { ...next, settledAt: null, reopenedAt: at };
        }
        if (patch.snoozedUntil === null) {
          next =
            next.snoozedUntil === null
              ? { ...next, snoozedUntil: null }
              : { ...next, snoozedUntil: null, reopenedAt: at };
        } else if (patch.snoozedUntil !== undefined) {
          const until = DateTime.make(patch.snoozedUntil);
          if (Option.isNone(until)) {
            return yield* failWith(
              "invalid",
              "snoozedUntil is not a time",
              "invalid_args",
              "bad_time",
              "snoozedUntil",
            );
          }
          if (DateTime.toEpochMillis(until.value) <= (yield* nowMillis)) {
            return yield* failWith(
              "invalid",
              "snoozedUntil must be in the future",
              "invalid_args",
              "bad_time",
              "snoozedUntil",
            );
          }
          next = {
            ...next,
            snoozedUntil: DateTime.formatIso(until.value),
            settledAt: null,
            pinnedAt: null,
          };
        }
        if (next !== discussion) yield* saveDiscussion(next);
        return next;
      }),
    );

  /**
   * The ask a pick on this message is for, when it is one of an ask's own
   * messages: its current one, or (`stale`) one from before the ask was edited.
   */
  const askPickOf = Effect.fn("KanbanService.askPickOf")(function* (
    discussionId: KanbanDiscussion["id"],
    seq: number,
    blockId: string,
  ) {
    const discussion = yield* discussionOf(discussionId);
    if (discussion.cardId === null) return null;
    const card = yield* cardOf(discussion.cardId);
    const ask = card.asks.find((entry) => entry.id === blockId);
    if (!ask) return null;
    const message = yield* store.message(discussionId, seq);
    // An ask's messages carry its id; the first of one asked before that is known by its seq.
    const own = message?.askId === ask.id || ask.seq === seq || ask.firstSeq === seq;
    const confirmation = ask.confirmation?.seq === seq;
    return own
      ? {
          card,
          ask,
          stale: confirmation
            ? ask.confirmation?.revision !== kanbanAskRevision(ask)
            : ask.seq !== seq,
        }
      : null;
  });

  const answer: KanbanServiceShape["answer"] = (discussionId, seq, blockId, choice, by, text) =>
    by._tag !== "owner"
      ? answerChoice(discussionId, seq, blockId, choice, by, text)
      : readDb(askPickOf(discussionId, seq, blockId)).pipe(
          Effect.flatMap((pick) => {
            if (pick === null) return answerChoice(discussionId, seq, blockId, choice, by, text);
            const ref = `${pick.ask.id} on card #${pick.card.number}`;
            if (pick.stale) {
              // An earlier version of the ask: answering it would answer something he no longer sees.
              return failAnswer({
                code: "conflict",
                detail: `${ref} was updated since this message (it is at revision ${kanbanAskRevision(pick.ask)} now). Nothing was answered: answer its current version.`,
                revision: kanbanAskRevision(pick.ask),
              });
            }
            if (pick.ask.closedAt !== null && pick.ask.confirmation !== undefined) {
              return failAnswer({
                code: "conflict",
                detail: `${ref} is closed. Its recorded answer cannot be changed by another pick.`,
                revision: kanbanAskRevision(pick.ask),
              });
            }
            // Older asks without confirmations retain their late discussion-reply route.
            if (pick.ask.closedAt !== null || kanbanAskIsFreeText(pick.ask)) {
              return answerChoice(discussionId, seq, blockId, choice, by, text);
            }
            const words = (text ?? "").trim();
            const message = store
              .message(discussionId, seq)
              .pipe(
                Effect.flatMap((found) =>
                  found ? Effect.succeed(found) : failWith("not-found", `message ${seq}`),
                ),
              );
            // Typed replies share the classifier used by the reply route.
            if (choice.length === 0 && words !== "") {
              return guardDeferred(
                "discussion.answer",
                replyOnAskUnlocked(
                  pick.card.id,
                  pick.ask.id,
                  by,
                  [{ _tag: "md", text: words }],
                  "owner",
                  kanbanAskRevision(pick.ask),
                ).pipe(Effect.andThen(message)),
              );
            }
            // Anything else is answered as the ask's own answer route would, checks included.
            return guardDeferred(
              "discussion.answer",
              answerAskUnlocked(
                pick.card.id,
                pick.ask.id,
                {
                  ...(pick.ask.confirmation?.seq === seq
                    ? {
                        text: pick.ask.confirmation.text,
                        note: pick.ask.confirmation.note,
                        values: pick.ask.confirmation.values,
                        finalDraft: pick.ask.confirmation.finalDraft,
                      }
                    : {}),
                  ...Asks.pickAnswer(pick.ask, choice, words),
                },
                by,
              ).pipe(Effect.andThen(message)),
            );
          }),
        );
  const answerChoice: KanbanServiceShape["answer"] = (
    discussionId,
    seq,
    blockId,
    choice,
    by,
    text,
  ) =>
    guard(
      "discussion.answer",
      Effect.gen(function* () {
        yield* checkText([["answer", text]]);
        const discussion = yield* discussionOf(discussionId);
        const message = yield* store.message(discussionId, seq);
        if (!message) return yield* failWith("not-found", `message ${seq}`);
        const block = message.blocks.find(
          (candidate): candidate is Extract<KanbanBlock, { _tag: "choice" }> =>
            candidate._tag === "choice" && candidate.id === blockId,
        );
        if (!block) return yield* failWith("not-found", `choice ${blockId}`);
        const words = (text ?? "").trim();
        if (words !== "" && block.style === "poll") {
          return yield* failWith("invalid", "a poll takes one of its options");
        }
        const picked = block.options.filter((option) => choice.includes(option.id));
        if (picked.length === 0 && words === "") {
          return yield* failWith("invalid", "pick an option or write your own answer");
        }
        if (!block.multi && picked.length + (words === "" ? 0 : 1) > 1) {
          return yield* failWith("invalid", "pick one option or write your own answer");
        }
        const key = actorKey(by);
        const previous = message.answers.find(
          (entry) => entry.blockId === blockId && actorKey(entry.by) === key,
        );
        const choiceIds = picked.map((option) => option.id);
        const same =
          previous &&
          previous.text === (words === "" ? null : words) &&
          previous.choice.length === choiceIds.length &&
          previous.choice.every((id, index) => id === choiceIds[index]);
        const at = same ? previous.at : yield* nowIso;
        const note = `Owner answered "${block.question}" in discussion ${discussion.id} (message ${seq}, block ${blockId}): ${[...picked.map((option) => option.label), ...(words === "" ? [] : [`his own answer: "${words}"`])].join(", ")} [options: ${choiceIds.join(", ")}]`;
        const answerText = words === "" ? null : words;
        // The content is part of the key: a different answer in the same millisecond
        // is a different delivery, never deduplicated as the earlier one.
        const content = NodeCrypto.createHash("sha256")
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          .update(JSON.stringify([choiceIds, answerText]))
          .digest("hex")
          .slice(0, 16);
        const routeKey = `owner-answer:${discussionId}:${seq}:${blockId}:${at}:${content}`;
        const next: KanbanMessage = {
          ...message,
          answers: [
            ...message.answers.filter(
              (entry) => !(entry.blockId === blockId && actorKey(entry.by) === key),
            ),
            {
              blockId,
              by,
              choice: picked.map((option) => option.id),
              text: words === "" ? null : words,
              at,
            },
          ],
        };
        // An owner answer commits with its routing obligation, in one transaction.
        yield* durableOwnerRoutes && by._tag === "owner"
          ? boardTransaction(
              discussion.boardId,
              saveOwnerRoute(discussion.boardId, discussionId, routeKey, {
                kind: "answer",
                seq,
                blockId,
                at,
                note,
                choice: choiceIds,
                text: answerText,
              }).pipe(Effect.andThen(store.putMessage(next))),
              `discussion:${discussionId}`,
            ).pipe(Effect.mapError(toKanbanError))
          : store.putMessage(next);
        yield* publish(discussion.boardId, { _tag: "message", message: next });
        return {
          next,
          note,
          routeKey,
          savedAnswer: { discussionId, seq, blockId, at, choice: choiceIds, text: answerText },
        };
      }),
    ).pipe(
      Effect.flatMap(({ next, note, routeKey, savedAnswer }) =>
        by._tag !== "owner"
          ? Effect.succeed(next)
          : durableOwnerRoutes
            ? afterOwnerCommit(discussionId).pipe(Effect.as(next))
            : ownerAnswerRoute(discussionId, seq, blockId, note, routeKey, savedAnswer).pipe(
                Effect.as(next),
              ),
      ),
    );

  // Null when the read is already recorded, else the discussion to save.
  const readMark = (discussion: KanbanDiscussion, actor: KanbanActor, seq: number) => {
    const key = actorKey(actor);
    const current = discussion.participants.find(
      (participant) => actorKey(participant.actor) === key,
    );
    const target = Math.min(seq, discussion.lastSeq);
    if (current && current.lastReadSeq >= target) return null;
    return withParticipant(discussion, actor, current?.name ?? OWNER_NAME, {
      lastReadSeq: target,
    });
  };

  // Opening a discussion marks it read every time. A read already recorded never queues
  // behind the board write lock or republishes the discussion.
  const markRead: KanbanServiceShape["markRead"] = Effect.fn("KanbanService.markRead")(
    function* (discussionId, actor, seq) {
      const seen = yield* readDb(discussionOf(discussionId));
      if (readMark(seen, actor, seq) === null) return;
      yield* guard(
        "discussion.markRead",
        Effect.gen(function* () {
          const next = readMark(yield* discussionOf(discussionId), actor, seq);
          if (next !== null) yield* saveDiscussion(next);
        }),
      );
    },
  );

  const markReadSoon: KanbanServiceShape["markReadSoon"] = (discussionId, actor, seq) =>
    markRead(discussionId, actor, seq).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban mark read failed", { discussionId, cause }),
      ),
      Effect.provideService(BoardLocks.writeWaitMs, BoardLocks.WRITE_WAIT_MS),
      Effect.provideService(TickTimings.current, undefined),
      SavedWrite.background,
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const wiki: KanbanServiceShape["wiki"] = Effect.fn("KanbanService.wiki")(
    function* (boardId, options) {
      if (
        (options?.section !== undefined || options?.outline === true) &&
        options?.slug === undefined
      )
        return yield* failWith(
          "invalid",
          "section and outline require slug",
          "invalid_args",
          "missing_required",
          "slug",
        );
      if (options?.section !== undefined && options?.outline === true)
        return yield* failWith(
          "invalid",
          "Pass section or outline, not both.",
          "invalid_args",
          "conflict",
          "section",
        );
      const requested = options?.slug === undefined ? options?.slugs : [options.slug];
      const selected =
        requested === undefined
          ? undefined
          : (yield* WikiReadTiming.step(
              "metadata",
              readDb(store.wikiIndex(boardId, requested)),
            )).map((page) => page.slug);
      if (selected?.length === 0) return [];
      const pages = yield* WikiReadTiming.step("body", readDb(store.wiki(boardId, selected)));
      if (options?.slug === undefined) return pages;
      const page = pages.find((page) => page.slug === options.slug);
      if (page === undefined) return [];
      if (options.outline) return [{ ...page, body: wikiOutline(page.body) }];
      if (options.section === undefined) return [page];
      const section = yield* WikiReadTiming.step(
        "section",
        Effect.sync(() => wikiSection(page.body, options.section!)),
      );
      if (!section.found)
        return yield* failWith(
          "invalid",
          `no wiki section ${options.section}; headings: ${section.headings.join(", ")}`,
          "wiki_section_unknown",
          "not_found",
          "section",
        );
      return [
        {
          ...page,
          body: section.body,
          ...(section.note === undefined ? {} : { note: section.note }),
        },
      ];
    },
  );

  const wikiIndex: KanbanServiceShape["wikiIndex"] = Effect.fn("KanbanService.wikiIndex")(
    (boardId) => WikiReadTiming.step("metadata", readDb(store.wikiIndex(boardId))),
  );

  const writeWiki: KanbanServiceShape["writeWiki"] = (boardId, page, actor) =>
    guard(
      "wiki.write",
      Effect.gen(function* () {
        if ((page.body === undefined) === (page.edits === undefined))
          return yield* failWith(
            "invalid",
            "Pass exactly one of body or edits.",
            undefined,
            "conflict",
            "body",
          );
        if (page.title !== undefined) yield* checkText([["title", page.title]]);
        yield* boardOf(boardId);
        const slug = page.slug
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        if (!slug)
          return yield* failWith(
            "invalid",
            "a wiki page needs a slug",
            "invalid_args",
            "missing_required",
            "slug",
          );
        // boardOf acquires the board's exclusive guard until this operation returns;
        // both full replacements and edits read and write under that same guard.
        const current =
          page.edits !== undefined || page.title === undefined
            ? (yield* store.wiki(boardId)).find((page) => page.slug === slug)
            : undefined;
        let body = page.body ?? current?.body ?? "";
        if (page.edits !== undefined) {
          if (current === undefined)
            return yield* failWith(
              "invalid",
              `no wiki page ${slug}; create it with body`,
              undefined,
              "not_found",
              "slug",
            );
          body = (yield* applyExactEdits([body], page.edits))[0]!;
        }
        yield* checkText([["wiki body", body]]);
        const next: KanbanWikiPage = {
          boardId,
          slug,
          title: page.title === undefined ? (current?.title ?? slug) : page.title.trim() || slug,
          body,
          updatedAt: yield* nowIso,
          updatedBy: actor,
        };
        yield* store.putWiki(next);
        return next;
      }),
    );

  // Big message blocks go out as stubs too; the chat reads the full message by seq.
  const feedChange = (change: KanbanChange): KanbanChange =>
    change._tag === "card"
      ? { ...change, card: BoardReplies.feedCard(change.card) }
      : change._tag === "message"
        ? { ...change, message: Pages.stubMessage(change.message) }
        : change._tag === "goal"
          ? { ...change, goal: BoardReplies.feedGoal(change.goal) }
          : change;

  const watch: KanbanServiceShape["watch"] = (boardId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        // The first frame comes from the boards store alone. Thread state reads the
        // orchestration store, whose reader queue held board opens for up to 14 s, so it
        // follows as thread changes. They are read after subscribing and sent before the
        // buffered live changes, so a newer live state always lands last.
        const snapshot = yield* read(
          ReplyBuilders.interactive(
            snapshotOf(boardId, true, undefined, true).pipe(NodeSqliteClient.readOnly),
          ),
        );
        const fill = Stream.fromIterable(liveThreadIds(snapshot.cards)).pipe(
          Stream.mapEffect(
            (threadId) =>
              threadState(threadId).pipe(
                NodeSqliteClient.readOnly,
                // A thread that can't be read stays unknown, like a missing one.
                Effect.orElseSucceed((): ReadonlyArray<KanbanThreadState> => []),
              ),
            { concurrency: 8 },
          ),
          Stream.flatMap(Stream.fromIterable),
          Stream.map((thread): KanbanWatchEvent => ({
            _tag: "change",
            change: { _tag: "thread", thread },
          })),
        );
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter((entry) => entry.boardId === boardId),
          Stream.map((entry): KanbanWatchEvent => ({
            _tag: "change",
            change: feedChange(entry.change),
          })),
        );
        return Stream.concat(
          Stream.succeed<KanbanWatchEvent>({
            _tag: "snapshot",
            snapshot,
          }),
          Stream.concat(fill, live),
        );
      }),
    );

  // Subscribed before the read, so no change falls between the two.
  const boardSummaries: KanbanServiceShape["boardSummaries"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const boards = yield* readDb(
        Effect.flatMap(store.boards, (all) =>
          Effect.forEach(all, (board) =>
            Effect.all({
              board: Effect.succeed(board),
              cards: store.summaryCards(board.id),
              discussions: store.discussions(board.id),
              threadIds: Effect.map(
                store.threadLinks({ boardId: board.id, open: false }),
                (links) => links.map((link) => link.threadId),
              ),
            }),
          ),
        ),
      );
      return Summaries.follow(
        Summaries.tallyBoards(boards),
        Stream.fromSubscription(subscription),
        Date.now,
        yield* readDb(store.pendingBoardPurges),
      );
    }),
  );

  /**
   * Pool keys carry the level (`instance/model#level`) since one model can run as several
   * pools. Pools stored before that are rekeyed in place (UPDATE keeps the row, so pool
   * order stays), and cards whose activePool names an old key follow. Each board's pools
   * and cards move in one transaction, so a failed write leaves that board on its old keys
   * and consistent; the next start tries again. Runs before the worker or any request; a
   * board with no stale pool costs one pools read.
   */
  const rekeyBoard = Effect.fn("KanbanService.rekeyBoard")(
    function* (board: KanbanBoard) {
      const pools = yield* store.pools(board.id);
      const moves = new Map<string, string>();
      for (const pool of pools) {
        const key = Rules.poolKey(pool.model);
        if (pool.key === key) continue;
        if (pools.some((other) => other.key === key)) {
          yield* Effect.logWarning(
            `board ${board.slug}: pool ${pool.key} can't become ${key}, taken`,
          );
          continue;
        }
        moves.set(pool.key, key);
      }
      if (moves.size === 0) return;
      const cards = (yield* store.cards(board.id))
        .filter((card) => card.activePool !== null && moves.has(card.activePool))
        .map((card) => ({ ...card, activePool: moves.get(card.activePool!)! }));
      const rekeyed = pools
        .filter((pool) => moves.has(pool.key))
        .map((pool) => ({ from: pool.key, pool: { ...pool, key: moves.get(pool.key)! } }));
      yield* store.rekeyBoard(board.id, rekeyed, cards);
      for (const card of cards) {
        if (card.activeThreadId !== null) {
          const tracked = slotState.get(board.id)?.has(card.activeThreadId) === true;
          yield* syncSlot(
            board.id,
            card.activeThreadId,
            tracked ? "pool_moved" : "restart",
            tracked ? card.id : null,
          );
        }
      }
      for (const { from, pool } of rekeyed) {
        yield* Effect.logInfo(`board ${board.slug}: pool ${from} is now ${pool.key}`);
      }
    },
    (effect, board) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`kanban pool rekey failed for board ${board.slug}`, { cause }),
        ),
      ),
  );
  yield* BoardsDatabase.onReady(
    locks
      .run(
        seedSlots().pipe(
          Effect.andThen(
            Effect.flatMap(store.boards, (boards) =>
              Effect.forEach(
                boards,
                (board) =>
                  Effect.gen(function* () {
                    yield* rekeyBoard(board);
                    const at = yield* nowIso;
                    let ended = 0;
                    for (const { link, card } of yield* store.openReviewLinks(board.id)) {
                      if (
                        card !== null &&
                        card.settledAt === null &&
                        (card.activeThreadId === link.threadId ||
                          Rules.reviewThreadToReuse(board, card) === link.threadId)
                      )
                        continue;
                      // Historical rows have no definitive release event; use repair time.
                      yield* endReviewLink(link.threadId, at, link);
                      ended++;
                    }
                    if (ended > 0)
                      yield* Effect.logInfo("kanban stale review links ended", {
                        boardId: board.id,
                        ended,
                      });
                  }),
                { discard: true },
              ),
            ),
          ),
          Effect.andThen(reconcileSlots()),
        ),
      )
      .pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const pending = yield* store.pendingBoardPurges;
            for (const boardId of new Set(pending.map((row) => row.boardId)))
              yield* finishPurge(boardId);
          }),
        ),
        Effect.andThen(loadPendingStops()),
        Effect.tapError((cause) =>
          Effect.logWarning("Board startup recovery will retry", { cause }),
        ),
        Effect.retry(Schedule.spaced("1 second")),
        Effect.andThen(Deferred.succeed(startupReady, undefined)),
      ),
  );
  // Owner routes left pending by a restart replay first; later sweeps pick up
  // any whose drain failed, leaving fresh ones to the drain their reply started.
  // Rows saved before a switch to `inline` still replay.
  {
    yield* Deferred.await(startupReady).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 7 }));
          yield* tickSql`
            DELETE FROM ardud_kanban_owner_routes WHERE done_at IS NOT NULL AND done_at < ${cutoff}
          `.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("kanban owner route prune failed", { cause }),
            ),
          );
          yield* sweepOwnerRoutes(0);
          // `await` delivers inside the reply, so only the restart replay is needed there.
          if (ownerRouteMode !== "deferred") return;
          return yield* sweepOwnerRoutes(30_000).pipe(Effect.delay("1 minute"), Effect.forever);
        }),
      ),
      Effect.provideService(BoardLocks.writeWaitMs, BoardLocks.WRITE_WAIT_MS),
      Effect.provideService(TickTimings.current, undefined),
      SavedWrite.background,
      Effect.forkIn(scope),
    );
  }

  const reconcileRunCancellationUnlocked = Effect.fn("KanbanService.reconcileRunCancellation")(
    function* (threadId: ThreadId, runId: string) {
      const key = `${threadId}:${runId}`;
      const cards = pendingCancelReasons.get(key);
      if (cards === undefined) return;
      const run = yield* locks.outside(threadIo.compactRun(threadId, runId), undefined, true);
      if (
        run === null ||
        (run.status !== "cancelled" && run.status !== "interrupted") ||
        run.cancelReason === undefined ||
        run.cancelReason === "provider_cancelled" ||
        run.cancelReason === "provider_interrupted"
      )
        return;
      // Early provider cleanup can publish a terminal before Stop commits its source.
      for (const [id, card] of cards) {
        yield* store.addCardEvent({
          cardId: id,
          at: yield* nowIso,
          actor: { _tag: "system", component: "dispatcher" },
          kind: "comment",
          fromStage: null,
          toStage: null,
          head: null,
          body: `Run ${runId} cancellation reason corrected (${run.cancelReason}${run.cancelDetail === undefined ? "" : `: ${run.cancelDetail}`})`,
        });
        cards.delete(id);
        yield* recordAnalytics({
          kind: "kanban.cancel_reason_updated",
          boardId: card.boardId,
          cardId: id,
          threadId,
          props: { runId, cancelReason: run.cancelReason },
        });
      }
      pendingCancelReasons.delete(key);
    },
  );

  const reconcileRunCancellation = (threadId: ThreadId, runId: string) =>
    serial(turnEnding, threadId, reconcileRunCancellationUnlocked(threadId, runId));

  const runJob = (job: Job) =>
    read(
      job._tag === "kick"
        ? dispatchUnlocked()
        : job._tag === "cancelReason"
          ? reconcileRunCancellation(job.threadId, job.runId)
          : turnEndedUnlocked(job.threadId, undefined, false, job.startTimeout),
    ).pipe(
      Effect.provideService(
        BoardLocks.operationName,
        job._tag === "kick"
          ? "dispatchNow"
          : job._tag === "cancelReason"
            ? "reconcileRunCancellation"
            : "turnEnded",
      ),
      NodeSqliteClient.backgroundReads,
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban job failed", { job: job._tag, cause }),
      ),
    );

  const submitEvaluator: KanbanServiceShape["submitEvaluator"] = (
    boardId,
    purpose,
    options = {},
  ) => {
    let key: string = uuid();
    let matchedCard: KanbanCard | undefined;
    const submission = guard(
      "evaluator.submit",
      evaluatorAdmission(
        boardId,
        Effect.gen(function* () {
          yield* checkText([
            ["text", options.text],
            [
              "text",
              purpose.kind === "request" || purpose.kind === "setup" ? purpose.text : undefined,
            ],
          ]);
          const board = yield* boardOf(boardId);
          if (board.archivedAt !== null)
            return yield* failWith("denied", "Board is deleted", "board_deleted");
          if (["stalled", "completed", "deployed", "check", "nightly"].includes(purpose.kind)) {
            const running = yield* runningSweep(board.id, purpose.kind);
            if (running)
              return yield* failWith(
                "conflict",
                `a ${purpose.kind} sweep is already running on this board (thread ${running})`,
              );
          }
          let card: KanbanCard | undefined;
          const reuse: EvaluatorAnalytics.ReuseObservation = { reason: "no_candidates" };
          const requestBody =
            purpose.kind === "request"
              ? [options.matchText ?? purpose.text, options.text].filter(Boolean).join("\n\n")
              : undefined;
          if (purpose.kind === "request") {
            const rawText = options.matchText ?? purpose.text;
            const links = yield* requestLinks(boardId, rawText);
            const cards = yield* openRequestCards(boardId);
            const matches = matchingCards(options.matchText ?? purpose.text, cards, links);
            card = matches.length === 1 ? matches[0] : undefined;
            if (card) {
              const source = options.callerThreadId
                ? yield* store.threadLink(options.callerThreadId)
                : null;
              const sourceCards = source ? [...(yield* store.cardsByThread(source.threadId))] : [];
              if (source?.cardId && !sourceCards.some((card) => card.id === source.cardId))
                sourceCards.push(yield* cardOf(source.cardId));
              const reporter = source
                ? { cards: sourceCards, board: yield* boardOf(source.boardId) }
                : undefined;
              const qualified = rawText.match(/(?:^|\s)([\w-]+#\d+)\b/);
              const references = requestCardReferences(rawText);
              const numeric = bugMatches(cards, rawText).find((match) => match.exact);
              const hint =
                qualified?.[1] ??
                (references.ids.length === 1
                  ? references.ids[0]
                  : numeric
                    ? `#${numeric.card.number}`
                    : undefined);
              if (references.numbers.size > 0 && hint === undefined) card = undefined;
              else
                card = bugSightingTarget(
                  rawText,
                  hint ?? card.id,
                  board,
                  yield* store.boards,
                  cards,
                  reporter,
                ).target;
            }
            if (card && !options.forceNew) {
              matchedCard = card;
              const discussion = yield* cardDiscussionUnlocked(card.id).pipe(
                SavedWrite.preparatory,
              );
              // Sightings are new evidence, like answers/verdicts/wait endings: deliver,
              // never just save an audit comment or merge them into card-less intake.
              const prior = yield* reusableEvaluator(card, reuse);
              let duplicate = false;
              const admitted = yield* admitEvaluator(
                board,
                {
                  kind: "discussion",
                  discussionId: discussion.id,
                  title: discussion.title,
                  cardNumber: card.number,
                },
                {
                  cardId: card.id,
                  text: [purpose.text, options.text].filter(Boolean).join("\n\n"),
                  key,
                  trigger: "evaluator_start",
                  reuseMissReason: reuse.reason,
                  requestBody,
                  reporterThreadId: options.callerThreadId,
                },
                {
                  actor: { _tag: "system", component: "evaluator-admission" },
                  body: `sighting from ${options.callerThreadId ?? "board"}: ${(options.matchText ?? purpose.text).slice(0, 400)}`,
                  ...(options.callerThreadId === undefined
                    ? {}
                    : { sourceThreadId: options.callerThreadId }),
                },
                {
                  at: yield* nowIso,
                  duplicateKey: key,
                  onDuplicate: (canonical) => {
                    key = canonical;
                    duplicate = true;
                  },
                },
              );
              if (!prior || duplicate) return admitted;
              return {
                matched: true as const,
                card: yield* cardOf(card.id),
                sightingAppended: true as const,
              };
            }
          }
          return yield* admitEvaluator(
            board,
            purpose,
            {
              text: options.text,
              requestBody,
              reporterThreadId: options.callerThreadId,
              forceNew: options.forceNew,
              cardId: card?.id ?? null,
              key,
              trigger: "evaluator_start",
              reuseMissReason: options.forceNew
                ? "forced_new"
                : card
                  ? reuse.reason
                  : "no_card_reuse_scope",
            },
            undefined,
            {
              at: yield* nowIso,
              duplicateKey: key,
              onDuplicate: (canonical) => {
                key = canonical;
              },
            },
          );
        }),
      ),
    );
    const recover = (saved: SavedWrite.Saved): EvaluatorSubmission | undefined =>
      saved.kind === "evaluator" && saved.key === key
        ? { threadId: saved.threadId }
        : saved.kind === "evaluatorQueue" && saved.key === key
          ? { queued: true, queueId: saved.queueId }
          : saved.kind === "card" && saved.card.id === matchedCard?.id
            ? { matched: true, card: saved.card, sightingAppended: true }
            : undefined;
    return (
      options.callerThreadId !== undefined ? SavedWrite.recover(submission, recover) : submission
    ).pipe(Effect.mapError(toKanbanError), (effect) =>
      SavedWrite.subSteps("evaluator.submit", effect, true),
    );
  };

  const startEvaluator: KanbanServiceShape["startEvaluator"] = (boardId, purpose, text) =>
    SavedWrite.recover(
      guard(
        "evaluator.start",
        Effect.gen(function* () {
          if (purpose.kind === "request") {
            const result = yield* submitEvaluator(
              boardId,
              purpose,
              text === undefined ? {} : { text },
            );
            if ("threadId" in result) return result.threadId;
            if ("matched" in result) {
              const target = yield* reusableEvaluator(result.card);
              if (target) return target;
            }
            return yield* failWith(
              "conflict",
              `Evaluator queued (${"queueId" in result ? result.queueId : 0}); it will start when a board slot is free.`,
            );
          }
          yield* checkText([
            ["text", text],
            ["text", purpose.kind === "setup" ? purpose.text : undefined],
          ]);
          const board = yield* boardOf(boardId);
          if (
            purpose.kind === "stalled" ||
            purpose.kind === "completed" ||
            purpose.kind === "deployed" ||
            purpose.kind === "check" ||
            purpose.kind === "nightly"
          ) {
            const running = yield* runningSweep(board.id, purpose.kind);
            if (running) {
              return yield* failWith(
                "conflict",
                `a ${purpose.kind} sweep is already running on this board (thread ${running}). Steer it with t3_thread_send, or hand one job to a new evaluator with kind "request" and text.`,
              );
            }
          }
          return yield* startEvaluatorUnlocked(board, purpose, {
            text,
            cardId: null,
            trigger: "evaluator_start",
          });
        }),
      ),
      (saved) => (saved.kind === "evaluator" ? saved.threadId : undefined),
    );

  const bugSightingTarget = (
    title: string,
    cardHint: string | undefined,
    board: KanbanBoard,
    boards: ReadonlyArray<KanbanBoard>,
    unsettled: ReadonlyArray<KanbanCard>,
    reporter?: { cards: ReadonlyArray<KanbanCard>; board: KanbanBoard },
  ) => {
    const open = unsettled.filter((card) => !KANBAN_DONE_STAGES.has(card.stage));
    const foreignNumbers = new Set<number>();
    for (const candidate of boards) {
      if (candidate.id === board.id) continue;
      for (const name of [candidate.id, candidate.slug, candidate.name]) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const separator = "[\\s*_\\x60\\[\\]():/\\-–—|]*";
        for (const reference of title.matchAll(
          new RegExp(
            `(?:^|[^\\p{L}\\p{N}_])${escaped}(?:${separator}\\b(?:cards?|issues?|tickets?)\\b)?${separator}#(\\d+)\\b`,
            "giu",
          ),
        ))
          foreignNumbers.add(Number(reference[1]));
      }
    }
    const hint = cardHint?.trim();
    const qualified = hint?.match(/^([^#\s]+)#(\d+)$/);
    const hintNumber = hint && /^#?\d+$/.test(hint) ? Number(hint.replace(/^#/, "")) : undefined;
    let hinted = unsettled.find((card) => card.id.toLowerCase() === hint?.toLowerCase());
    let missedHint: string | undefined;
    if (qualified) {
      const boardPart = qualified[1]!.toLowerCase();
      const hintBoard = boards.find(
        (candidate) =>
          candidate.id.toLowerCase() === boardPart || candidate.slug.toLowerCase() === boardPart,
      );
      if (hintBoard?.id === board.id) {
        hinted = unsettled.find((card) => card.number === Number(qualified[2]));
      } else {
        foreignNumbers.add(Number(qualified[2]));
        if (hintBoard) missedHint = `cardHint ${hint} names a card on another board; ignored.`;
      }
    } else if (hintNumber !== undefined) {
      const ownCard = reporter?.cards.find(
        (card) => card.boardId !== board.id && card.number === hintNumber,
      );
      if (foreignNumbers.has(hintNumber)) {
        missedHint = `cardHint ${hint} names a card on another board; ignored.`;
      } else if (ownCard && reporter) {
        foreignNumbers.add(hintNumber);
        missedHint = `cardHint #${hintNumber} is the reporter's own card on the "${reporter.board.name}" board, not a card on this board; ignored.`;
      } else {
        hinted = unsettled.find((card) => card.number === hintNumber);
      }
      if (!hinted)
        missedHint ??= `cardHint #${hintNumber} matched no unsettled card on this board.`;
    }
    if (hint && !hinted) missedHint ??= `cardHint ${hint} matched no unsettled card on this board.`;
    const missingId = hint?.toLowerCase().startsWith("card-") === true && !hinted;
    const matches = hinted
      ? []
      : bugMatches(open, title).filter(
          (match) => !match.exact || (!missingId && !foreignNumbers.has(match.card.number)),
        );
    const best = matches[0];
    const ambiguous = best && !best.exact && matches[1]?.score === best.score;
    const target = hinted ?? (best?.strong && !ambiguous ? best.card : undefined);
    return { target, hinted, matches, missedHint };
  };

  const acknowledgeSighting = Effect.fn("KanbanService.acknowledgeSighting")(function* (
    card: KanbanCard,
  ) {
    yield* resolvedContext({ boardId: card.boardId, id: card.id, number: card.number });
    yield* SavedWrite.record({ kind: "card", card });
  });

  const reportBug = Effect.fn("KanbanService.reportBug")(function* (
    input: Parameters<KanbanServiceShape["reportBug"]>[0],
  ) {
    yield* checkText([
      ["title", input.title],
      ["evidence", input.evidence],
    ]);
    const title = input.title.trim();
    const evidence = input.evidence.trim();
    if (!title || !evidence)
      return yield* failWith("invalid", "A bug report needs title and evidence.");
    const requestBody = input.cardHint?.trim()
      ? stableStringify({
          text: `${title} ${evidence}`.replace(/\s+/g, " "),
          cardHint: input.cardHint.trim().toLowerCase(),
        })
      : `${title}\n\n${evidence}`;
    const boards = yield* readDb(store.boards);
    const board = boards.find(
      (board) => board.id === input.boardId.trim() || board.slug === input.boardId.trim(),
    );
    if (!board) return yield* failWith("invalid", `No Missions board "${input.boardId}".`);
    yield* resolvedContext({ boardId: board.id });
    const source =
      input.callerUnverifiedReason === undefined
        ? yield* readDb(store.threadLink(input.threadId))
        : null;
    const reporter =
      source && (source.role === "work" || source.role === "review")
        ? yield* Effect.gen(function* () {
            const sourceBoard = yield* readDb(boardOf(source.boardId));
            const cards = [...(yield* readDb(store.cardsByThread(input.threadId)))];
            if (source.cardId && !cards.some((card) => card.id === source.cardId))
              cards.push(yield* readDb(cardOf(source.cardId)));
            return { role: source.role, board: sourceBoard, card: cards[0] ?? null, cards };
          })
        : undefined;
    let text = `${title}\n\n${evidence}`;
    if (reporter) {
      const cardPart = reporter.card
        ? `, card [#${reporter.card.number} ${reporter.card.title}](t3-context://v1/kanban-card/${reporter.card.id})`
        : "";
      text = `Handed on by a ${reporter.role} thread on the "${reporter.board.name}" board${cardPart}, thread [${input.threadId}](t3-thread://v1/${input.threadId}).\n\n${text}`;
    } else {
      text = `Reported by thread [${input.threadId}](t3-thread://v1/${input.threadId}).\n\n${text}`;
    }
    const verification =
      input.callerUnverifiedReason === undefined
        ? undefined
        : `reporter unverified (${input.callerUnverifiedReason}); callerVerified: false`;
    if (verification !== undefined) text = `${verification}\n\n${text}`;
    const body = `sighting\n\n${verification === undefined ? "" : `${verification}\n\n`}${evidence}`;
    const actor: KanbanActor = { _tag: "thread", threadId: input.threadId };
    // Recover a committed append if publishing the card change races another board write.
    let appended:
      | {
          appendedTo: string;
          deduped?: boolean;
          candidates?: Array<{ id: KanbanCardId; number: number; title: string; score: number }>;
        }
      | undefined;
    let missedHint: string | undefined;
    let appendTarget: KanbanCard | undefined;
    let appendKey: string | undefined;
    let readReruns = 0;
    const duplicateKey = uuid();
    const append: Effect.Effect<
      Effect.Success<ReturnType<KanbanServiceShape["reportBug"]>> | undefined,
      KanbanError
    > = Effect.suspend(() =>
      SavedWrite.recover(
        guard(
          "bug.report",
          Effect.gen(function* () {
            const unsettled = (yield* store.openCards(board.id)).filter(
              (card) => card.settledAt === null,
            );
            const {
              target,
              hinted,
              matches,
              missedHint: missed,
            } = bugSightingTarget(title, input.cardHint, board, boards, unsettled, reporter);
            missedHint = missed;
            if (target) {
              yield* resolvedContext(target);
              yield* SavedWrite.locateReport({
                kind: "card",
                boardId: board.id,
                cardId: target.id,
                number: target.number,
              });
            }
            const prior = target
              ? yield* duplicateRequest(
                  board.id,
                  requestBody,
                  input.threadId,
                  duplicateKey,
                  "report_bug",
                  target?.id,
                )
              : null;
            if (prior) {
              if (prior.cardId) {
                const card = yield* cardOf(KanbanCardId.make(prior.cardId));
                appendTarget = card;
                appended = { appendedTo: `#${card.number}`, deduped: true };
                yield* SavedWrite.locateReport({
                  kind: "card",
                  boardId: board.id,
                  cardId: card.id,
                  number: card.number,
                });
                yield* acknowledgeSighting(card);
                return { ...prior.result, ...appended };
              }
              return prior.result;
            }
            if (!target) return undefined;
            const candidates = matches.slice(0, 3).map(({ card, score }) => ({
              id: card.id,
              number: card.number,
              title: card.title,
              score,
            }));
            const response = { appendedTo: `#${target.number}`, ...(hinted ? {} : { candidates }) };
            const now = yield* Clock.currentTimeMillis;
            const duplicate = (yield* store.cardEvents(target.id)).some(
              (event) =>
                event.kind === "comment" &&
                event.body === body &&
                event.actor._tag === "thread" &&
                event.actor.threadId === input.threadId &&
                now - Date.parse(event.at) >= 0 &&
                now - Date.parse(event.at) < 30 * 60_000,
            );
            if (KANBAN_DONE_STAGES.has(target.stage)) {
              // Done cards retain the append-only sighting boundary.
              appendTarget = target;
              appended = duplicate ? { ...response, deduped: true } : response;
              if (duplicate) yield* acknowledgeSighting(target);
              else {
                const next = { ...target, updatedAt: yield* nowIso };
                appendTarget = next;
                yield* Effect.uninterruptible(
                  logEvent(next, actor, "comment", { body, at: next.updatedAt }).pipe(
                    Effect.andThen(SavedWrite.record({ kind: "card", card: next })),
                  ),
                );
                yield* saveCard(next);
              }
              return appended;
            }
            // A failed atomic admission must not recover an older identical comment.
            appendTarget = { ...target, updatedAt: yield* nowIso };
            appended = duplicate ? { ...response, deduped: true } : response;
            appendKey = uuid();
            const discussion = yield* cardDiscussionUnlocked(target.id).pipe(
              SavedWrite.preparatory,
            );
            const observer = yield* SavedWrite.observer;
            // An existing evidence comment can have a new title or target. Only
            // the exact full-intake duplicate check may suppress its delivery.
            // A known-card sighting is real evidence; keep it out of intake coalescing.
            yield* admitEvaluator(
              yield* boardOf(board.id),
              {
                kind: "discussion",
                discussionId: discussion.id,
                title: discussion.title,
                cardNumber: target.number,
              },
              {
                cardId: target.id,
                text,
                key: appendKey,
                trigger: "report_bug",
                requestBody,
                reporterThreadId: input.threadId,
              },
              {
                actor,
                body: duplicate ? null : body,
                at: appendTarget.updatedAt,
                onCommitted: (card) => {
                  appendTarget = card;
                  appended = duplicate ? { ...response, deduped: true } : response;
                  observer({ kind: "card", card });
                },
              },
            ).pipe(
              // Scope recovery to the report's sighting, including queued delivery.
              Effect.provideService(SavedWrite.observer, () => {}),
            );
            return appended;
          }).pipe((effect) => evaluatorAdmission(board.id, effect)),
          undefined,
          board.id,
        ),
        (saved) =>
          saved.kind === "card" && saved.card.id === appendTarget?.id ? appended : undefined,
      ),
    ).pipe(
      Effect.catchTags({
        KanbanError: (error) => {
          if (error.code !== "conflict") return Effect.fail(error);
          // Before selecting a target this step cannot have written a report.
          if (appendTarget === undefined && readReruns++ < 2) return append;
          return Effect.gen(function* () {
            const target = appendTarget;
            if (target !== undefined) {
              const events = yield* readDb(rawStore.cardEvents(target.id)).pipe(
                Effect.catchCause(() =>
                  Effect.fail(
                    new KanbanError({
                      code: "conflict",
                      saved: null,
                      detail: `Bug report outcome unavailable. Look up sighting on card #${target.number} (${target.id}). Retry with the same arguments.`,
                    }),
                  ),
                ),
              );
              const committedIntent =
                appendKey === undefined
                  ? []
                  : yield* readDb(
                      tickSql`SELECT id FROM ardud_kanban_evaluator_queue
                  WHERE board_id = ${board.id} AND card_id = ${target.id}
                  AND (job_key = ${appendKey} OR EXISTS (
                    SELECT 1 FROM json_each(json, '$.mergedKeys') WHERE value = ${appendKey}
                  )) LIMIT 1`,
                    ).pipe(
                      Effect.catchCause(() =>
                        Effect.fail(
                          new KanbanError({
                            code: "conflict",
                            saved: null,
                            detail: `Bug report outcome unavailable. Look up sighting on card #${target.number} (${target.id}). Retry with the same arguments.`,
                          }),
                        ),
                      ),
                    );
              // An atomic open-card admission also proves delivery when the evidence
              // comment already existed and the commit beat its acknowledgement.
              if (
                committedIntent.length > 0 ||
                (appendKey === undefined &&
                  events.some(
                    (event) =>
                      event.kind === "comment" &&
                      event.body === body &&
                      event.at === target.updatedAt &&
                      event.actor._tag === "thread" &&
                      event.actor.threadId === input.threadId,
                  ))
              ) {
                yield* SavedWrite.record({ kind: "card", card: target });
                return appended;
              }
            }
            return yield* Effect.fail(
              new KanbanError({
                code: "conflict",
                saved: false,
                detail: "Nothing was saved; retry with the same arguments.",
              }),
            );
          });
        },
      }),
    );
    const result = yield* append;
    if (result) return result;
    if (missedHint !== undefined) text = `${missedHint}\n\n${text}`;
    const keyPrefix = `bug-report:${NodeCrypto.createHash("sha256")
      .update(
        encodeBugReportIdentity([
          board.id,
          input.threadId,
          title,
          evidence,
          input.cardHint?.trim() ?? "",
        ]),
      )
      .digest("hex")}:`;
    yield* SavedWrite.locateReport({ kind: "evaluator", boardId: board.id, keyPrefix });
    let key = `${keyPrefix}${uuid()}`;
    // reportBug has already resolved its matches. Caller provenance in the
    // stamped text must not associate a novel report with the caller's own card.
    return yield* SavedWrite.recover(
      guard(
        "bug.report.evaluate",
        evaluatorAdmission(
          board.id,
          Effect.gen(function* () {
            const current = yield* boardOf(board.id);
            const retryWindowMs = 30 * 60_000;
            const at = yield* nowMillis;
            const bucket = Math.floor(at / retryWindowMs);
            const candidateKey = `${keyPrefix}${bucket}`;
            const since = DateTime.formatIso(DateTime.makeUnsafe(at - retryWindowMs));
            // Recover pending work across bucket boundaries and long spawn-cap waits.
            const previous =
              (yield* tickSql<EvaluatorQueueRow>`SELECT * FROM ardud_kanban_evaluator_queue
              WHERE board_id = ${board.id} AND job_key >= ${keyPrefix} AND job_key < ${`${keyPrefix}~`}
                AND (done_at IS NULL OR done_at > ${since})
              ORDER BY id DESC LIMIT 1`)[0];
            key = previous?.job_key ?? candidateKey;
            if (previous?.thread_id) {
              const threadId = ThreadId.make(previous.thread_id);
              yield* recordEvaluator(`duplicate:${duplicateKey}`, {
                boardId: board.id,
                cardId: previous.card_id,
                purposeKind: "request",
                trigger: "report_bug",
                outcome: "merged",
                threadId,
                reuseMissReason: "duplicate",
              });
              yield* SavedWrite.record({ kind: "evaluator", key, threadId });
              return { threadId };
            }
            if (
              previous !== undefined &&
              previous.started_at !== null &&
              !(yield* enqueueEvaluatorOnly)
            ) {
              // Resume the same interrupted launch and its stable reservation;
              // this retry must not create or steer a second admission.
              yield* recordEvaluator(`duplicate:${duplicateKey}`, {
                boardId: board.id,
                cardId: previous.card_id,
                purposeKind: "request",
                trigger: "report_bug",
                outcome: "merged",
                reuseMissReason: "duplicate",
              });
              yield* SavedWrite.record({ kind: "evaluatorQueue", key, queueId: previous.id });
              return yield* drainEvaluatorQueue(board.id, key);
            }
            return yield* admitEvaluator(
              current,
              { kind: "request", text },
              {
                key,
                trigger: "report_bug",
                reuseMissReason: "no_card_reuse_scope",
                requestBody,
                reporterThreadId: input.threadId,
              },
              undefined,
              {
                at: previous?.created_at ?? DateTime.formatIso(DateTime.makeUnsafe(at)),
                duplicateKey,
                onDuplicate: (canonicalKey) => {
                  key = canonicalKey;
                },
              },
            );
          }),
        ),
      ),
      (saved): EvaluatorLaunch | undefined =>
        saved.kind === "evaluator" && saved.key === key
          ? { threadId: saved.threadId }
          : saved.kind === "evaluatorQueue" && saved.key === key
            ? { queued: true, queueId: saved.queueId }
            : undefined,
    ).pipe(
      Effect.catchTags({
        KanbanError: (error) =>
          error.code === "conflict"
            ? readDb(
                tickSql<EvaluatorQueueRow>`SELECT * FROM ardud_kanban_evaluator_queue WHERE job_key = ${key}`,
              ).pipe(
                Effect.catchCause(() =>
                  Effect.fail(
                    new KanbanError({
                      code: "conflict",
                      saved: null,
                      detail: `Bug report outcome unavailable. Look up evaluator key ${key} on board ${board.slug}. Retry with the same arguments.`,
                    }),
                  ),
                ),
                Effect.flatMap((rows) => {
                  const row = rows[0];
                  if (row)
                    return Effect.succeed<EvaluatorLaunch>(
                      row.thread_id
                        ? { threadId: ThreadId.make(row.thread_id) }
                        : { queued: true, queueId: row.id },
                    );
                  return Effect.fail(
                    new KanbanError({
                      code: "conflict",
                      saved: false,
                      detail: "Nothing was saved; retry with the same arguments.",
                    }),
                  );
                }),
              )
            : Effect.fail(error),
      }),
    );
  }, Effect.mapError(toKanbanError));

  // The caller owns the retry boundary: a nested guard would turn a safe
  // conflict into a typed failure before the claim's retry loop sees it.
  const reconcileRunFailureUnlocked = Effect.fn("KanbanService.reconcileRunFailure")(function* (
    threadId: ThreadId,
  ) {
    // Discovery must not acquire a board permit; the locked read rechecks ownership.
    for (const id of yield* rawStore.threadCards(threadId)) {
      const initial = yield* rawStore.card(id);
      if (initial?.stalled?.runFailure?.threadId !== threadId) continue;
      const card = yield* store.card(id);
      const stalled = card?.stalled;
      if (
        card === null ||
        stalled?.runFailure?.threadId !== threadId ||
        stalled.by._tag !== "system" ||
        stalled.by.component !== "dispatcher" ||
        card.workThreadId !== threadId ||
        card.stage !== "todo" ||
        (card.activeThreadId !== null && card.activeThreadId !== threadId)
      )
        continue;
      const recovery = yield* freshThreads.laterStartedRun(threadId, stalled.runFailure.runId);
      if (recovery === null) continue;
      const model = recovery.model ?? (yield* freshThreads.model(threadId));
      const at = yield* nowIso;
      const next: KanbanCard = {
        ...card,
        stalled: null,
        stage: "working",
        activeThreadId: threadId,
        activeRole: "work",
        activePool: Rules.poolOf(yield* store.pools(card.boardId), model ?? card.model),
        nudgedAt: null,
        movedAt: at,
        updatedAt: at,
      };
      yield* logEvent(next, { _tag: "system", component: "dispatcher" }, "flagged", {
        fromStage: card.stage,
        toStage: "working",
        body: `Cleared run-failed stall: work resumed in ${recovery.runId}`,
      });
      yield* saveCard(next);
      yield* Effect.logInfo("restart-pacing.stall_auto_cleared", {
        cardId: id,
        threadId,
        runId: recovery.runId,
      });
    }
  }, Effect.mapError(toKanbanError));
  const reconcileRunFailure = (threadId: ThreadId) =>
    guard("card.recoverRunFailure", reconcileRunFailureUnlocked(threadId));
  return KanbanService.of({
    ready: Deferred.await(startupReady),
    boards: readDb(store.boards),
    withSelectionMigrationLock: (effect) =>
      Deferred.await(startupReady).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const changed = new Map<string, Map<string, string>>();
            // Migrations may nest transactions. Collect writes inside, then read the
            // committed result (or rollback) before giving up the exclusive permit.
            return locks
              .exclusive(
                rawStore.observeCallerWrites(effect).pipe(
                  Effect.provideService(cardWrites, (cards) => {
                    for (const card of cards) {
                      if (card.activeThreadId === null) continue;
                      const threads = changed.get(card.boardId) ?? new Map<string, string>();
                      threads.set(card.activeThreadId, card.id);
                      changed.set(card.boardId, threads);
                    }
                  }),
                  Effect.ensuring(
                    Effect.gen(function* () {
                      for (const [boardId, threads] of changed) {
                        for (const [threadId, cardId] of threads)
                          yield* syncSlot(boardId, threadId, "pool_moved", cardId);
                      }
                    }),
                  ),
                ),
              )
              .pipe(Effect.provideService(BoardLocks.operationName, "selectionMigration"));
          }),
        ),
      ),
    ensureBoard,
    openBoard,
    createBoard,
    updateBoard,
    purgeBoard,
    applyApprovedInstructions,
    applyApprovedSettings,
    standingApproval,
    revokeStandingApproval,
    setNightlyReview: Effect.fn("KanbanService.setNightlyReview")(function* (boardId, input) {
      return yield* guard(
        "board.setNightlyReview",
        Effect.gen(function* () {
          const board = yield* boardOf(boardId);
          const settings = yield* Schema.decodeUnknownEffect(KanbanNightlyReviewSettings)({
            ...board.nightlyReview,
            enabled: input.enabled,
            ...(input.timeOfDay === undefined ? {} : { timeOfDay: input.timeOfDay }),
            ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
          }).pipe(
            Effect.mapError(
              () =>
                new KanbanError({
                  code: "invalid",
                  detail: "Invalid nightly review time or time zone",
                }),
            ),
          );
          return yield* updateBoardUnlocked(boardId, { nightlyReview: settings });
        }),
      );
    }),
    nightlyTick: Effect.gen(function* () {
      for (const candidate of yield* readDb(store.boards)) {
        if (candidate.archivedAt !== null || !candidate.nightlyReview?.enabled) continue;
        yield* guard(
          "nightlyReview",
          serial(
            evaluating,
            candidate.id,
            Effect.gen(function* () {
              const board = yield* boardOf(candidate.id);
              const review = board.nightlyReview;
              if (board.archivedAt !== null || !review?.enabled) return;
              const { day, time } = nightlyLocalTime(yield* nowMillis, review.timeZone);
              if (time < review.timeOfDay || review.lastRunDay === day) return;
              if (yield* runningSweep(board.id, "nightly")) return;
              yield* admitEvaluator(
                board,
                { kind: "nightly", scheduled: true },
                { key: `${board.id}:nightly:${day}`, trigger: "nightly" },
              );
            }),
          ),
          undefined,
          candidate.id,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("nightly board review failed", { boardId: candidate.id, cause }),
          ),
        );
      }
    }),
    snapshot: (boardId) => readDb(snapshotOf(boardId)),
    replySnapshot: (boardId, page) => readDb(snapshotOf(boardId, true, page)),
    cardPage: Effect.fn("KanbanService.cardPage")(function* (input) {
      const after = input.after ?? 0;
      const requested = input.limit ?? 200;
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isSafeInteger(requested) ||
        requested < 0
      )
        return yield* failWith("invalid", "after and limit must be nonnegative integers.");
      const limit = Math.min(requested || 200, 500);
      const valid = Object.keys(KanbanCard.fields);
      const fields = input.fields ?? valid;
      if (fields.some((field) => !Object.hasOwn(KanbanCard.fields, field)))
        return yield* failWith("invalid", `fields must be KanbanCard keys: ${valid.join(",")}`);
      const keys = new Set(["id", "number", "updatedAt", ...fields]);
      const rows = yield* readDb(
        rawStore
          .cardPage(input.board, { after, limit: limit + 1, open: input.open ?? false })
          .pipe(
            Effect.flatMap((rows) =>
              keys.has("wait") ? withWaitTargets(rows) : Effect.succeed(rows),
            ),
          ),
      );
      const cards: Array<Partial<KanbanCard>> = [];
      let bytes = 0;
      for (const row of rows.slice(0, limit)) {
        const card = Object.fromEntries(Object.entries(row).filter(([key]) => keys.has(key)));
        cards.push(card);
        // @effect-diagnostics-next-line preferSchemaOverJson:off -- Count the exact wire bytes of this dynamic projection.
        bytes += Buffer.byteLength(JSON.stringify(card), "utf8");
        // Include the crossing row so even one oversized card advances the cursor.
        if (bytes > 4 * 1024 * 1024) break;
      }
      return {
        cards,
        page: {
          limit,
          hasMore: rows.length > cards.length,
          nextAfter: cards.at(-1)?.number ?? null,
        },
      };
    }),
    watch,
    boardSummaries,
    announce: (boardId, change) => Effect.asVoid(publish(boardId, change)),
    changes: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
    card: (cardId) =>
      readDb(
        Effect.gen(function* () {
          const card = yield* cardOf(cardId);
          return {
            card: (yield* withWaitTargets([card]))[0]!,
            events: yield* store.cardEvents(cardId),
            threads: yield* store.threadLinks({ cardId }),
          } satisfies CardDetail;
        }),
      ),
    activity: (boardId, window) =>
      readDb(
        Effect.gen(function* () {
          const { history, ...read } = yield* Effect.all({
            board: store.board(boardId),
            cards: store.cards(boardId),
            events: store.boardEvents(boardId, window.since, window.until),
            threads: store.threadLinks({ boardId, open: false }),
            pools: store.pools(boardId),
            slotHistory: store.slotHistory({ boardId, from: window.since, to: window.until }),
            history: store.activityHistory(boardId, window),
          });
          const readinessBefore = history.filter((event) => event.at < window.since);
          const prior = readinessBefore.filter(
            (event) => event.toStage !== null && event.fromStage !== event.toStage,
          );
          const after = history.filter((event) => event.at >= window.until);
          const dispatchCards = yield* dispatchCardPass(boardId, new Set()).read;
          const reviews = new Map<string, Rules.ReviewEvidence>();
          if (read.board)
            for (const card of dispatchCards) {
              if (card.settledAt === null && kanbanReviewAlreadyDone(card))
                reviews.set(card.id, yield* reviewEvidence(read.board, card));
            }
          return {
            ...read,
            prior,
            after,
            readinessBefore,
            dispatchCards,
            holds: yield* boardHolds(boardId),
            dispatchPools: Rules.maskDownPools(read.pools, new Set((yield* Ref.get(down)).keys())),
            reviews,
            workThreadHomes: yield* workThreadHomes(dispatchCards),
            assignmentWakeRetries: new Map(assignmentWakeRetries),
          };
        }),
      ),
    cardByNumber: (boardId, number) => readDb(store.cardByNumber(boardId, number)),
    cards: (boardId, options) =>
      readDb(
        (options?.includeSettled === false ? store.openCards(boardId) : store.cards(boardId)).pipe(
          Effect.flatMap(withWaitTargets),
        ),
      ),
    createCard,
    editCard,
    moveCard,
    restoreCutoverCard,
    flagCard,
    waitCard,
    answerWait,
    answerWaits,
    settleCard,
    markSubtask,
    handBack,
    askOwner,
    changeAsk,
    editAsk,
    answerAsk,
    replyOnAsk,
    handAsk,
    snoozeAsk,
    askSecretPlan,
    noteHandEvaluator,
    askDetail,
    askFeed,
    noteAskTiming,
    reviewResult,
    cardThread,
    setPool,
    removePool,
    setGoal,
    setGroups,
    discussions: (boardId) => readDb(store.discussions(boardId)),
    threads: (boardId) => readDb(threadRowsOf(boardId)),
    discussion: (id) => readDb(discussionOf(id).pipe(Effect.tap(captureDiscussionContext))),
    createDiscussion,
    updateDiscussion,
    cardDiscussion: Effect.fn("KanbanService.cardDiscussion")(function* (cardId) {
      const existing = yield* readDb(
        Effect.gen(function* () {
          const card = yield* cardOf(cardId);
          return card.discussionId === null ? null : yield* store.discussion(card.discussionId);
        }),
      );
      return existing ?? (yield* guard("card.discussion", cardDiscussionUnlocked(cardId)));
    }),
    messages: (id, options = {}) =>
      readDb(
        Effect.map(
          store.messages(id, {
            ...(options.afterSeq === undefined ? {} : { afterSeq: options.afterSeq }),
            ...(options.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq }),
            limit: Pages.pageLimit(
              options.limit,
              options.full ? Pages.MESSAGE_PAGE_MAX : undefined,
            ),
          }),
          (page) =>
            options.full
              ? Pages.fitNewest(page, options.maxBytes ?? Pages.AGENT_READ_BYTES)
              : Pages.listPage(page, options.maxBytes),
        ),
      ),
    message: (id, seq) =>
      readDb(
        Effect.gen(function* () {
          const message = yield* store.message(id, seq);
          if (!message) return yield* failWith("not-found", `message ${seq}`);
          return message;
        }),
      ),
    post: (discussionId, author, blocks) =>
      SavedWrite.recover(
        guardDeferred(
          "discussion.post",
          postUnlocked(
            discussionId,
            author,
            blocks,
            author._tag !== "owner" && author._tag !== "script",
            true,
            durableOwnerRoutes,
            undefined,
            undefined,
            true,
          ),
        ),
        (saved) => (saved.kind === "message" ? saved.message : undefined),
      ).pipe(Effect.tap((message) => SavedWrite.bestEffort(routeOwnerPost(message), undefined))),
    postToCard: (cardId, author, blocks) =>
      SavedWrite.recover(
        guardDeferred(
          "card.post",
          Effect.gen(function* () {
            const discussion = yield* cardDiscussionUnlocked(cardId);
            return yield* postUnlocked(
              discussion.id,
              author,
              blocks,
              author._tag !== "owner" && author._tag !== "script",
              true,
              durableOwnerRoutes,
            );
          }),
        ),
        (saved) => (saved.kind === "message" ? saved.message : undefined),
      ).pipe(Effect.tap((message) => SavedWrite.bestEffort(routeOwnerPost(message), undefined))),
    attachmentPath: (attachment) => attachments.pathOf(attachment),
    answer,
    markRead,
    markReadSoon,
    wiki,
    wikiIndex,
    writeWiki,
    endSetup: (boardId, actor) => guard("board.endSetup", endSetupUnlocked(boardId, actor)),
    pauseBoard: (boardId, pause, actor, callerAncestors = []) =>
      guard("board.pause", pauseBoardUnlocked(boardId, pause, actor, callerAncestors)),
    startSetup: (boardId, input) =>
      guard(
        "board.startSetup",
        Effect.gen(function* () {
          yield* checkText([["text", input.text]]);
          const board = yield* boardOf(boardId);
          if (board.setup?.status === "running") {
            return yield* failWith("invalid", `board ${board.slug} is already in setup`);
          }
          const evaluatorModel = withDefaultLevel(
            yield* canonicalModel(input.evaluatorModel),
            yield* canonicalModel(Defaults.DEFAULT_EVALUATOR_MODEL),
          );
          yield* checkModel(evaluatorModel);
          const saved: KanbanBoard = { ...board, evaluatorModel };
          yield* store.putBoard(saved);
          yield* publish(board.id, { _tag: "board", board: saved });
          const text = input.text?.trim() ? input.text.trim() : Defaults.DEFAULT_SETUP_TEXT;
          // startEvaluatorUnlocked opens the Setup discussion and marks setup running.
          // It returns the thread, so the discussion is read back from the board.
          yield* startEvaluatorUnlocked(saved, { kind: "setup", text }, {});
          const started = (yield* boardOf(boardId)).setup;
          if (!started) return yield* failWith("invalid", "setup did not open a Setup discussion");
          return { discussionId: started.discussionId };
        }),
      ),
    startEvaluator,
    evaluatorStatus: Effect.fn("KanbanService.evaluatorStatus")(function* (boardId, handle) {
      if ((handle.queueId === undefined) === (handle.threadId === undefined))
        return yield* failWith("invalid", "Pass exactly one of queueId or threadId.");
      return yield* readDb(
        Effect.gen(function* () {
          yield* boardOf(boardId);
          const row = (yield* tickSql<EvaluatorQueueRow>`SELECT * FROM ardud_kanban_evaluator_queue
            WHERE board_id = ${boardId} AND
              (id = ${handle.queueId ?? null} OR thread_id = ${handle.threadId ?? null})
            ORDER BY id DESC LIMIT 1`)[0];
          const threadId = row?.thread_id ?? handle.threadId;
          const link = threadId ? yield* rawStore.threadLink(threadId) : null;
          const saved =
            row !== undefined || (link?.boardId === boardId && link.role === "evaluator");
          if (!saved) return { saved: false, queued: false, cards: [] };
          // Follow persisted identities, including a duplicate appended to a
          // card created by another evaluator. Titles and live ownership can change.
          const ids = yield* tickSql<{ id: string }>`SELECT c.id FROM ardud_kanban_cards c
            WHERE c.board_id = ${boardId} AND (c.id = ${row?.card_id ?? link?.cardId ?? null} OR
              (json_extract(c.json, '$.createdBy._tag') = 'evaluator'
               AND json_extract(c.json, '$.createdBy.threadId') = ${threadId ?? null}) OR
              EXISTS (SELECT 1 FROM ardud_kanban_card_events e WHERE e.card_id = c.id
                AND (json_extract(e.json, '$.actor.threadId') = ${threadId ?? null}
                  OR json_extract(e.json, '$.sourceThreadId') = ${threadId ?? null})) OR
              EXISTS (SELECT 1 FROM ardud_kanban_messages m
                WHERE m.discussion_id = json_extract(c.json, '$.discussionId')
                AND json_extract(m.json, '$.author.threadId') = ${threadId ?? null}))
            ORDER BY c.number`;
          const cards = yield* Effect.forEach(ids, ({ id }) =>
            rawStore.card(KanbanCardId.make(id)),
          );
          return {
            saved: true,
            queued: row !== undefined && row.done_at === null,
            ...(row ? { queueId: row.id } : {}),
            ...(threadId ? { threadId: ThreadId.make(threadId) } : {}),
            cards: cards.flatMap((card) =>
              card
                ? [{ id: card.id, number: card.number, title: card.title, stage: card.stage }]
                : [],
            ),
          };
        }),
      ).pipe(Effect.mapError(toKanbanError));
    }),
    reportBug: (input) => SavedWrite.subSteps("bug.report", reportBug(input), true),
    submitEvaluator,
    resolveBoard: Effect.fn("KanbanService.resolveBoard")(function* (threadId, input) {
      return yield* readDb(
        Effect.gen(function* () {
          const boards = yield* store.boards;
          const explicit = input.boardId?.trim();
          if (explicit) {
            const board = boards.find((board) => board.id === explicit || board.slug === explicit);
            return board ?? (yield* failWith("invalid", `No Missions board "${explicit}".`));
          }
          const link = yield* store.threadLink(threadId);
          if (link) return yield* boardOf(link.boardId);
          const ids = new Set<string>();
          for (const card of yield* store.cardsByThread(threadId)) ids.add(card.boardId);
          for (const boardId of yield* store.discussionBoardIdsByEvaluator(threadId))
            ids.add(boardId);
          for (const board of boards) if (board.setup?.threadId === threadId) ids.add(board.id);
          if (input.discussionId?.trim())
            ids.add(
              (yield* discussionOf(KanbanDiscussionId.make(input.discussionId.trim()))).boardId,
            );
          const ref = input.card?.trim();
          if (ref && !/^#?\d+$/.test(ref)) ids.add((yield* cardOf(KanbanCardId.make(ref))).boardId);
          if (ids.size === 0 && ref && /^#?\d+$/.test(ref)) {
            for (const board of boards.filter((board) => board.archivedAt === null)) {
              if (yield* store.cardByNumber(board.id, Number(ref.replace(/^#/, ""))))
                ids.add(board.id);
            }
          }
          const candidates = boards.filter((board) => ids.has(board.id));
          if (candidates.length === 1) return candidates[0]!;
          const open = boards.filter((board) => board.archivedAt === null);
          if (ids.size === 0 && open.length === 1) return open[0]!;
          return yield* failWith(
            "invalid",
            `Pass boardId: this thread is not on a unique board. Candidate board ids: ${(candidates.length ? candidates : open).map((board) => board.id).join(", ") || "none"}.`,
          );
        }),
      );
    }),
    agentCall,
    ...(rawStore.callerAnalytics === undefined
      ? {}
      : { callerAnalytics: rawStore.callerAnalytics }),
    caller: (threadId) => readDb(store.threadLink(threadId)),
    carried: (threadId) => readDb(store.cardsByThread(threadId)),
    ownCards: (threadId) =>
      readDb(
        Effect.gen(function* () {
          const ids = yield* carriedIds(threadId);
          const cards = yield* Effect.forEach([...ids], (id) => store.card(KanbanCardId.make(id)));
          return cards.filter(
            (card): card is KanbanCard => card !== null && card.workThreadId === threadId,
          );
        }),
      ),
    claimCard,
    createForThread,
    nextCards,
    dispatchNow: read(dispatchUnlocked()).pipe(
      NodeSqliteClient.backgroundReads,
      Effect.provideService(BoardLocks.operationName, "dispatchNow"),
    ),
    turnEnded: (threadId, startTimeout) =>
      guard("turnEnded", turnEndedUnlocked(threadId, undefined, false, startTimeout)),
    reconcileRunCancellation: (threadId, runId) =>
      guard("reconcileRunCancellation", reconcileRunCancellation(threadId, runId)),
    notifyRunCancellation: (threadId, runId) =>
      Queue.offer(jobs, { _tag: "cancelReason", threadId, runId }).pipe(Effect.asVoid),
    tick: read(tickUnlocked()).pipe(
      NodeSqliteClient.backgroundReads,
      Effect.provideService(BoardLocks.operationName, "tick"),
    ),
    probeOutages: read(probeOutagesNow()).pipe(
      Effect.provideService(BoardLocks.operationName, "probeOutages"),
    ),
    threadEvent: (threadId) => Effect.sync(() => touch(threadId)),
    notifyTurnEnded: (threadId, startTimeout) =>
      Queue.offer(jobs, {
        _tag: "turnEnd",
        threadId,
        ...(startTimeout === undefined ? {} : { startTimeout }),
      }).pipe(Effect.asVoid),
    notifyThreadChanged: (threadId) =>
      read(
        Effect.gen(function* () {
          const link = yield* store.threadLink(threadId);
          if (!link) return;
          if (link.role === "work") yield* reconcileRunFailure(threadId);
          const view = yield* threads.view(threadId);
          if (!view) return;
          yield* publish(link.boardId, {
            _tag: "thread",
            thread: {
              threadId,
              title: view.title,
              running: view.state !== "idle" && view.state !== "needs-input",
              needsInput: view.state === "needs-input",
              lastActivityAt: view.updatedAt,
            },
          });
        }),
      ),
    worker: Stream.fromQueue(jobs).pipe(
      Stream.mapEffect(runJob, { concurrency: 8 }),
      Stream.runDrain,
      Effect.andThen(Effect.never),
    ),
  });
});

export const layer = Layer.effect(KanbanService, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
