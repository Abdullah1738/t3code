import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  getCodexServiceTierOptionValue,
  getCodexExecutionServiceTier,
} from "./codexModelOptions.ts";

it("returns the selected Codex service tier id", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5", [
    { id: "serviceTier", value: "flex" },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "flex");
});

it("keeps legacy persisted fast mode selections working", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "fast");
});

it("forces standard execution independently of recorded tier parsing", () => {
  for (const tier of [undefined, "priority", "fast", "ultrafast"]) {
    const selection = createModelSelection(
      ProviderInstanceId.make("codex"),
      "gpt-6-sol",
      tier ? [{ id: "serviceTier", value: tier }] : [],
    );
    assert.equal(getCodexExecutionServiceTier(selection), "default");
  }
});
