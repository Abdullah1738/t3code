import { writeAdmitted } from "../../analytics/McpCall.ts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Metric from "effect/Metric";
import * as References from "effect/References";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as TickTimings from "./tickTimings.ts";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { KanbanError } from "@t3tools/contracts";

import * as SavedWrite from "./savedWrite.ts";
import * as Metrics from "../../../observability/Metrics.ts";

// A board-wide writer excludes card writers; independent card writers share the gate.
const BOARD_PERMITS = 1_000_000;
const LONG_HOLD_MS = SavedWrite.LONG_HOLD_MS;
const RELEASE_HISTORY_SIZE = 256;

const shortLabel = (label: string) => label.replace(/^KanbanService\.(?:tickStep:)?/, "");

export const operationName = Context.Reference<string | undefined>("KanbanBoardOperationName", {
  defaultValue: () => undefined,
});

interface Holder {
  readonly label: string;
  readonly boardId: string;
  readonly cardId: string | undefined;
  readonly fiberId: number;
  readonly lock: "migration" | "gate" | "card";
  readonly mode: "shared" | "exclusive";
  readonly acquiredAtMs: number;
}

interface BoardLock {
  waiters: number;
  readonly holders: Map<symbol, Holder>;
  readonly releasedHolds: Array<Holder & { readonly releasedAtMs: number }>;
  nextRelease: number;
  lastWarningAtMs: number;
  readonly gate: Semaphore.Semaphore;
  readonly cards: Map<string, Semaphore.Semaphore>;
  readonly resources: Map<string, number>;
  generation: number;
  boardGeneration: number;
  readonly cardGenerations: Map<string, number>;
}

interface Held {
  readonly acquiredAtMs: number;
  readonly boardId: string;
  readonly board: BoardLock;
  readonly cardId: string | undefined;
  readonly mutex: Semaphore.Semaphore | undefined;
  readonly permits: number;
  readonly releases: ReadonlyArray<Effect.Effect<void>>;
}

interface Operation {
  readonly label: string;
  diagnosticCardId: string | undefined;
  readonly fiberId: number;
  readonly cardId: string | undefined;
  held: Held | undefined;
  stale: boolean;
  committed: boolean;
  sideEffect: boolean;
  readonly dependencies: Map<string, Map<string, number>>;
  readonly parent: Operation | undefined;
  readonly abandoned: Map<string, Effect.Effect<void>>;
  readonly scopes: Map<
    string,
    { readonly resources: ReadonlyArray<string>; readonly valid: Effect.Effect<boolean> }
  >;
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
const dispatchMetadata = Context.Reference<boolean>("KanbanDispatchMetadata", {
  defaultValue: () => false,
});

export class BoardStateChanged {
  readonly _tag = "BoardStateChanged";
  readonly committed: boolean;
  constructor(committed = false) {
    this.committed = committed;
  }
}

// A budget miss gives the next writer a turn instead of immediately retrying the start.
export class DispatchReadBudgetExceeded extends BoardStateChanged {}
const DISPATCH_READ_HOLD_MS = 2_000;

export const MAY_HAVE_APPLIED =
  "Board changed after this call started work; it may have been applied. Check t3_thread_list / card_get before retrying.";

export const WRITE_WAIT_MS = 120_000;
export const writeWaitMs = Context.Reference("KanbanBoardWriteWaitMs", {
  defaultValue: () => WRITE_WAIT_MS,
});

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
  const migrationHolders = new Map<symbol, Holder>();
  const migrationHistory: Pick<BoardLock, "releasedHolds" | "nextRelease"> = {
    releasedHolds: [],
    nextRelease: 0,
  };
  let migrationWaiters = 0;
  const dispatches = new Set<Operation>();
  let migrationGeneration = 0;
  // Only selection migration takes every permit; ordinary boards never exclude each other here.
  const migration = yield* Semaphore.make(BOARD_PERMITS);
  const boardOf = (id: string) => {
    let board = boards.get(id);
    if (!board) {
      board = {
        waiters: 0,
        holders: new Map(),
        releasedHolds: [],
        nextRelease: 0,
        lastWarningAtMs: -Infinity,
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
  const check = (op: Operation) =>
    op.stale ? Effect.die(new BoardStateChanged(op.committed)) : Effect.void;
  // These helpers share the caller's operation span; the hot admission loop adds no spans.
  const label = Effect.map(Effect.option(Effect.currentSpan), (span) => {
    if (Option.isNone(span)) return "KanbanBoardLocks.run";
    const nearest = span.value;
    let cursor: import("effect/Tracer").AnySpan | undefined = nearest;
    while (cursor?._tag === "Span") {
      const tool = cursor.attributes.get("mcp.tool.name");
      if (typeof tool === "string") return tool;
      cursor = Option.getOrUndefined(cursor.parent);
    }
    const parent = Option.getOrUndefined(nearest.parent);
    return nearest.name === "KanbanService.serial"
      ? `${parent?._tag === "Span" ? parent.name : nearest.name} (${nearest.attributes.get("serial.queue") ?? "serial"})`
      : nearest.name;
  });
  const holdersAt = (now: number) =>
    [
      ...[...boards.values()].flatMap((board) => [...board.holders.values()]),
      ...[...migrationHolders.values()].filter((holder) => holder.mode === "exclusive"),
    ].map((holder) => ({
      ...holder,
      cardId: holder.cardId ?? null,
      heldForMs: Math.max(0, now - holder.acquiredAtMs),
    }));
  const waitingOn = (boardId: string, lock: Holder["lock"], cardId?: string) => ({
    boardId,
    lock,
    cardId,
  });
  type WaitingOn = ReturnType<typeof waitingOn>;
  const blockersAt = (target: WaitingOn, now: number) =>
    (target.lock === "migration"
      ? [...migrationHolders.values()]
      : [...boardOf(target.boardId).holders.values()].filter(
          (holder) =>
            holder.lock === target.lock &&
            (target.lock !== "card" || holder.cardId === target.cardId),
        )
    ).map((holder) => ({
      ...holder,
      cardId: holder.cardId ?? null,
      heldForMs: Math.max(0, now - holder.acquiredAtMs),
    }));
  const recordHold = Effect.fnUntraced(function* (
    holder: Holder,
    waiters: number,
    finish?: (long: boolean) => ReadonlyArray<SavedWrite.SubStep> | undefined,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const heldMs = Math.max(0, now - holder.acquiredAtMs);
    const subSteps = finish?.(heldMs >= LONG_HOLD_MS);
    yield* Metric.update(
      Metric.withAttributes(
        Metrics.kanbanBoardLockHoldDuration,
        Metrics.metricAttributes({ name: holder.label }),
      ),
      Duration.millis(heldMs),
    );
    if (heldMs < LONG_HOLD_MS) return;
    if (subSteps !== undefined) (yield* SavedWrite.subStepReporter)(subSteps);
    yield* Metrics.increment(Metrics.kanbanBoardLockLongHoldTotal, { name: holder.label });
    const fields = {
      "board.observed_at_ms": now,
      "board.id": holder.boardId,
      "board.holder": holder.label,
      "board.card_id": holder.cardId ?? null,
      "board.lock": holder.lock,
      "board.mode": holder.mode,
      "board.acquired_at_ms": holder.acquiredAtMs,
      "board.held_ms": heldMs,
      "board.waiters": waiters,
      ...(subSteps === undefined ? {} : { subSteps }),
    };
    yield* Effect.logWarning(
      // Fixed internal diagnostic fields; encoding must not add a failure to lock release.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      JSON.stringify({ event: "kanban board lock long hold", ...fields }),
    ).pipe(
      Effect.annotateLogs({ ...fields, "board.lock_log": true }),
      Effect.provideService(References.MinimumLogLevel, "Warn"),
    );
  }, Effect.ignoreCause());
  // Keep release bookkeeping constant-time; attribution is computed only for warnings.
  const recordRelease = (holder: Holder, releasedAtMs: number) => {
    if (holder.lock === "card" || (holder.lock === "migration" && holder.mode === "shared")) return;
    const board = holder.boardId === "*" ? migrationHistory : boardOf(holder.boardId);
    board.releasedHolds[board.nextRelease] = { ...holder, releasedAtMs };
    board.nextRelease = (board.nextRelease + 1) % RELEASE_HISTORY_SIZE;
  };
  const warning = Effect.fnUntraced(function* (
    op: Operation,
    target: WaitingOn,
    started: number,
    queueAheadAtAdmission: number,
    refused: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const blockers = blockersAt(target, now);
    const board = boardOf(target.boardId);
    const waitedMs = Math.max(0, now - started);
    const byLabel = new Map<
      string,
      { label: string; lock: Holder["lock"]; ms: number; holds: number }
    >();
    if (!refused) {
      if (
        !blockers.some((holder) => holder.heldForMs >= 60_000) ||
        now - board.lastWarningAtMs < 30_000
      )
        return { blockers, waitedMs, waitByLabel: [] };
      board.lastWarningAtMs = now;
    }
    const account = (holder: Holder, releasedAtMs: number) => {
      // Shared migration permits accompany gates, and would count the same time twice.
      // A card waiter also owns a shared gate already; it must not attribute time to itself.
      if (
        holder.fiberId === op.fiberId ||
        (target.lock === "migration"
          ? holder.lock !== "migration" || holder.mode !== "exclusive"
          : holder.lock !== "gate")
      )
        return;
      const ms = Math.max(0, Math.min(now, releasedAtMs) - Math.max(started, holder.acquiredAtMs));
      if (ms === 0) return;
      const label = shortLabel(holder.label);
      const key = `${holder.lock}:${label}`;
      const entry = byLabel.get(key) ?? { label, lock: holder.lock, ms: 0, holds: 0 };
      entry.ms += ms;
      entry.holds += 1;
      byLabel.set(key, entry);
    };
    const history =
      target.lock === "migration" ? migrationHistory.releasedHolds : board.releasedHolds;
    for (const holder of history) account(holder, holder.releasedAtMs);
    for (const holder of target.lock === "migration"
      ? migrationHolders.values()
      : board.holders.values())
      account(holder, now);
    const ranked = [...byLabel.values()].sort(
      (a, b) => b.ms - a.ms || a.label.localeCompare(b.label),
    );
    const waitByLabel = ranked.slice(0, 8);
    const fields = {
      "board.observed_at_ms": now,
      "board.waiter": op.label,
      "board.id": target.boardId,
      "board.card_id": op.diagnosticCardId ?? null,
      "board.waiter_fiber_id": op.fiberId,
      "board.waiting_on": target.lock,
      "board.waited_ms": Math.max(0, now - started),
      "board.queue_ahead_at_admission": queueAheadAtAdmission,
      "board.wait_by_label": waitByLabel,
      "board.wait_accounted_ms": ranked.reduce((sum, entry) => sum + entry.ms, 0),
      "board.waiters": target.lock === "migration" ? migrationWaiters : board.waiters,
      "board.holders": holdersAt(now).filter(
        (holder) =>
          target.lock === "migration" ||
          holder.boardId === target.boardId ||
          holder.boardId === "*",
      ),
      "board.blockers": blockers,
    };
    // Console pretty-printers truncate nested objects. Keep a complete JSON line
    // in the durable child log as well as structured annotations for OTLP.
    yield* Effect.logWarning(
      // Fixed internal diagnostic fields; encoding must not add a failure to lock admission.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      JSON.stringify({
        event: refused ? "kanban board write refused" : "kanban board lock held too long",
        ...fields,
      }),
    ).pipe(
      Effect.annotateLogs({ ...fields, "board.lock_log": true }),
      Effect.provideService(References.MinimumLogLevel, "Warn"),
    );
    if (refused)
      yield* Metrics.increment(Metrics.kanbanBoardBusyRefusedTotal, { refused: op.label });
    return { blockers, waitedMs, waitByLabel };
  });
  const wait = <A>(
    op: Operation,
    target: WaitingOn,
    started: number,
    queueAheadAtAdmission: number,
    effect: Effect.Effect<A>,
  ) =>
    Effect.flatMap(writeWaitMs, (duration) =>
      effect.pipe(
        // Only contended admissions start this monitor; it dies with the waiter.
        Effect.raceFirst(
          Effect.forever(
            warning(op, target, started, queueAheadAtAdmission, false).pipe(
              Effect.andThen(Effect.sleep(30_000)),
            ),
          ),
        ),
        Effect.timeoutOrElse({
          duration,
          orElse: Effect.fnUntraced(function* () {
            const { blockers, waitedMs, waitByLabel } = yield* warning(
              op,
              target,
              started,
              queueAheadAtAdmission,
              true,
            );
            const oldest = blockers.sort((a, b) => b.heldForMs - a.heldForMs)[0];
            const seconds = Math.floor((oldest?.heldForMs ?? 0) / 1_000);
            const heldFor = `${Math.floor(seconds / 60)}m${seconds % 60}s`;
            const summary =
              waitByLabel.length > 0
                ? ` (waited ${Math.floor(waitedMs / 1_000)}s behind ${queueAheadAtAdmission}; most time: ${waitByLabel
                    .slice(0, 3)
                    .map((entry) => `${entry.label} ${Math.floor(entry.ms / 1_000)}s`)
                    .join(", ")})`
                : oldest
                  ? ` (held ${heldFor} by ${oldest.label}${blockers.length > 1 ? ` +${blockers.length - 1} more` : ""})`
                  : " (holder released at deadline)";
            return yield* Effect.die(
              new KanbanError({
                code: "conflict",
                reasonClass: "board_busy",
                saved: op.committed ? null : false,
                detail: op.committed
                  ? MAY_HAVE_APPLIED
                  : `Board busy: not written${summary}. Safe to retry once.`,
              }),
            );
          }),
        }),
      ),
    );
  const version = (held: Held) =>
    held.cardId === undefined
      ? held.board.generation
      : `${held.board.boardGeneration}:${held.board.cardGenerations.get(held.cardId) ?? 0}`;
  // Card versions contain two counters; retain them independently of wall-clock timestamps.
  const versions = new WeakMap<Operation, Map<string, number | string>>();
  const take = (
    op: Operation,
    semaphore: Semaphore.Semaphore,
    permits: number,
    target: WaitingOn,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const board = boardOf(target.boardId);
        const queueAheadAtAdmission =
          target.lock === "migration" ? migrationWaiters : board.waiters;
        board.waiters += 1;
        if (target.lock === "migration") migrationWaiters += 1;
        return Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          while (!(yield* semaphore.takeIfAvailable(permits))) {
            // withPermits owns cancellation cleanup while waiting. The actual transfer
            // happens masked, so an interrupt cannot land between take and ownership.
            yield* restore(
              Effect.interruptible(
                TickTimings.measure(
                  "queue_wait",
                  wait(
                    op,
                    target,
                    started,
                    queueAheadAtAdmission,
                    semaphore.withPermits(permits)(Effect.void),
                  ),
                ),
              ),
            );
          }
          const acquiredAtMs = yield* Clock.currentTimeMillis;
          const token = Symbol();
          const holder: Holder = {
            ...target,
            cardId: op.diagnosticCardId,
            label: op.label,
            fiberId: op.fiberId,
            acquiredAtMs,
            mode: permits === BOARD_PERMITS || target.lock === "card" ? "exclusive" : "shared",
          };
          board.holders.set(token, holder);
          if (target.lock === "migration") migrationHolders.set(token, holder);
          yield* Effect.annotateCurrentSpan("board.admission_wait_ms", acquiredAtMs - started);
          const release = Effect.gen(function* () {
            const releasedAtMs = yield* Clock.currentTimeMillis;
            board.holders.delete(token);
            migrationHolders.delete(token);
            recordRelease(holder, releasedAtMs);
            if (holder.lock === "gate")
              yield* Metric.update(
                Metric.withAttributes(Metrics.kanbanBoardGateHoldMs, {
                  label: shortLabel(holder.label),
                }),
                Math.max(0, releasedAtMs - holder.acquiredAtMs),
              ).pipe(Effect.ignoreCause());
          }).pipe(Effect.andThen(semaphore.release(permits)), Effect.asVoid);
          // Record once for the most specific permit, before releasing it. The
          // existing release path owns all holder cleanup and permit ordering.
          const primary =
            target.lock === "card" || (target.lock === "gate" && op.cardId === undefined);
          const finish = primary
            ? (yield* SavedWrite.subStepObserver)?.hold(op.fiberId)
            : undefined;
          return primary
            ? Effect.suspend(() => recordHold(holder, board.waiters, finish)).pipe(
                Effect.andThen(release),
              )
            : release;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              board.waiters -= 1;
              if (target.lock === "migration") migrationWaiters -= 1;
            }),
          ),
        );
      }),
    );
  // Shares the caller's span: this check runs on every scoped dispatch read.
  const dispatchRead = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    const op = yield* operation;
    const held = op?.held;
    if (!op || !held || !op.scopes.has(held.boardId)) return yield* effect;
    const remaining = held.acquiredAtMs + DISPATCH_READ_HOLD_MS - (yield* Clock.currentTimeMillis);
    const result =
      remaining <= 0
        ? Option.none<A>()
        : yield* effect.pipe(Effect.interruptible, Effect.timeoutOption(remaining));
    if (Option.isSome(result)) return result.value;
    op.stale = true;
    return yield* Effect.die(new DispatchReadBudgetExceeded(op.committed));
  });

  const release = Effect.fn("KanbanBoardLocks.release")(function* (op: Operation) {
    const held = op.held;
    if (!held) return;
    op.held = undefined;
    yield* Effect.forEach(held.releases.toReversed(), (release) => release, { discard: true });
  }, Effect.uninterruptible);
  const acquire = (op: Operation, boardId: string, reconcile = false) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (reconcile && !op.scopes.has(boardId)) op.stale = false;
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
        const releases: Array<Effect.Effect<void>> = [];
        yield* Effect.gen(function* () {
          releases.push(yield* take(op, migration, 1, waitingOn(boardId, "migration", cardId)));
          releases.push(yield* take(op, board.gate, permits, waitingOn(boardId, "gate", cardId)));
          if (mutex) releases.push(yield* take(op, mutex, 1, waitingOn(boardId, "card", cardId)));
        }).pipe(
          Effect.onError(() =>
            Effect.forEach(releases.toReversed(), (release) => release, { discard: true }),
          ),
        );
        const held: Held = {
          boardId,
          board,
          cardId,
          mutex,
          permits,
          releases,
          acquiredAtMs: yield* Clock.currentTimeMillis,
        };
        op.held = held;
        yield* writeAdmitted();
        const seen = versions.get(op)!;
        const expected = seen.get(boardId);
        const scoped = op.scopes.get(boardId);
        if (scoped || !reconcile) {
          if (!scoped && expected !== undefined && expected !== version(held)) op.stale = true;
          for (const [key, value] of op.dependencies.get(boardId) ?? []) {
            if ((board.resources.get(key) ?? 0) !== value) op.stale = true;
          }
        } else {
          // The explicit continuation validates its inputs under this new snapshot.
          op.dependencies.delete(boardId);
        }
        if (scoped && !(yield* dispatchRead(scoped.valid))) op.stale = true;
        if (!scoped && (expected !== undefined || !op.dependencies.has(boardId)))
          seen.set(boardId, version(held));
        yield* check(op);
      }),
    ).pipe((effect) => SavedWrite.stage(effect, "admission"));

  const run = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    cardId?: string,
    attempt = 0,
    // Only a stale rerun passes this in: every new execution starts with its own empty map.
    replayOf?: Map<string, Array<ReplayEntry>>,
    retry?: { readonly reruns: number; readonly backoffMs: number },
    operationLabel?: string,
  ): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const parent = yield* operation;
        if (parent) return yield* restore(effect);
        const policy = retry ?? (yield* retryPolicy);
        const replay = replayOf ?? new Map<string, Array<ReplayEntry>>();
        const op: Operation = {
          label: operationLabel ?? (yield* operationName) ?? (yield* label),
          fiberId: yield* Effect.fiberId,
          cardId,
          diagnosticCardId: cardId,
          held: undefined,
          stale: false,
          committed: false,
          sideEffect: false,
          dependencies: new Map(),
          parent: yield* ancestor,
          abandoned: new Map(),
          scopes: new Map(),
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
              Effect.andThen(Effect.sync(() => dispatches.delete(op))),
              Effect.andThen(
                Effect.suspend(() =>
                  Effect.forEach(op.abandoned.values(), (cleanup) => cleanup, { discard: true }),
                ),
              ),
            ),
          ),
          Effect.catchCause((cause) => {
            const defect = cause.reasons.find((reason) => reason._tag === "Die")?.defect;
            return defect instanceof BoardStateChanged &&
              !(defect instanceof DispatchReadBudgetExceeded) &&
              !defect.committed &&
              !op.committed &&
              !op.sideEffect &&
              attempt < policy.reruns
              ? restore(
                  policy.backoffMs > 0
                    ? Effect.sleep(policy.backoffMs * 2 ** attempt)
                    : Effect.void,
                ).pipe(Effect.andThen(run(effect, cardId, attempt + 1, replay, policy, op.label)))
              : Effect.failCause(cause);
          }),
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
        if (resource?.startsWith("card:")) op.diagnosticCardId ??= resource.slice(5);
        // Row-scoped access does not subscribe to unrelated card writes.
        const previous = versions.get(op)!;
        const broad = previous.has(boardId);
        yield* acquire(op, boardId);
        const scoped = op.scopes.get(boardId);
        if (resource === undefined && !scoped) previous.set(boardId, version(op.held!));
        else if (!broad) previous.delete(boardId);
        if (resource !== undefined && (!scoped || scoped.resources.includes(resource))) {
          let dependencies = op.dependencies.get(boardId);
          if (!dependencies) op.dependencies.set(boardId, (dependencies = new Map()));
          if (!scoped && !dependencies.has("epoch"))
            dependencies.set("epoch", boardOf(boardId).resources.get("epoch") ?? 0);
          if (!boardOf(boardId).resources.has(resource))
            boardOf(boardId).resources.set(resource, 0);
          if (!dependencies.has(resource))
            dependencies.set(resource, boardOf(boardId).resources.get(resource) ?? 0);
        }
        // Mark before entering masked SQL: a timeout must not promise a safe retry
        // while a transaction or its cleanup can still apply the write.
        const result = yield* write
          ? SavedWrite.stage(SavedWrite.committing.pipe(Effect.andThen(effect)), "commit")
          : restore(dispatchRead(effect));
        if (write) {
          yield* SavedWrite.committed();
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
            // A link-state refresh must not forgive an earlier content write or migration.
            if (yield* dispatchMetadata) {
              for (const dispatch of dispatches) {
                if (!dispatch.scopes.get(boardId)?.resources.includes(resource)) continue;
                const dependencies = dispatch.dependencies.get(boardId);
                if (dependencies?.get(resource) === value - 1) dependencies.set(resource, value);
              }
            }
            if (!scoped || scoped.resources.includes(resource))
              op.dependencies.get(boardId)!.set(resource, value);
            for (let parent = op.parent; parent; parent = parent.parent) {
              const dependencies = parent.dependencies.get(boardId);
              if (dependencies?.get(resource) === value - 1) dependencies.set(resource, value);
            }
          }
          if (!scoped && (resource === undefined || broad))
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
    readOnly = false,
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
        if (!readOnly) {
          op.committed = true;
          op.sideEffect = true;
        }
        const external = restore(Effect.interruptible(effect));
        const result = yield* Effect.exit(
          SavedWrite.stage(
            readOnly ? external : SavedWrite.committing.pipe(Effect.andThen(external)),
            readOnly ? "read" : "commit",
          ),
        );
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
    holders: Effect.map(Clock.currentTimeMillis, holdersAt),
    run,
    // Dispatch alone replaces its planning snapshot with the card and slot it will take.
    // Collection reads inside that dispatch must not silently restore a board-wide dependency.
    scopeDispatch: Effect.fn("KanbanBoardLocks.scopeDispatch")(function* (
      boardId: string,
      resources: ReadonlyArray<string>,
      valid: Effect.Effect<boolean>,
    ) {
      const op = yield* operation;
      if (!op) return;
      yield* acquire(op, boardId);
      const board = boardOf(boardId);
      op.scopes.set(boardId, { resources, valid });
      dispatches.add(op);
      versions.get(op)!.delete(boardId);
      op.dependencies.set(
        boardId,
        new Map(
          resources.map((key) => {
            if (!board.resources.has(key)) board.resources.set(key, 0);
            return [key, board.resources.get(key)!];
          }),
        ),
      );
      if (!(yield* dispatchRead(valid))) {
        op.stale = true;
        yield* check(op);
      }
    }),
    resourceVersion: (boardId: string, resource: string) =>
      access(
        boardId,
        Effect.sync(() => boardOf(boardId).resources.get(resource) ?? 0),
        false,
        resource,
      ),
    // Only the metadata persistence is marked; publication and its follow-ups keep normal conflicts.
    dispatchMetadata: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(dispatchMetadata, true)),
    step: <A, E, R>(effect: Effect.Effect<A, E, R>, cardId?: string, operationLabel?: string) =>
      run(effect, cardId, 0, undefined, undefined, operationLabel).pipe(
        Effect.provideService(retryPolicy, { reruns: 2, backoffMs: 10 }),
      ),
    access,
    outside,
    // Compensation must run without permits even after the snapshot became stale.
    unlock: Effect.flatMap(operation, (op) => (op ? release(op) : Effect.void)),
    outsideRead,
    // Lock-location lookups must share the start's read budget too.
    dispatchRead,
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
    // Detached work owns compensation even after the request that forked it ends.
    independent: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(current, undefined),
        Effect.provideService(ancestor, undefined),
      ),
    fresh: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(current, (parent) =>
        effect.pipe(
          Effect.provideService(current, undefined),
          Effect.provideService(ancestor, parent),
        ),
      ),
    exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Migration owns all boards, including boards first seen while it is running.
          const token = Symbol();
          const holder: Holder = {
            label: (yield* operationName) ?? (yield* label),
            boardId: "*",
            cardId: undefined,
            fiberId: yield* Effect.fiberId,
            lock: "migration",
            mode: "exclusive",
            acquiredAtMs: 0,
          };
          return yield* restore(
            migration.withPermits(BOARD_PERMITS)(
              Effect.gen(function* () {
                const acquired = { ...holder, acquiredAtMs: yield* Clock.currentTimeMillis };
                migrationHolders.set(token, acquired);
                return yield* effect;
              }).pipe(
                Effect.ensuring(
                  Effect.suspend(() => {
                    const holder = migrationHolders.get(token);
                    return holder === undefined
                      ? Effect.void
                      : recordHold(holder, migrationWaiters);
                  }).pipe(
                    Effect.andThen(
                      Effect.gen(function* () {
                        const releasedAtMs = yield* Clock.currentTimeMillis;
                        const holder = migrationHolders.get(token);
                        migrationHolders.delete(token);
                        if (holder) recordRelease(holder, releasedAtMs);
                        migrationGeneration += 1;
                        for (const board of boards.values()) {
                          board.generation += 1;
                          board.boardGeneration += 1;
                          for (const [key, value] of board.resources)
                            board.resources.set(key, value + 1);
                        }
                      }),
                    ),
                  ),
                ),
              ),
            ),
          );
        }),
      ),
  };
});
