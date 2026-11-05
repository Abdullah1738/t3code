import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as CutoverStore from "./CutoverStore.ts";

export interface CutoverItem {
  readonly key: string;
  readonly kind: "selection" | "thread" | "card" | "finalize";
  readonly ref: string;
  readonly payload: unknown;
  readonly wake: boolean;
}

export interface CutoverPlan {
  readonly readiness: ReadonlyArray<{
    readonly id: string;
    readonly ready: boolean;
    readonly reason: string;
  }>;
  readonly items: ReadonlyArray<CutoverItem>;
  readonly refusals: ReadonlyArray<{ readonly ref: string; readonly reason: string }>;
}

export type CutoverPhase = "switch" | "brief" | "rollback";

export class CutoverError extends Schema.TaggedError<CutoverError>()("CutoverError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {
  override get message(): string {
    return `Harness cutover failed during ${this.operation}.`;
  }
}

export class CutoverDeferred extends Schema.TaggedError<CutoverDeferred>()("CutoverDeferred", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export class CutoverActions extends Context.Service<
  CutoverActions,
  {
    readonly plan: Effect.Effect<CutoverPlan, CutoverError>;
    readonly check?: (
      items: ReadonlyArray<CutoverItem>,
    ) => Effect.Effect<CutoverPlan["readiness"], CutoverError>;
    /** Each phase must be idempotent under item.key, including a replay after a lost acknowledgement. */
    readonly apply: (
      item: CutoverItem,
      phase: CutoverPhase,
    ) => Effect.Effect<void, CutoverError | CutoverDeferred>;
  }
>()("t3/ardud/harness-migrate/CutoverEngine/CutoverActions") {}

export interface CutoverStatus {
  readonly active: boolean;
  readonly completed: boolean;
  readonly claimedThreadIds: ReadonlyArray<string>;
  readonly claimedRuns: ReadonlyArray<{ readonly threadId: string; readonly runId: string }>;
  readonly items: ReadonlyArray<CutoverStore.CutoverLedgerItem>;
  readonly refusals: CutoverPlan["refusals"];
}

export class HarnessCutover extends Context.Service<
  HarnessCutover,
  {
    readonly plan: () => Effect.Effect<CutoverPlan, CutoverError>;
    /** One bounded batch; invoking run again resumes the persisted snapshot. */
    readonly run: () => Effect.Effect<CutoverStatus, CutoverError>;
    readonly status: () => Effect.Effect<CutoverStatus, CutoverError>;
  }
>()("t3/ardud/harness-migrate/CutoverEngine/HarnessCutover") {}

const MAX_ATTEMPTS = 3;
const needsBrief = (item: CutoverItem) => item.kind === "thread";
const done = (item: CutoverStore.CutoverLedgerItem) =>
  item.state === "briefed" || (item.state === "switched" && !needsBrief(item));
const SourceRun = Schema.Struct({ sourceRunId: Schema.String });
const hasSourceRun = Schema.is(SourceRun);

const describe = (
  snapshot: CutoverStore.CutoverSnapshot | null,
  refusals: CutoverPlan["refusals"] = snapshot?.refusals ?? [],
): CutoverStatus => {
  const items = snapshot?.items ?? [];
  const completed =
    snapshot !== null && !snapshot.initializing && items.every(done) && refusals.length === 0;
  // Successful source runs stay claimed after completion so delayed recovery cannot revive them.
  const claims = items.filter((item) => item.kind === "thread" && !item.rolledBack);
  return {
    active: snapshot !== null && !completed,
    completed,
    claimedThreadIds: [...new Set(claims.map((item) => item.ref))],
    claimedRuns: claims.flatMap((item) =>
      hasSourceRun(item.payload) ? [{ threadId: item.ref, runId: item.payload.sourceRunId }] : [],
    ),
    items,
    refusals,
  };
};

const make = Effect.fn("HarnessCutover.make")(function* (
  options: {
    readonly batchSize?: number;
    readonly paceMillis?: number;
  } = {},
) {
  const actions = yield* CutoverActions;
  const store = yield* CutoverStore.CutoverStore;
  const lock = yield* Semaphore.make(1);
  const batchSize = Math.max(1, Math.min(8, Math.trunc(options.batchSize ?? 8) || 8));
  const paceMillis = Math.max(0, options.paceMillis ?? 100);
  const storageError = (cause: CutoverStore.CutoverStoreError) =>
    new CutoverError({ operation: cause.operation, cause });

  const read = store.read().pipe(Effect.mapError(storageError));
  const status = Effect.fn("HarnessCutover.status")(function* () {
    return describe(yield* read);
  });
  const save = Effect.fn("HarnessCutover.save")(function* (item: CutoverStore.CutoverLedgerItem) {
    yield* store.save(item).pipe(Effect.mapError(storageError));
  });

  const rollback = Effect.fn("HarnessCutover.rollback")(function* (
    item: CutoverStore.CutoverLedgerItem,
  ) {
    if (
      (item.kind !== "selection" && item.kind !== "thread") ||
      item.rolledBack ||
      item.rollbackAttempts >= MAX_ATTEMPTS
    ) {
      return item;
    }
    const pending: CutoverStore.CutoverLedgerItem = {
      ...item,
      state: "failed",
      reason: item.reason ?? "Cutover attempt limit reached.",
      rollbackAttempts: item.rollbackAttempts + 1,
    };
    yield* save(pending);
    const result = yield* Effect.result(actions.apply(pending, "rollback"));
    const restored: CutoverStore.CutoverLedgerItem = {
      ...pending,
      rolledBack: Result.isSuccess(result),
      rollbackAttempts:
        Result.isFailure(result) && result.failure._tag === "CutoverDeferred"
          ? item.rollbackAttempts
          : pending.rollbackAttempts,
      reason: Result.isFailure(result) ? result.failure.message : pending.reason,
    };
    yield* save(restored);
    return restored;
  });

  const process = Effect.fn("HarnessCutover.process")(function* (
    item: CutoverStore.CutoverLedgerItem,
    phase: "switch" | "brief",
  ) {
    let current: CutoverStore.CutoverLedgerItem = {
      ...item,
      attempts: item.attempts + 1,
      reason: null,
    };
    yield* save(current);
    const result = yield* Effect.result(actions.apply(current, phase));
    if (Result.isFailure(result)) {
      if (result.failure._tag === "CutoverDeferred") {
        const deferred: CutoverStore.CutoverLedgerItem = {
          ...current,
          state: phase === "switch" ? "planned" : "switched",
          phase,
          attempts: item.attempts,
          reason: result.failure.reason,
        };
        yield* save(deferred);
        return deferred;
      }
      current = { ...current, state: "failed", phase, reason: result.failure.message };
      yield* save(current);
      if (current.attempts >= MAX_ATTEMPTS) current = yield* rollback(current);
      return current;
    }
    current = {
      ...current,
      state: phase === "switch" ? "switched" : "briefed",
      phase: phase === "switch" && needsBrief(current) ? "brief" : phase,
      // Switching and briefing have separate retry budgets; a successful switch starts the next phase.
      attempts: phase === "switch" && needsBrief(current) ? 0 : current.attempts,
    };
    yield* save(current);
    return current;
  });

  const run = Effect.fn("HarnessCutover.run")(function* () {
    const existing = yield* read;
    if (existing !== null && actions.check === undefined) {
      return yield* new CutoverError({ operation: "resume-readiness" });
    }
    const fresh = existing === null ? yield* actions.plan : null;
    const readiness =
      existing !== null && actions.check ? yield* actions.check(existing.items) : fresh!.readiness;
    const refusals = existing?.refusals ?? fresh!.refusals;
    const refused = readiness
      .filter((check) => !check.ready)
      .map((check) => ({
        ref: check.id,
        reason: check.reason,
      }));
    if (refused.length > 0 || refusals.length > 0) {
      return describe(existing, [...refusals, ...refused]);
    }

    // Frozen plan import must finish before any switch can be delivered.
    let snapshot =
      (existing?.initializing ? null : existing) ??
      (yield* store
        .start(existing?.items ?? fresh!.items, refusals)
        .pipe(Effect.mapError(storageError)));
    let processed = 0;
    const visited = new Set<string>();
    const deferredKeys = new Set(
      snapshot.items
        .filter((item) => item.reason !== null && item.state !== "failed")
        .map((item) => item.key),
    );
    // A wake can run board actions immediately. Restore every card and future selection before sending it.
    // Defer retries until untouched switches and briefs get a turn, keeping persisted plan order within each group.
    for (const retryDeferred of [false, true]) {
      for (const pass of ["switch", "brief", "finalize"] as const) {
        if (
          pass === "brief" &&
          snapshot.items.some(
            (row) => (row.kind === "selection" || row.kind === "card") && !done(row),
          )
        )
          continue;
        for (const [index, item] of snapshot.items.entries()) {
          if (done(item) || visited.has(item.key)) continue;
          if (processed >= batchSize) break;
          if (deferredKeys.has(item.key) !== retryDeferred) continue;
          if (pass === "finalize") {
            if (
              item.kind !== "finalize" ||
              snapshot.refusals.length > 0 ||
              snapshot.items.some((row) => row.kind !== "finalize" && !done(row))
            )
              continue;
          } else if (item.kind === "finalize" || item.phase !== pass) {
            continue;
          }
          if (
            item.attempts >= MAX_ATTEMPTS &&
            (item.rolledBack ||
              item.rollbackAttempts >= MAX_ATTEMPTS ||
              (item.kind !== "selection" && item.kind !== "thread"))
          )
            continue;
          if (processed > 0 && paceMillis > 0) yield* Effect.sleep(paceMillis);
          processed += 1;
          const updated =
            item.attempts >= MAX_ATTEMPTS
              ? yield* rollback(item)
              : yield* process(item, pass === "brief" ? "brief" : "switch");
          const items = snapshot.items.slice();
          items[index] = updated;
          snapshot = { ...snapshot, items };
          // A successful switch may enter the brief pass in this invocation; failed/deferred work may not.
          if (updated.state !== "switched" || updated.phase !== "brief") visited.add(item.key);
          if (updated.reason !== null) visited.add(item.key);
          if (item.kind === "selection" && !done(updated) && updated.attempts < MAX_ATTEMPTS) break;
        }
      }
    }
    return describe(snapshot);
  }, lock.withPermits(1));

  return HarnessCutover.of({
    plan: Effect.fn("HarnessCutover.plan")(() => actions.plan),
    run,
    status,
  });
});

export const layerWithOptions = (options: {
  readonly batchSize?: number;
  readonly paceMillis?: number;
}) => Layer.effect(HarnessCutover, make(options));
export const layer = layerWithOptions({});
