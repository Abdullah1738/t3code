import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { KanbanError } from "@t3tools/contracts";

// A board-wide writer excludes card writers; independent card writers share the gate.
const BOARD_PERMITS = 1_000_000;

interface BoardLock {
  readonly gate: Semaphore.Semaphore;
  readonly cards: Map<string, Semaphore.Semaphore>;
  readonly resources: Map<string, number>;
  generation: number;
  boardGeneration: number;
  readonly cardGenerations: Map<string, number>;
}

interface Held {
  readonly boardId: string;
  readonly board: BoardLock;
  readonly cardId: string | undefined;
  readonly mutex: Semaphore.Semaphore | undefined;
  readonly permits: number;
}

interface Operation {
  readonly fiberId: number;
  readonly cardId: string | undefined;
  held: Held | undefined;
  stale: boolean;
  committed: boolean;
  sideEffect: boolean;
  readonly dependencies: Map<string, Map<string, number>>;
  readonly parent: Operation | undefined;
  readonly abandoned: Map<string, Effect.Effect<void>>;
  /** Reads this operation made outside the gate, shared by its stale reruns (see `outsideRead`). */
  readonly replay: Map<string, Array<ReplayEntry>>;
  /** How many reads of each key this attempt has made so far. */
  readonly reads: Map<string, number>;
  replayed: number;
}

interface ReplayEntry {
  readonly value: unknown;
  readonly at: number;
  readonly fence: number;
}

const current = Context.Reference<Operation | undefined>("KanbanBoardOperation", {
  defaultValue: () => undefined,
});
const ancestor = Context.Reference<Operation | undefined>("KanbanParentOperation", {
  defaultValue: () => undefined,
});

export class BoardStateChanged {
  readonly _tag = "BoardStateChanged";
}

export const WRITE_WAIT_MS = 120_000;

const retryPolicy = Context.Reference("KanbanBoardRetryPolicy", {
  defaultValue: () => ({ reruns: 8, backoffMs: 0 }),
});

/**
 * A stale rerun may reuse a read its earlier attempt made outside the gate for
 * this long, when the read's fence has not moved (see `outsideRead`).
 */
export const REPLAY_MAX_MS = 30_000;

/** State locks are never held across another service's I/O. A stale continuation cannot write. */
export const make = Effect.fn("KanbanBoardLocks.make")(function* () {
  const boards = new Map<string, BoardLock>();
  // Only selection migration takes every permit; ordinary boards never exclude each other here.
  const migration = yield* Semaphore.make(BOARD_PERMITS);
  const boardOf = (id: string) => {
    let board = boards.get(id);
    if (!board) {
      board = {
        gate: Semaphore.makeUnsafe(BOARD_PERMITS),
        cards: new Map(),
        resources: new Map([["epoch", 0]]),
        generation: 0,
        boardGeneration: 0,
        cardGenerations: new Map(),
      };
      boards.set(id, board);
    }
    return board;
  };
  // Forks inherit Context, but not ownership of a parent's permit or optimistic snapshot.
  const operation = Effect.gen(function* () {
    const op = yield* current;
    return op?.fiberId === (yield* Effect.fiberId) ? op : undefined;
  });
  const check = (op: Operation) => (op.stale ? Effect.die(new BoardStateChanged()) : Effect.void);
  const wait = <A>(op: Operation, effect: Effect.Effect<A>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: WRITE_WAIT_MS,
        orElse: () =>
          Effect.die(
            new KanbanError({
              code: "conflict",
              detail: op.committed
                ? "Board changed while this operation was waiting. Re-read its state before retrying."
                : "Board busy: not written. Safe to retry once.",
            }),
          ),
      }),
    );
  const version = (held: Held) =>
    held.cardId === undefined
      ? held.board.generation
      : `${held.board.boardGeneration}:${held.board.cardGenerations.get(held.cardId) ?? 0}`;
  // Card versions contain two counters; retain them independently of wall-clock timestamps.
  const versions = new WeakMap<Operation, Map<string, number | string>>();
  const take = (op: Operation, semaphore: Semaphore.Semaphore, permits: number) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const started = performance.now();
        while (!(yield* semaphore.takeIfAvailable(permits))) {
          // withPermits owns cancellation cleanup while waiting. The actual transfer
          // happens masked, so an interrupt cannot land between take and ownership.
          yield* restore(
            Effect.interruptible(wait(op, semaphore.withPermits(permits)(Effect.void))),
          );
        }
        yield* Effect.annotateCurrentSpan("board.admission_wait_ms", performance.now() - started);
      }),
    );
  const release = Effect.fn("KanbanBoardLocks.release")(function* (op: Operation) {
    const held = op.held;
    if (!held) return;
    op.held = undefined;
    if (held.mutex) yield* held.mutex.release(1);
    yield* held.board.gate.release(held.permits);
    yield* migration.release(1);
  });
  const acquire = (op: Operation, boardId: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        yield* check(op);
        if (op.held?.boardId === boardId) return;
        yield* release(op);
        const board = boardOf(boardId);
        const cardId = op.cardId;
        let mutex: Semaphore.Semaphore | undefined;
        if (cardId !== undefined) {
          mutex = board.cards.get(cardId);
          if (!mutex) {
            mutex = Semaphore.makeUnsafe(1);
            board.cards.set(cardId, mutex);
          }
        }
        const permits = cardId === undefined ? BOARD_PERMITS : 1;
        yield* take(op, migration, 1);
        yield* take(op, board.gate, permits).pipe(Effect.onError(() => migration.release(1)));
        if (mutex)
          yield* take(op, mutex, 1).pipe(
            Effect.onError(() =>
              board.gate.release(permits).pipe(Effect.andThen(migration.release(1))),
            ),
          );
        const held: Held = { boardId, board, cardId, mutex, permits };
        op.held = held;
        const seen = versions.get(op)!;
        const expected = seen.get(boardId);
        if (expected !== undefined && expected !== version(held)) op.stale = true;
        for (const [key, value] of op.dependencies.get(boardId) ?? []) {
          if ((board.resources.get(key) ?? 0) !== value) op.stale = true;
        }
        if (expected !== undefined || !op.dependencies.has(boardId))
          seen.set(boardId, version(held));
        yield* check(op);
      }),
    );

  const run = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    cardId?: string,
    attempt = 0,
    // Only a stale rerun passes this in: every new execution starts with its own empty map.
    replayOf?: Map<string, Array<ReplayEntry>>,
    retry?: { readonly reruns: number; readonly backoffMs: number },
  ): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const parent = yield* operation;
        if (parent) return yield* restore(effect);
        const policy = retry ?? (yield* retryPolicy);
        const replay = replayOf ?? new Map<string, Array<ReplayEntry>>();
        const op: Operation = {
          fiberId: yield* Effect.fiberId,
          cardId,
          held: undefined,
          stale: false,
          committed: false,
          sideEffect: false,
          dependencies: new Map(),
          parent: yield* ancestor,
          abandoned: new Map(),
          replay,
          reads: new Map(),
          replayed: 0,
        };
        versions.set(op, new Map());
        if (attempt > 0) yield* Effect.annotateCurrentSpan("board.rerun_attempt", attempt);
        return yield* restore(effect).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              op.replayed > 0
                ? Effect.annotateCurrentSpan("board.replayed_reads", op.replayed)
                : Effect.void,
            ),
          ),
          Effect.tap(() => check(op)),
          Effect.provideService(current, op),
          Effect.ensuring(
            release(op).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  Effect.forEach(op.abandoned.values(), (cleanup) => cleanup, { discard: true }),
                ),
              ),
            ),
          ),
          Effect.catchDefect((defect) =>
            defect instanceof BoardStateChanged &&
            !op.committed &&
            !op.sideEffect &&
            attempt < policy.reruns
              ? restore(
                  policy.backoffMs > 0
                    ? Effect.sleep(policy.backoffMs * 2 ** attempt)
                    : Effect.void,
                ).pipe(Effect.andThen(run(effect, cardId, attempt + 1, replay, policy)))
              : Effect.die(defect),
          ),
        );
      }),
    );

  const access = <A, E, R>(
    boardId: string,
    effect: Effect.Effect<A, E, R>,
    write = false,
    resource?: string,
  ): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const op = yield* operation;
        if (!op)
          return yield* write ? run(access(boardId, effect, true, resource)) : restore(effect);
        // Row-scoped access does not subscribe to unrelated card writes.
        const previous = versions.get(op)!;
        const broad = previous.has(boardId);
        yield* acquire(op, boardId);
        if (resource === undefined) previous.set(boardId, version(op.held!));
        else if (!broad) previous.delete(boardId);
        if (resource !== undefined) {
          let dependencies = op.dependencies.get(boardId);
          if (!dependencies) op.dependencies.set(boardId, (dependencies = new Map()));
          if (!dependencies.has("epoch"))
            dependencies.set("epoch", boardOf(boardId).resources.get("epoch") ?? 0);
          if (!boardOf(boardId).resources.has(resource))
            boardOf(boardId).resources.set(resource, 0);
          if (!dependencies.has(resource))
            dependencies.set(resource, boardOf(boardId).resources.get(resource) ?? 0);
        }
        const result = yield* write ? effect : restore(effect);
        if (write) {
          op.committed = true;
          const held = op.held!;
          const parents: Array<readonly [Operation, boolean]> = [];
          for (let parent = op.parent; parent; parent = parent.parent) {
            parents.push([
              parent,
              versions.get(parent)!.get(boardId) === version({ ...held, cardId: parent.cardId }),
            ]);
          }
          held.board.generation += 1;
          if (held.cardId === undefined && (resource === undefined || resource === "board"))
            held.board.boardGeneration += 1;
          if (held.cardId === undefined && resource === undefined) {
            const epoch = (held.board.resources.get("epoch") ?? 0) + 1;
            held.board.resources.set("epoch", epoch);
            op.dependencies.get(boardId)?.set("epoch", epoch);
          }
          if (held.cardId !== undefined) {
            held.board.cardGenerations.set(
              held.cardId,
              (held.board.cardGenerations.get(held.cardId) ?? 0) + 1,
            );
          }
          if (resource !== undefined) {
            const value = (held.board.resources.get(resource) ?? 0) + 1;
            held.board.resources.set(resource, value);
            op.dependencies.get(boardId)!.set(resource, value);
            for (let parent = op.parent; parent; parent = parent.parent) {
              const dependencies = parent.dependencies.get(boardId);
              if (dependencies?.get(resource) === value - 1) dependencies.set(resource, value);
            }
          }
          if (resource === undefined || broad) versions.get(op)!.set(boardId, version(held));
          // Nested routing owns its commits, not concurrent writers' commits. Let its
          // caller continue only when those are the sole changes since it released.
          for (const [parent, unchanged] of parents) {
            const seen = versions.get(parent)!;
            if (unchanged) seen.set(boardId, version({ ...held, cardId: parent.cardId }));
            else if (seen.has(boardId)) parent.stale = true;
            parent.committed = true;
          }
        }
        return result;
      }),
    );

  const outside = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    abandoned?: (value: A) => Effect.Effect<void>,
    readOnly = false,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const op = yield* operation;
        if (!op) return yield* restore(effect);
        yield* check(op);
        const held = op.held;
        yield* release(op);
        // Even a failed call may already have sent/launched. Never advertise a later
        // permit timeout as "not written" after crossing an external boundary.
        if (!readOnly) {
          op.committed = true;
          op.sideEffect = true;
        }
        const result = yield* Effect.exit(restore(Effect.interruptible(effect)));
        // Re-acquire on failures too: a caller may catch one and continue changing state.
        if (held) {
          const resumed = yield* Effect.exit(acquire(op, held.boardId));
          if (Exit.isFailure(resumed)) {
            yield* release(op);
            if (Exit.isSuccess(result) && abandoned) yield* abandoned(result.value);
            return yield* Effect.failCause(resumed.cause);
          }
        }
        return yield* Exit.isSuccess(result)
          ? Effect.succeed(result.value)
          : Effect.failCause(result.cause);
      }),
    );

  /**
   * A read-only `outside` call that a stale rerun of the same operation can
   * replay. Reads cross outside the gate, so on a busy board some write lands
   * during almost every one; the operation then reran from the start and read
   * everything again, each read queueing seconds for the state reader, until it
   * gave up after 8 reruns (turn ends: 925 of 1,373 attempts in an hour).
   *
   * A rerun's n-th read of `key` returns the value its earlier attempt read for
   * that n-th call, without leaving the gate, while `fence()` still returns the
   * value it had when that read started and the read is younger than
   * `REPLAY_MAX_MS`. Callers bump the fence of whatever the read describes before
   * and after anything this process does to it (a send to the thread), so a
   * rerun never combines board state written after such a change with a read
   * taken before it. Changes made elsewhere (a run ending by itself) can land
   * right after any read anyway. The first attempt always reads.
   */
  const outsideRead = Effect.fn("KanbanBoardLocks.outsideRead")(function* <A, E, R>(
    key: string,
    fence: () => number,
    effect: Effect.Effect<A, E, R>,
  ) {
    const op = yield* operation;
    if (!op) return yield* effect;
    yield* check(op);
    const index = op.reads.get(key) ?? 0;
    op.reads.set(key, index + 1);
    const entry = op.replay.get(key)?.[index];
    if (
      entry !== undefined &&
      entry.fence === fence() &&
      performance.now() - entry.at < REPLAY_MAX_MS
    ) {
      op.replayed += 1;
      return entry.value as A;
    }
    const at = performance.now();
    const started = fence();
    // Recorded before the gate is taken back: that is where a stale attempt ends.
    return yield* outside(
      Effect.tap(effect, (value) =>
        Effect.sync(() => {
          let entries = op.replay.get(key);
          if (!entries) op.replay.set(key, (entries = []));
          entries[index] = { value, at, fence: started };
        }),
      ),
      undefined,
      true,
    );
  });

  return {
    run,
    step: <A, E, R>(effect: Effect.Effect<A, E, R>, cardId?: string) =>
      run(effect, cardId).pipe(Effect.provideService(retryPolicy, { reruns: 2, backoffMs: 10 })),
    access,
    outside,
    // Compensation must run without permits even after the snapshot became stale.
    unlock: Effect.flatMap(operation, (op) => (op ? release(op) : Effect.void)),
    outsideRead,
    launched: Effect.fn("KanbanBoardLocks.launched")(function* (
      id: string,
      cleanup: Effect.Effect<void>,
    ) {
      let op = yield* operation;
      if (!op) return;
      while (op.parent) op = op.parent;
      op.abandoned.set(id, cleanup);
    }),
    attached: Effect.fn("KanbanBoardLocks.attached")(function* (id: string) {
      let op = yield* operation;
      if (!op) return;
      while (op.parent) op = op.parent;
      op.abandoned.delete(id);
    }),
    observe: Effect.fn("KanbanBoardLocks.observe")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) {
      const op = yield* operation;
      if (op && op.cardId === undefined) {
        yield* check(op);
        for (const [id, board] of boards) {
          let dependencies = op.dependencies.get(id);
          if (!dependencies) op.dependencies.set(id, (dependencies = new Map()));
          if (!board.resources.has("board")) board.resources.set("board", 0);
          if (!dependencies.has("epoch"))
            dependencies.set("epoch", board.resources.get("epoch") ?? 0);
          if (!dependencies.has("board"))
            dependencies.set("board", board.resources.get("board") ?? 0);
        }
      }
      return yield* effect;
    }),
    board: <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) => run(access(id, effect)),
    fresh: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(current, (parent) =>
        effect.pipe(
          Effect.provideService(current, undefined),
          Effect.provideService(ancestor, parent),
        ),
      ),
    exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      migration.withPermits(BOARD_PERMITS)(
        effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              // Migration uses the raw store. In-flight I/O must not commit pre-migration models.
              for (const board of boards.values()) {
                board.generation += 1;
                board.boardGeneration += 1;
                for (const [key, value] of board.resources) board.resources.set(key, value + 1);
              }
            }),
          ),
        ),
      ),
  };
});
