import type {
  CriticalityTrigger,
  CriticalityVerdict,
  MissionId,
  ModelSelection,
  ReviewLadder,
  ReviewPolicy,
  ReviewRecord,
  Role,
  RoleBinding,
  RoleId,
  RoleKind,
  SetCriticalityGuideInput,
  SetRoleModelInput,
} from "@t3tools/contracts";

import { changeIndex, lastChangedLine } from "./changeLog.ts";
import { modelLabel } from "./lanesViewModel.ts";
import type { MissionReviewSnapshot, MissionRolesSnapshot } from "./source.ts";
import { actorLabel } from "./viewModel.ts";

// Roles tab, part one: the role registry (model, pending model change,
// public-text writers, who holds each role) and the review policy (stages,
// ladders, criticality guide, hard triggers, recent verdicts and rounds).

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

export const ROLE_KIND_LABEL: Record<RoleKind, string> = {
  master: "Master",
  "sub-coordinator": "Sub-coordinator",
  "lane-lead": "Lane lead",
  "lane-worker": "Lane worker",
  reviewer: "Reviewer",
  "final-reviewer": "Final reviewer",
  writer: "Writer",
  scribe: "Scribe",
  editor: "Editor",
  verifier: "Verifier",
  answerer: "Answerer",
  custom: "Custom",
};

/** Registry order: master first, reviewers, then lane leads and the rest by name. */
const ROLE_KIND_RANK: Record<RoleKind, number> = {
  master: 0,
  "sub-coordinator": 1,
  "final-reviewer": 2,
  reviewer: 3,
  writer: 4,
  editor: 5,
  scribe: 6,
  verifier: 7,
  answerer: 8,
  "lane-lead": 9,
  "lane-worker": 10,
  custom: 11,
};

export interface RoleDriftView {
  readonly threadId: string;
  readonly expected: string;
  readonly observed: string;
}

export interface RoleRow {
  readonly role: Role;
  readonly kindLabel: string;
  readonly model: string;
  /** "Switches to opus/claude-opus-5-5 xhigh on its next turn", or null. */
  readonly pendingLine: string | null;
  /** Threads holding the role now (open bindings), newest first. */
  readonly holders: ReadonlyArray<RoleBinding>;
  /** Threads that held it before, newest first. */
  readonly past: ReadonlyArray<RoleBinding>;
  readonly drift: ReadonlyArray<RoleDriftView>;
  readonly modelChangedBy: string | null;
}

export interface RoleRegistryView {
  readonly rows: ReadonlyArray<RoleRow>;
  /** Roles that write text people outside the mission read. */
  readonly publicWriters: ReadonlyArray<Role>;
  readonly pendingModelChanges: number;
  readonly driftCount: number;
  /** "23 on Haiku, 17 on Opus": models by role count, most used first. */
  readonly modelMix: string;
}

export function pendingModelLine(role: Pick<Role, "pendingModelSelection">): string | null {
  const pending = modelLabel(role.pendingModelSelection);
  return pending ? `Switches to ${pending} on its next turn` : null;
}

function shortModel(model: string): string {
  return model.split("/").at(-1) ?? model;
}

export function roleRegistryView(
  snapshot: MissionRolesSnapshot,
  masterRoleId: string | null,
): RoleRegistryView {
  const lookup = changeIndex(snapshot.changes);
  const rows = [...snapshot.roles]
    .sort(
      (left, right) =>
        ROLE_KIND_RANK[left.kind] - ROLE_KIND_RANK[right.kind] ||
        left.name.localeCompare(right.name),
    )
    .map((role): RoleRow => {
      const bindings = snapshot.bindings.filter((binding) => binding.roleId === role.id);
      const ref = { kind: "role" as const, id: role.id };
      const modelChange =
        lookup(ref, "pendingModelSelection") ?? lookup(ref, "modelSelection") ?? null;
      return {
        role,
        kindLabel: ROLE_KIND_LABEL[role.kind],
        model: modelLabel(role.modelSelection) ?? role.modelSelection.model,
        pendingLine: pendingModelLine(role),
        holders: bindings.filter((binding) => binding.endedAt === null),
        past: bindings.filter((binding) => binding.endedAt !== null),
        drift: snapshot.drift
          .filter((entry) => entry.roleId === role.id)
          .map(({ threadId, expected, observed }) => ({ threadId, expected, observed })),
        modelChangedBy: lastChangedLine(modelChange, masterRoleId),
      };
    });
  const mix = new Map<string, number>();
  for (const role of snapshot.roles) {
    const key = shortModel(role.modelSelection.model);
    mix.set(key, (mix.get(key) ?? 0) + 1);
  }
  return {
    rows,
    publicWriters: snapshot.roles.filter((role) => role.writesPublicText),
    pendingModelChanges: snapshot.roles.filter((role) => role.pendingModelSelection !== null)
      .length,
    driftCount: snapshot.drift.length,
    modelMix: [...mix]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([model, count]) => `${count} on ${model}`)
      .join(", "),
  };
}

export interface ModelChoice {
  readonly key: string;
  readonly label: string;
  readonly selection: ModelSelection;
}

/** Every model a role in the registry runs or is switching to, for the model picker. */
export function roleModelChoices(roles: ReadonlyArray<Role>): ModelChoice[] {
  const choices = new Map<string, ModelChoice>();
  for (const role of roles) {
    for (const selection of [role.modelSelection, role.pendingModelSelection]) {
      if (selection === null) continue;
      const key = JSON.stringify(selection);
      if (!choices.has(key)) {
        choices.set(key, { key, label: modelLabel(selection) ?? selection.model, selection });
      }
    }
  }
  return [...choices.values()].sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * A model change applies on the role's next turn. Picking the model it already
 * runs cancels a pending change. A reason is required either way; it goes in
 * the timeline.
 */
export function setRoleModelInput(
  role: Pick<Role, "id" | "modelSelection" | "pendingModelSelection">,
  modelSelection: ModelSelection,
  reason: string,
): Result<SetRoleModelInput> {
  const trimmed = reason.trim();
  if (!trimmed) return err("Say why the model changes.");
  const same = (left: ModelSelection | null) =>
    left !== null && JSON.stringify(left) === JSON.stringify(modelSelection);
  if (same(role.pendingModelSelection)) return err("That change is already pending.");
  if (same(role.modelSelection) && role.pendingModelSelection === null) {
    return err("The role already runs that model.");
  }
  return ok({ roleId: role.id as RoleId, modelSelection, reason: trimmed });
}

// ---------------------------------------------------------------------------
// Review policy

export interface LadderView {
  readonly ladder: ReviewLadder;
  /** "Sol review → Astra final → rule-7 merge". */
  readonly stagesLine: string;
  readonly appliesLine: string;
}

export interface ReviewPolicyView {
  readonly policy: ReviewPolicy;
  readonly normal: ReadonlyArray<LadderView>;
  readonly critical: ReadonlyArray<LadderView>;
  readonly custom: ReadonlyArray<LadderView>;
  readonly triggers: ReadonlyArray<string>;
  /** "Guide v2 by master, 14 Oct": who wrote the current guide. */
  readonly guideBy: string;
  readonly judgedBy: string;
  readonly changedBy: string | null;
  readonly verdicts: ReadonlyArray<VerdictRow>;
  readonly reviews: ReadonlyArray<ReviewRow>;
}

export interface VerdictRow {
  readonly verdict: CriticalityVerdict;
  /** "risk-liquidation-latest#68 critical (hard trigger)". */
  readonly line: string;
  readonly by: string;
}

export interface ReviewRow {
  readonly review: ReviewRecord;
  readonly stageLabel: string;
  /** "Sol at 61025638: 19 findings (2 severe)". */
  readonly line: string;
}

export function triggerLabel(trigger: CriticalityTrigger): string {
  switch (trigger._tag) {
    case "changed-lines":
      return `${trigger.atLeast}+ changed lines`;
    case "path":
      return `touches ${trigger.pattern}`;
    case "label":
      return `labelled ${trigger.label}`;
  }
}

const VERDICT_SOURCE_LABEL: Record<CriticalityVerdict["source"], string> = {
  guide: "by the guide",
  "hard-trigger": "hard trigger",
  reclassified: "reclassified",
  owner: "your call",
};

export function verdictLine(verdict: CriticalityVerdict): string {
  const pr = `${verdict.pullRequest.repository}#${verdict.pullRequest.number}`;
  return `${pr} ${verdict.critical ? "critical" : "normal"} (${VERDICT_SOURCE_LABEL[verdict.source]})`;
}

export function reviewLine(review: ReviewRecord, stageLabel: string): string {
  const head = review.headSha.slice(0, 8);
  if (review.verdict === "clear") return `${stageLabel} at ${head}: clear`;
  if (review.verdict === "blocked") return `${stageLabel} at ${head}: blocked`;
  const severe = review.severeFindings > 0 ? ` (${review.severeFindings} severe)` : "";
  return `${stageLabel} at ${head}: ${review.findings} ${review.findings === 1 ? "finding" : "findings"}${severe}`;
}

export function reviewPolicyView(
  snapshot: MissionReviewSnapshot,
  masterRoleId: string | null,
): ReviewPolicyView {
  const { policy } = snapshot;
  const stageLabel = new Map(policy.stages.map((stage) => [stage.id as string, stage.label]));
  const ladder = (entry: ReviewLadder): LadderView => ({
    ladder: entry,
    stagesLine: entry.stageIds.map((id) => stageLabel.get(id) ?? id).join(" → "),
    appliesLine:
      entry.condition?.trim() ||
      (entry.appliesTo === "critical"
        ? "Critical PRs"
        : entry.appliesTo === "normal"
          ? "Every other PR"
          : ""),
  });
  const lookup = changeIndex(snapshot.changes);
  const ref = { kind: "review-policy" as const, id: policy.missionId };
  const latest = ["guide", "stages", "ladders", "commonRules", "judgedBy"]
    .map((field) => lookup(ref, field))
    .filter((change) => change !== null)
    .sort((left, right) => right.at.localeCompare(left.at))[0];
  return {
    policy,
    normal: policy.ladders.filter((entry) => entry.appliesTo === "normal").map(ladder),
    critical: policy.ladders.filter((entry) => entry.appliesTo === "critical").map(ladder),
    custom: policy.ladders.filter((entry) => entry.appliesTo === "custom").map(ladder),
    triggers: policy.guide.hardTriggers.map(triggerLabel),
    guideBy: `Guide v${policy.guide.version} by ${actorLabel(policy.guide.authoredBy, masterRoleId)}`,
    judgedBy:
      policy.judgedBy === "master" ? "The master calls criticality" : "Lane leads call criticality",
    changedBy: lastChangedLine(latest ?? null, masterRoleId),
    verdicts: snapshot.verdicts.map((verdict) => ({
      verdict,
      line: verdictLine(verdict),
      by: actorLabel(verdict.decidedBy, masterRoleId),
    })),
    reviews: snapshot.reviews.map((review) => {
      const label = stageLabel.get(review.stageId) ?? review.stageId;
      return { review, stageLabel: label, line: reviewLine(review, label) };
    }),
  };
}

export function setCriticalityGuideInput(
  missionId: MissionId,
  text: string,
  hardTriggers?: ReadonlyArray<CriticalityTrigger>,
): Result<SetCriticalityGuideInput> {
  const trimmed = text.trim();
  if (!trimmed) return err("Write what counts as critical.");
  return ok(
    hardTriggers ? { missionId, text: trimmed, hardTriggers } : { missionId, text: trimmed },
  );
}
