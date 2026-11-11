import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

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
 * - The read runs detached: a subscriber that disconnects mid-read does not
 *   interrupt the read other subscribers are waiting on.
 * - A failed read is not cached; its waiters get the failure and the next
 *   batch reads again.
 * - Entries are kept per owner (the server's ThreadManagementService) and the
 *   oldest are dropped past `maxEntries`.
 */
const DEFAULT_MAX_ENTRIES = 4_096;

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
}) {
  type Entry = Deferred.Deferred<Exit.Exit<S | null, E>>;
  let cache = cachesByOwner.get(options.owner);
  if (cache === undefined) {
    cache = new Map();
    cachesByOwner.set(options.owner, cache);
  }
  // One owner's entries all come from the same service, so they share S and E.
  const entries = cache as Map<string, Entry>;
  const waits: Array<readonly [Id, Entry]> = [];
  const misses: Array<{ readonly threadId: Id; readonly key: string; readonly entry: Entry }> = [];
  for (const { threadId, sequence } of options.wanted) {
    const key = `${threadId}\u0000${sequence}`;
    const existing = entries.get(key);
    if (existing !== undefined) {
      waits.push([threadId, existing]);
      continue;
    }
    const entry = yield* Deferred.make<Exit.Exit<S | null, E>>();
    entries.set(key, entry);
    misses.push({ threadId, key, entry });
    waits.push([threadId, entry]);
  }
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  while (entries.size > maxEntries) {
    const oldest = entries.keys().next();
    if (oldest.done === true) break;
    entries.delete(oldest.value);
  }

  if (misses.length > 0) {
    const read: Effect.Effect<ReadonlyArray<S | null>, E, R1 | R2> =
      options.batch && misses.length >= options.batchMinThreads
        ? Effect.map(options.readMany(misses.map((miss) => miss.threadId)), (shells) =>
            misses.map((miss) => shells.get(miss.threadId) ?? null),
          )
        : Effect.forEach(misses, (miss) => options.readOne(miss.threadId), { concurrency: 8 });
    yield* read.pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.forEach(
          misses,
          (miss, index) => {
            if (Exit.isFailure(exit) && entries.get(miss.key) === miss.entry) {
              entries.delete(miss.key);
            }
            return Deferred.succeed(
              miss.entry,
              Exit.isSuccess(exit)
                ? Exit.succeed(exit.value[index] ?? null)
                : Exit.failCause(exit.cause),
            );
          },
          { discard: true },
        ),
      ),
      Effect.forkDetach,
    );
  }

  const shells = new Map<Id, S | null>();
  for (const [threadId, entry] of waits) {
    shells.set(threadId, yield* yield* Deferred.await(entry));
  }
  return shells as ReadonlyMap<Id, S | null>;
});
