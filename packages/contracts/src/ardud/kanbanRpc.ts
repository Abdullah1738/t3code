/**
 * WebSocket RPCs for the Missions board (code name kanban). Reads need
 * `orchestration:read`; the owner's changes need `orchestration:operate`.
 * Agents change the board through MCP tools instead.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";
import {
  KanbanBlockInput,
  KanbanBoard,
  KanbanBoardIcon,
  KanbanBoardIconImage,
  KanbanBoardId,
  KanbanBoardListEntry,
  KanbanBoardSnapshot,
  KanbanCard,
  KanbanCardEvent,
  KanbanCardId,
  KanbanChange,
  KanbanDiscussion,
  KanbanDiscussionId,
  KanbanError,
  KanbanGoalId,
  KanbanInstructions,
  KanbanMessage,
  KanbanPool,
  KanbanPriority,
  KanbanReviewChain,
  KanbanScript,
  KanbanScriptId,
  KanbanScriptRun,
  KanbanStage,
  KanbanThreadLink,
  KanbanThreadRow,
  KanbanWikiPage,
} from "./kanban.ts";

export const KANBAN_WS_METHODS = {
  boards: "kanban.boards",
  subscribe: "kanban.subscribe",
  card: "kanban.card",
  discussions: "kanban.discussions",
  threads: "kanban.threads",
  owner: "kanban.owner",
  messages: "kanban.messages",
  message: "kanban.message",
  wiki: "kanban.wiki",
  boardCreate: "kanban.board.create",
  boardUpdate: "kanban.board.update",
  setupStart: "kanban.setup.start",
  setupEnd: "kanban.setup.end",
  boardPause: "kanban.board.pause",
  cardPatch: "kanban.card.patch",
  cardSettle: "kanban.card.settle",
  cardStop: "kanban.card.stop",
  cardAsk: "kanban.card.ask",
  cardDiscussion: "kanban.card.discussion",
  poolSet: "kanban.pool.set",
  poolRemove: "kanban.pool.remove",
  discussionCreate: "kanban.discussion.create",
  discussionRead: "kanban.discussion.read",
  discussionUpdate: "kanban.discussion.update",
  messagePost: "kanban.message.post",
  answer: "kanban.answer",
  scripts: "kanban.scripts",
  scriptRuns: "kanban.script.runs",
  scriptEnable: "kanban.script.enable",
  scriptRun: "kanban.script.run",
} as const;

type KanbanMethod = (typeof KANBAN_WS_METHODS)[keyof typeof KANBAN_WS_METHODS];

/** First a full snapshot, then every change to the board. */
export const KanbanWatchEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { snapshot: KanbanBoardSnapshot }),
  Schema.TaggedStruct("change", { change: KanbanChange }),
]);
export type KanbanWatchEvent = typeof KanbanWatchEvent.Type;

export const KanbanCardDetail = Schema.Struct({
  card: KanbanCard,
  events: Schema.Array(KanbanCardEvent),
  threads: Schema.Array(KanbanThreadLink),
});
export type KanbanCardDetail = typeof KanbanCardDetail.Type;

/** Owner edits to a card; a stage change follows the owner move rules. */
export const KanbanCardPatchInput = Schema.Struct({
  cardId: KanbanCardId,
  priority: Schema.optional(KanbanPriority),
  goalId: Schema.optional(Schema.NullOr(KanbanGoalId)),
  stage: Schema.optional(KanbanStage),
  /** Clears the stalled flag when false. */
  stalled: Schema.optional(Schema.Boolean),
  /** Links to take off, by URL. */
  removeLinks: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  comment: Schema.optional(Schema.String),
});
export type KanbanCardPatchInput = typeof KanbanCardPatchInput.Type;

export const KanbanBoardUpdateInput = Schema.Struct({
  boardId: KanbanBoardId,
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.NullOr(KanbanBoardIcon)),
  iconImage: Schema.optional(Schema.NullOr(KanbanBoardIconImage)),
  defaultProjectId: Schema.optional(Schema.NullOr(ProjectId)),
  managerModel: Schema.optional(ModelSelection),
  evaluatorModel: Schema.optional(ModelSelection),
  defaultCardModel: Schema.optional(ModelSelection),
  reviewChains: Schema.optional(Schema.Array(KanbanReviewChain)),
  defaultReviewChain: Schema.optional(Schema.NullOr(Schema.String)),
  instructions: Schema.optional(KanbanInstructions),
});
export type KanbanBoardUpdateInput = typeof KanbanBoardUpdateInput.Type;

/** Owner changes to a discussion. `settled: false`, `snoozedUntil: null` and `pinned: false` undo. */
export const KanbanDiscussionUpdateInput = Schema.Struct({
  discussionId: KanbanDiscussionId,
  title: Schema.optional(Schema.String),
  settled: Schema.optional(Schema.Boolean),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinned: Schema.optional(Schema.Boolean),
});
export type KanbanDiscussionUpdateInput = typeof KanbanDiscussionUpdateInput.Type;

const KanbanRpcError = Schema.Union([KanbanError, EnvironmentAuthorizationError]);

const call = <const Tag extends KanbanMethod, P extends Schema.Top, S extends Schema.Top>(
  tag: Tag,
  payload: P,
  success: S,
) => Rpc.make(tag, { payload, success, error: KanbanRpcError });

const M = KANBAN_WS_METHODS;
const BoardRef = Schema.Struct({ boardId: KanbanBoardId });
const CardRef = Schema.Struct({ cardId: KanbanCardId });
const ScriptRef = Schema.Struct({ scriptId: KanbanScriptId });

export const KanbanRpcs = RpcGroup.make(
  /** Every board with its counts, then what changed whenever a count, a board or its threads change. */
  Rpc.make(M.boards, {
    payload: Schema.Struct({}),
    success: Schema.Array(KanbanBoardListEntry),
    error: KanbanRpcError,
    stream: true,
  }),
  Rpc.make(M.subscribe, {
    payload: BoardRef,
    success: KanbanWatchEvent,
    error: KanbanRpcError,
    stream: true,
  }),
  call(M.card, CardRef, KanbanCardDetail),
  call(M.discussions, BoardRef, Schema.Array(KanbanDiscussion)),
  call(M.threads, BoardRef, Schema.Array(KanbanThreadRow)),
  call(M.owner, Schema.Struct({ threadId: ThreadId }), Schema.NullOr(KanbanThreadLink)),
  /**
   * The newest messages after `afterSeq` and before `beforeSeq`, oldest first. A page is cut
   * by count and by size (always at least one message), and big blocks come as stubs
   * (`truncated`); seqs have no holes, so a page whose first seq is past the one asked for
   * means more are left.
   */
  call(
    M.messages,
    Schema.Struct({
      discussionId: KanbanDiscussionId,
      afterSeq: Schema.optional(NonNegativeInt),
      beforeSeq: Schema.optional(NonNegativeInt),
      limit: Schema.optional(NonNegativeInt),
    }),
    Schema.Array(KanbanMessage),
  ),
  /** One message with every block in full. */
  call(
    M.message,
    Schema.Struct({ discussionId: KanbanDiscussionId, seq: NonNegativeInt }),
    KanbanMessage,
  ),
  call(M.wiki, BoardRef, Schema.Array(KanbanWikiPage)),
  call(
    M.boardCreate,
    Schema.Struct({
      slug: Schema.String,
      name: Schema.String,
      defaultProjectId: Schema.NullOr(ProjectId),
      managerModel: Schema.optional(ModelSelection),
      evaluatorModel: Schema.optional(ModelSelection),
      defaultCardModel: Schema.optional(ModelSelection),
    }),
    KanbanBoard,
  ),
  call(M.boardUpdate, KanbanBoardUpdateInput, KanbanBoard),
  call(
    M.setupStart,
    Schema.Struct({
      boardId: KanbanBoardId,
      evaluatorModel: ModelSelection,
      text: Schema.optional(Schema.String),
    }),
    Schema.Struct({ discussionId: KanbanDiscussionId }),
  ),
  call(M.setupEnd, Schema.Struct({ boardId: KanbanBoardId }), KanbanBoard),
  call(
    M.boardPause,
    Schema.Struct({
      boardId: KanbanBoardId,
      keep: Schema.optional(Schema.Array(KanbanCardId)),
      reason: Schema.optional(Schema.String),
      clear: Schema.optional(Schema.Boolean),
    }),
    KanbanBoard,
  ),
  call(M.cardPatch, KanbanCardPatchInput, KanbanCard),
  call(M.cardSettle, CardRef, KanbanCard),
  call(M.cardStop, CardRef, KanbanCard),
  /** The owner makes an async ask blocking, or drops an ask. */
  call(
    M.cardAsk,
    Schema.Struct({
      cardId: KanbanCardId,
      askId: Schema.String,
      action: Schema.Literals(["block", "drop"]),
    }),
    KanbanCard,
  ),
  /** The card's discussion, created on first use. */
  call(M.cardDiscussion, CardRef, KanbanDiscussion),
  call(
    M.poolSet,
    Schema.Struct({
      boardId: KanbanBoardId,
      model: ModelSelection,
      /** Required unless `replaces` is set; then left out keeps the pool's slots. */
      slots: Schema.optional(NonNegativeInt),
      /** Key of the pool whose level changes to `model`'s; its open cards follow. */
      replaces: Schema.optional(TrimmedNonEmptyString),
    }),
    Schema.Array(KanbanPool),
  ),
  call(
    M.poolRemove,
    Schema.Struct({
      boardId: KanbanBoardId,
      model: ModelSelection,
      /** Key of the pool to remove; it names the pool even when `model` has no level. */
      replaces: Schema.optional(TrimmedNonEmptyString),
    }),
    Schema.Array(KanbanPool),
  ),
  call(
    M.discussionCreate,
    Schema.Struct({ boardId: KanbanBoardId, title: Schema.String }),
    KanbanDiscussion,
  ),
  call(
    M.discussionRead,
    Schema.Struct({ discussionId: KanbanDiscussionId, seq: NonNegativeInt }),
    Schema.Struct({}),
  ),
  call(M.discussionUpdate, KanbanDiscussionUpdateInput, KanbanDiscussion),
  call(
    M.messagePost,
    Schema.Struct({ discussionId: KanbanDiscussionId, blocks: Schema.Array(KanbanBlockInput) }),
    KanbanMessage,
  ),
  call(
    M.answer,
    Schema.Struct({
      discussionId: KanbanDiscussionId,
      seq: NonNegativeInt,
      blockId: Schema.String,
      choice: Schema.Array(Schema.String),
      text: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    KanbanMessage,
  ),
  call(M.scripts, BoardRef, Schema.Array(KanbanScript)),
  /** Newest first. */
  call(
    M.scriptRuns,
    Schema.Struct({ scriptId: KanbanScriptId, limit: Schema.optional(NonNegativeInt) }),
    Schema.Array(KanbanScriptRun),
  ),
  call(
    M.scriptEnable,
    Schema.Struct({ scriptId: KanbanScriptId, enabled: Schema.Boolean }),
    KanbanScript,
  ),
  /** Starts a run now and answers with it open; it finishes in the background. */
  call(M.scriptRun, ScriptRef, KanbanScriptRun),
);

export const KANBAN_READ_SCOPES = {
  [M.boards]: AuthOrchestrationReadScope,
  [M.subscribe]: AuthOrchestrationReadScope,
  [M.card]: AuthOrchestrationReadScope,
  [M.discussions]: AuthOrchestrationReadScope,
  [M.threads]: AuthOrchestrationReadScope,
  [M.owner]: AuthOrchestrationReadScope,
  [M.messages]: AuthOrchestrationReadScope,
  [M.message]: AuthOrchestrationReadScope,
  [M.wiki]: AuthOrchestrationReadScope,
  [M.scripts]: AuthOrchestrationReadScope,
  [M.scriptRuns]: AuthOrchestrationReadScope,
} as const;

/** Owner changes: guarded on the client too (see `CLIENT_GUARDED_RPC_SCOPES`). */
export const KANBAN_GUARDED_SCOPES = {
  [M.boardCreate]: AuthOrchestrationOperateScope,
  [M.boardUpdate]: AuthOrchestrationOperateScope,
  [M.setupStart]: AuthOrchestrationOperateScope,
  [M.setupEnd]: AuthOrchestrationOperateScope,
  [M.boardPause]: AuthOrchestrationOperateScope,
  [M.cardPatch]: AuthOrchestrationOperateScope,
  [M.cardSettle]: AuthOrchestrationOperateScope,
  [M.cardStop]: AuthOrchestrationOperateScope,
  [M.cardAsk]: AuthOrchestrationOperateScope,
  [M.cardDiscussion]: AuthOrchestrationOperateScope,
  [M.poolSet]: AuthOrchestrationOperateScope,
  [M.poolRemove]: AuthOrchestrationOperateScope,
  [M.discussionCreate]: AuthOrchestrationOperateScope,
  [M.discussionRead]: AuthOrchestrationOperateScope,
  [M.discussionUpdate]: AuthOrchestrationOperateScope,
  [M.messagePost]: AuthOrchestrationOperateScope,
  [M.answer]: AuthOrchestrationOperateScope,
  [M.scriptEnable]: AuthOrchestrationOperateScope,
  [M.scriptRun]: AuthOrchestrationOperateScope,
} as const;

export const KANBAN_AGGREGATES = Object.fromEntries(
  Object.values(KANBAN_WS_METHODS).map((method) => [method, "missions"]),
) as { readonly [K in KanbanMethod]: "missions" };
