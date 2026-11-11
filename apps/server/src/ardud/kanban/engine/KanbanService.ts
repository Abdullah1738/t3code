// @effect-diagnostics nodeBuiltinImport:off - record ids only need a random UUID.
import * as NodeCrypto from "node:crypto";
import type { ThreadManagementTerminalRunStatus } from "../../../orchestration-v2/ThreadManagementService.ts";

import {
  KANBAN_BACKLOG,
  KANBAN_DONE_STAGES,
  KANBAN_THREAD_STAGES,
  kanbanCardModels,
  kanbanEvaluatorStep,
  kanbanAskExpired,
  kanbanAskIsFreeText,
  kanbanAskRevision,
  kanbanAskTakesWords,
  kanbanNeedsOwner,
  kanbanOpenAsks,
  kanbanStepSubtasks,
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
  type KanbanBoardListEntry,
  type KanbanBoardSnapshot,
  type KanbanCard,
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
  type ModelSelection,
  type ProviderOptionSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { effortOptionId } from "@t3tools/client-runtime/ardud/models/harnessRouting";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
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
import { actorKey, KanbanStore, type KanbanStoreError } from "../store/KanbanStore.ts";
import * as BoardsDatabase from "../../persistence/BoardsDatabase.ts";
import * as AskFeed from "./askFeed.ts";
import * as Asks from "./asks.ts";
import { modelProblem } from "./modelCheck.ts";
import * as Briefs from "./briefs.ts";
import { makeBoardAttachments } from "./attachments.ts";
import * as ServerConfig from "../../../config.ts";
import * as FileSystem from "effect/FileSystem";
import * as Defaults from "./defaults.ts";
import * as Retries from "./retries.ts";
import * as Rules from "./rules.ts";
import * as Scribe from "./scribe.ts";
import * as Subtasks from "./subtasks.ts";
import { KanbanWaitPrs } from "./waitPrs.ts";
import * as Waits from "./waits.ts";
import * as Summaries from "./summaries.ts";
import * as Text from "./text.ts";
import * as Pages from "./messagePages.ts";
import * as BoardReplies from "./boardReplies.ts";
import * as ReplyBuilders from "../../http/ReplyBuilders.ts";
import { KanbanThreads, KanbanThreadError, type KanbanThreadView } from "./threads.ts";
import { KanbanModels, isListed } from "./models.ts";
import { selectionRoutingEnabled } from "./selectionSettings.ts";
import { planCutoverCardRestore, type RestoreCutoverCardInput } from "./cutoverCards.ts";
import * as BoardLocks from "./boardLocks.ts";
import * as LockedStore from "./lockedStore.ts";

/** Typing shows while an agent's turn runs; refreshed by the tick, cleared at turn end. */
const TYPING_MS = 90_000;
export const BOARD_WRITE_START_DEADLINE_MS = BoardLocks.WRITE_WAIT_MS;

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
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly prompt?: string | undefined;
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
  /** The whole plan: listed ids keep their state, open ones left out go, done ones stay. */
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

export type BoardPatch = Partial<
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
  readonly updateBoard: (
    boardId: KanbanBoard["id"],
    patch: BoardPatch,
  ) => Effect.Effect<KanbanBoard, KanbanError>;
  readonly snapshot: (
    boardId: KanbanBoard["id"],
  ) => Effect.Effect<KanbanBoardSnapshot, KanbanError>;
  readonly replySnapshot: (
    boardId: KanbanBoard["id"],
    page?: { readonly after: number; readonly limit: number },
  ) => Effect.Effect<KanbanBoardSnapshot, KanbanError>;
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
  readonly cardByNumber: (
    boardId: KanbanBoard["id"],
    number: number,
  ) => Effect.Effect<KanbanCard | null, KanbanError>;
  readonly cards: (
    boardId: KanbanBoard["id"],
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
    options?: {
      readonly note?: string | null | undefined;
      readonly question?: string | null | undefined;
    },
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
   * A message in one ask's discussion. From the owner it does not answer the
   * ask: the ask waits on its asker, who is woken to reply or fix the ask.
   * From an agent it gives the owner the turn back. The ask stays open.
   */
  readonly replyOnAsk: (
    cardId: KanbanCard["id"],
    askId: string,
    actor: KanbanActor,
    blocks: ReadonlyArray<KanbanBlock>,
    role: Rules.MoveRole,
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
  ) => Effect.Effect<KanbanCard, KanbanError>;
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
  ) => Effect.Effect<ReadonlyArray<KanbanWikiPage>, KanbanError>;
  readonly writeWiki: (
    boardId: KanbanBoard["id"],
    page: { readonly slug: string; readonly title: string; readonly body: string },
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
  /** The board link of a calling thread, or null for threads the board did not start. */
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
  /** A work thread creates a card and takes it straight away. */
  readonly createForThread: (
    threadId: ThreadId,
    input: NewCard,
  ) => Effect.Effect<ClaimResult, KanbanError>;
  /** Related todo cards a work thread could take next, with why. */
  readonly nextCards: (threadId: ThreadId) => Effect.Effect<NextCards, KanbanError>;

  /** Runs dispatch for every board now. */
  readonly dispatchNow: Effect.Effect<void, KanbanError>;
  /** Handles a finished turn of a board thread now. */
  readonly turnEnded: (threadId: ThreadId) => Effect.Effect<void, KanbanError>;
  /** Periodic upkeep: typing heartbeat, PR states, dispatch. */
  readonly tick: Effect.Effect<void, KanbanError>;
  /** Probes the models paused threads wait on and wakes them when one answers. */
  readonly probeOutages: Effect.Effect<void, KanbanError>;
  /** Queues a finished turn for the worker. */
  readonly notifyTurnEnded: (threadId: ThreadId) => Effect.Effect<void>;
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

type Job = { readonly _tag: "kick" } | { readonly _tag: "turnEnd"; readonly threadId: ThreadId };

/** A slot a work thread keeps between cards (see `holds`). */
interface Hold {
  readonly boardId: string;
  readonly pool: string;
  readonly at: number;
}

// A held slot is meant to last to the end of the thread's turn; past this a
// stuck thread gives it back.
const HOLD_MAX_MS = 30 * 60_000;
/** Thread views the wait pass reads at once, in its one read outside the gate. */
const WAIT_VIEW_READS = 8;
// An evaluator turn that has run this long is asked for a one-line status, then again every hour.
const STATUS_FIRST_MS = 45 * 60_000;
const STATUS_EVERY_MS = 60 * 60_000;
const EVALUATOR_ERRORS_TITLE = "Evaluator errors";
// A todo card whose step is only evaluator subtasks (its packet) nobody has done
// gets its evaluator woken once: a card made by an evaluator wakes nobody else.
const STEP_WAIT_P1_MS = 15 * 60_000;
const STEP_WAIT_MS = 60 * 60_000;
const waitingOnEvaluatorStep = (card: KanbanCard) =>
  card.stage === "todo" &&
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

const failWith = (code: KanbanError["code"], detail: string) =>
  Effect.fail(new KanbanError({ code, detail }));

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
    ...(input.subtasks ?? []).map((subtask) => ["subtask text", subtask.text] as const),
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

const toKanbanError = (error: unknown): KanbanError => {
  if (isKanbanError(error)) return error;
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
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return "pr";
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

const ownerDeliveryKey = Context.Reference<string | undefined>("KanbanOwnerDeliveryKey", {
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

interface OwnerRoutePost {
  readonly kind: "post";
  readonly seq: number;
  readonly createdAt: string;
  /** The discussion's title is written from this post once its route is delivered. */
  readonly writeTitle?: boolean;
}
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
  | { readonly kind: "interrupt"; readonly reason: string }
  | { readonly kind: "note"; readonly text: string };
type BoardEffect =
  | {
      readonly kind: "send";
      readonly threadId: string;
      readonly text: string;
      /** Inline only, a failed send is dropped as before; a saved one retries like any other. */
      readonly bestEffort?: boolean;
    }
  | { readonly kind: "interrupt"; readonly threadId: string; readonly reason: string }
  /**
   * A card taken off a thread that keeps other cards (drop or pause note).
   * Pending like a stop: it reaches the thread before anything the board
   * sends or attaches to it next, so it can't land after the thread takes
   * the card again.
   */
  | { readonly kind: "release"; readonly threadId: string; readonly text: string }
  /** A card's new model on its open work thread; a failed switch is retried. */
  | { readonly kind: "setModel"; readonly threadId: string; readonly model: ModelSelection }
  /** Sent only while the evaluator thread is live, as a dropped ask's note. */
  | { readonly kind: "tellEvaluator"; readonly threadId: string; readonly text: string }
  | {
      readonly kind: "toEvaluator";
      readonly discussionId: string;
      readonly text: string;
      readonly note: boolean;
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
  | { readonly kind: "syncPrs"; readonly cardId: string };
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
}
const tickKicks = Context.Reference<TickKicks | undefined>("KanbanTickKicks", {
  defaultValue: () => undefined,
});

/**
 * The asks a durable owner route answers, fixed by its first attempt. Routing
 * closes only these, so a retry never answers an ask opened after the message.
 */
const ownerRouteAsks = Context.Reference<ReadonlySet<string> | undefined>("KanbanOwnerRouteAsks", {
  defaultValue: () => undefined,
});

const make = Effect.gen(function* () {
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
  const rawStore = yield* KanbanStore;
  const boardSql = yield* BoardsDatabase.client;
  const store = LockedStore.wrap(rawStore, locks);
  const threadIo = yield* KanbanThreads;
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
  const stoppedRoutes = new Set<string>();
  const stopping = yield* Semaphore.make(1);
  // Everything the board does that sets a thread's model (a switch, a send that
  // carries a model) holds that thread's model lock, so a saved switch that read
  // an older model can never land after a newer one. Never taken under a gate.
  const modelLocks = new Map<string, Semaphore.Semaphore>();
  const withThreadModel = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      let lock = modelLocks.get(threadId);
      if (!lock) modelLocks.set(threadId, (lock = Semaphore.makeUnsafe(1)));
      return lock.withPermits(1)(effect);
    });
  const stopResource = (threadId: string) => `stops:${threadId}`;
  const addPendingStop = (threadId: string, routeKey: string, entry: PendingRelease) => {
    let stops = pendingStops.get(threadId);
    if (!stops) pendingStops.set(threadId, (stops = new Map()));
    stops.set(routeKey, entry);
  };
  const releaseOf = (effect: BoardEffect): PendingRelease | null =>
    effect.kind === "interrupt"
      ? { kind: "interrupt", reason: effect.reason }
      : effect.kind === "release"
        ? { kind: "note", text: effect.text }
        : null;
  // A failed close fails the stop like a failed interrupt: the send waiting on it fails too.
  // Notes a stop made obsolete close as `superseded`, never as delivered.
  const closeStopRows = Effect.fn("KanbanService.closeStopRows")(
    function* (keys: ReadonlyArray<string>, superseded: ReadonlyArray<string> = []) {
      const at = yield* nowIso;
      yield* boardSql.withTransaction(
        Effect.gen(function* () {
          yield* boardSql`
            UPDATE ardud_kanban_owner_routes
            SET done_at = ${at}, json = json_set(json, '$.outcome', 'delivered')
            WHERE route_key IN ${boardSql.in(keys)} AND done_at IS NULL
          `;
          if (superseded.length === 0) return;
          yield* boardSql`
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
              const notes = entries.filter(([, entry]) => entry.kind === "note");
              const superseded = stop === undefined ? [] : notes.map(([key]) => key);
              const run =
                stop?.kind === "interrupt"
                  ? threadIo.interrupt(id, stop.reason)
                  : Effect.forEach(
                      notes,
                      ([key, entry]) =>
                        entry.kind === "note"
                          ? threadIo
                              .send({ threadId: id, text: entry.text, key: `${key}:note` })
                              .pipe(
                                // A thread that is gone has nothing left to drop.
                                Effect.catchIf(
                                  (error) => error.detail === "thread not found",
                                  () => Effect.void,
                                ),
                              )
                          : Effect.void,
                      { discard: true },
                    );
              return touching(threadId, run).pipe(
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
    replayReads
      ? locks.outsideRead(`${read}:${threadId}`, () => threadFences.get(threadId) ?? 0, effect)
      : locks.outside(effect, undefined, true);
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
          touching(id, threadIo.interrupt(id, "Board state changed during launch")).pipe(
            Effect.ignore,
          ),
        ),
      ),
  );
  const threads: typeof threadIo = {
    view: (id) => threadRead("view", id, threadIo.view(id)),
    find: (id) => threadRead("find", id, threadIo.find(id)),
    model: (id) => threadRead("model", id, threadIo.model(id)),
    lastFailure: (id) => threadRead("lastFailure", id, threadIo.lastFailure(id)),
    findLastFailure: (id) => threadRead("findLastFailure", id, threadIo.findLastFailure(id)),
    latestRun: (id) => threadRead("latestRun", id, threadIo.latestRun(id)),
    compactRun: (id, run) => locks.outside(touching(id, threadIo.compactRun(id, run))),
    launch: (input) =>
      locks
        .outside(
          threadIo.launch(input).pipe(
            Effect.tap((id) => Effect.sync(() => touch(id))),
            Effect.tap((id) =>
              Effect.gen(function* () {
                (yield* ownerDelivered)?.add(id);
                // Durable before the discussion names it, so a replay never sends again
                // what this launch's first message already carried.
                const row = yield* ownerRouteRow;
                if (row !== undefined) {
                  yield* boardSql`
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
          ),
          (id) => abandonLaunch(input, id),
        )
        .pipe(Effect.tap((id) => locks.launched(id, abandonLaunch(input, id)))),
    send: (input) =>
      Effect.gen(function* () {
        const key = yield* ownerDeliveryKey;
        const delivered = yield* ownerDelivered;
        const answer = input.key === undefined;
        if (answer && delivered?.has(input.threadId)) return;
        const sent = touching(
          input.threadId,
          threadIo.send({
            ...input,
            ...(key === undefined
              ? {}
              : { key: `${key}:${input.threadId}:${input.key ?? "answer"}` }),
          }),
        );
        return yield* locks.outside(
          Effect.andThen(
            runPendingStops(input.threadId),
            // A send that carries a model sets it: ordered with model switches.
            input.model === undefined ? sent : withThreadModel(input.threadId, sent),
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (answer) delivered?.add(input.threadId);
              }),
            ),
          ),
        );
      }),
    setModel: (id, model) =>
      locks.outside(withThreadModel(id, touching(id, threadIo.setModel(id, model)))),
    // Best effort, as before, for the board's own inline stops; saved stops use `runPendingStops`.
    interrupt: (id, reason) =>
      locks.outside(touching(id, threadIo.interrupt(id, reason)).pipe(Effect.ignore)),
  };
  /** Thread reads that confirm the current run: always read, never replayed. */
  const freshThreads = {
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
    Effect.flatMap(effectSink, (sink) => {
      if (sink === undefined || sink.closed) return Effect.asVoid(inline);
      sink.effects.push({ boardId, lane, effect });
      return Effect.void;
    });
  /** A card's follow-ons run in order in its discussion's lane, or its own when it has none. */
  const cardLane = (card: KanbanCard) => card.discussionId ?? `card:${card.id}`;
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
  const routing = new Map<string, Semaphore.Semaphore>();
  const ticking = new Map<string, Semaphore.Semaphore>();
  const turnEnding = new Map<string, Semaphore.Semaphore>();
  const starting = new Map<
    string,
    { readonly cardId: string; readonly pool: string; readonly threadId: string | null }
  >();
  const settingUp = new Set<string>();
  /** Runs `effect` alone per key; it opens its own lock operations (serial: exactly one). */
  const serialEach = <A, E, R>(
    all: Map<string, Semaphore.Semaphore>,
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend(() => {
      const started = performance.now();
      let mutex = all.get(key);
      if (!mutex) {
        mutex = Semaphore.makeUnsafe(1);
        all.set(key, mutex);
      }
      return locks.outside(
        mutex.withPermits(1)(
          Effect.gen(function* () {
            // The permit wait was invisible in traces: it dominated slow owner answers.
            yield* Effect.annotateCurrentSpan("serial.wait_ms", performance.now() - started);
            return yield* locks.fresh(effect);
          }),
        ),
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
  ) => serialEach(all, key, locks.run(effect));

  const changes = yield* PubSub.unbounded<{
    readonly boardId: KanbanBoard["id"];
    readonly change: KanbanChange;
  }>();
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
      }
    >
  >(new Map());
  // Discussions that already got a fresh evaluator after a give-up, until one finishes a run cleanly.
  const replaced = yield* Ref.make<ReadonlySet<KanbanDiscussion["id"]>>(new Set());
  // Evaluator threads asked for a status: the run it was asked in and when. A new run starts over.
  const statusAsked = yield* Ref.make<
    ReadonlyMap<ThreadId, { readonly run: string; readonly at: number }>
  >(new Map());
  // Cards waiting on evaluator subtasks: the step's subtask ids, when the wait began, and whether woken.
  const stepWaits = yield* Ref.make<
    ReadonlyMap<
      KanbanCard["id"],
      { readonly key: string; readonly since: number; readonly woken: boolean }
    >
  >(new Map());
  const forgetStepWait = (cardId: KanbanCard["id"]) =>
    Ref.update(stepWaits, (all) => {
      if (!all.has(cardId)) return all;
      const next = new Map(all);
      next.delete(cardId);
      return next;
    });
  // Discussions whose owner message was already reminded: discussion id -> its lastSeq then.
  const ownerWaits = yield* Ref.make<ReadonlyMap<KanbanDiscussionId, number>>(new Map());
  const hold = (threadId: ThreadId, boardId: string, pool: string) =>
    Effect.flatMap(nowMillis, (at) =>
      Ref.update(holds, (all) => new Map(all).set(threadId, { boardId, pool, at })),
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
  const missing = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
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
  const dropHold = (threadId: ThreadId) =>
    Ref.update(holds, (all) => {
      if (!all.has(threadId)) return all;
      const next = new Map(all);
      next.delete(threadId);
      return next;
    });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const publish = (boardId: KanbanBoard["id"], change: KanbanChange) =>
    PubSub.publish(changes, { boardId, change });

  // Announced so thread lists can leave the board's threads out as they start.
  const linkThread = Effect.fn("KanbanService.linkThread")(function* (
    link: KanbanThreadLink,
    title: string,
  ) {
    yield* store.putThreadLink(link);
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
    const board = (yield* locks.access(boardId, rawStore.boards, false, "board")).find(
      (candidate) => candidate.id === boardId,
    );
    if (!board) return yield* failWith("not-found", `board ${boardId}`);
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
    const selected = {
      instanceId: match.model.instanceId,
      model: match.model.model,
      ...(match.model.options
        ? { options: match.model.options }
        : model.options
          ? { options: model.options }
          : {}),
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
    if (!card) return yield* failWith("not-found", `card ${cardId}`);
    return card;
  });

  const discussionOf = Effect.fn("KanbanService.discussionOf")(function* (
    id: KanbanDiscussion["id"],
  ) {
    const discussion = yield* store.discussion(id);
    if (!discussion) return yield* failWith("not-found", `discussion ${id}`);
    return discussion;
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
    const cards = yield* feed ? store.feedCards(boardId, page) : store.cards(boardId);
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

  // Callers hold the lock, and log a card's event before saving it: clients
  // re-read the card's history when its change is published.

  // `by` is set when a move saved the card, so a script's own move doesn't re-trigger a card.moved script.
  const saveCard = Effect.fn("KanbanService.saveCard")(function* (
    card: KanbanCard,
    by?: KanbanActor,
  ) {
    yield* store.putCard(card);
    if (card.stalled?.by._tag === "evaluator") yield* forgetStepWait(card.id);
    yield* publish(
      card.boardId,
      by === undefined ? { _tag: "card", card } : { _tag: "card", card, by },
    );
  });

  const logEvent = Effect.fn("KanbanService.logEvent")(function* (
    card: KanbanCard,
    actor: KanbanActor,
    kind: KanbanCardEvent["kind"],
    extra: {
      readonly fromStage?: KanbanStage | null;
      readonly toStage?: KanbanStage | null;
      readonly body?: string | null;
      readonly head?: string | null;
    } = {},
  ) {
    return yield* store.addCardEvent({
      cardId: card.id,
      at: yield* nowIso,
      actor,
      kind,
      fromStage: extra.fromStage ?? null,
      toStage: extra.toStage ?? null,
      body: extra.body ?? null,
      head: extra.head ?? null,
    });
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
    ({ ...card, activeThreadId: null, activeRole: null, activePool: null }) satisfies KanbanCard;

  // Logged when a card leaves a thread that got too long; a repeat inside an hour is flagged.
  const FRESH_START = "Thread too long; the next run starts on a fresh thread";
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
    boardId: KanbanBoardId,
  ) {
    let latest: KanbanCardEvent | undefined;
    for (const candidate of yield* store.cards(boardId)) {
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
    /** Set to pause the card instead of dropping it: when it comes back. */
    until: string | null = null,
  ) {
    const threadId = card.activeThreadId;
    if (threadId === null) return false;
    const others =
      card.activeRole === "work"
        ? (yield* store.cardsByThread(threadId)).filter((other) => other.id !== card.id)
        : [];
    if (bySelf) {
      if (card.activeRole === "work" && others.length === 0 && card.activePool !== null) {
        yield* hold(threadId, card.boardId, card.activePool);
      }
      return others.length > 0;
    }
    if (others.length === 0) {
      const reason = `Card #${card.number} ${what}`;
      yield* later(
        card.boardId,
        cardLane(card),
        { kind: "interrupt", threadId, reason },
        threads.interrupt(threadId, reason),
      );
      return false;
    }
    const text =
      until !== null
        ? Briefs.pauseCardText(card, what, until, others)
        : Briefs.dropCardText(card, what, others);
    yield* later(
      card.boardId,
      cardLane(card),
      { kind: "release", threadId, text },
      threads.send({ threadId, text }).pipe(Effect.ignore),
    );
    return true;
  });

  const moveUnlocked = Effect.fn("KanbanService.moveUnlocked")(function* (
    card: KanbanCard,
    to: KanbanStage,
    role: Rules.MoveRole,
    actor: KanbanActor,
    options: {
      readonly note?: string | null | undefined;
      readonly question?: string | null | undefined;
    } = {},
  ) {
    const check = Rules.checkMove(role, card, to);
    if (!check.ok) return yield* failWith("denied", check.reason);
    const at = yield* nowIso;
    const leaving = card.activeThreadId !== null && !KANBAN_THREAD_STAGES.includes(to);
    const bySelf = role === "cardThread";
    // A card waiting on the owner comes back to its thread with the answer.
    const kept = !leaving
      ? false
      : to === "needs_owner"
        ? yield* letGo(card, bySelf, "waits on the owner's answer", "with the answer")
        : yield* letGo(card, bySelf, `moved to ${to}`);
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
      ...Retries.withoutRetries(base),
      stage: to,
      movedAt: at,
      updatedAt: at,
      question: to === "needs_owner" ? (asked ?? card.question) : null,
      reviewStep: card.stage === "working" && to === "needs_review" ? 0 : card.reviewStep,
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
      const texts = workerDropped.map((ask) => Asks.droppedText(next, ask, actor._tag === "owner"));
      next = { ...next, wakeNote: [next.wakeNote, ...texts].filter(Boolean).join("\n\n") };
    }
    yield* logEvent(next, actor, "moved", {
      fromStage: card.stage,
      toStage: to,
      body: options.note ?? null,
    });
    yield* saveCard(next, actor);
    for (const ask of dropped) {
      if (ask.by._tag !== "evaluator") continue;
      const evaluator = ask.by.threadId;
      const text = Asks.droppedText(next, ask, actor._tag === "owner");
      yield* later(
        next.boardId,
        cardLane(next),
        { kind: "tellEvaluator", threadId: evaluator, text },
        Effect.gen(function* () {
          if (!(yield* liveEvaluator(evaluator))) return;
          yield* threads.send({ threadId: evaluator, text }).pipe(Effect.ignore);
        }),
      );
    }
    yield* kick;
    return next;
  });

  /**
   * Copies the work thread's tracked PRs (same source as the sidebar) onto the
   * card. A thread that carried several cards attaches PRs per card itself, so
   * then only the states of PRs already on the card are refreshed.
   */
  const syncPrs = Effect.fn("KanbanService.syncPrs")(function* (
    card: KanbanCard,
    canSave?: () => Effect.Effect<boolean>,
  ) {
    if (card.workThreadId === null) return card;
    const view = yield* threads.view(card.workThreadId);
    if (!view || view.prs.length === 0) return card;
    const at = yield* nowIso;
    const solo = (yield* store.threadCards(card.workThreadId)).every((id) => id === card.id);
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
      if (!pr || link.state === pr.state) return link;
      changed = true;
      return { ...link, state: pr.state, checkedAt: at };
    });
    if (!changed) return card;
    if (canSave && !(yield* canSave())) return card;
    const next = { ...card, links, updatedAt: at };
    yield* saveCard(next);
    return next;
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
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  const scribeActor: KanbanActor = { _tag: "system", component: "scribe" };
  // The board's "Goal ideas" discussion: the newest open one the scribe made.
  const ideasDiscussion = Effect.fn("KanbanService.ideasDiscussion")(function* (
    boardId: KanbanBoardId,
  ) {
    const all = yield* store.discussions(boardId);
    return (
      all
        .filter(
          (entry) =>
            entry.cardId === null &&
            entry.archivedAt === null &&
            entry.createdBy._tag === "system" &&
            entry.createdBy.component === "scribe",
        )
        .at(-1) ?? null
    );
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

  const saveDiscussion = Effect.fn("KanbanService.saveDiscussion")(function* (
    discussion: KanbanDiscussion,
  ) {
    const next =
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
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const newDiscussion = Effect.fn("KanbanService.newDiscussion")(function* (
    boardId: KanbanBoard["id"],
    title: string,
    cardId: KanbanCard["id"] | null,
    actor: KanbanActor,
  ) {
    const at = yield* nowIso;
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
    const discussion = actor._tag === "evaluator" ? adoptEvaluator(opened, actor) : opened;
    yield* saveDiscussion(discussion);
    return discussion;
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
    yield* saveCard({ ...card, discussionId: discussion.id });
    return discussion;
  });

  const typingUntil = DateTime.now.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.add(now, { milliseconds: TYPING_MS }))),
  );

  /**
   * Delivers text to an agent on behalf of a discussion and marks it as owing a
   * reply. A `note` (the board telling an evaluator its step came) owes none.
   */
  const deliver = Effect.fn("KanbanService.deliver")(function* (
    discussion: KanbanDiscussion,
    actor: KanbanActor,
    name: string,
    threadId: ThreadId,
    text: string,
    note = false,
  ) {
    yield* threads.send({ threadId, text });
    const next = withParticipant(
      discussion,
      actor,
      name,
      note
        ? {}
        : { lastReadSeq: discussion.lastSeq, typingUntil: yield* typingUntil, owes: "asked" },
    );
    yield* saveDiscussion(next);
    return next;
  });

  const launchEvaluator = Effect.fn("KanbanService.startEvaluatorUnlocked")(function* (
    board: KanbanBoard,
    purpose: Briefs.EvaluatorPurpose,
    extra: { readonly text?: string | undefined; readonly cardId?: KanbanCard["id"] | null } = {},
  ) {
    if (board.defaultProjectId === null) {
      return yield* failWith("invalid", `board ${board.slug} has no default project`);
    }
    if (purpose.kind === "setup" && board.setup?.status === "running") {
      return yield* failWith("invalid", `board ${board.slug} is already in setup`);
    }
    const at = yield* nowIso;
    const launchKey = uuid();
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
    const brief = Briefs.evaluatorBrief(board, purpose);
    const title = Briefs.evaluatorTitle(purpose);
    const launchInput = (key: string) => ({
      key: `${board.id}:eval:${Briefs.purposeKey(purpose)}:${key}`,
      projectId: board.defaultProjectId!,
      title,
      model: board.evaluatorModel,
      text: extra.text ? `${brief}\n\n${extra.text}` : brief,
    });
    const routeKey = (yield* ownerRouteRow) === undefined ? undefined : yield* ownerDeliveryKey;
    let threadId: ThreadId | undefined;
    if (routeKey === undefined) {
      threadId = yield* threads.launch(launchInput(launchKey));
    } else {
      // A durable owner route launches under a stable key, so a replay after a
      // restart gets the evaluator it already started instead of a second one.
      // A launch the board abandoned has an ended link; the next attempt is fresh.
      for (let attempt = 0; threadId === undefined; attempt += 1) {
        if (attempt >= 8) {
          return yield* failWith("failed", "evaluator launch was abandoned 8 times");
        }
        const launched = yield* threads.launch(launchInput(`${routeKey}:${attempt}`));
        const link = yield* rawStore.threadLink(launched);
        if (link === null || link.endedAt === null) threadId = launched;
        // The ended link is written before its interrupt; a restart between the two
        // leaves the abandoned evaluator running. It must be seen stopped before the
        // next one starts with the same instruction; otherwise the route retries.
        else {
          yield* threads.interrupt(launched, "Board state changed during launch");
          const run = yield* threads.latestRun(launched).pipe(Effect.mapError(toKanbanError));
          if (run !== null && !FINISHED_RUN_STATUSES.has(run.status)) {
            return yield* failWith("failed", `abandoned evaluator ${launched} is still running`);
          }
        }
      }
    }
    if (threadId === undefined) return yield* failWith("failed", "evaluator launch gave no thread");
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
            : (setupDiscussion?.id ?? null),
        model: board.evaluatorModel,
        startedAt: at,
        endedAt: null,
        paused: null,
      },
      title,
    );
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

  const startEvaluatorUnlocked = (
    board: KanbanBoard,
    purpose: Briefs.EvaluatorPurpose,
    extra: { readonly text?: string | undefined; readonly cardId?: KanbanCard["id"] | null } = {},
  ) =>
    serial(
      evaluating,
      `${board.id}:${Briefs.purposeKey(purpose)}`,
      Effect.gen(function* () {
        const current = yield* boardOf(board.id);
        if (["stalled", "completed", "deployed", "check"].includes(purpose.kind)) {
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
            if (extra.text) yield* threads.send({ threadId: link.threadId, text: extra.text });
            return link.threadId;
          }
        }
        if (purpose.kind === "setup") settingUp.add(board.id);
        return yield* launchEvaluator(current, purpose, extra).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (purpose.kind === "setup") settingUp.delete(board.id);
            }),
          ),
        );
      }),
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
      return yield* failWith("denied", "only the owner or the setup evaluator ends setup");
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
      return yield* failWith("denied", "only the owner or an evaluator pauses a board");
    }
    for (const id of callerAncestors) {
      const link = yield* store.threadLink(id);
      if (link?.role === "work" || link?.role === "review") {
        return yield* failWith(
          "denied",
          "Only evaluators use this tool, not card threads or their children.",
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
      if (link.role !== "evaluator" || link.purpose !== kind || link.discussionId !== null)
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
      if (!(yield* liveEvaluator(ask.by.threadId))) continue;
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

  /**
   * The discussion's evaluator gets the text: an existing one is steered,
   * otherwise one starts. A `note` owes no reply in the discussion.
   */
  const routeEvaluator = Effect.fn("KanbanService.toEvaluator")(function* (
    discussion: KanbanDiscussion,
    text: string,
    note = false,
  ) {
    const actorOf = (threadId: ThreadId): KanbanActor => ({ _tag: "evaluator", threadId });
    if (discussion.evaluatorThreadId !== null) {
      const view = yield* threads.view(discussion.evaluatorThreadId);
      if (view && !view.archived) {
        return yield* deliver(
          discussion,
          actorOf(discussion.evaluatorThreadId),
          "Evaluator",
          discussion.evaluatorThreadId,
          text,
          note,
        );
      }
      if (view) {
        yield* threads.interrupt(
          discussion.evaluatorThreadId,
          `Replaced as evaluator of "${discussion.title}"`,
        );
      }
    }
    const board = yield* boardOf(discussion.boardId);
    const card = discussion.cardId ? yield* store.card(discussion.cardId) : null;
    // One evaluator per card discussion: the evaluators that asked on the card
    // hear it is handed over, and stop typing there.
    const priors = card ? yield* liveEvaluatorAskers(card) : [];
    const threadId = yield* startEvaluatorUnlocked(
      board,
      {
        kind: "discussion",
        discussionId: discussion.id,
        title: discussion.title,
        cardNumber: card?.number ?? null,
      },
      {
        text: priors.length > 0 ? `${text}\n\n${Briefs.priorAskerText(priors)}` : text,
        cardId: discussion.cardId,
      },
    );
    let next = withParticipant(
      { ...discussion, evaluatorThreadId: threadId },
      actorOf(threadId),
      "Evaluator",
      note
        ? { lastReadSeq: discussion.lastSeq }
        : { lastReadSeq: discussion.lastSeq, typingUntil: yield* typingUntil, owes: "asked" },
    );
    if (card) {
      for (const priorId of priors) {
        const handoff = Briefs.cardHandoffText(card.number, discussion.id, threadId);
        yield* threads
          .send({ threadId: priorId, text: handoff, key: `handoff:${threadId}:${priorId}` })
          .pipe(Effect.ignore);
        const prior = actorOf(priorId);
        if (next.participants.some((p) => actorKey(p.actor) === actorKey(prior))) {
          next = withParticipant(next, prior, "Evaluator", { typingUntil: null, owes: null });
        }
      }
    }
    yield* saveDiscussion(next);
    yield* locks.attached(threadId);
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
    return next;
  });

  const toEvaluator = (discussion: KanbanDiscussion, text: string, note = false) =>
    serial(
      routing,
      discussion.id,
      Effect.gen(function* () {
        let current = yield* discussionOf(discussion.id);
        if (
          current.evaluatorThreadId !== null &&
          (yield* Ref.get(evaluatorFailures)).get(current.evaluatorThreadId)?.state === "gone"
        ) {
          current = yield* saveDiscussion({ ...current, evaluatorThreadId: null });
        }
        return yield* routeEvaluator(current, text, note);
      }),
    );

  /** A board note to the card's discussion evaluator; a failed note never breaks the caller. */
  const noteDiscussion = (card: KanbanCard, text: string) =>
    cardDiscussionUnlocked(card.id).pipe(
      Effect.flatMap((discussion) => toEvaluator(discussion, text, true)),
      Effect.asVoid,
    );

  /** The move that put a card in needs_owner: who asked, and where the card was. */
  const askedBy = Effect.fn("KanbanService.askedBy")(function* (card: KanbanCard) {
    const events = yield* store.cardEvents(card.id);
    return events.findLast((event) => event.kind === "moved" && event.toStage === "needs_owner");
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
    kanbanEvaluatorStep(card) &&
    card.activeThreadId === null &&
    card.settledAt === null &&
    ((card.stage === "todo" && card.wakeNote === null) ||
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
  const evaluatorTurnStrict = Effect.fn("KanbanService.evaluatorTurn")(function* (
    before: KanbanCard | null,
    after: KanbanCard,
    actor: KanbanActor,
  ) {
    const turn = stepTurn;
    const now = turn(after);
    if (now === null) return;
    if (before !== null && now === turn(before)) return;
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
        yield* threads.send({ threadId: link.threadId, text });
        return;
      }
      yield* startEvaluatorUnlocked(yield* boardOf(after.boardId), { kind: "packets" }, { text });
      return;
    }
    const discussion = yield* cardDiscussionUnlocked(after.id);
    yield* toEvaluator(discussion, text, true);
  });
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
      const asked = yield* askedBy(card);
      const asker = Asks.openBlockingAsk(card)?.by ?? asked?.actor;
      const back = asked?.fromStage ?? "todo";
      // A card asked about mid-review reruns its step; one whose chain already
      // passed was only waiting (on its PRs or the evaluator) and goes back to
      // waiting, so the last reviewer isn't woken for a step it cleared.
      const reviewed =
        back === "in_review" &&
        Rules.reviewFinished(
          card,
          Rules.chainFor(yield* boardOf(card.boardId), card)?.steps.length ?? 1,
        );
      const stage =
        back === "working" ? "todo" : back === "in_review" && !reviewed ? "needs_review" : back;
      const workThread = card.workThreadId;
      const wake =
        workThread !== null &&
        stage === "todo" &&
        (asker?._tag !== "evaluator" ||
          answered.some((ask) => ask.by._tag === "thread" && ask.by.threadId === workThread));
      next = {
        ...next,
        stage,
        question: null,
        stalled: null,
        wakeNote: wake ? text : next.wakeNote,
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
    // Saved before anyone is told: the card's new state never waits on a thread.
    if (next !== card) yield* saveCard(next);
    const notice: AnsweredNotice = {
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
          effect: { kind: "tellAnswered", ...notice },
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
  const tellAnswered = Effect.fn("KanbanService.tellAnswered")(function* (
    notice: AnsweredNotice,
    discussion: KanbanDiscussion,
    card: KanbanCard,
  ) {
    const { text, note, answeredBy } = notice;
    let current = discussion;
    const told = new Set<string>(notice.told);
    if (notice.unblockEvaluator !== null && !told.has(notice.unblockEvaluator)) {
      const threadId = ThreadId.make(notice.unblockEvaluator);
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
      const by = ask.by;
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
  });

  /**
   * Owner (or script) text in a discussion reaches whoever owns it. On a
   * card, an owner reply answers its open asks (see `answerAsks`), and the
   * card's live thread hears it too. Otherwise it goes to the card's live
   * thread, else the discussion's evaluator. A pick passes `pick`: only those
   * asks are answered, and the live thread hears it only when nobody did. A
   * script post never sends a waiting card back to work.
   */
  const routeToOwnerAgent = Effect.fn("KanbanService.routeToOwnerAgent")(function* (
    discussion: KanbanDiscussion,
    text: string,
    from: "owner" | "script" = "owner",
    pick?: (ask: KanbanOwnerAsk) => boolean,
    /** When the owner wrote it: asks raised later are not what he replied to. */
    asOf?: string,
  ) {
    let current = discussion;
    if (current.cardId !== null) {
      let card = yield* cardOf(current.cardId);
      let told = new Set<string>();
      if (from === "owner" && kanbanNeedsOwner(card)) {
        const frozen = yield* ownerRouteAsks;
        const nowMs = yield* nowMillis;
        // Words answer only asks that take words alone. One with a verdict, a pick,
        // fields, a draft or a task is answered through the ask, where it is checked.
        const which = (ask: KanbanOwnerAsk) =>
          (pick === undefined || pick(ask)) &&
          (frozen === undefined || frozen.has(ask.id)) &&
          Asks.takesReply(ask, nowMs);
        const left = kanbanOpenAsks(card).filter(
          (ask) =>
            (pick === undefined || pick(ask)) &&
            !Asks.takesReply(ask, nowMs) &&
            // One asked after he wrote this was never what he replied to.
            (asOf === undefined || ask.at <= asOf),
        );
        // Whoever hears his words is told they did not answer those asks.
        if (left.length > 0) text = `${text}\n\n${Asks.wordsOnlyNote(card, left, nowMs)}`;
        const result = yield* answerAsks(current, card, text, which);
        ({ told, discussion: current, card } = result);
        // They stay open and wait on their askers, as after a reply on the ask itself.
        const at = yield* nowIso;
        const waiting = left
          .filter((ask) => !kanbanAskExpired(ask, nowMs))
          .reduce((next, ask) => Asks.markClarify(next, ask.id, at), card);
        if (waiting !== card) {
          card = { ...waiting, updatedAt: at };
          yield* saveCard(card);
        }
        // Each one's asker hears it: itself when live, else the discussion's evaluator.
        for (const ask of left) {
          const by = ask.by;
          const live =
            by._tag === "thread"
              ? by.threadId === card.activeThreadId
              : by._tag === "evaluator" && (yield* liveEvaluator(by.threadId));
          if (live && (by._tag === "thread" || by._tag === "evaluator")) {
            if (told.has(by.threadId)) continue;
            const name =
              by._tag === "evaluator" ? "Evaluator" : roleName(card.activeRole ?? "work");
            current = yield* deliver(current, by, name, by.threadId, text);
            told.add(by.threadId);
          } else if (current.evaluatorThreadId === null || !told.has(current.evaluatorThreadId)) {
            current = yield* toEvaluator(current, text);
            if (current.evaluatorThreadId !== null) told.add(current.evaluatorThreadId);
          }
        }
      }
      if (pick && told.size > 0) return;
      if (card.activeThreadId !== null && card.activeRole !== null) {
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
    yield* toEvaluator(current, text);
  });

  const ownerDeliveries = new Map<string, Set<string>>();
  /** A durable route row a delivery attempt works for (see `deliverOwnerRoute`). */
  interface SavedOwnerRow {
    readonly id: number;
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
    readonly discussion_id: string;
    readonly json: string;
    readonly launched: string;
    readonly noticed: number;
    readonly done_at: string | null;
  }
  const markOwnerRouteDone = Effect.fn("KanbanService.markOwnerRouteDone")(
    function* (id: number, outcome: string) {
      const at = yield* nowIso;
      yield* boardSql`
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
      yield* boardSql`
        INSERT INTO ardud_kanban_owner_routes (route_key, board_id, discussion_id, json, created_at)
        VALUES (${key}, ${boardId}, ${discussionId}, ${json}, ${at})
        ON CONFLICT (route_key) DO NOTHING
      `;
    },
    (effect) => effect.pipe(Effect.mapError(toKanbanError)),
  );
  const routeRetainingAskers = <E>(
    discussionId: KanbanDiscussion["id"],
    key: string,
    text: string,
    route: Effect.Effect<unknown, E>,
    askId?: string,
    row?: SavedOwnerRow,
  ) =>
    Effect.gen(function* () {
      const initial = yield* rawStore.discussion(discussionId);
      const card = initial?.cardId ? yield* rawStore.card(initial.cardId) : null;
      const specific = card?.asks.find((ask) => ask.id === askId);
      const recorded = row?.askers ?? null;
      const nowMs = yield* nowMillis;
      const asks = recorded
        ? (card?.asks ?? []).filter((ask) => recorded.ids.includes(ask.id))
        : specific
          ? [specific]
          : card
            ? // A reply in words answers only the asks that take words alone.
              kanbanOpenAsks(card).filter((ask) => Asks.takesReply(ask, nowMs))
            : [];
      const needsOwner = recorded ? recorded.needsOwner : card?.stage === "needs_owner";
      if (row !== undefined && recorded === null) {
        // Routing closes these asks. A replay after a restart must still tell
        // the same askers, so they are fixed before the first attempt runs.
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const askers = JSON.stringify({ ids: asks.map((ask) => ask.id), needsOwner });
        yield* boardSql`
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
    }).pipe(Effect.mapError(toKanbanError));
  const ownerPostRoute = Effect.fn("KanbanService.ownerPostRoute")(
    function* (message: KanbanMessage, key: string, row?: SavedOwnerRow) {
      const initial = yield* discussionOf(message.discussionId);
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
          );
        }),
        undefined,
        row,
      );
    },
    (effect) => effect.pipe(Effect.mapError(toKanbanError)),
  );
  const routeOwnerPost = (message: KanbanMessage) =>
    message.author._tag !== "owner"
      ? Effect.void
      : durableOwnerRoutes
        ? afterOwnerCommit(message.discussionId)
        : ownerPostRoute(message, `owner-post:${message.discussionId}:${message.seq}`);
  const ownerPostKey = (message: Pick<KanbanMessage, "discussionId" | "seq" | "createdAt">) =>
    `owner-post:${message.discussionId}:${message.seq}:${message.createdAt}`;

  /** A pick or written answer on a choice block reaches whoever asked it. */
  const ownerAnswerRoute = (
    discussionId: KanbanDiscussion["id"],
    seq: number,
    blockId: string,
    note: string,
    key: string,
    row?: SavedOwnerRow,
  ) =>
    routeRetainingAskers(
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
          // Already answered or dropped: its asker hears the late pick, and nothing else closes.
          const by = ask.by;
          if (by._tag === "thread" && by.threadId === card.activeThreadId) {
            yield* deliver(discussion, by, roleName(card.activeRole ?? "work"), by.threadId, note);
          } else if (by._tag === "evaluator" && (yield* liveEvaluator(by.threadId))) {
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
        if (!waiting && (author._tag === "thread" || author._tag === "evaluator")) {
          if (yield* liveEvaluator(author.threadId)) {
            yield* deliver(discussion, author, message.authorName, author.threadId, note);
            return;
          }
        }
        yield* routeToOwnerAgent(discussion, note);
      }),
      blockId,
      row,
    );

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
      case "send":
        return threads.send({
          threadId: ThreadId.make(effect.threadId),
          text: effect.text,
          key: "effect",
        });
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
          yield* toEvaluator(discussion, effect.text, effect.note);
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
      runBoardEffect(effect, record.route_key),
      row,
    );
    return yield* markOwnerRouteDelivered(record);
  });
  /** A pending or given-up notice: in the lane's discussion, or on the card for a card lane. */
  const routeNotice = (lane: string, text: string) =>
    lane.startsWith("card:")
      ? locks
          .fresh(
            locks.run(
              Effect.gen(function* () {
                const card = yield* store.card(KanbanCardId.make(lane.slice("card:".length)));
                if (card === null) return;
                yield* logEvent(card, { _tag: "system", component: "owner-delivery" }, "comment", {
                  body: text,
                });
              }),
            ),
          )
          .pipe(Effect.asVoid)
      : ownerDeliveryNotice(KanbanDiscussionId.make(lane), text);
  const routeWhat = (record: OwnerRouteRecord) => {
    const payload = ownerRoutePayload(record);
    return payload.kind === "effect" ? `Board follow-up (${payload.effect.kind})` : "Owner message";
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
    yield* boardSql.withTransaction(
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
    // Registered before the thread's stop resource moves: a dispatch that saw
    // the old value is stale on its return; one that sees the new value finds
    // the stop pending and runs it before its send.
    for (const [threadId, routeKey, entry] of stops) addPendingStop(threadId, routeKey, entry);
    for (const [threadId, , , boardId] of stops) {
      yield* locks.access(boardId, Effect.void, true, stopResource(threadId));
    }
    return lanes;
  });
  /** After a restart, stops saved and not yet run hold their threads' sends again. */
  const loadPendingStops = Effect.fn("KanbanService.loadPendingStops")(function* () {
    const rows = yield* boardSql<{
      route_key: string;
      thread_id: string;
      kind: string;
      reason: string | null;
      text: string | null;
    }>`
      SELECT route_key,
             json_extract(json, '$.effect.threadId') AS thread_id,
             json_extract(json, '$.effect.kind') AS kind,
             json_extract(json, '$.effect.reason') AS reason,
             json_extract(json, '$.effect.text') AS text
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
          ? { kind: "note", text: row.text ?? "" }
          : { kind: "interrupt", reason: row.reason ?? "" },
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
    if (payload.kind === "effect") return yield* runEffectRoute(record, payload.effect);
    const discussionId = KanbanDiscussionId.make(record.discussion_id);
    // Checked before the attempt and again inside its board operation (see `routeSavedOwner`).
    const check = (read: typeof rawStore.message) =>
      read(discussionId, payload.seq).pipe(
        Effect.map((message): OwnerRouteClosed | null => {
          if (payload.kind === "post") {
            return message === null ||
              message.author._tag !== "owner" ||
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
    yield* ownerAnswerRoute(
      discussionId,
      payload.seq,
      payload.blockId,
      payload.note,
      record.route_key,
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
    boardSql<OwnerRouteRecord>`
      SELECT id, route_key, discussion_id, json, launched, noticed, done_at
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
          yield* boardSql`UPDATE ardud_kanban_owner_routes SET noticed = 1 WHERE id = ${id}`.pipe(
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
        yield* boardSql`
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
    boardSql<{ id: number }>`
      SELECT id FROM ardud_kanban_owner_routes WHERE id = ${record.id} AND done_at IS NULL
    `.pipe(Effect.map((rows) => rows.length > 0));
  const closeGivenUpStop = (record: OwnerRouteRecord, threadId: string) =>
    locks.outside(
      stopping.withPermits(1)(
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* boardSql`
            UPDATE ardud_kanban_owner_routes
            SET done_at = ${at}, json = json_set(json, '$.outcome', 'undeliverable')
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
        const rows = yield* boardSql<{ id: number }>`
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
      const pending = yield* boardSql<{ discussion_id: string }>`
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
    /** Commit an owner post with its routing obligation (see `saveOwnerRoute`). */
    saveRoute = false,
    /** The ask whose discussion the message belongs to. */
    askId?: string,
  ) {
    yield* checkText(messageTextFields(blocks));
    if (blocks.length === 0)
      return yield* failWith("invalid", "a message needs at least one block");
    const discussion = yield* discussionOf(discussionId);
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
        if (sameBlocks) return last;
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
    };
    const writeTitle = author._tag === "owner" && (yield* wantsWrittenTitle(discussion));
    const durablePost = saveRoute && author._tag === "owner";
    // An owner post commits with its routing obligation: no drain ever sees one without the other.
    yield* (
      durablePost
        ? boardSql.withTransaction(
            saveOwnerRoute(discussion.boardId, discussionId, ownerPostKey(message), {
              kind: "post",
              seq: message.seq,
              createdAt: message.createdAt,
              writeTitle,
            }).pipe(Effect.andThen(store.putMessage(message))),
          )
        : store.putMessage(message)
    ).pipe(
      Effect.mapError(toKanbanError),
      Effect.onError(() => attachments.release(claim.claimedPaths)),
    );
    // A board discussion with no evaluator yet belongs to the first one that
    // speaks in it. Card discussions keep starting their own, which knows the card.
    const owned =
      author._tag === "evaluator" && discussion.cardId === null
        ? adoptEvaluator(discussion, author)
        : discussion;
    // Someone else speaking brings a settled or snoozed discussion back, like a thread waking.
    const woken =
      author._tag === "owner" ? owned : { ...owned, settledAt: null, snoozedUntil: null };
    const posted = withParticipant(
      { ...woken, lastSeq: message.seq, lastMessageAt: at },
      author,
      authorName,
      {
        lastReadSeq: message.seq,
        typingUntil: null,
        owes: null,
      },
    );
    yield* saveDiscussion(posted);
    yield* publish(discussion.boardId, { _tag: "message", message });

    const text = blocksText(storedBlocks, attachments.pathOf);
    if (!route) {
      // A durable owner post's title follows its delivery (see `runOwnerRoute`).
      if (writeTitle && !durablePost) yield* forkDiscussionTitle(discussion.id, text);
      return message;
    }
    if (author._tag === "owner") {
      yield* routeToOwnerAgent(posted, Briefs.ownerMessageText(posted.title, posted.id, text));
    } else if (author._tag === "script") {
      yield* routeToOwnerAgent(
        posted,
        `Script "${authorName}" posted in "${posted.title}" (discussion ${posted.id}):\n\n${text}`,
        "script",
      );
    } else if (author._tag === "evaluator" && posted.cardId !== null) {
      // An evaluator in a card discussion speaks to the card's live thread too.
      const card = yield* cardOf(posted.cardId);
      if (card.activeThreadId !== null && card.activeThreadId !== author.threadId) {
        const threadId = card.activeThreadId;
        const relay = `Evaluator in the discussion of card #${card.number} (${posted.id}):\n\n${text}`;
        yield* later(
          posted.boardId,
          posted.id,
          { kind: "send", threadId, text: relay },
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
        { kind: "toEvaluator", discussionId: posted.id, text: question, note: true },
        toEvaluator(posted, question, true).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("kanban worker question routing failed", { cardId: card.id, cause }),
          ),
        ),
      );
    }
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
    for (const initial of yield* store.discussions(board.id)) {
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

  /** A finished turn settles the agent's typing and, once, nudges an unanswered discussion. */
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
    if (!participant) return;
    if (discussion.settledAt !== null || discussion.archivedAt !== null) return;
    if (participant.owes === "asked") {
      const link = yield* store.threadLink(threadId);
      const board = yield* boardOf(discussion.boardId);
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
          return;
        }
      }
      const sent = yield* threads
        .send({
          threadId,
          text: Briefs.nudgeDiscussionText(discussion.id),
          ...(participant.deferred
            ? {
                key: `discussion:${participant.deferredKey ?? `${discussion.id}:${threadId}:${participant.lastReadSeq}`}`,
              }
            : {}),
        })
        .pipe(Effect.result);
      if (Result.isFailure(sent)) {
        if (participant.deferred && sent.failure.rejected) {
          yield* saveDiscussion(
            withParticipant(discussion, participant.actor, participant.name, {
              deferredKey: NodeCrypto.randomUUID(),
            }),
          );
        }
        if (retry || participant.deferred) return;
      }
      yield* saveDiscussion(
        withParticipant(discussion, participant.actor, participant.name, {
          owes: "nudged",
          typingUntil: yield* typingUntil,
        }),
      );
      return;
    }
    if (participant.typingUntil !== null || participant.owes !== null) {
      yield* saveDiscussion(
        withParticipant(discussion, participant.actor, participant.name, {
          owes: null,
          typingUntil: null,
        }),
      );
    }
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
      yield* settleParticipant(discussion, threadId, true);
      return true;
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
    yield* settleParticipant(discussion, threadId);
    return attempted;
  });

  /**
   * Runs as the card's own operation (see dispatchUnlocked), so only a change to
   * this card or to the board itself invalidates it, not writes to other cards.
   */
  const startCard = Effect.fn("KanbanService.startCard")(function* (
    boardId: KanbanBoard["id"],
    dispatch: Rules.Dispatch,
    planned: KanbanCard,
    downKeys: ReadonlySet<string>,
  ) {
    const board = yield* boardOf(boardId);
    if (settingUp.has(board.id)) return;
    const card = yield* cardOf(dispatch.cardId);
    // The plan came from an earlier snapshot: confirm it before any side effect.
    const confirmed = Rules.confirmDispatch(
      board,
      planned,
      yield* store.cards(board.id),
      Rules.maskDownPools(yield* store.pools(board.id), downKeys),
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
      yield* saveCard(next);
      return;
    }
    const refused = modelProblem(yield* providerRegistry.getProviders, dispatch.model);
    if (refused !== null) {
      const reason = `Model refused: ${refused}`;
      const next = { ...card, stalled: { reason, by: system, at }, updatedAt: at };
      yield* logEvent(next, system, "flagged", { body: reason });
      yield* saveCard(next);
      yield* noteDiscussion(card, Briefs.modelRefusedText(card, refused)).pipe(
        Effect.catchCause((cause) => Effect.logWarning("kanban model note failed", { cause })),
      );
      return;
    }
    const goal = yield* goalOf(card);
    // A fresh start leaves the old work thread to its cards in another pool.
    const existing = dispatch.fresh
      ? null
      : dispatch.role === "work"
        ? card.workThreadId
        : card.reviewThreadId;
    let threadId: ThreadId | null = null;
    if (existing !== null) {
      // Do not mistake a failed projection read for a missing work thread.
      const existingRead =
        dispatch.role === "work" ? yield* Effect.result(threads.find(existing)) : null;
      if (existingRead?._tag === "Failure") return;
      const view = existingRead === null ? yield* threads.view(existing) : existingRead.success;
      const compactEvent =
        dispatch.role === "work" ? yield* threadCompacting(existing, board.id) : undefined;
      if (dispatch.joins && !view) {
        // The thread holding the slot is gone: the card stops pointing at it,
        // so the next pass gives it a slot of its own instead of joining again.
        yield* dropHold(existing);
        yield* saveCard({ ...card, workThreadId: null, updatedAt: at });
        yield* kick;
        return;
      }
      // A turn still finishing (for example the one that called card_move) gets
      // the next message only after it ends; the next pass retries. A thread
      // that holds the slot for other cards is steered right away.
      if (view && view.state !== "idle") {
        // A batch can plan several joins before its first card starts. If that
        // first card is waiting for compaction, none may queue behind it.
        const waitingForCompact =
          dispatch.joins &&
          dispatch.role === "work" &&
          compactEvent !== undefined &&
          (yield* store.cardsByThread(existing)).length === 0;
        if (!dispatch.joins || waitingForCompact) return;
      }
      if (view?.state === "idle" && compactEvent !== undefined) {
        const compactRunId = compactEvent.body?.match(/\[compact-run ([^\]]+)\]$/)?.[1];
        const latest = yield* Effect.result(
          compactRunId === undefined
            ? threads.latestRun(existing)
            : threads.compactRun(existing, compactRunId),
        );
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
            movedAt: at,
            updatedAt: at,
          };
          yield* logEvent(fresh, system, "moved", {
            fromStage: card.stage,
            toStage: "todo",
            body: `${FRESH_START}: compaction failed`,
          });
          yield* saveCard(fresh);
          yield* kick;
          return;
        }
      }
      if (view) {
        threadId = existing;
        // The reused thread now runs on this model; its link must say so, or an
        // outage would be read against the old model's pool.
        const reused = yield* store.threadLink(existing);
        if (
          reused &&
          Rules.poolKey(reused.model ?? board.evaluatorModel) !== Rules.poolKey(dispatch.model)
        ) {
          yield* store.putThreadLink({ ...reused, model: dispatch.model });
        }
      }
      if (!view && dispatch.role === "work") {
        // Its old thread is gone, so a block by that thread's work counts again.
        const byId = new Map((yield* store.cards(card.boardId)).map((c) => [c.id as string, c]));
        if (Rules.isBlocked(card, byId, null)) {
          yield* saveCard({ ...card, workThreadId: null, updatedAt: at });
          return;
        }
      }
    }
    const synced = dispatch.role === "review" ? yield* syncPrs(card) : card;
    let text: string;
    if (dispatch.role === "work") {
      text = threadId ? Briefs.wakeText(synced) : Briefs.workBrief(board, synced, goal);
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
      text = Briefs.reviewBrief(
        board,
        synced,
        goal,
        Rules.chainFor(board, synced),
        findings,
        threadId === null,
      );
    }
    if (threadId) {
      const reused = threadId;
      const key = wakeKey(reused, `${card.id}:${at}`);
      // A stop saved for this thread while the assignment is out (another card
      // let go of it) makes this assignment stale: it is abandoned rather than
      // committed and then cut by that stop (see `saveEffectRows`).
      yield* locks.access(board.id, Effect.void, false, stopResource(reused));
      yield* locks.outside(
        Effect.andThen(
          runPendingStops(reused),
          withThreadModel(
            reused,
            touching(reused, threadIo.send({ threadId: reused, text, model: dispatch.model, key })),
          ),
        ),
        () =>
          touching(
            reused,
            threadIo.send({
              threadId: reused,
              key: `${key}:state-changed`,
              text: `The board changed while assigning card #${card.number}. Re-read card_get before acting on that assignment; keep working on your other cards.`,
            }),
          ).pipe(Effect.asVoid, Effect.ignore),
      );
    } else {
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
    }
    if (dispatch.role === "work") {
      yield* store.addThreadCard(threadId, card.id, at);
      yield* dropHold(threadId);
    }
    const to: KanbanStage = dispatch.role === "work" ? "working" : "in_review";
    const next: KanbanCard = {
      ...synced,
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
    yield* logEvent(next, system, "moved", { fromStage: card.stage, toStage: to });
    yield* saveCard(next);
    yield* locks.attached(threadId);
  });

  const dispatchUnlocked = Effect.fn("KanbanService.dispatchUnlocked")(function* () {
    yield* Ref.set(kickPending, false);
    const random = yield* Random.Random;
    const pick = (count: number) => Math.floor(random.nextDoubleUnsafe() * count);
    yield* seedDown;
    const downKeys = new Set((yield* Ref.get(down)).keys());
    yield* locks.outside(
      Effect.forEach(
        yield* store.boards,
        (candidate) =>
          serialEach(
            dispatching,
            candidate.id,
            Effect.gen(function* () {
              // Plan from one snapshot, then start each card as its own card-scoped
              // operation. One board-wide operation across every start's thread I/O
              // went stale on any write to any card of a busy board: the start was
              // abandoned after its prompt went out, and the rest of the plan never ran.
              const planned = yield* locks.run(
                Effect.gen(function* () {
                  const board = yield* boardOf(candidate.id);
                  if (board.archivedAt !== null || settingUp.has(board.id)) return null;
                  const cards = yield* store.cards(board.id);
                  const plan = Rules.planDispatch(
                    board,
                    cards,
                    Rules.maskDownPools(yield* store.pools(board.id), downKeys),
                    yield* boardHolds(board.id),
                    pick,
                    // The real time: a waiting retry's backoff and the aging of
                    // waiting cards are measured against it.
                    yield* nowMillis,
                  );
                  return { boardId: board.id, cards, plan };
                }),
              );
              if (planned === null) return;
              const byId = new Map(planned.cards.map((card) => [card.id as string, card]));
              for (const dispatch of planned.plan) {
                const card = byId.get(dispatch.cardId);
                if (!card) continue;
                const key = `${planned.boardId}:${dispatch.cardId}`;
                starting.set(key, {
                  cardId: card.id,
                  pool: dispatch.pool,
                  threadId: dispatch.joins ? card.workThreadId : null,
                });
                yield* locks
                  .run(startCard(planned.boardId, dispatch, card, downKeys), card.id)
                  .pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        starting.delete(key);
                      }),
                    ),
                    Effect.catchCause((cause) =>
                      Effect.logWarning("kanban dispatch failed", {
                        cardId: dispatch.cardId,
                        cause,
                      }),
                    ),
                  );
              }
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("kanban board dispatch failed", { boardId: candidate.id, cause }),
            ),
          ),
        { concurrency: 8, discard: true },
      ),
    );
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
      // Only a thread that still owns its work and isn't already running again.
      let live = link.role === "evaluator";
      if (link.role === "work") live = (yield* store.cardsByThread(link.threadId)).length > 0;
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
          key: wakeKey(link.threadId, link.paused.at),
        })
        .pipe(
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

  const wakeRecovered = Effect.fn("KanbanService.wakeRecovered")(function* (board: KanbanBoard) {
    const recovered = yield* Ref.get(recoveredThreads);
    if (recovered.size === 0) return;
    for (const { link } of yield* pausedLinks) {
      if (link.boardId !== board.id || link.paused === null || !recovered.has(link.threadId))
        continue;
      const carried = yield* store.cardsByThread(link.threadId);
      if (carried.length === 0) {
        yield* store.putThreadLink({ ...link, paused: null });
        yield* Ref.update(recoveredThreads, (map) => {
          const next = new Map(map);
          next.delete(link.threadId);
          return next;
        });
        continue;
      }
      if (board.pause && carried.some((card) => !board.pause!.keep.includes(card.id))) continue;
      if ((yield* Ref.get(down)).has(linkKey(link, board))) continue;
      const found = yield* Effect.result(threads.find(link.threadId));
      if (Result.isFailure(found)) continue;
      const view = found.success;
      if (view !== null && !view.archived && view.state === "idle") {
        const sent = yield* threads
          .send({ threadId: link.threadId, text: Briefs.providerBackText(link.paused.message) })
          .pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          );
        if (!sent) continue;
      }
      yield* store.putThreadLink({ ...link, paused: null });
    }
  });

  /** A stopped worker hears about its cards still in Working, every time. nudgedAt records the last nudge instead of a card event, so a looping worker can't flood the history. */
  const nudgeWorker = Effect.fn("KanbanService.nudgeWorker")(function* (
    threadId: ThreadId,
    cards: ReadonlyArray<KanbanCard>,
  ) {
    const board = cards[0] ? yield* boardOf(cards[0].boardId) : null;
    // A batched thread may carry both kept and held cards. Do not start it for a
    // kept sibling while another card it owns is held.
    const carried = board?.pause ? yield* store.cardsByThread(threadId) : cards;
    if (board?.pause && carried.some((card) => !board.pause!.keep.includes(card.id))) {
      yield* Ref.update(deferredNudges, (set) => new Set(set).add(threadId));
      return;
    }
    const nudge = cards.filter(
      (card) =>
        card.stage === "working" &&
        card.stalled === null &&
        (!board?.pause || board.pause.keep.includes(card.id)),
    );
    if (
      nudge.length === 0 &&
      cards.some((card) => card.stage === "working" && card.stalled === null)
    ) {
      yield* Ref.update(deferredNudges, (set) => new Set(set).add(threadId));
    }
    if (nudge.length === 0) return;
    yield* Ref.update(deferredNudges, (set) => {
      const next = new Set(set);
      next.delete(threadId);
      return next;
    });
    const at = yield* nowIso;
    yield* threads.send({ threadId, text: Briefs.nudgeWorkText(nudge) }).pipe(Effect.ignore);
    for (const card of nudge) yield* saveCard({ ...card, nudgedAt: at, updatedAt: at });
  });

  /** A reviewer whose turn ended with no verdict: nudged once, then flagged and its slot freed. */
  const reviewerStopped = Effect.fn("KanbanService.reviewerStopped")(function* (
    card: KanbanCard,
    threadId: ThreadId,
  ) {
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
    if (card.nudgedAt === null) {
      yield* threads.send({ threadId, text: Briefs.nudgeReviewText(card) }).pipe(Effect.ignore);
      yield* saveCard({ ...card, nudgedAt: at, updatedAt: at });
      return;
    }
    // A reviewer that still has no verdict after the nudge frees its slot. The first
    // time the review is started again once (see Retries); the second time it is flagged.
    const reason = Retries.NO_VERDICT_REASON;
    const retry = Retries.decideRetry({
      kind: "no_verdict",
      role: "review",
      retries: card.retries,
      paused: Retries.heldByPause(board, card),
      nowMs: Date.parse(at),
      at,
    });
    if (retry._tag === "hold" || retry._tag === "wait") return;
    if (retry._tag === "restart") {
      const again: KanbanCard = {
        ...release(card),
        stage: "needs_review",
        stalled: null,
        nudgedAt: null,
        retries: retry.retries,
        movedAt: at,
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
      movedAt: at,
      updatedAt: at,
    };
    yield* logEvent(next, system, "flagged", {
      fromStage: card.stage,
      toStage: next.stage,
      body: reason,
    });
    yield* saveCard(next);
    yield* kick;
  });

  const wakeBoardNudges = Effect.fn("KanbanService.wakeBoardNudges")(function* (
    board: KanbanBoard,
    discussionWakes: ReadonlySet<ThreadId>,
  ) {
    const deferred = yield* Ref.get(deferredNudges);
    if (deferred.size === 0) return;
    const cards = yield* store.cards(board.id);
    for (const threadId of deferred) {
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
      const foundFailure = yield* Effect.result(threads.findLastFailure(threadId));
      if (Result.isFailure(foundFailure)) {
        yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
        continue;
      }
      if (foundFailure.success !== null) {
        yield* turnEndedUnlocked(threadId, undefined, true);
        continue;
      }
      const view = yield* threads.view(threadId);
      if (!view || view.state !== "idle" || Rules.waitingOnBackground(view, yield* nowMillis))
        continue;
      const review = carried.find((card) => card.activeRole === "review");
      if (review) yield* reviewerStopped(review, threadId);
      else yield* nudgeWorker(threadId, carried);
    }
  });

  // The persisted deferral belongs to the participant even after its card is released.
  const wakeDiscussionNudges = Effect.fn("KanbanService.wakeDiscussionNudges")(function* (
    board: KanbanBoard,
  ) {
    const wakes = new Set<ThreadId>();
    for (const initial of yield* store.discussions(board.id)) {
      if (initial.settledAt !== null || initial.archivedAt !== null) continue;
      for (const entry of initial.participants) {
        if (entry.actor._tag !== "thread" || !entry.deferred || entry.owes !== "asked") continue;
        const threadId = entry.actor.threadId;
        if ((yield* Ref.get(unresolvedTurnEnds)).has(threadId)) continue;
        if (wakes.has(threadId)) continue;
        const discussion = yield* store.discussion(initial.id);
        if (!discussion || discussion.settledAt !== null || discussion.archivedAt !== null)
          continue;
        const participant = discussion.participants.find(
          (candidate) => candidate.actor._tag === "thread" && candidate.actor.threadId === threadId,
        );
        if (!participant?.deferred || participant.owes !== "asked") continue;
        const link = yield* store.threadLink(threadId);
        if (!link || link.boardId !== board.id || link.paused) continue;
        const carried = yield* store.cardsByThread(threadId);
        if (discussionHeld(board, discussion, link, carried)) continue;
        if (!(yield* isHome(discussion, threadId))) {
          yield* saveDiscussion(
            withParticipant(discussion, participant.actor, participant.name, {
              owes: null,
              typingUntil: null,
            }),
          );
          continue;
        }
        const view = yield* threads.view(threadId);
        if (
          !view ||
          view.archived ||
          view.state !== "idle" ||
          Rules.waitingOnBackground(view, yield* nowMillis)
        )
          continue;
        const failure = yield* Effect.result(threads.findLastFailure(threadId));
        if (Result.isFailure(failure) || failure.success !== null) {
          if (Result.isSuccess(failure)) yield* turnEndedUnlocked(threadId, undefined, true);
          wakes.add(threadId);
          continue;
        }
        // An attempted eligible reminder takes precedence over a work nudge, even
        // when the send is refused and must be retried on the next tick.
        wakes.add(threadId);
        yield* settleParticipant(discussion, threadId, true);
        const updated = yield* store.discussion(discussion.id);
        const stillAsked = updated?.participants.some(
          (candidate) =>
            candidate.actor._tag === "thread" &&
            candidate.actor.threadId === threadId &&
            candidate.owes === "asked",
        );
        if (!stillAsked) {
          yield* Ref.update(deferredNudges, (set) => {
            const next = new Set(set);
            next.delete(threadId);
            return next;
          });
        }
      }
    }
    return wakes;
  });

  /**
   * An evaluator failed twice (or ran out of context): it is given up. Its discussions
   * get a fresh evaluator once; a one-shot evaluator is handed to its card or reported.
   */
  const evaluatorGiveUp = Effect.fn("KanbanService.evaluatorGiveUp")(function* (
    link: KanbanThreadLink,
    message: string,
  ) {
    const threadId = link.threadId;
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
        const fresh = !(yield* Ref.get(replaced)).has(home.id);
        yield* postUnlocked(
          home.id,
          actor,
          [{ _tag: "md", text: Briefs.evaluatorGoneText(message, fresh) }],
          false,
        );
        const cleared = { ...(yield* discussionOf(home.id)), evaluatorThreadId: null };
        if (fresh) {
          yield* Ref.update(replaced, (all) => new Set(all).add(home.id));
          yield* toEvaluator(cleared, Briefs.evaluatorTakeoverText(threadId, message));
        } else {
          yield* saveDiscussion(cleared);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban evaluator give-up failed", { threadId, cause }),
        ),
      );
    }
    if (homes.length > 0) return;
    yield* Effect.gen(function* () {
      const card = link.cardId !== null ? yield* store.card(link.cardId) : null;
      if (card) {
        yield* noteDiscussion(card, Briefs.evaluatorTakeoverText(threadId, message));
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
        [{ _tag: "md", text: Briefs.evaluatorLostText(title, threadId, message) }],
        false,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban evaluator give-up failed", { threadId, cause }),
      ),
    );
  });

  const finishTurn = Effect.fn("KanbanService.turnEndedUnlocked")(function* (
    threadId: ThreadId,
    expectedFailedWorkRunId?: string,
    fromTick = false,
  ) {
    const link = yield* store.threadLink(threadId);
    if (!link) return;
    const at = yield* nowIso;
    // Every board-thread turn end is announced, so the Threads view rereads the run
    // as finished even when the dispatcher leaves the card as it is (a worker that
    // moved to needs_owner, a one-shot evaluator, and so on).
    // The turn has ended, so the run is not running: the provider's view can lag this event.
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
    let card = link.cardId ? yield* store.card(link.cardId) : null;
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
      const other = id === card?.id ? card : yield* store.card(id);
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
    const outage = failure !== null && Rules.isOutage(failure) ? failure : null;
    if (outage !== null) {
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
        } else if (participant?.deferred && participant.owes === "asked") {
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
      if (entry !== undefined || Rules.isContextFull(failure)) {
        yield* evaluatorGiveUp(link, failure.message);
        return;
      }
      const dueAt = (yield* nowMillis) + Rules.EVALUATOR_RETRY_MS;
      yield* Ref.update(evaluatorFailures, (all) =>
        new Map(all).set(threadId, {
          dueAt,
          message: failure.message,
          state: "retry",
          runId: failure.runId ?? null,
        }),
      );
      return;
    }
    const system: KanbanActor = { _tag: "system", component: "dispatcher" };
    if (link.role === "work") {
      // The turn is over, so a slot held for a next card is free again.
      if ((yield* Ref.get(holds)).has(threadId)) {
        yield* dropHold(threadId);
        yield* kick;
      }
      const carried = yield* Effect.forEach(yield* store.cardsByThread(threadId), (entry) =>
        syncPrs(entry, expectedFailedWorkRunId === undefined ? undefined : failedRunIsCurrent),
      );
      if (carried.length === 0) {
        yield* kick;
        return;
      }
      // Paused: the card keeps its thread until probeOutages wakes it.
      if (outage !== null) return;
      if (failure !== null) {
        const reason = `Run failed: ${failure.message}`;
        const hasCurrentCarriedWork = Effect.fn("KanbanService.hasCurrentCarriedWork")(
          function* () {
            if (!(yield* failedRunIsCurrent())) return false;
            let eligible = false;
            for (const entry of carried) {
              const current = yield* store.card(entry.id);
              if (
                current !== null &&
                current.stage === "working" &&
                current.activeRole === "work" &&
                current.activeThreadId === threadId &&
                current.stalled === null
              )
                eligible = true;
            }
            return eligible && (yield* failedRunIsCurrent());
          },
        );
        const recentCompactions = yield* Effect.forEach(carried, (entry) =>
          compactedRecently(entry, at),
        );
        const hasRecentCompaction = recentCompactions.some(Boolean);
        const candidates =
          Rules.isContextFull(failure) && !Rules.isHandoffBudget(failure) && !hasRecentCompaction
            ? yield* Effect.filter(carried, (entry) =>
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
        for (const oldEntry of carried) {
          let entry = oldEntry;
          if (expectedFailedWorkRunId !== undefined) {
            const current = yield* store.card(entry.id);
            if (
              current === null ||
              current.stage !== "working" ||
              current.activeRole !== "work" ||
              current.activeThreadId !== threadId ||
              current.stalled !== null
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
              movedAt: at,
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
              current.stalled !== null
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
              movedAt: at,
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
                  movedAt: at,
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
            Effect.catchCause((cause) => Effect.logWarning("kanban run note failed", { cause })),
          );
        }
        yield* kick;
        return;
      }
      // A card can't sit in Working while its worker is stopped: every quiet
      // turn end nudges it (see nudgeWorker).
      const view = yield* threads.view(threadId);
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
        const fresh: KanbanCard = {
          ...release(card),
          stage: "needs_review",
          reviewThreadId: null,
          stalled: null,
          nudgedAt: null,
          movedAt: at,
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
        movedAt: at,
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
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("kanban run note failed", { cause })));
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

  const turnEndedUnlocked = (threadId: ThreadId, runId?: string, retry = false) =>
    serial(turnEnding, threadId, finishTurn(threadId, runId, retry));

  /** Everything a tick does before it dispatches. Dispatch kicks are held (see `tickKicks`). */
  const tickSteps = Effect.fn("KanbanService.tickSteps")(function* () {
    const now = yield* nowMillis;
    for (const threadId of yield* Ref.get(unresolvedTurnEnds)) {
      yield* turnEndedUnlocked(threadId, undefined, true);
    }
    // This is planning data only. A failed read must remain distinct from a
    // successful absence, and nothing survives this invocation of the tick.
    const makeViews = () => {
      const views = new Map<ThreadId, KanbanThreadView | null>();
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
        freshFind(threadId).pipe(
          Effect.tap((found) =>
            Effect.sync(() => {
              if (Option.isSome(found)) views.set(threadId, found.value);
            }),
          ),
        );
      const planFind = (threadId: ThreadId) =>
        Effect.suspend(() => {
          if (views.has(threadId)) return Effect.succeed(Option.some(views.get(threadId)!));
          return freshFind(threadId).pipe(
            Effect.tap((found) =>
              Effect.sync(() => {
                if (Option.isSome(found)) views.set(threadId, found.value);
              }),
            ),
          );
        });
      const planView = (threadId: ThreadId) =>
        planFind(threadId).pipe(Effect.map((found) => Option.getOrNull(found)));
      return { views, freshFind, confirmFind, planFind, planView };
    };
    const { views, freshFind, planFind, planView } = makeViews();
    // A hold lasts for the turn; a missed turn end or a thread stuck waiting
    // on something must not keep the slot.
    for (const [threadId, held] of yield* Ref.get(holds)) {
      const view = yield* planView(threadId);
      if (!view || view.state !== "running" || now - held.at > HOLD_MAX_MS) {
        const current = yield* freshFind(threadId);
        if (Option.isNone(current)) continue;
        if (current.value?.state === "running" && now - held.at <= HOLD_MAX_MS) continue;
        views.delete(threadId);
        yield* dropHold(threadId);
        yield* kick;
      }
    }
    // A failed evaluator's one retry, once its wait is over.
    for (const [threadId, entry] of yield* Ref.get(evaluatorFailures)) {
      if (entry.state !== "retry" || entry.dueAt > now) continue;
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
      const sent = yield* threads
        .send({ threadId, text: Briefs.evaluatorRetryText(entry.message) })
        .pipe(
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
          yield* evaluatorGiveUp(link, entry.message);
          views.clear();
        }
      }
    }
    const missed = new Set<ThreadId>();
    const failedMissingReads = new Set<ThreadId>();
    const before = yield* Ref.get(missing);
    yield* locks.outside(
      Effect.forEach(
        yield* store.boards,
        (candidate) =>
          serial(
            ticking,
            candidate.id,
            Effect.gen(function* () {
              const board = yield* boardOf(candidate.id);
              if (board.archivedAt !== null) return;
              const { views, freshFind, confirmFind, planFind, planView } = makeViews();
              yield* wakeRecovered(board);
              yield* reconcileHeldDiscussions(board);
              const discussionWakes = yield* wakeDiscussionNudges(board);
              yield* wakeBoardNudges(board, discussionWakes);
              views.clear();
              let boardCards: ReadonlyArray<KanbanCard> | undefined;
              const cardsForPlan = Effect.suspend(() =>
                boardCards === undefined
                  ? store.cards(board.id).pipe(
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
              const savedCard = (card: KanbanCard) => {
                if (boardCards !== undefined) {
                  boardCards = boardCards.map((existing) =>
                    existing.id === card.id ? card : existing,
                  );
                }
              };
              const cardChanges = new Map<KanbanCard["id"], KanbanCard | null>();
              let refreshedCards = false;
              const cardsForAfterMutation = (card: KanbanCard) =>
                cardChanges.has(card.id)
                  ? (cardChanges.get(card.id) ?? null)
                  : refreshedCards
                    ? null
                    : card;
              const updateCard = (card: KanbanCard) => {
                savedCard(card);
                cardChanges.set(card.id, card);
              };
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
              const goalsPrint = Scribe.goalsFingerprint(
                yield* cardsForPlan,
                yield* store.goals(board.id),
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
              // A card whose thread was deleted goes back to its queue for a new one.
              for (const card of yield* cardsForPlan) {
                if (board.pause !== null && !board.pause.keep.includes(card.id)) continue;
                const threadId = card.activeThreadId;
                if (threadId === null) continue;
                const planned = yield* planFind(threadId);
                if (Option.isNone(planned)) {
                  failedMissingReads.add(threadId);
                  missed.delete(threadId);
                  continue;
                }
                if (planned.value !== null) {
                  missed.delete(threadId);
                  continue;
                }
                if (failedMissingReads.has(threadId)) continue;
                // A failed probe cannot count as a miss, even if an earlier read was absent.
                const confirmed = yield* confirmFind(threadId);
                if (Option.isNone(confirmed) || confirmed.value !== null) {
                  if (Option.isNone(confirmed)) failedMissingReads.add(threadId);
                  views.delete(threadId);
                  missed.delete(threadId);
                  continue;
                }
                missed.add(threadId);
                if (!before.has(threadId)) continue;
                const current = yield* store.card(card.id);
                if (current === null || current.activeThreadId !== threadId) continue;
                const at = yield* nowIso;
                const review = current.activeRole === "review";
                const next: KanbanCard = {
                  ...release(current),
                  stage: review ? "needs_review" : "todo",
                  workThreadId: review ? current.workThreadId : null,
                  reviewThreadId: review ? null : current.reviewThreadId,
                  movedAt: at,
                  updatedAt: at,
                };
                yield* logEvent(next, { _tag: "system", component: "dispatcher" }, "moved", {
                  fromStage: current.stage,
                  toStage: next.stage,
                  body: "Its thread is gone",
                });
                yield* saveCard(next);
                updateCard(next);
              }
              // Backstop for a missed turn end, or a worker stuck on its own question.
              for (const plannedCard of yield* cardsForPlan) {
                // A failed-run helper can release several cards from this snapshot.
                const card = cardsForAfterMutation(plannedCard);
                if (!card) continue;
                const threadId = card.activeThreadId;
                if (threadId === null || card.activeRole !== "work" || card.stalled !== null)
                  continue;
                if (board.pause && !board.pause.keep.includes(card.id)) continue;
                if ((yield* Ref.get(unresolvedTurnEnds)).has(threadId)) continue;
                if (discussionWakes.has(threadId)) continue;
                // A paused worker waits for probeOutages, not a nudge.
                if ((yield* store.threadLink(threadId))?.paused) continue;
                const foundFailure = yield* Effect.result(threads.findLastFailure(threadId));
                if (Result.isFailure(foundFailure)) {
                  yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
                  continue;
                }
                if (foundFailure.success !== null) {
                  if (foundFailure.success.runId == null) {
                    yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
                    continue;
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
                    continue;
                  views.clear();
                  yield* turnEndedUnlocked(threadId, foundFailure.success.runId).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        views.clear();
                        invalidateCards();
                      }),
                    ),
                  );
                  cardChanges.clear();
                  refreshedCards = true;
                  for (const carried of yield* cardsForPlan) cardChanges.set(carried.id, carried);
                  continue;
                }
                const view = yield* planView(threadId);
                if (
                  view === null ||
                  Rules.waitingOnBackground(view, now) ||
                  !Rules.workerQuietDue(card, view, now)
                )
                  continue;
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
                  continue;
                // A newly failed idle run is handled by the failure backstop next tick.
                if (fresh.value.state === "idle") {
                  const latestFailure = yield* Effect.result(threads.findLastFailure(threadId));
                  if (Result.isFailure(latestFailure)) {
                    yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
                    continue;
                  }
                  if (latestFailure.success !== null) continue;
                }
                views.delete(threadId);
                if (fresh.value.state === "needs-input") {
                  // Its turn end after the interrupt brings the nudge.
                  yield* threads.interrupt(
                    threadId,
                    "Stuck on its own question; the board nudges it",
                  );
                  const at = yield* nowIso;
                  yield* logEvent(current, { _tag: "system", component: "dispatcher" }, "thread", {
                    body: "Interrupted: stuck on its own question",
                  });
                  const interrupted = { ...current, nudgedAt: at, updatedAt: at };
                  yield* saveCard(interrupted);
                  updateCard(interrupted);
                  continue;
                }
                yield* nudgeWorker(threadId, [current]);
                const saved = yield* store.card(current.id);
                if (saved) updateCard(saved);
                else invalidateCards();
              }
              // Backstop for a reviewer left idle with no verdict: a turn end skipped while
              // its own background work ran, or one that never arrived.
              for (const card of yield* cardsForPlan) {
                const threadId = card.activeThreadId;
                if (threadId === null || card.activeRole !== "review") continue;
                if (board.pause && !board.pause.keep.includes(card.id)) continue;
                if ((yield* Ref.get(unresolvedTurnEnds)).has(threadId)) continue;
                if (discussionWakes.has(threadId)) continue;
                if ((yield* store.threadLink(threadId))?.paused) continue;
                const foundFailure = yield* Effect.result(threads.findLastFailure(threadId));
                if (Result.isFailure(foundFailure)) {
                  yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
                  continue;
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
                  continue;
                }
                const view = yield* planView(threadId);
                if (
                  view === null ||
                  Rules.waitingOnBackground(view, now) ||
                  !Rules.reviewerQuietDue(card, view, now)
                )
                  continue;
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
                  continue;
                const latestFailure = yield* Effect.result(threads.findLastFailure(threadId));
                if (Result.isFailure(latestFailure)) {
                  yield* Ref.update(unresolvedTurnEnds, (all) => new Set(all).add(threadId));
                  continue;
                }
                if (latestFailure.success !== null) continue;
                views.delete(threadId);
                yield* reviewerStopped(current, threadId);
                const saved = yield* store.card(current.id);
                if (saved) updateCard(saved);
                else invalidateCards();
              }
              // A long evaluator turn gets a status ask at 45 minutes, then hourly, so nobody waits blind.
              for (const link of yield* store.threadLinks({ boardId: board.id, open: true })) {
                if (link.role !== "evaluator") continue;
                // A failed read skips this thread and keeps its ask record, so a blip
                // can't make the next healthy tick ask again inside the hour.
                const read = yield* planFind(link.threadId);
                if (Option.isNone(read)) continue;
                let view = read.value;
                if (view?.state !== "running" || view.runStartedAt === null) {
                  if (!(yield* Ref.get(statusAsked)).has(link.threadId)) continue;
                  const fresh = yield* freshFind(link.threadId);
                  if (Option.isNone(fresh)) continue;
                  view = fresh.value;
                  if (view?.state === "running" && view.runStartedAt !== null) continue;
                  yield* Ref.update(statusAsked, (all) => {
                    if (!all.has(link.threadId)) return all;
                    const next = new Map(all);
                    next.delete(link.threadId);
                    return next;
                  });
                  continue;
                }
                const run = view.runStartedAt;
                const started = Date.parse(run);
                const asked = (yield* Ref.get(statusAsked)).get(link.threadId);
                const due =
                  asked?.run === run
                    ? now - asked.at >= STATUS_EVERY_MS
                    : now - started >= STATUS_FIRST_MS;
                if (!due) continue;
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
                  continue;
                views.delete(link.threadId);
                const minutes = Math.round((now - started) / 60_000);
                const sent = yield* threads
                  .send({
                    threadId: link.threadId,
                    text: `Board check: this turn has been running for ${minutes} minutes. If your last ETA in the discussion still holds, carry on without posting. Otherwise post one line there with discussion_post: what's done and the new ETA. After a second missed ETA, stop researching: file what's left as cards with what you know, post the summary, and end the turn.`,
                  })
                  .pipe(
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
              }
              // A todo card waiting on an evaluator step wakes its evaluator once. An evaluator
              // flag means it is waiting outside the board, so there is nothing to do until the
              // flag clears; the in-memory woken bit would otherwise be lost on a restart.
              for (const card of yield* cardsForPlan) {
                if (!waitingOnEvaluatorStep(card)) {
                  yield* forgetStepWait(card.id);
                  continue;
                }
                const key = Subtasks.subtaskIds(kanbanStepSubtasks(card, "evaluator"));
                const wait = (yield* Ref.get(stepWaits)).get(card.id);
                if (wait === undefined || wait.key !== key) {
                  yield* Ref.update(stepWaits, (all) =>
                    new Map(all).set(card.id, { key, since: now, woken: false }),
                  );
                  continue;
                }
                const limit = card.priority === 1 ? STEP_WAIT_P1_MS : STEP_WAIT_MS;
                if (wait.woken || now - wait.since < limit) continue;
                const current = yield* store.card(card.id);
                const currentWait = (yield* Ref.get(stepWaits)).get(card.id);
                if (current !== null && !waitingOnEvaluatorStep(current)) {
                  yield* forgetStepWait(card.id);
                  continue;
                }
                if (
                  current === null ||
                  Subtasks.subtaskIds(kanbanStepSubtasks(current, "evaluator")) !== key ||
                  currentWait !== wait ||
                  now - wait.since < (current.priority === 1 ? STEP_WAIT_P1_MS : STEP_WAIT_MS)
                )
                  continue;
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
                          Briefs.evaluatorStepWaitingText(current, minutes),
                          true,
                        ).pipe(Effect.as(true)),
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
                  yield* Ref.update(stepWaits, (all) =>
                    new Map(all).set(card.id, { ...wait, woken: true }),
                  );
                }
              }
              // An owner message a running evaluator hasn't answered gets one reminder. An idle
              // evaluator is covered by its turn-end nudge, so it isn't pinged here.
              for (const discussion of yield* store.discussions(board.id)) {
                if (discussion.settledAt !== null || discussion.archivedAt !== null) continue;
                // Only a discussion whose evaluator owes a reply can have an owner reminder due.
                const owing = discussion.participants.filter(
                  (participant) =>
                    participant.actor._tag === "evaluator" && participant.owes === "asked",
                );
                if (owing.length === 0) continue;
                // A failed read skips only this discussion, never the tick.
                yield* Effect.gen(function* () {
                  // The owner's latest message wherever it is, read without decoding the history.
                  const ask = yield* store.ownerWait(discussion.id);
                  if (ask === null || ask.answered) return;
                  const idleMs = now - Date.parse(ask.createdAt);
                  if (idleMs < OWNER_WAIT_MS) return;
                  if ((yield* Ref.get(ownerWaits)).get(discussion.id) === ask.seq) return;
                  for (const participant of owing) {
                    const actor = participant.actor;
                    if (actor._tag !== "evaluator") continue;
                    const evaluatorId = actor.threadId;
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
                    const sent = yield* threads
                      .send({
                        threadId: evaluatorId,
                        text: Briefs.ownerWaitingText(discussion, minutes),
                      })
                      .pipe(
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
                        new Map(all).set(discussion.id, ask.seq),
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
              }
              // Typing heartbeat.
              for (const discussion of yield* store.discussions(board.id)) {
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
              }
              // Idle discussions settle themselves.
              const idleNow = yield* nowIso;
              let openLinks: ReadonlyArray<KanbanThreadLink> | null = null;
              for (const discussion of yield* store.discussions(board.id)) {
                const card = discussion.cardId ? yield* store.card(discussion.cardId) : null;
                if (!Rules.discussionSettleDue(discussion, card, now)) continue;
                openLinks ??= yield* store.threadLinks({ boardId: board.id, open: true });
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
                if (working) continue;
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
                if (working) continue;
                const current = yield* store.discussion(discussion.id);
                const currentCard = current?.cardId ? yield* store.card(current.cardId) : null;
                if (!current || !Rules.discussionSettleDue(current, currentCard, now)) continue;
                yield* saveDiscussion({ ...current, settledAt: idleNow, snoozedUntil: null });
              }
              // Cards held for their evaluator after a wait ended: a hold that ran out, or
              // that a move or a thread has overtaken, comes off here.
              for (const card of yield* cardsForPlan) {
                if (card.deciding === undefined || Waits.decidingHolds(card, now)) continue;
                const current = yield* store.card(card.id);
                if (!current || current.deciding === undefined || Waits.decidingHolds(current, now))
                  continue;
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
              }
              // Waits: each parked card's check is asked once a tick, and a wait that
              // ended is cleared here, before the PRs-landed step below.
              const parked = Waits.WAITS_ENGINE_WIRED
                ? (yield* cardsForPlan).filter(
                    (card) => card.wait !== undefined && card.activeThreadId === null,
                  )
                : [];
              if (parked.length > 0) {
                // What the work threads know about the PRs these waits point at, and what
                // the hosts say about the rest. Any write that lands while a tick is outside
                // the gate makes the tick start over (see boardLocks `acquire`), so the pass
                // leaves it once: the views this tick does not have yet are read together,
                // then the host reader is asked, in one read a rerun replays.
                const watched = [
                  ...new Set(
                    parked.flatMap((card) =>
                      card.wait?.pr == null || card.workThreadId === null
                        ? []
                        : [card.workThreadId],
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
                  if (step._tag === "none" || (step._tag === "hold" && step.save === null))
                    continue;
                  steps.push(
                    // A PR no thread watches: the card's link takes the merge the host reported.
                    step._tag === "end"
                      ? { ...step, card: Waits.withLandedLinks(step.card, facts.prs, at) }
                      : step,
                  );
                }
                // Each card is saved before its evaluator is told. Telling leaves the gate, and
                // a tick that has written cannot start over, so the cards nobody is told about
                // are saved first: a note can then only cost the notes after it this tick.
                const tells = (step: (typeof steps)[number]) =>
                  step._tag !== "hold" && step.wake.to === "evaluator";
                for (const step of steps) if (!tells(step)) yield* applyWaitStep(step, waits);
                for (const step of steps) if (tells(step)) yield* applyWaitStep(step, waits);
                if (steps.length > 0) invalidateCards();
                // A note may have started or woken an evaluator's thread.
                if (steps.some(tells)) views.clear();
              }
              // Reviewed cards wait in review until their PRs land.
              const chains = board.reviewChains;
              // syncPrs and evaluatorTurn can change cards and send to other threads.
              for (const card of yield* cardsForPlan) {
                if (card.stage !== "in_review" || card.activeThreadId !== null) continue;
                // Parked on a wait: it stays in review until the wait pass above ends it.
                if (Waits.WAITS_ENGINE_WIRED && Waits.waitHoldsDispatch(card)) continue;
                const chain = Rules.chainFor({ ...board, reviewChains: chains }, card);
                if (!Rules.reviewFinished(card, chain?.steps.length ?? 1)) continue;
                const current = yield* store.card(card.id);
                if (
                  !current ||
                  current.stage !== "in_review" ||
                  current.activeThreadId !== null ||
                  (Waits.WAITS_ENGINE_WIRED && Waits.waitHoldsDispatch(current)) ||
                  !Rules.reviewFinished(
                    current,
                    Rules.chainFor({ ...board, reviewChains: chains }, current)?.steps.length ?? 1,
                  )
                )
                  continue;
                // Its wait just ended and its evaluator was told: that decision comes first.
                if (Waits.decidingHolds(current, now)) continue;
                views.clear();
                invalidateCards();
                const synced = yield* syncPrs(current);
                if (!Rules.prsLanded(synced)) continue;
                // The plan's next step decides where it goes: the worker's sends it
                // back to work, a review-only one to review, else it's completed.
                const to: KanbanStage =
                  kanbanStepSubtasks(synced, "work").length > 0
                    ? "todo"
                    : kanbanStepSubtasks(synced, "review").length > 0
                      ? "needs_review"
                      : "completed";
                const at = yield* nowIso;
                const dispatcher: KanbanActor = { _tag: "system", component: "dispatcher" };
                const landed: KanbanCard = {
                  ...synced,
                  stage: to,
                  reviewStep: to === "completed" ? synced.reviewStep : 0,
                  wakeNote:
                    to === "todo"
                      ? [synced.wakeNote, Subtasks.nextStepNote(synced, "The PRs landed. ")]
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
              }
            }),
          ).pipe(
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
    for (const candidate of yield* store.boards) {
      yield* locks.board(
        candidate.id,
        Effect.gen(function* () {
          const board = yield* boardOf(candidate.id);
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
    yield* Ref.set(unlistedPools, unlistedNow);
    yield* Ref.set(missing, missed);
  });

  const tickUnlocked = Effect.fn("KanbanService.tickUnlocked")(function* () {
    const kicks: TickKicks = { held: true, asked: false };
    yield* tickSteps().pipe(
      Effect.provideService(tickKicks, kicks),
      Effect.ensuring(
        Effect.sync(() => {
          kicks.held = false;
        }),
      ),
      // Steps that failed never reach the dispatch below: a kick they asked for is queued.
      Effect.onError(() => Effect.suspend(() => (kicks.asked ? kick : Effect.void))),
    );
    yield* dispatchUnlocked();
  });

  /** One tiny generation on `model`: true when its provider answers. */
  const probeModel = (model: ModelSelection): Effect.Effect<boolean> => {
    const generateJson = textGeneration.generateJson;
    if (!generateJson) return Effect.succeed(false);
    return generateJson({
      cwd: serverConfig.cwd,
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

  const guardReady = <A, E, R>(effect: Effect.Effect<A, E, R>, cardId?: string, boardId?: string) =>
    locks.run(boardId === undefined ? effect : locks.access(boardId, effect), cardId).pipe(
      Effect.catchDefect((defect) =>
        defect instanceof BoardLocks.BoardStateChanged
          ? failWith(
              "conflict",
              "Board changed during this operation. Re-read its state before retrying.",
            )
          : isKanbanError(defect)
            ? Effect.fail(defect)
            : Effect.die(defect),
      ),
      Effect.mapError(toKanbanError),
    );
  const guard = <A, E, R>(effect: Effect.Effect<A, E, R>, cardId?: string, boardId?: string) =>
    Deferred.await(startupReady).pipe(Effect.andThen(guardReady(effect, cardId, boardId)));
  /**
   * A write that replies once its state is committed: thread follow-ons it
   * makes through `later` are saved as route rows as its last step, still
   * inside its board operation, so rows keep the order of the writes that
   * made them; the drains start once it returns. A follow-on collected by an
   * attempt that then failed is still saved (after it, unordered), as the
   * inline path would already have run it. `inline` route mode runs them inline.
   */
  const guardDeferred = <A, E, R>(
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
          return guard(attempt, cardId, boardId).pipe(
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
      : guard(effect, cardId, boardId);
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
      instructions: Defaults.DEFAULT_INSTRUCTIONS,
      setup: null,
      pause: null,
      createdAt: yield* nowIso,
      archivedAt: null,
    };
    yield* store.putBoardWithPools(board, missingPools([], boardModels(board)));
    yield* publish(board.id, { _tag: "board", board });
    return board;
  });

  const ensureBoard: KanbanServiceShape["ensureBoard"] = (input) =>
    guard(
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
  ) {
    yield* checkText([
      ["name", patch.name],
      ["model routing", patch.instructions?.modelRouting],
      ["reviewer routing", patch.instructions?.reviewerRouting],
      ["escalation", patch.instructions?.escalation],
    ]);
    const board = yield* boardOf(boardId);
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
    const next: KanbanBoard = {
      ...board,
      ...patch,
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
    const pools = missingPools(yield* store.pools(board.id), boardModels(next));
    yield* store.putBoardWithPools(next, pools);
    if (pools.length > 0) {
      yield* publish(board.id, { _tag: "pools", pools: yield* store.pools(board.id) });
    }
    yield* publish(board.id, { _tag: "board", board: next });
    yield* kick;
    return next;
  });

  const updateBoard: KanbanServiceShape["updateBoard"] = (boardId, patch) =>
    guard(updateBoardUnlocked(boardId, patch));

  const openBoard: KanbanServiceShape["openBoard"] = (input) =>
    guard(
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
    const twin = openTwin(yield* store.cards(boardId), input);
    if (twin) {
      return yield* failWith(
        "conflict",
        `card #${twin.card.number} "${twin.card.title}" is already open with the same ${twin.why}; add to it (card_edit / comment) instead of a second card`,
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
      return yield* failWith("invalid", "a card needs a prompt or a title");
    }
    const at = yield* nowIso;
    const stage = input.stage ?? "todo";
    const models = input.models ? yield* cardModels(boardId, input.models) : [];
    const plan = Subtasks.planSubtasks([], input.subtasks ?? []);
    if (!plan.ok) return yield* failWith("invalid", plan.reason);
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
    const packet = actor._tag === "thread" || actor._tag === "script";
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
    guardDeferred(createCardUnlocked(boardId, input, actor));

  /**
   * Where a work thread stands: its board, pool, project, the cards it carries
   * and the card it started on, whose review chain and goal new cards inherit.
   */
  const workThreadOf = Effect.fn("KanbanService.workThreadOf")(function* (threadId: ThreadId) {
    const link = yield* store.threadLink(threadId);
    if (!link || link.role !== "work") {
      return yield* failWith("denied", "only a card's work thread takes cards");
    }
    const board = yield* boardOf(link.boardId);
    const view = yield* threads.view(threadId);
    if (!view) return yield* failWith("not-found", `thread ${threadId}`);
    const carried = yield* store.cardsByThread(threadId);
    const held = (yield* Ref.get(holds)).get(threadId);
    // Past the last card and the hold, the thread's own model still names its pool.
    const pool =
      carried[0]?.activePool ??
      held?.pool ??
      Rules.poolOf(
        yield* store.pools(board.id),
        (yield* threads.model(threadId)) ?? link.model ?? board.defaultCardModel,
      );
    const origin = carried[0] ?? (link.cardId ? yield* store.card(link.cardId) : null);
    return {
      link,
      board,
      projectId: view.projectId,
      carried,
      origin,
      pool,
      holdsSlot: carried.length > 0 || held !== undefined,
    };
  });

  /**
   * Cards this thread carried that are still its own: one that moved to
   * another thread no longer counts as this thread's work.
   */
  const ownCards = Effect.fn("KanbanService.ownCards")(function* (
    threadId: ThreadId,
    cards: ReadonlyArray<KanbanCard>,
  ) {
    const carried = yield* carriedIds(threadId);
    return new Set<string>(
      cards
        .filter((card) => carried.has(card.id) && card.workThreadId === threadId)
        .map((card) => card.id),
    );
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
  const refusePendingStop = (threadId: string) => {
    const pending = [...(pendingStops.get(threadId)?.values() ?? [])];
    if (pending.length === 0) return Effect.void;
    return pending.some((entry) => entry.kind === "interrupt")
      ? failWith(
          "conflict",
          "This thread is being stopped (the board let it go of a card); it can't take another card until that stop has run.",
        )
      : failWith(
          "conflict",
          "The board is still telling this thread to let go of a card; try again in a moment.",
        );
  };
  /**
   * A thread taking a card first gets the drop and pause notes still pending
   * for it (outside the gate, as dispatch does before reusing a thread). A
   * note saved meanwhile moves the thread's stop resource, so the take reruns
   * and sends it too. Pending stops are left to refuse the take.
   */
  const settlePendingNotes = (boardId: string, threadId: string) =>
    Effect.suspend(() => {
      const pending = [...(pendingStops.get(threadId)?.values() ?? [])];
      if (pending.length === 0 || pending.some((entry) => entry.kind === "interrupt")) {
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
      readonly holdsSlot: boolean;
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
    if (settingUp.has(card.boardId)) return yield* failWith("denied", "Setup is starting");
    if (card.boardId !== thread.board.id) {
      return yield* failWith("denied", `card #${card.number} is on another board`);
    }
    const cards = yield* store.cards(card.boardId);
    const pools = yield* store.pools(card.boardId);
    const slots = pools.find((pool) => pool.key === thread.pool)?.slots ?? 0;
    const check = Rules.checkClaim(thread.board, card, {
      threadId,
      pool: thread.pool,
      projectId: thread.projectId,
      byId: new Map(cards.map((entry) => [entry.id as string, entry])),
      carrying:
        thread.carried.length +
        [...starting.values()].filter((pending) => pending.threadId === threadId).length,
      slots,
      pools,
      nowMs: yield* nowMillis,
    });
    if (!check.ok) return yield* failWith("denied", check.reason);
    if (!thread.holdsSlot) {
      const used =
        Rules.poolThreads(cards, yield* boardHolds(card.boardId)).get(thread.pool)?.size ?? 0;
      if (used >= slots) {
        return yield* failWith("denied", `no free slot on ${thread.pool}; leave it in todo`);
      }
    }
  });

  /** Puts a checked todo card on its new work thread. */
  const takeCard = Effect.fn("KanbanService.takeCard")(function* (
    threadId: ThreadId,
    pool: string,
    card: KanbanCard,
    how: string,
  ) {
    // Checked in `checkTake` before anything is written; again here, defensively.
    yield* refusePendingStop(threadId);
    const at = yield* nowIso;
    const actor: KanbanActor = { _tag: "thread", threadId };
    const next: KanbanCard = {
      ...card,
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
    yield* dropHold(threadId);
    if (card.workThreadId !== threadId) {
      yield* logEvent(next, actor, "thread", { body: `work thread ${threadId}` });
    }
    yield* logEvent(next, actor, "moved", { fromStage: card.stage, toStage: "working", body: how });
    yield* saveCard(next);
    return {
      card: next,
      brief: Briefs.claimBrief(next, yield* goalOf(next), card.wakeNote),
    } satisfies ClaimResult;
  });

  const claimCard: KanbanServiceShape["claimCard"] = (threadId, cardId) =>
    guard(
      Effect.gen(function* () {
        const thread = yield* workThreadOf(threadId);
        const card = yield* cardOf(cardId);
        yield* checkTake(thread, threadId, card);
        return yield* takeCard(threadId, thread.pool, card, "Taken by its work thread");
      }),
    );

  // The card is checked as a draft first, so a refused take leaves nothing
  // behind for the dispatcher to start twice.
  const createForThread: KanbanServiceShape["createForThread"] = (threadId, input) =>
    guard(
      Effect.gen(function* () {
        yield* checkText(cardTextFields(input));
        const thread = yield* workThreadOf(threadId);
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
            `this thread runs ${thread.pool}; create the card without assignToSelf to run it on ${Rules.poolOf(pools, model)}`,
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
        const actor: KanbanActor = { _tag: "thread", threadId };
        yield* refuseTwin(thread.board.id, fields, actor);
        const draft = yield* draftCard(thread.board.id, fields, actor);
        yield* checkTake(thread, threadId, draft);
        const card = yield* insertCard(draft, fields);
        return yield* takeCard(threadId, thread.pool, card, "Created and taken by its work thread");
      }),
    );

  const nextCards: KanbanServiceShape["nextCards"] = (threadId) =>
    read(
      Effect.gen(function* () {
        const thread = yield* workThreadOf(threadId);
        const cards = yield* store.cards(thread.board.id);
        const mine = yield* ownCards(threadId, cards);
        const pools = yield* store.pools(thread.board.id);
        const slots = pools.find((pool) => pool.key === thread.pool)?.slots ?? 0;
        // Without a slot of its own the thread can only claim while the pool has room.
        const full =
          !thread.holdsSlot &&
          (Rules.poolThreads(cards, yield* boardHolds(thread.board.id)).get(thread.pool)?.size ??
            0) >= slots;
        return {
          carrying: thread.carried,
          candidates: full
            ? []
            : Rules.relatedCandidates({
                board: thread.board,
                cards,
                groups: yield* store.groups(thread.board.id),
                seeds: cards.filter((card) => mine.has(card.id)),
                threadId,
                pool: thread.pool,
                projectId: thread.projectId,
                carrying: thread.carried.length,
                slots,
                pools,
              }),
          holdsSlot: thread.holdsSlot,
        } satisfies NextCards;
      }),
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
    yield* letGo(card, false, "was moved to the backlog", "when it leaves the backlog");
    const paused: KanbanCard = {
      ...release(next),
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

  const editCard: KanbanServiceShape["editCard"] = (cardId, patch, actor) =>
    guardDeferred(
      Effect.gen(function* () {
        yield* checkText(cardTextFields(patch));
        const card = yield* cardOf(cardId);
        // A retry of an already saved edit must not emit another event or update the card.
        const events =
          isRetryActor(actor) && patch.comment?.trim() ? yield* store.cardEvents(card.id) : [];
        if (editRepeats(card, patch, events, actor, yield* Clock.currentTimeMillis)) return card;
        const at = yield* nowIso;
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
        const plan = patch.subtasks
          ? Subtasks.planSubtasks(card.subtasks, patch.subtasks, card.subtaskSeq)
          : null;
        if (plan && !plan.ok) return yield* failWith("invalid", plan.reason);
        if (plan?.ok) yield* checkScriptNames(card.boardId, plan.subtasks);
        const removeUrls = (patch.removeLinks ?? []).map((url) => url.trim());
        for (const url of removeUrls) {
          if (!card.links.some((link) => link.url === url))
            return yield* failWith("invalid", `card #${card.number} has no link ${url}`);
        }
        const keptLinks = card.links.filter((link) => !removeUrls.includes(link.url));
        const links = patch.links ? mergeLinks(keptLinks, patch.links) : keptLinks;
        const next: KanbanCard = {
          ...card,
          title: patch.title?.trim() || card.title,
          description: patch.description?.trim() ?? card.description,
          prompt: patch.prompt?.trim() || card.prompt,
          subtasks: plan?.ok ? plan.subtasks : card.subtasks,
          subtaskSeq: plan?.ok ? plan.subtaskSeq : card.subtaskSeq,
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
        const changed = Object.entries(patch)
          .filter(([key, value]) => key !== "comment" && value !== undefined)
          .map(([key]) => key);
        if (changed.length > 0)
          yield* logEvent(next, actor, patch.links || patch.removeLinks ? "linked" : "edited", {
            body: changed.join(", "),
          });
        if (patch.comment?.trim())
          yield* logEvent(next, actor, "comment", { body: patch.comment.trim() });
        const paused = yield* pauseIfBacklog(card, next, actor, at);
        // An open work thread now runs the new model's pool, so the card's slot moves with it.
        const saved =
          paused.activeThreadId !== null &&
          paused.activeRole === "work" &&
          paused.activePool !== Rules.poolOf(pools, paused.model)
            ? { ...paused, activePool: Rules.poolOf(pools, paused.model) }
            : paused;
        yield* saveCard(saved);
        yield* laterEvaluatorTurn(card, saved, actor);
        if (patch.prompt?.trim() && patch.prompt.trim() !== card.prompt && !patch.title) {
          yield* forkWriter(card.id, { title: true, description: !patch.description });
        }
        if (plan?.ok && saved.activeThreadId !== null) {
          // The thread on the card works from the plan it was given; tell it the new one.
          const threadId = saved.activeThreadId;
          const text = Briefs.planChangedText(saved);
          yield* later(
            saved.boardId,
            cardLane(saved),
            { kind: "send", threadId, text, bestEffort: true },
            threads.send({ threadId, text }).pipe(Effect.ignore),
          );
        }
        if (
          saved.activeThreadId !== null &&
          saved.activeRole === "work" &&
          !modelSelectionsEqual(card.model, saved.model)
        ) {
          // The thread now runs the new model's pool; its slot follows, so the pool
          // counts and the one-slot limit stay right. Cards sharing the thread take the
          // same model, so a steer or wake to any of them keeps the thread on it.
          const newPool = Rules.poolOf(pools, saved.model);
          for (const other of yield* store.cardsByThread(saved.activeThreadId)) {
            if (other.id === saved.id) continue;
            yield* saveCard({ ...other, model: saved.model, activePool: newPool });
          }
          if (
            card.activePool !== null &&
            card.activePool !== newPool &&
            (yield* Ref.get(holds)).has(saved.activeThreadId)
          ) {
            yield* hold(saved.activeThreadId, saved.boardId, newPool);
          }
          // An open work thread runs the card's model; switch it now, not on its next wake.
          yield* later(
            saved.boardId,
            cardLane(saved),
            { kind: "setModel", threadId: saved.activeThreadId, model: saved.model },
            threads.setModel(saved.activeThreadId, saved.model).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("kanban thread model switch failed", {
                  cardId: saved.id,
                  cause,
                }),
              ),
            ),
          );
        }
        yield* kick;
        return saved;
      }),
      Object.keys(patch).every((key) =>
        ["title", "description", "comment", "links", "removeLinks", "prompt", "projects"].includes(
          key,
        ),
      )
        ? cardId
        : undefined,
    );

  const moveCard: KanbanServiceShape["moveCard"] = (cardId, to, role, actor, options) =>
    guardDeferred(
      Effect.gen(function* () {
        yield* checkText([
          ["note", options?.note],
          ["question", options?.question],
        ]);
        const card = yield* cardOf(cardId);
        if (role === "cardThread") {
          if (actor._tag !== "thread" || card.activeThreadId !== actor.threadId) {
            return yield* failWith("denied", `card #${card.number} is not assigned to this thread`);
          }
          if (to === "needs_owner" && !options?.question?.trim()) {
            return yield* failWith("invalid", "needs_owner needs the question for the owner");
          }
          const work = kanbanStepSubtasks(card, "work");
          if (to === "needs_review" && work.length > 0) {
            return yield* failWith(
              "denied",
              `card #${card.number} still has ${Subtasks.subtaskIds(work)} to do: mark each done (or skipped, with why) with subtask_done first`,
            );
          }
        }
        if (to === "verified" && role !== "owner") {
          const open = card.subtasks.filter((subtask) => subtask.state === "open");
          if (open.length > 0) {
            return yield* failWith(
              "denied",
              `card #${card.number} still has ${Subtasks.subtaskIds(open)} open: mark each done or skipped first`,
            );
          }
        }
        if ((to === "completed" || to === "deployed") && role !== "owner") {
          const board = yield* boardOf(card.boardId);
          const blocked = Rules.reviewGate(card, Rules.chainFor(board, card)?.steps.length ?? 1);
          if (blocked !== null) return yield* failWith("denied", blocked);
        }
        if (role === "evaluator" && to === "todo" && kanbanEvaluatorStep(card)) {
          return yield* failWith(
            "denied",
            `card #${card.number}'s step is yours (${Subtasks.subtaskIds(kanbanStepSubtasks(card))}): do it, or add work subtasks with card_edit, before sending it back to todo`,
          );
        }
        const moved = yield* moveUnlocked(card, to, role, actor, options ?? {});
        yield* laterEvaluatorTurn(card, moved, actor);
        if (to === "needs_review") {
          // The PR read is thread state: a deferred write returns the card without it.
          const deferred = yield* effectSink;
          if (deferred === undefined || deferred.closed) return yield* syncPrs(moved);
          if (moved.workThreadId !== null)
            deferred.effects.push({
              boardId: moved.boardId,
              lane: cardLane(moved),
              effect: { kind: "syncPrs", cardId: moved.id },
            });
          return moved;
        }
        const ask = Asks.openBlockingAsk(moved);
        if (to === "needs_owner" && ask !== undefined && ask.seq === null) {
          return yield* postAsk(moved, ask, []);
        }
        return moved;
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
      Effect.gen(function* () {
        // Take the card's board permit before acquiring its SQLite writer.
        yield* cardOf(input.cardId);
        yield* refusePendingStop(input.threadId);
        const restored = yield* boardSql.withTransaction(
          Effect.gen(function* () {
            const card = yield* cardOf(input.cardId);
            const board = yield* boardOf(card.boardId);
            const plan = planCutoverCardRestore({
              restore: input,
              board,
              card,
              link: yield* store.threadLink(input.threadId),
              threadCards: yield* store.threadCards(input.threadId),
              cards: yield* store.cards(board.id),
              pools: yield* store.pools(board.id),
              holds: yield* boardHolds(board.id),
              at: yield* nowIso,
            });
            if (!plan.ok) return yield* Effect.fail(plan.error);
            if (!plan.changed) return null;
            yield* store.putCard(plan.card);
            yield* store.putThreadLink(plan.link);
            yield* logEvent(plan.card, { _tag: "system", component: "harness-cutover" }, "thread", {
              fromStage: card.stage,
              toStage: plan.card.stage,
              body: `Restored existing ${plan.link.role} thread after cutover`,
            });
            return plan.card;
          }),
        );
        if (restored !== null) yield* publish(restored.boardId, { _tag: "card", card: restored });
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
    );
    const next = Asks.updateAsk(yield* cardOf(card.id), ask.id, {
      ...fields,
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

  /** A card thread acts only on the card it is running. */
  const checkCardThread = (card: KanbanCard, actor: KanbanActor, role: Rules.MoveRole) =>
    role === "cardThread" && (actor._tag !== "thread" || card.activeThreadId !== actor.threadId)
      ? failWith("denied", `card #${card.number} is not assigned to this thread`)
      : Effect.void;

  const askOwner: KanbanServiceShape["askOwner"] = (cardId, input, actor, role) =>
    guardDeferred(
      Effect.gen(function* () {
        yield* checkText([
          ["question", input.question],
          ...Asks.askTextFields(input),
          ...messageTextFields(input.blocks ?? []),
        ]);
        const card = yield* cardOf(cardId);
        yield* checkCardThread(card, actor, role);
        const question = input.question.trim();
        if (!question) return yield* failWith("invalid", "an ask needs the question");
        const written = Asks.askFields(input, { blocking: input.blocking });
        if (Asks.isAskProblem(written)) return yield* failWith(written.code, written.detail);
        if (written.to === "evaluator" && actor._tag !== "thread") {
          return yield* failWith(
            "invalid",
            "only a card's thread asks the evaluator: ask the owner",
          );
        }
        const fields = yield* adoptAskFiles(card.boardId, written);
        if (card.settledAt !== null) return yield* failWith("denied", "card is settled");
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
          { kind: "toEvaluator", discussionId: talk.id, text, note: false },
          toEvaluator(talk, text),
        );
        return handed;
      }),
    );

  const changeAsk: KanbanServiceShape["changeAsk"] = (cardId, askId, action, actor, role) =>
    guardDeferred(
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        yield* checkCardThread(card, actor, role);
        const ask = Asks.findOpenAsk(card, askId);
        if (!ask) return yield* failWith("not-found", `open ask ${askId} on card #${card.number}`);
        const at = yield* nowIso;
        if (action === "drop") {
          const discussion = yield* cardDiscussionUnlocked(card.id);
          const fresh = yield* cardOf(card.id);
          // Logged first: answerAsks saves the card, which tells the clients to re-read.
          yield* logEvent(fresh, actor, "comment", { body: `Dropped ${ask.id}: ${ask.text}` });
          const result = yield* answerAsks(
            discussion,
            fresh,
            Asks.droppedText(fresh, ask, actor._tag === "owner"),
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
    );

  const openAskOf = (card: KanbanCard, askId: string) => {
    const ask = Asks.findOpenAsk(card, askId);
    return ask
      ? Effect.succeed(ask)
      : failWith("not-found", `open ask ${askId} on card #${card.number}`);
  };

  const editAsk: KanbanServiceShape["editAsk"] = (cardId, askId, edit, actor, role) =>
    guard(
      Effect.gen(function* () {
        yield* checkText([
          ["question", edit.question],
          ["revisionNote", edit.revisionNote],
          ...Asks.askTextFields(edit),
          ...messageTextFields(edit.blocks ?? []),
        ]);
        const card = yield* cardOf(cardId);
        yield* checkCardThread(card, actor, role);
        const ask = yield* openAskOf(card, askId);
        const at = yield* nowIso;
        const written = Asks.reviseAsk(ask, edit, at);
        if (Asks.isAskProblem(written)) return yield* failWith(written.code, written.detail);
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
        );
        const edited = Asks.replaceAsk(yield* cardOf(card.id), {
          ...revised,
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
        if (!ask) return yield* failWith("not-found", `ask ${askId} on card #${card.number}`);
        const plan = Asks.secretPlan(card, ask, fieldIds);
        if (Asks.isAskProblem(plan)) return yield* failWith(plan.code, plan.detail);
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
      );
    }
  });

  const answerAsk: KanbanServiceShape["answerAsk"] = (cardId, askId, input, actor, secrets) =>
    guardDeferred(answerAskUnlocked(cardId, askId, input, actor, secrets));
  /** The one place an ask is answered: by the answer route, a tool, or a pick on its message. */
  const answerAskUnlocked = (
    ...[cardId, askId, input, actor, secrets]: Parameters<KanbanServiceShape["answerAsk"]>
  ) =>
    // Suspended only to keep the body where it was: it is `answerAsk` as before.
    Effect.suspend(() =>
      Effect.gen(function* () {
        yield* checkText(Asks.answerTextFields(input));
        const card = yield* cardOf(cardId);
        const ask = card.asks.find((entry) => entry.id === askId);
        if (!ask) return yield* failWith("not-found", `ask ${askId} on card #${card.number}`);
        const byOwner = actor._tag === "owner";
        if (!byOwner && ask.handedAt === undefined) {
          return yield* failWith(
            "denied",
            `${ask.id} on card #${card.number} was not handed to the evaluator: only the owner answers it`,
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
        if (Asks.isAskProblem(checked)) return yield* failWith(checked.code, checked.detail);
        // The files he gave are kept before the card changes: one that can't be refuses the answer.
        let answer = checked;
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
        // The ask's pick block shows the answer to clients that only read the discussion.
        const asked = ask.seq === null ? null : yield* store.message(discussion.id, ask.seq);
        if (asked?.blocks.some((block) => block._tag === "choice" && block.id === ask.id)) {
          const key = actorKey(actor);
          const shown: KanbanMessage = {
            ...asked,
            answers: [
              ...asked.answers.filter(
                (entry) => !(entry.blockId === ask.id && actorKey(entry.by) === key),
              ),
              { blockId: ask.id, by: actor, ...Asks.blockAnswer(ask, answer), at: answer.at },
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
    );

  const replyOnAsk: KanbanServiceShape["replyOnAsk"] = (cardId, askId, actor, blocks, role) =>
    guardDeferred(replyOnAskUnlocked(cardId, askId, actor, blocks, role));
  /** A reply on an ask: from its route or tool, or his words typed on its pick block. */
  const replyOnAskUnlocked = (
    ...[cardId, askId, actor, blocks, role]: Parameters<KanbanServiceShape["replyOnAsk"]>
  ) =>
    // Suspended only to keep the body where it was: it is `replyOnAsk` as before.
    Effect.suspend(() =>
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        yield* checkCardThread(card, actor, role);
        const ask = yield* openAskOf(card, askId);
        // Read beside the ask, so held to the ask's sizes, whoever writes it.
        const tooBig = Asks.replyBlocksProblem(blocks);
        if (tooBig) return yield* failWith(tooBig.code, tooBig.detail);
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
        const next: KanbanCard = {
          ...Asks.markClarify(fresh, ask.id, message.createdAt),
          updatedAt: message.createdAt,
        };
        yield* saveCard(next);
        const said = blocksText(message.blocks, attachments.pathOf);
        const current = yield* discussionOf(discussion.id);
        const by = ask.by;
        const live =
          by._tag === "thread"
            ? by.threadId === next.activeThreadId
            : by._tag === "evaluator" && (yield* liveEvaluator(by.threadId));
        // A live asker hears it itself; a parked or ended one is the evaluator's to handle.
        // Either way the send is a follow-on of this write (see `later`), never made under it.
        if (live && (by._tag === "thread" || by._tag === "evaluator")) {
          const name = by._tag === "evaluator" ? "Evaluator" : roleName(next.activeRole ?? "work");
          const text = Asks.clarifyText(next, ask, said, false);
          const sink = yield* effectSink;
          if (sink === undefined || sink.closed) {
            yield* deliver(current, by, name, by.threadId, text);
          } else {
            // What `deliver` records about the asker is board state, so it is written here.
            yield* saveDiscussion(
              withParticipant(current, by, name, {
                lastReadSeq: current.lastSeq,
                typingUntil: yield* typingUntil,
                owes: "asked",
              }),
            );
            yield* later(
              next.boardId,
              current.id,
              by._tag === "evaluator"
                ? { kind: "tellEvaluator", threadId: by.threadId, text }
                : { kind: "send", threadId: by.threadId, text },
              Effect.void,
            );
          }
        } else {
          const text = Asks.clarifyText(next, ask, said, true);
          yield* later(
            next.boardId,
            current.id,
            { kind: "toEvaluator", discussionId: current.id, text, note: false },
            toEvaluator(current, text),
          );
        }
        return message;
      }),
    );

  const handAsk: KanbanServiceShape["handAsk"] = (cardId, askId, action, actor, always) =>
    guardDeferred(
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
        if (unfit) return yield* failWith(unfit.code, unfit.detail);
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
          { kind: "toEvaluator", discussionId: discussion.id, text, note: false },
          toEvaluator(discussion, text),
        );
        return next;
      }),
    );

  const snoozeAsk: KanbanServiceShape["snoozeAsk"] = (cardId, askId, until, actor) =>
    guard(
      Effect.gen(function* () {
        if (actor._tag !== "owner") {
          return yield* failWith("denied", "only the owner snoozes an ask");
        }
        const card = yield* cardOf(cardId);
        const ask = card.asks.find((entry) => entry.id === askId);
        if (!ask) return yield* failWith("not-found", `ask ${askId} on card #${card.number}`);
        const at = yield* nowIso;
        const snoozed = Asks.snoozeAsk(card, ask, until, at);
        if (Asks.isAskProblem(snoozed)) return yield* failWith(snoozed.code, snoozed.detail);
        const next = { ...snoozed, updatedAt: at };
        yield* saveCard(next);
        return next;
      }),
    );

  const noteHandEvaluator: KanbanServiceShape["noteHandEvaluator"] = (cardId, askId, threadId) =>
    guard(
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
        if (!ask) return yield* failWith("not-found", `ask ${askId} on card #${card.number}`);
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

  const flagCard: KanbanServiceShape["flagCard"] = (cardId, reason, actor) =>
    guard(
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
          );
        }
        const at = yield* nowIso;
        const selfFlag =
          reason !== null && actor._tag === "thread" && card.activeThreadId === actor.threadId;
        const flagged: KanbanCard = {
          ...card,
          stalled: reason === null ? null : { reason, by: actor, at },
          updatedAt: at,
        };
        // A thread that can't go on frees its slot; it ends its turn on its own.
        const next: KanbanCard = selfFlag
          ? {
              ...release(flagged),
              stage: card.activeRole === "review" ? "needs_review" : "todo",
              movedAt: at,
            }
          : flagged;
        yield* logEvent(next, actor, "flagged", {
          fromStage: card.stage,
          toStage: next.stage,
          body: reason ?? "Cleared",
        });
        yield* saveCard(next);
        if (selfFlag && reason !== null) {
          yield* noteDiscussion(next, Briefs.workerFlaggedText(next, reason)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("kanban self-flag note failed", { cardId: next.id, cause }),
            ),
          );
        }
        yield* kick;
        return next;
      }),
    );

  const waitCard: KanbanServiceShape["waitCard"] = (cardId, input, actor) =>
    guard(
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
          yield* logEvent(next, actor, Waits.waitEventKind("wait_cleared"), {
            body: Waits.waitClearedBody(card.wait),
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
        if (target !== null && target.boardId !== card.boardId) {
          return yield* failWith("invalid", `card #${target.number} is on another board`);
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
        const check = Waits.checkWait(card, request, actor, yield* nowMillis);
        if (!check.ok) return yield* failWith(check.code, check.reason);
        const wait = Waits.newWait(request, actor, at);
        // A new wait is a decision: a hold for the evaluator from the last one ends here.
        const next: KanbanCard = {
          ...kanbanWithoutDeciding(card),
          wait,
          stalled: null,
          updatedAt: at,
        };
        const known = target === null ? undefined : new Map([[target.id as string, target]]);
        yield* logEvent(next, actor, Waits.waitEventKind("wait_set"), {
          body:
            Waits.waitSetBody(wait, known) +
            (card.stalled !== null ? ` (replaces the stalled flag: ${card.stalled.reason})` : ""),
        });
        yield* saveCard(next);
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
    // part of this write, so it starts here, whenever the evaluator is told. A deferred
    // write's note is sent by its lane's drain, which marks the card told once it has
    // been. From the tick the note is sent below in this same operation, so the card
    // is saved as told: a tick that cannot write again after sending leaves it right.
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
      // under `guardDeferred`, sent here (outside the gate) from the tick.
      const text = step.wake.text;
      const discussion = yield* cardDiscussionUnlocked(step.card.id);
      // A card left in review with nobody on it is the evaluator's to decide. There the
      // text is an ask, not a note: the evaluator owes the card's discussion a reply.
      const note = !(step._tag === "end" && step.card.stage === "in_review");
      yield* later(
        step.card.boardId,
        discussion.id,
        { kind: "toEvaluator", discussionId: discussion.id, text, note, decides },
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

  const answerWait: KanbanServiceShape["answerWait"] = (cardId, answer, from, actor, wired) =>
    Effect.gen(function* () {
      // Only to find the card's board: the batch reads the card again under its lock.
      const card = yield* cardOf(cardId).pipe(Effect.mapError(toKanbanError));
      const [outcome] = yield* answerWaits(
        card.boardId,
        [{ card: card.id, answer, script: from.script, expect: from.expect ?? null }],
        actor,
        wired,
      );
      if (outcome === undefined) return yield* failWith("conflict", "nothing changed");
      return outcome.ok ? outcome.text : yield* failWith(outcome.code, outcome.detail);
    });

  const settleCard: KanbanServiceShape["settleCard"] = (cardId) =>
    guard(
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        if (card.stage !== "verified")
          return yield* failWith("denied", "only verified cards can be settled");
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

  const markSubtask: KanbanServiceShape["markSubtask"] = (
    cardId,
    subtaskId,
    state,
    note,
    actor,
    role,
  ) =>
    guard(
      Effect.gen(function* () {
        yield* checkText([["note", note]]);
        const card = yield* cardOf(cardId);
        const scriptName = role === "script" ? (yield* scriptFor(card, actor)).name : null;
        const check = Subtasks.checkMark(card, subtaskId, state, role, note, scriptName);
        if (!check.ok) return yield* failWith("denied", check.reason);
        const at = yield* nowIso;
        const marked: KanbanCard = {
          ...card,
          subtasks: Subtasks.markSubtask(card.subtasks, subtaskId, state, note, actor, at),
          updatedAt: at,
        };
        const text = card.subtasks.find((subtask) => subtask.id === subtaskId)?.text ?? "";
        yield* logEvent(marked, actor, "subtask", {
          body: `${subtaskId} ${state}: ${text}${note?.trim() ? ` (${note.trim()})` : ""}`,
        });
        // A step that now needs the worker sends the card back to work (to its
        // own thread when it has one); one that needs only a review sends it to
        // needs_review.
        const idle =
          (marked.stage === "todo" || Subtasks.BACK_TO_WORK_FROM.has(marked.stage)) &&
          marked.activeThreadId === null &&
          marked.settledAt === null;
        const opened = (owner: "work" | "review") =>
          kanbanStepSubtasks(card, owner).length === 0 &&
          kanbanStepSubtasks(marked, owner).length > 0;
        const to: KanbanStage | null = !idle
          ? null
          : opened("work")
            ? "todo"
            : opened("review") &&
                kanbanStepSubtasks(marked, "work").length === 0 &&
                marked.stage !== "needs_review"
              ? "needs_review"
              : null;
        const plan = Subtasks.nextStepNote(marked);
        const next: KanbanCard =
          to === null
            ? marked
            : {
                ...marked,
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
        // The actor goes with the save: a card a script's subtask moved is a move by that script.
        yield* saveCard(next, to !== null && card.stage !== to ? actor : undefined);
        yield* laterEvaluatorTurn(card, next, actor);
        yield* kick;
        return next;
      }),
    );

  /** Only a board script does a script's subtask, and only on its own board. */
  const scriptFor = Effect.fn("KanbanService.scriptFor")(function* (
    card: KanbanCard,
    actor: KanbanActor,
  ) {
    if (actor._tag !== "script") return yield* failWith("denied", "only a board script does this");
    const script = yield* store.script(actor.scriptId);
    if (script === null || script.boardId !== card.boardId) {
      return yield* failWith("denied", `card #${card.number} isn't on this script's board`);
    }
    return script;
  });

  const handBack: KanbanServiceShape["handBack"] = (cardId, subtaskId, note, actor) =>
    guard(
      Effect.gen(function* () {
        yield* checkText([["note", note]]);
        const card = yield* cardOf(cardId);
        const script = yield* scriptFor(card, actor);
        const check = Subtasks.checkHandBack(card, subtaskId, script.name, note);
        if (!check.ok) return yield* failWith("denied", check.reason);
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
  ) {
    if (
      card.stage !== "needs_review" ||
      card.activeThreadId !== null ||
      card.reviewThreadId !== threadId ||
      card.settledAt !== null
    ) {
      return false;
    }
    const events = yield* store.cardEvents(card.id);
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

  const reviewResult: KanbanServiceShape["reviewResult"] = (threadId, verdict, findings, head) =>
    guard(
      Effect.gen(function* () {
        yield* checkText(findings.map((finding) => ["finding", finding] as const));
        const link = yield* store.threadLink(threadId);
        if (!link || link.role !== "review" || link.cardId === null) {
          return yield* failWith("denied", "only a card's review thread records a review result");
        }
        const card = yield* cardOf(link.cardId);
        const live = card.activeThreadId === threadId && card.stage === "in_review";
        const late = !live && (yield* lateReviewer(card, threadId));
        const sha = head?.trim().toLowerCase() || null;
        const body =
          verdict === "findings" ? findings.map((line) => `- ${line.trim()}`).join("\n") : "clear";
        if (!live && !late) {
          if (sha !== null && /^[0-9a-f]{7,40}$/.test(sha)) {
            const events = yield* store.cardEvents(card.id);
            const lastReview = events.findLast((event) => event.kind === "review");
            if (
              lastReview?.actor._tag === "thread" &&
              lastReview.actor.threadId === threadId &&
              lastReview.head === sha &&
              lastReview.body === body
            ) {
              yield* Effect.logInfo("kanban review result replay ignored", {
                cardId: card.id,
                threadId,
                head: sha,
              });
              return card;
            }
          }
          return yield* failWith(
            "conflict",
            `card #${card.number} is not in review with this thread`,
          );
        }
        if (verdict === "findings" && findings.length === 0) {
          return yield* failWith("invalid", "findings need at least one line");
        }
        if (sha !== null && !/^[0-9a-f]{7,40}$/.test(sha)) {
          return yield* failWith(
            "invalid",
            "head is the commit you reviewed: 7 to 40 hex characters",
          );
        }
        const board = yield* boardOf(card.boardId);
        const chain = Rules.chainFor(board, card);
        const outcome = Rules.applyReviewResult(card, chain?.steps.length ?? 1, verdict);
        const at = yield* nowIso;
        // The last review step passing ticks off the step's review subtasks. If
        // the plan then has more work, the card goes back to its worker.
        const passed = verdict === "clear" && !outcome.continueReview;
        const subtasks = passed
          ? Subtasks.passReview(card, { _tag: "thread", threadId }, at)
          : card.subtasks;
        const moreWork = passed && Subtasks.workAfterReview({ subtasks });
        const next: KanbanCard = {
          // A verdict is a review that ended normally: its retry record goes.
          ...Retries.withoutRetries(release(card)),
          // The dispatcher's no-verdict flag is answered by the verdict; a
          // reviewer's own flag stays for the evaluator.
          stalled: late && card.stalled?.by._tag === "system" ? null : card.stalled,
          subtasks,
          stage: moreWork ? "todo" : outcome.continueReview ? "needs_review" : outcome.stage,
          reviewStep: moreWork ? 0 : outcome.reviewStep,
          reviewRound: outcome.reviewRound,
          wakeNote:
            verdict === "findings"
              ? `Review findings (round ${card.reviewRound + 1}):\n${body}\n\nFix them, then card_move to needs_review.`
              : moreWork
                ? Subtasks.nextStepNote({ subtasks }, "The review passed. ")
                : // A review start keeps the card's wake note so the reviewer reads it
                  // (startCard). The verdict is where it has been read: without this it
                  // came back in every later review brief.
                  null,
          nudgedAt: null,
          movedAt: at,
          updatedAt: at,
        };
        yield* logEvent(next, { _tag: "thread", threadId }, "review", {
          fromStage: card.stage,
          toStage: next.stage,
          body,
          head: sha,
        });
        yield* saveCard(next);
        yield* evaluatorTurn(card, next, { _tag: "thread", threadId });
        if (verdict === "findings" && next.reviewRound === 3) {
          // Third findings round: the evaluator decides scope rather than the loop running on.
          // A failed note must not fail the review result, so it only logs.
          yield* cardDiscussionUnlocked(next.id).pipe(
            Effect.flatMap((discussion) =>
              toEvaluator(
                discussion,
                `#${card.number} got review findings for the third time. Findings:\n${body}\n\nDecide the scope now: steer the worker on what must still be fixed here, move the rest to a new card, or accept what's left with a note on the card.`,
                true,
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("kanban third review round note failed", {
                cardId: next.id,
                cause,
              }),
            ),
          );
        }
        yield* kick;
        return next;
      }),
    );

  const cardThread: KanbanServiceShape["cardThread"] = (cardId, action, text, actor) =>
    guard(
      Effect.gen(function* () {
        yield* checkText([["note", text]]);
        const card = yield* cardOf(cardId);
        const at = yield* nowIso;
        if (action === "steer") {
          const threadId = card.activeThreadId ?? card.workThreadId;
          if (threadId === null)
            return yield* failWith("invalid", `card #${card.number} has no thread`);
          const board = yield* boardOf(card.boardId);
          if (board.pause && !board.pause.keep.includes(card.id)) {
            return yield* failWith("denied", `the board is paused: ${board.pause.reason}`);
          }
          if (
            board.pause &&
            (yield* store.cardsByThread(threadId)).some(
              (entry) => !board.pause!.keep.includes(entry.id),
            )
          ) {
            return yield* failWith("denied", `the board is paused: ${board.pause.reason}`);
          }
          // A released sibling still points at the shared thread. The thread runs its own
          // current model (a switch moved it, and it survives every card's release), so a
          // steer sends that rather than the sibling's stale one.
          const threadModel = card.activeThreadId === null ? yield* threads.model(threadId) : null;
          const model =
            card.activeRole === "review"
              ? Rules.nextModel(yield* boardOf(card.boardId), card)
              : (threadModel ?? card.model);
          yield* threads.send({ threadId, text, model });
          yield* logEvent(card, actor, "thread", { body: `Steered: ${text}` });
          return card;
        }
        if (action === "stop") {
          const kept = yield* letGo(
            card,
            false,
            text.trim() ? `was stopped: ${text.trim()}` : "was stopped",
          );
          const next: KanbanCard = {
            ...release(card),
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
          yield* saveCard(next);
          return next;
        }
        if (action === "reset") {
          yield* letGo(card, false, "moved to a fresh thread");
          const stage: KanbanCard["stage"] =
            card.stage === "working"
              ? "todo"
              : card.stage === "in_review"
                ? "needs_review"
                : card.stage;
          const next: KanbanCard = {
            ...release(card),
            workThreadId: null,
            reviewThreadId: null,
            stage,
            stalled: null,
            nudgedAt: null,
            wakeNote:
              stage === "todo"
                ? withFreshNote(text.trim() || card.wakeNote)
                : text.trim() || card.wakeNote,
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
          if (text.trim() && board.pause && !board.pause.keep.includes(card.id)) {
            return yield* failWith("denied", `the board is paused: ${board.pause.reason}`);
          }
          if (
            text.trim() &&
            board.pause &&
            (yield* store.cardsByThread(card.activeThreadId)).some(
              (entry) => !board.pause!.keep.includes(entry.id),
            )
          ) {
            return yield* failWith("denied", `the board is paused: ${board.pause.reason}`);
          }
          const model =
            card.activeRole === "review"
              ? Rules.nextModel(yield* boardOf(card.boardId), card)
              : card.model;
          if (text.trim()) yield* threads.send({ threadId: card.activeThreadId, text, model });
          return card;
        }
        const next: KanbanCard = {
          // Woken out of Needs Owner: the wake text stands in for the answer.
          ...Asks.closeAsks(card, at, (ask) => ask.blocking && card.stage === "needs_owner"),
          stage: card.stage === "needs_review" ? "needs_review" : "todo",
          stalled: null,
          question: null,
          settledAt: null,
          wakeNote: text.trim() || card.wakeNote,
          movedAt: at,
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
    yield* store.rekeyBoard(
      board.id,
      [{ from: from.key, pool: to }],
      moved.map((entry) => entry.card),
    );
    const actor: KanbanActor = { _tag: "system", component: "pools" };
    const level = Rules.modelLevel(to.model) ?? "default";
    const switched = new Set<string>();
    for (const { card, leveled, work } of moved) {
      // Logged before the publish: clients re-read the card's history when it's published.
      if (leveled) yield* logEvent(card, actor, "edited", { body: `model level: ${level}` });
      yield* publish(board.id, { _tag: "card", card });
      if (
        work &&
        card.activeRole === "work" &&
        card.activeThreadId !== null &&
        !switched.has(card.activeThreadId)
      ) {
        switched.add(card.activeThreadId);
        yield* threads
          .setModel(card.activeThreadId, to.model)
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
      if (hold.boardId !== board.id || hold.pool !== from.key) continue;
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
    yield* Ref.update(
      holds,
      (all) =>
        new Map(
          [...all].map(([threadId, hold]) =>
            hold.boardId === board.id && hold.pool === from.key
              ? [threadId, { ...hold, pool: to.key }]
              : [threadId, hold],
          ),
        ),
    );
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
      Effect.gen(function* () {
        model = yield* canonicalModel(model);
        const board = yield* boardOf(boardId);
        if (options?.replaces !== undefined) {
          const changed = yield* changePoolLevel(board, model, slots, options.replaces);
          yield* publish(boardId, { _tag: "pools", pools: changed });
          yield* kick;
          return changed;
        }
        if (slots === undefined) return yield* failWith("invalid", "slots is required");
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
          return yield* failWith("invalid", "a new goal needs a name");
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
      Effect.gen(function* () {
        yield* checkText([["title", patch.title]]);
        if (actor._tag !== "owner") {
          return yield* failWith("denied", "only the owner renames, settles, snoozes or pins");
        }
        const discussion = yield* discussionOf(discussionId);
        const at = yield* nowIso;
        let next = discussion;
        if (patch.title !== undefined) {
          const title = patch.title.trim().slice(0, DISCUSSION_TITLE_MAX);
          if (!title) return yield* failWith("invalid", "a discussion needs a title");
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
            return yield* failWith("invalid", "snoozedUntil is not a time");
          }
          if (DateTime.toEpochMillis(until.value) <= (yield* nowMillis)) {
            return yield* failWith("invalid", "snoozedUntil must be in the future");
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
    return own ? { card, ask, stale: ask.seq !== seq } : null;
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
              return failWith(
                "conflict",
                `${ref} was updated since this message (it is at revision ${kanbanAskRevision(pick.ask)} now). Nothing was answered: answer its current version.`,
              );
            }
            // A closed ask's late pick, and an ask that takes words alone, go the way a reply does.
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
            // Words with no pick, on an ask that needs a verdict or a pick: they are a reply
            // on the ask. It stays open and its asker is told they decided nothing.
            if (choice.length === 0 && words !== "" && !kanbanAskTakesWords(pick.ask)) {
              return guardDeferred(
                replyOnAskUnlocked(
                  pick.card.id,
                  pick.ask.id,
                  by,
                  [{ _tag: "md", text: words }],
                  "owner",
                ).pipe(Effect.andThen(message)),
              );
            }
            // Anything else is answered as the ask's own answer route would, checks included.
            return guardDeferred(
              answerAskUnlocked(
                pick.card.id,
                pick.ask.id,
                Asks.pickAnswer(pick.ask, choice, words),
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
        const note = `Owner answered "${block.question}" in discussion ${discussion.id} (message ${seq}): ${[...picked.map((option) => option.label), ...(words === "" ? [] : [`his own answer: "${words}"`])].join(", ")}`;
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
          ? boardSql
              .withTransaction(
                saveOwnerRoute(discussion.boardId, discussionId, routeKey, {
                  kind: "answer",
                  seq,
                  blockId,
                  at,
                  note,
                  choice: choiceIds,
                  text: answerText,
                }).pipe(Effect.andThen(store.putMessage(next))),
              )
              .pipe(Effect.mapError(toKanbanError))
          : store.putMessage(next);
        yield* publish(discussion.boardId, { _tag: "message", message: next });
        return { next, note, routeKey };
      }),
    ).pipe(
      Effect.flatMap(({ next, note, routeKey }) =>
        by._tag !== "owner"
          ? Effect.succeed(next)
          : durableOwnerRoutes
            ? afterOwnerCommit(discussionId).pipe(Effect.as(next))
            : ownerAnswerRoute(discussionId, seq, blockId, note, routeKey).pipe(Effect.as(next)),
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
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const writeWiki: KanbanServiceShape["writeWiki"] = (boardId, page, actor) =>
    guard(
      Effect.gen(function* () {
        yield* checkText([
          ["title", page.title],
          ["wiki body", page.body],
        ]);
        yield* boardOf(boardId);
        const slug = page.slug
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        if (!slug) return yield* failWith("invalid", "a wiki page needs a slug");
        const next: KanbanWikiPage = {
          boardId,
          slug,
          title: page.title.trim() || slug,
          body: page.body,
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
      return Summaries.follow(Summaries.tallyBoards(boards), Stream.fromSubscription(subscription));
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
        Effect.flatMap(store.boards, (boards) =>
          Effect.forEach(boards, rekeyBoard, { discard: true }),
        ),
      )
      .pipe(
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
          yield* boardSql`
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
      Effect.forkIn(scope),
    );
  }

  const runJob = (job: Job) =>
    read(job._tag === "kick" ? dispatchUnlocked() : turnEndedUnlocked(job.threadId)).pipe(
      NodeSqliteClient.backgroundReads,
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban job failed", { job: job._tag, cause }),
      ),
    );

  return KanbanService.of({
    ready: Deferred.await(startupReady),
    boards: readDb(store.boards),
    withSelectionMigrationLock: (effect) =>
      Deferred.await(startupReady).pipe(Effect.andThen(locks.exclusive(effect))),
    ensureBoard,
    openBoard,
    createBoard,
    updateBoard,
    snapshot: (boardId) => readDb(snapshotOf(boardId)),
    replySnapshot: (boardId, page) => readDb(snapshotOf(boardId, true, page)),
    watch,
    boardSummaries,
    announce: (boardId, change) => Effect.asVoid(publish(boardId, change)),
    changes: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
    card: (cardId) =>
      readDb(
        Effect.gen(function* () {
          const card = yield* cardOf(cardId);
          return {
            card,
            events: yield* store.cardEvents(cardId),
            threads: yield* store.threadLinks({ cardId }),
          } satisfies CardDetail;
        }),
      ),
    cardByNumber: (boardId, number) => readDb(store.cardByNumber(boardId, number)),
    cards: (boardId) => readDb(store.cards(boardId)),
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
    reviewResult,
    cardThread,
    setPool,
    removePool,
    setGoal,
    setGroups,
    discussions: (boardId) => readDb(store.discussions(boardId)),
    threads: (boardId) => readDb(threadRowsOf(boardId)),
    discussion: (id) => readDb(discussionOf(id)),
    createDiscussion,
    updateDiscussion,
    cardDiscussion: Effect.fn("KanbanService.cardDiscussion")(function* (cardId) {
      const existing = yield* readDb(
        Effect.gen(function* () {
          const card = yield* cardOf(cardId);
          return card.discussionId === null ? null : yield* store.discussion(card.discussionId);
        }),
      );
      return existing ?? (yield* guard(cardDiscussionUnlocked(cardId)));
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
      guardDeferred(
        postUnlocked(
          discussionId,
          author,
          blocks,
          author._tag !== "owner",
          true,
          durableOwnerRoutes,
        ),
      ).pipe(Effect.tap(routeOwnerPost)),
    postToCard: (cardId, author, blocks) =>
      guardDeferred(
        Effect.gen(function* () {
          const discussion = yield* cardDiscussionUnlocked(cardId);
          return yield* postUnlocked(
            discussion.id,
            author,
            blocks,
            author._tag !== "owner",
            true,
            durableOwnerRoutes,
          );
        }),
      ).pipe(Effect.tap(routeOwnerPost)),
    attachmentPath: (attachment) => attachments.pathOf(attachment),
    answer,
    markRead,
    markReadSoon,
    wiki: (boardId) => readDb(store.wiki(boardId)),
    writeWiki,
    endSetup: (boardId, actor) => guard(endSetupUnlocked(boardId, actor)),
    pauseBoard: (boardId, pause, actor, callerAncestors = []) =>
      guard(pauseBoardUnlocked(boardId, pause, actor, callerAncestors)),
    startSetup: (boardId, input) =>
      guard(
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
    startEvaluator: (boardId, purpose, text) =>
      guard(
        Effect.gen(function* () {
          yield* checkText([
            ["text", text],
            [
              "text",
              purpose.kind === "setup" || purpose.kind === "request" ? purpose.text : undefined,
            ],
          ]);
          const board = yield* boardOf(boardId);
          if (
            purpose.kind === "stalled" ||
            purpose.kind === "completed" ||
            purpose.kind === "deployed" ||
            purpose.kind === "check"
          ) {
            const running = yield* runningSweep(board.id, purpose.kind);
            if (running) {
              return yield* failWith(
                "conflict",
                `a ${purpose.kind} sweep is already running on this board (thread ${running}). Steer it with t3_thread_send, or hand one job to a new evaluator with kind "request" and text.`,
              );
            }
          }
          return yield* startEvaluatorUnlocked(board, purpose, { text });
        }),
      ),
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
    dispatchNow: read(dispatchUnlocked()).pipe(NodeSqliteClient.backgroundReads),
    turnEnded: (threadId) => guard(turnEndedUnlocked(threadId)),
    tick: read(tickUnlocked()).pipe(NodeSqliteClient.backgroundReads),
    probeOutages: read(probeOutagesNow()),
    threadEvent: (threadId) => Effect.sync(() => touch(threadId)),
    notifyTurnEnded: (threadId) =>
      Queue.offer(jobs, { _tag: "turnEnd", threadId }).pipe(Effect.asVoid),
    notifyThreadChanged: (threadId) =>
      read(
        Effect.gen(function* () {
          const link = yield* store.threadLink(threadId);
          if (!link) return;
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

export const layer = Layer.effect(KanbanService, make);
