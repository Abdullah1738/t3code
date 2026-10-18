import {
  MISSIONS_POLICY_WS_METHODS as M,
  MissionError,
  type MissionId,
  type MissionProvenance,
  type ReviewPlanRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OWNER_SESSION_REQUIRED } from "../core/provenance.ts";
import type * as PolicyService from "./PolicyService.ts";

/**
 * Policy WS handlers (rules page, roles, pools, portfolio). Reads need
 * orchestration:read; writes need orchestration:operate and run as the owner,
 * so they only work from a Robob client UI. The caller passes the owner
 * provenance it derived from the connection, or null when the connection is
 * not a Robob client.
 */
export const makePolicyWsHandlers = (
  policy: PolicyService.PolicyService["Service"],
  owner: MissionProvenance | null,
) => {
  const asOwner = <I, A>(
    write: (provenance: MissionProvenance, input: I) => Effect.Effect<A, MissionError>,
  ) =>
    owner === null
      ? (_input: I) =>
          Effect.fail(
            new MissionError({
              code: "provenance-required",
              detail: OWNER_SESSION_REQUIRED,
            }),
          )
      : (input: I) => write(owner, input);

  return {
    [M.roles]: (input: { readonly missionId: MissionId }) => policy.roles(input.missionId),
    [M.createRole]: asOwner(policy.createRole),
    [M.updateRole]: asOwner(policy.updateRole),
    [M.retireRole]: asOwner(policy.retireRole),
    [M.setRoleModel]: asOwner(policy.setRoleModel),
    [M.bindRole]: asOwner(policy.bindRole),
    [M.unbindRole]: asOwner(policy.unbindRole),
    [M.succeedRole]: asOwner(policy.succeedRole),
    [M.reviewPolicy]: (input: { readonly missionId: MissionId }) =>
      policy.reviewPolicy(input.missionId),
    [M.editReviewPolicy]: asOwner(policy.editReviewPolicy),
    [M.setCriticalityGuide]: asOwner(policy.setCriticalityGuide),
    [M.recordCriticality]: asOwner(policy.recordCriticality),
    [M.recordReview]: asOwner(policy.recordReview),
    [M.reviewPlan]: (input: ReviewPlanRequest) => policy.reviewPlan(input),
    [M.pools]: (input: { readonly missionId?: MissionId | undefined }) => policy.pools(input),
    [M.createPool]: asOwner(policy.createPool),
    [M.updatePool]: asOwner(policy.updatePool),
    [M.setPoolCapacity]: asOwner(policy.setPoolCapacity),
    [M.takeHold]: asOwner(policy.takeHold),
    [M.releaseHold]: asOwner(policy.releaseHold),
    [M.renewHold]: asOwner(policy.renewHold),
    [M.reconcileHold]: asOwner(policy.reconcileHold),
    [M.governor]: (_input: unknown) => policy.governor,
  } as const;
};
