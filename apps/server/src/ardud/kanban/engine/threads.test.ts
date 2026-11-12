import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CommandId,
  EventId,
  MessageId,
  RunAttemptId,
  TurnItemId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  backgroundWorkOf,
  KanbanThreadError,
  KanbanThreads,
  layer,
  prWatchesOf,
  viewStateOf,
} from "./threads.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const QUESTION_AT = "2026-10-25T00:10:00.000Z";
const FINISHED_AT = "2026-10-25T00:20:00.000Z";
const SHARED_UPDATED = "2026-10-25T00:50:00.000Z";

const shell = (overrides: Record<string, unknown>) => ({
  pendingRuntimeRequest: null,
  activityRunStatus: null,
  status: "idle" as const,
  updatedAt: at(SHARED_UPDATED),
  latestRunCompletedAt: null,
  ...overrides,
});

const question = (blocking: boolean | undefined) => ({
  id: RuntimeRequestId.make("req-1"),
  kind: "user_input" as const,
  createdAt: at(QUESTION_AT),
  ...(blocking === undefined ? {} : { blocking }),
});

describe("viewStateOf", () => {
  it("a blocking question stops the run: needs-input, quiet from the question", () => {
    const view = viewStateOf(
      shell({ pendingRuntimeRequest: question(true), activityRunStatus: "running" }),
    );
    expect(view.state).toBe("needs-input");
    expect(DateTime.formatIso(view.quietSince)).toBe(QUESTION_AT);
  });

  it("an async question never makes a running worker look quiet", () => {
    const view = viewStateOf(
      shell({
        pendingRuntimeRequest: question(false),
        activityRunStatus: "running",
        latestRunCompletedAt: at(FINISHED_AT),
      }),
    );
    expect(view.state).toBe("running");
    expect(DateTime.formatIso(view.quietSince)).toBe(FINISHED_AT);
  });

  it("an async question on an idle thread counts as no question: idle from the last finished run", () => {
    const view = viewStateOf(
      shell({ pendingRuntimeRequest: question(false), latestRunCompletedAt: at(FINISHED_AT) }),
    );
    expect(view.state).toBe("idle");
    expect(DateTime.formatIso(view.quietSince)).toBe(FINISHED_AT);
  });

  it("idle uses the last finished run, not the shared-session updatedAt", () => {
    const view = viewStateOf(shell({ latestRunCompletedAt: at(FINISHED_AT) }));
    expect(view.state).toBe("idle");
    expect(DateTime.formatIso(view.quietSince)).toBe(FINISHED_AT);
  });

  it("falls back to updatedAt only when no run ever finished", () => {
    const view = viewStateOf(shell({}));
    expect(DateTime.formatIso(view.quietSince)).toBe(SHARED_UPDATED);
  });

  it("an undefined blocking flag (older servers) is a blocking question", () => {
    const view = viewStateOf(shell({ pendingRuntimeRequest: question(undefined) }));
    expect(view.state).toBe("needs-input");
    expect(DateTime.formatIso(view.quietSince)).toBe(QUESTION_AT);
  });
});

describe("backgroundWorkOf", () => {
  it("counts subagents and background tasks, not commands or pull-request watches", () => {
    expect(
      backgroundWorkOf({
        pendingBackgroundTasks: [
          { taskId: "a", kind: "subagent" },
          { taskId: "b", kind: "background_task" },
          { taskId: "c", kind: "command" },
          { taskId: "pull-request-watch:github.com/x/y#1", kind: "monitor" },
        ],
      }),
    ).toBe(2);
  });

  it("is zero for an empty roster", () => {
    expect(backgroundWorkOf({ pendingBackgroundTasks: [] })).toBe(0);
  });

  it("is zero when the roster is missing (older shells)", () => {
    expect(backgroundWorkOf({})).toBe(0);
  });
});

describe("prWatchesOf", () => {
  const watchedPr = (overrides: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink => ({
    host: "github.com",
    repository: "x/y",
    number: 1,
    url: "https://github.com/x/y/pull/1",
    source: "agent",
    linkedAt: FINISHED_AT,
    stack: null,
    snapshot: {
      state: "open",
      title: "Change",
      headBranch: "change",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: FINISHED_AT,
    },
    watch: {
      startedAt: FINISHED_AT,
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: FINISHED_AT,
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    },
    ...overrides,
  });

  it.each([
    { name: "open", pr: watchedPr(), count: 1 },
    {
      name: "draft",
      pr: watchedPr({ snapshot: { ...watchedPr().snapshot!, isDraft: true } }),
      count: 1,
    },
    { name: "no snapshot yet", pr: watchedPr({ snapshot: null }), count: 1 },
    { name: "no watch", pr: watchedPr({ watch: undefined }), count: 0 },
    { name: "stack-dismissed", pr: watchedPr({ source: "stack-dismissed" }), count: 0 },
    {
      name: "merged",
      pr: watchedPr({ snapshot: { ...watchedPr().snapshot!, state: "merged" } }),
      count: 0,
    },
    {
      name: "closed",
      pr: watchedPr({ snapshot: { ...watchedPr().snapshot!, state: "closed" } }),
      count: 0,
    },
    {
      name: "ended watch",
      pr: watchedPr({ watch: undefined, endedWatch: watchedPr().watch }),
      count: 0,
    },
  ])("counts $name links correctly", ({ pr, count }) => {
    expect(prWatchesOf({ pullRequests: [pr] })).toBe(count);
  });

  it("counts each eligible link in a mixed roster", () => {
    expect(
      prWatchesOf({
        pullRequests: [watchedPr(), watchedPr({ snapshot: null }), watchedPr({ watch: undefined })],
      }),
    ).toBe(2);
  });

  it("is zero for an empty or missing roster", () => {
    expect(prWatchesOf({ pullRequests: [] })).toBe(0);
    expect(prWatchesOf({})).toBe(0);
  });
});

it.effect(
  "find distinguishes a failed shell read from a missing thread while view hides failures",
  () =>
    Effect.gen(function* () {
      const failedId = ThreadId.make("thread-shell-read-failed");
      const missingId = ThreadId.make("thread-shell-missing");
      const readError = new Orchestrator.OrchestratorProjectionError({
        threadId: failedId,
        cause: "injected shell read failure",
      });
      const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) =>
          threadId === failedId ? Effect.fail(readError) : Effect.succeed(null),
      });
      yield* Effect.gen(function* () {
        const threads = yield* KanbanThreads;
        const result = yield* Effect.result(threads.find(failedId));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(KanbanThreadError);
          expect(result.failure.operation).toBe("view");
          expect(result.failure.detail).toBe(readError.message);
        }
        expect(yield* threads.view(failedId)).toBeNull();
        expect(yield* threads.find(missingId)).toBeNull();
        expect(yield* threads.view(missingId)).toBeNull();
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(management),
            Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
            Layer.provide(Sqlite.layerMemory),
          ),
        ),
      );
    }),
);

it.effect.each(["first", "second", "missing", "completed", "none"] as const)(
  "active model reads the recorded run instead of a next-turn selection (%s)",
  (active) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-active-model");
      const first = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
      const second = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
      const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            deletedAt: null,
            modelSelection: second,
            activeRunId: active === "none" ? null : RunId.make("run-active"),
          } as never),
        getThreadRecords: () =>
          Effect.succeed({
            runs: [
              {
                id: RunId.make(active === "missing" ? "run-other" : "run-active"),
                status: active === "completed" ? "completed" : "running",
                modelSelection: active === "second" ? second : first,
              },
              { id: RunId.make("run-next"), status: "queued", modelSelection: second },
            ],
          } as never),
      });
      yield* Effect.gen(function* () {
        const threads = yield* KanbanThreads;
        expect(yield* threads.model(threadId)).toEqual(second);
        expect(yield* threads.model(threadId, true)).toEqual(
          active === "first" ? first : active === "second" ? second : null,
        );
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(management),
            Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
            Layer.provide(Sqlite.layerMemory),
          ),
        ),
      );
    }),
);

it.effect("interrupt fails on a failed shell read and treats a missing thread as stopped", () =>
  Effect.gen(function* () {
    const failedId = ThreadId.make("thread-stop-read-failed");
    const missingId = ThreadId.make("thread-stop-missing");
    const readError = new Orchestrator.OrchestratorProjectionError({
      threadId: failedId,
      cause: "injected shell read failure",
    });
    const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        threadId === failedId ? Effect.fail(readError) : Effect.succeed(null),
    });
    yield* Effect.gen(function* () {
      const threads = yield* KanbanThreads;
      // A saved stop retries on this instead of closing as delivered.
      const result = yield* Effect.result(threads.interrupt(failedId, "Card moved"));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(KanbanThreadError);
        expect(result.failure.operation).toBe("interrupt");
      }
      yield* threads.interrupt(missingId, "Card moved");
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(management),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    );
  }),
);

it.effect("a keyed send passes stable command and message ids to thread management", () =>
  Effect.gen(function* () {
    const sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
    const threadId = ThreadId.make("thread-wake");
    const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({ projectId: ProjectId.make("project-1"), deletedAt: null } as never),
      sendToThread: (input) =>
        Effect.sync(() => {
          sent.push(input);
          return {
            run: { id: `run-${sent.length}` },
            delivery: input.mode === "steer" ? "steered" : "started",
          } as never;
        }),
    });
    yield* Effect.gen(function* () {
      const threads = yield* KanbanThreads;
      yield* threads.send({ threadId, text: "Back", key: "wake:abc" });
      yield* threads.send({ threadId, text: "Back", key: "wake:abc" });
      yield* threads.send({ threadId, text: "Unkeyed" });
      yield* threads.send({ threadId, text: "Unkeyed" });
      yield* threads.send({ threadId, text: "Pause this card", mode: "steer" });
      expect(sent[0]?.commandId).toBe("kanban:send:wake:abc");
      expect(sent[0]?.messageId).toBe("kanban:wake:abc");
      expect(sent[1]?.commandId).toBe(sent[0]?.commandId);
      expect(sent[1]?.messageId).toBe(sent[0]?.messageId);
      expect(sent[2]?.commandId).not.toBe(sent[3]?.commandId);
      expect(sent.slice(0, 4).every((input) => input.mode === "auto")).toBe(true);
      expect(sent[4]?.mode).toBe("steer");
      expect(sent[4]?.activeTurnOnly).toBe(true);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(management),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    );
  }),
);

it.effect("a keyed send fails closed when its receipt can't be read", () =>
  Effect.gen(function* () {
    const sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
    const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({ projectId: ProjectId.make("project-1"), deletedAt: null } as never),
      sendToThread: (input) =>
        Effect.sync(() => {
          sent.push(input);
          return {} as never;
        }),
    });
    const sql = yield* SqlClient.SqlClient;
    // Make the real receipt repository's SELECT fail without replacing its layer.
    yield* sql`DROP TABLE orchestration_command_receipts`;
    yield* Effect.gen(function* () {
      const threads = yield* KanbanThreads;
      const result = yield* Effect.result(
        threads.send({ threadId: ThreadId.make("thread-wake"), text: "Back", key: "wake:abc" }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(KanbanThreadError);
        expect(result.failure.operation).toBe("send");
      }
      expect(sent).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(management),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        ),
      ),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("a rejected keyed wake can retry with real orchestrator receipts", () => {
  const db = Sqlite.layerMemory;
  const instanceId = ProviderInstanceId.make("codex");
  const projectId = ProjectId.make("project:outage-receipt");
  const threadId = ThreadId.make("thread:outage-receipt");
  const modelSelection = { instanceId, model: "gpt-5.1-codex" };
  let available = false;
  const adapter = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Provider execution is disabled in this test"),
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  const registry = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: (id) =>
        available
          ? Effect.succeed(adapter)
          : Effect.fail(
              new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId: id }),
            ),
      list: () => Effect.succeed(available ? [instanceId] : []),
    }),
  );
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(db));
  const recorded: Array<ThreadManagementService.ThreadManagementSendInput> = [];
  let failBeforeDispatch = false;
  let failAfterDispatch = false;
  let queueWithdrawal = false;
  let startWithdrawal = false;
  let restartBeforeCleanup = false;
  let siblingBeforeInterrupt = false;
  let nativeSteering: ThreadManagementService.ThreadManagementSendResult | null = null;
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name: "kanban-wake-receipts" },
    registry,
    { databaseLayer: db, runEffectWorker: false },
  );
  const management = ThreadManagementService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(runtime, receipts, ServerSettings.layerTest(), db)),
  );
  const dependencies = Layer.mergeAll(
    management,
    receipts,
    ProjectionStore.layer.pipe(Layer.provide(db)),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  );
  const instrumentedManagement = Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.gen(function* () {
      const real = yield* ThreadManagementService.ThreadManagementService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      return ThreadManagementService.ThreadManagementService.of({
        ...real,
        dispatch: (command) =>
          Effect.gen(function* () {
            if (siblingBeforeInterrupt && command.type === "run.interrupt") {
              siblingBeforeInterrupt = false;
              const records = yield* real.getThreadRecords(threadId, [
                "runs",
                "messages",
                "turnItems",
              ]);
              const run = records.runs.find((entry) => entry.id === command.runId)!;
              const root = records.turnItems.find(
                (item) => item.type === "user_message" && item.runId === run.id,
              );
              if (root?.type !== "user_message") return yield* Effect.die("Missing shared root");
              expect(command.expectedLastInputMessageId).toBe(root.messageId);
              yield* projections
                .apply({
                  id: EventId.make("withdrawal:native-sibling-after-read"),
                  type: "turn-item.updated",
                  threadId,
                  runId: run.id,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    ...root,
                    id: TurnItemId.make("item:late-native-sibling"),
                    messageId: MessageId.make("message:late-native-sibling"),
                    ordinal: root.ordinal + 1,
                    inputIntent: "steer",
                    text: "Late sibling work",
                  },
                })
                .pipe(Effect.orDie);
              nativeSteering = {
                dispatch: { sequence: 0, storedEvents: [] },
                projection: records,
                message: records.messages.find((message) => message.id === run.userMessageId)!,
                run,
                turnItem: root,
                delivery: "steered",
              };
            }
            if (restartBeforeCleanup && command.type === "run.interrupt") {
              restartBeforeCleanup = false;
              const records = yield* real.getThreadRecords(threadId, ["runs"]);
              const run = records.runs.find((entry) => entry.id === command.runId)!;
              expect(command.fenced).toBe(true);
              expect(command.expectedAttemptId).toBe(run.activeAttemptId);
              // A genuine restart commits after cleanup's read but before its interrupt.
              yield* projections
                .apply({
                  id: EventId.make("withdrawal:concurrent-steering-restart"),
                  type: "run.updated",
                  threadId,
                  runId: run.id,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    ...run,
                    status: "starting",
                    userMessageId: MessageId.make("message:genuine-steer"),
                    activeAttemptId: RunAttemptId.make("attempt:genuine-steer"),
                  },
                })
                .pipe(Effect.orDie);
            }
            return yield* real.dispatch(command);
          }),
        sendToThread: (input) =>
          Effect.gen(function* () {
            recorded.push(input);
            if (nativeSteering !== null && input.mode === "steer")
              return { ...nativeSteering, delivery: "steered" as const };
            if (failBeforeDispatch) {
              failBeforeDispatch = false;
              return yield* new ThreadManagementService.ThreadManagementProjectionLoadError({
                projectId: input.projectId,
                threadId: input.threadId,
                cause: "injected before dispatch",
              });
            }
            const result = yield* real.sendToThread(
              input.mode === "steer" && (queueWithdrawal || startWithdrawal)
                ? { ...input, mode: queueWithdrawal ? "queue" : "auto" }
                : input,
            );
            if (failAfterDispatch) {
              failAfterDispatch = false;
              return yield* new ThreadManagementService.ThreadManagementProjectionLoadError({
                projectId: input.projectId,
                threadId: input.threadId,
                cause: "injected after accepted dispatch",
              });
            }
            return result;
          }),
      });
    }),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const receiptStore = yield* CommandReceiptStore.CommandReceiptStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("kanban-wake-receipt:create"),
      threadId,
      projectId,
      title: "Outage wake",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    });
    yield* Effect.gen(function* () {
      const threads = yield* KanbanThreads;
      const wake = { threadId, text: "Model answers again", key: "wake:real-receipt" };
      expect(Result.isFailure(yield* Effect.result(threads.send(wake)))).toBe(true);
      const rejected = yield* receiptStore.getByCommandId(
        CommandId.make("kanban:send:wake:real-receipt"),
      );
      expect(Option.isSome(rejected) && rejected.value.status).toBe("rejected");
      expect((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages).toHaveLength(
        0,
      );
      // Multiple proven rejections advance only to the next deterministic attempt.
      expect(Result.isFailure(yield* Effect.result(threads.send(wake)))).toBe(true);
      const rejectedRetry = yield* receiptStore.getByCommandId(
        CommandId.make("kanban:send:wake:real-receipt:retry:1"),
      );
      expect(Option.isSome(rejectedRetry) && rejectedRetry.value.status).toBe("rejected");
    }).pipe(Effect.provide(layer.pipe(Layer.provide(instrumentedManagement))));

    // Rebuild the board adapter as on restart, but retain the orchestrator's DB.
    available = true;
    yield* Effect.gen(function* () {
      const threads = yield* KanbanThreads;
      // Withdrawals cannot become a queued turn when the original run is no longer steerable.
      const withdrawal = yield* Effect.result(
        threads.send({
          threadId,
          text: "Assignment withdrawn",
          key: "wake:withdrawal",
          mode: "steer",
        }),
      );
      expect(Result.isFailure(withdrawal)).toBe(true);
      expect(recorded.at(-1)?.mode).toBe("steer");
      expect(
        (yield* orchestrator.getThreadRecords(threadId, ["messages", "runs"])).messages,
      ).toHaveLength(0);
      expect((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(0);
      const wake = { threadId, text: "Model answers again", key: "wake:real-receipt" };
      failBeforeDispatch = true;
      expect(Result.isFailure(yield* Effect.result(threads.send(wake)))).toBe(true);
      expect(recorded.at(-1)?.commandId).toBe("kanban:send:wake:real-receipt:retry:2");
      expect(Option.isNone(yield* receiptStore.getByCommandId(recorded.at(-1)!.commandId))).toBe(
        true,
      );
      failAfterDispatch = true;
      expect(Result.isFailure(yield* Effect.result(threads.send(wake)))).toBe(true);
      expect(recorded.at(-1)?.commandId).toBe("kanban:send:wake:real-receipt:retry:2");
      const accepted = yield* receiptStore.getByCommandId(recorded.at(-1)!.commandId);
      expect(Option.isSome(accepted) && accepted.value.status).toBe("accepted");
      expect((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages).toHaveLength(
        1,
      );
    }).pipe(Effect.provide(Layer.fresh(layer).pipe(Layer.provide(instrumentedManagement))));

    yield* Effect.gen(function* () {
      const threads = yield* KanbanThreads;
      yield* threads.send({ threadId, text: "Model answers again", key: "wake:real-receipt" });
      expect(recorded.at(-1)?.commandId).toBe("kanban:send:wake:real-receipt:retry:2");
      expect((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages).toHaveLength(
        1,
      );
      const acceptedWake = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]!;
      yield* threads.withdraw({
        threadId,
        key: "wake:real-receipt",
        text: "The board changed while assigning this review",
      });
      const revoked = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
      expect(["interrupted", "cancelled"]).toContain(
        revoked.runs.find((run) => run.id === acceptedWake.id)?.status,
      );
      expect(
        revoked.messages.some(
          (message) => message.text === "The board changed while assigning this review",
        ),
      ).toBe(false);
      yield* threads.send({ threadId, key: "wake:next-worker", text: "Next valid work" });
      const original = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
      const records = yield* orchestrator.getThreadRecords(threadId, [
        "runs",
        "messages",
        "turnItems",
      ]);
      const root = records.turnItems.find(
        (item) => item.type === "user_message" && item.runId === original.id,
      );
      if (root?.type !== "user_message") return yield* Effect.die("Missing original root message");
      // Native steering adds an accepted input without replacing the root message or attempt.
      yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
        id: EventId.make("withdrawal:successful-native-sibling"),
        type: "turn-item.updated",
        threadId,
        runId: original.id,
        occurredAt: yield* DateTime.now,
        payload: {
          ...root,
          id: TurnItemId.make("item:successful-sibling"),
          messageId: MessageId.make("message:successful-sibling"),
          ordinal: root.ordinal + 1,
          inputIntent: "steer",
          text: "Sibling work",
        },
      });
      nativeSteering = {
        dispatch: { sequence: 0, storedEvents: [] },
        projection: records,
        message: records.messages.find((message) => message.id === original.userMessageId)!,
        run: original,
        turnItem: root,
        delivery: "steered",
      };
      yield* threads.withdraw({
        threadId,
        key: "wake:next-worker",
        text: "The board changed while assigning the original card",
      });
      nativeSteering = null;
      const shared = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const preservedRun = shared.runs.find((run) => run.id === original.id)!;
      expect(preservedRun.status).toBe(original.status);
      expect(preservedRun.userMessageId).toBe(original.userMessageId);
      expect(preservedRun.activeAttemptId).toBe(original.activeAttemptId);
      expect(shared.runs.filter((run) => run.status === "queued")).toHaveLength(0);
      expect(recorded.at(-1)?.mode).toBe("steer");
      expect(recorded.at(-1)?.text).toBe("The board changed while assigning the original card");
      // Both a returned result and a lost post-acceptance response must clean up the exact withdrawal.
      for (const lostResponse of [false, true]) {
        queueWithdrawal = true;
        failAfterDispatch = lostResponse;
        const withdrawn = yield* Effect.result(
          threads.send({
            threadId,
            text: "Assignment withdrawn",
            key: `wake:demoted-withdrawal:${lostResponse}`,
            mode: "steer",
          }),
        );
        expect(Result.isFailure(withdrawn)).toBe(true);
        const runs = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs;
        expect(runs.filter((run) => run.status === "queued")).toHaveLength(0);
        expect(runs.find((run) => run.id === original.id)?.status).toBe(original.status);
      }
      // Reproduce completion after steer preflight: the orchestrator starts a new withdrawal turn.
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("wake:finish-original"),
        threadId,
        runId: original.id,
        holdQueue: false,
      });
      queueWithdrawal = false;
      startWithdrawal = true;
      for (const lostResponse of [false, true]) {
        failAfterDispatch = lostResponse;
        const withdrawn = yield* Effect.result(
          threads.send({
            threadId,
            text: "Assignment withdrawn",
            key: `wake:late-withdrawal:${lostResponse}`,
            mode: "steer",
          }),
        );
        expect(Result.isFailure(withdrawn)).toBe(true);
        const runs = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs;
        expect(
          runs.filter((run) =>
            ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
          ),
        ).toHaveLength(0);
      }
      restartBeforeCleanup = true;
      const raced = yield* Effect.result(
        threads.send({
          threadId,
          text: "Assignment withdrawn",
          key: "wake:cleanup-attempt-race",
          mode: "steer",
        }),
      );
      expect(Result.isFailure(raced)).toBe(true);
      expect(restartBeforeCleanup).toBe(false);
      const preserved = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.activeAttemptId === "attempt:genuine-steer",
      );
      expect(preserved?.status).toBe("starting");
      expect(preserved?.userMessageId).toBe("message:genuine-steer");
      // The preceding attempt is synthetic and has no runtime attempt row to interrupt.
      yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
        id: EventId.make("withdrawal:finish-synthetic-restart"),
        type: "run.updated",
        threadId,
        runId: preserved!.id,
        occurredAt: yield* DateTime.now,
        payload: { ...preserved!, status: "interrupted", completedAt: yield* DateTime.now },
      });
      yield* threads.send({
        threadId,
        key: "wake:late-native-sibling",
        text: "Original card before late sibling",
      });
      const lateRoot = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
      siblingBeforeInterrupt = true;
      yield* threads.withdraw({
        threadId,
        key: "wake:late-native-sibling",
        text: "Stop only the original card",
      });
      nativeSteering = null;
      expect(siblingBeforeInterrupt).toBe(false);
      const lateShared = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const latePreserved = lateShared.runs.find((run) => run.id === lateRoot.id)!;
      expect(latePreserved.status).toBe(lateRoot.status);
      expect(latePreserved.userMessageId).toBe(lateRoot.userMessageId);
      expect(latePreserved.activeAttemptId).toBe(lateRoot.activeAttemptId);
      expect(lateShared.runs.filter((run) => run.status === "queued")).toHaveLength(0);
      expect(recorded.at(-1)?.mode).toBe("steer");
      expect(recorded.at(-1)?.text).toBe("Stop only the original card");
    }).pipe(Effect.provide(Layer.fresh(layer).pipe(Layer.provide(instrumentedManagement))));
  }).pipe(Effect.provide(dependencies));
});

it.effect("an accepted keyed wake replays once but a new key sends another message", () => {
  const db = Sqlite.layerMemory;
  const instanceId = ProviderInstanceId.make("codex");
  const projectId = ProjectId.make("project:wake-epochs");
  const threadId = ThreadId.make("thread:wake-epochs");
  const adapter = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Provider execution is disabled in this test"),
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  const registry = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: () => Effect.succeed(adapter),
      list: () => Effect.succeed([instanceId]),
    }),
  );
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(db));
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name: "kanban-wake-epochs" },
    registry,
    { databaseLayer: db, runEffectWorker: false },
  );
  const management = ThreadManagementService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(runtime, receipts, ServerSettings.layerTest(), db)),
  );
  const dependencies = Layer.mergeAll(
    management,
    receipts,
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const receiptStore = yield* CommandReceiptStore.CommandReceiptStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("kanban-wake-epochs:create"),
      threadId,
      projectId,
      title: "Outage wake epochs",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    });
    yield* Effect.gen(function* () {
      const threads = yield* KanbanThreads;
      const wake = { threadId, text: "Model answers again", key: "wake:k1" };
      yield* threads.send(wake);
      const receipt = yield* receiptStore.getByCommandId(CommandId.make("kanban:send:wake:k1"));
      expect(Option.isSome(receipt) && receipt.value.status).toBe("accepted");
      expect((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages).toHaveLength(
        1,
      );
      yield* threads.send(wake);
      expect((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages).toHaveLength(
        1,
      );
      yield* threads.send({ ...wake, key: "wake:k2" });
      expect((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages).toHaveLength(
        2,
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(dependencies));
});

it.effect.each([
  "preparing",
  "queued",
  "shared queued",
  "shared active",
  "shared completed",
  "shared failed",
  "shared interrupted",
] as const)(
  "#566 stopping an abandoned %s launch prevents its pending turn from starting",
  (state) => {
    const db = Sqlite.layerMemory;
    const instanceId = ProviderInstanceId.make("codex");
    const projectId = ProjectId.make("project:abandoned");
    const threadId = ThreadId.make("thread:abandoned");
    const modelSelection = { instanceId, model: "gpt-5.1-codex" };
    const adapter = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("Provider execution is disabled in this test"),
    } as ProviderAdapter.ProviderAdapterV2["Service"];
    const registry = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        get: () => Effect.succeed(adapter),
        list: () => Effect.succeed([instanceId]),
      }),
    );
    const receipts = CommandReceiptStore.layer.pipe(Layer.provide(db));
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "kanban-abandoned" },
      registry,
      { databaseLayer: db, runEffectWorker: false },
    );
    const management = ThreadManagementService.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(runtime, receipts, ServerSettings.layerTest(), db)),
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("abandon:create"),
        threadId,
        projectId,
        title: "Abandoned",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
      const count = state === "preparing" ? 1 : 2;
      for (let i = 0; i < count; i++)
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`abandon:message:${i}`),
          threadId,
          messageId: MessageId.make(`abandon:message:${i}`),
          text: "Run",
          attachments: [],
          modelSelection,
          dispatchMode:
            state === "preparing"
              ? { type: "defer_start", workspaceStrategy: { type: "root" } }
              : i === 0
                ? { type: "start_immediately" }
                : { type: "queue_after_active" },
          createdBy: "system",
          creationSource: "server",
        });
      expect((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.at(-1)?.status).toBe(
        state === "preparing" ? "preparing" : "queued",
      );
      const threads = yield* KanbanThreads;
      if (state.startsWith("shared")) {
        const before = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs;
        const target = state === "shared queued" ? before.at(-1)! : before[0]!;
        expect(yield* threads.cancelQueued(threadId, target.id)).toBe(state === "shared queued");
        const after = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs;
        expect(after[0]).toEqual(before[0]);
        expect(after.at(-1)?.status).toBe(state === "shared queued" ? "cancelled" : "queued");
        return;
      }
      yield* threads.interrupt(threadId, "Abandoned launch", true);
      const after = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs;
      expect(after.every((run) => ["cancelled", "interrupted"].includes(run.status))).toBe(true);
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("abandon:resume"),
        threadId,
      });
      expect(
        (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.map((run) => run.status),
      ).toEqual(after.map((run) => run.status));
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provideMerge(
            Layer.effect(
              ThreadManagementService.ThreadManagementService,
              Effect.map(ThreadManagementService.ThreadManagementService, (service) =>
                ThreadManagementService.ThreadManagementService.of({
                  ...service,
                  getThreadRecords: (id, fields, filter) =>
                    Effect.gen(function* () {
                      const records = yield* service.getThreadRecords(id, fields, filter);
                      if (
                        !["shared completed", "shared failed", "shared interrupted"].includes(state)
                      )
                        return records;
                      const { runs } = yield* service.getThreadRecords(id, ["runs"]);
                      return {
                        ...records,
                        runs: runs.map((run) => ({
                          ...run,
                          status:
                            state === "shared completed"
                              ? ("completed" as const)
                              : state === "shared failed"
                                ? ("failed" as const)
                                : ("interrupted" as const),
                        })),
                      };
                    }),
                }),
              ),
            ).pipe(Layer.provideMerge(management)),
          ),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        ),
      ),
    );
  },
);
