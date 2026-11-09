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
  readonly parent: Operation | undefined;
  readonly abandoned: Map<string, Effect.Effect<void>>;
}

const current = Context.Reference<Operation | undefined>("KanbanBoardOperation", {
  defaultValue: () => undefined,
});
const ancestor = Context.Reference<Operation | undefined>("KanbanParentOperation", {
  defaultValue: () => undefined,
});

export class BoardStateChanged {
  readonly _tag = "BoardStateChanged";
  readonly committed: boolean;
  constructor(committed: boolean) {
    this.committed = committed;
  }
}

export const MAY_HAVE_APPLIED =
  "Board changed after this call started work; it may have been applied. Check t3_thread_list / card_get before retrying.";

export const WRITE_WAIT_MS = 120_000;

/** State locks are never held across another service's I/O. A stale continuation cannot write. */
export const make = Effect.fn("KanbanBoardLocks.make")(function* () {
  const boards = new Map<string, BoardLock>();
  let migrationGeneration = 0;
  // Only selection migration takes every permit; ordinary boards never exclude each other here.
  const migration = yield* Semaphore.make(BOARD_PERMITS);
  const boardOf = (id: string) => {
    let board = boards.get(id);
    if (!board) {
      board = {
        gate: Semaphore.makeUnsafe(BOARD_PERMITS),
        cards: new Map(),
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
  const check = (op: Operation) =>
    op.stale ? Effect.die(new BoardStateChanged(op.committed)) : Effect.void;
  const wait = <A>(op: Operation, effect: Effect.Effect<A>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: WRITE_WAIT_MS,
        orElse: () =>
          Effect.die(
            new KanbanError({
              code: "conflict",
              detail: op.committed
                ? MAY_HAVE_APPLIED
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
        while (!(yield* semaphore.takeIfAvailable(permits))) {
          // withPermits owns cancellation cleanup while waiting. The actual transfer
          // happens masked, so an interrupt cannot land between take and ownership.
          yield* restore(
            Effect.interruptible(wait(op, semaphore.withPermits(permits)(Effect.void))),
          );
        }
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
  const acquire = (op: Operation, boardId: string, reconcile = false) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (reconcile) op.stale = false;
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
        if (!reconcile && expected !== undefined && expected !== version(held)) op.stale = true;
        seen.set(boardId, version(held));
        yield* check(op);
      }),
    );

  const run = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    cardId?: string,
    retry = false,
  ): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const parent = yield* operation;
        if (parent) return yield* restore(effect);
        const op: Operation = {
          fiberId: yield* Effect.fiberId,
          cardId,
          held: undefined,
          stale: false,
          committed: false,
          parent: yield* ancestor,
          abandoned: new Map(),
        };
        versions.set(op, new Map());
        return yield* restore(effect).pipe(
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
            retry && defect instanceof BoardStateChanged && !defect.committed && !op.committed
              ? Effect.logInfo("kanban retrying uncommitted board conflict", { cardId }).pipe(
                  Effect.andThen(run(effect, cardId)),
                )
              : Effect.die(defect),
          ),
        );
      }),
    );

  const access = <A, E, R>(
    boardId: string,
    effect: Effect.Effect<A, E, R>,
    write = false,
  ): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const op = yield* operation;
        if (!op) return yield* write ? run(access(boardId, effect, true)) : restore(effect);
        yield* acquire(op, boardId);
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
          if (held.cardId === undefined) held.board.boardGeneration += 1;
          else {
            held.board.cardGenerations.set(
              held.cardId,
              (held.board.cardGenerations.get(held.cardId) ?? 0) + 1,
            );
          }
          versions.get(op)!.set(boardId, version(held));
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

  const outside = <A, E, R, E2 = never, R2 = never>(
    effect: Effect.Effect<A, E, R>,
    abandoned?: (value: A) => Effect.Effect<void>,
    reconcile?: Effect.Effect<boolean, E2, R2>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const op = yield* operation;
        if (!op) return yield* restore(effect);
        yield* check(op);
        const held = op.held;
        const migrationBefore = migrationGeneration;
        yield* release(op);
        // Even a failed call may already have sent/launched. Never advertise a later
        // permit timeout as "not written" after crossing an external boundary.
        op.committed = true;
        const result = yield* Effect.exit(restore(Effect.interruptible(effect)));
        // Re-acquire on failures too: a caller may catch one and continue changing state.
        if (held) {
          const resumed = yield* Effect.exit(
            acquire(
              op,
              held.boardId,
              reconcile !== undefined &&
                Exit.isSuccess(result) &&
                migrationBefore === migrationGeneration,
            ).pipe(
              Effect.andThen(() => {
                if (migrationBefore !== migrationGeneration) {
                  op.stale = true;
                  return check(op);
                }
                return reconcile === undefined
                  ? Effect.void
                  : reconcile.pipe(
                      Effect.flatMap((valid) => {
                        if (!valid) op.stale = true;
                        return check(op);
                      }),
                    );
              }),
            ),
          );
          if (Exit.isFailure(resumed)) {
            op.stale = true;
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

  return {
    run,
    access,
    outside,
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
        const seen = versions.get(op)!;
        for (const [id, board] of boards) if (!seen.has(id)) seen.set(id, board.generation);
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
              migrationGeneration += 1;
              for (const board of boards.values()) {
                board.generation += 1;
                board.boardGeneration += 1;
              }
            }),
          ),
        ),
      ),
  };
});
