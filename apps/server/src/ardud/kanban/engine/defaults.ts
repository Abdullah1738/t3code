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
