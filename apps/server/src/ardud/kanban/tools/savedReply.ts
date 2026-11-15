import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import { McpSchema } from "effect/ai";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as BoardLocks from "../engine/boardLocks.ts";
import * as SavedWrite from "../engine/savedWrite.ts";
import { McpCall } from "../../analytics/McpCall.ts";

export const REPLY_BUDGET_MS = 25_000;
export const ADMISSION_BUDGET_MS = REPLY_BUDGET_MS - 5_000;

export const TOOLS = new Set([
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

/** Encloses encoding and the reply budget, not just the mutation handler. */
export const protect = Effect.fn("KanbanTools.savedReply")(function* <E, R>(
  effect: Effect.Effect<McpSchema.CallToolResult | McpSchema.InputRequired, E, R>,
  tool: string,
) {
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
  let timerLatenessMs: number | null = null;
  let closed = false;
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
  const call = yield* Effect.serviceOption(McpCall);
  let slowSubSteps: ReadonlyArray<SavedWrite.SubStep> = [];
  let commitStarted = false;
  let receipt: SavedWrite.Saved | undefined;
  const attributes = () => ({
    "kanban.reply.stage_at_timeout": stageAtTimeout,
    "kanban.reply.timed_out": timerLatenessMs !== null,
    "kanban.reply.saved": receipt !== undefined ? true : commitStarted ? null : false,
    "kanban.reply.commit_started": commitStarted,
    "kanban.reply.elapsed_ms": elapsed(),
    "kanban.reply.budget_ms": REPLY_BUDGET_MS,
    "kanban.reply.timer_lateness_ms": timerLatenessMs,
  });
  const fallback = (timedOut = false) => {
    if (call._tag === "Some") call.value.replyFailure = timedOut ? "reply_timeout" : "reply_error";
    if (call._tag === "Some") call.value.replyStage = stageAtTimeout ?? stage;
    const details =
      receipt?.kind === "card"
        ? {
            card: { id: receipt.card.id, number: receipt.card.number, stage: receipt.card.stage },
            ...(tool === "report_bug" ? { appendedTo: `#${receipt.card.number}` } : {}),
          }
        : receipt?.kind === "evaluator"
          ? { threadId: receipt.threadId }
          : receipt?.kind === "message"
            ? { message: { discussionId: receipt.message.discussionId, seq: receipt.message.seq } }
            : {};
    const saved = receipt !== undefined ? true : commitStarted ? null : false;
    const message =
      saved === false
        ? "Not saved (board busy). Safe to retry."
        : tool === "report_bug"
          ? receipt === undefined
            ? "Bug report reply timed out; a sighting or evaluator may have been saved. Check card_get and board threads before retrying."
            : receipt.kind === "evaluator"
              ? "Saved; the returned threadId identifies the request evaluator. Do not submit another report."
              : "Saved; the sighting is on appendedTo. Read it with card_get."
          : tool === "discussion_post"
            ? receipt === undefined
              ? "Discussion post reply timed out; the message may have been saved. Read back with discussion_read before retrying."
              : "Saved; discussion_read for details."
            : receipt === undefined
              ? "Board write reply timed out; the write may have been saved. Read back with card_get (evaluator_start: check board threads) before retrying."
              : "Saved; card_get for details.";
    const fields = attributes();
    return Effect.annotateCurrentSpan(fields).pipe(
      Effect.andThen(
        Effect.logWarning("kanban saved write reply unavailable", {
          timedOut,
          saved,
          commitStarted,
          ...fields,
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
  const work = effect.pipe(
    // Interactive pre-write reads must not queue behind tick and maintenance scans.
    NodeSqliteClient.foregroundReads,
    Effect.provideService(SavedWrite.traceObserver, { span, enter, mark }),
    Effect.provideService(SavedWrite.subStepReporter, (steps) => {
      slowSubSteps = [...slowSubSteps, ...steps].sort((a, b) => b.ms - a.ms).slice(0, 3);
      span.attribute("kanban.reply.sub_steps", slowSubSteps);
      if (call._tag === "Some") call.value.replySubSteps = slowSubSteps;
    }),
    Effect.provideService(BoardLocks.writeWaitMs, ADMISSION_BUDGET_MS),
    Effect.provideService(SavedWrite.commitObserver, () => {
      commitStarted = true;
      parentCommitting();
    }),
    Effect.provideService(SavedWrite.observer, (saved) => {
      parent(saved);
      if (tool === "report_bug") {
        if (
          saved.kind === "evaluator" ||
          (saved.kind === "card" &&
            (receipt === undefined ||
              (receipt.kind === "card" && saved.card.id === receipt.card.id)))
        )
          receipt = saved;
      } else if (tool === "evaluator_start") {
        if (saved.kind === "evaluator") receipt = saved;
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
      !(result instanceof McpSchema.InputRequired) && result.isError && receipt !== undefined
        ? fallback()
        : Effect.succeed(result),
    ),
    Effect.catchCause((cause) => (receipt === undefined ? Effect.failCause(cause) : fallback())),
  );
  // Capture the firing time before raceFirst joins cancellation finalizers. The
  // eventual reply can be late because of cleanup even when the timer was on time.
  let scheduledAt = 0;
  const timer = Effect.suspend(() => {
    scheduledAt = elapsed();
    return Effect.sleep(REPLY_BUDGET_MS);
  }).pipe(
    Effect.andThen(
      Effect.sync(() => {
        stageAtTimeout = stage;
        timerLatenessMs = Math.max(0, elapsed() - scheduledAt - REPLY_BUDGET_MS);
      }),
    ),
    Effect.as(Option.none()),
  );
  return yield* work.pipe(
    Effect.map(Option.some),
    Effect.raceFirst(timer),
    Effect.flatMap((result) =>
      Option.isSome(result) ? Effect.succeed(result.value) : fallback(true),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        updateStage();
        closed = true;
        for (const [key, value] of Object.entries(attributes())) span.attribute(key, value);
      }),
    ),
  );
});
