import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { KanbanStoreError, KanbanStoreShape } from "../store/KanbanStore.ts";

// Higher priority scopes own elapsed wall time when tick fibers overlap. This
// partitions the tick rather than summing concurrent or nested I/O durations.
export const phases = [
  "card_evaluation",
  "start_card",
  "dependency_checks",
  "pool_accounting",
  "board_load",
  "discussion_updates",
  "thread_status",
  "event_persistence",
  "queue_wait",
] as const;
export type Phase = (typeof phases)[number];

export const make = (now: () => number) => {
  const started = now();
  let last = started;
  let finished = false;
  const active = phases.map(() => 0);
  const durations = phases.map(() => 0);
  const counts = phases.map(() => 0);
  let dbActive = 0;
  let dbMs = 0;
  const scanned = new Set<string>();
  const changed = new Set<string>();
  const account = () => {
    const at = now();
    const elapsed = Math.max(0, at - last);
    const phase = active.findLastIndex((count) => count > 0);
    durations[Math.max(0, phase)]! += elapsed;
    if (dbActive > 0) dbMs += elapsed;
    last = at;
  };
  return {
    overlappingTicks: 0,
    enter(phase: Phase, db = false) {
      if (finished) return () => {};
      account();
      const index = phases.indexOf(phase);
      active[index]!++;
      counts[index]!++;
      if (db) dbActive++;
      let left = false;
      return () => {
        if (finished || left) return;
        left = true;
        account();
        active[index]!--;
        if (db) dbActive--;
      };
    },
    cards(value: unknown, write = false) {
      if (finished) return;
      for (const row of Array.isArray(value) ? value : [value]) {
        if (row && typeof row === "object" && "id" in row && "stage" in row) {
          scanned.add(String(row.id));
          if (write) changed.add(String(row.id));
        }
      }
    },
    finish() {
      account();
      finished = true;
      return {
        durationMs: Math.max(0, last - started),
        dbMs,
        queueWaitMs: durations[phases.indexOf("queue_wait")]!,
        cardsScanned: scanned.size,
        cardsChanged: changed.size,
        phases: phases.map((phase, index) => ({
          phase,
          durationMs: durations[index]!,
          count: counts[index]!,
        })),
      };
    },
  };
};

export const current = Context.Reference<ReturnType<typeof make> | undefined>("KanbanTickTimings", {
  defaultValue: () => undefined,
});

// No span per call outside a measured tick: these store paths are also used by
// foreground board operations and detached work which outlives the tick.
export const measure = <A, E, R>(
  phase: Phase,
  effect: Effect.Effect<A, E, R>,
  db = false,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(current, (timing) => {
    if (!timing) return effect;
    return Effect.acquireUseRelease(
      Effect.sync(() => timing.enter(phase, db)),
      () => effect,
      (leave) => Effect.sync(leave),
    ).pipe(Effect.withSpan("KanbanService.tickPhase", { attributes: { phase } }));
  });

export const admission = <A, E, R>(
  acquire: (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(current, (timing) => {
    if (!timing) return acquire(effect);
    return Effect.acquireUseRelease(
      Effect.sync(() => timing.enter("queue_wait")),
      (leave) => acquire(Effect.sync(leave).pipe(Effect.andThen(effect))),
      (leave) => Effect.sync(leave),
    );
  });

const storePhase = (key: string): Phase => {
  if (/^(board|boards|cards|openCards|dispatchCards|summaryCards)$/.test(key)) return "board_load";
  if (/Pool|^pools$/.test(key)) return "pool_accounting";
  if (/Event/.test(key)) return "event_persistence";
  if (/Discussion|discussion|Message|message|ownerWait/.test(key)) return "discussion_updates";
  return "card_evaluation";
};

/** Preserve the service's signatures, instrumenting both methods and effect properties. */
export const store = (source: KanbanStoreShape): KanbanStoreShape =>
  new Proxy(source, {
    get(target, key, receiver) {
      if (!Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
      // Metadata lookups are synchronous; the transaction observer only carries
      // context. Neither is a database operation to time or turn into an Effect.
      if (["callerAnalytics", "registerCallerParent", "observeCallerWrites"].includes(String(key)))
        return Reflect.get(target, key, receiver);
      const member =
        target[
          key as keyof Omit<
            KanbanStoreShape,
            "callerAnalytics" | "registerCallerParent" | "observeCallerWrites"
          >
        ];
      const wrap = (
        operation: Effect.Effect<unknown, KanbanStoreError, Scope.Scope>,
        args: unknown[] = [],
      ) =>
        measure(
          storePhase(String(key)),
          operation.pipe(
            Effect.tap((result) =>
              Effect.flatMap(current, (timing) =>
                Effect.sync(() => {
                  if (key === "putCard") timing?.cards(args[0], true);
                  else timing?.cards(result);
                }),
              ),
            ),
          ),
          true,
        );
      return typeof member === "function"
        ? (...args: unknown[]) =>
            wrap(
              Reflect.apply<
                typeof target,
                never[],
                Effect.Effect<unknown, KanbanStoreError, Scope.Scope>
              >(member, target, args as never[]),
              args,
            )
        : wrap(member);
    },
  });

export const create = Effect.map(Clock.Clock, (clock) =>
  make(() => Number(clock.monotonicTimeNanosUnsafe()) / 1e6),
);
