import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  ChatAttachmentId,
  ChatFileAttachment,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type AnalyticsEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ServerSettingsError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Logger from "effect/Logger";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as CredentialStore from "../ardud/mcp/CredentialStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderStartProgress from "../ardud/orchestration/ProviderStartProgress.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const driver = ProviderDriverKind.make("codex");

const layerTurnItemPositionsTest = Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
  allocate: () => Effect.succeed(1),
});

const layerRunExecutionTest = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layerEmpty,
      PreviewAgentActivity.layer,
      Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
      layerTurnItemPositionsTest,
      Layer.mock(EventSink.EventSinkV2)({}),
      IdAllocator.layer,
      Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
        ingestNormalized: () => Effect.succeed([]),
      }),
      ServerSettings.layerTest(),
    ),
  ),
);

it("keeps recoverable turn failures reusable and reserves error for broken threads", () => {
  assert.equal(RunExecutionService.finalProviderThreadStatus("reusable"), "idle");
  assert.equal(RunExecutionService.finalProviderThreadStatus("broken"), "error");
});

it.effect("routes shared-runtime events only to their owning root run", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const first: RunExecutionService.ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:first"),
      runId: RunId.make("run:shared-runtime:first"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:first"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:first"),
    };
    const second: RunExecutionService.ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:second"),
      runId: RunId.make("run:shared-runtime:second"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:second"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:second"),
    };
    const firstTurnId = ProviderTurnId.make("provider-turn:shared-runtime:first");
    const turnEvent: ProviderAdapter.ProviderAdapterV2Event = {
      type: "provider_turn.updated",
      driver,
      threadId: first.threadId,
      providerTurn: {
        id: firstTurnId,
        providerThreadId: first.providerThreadId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        runAttemptId: first.attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    };
    const messageEvent: ProviderAdapter.ProviderAdapterV2Event = {
      type: "message.updated",
      driver,
      message: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make("message:shared-runtime:first"),
        threadId: first.threadId,
        runId: first.runId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        role: "assistant",
        text: "first only",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    };
    const terminalEvent: ProviderAdapter.ProviderAdapterV2Event = {
      type: "turn.terminal",
      driver,
      providerThreadId: first.providerThreadId,
      providerTurnId: firstTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    };

    const firstInitial = RunExecutionService.makeProviderEventRoutingState({
      identity: first,
      providerTurnId: null,
    });
    const secondInitial = RunExecutionService.makeProviderEventRoutingState({
      identity: second,
      providerTurnId: null,
    });
    const [firstTurnAccepted, firstAfterTurn] = RunExecutionService.routeProviderEvent(
      turnEvent,
      first,
      firstInitial,
    );
    const [secondTurnAccepted, secondAfterTurn] = RunExecutionService.routeProviderEvent(
      turnEvent,
      second,
      secondInitial,
    );

    assert.isTrue(firstTurnAccepted);
    assert.isFalse(secondTurnAccepted);
    assert.isTrue(RunExecutionService.routeProviderEvent(messageEvent, first, firstAfterTurn)[0]);
    assert.isFalse(
      RunExecutionService.routeProviderEvent(messageEvent, second, secondAfterTurn)[0],
    );
    assert.isTrue(RunExecutionService.routeProviderEvent(terminalEvent, first, firstAfterTurn)[0]);
    assert.isFalse(
      RunExecutionService.routeProviderEvent(terminalEvent, second, secondAfterTurn)[0],
    );
  }),
);

it("routes only enrolled workflow members after the root turn ends", () => {
  const threadId = ThreadId.make("thread:late-child");
  const rootProviderTurnId = ProviderTurnId.make("provider-turn:late-child");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:late-child"),
    attemptId: RunAttemptId.make("attempt:late-child"),
    providerThreadId: ProviderThreadId.make("provider-thread:late-child"),
  };
  const childCreated = (
    childThreadId: ThreadId,
    parentThreadId = threadId,
  ): ProviderAdapter.ProviderAdapterV2Event =>
    ({
      type: "app_thread.created",
      driver,
      appThread: {
        id: childThreadId,
        lineage: {
          parentThreadId,
          relationshipToParent: "subagent",
          rootThreadId: threadId,
        },
      },
    }) as ProviderAdapter.ProviderAdapterV2Event;
  const earlyChild = ThreadId.make("thread:late-child:early");
  const lateChild = ThreadId.make("thread:late-child:late");

  const initial = RunExecutionService.makeProviderEventRoutingState({
    identity,
    providerTurnId: rootProviderTurnId,
  });
  const [earlyAccepted, live] = RunExecutionService.routeProviderEvent(
    childCreated(earlyChild),
    identity,
    initial,
  );
  assert.isTrue(earlyAccepted);
  const existingDescendant = ThreadId.make("thread:late-child:existing-descendant");
  const [descendantAccepted, withDescendant] = RunExecutionService.routeProviderEvent(
    childCreated(existingDescendant, earlyChild),
    identity,
    live,
  );
  assert.isTrue(descendantAccepted);
  const [terminalAccepted, ended] = RunExecutionService.routeProviderEvent(
    {
      type: "turn.terminal",
      driver,
      providerThreadId: identity.providerThreadId,
      providerTurnId: rootProviderTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    },
    identity,
    withDescendant,
  );
  assert.isTrue(terminalAccepted);
  assert.isTrue(ended.ownedThreadIds.has(earlyChild));
  const [lateAccepted, afterLate] = RunExecutionService.routeProviderEvent(
    childCreated(lateChild),
    identity,
    ended,
  );
  assert.isFalse(lateAccepted);
  assert.isFalse(afterLate.ownedThreadIds.has(lateChild));

  const memberId = ThreadId.make("thread:late-child:workflow-member");
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childCreated(memberId, earlyChild), identity, ended)[0],
  );
  const coordinator: OrchestrationV2Subagent = {
    id: NodeId.make("node:late-child:workflow"),
    threadId,
    runId: identity.runId,
    parentNodeId: NodeId.make("node:late-child"),
    origin: "provider_native",
    createdBy: "agent",
    driver,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: earlyChild,
    nativeTaskRef: null,
    prompt: "Review the code",
    title: "Review",
    model: null,
    status: "running",
    result: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
    workflow: {
      phases: [],
      agents: [{ index: 0, label: "Reviewer", state: "running", childThreadId: memberId }],
    },
  };
  const [foreignAccepted, afterForeign] = RunExecutionService.routeProviderEvent(
    {
      type: "subagent.updated",
      driver,
      subagent: {
        ...coordinator,
        threadId: earlyChild,
        childThreadId: existingDescendant,
        runId: RunId.make("run:late-child:new"),
      },
    },
    identity,
    ended,
  );
  assert.isTrue(foreignAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(
      childCreated(memberId, existingDescendant),
      identity,
      afterForeign,
    )[0],
  );
  const [workflowAccepted, afterWorkflow] = RunExecutionService.routeProviderEvent(
    { type: "subagent.updated", driver, subagent: coordinator },
    identity,
    ended,
  );
  assert.isTrue(workflowAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childCreated(memberId), identity, afterWorkflow)[0],
  );
  const [memberAccepted, afterMember] = RunExecutionService.routeProviderEvent(
    childCreated(memberId, earlyChild),
    identity,
    afterWorkflow,
  );
  assert.isTrue(memberAccepted);
  assert.isTrue(afterMember.ownedThreadIds.has(memberId));
  const [unrelatedAccepted] = RunExecutionService.routeProviderEvent(
    childCreated(ThreadId.make("thread:late-child:unrelated-member"), lateChild),
    identity,
    ended,
  );
  assert.isFalse(unrelatedAccepted);
  const [unrelatedDescendantAccepted, afterUnrelatedDescendant] =
    RunExecutionService.routeProviderEvent(
      childCreated(ThreadId.make("thread:late-child:unrelated-descendant"), earlyChild),
      identity,
      afterWorkflow,
    );
  assert.isFalse(unrelatedDescendantAccepted);
  assert.isFalse(
    afterUnrelatedDescendant.ownedThreadIds.has(
      ThreadId.make("thread:late-child:unrelated-descendant"),
    ),
  );
});

it("moves a child thread to the run that shows its subagent now", () => {
  const threadId = ThreadId.make("thread:handoff");
  const rootProviderTurnId = ProviderTurnId.make("provider-turn:handoff");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:handoff:1"),
    attemptId: RunAttemptId.make("attempt:handoff:1"),
    providerThreadId: ProviderThreadId.make("provider-thread:handoff"),
  };
  const resumedChild = ThreadId.make("thread:handoff:resumed");
  const siblingChild = ThreadId.make("thread:handoff:sibling");
  const providerThreadOf = (childThreadId: ThreadId) =>
    ProviderThreadId.make(`provider-thread:${childThreadId}`);
  const subagent = (childThreadId: ThreadId, runId: RunId): OrchestrationV2Subagent => ({
    id: NodeId.make(`node:${childThreadId}`),
    threadId,
    runId,
    parentNodeId: NodeId.make("node:handoff"),
    origin: "provider_native",
    createdBy: "agent",
    driver,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: providerThreadOf(childThreadId),
    childThreadId,
    nativeTaskRef: null,
    prompt: "Work",
    title: "Work",
    model: null,
    status: "running",
    result: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
  });
  const childMessage = (childThreadId: ThreadId) =>
    ({
      type: "message.updated",
      driver,
      message: {
        id: MessageId.make(`message:${childThreadId}`),
        threadId: childThreadId,
        runId: null,
      },
    }) as ProviderAdapter.ProviderAdapterV2Event;
  const childTurn = (childThreadId: ThreadId, ordinal: number) =>
    ({
      type: "provider_turn.updated",
      driver,
      providerTurn: {
        id: ProviderTurnId.make(`provider-turn:${childThreadId}:${ordinal}`),
        providerThreadId: providerThreadOf(childThreadId),
        runAttemptId: null,
        status: "running",
      },
    }) as ProviderAdapter.ProviderAdapterV2Event;
  const ended = RunExecutionService.routeProviderEvent(
    {
      type: "turn.terminal",
      driver,
      providerThreadId: identity.providerThreadId,
      providerTurnId: rootProviderTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    },
    identity,
    RunExecutionService.makeProviderEventRoutingState({
      identity,
      providerTurnId: rootProviderTurnId,
      relatedThreadIds: [resumedChild, siblingChild],
      relatedProviderThreadIds: [providerThreadOf(resumedChild), providerThreadOf(siblingChild)],
    }),
  )[1];
  const [firstTurnAccepted, withChildTurn] = RunExecutionService.routeProviderEvent(
    childTurn(resumedChild, 1),
    identity,
    ended,
  );
  assert.isTrue(firstTurnAccepted);
  const [movedAccepted, afterMove] = RunExecutionService.routeProviderEvent(
    {
      type: "subagent.updated",
      driver,
      subagent: subagent(resumedChild, RunId.make("run:handoff:2")),
    },
    identity,
    withChildTurn,
  );
  assert.isFalse(movedAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childMessage(resumedChild), identity, afterMove)[0],
  );
  assert.isTrue(
    RunExecutionService.routeProviderEvent(childMessage(siblingChild), identity, afterMove)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childTurn(resumedChild, 1), identity, afterMove)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childTurn(resumedChild, 2), identity, afterMove)[0],
  );
  assert.isTrue(
    RunExecutionService.routeProviderEvent(childTurn(siblingChild, 1), identity, afterMove)[0],
  );
  assert.isTrue(
    RunExecutionService.routeProviderEvent(
      { type: "subagent.updated", driver, subagent: subagent(siblingChild, identity.runId) },
      identity,
      afterMove,
    )[0],
  );
  const resuming: RunExecutionService.ProviderEventRouteIdentity = {
    ...identity,
    runId: RunId.make("run:handoff:2"),
    attemptId: RunAttemptId.make("attempt:handoff:2"),
  };
  const resumingState = RunExecutionService.makeProviderEventRoutingState({
    identity: resuming,
    providerTurnId: ProviderTurnId.make("provider-turn:handoff:2"),
  });
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childMessage(resumedChild), resuming, resumingState)[0],
  );
  const [moveAccepted, afterTake] = RunExecutionService.routeProviderEvent(
    { type: "subagent.updated", driver, subagent: subagent(resumedChild, resuming.runId) },
    resuming,
    resumingState,
  );
  assert.isTrue(moveAccepted);
  assert.isTrue(
    RunExecutionService.routeProviderEvent(childMessage(resumedChild), resuming, afterTake)[0],
  );
});

it("does not route a superseded attempt through a reused provider thread", () => {
  const threadId = ThreadId.make("thread:shared-runtime:restart");
  const providerThreadId = ProviderThreadId.make("provider-thread:shared-runtime:restart");
  const oldAttempt: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:shared-runtime:restart"),
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:old"),
    providerThreadId,
  };
  const newAttempt: RunExecutionService.ProviderEventRouteIdentity = {
    ...oldAttempt,
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:new"),
  };
  const oldTurnEvent: ProviderAdapter.ProviderAdapterV2Event = {
    type: "provider_turn.updated",
    driver,
    threadId,
    providerTurn: {
      id: ProviderTurnId.make("provider-turn:shared-runtime:restart:old"),
      providerThreadId,
      nodeId: NodeId.make("node:shared-runtime:restart:old"),
      runAttemptId: oldAttempt.attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status: "interrupted",
      startedAt: null,
      completedAt: null,
    },
  };

  const newState = RunExecutionService.makeProviderEventRoutingState({
    identity: newAttempt,
    providerTurnId: null,
  });
  assert.isFalse(RunExecutionService.routeProviderEvent(oldTurnEvent, newAttempt, newState)[0]);
});

it("routes only exact same-thread background items inherited from settled runs", () => {
  const threadId = ThreadId.make("thread:inherited-background-routing");
  const otherThreadId = ThreadId.make("thread:inherited-background-routing:other");
  const priorRunId = RunId.make("run:inherited-background-routing:prior");
  const currentRunId = RunId.make("run:inherited-background-routing:current");
  const itemId = TurnItemId.make("turn-item:inherited-background-routing");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: currentRunId,
    attemptId: RunAttemptId.make("attempt:inherited-background-routing:current"),
    providerThreadId: ProviderThreadId.make("provider-thread:inherited-background-routing:current"),
  };
  const initial = RunExecutionService.makeProviderEventRoutingState({
    identity,
    inheritedBackgroundTurnItems: [{ id: itemId, runId: priorRunId }],
    providerTurnId: null,
  });
  const inheritedRunning = {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: itemId,
      threadId,
      runId: priorRunId,
      providerTurnId: null,
      ordinal: 1,
      type: "subagent",
      status: "running",
    },
  } as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>;
  const unrelatedRunItem = {
    ...inheritedRunning,
    turnItem: {
      ...inheritedRunning.turnItem,
      runId: RunId.make("run:inherited-background-routing:unrelated"),
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
  const unlistedPriorItem = {
    ...inheritedRunning,
    turnItem: {
      ...inheritedRunning.turnItem,
      id: TurnItemId.make("turn-item:inherited-background-routing:unrelated"),
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
  const unrelatedThreadItem = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, threadId: otherThreadId },
  } as ProviderAdapter.ProviderAdapterV2Event;
  const ordinaryItem = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, type: "reasoning" as const },
  } as ProviderAdapter.ProviderAdapterV2Event;
  const inheritedTerminal = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, status: "completed" as const },
  } as ProviderAdapter.ProviderAdapterV2Event;

  const [runningAccepted, afterRunning] = RunExecutionService.routeProviderEvent(
    inheritedRunning,
    identity,
    initial,
  );
  assert.isTrue(runningAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unrelatedRunItem, identity, afterRunning)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unlistedPriorItem, identity, afterRunning)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unrelatedThreadItem, identity, afterRunning)[0],
  );
  assert.isFalse(RunExecutionService.routeProviderEvent(ordinaryItem, identity, afterRunning)[0]);

  const [terminalAccepted, afterTerminal] = RunExecutionService.routeProviderEvent(
    inheritedTerminal,
    identity,
    afterRunning,
  );
  assert.isTrue(terminalAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(inheritedRunning, identity, afterTerminal)[0],
    "a nonterminal replay must not resurrect an inherited terminal",
  );
});

it("selects only live background items from non-completed settled prior runs", () => {
  const threadId = ThreadId.make("thread:inherited-background-selection");
  const otherThreadId = ThreadId.make("thread:inherited-background-selection:other");
  const currentProviderThreadId = ProviderThreadId.make(
    "provider-thread:inherited-background-selection:current",
  );
  const foreignProviderThreadId = ProviderThreadId.make(
    "provider-thread:inherited-background-selection:foreign-session",
  );
  const interruptedRunId = RunId.make("run:inherited-background-selection:interrupted");
  const failedRunId = RunId.make("run:inherited-background-selection:failed");
  const cancelledRunId = RunId.make("run:inherited-background-selection:cancelled");
  const completedRunId = RunId.make("run:inherited-background-selection:completed");
  const rolledBackRunId = RunId.make("run:inherited-background-selection:rolled-back");
  const currentRunId = RunId.make("run:inherited-background-selection:current");
  const inheritedItemId = TurnItemId.make("turn-item:inherited-background-selection:live");
  const failedItemId = TurnItemId.make("turn-item:inherited-background-selection:failed");
  const cancelledItemId = TurnItemId.make("turn-item:inherited-background-selection:cancelled");
  const makeRun = (
    id: RunId,
    ordinal: number,
    status: OrchestrationV2Run["status"],
    runThreadId = threadId,
  ) =>
    ({
      id,
      threadId: runThreadId,
      ordinal,
      status,
    }) as OrchestrationV2Run;
  const makeItem = (
    id: TurnItemId,
    runId: RunId,
    status: OrchestrationV2TurnItem["status"],
    type: OrchestrationV2TurnItem["type"] = "subagent",
    itemThreadId = threadId,
    providerThreadId = currentProviderThreadId,
  ) =>
    ({
      id,
      threadId: itemThreadId,
      runId,
      providerThreadId,
      type,
      status,
    }) as OrchestrationV2TurnItem;

  const selected = RunExecutionService.selectInheritedBackgroundTurnItems({
    threadId,
    currentProviderThreadId,
    currentRunOrdinal: 6,
    runs: [
      makeRun(interruptedRunId, 1, "interrupted"),
      makeRun(failedRunId, 2, "failed"),
      makeRun(cancelledRunId, 3, "cancelled"),
      makeRun(completedRunId, 4, "completed"),
      makeRun(rolledBackRunId, 5, "rolled_back"),
      makeRun(currentRunId, 6, "running"),
      makeRun(
        RunId.make("run:inherited-background-selection:other"),
        1,
        "interrupted",
        otherThreadId,
      ),
    ],
    turnItems: [
      makeItem(inheritedItemId, interruptedRunId, "running"),
      makeItem(failedItemId, failedRunId, "running"),
      makeItem(cancelledItemId, cancelledRunId, "running"),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:completed-run"),
        completedRunId,
        "running",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:terminal"),
        interruptedRunId,
        "completed",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:ordinary"),
        interruptedRunId,
        "running",
        "reasoning",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:rolled-back"),
        rolledBackRunId,
        "running",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:other-thread"),
        interruptedRunId,
        "running",
        "subagent",
        otherThreadId,
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:foreign-provider"),
        interruptedRunId,
        "running",
        "subagent",
        threadId,
        foreignProviderThreadId,
      ),
    ],
  });

  assert.deepEqual(selected, [
    { id: inheritedItemId, runId: interruptedRunId },
    { id: failedItemId, runId: failedRunId },
    { id: cancelledItemId, runId: cancelledRunId },
  ]);
});

it("does not carry interrupted or still-running child ownership into later attempts", () => {
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("interrupted"));
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("failed"));
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("cancelled"));
  assert.isTrue(RunExecutionService.canRouteRelatedSubagent("completed"));
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("running"));

  const threadId = ThreadId.make("thread:related-child:next-attempt");
  const childThreadId = ThreadId.make("thread:related-child:interrupted");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:related-child:next-attempt"),
    attemptId: RunAttemptId.make("attempt:related-child:next-attempt"),
    providerThreadId: ProviderThreadId.make("provider-thread:related-child:next-attempt"),
  };
  const state = RunExecutionService.makeProviderEventRoutingState({
    identity,
    providerTurnId: null,
    relatedThreadIds: RunExecutionService.canRouteRelatedSubagent("interrupted")
      ? [childThreadId]
      : [],
  });
  const childNodeId = NodeId.make("node:related-child:interrupted");
  const lateChildNode = {
    type: "node.updated",
    driver,
    node: {
      id: childNodeId,
      threadId: childThreadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: childNodeId,
      kind: "root_turn",
      status: "completed",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: null,
      completedAt: null,
    },
  } satisfies ProviderAdapter.ProviderAdapterV2Event;

  assert.isFalse(RunExecutionService.routeProviderEvent(lateChildNode, identity, state)[0]);
});

it.effect("rechecks run ownership immediately before calling the provider", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const threadId = ThreadId.make("thread:run-execution-start-guard");
    const runId = RunId.make("run:run-execution-start-guard");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-start-guard");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-start-guard");
    const rootNodeId = NodeId.make("node:run-execution-start-guard");
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
    } as OrchestrationV2Run;
    const rootNode = { id: rootNodeId } as OrchestrationV2ExecutionNode;
    const providerThread = {
      id: providerThreadId,
      driver,
    } as OrchestrationV2ProviderThread;
    const attempt = {
      id: attemptId,
      providerTurnId: null,
    } as OrchestrationV2RunAttempt;
    const session = {
      events: Stream.never,
      startTurn: () => Ref.update(providerStarts, (count) => count + 1),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;

    yield* runExecution.startRootRun({
      commandId: CommandId.make("command:run-execution-start-guard"),
      appThread: { id: threadId } as OrchestrationV2AppThread,
      providerSessionId,
      session,
      run,
      rootNode,
      checkpointScope: {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard"),
      } as OrchestrationV2CheckpointScope,
      providerThread,
      attempt,
      attemptId,
      providerTurnOrdinal: 1,
      shouldStartProviderTurn: () =>
        Ref.modify(guardCalls, (calls) => [calls === 0, calls + 1] as const),
      message: {
        messageId: MessageId.make("message:run-execution-start-guard"),
        text: "Do not start after ownership changes.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    });

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
  }).pipe(Effect.provide(layerRunExecutionTest)),
);

it.effect("passes the thread's MCP app context to the provider under a safe key", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const started = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2TurnInput>();
    const threadId = ThreadId.make("thread:run-execution-app-context");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const attemptId = RunAttemptId.make("attempt:run-execution-app-context");
    const session = {
      events: Stream.never,
      startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        Deferred.succeed(started, input),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;

    yield* runExecution.startRootRun({
      commandId: CommandId.make("command:run-execution-app-context"),
      appThread: { id: threadId } as OrchestrationV2AppThread,
      providerSessionId: ProviderSessionId.make("session:run-execution-app-context"),
      session,
      run: {
        id: RunId.make("run:run-execution-app-context"),
        threadId,
        ordinal: 1,
        providerInstanceId,
      } as OrchestrationV2Run,
      rootNode: {
        id: NodeId.make("node:run-execution-app-context"),
      } as OrchestrationV2ExecutionNode,
      checkpointScope: {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-app-context"),
      } as OrchestrationV2CheckpointScope,
      providerThread: {
        id: ProviderThreadId.make("provider-thread:run-execution-app-context"),
        driver,
      } as OrchestrationV2ProviderThread,
      attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
      attemptId,
      providerTurnOrdinal: 1,
      message: {
        messageId: MessageId.make("message:run-execution-app-context"),
        text: "What is on my list?",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: process.cwd() },
    });

    const input = yield* Deferred.await(started);
    assert.deepEqual(input.appContext, [
      { key: "mcp_app_turn-item_provider_codex_native-item_call-1", text: "2 overdue" },
    ]);
  }).pipe(
    Effect.provide(
      RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            PreviewAgentActivity.layer,
            Layer.mock(McpAppModelContext.McpAppModelContext)({
              forThread: () =>
                Effect.succeed([
                  {
                    itemId: "turn-item:provider:codex:native-item:call-1",
                    server: "my tools>",
                    tool: "list",
                    text: "2 overdue",
                  },
                ]),
            }),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({}),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      ),
    ),
  ),
);

it.effect("fails the run when its ownership check cannot be read before calling the provider", () =>
  Effect.gen(function* () {
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const writes = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const threadId = ThreadId.make("thread:run-execution-start-guard-read");
    const runId = RunId.make("run:run-execution-start-guard-read");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard-read");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            writeIfRunCurrent: (input) =>
              Ref.update(writes, (current) => [...current, ...input.events]).pipe(
                Effect.as({ committed: true, storedEvents: [] }),
              ),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-start-guard-read"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make("session:run-execution-start-guard-read"),
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(providerStarts, (count) => count + 1),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: { id: runId, threadId, ordinal: 1, providerInstanceId } as OrchestrationV2Run,
        rootNode: {
          id: NodeId.make("node:run-execution-start-guard-read"),
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard-read"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ProviderThreadId.make("provider-thread:run-execution-start-guard-read"),
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        shouldStartProviderTurn: () =>
          Ref.getAndUpdate(guardCalls, (calls) => calls + 1).pipe(
            Effect.flatMap((calls) =>
              calls === 0
                ? Effect.succeed(true)
                : Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId,
                      cause: "database unavailable",
                    }),
                  ),
            ),
          ),
        shouldFinalizeRun: () =>
          Effect.fail(
            new ProjectionStore.ProjectionStoreReadError({
              threadId,
              cause: "database unavailable",
            }),
          ),
        message: {
          messageId: MessageId.make("message:run-execution-start-guard-read"),
          text: "Start while the store is down.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(layerTest));

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
    const runUpdate = (yield* Ref.get(writes)).find((event) => event.type === "run.updated");
    assert.equal(
      runUpdate?.type === "run.updated" ? runUpdate.payload.status : undefined,
      "failed",
    );
  }),
);

it.effect(
  "dispatches only attachment-free compact commands through the native compaction path",
  () =>
    Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      const calls: Array<string> = [];
      const attachment = ChatFileAttachment.make({
        type: "file",
        id: ChatAttachmentId.make("compact-file-12345678-1234-1234-1234-123456789abc"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
      });
      const cases = [
        { text: " /compact ", attachments: [], expected: "compact" },
        { text: "/compact", attachments: [attachment], expected: "prompt" },
        { text: "Continue the work", attachments: [], expected: "prompt" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const threadId = ThreadId.make(`thread:compact-routing:${index}`);
        const attemptId = RunAttemptId.make(`attempt:compact-routing:${index}`);
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:compact-routing:${index}`),
          appThread: { id: threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:compact-routing:${index}`),
          session: {
            events: Stream.never,
            startTurn: () =>
              Effect.sync(() => {
                calls.push("prompt");
              }),
            compactThread: () =>
              Effect.sync(() => {
                calls.push("compact");
              }),
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: RunId.make(`run:compact-routing:${index}`),
            threadId,
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
          } as OrchestrationV2Run,
          rootNode: {
            id: NodeId.make(`node:compact-routing:${index}`),
          } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint:compact-routing:${index}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ProviderThreadId.make(`provider-thread:compact-routing:${index}`),
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
          attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:compact-routing:${index}`),
            text: testCase.text,
            attachments: testCase.attachments,
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }
      assert.deepEqual(
        calls,
        cases.map((testCase) => testCase.expected),
      );
    }).pipe(Effect.provide(layerRunExecutionTest)),
);

const layerMcpSessionRegistryTest = McpSessionRegistry.layer.pipe(
  Layer.provide(CredentialStore.layer.pipe(Layer.provide(Sqlite.layerMemory))),
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:mcp-liveness")),
      }),
    ),
  ),
);

it.effect("refreshes MCP credential liveness before calling the provider", () =>
  Effect.gen(function* () {
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const key = "run-execution-mcp-liveness";
    const touchActiveMcpThread = vi
      .spyOn(McpSessionRegistry, "touchActiveMcpThread")
      .mockImplementation((threadId) =>
        Ref.update(order, (entries) => [...entries, `touch:${threadId}`]),
      );

    yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Effect.succeed(true),
      startTurn: () => Ref.update(order, (entries) => [...entries, "start-turn"]),
    }).pipe(Effect.ensuring(Effect.sync(() => touchActiveMcpThread.mockRestore())));

    assert.deepEqual(yield* Ref.get(order), [
      `touch:${backgroundScenarioIds(key).threadId}`,
      "start-turn",
    ]);
  }),
);

it.effect.each([
  ["keeps the MCP credential alive for a 44-hour turn without MCP traffic", false],
  ["expires the MCP credential at 44 hours when ingestion ended at 2 hours", true],
] as const)("%s", ([, endEarly]) =>
  Effect.gen(function* () {
    const key = `mcp-liveness:${endEarly}`;
    const { threadId } = backgroundScenarioIds(key);
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const started = yield* Deferred.make<void>();
    const end = yield* Deferred.make<void>();
    const run = yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Effect.succeed(true),
      startTurn: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
      events: (ids) =>
        Stream.fromEffect(Deferred.await(end)).pipe(
          Stream.map(() => rootTerminalEvent(ids, "completed")),
        ),
    }).pipe(Effect.forkChild);

    yield* Effect.gen(function* () {
      yield* Deferred.await(started);
      yield* TestClock.adjust("2 hours");
      if (endEarly) {
        yield* Deferred.succeed(end, undefined);
        yield* Fiber.join(run);
      }
      yield* TestClock.adjust("42 hours");
      assert.equal(
        (yield* registry.resolve(token))?.thread.threadId,
        endEarly ? undefined : threadId,
      );
    }).pipe(
      Effect.ensuring(
        Deferred.succeed(end, undefined).pipe(Effect.andThen(Fiber.join(run)), Effect.orDie),
      ),
    );
  }).pipe(Effect.provide(layerMcpSessionRegistryTest)),
);

it.effect(
  "does not renew an MCP credential after startup is interrupted during the app context read",
  () =>
    Effect.gen(function* () {
      const key = "mcp-liveness:abandoned-startup";
      const { threadId } = backgroundScenarioIds(key);
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const contextReadStarted = yield* Deferred.make<void>();
      const end = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const run = yield* captureRootRunTermination({
        key,
        shouldFinalizeRun: () => Effect.succeed(true),
        appContext: Deferred.succeed(contextReadStarted, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
        events: (ids) =>
          Stream.fromEffect(Deferred.await(end)).pipe(
            Stream.map(() => rootTerminalEvent(ids, "completed")),
          ),
        onSubscriptionClose: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
      }).pipe(Effect.interruptible, Effect.forkChild);

      yield* Effect.gen(function* () {
        yield* Deferred.await(contextReadStarted);
        yield* Fiber.interrupt(run);
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(run)));
        yield* TestClock.adjust("44 hours");
        assert.isUndefined(yield* registry.resolve(token));
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(end, undefined).pipe(Effect.andThen(Deferred.await(closed))),
        ),
      );
    }).pipe(Effect.provide(layerMcpSessionRegistryTest)),
);

it.effect("starts the provider when checkpoint baseline capture fails", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-baseline-failure");
    const runId = RunId.make("run:run-execution-baseline-failure");
    const attemptId = RunAttemptId.make("attempt:run-execution-baseline-failure");
    const providerThreadId = ProviderThreadId.make(
      "provider-thread:run-execution-baseline-failure",
    );
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-baseline-failure");
    const rootNodeId = NodeId.make("node:run-execution-baseline-failure");
    const checkpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:run-execution-baseline-failure"),
    } as OrchestrationV2CheckpointScope;
    const providerStarts = yield* Ref.make(0);
    const writes = yield* Ref.make<
      ReadonlyArray<{
        events: ReadonlyArray<OrchestrationV2DomainEvent>;
        effects: ReadonlyArray<PendingOrchestrationEffectV2>;
      }>
    >([]);
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            captureBaseline: () =>
              Effect.fail(
                new CheckpointService.CheckpointBaselineCaptureError({
                  scopeId: checkpointScope.id,
                  ordinalWithinScope: 0,
                  cause: new Error("VCS process timed out"),
                }),
              ),
          }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Ref.update(writes, (current) => [
                ...current,
                { events: input.events, effects: input.effects },
              ]).pipe(Effect.as([])),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-baseline-failure"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId,
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(providerStarts, (count) => count + 1),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope,
        providerThread: {
          id: providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: attemptId,
          providerTurnId: null,
        } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-baseline-failure"),
          text: "Start the provider without a baseline.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(layerTest));

    assert.equal(yield* Ref.get(providerStarts), 1);

    const events = (yield* Ref.get(writes)).flatMap((write) => [...write.events]);
    const failedEvent = events.find(
      (event) =>
        (event.type === "run.updated" ||
          event.type === "run-attempt.updated" ||
          event.type === "node.updated") &&
        event.payload.status === "failed",
    );
    assert.isUndefined(failedEvent);
    const errorItem = events.find(
      (event) => event.type === "turn-item.updated" && event.payload.type === "error",
    );
    assert.isUndefined(errorItem);
  }),
);

it.effect.each(["failure", "interruption", "stale-attempt", "start-guard"] as const)(
  "handles %s before the provider turn starts",
  (scenario) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:run-execution-settings-failure");
      const runId = RunId.make("run:run-execution-settings-failure");
      const attemptId = RunAttemptId.make("attempt:run-execution-settings-failure");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const providerSessionId = ProviderSessionId.make("session:run-execution-settings-failure");
      const providerThreadId = ProviderThreadId.make(
        "provider-thread:run-execution-settings-failure",
      );
      const rootNodeId = NodeId.make("node:run-execution-settings-failure");
      const checkpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-settings-failure"),
      } as OrchestrationV2CheckpointScope;
      const providerStarts = yield* Ref.make(0);
      const refreshes = yield* Ref.make(0);
      const guardedWrites = yield* Ref.make(0);
      const writes = yield* Ref.make<ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>>([]);
      const layerTest = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpAppModelContext.layerEmpty,
            PreviewAgentActivity.layer,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () =>
                scenario === "start-guard" ? Effect.void : Effect.die("not reached"),
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({
              writeIfRunCurrent: (input) =>
                Effect.gen(function* () {
                  assert.equal(input.threadId, threadId);
                  assert.equal(input.runId, runId);
                  assert.equal(input.activeAttemptId, attemptId);
                  assert.equal(input.expectedStatus, "running");
                  yield* Ref.update(guardedWrites, (count) => count + 1);
                  if (scenario === "stale-attempt") {
                    return { committed: false, storedEvents: [] };
                  }
                  yield* Ref.update(writes, (current) => [...current, input.events]);
                  return { committed: true, storedEvents: [] };
                }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            scenario === "start-guard"
              ? ServerSettings.layerTest()
              : Layer.mock(ServerSettings.ServerSettingsService)({
                  getSettings:
                    scenario === "interruption"
                      ? Effect.interrupt
                      : Effect.fail(
                          new ServerSettingsError({
                            settingsPath: "<test>",
                            operation: "read-file",
                            cause: new Error("settings read failed"),
                          }),
                        ),
                }),
            Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
              refresh: () => Effect.void,
              refreshAfterTurn: () => Ref.update(refreshes, (count) => count + 1),
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:run-execution-settings-failure"),
          appThread: { id: threadId } as OrchestrationV2AppThread,
          providerSessionId,
          session: {
            events: Stream.never,
            startTurn: () => Ref.update(providerStarts, (count) => count + 1),
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            status: "running",
          } as OrchestrationV2Run,
          rootNode: { id: rootNodeId, status: "running" } as OrchestrationV2ExecutionNode,
          checkpointScope,
          providerThread: {
            id: providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: attemptId,
            providerTurnId: null,
            status: "running",
          } as OrchestrationV2RunAttempt,
          attemptId,
          providerTurnOrdinal: 1,
          ...(scenario === "start-guard"
            ? { shouldStartProviderTurn: () => Effect.succeed(false) }
            : {}),
          message: {
            messageId: MessageId.make("message:run-execution-settings-failure"),
            text: "Start after settings fail.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(layerTest), Effect.exit);

      assert.equal(yield* Ref.get(providerStarts), 0);
      const events = (yield* Ref.get(writes)).flat();
      if (scenario === "interruption") {
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterruptsOnly(result.cause));
        assert.equal(yield* Ref.get(guardedWrites), 0);
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.isTrue(Exit.isSuccess(result));
      if (scenario === "start-guard") {
        assert.equal(yield* Ref.get(guardedWrites), 0);
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.equal(yield* Ref.get(guardedWrites), 1);
      if (scenario === "stale-attempt") {
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.equal(yield* Ref.get(refreshes), 1);
      assert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "run.updated" ||
              event.type === "run-attempt.updated" ||
              event.type === "node.updated",
          )
          .map((event) => event.payload.status),
        ["failed", "failed", "failed"],
      );
      const errorItem = events.find(
        (event) => event.type === "turn-item.updated" && event.payload.type === "error",
      );
      assert.isDefined(errorItem);
      if (errorItem?.type === "turn-item.updated" && errorItem.payload.type === "error") {
        assert.equal(errorItem.payload.failure.message, "Run preparation failed.");
      }
    }),
);

it.effect("ingests new member threads of an owned child after the root turn terminalizes", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-late-child");
    const childThreadId = ThreadId.make("thread:run-execution-late-child:child");
    const memberThreadId = ThreadId.make("thread:run-execution-late-child:member");
    const runId = RunId.make("run:run-execution-late-child");
    const attemptId = RunAttemptId.make("attempt:run-execution-late-child");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-late-child");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-late-child");
    const childProviderThreadId = ProviderThreadId.make(
      "provider-thread:run-execution-late-child:child",
    );
    const rootProviderTurnId = ProviderTurnId.make("provider-turn:run-execution-late-child");
    const childProviderTurnId = ProviderTurnId.make("provider-turn:run-execution-late-child:child");
    const rootNodeId = NodeId.make("node:run-execution-late-child");
    const childNodeId = NodeId.make("node:run-execution-late-child:child");
    const subagentNodeId = NodeId.make("node:run-execution-late-child:subagent");
    const childMessageIngested = yield* Deferred.make<void>();
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === runId,
                  )
                ) {
                  yield* Ref.update(order, (current) => [...current, "root-finalized"]);
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                if (
                  input.event.type === "app_thread.created" &&
                  input.event.appThread.id === memberThreadId
                ) {
                  yield* Ref.update(order, (current) => [...current, "member-thread"]);
                }
                if (
                  input.event.type === "message.updated" &&
                  input.event.message.threadId === memberThreadId
                ) {
                  yield* Ref.update(order, (current) => [...current, "child-message"]);
                  yield* Deferred.succeed(childMessageIngested, undefined).pipe(Effect.ignore);
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
      {
        type: "app_thread.created",
        driver,
        appThread: {
          id: childThreadId,
          lineage: {
            parentThreadId: threadId,
            relationshipToParent: "subagent",
            rootThreadId: threadId,
          },
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "provider_thread.updated",
        driver,
        providerThread: {
          id: childProviderThreadId,
          appThreadId: childThreadId,
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          ...makeRunOwnedSubagentFixture({
            ids: backgroundScenarioIds("run-execution-late-child"),
            providerInstanceId,
            childThreadId,
            driver,
            status: "running",
          }),
          workflow: {
            phases: [],
            agents: [
              { index: 0, label: "Reviewer", state: "running", childThreadId: memberThreadId },
            ],
          },
        },
      },
      {
        type: "provider_turn.updated",
        driver,
        threadId: childThreadId,
        providerTurn: {
          id: childProviderTurnId,
          providerThreadId: childProviderThreadId,
          nodeId: childNodeId,
          runAttemptId: null,
          status: "running",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "turn.terminal",
        driver,
        providerThreadId,
        providerTurnId: rootProviderTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      },
      {
        type: "app_thread.created",
        driver,
        appThread: {
          id: memberThreadId,
          lineage: {
            parentThreadId: childThreadId,
            relationshipToParent: "subagent",
            rootThreadId: threadId,
          },
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "message.updated",
        driver,
        message: {
          id: MessageId.make("message:run-execution-late-child:child"),
          threadId: memberThreadId,
          runId: null,
          nodeId: childNodeId,
          role: "assistant",
          text: "Hello.",
          streaming: false,
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "provider_turn.updated",
        driver,
        threadId: childThreadId,
        providerTurn: {
          id: childProviderTurnId,
          providerThreadId: childProviderThreadId,
          nodeId: childNodeId,
          runAttemptId: null,
          status: "completed",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: subagentNodeId,
          threadId,
          runId,
          status: "completed",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
    ];

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-late-child"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId,
        session: {
          events: Stream.fromIterable(events),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-late-child"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: attemptId,
          providerTurnId: rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-late-child:user"),
          text: "Spawn a child and finish.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(layerTest));

    const observed = yield* Deferred.await(childMessageIngested).pipe(
      Effect.timeoutOption("2 seconds"),
    );
    assert.isTrue(Option.isSome(observed), "child message was not ingested after root terminal");
    assert.deepEqual(yield* Ref.get(order), ["root-finalized", "member-thread", "child-message"]);
  }),
);

it.effect("ends a nested native subagent and its thread when the root run is interrupted", () =>
  Effect.gen(function* () {
    const key = "run-execution-nested-native";
    const threadId = ThreadId.make(`thread:${key}`);
    const childThreadId = ThreadId.make(`thread:${key}:child`);
    const grandchildThreadId = ThreadId.make(`thread:${key}:grandchild`);
    const runId = RunId.make(`run:${key}`);
    const attemptId = RunAttemptId.make(`attempt:${key}`);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerThreadId = ProviderThreadId.make(`provider-thread:${key}`);
    const rootProviderTurnId = ProviderTurnId.make(`provider-turn:${key}`);
    const nestedId = NodeId.make(`node:${key}:nested`);
    const grandchildRootId = NodeId.make(`node:${key}:grandchild-root`);
    const finalized = yield* Deferred.make<ReadonlyArray<OrchestrationV2DomainEvent>>();
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.as(
                input.events.some((event) => event.type === "run.updated")
                  ? Deferred.succeed(finalized, input.events)
                  : Effect.void,
                [],
              ),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const subagentThread = (id: ThreadId, parentThreadId: ThreadId) =>
      ({
        type: "app_thread.created",
        driver,
        appThread: {
          id,
          lineage: { parentThreadId, relationshipToParent: "subagent", rootThreadId: threadId },
        },
      }) as ProviderAdapter.ProviderAdapterV2Event;
    const events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
      subagentThread(childThreadId, threadId),
      subagentThread(grandchildThreadId, childThreadId),
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: nestedId,
          threadId: childThreadId,
          runId: null,
          origin: "provider_native",
          childThreadId: grandchildThreadId,
          status: "running",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "node.updated",
        driver,
        node: {
          id: grandchildRootId,
          threadId: grandchildThreadId,
          runId: null,
          kind: "root_turn",
          status: "running",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "turn.terminal",
        driver,
        providerThreadId,
        providerTurnId: rootProviderTurnId,
        runOrdinal: 1,
        status: "interrupted",
        failure: null,
        threadDisposition: "reusable",
      },
    ];

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          events: Stream.fromIterable(events),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: { id: runId, threadId, ordinal: 1, providerInstanceId } as OrchestrationV2Run,
        rootNode: { id: NodeId.make(`node:${key}`) } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: { id: providerThreadId, driver } as OrchestrationV2ProviderThread,
        attempt: { id: attemptId, providerTurnId: rootProviderTurnId } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make(`message:${key}:user`),
          text: "Spawn a nested subagent.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
        },
      });
    }).pipe(Effect.provide(layerTest));

    const ended = (yield* Deferred.await(finalized)).flatMap((event) =>
      event.type === "subagent.updated" || event.type === "node.updated"
        ? [[event.type, event.payload.id, event.payload.status]]
        : [],
    );
    assert.deepInclude(ended, ["subagent.updated", nestedId, "interrupted"]);
    assert.deepInclude(ended, ["node.updated", grandchildRootId, "interrupted"]);
  }),
);

it.effect("keeps ingesting a late background command item completion after root terminal", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-command", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      rootTerminalEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
    ]);
    assert.deepEqual(observed, ["turn_item:running", "root-finalized", "turn_item:completed"]);
  }),
);

it.effect("ingests the trailing subagent item completion after the subagent row completes", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("subagent-trailing-item", (ids) => [
      subagentEvent(ids, "running"),
      backgroundTurnItemEvent(ids, "subagent", "running", 1),
      rootTerminalEvent(ids, "completed"),
      subagentEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "subagent", "completed", 2),
    ]);
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "root-finalized",
      "subagent:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect.each(["completed", "interrupted"] as const)(
  "drains a queued %s child follow-up before accepting the adapter's live idle state",
  (status) =>
    Effect.gen(function* () {
      const followUps = yield* Ref.make<ReadonlyArray<string>>([]);
      const result = yield* captureRootRunTermination({
        key: `queued-follow-up:${status}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
        events: (ids) => {
          const pending = (
            pendingBackgroundWork: boolean,
          ): ProviderAdapter.ProviderAdapterV2Event => ({
            type: "provider_thread.updated",
            driver,
            providerThread: {
              id: ids.providerThreadId,
              pendingBackgroundWork,
            } as OrchestrationV2ProviderThread,
          });
          const childTurn = (
            status: "running" | "completed" | "interrupted",
          ): ProviderAdapter.ProviderAdapterV2Event => ({
            type: "provider_turn.updated",
            driver,
            threadId: ids.childThreadId,
            providerTurn: {
              id: ProviderTurnId.make(`${ids.childThreadId}:follow-up`),
              providerThreadId: ProviderThreadId.make(`${ids.childThreadId}:provider`),
              runAttemptId: null,
              status,
            } as OrchestrationV2ProviderTurn,
          });
          return Stream.make(
            pending(true),
            childThreadCreatedEvent(ids),
            rootTerminalEvent(ids, "completed"),
            childTurn("running"),
            {
              type: "message.updated",
              driver,
              message: {
                id: MessageId.make(`${ids.childThreadId}:follow-up`),
                threadId: ids.childThreadId,
                runId: null,
                role: "assistant",
                text: status === "completed" ? "GRANDCHILD_OK" : "Grandchild interrupted",
                streaming: false,
              },
            } as ProviderAdapter.ProviderAdapterV2Event,
            childTurn(status),
            pending(false),
          );
        },
        ingestNormalized: ({ event, threadId, providerInstanceId }) =>
          Effect.gen(function* () {
            if (event.type === "message.updated") {
              yield* Ref.update(followUps, (texts) => [...texts, event.message.text]);
            }
            yield* Effect.yieldNow;
            if (event.type === "provider_thread.updated") {
              return [
                {
                  sequence: event.providerThread.pendingBackgroundWork ? 1 : 2,
                  commandId: null,
                  event: {
                    id: EventId.make(
                      `event:${event.providerThread.id}:${event.providerThread.pendingBackgroundWork}`,
                    ),
                    type: "provider-thread.updated",
                    threadId,
                    driver,
                    providerInstanceId,
                    occurredAt: yield* DateTime.now,
                    payload: event.providerThread,
                  },
                },
              ] satisfies ReadonlyArray<OrchestrationV2StoredEvent>;
            }
            return [];
          }),
      });
      assert.deepEqual(yield* Ref.get(followUps), [
        status === "completed" ? "GRANDCHILD_OK" : "Grandchild interrupted",
      ]);
      assert.deepEqual(result.observed, ["run:waiting", "pull-requests-refreshed"]);
    }),
);

it.effect("keeps ingesting a child thread's late background item completion", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-child-item", (ids) => [
      childThreadCreatedEvent(ids),
      subagentEvent(ids, "running"),
      childBackgroundTurnItemEvent(ids, "running", 1),
      rootTerminalEvent(ids, "completed"),
      subagentEvent(ids, "completed"),
      childBackgroundTurnItemEvent(ids, "completed", 2),
    ]);
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "root-finalized",
      "subagent:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect.each([null, "run:nested-sdk"] as const)(
  "releases a settled run when its live child transfers to another run (%s)",
  (nestedRunId) =>
    Effect.gen(function* () {
      const consumed = yield* Deferred.make<void>();
      const result = yield* Effect.raceFirst(
        runBackgroundItemScenario(
          "child-transfer-release",
          (ids) => {
            const running = subagentEvent(ids, "running");
            if (running.type !== "subagent.updated") throw new Error("Missing subagent");
            const linked = {
              ...running,
              subagent: {
                ...running.subagent,
                origin: "provider_native" as const,
                childThreadId: ids.childThreadId,
                providerThreadId: null,
              },
            };
            return [
              childThreadCreatedEvent(ids),
              linked,
              {
                ...linked,
                subagent: {
                  ...linked.subagent,
                  id: NodeId.make("node:child-transfer-release:nested"),
                  threadId: ids.childThreadId,
                  runId: nestedRunId === null ? null : RunId.make(nestedRunId),
                  childThreadId: null,
                },
              },
              childBackgroundTurnItemEvent(ids, "running", 1),
              rootTerminalEvent(ids, "completed"),
              { ...linked, subagent: { ...linked.subagent, runId: RunId.make("run:replacement") } },
            ];
          },
          {
            keepEventStreamOpen: true,
            onEventsConsumed: Deferred.succeed(consumed, undefined).pipe(Effect.asVoid),
          },
        ).pipe(Effect.map(Option.some)),
        Deferred.await(consumed).pipe(Effect.as(Option.none())),
      );
      assert.isTrue(
        Option.isSome(result),
        "the transferred child must release its prior subscription",
      );
      if (Option.isSome(result))
        assert.deepEqual(result.value, [
          "subagent:running",
          "subagent:running",
          "turn_item:running",
          "root-finalized",
        ]);
    }),
);

// The handover event is not this run's, yet it is what settles the run's agent turns.
it.effect(
  "ends preview activity when a transferred child settles a run kept open by background work",
  () =>
    Effect.gen(function* () {
      const active = yield* Deferred.make<boolean>();
      yield* runBackgroundItemScenario(
        "child-transfer-preview",
        (ids) => {
          const running = subagentEvent(ids, "running");
          if (running.type !== "subagent.updated") throw new Error("Missing subagent");
          const linked = {
            ...running,
            subagent: {
              ...running.subagent,
              origin: "provider_native" as const,
              childThreadId: ids.childThreadId,
              providerThreadId: null,
            },
          };
          return [
            childThreadCreatedEvent(ids),
            linked,
            backgroundTurnItemEvent(ids, "command_execution", "running", 1),
            rootTerminalEvent(ids, "completed"),
            { ...linked, subagent: { ...linked.subagent, runId: RunId.make("run:replacement") } },
          ];
        },
        {
          keepEventStreamOpen: true,
          afterEvents: (activity) =>
            activity
              .active(backgroundScenarioIds("child-transfer-preview").threadId)
              .pipe(Effect.flatMap((value) => Deferred.succeed(active, value))),
        },
      ).pipe(Effect.forkScoped);
      assert.isFalse(yield* Deferred.await(active));
    }).pipe(Effect.scoped),
);

it.effect("keeps ingesting until the last of several background items terminalizes", () =>
  Effect.gen(function* () {
    const secondItemId = TurnItemId.make("turn-item:bg-multi:second");
    const observed = yield* runBackgroundItemScenario("bg-multi", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      backgroundTurnItemEvent(ids, "dynamic_tool", "running", 2, secondItemId),
      rootTerminalEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 3),
      backgroundTurnItemEvent(ids, "dynamic_tool", "completed", 4, secondItemId),
    ]);
    assert.deepEqual(observed, [
      "turn_item:running",
      "turn_item:running",
      "root-finalized",
      "turn_item:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect("does not pin ingestion on background items when the root turn is interrupted", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-interrupted", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      rootTerminalEvent(ids, "interrupted"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
    ]);
    assert.deepEqual(observed, ["turn_item:running", "root-finalized"]);
  }),
);

it.effect("seeds inherited background items before their next update", () =>
  Effect.gen(function* () {
    const key = "inherited-background-seeded";
    const priorRunId = RunId.make(`run:${key}:prior`);
    const observed = yield* runBackgroundItemScenario(
      key,
      (ids) => [
        rootTerminalEvent(ids, "completed"),
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "completed", 1),
      ],
      {
        loadInheritedBackgroundTurnItems: () =>
          Effect.succeed([{ id: TurnItemId.make(`turn-item:${key}`), runId: priorRunId }]),
      },
    );

    assert.deepEqual(observed, ["root-finalized", "turn_item:completed"]);
  }),
);

it.effect("releases the live run after an inherited background item terminalizes", () =>
  Effect.gen(function* () {
    const key = "inherited-background-terminal";
    const priorRunId = RunId.make(`run:${key}:prior`);
    const observed = yield* runBackgroundItemScenario(
      key,
      (ids) => [
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "running", 1),
        rootTerminalEvent(ids, "completed"),
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "completed", 2),
      ],
      {
        loadInheritedBackgroundTurnItems: () =>
          Effect.succeed([{ id: TurnItemId.make(`turn-item:${key}`), runId: priorRunId }]),
      },
    );

    assert.deepEqual(observed, ["turn_item:running", "root-finalized", "turn_item:completed"]);
  }),
);

it.effect("does not hold the live stream open for a foreign provider's background item", () =>
  Effect.gen(function* () {
    const key = "inherited-background-foreign-provider";
    const ids = backgroundScenarioIds(key);
    const priorRunId = RunId.make(`run:${key}:prior`);
    const foreignProviderThreadId = ProviderThreadId.make(`provider-thread:${key}:foreign-session`);
    const foreignItem = {
      id: ids.itemId,
      threadId: ids.threadId,
      runId: priorRunId,
      providerThreadId: foreignProviderThreadId,
      type: "subagent",
      status: "running",
    } as OrchestrationV2TurnItem;
    const inherited = RunExecutionService.selectInheritedBackgroundTurnItems({
      threadId: ids.threadId,
      currentProviderThreadId: ids.providerThreadId,
      currentRunOrdinal: 2,
      runs: [
        {
          id: priorRunId,
          threadId: ids.threadId,
          ordinal: 1,
          status: "interrupted",
        } as OrchestrationV2Run,
      ],
      turnItems: [foreignItem],
    });

    const observed = yield* runBackgroundItemScenario(
      key,
      (scenarioIds) => [rootTerminalEvent(scenarioIds, "completed")],
      {
        keepEventStreamOpen: true,
        loadInheritedBackgroundTurnItems: () => Effect.succeed(inherited),
      },
    );

    assert.deepEqual(inherited, []);
    assert.deepEqual(observed, ["root-finalized"]);
  }),
);

it.effect("refreshes inherited background items after event subscription", () =>
  Effect.gen(function* () {
    const key = "inherited-background-subscription-refresh";
    const ids = backgroundScenarioIds(key);
    const priorRunId = RunId.make(`run:${key}:prior`);
    const itemStatus = yield* Ref.make<OrchestrationV2TurnItem["status"]>("running");
    const loadInheritedBackgroundTurnItems = () =>
      Ref.get(itemStatus).pipe(
        Effect.map((status) =>
          RunExecutionService.selectInheritedBackgroundTurnItems({
            threadId: ids.threadId,
            currentProviderThreadId: ids.providerThreadId,
            currentRunOrdinal: 2,
            runs: [
              {
                id: priorRunId,
                threadId: ids.threadId,
                ordinal: 1,
                status: "interrupted",
              } as OrchestrationV2Run,
            ],
            turnItems: [
              {
                id: ids.itemId,
                threadId: ids.threadId,
                runId: priorRunId,
                providerThreadId: ids.providerThreadId,
                type: "subagent",
                status,
              } as OrchestrationV2TurnItem,
            ],
          }),
        ),
      );

    const observed = yield* runBackgroundItemScenario(
      key,
      (scenarioIds) => [rootTerminalEvent(scenarioIds, "completed")],
      {
        keepEventStreamOpen: true,
        loadInheritedBackgroundTurnItems,
        onSubscribe: Ref.set(itemStatus, "completed"),
      },
    );

    assert.deepEqual(yield* loadInheritedBackgroundTurnItems(), []);
    assert.deepEqual(observed, ["root-finalized"]);
  }),
);

it.effect(
  "keeps ingesting a late empty provider-thread roster while thread-scoped pending work is true",
  () =>
    Effect.gen(function* () {
      const key = "bg-roster-pending-work";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      const pendingByProviderThreadId = yield* Ref.make(new Map([[ids.providerThreadId, true]]));
      const scopedProbeArgs = yield* Ref.make<ReadonlyArray<ProviderThreadId>>([]);
      const ingestCalls = yield* Ref.make<
        ReadonlyArray<{
          readonly activeAttemptId: RunAttemptId | null;
          readonly eventType: string;
          readonly hasWriteIfRunCurrent: boolean;
          readonly hasWriteIfProviderThreadOwner: boolean;
          readonly expectedLastRunOrdinal: number | null;
          readonly runId: RunId | null;
          readonly rosterLength: number | null;
        }>
      >([]);
      const ingestionDone = yield* Deferred.make<void>();
      const layerTest = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpAppModelContext.layerEmpty,
            PreviewAgentActivity.layer,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  if (
                    input.events.some(
                      (event) => event.type === "run.updated" && event.runId === ids.runId,
                    )
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                  }
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
              writeIfProviderThreadOwner: () =>
                Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Effect.gen(function* () {
                  const event = input.event;
                  const rosterLength =
                    event.type === "provider_thread.updated"
                      ? (event.providerThread.pendingBackgroundTasks?.length ?? 0)
                      : null;
                  yield* Ref.update(ingestCalls, (current) => [
                    ...current,
                    {
                      activeAttemptId: input.writeIfProviderThreadOwner?.activeAttemptId ?? null,
                      eventType: event.type,
                      hasWriteIfRunCurrent: input.writeIfRunCurrent !== undefined,
                      hasWriteIfProviderThreadOwner: input.writeIfProviderThreadOwner !== undefined,
                      expectedLastRunOrdinal:
                        input.writeIfProviderThreadOwner?.expectedLastRunOrdinal ?? null,
                      runId: input.writeIfProviderThreadOwner?.runId ?? null,
                      rosterLength,
                    },
                  ]);
                  if (event.type === "provider_thread.updated" && rosterLength === 0) {
                    yield* Ref.update(pendingByProviderThreadId, (current) => {
                      const next = new Map(current);
                      next.set(event.providerThread.id, false);
                      return next;
                    });
                    yield* Ref.update(observed, (current) => [...current, "roster-cleared"]);
                  }
                  if (event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  return [];
                }),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const providerThreadBase = {
        id: ids.providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        appThreadId: ids.threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:${key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${key}`),
          session: {
            events: Stream.empty,
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: (providerThread: OrchestrationV2ProviderThread) =>
              Effect.gen(function* () {
                yield* Ref.update(scopedProbeArgs, (current) => [...current, providerThread.id]);
                return (yield* Ref.get(pendingByProviderThreadId)).get(providerThread.id) === true;
              }),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "active" as const,
                    pendingBackgroundTasks: [
                      { taskId: "bg-1", description: "sleep 20", kind: "command" },
                    ],
                    updatedAt: now,
                  },
                } as ProviderAdapter.ProviderAdapterV2Event,
                rootTerminalEvent(ids, "completed"),
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "idle" as const,
                    pendingBackgroundTasks: [],
                    updatedAt: now,
                  },
                } as ProviderAdapter.ProviderAdapterV2Event,
              ]),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: providerThreadBase as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:${key}:user`),
            text: "Start background work and settle.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(layerTest));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event subscription did not release");
      assert.deepEqual(yield* Ref.get(observed), ["terminal", "root-finalized", "roster-cleared"]);
      assert.isTrue((yield* Ref.get(scopedProbeArgs)).includes(ids.providerThreadId));

      const calls = yield* Ref.get(ingestCalls);
      const preTerminalRoster = calls.find(
        (call) => call.eventType === "provider_thread.updated" && call.rosterLength === 1,
      );
      const lateClear = calls.find(
        (call) => call.eventType === "provider_thread.updated" && call.rosterLength === 0,
      );
      assert.isDefined(preTerminalRoster);
      assert.isTrue(preTerminalRoster?.hasWriteIfRunCurrent);
      assert.isFalse(preTerminalRoster?.hasWriteIfProviderThreadOwner);
      assert.isDefined(lateClear);
      assert.isFalse(
        lateClear?.hasWriteIfRunCurrent,
        "late empty roster must not use stale writeIfRunCurrent running-gate",
      );
      assert.isTrue(
        lateClear?.hasWriteIfProviderThreadOwner,
        "late empty roster must gate on provider-thread ownership",
      );
      assert.equal(lateClear?.expectedLastRunOrdinal, 1);
      assert.equal(lateClear?.runId, ids.runId);
      assert.equal(lateClear?.activeAttemptId, ids.attemptId);
    }),
);

it.effect("drops late root provider-thread writes from a superseded attempt", () =>
  Effect.gen(function* () {
    const key = "bg-roster-attempt-owner-lost";
    const ids = backgroundScenarioIds(key);
    const replacementAttemptId = RunAttemptId.make(`attempt:${key}:replacement`);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const now = yield* DateTime.now;
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const ingestCalls = yield* Ref.make<
      ReadonlyArray<{
        readonly activeAttemptId: RunAttemptId | null;
        readonly eventType: string;
        readonly hasWriteIfProviderThreadOwner: boolean;
        readonly expectedLastRunOrdinal: number | null;
        readonly rosterLength: number | null;
        readonly committed: boolean;
      }>
    >([]);
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === ids.runId,
                  )
                ) {
                  yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            writeIfProviderThreadOwner: () =>
              Effect.succeed({ committed: false, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                const event = input.event;
                const rosterLength =
                  event.type === "provider_thread.updated"
                    ? (event.providerThread.pendingBackgroundTasks?.length ?? 0)
                    : null;
                const ownerGate = input.writeIfProviderThreadOwner;
                const rejectAsStaleOwner =
                  ownerGate !== undefined && ownerGate.activeAttemptId !== replacementAttemptId;
                yield* Ref.update(ingestCalls, (current) => [
                  ...current,
                  {
                    activeAttemptId: ownerGate?.activeAttemptId ?? null,
                    eventType: event.type,
                    hasWriteIfProviderThreadOwner: ownerGate !== undefined,
                    expectedLastRunOrdinal: ownerGate?.expectedLastRunOrdinal ?? null,
                    rosterLength,
                    committed: !rejectAsStaleOwner,
                  },
                ]);
                if (event.type === "turn.terminal") {
                  yield* Ref.update(observed, (current) => [...current, "terminal"]);
                }
                if (event.type === "provider_thread.updated" && rejectAsStaleOwner) {
                  yield* Ref.update(observed, (current) => [...current, "stale-owner-rejected"]);
                  return [];
                }
                if (event.type === "provider_thread.updated") {
                  yield* Ref.update(observed, (current) => [...current, "roster-written"]);
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
      Layer.provideMerge(PreviewAgentActivity.layer),
    );

    const providerThreadBase = {
      id: ids.providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: ProviderSessionId.make(`session:${key}`),
      appThreadId: ids.threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle" as const,
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          events: Stream.empty,
          hasPendingBackgroundWork: Effect.succeed(true),
          hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
          subscribeEvents: Effect.succeed({
            events: Stream.fromIterable([
              {
                type: "provider_thread.updated",
                driver,
                providerThread: {
                  ...providerThreadBase,
                  status: "active" as const,
                  pendingBackgroundTasks: [
                    { taskId: "bg-stale", description: "sleep 20", kind: "command" },
                  ],
                  updatedAt: now,
                },
              } as ProviderAdapter.ProviderAdapterV2Event,
              rootTerminalEvent(ids, "completed"),
              {
                type: "provider_thread.updated",
                driver,
                providerThread: {
                  ...providerThreadBase,
                  status: "idle" as const,
                  lastRunOrdinal: 1,
                  pendingBackgroundTasks: [
                    { taskId: "bg-stale", description: "sleep 20", kind: "command" },
                  ],
                  updatedAt: now,
                },
              } as ProviderAdapter.ProviderAdapterV2Event,
            ]),
            close: Deferred.succeed(ingestionDone, undefined),
          }),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: providerThreadBase as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make(`message:${key}:user`),
          text: "Background work that loses ownership.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(layerTest));

    const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
    assert.isTrue(
      Option.isSome(closed),
      "subscription must release after ownership-loss reject even when probe stays true",
    );
    assert.deepEqual(yield* Ref.get(observed), [
      "roster-written",
      "terminal",
      "root-finalized",
      "stale-owner-rejected",
    ]);

    const calls = yield* Ref.get(ingestCalls);
    const lateStale = calls.find(
      (call) =>
        call.eventType === "provider_thread.updated" &&
        call.hasWriteIfProviderThreadOwner &&
        call.rosterLength === 1,
    );
    assert.isDefined(lateStale);
    assert.equal(lateStale?.expectedLastRunOrdinal, 1);
    assert.equal(lateStale?.activeAttemptId, ids.attemptId);
    assert.isFalse(lateStale?.committed);
  }),
);

it.effect(
  "keeps ingesting a late background turn-item completion after ownership-loss rejects roster writes",
  () =>
    Effect.gen(function* () {
      const key = "bg-item-after-owner-lost";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const layerTest = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpAppModelContext.layerEmpty,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  if (
                    input.events.some(
                      (event) => event.type === "run.updated" && event.runId === ids.runId,
                    )
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                  }
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
              writeIfProviderThreadOwner: () =>
                Effect.succeed({ committed: false, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Effect.gen(function* () {
                  const event = input.event;
                  if (event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  if (
                    event.type === "provider_thread.updated" &&
                    input.writeIfProviderThreadOwner !== undefined
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "stale-owner-rejected"]);
                    return [];
                  }
                  if (event.type === "turn_item.updated") {
                    yield* Ref.update(observed, (current) => [
                      ...current,
                      `turn_item:${event.turnItem.status}`,
                    ]);
                  }
                  return [];
                }),
            }),
            ServerSettings.layerTest(),
          ),
        ),
        Layer.provideMerge(PreviewAgentActivity.layer),
      );

      const providerThreadBase = {
        id: ids.providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        appThreadId: ids.threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:${key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${key}`),
          session: {
            events: Stream.empty,
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                backgroundTurnItemEvent(ids, "command_execution", "running", 1),
                rootTerminalEvent(ids, "completed"),
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "idle" as const,
                    lastRunOrdinal: 1,
                    pendingBackgroundTasks: [
                      { taskId: "bg-stale", description: "sleep 20", kind: "command" },
                    ],
                    updatedAt: now,
                  },
                } as ProviderAdapter.ProviderAdapterV2Event,
                backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
              ]),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: providerThreadBase as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:${key}:user`),
            text: "Background item after ownership loss.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(layerTest));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(
        Option.isSome(closed),
        "subscription must release after background item completes past ownership loss",
      );
      assert.deepEqual(yield* Ref.get(observed), [
        "turn_item:running",
        "terminal",
        "root-finalized",
        "stale-owner-rejected",
        "turn_item:completed",
      ]);
    }),
);

it.effect(
  "does not pin ingestion on a sibling session-wide pending state when this thread has no roster",
  () =>
    Effect.gen(function* () {
      const key = "bg-roster-sibling-not-pin";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const scopedProbeArgs = yield* Ref.make<ReadonlyArray<ProviderThreadId>>([]);
      const layerTest = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpAppModelContext.layerEmpty,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  if (
                    input.events.some(
                      (event) => event.type === "run.updated" && event.runId === ids.runId,
                    )
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                  }
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Effect.gen(function* () {
                  if (input.event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  return [];
                }),
            }),
            ServerSettings.layerTest(),
          ),
        ),
        Layer.provideMerge(PreviewAgentActivity.layer),
      );

      const providerThreadBase = {
        id: ids.providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        appThreadId: ids.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-self",
          strength: "strong" as const,
        },
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const siblingProviderThreadId = ProviderThreadId.make(`provider-thread:${key}:sibling`);

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:${key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${key}`),
          session: {
            events: Stream.empty,
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: (providerThread: OrchestrationV2ProviderThread) =>
              Effect.gen(function* () {
                yield* Ref.update(scopedProbeArgs, (current) => [...current, providerThread.id]);
                return providerThread.id !== ids.providerThreadId;
              }),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                rootTerminalEvent(ids, "completed"),
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    id: siblingProviderThreadId,
                    appThreadId: ThreadId.make(`thread:${key}:sibling`),
                    nativeThreadRef: {
                      driver,
                      nativeId: "native-sibling",
                      strength: "strong" as const,
                    },
                    pendingBackgroundTasks: [
                      { taskId: "sibling-bg", description: "other thread", kind: "command" },
                    ],
                    updatedAt: now,
                  },
                } as ProviderAdapter.ProviderAdapterV2Event,
              ]),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: providerThreadBase as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:${key}:user`),
            text: "Settle without local pending work.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(layerTest));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event subscription did not release");
      const observedEvents = [...(yield* Ref.get(observed))];
      assert.includeMembers(observedEvents, ["terminal", "root-finalized"]);
      const probedIds = yield* Ref.get(scopedProbeArgs);
      assert.isTrue(probedIds.includes(ids.providerThreadId));
      assert.isFalse(probedIds.includes(siblingProviderThreadId));
    }),
);

it.effect(
  "cascade-terminalizes run-owned subagent rows on interrupt before root finalization",
  () =>
    Effect.gen(function* () {
      const ids = backgroundScenarioIds("subagent-interrupt-cascade");
      const childThreadId = ids.childThreadId;
      const unrelatedChildThreadId = ThreadId.make(
        "thread:subagent-interrupt-cascade:unrelated-child",
      );
      const providerInstanceId = ProviderInstanceId.make("codex");
      const written = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const ingested = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const layerTest = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpAppModelContext.layerEmpty,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(written, (current) => [...current, ...input.events]);
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Ref.update(ingested, (current) => [...current, input.event]).pipe(Effect.as([])),
            }),
            ServerSettings.layerTest(),
          ),
        ),
        Layer.provideMerge(PreviewAgentActivity.layer),
      );

      const runningSubagent = makeRunOwnedSubagentFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningTurnItem = makeRunOwnedSubagentTurnItemFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningNode = makeRunOwnedSubagentNodeFixture({
        ids,
        status: "running",
      });
      const runningChildNode = makeRunOwnedSubagentChildNodeFixture({
        ids,
        status: "running",
      });
      const memberThreadId = ThreadId.make("thread:subagent-interrupt-cascade:member");
      const runningMember = {
        ...runningSubagent,
        id: NodeId.make("node:subagent-interrupt-cascade:member"),
        threadId: childThreadId,
        runId: null,
        parentNodeId: runningChildNode.id,
        childThreadId: memberThreadId,
      };
      const foreignSubagent = {
        ...runningMember,
        id: NodeId.make("node:subagent-interrupt-cascade:foreign-subagent"),
        runId: RunId.make("run:subagent-interrupt-cascade:foreign"),
        childThreadId: unrelatedChildThreadId,
      };
      const runningMemberRoot = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-interrupt-cascade:member-root"),
        threadId: memberThreadId,
        rootNodeId: NodeId.make("node:subagent-interrupt-cascade:member-root"),
      };
      const foreignChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-interrupt-cascade:foreign-child"),
        runId: foreignSubagent.runId,
      };
      const runningChildTurnItem = makeLinkedChildTurnItemFixture({
        ids,
        driver,
        type: "command_execution",
      });
      const foreignChildTurnItem = {
        ...runningChildTurnItem,
        id: TurnItemId.make("turn-item:subagent-interrupt-cascade:foreign-child"),
        runId: foreignSubagent.runId,
      };
      const suppressedChildAssistantTurnItem = makeLinkedChildTurnItemFixture({
        ids: {
          ...ids,
          childItemId: TurnItemId.make("turn-item:subagent-interrupt-cascade:suppressed-assistant"),
        },
        driver,
        type: "assistant_message",
      });
      const unrelatedChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-interrupt-cascade:unrelated-child"),
        threadId: unrelatedChildThreadId,
        runId: ids.runId,
        rootNodeId: NodeId.make("node:subagent-interrupt-cascade:unrelated-child"),
      };
      const unrelatedChildTurnItem = {
        ...runningChildTurnItem,
        id: TurnItemId.make("turn-item:subagent-interrupt-cascade:unrelated-child"),
        threadId: unrelatedChildThreadId,
        nodeId: unrelatedChildNode.id,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:subagent-interrupt-cascade"),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make("session:subagent-interrupt-cascade"),
          session: {
            events: Stream.empty,
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                childThreadCreatedEvent(ids),
                {
                  type: "subagent.updated",
                  driver,
                  subagent: runningSubagent,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningChildNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: unrelatedChildNode,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningChildTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: suppressedChildAssistantTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: unrelatedChildTurnItem,
                },
                { type: "subagent.updated", driver, subagent: runningMember },
                { type: "subagent.updated", driver, subagent: foreignSubagent },
                { type: "node.updated", driver, node: runningMemberRoot },
                { type: "node.updated", driver, node: foreignChildNode },
                { type: "turn_item.updated", driver, turnItem: foreignChildTurnItem },
                rootTerminalEvent(ids, "interrupted"),
                {
                  type: "subagent.updated",
                  driver,
                  subagent: {
                    ...runningSubagent,
                    status: "completed" as const,
                    result: "should-not-apply",
                    completedAt: runningSubagent.updatedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningTurnItem,
                    status: "completed" as const,
                    result: "should-not-apply",
                    completedAt: runningTurnItem.updatedAt,
                    updatedAt: runningTurnItem.updatedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningChildTurnItem,
                    status: "completed" as const,
                    completedAt: runningChildTurnItem.updatedAt,
                    updatedAt: runningChildTurnItem.updatedAt,
                  },
                },
                {
                  type: "node.updated",
                  driver,
                  node: {
                    ...runningChildNode,
                    status: "completed" as const,
                    completedAt: runningChildNode.startedAt,
                  },
                },
              ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make("checkpoint-scope:subagent-interrupt-cascade"),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ids.providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          relatedThreadIds: [unrelatedChildThreadId, memberThreadId],
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make("message:subagent-interrupt-cascade:user"),
            text: "Spawn a subagent then stop.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(layerTest));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");

      const events = yield* Ref.get(written);
      const subagentEvents = events.flatMap((event) =>
        event.type === "subagent.updated" ? [event] : [],
      );
      const turnItemEvents = events.flatMap((event) => {
        if (event.type !== "turn-item.updated" || event.payload.type !== "subagent") {
          return [];
        }
        return [
          {
            ...event,
            payload: event.payload,
          },
        ];
      });
      const nodeEvents = events.flatMap((event) =>
        event.type === "node.updated" &&
        event.payload.status === "interrupted" &&
        (event.payload.id === runningNode.id || event.payload.id === runningChildNode.id)
          ? [event]
          : [],
      );
      const runUpdatedIndex = events.findIndex((event) => event.type === "run.updated");
      assert.isAtLeast(runUpdatedIndex, 0, "root run.updated must be written");

      assert.lengthOf(subagentEvents, 2);
      const terminalSubagent = subagentEvents.find(
        (event) => event.payload.id === runningSubagent.id,
      );
      const terminalMember = subagentEvents.find((event) => event.payload.id === runningMember.id);
      assert.isDefined(terminalMember);
      assert.equal(terminalMember.payload.status, "interrupted");
      assert.equal(terminalMember.payload.runId, null);
      assert.equal(terminalMember.payload.childThreadId, memberThreadId);
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === runningMemberRoot.id &&
            event.payload.status === "interrupted",
        ),
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.id === foreignSubagent.id,
        ),
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "node.updated" && event.payload.id === foreignChildNode.id,
        ),
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" && event.payload.id === foreignChildTurnItem.id,
        ),
      );
      assert.isDefined(terminalSubagent);
      assert.equal(terminalSubagent.payload.status, "interrupted");
      assert.equal(terminalSubagent.payload.childThreadId, childThreadId);
      assert.equal(terminalSubagent.payload.result, null);
      assert.isNotNull(terminalSubagent.payload.completedAt);

      assert.lengthOf(turnItemEvents, 1);
      const terminalTurnItem = turnItemEvents[0];
      assert.isDefined(terminalTurnItem);
      assert.equal(terminalTurnItem.payload.status, "interrupted");
      assert.equal(terminalTurnItem.payload.childThreadId, childThreadId);
      assert.equal(terminalTurnItem.payload.result, null);

      const terminalChildTurnItems = events.flatMap((event) =>
        event.type === "turn-item.updated" &&
        event.payload.id === runningChildTurnItem.id &&
        event.payload.status === "interrupted"
          ? [event]
          : [],
      );
      assert.lengthOf(terminalChildTurnItems, 1);
      const terminalChildTurnItem = terminalChildTurnItems[0];
      assert.isDefined(terminalChildTurnItem);
      assert.equal(terminalChildTurnItem.threadId, childThreadId);
      assert.equal(terminalChildTurnItem.payload.threadId, childThreadId);
      assert.equal(terminalChildTurnItem.payload.runId, null);
      assert.equal(terminalChildTurnItem.payload.type, "command_execution");
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === unrelatedChildTurnItem.id &&
            event.payload.status === "interrupted",
        ),
        "related but unlinked child turn items must not cascade",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === suppressedChildAssistantTurnItem.id,
        ),
        "suppressed streaming child items must not be created by the cascade",
      );

      assert.lengthOf(nodeEvents, 2);
      assert.isTrue(
        nodeEvents.some(
          (event) => event.payload.id === runningNode.id && event.payload.kind === "subagent",
        ),
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === unrelatedChildNode.id &&
            event.payload.status === "interrupted",
        ),
        "owned child threads without a live run-owned subagent link must not cascade",
      );
      assert.isTrue(
        nodeEvents.some(
          (event) =>
            event.payload.id === runningChildNode.id &&
            event.runId === (runningChildNode.runId ?? ids.runId) &&
            event.payload.threadId === childThreadId &&
            event.payload.kind === "root_turn",
        ),
      );

      const cascadeIndexes = events.flatMap((event, index) => {
        if (event.type === "subagent.updated" && event.payload.status === "interrupted") {
          return [index];
        }
        if (
          event.type === "turn-item.updated" &&
          event.payload.status === "interrupted" &&
          (event.payload.type === "subagent" || event.payload.id === runningChildTurnItem.id)
        ) {
          return [index];
        }
        if (event.type === "node.updated" && event.payload.status === "interrupted") {
          return event.payload.id === runningNode.id || event.payload.id === runningChildNode.id
            ? [index]
            : [];
        }
        return [];
      });
      assert.isTrue(
        cascadeIndexes.every((index) => index < runUpdatedIndex),
        "subagent cascade must precede run.updated",
      );
      assert.isFalse(
        events.some((event) => {
          if (event.type === "subagent.updated") {
            return event.payload.status === "completed";
          }
          if (event.type === "turn-item.updated" && event.payload.type === "subagent") {
            return event.payload.status === "completed";
          }
          return false;
        }),
        "late provider completion must not reopen cascaded subagent rows",
      );
      assert.isFalse(
        (yield* Ref.get(ingested)).some(
          (event) =>
            (event.type === "subagent.updated" && event.subagent.status === "completed") ||
            (event.type === "turn_item.updated" && event.turnItem.status === "completed") ||
            (event.type === "node.updated" && event.node.status === "completed"),
        ),
        "late provider completion must not be ingested after interrupt",
      );
    }),
);

it.effect(
  "cascades linked child-thread nodes after run-owned subagent and turn-item terminalize",
  () =>
    Effect.gen(function* () {
      const ids = backgroundScenarioIds("subagent-link-survives-terminal");
      const childThreadId = ids.childThreadId;
      const unrelatedChildThreadId = ThreadId.make(
        "thread:subagent-link-survives-terminal:unrelated-child",
      );
      const providerInstanceId = ProviderInstanceId.make("codex");
      const written = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const layerTest = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpAppModelContext.layerEmpty,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(written, (current) => [...current, ...input.events]);
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            ServerSettings.layerTest(),
          ),
        ),
        Layer.provideMerge(PreviewAgentActivity.layer),
      );

      const runningSubagent = makeRunOwnedSubagentFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningTurnItem = makeRunOwnedSubagentTurnItemFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningNode = makeRunOwnedSubagentNodeFixture({
        ids,
        status: "running",
      });
      const runningChildNode = makeRunOwnedSubagentChildNodeFixture({
        ids,
        status: "running",
      });
      const unrelatedChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-link-survives-terminal:unrelated-child"),
        threadId: unrelatedChildThreadId,
        runId: ids.runId,
        rootNodeId: NodeId.make("node:subagent-link-survives-terminal:unrelated-child"),
      };
      const completedAt = runningSubagent.updatedAt;

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:subagent-link-survives-terminal"),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make("session:subagent-link-survives-terminal"),
          session: {
            events: Stream.empty,
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                childThreadCreatedEvent(ids),
                {
                  type: "subagent.updated",
                  driver,
                  subagent: runningSubagent,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningChildNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: unrelatedChildNode,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningTurnItem,
                },
                {
                  type: "subagent.updated",
                  driver,
                  subagent: {
                    ...runningSubagent,
                    status: "completed" as const,
                    result: "subagent finished first",
                    completedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningTurnItem,
                    status: "completed" as const,
                    result: "turn item finished first",
                    completedAt,
                    updatedAt: completedAt,
                  },
                },
                {
                  type: "node.updated",
                  driver,
                  node: {
                    ...runningNode,
                    status: "completed" as const,
                    completedAt,
                  },
                },
                rootTerminalEvent(ids, "interrupted"),
              ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make("checkpoint-scope:subagent-link-survives-terminal"),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ids.providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          relatedThreadIds: [unrelatedChildThreadId],
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make("message:subagent-link-survives-terminal:user"),
            text: "Subagent settles before root interrupt.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(layerTest));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");

      const events = yield* Ref.get(written);
      const runUpdatedIndex = events.findIndex((event) => event.type === "run.updated");
      assert.isAtLeast(runUpdatedIndex, 0, "root run.updated must be written");

      const cascadedChildNodeEvents = events.flatMap((event, index) =>
        event.type === "node.updated" &&
        event.payload.id === runningChildNode.id &&
        event.payload.status === "interrupted"
          ? [{ event, index }]
          : [],
      );
      assert.lengthOf(
        cascadedChildNodeEvents,
        1,
        "open linked child-thread node must cascade after subagent/turn-item terminalize",
      );
      const cascadedChild = cascadedChildNodeEvents[0];
      assert.isDefined(cascadedChild);
      assert.isTrue(
        cascadedChild.index < runUpdatedIndex,
        "child-thread cascade must precede run.updated",
      );
      assert.equal(cascadedChild.event.payload.threadId, childThreadId);
      assert.equal(cascadedChild.event.payload.kind, "root_turn");
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === unrelatedChildNode.id &&
            event.payload.status === "interrupted",
        ),
        "related but unlinked child threads must not cascade",
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.status === "interrupted",
        ),
        "already-terminal subagent rows must not be re-cascaded",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "subagent" &&
            event.payload.status === "interrupted",
        ),
        "already-terminal subagent turn items must not be re-cascaded",
      );
    }),
);

it.effect("cascade helper is provider-neutral for Claude and Codex-shaped child projections", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    let nextId = 0;
    const allocateEventId = () =>
      Effect.sync(() => EventId.make(`event:cascade-helper:${nextId++}`));

    for (const driverKind of [
      ProviderDriverKind.make("claudeAgent"),
      ProviderDriverKind.make("codex"),
    ] as const) {
      const runId = RunId.make(`run:cascade-helper:${driverKind}`);
      const threadId = ThreadId.make(`thread:cascade-helper:${driverKind}`);
      const childThreadId = ThreadId.make(`thread:cascade-helper:${driverKind}:child`);
      const subagentId = NodeId.make(`node:cascade-helper:${driverKind}:subagent`);
      const childNodeId = NodeId.make(`node:cascade-helper:${driverKind}:child-root`);
      const providerInstanceId = ProviderInstanceId.make(String(driverKind));
      const terminalStatus = driverKind === "claudeAgent" ? "failed" : "cancelled";
      const subagent: OrchestrationV2Subagent = {
        id: subagentId,
        threadId,
        runId,
        parentNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        origin: "provider_native",
        createdBy: "agent",
        driver: driverKind,
        providerInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: {
          driver: driverKind,
          nativeId: `native-${driverKind}`,
          strength: "strong",
        },
        prompt: "hold",
        title: "hold",
        model: null,
        status: "running",
        progress: "partial progress",
        result: "partial result",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const turnItem = {
        id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}`),
        threadId,
        runId,
        nodeId: subagentId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: subagent.nativeTaskRef,
        parentItemId: null,
        ordinal: 3,
        status: "running" as const,
        title: "hold",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent" as const,
        subagentId,
        origin: "provider_native" as const,
        driver: driverKind,
        providerInstanceId,
        childThreadId,
        prompt: "hold",
        progress: "partial progress",
        result: "partial result",
      } satisfies Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
      const node: OrchestrationV2ExecutionNode = {
        id: subagentId,
        threadId,
        runId,
        parentNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        rootNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: subagent.nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const openChildNode: OrchestrationV2ExecutionNode = {
        id: childNodeId,
        threadId: childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: childNodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const childTurnItem: OrchestrationV2TurnItem =
        driverKind === "claudeAgent"
          ? {
              id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}:child-reasoning`),
              threadId: childThreadId,
              runId: null,
              nodeId: childNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: "Working",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "reasoning",
              text: "partial progress",
              streaming: true,
            }
          : {
              id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}:child-command`),
              threadId: childThreadId,
              runId: null,
              nodeId: childNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: "sleep 300",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "command_execution",
              input: "sleep 300",
            };

      const events = yield* RunExecutionService.cascadeTerminalizeRunOwnedSubagents({
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        open: {
          subagents: new Map([[subagentId, subagent]]),
          turnItems: new Map([[subagentId, turnItem]]),
          childTurnItems: new Map(),
          nodes: new Map([[subagentId, node]]),
          linkedChildThreadIds: new Set([childThreadId]),
        },
        status: terminalStatus,
        completedAt: now,
        allocateEventId,
      });

      assert.equal(events.length, 3, `${driverKind}: subagent + node + turn item`);
      const terminalSubagent = events.find((event) => event.type === "subagent.updated");
      assert.isDefined(terminalSubagent);
      if (terminalSubagent?.type !== "subagent.updated") {
        assert.fail("expected subagent.updated event");
        return;
      }
      assert.equal(terminalSubagent.payload.status, terminalStatus);
      assert.equal(terminalSubagent.payload.childThreadId, childThreadId);
      assert.equal(terminalSubagent.payload.progress, "partial progress");
      assert.equal(terminalSubagent.payload.result, "partial result");
      assert.equal(terminalSubagent.payload.driver, driverKind);

      const terminalItem = events.find(
        (event) => event.type === "turn-item.updated" && event.payload.type === "subagent",
      );
      assert.isDefined(terminalItem);
      if (terminalItem?.type !== "turn-item.updated" || terminalItem.payload.type !== "subagent") {
        assert.fail("expected subagent turn-item.updated event");
        return;
      }
      assert.equal(terminalItem.payload.status, terminalStatus);
      assert.equal(terminalItem.payload.childThreadId, childThreadId);
      assert.equal(terminalItem.payload.progress, "partial progress");
      assert.equal(terminalItem.payload.result, "partial result");

      const afterTerminalLinkEvents =
        yield* RunExecutionService.cascadeTerminalizeRunOwnedSubagents({
          run: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          open: {
            subagents: new Map(),
            turnItems: new Map(),
            childTurnItems: new Map([[childTurnItem.id, childTurnItem]]),
            nodes: new Map([[childNodeId, openChildNode]]),
            linkedChildThreadIds: new Set([childThreadId]),
          },
          status: terminalStatus,
          completedAt: now,
          allocateEventId,
        });
      assert.equal(
        afterTerminalLinkEvents.length,
        2,
        `${driverKind}: linked child node and turn item cascade after link rows terminalize`,
      );
      const cascadedChild = afterTerminalLinkEvents.find((event) => event.type === "node.updated");
      assert.isDefined(cascadedChild);
      if (cascadedChild?.type !== "node.updated") {
        assert.fail("expected node.updated for linked child thread");
        return;
      }
      assert.equal(cascadedChild.payload.id, childNodeId);
      assert.equal(cascadedChild.payload.threadId, childThreadId);
      assert.equal(cascadedChild.payload.status, terminalStatus);
      assert.equal(cascadedChild.payload.kind, "root_turn");
      const cascadedChildTurnItem = afterTerminalLinkEvents.find(
        (event) => event.type === "turn-item.updated",
      );
      assert.isDefined(cascadedChildTurnItem);
      if (cascadedChildTurnItem?.type !== "turn-item.updated") {
        assert.fail("expected turn-item.updated for linked child thread");
        return;
      }
      assert.equal(cascadedChildTurnItem.threadId, childThreadId);
      assert.equal(cascadedChildTurnItem.payload.id, childTurnItem.id);
      assert.equal(cascadedChildTurnItem.payload.status, terminalStatus);
      assert.equal(cascadedChildTurnItem.payload.runId, null);
      assert.equal(cascadedChildTurnItem.payload.type, childTurnItem.type);
      if (cascadedChildTurnItem.payload.type === "reasoning") {
        assert.isFalse(cascadedChildTurnItem.payload.streaming);
      }
    }
  }),
);

it.effect("omits interrupt results and subagent cascade for a superseded attempt", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "steer-supersede",
      shouldFinalizeRun: () => Effect.succeed(false),
      seedOpenSubagent: true,
    });
    assert.deepEqual(
      written.map((item) => item.type),
      [],
    );
    assert.deepEqual(observed, []);
  }),
);

it.effect("emits run_interrupt_result when superseded attempt still has a hard-stop request", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "stop-then-steer-supersede",
      shouldFinalizeRun: () => Effect.succeed(false),
      hasUnpairedRunInterruptRequest: () => Effect.succeed(true),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      ["run_interrupt_result"],
    );
    assert.deepEqual(observed, ["pull-requests-refreshed"]);
    const ids = backgroundScenarioIds("stop-then-steer-supersede");
    const expectedRequestId = yield* Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      return idAllocator.derive.runSignalTurnItem({
        runId: ids.runId,
        signal: "interrupt-request",
      });
    }).pipe(Effect.provide(IdAllocator.layer));
    assert.equal(written[0]?.parentItemId, expectedRequestId);
  }),
);

it.effect("omits run_interrupt_result when superseded attempt request is already paired", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "stop-then-steer-already-paired",
      shouldFinalizeRun: () => Effect.succeed(false),
      hasUnpairedRunInterruptRequest: () => Effect.succeed(false),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      [],
    );
    assert.deepEqual(observed, []);
  }),
);

it.effect("does not overwrite Stop when ownership changes after the finalization read", () =>
  Effect.gen(function* () {
    const { written, observed, submittedEffects, committedEffects } =
      yield* captureRootRunTermination({
        key: "stop-wins-finalization-gap",
        shouldFinalizeRun: () => Effect.succeed(true),
        rejectTerminalWrite: true,
      });
    assert.deepEqual(written, []);
    assert.deepEqual(observed, []);
    assert.deepEqual(
      submittedEffects.map((effect) => effect.request.type),
      ["checkpoint.capture"],
    );
    assert.deepEqual(committedEffects, []);
  }),
);

it.effect("emits run_interrupt_result when hard-stop finalizes the active attempt", () =>
  Effect.gen(function* () {
    const { written, observed, committedEffects } = yield* captureRootRunTermination({
      key: "hard-stop",
      shouldFinalizeRun: () => Effect.succeed(true),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      ["run_interrupt_result"],
    );
    assert.deepEqual(observed, ["run:interrupted", "pull-requests-refreshed"]);
    assert.deepEqual(
      committedEffects.map((effect) => effect.request.type),
      ["checkpoint.capture"],
    );
  }),
);

it.effect.each(["completed", "interrupted", "cancelled", "failed"] as const)(
  "refreshes pull requests after the current root run %s",
  (status) =>
    Effect.gen(function* () {
      const { observed } = yield* captureRootRunTermination({
        key: `pull-request-refresh:${status}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) => Stream.make(rootTerminalEvent(ids, status)),
      });
      assert.deepEqual(observed, [
        `run:${status === "completed" ? "waiting" : status}`,
        "pull-requests-refreshed",
      ]);
    }),
);

it.effect("records a finished run as failed when its ownership check cannot be read", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "finalize-guard-read-failure",
      shouldFinalizeRun: () =>
        Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({
            threadId: ThreadId.make("thread:finalize-guard-read-failure"),
            cause: "database unavailable",
          }),
        ),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
    });
    assert.include(observed, "run:failed");
  }),
);

it.effect("does not refresh pull requests for auxiliary or stale provider terminals", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:auxiliary",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.fromIterable([
          rootTerminalEvent(
            { ...ids, rootProviderTurnId: ProviderTurnId.make("turn:child") },
            "completed",
          ),
          rootTerminalEvent(
            { ...ids, rootProviderTurnId: ProviderTurnId.make("turn:previous") },
            "interrupted",
          ),
          rootTerminalEvent(ids, "cancelled"),
        ]),
    });
    assert.deepEqual(observed, ["run:cancelled", "pull-requests-refreshed"]);
  }),
);

it.effect("refreshes pull requests after a provider stream exits with an error", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:stream-error",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver,
            providerSessionId: ProviderSessionId.make("session:exited"),
            cause: "provider process exited",
          }),
        ),
    });
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
    assert.deepEqual(
      written.map((item) => item.type),
      ["error"],
    );
    const error = written.find((item) => item.type === "error");
    assert.include(error?.failure.message ?? "", "provider event stream closed unexpectedly");
  }),
);

// The server browser keeps an agent's tab focused for exactly this span.
it.effect.each(["completed", "failed"] as const)(
  "reports the thread executing until its %s run's event consumer ends",
  (outcome) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { previewActivityEnded } = yield* captureRootRunTermination({
        key: `preview-activity:${outcome}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) =>
          Stream.fromEffect(Deferred.await(gate)).pipe(
            Stream.flatMap(() =>
              outcome === "completed"
                ? Stream.make(rootTerminalEvent(ids, "completed"))
                : Stream.fail(
                    new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver,
                      providerSessionId: ProviderSessionId.make("session:exited"),
                      cause: "provider process exited",
                    }),
                  ),
            ),
          ),
        afterStart: () =>
          Effect.gen(function* () {
            const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
            assert.isTrue(
              yield* activity.active(ThreadId.make(`thread:preview-activity:${outcome}`)),
            );
            yield* Deferred.succeed(gate, undefined);
          }),
      });
      assert.isTrue(previewActivityEnded);
    }),
);

// Background commands keep the consumer alive for the whole session; only the agent's own
// turn and the children it drives should hold the browser tab focused.
it.effect.each([
  { name: "ends once the root turn finishes beside background work", openSubagent: false },
  { name: "stays while a run-owned subagent continues", openSubagent: true },
])("preview activity $name", ({ openSubagent }) =>
  Effect.gen(function* () {
    const key = `preview-activity:background:${openSubagent}`;
    const consumerWaiting = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const providerInstanceId = ProviderInstanceId.make("codex");
    yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Effect.succeed(true),
      hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
      events: (ids) =>
        Stream.concat(
          Stream.fromIterable([
            ...(openSubagent
              ? [
                  {
                    type: "subagent.updated",
                    driver,
                    subagent: makeRunOwnedSubagentFixture({
                      ids,
                      providerInstanceId,
                      childThreadId: ids.childThreadId,
                      driver,
                      status: "running",
                    }),
                  } as const,
                ]
              : []),
            rootTerminalEvent(ids, "completed"),
          ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
          Stream.fromEffect(
            Deferred.succeed(consumerWaiting, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          ).pipe(Stream.drain),
        ),
      afterStart: (closed) =>
        Effect.gen(function* () {
          yield* Deferred.await(consumerWaiting);
          assert.isFalse(yield* Deferred.isDone(closed));
          const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
          assert.equal(yield* activity.active(ThreadId.make(`thread:${key}`)), openSubagent);
          yield* Deferred.succeed(release, undefined);
        }),
    });
  }),
);

it.effect("fails the run when its event stream ends without a root terminal", () =>
  Effect.gen(function* () {
    const { observed, finalEvents } = yield* captureRootRunTermination({
      key: "stream-end-without-terminal",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () => Stream.empty,
    });
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
    assert.equal(
      finalEvents.find((event) => event.type === "provider-thread.updated")?.payload.status,
      "idle",
    );
  }),
);

it.effect.each(
  (["interrupted", "failed", "completed", "cancelled", "rolled_back"] as const).flatMap((status) =>
    (["command", "held-text", "message", "node"] as const).flatMap((kind) =>
      (["before-terminal", "unowned-terminal", "rejected-terminal"] as const).map((phase) => ({
        status,
        kind,
        phase,
      })),
    ),
  ),
)(
  "drops late activity and stops the exact provider turn of an externally $status run ($kind, $phase)",
  ({ status, kind, phase }) =>
    Effect.gen(function* () {
      const stops: ProviderTurnId[] = [];
      const logs: unknown[] = [];
      const now = yield* DateTime.now;
      let guarded = false;
      let settled = phase === "before-terminal";
      const result = yield* captureRootRunTermination({
        key: `late-settled:${status}`,
        shouldFinalizeRun: () => Effect.succeed(phase === "rejected-terminal"),
        rejectTerminalWrite: phase === "rejected-terminal",
        loadRunSettlement: () =>
          Effect.succeed({
            status: settled ? status : "running",
            completedAt: settled ? now : null,
          }),
        responseStreamingMode: "turn",
        events: (ids) => {
          const event = backgroundTurnItemEvent(ids, "command_execution", "running", 1);
          if (event.type !== "turn_item.updated") throw new Error("Expected turn item");
          const item = {
            ...event.turnItem,
            id: TurnItemId.make(`${event.turnItem.id}:held`),
            type: "assistant_message" as const,
            text: "Still working",
            streaming: true,
          };
          const late =
            kind === "command"
              ? event
              : kind === "held-text"
                ? { ...event, turnItem: item }
                : kind === "message"
                  ? {
                      type: "message.updated" as const,
                      driver,
                      message: {
                        id: MessageId.make("late-message"),
                        threadId: ids.threadId,
                        runId: ids.runId,
                        role: "assistant" as const,
                        text: "Finished",
                        streaming: false,
                      },
                    }
                  : {
                      type: "node.updated" as const,
                      driver,
                      node: {
                        id: ids.rootNodeId,
                        threadId: ids.threadId,
                        runId: ids.runId,
                        kind: "command_execution",
                        status: "running",
                      },
                    };
          const lateEvents = Stream.make(
            late,
            late,
          ) as Stream.Stream<ProviderAdapter.ProviderAdapterV2Event>;
          return phase === "before-terminal"
            ? lateEvents
            : Stream.make(event).pipe(
                Stream.concat(
                  Stream.fromEffect(
                    Effect.sync(() => {
                      settled = true;
                      return rootTerminalEvent(ids, "completed");
                    }),
                  ),
                ),
                Stream.concat(lateEvents),
              );
        },
        ingestNormalized: (input) =>
          Effect.sync(() => {
            if (input.event.type !== "turn.terminal")
              guarded = input.writeIfRunCurrent?.expectedStatus === "running";
            return [];
          }),
        interruptTurn: (input) =>
          Effect.sync(() => {
            assert.isTrue(input.stopBackgroundWork);
            stops.push(input.providerTurnId);
          }),
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => {
              logs.push(message);
            }),
          ]),
        ),
      );
      assert.equal(guarded, kind !== "held-text" || phase !== "before-terminal");
      assert.deepEqual(stops, [`provider-turn:late-settled:${status}`]);
      assert.isEmpty(result.written);
      assert.isEmpty(result.observed);
      assert.isTrue(result.previewActivityEnded);
      assert.lengthOf(
        logs.filter((m) => String(m).includes("provider item after run settlement")),
        1,
      );
      const warning = logs
        .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
        .find(
          (entry) =>
            typeof entry === "object" && entry !== null && "secondsSinceSettlement" in entry,
        );
      assert.deepInclude(warning, {
        threadId: `thread:late-settled:${status}`,
        runId: `run:late-settled:${status}`,
        ordinal: 1,
        providerTurnId: `provider-turn:late-settled:${status}`,
        secondsSinceSettlement: 0,
      });
    }),
);

it.effect("stops a settled run by exact attempt when late activity precedes its turn id", () =>
  Effect.gen(function* () {
    const stops: string[] = [];
    const result = yield* captureRootRunTermination({
      key: "late-before-turn-id",
      unobservedProviderTurn: true,
      shouldFinalizeRun: () => Effect.succeed(false),
      loadRunSettlement: () => Effect.succeed({ status: "interrupted", completedAt: null }),
      events: (ids) => Stream.make(backgroundTurnItemEvent(ids, "command_execution", "running", 1)),
      interruptStartingRun: (input) =>
        Effect.sync(() => {
          assert.isTrue(input.stopBackgroundWork);
          stops.push(`${input.runId}:${input.attemptId}`);
        }),
      interruptTurn: () => Effect.die("No provider turn id is available"),
    });
    assert.deepEqual(stops, ["run:late-before-turn-id:attempt:late-before-turn-id"]);
    assert.isEmpty(result.written);
    assert.isEmpty(result.observed);
  }),
);

it.effect("keeps confirmed background completions after the root run settles", () =>
  Effect.gen(function* () {
    let settled = false;
    const items: string[] = [];
    yield* captureRootRunTermination({
      key: "confirmed-completion",
      shouldFinalizeRun: () => Effect.succeed(true),
      loadRunSettlement: () =>
        Effect.succeed({ status: settled ? "completed" : "running", completedAt: null }),
      onTerminalRun: Effect.sync(() => {
        settled = true;
      }),
      events: (ids) =>
        Stream.make(
          backgroundTurnItemEvent(ids, "command_execution", "running", 1),
          rootTerminalEvent(ids, "completed"),
          backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
        ),
      ingestNormalized: ({ event }) =>
        Effect.sync(() => {
          if (event.type === "turn_item.updated") items.push(event.turnItem.status);
          return [];
        }),
      interruptTurn: () =>
        Effect.die("Confirmed background completion must not interrupt the turn"),
    });
    assert.deepEqual(items, ["running", "completed"]);
  }),
);

// ardud (9 Nov): a failed projection read failed the run while the Claude turn
// kept running unread, and the next send was refused as "previous turn is
// still running". A failed run must stop its provider turn.
it.effect("stops the provider turn when ingestion fails the run before a terminal", () =>
  Effect.gen(function* () {
    const interrupted = yield* Ref.make<ReadonlyArray<string>>([]);
    const preservation: Array<readonly [boolean | undefined, boolean | undefined]> = [];
    const { observed } = yield* captureRootRunTermination({
      key: "ingest-failure:orphaned-turn",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.make({
          type: "node.updated",
          driver,
          node: { id: ids.rootNodeId, threadId: ids.threadId, runId: ids.runId },
        } as unknown as ProviderAdapter.ProviderAdapterV2Event),
      ingestNormalized: (ingest) =>
        Effect.fail(
          new ProviderEventIngestor.ProviderEventNormalizeError({
            providerSessionId: ingest.providerSessionId,
            threadId: ingest.threadId,
            providerEvent: ingest.event,
            cause: new Error("projection read failed"),
          }),
        ),
      interruptTurn: (turn) =>
        Effect.sync(() => {
          preservation.push([turn.requestRuntimeRestart, turn.stopBackgroundWork]);
        }).pipe(
          Effect.andThen(
            Ref.update(interrupted, (current) => [...current, String(turn.providerTurnId)]),
          ),
        ),
    });
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
    assert.deepEqual(yield* Ref.get(interrupted), ["provider-turn:ingest-failure:orphaned-turn"]);
    assert.deepEqual(preservation, [[false, false]]);
  }),
);

it.effect.each(["ended", "healthy-successor"] as const)(
  "finalizes ingestion failure after one not-active Stop: %s",
  (scenario) =>
    Effect.gen(function* () {
      const stale = ProviderTurnId.make(`provider-turn:orphan-not-active:${scenario}`);
      const active =
        scenario === "healthy-successor" ? ProviderTurnId.make("healthy-successor") : null;
      const calls: ProviderTurnId[] = [];
      const warnings: unknown[] = [];
      const result = yield* captureRootRunTermination({
        key: `orphan-not-active:${scenario}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () =>
          Stream.fail(
            new ProviderAdapter.ProviderAdapterEventStreamError({
              driver,
              providerSessionId: ProviderSessionId.make("session:orphan-not-active"),
              cause: "reader unavailable",
            }),
          ),
        interruptTurn: (turn) =>
          Effect.gen(function* () {
            calls.push(turn.providerTurnId);
            assert.equal(turn.providerTurnId, stale);
            assert.notEqual(turn.providerTurnId, active);
            assert.isFalse(turn.requestRuntimeRestart);
            assert.isFalse(turn.stopBackgroundWork);
            return yield* new ProviderAdapter.ProviderAdapterTurnNotActiveError({
              driver,
              providerThreadId: turn.providerThread.id,
              providerTurnId: turn.providerTurnId,
            });
          }),
        onTerminalRun: Effect.sync(() => assert.deepEqual(calls, [stale])),
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ message, logLevel }) => {
              if (logLevel === "Warn") warnings.push(message);
            }),
          ]),
        ),
      );
      assert.deepEqual(calls, [stale]);
      assert.equal(
        warnings.map(String).filter((m) => m.includes("could not stop an orphaned provider turn"))
          .length,
        0,
      );
      assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
    }),
);

it.effect("caps orphan Stop failures with exponential backoff and finalizes the run", () =>
  Effect.gen(function* () {
    const attempts = yield* Queue.unbounded<number>();
    const timestamps: number[] = [];
    const logs: unknown[] = [];
    const result = yield* captureRootRunTermination({
      key: "orphan-stop-cap",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver,
            providerSessionId: ProviderSessionId.make("session:orphan-stop-cap"),
            cause: "reader unavailable",
          }),
        ),
      interruptTurn: () =>
        Effect.gen(function* () {
          timestamps.push(yield* Clock.currentTimeMillis);
          yield* Queue.offer(attempts, timestamps.length);
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver,
            detail: "interrupt transport unavailable",
          });
        }),
      onTerminalRun: Effect.sync(() => assert.lengthOf(timestamps, 10)),
      afterStart: () =>
        Effect.gen(function* () {
          assert.equal(yield* Queue.take(attempts), 1);
          for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]) {
            yield* TestClock.adjust(delay);
            yield* Queue.take(attempts);
          }
        }),
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            logs.push(message);
          }),
        ]),
      ),
    );
    assert.deepEqual(
      timestamps.map((time) => time - timestamps[0]!),
      [0, 1000, 3000, 7000, 15000, 31000, 61000, 91000, 121000, 151000],
    );
    const messages = logs.map(String);
    assert.equal(
      messages.filter((m) => m.includes("could not stop an orphaned provider turn")).length,
      1,
    );
    assert.equal(
      messages.filter((m) => m.includes("gave up stopping an orphaned provider turn")).length,
      1,
    );
    assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
  }),
);

it.effect.each(["ownership-read", "missing-turn-id"] as const)(
  "bounds orphan Stop prerequisite failures: %s",
  (scenario) =>
    Effect.gen(function* () {
      const probes = yield* Queue.unbounded<void>();
      let probeCount = 0;
      let stops = 0;
      const result = yield* captureRootRunTermination({
        key: `orphan-prerequisite:${scenario}`,
        unobservedProviderTurn: scenario === "missing-turn-id",
        shouldFinalizeRun: () =>
          Effect.gen(function* () {
            probeCount++;
            yield* Queue.offer(probes, undefined);
            if (scenario === "ownership-read")
              return yield* new ProjectionStore.ProjectionStoreReadError({
                threadId: ThreadId.make(`thread:orphan-prerequisite:${scenario}`),
                cause: "ownership read unavailable",
              });
            return true;
          }),
        events: () =>
          Stream.fail(
            new ProviderAdapter.ProviderAdapterEventStreamError({
              driver,
              providerSessionId: ProviderSessionId.make("session:orphan-prerequisite"),
              cause: "reader unavailable",
            }),
          ),
        interruptTurn: () =>
          Effect.sync(() => {
            stops++;
          }),
        afterStart: () =>
          Effect.gen(function* () {
            yield* Queue.take(probes);
            for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]) {
              yield* TestClock.adjust(delay);
              yield* Queue.take(probes);
            }
          }),
      });
      assert.equal(probeCount, 10);
      assert.equal(stops, 0);
      assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
    }),
);

it.effect("bounds slow orphan Stops with a five-minute total deadline", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let attempts = 0;
    const start = yield* Clock.currentTimeMillis;
    const result = yield* captureRootRunTermination({
      key: "orphan-stop-deadline",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver,
            providerSessionId: ProviderSessionId.make("session:orphan-stop-deadline"),
            cause: "reader unavailable",
          }),
        ),
      interruptTurn: () =>
        Effect.sync(() => {
          attempts++;
        }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never)),
      afterStart: () => Deferred.await(entered).pipe(Effect.andThen(TestClock.adjust("5 minutes"))),
      onTerminalRun: Effect.gen(function* () {
        assert.equal((yield* Clock.currentTimeMillis) - start, 300_000);
        assert.equal(attempts, 7);
      }),
    });
    assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
  }),
);

it.effect("stops a Claude query before publishing ingestion failure as a terminal run", () =>
  Effect.gen(function* () {
    const order: Array<string> = [];
    const interruptEntered = yield* Deferred.make<void>();
    const allowClose = yield* Deferred.make<void>();
    const result = yield* captureRootRunTermination({
      key: "claude-stop-before-terminal",
      providerDriver: ProviderDriverKind.make("claudeAgent"),
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.make({
          type: "node.updated",
          driver: ProviderDriverKind.make("claudeAgent"),
          node: { id: ids.rootNodeId, threadId: ids.threadId, runId: ids.runId },
        } as unknown as ProviderAdapter.ProviderAdapterV2Event),
      ingestNormalized: (ingest) =>
        Effect.fail(
          new ProviderEventIngestor.ProviderEventNormalizeError({
            providerSessionId: ingest.providerSessionId,
            threadId: ingest.threadId,
            providerEvent: ingest.event,
            cause: "projection failure",
          }),
        ),
      interruptTurn: () =>
        Effect.gen(function* () {
          order.push("query.interrupt");
          yield* Deferred.succeed(interruptEntered, undefined);
          yield* Deferred.await(allowClose);
          order.push("query.close");
        }),
      onTerminalRun: Effect.sync(() => {
        order.push("run:failed");
      }),
      afterStart: () =>
        Deferred.await(interruptEntered).pipe(
          Effect.andThen(Deferred.succeed(allowClose, undefined)),
        ),
    });
    assert.deepEqual(order, ["query.interrupt", "query.close", "run:failed"]);
    assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
  }),
);

it.effect("interrupts both live turns before failing runs after a shared ingestion error", () =>
  Effect.gen(function* () {
    const requested = yield* Ref.make(0);
    const failed = yield* Ref.make(0);
    const bothRequested = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    yield* Effect.forEach(
      ["first", "second"],
      (key) =>
        captureRootRunTermination({
          key: `shared-ingest-failure:${key}`,
          shouldFinalizeRun: () => Effect.succeed(true),
          events: () =>
            Stream.fail(
              new ProviderAdapter.ProviderAdapterEventStreamError({
                driver,
                providerSessionId: ProviderSessionId.make("session:shared-reader-failure"),
                cause: "Database reader retired: a statement ran longer than 120000 ms",
              }),
            ),
          interruptTurn: () =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(requested, (value) => value + 1);
              if (count === 2) yield* Deferred.succeed(bothRequested, undefined);
              yield* Deferred.await(stopped);
            }),
          refreshAfterTurn: Ref.update(failed, (value) => value + 1),
          afterStart: () =>
            key === "second"
              ? Effect.void
              : Effect.gen(function* () {
                  yield* Deferred.await(bothRequested);
                  assert.equal(yield* Ref.get(failed), 0);
                  yield* Deferred.succeed(stopped, undefined);
                }),
        }),
      { concurrency: "unbounded" },
    );
    assert.equal(yield* Ref.get(requested), 2);
    assert.equal(yield* Ref.get(failed), 2);
  }),
);

it.effect.each(["rejected", "timeout", "exit-observation-retry"] as const)(
  "keeps ownership and capture through %s Stop until process exit is confirmed",
  (scenario) =>
    Effect.gen(function* () {
      const terminationStarted = yield* Deferred.make<void>();
      const terminated = yield* Deferred.make<void>();
      const stopStarted = yield* Deferred.make<void>();
      const sourceClosed = yield* Ref.make(false);
      const runFailed = yield* Ref.make(false);
      const shutdownAttempts = yield* Ref.make(0);
      const nativeEvents = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        Cause.Done
      >();
      const result = yield* captureRootRunTermination({
        key: `ingest-stop-recovery:${scenario}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) =>
          Stream.make({
            type: "node.updated",
            driver,
            node: { id: ids.rootNodeId, threadId: ids.threadId, runId: ids.runId },
          } as unknown as ProviderAdapter.ProviderAdapterV2Event).pipe(
            Stream.concat(Stream.fromQueue(nativeEvents)),
            Stream.ensuring(Ref.set(sourceClosed, true)),
          ),
        ingestNormalized: (input) =>
          Effect.fail(
            new ProviderEventIngestor.ProviderEventNormalizeError({
              providerSessionId: input.providerSessionId,
              threadId: input.threadId,
              providerEvent: input.event,
              cause: "reader unavailable",
            }),
          ),
        interruptTurn: (turn) =>
          Deferred.succeed(stopStarted, undefined).pipe(
            Effect.andThen(
              scenario === "timeout"
                ? Effect.never
                : Effect.fail(
                    new ProviderAdapter.ProviderAdapterInterruptError({
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId: turn.providerTurnId,
                      cause:
                        "Codex did not start the queued turn within 10 seconds; Stop could not be delivered.",
                    }),
                  ),
            ),
          ),
        awaitSessionExit: Effect.gen(function* () {
          const attempt = yield* Ref.updateAndGet(shutdownAttempts, (n) => n + 1);
          yield* Deferred.succeed(terminationStarted, undefined);
          if (scenario === "exit-observation-retry" && attempt === 1) {
            return yield* new ProviderAdapter.ProviderAdapterCloseSessionError({
              driver,
              providerSessionId: ProviderSessionId.make("session:shutdown-retry"),
              cause: "exit could not be confirmed",
            });
          }
          yield* Deferred.await(terminated);
          yield* Queue.offer(
            nativeEvents,
            rootTerminalEvent(
              backgroundScenarioIds(`ingest-stop-recovery:${scenario}`),
              "completed",
            ),
          );
        }),
        refreshAfterTurn: Ref.set(runFailed, true),
        afterStart: (closed) =>
          Effect.gen(function* () {
            yield* Deferred.await(stopStarted);
            if (scenario === "timeout") yield* TestClock.adjust("30 seconds");
            yield* Effect.raceFirst(Deferred.await(terminationStarted), Deferred.await(closed));
            assert.isFalse(yield* Ref.get(runFailed));
            assert.isFalse(yield* Ref.get(sourceClosed));
            assert.isFalse(yield* Deferred.isDone(closed));
            yield* Deferred.succeed(terminated, undefined);
            if (scenario === "exit-observation-retry") yield* TestClock.adjust("1 second");
          }),
      });
      assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
      assert.equal(yield* Ref.get(shutdownAttempts), scenario === "exit-observation-retry" ? 2 : 1);
    }),
);

it.effect("interrupts a blocked event write at the confirmed shutdown cleanup deadline", () =>
  Effect.gen(function* () {
    const blocked = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const writes = yield* Ref.make(0);
    const sourceClosed = yield* Ref.make(false);
    const result = yield* captureRootRunTermination({
      key: "blocked-shutdown-cleanup",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.make(
          backgroundTurnItemEvent(ids, "command_execution", "running", 1),
          backgroundTurnItemEvent(ids, "command_execution", "completed", 1),
        ).pipe(Stream.ensuring(Ref.set(sourceClosed, true))),
      ingestNormalized: (input) =>
        Effect.gen(function* () {
          if ((yield* Ref.updateAndGet(writes, (count) => count + 1)) === 1) {
            return yield* new ProviderEventIngestor.ProviderEventNormalizeError({
              providerSessionId: input.providerSessionId,
              threadId: input.threadId,
              providerEvent: input.event,
              cause: "first projection failure",
            });
          }
          yield* Deferred.succeed(blocked, undefined);
          return yield* Effect.never;
        }),
      interruptTurn: () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
      afterStart: (closed) =>
        Effect.gen(function* () {
          yield* Deferred.await(stopped);
          yield* Deferred.await(blocked);
          yield* TestClock.adjust("9 seconds");
          assert.isFalse(yield* Deferred.isDone(closed));
          yield* TestClock.adjust("1 second");
          yield* Deferred.await(closed);
        }),
    });
    assert.isTrue(yield* Ref.get(sourceClosed));
    assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
  }),
);

it.effect.each(["delivered", "terminated"] as const)(
  "drains subscriber cleanup before failing ingestion after %s Stop",
  (scenario) =>
    Effect.gen(function* () {
      const key = `subscriber-cleanup:${scenario}`;
      const ids = backgroundScenarioIds(key);
      const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
      const ingested = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>>([]);
      const providerTurn = (
        status: "running" | "interrupted",
      ): ProviderAdapter.ProviderAdapterV2Event => ({
        type: "provider_turn.updated",
        driver,
        threadId: ids.threadId,
        providerTurn: {
          id: ids.rootProviderTurnId,
          runAttemptId: ids.attemptId,
          status,
        } as OrchestrationV2ProviderTurn,
      });
      const cleanup = Queue.offerAll(queue, [
        providerTurn("interrupted"),
        rootTerminalEvent(ids, "interrupted"),
        backgroundTurnItemEvent(ids, "command_execution", "completed", 101),
      ]).pipe(Effect.asVoid);
      const result = yield* captureRootRunTermination({
        key,
        shouldFinalizeRun: () => Effect.succeed(true),
        subscribeEvents: () =>
          Effect.gen(function* () {
            yield* Queue.offerAll(queue, [
              providerTurn("running"),
              backgroundTurnItemEvent(ids, "command_execution", "running", 101),
              {
                type: "node.updated",
                driver,
                node: { id: ids.rootNodeId, threadId: ids.threadId, runId: ids.runId },
              } as ProviderAdapter.ProviderAdapterV2Event,
            ]);
            const close = Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid);
            return { events: Stream.fromQueue(queue).pipe(Stream.ensuring(close)), close };
          }),
        ingestNormalized: (input) =>
          input.event.type === "node.updated"
            ? Effect.fail(
                new ProviderEventIngestor.ProviderEventNormalizeError({
                  providerSessionId: input.providerSessionId,
                  threadId: input.threadId,
                  providerEvent: input.event,
                  cause: "reader failed during ingestion",
                }),
              )
            : Ref.update(ingested, (events) => [...events, input.event]).pipe(Effect.as([])),
        interruptTurn: (turn) =>
          scenario === "delivered"
            ? cleanup
            : Effect.fail(
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                  cause: "Stop unavailable",
                }),
              ),
        ...(scenario === "terminated" ? { awaitSessionExit: cleanup } : {}),
      });
      const events = yield* Ref.get(ingested);
      assert.deepEqual(
        events
          .filter((event) => event.type === "provider_turn.updated")
          .map((event) => event.providerTurn.status),
        ["running", "interrupted"],
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "turn_item.updated")
          .map((event) => event.turnItem.status),
        ["running", "completed"],
      );
      assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
    }),
);

it.effect.each(["delivered", "terminated"] as const)(
  "retains capture for a failed root's live child until %s Stop after terminal ingestion fails",
  (scenario) =>
    Effect.gen(function* () {
      const key = `failed-root-live-child:${scenario}`;
      const ids = backgroundScenarioIds(key);
      const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
      const stopStarted = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const closed = yield* Ref.make(false);
      const runFailed = yield* Ref.make(false);
      const childFinished = yield* Ref.make(false);
      const endChild = Deferred.succeed(stopStarted, undefined).pipe(
        Effect.andThen(Deferred.await(stopped)),
        Effect.andThen(Queue.offer(queue, subagentEvent(ids, "completed"))),
        Effect.asVoid,
      );
      const result = yield* captureRootRunTermination({
        key,
        shouldFinalizeRun: () => Effect.succeed(true),
        subscribeEvents: () =>
          Effect.gen(function* () {
            yield* Queue.offerAll(queue, [
              subagentEvent(ids, "running"),
              {
                ...rootTerminalEvent(ids, "failed"),
                childTurnsContinue: true,
              } as ProviderAdapter.ProviderAdapterV2Event,
            ]);
            const close = Ref.set(closed, true).pipe(
              Effect.andThen(Queue.clear(queue)),
              Effect.andThen(Queue.end(queue)),
              Effect.asVoid,
            );
            return { events: Stream.fromQueue(queue).pipe(Stream.ensuring(close)), close };
          }),
        ingestNormalized: (input) =>
          input.event.type === "turn.terminal"
            ? Effect.fail(
                new ProviderEventIngestor.ProviderEventNormalizeError({
                  providerSessionId: input.providerSessionId,
                  threadId: input.threadId,
                  providerEvent: input.event,
                  cause: "root terminal storage failed",
                }),
              )
            : input.event.type === "subagent.updated" && input.event.subagent.status === "completed"
              ? Ref.set(childFinished, true).pipe(Effect.as([]))
              : Effect.succeed([]),
        interruptTurn: (turn) =>
          scenario === "delivered"
            ? endChild
            : Effect.fail(
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                  cause: "Stop unavailable",
                }),
              ),
        ...(scenario === "terminated" ? { awaitSessionExit: endChild } : {}),
        refreshAfterTurn: Ref.set(runFailed, true),
        afterStart: (ingestionClosed) =>
          Effect.gen(function* () {
            yield* Effect.raceFirst(Deferred.await(stopStarted), Deferred.await(ingestionClosed));
            assert.isFalse(yield* Ref.get(closed));
            assert.isFalse(yield* Ref.get(runFailed));
            yield* Deferred.succeed(stopped, undefined);
          }),
      });
      assert.isTrue(yield* Ref.get(childFinished));
      assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
    }),
);

it.effect("consumes natural completion while Stop rejects without a process-exit hook", () =>
  Effect.gen(function* () {
    const key = "stop-retry-natural-completion";
    const ids = backgroundScenarioIds(key);
    const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
    const current = yield* Ref.make(true);
    const attempts = yield* Ref.make(0);
    const secondAttempt = yield* Deferred.make<void>();
    const consumedTerminal = yield* Deferred.make<void>();
    const result = yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Ref.get(current),
      subscribeEvents: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            type: "node.updated",
            driver,
            node: { id: ids.rootNodeId, threadId: ids.threadId, runId: ids.runId },
          } as ProviderAdapter.ProviderAdapterV2Event);
          const close = Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid);
          return { events: Stream.fromQueue(queue).pipe(Stream.ensuring(close)), close };
        }),
      ingestNormalized: (input) =>
        input.event.type === "node.updated"
          ? Effect.fail(
              new ProviderEventIngestor.ProviderEventNormalizeError({
                providerSessionId: input.providerSessionId,
                threadId: input.threadId,
                providerEvent: input.event,
                cause: "reader failed",
              }),
            )
          : Deferred.succeed(consumedTerminal, undefined).pipe(Effect.as([])),
      interruptTurn: (turn) =>
        Effect.gen(function* () {
          const count = yield* Ref.updateAndGet(attempts, (n) => n + 1);
          if (count === 1) yield* Queue.offer(queue, rootTerminalEvent(ids, "completed"));
          if (count === 2) yield* Deferred.succeed(secondAttempt, undefined);
          return yield* new ProviderAdapter.ProviderAdapterInterruptError({
            driver,
            providerThreadId: turn.providerThread.id,
            providerTurnId: turn.providerTurnId,
            cause: "Claude provider thread has no live query; turn finished naturally",
          });
        }),
      afterStart: () =>
        Effect.gen(function* () {
          yield* TestClock.adjust("1 second");
          yield* Effect.raceFirst(Deferred.await(consumedTerminal), Deferred.await(secondAttempt));
          if (!(yield* Deferred.isDone(consumedTerminal))) {
            yield* Ref.set(current, false);
            yield* TestClock.adjust("1 second");
          }
        }),
    });
    assert.isTrue(
      yield* Deferred.isDone(consumedTerminal),
      "Natural completion stayed queued behind Stop retries",
    );
    assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
  }),
);

it.live("finishes recovery when a terminal item write fails before natural completion", () =>
  Effect.gen(function* () {
    const key = "failed-terminal-item-natural-end";
    const ids = backgroundScenarioIds(key);
    const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
    const attempts = yield* Ref.make(0);
    const secondAttempt = yield* Deferred.make<void>();
    const completionConsumed = yield* Deferred.make<void>();
    const requiredReplay = yield* Ref.make(false);
    const replayAvailable = yield* Ref.make(false);
    const result = yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Effect.succeed(true),
      subscribeEvents: () =>
        Effect.gen(function* () {
          yield* Queue.offerAll(queue, [
            backgroundTurnItemEvent(ids, "command_execution", "running", 101),
            backgroundTurnItemEvent(ids, "command_execution", "completed", 101),
          ]);
          const close = Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid);
          return { events: Stream.fromQueue(queue).pipe(Stream.ensuring(close)), close };
        }),
      ingestNormalized: (input) =>
        Effect.gen(function* () {
          if (
            input.event.type === "turn_item.updated" &&
            input.event.turnItem.status === "completed" &&
            !(yield* Ref.get(replayAvailable))
          ) {
            return yield* new ProviderEventIngestor.ProviderEventNormalizeError({
              providerSessionId: input.providerSessionId,
              threadId: input.threadId,
              providerEvent: input.event,
              cause: "terminal item write failed",
            });
          }
          if (input.event.type === "turn.terminal")
            yield* Deferred.succeed(completionConsumed, undefined);
          return [];
        }),
      interruptTurn: (turn) =>
        Effect.gen(function* () {
          const count = yield* Ref.updateAndGet(attempts, (n) => n + 1);
          if (count === 1) yield* Queue.offer(queue, rootTerminalEvent(ids, "completed"));
          if (count === 2) yield* Deferred.succeed(secondAttempt, undefined);
          return yield* new ProviderAdapter.ProviderAdapterInterruptError({
            driver,
            providerThreadId: turn.providerThread.id,
            providerTurnId: turn.providerTurnId,
            cause: "No live query",
          });
        }),
      afterStart: (closed) =>
        Effect.gen(function* () {
          yield* Effect.raceFirst(Deferred.await(closed), Deferred.await(secondAttempt));
          if (!(yield* Deferred.isDone(closed))) {
            yield* Ref.set(requiredReplay, true);
            yield* Ref.set(replayAvailable, true);
            yield* Queue.offer(
              queue,
              backgroundTurnItemEvent(ids, "command_execution", "completed", 101),
            );
          }
        }),
    });
    assert.isTrue(yield* Deferred.isDone(completionConsumed));
    assert.isFalse(
      yield* Ref.get(requiredReplay),
      "A failed completion write kept the item permanently active",
    );
    assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
  }),
);

it.effect("keeps healthy sibling work alive when another shared-session turn rejects Stop", () =>
  Effect.gen(function* () {
    const bad = backgroundScenarioIds("shared-session-stop:bad");
    const good = backgroundScenarioIds("shared-session-stop:good");
    const badEvents = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
    const goodEvents = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
    const stopAttempted = yield* Deferred.make<void>();
    const heartbeatIngested = yield* Deferred.make<void>();
    const sharedExit = yield* Deferred.make<void>();
    const kills = yield* Ref.make(0);
    const unsafeProcessStop = Ref.update(kills, (n) => n + 1).pipe(
      Effect.andThen(Deferred.succeed(sharedExit, undefined)),
      Effect.andThen(Queue.offer(goodEvents, rootTerminalEvent(good, "failed"))),
      Effect.asVoid,
    );
    const results = yield* Effect.forEach(
      ["bad", "good"] as const,
      (key) => {
        const ids = key === "bad" ? bad : good;
        const queue = key === "bad" ? badEvents : goodEvents;
        return captureRootRunTermination({
          key: `shared-session-stop:${key}`,
          sharedSessionId: ProviderSessionId.make("session:shared-siblings"),
          shouldFinalizeRun: () => Effect.succeed(true),
          unsafeProcessStop,
          awaitSessionExit: Deferred.await(sharedExit),
          subscribeEvents: () =>
            Effect.gen(function* () {
              yield* Queue.offer(
                queue,
                key === "bad"
                  ? ({
                      type: "node.updated",
                      driver,
                      node: { id: ids.rootNodeId, threadId: ids.threadId, runId: ids.runId },
                    } as ProviderAdapter.ProviderAdapterV2Event)
                  : backgroundTurnItemEvent(ids, "command_execution", "running", 101),
              );
              const close = Queue.clear(queue).pipe(
                Effect.andThen(Queue.end(queue)),
                Effect.asVoid,
              );
              return { events: Stream.fromQueue(queue).pipe(Stream.ensuring(close)), close };
            }),
          ingestNormalized: (input) =>
            key === "bad"
              ? Effect.fail(
                  new ProviderEventIngestor.ProviderEventNormalizeError({
                    providerSessionId: input.providerSessionId,
                    threadId: input.threadId,
                    providerEvent: input.event,
                    cause: "reader failed for one turn",
                  }),
                )
              : input.event.type === "turn_item.updated" &&
                  input.event.turnItem.status === "completed"
                ? Deferred.succeed(heartbeatIngested, undefined).pipe(Effect.as([]))
                : Effect.succeed([]),
          interruptTurn: (turn) =>
            Deferred.succeed(stopAttempted, undefined).pipe(
              Effect.andThen(
                Effect.fail(
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: turn.providerTurnId,
                    cause: "One turn's Stop unavailable",
                  }),
                ),
              ),
            ),
          afterStart: () =>
            key === "good"
              ? Effect.void
              : Effect.gen(function* () {
                  yield* Deferred.await(stopAttempted);
                  yield* Queue.offer(
                    goodEvents,
                    backgroundTurnItemEvent(good, "command_execution", "completed", 101),
                  );
                  yield* Effect.raceFirst(
                    Deferred.await(heartbeatIngested),
                    Deferred.await(sharedExit),
                  );
                  yield* Queue.offer(badEvents, rootTerminalEvent(bad, "completed"));
                  yield* Queue.offer(goodEvents, rootTerminalEvent(good, "completed"));
                }),
        });
      },
      { concurrency: "unbounded" },
    );
    assert.equal(yield* Ref.get(kills), 0, "A failed Stop cannot kill the sibling's app-server");
    assert.isTrue(yield* Deferred.isDone(heartbeatIngested));
    assert.deepEqual(results[1]?.observed, ["run:waiting", "pull-requests-refreshed"]);
  }),
);

it.effect("does not interrupt a replaced turn after a newer run takes ownership", () =>
  Effect.gen(function* () {
    const shutdowns = yield* Ref.make(0);
    const result = yield* captureRootRunTermination({
      key: "ingest-stop-recovery:takeover",
      shouldFinalizeRun: () => Effect.succeed(false),
      rejectTerminalWrite: true,
      events: () =>
        Stream.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver,
            providerSessionId: ProviderSessionId.make("session:takeover"),
            cause: "stream failed",
          }),
        ),
      interruptTurn: (turn) =>
        Ref.update(shutdowns, (n) => n + 1).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderAdapter.ProviderAdapterInterruptError({
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId: turn.providerTurnId,
                cause: "old turn unavailable",
              }),
            ),
          ),
        ),
      awaitSessionExit: Effect.never,
    });
    assert.equal(yield* Ref.get(shutdowns), 0);
    assert.deepEqual(result.observed, []);
  }),
);

it.effect("does not terminate a session when storing an observed native completion fails", () =>
  Effect.gen(function* () {
    const stops = yield* Ref.make(0);
    const result = yield* captureRootRunTermination({
      key: "native-terminal-ingest-failure",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
      ingestNormalized: (input) =>
        Effect.fail(
          new ProviderEventIngestor.ProviderEventNormalizeError({
            providerSessionId: input.providerSessionId,
            threadId: input.threadId,
            providerEvent: input.event,
            cause: "database unavailable",
          }),
        ),
      interruptTurn: () => Ref.update(stops, (n) => n + 1),
      awaitSessionExit: Ref.update(stops, (n) => n + 1),
    });
    assert.equal(yield* Ref.get(stops), 0);
    assert.include(result.observed, "run:failed");
  }),
);

it.effect("does not stop a provider turn that already reached its terminal", () =>
  Effect.gen(function* () {
    const interrupted = yield* Ref.make(0);
    yield* captureRootRunTermination({
      key: "ingest-failure:settled-turn",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.concat(
          Stream.make(rootTerminalEvent(ids, "completed")),
          Stream.fail(
            new ProviderAdapter.ProviderAdapterEventStreamError({
              driver,
              providerSessionId: ProviderSessionId.make("session:settled"),
              cause: "late stream failure",
            }),
          ),
        ),
      hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
      interruptTurn: () => Ref.update(interrupted, (count) => count + 1),
    });
    assert.equal(yield* Ref.get(interrupted), 0);
  }),
);

it.effect("leaves the run to restart recovery when shutdown interrupts its event stream", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "stream-end:shutdown",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () => Stream.failCause(Cause.interrupt()),
    });
    assert.deepEqual(written, []);
    assert.deepEqual(observed, []);
  }),
);

it.effect("does not start a turn whose run settled during the app context read", () =>
  Effect.gen(function* () {
    const contextReadStarted = yield* Deferred.make<void>();
    const runFailed = yield* Deferred.make<void>();
    const current = yield* Ref.make(true);
    const providerCalls = yield* Ref.make(0);
    const { observed } = yield* captureRootRunTermination({
      key: "stream-end:context-read",
      shouldStartProviderTurn: () => Ref.get(current),
      shouldFinalizeRun: () => Ref.get(current),
      events: () => Stream.unwrap(Deferred.await(contextReadStarted).pipe(Effect.as(Stream.empty))),
      appContext: Deferred.succeed(contextReadStarted, undefined).pipe(
        Effect.andThen(Deferred.await(runFailed)),
        Effect.as([]),
      ),
      refreshAfterTurn: Ref.set(current, false).pipe(
        Effect.andThen(Deferred.succeed(runFailed, undefined)),
      ),
      startTurn: () => Ref.update(providerCalls, (count) => count + 1),
    });
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
    assert.equal(yield* Ref.get(providerCalls), 0);
  }),
);

it.effect.each(["failure", "interruption"] as const)(
  "stops the exact attached Claude attempt before startup %s closes ingestion",
  (mode) =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const cleanupPolicies: Array<boolean | undefined> = [];
      const ingestionStarted = yield* Deferred.make<void>();
      const result = yield* captureRootRunTermination({
        key: `claude-startup-${mode}`,
        providerDriver: ProviderDriverKind.make("claudeAgent"),
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () =>
          Stream.unwrap(
            Deferred.succeed(ingestionStarted, undefined).pipe(Effect.as(Stream.never)),
          ),
        startTurn: (input) =>
          Deferred.await(ingestionStarted).pipe(
            Effect.andThen(
              mode === "interruption"
                ? Effect.interrupt
                : Effect.fail(
                    new ProviderAdapter.ProviderAdapterTurnStartError({
                      driver: ProviderDriverKind.make("claudeAgent"),
                      threadId: input.threadId,
                      providerThreadId: input.providerThread.id,
                      runId: input.runId,
                      cause: "offer failed after attachment",
                    }),
                  ),
            ),
          ),
        interruptStartingRun: ({ runId, attemptId, stopBackgroundWork }) =>
          Effect.sync(() => {
            assert.equal(runId, RunId.make(`run:claude-startup-${mode}`));
            assert.equal(attemptId, RunAttemptId.make(`attempt:claude-startup-${mode}`));
            cleanupPolicies.push(stopBackgroundWork);
            order.push("query.stopped");
          }),
        onSubscriptionClose: Effect.sync(() => {
          order.push("ingestion.closed");
        }),
        onTerminalRun: Effect.sync(() => {
          order.push("run:failed");
        }),
      }).pipe(Effect.exit);
      assert.deepEqual(
        order,
        mode === "failure"
          ? ["query.stopped", "ingestion.closed", "run:failed"]
          : ["query.stopped", "ingestion.closed"],
      );
      assert.equal(result._tag, mode === "failure" ? "Success" : "Failure");
      assert.deepEqual(cleanupPolicies, [false]);
    }),
);

it.effect.each(["terminal", "ingest_error", "stop_error"] as const)(
  "preserves the startup failure when Claude cleanup emits a terminal before returning: %s",
  (mode) =>
    Effect.gen(function* () {
      const key = `claude-startup-terminal-${mode}`;
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const ingestionStarted = yield* Deferred.make<void>();
      const ingestionClosed = yield* Deferred.make<void>();
      const outcome = yield* captureRootRunTermination({
        key,
        providerDriver: ProviderDriverKind.make("claudeAgent"),
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () =>
          Stream.unwrap(
            Deferred.succeed(ingestionStarted, undefined).pipe(Effect.as(Stream.fromQueue(events))),
          ),
        startTurn: (input) =>
          Deferred.await(ingestionStarted).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: ProviderDriverKind.make("claudeAgent"),
                  threadId: input.threadId,
                  providerThreadId: input.providerThread.id,
                  runId: input.runId,
                  cause: "offer failed after attachment",
                }),
              ),
            ),
          ),
        interruptStartingRun: () =>
          Queue.offer(events, rootTerminalEvent(backgroundScenarioIds(key), "interrupted")).pipe(
            Effect.andThen(Deferred.await(ingestionClosed)),
            Effect.andThen(mode === "stop_error" ? Effect.die("late Stop error") : Effect.void),
          ),
        ingestNormalized: () =>
          mode !== "ingest_error"
            ? Effect.succeed([])
            : Effect.die("cleanup terminal persistence failed"),
        onSubscriptionClose: Deferred.succeed(ingestionClosed, undefined),
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isSuccess(outcome));
      if (Exit.isFailure(outcome)) throw new Error("Startup cleanup failed to settle");
      const result = outcome.value;
      const terminals = result.finalEvents.flatMap((event) =>
        event.type === "run.updated" ? [event.payload.status] : [],
      );
      assert.deepEqual(terminals, ["failed"]);
      const error = result.written.find((item) => item.type === "error");
      assert.include(error?.failure.message ?? "", "provider could not start this turn");
      assert.notInclude(error?.failure.message ?? "", "cleanup terminal persistence failed");
    }),
);

it.effect("retries a failed Claude startup cleanup before settling the original failure", () =>
  Effect.gen(function* () {
    const firstStopFailed = yield* Deferred.make<void>();
    const ingestionStarted = yield* Deferred.make<void>();
    let stops = 0;
    const run = yield* captureRootRunTermination({
      key: "claude-startup-cleanup-retry",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.unwrap(Deferred.succeed(ingestionStarted, undefined).pipe(Effect.as(Stream.never))),
      startTurn: (input) =>
        Deferred.await(ingestionStarted).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: ProviderDriverKind.make("claudeAgent"),
                threadId: input.threadId,
                providerThreadId: input.providerThread.id,
                runId: input.runId,
                cause: "offer failed after attachment",
              }),
            ),
          ),
        ),
      interruptStartingRun: () =>
        Effect.suspend(() =>
          ++stops === 1
            ? Deferred.succeed(firstStopFailed, undefined).pipe(
                Effect.andThen(Effect.die("transient Stop failure")),
              )
            : Effect.void,
        ),
    }).pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(firstStopFailed);
    yield* TestClock.adjust("1 second");
    const outcome = yield* Fiber.join(run);
    assert.isTrue(Exit.isSuccess(outcome));
    if (Exit.isFailure(outcome)) throw new Error("Startup cleanup failed to settle");
    const result = outcome.value;
    assert.equal(stops, 2);
    assert.deepEqual(
      result.finalEvents.flatMap((event) =>
        event.type === "run.updated" ? [event.payload.status] : [],
      ),
      ["failed"],
    );
  }).pipe(Effect.scoped),
);

it.effect("refreshes pull requests only once when startup failure closes its event stream", () =>
  Effect.gen(function* () {
    const ingestionStarted = yield* Deferred.make<void>();
    const { observed, written } = yield* captureRootRunTermination({
      key: "pull-request-refresh:startup-error",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.unwrap(Deferred.succeed(ingestionStarted, undefined).pipe(Effect.as(Stream.never))),
      startTurn: (input) =>
        Deferred.await(ingestionStarted).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver,
                threadId: input.threadId,
                providerThreadId: input.providerThread.id,
                runId: input.runId,
                cause: "provider rejected the turn",
              }),
            ),
          ),
        ),
    });
    assert.equal(observed.filter((item) => item === "pull-requests-refreshed").length, 1);
    assert.equal(observed[0], "run:failed");
    const error = written.find((item) => item.type === "error");
    assert.include(error?.failure.message ?? "", "provider could not start this turn");
  }),
);

it.effect("keeps completed runs completed when pull request refresh fails", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:refresh-failure",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
      refreshAfterTurn: Effect.die("refresh failed"),
    });
    assert.deepEqual(observed, ["run:waiting", "pull-requests-refreshed"]);
  }),
);

it.effect.each([
  { provider: "codex", processOwned: true },
  { provider: "cursor", processOwned: true },
  { provider: "grok", processOwned: true },
  { provider: "antigravity", processOwned: true },
  { provider: "opencode", processOwned: false },
] as const)(
  "applies $provider child lifetime on live subscriber failure",
  ({ provider, processOwned }) =>
    Effect.gen(function* () {
      const key = `session-subscriber-failure:${provider}`;
      const ids = backgroundScenarioIds(key);
      const providerDriver = ProviderDriverKind.make(provider);
      const result = yield* captureRootRunTermination({
        key,
        providerDriver,
        backgroundTasksEndWithProcess: processOwned,
        shouldFinalizeRun: () => Effect.succeed(true),
        awaitSessionExit: Effect.void,
        subscribeEvents: () =>
          Effect.succeed({
            events: Stream.make(
              subagentEvent(ids, "running"),
              {
                type: "node.updated",
                driver: providerDriver,
                node: makeRunOwnedSubagentNodeFixture({ ids, status: "running" }),
              },
              backgroundTurnItemEvent(ids, "subagent", "running", 1),
            ).pipe(
              Stream.concat(
                Stream.fail(
                  new ProviderAdapter.ProviderAdapterEventStreamError({
                    driver: providerDriver,
                    providerSessionId: ProviderSessionId.make(`session:${key}`),
                    cause: "Provider session released: runtime_error.",
                  }),
                ),
              ),
            ),
            close: Effect.void,
          }),
      });
      assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
      const childEvents = result.finalEvents.filter(
        (event) =>
          event.type === "subagent.updated" ||
          (event.type === "node.updated" && event.payload.id === ids.subagentNodeId) ||
          (event.type === "turn-item.updated" && event.payload.type === "subagent"),
      );
      assert.lengthOf(childEvents, processOwned ? 3 : 0);
      for (const event of childEvents) {
        if (
          event.type === "subagent.updated" ||
          event.type === "node.updated" ||
          event.type === "turn-item.updated"
        )
          assert.equal(event.payload.status, "failed");
      }
    }),
);

function captureRootRunTermination(input: {
  readonly key: string;
  readonly cancelMetadata?: Pick<OrchestrationV2Run, "cancelReason" | "cancelDetail">;
  readonly loadCancelMetadata?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["loadRunCancelMetadata"];
  readonly unobservedProviderTurn?: boolean;
  readonly providerDriver?: ProviderDriverKind;
  readonly backgroundTasksEndWithProcess?: boolean;
  readonly onTerminalRun?: Effect.Effect<void>;
  readonly delegated?: boolean;
  readonly legacyOwnership?:
    | "app_owned"
    | "provider_native"
    | "missing"
    | "other_child"
    | "other_task"
    | "read_error";
  readonly recoveryRun?: OrchestrationV2Run["transientRecovery"];
  readonly stallRecovery?: OrchestrationV2Run["delegatedTaskStallRecovery"];
  readonly providerStartDeadlineAt?: OrchestrationV2Run["providerStartDeadlineAt"];
  readonly responseStreamingMode?: "turn" | "paragraph";
  readonly launchRecovery?: OrchestrationV2Run["launchRecovery"];
  readonly model?: string;
  readonly relayText?: string;
  readonly sessionRefused?: boolean;
  readonly durableRefusal?: boolean | "read_error";
  readonly refusalRead?: () => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
  readonly admissionRead?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["loadRecoveryAdmission"];
  readonly captureActivity?: (active: Effect.Effect<boolean>) => Effect.Effect<void>;
  readonly rejectRecoveryWrite?: boolean;
  readonly loadDelegatedTask?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["loadDelegatedTask"];
  readonly shouldFinalizeRun: () => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
  readonly loadRunSettlement?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["loadRunSettlement"];
  readonly rejectTerminalWriteForAttempt?: RunAttemptId;
  readonly runStart?: (
    start: Effect.Effect<void, RunExecutionService.RunExecutionServiceV2Error>,
    closed: Deferred.Deferred<void>,
  ) => Effect.Effect<void>;
  readonly rejectTerminalWrite?: boolean;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  readonly hasPendingBackgroundWorkForThread?: ProviderAdapter.ProviderAdapterV2SessionRuntime["hasPendingBackgroundWorkForThread"];
  readonly seedOpenSubagent?: boolean;
  readonly events?: (
    ids: BackgroundScenarioIds,
  ) => Stream.Stream<
    ProviderAdapter.ProviderAdapterV2Event,
    ProviderAdapter.ProviderAdapterV2Error
  >;
  readonly subscribeEvents?: (
    ids: BackgroundScenarioIds,
  ) => Effect.Effect<ProviderAdapter.ProviderAdapterV2EventSubscription>;
  readonly startTurn?: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"];
  readonly interruptStartingRun?: ProviderAdapter.ProviderAdapterV2SessionRuntime["interruptStartingRun"];
  readonly interruptTurn?: ProviderAdapter.ProviderAdapterV2SessionRuntime["interruptTurn"];
  readonly awaitSessionExit?: ProviderAdapter.ProviderAdapterV2SessionRuntime["awaitSessionExit"];
  readonly unsafeProcessStop?: Effect.Effect<void>;
  readonly sharedSessionId?: ProviderSessionId;
  readonly nativeSessionId?: string;
  readonly ingestNormalized?: ProviderEventIngestor.ProviderEventIngestorV2Shape["ingestNormalized"];
  readonly refreshAfterTurn?: Effect.Effect<void>;
  readonly onSubscriptionClose?: Effect.Effect<void>;
  readonly shouldStartProviderTurn?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["shouldStartProviderTurn"];
  readonly captureBaseline?: CheckpointService.CheckpointServiceV2["Service"]["captureBaseline"];
  readonly afterRetryCommit?: Effect.Effect<void>;
  readonly runUpdates?: Stream.Stream<OrchestrationV2StoredEvent>;
  readonly afterIngestion?: (
    execution: RunExecutionService.RunExecutionServiceV2["Service"],
    ids: BackgroundScenarioIds,
    controls: RunExecutionService.RunExecutionServiceV2StartRootRunInput,
  ) => Effect.Effect<void>;
  readonly recordUsage?: Analytics.Analytics["Service"]["record"];
  readonly appContext?: ReturnType<McpAppModelContext.McpAppModelContext["Service"]["forThread"]>;
  readonly afterStart?: (
    closed: Deferred.Deferred<void>,
    execution: RunExecutionService.RunExecutionServiceV2["Service"],
    ids: BackgroundScenarioIds,
    controls: RunExecutionService.RunExecutionServiceV2StartRootRunInput,
  ) => Effect.Effect<void, never, PreviewAgentActivity.PreviewAgentActivity>;
}) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(input.key);
    const usageStartedAt = yield* DateTime.now;
    const driver = input.providerDriver ?? ProviderDriverKind.make("codex");
    const readRefusal =
      input.refusalRead ??
      (() =>
        input.durableRefusal === "read_error"
          ? Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId: ids.threadId,
                cause: "refusal history unavailable",
              }),
            )
          : Effect.succeed(input.durableRefusal ?? false));
    const providerInstanceId = ProviderInstanceId.make(driver);
    const runningSubagent = makeRunOwnedSubagentFixture({
      ids,
      providerInstanceId,
      childThreadId: ids.childThreadId,
      driver,
      status: "running",
    });
    const writtenItems = yield* Ref.make<ReadonlyArray<OrchestrationV2TurnItem>>([]);
    const finalEvents = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const submittedEffects = yield* Ref.make<ReadonlyArray<PendingOrchestrationEffectV2>>([]);
    const committedEffects = yield* Ref.make<ReadonlyArray<PendingOrchestrationEffectV2>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const captureTurnItem = (payload: OrchestrationV2TurnItem) =>
      Ref.update(writtenItems, (current) => [...current, payload]);
    const captureFinalEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        yield* Ref.update(finalEvents, (current) => [...current, ...events]);
        for (const event of events) {
          if (event.type === "turn-item.updated") {
            yield* captureTurnItem(event.payload);
          }
          if (event.type === "run.updated") {
            yield* input.onTerminalRun ?? Effect.void;
            yield* Ref.update(observed, (current) => [...current, `run:${event.payload.status}`]);
          }
        }
      });
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(McpAppModelContext.McpAppModelContext)({
            forThread: () => input.appContext ?? Effect.succeed([]),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            captureBaseline: input.captureBaseline ?? (() => Effect.void),
          }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            stream: () => input.runUpdates ?? Stream.never,
            latestSequence: () => Effect.succeed(0),
            write: (payload) =>
              Effect.gen(function* () {
                for (const event of payload.events) {
                  if (event.type === "turn-item.updated") {
                    yield* captureTurnItem(event.payload);
                  }
                }
                return [];
              }),
            writeWithEffects: (payload) =>
              Effect.gen(function* () {
                yield* Ref.update(submittedEffects, (current) => [...current, ...payload.effects]);
                yield* Ref.update(committedEffects, (current) => [...current, ...payload.effects]);
                yield* captureFinalEvents(payload.events);
                return [];
              }),
            writeIfRunCurrent: (payload) =>
              Effect.gen(function* () {
                const effects = payload.effects ?? [];
                yield* Ref.update(submittedEffects, (current) => [...current, ...effects]);
                if (
                  input.rejectTerminalWrite === true ||
                  payload.activeAttemptId === input.rejectTerminalWriteForAttempt
                ) {
                  return { committed: false, storedEvents: [] };
                }
                if (input.rejectRecoveryWrite && payload.unlessClaudeRefused !== undefined)
                  return { committed: false, storedEvents: [] };
                yield* Ref.update(committedEffects, (current) => [...current, ...effects]);
                yield* captureFinalEvents(payload.events);
                if (effects.some((effect) => effect.request.type === "provider-turn.start"))
                  yield* input.afterRetryCommit ?? Effect.void;
                return { committed: true, storedEvents: [] };
              }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: input.ingestNormalized ?? (() => Effect.succeed([])),
          }),
          ServerSettings.layerTest(
            input.responseStreamingMode === undefined
              ? {}
              : { responseStreamingMode: input.responseStreamingMode },
          ),
          input.recordUsage
            ? Layer.mock(Analytics.Analytics)({ record: input.recordUsage })
            : Layer.empty,
          Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
            refresh: () => Effect.void,
            refreshAfterTurn: () =>
              Ref.update(observed, (current) => [...current, "pull-requests-refreshed"]).pipe(
                Effect.andThen(input.refreshAfterTurn ?? Effect.void),
              ),
          }),
        ),
      ),
      Layer.provideMerge(PreviewAgentActivity.layer),
    );

    const previewActivityEnded = yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      const previewActivity = yield* PreviewAgentActivity.PreviewAgentActivity;
      yield* input.captureActivity?.(previewActivity.active(ids.threadId)) ?? Effect.void;
      const controls = {
        commandId: CommandId.make(`command:${input.key}`),
        appThread: {
          id: ids.threadId,
          lineage: { relationshipToParent: input.delegated ? "subagent" : null },
          forkedFrom: input.delegated ? { type: "node", nodeId: ids.subagentNodeId } : null,
          archivedAt: null,
          deletedAt: null,
        } as OrchestrationV2AppThread,
        providerSessionId: input.sharedSessionId ?? ProviderSessionId.make(`session:${input.key}`),
        session: {
          ...(input.backgroundTasksEndWithProcess === false
            ? {}
            : { backgroundTasksEndWithProcess: true }),
          events: Stream.empty,
          subscribeEvents: (
            input.subscribeEvents?.(ids) ??
            Effect.succeed({
              events:
                input.events?.(ids) ??
                Stream.fromIterable([
                  ...(input.seedOpenSubagent
                    ? [
                        { type: "subagent.updated", driver, subagent: runningSubagent } as const,
                        {
                          type: "node.updated",
                          driver,
                          node: makeRunOwnedSubagentNodeFixture({ ids, status: "running" }),
                        } as const,
                        {
                          type: "turn_item.updated",
                          driver,
                          turnItem: makeRunOwnedSubagentTurnItemFixture({
                            ids,
                            providerInstanceId,
                            childThreadId: ids.childThreadId,
                            driver,
                            status: "running",
                          }),
                        } as const,
                      ]
                    : []),
                  rootTerminalEvent(ids, "interrupted"),
                ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined).pipe(
                Effect.andThen(input.onSubscriptionClose ?? Effect.void),
              ),
            })
          ).pipe(
            Effect.map((subscription) => ({
              ...subscription,
              close: subscription.close.pipe(
                Effect.andThen(Deferred.succeed(ingestionDone, undefined)),
              ),
            })),
          ),
          startTurn: input.startTurn ?? (() => Effect.void),
          ...(input.interruptStartingRun === undefined
            ? {}
            : { interruptStartingRun: input.interruptStartingRun }),
          interruptTurn: input.interruptTurn ?? (() => Effect.void),
          ...(input.awaitSessionExit === undefined
            ? {}
            : { awaitSessionExit: input.awaitSessionExit }),
          ...(input.unsafeProcessStop === undefined
            ? {}
            : { terminateSession: input.unsafeProcessStop }),
          hasPendingBackgroundWorkForThread: input.hasPendingBackgroundWorkForThread,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          startedAt: input.recordUsage ? usageStartedAt : null,
          providerInstanceId,
          transientRecovery: input.recoveryRun,
          delegatedTaskStallRecovery: input.stallRecovery,
          providerStartDeadlineAt: input.providerStartDeadlineAt,
          launchRecovery: input.launchRecovery,
          modelSelection: { instanceId: providerInstanceId, model: input.model ?? "gpt-5.4" },
          ...(input.delegated && input.legacyOwnership === undefined
            ? { delegatedTaskId: ids.subagentNodeId }
            : {}),
        } as OrchestrationV2Run,
        rootNode: {
          id: ids.rootNodeId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${input.key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ids.providerThreadId,
          driver,
          ...(input.nativeSessionId === undefined
            ? {}
            : {
                nativeThreadRef: { driver, nativeId: input.nativeSessionId, strength: "strong" },
              }),
          ...(input.sessionRefused === undefined
            ? {}
            : { nativeMetadata: { claudeRefusalObserved: input.sessionRefused } }),
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          attemptOrdinal: 1,
          providerTurnId: input.unobservedProviderTurn ? null : ids.rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        ...(input.legacyOwnership === undefined
          ? {}
          : {
              loadDelegatedTask: () =>
                input.legacyOwnership === "read_error"
                  ? Effect.fail(
                      new ProjectionStore.ProjectionStoreReadError({
                        threadId: ids.threadId,
                        cause: "parent read failed",
                      }),
                    )
                  : Effect.succeed(
                      input.legacyOwnership === "missing"
                        ? undefined
                        : {
                            id:
                              input.legacyOwnership === "other_task"
                                ? NodeId.make("wrong-task")
                                : ids.subagentNodeId,
                            childThreadId:
                              input.legacyOwnership === "other_child"
                                ? ThreadId.make("wrong-child")
                                : ids.threadId,
                            origin:
                              input.legacyOwnership === "provider_native"
                                ? ("provider_native" as const)
                                : ("app_owned" as const),
                          },
                    ),
            }),
        providerTurnOrdinal: 1,
        ...(input.loadDelegatedTask === undefined
          ? {}
          : { loadDelegatedTask: input.loadDelegatedTask }),
        shouldFinalizeRun: input.shouldFinalizeRun,
        ...(input.loadRunSettlement === undefined
          ? {}
          : { loadRunSettlement: input.loadRunSettlement }),
        loadRunCancelMetadata:
          input.loadCancelMetadata ?? (() => Effect.succeed(input.cancelMetadata)),
        ...(input.durableRefusal === undefined && input.refusalRead === undefined
          ? {}
          : { loadClaudeRefusal: readRefusal }),
        loadRecoveryAdmission:
          input.admissionRead ??
          (() =>
            Effect.gen(function* () {
              const current = yield* input.shouldStartProviderTurn?.() ?? Effect.succeed(true);
              const refused = yield* readRefusal();
              return { current, refused };
            })),
        ...(input.shouldStartProviderTurn === undefined
          ? {}
          : { shouldStartProviderTurn: input.shouldStartProviderTurn }),
        ...(input.hasUnpairedRunInterruptRequest === undefined
          ? {}
          : {
              hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
            }),
        message: {
          messageId: MessageId.make(`message:${input.key}`),
          text: input.relayText ?? "interrupt projection",
          attachments: [],
          createdBy: input.relayText === undefined ? "user" : "system",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      } satisfies RunExecutionService.RunExecutionServiceV2StartRootRunInput;
      const startup = runExecution.startRootRun(controls);
      yield* input.runStart?.(startup, ingestionDone) ?? startup;
      yield* input.afterStart?.(ingestionDone, runExecution, ids, controls) ?? Effect.void;
      yield* Deferred.await(ingestionDone);
      yield* input.afterIngestion?.(runExecution, ids, controls) ?? Effect.void;
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      return !(yield* activity.active(ids.threadId));
    }).pipe(Effect.provide(layerTest));

    return {
      previewActivityEnded,
      written: yield* Ref.get(writtenItems),
      finalEvents: yield* Ref.get(finalEvents),
      observed: yield* Ref.get(observed),
      submittedEffects: yield* Ref.get(submittedEffects),
      committedEffects: yield* Ref.get(committedEffects),
    };
  });
}

interface BackgroundScenarioIds {
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
  readonly rootProviderTurnId: ProviderTurnId;
  readonly rootNodeId: NodeId;
  readonly itemId: TurnItemId;
  readonly childItemId: TurnItemId;
  readonly subagentNodeId: NodeId;
}

function backgroundScenarioIds(key: string): BackgroundScenarioIds {
  return {
    threadId: ThreadId.make(`thread:${key}`),
    childThreadId: ThreadId.make(`thread:${key}:child`),
    runId: RunId.make(`run:${key}`),
    attemptId: RunAttemptId.make(`attempt:${key}`),
    providerThreadId: ProviderThreadId.make(`provider-thread:${key}`),
    rootProviderTurnId: ProviderTurnId.make(`provider-turn:${key}`),
    rootNodeId: NodeId.make(`node:${key}`),
    itemId: TurnItemId.make(`turn-item:${key}`),
    childItemId: TurnItemId.make(`turn-item:${key}:child`),
    subagentNodeId: NodeId.make(`node:${key}:subagent`),
  };
}

function childThreadCreatedEvent(
  ids: BackgroundScenarioIds,
): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "app_thread.created",
    driver,
    appThread: {
      id: ids.childThreadId,
      lineage: {
        parentThreadId: ids.threadId,
        relationshipToParent: "subagent",
        rootThreadId: ids.threadId,
      },
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
}

function childBackgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed" | "idle",
  ordinal: number,
): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: ids.childItemId,
      threadId: ids.childThreadId,
      runId: null,
      providerTurnId: null,
      ordinal,
      type: "command_execution",
      status,
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
}

function backgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed" | "idle",
  ordinal: number,
  itemId?: TurnItemId,
): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: itemId ?? ids.itemId,
      threadId: ids.threadId,
      runId: ids.runId,
      providerTurnId: ids.rootProviderTurnId,
      ordinal,
      type,
      status,
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
}

function backgroundTurnItemEventForRun(
  ids: BackgroundScenarioIds,
  runId: RunId,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed" | "idle",
  ordinal: number,
): ProviderAdapter.ProviderAdapterV2Event {
  const event = backgroundTurnItemEvent(ids, type, status, ordinal);
  if (event.type !== "turn_item.updated") {
    return event;
  }
  return { ...event, turnItem: { ...event.turnItem, runId } };
}

function subagentEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed" | "idle",
): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "subagent.updated",
    driver,
    subagent: {
      id: ids.subagentNodeId,
      threadId: ids.threadId,
      runId: ids.runId,
      status,
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
}

function makeRunOwnedSubagentFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): OrchestrationV2Subagent {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    origin: "provider_native",
    createdBy: "agent",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    providerThreadId: null,
    childThreadId: input.childThreadId,
    nativeTaskRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    prompt: "hold",
    title: "Live-test subagent hold",
    model: null,
    status: input.status,
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
}

function makeRunOwnedSubagentTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): Extract<OrchestrationV2TurnItem, { type: "subagent" }> {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.itemId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    nodeId: input.ids.subagentNodeId,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    parentItemId: null,
    ordinal: 3,
    status: input.status,
    title: "Live-test subagent hold",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "subagent",
    subagentId: input.ids.subagentNodeId,
    origin: "provider_native",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    childThreadId: input.childThreadId,
    prompt: "hold",
    result: null,
  };
}

function makeLinkedChildTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly driver: typeof driver;
  readonly type: "assistant_message" | "command_execution" | "reasoning";
}): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  const base = {
    id: input.ids.childItemId,
    threadId: input.ids.childThreadId,
    runId: null,
    nodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running" as const,
    title: "Working",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  if (input.type === "assistant_message") {
    return {
      ...base,
      type: "assistant_message",
      messageId: MessageId.make(`${input.ids.childItemId}:message`),
      text: "partial response",
      streaming: true,
    };
  }
  if (input.type === "reasoning") {
    return {
      ...base,
      type: "reasoning",
      text: "partial progress",
      streaming: true,
    };
  }
  return {
    ...base,
    type: "command_execution",
    input: "sleep 300",
  };
}

function makeRunOwnedSubagentNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    rootNodeId: input.ids.rootNodeId,
    kind: "subagent",
    status: input.status,
    countsForRun: false,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

function makeRunOwnedSubagentChildNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    threadId: input.ids.childThreadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    kind: "root_turn",
    status: input.status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

function rootTerminalEvent(
  ids: BackgroundScenarioIds,
  status: "completed" | "interrupted" | "cancelled" | "failed",
): Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> {
  const common = {
    type: "turn.terminal" as const,
    driver,
    providerThreadId: ids.providerThreadId,
    providerTurnId: ids.rootProviderTurnId,
    runOrdinal: 1,
    threadDisposition: "reusable" as const,
  };
  return status === "failed"
    ? {
        ...common,
        status,
        failureItemOrdinal: 101,
        failure: {
          class: "provider_error",
          message: "Provider failed",
          code: null,
          retryable: null,
        },
      }
    : { ...common, status, failure: null };
}

it.effect.each(["ack", "output"] as const)(
  "retains non-Claude native %s evidence while ingestion is blocked",
  (evidence) =>
    Effect.gen(function* () {
      const key = `blocked-native-${evidence}`;
      const ids = backgroundScenarioIds(key);
      const progress = yield* ProviderStartProgress.ProviderStartProgress;
      const now = yield* DateTime.now;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* progress.begin({
        threadId: ids.threadId,
        runId: ids.runId,
        attemptId: ids.attemptId,
        attemptOrdinal: 1,
        provider: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        delegated: false,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
      });
      const turn = {
        id: ids.rootProviderTurnId,
        providerThreadId: ids.providerThreadId,
        nodeId: ids.rootNodeId,
        runAttemptId: ids.attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      };
      yield* captureRootRunTermination({
        key,
        nativeSessionId: "codex-native-session",
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () =>
          Stream.fromIterable([
            { type: "provider_turn.updated", driver, providerTurn: turn },
            evidence === "ack"
              ? {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: { ...turn, promptAcceptedAt: now },
                }
              : {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: ids.itemId,
                    type: "reasoning",
                    threadId: ids.threadId,
                    runId: ids.runId,
                    nodeId: ids.rootNodeId,
                    providerThreadId: ids.providerThreadId,
                    providerTurnId: ids.rootProviderTurnId,
                    nativeItemRef: { driver, nativeId: "native-reasoning", strength: "strong" },
                    parentItemId: null,
                    ordinal: 1,
                    status: "running",
                    title: null,
                    startedAt: now,
                    completedAt: null,
                    updatedAt: now,
                    text: "Working",
                    streaming: true,
                  },
                },
            rootTerminalEvent(ids, "completed"),
          ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
        ingestNormalized: ({ event }) =>
          event.type === "provider_turn.updated" &&
          event.providerTurn.promptAcceptedAt !== undefined
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as([]),
              )
            : Effect.succeed([]),
        afterStart: () =>
          Effect.gen(function* () {
            yield* Deferred.await(entered);
            const snapshot = progress.get(ids.runId, ids.attemptId)!;
            assert.isNotNull(snapshot.nativeAcceptedAt);
            assert.equal(snapshot.nativeSessionId, "codex-native-session");
            assert.equal(snapshot.step, "run_ingestion_write");
            assert.isFalse(yield* Deferred.isDone(release));
            yield* Deferred.succeed(release, undefined);
          }),
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    }).pipe(Effect.provide(ProviderStartProgress.layer)),
);

it.effect.each([
  { provider: "cursor", mode: "turn" },
  { provider: "cursor", mode: "paragraph" },
  { provider: "muse", mode: "turn" },
  { provider: "muse", mode: "paragraph" },
  { provider: "pi", mode: "turn" },
  { provider: "pi", mode: "paragraph" },
] as const)(
  "separates native acceptance from buffered output: $provider/$mode",
  ({ provider, mode }) =>
    Effect.gen(function* () {
      const acknowledged = yield* Deferred.make<void>();
      let heldTextWasPersisted = false;
      const now = yield* DateTime.now;
      yield* captureRootRunTermination({
        key: `buffered-start-${provider}`,
        providerDriver: ProviderDriverKind.make(provider),
        responseStreamingMode: mode,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) =>
          Stream.make(
            ...([
              {
                type: "provider_turn.updated",
                driver: ProviderDriverKind.make(provider),
                providerTurn: {
                  id: ids.rootProviderTurnId,
                  providerThreadId: ids.providerThreadId,
                  nodeId: ids.rootNodeId,
                  runAttemptId: ids.attemptId,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              },
              {
                type: "turn_item.updated",
                driver: ProviderDriverKind.make(provider),
                turnItem: {
                  id: TurnItemId.make(`${provider}:native-reasoning`),
                  type: "reasoning",
                  threadId: ids.threadId,
                  runId: ids.runId,
                  nodeId: ids.rootNodeId,
                  providerThreadId: ids.providerThreadId,
                  providerTurnId: ids.rootProviderTurnId,
                  nativeItemRef: {
                    driver: ProviderDriverKind.make(provider),
                    nativeId: "reasoning",
                    strength: "strong",
                  },
                  parentItemId: null,
                  ordinal: 1,
                  status: "running",
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  text: "Still reasoning",
                  streaming: true,
                },
              },
            ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
          ).pipe(
            Stream.concat(
              Stream.fromEffect(
                (provider === "pi" || provider === "muse"
                  ? Effect.void
                  : Deferred.await(acknowledged)
                ).pipe(
                  Effect.andThen(TestClock.adjust("11 minutes")),
                  Effect.as(rootTerminalEvent(ids, "completed")),
                ),
              ),
            ),
          ),
        ingestNormalized: ({ event }) =>
          Effect.gen(function* () {
            if (event.type === "turn_item.updated" && event.turnItem.type === "reasoning")
              heldTextWasPersisted = true;
            if (
              event.type === "provider_turn.updated" &&
              event.providerTurn.promptAcceptedAt !== undefined
            ) {
              assert.isFalse(heldTextWasPersisted);
              yield* Deferred.succeed(acknowledged, undefined);
            }
            return [];
          }),
      });
      assert.equal(yield* Deferred.isDone(acknowledged), provider !== "pi" && provider !== "muse");
      assert.isFalse(heldTextWasPersisted);
    }),
);

it.effect("reserves a held reasoning item's position before an intervening tool", () =>
  Effect.gen(function* () {
    const key = "held-reasoning-position";
    const ids = backgroundScenarioIds(key);
    const providerInstanceId = ProviderInstanceId.make("opencode");
    const reasoningId = TurnItemId.make(`${key}:reasoning`);
    const toolId = TurnItemId.make(`${key}:tool`);
    const done = yield* Deferred.make<void>();
    const positions = yield* Ref.make(new Map<TurnItemId, number>());
    const stored = yield* Ref.make(new Map<TurnItemId, OrchestrationV2TurnItem>());
    const writes = yield* Ref.make<ReadonlyArray<string>>([]);
    const allocate = (itemId: TurnItemId) =>
      Ref.modify(positions, (current) => {
        const existing = current.get(itemId);
        if (existing !== undefined) return [existing, current] as const;
        const ordinal = current.size + 1;
        return [ordinal, new Map(current).set(itemId, ordinal)] as const;
      });
    const base = {
      threadId: ids.threadId,
      runId: ids.runId,
      nodeId: null,
      providerThreadId: ids.providerThreadId,
      providerTurnId: ids.rootProviderTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 999,
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-11-02T12:00:00Z"),
    };
    const reasoning = (
      text: string,
      streaming: boolean,
    ): ProviderAdapter.ProviderAdapterV2Event => ({
      type: "turn_item.updated",
      driver,
      turnItem: {
        ...base,
        id: reasoningId,
        type: "reasoning",
        status: streaming ? "running" : "completed",
        text,
        streaming,
      },
    });
    const tool: ProviderAdapter.ProviderAdapterV2Event = {
      type: "turn_item.updated",
      driver,
      turnItem: {
        ...base,
        id: toolId,
        type: "command_execution",
        status: "completed",
        input: "echo test",
        output: "test\n",
      },
    };
    const events = [
      reasoning("partial", true),
      tool,
      reasoning("First\n\npartial", true),
      reasoning("First\n\nSecond\n\npartial", true),
      reasoning("Exact final 🐈", false),
    ];
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
            allocate: ({ turnItemId }) => allocate(turnItemId),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: () => Effect.succeed([]),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: ({ event }) =>
              Effect.gen(function* () {
                if (event.type === "turn_item.updated") {
                  const ordinal = yield* allocate(event.turnItem.id);
                  yield* Ref.update(stored, (items) =>
                    new Map(items).set(event.turnItem.id, { ...event.turnItem, ordinal }),
                  );
                  if (event.turnItem.type === "reasoning") {
                    const item = event.turnItem;
                    yield* Ref.update(writes, (current) => [...current, item.text]);
                    if (!item.streaming) yield* Deferred.succeed(done, undefined);
                  }
                }
                return [];
              }),
          }),
          ServerSettings.layerTest({ responseStreamingMode: "paragraph" }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* RunExecutionService.RunExecutionServiceV2;
      yield* service.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          events: Stream.fromIterable(events).pipe(Stream.concat(Stream.never)),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint:${key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: { id: ids.providerThreadId, driver } as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make(`message:${key}`),
          text: "Start",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "test" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
        },
      });
      yield* Deferred.await(done);
      assert.deepEqual(yield* Ref.get(writes), ["First\n\n", "Exact final 🐈"]);
      const items = yield* Ref.get(stored);
      assert.equal(items.get(reasoningId)?.ordinal, 1);
      assert.equal(items.get(toolId)?.ordinal, 2);
      const final = items.get(reasoningId);
      assert.isTrue(
        final?.type === "reasoning" && final.text === "Exact final 🐈" && !final.streaming,
      );
    }).pipe(Effect.provide(layerTest));
  }),
);

function runBackgroundItemScenario(
  key: string,
  makeEvents: (ids: BackgroundScenarioIds) => ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  options?: {
    readonly keepEventStreamOpen?: boolean;
    readonly loadInheritedBackgroundTurnItems?: () => Effect.Effect<
      ReadonlyArray<{ readonly id: TurnItemId; readonly runId: RunId }>
    >;
    readonly onSubscribe?: Effect.Effect<void>;
    readonly onEventsConsumed?: Effect.Effect<void>;
    readonly afterEvents?: (
      activity: PreviewAgentActivity.PreviewAgentActivity["Service"],
    ) => Effect.Effect<void>;
    readonly onFinalized?: (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
    ) => Effect.Effect<void>;
  },
) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(key);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const previewActivity = yield* PreviewAgentActivity.PreviewAgentActivity.pipe(
      Effect.provide(PreviewAgentActivity.layer),
    );
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          Layer.succeed(PreviewAgentActivity.PreviewAgentActivity, previewActivity),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === ids.runId,
                  )
                ) {
                  yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                  yield* options?.onFinalized?.(input.events) ?? Effect.void;
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                const event = input.event;
                if (event.type === "turn_item.updated") {
                  yield* Ref.update(observed, (current) => [
                    ...current,
                    `turn_item:${event.turnItem.status}`,
                  ]);
                }
                if (event.type === "subagent.updated") {
                  yield* Ref.update(observed, (current) => [
                    ...current,
                    `subagent:${event.subagent.status}`,
                  ]);
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          events: Stream.empty,
          subscribeEvents: Effect.gen(function* () {
            yield* options?.onSubscribe ?? Effect.void;
            const events = Stream.fromIterable(makeEvents(ids)).pipe(
              Stream.concat(
                Stream.fromEffect(
                  Effect.andThen(
                    options?.onEventsConsumed ?? Effect.void,
                    options?.afterEvents?.(previewActivity) ?? Effect.void,
                  ),
                ).pipe(Stream.drain),
              ),
            );
            return {
              events:
                options?.keepEventStreamOpen === true
                  ? events.pipe(Stream.concat(Stream.never))
                  : events,
              close: Deferred.succeed(ingestionDone, undefined),
            };
          }),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ids.providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        ...(options?.loadInheritedBackgroundTurnItems === undefined
          ? {}
          : {
              loadInheritedBackgroundTurnItems: options.loadInheritedBackgroundTurnItems,
            }),
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make(`message:${key}:user`),
          text: "Start a background item and finish.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(layerTest));

    const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
    assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");
    return yield* Ref.get(observed);
  });
}

it.effect("keeps a failed root's still-running native children live while the run settles", () =>
  Effect.gen(function* () {
    const finalized = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const childTurn = (
      ids: BackgroundScenarioIds,
      status: "running" | "completed",
    ): ProviderAdapter.ProviderAdapterV2Event =>
      ({
        type: "provider_turn.updated",
        driver,
        threadId: ids.childThreadId,
        providerTurn: {
          id: ProviderTurnId.make(`${ids.rootProviderTurnId}:child`),
          providerThreadId: ProviderThreadId.make(`${ids.providerThreadId}:child`),
          nodeId: NodeId.make(`${ids.subagentNodeId}:child-root`),
          runAttemptId: null,
          status,
        },
      }) as ProviderAdapter.ProviderAdapterV2Event;
    const observed = yield* runBackgroundItemScenario(
      "failed-root-live-child",
      (ids) => [
        childThreadCreatedEvent(ids),
        subagentEvent(ids, "running"),
        childTurn(ids, "running"),
        { ...rootTerminalEvent(ids, "failed"), childTurnsContinue: true },
        subagentEvent(ids, "completed"),
        childTurn(ids, "completed"),
      ],
      {
        keepEventStreamOpen: true,
        onFinalized: (events) => Ref.set(finalized, events),
      },
    );

    assert.deepEqual(observed, ["subagent:running", "root-finalized", "subagent:completed"]);
    const written = yield* Ref.get(finalized);
    assert.deepEqual(
      written.flatMap((event) => (event.type === "run.updated" ? [event.payload.status] : [])),
      ["failed"],
    );
    assert.isFalse(
      written.some((event) => event.type === "subagent.updated"),
      "a child that outlives the failed root must not be settled with it",
    );
  }),
);

it.effect("releases ingestion after idle subagent rows and items settle", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario(
      "subagent-idle",
      (ids) => [
        subagentEvent(ids, "running"),
        backgroundTurnItemEvent(ids, "subagent", "running", 1),
        subagentEvent(ids, "idle"),
        backgroundTurnItemEvent(ids, "subagent", "idle", 2),
        rootTerminalEvent(ids, "completed"),
      ],
      { keepEventStreamOpen: true },
    );
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "subagent:idle",
      "turn_item:idle",
      "root-finalized",
    ]);
  }),
);

it.effect.each([
  "transient",
  "auth_expired",
  "model_invalid",
  "quota",
  "context_exhausted",
] as const)("resumes delegated exhaustion only for transient failures: %s", (category) =>
  Effect.gen(function* () {
    const result = yield* captureRootRunTermination({
      key: `recovery-${category}`,
      delegated: true,
      shouldFinalizeRun: () => Effect.succeed(true),
      providerStartDeadlineAt: DateTime.makeUnsafe(0),
      events: (ids) =>
        Stream.make({
          ...rootTerminalEvent(ids, "failed"),
          status: "failed" as const,
          failureItemOrdinal: 101,
          failure: {
            class: "provider_error" as const,
            category,
            code: "api_error_529",
            retryable: null,
            message: "Claude gave up after repeated API errors. Last error: 529 overloaded.",
          },
          threadDisposition: "reusable" as const,
        }),
    });
    const resumes = result.committedEffects.filter((effect) =>
      effect.id.startsWith("effect:delegated-transient-resume:"),
    );
    assert.lengthOf(resumes, category === "transient" ? 1 : 0);
    if (category === "transient") {
      const run = result.finalEvents.findLast((event) => event.type === "run.updated");
      assert.equal(run?.payload.status, "starting");
      if (run?.type === "run.updated")
        assert.include(run.payload.transientRecovery?.firstError.message ?? "", "529");
      assert.isUndefined(run?.payload.providerStartDeadlineAt);
    }
  }),
);

it.effect.each(
  ["claude_no_response_budget", "claude_retry_flap", "claude_network_error"].flatMap((code) =>
    [true, false].map((retryable) => ({ code, retryable })),
  ),
)(
  "resumes a coded Claude failure once only when retryable: $code/$retryable",
  ({ code, retryable }) =>
    Effect.gen(function* () {
      for (const resumed of [false, true]) {
        const result = yield* captureRootRunTermination({
          key: `${code}-${retryable}-${resumed}`,
          delegated: true,
          ...(resumed
            ? {
                recoveryRun: {
                  firstError: {
                    class: "transport_error" as const,
                    category: "transient" as const,
                    code,
                    retryable: true,
                    message: "First: Request timed out",
                  },
                  since: DateTime.formatIso(yield* DateTime.now),
                },
              }
            : {}),
          shouldFinalizeRun: () => Effect.succeed(true),
          events: (ids) =>
            Stream.make({
              ...rootTerminalEvent(ids, "failed"),
              status: "failed" as const,
              failureItemOrdinal: 101,
              threadDisposition: "reusable" as const,
              failure: {
                class: "transport_error" as const,
                category: "transient" as const,
                code,
                retryable,
                message: "Second: upstream connection lost",
              },
            }),
        });
        assert.lengthOf(
          result.committedEffects.filter((effect) =>
            effect.id.startsWith("effect:delegated-transient-resume:"),
          ),
          resumed || !retryable ? 0 : 1,
        );
        if (resumed) {
          const errors = result.finalEvents.filter(
            (event) => event.type === "turn-item.updated" && event.payload.type === "error",
          );
          assert.isTrue(
            errors.some(
              (event) =>
                event.type === "turn-item.updated" &&
                event.payload.type === "error" &&
                event.payload.failure.message.includes("First: Request timed out") &&
                event.payload.failure.message.includes("Second: upstream connection lost"),
            ),
          );
        }
      }
    }),
);

it.effect.each(
  ["claude_no_response_budget", "claude_retry_flap", "claude_network_error"].flatMap((code) =>
    (["first_event", "post_tool"] as const).flatMap((phase) =>
      [undefined, "Please relay: ready", "[Watcher event from build] Ready"].map((relayText) => ({
        code,
        phase,
        relayText,
      })),
    ),
  ),
)(
  "a previous silent recovery blocks coded network and relay replay: $phase/$code/$relayText",
  ({ code, phase, relayText }) =>
    Effect.gen(function* () {
      const result = yield* captureRootRunTermination({
        key: `silent-then-network-${phase}-${code}-${relayText ?? "work"}`,
        delegated: true,
        providerDriver: ProviderDriverKind.make("claudeAgent"),
        model: "claude-haiku-5-5",
        ...(relayText === undefined ? {} : { relayText }),
        stallRecovery: {
          phase,
          lastProgressAt: DateTime.formatIso(yield* DateTime.now),
          attemptId: null,
        },
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) =>
          Stream.make({
            ...rootTerminalEvent(ids, "failed"),
            status: "failed" as const,
            failureItemOrdinal: 101,
            threadDisposition: "reusable" as const,
            failure: {
              class: "transport_error" as const,
              category: "transient" as const,
              code,
              retryable: true,
              message: "Connection dropped (ECONNRESET)",
              claudeAccess: {
                status: null,
                beforeResponse: true,
                refusalFree: true,
                refused: false,
              },
            },
          }),
      });
      assert.isFalse(
        result.committedEffects.some((effect) => effect.request.type === "provider-turn.start"),
      );
      const run = result.finalEvents.findLast((event) => event.type === "run.updated");
      assert.equal(run?.payload.status, "failed");
      assert.isUndefined(run?.payload.transientRecovery);
      assert.isUndefined(run?.payload.launchRecovery);
    }),
);

it.effect.each([
  "app_owned",
  "provider_native",
  "missing",
  "other_child",
  "other_task",
  "read_error",
] as const)("checks the parent's task record for a legacy child: %s", (legacyOwnership) =>
  Effect.gen(function* () {
    const result = yield* captureRootRunTermination({
      key: `legacy-recovery-${legacyOwnership}`,
      delegated: true,
      legacyOwnership,
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.make({
          ...rootTerminalEvent(ids, "failed"),
          status: "failed" as const,
          failureItemOrdinal: 101,
          failure: {
            class: "provider_error" as const,
            category: "transient" as const,
            code: "api_error_529",
            retryable: true,
            message: "Claude gave up after repeated API errors. Last error: 529 overloaded.",
          },
        }),
    });
    const resumes = result.committedEffects.filter((effect) =>
      effect.id.startsWith("effect:delegated-transient-resume:"),
    );
    assert.lengthOf(resumes, legacyOwnership === "app_owned" ? 1 : 0);
  }),
);

it.effect("stops a second delegated failure and reports both errors", () =>
  Effect.gen(function* () {
    const result = yield* captureRootRunTermination({
      key: "second-recovery",
      delegated: true,
      recoveryRun: {
        firstError: {
          class: "provider_error",
          category: "transient",
          code: "api_error_529",
          retryable: true,
          message: "529 overloaded",
        },
        since: DateTime.formatIso(yield* DateTime.now),
      },
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.make({
          ...rootTerminalEvent(ids, "failed"),
          status: "failed" as const,
          failureItemOrdinal: 101,
          failure: {
            class: "provider_error" as const,
            category: "transient" as const,
            code: "api_error_502",
            retryable: true,
            message: "502 connection reset",
          },
          threadDisposition: "reusable" as const,
        }),
    });
    assert.lengthOf(result.committedEffects, 0);
    const error = result.written.find((item) => item.type === "error");
    assert.include(error?.failure.message ?? "", "529 overloaded");
    assert.include(error?.failure.message ?? "", "502 connection reset");
  }),
);

it.effect("retains the first failure when the resumed provider throws at startup", () =>
  Effect.gen(function* () {
    const result = yield* captureRootRunTermination({
      key: "recovery-start-throws",
      afterStart: (closed) => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
      delegated: true,
      recoveryRun: {
        firstError: {
          class: "provider_error",
          category: "transient",
          code: "api_error_529",
          retryable: true,
          message: "529 overloaded",
        },
        since: "2026-11-08T10:00:00.000Z",
      },
      shouldFinalizeRun: () => Effect.succeed(true),
      startTurn: () =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterTurnStartError({
            driver,
            threadId: ThreadId.make("thread:recovery-start-throws"),
            providerThreadId: ProviderThreadId.make("provider-thread:recovery-start-throws"),
            runId: RunId.make("run:recovery-start-throws"),
            cause: "resume failed",
          }),
        ),
    });
    const error = result.written.find((item) => item.type === "error");
    assert.include(error?.type === "error" ? error.failure.message : "", "529 overloaded");
    assert.include(error?.type === "error" ? error.failure.message : "", "Resume error:");
    assert.lengthOf(result.committedEffects, 0);
  }),
);

it.effect.each([
  { driverKind: "codex", stale: false, compact: false },
  { driverKind: "codex", stale: true, compact: false },
  { driverKind: "codex", stale: true, compact: true },
  { driverKind: "claudeAgent", stale: false, compact: false },
  { driverKind: "claudeAgent", stale: true, compact: false },
  { driverKind: "claudeAgent", stale: true, compact: true },
])("forces Standard at the unconditional provider boundary: %j", ({ driverKind, stale, compact }) =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const started = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2TurnInput>();
    const threadId = ThreadId.make("thread:run-execution-app-context");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const attemptId = RunAttemptId.make("attempt:run-execution-app-context");
    const session = {
      driver: ProviderDriverKind.make(driverKind),
      events: Stream.never,
      compactThread: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        Deferred.succeed(started, input),
      startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        Deferred.succeed(started, input),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;

    yield* runExecution.startRootRun({
      commandId: CommandId.make("command:run-execution-app-context"),
      appThread: { id: threadId } as OrchestrationV2AppThread,
      providerSessionId: ProviderSessionId.make("session:run-execution-app-context"),
      session,
      run: {
        id: RunId.make("run:run-execution-app-context"),
        threadId,
        ordinal: 1,
        providerInstanceId,
      } as OrchestrationV2Run,
      rootNode: {
        id: NodeId.make("node:run-execution-app-context"),
      } as OrchestrationV2ExecutionNode,
      checkpointScope: {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-app-context"),
      } as OrchestrationV2CheckpointScope,
      providerThread: {
        id: ProviderThreadId.make("provider-thread:run-execution-app-context"),
        driver,
      } as OrchestrationV2ProviderThread,
      attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
      attemptId,
      providerTurnOrdinal: 1,
      message: {
        messageId: MessageId.make("message:run-execution-app-context"),
        text: compact ? "/compact" : "What is on my list?",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: {
        instanceId: providerInstanceId,
        model: "gpt-6-sol",
        options: stale
          ? [
              driverKind === "codex"
                ? { id: "serviceTier", value: "priority" }
                : { id: "fastMode", value: true },
            ]
          : [],
      },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: process.cwd() },
    });

    const input = yield* Deferred.await(started);
    assert.deepEqual(input.modelSelection.options, [
      driverKind === "codex"
        ? { id: "serviceTier", value: "default" }
        : { id: "fastMode", value: false },
    ]);
  }).pipe(Effect.provide(layerRunExecutionTest)),
);

it.effect.each([
  { model: "claude-haiku-5-5", prior: 0, expected: "claude-haiku-5-5" },
  { model: "claude-haiku-5-5", prior: 1, expected: "claude-sonnet-5-5" },
  { model: "claude-sonnet-5-5", prior: 1, expected: "claude-opus-5-5" },
  { model: "claude-opus-5-5", prior: 1, expected: undefined },
])(
  "recovers a first-turn model access failure: $model retry=$prior",
  ({ model, prior, expected }) =>
    Effect.gen(function* () {
      const result = yield* captureRootRunTermination({
        key: `access-${model}-${prior}`,
        delegated: true,
        providerDriver: ProviderDriverKind.make("claudeAgent"),
        model,
        ...(prior === 0
          ? {}
          : {
              launchRecovery: {
                kind: "model_access" as const,
                retriesOnModel: prior,
                attempt: 1,
                delayMs: 20_000,
                since: "2026-11-13T00:00:00Z",
              },
            }),
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) =>
          Stream.make({
            ...rootTerminalEvent(ids, "failed"),
            status: "failed" as const,
            failureItemOrdinal: 101,
            failure: {
              class: "provider_error" as const,
              code: "model_not_found",
              category: "model_invalid" as const,
              retryable: null,
              message: "There's an issue with the selected model.",
              claudeAccess: {
                status: 401,
                beforeResponse: true,
                refusalFree: true,
                refused: false,
              },
            },
            threadDisposition: "reusable" as const,
          }),
      });
      const retries = result.committedEffects.filter((effect) =>
        effect.id.startsWith("effect:launch-recovery:"),
      );
      assert.lengthOf(retries, expected === undefined ? 0 : 1);
      if (expected !== undefined) {
        const event = result.finalEvents.findLast((event) => event.type === "run.updated");
        assert.equal(event?.payload.status, "starting");
        if (event?.type === "run.updated")
          assert.equal(event.payload.modelSelection.model, expected);
        const request = retries[0]?.request;
        if (request?.type === "provider-turn.start")
          assert.isAtLeast(request.retryDelayMs ?? 0, 20_000);
      }
    }),
);

it.effect.each(
  ["[Watcher event from build] Ready", "Please relay: ready"].flatMap((relayText) =>
    [null, 401, 403, 404, 429].map((status) => ({ relayText, status })),
  ),
)("honors permanent relay evidence in the outbox: $relayText/$status", ({ relayText, status }) =>
  Effect.gen(function* () {
    for (const delegated of [false, true]) {
      for (const retryable of [false, true]) {
        const result = yield* captureRootRunTermination({
          key: `relay-veto-${relayText}-${status}-${delegated}-${retryable}`,
          relayText,
          delegated,
          model: "claude-haiku-5-5",
          providerDriver: ProviderDriverKind.make("claudeAgent"),
          shouldFinalizeRun: () => Effect.succeed(true),
          events: (ids) =>
            Stream.make({
              ...rootTerminalEvent(ids, "failed"),
              status: "failed" as const,
              failureItemOrdinal: 101,
              threadDisposition: "reusable" as const,
              failure: {
                class: "transport_error" as const,
                category: "transient" as const,
                code: "claude_network_error",
                retryable,
                message: "Request timed out.",
                claudeAccess: { status, beforeResponse: true, refusalFree: true, refused: false },
              },
            }),
        });
        assert.lengthOf(
          result.committedEffects.filter((effect) => effect.request.type === "provider-turn.start"),
          retryable ? 1 : 0,
        );
        if (!retryable) {
          const run = result.finalEvents.findLast((event) => event.type === "run.updated");
          assert.equal(run?.payload.status, "failed");
          assert.isUndefined(run?.payload.transientRecovery);
          assert.isUndefined(run?.payload.launchRecovery);
        }
      }
    }
  }),
);

it.effect.each([false, true])("retries an unsent relay once, refusal=%s", (refused) =>
  Effect.gen(function* () {
    for (const alreadyRetried of [false, true]) {
      const result = yield* captureRootRunTermination({
        key: `relay-${refused}-${alreadyRetried}`,
        relayText: "Please relay: iPhone is ready",
        providerDriver: ProviderDriverKind.make("claudeAgent"),
        ...(alreadyRetried
          ? {
              launchRecovery: {
                kind: "relay" as const,
                retriesOnModel: 1,
                attempt: 1,
                delayMs: 20_000,
                since: "2026-11-13T00:00:00Z",
              },
            }
          : {}),
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) =>
          Stream.make({
            ...rootTerminalEvent(ids, "failed"),
            status: "failed" as const,
            failureItemOrdinal: 101,
            failure: {
              class: "provider_error" as const,
              code: "api_error_401",
              category: "auth_expired" as const,
              retryable: null,
              message: "selected model (claude-opus-4-8)",
              claudeAccess: { status: 401, beforeResponse: true, refusalFree: !refused, refused },
            },
            threadDisposition: "reusable" as const,
          }),
      });
      assert.lengthOf(
        result.committedEffects.filter((effect) => effect.id.startsWith("effect:launch-recovery:")),
        !refused && !alreadyRetried ? 1 : 0,
      );
    }
  }),
);

it.effect.each([500, 502, null])("does not send a third delegated relay after %s", (status) =>
  Effect.gen(function* () {
    for (const alreadyRetried of [false, true]) {
      const result = yield* captureRootRunTermination({
        key: `relay-cap-${status}-${alreadyRetried}`,
        delegated: true,
        relayText: "[Watcher event from build] Please relay: ready",
        providerDriver: ProviderDriverKind.make("claudeAgent"),
        ...(alreadyRetried
          ? {
              launchRecovery: {
                kind: "relay" as const,
                retriesOnModel: 1,
                attempt: 1,
                delayMs: 30_000,
                since: "2026-11-13T00:00:00Z",
              },
            }
          : {}),
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) =>
          Stream.make({
            ...rootTerminalEvent(ids, "failed"),
            status: "failed" as const,
            failureItemOrdinal: 101,
            failure: {
              class: "provider_error" as const,
              category: "transient" as const,
              code: "api_error_500",
              retryable: true,
              message: "Claude gave up after repeated API errors. Last error: 500",
              claudeAccess: { status, beforeResponse: true, refusalFree: true, refused: false },
            },
            threadDisposition: "reusable" as const,
          }),
      });
      const starts = result.committedEffects.filter(
        (effect) => effect.request.type === "provider-turn.start",
      );
      assert.lengthOf(starts, alreadyRetried ? 0 : 1);
      if (alreadyRetried)
        assert.equal(
          result.finalEvents.findLast((event) => event.type === "run.updated")?.payload.status,
          "failed",
        );
    }
  }),
);

it.effect.each([401, 403, 404, 429])(
  "caps an access-failing delegated relay at one retry: %s",
  (status) =>
    Effect.gen(function* () {
      for (const alreadyRetried of [false, true]) {
        const result = yield* captureRootRunTermination({
          key: `relay-access-cap-${status}-${alreadyRetried}`,
          delegated: true,
          model: "claude-haiku-5-5",
          relayText: "[Watcher event from build] Please relay: ready",
          providerDriver: ProviderDriverKind.make("claudeAgent"),
          ...(alreadyRetried
            ? {
                launchRecovery: {
                  kind: "relay" as const,
                  replayAllowed: true,
                  retriesOnModel: 1,
                  attempt: 1,
                  delayMs: 30_000,
                  since: "2026-11-13T00:00:00Z",
                },
              }
            : {}),
          shouldFinalizeRun: () => Effect.succeed(true),
          events: (ids) =>
            Stream.make({
              ...rootTerminalEvent(ids, "failed"),
              status: "failed" as const,
              failureItemOrdinal: 101,
              failure: {
                class: "provider_error" as const,
                category: "transient" as const,
                code: "api_error_401",
                retryable: true,
                message: "Claude gave up after repeated API errors.",
                claudeAccess: { status, beforeResponse: true, refusalFree: true, refused: false },
              },
              threadDisposition: "reusable" as const,
            }),
        });
        const starts = result.committedEffects.filter(
          (effect) => effect.request.type === "provider-turn.start",
        );
        assert.lengthOf(starts, alreadyRetried ? 0 : 1);
        const event = result.finalEvents.findLast((event) => event.type === "run.updated");
        if (!alreadyRetried && event?.type === "run.updated") {
          assert.equal(event.payload.launchRecovery?.kind, "relay");
          assert.equal(event.payload.modelSelection.model, "claude-haiku-5-5");
        }
      }
    }),
);

it.effect.each([false, true])(
  "keeps session refusal exclusion if terminal evidence is lost: %s",
  (sessionRefused) =>
    Effect.gen(function* () {
      const result = yield* captureRootRunTermination({
        key: `session-refusal-${sessionRefused}`,
        delegated: true,
        sessionRefused,
        providerDriver: ProviderDriverKind.make("claudeAgent"),
        model: "claude-haiku-5-5",
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) =>
          Stream.make({
            ...rootTerminalEvent(ids, "failed"),
            status: "failed" as const,
            failureItemOrdinal: 101,
            failure: {
              class: "provider_error" as const,
              category: "transient" as const,
              code: "api_error_502",
              retryable: true,
              message: "Claude gave up after repeated API errors. Last error: 502",
            },
            threadDisposition: "reusable" as const,
          }),
      });
      assert.lengthOf(
        result.committedEffects.filter((effect) => effect.request.type === "provider-turn.start"),
        sessionRefused ? 0 : 1,
      );
    }),
);

it.effect.each([500, 502, null])(
  "preserves ordinary mid-task resume after first-turn recovery: %s",
  (status) =>
    Effect.gen(function* () {
      for (const phase of [
        "none",
        "pending",
        "responded",
        "continued",
        "relay",
        "already_resumed",
      ] as const) {
        const beforeResponse = phase !== "responded" && phase !== "already_resumed";
        const replayAllowed = phase !== "continued";
        const result = yield* captureRootRunTermination({
          key: `existing-resume-${status}-${phase}`,
          delegated: true,
          model: "claude-sonnet-5-5",
          providerDriver: ProviderDriverKind.make("claudeAgent"),
          ...(phase === "none"
            ? {}
            : {
                launchRecovery: {
                  kind: phase === "relay" ? ("relay" as const) : ("model_access" as const),
                  replayAllowed,
                  retriesOnModel: 1,
                  attempt: 3,
                  delayMs: 30_000,
                  since: "2026-11-13T00:00:00Z",
                },
              }),
          ...(phase === "already_resumed"
            ? {
                recoveryRun: {
                  firstError: {
                    class: "provider_error" as const,
                    category: "transient" as const,
                    code: "api_error_transport",
                    retryable: true,
                    message: "First transient failure",
                  },
                  since: "2026-11-13T00:00:00Z",
                },
              }
            : {}),
          shouldFinalizeRun: () => Effect.succeed(true),
          events: (ids) =>
            Stream.make({
              ...rootTerminalEvent(ids, "failed"),
              status: "failed" as const,
              failureItemOrdinal: 101,
              failure: {
                class: "provider_error" as const,
                category: "transient" as const,
                code: "api_error_transport",
                retryable: true,
                message: "Claude gave up after repeated API errors. Last error: transport",
                claudeAccess: { status, beforeResponse, refusalFree: true, refused: false },
              },
              threadDisposition: "reusable" as const,
            }),
        });
        const starts = result.committedEffects.filter(
          (effect) => effect.request.type === "provider-turn.start",
        );
        const expected = phase === "none" || phase === "responded" || phase === "continued";
        assert.lengthOf(starts, expected ? 1 : 0);
        if (expected) assert.isTrue(starts[0]!.id.startsWith("effect:delegated-transient-resume:"));
      }
    }),
);

it.effect.each(["decision", "commit", "dispatch", "read_error"] as const)(
  "excludes a durable refusal at recovery %s",
  (stage) =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      const silent = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const result = yield* captureRootRunTermination({
        key: `durable-refusal-${stage}`,
        delegated: true,
        sessionRefused: false,
        providerDriver: ProviderDriverKind.make("claudeAgent"),
        model: "claude-haiku-5-5",
        durableRefusal: stage === "read_error" ? "read_error" : stage !== "commit",
        rejectRecoveryWrite: stage === "commit",
        ...(stage === "dispatch" || stage === "read_error"
          ? {
              launchRecovery: {
                kind: "relay" as const,
                replayAllowed: true,
                retriesOnModel: 1,
                attempt: 1,
                delayMs: 30000,
                since: "2026-11-12T12:00:00Z",
              },
            }
          : {}),
        shouldFinalizeRun: () => Effect.succeed(true),
        startTurn: () => Ref.update(starts, (n) => n + 1),
        events: (ids) =>
          stage === "dispatch" || stage === "read_error"
            ? Stream.fromQueue(silent)
            : Stream.make({
                ...rootTerminalEvent(ids, "failed"),
                status: "failed" as const,
                failureItemOrdinal: 101,
                failure: {
                  class: "provider_error" as const,
                  category: "auth_expired" as const,
                  code: "api_error_401",
                  retryable: false,
                  message: "Access failed",
                  claudeAccess: {
                    status: 401,
                    beforeResponse: true,
                    refusalFree: true,
                    refused: false,
                  },
                },
                threadDisposition: "reusable" as const,
              }),
      });
      assert.lengthOf(
        result.committedEffects.filter((effect) => effect.request.type === "provider-turn.start"),
        0,
      );
      assert.isTrue(
        result.finalEvents.some(
          (event) => event.type === "run.updated" && event.payload.status === "failed",
        ),
      );
      if (stage === "dispatch" || stage === "read_error") assert.equal(yield* Ref.get(starts), 0);
    }),
);

it.effect.each(["refusal", "ownership"] as const)(
  "closes recovery ingestion when cancellation interrupts the %s read",
  (phase) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const activity = yield* Deferred.make<Effect.Effect<boolean>>();
      const closes = yield* Ref.make(0);
      const ownershipReads = yield* Ref.make(0);
      const silent = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
      const startup = yield* captureRootRunTermination({
        key: `recovery-cancellation-${phase}`,
        providerDriver: ProviderDriverKind.make("claudeAgent"),
        launchRecovery: {
          kind: "relay",
          replayAllowed: true,
          retriesOnModel: 1,
          attempt: 1,
          delayMs: 30000,
          since: "2026-11-13T00:00:00Z",
        },
        captureActivity: (active) => Deferred.succeed(activity, active).pipe(Effect.asVoid),
        shouldFinalizeRun: () => Effect.succeed(true),
        shouldStartProviderTurn: () =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(ownershipReads, (n) => n + 1);
            if (phase === "ownership" && n > 1) {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }
            return true;
          }),
        refusalRead: () =>
          phase === "ownership"
            ? Effect.succeed(false)
            : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        onSubscriptionClose: Ref.update(closes, (n) => n + 1).pipe(
          Effect.andThen(Deferred.succeed(closed, undefined)),
        ),
        events: () => Stream.fromQueue(silent),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(startup);
      const closedOnCancel = yield* Ref.get(closes);
      const activeAfterCancel = yield* yield* Deferred.await(activity);
      // End the isolated source even if the cleanup assertion fails.
      yield* Queue.end(silent);
      yield* Deferred.await(closed);
      assert.equal(closedOnCancel, 1);
      assert.isFalse(activeAfterCancel);
    }),
);

it.effect.each(["failed", "interrupted"] as const)(
  "rechecks recovery ownership after ingestion becomes %s during the refusal read",
  (status) =>
    Effect.gen(function* () {
      const refusalReadStarted = yield* Deferred.make<void>();
      const runFinalized = yield* Deferred.make<void>();
      const current = yield* Ref.make(true);
      const starts = yield* Ref.make(0);
      const result = yield* captureRootRunTermination({
        key: `recovery-ownership-during-refusal-${status}`,
        providerDriver: ProviderDriverKind.make("claudeAgent"),
        launchRecovery: {
          kind: "relay",
          replayAllowed: true,
          retriesOnModel: 1,
          attempt: 1,
          delayMs: 30000,
          since: "2026-11-13T00:00:00Z",
        },
        shouldFinalizeRun: () => Ref.get(current),
        shouldStartProviderTurn: () => Ref.get(current),
        admissionRead: () =>
          Deferred.succeed(refusalReadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(runFinalized)),
            Effect.andThen(Ref.get(current)),
            Effect.map((current) => ({ current, refused: false })),
          ),
        refreshAfterTurn: Ref.set(current, false).pipe(
          Effect.andThen(Deferred.succeed(runFinalized, undefined)),
        ),
        startTurn: () => Ref.update(starts, (n) => n + 1),
        events: (ids) =>
          Stream.unwrap(
            Deferred.await(refusalReadStarted).pipe(
              Effect.as(
                status === "failed" ? Stream.empty : Stream.make(rootTerminalEvent(ids, status)),
              ),
            ),
          ),
      });
      assert.deepEqual(result.observed, [`run:${status}`, "pull-requests-refreshed"]);
      assert.equal(yield* Ref.get(starts), 0);
    }),
);

it.effect.each(
  (["relay", "model_access", "transient"] as const).flatMap((kind) =>
    [false, true].map((refused) => ({ kind, refused })),
  ),
)("excludes a refusal observed during recovery admission: $kind/$refused", ({ kind, refused }) =>
  Effect.gen(function* () {
    const key = `r9-refusal-during-ownership-${kind}-${refused}`;
    const ids = backgroundScenarioIds(key);
    const driver = ProviderDriverKind.make("claudeAgent");
    const durableMarker = yield* Ref.make(false);
    const ownershipReads = yield* Ref.make(0);
    const markerIngestions = yield* Ref.make(0);
    const markerIngested = yield* Deferred.make<void>();
    const sends = yield* Ref.make<ReadonlyArray<{ refused: boolean }>>([]);
    const source = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
    const marker = {
      type: "provider_thread.updated",
      driver,
      providerThread: {
        id: ids.providerThreadId,
        appThreadId: ids.threadId,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        driver,
        status: "idle",
        nativeThreadRef: { driver, nativeId: "r9-current-native", strength: "strong" },
        nativeMetadata: { claudeRefusalObserved: refused },
      } as OrchestrationV2ProviderThread,
    } as const;
    const result = yield* captureRootRunTermination({
      key,
      providerDriver: driver,
      sessionRefused: false,
      ...(kind === "transient"
        ? {
            recoveryRun: {
              firstError: {
                class: "provider_error",
                category: "transient",
                code: "api_error_502",
                retryable: true,
                message: "502",
              },
              since: "2026-11-13T00:00:00Z",
            },
          }
        : {
            launchRecovery: {
              kind,
              replayAllowed: true,
              retriesOnModel: 1,
              attempt: 1,
              delayMs: 30000,
              since: "2026-11-13T00:00:00Z",
            },
          }),
      shouldFinalizeRun: () => Effect.succeed(true),
      refusalRead: () => Ref.get(durableMarker),
      shouldStartProviderTurn: () =>
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(ownershipReads, (n) => n + 1);
          if (n === 2) {
            // Hold the final run-control read while native-session history is persisted.
            // The second receipt proves the first event also refreshed ingestion's local snapshot.
            yield* Queue.offer(source, marker);
            yield* Queue.offer(source, marker);
            yield* Deferred.await(markerIngested);
          }
          return true;
        }),
      ingestNormalized: ({ event }) =>
        Effect.gen(function* () {
          if (event.type === "provider_thread.updated") {
            yield* Ref.set(
              durableMarker,
              event.providerThread.nativeMetadata?.claudeRefusalObserved === true,
            );
            const n = yield* Ref.updateAndGet(markerIngestions, (n) => n + 1);
            if (n === 2) yield* Deferred.succeed(markerIngested, undefined);
            return [
              {
                sequence: n,
                commandId: null,
                event: {
                  id: EventId.make(`event:${key}:marker:${n}`),
                  type: "provider-thread.updated",
                  threadId: ids.threadId,
                  driver,
                  providerInstanceId: event.providerThread.providerInstanceId,
                  occurredAt: yield* DateTime.now,
                  payload: event.providerThread,
                },
              },
            ] satisfies ReadonlyArray<OrchestrationV2StoredEvent>;
          }
          return [];
        }),
      startTurn: () =>
        Effect.gen(function* () {
          const atSend = yield* Ref.get(durableMarker);
          yield* Ref.update(sends, (current) => [...current, { refused: atSend }]);
        }),
      events: () => Stream.fromQueue(source),
      afterStart: () =>
        Queue.offer(source, rootTerminalEvent(ids, "completed")).pipe(Effect.asVoid),
    });
    yield* Queue.end(source);
    const actual = yield* Ref.get(sends);
    assert.equal(
      actual.length,
      refused ? 0 : 1,
      "a durable native refusal observed before dispatch must exclude an automatic resend",
    );
    if (refused) assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
  }),
);

it.effect("keeps a stale recovery from replacing the active steering attempt's Stop fallback", () =>
  Effect.gen(function* () {
    const key = "usage:recovery-steering-stop";
    const ids = backgroundScenarioIds(key);
    const next = {
      ...ids,
      attemptId: RunAttemptId.make("attempt:steering:active"),
      rootProviderTurnId: ProviderTurnId.make("provider-turn:steering:active"),
    };
    const recoveryEntered = yield* Deferred.make<void>();
    const resumeRecovery = yield* Deferred.make<void>();
    const stopCommitted = yield* Deferred.make<void>();
    const stopProcessed = yield* Deferred.make<void>();
    const activeClosed = yield* Deferred.make<void>();
    const activeEvents = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const rows: AnalyticsEvent[] = [];
    let current: "recovery" | "steering" | "stopped" = "recovery";
    const usage = (owner: BackgroundScenarioIds, inputTokens: number) => ({
      type: "provider_turn.updated" as const,
      driver,
      providerTurn: {
        id: owner.rootProviderTurnId,
        providerThreadId: owner.providerThreadId,
        nodeId: owner.rootNodeId,
        runAttemptId: owner.attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed" as const,
        startedAt: null,
        completedAt: null,
        finish: null,
        turnTokenUsage: {
          usageScope: "main_agent" as const,
          usageStatus: "complete" as const,
          inputTokens,
          outputTokens: 10,
          hasSubagents: false,
        },
      },
    });
    yield* captureRootRunTermination({
      key,
      delegated: true,
      legacyOwnership: "app_owned",
      loadDelegatedTask: () =>
        Deferred.succeed(recoveryEntered, undefined).pipe(
          Effect.andThen(Deferred.await(resumeRecovery)),
          Effect.as({ id: ids.subagentNodeId, origin: "app_owned", childThreadId: ids.threadId }),
        ),
      shouldFinalizeRun: () => Effect.sync(() => current === "recovery"),
      rejectTerminalWriteForAttempt: ids.attemptId,
      recordUsage: (event) =>
        Effect.sync(() => {
          rows.push(event);
        }),
      events: () =>
        Stream.make(usage(ids, 123), {
          ...rootTerminalEvent(ids, "failed"),
          status: "failed" as const,
          failureItemOrdinal: 101,
          failure: {
            class: "provider_error" as const,
            category: "transient" as const,
            code: "api_error_529",
            retryable: true,
            message: "Claude gave up after repeated API errors. Last error: 529 overloaded.",
          },
        }),
      runUpdates: Stream.fromEffect(Deferred.await(stopCommitted)).pipe(
        Stream.flatMap(() =>
          Stream.make({
            sequence: 1,
            commandId: null,
            event: {
              id: EventId.make("event:recovery-steering-stop"),
              type: "run.updated" as const,
              threadId: ids.threadId,
              occurredAt: DateTime.makeUnsafe("2026-11-13T00:00:00Z"),
              payload: { id: ids.runId, status: "interrupted" } as OrchestrationV2Run,
            },
          }),
        ),
        // The next stream starts after the listener has handled the Stop event.
        Stream.concat(
          Stream.fromEffect(Deferred.succeed(stopProcessed, undefined)).pipe(Stream.drain),
        ),
      ),
      afterStart: (recoveryClosed, execution, _ids, controls) =>
        Effect.gen(function* () {
          yield* Deferred.await(recoveryEntered);
          current = "steering";
          yield* execution
            .startRootRun({
              ...controls,
              attempt: {
                ...controls.attempt,
                id: next.attemptId,
                providerTurnId: next.rootProviderTurnId,
                reason: "steering_restart",
              },
              attemptId: next.attemptId,
              shouldFinalizeRun: () => Effect.sync(() => current === "steering"),
              session: {
                ...controls.session,
                subscribeEvents: Effect.succeed({
                  events: Stream.fromQueue(activeEvents),
                  close: Deferred.succeed(activeClosed, undefined).pipe(Effect.asVoid),
                }),
              },
            })
            .pipe(Effect.orDie);
          yield* Deferred.succeed(resumeRecovery, undefined);
          yield* Deferred.await(recoveryClosed);
          current = "stopped";
          yield* Deferred.succeed(stopCommitted, undefined);
          yield* Deferred.await(stopProcessed);
          yield* Queue.offerAll(activeEvents, [
            usage(next, 456),
            rootTerminalEvent(next, "interrupted"),
          ]);
          yield* Deferred.await(activeClosed);
        }),
    });
    assert.deepEqual(
      rows
        .filter((row) => "runId" in row)
        .map((row) => ({ inputTokens: row.inputTokens, endReason: row.endReason })),
      [{ inputTokens: 579, endReason: "interrupted" }],
    );
  }),
);

it.effect.each(["completed", "failed"] as const)(
  "enqueues usage when cleanup interrupts the reader after the %s commit",
  (status) =>
    Effect.gen(function* () {
      const rows: AnalyticsEvent[] = [];
      const result = yield* captureRootRunTermination({
        key: `usage:interrupted-commit-${status}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) => Stream.make(rootTerminalEvent(ids, status)),
        // Persistence has committed, but its caller has not received the receipt yet.
        onTerminalRun: Effect.withFiber((reader) => Effect.sync(() => reader.interruptUnsafe())),
        recordUsage: (event) =>
          Effect.sync(() => {
            rows.push(event);
          }),
      });
      assert.equal(result.finalEvents.filter((event) => event.type === "run.updated").length, 1);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      if (!("runId" in row)) return assert.fail("missing usage");
      assert.equal(row.endReason, status);
      assert.equal(row.inputTokens, null);
    }),
);

it.effect.each([
  { phase: "baseline", status: "interrupted" },
  { phase: "baseline", status: "cancelled" },
  { phase: "admission", status: "interrupted" },
  { phase: "admission", status: "cancelled" },
] as const)("records initial startup Stop during $phase ($status)", ({ phase, status }) =>
  Effect.gen(function* () {
    const rows: AnalyticsEvent[] = [];
    const entered = yield* Deferred.make<void>();
    const recorded = yield* Deferred.make<void>();
    const updates = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const key = `usage:first-${phase}-${status}`;
    const ids = backgroundScenarioIds(key);
    yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Effect.succeed(false),
      captureBaseline: () =>
        phase === "baseline"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      ...(phase === "admission"
        ? {
            shouldStartProviderTurn: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          }
        : {}),
      recordUsage: (event) =>
        Effect.sync(() => {
          rows.push(event);
        }).pipe(Effect.andThen(Deferred.succeed(recorded, undefined)), Effect.asVoid),
      runUpdates: Stream.fromQueue(updates),
      runStart: (start, closed) =>
        Effect.gen(function* () {
          const startup = yield* start.pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust("200 millis");
          yield* Queue.offer(updates, {
            sequence: 1,
            commandId: null,
            event: {
              id: EventId.make(`event:stop:${key}`),
              type: "run.updated",
              threadId: ids.threadId,
              occurredAt: yield* DateTime.now,
              payload: { id: ids.runId, status } as OrchestrationV2Run,
            },
          });
          // The execution service outlives the cancelled startup, as it does in production.
          yield* Fiber.interrupt(startup);
          yield* Deferred.await(recorded);
          yield* Deferred.succeed(closed, undefined);
        }),
    });
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    if (!("runId" in row)) return assert.fail("missing usage");
    assert.equal(row.runId, ids.runId);
    assert.equal(row.endReason, status);
    assert.equal(row.wallMs, 200);
    assert.equal(row.inputTokens, null);
  }),
);

it.effect.each(
  (["completed", "failed", "interrupted", "cancelled"] as const).flatMap((status) =>
    (["ownership", "commit"] as const).map((gate) => ({ status, gate })),
  ),
)("retains steering usage after superseded $status ($gate guard)", ({ status, gate }) =>
  Effect.gen(function* () {
    const rows: AnalyticsEvent[] = [];
    const updated = (ids: BackgroundScenarioIds, tokens: number) => ({
      type: "provider_turn.updated" as const,
      driver,
      providerTurn: {
        id: ids.rootProviderTurnId,
        providerThreadId: ids.providerThreadId,
        nodeId: ids.rootNodeId,
        runAttemptId: ids.attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed" as const,
        startedAt: null,
        completedAt: null,
        finish: null,
        turnTokenUsage: {
          usageScope: "main_agent" as const,
          usageStatus: "complete" as const,
          inputTokens: tokens,
          outputTokens: 10,
          hasSubagents: false,
        },
      },
    });
    yield* captureRootRunTermination({
      key: "usage:steering-restart",
      shouldFinalizeRun: () => Effect.succeed(gate === "commit"),
      ...(gate === "commit"
        ? {
            rejectTerminalWriteForAttempt:
              backgroundScenarioIds("usage:steering-restart").attemptId,
          }
        : {}),
      recordUsage: (event) =>
        Effect.sync(() => {
          rows.push(event);
        }),
      events: (ids) => Stream.make(updated(ids, 123), rootTerminalEvent(ids, status)),
      afterIngestion: (execution, ids, controls) =>
        Effect.gen(function* () {
          const next = {
            ...ids,
            attemptId: RunAttemptId.make("attempt:steering:next"),
            rootProviderTurnId: ProviderTurnId.make("provider-turn:steering:next"),
          };
          const closed = yield* Deferred.make<void>();
          yield* execution
            .startRootRun({
              ...controls,
              attempt: {
                ...controls.attempt,
                id: next.attemptId,
                reason: "steering_restart",
                providerTurnId: next.rootProviderTurnId,
              },
              attemptId: next.attemptId,
              shouldFinalizeRun: () => Effect.succeed(true),
              session: {
                ...controls.session,
                subscribeEvents: Effect.succeed({
                  events: Stream.make(updated(next, 456), rootTerminalEvent(next, "completed")),
                  close: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                }),
              },
            })
            .pipe(Effect.orDie);
          yield* Deferred.await(closed);
        }),
    });
    assert.deepEqual(
      rows
        .filter((row) => "runId" in row)
        .map((row) => ({
          runId: row.runId,
          inputTokens: row.inputTokens,
          endReason: row.endReason,
        })),
      [{ runId: "run:usage:steering-restart", inputTokens: 579, endReason: "completed" }],
    );
  }),
);

it.effect.each(["completed", "failed", "interrupted", "cancelled"] as const)(
  "writes run.usage through run execution when a run ends %s",
  (status) =>
    Effect.gen(function* () {
      const events: AnalyticsEvent[] = [];
      yield* captureRootRunTermination({
        key: `usage:${status}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        recordUsage: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        events: (ids) => Stream.fromIterable([rootTerminalEvent(ids, status)]),
      });
      assert.equal(events.length, 1);
      const row = events[0]!;
      if (!("runId" in row)) return assert.fail("missing run usage");
      assert.equal(row.endReason, status);
      assert.equal(row.inputTokens, null);
      assert.equal(row.reasoningTokens, null);
    }),
);

it.effect.each([
  ["failed", "after"],
  ["interrupted", "after"],
  ["cancelled", "after"],
  ["interrupted", "commit"],
  ["cancelled", "commit"],
  ["interrupted", "baseline"],
  ["interrupted", "admission"],
  ["interrupted", "inner-admission"],
] as const)(
  "flushes retry usage when the next attempt ends %s before startup (%s)",
  ([status, phase]) =>
    Effect.gen(function* () {
      const rows: AnalyticsEvent[] = [];
      const updates = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const recorded = yield* Deferred.make<void>();
      const emitStopDuringRetry = (ids: BackgroundScenarioIds) =>
        Queue.offer(updates, {
          sequence: 1,
          commandId: null,
          event: {
            id: EventId.make("event:stop-retry"),
            type: "run.updated" as const,
            threadId: ids.threadId,
            occurredAt: DateTime.makeUnsafe("2026-11-13T00:00:00.000Z"),
            payload: { id: ids.runId, status } as OrchestrationV2Run,
          },
        }).pipe(Effect.asVoid);
      const stopDuringRetry = (ids: BackgroundScenarioIds) =>
        emitStopDuringRetry(ids).pipe(Effect.andThen(Deferred.await(recorded)));
      const startupBlocked = yield* Deferred.make<void>();
      let baselineCalls = 0;
      const result = yield* captureRootRunTermination({
        key: "usage:retry-before-start",
        ...(phase === "commit"
          ? { afterRetryCommit: stopDuringRetry(backgroundScenarioIds("usage:retry-before-start")) }
          : {}),
        captureBaseline: () =>
          ++baselineCalls === 2 && phase === "baseline"
            ? Deferred.succeed(startupBlocked, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        delegated: true,
        shouldFinalizeRun: () => Effect.succeed(true),
        runUpdates: Stream.fromQueue(updates),
        recordUsage: (event) =>
          Effect.sync(() => {
            rows.push(event);
          }).pipe(Effect.andThen(Deferred.succeed(recorded, undefined)), Effect.asVoid),
        events: (ids) =>
          Stream.make(
            {
              type: "provider_turn.updated" as const,
              driver,
              providerTurn: {
                id: ids.rootProviderTurnId,
                providerThreadId: ids.providerThreadId,
                nodeId: ids.rootNodeId,
                runAttemptId: ids.attemptId,
                nativeTurnRef: null,
                ordinal: 1,
                status: "failed" as const,
                startedAt: null,
                completedAt: null,
                finish: null,
                turnTokenUsage: {
                  usageScope: "main_agent" as const,
                  usageStatus: "partial" as const,
                  inputTokens: 123,
                  outputTokens: 45,
                  hasSubagents: false,
                },
              },
            },
            {
              ...rootTerminalEvent(ids, "failed"),
              status: "failed" as const,
              failureItemOrdinal: 101,
              failure: {
                class: "provider_error" as const,
                category: "transient" as const,
                code: "api_error_529",
                retryable: true,
                message: "Claude gave up after repeated API errors. Last error: 529 overloaded.",
              },
            },
          ),
        afterIngestion: (execution, ids, controls) =>
          phase === "baseline" || phase === "admission" || phase === "inner-admission"
            ? Effect.gen(function* () {
                const startup = yield* execution
                  .startRootRun({
                    ...controls,
                    run: { ...controls.run, startedAt: yield* DateTime.now },
                    attempt: { ...controls.attempt, id: RunAttemptId.make("attempt:second") },
                    attemptId: RunAttemptId.make("attempt:second"),
                    ...(phase === "admission"
                      ? {
                          shouldStartProviderTurn: () =>
                            Deferred.succeed(startupBlocked, undefined).pipe(
                              Effect.andThen(Effect.never),
                            ),
                        }
                      : {}),
                    session: {
                      ...controls.session,
                      subscribeEvents: Effect.succeed({ events: Stream.never, close: Effect.void }),
                      ...(phase === "inner-admission"
                        ? {
                            startTurn: () =>
                              Deferred.succeed(startupBlocked, undefined).pipe(
                                Effect.andThen(Effect.never),
                              ),
                            interruptStartingRun: () => Effect.void,
                          }
                        : {}),
                    },
                  })
                  .pipe(Effect.forkChild);
                yield* Deferred.await(startupBlocked);
                yield* emitStopDuringRetry(ids);
                yield* Fiber.interrupt(startup);
                yield* Deferred.await(recorded);
              })
            : status !== "failed"
              ? phase === "commit"
                ? Effect.void
                : stopDuringRetry(ids)
              : execution.finishUsageBeforeStart({
                  run: {
                    id: ids.runId,
                    threadId: ids.threadId,
                    startedAt: null,
                    providerInstanceId: ProviderInstanceId.make("codex"),
                  },
                  attempt: { id: RunAttemptId.make("attempt:next") },
                  providerThread: { id: ids.providerThreadId },
                  appThread: {
                    lineage: {
                      rootThreadId: ids.threadId,
                      parentThreadId: null,
                      relationshipToParent: null,
                    },
                  },
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5.4",
                  },
                  status: "failed",
                }),
      });
      assert.isTrue(
        result.committedEffects.some((effect) =>
          effect.id.startsWith("effect:delegated-transient-resume:"),
        ),
      );
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      if (!("runId" in row)) return assert.fail("missing usage");
      assert.equal(row.inputTokens, 123);
      assert.equal(row.outputTokens, 45);
      assert.equal(row.endReason, status);
    }),
);

it.effect.each([undefined, "server_shutdown", "task_cancel", "user_stop"] as const)(
  "keeps cancellation provenance from the current run in the terminal event and analytics (%s)",
  (cancelReason) =>
    Effect.gen(function* () {
      const usage: AnalyticsEvent[] = [];
      const result = yield* captureRootRunTermination({
        key: `cancel-provenance:${cancelReason ?? "provider"}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        ...(cancelReason === undefined
          ? {}
          : {
              cancelMetadata: {
                cancelReason,
                cancelDetail: "Cancellation source read at finalization.",
              },
            }),
        recordUsage: (event) =>
          Effect.sync(() => {
            usage.push(event);
          }),
        events: (ids) => Stream.make(rootTerminalEvent(ids, "cancelled")),
      });
      const ended = result.finalEvents.find(
        (event) => event.type === "run.updated" && event.payload.status === "cancelled",
      );
      assert.isDefined(ended);
      if (ended?.type !== "run.updated") return;
      assert.equal(ended.payload.cancelReason, cancelReason ?? "provider_cancelled");
      assert.equal(
        ended.payload.cancelDetail,
        cancelReason === undefined ? undefined : "Cancellation source read at finalization.",
      );
      const row = usage.find((event) => event.kind === "run.usage");
      if (row === undefined || !("runId" in row)) return assert.fail("Missing run usage event");
      assert.equal(row.cancelReason, cancelReason ?? "provider_cancelled");
    }),
);

it.effect.each(
  (["cancelled", "interrupted"] as const).flatMap((status) =>
    (["server_shutdown", "server_restart", "thread_delete"] as const).flatMap((cancelReason) =>
      [undefined, "user_stop" as const].map((staleReason) => ({
        status,
        cancelReason,
        staleReason,
      })),
    ),
  ),
)(
  "a rejected provider $status write keeps committed analytics cause $cancelReason (stale=$staleReason)",
  ({ status, cancelReason, staleReason }) =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const processed = yield* Deferred.make<void>();
      const ids = backgroundScenarioIds(
        `rejected-cancel:${status}:${cancelReason}:${staleReason ?? "missing"}`,
      );
      const rows: AnalyticsEvent[] = [];
      const result = yield* captureRootRunTermination({
        key: `rejected-cancel:${status}:${cancelReason}:${staleReason ?? "missing"}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        rejectTerminalWriteForAttempt: ids.attemptId,
        loadCancelMetadata: () =>
          Deferred.succeed(committed, undefined).pipe(
            Effect.andThen(Deferred.await(processed)),
            Effect.as({ cancelReason: staleReason }),
          ),
        runUpdates: Stream.fromEffect(Deferred.await(committed)).pipe(
          Stream.map(() => ({
            sequence: 1,
            commandId: null,
            event: {
              id: EventId.make("committed-cancellation"),
              type: "run.updated" as const,
              threadId: ids.threadId,
              occurredAt: DateTime.makeUnsafe("2026-11-15T00:00:00Z"),
              payload: { id: ids.runId, status, cancelReason } as OrchestrationV2Run,
            },
          })),
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(processed, undefined)).pipe(Stream.drain),
          ),
        ),
        recordUsage: (row) =>
          Effect.sync(() => {
            rows.push(row);
          }),
        startTurn: () => Deferred.succeed(admitted, undefined).pipe(Effect.asVoid),
        events: (runtimeIds) =>
          Stream.fromEffect(Deferred.await(admitted)).pipe(
            Stream.flatMap(() => Stream.make(rootTerminalEvent(runtimeIds, status))),
          ),
      });
      assert.isFalse(result.finalEvents.some((event) => event.type === "run.updated"));
      const row = rows.find((event) => "runId" in event);
      if (row === undefined || !("runId" in row)) return assert.fail("Missing usage event");
      assert.equal(row.cancelReason, cancelReason);
      assert.equal(row.endReason, status);
    }),
);

it.effect.each(
  (["cancelled", "interrupted"] as const).flatMap((status) =>
    (
      [
        "user_stop",
        "task_cancel",
        "thread_reset",
        "card_stop",
        "delegated_parent_cancelled",
        "superseded",
        "thread_archive",
      ] as const
    ).map((cancelReason) => ({ status, cancelReason })),
  ),
)(
  "successful $status finalization reloads committed $cancelReason for usage",
  ({ status, cancelReason }) =>
    Effect.gen(function* () {
      let committed = false;
      let reads = 0;
      const rows: AnalyticsEvent[] = [];
      const result = yield* captureRootRunTermination({
        key: `successful-cancel:${status}:${cancelReason}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        loadCancelMetadata: () =>
          Effect.sync(() => {
            reads += 1;
            return committed ? { cancelReason } : undefined;
          }),
        onTerminalRun: Effect.sync(() => {
          committed = true;
        }),
        recordUsage: (row) =>
          Effect.sync(() => {
            rows.push(row);
          }),
        events: (ids) => Stream.make(rootTerminalEvent(ids, status)),
      });
      assert.isTrue(result.finalEvents.some((event) => event.type === "run.updated"));
      assert.isAtLeast(reads, 2);
      const row = rows.find((event) => "runId" in event);
      if (row === undefined || !("runId" in row)) return assert.fail("Missing usage event");
      assert.equal(row.cancelReason, cancelReason);
      assert.equal(row.endReason, status);
    }),
);
