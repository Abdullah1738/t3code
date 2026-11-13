import { assert, it } from "@effect/vitest";
import type { KanbanBoard } from "@t3tools/contracts";

import { planBoardAgentInstructions } from "./BoardAgentPlan.ts";

const instructions = (reviewerRouting: string): KanbanBoard["instructions"] => ({
  modelRouting: "Haiku writes code at max. Keep the existing pool weights.",
  reviewerRouting,
  escalation: "Ask before merging or deploying.",
});

it("inlines the known reviewer role without changing the board's other routing or approvals", () => {
  const before = instructions(
    "One crpko-reviewer per round. Sol xhigh first; Astra xhigh only after Sol clears a critical PR. Findings: /scratch/findings.md.",
  );
  const plan = planBoardAgentInstructions(before);
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  assert.strictEqual(plan.next.modelRouting, before.modelRouting);
  assert.strictEqual(plan.next.escalation, before.escalation);
  assert.include(
    plan.next.reviewerRouting,
    "Sol xhigh first; Astra xhigh only after Sol clears a critical PR",
  );
  assert.include(plan.next.reviewerRouting, "/scratch/findings.md");
  assert.include(plan.next.reviewerRouting, "exact head SHA");
  assert.include(
    plan.next.reviewerRouting,
    "Never push, comment on GitHub, change Linear, merge, deploy",
  );
  assert.include(plan.next.reviewerRouting, "/Users/ardud/CrpkoArchitectureBroker");
  assert.include(plan.next.reviewerRouting, "output file the brief names");
  assert.include(plan.next.reviewerRouting, '"reasoningEffort","value":"xhigh"');
  assert.notInclude(plan.next.reviewerRouting, "crpko-reviewer");
  assert.deepStrictEqual(planBoardAgentInstructions(plan.next), { _tag: "same" });
  assert.include(before.reviewerRouting, "crpko-reviewer", "planning does not mutate the input");
});

it.each([
  {
    model: undefined,
    instance: "codex",
    name: "gpt-6.1-sol",
    effort: "xhigh",
    option: "reasoningEffort",
  },
  {
    model: "opus/gpt-6-astra#xhigh",
    instance: "codex",
    name: "gpt-6-astra",
    effort: "xhigh",
    option: "reasoningEffort",
  },
  {
    model: "opus/cx/gpt-6.1-terra#max",
    instance: "codex-cu",
    name: "gpt-6.1-terra",
    effort: "max",
    option: "reasoningEffort",
  },
  {
    model: "opus/cc/claude-haiku-5-5#max",
    instance: "claudeAgent",
    name: "claude-haiku-5-5",
    effort: "max",
    option: "effort",
  },
])("converts a complete native call with $name at $effort into an explicit task target", (row) => {
  const prompt =
    'Review head abcdef. The example is foo("nested (call)"). Return to /scratch/report.md.';
  const plan = planBoardAgentInstructions(
    instructions(
      `subagent(${JSON.stringify({
        agent: "crpko-reviewer",
        ...(row.model === undefined ? {} : { model: row.model }),
        prompt,
        description: "Exact-head review",
        background: false,
      })})`,
    ),
  );
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  const firstLine = plan.next.reviewerRouting.split("\n")[0]!;
  assert.isTrue(firstLine.startsWith("delegate_task("));
  const call = JSON.parse(firstLine.slice("delegate_task(".length, -1));
  assert.deepStrictEqual(call.target, {
    providerInstanceId: row.instance,
    model: row.name,
    options: [{ id: row.option, value: row.effort }],
  });
  assert.strictEqual(call.role, "review");
  assert.strictEqual(call.mode, "wait");
  assert.strictEqual(call.title, "Exact-head review");
  assert.strictEqual(call.agent, undefined);
  assert.isTrue(call.task.endsWith(prompt));
  assert.include(call.task, "Never edit the review worktree");
});

it("keeps an explicitly background task async without treating it as a completed review", () => {
  const plan = planBoardAgentInstructions(
    instructions(
      `subagent(${JSON.stringify({ agent: "crpko-reviewer", prompt: "Review exact head abc", background: true })})`,
    ),
  );
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  assert.include(plan.next.reviewerRouting, '"mode":"async"');
  assert.include(
    plan.next.reviewerRouting,
    "wait for the report before recording the board verdict",
  );
});

it("makes explicit model overrides in prose native without lowering their effort", () => {
  const plan = planBoardAgentInstructions(
    instructions(
      "One crpko-reviewer. Sol is opus/cx/gpt-6.1-sol#xhigh; the critical final uses opus/gpt-6-astra#max. No helpers.",
    ),
  );
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  assert.include(
    plan.next.reviewerRouting,
    '"model":"gpt-6-astra","options":[{"id":"reasoningEffort","value":"max"}]',
  );
  assert.include(
    plan.next.reviewerRouting,
    '"model":"gpt-6.1-sol","options":[{"id":"reasoningEffort","value":"xhigh"}]',
  );
  assert.include(plan.next.reviewerRouting, "No helpers.");
  assert.notInclude(plan.next.reviewerRouting, "opus/");
  assert.deepStrictEqual(planBoardAgentInstructions(plan.next), { _tag: "same" });
});

it("replaces the known prose-based implicit reviewer default with an explicit native target", () => {
  const plan = planBoardAgentInstructions(
    instructions(
      "Use one native subagent with agent `crpko-reviewer`. Pass no model (it runs Sol xhigh).",
    ),
  );
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  assert.include(plan.next.reviewerRouting, "Use one T3 delegate_task review task");
  assert.notInclude(plan.next.reviewerRouting, "Pass no model");
  assert.notInclude(plan.next.reviewerRouting, "native subagent");
  assert.include(plan.next.reviewerRouting, '"providerInstanceId":"codex","model":"gpt-6.1-sol"');
});

it("does not recast an unrelated writer's native task as a review role", () => {
  const plan = planBoardAgentInstructions(
    instructions(
      "Use crpko-reviewer for the review. Then use one native subagent on opus/cc/claude-haiku-5-5#max to rewrite the feedback.",
    ),
  );
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  assert.include(plan.next.reviewerRouting, "Then use one native subagent on");
  assert.include(
    plan.next.reviewerRouting,
    '"model":"claude-haiku-5-5","options":[{"id":"effort","value":"max"}]',
  );
});

it.each([
  'agent: "custom-auditor"',
  '{"agent":"custom-auditor"}',
  "subagent_type=`security-reviewer`",
  "Use agent `private-auditor`.",
  "Read ~/.config/opencode/agents/crpko-reviewer.md for its rules.",
  "Use security-reviewer after Sol.",
  "subagent(agent: crpko-reviewer, ...)",
  'subagent({"agent":"crpko-reviewer","prompt":"Review", "sessionID":"old"})',
  'subagent({"agent":"crpko-reviewer","prompt":"Review", "model":"opus/cx/gpt-unknown#max"})',
  'subagent({"agent":"crpko-reviewer","prompt":"Review"}',
  '{"agent":"crpko-reviewer","prompt":"Review"}',
  "Use crpko-reviewer on opus/cx/gpt-unknown#max.",
])("blocks unsupported or ambiguous routing rather than partially rewriting: %s", (text) => {
  const before = {
    ...instructions(text),
    modelRouting: "Use crpko-reviewer for the Sol pass.",
  };
  const saved = structuredClone(before);
  const plan = planBoardAgentInstructions(before);
  assert.strictEqual(plan._tag, "conflict");
  if (plan._tag !== "conflict") return;
  assert.strictEqual(plan.conflicts[0]?.field, "reviewerRouting");
  assert.isFalse("next" in plan, "no partially converted instructions are returned");
  assert.deepStrictEqual(before, saved);
});

it("checks all instruction fields, not just reviewerRouting", () => {
  const plan = planBoardAgentInstructions({
    ...instructions("Keep board review chains unchanged."),
    modelRouting: "Start agent: crpko-reviewer for reviews.",
    escalation: "Ask agent: private-approver before a merge.",
  });
  assert.strictEqual(plan._tag, "conflict");
  if (plan._tag !== "conflict") return;
  assert.strictEqual(plan.conflicts[0]?.field, "escalation");
});

it("retires the known prompt-trimming plugin without pretending native tasks trim system instructions", () => {
  const plan = planBoardAgentInstructions(
    instructions("Use crpko-reviewer with the lean-reviewer plugin."),
  );
  assert.strictEqual(plan._tag, "mapped");
  if (plan._tag !== "mapped") return;
  assert.notInclude(plan.next.reviewerRouting, "lean-reviewer");
  assert.notInclude(plan.next.reviewerRouting, "crpko-reviewer");
  assert.include(plan.next.reviewerRouting, "no prompt-trimming hook");
  assert.include(
    plan.next.reviewerRouting,
    "does not strip the target harness's global instructions",
  );
  assert.deepStrictEqual(planBoardAgentInstructions(plan.next), { _tag: "same" });
});

it("leaves already native routing and ordinary prose byte-for-byte alone", () => {
  const before = instructions(
    "Keep Sol xhigh in the board review chain. No child reviewer needed.",
  );
  assert.deepStrictEqual(planBoardAgentInstructions(before), { _tag: "same" });
});
