import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type ScopedThreadRef,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { Atom, type AtomRegistry } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import {
  THREAD_NOT_FOUND_GRACE_MS,
  THREAD_SNAPSHOT_IDLE_TTL_MS,
  threadNotFoundRetryDelayMs,
} from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import {
  applyHistoryPageMeta,
  clearActiveHistoryLoading,
  EMPTY_THREAD_HISTORY_META,
  isActiveHistoryRequestCursor,
  mergeOlderHistoryIntoProjection,
  type ThreadHistoryMeta,
} from "./threadHistoryMerge.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

/** Terminal "no thread" outcomes that connection-phase updates must not overwrite. */
function isAbsentStatus(status: EnvironmentThreadStatus): boolean {
  return status === "deleted" || status === "not-found";
}

function statusWithoutLiveData(
  data: Option.Option<OrchestrationV2ThreadProjection>,
): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function formatHistoryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Could not load earlier activity.";
}

function historyMetaFromCachedSnapshot(
  snapshot: OrchestrationV2ThreadDetailSnapshot,
): ThreadHistoryMeta {
  const historyCursor = snapshot.historyCursor ?? null;
  const hasMoreHistory = snapshot.hasMoreHistory ?? false;
  return {
    historyCursor,
    hasMoreHistory,
    loading: false,
    error: null,
    expanded: false,
    latestLocalTurnOrdinal: snapshot.latestLocalTurnOrdinal ?? null,
  };
}

function snapshotToPersist(
  snapshotSequence: number,
  projection: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
  acceptsBoundedSnapshots: boolean,
): OrchestrationV2ThreadDetailSnapshot {
  // A complete bounded snapshot still proves paging support. Retain that evidence
  // so a thread that grows while closed can resume with a bounded fallback.
  if (acceptsBoundedSnapshots || history.hasMoreHistory || history.historyCursor !== null) {
    return {
      snapshotSequence,
      projection,
      historyCursor: history.historyCursor,
      hasMoreHistory: history.hasMoreHistory,
      latestLocalTurnOrdinal: history.latestLocalTurnOrdinal,
    };
  }
  return { snapshotSequence, projection };
}

function shouldPersistThread(
  thread: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
): boolean {
  // After the user loads older pages the in-memory timeline can grow large.
  // Keep those expanded projections out of the monolithic cache.
  if (history.expanded) {
    return false;
  }
  return !thread.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}

interface ThreadResumeSnapshot {
  readonly state: EnvironmentThreadState;
  readonly sequence: number;
  readonly persisted: boolean;
  readonly acceptsBoundedSnapshots?: boolean;
}

interface ThreadResumeCache {
  snapshot: ThreadResumeSnapshot | undefined;
  owner: object | undefined;
}

function matchesThreadSnapshot(
  current: ThreadResumeSnapshot,
  projection: OrchestrationV2ThreadProjection | null,
  sequence: number,
  history: Pick<ThreadHistoryMeta, "historyCursor" | "hasMoreHistory" | "latestLocalTurnOrdinal">,
): boolean {
  if (current.sequence !== sequence || Option.getOrNull(current.state.data) !== projection)
    return false;
  const currentHistory = current.state.history;
  return (
    currentHistory.historyCursor === history.historyCursor &&
    currentHistory.hasMoreHistory === history.hasMoreHistory &&
    (!(history.hasMoreHistory || history.historyCursor !== null) ||
      currentHistory.latestLocalTurnOrdinal === history.latestLocalTurnOrdinal)
  );
}

// Only a delete event is kept. "not-found" (an HTTP miss) falls back to
// empty/cached, so reopening the thread loads it again.
function cachedThreadState(value: EnvironmentThreadState): EnvironmentThreadState {
  return {
    ...value,
    status:
      value.status === "deleted" || (value.status === "live" && Option.isSome(value.data))
        ? value.status
        : statusWithoutLiveData(value.data),
    error: Option.none(),
    history: { ...value.history, loading: false, error: null },
  };
}

export interface EnvironmentThreadStateOptions {
  /**
   * Whether the environment shell lists this thread. A thread that was not
   * found is loaded again when this turns true.
   */
  readonly presence?: Stream.Stream<boolean>;
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
  options?: EnvironmentThreadStateOptions,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
  const historyController = yield* Effect.serviceOption(
    ThreadHistoryController.ThreadHistoryController,
  );
  const httpClient = yield* Effect.serviceOption(HttpClient.HttpClient);
  const dpopSigner = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const retained = resumeCache?.snapshot;
  const owner = {};
  if (resumeCache) resumeCache.owner = owner;
  const cached =
    retained === undefined
      ? yield* cache.loadThread(environmentId, threadId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not load cached thread.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                error: error.message,
              }),
              Effect.as(Option.none<OrchestrationV2ThreadDetailSnapshot>()),
            ),
          ),
        )
      : Option.none<OrchestrationV2ThreadDetailSnapshot>();
  const cachedThread = Option.map(cached, (snapshot) => snapshot.projection);
  const initialState: EnvironmentThreadState = retained
    ? cachedThreadState(retained.state)
    : {
        data: cachedThread,
        status: statusWithoutLiveData(cachedThread),
        error: Option.none(),
        history: Option.match(cached, {
          onNone: () => EMPTY_THREAD_HISTORY_META,
          onSome: historyMetaFromCachedSnapshot,
        }),
      };
  const state = yield* SubscriptionRef.make(initialState);
  const canLoadHistory = Option.isSome(httpClient) && Option.isSome(historyController);
  const acceptsBoundedSocketSnapshots = yield* Ref.make(canLoadHistory);
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const initialSequence =
    retained?.sequence ??
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence });
  const lastSequence = yield* SubscriptionRef.make(initialSequence);
  let committed: ThreadResumeSnapshot = {
    state: initialState,
    sequence: initialSequence,
    persisted: retained?.persisted ?? Option.isSome(cached),
    acceptsBoundedSnapshots: canLoadHistory,
  };
  if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  const awaitingCompletion = yield* Ref.make(false);
  const applyLock = yield* Semaphore.make(1);
  // Save only completed data/cursor updates. A canceled scope must not cache
  // a cursor whose event has not reached the data yet.
  const remember = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const sequence = yield* SubscriptionRef.get(lastSequence);
    committed = {
      state: current,
      sequence,
      acceptsBoundedSnapshots: yield* Ref.get(acceptsBoundedSocketSnapshots),
      persisted:
        committed.persisted &&
        matchesThreadSnapshot(committed, Option.getOrNull(current.data), sequence, current.history),
    };
    if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  });
  const persistence = yield* Queue.sliding<OrchestrationV2ThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationV2ThreadDetailSnapshot,
  ) {
    if (resumeCache !== undefined && resumeCache.owner !== owner) return;
    if (committed.state.status === "deleted") return;
    if (
      committed.persisted &&
      matchesThreadSnapshot(
        committed,
        snapshot.projection,
        snapshot.snapshotSequence,
        historyMetaFromCachedSnapshot(snapshot),
      )
    )
      return;
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (
            !matchesThreadSnapshot(
              committed,
              snapshot.projection,
              snapshot.snapshotSequence,
              historyMetaFromCachedSnapshot(snapshot),
            )
          )
            return;
          committed = { ...committed, persisted: true };
          if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const { state: current, sequence: snapshotSequence } = committed;
      return Option.match(current.data, {
        onNone: () => Effect.void,
        onSome: (projection) =>
          shouldPersistThread(projection, current.history)
            ? persist(
                snapshotToPersist(
                  snapshotSequence,
                  projection,
                  current.history,
                  committed.acceptsBoundedSnapshots === true,
                ),
              )
            : Effect.void,
      });
    }),
  );

  yield* runCachePersistence(persistence, persist).pipe(Effect.forkScoped);

  const setConnecting = SubscriptionRef.update(state, (current) =>
    isAbsentStatus(current.status) || Option.isSome(current.error)
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || isAbsentStatus(current.status) || Option.isSome(current.error)
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: isAbsentStatus(current.status) ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  let consecutiveSyncFailures = 0;
  const setStreamError = (message: string) =>
    Effect.sync(() => {
      consecutiveSyncFailures += 1;
    }).pipe(
      Effect.andThen(Ref.set(awaitingCompletion, false)),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: isAbsentStatus(current.status)
            ? current.status
            : statusWithoutLiveData(current.data),
          error: Option.some(
            `Could not synchronize the thread. Showing saved history; retrying. ${message}`,
          ),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationV2ThreadProjection,
    options?: {
      readonly resetHistory?: boolean;
      readonly history?: ThreadHistoryMeta;
    },
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    // Atomic with concurrent history meta updates: never get-then-set the whole
    // state when only the projection changes. Bounded installs pass history so
    // projection + cursor persist together in one enqueue.
    const next = yield* SubscriptionRef.updateAndGet(state, (previous) => {
      const history =
        options?.history !== undefined
          ? options.history
          : options?.resetHistory === true
            ? EMPTY_THREAD_HISTORY_META
            : previous.history;
      return {
        ...previous,
        data: Option.some(thread),
        status: waiting ? ("synchronizing" as const) : ("live" as const),
        error: Option.none(),
        history,
      };
    });
    // Active projections can update many times per second and retain large tool
    // payloads. Persist once the run settles so cache encoding stays off the
    // streaming path. Progressive meta rides along when the window is incomplete.
    if (shouldPersistThread(thread, next.history)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(
        persistence,
        snapshotToPersist(
          snapshotSequence,
          thread,
          next.history,
          yield* Ref.get(acceptsBoundedSocketSnapshots),
        ),
      );
    }
  });

  const patchHistoryMeta = (patch: (history: ThreadHistoryMeta) => ThreadHistoryMeta) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      history: patch(current.history),
    }));

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
      history: EMPTY_THREAD_HISTORY_META,
    });
    yield* remember;
    if (resumeCache !== undefined && resumeCache.owner !== owner) return;
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  // An HTTP miss is not a delete: the thread may not be committed yet (draft
  // promotion, a queued creation) or the read raced. Retry with backoff for a
  // grace window, then show "not-found" until the shell lists the thread (a new
  // presence generation) or the user retries. Nothing is removed from the disk cache and the state is never
  // retained as deleted.
  let missSince: number | undefined;
  let missAttempts = 0;
  // Presence is observed from the start, not only after the final miss: the
  // last HTTP read can miss, creation commit, and the shell list the thread
  // before a late subscriber would see it (11 Nov 2026 review). Each
  // absent -> present transition (an initial "present" counts) is one
  // generation, consumed by at most one retry, so a shell that keeps listing a
  // thread the server can't find causes one retry, not a loop.
  const presenceGeneration = yield* SubscriptionRef.make(0);
  let consumedPresenceGeneration = 0;
  if (options?.presence !== undefined) {
    yield* Effect.forkScoped(
      options.presence.pipe(
        Stream.changes,
        Stream.runForEach((present) =>
          present ? SubscriptionRef.update(presenceGeneration, (value) => value + 1) : Effect.void,
        ),
      ),
    );
  }
  /** Consumes a presence generation not yet retried, if there is one. */
  const takePresenceAdvance = Effect.gen(function* () {
    const generation = yield* SubscriptionRef.get(presenceGeneration);
    if (generation <= consumedPresenceGeneration) return false;
    consumedPresenceGeneration = generation;
    return true;
  });
  const awaitPresenceAdvance = Effect.gen(function* () {
    const seen = consumedPresenceGeneration;
    const generation = yield* SubscriptionRef.changes(presenceGeneration).pipe(
      Stream.filter((value) => value > seen),
      Stream.runHead,
      Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: Effect.succeed })),
    );
    consumedPresenceGeneration = Math.max(consumedPresenceGeneration, generation);
  });
  const clearMiss = Effect.sync(() => {
    missSince = undefined;
    missAttempts = 0;
  });
  const waitAfterMiss = Effect.fn("EnvironmentThreadState.waitAfterMiss")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (missSince === undefined) missSince = now;
    missAttempts += 1;
    if (now - missSince < THREAD_NOT_FOUND_GRACE_MS) {
      yield* Effect.logDebug("Thread not found yet; retrying.").pipe(
        Effect.annotateLogs({ environmentId, threadId, attempt: missAttempts }),
      );
      yield* Effect.sleep(threadNotFoundRetryDelayMs(missAttempts));
      return;
    }
    // The shell listed the thread during the last read (or already lists it):
    // read once more before parking.
    if (yield* takePresenceAdvance) {
      yield* Effect.logDebug("Thread not found, but the shell lists it; retrying once.").pipe(
        Effect.annotateLogs({ environmentId, threadId, attempt: missAttempts }),
      );
      return;
    }
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) =>
      current.status === "deleted"
        ? current
        : {
            data: Option.none(),
            status: "not-found" as const,
            error: Option.none(),
            history: EMPTY_THREAD_HISTORY_META,
          },
    );
    yield* remember;
    yield* awaitPresenceAdvance;
    yield* clearMiss;
    yield* SubscriptionRef.update(state, (current) =>
      current.status === "not-found"
        ? { ...current, status: "synchronizing" as const, error: Option.none() }
        : current,
    );
  });

  type EventItem = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;
  type SequencedItem = Extract<
    OrchestrationV2ThreadStreamItem,
    { kind: "event" | "unknown-event" }
  >;
  const applyEventsLocked = Effect.fn("EnvironmentThreadState.applyEventsLocked")(function* (
    items: ReadonlyArray<SequencedItem>,
  ) {
    const appliedSequence = yield* SubscriptionRef.get(lastSequence);
    let sequence = appliedSequence;
    const fresh: EventItem[] = [];
    for (const item of items) {
      if (item.sequence <= sequence) continue;
      sequence = item.sequence;
      if (item.kind === "event") {
        fresh.push(item);
        continue;
      }
      yield* Effect.logDebug("Skipped a thread event type this client does not know.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          eventType: item.eventType.slice(0, 64),
          sequence: item.sequence,
        }),
      );
    }
    if (sequence === appliedSequence) return;
    yield* SubscriptionRef.set(lastSequence, sequence);
    if (fresh.length === 0) return;

    const waiting = yield* Ref.get(awaitingCompletion);
    // Apply against the latest projection/history in one update so a concurrent
    // loadEarlier merge (or history-meta patch) cannot be clobbered by a stale
    // get-then-set rebuild.
    type EventApplyResult =
      | { readonly _tag: "noop" }
      | { readonly _tag: "delete" }
      | {
          readonly _tag: "applied";
          readonly projection: OrchestrationV2ThreadProjection;
          readonly history: ThreadHistoryMeta;
        };

    const applyEvent = (
      current: EnvironmentThreadState,
      item: EventItem,
    ): readonly [EventApplyResult, EnvironmentThreadState] => {
      if (current.status === "deleted") {
        return [{ _tag: "noop" }, current];
      }
      if (Option.isNone(current.data)) {
        return [
          item.event.type === "thread.deleted" ? { _tag: "delete" } : { _tag: "noop" },
          current,
        ];
      }
      if (item.event.type === "thread.deleted") {
        return [{ _tag: "delete" }, current];
      }

      // Incomplete progressive windows only (hasMore or open cursor). Do not
      // use expanded: it remains true after the last page as a cache marker.
      const partial =
        current.history.hasMoreHistory || current.history.historyCursor !== null
          ? {
              partialTimeline: true as const,
              latestLocalTurnOrdinal: current.history.latestLocalTurnOrdinal,
            }
          : undefined;
      const next = applyOrchestrationV2ProjectionEvent(current.data.value, item.event, partial);
      if (next === null || next === current.data.value) {
        return [{ _tag: "noop" }, current];
      }

      let history = current.history;
      if (partial !== undefined && item.event.type === "turn-item.updated") {
        const ordinal = item.event.payload.ordinal;
        const watermark = history.latestLocalTurnOrdinal;
        if (watermark === null || ordinal > watermark) {
          history = { ...history, latestLocalTurnOrdinal: ordinal };
        }
      }

      const updated: EnvironmentThreadState = {
        ...current,
        data: Option.some(next),
        status: waiting ? "synchronizing" : "live",
        error: Option.none(),
        history,
      };
      return [{ _tag: "applied", projection: next, history: updated.history }, updated];
    };

    const result = yield* SubscriptionRef.modify(
      state,
      (current): readonly [EventApplyResult, EnvironmentThreadState] => {
        let result: EventApplyResult = { _tag: "noop" };
        for (const item of fresh) {
          const [applied, next] = applyEvent(current, item);
          current = next;
          if (applied._tag !== "noop") result = applied;
          if (applied._tag === "delete") break;
        }
        return [result, current];
      },
    );

    if (result._tag === "delete") {
      yield* setDeleted();
      return;
    }
    if (result._tag === "applied" && shouldPersistThread(result.projection, result.history)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(
        persistence,
        snapshotToPersist(
          snapshotSequence,
          result.projection,
          result.history,
          yield* Ref.get(acceptsBoundedSocketSnapshots),
        ),
      );
    }
  });

  const applyItemLocked = Effect.fn("EnvironmentThreadState.applyItemLocked")(function* (
    item: OrchestrationV2ThreadStreamItem,
  ) {
    if (item.kind === "synchronized") {
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      yield* SubscriptionRef.set(lastSequence, item.snapshotSequence);
      const hasProgressiveHistory =
        item.historyCursor !== undefined ||
        item.hasMoreHistory !== undefined ||
        item.latestLocalTurnOrdinal !== undefined;
      yield* setThread(
        boundedSnapshotProjection(item),
        hasProgressiveHistory
          ? {
              history: {
                historyCursor: item.historyCursor ?? null,
                hasMoreHistory: item.hasMoreHistory ?? false,
                loading: false,
                error: null,
                expanded: false,
                latestLocalTurnOrdinal: item.latestLocalTurnOrdinal ?? null,
              },
            }
          : { resetHistory: true },
      );
      return;
    }

    yield* applyEventsLocked([item]);
  });

  const applyItems = Effect.fn("EnvironmentThreadState.applyItems")(function* (
    items: ReadonlyArray<OrchestrationV2ThreadStreamItem>,
  ) {
    yield* applyLock.withPermits(1)(
      Effect.gen(function* () {
        let events: SequencedItem[] = [];
        for (const item of items) {
          if (
            item.kind === "unknown-event" ||
            (item.kind === "event" && item.event.type !== "thread.deleted")
          ) {
            events.push(item);
            continue;
          }
          yield* applyEventsLocked(events);
          events = [];
          yield* applyItemLocked(item);
        }
        yield* applyEventsLocked(events);
        if (items.some((item) => item.kind === "snapshot" || item.kind === "synchronized"))
          consecutiveSyncFailures = 0;
        yield* remember;
      }),
    );
  });

  const loadEarlier = Effect.fn("EnvironmentThreadState.loadEarlier")(function* (
    throughEntryId?: string,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (
      current.status === "deleted" ||
      Option.isNone(current.data) ||
      !current.history.hasMoreHistory ||
      current.history.historyCursor === null
    ) {
      return { _tag: "noop" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }
    if (current.history.loading) {
      return { _tag: "busy" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }

    // Capture the cursor that initiated this request. Completions/failures must
    // no-op if a socket or new bounded snapshot replaced progressive meta mid-flight.
    const requestCursor = current.history.historyCursor;
    yield* patchHistoryMeta((history) =>
      isActiveHistoryRequestCursor(requestCursor, history)
        ? { ...history, loading: true, error: null }
        : history,
    );

    const failLoad = (message: string) =>
      SubscriptionRef.modify(
        state,
        (
          latest,
        ): readonly [
          ThreadHistoryController.ThreadHistoryLoadEarlierResult,
          EnvironmentThreadState,
        ] =>
          isActiveHistoryRequestCursor(requestCursor, latest.history)
            ? [
                { _tag: "error", message },
                {
                  ...latest,
                  history: { ...latest.history, loading: false, error: message },
                },
              ]
            : [{ _tag: "noop" }, latest],
      );

    const runLoad = Effect.gen(function* () {
      const preparedOption = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(preparedOption) || Option.isNone(httpClient))
        return yield* failLoad("Environment is not connected.");

      const views =
        throughEntryId === undefined ? [undefined] : ["conversation" as const, undefined];
      for (const view of views) {
        const pageResult = yield* fetchEnvironmentThreadHistoryPage({
          prepared: preparedOption.value,
          threadId,
          cursor: requestCursor,
          throughEntryId,
          view,
          signer: dpopSigner,
          remoteAuthorization,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient.value), Effect.result);
        if (Result.isFailure(pageResult))
          return yield* failLoad(formatHistoryError(pageResult.failure));
        const page = pageResult.success;
        const complete = view === undefined;
        const waiting = yield* Ref.get(awaitingCompletion);
        const result = yield* applyLock.withPermits(1)(
          SubscriptionRef.modify(
            state,
            (
              latest,
            ): readonly [
              ThreadHistoryController.ThreadHistoryLoadEarlierResult,
              EnvironmentThreadState,
            ] => {
              if (!isActiveHistoryRequestCursor(requestCursor, latest.history))
                return [{ _tag: "noop" }, latest];
              if (Option.isNone(latest.data) || latest.status === "deleted")
                return [{ _tag: "noop" }, { ...latest, history: EMPTY_THREAD_HISTORY_META }];
              return [
                { _tag: "loaded" },
                {
                  ...latest,
                  data: Option.some(mergeOlderHistoryIntoProjection(latest.data.value, page.items)),
                  status: complete && waiting ? "synchronizing" : latest.status,
                  history: complete
                    ? applyHistoryPageMeta(latest.history, page)
                    : { ...latest.history, expanded: true },
                },
              ];
            },
          ),
        );
        if (result._tag !== "loaded") return result;
        if (complete) yield* remember;
      }
      return { _tag: "loaded" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    });

    return yield* runLoad.pipe(
      Effect.onInterrupt(() =>
        SubscriptionRef.update(state, (latest) => ({
          ...latest,
          history: clearActiveHistoryLoading(requestCursor, latest.history),
        })),
      ),
    );
  });

  if (Option.isSome(historyController)) {
    const scope = yield* Scope.Scope;
    const registration = yield* historyController.value.register(environmentId, threadId, {
      loadEarlier: (throughEntryId) =>
        loadEarlier(throughEntryId).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
    });
    yield* Effect.addFinalizer(() => historyController.value.unregister(registration));
  }

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setConnecting;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  // Only the first subscription after a warm live resume keeps the retained
  // status. A replacement session or foreground resubscribe on the same scope
  // may have missed events, so those show sync progress until confirmed.
  const resumingLive = yield* Ref.make(initialState.status === "live");
  const markSynchronizing = Effect.gen(function* () {
    if (yield* Ref.get(resumingLive)) return;
    yield* SubscriptionRef.update(state, (current) =>
      isAbsentStatus(current.status) || Option.isSome(current.error)
        ? current
        : { ...current, status: "synchronizing" as const, error: Option.none() },
    );
  });

  yield* markSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_V2_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        if (consecutiveSyncFailures > 0) {
          yield* Effect.sleep(
            Math.min(1_000 * 2 ** Math.min(consecutiveSyncFailures - 1, 5), 30_000),
          );
        }
        let current = yield* SubscriptionRef.get(state);
        // A delete event already cleared this thread. Park the subscription
        // attempt without opening the socket. An HTTP miss never lands here: it
        // is "not-found" and retried below.
        if (current.status === "deleted") {
          return yield* Effect.never;
        }

        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        );
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* markSynchronizing;
        yield* Ref.set(resumingLive, false);

        let loading = Option.isNone(current.data);
        if (loading && current.status === "not-found") {
          // A new session or retry is loading again; show progress, not the old miss.
          yield* SubscriptionRef.update(state, (value) =>
            value.status === "not-found" ? { ...value, status: "synchronizing" as const } : value,
          );
        }
        while (loading) {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          const httpResult: ThreadSnapshotLoader.ThreadSnapshotLoadResult =
            yield* snapshotLoader.load(prepared, threadId);
          switch (httpResult._tag) {
            case "denied": {
              yield* SubscriptionRef.set(state, {
                data: Option.none(),
                status: "no-access",
                error: Option.none(),
                history: EMPTY_THREAD_HISTORY_META,
              });
              return yield* Effect.never;
            }
            case "present": {
              yield* clearMiss;
              loading = false;
              if (canLoadHistory && httpResult.history !== undefined) {
                yield* Ref.set(acceptsBoundedSocketSnapshots, true);
              }
              // Atomic projection + progressive meta so a settled bounded window
              // never persists as a complete full-timeline cache entry. Socket
              // snapshots still go through applyItem (resetHistory).
              yield* applyLock.withPermits(1)(
                Effect.gen(function* () {
                  yield* SubscriptionRef.set(lastSequence, httpResult.snapshot.snapshotSequence);
                  const history: ThreadHistoryMeta =
                    httpResult.history !== undefined
                      ? {
                          historyCursor: httpResult.history.historyCursor,
                          hasMoreHistory: httpResult.history.hasMoreHistory,
                          loading: false,
                          error: null,
                          expanded: false,
                          latestLocalTurnOrdinal: httpResult.history.latestLocalTurnOrdinal ?? null,
                        }
                      : EMPTY_THREAD_HISTORY_META;
                  yield* setThread(httpResult.snapshot.projection, { history });
                  yield* remember;
                }),
              );
              current = yield* SubscriptionRef.get(state);
              break;
            }
            case "missing": {
              yield* waitAfterMiss();
              current = yield* SubscriptionRef.get(state);
              if (current.status === "deleted") return yield* Effect.never;
              break;
            }
            case "unavailable": {
              loading = false;
              break;
            }
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data);
        const acceptBoundedSnapshot = yield* Ref.get(acceptsBoundedSocketSnapshots);
        if (!supportsCompletionMarker && canResume && consecutiveSyncFailures === 0) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          ...(acceptBoundedSnapshot
            ? { acceptBoundedSnapshot: true as const, acceptCompactTurnItems: true as const }
            : {}),
        };
      }),
      {
        onDefect: () => setStreamError("Could not synchronize the thread."),
        onExpectedFailure: (cause) => {
          const error = Cause.squash(cause);
          if (
            typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            error._tag === "EnvironmentAuthorizationError"
          ) {
            return SubscriptionRef.set(state, {
              data: Option.none(),
              status: "no-access",
              error: Option.none(),
              history: EMPTY_THREAD_HISTORY_META,
            });
          }
          return setStreamError(formatThreadError(cause));
        },
        retryExpectedFailureAfter: "250 millis",
        retryDefects: true,
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEachArray(applyItems)),
  );

  return state;
});

function threadStateChanges(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
  options?: EnvironmentThreadStateOptions,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId, resumeCache, options).pipe(
        Effect.map(SubscriptionRef.changes),
      ),
    ),
  );
}

export interface EnvironmentThreadStateAtomsOptions {
  /**
   * True while the environment shell lists the thread. Lets a thread that was
   * not found (e.g. opened before the server created it) load once it exists.
   */
  readonly threadPresenceAtom?: (ref: ScopedThreadRef) => Atom.Atom<boolean>;
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | Persistence.EnvironmentCacheStore
    | ThreadSnapshotLoader.ThreadSnapshotLoader
    | R,
    E
  >,
  atomsOptions?: EnvironmentThreadStateAtomsOptions,
) {
  // Cache definitions must outlive collectible live-atom definitions. The
  // registry retains these nodes without retaining environment or RPC scopes.
  const resumeFamily = Atom.family((key: string) =>
    Atom.make((): ThreadResumeCache => ({
      snapshot: undefined,
      owner: undefined,
    })).pipe(
      Atom.setIdleTTL(THREAD_SNAPSHOT_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-resume:${key}`),
    ),
  );
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    const resumeAtom = resumeFamily(key);
    return runtime
      .atom(
        (get) => {
          get.mount(resumeAtom);
          const resume = get.once(resumeAtom);
          // `stream` subscribes without making the shell a dependency, so shell
          // updates never restart this thread's stream.
          const presenceAtom = atomsOptions?.threadPresenceAtom?.({ environmentId, threadId });
          const live = threadStateChanges(environmentId, threadId, resume, {
            ...(presenceAtom === undefined ? {} : { presence: get.stream(presenceAtom) }),
          });
          return resume.snapshot === undefined
            ? live
            : Stream.concat(Stream.succeed(cachedThreadState(resume.snapshot.state)), live);
        },
        {
          initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
        },
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state:${key}`));
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
    /**
     * Loads the thread again from the server, dropping the retained in-memory
     * state first. Use this for Retry: refreshing the state atom alone would
     * resume a retained "deleted" state and park again.
     */
    reload: (
      registry: AtomRegistry.AtomRegistry,
      environmentId: EnvironmentIdType,
      threadId: ThreadIdType,
    ) => {
      const key = threadKey({ environmentId, threadId });
      const resume = registry.get(resumeFamily(key));
      resume.snapshot = undefined;
      resume.owner = undefined;
      registry.refresh(family(key));
    },
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * as BoundedThreadSnapshotLoader from "./boundedThreadSnapshotHttp.ts";
export * as ThreadHistoryController from "./threadHistoryController.ts";
export type { ThreadHistoryLoadEarlierResult } from "./threadHistoryController.ts";
export * from "./threadHistoryMerge.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadFeedback.ts";
export * from "./threadDetail.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";

export { threadDetailToShell } from "./threadDetailShell.ts";
