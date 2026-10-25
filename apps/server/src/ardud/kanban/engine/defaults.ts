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

export const DEFAULT_REVIEW_CHAINS: ReadonlyArray<KanbanReviewChain> = [
  { name: "Standard", steps: [model("opus/claude-opus-5-5", "xhigh")] },
  {
    name: "Critical",
    steps: [model("opus/cx/gpt-6.1-sol", "high"), model("opus/gpt-6-astra", "high")],
  },
];
export const DEFAULT_REVIEW_CHAIN = "Standard";

/** Pools key on provider/model, so one pool covers every variant of a model. */
export const DEFAULT_POOLS: ReadonlyArray<{
  readonly model: ModelSelection;
  readonly slots: number;
}> = [
  { model: DEFAULT_CARD_MODEL, slots: 3 },
  { model: model("opus/cc/claude-haiku-5-5", "xhigh"), slots: 2 },
  { model: model("opus/cx/gpt-6.1-sol", "high"), slots: 1 },
  { model: model("opus/gpt-6-astra", "high"), slots: 1 },
];

export const DEFAULT_INSTRUCTIONS = {
  modelRouting:
    "Most cards run on Opus 5.5. Small, well-specified edits can run on Haiku 5.5. Work that needs app internals or deep debugging runs on GPT-6 Astra.",
  reviewerRouting:
    "Critical cards are anything touching money, balances, risk, auth or production data. They use the Critical chain. Everything else uses Standard.",
  escalation:
    "Ask the owner before anything outward (messages to people, Linear, GitHub comments), anything that spends money, deploys to production, or deletes data. Everything else you decide.",
};
