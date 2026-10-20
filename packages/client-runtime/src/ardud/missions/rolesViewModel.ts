import type {
  CreateRoleInput,
  CriticalityTrigger,
  CriticalityVerdict,
  MissionId,
  ModelSelection,
  PullRequestKey,
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
import { modelFamily, modelLabel } from "./lanesViewModel.ts";
import type { SummaryPart } from "./portfolioViewModel.ts";
import type { MissionReviewSnapshot, MissionRolesSnapshot } from "./source.ts";
import { actorLabel, formatDayLabel, formatTimeOfDay } from "./viewModel.ts";

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
  /** "Opus", "Haiku": the model family, for a narrow column. */
  readonly family: string;
  /** The family it moves to at its next idle turn, or null. */
  readonly pendingFamily: string | null;
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
        family: modelFamily(role.modelSelection) ?? role.modelSelection.model,
        pendingFamily: modelFamily(role.pendingModelSelection),
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

// --- finish-b ---

/**
 * Kinds the owner adds by hand. The master is one per mission and lane roles
 * come with their lane; custom roles need a model picked elsewhere.
 */
export const NEW_ROLE_KINDS: ReadonlyArray<RoleKind> = [
  "sub-coordinator",
  "reviewer",
  "final-reviewer",
  "writer",
  "editor",
  "scribe",
  "verifier",
  "answerer",
];

/** A blank name keeps the kind's default name. */
export function newRoleInput(
  missionId: MissionId,
  kind: RoleKind,
  name: string,
): Result<CreateRoleInput> {
  if (!NEW_ROLE_KINDS.includes(kind)) return err("Pick a role kind.");
  const trimmed = name.trim();
  return ok(trimmed ? { missionId, kind, name: trimmed } : { missionId, kind });
}
// --- end finish-b ---

// ---------------------------------------------------------------------------
// Review policy

export interface LadderView {
  readonly ladder: ReviewLadder;
  /** "Sol review → Astra final → rule-7 merge". */
  readonly stagesLine: string;
  /** The same stages, one label each, for a flow of chips. */
  readonly stages: ReadonlyArray<string>;
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
  /** "risk-liquidation-latest#68": the repository's own name and the number. */
  readonly ref: string;
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
    stages: entry.stageIds.map((id) => stageLabel.get(id) ?? id),
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
      ref: `${verdict.pullRequest.repository.split("/").at(-1)}#${verdict.pullRequest.number}`,
      by: actorLabel(verdict.decidedBy, masterRoleId),
    })),
    reviews: snapshot.reviews.map((review) => {
      const label = stageLabel.get(review.stageId) ?? review.stageId;
      return { review, stageLabel: label, line: reviewLine(review, label) };
    }),
  };
}

export interface PullRequestReviews {
  /** The PR's current call: the newest verdict recorded for it. */
  readonly verdict: VerdictRow | null;
  /** Its review rounds, first to last, each with a chip label ("Sol review r2: 3 findings"). */
  readonly rounds: ReadonlyArray<ReviewRow & { readonly chip: string }>;
}

function roundChip(row: ReviewRow, round: number): string {
  const { review } = row;
  const outcome =
    review.verdict === "findings"
      ? `${review.findings} ${review.findings === 1 ? "finding" : "findings"}`
      : review.verdict;
  return `${row.stageLabel} r${round}: ${outcome}`;
}

/** One PR's criticality call and review rounds, for a work row that expands. */
export function pullRequestReviews(
  view: ReviewPolicyView,
  pullRequest: PullRequestKey,
): PullRequestReviews {
  const same = (key: PullRequestKey) =>
    key.repository === pullRequest.repository && key.number === pullRequest.number;
  const perStage = new Map<string, number>();
  const rounds = [...view.reviews]
    .reverse()
    .filter((row) => same(row.review.pullRequest))
    .map((row) => {
      const round = (perStage.get(row.review.stageId) ?? 0) + 1;
      perStage.set(row.review.stageId, round);
      return { ...row, chip: roundChip(row, round) };
    });
  return {
    verdict: view.verdicts.find((row) => same(row.verdict.pullRequest)) ?? null,
    rounds,
  };
}

// ---------------------------------------------------------------------------
// Desk page

/** "ardud-control:thread:9d5f1360-…" reads as "9d5f1360", "mcp:271cfc0f" as "271cfc0f". */
export function threadCode(threadId: string): string {
  const last = threadId.split(":").at(-1) ?? threadId;
  return /^[0-9a-f]{8}-/i.test(last) ? last.slice(0, 8) : last;
}

const KIND_NOUN: Record<RoleKind, readonly [string, string]> = {
  master: ["master", "masters"],
  "sub-coordinator": ["sub-coordinator", "sub-coordinators"],
  "lane-lead": ["lane lead", "lane leads"],
  "lane-worker": ["lane worker", "lane workers"],
  reviewer: ["reviewer", "reviewers"],
  "final-reviewer": ["final reviewer", "final reviewers"],
  writer: ["writer", "writers"],
  scribe: ["scribe", "scribes"],
  editor: ["editor", "editors"],
  verifier: ["verifier", "verifiers"],
  answerer: ["answerer", "answerers"],
  custom: ["custom role", "custom roles"],
};

function joinAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** "52 roles: the master, 2 custom roles and 49 lane leads. 29 on Opus, 23 on Haiku." */
export function rolesSummary(view: RoleRegistryView): SummaryPart[] {
  const kinds = new Map<RoleKind, number>();
  const families = new Map<string, number>();
  for (const row of view.rows) {
    kinds.set(row.role.kind, (kinds.get(row.role.kind) ?? 0) + 1);
    families.set(row.family, (families.get(row.family) ?? 0) + 1);
  }
  const kindParts = [...kinds]
    .sort((left, right) => ROLE_KIND_RANK[left[0]] - ROLE_KIND_RANK[right[0]])
    .map(([kind, count]) => {
      const [one, many] = KIND_NOUN[kind];
      if (kind === "master" && count === 1) return "the master";
      return `${count} ${count === 1 ? one : many}`;
    });
  const parts: SummaryPart[] = [
    { key: "roles", figure: String(view.rows.length) },
    ` ${view.rows.length === 1 ? "role" : "roles"}: ${joinAnd(kindParts)}.`,
  ];
  const mix = [...families].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  mix.forEach(([family, count], index) => {
    parts.push(index === 0 ? " " : ", ", { key: `family:${family}`, figure: String(count) });
    parts.push(` on ${family}${index === mix.length - 1 ? "." : ""}`);
  });
  return parts;
}

/** The thread column: the pending model move, the holder's code, or "No holder". */
export function roleThreadLine(row: RoleRow): string {
  if (row.pendingFamily) return `Moves to ${row.pendingFamily} at the next idle turn`;
  const holder = row.holders[0];
  return holder ? threadCode(holder.threadId) : "No holder";
}

export interface RoleHistoryRow {
  readonly key: string;
  readonly code: string;
  /** "Current, since Wed 14 Oct 21:25", "Handed off: MASTER-STATE.md is current". */
  readonly note: string;
  /** When the thread let go, in the reader's zone; null for the current holder. */
  readonly at: string | null;
}

/** Every thread that held the role, newest first, with the note each one handed on. */
export function roleHistory(row: RoleRow, timeZone?: string): RoleHistoryRow[] {
  const stamp = (at: string) => `${formatDayLabel(at, timeZone)} ${formatTimeOfDay(at, timeZone)}`;
  const bindings = [...row.holders, ...row.past].sort((left, right) =>
    right.boundAt.localeCompare(left.boundAt),
  );
  return bindings.map((binding, index) => {
    const successor = index > 0 ? bindings[index - 1] : undefined;
    const handedOn = successor?.handoffNote?.trim();
    const note =
      binding.endedAt === null
        ? `Current, since ${stamp(binding.boundAt)}`
        : handedOn
          ? `Handed off: ${handedOn}`
          : binding.reason === "initial"
            ? "First thread"
            : "Ended";
    return {
      key: binding.id,
      code: threadCode(binding.threadId),
      note,
      at: binding.endedAt === null ? null : formatDayLabel(binding.endedAt, timeZone),
    };
  });
}

export interface ReviewerRow {
  readonly stageId: string;
  readonly stage: string;
  readonly name: string;
  readonly family: string | null;
}

/** Who runs each review stage: the stage's role and the model family it runs. */
export function reviewerRows(
  policy: Pick<ReviewPolicy, "stages">,
  roles: ReadonlyArray<Role>,
): ReviewerRow[] {
  const byId = new Map(roles.map((role) => [role.id as string, role]));
  return policy.stages.map((stage) => {
    const role = byId.get(stage.roleId);
    return {
      stageId: stage.id,
      stage: stage.label,
      name: role?.name ?? "No role",
      family: role ? modelFamily(role.modelSelection) : null,
    };
  });
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
