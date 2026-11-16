import { McpCall, writeCommitting, writeRefused } from "../../analytics/McpCall.ts";
import type { KanbanCard, KanbanMessage, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";

export const LONG_HOLD_MS = 5_000;
export type SubStep = { readonly subStep: string; readonly ms: number };

export const subStepReporter = Context.Reference<(steps: ReadonlyArray<SubStep>) => void>(
  "KanbanSavedWriteSubStepReporter",
  { defaultValue: () => () => {} },
);

export const subStepObserver = Context.Reference<
  | {
      readonly tracer: Tracer.Tracer;
      readonly hold: (fiberId: number) => (long: boolean) => ReadonlyArray<SubStep> | undefined;
    }
  | undefined
>("KanbanSavedWriteSubSteps", { defaultValue: () => undefined });

// Reuse existing operation spans, including interrupted SQL admission. No extra
// spans or detail rows on fast calls. Evaluator calls also count launch I/O
// outside the board permit, where command-receipt reads can wait on a reader.
export const subSteps = Effect.fnUntraced(function* <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  includeOutsideLocks = false,
) {
  const delegate = yield* Tracer.Tracer;
  const parent = yield* subStepObserver;
  const clock = yield* Clock.Clock;
  const startedAt = clock.monotonicTimeNanosUnsafe();
  const now = () => Number(clock.monotonicTimeNanosUnsafe() - startedAt) / 1_000_000;
  const active = new Map<number, Array<Tracer.Span>>();
  const holds = new Set<{
    fiberId: number;
    since: number;
    totals: Map<string, number>;
  }>();
  const account = (fiberId: number) => {
    if (holds.size === 0) return;
    const at = now();
    const step = active.get(fiberId)?.at(-1)?.name ?? name;
    for (const hold of holds) {
      if (hold.fiberId !== fiberId) continue;
      const ms = Math.max(0, at - hold.since);
      if (ms > 0) hold.totals.set(step, (hold.totals.get(step) ?? 0) + ms);
      hold.since = at;
    }
  };
  const tracer = Tracer.make({
    span(options) {
      const span = delegate.span(options);
      // Plumbing should not hide the operation that is waiting on it.
      if (/^(?:KanbanBoardLocks\.|KanbanSavedWrite\.|sql\.|sqlite$)/.test(options.name))
        return span;
      const fiberId = Fiber.getCurrent()?.id;
      if (fiberId === undefined) return span;
      account(fiberId);
      const stack = active.get(fiberId) ?? [];
      if (stack.length === 0) active.set(fiberId, stack);
      stack.push(span);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        account(fiberId);
        const index = stack.indexOf(span);
        if (index >= 0) stack.splice(index, 1);
        if (stack.length === 0) active.delete(fiberId);
        end(endTime, exit);
      };
      return span;
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
  const hold = (fiberId: number) => {
    const held = { fiberId, since: now(), totals: new Map<string, number>() };
    holds.add(held);
    return (long: boolean) => {
      account(fiberId);
      holds.delete(held);
      if (!long) return undefined;
      return [...held.totals]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([subStep, ms]) => ({
          subStep:
            subStep.length <= 160 && /^[a-zA-Z0-9_.:/#@%+-]+$/.test(subStep) ? subStep : "unknown",
          ms,
        }));
    };
  };
  const finish = includeOutsideLocks ? hold(yield* Effect.fiberId) : undefined;
  const report = yield* subStepReporter;
  return yield* effect.pipe(
    // Lock collectors still return their diagnostics, but only the enclosing
    // whole-call collector publishes to the reply ledger.
    (effect) =>
      includeOutsideLocks ? effect.pipe(Effect.provideService(subStepReporter, () => {})) : effect,
    Effect.withTracer(tracer),
    Effect.provideService(subStepObserver, {
      tracer: parent?.tracer ?? delegate,
      hold,
    }),
    Effect.ensuring(
      Effect.sync(() => {
        const steps = finish?.(now() >= LONG_HOLD_MS);
        if (steps !== undefined) report(steps);
      }),
    ),
  );
});

// The store defers this callback when SQL is inside an enclosing transaction.
export const afterCommit = Context.Reference<(confirm: () => void) => void>(
  "KanbanSavedWriteAfterCommit",
  {
    defaultValue: () => (confirm) => confirm(),
  },
);
const requestCommitEvidence = Context.Reference<boolean>("KanbanSavedWriteRequestCommitEvidence", {
  defaultValue: () => true,
});

// Setup may persist a discussion while the incoming request is still unsaved.
export const preparatory = Effect.fn("KanbanSavedWrite.preparatory")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  return yield* effect.pipe(
    Effect.provideService(observer, () => {}),
    Effect.provideService(requestCommitEvidence, false),
  );
});

export const committed = Effect.fnUntraced(function* () {
  const call = yield* Effect.serviceOption(McpCall);
  if (call._tag === "Some" && call.value.boardWrite && (yield* requestCommitEvidence))
    (yield* afterCommit)(() => {
      call.value.saved = true;
      delete call.value.refusedAt;
    });
});

export type Stage = "caller" | "admission" | "read" | "mutate" | "commit" | "ack";

export const traceObserver = Context.Reference<
  | {
      readonly span: Tracer.Span;
      readonly enter: (stage: Stage, fiberId: number) => () => void;
      readonly mark: (stage: Stage, fiberId: number) => void;
    }
  | undefined
>("KanbanSavedWriteTrace", { defaultValue: () => undefined });

// Only protected MCP writes collect stage timings; each scope owns its stage span.
export const stage = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  name: Stage,
) {
  effect = effect.pipe(
    Effect.onError(() =>
      writeRefused(name === "admission" || name === "caller" ? "pre_lock" : "in_write"),
    ),
  );
  const trace = yield* traceObserver;
  if (trace === undefined) return yield* effect;
  const fiberId = yield* Effect.fiberId;
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => trace.enter(name, fiberId)),
    () =>
      effect.pipe(
        Effect.withSpan("KanbanSavedWrite.stage", { attributes: { "kanban.reply.stage": name } }),
      ),
    (leave) => Effect.sync(leave),
  );
});

// Mutation is the enclosing phase after caller resolution, including reply encoding.
export const mutating = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const trace = yield* traceObserver;
  if (trace === undefined) return yield* effect;
  trace.mark("mutate", yield* Effect.fiberId);
  return yield* effect.pipe(Effect.withSpan("KanbanSavedWrite.mutate"));
});

// Detached work keeps commit/receipt evidence, but cannot advance the reply's stage.
export const background = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const steps = yield* subStepObserver;
  const detached = effect.pipe(
    Effect.provideService(traceObserver, undefined),
    Effect.provideService(subStepObserver, undefined),
  );
  return yield* steps === undefined ? detached : detached.pipe(Effect.withTracer(steps.tracer));
});

// MCP's toolkit restores its registration context, including ParentSpan. Link the
// handler root rather than changing that context or the lifetime of its work.
export const linkReply = Effect.fnUntraced(function* () {
  const trace = yield* traceObserver;
  if (trace === undefined) return;
  const work = yield* Effect.option(Effect.currentSpan);
  if (work._tag === "None") return;
  work.value.addLinks([{ span: trace.span, attributes: { "kanban.reply.work": true } }]);
  trace.span.addLinks([{ span: work.value, attributes: { "kanban.reply.work": true } }]);
});

export type Saved =
  | { readonly kind: "card"; readonly card: KanbanCard }
  | { readonly kind: "message"; readonly message: KanbanMessage }
  | { readonly kind: "evaluator"; readonly threadId: ThreadId; readonly key?: string | undefined }
  | { readonly kind: "evaluatorQueue"; readonly key: string; readonly queueId: number };

export type ReportLookup =
  | {
      readonly kind: "card";
      readonly boardId: KanbanCard["boardId"];
      readonly cardId: KanbanCard["id"];
      readonly number: number;
    }
  | {
      readonly kind: "evaluator";
      readonly boardId: KanbanCard["boardId"];
      readonly keyPrefix: string;
    };

// Published before a report can write; unlike a receipt, this does not prove a save.
export const reportLookupObserver = Context.Reference<(lookup: ReportLookup) => void>(
  "KanbanReportLookup",
  {
    defaultValue: () => () => {},
  },
);

export const locateReport = Effect.fn("KanbanSavedWrite.locateReport")(function* (
  lookup: ReportLookup,
) {
  (yield* reportLookupObserver)(lookup);
});

export const observer = Context.Reference<(saved: Saved) => void>("KanbanSavedWrite", {
  defaultValue: () => () => {},
});

// Separate from receipts: recovery filters receipts by their target entity.
export const commitObserver = Context.Reference<() => void>("KanbanSavedWriteCommitting", {
  defaultValue: () => () => {},
});

// Runs at every store write; the enclosing lock operation already supplies its span.
export const committing = Effect.gen(function* () {
  if (yield* requestCommitEvidence) yield* writeCommitting();
  const trace = yield* traceObserver;
  trace?.mark("commit", yield* Effect.fiberId);
  (yield* commitObserver)();
});

export const record = Effect.fn("KanbanSavedWrite.record")(function* (saved: Saved) {
  yield* committed();
  const trace = yield* traceObserver;
  trace?.mark("ack", yield* Effect.fiberId);
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
