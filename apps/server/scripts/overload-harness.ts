// @effect-diagnostics nodeBuiltinImport:off - standalone benchmark owns its process, clocks and output artifacts.
// @effect-diagnostics globalDate:off - wall-clock metadata belongs to the CLI boundary.
// @effect-diagnostics globalTimers:off - perf_hooks and inspector measure the host event loop.
// @effect-diagnostics globalTimersInEffect:off - the stall probe deliberately measures native timer lateness independently of the Effect scheduler.
// @effect-diagnostics preferSchemaOverJson:off - result artifacts and frozen numeric fixture data, not application inputs.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeInspectorPromises from "node:inspector/promises";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Tracer from "effect/Tracer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  CommandId,
  EventId,
  MessageId,
  PlanId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  KanbanBoardId,
  KanbanBoard,
  KanbanDiscussionId,
  NodeId,
  OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as ServerConfig from "../src/config.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as Sqlite from "../src/persistence/Sqlite.ts";
import * as BoardsDatabase from "../src/ardud/persistence/BoardsDatabase.ts";
import * as KanbanStore from "../src/ardud/kanban/store/KanbanStore.ts";
import * as KanbanService from "../src/ardud/kanban/engine/KanbanService.ts";
import { poolKey } from "../src/ardud/kanban/engine/rules.ts";
import * as KanbanModels from "../src/ardud/kanban/engine/models.ts";
import {
  KanbanThreads,
  KanbanThreadError,
  type KanbanThreadView,
} from "../src/ardud/kanban/engine/threads.ts";
import { opencodeTestProvider } from "../src/ardud/kanban/engine/testProviders.ts";
import { layer as providerLayer } from "../src/provider/testUtils/providerRegistryMock.ts";
import * as TextGeneration from "../src/textGeneration/TextGeneration.ts";
import * as ProjectService from "../src/project/ProjectService.ts";
import { CodexProviderCapabilitiesV2 } from "../src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as CommandReceiptStore from "../src/orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../src/orchestration-v2/EffectOutbox.ts";
import * as ProjectStore from "../src/orchestration-v2/ProjectStore.ts";
import * as TurnItemPositionStore from "../src/orchestration-v2/TurnItemPositionStore.ts";
import * as ThreadCommandExecutor from "../src/orchestration-v2/ThreadCommandExecutor.ts";
import * as RestartPacingState from "../src/ardud/restart-pacing/RestartPacingState.ts";
import * as CutoverStore from "../src/ardud/harness-migrate/CutoverStore.ts";
import * as CutoverEngine from "../src/ardud/harness-migrate/CutoverEngine.ts";
import { summarizeStatus } from "../src/ardud/harness-migrate/http.ts";
import * as ControlStore from "../src/ardud/control/ControlStore.ts";
import { boardShapes, syntheticCards } from "../src/ardud/perf/overloadShape.ts";
import { gcOverlapMs, slope, utilisation } from "../src/ardud/perf/overloadMath.ts";
import shape from "../../../scripts/overload-harness/shape.json" with { type: "json" };
import targets from "../../../scripts/overload-harness/targets.json" with { type: "json" };

const decodeBoard = Schema.decodeUnknownEffect(KanbanBoard);
const decodeRun = Schema.decodeUnknownEffect(OrchestrationV2Run);

const arg = (name: string, fallback: string) =>
  process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const warmupSeconds = Number(arg("warmup", "120"));
const steadySeconds = Number(arg("seconds", "600"));
const boardsCount = Number(arg("boards", String(shape.syntheticLoad.boards)));
const out = NodePath.resolve(arg("out", "overload-result"));
const revision = arg("revision", "UNSPECIFIED");
if (
  !Number.isFinite(warmupSeconds) ||
  warmupSeconds < 0 ||
  !Number.isFinite(steadySeconds) ||
  steadySeconds <= 0 ||
  !Number.isInteger(boardsCount) ||
  boardsCount < 2
)
  throw new Error("Invalid run configuration");
await NodeFSP.mkdir(out, { recursive: true });
const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "overload-"));
const logical: Record<string, number> = Object.fromEntries(
  [
    ...[
      "providerEvent",
      "rootStart",
      "pacing",
      "otherCommand",
      "providerTurnEnd",
      "status",
      "asks",
      "boardGet",
      "readOpenCards",
      "kanbanToolsRead",
    ].flatMap((kind) => [`offered:${kind}`, `completed:${kind}`]),
    ...["status", "asks", "boardGet", "readOpenCards", "kanbanToolsRead"].map(
      (kind) => `served:${kind}`,
    ),
    ...Object.keys(targets.eventWriteBatches.all).map((kind) => `persisted:${kind}`),
    "tickSteps",
    "dispatchDecisions",
    "providerLaunches",
    "providerSends",
    "receipts",
    "driverEvents:providerEvent",
    "driverEvents:rootStart",
    "driverEvents:command",
  ].map((key) => [key, 0]),
);
const physical: Record<string, number> = {};
const increment = (counter: Record<string, number>, key: string, n = 1) => {
  counter[key] = (counter[key] ?? 0) + n;
};
let measuring = false;
let pending = 0;
const gcEntries: Array<{ startTime: number; duration: number }> = [];
let gcWindowStart = Infinity;
const errors: Record<string, number> = {};
const backlog: Array<{ seconds: number; pending: number; outbox: number; dispatcher: number }> = [];
const resultSizes: Record<string, number> = {};
const stalls: Array<{ seconds: number; delayMs: number }> = [];
let started = 0;
const trace = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    const end = span.end.bind(span);
    let ended = false;
    span.end = (time, exit) => {
      if (measuring && ended) increment(physical, "duplicateSpanEnds");
      if (measuring && !ended) {
        if (span.name === "KanbanService.tickStep") {
          increment(logical, "tickSteps");
          increment(physical, `tickStep:${String(span.attributes.get("kanban.tick_step"))}`);
        }
        if (span.name === "KanbanService.startCard") increment(logical, "dispatchDecisions");
        if (span.name === "KanbanService.dispatchUnlocked") increment(physical, "dispatchPasses");
        if (span.name === "KanbanService.turnEndedUnlocked") increment(physical, "turnEndPasses");
        if (
          span.name === "sql.transaction" &&
          span.attributes.get("db.connection") === "writer" &&
          span.attributes.get("db.name") === "statev2.sqlite"
        )
          increment(physical, "writerTransactions");
        if (span.name === "KanbanStore.read") {
          const operation = span.attributes.get("kanban.operation");
          if (operation === "read open cards")
            increment(
              physical,
              "openCardRows",
              Number(span.attributes.get("kanban.decode.card.hits") ?? 0) +
                Number(span.attributes.get("kanban.decode.card.misses") ?? 0),
            );
        }
      }
      ended = true;
      end(time, exit);
    };
    return span;
  },
});
const config = ServerConfig.layerTest(process.cwd(), home).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
);
const persistence = Sqlite.layerConfig.pipe(Layer.provideMerge(config));
const boards = Layer.unwrap(
  Effect.gen(function* () {
    const cfg = yield* ServerConfig.ServerConfig;
    return BoardsDatabase.layerFromPaths(
      NodePath.join(NodePath.dirname(cfg.dbPath), "boards.sqlite"),
      cfg.dbPath,
    );
  }),
).pipe(Layer.provideMerge(persistence));
const stores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  CommandReceiptStore.layer,
  EffectOutbox.layer,
  ProjectStore.layer,
  TurnItemPositionStore.layer,
  KanbanStore.layer,
  ControlStore.layer,
).pipe(Layer.provideMerge(boards));
const observedEvents = Layer.effect(
  EventStore.EventStoreV2,
  Effect.map(EventStore.EventStoreV2, (base) => ({
    ...base,
    publishCommitted: (events) =>
      base.publishCommitted(events).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (measuring)
              for (const event of events)
                increment(logical, `persisted:${"event" in event ? event.event.type : event.type}`);
          }),
        ),
      ),
  })),
).pipe(Layer.provideMerge(stores));
const sinkLayer = EventSink.layerFromStores.pipe(Layer.provideMerge(observedEvents));
const cutoverStore = CutoverStore.layerWithOptions({
  snapshotPath: NodePath.join(home, "cutover-plan.json"),
}).pipe(Layer.provideMerge(sinkLayer));
const cutover = CutoverEngine.layer.pipe(
  Layer.provideMerge(cutoverStore),
  Layer.provide(
    Layer.succeed(CutoverEngine.CutoverActions, {
      plan: Effect.die(new Error("Cutover mutation disabled in benchmark")),
      apply: () => Effect.die(new Error("Cutover mutation disabled in benchmark")),
    }),
  ),
);
const pacingLayer = RestartPacingState.layer.pipe(
  Layer.provideMerge(cutover),
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provide(IdAllocator.layer),
);
const views = new Map<string, boolean>();
const activeThreads = new Set<ThreadId>();
const threadPrs = new Map<string, KanbanThreadView["prs"]>();
let launchNumber = 0;
const model = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "opus/cx/gpt-6.1-sol",
  options: [{ id: "variant", value: "xhigh" }],
};
const projectId = ProjectId.make("load-project");
const threadEvent = (threadId: ThreadId): OrchestrationV2DomainEvent => {
  const at = DateTime.makeUnsafe(Date.now());
  return {
    id: EventId.make(`created-${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: at,
    payload: {
      id: threadId,
      projectId,
      title: threadId,
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: model.instanceId,
      modelSelection: model,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
};
const threads = Layer.effect(
  KanbanThreads,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const view = Effect.fn("OverloadProvider.view")(function* (threadId: ThreadId) {
      const state = yield* projections
        .getThreadRecords(threadId, ["runs"])
        .pipe(NodeSqliteClient.readOnly, Effect.option);
      if (Option.isNone(state)) return null;
      const at = DateTime.formatIso(yield* DateTime.now);
      return {
        threadId,
        projectId,
        title: threadId,
        state: views.get(threadId) === false ? "idle" : "running",
        updatedAt: at,
        quietSince: at,
        runStartedAt: at,
        lastActivityAt: at,
        runId: `load-run-${threadId}`,
        runRequestedAt: at,
        backgroundWork: 0,
        prWatches: threadPrs.get(threadId)?.length ?? 0,
        prs: threadPrs.get(threadId) ?? [],
        archived: false,
      } satisfies KanbanThreadView;
    });
    return KanbanThreads.of({
      view,
      find: view,
      model: () => Effect.succeed(model),
      pendingUserInputs: () => Effect.succeed([]),
      lastFailure: () => Effect.succeed(null),
      findLastFailure: () => Effect.succeed(null),
      latestRun: (threadId) =>
        Effect.succeed({
          runId: `load-run-${threadId}`,
          status: views.get(threadId) === false ? "completed" : "running",
          message: null,
        }),
      runSettled: () => Effect.succeed(true),
      compactRun: () => Effect.succeed(null),
      launch: Effect.fn("OverloadProvider.launch")(function* () {
        const id = ThreadId.make(`load-launched-${launchNumber++}`);
        yield* sink.write({ events: [threadEvent(id)] }).pipe(
          Effect.mapError(
            () =>
              new KanbanThreadError({
                operation: "launch",
                detail: "Synthetic event persistence failed",
              }),
          ),
        );
        views.set(id, true);
        activeThreads.add(id);
        if (measuring) increment(logical, "providerLaunches");
        return id;
      }),
      send: (input) =>
        Effect.sync(() => {
          views.set(input.threadId, true);
          activeThreads.add(input.threadId);
          if (measuring) increment(logical, "providerSends");
        }),
      withdraw: () => Effect.void,
      setModel: () => Effect.void,
      queuedRuns: () => Effect.succeed([]),
      cancelQueued: () => Effect.succeed(false),
      interrupt: (id) =>
        Effect.sync(() => {
          views.set(id, false);
          activeThreads.delete(id);
        }),
    });
  }),
).pipe(Layer.provideMerge(pacingLayer));
const layer = KanbanService.layer.pipe(
  Layer.provide(Layer.succeed(KanbanService.OwnerRouteMode, "deferred")),
  Layer.provide(Layer.succeed(KanbanService.ReplayReads, true)),
  Layer.provide(Layer.succeed(KanbanService.DeferWriteEffects, true)),
  Layer.provideMerge(threads),
  Layer.provide(KanbanModels.layerTest(null)),
  Layer.provide(Layer.mock(TextGeneration.TextGeneration)({})),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
  ),
  Layer.provide(providerLayer([opencodeTestProvider()])),
);
const observer = new NodePerfHooks.PerformanceObserver((list) => {
  for (const entry of list.getEntries())
    if (entry.startTime + entry.duration >= gcWindowStart)
      gcEntries.push({ startTime: entry.startTime, duration: entry.duration });
});
observer.observe({ entryTypes: ["gc"] });
const lag = NodePerfHooks.monitorEventLoopDelay({ resolution: 10 });
const warnings = Logger.make(({ logLevel }) => {
  if (measuring && (logLevel === "Error" || logLevel === "Warn")) increment(errors, logLevel);
});
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const sink = yield* EventSink.EventSinkV2;
      const pacing = yield* RestartPacingState.RestartPacingState;
      const statusService = yield* CutoverEngine.HarnessCutover;
      const statusStore = yield* CutoverStore.CutoverStore;
      const sql = yield* SqlClient.SqlClient;
      const cfg = yield* ServerConfig.ServerConfig;
      yield* kanban.ready;
      const at = DateTime.formatIso(yield* DateTime.now);
      const ids: Array<ThreadId> = [];
      for (const spec of boardShapes(boardsCount)) {
        const board = yield* decodeBoard({
          id: `load-board-${spec.rank}`,
          slug: `load-${spec.rank}`,
          name: `Synthetic ${spec.rank}`,
          icon: null,
          iconImage: null,
          defaultProjectId: projectId,
          managerModel: model,
          evaluatorModel: model,
          defaultCardModel: model,
          reviewChains: [{ name: "Load", steps: [model] }],
          defaultReviewChain: "Load",
          instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
          setup: null,
          pause: null,
          nightlyReview: null,
          createdAt: at,
          archivedAt: null,
        });
        yield* store.putBoardWithPools(board, [
          { key: poolKey(model), model, slots: spec.poolSlots },
        ]);
        const rows = syntheticCards(board, spec.rank, yield* Clock.currentTimeMillis);
        for (const card of rows) {
          yield* store.putCard(card);
          const linked = card.activeThreadId ?? card.workThreadId ?? card.reviewThreadId;
          if (linked === null) continue;
          const id = ThreadId.make(linked);
          threadPrs.set(
            id,
            card.links
              .filter((link) => link.kind === "pr")
              .map((link) => ({
                url: link.url,
                title: "Synthetic PR",
                state: "open" as const,
                checks: "pending" as const,
                head: "synthetic-head",
                at,
              })),
          );
          ids.push(id);
          views.set(id, card.activeThreadId !== null);
          if (card.activeThreadId !== null) activeThreads.add(id);
          yield* sink.write({ events: [threadEvent(id)] });
          yield* store.addThreadCard(id, card.id, at);
          yield* store.putThreadLink({
            threadId: id,
            boardId: board.id,
            cardId: card.id,
            role: card.activeRole === "review" ? "review" : "work",
            purpose: null,
            discussionId: null,
            model,
            startedAt: at,
            endedAt: card.activeThreadId === null ? at : null,
            paused: null,
          });
        }
        for (let i = 0; i < spec.discussions; i++)
          yield* store.putDiscussion({
            id: KanbanDiscussionId.make(`load-disc-${spec.rank}-${i}`),
            boardId: board.id,
            cardId: null,
            title: `Synthetic discussion ${i}`,
            evaluatorThreadId: null,
            participants: [],
            lastSeq: 0,
            lastMessageAt: at,
            createdBy: { _tag: "owner" },
            createdAt: at,
            archivedAt: null,
            titleEditedAt: null,
            settledAt:
              i <
              (shape.syntheticLoad.traceTickShapes[spec.rank]?.maxStepCounts.settleDiscussion ?? 0)
                ? null
                : at,
            snoozedUntil: null,
            pinnedAt: null,
            reopenedAt: null,
          });
      }
      const pacingThread = ids[0]!;
      const runId = RunId.make("load-pacing-run");
      const now = yield* DateTime.now;
      const run = yield* decodeRun({
        id: runId,
        threadId: pacingThread,
        ordinal: 1,
        providerInstanceId: model.instanceId,
        modelSelection: model,
        providerThreadId: "load-provider-thread",
        userMessageId: "load-message",
        rootNodeId: "load-node",
        activeAttemptId: "load-attempt",
        status: "cancelled",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("load-run-created"),
            type: "run.updated",
            threadId: pacingThread,
            runId,
            occurredAt: now,
            payload: run,
          },
        ],
      });
      yield* Effect.sync(() =>
        process.stdout.write(`seeded ${ids.length} cards on ${boardsCount} boards; home=${home}\n`),
      );
      let eventNumber = 0;
      const event = (kind: string, eventType = "turn-item.updated"): OrchestrationV2DomainEvent => {
        const n = eventNumber++;
        const threadId = ids[n % ids.length]!;
        const occurredAt = DateTime.makeUnsafe(Date.now());
        const base = { id: EventId.make(`drive-${kind}-${n}`), threadId, occurredAt };
        const nodeId = NodeId.make(`load-node-${n}`);
        if (eventType === "node.updated")
          return {
            ...base,
            type: "node.updated",
            payload: {
              id: nodeId,
              threadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "tool_call",
              status: "completed",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: occurredAt,
              completedAt: occurredAt,
            },
          };
        if (eventType === "message.updated")
          return {
            ...base,
            type: "message.updated",
            payload: {
              id: MessageId.make(`load-message-${n}`),
              threadId,
              runId: null,
              nodeId: null,
              role: "assistant",
              text: "synthetic response ".repeat(64),
              phase: "unknown",
              attachments: [],
              streaming: false,
              createdAt: occurredAt,
              updatedAt: occurredAt,
              createdBy: "agent",
              creationSource: "provider",
            },
          };
        if (eventType === "provider-turn.updated")
          return {
            ...base,
            type: "provider-turn.updated",
            payload: {
              id: ProviderTurnId.make(`load-turn-${n}`),
              providerThreadId: ProviderThreadId.make(`load-native-${threadId}`),
              nodeId,
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: n + 1,
              status: "completed",
              startedAt: occurredAt,
              completedAt: occurredAt,
              finish: null,
            },
          };
        if (eventType === "plan.updated")
          return {
            ...base,
            type: "plan.updated",
            payload: {
              id: PlanId.make(`load-plan-${n}`),
              threadId,
              runId: null,
              nodeId,
              status: "active",
              kind: "proposed_plan",
              markdown: "Synthetic plan ".repeat(64),
            },
          };
        if (eventType === "provider-session.updated" || eventType === "provider-session.attached")
          return {
            ...base,
            type: eventType,
            payload: {
              id: ProviderSessionId.make(`load-session-${n % 128}`),
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: model.instanceId,
              status: "ready",
              cwd: home,
              model: model.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: occurredAt,
              updatedAt: occurredAt,
              lastError: null,
            },
          };
        return {
          ...base,
          type: "turn-item.updated",
          payload: {
            id: TurnItemId.make(`load-item-${n}`),
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: n,
            status: "completed",
            title: kind,
            startedAt: occurredAt,
            completedAt: occurredAt,
            updatedAt: occurredAt,
            type: "command_execution",
            input: "synthetic output ".repeat(64),
          },
        } satisfies OrchestrationV2DomainEvent;
      };
      const drive = Effect.fn("Overload.drive")(function* <A, E, R>(
        kind: string,
        countPerMinute: number,
        action: Effect.Effect<A, E, R>,
      ) {
        if (countPerMinute === 0) return;
        let due = NodePerfHooks.performance.now();
        while (true) {
          due += 60000 / countPerMinute;
          pending++;
          if (measuring) increment(logical, `offered:${kind}`);
          yield* Effect.forkScoped(
            action.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (measuring) increment(logical, `completed:${kind}`);
                }),
              ),
              Effect.catchCause(() =>
                Effect.sync(() => {
                  if (measuring) increment(errors, kind);
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  pending--;
                }),
              ),
            ),
          );
          yield* Effect.sleep(Math.max(0, due - NodePerfHooks.performance.now()));
        }
      });
      const kindSequences: Record<string, number> = {};
      const mixes: Record<string, ReadonlyArray<string>> = {
        providerEvent: Object.entries(targets.eventWriteBatches.parentless).flatMap(
          ([type, count]) => Array.from({ length: count }, () => type),
        ),
        rootStart: Object.entries(
          targets.eventWriteBatches.byRootCaller["ProviderTurnStartService.start"],
        ).flatMap(([type, count]) => Array.from({ length: count }, () => type)),
      };
      const write = Effect.fn("Overload.write")(function* (kind: string) {
        const sequence = kindSequences[kind] ?? 0;
        kindSequences[kind] = sequence + 1;
        const mix = mixes[kind]!;
        const type = mix[(sequence * 37) % mix.length]!;
        if (measuring) increment(logical, `offeredEventType:${type}`);
        const e = event(kind, type);
        const saved = yield* sink.write({ events: [e] });
        if (measuring) increment(logical, `driverEvents:${kind}`, saved.length);
      });
      const pacingStatus = Effect.gen(function* () {
        yield* pacing.status({ threadId: pacingThread, sourceRunId: runId }, 1);
      });
      yield* Effect.forkScoped(drive("providerEvent", 284, write("providerEvent")));
      yield* Effect.forkScoped(drive("rootStart", 200, write("rootStart")));
      yield* Effect.forkScoped(drive("pacing", 189, pacingStatus));
      yield* Effect.forkScoped(
        drive(
          "otherCommand",
          122,
          Effect.gen(function* () {
            const e = event("command");
            const receipt = yield* sink.commitCommand({
              commandId: CommandId.make(`load-command-${eventNumber}`),
              threadId: e.threadId,
              commandType: "overload.synthetic",
              acceptedAt: e.occurredAt,
              events: [e],
              effects: [],
            });
            if (measuring) {
              increment(logical, "receipts");
              increment(logical, "driverEvents:command", receipt.storedEvents.length);
            }
          }),
        ),
      );
      yield* Effect.forkScoped(kanban.worker);
      yield* Effect.forkScoped(
        kanban.tick.pipe(Effect.forkScoped, Effect.repeat(Schedule.spaced("30 seconds"))),
      );
      yield* Effect.forkScoped(
        drive(
          "providerTurnEnd",
          targets.driverCallsPerMinute.providerTurnEnd,
          Effect.suspend(() => {
            const id = activeThreads.values().next().value;
            if (id === undefined) return Effect.void;
            activeThreads.delete(id);
            views.set(id, false);
            return kanban.notifyTurnEnded(id);
          }),
        ),
      );
      const record = (name: string, size: number) => {
        if (measuring) {
          increment(logical, `served:${name}`);
          resultSizes[name] = size;
        }
      };
      yield* Effect.forkScoped(
        drive(
          "asks",
          targets.pollers.asksRequestsPerMinute,
          Effect.gen(function* () {
            const feed = yield* kanban.askFeed({});
            record("asks", feed.open.length);
          }),
        ),
      );
      yield* Effect.forkScoped(
        drive(
          "boardGet",
          targets.driverCallsPerMinute.boardGet,
          Effect.gen(function* () {
            const reply = yield* kanban.snapshot(KanbanBoardId.make("load-board-0"));
            record("boardGet", reply.cards.length);
          }),
        ),
      );
      // Distinct synthetic ledger refs reproduce the large status reply through its real service and formatter.
      const statusItems = Array.from(
        { length: Math.ceil(targets.pollers.statusReplyApproxBytes / 160) },
        (_, i) => ({
          key: `load-status:${i}`,
          kind: "thread" as const,
          ref: `load-status-thread-${i}-${"r".repeat(40)}`,
          payload: { sourceRunId: `load-source-run-${i}` },
          wake: false,
        }),
      );
      yield* statusStore.start(statusItems, []);
      yield* Effect.forkScoped(
        drive(
          "status",
          4,
          Effect.gen(function* () {
            const status = yield* statusService.status();
            const reply = { ok: true, cutover: summarizeStatus(status, false) };
            const encoded = JSON.stringify(reply);
            record("status", status.items.length);
            if (measuring) increment(physical, "statusBytes", encoded.length);
          }),
        ),
      );
      // An explicit reader poll is separate from the reads the real tick/dispatch emits.
      yield* Effect.forkScoped(
        drive(
          "readOpenCards",
          targets.driverCallsPerMinute.readOpenCards,
          Effect.gen(function* () {
            const rows = yield* store.openCards(KanbanBoardId.make("load-board-0"));
            record("readOpenCards", rows.length);
          }),
        ),
      );
      yield* Effect.forkScoped(
        drive(
          "kanbanToolsRead",
          targets.driverCallsPerMinute.kanbanToolsRead,
          Effect.gen(function* () {
            const rows = yield* store.openCards(KanbanBoardId.make("load-board-0"));
            record("kanbanToolsRead", rows.length);
          }),
        ),
      );
      yield* Effect.sleep(warmupSeconds * 1000);
      const cacheBefore = yield* store.decodeCacheStats;
      const before = NodePerfHooks.performance.eventLoopUtilization();
      started = NodePerfHooks.performance.now();
      observer.takeRecords();
      gcWindowStart = started;
      measuring = true;
      lag.enable();
      lag.reset();
      let lastProbe = NodePerfHooks.performance.now();
      const timer = setInterval(() => {
        const current = NodePerfHooks.performance.now();
        const delayMs = current - lastProbe - 100;
        lastProbe = current;
        // A one-second block can start immediately after a probe; include its sampling interval.
        if (delayMs + 100 >= 1000) stalls.push({ seconds: (current - started) / 1000, delayMs });
      }, 100);
      yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(timer)));
      const globals = globalThis as typeof globalThis & {
        __overloadDispatcherQueue?: () => Effect.Effect<number>;
        __overloadProbeHash?: string;
      };
      if (!globals.__overloadDispatcherQueue)
        return yield* Effect.die(
          new Error(
            "Run through scripts/overload-harness/run.mjs to observe the real dispatcher queue",
          ),
        );
      const queueSize = globals.__overloadDispatcherQueue;
      const sample = Effect.gen(function* () {
        const rows = yield* sql<{
          depth: number;
        }>`SELECT count(*) AS depth FROM orchestration_v2_effect_outbox WHERE status IN ('pending','running')`.pipe(
          NodeSqliteClient.readOnly,
        );
        backlog.push({
          seconds: (NodePerfHooks.performance.now() - started) / 1000,
          pending,
          outbox: rows[0]?.depth ?? 0,
          dispatcher: yield* queueSize(),
        });
      });
      yield* sample;
      yield* Effect.forkScoped(sample.pipe(Effect.repeat(Schedule.spaced("10 seconds"))));
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          if (steadySeconds < 120) return;
          yield* Effect.sleep((steadySeconds / 2 - 30) * 1000);
          const session = new NodeInspectorPromises.Session();
          session.connect();
          yield* Effect.tryPromise(() => session.post("Profiler.enable"));
          yield* Effect.tryPromise(() =>
            session.post("Profiler.setSamplingInterval", { interval: 1000 }),
          );
          yield* Effect.tryPromise(() => session.post("Profiler.start"));
          yield* Effect.sleep("60 seconds");
          const profile = yield* Effect.tryPromise(() => session.post("Profiler.stop"));
          session.disconnect();
          yield* Effect.tryPromise(() =>
            NodeFSP.writeFile(
              NodePath.join(out, "middle.cpuprofile"),
              JSON.stringify(profile.profile),
            ),
          );
        }),
      );
      yield* Effect.sleep(steadySeconds * 1000);
      const after = NodePerfHooks.performance.eventLoopUtilization();
      const gcWindowEnd = NodePerfHooks.performance.now();
      measuring = false;
      lag.disable();
      clearInterval(timer);
      yield* sample;
      const cacheAfter = yield* store.decodeCacheStats;
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      for (const entry of observer.takeRecords())
        gcEntries.push({ startTime: entry.startTime, duration: entry.duration });
      const gcMs = gcOverlapMs(gcEntries, gcWindowStart, gcWindowEnd);
      const measured = utilisation(before, after, gcMs);
      return {
        telemetrySchemaVersion: 2,
        revision,
        home,
        startedAt: at,
        completedAt: DateTime.formatIso(yield* DateTime.now),
        node: process.version,
        platform: yield* HostProcess.Platform,
        cpu: NodeOS.cpus()[0]?.model,
        cpus: NodeOS.cpus().length,
        probeHash: globals.__overloadProbeHash,
        shapeHash: NodeCrypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex"),
        targetsHash: NodeCrypto.createHash("sha256").update(JSON.stringify(targets)).digest("hex"),
        warmupSeconds,
        steadySeconds,
        boardsCount,
        runtimeFlags: process.execArgv,
        memory: process.memoryUsage(),
        dbPath: cfg.dbPath,
        ...measured,
        gcMs,
        gcWindowStart,
        gcWindowEnd,
        delayMs: {
          p50: lag.percentile(50) / 1e6,
          p99: lag.percentile(99) / 1e6,
          max: lag.max / 1e6,
        },
        stalls,
        logical,
        physical,
        resultSizes,
        errors,
        backlog,
        backlogSlopes: Object.fromEntries(
          (["pending", "outbox", "dispatcher"] as const).map((key) => [
            key,
            slope(backlog.map((p) => ({ seconds: p.seconds, value: p[key] }))),
          ]),
        ),
        cacheBefore,
        cacheAfter,
        fidelity: "UNVALIDATED",
        limitations: [
          "Status poll uses real HarnessCutover.status and summarizeStatus over a synthetic ledger; HTTP authentication/transport is outside this composition.",
          "rootStart driver currently exercises the real EventSink write path; full RunExecution start composition is pending calibration evidence.",
          "KanbanThreads is replaced in full: shell reads, failure lookup, receipts and sends are synthetic adapter behavior; timestamps refresh on view. This removes internal product work beyond the external provider boundary.",
          "Synthetic commitCommand uses effects: []; outbox pressure is not exercised by those commands.",
        ],
        verdict: "NOT_EVALUATED",
      };
    }),
  ).pipe(Effect.provide(Layer.mergeAll(layer, Logger.layer([warnings]))), Effect.withTracer(trace)),
);
observer.disconnect();
await NodeFSP.writeFile(NodePath.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
process.stdout.write(JSON.stringify(result) + "\n");
