/**
 * WebSocket RPCs for the mission policy (roles, review policy, pools,
 * governor). They form their own group so the server implements them in a
 * separate handler layer; `rpc.ts` adds the scope middleware and merges the
 * group into `WsRpcGroup`. Reads need `orchestration:read`, writes
 * `orchestration:operate`, and writes run as the owner.
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
  BindRoleInput,
  CreatePoolInput,
  CreateRoleInput,
  EditReviewPolicyInput,
  GovernorView,
  MissionError,
  MissionId,
  MissionMutationResult,
  PoolHold,
  PoolsSnapshot,
  ReconcileHoldInput,
  RecordCriticalityInput,
  RecordReviewInput,
  ReleaseHoldInput,
  RenewHoldInput,
  RetireRoleInput,
  ReviewPlan,
  ReviewPlanRequest,
  ReviewPolicySnapshot,
  RolesSnapshot,
  SetCriticalityGuideInput,
  SetPoolCapacityInput,
  SetRoleModelInput,
  SucceedRoleInput,
  SucceedRoleResult,
  TakeHoldInput,
  TakeHoldResult,
  UnbindRoleInput,
  UpdatePoolInput,
  UpdateRoleInput,
} from "./missions.ts";

export const MISSIONS_POLICY_WS_METHODS = {
  roles: "missions.policy.roles",
  createRole: "missions.policy.createRole",
  updateRole: "missions.policy.updateRole",
  retireRole: "missions.policy.retireRole",
  setRoleModel: "missions.policy.setRoleModel",
  bindRole: "missions.policy.bindRole",
  unbindRole: "missions.policy.unbindRole",
  succeedRole: "missions.policy.succeedRole",
  reviewPolicy: "missions.policy.reviewPolicy",
  editReviewPolicy: "missions.policy.editReviewPolicy",
  setCriticalityGuide: "missions.policy.setCriticalityGuide",
  recordCriticality: "missions.policy.recordCriticality",
  recordReview: "missions.policy.recordReview",
  reviewPlan: "missions.policy.reviewPlan",
  pools: "missions.policy.pools",
  createPool: "missions.policy.createPool",
  updatePool: "missions.policy.updatePool",
  setPoolCapacity: "missions.policy.setPoolCapacity",
  takeHold: "missions.policy.takeHold",
  releaseHold: "missions.policy.releaseHold",
  renewHold: "missions.policy.renewHold",
  reconcileHold: "missions.policy.reconcileHold",
  governor: "missions.policy.governor",
} as const;

type PolicyMethod = (typeof MISSIONS_POLICY_WS_METHODS)[keyof typeof MISSIONS_POLICY_WS_METHODS];

const PolicyRpcError = Schema.Union([MissionError, EnvironmentAuthorizationError]);

const MissionScope = Schema.Struct({ missionId: MissionId });

const call = <const Tag extends PolicyMethod, P extends Schema.Top, S extends Schema.Top>(
  tag: Tag,
  payload: P,
  success: S,
) => Rpc.make(tag, { payload, success, error: PolicyRpcError });

const M = MISSIONS_POLICY_WS_METHODS;

export const MissionsPolicyRpcs = RpcGroup.make(
  call(M.roles, MissionScope, RolesSnapshot),
  call(M.createRole, CreateRoleInput, MissionMutationResult),
  call(M.updateRole, UpdateRoleInput, MissionMutationResult),
  call(M.retireRole, RetireRoleInput, MissionMutationResult),
  call(M.setRoleModel, SetRoleModelInput, MissionMutationResult),
  call(M.bindRole, BindRoleInput, MissionMutationResult),
  call(M.unbindRole, UnbindRoleInput, MissionMutationResult),
  call(M.succeedRole, SucceedRoleInput, SucceedRoleResult),
  call(M.reviewPolicy, MissionScope, ReviewPolicySnapshot),
  call(M.editReviewPolicy, EditReviewPolicyInput, MissionMutationResult),
  call(M.setCriticalityGuide, SetCriticalityGuideInput, MissionMutationResult),
  call(M.recordCriticality, RecordCriticalityInput, MissionMutationResult),
  call(M.recordReview, RecordReviewInput, MissionMutationResult),
  call(M.reviewPlan, ReviewPlanRequest, ReviewPlan),
  call(M.pools, Schema.Struct({ missionId: Schema.optional(MissionId) }), PoolsSnapshot),
  call(M.createPool, CreatePoolInput, MissionMutationResult),
  call(M.updatePool, UpdatePoolInput, MissionMutationResult),
  call(M.setPoolCapacity, SetPoolCapacityInput, MissionMutationResult),
  call(M.takeHold, TakeHoldInput, TakeHoldResult),
  call(M.releaseHold, ReleaseHoldInput, MissionMutationResult),
  call(M.renewHold, RenewHoldInput, PoolHold),
  call(M.reconcileHold, ReconcileHoldInput, MissionMutationResult),
  call(M.governor, Schema.Struct({}), GovernorView),
);

/** Reads: any client allowed to read orchestration state. */
export const MISSIONS_POLICY_READ_SCOPES = {
  [M.roles]: AuthOrchestrationReadScope,
  [M.reviewPolicy]: AuthOrchestrationReadScope,
  [M.reviewPlan]: AuthOrchestrationReadScope,
  [M.pools]: AuthOrchestrationReadScope,
  [M.governor]: AuthOrchestrationReadScope,
} as const;

/** Writes: guarded on the client too (see `CLIENT_GUARDED_RPC_SCOPES`). */
export const MISSIONS_POLICY_GUARDED_SCOPES = {
  [M.createRole]: AuthOrchestrationOperateScope,
  [M.updateRole]: AuthOrchestrationOperateScope,
  [M.retireRole]: AuthOrchestrationOperateScope,
  [M.setRoleModel]: AuthOrchestrationOperateScope,
  [M.bindRole]: AuthOrchestrationOperateScope,
  [M.unbindRole]: AuthOrchestrationOperateScope,
  [M.succeedRole]: AuthOrchestrationOperateScope,
  [M.editReviewPolicy]: AuthOrchestrationOperateScope,
  [M.setCriticalityGuide]: AuthOrchestrationOperateScope,
  [M.recordCriticality]: AuthOrchestrationOperateScope,
  [M.recordReview]: AuthOrchestrationOperateScope,
  [M.createPool]: AuthOrchestrationOperateScope,
  [M.updatePool]: AuthOrchestrationOperateScope,
  [M.setPoolCapacity]: AuthOrchestrationOperateScope,
  [M.takeHold]: AuthOrchestrationOperateScope,
  [M.releaseHold]: AuthOrchestrationOperateScope,
  [M.renewHold]: AuthOrchestrationOperateScope,
  [M.reconcileHold]: AuthOrchestrationOperateScope,
} as const;

/** Trace aggregate label for every policy RPC. */
export const MISSIONS_POLICY_AGGREGATES = Object.fromEntries(
  Object.values(MISSIONS_POLICY_WS_METHODS).map((method) => [method, "missions"]),
) as { readonly [K in PolicyMethod]: "missions" };
