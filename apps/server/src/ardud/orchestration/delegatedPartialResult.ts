import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { ProjectionRecordFilter } from "../../orchestration-v2/ProjectionStore.ts";

export const completedToolFilter = (run: OrchestrationV2Run): ProjectionRecordFilter => ({
  turnItemRunId: run.id,
  turnItemTypes: ["command_execution", "dynamic_tool"],
  turnItemStatuses: ["completed", "failed"],
  toolResultsOnly: true,
  turnItemOrder: "completion",
  recentTurnItemLimit: 1,
});

export const needsPartialResult = (run: OrchestrationV2Run) =>
  run.status === "interrupted" || run.status === "failed";

// Include the marker in the byte budget, and never split a UTF-8 code point.
function outputTail(output: string): string {
  const bytes = new TextEncoder().encode(output);
  if (bytes.length <= 4096) return output;
  const marker = "[truncated; last output bytes follow]\n";
  let start = bytes.length - (4096 - new TextEncoder().encode(marker).length);
  while ((bytes[start]! & 0xc0) === 0x80) start++;
  return marker + new TextDecoder().decode(bytes.subarray(start));
}

export function delegatedPartialResult(
  text: string,
  run: OrchestrationV2Run,
  tool: OrchestrationV2TurnItem | undefined,
  failureMessage?: string,
): string {
  if (!needsPartialResult(run)) return text;
  const reason =
    run.cancelDetail ??
    failureMessage ??
    run.cancelReason ??
    `Child task ended with status ${run.status}.`;
  const stopped = text.includes(reason) ? text : `${text}\n\nStop reason: ${reason}`;
  if (tool?.type !== "command_execution" && tool?.type !== "dynamic_tool") return stopped;
  const name = tool.type === "command_execution" ? tool.input : (tool.toolName ?? "dynamic_tool");
  const output = tool.output;
  const rendered = typeof output === "string" ? output : (JSON.stringify(output) ?? "");
  const exitCode =
    tool.type === "command_execution"
      ? tool.exitCode
      : typeof output === "object" &&
          output !== null &&
          "exitCode" in output &&
          typeof output.exitCode === "number"
        ? output.exitCode
        : undefined;
  const exit = exitCode === undefined ? "" : ` (exit ${exitCode})`;
  return `${stopped}\n\nLast completed tool: ${name.slice(0, 512)}${exit}\n${outputTail(rendered)}`;
}
