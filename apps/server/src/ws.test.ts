import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  AuthSessionId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  OrchestrationV2GetThreadProjectionError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  WS_METHODS,
  WsSubscribeServerConfigRpc,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationProjectShell,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Headers } from "effect/http";
import { RpcGroup, RpcMessage, RpcServer } from "effect/rpc";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import { KanbanService } from "./ardud/kanban/engine/KanbanService.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfigModule from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerSettings from "./serverSettings.ts";

import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as EventSink from "./orchestration-v2/EventSink.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { loadShellSnapshotParts } from "./orchestration-v2/ShellStream.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import {
  hasCompatibleOrchestrationProtocol,
  layerWsRpc,
  resolveAvailableEditorsForConfig,
  shouldUseBoundedThreadSnapshot,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  WS_RPC_SERVER_OPTIONS,
  withLateEditorConfig,
} from "./ws.ts";

it("accepts only the current orchestration protocol before websocket RPC setup", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  assert.isFalse(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
});

it("keeps full thread snapshot fallback unless the client opts into bounded history", () => {
  assert.isFalse(shouldUseBoundedThreadSnapshot({}));
  assert.isFalse(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: false }));
  assert.isTrue(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: true }));
});

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateEditorConfig(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("sends no late snapshot when the scan matches the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["vscode"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["vscode"]),
        resolveFileManagerRevealKind: () => Effect.succeed(undefined),
      },
    ).pipe(Stream.runCollect);

    assert.equal(events.length, 0);
  }),
);

it.effect("resends a file manager reveal kind that missed the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
    ).pipe(Stream.runCollect);

    const [late] = Array.from(events);
    assert.equal(events.length, 1);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }),
);

const makeParkedWindowsLauncher = Effect.gen(function* () {
  const parkedProbes = yield* Queue.unbounded<void>();
  const release = yield* Deferred.make<void>();
  const launcher = yield* ExternalLauncher.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Queue.offer(parkedProbes, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ type: "File" } as FileSystem.File.Info),
            ),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
        ),
      ),
    ),
  );
  const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { PATH: "C:\\t3-late-editors-test", PATHEXT: ".EXE" },
          }),
        ),
      ),
    );
  return {
    editors: {
      resolveAvailableEditors: () => onWindows(launcher.resolveAvailableEditors()),
      resolveFileManagerRevealKind: () => onWindows(launcher.resolveFileManagerRevealKind()),
    },
    probeParked: Queue.take(parkedProbes),
    releaseProbes: Deferred.succeed(release, undefined),
  };
});

it.effect("recovers editors after a real scan outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    const snapshotFiber = yield* resolveAvailableEditorsForConfig(
      editors.resolveAvailableEditors(),
    ).pipe(Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(5));
    const snapshotEditors = yield* Fiber.join(snapshotFiber);
    assert.deepEqual(snapshotEditors, []);

    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: snapshotEditors }),
      Stream.empty,
      editors,
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.availableEditors.includes("vscode"), true);
    }
  }).pipe(Effect.scoped),
);

it.effect("recovers a reveal kind whose real probe outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: editors.resolveFileManagerRevealKind,
      },
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(6));
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }).pipe(Effect.scoped),
);

const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const layerNoThreadSessionUpdates = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
  observeThreadSessionUpdates: () => Effect.void,
  refreshThreadSessionUpdates: () => Effect.void,
});

const ResumeSessionTestLayer = Layer.merge(ReplayTestLayer, ProjectionStore.layerMemory);

// A real file DB and the real session manager, event store, sink and importer.
// Project metadata is deterministic so the test never launches VCS commands.
const fileReplayLayer = (filename: string) => {
  const database = SqlitePersistence.layerFromPath(filename).pipe(
    Layer.provide(NodeServices.layer),
  );
  const instanceId = ProviderInstanceId.make("codex");
  const adapter = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Unexpected provider process"),
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  const harness = ProviderReplayHarness.layerWithRegistry(
    { name: "ws-file-reader" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const application = OrchestrationEventStore.layer.pipe(Layer.provide(database));
  const stores = Layer.mergeAll(
    database,
    application,
    EventStore.layerFromOrchestrationEventStore.pipe(Layer.provide(application)),
    ProjectionStore.layer.pipe(Layer.provide(database)),
    ProjectStore.layer.pipe(Layer.provide(database)),
    harness,
  );
  const importer = LegacyV1ThreadImporter.layer.pipe(Layer.provide(stores));
  return Layer.mergeAll(stores, importer);
};

const fileReplayFixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const application = yield* OrchestrationEventStore.OrchestrationEventStore;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const now = DateTime.makeUnsafe("2026-10-30T10:00:00.000Z");
  const timestamp = DateTime.formatIso(now);
  const projectId = ProjectId.make("project:ws-reader");
  const threadId = ThreadId.make("thread:ws-reader");
  const archivedId = ThreadId.make("thread:ws-reader-archived");
  const instanceId = ProviderInstanceId.make("codex");
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Reader project', '/ws-reader', '[]', ${timestamp}, ${timestamp})`;
  const create = (id: ThreadId) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId: id,
      projectId,
      title: id === threadId ? "Reader thread" : "Archived thread",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  yield* create(threadId);
  yield* create(archivedId);
  const archivedThread = (yield* orchestrator.getThreadRecords(archivedId, [])).thread;
  const [archived] = yield* sink.write({
    events: [
      {
        id: EventId.make("ws-reader:archive"),
        type: "thread.archived",
        threadId: archivedId,
        occurredAt: now,
        payload: { ...archivedThread, archivedAt: now },
      },
    ],
  });
  assert.isDefined(archived);
  const cursor = yield* application.latestApplicationSequence;
  let ordinal = 0;
  const appendMessage = (text: string) =>
    sink.write({
      events: [
        {
          id: EventId.make(`ws-reader:message-event:${++ordinal}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: MessageId.make(`ws-reader:message:${ordinal}`),
            threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
  const first = (yield* appendMessage("one"))[0]!;
  const second = (yield* appendMessage("two"))[0]!;
  const projectEvent = yield* application.appendProjectEvent({
    type: "project.meta-updated",
    eventId: EventId.make("ws-reader:project"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: timestamp,
    commandId: CommandId.make("ws-reader:project"),
    causationEventId: null,
    correlationId: CommandId.make("ws-reader:project"),
    metadata: {},
    payload: { projectId, title: "Reader project", updatedAt: timestamp },
  });
  const changes = yield* PubSub.unbounded<ProjectEnrichment.ProjectEnrichmentChange>();
  const available = {
    repositoryIdentity: null,
    faviconPath: null,
    repositoryIdentityResolved: false,
  };
  const services = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      ensureLegacyTranscript: (id) => importer.ensureTranscript(id).pipe(Effect.asVoid),
      streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
      getThreadShell: orchestrator.getThreadShell,
      getThreadSnapshot: orchestrator.getThreadSnapshot,
      getThreadSnapshotWindow: orchestrator.getThreadSnapshotWindow,
      readShellSnapshot: orchestrator.readShellSnapshot,
    }),
    Layer.mock(ProjectService.ProjectService)({
      getShell: (id) =>
        projects.getShell(id).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectService.ProjectOperationError({
                operation: "read-project",
                projectId: id,
                cause,
              }),
          ),
        ),
    }),
    Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
      getAvailable: () => Effect.succeed(available),
      subscribeChanges: PubSub.subscribe(changes),
    }),
  );
  return {
    sql,
    sink,
    application,
    orchestrator,
    importer,
    projects,
    threadId,
    archivedId,
    projectId,
    cursor,
    first,
    second,
    projectEvent,
    appendMessage,
    changes,
    services,
    now,
  };
});

it.live("streams a synthetic large shell as bounded pages before synchronizing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ws-shell-pages-" });
    yield* Effect.gen(function* () {
      const fixture = yield* fileReplayFixture;
      const base = (yield* fixture.orchestrator.getThreadShell(fixture.threadId))!;
      const rows = Array.from({ length: 1101 }, (_, index) => ({
        ...base,
        id: ThreadId.make(`thread:${String(index).padStart(5, "0")}`),
        lastError: "x".repeat(16_000),
      }));
      const cursors: Array<string | undefined> = [];
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const events = yield* subscribeOrchestrationV2Shell({
          requestCompletionMarker: true,
          acceptShellPages: true,
        }).pipe(
          Effect.flatMap((stream) =>
            stream.pipe(
              Stream.takeUntil((item) => item.kind === "synchronized"),
              Stream.runCollect,
            ),
          ),
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            readShellSnapshot: (options) => {
              cursors.push(options?.afterThreadId);
              const selected = rows
                .filter(
                  (row) => options?.afterThreadId === undefined || row.id > options.afterThreadId,
                )
                .slice(0, options?.limit);
              return Effect.succeed(
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 0,
                  threads: selected,
                  archivedThreads: [],
                }),
              );
            },
          }),
        );
        const pages = Array.from(events).filter(
          (item): item is Extract<OrchestrationV2ShellStreamItem, { kind: "snapshot" }> =>
            item.kind === "snapshot" && item.resolvedRepositoryIdentityRoots === undefined,
        );
        assert.deepEqual(
          pages.map((item) => item.snapshot.threads.length),
          [500, 500, 101],
        );
        assert.deepEqual(
          pages.flatMap((item) => item.snapshot.threads.map((thread) => thread.id)),
          rows.map((row) => row.id),
        );
        assert.isTrue(
          pages.every((item) => Buffer.byteLength(JSON.stringify(item)) < 2 * 1024 * 1024),
        );
        assert.deepEqual(cursors, [undefined, rows[499]!.id, rows[999]!.id]);
      }).pipe(Effect.provide(fixture.services));
    }).pipe(Effect.provide(fileReplayLayer(path.join(dir, "state.sqlite"))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each([false, true])(
  "valid file-DB thread replay bypasses a held writer (bounded=%s)",
  (acceptBoundedSnapshot) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ws-thread-reader-" });
      yield* Effect.gen(function* () {
        const fixture = yield* fileReplayFixture;
        const input = {
          threadId: fixture.threadId,
          afterSequence: fixture.cursor,
          requestCompletionMarker: true,
          acceptBoundedSnapshot,
        };
        const baseline = yield* subscribeOrchestrationV2Thread(input).pipe(
          Effect.flatMap((stream) =>
            stream.pipe(
              Stream.takeUntil((item) => item.kind === "synchronized"),
              Stream.runCollect,
            ),
          ),
          Effect.scoped,
          Effect.provide(fixture.services),
        );
        assert.deepEqual(
          baseline.map((item) => item.kind),
          ["event", "event", "synchronized"],
        );
        assert.deepEqual(
          baseline.flatMap((item) =>
            item.kind === "event" ? [{ sequence: item.sequence, event: item.event }] : [],
          ),
          [fixture.first, fixture.second].map((stored) => ({
            sequence: stored.sequence,
            event: stored.event,
          })),
        );
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* fixture.sql
          .withTransaction(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(held);
        const items = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
        const consumer = yield* subscribeOrchestrationV2Thread(input).pipe(
          Effect.flatMap((stream) =>
            stream.pipe(Stream.runForEach((item) => Queue.offer(items, item))),
          ),
          Effect.scoped,
          Effect.provide(fixture.services),
          Effect.forkScoped,
        );
        const replay = yield* Effect.all([
          Queue.take(items),
          Queue.take(items),
          Queue.take(items),
        ]).pipe(
          Effect.timeout("10 seconds"),
          Effect.onError(() => Deferred.succeed(release, undefined)),
        );
        assert.deepEqual(Array.from(replay), Array.from(baseline));
        assert.isFalse(yield* Deferred.isDone(release));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
        const [tail] = yield* fixture.appendMessage("after release");
        const delivered = yield* Queue.take(items).pipe(Effect.timeout("10 seconds"));
        assert.equal(delivered.kind, "event");
        if (delivered.kind === "event") {
          assert.equal(delivered.sequence, tail!.sequence);
          assert.deepEqual(delivered.event, tail!.event);
        }
        assert.equal(yield* Queue.size(items), 0);
        yield* Fiber.interrupt(consumer);
      }).pipe(Effect.provide(fileReplayLayer(path.join(dir, "state.sqlite"))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "replays shell changes and reads initial, archive and enrichment while a writer is held",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ws-shell-reader-" });
      yield* Effect.gen(function* () {
        const fixture = yield* fileReplayFixture;
        const input = { afterSequence: fixture.cursor, requestCompletionMarker: true };
        const throughSync = subscribeOrchestrationV2Shell(input).pipe(
          Effect.flatMap((stream) =>
            stream.pipe(
              Stream.takeUntil((item) => item.kind === "synchronized"),
              Stream.runCollect,
            ),
          ),
          Effect.scoped,
          Effect.provide(fixture.services),
        );
        const baseline = Array.from(yield* throughSync);
        assert.deepEqual(
          baseline.map((item) => item.kind),
          ["thread.updated", "project.updated", "synchronized"],
        );
        assert.equal(
          baseline[0]?.kind === "thread.updated" ? baseline[0].sequence : 0,
          fixture.second.sequence,
        );
        assert.equal(
          baseline[1]?.kind === "project.updated" ? baseline[1].sequence : 0,
          fixture.projectEvent.sequence,
        );
        // Clients that omit idle subagents resume from the cursor event itself, so ancestor rows
        // sent at an already-applied sequence come again; everything after it is unchanged.
        const optedIn = Array.from(
          yield* subscribeOrchestrationV2Shell({ ...input, omitIdleSubagents: true }).pipe(
            Effect.flatMap((stream) =>
              stream.pipe(
                Stream.takeUntil((item) => item.kind === "synchronized"),
                Stream.runCollect,
              ),
            ),
            Effect.scoped,
            Effect.provide(fixture.services),
          ),
        );
        assert.equal(
          optedIn[0] !== undefined && "sequence" in optedIn[0] ? optedIn[0].sequence : -1,
          fixture.cursor,
        );
        assert.deepEqual(optedIn.slice(1), baseline);
        // The replay budget covers the cursor event too: when it alone is over budget the
        // opted-in client gets a snapshot, not a replay.
        const overBudgetAtCursor = Layer.succeed(OrchestrationEventStore.OrchestrationEventStore, {
          ...fixture.application,
          getReplayStats: (range) =>
            fixture.application
              .getReplayStats(range)
              .pipe(
                Effect.map((stats) =>
                  range.afterSequence < fixture.cursor
                    ? { ...stats, rawPayloadBytes: Number.MAX_SAFE_INTEGER }
                    : stats,
                ),
              ),
        });
        const [firstOverBudget] = yield* subscribeOrchestrationV2Shell({
          ...input,
          omitIdleSubagents: true,
        }).pipe(
          Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect)),
          Effect.scoped,
          Effect.provide(Layer.mergeAll(fixture.services, overBudgetAtCursor)),
        );
        assert.equal(firstOverBudget?.kind, "snapshot");
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* fixture.sql
          .withTransaction(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(held);
        const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const consumer = yield* subscribeOrchestrationV2Shell(input).pipe(
          Effect.flatMap((stream) =>
            stream.pipe(Stream.runForEach((item) => Queue.offer(items, item))),
          ),
          Effect.scoped,
          Effect.provide(fixture.services),
          Effect.forkScoped,
        );
        const replay = yield* Effect.all([
          Queue.take(items),
          Queue.take(items),
          Queue.take(items),
        ]).pipe(
          Effect.timeout("10 seconds"),
          Effect.onError(() => Deferred.succeed(release, undefined)),
        );
        assert.deepEqual(replay, baseline);

        const initial = yield* subscribeOrchestrationV2Shell({
          requestCompletionMarker: true,
        }).pipe(
          Effect.flatMap((stream) =>
            stream.pipe(
              Stream.takeUntil((item) => item.kind === "synchronized"),
              Stream.runCollect,
            ),
          ),
          Effect.scoped,
          Effect.provide(fixture.services),
          Effect.timeout("10 seconds"),
          Effect.onError(() => Deferred.succeed(release, undefined)),
        );
        const initialSnapshot = initial.find((item) => item.kind === "snapshot");
        assert.equal(initialSnapshot?.kind, "snapshot");
        if (initialSnapshot?.kind === "snapshot") {
          assert.isTrue(
            initialSnapshot.snapshot.threads.some((thread) => thread.id === fixture.threadId),
          );
          assert.isTrue(
            initialSnapshot.snapshot.projects.some((project) => project.id === fixture.projectId),
          );
          assert.isFalse(
            initialSnapshot.snapshot.threads.some((thread) => thread.id === fixture.archivedId),
          );
        }
        const archive = yield* loadShellSnapshotParts({
          sql: fixture.sql,
          readThreads: fixture.orchestrator.readShellSnapshot({ location: "archive" }),
          listProjects: fixture.projects.listShells(),
          latestSequence: fixture.application.latestApplicationSequence,
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.onError(() => Deferred.succeed(release, undefined)),
        );
        assert.isTrue(
          archive.threads.archivedThreads.some((thread) => thread.id === fixture.archivedId),
        );
        assert.equal(archive.snapshotSequence, fixture.projectEvent.sequence);

        const identity = {
          canonicalKey: "test:ws-reader",
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: "https://example.test/repo.git",
          },
        };
        yield* PubSub.publish(fixture.changes, {
          workspaceRoot: "/ws-reader",
          enrichment: {
            repositoryIdentity: identity,
            faviconPath: null,
            repositoryIdentityResolved: true,
          },
          repositoryIdentityResolved: true,
        });
        const enriched = yield* Queue.take(items).pipe(
          Effect.timeout("10 seconds"),
          Effect.onError(() => Deferred.succeed(release, undefined)),
        );
        assert.equal(enriched.kind, "snapshot");
        if (enriched.kind === "snapshot") {
          assert.equal(enriched.snapshot.snapshotSequence, fixture.projectEvent.sequence);
          assert.deepEqual(enriched.snapshot.projects[0]?.repositoryIdentity, identity);
        }
        assert.isFalse(yield* Deferred.isDone(release));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
        const [tail] = yield* fixture.appendMessage("shell live");
        const live = yield* Queue.take(items).pipe(Effect.timeout("10 seconds"));
        assert.equal(live.kind, "thread.updated");
        if (live.kind === "thread.updated") assert.equal(live.sequence, tail!.sequence);
        assert.equal(yield* Queue.size(items), 0);
        yield* Fiber.interrupt(consumer);
      }).pipe(Effect.provide(fileReplayLayer(path.join(dir, "state.sqlite"))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("keeps an opted-in OpenCode refresh write on the writer during resume", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ws-refresh-writer-" });
    yield* Effect.gen(function* () {
      const fixture = yield* fileReplayFixture;
      const instanceId = ProviderInstanceId.make("opencode");
      const session: OrchestrationV2ProviderSession = {
        id: ProviderSessionId.make("session:ws-refresh"),
        driver: ProviderDriverKind.make("opencode"),
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/ws-reader",
        model: "test-model",
        capabilities: {
          ...CodexProviderCapabilitiesV2,
          sessions: {
            ...CodexProviderCapabilitiesV2.sessions,
            supportsMultipleProviderThreadsPerSession: true,
          },
        },
        createdAt: fixture.now,
        updatedAt: fixture.now,
        lastError: null,
      };
      yield* fixture.sink.write({
        events: [
          {
            id: EventId.make("ws-reader:session-attached"),
            type: "provider-session.attached",
            threadId: fixture.threadId,
            driver: session.driver,
            providerInstanceId: instanceId,
            occurredAt: fixture.now,
            payload: session,
          },
        ],
      });
      const cursor = yield* fixture.application.latestAgentSequence(fixture.threadId);
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* fixture.sql
        .withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      const prepared = yield* Deferred.make<void>();
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const sessions = Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, {
        ...manager,
        refreshThreadSessionUpdates: (id) =>
          Deferred.succeed(prepared, undefined).pipe(
            Effect.andThen(manager.refreshThreadSessionUpdates(id)),
          ),
      });
      const running = yield* subscribeOrchestrationV2Thread({
        threadId: fixture.threadId,
        afterSequence: cursor,
        requestCompletionMarker: true,
      }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
        Effect.scoped,
        Effect.provide(Layer.merge(fixture.services, sessions)),
        Effect.forkScoped,
      );
      yield* Deferred.await(prepared).pipe(
        Effect.timeout("10 seconds"),
        Effect.onError(() => Deferred.succeed(release, undefined)),
      );
      // The writer admits only after release. The real refresh may finish its
      // reader preflight now, but must not perform the write on that reader.
      assert.isFalse(yield* Deferred.isDone(release));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      const replay = yield* Fiber.join(running).pipe(Effect.timeout("10 seconds"));
      assert.deepEqual(
        replay.map((item) => item.kind),
        ["event", "synchronized"],
      );
      const update = replay[0];
      assert.equal(update?.kind, "event");
      if (update?.kind === "event") {
        assert.equal(update.event.type, "provider-session.updated");
        assert.isAbove(update.sequence, cursor);
        if (update.event.type === "provider-session.updated")
          assert.equal(update.event.payload.id, session.id);
        const persisted = yield* fixture.application
          .readAgentEvents({
            threadId: fixture.threadId,
            afterSequence: cursor,
            throughSequence: update.sequence,
          })
          .pipe(Stream.runCollect);
        assert.equal(persisted.length, 1);
        assert.equal(persisted[0]?.sequence, update.sequence);
        assert.equal(persisted[0]?.event.type, "provider-session.updated");
      }
    }).pipe(Effect.provide(fileReplayLayer(path.join(dir, "state.sqlite"))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const makeSessionResumeFixture = Effect.fn("makeSessionResumeFixture")(function* (
  options: {
    readonly pauseRefresh?: boolean;
    readonly interveningEvent?: boolean;
    readonly failAt?: "initial-head" | "refreshed-head" | "refresh-read" | "refresh-commit";
    readonly binding?: "missing" | "deleted" | "archived" | "unbound" | "codex" | "opencode-v1";
  } = {},
) {
  const store = yield* OrchestrationEventStore.OrchestrationEventStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.makeUnsafe("2026-10-30T10:00:00.000Z");
  const threadId = ThreadId.make("thread:resume:C");
  const carrierId = ThreadId.make("thread:resume:A");
  const instanceId = ProviderInstanceId.make("resume-provider");
  const driver = ProviderDriverKind.make(options.binding === "codex" ? "codex" : "opencode");
  const modelSelection = { instanceId, model: "resume-model" };
  const session: OrchestrationV2ProviderSession = {
    id: ProviderSessionId.make("session:resume"),
    driver,
    providerInstanceId: instanceId,
    status: "ready",
    cwd: "/resume-fixture",
    model: modelSelection.model,
    capabilities: {
      ...CodexProviderCapabilitiesV2,
      sessions: {
        ...CodexProviderCapabilitiesV2.sessions,
        supportsMultipleProviderThreadsPerSession: options.binding !== "opencode-v1",
      },
    },
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  const thread: OrchestrationV2ThreadProjection["thread"] = {
    id: threadId,
    projectId: ProjectId.make("project:resume"),
    title: "Restored C",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: options.binding === "archived" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: options.binding === "deleted" ? now : null,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: MessageId.make("message:restored"),
    threadId,
    runId: RunId.make("run:restored"),
    nodeId: null,
    role: "user",
    text: "Authoritative restored message",
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: RunId.make("run:restored"),
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: message.id,
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
  let eventOrdinal = 0;
  const eventBase = (id = threadId) => ({
    id: EventId.make(`resume:event:${++eventOrdinal}`),
    threadId: id,
    occurredAt: now,
  });
  const append = Effect.fn("sessionResumeFixture.append")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    const committed = yield* sql.withTransaction(
      Effect.gen(function* () {
        const events = yield* store.appendAgentEvents({ events: [event] });
        if (!(options.binding === "missing" && event.threadId === threadId)) {
          yield* projections.apply(event);
        }
        return events;
      }),
    );
    yield* store.publishCommitted(committed);
    return committed[0]!;
  });
  // SQLite allocates every sequence, including the unrelated gap. A misplaced
  // refresh really advances C from 40 to 1001 and masks its stale cursor 50.
  const padThrough = Effect.fn("sessionResumeFixture.padThrough")(function* (head: number) {
    const current = yield* store.latestApplicationSequence;
    const count = head - current;
    assert.isAbove(count, 0);
    yield* sql`
      WITH RECURSIVE padding(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM padding WHERE n < ${count}
      )
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) SELECT
        'resume:padding:' || ${current} || ':' || n, 'thread', ${carrierId}, ${current} + n,
        'provider-session.detached', ${DateTime.formatIso(now)}, 'server',
        ${JSON.stringify({ providerSessionId: "session:unrelated", detachedAt: DateTime.formatIso(now) })},
        '{}', 2
      FROM padding
    `;
  });
  yield* append({ ...eventBase(), type: "thread.created", payload: thread });
  yield* append({ ...eventBase(), type: "message.updated", payload: message });
  yield* append({ ...eventBase(), type: "run.created", payload: run });
  if (options.binding !== "unbound") {
    yield* append({ ...eventBase(), type: "provider-session.attached", payload: session });
  }
  const cachedProjection =
    options.binding === "missing" ? null : yield* projections.getThreadProjection(threadId);
  yield* padThrough(39);
  yield* append({ ...eventBase(), type: "message.updated", payload: message });
  yield* append({
    ...eventBase(carrierId),
    type: "thread.created",
    payload: {
      ...thread,
      id: carrierId,
      lineage: { ...thread.lineage, rootThreadId: carrierId },
      archivedAt: null,
      deletedAt: null,
    },
  });
  yield* append({
    ...eventBase(carrierId),
    type: "provider-session.attached",
    payload: session,
  });
  yield* padThrough(999);
  yield* append({
    ...eventBase(carrierId),
    type: "provider-session.updated",
    payload: { ...session, status: "running" },
  });
  assert.equal(yield* store.latestAgentSequence(threadId), 40);
  assert.equal(yield* store.latestAgentSequence(carrierId), 1000);
  assert.equal(yield* store.latestApplicationSequence, 1000);

  const calls: string[] = [];
  const observers = { active: 0 };
  const refreshStarted = yield* Queue.unbounded<void>();
  const refreshGate = yield* Deferred.make<void>();
  if (!options.pauseRefresh) yield* Deferred.succeed(refreshGate, undefined);
  let headReads = 0;
  const readError = new PersistenceSqlError({ operation: "resume-fixture.read" });
  const commitError = new EventSink.EventSinkWriteError({ eventCount: 1 });
  const appendMessage = Effect.fn("sessionResumeFixture.appendMessage")(function* (text: string) {
    return yield* append({
      ...eventBase(),
      type: "message.updated",
      payload: { ...message, text },
    });
  });
  const snapshot = (method: "full" | "bounded") =>
    Effect.gen(function* () {
      calls.push(`snapshot:${method}`);
      return {
        schemaVersion: 2,
        snapshotSequence: yield* store.latestAgentSequence(threadId),
        projection: yield* projections.getThreadProjection(threadId),
      };
    }).pipe(Effect.orDie);
  const layers = Layer.mergeAll(
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      observeThreadSessionUpdates: (observedId) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            assert.equal(observedId, threadId);
            calls.push(`observe:${++observers.active}`);
          }),
          () => Effect.sync(() => calls.push(`release:${--observers.active}`)),
        ).pipe(Effect.asVoid),
      refreshThreadSessionUpdates: (refreshedId) =>
        Effect.gen(function* () {
          assert.equal(refreshedId, threadId);
          calls.push("refresh:start");
          yield* Queue.offer(refreshStarted, undefined);
          yield* Deferred.await(refreshGate);
          if (options.failAt === "refresh-read") return yield* Effect.fail(readError);
          const records = yield* projections.getThreadRecords(threadId, ["providerSessions"]).pipe(
            Effect.catchTags({
              ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
            }),
          );
          if (
            records === null ||
            records.thread.deletedAt !== null ||
            records.thread.archivedAt !== null
          ) {
            calls.push("refresh:skipped");
            return;
          }
          for (const canonical of records.providerSessions) {
            if (
              canonical.driver !== "opencode" ||
              !canonical.capabilities.sessions.supportsMultipleProviderThreadsPerSession
            )
              continue;
            if (options.failAt === "refresh-commit") return yield* Effect.fail(commitError);
            const stored = yield* append({
              ...eventBase(),
              type: "provider-session.updated",
              driver: canonical.driver,
              providerInstanceId: canonical.providerInstanceId,
              payload: canonical,
            });
            calls.push(`refresh:commit:${stored.sequence}`);
          }
          if (options.interveningEvent) {
            const stored = yield* appendMessage("Ordinary event between refresh and second head");
            calls.push(`intervening:commit:${stored.sequence}`);
          }
        }).pipe(
          Effect.mapError(
            (cause) => new ProviderSessionManager.ProviderSessionRefreshError({ threadId, cause }),
          ),
        ),
    }),
    Layer.succeed(OrchestrationEventStore.OrchestrationEventStore, {
      ...store,
      latestAgentSequence: (requestedId) =>
        Effect.gen(function* () {
          assert.equal(requestedId, threadId);
          headReads++;
          if (
            (headReads === 1 && options.failAt === "initial-head") ||
            (headReads === 2 && options.failAt === "refreshed-head")
          ) {
            calls.push(`head:error:${headReads}`);
            return yield* Effect.fail(readError);
          }
          const head = yield* store.latestAgentSequence(requestedId);
          calls.push(`head:${head}`);
          return head;
        }),
      getAgentReplayStats: (input) => {
        assert.equal(input.threadId, threadId);
        calls.push(`stats:${input.afterSequence}:${input.throughSequence}`);
        return store.getAgentReplayStats(input);
      },
      readAgentEvents: (input) => {
        assert.equal(input?.threadId, threadId);
        calls.push(`replay:${input?.afterSequence}:${input?.throughSequence}`);
        return store.readAgentEvents(input);
      },
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      ensureLegacyTranscript: (hydratedId) =>
        Effect.sync(() => {
          assert.equal(hydratedId, threadId);
          calls.push("legacy");
        }),
      getThreadSnapshot: () => snapshot("full"),
      getThreadSnapshotWindow: () => snapshot("bounded"),
      streamStoredEventsFrom: (input) => {
        assert.equal(input?.threadId, threadId);
        calls.push(`tail:${input?.afterSequence}`);
        return store.streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 }).pipe(
          Stream.filter(
            (stored): stored is OrchestrationV2StoredEvent =>
              "event" in stored && stored.event.threadId === threadId,
          ),
          Stream.mapError(
            (cause) => new Orchestrator.OrchestratorDomainEventStreamError({ cause }),
          ),
        );
      },
    }),
  );
  const open = (input: Omit<Parameters<typeof subscribeOrchestrationV2Thread>[0], "threadId">) =>
    subscribeOrchestrationV2Thread({ threadId, ...input }).pipe(Effect.provide(layers));
  const throughSync = (input: Parameters<typeof open>[0]) =>
    open(input).pipe(
      Effect.flatMap((stream) =>
        stream.pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        ),
      ),
    );
  return {
    threadId,
    cachedProjection,
    calls,
    observers,
    readError,
    commitError,
    open,
    throughSync,
    appendMessage,
    refreshStarted: Queue.take(refreshStarted),
    releaseRefresh: Deferred.succeed(refreshGate, undefined),
    head: store.latestAgentSequence(threadId),
    events: (afterSequence = 40) =>
      store.readAgentEvents({ threadId, afterSequence }).pipe(Stream.runCollect),
  };
});

it.live.each([false, true])(
  "ahead-of-head OpenCode 2 resume snapshots before refresh despite a higher unrelated global head (bounded=%s)",
  (acceptBoundedSnapshot) =>
    Effect.gen(function* () {
      const fixture = yield* makeSessionResumeFixture();
      let tailSequence = 0;
      const items = yield* fixture
        .open({
          afterSequence: 50,
          requestCompletionMarker: true,
          acceptBoundedSnapshot,
        })
        .pipe(
          Effect.flatMap((stream) =>
            stream.pipe(
              Stream.tap((item) =>
                Effect.gen(function* () {
                  if (item.kind !== "synchronized") return;
                  assert.equal(fixture.observers.active, 1);
                  tailSequence = (yield* fixture.appendMessage("Live after restored snapshot"))
                    .sequence;
                }),
              ),
              Stream.takeUntil((item) => item.kind === "event" && item.sequence === tailSequence),
              Stream.runCollect,
            ),
          ),
          Effect.scoped,
        );
      assert.deepEqual(
        items.map((item) => item.kind),
        ["snapshot", "synchronized", "event"],
      );
      const snapshot = items[0];
      assert.equal(snapshot?.kind, "snapshot");
      if (snapshot?.kind !== "snapshot") return yield* Effect.die("Missing restored snapshot");
      assert.equal(snapshot.snapshotSequence, 40);
      assert.deepEqual(
        snapshot.projection.messages.map(({ id, text }) => ({ id, text })),
        [
          {
            id: MessageId.make("message:restored"),
            text: "Authoritative restored message",
          },
        ],
      );
      assert.deepEqual(
        snapshot.projection.runs.map(({ id, status }) => ({ id, status })),
        [
          {
            id: RunId.make("run:restored"),
            status: "completed",
          },
        ],
      );
      assert.equal(snapshot.projection.providerSessions[0]?.status, "running");
      assert.deepEqual(fixture.calls, [
        "observe:1",
        "legacy",
        "head:40",
        `snapshot:${acceptBoundedSnapshot ? "bounded" : "full"}`,
        "tail:40",
        "release:0",
      ]);
      assert.equal(fixture.observers.active, 0);
      assert.equal(tailSequence, 1001);
      assert.deepEqual(
        (yield* fixture.events()).map((stored) => stored.event.type),
        ["message.updated"],
      );
    }).pipe(Effect.provide(ResumeSessionTestLayer)),
);

it.live.each([
  { acceptBoundedSnapshot: false, interveningEvent: false },
  { acceptBoundedSnapshot: true, interveningEvent: false },
  { acceptBoundedSnapshot: false, interveningEvent: true },
  { acceptBoundedSnapshot: true, interveningEvent: true },
])("valid restored cursor replays through the post-refresh thread head (%j)", (options) =>
  Effect.gen(function* () {
    const fixture = yield* makeSessionResumeFixture(options);
    const highWater = options.interveningEvent ? 1002 : 1001;
    let tailSequence = 0;
    const items = yield* fixture
      .open({
        afterSequence: 40,
        requestCompletionMarker: true,
        acceptBoundedSnapshot: options.acceptBoundedSnapshot,
      })
      .pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.tap((item) =>
              Effect.gen(function* () {
                if (item.kind !== "synchronized") return;
                tailSequence = (yield* fixture.appendMessage("Buffered live tail")).sequence;
              }),
            ),
            Stream.takeUntil((item) => item.kind === "event" && item.sequence === tailSequence),
            Stream.runCollect,
          ),
        ),
        Effect.scoped,
      );
    assert.deepEqual(fixture.calls, [
      "observe:1",
      "legacy",
      "head:40",
      "refresh:start",
      "refresh:commit:1001",
      ...(options.interveningEvent ? ["intervening:commit:1002"] : []),
      `head:${highWater}`,
      `stats:40:${highWater}`,
      `replay:40:${highWater}`,
      `tail:${highWater}`,
      "release:0",
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      options.interveningEvent
        ? ["event", "event", "synchronized", "event"]
        : ["event", "synchronized", "event"],
    );
    assert.deepEqual(
      items.flatMap((item) => (item.kind === "event" ? [item.sequence] : [])),
      options.interveningEvent ? [1001, 1002, 1003] : [1001, 1002],
    );
    const refreshed = items[0];
    assert.equal(refreshed?.kind, "event");
    if (refreshed?.kind !== "event") return yield* Effect.die("Missing session refresh");
    assert.equal(refreshed.event.type, "provider-session.updated");
    if (refreshed.event.type !== "provider-session.updated")
      return yield* Effect.die("Wrong refresh type");
    assert.equal(refreshed.event.threadId, fixture.threadId);
    assert.equal(refreshed.event.payload.status, "running");
    assert.deepEqual(refreshed.event.payload, {
      ...fixture.cachedProjection!.providerSessions[0]!,
      status: "running",
    });
    if (options.interveningEvent) {
      const ordinary = items[1];
      assert.equal(
        ordinary?.kind === "event" && ordinary.event.type === "message.updated"
          ? ordinary.event.payload.text
          : null,
        "Ordinary event between refresh and second head",
      );
    }
    assert.equal(fixture.observers.active, 0);
  }).pipe(Effect.provide(ResumeSessionTestLayer)),
);

it.live.each([false, true])(
  "OpenCode 2 resume replays a canonical session refresh without replacing history (bounded=%s)",
  (acceptBoundedSnapshot) =>
    Effect.gen(function* () {
      const fixture = yield* makeSessionResumeFixture({ pauseRefresh: true });
      assert.equal(fixture.cachedProjection?.providerSessions[0]?.status, "ready");
      const firstItems = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
      const secondItems = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
      const subscribe = (
        afterSequence: number,
        items: Queue.Queue<OrchestrationV2ThreadStreamItem>,
      ) =>
        fixture.open({ afterSequence, requestCompletionMarker: true, acceptBoundedSnapshot }).pipe(
          Effect.flatMap((stream) =>
            stream.pipe(Stream.runForEach((item) => Queue.offer(items, item))),
          ),
          Effect.scoped,
          Effect.forkChild,
        );
      const first = yield* subscribe(40, firstItems);
      yield* fixture.refreshStarted;
      assert.deepEqual(fixture.calls, ["observe:1", "legacy", "head:40", "refresh:start"]);
      assert.equal(fixture.observers.active, 1);
      assert.equal(yield* fixture.head, 40);
      assert.isEmpty(yield* fixture.events());
      yield* fixture.releaseRefresh;
      const refresh = yield* Queue.take(firstItems);
      assert.equal(refresh.kind, "event");
      if (refresh.kind !== "event") return yield* Effect.die("Missing canonical refresh");
      assert.equal(refresh.sequence, 1001);
      assert.equal(
        refresh.event.type === "provider-session.updated" ? refresh.event.payload.status : null,
        "running",
      );
      assert.equal((yield* Queue.take(firstItems)).kind, "synchronized");
      assert.deepEqual(fixture.calls, [
        "observe:1",
        "legacy",
        "head:40",
        "refresh:start",
        "refresh:commit:1001",
        "head:1001",
        "stats:40:1001",
        "replay:40:1001",
        "tail:1001",
      ]);

      const live = yield* fixture.appendMessage("First client's live tail");
      const firstTail = yield* Queue.take(firstItems);
      assert.equal(firstTail.kind === "event" ? firstTail.sequence : null, live.sequence);
      const second = yield* subscribe(1001, secondItems);
      yield* fixture.refreshStarted;
      const secondReplay = yield* Queue.take(secondItems);
      const secondRefresh = yield* Queue.take(secondItems);
      assert.equal(secondReplay.kind === "event" ? secondReplay.sequence : null, 1002);
      assert.equal(secondRefresh.kind === "event" ? secondRefresh.sequence : null, 1003);
      assert.equal((yield* Queue.take(secondItems)).kind, "synchronized");
      const sharedTail = yield* Queue.take(firstItems);
      assert.equal(sharedTail.kind === "event" ? sharedTail.sequence : null, 1003);
      assert.equal(fixture.observers.active, 2);
      yield* Fiber.interrupt(first);
      assert.equal(fixture.observers.active, 1);
      assert.equal(fixture.calls.at(-1), "release:1");
      const remainingLive = yield* fixture.appendMessage("Second client stays subscribed");
      const secondTail = yield* Queue.take(secondItems);
      assert.equal(
        secondTail.kind === "event" ? secondTail.sequence : null,
        remainingLive.sequence,
      );
      yield* Fiber.interrupt(second);
      assert.equal(fixture.observers.active, 0);

      let cursor = remainingLive.sequence;
      for (const reason of ["application-active", "application-active-probe", "navigation-back"]) {
        const callStart = fixture.calls.length;
        const items = yield* fixture
          .throughSync({
            afterSequence: cursor,
            requestCompletionMarker: true,
            acceptBoundedSnapshot,
          })
          .pipe(Effect.scoped);
        assert.deepEqual(
          items.map((item) => item.kind),
          ["event", "synchronized"],
          reason,
        );
        assert.deepEqual(
          fixture.calls.slice(callStart),
          [
            "observe:1",
            "legacy",
            `head:${cursor}`,
            "refresh:start",
            `refresh:commit:${cursor + 1}`,
            `head:${cursor + 1}`,
            `stats:${cursor}:${cursor + 1}`,
            `replay:${cursor}:${cursor + 1}`,
            `tail:${cursor + 1}`,
            "release:0",
          ],
          reason,
        );
        const item = items[0];
        assert.equal(
          item?.kind === "event" && item.event.type === "provider-session.updated"
            ? item.event.payload.status
            : null,
          "running",
          reason,
        );
        cursor++;
      }
      assert.isFalse(fixture.calls.some((call) => call.startsWith("snapshot:")));
      assert.equal(fixture.observers.active, 0);
    }).pipe(Effect.scoped, Effect.provide(ResumeSessionTestLayer)),
);

it.live.each(["initial-head", "refreshed-head", "refresh-read", "refresh-commit"] as const)(
  "thread resume fails without synchronizing and releases its observer on %s failure",
  (failAt) =>
    Effect.gen(function* () {
      const fixture = yield* makeSessionResumeFixture({ failAt });
      const items: OrchestrationV2ThreadStreamItem[] = [];
      const error = yield* fixture.open({ afterSequence: 40, requestCompletionMarker: true }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.runForEach((item) =>
              Effect.sync(() => {
                items.push(item);
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.flip,
      );
      assert.instanceOf(error, OrchestrationV2GetThreadProjectionError);
      assert.isEmpty(items);
      assert.equal(fixture.observers.active, 0);
      assert.isFalse(fixture.calls.some((call) => /^(snapshot|stats|replay|tail):/.test(call)));
      if (failAt === "initial-head") {
        assert.deepEqual(fixture.calls, ["observe:1", "legacy", "head:error:1", "release:0"]);
        assert.equal(error.cause, fixture.readError);
      } else if (failAt === "refreshed-head") {
        assert.deepEqual(fixture.calls, [
          "observe:1",
          "legacy",
          "head:40",
          "refresh:start",
          "refresh:commit:1001",
          "head:error:2",
          "release:0",
        ]);
        assert.equal(error.cause, fixture.readError);
      } else {
        assert.deepEqual(fixture.calls, [
          "observe:1",
          "legacy",
          "head:40",
          "refresh:start",
          "release:0",
        ]);
        assert.instanceOf(error.cause, ProviderSessionManager.ProviderSessionRefreshError);
        if (Schema.is(ProviderSessionManager.ProviderSessionRefreshError)(error.cause)) {
          assert.equal(
            error.cause.cause,
            failAt === "refresh-read" ? fixture.readError : fixture.commitError,
          );
        }
      }
      assert.equal((yield* fixture.events()).length, failAt === "refreshed-head" ? 1 : 0);
    }).pipe(Effect.provide(ResumeSessionTestLayer)),
);

it.live.each(["missing", "deleted", "archived", "unbound", "codex", "opencode-v1"] as const)(
  "thread resume keeps ordinary replay when session refresh has no eligible binding (%s)",
  (binding) =>
    Effect.gen(function* () {
      const fixture = yield* makeSessionResumeFixture({ binding });
      const items = yield* fixture
        .throughSync({ afterSequence: 39, requestCompletionMarker: true })
        .pipe(Effect.scoped);
      assert.deepEqual(
        items.map((item) => item.kind),
        ["event", "synchronized"],
      );
      const replayed = items[0];
      assert.equal(replayed?.kind === "event" ? replayed.sequence : null, 40);
      assert.equal(
        replayed?.kind === "event" && replayed.event.type === "message.updated"
          ? replayed.event.payload.text
          : null,
        "Authoritative restored message",
      );
      assert.deepEqual(fixture.calls, [
        "observe:1",
        "legacy",
        "head:40",
        "refresh:start",
        ...(["missing", "deleted", "archived"].includes(binding) ? ["refresh:skipped"] : []),
        "head:40",
        "stats:39:40",
        "replay:39:40",
        "tail:40",
        "release:0",
      ]);
      assert.isEmpty(yield* fixture.events());
      assert.equal(fixture.observers.active, 0);
    }).pipe(Effect.provide(ResumeSessionTestLayer)),
);

it.live.each([false, true])(
  "cold thread detail observes before snapshot without refreshing (bounded=%s)",
  (acceptBoundedSnapshot) =>
    Effect.gen(function* () {
      const fixture = yield* makeSessionResumeFixture();
      const items = yield* fixture
        .throughSync({ requestCompletionMarker: true, acceptBoundedSnapshot })
        .pipe(Effect.scoped);
      assert.deepEqual(
        items.map((item) => item.kind),
        ["snapshot", "synchronized"],
      );
      assert.deepEqual(fixture.calls, [
        "observe:1",
        "legacy",
        `snapshot:${acceptBoundedSnapshot ? "bounded" : "full"}`,
        "tail:40",
        "release:0",
      ]);
      assert.isEmpty(yield* fixture.events());
    }).pipe(Effect.provide(ResumeSessionTestLayer)),
);

it.live("cancelling a paused resume refresh releases the thread observer without a write", () =>
  Effect.gen(function* () {
    const fixture = yield* makeSessionResumeFixture({ pauseRefresh: true });
    const fiber = yield* fixture
      .throughSync({ afterSequence: 40, requestCompletionMarker: true })
      .pipe(Effect.scoped, Effect.forkChild);
    yield* fixture.refreshStarted;
    assert.equal(fixture.observers.active, 1);
    yield* Fiber.interrupt(fiber);
    assert.deepEqual(fixture.calls, [
      "observe:1",
      "legacy",
      "head:40",
      "refresh:start",
      "release:0",
    ]);
    assert.equal(fixture.observers.active, 0);
    assert.isEmpty(yield* fixture.events());
  }).pipe(Effect.scoped, Effect.provide(ResumeSessionTestLayer)),
);

it.live.each(["thread", "shell"] as const)(
  "%s resume skips unknown types, synchronizes, and receives the live tail",
  (scope) =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread:replay");
      const projectId = ProjectId.make("project:replay");
      const project = {
        id: projectId,
        title: "Replay",
        workspaceRoot: "/tmp/replay",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const insert = (version: number, unknown = false) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`replay:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${unknown ? "future.event" : scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:replay", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
      const [before] = yield* insert(0);
      yield* insert(1, true);
      const [after] = yield* insert(2);
      const [highWater] = yield* insert(3, true);
      const updates = yield* PubSub.unbounded();
      let liveSequence = 0;
      const consume = <A extends { readonly kind: string; readonly sequence?: number }, E, R>(
        stream: Stream.Stream<A, E, R>,
      ) =>
        stream.pipe(
          Stream.tap((item) =>
            Effect.gen(function* () {
              if (item.kind !== "synchronized") return;
              const [live] = yield* insert(4);
              liveSequence = live!.sequence;
              const events = yield* store
                .readApplicationEvents({
                  afterSequence: highWater!.sequence,
                  throughSequence: liveSequence,
                })
                .pipe(Stream.runCollect);
              yield* store.publishCommitted(events);
            }),
          ),
          Stream.takeUntil((item) => item.sequence === liveSequence),
          Stream.map((item) => ({ kind: item.kind as string, sequence: item.sequence })),
          Stream.runCollect,
        );
      const subscription = Effect.gen(function* () {
        return scope === "thread"
          ? yield* subscribeOrchestrationV2Thread({
              threadId,
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume))
          : yield* subscribeOrchestrationV2Shell({
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume));
      });
      const items = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          streamStoredEventsFrom: (
            input: Parameters<
              ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
            >[0],
          ) => {
            assert.equal(input?.afterSequence, highWater!.sequence);
            return store
              .streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 })
              .pipe(
                Stream.filter((event): event is OrchestrationV2StoredEvent => "event" in event),
              );
          },
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(updates),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
      );
      assert.deepEqual(
        items.map((item) => item.kind),
        scope === "thread"
          ? ["event", "synchronized", "event"]
          : ["project.updated", "synchronized", "project.updated"],
      );
      assert.deepEqual(
        items.flatMap((item) => (item.sequence === undefined ? [] : [item.sequence])),
        [after!.sequence, liveSequence],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(ReplayTestLayer, layerNoThreadSessionUpdates)),
    ),
);

// Build the production RPC layer; unrelated capabilities fail if this test calls them.
const layerUnusedConfigRpcServices = Layer.mergeAll(
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AnalyticsService.AnalyticsService)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(PortScanner.PortDiscovery)({}),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  layerNoThreadSessionUpdates,
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RelayClient.RelayClient)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(SessionStore.SessionStore)({ cookieName: "config-test", legacyCookieName: undefined }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(KanbanService)({ attachmentPath: () => null }),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
).pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(
      ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-config-subscription-test-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "preserves settings during discovery and keybindings during snapshot ACK at the config RPC boundary",
  () =>
    Effect.gen(function* () {
      const keybindings = yield* Keybindings.Keybindings;
      const settings = yield* ServerSettings.ServerSettingsService;
      const keybindingsSubscribed = yield* Deferred.make<void>();
      const settingsSubscribed = yield* Deferred.make<void>();
      const keybindingsChanges = keybindings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(keybindingsSubscribed, undefined)),
      );
      const settingsChanges = settings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(settingsSubscribed, undefined)),
      );
      const initialKeybindings = (yield* keybindings.getSnapshot).keybindings;
      const discoveryStarted = yield* Deferred.make<void>();
      const finishDiscovery = yield* Deferred.make<void>();
      const responses = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const configRpcServices = Layer.mergeAll(
        layerUnusedConfigRpcServices,
        Layer.mock(ExternalLauncher.ExternalLauncher)({
          resolveAvailableEditors: () =>
            Deferred.succeed(discoveryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishDiscovery)),
              Effect.as([]),
            ),
          resolveFileManagerRevealKind: () => Effect.succeed(undefined),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          streamChanges: Stream.never,
        }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({ streamChanges: Stream.make([]) }),
        Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
          resolveTargets: () => Effect.succeed([]),
        }),
        Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          scratchRoot: Effect.succeedNone,
          namedProjectsRoot: process.cwd(),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("config-test"),
            label: "Config test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          getDescriptor: () =>
            Effect.succeed({
              policy: "loopback-browser",
              bootstrapMethods: [],
              sessionMethods: ["browser-session-cookie"],
              sessionCookieName: "config-test-session",
            }),
        }),
        // Signal subscription on either accessor so the test also fails, rather
        // than hangs, against a handler that subscribes after the snapshot.
        Layer.succeed(Keybindings.Keybindings, {
          ...keybindings,
          streamChanges: Stream.unwrap(keybindingsChanges),
          subscribeChanges: keybindingsChanges,
        }),
        Layer.succeed(ServerSettings.ServerSettingsService, {
          ...settings,
          streamChanges: Stream.unwrap(settingsChanges),
          subscribeChanges: settingsChanges,
        }),
      );
      const server = yield* RpcServer.makeNoSerialization(
        RpcGroup.make(WsSubscribeServerConfigRpc),
        {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Chunk"
              ? Effect.forEach(response.values, (event) => Queue.offer(responses, event), {
                  discard: true,
                })
              : Effect.void,
        },
      ).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make("config-test"),
              subject: "config-test",
              method: "browser-session-cookie",
              scopes: [],
            },
            {},
            {},
            yield* PreviewAutomationBroker.PreviewAutomationBroker,
            yield* ServerBrowser.ServerBrowser,
          ).pipe(Layer.provide(configRpcServices)),
        ),
      );
      const requestId = RpcMessage.RequestId("config");
      const acknowledge = server.write(0, { _tag: "Ack", requestId });
      yield* server.write(0, {
        _tag: "Request",
        id: requestId,
        tag: WS_METHODS.subscribeServerConfig,
        payload: {},
        headers: Headers.empty,
      });
      yield* Deferred.await(discoveryStarted);

      const duringDiscovery = yield* settings.updateSettings({ defaultAutoPull: true });
      yield* Deferred.succeed(finishDiscovery, undefined);
      const snapshot = yield* Queue.take(responses);
      assert.equal(snapshot.type, "snapshot");
      if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
      assert.isFalse(snapshot.config.settings.defaultAutoPull);
      assert.deepEqual(snapshot.config.keybindings, initialKeybindings);
      const duringAck = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+y",
        command: "terminal.toggle",
      });
      yield* acknowledge;
      yield* Deferred.await(keybindingsSubscribed);
      yield* Deferred.await(settingsSubscribed);

      // Later updates expose a dropped buffered event as a value mismatch, not a timeout.
      const latestSettings = yield* settings.updateSettings({ enableProviderUpdateChecks: false });
      const latestKeybindings = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+z",
        command: "terminal.split",
      });
      const expectedSettings = [duringDiscovery, latestSettings].map(
        ServerSettings.redactServerSettingsForClient,
      );
      const expectedKeybindings = [duringAck, latestKeybindings];
      // The two sources can interleave, but each must retain its own publication order.
      for (let i = 0; i < 4; i++) {
        const event = yield* Queue.take(responses);
        if (event.type === "settingsUpdated") {
          assert.deepEqual(event.payload.settings, expectedSettings.shift());
        } else {
          assert.equal(event.type, "keybindingsUpdated");
          if (event.type !== "keybindingsUpdated")
            return yield* Effect.die("Unexpected config event");
          assert.deepEqual(event.payload.keybindings, expectedKeybindings.shift());
          assert.deepEqual(event.payload.issues, []);
        }
        yield* acknowledge;
      }
      assert.isEmpty(expectedSettings);
      assert.isEmpty(expectedKeybindings);
      yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
      Effect.scoped,
    ),
);

// Compaction keeps the oldest and newest event per message, so a cursor older
// than the deleted rows still replays each message where the client would
// first have seen it (reducers append on first sight) and reaches the same
// final state. No snapshot fallback is needed.
it.effect("thread resume across compacted history keeps message order and final state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = "2026-10-13T00:00:00.000Z";
    const threadId = ThreadId.make("thread:compacted");
    const insertMessage = (version: number, id: string, text: string) => sql<{
      sequence: number;
    }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`compacted:${version}`}, 'thread', ${threadId}, ${version}, 'message.updated',
        ${now}, 'server', ${JSON.stringify({
          createdBy: "user",
          creationSource: "web",
          id,
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        })}, '{}', 2
      ) RETURNING sequence
    `;
    const [first] = yield* insertMessage(0, "message:a", "a created");
    const [second] = yield* insertMessage(1, "message:b", "b created");
    yield* insertMessage(2, "message:a", "a superseded");
    const [head] = yield* insertMessage(3, "message:a", "a final");
    // thread.deleted is never superseded: clients switch on the event type.
    for (const version of [0, 1]) {
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`deleted:${version}`}, 'thread', 'thread:deleted-twice', ${version}, 'thread.deleted',
          ${now}, 'server', '{}', '{}', 2
        )
      `;
    }
    // Only the event between a's first and newest is deleted.
    assert.equal((yield* maintenance.compactEventStore).deletedEventCount, 1);

    const items = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: first!.sequence - 1,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap((stream) =>
        stream.pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        ),
      ),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () => Stream.never,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      Array.from(items, (item) =>
        item.kind === "event"
          ? [item.sequence, item.event.type === "message.updated" ? item.event.payload.text : null]
          : [item.kind],
      ),
      [
        [first!.sequence, "a created"],
        [second!.sequence, "b created"],
        [head!.sequence, "a final"],
        ["synchronized"],
      ],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        layerNoThreadSessionUpdates,
        ProjectionMaintenance.layer.pipe(
          Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
          Layer.provideMerge(ReplayTestLayer),
        ),
      ),
    ),
  ),
);
