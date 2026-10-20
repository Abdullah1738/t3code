import {
  BindRoleInput,
  CreatePoolInput,
  CreateRoleInput,
  EditReviewPolicyInput,
  GovernorView,
  HandOffLaneInput,
  MissionId,
  MissionMutationResult,
  OrchestratorMcpFailure,
  PoolHold,
  PoolsSnapshot,
  RecordCriticalityInput,
  RecordReviewInput,
  ReconcileHoldInput,
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
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PolicyService from "./PolicyService.ts";

/**
 * Mission policy tools: roles and their models, review policy and plans,
 * pools and holds. Who is calling comes from the calling thread, never from
 * parameters. The service decides what the caller may do: the owner and a
 * mission's master may change anything; holders may hand over or release
 * their own role; anyone in a mission may take a hold.
 */

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PolicyService.PolicyService,
];

const tool = <
  Name extends string,
  Parameters extends Schema.Constraint,
  Success extends Schema.Constraint,
>(
  name: Name,
  description: string,
  parameters: Parameters,
  success: Success,
) =>
  Tool.make(name, {
    description,
    parameters,
    success,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  });

const MissionIdOnly = Schema.Struct({ missionId: MissionId });

// --- reads

const RolesTool = tool(
  "mission_roles",
  "A mission's roles with their models (a pending model applies at each holder's next turn), registry defaults nobody changed yet, holders newest first, and drift: holders running a model other than their role's.",
  MissionIdOnly,
  RolesSnapshot,
);

const ReviewPolicyTool = tool(
  "mission_review_policy",
  "A mission's review policy: stages (each points at a role), ladders (normal, critical, custom), common rules, the criticality guide with its hard triggers and version, and who judges criticality. `stored` is false while the mission still runs the default policy.",
  MissionIdOnly,
  ReviewPolicySnapshot,
);

const ReviewPlanTool = tool(
  "mission_review_plan",
  "What a PR needs next at an exact head: its criticality verdict, the ladder, each stage's state (done-at-head, done-at-older-head, pending, needs-rerun), the next stage with its role and model, and whether merge is allowed. Pass facts (changed lines, paths, labels) to see whether a hard trigger fires; this read never records it (use mission_criticality to record a verdict).",
  ReviewPlanRequest,
  ReviewPlan,
);

const PoolsTool = tool(
  "mission_pools",
  "Pools with live usage, holds (running first, then the queue in admission order), what is in use, pressure, and whether an outside source is sampled. Pass missionId for the pools that mission can use.",
  Schema.Struct({ missionId: Schema.optional(MissionId) }),
  PoolsSnapshot,
);

const GovernorTool = tool(
  "mission_governor",
  "What the governor sees now: pressure per pool, each mission's dominant share, the park or resume it would apply this tick, and the admission order. It never switches models.",
  // An empty Struct serializes to `anyOf`, which MCP clients reject; EmptyParams is an object root.
  Tool.EmptyParams,
  GovernorView,
);

// --- roles

const RoleCreateTool = tool(
  "mission_role_create",
  "Add a role to a mission (a registry kind, or `custom` with a name and model). Lane roles need laneId.",
  CreateRoleInput,
  MissionMutationResult,
);

const RoleUpdateTool = tool(
  "mission_role_update",
  "Rename a role, change its description, or set whether it writes public text.",
  UpdateRoleInput,
  MissionMutationResult,
);

const RoleRetireTool = tool(
  "mission_role_retire",
  "Retire a custom role: its holders are released and the role is removed. Registry roles cannot be retired; unbind their holders or change their model instead.",
  RetireRoleInput,
  MissionMutationResult,
);

const RoleModelTool = tool(
  "mission_role_model",
  "Change a role's model and variant. Every holder switches at its next turn, never mid-turn. To cancel a pending change, pass the role's current model.",
  SetRoleModelInput,
  MissionMutationResult,
);

const RoleBindTool = tool(
  "mission_role_bind",
  "Bind a thread to a role. By default it replaces the current holders; shared keeps them. The thread runs the role's model from its next turn.",
  BindRoleInput,
  MissionMutationResult,
);

const RoleUnbindTool = tool(
  "mission_role_unbind",
  "Release a thread from a role. A holder may release itself.",
  UnbindRoleInput,
  MissionMutationResult,
);

const RoleSucceedTool = tool(
  "mission_role_succeed",
  "Hand a role from its holder to a thread you already launched, with a handoff note. Schedules bound to the old thread move to the new one unless that thread also serves another role, lane or mission; the result counts any kept. A holder may hand over its own role.",
  SucceedRoleInput,
  SucceedRoleResult,
);

const LaneHandoffTool = tool(
  "mission_lane_handoff",
  "Hand a lane's lead role to a fresh thread with a handoff note. Without threadId the server launches the new thread in the old lead's project and workspace on the role's model and briefs it with the note. Schedules (unless the old thread serves something else too) and the old thread's room subscriptions move; running work on the old thread is left alone. Retrying a failed handoff reuses the thread it launched.",
  HandOffLaneInput,
  SucceedRoleResult,
);

// --- review policy

const ReviewPolicyEditTool = tool(
  "mission_review_policy_edit",
  "Edit a mission's review stages, ladders, common rules or who judges criticality (master, or lane leads). Every stage points at a role, never a model. A stage's optional recordedBy lists role kinds (for example lane-lead) that may record its result too, besides the role's holders, crw, the master and the owner.",
  EditReviewPolicyInput,
  MissionMutationResult,
);

const CriticalityGuideTool = tool(
  "mission_criticality_guide",
  "Write a mission's criticality guide: the instruction for judging critical PRs plus optional hard triggers (changed lines at least N, path patterns, labels) that mark a PR critical without asking. An empty guide means every PR is normal.",
  SetCriticalityGuideInput,
  MissionMutationResult,
);

const CriticalityTool = tool(
  "mission_criticality",
  "Record or reclassify a PR's criticality verdict with a reason. The newest verdict wins, whoever made it.",
  RecordCriticalityInput,
  MissionMutationResult,
);

const ReviewRecordTool = tool(
  "mission_review_record",
  "Record a review stage's result for a PR at an exact head sha: clear, findings or blocked, with finding counts and links.",
  RecordReviewInput,
  MissionMutationResult,
);

// --- pools

const PoolCreateTool = tool(
  "mission_pool_create",
  "Create a pool of any scope (one mission, shared by named missions, or global): lease, budget or observed, with a capacity. Native pools are enforced; outside backends are read-only observers.",
  CreatePoolInput,
  MissionMutationResult,
);

const PoolUpdateTool = tool(
  "mission_pool_update",
  "Rename a pool, change its unit, or set its cross-mission priority (admission order when contended).",
  UpdatePoolInput,
  MissionMutationResult,
);

const PoolCapacityTool = tool(
  "mission_pool_capacity",
  "Change any pool's capacity. Raising it admits queued holds; lowering it never evicts running holds.",
  SetPoolCapacityInput,
  MissionMutationResult,
);

const HoldTakeTool = tool(
  "mission_hold_take",
  "Take a hold on a pool for this mission with a lease (ttlSeconds). Keep the returned fence: release and renew need it. With queue: true a full pool queues the hold instead of refusing.",
  TakeHoldInput,
  TakeHoldResult,
);

const HoldReleaseTool = tool(
  "mission_hold_release",
  "Release a hold (or withdraw a queued one) with its fence and a note. An expired hold cannot be released; it needs reconciling.",
  ReleaseHoldInput,
  MissionMutationResult,
);

const HoldRenewTool = tool(
  "mission_hold_renew",
  "Extend a running hold's lease with its fence before it expires.",
  RenewHoldInput,
  Schema.Struct({ hold: PoolHold }),
);

const HoldReconcileTool = tool(
  "mission_hold_reconcile",
  "Reconcile an expired hold after checking what really happened: done, not-started or rolled-back, with evidence. Only then does its slot free up; an expiry never means a repeat is safe.",
  ReconcileHoldInput,
  MissionMutationResult,
);

interface ToolConfig {
  readonly parameters: Schema.Constraint;
  readonly success: Schema.Constraint;
  readonly failure: Schema.Constraint;
  readonly failureMode: Tool.FailureMode;
}

const readTool = <Name extends string, Config extends ToolConfig, R>(
  definition: Tool.Tool<Name, Config, R>,
  title: string,
) =>
  definition
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Strict, true);

const writeTool = <Name extends string, Config extends ToolConfig, R>(
  definition: Tool.Tool<Name, Config, R>,
  title: string,
) =>
  definition
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Strict, true);

export const PolicyToolkit = Toolkit.make(
  readTool(RolesTool, "Mission roles"),
  readTool(ReviewPolicyTool, "Mission review policy"),
  // ardud missions: core (M2) - a pure read; facts never store a verdict.
  readTool(ReviewPlanTool, "PR review plan"),
  readTool(PoolsTool, "Mission pools"),
  readTool(GovernorTool, "Mission governor"),
  writeTool(RoleCreateTool, "Add a role"),
  writeTool(RoleUpdateTool, "Update a role"),
  writeTool(RoleRetireTool, "Retire a role"),
  writeTool(RoleModelTool, "Change a role's model"),
  writeTool(RoleBindTool, "Bind a role"),
  writeTool(RoleUnbindTool, "Release a role"),
  writeTool(RoleSucceedTool, "Hand a role over"),
  writeTool(LaneHandoffTool, "Hand a lane off"),
  writeTool(ReviewPolicyEditTool, "Edit review policy"),
  writeTool(CriticalityGuideTool, "Write the criticality guide"),
  writeTool(CriticalityTool, "Record a criticality verdict"),
  writeTool(ReviewRecordTool, "Record a review"),
  writeTool(PoolCreateTool, "Create a pool"),
  writeTool(PoolUpdateTool, "Update a pool"),
  writeTool(PoolCapacityTool, "Change pool capacity"),
  writeTool(HoldTakeTool, "Take a hold"),
  writeTool(HoldReleaseTool, "Release a hold"),
  writeTool(HoldRenewTool, "Renew a hold"),
  writeTool(HoldReconcileTool, "Reconcile an expired hold"),
);
