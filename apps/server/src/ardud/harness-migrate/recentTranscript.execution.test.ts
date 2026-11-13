import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const source = ProviderInstanceId.make("opencode");
const threadId = ThreadId.make("thread:compact-switch");
const sourceThreadId = ProviderThreadId.make("provider-thread:old");
const sourceSelection = { instanceId: source, model: "opus/cx/gpt-6.1-sol" };

const adapter = (
  name: "opencode" | "codex" | "claudeAgent",
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId: ProviderInstanceId.make(name),
  driver: ProviderDriverKind.make(name),
  getCapabilities: () =>
    Effect.succeed(
      name === "claudeAgent" ? ClaudeProviderCapabilitiesV2 : CodexProviderCapabilitiesV2,
    ),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Effect worker is disabled"),
});

it.effect.each([
  { target: "codex", enabled: true },
  { target: "claudeAgent", enabled: true },
  { target: "codex", enabled: false },
  { target: "codex", enabled: false, staged: true },
] as const)(
  "uses compact=$enabled projected history for a first turn on $target",
  ({ target, enabled, ...scenario }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:switch"),
        title: "Switch test",
        modelSelection: sourceSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const initial = yield* orchestrator.getThreadProjection(threadId);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("source-provider"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: sourceThreadId,
              driver: ProviderDriverKind.make("opencode"),
              providerInstanceId: source,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("opencode"),
                nativeId: "ses_old",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 3,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("active-source"),
            type: "thread.provider-switched",
            threadId,
            occurredAt: now,
            payload: { ...initial.thread, activeProviderThreadId: sourceThreadId },
          },
        ],
      });
      for (const ordinal of [1, 2, 3]) {
        const runId = RunId.make(`run:old:${ordinal}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run:${ordinal}`),
              type: "run.created",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal,
                providerInstanceId: source,
                modelSelection: sourceSelection,
                providerThreadId: sourceThreadId,
                userMessageId: MessageId.make(`message:${ordinal}`),
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            ...(["user", "assistant"] as const).map((role, index) => ({
              id: EventId.make(`event:${ordinal}:${role}`),
              type: "turn-item.updated" as const,
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item:${ordinal}:${role}`),
                threadId,
                runId,
                nodeId: null,
                providerThreadId: sourceThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: ordinal * 2 + index,
                status: "completed" as const,
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                messageId: MessageId.make(`message:${ordinal}:${role}`),
                text: `TURN_${ordinal}_${role}`,
                ...(role === "user"
                  ? {
                      type: "user_message" as const,
                      createdBy: "user" as const,
                      creationSource: "web" as const,
                      inputIntent: "turn_start" as const,
                      attachments: [],
                    }
                  : { type: "assistant_message" as const, streaming: false }),
              },
            })),
          ],
        });
      }
      const next = { instanceId: ProviderInstanceId.make(target), model: "test-model" };
      if ("staged" in scenario) {
        const imported = {
          ...initial.thread,
          activeProviderThreadId: sourceThreadId,
          historyOrigin: "v1_import" as const,
        };
        const sourceRun = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const sourceMessage = (yield* orchestrator.getThreadRecords(threadId, ["turnItems"]))
          .turnItems.find((item) => item.type === "user_message")!;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source-running"), type: "run.updated", threadId,
              runId: sourceRun.id, occurredAt: now, payload: { ...sourceRun, status: "running" },
            },
            {
              id: EventId.make("import-origin"),
              type: "thread.provider-switched",
              threadId,
              occurredAt: now,
              payload: imported,
            },
            {
              id: EventId.make("imported-message"),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...sourceMessage,
                id: TurnItemId.make("item:imported"),
                runId: null,
                ordinal: 1,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId: MessageId.make("message:imported"),
                text: "ALREADY_STAGED_IMPORT",
                attachments: [],
              },
            },
            {
              id: EventId.make("staged-provider"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...(yield* orchestrator.getThreadProjection(threadId)).providerThreads[0]!,
                id: ProviderThreadId.make("provider-thread:staged"),
                providerInstanceId: next.instanceId,
                driver: ProviderDriverKind.make("codex"),
                nativeThreadRef: null,
                nativeMetadata: {
                  seededHistory: {
                    mode: "codex-inject",
                    source: "opencode",
                    sourceSessionId: "ses_old",
                    digest: "source",
                    snapshotRunOrdinal: 1,
                  },
                },
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued-native"),
          threadId,
          messageId: MessageId.make("message:queued-native"),
          text: "Continue",
          attachments: [],
          modelSelection: next,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* eventSink.write({ events: [{
          id: EventId.make("source-ended"), type: "run.updated", threadId,
          runId: sourceRun.id, occurredAt: now, payload: sourceRun,
        }] });
        yield* orchestrator.resumeQueuedRuns;
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        const history = resumed.contextHandoffs.map((handoff) => handoff.summaryText).join("\n");
        assert.notInclude(history, "ALREADY_STAGED_IMPORT");
        assert.include(history, "TURN_3_user");
        return;
      }
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("select-native"),
        threadId,
        modelSelection: next,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue"),
        threadId,
        messageId: MessageId.make("message:continue"),
        text: "Continue with the decision",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const switched = yield* orchestrator.getThreadProjection(threadId);
      const handoff = switched.contextHandoffs.at(-1)!;
      assert.equal(handoff.deliveryMode, enabled ? "prompt" : undefined);
      if (enabled) {
        assert.include(handoff.summaryText, "Recent conversation excerpt only");
        assert.notInclude(handoff.summaryText, "TURN_1_");
      } else {
        assert.include(handoff.summaryText, "TURN_1_user");
      }
      assert.include(handoff.summaryText, "TURN_2_user");
      assert.include(handoff.summaryText, "TURN_3_assistant");
      assert.notInclude(handoff.summaryText, "Continue with the decision");
      assert.equal(switched.thread.modelSelection.instanceId, next.instanceId);
      assert.isUndefined(switched.providerThreads.at(-1)!.nativeMetadata?.seededHistory);

      // Exercise the SQL filter itself, not just the pure run selector.
      const bounded = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message", "assistant_message"],
        turnItemRunIds: [RunId.make("run:old:2"), RunId.make("run:old:3")],
        recentTurnItemLimit: 2,
      });
      assert.deepEqual(
        bounded.turnItems.map((item) => item.id),
        [TurnItemId.make("item:3:user"), TurnItemId.make("item:3:assistant")],
      );
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: `compact-switch-${target}-${enabled}` },
          ProviderAdapterRegistry.layerFromAdapters([adapter("opencode"), adapter(target)]),
          {
            runEffectWorker: false,
            ardudHarnessMigration: { transcript: { enabled, lastTurns: 2 } },
          },
        ),
      ),
    ),
);
