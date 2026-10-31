// @effect-diagnostics nodeBuiltinImport:off - record ids only need a random UUID.
import * as NodeCrypto from "node:crypto";

import {
  KANBAN_BACKLOG,
  KANBAN_DONE_STAGES,
  KANBAN_THREAD_STAGES,
  kanbanCardModels,
  kanbanEvaluatorStep,
  kanbanNeedsOwner,
  kanbanOpenAsks,
  kanbanStepSubtasks,
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
  type KanbanOwnerAsk,
  type KanbanParticipant,
  type KanbanPool,
  type KanbanStage,
  type KanbanThreadLink,
  type KanbanThreadRow,
  type KanbanThreadState,
  type KanbanWikiPage,
  type ModelSelection,
  type ProviderOptionSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
import * as Stream from "effect/Stream";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import { actorKey, KanbanStore } from "../store/KanbanStore.ts";
import * as Asks from "./asks.ts";
import { modelProblem } from "./modelCheck.ts";
import * as Briefs from "./briefs.ts";
import { makeBoardAttachments } from "./attachments.ts";
import * as ServerConfig from "../../../config.ts";
import * as FileSystem from "effect/FileSystem";
import * as Defaults from "./defaults.ts";
import * as Rules from "./rules.ts";
import * as Scribe from "./scribe.ts";
import * as Subtasks from "./subtasks.ts";
import * as Summaries from "./summaries.ts";
import { KanbanThreads } from "./threads.ts";
import { KanbanModels, isListed } from "./models.ts";

/** Typing shows while an agent's turn runs; refreshed by the tick, cleared at turn end. */
const TYPING_MS = 90_000;

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

export interface KanbanServiceShape {
  readonly boards: Effect.Effect<ReadonlyArray<KanbanBoard>, KanbanError>;
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
  readonly updateBoard: (
    boardId: KanbanBoard["id"],
    patch: BoardPatch,
  ) => Effect.Effect<KanbanBoard, KanbanError>;
  readonly snapshot: (
    boardId: KanbanBoard["id"],
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
  readonly settleCard: (cardId: KanbanCard["id"]) => Effect.Effect<KanbanCard, KanbanError>;
  /**
   * Asks the owner a question on a card. A blocking ask holds the card in
   * Needs Owner (a card thread's own card must be in Working); an async one
   * leaves it where it is. Options make it a pick.
   */
  readonly askOwner: (
    cardId: KanbanCard["id"],
    input: {
      readonly question: string;
      readonly blocking: boolean;
      readonly options?: ReadonlyArray<string> | undefined;
      readonly multi?: boolean | undefined;
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

  readonly setPool: (
    boardId: KanbanBoard["id"],
    model: ModelSelection,
    slots: number,
  ) => Effect.Effect<ReadonlyArray<KanbanPool>, KanbanError>;
  readonly removePool: (
    boardId: KanbanBoard["id"],
    model: ModelSelection,
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
  readonly messages: (
    id: KanbanDiscussion["id"],
    options?: { readonly afterSeq?: number; readonly limit?: number },
  ) => Effect.Effect<ReadonlyArray<KanbanMessage>, KanbanError>;
  /** Absolute path an agent can open for a board attachment, or null. */
  readonly attachmentPath: (attachment: ChatAttachment) => string | null;
  readonly post: (
    discussionId: KanbanDiscussion["id"],
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
// An evaluator turn that has run this long is asked for a one-line status, then again every hour.
const STATUS_FIRST_MS = 45 * 60_000;
const STATUS_EVERY_MS = 60 * 60_000;
// A Now someone wrote this recently (an evaluator, by hand) is not overwritten by the scribe.
const SCRIBE_KEEPS_NOW_MS = 5 * 60_000;

const DISCUSSION_TITLE_MAX = 80;
/** Past this many messages a discussion has long had the owner's first one. */
const TITLE_SCAN_MAX = 20;

const WriterOutput = Schema.Struct({ title: Schema.String, description: Schema.String });
const ProbeOutput = Schema.Struct({ ok: Schema.Boolean });

const uuid = () => NodeCrypto.randomUUID();

const failWith = (code: KanbanError["code"], detail: string) =>
  Effect.fail(new KanbanError({ code, detail }));

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

const make = Effect.gen(function* () {
  const store = yield* KanbanStore;
  const threads = yield* KanbanThreads;
  const models = yield* KanbanModels;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const projects = yield* ProjectService.ProjectService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const attachments = makeBoardAttachments(serverConfig, yield* FileSystem.FileSystem);
  const scope = yield* Effect.scope;

  const lock = yield* Semaphore.make(1);
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
  // Evaluator threads asked for a status: the run it was asked in and when. A new run starts over.
  const statusAsked = yield* Ref.make<ReadonlyMap<ThreadId, { readonly run: string; readonly at: number }>>(
    new Map(),
  );
  const hold = (threadId: ThreadId, boardId: string, pool: string) =>
    Effect.flatMap(nowMillis, (at) =>
      Ref.update(holds, (all) => new Map(all).set(threadId, { boardId, pool, at })),
    );
  /** One board's held slots, thread id to pool, as the rules take them. */
  const boardHolds = (boardId: string) =>
    Effect.map(
      Ref.get(holds),
      (all) =>
        new Map(
          [...all].flatMap(([threadId, held]) =>
            held.boardId === boardId ? [[threadId as string, held.pool] as const] : [],
          ),
        ),
    );
  // Threads a card was running on that were missing at the last tick. `view`
  // also answers null on a read error, so a card is let go on the second miss.
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
  });

  const kick = Effect.gen(function* () {
    const pending = yield* Ref.getAndSet(kickPending, true);
    if (!pending) yield* Queue.offer(jobs, { _tag: "kick" });
  });

  const boardOf = Effect.fn("KanbanService.boardOf")(function* (boardId: string) {
    const board = (yield* store.boards).find((candidate) => candidate.id === boardId);
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
    const pools = yield* store.pools(boardId);
    const joined = `${model.instanceId}/${model.model}`;
    const match =
      Rules.poolFor(pools, model) ??
      pools.find((pool) => pool.model.model === joined || pool.model.model === model.model) ??
      (() => {
        const suffix = pools.filter((pool) => pool.model.model.endsWith(`/${model.model}`));
        return suffix.length === 1 ? suffix[0] : undefined;
      })();
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
      .sort((a, b) => (b.lastActivityAt ?? b.startedAt).localeCompare(a.lastActivityAt ?? a.startedAt))
      .slice(0, THREAD_ROWS_ENDED_LIMIT);
    return [...running, ...ended];
  });

  const snapshotOf = Effect.fn("KanbanService.snapshotOf")(function* (boardId: KanbanBoard["id"]) {
    const board = yield* boardOf(boardId);
    const cards = yield* store.cards(boardId);
    const live = [
      ...new Set(cards.flatMap((card) => (card.activeThreadId ? [card.activeThreadId] : []))),
    ];
    const states = yield* Effect.forEach(live, threadState, { concurrency: 8 });
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
      cards,
      goals: yield* store.goals(boardId),
      pools: yield* store.pools(boardId),
      groups: yield* store.groups(boardId),
      threads: states.flat(),
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
    yield* publish(card.boardId, by === undefined ? { _tag: "card", card } : { _tag: "card", card, by });
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

  const release = (card: KanbanCard) =>
    ({ ...card, activeThreadId: null, activeRole: null, activePool: null }) satisfies KanbanCard;

  // Logged when a card leaves a thread that got too long; a repeat inside an hour is flagged.
  const FRESH_START = "Thread too long; the next run starts on a fresh thread";
  const freshStartedRecently = (card: KanbanCard, at: string) =>
    store.cardEvents(card.id).pipe(
      Effect.map((events) =>
        events.some(
          (event) =>
            event.body?.startsWith(FRESH_START) === true &&
            Date.parse(at) - Date.parse(event.at) < Rules.CONTEXT_FULL_RETRY_MS,
        ),
      ),
    );
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
      yield* threads.interrupt(threadId, `Card #${card.number} ${what}`);
      return false;
    }
    yield* threads
      .send({
        threadId,
        text:
          until !== null
            ? Briefs.pauseCardText(card, what, until, others)
            : Briefs.dropCardText(card, what, others),
      })
      .pipe(Effect.ignore);
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
      ...base,
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
      if (ask.by._tag !== "evaluator" || !(yield* liveEvaluator(ask.by.threadId))) continue;
      yield* threads
        .send({
          threadId: ask.by.threadId,
          text: Asks.droppedText(next, ask, actor._tag === "owner"),
        })
        .pipe(Effect.ignore);
    }
    yield* kick;
    return next;
  });

  /**
   * Copies the work thread's tracked PRs (same source as the sidebar) onto the
   * card. A thread that carried several cards attaches PRs per card itself, so
   * then only the states of PRs already on the card are refreshed.
   */
  const syncPrs = Effect.fn("KanbanService.syncPrs")(function* (card: KanbanCard) {
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
    const next = { ...card, links, updatedAt: at };
    yield* saveCard(next);
    return next;
  });

  const writeTitle = Effect.fn("KanbanService.writeTitle")(function* (
    cardId: KanbanCard["id"],
    fields: { readonly title: boolean; readonly description: boolean },
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
    });
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* cardOf(cardId);
        const title = written.title.trim().slice(0, 80);
        const description = written.description.trim();
        yield* saveCard({
          ...current,
          title: fields.title && title ? title : current.title,
          description: fields.description && description ? description : current.description,
          updatedAt: yield* nowIso,
        });
      }),
    );
  });

  const forkWriter = (
    cardId: KanbanCard["id"],
    fields: { readonly title: boolean; readonly description: boolean },
  ) =>
    writeTitle(cardId, fields).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("kanban title writer failed", { cardId, cause }),
      ),
      Effect.forkIn(scope),
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
    });
    yield* lock.withPermits(1)(
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
  const forkGroups = (boardId: KanbanBoardId) =>
    writeGroups(boardId).pipe(
      Effect.catchCause((cause) => Effect.logWarning("kanban scribe failed", { boardId, cause })),
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
    const output = yield* generateJson({
      cwd: project.value.workspaceRoot,
      prompt: Scribe.goalsPrompt(yield* store.cards(boardId), yield* store.goals(boardId)),
      outputSchema: Scribe.ScribeGoalsOutput,
      modelSelection: board.managerModel,
    });
    yield* lock.withPermits(1)(
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
          const keepNow =
            update.now === "" ||
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
      Effect.catchCause((cause) => Effect.logWarning("kanban goal scribe failed", { boardId, cause })),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  const scribeActor: KanbanActor = { _tag: "system", component: "scribe" };
  // The board's "Goal ideas" discussion: the newest open one the scribe made.
  const ideasDiscussion = Effect.fn("KanbanService.ideasDiscussion")(function* (boardId: KanbanBoardId) {
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
  const ideaMessages = Effect.fn("KanbanService.ideaMessages")(function* (discussionId: KanbanDiscussionId) {
    return yield* store.allMessages(discussionId);
  });
  const writeProposals = Effect.fn("KanbanService.writeProposals")(function* (boardId: KanbanBoardId) {
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
      prompt: Scribe.proposalsPrompt(yield* store.cards(boardId), yield* store.goals(boardId), past),
      outputSchema: Scribe.ScribeProposalsOutput,
      modelSelection: board.managerModel,
    });
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        // The model call ran without the lock: re-read the history and the due check now, so a
        // proposal that landed meanwhile is respected.
        const current = yield* ideasDiscussion(boardId);
        const currentMessages = current === null ? [] : yield* ideaMessages(current.id);
        const currentPast = Scribe.pastProposals(currentMessages);
        const cards = yield* store.cards(boardId);
        const goals = yield* store.goals(boardId);
        const last = currentMessages.filter((message) => message.author._tag === "system").at(-1) ?? null;
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
      Effect.catchCause((cause) => Effect.logWarning("kanban goal ideas failed", { boardId, cause })),
      Effect.ensuring(Ref.update(proposalsRunning, (all) => new Set([...all].filter((id) => id !== boardId)))),
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
    const updated = { ...current, ...patch };
    const participants = [...discussion.participants];
    if (index >= 0) participants[index] = updated;
    else participants.push(updated);
    return { ...discussion, participants };
  };

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
    yield* store.putDiscussion(discussion);
    yield* publish(discussion.boardId, { _tag: "discussion", discussion });
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
    yield* lock.withPermits(1)(
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

  const startEvaluatorUnlocked = Effect.fn("KanbanService.startEvaluatorUnlocked")(function* (
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
    const threadId = yield* threads.launch({
      key: `${board.id}:eval:${Briefs.purposeKey(purpose)}:${at}`,
      projectId: board.defaultProjectId,
      title,
      model: board.evaluatorModel,
      text: extra.text ? `${brief}\n\n${extra.text}` : brief,
    });
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
    }
    return threadId;
  });

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
    const isSetupThread =
      actor._tag === "evaluator" && actor.threadId === setup.threadId;
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
      if (link.role !== "evaluator" || link.purpose !== kind || link.discussionId !== null) continue;
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

  /** An evaluator that exists and is not archived. Archived ones are gone for routing. */
  const liveEvaluator = Effect.fn("KanbanService.liveEvaluator")(function* (threadId: ThreadId) {
    const view = yield* threads.view(threadId);
    return !!view && !view.archived;
  });

  /**
   * The discussion's evaluator gets the text: an existing one is steered,
   * otherwise one starts. A `note` owes no reply in the discussion.
   */
  const toEvaluator = Effect.fn("KanbanService.toEvaluator")(function* (
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
        yield* threads.send({ threadId: priorId, text: handoff }).pipe(Effect.ignore);
        const prior = actorOf(priorId);
        if (next.participants.some((p) => actorKey(p.actor) === actorKey(prior))) {
          next = withParticipant(next, prior, "Evaluator", { typingUntil: null, owes: null });
        }
      }
    }
    yield* saveDiscussion(next);
    return next;
  });

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
  const evaluatorTurn = Effect.fn("KanbanService.evaluatorTurn")(
    function* (before: KanbanCard | null, after: KanbanCard, actor: KanbanActor) {
      // in_review with no thread: its review passed and it waits for its PRs.
      const turn = (card: KanbanCard) =>
        kanbanEvaluatorStep(card) &&
        card.activeThreadId === null &&
        card.settledAt === null &&
        ((card.stage === "todo" && card.wakeNote === null) ||
          card.stage === "in_review" ||
          (KANBAN_DONE_STAGES.has(card.stage) && card.stage !== "verified"))
          ? Subtasks.subtaskIds(kanbanStepSubtasks(card, "evaluator"))
          : null;
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
        yield* toEvaluator(discussion, Briefs.evaluatorStepFromOtherText(after, actor.threadId), true);
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
    },
    (effect, _before, after) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban evaluator step note failed", { cardId: after.id, cause }),
        ),
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
  ) {
    const at = yield* nowIso;
    const open = kanbanOpenAsks(card);
    const answered = open.filter(which);
    let next = Asks.closeAsks(card, at, which);
    let current = discussion;
    const told = new Set<string>(
      answeredBy._tag === "thread" || answeredBy._tag === "evaluator" ? [answeredBy.threadId] : [],
    );
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
        body: answeredBy._tag === "owner" ? "Owner replied" : "Question dropped",
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
      if (asker?._tag === "evaluator" && !told.has(asker.threadId)) {
        if (yield* liveEvaluator(asker.threadId)) {
          current = yield* deliver(current, asker, "Evaluator", asker.threadId, text, note);
          told.add(asker.threadId);
        } else {
          current = yield* toEvaluator(current, text, note);
          if (current.evaluatorThreadId !== null) told.add(current.evaluatorThreadId);
        }
      }
    } else if (next !== card) {
      // Still waiting: the question shown is the blocking ask whose asker gets the answer.
      const blocking = next.stage === "needs_owner" ? Asks.openBlockingAsk(next) : undefined;
      next = { ...next, question: blocking?.text ?? next.question, updatedAt: at };
    }
    if (next !== card) yield* saveCard(next);
    // The rest hear it where they are: a live asker directly, anyone else
    // through the card discussion's evaluator.
    for (const ask of answered) {
      const by = ask.by;
      // Whoever answers or drops their own question isn't told about it.
      if (actorKey(by) === actorKey(answeredBy)) continue;
      if (by._tag === "thread" || by._tag === "evaluator") {
        if (told.has(by.threadId)) continue;
        const role = by._tag === "evaluator" ? "Evaluator" : roleName(next.activeRole ?? "work");
        const live =
          by._tag === "thread"
            ? by.threadId === next.activeThreadId
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
        by._tag === "thread" ? Asks.passOnText(next, ask, text) : text,
        note,
      );
      if (current.evaluatorThreadId !== null) told.add(current.evaluatorThreadId);
    }
    if (unblock) yield* kick;
    return { told, discussion: current, card: next };
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
  ) {
    let current = discussion;
    if (current.cardId !== null) {
      let card = yield* cardOf(current.cardId);
      let told = new Set<string>();
      if (from === "owner" && kanbanNeedsOwner(card)) {
        const result = yield* answerAsks(current, card, text, pick ?? (() => true));
        ({ told, discussion: current, card } = result);
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

  /** `route` false posts without passing it on: an owner's own question on his move. */
  const postUnlocked = Effect.fn("KanbanService.postUnlocked")(function* (
    discussionId: KanbanDiscussion["id"],
    author: KanbanActor,
    blocks: ReadonlyArray<KanbanBlock>,
    route = true,
  ) {
    if (blocks.length === 0)
      return yield* failWith("invalid", "a message needs at least one block");
    const discussion = yield* discussionOf(discussionId);
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
    const claim = yield* attachments.claim(discussion.boardId, blocks);
    const storedBlocks = [...claim.blocks];
    const message: KanbanMessage = {
      discussionId,
      seq: discussion.lastSeq + 1,
      author,
      authorName,
      blocks: storedBlocks,
      answers: [],
      createdAt: at,
    };
    yield* store.putMessage(message).pipe(
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
    if (author._tag === "owner" && (yield* wantsWrittenTitle(discussion))) {
      yield* forkDiscussionTitle(discussion.id, text);
    }
    if (!route) return message;
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
        yield* threads.send({
          threadId: card.activeThreadId,
          text: `Evaluator in the discussion of card #${card.number} (${posted.id}):\n\n${text}`,
        });
      }
    } else if (
      author._tag === "thread" &&
      posted.cardId !== null &&
      asksSomething(storedBlocks, text)
    ) {
      // Nothing else reads a worker's post, so its question goes to the discussion's evaluator.
      const card = yield* cardOf(posted.cardId);
      yield* toEvaluator(
        posted,
        Briefs.workerQuestionText(card.number, posted.id, author.threadId, text),
        true,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban worker question routing failed", { cardId: card.id, cause }),
        ),
      );
    }
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

  /** A finished turn settles the agent's typing and, once, nudges an unanswered discussion. */
  const settleParticipant = Effect.fn("KanbanService.settleParticipant")(function* (
    discussion: KanbanDiscussion,
    threadId: ThreadId,
  ) {
    const participant = discussion.participants.find(
      (candidate) =>
        (candidate.actor._tag === "thread" || candidate.actor._tag === "evaluator") &&
        candidate.actor.threadId === threadId,
    );
    if (!participant) return;
    if (participant.owes === "asked") {
      yield* threads
        .send({ threadId, text: Briefs.nudgeDiscussionText(discussion.id) })
        .pipe(Effect.ignore);
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

  const startCard = Effect.fn("KanbanService.startCard")(function* (
    board: KanbanBoard,
    dispatch: Rules.Dispatch,
  ) {
    const card = yield* cardOf(dispatch.cardId);
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
      const view = yield* threads.view(existing);
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
      if (view && view.state !== "idle" && !dispatch.joins) return;
      if (view) {
        threadId = existing;
        // The reused thread now runs on this model; its link must say so, or an
        // outage would be read against the old model's pool.
        const reused = yield* store.threadLink(existing);
        if (reused && Rules.poolKey(reused.model ?? board.evaluatorModel) !== Rules.poolKey(dispatch.model)) {
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
      yield* threads.send({ threadId, text, model: dispatch.model });
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
  });

  const dispatchUnlocked = Effect.fn("KanbanService.dispatchUnlocked")(function* () {
    yield* Ref.set(kickPending, false);
    const random = yield* Random.Random;
    const pick = (count: number) => Math.floor(random.nextDoubleUnsafe() * count);
    yield* seedDown;
    const downKeys = new Set((yield* Ref.get(down)).keys());
    for (const board of yield* store.boards) {
      if (board.archivedAt !== null) continue;
      const plan = Rules.planDispatch(
        board,
        yield* store.cards(board.id),
        Rules.maskDownPools(yield* store.pools(board.id), downKeys),
        yield* boardHolds(board.id),
        pick,
      );
      for (const dispatch of plan) {
        yield* startCard(board, dispatch).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("kanban dispatch failed", { cardId: dispatch.cardId, cause }),
          ),
        );
      }
    }
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
    for (const { link, board } of yield* pausedLinks) keys.add(linkKey(link, board));
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

  /** Marks a thread paused on the model its failed run used. A reused evaluator is reopened so it stays wakeable. */
  const pauseThread = Effect.fn("KanbanService.pauseThread")(function* (
    link: KanbanThreadLink,
    model: ModelSelection,
    message: string,
  ) {
    const at = yield* nowIso;
    const now = yield* nowMillis;
    yield* store.putThreadLink({
      ...link,
      model,
      endedAt: link.role === "evaluator" ? null : link.endedAt,
      paused: { at: link.paused?.at ?? at, message },
    });
    const key = Rules.modelKey(model);
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
   * Posts to the "Provider outages" discussion of each board in `only` that has threads
   * waiting on `key`, with how many. Returns the boards whose post landed. A failed post
   * is logged and left out, so the caller retries it next time; it never fails the probe.
   */
  const alertBoards = Effect.fn("KanbanService.alertBoards")(function* (
    key: string,
    only: ReadonlySet<KanbanBoard["id"]>,
    text: (count: number) => string,
  ) {
    const counts = new Map<KanbanBoard["id"], number>();
    for (const { link, board } of yield* pausedLinks) {
      if (linkKey(link, board) === key && only.has(board.id)) {
        counts.set(board.id, (counts.get(board.id) ?? 0) + 1);
      }
    }
    const delivered = new Set<KanbanBoard["id"]>();
    for (const [boardId, count] of counts) {
      const posted = yield* Effect.gen(function* () {
        const existing = (yield* store.discussions(boardId)).find(
          (discussion) =>
            discussion.cardId === null &&
            discussion.archivedAt === null &&
            discussion.title === OUTAGE_TITLE,
        );
        const discussion = existing ?? (yield* newDiscussion(boardId, OUTAGE_TITLE, null, outageActor));
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
    // Only boards that were announced get a "back" message, once per outage: a board
    // is recorded as recovered as soon as its post lands, so a rejected wake below
    // doesn't repeat it on the next probe.
    // The whole step is optional: a failed read here (boards or links) must not abort
    // the wakes below, or the other probe keys in this run.
    yield* Effect.gen(function* () {
      const state = (yield* Ref.get(down)).get(key);
      if (state === undefined) return;
      const pending = new Set<KanbanBoard["id"]>();
      for (const id of state.announced) if (!state.recovered.has(id)) pending.add(id);
      if (pending.size === 0) return;
      const backed = yield* alertBoards(
        key,
        pending,
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
    let failed = false;
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
        .send({ threadId: link.threadId, text: Briefs.providerBackText(link.paused.message) })
        .pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        );
      if (!sent) {
        failed = true;
        continue;
      }
      yield* store.putThreadLink({ ...link, paused: null });
    }
    if (failed) return;
    yield* Ref.update(down, (map) => {
      const next = new Map(map);
      next.delete(key);
      return next;
    });
    yield* kick;
  });

  /** A stopped worker hears about its cards still in Working, every time. nudgedAt records the last nudge instead of a card event, so a looping worker can't flood the history. */
  const nudgeWorker = Effect.fn("KanbanService.nudgeWorker")(function* (
    threadId: ThreadId,
    cards: ReadonlyArray<KanbanCard>,
  ) {
    const nudge = cards.filter((card) => card.stage === "working" && card.stalled === null);
    if (nudge.length === 0) return;
    const at = yield* nowIso;
    yield* threads.send({ threadId, text: Briefs.nudgeWorkText(nudge) }).pipe(Effect.ignore);
    for (const card of nudge) yield* saveCard({ ...card, nudgedAt: at, updatedAt: at });
  });

  /** A reviewer whose turn ended with no verdict: nudged once, then flagged and its slot freed. */
  const reviewerStopped = Effect.fn("KanbanService.reviewerStopped")(function* (
    card: KanbanCard,
    threadId: ThreadId,
  ) {
    const at = yield* nowIso;
    const system: KanbanActor = { _tag: "system", component: "dispatcher" };
    if (card.nudgedAt === null) {
      yield* threads.send({ threadId, text: Briefs.nudgeReviewText(card) }).pipe(Effect.ignore);
      yield* saveCard({ ...card, nudgedAt: at, updatedAt: at });
      return;
    }
    // A reviewer that still has no verdict after the nudge frees its slot and is flagged.
    const reason = "Reviewer stopped without a verdict";
    const next: KanbanCard = {
      ...release(card),
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

  const turnEndedUnlocked = Effect.fn("KanbanService.turnEndedUnlocked")(function* (
    threadId: ThreadId,
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
    const card = link.cardId ? yield* store.card(link.cardId) : null;
    const carriedIds = link.role === "work" ? yield* store.threadCards(threadId) : [];

    const discussionIds = new Set<string>();
    if (link.discussionId) discussionIds.add(link.discussionId);
    if (card?.discussionId) discussionIds.add(card.discussionId);
    for (const id of carriedIds) {
      const other = id === card?.id ? card : yield* store.card(id);
      if (other?.discussionId) discussionIds.add(other.discussionId);
    }
    // A run that failed (the provider refused the model or variant, or a route is gone)
    // would only loop on a nudge, so the failure is read first and nothing is nudged.
    const failure = yield* threads.lastFailure(threadId);
    // Out of usage or down: a nudge or a flag can't help, so the thread waits for
    // probeOutages to wake it on the same model.
    const outage = failure !== null && Rules.isOutage(failure) ? failure : null;
    if (outage !== null) {
      // A card_edit switches the open thread's model without touching its link.
      const model =
        (yield* threads.model(threadId)) ??
        link.model ??
        (yield* boardOf(link.boardId)).evaluatorModel;
      yield* pauseThread(link, model, outage.message);
    }
    else if (link.paused !== null) yield* store.putThreadLink({ ...link, paused: null });
    // Discussions the thread evaluates, or is still typing or owing in after
    // being told something there (which the link and card don't name).
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
        if (failure === null) yield* settleParticipant(discussion, threadId);
        else if (participant && pending) {
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
      // A paused evaluator stays open so it can be woken. `link` is stale once its
      // pause was set or cleared above, so the current row is ended.
      if (link.discussionId === null && link.endedAt === null && outage === null) {
        const current = (yield* store.threadLink(threadId)) ?? link;
        yield* store.putThreadLink({ ...current, endedAt: at });
      }
      return;
    }
    const system: KanbanActor = { _tag: "system", component: "dispatcher" };
    if (link.role === "work") {
      // The turn is over, so a slot held for a next card is free again.
      if ((yield* Ref.get(holds)).has(threadId)) {
        yield* dropHold(threadId);
        yield* kick;
      }
      const carried = yield* Effect.forEach(yield* store.cardsByThread(threadId), syncPrs);
      if (carried.length === 0) {
        yield* kick;
        return;
      }
      // Paused: the card keeps its thread until probeOutages wakes it.
      if (outage !== null) return;
      if (failure !== null) {
        const reason = `Run failed: ${failure.message}`;
        for (const entry of carried) {
          // A thread too long to send again can't run the card: the next
          // dispatch starts it on a fresh thread.
          if (Rules.isContextFull(failure) && !(yield* freshStartedRecently(entry, at))) {
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
          const next: KanbanCard = {
            ...release(entry),
            stage: "todo",
            stalled: { reason, by: system, at },
            nudgedAt: null,
            movedAt: at,
            updatedAt: at,
          };
          yield* logEvent(next, system, "flagged", {
            fromStage: entry.stage,
            toStage: "todo",
            body: reason,
          });
          yield* saveCard(next);
          yield* noteDiscussion(
            next,
            Briefs.runFailedText(next, "work", failure.message, "todo"),
          ).pipe(Effect.catchCause((cause) => Effect.logWarning("kanban run note failed", { cause })));
        }
        yield* kick;
        return;
      }
      // A card can't sit in Working while its worker is stopped: every quiet
      // turn end nudges it (see nudgeWorker).
      const view = yield* threads.view(threadId);
      // A repeated run event can arrive while the thread runs again.
      if (view === null || view.state !== "idle") return;
      // A worker waiting on its own subagents hasn't stopped.
      if (Rules.waitingOnBackground(view, yield* nowMillis)) return;
      yield* nudgeWorker(threadId, carried);
      return;
    }
    if (!card) return;
    if (card.activeThreadId !== threadId) {
      yield* kick;
      return;
    }
    if (outage !== null) return;
    if (failure !== null) {
      if (Rules.isContextFull(failure) && !(yield* freshStartedRecently(card, at))) {
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
      const next: KanbanCard = {
        ...release(card),
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
    yield* reviewerStopped(card, threadId);
  });

  const tickUnlocked = Effect.fn("KanbanService.tickUnlocked")(function* () {
    const now = yield* nowMillis;
    // A hold lasts for the turn; a missed turn end or a thread stuck waiting
    // on something must not keep the slot.
    for (const [threadId, held] of yield* Ref.get(holds)) {
      const view = yield* threads.view(threadId);
      if (!view || view.state !== "running" || now - held.at > HOLD_MAX_MS) {
        yield* dropHold(threadId);
        yield* kick;
      }
    }
    const missed = new Set<ThreadId>();
    const before = yield* Ref.get(missing);
    for (const board of yield* store.boards) {
      if (board.archivedAt !== null) continue;
      // The scribe regroups at most every SCRIBE_EVERY_MS, and only when open cards changed.
      const fingerprint = Scribe.groupsFingerprint(yield* store.cards(board.id));
      const last = (yield* Ref.get(scribed)).get(board.id);
      const cooled = last === undefined || now - last.at >= Scribe.SCRIBE_EVERY_MS;
      // A failed attempt is retried once the cooldown has passed, cards changed or not.
      const due =
        fingerprint !== "" &&
        cooled &&
        (last === undefined || !last.done || fingerprint !== last.fingerprint);
      if (due) {
        yield* Ref.update(scribed, (all) =>
          new Map(all).set(board.id, { fingerprint, at: now, done: false }),
        );
        yield* forkGroups(board.id);
      }
      const goalsPrint = Scribe.goalsFingerprint(
        yield* store.cards(board.id),
        yield* store.goals(board.id),
      );
      const lastGoals = (yield* Ref.get(goalsScribed)).get(board.id);
      // A failed or held-back attempt is retried after the cooldown, cards unchanged or not.
      const goalsDue =
        goalsPrint !== "" &&
        (lastGoals === undefined || now - lastGoals.at >= Scribe.SCRIBE_EVERY_MS) &&
        (lastGoals === undefined || !lastGoals.done || goalsPrint !== lastGoals.fingerprint);
      if (goalsDue) {
        yield* Ref.update(goalsScribed, (all) =>
          new Map(all).set(board.id, { fingerprint: goalsPrint, at: now, done: false }),
        );
        yield* forkGoals(board.id);
      }
      // Goal ideas: checked every PROPOSAL_CHECK_MS per board, asked only when due.
      const checked = (yield* Ref.get(proposalsChecked)).get(board.id);
      const running = (yield* Ref.get(proposalsRunning)).has(board.id);
      if (!running && (checked === undefined || now - checked >= Scribe.PROPOSAL_CHECK_MS)) {
        yield* Ref.update(proposalsChecked, (all) => new Map(all).set(board.id, now));
        const ideas = yield* ideasDiscussion(board.id);
        const last =
          ideas === null
            ? null
            : ((yield* ideaMessages(ideas.id)).filter((message) => message.author._tag === "system").at(-1) ??
              null);
        if (Scribe.proposalDue(yield* store.cards(board.id), yield* store.goals(board.id), last, now)) {
          yield* Ref.update(proposalsRunning, (all) => new Set(all).add(board.id));
          yield* forkProposals(board.id);
        }
      }
      // A card whose thread was deleted goes back to its queue for a new one.
      for (const card of yield* store.cards(board.id)) {
        const threadId = card.activeThreadId;
        if (threadId === null || (yield* threads.view(threadId))) continue;
        missed.add(threadId);
        if (!before.has(threadId)) continue;
        const at = yield* nowIso;
        const review = card.activeRole === "review";
        const next: KanbanCard = {
          ...release(card),
          stage: review ? "needs_review" : "todo",
          workThreadId: review ? card.workThreadId : null,
          reviewThreadId: review ? null : card.reviewThreadId,
          movedAt: at,
          updatedAt: at,
        };
        yield* logEvent(next, { _tag: "system", component: "dispatcher" }, "moved", {
          fromStage: card.stage,
          toStage: next.stage,
          body: "Its thread is gone",
        });
        yield* saveCard(next);
      }
      // Backstop for a missed turn end, or a worker stuck on its own question.
      for (const card of yield* store.cards(board.id)) {
        const threadId = card.activeThreadId;
        if (threadId === null || card.activeRole !== "work") continue;
        // A paused worker waits for probeOutages, not a nudge.
        if ((yield* store.threadLink(threadId))?.paused) continue;
        const view = yield* threads.view(threadId);
        if (
          view === null ||
          Rules.waitingOnBackground(view, now) ||
          !Rules.workerQuietDue(card, view, now)
        )
          continue;
        if (view.state === "needs-input") {
          // Its turn end after the interrupt brings the nudge.
          yield* threads.interrupt(threadId, "Stuck on its own question; the board nudges it");
          const at = yield* nowIso;
          yield* logEvent(card, { _tag: "system", component: "dispatcher" }, "thread", {
            body: "Interrupted: stuck on its own question",
          });
          yield* saveCard({ ...card, nudgedAt: at, updatedAt: at });
          continue;
        }
        yield* nudgeWorker(threadId, [card]);
      }
      // Backstop for a reviewer left idle with no verdict: a turn end skipped while
      // its own background work ran, or one that never arrived.
      for (const card of yield* store.cards(board.id)) {
        const threadId = card.activeThreadId;
        if (threadId === null || card.activeRole !== "review") continue;
        if ((yield* store.threadLink(threadId))?.paused) continue;
        const view = yield* threads.view(threadId);
        if (
          view === null ||
          Rules.waitingOnBackground(view, now) ||
          !Rules.reviewerQuietDue(card, view, now)
        )
          continue;
        yield* reviewerStopped(card, threadId);
      }
      // A long evaluator turn gets a status ask at 45 minutes, then hourly, so nobody waits blind.
      for (const link of yield* store.threadLinks({ boardId: board.id, open: true })) {
        if (link.role !== "evaluator") continue;
        // A failed read skips this thread and keeps its ask record, so a blip
        // can't make the next healthy tick ask again inside the hour.
        const read = yield* Effect.result(threads.find(link.threadId));
        if (read._tag === "Failure") continue;
        const view = read.success;
        if (view?.state !== "running" || view.runStartedAt === null) {
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
        const minutes = Math.round((now - started) / 60_000);
        const sent = yield* threads
          .send({
            threadId: link.threadId,
            text: `Board check: this turn has been running for ${minutes} minutes. Post a one-line status where Abdullah reads it (your discussion, with discussion_post): what you're doing and when you expect to finish. Then carry on; don't stop for this.`,
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
      // Typing heartbeat.
      for (const discussion of yield* store.discussions(board.id)) {
        let next = discussion;
        for (const participant of discussion.participants) {
          if (participant.typingUntil === null) continue;
          const actor = participant.actor;
          if (actor._tag !== "thread" && actor._tag !== "evaluator") continue;
          const view = yield* threads.view(actor.threadId);
          // Typing is kept alive only where the agent is working on a reply.
          // Once it lapses, a non-home thread's owes go too; home keeps them so
          // its turn end still nudges.
          if (view && view.state !== "idle" && (yield* isHome(discussion, actor.threadId))) {
            next = withParticipant(next, actor, participant.name, {
              typingUntil: yield* typingUntil,
            });
          } else if (Date.parse(participant.typingUntil) < now) {
            const home = yield* isHome(discussion, actor.threadId);
            next = withParticipant(next, actor, participant.name, {
              typingUntil: null,
              owes: home ? participant.owes : null,
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
          const view = yield* threads.view(threadId);
          if (view !== null && view.state !== "idle") working = true;
        }
        if (working) continue;
        yield* saveDiscussion({ ...discussion, settledAt: idleNow, snoozedUntil: null });
      }
      // Reviewed cards wait in review until their PRs land.
      const chains = board.reviewChains;
      for (const card of yield* store.cards(board.id)) {
        if (card.stage !== "in_review" || card.activeThreadId !== null) continue;
        const chain = Rules.chainFor({ ...board, reviewChains: chains }, card);
        if (!Rules.reviewFinished(card, chain?.steps.length ?? 1)) continue;
        const synced = yield* syncPrs(card);
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
      }
    }
    // A pool whose model left the composer's list drops to 0 slots after two
    // ticks in a row, so a provider refresh blip never pauses a board. A model
    // that returns is not raised back up; the owner does that.
    const listed = yield* models.listed;
    const unlistedBefore = yield* Ref.get(unlistedPools);
    const unlistedNow = new Set<string>();
    for (const board of yield* store.boards) {
      if (board.archivedAt !== null) continue;
      let zeroed = false;
      for (const pool of yield* store.pools(board.id)) {
        if (pool.slots === 0 || isListed(listed, pool.model) !== false) continue;
        const id = `${board.id}:${pool.key}`;
        unlistedNow.add(id);
        if (!unlistedBefore.has(id)) continue;
        yield* store.putPool(board.id, { ...pool, slots: 0 });
        yield* Effect.logInfo(`board ${board.slug}: pool ${pool.key} left the model list, now 0 slots`);
        zeroed = true;
      }
      if (zeroed) {
        yield* publish(board.id, { _tag: "pools", pools: yield* store.pools(board.id) });
        yield* kick;
      }
    }
    yield* Ref.set(unlistedPools, unlistedNow);
    yield* Ref.set(missing, missed);
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
    // Snapshot and reconcile under one lock hold: a turnEnded between the two would
    // record an outage the snapshot misses, and the filter would drop it.
    const models = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        yield* seedDown;
        const found = new Map<string, ModelSelection>();
        for (const { link, board } of yield* pausedLinks) {
          const model = link.model ?? board.evaluatorModel;
          found.set(Rules.modelKey(model), model);
        }
        // A key whose threads all came back on their own is up again. A key with paused
        // links but no state is marked down now, so dispatch holds it while the probe
        // below is in flight.
        yield* Ref.update(down, (map) => {
          const next = new Map([...map].filter(([key]) => found.has(key)));
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
      if (yield* probeModel(model)) {
        yield* lock.withPermits(1)(resumeKey(key));
        continue;
      }
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
        const unannounced = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const boards = new Set<KanbanBoard["id"]>();
            for (const { link, board } of yield* pausedLinks) {
              if (linkKey(link, board) === key) boards.add(board.id);
            }
            const announced = (yield* Ref.get(down)).get(key)?.announced ?? new Set();
            const unannounced = new Set<KanbanBoard["id"]>();
            for (const id of boards) if (!announced.has(id)) unannounced.add(id);
            return unannounced;
          }),
        );
        if (unannounced.size > 0) {
          const posted = yield* lock.withPermits(1)(
            alertBoards(
              key,
              unannounced,
              (count) =>
                `${key} is out of usage or down: ${count} thread${count === 1 ? "" : "s"} paused. They wake by themselves when a probe passes (every 5 to 30 minutes). Cards that list another model start there meanwhile.`,
            ),
          );
          yield* Ref.update(down, (map) => {
            const entry = map.get(key);
            if (!entry) return map;
            return new Map(map).set(key, {
              ...entry,
              announced: new Set([...entry.announced, ...posted]),
            });
          });
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("kanban outage alert failed", { key, cause })),
      );
    }
  });

  const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    lock.withPermits(1)(effect).pipe(Effect.mapError(toKanbanError));
  const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(toKanbanError));

  /** Every model a board uses, deduped by pool key. */
  const boardModels = (board: KanbanBoard): Array<ModelSelection> => {
    const seen = new Map<string, ModelSelection>();
    const add = (model: ModelSelection) => {
      const key = Rules.poolKey(model);
      if (!seen.has(key)) seen.set(key, model);
    };
    add(board.managerModel);
    add(board.evaluatorModel);
    add(board.defaultCardModel);
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
        const slug = input.slug.trim().toLowerCase();
        if ((yield* store.boards).some((board) => board.slug === slug)) {
          return yield* failWith("conflict", `a board with slug ${slug} already exists`);
        }
        return yield* insertBoardUnlocked({ ...input, slug });
      }),
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
    if (input.managerModel) yield* checkModel(input.managerModel);
    if (input.evaluatorModel) yield* checkModel(input.evaluatorModel);
    if (input.defaultCardModel) yield* checkModel(input.defaultCardModel);
    const slug = input.slug.trim().toLowerCase();
    const board: KanbanBoard = {
      id: KanbanBoardId.make(`board-${slug}`),
      slug,
      name: input.name.trim() || slug,
      icon: null,
      iconImage: null,
      defaultProjectId: input.defaultProjectId,
      managerModel: input.managerModel ?? Defaults.DEFAULT_MANAGER_MODEL,
      evaluatorModel: input.evaluatorModel ?? Defaults.DEFAULT_EVALUATOR_MODEL,
      defaultCardModel: input.defaultCardModel ?? Defaults.DEFAULT_CARD_MODEL,
      reviewChains: [],
      defaultReviewChain: null,
      instructions: Defaults.DEFAULT_INSTRUCTIONS,
      setup: null,
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
        const slug = input.slug.trim().toLowerCase();
        const existing = (yield* store.boards).find((board) => board.slug === slug);
        if (existing) return existing;
        return yield* insertBoardUnlocked({ ...input, slug });
      }),
    );

  const updateBoard: KanbanServiceShape["updateBoard"] = (boardId, patch) =>
    guard(
      Effect.gen(function* () {
        const board = yield* boardOf(boardId);
        const next: KanbanBoard = { ...board, ...patch };
        if (patch.managerModel) yield* checkModel(patch.managerModel);
        if (patch.evaluatorModel) yield* checkModel(patch.evaluatorModel);
        if (patch.defaultCardModel) yield* checkModel(patch.defaultCardModel);
        // Only steps that differ from the stored chain are checked. A step already saved
        // (even if its model has since left the catalog) must not block fixing another step.
        for (const chain of patch.reviewChains ?? []) {
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
      }),
    );

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
      model:
        models[0]?.model ??
        (yield* poolModel(boardId, input.model ?? board.defaultCardModel)),
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
    // A thread's or a script's card waits for an evaluator to write its packet;
    // the owner's and the evaluators' own come written.
    const packet = actor._tag === "thread" || actor._tag === "script";
    const fields = packet
      ? { ...input, subtasks: Subtasks.withPacketStep(input.subtasks ?? []) }
      : input;
    const card = yield* insertCard(yield* draftCard(boardId, fields, actor), fields);
    if (packet) yield* evaluatorTurn(null, card, actor);
    const ask = Asks.openBlockingAsk(card);
    return ask ? yield* postAsk(card, ask, []) : card;
  });

  const createCard: KanbanServiceShape["createCard"] = (boardId, input, actor) =>
    guard(createCardUnlocked(boardId, input, actor));

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
      carrying: thread.carried.length,
      slots,
      pools,
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
        const draft = yield* draftCard(thread.board.id, fields, { _tag: "thread", threadId });
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
    guard(
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        const at = yield* nowIso;
        const pools = yield* store.pools(card.boardId);
        const models = patch.models ? yield* cardModels(card.boardId, patch.models) : null;
        const model = models
          ? // A card with a work thread stays on its pool while the list still has it; the list's
            // entry carries the pool's variant, so a variant change sticks.
            (card.workThreadId !== null
              ? models.find(
                  (entry) => Rules.poolOf(pools, entry.model) === Rules.poolOf(pools, card.model),
                )?.model
              : undefined) ?? (models[0]?.model ?? card.model)
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
        yield* evaluatorTurn(card, saved, actor);
        if (patch.prompt?.trim() && patch.prompt.trim() !== card.prompt && !patch.title) {
          yield* forkWriter(card.id, { title: true, description: !patch.description });
        }
        if (plan?.ok && saved.activeThreadId !== null) {
          // The thread on the card works from the plan it was given; tell it the new one.
          yield* threads
            .send({ threadId: saved.activeThreadId, text: Briefs.planChangedText(saved) })
            .pipe(Effect.ignore);
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
          yield* threads
            .setModel(saved.activeThreadId, saved.model)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("kanban thread model switch failed", { cardId: saved.id, cause }),
              ),
            );
        }
        yield* kick;
        return saved;
      }),
    );

  const moveCard: KanbanServiceShape["moveCard"] = (cardId, to, role, actor, options) =>
    guard(
      Effect.gen(function* () {
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
        yield* evaluatorTurn(card, moved, actor);
        if (to === "needs_review") return yield* syncPrs(moved);
        const ask = Asks.openBlockingAsk(moved);
        if (to === "needs_owner" && ask !== undefined && ask.seq === null) {
          return yield* postAsk(moved, ask, []);
        }
        return moved;
      }),
    );

  /** Posts an ask in the card's discussion (never routed: it's for the owner) and keeps its seq. */
  const postAsk = Effect.fn("KanbanService.postAsk")(function* (
    card: KanbanCard,
    ask: KanbanOwnerAsk,
    options: ReadonlyArray<string>,
    multi = false,
  ) {
    const discussion = yield* cardDiscussionUnlocked(card.id);
    const message = yield* postUnlocked(
      discussion.id,
      ask.by,
      Asks.askBlocks(ask, options, multi),
      false,
    );
    const next = Asks.updateAsk(yield* cardOf(card.id), ask.id, { seq: message.seq });
    yield* saveCard(next);
    return next;
  });

  /** A card thread acts only on the card it is running. */
  const checkCardThread = (card: KanbanCard, actor: KanbanActor, role: Rules.MoveRole) =>
    role === "cardThread" && (actor._tag !== "thread" || card.activeThreadId !== actor.threadId)
      ? failWith("denied", `card #${card.number} is not assigned to this thread`)
      : Effect.void;

  const askOwner: KanbanServiceShape["askOwner"] = (cardId, input, actor, role) =>
    guard(
      Effect.gen(function* () {
        const card = yield* cardOf(cardId);
        yield* checkCardThread(card, actor, role);
        const question = input.question.trim();
        if (!question) return yield* failWith("invalid", "an ask needs the question");
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
          yield* evaluatorTurn(card, next, actor);
        }
        const ask = next.asks.at(-1);
        return ask ? yield* postAsk(next, ask, input.options ?? [], input.multi ?? false) : next;
      }),
    );

  const changeAsk: KanbanServiceShape["changeAsk"] = (cardId, askId, action, actor, role) =>
    guard(
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
        yield* evaluatorTurn(card, next, actor);
        return next;
      }),
    );

  const flagCard: KanbanServiceShape["flagCard"] = (cardId, reason, actor) =>
    guard(
      Effect.gen(function* () {
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
          if (discussion !== null && discussion.settledAt === null && discussion.pinnedAt === null) {
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
        const card = yield* cardOf(cardId);
        const scriptName =
          role === "script" ? (yield* scriptFor(card, actor)).name : null;
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
        yield* evaluatorTurn(card, next, actor);
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
        yield* noteDiscussion(next, Briefs.handBackText(next, subtaskId, script.name, trimmed)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("kanban hand-back note failed", cause),
          ),
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

  const reviewResult: KanbanServiceShape["reviewResult"] = (
    threadId,
    verdict,
    findings,
    head,
  ) =>
    guard(
      Effect.gen(function* () {
        const link = yield* store.threadLink(threadId);
        if (!link || link.role !== "review" || link.cardId === null) {
          return yield* failWith("denied", "only a card's review thread records a review result");
        }
        const card = yield* cardOf(link.cardId);
        const live = card.activeThreadId === threadId && card.stage === "in_review";
        const late = !live && (yield* lateReviewer(card, threadId));
        if (!live && !late) {
          return yield* failWith(
            "conflict",
            `card #${card.number} is not in review with this thread`,
          );
        }
        if (verdict === "findings" && findings.length === 0) {
          return yield* failWith("invalid", "findings need at least one line");
        }
        const sha = head?.trim().toLowerCase() || null;
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
        const body =
          verdict === "findings" ? findings.map((line) => `- ${line.trim()}`).join("\n") : "clear";
        // The last review step passing ticks off the step's review subtasks. If
        // the plan then has more work, the card goes back to its worker.
        const passed = verdict === "clear" && !outcome.continueReview;
        const subtasks = passed
          ? Subtasks.passReview(card, { _tag: "thread", threadId }, at)
          : card.subtasks;
        const moreWork = passed && Subtasks.workAfterReview({ subtasks });
        const next: KanbanCard = {
          ...release(card),
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
                : card.wakeNote,
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
              Effect.logWarning("kanban third review round note failed", { cardId: next.id, cause }),
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
        const card = yield* cardOf(cardId);
        const at = yield* nowIso;
        if (action === "steer") {
          const threadId = card.activeThreadId ?? card.workThreadId;
          if (threadId === null)
            return yield* failWith("invalid", `card #${card.number} has no thread`);
          // A released sibling still points at the shared thread. The thread runs its own
          // current model (a switch moved it, and it survives every card's release), so a
          // steer sends that rather than the sibling's stale one.
          const threadModel =
            card.activeThreadId === null ? yield* threads.model(threadId) : null;
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
            card.stage === "working" ? "todo" : card.stage === "in_review" ? "needs_review" : card.stage;
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
          const model =
            card.activeRole === "review"
              ? Rules.nextModel(yield* boardOf(card.boardId), card)
              : card.model;
          if (text.trim())
            yield* threads.send({ threadId: card.activeThreadId, text, model });
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
        yield* evaluatorTurn(card, next, actor);
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
    if (exact !== undefined || Rules.modelLevel(model) !== null) return exact;
    if (same.length > 1) {
      const levels = same.map((pool) => Rules.modelLevel(pool.model) ?? "no level").join(", ");
      return yield* failWith("invalid", `${model.model} has pools at ${levels}; name the level`);
    }
    return same[0];
  });

  const setPool: KanbanServiceShape["setPool"] = (boardId, model, slots) =>
    guard(
      Effect.gen(function* () {
        const board = yield* boardOf(boardId);
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

  const removePool: KanbanServiceShape["removePool"] = (boardId, model) =>
    guard(
      Effect.gen(function* () {
        const board = yield* boardOf(boardId);
        const pools = yield* store.pools(board.id);
        const pool = yield* namedPool(pools, model);
        if (!pool) return yield* failWith("not-found", `pool ${Rules.poolKey(model)}`);
        const key = pool.key;
        // A model with no pool at its own level runs on its model's first pool (Rules.poolFor).
        const runsHere = (used: ModelSelection) => Rules.poolFor(pools, used)?.key === key;
        if (pool.slots > 0) {
          return yield* failWith("invalid", `${key} has ${pool.slots} slots; set it to 0 before removing`);
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
        const at = yield* nowIso;
        const next = groups.map((group) => ({ ...group, updatedAt: at }));
        yield* store.putGroups(boardId, next);
        yield* publish(boardId, { _tag: "groups", groups: next });
      }),
    );

  const createDiscussion: KanbanServiceShape["createDiscussion"] = (boardId, title, actor) =>
    guard(
      Effect.gen(function* () {
        yield* boardOf(boardId);
        return yield* newDiscussion(boardId, title, null, actor);
      }),
    );

  const updateDiscussion: KanbanServiceShape["updateDiscussion"] = (discussionId, patch, actor) =>
    guard(
      Effect.gen(function* () {
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
        if (patch.pinned === true && (patch.settled === true || typeof patch.snoozedUntil === "string")) {
          return yield* failWith("invalid", "pin, settle or snooze one at a time");
        }
        if (patch.pinned === true) {
          next = { ...next, pinnedAt: next.pinnedAt ?? at, settledAt: null, snoozedUntil: null };
        } else if (patch.pinned === false && next.pinnedAt !== null) {
          next = { ...next, pinnedAt: null, reopenedAt: at };
        }
        if (patch.settled === true) next = { ...next, settledAt: at, snoozedUntil: null, pinnedAt: null };
        else if (patch.settled === false && next.settledAt !== null) {
          next = { ...next, settledAt: null, reopenedAt: at };
        }
        if (patch.snoozedUntil === null) {
          next = next.snoozedUntil === null
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

  const answer: KanbanServiceShape["answer"] = (discussionId, seq, blockId, choice, by, text) =>
    guard(
      Effect.gen(function* () {
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
        const at = yield* nowIso;
        const key = actorKey(by);
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
        yield* store.putMessage(next);
        yield* publish(discussion.boardId, { _tag: "message", message: next });
        if (by._tag !== "owner") return next;
        const said = [
          ...picked.map((option) => option.label),
          ...(words === "" ? [] : [`his own answer: "${words}"`]),
        ].join(", ");
        const note = `Owner answered "${block.question}" in discussion ${discussion.id} (message ${seq}): ${said}`;
        const card = discussion.cardId === null ? null : yield* cardOf(discussion.cardId);
        // A pick on an ask answers that ask alone.
        const ask = card?.asks.find((entry) => entry.id === blockId && entry.seq === seq);
        if (card !== null && ask !== undefined && ask.closedAt === null) {
          yield* routeToOwnerAgent(discussion, note, "owner", (open) => open.id === ask.id);
          return next;
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
          return next;
        }
        // A pick on a card waiting on the owner answers it like a reply does.
        const waiting = card !== null && card.stage === "needs_owner";
        const author = message.author;
        if (!waiting && (author._tag === "thread" || author._tag === "evaluator")) {
          if (yield* liveEvaluator(author.threadId)) {
            yield* deliver(discussion, author, message.authorName, author.threadId, note);
            return next;
          }
        }
        yield* routeToOwnerAgent(discussion, note);
        return next;
      }),
    );

  const markRead: KanbanServiceShape["markRead"] = (discussionId, actor, seq) =>
    guard(
      Effect.gen(function* () {
        const discussion = yield* discussionOf(discussionId);
        const key = actorKey(actor);
        const current = discussion.participants.find(
          (participant) => actorKey(participant.actor) === key,
        );
        if (current && current.lastReadSeq >= seq) return;
        yield* saveDiscussion(
          withParticipant(discussion, actor, current?.name ?? OWNER_NAME, {
            lastReadSeq: Math.min(seq, discussion.lastSeq),
          }),
        );
      }),
    );

  const writeWiki: KanbanServiceShape["writeWiki"] = (boardId, page, actor) =>
    guard(
      Effect.gen(function* () {
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

  // The apps never show a card's prompt (they read one card in full through card), and on big boards prompts are most of the feed.
  const feedCard = (card: KanbanCard): KanbanCard => ({ ...card, prompt: "" });
  const feedChange = (change: KanbanChange): KanbanChange =>
    change._tag === "card" ? { ...change, card: feedCard(change.card) } : change;

  const watch: KanbanServiceShape["watch"] = (boardId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = yield* read(snapshotOf(boardId));
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
            snapshot: { ...snapshot, cards: snapshot.cards.map(feedCard) },
          }),
          live,
        );
      }),
    );

  // Subscribed before the read, so no change falls between the two.
  const boardSummaries: KanbanServiceShape["boardSummaries"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const boards = yield* read(
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

  const runJob = (job: Job) =>
    lock
      .withPermits(1)(job._tag === "kick" ? dispatchUnlocked() : turnEndedUnlocked(job.threadId))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("kanban job failed", { job: job._tag, cause }),
        ),
      );

  return KanbanService.of({
    boards: read(store.boards),
    ensureBoard,
    createBoard,
    updateBoard,
    snapshot: (boardId) => read(snapshotOf(boardId)),
    watch,
    boardSummaries,
    announce: (boardId, change) => Effect.asVoid(publish(boardId, change)),
    changes: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
    card: (cardId) =>
      read(
        Effect.gen(function* () {
          const card = yield* cardOf(cardId);
          return {
            card,
            events: yield* store.cardEvents(cardId),
            threads: yield* store.threadLinks({ cardId }),
          } satisfies CardDetail;
        }),
      ),
    createCard,
    editCard,
    moveCard,
    flagCard,
    settleCard,
    markSubtask,
    handBack,
    askOwner,
    changeAsk,
    reviewResult,
    cardThread,
    setPool,
    removePool,
    setGoal,
    setGroups,
    discussions: (boardId) => read(store.discussions(boardId)),
    threads: (boardId) => read(threadRowsOf(boardId)),
    discussion: (id) => read(discussionOf(id)),
    createDiscussion,
    updateDiscussion,
    cardDiscussion: (cardId) => guard(cardDiscussionUnlocked(cardId)),
    messages: (id, options) => read(store.messages(id, options)),
    post: (discussionId, author, blocks) => guard(postUnlocked(discussionId, author, blocks)),
    attachmentPath: (attachment) => attachments.pathOf(attachment),
    answer,
    markRead,
    wiki: (boardId) => read(store.wiki(boardId)),
    writeWiki,
    endSetup: (boardId, actor) => guard(endSetupUnlocked(boardId, actor)),
    startSetup: (boardId, input) =>
      guard(
        Effect.gen(function* () {
          const board = yield* boardOf(boardId);
          if (board.setup?.status === "running") {
            return yield* failWith("invalid", `board ${board.slug} is already in setup`);
          }
          yield* checkModel(input.evaluatorModel);
          const saved: KanbanBoard = { ...board, evaluatorModel: input.evaluatorModel };
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
    caller: (threadId) => read(store.threadLink(threadId)),
    carried: (threadId) => read(store.cardsByThread(threadId)),
    ownCards: (threadId) =>
      read(
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
    dispatchNow: guard(dispatchUnlocked()),
    turnEnded: (threadId) => guard(turnEndedUnlocked(threadId)),
    tick: guard(tickUnlocked()),
    probeOutages: read(probeOutagesNow()),
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
    worker: Queue.take(jobs).pipe(Effect.flatMap(runJob), Effect.forever),
  });
});

export const layer = Layer.effect(KanbanService, make);
