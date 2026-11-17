import * as SqlClient from "effect/sql/SqlClient";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as NetAddress from "effect/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AgentScope } from "@t3tools/shared/AgentScope";
import {
  CommandId,
  NodeId,
  RunId,
  type OrchestrationV2ThreadProjection,
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2StoredEvent,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as ContextResetService from "../ardud/context-reset/ContextResetService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/http";

import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as CredentialStore from "../ardud/mcp/CredentialStore.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CodexAdapterV2 from "./Adapters/CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./Adapters/CodexAdapterV2.testkit.ts";
import packageJson from "../../package.json" with { type: "json" };
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const decodeResumeMcpConfig = Schema.decodeUnknownSync(
  Schema.Struct({
    config: Schema.Struct({
      "mcp_servers.t3-code": Schema.optional(
        Schema.Struct({
          http_headers: Schema.Struct({ Authorization: Schema.String }),
        }),
      ),
    }),
  }),
);

const decodeMcpResumeRefusal = Schema.decodeUnknownSync(
  Schema.Struct({ cause: ProviderAdapter.ProviderAdapterProtocolError }),
);

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
const layerFailingReleaseEventSink = Layer.effect(
  EventSink.EventSinkV2,
  Effect.gen(function* () {
    const delegate = yield* EventSink.EventSinkV2;
    return EventSink.EventSinkV2.of({
      ...delegate,
      write: (input) =>
        input.events.some(
          (event) =>
            event.type === "provider-session.updated" &&
            (event.payload.status === "stopped" || event.payload.status === "error"),
        )
          ? Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length }))
          : delegate.write(input),
    });
  }),
).pipe(Layer.provide(layerTestEventSink));

interface FlakyReleaseWrites {
  readonly failing: Ref.Ref<"none" | "session" | "session-and-requests">;
  readonly failures: Queue.Queue<void>;
  readonly pauseRequestWrites?: {
    readonly paused: Deferred.Deferred<void>;
    readonly resume: Deferred.Deferred<void>;
  };
}

const layerFlakyReleaseEventSink = (flaky: FlakyReleaseWrites) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const failing = yield* Ref.get(flaky.failing);
            const fails = input.events.some(
              (event) =>
                (failing !== "none" &&
                  event.type === "provider-session.updated" &&
                  (event.payload.status === "stopped" || event.payload.status === "error")) ||
                (failing === "session-and-requests" && event.type === "runtime-request.updated"),
            );
            const pause = flaky.pauseRequestWrites;
            if (
              pause !== undefined &&
              input.events.some((event) => event.type === "runtime-request.updated")
            ) {
              yield* Deferred.succeed(pause.paused, undefined);
              yield* Deferred.await(pause.resume);
            }
            if (!fails) return yield* delegate.write(input);
            yield* Queue.offer(flaky.failures, undefined);
            return yield* Effect.die(new Error("simulated commit failure"));
          }),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const layerPausingAttachEventSink = (pause: {
  readonly armed: Ref.Ref<boolean>;
  readonly paused: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const attach = input.events.some((event) => event.type === "provider-session.attached");
            if (attach && (yield* Ref.getAndSet(pause.armed, false))) {
              yield* Deferred.succeed(pause.paused, undefined);
              return yield* Effect.never;
            }
            return yield* delegate.write(input);
          }),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const layerBeforeUnchangedWriteEventSink = (before: Ref.Ref<Effect.Effect<void>>) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        writeIfProviderThreadUnchanged: (input) =>
          Ref.getAndSet(before, Effect.void).pipe(
            Effect.flatten,
            Effect.andThen(delegate.writeIfProviderThreadUnchanged(input)),
          ),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

type SessionWriteHook = (
  input: Parameters<EventSink.EventSinkV2Shape["write"]>[0],
) => Effect.Effect<void, EventSink.EventSinkV2Error>;

const layerInterceptedSessionEventSink = (hook: Ref.Ref<SessionWriteHook>) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Ref.get(hook).pipe(
            Effect.flatMap((before) => before(input)),
            Effect.andThen(delegate.write(input)),
          ),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const CodexCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
const ExclusiveCapabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexCapabilities,
  sessions: {
    ...CodexCapabilities.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

interface TestProviderRuntimeState {
  readonly openCount: number;
  readonly closeCount: number;
  readonly interruptCount: number;
  readonly resumeCount: number;
  readonly unloadedNativeThreadIds: ReadonlyArray<string>;
  readonly eventQueues: ReadonlyMap<
    string,
    Queue.Queue<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>
  >;
}

const emptyState: TestProviderRuntimeState = {
  openCount: 0,
  closeCount: 0,
  interruptCount: 0,
  resumeCount: 0,
  unloadedNativeThreadIds: [],
  eventQueues: new Map(),
};

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;

function makeProviderSession(input: {
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly driver?: ProviderDriverKind;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: input.driver ?? CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    status: "ready",
    cwd: process.cwd(),
    model: "gpt-5.4",
    capabilities: input.capabilities ?? CodexCapabilities,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function makeThreadCreatedEvent(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly projectId?: ProjectId;
}) {
  return Effect.gen(function* () {
    const projectId =
      input.projectId ??
      (yield* input.idAllocator.allocate.project({
        fixtureName: "provider-session-manager",
      }));
    const providerThreadId = input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId,
      title: "Provider session manager",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      id: yield* input.idAllocator.allocate.event({ threadId: input.threadId }),
      type: "thread.created" as const,
      threadId: input.threadId,
      occurredAt: input.now,
      payload: thread,
    };
  });
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly nativeThreadId?: string;
  readonly driver?: ProviderDriverKind;
}): OrchestrationV2ProviderThread {
  const nativeThreadId = input.nativeThreadId ?? "native-thread";
  const driver = input.driver ?? CODEX_DRIVER;
  return {
    id: input.idAllocator.derive.providerThread({
      driver,
      nativeThreadId,
    }),
    driver,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver,
      nativeId: nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function unimplemented(detail: string) {
  return Effect.fail(
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CODEX_DRIVER,
      detail,
    }),
  );
}

const makeProviderAdapter = Effect.fnUntraced(function* (
  state: Ref.Ref<TestProviderRuntimeState>,
  options: {
    readonly failEventStream?: boolean;
    readonly capabilities?: OrchestrationV2ProviderCapabilities;
    readonly mcpConfigs?: Ref.Ref<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >;
    readonly beforeOpen?: (input: {
      readonly providerSessionId: ProviderSessionId;
      readonly initialProviderItemIdentityVersion?: 2;
    }) => Effect.Effect<void>;
    readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
    readonly hasPendingBackgroundWorkForThread?: Effect.Effect<boolean>;
    readonly backgroundTasksEndWithProcess?: boolean;
    readonly hangSessionScopeClose?: boolean;
    readonly startTurn?: Effect.Effect<void>;
    readonly beforeUnload?: Effect.Effect<void>;
    readonly listLoadedNativeThreads?: ProviderAdapter.ProviderAdapterV2SessionRuntime["listLoadedNativeThreads"];
    readonly ensureThread?: ProviderAdapter.ProviderAdapterV2SessionRuntime["ensureThread"];
    readonly afterResume?: Effect.Effect<void>;
    readonly spawnBeforeOpen?: boolean;
    readonly scopeCloseReached?: Deferred.Deferred<void>;
    readonly afterClose?: Effect.Effect<void>;
    readonly driver?: ProviderDriverKind;
    readonly sessionUpdateFanout?: "interested_threads";
    readonly liveSessions?: Map<ProviderSessionId, OrchestrationV2ProviderSession>;
    readonly pendingWorkForThread?: (
      thread: OrchestrationV2ProviderThread,
    ) => Effect.Effect<boolean>;
  } = {},
) {
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const countClose = Effect.addFinalizer(() =>
    Ref.update(state, (current) => ({
      ...current,
      closeCount: current.closeCount + 1,
    })).pipe(Effect.andThen(options.afterClose ?? Effect.void)),
  );
  // Registered after countClose so it runs first on scope close, wedging the
  // close before the closeCount finalizer, like a provider process that never
  // yields its message stream.
  const hangClose = Effect.addFinalizer(() =>
    (options.scopeCloseReached === undefined
      ? Effect.void
      : Deferred.succeed(options.scopeCloseReached, undefined)
    ).pipe(Effect.andThen(Effect.never)),
  );
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: ProviderInstanceId.make("codex"),
    driver: options.driver ?? CODEX_DRIVER,
    getCapabilities: () => Effect.succeed(options.capabilities ?? CodexCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        if (options.spawnBeforeOpen === true) {
          yield* countClose;
          if (options.hangSessionScopeClose === true) yield* hangClose;
        }
        if (options.mcpConfigs !== undefined && options.spawnBeforeOpen === true) {
          const mcpConfig = yield* mcpSessions.read(input.threadId);
          yield* Ref.update(options.mcpConfigs, (configs) => [...configs, mcpConfig]);
        }
        if (options.beforeOpen !== undefined) {
          yield* options.beforeOpen(input);
        }
        if (options.mcpConfigs !== undefined && options.spawnBeforeOpen !== true) {
          const mcpConfig = yield* mcpSessions.read(input.threadId);
          yield* Ref.update(options.mcpConfigs, (configs) => [...configs, mcpConfig]);
        }
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
        const session = makeProviderSession({
          providerSessionId: input.providerSessionId,
          now,
          ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
          ...(options.driver === undefined ? {} : { driver: options.driver }),
        });
        options.liveSessions?.set(input.providerSessionId, session);
        yield* Ref.update(state, (current) => {
          const eventQueues = new Map(current.eventQueues);
          eventQueues.set(String(input.providerSessionId), events);
          return {
            ...current,
            openCount: current.openCount + 1,
            eventQueues,
          };
        });
        if (options.spawnBeforeOpen !== true) {
          yield* countClose;
          if (options.hangSessionScopeClose === true) yield* hangClose;
        }

        return {
          instanceId: ProviderInstanceId.make("codex"),
          driver: options.driver ?? CODEX_DRIVER,
          providerSessionId: input.providerSessionId,
          get providerSession() {
            return options.liveSessions?.get(input.providerSessionId) ?? session;
          },
          ...(options.sessionUpdateFanout === undefined
            ? {}
            : { sessionUpdateFanout: options.sessionUpdateFanout }),
          events: options.failEventStream
            ? Stream.fail(
                new ProviderAdapter.ProviderAdapterEventStreamError({
                  driver: CODEX_DRIVER,
                  providerSessionId: input.providerSessionId,
                  cause: "process exited",
                }),
              )
            : Stream.fromQueue(events),
          ...(options.backgroundTasksEndWithProcess === false
            ? {}
            : { backgroundTasksEndWithProcess: true as const }),
          ...(options.hasPendingBackgroundWork === undefined
            ? {}
            : { hasPendingBackgroundWork: options.hasPendingBackgroundWork }),
          ...(options.hasPendingBackgroundWorkForThread === undefined
            ? {}
            : {
                hasPendingBackgroundWorkForThread: () => options.hasPendingBackgroundWorkForThread!,
              }),
          ...(options.pendingWorkForThread === undefined
            ? {}
            : { hasPendingBackgroundWorkForThread: options.pendingWorkForThread }),
          ensureThread:
            options.ensureThread ?? (() => unimplemented("ensureThread unused in test")),
          resumeThread: (threadInput) =>
            Ref.update(state, (current) => ({
              ...current,
              resumeCount: current.resumeCount + 1,
            })).pipe(
              Effect.andThen(options.afterResume ?? Effect.void),
              Effect.as(threadInput.providerThread),
            ),
          startTurn: () => options.startTurn ?? Effect.void,
          compactThread: () => options.startTurn ?? Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () =>
            Ref.update(state, (current) => ({
              ...current,
              interruptCount: current.interruptCount + 1,
            })),
          unloadThread: ({ providerThread }) =>
            (options.beforeUnload ?? Effect.void).pipe(
              Effect.andThen(
                Ref.update(state, (current) => ({
                  ...current,
                  unloadedNativeThreadIds: [
                    ...current.unloadedNativeThreadIds,
                    providerThread.nativeThreadRef?.nativeId ?? "",
                  ],
                })),
              ),
            ),
          ...(options.listLoadedNativeThreads === undefined
            ? {}
            : { listLoadedNativeThreads: options.listLoadedNativeThreads }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused in test"),
          rollbackThread: () => unimplemented("rollbackThread unused in test"),
          forkThread: () => unimplemented("forkThread unused in test"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
});

function layerTest(input: {
  readonly state: Ref.Ref<TestProviderRuntimeState>;
  readonly adapterRegistryLayer?: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >;
  readonly idleTimeoutMs?: number;
  readonly maxIdlePinMs?: number;
  readonly failEventStream?: boolean;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly mcpConfigs?: Ref.Ref<
    ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
  >;
  readonly beforeOpen?: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly initialProviderItemIdentityVersion?: 2;
  }) => Effect.Effect<void>;
  readonly failReleaseEventWrites?: boolean;
  readonly flakyReleaseWrites?: FlakyReleaseWrites;
  readonly pauseAttachWrite?: Parameters<typeof layerPausingAttachEventSink>[0];
  readonly beforeUnchangedWrite?: Ref.Ref<Effect.Effect<void>>;
  readonly beforeMessageRead?: Effect.Effect<void>;
  readonly pauseResolve?: {
    readonly armed: Ref.Ref<boolean>;
    readonly paused: Deferred.Deferred<void>;
  };
  readonly mcpRegistryLayer?: Layer.Layer<McpSessionRegistry.McpSessionRegistry>;
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  readonly hasPendingBackgroundWorkForThread?: Effect.Effect<boolean>;
  readonly backgroundTasksEndWithProcess?: boolean;
  readonly hangSessionScopeClose?: boolean;
  readonly startTurn?: Effect.Effect<void>;
  readonly beforeUnload?: Effect.Effect<void>;
  readonly listLoadedNativeThreads?: ProviderAdapter.ProviderAdapterV2SessionRuntime["listLoadedNativeThreads"];
  readonly ensureThread?: ProviderAdapter.ProviderAdapterV2SessionRuntime["ensureThread"];
  readonly afterResume?: Effect.Effect<void>;
  readonly spawnBeforeOpen?: boolean;
  readonly scopeCloseReached?: Deferred.Deferred<void>;
  readonly afterClose?: Effect.Effect<void>;
  readonly serverSettingsLayer?: ReturnType<typeof ServerSettings.layerTest>;
  readonly projectServiceLayer?: Layer.Layer<ProjectService.ProjectService>;
  readonly sessionWriteHook?: Ref.Ref<SessionWriteHook>;
  readonly driver?: ProviderDriverKind;
  readonly sessionUpdateFanout?: "interested_threads";
  readonly liveSessions?: Map<ProviderSessionId, OrchestrationV2ProviderSession>;
  readonly pendingWorkForThread?: (thread: OrchestrationV2ProviderThread) => Effect.Effect<boolean>;
}) {
  const layerConfiguredEventSink =
    input.sessionWriteHook !== undefined
      ? layerInterceptedSessionEventSink(input.sessionWriteHook)
      : input.flakyReleaseWrites !== undefined
        ? layerFlakyReleaseEventSink(input.flakyReleaseWrites)
        : input.pauseAttachWrite !== undefined
          ? layerPausingAttachEventSink(input.pauseAttachWrite)
          : input.beforeUnchangedWrite !== undefined
            ? layerBeforeUnchangedWriteEventSink(input.beforeUnchangedWrite)
            : input.failReleaseEventWrites
              ? layerFailingReleaseEventSink
              : layerTestEventSink;
  const layerManagerStores =
    input.beforeMessageRead === undefined
      ? layerTestStores
      : Layer.effect(
          ProjectionStore.ProjectionStoreV2,
          Effect.gen(function* () {
            const delegate = yield* ProjectionStore.ProjectionStoreV2;
            const getThreadRecords: ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"] = (
              threadId,
              fields,
              filter,
            ) =>
              (fields.some((field) => field === "messages")
                ? input.beforeMessageRead!
                : Effect.void
              ).pipe(Effect.andThen(delegate.getThreadRecords(threadId, fields, filter)));
            return ProjectionStore.ProjectionStoreV2.of({ ...delegate, getThreadRecords });
          }),
        ).pipe(Layer.provideMerge(layerTestStores));
  const layerRegistry =
    input.adapterRegistryLayer ??
    Layer.unwrap(
      makeProviderAdapter(input.state, {
        failEventStream: input.failEventStream ?? false,
        ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
        ...(input.mcpConfigs === undefined ? {} : { mcpConfigs: input.mcpConfigs }),
        ...(input.beforeOpen === undefined ? {} : { beforeOpen: input.beforeOpen }),
        ...(input.hasPendingBackgroundWork === undefined
          ? {}
          : { hasPendingBackgroundWork: input.hasPendingBackgroundWork }),
        ...(input.hasPendingBackgroundWorkForThread === undefined
          ? {}
          : { hasPendingBackgroundWorkForThread: input.hasPendingBackgroundWorkForThread }),
        ...(input.backgroundTasksEndWithProcess === undefined
          ? {}
          : { backgroundTasksEndWithProcess: input.backgroundTasksEndWithProcess }),
        ...(input.hangSessionScopeClose === undefined
          ? {}
          : { hangSessionScopeClose: input.hangSessionScopeClose }),
        ...(input.startTurn === undefined ? {} : { startTurn: input.startTurn }),
        ...(input.beforeUnload === undefined ? {} : { beforeUnload: input.beforeUnload }),
        ...(input.listLoadedNativeThreads === undefined
          ? {}
          : { listLoadedNativeThreads: input.listLoadedNativeThreads }),
        ...(input.ensureThread === undefined ? {} : { ensureThread: input.ensureThread }),
        ...(input.afterResume === undefined ? {} : { afterResume: input.afterResume }),
        ...(input.spawnBeforeOpen === undefined ? {} : { spawnBeforeOpen: input.spawnBeforeOpen }),
        ...(input.afterClose === undefined ? {} : { afterClose: input.afterClose }),
        ...(input.scopeCloseReached === undefined
          ? {}
          : { scopeCloseReached: input.scopeCloseReached }),
        ...(input.driver === undefined ? {} : { driver: input.driver }),
        ...(input.sessionUpdateFanout === undefined
          ? {}
          : { sessionUpdateFanout: input.sessionUpdateFanout }),
        ...(input.liveSessions === undefined ? {} : { liveSessions: input.liveSessions }),
        ...(input.pendingWorkForThread === undefined
          ? {}
          : { pendingWorkForThread: input.pendingWorkForThread }),
      }).pipe(Effect.map(ProviderAdapterRegistry.layerSingle)),
    );
  const layerConfiguredMcpRegistry =
    input.mcpRegistryLayer ??
    (input.pauseResolve === undefined
      ? layerTestMcpRegistry
      : layerPausingMcpRegistry(input.pauseResolve));
  const layerProviderEventIngestorTest = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerConfiguredEventSink,
        IdAllocator.layer,
        layerTestStores,
        ThreadCommandExecutor.layer,
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveBranchName: () => Effect.succeed(null),
        }),
      ),
    ),
  );
  return Layer.mergeAll(
    layerTestDatabase,
    layerTestStores,
    layerConfiguredEventSink,
    EffectOutbox.layer.pipe(Layer.provide(layerTestDatabase)),
    IdAllocator.layer,
    layerConfiguredMcpRegistry,
    McpProviderSessions.layer,
    ProviderSessionManager.layerWithOptions({
      ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
      ...(input.maxIdlePinMs === undefined ? {} : { maxIdlePinMs: input.maxIdlePinMs }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          layerRegistry.pipe(Layer.provideMerge(McpProviderSessions.layer)),
          CommandOutputHub.layer.pipe(
            Layer.provide(Layer.merge(layerConfiguredEventSink, layerTestStores)),
          ),
          layerConfiguredEventSink,
          EffectOutbox.layer.pipe(Layer.provide(layerTestDatabase)),
          IdAllocator.layer,
          layerProviderEventIngestorTest,
          layerConfiguredMcpRegistry,
          layerManagerStores,
          ...(input.serverSettingsLayer === undefined ? [] : [input.serverSettingsLayer]),
          ...(input.projectServiceLayer === undefined ? [] : [input.projectServiceLayer]),
        ),
      ),
    ),
  ).pipe(Layer.provide(NodeServices.layer));
}

const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-provider-session-manager")),
  getDescriptor: Effect.die("unused"),
});

const layerTestMcpCredentialStore = CredentialStore.layer.pipe(
  Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
);

const layerTestMcpRegistryWithStore = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
  Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
);

const layerTestMcpRegistry = layerTestMcpRegistryWithStore.pipe(
  Layer.provide(layerTestMcpCredentialStore),
  Layer.provide(NodeServices.layer),
);

const layerPausingMcpRegistry = (pause: {
  readonly armed: Ref.Ref<boolean>;
  readonly paused: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    McpSessionRegistry.McpSessionRegistry,
    Effect.gen(function* () {
      const delegate = yield* McpSessionRegistry.McpSessionRegistry;
      return McpSessionRegistry.McpSessionRegistry.of({
        ...delegate,
        resolve: (rawToken) =>
          Ref.getAndSet(pause.armed, false).pipe(
            Effect.flatMap((armed) =>
              armed
                ? Deferred.succeed(pause.paused, undefined).pipe(Effect.andThen(Effect.never))
                : delegate.resolve(rawToken),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(layerTestMcpRegistry));

function makeBrowserAccessProject(projectId: ProjectId): Project {
  return {
    id: projectId,
    title: "Browser access project",
    workspaceRoot: process.cwd(),
    repositoryIdentity: null,
    faviconPath: null,
    projectIcon: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function runBrowserAccessScenario(input: {
  readonly enableAgentBrowserAccess: boolean;
  readonly projectOverride: boolean;
  readonly deviceOverride?: boolean;
  readonly createThread?: boolean;
  readonly projectExists?: boolean;
}) {
  return Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const projectId = ProjectId.make("project-provider-session-manager-browser-access");
    const threadId = ThreadId.make("thread-provider-session-manager-browser-access");
    const layerProjectService = Layer.mock(ProjectService.ProjectService)({
      getById: (requestedProjectId) =>
        Effect.succeed(
          input.projectExists === false
            ? Option.none()
            : Option.some(makeBrowserAccessProject(requestedProjectId)),
        ),
    });

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      if (input.createThread !== false) {
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now, projectId })],
        });
      }
      yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.ignore);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          projectServiceLayer: layerProjectService,
          serverSettingsLayer: ServerSettings.layerTest({
            enableAgentBrowserAccess: input.enableAgentBrowserAccess,
            projectSettingsOverrides: {
              [projectId]: {
                enableAgentBrowserAccess: input.projectOverride,
                ...(input.deviceOverride === undefined
                  ? {}
                  : { enableAgentDeviceAccess: input.deviceOverride }),
              },
            },
          }),
        }),
      ),
    );

    return (yield* Ref.get(mcpConfigs))[0];
  });
}

function makePendingRuntimeRequestEvents(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}) {
  return Effect.gen(function* () {
    const requestId = yield* input.idAllocator.allocate.runtimeRequest({
      driver: CODEX_DRIVER,
      nativeRequestId: "pending-approval",
    });
    const nodeId = input.idAllocator.derive.approvalNode({ requestId });
    const node = {
      id: nodeId,
      threadId: input.threadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "approval_request" as const,
      status: "waiting" as const,
      countsForRun: false,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: input.now,
      completedAt: null,
    };
    const request = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: {
        driver: CODEX_DRIVER,
        nativeId: "pending-approval",
        strength: "strong" as const,
      },
      kind: "command" as const,
      status: "pending" as const,
      responseCapability: {
        type: "live" as const,
        providerSessionId: input.providerSessionId,
      },
      createdAt: input.now,
      resolvedAt: null,
    };
    const turnItem = {
      id: input.idAllocator.derive.approvalTurnItem({ requestId }),
      threadId: input.threadId,
      runId: null,
      nodeId,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "waiting" as const,
      title: null,
      startedAt: input.now,
      completedAt: null,
      updatedAt: input.now,
      type: "approval_request" as const,
      requestId,
      requestKind: "command" as const,
    };
    const events = [
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "node.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: node,
      },
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "runtime-request.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: request,
      },
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "turn-item.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: turnItem,
      },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
    const providerEvents = [
      {
        type: "runtime_request.updated" as const,
        driver: CODEX_DRIVER,
        threadId: input.threadId,
        runtimeRequest: request,
      },
      {
        type: "node.updated" as const,
        driver: CODEX_DRIVER,
        node,
      },
      {
        type: "turn_item.updated" as const,
        driver: CODEX_DRIVER,
        turnItem,
      },
    ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
    return { events, providerEvents, requestId, nodeId };
  });
}

const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

const makeSessionAudienceFixture = Effect.fnUntraced(function* (
  state: Ref.Ref<TestProviderRuntimeState>,
  count = 3,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const eventStore = yield* EventStore.EventStoreV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadIds = Array.from({ length: count }, (_, i) => ThreadId.make(`audience-${i}`));
  const providerSessionId = yield* idAllocator.allocate.providerSession({
    providerInstanceId: modelSelection.instanceId,
    threadId: threadIds[0]!,
  });
  const created = yield* Effect.forEach(threadIds, (threadId) =>
    makeThreadCreatedEvent({ idAllocator, threadId, now }),
  );
  yield* eventSink.write({ events: created });
  const runtimes = yield* Effect.forEach(threadIds, (threadId) =>
    manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy }),
  );
  const runtime = runtimes[0]!;
  assert.isTrue(runtimes.every((candidate) => candidate === runtime));
  const providerThreadOf = (threadId: ThreadId) =>
    makeProviderThread({
      idAllocator,
      threadId,
      providerSessionId,
      now,
      driver: runtime.driver,
      nativeThreadId: `native-${threadId}`,
    });
  const publish = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* Effect.acquireRelease(
          runtime.subscribeEvents!,
          (sub) => sub.close,
        );
        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, event);
        // The pump publishes only after persistence and cache bookkeeping finish.
        assert.deepEqual(yield* subscription.events.pipe(Stream.runHead), Option.some(event));
      }),
    );
  const resume = (threadId: ThreadId) =>
    runtime.resumeThread({
      providerThread: providerThreadOf(threadId),
      threadId,
      modelSelection,
      runtimePolicy,
    });
  const start = Effect.fnUntraced(function* (
    threadId: ThreadId,
    ordinal = 1,
    providerThread = providerThreadOf(threadId),
  ) {
    const runId = idAllocator.derive.run({ threadId, ordinal });
    yield* runtime.startTurn({
      appThread: created.find((event) => event.threadId === threadId)!.payload,
      threadId,
      runId,
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
      rootNodeId: idAllocator.derive.rootNode({ runId }),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: yield* idAllocator.allocate.message({ threadId, ordinal }),
        text: "turn",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
  });
  const finish = (threadId: ThreadId, ordinal = 1) =>
    publish({
      type: "turn.terminal",
      driver: runtime.driver,
      providerThreadId: providerThreadOf(threadId).id,
      providerTurnId: idAllocator.derive.providerTurn({
        driver: runtime.driver,
        nativeTurnId: `native-turn-${threadId}-${ordinal}`,
      }),
      runOrdinal: ordinal,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    });
  const updatesSince = (afterSequence: number) =>
    eventStore
      .read({ afterSequence, eventType: "provider-session.updated" })
      .pipe(Stream.runCollect);
  const emit = Effect.fnUntraced(function* (session: OrchestrationV2ProviderSession) {
    const before = yield* eventStore.latestSequence();
    yield* publish({
      type: "provider_session.updated",
      driver: runtime.driver,
      providerSession: session,
    });
    return yield* updatesSince(before);
  });
  const updatedEnvelope = Effect.fnUntraced(function* (
    threadId: ThreadId,
    payload: OrchestrationV2ProviderSession,
  ) {
    return {
      id: yield* idAllocator.allocate.event({ threadId, providerSessionId: payload.id }),
      threadId,
      type: "provider-session.updated" as const,
      driver: payload.driver,
      providerInstanceId: payload.providerInstanceId,
      occurredAt: yield* DateTime.now,
      payload,
    };
  });
  return {
    eventSink,
    eventStore,
    idAllocator,
    manager,
    projectionStore,
    now,
    threadIds,
    providerSessionId,
    runtime,
    providerThreadOf,
    publish,
    resume,
    start,
    finish,
    updatesSince,
    emit,
    updatedEnvelope,
  };
});

function assertSessionRecipients(
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
  threadIds: ReadonlyArray<ThreadId>,
  session: OrchestrationV2ProviderSession,
) {
  assert.deepEqual(events.map((stored) => stored.event.threadId).toSorted(), [...threadIds].sort());
  for (const { event } of events) {
    assert.equal(event.type, "provider-session.updated");
    assert.deepEqual(event.payload, session);
  }
}

const observeSessionUpdates = Effect.fnUntraced(function* (
  manager: ProviderSessionManager.ProviderSessionManagerV2Shape,
  threadId: ThreadId,
) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  yield* manager
    .observeThreadSessionUpdates(threadId)
    .pipe(Effect.provideService(Scope.Scope, scope));
  return { close: Scope.close(scope, Exit.void) };
});

it.effect(
  "opted-in session status reaches busy loaded and viewed threads without dormant fanout",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state, 1000);
        const [busy, loaded, viewed] = f.threadIds;
        yield* observeSessionUpdates(f.manager, viewed!);
        // Every dormant fixture was genuinely loaded, ran, and reached its idle timer.
        for (const threadId of f.threadIds) {
          yield* f.resume(threadId);
          yield* f.start(threadId);
          if (threadId !== busy) yield* f.finish(threadId);
        }
        yield* TestClock.adjust("1 second");
        assert.deepEqual(
          (yield* Ref.get(state)).unloadedNativeThreadIds.toSorted(),
          f.threadIds
            .slice(2)
            .map((id) => `native-${id}`)
            .sort(),
        );
        assert.equal((yield* Ref.get(state)).resumeCount, 1000);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        const rawA = yield* Effect.acquireRelease(f.runtime.subscribeEvents!, (sub) => sub.close);
        const rawB = yield* Effect.acquireRelease(f.runtime.subscribeEvents!, (sub) => sub.close);
        for (const [index, status] of (["running", "waiting", "ready"] as const).entries()) {
          const session = {
            ...f.runtime.providerSession,
            status,
            updatedAt: DateTime.add(f.now, { seconds: index + 1 }),
          };
          assertSessionRecipients(yield* f.emit(session), [busy!, loaded!, viewed!], session);
        }
        for (const subscription of [rawA, rawB]) {
          const received = yield* subscription.events.pipe(Stream.take(3), Stream.runCollect);
          assert.deepEqual(
            received.map((event) =>
              event.type === "provider_session.updated" ? event.providerSession.status : event.type,
            ),
            ["running", "waiting", "ready"],
          );
        }
        for (const threadId of f.threadIds) {
          const records = yield* f.projectionStore.getThreadRecords(threadId, ["providerSessions"]);
          assert.deepEqual(
            records.providerSessions.map((session) => session.id),
            [f.providerSessionId],
          );
          assert.equal(records.providerSessions[0]!.status, "ready");
        }
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            driver: OPENCODE_DRIVER,
            sessionUpdateFanout: "interested_threads",
            pendingWorkForThread: (thread) =>
              Effect.succeed(thread.appThreadId === ThreadId.make("audience-1")),
          }),
        ),
      );
    }),
  { timeout: 120_000 },
);

it.effect(
  "busy owners survive thread cache eviction and only matching terminals clear overlapping ordinals",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const failStart = yield* Ref.make(false);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        const [, busy, failed] = f.threadIds;
        yield* f.resume(busy!);
        yield* f.start(busy!, 1);
        yield* f.start(busy!, 2);
        yield* f.publish({
          type: "provider_thread.updated",
          driver: f.runtime.driver,
          providerThread: { ...f.providerThreadOf(busy!), status: "error" },
        });
        const running = { ...f.runtime.providerSession, status: "running" as const };
        assertSessionRecipients(yield* f.emit(running), [busy!], running);
        yield* f.finish(busy!, 1);
        yield* TestClock.adjust("1 second");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
        const waiting = { ...running, status: "waiting" as const };
        assertSessionRecipients(yield* f.emit(waiting), [busy!], waiting);
        yield* f.finish(busy!, 1);
        assertSessionRecipients(yield* f.emit(running), [busy!], running);

        yield* Ref.set(failStart, true);
        assert.isTrue(Exit.isFailure(yield* f.start(failed!).pipe(Effect.exit)));
        yield* Ref.set(failStart, false);
        yield* f.finish(failed!); // A late terminal for a rejected start cannot clear the other owner.
        // A rejected send can still have reloaded its native thread.
        assertSessionRecipients(yield* f.emit(waiting), [busy!, failed!], waiting);
        yield* f.finish(busy!, 2);
        const ready = { ...running, status: "ready" as const };
        assertSessionRecipients(yield* f.emit(ready), [failed!], ready);
        yield* TestClock.adjust("1 second");
        assert.isTrue(Option.isNone(yield* f.manager.get(f.providerSessionId)));
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            sessionUpdateFanout: "interested_threads",
            startTurn: Ref.get(failStart).pipe(
              Effect.flatMap((fail) => (fail ? Effect.die("failed start") : Effect.void)),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "observer refcounts survive runtime replacement and failed refresh without creating activity",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const hook = yield* Ref.make<SessionWriteHook>(() => Effect.void);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        const [carrier, viewed] = f.threadIds;
        const { close: closeFirst } = yield* observeSessionUpdates(f.manager, viewed!);
        const { close: closeSecond } = yield* observeSessionUpdates(f.manager, viewed!);
        const before = yield* Ref.get(state);
        const mcp = yield* McpProviderSessions.McpProviderSessions;
        const credential = yield* mcp.read(viewed!);
        const running = { ...f.runtime.providerSession, status: "running" as const };
        assertSessionRecipients(yield* f.emit(running), [viewed!], running);
        yield* closeFirst;
        assertSessionRecipients(yield* f.emit({ ...running, status: "waiting" }), [viewed!], {
          ...running,
          status: "waiting",
        });
        yield* Ref.set(hook, (input) =>
          input.refreshBoundProviderSessions
            ? Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length }))
            : Effect.void,
        );
        const error = yield* f.manager.refreshThreadSessionUpdates(viewed!).pipe(Effect.flip);
        assert.equal(error._tag, "ProviderSessionRefreshError");
        yield* Ref.set(hook, () => Effect.void);
        assertSessionRecipients(yield* f.emit(running), [viewed!], running);
        assert.equal((yield* Ref.get(state)).openCount, before.openCount);
        assert.equal((yield* Ref.get(state)).resumeCount, before.resumeCount);
        assert.deepEqual(yield* mcp.read(viewed!), credential);

        yield* f.manager.close(f.providerSessionId);
        const replacement = yield* f.manager.open({
          threadId: carrier!,
          providerSessionId: f.providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* f.manager.open({
          threadId: viewed!,
          providerSessionId: f.providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const subscription = yield* Effect.acquireRelease(
          replacement.subscribeEvents!,
          (sub) => sub.close,
        );
        const queue = (yield* Ref.get(state)).eventQueues.get(String(f.providerSessionId))!;
        const replacementRunning = { ...replacement.providerSession, status: "running" as const };
        const head = yield* f.eventStore.latestSequence();
        yield* Queue.offer(queue, {
          type: "provider_session.updated",
          driver: replacement.driver,
          providerSession: replacementRunning,
        });
        yield* subscription.events.pipe(Stream.runHead);
        assertSessionRecipients(yield* f.updatesSince(head), [viewed!], replacementRunning);
        yield* closeSecond;
        const last = yield* Effect.acquireRelease(replacement.subscribeEvents!, (sub) => sub.close);
        const after = yield* f.eventStore.latestSequence();
        yield* Queue.offer(queue, {
          type: "provider_session.updated",
          driver: replacement.driver,
          providerSession: { ...replacementRunning, status: "ready" },
        });
        yield* last.events.pipe(Stream.runHead);
        assertSessionRecipients(yield* f.updatesSince(after), [carrier!], {
          ...replacementRunning,
          status: "ready",
        });

        const { close: idleLease } = yield* observeSessionUpdates(f.manager, viewed!);
        yield* TestClock.adjust("500 millis");
        yield* f.manager.refreshThreadSessionUpdates(viewed!);
        yield* TestClock.adjust("500 millis");
        assert.isTrue(Option.isNone(yield* f.manager.get(f.providerSessionId)));
        yield* idleLease;
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            driver: OPENCODE_DRIVER,
            sessionUpdateFanout: "interested_threads",
            sessionWriteHook: hook,
          }),
        ),
      );
    }),
);

it.effect(
  "zero interested attachments retain one canonical carrier and zero attachments write nothing",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        yield* observeSessionUpdates(f.manager, ThreadId.make("not-attached"));
        const running = { ...f.runtime.providerSession, status: "running" as const };
        assertSessionRecipients(yield* f.emit(running), [f.threadIds[0]!], running);
        for (const threadId of f.threadIds)
          yield* f.manager.detach({ providerSessionId: f.providerSessionId, threadId });
        yield* observeSessionUpdates(f.manager, f.threadIds[1]!);
        assert.deepEqual(yield* f.emit({ ...running, status: "waiting" }), []);
      }).pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, sessionUpdateFanout: "interested_threads" }),
        ),
      );
    }),
);

it.effect(
  "only healthy status and updatedAt changes narrow; metadata, errors, recovery and release stay full audience",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        yield* observeSessionUpdates(f.manager, f.threadIds[1]!);
        let previous = f.runtime.providerSession;
        const transitions: ReadonlyArray<
          readonly [Partial<OrchestrationV2ProviderSession>, boolean]
        > = [
          [{ status: "running" }, false],
          [{ updatedAt: DateTime.add(f.now, { seconds: 1 }) }, false],
          [{ status: "error", lastError: "first failure" }, true],
          [{ lastError: "different failure" }, true],
          [{ status: "ready", lastError: null }, true],
          [{ status: "waiting" }, false],
          [{ status: "starting" }, true],
          [{ status: "ready" }, true],
          [{ status: "stopped" }, true],
          [{ status: "ready" }, true],
          [{ model: "gpt-5.4-mini" }, true],
          [{ cwd: "/different-workspace" }, true],
          [
            {
              capabilities: {
                ...CodexCapabilities,
                sessions: {
                  ...CodexCapabilities.sessions,
                  supportsModelSwitchInSession:
                    !CodexCapabilities.sessions.supportsModelSwitchInSession,
                },
              },
            },
            true,
          ],
          [{ lastError: "warning while ready" }, true],
          [{ lastError: null }, true],
          [{ status: "running" }, false],
        ];
        for (const [patch, full] of transitions) {
          previous = { ...previous, ...patch };
          assertSessionRecipients(
            yield* f.emit(previous),
            full ? f.threadIds : [f.threadIds[1]!],
            previous,
          );
          assert.isTrue(Option.isSome(yield* f.manager.get(f.providerSessionId)));
        }
        assert.equal((yield* Ref.get(state)).openCount, 1);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        const before = yield* f.eventStore.latestSequence();
        yield* f.manager.close(f.providerSessionId);
        const released = yield* f.updatesSince(before);
        assert.deepEqual(
          released.map((stored) => stored.event.threadId).toSorted(),
          [...f.threadIds].sort(),
        );
        assert.isTrue(
          released.every(
            ({ event }) =>
              event.type === "provider-session.updated" && event.payload.status === "stopped",
          ),
        );
      }).pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, sessionUpdateFanout: "interested_threads" }),
        ),
      );
    }),
);

it.effect.each(["live", "closed", "delayed"] as const)(
  "replacement Codex resume authenticates with its launch credential (predecessor: %s)",
  (predecessor) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const launchHeaders: Array<string | undefined> = [];
      const nativeThreadId = "resumed-credential-conversation";
      const threadId = ThreadId.make("resumed-credential-thread");
      const adapterRegistryLayer = Layer.effect(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        Effect.gen(function* () {
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
            instanceId: modelSelection.instanceId,
            settings: CodexAdapterV2.CodexAdapterV2Driver.defaultConfig(),
            environment: {},
            crypto: yield* Crypto.Crypto,
            fileSystem: yield* FileSystem.FileSystem,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
            serverConfig: yield* makeReplayServerConfig("replacement-credential"),
            clientFactory: {
              open: (input) =>
                Effect.gen(function* () {
                  const context = yield* Layer.build(
                    CodexReplay.layerReplay({
                      provider: "codex",
                      protocol: "codex.app-server",
                      version: "0.144.0",
                      scenario: "replacement-credential",
                      entries: [
                        {
                          type: "expect_outbound",
                          frame: {
                            id: 1,
                            method: "initialize",
                            params: {
                              clientInfo: {
                                name: "T3 Code",
                                title: "T3 Code",
                                version: packageJson.version,
                              },
                              capabilities: {
                                experimentalApi: true,
                                optOutNotificationMethods: ["turn/diff/updated"],
                                extensions: {
                                  "io.modelcontextprotocol/ui": {
                                    mimeTypes: ["text/html;profile=mcp-app"],
                                  },
                                },
                              },
                            },
                          },
                        },
                        {
                          type: "emit_inbound",
                          frame: {
                            id: 1,
                            result: {
                              userAgent: "T3 Code/test",
                              codexHome: "/tmp/codex-home",
                              platformFamily: "unix",
                              platformOs: "linux",
                            },
                          },
                        },
                        { type: "expect_outbound", frame: { method: "initialized" } },
                        {
                          type: "expect_outbound",
                          frame: {
                            id: 2,
                            method: "thread/resume",
                            params: {
                              threadId: nativeThreadId,
                              excludeTurns: true,
                              config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                            },
                          },
                        },
                        {
                          type: "emit_inbound",
                          frame: {
                            id: 2,
                            result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } },
                          },
                        },
                      ],
                    }),
                  ).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapter.ProviderAdapterOpenSessionError({
                          driver: CODEX_DRIVER,
                          providerSessionId: input.providerSessionId,
                          cause,
                        }),
                    ),
                  );
                  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
                    Effect.provide(context),
                  );
                  return {
                    ...client,
                    raw: {
                      ...client.raw,
                      request: (method, params) =>
                        Effect.gen(function* () {
                          if (method === "thread/resume") {
                            // Replay ignores machine-specific MCP config; inspect the actual outbound header.
                            const header =
                              decodeResumeMcpConfig(params).config["mcp_servers.t3-code"]
                                ?.http_headers.Authorization;
                            launchHeaders.push(header);
                            if (header === undefined)
                              return yield* client.raw.request(method, params);
                            const authenticated = yield* registry.resolve(
                              header.replace(/^Bearer\s+/, ""),
                            );
                            assert.equal(
                              authenticated?.thread.threadId,
                              threadId,
                              "the first tool's launch header must authenticate",
                            );
                            assert.equal(
                              authenticated?.thread.providerInstanceId,
                              modelSelection.instanceId,
                            );
                          }
                          return yield* client.raw.request(method, params);
                        }),
                    },
                  } satisfies CodexClient.CodexAppServerClient["Service"];
                }),
            },
          });
          return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            get: () => Effect.succeed(adapter),
            list: () => Effect.succeed([modelSelection.instanceId]),
          });
        }),
      ).pipe(
        Layer.provide(Layer.mergeAll(layerTestMcpRegistry, IdAllocator.layer, NodeServices.layer)),
        Layer.orDie,
      );
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const credentials = yield* McpProviderSessions.McpProviderSessions;
        const sink = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
        });
        const open = Effect.gen(function* () {
          const runtimeId = yield* ids.allocate.providerSession({
            threadId,
            providerInstanceId: modelSelection.instanceId,
          });
          const runtime = yield* manager.open({
            threadId,
            providerSessionId: runtimeId,
            modelSelection,
            runtimePolicy,
          });
          const resume = runtime.resumeThread({
            threadId,
            providerThread: makeProviderThread({
              idAllocator: ids,
              threadId,
              providerSessionId: runtimeId,
              now,
              nativeThreadId,
            }),
          });
          return { runtimeId, resume };
        });
        const original = yield* open;
        if (predecessor !== "delayed") yield* original.resume;
        const originalCredential = yield* credentials.read(threadId);
        if (predecessor === "closed") yield* manager.close(original.runtimeId);
        const replacement = yield* open;
        yield* replacement.resume;
        const replacementCredential = yield* credentials.read(threadId);
        assert.equal(launchHeaders.at(-1), replacementCredential?.authorizationHeader);
        if (predecessor === "delayed") {
          const refused = yield* original.resume.pipe(Effect.result);
          assert.equal(refused._tag, "Failure");
          if (refused._tag === "Failure") {
            const refusal = decodeMcpResumeRefusal(refused.failure);
            assert.include(
              refusal.cause.detail,
              "MCP credential is not owned by this provider runtime",
            );
          }
          assert.lengthOf(launchHeaders, 1, "a predecessor must not send the replacement token");
        } else {
          assert.lengthOf(launchHeaders, 2);
        }
        assert.notEqual(
          originalCredential?.authorizationHeader,
          replacementCredential?.authorizationHeader,
        );
        assert.isUndefined(
          yield* registry.resolve(
            originalCredential!.authorizationHeader.replace(/^Bearer\s+/, ""),
          ),
        );
        assert.equal(
          (yield* registry.resolve(
            replacementCredential!.authorizationHeader.replace(/^Bearer\s+/, ""),
          ))?.thread.threadId,
          threadId,
        );
      }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, adapterRegistryLayer })));
    }),
);

it.effect.each([
  { name: "shared Codex", capabilities: CodexCapabilities, count: 3 },
  { name: "exclusive provider", capabilities: ExclusiveCapabilities, count: 1 },
])("$name without the opt-in keeps full fanout", ({ capabilities, count }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const f = yield* makeSessionAudienceFixture(state, count);
      const running = { ...f.runtime.providerSession, status: "running" as const };
      assertSessionRecipients(yield* f.emit(running), f.threadIds, running);
      const before = yield* f.eventStore.latestSequence();
      yield* f.manager.refreshThreadSessionUpdates(f.threadIds[0]!);
      assert.equal(yield* f.eventStore.latestSequence(), before);
    }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, capabilities })));
  }),
);

it.effect(
  "decorated runtimes forward the live getter and the real turn-start service persists its current session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const liveSessions = new Map<ProviderSessionId, OrchestrationV2ProviderSession>();
      const started =
        yield* Queue.unbounded<RunExecutionService.RunExecutionServiceV2StartRootRunInput>();
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        const threadId = f.threadIds[2]!;
        const ready = f.runtime.providerSession;
        const changed = {
          ...ready,
          status: "waiting" as const,
          model: "live-model",
          updatedAt: DateTime.add(f.now, { seconds: 1 }),
        };
        liveSessions.set(f.providerSessionId, changed);
        assert.strictEqual(f.runtime.providerSession, changed);
        // The getter is ahead of the queued pump. Its new metadata must not be the comparison baseline.
        assertSessionRecipients(yield* f.emit(changed), f.threadIds, changed);
        const running = { ...changed, status: "running" as const };
        liveSessions.set(f.providerSessionId, running);
        assertSessionRecipients(yield* f.emit(running), [f.threadIds[0]!], running);

        const providerThread = f.providerThreadOf(threadId);
        const runId = f.idAllocator.derive.run({ threadId, ordinal: 1 });
        const rootNodeId = f.idAllocator.derive.rootNode({ runId });
        const attemptId = f.idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const messageId = yield* f.idAllocator.allocate.message({ threadId, ordinal: 1 });
        const checkpointScopeId = yield* f.idAllocator.allocate.checkpointScope({
          threadId,
          name: "live-getter",
        });
        const payloads = [
          { type: "provider-thread.updated", payload: providerThread },
          {
            type: "run.created",
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: providerThread.id,
              userMessageId: messageId,
              rootNodeId,
              activeAttemptId: attemptId,
              status: "starting",
              requestedAt: f.now,
              startedAt: null,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            type: "run-attempt.updated",
            payload: {
              id: attemptId,
              runId,
              rootNodeId,
              attemptOrdinal: 1,
              providerInstanceId: modelSelection.instanceId,
              providerThreadId: providerThread.id,
              providerTurnId: null,
              reason: "initial",
              status: "pending",
              startedAt: null,
              completedAt: null,
            },
          },
          {
            type: "node.updated",
            payload: {
              id: rootNodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId,
              kind: "root_turn",
              status: "pending",
              countsForRun: true,
              providerThreadId: providerThread.id,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId,
              startedAt: null,
              completedAt: null,
            },
          },
          {
            type: "message.updated",
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: rootNodeId,
              role: "user",
              text: "start with the current session",
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "web",
              createdAt: f.now,
              updatedAt: f.now,
            },
          },
          {
            type: "checkpoint-scope.created",
            payload: {
              id: checkpointScopeId,
              threadId,
              runId,
              nodeId: rootNodeId,
              parentScopeId: null,
              providerThreadId: providerThread.id,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: runtimePolicy.cwd,
              createdAt: f.now,
            },
          },
        ] as const;
        const events = yield* Effect.forEach(payloads, (event) =>
          Effect.gen(function* () {
            return {
              ...event,
              id: yield* f.idAllocator.allocate.event({ threadId }),
              threadId,
              occurredAt: f.now,
            } satisfies OrchestrationV2DomainEvent;
          }),
        );
        yield* f.eventSink.write({ events });
        const head = yield* f.eventStore.latestSequence();
        const startLayer = ProviderTurnStart.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(EventSink.EventSinkV2, f.eventSink),
              Layer.succeed(IdAllocator.IdAllocatorV2, f.idAllocator),
              Layer.succeed(ProjectionStore.ProjectionStoreV2, f.projectionStore),
              Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, f.manager),
              Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
              Layer.mock(GitWorkflow.GitWorkflowService)({}),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(ProviderAuthService.ProviderAuthService)({}),
              Layer.mock(RuntimePolicy.RuntimePolicyV2)({
                resolve: () => Effect.succeed(runtimePolicy),
              }),
              Layer.mock(RunExecutionService.RunExecutionServiceV2)({
                prepareUsageBeforeStart: () => Effect.succeed(() => Effect.void),
                startRootRun: (input) => Queue.offer(started, input).pipe(Effect.asVoid),
              }),
              ServerConfig.layerTest(process.cwd(), {
                prefix: "provider-session-manager-start-",
              }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, Path.layer))),
              ServerSettings.layerTest(),
              NodeServices.layer,
              Path.layer,
            ),
          ),
        );
        yield* Effect.gen(function* () {
          yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
        }).pipe(Effect.provide(startLayer));
        const delivery = yield* Queue.take(started);
        assert.strictEqual(delivery.session.providerSession, f.runtime.providerSession);
        assert.deepEqual(delivery.session.providerSession, running);
        assertSessionRecipients(yield* f.updatesSince(head), [threadId], running);
        assert.equal(
          (yield* f.projectionStore.getThreadProjection(threadId)).runs[0]!.status,
          "running",
        );
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            driver: OPENCODE_DRIVER,
            sessionUpdateFanout: "interested_threads",
            liveSessions,
          }),
        ),
      );
    }),
);

it.effect.each(["update", "refresh"] as const)(
  "a blocked session %s does not stall another session's update or turn acceptance",
  (blockedWrite) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const hook = yield* Ref.make<SessionWriteHook>(() => Effect.void);
      const paused = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        const otherThread = ThreadId.make("unblocked-session");
        yield* f.eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator: f.idAllocator,
              threadId: otherThread,
              now: f.now,
            }),
          ],
        });
        const otherSessionId = yield* f.idAllocator.allocate.providerSession({
          threadId: otherThread,
          providerInstanceId: modelSelection.instanceId,
        });
        const other = yield* f.manager.open({
          threadId: otherThread,
          providerSessionId: otherSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* observeSessionUpdates(f.manager, otherThread);
        yield* Ref.set(hook, (input) =>
          input.events.some(
            (event) =>
              event.type === "provider-session.updated" && event.payload.id === f.providerSessionId,
          )
            ? Ref.set(hook, () => Effect.void).pipe(
                Effect.andThen(Deferred.succeed(paused, undefined)),
                Effect.andThen(Deferred.await(release)),
              )
            : Effect.void,
        );
        const blocked = yield* (
          blockedWrite === "update"
            ? f.emit({ ...f.runtime.providerSession, status: "running" })
            : f.manager.refreshThreadSessionUpdates(f.threadIds[0]!)
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(paused);
        const unblocked = yield* Effect.gen(function* () {
          const subscription = yield* Effect.acquireRelease(
            other.subscribeEvents!,
            (sub) => sub.close,
          );
          const queue = (yield* Ref.get(state)).eventQueues.get(String(otherSessionId))!;
          const running = { ...other.providerSession, status: "running" as const };
          const runId = f.idAllocator.derive.run({ threadId: otherThread, ordinal: 1 });
          const accepted = {
            type: "provider_turn.updated",
            driver: other.driver,
            threadId: otherThread,
            providerTurn: {
              id: f.idAllocator.derive.providerTurn({
                driver: other.driver,
                nativeTurnId: "accepted",
              }),
              providerThreadId: f.providerThreadOf(otherThread).id,
              nodeId: f.idAllocator.derive.rootNode({ runId }),
              runAttemptId: f.idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: f.now,
              completedAt: null,
            },
          } satisfies ProviderAdapter.ProviderAdapterV2Event;
          const update = {
            type: "provider_session.updated",
            driver: other.driver,
            providerSession: running,
          } satisfies ProviderAdapter.ProviderAdapterV2Event;
          const before = yield* f.eventStore.latestSequence();
          yield* Queue.offer(queue, update);
          yield* Queue.offer(queue, accepted);
          assert.deepEqual(yield* subscription.events.pipe(Stream.take(2), Stream.runCollect), [
            update,
            accepted,
          ]);
          assertSessionRecipients(yield* f.updatesSince(before), [otherThread], running);
          assert.isFalse(yield* Deferred.isDone(release));
          yield* observeSessionUpdates(f.manager, otherThread);
          yield* f.manager.refreshThreadSessionUpdates(otherThread);
        }).pipe(Effect.forkScoped);
        yield* Fiber.join(unblocked).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(blocked);
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            driver: OPENCODE_DRIVER,
            sessionUpdateFanout: "interested_threads",
            sessionWriteHook: hook,
          }),
        ),
      );
    }),
);

it.effect(
  "late observers wait for their session fan-out before snapshots and refreshes while new attachments survive bookkeeping",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const hook = yield* Ref.make<SessionWriteHook>(() => Effect.void);
      const selected = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const observerStarted = yield* Deferred.make<void>();
      const observerAcquired = yield* Deferred.make<void>();
      const liveSessions = new Map<ProviderSessionId, OrchestrationV2ProviderSession>();
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        const [carrier, , viewed] = f.threadIds;
        const running = { ...f.runtime.providerSession, status: "running" as const };
        liveSessions.set(f.providerSessionId, running);
        yield* Ref.set(hook, (input) =>
          input.refreshBoundProviderSessions === undefined &&
          input.events.some((event) => event.type === "provider-session.updated")
            ? Ref.set(hook, () => Effect.void).pipe(
                Effect.andThen(Deferred.succeed(selected, undefined)),
                Effect.andThen(Deferred.await(commit)),
              )
            : Effect.void,
        );
        const updating = yield* f.emit(running).pipe(Effect.forkScoped);
        yield* Deferred.await(selected);
        const watching = yield* Effect.gen(function* () {
          yield* Deferred.succeed(observerStarted, undefined);
          yield* observeSessionUpdates(f.manager, viewed!);
          yield* Deferred.succeed(observerAcquired, undefined);
          yield* f.manager.refreshThreadSessionUpdates(viewed!);
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(observerStarted);

        const attached = ThreadId.make("attached-during-status-commit");
        yield* f.eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator: f.idAllocator,
              threadId: attached,
              now: f.now,
            }),
          ],
        });
        yield* f.manager.open({
          threadId: attached,
          providerSessionId: f.providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* f.runtime.resumeThread({
          providerThread: f.providerThreadOf(attached),
          threadId: attached,
          modelSelection,
          runtimePolicy,
        });
        assert.isFalse(yield* Deferred.isDone(observerAcquired));
        yield* Deferred.succeed(commit, undefined);
        yield* Fiber.join(updating);
        yield* Fiber.join(watching);

        const refreshed = yield* f.eventStore
          .read({ threadId: viewed!, eventType: "provider-session.updated" })
          .pipe(Stream.runCollect);
        assertSessionRecipients(refreshed, [viewed!], running);
        const carrierEvents = yield* f.eventStore
          .read({ threadId: carrier!, eventType: "provider-session.updated" })
          .pipe(Stream.runCollect);
        assert.lengthOf(carrierEvents, 1);
        assert.isAbove(refreshed[0]!.sequence, carrierEvents[0]!.sequence);
        const waiting = { ...running, status: "waiting" as const };
        assertSessionRecipients(yield* f.emit(waiting), [viewed!, attached], waiting);
        const bindings = yield* f.projectionStore.getThreadRecords(attached, ["providerSessions"]);
        assert.deepEqual(
          bindings.providerSessions.map((session) => session.id),
          [f.providerSessionId],
        );
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            driver: OPENCODE_DRIVER,
            sessionUpdateFanout: "interested_threads",
            liveSessions,
            sessionWriteHook: hook,
          }),
        ),
      );
    }),
);

it.effect(
  "failed pump writes release the session lock without advancing the successful comparison baseline",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const hook = yield* Ref.make<SessionWriteHook>(() => Effect.void);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        const changed = {
          ...f.runtime.providerSession,
          model: "new-model",
          status: "running" as const,
        };
        yield* Ref.set(hook, (input) =>
          input.events.some((event) => event.type === "provider-session.updated")
            ? Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length }))
            : Effect.void,
        );
        assert.deepEqual(yield* f.emit(changed), []);
        yield* observeSessionUpdates(f.manager, f.threadIds[1]!);
        yield* Ref.set(hook, () => Effect.void);
        // Retrying exactly the failed payload must still be a metadata change, not ordinary status.
        assertSessionRecipients(yield* f.emit(changed), f.threadIds, changed);
        const ready = { ...changed, status: "ready" as const };
        assertSessionRecipients(yield* f.emit(ready), [f.threadIds[1]!], ready);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            sessionUpdateFanout: "interested_threads",
            sessionWriteHook: hook,
          }),
        ),
      );
    }),
);

it.effect.each(["failure", "interruption"] as const)(
  "a refresh %s releases the session lock for subsequent leases and status writes",
  (outcome) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const hook = yield* Ref.make<SessionWriteHook>(() => Effect.void);
      const paused = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        yield* Ref.set(hook, (input) =>
          input.refreshBoundProviderSessions
            ? Deferred.succeed(paused, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(
                  Effect.fail(
                    new EventSink.EventSinkWriteError({ eventCount: input.events.length }),
                  ),
                ),
              )
            : Effect.void,
        );
        const refreshing = yield* f.manager
          .refreshThreadSessionUpdates(f.threadIds[1]!)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(paused);
        if (outcome === "interruption") {
          yield* Fiber.interrupt(refreshing);
          assert.isTrue(Exit.isFailure(yield* Fiber.await(refreshing)));
        } else {
          yield* Deferred.succeed(release, undefined);
          const error = yield* Fiber.join(refreshing).pipe(Effect.flip);
          assert.equal(error._tag, "ProviderSessionRefreshError");
        }
        yield* Ref.set(hook, () => Effect.void);
        const { close } = yield* observeSessionUpdates(f.manager, f.threadIds[1]!);
        yield* f.manager.refreshThreadSessionUpdates(f.threadIds[1]!);
        const running = { ...f.runtime.providerSession, status: "running" as const };
        assertSessionRecipients(yield* f.emit(running), [f.threadIds[1]!], running);
        yield* close;
        assertSessionRecipients(yield* f.emit({ ...running, status: "ready" }), [f.threadIds[0]!], {
          ...running,
          status: "ready",
        });
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            driver: OPENCODE_DRIVER,
            sessionUpdateFanout: "interested_threads",
            sessionWriteHook: hook,
          }),
        ),
      );
    }),
);

it.effect("a blocked session status write does not hold another session's native events", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const hook = yield* Ref.make<SessionWriteHook>(() => Effect.void);
    const paused = yield* Deferred.make<void>();
    const commit = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const f = yield* makeSessionAudienceFixture(state, 1);
      const otherThread = ThreadId.make("independent-claude-session");
      yield* f.eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({
            idAllocator: f.idAllocator,
            threadId: otherThread,
            now: f.now,
          }),
        ],
      });
      const otherSessionId = yield* f.idAllocator.allocate.providerSession({
        threadId: otherThread,
        providerInstanceId: modelSelection.instanceId,
      });
      const other = yield* f.manager.open({
        threadId: otherThread,
        providerSessionId: otherSessionId,
        modelSelection,
        runtimePolicy,
      });
      const subscription = yield* Effect.acquireRelease(other.subscribeEvents!, (sub) => sub.close);
      yield* Ref.set(hook, (input) =>
        input.events.some(
          (event) =>
            event.type === "provider-session.updated" &&
            event.payload.id === f.providerSessionId &&
            event.payload.status === "running",
        )
          ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(commit)))
          : Effect.void,
      );
      const queues = (yield* Ref.get(state)).eventQueues;
      yield* Queue.offer(queues.get(String(f.providerSessionId))!, {
        type: "provider_session.updated",
        driver: f.runtime.driver,
        providerSession: { ...f.runtime.providerSession, status: "running" },
      });
      yield* Deferred.await(paused);
      const running = {
        type: "provider_session.updated" as const,
        driver: other.driver,
        providerSession: { ...other.providerSession, status: "running" as const },
      };
      yield* Queue.offer(queues.get(String(otherSessionId))!, running);
      assert.deepEqual(yield* subscription.events.pipe(Stream.runHead), Option.some(running));
      assert.isFalse(yield* Deferred.isDone(commit));
      const records = yield* f.projectionStore.getThreadRecords(otherThread, ["providerSessions"]);
      assert.equal(records.providerSessions.at(-1)?.status, "running");
    }).pipe(
      Effect.ensuring(Deferred.succeed(commit, undefined)),
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          driver: ProviderDriverKind.make("claudeAgent"),
          sessionWriteHook: hook,
        }),
      ),
    );
  }),
);

it.effect(
  "interrupting a pump write releases the session permit for a different live session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const hook = yield* Ref.make<SessionWriteHook>(() => Effect.void);
      const paused = yield* Deferred.make<void>();
      const interruptWrite = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        const otherThread = ThreadId.make("other-live-session");
        yield* f.eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator: f.idAllocator,
              threadId: otherThread,
              now: f.now,
            }),
          ],
        });
        const otherSessionId = yield* f.idAllocator.allocate.providerSession({
          threadId: otherThread,
          providerInstanceId: modelSelection.instanceId,
        });
        const other = yield* f.manager.open({
          threadId: otherThread,
          providerSessionId: otherSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* Ref.set(hook, (input) =>
          input.events.some(
            (event) =>
              event.type === "provider-session.updated" &&
              event.payload.id === f.providerSessionId &&
              event.payload.status === "running",
          )
            ? Deferred.succeed(paused, undefined).pipe(
                Effect.andThen(Deferred.await(interruptWrite)),
                Effect.andThen(Effect.interrupt),
              )
            : Effect.void,
        );
        yield* Queue.offer((yield* Ref.get(state)).eventQueues.get(String(f.providerSessionId))!, {
          type: "provider_session.updated",
          driver: f.runtime.driver,
          providerSession: { ...f.runtime.providerSession, status: "running" },
        });
        yield* Deferred.await(paused);
        yield* Ref.set(hook, () => Effect.void);
        yield* Deferred.succeed(interruptWrite, undefined);
        yield* observeSessionUpdates(f.manager, otherThread);
        yield* f.manager.refreshThreadSessionUpdates(otherThread);
        const subscription = yield* Effect.acquireRelease(
          other.subscribeEvents!,
          (sub) => sub.close,
        );
        const before = yield* f.eventStore.latestSequence();
        const running = { ...other.providerSession, status: "running" as const };
        yield* Queue.offer((yield* Ref.get(state)).eventQueues.get(String(otherSessionId))!, {
          type: "provider_session.updated",
          driver: other.driver,
          providerSession: running,
        });
        yield* subscription.events.pipe(Stream.runHead);
        assertSessionRecipients(yield* f.updatesSince(before), [otherThread], running);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            driver: OPENCODE_DRIVER,
            sessionUpdateFanout: "interested_threads",
            sessionWriteHook: hook,
          }),
        ),
      );
    }),
);

it.effect.each(["error", "ready", "detach", "replacement", "archive", "delete"] as const)(
  "resume refresh reads canonical bindings inside the commit transaction (%s)",
  (race) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const hook = yield* Ref.make<SessionWriteHook>(() => Effect.void);
      const preflight = yield* Deferred.make<ReadonlyArray<OrchestrationV2DomainEvent>>();
      const enterTransaction = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        const threadId = f.threadIds[2]!;
        const stale =
          race === "ready"
            ? { ...f.runtime.providerSession, status: "error" as const, lastError: "old error" }
            : f.runtime.providerSession;
        yield* f.eventSink.write({ events: [yield* f.updatedEnvelope(f.threadIds[0]!, stale)] });
        yield* Ref.set(hook, (input) =>
          input.refreshBoundProviderSessions
            ? Deferred.succeed(preflight, input.events).pipe(
                Effect.andThen(Deferred.await(enterTransaction)),
              )
            : Effect.void,
        );
        const refreshing = yield* f.manager
          .refreshThreadSessionUpdates(threadId)
          .pipe(Effect.forkScoped);
        const placeholders = yield* Deferred.await(preflight);
        assert.lengthOf(placeholders, 1);
        assert.deepEqual(placeholders[0]!.payload, stale);

        const newer = {
          ...stale,
          status: race === "error" ? ("error" as const) : ("ready" as const),
          lastError: race === "error" ? "new canonical error" : null,
          model: "canonical-model",
          cwd: "/canonical-workspace",
          updatedAt: DateTime.add(f.now, { seconds: 10 }),
        };
        let replacement: OrchestrationV2ProviderSession | undefined;
        if (race === "error" || race === "ready") {
          yield* f.eventSink.write({ events: [yield* f.updatedEnvelope(f.threadIds[0]!, newer)] });
        } else if (race === "detach" || race === "replacement") {
          const events: Array<OrchestrationV2DomainEvent> = [
            {
              id: yield* f.idAllocator.allocate.event({ threadId }),
              threadId,
              type: "provider-session.detached",
              occurredAt: f.now,
              payload: { providerSessionId: f.providerSessionId, detachedAt: f.now },
            },
          ];
          if (race === "replacement") {
            replacement = {
              ...newer,
              id: yield* f.idAllocator.allocate.providerSession({
                threadId,
                providerInstanceId: modelSelection.instanceId,
              }),
            };
            events.push({
              ...(yield* f.updatedEnvelope(threadId, replacement)),
              type: "provider-session.attached",
            });
          }
          yield* f.eventSink.write({ events });
        } else {
          const { thread } = yield* f.projectionStore.getThreadRecords(threadId, [
            "providerSessions",
          ]);
          yield* f.eventSink.write({
            events: [
              {
                id: yield* f.idAllocator.allocate.event({ threadId }),
                threadId,
                occurredAt: f.now,
                type: race === "archive" ? "thread.archived" : "thread.deleted",
                payload: {
                  ...thread,
                  ...(race === "archive" ? { archivedAt: f.now } : { deletedAt: f.now }),
                },
              },
            ],
          });
        }
        const afterRace = yield* f.eventStore.latestSequence();
        yield* TestClock.adjust("1 second");
        yield* Deferred.succeed(enterTransaction, undefined);
        yield* Fiber.join(refreshing);
        yield* Ref.set(hook, () => Effect.void);
        const refreshed = yield* f.updatesSince(afterRace);
        if (race === "error" || race === "ready") {
          assertSessionRecipients(refreshed, [threadId], newer);
          assert.equal(refreshed[0]!.event.id, placeholders[0]!.id);
          assert.equal(refreshed[0]!.event.driver, newer.driver);
          assert.equal(refreshed[0]!.event.providerInstanceId, newer.providerInstanceId);
          assert.deepEqual(refreshed[0]!.event.occurredAt, yield* DateTime.now);
          assert.isAbove(refreshed[0]!.sequence, afterRace);
          const published = yield* f.eventSink
            .stream({ threadId, afterSequence: afterRace })
            .pipe(Stream.take(1), Stream.runCollect);
          assert.deepEqual(published, refreshed);
        } else {
          assert.deepEqual(refreshed, []);
          assert.equal(yield* f.eventStore.latestSequence(), afterRace);
          const records = yield* f.projectionStore.getThreadRecords(threadId, ["providerSessions"]);
          if (race === "detach") assert.deepEqual(records.providerSessions, []);
          if (race === "replacement") {
            assert.isDefined(replacement);
            assert.deepEqual(records.providerSessions, [replacement!]);
          }
          if (race === "archive") assert.deepEqual(records.thread.archivedAt, f.now);
          if (race === "delete") assert.deepEqual(records.thread.deletedAt, f.now);
        }
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            driver: OPENCODE_DRIVER,
            sessionUpdateFanout: "interested_threads",
            sessionWriteHook: hook,
          }),
        ),
      );
    }),
);

it.effect(
  "refresh batches dedupe stable thread/session pairs and use real increasing sequences on the normal publication lane",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        const [first, second] = f.threadIds;
        const extraId = yield* f.idAllocator.allocate.providerSession({
          threadId: first!,
          providerInstanceId: modelSelection.instanceId,
        });
        const canonical = {
          ...f.runtime.providerSession,
          status: "waiting" as const,
          model: "canonical",
        };
        const extra = { ...canonical, id: extraId };
        yield* f.eventSink.write({
          events: [
            yield* f.updatedEnvelope(first!, canonical),
            { ...(yield* f.updatedEnvelope(first!, extra)), type: "provider-session.attached" },
          ],
        });
        const head = yield* f.eventStore.latestSequence();
        const a = yield* f.updatedEnvelope(second!, f.runtime.providerSession);
        const b = yield* f.updatedEnvelope(first!, f.runtime.providerSession);
        const c = yield* f.updatedEnvelope(first!, extra);
        const missing = yield* f.updatedEnvelope(
          ThreadId.make("missing-refresh-thread"),
          canonical,
        );
        const live = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
        yield* f.eventSink.stream({ afterSequence: head }).pipe(
          Stream.runForEach((event) => Queue.offer(live, event)),
          Effect.forkScoped,
        );
        const marker = yield* f.eventSink.write({
          events: [yield* f.updatedEnvelope(second!, canonical)],
        });
        assert.deepEqual(yield* Queue.take(live), marker[0]);
        const refresh = yield* f.eventSink.write({
          events: [a, b, a, c, b, missing],
          refreshBoundProviderSessions: true,
        });
        assert.deepEqual(
          refresh.map(({ event }) => event.id),
          [a.id, b.id, c.id],
        );
        assert.deepEqual(
          refresh.map(({ event }) => event.payload),
          [canonical, canonical, extra],
        );
        const ordinary = yield* f.eventSink.write({
          events: [yield* f.updatedEnvelope(second!, { ...canonical, status: "ready" })],
        });
        const committed = [...refresh, ...ordinary];
        assert.isTrue(
          committed.every(
            (stored, index) =>
              stored.sequence >
              (index === 0 ? marker[0]!.sequence : committed[index - 1]!.sequence),
          ),
        );
        const replay = yield* f.eventStore
          .read({ afterSequence: marker[0]!.sequence })
          .pipe(Stream.runCollect);
        assert.deepEqual(replay, committed);
        const published = yield* Effect.forEach(committed, () => Queue.take(live));
        assert.deepEqual(published, committed);
        const beforeNoop = yield* f.eventStore.latestSequence();
        yield* f.manager.refreshThreadSessionUpdates(ThreadId.make("missing-refresh-thread"));
        assert.equal(yield* f.eventStore.latestSequence(), beforeNoop);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            driver: OPENCODE_DRIVER,
            sessionUpdateFanout: "interested_threads",
          }),
        ),
      );
    }),
);

it.effect(
  "refresh skips unbound, archived, deleted and exclusive OpenCode rows without opening or loading a runtime",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const hook = yield* Ref.make<SessionWriteHook>(() => Effect.void);
      const refreshWrites = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        const extra = Array.from({ length: 4 }, (_, index) =>
          ThreadId.make(`skipped-refresh-${index}`),
        );
        for (const threadId of extra)
          yield* f.eventSink.write({
            events: [
              yield* makeThreadCreatedEvent({ idAllocator: f.idAllocator, threadId, now: f.now }),
            ],
          });
        const [unbound, archived, deleted, exclusive] = extra;
        for (const threadId of [archived!, deleted!, exclusive!]) {
          const session = {
            ...f.runtime.providerSession,
            id: yield* f.idAllocator.allocate.providerSession({
              threadId,
              providerInstanceId: modelSelection.instanceId,
            }),
            ...(threadId === exclusive ? { capabilities: ExclusiveCapabilities } : {}),
          };
          yield* f.eventSink.write({
            events: [
              {
                ...(yield* f.updatedEnvelope(threadId, session)),
                type: "provider-session.attached",
              },
            ],
          });
        }
        for (const [threadId, type] of [
          [archived!, "thread.archived"],
          [deleted!, "thread.deleted"],
        ] as const) {
          const { thread } = yield* f.projectionStore.getThreadRecords(threadId, [
            "providerSessions",
          ]);
          yield* f.eventSink.write({
            events: [
              {
                id: yield* f.idAllocator.allocate.event({ threadId }),
                threadId,
                type,
                occurredAt: f.now,
                payload: {
                  ...thread,
                  ...(type === "thread.archived" ? { archivedAt: f.now } : { deletedAt: f.now }),
                },
              },
            ],
          });
        }
        const beforeState = yield* Ref.get(state);
        const before = yield* f.eventStore.latestSequence();
        yield* Ref.set(hook, (input) =>
          input.refreshBoundProviderSessions
            ? Ref.update(refreshWrites, (count) => count + 1)
            : Effect.void,
        );
        for (const threadId of [
          unbound!,
          archived!,
          deleted!,
          exclusive!,
          ThreadId.make("does-not-exist"),
        ]) {
          yield* f.manager.refreshThreadSessionUpdates(threadId);
        }
        assert.equal(yield* Ref.get(refreshWrites), 0);
        assert.equal(yield* f.eventStore.latestSequence(), before);
        assert.deepEqual(yield* Ref.get(state), beforeState);
        // The sink enforces the same restrictions even if a caller supplies a stale candidate.
        const requests = yield* Effect.forEach(extra, (threadId) =>
          f.updatedEnvelope(threadId, f.runtime.providerSession),
        );
        const records = yield* f.projectionStore.getThreadRecords(exclusive!, ["providerSessions"]);
        requests.push(yield* f.updatedEnvelope(exclusive!, records.providerSessions[0]!));
        assert.deepEqual(
          yield* f.eventSink.write({ events: requests, refreshBoundProviderSessions: true }),
          [],
        );
        assert.equal(yield* f.eventStore.latestSequence(), before);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            driver: OPENCODE_DRIVER,
            sessionUpdateFanout: "interested_threads",
            sessionWriteHook: hook,
          }),
        ),
      );
    }),
);

it.effect.each([
  "mixed-events",
  "effects",
  "native-owner",
  "request-guard",
  "completion-only",
] as const)(
  "refresh rejects %s atomically rather than partially updating sessions or enqueuing effects",
  (invalid) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state);
        const threadId = f.threadIds[0]!;
        const before = yield* f.eventStore.latestSequence();
        const original = (yield* f.projectionStore.getThreadRecords(threadId, ["providerSessions"]))
          .providerSessions;
        const event = yield* f.updatedEnvelope(threadId, {
          ...f.runtime.providerSession,
          status: "error",
          lastError: "must not persist",
        });
        const commandId = CommandId.make(`invalid-refresh-${invalid}`);
        const effect: EffectOutbox.PendingOrchestrationEffectV2 = {
          id: `invalid-refresh-effect-${invalid}`,
          commandId,
          threadId,
          request: { type: "provider-session.detach", providerSessionId: f.providerSessionId },
        };
        const result = yield* f.eventSink
          .writeWithEffects({
            refreshBoundProviderSessions: true,
            events:
              invalid === "mixed-events"
                ? [
                    event,
                    yield* makeThreadCreatedEvent({
                      idAllocator: f.idAllocator,
                      threadId: ThreadId.make("must-not-create"),
                      now: f.now,
                    }),
                  ]
                : [event],
            effects: invalid === "effects" ? [effect] : [],
            ...(invalid === "native-owner"
              ? { unlessNativeThreadOwned: f.providerThreadOf(threadId) }
              : {}),
            ...(invalid === "request-guard" ? { guardPendingUserInputCancellations: true } : {}),
            ...(invalid === "completion-only" ? { updateDelegatedCompletionOnly: true } : {}),
          })
          .pipe(Effect.flip);
        assert.equal(result._tag, "EventSinkWriteError");
        assert.equal(yield* f.eventStore.latestSequence(), before);
        assert.deepEqual(
          (yield* f.projectionStore.getThreadRecords(threadId, ["providerSessions"]))
            .providerSessions,
          original,
        );
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        assert.isTrue(Option.isNone(yield* outbox.get(effect.id)));
        if (invalid === "mixed-events") {
          const missing = yield* f.projectionStore
            .getThreadRecords(ThreadId.make("must-not-create"), ["providerSessions"])
            .pipe(Effect.flip);
          assert.equal(missing._tag, "ProjectionStoreThreadNotFoundError");
        }
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            driver: OPENCODE_DRIVER,
            sessionUpdateFanout: "interested_threads",
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 opens independent sessions concurrently", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const openStartedCount = yield* Ref.make(0);
    const firstOpenStarted = yield* Deferred.make<void>();
    const secondOpenStarted = yield* Deferred.make<void>();
    const releaseOpens = yield* Deferred.make<void>();
    const beforeOpen = () =>
      Effect.gen(function* () {
        const openNumber = yield* Ref.modify(openStartedCount, (count) => [count + 1, count + 1]);
        yield* Deferred.succeed(openNumber === 1 ? firstOpenStarted : secondOpenStarted, undefined);
        yield* Deferred.await(releaseOpens);
      });

    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-concurrent-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-concurrent-b");
      const firstProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      const secondProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: secondThreadId,
      });

      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      const firstFiber = yield* manager
        .open({
          threadId: firstThreadId,
          providerSessionId: firstProviderSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstOpenStarted);
      const secondFiber = yield* manager
        .open({
          threadId: secondThreadId,
          providerSessionId: secondProviderSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);

      yield* Deferred.await(secondOpenStarted);
      assert.equal(yield* Ref.get(openStartedCount), 2);
      yield* Deferred.succeed(releaseOpens, undefined);
      const [firstRuntime, secondRuntime] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);
      assert.notStrictEqual(firstRuntime, secondRuntime);
      assert.equal((yield* Ref.get(state)).openCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 closes every live session for a provider instance", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-logout-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-logout-b");
      const firstProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      const secondProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: secondThreadId,
      });

      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      yield* manager.open({
        threadId: firstThreadId,
        providerSessionId: firstProviderSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({
        threadId: secondThreadId,
        providerSessionId: secondProviderSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* manager.closeInstance(modelSelection.instanceId);

      assert.isTrue(Option.isNone(yield* manager.get(firstProviderSessionId)));
      assert.isTrue(Option.isNone(yield* manager.get(secondProviderSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 records provider session and turn metrics", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-metrics");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });

      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      assert.deepEqual(yield* manager.runtimeSnapshot!(), {
        turns: [],
        providerSessions: { codex: 1 },
      });
      yield* runtime.startTurn({
        appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
        threadId,
        runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
        rootNodeId: idAllocator.derive.rootNode({ runId }),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
          text: "hello",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      assert.deepEqual(yield* manager.runtimeSnapshot!(), {
        turns: [{ threadId, provider: modelSelection.instanceId, model: modelSelection.model }],
        providerSessions: { codex: 1 },
      });
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn",
        }),
      });
      yield* manager.close(providerSessionId);
      assert.deepEqual(yield* manager.runtimeSnapshot!(), { turns: [], providerSessions: {} });

      const snapshots = yield* Metric.snapshot;
      const has = (id: string, attributes: Readonly<Record<string, string>>) =>
        snapshots.some(
          (snapshot) =>
            snapshot.id === id &&
            Object.entries(attributes).every(
              ([key, value]) => snapshot.attributes?.[key] === value,
            ),
        );
      assert.isTrue(
        has("t3_provider_sessions_total", {
          provider: "codex",
          operation: "open",
          outcome: "success",
        }),
      );
      assert.isTrue(
        has("t3_provider_sessions_total", {
          provider: "codex",
          operation: "release",
          reason: "manual_shutdown",
          outcome: "success",
        }),
      );
      assert.isTrue(
        has("t3_provider_turns_total", {
          provider: "codex",
          operation: "send",
          modelFamily: "gpt",
          outcome: "success",
        }),
      );
      assert.isTrue(has("t3_provider_turn_duration", { provider: "codex", operation: "send" }));
      assert.isTrue(
        has("t3_provider_turns_total", {
          provider: "codex",
          operation: "interrupt",
          outcome: "success",
        }),
      );
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    );
  }),
);

it.effect("ProviderSessionManagerV2 opens a duplicate session only once", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const openStartedCount = yield* Ref.make(0);
    const firstOpenStarted = yield* Deferred.make<void>();
    const releaseOpen = yield* Deferred.make<void>();
    const beforeOpen = () =>
      Ref.updateAndGet(openStartedCount, (count) => count + 1).pipe(
        Effect.tap(() => Deferred.succeed(firstOpenStarted, undefined)),
        Effect.andThen(Deferred.await(releaseOpen)),
      );

    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-single-flight");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const open = manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const firstFiber = yield* open.pipe(Effect.forkScoped);
      yield* Deferred.await(firstOpenStarted);
      const secondFiber = yield* open.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(openStartedCount), 1);

      yield* Deferred.succeed(releaseOpen, undefined);
      const [firstRuntime, secondRuntime] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);
      assert.strictEqual(firstRuntime, secondRuntime);
      assert.equal((yield* Ref.get(state)).openCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 starts a thread's session without its last agent's OOM kill",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const owner = ThreadId.make("thread-provider-session-manager-oom-owner");
      const joiner = ThreadId.make("thread-provider-session-manager-oom-joiner");
      const oomKilledThreads = new Set<string>([owner, joiner]);
      const agentScope = {
        ...AgentScope.defaultValue(),
        oomKilled: (id: string) => Effect.sync(() => oomKilledThreads.has(id)),
        clear: (id: string) => Effect.sync(() => void oomKilledThreads.delete(id)),
      };

      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: owner,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: owner, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: joiner, now }),
          ],
        });
        yield* manager.open({ threadId: owner, providerSessionId, modelSelection, runtimePolicy });
        assert.isFalse(yield* agentScope.oomKilled(owner));

        yield* manager.open({ threadId: joiner, providerSessionId, modelSelection, runtimePolicy });
        assert.isFalse(yield* agentScope.oomKilled(joiner));

        oomKilledThreads.add(owner);
        yield* manager.open({ threadId: owner, providerSessionId, modelSelection, runtimePolicy });
        assert.isTrue(yield* agentScope.oomKilled(owner));
        assert.equal((yield* Ref.get(state)).openCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })),
        Effect.provideService(AgentScope, agentScope),
      );
    }),
);

it.effect("ProviderSessionManagerV2 cleans up an open interrupted mid-handshake", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const handshakeStarted = yield* Deferred.make<void>();
    const holdHandshake = yield* Ref.make(true);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-interrupted-open");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });

      const opening = yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(handshakeStarted);
      const issued = (yield* Ref.get(mcpConfigs)).at(-1);
      const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(token);
      assert.isDefined(yield* registry.resolve(token!));

      yield* Fiber.interrupt(opening);

      assert.equal((yield* Ref.get(state)).closeCount, 1);
      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(yield* mcpSessions.read(threadId));
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

      yield* Ref.set(holdHandshake, false);
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
      const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(replacementToken);
      assert.notEqual(replacementToken, token);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.providerSessions.at(-1)?.status, "ready");

      yield* manager.close(providerSessionId);
      assert.isUndefined(yield* registry.resolve(replacementToken!));
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          mcpConfigs,
          beforeOpen: () =>
            Ref.get(holdHandshake).pipe(
              Effect.flatMap((hold) =>
                hold
                  ? Deferred.succeed(handshakeStarted, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.void,
              ),
            ),
          spawnBeforeOpen: true,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 cleans up an interrupted open whose scope close hangs", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const handshakeStarted = yield* Deferred.make<void>();
    const scopeCloseReached = yield* Deferred.make<void>();
    const releaseRetry = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-interrupted-hung-open");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });

      const opening = yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.forkChild);
      yield* Deferred.await(handshakeStarted);
      const issued = (yield* Ref.get(mcpConfigs)).at(-1);
      const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(token);

      const interrupter = yield* Fiber.interrupt(opening).pipe(Effect.forkChild);
      yield* Deferred.await(scopeCloseReached);

      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(yield* mcpSessions.read(threadId));
      assert.equal((yield* Ref.get(state)).closeCount, 0);

      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(interrupter);
      yield* Deferred.succeed(releaseRetry, undefined);
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      assert.equal((yield* Ref.get(state)).openCount, 1);

      const stopping = yield* manager.shutdown.pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(stopping);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          mcpConfigs,
          beforeOpen: () =>
            Deferred.isDone(handshakeStarted).pipe(
              Effect.flatMap((retry) =>
                retry
                  ? Deferred.await(releaseRetry)
                  : Deferred.succeed(handshakeStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                    ),
              ),
            ),
          spawnBeforeOpen: true,
          hangSessionScopeClose: true,
          scopeCloseReached,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 releases an idle session whose turn start was stopped", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const startTurnReached = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-stopped-turn-start");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      const starting = yield* runtime
        .startTurn({
          appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId }),
          providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "stopped before the provider accepted it",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(startTurnReached);

      yield* Fiber.interrupt(starting);
      yield* TestClock.adjust("2 seconds");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          startTurn: Deferred.succeed(startTurnReached, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a shared session busy when another thread's start is stopped early",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const projectId = ProjectId.make("project-provider-session-manager-shared-stopped-start");
      const holdProjectRead = yield* Ref.make(false);
      const projectReadHeld = yield* Deferred.make<void>();
      const projectServiceLayer = Layer.mock(ProjectService.ProjectService)({
        getById: (requestedProjectId) =>
          Ref.get(holdProjectRead).pipe(
            Effect.flatMap((hold) =>
              hold
                ? Deferred.succeed(projectReadHeld, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(Option.some(makeBrowserAccessProject(requestedProjectId))),
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadA = ThreadId.make("thread-provider-session-manager-shared-stopped-a");
        const threadB = ThreadId.make("thread-provider-session-manager-shared-stopped-b");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadA, now, projectId }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadB, now, projectId }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: threadA,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: threadB,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const startTurn = (threadId: ThreadId) =>
          Effect.gen(function* () {
            const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
            return yield* runtime.startTurn({
              appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
              threadId,
              runId,
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
              rootNodeId: idAllocator.derive.rootNode({ runId }),
              providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
                text: "turn",
                attachments: [],
              },
              modelSelection,
              runtimePolicy,
            });
          });

        yield* startTurn(threadB);

        yield* manager.detach({ providerSessionId, threadId: threadA });
        yield* Ref.set(holdProjectRead, true);
        const startingA = yield* startTurn(threadA).pipe(Effect.forkChild);
        yield* Deferred.await(projectReadHeld);
        yield* Fiber.interrupt(startingA);

        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            projectServiceLayer,
            serverSettingsLayer: ServerSettings.layerTest({
              projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: true } },
            }),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a shared session busy when a stopped start still ends its turn",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      // A's adapter start installs its turn, then is stopped mid-request; like
      // OpenCode2, the adapter still ends that turn with turn.terminal later.
      const holdStart = yield* Ref.make(false);
      const startHeld = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadA = ThreadId.make("thread-provider-session-manager-stopped-ended-a");
        const threadB = ThreadId.make("thread-provider-session-manager-stopped-ended-b");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadA, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadB, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: threadA,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: threadB,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const providerThreadOf = (threadId: ThreadId) =>
          makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: `native-${threadId}`,
          });
        const startTurn = (threadId: ThreadId) =>
          Effect.gen(function* () {
            const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
            return yield* runtime.startTurn({
              appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
              threadId,
              runId,
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
              rootNodeId: idAllocator.derive.rootNode({ runId }),
              providerThread: providerThreadOf(threadId),
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
                text: "turn",
                attachments: [],
              },
              modelSelection,
              runtimePolicy,
            });
          });

        yield* startTurn(threadB);

        yield* Ref.set(holdStart, true);
        const startingA = yield* startTurn(threadA).pipe(Effect.forkChild);
        yield* Deferred.await(startHeld);
        yield* Fiber.interrupt(startingA);

        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: providerThreadOf(threadA).id,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: CODEX_DRIVER,
            nativeTurnId: "native-turn-stopped-a",
          }),
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });

        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            startTurn: Ref.get(holdStart).pipe(
              Effect.flatMap((hold) =>
                hold
                  ? Deferred.succeed(startHeld, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.void,
              ),
            ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 stops a session still opening when its layer shuts down", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const handshakeStarted = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown-during-open");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.forkDetach);
      yield* Deferred.await(handshakeStarted);
      assert.equal((yield* Ref.get(state)).closeCount, 0);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen: () =>
            Deferred.succeed(handshakeStarted, undefined).pipe(Effect.andThen(Effect.never)),
          spawnBeforeOpen: true,
        }),
      ),
    );

    assert.equal((yield* Ref.get(state)).closeCount, 1);
  }),
);

it.effect("ProviderSessionManagerV2 releases live sessions when its layer shuts down", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      const liveState = yield* Ref.get(state);
      assert.equal(liveState.openCount, 1);
      assert.equal(liveState.closeCount, 0);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
        }),
      ),
    );

    assert.equal((yield* Ref.get(state)).closeCount, 1);
  }),
);

it.effect(
  "ProviderSessionManagerV2 preserves live MCP credentials through its shutdown finalizer",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const threadIds = [
        ThreadId.make("thread-provider-session-manager-shutdown-mcp-attached"),
        ThreadId.make("thread-provider-session-manager-shutdown-mcp-detached"),
        ThreadId.make("thread-provider-session-manager-shutdown-mcp-manual-close"),
      ] as const;
      // Keep the in-memory database alive across two independently scoped registries.
      const layerOuterRegistry = layerTestMcpRegistryWithStore.pipe(
        Layer.provideMerge(layerTestMcpCredentialStore),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const store = yield* CredentialStore.CredentialStore;
        const mcpConfigs = yield* Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
          const now = yield* DateTime.now;
          const providerSessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId: threadIds[0],
          });
          const closingSessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId: threadIds[2],
          });
          yield* eventSink.write({
            events: yield* Effect.forEach(threadIds, (threadId) =>
              makeThreadCreatedEvent({ idAllocator, threadId, now }),
            ),
          });
          for (const threadId of threadIds.slice(0, 2)) {
            yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
          }
          yield* manager.open({
            threadId: threadIds[2],
            providerSessionId: closingSessionId,
            modelSelection,
            runtimePolicy,
          });
          const configs = yield* Effect.forEach(threadIds, (threadId) =>
            mcpSessions.read(threadId),
          );
          for (const [index, config] of configs.entries()) {
            assert.isDefined(config);
            const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");
            assert.equal((yield* registry.resolve(token))?.thread.threadId, threadIds[index]);
          }

          // A shared provider may still hold the detached thread's credential.
          yield* manager.detach({ providerSessionId, threadId: threadIds[1] });
          yield* manager.close(closingSessionId);
          assert.isUndefined(yield* mcpSessions.read(threadIds[2]));
          assert.isUndefined(
            yield* registry.resolve(configs[2]!.authorizationHeader.replace(/^Bearer\s+/, "")),
          );
          assert.equal((yield* Ref.get(state)).closeCount, 1);
          return configs;
        }).pipe(
          Effect.provide(
            layerTest({
              state,
              idleTimeoutMs: 60_000,
              mcpRegistryLayer: Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry),
            }),
          ),
        );

        // The manager layer has closed, not merely the registry's scope.
        assert.equal((yield* Ref.get(state)).openCount, 2);
        assert.equal((yield* Ref.get(state)).closeCount, 2);
        const restoredRegistry = yield* McpSessionRegistry.__testing
          .make()
          .pipe(
            Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
            Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
            Effect.provideService(CredentialStore.CredentialStore, store),
            Effect.provide(NodeServices.layer),
          );
        for (const [index, config] of mcpConfigs.slice(0, 2).entries()) {
          const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");
          const original = yield* registry.resolve(token);
          assert.equal(original?.thread.threadId, threadIds[index]);
          assert.deepEqual(yield* restoredRegistry.resolve(token), original);
        }
        assert.isUndefined(
          yield* restoredRegistry.resolve(
            mcpConfigs[2]!.authorizationHeader.replace(/^Bearer\s+/, ""),
          ),
        );
      }).pipe(Effect.provide(layerOuterRegistry));
    }),
);

it.effect("ProviderSessionManagerV2 releases sessions in parallel on server shutdown", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      for (const name of ["a", "b", "c"]) {
        const threadId = ThreadId.make(`thread-provider-session-manager-parallel-shutdown-${name}`);
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId: yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          }),
          modelSelection,
          runtimePolicy,
        });
      }

      const stopping = yield* manager.shutdown.pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
      assert.isDefined(stopping.pollUnsafe());
    }).pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, hangSessionScopeClose: true })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 interrupts event subscriptions on server shutdown", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown-subscription");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const bufferedSubscription = yield* runtime.subscribeEvents!;
      const activeSubscription = yield* runtime.subscribeEvents!;
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);
      yield* Queue.offer(adapterQueue!, {
        type: "provider_session.updated",
        driver: CODEX_DRIVER,
        providerSession: runtime.providerSession,
      });
      assert.isTrue(Option.isSome(yield* activeSubscription.events.pipe(Stream.runHead)));

      yield* manager.shutdown;

      const exit = yield* bufferedSubscription.events.pipe(Stream.runCollect, Effect.exit);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })));
  }),
);

it.effect("ProviderSessionManagerV2 drains subscribers when the provider stops", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const closed = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-provider-stop");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const subscription = yield* runtime.subscribeEvents!;
      const collected = yield* subscription.events.pipe(Stream.runCollect, Effect.forkScoped);
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "provider-stop-thread",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "provider-stop-turn",
      });
      yield* Queue.offer(adapterQueue!, {
        type: "turn.terminal",
        driver: CODEX_DRIVER,
        providerThreadId,
        providerTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Queue.offer(adapterQueue!, {
        type: "provider_session.updated",
        driver: CODEX_DRIVER,
        providerSession: {
          ...runtime.providerSession,
          status: "stopped",
          updatedAt: now,
        },
      });
      yield* Queue.end(adapterQueue!);

      const events = Array.from(yield* Fiber.join(collected));
      yield* Deferred.await(closed);
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn.terminal", "provider_session.updated"],
      );
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          afterClose: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 issues MCP credentials before opening and revokes them on close",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-mcp");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const captured = (yield* Ref.get(mcpConfigs))[0];
        assert.isDefined(captured);
        assert.equal(captured?.threadId, threadId);
        assert.equal(captured?.providerInstanceId, modelSelection.instanceId);
        assert.equal(captured?.endpoint, "http://127.0.0.1:43123/mcp");
        const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);
        const resolved = yield* registry.resolve(token!);
        assert.equal(resolved?.thread.threadId, threadId);
        assert.deepEqual(
          resolved?.capabilities,
          new Set(["preview", "orchestration", "worktree", "pull-requests"]),
        );

        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* mcpSessions.read(threadId));
        assert.isUndefined(yield* registry.resolve(token!));
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 withholds the preview capability when agent browser access is off",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-no-browser");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const captured = (yield* Ref.get(mcpConfigs))[0];
        assert.isDefined(captured);
        assert.equal(captured?.browserToolsAvailable, false);
        const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
        const resolved = yield* registry.resolve(token!);
        assert.deepEqual(
          resolved?.capabilities,
          new Set(["orchestration", "worktree", "pull-requests"]),
        );

        yield* manager.close(providerSessionId);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            serverSettingsLayer: ServerSettings.layerTest({
              enableAgentBrowserAccess: false,
            }).pipe(Layer.orDie),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 honors a project browser-access opt-out", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.browserToolsAvailable, false);
  }),
);

it.effect("ProviderSessionManagerV2 honors a project browser-access opt-in", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: false,
      projectOverride: true,
    });
    assert.isDefined(captured);
    assert.equal(captured?.browserToolsAvailable, true);
  }),
);

it.effect("ProviderSessionManagerV2 fails browser access closed for a missing project", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: true,
      projectExists: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.browserToolsAvailable, false);
  }),
);

it.effect("ProviderSessionManagerV2 fails browser access closed for a missing thread", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: true,
      createThread: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.browserToolsAvailable, false);
  }),
);

it.effect("ProviderSessionManagerV2 revokes MCP credentials when release persistence fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-mcp-release-failure");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      const captured = (yield* Ref.get(mcpConfigs))[0];
      const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(token);
      assert.isDefined(yield* registry.resolve(token!));

      const closeError = yield* manager.close(providerSessionId).pipe(Effect.flip);
      assert.equal(closeError._tag, "ProviderSessionCloseError");
      assert.isUndefined(yield* mcpSessions.read(threadId));
      assert.isUndefined(yield* registry.resolve(token!));
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          failReleaseEventWrites: true,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a thread attached when an earlier attach of it is interrupted",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const armed = yield* Ref.make(false);
      const paused = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const owner = ThreadId.make("thread-provider-session-manager-attach-race-owner");
        const threadId = ThreadId.make("thread-provider-session-manager-attach-race");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: owner, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: owner,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const resume = runtime.resumeThread({
          threadId,
          providerThread: makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: "native-attach-race",
          }),
        });

        yield* Ref.set(armed, true);
        const first = yield* resume.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(paused);
        const second = yield* resume.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        yield* Fiber.join(second);

        const config = yield* mcpSessions.read(threadId);
        assert.isDefined(config);
        const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.equal((yield* registry.resolve(token))?.thread.threadId, threadId);
      }).pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, pauseAttachWrite: { armed, paused } }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a replacement session's attachment when a stale attach is interrupted",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const armed = yield* Ref.make(false);
      const paused = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const eventStore = yield* EventStore.EventStoreV2;
        const now = yield* DateTime.now;
        const owner = ThreadId.make("thread-provider-session-manager-stale-attach-owner");
        const threadId = ThreadId.make("thread-provider-session-manager-stale-attach");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: owner, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: owner,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        yield* Ref.set(armed, true);
        const stale = yield* runtime
          .resumeThread({
            threadId,
            providerThread: makeProviderThread({
              idAllocator,
              threadId,
              providerSessionId,
              now,
              nativeThreadId: "native-stale-attach",
            }),
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(paused);

        yield* manager.release({ providerSessionId, reason: "runtime_error" });
        const replacement = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const config = yield* mcpSessions.read(threadId);
        assert.isDefined(config);

        yield* Fiber.interrupt(stale);

        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          config!.providerSessionId,
        );
        const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.equal((yield* registry.resolve(token))?.thread.threadId, threadId);
        const attachedEvents = eventStore
          .read({ threadId, eventType: "provider-session.attached" })
          .pipe(
            Stream.runCollect,
            Effect.map((events) => events.length),
          );
        const attachedBefore = yield* attachedEvents;
        yield* replacement.resumeThread({
          threadId,
          providerThread: makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: "native-stale-attach",
          }),
        });
        assert.equal(yield* attachedEvents, attachedBefore);
      }).pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, pauseAttachWrite: { armed, paused } }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 revokes a reused credential after a resume stopped while checking it",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const armed = yield* Ref.make(false);
      const paused = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const owner = ThreadId.make("thread-provider-session-manager-resolve-stop-owner");
        const threadId = ThreadId.make("thread-provider-session-manager-resolve-stop");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: owner, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: owner,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const resume = runtime.resumeThread({
          threadId,
          providerThread: makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: "native-resolve-stop",
          }),
        });
        yield* resume;
        yield* manager.detach({ providerSessionId, threadId });
        const config = yield* mcpSessions.read(threadId);
        assert.isDefined(config);
        const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");

        yield* Ref.set(armed, true);
        const stopped = yield* resume.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(paused);
        yield* Fiber.interrupt(stopped);

        yield* manager.release({ providerSessionId, reason: "manual_shutdown" });
        assert.isUndefined(yield* registry.resolve(token));
      }).pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, pauseResolve: { armed, paused } }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 duplicate detach preserves replacement MCP credentials", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-replacement-mcp");
      const oldSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const replacementSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId: oldSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.detach({ providerSessionId: oldSessionId, threadId });
      yield* manager.open({
        threadId,
        providerSessionId: replacementSessionId,
        modelSelection,
        runtimePolicy,
      });

      const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
      assert.isDefined(replacement);
      const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(replacementToken);
      assert.equal(
        (yield* mcpSessions.read(threadId))?.providerSessionId,
        replacement?.providerSessionId,
      );

      yield* manager.detach({ providerSessionId: oldSessionId, threadId });

      assert.equal(
        (yield* mcpSessions.read(threadId))?.providerSessionId,
        replacement?.providerSessionId,
      );
      assert.equal((yield* registry.resolve(replacementToken!))?.thread.threadId, threadId);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1_000,
          capabilities: ExclusiveCapabilities,
          mcpConfigs,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 detach of a superseded live session preserves replacement MCP credentials",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-superseded-mcp");
        const oldSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const replacementSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId: oldSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId,
          providerSessionId: replacementSessionId,
          modelSelection,
          runtimePolicy,
        });

        const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.isDefined(replacement);
        const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(replacementToken);
        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          replacement?.providerSessionId,
        );

        yield* manager.detach({ providerSessionId: oldSessionId, threadId });

        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          replacement?.providerSessionId,
        );
        assert.equal((yield* registry.resolve(replacementToken!))?.thread.threadId, threadId);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            capabilities: ExclusiveCapabilities,
            mcpConfigs,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a thread's MCP credential stable across detach and re-attach on a shared session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-stable-mcp");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const original = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.isDefined(original);
        const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(originalToken);

        // Workspace-change handoff on a shared multi-thread session (codex):
        // the thread detaches while the provider process keeps running, and the
        // process's MCP client keeps using the credential it was started with.
        yield* manager.detach({ providerSessionId, threadId, detail: "Workspace changed." });
        assert.equal(
          (yield* registry.resolve(originalToken!))?.thread.threadId,
          threadId,
          "detach must not revoke the credential the live provider process still holds",
        );

        // The continuation run re-attaches the same thread to the same session;
        // the credential must be reused, not rotated, so the provider process's
        // long-lived MCP client stays authorized.
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          original?.providerSessionId,
          "re-attach must reuse the existing credential, not rotate it",
        );
        assert.equal((yield* registry.resolve(originalToken!))?.thread.threadId, threadId);

        const secondThreadId = ThreadId.make("shared-session-second-thread");
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now })],
        });
        yield* manager.open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const second = (yield* mcpSessions.read(secondThreadId))!;
        assert.notEqual(second.providerSessionId, original!.providerSessionId);
        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          original!.providerSessionId,
        );
        assert.equal((yield* registry.resolve(originalToken!))?.thread.threadId, threadId);
        assert.equal(
          (yield* registry.resolve(second.authorizationHeader.replace(/^Bearer\s+/, "")))?.thread
            .threadId,
          secondThreadId,
        );

        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* registry.resolve(originalToken!));
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 revokes a rotated credential despite a stale record on another live session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-stale-record");
        const s1 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const s2 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({ threadId, providerSessionId: s1, modelSelection, runtimePolicy });
        yield* manager.detach({ providerSessionId: s1, threadId });

        yield* registry.revokeThread(threadId);
        yield* manager.open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy });
        const rotated = yield* mcpSessions.read(threadId);
        assert.isDefined(rotated);
        const rotatedToken = rotated?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(yield* registry.resolve(rotatedToken!));

        yield* manager.close(s2);
        assert.isUndefined(
          yield* registry.resolve(rotatedToken!),
          "stale record on S1 must not veto revoking S2's rotated credential",
        );
        yield* manager.close(s1);
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1_000, mcpConfigs })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 protects a replacement credential from a predecessor release during open",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const duringOpen = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-open-race");
        const s1 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const s2 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({ threadId, providerSessionId: s1, modelSelection, runtimePolicy });
        const original = (yield* Ref.get(mcpConfigs)).at(-1);
        const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(originalToken);
        yield* manager.detach({ providerSessionId: s1, threadId });

        // While S2's provider process is spawning (after prepare issued its
        // credential, before the entry is visible), the predecessor session
        // releases. Eager adapters (ACP, OpenCode) bake the credential into
        // the process during openSession, so the release must not revoke it;
        // rotating afterwards cannot repair those adapters.
        yield* Ref.set(duringOpen, manager.close(s1).pipe(Effect.orDie));
        yield* manager.open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy });

        const slot = yield* mcpSessions.read(threadId);
        const launched = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.notEqual(slot?.providerSessionId, original?.providerSessionId);
        assert.equal(
          slot?.providerSessionId,
          launched?.providerSessionId,
          "the credential the adapter was configured with must remain current",
        );
        assert.isUndefined(yield* registry.resolve(originalToken!));
        assert.equal(
          (yield* registry.resolve(launched!.authorizationHeader.replace(/^Bearer\s+/, "")))?.thread
            .threadId,
          threadId,
          "the predecessor release must not revoke the replacement's launch credential",
        );
        yield* manager.close(s2);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            beforeOpen: (input) =>
              input.providerSessionId === undefined
                ? Effect.void
                : Ref.get(duringOpen).pipe(
                    Effect.flatten,
                    Effect.tap(() => Ref.set(duringOpen, Effect.void)),
                  ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 terminal detach revokes the thread's MCP credential", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-terminal-detach");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const issued = (yield* Ref.get(mcpConfigs)).at(-1);
      const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(yield* registry.resolve(token!));

      yield* manager.detach({
        providerSessionId,
        threadId,
        detail: "Thread deleted.",
        revokeMcpCredential: true,
      });
      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(yield* mcpSessions.read(threadId));
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1_000, mcpConfigs })));
  }),
);

it.effect("ProviderSessionManagerV2 releases idle sessions without sweeping all sessions", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-idle",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-idle",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* TestClock.adjust("1 second");
      yield* eventSink.stream({ threadId }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "provider-session.updated" && event.payload.status === "stopped",
        ),
        Stream.take(1),
        Stream.runDrain,
      );

      const liveSession = yield* manager.get(providerSessionId);
      const runtimeState = yield* Ref.get(state);
      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.isTrue(Option.isNone(liveSession));
      assert.equal(runtimeState.openCount, 1);
      assert.equal(runtimeState.closeCount, 1);
      assert.equal(projection.providerSessions.at(-1)?.status, "stopped");
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect("ProviderSessionManagerV2 persists release when session scope close hangs", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-hung-close",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-hung-close",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.providerSessions.at(-1)?.status, "stopped");
      assert.equal((yield* Ref.get(state)).closeCount, 0);
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 1000, hangSessionScopeClose: true })),
    );
  }),
);

const openSessionWithBackgroundCommand = (fixtureName: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const now = yield* DateTime.now;
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName,
      projectId: yield* idAllocator.allocate.project({ fixtureName }),
    });
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId,
    });
    const otherProviderSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId,
    });
    const pendingBackgroundTasks = [
      { taskId: "dev-server", kind: "command", description: "python3 -m http.server" },
    ] as const;
    const providerThreads = [
      {
        ...makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
        pendingBackgroundTasks,
      },
      {
        ...makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId: otherProviderSessionId,
          now,
          nativeThreadId: "native-thread-other-session",
        }),
        pendingBackgroundTasks,
      },
    ];
    const writeProviderThread = (payload: OrchestrationV2ProviderThread) =>
      Effect.gen(function* () {
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload,
            },
          ],
        });
      });
    yield* eventSink.write({
      events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
    });
    yield* Effect.forEach(providerThreads, writeProviderThread);
    yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
    const rosters = Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const projection = yield* projectionStore.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: providerThreads.map((p) => p.id),
      });
      return providerThreads.map((seeded) =>
        (
          projection.providerThreads.find((thread) => thread.id === seeded.id)
            ?.pendingBackgroundTasks ?? []
        ).map((task) => task.taskId),
      );
    });
    return { threadId, providerSessionId, providerThreads, writeProviderThread, rosters };
  });

it.effect(
  "ProviderSessionManagerV2 clears the background roster of a session a detach releases",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const { threadId, providerSessionId, providerThreads, rosters } =
          yield* openSessionWithBackgroundCommand("provider-session-manager-detach-roster");
        assert.deepStrictEqual(yield* rosters, [["dev-server"], ["dev-server"]]);
        yield* seedUnreadProviderHistory(providerThreads[0]!.id);

        yield* manager.detach({ providerSessionId, threadId, detail: "Thread settled." });

        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.deepStrictEqual(yield* rosters, [[], ["dev-server"]]);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, capabilities: ExclusiveCapabilities }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 checks liveness without delaying idle release", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const { providerSessionId } = yield* openSessionWithBackgroundCommand(
        "provider-session-manager-is-live",
      );
      yield* TestClock.adjust("600 millis");
      assert.isTrue(yield* manager.isLive(providerSessionId));
      yield* TestClock.adjust("600 millis");
      yield* Effect.yieldNow;
      assert.isFalse(yield* manager.isLive(providerSessionId));
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect.each([
  { name: "shared", capabilities: CodexCapabilities },
  { name: "exclusive", capabilities: ExclusiveCapabilities },
])(
  "ProviderSessionManagerV2 runtime polling does not keep an idle $name session alive",
  ({ capabilities }) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const { providerSessionId } = yield* openSessionWithBackgroundCommand(
          "provider-session-manager-polled-runtime",
        );
        yield* TestClock.adjust("600 millis");
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        yield* TestClock.adjust("600 millis");
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000, capabilities })));
    }),
);

it.effect("ProviderSessionManagerV2 clears the background roster of an idle-released session", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const { threadId, providerSessionId, providerThreads, rosters } =
        yield* openSessionWithBackgroundCommand("provider-session-manager-idle-roster");
      assert.deepStrictEqual(yield* rosters, [["dev-server"], ["dev-server"]]);

      yield* TestClock.adjust("1 second");
      yield* eventSink.stream({ threadId }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "provider-thread.updated" &&
            event.payload.id === providerThreads[0]!.id &&
            event.payload.pendingBackgroundTasks?.length === 0,
        ),
        Stream.take(1),
        Stream.runDrain,
      );

      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.deepStrictEqual(yield* rosters, [[], ["dev-server"]]);
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect("ProviderSessionManagerV2 keeps the roster of a runtime whose tasks can outlive it", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const { providerSessionId, rosters } = yield* openSessionWithBackgroundCommand(
        "provider-session-manager-outliving-roster",
      );

      yield* manager.close(providerSessionId);

      assert.deepStrictEqual(yield* rosters, [["dev-server"], ["dev-server"]]);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({ state, idleTimeoutMs: 60_000, backgroundTasksEndWithProcess: false }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps background tasks a replacement reports during release",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const scopeCloseReached = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const { providerSessionId, providerThreads, writeProviderThread, rosters } =
          yield* openSessionWithBackgroundCommand("provider-session-manager-replacement-roster");
        const release = yield* manager.close(providerSessionId).pipe(Effect.forkChild);

        yield* Deferred.await(scopeCloseReached);
        yield* writeProviderThread({
          ...providerThreads[0]!,
          pendingBackgroundTasks: [
            ...providerThreads[0]!.pendingBackgroundTasks,
            { taskId: "replacement-task", kind: "command" },
          ],
        });
        yield* TestClock.adjust("30 seconds");
        yield* Fiber.join(release);

        assert.deepStrictEqual(yield* rosters, [["replacement-task"], ["dev-server"]]);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            hangSessionScopeClose: true,
            scopeCloseReached,
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 keeps a provider update that lands while release clears", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const beforeUnchangedWrite = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const effect = Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const { providerSessionId, providerThreads, writeProviderThread, rosters } =
        yield* openSessionWithBackgroundCommand("provider-session-manager-raced-roster");
      const seeded = providerThreads[0]!;
      yield* Ref.set(
        beforeUnchangedWrite,
        writeProviderThread({
          ...seeded,
          pendingBackgroundTasks: [
            ...seeded.pendingBackgroundTasks,
            { taskId: "replacement-task", kind: "command" },
          ],
        }).pipe(Effect.orDie),
      );

      yield* manager.close(providerSessionId);

      assert.deepStrictEqual(yield* rosters, [["replacement-task"], ["dev-server"]]);
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, beforeUnchangedWrite })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 defers idle release while background work is pending", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const pendingWork = yield* Ref.make(true);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-idle-pin",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-idle-pin",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* TestClock.adjust("3 seconds");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 0);

      yield* Ref.set(pendingWork, false);
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          backgroundTasksEndWithProcess: true,
          hasPendingBackgroundWork: Ref.get(pendingWork),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 releases pinned idle sessions once the pin cap expires", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-pin-cap",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-pin-cap",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* TestClock.adjust("3 seconds");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          maxIdlePinMs: 3000,
          hasPendingBackgroundWork: Effect.succeed(true),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 keeps pinned work that reports progress", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-pin-progress",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-pin-progress",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);
      const step = (duration: Parameters<typeof TestClock.adjust>[0]) =>
        Effect.gen(function* () {
          yield* TestClock.adjust(duration);
          for (let i = 0; i < 20; i += 1) yield* Effect.yieldNow;
        });

      for (let tick = 0; tick < 12; tick += 1) {
        yield* step("1500 millis");
        yield* Queue.offer(adapterQueue!, {
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: runtime.providerSession,
        });
        for (let i = 0; i < 20; i += 1) yield* Effect.yieldNow;
      }
      assert.equal((yield* Ref.get(state)).closeCount, 0);

      for (let tick = 0; tick < 6; tick += 1) {
        yield* step("1 second");
      }
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          maxIdlePinMs: 3000,
          hasPendingBackgroundWork: Effect.succeed(true),
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 does not idle-release a session that turns busy during the pending-work check",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const firstCheck = yield* Ref.make(true);
      const checkEntered = yield* Deferred.make<void>();
      const checkGate = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-busy-during-check",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-busy-during-check",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = idAllocator.derive.rootNode({ runId });
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn-busy-during-check",
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;

        yield* TestClock.adjust("1 second");
        yield* Deferred.await(checkEntered);

        const turnFiber = yield* runtime
          .startTurn({
            appThread,
            threadId,
            runId,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId,
            rootNodeId,
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
              text: "hello",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkDetach);
        for (let i = 0; i < 10; i += 1) {
          yield* Effect.yieldNow;
        }
        yield* Deferred.succeed(checkGate, undefined);
        yield* Fiber.join(turnFiber);
        yield* Effect.yieldNow;

        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: providerThread.id,
          providerTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            hasPendingBackgroundWork: Effect.uninterruptible(
              Effect.gen(function* () {
                if (yield* Ref.getAndSet(firstCheck, false)) {
                  yield* Deferred.succeed(checkEntered, undefined);
                  yield* Deferred.await(checkGate);
                }
                return false;
              }),
            ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 does not apply a stale idle pin to a replacement session", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const firstCheck = yield* Ref.make(true);
    const checkEntered = yield* Deferred.make<void>();
    const checkGate = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-stale-pin",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-stale-pin",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* TestClock.adjust("1 second");
      yield* Deferred.await(checkEntered);

      const closeFiber = yield* manager.close(providerSessionId).pipe(Effect.forkDetach);
      for (let i = 0; i < 20; i += 1) {
        yield* Effect.yieldNow;
      }
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      assert.equal((yield* Ref.get(state)).openCount, 2);

      yield* Deferred.succeed(checkGate, undefined);
      yield* Fiber.join(closeFiber);
      for (let i = 0; i < 10; i += 1) {
        yield* Effect.yieldNow;
      }

      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          maxIdlePinMs: 60_000,
          hasPendingBackgroundWork: Effect.uninterruptible(
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(firstCheck, false)) {
                yield* Deferred.succeed(checkEntered, undefined);
                yield* Deferred.await(checkGate);
                return true;
              }
              return false;
            }),
          ),
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps active sessions alive until the provider turn terminates",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-active",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-active",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = idAllocator.derive.rootNode({ runId });
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn",
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;
        yield* runtime.startTurn({
          appThread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId,
          rootNodeId,
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });

        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: providerThread.id,
          providerTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        const liveSession = yield* manager.get(providerSessionId);
        const projection = yield* projectionStore.getThreadProjection(threadId);
        assert.isTrue(Option.isNone(liveSession));
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        assert.equal(projection.providerSessions.at(-1)?.status, "stopped");
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect("ProviderSessionManagerV2 uses the same release path for runtime failures", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-runtime-error",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-runtime-error",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.release({
        providerSessionId,
        reason: "runtime_error",
        detail: "process exited",
      });

      const liveSession = yield* manager.get(providerSessionId);
      const runtimeState = yield* Ref.get(state);
      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.isTrue(Option.isNone(liveSession));
      assert.equal(runtimeState.closeCount, 1);
      assert.equal(projection.providerSessions.at(-1)?.status, "error");
      assert.equal(projection.providerSessions.at(-1)?.lastError, "process exited");
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect("ProviderSessionManagerV2 releases sessions when provider event streams fail", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-stream-error",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-stream-error",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      // The stream reports failure before releaseEntry persists the error status.
      const persistedError = yield* eventSink.stream({ threadId }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "provider-session.updated" &&
            event.payload.id === providerSessionId &&
            event.payload.status === "error",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.events.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      yield* Fiber.join(persistedError);

      const liveSession = yield* manager.get(providerSessionId);
      const runtimeState = yield* Ref.get(state);
      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.isTrue(Option.isNone(liveSession));
      assert.equal(runtimeState.closeCount, 1);
      assert.equal(projection.providerSessions.at(-1)?.status, "error");
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          failEventStream: true,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 marks pending runtime requests non-live on release", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-request-expire",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-request-expire",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      yield* eventSink.write({ events: pendingRequest.events });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.release({
        providerSessionId,
        reason: "runtime_error",
        detail: "process exited",
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.at(-1);
      const requestNode = projection.nodes.find((node) => node.id === request?.nodeId);
      const requestTurnItem = projection.turnItems.find(
        (item) => item.type === "approval_request" && item.requestId === request?.id,
      );

      assert.equal(request?.status, "expired");
      assert.equal(request?.responseCapability.type, "not_resumable");
      assert.equal(requestNode?.status, "failed");
      assert.equal(requestTurnItem?.status, "failed");
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);
it.effect("ProviderSessionManagerV2 protects compaction from idle unloading", () =>
  runIdleThreadUnloadScenario("compact-idle-unload", ({ state, threadA, startTurn, endTurn }) =>
    Effect.gen(function* () {
      yield* startTurn(threadA, 1, { compact: true });
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
      yield* endTurn(threadA, 1);
      yield* TestClock.adjust("1 second");
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
    }),
  ),
);

it.effect("ProviderSessionManagerV2 retries release records that failed to persist", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const flaky: FlakyReleaseWrites = {
      failing: yield* Ref.make<"none" | "session" | "session-and-requests">("session"),
      failures: yield* Queue.unbounded<void>(),
    };
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-release-retry");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      yield* eventSink.write({ events: pendingRequest.events });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

      assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.close(providerSessionId))));
      yield* Queue.take(flaky.failures);
      const afterClose = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(afterClose.runtimeRequests.at(-1)?.responseCapability.type, "not_resumable");
      assert.equal(afterClose.providerSessions.at(-1)?.status, "ready");

      yield* TestClock.adjust("1 second");
      yield* Queue.take(flaky.failures);
      yield* Ref.set(flaky.failing, "none");
      const stopped = yield* eventSink
        .stream({
          threadId,
          afterSequence: yield* eventSink.latestSequence({ threadId }),
          eventType: "provider-session.updated",
        })
        .pipe(Stream.runHead, Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(stopped);

      const afterRetry = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(afterRetry.providerSessions.at(-1)?.status, "stopped");
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 release retries leave a replacement session alone", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const flaky: FlakyReleaseWrites = {
      failing: yield* Ref.make<"none" | "session" | "session-and-requests">("none"),
      failures: yield* Queue.unbounded<void>(),
    };
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread-provider-session-manager-release-replacement");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const writePendingRequest = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const request = yield* makePendingRuntimeRequestEvents({
          idAllocator,
          threadId,
          providerSessionId,
          providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
          now,
        });
        yield* eventSink.write({ events: request.events });
        return request.requestId;
      });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId, now: yield* DateTime.now }),
        ],
      });
      const oldRequestId = yield* writePendingRequest;
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      yield* Ref.set(flaky.failing, "session-and-requests");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.close(providerSessionId))));
      yield* Queue.take(flaky.failures);
      yield* Queue.take(flaky.failures);
      yield* Ref.set(flaky.failing, "none");

      yield* TestClock.adjust("500 millis");
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const newRequestId = yield* writePendingRequest;
      const replacementStatus = (yield* projectionStore.getThreadProjection(
        threadId,
      )).providerSessions.at(-1)?.status;
      const settled = yield* eventSink
        .stream({
          threadId,
          afterSequence: yield* eventSink.latestSequence({ threadId }),
          eventType: "runtime-request.updated",
        })
        .pipe(Stream.runHead, Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(settled);

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = (id: typeof oldRequestId) =>
        projection.runtimeRequests.find((candidate) => candidate.id === id);
      assert.equal(request(oldRequestId)?.responseCapability.type, "not_resumable");
      assert.equal(request(newRequestId)?.responseCapability.type, "live");
      assert.equal(projection.providerSessions.at(-1)?.status, replacementStatus);
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 keeps each failed release's cleanup", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const flaky: FlakyReleaseWrites = {
      failing: yield* Ref.make<"none" | "session" | "session-and-requests">("none"),
      failures: yield* Queue.unbounded<void>(),
    };
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-release-each-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-release-each-b");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      const secondThreadRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId: secondThreadId,
        providerSessionId,
        providerThread: makeProviderThread({
          idAllocator,
          threadId: secondThreadId,
          providerSessionId,
          now,
        }),
        now,
      });
      yield* eventSink.write({ events: secondThreadRequest.events });
      const failRelease = (failedWrites: number) =>
        Effect.gen(function* () {
          yield* Ref.set(flaky.failing, "session-and-requests");
          assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.close(providerSessionId))));
          yield* Effect.repeat(Queue.take(flaky.failures), { times: failedWrites - 1 });
          yield* Ref.set(flaky.failing, "none");
        });

      yield* manager.open({
        threadId: firstThreadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({
        threadId: secondThreadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* failRelease(2);
      yield* TestClock.adjust("500 millis");
      yield* manager.open({
        threadId: firstThreadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* failRelease(1);

      const settled = yield* eventSink
        .stream({
          threadId: secondThreadId,
          afterSequence: yield* eventSink.latestSequence({ threadId: secondThreadId }),
          eventType: "runtime-request.updated",
        })
        .pipe(Stream.runHead, Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(settled);

      const projection = yield* projectionStore.getThreadProjection(secondThreadId);
      assert.equal(projection.runtimeRequests.at(-1)?.responseCapability.type, "not_resumable");
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 settles a request the event pump persists during release", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const flaky: FlakyReleaseWrites = {
      failing: yield* Ref.make<"none" | "session" | "session-and-requests">("none"),
      failures: yield* Queue.unbounded<void>(),
      pauseRequestWrites: {
        paused: yield* Deferred.make<void>(),
        resume: yield* Deferred.make<void>(),
      },
    };
    const pause = flaky.pauseRequestWrites!;
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-release-pump");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const createdAt = DateTime.add(now, { seconds: 1 });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread: makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now: createdAt,
        }),
        now: createdAt,
      });
      const adapterEvents = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterEvents);
      yield* Queue.offerAll(adapterEvents!, pendingRequest.providerEvents);
      yield* Deferred.await(pause.paused);
      const closed = yield* manager
        .close(providerSessionId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(pause.resume, undefined);
      yield* Fiber.join(closed);

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.find(
        (candidate) => candidate.id === pendingRequest.requestId,
      );
      assert.equal(request?.responseCapability.type, "not_resumable");
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 terminalizes a pending input transcript item on release", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-request-expire",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-request-expire",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      yield* eventSink.write({
        events: pendingRequest.events.map((event) =>
          event.type === "turn-item.updated"
            ? { ...event, payload: { ...event.payload, type: "user_input_request", questions: [] } }
            : event,
        ),
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.release({
        providerSessionId,
        reason: "runtime_error",
        detail: "process exited",
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.at(-1);
      const requestNode = projection.nodes.find((node) => node.id === request?.nodeId);
      const requestTurnItem = projection.turnItems.find(
        (item) => item.type === "user_input_request" && item.requestId === request?.id,
      );

      assert.equal(request?.status, "expired");
      assert.equal(request?.responseCapability.type, "not_resumable");
      assert.equal(requestNode?.status, "failed");
      assert.equal(requestTurnItem?.status, "failed");
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect("ProviderSessionManagerV2 persists session-scoped runtime requests without a run", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-session-request",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-session-request",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      const afterSequence = yield* eventSink.latestSequence({ threadId });
      const persistedFiber = yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "runtime-request.updated" ||
            stored.event.type === "node.updated" ||
            stored.event.type === "turn-item.updated",
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const adapterEvents = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterEvents);
      yield* Queue.offerAll(adapterEvents!, pendingRequest.providerEvents);
      const persisted = Array.from(yield* Fiber.join(persistedFiber));

      assert.sameMembers(
        persisted.map((stored) => stored.event.type),
        ["runtime-request.updated", "node.updated", "turn-item.updated"],
      );
      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.find(
        (candidate) => candidate.id === pendingRequest.requestId,
      );
      const node = projection.nodes.find((candidate) => candidate.id === pendingRequest.nodeId);
      const turnItem = projection.turnItems.find(
        (candidate) =>
          candidate.type === "approval_request" && candidate.requestId === pendingRequest.requestId,
      );
      assert.equal(request?.status, "pending");
      assert.equal(request?.providerTurnId, null);
      assert.equal(node?.runId, null);
      assert.equal(node?.status, "waiting");
      assert.equal(turnItem?.runId, null);
      assert.equal(turnItem?.status, "waiting");
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 preserves item identity during eager native session activation",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-request-expire",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-request-expire",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* eventSink.write({
          events: (yield* makePendingRuntimeRequestEvents({
            idAllocator,
            threadId,
            providerSessionId,
            providerThread,
            now,
          })).events,
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          initialNativeThreadId: "native-import",
          initialProviderItemIdentityVersion: 2,
        });
        yield* manager.release({
          providerSessionId,
          reason: "runtime_error",
          detail: "process exited",
        });

        const projection = yield* projectionStore.getThreadProjection(threadId);
        const request = projection.runtimeRequests.at(-1);
        const requestNode = projection.nodes.find((node) => node.id === request?.nodeId);
        const requestTurnItem = projection.turnItems.find(
          (item) => item.type === "approval_request" && item.requestId === request?.id,
        );

        assert.equal(request?.status, "expired");
        assert.equal(request?.responseCapability.type, "not_resumable");
        assert.equal(requestNode?.status, "failed");
        assert.equal(requestTurnItem?.status, "failed");
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            beforeOpen: (input) =>
              Effect.sync(() => assert.equal(input.initialProviderItemIdentityVersion, 2)),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a multi-thread session alive until all turns finish",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-multi-thread-active",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-multi-thread-active-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-multi-thread-active-b",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: firstThreadId,
        });
        const firstProviderThread = makeProviderThread({
          idAllocator,
          threadId: firstThreadId,
          providerSessionId,
          now,
          nativeThreadId: "native-thread-a",
        });
        const secondProviderThread = makeProviderThread({
          idAllocator,
          threadId: secondThreadId,
          providerSessionId,
          now,
          nativeThreadId: "native-thread-b",
        });
        const firstRunId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
        const secondRunId = idAllocator.derive.run({ threadId: secondThreadId, ordinal: 1 });
        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn-a",
        });
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn-b",
        });

        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const firstAppThread = (yield* projectionStore.getThreadProjection(firstThreadId)).thread;
        const secondAppThread = (yield* projectionStore.getThreadProjection(secondThreadId)).thread;
        yield* runtime.startTurn({
          appThread: firstAppThread,
          threadId: firstThreadId,
          runId: firstRunId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId: firstRunId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId: firstRunId }),
          providerThread: firstProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId: firstThreadId, ordinal: 1 }),
            text: "first",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn({
          appThread: secondAppThread,
          threadId: secondThreadId,
          runId: secondRunId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId: secondRunId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId: secondRunId }),
          providerThread: secondProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({
              threadId: secondThreadId,
              ordinal: 1,
            }),
            text: "second",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });

        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: firstProviderThread.id,
          providerTurnId: firstProviderTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: secondProviderThread.id,
          providerTurnId: secondProviderTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 opens one shared runtime, broadcasts events, and detaches threads independently",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-shared-runtime",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-shared-runtime-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-shared-runtime-b",
          projectId,
        });
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });

        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
          ],
        });
        const firstProviderThread = makeProviderThread({
          idAllocator,
          threadId: firstThreadId,
          providerSessionId,
          now,
          nativeThreadId: "shared-runtime-first",
        });
        const secondProviderThread = makeProviderThread({
          idAllocator,
          threadId: secondThreadId,
          providerSessionId,
          now,
          nativeThreadId: "shared-runtime-second",
        });
        const firstRunId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-thread.updated",
              threadId: firstThreadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: firstProviderThread,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-turn.updated",
              threadId: firstThreadId,
              runId: firstRunId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: {
                id: idAllocator.derive.providerTurn({
                  driver: CODEX_DRIVER,
                  nativeTurnId: "native-turn-shared-runtime-a",
                }),
                providerThreadId: firstProviderThread.id,
                nodeId: idAllocator.derive.rootNode({ runId: firstRunId }),
                runAttemptId: null,
                nativeTurnRef: null,
                ordinal: 1,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            },
          ],
        });
        const firstRuntime = yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const secondRuntime = yield* manager.open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        assert.strictEqual(firstRuntime, secondRuntime);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        const resumeSecondThread = secondRuntime.resumeThread({
          providerThread: secondProviderThread,
          threadId: secondThreadId,
          modelSelection,
          runtimePolicy,
        });
        yield* resumeSecondThread;
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 1);
        yield* secondRuntime.resumeThread({
          providerThread: secondProviderThread,
          threadId: secondThreadId,
          modelSelection: { ...modelSelection, model: "gpt-5.4-mini" },
          runtimePolicy,
        });
        assert.equal((yield* Ref.get(state)).resumeCount, 2);
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 3);
        const subscribe = firstRuntime.subscribeEvents;
        assert.isDefined(subscribe);
        if (subscribe === undefined) return;
        const firstSubscription = yield* subscribe;
        const secondSubscription = yield* subscribe;
        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: firstRuntime.providerSession,
        });
        const received = yield* Effect.all([
          firstSubscription.events.pipe(Stream.runHead),
          secondSubscription.events.pipe(Stream.runHead),
        ]);
        assert.isTrue(received.every(Option.isSome));
        assert.isTrue(
          received.every(
            (event) => Option.isSome(event) && event.value.type === "provider_session.updated",
          ),
        );

        yield* manager.detach({ providerSessionId, threadId: secondThreadId });
        yield* manager.open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 4);

        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
          "shared-runtime-second",
        ]);

        yield* manager.detach({ providerSessionId, threadId: firstThreadId });
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.equal((yield* Ref.get(state)).interruptCount, 1);
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
          "shared-runtime-second",
          "shared-runtime-first",
        ]);

        yield* manager.detach({ providerSessionId, threadId: secondThreadId });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 invalidates only errored threads and keeps reusable session errors cached",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const openCachedRuntime = Effect.fnUntraced(function* (
          threadId: ThreadId,
          sharedSessionId?: ProviderSessionId,
        ) {
          const providerSessionId =
            sharedSessionId ??
            (yield* idAllocator.allocate.providerSession({
              providerInstanceId: modelSelection.instanceId,
              threadId,
            }));
          yield* eventSink.write({
            events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
          });
          const runtime = yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          const providerThread = makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: String(threadId),
          });
          const resume = runtime.resumeThread({
            providerThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });
          yield* resume;
          yield* resume;
          return { runtime, providerThread, resume };
        });
        const failed = yield* openCachedRuntime(ThreadId.make("idle-failed-runtime"));
        const healthy = yield* openCachedRuntime(ThreadId.make("idle-healthy-runtime"));
        const sibling = yield* openCachedRuntime(
          ThreadId.make("idle-healthy-sibling"),
          failed.runtime.providerSessionId,
        );
        assert.strictEqual(sibling.runtime, failed.runtime);
        assert.equal((yield* Ref.get(state)).openCount, 2);
        assert.equal((yield* Ref.get(state)).resumeCount, 3);

        const queue = (yield* Ref.get(state)).eventQueues.get(
          String(failed.runtime.providerSessionId),
        );
        assert.isDefined(queue);
        const publish = Effect.fnUntraced(function* (
          event: ProviderAdapter.ProviderAdapterV2Event,
        ) {
          const subscription = yield* failed.runtime.subscribeEvents!;
          yield* Queue.offer(queue!, event);
          // Observing the exact event ensures the manager has handled it before resuming.
          assert.deepEqual(yield* subscription.events.pipe(Stream.runHead), Option.some(event));
        });
        const countRawResumes = Effect.fnUntraced(function* (cached: typeof failed) {
          const before = (yield* Ref.get(state)).resumeCount;
          yield* cached.resume;
          return (yield* Ref.get(state)).resumeCount - before;
        });
        yield* publish({
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread: failed.providerThread,
        });
        yield* publish({
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: {
            ...failed.runtime.providerSession,
            status: "error",
            lastError: "Reusable turn failure",
          },
        });
        const afterSessionError = {
          reusableThread: yield* countRawResumes(failed),
          siblingThread: yield* countRawResumes(sibling),
        };

        yield* publish({
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread: { ...failed.providerThread, status: "error" },
        });
        const afterThreadError = {
          healthyRuntime: yield* countRawResumes(healthy),
          siblingThread: yield* countRawResumes(sibling),
          failedThread: yield* countRawResumes(failed),
          failedThreadAgain: yield* countRawResumes(failed),
        };
        assert.deepEqual(
          { afterSessionError, afterThreadError },
          {
            afterSessionError: { reusableThread: 0, siblingThread: 0 },
            afterThreadError: {
              healthyRuntime: 0,
              siblingThread: 0,
              failedThread: 1,
              failedThreadAgain: 0,
            },
          },
        );
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 re-attaching a thread waits for its in-flight unload, then reloads it",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const unloadStarted = yield* Deferred.make<void>();
      const releaseUnload = yield* Deferred.make<void>();
      let resumesBeforeUnload: number | undefined;
      const beforeUnload = Effect.gen(function* () {
        yield* Deferred.succeed(unloadStarted, undefined);
        yield* Deferred.await(releaseUnload);
        resumesBeforeUnload = (yield* Ref.get(state)).resumeCount;
      });
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-unload-race",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-unload-race-a",
          projectId,
        });
        const otherThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-unload-race-b",
          projectId,
        });
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: otherThreadId, now }),
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: providerThread,
            },
          ],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: otherThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const resume = runtime.resumeThread({
          providerThread,
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* resume;

        const detach = yield* manager
          .detach({ providerSessionId, threadId })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(unloadStarted);
        const reattach = yield* resume.pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseUnload, undefined);
        yield* Fiber.join(detach);
        yield* Fiber.join(reattach);

        assert.equal(resumesBeforeUnload, 1);
        assert.equal((yield* Ref.get(state)).resumeCount, 2);
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["native-thread"]);
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      });

      yield* effect.pipe(
        Effect.provide(layerTest({ state, idleTimeoutMs: 1000, beforeUnload })),
        Effect.scoped,
      );
    }),
);

function runIdleThreadUnloadScenario(
  name: string,
  scenario: (input: {
    readonly state: Ref.Ref<TestProviderRuntimeState>;
    readonly manager: ProviderSessionManager.ProviderSessionManagerV2Shape;
    readonly providerSessionId: ProviderSessionId;
    readonly threadA: ThreadId;
    readonly threadB: ThreadId;
    readonly startTurn: (
      threadId: ThreadId,
      ordinal: number,
      options?: { resume?: boolean; compact?: boolean },
    ) => Effect.Effect<void>;
    readonly endTurn: (threadId: ThreadId, ordinal: number) => Effect.Effect<void>;
    readonly resume: (threadId: ThreadId) => Effect.Effect<void>;
    readonly setRunStatus: (
      status: "preparing" | "queued" | "starting" | "running" | "waiting" | "completed",
    ) => Effect.Effect<void>;
    readonly subscribe: NonNullable<
      ProviderAdapter.ProviderAdapterV2SessionRuntime["subscribeEvents"]
    >;
  }) => Effect.Effect<void, ProviderSessionManager.ProviderSessionManagerV2Error, Scope.Scope>,
  options: {
    readonly hasPendingBackgroundWorkForThread?: Effect.Effect<boolean>;
    readonly beforeUnload?: Effect.Effect<void>;
    readonly idleTimeoutMs?: number | null;
    readonly afterResume?: Effect.Effect<void>;
  } = {},
) {
  return Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadA = ThreadId.make(`thread-provider-session-manager-${name}-a`);
      const threadB = ThreadId.make(`thread-provider-session-manager-${name}-b`);
      const providerSessionId = idAllocator.derive.providerSession({
        providerInstanceId: modelSelection.instanceId,
      });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: threadA, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: threadB, now }),
        ],
      });
      const runtime = yield* manager.open({
        threadId: threadA,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({ threadId: threadB, providerSessionId, modelSelection, runtimePolicy });
      const providerThreadOf = (threadId: ThreadId) =>
        makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
          nativeThreadId: `native-${threadId}`,
        });
      const resume = (threadId: ThreadId) =>
        runtime
          .resumeThread({
            providerThread: providerThreadOf(threadId),
            threadId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.asVoid, Effect.orDie);
      const startTurn = (
        threadId: ThreadId,
        ordinal: number,
        options?: { resume?: boolean; compact?: boolean },
      ) =>
        Effect.gen(function* () {
          if (options?.resume !== false) yield* resume(threadId);
          const runId = idAllocator.derive.run({ threadId, ordinal });
          yield* (options?.compact ? runtime.compactThread! : runtime.startTurn)({
            appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
            threadId,
            runId,
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
            rootNodeId: idAllocator.derive.rootNode({ runId }),
            providerThread: providerThreadOf(threadId),
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal }),
              text: "turn",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          });
        }).pipe(Effect.orDie);
      const setRunStatus = Effect.fn("test.setRunStatus")(function* (
        status: "preparing" | "queued" | "starting" | "running" | "waiting" | "completed",
      ) {
        const threadId = threadA;
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: providerThreadOf(threadId),
            },
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId: modelSelection.instanceId,
                modelSelection,
                providerThreadId: providerThreadOf(threadId).id,
                userMessageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
                rootNodeId: idAllocator.derive.rootNode({ runId }),
                activeAttemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
                status,
                requestedAt: now,
                startedAt: null,
                completedAt: status === "completed" ? now : null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
      }, Effect.orDie);
      const subscribe = runtime.subscribeEvents;
      assert.isDefined(subscribe);
      const endTurn = (threadId: ThreadId, ordinal: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const subscription = yield* Effect.acquireRelease(subscribe!, (sub) => sub.close);
            const received = yield* subscription.events.pipe(
              Stream.filter((event) => event.type === "turn.terminal"),
              Stream.runHead,
              Effect.forkScoped,
            );
            const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
            assert.isDefined(queue);
            yield* Queue.offer(queue!, {
              type: "turn.terminal",
              driver: CODEX_DRIVER,
              providerThreadId: providerThreadOf(threadId).id,
              providerTurnId: idAllocator.derive.providerTurn({
                driver: CODEX_DRIVER,
                nativeTurnId: `native-turn-${threadId}-${ordinal}`,
              }),
              runOrdinal: ordinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(received);
          }),
        ).pipe(Effect.orDie);

      yield* startTurn(threadB, 1);
      yield* scenario({
        state,
        manager,
        providerSessionId,
        threadA,
        threadB,
        startTurn,
        endTurn,
        resume,
        subscribe: subscribe!,
        setRunStatus,
      }).pipe(Effect.scoped);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          ...(options.idleTimeoutMs === null
            ? {}
            : { idleTimeoutMs: options.idleTimeoutMs ?? 1000 }),
          ...(options.beforeUnload === undefined ? {} : { beforeUnload: options.beforeUnload }),
          ...(options.afterResume === undefined ? {} : { afterResume: options.afterResume }),
          ...(options.hasPendingBackgroundWorkForThread === undefined
            ? {}
            : { hasPendingBackgroundWorkForThread: options.hasPendingBackgroundWorkForThread }),
        }),
      ),
    );
  });
}

it.effect.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
  "ProviderSessionManagerV2 keeps never-turned native state during %s preparation",
  (status) =>
    runIdleThreadUnloadScenario(
      `pending-${status}`,
      ({ state, threadA, resume, startTurn, endTurn, setRunStatus }) =>
        Effect.gen(function* () {
          yield* setRunStatus(status);
          yield* resume(threadA);
          // TestClock crosses the unload timer while the first native offer is still pending.
          yield* TestClock.adjust("3 seconds");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
          const resumed = (yield* Ref.get(state)).resumeCount;
          yield* startTurn(threadA, 1, { resume: false });
          assert.equal((yield* Ref.get(state)).resumeCount, resumed);
          yield* setRunStatus("completed");
          yield* endTurn(threadA, 1);
          yield* TestClock.adjust("1 second");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
        }),
    ),
);

it.effect(
  "ProviderSessionManagerV2 unloads a shared-runtime thread left idle, and reloads it on its next turn",
  () =>
    runIdleThreadUnloadScenario(
      "idle-unload",
      ({ state, manager, providerSessionId, threadA, startTurn, endTurn, resume }) =>
        Effect.gen(function* () {
          yield* startTurn(threadA, 1);
          assert.equal((yield* Ref.get(state)).resumeCount, 2);
          yield* endTurn(threadA, 1);

          yield* TestClock.adjust("500 millis");
          yield* startTurn(threadA, 2);
          yield* TestClock.adjust("1 second");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);

          yield* endTurn(threadA, 2);
          yield* TestClock.adjust("1 second");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
          assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
          assert.equal((yield* Ref.get(state)).closeCount, 0);

          const resumes = (yield* Ref.get(state)).resumeCount;
          yield* resume(threadA);
          assert.equal((yield* Ref.get(state)).resumeCount, resumes + 1);
        }),
    ),
);

// ardud (9 Nov): a turn that is silent for longer than the idle window (a
// long tool, a long model think) is still a live turn.
it.effect(
  "ProviderSessionManagerV2 never unloads or releases threads whose turns run silently past the idle window",
  () =>
    runIdleThreadUnloadScenario(
      "silent-long-turn",
      ({ state, manager, providerSessionId, threadA, startTurn }) =>
        Effect.gen(function* () {
          yield* startTurn(threadA, 1);
          // Thirty idle windows with no provider events at all.
          for (let tick = 0; tick < 30; tick++) {
            yield* TestClock.adjust("1 second");
            yield* Effect.yieldNow;
          }
          const current = yield* Ref.get(state);
          assert.deepEqual(current.unloadedNativeThreadIds, []);
          assert.equal(current.closeCount, 0);
          assert.equal(current.interruptCount, 0);
          assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        }),
    ),
);

it.effect(
  "ProviderSessionManagerV2 unloading one idle thread leaves another thread's live subscription intact",
  () =>
    runIdleThreadUnloadScenario(
      "unload-isolation",
      ({ state, threadA, threadB, startTurn, endTurn, subscribe }) =>
        Effect.gen(function* () {
          // Thread B's run keeps reading the shared session while A goes idle.
          const subscription = yield* Effect.acquireRelease(subscribe, (sub) => sub.close);
          const terminals = yield* subscription.events.pipe(
            Stream.filter((event) => event.type === "turn.terminal"),
            Stream.take(2),
            Stream.runCollect,
            Effect.exit,
            Effect.forkScoped,
          );
          yield* startTurn(threadA, 1);
          yield* endTurn(threadA, 1);
          yield* TestClock.adjust("1 second");
          yield* Effect.yieldNow;
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
          assert.equal((yield* Ref.get(state)).closeCount, 0);
          // Thread B's turn ends after A was unloaded; B's reader still sees it.
          yield* endTurn(threadB, 1);
          const exit = yield* Fiber.join(terminals);
          assert.isTrue(Exit.isSuccess(exit), "thread B's subscription must not be failed");
          if (Exit.isSuccess(exit)) assert.lengthOf(Array.from(exit.value), 2);
        }),
    ),
);

it.effect("ProviderSessionManagerV2 unloads a thread resumed without starting a turn", () =>
  runIdleThreadUnloadScenario("resume-only-unload", ({ state, threadA, resume, startTurn }) =>
    Effect.gen(function* () {
      yield* resume(threadA);
      yield* TestClock.adjust("1 second");
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
      const resumes = (yield* Ref.get(state)).resumeCount;
      yield* startTurn(threadA, 1, { resume: false });
      assert.equal((yield* Ref.get(state)).resumeCount, resumes + 1);
    }),
  ),
);

it.effect("ProviderSessionManagerV2 retries an idle unload after a transient failure", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    yield* runIdleThreadUnloadScenario(
      "retry-idle-unload",
      ({ state, threadA, startTurn, endTurn }) =>
        Effect.gen(function* () {
          yield* startTurn(threadA, 1);
          yield* endTurn(threadA, 1);
          yield* TestClock.adjust("1 second");
          assert.equal(yield* Ref.get(attempts), 1);
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
          yield* TestClock.adjust("1 second");
          assert.equal(yield* Ref.get(attempts), 2);
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
        }),
      {
        beforeUnload: Ref.updateAndGet(attempts, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 1 ? Effect.die("temporary unload failure") : Effect.void,
          ),
        ),
      },
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps an idle shared-runtime thread loaded while its background work runs",
  () =>
    Effect.gen(function* () {
      const pendingWork = yield* Ref.make(true);
      yield* runIdleThreadUnloadScenario(
        "idle-unload-pinned",
        ({ state, threadA, startTurn, endTurn }) =>
          Effect.gen(function* () {
            yield* startTurn(threadA, 1);
            yield* endTurn(threadA, 1);
            yield* TestClock.adjust("3 seconds");
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);

            yield* Ref.set(pendingWork, false);
            yield* TestClock.adjust("1 second");
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
              `native-${threadA}`,
            ]);
          }),
        { hasPendingBackgroundWorkForThread: Ref.get(pendingWork) },
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 rejects a second thread when the provider runtime is exclusive",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-exclusive-runtime",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-exclusive-runtime-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-exclusive-runtime-b",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: firstThreadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
          ],
        });

        yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const error = yield* manager
          .open({
            threadId: secondThreadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderSessionOpenError");
        assert.equal((yield* Ref.get(state)).openCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 1000, capabilities: ExclusiveCapabilities }),
        ),
      );
    }),
);

it.effect.each(["missing", "file"] as const)(
  "rejects a %s workspace before opening a provider session",
  (workspaceState) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = `${root}/workspace`;
      if (workspaceState === "file") yield* fileSystem.writeFileString(cwd, "not a directory");
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make(`thread-${workspaceState}-workspace`);
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const error = yield* manager
          .open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: { ...runtimePolicy, cwd },
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, ProviderWorkspaceMissingError);
        assert.include(error.message, cwd);
        assert.include(error.message, "Restore the folder at this path before retrying.");
        assert.equal((yield* Ref.get(state)).openCount, 0);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerSessions,
          [],
        );
      }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects a deleted workspace before reusing a live session without changing its state",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = `${root}/workspace`;
      yield* fileSystem.makeDirectory(cwd);
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make("thread-deleted-live-workspace");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const input = {
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: { ...runtimePolicy, cwd },
        };
        const runtime = yield* manager.open(input);
        const before = yield* projectionStore.getThreadProjection(threadId);
        yield* fileSystem.remove(cwd, { recursive: true });
        const error = yield* manager.open(input).pipe(Effect.flip);
        assert.instanceOf(error, ProviderWorkspaceMissingError);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.strictEqual(Option.getOrThrow(yield* manager.get(providerSessionId)), runtime);
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerSessions,
          before.providerSessions,
        );
      }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderSessionManagerV2 applies project device access independently of browser access",
  () =>
    Effect.gen(function* () {
      const enabled = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: false,
        projectOverride: false,
        deviceOverride: true,
      });
      assert.isTrue(enabled?.capabilities?.has("device"));
      assert.isFalse(enabled?.browserToolsAvailable);
      const denied = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: false,
        projectOverride: false,
        deviceOverride: true,
        projectExists: false,
      });
      assert.isFalse(denied?.capabilities?.has("device"));
    }),
);

it.effect("ProviderSessionManagerV2 defaults to a three minute unload window", () =>
  runIdleThreadUnloadScenario(
    "short-default",
    ({ state, threadA, resume }) =>
      Effect.gen(function* () {
        yield* resume(threadA);
        yield* TestClock.adjust("179 seconds");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
        yield* TestClock.adjust("1 second");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
      }),
    { idleTimeoutMs: null },
  ),
);

it.effect("ProviderSessionManagerV2 uses the idle unload environment override", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.ROBOB_PROVIDER_IDLE_UNLOAD_MS;
      process.env.ROBOB_PROVIDER_IDLE_UNLOAD_MS = "2000";
      return previous;
    }),
    () =>
      runIdleThreadUnloadScenario(
        "env-window",
        ({ state, threadA, resume }) =>
          Effect.gen(function* () {
            yield* resume(threadA);
            yield* TestClock.adjust("1 second");
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
            yield* TestClock.adjust("1 second");
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
              `native-${threadA}`,
            ]);
          }),
        { idleTimeoutMs: null },
      ),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.ROBOB_PROVIDER_IDLE_UNLOAD_MS;
        else process.env.ROBOB_PROVIDER_IDLE_UNLOAD_MS = previous;
      }),
  ),
);

it("ProviderSessionManagerV2 rejects invalid unload overrides", () => {
  for (const value of ["", "0", "-1", "NaN", "Infinity", "1.5"]) {
    assert.equal(ProviderSessionManager.providerIdleUnloadMs(value), 180000);
  }
});

it.effect("ProviderSessionManagerV2 unloads a thread whose resume preparation fails", () =>
  Effect.gen(function* () {
    const fail = yield* Ref.make(false);
    yield* runIdleThreadUnloadScenario(
      "failed-preparation",
      ({ state, threadA, resume }) =>
        Effect.gen(function* () {
          yield* Ref.set(fail, true);
          const exit = yield* Effect.exit(resume(threadA));
          assert.isTrue(Exit.isFailure(exit));
          yield* TestClock.adjust("1 second");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
        }),
      {
        afterResume: Ref.get(fail).pipe(
          Effect.flatMap((failed) =>
            failed ? Effect.die("preparation failed after native resume") : Effect.void,
          ),
        ),
      },
    );
  }),
);

it.effect("ProviderSessionManagerV2 unloads a thread whose resume preparation is cancelled", () =>
  Effect.gen(function* () {
    const block = yield* Ref.make(false);
    const loaded = yield* Deferred.make<void>();
    yield* runIdleThreadUnloadScenario(
      "cancelled-preparation",
      ({ state, threadA, resume }) =>
        Effect.gen(function* () {
          yield* Ref.set(block, true);
          const fiber = yield* resume(threadA).pipe(Effect.forkChild);
          yield* Deferred.await(loaded);
          yield* Fiber.interrupt(fiber);
          yield* TestClock.adjust("1 second");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
        }),
      {
        afterResume: Ref.get(block).pipe(
          Effect.flatMap((blocked) =>
            blocked
              ? Deferred.succeed(loaded, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
          ),
        ),
      },
    );
  }),
);

it.effect.each([false, true])(
  "ProviderSessionManagerV2 unloads the superseded native ID while its replacement turn remains busy (resume fails: %s)",
  (resumeFails) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const failNextResume = yield* Ref.make(false);
      const effect = Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state, 2);
        const [target, sibling] = f.threadIds;
        yield* f.resume(target!);
        yield* f.start(sibling!);
        if (resumeFails) {
          yield* Ref.set(failNextResume, true);
          const failedResume = yield* Effect.exit(
            f.runtime.resumeThread({
              providerThread: f.providerThreadOf(target!),
              threadId: target!,
              modelSelection: { ...modelSelection, model: "gpt-6-astra" },
              runtimePolicy,
            }),
          );
          assert.equal(failedResume._tag, "Failure");
        } else {
          yield* f.resume(target!);
        }
        const prior = f.providerThreadOf(target!);
        const replacement = yield* f.runtime.ensureThread({
          threadId: target!,
          title: "replacement",
          providerSessionId: f.providerSessionId,
          modelSelection,
          runtimePolicy,
          existingProviderThread: { ...prior, nativeThreadRef: null },
          forceNewNativeThread: true,
        });
        yield* f.start(target!, 1, replacement);
        yield* TestClock.adjust("2 seconds");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${target}`]);
        yield* f.finish(target!);
        yield* TestClock.adjust("1 second");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
          `native-${target}`,
          "replacement-native",
        ]);
        yield* TestClock.adjust("2 seconds");
        assert.equal((yield* Ref.get(state)).unloadedNativeThreadIds.length, 2);
      });
      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            afterResume: Ref.getAndSet(failNextResume, false).pipe(
              Effect.flatMap((fail) =>
                fail ? Effect.die("resume transport failure") : Effect.void,
              ),
            ),
            ensureThread: (input) =>
              Effect.succeed({
                ...input.existingProviderThread!,
                nativeThreadRef: {
                  driver: CODEX_DRIVER,
                  nativeId: "replacement-native",
                  strength: "strong" as const,
                },
              }),
          }),
        ),
      );
    }),
);

it.effect.each([0, 1, 3])(
  "ProviderSessionManagerV2 bounds detach cleanup retries and does not unsubscribe an unloaded generation again (failures: %s)",
  (failures) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const attempts = yield* Ref.make(0);
      const effect = Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state, 2);
        const [target, sibling] = f.threadIds;
        yield* f.resume(target!);
        yield* f.start(sibling!);
        const providerThread = f.providerThreadOf(target!);
        yield* f.eventSink.write({
          events: [
            {
              id: yield* f.idAllocator.allocate.event({ threadId: target! }),
              type: "provider-thread.updated",
              threadId: target!,
              driver: CODEX_DRIVER,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: f.now,
              payload: providerThread,
            },
          ],
        });
        yield* f.manager.detach({ providerSessionId: f.providerSessionId, threadId: target! });
        yield* TestClock.adjust("3 seconds");
        assert.equal(yield* Ref.get(attempts), Math.min(failures + 1, 3));
        assert.deepEqual(
          (yield* Ref.get(state)).unloadedNativeThreadIds,
          failures < 3 ? [`native-${target}`] : [],
        );
        yield* f.manager.detach({ providerSessionId: f.providerSessionId, threadId: target! });
        assert.equal(yield* Ref.get(attempts), Math.min(failures + 1, 3));
      });
      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            beforeUnload: Ref.updateAndGet(attempts, (n) => n + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt <= failures ? Effect.die("unsubscribe transport failure") : Effect.void,
              ),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 defers an idle unload when its background-work probe fails, then unloads after recovery",
  () =>
    Effect.gen(function* () {
      const failing = yield* Ref.make(true);
      yield* runIdleThreadUnloadScenario(
        "probe-error",
        ({ state, threadA, startTurn, endTurn }) =>
          Effect.gen(function* () {
            yield* startTurn(threadA, 1);
            yield* endTurn(threadA, 1);
            yield* TestClock.adjust("3 seconds");
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
            yield* Ref.set(failing, false);
            yield* TestClock.adjust("1 second");
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
              `native-${threadA}`,
            ]);
          }),
        {
          hasPendingBackgroundWorkForThread: Ref.get(failing).pipe(
            Effect.flatMap((fail) =>
              fail ? Effect.die("probe transport failure") : Effect.succeed(false),
            ),
          ),
        },
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps the session alive when its background-work probe fails",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const failing = yield* Ref.make(true);
      const probe = Ref.get(failing).pipe(
        Effect.flatMap((fail) =>
          fail ? Effect.die("probe transport failure") : Effect.succeed(false),
        ),
      );
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state, 1);
        yield* f.resume(f.threadIds[0]!);
        yield* TestClock.adjust("3 seconds");
        assert.isTrue(Option.isSome(yield* f.manager.get(f.providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
        yield* Ref.set(failing, false);
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            hasPendingBackgroundWork: probe,
            hasPendingBackgroundWorkForThread: probe,
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 detach skips a native generation already idle-unloaded", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const f = yield* makeSessionAudienceFixture(state, 2);
      const [target, sibling] = f.threadIds;
      yield* f.resume(target!);
      yield* f.start(sibling!);
      yield* f.eventSink.write({
        events: [
          {
            id: yield* f.idAllocator.allocate.event({ threadId: target! }),
            type: "provider-thread.updated",
            threadId: target!,
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: f.now,
            payload: f.providerThreadOf(target!),
          },
        ],
      });
      yield* TestClock.adjust("1 second");
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${target}`]);
      yield* f.manager.detach({ providerSessionId: f.providerSessionId, threadId: target! });
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${target}`]);
    }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 detaches every pending native generation of a replaced provider row",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state, 2);
        const [target, sibling] = f.threadIds;
        yield* f.resume(target!);
        yield* f.start(sibling!);
        yield* f.runtime.ensureThread({
          threadId: target!,
          title: "replacement",
          providerSessionId: f.providerSessionId,
          modelSelection,
          runtimePolicy,
          existingProviderThread: { ...f.providerThreadOf(target!), nativeThreadRef: null },
          forceNewNativeThread: true,
        });
        yield* f.manager.detach({ providerSessionId: f.providerSessionId, threadId: target! });
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
          `native-${target}`,
          "replacement-native",
        ]);
        yield* TestClock.adjust("2 seconds");
        assert.equal((yield* Ref.get(state)).unloadedNativeThreadIds.length, 2);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            ensureThread: (input) =>
              Effect.succeed({
                ...input.existingProviderThread!,
                nativeThreadRef: {
                  driver: CODEX_DRIVER,
                  nativeId: "replacement-native",
                  strength: "strong" as const,
                },
              }),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 retains superseded cleanup when reattachment wins before detach unloads",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const armed = yield* Ref.make(false);
      const detached = yield* Deferred.make<void>();
      const continueDetach = yield* Deferred.make<void>();
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            revokeThread: (threadId) =>
              delegate
                .revokeThread(threadId)
                .pipe(
                  Effect.tap(() =>
                    Ref.getAndSet(armed, false).pipe(
                      Effect.flatMap((pause) =>
                        pause
                          ? Deferred.succeed(detached, undefined).pipe(
                              Effect.andThen(Deferred.await(continueDetach)),
                            )
                          : Effect.void,
                      ),
                    ),
                  ),
                ),
          });
        }),
      ).pipe(Layer.provide(layerTestMcpRegistry), Layer.orDie);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state, 2);
        const [target, sibling] = f.threadIds;
        yield* f.resume(target!);
        yield* f.start(sibling!);
        const replacement = yield* f.runtime.ensureThread({
          threadId: target!,
          title: "replacement",
          providerSessionId: f.providerSessionId,
          modelSelection,
          runtimePolicy,
          existingProviderThread: { ...f.providerThreadOf(target!), nativeThreadRef: null },
          forceNewNativeThread: true,
        });
        yield* f.eventSink.write({
          events: [
            {
              id: yield* f.idAllocator.allocate.event({ threadId: target! }),
              type: "provider-thread.updated",
              threadId: target!,
              driver: CODEX_DRIVER,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: f.now,
              payload: replacement,
            },
          ],
        });
        yield* Ref.set(armed, true);
        const detaching = yield* f.manager
          .detach({
            providerSessionId: f.providerSessionId,
            threadId: target!,
            revokeMcpCredential: true,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(detached);
        yield* f.runtime.resumeThread({
          providerThread: replacement,
          threadId: target!,
          modelSelection,
          runtimePolicy,
        });
        yield* f.start(target!, 1, replacement);
        yield* Deferred.succeed(continueDetach, undefined);
        yield* Fiber.join(detaching);
        yield* TestClock.adjust("1 second");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${target}`]);
        yield* f.finish(target!);
        yield* TestClock.adjust("1 second");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
          `native-${target}`,
          "replacement-native",
        ]);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            mcpRegistryLayer,
            ensureThread: (input) =>
              Effect.succeed({
                ...input.existingProviderThread!,
                nativeThreadRef: {
                  driver: CODEX_DRIVER,
                  nativeId: "replacement-native",
                  strength: "strong" as const,
                },
              }),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 unloading a superseded native ID preserves the replacement's loaded cache",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const pending = yield* Ref.make(true);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state, 2);
        const [target, sibling] = f.threadIds;
        yield* f.resume(target!);
        yield* f.start(sibling!);
        const replacement = yield* f.runtime.ensureThread({
          threadId: target!,
          title: "replacement",
          providerSessionId: f.providerSessionId,
          modelSelection,
          runtimePolicy,
          existingProviderThread: { ...f.providerThreadOf(target!), nativeThreadRef: null },
          forceNewNativeThread: true,
        });
        yield* TestClock.adjust("1 second");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${target}`]);
        const resumes = (yield* Ref.get(state)).resumeCount;
        yield* f.runtime.resumeThread({
          providerThread: replacement,
          threadId: target!,
          modelSelection,
          runtimePolicy,
        });
        assert.equal((yield* Ref.get(state)).resumeCount, resumes);
        yield* Ref.set(pending, false);
        yield* TestClock.adjust("1 second");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
          `native-${target}`,
          "replacement-native",
        ]);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            pendingWorkForThread: (thread) =>
              thread.nativeThreadRef?.nativeId === "replacement-native"
                ? Ref.get(pending)
                : Effect.succeed(false),
            ensureThread: (input) =>
              Effect.succeed({
                ...input.existingProviderThread!,
                nativeThreadRef: {
                  driver: CODEX_DRIVER,
                  nativeId: "replacement-native",
                  strength: "strong" as const,
                },
              }),
          }),
        ),
      );
    }),
);

const seedUnreadProviderHistory = Effect.fn("test.seedUnreadProviderHistory")(function* (
  providerThreadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
    (provider_thread_id, thread_id, owner_node_id, provider, provider_instance_id,
      provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at, payload_json)
    SELECT provider_thread_id || '-history-' || value, thread_id, NULL, provider, provider_instance_id,
      provider_session_id, 'idle', NULL, NULL, updated_at,
      json_object('nativeThreadRef', json_object('nativeId', 'old-' || value))
    FROM orchestration_v2_projection_provider_threads
    CROSS JOIN json_each(${JSON.stringify(Array.from({ length: 2000 }, (_, i) => i))})
    WHERE provider_thread_id = ${providerThreadId}`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
    SELECT provider_thread_id || '-old-run-' || value, thread_id, value, provider, 'completed',
      updated_at, updated_at, '{}'
    FROM orchestration_v2_projection_provider_threads
    CROSS JOIN json_each(${JSON.stringify(Array.from({ length: 2000 }, (_, i) => i + 1))})
    WHERE provider_thread_id = ${providerThreadId}`;
});

const orphanSweepFixture = Effect.fn("test.orphanSweepFixture")(function* (count: number) {
  const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const now = yield* DateTime.now;
  const providerSessionId = idAllocator.derive.providerSession({
    providerInstanceId: modelSelection.instanceId,
  });
  const threads = [];
  for (let i = 0; i < count; i++) {
    const threadId = ThreadId.make(`orphan-sweep-${i}`);
    const providerThread = makeProviderThread({
      idAllocator,
      threadId,
      providerSessionId,
      now,
      nativeThreadId: `orphan-native-${i}`,
    });
    yield* eventSink.write({
      events: [
        yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
        {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "provider-thread.updated",
          threadId,
          driver: CODEX_DRIVER,
          occurredAt: now,
          payload: providerThread,
        },
      ],
    });
    threads.push({ threadId, providerThread });
  }
  const first = threads[0]!;
  const runtime = yield* manager.open({
    threadId: first.threadId,
    providerSessionId,
    modelSelection,
    runtimePolicy,
  });
  for (const { threadId } of threads.slice(1)) {
    yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
  }
  // Keep the shared session alive without registering any orphan's unload timer.
  const keeper = threads.at(-1)!;
  const runId = idAllocator.derive.run({ threadId: keeper.threadId, ordinal: 1 });
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  yield* runtime.startTurn({
    appThread: yield* projectionStore.getThread(keeper.threadId),
    threadId: keeper.threadId,
    providerThread: keeper.providerThread,
    runId,
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
    rootNodeId: idAllocator.derive.rootNode({ runId }),
    modelSelection,
    runtimePolicy,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: yield* idAllocator.allocate.message({ threadId: keeper.threadId, ordinal: 1 }),
      text: "keep running",
      attachments: [],
    },
  });
  return {
    manager,
    runtime,
    threads,
    providerSessionId,
    sweep: manager.sweepOrphanedThreads(providerSessionId),
  };
});

it.effect("orphan sweep reaps missed registrations and keeps busy and unknown threads", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const fixture = yield* orphanSweepFixture(2);
      yield* seedUnreadProviderHistory(fixture.threads[0]!.providerThread.id);
      yield* TestClock.adjust("1 second");
      yield* fixture.sweep;
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["orphan-native-0"]);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          pendingWorkForThread: () => Effect.succeed(false),
          listLoadedNativeThreads: () =>
            Effect.succeed(["orphan-native-0", "orphan-native-1", "unknown-native"]),
        }),
      ),
    );
  }),
);

it.effect("orphan sweep caps unsubscribes at 50 and continues next sweep", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const fixture = yield* orphanSweepFixture(56);
      yield* TestClock.adjust("1 second");
      yield* fixture.sweep;
      assert.equal((yield* Ref.get(state)).unloadedNativeThreadIds.length, 50);
      yield* fixture.sweep;
      assert.equal((yield* Ref.get(state)).unloadedNativeThreadIds.length, 55);
      assert.isFalse((yield* Ref.get(state)).unloadedNativeThreadIds.includes("orphan-native-55"));
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          pendingWorkForThread: () => Effect.succeed(false),
          listLoadedNativeThreads: () =>
            Ref.get(state).pipe(
              Effect.map((s) =>
                Array.from({ length: 56 }, (_, i) => `orphan-native-${i}`).filter(
                  (id) => !s.unloadedNativeThreadIds.includes(id),
                ),
              ),
            ),
        }),
      ),
    );
  }),
);

it.effect("orphan sweep keeps background work, recent and held threads", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const resumed = yield* Deferred.make<void>();
    const resumeGate = yield* Deferred.make<void>();
    const holdResume = yield* Ref.make(false);
    yield* Effect.gen(function* () {
      const fixture = yield* orphanSweepFixture(4);
      // All rows are recent on the first sweep.
      yield* fixture.sweep;
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
      yield* TestClock.adjust("1 second");
      yield* Ref.set(holdResume, true);
      const held = fixture.threads[1]!;
      const fiber = yield* fixture.runtime
        .resumeThread({
          providerThread: held.providerThread,
          threadId: held.threadId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(resumed);
      yield* fixture.sweep;
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["orphan-native-2"]);
      yield* Deferred.succeed(resumeGate, undefined);
      yield* Fiber.join(fiber);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          pendingWorkForThread: (thread) =>
            Effect.succeed(thread.nativeThreadRef?.nativeId === "orphan-native-0"),
          afterResume: Ref.get(holdResume).pipe(
            Effect.flatMap((hold) =>
              hold
                ? Deferred.succeed(resumed, undefined).pipe(
                    Effect.andThen(Deferred.await(resumeGate)),
                  )
                : Effect.void,
            ),
          ),
          listLoadedNativeThreads: () =>
            Effect.succeed(Array.from({ length: 4 }, (_, i) => `orphan-native-${i}`)),
        }),
      ),
    );
  }),
);

it.effect.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
  "orphan sweep keeps a persisted %s run without an in-memory busy marker",
  (status) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const fixture = yield* orphanSweepFixture(2);
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const { threadId, providerThread } = fixture.threads[0]!;
        const now = yield* DateTime.now;
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              type: "run.created",
              payload: {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId: modelSelection.instanceId,
                modelSelection,
                providerThreadId: providerThread.id,
                userMessageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
                rootNodeId: idAllocator.derive.rootNode({ runId }),
                activeAttemptId: null,
                status,
                requestedAt: now,
                startedAt: null,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
        yield* TestClock.adjust("1 second");
        yield* fixture.sweep;
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            pendingWorkForThread: () => Effect.succeed(false),
            listLoadedNativeThreads: () => Effect.succeed(["orphan-native-0", "orphan-native-1"]),
          }),
        ),
      );
    }),
);

it.effect("orphan sweep does nothing when listing fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const logs: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    yield* Effect.gen(function* () {
      const fixture = yield* orphanSweepFixture(2);
      yield* TestClock.adjust("1 second");
      yield* fixture.sweep;
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
      assert.isTrue(
        logs.some(
          (message) =>
            Array.isArray(message) &&
            message[0] === "orchestration-v2.driver-session.orphan-sweep" &&
            message[1]?.listFailed === true,
        ),
      );
    }).pipe(
      Effect.provide([
        Logger.layer([logger]),
        layerTest({
          state,
          idleTimeoutMs: 1000,
          pendingWorkForThread: () => Effect.succeed(false),
          listLoadedNativeThreads: () => unimplemented("loaded list unavailable"),
        }),
      ]),
    );
  }),
);

it.effect("orphan sweep skips a thread resumed while its loaded list is in flight", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const listing = yield* Deferred.make<void>();
    const listed = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const fixture = yield* orphanSweepFixture(2);
      yield* TestClock.adjust("1 second");
      const sweep = yield* fixture.sweep.pipe(Effect.forkScoped);
      yield* Deferred.await(listing);
      const owner = fixture.threads[0]!;
      yield* fixture.runtime.resumeThread({
        threadId: owner.threadId,
        providerThread: owner.providerThread,
        modelSelection,
        runtimePolicy,
      });
      yield* Deferred.succeed(listed, undefined);
      yield* Fiber.join(sweep);
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          pendingWorkForThread: () => Effect.succeed(false),
          listLoadedNativeThreads: () =>
            Deferred.succeed(listing, undefined).pipe(
              Effect.andThen(Deferred.await(listed)),
              Effect.as(["orphan-native-0", "orphan-native-1"]),
            ),
        }),
      ),
    );
  }),
);

it.effect("orphan sweep starts after 30 seconds and recovers on its ten minute interval", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const calls = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      yield* orphanSweepFixture(2);
      yield* TestClock.adjust("29 seconds");
      assert.equal(yield* Ref.get(calls), 0);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Ref.get(calls), 1);
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
      yield* TestClock.adjust("10 minutes");
      assert.equal(yield* Ref.get(calls), 2);
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["orphan-native-0"]);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          pendingWorkForThread: () => Effect.succeed(false),
          listLoadedNativeThreads: () =>
            Ref.updateAndGet(calls, (n) => n + 1).pipe(
              Effect.flatMap((n) =>
                n === 1
                  ? unimplemented("list failure")
                  : Effect.succeed(["orphan-native-0", "orphan-native-1"]),
              ),
            ),
        }),
      ),
    );
  }),
);

it.effect.each(["missing", "failed"] as const)(
  "orphan sweep keeps ownership whose background probe is %s",
  (probe) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const fixture = yield* orphanSweepFixture(2);
        yield* TestClock.adjust("1 second");
        yield* fixture.sweep;
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            ...(probe === "missing"
              ? {}
              : { pendingWorkForThread: () => Effect.die("probe failed") }),
            listLoadedNativeThreads: () => Effect.succeed(["orphan-native-0", "orphan-native-1"]),
          }),
        ),
      );
    }),
);

it.effect.each([
  "self",
  "native-child",
  "unknown-owner",
  "other-session",
  "other-instance",
  "other-driver",
  "missing-native-id",
] as const)("orphan sweep uses the actual owner of a %s provider row during child resume", (kind) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const listing = yield* Deferred.make<void>();
    const listed = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const f = yield* orphanSweepFixture(2);
      const parent = f.threads[0]!;
      const childId = ThreadId.make("orphan-native-child-owner");
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const child = {
        ...makeProviderThread({
          idAllocator,
          threadId: childId,
          providerSessionId: f.providerSessionId,
          now,
          nativeThreadId: "orphan-child-native",
        }),
        appThreadId:
          kind === "native-child" ? childId : kind === "unknown-owner" ? null : parent.threadId,
        providerSessionId:
          kind === "other-session"
            ? idAllocator.derive.providerSession({
                providerInstanceId: ProviderInstanceId.make("other"),
              })
            : f.providerSessionId,
        providerInstanceId:
          kind === "other-instance" ? ProviderInstanceId.make("other") : modelSelection.instanceId,
        nativeThreadRef: {
          driver: kind === "other-driver" ? ProviderDriverKind.make("other") : CODEX_DRIVER,
          nativeId: kind === "missing-native-id" ? null : "orphan-child-native",
          strength: "strong" as const,
        },
      };
      const runId = idAllocator.derive.run({ threadId: parent.threadId, ordinal: 1 });
      const parentNodeId = idAllocator.derive.rootNode({ runId });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: childId, now }),
          {
            id: yield* idAllocator.allocate.event({ threadId: parent.threadId }),
            threadId: parent.threadId,
            occurredAt: now,
            driver: CODEX_DRIVER,
            type: "provider-thread.updated",
            payload: child,
          },
          {
            id: yield* idAllocator.allocate.event({ threadId: parent.threadId }),
            threadId: parent.threadId,
            occurredAt: now,
            driver: CODEX_DRIVER,
            type: "subagent.updated",
            payload: {
              id: idAllocator.derive.rootNode({
                runId: idAllocator.derive.run({ threadId: childId, ordinal: 1 }),
              }),
              threadId: parent.threadId,
              runId,
              parentNodeId,
              origin: "provider_native",
              createdBy: "system",
              driver: CODEX_DRIVER,
              providerInstanceId: modelSelection.instanceId,
              providerThreadId: child.id,
              childThreadId: childId,
              nativeTaskRef: child.nativeThreadRef,
              prompt: "child",
              title: null,
              model: null,
              status: "completed",
              result: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      assert.isTrue(
        (yield* store.getThreadRecords(parent.threadId, ["providerThreads"])).providerThreads.some(
          (row) => row.id === child.id,
        ),
      );
      yield* TestClock.adjust("1 second");
      const sweep = yield* f.sweep.pipe(Effect.forkScoped);
      yield* Deferred.await(listing);
      if (kind === "native-child") {
        yield* f.manager.open({
          threadId: childId,
          providerSessionId: f.providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* f.runtime.resumeThread({
          threadId: childId,
          providerThread: child,
          modelSelection,
          runtimePolicy,
        });
      }
      yield* Deferred.succeed(listed, undefined);
      yield* Fiber.join(sweep);
      assert.deepEqual(
        (yield* Ref.get(state)).unloadedNativeThreadIds,
        kind === "self" ? ["orphan-child-native"] : [],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          pendingWorkForThread: () => Effect.succeed(false),
          listLoadedNativeThreads: () =>
            Deferred.succeed(listing, undefined).pipe(
              Effect.andThen(Deferred.await(listed)),
              Effect.as(["orphan-child-native"]),
            ),
        }),
      ),
    );
  }),
);

it.effect(
  "orphan sweep retires a deferred timer before a resumed thread gets a new idle window",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const background = yield* Ref.make(true);
      yield* Effect.gen(function* () {
        const f = yield* orphanSweepFixture(2);
        const owner = f.threads[0]!;
        const resume = f.runtime.resumeThread({
          threadId: owner.threadId,
          providerThread: owner.providerThread,
          modelSelection,
          runtimePolicy,
        });
        yield* resume;
        yield* TestClock.adjust("1 second");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
        yield* Ref.set(background, false);
        yield* TestClock.adjust("500 millis");
        yield* f.sweep;
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["orphan-native-0"]);
        yield* resume;
        yield* TestClock.adjust("500 millis");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["orphan-native-0"]);
        yield* TestClock.adjust("500 millis");
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
          "orphan-native-0",
          "orphan-native-0",
        ]);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            pendingWorkForThread: () => Ref.get(background),
            listLoadedNativeThreads: () => Effect.succeed(["orphan-native-0"]),
          }),
        ),
      );
    }),
);

it.effect.each(["same", "session", "native", "instance", "driver", "missing", "thread"] as const)(
  "persists only the current idle Claude refusal session: %s",
  (identity) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state, 1);
        const threadId = f.threadIds[0]!;
        const old = {
          ...f.providerThreadOf(threadId),
          nativeMetadata: { claudeRefusalObserved: false },
        };
        yield* f.eventSink.write({
          events: [
            {
              id: yield* f.idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              occurredAt: f.now,
              payload: old,
            },
          ],
        });
        yield* f.resume(threadId);
        yield* f.start(threadId);
        yield* f.finish(threadId);
        // f.publish uses a temporary raw receipt subscriber only. There is no
        // run ingestion subscriber; the receipt proves the real pump completed.
        const incoming = {
          ...old,
          status: "error" as const,
          nativeMetadata: { claudeRefusalObserved: true },
        };
        if (identity === "session")
          incoming.providerSessionId = "old-provider-session" as typeof old.providerSessionId;
        if (identity === "native")
          incoming.nativeThreadRef = { ...old.nativeThreadRef!, nativeId: "old-native-session" };
        if (identity === "missing") incoming.nativeThreadRef = null;
        if (identity === "thread") incoming.appThreadId = ThreadId.make("retired-thread");
        if (identity === "instance")
          incoming.providerInstanceId = ProviderInstanceId.make("old-instance");
        if (identity === "driver") incoming.driver = ProviderDriverKind.make("codex");
        yield* f.publish({
          type: "provider_thread.updated",
          driver: f.runtime.driver,
          providerThread: incoming,
        });
        const records = yield* f.projectionStore.getThreadRecords(threadId, ["providerThreads"]);
        const stored = records.providerThreads.find((thread) => thread.id === old.id);
        assert.equal(
          stored?.nativeMetadata?.claudeRefusalObserved,
          identity === "same",
          "only the current native session may record its exclusion",
        );
        assert.equal(stored?.status, old.status, "marker persistence must not copy a stale status");
        assert.deepEqual(stored?.nativeThreadRef, old.nativeThreadRef);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60000,
            driver: ProviderDriverKind.make("claudeAgent"),
          }),
        ),
      );
    }),
);

it.effect.each(
  (
    [
      "snapshot",
      "batch",
      "new-runtime",
      "new-native",
      "new-instance",
      "other-driver",
      "missing-native",
    ] as const
  ).flatMap((change) => [false, undefined].map((marker) => ({ change, marker }))),
)("keeps durable Claude refusal history through $change/$marker", ({ change, marker }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const f = yield* makeSessionAudienceFixture(state, 1);
      const threadId = f.threadIds[0]!;
      const initial: OrchestrationV2ProviderThread = {
        ...f.providerThreadOf(threadId),
        nativeMetadata: { claudeRefusalObserved: false },
      };
      const write = (payloads: ReadonlyArray<OrchestrationV2ProviderThread>) =>
        Effect.forEach(payloads, (payload) =>
          Effect.gen(function* () {
            return {
              id: yield* f.idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated" as const,
              threadId,
              occurredAt: yield* DateTime.now,
              payload,
            };
          }),
        ).pipe(Effect.flatMap((events) => f.eventSink.write({ events })));
      yield* write([initial]);
      yield* f.resume(threadId);
      yield* f.start(threadId);
      yield* f.finish(threadId);
      const observed = { ...initial, nativeMetadata: { claudeRefusalObserved: true } };
      if (change !== "batch")
        yield* f.publish({
          type: "provider_thread.updated",
          driver: f.runtime.driver,
          providerThread: observed,
        });
      const snapshot = {
        ...initial,
        nativeMetadata: marker === undefined ? {} : { claudeRefusalObserved: marker },
      };
      if (change === "new-runtime")
        snapshot.providerSessionId = yield* f.idAllocator.allocate.providerSession({
          threadId,
          providerInstanceId: modelSelection.instanceId,
        });
      if (change === "new-native")
        snapshot.nativeThreadRef = { ...initial.nativeThreadRef!, nativeId: "new-native-session" };
      if (change === "new-instance")
        snapshot.providerInstanceId = ProviderInstanceId.make("new-instance");
      if (change === "other-driver") snapshot.driver = CODEX_DRIVER;
      if (change === "missing-native") snapshot.nativeThreadRef = null;
      yield* write(change === "batch" ? [observed, snapshot] : [snapshot]);
      const stored = (yield* f.projectionStore.getThreadRecords(threadId, [
        "providerThreads",
      ])).providerThreads.find((row) => row.id === initial.id);
      const preserved = change === "snapshot" || change === "batch" || change === "new-runtime";
      assert.equal(stored?.nativeMetadata?.claudeRefusalObserved, preserved ? true : marker);
      const events = yield* f.eventStore
        .read({ eventType: "provider-thread.updated" })
        .pipe(Stream.runCollect);
      const last = events.at(-1)?.event;
      assert.equal(
        last?.type === "provider-thread.updated"
          ? last.payload.nativeMetadata?.claudeRefusalObserved
          : undefined,
        preserved ? true : marker,
      );
    }).pipe(
      Effect.provide(
        layerTest({ state, driver: ProviderDriverKind.make("claudeAgent"), idleTimeoutMs: 60000 }),
      ),
    );
  }),
);

it.effect.each([false, true, "session"] as const)(
  "guards a refusal write racing native replacement: %s",
  (replaceNative) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const before = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state, 1);
        const threadId = f.threadIds[0]!;
        const initial = {
          ...f.providerThreadOf(threadId),
          nativeMetadata: { claudeRefusalObserved: false },
        };
        const write = (payload: OrchestrationV2ProviderThread) =>
          Effect.gen(function* () {
            yield* f.eventSink.write({
              events: [
                {
                  id: yield* f.idAllocator.allocate.event({ threadId }),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload,
                },
              ],
            });
          });
        yield* write(initial);
        yield* f.resume(threadId);
        yield* f.start(threadId);
        yield* f.finish(threadId);
        const concurrent = {
          ...initial,
          status: "active" as const,
          nativeThreadRef:
            replaceNative === true
              ? { ...initial.nativeThreadRef!, nativeId: "replacement-native" }
              : initial.nativeThreadRef,
        };
        if (replaceNative === "session")
          concurrent.providerSessionId = yield* f.idAllocator.allocate.providerSession({
            threadId,
            providerInstanceId: modelSelection.instanceId,
          });
        yield* Ref.set(before, write(concurrent).pipe(Effect.orDie));
        yield* f.publish({
          type: "provider_thread.updated",
          driver: f.runtime.driver,
          providerThread: { ...initial, nativeMetadata: { claudeRefusalObserved: true } },
        });
        const stored = (yield* f.projectionStore.getThreadRecords(threadId, [
          "providerThreads",
        ])).providerThreads.find((row) => row.id === initial.id);
        assert.equal(stored?.nativeMetadata?.claudeRefusalObserved, replaceNative !== true);
        assert.equal(stored?.status, "active");
        assert.equal(stored?.providerSessionId, concurrent.providerSessionId);
        assert.equal(stored?.nativeThreadRef?.nativeId, concurrent.nativeThreadRef?.nativeId);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            beforeUnchangedWrite: before,
            driver: ProviderDriverKind.make("claudeAgent"),
            idleTimeoutMs: 60000,
          }),
        ),
      );
    }),
);

it.effect.each(["shared Claude", "muse", "codex"] as const)(
  "stopping background work keeps a %s session",
  (kind) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const f = yield* makeSessionAudienceFixture(state, kind === "shared Claude" ? 2 : 1);
        yield* f.eventSink.write({
          events: [
            {
              id: yield* f.idAllocator.allocate.event({ threadId: f.threadIds[0]! }),
              type: "provider-thread.updated",
              threadId: f.threadIds[0]!,
              occurredAt: f.now,
              payload: f.providerThreadOf(f.threadIds[0]!),
            },
          ],
        });
        if (kind === "shared Claude") yield* f.start(f.threadIds[1]!);
        yield* f.manager.stopBackgroundWork({
          threadId: f.threadIds[0]!,
          throughRunOrdinal: 0,
          onlyIfCancelled: false,
        });
        assert.isTrue(Option.isSome(yield* f.manager.get(f.providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            driver: ProviderDriverKind.make(kind === "shared Claude" ? "claudeAgent" : kind),
            backgroundTasksEndWithProcess: true,
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: Effect.succeed(true),
          }),
        ),
      );
    }),
);

it.effect.each([
  { change: "new start", releases: false },
  { change: "new start and finish", releases: false },
  { change: "same turn finishes", releases: true },
  { change: "old thread errors", releases: true },
  { change: "starting cancellation", releases: true },
] as const)("Stop revalidates $change during its background probe", ({ change, releases }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const probing = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const startEntered = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const f = yield* makeSessionAudienceFixture(state, 1);
      yield* f.eventSink.write({
        events: [
          {
            id: yield* f.idAllocator.allocate.event({ threadId: f.threadIds[0]! }),
            type: "provider-thread.updated",
            threadId: f.threadIds[0]!,
            occurredAt: f.now,
            payload: f.providerThreadOf(f.threadIds[0]!),
          },
        ],
      });
      const starting =
        change === "starting cancellation"
          ? yield* f.start(f.threadIds[0]!, 1).pipe(Effect.forkScoped)
          : null;
      if (starting === null) yield* f.start(f.threadIds[0]!, 1);
      else yield* Deferred.await(startEntered);
      const stopping = yield* f.manager
        .stopBackgroundWork({
          threadId: f.threadIds[0]!,
          throughRunOrdinal: 1,
          onlyIfCancelled: false,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(probing);
      if (starting !== null) yield* Fiber.interrupt(starting);
      else if (change === "same turn finishes" || change === "old thread errors") {
        yield* f.finish(f.threadIds[0]!, 1);
        if (change === "old thread errors")
          yield* f.publish({
            type: "provider_thread.updated",
            driver: f.runtime.driver,
            providerThread: { ...f.providerThreadOf(f.threadIds[0]!), status: "error" },
          });
      } else {
        yield* f.start(f.threadIds[0]!, 2);
        if (change === "new start and finish") yield* f.finish(f.threadIds[0]!, 2);
      }
      yield* Deferred.succeed(resume, undefined);
      const released = yield* Fiber.join(stopping);
      assert.equal(released.length, releases ? 1 : 0);
      assert.equal(Option.isNone(yield* f.manager.get(f.providerSessionId)), releases);
      assert.equal((yield* Ref.get(state)).closeCount, releases ? 1 : 0);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          driver: ProviderDriverKind.make("claudeAgent"),
          backgroundTasksEndWithProcess: true,
          ...(change === "starting cancellation"
            ? {
                startTurn: Deferred.succeed(startEntered, undefined).pipe(
                  Effect.andThen(Effect.never),
                ),
              }
            : {}),
          hasPendingBackgroundWorkForThread: Deferred.succeed(probing, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as(true),
          ),
        }),
      ),
    );
  }),
);

it.effect.each([
  { change: "new user queued", releases: false },
  { change: "new agent queued", releases: false },
  { change: "wake unheld", releases: false },
  { change: "wake starting", releases: false },
  { change: "new automatic wake", releases: true },
] as const)("Stop revalidates $change during its message lookup", ({ change, releases }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const armed = yield* Ref.make(false);
    const reading = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const f = yield* makeSessionAudienceFixture(state, 1);
      const threadId = f.threadIds[0]!;
      const providerThread = f.providerThreadOf(threadId);
      yield* f.eventSink.write({
        events: [
          {
            id: yield* f.idAllocator.allocate.event({ threadId }),
            type: "provider-thread.updated",
            threadId,
            occurredAt: f.now,
            payload: providerThread,
          },
        ],
      });
      yield* f.start(threadId);
      const seedRun = Effect.fnUntraced(function* (
        ordinal: number,
        createdBy: "user" | "agent",
        creationSource: "provider" | "web" | "mcp",
      ) {
        const runId = f.idAllocator.derive.run({ threadId, ordinal });
        const messageId = yield* f.idAllocator.allocate.message({ threadId, ordinal });
        const rootNodeId = f.idAllocator.derive.rootNode({ runId });
        const run = {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId: providerThread.id,
          userMessageId: messageId,
          rootNodeId,
          activeAttemptId: f.idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
          status: "queued" as const,
          queueHeld: true,
          requestedAt: f.now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        yield* f.eventSink.write({
          events: [
            {
              id: yield* f.idAllocator.allocate.event({ threadId }),
              type: "run.updated",
              threadId,
              occurredAt: f.now,
              payload: run,
            },
            {
              id: yield* f.idAllocator.allocate.event({ threadId }),
              type: "message.updated",
              threadId,
              occurredAt: f.now,
              payload: {
                id: messageId,
                threadId,
                runId,
                nodeId: rootNodeId,
                role: "user",
                text: "late work",
                attachments: [],
                streaming: false,
                createdBy,
                creationSource,
                createdAt: f.now,
                updatedAt: f.now,
              },
            },
          ],
        });
        return run;
      });
      const wake = yield* seedRun(2, "agent", "provider");
      yield* Ref.set(armed, true);
      const stopping = yield* f.manager
        .stopBackgroundWork({
          threadId,
          throughRunOrdinal: 1,
          onlyIfCancelled: false,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(reading);
      if (change === "wake unheld" || change === "wake starting") {
        yield* f.eventSink.write({
          events: [
            {
              id: yield* f.idAllocator.allocate.event({ threadId }),
              type: "run.updated",
              threadId,
              occurredAt: f.now,
              payload: {
                ...wake,
                queueHeld: false,
                status: change === "wake starting" ? "starting" : "queued",
              },
            },
          ],
        });
      } else {
        yield* seedRun(
          3,
          change === "new user queued" ? "user" : "agent",
          change === "new user queued" ? "web" : change === "new agent queued" ? "mcp" : "provider",
        );
      }
      yield* Deferred.succeed(resume, undefined);
      const released = yield* Fiber.join(stopping);
      assert.equal(released.length, releases ? 1 : 0);
      assert.equal(Option.isNone(yield* f.manager.get(f.providerSessionId)), releases);
      assert.equal((yield* Ref.get(state)).closeCount, releases ? 1 : 0);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          driver: ProviderDriverKind.make("claudeAgent"),
          backgroundTasksEndWithProcess: true,
          hasPendingBackgroundWorkForThread: Effect.succeed(true),
          beforeMessageRead: Ref.getAndSet(armed, false).pipe(
            Effect.flatMap((pause) =>
              pause
                ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
            ),
          ),
        }),
      ),
    );
  }),
);

it.effect.each([
  "own",
  "missing",
  "stale",
  "foreign_thread",
  "foreign_instance",
  "reattached_same_session",
  "newer_run_same_session",
  "newer_run_other_session",
  "replacement_own",
  "replacement_projection_pending",
  "runtime_projection_mismatch",
  "restart_unbound_record",
] as const)("delegate_task handles real manager-issued credential: %s", (identity) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const registryLayer = Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry);
    const threadId = ThreadId.make("real-issuer-parent");
    const previousCredential =
      identity === "restart_unbound_record"
        ? yield* Effect.gen(function* () {
            const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
            const credentials = yield* McpProviderSessions.McpProviderSessions;
            const sink = yield* EventSink.EventSinkV2;
            const ids = yield* IdAllocator.IdAllocatorV2;
            const now = yield* DateTime.now;
            yield* sink.write({
              events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
            });
            yield* manager.open({
              threadId,
              providerSessionId: yield* ids.allocate.providerSession({
                threadId,
                providerInstanceId: modelSelection.instanceId,
              }),
              modelSelection,
              runtimePolicy,
            });
            return (yield* credentials.read(threadId))!;
          }).pipe(
            Effect.provide(
              layerTest({ state, idleTimeoutMs: 60_000, mcpRegistryLayer: registryLayer }),
            ),
          )
        : undefined;
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const credentials = yield* McpProviderSessions.McpProviderSessions;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const now = yield* DateTime.now;
      const runtimeId = yield* ids.allocate.providerSession({
        threadId,
        providerInstanceId: modelSelection.instanceId,
      });
      yield* sink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
      });
      if (previousCredential !== undefined) {
        assert.isUndefined(yield* credentials.read(threadId), "session config is process-local");
        const token = previousCredential.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(yield* registry.resolve(token), "registry auth survives manager shutdown");
        const { runtimeProviderSessionId: _oldRuntime, ...unbound } = previousCredential;
        yield* credentials.set(unbound);
      }
      yield* manager.open({
        threadId,
        providerSessionId: runtimeId,
        modelSelection,
        runtimePolicy,
      });
      const credential = yield* credentials.read(threadId);
      assert.isDefined(credential);
      assert.equal(credential!.runtimeProviderSessionId, runtimeId);
      if (previousCredential !== undefined) {
        assert.notEqual(credential!.providerSessionId, previousCredential.providerSessionId);
        assert.isUndefined(
          yield* registry.resolve(previousCredential.authorizationHeader.replace(/^Bearer\s+/, "")),
        );
      }
      const scope = yield* registry.resolve(
        credential!.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      assert.isDefined(scope);
      assert.notEqual(scope!.thread.providerSessionId, runtimeId);
      const providerThread = makeProviderThread({
        idAllocator: ids,
        threadId,
        providerSessionId: runtimeId,
        now,
      });
      const runId = ids.derive.run({ threadId, ordinal: 1 });
      const rootNodeId = ids.derive.rootNode({ runId });
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            threadId,
            occurredAt: now,
            type: "provider-thread.updated",
            payload: providerThread,
          },
          {
            id: yield* ids.allocate.event({ threadId }),
            threadId,
            occurredAt: now,
            type: "run.created",
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: providerThread.id,
              userMessageId: yield* ids.allocate.message({ threadId, ordinal: 1 }),
              rootNodeId,
              activeAttemptId: null,
              status: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      let parent = yield* store.getThreadProjection(threadId);
      assert.equal(parent.providerThreads[0]?.providerSessionId, runtimeId);
      let callerScope = scope!;
      let expectedRunId = runId;
      let expectedRuntimeId = runtimeId;
      if (identity === "foreign_thread" || identity === "foreign_instance") {
        const foreign = yield* registry.issue({
          threadId: identity === "foreign_thread" ? ThreadId.make("foreign-thread") : threadId,
          providerInstanceId:
            identity === "foreign_instance"
              ? ProviderInstanceId.make("foreign-instance")
              : modelSelection.instanceId,
        });
        callerScope = (yield* registry.resolve(
          foreign.config.authorizationHeader.replace(/^Bearer\s+/, ""),
        ))!;
      }
      if (identity === "missing") yield* credentials.clear(threadId);
      if (identity === "replacement_projection_pending") {
        const replacementRuntime = yield* ids.allocate.providerSession({
          threadId,
          providerInstanceId: modelSelection.instanceId,
        });
        yield* manager.open({
          threadId,
          providerSessionId: replacementRuntime,
          modelSelection,
          runtimePolicy,
        });
        const replacement = (yield* credentials.read(threadId))!;
        callerScope = (yield* registry.resolve(
          replacement.authorizationHeader.replace(/^Bearer\s+/, ""),
        ))!;
        assert.equal(parent.providerThreads[0]!.providerSessionId, runtimeId);
        assert.equal(replacement.runtimeProviderSessionId, replacementRuntime);
      }
      if (identity === "runtime_projection_mismatch") {
        yield* sink.write({
          events: [
            {
              id: yield* ids.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              type: "provider-thread.updated",
              payload: {
                ...providerThread,
                providerSessionId: yield* ids.allocate.providerSession({
                  threadId,
                  providerInstanceId: modelSelection.instanceId,
                }),
              },
            },
          ],
        });
        parent = yield* store.getThreadProjection(threadId);
      }
      if (identity === "stale") {
        const newer = yield* registry.issue({
          threadId,
          providerInstanceId: modelSelection.instanceId,
        });
        yield* credentials.set(newer.config);
      }
      if (identity === "reattached_same_session") {
        yield* manager.detach({ providerSessionId: runtimeId, threadId });
        yield* manager.open({
          threadId,
          providerSessionId: runtimeId,
          modelSelection,
          runtimePolicy,
        });
        assert.equal(
          (yield* credentials.read(threadId))?.providerSessionId,
          credential!.providerSessionId,
        );
      }
      if (
        identity === "newer_run_same_session" ||
        identity === "newer_run_other_session" ||
        identity === "replacement_own"
      ) {
        const newerRuntime =
          identity === "newer_run_same_session"
            ? runtimeId
            : yield* ids.allocate.providerSession({
                threadId,
                providerInstanceId: modelSelection.instanceId,
              });
        if (newerRuntime !== runtimeId) {
          yield* manager.open({
            threadId,
            providerSessionId: newerRuntime,
            modelSelection,
            runtimePolicy,
          });
          const replacement = (yield* credentials.read(threadId))!;
          assert.notEqual(replacement.providerSessionId, credential!.providerSessionId);
          assert.isUndefined(
            yield* registry.resolve(credential!.authorizationHeader.replace(/^Bearer\s+/, "")),
          );
          if (identity === "replacement_own") {
            callerScope = (yield* registry.resolve(
              replacement.authorizationHeader.replace(/^Bearer\s+/, ""),
            ))!;
          }
        }
        const newerThread = { ...providerThread, providerSessionId: newerRuntime };
        const newerRunId = ids.derive.run({ threadId, ordinal: 2 });
        yield* sink.write({
          events: [
            {
              id: yield* ids.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              type: "provider-thread.updated",
              payload: newerThread,
            },
            {
              id: yield* ids.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              type: "run.updated",
              payload: { ...parent.runs[0]!, status: "completed", completedAt: now },
            },
            {
              id: yield* ids.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              type: "run.created",
              payload: {
                ...parent.runs[0]!,
                id: newerRunId,
                ordinal: 2,
                rootNodeId: ids.derive.rootNode({ runId: newerRunId }),
              },
            },
          ],
        });
        parent = yield* store.getThreadProjection(threadId);
        assert.equal(parent.runs.at(-1)?.ordinal, 2);
        expectedRunId = newerRunId;
        expectedRuntimeId = newerRuntime;
      }
      const childId = ThreadId.make("real-issuer-child");
      const taskId = NodeId.make("real-issuer-task");
      const childRunId = RunId.make("real-issuer-child-run");
      const task = {
        id: taskId,
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        providerInstanceId: modelSelection.instanceId,
        model: modelSelection.model,
        status: "completed",
        result: "Done",
        completionDelivery: { state: "acknowledged" },
      } as const;
      let dispatched = false;
      const child = {
        ...parent,
        thread: { ...parent.thread, id: childId },
        subagents: [],
        runs: [
          {
            ...parent.runs[0]!,
            id: childRunId,
            rootNodeId: taskId,
            delegatedTaskId: taskId,
            status: "completed",
            completedAt: now,
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getCallerRow: () =>
            Effect.succeed({
              ...liveThreadShell(threadId),
              ...parent.thread,
              activeRunId: expectedRunId,
            }),
          getThreadRecords: (id) =>
            Effect.succeed(
              id === childId
                ? child
                : ({
                    ...parent,
                    subagents: dispatched ? [task] : [],
                  } as unknown as OrchestrationV2ThreadProjection),
            ),
          hasReceipt: () => Effect.succeed(false),
          getDelegationCommandState: () => Effect.succeed({ status: "never_saved" }),
          delegatedTaskResultPending: () => Effect.succeed(false),
          dispatch: (command) =>
            Effect.sync(() => {
              assert.equal(command.type, "delegated_task.request");
              if (command.type === "delegated_task.request") {
                assert.equal(command.parentRunId, expectedRunId);
                assert.equal(command.parentProviderSessionId, expectedRuntimeId);
              }
              dispatched = true;
              return {
                sequence: 1,
                storedEvents: [
                  { event: { type: "subagent.updated", payload: task } },
                  { event: { type: "run.created", threadId: childId, payload: child.runs[0] } },
                ],
              } as never;
            }),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId: modelSelection.instanceId,
              driver: CODEX_DRIVER,
              enabled: true,
              installed: true,
              version: "test",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: "2026-11-16T00:00:00Z",
              models: [
                {
                  slug: modelSelection.model,
                  name: modelSelection.model,
                  isCustom: false,
                  capabilities: null,
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ]),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([modelSelection.instanceId]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const call = service.delegateTask(callerScope, {
          task: "Review",
          mode: "async",
          clientRequestId: "real-issuer",
        });
        if (
          identity === "own" ||
          identity === "reattached_same_session" ||
          identity === "newer_run_same_session" ||
          identity === "replacement_own" ||
          identity === "restart_unbound_record"
        ) {
          const result = yield* call;
          assert.equal(result.taskId, taskId);
          assert.isTrue(dispatched);
        } else {
          const error = yield* Effect.flip(call);
          assert.equal(error.code, "parent_not_active");
          assert.equal(error.saved, false);
          assert.isFalse(dispatched, "stale or foreign credentials must not adopt a run");
        }
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }).pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, mcpRegistryLayer: registryLayer })),
    );
  }).pipe(Effect.provide(layerTestMcpRegistry)),
);

it.effect.each([
  "current",
  "replaced",
  "replaced_same_runtime",
  "revoked",
  "foreign_instance",
  "detached",
] as const)("context reset detaches the real manager-issued caller runtime: %s", (identity) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const database = SqlitePersistence.layerMemory;
    const eventStoreLayer = EventStore.layer.pipe(Layer.provide(database));
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const registryLayer = Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry);
    const runtimeLayer = ProviderReplayHarness.layerWithRegistry(
      { name: "context-reset-real-issuer" },
      Layer.unwrap(
        makeProviderAdapter(state).pipe(Effect.map(ProviderAdapterRegistry.layerSingle)),
      ),
      {
        databaseLayer: database,
        configureMcp: true,
        mcpRegistryLayer: registryLayer,
        runEffectWorker: false,
      },
    );
    yield* Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventStore.EventStoreV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const credentials = yield* McpProviderSessions.McpProviderSessions;
      const sink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const threadId = ThreadId.make("context-reset-real-issuer");
      const now = yield* DateTime.now;
      const runtimeId = yield* ids.allocate.providerSession({
        threadId,
        providerInstanceId: modelSelection.instanceId,
      });
      yield* sink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId: runtimeId,
        modelSelection,
        runtimePolicy,
      });
      const credential = (yield* credentials.read(threadId))!;
      const scope = (yield* registry.resolve(
        credential.authorizationHeader.replace(/^Bearer\s+/, ""),
      ))!;
      assert.isDefined(scope);
      assert.notEqual(scope.thread.providerSessionId, runtimeId);
      const providerThread = makeProviderThread({
        idAllocator: ids,
        threadId,
        providerSessionId: runtimeId,
        now,
      });
      const runId = ids.derive.run({ threadId, ordinal: 1 });
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            threadId,
            occurredAt: now,
            type: "provider-thread.updated",
            payload: providerThread,
          },
          {
            id: yield* ids.allocate.event({ threadId }),
            threadId,
            occurredAt: now,
            type: "run.created",
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: providerThread.id,
              userMessageId: yield* ids.allocate.message({ threadId, ordinal: 1 }),
              rootNodeId: ids.derive.rootNode({ runId }),
              activeAttemptId: null,
              status: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      let callerScope = scope;
      let expectedAttachedRuntime = runtimeId;
      if (identity === "replaced") {
        expectedAttachedRuntime = yield* ids.allocate.providerSession({
          threadId,
          providerInstanceId: modelSelection.instanceId,
        });
        yield* manager.open({
          threadId,
          providerSessionId: expectedAttachedRuntime,
          modelSelection,
          runtimePolicy,
        });
        yield* sink.write({
          events: [
            {
              id: yield* ids.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              type: "provider-thread.updated",
              payload: { ...providerThread, providerSessionId: expectedAttachedRuntime },
            },
          ],
        });
        assert.isUndefined(
          yield* registry.resolve(credential.authorizationHeader.replace(/^Bearer\s+/, "")),
        );
      }
      if (identity === "replaced_same_runtime") {
        yield* registry.revokeThread(threadId);
        const replacement = yield* registry.issue({
          threadId,
          providerInstanceId: modelSelection.instanceId,
        });
        yield* credentials.set({ ...replacement.config, runtimeProviderSessionId: runtimeId });
      }
      if (identity === "revoked") {
        yield* registry.revokeThread(threadId);
        yield* credentials.clear(threadId);
      }
      if (identity === "foreign_instance") {
        const foreign = yield* registry.issue({
          threadId,
          providerInstanceId: ProviderInstanceId.make("other"),
        });
        callerScope = (yield* registry.resolve(
          foreign.config.authorizationHeader.replace(/^Bearer\s+/, ""),
        ))!;
      }
      if (identity === "detached") {
        yield* engine.dispatch({
          type: "provider-session.detach",
          commandId: CommandId.make("already-detached"),
          threadId,
          providerSessionId: runtimeId,
        });
      }
      const afterSequence = yield* events.latestSequence({ threadId });
      const readDetachedEvents = events
        .read({ threadId, afterSequence, eventType: "provider-session.detached" })
        .pipe(Stream.runCollect);
      const commands: string[] = [];
      let queuedNotes = 0;
      const resetLayer = ContextResetService.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: engine.getThreadRecords,
            sendToThread: (input) =>
              Effect.gen(function* () {
                const dispatch = yield* engine.dispatch({
                  type: "message.dispatch",
                  commandId: input.commandId,
                  threadId: input.threadId,
                  messageId: input.messageId,
                  text: input.text,
                  attachments: input.attachments,
                  dispatchMode: { type: "queue_after_active" },
                  ...(input.contextReset === true ? { contextReset: true } : {}),
                  createdBy: input.createdBy,
                  creationSource: input.creationSource,
                });
                queuedNotes += 1;
                const projection = yield* engine.getThreadProjection(threadId);
                const message = projection.messages.find(
                  (message) => message.id === input.messageId,
                )!;
                const run = projection.runs.find((run) => run.id === message.runId)!;
                assert.equal(run.status, "queued");
                assert.isTrue(run.contextReset);
                return {
                  dispatch,
                  projection,
                  message,
                  run,
                  turnItem: null,
                  delivery: "queued" as const,
                };
              }),
            dispatch: (command) => {
              if (command.type === "provider-session.detach")
                commands.push(command.providerSessionId);
              return engine.dispatch(command);
            },
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const reset = yield* ContextResetService.ContextResetService;
        const call = reset.reset(callerScope, { note: "resume note" });
        if (identity !== "current" && identity !== "detached") {
          const error = yield* Effect.flip(call);
          assert.equal(error.code, "provider_unavailable");
          assert.equal(queuedNotes, 0);
          assert.deepEqual(commands, []);
          assert.equal((yield* readDetachedEvents).length, 0);
          assert.isTrue(
            (yield* engine.getThreadProjection(threadId)).providerSessions.some(
              (session) => session.id === expectedAttachedRuntime,
            ),
          );
          return;
        }
        const result = yield* call;
        assert.equal(queuedNotes, 1);
        if (identity === "detached") {
          assert.deepEqual(commands, []);
          assert.equal((yield* readDetachedEvents).length, 0);
          assert.include(result.note, "no session was ended");
          assert.notInclude(result.note, "Context reset scheduled");
          return;
        }
        assert.deepEqual(
          { commands, note: result.note },
          {
            commands: [runtimeId],
            note: "Context reset scheduled. Your current turn ends now; a fresh session starts with the resume note as its only context. Do not do any more work in this turn.",
          },
        );
        const detachedEvents = yield* readDetachedEvents;
        assert.equal(detachedEvents.length, 1);
        assert.equal(detachedEvents[0]?.event.type, "provider-session.detached");
        if (detachedEvents[0]?.event.type === "provider-session.detached")
          assert.equal(detachedEvents[0].event.payload.providerSessionId, runtimeId);
        assert.isFalse(
          (yield* engine.getThreadProjection(threadId)).providerSessions.some(
            (session) => session.id === runtimeId,
          ),
        );
      }).pipe(Effect.provide(resetLayer));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(runtimeLayer, IdAllocator.layer, eventStoreLayer).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(layerTestMcpRegistry)),
);
