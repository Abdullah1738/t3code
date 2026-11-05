import type { ModelSelection } from "@t3tools/contracts";
import { resolveSelection } from "@t3tools/client-runtime/ardud/models/harnessRouting";

/**
 * What a stored selection becomes, decided once per value and shared by every scope.
 * `same` means the value needs no write; `conflict` is never guessed through.
 */
export type SelectionPlan =
  | { readonly _tag: "same" }
  | { readonly _tag: "mapped"; readonly next: ModelSelection; readonly from: string }
  | { readonly _tag: "conflict"; readonly reason: string };

/**
 * Structural equality for planned values: plain data only (selections, cards, pools, links), so a
 * key-by-key walk is exact. Key order never counts as a change.
 */
export const sameValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameValue(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameValue(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    );
  }
  return false;
};

const sameSelection = (left: ModelSelection, right: ModelSelection) => sameValue(left, right);

/**
 * Routes one stored selection through the shared resolver. A mapped value is always
 * the resolver's own output; an unmapped OpenCode model (GLM, Kimi, title model) comes
 * back `unchanged` and stays exactly as it is.
 */
export const planSelection = (selection: ModelSelection): SelectionPlan => {
  const resolved = resolveSelection(selection);
  switch (resolved.kind) {
    case "unchanged":
      return { _tag: "same" };
    case "conflict":
      return { _tag: "conflict", reason: resolved.reason };
    case "mapped":
      return sameSelection(resolved.selection, selection)
        ? { _tag: "same" }
        : {
            _tag: "mapped",
            next: resolved.selection,
            from: `${resolved.from.instanceId}/${resolved.from.model}`,
          };
  }
};
