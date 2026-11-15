// @effect-diagnostics nodeBuiltinImport:off - command ids only need a random UUID.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  RunId,
  type OrchestrationV2UserInputQuestion,
  type OrchestrationV2Run,
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
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  rootRuntimeLoss,
} from "@t3tools/shared/orchestrationV2ThreadError";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as OrchestrationCommandReceipts from "../../../persistence/OrchestrationCommandReceipts.ts";
import { type ControlThreadState, stateFromRunStatus } from "../../control/model.ts";

export class KanbanThreadError extends Schema.TaggedError<KanbanThreadError>()(
  "KanbanThreadError",
  {
    operation: Schema.String,
    detail: Schema.String,
    rejected: Schema.optional(Schema.Boolean),
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
  readonly runId?: string | null;
  readonly runRequestedAt?: string | null;
  /** Its own subagents and background tasks still running after its turn ended. Pull-request watches are counted in prWatches instead. */
  readonly backgroundWork: number;
  /** Pull requests this thread watches (watch_pull_request) that are still open or draft. The watch wakes it on CI and review changes. */
  readonly prWatches: number;
  readonly prs: ReadonlyArray<KanbanThreadPr>;
  readonly archived: boolean;
}

export interface KanbanLaunchInput {
  /** Stable per logical launch so a retry finds the same thread. */
  readonly key: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly model: ModelSelection;
  readonly text: string;
}

export interface KanbanSendInput {
  readonly flushQueued?: "wake" | "steer";
  readonly threadId: ThreadId;
  readonly text: string;
  /** Stable per logical send when a retry must not deliver a second message. */
  readonly key?: string;
  /** One logical delivery across replacement recipients; only rejected attempts may send again. */
  readonly keyAcrossThreads?: boolean;
  /** Replace the oldest queued board wake in this thread with the same scope. */
  readonly coalesce?: string;
  /** Departure can invalidate a snapshot while its queue read is in flight. */
  readonly isStale?: () => boolean;
  /** Switch the thread to this model for the turn the message starts. */
  readonly model?: ModelSelection;
  /** Steer only an existing turn; never start an idle thread. */
  readonly mode?: "steer";
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
  readonly find: (threadId: ThreadId) => Effect.Effect<KanbanThreadView | null, KanbanThreadError>;
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
  /** Strict read used to reconcile a released card after its maintenance turn. */
  readonly latestRun: (threadId: ThreadId) => Effect.Effect<
    {
      readonly runId: string;
      readonly status: string;
      readonly message: string | null;
      readonly model?: ModelSelection | null;
    } | null,
    KanbanThreadError
  >;
  readonly runSettled: (
    threadId: ThreadId,
    runId: string,
  ) => Effect.Effect<boolean, KanbanThreadError>;
  readonly compactRun: (
    threadId: ThreadId,
    runId: string,
  ) => Effect.Effect<
    {
      readonly status: string;
      readonly message: string | null;
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
  readonly withdraw: (input: {
    readonly threadId: ThreadId;
    readonly key: string;
    readonly text: string;
  }) => Effect.Effect<void>;
  /** Switches an open thread to this model now; does nothing when it already runs it. */
  readonly setModel: (
    threadId: ThreadId,
    model: ModelSelection,
  ) => Effect.Effect<void, KanbanThreadError>;
  readonly queuedRuns: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2Run>, KanbanThreadError>;
  /** Cancels only this queued brief; false means it may already be acting. */
  readonly cancelQueued: (
    threadId: ThreadId,
    runId: string,
  ) => Effect.Effect<boolean, KanbanThreadError>;
  /** A thread that no longer exists counts as stopped; a failed read or stop fails. */
  readonly interrupt: (
    threadId: ThreadId,
    reason: string,
    cancelQueued?: boolean,
    runId?: string,
    messageId?: string,
  ) => Effect.Effect<KanbanInterruptResult | void, KanbanThreadError>;
}

export class KanbanThreads extends Context.Service<KanbanThreads, KanbanThreadsShape>()(
  "t3/ardud/kanban/engine/threads/KanbanThreads",
) {}

export const coalesceTarget = <
  R extends Pick<OrchestrationV2Run, "ordinal" | "status" | "userMessageId">,
>(
  runs: ReadonlyArray<R>,
  scope: string,
): R | undefined => {
  const prefix = `kanban:wake:${scope}:`;
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
        run.userMessageId.startsWith("kanban:wake:") &&
        (scopes === undefined ||
          scopes.some((scope) => run.userMessageId.startsWith(`kanban:wake:${scope}:`))),
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
): number =>
  (shell.pendingBackgroundTasks ?? []).filter(
    (task) =>
      !task.taskId.startsWith("pull-request-watch:") && backgroundWorkHoldsCompletion([task]),
  ).length;

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

  const find: KanbanThreadsShape["find"] = Effect.fn("KanbanThreads.find")(
    function* (threadId) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) return null;
      const runId = shell.activeRunId;
      const records =
        runId === null
          ? null
          : yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
      const run = records?.runs[0];
      const started = shell.activityRunStartedAt;
      const activity = run?.lastActivityAt;
      return {
        threadId: shell.id,
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
        runId,
        runRequestedAt: run ? DateTime.formatIso(run.requestedAt) : null,
        backgroundWork: backgroundWorkOf(shell),
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
      Effect.map((records) => {
        const run = latestExecutedRun(records.runs);
        const failure =
          latestRootProviderFailure(run, records.turnItems) ??
          rootRuntimeLoss(run, records.turnItems);
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
      Effect.mapError(
        (error) => new KanbanThreadError({ operation: "lastFailure", detail: detailOf(error) }),
      ),
    );
  const lastFailure: KanbanThreadsShape["lastFailure"] = (threadId) =>
    findLastFailure(threadId).pipe(Effect.catchCause(() => Effect.succeed(null)));

  const latestRun: KanbanThreadsShape["latestRun"] = (threadId) =>
    threads.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.flatMap((records) => {
        const run = latestExecutedRun(records.runs);
        if (run === null) return Effect.succeed(null);
        return threads
          .getThreadRecords(threadId, ["messages"], {
            messageIds: run.userMessageId === null ? [] : [run.userMessageId],
          })
          .pipe(
            Effect.map((messages) => ({
              runId: run.id,
              status: run.status,
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
        initialMessage: { text: input.text, attachments: [] },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
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
                commandId: CommandId.make(`kanban:send:${id}:cancel`),
                threadId,
                runId: run.id,
              }
            : ["preparing", "starting", "running", "waiting"].includes(run.status)
              ? {
                  type: "run.interrupt" as const,
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
        if (command === null) return true;
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

  const sendId = Effect.fn("KanbanThreads.sendId")(function* (
    input: Pick<KanbanSendInput, "threadId" | "key" | "keyAcrossThreads" | "coalesce">,
    onReplay?: (threadId: ThreadId, messageId: string) => ReturnType<typeof pruneMessageWakes>,
  ) {
    let id: string = input.key ?? NodeCrypto.randomUUID();
    if (input.key !== undefined) {
      // A rejected receipt is final, but proves that attempt did not send. Walk
      // only those receipts: an accepted or unknown attempt must retain its id.
      for (let attempt = 0; ; attempt += 1) {
        id = attempt === 0 ? input.key : `${input.key}:retry:${attempt}`;
        const receipt = yield* receipts.getByCommandId({
          commandId: CommandId.make(`kanban:send:${id}`),
        });
        if (Option.isNone(receipt)) break;
        if (
          receipt.value.aggregateKind !== "thread" ||
          (receipt.value.commandType !== "message.dispatch" &&
            receipt.value.commandType !== "queued-run.edit") ||
          (receipt.value.commandType === "queued-run.edit" &&
            receipt.value.aggregateId !== input.threadId) ||
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
        if (receipt.value.status !== "rejected") {
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

  const send: KanbanThreadsShape["send"] = Effect.fn("KanbanThreads.send")(
    function* (input) {
      let acceptedMessageId: string | undefined;
      let acceptedRunId: string | undefined;
      return yield* Effect.gen(function* () {
        const scope =
          input.mode === "steer" || input.model !== undefined ? undefined : input.coalesce;
        if (input.isStale?.()) return;
        const shell = yield* threads.getThreadShell(input.threadId);
        if (shell === null || shell.deletedAt !== null) {
          return yield* new KanbanThreadError({ operation: "send", detail: "thread not found" });
        }
        if (scope === "nudge" && (yield* nudgeBlocked(input.threadId))) return;
        let id = yield* sendId(input, pruneMessageWakes);
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
            id = yield* sendId({ ...input, key: input.key ?? id });
            if (id === undefined) return;
          }
        }
        const deliver = Effect.gen(function* () {
          if (input.isStale?.()) return;
          // A post-dispatch projection failure still needs an identity for stale-wake withdrawal.
          const messageId = MessageId.make(
            scope === undefined ? `kanban:${id}` : `kanban:wake:${scope}:${id}`,
          );
          acceptedMessageId = messageId;
          acceptedRunId = undefined;
          const result = yield* Effect.result(
            threads.sendToThread({
              projectId: shell.projectId,
              commandId: CommandId.make(`kanban:send:${id}`),
              messageId,
              threadId: input.threadId,
              text: input.text,
              attachments: [],
              ...(input.model ? { modelSelection: input.model } : {}),
              mode: input.mode ?? "auto",
              ...(input.mode === "steer" ? { activeTurnOnly: true } : {}),
              createdBy: "system",
              creationSource: "server",
              ...(input.isStale === undefined ? {} : { isStale: input.isStale }),
            }),
          );
          if (Result.isFailure(result)) {
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
              const receipt = yield* receipts.getByCommandId({
                commandId: CommandId.make(`kanban:send:${id}`),
              });
              if (Option.isSome(receipt) && receipt.value.status === "accepted")
                yield* pruneMessageWakes(input.threadId, messageId);
            }
            return yield* sendError(result.failure, scope === undefined ? undefined : messageId);
          }
          const sent = result.success;
          acceptedRunId = sent.run.id;
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
      }).pipe(Effect.mapError((error) => sendError(error, acceptedMessageId, acceptedRunId)));
    },
    Effect.mapError((error) => sendError(error)),
  );

  const withdraw: KanbanThreadsShape["withdraw"] = Effect.fn("KanbanThreads.withdraw")(
    function* (input) {
      const shell = yield* threads.getThreadShell(input.threadId);
      if (!shell || shell.deletedAt !== null) return;
      const id = yield* sendId(input);
      if (id === undefined) return;
      const receipt = yield* receipts.getByCommandId({
        commandId: CommandId.make(`kanban:send:${id}`),
      });
      if (Option.isNone(receipt) || receipt.value.status !== "accepted") return;
      const stopped = yield* discardWithdrawal(shell.projectId, input.threadId, id, input.text);
      if (!stopped) yield* send({ ...input, key: `${input.key}:state-changed`, mode: "steer" });
    },
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("kanban assignment withdrawal failed", { cause }),
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
    function* (threadId) {
      return (yield* threads.getThreadRecords(threadId, ["runs"])).runs.filter(
        (run) => run.status === "queued",
      );
    },
    Effect.mapError(
      (error) => new KanbanThreadError({ operation: "queue", detail: detailOf(error) }),
    ),
  );

  const cancelQueuedRun: KanbanThreadsShape["cancelQueued"] = Effect.fn(
    "KanbanThreads.cancelQueued",
  )(
    function* (threadId, runId) {
      const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.find(
        (row) => row.id === runId,
      );
      if (run?.status !== "queued") return false;
      const cancelled = yield* Effect.result(
        threads.dispatch({
          type: "queued-run.cancel",
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
    function* (threadId, reason, cancelQueued = false, runId, messageId) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null) return { outcome: "noop" } as const;
      if (messageId !== undefined) {
        const target = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.find(
          (run) => run.userMessageId === messageId,
        );
        if (target === undefined) return { outcome: "noop" } as const;
        yield* cancelQueuedRun(threadId, target.id);
        return yield* interrupt(threadId, reason, false, target.id);
      }
      if (!cancelQueued) {
        const result = yield* threads
          .interruptThread({
            projectId: shell.projectId,
            commandId: commandId("stop"),
            threadId,
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
        commandId: commandId("stop"),
        threadId,
        reason,
      });
      const stopped = yield* threads.getThreadRecords(threadId, ["runs"]);
      for (const run of stopped.runs) {
        if (run.status !== "queued") continue;
        yield* threads.dispatch({
          type: "queued-run.cancel",
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
    launch,
    send,
    withdraw,
    setModel,
    queuedRuns,
    cancelQueued,
    interrupt,
  });
});

export const layer = Layer.effect(KanbanThreads, make).pipe(
  Layer.provide(OrchestrationCommandReceipts.layer),
);
