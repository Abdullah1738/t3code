import type { OrchestrationV2ConversationMessage, OrchestrationV2TurnItem } from "@t3tools/contracts";

import { TERMINAL_RUN_STATUSES } from "./model.ts";

/**
 * Turn-item types that mean a tool, command or delegated action ran. Anything
 * here makes a run `ran`. Missing a type would let a run that did act read as
 * `none`, and the iMessage bridge would then retry an action that already ran,
 * so this set errs wide.
 */
const TOOL_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "file_change",
  "dynamic_tool",
  "web_search",
  "file_search",
  "subagent",
  "todo_list",
  "fork",
  "handoff",
]);

export type ToolEvidence = "ran" | "none" | "unknown";

export interface RunEvidence {
  readonly toolEvidence: ToolEvidence;
  /** Every turn item of the run was read, and the run has settled. */
  readonly complete: boolean;
}

const PREVIEW_CHARS = 200;

/**
 * Whether the run called a tool, from its turn items. `none` is a claim about
 * the whole run, so it needs the run to be terminal and every item loaded; when
 * either is missing the answer is `unknown`. A tool item found is `ran` whatever
 * else is missing, because a tool that ran is a fact.
 */
export function runToolEvidence(input: {
  readonly runStatus: string | null;
  readonly turnItems: ReadonlyArray<Pick<OrchestrationV2TurnItem, "type">>;
  /** False when the read was capped or the run's items could not all be loaded. */
  readonly itemsComplete: boolean;
}): RunEvidence {
  const terminal =
    input.runStatus !== null &&
    TERMINAL_RUN_STATUSES.has(input.runStatus as Parameters<typeof TERMINAL_RUN_STATUSES.has>[0]);
  if (input.turnItems.some((item) => TOOL_ITEM_TYPES.has(item.type))) {
    return { toolEvidence: "ran", complete: terminal && input.itemsComplete };
  }
  const complete = terminal && input.itemsComplete;
  return { toolEvidence: complete ? "none" : "unknown", complete };
}

/** A message's visible text, cut to the preview length the control API returns. */
export function messagePreview(message: Pick<OrchestrationV2ConversationMessage, "text">): string {
  return message.text.length <= PREVIEW_CHARS
    ? message.text
    : message.text.slice(0, PREVIEW_CHARS);
}
