import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  backgroundWorkOf,
  KanbanThreadError,
  KanbanThreads,
  layer,
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
          return { run: { id: `run-${sent.length}` } } as never;
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
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  );
  const instrumentedManagement = Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.gen(function* () {
      const real = yield* ThreadManagementService.ThreadManagementService;
      return ThreadManagementService.ThreadManagementService.of({
        ...real,
        sendToThread: (input) =>
          Effect.gen(function* () {
            recorded.push(input);
            if (failBeforeDispatch) {
              failBeforeDispatch = false;
              return yield* new ThreadManagementService.ThreadManagementProjectionLoadError({
                projectId: input.projectId,
                threadId: input.threadId,
                cause: "injected before dispatch",
              });
            }
            const result = yield* real.sendToThread(input);
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
