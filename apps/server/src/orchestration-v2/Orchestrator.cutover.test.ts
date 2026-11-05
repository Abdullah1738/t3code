import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const at = DateTime.makeUnsafe("2026-11-05T12:00:00.000Z");
const openCodeInstance = ProviderInstanceId.make("opencode");
const openCodeDriver = ProviderDriverKind.make("opencode");
const codexInstance = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");
const claudeInstance = ProviderInstanceId.make("claudeAgent");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const sourceSelection = { instanceId: openCodeInstance, model: "opus/cx/gpt-6.1-sol" };
const codexSelection = { instanceId: codexInstance, model: "gpt-6.1-sol" };
const claudeSelection = { instanceId: claudeInstance, model: "claude-opus-5-5" };

const adapter = (
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  capabilities: typeof CodexProviderCapabilitiesV2 | typeof ClaudeProviderCapabilitiesV2,
) =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Cutover fixtures must not start a provider process"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "orchestrator-cutover-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const layerTest = (cutoverComplete = false) =>
  Layer.mergeAll(
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "orchestrator-cutover" },
      ProviderAdapterRegistry.layerFromAdapters([
        adapter(openCodeInstance, openCodeDriver, CodexProviderCapabilitiesV2),
        adapter(codexInstance, codexDriver, CodexProviderCapabilitiesV2),
        adapter(claudeInstance, claudeDriver, ClaudeProviderCapabilitiesV2),
      ]),
      {
        databaseLayer: layerDatabase,
        runEffectWorker: false,
        ardudHarnessMigration: { cutoverComplete },
      },
    ).pipe(Layer.provideMerge(layerConfig)),
  );

const sourceFixture = (threadId: ThreadId) => {
  const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}:source`);
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    createdBy: "agent",
    creationSource: "mcp",
    projectId: ProjectId.make("project:cutover"),
    title: "Keep this review title",
    providerInstanceId: openCodeInstance,
    modelSelection: sourceSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/keep-worktree",
    worktreePath: "/fixture/worktrees/keep-me",
    activeProviderThreadId: providerThreadId,
    historyOrigin: "v1_import",
    lineage: {
      parentThreadId: ThreadId.make("thread:cutover:parent"),
      relationshipToParent: "subagent",
      rootThreadId: ThreadId.make("thread:cutover:root"),
    },
    forkedFrom: { type: "node", nodeId: NodeId.make("node:cutover:parent") },
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const source: OrchestrationV2ProviderThread = {
    id: providerThreadId,
    driver: openCodeDriver,
    providerInstanceId: openCodeInstance,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: openCodeDriver, nativeId: `ses_${threadId}`, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    contextUsage: null,
    createdAt: at,
    updatedAt: at,
  };
  return { thread, source };
};

const sourceEvents = (threadId: ThreadId) => {
  const { thread, source } = sourceFixture(threadId);
  return [
    {
      id: EventId.make(`event:${threadId}:created`),
      type: "thread.created" as const,
      threadId,
      occurredAt: at,
      payload: thread,
    },
    {
      id: EventId.make(`event:${threadId}:source`),
      type: "provider-thread.updated" as const,
      threadId,
      occurredAt: at,
      payload: source,
    },
  ];
};

const seedSource = (threadId: ThreadId) =>
  EventSink.EventSinkV2.use((sink) => sink.write({ events: sourceEvents(threadId) }));

const adopt = (
  threadId: ThreadId,
  modelSelection: ModelSelection = codexSelection,
  driver: ProviderDriverKind = codexDriver,
): Extract<OrchestrationV2InternalCommand, { readonly type: "thread.adopt-native-history" }> => ({
  type: "thread.adopt-native-history",
  commandId: CommandId.make(`adopt:${threadId}`),
  threadId,
  modelSelection,
  expectedActiveProviderThreadId: sourceFixture(threadId).source.id,
  target: { kind: "new", driver, nativeId: null, headId: null },
});

const errorCause = (error: Orchestrator.OrchestratorV2Error) =>
  "cause" in error ? String(error.cause) : error.message;

it.effect.each([
  ["Codex", codexSelection, codexDriver],
  ["Claude", claudeSelection, claudeDriver],
] as const)(
  "prompt-only %s adoption preserves thread identity and leaves source history untouched",
  ([, selection, driver]) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:cutover:prompt-only");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* seedSource(threadId);
      const before = yield* orchestrator.getThreadProjection(threadId);
      const command = adopt(threadId, selection, driver);

      const accepted = yield* orchestrator.dispatch(command);
      const after = yield* orchestrator.getThreadProjection(threadId);
      const target = after.providerThreads.find(
        (row) => row.id === after.thread.activeProviderThreadId,
      );
      assert.isDefined(target);
      assert.notEqual(target!.id, before.thread.activeProviderThreadId);
      assert.deepEqual(after.thread, {
        ...before.thread,
        providerInstanceId: selection.instanceId,
        modelSelection: selection,
        activeProviderThreadId: target!.id,
        harnessMigrationFence: true,
        updatedAt: after.thread.updatedAt,
      });
      assert.lengthOf(after.providerThreads, 2);
      assert.deepEqual(
        after.providerThreads.find((row) => row.id === before.thread.activeProviderThreadId),
        before.providerThreads[0],
      );
      assert.equal(target!.driver, driver);
      assert.equal(target!.providerInstanceId, selection.instanceId);
      assert.isNull(target!.nativeThreadRef);
      assert.isNull(target!.nativeConversationHeadRef);
      assert.isNull(target!.providerSessionId);
      assert.equal(target!.status, "not_loaded");
      assert.isUndefined(target!.nativeMetadata?.seededHistory);
      assert.deepEqual(after.messages, before.messages);
      assert.deepEqual(after.runs, before.runs);
      assert.deepEqual(after.contextHandoffs, before.contextHandoffs);
      assert.deepEqual(after.contextTransfers, before.contextTransfers);

      const sequence = yield* sink.latestSequence({ threadId });
      assert.deepEqual(yield* orchestrator.dispatch(command), accepted);
      assert.equal(yield* sink.latestSequence({ threadId }), sequence);
      assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), after);
    }).pipe(Effect.provide(layerTest())),
);

it.effect.each(["busy", "request", "roster", "provider_native", "app_owned"] as const)(
  "prompt-only adoption refuses %s work without changing the thread",
  (state) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`thread:cutover:blocked:${state}`);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedSource(threadId);
      const { source } = sourceFixture(threadId);

      if (state === "busy") {
        for (const ancestor of ["root", "parent"]) {
          const ancestorId = ThreadId.make(`thread:cutover:${ancestor}`);
          yield* sink.write({
            events: sourceEvents(ancestorId).map((event) =>
              event.type === "thread.created"
                ? {
                    ...event,
                    payload: {
                      ...event.payload,
                      lineage: {
                        parentThreadId: null,
                        relationshipToParent: null,
                        rootThreadId: ancestorId,
                      },
                      forkedFrom: null,
                    },
                  }
                : event,
            ),
          });
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${threadId}:first`),
          threadId,
          messageId: MessageId.make(`message:${threadId}:first`),
          text: "Continue the review",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "defer_start" },
        });
        const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* projections.apply({
          id: EventId.make(`event:${threadId}:run`),
          type: "run.updated",
          threadId,
          occurredAt: at,
          payload: { ...first, status: "running", startedAt: at },
        });
      } else if (state === "request") {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${threadId}:request`),
              type: "runtime-request.updated",
              threadId,
              occurredAt: at,
              payload: {
                id: RuntimeRequestId.make("request:cutover"),
                nodeId: NodeId.make("node:cutover:request"),
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: at,
                resolvedAt: null,
              },
            },
          ],
        });
      } else if (state === "roster") {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${threadId}:roster`),
              type: "provider-thread.updated",
              threadId,
              occurredAt: at,
              payload: {
                ...source,
                pendingBackgroundTasks: [{ taskId: "background-review", kind: "command" }],
              },
            },
          ],
        });
      } else {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${threadId}:subagent`),
              type: "subagent.updated",
              threadId,
              occurredAt: at,
              payload: {
                id: NodeId.make("node:cutover:subagent"),
                threadId,
                runId: null,
                parentNodeId: NodeId.make("node:cutover:parent"),
                origin: state,
                createdBy: "agent",
                driver: openCodeDriver,
                providerInstanceId: openCodeInstance,
                providerThreadId: source.id,
                childThreadId: ThreadId.make("thread:cutover:child"),
                nativeTaskRef: null,
                prompt: "Finish the review",
                title: "Review",
                model: sourceSelection.model,
                status: "running",
                result: null,
                startedAt: at,
                completedAt: null,
                updatedAt: at,
              },
            },
          ],
        });
      }

      const before = yield* orchestrator.getThreadProjection(threadId);
      if (state === "busy") {
        assert.deepEqual(
          before.runs.map((run) => run.status),
          ["running"],
        );
      } else {
        assert.lengthOf(before.runs, 0);
      }
      const sequence = yield* sink.latestSequence({ threadId });
      const error = yield* orchestrator.dispatch(adopt(threadId)).pipe(Effect.flip);
      assert.include(
        errorCause(error),
        state === "busy"
          ? "queued or active"
          : state === "request"
            ? "pending runtime request"
            : "background work",
      );
      assert.equal(yield* sink.latestSequence({ threadId }), sequence);
      assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
    }).pipe(Effect.provide(layerTest())),
);

it.effect.each(["same-harness", "mixed-harness"] as const)(
  "prompt-only adoption preserves a %s mapped queue without reordering or releasing holds",
  (kind) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`thread:cutover:queued:${kind}`);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* sink.write({
        events: sourceEvents(threadId).map((event) =>
          event.type === "thread.created"
            ? {
                ...event,
                payload: {
                  ...event.payload,
                  lineage: {
                    parentThreadId: null,
                    relationshipToParent: null,
                    rootThreadId: threadId,
                  },
                  forkedFrom: null,
                },
              }
            : event,
        ),
      });
      for (const [suffix, type] of [
        ["first", "defer_start"],
        ["second", "queue_after_active"],
        ["third", "queue_after_active"],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${threadId}:${suffix}`),
          threadId,
          messageId: MessageId.make(`message:${threadId}:${suffix}`),
          text: `Review ${suffix}`,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type },
        });
      }
      const initial = yield* orchestrator.getThreadProjection(threadId);
      const [first, second, third] = initial.runs;
      assert.isDefined(first);
      assert.isDefined(second);
      assert.isDefined(third);
      assert.deepEqual(
        initial.runs.map((run) => run.status),
        ["preparing", "queued", "queued"],
      );
      const selections = [
        codexSelection,
        kind === "mixed-harness" ? claudeSelection : codexSelection,
      ];
      // Preparation maps each queued selection independently; adoption must not rewrite those rows.
      for (const [index, run] of [second!, third!].entries()) {
        const selection = selections[index]!;
        yield* projections.apply({
          id: EventId.make(`event:${threadId}:map:${index}`),
          type: "run.updated",
          threadId,
          occurredAt: at,
          payload: {
            ...run,
            providerInstanceId: selection.instanceId,
            modelSelection: selection,
            queueHeld: index === 0,
          },
        });
      }
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:completed`),
        type: "run.updated",
        threadId,
        occurredAt: at,
        payload: { ...first!, status: "completed", completedAt: at },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const queued = before.runs.filter((run) => run.status === "queued");
      assert.deepEqual(
        queued.map((run) => ({
          id: run.id,
          modelSelection: run.modelSelection,
          held: run.queueHeld,
        })),
        [
          { id: second!.id, modelSelection: selections[0]!, held: true },
          { id: third!.id, modelSelection: selections[1]!, held: false },
        ],
      );
      assert.equal(before.thread.activeProviderThreadId, sourceFixture(threadId).source.id);

      const command = adopt(threadId);
      yield* orchestrator.dispatch(command);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(after.thread.modelSelection, codexSelection);
      assert.notEqual(after.thread.activeProviderThreadId, before.thread.activeProviderThreadId);
      assert.deepEqual(after.runs, before.runs);
      assert.deepEqual(
        after.runs.filter((run) => run.status === "queued"),
        queued,
      );
      assert.deepEqual(after.messages, before.messages);
      assert.deepEqual(after.contextHandoffs, before.contextHandoffs);
      assert.deepEqual(after.contextTransfers, before.contextTransfers);
      const target = after.providerThreads.find(
        (row) => row.id === after.thread.activeProviderThreadId,
      );
      assert.isDefined(target);
      assert.equal(target!.status, "not_loaded");
      assert.isNull(target!.nativeThreadRef);
      assert.isNull(target!.nativeConversationHeadRef);
      assert.isNull(target!.providerSessionId);
      assert.isUndefined(target!.nativeMetadata?.seededHistory);
      assert.deepEqual(
        after.providerThreads.find((row) => row.id === before.thread.activeProviderThreadId),
        before.providerThreads[0],
      );
      const sequence = yield* sink.latestSequence({ threadId });
      yield* orchestrator.dispatch(command);
      assert.equal(yield* sink.latestSequence({ threadId }), sequence);
      assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), after);
    }).pipe(Effect.provide(layerTest())),
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
  switch (type) {
    case "thread.create":
      return {
        type,
        commandId,
        threadId: ThreadId.make(`thread:new:${modelSelection.model}`),
        projectId: ProjectId.make("project:cutover"),
        title: "New thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      };
    case "message.dispatch":
      return {
        type,
        commandId,
        threadId,
        modelSelection,
        messageId: MessageId.make(`message:${commandId}`),
        text: "Continue",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "defer_start" },
      };
    case "delegated_task.request":
      return {
        type,
        commandId,
        parentThreadId: threadId,
        parentRunId: RunId.make("run:cutover:parent"),
        parentNodeId: NodeId.make("node:cutover:parent"),
        task: "Review the changes",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      };
    default:
      return { type, commandId, threadId, modelSelection };
  }
};

it.effect.each([
  "thread.create",
  "message.dispatch",
  "thread.model-selection.set",
  "provider.switch",
  "delegated_task.request",
] as const)("completed cutover refuses explicit OpenCode Claude/OpenAI selections in %s", (type) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:cutover:explicit");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* seedSource(threadId);
    const before = yield* orchestrator.getThreadProjection(threadId);
    const sequence = yield* sink.latestSequence();

    for (const [model, reason] of [
      ["opus/claude-opus-5-5", "use claudeAgent/claude-opus-5-5 instead"],
      ["opus/cx/gpt-6.1-sol", "use codex/gpt-6.1-sol instead"],
      ["opus/claude-future", "No verified native harness mapping"],
      ["openai/future", "No verified native harness mapping"],
    ] as const) {
      const error = yield* orchestrator
        .dispatch(explicitCommand(type, threadId, { instanceId: openCodeInstance, model }))
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorCommandRejectedError");
      assert.include(errorCause(error), reason);
      assert.equal(yield* sink.latestSequence(), sequence);
      assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
    }
  }).pipe(Effect.provide(layerTest(true))),
);

it.effect.each([
  ["retained GLM", { instanceId: openCodeInstance, model: "surplus/glm-5.3-flash" }],
  ["native Codex", codexSelection],
  ["native Claude", claudeSelection],
] as const)("completed cutover still accepts a %s thread", ([, selection]) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const command = explicitCommand("thread.create", ThreadId.make("unused"), selection);
    assert.equal(command.type, "thread.create");
    if (command.type !== "thread.create") return;
    yield* orchestrator.dispatch(command);
    assert.deepEqual(
      (yield* orchestrator.getThreadProjection(command.threadId)).thread.modelSelection,
      selection,
    );
  }).pipe(Effect.provide(layerTest(true))),
);

it.effect("explicit legacy selections remain accepted before cutover completes", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const command = explicitCommand("thread.create", ThreadId.make("unused"), sourceSelection);
    yield* orchestrator.dispatch(command);
  }).pipe(Effect.provide(layerTest())),
);

it.effect(
  "completed cutover replays an accepted legacy-selection receipt before checking selection policy",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const command = explicitCommand("thread.create", ThreadId.make("unused"), sourceSelection);
      assert.equal(command.type, "thread.create");
      if (command.type !== "thread.create") return;
      // A persisted pre-cutover acceptance is authoritative even though a fresh command would now fail.
      const accepted = yield* sink.commitCommand({
        commandId: command.commandId,
        commandType: command.type,
        threadId: command.threadId,
        acceptedAt: at,
        events: sourceEvents(command.threadId),
        effects: [],
      });
      const before = yield* orchestrator.getThreadProjection(command.threadId);
      const sequence = yield* sink.latestSequence();

      assert.deepEqual(yield* orchestrator.dispatch(command), {
        sequence: accepted.receipt.resultSequence,
        storedEvents: accepted.storedEvents,
      });
      assert.equal(yield* sink.latestSequence(), sequence);
      assert.deepEqual(yield* orchestrator.getThreadProjection(command.threadId), before);

      const error = yield* orchestrator
        .dispatch({ ...command, commandId: CommandId.make("explicit:fresh-after-cutover") })
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorCommandRejectedError");
      assert.include(errorCause(error), "use codex/gpt-6.1-sol instead");
      assert.equal(yield* sink.latestSequence(), sequence);
    }).pipe(Effect.provide(layerTest(true))),
);
