import { assert, it } from "@effect/vitest";
import type { ModelSelection } from "@t3tools/contracts";

import { planSelection } from "./selectionPlan.ts";

const OPENCODE = "opencode";

const selection = (model: string, options?: ModelSelection["options"]): ModelSelection =>
  ({
    instanceId: OPENCODE,
    model,
    ...(options === undefined ? {} : { options }),
  }) as ModelSelection;

it("maps a legacy Claude selection to the Claude Code harness", () => {
  const plan = planSelection(selection("opus/claude-opus-5-5"));
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  assert.strictEqual(plan.next.instanceId, "claudeAgent");
  assert.strictEqual(plan.next.model, "claude-opus-5-5");
});

it("maps a legacy Codex selection to the Codex harness", () => {
  const plan = planSelection(selection("opus/cx/gpt-6.1-sol"));
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  assert.strictEqual(plan.next.instanceId, "codex");
  assert.strictEqual(plan.next.model, "gpt-6.1-sol");
});

it("maps Terra to codex-cu, not codex", () => {
  const plan = planSelection(selection("opus/cx/gpt-6.1-terra"));
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  assert.strictEqual(plan.next.instanceId, "codex-cu");
  assert.strictEqual(plan.next.model, "gpt-6.1-terra");
});

it("leaves an unmapped OpenCode model exactly as it is", () => {
  // GLM, Kimi and the title model stay on OpenCode; the migration must never touch them.
  const plan = planSelection(selection("opus/glm-5"));
  assert.strictEqual(plan._tag, "same");
});

it("moves a legacy #xhigh suffix into the effort option", () => {
  const plan = planSelection(selection("opus/cc/claude-haiku-5-5#xhigh"));
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  assert.strictEqual(plan.next.instanceId, "claudeAgent");
  assert.strictEqual(plan.next.model, "claude-haiku-5-5");
  assert.deepStrictEqual(plan.next.options, [{ id: "effort", value: "xhigh" }]);
});

it("refuses a suffix and a variant that name different efforts", () => {
  const plan = planSelection(
    selection("opus/cc/claude-haiku-5-5#xhigh", [{ id: "variant", value: "high" }]),
  );
  assert.strictEqual(plan._tag, "conflict");
});

it("keeps a fast-mode option on the new harness", () => {
  const plan = planSelection(selection("opus/claude-opus-5-5", [{ id: "fastMode", value: true }]));
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  assert.deepStrictEqual(plan.next.options, [{ id: "fastMode", value: true }]);
});

it("keeps a value that already routes to the new harness unchanged", () => {
  const plan = planSelection({
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
  } as ModelSelection);
  assert.strictEqual(plan._tag, "same");
});
