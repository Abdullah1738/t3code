import * as Effect from "effect/Effect";
import { McpCall } from "./McpCall.ts";

type Stage = NonNullable<McpCall["Service"]["activityStages"]>[number]["stage"];

export const step = <A, E, R>(stage: Stage, effect: Effect.Effect<A, E, R>) =>
  Effect.fn(
    stage === "load"
      ? "KanbanService.activity.load"
      : stage === "rollup" || stage === "compact"
        ? `Activity.${stage}`
        : `KanbanService.activity.load.${stage}`,
  )(function* () {
    const call = yield* Effect.serviceOption(McpCall);
    if (call._tag === "None") return yield* effect;
    const rows = (call.value.activityStages ??= []);
    const started = performance.now();
    const row: NonNullable<McpCall["Service"]["activityStages"]>[number] = {
      stage,
      durationMs: 0,
      completed: false,
      started,
    };
    if (rows.length < 16) rows.push(row);
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          row.durationMs = Math.max(0, performance.now() - started);
          row.completed = exit._tag === "Success";
          delete row.started;
        }),
      ),
    );
  })();
