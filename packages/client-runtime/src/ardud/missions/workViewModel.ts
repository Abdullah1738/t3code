import {
  WORK_ITEM_REVIEW_BUDGET,
  type MissionActor,
  type WorkItem,
  type WorkStage,
} from "@t3tools/contracts";

import { actorLabel, refLabel } from "./viewModel.ts";

// Work tab: open work by who holds it and what blocks it, the stage counts,
// dependency chains and the deferred register.

export const WORK_STAGES: ReadonlyArray<WorkStage> = [
  "ticket",
  "pr",
  "review",
  "merge",
  "deploy",
  "readback",
  "exercised",
  "done",
];

export const WORK_STAGE_LABEL: Record<WorkStage, string> = {
  ticket: "Ticket",
  pr: "PR",
  review: "Review",
  merge: "Merge",
  deploy: "Deploy",
  readback: "Readback",
  exercised: "Exercised",
  done: "Done",
};

/** An item is blocked when something named blocks it or a dependency hasn't reached its stage yet. */
export function isBlocked(
  item: WorkItem,
  byId: ReadonlyMap<string, WorkItem>,
  unknownOpen = true,
): boolean {
  if (item.stage === "done") return false;
  if (item.blockedBy.length > 0) return true;
  return openDependencies(item, byId, unknownOpen).length > 0;
}

/**
 * Dependencies not done (or past the dependent's own stage). Unknown ids count
 * as open, unless `byId` holds every open item (then a missing one is done).
 */
export function openDependencies(
  item: WorkItem,
  byId: ReadonlyMap<string, WorkItem>,
  unknownOpen = true,
): string[] {
  const rank = WORK_STAGES.indexOf(item.stage);
  return item.dependsOn.filter((id) => {
    const dependency = byId.get(id);
    if (!dependency) return unknownOpen;
    if (dependency.stage === "done" || dependency.stage === "exercised") return false;
    return WORK_STAGES.indexOf(dependency.stage) <= rank;
  });
}

/** Items nothing depends on yet that have open dependencies: the far end of each chain. */
export function chainHeads(items: ReadonlyArray<WorkItem>): WorkItem[] {
  const dependedOn = new Set(items.flatMap((item) => item.dependsOn));
  return items.filter((item) => !dependedOn.has(item.id) && item.dependsOn.length > 0);
}

/** The item's recorded facts, one element each: "merged 79887b3a", "deployed: ...". */
export function workFacts(item: WorkItem): string[] {
  return [
    item.facts.mergedAtHead ? `merged ${item.facts.mergedAtHead}` : null,
    item.facts.deployedReadback ? `deployed: ${item.facts.deployedReadback}` : null,
    item.facts.exercised ? `exercised: ${item.facts.exercised}` : null,
  ].filter((part): part is string => part !== null);
}

export interface ReviewRoundsView {
  /** "2 rounds", "5 rounds". */
  readonly label: string;
  /** "Round 3 clear", "Round 5: 2 findings, 1 P0/P1". */
  readonly detail: string;
  /** Past the review budget: the master was told. */
  readonly over: boolean;
}

/** The review rounds a lane recorded on an item, or null before the first. */
export function reviewRoundsView(item: WorkItem): ReviewRoundsView | null {
  const rounds = item.reviewRounds ?? [];
  const last = rounds.at(-1);
  if (last === undefined) return null;
  const findings = `${last.findings} finding${last.findings === 1 ? "" : "s"}`;
  return {
    label: `${rounds.length} round${rounds.length === 1 ? "" : "s"}`,
    detail:
      last.verdict === "clear"
        ? `Round ${last.round} clear`
        : `Round ${last.round}: ${findings}${last.severe > 0 ? `, ${last.severe} P0/P1` : ""}`,
    over: rounds.length > WORK_ITEM_REVIEW_BUDGET,
  };
}

// --- Desk board ---

/** Every stage but done: the open work feed asks for these. */
export const OPEN_WORK_STAGES: ReadonlyArray<WorkStage> = WORK_STAGES.filter(
  (stage) => stage !== "done",
);

export interface WorkHolder {
  readonly kind: "you" | "master" | "person";
  /** "You", "Master", "cell-risk", "Dylan". */
  readonly name: string;
}

export interface WorkRow {
  readonly item: WorkItem;
  /** risk: with you; bad: blocked; ok: moving. */
  readonly glyph: "risk" | "bad" | "ok";
  readonly stageLabel: string;
  readonly holder: WorkHolder | null;
  /** "Waiting on risk#68 final" when blocked, else the first recorded fact. */
  readonly reason: string | null;
}

export interface WorkStageGroup {
  readonly stage: WorkStage;
  readonly label: string;
  readonly rows: ReadonlyArray<WorkRow>;
}

export interface WorkChain {
  /** The chain's last item. */
  readonly id: string;
  /** The sub-mission it belongs to, when known. */
  readonly name: string | null;
  /** First step first; every step is still open. */
  readonly steps: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}

export interface DeferredRow {
  readonly item: WorkItem;
  readonly registerId: string;
  readonly what: string;
  readonly trigger: string | null;
  readonly fired: boolean;
}

export interface WorkBoard {
  /** Open items per stage, ticket to exercised, deferred register entries left out. */
  readonly stages: ReadonlyArray<{
    readonly stage: WorkStage;
    readonly label: string;
    readonly count: number;
  }>;
  readonly open: number;
  /** Held by the owner, oldest first. */
  readonly withYou: ReadonlyArray<WorkRow>;
  /** Blocked and held by someone else, oldest first. */
  readonly blocked: ReadonlyArray<WorkRow>;
  /** Everything else, latest first. */
  readonly moving: ReadonlyArray<WorkRow>;
  /** The same rows by stage, empty stages left out. */
  readonly byStage: ReadonlyArray<WorkStageGroup>;
  readonly chains: ReadonlyArray<WorkChain>;
  /** Open deferred register entries, fired ones first. */
  readonly register: ReadonlyArray<DeferredRow>;
}

function holderOf(actor: MissionActor | null, masterRoleId: string | null): WorkHolder | null {
  if (!actor) return null;
  if (actor._tag === "owner") return { kind: "you", name: "You" };
  if (actor._tag === "role" && actor.roleId === masterRoleId) {
    return { kind: "master", name: "Master" };
  }
  return { kind: "person", name: actorLabel(actor, masterRoleId) };
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const oldestFirst = (left: WorkRow, right: WorkRow) =>
  left.item.updatedAt.localeCompare(right.item.updatedAt);
const latestFirst = (left: WorkRow, right: WorkRow) =>
  right.item.updatedAt.localeCompare(left.item.updatedAt);

/**
 * The Work page from the open work feed (every stage but done, complete), so a
 * dependency missing from it has finished. Register entries the server keeps
 * as work items go to their own list.
 */
export function workBoard(
  openItems: ReadonlyArray<WorkItem>,
  masterRoleId: string | null,
  subMissionTitles: ReadonlyMap<string, string> = new Map(),
): WorkBoard {
  const register: DeferredRow[] = [];
  const items: WorkItem[] = [];
  for (const item of openItems) {
    if (item.stage === "done") continue;
    const deferral = item.deferral;
    if (deferral && (deferral.status === "deferred" || deferral.status === "fired")) {
      register.push({
        item,
        registerId: deferral.registerId,
        what: deferral.what.split("\n")[0]?.trim() || item.title,
        trigger: deferral.trigger.trim() || null,
        fired: deferral.status === "fired",
      });
    } else {
      items.push(item);
    }
  }
  const byId = new Map(items.map((item) => [item.id as string, item]));

  const withYou: WorkRow[] = [];
  const blocked: WorkRow[] = [];
  const moving: WorkRow[] = [];
  for (const item of items) {
    const isStuck = isBlocked(item, byId, false);
    const waiting = isStuck
      ? [
          ...item.blockedBy.map((ref) => refLabel(ref)),
          ...openDependencies(item, byId, false).map((id) => byId.get(id)?.title ?? id),
        ]
      : [];
    const mine = item.heldBy?._tag === "owner";
    const row: WorkRow = {
      item,
      glyph: mine ? "risk" : isStuck ? "bad" : "ok",
      stageLabel: WORK_STAGE_LABEL[item.stage],
      holder: holderOf(item.heldBy, masterRoleId),
      reason:
        waiting.length > 0
          ? `Waiting on ${waiting.join(", ")}`
          : (workFacts(item).map(capitalised)[0] ?? null),
    };
    (mine ? withYou : isStuck ? blocked : moving).push(row);
  }
  withYou.sort(oldestFirst);
  blocked.sort(oldestFirst);
  moving.sort(latestFirst);

  const rows = [...withYou, ...blocked, ...moving];
  const byStage = OPEN_WORK_STAGES.map((stage) => ({
    stage,
    label: WORK_STAGE_LABEL[stage],
    rows: rows.filter((row) => row.item.stage === stage).sort(latestFirst),
  })).filter((group) => group.rows.length > 0);

  const chains = chainHeads(items).flatMap((head): WorkChain[] => {
    const steps: WorkItem[] = [];
    const seen = new Set<string>();
    const visit = (item: WorkItem) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      for (const id of item.dependsOn) {
        const dependency = byId.get(id);
        if (dependency) visit(dependency);
      }
      steps.push(item);
    };
    visit(head);
    if (steps.length < 2) return [];
    return [
      {
        id: head.id,
        name: head.subMissionId ? (subMissionTitles.get(head.subMissionId) ?? null) : null,
        steps: steps.map((step) => ({ id: step.id, title: step.title })),
      },
    ];
  });

  register.sort((left, right) => Number(right.fired) - Number(left.fired));

  return {
    stages: OPEN_WORK_STAGES.map((stage) => ({
      stage,
      label: WORK_STAGE_LABEL[stage],
      count: items.filter((item) => item.stage === stage).length,
    })),
    open: items.length,
    withYou,
    blocked,
    moving,
    byStage,
    chains,
    register,
  };
}

/** "merged 79887b3a · deployed · exercised", from the item's recorded facts. */
export function workFactsLine(item: WorkItem): string | null {
  const parts = workFacts(item);
  return parts.length === 0 ? null : parts.join(" · ");
}
