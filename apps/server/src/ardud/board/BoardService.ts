import {
  ArdudBoardEntry,
  ThreadId,
  type ArdudBoardClearInput,
  type ArdudBoardClearResult,
  type ArdudBoardDelta,
  type ArdudBoardSnapshot,
  type ArdudBoardToken,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../../persistence/Services/OrchestrationEventStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  BoardModel,
  decideAction,
  type BoardAction,
  type BoardRow,
  type Observation,
} from "./BoardModel.ts";
import * as BoardStore from "./BoardStore.ts";
import { observationFromShell } from "./shellObservation.ts";

export class BoardConflictError extends Schema.TaggedError<BoardConflictError>()(
  "BoardConflictError",
  {
    threadId: Schema.String,
    reason: Schema.Literals(["stale", "running", "not-restorable"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "running":
        return "This thread is still running.";
      case "not-restorable":
        return "This card cannot be restored.";
      default:
        return "This card changed. Refresh and try again.";
    }
  }
}

export class BoardUnavailableError extends Schema.TaggedError<BoardUnavailableError>()(
  "BoardUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The session board is unavailable.";
  }
}

export type BoardEvent =
  | { readonly kind: "snapshot"; readonly snapshot: ArdudBoardSnapshot }
  | { readonly kind: "delta"; readonly delta: ArdudBoardDelta };

export class BoardService extends Context.Service<
  BoardService,
  {
    readonly snapshot: Effect.Effect<ArdudBoardSnapshot>;
    /** The current snapshot, then one small delta per change. */
    readonly events: Stream.Stream<BoardEvent>;
    readonly act: (
      action: BoardAction,
      token: ArdudBoardToken,
    ) => Effect.Effect<ArdudBoardSnapshot, BoardConflictError | BoardUnavailableError>;
    /** Completes the exact cards the user saw in one lane, skipping any that changed. */
    readonly clearLane: (
      input: ArdudBoardClearInput,
    ) => Effect.Effect<ArdudBoardClearResult, BoardUnavailableError>;
    /** Re-reads every tracked and active thread; runs on startup. */
    readonly reconcile: Effect.Effect<ArdudBoardSnapshot, BoardUnavailableError>;
    /** Re-reads one thread now (also used after origin changes). */
    readonly refreshThread: (threadId: string) => Effect.Effect<void, BoardUnavailableError>;
    /** Replaces rows wholesale (OpenChamber import). Keeps rows already ahead of the import. */
    readonly importRows: (
      rows: ReadonlyArray<BoardRow>,
    ) => Effect.Effect<number, BoardUnavailableError>;
    readonly rows: Effect.Effect<ReadonlyMap<string, BoardRow>>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/ardud/board/BoardService") {}

// Entries are compared by their encoded form to find what changed.
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(ArdudBoardEntry));

const make = Effect.gen(function* () {
  const store = yield* BoardStore.BoardStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

  const loaded = yield* store.load.pipe(Effect.orDie);
  const clock = yield* Clock.Clock;
  const model = new BoardModel({
    activatedAt: loaded.meta.activatedAt,
    now: () => clock.currentTimeMillisUnsafe(),
  });
  for (const row of loaded.rows) model.rows.set(row.threadId, row);
  for (const [threadId, origin] of yield* store.origins().pipe(Effect.orDie)) {
    model.origins.set(threadId, origin);
  }
  let revision = loaded.meta.revision;
  let syncError: string | null = "Session board is reconciling.";
  let lastEntries = new Map<ThreadId, string>();
  const lock = yield* Semaphore.make(1);
  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);
  const events = yield* PubSub.unbounded<BoardEvent>();

  const snapshotNow = (): ArdudBoardSnapshot => ({
    version: 1,
    revision,
    activatedAt: model.activatedAt,
    entries: model.entries(),
    syncError,
  });

  const rememberEntries = (entries: ReadonlyArray<ArdudBoardEntry>) => {
    lastEntries = new Map(entries.map((entry) => [entry.threadId, encodeEntry(entry)]));
  };
  rememberEntries(model.entries());

  /** Diffs the board against what clients last saw and publishes only the changes. */
  const publish = Effect.suspend(() => {
    const entries = model.entries();
    const next = new Map(entries.map((entry) => [entry.threadId, encodeEntry(entry)]));
    const upserts = entries.filter(
      (entry) => lastEntries.get(entry.threadId) !== next.get(entry.threadId),
    );
    const removed = [...lastEntries.keys()].filter((id) => !next.has(id));
    lastEntries = next;
    if (upserts.length === 0 && removed.length === 0) return Effect.void;
    return PubSub.publish(events, {
      kind: "delta",
      delta: { revision, upserts, removed, syncError },
    }).pipe(Effect.asVoid);
  });

  const persist = (rows: ReadonlyArray<BoardRow>) =>
    rows.length === 0
      ? Effect.void
      : store.save(rows, revision + 1).pipe(
          Effect.tap(() => Effect.sync(() => (revision += 1))),
          Effect.mapError((cause) => new BoardUnavailableError({ cause })),
        );

  const readShell = (threadId: string) =>
    threads.getThreadShell(ThreadId.make(threadId)).pipe(
      Effect.map((shell) => observationFromShell(shell, threadId)),
      Effect.mapError((cause) => new BoardUnavailableError({ cause })),
    );

  /** Applies observations; call under the lock. */
  const applyObservations = (observations: ReadonlyArray<Observation>) =>
    Effect.gen(function* () {
      const patches = observations.map((observation) => ({
        observation,
        patch: model.observe(observation),
      }));
      // New work whose prompt may have come from a scheduled task.
      const creating = patches
        .filter(({ patch }) => {
          const row = patch.rows[0];
          return (
            row !== undefined &&
            !row.scheduled &&
            (patch.creates || row.promptAt !== model.rows.get(row.threadId)?.promptAt)
          );
        })
        .map(({ observation }) => observation.threadId);
      const scheduled =
        creating.length === 0
          ? new Set<string>()
          : yield* store
              .scheduledThreads(creating)
              .pipe(Effect.mapError((cause) => new BoardUnavailableError({ cause })));
      const final = patches.map(({ observation, patch }) =>
        scheduled.has(observation.threadId) && observation.deleted !== true
          ? model.observe({ ...observation, scheduledHint: true })
          : patch,
      );
      yield* persist(final.flatMap((patch) => patch.rows));
      for (const patch of final) model.commit(patch);
    });

  const observeThreads = (threadIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const observations = yield* Effect.forEach(threadIds, readShell, { concurrency: 8 });
      // Origins are written by other services (bridges, crw) around thread
      // creation, so re-read them for every thread in the batch and its lineage.
      const lineage = new Set<string>();
      for (const observation of observations) {
        lineage.add(observation.threadId);
        if (observation.deleted !== true) {
          lineage.add(observation.rootId);
          if (observation.parentId !== null) lineage.add(observation.parentId);
        }
      }
      const origins = yield* store
        .origins([...lineage])
        .pipe(Effect.mapError((cause) => new BoardUnavailableError({ cause })));
      yield* serialized(
        Effect.gen(function* () {
          for (const threadId of lineage) {
            const origin = origins.get(threadId);
            if (origin === undefined) model.origins.delete(threadId);
            else model.origins.set(threadId, origin);
          }
          yield* applyObservations(observations);
          yield* publish;
        }),
      );
    });

  const refreshThread = (threadId: string) => observeThreads([threadId]);

  const reconcile = Effect.gen(function* () {
    const shells = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.mapError((cause) => new BoardUnavailableError({ cause })));
    const origins = yield* store
      .origins()
      .pipe(Effect.mapError((cause) => new BoardUnavailableError({ cause })));
    const listed = new Set(shells.threads.map((shell) => shell.id as string));
    const tracked = [...model.rows.values()]
      .filter((row) => !row.deleted && !listed.has(row.threadId))
      .filter((row) => row.pending || row.backlog || (row.scheduled && !row.reviewed))
      .map((row) => row.threadId);
    // Archived or older tracked cards are not in the active shell list; read them by id.
    const extra = yield* Effect.forEach(tracked, readShell, { concurrency: 8 });
    yield* serialized(
      Effect.gen(function* () {
        model.origins.clear();
        for (const [threadId, origin] of origins) model.origins.set(threadId, origin);
        const observations: Observation[] = [
          ...shells.threads.map((shell) => observationFromShell(shell, shell.id)),
          ...extra,
        ];
        yield* applyObservations(observations);
        // Live state for threads this pass did not see is stale.
        const seen = new Set(observations.map((observation) => observation.threadId));
        for (const threadId of model.live.keys()) {
          if (!seen.has(threadId)) model.live.delete(threadId);
        }
        syncError = null;
        yield* publish;
        yield* PubSub.publish(events, { kind: "snapshot", snapshot: snapshotNow() });
      }),
    );
    return yield* serialized(Effect.sync(snapshotNow));
  });

  const act = (action: BoardAction, token: ArdudBoardToken) =>
    Effect.gen(function* () {
      // A fresh read first, so a just-finished or just-restarted run is judged on truth.
      const observation = yield* readShell(token.threadId);
      return yield* serialized(
        Effect.gen(function* () {
          yield* applyObservations([observation]);
          const now = yield* Clock.currentTimeMillis;
          const decision = decideAction({
            action,
            row: model.rows.get(token.threadId),
            workRevision: token.workRevision,
            running: model.isRunning(token.threadId),
            now,
          });
          if (decision._tag === "conflict") {
            yield* publish;
            return yield* new BoardConflictError({
              threadId: token.threadId,
              reason: decision.reason,
            });
          }
          if (decision._tag === "commit") {
            yield* persist([decision.row]);
            model.rows.set(decision.row.threadId, decision.row);
          }
          yield* publish;
          return snapshotNow();
        }),
      );
    });

  const clearLane = (input: ArdudBoardClearInput) =>
    Effect.gen(function* () {
      const unique = [...new Map(input.entries.map((entry) => [entry.threadId, entry])).values()];
      const observations = yield* Effect.forEach(unique, (entry) => readShell(entry.threadId), {
        concurrency: 8,
      });
      return yield* serialized(
        Effect.gen(function* () {
          const before = new Map(
            unique.map((entry) => [entry.threadId, model.rows.get(entry.threadId)?.workRevision]),
          );
          yield* applyObservations(observations);
          const working = model.workingAncestors();
          const totals = model.attentionTotals();
          const now = yield* Clock.currentTimeMillis;
          const cleared: ThreadId[] = [];
          const skipped: Array<{
            threadId: ThreadId;
            reason: "stale" | "cleared" | "running" | "changed";
          }> = [];
          const rows: BoardRow[] = [];
          for (const token of unique) {
            const row = model.rows.get(token.threadId);
            if (row === undefined || before.get(token.threadId) !== token.workRevision) {
              skipped.push({ threadId: token.threadId, reason: "stale" });
              continue;
            }
            if (row.workRevision !== token.workRevision) {
              skipped.push({ threadId: token.threadId, reason: "changed" });
              continue;
            }
            const lane = model.laneOf(row, working, totals);
            if (lane === null) {
              skipped.push({ threadId: token.threadId, reason: "cleared" });
              continue;
            }
            if (lane !== input.lane) {
              skipped.push({
                threadId: token.threadId,
                reason: lane === "running" ? "running" : "stale",
              });
              continue;
            }
            const decision = decideAction({
              action: "review",
              row,
              workRevision: token.workRevision,
              running: model.isRunning(token.threadId, working),
              now,
            });
            if (decision._tag === "commit") {
              rows.push(decision.row);
              cleared.push(token.threadId);
            } else if (decision._tag === "noop") {
              skipped.push({ threadId: token.threadId, reason: "cleared" });
            } else {
              skipped.push({
                threadId: token.threadId,
                reason: decision.reason === "running" ? "running" : "stale",
              });
            }
          }
          // All accepted cards commit in one revision; a failed write acknowledges none.
          yield* persist(rows);
          for (const row of rows) model.rows.set(row.threadId, row);
          yield* publish;
          return { ...snapshotNow(), cleared, skipped };
        }),
      );
    });

  const importRows = (rows: ReadonlyArray<BoardRow>) =>
    serialized(
      Effect.gen(function* () {
        const accepted = rows.filter((row) => {
          const current = model.rows.get(row.threadId);
          // A row already tracking newer work in t3 wins over the import.
          return current === undefined || (current.promptAt ?? 0) <= (row.promptAt ?? 0);
        });
        yield* persist(accepted);
        for (const row of accepted) model.rows.set(row.threadId, row);
        yield* publish;
        return accepted.length;
      }),
    );

  // Streaming transcript and UI-only events never change a card; skipping them
  // keeps a busy stream from re-reading shells for every token.
  const ignoredEvents = new Set([
    "turn-item.updated",
    "node.updated",
    "plan.updated",
    "checkpoint.captured",
    "checkpoint-scope.created",
    "thread.visited",
    "thread.marked-unread",
    "thread.pinned",
    "thread.unpinned",
    "thread.pin-reordered",
    "thread.active-reordered",
    "thread.snoozed",
    "thread.unsnoozed",
    "thread.pull-request-synced",
  ]);

  const start = Effect.gen(function* () {
    // The same committed application-event stream the shell subscription uses,
    // reduced to thread ids, coalesced, then one shell read per changed thread.
    const latest = yield* applicationEvents.latestApplicationSequence.pipe(
      Effect.orElseSucceed(() => 0),
    );
    const changes = applicationEvents
      .streamProjectedApplicationEvents({
        afterSequence: latest,
        project: (stored) =>
          "aggregateKind" in stored
            ? { sequence: stored.sequence, threadId: null as string | null }
            : {
                sequence: stored.sequence,
                threadId: ignoredEvents.has(stored.event.type)
                  ? null
                  : (stored.event.threadId as string),
              },
      })
      .pipe(
        Stream.filter((item) => item.threadId !== null),
        Stream.groupedWithin(512, Duration.millis(150)),
        Stream.runForEach((batch) =>
          observeThreads([...new Set(Array.from(batch, (item) => item.threadId as string))]).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.logWarning("Session board could not apply thread changes", {
                  cause: Cause.pretty(cause),
                }).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      syncError = "Some thread changes could not be applied.";
                    }),
                  ),
                ),
            ),
          ),
        ),
      );
    yield* forkParked(
      reconcile.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Session board startup reconcile failed", {
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                syncError = "Session board could not reconcile; showing saved state.";
              }),
            ),
          ),
        ),
        Effect.andThen(changes),
        Effect.catchCause((cause) =>
          Effect.logWarning("Session board event stream stopped", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
  });

  const eventStream: Stream.Stream<BoardEvent> = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(events);
      const initial = yield* serialized(Effect.sync(snapshotNow));
      return Stream.concat(
        Stream.succeed<BoardEvent>({ kind: "snapshot", snapshot: initial }),
        Stream.fromSubscription(subscription).pipe(
          // Deltas older than the snapshot just sent are already in it.
          Stream.filter((event) =>
            event.kind === "snapshot" ? true : event.delta.revision >= initial.revision,
          ),
        ),
      );
    }),
  );

  return BoardService.of({
    snapshot: serialized(Effect.sync(snapshotNow)),
    events: eventStream,
    act,
    clearLane,
    reconcile,
    refreshThread,
    importRows,
    rows: serialized(Effect.sync(() => new Map(model.rows))),
    start,
  });
});

export const layer = Layer.effect(BoardService, make);
