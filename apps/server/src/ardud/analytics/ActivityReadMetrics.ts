import * as Effect from "effect/Effect";
import { McpCall } from "./McpCall.ts";

type Stage = NonNullable<McpCall["Service"]["activityStages"]>[number]["stage"];

const measure = (stage: Stage) =>
  Effect.fn(
    stage === "load"
      ? "KanbanService.activity.load"
      : stage === "rollup" || stage === "compact"
        ? `Activity.${stage}`
        : `KanbanService.activity.load.${stage}`,
  )(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
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
  });

const stages = {
  load: measure("load"),
  cards: measure("cards"),
  events: measure("events"),
  history: measure("history"),
  threads: measure("threads"),
  slots: measure("slots"),
  board: measure("board"),
  pools: measure("pools"),
  evaluatorEvents: measure("evaluatorEvents"),
  dispatch: measure("dispatch"),
  analytics: measure("analytics"),
  rollup: measure("rollup"),
  compact: measure("compact"),
} satisfies Record<Stage, ReturnType<typeof measure>>;

export const step = <A, E, R>(stage: Stage, effect: Effect.Effect<A, E, R>) =>
  stages[stage](effect);
