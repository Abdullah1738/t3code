import * as Effect from "effect/Effect";
import { McpSchema } from "effect/ai";

import * as BoardLocks from "../engine/boardLocks.ts";
import * as SavedWrite from "../engine/savedWrite.ts";

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
  const parent = yield* SavedWrite.observer;
  const parentCommitting = yield* SavedWrite.commitObserver;
  let commitStarted = false;
  let receipt: SavedWrite.Saved | undefined;
  const fallback = (timedOut = false) => {
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
    return Effect.logWarning("kanban saved write reply unavailable", {
      timedOut,
      saved,
      commitStarted,
    }).pipe(
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
  return yield* effect.pipe(
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
    // timeoutOrElse joins the interrupted effect, including finalizers, before
    // fallback reads the commit state. Never detach the losing write fiber.
    Effect.timeoutOrElse({ duration: REPLY_BUDGET_MS, orElse: () => fallback(true) }),
  );
});
