// @effect-diagnostics nodeBuiltinImport:off - command ids only need a random UUID.
import * as NodeCrypto from "node:crypto";

import { CommandId, ThreadId, type ArdudBoardSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import { BoardModel, type BoardRow, type Observation } from "./BoardModel.ts";
import * as BoardStore from "./BoardStore.ts";
import { observationFromShell } from "./shellObservation.ts";

export class BoardUnavailableError extends Schema.TaggedError<BoardUnavailableError>()(
  "BoardUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The session board is unavailable.";
  }
}

/**
 * The session board ledger. There is no board UI any more; the telegram bridge
 * reads the snapshot (GET /api/ardud/board) to find running threads and open
 * requests, and the memory-system reaper reads the Backlog rows from its table.
 */
export class BoardService extends Context.Service<
  BoardService,
  {
    readonly snapshot: Effect.Effect<ArdudBoardSnapshot>;
    /** Re-reads every tracked and active thread; runs on startup. */
    readonly reconcile: Effect.Effect<ArdudBoardSnapshot, BoardUnavailableError>;
    /** Re-reads one thread now (also used after origin changes). */
    readonly refreshThread: (threadId: string) => Effect.Effect<void, BoardUnavailableError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/ardud/board/BoardService") {}

/**
 * A settle the user made (sidebar, keybinding, MCP, control API). The
 * automatic sweep (`server:auto-settle:`) and the board's own sync
 * (`ardud-board:`) don't count: auto-settle would empty Later after a few
 * idle days, and the board already applied its own.
 */
const isUserSettle = (commandId: string | null) =>
  commandId === null ||
  !(commandId.startsWith("server:auto-settle:") || commandId.startsWith("ardud-board:"));

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
  const lock = yield* Semaphore.make(1);
  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

  const snapshotNow = (): ArdudBoardSnapshot => ({
    version: 1,
    revision,
    activatedAt: model.activatedAt,
    entries: model.entries(),
    syncError,
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

  /**
   * Applies observations, then completes runs a newer run of their schedule
   * replaced. Call under the lock; returns the completed thread ids so the
   * caller can settle them in t3 once the lock is released.
   */
  const applyObservations = (observations: ReadonlyArray<Observation>) =>
    Effect.gen(function* () {
      const patches = observations.map((observation) => ({
        observation,
        patch: model.observe(observation),
      }));
      // New prompts may come from a scheduled task, and a scheduled card still
      // on the board when first seen needs its task id to group by.
      const lookup = patches
        .filter(({ observation, patch }) => {
          if (observation.deleted === true) return false;
          const previous = model.rows.get(observation.threadId);
          const row = patch.rows[0] ?? previous;
          if (row === undefined) return false;
          const prompted =
            patch.rows[0] !== undefined && (patch.creates || row.promptAt !== previous?.promptAt);
          return prompted || (row.scheduled && !row.reviewed && !model.schedules.has(row.threadId));
        })
        .map(({ observation }) => observation.threadId);
      const scheduled =
        lookup.length === 0
          ? new Map<string, string>()
          : yield* store
              .scheduledThreads(lookup)
              .pipe(Effect.mapError((cause) => new BoardUnavailableError({ cause })));
      const checked = new Set(lookup);
      const final = patches.map(({ observation, patch }) => {
        if (observation.deleted === true || !checked.has(observation.threadId)) return patch;
        // Re-read with what the latest prompt says: a scheduled run, or a
        // card persisted as scheduled that a later non-scheduled prompt owns.
        const row = patch.rows[0] ?? model.rows.get(observation.threadId);
        if (row === undefined) return patch;
        const fromSchedule = scheduled.has(observation.threadId);
        return fromSchedule !== row.scheduled
          ? model.observe({ ...observation, scheduledHint: fromSchedule })
          : patch;
      });
      yield* persist(final.flatMap((patch) => patch.rows));
      for (const patch of final) model.commit(patch);
      for (const threadId of lookup) model.schedules.set(threadId, scheduled.get(threadId) ?? null);

      const superseded = model.supersededRuns();
      yield* persist(superseded);
      for (const row of superseded) model.rows.set(row.threadId, row);
      return superseded
        .filter((row) => {
          const info = model.live.get(row.threadId);
          return info !== undefined && !info.archived && !info.settled && !row.deleted;
        })
        .map((row) => row.threadId);
    });

  const observeThreads = (
    threadIds: ReadonlyArray<string>,
    userSettled: ReadonlySet<string> = new Set(),
  ) =>
    Effect.gen(function* () {
      const observations = (yield* Effect.forEach(threadIds, readShell, { concurrency: 8 })).map(
        (observation): Observation =>
          observation.deleted !== true &&
          observation.settled === true &&
          userSettled.has(observation.threadId)
            ? { ...observation, settledByUser: true }
            : observation,
      );
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
      const superseded = yield* serialized(
        Effect.gen(function* () {
          for (const threadId of lineage) {
            const origin = origins.get(threadId);
            if (origin === undefined) model.origins.delete(threadId);
            else model.origins.set(threadId, origin);
          }
          return yield* applyObservations(observations);
        }),
      );
      yield* settleSuperseded(superseded);
    });

  const refreshThread = (threadId: string) => observeThreads([threadId]);

  /**
   * A superseded scheduled run is settled in t3 too, so the sidebar matches.
   * Best effort: the card state is already saved, and t3 refuses to settle a
   * thread that still has work.
   */
  const settleSuperseded = (threadIds: ReadonlyArray<string>) =>
    Effect.forEach(
      threadIds,
      (threadId) =>
        threads
          .dispatch({
            type: "thread.settle",
            commandId: CommandId.make(`ardud-board:settle:${threadId}:${NodeCrypto.randomUUID()}`),
            threadId: ThreadId.make(threadId),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Session board could not settle a superseded run", {
                threadId,
                error,
              }),
            ),
          ),
      { concurrency: 4, discard: true },
    );

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
    const superseded = yield* serialized(
      Effect.gen(function* () {
        model.origins.clear();
        for (const [threadId, origin] of origins) model.origins.set(threadId, origin);
        const observations: Observation[] = [
          ...shells.threads.map((shell) => observationFromShell(shell, shell.id)),
          ...extra,
        ];
        const superseded = yield* applyObservations(observations);
        // Live state for threads this pass did not see is stale.
        const seen = new Set(observations.map((observation) => observation.threadId));
        for (const threadId of model.live.keys()) {
          if (!seen.has(threadId)) model.live.delete(threadId);
        }
        syncError = null;
        return superseded;
      }),
    );
    yield* settleSuperseded(superseded);
    return yield* serialized(Effect.sync(snapshotNow));
  });

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
            ? { sequence: stored.sequence, threadId: null as string | null, userSettle: false }
            : {
                sequence: stored.sequence,
                threadId: ignoredEvents.has(stored.event.type)
                  ? null
                  : (stored.event.threadId as string),
                userSettle:
                  stored.event.type === "thread.settled" && isUserSettle(stored.commandId),
              },
      })
      .pipe(
        Stream.filter((item) => item.threadId !== null),
        Stream.groupedWithin(512, Duration.millis(150)),
        Stream.runForEach((batch) =>
          observeThreads(
            [...new Set(Array.from(batch, (item) => item.threadId as string))],
            new Set(
              Array.from(batch)
                .filter((item) => item.userSettle)
                .map((item) => item.threadId as string),
            ),
          ).pipe(
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

  return BoardService.of({
    snapshot: serialized(Effect.sync(snapshotNow)),
    reconcile,
    refreshThread,
    start,
  });
});

export const layer = Layer.effect(BoardService, make);
