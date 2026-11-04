import type { ModelSelection } from "@t3tools/contracts";

import { planSelection, sameValue, type SelectionPlan } from "./selectionPlan.ts";

/** One task's stored provider-block fallbacks, read from the block-retry table. */
export interface FallbackSnapshot {
  readonly taskId: string;
  readonly fallbacks: ReadonlyArray<ModelSelection>;
}

export interface FallbackConflict {
  readonly taskId: string;
  readonly index: number;
  readonly reason: string;
}

/** The planned fallback list for one task. Nothing is written until the owner applies it. */
export interface FallbackPlan {
  readonly taskId: string;
  readonly changed: boolean;
  readonly before: ReadonlyArray<ModelSelection>;
  /** The list as it will be written: mapped entries replaced, others kept in order. */
  readonly after: ReadonlyArray<ModelSelection>;
  readonly conflicts: ReadonlyArray<FallbackConflict>;
}

/**
 * Plans one task's fallback list. Each entry goes through the shared resolver, in order. A mapped
 * entry is replaced; an unmapped one stays. Duplicates are removed after mapping, keeping the first
 * occurrence, so the mapping never leaves the same model in the list twice. A conflict leaves the
 * whole list as it was: a partly-mapped list would silently change which fallback runs first.
 */
export const planFallbacks = (snapshot: FallbackSnapshot): FallbackPlan => {
  const conflicts: Array<FallbackConflict> = [];
  const mapped: Array<ModelSelection> = [];
  snapshot.fallbacks.forEach((selection, index) => {
    const plan: SelectionPlan = planSelection(selection);
    if (plan._tag === "conflict") {
      conflicts.push({ taskId: snapshot.taskId, index, reason: plan.reason });
      mapped.push(selection);
      return;
    }
    mapped.push(plan._tag === "mapped" ? plan.next : selection);
  });

  if (conflicts.length > 0) {
    return {
      taskId: snapshot.taskId,
      changed: false,
      before: snapshot.fallbacks,
      after: snapshot.fallbacks,
      conflicts,
    };
  }

  const seen: Array<ModelSelection> = [];
  for (const selection of mapped) {
    if (!seen.some((existing) => sameValue(existing, selection))) seen.push(selection);
  }
  const changed = !sameValue(seen, snapshot.fallbacks);
  return {
    taskId: snapshot.taskId,
    changed,
    before: snapshot.fallbacks,
    after: changed ? seen : snapshot.fallbacks,
    conflicts: [],
  };
};
