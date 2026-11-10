import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import type { Connection } from "effect/sql/SqlConnection";

/**
 * Which reader a read-only statement uses.
 *
 * - `auth` / `identity`: reserved single-connection processes (session and
 *   execution identity lookups).
 * - `foreground`: interactive views (shell pages, thread detail, board and
 *   discussion views, transcript checks on a user action). Opt in with
 *   `foregroundReads`; served by the foreground pool when one is configured.
 * - `background`: everything else (sweeps, recovery, provider ingest,
 *   control-API polling). The default, so an untagged caller can never queue
 *   ahead of interactive work.
 */
export type ReaderLaneName = "auth" | "identity" | "foreground" | "background";

export const ReaderLane = Context.Reference<ReaderLaneName>(
  "@t3tools/shared/nodeSqliteClient/ReaderLane",
  { defaultValue: () => "background" },
);

/** Auth and identity use their own reserved processes and snapshot limits. */
export const isReservedLane = (lane: ReaderLaneName): lane is "auth" | "identity" =>
  lane === "auth" || lane === "identity";

const laneOverloaded = (lane: string, limit: number) =>
  new SqlError({
    reason: classifySqliteError(new Error(`Reader lane admission queue full (${lane}, ${limit} in flight)`), {
      operation: "readerAdmission",
      message: `Reader lane admission queue full (${lane})`,
    }),
  });

export interface ReaderSlotLock {
  readonly take: (permits: number) => Effect.Effect<number, SqlError>;
  readonly release: (permits: number) => Effect.Effect<number>;
  readonly withPermits: (
    permits: number,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
  readonly withPermitsIfAvailable: (
    permits: number,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
}

export interface ReaderPoolSlot {
  readonly connection: Connection;
  readonly lock: ReaderSlotLock;
  readonly lane: "foreground" | "background";
  readonly slot: number;
}

export interface ReaderPool {
  /** Resolves a slot (least loaded first); undefined when that slot's worker is unavailable. */
  readonly acquire: Effect.Effect<ReaderPoolSlot | undefined>;
  /** Reads queued or running on this lane, across its slots. */
  readonly inFlight: () => number;
  readonly slots: number;
}

/**
 * A lane of one or more reader workers. Each slot has its own permit, so a
 * transaction (which holds its slot's permit from BEGIN to COMMIT) pins one
 * worker snapshot and never spans slots. Admission is bounded per lane: past
 * `queueLimit` reads queued or running, a new read fails at once with
 * "Reader lane admission queue full" instead of waiting without bound.
 */
export const makeReaderPool = Effect.fnUntraced(function* (options: {
  readonly lane: "foreground" | "background";
  readonly slots: ReadonlyArray<Effect.Effect<Connection | undefined>>;
  readonly queueLimit: number;
}) {
  let inFlight = 0;
  const entries = yield* Effect.forEach(options.slots, (acquire, slot) =>
    Effect.map(Semaphore.make(1), (semaphore) => ({ slot, acquire, semaphore, load: 0 })),
  );
  type Entry = (typeof entries)[number];
  const admit = (entry: Entry): SqlError | undefined => {
    if (inFlight >= options.queueLimit) return laneOverloaded(options.lane, options.queueLimit);
    inFlight++;
    entry.load++;
    return undefined;
  };
  const leave = (entry: Entry) => {
    inFlight--;
    entry.load--;
  };
  const lockFor = (entry: Entry): ReaderSlotLock => ({
    take: (permits) =>
      Effect.suspend(() => {
        const refused = admit(entry);
        if (refused !== undefined) return Effect.fail(refused);
        return entry.semaphore
          .take(permits)
          .pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => leave(entry)))));
      }),
    release: (permits) =>
      entry.semaphore.release(permits).pipe(Effect.ensuring(Effect.sync(() => leave(entry)))),
    withPermits:
      (permits) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.suspend<A, E | SqlError, R>(() => {
          const refused = admit(entry);
          if (refused !== undefined) return Effect.fail(refused);
          // Semaphore's own atomic acquire/finalizer handoff; the count covers waiting and running.
          return entry.semaphore
            .withPermits(permits)(effect)
            .pipe(Effect.ensuring(Effect.sync(() => leave(entry))));
        }),
    withPermitsIfAvailable:
      (permits) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        entry.semaphore.withPermitsIfAvailable(permits)(
          Effect.suspend(() => {
            inFlight++;
            entry.load++;
            return effect.pipe(Effect.ensuring(Effect.sync(() => leave(entry))));
          }),
        ),
  });
  const locks = entries.map(lockFor);
  const pick = (): Entry => {
    let best = entries[0]!;
    for (const entry of entries) if (entry.load < best.load) best = entry;
    return best;
  };
  const acquire = Effect.suspend(() => {
    const entry = pick();
    return Effect.map(entry.acquire, (connection) =>
      connection === undefined
        ? undefined
        : { connection, lock: locks[entry.slot]!, lane: options.lane, slot: entry.slot },
    );
  });
  return { acquire, inFlight: () => inFlight, slots: entries.length } satisfies ReaderPool;
});

/** Bounded admission for one reserved connection; opened after migrations. */
export const makeReaderLanes = Effect.fnUntraced(function* <E, R>(
  make: () => Effect.Effect<Effect.Effect<Connection | undefined>, E, R>,
) {
  const slot = yield* Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    let waiting = 0;
    let starting = 0;
    const take = (permits: number) =>
      Effect.suspend(() => {
        if (waiting >= 256)
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(new Error("Reader lane admission queue full"), {
                operation: "readerAdmission",
                message: "Reader lane admission queue full",
              }),
            }),
          );
        waiting++;
        return semaphore.take(permits).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              waiting--;
            }),
          ),
        );
      });
    const lock = {
      take,
      release: (permits: number) => semaphore.release(permits),
      withPermits:
        (permits: number) =>
        <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
          Effect.suspend<A, E2 | SqlError, R2>(() => {
            if (waiting >= 256)
              return Effect.fail(
                new SqlError({
                  reason: classifySqliteError(new Error("Reader lane admission queue full"), {
                    operation: "readerAdmission",
                    message: "Reader lane admission queue full",
                  }),
                }),
              );
            waiting++;
            // Use Semaphore's own atomic acquire/finalizer handoff.
            return semaphore
              .withPermits(permits)(effect)
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    waiting--;
                  }),
                ),
              );
          }),
      withPermitsIfAvailable: semaphore.withPermitsIfAvailable.bind(semaphore),
    };
    const acquire = yield* make();
    const boundedAcquire = Effect.suspend(() => {
      if (starting >= 256)
        return Effect.fail(
          new SqlError({
            reason: classifySqliteError(new Error("Reader startup queue full"), {
              operation: "readerAdmission",
              message: "Reader startup queue full",
            }),
          }),
        );
      starting++;
      return acquire.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            starting--;
          }),
        ),
      );
    });
    return { acquire: boundedAcquire, lock };
  });
  return Effect.suspend(() => {
    return Effect.flatMap(slot.acquire, (connection) => {
      if (connection === undefined)
        return Effect.fail(
          new SqlError({
            reason: classifySqliteError(new Error("Reader lane unavailable"), {
              operation: "readerAdmission",
              message: "Reader lane unavailable",
            }),
          }),
        );
      return Effect.succeed({ connection, lock: slot.lock });
    });
  });
});

/** Preserve Semaphore receivers when composing writer and auth locks. */
export const bindSemaphore = (lock: Semaphore.Semaphore) => ({
  take: lock.take.bind(lock),
  release: lock.release.bind(lock),
  withPermits: lock.withPermits.bind(lock),
  withPermitsIfAvailable: lock.withPermitsIfAvailable.bind(lock),
});
