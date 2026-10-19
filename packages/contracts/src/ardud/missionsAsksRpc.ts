/**
 * WebSocket RPCs the app needs on top of the core mission calls: record feeds
 * for rules and draft notes, the routing table, decided-item history,
 * and the owner's draft routing, draft note and annotation writes. Their own group so the asks
 * track implements them in a separate handler set; `rpc.ts` adds the scope
 * middleware and merges the group into `WsRpcGroup`. Reads need
 * `orchestration:read` and no owner proof; writes need `orchestration:operate`
 * and a paired owner session.
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
  AnnotateApprovalInput,
  AnnotateDraftInput,
  Approval,
  Draft,
  DraftNote,
  MissionError,
  MissionFeedInput,
  MissionFeedItem,
  MissionId,
  MissionInboxHistory,
  MissionInboxHistoryInput,
  MissionMasterInbox,
  MissionRoutingTable,
  MissionScopeInput,
  RouteDraftInput,
  SetDraftNoteActiveInput,
  SuggestionStats,
} from "./missions.ts";

export const MISSIONS_ASKS_WS_METHODS = {
  subscribeRules: "missions.asks.subscribeRules",
  subscribeDraftNotes: "missions.asks.subscribeDraftNotes",
  subscribeRouting: "missions.asks.subscribeRouting",
  inboxHistory: "missions.asks.inboxHistory",
  routeDraft: "missions.asks.routeDraft",
  setDraftNoteActive: "missions.asks.setDraftNoteActive",
  annotateDraft: "missions.asks.annotateDraft",
  annotateApproval: "missions.asks.annotateApproval",
  subscribeSuggestionStats: "missions.asks.subscribeSuggestionStats",
  subscribeMasterInbox: "missions.asks.subscribeMasterInbox",
} as const;

type AsksMethod = (typeof MISSIONS_ASKS_WS_METHODS)[keyof typeof MISSIONS_ASKS_WS_METHODS];

const AsksRpcError = Schema.Union([MissionError, EnvironmentAuthorizationError]);

const call = <const Tag extends AsksMethod, P extends Schema.Top, S extends Schema.Top>(
  tag: Tag,
  payload: P,
  success: S,
) => Rpc.make(tag, { payload, success, error: AsksRpcError });

const feed = <const Tag extends AsksMethod, P extends Schema.Top, S extends Schema.Top>(
  tag: Tag,
  payload: P,
  success: S,
) => Rpc.make(tag, { payload, success, error: AsksRpcError, stream: true });

const M = MISSIONS_ASKS_WS_METHODS;

export const MissionsAsksRpcs = RpcGroup.make(
  /** Rules and rule change requests: the mission's plus global (null: global only). */
  feed(M.subscribeRules, MissionFeedInput, MissionFeedItem),
  /** Draft notes, active and turned off: the mission's plus global (null: global only). */
  feed(M.subscribeDraftNotes, MissionFeedInput, MissionFeedItem),
  /** The mission's approval routing table, resent when it changes. */
  feed(M.subscribeRouting, Schema.Struct({ missionId: MissionId }), MissionRoutingTable),
  call(M.inboxHistory, MissionInboxHistoryInput, MissionInboxHistory),
  call(M.routeDraft, RouteDraftInput, Draft),
  call(M.setDraftNoteActive, SetDraftNoteActiveInput, DraftNote),
  /** Summary and flag chips on a pending draft or approval. */
  call(M.annotateDraft, AnnotateDraftInput, Draft),
  call(M.annotateApproval, AnnotateApprovalInput, Approval),
  /**
   * Suggestion record per source and target kind, with applied counts: one
   * mission's rows, or rows across every mission when null. Resent when it changes.
   */
  feed(M.subscribeSuggestionStats, MissionScopeInput, Schema.Array(SuggestionStats)),
  /** What waits on the master (one mission, or every mission when null); resent when it changes. */
  feed(M.subscribeMasterInbox, MissionScopeInput, MissionMasterInbox),
);

/** Reads: any client allowed to read orchestration state. */
export const MISSIONS_ASKS_READ_SCOPES = {
  [M.subscribeRules]: AuthOrchestrationReadScope,
  [M.subscribeDraftNotes]: AuthOrchestrationReadScope,
  [M.subscribeRouting]: AuthOrchestrationReadScope,
  [M.inboxHistory]: AuthOrchestrationReadScope,
  [M.subscribeSuggestionStats]: AuthOrchestrationReadScope,
  [M.subscribeMasterInbox]: AuthOrchestrationReadScope,
} as const;

/** Writes: guarded on the client too (see `CLIENT_GUARDED_RPC_SCOPES`). */
export const MISSIONS_ASKS_GUARDED_SCOPES = {
  [M.routeDraft]: AuthOrchestrationOperateScope,
  [M.setDraftNoteActive]: AuthOrchestrationOperateScope,
  [M.annotateDraft]: AuthOrchestrationOperateScope,
  [M.annotateApproval]: AuthOrchestrationOperateScope,
} as const;

/** Trace aggregate label for every asks RPC. */
export const MISSIONS_ASKS_AGGREGATES = Object.fromEntries(
  Object.values(MISSIONS_ASKS_WS_METHODS).map((method) => [method, "missions"]),
) as { readonly [K in AsksMethod]: "missions" };
