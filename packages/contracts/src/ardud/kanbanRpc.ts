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
import { NonNegativeInt, ProjectId } from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";
import {
  KanbanBlock,
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
  KanbanWikiPage,
} from "./kanban.ts";

export const KANBAN_WS_METHODS = {
  boards: "kanban.boards",
  subscribe: "kanban.subscribe",
  card: "kanban.card",
  discussions: "kanban.discussions",
  messages: "kanban.messages",
  wiki: "kanban.wiki",
  boardCreate: "kanban.board.create",
  boardUpdate: "kanban.board.update",
  cardPatch: "kanban.card.patch",
  cardSettle: "kanban.card.settle",
  cardStop: "kanban.card.stop",
  cardAsk: "kanban.card.ask",
  cardDiscussion: "kanban.card.discussion",
  poolSet: "kanban.pool.set",
  discussionCreate: "kanban.discussion.create",
  discussionRead: "kanban.discussion.read",
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
  call(
    M.messages,
    Schema.Struct({
      discussionId: KanbanDiscussionId,
      afterSeq: Schema.optional(NonNegativeInt),
      limit: Schema.optional(NonNegativeInt),
    }),
    Schema.Array(KanbanMessage),
  ),
  call(M.wiki, BoardRef, Schema.Array(KanbanWikiPage)),
  call(
    M.boardCreate,
    Schema.Struct({
      slug: Schema.String,
      name: Schema.String,
      defaultProjectId: Schema.NullOr(ProjectId),
    }),
    KanbanBoard,
  ),
  call(M.boardUpdate, KanbanBoardUpdateInput, KanbanBoard),
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
    Schema.Struct({ boardId: KanbanBoardId, model: ModelSelection, slots: NonNegativeInt }),
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
  call(
    M.messagePost,
    Schema.Struct({ discussionId: KanbanDiscussionId, blocks: Schema.Array(KanbanBlock) }),
    KanbanMessage,
  ),
  call(
    M.answer,
    Schema.Struct({
      discussionId: KanbanDiscussionId,
      seq: NonNegativeInt,
      blockId: Schema.String,
      choice: Schema.Array(Schema.String),
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
  [M.messages]: AuthOrchestrationReadScope,
  [M.wiki]: AuthOrchestrationReadScope,
  [M.scripts]: AuthOrchestrationReadScope,
  [M.scriptRuns]: AuthOrchestrationReadScope,
} as const;

/** Owner changes: guarded on the client too (see `CLIENT_GUARDED_RPC_SCOPES`). */
export const KANBAN_GUARDED_SCOPES = {
  [M.boardCreate]: AuthOrchestrationOperateScope,
  [M.boardUpdate]: AuthOrchestrationOperateScope,
  [M.cardPatch]: AuthOrchestrationOperateScope,
  [M.cardSettle]: AuthOrchestrationOperateScope,
  [M.cardStop]: AuthOrchestrationOperateScope,
  [M.cardAsk]: AuthOrchestrationOperateScope,
  [M.cardDiscussion]: AuthOrchestrationOperateScope,
  [M.poolSet]: AuthOrchestrationOperateScope,
  [M.discussionCreate]: AuthOrchestrationOperateScope,
  [M.discussionRead]: AuthOrchestrationOperateScope,
  [M.messagePost]: AuthOrchestrationOperateScope,
  [M.answer]: AuthOrchestrationOperateScope,
  [M.scriptEnable]: AuthOrchestrationOperateScope,
  [M.scriptRun]: AuthOrchestrationOperateScope,
} as const;

export const KANBAN_AGGREGATES = Object.fromEntries(
  Object.values(KANBAN_WS_METHODS).map((method) => [method, "missions"]),
) as { readonly [K in KanbanMethod]: "missions" };
