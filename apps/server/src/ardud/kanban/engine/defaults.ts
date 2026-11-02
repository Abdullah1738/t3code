import {
  type KanbanReviewChain,
  type ModelSelection,
  type ProviderOptionSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  effortOptionId,
  mergeSelection,
  resolveSelection,
} from "@t3tools/client-runtime/ardud/models/harnessRouting";

const opencode = ProviderInstanceId.make("opencode");

const model = (id: string, variant: string): ModelSelection => ({
  instanceId: opencode,
  model: id,
  options: [{ id: "variant", value: variant }],
});

export interface ModelInput {
  readonly model: string;
  readonly instanceId?: string | undefined;
  readonly provider?: string | undefined;
  readonly effort?: string | undefined;
  readonly variant?: string | undefined;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
}

type InputResult =
  | { readonly kind: "selection"; readonly selection: ModelSelection }
  | { readonly kind: "conflict"; readonly reason: string };

/** Build a new selection without inheriting options from another model. */
export const modelSelectionResult = (input: ModelInput, apply = false): InputResult => {
  if (input.effort !== undefined && input.variant !== undefined && input.effort !== input.variant) {
    return { kind: "conflict", reason: "effort and variant name different levels" };
  }
  const instance = input.instanceId ?? input.provider;
  const instanceId = instance ? ProviderInstanceId.make(instance) : opencode;
  const ids = new Set<string>();
  for (const option of input.options ?? []) {
    if (ids.has(option.id)) {
      return { kind: "conflict", reason: `Option ${option.id} was specified more than once` };
    }
    ids.add(option.id);
    if (
      apply &&
      ["variant", "effort", "reasoningEffort"].includes(option.id) &&
      option.id !== "variant" &&
      option.id !== effortOptionId(instanceId)
    ) {
      return { kind: "conflict", reason: `Option ${option.id} is not an effort option for ${instanceId}` };
    }
  }
  // mergeSelection folds mapped #suffixes. With the flag off they must remain literal,
  // including when an old client supplies a separate variant.
  const model = apply ? input.model : "__kanban_input__";
  const merged = mergeSelection(
    { instanceId, model: "__kanban_base__" },
    {
      model,
      ...(input.options === undefined ? {} : { options: input.options }),
      ...((input.effort ?? input.variant) === undefined
        ? {}
        : { variant: input.effort ?? input.variant }),
    },
  );
  if (merged.kind === "conflict") return merged;
  const selection = apply ? merged.selection : { ...merged.selection, model: input.model };
  if (!apply) return { kind: "selection", selection };
  const resolved = resolveSelection(selection);
  return resolved.kind === "conflict"
    ? resolved
    : { kind: "selection", selection: resolved.selection };
};

/** A model picked by id, as agents and scripts name it. */
export const modelSelectionOf = (input: ModelInput, apply = false): ModelSelection => {
  const result = modelSelectionResult(input, apply);
  if (result.kind === "conflict") throw new Error(result.reason);
  return result.selection;
};

/** Titles, descriptions, goal stories and similar-card groups. */
export const DEFAULT_MANAGER_MODEL = model("opus/cc/claude-haiku-5-5", "xhigh");
export const DEFAULT_EVALUATOR_MODEL = model("opus/claude-opus-5-5", "high");
export const DEFAULT_CARD_MODEL = model("opus/claude-opus-5-5", "high");

/**
 * What the setup evaluator is told when the owner leaves notes empty. It proposes
 * instructions for approval and keeps pools at 0 until the owner says start.
 */
export const DEFAULT_SETUP_TEXT = [
  "Set this board up for the project. Read the project first (its README, layout, and the scripts it already has).",
  "Propose the board instructions (model routing, reviewer routing, escalation), the review chains, and any scripts it needs.",
  "Bring the proposal to the owner in this Setup discussion and wait for approval before you apply instructions or scripts.",
  "Then make the first cards. Keep every pool at 0 until the owner says start.",
].join(" ");

/** New boards start empty: no routing text, no review chains, no pools beyond the models they pick. */
export const DEFAULT_INSTRUCTIONS = {
  modelRouting: "",
  reviewerRouting: "",
  escalation: "",
};
