import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { McpSchema } from "effect/ai";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as BoardLocks from "../engine/boardLocks.ts";
import * as SavedWrite from "../engine/savedWrite.ts";
import { McpCall } from "../../analytics/McpCall.ts";

export const REPLY_BUDGET_MS = 25_000;
export const ADMISSION_BUDGET_MS = REPLY_BUDGET_MS - 5_000;

export const TOOLS = new Set([
  "card_claim",
  "card_create",
  "card_wait",
  "card_ask",
  "card_ask_answer",
  "card_thread",
  "card_move",
  "card_review_result",
  "subtask_done",
  "card_flag",
  "card_update",
  "card_edit",
  "card_ask_change",
  "evaluator_start",
  "report_bug",
  "discussion_post",
]);
export const TIMED_TOOLS = new Set([...TOOLS, "wiki_read"]);

/** Encloses encoding and the reply budget, not just the mutation handler. */
export const protect = Effect.fn("KanbanTools.savedReply")(function* <E, R>(
  effect: Effect.Effect<McpSchema.CallToolResult | McpSchema.InputRequired, E, R>,
  tool: string,
) {
  const timingOnly = !TOOLS.has(tool);
  const span = yield* Effect.currentSpan.pipe(Effect.orDie);
  const clock = yield* Clock.Clock;
  const started = clock.monotonicTimeNanosUnsafe();
  const elapsed = () => Number(clock.monotonicTimeNanosUnsafe() - started) / 1_000_000;
  let baseStage: SavedWrite.Stage = "caller";
  const scopes = new Map<symbol, { stage: SavedWrite.Stage; fiberId: number }>();
  let stage: SavedWrite.Stage = "caller";
  let stageSince = 0;
  const totals = new Map<SavedWrite.Stage, number>();
  let stageAtTimeout: SavedWrite.Stage | null = null;
  let deadline: "read" | "reply" | null = null;
  let readBudgetMs: number | null = null;
  let timerLatenessMs: number | null = null;
  const lockSnapshots = new Map<symbol, (now: number) => Readonly<Record<string, unknown>>>();
  const readerSnapshots = new Map<symbol, () => NodeSqliteClient.ReaderSnapshot>();
  const awaitedSnapshots = new Map<symbol, () => ReadonlyArray<string>>();
  const parentReader = yield* NodeSqliteClient.ReaderSnapshotObserver;
  let knownLocks: Readonly<Record<string, unknown>> = {};
  let timeoutLocks: Readonly<Record<string, unknown>> = {};
  let timeoutReaders: ReadonlyArray<NodeSqliteClient.ReaderSnapshot> = [];
  let timeoutAwaited: ReadonlyArray<string> = [];
  let timeoutElapsedMs = 0;
  let timeoutObservedAtMs = 0;
  let closed = false;
  const admissions = new Map<symbol, { detail: Effect.Effect<string>; fiberId: number }>();
  let admissionDetail: string | undefined;
  const updateStage = () => {
    if (closed) return;
    const now = elapsed();
    const total = (totals.get(stage) ?? 0) + now - stageSince;
    totals.set(stage, total);
    span.attribute(`kanban.reply.stage_ms.${stage}`, total);
    stage = [...scopes.values()].at(-1)?.stage ?? baseStage;
    stageSince = now;
  };
  // Parallel scopes can end in either order. Removing only this token preserves
  // the newest scope still running instead of resurrecting a captured stage.
  const enter = (next: SavedWrite.Stage, fiberId: number) => {
    if (closed) return () => {};
    const token = Symbol();
    scopes.set(token, { stage: next, fiberId });
    updateStage();
    return () => {
      if (scopes.delete(token)) updateStage();
    };
  };
  const mark = (next: SavedWrite.Stage, fiberId: number) => {
    if (closed) return;
    const scope = [...scopes.values()].findLast((scope) => scope.fiberId === fiberId);
    if (scope === undefined) baseStage = next;
    else scope.stage = next;
    updateStage();
  };
  const parent = yield* SavedWrite.observer;
  const parentCommitting = yield* SavedWrite.commitObserver;
  const parentLookup = yield* SavedWrite.reportLookupObserver;
  const call = yield* Effect.serviceOption(McpCall);
  let slowSubSteps: ReadonlyArray<SavedWrite.SubStep> = [];
  let wholeCallReported = false;
  const reportSubSteps = (steps: ReadonlyArray<SavedWrite.SubStep>, wholeCall = false) => {
    // A whole-call collection already includes the holds; do not count them twice.
    if (wholeCallReported && !wholeCall) return;
    wholeCallReported ||= wholeCall;
    slowSubSteps = [...(wholeCall ? [] : slowSubSteps), ...steps]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3);
    span.attribute("kanban.reply.sub_steps", slowSubSteps);
    if (call._tag === "Some") call.value.replySubSteps = slowSubSteps;
  };
  let commitStarted = false;
  let receipt: SavedWrite.Saved | undefined;
  let unverifiedReporter: SavedWrite.UnverifiedReporterReason | undefined;
  let reportLookup: SavedWrite.ReportLookup | undefined;
  // raceFirst joins cancellation before replying. Evaluator admissions and bug
  // sightings publish their receipt inside the masked write, including queue-only saves.
  const savedState = () =>
    receipt !== undefined
      ? true
      : tool === "evaluator_start" || (tool === "report_bug" && deadline !== null)
        ? false
        : tool === "report_bug" && reportLookup === undefined
          ? false
          : commitStarted
            ? null
            : false;
  const attributes = () => ({
    "kanban.reply.stage_at_timeout": stageAtTimeout,
    "kanban.reply.timed_out": deadline !== null,
    "kanban.reply.saved": savedState(),
    "kanban.reply.commit_started": commitStarted,
    "kanban.reply.elapsed_ms": elapsed(),
    "kanban.reply.budget_ms": REPLY_BUDGET_MS,
    "kanban.reply.read_budget_ms": readBudgetMs,
    "kanban.reply.timer_lateness_ms": timerLatenessMs,
  });
  const fallback = (timedOut = false) => {
    if (call._tag === "Some") call.value.replyFailure = timedOut ? "reply_timeout" : "reply_error";
    if (call._tag === "Some") call.value.replyStage = stageAtTimeout ?? stage;
    updateStage();
    if (call._tag === "Some") call.value.replyPhases = Object.fromEntries(totals);
    const details =
      receipt?.kind === "card"
        ? {
            card: { id: receipt.card.id, number: receipt.card.number, stage: receipt.card.stage },
            ...(tool === "report_bug" ? { appendedTo: `#${receipt.card.number}` } : {}),
          }
        : receipt?.kind === "evaluator"
          ? { threadId: receipt.threadId }
          : receipt?.kind === "evaluatorQueue"
            ? { queued: true, queueId: receipt.queueId, evaluatorKey: receipt.key }
            : receipt?.kind === "message"
              ? {
                  message: { discussionId: receipt.message.discussionId, seq: receipt.message.seq },
                }
              : tool === "report_bug" && reportLookup !== undefined
                ? { lookup: reportLookup }
                : {};
    if (tool === "report_bug" && unverifiedReporter !== undefined) {
      Object.assign(details, { callerVerified: false, callerUnverifiedReason: unverifiedReporter });
    }
    const saved = savedState();
    const savedMessage =
      saved === false
        ? (admissionDetail ??
          (tool === "evaluator_start"
            ? "Not saved; evaluator not started. Safe to retry with the same arguments."
            : tool === "report_bug"
              ? "Nothing was saved; retry with the same arguments."
              : `Not saved (reply timed out before a save; stage: ${stageAtTimeout ?? stage}). Safe to retry.`))
        : tool === "evaluator_start"
          ? receipt?.kind === "evaluator"
            ? `Saved; evaluator launched as ${receipt.threadId}. Do not retry. Use evaluator_status with this threadId to find its cards.`
            : receipt?.kind === "evaluatorQueue"
              ? "Saved; the request is queued. The launch may still finish. Use evaluator_status with the returned queueId to find its evaluator and cards. Retry only with the same arguments to recover this request; do not submit a new request."
              : "Saved; the sighting is on the returned card. Do not retry."
          : tool === "report_bug"
            ? receipt === undefined
              ? reportLookup === undefined
                ? "Nothing was saved; retry with the same arguments."
                : `Bug report outcome unknown. ${
                    reportLookup.kind === "card"
                      ? `Look up card #${reportLookup.number} (${reportLookup.cardId}) on board ${reportLookup.boardId}.`
                      : `Look up evaluator key prefix ${reportLookup.keyPrefix} on board ${reportLookup.boardId}.`
                  } Retry with the same arguments to recover the report or save it once.`
              : receipt.kind === "evaluator"
                ? "Saved; the returned threadId identifies the request evaluator. Use evaluator_status with this threadId to find its cards. Do not submit another report."
                : receipt.kind === "evaluatorQueue"
                  ? "Saved; the request evaluator is queued. Its launch may still finish. Use evaluator_status with the returned queueId to find its evaluator and cards. Retry only with the same arguments to recover this request. Do not submit another report."
                  : "Saved; the sighting is on appendedTo. Read it with card_get."
            : tool === "discussion_post"
              ? receipt === undefined
                ? "The message may have been saved. Read back with discussion_read before retrying."
                : "Saved; discussion_read for details."
              : receipt === undefined
                ? "The write may have been saved. Read back with card_get (evaluator_start: check board threads) before retrying."
                : "Saved; card_get for details.";
    const waitMessage = !timedOut
      ? undefined
      : stageAtTimeout === "read"
        ? "Read timed out."
        : stageAtTimeout === "admission" && typeof timeoutLocks["board.waiting_on"] === "string"
          ? "Board lock wait timed out."
          : undefined;
    const outcomeMessage =
      waitMessage === undefined ? savedMessage : `${waitMessage} ${savedMessage}`;
    const message =
      tool === "report_bug" && saved === true && unverifiedReporter !== undefined
        ? `${outcomeMessage} Saved with an unverified caller; reporter unverified (${unverifiedReporter}).`
        : outcomeMessage;
    const fields = attributes();
    const boardId =
      (call._tag === "Some" ? call.value.boardId : undefined) ??
      timeoutLocks["board.id"] ??
      knownLocks["board.id"] ??
      (receipt?.kind === "card" ? receipt.card.boardId : null);
    const cardId =
      (call._tag === "Some" ? call.value.cardId : undefined) ??
      timeoutLocks["board.card_id"] ??
      knownLocks["board.card_id"] ??
      (receipt?.kind === "card" ? receipt.card.id : null);
    const operation = timeoutLocks["board.operation"] ?? knownLocks["board.operation"] ?? tool;
    const diagnostics = {
      "board.observed_at_ms": timedOut ? timeoutObservedAtMs : clock.currentTimeMillisUnsafe(),
      "board.waiter": tool,
      "board.waiting_on": null,
      "board.waited_ms": timedOut ? timeoutElapsedMs : elapsed(),
      "board.holders": [],
      "board.blockers": [],
      ...timeoutLocks,
      boardId,
      operation,
      cardId,
      "board.id": boardId,
      "board.operation": operation,
      "board.card_id": cardId,
      "board.reply_phase": stageAtTimeout ?? stage,
      "board.reply_elapsed_ms": timedOut ? timeoutElapsedMs : elapsed(),
      awaited: timeoutAwaited,
      readers: timeoutReaders,
      subSteps: slowSubSteps,
    };
    return Effect.annotateCurrentSpan(fields).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          Effect.logWarning(
            // Fixed diagnostic fields, as in the lock-admission refusal logger.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              event:
                saved === false
                  ? "kanban board write refused"
                  : "kanban saved write reply unavailable",
              saved,
              timedOut,
              ...diagnostics,
            }),
          ).pipe(
            Effect.annotateLogs({ ...diagnostics, "board.lock_log": true }),
            Effect.provideService(References.MinimumLogLevel, "Warn"),
          ),
        ),
      ),
      Effect.andThen(
        Effect.logWarning("kanban saved write reply unavailable", {
          timedOut,
          saved,
          commitStarted,
          ...fields,
          ...diagnostics,
        }),
      ),
      Effect.as(
        new McpSchema.CallToolResult({
          isError: receipt === undefined,
          structuredContent: {
            saved,
            message,
            ...details,
            ...(tool === "card_review_result" && receipt?.kind === "card"
              ? { recorded: true }
              : {}),
          },
          content: [{ type: "text", text: message }],
        }),
      ),
    );
  };
  const captureDeadline = (kind: "read" | "reply", budgetMs?: number) => {
    if (deadline !== null) return;
    deadline = kind;
    readBudgetMs = budgetMs ?? null;
    stageAtTimeout = kind === "read" ? "read" : stage;
    timeoutElapsedMs = elapsed();
    timeoutObservedAtMs = clock.currentTimeMillisUnsafe();
    timeoutLocks = [...lockSnapshots.values()].at(-1)?.(timeoutObservedAtMs) ?? {};
    timeoutReaders = [...readerSnapshots.values()].flatMap((snapshot) => {
      try {
        return [snapshot()];
      } catch {
        return [];
      }
    });
    timeoutAwaited = [...awaitedSnapshots.values()].flatMap((snapshot) => snapshot()).slice(0, 3);
  };
  const work = effect.pipe(
    Effect.provideService(BoardLocks.admissionObserver, (detail, fiberId) => {
      const token = Symbol();
      admissions.set(token, { detail, fiberId });
      return () => {
        admissions.delete(token);
      };
    }),
    // Interactive pre-write reads must not queue behind tick and maintenance scans.
    (effect) => (timingOnly ? effect : NodeSqliteClient.foregroundReads(effect)),
    Effect.provideService(SavedWrite.traceObserver, {
      span,
      enter,
      mark,
      readDeadline: (budgetMs) => captureDeadline("read", budgetMs),
      // Cleared together with stage tracking by SavedWrite.background.
      observeLocks: (snapshot) => {
        const token = Symbol();
        lockSnapshots.set(token, snapshot);
        knownLocks = { ...knownLocks, ...snapshot(clock.currentTimeMillisUnsafe()) };
        return () => {
          knownLocks = { ...knownLocks, ...snapshot(clock.currentTimeMillisUnsafe()) };
          lockSnapshots.delete(token);
        };
      },
      observeAwaited: (snapshot) => {
        const token = Symbol();
        awaitedSnapshots.set(token, snapshot);
        return () => {
          awaitedSnapshots.delete(token);
        };
      },
    }),
    Effect.provideService(NodeSqliteClient.ReaderSnapshotObserver, (snapshot) => {
      const token = Symbol();
      readerSnapshots.set(token, snapshot);
      let stopParent: (() => void) | undefined;
      try {
        stopParent = parentReader?.(snapshot);
      } catch {
        /* Diagnostic only. */
      }
      return () => {
        readerSnapshots.delete(token);
        try {
          stopParent?.();
        } catch {
          /* Diagnostic only. */
        }
      };
    }),
    Effect.provideService(SavedWrite.subStepReporter, reportSubSteps),
    Effect.provideService(SavedWrite.callSubStepReporter, (steps) => reportSubSteps(steps, true)),
    Effect.provideService(
      BoardLocks.writeWaitMs,
      timingOnly ? yield* BoardLocks.writeWaitMs : ADMISSION_BUDGET_MS,
    ),
    Effect.provideService(SavedWrite.reportLookupObserver, (lookup) => {
      reportLookup = lookup;
      parentLookup(lookup);
    }),
    Effect.provideService(SavedWrite.reporterUnverified, (reason) => {
      unverifiedReporter = reason;
    }),
    Effect.provideService(SavedWrite.commitObserver, () => {
      commitStarted = true;
      parentCommitting();
    }),
    Effect.provideService(SavedWrite.observer, (saved) => {
      parent(saved);
      if (tool === "report_bug") {
        if (
          saved.kind === "evaluator" ||
          saved.kind === "evaluatorQueue" ||
          (saved.kind === "card" &&
            (receipt === undefined ||
              (receipt.kind === "card" && saved.card.id === receipt.card.id)))
        )
          receipt = saved;
      } else if (tool === "evaluator_start") {
        if (saved.kind === "evaluator" || saved.kind === "evaluatorQueue" || saved.kind === "card")
          receipt = saved;
      } else if (tool === "discussion_post") {
        if (
          saved.kind === "message" &&
          (receipt === undefined ||
            (receipt.kind === "message" &&
              saved.message.discussionId === receipt.message.discussionId &&
              saved.message.seq === receipt.message.seq))
        )
          receipt = saved;
      } else if (
        saved.kind === "card" &&
        (receipt?.kind !== "card" || saved.card.id === receipt.card.id)
      ) {
        receipt = saved;
      }
    }),
    Effect.flatMap((result) =>
      !timingOnly &&
      !(result instanceof McpSchema.InputRequired) &&
      (deadline === "read" || (result.isError && receipt !== undefined))
        ? fallback(deadline === "read")
        : Effect.succeed(result),
    ),
    Effect.catchCause((cause) =>
      !timingOnly && deadline === "read"
        ? fallback(true)
        : timingOnly || receipt === undefined
          ? Effect.failCause(cause)
          : fallback(),
    ),
  );
  // Capture the firing time before raceFirst joins cancellation finalizers. The
  // eventual reply can be late because of cleanup even when the timer was on time.
  let scheduledAt = 0;
  const timer = Effect.suspend(() => {
    scheduledAt = elapsed();
    return Effect.sleep(REPLY_BUDGET_MS);
  }).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        captureDeadline("reply");
        timerLatenessMs = Math.max(0, elapsed() - scheduledAt - REPLY_BUDGET_MS);
        const foreground = [...scopes.values()].findLast((scope) => scope.stage === "admission");
        const detail = [...admissions.values()].findLast(
          (entry) => entry.fiberId === foreground?.fiberId,
        )?.detail;
        if (stageAtTimeout === "admission" && detail !== undefined) admissionDetail = yield* detail;
      }),
    ),
    Effect.as(Option.none()),
  );
  return yield* work.pipe(
    Effect.map(Option.some),
    (effect) => (timingOnly ? effect : effect.pipe(Effect.raceFirst(timer))),
    Effect.flatMap((result) =>
      Option.isSome(result) ? Effect.succeed(result.value) : fallback(true),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        updateStage();
        if (call._tag === "Some") {
          call.value.replyPhases = Object.fromEntries(totals);
          call.value.writePhases = {
            lockWait: totals.get("admission") ?? 0,
            read: totals.get("read") ?? 0,
            write: totals.get("commit") ?? 0,
            replyWait: totals.get("ack") ?? 0,
          };
        }
        closed = true;
        for (const [key, value] of Object.entries(attributes())) span.attribute(key, value);
      }),
    ),
  );
});
