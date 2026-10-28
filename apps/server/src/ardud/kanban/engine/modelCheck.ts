import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProvider,
} from "@t3tools/contracts";

/**
 * Mirrors OrchestratorMcpService's option and model checks: a board must never
 * start a thread on a model or variant the provider doesn't offer. Unknown
 * providers and providers without a model list are not blocked (catalog not
 * loaded yet).
 */
export function modelProblem(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): string | null {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider === undefined || provider.models.length === 0) return null;
  const instanceId: string = selection.instanceId;
  const entry = provider.models.find((candidate) => candidate.slug === selection.model);
  if (entry === undefined) {
    return `Model ${selection.model} is not offered by ${instanceId}.`;
  }
  const descriptors = entry.capabilities?.optionDescriptors;
  const options = selection.options ?? [];
  const problems = invalidOptions(options, descriptors);
  if (problems.length === 0) return null;
  return `${selection.model} ${problems.join(" ")}`;
}

function invalidOptions(
  options: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.id)) {
      problems.push(`Option ${option.id} was specified more than once.`);
      continue;
    }
    seen.add(option.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${option.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean") {
      if (typeof option.value !== "boolean") {
        problems.push(`Option ${option.id} expects a boolean value.`);
      }
      continue;
    }
    const choices = descriptor.options.map((choice) => choice.id);
    if (!choices.includes(String(option.value))) {
      const offered = choices.join(", ");
      problems.push(
        `has no "${String(option.value)}" ${option.id === "variant" ? "variant" : `${option.id} value`}; it offers: ${offered || "none"}.`,
      );
    }
  }
  return problems;
}
