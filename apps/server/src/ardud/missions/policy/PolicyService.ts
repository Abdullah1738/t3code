import type {
  BindRoleInput,
  CreatePoolInput,
  CreateRoleInput,
  EditReviewPolicyInput,
  GovernorView,
  MissionError,
  MissionId,
  MissionMutationResult,
  MissionProvenance,
  PoolHold,
  PoolId,
  PoolsSnapshot,
  ReconcileHoldInput,
  RecordCriticalityInput,
  RecordReviewInput,
  RecordTriggerFactsInput,
  RecordTriggerFactsResult,
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
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { forkParked } from "../../../serverActivation.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import type { PolicyDeps } from "./context.ts";
import type { GovernorDecision } from "./governor.ts";
import { governorView, makeGovernorMemory, runGovernor, type GovernorMode } from "./governorOps.ts";
import * as PolicyStore from "./PolicyStore.ts";
import * as Pools from "./poolOps.ts";
import { PolicySampler, PolicySuccession, PolicySuggestions, PolicyThreads } from "./ports.ts";
import * as Reviews from "./reviewOps.ts";
import * as Roles from "./roleOps.ts";
import type { PoolSource } from "./sources.ts";

type Fx<A> = Effect.Effect<A, MissionError>;
type Write<I, A = MissionMutationResult> = (provenance: MissionProvenance, input: I) => Fx<A>;

export interface SetPoolSourceInput {
  readonly poolId: PoolId;
  readonly source: PoolSource | null;
}

/**
 * Roles, review policy, pools and the governor. Every write takes the
 * caller's provenance from the transport and lands on the mission timeline
 * with that actor. The owner and any mission's master may change everything
 * here; nothing refuses on a locked field.
 */
export class PolicyService extends Context.Service<
  PolicyService,
  {
    // Roles
    readonly roles: (missionId: MissionId) => Fx<RolesSnapshot>;
    readonly createRole: Write<CreateRoleInput>;
    readonly updateRole: Write<UpdateRoleInput>;
    readonly retireRole: Write<RetireRoleInput>;
    /** Applies at each holder's next turn; never mid-turn. Pass the current model to cancel. */
    readonly setRoleModel: Write<SetRoleModelInput>;
    readonly bindRole: Write<BindRoleInput>;
    readonly unbindRole: Write<UnbindRoleInput>;
    readonly succeedRole: Write<SucceedRoleInput, SucceedRoleResult>;
    // Review policy
    readonly reviewPolicy: (missionId: MissionId) => Fx<ReviewPolicySnapshot>;
    readonly editReviewPolicy: Write<EditReviewPolicyInput>;
    readonly setCriticalityGuide: Write<SetCriticalityGuideInput>;
    readonly recordCriticality: Write<RecordCriticalityInput>;
    readonly recordReview: Write<RecordReviewInput>;
    /** What a pull request needs next at this head, and whether it may merge. Never writes. */
    readonly reviewPlan: (request: ReviewPlanRequest) => Fx<ReviewPlan>;
    // ardud missions: core (M2)
    /** Verified PR facts from the owner, the master or crw; a fired trigger is recorded. */
    readonly recordTriggerFacts: Write<RecordTriggerFactsInput, RecordTriggerFactsResult>;
    // Pools
    readonly pools: (filter: { readonly missionId?: MissionId | undefined }) => Fx<PoolsSnapshot>;
    readonly createPool: Write<CreatePoolInput>;
    readonly updatePool: Write<UpdatePoolInput>;
    readonly setPoolCapacity: Write<SetPoolCapacityInput>;
    readonly setPoolSource: Write<SetPoolSourceInput>;
    readonly takeHold: Write<TakeHoldInput, TakeHoldResult>;
    readonly releaseHold: Write<ReleaseHoldInput>;
    /** The fence is the authority; whoever holds it may renew. */
    readonly renewHold: Write<RenewHoldInput, PoolHold>;
    readonly reconcileHold: Write<ReconcileHoldInput>;
    // Governor and upkeep
    readonly governor: Fx<GovernorView>;
    readonly runGovernor: (mode?: GovernorMode) => Fx<GovernorDecision>;
    /** Expires overdue holds and puts pending role models on idle holders. */
    readonly sweep: Fx<void>;
    // ardud missions: recovery
    /** Flips holds whose lease ran out to reconcile-required; recovery runs it on boot. */
    readonly expireHolds: Fx<void>;
    readonly sampleObservers: Fx<number>;
    /** Background loops: sweep every 30s, governor every 5 min, observers every 15 min. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/ardud/missions/policy/PolicyService") {}

export interface PolicyOptions {
  readonly governorMode: GovernorMode;
}

const DEFAULT_OPTIONS: PolicyOptions = { governorMode: "apply" };

const logFailures =
  (what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning(`mission policy ${what} failed`, { cause: Cause.pretty(cause) }),
      ),
    );

const make = (options: PolicyOptions) =>
  Effect.gen(function* () {
    const deps: PolicyDeps = {
      store: yield* MissionStore.MissionStore,
      missions: yield* MissionService.MissionService,
      policyStore: yield* PolicyStore.PolicyStore,
      threads: yield* PolicyThreads,
      succession: yield* PolicySuccession,
      sampler: yield* PolicySampler,
      holdLock: yield* Semaphore.make(1),
    };
    const suggestions = yield* PolicySuggestions;
    const memory = makeGovernorMemory();

    const sweep = Effect.gen(function* () {
      yield* Pools.sweepHolds(deps);
      yield* Roles.alignAll(deps);
    });
    const governor = (mode: GovernorMode = options.governorMode) =>
      runGovernor(deps, suggestions, memory, mode);

    const every = (
      what: string,
      period: Duration.Input,
      effect: Effect.Effect<unknown, MissionError>,
    ) => logFailures(what)(effect).pipe(Effect.repeat(Schedule.spaced(period)), Effect.asVoid);

    const start = Effect.gen(function* () {
      yield* forkParked(every("sweep", "30 seconds", sweep));
      yield* forkParked(every("governor", "5 minutes", governor()));
      yield* forkParked(every("observers", "15 minutes", Pools.sampleObservers(deps)));
    });

    return PolicyService.of({
      roles: (missionId) => Roles.rolesSnapshot(deps, missionId),
      createRole: (provenance, input) => Roles.createRole(deps, provenance, input),
      updateRole: (provenance, input) => Roles.updateRole(deps, provenance, input),
      retireRole: (provenance, input) => Roles.retireRole(deps, provenance, input),
      setRoleModel: (provenance, input) => Roles.setRoleModel(deps, provenance, input),
      bindRole: (provenance, input) => Roles.bindRole(deps, provenance, input),
      unbindRole: (provenance, input) => Roles.unbindRole(deps, provenance, input),
      succeedRole: (provenance, input) => Roles.succeedRole(deps, provenance, input),
      reviewPolicy: (missionId) => Reviews.reviewPolicySnapshot(deps, missionId),
      editReviewPolicy: (provenance, input) => Reviews.editReviewPolicy(deps, provenance, input),
      setCriticalityGuide: (provenance, input) =>
        Reviews.setCriticalityGuide(deps, provenance, input),
      recordCriticality: (provenance, input) => Reviews.recordCriticality(deps, provenance, input),
      recordReview: (provenance, input) => Reviews.recordReview(deps, provenance, input),
      reviewPlan: (request) => Reviews.planReview(deps, request),
      recordTriggerFacts: (provenance, input) =>
        Reviews.recordTriggerFacts(deps, provenance, input),
      pools: (filter) => Pools.poolsSnapshot(deps, filter),
      createPool: (provenance, input) => Pools.createPool(deps, provenance, input),
      updatePool: (provenance, input) => Pools.updatePool(deps, provenance, input),
      setPoolCapacity: (provenance, input) => Pools.setPoolCapacity(deps, provenance, input),
      setPoolSource: (provenance, input) => Pools.setPoolSource(deps, provenance, input),
      takeHold: (provenance, input) => Pools.takeHold(deps, provenance, input),
      releaseHold: (provenance, input) => Pools.releaseHold(deps, provenance, input),
      renewHold: (_provenance, input) => Pools.renewHold(deps, input),
      reconcileHold: (provenance, input) => Pools.reconcileHold(deps, provenance, input),
      governor: governorView(deps),
      runGovernor: governor,
      sweep,
      // ardud missions: recovery
      expireHolds: Pools.sweepHolds(deps),
      sampleObservers: Pools.sampleObservers(deps),
      start,
    });
  });

/** The service alone. Needs MissionStore, MissionService, PolicyStore and the ports. */
export const makeLayer = (options: Partial<PolicyOptions> = {}) =>
  Layer.effect(PolicyService, make({ ...DEFAULT_OPTIONS, ...options }));

export const layer = makeLayer();
