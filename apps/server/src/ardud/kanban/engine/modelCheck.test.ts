import { assert, it } from "@effect/vitest";
import { ModelSelection, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

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

it.each([false, true, "false"] as const)(
  "only treats an unadvertised fastMode:false as a no-op (%s)",
  (value) => {
    const selection = ModelSelection.make({
      instanceId: ProviderInstanceId.make("opencode"),
      model: "opus/gpt-6-astra",
      options: [
        { id: "variant", value: "xhigh" },
        { id: "fastMode", value },
      ],
    });
    const problem = modelProblem(providers, selection);
    if (value === false) assert.isNull(problem);
    else assert.include(problem ?? "", "Unknown option fastMode");
  },
);

it("still refuses other unknown options alongside fastMode:false", () => {
  const selection = ModelSelection.make({
    instanceId: ProviderInstanceId.make("opencode"),
    model: "opus/gpt-6-astra",
    options: [
      { id: "fastMode", value: false },
      { id: "missing", value: false },
    ],
  });
  assert.include(modelProblem(providers, selection) ?? "", "Unknown option missing");
});

it.each([
  ["claudeAgent", "claude-opus-5-5", "effort"],
  ["codex", "gpt-6.1-sol", "reasoningEffort"],
] as const)(
  "accepts standard mode on %s/%s without a fastMode descriptor",
  (driver, model, effortId) => {
    const instanceId = ProviderInstanceId.make(driver);
    const provider = {
      ...opencodeTestProvider(),
      instanceId,
      driver: ProviderDriverKind.make(driver),
      models: [
        {
          slug: model,
          name: model,
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: effortId,
                label: "Effort",
                type: "select" as const,
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
    };
    const selection = ModelSelection.make({
      instanceId,
      model,
      options: [
        { id: effortId, value: "high" },
        { id: "fastMode", value: false },
      ],
    });
    assert.isNull(modelProblem([provider], selection));
    assert.include(
      modelProblem([provider], {
        ...selection,
        options: [{ id: "fastMode", value: true }],
      }) ?? "",
      "Unknown option fastMode",
    );
  },
);

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
