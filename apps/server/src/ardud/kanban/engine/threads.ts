// @effect-diagnostics nodeBuiltinImport:off - command ids only need a random UUID.
import * as NodeCrypto from "node:crypto";
import * as EvaluatorAnalytics from "./evaluatorAnalytics.ts";
import { BACKGROUND_GRACE_MS, isUnconfirmedPromptAcceptance } from "./rules.ts";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type NodeId,
  RunId,
  type OrchestrationV2UserInputQuestion,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type RuntimeRequestId,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  rootRuntimeLoss,
} from "@t3tools/shared/orchestrationV2ThreadError";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as EffectOutbox from "../../../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as OrchestrationCommandReceipts from "../../../persistence/OrchestrationCommandReceipts.ts";
import { analyticsErrorTag } from "../../../observability/RpcInstrumentation.ts";
import { type ControlThreadState, stateFromRunStatus } from "../../control/model.ts";

export class KanbanThreadError extends Schema.TaggedError<KanbanThreadError>()(
  "KanbanThreadError",
  {
    operation: Schema.String,
    detail: Schema.String,
    rejected: Schema.optional(Schema.Boolean),
    retryable: Schema.optional(Schema.Boolean),
    wakeMessageId: Schema.optional(Schema.String),
    sentRunId: Schema.optional(Schema.String),
  },
) {}

const isKanbanThreadError = Schema.is(KanbanThreadError);
const isCommandRejected = Schema.is(Orchestrator.OrchestratorCommandRejectedError);
const isCommandPreviouslyRejected = Schema.is(
  Orchestrator.OrchestratorCommandPreviouslyRejectedError,
);

export interface KanbanThreadPr {
  readonly url: string;
  readonly title: string | null;
  readonly state: "open" | "draft" | "merged" | "closed";
  /** The watch's CI checkpoint, which may lag the observed branch head. */
  readonly head?: string | null;
  /** Latest branch head observed by a live watch; null when unknown. */
  readonly observedHead?: string | null;
  /** Checks on the head as last synced; null when none were reported. */
  readonly checks?: "passing" | "failing" | "pending" | null;
  /** When its state and checks were last synced from the host; null when never. */
  readonly at?: string | null;
}

export interface KanbanThreadView {
  readonly activeInWindow?: boolean;
  readonly turnsInWindow?: number;
  readonly lastAssistant?: {
    readonly at: string;
    readonly text: string;
    readonly itemId?: string;
  } | null;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly state: ControlThreadState;
  readonly updatedAt: string;
  /** When the thread itself last did something: its open question, else its last finished run. updatedAt also moves on shared provider-session updates. */
  readonly quietSince: string;
  /** When the current run started, or null when no run is active. */
  readonly runStartedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly openToolSince?: string | null;
  readonly openToolKind?: string | null;
  readonly runId?: string | null;
  readonly latestRunId?: string | null;
  readonly runRequestedAt?: string | null;
  readonly runMessageId?: string | null;
  readonly runStatus?: string | null;
  readonly restartRecovery?: { readonly effectId?: string; readonly runId?: string } | undefined;
  /** Its own subagents, commands and background tasks still running after its turn ended. Pull-request watches are counted in prWatches instead. */
  readonly backgroundWork: number;
  readonly backgroundWorkUntil?: string;
  readonly backgroundJobs?: OrchestrationV2ThreadShell["pendingBackgroundTasks"];
  /** Pull requests this thread watches (watch_pull_request) that are still open or draft. The watch wakes it on CI and review changes. */
  readonly prWatches: number;
  readonly prs: ReadonlyArray<KanbanThreadPr>;
  readonly archived: boolean;
}

export interface KanbanLaunchInput {
  readonly messageId?: MessageId;
  readonly onStarted?: (threadId: ThreadId) => Effect.Effect<void>;
  /** Stable per logical launch so a retry finds the same thread. */
  readonly key: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly model: ModelSelection;
  readonly text: string;
}

export interface KanbanSendInput {
  /** Observes a newly accepted delivery, excluding receipt replays and coalesced no-ops. */
  readonly onAccepted?: (identity: string) => Effect.Effect<void>;
  /** Called at the durable acceptance boundary, before any projection or board revalidation. */
  readonly onCommitted?: () => void;
  readonly flushQueued?: "wake" | "steer";
  readonly threadId: ThreadId;
  readonly text: string;
  /** Stable per logical send when a retry must not deliver a second message. */
  readonly key?: string;
  /** One logical delivery across replacement recipients; only rejected attempts may send again. */
  readonly keyAcrossThreads?: boolean;
  /** Assignment rollback may have withdrawn an accepted run; retry that terminal delivery. */
  readonly retryWithdrawn?: boolean;
  readonly withdrawalText?: string;
  readonly withdrawalBefore?: string;
  /** Replace the oldest queued board wake in this thread with the same scope. */
  readonly coalesce?: string;
  /** Departure can invalidate a snapshot while its queue read is in flight. */
  readonly isStale?: () => boolean;
  /** Switch the thread to this model for the turn the message starts. */
  readonly model?: ModelSelection;
  /** Queue waits behind a live turn; steer only targets an existing turn. */
  readonly mode?: "steer" | "queue";
}

type KanbanInterruptResult =
  | { readonly outcome: "noop" }
  | { readonly outcome: "requested"; readonly runId: string };

/**
 * The few thread operations the board needs. Every message is delivered as a
 * steer when supported by a live turn, otherwise it starts or queues a turn.
 */
export interface KanbanThreadsShape {
  readonly pendingUserInputs: (threadId: ThreadId) => Effect.Effect<
    ReadonlyArray<{
      readonly requestId: RuntimeRequestId;
      readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
    }>,
    KanbanThreadError
  >;
  readonly claimContext: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly projectId: ProjectId; readonly model: ModelSelection } | null,
    KanbanThreadError
  >;
  readonly view: (threadId: ThreadId) => Effect.Effect<KanbanThreadView | null>;
  /** Like view, but a failed read fails: null means the thread is gone. */
  readonly find: (
    threadId: ThreadId,
    options?: {
      readonly lastAssistant: boolean;
      readonly window?: { readonly since: string; readonly until: string };
    },
  ) => Effect.Effect<KanbanThreadView | null, KanbanThreadError>;
  /** The selected model, or the active run's recorded model when requested. */
  readonly model: (threadId: ThreadId, activeRun?: boolean) => Effect.Effect<ModelSelection | null>;
  /** The root provider failure of the thread's latest executed run, if that run failed. */
  // runId names the executed run, so a repeated notification of the same run is recognised.
  readonly lastFailure: (threadId: ThreadId) => Effect.Effect<
    | (OrchestrationV2ProviderFailure & {
        readonly runId?: string | null;
        readonly model?: ModelSelection | null;
      })
    | null
  >;
  /** With afterRunId, find the latest persisted start after that run, even if finished. */
  readonly latestRun: (
    threadId: ThreadId,
    afterRunId?: string,
  ) => Effect.Effect<
    {
      readonly runId: string;
      readonly status: string;
      readonly cancelReason?: OrchestrationV2Run["cancelReason"];
      readonly cancelDetail?: string | undefined;
      readonly message: string | null;
      readonly model?: ModelSelection | null;
    } | null,
    KanbanThreadError
  >;
  readonly runSettled: (
    threadId: ThreadId,
    runId: string,
  ) => Effect.Effect<boolean, KanbanThreadError>;
  readonly backgroundStoppedSince: (
    threadId: ThreadId,
    since: string,
  ) => Effect.Effect<boolean, KanbanThreadError>;
  readonly compactRun: (
    threadId: ThreadId,
    runId: string,
  ) => Effect.Effect<
    {
      readonly status: string;
      readonly cancelReason?: OrchestrationV2Run["cancelReason"];
      readonly cancelDetail?: string | undefined;
      readonly message: string | null;
      readonly messageId?: string;
      readonly model?: ModelSelection | null;
    } | null,
    KanbanThreadError
  >;
  readonly findLastFailure: (threadId: ThreadId) => Effect.Effect<
    | (OrchestrationV2ProviderFailure & {
        readonly runId?: string | null;
        readonly model?: ModelSelection | null;
      })
    | null,
    KanbanThreadError
  >;
  readonly launch: (input: KanbanLaunchInput) => Effect.Effect<ThreadId, KanbanThreadError>;
  readonly send: (input: KanbanSendInput) => Effect.Effect<string | void, KanbanThreadError>;
  /** Recovers the durable recipient of a keyed send, including across service restarts. */
  readonly acceptedSend?: (key: string) => Effect.Effect<ThreadId | null, KanbanThreadError>;
  readonly withdraw: (input: {
    readonly threadId: ThreadId;
    readonly key: string;
    readonly text: string;
    readonly retryWithdrawn?: boolean;
    readonly withdrawalBefore?: string;
  }) => Effect.Effect<void | "pending">;
  /** Switches an open thread to this model now; does nothing when it already runs it. */
  readonly setModel: (
    threadId: ThreadId,
    model: ModelSelection,
  ) => Effect.Effect<void, KanbanThreadError>;
  /** Include live runs when a successor check needs one projection snapshot. */
  readonly queuedRuns: (
    threadId: ThreadId,
    includeActive?: boolean,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2Run>, KanbanThreadError>;
  /** Cancels only this queued brief; false means it may already be acting. */
  readonly cancelQueued: (
    threadId: ThreadId,
    runId: string,
    cancelReason?: OrchestrationV2Run["cancelReason"],
  ) => Effect.Effect<boolean, KanbanThreadError>;
  readonly remove: (threadId: ThreadId) => Effect.Effect<void, KanbanThreadError>;
  /** A thread that no longer exists counts as stopped; a failed read or stop fails. */
  readonly interrupt: (
    threadId: ThreadId,
    reason: string,
    cancelQueued?: boolean,
    runId?: string,
    messageId?: string,
    cancelReason?: OrchestrationV2Run["cancelReason"],
  ) => Effect.Effect<KanbanInterruptResult | void, KanbanThreadError>;
}

export class KanbanThreads extends Context.Service<KanbanThreads, KanbanThreadsShape>()(
  "t3/ardud/kanban/engine/threads/KanbanThreads",
) {}

// Assignment briefs carry new work and must survive input that supersedes reminder snapshots.
const scopedMessagePrefix = (scope: string) =>
  scope.startsWith("assignment:") ? `kanban:${scope}:` : `kanban:wake:${scope}:`;

export const coalesceTarget = <
  R extends Pick<OrchestrationV2Run, "ordinal" | "status" | "userMessageId">,
>(
  runs: ReadonlyArray<R>,
  scope: string,
): R | undefined => {
  const prefix = scopedMessagePrefix(scope);
  let oldest: R | undefined;
  for (const run of runs) {
    if (
      run.status === "queued" &&
      run.userMessageId.startsWith(prefix) &&
      (oldest === undefined || run.ordinal < oldest.ordinal)
    )
      oldest = run;
  }
  return oldest;
};

export const queuedWakes = <
  R extends Pick<OrchestrationV2Run, "ordinal" | "status" | "userMessageId">,
>(
  runs: ReadonlyArray<R>,
  beforeOrdinal = Infinity,
  scopes?: ReadonlyArray<string>,
): R[] =>
  runs
    .filter(
      (run) =>
        run.status === "queued" &&
        run.ordinal < beforeOrdinal &&
        (scopes === undefined
          ? run.userMessageId.startsWith("kanban:wake:")
          : scopes.some((scope) => run.userMessageId.startsWith(scopedMessagePrefix(scope)))),
    )
    .toSorted((a, b) => a.ordinal - b.ordinal);

const hasQueuedMessage = (
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "userMessageId">>,
) => runs.some((run) => run.status === "queued" && !run.userMessageId.startsWith("kanban:wake:"));

const commandId = (prefix: string) => CommandId.make(`kanban:${prefix}:${NodeCrypto.randomUUID()}`);

const detailOf = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

const sendError = (error: unknown, wakeMessageId?: string, sentRunId?: string) => {
  if (isKanbanThreadError(error) && wakeMessageId === undefined && sentRunId === undefined)
    return error;
  return new KanbanThreadError({
    ...(isKanbanThreadError(error)
      ? error
      : {
          operation: "send",
          detail: detailOf(error),
          rejected: isCommandPreviouslyRejected(error),
        }),
    ...(wakeMessageId === undefined ? {} : { wakeMessageId }),
    ...(sentRunId === undefined ? {} : { sentRunId }),
  });
};

/**
 * The state and quiet-since of a thread from the shell fields that matter here.
 * An async question (blocking false) doesn't stop the run, so it counts as no question at all.
 */
export const viewStateOf = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "pendingRuntimeRequest" | "activityRunStatus" | "status" | "updatedAt" | "latestRunCompletedAt"
  >,
): { readonly state: ControlThreadState; readonly quietSince: DateTime.Utc } => {
  const request = shell.pendingRuntimeRequest;
  const blocking = request !== null && request.blocking !== false ? request : null;
  const state = stateFromRunStatus(shell.activityRunStatus ?? shell.status, blocking !== null);
  const quietSince = blocking?.createdAt ?? shell.latestRunCompletedAt ?? shell.updatedAt;
  return { state, quietSince };
};

/** Background work that still runs for the thread once its turn ended. */
export const backgroundWorkOf = (
  shell: Pick<OrchestrationV2ThreadShell, "pendingBackgroundTasks">,
  completions: ReadonlyArray<OrchestrationV2Subagent> = [],
  descendants: ReadonlySet<NodeId> = new Set(),
): number =>
  (shell.pendingBackgroundTasks ?? []).filter(
    // Commands may finish the turn, but their completion still wakes an idle worker.
    (task) => !task.taskId.startsWith("pull-request-watch:"),
  ).length +
  completions.filter((task) => completionPending(task) || descendants.has(task.id)).length;

const completionPending = (task: OrchestrationV2Subagent) =>
  task.origin === "app_owned" &&
  ["completed", "failed", "cancelled", "interrupted"].includes(task.status) &&
  (task.completionDelivery?.state === "pending" || task.completionDelivery?.state === "claimed");

const backgroundWorkUntil = (
  quietSince: DateTime.Utc,
  tasks: ReadonlyArray<OrchestrationV2Subagent>,
  activity: ReadonlyMap<ThreadId, DateTime.Utc>,
  otherBackgroundUntil?: number,
): string | undefined => {
  if (tasks.length === 0 && otherBackgroundUntil === undefined) return undefined;
  const quiet = DateTime.toEpochMillis(quietSince);
  return DateTime.formatIso(
    DateTime.makeUnsafe(
      Math.max(
        ...(otherBackgroundUntil === undefined ? [] : [otherBackgroundUntil]),
        ...tasks.map((task) => {
          const progress =
            task.childThreadId === null ? undefined : activity.get(task.childThreadId);
          const since = completionPending(task)
            ? task.updatedAt
            : (progress ?? task.startedAt ?? task.updatedAt);
          const timeout = completionPending(task)
            ? BACKGROUND_GRACE_MS
            : task.idleTimeoutMs && Number.isFinite(task.idleTimeoutMs)
              ? Math.min(2 * BACKGROUND_GRACE_MS, Math.max(60_000, task.idleTimeoutMs))
              : BACKGROUND_GRACE_MS;
          return Math.max(quiet, DateTime.toEpochMillis(since)) + timeout;
        }),
      ),
    ),
  );
};

export const prWatchesOf = (shell: Pick<OrchestrationV2ThreadShell, "pullRequests">): number =>
  (shell.pullRequests ?? []).filter(
    (pr) =>
      pr.watch !== undefined &&
      pr.source !== "stack-dismissed" &&
      (pr.snapshot === null || pr.snapshot.state === "open"),
  ).length;

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
  const outbox = yield* EffectOutbox.EffectOutboxV2;

  const find: KanbanThreadsShape["find"] = Effect.fn("KanbanThreads.find")(
    function* (threadId, options) {
      // Read the effect first so its retirement cannot hide a newly committed recovery run.
      const effectId = yield* outbox.pendingRunContinuation(threadId);
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) return null;
      const runId = shell.activeRunId;
      const records = yield* threads.getThreadRecords(
        threadId,
        runId === null ? ["runs", "subagents"] : ["runs"],
        {
          ...(runId === null ? { latestRunOnly: true } : { runIds: [runId] }),
          pendingBackgroundTasksOnly: true,
        },
        { projectionOnly: true },
      );
      const latest = records.runs[0];
      const run = runId === null ? undefined : latest;
      const restartRecovery =
        effectId !== null
          ? { effectId }
          : latest?.restartContinuationOfRunId !== undefined &&
              latest.startedAt === null &&
              (latest.status === "queued" || latest.status === "starting")
            ? { runId: latest.id }
            : undefined;
      // The shell drops terminal items before their completion wake is accepted.
      const pending = runId === null ? records.subagents : [];
      const activityByChild = new Map<ThreadId, DateTime.Utc>();
      const pendingTree = [...pending];
      const visited = new Set<ThreadId>([threadId]);
      const descendants = new Set<NodeId>();
      const threadsWithBackground = new Set<ThreadId>();
      let otherBackgroundUntil =
        backgroundWorkOf(shell) >
        pending.filter((task) => ["pending", "running", "waiting"].includes(task.status)).length
          ? DateTime.toEpochMillis(viewStateOf(shell).quietSince) + BACKGROUND_GRACE_MS
          : undefined;
      // Each descendant keeps its own silence timeout or completion-delivery grace.
      for (const task of pendingTree) {
        if (task.childThreadId === null) continue;
        if (visited.has(task.childThreadId)) continue;
        visited.add(task.childThreadId);
        const childShell = yield* threads.getThreadShell(task.childThreadId);
        if (childShell === null || childShell.deletedAt !== null) continue;
        const child = yield* threads.getThreadRecords(
          task.childThreadId,
          ["runs", "subagents"],
          {
            ...(childShell.activeRunId === null
              ? { latestRunOnly: true }
              : { runIds: [childShell.activeRunId] }),
            pendingBackgroundTasksOnly: true,
          },
          { projectionOnly: true },
        );
        const latest = child.runs[0];
        if (latest)
          activityByChild.set(
            task.childThreadId,
            latest.lastActivityAt ?? latest.startedAt ?? latest.requestedAt,
          );
        const background = backgroundWorkOf(childShell, child.subagents);
        // A completion wake hides pending shell work while its run is active.
        const activeDelegates =
          childShell.activeRunId !== null &&
          child.subagents.some((nested) =>
            ["pending", "running", "waiting"].includes(nested.status),
          );
        if (background > 0 || activeDelegates) {
          threadsWithBackground.add(task.childThreadId);
          if (
            backgroundWorkOf(childShell) >
            child.subagents.filter((nested) =>
              ["pending", "running", "waiting"].includes(nested.status),
            ).length
          ) {
            const quiet = DateTime.toEpochMillis(viewStateOf(childShell).quietSince);
            const activity = latest?.lastActivityAt
              ? DateTime.toEpochMillis(latest.lastActivityAt)
              : quiet;
            otherBackgroundUntil = Math.max(
              otherBackgroundUntil ?? 0,
              Math.max(quiet, activity) + BACKGROUND_GRACE_MS,
            );
          }
        }
        pendingTree.push(...child.subagents);
      }
      const terminalParents = new Map<ThreadId, OrchestrationV2Subagent[]>();
      for (const task of pendingTree) {
        if (
          task.childThreadId !== null &&
          ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
        ) {
          const parents = terminalParents.get(task.childThreadId) ?? [];
          parents.push(task);
          terminalParents.set(task.childThreadId, parents);
        }
      }
      // Propagate validated work through terminal ancestors, including shared subtrees.
      for (const childId of threadsWithBackground) {
        for (const task of terminalParents.get(childId) ?? []) {
          descendants.add(task.id);
          threadsWithBackground.add(task.threadId);
        }
      }
      const until = backgroundWorkUntil(
        viewStateOf(shell).quietSince,
        pendingTree.filter(
          (task) =>
            ["pending", "running", "waiting"].includes(task.status) || completionPending(task),
        ),
        activityByChild,
        otherBackgroundUntil,
      );
      const started = shell.activityRunStartedAt;
      const activity = run?.lastActivityAt;
      const oldestTool = Object.values(run?.openTools ?? {}).reduce<{
        kind: string;
        since: string;
      } | null>(
        (oldest, tool) =>
          oldest === null || Date.parse(tool.since) < Date.parse(oldest.since) ? tool : oldest,
        null,
      );
      const digestRecords = options?.lastAssistant
        ? yield* threads.getThreadRecords(
            threadId,
            ["runs", "turnItems"],
            {
              turnItemTypes: ["assistant_message"],
              recentTurnItemLimit: 1,
            },
            { projectionOnly: true },
          )
        : null;
      const newest = digestRecords?.turnItems[0];
      const window = options?.window;
      const matchingRuns =
        window === undefined
          ? undefined
          : (digestRecords?.runs ?? []).filter((entry) => {
              const since = DateTime.toEpochMillis(DateTime.makeUnsafe(window.since));
              const until = DateTime.toEpochMillis(DateTime.makeUnsafe(window.until));
              const requested = DateTime.toEpochMillis(entry.requestedAt);
              if (requested >= since && requested < until) return true;
              if (entry.startedAt === null) return false;
              const start = DateTime.toEpochMillis(entry.startedAt);
              const end =
                entry.completedAt ??
                (["preparing", "starting", "running", "waiting"].includes(entry.status)
                  ? null
                  : (entry.lastActivityAt ?? entry.startedAt));
              return start < until && (end === null || DateTime.toEpochMillis(end) >= since);
            });
      return {
        threadId: shell.id,
        ...(matchingRuns === undefined
          ? {}
          : { activeInWindow: matchingRuns.length > 0, turnsInWindow: matchingRuns.length }),
        ...(options?.lastAssistant
          ? {
              lastAssistant:
                newest?.type === "assistant_message"
                  ? {
                      at: DateTime.formatIso(newest.updatedAt),
                      text: newest.text.slice(0, 300),
                      itemId: newest.id,
                    }
                  : null,
            }
          : {}),
        projectId: shell.projectId,
        title: shell.title,
        state: viewStateOf(shell).state,
        updatedAt: DateTime.formatIso(shell.updatedAt),
        quietSince: DateTime.formatIso(viewStateOf(shell).quietSince),
        runStartedAt: shell.activityRunStartedAt
          ? DateTime.formatIso(shell.activityRunStartedAt)
          : null,
        lastActivityAt:
          activity &&
          (!started || DateTime.toEpochMillis(activity) > DateTime.toEpochMillis(started))
            ? DateTime.formatIso(activity)
            : started
              ? DateTime.formatIso(started)
              : null,
        latestRunId: latest?.id ?? null,
        openToolSince: oldestTool?.since ?? null,
        openToolKind: oldestTool?.kind ?? null,
        runId,
        runRequestedAt: run ? DateTime.formatIso(run.requestedAt) : null,
        runMessageId: run?.userMessageId ?? null,
        runStatus: run?.status ?? null,
        restartRecovery,
        backgroundWork: backgroundWorkOf(shell, pending, descendants),
        ...(until === undefined ? {} : { backgroundWorkUntil: until }),
        backgroundJobs: (shell.pendingBackgroundTasks ?? []).filter(
          (task) => !task.taskId.startsWith("pull-request-watch:"),
        ),
        prWatches: prWatchesOf(shell),
        archived: shell.archivedAt !== null,
        prs: (shell.pullRequests ?? []).map((pr) => ({
          url: pr.url,
          title: pr.snapshot?.title ?? null,
          state:
            pr.snapshot === null
              ? "open"
              : pr.snapshot.state === "open" && pr.snapshot.isDraft
                ? "draft"
                : pr.snapshot.state,
          // Only a live watch: an ended one's head may be commits behind.
          head: pr.watch?.headSha ?? null,
          observedHead: pr.watch?.observedHeadSha ?? null,
          checks: pr.snapshot?.checksState ?? null,
          at: pr.snapshot?.syncedAt ?? null,
        })),
      } satisfies KanbanThreadView;
    },
    Effect.mapError(
      (error) => new KanbanThreadError({ operation: "view", detail: detailOf(error) }),
    ),
  );

  const claimContext = Effect.fn("KanbanThreads.claimContext")(
    function* (threadId: ThreadId) {
      // Claim eligibility needs neither thread history nor activity/shell aggregation.
      const row = yield* threads.getCallerRow(threadId);
      return row === null ? null : { projectId: row.projectId, model: row.modelSelection };
    },
    Effect.mapError(
      (error) => new KanbanThreadError({ operation: "claimContext", detail: detailOf(error) }),
    ),
  );

  const view: KanbanThreadsShape["view"] = (threadId) =>
    find(threadId).pipe(Effect.catchCause(() => Effect.succeed(null)));

  const model: KanbanThreadsShape["model"] = (threadId, activeRun = false) =>
    threads.getThreadShell(threadId).pipe(
      Effect.flatMap((shell) => {
        if (shell === null || shell.deletedAt !== null) return Effect.succeed(null);
        if (!activeRun) return Effect.succeed(shell.modelSelection);
        if (shell.activeRunId === null) return Effect.succeed(null);
        return threads
          .getThreadRecords(threadId, ["runs"])
          .pipe(
            Effect.map(
              (records) =>
                records.runs.find(
                  (run) =>
                    run.id === shell.activeRunId &&
                    ["preparing", "starting", "running", "waiting"].includes(run.status),
                )?.modelSelection ?? null,
            ),
          );
      }),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const findLastFailure: KanbanThreadsShape["findLastFailure"] = (threadId) =>
    threads.getThreadRecords(threadId, ["runs", "turnItems"], { turnItemTypes: ["error"] }).pipe(
      Effect.flatMap((records) =>
        Effect.gen(function* () {
          const run = latestExecutedRun(records.runs);
          // A steer can lose acceptance while its original run stays healthy.
          // Only this executed run owns recovery; older inputs cannot hold a successor.
          const messages =
            run === null
              ? []
              : (yield* threads.getThreadRecords(threadId, ["messages"], {
                  messageRunIds: [run.id],
                  messageRoles: ["user"],
                })).messages;
          const unconfirmed = messages.findLast(
            (message) =>
              message.deliveryFailure !== undefined &&
              isUnconfirmedPromptAcceptance(message.deliveryFailure),
          )?.deliveryFailure;
          const failure =
            unconfirmed ??
            latestRootProviderFailure(run, records.turnItems) ??
            rootRuntimeLoss(run, records.turnItems) ??
            (run?.status === "failed" ? (run.failure ?? null) : null);
          // A failed run can leave no error item on its root node; it still counts as failed.
          if (failure === null && run?.status === "failed") {
            return {
              class: "unknown",
              message: "The run failed without an error message.",
              code: null,
              retryable: null,
              runId: run.id,
              model: run.modelSelection,
            } as OrchestrationV2ProviderFailure & {
              readonly runId?: string | null;
              readonly model?: ModelSelection | null;
            };
          }
          return failure === null
            ? null
            : { ...failure, runId: run?.id ?? null, model: run?.modelSelection ?? null };
        }),
      ),
      Effect.mapError(
        (error) => new KanbanThreadError({ operation: "lastFailure", detail: detailOf(error) }),
      ),
    );
  const lastFailure: KanbanThreadsShape["lastFailure"] = (threadId) =>
    findLastFailure(threadId).pipe(Effect.catchCause(() => Effect.succeed(null)));

  const latestRun: KanbanThreadsShape["latestRun"] = (threadId, afterRunId) =>
    threads.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.flatMap((records) => {
        const failed =
          afterRunId === undefined ? undefined : records.runs.find((run) => run.id === afterRunId);
        const startOrder = (run: OrchestrationV2Run) =>
          DateTime.toEpochMillis(run.startedAt ?? run.requestedAt);
        const laterStarts =
          failed === undefined
            ? []
            : records.runs.filter(
                (run) =>
                  run.id !== failed.id &&
                  run.startedAt !== null &&
                  (startOrder(run) > startOrder(failed) ||
                    (startOrder(run) === startOrder(failed) && run.ordinal > failed.ordinal)),
              );
        const run =
          afterRunId === undefined
            ? latestExecutedRun(records.runs)
            : laterStarts.reduce<OrchestrationV2Run | null>(
                (latest, candidate) =>
                  latest === null ||
                  startOrder(candidate) > startOrder(latest) ||
                  (startOrder(candidate) === startOrder(latest) &&
                    candidate.ordinal > latest.ordinal)
                    ? candidate
                    : latest,
                null,
              );
        if (run === null) return Effect.succeed(null);
        return threads
          .getThreadRecords(threadId, ["messages"], {
            messageIds: run.userMessageId === null ? [] : [run.userMessageId],
          })
          .pipe(
            Effect.map((messages) => ({
              runId: run.id,
              status: run.status,
              cancelReason: run.cancelReason,
              cancelDetail: run.cancelDetail,
              model: run.modelSelection,
              message: messages.messages[0]?.text ?? null,
            })),
          );
      }),
      Effect.mapError(
        (error) => new KanbanThreadError({ operation: "latestRun", detail: detailOf(error) }),
      ),
    );

  const runSettled: KanbanThreadsShape["runSettled"] = Effect.fn("KanbanThreads.runSettled")(
    function* (threadId, runId) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) return true;
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"], {
        runIds: [RunId.make(runId)],
      });
      return (
        runs[0] === undefined ||
        ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(runs[0].status)
      );
    },
    Effect.mapError(
      (error) => new KanbanThreadError({ operation: "runSettled", detail: detailOf(error) }),
    ),
  );

  const backgroundStoppedSince = Effect.fn("KanbanThreads.backgroundStoppedSince")(
    function* (threadId: ThreadId, since: string) {
      // Stop can interrupt retained work without changing the finished run's timestamp.
      const records = yield* Effect.all([
        threads.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["run_interrupt_request"],
          recentTurnItemLimit: 1,
        }),
        threads.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
          turnItemStatuses: ["interrupted", "cancelled"],
        }),
      ]);
      return records.some(({ turnItems }) =>
        turnItems.some((item) => DateTime.toEpochMillis(item.updatedAt) >= Date.parse(since)),
      );
    },
    Effect.mapError(
      (error) =>
        new KanbanThreadError({ operation: "backgroundStoppedSince", detail: detailOf(error) }),
    ),
  );

  const compactRun: KanbanThreadsShape["compactRun"] = (threadId, runId) =>
    threads.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.flatMap((records) => {
        const run = records.runs.find((candidate) => candidate.id === runId);
        if (run === undefined) return Effect.succeed(null);
        return threads
          .getThreadRecords(threadId, ["messages"], {
            messageIds: run.userMessageId === null ? [] : [run.userMessageId],
          })
          .pipe(
            Effect.map((messages) => ({
              status: run.status,
              cancelReason: run.cancelReason,
              cancelDetail: run.cancelDetail,
              messageId: run.userMessageId,
              model: run.modelSelection,
              message: messages.messages[0]?.text ?? null,
            })),
          );
      }),
      Effect.mapError(
        (error) => new KanbanThreadError({ operation: "compactRun", detail: detailOf(error) }),
      ),
    );

  const launch: KanbanThreadsShape["launch"] = (input) =>
    launcher
      .launch({
        commandId: CommandId.make(`kanban:launch:${input.key}`),
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.model,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: {
          text: input.text,
          attachments: [],
          ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
        },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.provideService(EvaluatorAnalytics.startObserver, input.onStarted),
        Effect.map((launched) => launched.threadId),
        Effect.mapError(
          (error) => new KanbanThreadError({ operation: "launch", detail: detailOf(error) }),
        ),
      );

  const discardWithdrawal = Effect.fn("KanbanThreads.discardWithdrawal")(
    function* (
      projectId: ProjectId,
      threadId: ThreadId,
      id: string,
      reason = "Board withdrawal could not steer its original run",
      interruptRunning = true,
    ) {
      const messageId = MessageId.make(`kanban:${id}`);
      // A queued withdrawal can start while cancellation is committing; reconcile that race once.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const records = yield* threads.getProjectThreadRecords(
          { projectId, threadId },
          ["messages", "runs", "turnItems"],
          { messageIds: [messageId], turnItemTypes: ["user_message"] },
        );
        const message = records.messages.find((entry) => entry.id === messageId);
        const run = records.runs.find((entry) => entry.id === message?.runId);
        const item = records.turnItems.find(
          (entry) => entry.type === "user_message" && entry.messageId === messageId,
        );
        // Steering restarts can replace userMessageId on the worker's existing run.
        if (
          !run ||
          run.userMessageId !== messageId ||
          (item?.type === "user_message" &&
            ["steer", "promoted_queued_to_steer"].includes(item.inputIntent))
        )
          return false;
        // Native steering keeps the root message and attempt while adding another card's work.
        if (
          records.turnItems.some(
            (entry) =>
              entry.type === "user_message" &&
              entry.runId === run.id &&
              entry.messageId !== messageId &&
              ["steer", "promoted_queued_to_steer"].includes(entry.inputIntent),
          )
        )
          return false;
        const command =
          run.status === "queued"
            ? {
                type: "queued-run.cancel" as const,
                reason: "superseded" as const,
                detail: "Board send withdrawn before it started.",
                commandId: CommandId.make(`kanban:send:${id}:cancel`),
                threadId,
                runId: run.id,
              }
            : interruptRunning &&
                ["preparing", "starting", "running", "waiting"].includes(run.status)
              ? {
                  type: "run.interrupt" as const,
                  cancelReason: "superseded" as const,
                  commandId: CommandId.make(`kanban:send:${id}:interrupt`),
                  threadId,
                  runId: run.id,
                  holdQueue: false,
                  fenced: true,
                  expectedLastInputMessageId: messageId,
                  ...(run.activeAttemptId === null
                    ? {}
                    : { expectedAttemptId: run.activeAttemptId }),
                  reason,
                }
              : null;
        if (command === null)
          return !["preparing", "starting", "running", "waiting"].includes(run.status);
        const stopped = yield* Effect.result(threads.dispatch(command));
        if (Result.isSuccess(stopped)) return true;
        if (attempt === 1) return yield* stopped.failure;
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("kanban withdrawal cleanup failed", { cause }).pipe(Effect.as(true)),
    ),
  );

  const pruneMessageWakes = Effect.fn("KanbanThreads.pruneMessageWakes")(function* (
    threadId: ThreadId,
    messageId: string,
  ) {
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
    const real = runs.find((run) => run.userMessageId === messageId);
    if (real?.status !== "queued") return;
    for (const wake of queuedWakes(runs, real.ordinal)) yield* cancelQueued(threadId, wake.id);
  });

  const nudgeBlocked = Effect.fn("KanbanThreads.nudgeBlocked")(function* (
    threadId: ThreadId,
    target?: { readonly runId?: string; readonly messageId?: string },
  ) {
    const { runs } = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError((error) => sendError(error, target?.messageId)));
    if (!hasQueuedMessage(runs)) return false;
    if (target !== undefined) {
      const wake = queuedWakes(runs).find((run) =>
        target.runId === undefined
          ? run.userMessageId === target.messageId
          : run.id === target.runId,
      );
      if (wake !== undefined)
        yield* cancelQueued(threadId, wake.id).pipe(
          Effect.mapError((error) => sendError(error, target?.messageId)),
        );
    }
    yield* Effect.logDebug("kanban nudge skipped: unread message queued", { threadId });
    return true;
  });

  const readSendReceipt = Effect.fn("KanbanThreads.readSendReceipt")(function* (
    commandId: CommandId,
    retryable: boolean,
  ) {
    return yield* receipts.getByCommandId({ commandId }).pipe(
      Effect.mapError((error) =>
        retryable
          ? new KanbanThreadError({
              operation: "send",
              detail: "Assignment delivery could not be reconciled",
              retryable: true,
            })
          : error,
      ),
    );
  });

  const finishAssignmentWithdrawal = Effect.fn("KanbanThreads.finishAssignmentWithdrawal")(
    function* (projectId: ProjectId, threadId: ThreadId, id: string, text?: string) {
      const messageId = MessageId.make(`kanban:${id}`);
      const terminal = Effect.gen(function* () {
        const records = yield* threads.getProjectThreadRecords(
          { projectId, threadId },
          ["messages", "runs"],
          { messageIds: [messageId] },
        );
        const message = records.messages.find((row) => row.id === messageId);
        const run =
          message?.runId !== undefined && message.runId !== null
            ? records.runs.find((row) => row.id === message.runId)
            : records.runs.find((row) => row.userMessageId === messageId);
        return (
          run !== undefined &&
          ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status)
        );
      });
      // Native steering can share a run whose root message belongs to another card.
      // Its delivery is already stopped if that shared run finished before cleanup.
      if (yield* terminal) return true;
      const stopped = yield* discardWithdrawal(projectId, threadId, id, text, false);
      if (!stopped && text !== undefined) {
        const steered = yield* Effect.result(
          send({ threadId, key: `${id}:state-changed`, text, mode: "steer" }),
        );
        if (Result.isSuccess(steered)) return yield* terminal;
        if (yield* terminal) return true;
        return yield* Effect.fail(steered.failure);
      }
      return yield* terminal;
    },
  );

  const sendId = Effect.fn("KanbanThreads.sendId")(function* (
    input: Pick<
      KanbanSendInput,
      | "threadId"
      | "key"
      | "keyAcrossThreads"
      | "coalesce"
      | "retryWithdrawn"
      | "withdrawalText"
      | "withdrawalBefore"
      | "onCommitted"
    >,
    onReplay?: (threadId: ThreadId, messageId: string) => ReturnType<typeof pruneMessageWakes>,
  ) {
    let id: string = input.key ?? NodeCrypto.randomUUID();
    if (input.key !== undefined) {
      // A rejected receipt is final, but proves that attempt did not send. Walk
      // only those receipts: an accepted or unknown attempt must retain its id.
      for (let attempt = 0; ; attempt += 1) {
        id = attempt === 0 ? input.key : `${input.key}:retry:${attempt}`;
        const receipt = yield* readSendReceipt(
          CommandId.make(`kanban:send:${id}`),
          input.retryWithdrawn === true,
        );
        if (Option.isNone(receipt)) break;
        if (
          receipt.value.aggregateKind !== "thread" ||
          (receipt.value.commandType !== "message.dispatch" &&
            receipt.value.commandType !== "queued-run.edit") ||
          (receipt.value.commandType === "queued-run.edit" &&
            receipt.value.aggregateId !== input.threadId &&
            (receipt.value.status !== "accepted" || input.coalesce === undefined)) ||
          (receipt.value.aggregateId !== input.threadId && !input.keyAcrossThreads)
        ) {
          return yield* new KanbanThreadError({
            operation: "send",
            detail: "keyed send receipt belongs to another command",
          });
        }
        if (
          receipt.value.status === "rejected" &&
          receipt.value.commandType === "queued-run.edit" &&
          !/^Run [^\r\n]+ is not queued\.$/.test(receipt.value.error ?? "")
        ) {
          return yield* new KanbanThreadError({
            operation: "send",
            detail: receipt.value.error ?? "queued wake edit was rejected",
            rejected: true,
          });
        }
        if (receipt.value.status === "accepted" && input.retryWithdrawn) {
          const markerId = CommandId.make(`kanban:send:${id}:withdrawn`);
          let withdrawn = yield* readSendReceipt(markerId, true);
          // The board rollback and orchestration receipts use separate stores.
          // Its persisted rollback also repairs an intent write lost to an I/O failure.
          if (
            Option.isNone(withdrawn) &&
            input.withdrawalBefore !== undefined &&
            Date.parse(receipt.value.acceptedAt) <= Date.parse(input.withdrawalBefore)
          ) {
            const marker = {
              ...receipt.value,
              commandId: markerId,
              commandType: "kanban.assignment.withdrawal_requested",
            };
            yield* receipts.insertIfAbsent(marker).pipe(
              Effect.mapError(
                () =>
                  new KanbanThreadError({
                    operation: "send",
                    detail: "Assignment withdrawal is still pending",
                    retryable: true,
                  }),
              ),
            );
            withdrawn = Option.some(marker);
          }
          if (
            Option.isSome(withdrawn) &&
            withdrawn.value.aggregateId === input.threadId &&
            withdrawn.value.status === "accepted"
          ) {
            if (withdrawn.value.commandType === "kanban.assignment.withdrawn") continue;
            if (withdrawn.value.commandType === "kanban.assignment.withdrawal_requested") {
              const reconciled = yield* Effect.result(
                Effect.gen(function* () {
                  const shell = yield* threads.getThreadShell(input.threadId);
                  return (
                    shell !== null &&
                    (yield* finishAssignmentWithdrawal(
                      shell.projectId,
                      input.threadId,
                      id,
                      input.withdrawalText,
                    ))
                  );
                }),
              );
              if (Result.isSuccess(reconciled) && reconciled.success) continue;
              return yield* new KanbanThreadError({
                operation: "send",
                detail: "Assignment withdrawal is still pending",
                retryable: true,
              });
            }
          }
        }
        if (receipt.value.status !== "rejected") {
          if (receipt.value.status === "accepted") input.onCommitted?.();
          if (input.keyAcrossThreads && input.coalesce === undefined && onReplay !== undefined)
            yield* onReplay(ThreadId.make(receipt.value.aggregateId), `kanban:${id}`);
          if (
            input.keyAcrossThreads ||
            input.coalesce !== undefined ||
            receipt.value.commandType === "queued-run.edit"
          )
            return;
          break;
        }
      }
    }
    return id;
  });

  const acceptedSend = Effect.fn("KanbanThreads.acceptedSend")(
    function* (key: string) {
      for (let attempt = 0; ; attempt += 1) {
        const identity = attempt === 0 ? key : `${key}:retry:${attempt}`;
        const receipt = yield* readSendReceipt(CommandId.make(`kanban:send:${identity}`), false);
        if (Option.isNone(receipt)) return null;
        if (
          receipt.value.aggregateKind !== "thread" ||
          receipt.value.commandType !== "message.dispatch"
        )
          return yield* new KanbanThreadError({
            operation: "send",
            detail: "keyed send receipt belongs to another command",
          });
        if (receipt.value.status === "accepted") return ThreadId.make(receipt.value.aggregateId);
      }
    },
    Effect.mapError((error) => sendError(error)),
  );

  const send: KanbanThreadsShape["send"] = Effect.fn("KanbanThreads.send")(
    function* (input) {
      let acceptedMessageId: string | undefined;
      let acceptedRunId: string | undefined;
      let deliveryCommandId: CommandId | undefined;
      let acknowledged = false;
      const accept = () => {
        if (acknowledged) return;
        acknowledged = true;
        input.onCommitted?.();
      };
      return yield* Effect.gen(function* () {
        const scope =
          input.mode === "steer" || input.model !== undefined ? undefined : input.coalesce;
        if (input.isStale?.()) return;
        const shell = yield* threads.getThreadShell(input.threadId);
        if (shell === null || shell.deletedAt !== null) {
          return yield* new KanbanThreadError({ operation: "send", detail: "thread not found" });
        }
        if (scope === "nudge" && (yield* nudgeBlocked(input.threadId))) return;
        let id = yield* sendId({ ...input, onCommitted: accept }, pruneMessageWakes);
        if (id === undefined) return;
        // Queue edits cannot change a run's model selection or steer a live turn.
        if (input.flushQueued !== undefined) {
          yield* threads.promoteQueuedMessages(input.threadId, input.flushQueued, {
            deferBoardWakes: input.text.trim().length > 0,
            isStale: () => input.isStale?.() === true,
          });
          if (!input.text.trim()) return;
        }
        if (scope !== undefined) {
          const records = yield* threads.getThreadRecords(input.threadId, ["runs", "messages"]);
          if (input.isStale?.()) return;
          if (scope === "nudge" && hasQueuedMessage(records.runs)) {
            yield* Effect.logDebug("kanban nudge skipped: unread message queued", {
              threadId: input.threadId,
            });
            return;
          }
          const target = coalesceTarget(records.runs, scope);
          if (target !== undefined) {
            const message = records.messages.find((row) => row.id === target.userMessageId);
            // A keyed no-op still needs an edit receipt so its retry cannot restore stale text.
            if (message?.text === input.text && input.key === undefined) return target.id;
            acceptedMessageId = target.userMessageId;
            const edited = yield* Effect.result(
              threads.dispatch({
                type: "queued-run.edit",
                commandId: CommandId.make(`kanban:send:${id}`),
                threadId: input.threadId,
                runId: target.id,
                text: input.text,
              }),
            );
            if (Result.isSuccess(edited)) {
              acceptedRunId = target.id;
              accept();
              if (
                scope === "nudge" &&
                (yield* nudgeBlocked(input.threadId, {
                  runId: target.id,
                  messageId: target.userMessageId,
                }))
              )
                return;
              return target.id;
            }
            if (
              !isCommandRejected(edited.failure) ||
              edited.failure.cause !== `Run ${target.id} is not queued.`
            ) {
              if (
                scope === "nudge" &&
                (yield* nudgeBlocked(input.threadId, {
                  runId: target.id,
                  messageId: target.userMessageId,
                }))
              )
                return;
              return yield* sendError(edited.failure, target.userMessageId);
            }
            // The rejected edit owns its command id. Walk its receipt before sending once.
            id = yield* sendId({ ...input, key: input.key ?? id, onCommitted: accept });
            if (id === undefined) return;
          }
        }
        const deliver = Effect.gen(function* () {
          if (input.isStale?.()) return;
          // A post-dispatch projection failure still needs an identity for stale-wake withdrawal.
          const messageId = MessageId.make(
            scope === undefined ? `kanban:${id}` : `${scopedMessagePrefix(scope)}${id}`,
          );
          acceptedMessageId = messageId;
          acceptedRunId = undefined;
          deliveryCommandId = CommandId.make(`kanban:send:${id}`);
          const result = yield* Effect.result(
            threads.sendToThread({
              projectId: shell.projectId,
              commandId: CommandId.make(`kanban:send:${id}`),
              messageId,
              threadId: input.threadId,
              text: input.text,
              attachments: [],
              onAccepted: accept,
              ...(input.model ? { modelSelection: input.model } : {}),
              mode: input.mode ?? "auto",
              ...(input.mode === "steer" ? { activeTurnOnly: true } : {}),
              createdBy: "system",
              creationSource: "server",
              ...(input.isStale === undefined ? {} : { isStale: input.isStale }),
            }),
          );
          if (Result.isFailure(result)) {
            const receipt = yield* receipts.getByCommandId({
              commandId: CommandId.make(`kanban:send:${id}`),
            });
            if (Option.isSome(receipt) && receipt.value.status === "accepted") accept();
            if (isCommandRejected(result.failure) && result.failure.revoked) {
              // No enqueue occurred; a future retry must not inherit cleanup for this id.
              acceptedMessageId = undefined;
              return yield* sendError(result.failure);
            }
            if (input.isStale?.()) {
              const sent = (yield* threads.getThreadRecords(input.threadId, ["runs"]).pipe(
                Effect.retry({ times: 1 }),
                Effect.mapError((error) => sendError(error, messageId)),
              )).runs.find((run) => run.userMessageId === messageId);
              return yield* sendError(result.failure, messageId, sent?.id);
            }
            if (scope === "nudge" && (yield* nudgeBlocked(input.threadId, { messageId }))) return;
            if (scope === undefined && input.mode !== "steer") {
              const receipt = yield* readSendReceipt(
                CommandId.make(`kanban:send:${id}`),
                input.retryWithdrawn === true,
              );
              if (Option.isSome(receipt) && receipt.value.status === "accepted")
                yield* pruneMessageWakes(input.threadId, messageId);
            }
            return yield* sendError(result.failure, scope === undefined ? undefined : messageId);
          }
          const sent = result.success;
          acceptedRunId = sent.run.id;
          accept();
          if (input.mode === "steer" && sent.delivery !== "steered") {
            return yield* new KanbanThreadError({
              operation: "send",
              detail: "withdrawal did not steer a live run",
              rejected: true,
            });
          }
          if (scope === undefined && sent.delivery === "queued") {
            yield* pruneMessageWakes(input.threadId, messageId);
          }
          if (
            scope === "nudge" &&
            sent.delivery === "queued" &&
            (yield* nudgeBlocked(input.threadId, { runId: sent.run.id, messageId }))
          )
            return;
          return sent.run.id;
        });
        return yield* input.mode === "steer"
          ? deliver.pipe(
              Effect.onError(() =>
                discardWithdrawal(shell.projectId, input.threadId, id).pipe(Effect.asVoid),
              ),
            )
          : deliver;
      }).pipe(
        Effect.provideService(
          EvaluatorAnalytics.deliveryObserver,
          input.onAccepted === undefined
            ? undefined
            : (commandId) => input.onAccepted!(commandId.replace(/^kanban:send:/, "")),
        ),
        Effect.onError(() =>
          deliveryCommandId === undefined || input.onCommitted === undefined
            ? Effect.void
            : receipts.getByCommandId({ commandId: deliveryCommandId }).pipe(
                Effect.tap((receipt) =>
                  Effect.sync(() => {
                    if (Option.isSome(receipt) && receipt.value.status === "accepted") accept();
                  }),
                ),
                Effect.ignore,
              ),
        ),
        Effect.mapError((error) => sendError(error, acceptedMessageId, acceptedRunId)),
      );
    },
    Effect.mapError((error) => sendError(error)),
  );

  const withdraw: KanbanThreadsShape["withdraw"] = Effect.fn("KanbanThreads.withdraw")(
    function* (input) {
      const shell = yield* threads.getThreadShell(input.threadId);
      if (!shell || shell.deletedAt !== null) return;
      const id = yield* sendId({ ...input, withdrawalText: input.text });
      if (id === undefined) return;
      const receipt = yield* readSendReceipt(
        CommandId.make(`kanban:send:${id}`),
        input.retryWithdrawn === true,
      );
      if (Option.isNone(receipt) || receipt.value.status !== "accepted") return;
      if (
        input.withdrawalBefore !== undefined &&
        Date.parse(receipt.value.acceptedAt) > Date.parse(input.withdrawalBefore)
      )
        return;
      const commandId = CommandId.make(`kanban:send:${id}:withdrawn`);
      if (input.retryWithdrawn) {
        // Persist intent before cleanup so a crash cannot replay the old accepted command.
        yield* receipts.insertIfAbsent({
          ...receipt.value,
          commandId,
          commandType: "kanban.assignment.withdrawal_requested",
        });
      }
      if (!(yield* finishAssignmentWithdrawal(shell.projectId, input.threadId, id, input.text)))
        return "pending" as const;
      if (input.retryWithdrawn)
        yield* receipts.upsert({
          ...receipt.value,
          commandId,
          commandType: "kanban.assignment.withdrawn",
        });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("kanban assignment withdrawal failed", {
        errorTag: analyticsErrorTag(cause),
      }).pipe(Effect.as("pending" as const)),
    ),
  );

  const setModel: KanbanThreadsShape["setModel"] = Effect.fn("KanbanThreads.setModel")(
    function* (threadId, model) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) {
        return yield* new KanbanThreadError({ operation: "setModel", detail: "thread not found" });
      }
      if (modelSelectionsEqual(shell.modelSelection, model)) return;
      yield* threads.dispatch({
        type:
          model.instanceId === shell.providerInstanceId
            ? "thread.model-selection.set"
            : "provider.switch",
        commandId: commandId("model"),
        threadId,
        modelSelection: model,
      });
    },
    Effect.mapError((error) =>
      isKanbanThreadError(error)
        ? error
        : new KanbanThreadError({ operation: "setModel", detail: detailOf(error) }),
    ),
  );

  const queuedRuns: KanbanThreadsShape["queuedRuns"] = Effect.fn("KanbanThreads.queuedRuns")(
    function* (threadId, includeActive = false) {
      return (yield* threads.getThreadRecords(threadId, ["runs"])).runs.filter(
        (run) =>
          run.status === "queued" ||
          (includeActive && ["preparing", "starting", "running", "waiting"].includes(run.status)),
      );
    },
    Effect.mapError(
      (error) => new KanbanThreadError({ operation: "queue", detail: detailOf(error) }),
    ),
  );

  const cancelQueuedRun: KanbanThreadsShape["cancelQueued"] = Effect.fn(
    "KanbanThreads.cancelQueued",
  )(
    function* (threadId, runId, cancelReason = "superseded") {
      const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.find(
        (row) => row.id === runId,
      );
      if (run?.status !== "queued") return false;
      const cancelled = yield* Effect.result(
        threads.dispatch({
          type: "queued-run.cancel",
          reason: cancelReason,
          detail: "Board withdrew queued work before it started.",
          commandId: commandId("cancel"),
          threadId,
          runId: run.id,
        }),
      );
      if (Result.isFailure(cancelled)) {
        if (
          isCommandRejected(cancelled.failure) &&
          cancelled.failure.cause === `Run ${run.id} is not queued.`
        )
          return false;
        return yield* cancelled.failure;
      }
      const after = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.find(
        (row) => row.id === runId,
      );
      if (after?.status === "queued")
        return yield* new KanbanThreadError({
          operation: "cancel",
          detail: `Run ${run.id} is still queued.`,
        });
      return after?.status === "cancelled";
    },
    Effect.mapError((error) =>
      isKanbanThreadError(error)
        ? error
        : new KanbanThreadError({ operation: "cancel", detail: detailOf(error) }),
    ),
  );

  const cancelQueued = cancelQueuedRun;

  const interrupt: KanbanThreadsShape["interrupt"] = Effect.fn("KanbanThreads.interrupt")(
    function* (
      threadId,
      reason,
      cancelQueued = false,
      runId,
      messageId,
      cancelReason = "card_stop",
    ) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null) return { outcome: "noop" } as const;
      if (messageId !== undefined) {
        const target = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.find(
          (run) => run.userMessageId === messageId,
        );
        if (target === undefined) return { outcome: "noop" } as const;
        yield* cancelQueuedRun(threadId, target.id, cancelReason);
        return yield* interrupt(threadId, reason, false, target.id, undefined, cancelReason);
      }
      if (!cancelQueued) {
        const result = yield* threads
          .interruptThread({
            projectId: shell.projectId,
            commandId: commandId("stop"),
            threadId,
            cancelReason,
            reason,
            ...(runId === undefined ? {} : { runId: RunId.make(runId) }),
          })
          .pipe(
            Effect.catchTags({
              ThreadManagementRunNotFoundError: () =>
                Effect.succeed({ type: "no_active_run" } as const),
            }),
          );
        return result.type === "interrupt_requested"
          ? ({ outcome: "requested", runId: result.run.id } as const)
          : ({ outcome: "noop" } as const);
      }
      // Stop holds the queue atomically with the interrupt. interruptThread alone
      // ignores queued runs, allowing an abandoned launch to start afterwards.
      const result = yield* threads.dispatch({
        type: "thread.stop",
        cancelReason,
        commandId: commandId("stop"),
        threadId,
        reason,
      });
      const stopped = yield* threads.getThreadRecords(threadId, ["runs"]);
      for (const run of stopped.runs) {
        if (run.status !== "queued") continue;
        yield* threads.dispatch({
          type: "queued-run.cancel",
          reason: cancelReason,
          commandId: commandId("cancel"),
          threadId,
          runId: run.id,
        });
      }
      // The committed request identifies the stopped run even if it changed after the shell read.
      for (const { event } of result.storedEvents) {
        if (
          event.threadId === threadId &&
          event.type === "turn-item.updated" &&
          event.payload.type === "run_interrupt_request" &&
          event.payload.runId !== null
        ) {
          return { outcome: "requested", runId: event.payload.runId } as const;
        }
      }
      return { outcome: "noop" } as const;
    },
    Effect.mapError((error) =>
      isKanbanThreadError(error)
        ? error
        : new KanbanThreadError({ operation: "interrupt", detail: detailOf(error) }),
    ),
  );

  const remove = Effect.fn("KanbanThreads.remove")(
    function* (threadId: ThreadId) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) return;
      yield* threads.dispatch({ type: "thread.delete", commandId: commandId("delete"), threadId });
    },
    Effect.mapError(
      (error) => new KanbanThreadError({ operation: "delete", detail: detailOf(error) }),
    ),
  );

  const pendingUserInputs: KanbanThreadsShape["pendingUserInputs"] = Effect.fn(
    "KanbanThreads.pendingUserInputs",
  )(
    function* (threadId) {
      const records = yield* threads.getThreadRecords(threadId, ["runtimeRequests", "turnItems"], {
        turnItemTypes: ["user_input_request"],
      });
      return records.runtimeRequests.flatMap((request) => {
        if (request.kind !== "user_input" || request.status !== "pending") return [];
        const item = records.turnItems.find(
          (item) => item.type === "user_input_request" && item.requestId === request.id,
        );
        return item?.type === "user_input_request"
          ? [{ requestId: request.id, questions: item.questions }]
          : [];
      });
    },
    Effect.mapError(
      (error) => new KanbanThreadError({ operation: "pendingUserInputs", detail: detailOf(error) }),
    ),
  );

  return KanbanThreads.of({
    pendingUserInputs,
    claimContext,
    view,
    find,
    model,
    lastFailure,
    findLastFailure,
    latestRun,
    compactRun,
    runSettled,
    backgroundStoppedSince,
    launch,
    send,
    acceptedSend,
    withdraw,
    setModel,
    queuedRuns,
    cancelQueued,
    interrupt,
    remove,
  });
});

export const layerFromApplicationReceipts = Layer.effect(KanbanThreads, make).pipe(
  Layer.provide(EffectOutbox.layer),
);
export const layer = layerFromApplicationReceipts.pipe(
  Layer.provide(OrchestrationCommandReceipts.layer),
);
