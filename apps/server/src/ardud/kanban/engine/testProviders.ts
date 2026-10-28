import {
  type ProviderOptionDescriptor,
  type ServerProvider,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

const ALL_VARIANTS = ["low", "medium", "high", "xhigh", "max"] as const;

const variantDescriptor = (values: ReadonlyArray<string>): ProviderOptionDescriptor => ({
  id: "variant",
  label: "Variant",
  type: "select",
  options: values.map((value) => ({ id: value, label: value })),
});

/** The opencode catalog as it looked on 27 Oct: GPT-6 models offer only xhigh. */
export const opencodeTestProvider = (): ServerProvider => {
  const models = [
    { slug: "opus/claude-opus-5-5", variants: ALL_VARIANTS },
    { slug: "opus/cc/claude-haiku-5-5", variants: ALL_VARIANTS },
    { slug: "opus/cx/gpt-6.1-sol", variants: ["xhigh"] },
    { slug: "opus/gpt-6-astra", variants: ["xhigh"] },
  ];
  return {
    instanceId: ProviderInstanceId.make("opencode"),
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-27T00:00:00.000Z",
    models: models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      capabilities: { optionDescriptors: [variantDescriptor(model.variants)] },
    })),
    slashCommands: [],
    skills: [],
  } as ServerProvider;
};
