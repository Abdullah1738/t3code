import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";
import { ThreadId } from "@t3tools/contracts";

const openCode = ProviderInstanceId.make("opencode");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const source = { instanceId: openCode, model: "opus/cx/gpt-6.1-sol" };
const native = { instanceId: codex, model: "gpt-6.1-sol" };
const nativeClaude = { instanceId: claude, model: "claude-opus-5-5" };
const adapter = (instanceId: ProviderInstanceId, driver: string) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make(driver),
    getCapabilities: () =>
      Effect.succeed(
        driver === "claudeAgent" ? ClaudeProviderCapabilitiesV2 : CodexProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Planning fixtures never start a provider process"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];
const database = Sqlite.layerMemory;
const config = ServerConfig.layerTest(process.cwd(), { prefix: "orchestrator-cutover-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const layer = (cutoverComplete = false) =>
  Layer.mergeAll(
    ProjectionStore.layer.pipe(Layer.provide(database)),
    Harness.layerWithRegistry(
      { name: "normal-cutover" },
      Registry.layerFromAdapters([
        adapter(openCode, "opencode"),
        adapter(codex, "codex"),
        adapter(claude, "claudeAgent"),
      ]),
      {
        databaseLayer: database,
        runEffectWorker: false,
        ardudHarnessMigration: { cutoverComplete },
      },
    ).pipe(Layer.provideMerge(config)),
  );
const create = (threadId: ThreadId, modelSelection: ModelSelection = source) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${threadId}`),
  threadId,
  projectId: ProjectId.make("project:cutover"),
  title: "Keep the existing task",
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: "feature/existing",
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
});
const send = (
  threadId: ThreadId,
  suffix: string,
  text: string,
  type: "defer_start" | "queue_after_active" | "start_immediately",
  modelSelection?: ModelSelection,
) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`send:${threadId}:${suffix}`),
  threadId,
  messageId: MessageId.make(`message:${threadId}:${suffix}`),
  text,
  attachments: [],
  createdBy: "user" as const,
  creationSource: "web" as const,
  dispatchMode: { type },
  ...(modelSelection === undefined ? {} : { modelSelection }),
});
const errorCause = (error: Orchestrator.OrchestratorV2Error) =>
  "cause" in error ? String(error.cause) : error.message;

it.effect.each([native, nativeClaude])(
  "normal provider.switch preserves identity and hands off the original task on the next turn (%j)",
  (selection) =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:normal-switch");
      yield* engine.dispatch(create(threadId));
      yield* engine.dispatch(
        send(
          threadId,
          "original",
          "ORIGINAL_TASK: implement the exact requested feature",
          "defer_start",
        ),
      );
      const before = yield* engine.getThreadProjection(threadId);
      const run = before.runs[0]!;
      yield* projections.apply({
        id: EventId.make("source-completed"),
        type: "run.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: { ...run, status: "completed", completedAt: yield* DateTime.now },
      });
      const command = {
        type: "provider.switch" as const,
        commandId: CommandId.make("normal:switch"),
        threadId,
        modelSelection: selection,
        expectedModelSelection: source,
      };
      const result = yield* engine.dispatch(command);
      const switched = yield* engine.getThreadProjection(threadId);
      assert.deepEqual(switched.thread, {
        ...before.thread,
        providerInstanceId: selection.instanceId,
        modelSelection: selection,
        updatedAt: switched.thread.updatedAt,
      });
      assert.deepEqual(switched.providerThreads, before.providerThreads);
      assert.deepEqual(switched.messages, before.messages);
      assert.lengthOf(switched.contextHandoffs, 0);
      assert.deepEqual(yield* engine.dispatch(command), result);
      yield* engine.dispatch(
        send(threadId, "next", "Continue without redoing finished work", "start_immediately"),
      );
      const after = yield* engine.getThreadProjection(threadId);
      const next = after.runs.at(-1)!;
      const handoff = after.contextHandoffs.find((row) => row.targetRunId === next.id);
      assert.isDefined(handoff);
      assert.include(JSON.stringify(handoff), "ORIGINAL_TASK");
      assert.notProperty(after.thread, "harnessMigrationFence");
      assert.isTrue(
        after.providerThreads.every((row) => row.nativeMetadata?.seededHistory === undefined),
      );
      assert.lengthOf(
        after.contextHandoffs.filter((row) => row.targetRunId === next.id),
        1,
      );
    }).pipe(Effect.provide(layer())),
);

it.effect.each(["immediate", "queued"] as const)(
  "a first-ever recovered cancellation retains its original task and command in normal %s handoff",
  (mode) =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make(`recovered:${mode}`);
      yield* engine.dispatch(create(threadId));
      yield* engine.dispatch(
        send(
          threadId,
          "first",
          "FIRST_EVER_TASK: finish the exact requested parser",
          "defer_start",
        ),
      );
      if (mode === "queued")
        yield* engine.dispatch(
          send(threadId, "queued", "Continue the parser", "queue_after_active", native),
        );
      const original = yield* engine.getThreadProjection(threadId);
      const first = original.runs[0]!;
      const at = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("first-started-command"),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: {
          id: TurnItemId.make("first-command"),
          threadId,
          runId: first.id,
          nodeId: first.rootNodeId,
          providerThreadId: first.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 101,
          status: "completed",
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "command_execution",
          input: "vp test parser",
          output: "FIRST_COMMAND_RESULT keep this evidence",
          exitCode: 0,
        },
      });
      yield* projections.apply({
        id: EventId.make("recovery-cancel"),
        type: "run.updated",
        threadId,
        occurredAt: at,
        payload: { ...first, status: "cancelled", startedAt: at, completedAt: at },
      });
      yield* engine.dispatch({
        type: "provider.switch",
        commandId: CommandId.make("recovery-switch"),
        threadId,
        modelSelection: native,
        expectedModelSelection: source,
      });
      if (mode === "queued")
        yield* engine.dispatch({
          type: "queue.cutover-release",
          commandId: CommandId.make("recovery-queue"),
          threadId,
        });
      else
        yield* engine.dispatch(
          send(threadId, "carry", "Carry on where you left off", "start_immediately"),
        );
      const after = yield* engine.getThreadProjection(threadId);
      const target = after.runs.at(-1)!;
      assert.equal(target.status, "starting");
      const handoff = after.contextHandoffs.find((handoff) => handoff.targetRunId === target.id);
      assert.isDefined(handoff);
      const text = JSON.stringify(handoff);
      assert.include(text, "FIRST_EVER_TASK");
      assert.include(text, "FIRST_COMMAND_RESULT");
      assert.include(text, "t3_thread_read");
      assert.include(text, threadId);
      assert.equal(handoff!.coveredRunOrdinals.from, first.ordinal);
    }).pipe(Effect.provide(layer())),
);

it.effect("cancelled-before-start queues do not become handoff history", () =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("unsent-cancelled");
    yield* engine.dispatch(create(threadId));
    yield* engine.dispatch(send(threadId, "unsent", "UNSENT_QUEUE_TASK", "defer_start"));
    const first = (yield* engine.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("cancel-before-start"),
      type: "run.updated",
      threadId,
      occurredAt: yield* DateTime.now,
      payload: { ...first, status: "cancelled", startedAt: null, completedAt: yield* DateTime.now },
    });
    yield* engine.dispatch({
      type: "provider.switch",
      commandId: CommandId.make("unsent-switch"),
      threadId,
      modelSelection: native,
    });
    yield* engine.dispatch(send(threadId, "new", "Fresh owner request", "start_immediately"));
    assert.lengthOf((yield* engine.getThreadProjection(threadId)).contextHandoffs, 0);
  }).pipe(Effect.provide(layer())),
);

it.effect.each(["same", "mixed", "reset"] as const)(
  "normal cutover keeps queued %s harness continuity and reset semantics",
  (kind) =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make(`thread:queue:${kind}`);
      yield* engine.dispatch(create(threadId));
      yield* engine.dispatch(
        send(threadId, "original", "ORIGINAL_TASK queue continuity", "defer_start"),
      );
      yield* engine.dispatch({
        ...send(threadId, "queued", "Queued owner request", "queue_after_active"),
        ...(kind === "reset" ? { contextReset: true } : {}),
      });
      const original = yield* engine.getThreadProjection(threadId);
      const queued = original.runs[1]!;
      const queuedSelection: ModelSelection = {
        ...(kind === "mixed" ? nativeClaude : native),
        options: [{ id: kind === "mixed" ? "effort" : "reasoningEffort", value: "xhigh" }],
      };
      yield* engine.dispatch({
        type: "queued-run.rebind-selection",
        commandId: CommandId.make("rebind-queued"),
        threadId,
        runId: queued.id,
        modelSelection: queuedSelection,
        expectedModelSelection: source,
      });
      const mapped = yield* engine.getThreadProjection(threadId);
      const placeholder = mapped.runs[1]!.providerThreadId!;
      yield* projections.apply({
        id: EventId.make("source-terminal"),
        type: "run.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: { ...mapped.runs[0]!, status: "completed", completedAt: yield* DateTime.now },
      });
      yield* engine.dispatch({
        type: "provider.switch",
        commandId: CommandId.make("switch-normal"),
        threadId,
        modelSelection: native,
        expectedModelSelection: source,
      });
      const binding = mapped.providerThreads.find((row) => row.id === placeholder)!;
      yield* projections.apply({
        id: EventId.make("current-native-binding"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: {
          ...binding,
          id: ProviderThreadId.make("native:current-binding"),
          providerInstanceId: codex,
          driver: ProviderDriverKind.make("codex"),
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          nativeThreadRef: {
            driver: ProviderDriverKind.make("codex"),
            nativeId: "native:existing-target",
            strength: "strong",
          },
        },
      });
      yield* engine.dispatch(
        send(
          threadId,
          "carry",
          "Robob upgrade moved this thread to Codex. Carry on where you left off; do not redo finished work or resend messages.",
          "start_immediately",
        ),
      );
      const carryProjection = yield* engine.getThreadProjection(threadId);
      const carry = carryProjection.runs.at(-1)!;
      const active = carryProjection.providerThreads.find(
        (row) => row.id === carry.providerThreadId,
      )!;
      const nativeRef = {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "native:accepted-carry-on",
        strength: "strong" as const,
      };
      const at = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("native-accepted"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: at,
        payload: {
          ...active,
          nativeThreadRef: nativeRef,
          status: "idle",
          firstRunOrdinal: carry.ordinal,
          lastRunOrdinal: carry.ordinal,
        },
      });
      yield* projections.apply({
        id: EventId.make("carry-completed"),
        type: "run.updated",
        threadId,
        occurredAt: at,
        payload: { ...carry, status: "completed", startedAt: at, completedAt: at },
      });
      const beforeStart = yield* engine.getThreadProjection(threadId);
      const queuedBefore = beforeStart.runs.find((run) => run.id === queued.id)!;
      yield* engine.dispatch({
        type: "queue.cutover-release",
        commandId: CommandId.make("release-queue"),
        threadId,
      });
      const after = yield* engine.getThreadProjection(threadId);
      const started = after.runs.find((run) => run.id === queued.id)!;
      assert.equal(started.status, "starting");
      assert.deepEqual(started.modelSelection, queuedSelection);
      assert.equal(started.queueHeld, queuedBefore.queueHeld);
      assert.equal(started.contextReset, queuedBefore.contextReset);
      assert.equal(started.userMessageId, queuedBefore.userMessageId);
      const target = after.providerThreads.find((row) => row.id === started.providerThreadId)!;
      if (kind === "same") {
        assert.equal(target.id, active.id);
        assert.deepEqual(target.nativeThreadRef, nativeRef);
        assert.isNull(started.contextHandoffId);
      } else {
        assert.equal(target.id, placeholder);
        assert.isNull(target.nativeThreadRef);
        if (kind === "mixed") assert.isNotNull(started.contextHandoffId);
        else assert.isNull(started.contextHandoffId);
      }
      assert.equal(
        after.attempts.find((row) => row.id === started.activeAttemptId)?.providerThreadId,
        target.id,
      );
      const node = after.nodes.find((row) => row.id === started.rootNodeId)!;
      assert.equal(node.providerThreadId, target.id);
      assert.equal(
        after.checkpointScopes.find((row) => row.id === node.checkpointScopeId)?.providerThreadId,
        target.id,
      );
      assert.equal(
        after.turnItems.find((row) => row.runId === started.id && row.type === "user_message")
          ?.providerThreadId,
        target.id,
      );
      assert.notInclude(
        after.messages.find((row) => row.id === started.userMessageId)!.text,
        "Robob upgrade",
      );
    }).pipe(Effect.provide(layer())),
);

const explicitCommand = (
  type:
    | "thread.create"
    | "message.dispatch"
    | "thread.model-selection.set"
    | "provider.switch"
    | "delegated_task.request",
  threadId: ThreadId,
  modelSelection: ModelSelection,
): OrchestrationV2ServerCommand => {
  const commandId = CommandId.make(`explicit:${type}:${modelSelection.model}`);
  if (type === "thread.create")
    return { ...create(ThreadId.make(`new:${modelSelection.model}`), modelSelection), commandId };
  if (type === "message.dispatch")
    return { ...send(threadId, "explicit", "Continue", "defer_start", modelSelection), commandId };
  if (type === "delegated_task.request")
    return {
      type,
      commandId,
      parentThreadId: threadId,
      parentRunId: RunId.make("parent-run"),
      parentNodeId: NodeId.make("parent-node"),
      task: "Review",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    };
  return { type, commandId, threadId, modelSelection };
};
it.effect.each([
  "thread.create",
  "message.dispatch",
  "thread.model-selection.set",
  "provider.switch",
  "delegated_task.request",
] as const)("completed cutover refuses explicit legacy selections in %s", (type) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("guard");
    yield* engine.dispatch(create(threadId, native));
    const before = yield* engine.getThreadProjection(threadId);
    const sequence = yield* sink.latestSequence();
    for (const [model, reason] of [
      ["opus/claude-opus-5-5", "use claudeAgent/claude-opus-5-5 instead"],
      [source.model, "use codex/gpt-6.1-sol instead"],
      ["openai/future", "No verified native harness mapping"],
    ]) {
      const error = yield* engine
        .dispatch(explicitCommand(type, threadId, { instanceId: openCode, model: model! }))
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorCommandRejectedError");
      assert.include(errorCause(error), reason!);
    }
    assert.equal(yield* sink.latestSequence(), sequence);
    assert.deepEqual(yield* engine.getThreadProjection(threadId), before);
  }).pipe(Effect.provide(layer(true))),
);

it.effect.each([native, nativeClaude, { instanceId: openCode, model: "surplus/glm-5.3-flash" }])(
  "completed cutover retains native and GLM selections (%j)",
  (selection) =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const command = create(ThreadId.make("allowed"), selection);
      yield* engine.dispatch(command);
      assert.deepEqual(
        (yield* engine.getThreadProjection(command.threadId)).thread.modelSelection,
        selection,
      );
    }).pipe(Effect.provide(layer(true))),
);

it.effect("receipt replay precedes completed-cutover selection policy", () =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("receipt");
    const command = create(threadId);
    const at = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("receipt:source");
    const accepted = yield* sink.commitCommand({
      commandId: command.commandId,
      commandType: command.type,
      threadId,
      acceptedAt: at,
      effects: [],
      events: [
        {
          id: EventId.make("receipt:event"),
          type: "thread.created",
          threadId,
          occurredAt: at,
          payload: {
            id: threadId,
            projectId: command.projectId,
            title: command.title,
            modelSelection: source,
            providerInstanceId: openCode,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThreadId,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: at,
            updatedAt: at,
            archivedAt: null,
            deletedAt: null,
            settledAt: null,
            settledOverride: null,
            lastVisitedAt: null,
          },
        },
      ],
    });
    assert.deepEqual(yield* engine.dispatch(command), {
      sequence: accepted.receipt.resultSequence,
      storedEvents: accepted.storedEvents,
    });
    const error = yield* engine
      .dispatch({ ...command, commandId: CommandId.make("fresh-receipt") })
      .pipe(Effect.flip);
    assert.equal(error._tag, "OrchestratorCommandRejectedError");
  }).pipe(Effect.provide(layer(true))),
);
