import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { modelSelectionResult } from "./defaults.ts";
import { resolveScriptSelection } from "./selectionBridge.ts";

it.each(["sol", "terra"] as const)("preserves serviceTier on card and script %s remaps", (name) => {
  const selection = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: `opus/cx/gpt-6.1-${name}`,
    options: [
      { id: "variant", value: "xhigh" },
      { id: "serviceTier", value: "default" },
    ],
  };
  const expected = {
    instanceId: ProviderInstanceId.make(name === "sol" ? "codex" : "codex-cu"),
    model: `gpt-6.1-${name}`,
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
