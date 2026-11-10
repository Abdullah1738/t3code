import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  ContextHandoffId,
  CheckpointScopeId,
  EnvironmentId,
  ContextTransferId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@t3tools/contracts";
import {
  expandAssistantCitationsForProvider,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import { CodexHistoryNotSentError } from "../ardud/harness-migrate/CodexHistoryDeliveryError.ts";
import {
  ContextHandoffBudgetError,
  makeProviderFailure,
} from "@t3tools/provider-core/server/failure";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

const managedWorktreesDir = "/tmp/provider-turn-start-worktrees";
// fs.realpath applies `..` and `.` before following symlinks.
const normalize = (target: string) => {
  const parts: Array<string> = [];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
};
const layerWorktreeLocation = (worktreesDir = managedWorktreesDir) =>
  Layer.mergeAll(
    Path.layer,
    Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as ServerConfig.ServerConfig["Service"]),
    ServerSettings.layerTest(),
  );

/** Starts a run on a thread whose worktree folder is missing, with routing reads failing after. */
function startWithMissingWorktree(
  worktreePath: string,
  realPaths: Record<string, string> = {
    [managedWorktreesDir]: managedWorktreesDir,
    [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
  },
) {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath,
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, {
          exists: () => Effect.succeed(false),
          // Paths that exist on the fake disk, mapped to where their symlinks lead.
          realPath: (target: string) =>
            normalize(target) in realPaths
              ? Effect.succeed(realPaths[normalize(target)])
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "realPath",
                    pathOrDescriptor: target,
                  }),
                ),
        } as never),
        layerWorktreeLocation(),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees, createWorktree }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => {
            projectionReadCount += 1;
            return Effect.succeed(projection);
          },
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  const start = Effect.gen(function* () {
    return yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);
  }).pipe(Effect.provide(layer), Effect.runPromise);
  return {
    start,
    pruneWorktrees,
    createWorktree,
    writeIfRunCurrent,
    startRootRun,
    projectionReads: () => projectionReadCount,
  };
}

it("does not commit running state when inherited background routing cannot be read", async () => {
  const worktreePath = `${managedWorktreesDir}/project/feature-restore`;
  const harness = startWithMissingWorktree(worktreePath);
  const error = await harness.start;

  expect(error._tag).toBe("ProviderTurnStartError");
  expect(harness.projectionReads()).toBe(3);
  expect(harness.pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-turn-start-project" });
  expect(harness.createWorktree).toHaveBeenCalledWith({
    cwd: "/tmp/provider-turn-start-project",
    refName: "feature/restore",
    path: worktreePath,
  });
  expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
  expect(harness.startRootRun).not.toHaveBeenCalled();
});

it.each([
  {
    label: "<managed>/<repo>/<branch>",
    worktreePath: `${managedWorktreesDir}/project/feature-restore`,
    recreated: true,
  },
  {
    label: "the real path of a symlinked managed folder",
    worktreePath: "/real-worktrees/project/feature-restore",
    realPaths: { [managedWorktreesDir]: "/real-worktrees", "/real-worktrees": "/real-worktrees" },
    recreated: true,
  },
  {
    label: "a path outside the managed folder",
    worktreePath: "/tmp/provider-turn-start-project/.git/hooks",
    recreated: false,
  },
  {
    label: "a symlink inside the managed folder that leads out",
    worktreePath: `${managedWorktreesDir}/project/hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: "/tmp/provider-turn-start-project/.git",
    },
    recreated: false,
  },
  {
    label: "a folder nested below a worktree",
    worktreePath: `${managedWorktreesDir}/project/feature-restore/link/hooks`,
    recreated: false,
  },
  {
    label: "'..' out of the managed folder",
    worktreePath: `${managedWorktreesDir}/project/../../outside`,
    recreated: false,
  },
  {
    // Left raw on purpose: git follows `link` before applying `..`.
    label: "'..' after a symlink inside the managed folder",
    worktreePath: `${managedWorktreesDir}/project/x/link/../../hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
      [`${managedWorktreesDir}/project/x`]: `${managedWorktreesDir}/project/x`,
      [`${managedWorktreesDir}/project/x/link`]: "/tmp/provider-turn-start-project/.git/refs/heads",
    },
    recreated: false,
  },
  { label: "a relative path", worktreePath: "project/feature-restore", recreated: false },
])("recreates a missing worktree only at the managed location: $label", async (input) => {
  const harness = startWithMissingWorktree(input.worktreePath, input.realPaths);
  await harness.start;
  expect(harness.createWorktree).toHaveBeenCalledTimes(input.recreated ? 1 : 0);
});

function makeLocalCommandHarness(input: {
  readonly text: string;
  readonly worktreePath?: string;
  readonly worktreesDir?: string;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  readonly ensureThreadFailure?: unknown;
  readonly ensureThreadResult?: OrchestrationV2ThreadProjection["providerThreads"][number];
  readonly ensureThreadFailOnce?: boolean;
  readonly loseRunningWrite?: boolean;
  readonly historyReadFailureAfterFallback?: unknown;
  readonly resumeSuccess?: boolean;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  readonly failReadsAfterRunning?: boolean;
  readonly nativeDelivery?: boolean;
}) {
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-native-account-command");
  const runId = RunId.make("run-native-account-command");
  const rootNodeId = NodeId.make("root-native-account-command");
  const attemptId = RunAttemptId.make("attempt-native-account-command");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const oldProviderThreadId = ProviderThreadId.make("existing-native-provider-thread");
  const oldInstanceId = ProviderInstanceId.make("antigravity-personal");
  const newInstanceId = ProviderInstanceId.make("codex-personal");
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make("message-native-account-command");
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: { instanceId: newInstanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: newInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      projectId: ProjectId.make("project-native-account-command"),
      branch: input.worktreePath === undefined ? null : "feature/restore",
      worktreePath: input.worktreePath ?? null,
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [
      ...(input.previousNativeSession
        ? [
            {
              ...run,
              id: RunId.make("previous-native-run"),
              ordinal: 1,
              status: "completed" as const,
              providerInstanceId: oldInstanceId,
              providerThreadId: oldProviderThreadId,
            },
          ]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      ...(input.previousNativeSession
        ? [
            {
              ...providerThread,
              id: oldProviderThreadId,
              providerInstanceId: oldInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              lastRunOrdinal: 1,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("antigravity"),
                nativeId: "existing-session",
                strength: "strong" as const,
              },
            },
          ]
        : []),
      providerThread,
    ],
    messages: [
      ...(input.previousMessages ?? []).map((text, index) => ({
        ...message,
        id: MessageId.make(`previous-message-${index}`),
        text,
      })),
      message,
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-account-command",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  if ("historyReadFailureAfterFallback" in input) {
    const nativeThreadRef = {
      driver: providerThread.driver,
      nativeId: "native-resume-thread",
      strength: "strong" as const,
    };
    projection = {
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThreadId ? { ...candidate, nativeThreadRef } : candidate,
      ),
    };
  }
  const events: Array<OrchestrationV2DomainEvent> = [];
  const interruptRun = () => {
    projection = {
      ...projection,
      runs: projection.runs.map((candidate) =>
        candidate.id === runId
          ? { ...candidate, status: "interrupted", completedAt: now }
          : candidate,
      ),
    };
  };
  const ensureThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.interruptRunBeforeOpenFailure === true) interruptRun();
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: input.ensureThreadFailure,
          }),
        ),
      ),
    ),
  );
  const resumeFallbackEnsure = vi.fn(() => Effect.succeed(providerThread));
  const resumeThread = vi.fn(
    ({ providerThread: existing }: { providerThread: typeof providerThread }) =>
      input.resumeSuccess === true
        ? Effect.succeed(existing)
        : Effect.fail(
            new ProviderAdapter.ProviderAdapterEventStreamError({
              driver: providerThread.driver,
              providerSessionId,
              cause: "native thread is gone",
            }),
          ),
  );
  const resumeFallbackSession = {
    driver: providerThread.driver,
    providerSession: {
      id: providerSessionId,
      driver: providerThread.driver,
      providerInstanceId: newInstanceId,
      status: "ready" as const,
      cwd: "/tmp/native-account-command",
      model: null,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
    resumeThread,
    ensureThread: resumeFallbackEnsure,
  };
  let failOnce = input.ensureThreadFailOnce === true;
  const retryableEnsureThread = vi.fn<
    ProviderAdapter.ProviderAdapterV2SessionRuntime["ensureThread"]
  >(() => {
    if (failOnce) {
      failOnce = false;
      return Effect.fail(
        new ProviderAdapter.ProviderAdapterEnsureThreadError({
          driver: providerThread.driver,
          threadId,
          cause: new CodexHistoryNotSentError({ cause: "missing staged file" }),
        }),
      );
    }
    return Effect.succeed(
      input.ensureThreadResult ??
        (input.nativeDelivery === true
          ? {
              ...providerThread,
              nativeThreadRef: {
                driver: providerThread.driver,
                nativeId: "native-fresh-cutover",
                strength: "strong" as const,
              },
            }
          : providerThread),
    );
  });
  const nativeStartTurn = vi.fn<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>(
    () => Effect.void,
  );
  const injectHistory = vi.fn<
    NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["injectHistory"]>
  >(() => Effect.succeed(true));
  const open = vi.fn<ProviderSessionManager.ProviderSessionManagerV2["Service"]["open"]>(() =>
    input.interruptOpen === true
      ? Effect.interrupt
      : "historyReadFailureAfterFallback" in input
        ? Effect.succeed(resumeFallbackSession as never)
        : "ensureThreadFailure" in input
          ? Effect.succeed({ driver: providerThread.driver, ensureThread } as never)
          : "openFailure" in input
            ? Effect.sync(() => {
                if (input.interruptRunBeforeOpenFailure === true) interruptRun();
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProviderSessionManager.ProviderSessionOpenError({
                      instanceId: newInstanceId,
                      providerSessionId,
                      cause: input.openFailure,
                    }),
                  ),
                ),
              )
            : input.failReadsAfterRunning === true || input.nativeDelivery === true
              ? Effect.succeed({
                  driver: providerThread.driver,
                  providerSession: {
                    id: providerSessionId,
                    driver: providerThread.driver,
                    providerInstanceId: newInstanceId,
                    status: "ready",
                    cwd: "/tmp/native-account-command",
                    model: null,
                    capabilities: CodexProviderCapabilitiesV2,
                    createdAt: now,
                    updatedAt: now,
                    lastError: null,
                  },
                  ensureThread: retryableEnsureThread,
                  resumeThread,
                  startTurn: nativeStartTurn,
                  compactThread: nativeStartTurn,
                  injectHistory,
                } as never)
              : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn<
    (input: RunExecutionService.RunExecutionServiceV2StartRootRunInput) => Effect.Effect<void>
  >(() =>
    input.failReadsAfterRunning === true ||
    input.resumeSuccess === true ||
    input.nativeDelivery === true
      ? Effect.void
      : Effect.die("A local command must not start a native turn."),
  );
  const failReadIfRunning = Effect.suspend(() =>
    input.failReadsAfterRunning === true &&
    projection.runs.find((candidate) => candidate.id === runId)?.status === "running"
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "database unavailable" }),
        )
      : Effect.void,
  );
  const tryHandlePromptCommand = vi.fn(() =>
    input.logoutFailure === undefined
      ? Effect.succeed(true)
      : Effect.fail(
          new ProviderSetupError({
            instanceId: oldInstanceId,
            operation: "logout",
            detail: input.logoutFailure,
          }),
        ),
  );
  const writeIfProviderThreadUnchanged = vi.fn(({ expected, events: incoming }) =>
    Effect.sync(() => {
      const committed = projection.providerThreads.some((thread) => thread === expected);
      if (committed) {
        for (const event of incoming) {
          expect(isDomainEvent(event)).toBe(true);
          events.push(event);
          projection = ProjectionStore.applyToProjection(projection, event);
        }
      }
      return { committed, storedEvents: [] };
    }),
  );
  const writeIfRunCurrent = vi.fn(
    ({ events: incoming, activeAttemptId, expectedStatus, runId: requestedRunId }) =>
      "writeFailure" in input
        ? Effect.fail(
            new EventSink.EventSinkWriteError({
              eventCount: incoming.length,
              cause: input.writeFailure,
            }),
          )
        : Effect.sync(() => {
            const current = projection.runs.find((candidate) => candidate.id === requestedRunId);
            const committed =
              current !== undefined &&
              current.activeAttemptId === activeAttemptId &&
              current.status === expectedStatus &&
              !(
                input.loseRunningWrite === true &&
                incoming.some(
                  (event: OrchestrationV2DomainEvent) =>
                    event.type === "run.updated" && event.payload.status === "running",
                )
              );
            if (committed) {
              for (const event of incoming) {
                expect(isDomainEvent(event)).toBe(true);
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
            }
            return { committed, storedEvents: [] };
          }),
  );
  const resolveRuntimePolicy = vi.fn(
    ({ thread }: Parameters<RuntimePolicy.RuntimePolicyV2Shape["resolve"]>[0]) =>
      Effect.succeed({ cwd: thread.worktreePath ?? "/tmp/native-account-command" } as never),
  );
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const getThreadRecords = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"]>(() =>
    Effect.succeed(projection),
  );
  const getTurnStartContext = vi.fn(() =>
    Effect.succeed({
      ...projection,
      hasConversation: projection.messages.some(
        (m) =>
          m.role === "user" &&
          (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
      ),
    }),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: () => Effect.die("history read must fail first"),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent,
          writeIfProviderThreadUnchanged,
          write: ({ events: incoming }) =>
            Effect.sync(() => {
              for (const event of incoming) {
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
            }) as never,
        }),
        IdAllocator.layer,
        layerWorktreeLocation(input.worktreesDir),
        input.fileSystem === undefined
          ? FileSystem.layerNoop({ exists: () => Effect.succeed(true) })
          : Layer.succeed(FileSystem.FileSystem, input.fileSystem),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees: () => Effect.void,
          createWorktree,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ workspaceRoot: "/tmp/native-account-project" } as never)),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords,
          getTurnStartContext,
          getRuntimeRecoveryProjection: () =>
            Effect.as(failReadIfRunning, {
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getTurnStartHistory: () =>
            input.nativeDelivery === true
              ? Effect.succeed(projection.turnItems)
              : Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: input.historyReadFailureAfterFallback,
                  }),
                ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({ tryHandlePromptCommand }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: resolveRuntimePolicy,
        }),
      ),
    ),
  );
  return {
    getThreadRecords,
    getTurnStartContext,
    setProjection: (next: OrchestrationV2ThreadProjection) => {
      projection = next;
    },
    resolveRuntimePolicy,
    createWorktree,
    open,
    resumeThread,
    resumeFallbackEnsure,
    writeIfRunCurrent,
    writeIfProviderThreadUnchanged,
    retryableEnsureThread,
    nativeStartTurn,
    injectHistory,
    startRootRun,
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    attemptId,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
    startForRun: (nextRunId: RunId) =>
      Effect.gen(function* () {
        yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
          threadId,
          runId: nextRunId,
        });
      }).pipe(Effect.provide(layer)),
  };
}

const startPreparedTurn = (controls: RunExecutionService.RunExecutionServiceV2StartRootRunInput) =>
  controls.session.startTurn({
    appThread: controls.appThread,
    threadId: controls.run.threadId,
    runId: controls.run.id,
    runOrdinal: controls.run.ordinal,
    providerTurnOrdinal: controls.providerTurnOrdinal,
    attemptId: controls.attemptId,
    rootNodeId: controls.rootNode.id,
    providerThread: controls.providerThread,
    message: controls.message,
    modelSelection: controls.modelSelection,
    runtimePolicy: controls.runtimePolicy,
  });

effectIt.effect(
  "delivers the normal native switch history once and resumes it on the second turn",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue interrupted work.",
        nativeDelivery: true,
        resumeSuccess: true,
      });
      harness.injectHistory.mockImplementation(() => Effect.succeed(false));
      const projection = harness.projection();
      const run = projection.runs.at(-1)!;
      const providerThread = projection.providerThreads.at(-1)!;
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareProviderHandoff({
        threadId: run.threadId,
        targetRunId: run.id,
        transferId: null,
        fromProviderThreadIds: [ProviderThreadId.make("provider-thread:old-opencode")],
        toProviderThreadId: providerThread.id,
        fromProviderInstanceId: ProviderInstanceId.make("opencode"),
        toProviderInstanceId: run.providerInstanceId,
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "full_thread_summary",
        createdAt: run.requestedAt,
        items: [
          {
            id: TurnItemId.make("item:old-command"),
            threadId: run.threadId,
            runId: null,
            nodeId: null,
            providerThreadId: ProviderThreadId.make("provider-thread:old-opencode"),
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: run.requestedAt,
            completedAt: run.requestedAt,
            updatedAt: run.requestedAt,
            type: "command_execution",
            input: "vp test parser",
            output: "Finished parser regression",
            exitCode: 0,
          },
        ],
      });
      harness.setProjection({ ...projection, contextHandoffs: [handoff] });
      yield* harness.start;
      yield* startPreparedTurn(harness.startRootRun.mock.calls[0]![0]);
      const first = harness.nativeStartTurn.mock.calls[0]![0].message.text;
      expect(first).toContain("Finished parser regression");
      expect(first).toContain(`t3_thread_read({threadId:"${run.threadId}",view:"activity"`);
      expect(first).toContain("afterPosition=nextPosition");
      expect(harness.projection().contextHandoffs[0]?.delivery?.status).toBe("inline");
      const after = harness.projection();
      const secondRunId = RunId.make("run:second-native");
      harness.setProjection({
        ...after,
        runs: [
          { ...after.runs.at(-1)!, status: "completed" },
          { ...run, id: secondRunId, ordinal: run.ordinal + 1, status: "starting" },
        ],
        nodes: after.nodes.map((node) => ({ ...node, runId: secondRunId })),
        attempts: after.attempts.map((attempt) => ({ ...attempt, runId: secondRunId })),
        messages: after.messages.map((message) => ({ ...message, runId: secondRunId })),
      });
      yield* harness.startForRun(secondRunId);
      yield* startPreparedTurn(harness.startRootRun.mock.calls[1]![0]);
      expect(harness.retryableEnsureThread).toHaveBeenCalledOnce();
      expect(harness.resumeThread).toHaveBeenCalledOnce();
      expect(harness.nativeStartTurn.mock.calls[1]![0].message.text).toBe(
        "Continue interrupted work.",
      );
    }).pipe(Effect.provide(ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)))),
);

effectIt.effect("retains a ready handoff whose target was cancelled by recovery before retry", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Retry the interrupted task",
      nativeDelivery: true,
      resumeSuccess: true,
    });
    harness.injectHistory.mockImplementation(() => Effect.succeed(false));
    const projection = harness.projection();
    const run = projection.runs.at(-1)!;
    const target = projection.providerThreads.at(-1)!;
    const cancelledId = RunId.make("run:cancelled-handoff-target");
    harness.setProjection({
      ...projection,
      runs: [
        { ...run, id: cancelledId, ordinal: run.ordinal, status: "cancelled", startedAt: null },
        { ...run, ordinal: run.ordinal + 1 },
      ],
      contextHandoffs: [
        {
          id: ContextHandoffId.make("handoff:cancelled-retry"),
          threadId: run.threadId,
          targetRunId: cancelledId,
          fromProviderThreadIds: [],
          toProviderThreadId: target.id,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "full_thread_summary",
          status: "ready",
          summaryMessageId: null,
          summaryText: "RETAIN_CANCELLED_HANDOFF original parser task and completed command",
          createdByProviderInstanceId: null,
          createdAt: run.requestedAt,
          updatedAt: run.requestedAt,
        },
      ],
    });
    yield* harness.start;
    yield* startPreparedTurn(harness.startRootRun.mock.calls[0]![0]);
    expect(harness.nativeStartTurn.mock.calls[0]![0].message.text).toContain(
      "RETAIN_CANCELLED_HANDOFF",
    );
    expect(harness.projection().contextHandoffs[0]?.delivery?.status).toBe("inline");
  }),
);

effectIt.effect.each(["budget-before-send", "ambiguous-send"] as const)(
  "records proven unsent only for pre-prompt delivery failure after running state (%s)",
  (stage) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Carry on with the original task",
        nativeDelivery: true,
        resumeSuccess: true,
      });
      const initial = harness.projection();
      const run = initial.runs.at(-1)!;
      const providerThread = initial.providerThreads.at(-1)!;
      harness.setProjection({
        ...initial,
        contextHandoffs: [
          {
            id: ContextHandoffId.make("handoff:before-send-budget"),
            threadId: run.threadId,
            targetRunId: run.id,
            fromProviderThreadIds: [],
            toProviderThreadId: providerThread.id,
            coveredRunOrdinals: { from: 1, to: 1 },
            strategy: "full_thread_summary",
            status: "ready",
            summaryMessageId: null,
            summaryText: "Original task history",
            createdByProviderInstanceId: null,
            createdAt: run.requestedAt,
            updatedAt: run.requestedAt,
          },
        ],
      });
      if (stage === "budget-before-send")
        harness.injectHistory.mockImplementation(() =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: providerThread.driver,
              threadId: run.threadId,
              providerThreadId: providerThread.id,
              runId: run.id,
              cause: new ContextHandoffBudgetError(),
            }),
          ),
        );
      else {
        harness.injectHistory.mockImplementation(() => Effect.succeed(false));
        harness.nativeStartTurn.mockImplementation(() =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: providerThread.driver,
              threadId: run.threadId,
              providerThreadId: providerThread.id,
              runId: run.id,
              cause: "Connection dropped after native send; outcome unknown",
            }),
          ),
        );
      }
      yield* harness.start;
      expect(harness.projection().runs.at(-1)?.status).toBe("running");
      expect(harness.projection().runs.at(-1)?.startedAt).not.toBeNull();
      expect(harness.projection().attempts.at(-1)?.startedAt).not.toBeNull();
      const result = yield* startPreparedTurn(harness.startRootRun.mock.calls[0]![0]).pipe(
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const failure = makeProviderFailure({ cause: result.failure });
        expect(failure.code).toBe(
          stage === "budget-before-send" ? "provider_prompt_not_sent" : null,
        );
      }
      expect(harness.nativeStartTurn).toHaveBeenCalledTimes(stage === "budget-before-send" ? 0 : 1);

      // Use the actual execution/finalization path too: cutover reads the
      // persisted error item, not the startup exception inspected above.
      const controls = harness.startRootRun.mock.calls[0]![0];
      // The delivery wrapper is single-use. Capture a fresh one by restoring
      // the starting projection rather than calling the already-used session.
      const { delivery: _delivery, ...handoff } = harness.projection().contextHandoffs[0]!;
      harness.setProjection({ ...initial, contextHandoffs: [handoff] });
      yield* harness.start;
      const nextControls = harness.startRootRun.mock.calls.at(-1)![0];
      yield* Effect.gen(function* () {
        const execution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* execution.startRootRun({
          ...nextControls,
          session: { ...nextControls.session, events: Stream.never },
        });
      }).pipe(
        Effect.provide(
          RunExecutionService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                McpAppModelContext.layerEmpty,
                PreviewAgentActivity.layer,
                IdAllocator.layer,
                ServerSettings.layerTest(),
                Layer.mock(CheckpointService.CheckpointServiceV2)({
                  captureBaseline: () => Effect.void,
                }),
                Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
                  allocate: () => Effect.succeed(1),
                }),
                Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
                  ingestNormalized: () => Effect.succeed([]),
                }),
                Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent: harness.writeIfRunCurrent }),
              ),
            ),
          ),
        ),
      );
      const persisted = harness.projection();
      expect(persisted.runs.find((row) => row.id === controls.run.id)?.status).toBe("failed");
      expect(
        persisted.attempts.find((row) => row.id === controls.attemptId)?.startedAt,
      ).not.toBeNull();
      expect(
        persisted.turnItems.some(
          (item) =>
            item.runId === controls.run.id &&
            item.type === "error" &&
            item.failure.code === "provider_prompt_not_sent",
        ),
      ).toBe(stage === "budget-before-send");
      expect(harness.nativeStartTurn).toHaveBeenCalledTimes(stage === "budget-before-send" ? 0 : 2);
    }),
);

effectIt.effect.each(["cleanup-first", "startup-first"])(
  "coordinates provider startup with %s",
  (order) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-start-" });
      const worktreePath = path.join(workspaceRoot, "project", "worktree");
      yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
      const release = yield* Deferred.make<void>();
      const openEntered = yield* Deferred.make<void>();
      const harness = makeLocalCommandHarness({
        text: "Continue",
        worktreePath,
        worktreesDir: workspaceRoot,
        fileSystem,
        failReadsAfterRunning: true,
      });
      harness.createWorktree.mockImplementation(() =>
        fileSystem.makeDirectory(worktreePath).pipe(Effect.as({} as never), Effect.orDie),
      );
      const open = harness.open.getMockImplementation()!;
      harness.open.mockImplementation((input) =>
        Effect.gen(function* () {
          expect(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie)).toBe(true);
          yield* Deferred.succeed(openEntered, undefined);
          if (order === "startup-first") yield* Deferred.await(release);
          return yield* open(input);
        }),
      );
      let cleanupEntered = false;
      const cleanupEffect = withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "cleanup-first") yield* Deferred.await(release);
          else {
            expect(harness.projection().providerSessions).toHaveLength(1);
            expect(harness.projection().runs.at(-1)?.status).toBe("running");
          }
          yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
        }),
      );
      const cleanup =
        order === "cleanup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
      if (order === "cleanup-first") expect(harness.open).not.toHaveBeenCalled();
      if (order === "startup-first") yield* Deferred.await(openEntered);
      const laterCleanup =
        order === "startup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (order === "startup-first") expect(cleanupEntered).toBe(false);
      yield* Deferred.succeed(release, undefined);
      if (cleanup !== undefined) yield* Fiber.join(cleanup);
      yield* Fiber.join(startup);
      if (laterCleanup !== undefined) yield* Fiber.join(laterCleanup);
      if (order === "cleanup-first") {
        expect(harness.createWorktree).toHaveBeenCalledWith({
          cwd: "/tmp/native-account-project",
          refName: "feature/restore",
          path: worktreePath,
        });
      }
      expect(harness.resolveRuntimePolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: expect.objectContaining({ worktreePath }),
        }),
      );
      expect(harness.open).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
        }),
      );
      expect(harness.startRootRun).toHaveBeenCalledWith(
        expect.objectContaining({
          appThread: expect.objectContaining({ worktreePath }),
          runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

effectIt.effect("reads only thread state before taking the startup lease", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });
    yield* harness.start;
    expect(harness.getThreadRecords).toHaveBeenCalledExactlyOnceWith(
      harness.projection().thread.id,
      [],
    );
    expect(harness.getTurnStartContext).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("completed");
  }),
);

effectIt.effect("reads current startup state after waiting for the workspace lease", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-fresh-state";
    const release = yield* Deferred.make<void>();
    const readEntered = yield* Deferred.make<void>();
    const harness = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    harness.getThreadRecords.mockImplementationOnce(() =>
      Deferred.succeed(readEntered, undefined).pipe(Effect.as(harness.projection())),
    );
    const holder = yield* withWorkspaceLease(worktreePath, Deferred.await(release)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(readEntered);
    expect(harness.getTurnStartContext).not.toHaveBeenCalled();
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status: "running" })),
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(startup);
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }),
);

effectIt.effect.each([
  { boundary: "policy resolution", nativeMode: "ensure", loss: "replaced" },
  { boundary: "policy resolution", nativeMode: "ensure", loss: "interrupted" },
  { boundary: "session opening", nativeMode: "ensure", loss: "replaced" },
  { boundary: "session opening", nativeMode: "ensure", loss: "interrupted" },
  { boundary: "session opening", nativeMode: "resume", loss: "replaced" },
  { boundary: "session opening", nativeMode: "fork", loss: "replaced" },
])(
  "does not continue $nativeMode startup when $loss during $boundary",
  ({ boundary, nativeMode, loss }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const harness = makeLocalCommandHarness({ text: "Continue" });
      const projection = harness.projection();
      const run = projection.runs[0]!;
      const providerThread = projection.providerThreads[0]!;
      if (nativeMode === "resume") {
        harness.setProjection({
          ...projection,
          providerThreads: [
            {
              ...providerThread,
              nativeThreadRef: {
                driver: providerThread.driver,
                nativeId: "existing",
                strength: "strong",
              },
            },
          ],
        });
      } else if (nativeMode === "fork") {
        const sourceThreadId = ThreadId.make("fork-source");
        harness.getThreadRecords.mockReturnValue(
          Effect.succeed({
            ...projection,
            thread: { ...projection.thread, id: sourceThreadId },
          }),
        );
        harness.setProjection({
          ...projection,
          contextTransfers: [
            {
              id: ContextTransferId.make("pending-fork"),
              type: "fork",
              sourceThreadId,
              targetThreadId: projection.thread.id,
              sourcePoint: { threadId: sourceThreadId, runId: run.id },
              basePoint: null,
              sourceProviderInstanceId: run.providerInstanceId,
              targetProviderInstanceId: run.providerInstanceId,
              targetRunId: run.id,
              status: "pending",
              resolution: null,
              createdBy: "user",
              error: null,
              createdAt: projection.updatedAt,
              updatedAt: projection.updatedAt,
              consumedAt: null,
            },
          ],
        });
      }
      const ensureThread = vi.fn(() => Effect.succeed(providerThread));
      const resumeThread = vi.fn(() => Effect.succeed(providerThread));
      const forkThread = vi.fn(() => Effect.succeed(providerThread));
      harness.open.mockReturnValue(
        (boundary === "session opening" ? gate : Effect.void).pipe(
          Effect.as({
            driver: providerThread.driver,
            ensureThread,
            resumeThread,
            forkThread,
          } as never),
        ),
      );
      if (boundary === "policy resolution") {
        harness.resolveRuntimePolicy.mockReturnValue(
          gate.pipe(Effect.as({ cwd: "/tmp/native-account-command" } as never)),
        );
      }

      const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const current = harness.projection();
      const replacementId = RunAttemptId.make("replacement-attempt");
      const updated = {
        ...current,
        runs: current.runs.map((candidate) =>
          loss === "replaced"
            ? { ...candidate, activeAttemptId: replacementId }
            : { ...candidate, status: "interrupted" as const, completedAt: current.updatedAt },
        ),
        attempts:
          loss === "replaced"
            ? [
                ...current.attempts,
                { ...current.attempts[0]!, id: replacementId, attemptOrdinal: 2 },
              ]
            : current.attempts,
      };
      harness.setProjection(updated);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(startup);

      expect(harness.open).toHaveBeenCalledTimes(boundary === "session opening" ? 1 : 0);
      expect(ensureThread).not.toHaveBeenCalled();
      expect(resumeThread).not.toHaveBeenCalled();
      expect(forkThread).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
      expect(harness.events).toEqual([]);
      expect(harness.projection()).toEqual(updated);
    }),
);

effectIt.effect("starts another provider in the same checkout while a turn is pending", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-shared-checkout";
    const turnEntered = yield* Deferred.make<void>();
    const releaseTurn = yield* Deferred.make<void>();
    const first = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    const second = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    first.startRootRun.mockImplementation(() =>
      Deferred.succeed(turnEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseTurn))),
    );
    const pending = yield* first.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(turnEntered);
    yield* second.start;
    expect(second.startRootRun).toHaveBeenCalledOnce();
    expect(second.projection().runs.at(-1)?.status).toBe("running");
    yield* Deferred.succeed(releaseTurn, undefined);
    yield* Fiber.join(pending);
  }),
);

effectIt.effect("terminalizes a starting run when its provider session cannot open", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("DESCRIPTION is not valid ACP JSON"),
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "starting",
      }),
    );
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "DESCRIPTION is not valid ACP JSON",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a session-open failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a session-open failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not terminalize a provider-session open interruption", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", interruptOpen: true });

    const exit = yield* Effect.exit(harness.start);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not overwrite a run interrupted while its provider session opens", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("interrupted");
    expect(projection.attempts[0]?.status).toBe("pending");
    expect(projection.nodes[0]?.status).toBe("pending");
    expect(projection.turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("fails a starting run when its last start attempt cannot load the thread", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("Pi RPC read failed: pi process exited with code 1."),
    });

    yield* harness.start;

    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider turn failed to start",
        failure: {
          class: "provider_error",
          message: "Pi RPC read failed: pi process exited with code 1.",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a thread-load failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a thread-load failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "keeps a store failure after the provider loaded the thread typed and retryable",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        historyReadFailureAfterFallback: new Error("database unavailable"),
      });

      const error = yield* harness.start.pipe(Effect.flip);

      expect(error._tag).toBe("ProviderTurnStartError");
      expect((error.cause as { _tag?: string } | undefined)?._tag).toBe("ProjectionStoreReadError");
      expect(harness.resumeFallbackEnsure).toHaveBeenCalledOnce();
      expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("starting");
      expect(harness.events).toEqual([]);
    }),
);

effectIt.effect.each([
  "resume failed",
  "uncertain delivery",
  "missing native ref",
  "missing native id",
  "injected Codex missing native id",
  "Codex local goal completed before resume failure",
] as const)("fails a seeded turn without opening a fresh session on %s", (scenario) =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      historyReadFailureAfterFallback: new Error("unexpected fallback"),
    });
    const projection = harness.projection();
    const providerThread = projection.providerThreads.at(-1)!;
    harness.setProjection({
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id !== providerThread.id
          ? candidate
          : {
              ...candidate,
              ...(scenario === "missing native ref" ||
              scenario === "injected Codex missing native id"
                ? { nativeThreadRef: null }
                : scenario === "missing native id"
                  ? { nativeThreadRef: { ...candidate.nativeThreadRef!, nativeId: null } }
                  : {}),
              nativeMetadata: {
                seededHistory: {
                  source: "opencode",
                  sourceSessionId: "ses_source",
                  digest: "sha256:seed",
                  ...(scenario === "injected Codex missing native id" ||
                  scenario === "Codex local goal completed before resume failure"
                    ? { mode: "codex-inject" as const, injectedNativeId: "native-injected" }
                    : { mode: "claude-transcript" as const }),
                },
              },
            },
      ),
      providerTurns:
        scenario === "Codex local goal completed before resume failure"
          ? [
              {
                id: ProviderTurnId.make("completed-goal-command"),
                providerThreadId: providerThread.id,
                nodeId: projection.nodes[0]!.id,
                runAttemptId: null,
                nativeTurnRef: null,
                ordinal: 1,
                status: "completed",
                startedAt: projection.updatedAt,
                completedAt: projection.updatedAt,
              },
            ]
          : [],
      contextHandoffs:
        scenario === "uncertain delivery"
          ? [
              {
                id: ContextHandoffId.make("handoff:uncertain-seed"),
                threadId: projection.thread.id,
                targetRunId: projection.runs.at(-1)!.id,
                fromProviderThreadIds: [],
                toProviderThreadId: providerThread.id,
                coveredRunOrdinals: { from: 1, to: 1 },
                strategy: "manual_context",
                status: "ready",
                summaryMessageId: null,
                summaryText: "Pending handoff",
                createdByProviderInstanceId: null,
                createdAt: projection.updatedAt,
                updatedAt: projection.updatedAt,
                delivery: {
                  nativeThreadId: providerThread.nativeThreadRef!.nativeId!,
                  status: "pending",
                  itemIds: [],
                },
              },
            ]
          : [],
    });

    yield* harness.start;

    expect(harness.resumeThread).toHaveBeenCalledTimes(
      scenario === "resume failed" ||
        scenario === "Codex local goal completed before resume failure"
        ? 1
        : 0,
    );
    expect(harness.resumeFallbackEnsure).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        failure: {
          message:
            "This thread's moved history could not be resumed, so the turn stopped instead of starting without it. Roll the move back with t3ctl harness-migrate rollback <thread>, or retry.",
        },
      },
    ]);
  }),
);

effectIt.effect("fails an unconfirmed seeded turn when resumed handoffs do not fit", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      historyReadFailureAfterFallback: new Error("unexpected fallback"),
      resumeSuccess: true,
    });
    const projection = harness.projection();
    const providerThread = projection.providerThreads.at(-1)!;
    const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
    harness.setProjection({
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) => ({
        ...candidate,
        contextUsage: { usedTokens: 99_000, maxTokens: 100_000 },
        nativeMetadata: {
          seededHistory: {
            source: "opencode",
            sourceSessionId: "ses_source",
            digest: "sha256:seed",
            mode: "claude-transcript",
          },
        },
      })),
      contextHandoffs: [
        {
          id: ContextHandoffId.make("handoff:seeded-budget"),
          threadId: projection.thread.id,
          targetRunId: projection.runs.at(-1)!.id,
          fromProviderThreadIds: [],
          toProviderThreadId: providerThread.id,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: "Pending handoff",
          createdByProviderInstanceId: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    yield* harness.start;

    expect(harness.resumeThread).toHaveBeenCalledOnce();
    expect(harness.resumeFallbackEnsure).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      { type: "error", failure: { message: expect.stringContaining("moved history") } },
    ]);
  }),
);

effectIt.effect("passes native history for a seeded Claude first turn with no handoffs", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      historyReadFailureAfterFallback: new Error("unexpected history read"),
      resumeSuccess: true,
    });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) => ({
        ...candidate,
        nativeMetadata: {
          seededHistory: {
            source: "opencode",
            sourceSessionId: "ses_source",
            digest: "sha256:seed",
            mode: "claude-transcript",
          },
        },
      })),
    });

    yield* harness.start;

    expect(harness.resumeThread).toHaveBeenCalledOnce();
    expect(harness.resumeFallbackEnsure).not.toHaveBeenCalled();
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    const turn = harness.startRootRun.mock.calls[0]?.[0];
    expect(turn?.nativeThreadHasTurns).toBe(true);
    expect(turn?.providerTurnOrdinal).toBe(1);
    expect(turn?.providerThread.nativeMetadata?.seededHistory?.mode).toBe("claude-transcript");
  }),
);

effectIt.effect("allows a first Codex staged injection to create its native thread", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      historyReadFailureAfterFallback: new Error("unexpected history read"),
      resumeSuccess: true,
    });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) => ({
        ...candidate,
        nativeThreadRef: null,
        nativeMetadata: {
          seededHistory: {
            source: "opencode",
            sourceSessionId: "ses_source",
            digest: "sha256:seed",
            mode: "codex-inject",
            stagedPath: "/staged/input",
          },
        },
      })),
    });

    yield* harness.start;

    expect(harness.resumeThread).not.toHaveBeenCalled();
    expect(harness.resumeFallbackEnsure).toHaveBeenCalledOnce();
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    expect(
      harness.startRootRun.mock.calls[0]?.[0].providerThread.nativeMetadata?.seededHistory,
    ).toMatchObject({ mode: "codex-inject", stagedPath: "/staged/input" });
  }),
);

effectIt.effect("allows the normal fresh-session recovery after a seeded turn completed", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      historyReadFailureAfterFallback: new Error("expected history read"),
    });
    const projection = harness.projection();
    const providerThread = projection.providerThreads.at(-1)!;
    const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
    harness.setProjection({
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) => ({
        ...candidate,
        nativeMetadata: {
          seededHistory: {
            source: "opencode",
            sourceSessionId: "ses_source",
            digest: "sha256:seed",
            mode: "claude-transcript",
          },
        },
      })),
      providerTurns: [
        {
          id: ProviderTurnId.make("completed-seeded-turn"),
          providerThreadId: providerThread.id,
          nodeId: projection.nodes[0]!.id,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      ],
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.resumeThread).toHaveBeenCalledOnce();
    expect(harness.resumeFallbackEnsure).toHaveBeenCalledOnce();
  }),
);

effectIt.effect("does not mistake a failed state read for a superseded run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) return;
    const startCheck = yield* Effect.flip(controls.shouldStartProviderTurn!());
    const finalizeCheck = yield* Effect.flip(controls.shouldFinalizeRun!());
    expect(startCheck._tag).toBe("ProjectionStoreReadError");
    expect(finalizeCheck._tag).toBe("ProjectionStoreReadError");
  }),
);

effectIt.effect("keeps seeded history when a new Codex native thread is loaded", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });
    const history = {
      source: "opencode" as const,
      sourceSessionId: "ses_x",
      digest: "sha256:seed",
      mode: "codex-inject" as const,
      stagedPath: "/staged/input",
    };
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      providerThreads: projection.providerThreads.map((thread) => ({
        ...thread,
        nativeMetadata: { seededHistory: history },
      })),
    });

    yield* harness.start;

    const updated = harness.events.findLast((event) => event.type === "provider-thread.updated");
    expect(updated?.type).toBe("provider-thread.updated");
    if (updated?.type === "provider-thread.updated") {
      expect(updated.payload.nativeMetadata?.seededHistory).toEqual(history);
    }
  }),
);

effectIt.effect("persists the injected native id returned by the adapter", () =>
  Effect.gen(function* () {
    const history = {
      source: "opencode" as const,
      sourceSessionId: "ses_x",
      digest: "sha256:seed",
      mode: "codex-inject" as const,
      stagedPath: "/staged/input",
    };
    const baseline = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });
    const row = baseline.projection().providerThreads[0]!;
    const harness = makeLocalCommandHarness({
      text: "Continue",
      failReadsAfterRunning: true,
      ensureThreadResult: {
        ...row,
        nativeThreadRef: { driver: row.driver, nativeId: "native-injected", strength: "strong" },
        nativeMetadata: {
          title: "adapter title",
          seededHistory: { ...history, injectedNativeId: "native-injected" },
        },
      },
    });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      providerThreads: projection.providerThreads.map((thread) => ({
        ...thread,
        nativeMetadata: { title: "original title", seededHistory: history },
      })),
    });
    yield* harness.start;
    const updated = harness.events.findLast((event) => event.type === "provider-thread.updated");
    expect(updated?.type).toBe("provider-thread.updated");
    if (updated?.type === "provider-thread.updated") {
      expect(updated.payload.id).toBe(row.id);
      expect(updated.payload.nativeThreadRef?.nativeId).toBe("native-injected");
      expect(updated.payload.nativeMetadata).toEqual({
        title: "adapter title",
        seededHistory: { ...history, injectedNativeId: "native-injected" },
      });
    }
  }),
);

effectIt.effect("fences ambiguous staged-history delivery before starting a native thread", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      providerThreads: projection.providerThreads.map((thread) => ({
        ...thread,
        nativeMetadata: {
          seededHistory: {
            source: "opencode",
            sourceSessionId: "ses_x",
            digest: "digest",
            mode: "codex-inject",
            stagedPath: "/staged/input",
            injectionPending: true,
          },
        },
      })),
    });
    yield* harness.start;
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfProviderThreadUnchanged).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(
      harness.projection().providerThreads[0]?.nativeMetadata?.seededHistory?.injectionPending,
    ).toBe(true);
  }),
);

effectIt.effect("clears a proven unsent claim and retries delivery", () =>
  Effect.gen(function* () {
    const baseline = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });
    const row = baseline.projection().providerThreads[0]!;
    const history = {
      source: "opencode" as const,
      sourceSessionId: "ses_x",
      digest: "digest",
      mode: "codex-inject" as const,
      stagedPath: "/staged/input",
    };
    const harness = makeLocalCommandHarness({
      text: "Continue",
      failReadsAfterRunning: true,
      ensureThreadFailOnce: true,
      ensureThreadResult: {
        ...row,
        nativeThreadRef: { driver: row.driver, nativeId: "native-injected", strength: "strong" },
        nativeMetadata: { seededHistory: { ...history, injectedNativeId: "native-injected" } },
      },
    });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      providerThreads: projection.providerThreads.map((thread) => ({
        ...thread,
        nativeMetadata: { seededHistory: history },
      })),
    });
    const failure = yield* harness.startWithRetry.pipe(Effect.flip);
    expect(failure._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().providerThreads[0]?.nativeMetadata?.seededHistory).toEqual(history);
    expect(harness.startRootRun).not.toHaveBeenCalled();
    yield* harness.start;
    expect(harness.retryableEnsureThread).toHaveBeenCalledTimes(2);
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    expect(
      harness.projection().providerThreads[0]?.nativeMetadata?.seededHistory?.injectedNativeId,
    ).toBe("native-injected");
  }),
);

effectIt.effect("keeps the claim after an ambiguous injection failure", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("lost injection acknowledgement"),
    });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      providerThreads: projection.providerThreads.map((thread) => ({
        ...thread,
        nativeMetadata: {
          seededHistory: {
            source: "opencode",
            sourceSessionId: "ses_x",
            digest: "digest",
            mode: "codex-inject",
            stagedPath: "/staged/input",
          },
        },
      })),
    });
    yield* harness.startWithRetry.pipe(Effect.flip);
    expect(
      harness.projection().providerThreads[0]?.nativeMetadata?.seededHistory?.injectionPending,
    ).toBe(true);
    expect(harness.writeIfProviderThreadUnchanged).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }),
);

effectIt.effect("does not inject again if the row update is lost after native delivery", () =>
  Effect.gen(function* () {
    const baseline = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });
    const row = baseline.projection().providerThreads[0]!;
    const history = {
      source: "opencode" as const,
      sourceSessionId: "ses_x",
      digest: "digest",
      mode: "codex-inject" as const,
      stagedPath: "/staged/input",
    };
    const harness = makeLocalCommandHarness({
      text: "Continue",
      failReadsAfterRunning: true,
      loseRunningWrite: true,
      ensureThreadResult: {
        ...row,
        nativeThreadRef: { driver: row.driver, nativeId: "native-injected", strength: "strong" },
        nativeMetadata: { seededHistory: { ...history, injectedNativeId: "native-injected" } },
      },
    });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      providerThreads: projection.providerThreads.map((thread) => ({
        ...thread,
        nativeMetadata: { seededHistory: history },
      })),
    });
    yield* harness.start;
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(
      harness.projection().providerThreads[0]?.nativeMetadata?.seededHistory?.injectionPending,
    ).toBe(true);
    expect(harness.startRootRun).not.toHaveBeenCalled();
    yield* harness.start;
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.writeIfProviderThreadUnchanged).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }),
);

effectIt.effect("does not overwrite a run interrupted while its thread loads", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.projection().turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

effectIt.effect("persists a failed sign-out without starting a provider turn", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "/logout",
      logoutFailure: "Could not stop all sessions for this provider. Try again.",
    });

    yield* harness.start;

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider sign-out failed",
        failure: {
          class: "permission_error",
          message: "Could not stop all sessions for this provider. Try again.",
        },
      },
    ]);
  }),
);

for (const previousMessages of [[], ["/compact", " /COMPACT "]]) {
  effectIt.effect(
    `rejects compaction without conversation context after ${previousMessages.length} prior compactions`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({ text: "/compact", previousMessages });

        yield* harness.start;

        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
        expect(harness.startRootRun).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          {
            type: "error",
            failure: {
              class: "validation_error",
              message: "Start a conversation before compacting this thread.",
            },
          },
        ]);
      }),
  );
}

effectIt.effect("fails a run whose expanded assistant quotes exceed the provider input limit", () =>
  Effect.gen(function* () {
    const citation = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("environment-citation"),
      threadId: ThreadId.make("thread-citation-source"),
      messageId: MessageId.make("message-citation-source"),
      text: "Quoted claim",
      start: 0,
      end: 12,
      prefix: "",
      suffix: "",
    });
    // Fits as a link, which the composer allows, but not once the quote expands.
    const text = `${"x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - citation.length - 1)} ${citation}`;
    expect(text.length).toBe(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(expandAssistantCitationsForProvider(text).length).toBeGreaterThan(
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    );
    const harness = makeLocalCommandHarness({ text });

    yield* harness.start;

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("failed");
    expect(projection.messages.at(-1)?.text).toBe(text);
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Message is too long",
        failure: { class: "validation_error" },
      },
    ]);
  }),
);

effectIt.effect("fails an automatic recovery instead of replacing its native session", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      historyReadFailureAfterFallback: new Error("must not replace"),
    });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      runs: projection.runs.map((run) => ({
        ...run,
        transientRecovery: {
          firstError: {
            class: "provider_error",
            category: "transient",
            code: "api_error_529",
            retryable: true,
            message: "529 overloaded",
          },
          since: "2026-11-08T10:00:00.000Z",
        },
      })),
    });
    yield* harness.start;
    expect(harness.resumeThread).toHaveBeenCalledOnce();
    expect(harness.resumeFallbackEnsure).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const failed = harness.projection().turnItems.findLast((item) => item.type === "error");
    expect(failed?.type === "error" ? failed.failure.message : "").toContain("529 overloaded");
    expect(failed?.type === "error" ? failed.failure.message : "").toContain("Resume error:");
    expect(failed?.type === "error" ? failed.failure.message : "").toContain(
      "native thread is gone",
    );
  }),
);
