import { assert, it } from "@effect/vitest";
import type { ModelSelection } from "@t3tools/contracts";

import { planFallbacks } from "./fallbackPlan.ts";

const sel = (instanceId: string, model: string): ModelSelection =>
  ({ instanceId, model }) as unknown as ModelSelection;

it("maps a task's OpenCode fallbacks to the new harness, in order", () => {
  const plan = planFallbacks({
    taskId: "task-1",
    fallbacks: [sel("opencode", "opus/gpt-6-astra"), sel("opencode", "layso/gpt-6-astra")],
  });
  assert.isTrue(plan.changed);
  assert.strictEqual(plan.conflicts.length, 0);
  assert.deepStrictEqual(
    plan.after.map((entry) => `${entry.instanceId}/${entry.model}`),
    ["codex/gpt-6-astra"],
  );
});

it("dedupes after mapping, so two routes to one model collapse to one entry", () => {
  // Both legacy ids name the same Codex model, so the mapped list must hold it once.
  const plan = planFallbacks({
    taskId: "task-2",
    fallbacks: [sel("opencode", "opus/gpt-6-astra"), sel("opencode", "layso/gpt-6-astra")],
  });
  assert.strictEqual(plan.after.length, 1);
});

it("leaves an unmapped fallback exactly where it was", () => {
  const glm = sel("opencode", "opus/glm-5");
  const plan = planFallbacks({
    taskId: "task-3",
    fallbacks: [glm, sel("opencode", "opus/gpt-6-astra")],
  });
  assert.strictEqual(plan.after[0]?.model, "opus/glm-5");
  assert.strictEqual(plan.after[1]?.instanceId, "codex");
});

it("reports nothing to change when every fallback is already migrated", () => {
  const plan = planFallbacks({
    taskId: "task-4",
    fallbacks: [sel("codex", "gpt-6-astra")],
  });
  assert.isFalse(plan.changed);
  assert.deepStrictEqual(plan.after, plan.before);
});

it("keeps the whole list when one entry conflicts, rather than partly rewriting it", () => {
  const conflicting = {
    instanceId: "opencode",
    model: "opus/gpt-6-astra#xhigh",
    options: [{ id: "variant", value: "high" }],
  } as unknown as ModelSelection;
  const plan = planFallbacks({
    taskId: "task-5",
    fallbacks: [sel("opencode", "opus/gpt-6-astra"), conflicting],
  });
  assert.isFalse(plan.changed);
  assert.strictEqual(plan.conflicts.length, 1);
  assert.strictEqual(plan.conflicts[0]?.index, 1);
  assert.deepStrictEqual(plan.after, plan.before);
});
