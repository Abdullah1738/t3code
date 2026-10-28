import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { modelProblem } from "./modelCheck.ts";
import { opencodeTestProvider } from "./testProviders.ts";

const sel = (model: string, variant?: string) =>
  ModelSelection.make({
    instanceId: ProviderInstanceId.make("opencode"),
    model,
    ...(variant === undefined ? {} : { options: [{ id: "variant", value: variant }] }),
  });

describe("modelProblem", () => {
  const providers = [opencodeTestProvider()];

  it("does not block when the provider is unknown", () => {
    expect(
      modelProblem(
        [],
        ModelSelection.make({ instanceId: ProviderInstanceId.make("nope"), model: "x" }),
      ),
    ).toBeNull();
  });

  it("refuses a model the provider does not offer", () => {
    expect(modelProblem(providers, sel("opus/unknown-model"))).toBe(
      "Model opus/unknown-model is not offered by opencode.",
    );
  });

  it("names the offered variant when astra gets high", () => {
    const problem = modelProblem(providers, sel("opus/gpt-6-astra", "high"));
    expect(problem).toContain('no "high" variant');
    expect(problem).toContain("it offers: xhigh");
  });

  it("accepts the offered variant", () => {
    expect(modelProblem(providers, sel("opus/gpt-6-astra", "xhigh"))).toBeNull();
  });

  it("skips descriptor checks when the model has no descriptors", () => {
    const bare = [
      {
        ...opencodeTestProvider(),
        models: [{ slug: "opus/gpt-6-astra", name: "x", isCustom: false, capabilities: null }],
      },
    ];
    expect(modelProblem(bare, sel("opus/gpt-6-astra", "high"))).toBeNull();
  });
});
