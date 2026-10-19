import type { MissionActor, WorkItem, WorkStage } from "@t3tools/contracts";

import { actorKey, actorLabel, refLabel } from "./viewModel.ts";

// Work tab: every work item on the pipeline from ticket to exercised, the
// blocked ones with who holds the ball, and the dependency edges between them.

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

export interface WorkStageColumn {
  readonly stage: WorkStage;
  readonly label: string;
  /** Most recently updated first. */
  readonly items: ReadonlyArray<WorkItem>;
}

/** One column per stage, empty ones kept so the pipeline reads the same every time. */
export function workPipeline(items: ReadonlyArray<WorkItem>): WorkStageColumn[] {
  return WORK_STAGES.map((stage) => ({
    stage,
    label: WORK_STAGE_LABEL[stage],
    items: items
      .filter((item) => item.stage === stage)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  }));
}

/** An item is blocked when something named blocks it or a dependency hasn't reached its stage yet. */
export function isBlocked(item: WorkItem, byId: ReadonlyMap<string, WorkItem>): boolean {
  if (item.stage === "done") return false;
  if (item.blockedBy.length > 0) return true;
  return openDependencies(item, byId).length > 0;
}

/** Dependencies not done (or past the dependent's own stage). Unknown ids count as open. */
export function openDependencies(item: WorkItem, byId: ReadonlyMap<string, WorkItem>): string[] {
  const rank = WORK_STAGES.indexOf(item.stage);
  return item.dependsOn.filter((id) => {
    const dependency = byId.get(id);
    if (!dependency) return true;
    if (dependency.stage === "done" || dependency.stage === "exercised") return false;
    return WORK_STAGES.indexOf(dependency.stage) <= rank;
  });
}

export interface BlockedWork {
  readonly item: WorkItem;
  /** "master", "you", "cell-risk", "Dylan"; null when nobody holds it. */
  readonly ballWith: string | null;
  readonly ballWithActor: MissionActor | null;
  /** "Waiting on risk68-final, codex reviews". */
  readonly waitingOn: string;
}

export interface BlockedGroup {
  readonly holder: string;
  readonly holderActor: MissionActor | null;
  readonly items: ReadonlyArray<BlockedWork>;
}

/**
 * Blocked items grouped by who holds the ball, the owner's group first and
 * then the biggest groups. The ball is with the item's holder.
 */
export function blockedWork(
  items: ReadonlyArray<WorkItem>,
  masterRoleId: string | null,
): BlockedGroup[] {
  const byId = new Map(items.map((item) => [item.id as string, item]));
  const groups = new Map<
    string,
    { holder: string; holderActor: MissionActor | null; items: BlockedWork[] }
  >();
  for (const item of items) {
    if (!isBlocked(item, byId)) continue;
    const waiting = [
      ...item.blockedBy.map((ref) => refLabel(ref)),
      ...openDependencies(item, byId).map((id) => byId.get(id)?.title ?? id),
    ];
    const holder = item.heldBy ? actorLabel(item.heldBy, masterRoleId) : null;
    const entry: BlockedWork = {
      item,
      ballWith: holder,
      ballWithActor: item.heldBy,
      waitingOn: `Waiting on ${waiting.join(", ")}`,
    };
    const key = item.heldBy ? actorKey(item.heldBy) : "nobody";
    const group = groups.get(key);
    if (group) group.items.push(entry);
    else groups.set(key, { holder: holder ?? "nobody", holderActor: item.heldBy, items: [entry] });
  }
  return [...groups.values()].sort((left, right) => {
    const owner =
      Number(right.holderActor?._tag === "owner") - Number(left.holderActor?._tag === "owner");
    if (owner !== 0) return owner;
    return right.items.length - left.items.length || left.holder.localeCompare(right.holder);
  });
}

export interface WorkEdge {
  readonly from: string;
  readonly to: string;
  /** False when `from` is done or past `to`'s stage. */
  readonly open: boolean;
}

/** `from` must land before `to`. Edges to unknown items are kept, marked open. */
export function workEdges(items: ReadonlyArray<WorkItem>): WorkEdge[] {
  const byId = new Map(items.map((item) => [item.id as string, item]));
  return items.flatMap((item) => {
    const open = new Set(openDependencies(item, byId));
    return item.dependsOn.map((id) => ({ from: id, to: item.id, open: open.has(id) }));
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

/** "merged 79887b3a · deployed · exercised", from the item's recorded facts. */
export function workFactsLine(item: WorkItem): string | null {
  const parts = workFacts(item);
  return parts.length === 0 ? null : parts.join(" · ");
}
