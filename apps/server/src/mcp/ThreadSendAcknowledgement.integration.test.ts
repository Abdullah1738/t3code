import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");
const threadId = ThreadId.make("thread:send-ack");
const projectId = ProjectId.make("project:send-ack");
const selection = { instanceId, model: "test-claude" };
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:send-ack"),
  requestNamespace: "send-ack-test",
  thread: undefined,
  client: { sessionId: "test", label: "test", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

it.effect.each([
  "command lane",
  "provider acceptance",
  "cross-target conflict",
  "run snapshot",
  "background reader",
  "background reader with paced continuation",
  "receipt replay",
  "canonical reader running auto",
  "canonical reader running steer",
  "canonical reader completed auto",
] as const)(
  "acknowledges idle sends and bounds a blocked %s without duplicating a retry",
  (blocked) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`send-ack-${blocked.replaceAll(" ", "-")}`);
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const steerEntered = yield* Deferred.make<void>();
        const offer = yield* Deferred.make<void>();
        const bothPlanning = yield* Deferred.make<void>();
        const preflightRead = yield* Deferred.make<void>();
        const resumeDispatch = yield* Deferred.make<void>();
        let gateSteer = false;
        let gatePlanning = false;
        let planning = 0;
        let starts = 0;
        const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
          instanceId,
          driver,
          getCapabilities: () =>
            Effect.gen(function* () {
              if (gatePlanning) {
                planning += 1;
                if (planning === 2) yield* Deferred.succeed(bothPlanning, undefined);
                yield* Deferred.await(bothPlanning);
              }
              return CodexProviderCapabilitiesV2;
            }),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: selection.model,
                  capabilities: CodexProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                ensureThread: ({ threadId: id }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`provider:${id}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: id,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: "native", strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    starts += 1;
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: ProviderTurnId.make(`turn:${turn.attemptId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: { driver, nativeId: "turn", strength: "strong" },
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                  }),
                steerTurn: () =>
                  Deferred.succeed(steerEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(offer)),
                  ),
                interruptTurn: () => Effect.void,
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
        const registry = ProviderAdapterRegistry.layerSingle(adapter);
        const database =
          blocked.startsWith("background reader") || blocked.startsWith("canonical reader")
            ? Sqlite.layerFromPath(`${cwd}/send.sqlite`).pipe(Layer.provide(NodeServices.layer))
            : Sqlite.layerMemory;
        const runtime = ProviderReplayHarness.layerWithRegistry(
          { name: `send-ack-${blocked}`, runtimePolicyOverride: { cwd } },
          registry,
          { databaseLayer: database, runEffectWorker: false },
        );
        const settings = ServerSettings.layerTest(
          blocked === "receipt replay" ? { ardudHarnessMigration: { cutoverComplete: true } } : {},
        );
        const dispatchRuntime = Layer.effect(
          Orchestrator.OrchestratorV2,
          Effect.gen(function* () {
            const actual = yield* Orchestrator.OrchestratorV2;
            return {
              ...actual,
              dispatch: (command) =>
                Effect.gen(function* () {
                  if (gateSteer && command.type === "message.dispatch") {
                    gateSteer = false;
                    yield* Deferred.succeed(preflightRead, undefined);
                    yield* Deferred.await(resumeDispatch);
                  }
                  return yield* actual.dispatch(command);
                }),
            } satisfies typeof actual;
          }),
        ).pipe(Layer.provideMerge(runtime));
        const threads = ThreadManagementService.layer.pipe(
          Layer.provideMerge(dispatchRuntime),
          Layer.provideMerge(settings),
          Layer.provideMerge(
            Layer.mergeAll(
              CommandReceiptStore.layer,
              EffectOutbox.layer,
              ProjectionStore.layer,
            ).pipe(Layer.provide(database)),
          ),
          Layer.provideMerge(ThreadCommandExecutor.layer),
        );
        const layer = OrchestratorMcpService.layer.pipe(
          Layer.provideMerge(database),
          Layer.provideMerge(threads),
          Layer.provide(
            Layer.mergeAll(
              registry,
              settings,
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              NodeServices.layer,
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId,
            title: "Send acknowledgement",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const request = { threadId, message: "Start the idle child", clientRequestId: "idle" };
          if (blocked.startsWith("canonical reader")) {
            const initial = yield* service.sendToThread(scope, request);
            const runningEvent = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.threadId === threadId &&
                  event.type === "provider-turn.updated" &&
                  event.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* worker.drain();
            yield* Fiber.join(runningEvent);
            const store = yield* ProjectionStore.ProjectionStoreV2;
            const sink = yield* EventSink.EventSinkV2;
            const running = (yield* store.getThreadRecords(threadId, ["runs"])).runs.find(
              (run) => run.id === initial.runId,
            )!;
            assert.equal(running.status, "running");
            const completed = blocked === "canonical reader completed auto";
            if (completed) {
              const now = yield* DateTime.now;
              yield* sink.write({
                events: [
                  {
                    id: EventId.make("complete-before-canonical-read"),
                    type: "run.updated",
                    threadId,
                    occurredAt: now,
                    payload: { ...running, status: "completed", completedAt: now },
                  },
                ],
              });
            }
            const entered = yield* Deferred.make<NodeSqliteClient.SqliteStatementObservation>();
            const release = yield* Deferred.make<void>();
            let paused = false;
            // This is the orphan sweep's real read boundary, with its snapshot held open.
            const reader = yield* store.getThreadRecords(threadId, ["providerThreads"]).pipe(
              Effect.provideService(NodeSqliteClient.StatementObserver, {
                slowThresholdMs: 0,
                record: (observation) =>
                  Effect.suspend(() => {
                    if (paused) return Effect.void;
                    paused = true;
                    return Deferred.succeed(entered, observation).pipe(
                      Effect.andThen(Deferred.await(release)),
                    );
                  }),
              }),
              Effect.forkChild,
            );
            yield* Effect.gen(function* () {
              assert.equal((yield* Deferred.await(entered)).connection, "reader");
              const followup = {
                threadId,
                message: "Follow up during a canonical snapshot",
                mode:
                  blocked === "canonical reader running steer"
                    ? ("steer" as const)
                    : ("auto" as const),
                clientRequestId: "during-canonical-read",
              };
              const result = yield* service
                .sendToThread(scope, followup)
                .pipe(Effect.timeout("3 seconds"), TestClock.withLive);
              assert.equal(result.delivery, completed ? "started" : "steered");
              if (completed) assert.notEqual(result.runId, initial.runId);
              else assert.equal(result.runId, initial.runId);
              const repeated = yield* service
                .sendToThread(scope, followup)
                .pipe(Effect.timeout("3 seconds"), TestClock.withLive);
              assert.equal(repeated.messageId, result.messageId);
              assert.equal(repeated.runId, result.runId);
              assert.isUndefined(reader.pollUnsafe());
              const messages = yield* store
                .getThreadRecords(threadId, ["messages"])
                .pipe(NodeSqliteClient.foregroundReads);
              assert.lengthOf(messages.messages, 2);
              assert.lengthOf(
                messages.messages.filter((message) => message.id === result.messageId),
                1,
              );
            }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
            yield* Fiber.join(reader);
            return;
          }
          if (blocked.startsWith("background reader")) {
            let expectedMessages = 1;
            if (blocked === "background reader with paced continuation") {
              const old = yield* service.sendToThread(scope, {
                ...request,
                clientRequestId: "before-restart",
              });
              yield* orchestrator.dispatch({
                type: "run.interrupt",
                commandId: CommandId.make("restart-cut"),
                threadId,
                runId: old.runId,
                fenced: true,
              });
              const outbox = yield* EffectOutbox.EffectOutboxV2;
              yield* outbox.enqueue([
                {
                  id: "leftover-paced-continuation",
                  commandId: CommandId.make("restart-resume"),
                  threadId,
                  request: {
                    type: "provider-runtime.continue",
                    sourceRunId: old.runId,
                  },
                  availableAt: DateTime.add(yield* DateTime.now, { hours: 1 }),
                },
              ]);
              assert.isTrue(yield* outbox.hasPendingRunContinuation(threadId));
              assert.isUndefined(
                ThreadManagementService.latestActiveRun(
                  yield* orchestrator.getThreadProjection(threadId),
                ),
              );
              expectedMessages += 1;
            }
            const sql = yield* SqlClient.SqlClient;
            const held = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const holder = yield* sql
              .withTransaction(
                sql`SELECT 1`.pipe(
                  Effect.andThen(Deferred.succeed(held, undefined)),
                  Effect.andThen(Deferred.await(release)),
                ),
              )
              .pipe(NodeSqliteClient.readOnly, NodeSqliteClient.backgroundReads, Effect.forkChild);
            yield* Deferred.await(held);
            // The background transaction stays open until the message is committed.
            const result = yield* service.sendToThread(scope, { ...request, mode: "queue" });
            assert.equal(result.delivery, "started");
            const writerHeld = yield* Deferred.make<void>();
            const releaseWriter = yield* Deferred.make<void>();
            const writer = yield* sql
              .withTransaction(
                sql`SELECT 1`.pipe(
                  Effect.andThen(Deferred.succeed(writerHeld, undefined)),
                  Effect.andThen(Deferred.await(releaseWriter)),
                ),
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(writerHeld);
            const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
            const receipt = yield* receipts
              .getByCommandId(CommandId.make("command:mcp:send-ack-test:thread-send:idle"))
              .pipe(NodeSqliteClient.foregroundReads);
            assert.equal(receipt._tag, "Some");
            yield* Deferred.succeed(releaseWriter, undefined);
            yield* Fiber.join(writer);
            if (receipt._tag === "Some") {
              const ownCommand = CommandId.make("receipt-in-own-transaction");
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* receipts.insertIfAbsent({ ...receipt.value, commandId: ownCommand });
                  assert.equal((yield* receipts.getByCommandId(ownCommand))._tag, "Some");
                }),
              );
            }
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(holder);
            yield* worker.drain();
            assert.equal(starts, 1);
            assert.lengthOf(
              (yield* orchestrator.getThreadProjection(threadId)).messages,
              expectedMessages,
            );
            return;
          }
          if (blocked === "cross-target conflict") {
            const other = ThreadId.make("thread:other-send-target");
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create-other"),
              threadId: other,
              projectId,
              title: "Other target",
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            gatePlanning = true;
            const results = yield* Effect.all(
              [
                service.sendToThread(scope, request).pipe(Effect.result),
                service.sendToThread(scope, { ...request, threadId: other }).pipe(Effect.result),
              ],
              { concurrency: 2 },
            );
            gatePlanning = false;
            assert.equal(results.filter((result) => result._tag === "Success").length, 1);
            assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).messages.length +
                (yield* orchestrator.getThreadProjection(other)).messages.length,
              1,
            );
            return;
          }
          if (blocked === "command lane") {
            const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const holder = yield* locks
              .withLock(
                threadId,
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            const waiting = yield* service
              .sendToThread(scope, request)
              .pipe(Effect.result, Effect.forkChild);
            yield* TestClock.adjust("15 seconds");
            const result = yield* Fiber.join(waiting);
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") assert.equal(result.failure.code, "send_timeout");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(holder);
            assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).messages, 0);
          }
          const [started, concurrent] = yield* Effect.all(
            [service.sendToThread(scope, request), service.sendToThread(scope, request)],
            { concurrency: 2 },
          );
          assert.equal(started.delivery, "started");
          assert.equal(concurrent.messageId, started.messageId);
          assert.equal(concurrent.runId, started.runId);
          const running = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* worker.drain();
          yield* Fiber.join(running);
          assert.equal(starts, 1);
          assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).messages, 1);
          if (blocked === "run snapshot") {
            gateSteer = true;
            const steerRequest = {
              threadId,
              message: "Steer after a concurrent task attachment",
              mode: "steer" as const,
              clientRequestId: "steer-snapshot",
            };
            const steering = yield* service
              .sendToThread(scope, steerRequest)
              .pipe(Effect.forkChild);
            yield* Deferred.await(preflightRead);
            const sink = yield* EventSink.EventSinkV2;
            const taskId = NodeId.make("task:attached-before-dispatch");
            const before = yield* orchestrator.getThreadProjection(threadId);
            const run = before.runs.find((candidate) => candidate.id === started.runId)!;
            assert.isUndefined(run.delegatedTaskId);
            const now = yield* DateTime.now;
            // A native restart can attach a task to the same run after preflight.
            yield* sink.write({
              events: [
                {
                  id: EventId.make("event:attach-task-before-steer"),
                  type: "run.updated",
                  threadId,
                  runId: run.id,
                  occurredAt: now,
                  payload: { ...run, delegatedTaskId: taskId },
                },
              ],
            });
            yield* Deferred.succeed(resumeDispatch, undefined);
            const steered = yield* Fiber.join(steering);
            assert.equal(steered.delivery, "steered");
            assert.equal(steered.runId, run.id);
            assert.equal(steered.taskId, taskId);
            const replayed = yield* service.sendToThread(scope, steerRequest);
            assert.equal(replayed.taskId, taskId);
            assert.equal(replayed.messageId, steered.messageId);
            assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).messages, 2);
            return;
          }
          if (blocked === "receipt replay") {
            const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
            const held = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const holder = yield* locks
              .withLock(
                threadId,
                Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(held);
            const replay = yield* service
              .sendToThread(scope, request)
              .pipe(Effect.result, Effect.forkChild);
            yield* TestClock.adjust("15 seconds");
            const result = yield* Fiber.join(replay);
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") {
              assert.include(
                result.failure.message,
                `message replay dispatch for thread ${threadId}`,
              );
              assert.notInclude(result.failure.message, "receipt read");
            }
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(holder);
          }
          const repeated = yield* service.sendToThread(scope, request);
          assert.equal(repeated.messageId, started.messageId);
          assert.equal(repeated.runId, started.runId);
          assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).messages, 1);
          const queued = yield* service.sendToThread(scope, {
            threadId,
            message: "A separate follow-up",
            mode: "queue",
            clientRequestId: "queue",
          });
          assert.equal(queued.delivery, "queued");
          assert.equal(queued.status, "queued");
          const steer = yield* service.sendToThread(scope, {
            threadId,
            message: "Steer while offer waits",
            mode: "steer",
            clientRequestId: "steer",
          });
          assert.equal(steer.delivery, "steered");
          assert.equal(steer.runId, started.runId);
          const delivering = yield* worker.drain().pipe(Effect.forkChild);
          yield* Deferred.await(steerEntered);
          const saved = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            saved.messages.find((message) => message.id === steer.messageId)?.text,
            "Steer while offer waits",
          );
          yield* Deferred.succeed(offer, undefined);
          yield* Fiber.join(delivering);
          assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).messages, 3);
          const restarted = yield* service.sendToThread(scope, {
            threadId,
            message: "Restart with this input",
            mode: "restart",
            clientRequestId: "restart",
          });
          assert.equal(restarted.delivery, "restarted");
          assert.equal(restarted.runId, started.runId);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
