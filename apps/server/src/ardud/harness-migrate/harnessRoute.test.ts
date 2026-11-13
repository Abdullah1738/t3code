import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { resolveSelection } from "@t3tools/client-runtime/ardud/models/harnessRouting";

it("routes OpenCode Terra to codex-cu with its effort", () => {
  const result = resolveSelection({
    instanceId: ProviderInstanceId.make("opencode"),
    model: "opus/cx/gpt-6.1-terra",
    options: [{ id: "variant", value: "max" }],
  });
  assert.equal(result.kind, "mapped");
  if (result.kind !== "mapped") return;
  assert.equal(result.selection.instanceId, "codex-cu");
  assert.equal(result.selection.model, "gpt-6.1-terra");
  assert.deepEqual(result.selection.options, [{ id: "reasoningEffort", value: "max" }]);
});
