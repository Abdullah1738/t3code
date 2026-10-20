import {
  CriticalityVerdictId,
  ReviewRecordId,
  type CriticalityVerdict,
  type EditReviewPolicyInput,
  type MissionError,
  type MissionId,
  type MissionMutationResult,
  type MissionProvenance,
  type MissionRecordRef,
  type PullRequestKey,
  type RecordCriticalityInput,
  type RecordReviewInput,
  type RecordTriggerFactsInput,
  type RecordTriggerFactsResult,
  type ReviewPlan,
  type ReviewPlanRequest,
  type ReviewPolicy,
  type ReviewPolicySnapshot,
  type ReviewRecord,
  type ReviewStage,
  type Role,
  type SetCriticalityGuideInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  POLICY_PROVENANCE,
  activeBindings,
  attempt,
  eventDraft,
  failWith,
  missionRoles,
  nowIso,
  requireGovern,
  requireMission,
  resolveCaller,
  recordsByIds,
  shortId,
  systemCaller,
  type Caller,
  type PolicyDeps,
} from "./context.ts";
import { modelKey } from "./models.ts";
import { callerModelKey } from "./roleOps.ts";
import {
  defaultReviewPolicy,
  editPolicy,
  effectiveVerdict,
  latestVerdict,
  mayJudge,
  newVerdict,
  pullRequestLabel,
  reviewPlan,
  validatePolicy,
  validateRecord,
  type PolicyEdit,
} from "./review.ts";

const policyRef = (missionId: MissionId): MissionRecordRef => ({
  kind: "review-policy",
  id: missionId,
  label: "review policy",
});

const verdictRef = (verdict: CriticalityVerdict): MissionRecordRef => ({
  kind: "criticality-verdict",
  id: verdict.id,
  label: pullRequestLabel(verdict.pullRequest),
});

const reviewRef = (record: ReviewRecord): MissionRecordRef => ({
  kind: "review",
  id: record.id,
  label: pullRequestLabel(record.pullRequest),
});

const shortSha = (sha: string) => (sha.length > 12 ? sha.slice(0, 12) : sha);

/** The stored policy, or the defaults (one reviewer stage; Astra final for critical PRs). */
export const loadPolicy = (deps: PolicyDeps, missionId: MissionId) =>
  Effect.gen(function* () {
    const stored = yield* deps.store.get("review-policy", missionId);
    if (Option.isSome(stored)) return { policy: stored.value, stored: true };
    const now = yield* nowIso;
    return { policy: defaultReviewPolicy(missionId, now), stored: false };
  });

export const reviewPolicySnapshot = (
  deps: PolicyDeps,
  missionId: MissionId,
): Effect.Effect<ReviewPolicySnapshot, MissionError> =>
  Effect.gen(function* () {
    yield* requireMission(deps, missionId);
    const loaded = yield* loadPolicy(deps, missionId);
    const recent = { missionId, limit: RECENT_REVIEWS } as const;
    const verdicts = yield* deps.store.list("criticality-verdict", recent);
    const reviews = yield* deps.store.list("review", recent);
    return { ...loaded, verdicts, reviews };
  });

/** How many of the mission's latest verdicts and review rounds the snapshot carries. */
const RECENT_REVIEWS = 100;

const savePolicy = (
  deps: PolicyDeps,
  caller: Caller,
  policy: ReviewPolicy,
  summary: string,
  payload: unknown,
) =>
  deps.store
    .commit({
      event: eventDraft(
        caller,
        policy.missionId,
        "review-policy.updated",
        summary,
        policyRef(policy.missionId),
        payload,
      ),
      upserts: [{ _tag: "review-policy", record: policy }],
    })
    .pipe(
      Effect.map((committed): MissionMutationResult => ({
        seq: committed.seq,
        ref: policyRef(policy.missionId),
      })),
    );

const applyEdit = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  missionId: MissionId,
  edit: PolicyEdit,
  describe: (next: ReviewPolicy) => string,
) =>
  Effect.gen(function* () {
    yield* requireMission(deps, missionId);
    const caller = yield* resolveCaller(deps, provenance, missionId);
    yield* requireGovern(caller, "change the review policy");
    const now = yield* nowIso;
    const { policy } = yield* loadPolicy(deps, missionId);
    const next = yield* attempt(() => editPolicy(policy, edit, { by: caller.actor, now }));
    const roles = yield* missionRoles(deps, missionId, now);
    yield* attempt(() => validatePolicy(next, roles.all));
    const fields = Object.keys(edit).filter(
      (field) => edit[field as keyof PolicyEdit] !== undefined,
    );
    return yield* savePolicy(deps, caller, next, describe(next), {
      version: next.version,
      guideVersion: next.guide.version,
      fields,
    });
  });

export const editReviewPolicy = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: EditReviewPolicyInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  applyEdit(
    deps,
    provenance,
    input.missionId,
    {
      stages: input.stages,
      ladders: input.ladders,
      commonRules: input.commonRules,
      judgedBy: input.judgedBy,
    },
    (next) =>
      `Review policy v${next.version}: ${next.ladders.map((ladder) => ladder.name).join(", ")}`,
  );

/** The master writes the guide; the owner can edit or lock it. An empty guide makes every PR normal. */
export const setCriticalityGuide = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: SetCriticalityGuideInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  applyEdit(
    deps,
    provenance,
    input.missionId,
    { guide: { text: input.text, hardTriggers: input.hardTriggers } },
    (next) =>
      next.guide.text.trim().length === 0
        ? `Criticality guide v${next.guide.version} cleared: every PR is normal`
        : `Criticality guide v${next.guide.version}: ${next.guide.text}`,
  );

/** Stores the default policy so the owner can lock its fields. */
export const materializePolicy = (deps: PolicyDeps, missionId: MissionId) =>
  Effect.gen(function* () {
    yield* requireMission(deps, missionId);
    const loaded = yield* loadPolicy(deps, missionId);
    if (loaded.stored) return loaded.policy;
    yield* savePolicy(
      deps,
      systemCaller(POLICY_PROVENANCE),
      loaded.policy,
      "Review policy stored from the defaults",
      { version: loaded.policy.version, fields: [] },
    );
    return loaded.policy;
  });

const verdictsFor = (deps: PolicyDeps, missionId: MissionId, pullRequest: PullRequestKey) =>
  Effect.gen(function* () {
    const ids = yield* deps.policyStore.reviewIds("criticality-verdict", missionId, pullRequest);
    return yield* recordsByIds(deps.store, "criticality-verdict", ids);
  });

const recordsFor = (deps: PolicyDeps, missionId: MissionId, pullRequest: PullRequestKey) =>
  Effect.gen(function* () {
    const ids = yield* deps.policyStore.reviewIds("review", missionId, pullRequest);
    return yield* recordsByIds(deps.store, "review", ids);
  });

/**
 * Verdict ids carry the PR's running count so two verdicts in the same
 * millisecond still sort in the order they were made.
 */
const sequenced = (verdict: CriticalityVerdict, count: number): CriticalityVerdict => ({
  ...verdict,
  id: CriticalityVerdictId.make(
    `${verdict.missionId}:${pullRequestLabel(verdict.pullRequest)}:${verdict.createdAt}:${String(count + 1).padStart(6, "0")}:${verdict.source}`,
  ),
});

const saveVerdict = (deps: PolicyDeps, caller: Caller, verdict: CriticalityVerdict) =>
  deps.store.commit({
    event: eventDraft(
      caller,
      verdict.missionId,
      "criticality.recorded",
      `${pullRequestLabel(verdict.pullRequest)} is ${verdict.critical ? "critical" : "normal"} (${verdict.source}): ${verdict.reason}`,
      verdictRef(verdict),
      {
        pullRequest: verdict.pullRequest,
        critical: verdict.critical,
        source: verdict.source,
        guideVersion: verdict.guideVersion,
        supersedesId: verdict.supersedesId,
      },
    ),
    upserts: [{ _tag: "criticality-verdict", record: verdict }],
    alongside: deps.policyStore.indexReview(
      "criticality-verdict",
      verdict.id,
      verdict.missionId,
      verdict.pullRequest,
    ),
  });

/**
 * Records whether a PR is critical. The owner or the master judges (lane leads
 * too when the policy delegates); the newest verdict wins, whoever made it.
 */
export const recordCriticality = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: RecordCriticalityInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  Effect.gen(function* () {
    yield* requireMission(deps, input.missionId);
    const caller = yield* resolveCaller(deps, provenance, input.missionId);
    const { policy } = yield* loadPolicy(deps, input.missionId);
    if (!(caller.trusted || caller.isMaster || mayJudge(policy, caller.role, caller.byOwner))) {
      return yield* failWith(
        "forbidden",
        policy.judgedBy === "lane-leads"
          ? "Only the owner, the master or a lane lead can judge criticality."
          : "Only the owner or the master can judge criticality.",
      );
    }
    const reason = input.reason.trim();
    if (reason.length === 0) return yield* failWith("invalid", "A verdict needs a reason.");
    const now = yield* nowIso;
    const existing = yield* verdictsFor(deps, input.missionId, input.pullRequest);
    const previous = latestVerdict(existing);
    const made = newVerdict({
      missionId: input.missionId,
      pullRequest: input.pullRequest,
      critical: input.critical,
      reason,
      guide: policy.guide,
      decidedBy: caller.actor,
      previous,
      now,
    });
    const verdict = sequenced(made, existing.length);
    const committed = yield* saveVerdict(deps, caller, verdict);
    return { seq: committed.seq, ref: verdictRef(verdict) };
  });

// ardud missions: core
/** Components that run review stages and record them in their own name. */
export const REVIEW_RECORDERS: ReadonlySet<string> = new Set(["crw"]);

/**
 * Who may record a stage's review: the owner, the master, the policy's own
 * components, a review runner (crw), a thread bound to the stage's role, or a
 * thread holding a role of a kind the master listed in `recordedBy`.
 * A record moves the merge gate, so nobody else does.
 */
const stageRecorder = (
  deps: PolicyDeps,
  caller: Caller,
  missionId: MissionId,
  stage: ReviewStage,
  roles: ReadonlyArray<Role>,
): Effect.Effect<"holder" | "delegate" | null, MissionError> => {
  const { provenance } = caller;
  if (caller.byOwner || caller.isMaster || caller.trusted) return Effect.succeed("holder");
  if (provenance._tag === "system")
    return Effect.succeed(REVIEW_RECORDERS.has(provenance.component) ? "holder" : null);
  if (provenance._tag !== "agent") return Effect.succeed(null);
  const delegated = new Set<string>(stage.recordedBy ?? []);
  return activeBindings(deps, missionId).pipe(
    Effect.map((bindings) => {
      const held = bindings.filter((binding) => binding.threadId === provenance.threadId);
      if (held.some((binding) => binding.roleId === stage.roleId)) return "holder";
      if (delegated.size === 0) return null;
      const heldIds = new Set<string>(held.map((binding) => binding.roleId));
      return roles.some((role) => heldIds.has(role.id) && delegated.has(role.kind))
        ? "delegate"
        : null;
    }),
  );
};

/**
 * Stores one review run as evidence bound to the exact head it read. The
 * stage's role is recorded; the model defaults to what the calling thread runs.
 */
export const recordReview = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: RecordReviewInput,
): Effect.Effect<MissionMutationResult, MissionError> =>
  Effect.gen(function* () {
    yield* requireMission(deps, input.missionId);
    const caller = yield* resolveCaller(deps, provenance, input.missionId);
    const now = yield* nowIso;
    const { policy } = yield* loadPolicy(deps, input.missionId);
    const stage = policy.stages.find((candidate) => candidate.id === input.stageId);
    if (!stage) return yield* failWith("invalid", `Unknown review stage ${input.stageId}.`);
    const roles = yield* missionRoles(deps, input.missionId, now);
    // ardud missions: core
    const recorder = yield* stageRecorder(deps, caller, input.missionId, stage, roles.all);
    if (recorder === null) {
      return yield* failWith(
        "forbidden",
        `Only the owner, the master, crw or a thread holding ${stage.roleId} records ${stage.label}. The master can let other role kinds record it (recordedBy on the stage).`,
      );
    }
    const role = roles.all.find((candidate) => candidate.id === stage.roleId);
    if (!role) {
      return yield* failWith(
        "invalid",
        `Stage ${stage.id} points at unknown role ${stage.roleId}.`,
      );
    }
    // A delegate relays the stage role's run, so its own thread's model would misname the reviewer.
    const model =
      input.model ??
      (recorder === "delegate"
        ? modelKey(role.modelSelection)
        : yield* callerModelKey(deps, caller, role));
    const earlier = yield* deps.policyStore.reviewIds("review", input.missionId, input.pullRequest);
    const record: ReviewRecord = {
      // The running count keeps same-millisecond records in the order they were made.
      id: ReviewRecordId.make(shortId(`review-${String(earlier.length + 1).padStart(6, "0")}`)),
      missionId: input.missionId,
      pullRequest: input.pullRequest,
      stageId: stage.id,
      headSha: input.headSha,
      roleId: role.id,
      model,
      verdict: input.verdict,
      findings: input.findings ?? 0,
      severeFindings: input.severeFindings ?? 0,
      links: [...(input.links ?? [])],
      createdAt: now,
    };
    yield* attempt(() => validateRecord(policy, record));
    const findings =
      record.findings > 0
        ? ` with ${record.findings} finding(s)${record.severeFindings > 0 ? `, ${record.severeFindings} severe` : ""}`
        : "";
    const committed = yield* deps.store.commit({
      event: eventDraft(
        caller,
        input.missionId,
        "review.recorded",
        `${stage.label} ${record.verdict.toUpperCase()} on ${pullRequestLabel(record.pullRequest)} at ${shortSha(record.headSha)}${findings}`,
        reviewRef(record),
        {
          pullRequest: record.pullRequest,
          stageId: record.stageId,
          headSha: record.headSha,
          verdict: record.verdict,
          model: record.model,
        },
      ),
      upserts: [{ _tag: "review", record }],
      alongside: deps.policyStore.indexReview(
        "review",
        record.id,
        record.missionId,
        record.pullRequest,
      ),
    });
    return { seq: committed.seq, ref: reviewRef(record) };
  });

/**
 * What a PR needs next at `headSha`: its verdict, each stage's state, the next
 * stage with its role and model, and whether it may merge. A pure read: facts
 * that fire a hard trigger count in this plan only. `recordTriggerFacts`
 * records them.
 */
export const planReview = (
  deps: PolicyDeps,
  request: ReviewPlanRequest,
): Effect.Effect<ReviewPlan, MissionError> =>
  Effect.gen(function* () {
    yield* requireMission(deps, request.missionId);
    const now = yield* nowIso;
    const { policy } = yield* loadPolicy(deps, request.missionId);
    const roles = yield* missionRoles(deps, request.missionId, now);
    const result = reviewPlan({
      policy,
      pullRequest: request.pullRequest,
      headSha: request.headSha,
      verdicts: yield* verdictsFor(deps, request.missionId, request.pullRequest),
      records: yield* recordsFor(deps, request.missionId, request.pullRequest),
      roles: roles.all,
      customLadderIds: request.customLadderIds,
      facts: request.facts,
      now,
    });
    // ardud missions: core (M2) - reading never stores a verdict.
    return result.plan;
  });

// ardud missions: core (M2)
/** Components that read PR facts from the forge and may report them. */
export const TRIGGER_REPORTERS: ReadonlySet<string> = new Set(["crw"]);

/**
 * Records a fired hard trigger as the PR's verdict, in the reporter's name.
 * Only the component that read the facts from the forge (crw) reports them;
 * the owner and the master judge a PR directly with `recordCriticality`.
 * Nothing fires, or a trigger is already on record: nothing is written.
 */
export const recordTriggerFacts = (
  deps: PolicyDeps,
  provenance: MissionProvenance,
  input: RecordTriggerFactsInput,
): Effect.Effect<RecordTriggerFactsResult, MissionError> =>
  Effect.gen(function* () {
    yield* requireMission(deps, input.missionId);
    const caller = yield* resolveCaller(deps, provenance, input.missionId);
    if (!(provenance._tag === "system" && TRIGGER_REPORTERS.has(provenance.component))) {
      return yield* failWith(
        "forbidden",
        "Only crw reports the PR facts a hard trigger reads; the owner or the master records a verdict with mission_criticality.",
      );
    }
    const now = yield* nowIso;
    const { policy } = yield* loadPolicy(deps, input.missionId);
    const verdicts = yield* verdictsFor(deps, input.missionId, input.pullRequest);
    const { unrecordedTrigger } = effectiveVerdict({
      policy,
      pullRequest: input.pullRequest,
      verdicts,
      facts: input.facts,
      now,
    });
    if (unrecordedTrigger === null) {
      return { recorded: false, verdict: latestVerdict(verdicts) };
    }
    const verdict = sequenced({ ...unrecordedTrigger, decidedBy: caller.actor }, verdicts.length);
    yield* saveVerdict(deps, caller, verdict);
    return { recorded: true, verdict };
  });
