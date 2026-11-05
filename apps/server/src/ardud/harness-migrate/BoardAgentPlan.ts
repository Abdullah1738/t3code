import {
  ProviderInstanceId,
  type KanbanBoard,
  type OrchestratorMcpTarget,
} from "@t3tools/contracts";

import {
  CRPKO_REVIEWER_GUIDANCE,
  REVIEW_DELEGATION_GUIDANCE,
} from "../kanban/engine/reviewerRouting.ts";
import { planSelection } from "./selectionPlan.ts";

type Instructions = KanbanBoard["instructions"];
type InstructionField = keyof Instructions;

export type BoardAgentPlan =
  | { readonly _tag: "same" }
  | { readonly _tag: "mapped"; readonly next: Instructions }
  | {
      readonly _tag: "conflict";
      readonly conflicts: ReadonlyArray<{
        readonly field: InstructionField;
        readonly reason: string;
      }>;
    };

const AGENT_NAME = "crpko-reviewer";
const ROLE_NAME = "the inline read-only Crpko review role";
const DEFAULT_REVIEW_TARGET: OrchestratorMcpTarget = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "xhigh" }],
};

const fieldNames = ["modelRouting", "reviewerRouting", "escalation"] as const;
const namedSelector =
  /["'`]?\b(?:agent|subagent_type|agent_type)["'`]?\s*[=:]\s*["'`]?([\w./-]+)["'`]?/gi;
const quotedAgent = /\b(?:agent|subagent)\s+(?:named\s+)?["'`]([\w./-]+)["'`]/gi;
const namedRole = /\b([\w-]+-reviewer)\b/g;
const nativeCall = /\b(?:subagent|functions\.subagent)\s*\(/g;
const legacyModel = /\b(?:opus|layso)\/[\w./-]+(?:#[\w-]+)?/g;
const implicitModel = /\bpass no model\s*\(it runs Sol xhigh\)/gi;
const supportedCallArguments = new Set(["agent", "model", "prompt", "description", "background"]);

const modelTarget = (model: string): { target: OrchestratorMcpTarget } | { reason: string } => {
  const selection = planSelection({ instanceId: ProviderInstanceId.make("opencode"), model });
  if (selection._tag !== "mapped")
    return {
      reason:
        selection._tag === "conflict"
          ? selection.reason
          : "Reviewer model has no verified native route.",
    };
  return {
    target: {
      providerInstanceId: selection.next.instanceId,
      model: selection.next.model,
      options: selection.next.options ?? [],
    },
  };
};

const callEnd = (text: string, start: number): number | null => {
  let depth = 1;
  let quote: string | null = null;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index;
  }
  return null;
};

/** Only complete JSON examples are executable rewrites; shorthand or dynamic calls need a human. */
const mapCall = (body: string): { text: string } | { reason: string } => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return {
      reason:
        "Native reviewer call is not a complete JSON object; rewrite it as delegate_task explicitly.",
    };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { reason: "Native reviewer call must be a JSON object." };
  const args = value as Record<string, unknown>;
  if (args.agent !== AGENT_NAME)
    return { reason: "Native reviewer call names an unsupported agent." };
  if (Object.keys(args).some((key) => !supportedCallArguments.has(key)))
    return {
      reason:
        "Native reviewer call has unsupported arguments; no continuation or permission semantics are guessed.",
    };
  if (
    typeof args.prompt !== "string" ||
    (args.description !== undefined && typeof args.description !== "string") ||
    (args.background !== undefined && typeof args.background !== "boolean") ||
    (args.model !== undefined && typeof args.model !== "string")
  )
    return {
      reason:
        "Native reviewer call has nonliteral or invalid task, model, title or background arguments.",
    };

  let target = DEFAULT_REVIEW_TARGET;
  if (typeof args.model === "string") {
    const mapped = modelTarget(args.model);
    if ("reason" in mapped) return mapped;
    target = mapped.target;
  }
  return {
    text: `delegate_task(${JSON.stringify({
      role: "review",
      target,
      task: `${CRPKO_REVIEWER_GUIDANCE}\n\n${args.prompt}`,
      ...(args.description === undefined ? {} : { title: args.description }),
      mode: args.background === true ? "async" : "wait",
    })})`,
  };
};

const planText = (text: string): { text: string; mapped: boolean } | { reason: string } => {
  for (const pattern of [namedSelector, quotedAgent])
    for (const match of text.matchAll(pattern))
      if (match[1] !== AGENT_NAME)
        return {
          reason: `Unsupported named agent ${match[1]}; its guidance must be supplied explicitly.`,
        };
  if (/(?:\.config\/opencode|OPENCODE_CONFIG_DIR)[^\n]*\/agents\//.test(text))
    return {
      reason:
        "Agent-definition file requirements must be replaced with inline guidance explicitly.",
    };
  for (const match of text.matchAll(namedRole))
    if (match[1] !== AGENT_NAME && match[1] !== "lean-reviewer")
      return {
        reason: `Unsupported named reviewer ${match[1]}; its guidance must be supplied explicitly.`,
      };
  if (!/\b(?:crpko-reviewer|lean-reviewer)\b/.test(text)) return { text, mapped: false };

  let result = "";
  let offset = 0;
  for (const match of text.matchAll(nativeCall)) {
    if (match.index < offset) continue;
    const start = match.index + match[0].length;
    const end = callEnd(text, start);
    if (end === null) return { reason: "Native reviewer call is incomplete." };
    const call = mapCall(text.slice(start, end));
    if ("reason" in call) return call;
    const prose = mapProse(text.slice(offset, match.index));
    if ("reason" in prose) return prose;
    result += prose.text + call.text;
    offset = end + 1;
  }
  const prose = mapProse(text.slice(offset));
  if ("reason" in prose) return prose;
  result += prose.text;
  return {
    mapped: true,
    text: [
      result,
      REVIEW_DELEGATION_GUIDANCE,
      `- When the routing above relied on the review role's implicit model, use this explicit default target: ${JSON.stringify(DEFAULT_REVIEW_TARGET)}. An explicitly routed model or effort above still wins.`,
      CRPKO_REVIEWER_GUIDANCE,
    ].join("\n\n"),
  };
};

const mapProse = (text: string): { text: string } | { reason: string } => {
  // Bare selectors occur in prose too. Structured objects outside a call are not safe to reinterpret.
  if (/[{][^{}]*["'`]?\b(?:agent|subagent_type|agent_type)["'`]?\s*[=:]/s.test(text))
    return { reason: "Standalone native agent arguments need an explicit delegate_task rewrite." };
  let result = text;
  for (const match of text.matchAll(legacyModel)) {
    const mapped = modelTarget(match[0]);
    if ("reason" in mapped) return mapped;
    result = result.replace(match[0], JSON.stringify(mapped.target));
  }
  return {
    text: result
      .replace(implicitModel, `set target to ${JSON.stringify(DEFAULT_REVIEW_TARGET)}`)
      .replace(
        /\bnative subagent with agent\s+["'`]?crpko-reviewer["'`]?/gi,
        `T3 delegate_task review task using ${ROLE_NAME}`,
      )
      .replace(namedSelector, ROLE_NAME)
      .replace(quotedAgent, ROLE_NAME)
      .replace(/\bcrpko-reviewer\b/g, ROLE_NAME)
      .replace(
        /\blean-reviewer(?:\s+plugin)?\b/g,
        "self-contained task context (no prompt-trimming hook)",
      ),
  };
};

/** Plans stored instruction text only. The caller owns the board transaction, ledger and rollback. */
export const planBoardAgentInstructions = (instructions: Instructions): BoardAgentPlan => {
  const next = { ...instructions };
  const conflicts: Array<{ field: InstructionField; reason: string }> = [];
  let mapped = false;
  for (const field of fieldNames) {
    const plan = planText(instructions[field]);
    if ("reason" in plan) conflicts.push({ field, reason: plan.reason });
    else {
      next[field] = plan.text;
      mapped ||= plan.mapped;
    }
  }
  return conflicts.length > 0
    ? { _tag: "conflict", conflicts }
    : mapped
      ? { _tag: "mapped", next }
      : { _tag: "same" };
};
