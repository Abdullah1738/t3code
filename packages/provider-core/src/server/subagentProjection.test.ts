import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2AssistantPhase,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeSubagentConversationArtifacts, subagentResultForRun } from "./subagentProjection.ts";

const now = DateTime.makeUnsafe("2026-11-05T17:52:25Z");
const run: OrchestrationV2Run = {
  id: RunId.make("child"),
  threadId: ThreadId.make("child"),
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("opencode"),
  modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "haiku" },
  providerThreadId: ProviderThreadId.make("child"),
  userMessageId: MessageId.make("prompt"),
  rootNodeId: NodeId.make("root"),
  activeAttemptId: RunAttemptId.make("attempt"),
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
};
const cases: ReadonlyArray<{
  finish: string | null | undefined;
  phase: OrchestrationV2AssistantPhase;
  incomplete: boolean;
  empty?: boolean;
}> = [
  { finish: "length", phase: "narration", incomplete: true },
  { finish: "length", phase: "answer", incomplete: true },
  { finish: "length", phase: "unknown", incomplete: true, empty: true },
  { finish: "content-filter", phase: "answer", incomplete: true },
  { finish: "error", phase: "answer", incomplete: true },
  { finish: "tool-calls", phase: "narration", incomplete: true },
  { finish: "stop", phase: "narration", incomplete: true },
  { finish: null, phase: "narration", incomplete: true },
  { finish: "stop", phase: "answer", incomplete: false },
  { finish: "end_turn", phase: "answer", incomplete: false },
  { finish: "stop_sequence", phase: "answer", incomplete: false },
  { finish: "end_turn", phase: "unknown", incomplete: false },
  { finish: "stop_sequence", phase: "unknown", incomplete: false },
  { finish: "end_turn", phase: "narration", incomplete: true },
  { finish: "stop_sequence", phase: "narration", incomplete: true },
  { finish: "max_tokens", phase: "answer", incomplete: true },
  { finish: "max_tokens", phase: "unknown", incomplete: true, empty: true },
  { finish: "refusal", phase: "answer", incomplete: true },
  { finish: "pause_turn", phase: "answer", incomplete: true },
  { finish: "tool_use", phase: "answer", incomplete: true },
  { finish: "model_context_window_exceeded", phase: "answer", incomplete: true },
  { finish: null, phase: "answer", incomplete: false },
  { finish: undefined, phase: "answer", incomplete: false },
];
it.each(
  cases.flatMap((entry) => [false, true].map((withoutAttempt) => ({ ...entry, withoutAttempt }))),
)(
  "classifies result finish=$finish phase=$phase empty=$empty withoutAttempt=$withoutAttempt",
  (test) => {
    const text =
      test.phase === "narration" ? "Next I'll read the storage module." : "All checks passed.";
    const artifacts = makeSubagentConversationArtifacts({
      messageId: MessageId.make("result"),
      turnItemId: TurnItemId.make("result"),
      threadId: run.threadId,
      rootNodeId: run.rootNodeId!,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      role: "assistant",
      text,
      ordinal: 1,
      now,
    });
    assert.equal(artifacts.turnItem.type, "assistant_message");
    if (artifacts.turnItem.type !== "assistant_message") throw new Error("Expected assistant item");
    const turn = {
      id: ProviderTurnId.make("last"),
      providerThreadId: run.providerThreadId!,
      nodeId: run.rootNodeId!,
      runAttemptId: run.activeAttemptId,
      nativeTurnRef: null,
      ordinal: 2,
      status: "completed" as const,
      startedAt: now,
      completedAt: now,
      finish: test.finish,
    };
    const result = subagentResultForRun(
      {
        messages: test.empty ? [] : [{ ...artifacts.message, runId: run.id, phase: test.phase }],
        turnItems: test.empty ? [] : [{ ...artifacts.turnItem, runId: run.id, phase: test.phase }],
        providerTurns: [
          turn,
          { ...turn, id: ProviderTurnId.make("earlier"), ordinal: 1, finish: "length" },
          {
            ...turn,
            id: ProviderTurnId.make("other-run"),
            ordinal: 99,
            runAttemptId: RunAttemptId.make("other"),
            nodeId: NodeId.make("other-root"),
            finish: "length",
          },
        ],
      },
      test.withoutAttempt ? { ...run, activeAttemptId: null } : run,
    );
    assert.equal(result.incomplete !== null, test.incomplete);
    if (test.incomplete) {
      assert.isTrue(result.text.startsWith("[Result looks incomplete:"));
      if (test.finish === "length")
        assert.include(result.incomplete!, "output limit (finish=length)");
      if (test.phase === "narration") assert.include(result.incomplete!, "progress note");
      assert.include(
        result.text,
        test.empty ? "Child task completed without an assistant result." : text,
      );
    } else {
      assert.equal(result.text, text);
    }
  },
);
