import {
  OrchestratorMcpFailure,
  type MissionError,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as PolicyService from "./PolicyService.ts";
import { PolicyToolkit } from "./tools.ts";

const REFUSALS: ReadonlySet<MissionError["code"]> = new Set([
  "forbidden",
  "provenance-required",
  "provenance-invalid",
  "locked",
]);

/** Mission errors reach the agent as tool errors in the mission's own wording. */
const toolFailure = (error: MissionError) =>
  new OrchestratorMcpFailure({
    code: REFUSALS.has(error.code) ? "capability_denied" : "invalid_request",
    message: error.message,
  });

/**
 * Who is calling, from the MCP invocation context only: a T3 thread is an
 * agent (the service resolves its roles); a signed-in MCP client is a system
 * component named after its label. Writes go through `actsAsCaller`, so only
 * threads reach them.
 */
const callerProvenance = (scope: McpInvocationContext.McpInvocationScope): MissionProvenance =>
  scope.thread !== undefined
    ? { _tag: "agent", threadId: scope.thread.threadId, roleId: null }
    : {
        _tag: "system",
        component: scope.client === undefined ? "mcp" : `mcp-client:${scope.client.label}`,
      };

const withPolicy = <A>(
  run: (
    policy: PolicyService.PolicyService["Service"],
    provenance: MissionProvenance,
  ) => Effect.Effect<A, MissionError>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const policy = yield* PolicyService.PolicyService;
    return yield* run(policy, callerProvenance(scope));
  }).pipe(Effect.catchTags({ MissionError: (error) => Effect.fail(toolFailure(error)) }));

/** A write tool: the calling thread's live run, then the same service method the owner's UI uses. */
const write = <I, A>(
  run: (
    policy: PolicyService.PolicyService["Service"],
  ) => (provenance: MissionProvenance, input: I) => Effect.Effect<A, MissionError>,
) =>
  McpToolAccess.actsAsCaller((input: I) =>
    withPolicy((policy, provenance) => run(policy)(provenance, input)),
  );

const handlers = {
  mission_roles: McpToolAccess.reads((input) =>
    withPolicy((policy) => policy.roles(input.missionId)),
  ),
  mission_review_policy: McpToolAccess.reads((input) =>
    withPolicy((policy) => policy.reviewPolicy(input.missionId)),
  ),
  mission_review_plan: McpToolAccess.reads((input) =>
    withPolicy((policy) => policy.reviewPlan(input)),
  ),
  mission_pools: McpToolAccess.reads((input) =>
    withPolicy((policy) => policy.pools({ missionId: input.missionId })),
  ),
  mission_governor: McpToolAccess.reads(() => withPolicy((policy) => policy.governor)),
  mission_role_create: write((policy) => policy.createRole),
  mission_role_update: write((policy) => policy.updateRole),
  mission_role_retire: write((policy) => policy.retireRole),
  mission_role_model: write((policy) => policy.setRoleModel),
  mission_role_bind: write((policy) => policy.bindRole),
  mission_role_unbind: write((policy) => policy.unbindRole),
  mission_role_succeed: write((policy) => policy.succeedRole),
  mission_review_policy_edit: write((policy) => policy.editReviewPolicy),
  mission_criticality_guide: write((policy) => policy.setCriticalityGuide),
  mission_criticality: write((policy) => policy.recordCriticality),
  mission_review_record: write((policy) => policy.recordReview),
  mission_pool_create: write((policy) => policy.createPool),
  mission_pool_update: write((policy) => policy.updatePool),
  mission_pool_capacity: write((policy) => policy.setPoolCapacity),
  mission_hold_take: write((policy) => policy.takeHold),
  mission_hold_release: write((policy) => policy.releaseHold),
  mission_hold_renew: McpToolAccess.actsAsCaller((input) =>
    withPolicy((policy, provenance) =>
      policy.renewHold(provenance, input).pipe(Effect.map((hold) => ({ hold }))),
    ),
  ),
  mission_hold_reconcile: write((policy) => policy.reconcileHold),
} satisfies McpToolAccess.Handlers<typeof PolicyToolkit.tools>;

export const layer = McpToolAccess.toLayer(PolicyToolkit, handlers);
