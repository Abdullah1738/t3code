/**
 * Model selections the role registry hands out, plus the string key used to
 * compare what a thread ran with what its role says. Robob routes every
 * model through the shared OpenCode instance.
 */
import { type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue, modelSelectionsEqual } from "@t3tools/shared/model";

const OPENCODE = ProviderInstanceId.make("opencode");

function opencode(model: string, variant?: string): ModelSelection {
  return {
    instanceId: OPENCODE,
    model,
    ...(variant ? { options: [{ id: "variant", value: variant }] } : {}),
  } as ModelSelection;
}

export const OPUS_XHIGH = opencode("opus/claude-opus-5-5", "xhigh");
export const HAIKU = opencode("opus/cc/claude-haiku-5-5");
/** Crpko rule 90: the writer that turns reviewer findings into public text. */
export const HAIKU_XHIGH = opencode("opus/cc/claude-haiku-5-5", "xhigh");
export const SOL_XHIGH = opencode("opus/cx/gpt-6.1-sol", "xhigh");
export const ASTRA_XHIGH = opencode("opus/gpt-6-astra", "xhigh");

export function variantOf(selection: ModelSelection): string | undefined {
  return getModelSelectionStringOptionValue(selection, "variant");
}

/** `instance:model@variant`, the shape `RoleBinding.observedModel` stores. */
export function modelKey(selection: ModelSelection): string {
  const variant = variantOf(selection);
  return `${selection.instanceId}:${selection.model}${variant ? `@${variant}` : ""}`;
}

export const sameModel = modelSelectionsEqual;
