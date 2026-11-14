// @effect-diagnostics globalTimers:off - Bounded callback collector shared by browser and React Native hosts.
// @effect-diagnostics globalDate:off - Client event timestamps use the host wall clock; tests inject it.
import {
  DEFAULT_SERVER_SETTINGS,
  KANBAN_WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  LONG_TASK_HISTOGRAM_BUCKETS,
  type AnalyticsEvent,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { createLongTaskTracker, type LongTaskEntry, type LongTaskView } from "./longTasks.ts";

export type ClientAnalyticsEvent = AnalyticsEvent & {
  readonly surface: "web" | "desktop" | "mobile";
};
export type AnalyticsDetails = Partial<Omit<ClientAnalyticsEvent, "kind" | "ts" | "surface">>;
const ANALYTICS_BATCH_SIZE = 100;
const ANALYTICS_FLUSH_MS = 10_000;
const ANALYTICS_MAX_EVENTS = 1_000;

const kinds = new Set([
  "screen.open",
  "screen.dwell",
  "owner.action",
  "ask.answer_sent",
  "ask.dropped",
  "discussion.post",
  "discussion.read-end",
  "search",
  "settings.change",
  "command.palette",
  "command.keybinding",
  "client.retry",
  "client.refresh",
  "toast.show",
  "client.error",
  "client.lifecycle",
  "connection.reconnect",
  "performance.route",
  "performance.action",
  "performance.long-task",
  "performance.long-task-summary",
  "performance.frames",
  "performance.memory",
  "rpc.summary",
  "analytics.dropped",
]);
const routes = new Set([
  "home",
  "board",
  "card",
  "ask",
  "discussion",
  "thread",
  "needs-owner",
  "settings",
  "usage",
  "projects",
  "pull-requests",
  "imessage",
  "connect",
  "welcome",
  "other",
]);
const screenKinds = new Set([
  ...routes,
  "board.threads",
  "board.goals",
  "board.discussions",
  "board.automations",
  "board.scripts",
  "board.wiki",
  "board.settings",
  "needs-owner.history",
  "needs-owner.reference",
]);
const methods = new Set<string>([
  ...Object.values(WS_METHODS),
  ...Object.values(KANBAN_WS_METHODS),
  ...Object.values(ORCHESTRATION_V2_WS_METHODS),
  "asks.answer",
  "asks.answerBatch",
  "asks.reply",
  "asks.hand",
  "asks.handBatch",
  "asks.snooze",
  "asks.snoozeBatch",
  "asks.answerSecrets",
]);
const settingsKeys = new Set([
  ...Object.keys(DEFAULT_CLIENT_SETTINGS),
  ...Object.keys(DEFAULT_SERVER_SETTINGS),
  "themeId",
  "lightThemeId",
  "darkThemeId",
  "themeMode",
  "baseFontSize",
  "terminalFontSize",
  "markdownFontSize",
  "codeFontSize",
  "codeWordBreak",
  "mathRenderingEnabled",
  "liveActivitiesEnabled",
  "composerEnterBehavior",
  "followUpBehavior",
  "microphones",
  "projectGroupingEnabled",
  "projectGroupingMode",
  "workingShelfEnabled",
  "kanbanHideCardDiscussions",
  "kanbanBoardFilters",
  "kanbanBoardColumns",
  "kanbanDiscussionShelves",
]);
const errorTags = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "RpcClientError",
  "RpcClientDefect",
  "EnvironmentAuthorizationError",
  "EnvironmentRpcUnavailableError",
  "KanbanError",
  "AskApiError",
  "Interrupted",
  "unknown",
]);
const ownerOperations = new Set([
  "project.create",
  "project.update",
  "project.delete",
  "thread.create",
  "thread.delete",
  "thread.archive",
  "thread.pin",
  "thread.pin.reorder",
  "thread.active.reorder",
  "thread.auto-settle.set",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
  "thread.visit",
  "thread.mark-unread",
  "thread.metadata.update",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "message.dispatch",
  "run.interrupt",
  "run.retry",
  "run.cancel",
  "user-input.respond",
  "approval.respond",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.user-input.dismiss",
  "checkpoint.rollback",
  "provider-session.detach",
  "thread.fork",
  "thread.merge_back",
  "queue.resume",
  "queued-run.reorder",
  "queued-message.promote-to-steer",
  "queued-run.cancel",
  "prepared-run.retry",
  "queued-run.edit",
  "thread.pull-request.link",
  "thread.pull-request.unlink",
  "thread.pull-request.watch",
]);
const cardPatchKeys = [
  "stage",
  "priority",
  "title",
  "description",
  "prompt",
  "comment",
  "goalId",
  "projectId",
  "model",
  "blockedBy",
  "subtasks",
  "links",
  "removeLinks",
  "stalled",
  "handoff",
  "reviewChain",
];
const searchMethods = new Set<string>([
  ORCHESTRATION_V2_WS_METHODS.searchThread,
  ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
  ORCHESTRATION_V2_WS_METHODS.searchThreads,
  WS_METHODS.projectsSearchContents,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.serverSearchAcpRegistry,
]);
const ownerMutationMethods = new Set<string>([
  // Client permission enforcement is incremental; activity classification covers each mutation independently.
  WS_METHODS.projectsAdd,
  WS_METHODS.projectsRemove,
  WS_METHODS.projectsWriteFile,
  WS_METHODS.projectsMutate,
  WS_METHODS.projectsEnsureScratch,
  WS_METHODS.projectsCreateNew,
  WS_METHODS.shellOpenInEditor,
  WS_METHODS.agentSessionsImport,
  WS_METHODS.assetsPersistChatAttachments,
  WS_METHODS.attachmentsCreateUploadUrl,
  WS_METHODS.attachmentsDelete,
  WS_METHODS.mcpAppsCallTool,
  WS_METHODS.mcpAppsUpdateModelContext,
  WS_METHODS.providerUploadFeedback,
  WS_METHODS.providerAuthStart,
  WS_METHODS.providerConsumeResetCredit,
  WS_METHODS.providerAuthComplete,
  WS_METHODS.chatGptReconnectProfile,
  WS_METHODS.chatGptImportProfile,
  WS_METHODS.providerAuthRespond,
  WS_METHODS.providerAuthCancel,
  WS_METHODS.providerAuthLogout,
  WS_METHODS.providerInstallStart,
  WS_METHODS.providerInstallCancel,
  WS_METHODS.providerInstallRemove,
  WS_METHODS.vcsPull,
  WS_METHODS.vcsRefreshStatus,
  WS_METHODS.vcsCreateWorktree,
  WS_METHODS.vcsRemoveWorktree,
  WS_METHODS.vcsCreateRef,
  WS_METHODS.vcsSwitchRef,
  WS_METHODS.vcsInit,
  WS_METHODS.gitPreparePullRequestThread,
  WS_METHODS.terminalOpen,
  WS_METHODS.terminalWrite,
  WS_METHODS.terminalResize,
  WS_METHODS.terminalClear,
  WS_METHODS.terminalRestart,
  WS_METHODS.terminalClose,
  WS_METHODS.previewOpen,
  WS_METHODS.previewNavigate,
  WS_METHODS.previewResize,
  WS_METHODS.previewAdjust,
  WS_METHODS.previewRefresh,
  WS_METHODS.previewClose,
  WS_METHODS.previewClearProfile,
  WS_METHODS.deviceConfigure,
  WS_METHODS.deviceOpen,
  WS_METHODS.deviceClose,
  WS_METHODS.deviceShutdown,
  WS_METHODS.deviceAction,
  WS_METHODS.serverRefreshProviders,
  WS_METHODS.serverUpdateProvider,
  WS_METHODS.serverUpdateServer,
  WS_METHODS.serverCommitDesktopUpdate,
  WS_METHODS.serverUpsertKeybinding,
  WS_METHODS.serverRemoveKeybinding,
  WS_METHODS.serverRunStorageCleanup,
  WS_METHODS.serverUpdateSettings,
  WS_METHODS.serverPrepareAcpRegistryAgent,
  WS_METHODS.serverUninstallAcpRegistryManagedBinary,
  WS_METHODS.serverAcceptAcpRegistryUrlAuth,
  WS_METHODS.serverImportAcpRegistrySession,
  WS_METHODS.serverDeleteAcpRegistrySession,
  WS_METHODS.serverSetAcpRegistryProvider,
  WS_METHODS.serverDisableAcpRegistryProvider,
  WS_METHODS.serverLogoutAcpRegistry,
  WS_METHODS.serverRetryResourceTelemetry,
  WS_METHODS.serverSignalProcess,
  WS_METHODS.serverRefreshUsageRates,
  WS_METHODS.scheduledTasksUpsert,
  WS_METHODS.scheduledTasksSetEnabled,
  WS_METHODS.scheduledTasksDelete,
  WS_METHODS.scheduledTasksRunNow,
  WS_METHODS.scheduledTasksRotateWebhookToken,
  WS_METHODS.secretsAnswerRequest,
  WS_METHODS.secretsAnswerAsk,
  WS_METHODS.pullRequestsGenerateReviewGuide,
  WS_METHODS.pullRequestsSetFilesViewed,
  WS_METHODS.pullRequestsRunAction,
  WS_METHODS.pullRequestsUpdate,
  WS_METHODS.pullRequestsComment,
  WS_METHODS.pullRequestsUpdateComment,
  WS_METHODS.pullRequestsSubmitReview,
  WS_METHODS.pullRequestsReplyToThread,
  WS_METHODS.pullRequestsSetThreadResolution,
  WS_METHODS.pullRequestsSetReaction,
  WS_METHODS.pullRequestsInvalidate,
  WS_METHODS.pullRequestsRequestReviewers,
  WS_METHODS.pullRequestsSetLabels,
  WS_METHODS.sourceControlCloneRepository,
  WS_METHODS.sourceControlPublishRepository,
  WS_METHODS.projectCloneStart,
  WS_METHODS.projectCloneCancel,
  WS_METHODS.projectCloneRetry,
  WS_METHODS.worktreeSetupCancel,
  KANBAN_WS_METHODS.boardCreate,
  KANBAN_WS_METHODS.boardUpdate,
  KANBAN_WS_METHODS.standingApprovalRevoke,
  KANBAN_WS_METHODS.setupStart,
  KANBAN_WS_METHODS.setupEnd,
  KANBAN_WS_METHODS.boardPause,
  KANBAN_WS_METHODS.cardPatch,
  KANBAN_WS_METHODS.cardSettle,
  KANBAN_WS_METHODS.cardStop,
  KANBAN_WS_METHODS.cardAsk,
  KANBAN_WS_METHODS.cardDiscussion,
  KANBAN_WS_METHODS.poolSet,
  KANBAN_WS_METHODS.poolRemove,
  KANBAN_WS_METHODS.discussionCreate,
  KANBAN_WS_METHODS.discussionRead,
  KANBAN_WS_METHODS.discussionUpdate,
  KANBAN_WS_METHODS.messagePost,
  KANBAN_WS_METHODS.answer,
  KANBAN_WS_METHODS.scriptEnable,
  KANBAN_WS_METHODS.scriptRun,
  KANBAN_WS_METHODS.scriptAcknowledge,
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  ORCHESTRATION_V2_WS_METHODS.launchThread,
  ORCHESTRATION_V2_WS_METHODS.stopWorkflow,
]);
const labels: Readonly<Record<string, ReadonlySet<string>>> = {
  screen: screenKinds,
  containerType: new Set(["iframe", "embed", "object", "window", "unknown"]),
  containerName: new Set(["none", "redacted"]),
  ownerAction: new Set([
    ...methods,
    ...ownerOperations,
    "owner.action",
    "command.palette",
    "command.keybinding",
    "settings.change",
  ]),
  method: methods,
  errorTag: errorTags,
  span: new Set([
    "board",
    "card",
    "ask",
    "discussion",
    "thread",
    "needs-owner",
    "threads",
    "command-palette",
    "settings",
    "client.action",
  ]),
  phase: new Set([
    "active",
    "background",
    "close",
    "render",
    "uncaught",
    "unhandled-rejection",
    "post-commit-paint",
    "board-painted",
    "discussion-painted",
    "pending-paint",
    "authoritative-paint",
    "decode",
    "state-ready",
    "send",
    "durable-ack",
    "start",
    "complete",
    "ask",
    "pick",
    "poll",
    "stream",
  ]),
  reason: new Set([
    "capacity",
    "failed",
    "cancelled",
    "closed",
    "superseded",
    "connection-change",
    "undo",
    "retry",
    "refresh",
    "timeout",
  ]),
  originKind: new Set([
    "web",
    "desktop",
    "mobile",
    "user",
    "owner",
    "imessage",
    "automation",
    "watcher",
    "crw",
    "mcp",
    "provider",
    "server",
  ]),
};
const measurements = [
  "status",
  "count",
  "bytes",
  "p50Ms",
  "p95Ms",
  "queryLength",
  "resultCount",
  "depth",
  "droppedFrames",
  "memoryBytes",
  "visibleCardCount",
  "visibleThreadCount",
  "subscriptionBytes",
  "subscriptionMessages",
  "totalMs",
  "maxMs",
  "wallTimeMs",
] as const;
const ids = ["boardId", "cardId", "discussionId", "threadId"] as const;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const token = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  /^[a-zA-Z0-9_.:/#@%+\-]+$/.test(value) &&
  !value.includes("://");
const measurement = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT/.test(value) &&
  Number.isFinite(Date.parse(value));

/** Rebuild the payload: callers cannot accidentally pass through text or new fields. */
export function sanitizeAnalyticsEvent(input: unknown): ClientAnalyticsEvent | undefined {
  const value = record(input);
  if (
    typeof value.kind !== "string" ||
    !kinds.has(value.kind) ||
    !iso(value.ts) ||
    (value.surface !== "web" && value.surface !== "desktop" && value.surface !== "mobile")
  )
    return;
  const props: Record<string, string | number | ReadonlyArray<readonly [number, number]>> = {};
  const raw = record(value.props);
  for (const [key, allowed] of Object.entries(labels)) {
    if (typeof raw[key] === "string" && allowed.has(raw[key])) props[key] = raw[key];
  }
  // These are identifiers, never arbitrary values from a settings patch or form.
  if (token(raw.key, 160)) props.key = raw.key;
  if (token(raw.poolKey, 160)) props.poolKey = raw.poolKey;
  if (iso(raw.createdAt)) props.createdAt = raw.createdAt;
  for (const key of measurements) if (measurement(raw[key])) props[key] = raw[key];
  const longTask =
    value.kind === "performance.long-task" || value.kind === "performance.long-task-summary";
  if (longTask) {
    for (const key of Object.keys(props))
      if (
        ![
          "method",
          "screen",
          "containerType",
          "containerName",
          "ownerAction",
          "visibleCardCount",
          "visibleThreadCount",
          "subscriptionBytes",
          "subscriptionMessages",
          "count",
          "totalMs",
          "p95Ms",
          "maxMs",
          "wallTimeMs",
        ].includes(key)
      )
        delete props[key];
    if (
      value.kind === "performance.long-task-summary" &&
      Array.isArray(raw.histogram) &&
      raw.histogram.length <= LONG_TASK_HISTOGRAM_BUCKETS
    ) {
      const histogram: Array<readonly [number, number]> = [];
      for (const item of raw.histogram) {
        if (
          !Array.isArray(item) ||
          item.length !== 2 ||
          !Number.isInteger(item[0]) ||
          item[0] < 0 ||
          item[0] >= LONG_TASK_HISTOGRAM_BUCKETS ||
          !measurement(item[1]) ||
          !Number.isInteger(item[1])
        ) {
          histogram.length = 0;
          break;
        }
        histogram.push([item[0], item[1]]);
      }
      props.histogram = histogram;
    }
  }
  const event: ClientAnalyticsEvent = {
    ts: value.ts,
    kind: value.kind,
    surface: value.surface,
    route: typeof value.route === "string" && routes.has(value.route) ? value.route : "other",
    ...(measurement(value.durationMs) ? { durationMs: value.durationMs } : {}),
    ...(Object.keys(props).length ? { props } : {}),
  };
  const cleanIds: Partial<Record<(typeof ids)[number], string>> = {};
  for (const key of ids) if (token(value[key], 512)) cleanIds[key] = value[key];
  return longTask ? event : { ...event, ...cleanIds };
}

export function analyticsErrorTag(error: unknown): string {
  const value = record(error);
  const tag = value._tag ?? value.name;
  return typeof tag === "string" && errorTags.has(tag) ? tag : "unknown";
}

function analyticsDefectTag(defect: unknown): string {
  const value = record(defect);
  // Schema.Defect turns message-bearing objects into Error instances and discards other tags.
  return typeof value.message === "string"
    ? analyticsErrorTag({ name: typeof value.name === "string" ? value.name : "Error" })
    : analyticsErrorTag(defect);
}

// Wire causes are arrays; runtime causes wrap the same reasons. Both paths must group failures alike.
export function analyticsCauseTag(cause: unknown): string {
  const value = record(cause);
  const reasons = Array.isArray(cause) ? cause : Array.isArray(value.reasons) ? value.reasons : [];
  const failure = record(
    reasons.find((reason) => {
      const tag = record(reason)._tag;
      return tag === "Fail" || tag === "Die";
    }),
  );
  if (failure._tag === "Fail") return analyticsErrorTag(failure.error);
  if (failure._tag === "Die") return analyticsDefectTag(failure.defect);
  return reasons.some((reason) => record(reason)._tag === "Interrupt") ? "Interrupted" : "unknown";
}

function captureRpcContext(details: AnalyticsDetails) {
  const cleanIds: Partial<Record<(typeof ids)[number], string>> = {};
  for (const key of ids) if (token(details[key], 512)) cleanIds[key] = details[key];
  return {
    route: typeof details.route === "string" && routes.has(details.route) ? details.route : "other",
    ...cleanIds,
  };
}

/** Counts encoded bytes without retaining the encoded value or its text. */
interface RpcSamples {
  method: string;
  context: ReturnType<typeof captureRpcContext>;
  stream: boolean;
  errorTag?: string;
  count: number;
  bytes: number;
  samples: number[];
}
export interface AnalyticsCollector {
  readonly context: () => AnalyticsDetails;
  readonly endRoute: () => void;
  readonly trackScreen: (details: AnalyticsDetails) => () => void;
  readonly record: (kind: string, details?: AnalyticsDetails) => void;
  readonly setRoute: (details: AnalyticsDetails, foreground?: boolean) => void;
  readonly beginRpc: (
    method: string,
  ) => (durationMs: number, bytes: number, errorTag?: string) => void;
  readonly receivedRpc: (
    method: string,
    context: AnalyticsDetails,
    bytes: number,
    errorTag?: string,
    stream?: boolean,
  ) => void;
  readonly recordLongTask: (entry: LongTaskEntry) => void;
  readonly enableLongTasks: () => void;
  readonly trackLongTaskView: (view: LongTaskView) => () => void;
  readonly flush: () => Promise<void>;
  readonly background: (phase: "background" | "close") => Promise<void>;
  readonly foreground: () => void;
  readonly dispose: () => void;
  readonly pending: () => number;
}

export function createAnalyticsCollector(options: {
  readonly surface: ClientAnalyticsEvent["surface"];
  readonly send: (events: ReadonlyArray<ClientAnalyticsEvent>) => Promise<void>;
  readonly now?: () => number;
  readonly maxEvents?: number;
  readonly flushMs?: number;
}): AnalyticsCollector {
  const now = options.now ?? Date.now;
  const maxEvents = Math.max(ANALYTICS_BATCH_SIZE, options.maxEvents ?? ANALYTICS_MAX_EVENTS);
  let queue: ClientAnalyticsEvent[] = [];
  let inFlight: ClientAnalyticsEvent[] = [];
  let active: Promise<void> | undefined;
  let flushAgain = false;
  let finalDrain = false;
  let disposed = false;
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let route: AnalyticsDetails = { route: "other" };
  let routeStarted = now();
  let visible = true;
  const rpc = new Map<string, RpcSamples>();
  const screens = new Set<{ details: AnalyticsDetails; started: number; elapsed: number }>();
  const views = new Set<LongTaskView>();
  const longTasks = createLongTaskTracker({
    now,
    emit: (kind, route, durationMs, props, at) =>
      enqueue(
        kind,
        { route, ...(durationMs === undefined ? {} : { durationMs }), props },
        false,
        at,
      ),
  });
  const updateLongTaskView = () => {
    const details = [...screens].at(-1)?.details;
    const view = [...views].at(-1);
    const safeRoute = route.route && routes.has(route.route) ? route.route : "other";
    const screen = details?.route ?? view?.screen ?? safeRoute;
    longTasks.context(
      {
        screen: screenKinds.has(screen) ? screen : "other",
        visibleCardCount:
          [...views].reduce((n, view) => n + (view.visibleCardCount ?? 0), 0) +
          (details?.cardId ? 1 : 0),
        visibleThreadCount: [...views].reduce(
          (n, view) => n + (view.visibleThreadCount ?? 0),
          route.route === "thread" ? 1 : 0,
        ),
      },
      safeRoute,
    );
  };
  const arm = () => {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, options.flushMs ?? ANALYTICS_FLUSH_MS);
  };
  const enqueue = (
    kind: string,
    details: AnalyticsDetails = {},
    inheritContext = true,
    at = now(),
  ) => {
    if (disposed) return;
    const event = sanitizeAnalyticsEvent({
      ...(inheritContext ? route : {}),
      ...details,
      props: {
        originKind: options.surface,
        ...(inheritContext ? route.props : {}),
        ...details.props,
      },
      kind,
      surface: options.surface,
      ts: new Date(at).toISOString(),
    });
    if (!event) return;
    const available = maxEvents - inFlight.length;
    if (available <= 0) {
      dropped++;
      return;
    }
    if (queue.length >= available) {
      queue.shift();
      dropped++;
    }
    queue.push(event);
    arm();
  };
  const recordEvent = (kind: string, details?: AnalyticsDetails) => {
    if (
      ["owner.action", "command.palette", "command.keybinding", "settings.change"].includes(kind)
    ) {
      const key = details?.props?.key;
      const method = details?.props?.method;
      longTasks.action(
        key && ownerOperations.has(key) ? key : method && methods.has(method) ? method : kind,
      );
    }
    enqueue(kind, details);
    if (queue.length >= ANALYTICS_BATCH_SIZE) void flush();
  };
  const drainSamples = () => {
    drainLongTaskObserver?.();
    longTasks.flush();
    for (const sample of rpc.values()) {
      sample.samples.sort((a, b) => a - b);
      const percentile = (p: number) =>
        sample.samples[Math.max(0, Math.ceil(sample.samples.length * p) - 1)] ?? 0;
      enqueue(
        "rpc.summary",
        {
          ...sample.context,
          props: {
            method: sample.method,
            count: sample.count,
            bytes: sample.bytes,
            ...(sample.samples.length ? { p50Ms: percentile(0.5), p95Ms: percentile(0.95) } : {}),
            ...(sample.stream ? { phase: "stream" } : {}),
            ...(sample.errorTag ? { errorTag: sample.errorTag } : {}),
          },
        },
        false,
      );
    }
    rpc.clear();
    if (dropped && queue.length < maxEvents - inFlight.length) {
      const count = dropped;
      dropped = 0;
      enqueue("analytics.dropped", { props: { count, reason: "capacity" } });
    }
  };
  const flush = (complete = false): Promise<void> => {
    if (disposed) return Promise.resolve();
    finalDrain ||= complete;
    if (active) {
      flushAgain = true;
      return active;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    active = Promise.resolve()
      .then(async () => {
        let failures = 0;
        do {
          flushAgain = false;
          drainSamples();
          // Ordinary flushes take a snapshot; lifecycle flushes also send arrivals during it.
          let remaining = queue.length;
          while (remaining > 0 && !disposed) {
            inFlight = queue.splice(0, Math.min(remaining, ANALYTICS_BATCH_SIZE));
            remaining -= inFlight.length;
            try {
              await options.send(inFlight);
            } catch {
              queue = [...inFlight, ...queue];
              failures++;
              break;
            } finally {
              inFlight = [];
            }
          }
          // A queued final drain may retry a failed flight once; later attempts use the timer.
          if (failures >= 2) break;
        } while (
          !disposed &&
          (flushAgain || (finalDrain && (queue.length > 0 || rpc.size > 0 || dropped > 0)))
        );
      })
      .finally(() => {
        active = undefined;
        flushAgain = false;
        finalDrain = false;
        arm();
      });
    return active;
  };
  const dwell = () => {
    if (visible) enqueue("screen.dwell", { durationMs: Math.max(0, now() - routeStarted) });
    routeStarted = now();
  };
  const pauseScreens = () => {
    if (visible)
      for (const screen of screens) screen.elapsed += Math.max(0, now() - screen.started);
  };
  const rpcSample = (
    method: string,
    context: ReturnType<typeof captureRpcContext>,
    errorTag?: string,
    stream = false,
  ) => {
    const safeErrorTag =
      errorTag === undefined ? undefined : errorTags.has(errorTag) ? errorTag : "unknown";
    const key = JSON.stringify([
      method,
      context.route,
      ...ids.map((id) => context[id]),
      safeErrorTag,
      stream,
    ]);
    if (!rpc.has(key) && rpc.size >= 128) drainSamples();
    const sample = rpc.get(key) ?? {
      method,
      context,
      stream,
      ...(safeErrorTag ? { errorTag: safeErrorTag } : {}),
      count: 0,
      bytes: 0,
      samples: [],
    };
    rpc.set(key, sample);
    return sample;
  };
  return {
    context: () => route,
    record: recordEvent,
    setRoute: (details, foreground = true) => {
      dwell();
      if (!visible) for (const screen of screens) screen.started = now();
      visible = foreground;
      route = details;
      updateLongTaskView();
      if (foreground) longTasks.foreground();
      else longTasks.pause();
      routeStarted = now();
      recordEvent("screen.open");
    },
    endRoute: () => {
      dwell();
      pauseScreens();
      visible = false;
      longTasks.pause();
    },
    trackScreen: (details) => {
      const screen = { details, started: now(), elapsed: 0 };
      if (screens.size >= 64) return () => {};
      screens.add(screen);
      updateLongTaskView();
      recordEvent("screen.open", details);
      return () => {
        if (!screens.delete(screen)) return;
        updateLongTaskView();
        recordEvent("screen.dwell", {
          ...details,
          durationMs: screen.elapsed + (visible ? Math.max(0, now() - screen.started) : 0),
        });
      };
    },
    beginRpc: (method) => {
      const context = captureRpcContext(route);
      if (!methods.has(method) || method === WS_METHODS.analyticsIngest) return () => {};
      return (durationMs, bytes, errorTag) => {
        if (disposed) return;
        const sample = rpcSample(method, context, errorTag);
        sample.count++;
        sample.bytes += bytes;
        if (sample.samples.length === 256) sample.samples.shift();
        sample.samples.push(Math.max(0, durationMs));
        arm();
      };
    },
    receivedRpc: (method, context, bytes, errorTag, stream = false) => {
      if (!disposed && methods.has(method) && method !== WS_METHODS.analyticsIngest) {
        const sample = rpcSample(method, captureRpcContext(context), errorTag, stream);
        sample.bytes += bytes;
        if (stream) longTasks.received(method, bytes);
        if (stream) sample.count++;
        arm();
      }
    },
    recordLongTask: (entry) => {
      longTasks.record({
        ...entry,
        attribution: entry.attribution?.slice(0, 1).map((item) => ({
          containerType: labels.containerType!.has(item.containerType ?? "")
            ? item.containerType!
            : "unknown",
          // Browser container names can be arbitrary DOM names, including user content.
          containerName: item.containerName ? "redacted" : "none",
        })),
      });
      arm();
    },
    enableLongTasks: () => {
      longTasks.enable();
      arm();
    },
    trackLongTaskView: (view) => {
      if (views.size >= 64) return () => {};
      const clean = {
        screen: screenKinds.has(view.screen) ? view.screen : "other",
        visibleCardCount: measurement(view.visibleCardCount) ? view.visibleCardCount : 0,
        visibleThreadCount: measurement(view.visibleThreadCount) ? view.visibleThreadCount : 0,
      };
      views.add(clean);
      updateLongTaskView();
      return () => {
        views.delete(clean);
        updateLongTaskView();
      };
    },
    flush,
    background: async (phase) => {
      if (visible) dwell();
      pauseScreens();
      visible = false;
      drainLongTaskObserver?.();
      longTasks.flush(true);
      enqueue("client.lifecycle", { props: { phase } });
      await flush(true);
    },
    foreground: () => {
      longTasks.foreground();
      if (!visible) {
        visible = true;
        routeStarted = now();
        for (const screen of screens) screen.started = now();
        recordEvent("client.lifecycle", { props: { phase: "active" } });
      }
    },
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      queue = [];
      rpc.clear();
    },
    pending: () => queue.length + inFlight.length,
  };
}

const collectors = new Map<string, AnalyticsCollector>();
let drainLongTaskObserver: (() => void) | undefined;
export function registerAnalyticsLongTaskObserver(drain: () => void) {
  drainLongTaskObserver = drain;
  return () => {
    if (drainLongTaskObserver === drain) drainLongTaskObserver = undefined;
  };
}
let activeEnvironmentId: string | null = null;
const longTaskEnvironments: Array<{ at: number; environmentId: string | null }> = [];
export const analyticsForEnvironment = (environmentId: string | null | undefined) =>
  environmentId ? collectors.get(environmentId) : undefined;
export function registerEnvironmentAnalytics(
  environmentId: string,
  collector: AnalyticsCollector,
): () => void {
  const previous = collectors.get(environmentId);
  previous?.dispose();
  collectors.set(environmentId, collector);
  return () => {
    if (collectors.get(environmentId) === collector) {
      collectors.delete(environmentId);
      collector.dispose();
    }
  };
}
export const setActiveAnalyticsEnvironment = (environmentId: string | null, at = Date.now()) => {
  drainLongTaskObserver?.();
  longTaskEnvironments.push({ at, environmentId });
  if (longTaskEnvironments.length > 128) longTaskEnvironments.shift();
  activeEnvironmentId = environmentId;
};
export const activeAnalytics = () => analyticsForEnvironment(activeEnvironmentId);
export const analyticsForLongTask = (startedAt: number) =>
  analyticsForEnvironment(
    longTaskEnvironments.findLast((entry) => entry.at <= startedAt)?.environmentId,
  );
export async function flushEnvironmentAnalytics(phase: "background" | "close") {
  const active = activeAnalytics();
  await Promise.all(
    [...collectors.values()].map((collector) =>
      collector === active ? collector.background(phase) : collector.flush(),
    ),
  );
}

const streamMethods = new Set<string>([
  WS_METHODS.codexAuthCallbackSubscribe,
  WS_METHODS.providerAuthSubscribe,
  WS_METHODS.providerInstallSubscribe,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
  ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
  WS_METHODS.subscribeAuthAccess,
  WS_METHODS.subscribeBackgroundPolicy,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.scheduledTasksSubscribe,
  WS_METHODS.serverGetStorageCleanupReport,
  WS_METHODS.serverGetDatabaseStorage,
  WS_METHODS.subscribeTerminalEvents,
  WS_METHODS.subscribeTerminalMetadata,
  WS_METHODS.subscribePreviewEvents,
  WS_METHODS.subscribeDiscoveredLocalServers,
  WS_METHODS.subscribeDeviceState,
  WS_METHODS.subscribeResourceTelemetry,
  WS_METHODS.pullRequestsSubscribeRefreshes,
  WS_METHODS.subscribeVcsStatus,
  WS_METHODS.subscribeWorktreeSetup,
  WS_METHODS.subscribeProjectClones,
  WS_METHODS.terminalAttach,
  WS_METHODS.terminalObserve,
  WS_METHODS.chatGptHandoffSubscribe,
  WS_METHODS.cloudInstallRelayClient,
  WS_METHODS.serverUpdateServerWithProgress,
  WS_METHODS.gitRunStackedAction,
  KANBAN_WS_METHODS.subscribe,
  KANBAN_WS_METHODS.boards,
]);

function jsonFrameBytes(data: Uint8Array | string, count: number): number[] {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  const sizes: number[] = [];
  let bytes = 0,
    depth = 0,
    start = 0;
  let quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const before = bytes;
    bytes +=
      code < 128
        ? 1
        : code < 2048
          ? 2
          : code >= 0xd800 &&
              code <= 0xdbff &&
              text.charCodeAt(i + 1) >= 0xdc00 &&
              text.charCodeAt(i + 1) <= 0xdfff
            ? 1
            : 3;
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (depth === 1 && char === "{") start = before;
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 1 && char === "}") sizes.push(bytes - start);
    }
  }
  return count === 1 ? [typeof data === "string" ? bytes : data.byteLength] : sizes;
}

/** Count the bytes already received by the JSON transport; never serialize a result again. */
export function analyticsRpcSerialization(
  environmentId: string,
): RpcSerialization.RpcSerialization["Service"] & { readonly disconnected: () => void } {
  // One serialization service belongs to one WebSocket session, including its disconnect hook.
  const pending = new Map<
    string | number,
    {
      method: string;
      context: ReturnType<typeof captureRpcContext>;
      collector: AnalyticsCollector;
      stream: boolean;
    }
  >();
  const failStreams = (errorTag: string) => {
    for (const request of pending.values()) {
      if (request.stream)
        request.collector.receivedRpc(request.method, request.context, 0, errorTag, true);
    }
    pending.clear();
  };
  return {
    ...RpcSerialization.json,
    disconnected: () => failStreams("RpcClientError"),
    makeUnsafe: () => {
      const parser = RpcSerialization.json.makeUnsafe();
      return {
        encode: (input) => {
          const message = record(input);
          if (
            message._tag === "Request" &&
            (typeof message.id === "string" || typeof message.id === "number") &&
            typeof message.tag === "string" &&
            methods.has(message.tag) &&
            message.tag !== WS_METHODS.analyticsIngest
          ) {
            const collector = analyticsForEnvironment(environmentId);
            if (collector) {
              if (pending.size >= 1_024) pending.delete(pending.keys().next().value!);
              pending.set(message.id, {
                method: message.tag,
                context: captureRpcContext(collector.context()),
                collector,
                stream: streamMethods.has(message.tag),
              });
            }
          }
          if (
            message._tag === "Interrupt" &&
            (typeof message.requestId === "string" || typeof message.requestId === "number")
          )
            pending.delete(message.requestId);
          return parser.encode(input);
        },
        decode: (data) => {
          const decoded = parser.decode(data);
          const relevant = decoded.some((item) => {
            const id = record(item).requestId;
            return (typeof id === "string" || typeof id === "number") && pending.has(id);
          });
          const sizes = relevant ? jsonFrameBytes(data, decoded.length) : [];
          for (let i = 0; i < decoded.length; i++) {
            const message = record(decoded[i]);
            if (message._tag === "Defect") {
              failStreams(analyticsDefectTag(message.defect));
              continue;
            }
            if (typeof message.requestId !== "string" && typeof message.requestId !== "number")
              continue;
            const request = pending.get(message.requestId);
            if (!request) continue;
            if (message._tag === "Chunk") request.stream = true;
            const exit = record(message.exit);
            request.collector.receivedRpc(
              request.method,
              request.context,
              sizes[i] ?? 0,
              exit._tag === "Failure" ? analyticsCauseTag(exit.cause) : undefined,
              request.stream || message._tag === "Chunk",
            );
            if (message._tag === "Exit") pending.delete(message.requestId);
          }
          return decoded;
        },
      };
    },
  };
}
export const recordAnalytics = (
  environmentId: string | null | undefined,
  kind: string,
  details?: AnalyticsDetails,
) => analyticsForEnvironment(environmentId)?.record(kind, details);
export const trackAnalyticsScreen = (
  environmentId: string | null | undefined,
  details: AnalyticsDetails,
) => analyticsForEnvironment(environmentId)?.trackScreen(details) ?? (() => {});

/** Only known ID fields are inspected; request/result bodies are never copied. */
export function analyticsOwnerAction(method: string, input: unknown): AnalyticsDetails | undefined {
  if (!ownerMutationMethods.has(method)) return;
  const value = record(input);
  const meta: Partial<Record<(typeof ids)[number], string>> = {};
  for (const key of ids) if (token(value[key], 512)) meta[key] = value[key];
  const command = record(value.command);
  for (const key of ids) if (!meta[key] && token(command[key], 512)) meta[key] = command[key];
  const changedFields =
    method === KANBAN_WS_METHODS.cardPatch
      ? cardPatchKeys.filter((key) => Object.hasOwn(value, key))
      : [];
  const key =
    method === KANBAN_WS_METHODS.cardAsk && (value.action === "drop" || value.action === "block")
      ? value.action
      : changedFields.length
        ? changedFields.join(".")
        : typeof value.type === "string" && ownerOperations.has(value.type)
          ? value.type
          : undefined;
  return { ...meta, props: { method, ...(key ? { key } : {}) } };
}

export function recordAnalyticsSearch(
  collector: AnalyticsCollector | undefined,
  method: string,
  input: unknown,
  output: unknown,
) {
  if (!searchMethods.has(method)) return;
  const value = record(input),
    result = record(output);
  if (result.complete === false) return;
  const query = typeof value.query === "string" ? value.query : "";
  const matches = result.matches ?? result.entries ?? result.results;
  collector?.record("search", {
    props: {
      method,
      queryLength: query.length,
      resultCount: measurement(result.totalMatches)
        ? result.totalMatches
        : Array.isArray(matches)
          ? matches.length
          : 0,
    },
  });
}

export function recordSettingsKeys(collector: AnalyticsCollector | undefined, patch: unknown) {
  for (const key of Object.keys(record(patch))) {
    if (settingsKeys.has(key)) collector?.record("settings.change", { props: { key } });
  }
}

export function analyticsWebScreen(pathname: string): {
  environmentId?: string;
  details: AnalyticsDetails;
} {
  const parts = pathname.split(/[?#]/, 1)[0]!.split("/").filter(Boolean);
  const first = parts[0] ?? "";
  if (first === "boards")
    return { details: { route: "board", ...(token(parts[1], 512) ? { boardId: parts[1] } : {}) } };
  if (first === "needs-you") return { details: { route: "needs-owner" } };
  if (first === "settings") return { details: { route: "settings" } };
  if (["usage", "projects", "pull-requests", "imessage", "welcome"].includes(first))
    return { details: { route: first } };
  if (["pair", "connect", "connect-agent"].includes(first))
    return { details: { route: "connect" } };
  if (
    parts.length === 2 &&
    !["draft", "new"].includes(first) &&
    token(first, 512) &&
    token(parts[1], 512)
  ) {
    return { environmentId: first, details: { route: "thread", threadId: parts[1] } };
  }
  return {
    details: { route: first === "" || first === "new" || first === "draft" ? "home" : "other" },
  };
}

export function analyticsNavigationScreen(
  name: string,
  params: unknown,
): { environmentId?: string; details: AnalyticsDetails } {
  const value = record(params);
  const route = name.startsWith("NeedsYou")
    ? name === "NeedsYouAsk"
      ? "ask"
      : name === "NeedsYouDiscussion"
        ? "discussion"
        : "needs-owner"
    : name === "KanbanRecord"
      ? value.kind === "card"
        ? "card"
        : "discussion"
      : name.startsWith("Kanban") || name === "NewBoard"
        ? "board"
        : name.startsWith("Settings")
          ? "settings"
          : name.startsWith("Thread")
            ? "thread"
            : name.startsWith("IMessage")
              ? "imessage"
              : name.startsWith("PullRequest")
                ? "pull-requests"
                : name.startsWith("Usage")
                  ? "usage"
                  : name.startsWith("Connect")
                    ? "connect"
                    : "home";
  const details: AnalyticsDetails = { route };
  const meta: Partial<Record<(typeof ids)[number], string>> = {};
  for (const key of ids) if (token(value[key], 512)) meta[key] = value[key];
  if (name === "KanbanRecord" && token(value.id, 512))
    meta[value.kind === "card" ? "cardId" : "discussionId"] = value.id;
  return {
    ...(token(value.environmentId, 512) ? { environmentId: value.environmentId } : {}),
    details: {
      ...details,
      ...meta,
      ...(token(value.askId, 160) ? { props: { key: value.askId } } : {}),
    },
  };
}

/** A finite frame sample after navigation; no persistent repaint loop. */
export function sampleAnalyticsFrames(
  collector: AnalyticsCollector,
  schedule: (run: (time: number) => void) => number,
  cancel: (id: number) => void,
) {
  let previous: number | undefined;
  let count = 0;
  let droppedFrames = 0;
  let id = 0;
  const frame = (time: number) => {
    if (previous !== undefined)
      droppedFrames += Math.max(0, Math.round((time - previous) / (1000 / 60)) - 1);
    previous = time;
    if (++count < 12) id = schedule(frame);
    else collector.record("performance.frames", { props: { count, droppedFrames } });
  };
  id = schedule(frame);
  return () => cancel(id);
}
