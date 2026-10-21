/**
 * WebSocket RPCs for mission views (card templates, sections, the mission
 * layout and the starter layout). They form their own group so the server
 * implements them in a separate handler layer; `rpc.ts` adds the scope
 * middleware and merges the group into `WsRpcGroup`. Reads need
 * `orchestration:read`; writes need `orchestration:operate` and a paired
 * owner session, and run as the owner.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import { MissionError, MissionId, MissionMutationResult } from "./missions.ts";
import {
  AddMissionAssetInput,
  ApplyViewBundleInput,
  DefineViewTemplateInput,
  EditStarterLayoutInput,
  EditViewLayoutInput,
  MissionViewsInput,
  MissionViewsSnapshot,
  PlaceViewSectionInput,
  PreviewViewInput,
  RemoveMissionAssetInput,
  RemoveViewInput,
  RestoreStarterLayoutInput,
  RestoreViewInput,
  RestoreViewLayoutInput,
  RunViewSourceInput,
  SetViewSourceInput,
  ViewCatalog,
  ViewHistory,
  ViewHistoryInput,
  ViewLongText,
  ViewLongTextInput,
  ViewPinned,
  ViewPreview,
  ViewSourceRunResult,
} from "./missionsViews.ts";

export const MISSIONS_VIEWS_WS_METHODS = {
  subscribe: "missions.views.subscribe",
  get: "missions.views.get",
  catalog: "missions.views.catalog",
  history: "missions.views.history",
  preview: "missions.views.preview",
  defineTemplate: "missions.views.defineTemplate",
  placeSection: "missions.views.placeSection",
  remove: "missions.views.remove",
  restore: "missions.views.restore",
  editLayout: "missions.views.editLayout",
  restoreLayout: "missions.views.restoreLayout",
  editStarter: "missions.views.editStarter",
  restoreStarter: "missions.views.restoreStarter",
  applyBundle: "missions.views.applyBundle",
  addAsset: "missions.views.addAsset",
  removeAsset: "missions.views.removeAsset",
  // --- views additions ---
  longText: "missions.views.longText",
  // --- end views additions ---
  // --- sources additions ---
  setSource: "missions.views.setSource",
  runSource: "missions.views.runSource",
  // --- end sources additions ---
} as const;

const M = MISSIONS_VIEWS_WS_METHODS;
type ViewsMethod = (typeof M)[keyof typeof M];

/**
 * The feed: a full snapshot first and after every view change, and a small
 * `waiting` item when only the count of items waiting on the owner moves.
 */
export const MissionViewsFeedItem = Schema.Union([
  Schema.TaggedStruct("snapshot", { snapshot: MissionViewsSnapshot }),
  Schema.TaggedStruct("waiting", {
    missionId: MissionId,
    ownerWaiting: Schema.Number,
    requestsUnread: Schema.Number,
    pinnedStrip: Schema.Boolean,
    pinned: ViewPinned,
  }),
]);
export type MissionViewsFeedItem = typeof MissionViewsFeedItem.Type;

const ViewsRpcError = Schema.Union([MissionError, EnvironmentAuthorizationError]);

const call = <const Tag extends ViewsMethod, P extends Schema.Top, S extends Schema.Top>(
  tag: Tag,
  payload: P,
  success: S,
) => Rpc.make(tag, { payload, success, error: ViewsRpcError });

export const MissionsViewsRpcs = RpcGroup.make(
  Rpc.make(M.subscribe, {
    payload: MissionViewsInput,
    success: MissionViewsFeedItem,
    error: ViewsRpcError,
    stream: true,
  }),
  call(M.get, MissionViewsInput, MissionViewsSnapshot),
  call(M.catalog, Schema.Struct({}), ViewCatalog),
  call(M.history, ViewHistoryInput, ViewHistory),
  call(M.preview, PreviewViewInput, ViewPreview),
  call(M.defineTemplate, DefineViewTemplateInput, MissionMutationResult),
  call(M.placeSection, PlaceViewSectionInput, MissionMutationResult),
  call(M.remove, RemoveViewInput, MissionMutationResult),
  call(M.restore, RestoreViewInput, MissionMutationResult),
  call(M.editLayout, EditViewLayoutInput, MissionMutationResult),
  call(M.restoreLayout, RestoreViewLayoutInput, MissionMutationResult),
  call(M.editStarter, EditStarterLayoutInput, MissionMutationResult),
  call(M.restoreStarter, RestoreStarterLayoutInput, MissionMutationResult),
  call(M.applyBundle, ApplyViewBundleInput, MissionMutationResult),
  call(M.addAsset, AddMissionAssetInput, MissionMutationResult),
  call(M.removeAsset, RemoveMissionAssetInput, MissionMutationResult),
  call(M.longText, ViewLongTextInput, ViewLongText),
  // --- sources additions ---
  call(M.setSource, SetViewSourceInput, MissionMutationResult),
  call(M.runSource, RunViewSourceInput, ViewSourceRunResult),
  // --- end sources additions ---
);

export const MISSIONS_VIEWS_READ_SCOPES = {
  [M.subscribe]: AuthOrchestrationReadScope,
  [M.get]: AuthOrchestrationReadScope,
  [M.catalog]: AuthOrchestrationReadScope,
  [M.history]: AuthOrchestrationReadScope,
  [M.preview]: AuthOrchestrationReadScope,
  [M.longText]: AuthOrchestrationReadScope,
} as const;

export const MISSIONS_VIEWS_GUARDED_SCOPES = {
  [M.defineTemplate]: AuthOrchestrationOperateScope,
  [M.placeSection]: AuthOrchestrationOperateScope,
  [M.remove]: AuthOrchestrationOperateScope,
  [M.restore]: AuthOrchestrationOperateScope,
  [M.editLayout]: AuthOrchestrationOperateScope,
  [M.restoreLayout]: AuthOrchestrationOperateScope,
  [M.editStarter]: AuthOrchestrationOperateScope,
  [M.restoreStarter]: AuthOrchestrationOperateScope,
  [M.applyBundle]: AuthOrchestrationOperateScope,
  [M.addAsset]: AuthOrchestrationOperateScope,
  [M.removeAsset]: AuthOrchestrationOperateScope,
  // --- sources additions ---
  [M.setSource]: AuthOrchestrationOperateScope,
  [M.runSource]: AuthOrchestrationOperateScope,
  // --- end sources additions ---
} as const;

export const MISSIONS_VIEWS_AGGREGATES = Object.fromEntries(
  Object.values(M).map((method) => [method, "missions"]),
) as { readonly [K in ViewsMethod]: "missions" };
