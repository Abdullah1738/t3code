import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type KanbanBoard,
  type KanbanCard,
  type KanbanDiscussion,
  type KanbanPool,
  type KanbanThreadLink,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type Project,
  type ScheduledTask,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../../orchestration-v2/ProviderSessionManager.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Schedules from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Settings from "../../serverSettings.ts";
import * as Kanban from "../kanban/engine/KanbanService.ts";
import * as Rules from "../kanban/engine/rules.ts";
import * as BoardStore from "../kanban/store/KanbanStore.ts";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";
import { kanbanDDL } from "../persistence/kanbanSchema.ts";
import { readBlockRetry, writeBlockRetry, type BlockRetry } from "../schedules/runFollow.ts";
import * as Actions from "./CutoverActions.ts";
import * as PendingContext from "./CutoverContext.ts";
import * as CutoverEngine from "./CutoverEngine.ts";
import * as Input from "./CutoverInput.ts";
import * as Readiness from "./CutoverReadiness.ts";
import * as CutoverStore from "./CutoverStore.ts";
import { cutoverThreadReleased } from "./cutoverClaim.ts";
import { projectOverrideRef } from "./settingsPlan.ts";

const at = "2026-11-05T00:00:00.000Z";
const now = DateTime.makeUnsafe(at);
const projectId = ProjectId.make("project:cutover-fixture");
const legacy = (model: string, effort = "xhigh"): ModelSelection => ({
  instanceId: ProviderInstanceId.make("opencode"),
  model,
  options: [{ id: "variant", value: effort }],
});
const opus = legacy("opus/claude-opus-5-5");
const sol = legacy("opus/cx/gpt-6.1-sol");
const terra = legacy("opus/cx/gpt-6.1-terra", "max");
const glm = legacy("surplus/glm-5.3-flash", "high");
const nativeOpus: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "xhigh" }],
};
const nativeSol: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "xhigh" }],
};
const nativeTerra: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex-cu"),
  model: "gpt-6.1-terra",
  options: [{ id: "reasoningEffort", value: "max" }],
};

const board: KanbanBoard = {
  id: KanbanBoardId.make("board:cutover-fixture"),
  slug: "cutover-fixture",
  name: "Cutover fixture",
  icon: null,
  iconImage: null,
  defaultProjectId: projectId,
  managerModel: legacy("opus/cc/claude-haiku-5-5"),
  evaluatorModel: opus,
  defaultCardModel: opus,
  reviewChains: [{ name: "review", steps: [sol, terra] }],
  defaultReviewChain: "review",
  instructions: {
    modelRouting: "Keep routing",
    reviewerRouting: "Keep review",
    escalation: "Ask owner",
  },
  setup: null,
  pause: { reason: "Harness cutover", keep: [], at, by: "owner" },
  createdAt: at,
  archivedAt: null,
};
const pool = (model: ModelSelection, slots: number): KanbanPool => ({
  key: Rules.poolKey(model),
  model,
  slots,
});
const pools = [pool(opus, 3), pool(sol, 2), pool(glm, 1)];
const worker = ThreadId.make("board:worker");
const reviewer = ThreadId.make("board:reviewer");
const evaluator = ThreadId.make("board:evaluator");
const discussionThread = ThreadId.make("board:discussion");
const discussionId = KanbanDiscussionId.make("discussion:existing");

const card = (id: string, number: number, overrides: Partial<KanbanCard> = {}): KanbanCard => ({
  id: KanbanCardId.make(id),
  boardId: board.id,
  number,
  title: `Existing packet ${number}`,
  description: "Keep branch, owner asks, review round, and packet",
  prompt: "Continue the existing work",
  subtasks: [],
  subtaskSeq: 0,
  stage: "todo",
  priority: 2,
  goalId: null,
  projects: [],
  model: opus,
  models: [
    { model: opus, weight: 7 },
    { model: sol, weight: 2 },
  ],
  projectId,
  links: [
    {
      kind: "pr",
      url: "https://github.com/example/repo/pull/17",
      label: "Existing PR",
      state: "open",
      checkedAt: at,
    },
  ],
  blockedBy: [],
  stalled: { reason: "Stopped for cutover", by: { _tag: "owner" }, at },
  question: null,
  asks: [
    {
      id: "ask:open",
      text: "Keep my deployment question",
      blocking: false,
      by: { _tag: "owner" },
      at,
      seq: null,
      closedAt: null,
    },
    {
      id: "ask:closed",
      text: "Already answered",
      blocking: false,
      by: { _tag: "owner" },
      at,
      seq: null,
      closedAt: at,
    },
  ],
  reviewChain: "review",
  reviewStep: 0,
  reviewRound: 2,
  activeThreadId: null,
  activeRole: null,
  activePool: null,
  workThreadId: null,
  reviewThreadId: null,
  discussionId: null,
  wakeNote: "Keep carry-on note",
  nudgedAt: null,
  settledAt: null,
  createdBy: { _tag: "owner" },
  createdAt: at,
  updatedAt: at,
  movedAt: at,
  ...overrides,
});
const stoppedWork = card("card:stopped-work", 1, { workThreadId: worker });
const stoppedReview = card("card:stopped-review", 2, {
  workThreadId: ThreadId.make("board:previous-worker"),
  reviewThreadId: reviewer,
});
const pinned = card("card:pinned-settled", 3, { stage: "verified", settledAt: at, stalled: null });
const occupying = card("card:working", 4, {
  stage: "working",
  activeThreadId: ThreadId.make("board:occupying"),
  activeRole: "work",
  activePool: pools[0]!.key,
  stalled: null,
});
const cards = [stoppedWork, stoppedReview, pinned, occupying];
const link = (
  threadId: ThreadId,
  role: KanbanThreadLink["role"],
  model: ModelSelection,
  overrides: Partial<KanbanThreadLink> = {},
): KanbanThreadLink => ({
  threadId,
  boardId: board.id,
  cardId: null,
  role,
  purpose: null,
  discussionId: null,
  model,
  startedAt: at,
  endedAt: null,
  paused: null,
  ...overrides,
});
const links = [
  link(worker, "work", opus, { cardId: stoppedWork.id, endedAt: at }),
  link(reviewer, "review", sol, { cardId: stoppedReview.id, endedAt: at }),
  link(evaluator, "evaluator", opus, { purpose: "request" }),
  link(discussionThread, "evaluator", sol, { purpose: `discussion:${discussionId}`, discussionId }),
];
const discussion: KanbanDiscussion = {
  id: discussionId,
  boardId: board.id,
  cardId: null,
  title: "Existing owner discussion",
  evaluatorThreadId: discussionThread,
  participants: [],
  lastSeq: 0,
  lastMessageAt: null,
  createdBy: { _tag: "owner" },
  createdAt: at,
  archivedAt: null,
  titleEditedAt: at,
  settledAt: null,
  snoozedUntil: null,
  pinnedAt: at,
  reopenedAt: null,
};

const makeThread = (
  id: string,
  selection = opus,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  id: ThreadId.make(id),
  projectId,
  title: id,
  createdBy: "user",
  creationSource: "server",
  providerInstanceId: selection.instanceId,
  modelSelection: selection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: "existing-branch",
  worktreePath: "/fixture/existing-worktree",
  activeProviderThreadId: ProviderThreadId.make(`source:${id}`),
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  settledAt: null,
  settledOverride: null,
  lastVisitedAt: null,
  ...overrides,
});
const makeRun = (
  thread: OrchestrationV2AppThread,
  status: OrchestrationV2Run["status"],
  ordinal = 1,
  selection = thread.modelSelection,
): OrchestrationV2Run => ({
  id: RunId.make(`run:${thread.id}:${ordinal}`),
  threadId: thread.id,
  ordinal,
  providerInstanceId: selection.instanceId,
  modelSelection: selection,
  providerThreadId: thread.activeProviderThreadId,
  userMessageId: MessageId.make(`message:${thread.id}:${ordinal}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: status === "queued" ? null : now,
  completedAt: ["completed", "interrupted"].includes(status) ? now : null,
  checkpointId: null,
  contextHandoffId: null,
  ...(status === "queued" ? { queueHeld: true, queuePosition: ordinal } : {}),
});
const turnItems = (
  thread: OrchestrationV2AppThread,
  run: OrchestrationV2Run,
): readonly OrchestrationV2TurnItem[] => {
  const base = {
    threadId: thread.id,
    runId: run.id,
    nodeId: null,
    providerThreadId: thread.activeProviderThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  return [
    {
      ...base,
      id: TurnItemId.make(`item:${thread.id}:user`),
      ordinal: 1,
      type: "user_message",
      messageId: run.userMessageId,
      createdBy: "user",
      creationSource: "server",
      inputIntent: "turn_start",
      text: `Last actual request for ${thread.id}`,
      attachments: [],
    },
    {
      ...base,
      id: TurnItemId.make(`item:${thread.id}:assistant`),
      ordinal: 2,
      type: "assistant_message",
      messageId: MessageId.make(`answer:${thread.id}`),
      text: "Already sent this answer; do not repeat it",
      streaming: false,
    },
    {
      ...base,
      id: TurnItemId.make(`item:${thread.id}:summary`),
      ordinal: 3,
      type: "compaction",
      driver: ProviderDriverKind.make("opencode"),
      summary: "Keep the existing branch and outstanding owner decision",
    },
  ];
};
const projection = (
  thread: OrchestrationV2AppThread,
  status: OrchestrationV2Run["status"] = "completed",
): OrchestrationV2ThreadProjection => {
  const run = makeRun(thread, status);
  return {
    thread,
    runs: [run],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: turnItems(thread, run),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
    providerThreads: [
      {
        id: thread.activeProviderThreadId!,
        driver: ProviderDriverKind.make("opencode"),
        providerInstanceId: thread.providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${thread.id}`),
        appThreadId: thread.id,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("opencode"),
          nativeId: `ses_source_${thread.id}`,
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
};
const fixtureThreads = () => [
  projection(makeThread(worker)),
  projection(makeThread(reviewer, sol)),
  projection(makeThread(evaluator)),
  projection(makeThread(discussionThread, sol)),
  projection(makeThread("ordinary:idle")),
  projection(makeThread("ordinary:running", sol), "running"),
  projection(makeThread("ordinary:interrupted", terra), "interrupted"),
  projection(makeThread("imessage:idle", opus, { projectId: ProjectId.make("project:imessage") })),
  projection(
    makeThread("imessage:interrupted", opus, { projectId: ProjectId.make("project:imessage") }),
    "interrupted",
  ),
  projection(makeThread("unrelated:queued", glm)),
  projection(makeThread("archived", opus, { archivedAt: now })),
  projection(makeThread("deleted", opus, { deletedAt: now })),
];
const project: Project = {
  id: projectId,
  title: "Fixture project",
  workspaceRoot: "/fixture/project",
  defaultModelSelection: sol,
  scripts: [],
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
};
const task: ScheduledTask = {
  id: ScheduledTaskId.make("schedule:fixture"),
  title: "Existing schedule",
  prompt: "Do scheduled work",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: terra,
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "server",
  createdAt: at,
  updatedAt: at,
  nextRunAt: "2026-11-05T01:00:00.000Z",
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 7,
};
const retry: BlockRetry = {
  fallbacks: [sol, glm, opus],
  limits: { runtimeMode: "approval-required", interactionMode: "plan" },
};
const initialSettings = (): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  defaultModelSelection: opus,
  textGenerationModelSelection: sol,
  sourceControlWriterModelSelection: opus,
  reviewGuideModelSelection: terra,
  favorites: [
    { provider: opus.instanceId, model: opus.model },
    { provider: glm.instanceId, model: glm.model },
  ],
  providerModelPreferences: { [opus.instanceId]: { hiddenModels: [opus.model], modelOrder: [] } },
  projectSettingsOverrides: {
    [projectId]: { textGenerationModelSelection: sol, responseStreamingMode: "paragraph" },
  },
});
const database = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-actions-" });
    return Layer.mergeAll(
      BoardStore.layer,
      CutoverStore.layerWithOptions({ snapshotPath: path.join(directory, "plan.json") }),
    ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

const splitDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-actions-split-" });
    const boardContext = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
    const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(boardContext));
    for (const ddl of kanbanDDL) yield* sql.unsafe(ddl);
    return Layer.mergeAll(
      BoardStore.layer,
      CutoverStore.layerWithOptions({ snapshotPath: path.join(directory, "plan.json") }),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(BoardsDatabase.BoardsDatabase, { sql, ready: Effect.void, path: ":memory:" }),
      ),
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    );
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeHarness = Effect.fn("CutoverActionsTest.make")(function* (
  options: {
    readonly threads?: readonly OrchestrationV2ThreadProjection[];
    readonly input?: Input.CutoverInput;
    readonly withBoard?: boolean;
    readonly withDefaults?: boolean;
    readonly withFallback?: boolean;
    readonly pageSize?: number;
    readonly realPendingContext?: boolean;
  } = {},
) {
  const store = yield* BoardStore.KanbanStore;
  const sql = yield* BoardsDatabase.client;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "cutover-actions-state-" });
  const config = { stateDir, baseDir: stateDir } as ServerConfig.ServerConfig["Service"];
  const realPending = options.realPendingContext
    ? yield* PendingContext.CutoverContext.pipe(
        Effect.provide(
          PendingContext.layer.pipe(
            Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
          ),
        ),
      )
    : undefined;
  const records = new Map(
    (options.threads ?? fixtureThreads()).map((entry) => [entry.thread.id, entry]),
  );
  const get = (id: string) => {
    const found = records.get(ThreadId.make(id));
    assert.isDefined(found, `Missing fixture thread ${id}`);
    return found!;
  };
  const replace = (id: string, patch: Partial<OrchestrationV2ThreadProjection>) =>
    records.set(ThreadId.make(id), { ...get(id), ...patch });
  const queuedParent = records.get(ThreadId.make("unrelated:queued"));
  if (queuedParent)
    replace(queuedParent.thread.id, {
      runs: [...queuedParent.runs, makeRun(queuedParent.thread, "queued", 2, sol)],
    });
  let currentSettings =
    options.withDefaults === false ? { ...DEFAULT_SERVER_SETTINGS } : initialSettings();
  let currentProject = project;
  let currentTask = task;
  let failAdoptions = false;
  let failSends = false;
  let liveRuntime: Option.Option<ProviderAdapter.ProviderAdapterV2SessionRuntime> = Option.none();
  let nativeActive = 0;
  let accepted = false;
  let acceptOnSend = true;
  const commands: OrchestrationV2ServerCommand[] = [];
  const sends: Threads.ThreadManagementSendInput[] = [];
  const interrupts: Threads.ThreadManagementInterruptInput[] = [];
  const contexts: Parameters<PendingContext.CutoverContext["Service"]["put"]>[0][] = [];
  const removedContexts: string[] = [];
  const fileWrites: { path: string; text: string }[] = [];
  const settingsWrites: ServerSettingsPatch[] = [];
  const projectWrites: Projects.ProjectUpdateInput[] = [];
  const scheduleWrites: Parameters<
    Schedules.ScheduledTaskService["Service"]["migrateModelSelection"]
  >[0][] = [];
  const restorations: Parameters<Kanban.KanbanService["Service"]["restoreCutoverCard"]>[0][] = [];
  const pageReads: Parameters<
    Projections.ProjectionStoreV2["Service"]["listCutoverCandidates"]
  >[0][] = [];
  const readinessTargets: (readonly ModelSelection[])[] = [];
  const peeks: ProviderSessionId[] = [];
  const receipts = new Set<string>();
  let shellReads = 0;
  if (options.withBoard !== false) {
    yield* store.putBoardWithPools(board, pools);
    for (const entry of cards) yield* store.putCard(entry);
    for (const entry of links) yield* store.putThreadLink(entry);
    yield* store.putDiscussion(discussion);
  }
  if (options.withFallback !== false) yield* writeBlockRetry(sql, task, retry);
  const input =
    options.input ??
    ({
      version: 1,
      stoppedCards:
        options.withBoard === false
          ? []
          : [
              { n: 1, id: stoppedWork.id, thread: worker, stage: "working" },
              { n: 2, id: stoppedReview.id, thread: reviewer, stage: "in_review" },
            ],
      interruptedThreads: [...records.values()].flatMap((entry) =>
        entry.runs
          .filter((run) => run.status === "interrupted")
          .map((run) => ({ threadId: entry.thread.id, runId: run.id })),
      ),
    } satisfies Input.CutoverInput);
  const getThreadRecords: Orchestrator.OrchestratorV2["Service"]["getThreadRecords"] = (
    id,
    _fields,
    filter,
  ) =>
    Effect.sync(() => {
      const current = get(id);
      return {
        ...current,
        messages: current.messages.filter(
          (message) =>
            !filter?.messageRunIds ||
            (message.runId !== null && filter.messageRunIds.includes(message.runId)),
        ),
        turnItems: current.turnItems.filter(
          (item) =>
            (!filter?.turnItemTypes || filter.turnItemTypes.includes(item.type)) &&
            (!filter?.turnItemRunIds ||
              (item.runId !== null && filter.turnItemRunIds.includes(item.runId))),
        ),
      };
    });
  const owners = Layer.mergeAll(
    Layer.mock(ServerConfig.ServerConfig)(config),
    Layer.succeed(Path.Path, path),
    Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (path, text) =>
          Effect.sync(() => {
            fileWrites.push({ path, text });
          }).pipe(Effect.andThen(fs.writeFileString(path, text))),
      }),
    ),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.sync(() => currentSettings),
      updateSettings: (patch) =>
        Effect.sync(() => {
          settingsWrites.push(patch);
          currentSettings = { ...currentSettings, ...patch } as ServerSettings;
          return currentSettings;
        }),
      updateSettingsIf: (update) =>
        Effect.sync(() => {
          const patch = update(currentSettings);
          if (patch === null) return false;
          settingsWrites.push(patch);
          currentSettings = { ...currentSettings, ...patch } as ServerSettings;
          return true;
        }),
    }),
    Layer.mock(Projects.ProjectService)({
      listShells: () => Effect.sync(() => (options.withDefaults === false ? [] : [currentProject])),
      getById: () => Effect.sync(() => Option.some(currentProject)),
      update: (value) =>
        Effect.sync(() => {
          projectWrites.push(value);
          currentProject = {
            ...currentProject,
            defaultModelSelection: value.defaultModelSelection ?? null,
          };
          return currentProject;
        }),
    }),
    Layer.mock(Schedules.ScheduledTaskService)({
      list: () =>
        Effect.sync(() => ({ tasks: options.withDefaults === false ? [] : [currentTask] })),
      migrateModelSelection: (value) =>
        Effect.sync(() => {
          scheduleWrites.push(value);
          currentTask = { ...currentTask, modelSelection: value.next };
          return true;
        }),
    }),
    Layer.mock(Projections.ProjectionStoreV2)({
      listCutoverCandidates: (request) =>
        Effect.sync(() => {
          pageReads.push(request);
          const candidates = [...records.values()]
            .map((entry) => entry.thread)
            .sort((a, b) => a.id.localeCompare(b.id));
          const start =
            request.afterThreadId === undefined
              ? 0
              : candidates.findIndex((entry) => entry.id === request.afterThreadId) + 1;
          const page = candidates.slice(
            start,
            start + Math.min(options.pageSize ?? 4, request.limit),
          );
          return {
            threads: page,
            nextThreadId: start + page.length < candidates.length ? page.at(-1)!.id : null,
          };
        }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadRecords,
      getShellSnapshot: () =>
        Effect.sync(() => {
          shellReads += 1;
          const active = Array.from({ length: nativeActive }, (_, index) => {
            const entry = projection(makeThread(`native:${index}`, nativeOpus), "running");
            return Projections.threadShellFromProjection(entry);
          });
          return { schemaVersion: 1, snapshotSequence: 0, threads: active, archivedThreads: [] };
        }),
      dispatch: (value) =>
        Effect.gen(function* () {
          commands.push(value);
          if (value.type === "thread.adopt-native-history" && failAdoptions)
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: value.commandId,
              commandType: value.type,
              cause: "Native adoption unavailable",
            });
          if (value.type === "thread.adopt-native-history" || value.type === "provider.switch") {
            const current = get(value.threadId);
            replace(value.threadId, {
              thread: {
                ...current.thread,
                providerInstanceId: value.modelSelection.instanceId,
                modelSelection: value.modelSelection,
              },
            });
          } else if (value.type === "queued-run.rebind-selection") {
            replace(value.threadId, {
              runs: get(value.threadId).runs.map((run) =>
                run.id === value.runId
                  ? {
                      ...run,
                      providerInstanceId: value.modelSelection.instanceId,
                      modelSelection: value.modelSelection,
                    }
                  : run,
              ),
            });
          } else if (value.type === "thread.runtime-mode.set") {
            replace(value.threadId, {
              thread: { ...get(value.threadId).thread, runtimeMode: value.runtimeMode },
            });
          }
          return { sequence: commands.length, storedEvents: [] };
        }),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      hasReceipt: (id) => Effect.sync(() => receipts.has(id)),
      interruptThread: (value) =>
        Effect.sync(() => {
          interrupts.push(value);
          return { type: "no_active_run" as const };
        }),
      sendToThread: (value) =>
        Effect.gen(function* () {
          sends.push(value);
          if (failSends)
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: value.commandId,
              commandType: "message.dispatch",
              cause: "Native send unavailable",
            });
          receipts.add(value.commandId);
          if (acceptOnSend) accepted = true;
          // The action ignores the owner's return value; only delivery inputs are under test.
          return {} as Threads.ThreadManagementSendResult;
        }),
    }),
    Layer.mock(Kanban.KanbanService)({
      attachmentPath: () => "unused",
      boards: store.boards.pipe(Effect.orDie),
      withSelectionMigrationLock: (effect) => effect,
      restoreCutoverCard: (value) =>
        Effect.sync(() => {
          restorations.push(value);
        }),
      pauseBoard: (id) =>
        Effect.gen(function* () {
          const current = (yield* store.boards.pipe(Effect.orDie)).find(
            (entry) => entry.id === id,
          )!;
          const next = { ...current, pause: null };
          yield* store.putBoard(next).pipe(Effect.orDie);
          return next;
        }),
    }),
    Layer.mock(Input.CutoverInputSource)({ read: Effect.succeed(input) }),
    Layer.mock(Readiness.CutoverReadiness)({
      check: (targets) =>
        Effect.sync(() => {
          readinessTargets.push(targets);
          return [{ id: "fixture-native", ready: true, reason: "healthy" }];
        }),
    }),
    realPending
      ? Layer.succeed(PendingContext.CutoverContext, {
          ...realPending,
          put: (value) =>
            Effect.sync(() => {
              contexts.push(value);
            }).pipe(Effect.andThen(realPending.put(value))),
        })
      : Layer.mock(PendingContext.CutoverContext)({
          status: () =>
            Effect.sync(() => (accepted ? ("accepted" as const) : ("pending" as const))),
          put: (value) =>
            Effect.sync(() => {
              contexts.push(value);
            }),
          remove: (id) =>
            Effect.sync(() => {
              removedContexts.push(id);
            }),
        }),
    Layer.mock(ProviderSessions.ProviderSessionManagerV2)({
      peek: (id) =>
        Effect.sync(() => {
          peeks.push(id);
          return liveRuntime;
        }),
    }),
  );
  const context = yield* Layer.build(Actions.layer.pipe(Layer.provide(owners)));
  const actions = yield* CutoverEngine.CutoverActions.pipe(Effect.provide(context));
  return {
    actions,
    store,
    records,
    get,
    replace,
    commands,
    sends,
    interrupts,
    contexts,
    removedContexts,
    fileWrites,
    stateDir,
    pending: realPending,
    released: (id: string) =>
      cutoverThreadReleased(id).pipe(Effect.provideService(ServerConfig.ServerConfig, config)),
    settingsWrites,
    projectWrites,
    scheduleWrites,
    restorations,
    pageReads,
    readinessTargets,
    peeks,
    input,
    receipts,
    settings: () => currentSettings,
    project: () => currentProject,
    task: () => currentTask,
    shellReads: () => shellReads,
    failAdoptions: (value = true) => {
      failAdoptions = value;
    },
    failSends: () => {
      failSends = true;
    },
    nativeActive: (count: number) => {
      nativeActive = count;
    },
    accepted: (value: boolean) => {
      accepted = value;
    },
    acceptOnSend: (value: boolean) => {
      acceptOnSend = value;
    },
    runtime: (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) => {
      liveRuntime = Option.some(runtime);
    },
  };
});
type Harness = Effect.Success<ReturnType<typeof makeHarness>>;
const itemFor = (plan: CutoverEngine.CutoverPlan, key: string) => {
  const found = plan.items.find((entry) => entry.key === key);
  assert.isDefined(found, `Missing planned item ${key}`);
  return found!;
};
const deferred = Effect.fn("CutoverActionsTest.deferred")(function* (
  effect: ReturnType<CutoverEngine.CutoverActions["Service"]["apply"]>,
  reason: string,
) {
  const result = yield* Effect.result(effect);
  assert.isTrue(Result.isFailure(result));
  if (Result.isFailure(result)) {
    assert.strictEqual(result.failure._tag, "CutoverDeferred");
    assert.include(result.failure.message, reason);
  }
});
const onlyThread = (
  id: string,
  status: OrchestrationV2Run["status"] = "completed",
  selection = opus,
) => ({
  threads: [projection(makeThread(id, selection), status)],
  withBoard: false,
  withDefaults: false,
  withFallback: false,
});

it.effect(
  "plans every selection scope and paged thread role without writing or waking idle conversations",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const sql = yield* SqlClient.SqlClient;
        const before = yield* sql`SELECT name, sql FROM sqlite_schema ORDER BY name`;
        const plan = yield* h.actions.plan;
        const scopeCounts = plan.items.reduce<Record<string, number>>((counts, item) => {
          const scope = item.key.split(":")[0]!;
          counts[scope] = (counts[scope] ?? 0) + 1;
          return counts;
        }, {});
        assert.deepStrictEqual(
          {
            items: plan.items.length,
            scopes: scopeCounts,
            selectionChanges: plan.items.filter((item) => item.kind === "selection").length,
            wakeThreads: plan.items.filter((item) => item.kind === "thread" && item.wake).length,
            quietThreads: plan.items.filter((item) => item.kind === "thread" && !item.wake).length,
            queueReleaseThreads: (
              itemFor(plan, "finalize").payload as { queueThreads: readonly string[] }
            ).queueThreads.length,
            refusals: plan.refusals,
            readiness: plan.readiness,
          },
          {
            items: 27,
            scopes: {
              settings: 7,
              project: 1,
              board: 1,
              pinned: 3,
              schedule: 1,
              fallback: 1,
              thread: 9,
              queued: 1,
              card: 2,
              finalize: 1,
            },
            selectionChanges: 15,
            wakeThreads: 5,
            quietThreads: 4,
            queueReleaseThreads: 9,
            refusals: [],
            readiness: [{ id: "fixture-native", ready: true, reason: "healthy" }],
          },
        );
        assert.deepStrictEqual(plan.refusals, []);
        assert.deepStrictEqual(plan.readiness, [
          { id: "fixture-native", ready: true, reason: "healthy" },
        ]);
        for (const key of [
          "settings:defaultModelSelection",
          "settings:textGenerationModelSelection",
          "settings:sourceControlWriterModelSelection",
          "settings:reviewGuideModelSelection",
          "settings:favorites",
          "settings:providerModelPreferences",
          `settings:${projectOverrideRef(projectId, "textGenerationModelSelection")}`,
          `project:${projectId}`,
          `schedule:${task.id}`,
          `fallback:${task.id}`,
          `board:${board.id}`,
          ...cards
            .filter((entry) => entry.activeThreadId === null)
            .map((entry) => `pinned:${entry.id}`),
          `card:${stoppedWork.id}`,
          `card:${stoppedReview.id}`,
          "queued:run:unrelated:queued:2",
          "finalize",
        ])
          itemFor(plan, key);
        const plannedThreads = plan.items.filter((entry) => entry.kind === "thread");
        for (const entry of plannedThreads)
          assert.deepStrictEqual((entry.payload as { queuedBefore: unknown }).queuedBefore, []);
        assert.deepStrictEqual(
          plannedThreads.map((entry) => entry.ref).sort(),
          [
            worker,
            reviewer,
            evaluator,
            discussionThread,
            "ordinary:idle",
            "ordinary:running",
            "ordinary:interrupted",
            "imessage:idle",
            "imessage:interrupted",
          ].sort(),
        );
        assert.deepStrictEqual(
          plannedThreads
            .filter((entry) => entry.wake)
            .map((entry) => entry.ref)
            .sort(),
          [
            worker,
            reviewer,
            "ordinary:running",
            "ordinary:interrupted",
            "imessage:interrupted",
          ].sort(),
        );
        for (const id of ["ordinary:idle", "imessage:idle", evaluator, discussionThread]) {
          const entry = itemFor(plan, `thread:${id}`);
          assert.isFalse(entry.wake);
          assert.include((entry.payload as { brief: string }).brief, "do not resume idle work");
        }
        const workBrief = (itemFor(plan, `thread:${worker}`).payload as { brief: string }).brief;
        for (const text of [
          worker,
          `ses_source_${worker}`,
          "Last actual request",
          "Already sent this answer",
          "existing branch",
          "Keep my deployment question",
        ])
          assert.include(workBrief, text);
        assert.notInclude(workBrief, "Already answered");
        assert.isAbove(h.pageReads.length, 1);
        assert.deepStrictEqual(h.pageReads[0], { limit: 100 });
        assert.isTrue(h.pageReads.slice(1).every((read) => read.afterThreadId !== undefined));
        assert.strictEqual(h.shellReads(), 0);
        assert.isTrue(h.readinessTargets[0]!.some((target) => target.instanceId === "codex-cu"));
        assert.deepStrictEqual(
          yield* sql`SELECT name, sql FROM sqlite_schema ORDER BY name`,
          before,
        );
        assert.deepStrictEqual(
          [h.commands, h.sends, h.contexts, h.settingsWrites, h.restorations],
          [[], [], [], [], []],
        );
      }),
    ).pipe(Effect.provide(database)),
);

it.effect("a plan with schedules but no fallback table remains read-only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness({ withBoard: false, withFallback: false, threads: [] });
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT name FROM sqlite_schema ORDER BY name`;
      const plan = yield* h.actions.plan;
      itemFor(plan, `schedule:${task.id}`);
      assert.isFalse(plan.items.some((entry) => entry.key.startsWith("fallback:")));
      assert.deepStrictEqual(yield* sql`SELECT name FROM sqlite_schema ORDER BY name`, before);
    }),
  ).pipe(Effect.provide(database)),
);

it.effect(
  "applies settings, project, schedule, queue and fallback selections without changing unrelated policy",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const plan = yield* h.actions.plan;
        const selected = plan.items.filter((entry) =>
          ["settings:", "project:", "schedule:", "queued:", "fallback:"].some((prefix) =>
            entry.key.startsWith(prefix),
          ),
        );
        for (const entry of selected) yield* h.actions.apply(entry, "switch");
        assert.deepStrictEqual(h.settings().defaultModelSelection, nativeOpus);
        assert.deepStrictEqual(h.settings().textGenerationModelSelection, nativeSol);
        assert.deepStrictEqual(h.settings().projectSettingsOverrides[projectId], {
          textGenerationModelSelection: nativeSol,
          responseStreamingMode: "paragraph",
        });
        assert.deepStrictEqual(h.settings().favorites, [
          { provider: nativeOpus.instanceId, model: "claude-opus-5-5" },
          { provider: opus.instanceId, model: glm.model },
        ]);
        assert.deepStrictEqual(h.project(), { ...project, defaultModelSelection: nativeSol });
        assert.deepStrictEqual(h.task(), { ...task, modelSelection: nativeTerra });
        assert.deepStrictEqual(h.scheduleWrites, [
          { id: task.id, expected: terra, next: nativeTerra },
        ]);
        assert.deepStrictEqual(h.projectWrites, [
          {
            projectId,
            commandId: CommandId.make(`harness-cutover:v1:project:${projectId}:switch`),
            defaultModelSelection: nativeSol,
            expectedDefaultModelSelection: sol,
          },
        ]);
        assert.deepStrictEqual(yield* readBlockRetry(yield* SqlClient.SqlClient, task), {
          ...retry,
          fallbacks: [nativeSol, glm, nativeOpus],
        });
        assert.deepStrictEqual(h.get("unrelated:queued").thread.modelSelection, glm);
        assert.deepStrictEqual(h.get("unrelated:queued").runs[1]!.modelSelection, nativeSol);
        const writes = [
          h.settingsWrites.length,
          h.projectWrites.length,
          h.scheduleWrites.length,
          h.commands.length,
        ];
        for (const entry of selected) yield* h.actions.apply(entry, "switch");
        assert.deepStrictEqual(
          [
            h.settingsWrites.length,
            h.projectWrites.length,
            h.scheduleWrites.length,
            h.commands.length,
          ],
          writes,
        );
        assert.deepStrictEqual(h.sends, []);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "rolls back future selections and board pins to their recorded source values idempotently",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const plan = yield* h.actions.plan;
        const selections = plan.items.filter((entry) => entry.kind === "selection");
        for (const entry of selections) yield* h.actions.apply(entry, "switch");
        for (const entry of selections.toReversed()) {
          yield* h.actions.apply(entry, "rollback");
          yield* h.actions.apply(entry, "rollback");
        }
        assert.deepStrictEqual(h.settings(), initialSettings());
        assert.deepStrictEqual(h.project(), project);
        assert.deepStrictEqual(h.task(), task);
        assert.deepStrictEqual(yield* readBlockRetry(yield* SqlClient.SqlClient, task), retry);
        assert.deepStrictEqual(h.get("unrelated:queued").runs[1]!.modelSelection, sol);
        assert.deepStrictEqual(yield* h.store.boards, [board]);
        assert.deepStrictEqual(yield* h.store.pools(board.id), pools);
        assert.deepStrictEqual(yield* h.store.cards(board.id), cards);
        assert.deepStrictEqual(
          yield* h.store.threadLinks({ boardId: board.id, open: false }),
          links,
        );
        assert.deepStrictEqual(yield* h.store.discussion(discussionId), discussion);
        assert.deepStrictEqual(h.projectWrites[1], {
          projectId,
          commandId: CommandId.make(`harness-cutover:v1:project:${projectId}:rollback`),
          defaultModelSelection: sol,
          expectedDefaultModelSelection: nativeSol,
        });
        assert.deepStrictEqual(h.scheduleWrites[1], {
          id: task.id,
          expected: nativeTerra,
          next: terra,
        });
        assert.deepStrictEqual(h.sends, []);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "migrates real board SQL and pinned cards while preserving pools, packets, stopped roles and discussion identity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const plan = yield* h.actions.plan;
        const boardItem = itemFor(plan, `board:${board.id}`);
        yield* h.actions.apply(boardItem, "switch");
        const mappedBoard = (yield* h.store.boards)[0]!;
        assert.deepStrictEqual(mappedBoard, {
          ...board,
          managerModel: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-haiku-5-5",
            options: [{ id: "effort", value: "xhigh" }],
          },
          evaluatorModel: nativeOpus,
          defaultCardModel: nativeOpus,
          reviewChains: [{ name: "review", steps: [nativeSol, nativeTerra] }],
        });
        assert.deepStrictEqual(yield* h.store.pools(board.id), [
          pool(nativeOpus, 3),
          pool(nativeSol, 2),
          pool(glm, 1),
        ]);
        assert.deepStrictEqual(
          yield* h.store.card(pinned.id),
          pinned,
          "Inactive cards have separately retryable pinned rows",
        );
        for (const entry of plan.items.filter((entry) => entry.key.startsWith("pinned:"))) {
          yield* h.actions.apply(entry, "switch");
          yield* h.actions.apply(entry, "switch");
        }
        for (const old of cards) {
          assert.deepStrictEqual(yield* h.store.card(old.id), {
            ...old,
            model: nativeOpus,
            models: [
              { model: nativeOpus, weight: 7 },
              { model: nativeSol, weight: 2 },
            ],
            activePool: old.activePool === null ? null : Rules.poolKey(nativeOpus),
          });
        }
        assert.deepStrictEqual(yield* h.store.discussion(discussionId), discussion);
        assert.deepStrictEqual(
          yield* h.store.threadLinks({ boardId: board.id, open: false }),
          links.map((old) => ({ ...old, model: old.model === sol ? nativeSol : nativeOpus })),
        );
        for (const entry of plan.items.filter((entry) => entry.kind === "card"))
          yield* h.actions.apply(entry, "switch");
        assert.deepStrictEqual(h.restorations, [
          { cardId: stoppedWork.id, threadId: worker, stage: "working" },
          { cardId: stoppedReview.id, threadId: reviewer, stage: "in_review" },
        ]);
        assert.deepStrictEqual(h.sends, []);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "adopts idle threads internally with bounded carry-on context but no imported or seeded native history and no wake",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const plan = yield* h.actions.plan;
        for (const id of ["ordinary:idle", "imessage:idle", evaluator, discussionThread]) {
          const entry = itemFor(plan, `thread:${id}`);
          const old = h.get(id);
          yield* h.actions.apply(entry, "switch");
          yield* h.actions.apply(entry, "brief");
          yield* h.actions.apply(entry, "switch");
          const adopt = h.commands.filter(
            (command) => command.type === "thread.adopt-native-history" && command.threadId === id,
          );
          assert.strictEqual(adopt.length, 1);
          const expected = id === discussionThread ? nativeSol : nativeOpus;
          assert.deepStrictEqual(adopt[0], {
            type: "thread.adopt-native-history",
            commandId: CommandId.make(`harness-cutover:v1:thread:${id}:switch`),
            threadId: ThreadId.make(id),
            modelSelection: expected,
            expectedActiveProviderThreadId: old.thread.activeProviderThreadId,
            target: {
              kind: "new",
              driver: ProviderDriverKind.make(
                expected.instanceId === "claudeAgent" ? "claudeAgent" : "codex",
              ),
              nativeId: null,
              headId: null,
            },
          });
          assert.deepStrictEqual(h.get(id).providerThreads, old.providerThreads);
          assert.strictEqual(h.get(id).thread.branch, old.thread.branch);
          assert.strictEqual(h.get(id).thread.worktreePath, old.thread.worktreePath);
          const context = h.contexts.find((value) => value.threadId === id)!;
          assert.strictEqual(context.targetInstance, expected.instanceId);
          assert.include(context.text, `t3_thread_read({threadId:${JSON.stringify(id)}`);
          assert.include(context.text, "do not resume idle work");
        }
        assert.isTrue(h.peeks.length >= 4);
        assert.deepStrictEqual(h.sends, []);
        assert.strictEqual(h.shellReads(), 0);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "interrupts a running source, waits for drain, then resumes the exact thread with stable command and message IDs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(onlyThread("running", "running", sol));
        const plan = yield* h.actions.plan;
        const entry = itemFor(plan, "thread:running");
        yield* deferred(h.actions.apply(entry, "switch"), "drain");
        assert.deepStrictEqual(h.interrupts, [
          {
            projectId,
            threadId: ThreadId.make("running"),
            runId: RunId.make("run:running:1"),
            commandId: CommandId.make("harness-cutover:v1:thread:running:interrupt:run:running:1"),
            reason: "Harness cutover",
          },
        ]);
        assert.deepStrictEqual(h.contexts, []);
        assert.deepStrictEqual(h.commands, []);
        h.replace("running", {
          runs: h
            .get("running")
            .runs.map((run) => ({ ...run, status: "interrupted", completedAt: now })),
        });
        yield* h.actions.apply(entry, "switch");
        h.acceptOnSend(false);
        yield* deferred(h.actions.apply(entry, "brief"), "waiting for native prompt acceptance");
        h.nativeActive(3);
        yield* deferred(h.actions.apply(entry, "brief"), "waiting for native prompt acceptance");
        assert.strictEqual(h.sends.length, 2);
        assert.deepStrictEqual(h.sends[0], h.sends[1]);
        assert.deepStrictEqual(h.sends[0], {
          projectId,
          threadId: ThreadId.make("running"),
          commandId: CommandId.make("harness-cutover:v1:thread:running:resume:0"),
          messageId: MessageId.make("harness-cutover:v1:thread:running:resume:0"),
          text: "Read the harness carry-on context, then continue the interrupted work exactly where it stopped. Do not announce the switch or repeat messages already sent.",
          attachments: [],
          modelSelection: nativeSol,
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        });
        assert.strictEqual(h.contexts.length, 1);
        assert.include(h.contexts[0]!.text, "Carry on exactly where you left off");
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "defers pending owner requests, active children, stale rosters and buffered provider work before adoption",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(onlyThread("blocked"));
        const entry = itemFor(yield* h.actions.plan, "thread:blocked");
        const original = h.get("blocked");
        h.replace("blocked", {
          runtimeRequests: [
            {
              id: RuntimeRequestId.make("question:1"),
              nodeId: NodeId.make("node:1"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          ],
        });
        yield* deferred(h.actions.apply(entry, "switch"), "owner question");
        h.replace("blocked", {
          runtimeRequests: [],
          subagents: [
            {
              id: NodeId.make("child:1"),
              threadId: original.thread.id,
              runId: null,
              parentNodeId: NodeId.make("node:1"),
              origin: "app_owned",
              createdBy: "agent",
              driver: ProviderDriverKind.make("opencode"),
              providerInstanceId: opus.instanceId,
              providerThreadId: original.thread.activeProviderThreadId,
              childThreadId: ThreadId.make("child:thread"),
              nativeTaskRef: null,
              prompt: "Keep working",
              title: "Live child",
              model: null,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          ],
        });
        yield* deferred(h.actions.apply(entry, "switch"), "background work");
        h.replace("blocked", {
          subagents: [],
          providerThreads: original.providerThreads.map((row) => ({
            ...row,
            pendingBackgroundTasks: [
              {
                taskId: "native:child",
                kind: "subagent",
                description: "Native child still running",
              },
            ],
          })),
        });
        yield* deferred(h.actions.apply(entry, "switch"), "background work");
        h.replace("blocked", { providerThreads: original.providerThreads });
        // Only the liveness probes are consumed; every other runtime method remains unavailable.
        h.runtime({
          holdsWorkForThread: () => Effect.succeed(true),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime);
        yield* deferred(h.actions.apply(entry, "switch"), "buffered wake");
        h.runtime({
          holdsWorkForThread: () => Effect.die("Probe unavailable"),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime);
        yield* deferred(h.actions.apply(entry, "switch"), "buffered wake");
        assert.deepStrictEqual([h.commands, h.contexts, h.interrupts, h.sends], [[], [], [], []]);
        h.runtime({
          holdsWorkForThread: () => Effect.succeed(false),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime);
        yield* h.actions.apply(entry, "switch");
        assert.strictEqual(
          h.commands.filter((value) => value.type === "thread.adopt-native-history").length,
          1,
        );
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "rebinds queued selections under the admission barrier before fresh adoption without waking idle work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(onlyThread("queued-parent", "completed", sol));
        const original = h.get("queued-parent");
        const queued = { ...makeRun(original.thread, "queued", 2, sol), queueHeld: false };
        h.replace("queued-parent", { runs: [...original.runs, queued] });
        const entry = itemFor(yield* h.actions.plan, "thread:queued-parent");
        assert.deepStrictEqual((entry.payload as { queuedBefore: unknown }).queuedBefore, [
          { id: queued.id, selection: sol },
        ]);
        assert.isFalse(entry.wake);
        yield* h.actions.apply(entry, "switch");
        assert.deepStrictEqual(
          h.commands.slice(0, 2).map((value) => value.type),
          ["queued-run.rebind-selection", "thread.adopt-native-history"],
        );
        assert.deepStrictEqual(h.get("queued-parent").runs[1]!.modelSelection, nativeSol);
        yield* h.actions.apply(entry, "brief");
        assert.deepStrictEqual(h.sends, []);
        yield* h.actions.apply(entry, "rollback");
        assert.deepStrictEqual(h.get("queued-parent").thread.modelSelection, sol);
        assert.deepStrictEqual(h.get("queued-parent").runs, [...original.runs, queued]);
        assert.isTrue(yield* h.released("queued-parent"));
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "defers a wake for existing owner input or three active native sessions without duplicating a prior receipt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(onlyThread("wake", "interrupted"));
        const entry = itemFor(yield* h.actions.plan, "thread:wake");
        yield* h.actions.apply(entry, "switch");
        const request = {
          id: RuntimeRequestId.make("question:1"),
          nodeId: NodeId.make("node:1"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input" as const,
          status: "pending" as const,
          responseCapability: { type: "message" as const },
          createdAt: now,
          resolvedAt: null,
        };
        h.replace("wake", { runtimeRequests: [request] });
        yield* deferred(h.actions.apply(entry, "brief"), "owner question");
        h.replace("wake", { runtimeRequests: [] });
        h.nativeActive(3);
        yield* deferred(h.actions.apply(entry, "brief"), "Three native sessions");
        assert.deepStrictEqual(h.sends, []);
        h.nativeActive(2);
        yield* h.actions.apply(entry, "brief");
        h.nativeActive(3);
        yield* h.actions.apply(entry, "brief");
        assert.strictEqual(h.sends.length, 1, "Accepted carry-on delivery must not dispatch again");
        assert.strictEqual(new Set(h.sends.map((send) => send.commandId)).size, 1);
        assert.strictEqual(new Set(h.sends.map((send) => send.messageId)).size, 1);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "a dispatched carry-on stays deferred until native prompt acceptance and keeps its delivery identity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(onlyThread("acceptance", "interrupted"));
        const entry = itemFor(yield* h.actions.plan, "thread:acceptance");
        yield* h.actions.apply(entry, "switch");
        h.acceptOnSend(false);
        yield* deferred(h.actions.apply(entry, "brief"), "waiting for native prompt acceptance");
        h.acceptOnSend(true);
        yield* h.actions.apply(entry, "brief");
        assert.strictEqual(h.sends.length, 2);
        assert.deepStrictEqual(h.sends[0], h.sends[1]);
        assert.strictEqual(h.contexts.length, 1);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "interrupted evaluators and discussion workers stage next-request context rather than unsolicited board messages",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({
          threads: [
            projection(makeThread(evaluator), "interrupted"),
            projection(makeThread(discussionThread, sol), "interrupted"),
            projection(makeThread(worker)),
            projection(makeThread(reviewer, sol)),
          ],
        });
        const plan = yield* h.actions.plan;
        for (const id of [evaluator, discussionThread]) {
          const entry = itemFor(plan, `thread:${id}`);
          assert.isFalse(entry.wake);
          assert.include((entry.payload as { brief: string }).brief, "do not resume idle work");
          yield* h.actions.apply(entry, "switch");
          yield* h.actions.apply(entry, "brief");
        }
        assert.deepStrictEqual(h.sends, []);
        assert.deepStrictEqual(yield* h.store.discussion(discussionId), discussion);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "migrates provider-native children quietly while preserving ordinary delegated-child continuation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parentId = ThreadId.make("parent");
        const child = (id: string, creationSource: OrchestrationV2AppThread["creationSource"]) =>
          makeThread(id, opus, {
            creationSource,
            lineage: {
              parentThreadId: parentId,
              rootThreadId: parentId,
              relationshipToParent: "subagent",
            },
          });
        const h = yield* makeHarness({
          ...onlyThread("unused"),
          threads: [
            projection(child("native-child", "provider"), "interrupted"),
            projection(child("delegated-child", "mcp"), "interrupted"),
          ],
        });
        const plan = yield* h.actions.plan;
        const native = itemFor(plan, "thread:native-child");
        assert.isFalse(native.wake);
        assert.isTrue(itemFor(plan, "thread:delegated-child").wake);
        assert.deepStrictEqual((native.payload as { queuedBefore: unknown }).queuedBefore, []);
        assert.include((native.payload as { brief: string }).brief, "do not resume idle work");
        yield* h.actions.apply(native, "switch");
        yield* h.actions.apply(native, "brief");
        assert.deepStrictEqual(h.get("native-child").thread.modelSelection, nativeOpus);
        assert.deepStrictEqual(h.sends, []);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect("refuses a stale pinned packet rather than overwriting a new owner ask", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const entry = itemFor(yield* h.actions.plan, `pinned:${pinned.id}`);
      const changed = { ...pinned, title: "Owner edited this packet after planning" };
      yield* h.store.putCard(changed);
      const result = yield* Effect.result(h.actions.apply(entry, "switch"));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "CutoverError");
      assert.deepStrictEqual(yield* h.store.card(pinned.id), changed);
    }),
  ).pipe(Effect.provide(database)),
);

it.effect(
  "finalize preserves migration policy, releases admission and unpauses only the recorded board",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.replace("unrelated:queued", {
          runs: h
            .get("unrelated:queued")
            .runs.map((run) => (run.status === "queued" ? { ...run, queueHeld: false } : run)),
        });
        const plan = yield* h.actions.plan;
        const entry = itemFor(plan, "finalize");
        const expectedThreads = [
          ...plan.items.filter((item) => item.kind === "thread").map((item) => item.ref),
          "unrelated:queued",
        ].sort();
        assert.deepStrictEqual(
          [...(entry.payload as { queueThreads: readonly string[] }).queueThreads].sort(),
          expectedThreads,
        );
        const idle = h.get("ordinary:idle");
        h.replace("ordinary:idle", {
          runs: [
            ...idle.runs,
            {
              ...makeRun(idle.thread, "queued", 2),
              userMessageId: MessageId.make("async-answer:late-owner-answer"),
            },
          ],
        });
        const migration = h.settings().ardudHarnessMigration;
        yield* h.actions.apply(entry, "switch");
        assert.deepStrictEqual(h.settings().ardudHarnessMigration, {
          ...migration,
          selections: "apply",
          cutoverComplete: true,
          transcript: { enabled: true, lastTurns: 8 },
        });
        assert.deepStrictEqual(h.fileWrites, [
          { path: `${h.stateDir}/harness-cutover-released.json`, text: '{"version":1}' },
        ]);
        assert.deepStrictEqual((yield* h.store.boards)[0], { ...board, pause: null });
        assert.strictEqual(h.commands.length, expectedThreads.length);
        assert.deepStrictEqual(
          h.commands
            .filter((command) => command.type === "queue.cutover-release")
            .toSorted((a, b) => a.threadId.localeCompare(b.threadId)),
          expectedThreads.map((id) => ({
            type: "queue.cutover-release",
            threadId: ThreadId.make(id),
            commandId: CommandId.make(`harness-cutover:v1:finalize:queue-release:${id}`),
          })),
        );
        assert.deepStrictEqual(yield* h.store.discussion(discussionId), discussion);
        assert.deepStrictEqual(h.sends, []);
      }),
    ).pipe(Effect.provide(database)),
);

const realEngine = Effect.fn("CutoverActionsTest.engine")(function* (h: Harness) {
  const context = yield* Layer.build(
    CutoverEngine.layerWithOptions({ paceMillis: 0 }).pipe(
      Layer.provide(Layer.succeed(CutoverEngine.CutoverActions, h.actions)),
    ),
  );
  return yield* CutoverEngine.HarnessCutover.pipe(Effect.provide(context));
});

it.effect(
  "three failed real adoptions exhaust attempts, remove pending context and retain the exact OpenCode source",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(onlyThread("fail-switch", "interrupted"));
        h.failAdoptions();
        const source = h.get("fail-switch");
        const engine = yield* realEngine(h);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const status = yield* engine.run();
          const row = status.items.find((entry) => entry.key === "thread:fail-switch")!;
          assert.strictEqual(row.attempts, attempt);
          assert.strictEqual(row.rolledBack, attempt === 3);
          assert.isFalse(status.completed);
        }
        const status = yield* engine.status();
        assert.deepStrictEqual(status.claimedThreadIds, []);
        assert.deepStrictEqual(h.get("fail-switch"), source);
        assert.deepStrictEqual(h.removedContexts, ["fail-switch"]);
        assert.isTrue(yield* h.released("fail-switch"));
        assert.strictEqual(
          h.commands.filter((value) => value.type === "thread.adopt-native-history").length,
          3,
        );
        assert.strictEqual(new Set(h.commands.map((value) => value.commandId)).size, 1);
        assert.deepStrictEqual(h.sends, []);
        assert.deepStrictEqual(h.settingsWrites, []);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "failed native wakes roll back selection to the existing source without erasing its runs or provider history",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(onlyThread("fail-wake", "interrupted"));
        h.failSends();
        const source = h.get("fail-wake");
        const engine = yield* realEngine(h);
        for (let batch = 0; batch < 4; batch += 1) yield* engine.run();
        const status = yield* engine.status();
        const row = status.items.find((entry) => entry.key === "thread:fail-wake")!;
        assert.strictEqual(row.attempts, 3);
        assert.strictEqual(row.phase, "brief");
        assert.isTrue(row.rolledBack);
        assert.deepStrictEqual(
          h.get("fail-wake").thread.modelSelection,
          source.thread.modelSelection,
        );
        assert.deepStrictEqual(h.get("fail-wake").providerThreads, source.providerThreads);
        assert.deepStrictEqual(h.get("fail-wake").runs, source.runs);
        assert.deepStrictEqual(h.get("fail-wake").turnItems, source.turnItems);
        assert.deepStrictEqual(h.removedContexts, ["fail-wake"]);
        assert.isTrue(yield* h.released("fail-wake"));
        assert.strictEqual(
          h.commands.filter((value) => value.type === "thread.adopt-native-history").length,
          1,
        );
        assert.deepStrictEqual(
          h.commands.find((value) => value.type === "provider.switch"),
          {
            type: "provider.switch",
            commandId: CommandId.make("harness-cutover:v1:thread:fail-wake:rollback"),
            threadId: ThreadId.make("fail-wake"),
            modelSelection: opus,
          },
        );
        assert.strictEqual(h.sends.length, 3);
        assert.strictEqual(new Set(h.sends.map((value) => value.messageId)).size, 1);
        assert.isFalse(status.completed);
        assert.deepStrictEqual(h.settingsWrites, []);
      }),
    ).pipe(Effect.provide(database)),
);

it.effect(
  "board, pinned and fallback changes roll back in the board database without touching the main database",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const main = yield* SqlClient.SqlClient;
        const boards = yield* BoardsDatabase.client;
        assert.notStrictEqual(main, boards);
        const h = yield* makeHarness();
        const beforeMain = yield* main`SELECT name, sql FROM sqlite_schema ORDER BY name`;
        const plan = yield* h.actions.plan;
        const selected = plan.items.filter((entry) =>
          ["board:", "pinned:", "fallback:"].some((prefix) => entry.key.startsWith(prefix)),
        );
        for (const entry of selected) yield* h.actions.apply(entry, "switch");
        assert.deepStrictEqual((yield* h.store.card(pinned.id))!.model, nativeOpus);
        assert.deepStrictEqual((yield* h.store.boards)[0]!.defaultCardModel, nativeOpus);
        assert.deepStrictEqual(yield* readBlockRetry(boards, task), {
          ...retry,
          fallbacks: [nativeSol, glm, nativeOpus],
        });
        for (const entry of selected.toReversed()) yield* h.actions.apply(entry, "rollback");
        assert.deepStrictEqual(yield* h.store.boards, [board]);
        assert.deepStrictEqual(yield* h.store.cards(board.id), cards);
        assert.deepStrictEqual(yield* h.store.pools(board.id), pools);
        assert.deepStrictEqual(yield* readBlockRetry(boards, task), retry);
        assert.deepStrictEqual(
          yield* main`SELECT name, sql FROM sqlite_schema ORDER BY name`,
          beforeMain,
        );
        assert.deepStrictEqual(
          yield* main`SELECT name FROM sqlite_schema WHERE name GLOB 'ardud_kanban_*' OR name = 'ardud_scheduled_task_block_retry'`,
          [],
        );
      }),
    ).pipe(Effect.provide(splitDatabase)),
);

it.effect(
  "a failed adoption retries the same final owner-answer context without losing its queued answer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({
          ...onlyThread("answer-retry", "interrupted"),
          realPendingContext: true,
        });
        const entry = itemFor(yield* h.actions.plan, "thread:answer-retry");
        const original = h.get("answer-retry");
        const answer = {
          ...makeRun(original.thread, "queued", 2),
          userMessageId: MessageId.make("async-answer:owner-decision"),
        };
        const message: OrchestrationV2ThreadProjection["messages"][number] = {
          id: answer.userMessageId,
          threadId: original.thread.id,
          runId: answer.id,
          nodeId: null,
          role: "user",
          text: "Keep the branch and wait for my deploy approval.",
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "server",
          createdAt: now,
          updatedAt: now,
        };
        h.replace("answer-retry", { runs: [...original.runs, answer], messages: [message] });
        h.failAdoptions();
        const failed = yield* Effect.result(h.actions.apply(entry, "switch"));
        assert.isTrue(Result.isFailure(failed));
        if (Result.isFailure(failed) && failed.failure._tag === "CutoverError")
          assert.strictEqual(failed.failure.operation, "switch");
        assert.strictEqual(yield* h.pending!.status("answer-retry"), "pending");
        h.failAdoptions(false);
        yield* h.actions.apply(entry, "switch");
        assert.strictEqual(h.contexts.length, 2);
        assert.deepStrictEqual(h.contexts[0], h.contexts[1]);
        assert.strictEqual(h.contexts[0]!.refreshPending, true);
        assert.include(h.contexts[0]!.text, `Owner answered: ${message.text}`);
        assert.strictEqual(h.contexts[0]!.text.split(message.text).length - 1, 1);
        assert.deepStrictEqual(h.get("answer-retry").messages, [message]);
        assert.deepStrictEqual(h.get("answer-retry").runs[1], {
          ...answer,
          modelSelection: nativeOpus,
          providerInstanceId: nativeOpus.instanceId,
        });
        assert.strictEqual(
          h.commands.filter((command) => command.type === "queued-run.rebind-selection").length,
          1,
        );
        const claim = {
          threadId: "answer-retry",
          targetInstance: "claudeAgent",
          runId: "native:carry-on",
        };
        assert.strictEqual(yield* h.pending!.read(claim), h.contexts[0]!.text);
        assert.strictEqual(yield* h.pending!.status("answer-retry"), "claimed");
        assert.deepStrictEqual(h.sends, []);
      }),
    ).pipe(Effect.provide(database)),
);
