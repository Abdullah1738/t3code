import { assert, it } from "@effect/vitest";
import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

import { modelProblem } from "./modelCheck.ts";
import { opencodeTestProvider } from "./testProviders.ts";

const sel = (model: string, variant?: string) =>
  ModelSelection.make({
    instanceId: ProviderInstanceId.make("opencode"),
    model,
    ...(variant === undefined ? {} : { options: [{ id: "variant", value: variant }] }),
  });

const providers = [opencodeTestProvider()];

it("does not block when the provider is unknown", () => {
  assert.isNull(
    modelProblem(
      [],
      ModelSelection.make({ instanceId: ProviderInstanceId.make("nope"), model: "x" }),
    ),
  );
});

it("refuses a model the provider does not offer", () => {
  assert.strictEqual(
    modelProblem(providers, sel("opus/unknown-model")),
    "Model opus/unknown-model is not offered by opencode.",
  );
});

it("names the offered variant when astra gets high", () => {
  const problem = modelProblem(providers, sel("opus/gpt-6-astra", "high"));
  assert.include(problem ?? "", 'no "high" variant');
  assert.include(problem ?? "", "it offers: xhigh");
});

it("accepts the offered variant", () => {
  assert.isNull(modelProblem(providers, sel("opus/gpt-6-astra", "xhigh")));
});

it("skips descriptor checks when the model has no descriptors", () => {
  const bare = [
    {
      ...opencodeTestProvider(),
      models: [{ slug: "opus/gpt-6-astra", name: "x", isCustom: false, capabilities: null }],
    },
  ];
  assert.isNull(modelProblem(bare, sel("opus/gpt-6-astra", "high")));
});

it("refuses a boolean value for a select option whose choice ids are 'true' and 'false'", () => {
  const base = opencodeTestProvider();
  const boolSelect = [
    {
      ...base,
      models: [
        {
          slug: "opus/x",
          name: "x",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "flag",
                label: "Flag",
                type: "select" as const,
                options: [
                  { id: "true", label: "true" },
                  { id: "false", label: "false" },
                ],
              },
            ],
          },
        },
      ],
    } satisfies typeof base,
  ];
  const selection = ModelSelection.make({
    instanceId: ProviderInstanceId.make("opencode"),
    model: "opus/x",
    options: [{ id: "flag", value: true }],
  });
  assert.isNotNull(modelProblem(boolSelect, selection));
});
