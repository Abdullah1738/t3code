import type { KanbanCard, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type Saved =
  | { readonly kind: "card"; readonly card: KanbanCard }
  | { readonly kind: "evaluator"; readonly threadId: ThreadId };

export const observer = Context.Reference<(saved: Saved) => void>("KanbanSavedWrite", {
  defaultValue: () => () => {},
});

export const record = Effect.fn("KanbanSavedWrite.record")(function* (saved: Saved) {
  (yield* observer)(saved);
});

/** Recover outside the lock wrapper too: its stale-continuation check runs after the save. */
export const recover = Effect.fn("KanbanSavedWrite.recover")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  select: (saved: Saved) => A | undefined,
) {
  const parent = yield* observer;
  let saved: A | undefined;
  return yield* effect.pipe(
    Effect.provideService(observer, (receipt) => {
      const value = select(receipt);
      if (value !== undefined) {
        saved = value;
        parent(receipt);
      }
    }),
    Effect.catchCause((cause) =>
      saved === undefined
        ? Effect.failCause(cause)
        : Effect.logWarning("kanban saved write post-commit work failed", { cause }).pipe(
            Effect.as(saved),
          ),
    ),
  );
});

export const bestEffort = Effect.fn("KanbanSavedWrite.bestEffort")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback: A,
) {
  return yield* effect.pipe(
    Effect.timeout("5 seconds"),
    Effect.catchCause((cause) =>
      Effect.logWarning("kanban saved write post-commit work failed", { cause }).pipe(
        Effect.as(fallback),
      ),
    ),
  );
});
