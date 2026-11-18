// @effect-diagnostics nodeBuiltinImport:off -- Host gauges and monotonic timing come from Node's in-process APIs.
import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import { forkParked } from "../../serverActivation.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import * as Analytics from "./Analytics.ts";

type Snapshot = Effect.Success<
  ReturnType<NonNullable<ProviderSessionManager.ProviderSessionManagerV2Shape["runtimeSnapshot"]>>
>;
type Props = NonNullable<AnalyticsEvent["props"]>;

const increment = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1);

export function runtimeSampleProps(
  snapshot: Snapshot,
  caller: NonNullable<KanbanStore.KanbanStoreShape["callerAnalytics"]>,
  host: NonNullable<Props["host"]>,
) {
  const byProvider = new Map<string, number>();
  const models = new Map<string, number>();
  const runningByOrigin = {
    boardWork: 0,
    boardReview: 0,
    boardEvaluator: 0,
    delegatedChild: 0,
    scheduledTask: 0,
    other: 0,
  };
  for (const turn of snapshot.turns) {
    increment(byProvider, turn.provider);
    increment(models, turn.model);
    const origin = caller(turn.threadId);
    // A child can inherit its parent's board role; count its own origin first.
    if (origin?.callerKind === "delegated_child") runningByOrigin.delegatedChild++;
    else if (origin?.callerRole === "work") runningByOrigin.boardWork++;
    else if (origin?.callerRole === "review") runningByOrigin.boardReview++;
    else if (origin?.callerRole === "evaluator") runningByOrigin.boardEvaluator++;
    else runningByOrigin.other++;
  }
  const ordered = [...models]
    .filter(([model]) => model !== "other")
    .sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b));
  const byModel = Object.fromEntries(ordered.slice(0, 10));
  byModel.other =
    (models.get("other") ?? 0) + ordered.slice(10).reduce((sum, [, count]) => sum + count, 0);
  return {
    runningTurns: {
      total: snapshot.turns.length,
      byProvider: Object.fromEntries(byProvider),
      byModel,
    },
    runningByOrigin,
    providerSessions: snapshot.providerSessions,
    host,
  };
}

export class RuntimeSampler extends Context.Service<
  RuntimeSampler,
  {
    readonly sample: () => Effect.Effect<void>;
  }
>()("t3/ardud/analytics/RuntimeSampler") {}

const make = Effect.gen(function* () {
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const boards = yield* KanbanStore.KanbanStore;
  const analytics = yield* Analytics.Analytics;
  const sample = Effect.fn("RuntimeSampler.sample")(function* () {
    // Time collection only; Analytics.record queues the row for its independent disk writer.
    const started = NodePerfHooks.performance.now();
    if (sessions.runtimeSnapshot === undefined) return;
    const snapshot = yield* sessions.runtimeSnapshot();
    const [load1 = 0, load5 = 0, load15 = 0] = NodeOS.loadavg();
    const memory = process.memoryUsage();
    const props = runtimeSampleProps(snapshot, boards.callerAnalytics ?? (() => undefined), {
      load1,
      load5,
      load15,
      rssMiB: memory.rss / 1024 ** 2,
      heapUsedMiB: memory.heapUsed / 1024 ** 2,
    });
    const ts = DateTime.formatIso(yield* DateTime.now);
    const sampleMs = NodePerfHooks.performance.now() - started;
    yield* analytics.record({
      ts,
      kind: "server.runtime_sample",
      surface: "server",
      route: "server",
      props: { ...props, sampleMs },
    });
  });
  return RuntimeSampler.of({ sample });
});

export const layer = Layer.effect(RuntimeSampler, make);
export const layerScheduled = Layer.effectDiscard(
  Effect.gen(function* () {
    const sampler = yield* RuntimeSampler;
    yield* forkParked(sampler.sample().pipe(Effect.repeat(Schedule.spaced("60 seconds"))));
  }),
).pipe(Layer.provide(layer));
