import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { modelSelectionResult } from "./defaults.ts";
import { resolveScriptSelection } from "./selectionBridge.ts";

it.each([
  ["opus/cx/gpt-6.1-sol", "gpt-6.1-sol", "codex"],
  ["opus/cx/gpt-6.1-terra", "gpt-6.1-terra", "codex-cu"],
  ["opus/gpt-6-astra", "gpt-6-astra", "codex"],
  ["layso/gpt-6-astra", "gpt-6-astra", "codex"],
] as const)("preserves serviceTier on card and script %s remaps", (source, model, instanceId) => {
  const selection = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: source,
    options: [
      { id: "variant", value: "xhigh" },
      { id: "serviceTier", value: "default" },
    ],
  };
  const expected = {
    instanceId: ProviderInstanceId.make(instanceId),
    model,
    options: [
      { id: "reasoningEffort", value: "xhigh" },
      { id: "serviceTier", value: "default" },
    ],
  };
  assert.deepEqual(modelSelectionResult(selection, true), {
    kind: "selection",
    selection: expected,
  });
  assert.deepEqual(resolveScriptSelection(selection), { kind: "selection", selection: expected });
});
