import * as Effect from "effect/Effect";
import { McpSchema } from "effect/ai";

import * as SavedWrite from "../engine/savedWrite.ts";

export const TOOLS = new Set([
  "card_move",
  "card_review_result",
  "subtask_done",
  "card_flag",
  "card_update",
  "card_edit",
  "card_ask_change",
  "evaluator_start",
]);

/** Encloses encoding and the reply budget, not just the mutation handler. */
export const protect = Effect.fn("KanbanTools.savedReply")(function* <E, R>(
  effect: Effect.Effect<McpSchema.CallToolResult | McpSchema.InputRequired, E, R>,
  tool: string,
) {
  const parent = yield* SavedWrite.observer;
  let receipt: SavedWrite.Saved | undefined;
  const fallback = (timedOut = false) => {
    const details =
      receipt?.kind === "card"
        ? { card: { id: receipt.card.id, number: receipt.card.number, stage: receipt.card.stage } }
        : receipt?.kind === "evaluator"
          ? { threadId: receipt.threadId }
          : {};
    const message =
      receipt === undefined
        ? "Board write reply timed out; the write may have been saved. Read back with card_get (evaluator_start: check board threads) before retrying."
        : "Saved; card_get for details.";
    return Effect.logWarning("kanban saved write reply unavailable", {
      timedOut,
      saved: receipt !== undefined,
    }).pipe(
      Effect.as(
        new McpSchema.CallToolResult({
          isError: false,
          structuredContent: { ...details, saved: receipt === undefined ? null : true, message },
          content: [{ type: "text", text: message }],
        }),
      ),
    );
  };
  return yield* effect.pipe(
    Effect.provideService(SavedWrite.observer, (saved) => {
      parent(saved);
      if (tool === "evaluator_start") {
        if (saved.kind === "evaluator") receipt = saved;
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
    // Return read-back guidance before a typical client's 30 second call deadline.
    Effect.timeoutOrElse({ duration: "25 seconds", orElse: () => fallback(true) }),
  );
});
