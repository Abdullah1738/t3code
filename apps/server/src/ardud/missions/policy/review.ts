/**
 * Review policy: stages point at roles, ladders order the stages, the
 * criticality guide decides which ladder a PR takes, and review records are
 * evidence bound to the exact head they reviewed.
 *
 * `reviewPlan` answers the one question crw and lanes ask: what does this PR
 * need next at this head, and may it merge.
 *
 * Pure functions only. `PolicyService` persists the results.
 */
import {
  type CriticalityGuide,
  type CriticalityTrigger,
  type CriticalityVerdict,
  CriticalityVerdictId,
  type MissionActor,
  MissionError,
  type MissionId,
  type ModelSelection,
  type PullRequestKey,
  type ReviewLadder,
  ReviewLadderId,
  type ReviewPlan,
  type ReviewPolicy,
  type ReviewRecord,
  type ReviewStage,
  ReviewStageId,
  type Role,
} from "@t3tools/contracts";

import { matchesGlob } from "./glob.ts";
import { defaultRoleId, isLocked } from "./roles.ts";

export const REVIEWER_STAGE_ID = ReviewStageId.make("reviewer");
export const FINAL_STAGE_ID = ReviewStageId.make("final");
export const NORMAL_LADDER_ID = ReviewLadderId.make("normal");
export const CRITICAL_LADDER_ID = ReviewLadderId.make("critical");

const POLICY_COMPONENT: MissionActor = { _tag: "system", component: "review-policy" };

export const COMMON_RULES: ReadonlyArray<string> = [
  "No round cap: a stage runs again until it is CLEAR at the exact head.",
  "Fixes go out as one-sitting packets, not one finding at a time.",
  "Reviewers never write public text. Their output is findings; a writer turns it into text.",
];

/**
 * A new mission's policy. Without a guide every PR is normal, so it runs the
 * reviewer stage until CLEAR. Critical PRs add the final reviewer at the
 * exact head after the reviewer stage clears.
 */
export function defaultReviewPolicy(missionId: MissionId, now: string): ReviewPolicy {
  return {
    missionId,
    version: 1,
    stages: [
      { id: REVIEWER_STAGE_ID, label: "Review", roleId: defaultRoleId(missionId, "reviewer") },
      {
        id: FINAL_STAGE_ID,
        label: "Final review",
        roleId: defaultRoleId(missionId, "final-reviewer"),
      },
    ],
    ladders: [
      {
        id: NORMAL_LADDER_ID,
        name: "Normal",
        appliesTo: "normal",
        condition: null,
        stageIds: [REVIEWER_STAGE_ID],
      },
      {
        id: CRITICAL_LADDER_ID,
        name: "Critical",
        appliesTo: "critical",
        condition: null,
        stageIds: [REVIEWER_STAGE_ID, FINAL_STAGE_ID],
      },
    ],
    commonRules: [...COMMON_RULES],
    guide: { text: "", hardTriggers: [], version: 0, authoredBy: POLICY_COMPONENT, updatedAt: now },
    judgedBy: "master",
    lockedFields: [],
    updatedAt: now,
  };
}

/** True when no guide exists yet, which makes every PR normal. */
export function guideIsEmpty(guide: CriticalityGuide): boolean {
  return guide.text.trim() === "" && guide.hardTriggers.length === 0;
}

/** What the caller knows about a PR at this head. Used only for hard triggers. */
export interface PullRequestFacts {
  readonly changedLines?: number | undefined;
  readonly paths?: ReadonlyArray<string> | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
}

export function triggerLabel(trigger: CriticalityTrigger): string {
  switch (trigger._tag) {
    case "changed-lines":
      return `${trigger.atLeast}+ changed lines`;
    case "path":
      return `touches ${trigger.pattern}`;
    case "label":
      return `label ${trigger.label}`;
  }
}

/** The hard triggers these facts hit, in guide order. */
export function firedTriggers(
  guide: CriticalityGuide,
  facts: PullRequestFacts,
): ReadonlyArray<CriticalityTrigger> {
  return guide.hardTriggers.filter((trigger) => {
    switch (trigger._tag) {
      case "changed-lines":
        return facts.changedLines !== undefined && facts.changedLines >= trigger.atLeast;
      case "path":
        return (facts.paths ?? []).some((path) => matchesGlob(trigger.pattern, path));
      case "label": {
        const wanted = trigger.label.toLowerCase();
        return (facts.labels ?? []).some((label) => label.toLowerCase() === wanted);
      }
    }
  });
}

export function samePullRequest(left: PullRequestKey, right: PullRequestKey): boolean {
  return (
    left.number === right.number && left.repository.toLowerCase() === right.repository.toLowerCase()
  );
}

export function pullRequestLabel(pr: PullRequestKey): string {
  return `${pr.repository}#${pr.number}`;
}

/** Newest first by creation time, ties broken by id so the order is stable. */
function newestFirst<T extends { readonly createdAt: string; readonly id: string }>(
  items: ReadonlyArray<T>,
): Array<T> {
  return [...items].sort((left, right) =>
    left.createdAt === right.createdAt
      ? right.id.localeCompare(left.id)
      : right.createdAt.localeCompare(left.createdAt),
  );
}

export function latestVerdict(
  verdicts: ReadonlyArray<CriticalityVerdict>,
): CriticalityVerdict | null {
  return newestFirst(verdicts)[0] ?? null;
}

/**
 * Builds the verdict a master, lane lead or the owner records. The owner's
 * word is source `owner`; changing an earlier verdict is `reclassified`.
 */
export function newVerdict(input: {
  readonly missionId: MissionId;
  readonly pullRequest: PullRequestKey;
  readonly critical: boolean;
  readonly reason: string;
  readonly guide: CriticalityGuide;
  readonly decidedBy: MissionActor;
  readonly previous: CriticalityVerdict | null;
  readonly source?: CriticalityVerdict["source"];
  readonly now: string;
}): CriticalityVerdict {
  const source =
    input.source ??
    (input.decidedBy._tag === "owner"
      ? "owner"
      : input.previous === null
        ? "guide"
        : "reclassified");
  return {
    id: CriticalityVerdictId.make(
      `${input.missionId}:${pullRequestLabel(input.pullRequest)}:${input.now}:${source}`,
    ),
    missionId: input.missionId,
    pullRequest: input.pullRequest,
    critical: input.critical,
    reason: input.reason,
    guideVersion: input.guide.version,
    source,
    decidedBy: input.decidedBy,
    supersedesId: input.previous?.id ?? null,
    createdAt: input.now,
  };
}

/** The verdict a hard trigger forces. Recorded by the policy itself, never asked. */
export function triggerVerdict(input: {
  readonly missionId: MissionId;
  readonly pullRequest: PullRequestKey;
  readonly guide: CriticalityGuide;
  readonly fired: ReadonlyArray<CriticalityTrigger>;
  readonly previous: CriticalityVerdict | null;
  readonly now: string;
}): CriticalityVerdict {
  return newVerdict({
    missionId: input.missionId,
    pullRequest: input.pullRequest,
    critical: true,
    reason: `hard trigger: ${input.fired.map(triggerLabel).join(", ")}`,
    guide: input.guide,
    decidedBy: POLICY_COMPONENT,
    previous: input.previous,
    source: "hard-trigger",
    now: input.now,
  });
}

export interface EffectiveVerdict {
  readonly verdict: CriticalityVerdict | null;
  readonly critical: boolean;
  /** Set when a hard trigger fired and no stored verdict says so yet. */
  readonly unrecordedTrigger: CriticalityVerdict | null;
}

/**
 * Which verdict decides the ladder. The owner's latest word wins over
 * everything. Otherwise a hard trigger forces critical, even over a master
 * reclassification. Otherwise the latest verdict stands. No verdict means
 * normal.
 */
export function effectiveVerdict(input: {
  readonly policy: ReviewPolicy;
  readonly pullRequest: PullRequestKey;
  readonly verdicts: ReadonlyArray<CriticalityVerdict>;
  readonly facts?: PullRequestFacts | undefined;
  readonly now: string;
}): EffectiveVerdict {
  const ordered = newestFirst(input.verdicts);
  const owner = ordered.find((verdict) => verdict.source === "owner");
  if (owner) return { verdict: owner, critical: owner.critical, unrecordedTrigger: null };

  const storedTrigger = ordered.find((verdict) => verdict.source === "hard-trigger");
  const fired = input.facts ? firedTriggers(input.policy.guide, input.facts) : [];
  if (fired.length > 0 && !storedTrigger) {
    const verdict = triggerVerdict({
      missionId: input.policy.missionId,
      pullRequest: input.pullRequest,
      guide: input.policy.guide,
      fired,
      previous: ordered[0] ?? null,
      now: input.now,
    });
    return { verdict, critical: true, unrecordedTrigger: verdict };
  }
  if (storedTrigger) {
    return { verdict: storedTrigger, critical: true, unrecordedTrigger: null };
  }
  const latest = ordered[0] ?? null;
  return { verdict: latest, critical: latest?.critical ?? false, unrecordedTrigger: null };
}

export function ladderFor(policy: ReviewPolicy, critical: boolean): ReviewLadder | null {
  const appliesTo = critical ? "critical" : "normal";
  return policy.ladders.find((ladder) => ladder.appliesTo === appliesTo) ?? null;
}

/** Stage ids for the PR: its base ladder, then any custom ladders picked for it. */
export function ladderStageIds(
  policy: ReviewPolicy,
  base: ReviewLadder | null,
  customLadderIds: ReadonlyArray<ReviewLadder["id"]>,
): Array<ReviewStage["id"]> {
  const ids: Array<ReviewStage["id"]> = [...(base?.stageIds ?? [])];
  for (const ladderId of customLadderIds) {
    const ladder = policy.ladders.find((candidate) => candidate.id === ladderId);
    for (const stageId of ladder?.stageIds ?? []) {
      if (!ids.includes(stageId)) ids.push(stageId);
    }
  }
  return ids;
}

type StageState = ReviewPlan["stages"][number]["state"];

export interface StageStatus {
  readonly stage: ReviewStage;
  readonly state: StageState;
  readonly last: ReviewRecord | null;
  /** The newest record at this head, if any. */
  readonly atHead: ReviewRecord | null;
}

/**
 * Where one stage stands at `headSha`. Only a CLEAR at this exact head counts
 * as done. A CLEAR at an older head is `done-at-older-head` and has to run
 * again. Findings or a block mean `needs-rerun`.
 */
export function stageStatus(
  stage: ReviewStage,
  records: ReadonlyArray<ReviewRecord>,
  headSha: string,
): StageStatus {
  const own = newestFirst(records.filter((record) => record.stageId === stage.id));
  const last = own[0] ?? null;
  const atHead = own.find((record) => record.headSha === headSha) ?? null;
  if (atHead) {
    return {
      stage,
      state: atHead.verdict === "clear" ? "done-at-head" : "needs-rerun",
      last: atHead,
      atHead,
    };
  }
  if (!last) return { stage, state: "pending", last: null, atHead: null };
  return {
    stage,
    state: last.verdict === "clear" ? "done-at-older-head" : "needs-rerun",
    last,
    atHead: null,
  };
}

export interface ReviewPlanInput {
  readonly policy: ReviewPolicy;
  readonly pullRequest: PullRequestKey;
  readonly headSha: string;
  readonly verdicts: ReadonlyArray<CriticalityVerdict>;
  readonly records: ReadonlyArray<ReviewRecord>;
  readonly roles: ReadonlyArray<Role>;
  readonly customLadderIds?: ReadonlyArray<ReviewLadder["id"]> | undefined;
  readonly facts?: PullRequestFacts | undefined;
  readonly now: string;
}

export interface ReviewPlanResult {
  readonly plan: ReviewPlan;
  /** A hard-trigger verdict the caller should persist. */
  readonly unrecordedTrigger: CriticalityVerdict | null;
}

/** The model a stage runs. New review threads start on a pending change right away. */
function stageModel(role: Role): ModelSelection {
  return role.pendingModelSelection ?? role.modelSelection;
}

/**
 * Walks the PR's ladder in order at `headSha`. The first stage that is not
 * CLEAR at this head is next. A stage that found problems at this head waits
 * for a fix push, except a `blocked` run, which can go again at the same head.
 * A critical PR whose final review finds problems goes back through the
 * reviewer stage at the new head, because that stage's CLEAR is now at an
 * older head.
 */
export function reviewPlan(input: ReviewPlanInput): ReviewPlanResult {
  const { policy, pullRequest, headSha } = input;
  const records = input.records.filter(
    (record) =>
      record.missionId === policy.missionId && samePullRequest(record.pullRequest, pullRequest),
  );
  const verdicts = input.verdicts.filter(
    (verdict) =>
      verdict.missionId === policy.missionId && samePullRequest(verdict.pullRequest, pullRequest),
  );
  const effective = effectiveVerdict({
    policy,
    pullRequest,
    verdicts,
    facts: input.facts,
    now: input.now,
  });
  const ladder = ladderFor(policy, effective.critical);
  const stageIds = ladderStageIds(policy, ladder, input.customLadderIds ?? []);

  const base = {
    missionId: policy.missionId,
    pullRequest,
    headSha,
    verdict: effective.verdict,
    ladderId: ladder?.id ?? null,
  };
  const blockedPlan = (reason: string): ReviewPlanResult => ({
    plan: { ...base, stages: [], next: null, mergeAllowed: false, reason },
    unrecordedTrigger: effective.unrecordedTrigger,
  });

  if (!ladder) {
    return blockedPlan(`the policy has no ${effective.critical ? "critical" : "normal"} ladder`);
  }
  const statuses: Array<StageStatus> = [];
  for (const stageId of stageIds) {
    const stage = policy.stages.find((candidate) => candidate.id === stageId);
    if (!stage) return blockedPlan(`ladder ${ladder.id} names unknown stage ${stageId}`);
    statuses.push(stageStatus(stage, records, headSha));
  }

  const stages = statuses.map((status) => ({
    stageId: status.stage.id,
    label: status.stage.label,
    state: status.state,
    lastRecordId: status.last?.id ?? null,
  }));

  const open = statuses.find((status) => status.state !== "done-at-head");
  const needsVerdict = effective.verdict === null && !guideIsEmpty(policy.guide);
  const verdictNote = needsVerdict
    ? ` It still needs a criticality verdict against guide v${policy.guide.version}.`
    : "";

  if (!open) {
    return {
      plan: {
        ...base,
        stages,
        next: null,
        mergeAllowed: !needsVerdict,
        reason: needsVerdict
          ? `Every stage is CLEAR at ${shortSha(headSha)}.${verdictNote}`
          : `Every stage is CLEAR at ${shortSha(headSha)}.`,
      },
      unrecordedTrigger: effective.unrecordedTrigger,
    };
  }

  const waitingForFix = open.atHead !== null && open.atHead.verdict === "findings";
  if (waitingForFix) {
    const found = open.atHead!;
    return {
      plan: {
        ...base,
        stages,
        next: null,
        mergeAllowed: false,
        reason:
          `${open.stage.label} found ${found.findings} finding(s) at ${shortSha(headSha)}. ` +
          `It runs again after the fix is pushed.${verdictNote}`,
      },
      unrecordedTrigger: effective.unrecordedTrigger,
    };
  }

  const role = input.roles.find((candidate) => candidate.id === open.stage.roleId);
  if (!role) {
    return {
      plan: {
        ...base,
        stages,
        next: null,
        mergeAllowed: false,
        reason: `${open.stage.label} points at role ${open.stage.roleId}, which does not exist.`,
      },
      unrecordedTrigger: effective.unrecordedTrigger,
    };
  }
  const why =
    open.state === "done-at-older-head"
      ? `${open.stage.label} was CLEAR at an older head; it runs again at ${shortSha(headSha)}.`
      : open.state === "needs-rerun"
        ? `${open.stage.label} runs again at ${shortSha(headSha)}.`
        : `${open.stage.label} has not run at ${shortSha(headSha)} yet.`;
  return {
    plan: {
      ...base,
      stages,
      next: { stageId: open.stage.id, roleId: role.id, modelSelection: stageModel(role) },
      mergeAllowed: false,
      reason: `${why}${verdictNote}`,
    },
    unrecordedTrigger: effective.unrecordedTrigger,
  };
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/** Checks a review record against the policy before it is stored. */
export function validateRecord(policy: ReviewPolicy, record: ReviewRecord): void {
  const stage = policy.stages.find((candidate) => candidate.id === record.stageId);
  if (!stage) {
    throw new MissionError({ code: "invalid", detail: `unknown review stage ${record.stageId}` });
  }
  if (record.verdict === "clear" && record.findings > 0) {
    throw new MissionError({ code: "invalid", detail: "a CLEAR review cannot carry findings" });
  }
  if (record.severeFindings > record.findings) {
    throw new MissionError({
      code: "invalid",
      detail: "severe findings cannot outnumber findings",
    });
  }
}

/** Checks ladders and stages hang together and every stage names a known role. */
export function validatePolicy(policy: ReviewPolicy, roles: ReadonlyArray<Role>): void {
  const stageIds = new Set(policy.stages.map((stage) => stage.id));
  if (stageIds.size !== policy.stages.length) {
    throw new MissionError({ code: "invalid", detail: "review stage ids must be unique" });
  }
  const ladderIds = new Set(policy.ladders.map((ladder) => ladder.id));
  if (ladderIds.size !== policy.ladders.length) {
    throw new MissionError({ code: "invalid", detail: "review ladder ids must be unique" });
  }
  for (const appliesTo of ["normal", "critical"] as const) {
    const count = policy.ladders.filter((ladder) => ladder.appliesTo === appliesTo).length;
    if (count !== 1) {
      throw new MissionError({
        code: "invalid",
        detail: `the policy needs exactly one ${appliesTo} ladder, found ${count}`,
      });
    }
  }
  for (const ladder of policy.ladders) {
    if (ladder.stageIds.length === 0) {
      throw new MissionError({ code: "invalid", detail: `ladder ${ladder.id} has no stages` });
    }
    for (const stageId of ladder.stageIds) {
      if (!stageIds.has(stageId)) {
        throw new MissionError({
          code: "invalid",
          detail: `ladder ${ladder.id} names unknown stage ${stageId}`,
        });
      }
    }
    if (ladder.appliesTo === "custom" && !ladder.condition?.trim()) {
      throw new MissionError({
        code: "invalid",
        detail: `custom ladder ${ladder.id} needs a condition`,
      });
    }
  }
  const roleIds = new Set(roles.map((role) => role.id));
  for (const stage of policy.stages) {
    if (!roleIds.has(stage.roleId)) {
      throw new MissionError({
        code: "invalid",
        detail: `stage ${stage.id} points at unknown role ${stage.roleId}`,
      });
    }
  }
}

/** Policy fields a master edit may touch. The owner may lock any of them. */
export type PolicyField = "guide" | "stages" | "ladders" | "commonRules" | "judgedBy";

export interface PolicyEdit {
  readonly guide?:
    | {
        readonly text: string;
        readonly hardTriggers?: ReadonlyArray<CriticalityTrigger> | undefined;
      }
    | undefined;
  readonly stages?: ReadonlyArray<ReviewStage> | undefined;
  readonly ladders?: ReadonlyArray<ReviewLadder> | undefined;
  readonly commonRules?: ReadonlyArray<string> | undefined;
  readonly judgedBy?: ReviewPolicy["judgedBy"] | undefined;
}

/**
 * Applies an edit. Locked fields refuse non-owner edits. A guide edit bumps
 * the guide version; any edit bumps the policy version.
 */
export function editPolicy(
  policy: ReviewPolicy,
  edit: PolicyEdit,
  options: { readonly by: MissionActor; readonly byOwner: boolean; readonly now: string },
): ReviewPolicy {
  const touched = (Object.keys(edit) as Array<PolicyField>).filter(
    (field) => edit[field] !== undefined,
  );
  if (touched.length === 0) {
    throw new MissionError({ code: "invalid", detail: "the edit changes nothing" });
  }
  if (!options.byOwner) {
    const locked = touched.filter((field) => isLocked(policy.lockedFields, field));
    if (locked.length > 0) {
      throw new MissionError({
        code: "locked",
        detail: `the owner locked ${locked.join(", ")} on this review policy`,
      });
    }
  }
  const guide = edit.guide
    ? {
        text: edit.guide.text,
        hardTriggers: [...(edit.guide.hardTriggers ?? policy.guide.hardTriggers)],
        version: policy.guide.version + 1,
        authoredBy: options.by,
        updatedAt: options.now,
      }
    : policy.guide;
  return {
    ...policy,
    version: policy.version + 1,
    stages: edit.stages ? [...edit.stages] : policy.stages,
    ladders: edit.ladders ? [...edit.ladders] : policy.ladders,
    commonRules: edit.commonRules ? [...edit.commonRules] : policy.commonRules,
    judgedBy: edit.judgedBy ?? policy.judgedBy,
    guide,
    updatedAt: options.now,
  };
}

/**
 * Who may record a verdict: the owner always; the master always; lane leads
 * only when the policy delegates judging to them.
 */
export function mayJudge(policy: ReviewPolicy, actorRole: Role | null, byOwner: boolean): boolean {
  if (byOwner) return true;
  if (!actorRole || actorRole.missionId !== policy.missionId) return false;
  if (actorRole.kind === "master") return true;
  return policy.judgedBy === "lane-leads" && actorRole.kind === "lane-lead";
}

/**
 * Crpko's guide at cutover, from standing rule 89. The size trigger is hard;
 * the rest is judged by the master.
 */
export function crpkoRule89Guide(now: string, authoredBy: MissionActor): CriticalityGuide {
  return {
    text: [
      "Critical means a 10/10 risk change: irreversible real-fund or key movement,",
      "custody signing or broadcast, ledger settlement math, or privileged IAM, OIDC",
      "or deploy authorization. A PR whose own diff is 1,500+ changed lines",
      "(additions plus deletions) is critical too. Everything else is normal.",
    ].join(" "),
    hardTriggers: [{ _tag: "changed-lines", atLeast: 1500 }],
    version: 1,
    authoredBy,
    updatedAt: now,
  };
}
