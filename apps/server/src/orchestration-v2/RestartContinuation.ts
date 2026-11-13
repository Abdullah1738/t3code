import {
  markContinuationDispatched,
  markQueuedRunRecovered,
  markContinuationDeclined,
  markContinuationFinished,
} from "../ardud/fast-install/report.ts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  latestProviderTurnForAttempt,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import { preparedCutoverOwns } from "../ardud/harness-migrate/cutoverClaim.ts";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  awaitingProviderThreadId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  isAwaitedWork,
  isRestartContinuationSource,
  cancelledBeforeStart,
  isRestartNoteSource,
  neverStarted,
  restartContinuationNote,
} from "./RestartBackgroundNote.ts";
// ardud: the restart note checks OpenCode children before it says they were cancelled.
import { restartNoteSummary } from "../ardud/opencode-import/ChildSessions.ts";

const CONTINUE_PROMPT = "Continue where you left off.";

const MAX_CONTINUATION_CHAIN = 3;
const CONTINUATION_LOOP_WINDOW_MS = 5 * 60 * 1_000;

function restartContinuationBlocked(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runtimeRequests" | "providerTurns" | "turnItems"
  >,
  source: OrchestrationV2Run,
  now: DateTime.Utc,
  settled: boolean,
): boolean {
  const { thread } = projection;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.snoozedUntil != null && DateTime.isGreaterThan(thread.snoozedUntil, now))
  )
    return true;
  const turn = latestProviderTurnForAttempt(projection.providerTurns, source.activeAttemptId);
  if (
    !settled &&
    turn !== undefined &&
    (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")
  )
    return true;
  const waitingRequest = projection.runtimeRequests.some(
    (request) =>
      request.kind !== "dynamic_tool_call" &&
      request.kind !== "auth_refresh" &&
      request.responseCapability.type !== "message" &&
      (request.status === "pending" ||
        ((request.status === "expired" || request.status === "cancelled") &&
          request.responseCapability.type === "not_resumable" &&
          turn !== undefined &&
          turn.id === request.providerTurnId)),
  );
  if (waitingRequest) return true;
  return projection.turnItems.some(
    (item) =>
      item.type === "secret_request" &&
      item.runId === source.id &&
      (item.secretStatus === "pending" ||
        (item.secretStatus === "cancelled" &&
          item.completedAt !== null &&
          source.completedAt !== null &&
          DateTime.Equivalence(item.completedAt, source.completedAt))),
  );
}

/**
 * App-owned delegations are not counted: their own threads continue and report
 * back.
 */
function hasOpenAwaitedWork(
  projection: Pick<ProjectionRuntimeRecoveryState, "runs" | "turnItems">,
  providerThread: ProjectionRuntimeRecoveryState["providerThreads"][number],
): boolean {
  const openItem = projection.turnItems.some((item) => {
    if (item.status !== "pending" && item.status !== "running" && item.status !== "waiting")
      return false;
    if (item.type === "subagent" && item.origin === "app_owned" && item.childThreadId !== null)
      return false;
    const work = cancelledTurnItemWork(item);
    return (
      work !== undefined &&
      isAwaitedWork(work) &&
      awaitingProviderThreadId(item, projection.runs) === providerThread.id
    );
  });
  return (
    openItem ||
    (providerThread.ownerNodeId === null &&
      (providerThread.pendingBackgroundTasks ?? []).some((task) =>
        isAwaitedWork(cancelledRosterTaskWork(task)),
      ))
  );
}

// ardud: expose bounded reasons for the single startup recovery summary.
export type RestartContinuationSkipReason =
  | "blocked"
  | "no_provider_thread"
  | "provider_thread_not_active"
  | "no_session"
  | "session_stopped_or_error"
  | "no_running_turn"
  | "no_candidate"
  | "run_not_resumable"
  | "provider_changed"
  | "invalid_provider_thread"
  | "no_awaited_work"
  | "already_reconciled";

function preparationCut(
  run: OrchestrationV2Run,
  projection: Pick<ProjectionRuntimeRecoveryState, "providerThreads" | "providerTurns">,
): boolean {
  return (
    (run.startedAt === null || run.providerThreadId === null) &&
    !(projection.providerTurns ?? []).some((turn) => turn.runAttemptId === run.activeAttemptId) &&
    (run.status === "preparing" ||
      run.status === "starting" ||
      (run.status === "running" &&
        !projection.providerThreads.some(
          (thread) =>
            thread.id === run.providerThreadId && thread.nativeThreadRef?.strength === "strong",
        )))
  );
}

/** A settled run needs a live session, so an older crash cannot wake it. */
function activeRestartContinuationDecision(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    | "thread"
    | "runs"
    | "providerThreads"
    | "providerSessions"
    | "providerTurns"
    | "runtimeRequests"
    | "turnItems"
  >,
  now: DateTime.Utc,
): { readonly run: OrchestrationV2Run } | { readonly skip: RestartContinuationSkipReason } {
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.status !== "queued" &&
      (!neverStarted(candidate) || preparationCut(candidate, projection)) &&
      (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  if (!run) {
    const queued = projection.runs
      .filter((candidate) => candidate.status === "queued" && candidate.queueHeld !== true)
      .toSorted((a, b) => (a.queuePosition ?? a.ordinal) - (b.queuePosition ?? b.ordinal))[0];
    if (!queued) return { skip: "no_candidate" };
    if (restartContinuationBlocked(projection, queued, now, true)) return { skip: "blocked" };
    return { run: queued };
  }
  const preparedContinuation =
    run.status === "starting" && run.restartContinuationOfRunId !== undefined;
  const settled = run.status === "completed" || run.status === "waiting";
  const beforeProvider = preparationCut(run, projection);
  if (run.status !== "running" && !beforeProvider && !preparedContinuation && !settled)
    return { skip: "run_not_resumable" };
  if (restartContinuationBlocked(projection, run, now, settled)) return { skip: "blocked" };
  const liveTurnRequired = !preparedContinuation && !settled;
  if (projection.thread.providerInstanceId !== run.providerInstanceId)
    return { skip: "provider_changed" };
  if (beforeProvider) return { run };
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (!providerThread) return { skip: "no_provider_thread" };
  if (
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.ownerNodeId !== null ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== providerThread.driver
  )
    return { skip: "invalid_provider_thread" };
  if (
    (liveTurnRequired && providerThread.status !== "active") ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return { skip: "provider_thread_not_active" };
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  if (
    session === undefined ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver
  )
    return { skip: "no_session" };
  // ardud: a shared session describes the instance, not an individual live turn.
  // Settled runs still require a live session; their old turns prove nothing.
  if (
    !preparedContinuation &&
    (session.status === "stopped" || session.status === "error") &&
    !(liveTurnRequired && session.capabilities?.sessions.supportsMultipleProviderThreadsPerSession)
  )
    return { skip: "session_stopped_or_error" };
  if (settled)
    return hasOpenAwaitedWork(projection, providerThread) ? { run } : { skip: "no_awaited_work" };
  if (
    liveTurnRequired &&
    !projection.providerTurns.some(
      (turn) =>
        turn.providerThreadId === providerThread.id &&
        turn.runAttemptId === run.activeAttemptId &&
        turn.status === "running",
    )
  )
    return { skip: "no_running_turn" };
  return { run };
}

export function restartContinuationDecision(
  projection: Parameters<typeof activeRestartContinuationDecision>[0],
  now: DateTime.Utc,
): ReturnType<typeof activeRestartContinuationDecision> {
  const decision = activeRestartContinuationDecision(projection, now);
  if ("run" in decision) return decision;
  if (
    projection.runs.some((run) =>
      ["preparing", "starting", "running", "waiting"].includes(run.status),
    )
  )
    return decision;
  const queued = projection.runs.filter((run) => run.status === "queued" && run.queueHeld !== true);
  return queued.length > 0
    ? activeRestartContinuationDecision({ ...projection, runs: queued }, now)
    : decision;
}

export function restartContinuationRun(
  projection: Parameters<typeof restartContinuationDecision>[0],
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  const decision = restartContinuationDecision(projection, now);
  return "run" in decision ? decision.run : undefined;
}

export const continueRestartedRun = Effect.fn("RestartContinuation.continueRestartedRun")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly sourceRunId: RunId;
    readonly queued?: boolean | undefined;
  }) {
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
    const path = yield* Effect.serviceOption(Path.Path);
    if (
      Option.isSome(config) &&
      Option.isSome(fs) &&
      Option.isSome(path) &&
      (yield* preparedCutoverOwns(input.threadId, input.sourceRunId).pipe(
        Effect.provideService(ServerConfig.ServerConfig, config.value),
        Effect.provideService(FileSystem.FileSystem, fs.value),
        Effect.provideService(Path.Path, path.value),
      ))
    )
      return;
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const messageId = MessageId.make(`message:restart-continuation:${input.sourceRunId}`);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "providerTurns", "attempts", "runtimeRequests", "turnItems"],
      { messageIds: [messageId], turnItemTypes: ["secret_request"] },
    );
    if (
      !resolveProjectSettings(enabled, projection.thread.projectId).settings
        .continueThreadsAfterServerUpdate
    )
      return;
    if (projection.messages.some((message) => message.id === messageId)) return;
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    // A replayed queue wake must never become an in-flight continuation. Those
    // have separate durable effect IDs so a second crash can still recover it.
    if (input.queued && source?.status !== "queued") {
      yield* Effect.sync(() =>
        source &&
        ["preparing", "starting", "running", "waiting", "completed"].includes(source.status)
          ? markContinuationDispatched(input.threadId)
          : markContinuationDeclined(
              input.threadId,
              source ? `queue_source_${source.status}` : "queue_source_missing",
            ),
      );
      return;
    }
    if (source?.status === "queued") {
      if (source.queueHeld === true) return;
      if (restartContinuationBlocked(projection, source, yield* DateTime.now, true)) return;
      // Register before dispatch: a worker may reach the actual provider call
      // immediately after the queue promotion transaction commits.
      yield* Effect.sync(() => markQueuedRunRecovered(source.id));
      // Claim the original queued run under the normal per-thread dispatch lock.
      yield* threads.dispatch({
        type: "queue.cutover-release",
        commandId: CommandId.make(`command:restart-queue:${input.sourceRunId}`),
        threadId: input.threadId,
      });
      const current = yield* threads.getThreadRecords(input.threadId, ["runs"]);
      const promoted = current.runs.find((run) => run.id === source.id);
      yield* Effect.sync(() =>
        promoted?.status !== "queued"
          ? markContinuationDispatched(input.threadId)
          : markContinuationDeclined(
              input.threadId,
              promoted.queueHeld === true ? "queue_held" : "queue_admission_deferred",
            ),
      );
      return;
    }
    if (
      !source ||
      !isRestartContinuationSource(source, projection.providerTurns) ||
      restartContinuationBlocked(
        projection,
        source,
        yield* DateTime.now,
        isRestartNoteSource(source, projection.providerTurns) || source.status === "interrupted",
      )
    )
      return;
    if (
      projection.runs.some(
        (run) =>
          run.id !== source.id &&
          run.status !== "queued" &&
          !cancelledBeforeStart(run) &&
          runRanAfter(run, source),
      )
    )
      return;
    if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
    // A turn that keeps crashing the server would otherwise restart it forever.
    let chainLength = 0;
    const loopWindowStart =
      DateTime.toEpochMillis(source.completedAt ?? source.requestedAt) -
      CONTINUATION_LOOP_WINDOW_MS;
    for (
      let run: OrchestrationV2Run | undefined = source;
      run?.restartContinuationOfRunId !== undefined && chainLength < MAX_CONTINUATION_CHAIN;
      run = projection.runs.find((candidate) => candidate.id === run?.restartContinuationOfRunId)
    ) {
      if (DateTime.toEpochMillis(run.requestedAt) < loopWindowStart) break;
      chainLength += 1;
    }
    if (chainLength >= MAX_CONTINUATION_CHAIN) {
      yield* Effect.logWarning("Not continuing a run restarted too many times in a row", {
        threadId: input.threadId,
        sourceRunId: input.sourceRunId,
      });
      return;
    }
    const sourceRecords = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "turnItems"],
      {
        messageIds: [source.userMessageId],
        turnItemRunIds: [source.id],
        turnItemTypes: ["run_interrupt_request"],
      },
    );
    if (
      sourceRecords.turnItems.some(
        (item) => item.runId === source.id && item.type === "run_interrupt_request",
      )
    )
      return;
    const sourceMessage = sourceRecords.messages.find(
      (message) => message.id === source.userMessageId,
    );
    if (sourceMessage !== undefined && isNativeMaintenanceCommand(sourceMessage)) return;
    const replayOriginal = !projection.providerTurns.some(
      (turn) => turn.runAttemptId === source.activeAttemptId,
    );
    if (
      replayOriginal &&
      sourceMessage === undefined &&
      source.restartContinuationOfRunId === undefined
    )
      return;
    const note = restartContinuationNote(
      source,
      projection.runs,
      projection.providerTurns,
      projection.attempts,
    );
    // ardud: an OpenCode child still running or finished is not told as cancelled.
    const summary =
      note.work.length === 0
        ? undefined
        : yield* restartNoteSummary(settings, note.work).pipe(
            Effect.map((value) => ({
              ...value,
              text: value.text === "" ? undefined : value.text,
            })),
          );
    const noteText = summary?.text;
    // ardud: a settled parent whose only cut work is a confirmed-running child has no
    // note to give. Dispatching would start a turn and claim the work stopped.
    if (note.settled && noteText === undefined && note.work.length > 0) return;
    // ardud: the headline claims "stopped" only when the note kept cancelled work.
    const noteSaysCancelled = summary?.claimsCancelled === true;
    const text =
      replayOriginal && sourceMessage !== undefined
        ? sourceMessage.text
        : noteText === undefined
          ? CONTINUE_PROMPT
          : note.settled
            ? noteText
            : `${noteText}\n\n${CONTINUE_PROMPT}`;
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
        threadId: input.threadId,
        messageId,
        text,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          // ardud: the headline claims "stopped" only when the note itself says work was cancelled;
          // a checked-running, finished or unknown OpenCode child must not get that claim.
          summary:
            note.settled && noteSaysCancelled
              ? "T3 Code restarted and stopped background work"
              : "T3 Code restarted and resumed this turn",
          detail: text,
        },
        ...(replayOriginal && sourceMessage?.context !== undefined
          ? { context: sourceMessage.context }
          : {}),
        attachments: replayOriginal ? (sourceMessage?.attachments ?? []) : [],
        modelSelection: source.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: input.sourceRunId,
      })
      .pipe(
        Effect.tap(() => Effect.sync(() => markContinuationDispatched(input.threadId))),
        // The project turned this instance off since the restart. No turn
        // resumes, and the success path below still runs so a delegated
        // child waiting on this run is recovered immediately instead of
        // after EffectWorker exhausts its retries on a refusal that will
        // not change.
        Effect.catchTags({
          ThreadManagementProviderInstanceDisabledError: (error) =>
            Effect.logInfo("orchestration-v2.restart-continuation.instance-disabled", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
              projectId: error.projectId,
              instanceId: error.instanceId,
            }),
        }),
      );
  },
  // A delegated child this declined to continue still owes its parent a
  // result. Once a continuation run exists this is a no-op; that run settles it.
  (effect, input) =>
    effect.pipe(
      Effect.tap(() => Effect.sync(() => markContinuationFinished(input.threadId))),
      Effect.andThen(
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
        }),
      ),
    ),
);
