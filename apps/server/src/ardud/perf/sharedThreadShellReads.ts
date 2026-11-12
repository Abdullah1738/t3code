import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

/**
 * ardud: one shell read per (thread, event sequence) for all shell subscribers.
 *
 * Every open shell stream (desktop window, web tab, phone) projected each live
 * event batch on its own: one subscription opened at 08:05 on 11 Nov 2026 ran
 * 2,319 projections in 75 minutes, and four subscribers multiplied the
 * "unpaged full snapshot" reads that kept the background reader lane at a p95
 * wait of 10-115 s. Subscribers see the same events, so the shell of thread T
 * read for event sequence S is the same answer for all of them.
 *
 * - A key is claimed with a Deferred before the read starts, so a concurrent
 *   subscriber joins the read in flight instead of starting its own.
 * - Claiming the keys and starting the reader is one uninterruptible step: a
 *   subscriber interrupted while it registers a batch can't leave a published
 *   entry without a reader (11 Nov 2026 review: with a small scheduler budget
 *   the claim loop yielded, the subscriber disconnected, and the next
 *   subscriber for that key waited forever).
 * - The read runs detached: a subscriber that disconnects mid-read does not
 *   interrupt the read other subscribers are waiting on. The reader completes
 *   every entry it claimed on any exit, interruption included.
 * - A waiter never hangs: past `waitTimeout` it drops the stuck entry and
 *   reads the shell itself.
 * - A failed read is not cached; its waiters get the failure and the next
 *   batch reads again.
 * - Entries are kept per owner (the server's ThreadManagementService) and the
 *   oldest are dropped past `maxEntries`. Dropping an entry doesn't strand its
 *   waiters: the reader still holds it and completes it.
 */
const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_WAIT_TIMEOUT = Duration.minutes(2);
const FALLBACK_READ_CONCURRENCY = 8;

const cachesByOwner = new WeakMap<object, Map<string, unknown>>();

export const readThreadShellsShared = Effect.fnUntraced(function* <
  Id extends string,
  S,
  E,
  R1,
  R2,
>(options: {
  readonly owner: object;
  readonly wanted: ReadonlyArray<{ readonly threadId: Id; readonly sequence: number }>;
  /** Used when at least `batchMinThreads` shells are missing and batching is on. */
  readonly readMany: (ids: ReadonlyArray<Id>) => Effect.Effect<ReadonlyMap<Id, S>, E, R1>;
  readonly readOne: (id: Id) => Effect.Effect<S | null, E, R2>;
  readonly batch: boolean;
  readonly batchMinThreads: number;
  readonly maxEntries?: number;
  /** How long to wait on another subscriber's read before reading it here. */
  readonly waitTimeout?: Duration.Input;
}) {
  type Entry = Deferred.Deferred<Exit.Exit<S | null, E>>;
  type Wait = { readonly threadId: Id; readonly key: string; readonly entry: Entry };
  let cache = cachesByOwner.get(options.owner);
  if (cache === undefined) {
    cache = new Map();
    cachesByOwner.set(options.owner, cache);
  }
  // One owner's entries all come from the same service, so they share S and E.
  const entries = cache as Map<string, Entry>;

  const readMisses = (misses: ReadonlyArray<Wait>): Effect.Effect<void, never, R1 | R2> => {
    const complete = (exit: Exit.Exit<ReadonlyArray<S | null>, E>) =>
      Effect.sync(() => {
        for (const [index, miss] of misses.entries()) {
          if (Exit.isFailure(exit) && entries.get(miss.key) === miss.entry) {
            entries.delete(miss.key);
          }
          Deferred.doneUnsafe(
            miss.entry,
            Effect.succeed(
              Exit.isSuccess(exit)
                ? Exit.succeed(exit.value[index] ?? null)
                : Exit.failCause(exit.cause),
            ),
          );
        }
      });
    // Built inside the reader so a read that throws while it is built still
    // completes the entries.
    const read = Effect.suspend((): Effect.Effect<ReadonlyArray<S | null>, E, R1 | R2> =>
      options.batch && misses.length >= options.batchMinThreads
        ? Effect.map(options.readMany(misses.map((miss) => miss.threadId)), (shells) =>
            misses.map((miss) => shells.get(miss.threadId) ?? null),
          )
        : Effect.forEach(misses, (miss) => options.readOne(miss.threadId), { concurrency: 8 }),
    );
    // onExit runs uninterruptibly, so an interrupted reader still completes.
    return read.pipe(Effect.onExit(complete), Effect.exit, Effect.asVoid);
  };

  // Claim and launch: no interruption between publishing an entry and starting
  // the reader that completes it.
  const waits = yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const waits: Array<Wait> = [];
      const misses: Array<Wait> = [];
      for (const { threadId, sequence } of options.wanted) {
        const key = `${threadId}\u0000${sequence}`;
        const existing = entries.get(key);
        if (existing !== undefined) {
          waits.push({ threadId, key, entry: existing });
          continue;
        }
        const entry = Deferred.makeUnsafe<Exit.Exit<S | null, E>>();
        entries.set(key, entry);
        const claim = { threadId, key, entry };
        misses.push(claim);
        waits.push(claim);
      }
      const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      if (misses.length > 0) {
        // The reader itself is interruptible (forkDetach's default).
        yield* Effect.forkDetach(readMisses(misses));
      }
      return waits;
    }),
  );

  // Interruptible waits, all against one deadline.
  const waitTimeout = options.waitTimeout ?? DEFAULT_WAIT_TIMEOUT;
  const settled = yield* Effect.forEach(
    waits,
    (wait) => Deferred.await(wait.entry).pipe(Effect.timeoutOption(waitTimeout)),
    { concurrency: "unbounded" },
  );
  const values: Array<S | null> = [];
  const stuck: Array<{ readonly index: number; readonly wait: Wait }> = [];
  for (const [index, wait] of waits.entries()) {
    const exit = settled[index] ?? Option.none();
    if (Option.isNone(exit)) {
      stuck.push({ index, wait });
      values.push(null);
      continue;
    }
    values.push(yield* exit.value);
  }
  if (stuck.length > 0) {
    for (const { wait } of stuck) {
      // Later subscribers start a fresh read instead of joining the stuck one.
      if (entries.get(wait.key) === wait.entry) entries.delete(wait.key);
    }
    yield* Effect.logWarning("shared shell read did not settle; reading here", {
      threads: stuck.length,
    });
    const own = yield* Effect.forEach(stuck, ({ wait }) => options.readOne(wait.threadId), {
      concurrency: FALLBACK_READ_CONCURRENCY,
    });
    for (const [i, { index }] of stuck.entries()) values[index] = own[i] ?? null;
  }
  const shells = new Map<Id, S | null>();
  for (const [index, wait] of waits.entries()) shells.set(wait.threadId, values[index] ?? null);
  return shells as ReadonlyMap<Id, S | null>;
});
