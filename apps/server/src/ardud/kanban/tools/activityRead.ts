import type { KanbanBoardId, KanbanError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { KanbanService } from "../engine/KanbanService.ts";
import * as Activity from "../engine/activity.ts";

type Service = Pick<KanbanService["Service"], "activity">;
type Reply = { activity: { boardId: KanbanBoardId } & ReturnType<typeof Activity.rollup> };
const pending = new WeakMap<Service, Map<string, Effect.Effect<Reply, KanbanError>>>();

const rollup = Effect.fn("Activity.rollup")(function* (input: Activity.RollupInput) {
  return yield* Effect.sync(() => Activity.rollup(input));
});

// Share only pending reads. Each caller still resolves its own board access first.
export const read = Effect.fn("KanbanTools.boardActivity")(function* (
  service: Service,
  boardId: KanbanBoardId,
  window: Activity.ActivityWindow,
) {
  const key = `${boardId}:${window.since}:${window.until}`;
  let reads = pending.get(service);
  if (reads === undefined) {
    reads = new Map();
    pending.set(service, reads);
  }
  const existing = reads.get(key);
  if (existing !== undefined) return yield* existing;
  let currentRun: symbol;
  let shared: Effect.Effect<Reply, KanbanError>;
  shared = yield* Effect.cached(
    Effect.gen(function* () {
      const run = Symbol();
      currentRun = run;
      return yield* Effect.gen(function* () {
        const rows = yield* service.activity(boardId, window);
        return { activity: { boardId, ...(yield* rollup({ window, ...rows })) } };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (currentRun === run && reads.get(key) === shared) reads.delete(key);
          }),
        ),
      );
    }),
  );
  // Cached construction may yield; another caller can have installed the same read.
  const winner = reads.get(key) ?? shared;
  reads.set(key, winner);
  return yield* winner;
});
