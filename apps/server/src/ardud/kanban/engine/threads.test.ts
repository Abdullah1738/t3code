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
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as CommandReceipts from "../../../persistence/OrchestrationCommandReceipts.ts";
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
  coalesceTarget,
  queuedWakes,
  KanbanThreadError,
  KanbanThreads,
  layer,
  prWatchesOf,
  viewStateOf,
} from "./threads.ts";

import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";

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
      passedPending: [],
      remarksThrough: FINISHED_AT,
      remarkIds: [],
      conflicting: false,
      conflictHead: null,
      conflictWokeFor: null,
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

  it.effect.each(["current", "legacy", "ended"] as const)(
    "find keeps the observed PR head separate from its CI checkpoint (%s)",
    (state) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-pr-heads");
        const checkpoint = "aaaaaaa111111111";
        const observed = "bbbbbbb222222222";
        const watch = {
          ...watchedPr().watch!,
          headSha: checkpoint,
          ...(state === "current" ? { observedHeadSha: observed } : {}),
        };
        const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              ...shell({}),
              id: threadId,
              projectId: ProjectId.make("project-1"),
              deletedAt: null,
              activeRunId: null,
              activityRunStartedAt: null,
              archivedAt: null,
              title: "Watched PR",
              pullRequests: [
                watchedPr(state === "ended" ? { watch: undefined, endedWatch: watch } : { watch }),
              ],
            } as never),
        });
        yield* Effect.gen(function* () {
          const threads = yield* KanbanThreads;
          const view = yield* threads.find(threadId);
          expect(view?.prs[0]?.head).toBe(state === "ended" ? null : checkpoint);
          expect(view?.prs[0]?.observedHead).toBe(state === "current" ? observed : null);
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

it.effect.each(
  (["queued", "running", "completed", "missing"] as const).flatMap((status) =>
    (["run", "unscoped message", "scoped message"] as const).map((mode) => ({ status, mode })),
  ),
)(
  "$mode cleanup leaves a restored run and its queue alone (old run: $status)",
  ({ status, mode }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("restored-thread");
      const stopped: Array<string | undefined> = [];
      const cancelled: Array<string> = [];
      let restoredRunning = true;
      let oldCancelled = false;
      const messageId = mode === "scoped message" ? "kanban:wake:nudge:old" : "kanban:old";
      const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            projectId: ProjectId.make("project-1"),
            deletedAt: null,
            activeRunId: "restored-run",
          } as never),
        getThreadRecords: () =>
          Effect.succeed({
            runs: [
              ...(status === "missing"
                ? []
                : [
                    {
                      id: RunId.make("old-run"),
                      userMessageId: messageId,
                      status: oldCancelled ? "cancelled" : status,
                    },
                  ]),
              { id: RunId.make("restored-run"), status: "running" },
              { id: RunId.make("restored-queue"), status: "queued" },
            ],
          } as never),
        interruptThread: (input) =>
          Effect.sync(() => {
            stopped.push(input.runId);
            if (input.runId === undefined || input.runId === "restored-run")
              restoredRunning = false;
          }).pipe(
            Effect.andThen(
              status === "missing"
                ? Effect.fail(
                    new ThreadManagementService.ThreadManagementRunNotFoundError({
                      threadId,
                      runId: RunId.make("old-run"),
                    }),
                  )
                : Effect.succeed({ type: "no_active_run" } as never),
            ),
          ),
        dispatch: (input) =>
          Effect.sync(() => {
            if (input.type === "thread.stop") restoredRunning = false;
            if (input.type === "queued-run.cancel") {
              cancelled.push(input.runId);
              if (input.runId === "old-run") oldCancelled = true;
            }
            return { storedEvents: [] } as never;
          }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* KanbanThreads;
        if (mode === "run") {
          yield* threads.cancelQueued(threadId, "old-run");
          yield* threads.interrupt(threadId, "Late archived send", false, "old-run");
        } else
          yield* threads.interrupt(threadId, "Late archived send", false, undefined, messageId);
        expect(restoredRunning).toBe(true);
        expect(stopped).toEqual(status === "missing" && mode !== "run" ? [] : ["old-run"]);
        expect(cancelled).toEqual(status === "queued" ? ["old-run"] : []);
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
      expect(
        yield* threads.interrupt(missingId, "Old send", false, undefined, "kanban:old"),
      ).toEqual({ outcome: "noop" });
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

it.effect(
  "pendingUserInputs returns readable pending questions only, preserving every option",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-questions");
      const requests = [
        ["pending", "user_input", "pending"],
        ["resolved", "user_input", "resolved"],
        ["cancelled", "user_input", "cancelled"],
        ["expired", "user_input", "expired"],
        ["approval", "command", "pending"],
        ["missing-item", "user_input", "pending"],
      ] as const;
      const runtimeRequests: OrchestrationV2RuntimeRequest[] = requests.map(
        ([id, kind, status]) => ({
          id: RuntimeRequestId.make(id),
          nodeId: NodeId.make(id),
          kind,
          status,
          providerTurnId: null,
          nativeRequestRef: null,
          responseCapability: { type: "message" },
          createdAt: at(QUESTION_AT),
          resolvedAt: status === "pending" ? null : at(FINISHED_AT),
        }),
      );
      const questions = [
        {
          id: "strategy",
          header: "Git",
          question: "Rebase or merge?",
          options: [
            { label: "Rebase", description: "Force-push", value: "rebase" },
            { label: "Merge", description: "Normal push" },
          ],
        },
      ];
      const turnItems: OrchestrationV2TurnItem[] = requests
        .filter(([id]) => id !== "missing-item")
        .map(([id], ordinal) => ({
          id: TurnItemId.make(id),
          threadId,
          runId: null,
          nodeId: NodeId.make(id),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "waiting",
          title: null,
          startedAt: at(QUESTION_AT),
          completedAt: null,
          updatedAt: at(QUESTION_AT),
          type: "user_input_request",
          requestId: RuntimeRequestId.make(id),
          questions,
        }));
      let fail = false;
      const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          fail
            ? Effect.fail(
                new Orchestrator.OrchestratorProjectionError({ threadId, cause: "read failed" }),
              )
            : Effect.succeed({ runtimeRequests, turnItems } as never),
      });
      yield* Effect.gen(function* () {
        const threads = yield* KanbanThreads;
        expect(yield* threads.pendingUserInputs(threadId)).toEqual([
          { requestId: RuntimeRequestId.make("pending"), questions },
        ]);
        fail = true;
        const result = yield* Effect.result(threads.pendingUserInputs(threadId));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.operation).toBe("pendingUserInputs");
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

it.effect.each([
  {
    commandType: "message.dispatch",
    status: "rejected",
    cross: true,
    acceptedRetry: false,
    sends: 1,
    ok: true,
  },
  {
    commandType: "message.dispatch",
    status: "accepted",
    cross: true,
    acceptedRetry: false,
    sends: 0,
    ok: true,
  },
  {
    commandType: "message.dispatch",
    status: "rejected",
    cross: true,
    acceptedRetry: true,
    sends: 0,
    ok: true,
  },
  {
    commandType: "message.dispatch",
    status: "rejected",
    cross: false,
    acceptedRetry: false,
    sends: 0,
    ok: false,
  },
  {
    commandType: "message.dispatch",
    status: "accepted",
    cross: false,
    acceptedRetry: false,
    sends: 0,
    ok: false,
  },
  {
    commandType: "queued-run.edit",
    status: "accepted",
    cross: true,
    acceptedRetry: false,
    coalesce: "step:A",
    sends: 0,
    ok: true,
  },
  {
    commandType: "queued-run.edit",
    status: "accepted",
    cross: false,
    acceptedRetry: false,
    coalesce: "step:A",
    sends: 0,
    ok: false,
  },
  {
    commandType: "queued-run.edit",
    status: "accepted",
    cross: true,
    acceptedRetry: false,
    sends: 0,
    ok: false,
  },
  {
    commandType: "queued-run.edit",
    status: "rejected",
    cross: true,
    acceptedRetry: false,
    coalesce: "step:A",
    sends: 0,
    ok: false,
  },
  {
    commandType: "queued-run.edit",
    status: "rejected",
    cross: true,
    acceptedRetry: true,
    coalesce: "step:A",
    sends: 0,
    ok: false,
  },
  {
    commandType: "queued-run.cancel",
    status: "accepted",
    cross: true,
    acceptedRetry: false,
    coalesce: "step:A",
    sends: 0,
    ok: false,
  },
] as const)(
  "delivery replacement: $commandType prior=$status cross=$cross acceptedRetry=$acceptedRetry coalesce=$coalesce",
  (row) =>
    Effect.gen(function* () {
      const old = ThreadId.make("old-evaluator");
      const replacement = ThreadId.make("replacement-evaluator");
      const sent: string[] = [];
      const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({ projectId: ProjectId.make("project-1"), deletedAt: null } as never),
        getThreadRecords: () => Effect.succeed({ runs: [] } as never),
        sendToThread: (input) =>
          Effect.sync(() => {
            sent.push(input.commandId);
            return { run: { id: "delivered" } } as never;
          }),
      });
      yield* Effect.gen(function* () {
        const receipts = yield* CommandReceipts.OrchestrationCommandReceiptRepository;
        const receipt = {
          commandId: CommandId.make("kanban:send:question-key"),
          aggregateKind: "thread" as const,
          aggregateId: old,
          commandType: row.commandType,
          acceptedAt: QUESTION_AT,
          resultSequence: 1,
          status: row.status,
          error: row.status === "rejected" ? "unavailable" : null,
        };
        yield* receipts.insertIfAbsent(receipt);
        if (row.acceptedRetry)
          yield* receipts.insertIfAbsent({
            ...receipt,
            commandId: CommandId.make("kanban:send:question-key:retry:1"),
            status: "accepted",
            error: null,
          });
        const threads = yield* KanbanThreads;
        const result = yield* Effect.result(
          threads.send({
            threadId: replacement,
            text: "Same question",
            key: "question-key",
            keyAcrossThreads: row.cross,
            ...("coalesce" in row ? { coalesce: row.coalesce } : {}),
          }),
        );
        expect(Result.isSuccess(result)).toBe(row.ok);
        expect(sent).toHaveLength(row.sends);
        if (row.sends) expect(sent[0]).toBe("kanban:send:question-key:retry:1");
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(management),
            Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
            Layer.provideMerge(CommandReceipts.layer),
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
      yield* threads.send({
        threadId,
        text: "Deleted board",
        key: "stale-unscoped",
        isStale: () => true,
      });
      expect(sent).toHaveLength(0);
      yield* threads.send({ threadId, text: "Back", key: "wake:abc" });
      yield* threads.send({ threadId, text: "Back", key: "wake:abc" });
      yield* threads.send({ threadId, text: "Unkeyed" });
      yield* threads.send({ threadId, text: "Unkeyed" });
      yield* threads.send({ threadId, text: "Pause this card", mode: "steer", coalesce: "step:A" });
      expect(sent[0]?.commandId).toBe("kanban:send:wake:abc");
      expect(sent[0]?.messageId).toBe("kanban:wake:abc");
      expect(sent[1]?.commandId).toBe(sent[0]?.commandId);
      expect(sent[1]?.messageId).toBe(sent[0]?.messageId);
      expect(sent[2]?.commandId).not.toBe(sent[3]?.commandId);
      expect(sent.slice(0, 4).every((input) => input.mode === "auto")).toBe(true);
      expect(sent[4]?.mode).toBe("steer");
      expect(sent[4]?.activeTurnOnly).toBe(true);
      expect(sent[4]?.messageId.startsWith("kanban:wake:step:A:")).toBe(false);
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

it.effect.each([
  "prune read",
  "prune cancel",
  "nudge check",
  "edit check",
  "steer validation",
] as const)("post-enqueue %s failure retains the accepted message and run", (failure) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("post-enqueue");
    let accepted = false;
    let messageId = "kanban:accepted";
    const projectionError = new Orchestrator.OrchestratorProjectionError({
      threadId,
      cause: "Post-enqueue projection unavailable",
    });
    const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({ projectId: ProjectId.make("project-1"), deletedAt: null } as never),
      getThreadRecords: () =>
        accepted && failure !== "prune cancel"
          ? Effect.fail(projectionError)
          : Effect.succeed({
              runs: [
                ...(failure === "edit check"
                  ? [
                      {
                        id: RunId.make("accepted-run"),
                        status: "queued",
                        ordinal: 2,
                        userMessageId: "kanban:wake:nudge:prior",
                      },
                    ]
                  : []),
                ...(accepted
                  ? [
                      {
                        id: RunId.make("accepted-run"),
                        status: "queued",
                        ordinal: 3,
                        userMessageId: messageId,
                      },
                      {
                        id: RunId.make("old-wake"),
                        status: "queued",
                        ordinal: 1,
                        userMessageId: "kanban:wake:nudge:old",
                      },
                    ]
                  : []),
              ],
              messages: [],
            } as never),
      sendToThread: (input) =>
        Effect.sync(() => {
          accepted = true;
          messageId = input.messageId;
          return { delivery: "queued", run: { id: RunId.make("accepted-run") } } as never;
        }),
      dispatch: (input) =>
        input.type === "queued-run.edit"
          ? Effect.sync(() => {
              accepted = true;
              messageId = "kanban:wake:nudge:prior";
              return { storedEvents: [] } as never;
            })
          : Effect.fail(projectionError),
    });
    yield* Effect.gen(function* () {
      const threads = yield* KanbanThreads;
      const error = yield* threads
        .send({
          threadId,
          text: "Accepted message",
          key: "accepted",
          ...(["nudge check", "edit check"].includes(failure) ? { coalesce: "nudge" } : {}),
          ...(failure === "steer validation" ? { mode: "steer" as const } : {}),
        })
        .pipe(Effect.flip);
      expect(error.wakeMessageId).toBe(messageId);
      expect(error.sentRunId).toBe("accepted-run");
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

it.effect.each([0, 1, 2])(
  "a revoked send with a lost response retains its identity after %s read failures",
  (readFailures) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("late-send");
      let revoked = false;
      let remainingFailures = readFailures;
      const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({ projectId: ProjectId.make("project-1"), deletedAt: null } as never),
        getThreadRecords: () =>
          Effect.suspend(() =>
            remainingFailures-- > 0
              ? Effect.fail(
                  new Orchestrator.OrchestratorProjectionError({ threadId, cause: "Read failed" }),
                )
              : Effect.succeed({
                  runs: [
                    {
                      id: RunId.make("old-send"),
                      userMessageId: MessageId.make("kanban:owned-send"),
                      status: "running",
                    },
                    {
                      id: RunId.make("restored-run"),
                      userMessageId: MessageId.make("other"),
                      status: "running",
                    },
                  ],
                } as never),
          ),
        sendToThread: () =>
          Effect.sync(() => {
            revoked = true;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new Orchestrator.OrchestratorProjectionError({ threadId, cause: "Response lost" }),
              ),
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const threads = yield* KanbanThreads;
        const error = yield* threads
          .send({ threadId, text: "Old board message", key: "owned-send", isStale: () => revoked })
          .pipe(Effect.flip);
        expect(error.sentRunId).toBe(readFailures < 2 ? "old-send" : undefined);
        expect(error.wakeMessageId).toBe("kanban:owned-send");
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

it.effect.each([false, true])(
  "interrupt distinguishes a real already-terminal result and reads target settlement (cancelQueued=%s)",
  (cancelQueued) => {
    const db = Sqlite.layerMemory;
    const instanceId = ProviderInstanceId.make("codex");
    const threadId = ThreadId.make("thread:interrupt-noop");
    const projectId = ProjectId.make("project:interrupt-noop");
    const adapter = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("Provider execution is disabled in this test"),
    } as ProviderAdapter.ProviderAdapterV2["Service"];
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "kanban-interrupt-noop" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: db, runEffectWorker: false },
    );
    const receipts = CommandReceiptStore.layer.pipe(Layer.provide(db));
    const management = ThreadManagementService.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(runtime, receipts, ServerSettings.layerTest(), db)),
    );
    let staleShell = false;
    const observedManagement = Layer.effect(
      ThreadManagementService.ThreadManagementService,
      Effect.map(ThreadManagementService.ThreadManagementService, (real) =>
        ThreadManagementService.ThreadManagementService.of({
          ...real,
          getThreadShell: (id) =>
            real
              .getThreadShell(id)
              .pipe(
                Effect.map((shell) =>
                  staleShell && shell !== null
                    ? { ...shell, activeRunId: RunId.make("stale-read") }
                    : shell,
                ),
              ),
        }),
      ),
    ).pipe(Layer.provideMerge(management));
    const dependencies = Layer.mergeAll(
      observedManagement,
      receipts,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("interrupt-noop:create"),
        threadId,
        projectId,
        title: "Interrupt outcome",
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
        yield* threads.send({ threadId, text: "Start", key: "interrupt-noop:start" });
        const run = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]!;
        if (cancelQueued) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("interrupt-noop:queued"),
            threadId,
            messageId: MessageId.make("interrupt-noop:queued"),
            text: "Queued wake",
            attachments: [],
            modelSelection: { instanceId, model: "gpt-5.1-codex" },
            dispatchMode: { type: "queue_after_active" },
            createdBy: "system",
            creationSource: "server",
          });
        }
        expect(yield* threads.runSettled(threadId, run.id)).toBe(false);
        staleShell = true;
        expect(yield* threads.interrupt(threadId, "Stop", cancelQueued, run.id)).toEqual({
          outcome: "requested",
          runId: run.id,
        });
        expect(yield* threads.runSettled(threadId, run.id)).toBe(true);
        expect(
          yield* threads.interrupt(threadId, "Pruned target", false, "missing-old-run"),
        ).toEqual({ outcome: "noop" });
        expect(yield* threads.runSettled(threadId, "missing-old-run")).toBe(true);
        if (cancelQueued) {
          expect(
            (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.at(-1)?.status,
          ).toBe("cancelled");
        }
        expect(yield* threads.interrupt(threadId, "Already ended", false, run.id)).toEqual({
          outcome: "noop",
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(dependencies));
  },
);

describe("coalesceTarget", () => {
  const run = (ordinal: number, scope: string, status = "queued") => ({
    ordinal,
    status: status as "queued" | "running" | "completed" | "cancelled",
    userMessageId: MessageId.make(`kanban:wake:${scope}:wake-${ordinal}`),
  });

  it("picks the oldest queued run without relying on projection order", () => {
    const oldest = run(2, "step:A");
    expect(coalesceTarget([run(4, "step:A"), oldest, run(3, "step:A")], "step:A")).toBe(oldest);
  });

  it.each([
    run(1, "step:A", "running"),
    run(1, "step:A", "completed"),
    run(1, "step:A", "cancelled"),
    run(1, "step:B"),
    run(1, "step:AB"),
    run(1, "plan:A"),
    { ...run(1, "step:A"), userMessageId: MessageId.make("kanban:step:A:wake-1") },
    { ...run(1, "step:A"), userMessageId: MessageId.make("owner:step:A:wake-1") },
    { ...run(1, "step:A"), userMessageId: MessageId.make("pr-watch:step:A:wake-1") },
    { ...run(1, "step:A"), userMessageId: MessageId.make("delivery:step:A:wake-1") },
  ])("ignores other messages and nonqueued runs: $userMessageId $status", (candidate) => {
    expect(coalesceTarget([candidate], "step:A")).toBeUndefined();
  });

  it("has no target in an empty queue", () => {
    expect(coalesceTarget([], "step:A")).toBeUndefined();
  });
});

it.effect.each([
  "queued",
  "started",
  "race-keyed",
  "race-unkeyed",
  "race-after-rejection",
] as const)("board wake coalescing preserves queue order ($mode)", (mode) => {
  const db = Sqlite.layerMemory;
  const instanceId = ProviderInstanceId.make("codex");
  const projectId = ProjectId.make("project:coalesce");
  const threadId = ThreadId.make("thread:coalesce");
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
  const runtime = ProviderReplayHarness.layerWithRegistry({ name: "kanban-coalesce" }, registry, {
    databaseLayer: db,
    runEffectWorker: false,
  });
  const management = ThreadManagementService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(runtime, receipts, ServerSettings.layerTest(), db)),
  );
  let race = false;
  const edits: CommandId[] = [];
  const observed = Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.gen(function* () {
      const real = yield* ThreadManagementService.ThreadManagementService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      return ThreadManagementService.ThreadManagementService.of({
        ...real,
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type === "queued-run.edit") {
              edits.push(command.commandId);
              if (race) {
                race = false;
                const target = (yield* real.getThreadRecords(threadId, ["runs"])).runs.find(
                  (run) => run.id === command.runId,
                )!;
                yield* projections
                  .apply({
                    id: EventId.make("coalesce:started-during-edit"),
                    type: "run.updated",
                    threadId,
                    runId: target.id,
                    occurredAt: yield* DateTime.now,
                    payload: { ...target, status: "starting" },
                  })
                  .pipe(Effect.orDie);
              }
            }
            return yield* real.dispatch(command);
          }),
      });
    }),
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(management, ProjectionStore.layer.pipe(Layer.provide(db)))),
  );
  const dependencies = Layer.mergeAll(
    observed,
    receipts,
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const receiptStore = yield* CommandReceiptStore.CommandReceiptStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("coalesce:create"),
      threadId,
      projectId,
      title: "Board wakes",
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
      yield* threads.send({ threadId, text: "Unstarted active run" });
      const wake = {
        threadId,
        coalesce: "step:A",
        text: "First snapshot",
        key: "coalesce:first",
      };
      yield* threads.send({ threadId, text: "Owner message", key: "owner" });
      const first = yield* threads.send(wake);
      yield* threads.send({ threadId, text: "Other card", coalesce: "step:B", key: "other" });
      yield* threads.send({ threadId, text: "Plan", coalesce: "plan:A", key: "plan" });
      let records = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
      const target = records.runs.find((run) => run.id === first)!;
      expect(target.status).toBe("queued");
      const positions = records.runs.map((run) => [run.id, run.queuePosition]);
      const keyed = mode !== "race-unkeyed";
      if (mode === "started") {
        yield* projections
          .apply({
            id: EventId.make("coalesce:started-before-send"),
            type: "run.updated",
            threadId,
            runId: target.id,
            occurredAt: yield* DateTime.now,
            payload: { ...target, status: "starting" },
          })
          .pipe(Effect.orDie);
      }
      const same = { ...wake, key: "same-text" };
      if (mode === "queued") expect(yield* threads.send(same)).toBe(first);
      if (mode === "race-after-rejection") {
        yield* receiptStore.insertIfAbsent({
          commandId: CommandId.make("kanban:send:coalesce:latest"),
          threadId,
          commandType: "message.dispatch",
          acceptedAt: yield* DateTime.now,
          resultSequence: 0,
          status: "rejected",
          error: "Provider unavailable",
        });
      }
      race = mode.startsWith("race-");
      const latest = {
        threadId,
        coalesce: wake.coalesce,
        text: "Newest snapshot",
        ...(keyed ? { key: "coalesce:latest" } : {}),
      };
      const updated = yield* threads.send(latest);
      records = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
      const texts = records.runs
        .toSorted((a, b) => a.ordinal - b.ordinal)
        .map((run) => records.messages.find((message) => message.id === run.userMessageId)!.text);
      if (mode === "queued") {
        expect(updated).toBe(first);
        expect(texts).toEqual([
          "Unstarted active run",
          "Owner message",
          "Newest snapshot",
          "Other card",
          "Plan",
        ]);
        expect(records.runs.map((run) => [run.id, run.queuePosition])).toEqual(positions);
        expect(edits).toEqual([
          CommandId.make("kanban:send:same-text"),
          CommandId.make("kanban:send:coalesce:latest"),
        ]);
        // Retries of older accepted sends must not overwrite a newer snapshot.
        yield* threads.send(wake);
        yield* threads.send(latest);
        yield* threads.send(same);
        expect(yield* threads.send({ threadId, coalesce: wake.coalesce, text: latest.text })).toBe(
          first,
        );
        expect(edits).toHaveLength(2);
        expect(
          (yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages.find(
            (message) => message.id === target.userMessageId,
          )?.text,
        ).toBe(latest.text);
        // A rejection other than the start race must never become a new send.
        const empty = yield* Effect.result(threads.send({ ...latest, text: "", key: "empty" }));
        expect(Result.isFailure(empty)).toBe(true);
        if (Result.isFailure(empty)) expect(empty.failure.wakeMessageId).toBe(target.userMessageId);
        expect((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(5);
        yield* threads.send({
          ...latest,
          key: "new-model",
          model: { instanceId, model: "gpt-5.1-codex" },
        });
        const modelRun = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
        expect(modelRun.userMessageId).toBe("kanban:new-model");
        yield* projections
          .apply({
            id: EventId.make("coalesce:same-started"),
            type: "run.updated",
            threadId,
            runId: target.id,
            occurredAt: yield* DateTime.now,
            payload: { ...target, status: "starting" },
          })
          .pipe(Effect.orDie);
        yield* threads.send(same);
        expect((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(6);
      } else {
        expect(updated).not.toBe(first);
        expect(texts).toEqual([
          "Unstarted active run",
          "Owner message",
          "First snapshot",
          "Other card",
          "Plan",
          "Newest snapshot",
        ]);
        expect(
          records.runs.slice(0, positions.length).map((run) => [run.id, run.queuePosition]),
        ).toEqual(positions);
        if (mode.startsWith("race-")) {
          expect(edits).toHaveLength(1);
          expect(records.runs.at(-1)!.userMessageId).toBe(
            mode === "race-after-rejection"
              ? "kanban:wake:step:A:coalesce:latest:retry:2"
              : `kanban:wake:step:A:${edits[0]!.slice("kanban:send:".length)}:retry:1`,
          );
          const rejected = yield* receiptStore.getByCommandId(edits[0]!);
          expect(Option.isSome(rejected) && rejected.value.status).toBe("rejected");
          if (keyed) {
            const fallback = records.runs.at(-1)!;
            yield* projections
              .apply({
                id: EventId.make("coalesce:fallback-started"),
                type: "run.updated",
                threadId,
                runId: fallback.id,
                occurredAt: yield* DateTime.now,
                payload: { ...fallback, status: "starting" },
              })
              .pipe(Effect.orDie);
            yield* threads.send(latest);
            expect((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(
              records.runs.length,
            );
          }
        } else expect(edits).toHaveLength(0);
      }
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(dependencies));
});

it.effect.each([
  { error: "Run X is not queued.", retry: true },
  { error: "Queued run X has no user message.", retry: false },
  { error: "Queued run X cannot be edited to an empty message.", retry: false },
  { error: "Automatic completion deliveries cannot be edited.", retry: false },
  { error: "Storage failed", retry: false },
  { error: null, retry: false },
])("a rejected edit retries only a queue-start race: $error", ({ error, retry }) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-edit-rejection");
    const sent: string[] = [];
    const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({ projectId: ProjectId.make("project-1"), deletedAt: null } as never),
      getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
      sendToThread: (input) =>
        Effect.sync(() => {
          sent.push(input.commandId);
          return { run: { id: "fallback" } } as never;
        }),
    });
    yield* Effect.gen(function* () {
      const receipts = yield* CommandReceipts.OrchestrationCommandReceiptRepository;
      yield* receipts.insertIfAbsent({
        commandId: CommandId.make("kanban:send:rejected-edit"),
        aggregateKind: "thread",
        aggregateId: threadId,
        commandType: "queued-run.edit",
        acceptedAt: QUESTION_AT,
        resultSequence: 1,
        status: "rejected",
        error,
      });
      const threads = yield* KanbanThreads;
      const result = yield* Effect.result(
        threads.send({
          threadId,
          text: "Current snapshot",
          key: "rejected-edit",
          coalesce: "step:A",
        }),
      );
      expect(Result.isSuccess(result)).toBe(retry);
      expect(sent).toEqual(retry ? ["kanban:send:rejected-edit:retry:1"] : []);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(management),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
          Layer.provideMerge(CommandReceipts.layer),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    );
  }),
);

describe("queuedWakes", () => {
  const run = (
    ordinal: number,
    userMessageId: string,
    status: "queued" | "running" | "completed" | "cancelled" = "queued",
  ) => ({ ordinal, userMessageId: MessageId.make(userMessageId), status });
  it("selects only queued snapshots older than the new message, in order", () => {
    const first = run(2, "kanban:wake:nudge:old");
    const second = run(4, "kanban:wake:owner:A:old");
    expect(
      queuedWakes(
        [
          second,
          run(1, "kanban:steer"),
          run(3, "owner:relay"),
          first,
          run(5, "kanban:wake:nudge:same"),
          run(6, "kanban:wake:nudge:new"),
          ...(["running", "completed", "cancelled"] as const).map((status) =>
            run(1, "kanban:wake:nudge:active", status),
          ),
        ],
        5,
      ),
    ).toEqual([first, second]);
  });
  it.each(["step:A", "plan:A", "owner:A", "owner:discussion-A", "nudge"])(
    "matches exact scope %s",
    (scope) => {
      const target = run(1, `kanban:wake:${scope}:id`);
      expect(
        queuedWakes([target, run(2, `kanban:wake:${scope}B:id`), run(3, "kanban:real")], Infinity, [
          scope,
        ]),
      ).toEqual([target]);
    },
  );
});

it.effect("claimContext loads only caller identity, without thread shell or run history", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("claim-caller");
    const row = liveThreadShell(threadId);
    const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getCallerRow: () => Effect.succeed(row),
      getThreadShell: () => Effect.die("thread shell read"),
      getThreadRecords: () => Effect.die("run history read"),
    });
    yield* Effect.gen(function* () {
      const threads = yield* KanbanThreads;
      expect(yield* threads.claimContext(threadId)).toEqual({
        projectId: row.projectId,
        model: row.modelSelection,
      });
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

it.effect.each([false, true])(
  "successor reads queued and live statuses from one run snapshot: includeActive=%s",
  (includeActive) => {
    const statuses = [
      "queued",
      "preparing",
      "starting",
      "running",
      "waiting",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ] as const;
    const runs = statuses.map((status) => ({
      id: RunId.make(`run:${status}`),
      status,
    })) as OrchestrationV2Run[];
    let reads = 0;
    const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.sync(() => {
          reads++;
          return { runs } as never;
        }),
    });
    return Effect.gen(function* () {
      const threads = yield* KanbanThreads;
      const found = yield* threads.queuedRuns(ThreadId.make("thread:successor"), includeActive);
      expect(found.map((run) => run.status)).toEqual(
        includeActive ? statuses.slice(0, 5) : ["queued"],
      );
      expect(reads).toBe(1);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(management),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    );
  },
);

it.effect.each([
  { name: "completed later turn", ordinal: 3, start: 20, end: 30, expected: true },
  { name: "older queued input starts later", ordinal: 1, start: 20, end: 30, expected: true },
  { name: "old turn finishes later", ordinal: 1, start: 5, end: 40, expected: false },
  { name: "higher ordinal never starts", ordinal: 3, start: null, end: 30, expected: false },
  { name: "same timestamp later ordinal", ordinal: 3, start: 10, end: 30, expected: true },
  { name: "same timestamp older ordinal", ordinal: 1, start: 10, end: 30, expected: false },
  { name: "failed run missing", ordinal: 3, start: 20, end: 30, expected: false, missing: true },
  {
    name: "before the failed run's actual start",
    ordinal: 3,
    start: 15,
    end: 40,
    expected: false,
    failedStart: 20,
  },
  {
    name: "after the failed run's actual start",
    ordinal: 1,
    start: 30,
    end: 40,
    expected: true,
    failedStart: 20,
  },
])("persisted recovery history distinguishes $name", (row) => {
  const failedId = RunId.make("run:expired");
  const recoveryId = RunId.make("run:recovery");
  const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  const failed = {
    id: failedId,
    ordinal: 2,
    requestedAt: DateTime.makeUnsafe(10),
    startedAt: row.failedStart === undefined ? null : DateTime.makeUnsafe(row.failedStart),
    completedAt: DateTime.makeUnsafe(15),
    status: "failed",
  };
  const recovery = {
    id: recoveryId,
    ordinal: row.ordinal,
    requestedAt: DateTime.makeUnsafe(0),
    startedAt: row.start === null ? null : DateTime.makeUnsafe(row.start),
    completedAt: DateTime.makeUnsafe(row.end),
    status: "completed",
    modelSelection: model,
    userMessageId: MessageId.make("message:recovery"),
  };
  const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: (_, sections) =>
      Effect.succeed(
        (sections.some((section) => section === "runs")
          ? { runs: row.missing ? [recovery] : [failed, recovery] }
          : { messages: [] }) as never,
      ),
  });
  return Effect.gen(function* () {
    const threads = yield* KanbanThreads;
    const found = yield* threads.latestRun(ThreadId.make("thread:recovery"), failedId);
    expect(found?.runId ?? null).toBe(row.expected ? recoveryId : null);
    if (row.expected) expect(found?.model).toEqual(model);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(management),
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Sqlite.layerMemory),
      ),
    ),
  );
});

it.effect("recovery history chooses the most recent start instead of the latest completion", () => {
  const failedId = RunId.make("run:expired");
  const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: (_, sections) =>
      Effect.succeed(
        (sections.some((section) => section === "runs")
          ? {
              runs: [
                { id: failedId, ordinal: 2, startedAt: null, requestedAt: DateTime.makeUnsafe(10) },
                {
                  id: RunId.make("run:first"),
                  ordinal: 3,
                  startedAt: DateTime.makeUnsafe(20),
                  completedAt: DateTime.makeUnsafe(50),
                  modelSelection: model,
                },
                {
                  id: RunId.make("run:last"),
                  ordinal: 1,
                  startedAt: DateTime.makeUnsafe(30),
                  completedAt: DateTime.makeUnsafe(40),
                  modelSelection: model,
                },
              ],
            }
          : { messages: [] }) as never,
      ),
  });
  return Effect.gen(function* () {
    const threads = yield* KanbanThreads;
    expect((yield* threads.latestRun(ThreadId.make("thread:recovery"), failedId))?.runId).toBe(
      "run:last",
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
});
