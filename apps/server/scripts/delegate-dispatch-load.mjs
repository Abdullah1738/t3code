import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ProviderReplayHarness from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import * as Orchestrator from "../src/orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../src/orchestration-v2/ThreadManagementService.ts";
import * as Receipts from "../src/orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../src/orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../src/vcs/GitVcsDriver.ts";
import * as Mcp from "../src/mcp/OrchestratorMcpService.ts";
import * as ProjectService from "../src/project/ProjectService.ts";
import * as ScheduledTasks from "../src/scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../src/secrets/SecretRequests.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import { layer as providerLayer } from "../src/provider/testUtils/providerRegistryMock.ts";
import { opencodeTestProvider } from "../src/ardud/kanban/engine/testProviders.ts";
import { CodexProviderCapabilitiesV2 } from "../src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId,
  model: "gpt-6.1-sol",
  options: [
    { id: "reasoningEffort", value: "xhigh" },
    { id: "serviceTier", value: "default" },
  ],
};
const provider = {
  ...opencodeTestProvider(),
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  models: [
    {
      slug: modelSelection.model,
      name: modelSelection.model,
      isCustom: true,
      capabilities: {
        optionDescriptors: modelSelection.options.map((x) => ({
          id: x.id,
          label: x.id,
          type: "select",
          options: [{ id: x.value, label: x.value }],
        })),
      },
    },
  ],
};
const adapters = ProviderAdapterRegistry.layerSingle({
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("No provider may be started by this experiment"),
});
export const layer = (databaseLayer) => {
  const replay = ProviderReplayHarness.layerWithRegistry(
    { name: "delegate-dispatch-1448" },
    adapters,
    { databaseLayer, runEffectWorker: false, runContinuationWorker: true, recoverOnStartup: false },
  );
  const management = ThreadManagement.layer.pipe(
    Layer.provide(replay),
    Layer.provide(Receipts.layer.pipe(Layer.provide(databaseLayer))),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(providerLayer([provider])),
  );
  return Mcp.layer.pipe(
    Layer.provideMerge(management),
    Layer.provideMerge(replay),
    Layer.provide(
      Layer.mergeAll(
        adapters,
        providerLayer([provider]),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        ServerSettings.layerTest(),
        NodeServices.layer,
      ),
    ),
  );
};
export const samples = [];
export const start = Effect.fn("DelegateLoad.start")(function* (measuring) {
  const mcp = yield* Mcp.OrchestratorMcpService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const management = yield* ThreadManagement.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const parent = ThreadId.make("dispatch-load-parent");
  const target = ThreadId.make("dispatch-load-target");
  for (const id of [parent, target])
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId: id,
      projectId: ProjectId.make("load-project"),
      title: id,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: process.cwd(),
      createdBy: "user",
      creationSource: "web",
    });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("parent-run"),
    threadId: parent,
    messageId: MessageId.make("parent-message"),
    text: "Synthetic parent",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const scope = {
    environmentId: EnvironmentId.make("load-environment"),
    requestNamespace: "dispatch-load-1448",
    thread: { threadId: parent, providerSessionId: "synthetic", providerInstanceId: instanceId },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const milestones = new Map();
  const milestone = Effect.fn("DelegateLoad.milestone")(function* (id) {
    if (milestones.has(id)) return milestones.get(id);
    const created = yield* Deferred.make();
    if (milestones.has(id)) return milestones.get(id);
    milestones.set(id, created);
    return created;
  });
  yield* orchestrator.streamDomainEvents.pipe(
    Stream.filter((event) => event.type === "subagent.updated"),
    Stream.runForEach((event) =>
      milestone(event.payload.id).pipe(
        Effect.flatMap((committed) => Deferred.succeed(committed, undefined)),
      ),
    ),
    Effect.forkScoped,
  );
  const holdMs = Number(
    process.argv.find((x) => x.startsWith("--reader-hold-ms="))?.split("=")[1] ?? 0,
  );
  if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs >= 120000)
    throw new Error("reader-hold-ms must be finite and between 0 and 120000 (exclusive)");
  const beginHold = Effect.fn("DelegateLoad.beginHold")(function* () {
    const entered = yield* Deferred.make();
    const released = yield* Deferred.make();
    yield* Effect.forkScoped(
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT 1`;
            yield* Deferred.succeed(entered, Date.now());
            yield* Effect.sleep(holdMs);
          }),
        )
        .pipe(NodeSqliteClient.readOnly, Effect.ensuring(Deferred.succeed(released, undefined))),
    );
    return { released, enteredAt: yield* Deferred.await(entered) };
  });
  const capture = (effect) =>
    effect.pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: true, value }),
        onFailure: (error) => ({ ok: false, error: { code: error.code, message: error.message } }),
      }),
    );
  let sequence = 0;
  let observedSteady = false;
  const call = Effect.fn("DelegateLoad.call")(function* (tool, occupancy) {
    const measure = measuring();
    if (!measure && observedSteady) return;
    if (measure) observedSteady = true;
    const seq = sequence++;
    const id = `delegate-load-${seq}`;
    const started = performance.now();
    const row = {
      tool,
      id,
      measured: measure,
      startedAt: Date.now(),
      readerHoldMs: occupancy ? holdMs : 0,
      readerEnteredAt: occupancy?.enteredAt,
    };
    samples.push(row);
    const input = {
      task: "Synthetic delegated task; never start an external provider",
      mode: "async",
      clientRequestId: id,
      target: { providerInstanceId: instanceId, model: modelSelection.model },
    };
    const result = yield* (
      tool === "delegate_task"
        ? mcp.delegateTask(scope, input)
        : mcp.sendToThread(scope, {
            threadId: target,
            message: `Synthetic send ${seq}`,
            mode: "queue",
            clientRequestId: id,
          })
    ).pipe(capture);
    Object.assign(row, { elapsedMs: performance.now() - started, result });
    // Reconcile after every call, including timeouts, without another new request id.
    if (tool === "delegate_task") {
      const expected = result.ok
        ? result.value.taskId
        : result.error.message.match(/Task (\S+) may/)?.[1];
      if (occupancy) yield* Deferred.await(occupancy.released);
      if (expected) {
        const committed = yield* milestone(expected);
        const observed = yield* Deferred.await(committed).pipe(Effect.timeoutOption("10 seconds"));
        Object.assign(row, { originalCommitObserved: Option.isSome(observed) });
        Object.assign(row, {
          beforeRetryStatus: yield* mcp.taskStatus(scope, expected).pipe(capture),
        });
        const before = yield* management.getThreadRecords(parent, ["subagents"]);
        Object.assign(row, {
          beforeRetryCount: before.subagents.filter((x) => x.id === expected).length,
        });
      }
      const retryStarted = performance.now();
      const retryStartedAt = Date.now();
      const again = yield* mcp.delegateTask(scope, input).pipe(capture);
      Object.assign(row, {
        retry: again,
        retryStartedAt,
        retryElapsedMs: performance.now() - retryStarted,
      });
      if (again.ok)
        Object.assign(row, {
          status: yield* mcp.taskStatus(scope, again.value.taskId).pipe(capture),
        });
    }
  });
  const drive = Effect.fn("DelegateLoad.drive")(function* (tool, interval) {
    let due = performance.now();
    if (tool === "delegate_task") {
      yield* Effect.sleep(10000);
      due = performance.now();
    }
    while (true) {
      const occupancy = holdMs > 0 && tool === "delegate_task" ? yield* beginHold() : undefined;
      yield* Effect.forkScoped(call(tool, occupancy));
      due += interval;
      yield* Effect.sleep(Math.max(0, due - performance.now()));
    }
  });
  yield* Effect.forkScoped(drive("delegate_task", 120000));
  yield* Effect.forkScoped(drive("t3_thread_send", 45000));
});
