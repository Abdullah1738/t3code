import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2DomainEvent,
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
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import {
  endRunlessRootTurns,
  endRunlessProviderTurns,
  makeSubagentConversationArtifacts,
  subagentResultForRun,
} from "./subagentProjection.ts";

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

const root: OrchestrationV2ExecutionNode = {
  id: NodeId.make("runless-root"),
  threadId: run.threadId,
  runId: null,
  parentNodeId: null,
  rootNodeId: NodeId.make("runless-root"),
  kind: "root_turn",
  status: "running",
  countsForRun: false,
  providerThreadId: run.providerThreadId,
  providerTurnId: ProviderTurnId.make("runless-turn"),
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: now,
  completedAt: null,
};
const runlessTurn: OrchestrationV2ProviderTurn = {
  id: root.providerTurnId!,
  nodeId: root.id,
  providerThreadId: root.providerThreadId!,
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "running",
  startedAt: now,
  completedAt: null,
};
const endInput = {
  threadId: run.threadId,
  providerInstanceId: run.providerInstanceId,
  now,
  emitted: [] as ReadonlyArray<OrchestrationV2DomainEvent>,
  allocateEventId: () => Effect.succeed(EventId.make("end-runless")),
};
it.effect("ends the active root, streaming item and every runless turn together", () =>
  Effect.gen(function* () {
    const item = makeSubagentConversationArtifacts({
      messageId: MessageId.make("stream"),
      turnItemId: TurnItemId.make("stream"),
      threadId: run.threadId,
      rootNodeId: root.id,
      providerThreadId: root.providerThreadId,
      providerTurnId: runlessTurn.id,
      nativeItemRef: null,
      role: "assistant",
      text: "Working",
      ordinal: 1,
      now,
    }).turnItem;
    const events = yield* endRunlessRootTurns({
      ...endInput,
      status: "cancelled",
      projection: {
        nodes: [root],
        turnItems: [{ ...item, status: "running", completedAt: null }],
        providerTurns: [
          runlessTurn,
          { ...runlessTurn, id: ProviderTurnId.make("pending"), status: "pending" },
        ],
      },
    });
    assert.deepEqual(
      events.map((e) => e.type),
      ["node.updated", "turn-item.updated", "provider-turn.updated", "provider-turn.updated"],
    );
    for (const event of events) {
      if (
        event.type === "node.updated" ||
        event.type === "turn-item.updated" ||
        event.type === "provider-turn.updated"
      ) {
        assert.equal(event.payload.status, "cancelled");
        assert.deepEqual(event.payload.completedAt, now);
      }
    }
  }),
);
it.effect.each(["cancelled", "completed", "failed", "interrupted"] as const)(
  "repairs a %s root using its own completion time",
  (status) =>
    Effect.gen(function* () {
      const completedAt = DateTime.makeUnsafe("2026-10-03T02:53:13.220Z");
      const events = yield* endRunlessRootTurns({
        ...endInput,
        status: "cancelled",
        projection: {
          nodes: [{ ...root, status, completedAt }],
          providerTurns: [runlessTurn],
          turnItems: [],
        },
      });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "provider-turn.updated");
      const event = events[0];
      if (event?.type !== "provider-turn.updated") throw new Error("Expected provider turn update");
      assert.equal(event.payload.status, status);
      assert.deepEqual(event.payload.completedAt, completedAt);
    }),
);
it.effect("preserves attached, already ended, already emitted and live-owned turns", () =>
  Effect.gen(function* () {
    const terminalRoot = { ...root, status: "cancelled" as const };
    const event: OrchestrationV2DomainEvent = {
      id: EventId.make("prior"),
      type: "provider-turn.updated",
      threadId: run.threadId,
      occurredAt: now,
      payload: { ...runlessTurn, status: "cancelled", completedAt: now },
    };
    for (const turn of [
      { ...runlessTurn, runAttemptId: run.activeAttemptId },
      { ...runlessTurn, status: "completed" as const, completedAt: now },
    ]) {
      assert.deepEqual(
        yield* endRunlessRootTurns({
          ...endInput,
          status: "cancelled",
          projection: { nodes: [terminalRoot], providerTurns: [turn], turnItems: [] },
        }),
        [],
      );
    }
    assert.deepEqual(
      yield* endRunlessRootTurns({
        ...endInput,
        emitted: [event],
        status: "cancelled",
        projection: { nodes: [terminalRoot], providerTurns: [runlessTurn], turnItems: [] },
      }),
      [],
    );
    assert.deepEqual(
      yield* endRunlessProviderTurns({
        ...endInput,
        projection: { nodes: [root], providerTurns: [runlessTurn] },
      }),
      [],
    );
    const events = yield* endRunlessProviderTurns({
      ...endInput,
      projection: { nodes: [terminalRoot], providerTurns: [runlessTurn] },
    });
    const repaired = events[0];
    if (repaired?.type !== "provider-turn.updated")
      throw new Error("Expected provider turn update");
    assert.deepEqual(repaired.payload.completedAt, now);
  }),
);
