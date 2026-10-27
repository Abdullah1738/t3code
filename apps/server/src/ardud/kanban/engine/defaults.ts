import {
  type KanbanReviewChain,
  type ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";

const opencode = ProviderInstanceId.make("opencode");

const model = (id: string, variant: string): ModelSelection => ({
  instanceId: opencode,
  model: id,
  options: [{ id: "variant", value: variant }],
});

/** A model picked by id, as agents and scripts name it. */
export const modelSelectionOf = (input: {
  readonly model: string;
  readonly instanceId?: string | undefined;
  readonly variant?: string | undefined;
}): ModelSelection => ({
  instanceId: input.instanceId ? ProviderInstanceId.make(input.instanceId) : opencode,
  model: input.model,
  ...(input.variant ? { options: [{ id: "variant", value: input.variant }] } : {}),
});

/** Titles, descriptions, goal stories and similar-card groups. */
export const DEFAULT_MANAGER_MODEL = model("opus/cc/claude-haiku-5-5", "xhigh");
export const DEFAULT_EVALUATOR_MODEL = model("opus/claude-opus-5-5", "xhigh");
export const DEFAULT_CARD_MODEL = model("opus/claude-opus-5-5", "high");

/** New boards start empty: no routing text, no review chains, no pools beyond the models they pick. */
export const DEFAULT_INSTRUCTIONS = {
  modelRouting: "",
  reviewerRouting: "",
  escalation: "",
};
