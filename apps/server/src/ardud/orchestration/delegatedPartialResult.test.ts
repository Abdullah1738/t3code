import { assert, it } from "@effect/vitest";
import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { delegatedPartialResult } from "./delegatedPartialResult.ts";

it.each([0, 1])(
  "retains a stopped watcher's tool output (exit %s), bounded in UTF-8 bytes",
  (exitCode) => {
    const reason =
      "Stalled: no tool call or text for 15 min (last progress: command_execution_finished)";
    const result = delegatedPartialResult(
      "I'll load the remote-compute skill first.",
      {
        status: "interrupted",
        cancelDetail: reason,
      } as OrchestrationV2Run,
      {
        type: "command_execution",
        input: "offbox wait run-1116-watch --timeout 570",
        exitCode,
        output: "界".repeat(4096) + `\nexit ${exitCode}\n/logs/run-1116-watch.log`,
      } as OrchestrationV2TurnItem,
    );
    assert.include(result, reason);
    assert.include(result, `offbox wait run-1116-watch --timeout 570 (exit ${exitCode})`);
    const tail = result.split(`(exit ${exitCode})\n`)[1]!;
    assert.isAtMost(new TextEncoder().encode(tail).length, 4096);
    assert.include(tail, "[truncated;");
    assert.notInclude(tail, "�");
    assert.isTrue(tail.endsWith(`/logs/run-1116-watch.log`));
  },
);

it("a failed child without tools preserves the result and adds its stop reason", () => {
  assert.equal(
    delegatedPartialResult(
      "Starting checks.",
      { status: "failed", cancelDetail: "Request timed out." } as OrchestrationV2Run,
      undefined,
    ),
    "Starting checks.\n\nStop reason: Request timed out.",
  );
});

it("successful completion remains byte-identical even with tool output", () => {
  const text = "WATCH_DONE: run-1116-watch exit 0\n/logs/run-1116-watch.log\n";
  assert.equal(
    delegatedPartialResult(
      text,
      { status: "completed" } as OrchestrationV2Run,
      {
        type: "command_execution",
        input: "offbox wait",
        output: "ignored",
      } as OrchestrationV2TurnItem,
    ),
    text,
  );
});

it("retains MCP results with the tool name", () => {
  assert.include(
    delegatedPartialResult(
      "Starting.",
      { status: "failed" } as OrchestrationV2Run,
      {
        type: "dynamic_tool",
        toolName: "mcp__offbox__wait",
        output: { exitCode: 1, log: "/logs/watch.log" },
      } as OrchestrationV2TurnItem,
    ),
    'Last completed tool: mcp__offbox__wait (exit 1)\n{"exitCode":1,"log":"/logs/watch.log"}',
  );
});

it("an interrupted provider backstop includes its error even after narration", () => {
  assert.include(
    delegatedPartialResult(
      "Loading the skill.",
      { status: "interrupted" } as OrchestrationV2Run,
      undefined,
      "Claude got no response for 5 min: Request timed out.",
    ),
    "Stop reason: Claude got no response for 5 min: Request timed out.",
  );
});
